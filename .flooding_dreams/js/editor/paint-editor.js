/* ============================================================
   3D 涂鸦模式（B 键开关）
   - 全局图层系统（高图层覆盖低图层，支持混合模式与不透明度）
   - 笔刷 / 橡皮 / 材质图章 / 吸色；滚轮调笔触大小
   ============================================================ */
import { el, clear, toast, promptBox, confirmBox } from '../ui/dom.js';
import { BLEND_MODES } from '../world/level.js';
import { BUILTIN_TEXTURES, EDITOR } from '../config.js';
import { clamp } from '../core/util.js';
import { optSelect, popover, contextMenu } from './widgets.js';
import { GridSelect } from '../ui/grid-picker.js';
import { getObject, objectLabel } from '../world/level.js';
import { store } from '../core/storage.js';
import { resolveAssetURL } from '../core/settings.js';
import { hasTexture, loadTextureFromURL } from '../core/textures.js';

const TOOLS = [
  { v: 'brush', l: '笔刷', ico: '🖌' },
  { v: 'eraser', l: '橡皮', ico: '🧽' },
  { v: 'stamp', l: '材质章', ico: '🧱' },
  { v: 'picker', l: '吸色', ico: '💧' },
];

/** 指针是否落在 3D 视口上的浮层 UI（HUD / 工具条 / 框选框）上 */
export function isOverlay(target) {
  return !!(target && target.closest
    && target.closest('#ed-paint-hud,#ed-parkour-hud,#ed-model-hud,#ed-sticker-hud,#ed-gizmo-bar,#ed-gizmo-bar-top,#ed-view-hud,#ed-marquee'));
}

export class PaintEditor {
  constructor(ed) {
    this.ed = ed;
    this.active = false;
    this.tool = 'brush';
    this.color = '#ff5c8a';
    this.alpha = 1;
    this.size = 24;
    this.hardness = 0.5;
    this.tex = 'bricks';
    this.layerId = null;
    this.targetId = null;
    this.pointer = { x: 0, y: 0, inside: false };
    this._stroke = null;
    this._prev = null;
    this._held = false;
    this._counter = 0;

    /* ---------- DOM ---------- */
    this.hud = document.getElementById('ed-paint-hud');
    this.view = document.getElementById('ed-view');
    this.layerList = document.getElementById('layer-list');
    this.cColor = document.getElementById('paint-color');
    this.cAlpha = document.getElementById('paint-alpha');
    this.cSize = document.getElementById('paint-size');
    this.cSizeNum = document.getElementById('paint-size-num');
    this.cHard = document.getElementById('paint-hard');
    this.cLayer = null;
    const layerHost = document.getElementById('paint-layer');
    if (layerHost) {
      this.cLayer = new GridSelect({
        value: '', cls: 'inp sm', placeholder: '目标图层', options: [],
        onChange: (v) => { this.layerId = v; this._renderLayers(); },
      });
      layerHost.replaceWith(this.cLayer.el);
    }

    this.cursor = el('div', {
      style: {
        position: 'absolute', borderRadius: '50%', pointerEvents: 'none', display: 'none',
        border: '1.5px solid rgba(127,227,255,.95)', boxShadow: '0 0 0 1px rgba(0,0,0,.5)',
        zIndex: '4', transform: 'translate(-50%,-50%)',
      },
    });
    if (this.view) this.view.appendChild(this.cursor);

    this._buildStampRow();
    this._bind();
    this.refresh();
  }

