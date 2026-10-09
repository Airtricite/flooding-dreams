/* ============================================================
   低模建模体（poly）：几何构建 / 拓扑 / 倒角 / 平滑
   - 数据直接挂在对象记录上：verts（点表）+ faces（三角面索引表），
     两者都用 vec3list 存（faces 的每一项是 [i, j, k]），
     这样撤销快照（JSON.stringify）、深拷贝、存档序列化全部复用现成管线
   - 几何是「单位空间」的：物体尺寸由 scale 决定（与网格方块一致）
   - 一切操作都按低模尺度设计：面数上千也能逐帧重建，不做细分 / 半边结构
   ============================================================ */
import * as THREE from 'three';
import { round, clamp } from '../core/util.js';

/** 面数上限：超过就拒绝继续建模，避免 JSON 快照把撤销栈撑爆 */
export const MAX_POLY_FACES = 20000;

/** 单位立方体模板（±0.5）：新建建模体即为可编辑方块 → 即建即用 */
export const BOX_TEMPLATE = {
  verts: [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ],
  faces: [
    [0, 2, 1], [0, 3, 2],   // -Z
    [4, 5, 6], [4, 6, 7],   // +Z
    [0, 1, 5], [0, 5, 4],   // -Y
    [3, 7, 6], [3, 6, 2],   // +Y
    [1, 2, 6], [1, 6, 5],   // +X
    [0, 4, 7], [0, 7, 3],   // -X
  ],
};

export function polyVerts(o) { return (o && Array.isArray(o.verts)) ? o.verts : []; }
export function polyFaces(o) { return (o && Array.isArray(o.faces)) ? o.faces : []; }

const isTri = (f) => Array.isArray(f) && f.length >= 3
  && Number.isFinite(Number(f[0])) && Number.isFinite(Number(f[1])) && Number.isFinite(Number(f[2]));

/** 校验 / 修复数据；数据不可用时用模板兜底。返回 true 表示做过修复 */
export function ensurePoly(o) {
  if (!o) return false;
  let fixed = false;
  if (!Array.isArray(o.verts) || o.verts.length < 3) {
    o.verts = BOX_TEMPLATE.verts.map((v) => v.slice());
    o.faces = BOX_TEMPLATE.faces.map((f) => f.slice());
    return true;
  }
  o.verts = o.verts
    .filter((v) => Array.isArray(v) && v.length >= 3)
    .map((v) => [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0]);
  const n = o.verts.length;
  if (!Array.isArray(o.faces)) { o.faces = BOX_TEMPLATE.faces.map((f) => f.slice()); fixed = true; }
  else {
    const before = o.faces.length;
    o.faces = o.faces.filter(isTri).map((f) => {
      const a = clamp(Math.round(Number(f[0])), 0, n - 1);
      const b = clamp(Math.round(Number(f[1])), 0, n - 1);
      const c = clamp(Math.round(Number(f[2])), 0, n - 1);
      return [a, b, c];
    }).filter((f) => f[0] !== f[1] && f[1] !== f[2] && f[0] !== f[2]);
    if (o.faces.length !== before) fixed = true;
  }
  if (!o.faces.length) { o.faces = BOX_TEMPLATE.faces.map((f) => f.slice()); fixed = true; }
  return fixed;
}

/* ============================================================
   几何构建
   ============================================================ */

/** 顶点所属面的主轴（0=X / 1=Y / 2=Z），用于盒式投影 uv */
function dominantAxis(nx, ny, nz) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ax >= ay && ax >= az) return 0;
  return ay >= az ? 1 : 2;
}

/**
 * 由 verts / faces 生成索引几何体。
 * 索引化 + computeVertexNormals 才能同时支持「平滑着色」与材质开关 flatShading；
 * uv 按每个顶点所属第一个面的主轴做盒式投影，让贴图在低模面上不出现拉伸；
 * uv 乘上逐轴 scale 烘成 stud 尺度（材质层 repeat = 1/贴图尺寸(stud)，
 * 与方块「平铺不拉伸」同一量纲：每格贴图的世界边长 = 贴图尺寸(stud)）。
 */
