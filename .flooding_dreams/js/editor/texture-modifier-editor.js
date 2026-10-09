/* ============================================================
   贴图修改器（Texture Modifier）· 独立编辑器
   ------------------------------------------------------------
   · 以一张贴图素材为「源」，叠若干层算子（调色 / 扭曲失真 / 风格化结构 / 叠加混合）
   · 左侧：源 / 尺寸 / 图层栈 / 图层参数；右侧：2D 无缝预览 + 3D 物体预览
   · 「烘焙并保存」= 把结果画成 PNG 写进关卡素材文件夹（本地化），
     同时把配方写进 level.texMods（随关卡 JSON 走，可再次打开编辑）
   · 游戏里它只是一张普通贴图 —— 所有加工都在进游戏之前算完
   ============================================================ */
import * as THREE from 'three';
import { el, clear, toast, hideScreens, showScreen, promptBox, confirmBox } from '../ui/dom.js';
import { row, numInput, optSelect, swtch, attachNumWheel } from './widgets.js';
import { GridSelect } from '../ui/grid-picker.js';
import { store } from '../core/storage.js';
import { forgetAssetURL } from '../core/settings.js';
import { TEXTURE_IDS, isHDRName, registerTexture, dropTexture, textureSourceCanvas } from '../core/textures.js';
import { refreshAssetManager } from './asset-manager.js';
import {
  TEXMOD_OPS, TEXMOD_CATS, BLEND_MODES, OP_BY_ID, TEXMOD_MIN, TEXMOD_MAX,
  newTexMod, defaultLayer, normalizeTexMod, texModByOutput,
  bakeTexMod, canvasToBlob, texModSize,
} from '../core/texture-modifier.js';

export const TEXMOD_SHAPES = [
  { v: 'cube', l: '立方体' },
  { v: 'sphere', l: '球体' },
  { v: 'plane', l: '平面' },
  { v: 'cylinder', l: '圆柱' },
  { v: 'torus', l: '圆环' },
];

const MAX_PREVIEW = 512;      // 预览烘焙尺寸上限（保存时按配方尺寸全量烘焙）

let _inst = null;
export function registerTexModEditor(inst) { _inst = inst; }
/** 打开贴图修改器（素材管理器 / 编辑器按钮调用） */
export function openTexModEditor(assetId) {
  if (!_inst) { toast('贴图修改器未就绪', 'err'); return; }
  _inst.open(assetId);
}

export class TextureModifierEditor {
  constructor(ed) {
    this.ed = ed;
    this.cfg = null;
    this.sel = 0;                 // 当前选中的图层下标
    this.open_ = false;
    this._ext = new Map();        // 外部输入贴图的像素源：id → canvas
    this._baked = null;
    this._outCreated = 0;
    this._timer = 0;
    this._busy = false;
    this._again = false;
    this._drag = null;

    this.side = document.getElementById('tm-side');
    this.c2d = document.getElementById('tm-2d');
    this.c3d = document.getElementById('tm-3d');
    this.titleEl = document.getElementById('tm-title');
    this.hint2d = document.getElementById('tm-2d-hint');
    this._bindToolbar();
    registerTexModEditor(this);
  }

  /* ============================================================
     开 / 关
     ============================================================ */
  _bindToolbar() {
    document.addEventListener('click', (e) => {
      if (!this.open_) return;
      const b = e.target.closest('[data-tm]');
      if (!b) return;
      const a = b.dataset.tm;
      if (a === 'close') this.close();
      else if (a === 'save') this.save();
      else if (a === 'reload') this.reload();
      else if (a === 'add-layer') this._addLayer();
    });
    const shape = document.getElementById('tm-shape');
    if (shape) {
      const sel = new GridSelect({
        value: 'cube', cls: 'inp sm', options: TEXMOD_SHAPES.map((s) => ({ v: s.v, l: s.l })),
        onChange: (v) => { this._shape = v; this._buildMesh(); },
      });
      shape.replaceWith(sel.el);
    }
    this._shape = 'cube';
    window.addEventListener('resize', () => { if (this.open_) this._resize(); });
  }

