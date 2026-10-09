/* ============================================================
   编辑器 · 贴纸放置（P 键开关）
   - 从素材库挑一张图片（或直接导入）→ 鼠标射线贴到模型表面
   - 贴纸盖在底层贴图与涂鸦之上，保留它们；只把该区域的粗糙度 / 法线换成贴纸自己的
   - 左键贴 / 选中 · 拖动移动 · 滚轮改大小 · 右键菜单复制 / 删除
   - 每张贴纸按对象独立成层，随关卡保存 / 打包（引用走 asset:，本地化无依赖）
   ============================================================ */
import * as THREE from 'three';
import { EDITOR } from '../config.js';
import { clamp, deg2rad, rad2deg } from '../core/util.js';
import { el, clear, toast } from '../ui/dom.js';
import { contextMenu } from './widgets.js';
import { GridSelect, streamAssetOptions } from '../ui/grid-picker.js';
import { resolveAssetURL } from '../core/settings.js';
import { getTexture, hasTexture, loadTextureFromURL } from '../core/textures.js';
import { importAssetFile } from './asset-manager.js';
import { FACE_ATLAS } from '../world/objectTypes.js';

const _UPX = new THREE.Vector3(1, 0, 0);
const _UPY = new THREE.Vector3(0, 1, 0);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _p = new THREE.Vector3();

export class StickerEditor {
  constructor(ed) {
    this.ed = ed;
    this.active = false;
    this.assetId = '';              // 当前要贴的图片素材（'asset:xxx'）
    this.quality = EDITOR.defaultStickerSize;
    this.selectedId = null;
    this.objectId = null;           // 贴纸列表跟着「最近一次命中的对象」走
    this.drag = null;
    this._livePrev = null;          // 滑杆拖动中的撤销快照
    this._liveLabel = '';
    this._pending = null;
    this._lastMove = 0;
    this._mark = null;              // 选中贴纸在表面上的世界标记 { point, normal, half }
    this._markId = null;

    /* ---------- 浮层 ---------- */
    this.hud = document.getElementById('ed-sticker-hud');
    if (!this.hud) {
      this.hud = el('div', { id: 'ed-sticker-hud', class: 'hidden' });
      const view = document.getElementById('ed-view');
      const bar = document.getElementById('ed-gizmo-bar');
      if (view) view.insertBefore(this.hud, bar || null);
    }
    this._build();
    this._buildOutline();
    this.refresh();
  }

  /* ============================================================
     结构
     ============================================================ */
  _build() {
    const hud = this.hud;
    if (!hud) return;
    clear(hud);
    const row = (...k) => el('div', { class: 'ph-row' }, ...k);
    const lab = (t) => el('span', { class: 'ph-lab', text: t });

    this.cAsset = new GridSelect({
      value: this.assetId,
      cls: 'inp sm',
      placeholder: '（选择图片）',
      onChange: (v) => { this.assetId = v; this._ensureTex(); },
    });
    this.cAsset.el.id = 'sticker-asset';
    hud.appendChild(row(lab('贴纸图片'), this.cAsset, el('button', {
      class: 'mini', text: '＋图', title: '导入图片素材（同时进素材库）',
      onclick: () => this._import(),
    })));

    this.cQuality = new GridSelect({
      value: String(this.quality),
      cls: 'inp sm',
      options: EDITOR.stickerSizes.map((s) => ({ v: String(s), l: s + ' px' })),
      onChange: (v) => {
        this.quality = clamp(Number(v) || EDITOR.defaultStickerSize, 512, 4096);
        const st = this._sel();
        if (st) this.edit('贴纸清晰度', () => { this.ed.paint.updateSticker(st.id, { size: this.quality }); }, st.objectId);
      },
    });
    this.cQuality.el.id = 'sticker-quality';
    hud.appendChild(row(lab('清晰度'), this.cQuality));

    this.cSize = el('input', {
      type: 'range', min: '0.03', max: '1.5', step: '0.01', value: '0.4',
      oninput: () => this._onSizeInput(),
    });
    this.cSizeNum = el('span', { class: 'ph-num', text: '0.40' });
    hud.appendChild(row(lab('大小'), this.cSize, this.cSizeNum));

    this.cRot = el('input', {
      type: 'range', min: '-180', max: '180', step: '1', value: '0',
      oninput: () => this._onRotInput(),
    });
    hud.appendChild(row(lab('旋转'), this.cRot));

    this.cRough = el('input', {
      type: 'range', min: '0', max: '1', step: '0.01', value: '0.45',
      oninput: () => this._onRoughInput(),
    });
    hud.appendChild(row(lab('粗糙度'), this.cRough));

    this.cTrans = el('input', {
      type: 'range', min: '0', max: '1', step: '0.01', value: '0',
      oninput: () => this._onTransInput(),
    });
    hud.appendChild(row(lab('透明度'), this.cTrans));

    this.list = el('ul', { class: 'sk-list' });
    hud.appendChild(el('div', { class: 'ph-row', style: { alignItems: 'flex-start' } }, lab('贴纸层'), this.list));
    hud.appendChild(el('div', {
      class: 'ph-row', style: { color: 'var(--ink-faint)', fontSize: 'calc(10.5px * var(--ui-s) * var(--ui-fs))', lineHeight: '1.5' },
    }, el('span', { text: '左键贴到表面 / 选中 · 拖动移动 · 滚轮改大小 · 右键菜单 · P 退出' })));

    // 滑杆松手才记一次撤销
    for (const c of [this.cSize, this.cRot, this.cRough, this.cTrans]) {
      c.addEventListener('change', () => this._endLive());
    }
  }