export function polyGeometry(o) {
  const verts = polyVerts(o);
  const faces = polyFaces(o);
  const sc = (o.scale || [1, 1, 1]).map((v) => (Number(v) || 1));
  const n = verts.length;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2];
  }
  const idx = [];
  // 三角序号 → 面表下标：射线命中 triangleIndex 时要能反查回 o.faces 的下标
  const triFace = [];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const a = f[0] | 0, b = f[1] | 0, c = f[2] | 0;
    if (a >= n || b >= n || c >= n) continue;
    if (a === b || b === c || a === c) continue;
    idx.push(a, b, c);
    triFace.push(i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.userData.triFace = triFace;
  if (idx.length) g.computeVertexNormals();

  // 盒式投影 uv：每个顶点取所属第一个面的主轴，另外两轴坐标直接当 uv
  const uv = new Float32Array(n * 2);
  const done = new Uint8Array(n);
  const nor = g.attributes.normal;
  for (const f of faces) {
    const a = f[0] | 0, b = f[1] | 0, c = f[2] | 0;
    if (a >= n || b >= n || c >= n) continue;
    const nx = nor ? nor.getX(a) : 0, ny = nor ? nor.getY(a) : 0, nz = nor ? nor.getZ(a) : 1;
    const ax = dominantAxis(nx, ny, nz);
    const i0 = ax === 0 ? 1 : 0;
    const i1 = ax === 2 ? 1 : 2;
    for (const vi of [a, b, c]) {
      if (done[vi]) continue;
      done[vi] = 1;
      uv[vi * 2] = verts[vi][i0] * sc[i0];
      uv[vi * 2 + 1] = verts[vi][i1] * sc[i1];
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/* ============================================================
   拓扑
   ============================================================ */

/** 边 → 相邻面：{ a, b, k, f:[面下标…] }（a < b） */
export function edgeMap(faces) {
  const map = new Map();
  const add = (a, b, fi) => {
    const k = a < b ? a + '_' + b : b + '_' + a;
    let e = map.get(k);
    if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), k, f: [] }; map.set(k, e); }
    if (e.f.length < 4) e.f.push(fi);
  };
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (!isTri(f)) continue;
    add(f[0] | 0, f[1] | 0, i); add(f[1] | 0, f[2] | 0, i); add(f[2] | 0, f[0] | 0, i);
  }
  return map;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/** 三角面法线（未归一化，方向遵循面绕序） */
export function faceNormal(verts, f, out = new THREE.Vector3()) {
  const a = verts[f[0]], b = verts[f[1]], c = verts[f[2]];
  if (!a || !b || !c) return out.set(0, 1, 0);
  _v1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  _v2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  return out.crossVectors(_v1, _v2);
}

