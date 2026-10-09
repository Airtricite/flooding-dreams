/* ============================================================
   预制件 3D 预览图
   ------------------------------------------------------------
   导出预制件时，只把属于该预制件的对象圈出来，借编辑器现成的渲染器 /
   光照 / 环境空拍一张方图，裁成图标尺寸后存进预制件，作为卡片图标。

   做法：切到「预览专用图层」（相机只画这一层），给预制件的场景节点
   与场景里的灯光都加上这一层，取景到预制件包围盒，渲染后立刻读像素，
   最后逐一还原图层与相机状态。
   好处：不受对象层级影响（父级不在预制件里的对象也能单独拍到），
   也不改动可见性与场景结构。
   ============================================================ */
import * as THREE from 'three';
import { collectTree } from '../world/level.js';

/** 预览专用图层号（相机只画这一层，编辑器里的网格 / 光标等自然被排除） */
const PREVIEW_LAYER = 6;
/** 取景方向（略俯视的三分之四视角） */
const _DIR = new THREE.Vector3(0.55, 0.62, 0.55).normalize();
/** 纯平面内容（公告板 / 文字方块）不算「3D 内容」 */
const FLAT_TYPES = new Set(['billboard', 'textblock']);

/** 这组对象里有没有 3D 内容（有才值得预渲染预览图） */
export function prefabHas3D(objects) {
  const list = Array.isArray(objects) ? objects : [];
  return list.some((o) => o && o.type && !FLAT_TYPES.has(o.type));
}

/** 从渲染画布中央裁方图 → dataURL（太大返回 null，避免撑爆预制件索引） */
function _grab(src, size) {
  if (!src || !src.width || !src.height) return null;
  const side = Math.min(src.width, src.height);
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  if (!g) return null;
  g.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, size, size);
  let url = '';
  try { url = c.toDataURL('image/webp', 0.74); } catch (e) { url = ''; }
  if (!url || url.indexOf('data:image/webp') !== 0) {
    try { url = c.toDataURL('image/jpeg', 0.74); } catch (e) { url = ''; }
  }
  if (!url || url.indexOf('data:image/') !== 0) return null;
  return url.length > 90000 ? null : url;
}

/**
 * 给一组对象空拍一张 3D 预览图。
 * @param {object} ed                编辑器
 * @param {string[]} ids             选中的对象 id（其后代一并入镜，与 capturePrefab 一致）
 * @param {{size?:number, margin?:number}} [opts]
 * @returns {string|null} dataURL；没有 3D 内容 / 渲染失败时返回 null
 */
export function renderPrefabPreview(ed, ids, opts = {}) {
  const touched = [];
  let cam = null;
  let saved = null;
  try {
    const b = ed && ed.builder;
    const renderer = ed && ed.engine && ed.engine.renderer;
    const scene = ed && ed.scene;
    cam = ed && ed.viewport && ed.viewport.camera;
    if (!b || !renderer || !scene || !cam || !ed.level) return null;

    /* 选中 id → 该对象及其全部后代（去重保序），与 capturePrefab 采到的一致 */
    const list = [];
    const picked = [];
    const seen = new Set();
    for (const id of (Array.isArray(ids) ? ids : [])) {
      for (const o of collectTree(ed.level, id)) {
        if (!o || seen.has(o.id)) continue;
        seen.add(o.id);
        list.push(o.id);
        picked.push(o);
      }
    }
    if (!prefabHas3D(picked)) return null;

    scene.updateMatrixWorld(true);

    /* 1. 预制件的场景节点整体切到预览层（连同辅助体），并累计包围盒 */
    const marked = new Set();
    const bounds = new THREE.Box3();
    const mark = (n) => {
      if (!n || !n.isObject3D || marked.has(n)) return;
      marked.add(n);
      touched.push({ n, m: n.layers.mask });
      n.layers.set(PREVIEW_LAYER);
    };
    for (const id of list) {
      const rec = b.objects.get(id);
      if (!rec) continue;
      const roots = [rec.mesh, rec.group, rec.model, rec.foamMesh, rec.liquid && rec.liquid.mesh];
      for (const h of (rec.helpers || [])) roots.push(h);
      for (const r of roots) {
        if (!r || !r.isObject3D) continue;
        r.traverse(mark);
        bounds.expandByObject(r);
      }
    }
    if (!touched.length || bounds.isEmpty()) { _restore(touched); return null; }

    /* 2. 灯光也要进这一层，否则预览层的物体收不到光（灯本身不会画出来） */
    scene.traverse((n) => {
      if (!n.isLight || marked.has(n)) return;
      touched.push({ n, m: n.layers.mask });
      n.layers.enable(PREVIEW_LAYER);
    });

    /* 3. 临时把相机摆到预制件正前方 */
    saved = {
      pos: cam.position.clone(), quat: cam.quaternion.clone(),
      near: cam.near, far: cam.far, aspect: cam.aspect, mask: cam.layers.mask,
    };
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.5, 0.5);
    const half = Math.max(0.05, Math.tan((cam.fov * Math.PI / 180) / 2));
    const dist = radius / half * (opts.margin || 1.18);
    cam.position.copy(center).addScaledVector(_DIR, dist);
    cam.lookAt(center);
    cam.near = Math.max(0.05, dist - radius * 2.5);
    cam.far = dist + radius * 6;
    cam.layers.set(PREVIEW_LAYER);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    /* 4. 渲染 + 立刻读像素（同一任务内，画布还没被清） */
    renderer.render(scene, cam);
    const url = _grab(renderer.domElement, opts.size || 176);

    /* 5. 还原相机与图层：下一帧引擎按原机位重画 */
    _restoreCamera(cam, saved);
    _restore(touched);
    return url;
  } catch (e) {
    console.warn('[prefab] 预览渲染失败', e);
    if (cam && saved) _restoreCamera(cam, saved);
    _restore(touched);
    return null;
  }
}

function _restore(touched) {
  for (const t of touched) {
    try { t.n.layers.mask = t.m; } catch (e) { /* ignore */ }
  }
  touched.length = 0;
}

function _restoreCamera(cam, saved) {
  cam.position.copy(saved.pos);
  cam.quaternion.copy(saved.quat);
  cam.near = saved.near;
  cam.far = saved.far;
  cam.aspect = saved.aspect;
  cam.layers.mask = saved.mask;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}