  /**
   * @param {string} [assetId] 以该贴图素材为起点：
   *   已经是某条配方的成品 → 打开这条配方；否则 → 新建一条以它为源的配方
   */
  async open(assetId) {
    const lv = this.ed && this.ed.level;
    if (!lv) { toast('先在编辑器里打开一个关卡', 'err'); return; }
    this.open_ = true;
    this._ext.clear();
    const bare = String(assetId || '').startsWith('asset:') ? String(assetId).slice(6) : String(assetId || '');
    let cfg = bare ? texModByOutput(lv, bare) : null;
    this._outCreated = 0;
    if (cfg) {
      this._outCreated = 0;
      try {
        const meta = await store.getAssetMeta(bare);
        this._outCreated = (meta && meta.created) || 0;
      } catch (e) { /* ignore */ }
    } else {
      cfg = newTexMod(bare ? '' : '新贴图', bare ? 'asset:' + bare : '');
      if (!bare) cfg.layers.push(defaultLayer('hsl'));
    }
    this.cfg = normalizeTexMod(cfg) || cfg;
    this.cfg.name = this.cfg.name || '新贴图';
    this.sel = Math.max(0, this.cfg.layers.length - 1);
    showScreen('texmod');
    if (this.ed.viewport) this.ed.viewport.enabled = false;   // 盖住编辑器时不响应飞行 / 旋转
    this.titleEl.textContent = '贴图修改器 · ' + this.cfg.name;
    await this._build(true);
    this._resize();
    this.refresh();
  }

  close() {
    this.open_ = false;
    hideScreens();
    if (this.ed.viewport) this.ed.viewport.enabled = true;
    this._dispose3D();
    if (this.ed && this.ed.refreshProps) this.ed.refreshProps();
  }

  async reload() {
    if (!this.cfg) return;
    const bare = this.cfg.output.startsWith('asset:') ? this.cfg.output.slice(6) : '';
    const lv = this.ed.level;
    const saved = bare ? texModByOutput(lv, bare) : null;
    if (!saved) { toast('这条配方还没保存过', 'err'); return; }
    const ok = await confirmBox('丢弃未保存的改动，重新载入已保存的配方？', { title: '重新载入' });
    if (!ok) return;
    this.cfg = normalizeTexMod(saved);
    this.sel = Math.max(0, this.cfg.layers.length - 1);
    this.titleEl.textContent = '贴图修改器 · ' + this.cfg.name;
    await this._build();
    this.refresh();
  }

  /* ============================================================
     面板
     ============================================================ */
  /** 重建左侧面板（forceOpts=true 时重新拉一次素材列表） */
  async _build(forceOpts) {
    if (!this.side) return;
    if (forceOpts || !this._opts) this._opts = await this._assetOptions();
    clear(this.side);
    this._buildSource();
    this._buildLayerSection();
  }

  _rebuild() { this._build(false); }