export function faceCenter(verts, f, out = new THREE.Vector3()) {
  const a = verts[f[0]], b = verts[f[1]], c = verts[f[2]];
  if (!a || !b || !c) return out.set(0, 0, 0);
  return out.set((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3);
}

/* ============================================================
   最近表面点（接头贴合用）
   - 在单位空间里，求点 p 到三角网最近的表面点 + 该面法线
   - hint 为上一次命中的面下标：投影仍落在这个面内就直接复用，
     否则全量搜索（网格变形 / 拖动接头时自动重新找面）
   ============================================================ */
const _tri = new THREE.Triangle();
const _tA = new THREE.Vector3(), _tB = new THREE.Vector3(), _tC = new THREE.Vector3();
const _tP = new THREE.Vector3();
const _tQ = new THREE.Vector3();
const _tN = new THREE.Vector3();

/** 点 p 到第 fi 个面的最近点，返回距离平方（最近点写入 out），面无效返回 -1 */
function _closestOnFace(verts, faces, fi, p, out) {
  const f = faces[fi];
  if (!f) return -1;
  const A = verts[f[0]], B = verts[f[1]], C = verts[f[2]];
  if (!A || !B || !C) return -1;
  _tri.set(_tA.set(A[0], A[1], A[2]), _tB.set(B[0], B[1], B[2]), _tC.set(C[0], C[1], C[2]));
  _tri.closestPointToPoint(p, out);
  return out.distanceToSquared(p);
}

/**
 * 最近表面点。返回 { point:[x,y,z], normal:[nx,ny,nz], face } 或 null。
 * point / normal 都在「单位空间」（与 verts 同一坐标系）。
 */
export function nearestSurfacePoint(verts, faces, p, hint = -1) {
  if (!verts.length || !faces.length) return null;
  _tQ.set(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
  let bestFi = -1, bestD = Infinity;
  // 缓存面命中（投影就落在面上）→ 免全量扫描；网格变形 / 拖动接头时自动重新找面
  if (hint >= 0 && hint < faces.length) {
    const d = _closestOnFace(verts, faces, hint, _tQ, _tP);
    if (d >= 0 && d < 1e-6) { bestFi = hint; bestD = d; }
  }
  if (bestFi < 0) {
    for (let i = 0; i < faces.length; i++) {
      const d = _closestOnFace(verts, faces, i, _tQ, _tP);
      if (d >= 0 && d < bestD) { bestD = d; bestFi = i; }
    }
  }
  if (bestFi < 0) return null;
  if (bestFi !== hint || bestD >= 1e-6) _closestOnFace(verts, faces, bestFi, _tQ, _tP);
  const n = faceNormal(verts, faces[bestFi], _tN);
  const len = n.length();
  if (len > 1e-12) n.divideScalar(len); else n.set(0, 1, 0);
  return { point: [_tP.x, _tP.y, _tP.z], normal: [n.x, n.y, n.z], face: bestFi };
}

const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();

/**
 * 这条边是不是「平的」——两侧面近乎共面。
 * 三角网格里一整块平面（比如方块的每个面）由两个三角面拼成，中间那条对角线
 * 在数据上是一条边，但对用户来说并不是「棱」：显示出来会让方块看起来有 18 条边，
 * 倒角时还会在平面中间凿出一条多余的凹槽。所以显示 / 拾取 / 倒角都跳过它。
 */
export function isFlatEdge(verts, faces, e, eps = 1e-3) {
  if (!e || !e.f || e.f.length !== 2) return false;
  const f1 = faces[e.f[0]], f2 = faces[e.f[1]];
  if (!f1 || !f2) return false;
  faceNormal(verts, f1, _n1);
  faceNormal(verts, f2, _n2);
  if (_n1.lengthSq() < 1e-12 || _n2.lengthSq() < 1e-12) return false;
  return _n1.normalize().dot(_n2.normalize()) > 1 - eps;
}

/** 顶点 → 相邻顶点集合（拉普拉斯平滑用） */
export function vertexAdjacency(faces, count) {
  const adj = Array.from({ length: count }, () => new Set());
  for (const f of faces) {
    if (!isTri(f)) continue;
    const a = f[0] | 0, b = f[1] | 0, c = f[2] | 0;
    if (a >= count || b >= count || c >= count) continue;
    adj[a].add(b); adj[a].add(c);
    adj[b].add(a); adj[b].add(c);
    adj[c].add(a); adj[c].add(b);
  }
  return adj;
}

/** 去掉没有被任何面引用的孤立顶点，返回「旧下标 → 新下标」映射 */
export function compactVerts(o) {
  const verts = polyVerts(o);
  const faces = polyFaces(o);
  const used = new Uint8Array(verts.length);
  for (const f of faces) { used[f[0]] = 1; used[f[1]] = 1; used[f[2]] = 1; }
  const remap = new Int32Array(verts.length).fill(-1);
  const out = [];
  for (let i = 0; i < verts.length; i++) {
    if (!used[i]) continue;
    remap[i] = out.length;
    out.push(verts[i]);
  }
  if (out.length === verts.length) return null;
  o.verts = out;
  o.faces = faces.map((f) => [remap[f[0]], remap[f[1]], remap[f[2]]]);
  return remap;
}

/* ============================================================
   选边倒角（chamfer）
   - 每条被选中的边在它两个相邻面里各内缩一条平行边，再用四边形把缝补上
   - 同一顶点在同一面里被多条选中边影响时，偏移量叠加后取平均（避免拐角裂开）
   - 只处理「恰好 2 个相邻面」的流形边；边界边与非流形边直接跳过
   - 平面内部的三角剖分对角线（共面边）不算棱，同样跳过
   ============================================================ */
export function bevelEdges(o, edgeKeys, amount) {
  const verts = polyVerts(o);
  const faces = polyFaces(o);
  const emap = edgeMap(faces);
  const manifold = (edgeKeys || [])
    .map((k) => emap.get(k))
    .filter((e) => e && e.f.length === 2);
  const targets = manifold.filter((e) => !isFlatEdge(verts, faces, e));
  const flat = manifold.length - targets.length;
  if (!targets.length) return { ok: false, reason: flat ? 'flat' : 'nomatch' };
  if (faces.length + targets.length * 2 > MAX_POLY_FACES) return { ok: false, reason: 'toobig' };

  // 倒角量不能超过相邻边长的 45%，否则面会自交翻面
  let minEdge = Infinity;
  for (const e of targets) {
    const a = verts[e.a], b = verts[e.b];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d > 1e-6) minEdge = Math.min(minEdge, d);
  }
  const amt = Math.min(Math.max(Number(amount) || 0, 1e-4),
    Number.isFinite(minEdge) ? minEdge * 0.45 : 1e9);

  // 累加每个 (面, 顶点) 的面内偏移方向与出现次数
  const acc = new Map();     // 面下标 → Map(顶点下标 → { dir: Vector3, n: number })
  const pushDir = (fi, vi, dir) => {
    let m = acc.get(fi);
    if (!m) { m = new Map(); acc.set(fi, m); }
    let cell = m.get(vi);
    if (!cell) { cell = { dir: new THREE.Vector3(), n: 0 }; m.set(vi, cell); }
    cell.dir.add(dir);
    cell.n++;
  };

  for (const e of targets) {
    const a = e.a, b = e.b;
    for (const fi of e.f) {
      const f = faces[fi];
      // 该面里与这条边相对的第三个顶点
      let c = -1;
      for (const x of f) if (x !== a && x !== b) { c = x; break; }
      if (c < 0) continue;
      const pa = verts[a], pb = verts[b], pc = verts[c];
      const dirA = perpInFace(pa, pb, pc);
      const dirB = perpInFace(pb, pa, pc);
      if (dirA) pushDir(fi, a, dirA);
      if (dirB) pushDir(fi, b, dirB);
    }
  }

  const newVerts = verts.map((v) => [v[0], v[1], v[2]]);
  const replace = new Map();   // `${面}|${顶点}` → 新顶点下标
  for (const [fi, m] of acc) {
    for (const [vi, cell] of m) {
      const d = cell.dir.clone().divideScalar(Math.max(1, cell.n));
      const len = d.length();
      if (len > 1e-9) d.multiplyScalar(amt / len);
      const p = verts[vi];
      newVerts.push([round(p[0] + d.x), round(p[1] + d.y), round(p[2] + d.z)]);
      replace.set(fi + '|' + vi, newVerts.length - 1);
    }
  }

  const newFaces = faces.map((f, fi) => f.map((vi) => {
    const r = replace.get(fi + '|' + vi);
    return r === undefined ? vi : r;
  }));

  // 用四边形把每条被倒的边两侧的缝补上（拆成两个三角）
  const n1 = new THREE.Vector3();
  const n2 = new THREE.Vector3();
  const avg = new THREE.Vector3();
  const qn = new THREE.Vector3();
  for (const e of targets) {
    const [f1, f2] = e.f;
    const a1 = replace.get(f1 + '|' + e.a), b1 = replace.get(f1 + '|' + e.b);
    const a2 = replace.get(f2 + '|' + e.a), b2 = replace.get(f2 + '|' + e.b);
    if (a1 === undefined || b1 === undefined || a2 === undefined || b2 === undefined) continue;
    faceNormal(verts, faces[f1], n1);
    faceNormal(verts, faces[f2], n2);
    avg.copy(n1).add(n2);
    // 桥接面的绕序要和原有两个面的平均朝向一致，否则会出现翻面
    faceNormal(newVerts, [a1, b1, b2], qn);
    if (qn.dot(avg) < 0) newFaces.push([a1, b2, b1], [a1, a2, b2]);
    else newFaces.push([a1, b1, b2], [a1, b2, a2]);
  }

  o.verts = newVerts;
  o.faces = newFaces;
  return { ok: true, edges: targets.length, added: newVerts.length - verts.length, flat };
}

/** 在顶点 P 处、面 (P,Q,R) 内，垂直于 PQ 且指向面内部（R 侧）的单位方向 */
function perpInFace(P, Q, R) {
  _v1.set(Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]);
  if (_v1.lengthSq() < 1e-12) return null;
  _v1.normalize();
  _v2.set(R[0] - P[0], R[1] - P[1], R[2] - P[2]);
  _v3.copy(_v2).addScaledVector(_v1, -_v2.dot(_v1));
  if (_v3.lengthSq() < 1e-12) return null;
  return _v3.clone().normalize();
}