  /* ============================================================
     结构
     ============================================================ */
  _buildStampRow() {
    if (!this.hud) return;
    const sel = new GridSelect({
      value: this.tex,
      cls: 'inp sm',
      options: BUILTIN_TEXTURES.filter((t) => t.id !== 'none').map((t) => ({ v: t.id, l: t.label })),
      onChange: (v) => { this.tex = v; this._ensureStampTex(this.tex); },
    });
    sel.el.id = 'paint-tex';
    this.cTex = sel;
    this.stampRow = el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '图章材质' }), sel);
    this.hud.appendChild(this.stampRow);
    this.hintRow = el('div', { class: 'ph-row', style: { color: 'var(--ink-faint)', fontSize: 'calc(10.5px * var(--ui-s) * var(--ui-fs))', lineHeight: '1.5' } },
      el('span', { text: '按住左键涂抹 · 滚轮调笔触 · B 退出涂鸦' }));
    this.hud.appendChild(this.hintRow);
  }

  /**
   * 图章下拉：内置贴图 + 导入的图片素材。
   * 素材是异步读出来的，先画内置列表，读完再补上导入的图片。
   */
  _fillStampOptions() {
    const sel = this.cTex;
    if (!sel) return;
    const fill = (assets) => {
      const imgs = (assets || []).filter((a) => a.kind === 'texture');
      const opts = [];
      for (const t of BUILTIN_TEXTURES) {
        if (t.id === 'none') continue;
        opts.push({ v: t.id, l: t.label });
      }
      for (const a of imgs) {
        opts.push({ v: 'asset:' + a.id, l: '图片：' + a.name });
      }
      // 选中的图片素材不在列表里（被删除 / 素材还没加载完）时给出占位，别静默回落成内置贴图
      if (this.tex && !BUILTIN_TEXTURES.some((t) => t.id === this.tex)
        && !imgs.some((a) => 'asset:' + a.id === this.tex)) {
        opts.push({ v: this.tex, l: '图片：' + this.tex + '（已丢失）' });
      }
      sel.setOptions(opts);
      sel.setValue(this.tex);
      // 图章要拿纹理像素源，必须已注册进贴图缓存，否则会退化成纯色
      this._ensureStampTex(this.tex);
    };
    fill(null);
    store.listAssets().then(fill).catch(() => { /* 读不到素材时保持内置列表 */ });
  }

  /** 把选中的图片素材注册进贴图缓存（paint.js 用 getTexture(tex).image 取像素源） */
  _ensureStampTex(id) {
    if (!id || !id.startsWith('asset:') || hasTexture(id)) return;
    resolveAssetURL(id.slice(6)).then((url) => { if (url) loadTextureFromURL(id, url); });
  }

  /* ============================================================
     开关
     ============================================================ */
  toggle(force) { this.setActive(force === undefined ? !this.active : !!force); }

  setActive(on) {
    if (this.active === on) return;
    this.active = on;
    const ed = this.ed;
    if (this.hud) this.hud.classList.toggle('hidden', !on);
    if (this.cursor) this.cursor.style.display = 'none';
    if (ed.viewport) ed.viewport.wheelHandler = on ? (e) => this._wheel(e) : null;
    if (ed.gizmo) {
      if (on) ed.gizmo.detach();
      else if (ed.mode !== 'select') ed.gizmo.attach(ed.selectedRecs());
    }
    for (const b of document.querySelectorAll('[data-painttool]')) {
      b.classList.toggle('on', on && b.dataset.painttool === this.tool);
    }
    this._syncToolButtons();
    if (this.cTex) this.cTex.setDisabled(!on);
    if (on) {
      this.refresh();
      ed.showHint('涂鸦模式：左键涂抹 · 滚轮改笔触大小 · 右键吸色 · B 或 Esc 退出', 9000);
      ed.log('进入 3D 涂鸦模式（' + (this.targetId ? '目标：' + this._targetName() : '自由涂抹') + '）', 'i');
    } else {
      this._held = false;
      this._endStroke();
      this.targetId = null;
      ed.showHint('已退出涂鸦模式', 2600);
    }
  }

  /** 工具按钮高亮（涂鸦 / 橡皮 / 材质章 / 吸色） */
  _syncToolButtons() {
    for (const b of document.querySelectorAll('[data-painttool]')) {
      b.classList.toggle('on', this.active && b.dataset.painttool === this.tool);
    }
    if (this.stampRow) this.stampRow.style.opacity = this.tool === 'stamp' ? '1' : '.45';
  }

  setTarget(id) {
    this.targetId = id || null;
    if (id) {
      this.setActive(true);
      this.refresh();
      this.ed.log('涂鸦目标锁定：' + this._targetName(), 'i');
    }
  }

  _targetName() {
    const o = this.targetId ? getObject(this.ed.level, this.targetId) : null;
    return o ? objectLabel(o) : '（无）';
  }

  /* ============================================================
     刷新界面
     ============================================================ */
  refresh() {
    this._renderLayers();
    this._syncInputs();
    this._fillStampOptions();
  }

  _syncInputs() {
    if (this.cColor) this.cColor.value = this.color;
    if (this.cAlpha) this.cAlpha.value = this.alpha;
    if (this.cSize) this.cSize.value = this.size;
    if (this.cSizeNum) this.cSizeNum.textContent = String(Math.round(this.size));
    if (this.cHard) this.cHard.value = this.hardness;
    if (this.cLayer) {
      const layers = this._layers();
      this.cLayer.setOptions([...layers].reverse().map((l) => ({ v: l.id, l: l.name })));
      this.cLayer.setValue(this._activeLayerId() || '');
    }
  }

  _layers() {
    return (this.ed.level && this.ed.level.paintLayers) || [];
  }

  _activeLayerId() {
    const layers = this._layers();
    if (!layers.length) return null;
    if (this.layerId && layers.some((l) => l.id === this.layerId)) return this.layerId;
    this.layerId = layers[layers.length - 1].id;
    return this.layerId;
  }

  _layerColors(layerId) {
    const out = [];
    const paints = (this.ed.level && this.ed.level.paints) || [];
    for (const p of paints) {
      if (p.layerId !== layerId) continue;
      for (const s of p.strokes) {
        if (s.m === 'color' && s.c) out.push(s.c);
        if (out.length >= 6) return out;
      }
    }
    return out;
  }

  _renderLayers() {
    const list = this.layerList;
    if (!list) return;
    clear(list);
    const layers = this._layers();
    const cur = this._activeLayerId();
    for (const l of [...layers].reverse()) {
      const colors = this._layerColors(l.id);
      const thumb = el('span', { class: 'lthumb' });
      if (colors.length) thumb.style.background = colors.length === 1 ? colors[0] : ('linear-gradient(135deg,' + colors.join(',') + ')');
      const rowEl = el('li', {}, el('div', {
        class: 'lrow' + (l.id === cur ? ' sel' : ''),
        title: l.name + '（点击设为当前图层 · 右键更多操作）',
        onclick: (e) => {
          if (e.target.classList.contains('eye') || e.target.classList.contains('lmeta')) return;
          this.layerId = l.id;
          this._syncInputs();
          this._renderLayers();
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          const top = layers.indexOf(l);
          contextMenu(e.clientX, e.clientY, [
            { label: l.name },
            { ico: '✎', l: '重命名图层', fn: () => this._renameLayer(l) },
            { ico: '🎛', l: '不透明度 / 混合模式…', fn: () => this._layerPopover(l, rowEl) },
            { ico: '↑', l: '上移一层', hint: top === layers.length - 1 ? '已是最上' : '', fn: () => this._moveLayer(l, 1) },
            { ico: '↓', l: '下移一层', hint: top === 0 ? '已是最下' : '', fn: () => this._moveLayer(l, -1) },
            { sep: true },
            { ico: '🧽', l: '清空该图层涂鸦', danger: true, fn: () => this._clearLayer(l) },
            { ico: '🗑', l: '删除图层', danger: true, fn: () => this._delLayer(l) },
          ]);
        },
      },
        thumb,
        el('span', { class: 'lname', style: { cursor: 'pointer' }, text: l.name, ondblclick: (e) => { e.stopPropagation(); this._renameLayer(l); } }),
        el('span', {
          class: 'lmeta', title: '不透明度 / 混合模式',
          text: (BLEND_MODES.find((b) => b.v === l.blendMode) || { l: '正常' }).l + ' ' + Math.round((l.opacity ?? 1) * 100) + '%',
        }),
        el('span', {
          class: 'eye' + (l.visible ? ' on' : ''), text: l.visible ? '👁' : '🚫', title: '显示/隐藏',
          onclick: (e) => {
            e.stopPropagation();
            this.ed.edit('切换图层可见', () => { this.ed.paint.setLayer(l.id, { visible: !l.visible }); }, {});
            this.ed.builder.refreshAll();
            this._renderLayers();
          },
        })));
      list.appendChild(rowEl);
    }
  }

  /* ---------- 图层操作 ---------- */
  _renameLayer(l) {
    promptBox('图层名称', l.name || '', { title: '重命名图层' }).then((n) => {
      if (n === null) return;
      this.ed.edit('重命名图层', () => { this.ed.paint.setLayer(l.id, { name: n || '图层' }); }, {});
      this.refresh();
    });
  }

  _moveLayer(l, dir) {
    this.ed.edit(dir > 0 ? '图层上移' : '图层下移', () => { this.ed.paint.moveLayer(l.id, dir); }, {});
    this.ed.builder.refreshAll();
    this.refresh();
  }

  _clearLayer(l) {
    const ed = this.ed;
    const prev = ed.snap();
    const surfaces = [...ed.paint.surfaces.keys()];
    for (const id of surfaces) ed.paint.clearObject(id, l.id);
    ed.paint.rebuildAll();
    ed.builder.refreshAll();
    ed.record('清空图层涂鸦', prev);
    this.refresh();
    toast('已清空「' + l.name + '」的涂鸦');
  }

  _delLayer(l) {
    const ed = this.ed;
    if (this._layers().length <= 1) { toast('至少要保留一个图层', 'err'); return; }
    const ok = window.confirm('确定删除图层「' + l.name + '」？该图层上的涂鸦会一并删除。');
    if (!ok) return;
    ed.edit('删除图层', () => { ed.paint.removeLayer(l.id); }, {});
    if (this.layerId === l.id) this.layerId = null;
    ed.builder.refreshAll();
    this.refresh();
  }

  /** 面板头部的删除按钮 */
  removeActiveLayer() {
    const id = this._activeLayerId();
    const l = id ? this.ed.paint.getLayer(id) : null;
    if (!l) return;
    this._delLayer(l);
  }

  _layerPopover(l, anchor) {
    const body = el('div', {});
    const opacityOut = el('span', { class: 'ph-num', text: Math.round((l.opacity ?? 1) * 100) });
    const range = el('input', {
      type: 'range', min: 0, max: 1, step: 0.01, value: l.opacity ?? 1,
      oninput: (e) => {
        l.opacity = Number(e.target.value);
        opacityOut.textContent = Math.round(l.opacity * 100);
        this.ed.paint.setLayer(l.id, { opacity: l.opacity });
        this.ed.builder.refreshAll();
      },
    });
    body.appendChild(el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '不透明度' }), range, opacityOut));
    const sel = optSelect(BLEND_MODES, l.blendMode, (v) => {
      this.ed.paint.setLayer(l.id, { blendMode: v });
      this.ed.builder.refreshAll();
      this._renderLayers();
    });
    body.appendChild(el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '混合模式' }), sel));
    popover({ title: '图层 · ' + l.name, body, anchor, width: 260, onClose: () => this._renderLayers() });
  }

  /* ============================================================
     输入
     ============================================================ */
  _bind() {
    if (this.hud) {
      // HUD 上的按钮 / 滑块：先截住指针事件，别让下层视口把它当成涂抹
      this.hud.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button,input,select,label')) e.stopPropagation();
      });
      this.hud.addEventListener('click', (e) => {
        const b = e.target.closest('[data-painttool]');
        if (!b) return;
        this.tool = b.dataset.painttool;
        this._syncToolButtons();
        this.ed.showHint('涂鸦工具：' + (TOOLS.find((t) => t.v === this.tool) || {}).l, 2000);
      });
    }
    if (this.cColor) this.cColor.addEventListener('input', () => { this.color = this.cColor.value; });
    if (this.cAlpha) this.cAlpha.addEventListener('input', () => { this.alpha = clamp(Number(this.cAlpha.value), 0, 1); });
    if (this.cSize) this.cSize.addEventListener('input', () => { this._setSize(Number(this.cSize.value)); });
    if (this.cHard) this.cHard.addEventListener('input', () => { this.hardness = clamp(Number(this.cHard.value), 0, 1); });

    const v = this.view;
    if (!v) return;
    v.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      if (isOverlay(e.target)) return;          // 点在 HUD / 工具条上：交给按钮
      if (e.button === 2) { this._pickColorAt(e.clientX, e.clientY); return; }
      if (e.button !== 0) return;
      if (e.altKey) return;                     // Alt+左键留给视口旋转
      this._held = true;
      this._beginStroke(e.clientX, e.clientY);
      if (this._stroke) {
        e.preventDefault();
        try { v.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
    });
    v.addEventListener('pointermove', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.inside = true;
      if (!this.active) return;
      if (this._stroke) this._strokeMove(e.clientX, e.clientY);
      // 起笔时没命中（点在空处）→ 指针划到物体上再续笔
      else if (this._held) this._beginStroke(e.clientX, e.clientY);
    });
    v.addEventListener('pointerleave', () => { this.pointer.inside = false; this.cursor.style.display = 'none'; });
    v.addEventListener('pointerup', () => { this._held = false; this._endStroke(); });
    v.addEventListener('pointercancel', () => { this._held = false; this._endStroke(); });
    v.addEventListener('contextmenu', (e) => { if (this.active) e.preventDefault(); });
  }

  _wheel(e) {
    const step = Math.max(1, this.size * 0.12);
    this._setSize(this.size + (e.deltaY > 0 ? -step : step));
  }

  _setSize(v) {
    this.size = clamp(Math.round(v), 1, EDITOR.paintSizes ? EDITOR.paintSizes[EDITOR.paintSizes.length - 1] : 400);
    if (this.cSize) this.cSize.value = this.size;
    if (this.cSizeNum) this.cSizeNum.textContent = String(this.size);
  }

  /* ---------- 涂抹 ---------- */
  _beginStroke(cx, cy) {
    const ed = this.ed;
    const paint = ed.paint;
    if (!paint) return;
    const hit = ed.viewport.pick(cx, cy, { helpers: false, skipLiquid: false });
    if (!hit || !hit.rec || !hit.uv) return;
    if (this.targetId && hit.rec.id !== this.targetId) {
      this.ed.showHint('涂鸦目标已锁定为「' + this._targetName() + '」', 1800);
      return;
    }
    if (this.tool === 'picker') { this._takeColor(hit); this._held = false; return; }
    const layerId = this._activeLayerId();
    if (!layerId) return;
    if (!this._prev) this._prev = ed.snap();     // 整个拖拽只记一次撤销点
    this._stroke = {
      rec: hit.rec,
      id: hit.rec.id,
      layerId,
      active: paint.beginStroke(hit.rec.id, layerId, {
        tool: this.tool === 'eraser' ? 'eraser' : 'brush',
        mode: this.tool === 'stamp' ? 'mat' : 'color',
        color: this.color,
        alpha: this.alpha,
        size: this.size,
        hardness: this.hardness,
        tex: this.tex,
      }),
    };
    paint.strokePoint(this._stroke.active, hit.uv);
    this._counter = 0;
    if (this.cursor) this.cursor.style.display = 'block';
  }

  _strokeMove(cx, cy) {
    const ed = this.ed;
    const hit = ed.viewport.pick(cx, cy, { helpers: false });
    if (!hit || !hit.rec || !hit.uv) return;
    if (hit.rec.id !== this._stroke.id) {
      // 划到另一个对象上：结束当前笔画并在新对象上接着画（一次拖拽可以跨多个对象）
      if (this.targetId && hit.rec.id !== this.targetId) return;
      this._finishStroke();
      this._beginStroke(cx, cy);
      return;
    }
    ed.paint.strokePoint(this._stroke.active, hit.uv);
    this._counter++;
    if (this._counter % 6 === 0) {
      try { ed.builder.syncMaterial(this._stroke.rec); } catch (e) { /* ignore */ }
    }
  }

  /** 结束当前笔画（不写历史） */
  _finishStroke() {
    if (!this._stroke) return;
    const ed = this.ed;
    const st = this._stroke;
    this._stroke = null;
    ed.paint.endStroke(st.active.s);
    try { ed.builder.syncMaterial(st.rec); } catch (e) { /* ignore */ }
  }

  _endStroke() {
    if (!this._stroke) return;
    const ed = this.ed;
    const st = this._stroke;
    this._finishStroke();
    if (this._prev) {
      ed.record('涂鸦 · ' + objectLabel(st.rec.o), this._prev);
      this._prev = null;
    }
    this.refresh();
  }

  _takeColor(hit) {
    const c = this.ed.paint.pickColor(hit.rec.id, hit.uv);
    if (!c) return;
    this.color = c;
    if (this.cColor) this.cColor.value = c;
    this.ed.showHint('吸取颜色 ' + c, 1600);
  }

  _pickColorAt(cx, cy) {
    const hit = this.ed.viewport.pick(cx, cy, { helpers: false });
    if (hit && hit.uv) this._takeColor(hit);
  }

  /* ---------- 光标 ---------- */
  update() {
    if (!this.active) { if (this.cursor.style.display !== 'none') this.cursor.style.display = 'none'; return; }
    if (!this.pointer.inside) { this.cursor.style.display = 'none'; return; }
    const r = this.view.getBoundingClientRect();
    const d = Math.max(6, this.size);
    this.cursor.style.display = 'block';
    this.cursor.style.width = d + 'px';
    this.cursor.style.height = d + 'px';
    this.cursor.style.left = (this.pointer.x - r.left) + 'px';
    this.cursor.style.top = (this.pointer.y - r.top) + 'px';
    this.cursor.style.borderColor = this.tool === 'eraser' ? 'rgba(255,140,170,.95)'
      : this.tool === 'picker' ? 'rgba(255,217,138,.95)' : 'rgba(127,227,255,.95)';
  }
}

export { TOOLS as PAINT_TOOLS };