  async _assetOptions() {
    const out = [];
    for (const id of TEXTURE_IDS) out.push({ v: id, l: '内置 · ' + id });
    try {
      const recs = (await store.listAssets()) || [];
      for (const r of recs) {
        if (r.kind !== 'texture' || isHDRName(r.name)) continue;
        out.push({ v: 'asset:' + r.id, l: r.name || r.id });
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  _section(title, ...kids) {
    const s = el('div', { class: 'tm-sec' }, el('div', { class: 'tm-sec-h', text: title }), ...kids);
    this.side.appendChild(s);
    return s;
  }

  _buildSource() {
    const cfg = this.cfg;
    const nameInp = el('input', { class: 'inp sm', value: cfg.name, title: '成品贴图的名字（保存后进素材库）' });
    nameInp.addEventListener('change', () => {
      cfg.name = String(nameInp.value || '').trim() || '新贴图';
      this.titleEl.textContent = '贴图修改器 · ' + cfg.name;
    });

    const srcSel = optSelect(
      [{ v: '', l: '（选一张源贴图）' }].concat(this._opts),
      cfg.source, (v) => { cfg.source = v; this._ext.clear(); this.refresh(); }, 'inp sm');

    const sizeInp = numInput(cfg.size, { min: TEXMOD_MIN, max: TEXMOD_MAX, st: 64 });
    sizeInp.addEventListener('change', () => {
      cfg.size = Math.max(TEXMOD_MIN, Math.min(TEXMOD_MAX, Math.round(Number(sizeInp.value) || 512)));
      sizeInp.value = cfg.size;
      this._ext.clear();
      this.refresh();
    });

    this._section('配方',
      row('名称', nameInp),
      row('源贴图', srcSel, el('button', {
        class: 'mini', text: '＋图', title: '导入一张图片素材（同时进素材库）',
        onclick: () => this._importSource(),
      })),
      row('输出尺寸', sizeInp),
      el('div', { class: 'tm-note', text: '成品是一张新贴图素材：保存后进素材库，物体照常按素材引用它。' }));
  }

  async _importSource() {
    const { importAssetFile } = await import('./asset-manager.js');
    const rec = await importAssetFile('texture', { ed: this.ed });
    if (!rec) return;
    this.cfg.source = 'asset:' + rec.id;
    this._ext.clear();
    await this._build(true);
    this.refresh();
  }

  /* ---------- 图层栈 ---------- */
  _buildLayerSection() {
    const cfg = this.cfg;
    const box = el('div', { class: 'tm-layers' });
    if (!cfg.layers.length) box.appendChild(el('div', { class: 'tm-note', text: '还没有图层。' }));
    cfg.layers.forEach((l, i) => {
      const op = OP_BY_ID[l.op];
      const r = el('div', { class: 'tm-lrow' + (i === this.sel ? ' sel' : '') + (l.enabled ? '' : ' off') });
      r.appendChild(el('div', { class: 'tm-lname', text: (i + 1) + '. ' + (op ? op.l : l.op) }));
      r.appendChild(el('div', { class: 'tm-lacts' },
        el('button', {
          class: 'mini', text: l.enabled ? '👁' : '·', title: '显示 / 隐藏该层',
          onclick: (e) => { e.stopPropagation(); l.enabled = !l.enabled; this._rebuild(); this.refresh(); },
        }),
        el('button', {
          class: 'mini', text: '↑', title: '上移',
          onclick: (e) => { e.stopPropagation(); this._moveLayer(i, -1); },
        }),
        el('button', {
          class: 'mini', text: '↓', title: '下移',
          onclick: (e) => { e.stopPropagation(); this._moveLayer(i, 1); },
        }),
        el('button', {
          class: 'mini danger', text: '✕', title: '删除该层',
          onclick: (e) => { e.stopPropagation(); this._removeLayer(i); },
        })));
      r.addEventListener('click', () => { this.sel = i; this._rebuild(); });
      box.appendChild(r);
    });

    const catSel = new GridSelect({
      value: TEXMOD_CATS.length ? TEXMOD_CATS[0].v : '',
      cls: 'inp sm',
      options: TEXMOD_CATS,
      onChange: () => fillOps(),
    });
    const opSel = new GridSelect({ value: '', cls: 'inp sm', options: [] });
    const fillOps = () => {
      const ops = TEXMOD_OPS.filter((o) => o.c === catSel.value).map((o) => ({ v: o.v, l: o.l }));
      opSel.setOptions(ops);
      opSel.setValue(ops.length ? ops[0].v : '');
    };
    fillOps();

    const addRow = el('div', { class: 'tm-add' }, catSel, opSel, el('button', {
      class: 'mini', text: '＋ 添加图层',
      onclick: () => {
        const op = opSel.value;
        if (!OP_BY_ID[op]) return;
        const l = defaultLayer(op);
        cfg.layers.splice(this.sel + 1, 0, l);
        this.sel = cfg.layers.indexOf(l);
        this._rebuild();
        this.refresh();
      },
    }));

    this._section('图层（从上到下依次作用）', box, addRow);
    this._buildParams();
  }

  _moveLayer(i, d) {
    const list = this.cfg.layers;
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const [l] = list.splice(i, 1);
    list.splice(j, 0, l);
    this.sel = j;
    this._rebuild();
    this.refresh();
  }

  _removeLayer(i) {
    this.cfg.layers.splice(i, 1);
    this.sel = Math.max(0, Math.min(this.sel, this.cfg.layers.length - 1));
    this._rebuild();
    this.refresh();
  }

  _addLayer() {
    if (!this.cfg) return;
    const l = defaultLayer('hsl');
    this.cfg.layers.push(l);
    this.sel = this.cfg.layers.length - 1;
    this._rebuild();
    this.refresh();
  }

  /* ---------- 选中图层的参数 ---------- */
  _buildParams() {
    const l = this.cfg.layers[this.sel];
    if (!l) return;
    const op = OP_BY_ID[l.op];
    if (!op) return;
    const kids = [];

    kids.push(row('启用', swtch(l.enabled !== false, (v) => { l.enabled = v; this._rebuild(); this.refresh(); })));
    kids.push(row('混合模式', optSelect(BLEND_MODES, l.blend, (v) => { l.blend = v; this.refresh(); }, 'inp sm')));

    const opin = numInput(l.opacity, { min: 0, max: 1, st: 0.05 });
    attachNumWheel(opin, { min: 0, max: 1, st: 0.05, onStep: (v) => { l.opacity = v; this.refresh(); } });
    opin.addEventListener('change', () => { l.opacity = Math.max(0, Math.min(1, Number(opin.value) || 0)); this.refresh(); });
    kids.push(row('不透明度', opin));

    const inputs = [
      { v: 'below', l: '下层结果' },
      { v: 'source', l: '源图' },
    ].concat(this._opts);
    if (l.op === 'image') inputs.unshift({ v: '', l: '（选择要叠加的贴图）' });
    kids.push(row('输入', optSelect(inputs, l.input || (l.op === 'image' ? '' : 'below'),
      (v) => { l.input = v; this._ext.clear(); this.refresh(); }, 'inp sm')));

    for (const p of op.p) {
      kids.push(row(p.l || p.k, this._paramControl(l, p)));
    }
    this._section('图层参数 · ' + op.l, ...kids);
  }

  _paramControl(l, p) {
    const v = l.params[p.k];
    if (p.t === 'bool') {
      return swtch(!!v, (nv) => { l.params[p.k] = nv; this.refresh(); });
    }
    if (p.t === 'select') {
      return optSelect(p.o || [], v, (nv) => { l.params[p.k] = nv; this.refresh(); }, 'inp sm');
    }
    if (p.t === 'color') {
      const c = el('input', { class: 'tm-color', type: 'color', value: v || '#ffffff' });
      c.addEventListener('input', () => { l.params[p.k] = c.value; this.refresh(); });
      return c;
    }
    const inp = numInput(v, { min: p.min, max: p.max, st: p.st });
    attachNumWheel(inp, {
      min: p.min, max: p.max, st: p.st,
      onStep: (nv) => { l.params[p.k] = nv; this.refresh(); },
    });
    inp.addEventListener('input', () => {
      const nv = Number(inp.value);
      if (isFinite(nv)) { l.params[p.k] = nv; this.refresh(); }
    });
    return inp;
  }

  /* ============================================================
     烘焙 + 预览
     ============================================================ */
  refresh() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._render(), 110);
  }

  async _render() {
    if (this._busy) { this._again = true; return; }
    this._busy = true;
    try {
      const canvas = await this._bake();
      this._baked = canvas;
      if (canvas) { this._paint2D(canvas); this._paint3D(canvas); }
    } finally {
      this._busy = false;
      if (this._again) { this._again = false; this._render(); }
    }
  }

  async _bake() {
    const cfg = this.cfg;
    if (!cfg || !cfg.source) {
      this.hint2d.textContent = '先选一张源贴图';
      return null;
    }
    this.hint2d.textContent = '';
    const size = Math.min(texModSize(cfg, null), MAX_PREVIEW);
    const src = await textureSourceCanvas(cfg.source, size);
    if (!src) { this.hint2d.textContent = '源贴图读取失败（HDR 全景不能作为 2D 贴图源）'; return null; }
    await this._preloadExternal(size);
    const tmp = { ...cfg, size };
    return bakeTexMod(tmp, src, { resolve: (id) => this._ext.get(id) || null });
  }

  /** 预取所有「外部贴图输入」的像素源（bake 的 resolve 是同步的） */
  async _preloadExternal(size) {
    const ids = new Set();
    for (const l of (this.cfg.layers || [])) {
      const inId = l.input;
      if (inId && inId !== 'below' && inId !== 'source') ids.add(inId);
    }
    for (const id of ids) {
      if (this._ext.has(id)) continue;
      try {
        const c = await textureSourceCanvas(id, size);
        if (c) this._ext.set(id, c);
      } catch (e) { /* ignore */ }
    }
  }

  /** 2D 无缝预览：2×2 平铺，一眼看出接缝 */
  _paint2D(canvas) {
    const c = this.c2d;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(64, c.clientWidth), h = Math.max(64, c.clientHeight);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const s = Math.floor(Math.min(w, h) / 2);
    const ox = Math.round((w - s * 2) / 2), oy = Math.round((h - s * 2) / 2);
    g.imageSmoothingQuality = 'high';
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) g.drawImage(canvas, ox + x * s, oy + y * s, s, s);
    g.strokeStyle = 'rgba(255,255,255,.18)';
    g.lineWidth = 1;
    g.strokeRect(ox + 0.5, oy + 0.5, s * 2 - 1, s * 2 - 1);
    g.beginPath();
    g.moveTo(ox + s + 0.5, oy); g.lineTo(ox + s + 0.5, oy + s * 2);
    g.moveTo(ox, oy + s + 0.5); g.lineTo(ox + s * 2, oy + s + 0.5);
    g.strokeStyle = 'rgba(255,255,255,.1)';
    g.stroke();
  }