/* ============================================================
   顶点级操作
   ============================================================ */

/**
 * 拉普拉斯平滑：只动被选中的点，往邻点平均值收敛。
 * 这就是「体素平滑」在低模上的等价物——雕刻笔刷的平滑模式也走它。
 */
export function smoothVerts(o, indexSet, strength = 0.5, iterations = 1) {
  const verts = polyVerts(o);
  const faces = polyFaces(o);
  const sel = indexSet instanceof Set ? [...indexSet] : (indexSet || []).map(Number);
  if (!sel.length) return 0;
  const adj = vertexAdjacency(faces, verts.length);
  const k = clamp(Number(strength) || 0, 0, 1);
  for (let it = 0; it < Math.max(1, iterations | 0); it++) {
    const next = new Map();
    for (const i of sel) {
      const nb = adj[i];
      if (!nb || !nb.size) continue;
      let sx = 0, sy = 0, sz = 0;
      for (const j of nb) { const p = verts[j]; sx += p[0]; sy += p[1]; sz += p[2]; }
      const m = nb.size;
      const p = verts[i];
      next.set(i, [
        round(p[0] + (sx / m - p[0]) * k),
        round(p[1] + (sy / m - p[1]) * k),
        round(p[2] + (sz / m - p[2]) * k),
      ]);
    }
    for (const [i, v] of next) verts[i] = v;
  }
  return sel.length;
}