  /** 选中贴纸的轮廓（贴纸是贴在表面上的，用线框提示位置与大小） */
  _buildOutline() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    this.outlineGeo = geo;
    this.outline = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
      color: 0x7fe3ff, depthTest: false, transparent: true, opacity: 0.95,
    }));
    this.outline.userData.helper = true;
    this.outline.frustumCulled = false;
    this.outline.visible = false;
  }

  /** 场景每次打开都是新的（编辑器 open 会重建 Scene），轮廓要重新挂上去 */
  attach() {
    if (!this.outline || !this.ed.scene) return;
    if (this.outline.parent !== this.ed.scene) this.ed.scene.add(this.outline);
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
    if (ed.viewport) ed.viewport.wheelHandler = on ? (e) => this._wheel(e) : null;
    this.drag = null;
    this._pending = null;
    this._livePrev = null;
    if (ed.paint) ed.paint._fast = false;
    if (this.outline) this.outline.visible = false;
    if (ed.gizmo) {
      if (on) ed.gizmo.detach();
      else if (ed.mode !== 'select') ed.gizmo.attach(ed.selectedRecs());
    }
    if (on) {
      this.attach();
      this.refresh();
      ed.showHint('贴纸模式：选好图片 → 左键贴到模型表面 · 拖动移动 · 滚轮改大小 · 右键菜单 · P / Esc 退出', 9000);
      ed.log('进入贴纸模式', 'i');
    } else {
      this.selectedId = null;
      this._mark = null;
      this._markId = null;
      ed.showHint('已退出贴纸模式', 2600);
    }
  }

  /* ============================================================
     刷新界面
     ============================================================ */
  refresh() {
    this._fillAssets();
    this._syncInputs();
    this._renderList();
  }

  /**
   * 图片素材下拉：素材是异步读出来的，先画当前值，读完再补全。
   * 只列图片素材（.hdr 是全景环境图，不是像素图，贴不上）。
   */
  _fillAssets() {
    const sel = this.cAsset;
    if (!sel) return;
    // 素材走流式 loader（分批显示 + 缓存），不要同步读 store
    const load = streamAssetOptions('texture', {
      filter: (a) => !String(a.l || '').toLowerCase().endsWith('.hdr'),
      missing: (all) => (this.assetId && !all.some((o) => o.v === this.assetId))
        ? { v: this.assetId, l: '图片：' + String(this.assetId).slice(6) + '（已丢失）' }
        : null,
    });
    sel.setOptions(load);
    // 素材是异步读出来的，先画当前值，读完再补默认值
    sel.ready().then((all) => {
      const next = this.assetId || ((all && all[0]) ? all[0].v : '');
      if (!this.assetId && next) this.assetId = next;
      sel.setValue(next);
      this._ensureTex();
    }).catch(() => {});
  }

  _sel() { return this.selectedId ? this.ed.paint.getSticker(this.selectedId) : null; }

  /**
   * 大小滑杆的口径统一成「命中那一面的比例」：
   * 方块画布是 3×3 面图集，贴纸存的是图集 uv，一个面只占 1/3，得换算回来
   * 否则滑杆 0.03~1.5 里能用的只有前 22%，默认值还会直接撑满整面。
   */
  _sizeScale(objectId) {
    const o = this.ed.level && this.ed.level.objects.find((x) => x.id === objectId);
    return o && (o.shape || 'block') === 'block' ? 1 / FACE_ATLAS.cols : 1;
  }

  _syncInputs() {
    const st = this._sel();
    if (!st) return;
    const long = Math.max(st.w, st.h) / this._sizeScale(st.objectId);
    if (this.cSize) this.cSize.value = String(long);
    if (this.cSizeNum) this.cSizeNum.textContent = long.toFixed(2);
    if (this.cRot) this.cRot.value = String(Math.round(rad2deg(st.rot || 0)));
    if (this.cRough) this.cRough.value = String(st.rough);
    if (this.cTrans) this.cTrans.value = String(st.trans);
    if (this.cQuality && EDITOR.stickerSizes.includes(st.size)) this.cQuality.setValue(String(st.size));
    if (this.cAsset && st.tex) this.cAsset.setValue(st.tex);
    this.quality = st.size || this.quality;
  }

  _renderList() {
    const list = this.list;
    if (!list) return;
    clear(list);
    const oid = this.objectId || (this._sel() && this._sel().objectId);
    if (!oid) { list.appendChild(el('div', { class: 'sk-empty', text: '把贴纸贴到模型上' })); return; }
    const all = this.ed.paint.getStickers(oid);
    if (!all.length) { list.appendChild(el('div', { class: 'sk-empty', text: '这个对象还没有贴纸' })); return; }
    for (let i = all.length - 1; i >= 0; i--) {
      const st = all[i];
      const thumb = el('img', { alt: '' });
      if (st.tex.startsWith('asset:')) {
        resolveAssetURL(st.tex.slice(6)).then((u) => { if (u) thumb.src = u; }).catch(() => {});
      }
      list.appendChild(el('div', {
        class: 'sk-item' + (st.id === this.selectedId ? ' sel' : ''),
        title: '点击选中 · 右键更多操作',
        onclick: () => this.select(st.id),
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); this._menu(e, st); },
      }, thumb, el('span', { text: '第 ' + (i + 1) + ' 张 · ' + Math.max(st.w, st.h).toFixed(2) })));
    }
  }

  /* ============================================================
     选中
     ============================================================ */
  select(id, hit) {
    this.selectedId = id || null;
    const st = this._sel();
    if (st) {
      this.objectId = st.objectId;
      this.quality = st.size || this.quality;
      if (this.cQuality) this.cQuality.setValue(String(this.quality));
    }
    if (hit && id) { this._syncMark(hit); this._markId = id; }
    if (!id) { this._mark = null; this._markId = null; }
    if (this.outline) this.outline.visible = false;
    this._syncInputs();
    this._renderList();
  }

  /** 选中贴纸的世界标记：命中点 + 表面法线 + 对象尺度（轮廓用） */
  _syncMark(hit) {
    if (!hit || !hit.point) { this._mark = null; return; }
    const n = hit.face && hit.face.normal && hit.object
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : _UPY.clone();
    this._mark = { point: hit.point.clone(), normal: n, half: this._halfExtent(hit.rec) };
  }

  _halfExtent(rec) {
    const s = rec && Array.isArray(rec.o && rec.o.size) ? rec.o.size : null;
    const m = s ? Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])) : 2;
    return Math.max(0.5, m * 0.5);
  }

  /* ============================================================
     指针
     ============================================================ */
  onDown(e) {
    if (!this.active) return;
    const hit = this.ed.viewport.pick(e.clientX, e.clientY, { helpers: false });
    if (!hit || !hit.uv) { this.select(null); return; }
    this.objectId = hit.rec.id;
    const exist = this._hitSticker(hit.rec.id, hit.uv);
    if (exist) {
      this.select(exist.id, hit);
      this._beginDrag(e, exist, hit);
      return;
    }
    this._place(hit).then((st) => {
      if (!st) return;
      this.select(st.id, hit);
      this.objectId = st.objectId;
      this._beginDrag(e, st, hit);
    });
  }

  onMove(e) {
    if (!this.active) return;
    if (!this.drag) return;
    const hit = this.ed.viewport.pick(e.clientX, e.clientY, { helpers: false });
    if (!hit || !hit.uv || hit.rec.id !== this.drag.objectId) return;
    this._pending = hit;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this._lastMove < 33) return;    // 高清画布重合成不便宜，拖动时节流
    this._lastMove = now;
    this._applyPending();
  }

  onUp() {
    if (!this.active) return;
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    this._applyPending();                     // 收尾一定落到最终位置
    this._pending = null;
    if (this.ed.paint) this.ed.paint._fast = false;
    if (d.moved) this.ed.record('移动贴纸', d.prev);
    this._refreshObject(d.objectId, false);   // 全量重合成（含粗糙度 / 法线）
    this.select(d.id);
  }

  _beginDrag(e, st, hit) {
    this.drag = { id: st.id, objectId: st.objectId, moved: false, prev: this.ed.snap() };
    this._pending = null;
    this._lastMove = 0;
    if (this.ed.paint) this.ed.paint._fast = true;   // 拖动中先不重算粗糙度 / 法线
    try { this.ed.viewDom.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  _applyPending() {
    const hit = this._pending;
    const d = this.drag;
    if (!hit || !d) return;
    this.ed.paint.updateSticker(d.id, { u: hit.uv[0], v: hit.uv[1] });
    d.moved = true;
    this._syncMark(hit);
    this._markId = d.id;
  }

  _hitSticker(objectId, uv) {
    const list = this.ed.paint.getStickers(objectId);
    for (let i = list.length - 1; i >= 0; i--) {
      const st = list[i];
      const dx = uv[0] - st.u;
      const dy = -(uv[1] - st.v);
      const th = -(Number(st.rot) || 0);
      const c = Math.cos(th), s = Math.sin(th);
      const lx = dx * c + dy * s;
      const ly = -dx * s + dy * c;
      if (Math.abs(lx) <= st.w / 2 && Math.abs(ly) <= st.h / 2) return st;
    }
    return null;
  }

  onContext(e) {
    if (!this.active) return;
    const hit = this.ed.viewport.pick(e.clientX, e.clientY, { helpers: false });
    if (hit && hit.uv) {
      const st = this._hitSticker(hit.rec.id, hit.uv);
      if (st) { this.select(st.id, hit); this._menu(e, st); return; }
      this.objectId = hit.rec.id;
      this._renderList();
      contextMenu(e.clientX, e.clientY, [
        { label: '贴纸' },
        { ico: '＋', l: '在这里贴一张贴纸', fn: () => { this._place(hit).then((s) => { if (s) this.select(s.id, hit); }); } },
      ]);
      return;
    }
    contextMenu(e.clientX, e.clientY, [
      { label: '贴纸' },
      { ico: '✋', l: '取消选择', fn: () => this.select(null) },
    ]);
  }

  _menu(e, st) {
    contextMenu(e.clientX, e.clientY, [
      { label: '贴纸' },
      { ico: '⧉', l: '复制一张', fn: () => this._duplicate(st) },
      { sep: true },
      { ico: '🗑', l: '删除贴纸', danger: true, fn: () => this._remove(st) },
    ]);
  }

  /* ============================================================
     放置 / 增删
     ============================================================ */
  async _place(hit) {
    if (!hit || !hit.uv) return null;
    if (!this.assetId) { toast('先在贴纸面板选一张图片（或点 ＋图 导入）', 'err', 3200); return null; }
    const img = await this._loadTex(this.assetId);
    if (!img) { toast('贴纸图片还没就绪', 'err'); return null; }
    const aspect = (img.width && img.height) ? img.width / img.height : 1;
    const long = clamp(Number(this.cSize && this.cSize.value) || 0.4, 0.03, 1.5);
    const k = this._sizeScale(hit.rec.id);     // 方块要折算成图集 uv
    const w = (aspect >= 1 ? long : long * aspect) * k;
    const h = (aspect >= 1 ? long / aspect : long) * k;
    let st = null;
    this.edit('放置贴纸', () => {
      st = this.ed.paint.addSticker(hit.rec.id, {
        tex: this.assetId,
        u: hit.uv[0], v: hit.uv[1], w, h,
        rot: deg2rad(Number(this.cRot && this.cRot.value) || 0),
        rough: Number(this.cRough && this.cRough.value) || 0,
        trans: Number(this.cTrans && this.cTrans.value) || 0,
        size: this.quality,
      });
    }, hit.rec.id);
    if (!st) { toast('贴纸已达上限（每个对象最多 ' + EDITOR.stickerMaxPerObject + ' 张）', 'err', 3200); return null; }
    this._renderList();
    return st;
  }

  _remove(st) {
    this.edit('删除贴纸', () => { this.ed.paint.removeSticker(st.id); }, st.objectId);
    if (this.selectedId === st.id) this.select(null);
    this._renderList();
  }

  _duplicate(st) {
    let copy = null;
    this.edit('复制贴纸', () => {
      copy = this.ed.paint.addSticker(st.objectId, {
        tex: st.tex,
        u: clamp(st.u + st.w * 0.12, -8, 9),
        v: clamp(st.v - st.h * 0.12, -8, 9),
        w: st.w, h: st.h, rot: st.rot, rough: st.rough, trans: st.trans, size: st.size,
      });
    }, st.objectId);
    if (copy) this.select(copy.id);
    this._renderList();
  }

  async _import() {
    const rec = await importAssetFile('texture', { ed: this.ed });
    if (!rec) return;
    this.assetId = 'asset:' + rec.id;
    await _tick();
    this.refresh();
  }

  /* ============================================================
     参数控制
     ============================================================ */
  _onSizeInput() {
    const long = Number(this.cSize.value) || 0.4;
    if (this.cSizeNum) this.cSizeNum.textContent = long.toFixed(2);
    const st = this._sel();
    if (!st) return;
    this._beginLive('调整贴纸大小');
    const cur = Math.max(st.w, st.h) / this._sizeScale(st.objectId) || 0.01;
    const f = long / cur;                      // 比值与单位无关，乘回 uv 就好
    if (this.ed.paint) this.ed.paint._fast = true;
    this.ed.paint.updateSticker(st.id, { w: st.w * f, h: st.h * f });
  }

  _onRotInput() {
    const st = this._sel();
    if (!st) return;
    this._beginLive('旋转贴纸');
    if (this.ed.paint) this.ed.paint._fast = true;
    this.ed.paint.updateSticker(st.id, { rot: deg2rad(Number(this.cRot.value) || 0) });
  }

  _onRoughInput() {
    const st = this._sel();
    if (!st) return;
    this._beginLive('调整贴纸粗糙度');
    this.ed.paint.updateSticker(st.id, { rough: Number(this.cRough.value) || 0 });
  }

  _onTransInput() {
    const st = this._sel();
    if (!st) return;
    this._beginLive('调整贴纸透明度');
    this.ed.paint.updateSticker(st.id, { trans: Number(this.cTrans.value) || 0 });
  }

  _beginLive(label) {
    if (!this._livePrev) { this._livePrev = this.ed.snap(); this._liveLabel = label; }
  }

  _endLive() {
    if (!this._livePrev) return;
    const st = this._sel();
    this.ed.record(this._liveLabel || '调整贴纸', this._livePrev);
    this._livePrev = null;
    if (this.ed.paint) this.ed.paint._fast = false;
    if (st) this._refreshObject(st.objectId, false);
  }

  _wheel(e) {
    if (!this.active) return;
    const st = this._sel();
    const k = e.deltaY > 0 ? 0.94 : 1.06;
    if (st) {
      const sc = this._sizeScale(st.objectId);
      const long = clamp(Math.max(st.w, st.h) / sc * k, 0.03, 1.5);
      const f = long / (Math.max(st.w, st.h) / sc || 0.01);
      this._beginLive('调整贴纸大小');
      this.ed.paint.updateSticker(st.id, { w: st.w * f, h: st.h * f });
      this._syncInputs();
      this._endLive();
      return;
    }
    // 没有选中贴纸时，滚轮改「新建贴纸」的默认大小
    const v = clamp((Number(this.cSize.value) || 0.4) * k, 0.03, 1.5);
    this.cSize.value = String(v);
    if (this.cSizeNum) this.cSizeNum.textContent = v.toFixed(2);
  }

  /* ============================================================
     通用
     ============================================================ */
  /** 改动 + 撤销记录；material=true 时还要重换材质（贴纸集合变了） */
  edit(label, fn, objectId) {
    const ed = this.ed;
    const prev = ed.snap();
    try { fn(); } catch (err) {
      console.error('[sticker] 操作失败', err);
      toast('操作失败：' + (err && err.message ? err.message : err), 'err');
      return false;
    }
    this._refreshObject(objectId, true);
    ed.record(label, prev);
    return true;
  }

  _refreshObject(objectId, material) {
    const ed = this.ed;
    if (!objectId || !ed.paint) return;
    const s = ed.paint.surfaces.get(objectId);
    if (s) { s.dirty = true; ed.paint.markDirty(objectId); ed.paint.flush(); }
    if (material && ed.builder) {
      const rec = ed.builder.objects.get(objectId);
      if (rec) { try { ed.builder.syncMaterial(rec); } catch (err) { /* ignore */ } }
    }
    ed.dirty = true;
  }

  _image(id) {
    if (!id || !id.startsWith('asset:')) return null;
    const t = getTexture(id);
    return t && t.image && t.image.width ? t.image : null;
  }

  _loadTex(id) {
    const img = this._image(id);
    if (img) return Promise.resolve(img);
    if (!id || !id.startsWith('asset:')) return Promise.resolve(null);
    return resolveAssetURL(id.slice(6))
      .then((url) => (url ? loadTextureFromURL(id, url) : null))
      .then((t) => (t && t.image && t.image.width ? t.image : null));
  }

  /** 图片素材就绪后把用到它的贴纸重合成一次（进了编辑器才发现素材没解码完） */
  _ensureTex() {
    const id = this.assetId;
    if (!id || !id.startsWith('asset:') || hasTexture(id)) return;
    this._loadTex(id).then((img) => {
      if (!img || !this.ed.level) return;
      const ids = new Set();
      for (const s of (this.ed.level.stickers || [])) if (s.tex === id) ids.add(s.objectId);
      for (const oid of ids) this._refreshObject(oid, true);
    });
  }

  /* ============================================================
     每帧：选中贴纸的轮廓
     ============================================================ */
  update() {
    if (!this.active) return;
    const st = this._sel();
    if (!st || !this._mark || this._markId !== st.id) { if (this.outline) this.outline.visible = false; return; }
    const m = this._mark;
    const n = m.normal;
    const up = Math.abs(n.y) > 0.9 ? _UPX : _UPY;
    _t1.crossVectors(up, n).normalize();
    _t2.crossVectors(n, _t1).normalize();
    const rot = Number(st.rot) || 0;
    const c = Math.cos(rot), s = Math.sin(rot);
    const ex = _t1.clone().multiplyScalar(c).addScaledVector(_t2, s);
    const ey = _t2.clone().multiplyScalar(c).addScaledVector(_t1, -s);
    const half = m.half || 1;
    const W = st.w * half, H = st.h * half;   // 近似：把对象的半径当成 1 个 uv 单位
    const ctr = _p.copy(m.point).addScaledVector(n, half * 0.02 + 0.01);
    const pos = this.outlineGeo.attributes.position;
    const quad = [[W / 2, H / 2], [W / 2, -H / 2], [-W / 2, -H / 2], [-W / 2, H / 2]];
    for (let i = 0; i < 4; i++) {
      const v = ctr.clone().addScaledVector(ex, quad[i][0]).addScaledVector(ey, quad[i][1]);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    this.outlineGeo.computeBoundingSphere();
    this.outline.visible = true;
  }
}

/** 让素材库的写入先落地（IndexedDB 事务） */
function _tick() {
  return new Promise((r) => setTimeout(r, 0));
}
