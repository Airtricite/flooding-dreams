/* ============================================================
   3D 涂鸦：全局图层系统 + 每对象画布 + 材质图层合成
   - 图层按顺序自下而上合成，高图层覆盖低图层
   - 支持纯色笔刷 / 材质图像笔刷(Substance 风格) / 橡皮
   - 数据以笔画列表保存，便于撤销、导出与重放
   ============================================================ */
import * as THREE from 'three';
import { EDITOR, BUILTIN_TEXTURES } from '../config.js';
import { clamp, uid, deepClone } from '../core/util.js';
import { getTexture } from '../core/textures.js';
import { setPaintResolver, setStickerResolver } from '../core/materials.js';
import { FACE_ATLAS } from './objectTypes.js';
import { BLEND_MODES } from './level.js';

/* ---------- 基础贴图取像素源 ---------- */
function textureSource(id) {
  if (!id || id === 'none') return null;
  const t = getTexture(id);
  if (t && t.image) return t.image;
  return null;
}

/* ---------- 柔软笔触的分层参数 ----------
   canvas 的 shadowBlur 只能投一个纯色影子，纹理图章用它做柔边会糊出一圈“软纯色边”。
   改为多层宽度叠印：由外向内多画几遍、越外越淡，边缘依旧是纹理。
   第 j 层透明度取 1/(n-j)——叠完的累计覆盖正好是 1/n、2/n…1，过渡均匀。 */
const SOFT_PASSES = 4;
function softPasses(size, hardness) {
  const soft = 1 - clamp(hardness ?? 0.5, 0, 1);
  if (soft <= 0.03) return [{ w: size, a: 1 }];
  const out = [];
  for (let j = 0; j < SOFT_PASSES; j++) {
    out.push({ w: size * (1 - soft * j / (SOFT_PASSES - 1)), a: 1 / (SOFT_PASSES - j) });
  }
  return out;
}

export class PaintManager {
  constructor(level, opts = {}) {
    this.level = level;
    this.surfaces = new Map();     // objectId -> surface
    this.size = opts.size || EDITOR.defaultPaintSize;
    this.onChange = null;
    this.dirtyList = new Set();
    this._scratch = new Map();     // size -> 贴纸遮罩临时画布（粗糙度 / 法线用）
    this._fast = false;            // 拖动贴纸时的快速合成：先不重算粗糙度 / 法线
    this._prevResolver = setPaintResolver((id) => this.getComposite(id));
    this._prevSticker = setStickerResolver((id) => this.getStickerMaps(id));
    this.rebuildAll();
  }

  /* ---------- 图层 ---------- */
  get layers() { return this.level.paintLayers; }
  getLayer(id) { return this.level.paintLayers.find((l) => l.id === id) || null; }
  addLayer(name) {
    const l = {
      id: uid('ly'), name: name || ('图层 ' + (this.level.paintLayers.length + 1)),
      visible: true, opacity: 1, blendMode: 'normal', locked: false,
    };
    this.level.paintLayers.push(l);
    this.onChange && this.onChange();
    return l;
  }
  removeLayer(id) {
    const i = this.level.paintLayers.findIndex((l) => l.id === id);
    if (i < 0 || this.level.paintLayers.length <= 1) return false;
    this.level.paintLayers.splice(i, 1);
    for (const s of this.surfaces.values()) {
      const rec = s.layers.get(id);
      if (rec) { rec.canvas.width = rec.canvas.height = 1; s.layers.delete(id); }
    }
    this.rebuildAll();
    this.onChange && this.onChange();
    return true;
  }
  moveLayer(id, dir) {
    const a = this.level.paintLayers;
    const i = a.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return false;
    const t = a[i]; a[i] = a[j]; a[j] = t;
    this.rebuildAll();
    this.onChange && this.onChange();
    return true;
  }
  setLayer(id, patch) {
    const l = this.getLayer(id);
    if (!l) return;
    Object.assign(l, patch);
    this.rebuildAll();
    this.onChange && this.onChange();
  }