/** 删除选中的面 */
export function deleteFaces(o, indexSet) {
  const faces = polyFaces(o);
  const rm = indexSet instanceof Set ? indexSet : new Set((indexSet || []).map(Number));
  if (!rm.size) return 0;
  const before = faces.length;
  o.faces = faces.filter((_, i) => !rm.has(i));
  const n = o.faces.length;
  if (n && n === before) return 0;
  compactVerts(o);
  return before - n;
}

/** 删除选中的顶点（连带删除引用它们的面） */
export function deleteVerts(o, indexSet) {
  const verts = polyVerts(o);
  const rm = indexSet instanceof Set ? new Set([...indexSet].map(Number)) : new Set((indexSet || []).map(Number));
  if (!rm.size) return 0;
  const before = verts.length;
  o.verts = verts.filter((_, i) => !rm.has(i));
  if (!o.verts.length) { o.verts = verts; return 0; }      // 不允许删空
  const remap = new Int32Array(before).fill(-1);
  let w = 0;
  for (let i = 0; i < before; i++) if (!rm.has(i)) remap[i] = w++;
  o.faces = polyFaces(o)
    .filter((f) => f[0] >= 0 && f[0] < before && remap[f[0]] >= 0
      && remap[f[1]] >= 0 && remap[f[2]] >= 0)
    .map((f) => [remap[f[0]], remap[f[1]], remap[f[2]]]);
  if (!o.faces.length) {
    o.verts = verts;
    return 0;
  }
  compactVerts(o);
  return before - polyVerts(o).length;
}