  /* ---------- 3D 预览（自己的小渲染器，不干扰编辑器主画布） ---------- */
  _ensure3D() {
    if (this._renderer || !this.c3d) return;
    try {
      this._renderer = new THREE.WebGLRenderer({ canvas: this.c3d, antialias: true, alpha: true });
    } catch (e) { this._renderer = null; return; }
    this._renderer.setClearColor(0x000000, 0);
    this._scene = new THREE.Scene();
    this._cam = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this._cam.position.set(0, 0.9, 3.1);
    this._cam.lookAt(0, 0, 0);
    this._scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const d = new THREE.DirectionalLight(0xffffff, 1.5);
    d.position.set(2.4, 3.4, 2.6);
    this._scene.add(d);
    const d2 = new THREE.DirectionalLight(0xbcd0ff, 0.6);
    d2.position.set(-2.6, -1.4, -2.2);
    this._scene.add(d2);
    this._group = new THREE.Group();
    this._scene.add(this._group);
    this._spin = { y: 0.6, x: 0.25 };
    this._buildMesh();

    /* 拖动旋转 */
    let dragging = false, lx = 0, ly = 0;
    this.c3d.addEventListener('pointerdown', (e) => {
      dragging = true; lx = e.clientX; ly = e.clientY;
      this.c3d.setPointerCapture(e.pointerId);
    });
    this.c3d.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this._spin.y += (e.clientX - lx) * 0.01;
      this._spin.x = Math.max(-1.2, Math.min(1.2, this._spin.x + (e.clientY - ly) * 0.01));
      lx = e.clientX; ly = e.clientY;
      this._poseMesh();
    });
    const stop = (e) => { dragging = false; try { this.c3d.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ } };
    this.c3d.addEventListener('pointerup', stop);
    this.c3d.addEventListener('pointercancel', stop);
  }

  _buildMesh() {
    if (!this._group) return;
    while (this._group.children.length) {
      const m = this._group.children.pop();
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
    const s = this._shape || 'cube';
    const geo = s === 'sphere' ? new THREE.SphereGeometry(0.85, 48, 32)
      : s === 'plane' ? new THREE.PlaneGeometry(1.7, 1.7)
        : s === 'cylinder' ? new THREE.CylinderGeometry(0.68, 0.68, 1.5, 40)
          : s === 'torus' ? new THREE.TorusGeometry(0.62, 0.26, 24, 64)
            : new THREE.BoxGeometry(1.25, 1.25, 1.25);
    this._mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.05, side: THREE.DoubleSide });
    this._mesh = new THREE.Mesh(geo, this._mat);
    this._group.add(this._mesh);
    this._poseMesh();
    if (this._baked) this._paint3D(this._baked);
  }

  _poseMesh() {
    if (!this._group) return;
    this._group.rotation.set(this._spin.x, this._spin.y, 0);
  }

  _paint3D(canvas) {
    this._ensure3D();
    if (!this._renderer || !this._mat) return;
    if (this._tex) { this._mat.map = null; this._tex.dispose(); this._tex = null; }
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
    t.anisotropy = 4;
    t.needsUpdate = true;
    this._tex = t;
    this._mat.map = t;
    this._mat.needsUpdate = true;
    this._draw3D();
  }

  _draw3D() {
    if (!this._renderer) return;
    const w = Math.max(64, this.c3d.clientWidth), h = Math.max(64, this.c3d.clientHeight);
    this._renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this._renderer.setSize(w, h, false);
    this._cam.aspect = w / h;
    this._cam.updateProjectionMatrix();
    this._renderer.render(this._scene, this._cam);
  }

  _dispose3D() {
    if (this._tex) { this._tex.dispose(); this._tex = null; }
    if (this._renderer) { try { this._renderer.dispose(); } catch (e) { /* ignore */ } }
    this._renderer = null;
    this._scene = null; this._cam = null; this._group = null; this._mat = null; this._mesh = null;
  }

  _resize() {
    if (!this.open_) return;
    if (this._baked) this._paint2D(this._baked);
    this._ensure3D();
    this._draw3D();
  }

  /* ============================================================
     保存：烘焙 PNG → 关卡素材；配方 → level.texMods
     ============================================================ */
  async save() {
    const cfg = this.cfg;
    const ed = this.ed;
    if (!cfg || !ed || !ed.level) return;
    if (!cfg.source) { toast('先选一张源贴图', 'err'); return; }
    if (!cfg.layers.length) { toast('至少添加一个图层', 'err'); return; }

    const name = await promptBox('成品贴图名称', cfg.name || '新贴图', { title: '烘焙并保存' });
    if (name === null) return;
    cfg.name = String(name).trim() || '新贴图';

    const src = await textureSourceCanvas(cfg.source, texModSize(cfg, null));
    if (!src) { toast('源贴图读取失败', 'err'); return; }
    const size = texModSize(cfg, src);
    await this._preloadExternal(size);
    const canvas = bakeTexMod({ ...cfg, size }, src, { resolve: (id) => this._ext.get(id) || null });
    const blob = await canvasToBlob(canvas);
    if (!blob) { toast('烘焙失败（画布导出异常）', 'err'); return; }

    const oldId = cfg.output.startsWith('asset:') ? cfg.output.slice(6) : '';
    if (oldId) { forgetAssetURL(oldId); dropTexture('asset:' + oldId); }
    let rec = null;
    try {
      rec = await store.saveAsset(blob, 'texture', {
        id: oldId || undefined,
        name: cfg.name + '.png',
        created: oldId && this._outCreated ? this._outCreated : undefined,
      });
    } catch (e) {
      toast('写入素材失败：' + (e && e.message ? e.message : e), 'err', 3200);
      return;
    }
    if (!rec) { toast('写入素材失败', 'err'); return; }
    this._outCreated = rec.created || Date.now();
    cfg.output = 'asset:' + rec.id;
    registerTexture(cfg.output, canvas);

    /* 配方写进关卡（同一条成品只留一条配方），可撤销 */
    const prev = ed.snap();
    const list = ed.level.texMods || (ed.level.texMods = []);
    const copy = JSON.parse(JSON.stringify(cfg));
    const i = list.findIndex((m) => m && m.output === cfg.output);
    if (i >= 0) list[i] = copy; else list.push(copy);
    ed.record('贴图修改器「' + cfg.name + '」', prev);

    this.titleEl.textContent = '贴图修改器 · ' + cfg.name;
    toast('已烘焙「' + cfg.name + '」→ 素材库（' + size + '×' + size + '）', 'ok');
    if (ed.log) ed.log('贴图修改器烘焙 ' + cfg.name + '（' + size + 'px，' + cfg.layers.length + ' 层）', 'i');
    refreshAssetManager();
    if (ed.inspector && ed.inspector.invalidateAssets) ed.inspector.invalidateAssets();
    if (ed.refreshProps) ed.refreshProps();
    try { ed.builder && ed.builder.refreshAll(); } catch (e) { /* ignore */ }
  }
}