  /* ---------- 画布 ---------- */
  makeCanvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }

  getSurface(objectId, create = true) {
    let s = this.surfaces.get(objectId);
    if (s) return s;
    if (!create) return null;
    const baseSize = this.size;
    let size = baseSize;
    for (const st of this._stickersOf(objectId)) size = Math.max(size, Number(st.size) || EDITOR.defaultStickerSize);
    size = clamp(Math.round(size), 128, 4096);
    const composite = this.makeCanvas(size);
    const tex = new THREE.CanvasTexture(composite);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    tex.userData.paint = true;
    s = {
      objectId, size, baseSize,
      layers: new Map(),
      composite, ctx: composite.getContext('2d'), tex,
      strokes: [],
      rough: null, norm: null,     // 贴纸合成的粗糙度 / 法线画布（有贴纸时才有）
      dirty: true,
    };
    this.surfaces.set(objectId, s);
    return s;
  }

  /* ---------- 贴纸层数据 ---------- */
  /** 某个对象上的贴纸列表（贴纸按对象独立，存 level.stickers） */
  _stickersOf(objectId) {
    const all = (this.level && this.level.stickers) || [];
    return all.filter((s) => s && s.objectId === objectId);
  }
  getStickers(objectId) {
    return objectId ? this._stickersOf(objectId) : ((this.level && this.level.stickers) || []);
  }
  getSticker(id) { return ((this.level && this.level.stickers) || []).find((s) => s.id === id) || null; }
  hasStickers(objectId) { return this._stickersOf(objectId).length > 0; }

  /** 表面画布尺寸：有贴纸时抬到贴纸分辨率（要高清、不糊），否则用涂鸦尺寸 */
  _objectSurfaceSize(objectId) {
    const s = this.surfaces.get(objectId);
    let n = s ? s.baseSize : this.size;
    for (const st of this._stickersOf(objectId)) n = Math.max(n, Number(st.size) || EDITOR.defaultStickerSize);
    return clamp(Math.round(n), 128, 4096);
  }

  /** 换画布尺寸（笔画数据保留，就地重放） */
  _resizeSurface(s, size) {
    size = clamp(Math.round(size), 128, 4096);
    if (size === s.size) return;
    const strokes = s.strokes.slice();
    s.size = size;
    s.composite.width = s.composite.height = size;
    s.ctx = s.composite.getContext('2d');
    for (const rec of s.layers.values()) {
      rec.canvas.width = rec.canvas.height = size;
      rec.ctx = rec.canvas.getContext('2d');
    }
    s.strokes.length = 0;
    for (const it of strokes) { s.strokes.push(it); this.drawStroke(s, it.layerId, it.stroke); }
    this._dropMaps(s);
    s.dirty = true;
    this.markDirty(s.objectId);
  }

  /** 释放粗糙度 / 法线画布 */
  _dropMaps(s) {
    if (s.rough) { s.rough.tex.dispose(); s.rough.canvas.width = s.rough.canvas.height = 1; s.rough = null; }
    if (s.norm) { s.norm.tex.dispose(); s.norm.canvas.width = s.norm.canvas.height = 1; s.norm = null; }
  }

  _scratchFor(size) {
    let c = this._scratch.get(size);
    if (!c) {
      c = this.makeCanvas(size);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      this._scratch.set(size, c);
    }
    return c;
  }

  layerCanvas(s, layerId) {
    let rec = s.layers.get(layerId);
    if (rec) return rec;
    const canvas = this.makeCanvas(s.size);
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    rec = { canvas, ctx };
    s.layers.set(layerId, rec);
    return rec;
  }

  /** 材质对象使用的贴图（供 materials.js 解析 paint:xxx） */
  getComposite(objectId) {
    const s = this.surfaces.get(objectId);
    if (!s) return null;
    if (s.dirty) this.composite(s);
    return s.tex;
  }
  has(objectId) {
    if (this._stickersOf(objectId).length) return true;
    const s = this.surfaces.get(objectId);
    return !!s && s.strokes.length > 0;
  }
  /** 贴纸合成的粗糙度 / 法线贴图（供 materials.js 解析） */
  getStickerMaps(objectId) {
    const s = this.surfaces.get(objectId);
    if (!s || !this._stickersOf(objectId).length) return null;
    if (s.dirty) this.composite(s);
    if (!s.rough || !s.norm) return null;
    return { rough: s.rough.tex, normal: s.norm.tex };
  }
  key(objectId) { return 'paint:' + objectId; }

  /** 立方体的画布是 3×3 面图集（其余形状是整张 0..1 画布） */
  _isAtlasCanvas(objectId) {
    const o = this.level.objects.find((x) => x.id === objectId);
    return !!o && (o.shape || 'block') === 'block';
  }

  /** uv 落在面图集的哪一格（画布坐标 [x, y, w, h]） */
  _cellRect(s, uv) {
    const cw = s.size / FACE_ATLAS.cols, ch = s.size / FACE_ATLAS.rows;
    const col = clamp(Math.floor(uv[0] * FACE_ATLAS.cols), 0, FACE_ATLAS.cols - 1);
    const row = clamp(Math.floor((1 - uv[1]) * FACE_ATLAS.rows), 0, FACE_ATLAS.rows - 1);
    return [col * cw, row * ch, cw, ch];
  }

  /** 把落笔裁进某一格；返回 true 时调用方要 ctx.restore()
      面图集里相邻的格子是别的面（甚至是对面），笔刷压过面的边界时不许染过去 */
  _clipCell(ctx, rect) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect[0], rect[1], rect[2], rect[3]);
    ctx.clip();
    return true;
  }

  /* ---------- 合成 ---------- */
  /** 立方体的画布是 3×3 面图集：每个面一格，底色 / 自带贴图要逐格铺满 */
  _fillBase(ctx, obj, size) {
    const src = obj ? textureSource(obj.texture) : null;
    const isBlock = !obj || (obj.shape || 'block') === 'block';
    if (!isBlock) {
      if (src) { try { ctx.drawImage(src, 0, 0, size, size); } catch (e) { /* ignore */ } }
      else if (obj) { ctx.fillStyle = obj.color || '#ffffff'; ctx.fillRect(0, 0, size, size); }
      return;
    }
    const cw = size / FACE_ATLAS.cols, ch = size / FACE_ATLAS.rows;
    for (let f = 0; f < 6; f++) {
      const col = f % FACE_ATLAS.cols, row = Math.floor(f / FACE_ATLAS.cols);
      const cx = col * cw;
      // 画布 Y 轴与 uv 相反：图集第 row 行落在画布底部往上数第 (row+1) 格
      const cy = size - (row + 1) * ch;
      if (src) {
        ctx.save();
        ctx.translate(cx, cy + ch);
        ctx.scale(1, -1);                       // 抵消画布的 Y 翻转，贴图方向才和以前一致
        try { ctx.drawImage(src, 0, 0, cw, ch); } catch (e) { /* ignore */ }
        ctx.restore();
      } else {
        ctx.fillStyle = (obj && obj.color) || '#ffffff';
        ctx.fillRect(cx, cy, cw, ch);
      }
    }
  }

  composite(s) {
    const ctx = s.ctx;
    const size = s.size;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, size, size);
    // 底：对象自带贴图 / 底色（立方体逐面图集）
    const obj = this.level.objects.find((o) => o.id === s.objectId);
    this._fillBase(ctx, obj, size);
    // 图层自下而上
    for (const l of this.level.paintLayers) {
      if (!l.visible) continue;
      const rec = s.layers.get(l.id);
      if (!rec) continue;
      ctx.globalAlpha = clamp(l.opacity ?? 1, 0, 1);
      ctx.globalCompositeOperation = l.blendMode && l.blendMode !== 'normal' ? l.blendMode : 'source-over';
      try { ctx.drawImage(rec.canvas, 0, 0); } catch (e) { /* ignore */ }
    }
    // 贴纸层：盖在涂鸦之上，底层贴图 / 涂鸦都保留（透明度可调）
    const stickers = this._stickersOf(s.objectId);
    for (const st of stickers) {
      const img = this._stickerImage(st.tex);
      if (img) this._drawSticker(ctx, s, st, img);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // 贴纸同时覆盖粗糙度 / 法线区域：合成两张额外的画布贴图
    if (!this._fast) this._compositeMaps(s, obj, stickers);
    s.tex.needsUpdate = true;
    s.dirty = false;
  }

  /* ---------- 贴纸绘制 ---------- */
  /** 贴纸图片像素源（导入的图片素材） */
  _stickerImage(id) {
    if (!id || !id.startsWith('asset:')) return null;
    const t = getTexture(id);
    return t && t.image ? t.image : null;
  }

  /** 贴纸在画布上的变换（中心 + 尺寸，画布 Y 轴与 uv 相反） */
  _stickerRect(s, st) {
    const size = s.size;
    return {
      cx: st.u * size,
      cy: (1 - st.v) * size,
      w: Math.max(1, st.w * size),
      h: Math.max(1, st.h * size),
      rot: -(Number(st.rot) || 0),
    };
  }

  /** 把贴纸画到画布上（立方体裁进命中那一格，避免压到别的面） */
  _drawSticker(ctx, s, st, img) {
    const r = this._stickerRect(s, st);
    const rect = this._isAtlasCanvas(s.objectId) ? this._cellRect(s, [st.u, st.v]) : null;
    ctx.save();
    if (rect) { ctx.beginPath(); ctx.rect(rect[0], rect[1], rect[2], rect[3]); ctx.clip(); }
    ctx.globalAlpha = clamp(1 - (st.trans ?? 0), 0, 1);
    ctx.globalCompositeOperation = 'source-over';
    ctx.translate(r.cx, r.cy);
    if (r.rot) ctx.rotate(r.rot);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    try { ctx.drawImage(img, -r.w / 2, -r.h / 2, r.w, r.h); } catch (e) { /* ignore */ }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** 粗糙度 / 法线底色：与底贴图同一套图集 / 拉伸规则（没有对应贴图时铺常量色） */
  _fillMap(ctx, obj, size, texId, fallback) {
    const src = textureSource(texId);
    const isBlock = !obj || (obj.shape || 'block') === 'block';
    if (!isBlock) {
      if (src) { try { ctx.drawImage(src, 0, 0, size, size); } catch (e) { /* ignore */ } }
      else { ctx.fillStyle = fallback; ctx.fillRect(0, 0, size, size); }
      return;
    }
    const cw = size / FACE_ATLAS.cols, ch = size / FACE_ATLAS.rows;
    for (let f = 0; f < 6; f++) {
      const col = f % FACE_ATLAS.cols, row = Math.floor(f / FACE_ATLAS.cols);
      const cx = col * cw;
      const cy = size - (row + 1) * ch;
      if (src) {
        ctx.save();
        ctx.translate(cx, cy + ch);
        ctx.scale(1, -1);
        try { ctx.drawImage(src, 0, 0, cw, ch); } catch (e) { /* ignore */ }
        ctx.restore();
      } else {
        ctx.fillStyle = fallback;
        ctx.fillRect(cx, cy, cw, ch);
      }
    }
  }

  _makeMapCanvas(size) {
    const canvas = this.makeCanvas(size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    tex.userData.paint = true;     // 与底贴图一样：每对象独享、不克隆、repeat / offset 固定
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return { canvas, ctx, tex };
  }

  /**
   * 贴纸区域整体覆盖掉粗糙度 / 法线：
   * 先按贴纸的像素 alpha 做一张纯色遮罩，再按（1 - 透明度）盖到目标画布。
   */
  _stampTinted(s, targetCtx, st, img, color) {
    const size = s.size;
    const tmp = this._scratchFor(size);
    const tc = tmp.getContext('2d');
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.globalCompositeOperation = 'source-over';
    tc.globalAlpha = 1;
    tc.imageSmoothingEnabled = true;
    tc.imageSmoothingQuality = 'high';
    tc.clearRect(0, 0, size, size);
    const r = this._stickerRect(s, st);
    tc.save();
    tc.translate(r.cx, r.cy);
    if (r.rot) tc.rotate(r.rot);
    try { tc.drawImage(img, -r.w / 2, -r.h / 2, r.w, r.h); } catch (e) { /* ignore */ }
    tc.restore();
    tc.globalCompositeOperation = 'source-in';   // 只留贴纸的透明形状
    tc.fillStyle = color;
    tc.fillRect(0, 0, size, size);
    tc.globalCompositeOperation = 'source-over';

    const rect = this._isAtlasCanvas(s.objectId) ? this._cellRect(s, [st.u, st.v]) : null;
    targetCtx.save();
    if (rect) { targetCtx.beginPath(); targetCtx.rect(rect[0], rect[1], rect[2], rect[3]); targetCtx.clip(); }
    targetCtx.globalAlpha = clamp(1 - (st.trans ?? 0), 0, 1);
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = 'high';
    try { targetCtx.drawImage(tmp, 0, 0); } catch (e) { /* ignore */ }
    targetCtx.restore();
    targetCtx.globalAlpha = 1;
  }

  /** 合成粗糙度 / 法线画布：底是对象自带贴图，贴纸区域被贴纸的粗糙度与平面法线盖掉 */
  _compositeMaps(s, obj, stickers) {
    if (!stickers.length) { this._dropMaps(s); return; }
    const size = s.size;
    if (!s.rough) s.rough = this._makeMapCanvas(size);
    if (!s.norm) s.norm = this._makeMapCanvas(size);
    // 注意：&& 与 ?? 不能不加括号地混用（JS 语法错误），左操作数必须括起来
    const roughV = Math.round(clamp(Number((obj && obj.roughness) ?? 0.72) || 0, 0, 1) * 255);
    const roughBase = 'rgb(' + roughV + ',' + roughV + ',' + roughV + ')';
    for (const [c, isRough] of [[s.rough, true], [s.norm, false]]) {
      c.ctx.setTransform(1, 0, 0, 1, 0, 0);
      c.ctx.globalCompositeOperation = 'source-over';
      c.ctx.globalAlpha = 1;
      c.ctx.imageSmoothingEnabled = true;
      c.ctx.imageSmoothingQuality = 'high';
      c.ctx.clearRect(0, 0, size, size);
      if (isRough) this._fillMap(c.ctx, obj, size, obj && obj.roughnessMap, roughBase);
      else this._fillMap(c.ctx, obj, size, obj && obj.normalMap, '#8080ff');
    }
    for (const st of stickers) {
      const img = this._stickerImage(st.tex);
      if (!img) continue;
      const v = Math.round(clamp(Number(st.rough ?? 0.45) || 0, 0, 1) * 255);
      this._stampTinted(s, s.rough.ctx, st, img, 'rgb(' + v + ',' + v + ',' + v + ')');
      this._stampTinted(s, s.norm.ctx, st, img, '#8080ff');   // 平面法线：贴纸表面光滑
    }
    s.rough.tex.needsUpdate = true;
    s.norm.tex.needsUpdate = true;
  }

  /* ---------- 贴纸增删改 ---------- */
  addSticker(objectId, data = {}) {
    if (!this.level.objects.some((o) => o.id === objectId)) return null;
    const arr = this.level.stickers || (this.level.stickers = []);
    if (arr.filter((x) => x.objectId === objectId).length >= EDITOR.stickerMaxPerObject) return null;
    const size = clamp(Math.round(Number(data.size) || EDITOR.defaultStickerSize), 512, 4096);
    const st = {
      id: data.id || uid('sk'),
      objectId,
      tex: String(data.tex || ''),
      u: Number(data.u) || 0,
      v: Number(data.v) || 0,
      w: clamp(Number(data.w) || 0.25, 0.005, 8),
      h: clamp(Number(data.h) || 0.25, 0.005, 8),
      rot: Number(data.rot) || 0,
      rough: clamp(Number(data.rough ?? 0.45) || 0, 0, 1),
      trans: clamp(Number(data.trans ?? 0) || 0, 0, 1),
      size,
    };
    arr.push(st);
    const s = this.getSurface(objectId);
    this._resizeSurface(s, this._objectSurfaceSize(objectId));   // 贴纸要高清：画布抬到贴纸分辨率
    s.dirty = true;
    this.markDirty(objectId);
    this.flush();
    return st;
  }

  updateSticker(id, patch) {
    const st = this.getSticker(id);
    if (!st) return null;
    for (const k in patch) {
      const v = patch[k];
      if (k === 'u' || k === 'v' || k === 'rot') st[k] = Number(v) || 0;
      else if (k === 'w' || k === 'h') st[k] = clamp(Number(v) || 0.01, 0.005, 8);
      else if (k === 'rough' || k === 'trans') st[k] = clamp(Number(v) || 0, 0, 1);
      else if (k === 'size') st[k] = clamp(Math.round(Number(v) || EDITOR.defaultStickerSize), 512, 4096);
      else st[k] = v;
    }
    const s = this.surfaces.get(st.objectId);
    if (s) { this._resizeSurface(s, this._objectSurfaceSize(st.objectId)); s.dirty = true; this.markDirty(st.objectId); this.flush(); }
    return st;
  }

  removeSticker(id) {
    const arr = (this.level && this.level.stickers) || [];
    const i = arr.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const objectId = arr[i].objectId;
    arr.splice(i, 1);
    this._afterStickerChange(objectId);
    return true;
  }

  clearStickers(objectId) {
    const arr = (this.level && this.level.stickers) || [];
    const keep = arr.filter((s) => s.objectId !== objectId);
    const n = arr.length - keep.length;
    if (!n) return 0;
    this.level.stickers = keep;
    this._afterStickerChange(objectId);
    return n;
  }

  /** 贴纸增删后：画布尺寸随贴纸清晰度升降，贴纸全没了就释放粗糙度 / 法线画布 */
  _afterStickerChange(objectId) {
    const s = this.surfaces.get(objectId);
    if (!s) return;
    this._resizeSurface(s, this._objectSurfaceSize(objectId));
    if (!this._stickersOf(objectId).length) this._dropMaps(s);
    s.dirty = true;
    this.markDirty(objectId);
    this.flush();
  }

  markDirty(objectId) {
    const s = this.surfaces.get(objectId);
    if (s) { s.dirty = true; this.dirtyList.add(objectId); }
  }

  flush() {
    for (const id of this.dirtyList) {
      const s = this.surfaces.get(id);
      if (s) this.composite(s);
    }
    this.dirtyList.clear();
  }

  /* ---------- 笔画 ---------- */
  /** uv 坐标（0..1）→ 画布坐标，注意 Y 轴翻转 */
  toCanvas(s, uv) { return [uv[0] * s.size, (1 - uv[1]) * s.size]; }

  beginStroke(objectId, layerId, opt) {
    const s = this.getSurface(objectId);
    const o = this.layerCanvas(s, layerId).ctx;
    const size = Math.max(1, opt.size || 24);
    o.lineCap = 'round'; o.lineJoin = 'round';
    // 纹理图章 + 柔软笔触：走多层叠印（shadow 只能纯色，会糊出软纯色边）
    const passes = opt.tool !== 'eraser' && opt.mode === 'mat' && opt.tex
      ? softPasses(size, opt.hardness) : null;
    if (opt.tool === 'eraser') {
      o.globalCompositeOperation = 'destination-out';
      o.strokeStyle = 'rgba(0,0,0,1)';
      o.globalAlpha = 1;
    } else if (opt.mode === 'mat' && opt.tex) {
      const t = getTexture(opt.tex);
      const img = t && t.image ? t.image : null;
      o.globalCompositeOperation = 'source-over';
      o.strokeStyle = img ? o.createPattern(img, 'repeat') : (opt.color || '#ffffff');
      o.globalAlpha = clamp(opt.alpha ?? 1, 0, 1) * (passes ? passes[0].a : 1);
    } else {
      o.globalCompositeOperation = 'source-over';
      o.strokeStyle = opt.color || '#ff5c8a';
      o.globalAlpha = clamp(opt.alpha ?? 1, 0, 1);
    }
    o.lineWidth = passes ? passes[0].w : size;
    // 多层叠印自带柔边；其余仍用 shadowBlur 做柔化
    o.shadowBlur = passes ? 0 : (1 - clamp(opt.hardness ?? 0.5, 0, 1)) * size * 0.5;
    o.shadowColor = opt.tool === 'eraser' ? 'rgba(0,0,0,1)' : (opt.color || '#ff5c8a');
    const stroke = {
      t: opt.tool === 'eraser' ? 'erase' : 'brush',
      m: opt.mode === 'mat' ? 'mat' : 'color',
      c: opt.color || '#ff5c8a',
      a: clamp(opt.alpha ?? 1, 0, 1),
      s: size,
      h: clamp(opt.hardness ?? 0.5, 0, 1),
      tex: opt.mode === 'mat' ? (opt.tex || '') : '',
      pts: [],
    };
    s.strokes.push({ layerId, stroke });
    return { s, layerId, stroke, ctx: o, passes };
  }

  strokePoint(active, uv) {
    const s = active.s;
    const stroke = active.stroke;
    const ctx = this.layerCanvas(s, active.layerId).ctx;
    const [x, y] = this.toCanvas(s, uv);
    stroke.pts.push([uv[0], uv[1]]);
    const pts = stroke.pts;
    // 立方体：整条笔画裁在起笔那一格里，笔刷压过面边界不会染到别的面
    let clipped = false;
    if (this._isAtlasCanvas(s.objectId)) {
      if (!active.cell) active.cell = this._cellRect(s, uv);
      clipped = this._clipCell(ctx, active.cell);
    }
    const prev = pts.length > 1 ? this.toCanvas(s, pts[pts.length - 2]) : null;
    if (active.passes) {
      for (const p of active.passes) {
        ctx.lineWidth = p.w;
        ctx.globalAlpha = stroke.a * p.a;
        this.paintSeg(ctx, pts, x, y, prev);
      }
    } else {
      this.paintSeg(ctx, pts, x, y, prev);
    }
    if (clipped) ctx.restore();
    s.dirty = true;
    this.markDirty(s.objectId);
  }

  /** 实时涂抹：只画最新的一段（第一个点画圆点），用 ctx 当前的线宽 / 透明度 / 样式 */
  paintSeg(ctx, pts, x, y, prev) {
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(x, y, ctx.lineWidth / 2, 0, 6.283);
      if (ctx.globalCompositeOperation === 'destination-out') {
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.fillStyle = ctx.strokeStyle;
      }
      ctx.fill();
    } else if (prev) {
      ctx.beginPath();
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  }

  endStroke(s) {
    const ctxs = new Set();
    for (const rec of s.layers.values()) ctxs.add(rec.ctx);
    for (const c of ctxs) { c.globalAlpha = 1; c.shadowBlur = 0; c.globalCompositeOperation = 'source-over'; }
    s.dirty = true;
    this.markDirty(s.objectId);
    this.syncData(s.objectId);
  }

  /** 一次成型（撤销重放用） */
  drawStroke(s, layerId, stroke) {
    const ctx = this.layerCanvas(s, layerId).ctx;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const size = Math.max(1, stroke.s || 24);
    // 与实时涂抹一致：纹理图章 + 柔软笔触走多层叠印，其余用 shadowBlur
    const passes = stroke.t !== 'erase' && stroke.m === 'mat' && stroke.tex
      ? softPasses(size, stroke.h) : null;
    ctx.shadowBlur = passes ? 0 : (1 - clamp(stroke.h ?? 0.5, 0, 1)) * size * 0.5;
    if (stroke.t === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.globalAlpha = 1;
      ctx.shadowColor = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      if (stroke.m === 'mat' && stroke.tex) {
        const t = getTexture(stroke.tex);
        const img = t && t.image ? t.image : null;
        ctx.strokeStyle = img ? ctx.createPattern(img, 'repeat') : stroke.c;
        ctx.fillStyle = ctx.strokeStyle;
      } else {
        ctx.strokeStyle = stroke.c;
        ctx.fillStyle = stroke.c;
      }
      ctx.globalAlpha = clamp(stroke.a ?? 1, 0, 1);
      ctx.shadowColor = stroke.c;
    }
    const pts = stroke.pts || [];
    // 与实时涂抹一致：立方体整条笔画裁在起笔那一格里
    const clipped = this._isAtlasCanvas(s.objectId) && pts.length ? this._clipCell(ctx, this._cellRect(s, pts[0])) : false;
    if (passes) {
      const a = clamp(stroke.a ?? 1, 0, 1);
      for (const p of passes) {
        ctx.lineWidth = p.w;
        ctx.globalAlpha = a * p.a;
        this.strokePath(ctx, s, pts);
      }
    } else {
      ctx.lineWidth = size;
      this.strokePath(ctx, s, pts);
    }
    if (clipped) ctx.restore();
    ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.globalCompositeOperation = 'source-over';
  }

  /** 重放：把整条笔画（或单点）画到 ctx，用 ctx 当前的线宽 / 透明度 / 样式 */
  strokePath(ctx, s, pts) {
    if (pts.length === 1) {
      const [x, y] = this.toCanvas(s, pts[0]);
      ctx.beginPath(); ctx.arc(x, y, ctx.lineWidth / 2, 0, 6.283); ctx.fill();
      return;
    }
    if (pts.length < 2) return;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = this.toCanvas(s, pts[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /** 清空某对象某图层 / 全部 */
  clearObject(objectId, layerId) {
    const s = this.surfaces.get(objectId);
    if (!s) return false;
    if (layerId) {
      const rec = s.layers.get(layerId);
      if (rec) rec.ctx.clearRect(0, 0, s.size, s.size);
      s.strokes = s.strokes.filter((x) => x.layerId !== layerId);
    } else {
      for (const rec of s.layers.values()) rec.ctx.clearRect(0, 0, s.size, s.size);
      s.strokes.length = 0;
    }
    s.dirty = true;
    this.markDirty(objectId);
    this.syncData(objectId);
    return true;
  }

  /* ---------- 数据同步 ---------- */
  syncData(objectId) {
    const s = this.surfaces.get(objectId);
    if (!s) return;
    const arr = this.level.paints;
    let entry = arr.find((p) => p.objectId === objectId);
    const byLayer = new Map();
    for (const it of s.strokes) {
      const list = byLayer.get(it.layerId) || byLayer.set(it.layerId, []).get(it.layerId);
      list.push(it.stroke);
    }
    // 移除旧数据
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].objectId === objectId) arr.splice(i, 1);
    for (const [layerId, strokes] of byLayer) {
      arr.push({ objectId, layerId, size: s.size, strokes: deepClone(strokes) });
    }
    void entry;
  }

  /** 从 level.paints / level.stickers 重建全部画布 */
  rebuildAll() {
    for (const s of this.surfaces.values()) {
      for (const rec of s.layers.values()) { rec.canvas.width = 1; rec.canvas.height = 1; }
      s.layers.clear();
      s.strokes.length = 0;    // 必须清空，否则每次重建都会把 level.paints 里的笔画重复累积
      this._dropMaps(s);
    }
    // 有贴纸的对象即使没有笔画也要有一张画布：贴纸层就画在这张画布上
    for (const st of this.level.stickers || []) this.getSurface(st.objectId);
    for (const rec of this.level.paints || []) {
      const s = this.getSurface(rec.objectId);
      if (rec.size) s.baseSize = clamp(rec.size, 128, 2048);
      this._resizeSurface(s, this._objectSurfaceSize(rec.objectId));
      for (const st of rec.strokes) {
        s.strokes.push({ layerId: rec.layerId, stroke: st });
        this.drawStroke(s, rec.layerId, st);
      }
    }
    for (const s of this.surfaces.values()) { s.dirty = true; this.markDirty(s.objectId); }
    this.flush();
  }

  /** 拾取某对象某 uv 的合成颜色 */
  pickColor(objectId, uv) {
    const s = this.surfaces.get(objectId);
    if (!s) return null;
    if (s.dirty) this.composite(s);
    const [x, y] = this.toCanvas(s, uv);
    try {
      const d = s.ctx.getImageData(clamp(x | 0, 0, s.size - 1), clamp(y | 0, 0, s.size - 1), 1, 1).data;
      return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    } catch (e) { return null; }
  }

  /** 导出对象的涂鸦为 PNG（用于缩略图/分享） */
  exportPNG(objectId) {
    const s = this.surfaces.get(objectId);
    if (!s) return null;
    if (s.dirty) this.composite(s);
    return s.composite.toDataURL('image/png');
  }

  dispose() {
    for (const s of this.surfaces.values()) {
      s.tex.dispose();
      this._dropMaps(s);
      for (const rec of s.layers.values()) { rec.canvas.width = rec.canvas.height = 1; }
      s.layers.clear();
      s.composite.width = s.composite.height = 1;
    }
    this.surfaces.clear();
    for (const c of this._scratch.values()) c.width = c.height = 1;
    this._scratch.clear();
    // 还原上一个解析器：试玩会话销毁时若直接置 null，编辑器里已涂鸦的方块
    // 会在下一次重建材质（撤销/重做等）时解析不到画布贴图 → 涂鸦数据还在但贴图不显示
    setPaintResolver(this._prevResolver || null);
    this._prevResolver = null;
    setStickerResolver(this._prevSticker || null);
    this._prevSticker = null;
  }
}

export { BUILTIN_TEXTURES, BLEND_MODES };
export function blendOptions() { return BLEND_MODES; }