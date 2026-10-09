/* ============================================================
   路径解析共享模块
   滑索 / 折曲线 / 管道 / 网格修改器 共用同一套
   「节点列表 + 段模式 + 贝塞尔手柄」的路径语义。

   约定：
   - 节点坐标是**绝对坐标**，几何按节点直接生成；o.position / o.rotation / o.scale
     由渲染端作为整体变换叠加（builder.applyPathTransform，旋转 / 缩放绕路径中心）。
   - 「路径来源 = 引用折曲线对象」时，取被引用折曲线的节点（同样不并入 o.position）。
   - 每个节点带一对**相对手柄** o.handles[i] = [inVec, outVec]（相对本节点的偏移量）：
       曲线段 = 以「起点 + 起点出手柄」「终点 + 终点入手柄」为控制点的三次贝塞尔曲线；
       直线段 = 直连，忽略手柄。
     手柄缺省（条目为 null 或整体缺失）时按 Catmull-Rom 自动推导，
     因此从没手动画过手柄的旧关卡依旧保持原来的平滑外观。
   ============================================================ */
import * as THREE from 'three';
import { clamp, deg2rad } from '../core/util.js';
import { docContours } from '../core/vector-shape.js';

/** 几何由 points 决定、o.position 不参与（自身节点模式）的类型。
    新增曲线类对象只需加进这个集合：视口节点编辑、gizmo 枢轴、关卡校验、
    引用折曲线、整体变换（applyPathTransform）全部由它统一驱动。 */
export const PATH_TYPES = new Set(['zipline', 'curve', 'pipe', 'curvewall']);

/** 视口里可逐节点编辑的类型：路径对象是「开放路径」，传送门是「闭合环」 */
export const CURVE_NODE_TYPES = new Set([...PATH_TYPES, 'portal']);

/** 路径节点最少数量 */
const MIN_POINTS = 2;
const FALLBACK = [[0, 10, 0], [0, 10, 30]];

/** 该对象当前是否处于「引用折曲线」模式 */
export function usesPathRef(o) {
  return !!(o && o.pathSource === 'curve' && o.pathRef);
}

/** 是否是一个可用的三维向量（数组形式） */
function isVec3(v) {
  return Array.isArray(v) && v.length >= 3 && v.every((x) => Number.isFinite(Number(x)));
}

/**
 * 节点自动切线（Catmull-Rom 的标准取法）：
 * 内部节点 = (后一个 - 前一个) / 6；端点 = 单侧差 / 3
 */
function autoTangent(points, i) {
  const cur = points[i];
  const prev = i > 0 ? points[i - 1] : null;
  const next = i < points.length - 1 ? points[i + 1] : null;
  const t = new THREE.Vector3();
  if (prev && next) t.subVectors(next, prev).multiplyScalar(1 / 6);
  else if (next) t.subVectors(next, cur).multiplyScalar(1 / 3);
  else if (prev) t.subVectors(cur, prev).multiplyScalar(1 / 3);
  return t;
}

/** 全部节点的自动手柄（[[inVec, outVec], ...]，与 points 一一对应） */
export function defaultHandles(points) {
  return points.map((_, i) => {
    const t = autoTangent(points, i);
    return [[-t.x, -t.y, -t.z], [t.x, t.y, t.z]];
  });
}

/** 把（可能稀疏 / 残缺的）o.handles 解析成与 points 等长的完整手柄表 */
export function resolveHandles(raw, points) {
  const auto = defaultHandles(points);
  return points.map((_, i) => {
    const h = Array.isArray(raw) ? raw[i] : null;
    const inV = Array.isArray(h) && isVec3(h[0]) ? h[0].map(Number) : auto[i][0];
    const outV = Array.isArray(h) && isVec3(h[1]) ? h[1].map(Number) : auto[i][1];
    return [inV, outV];
  });
}

/** 把 points 数组（[x,y,z]）转成 Vector3 数组 */
export function toVec3List(raw) {
  return (Array.isArray(raw) ? raw : []).map((p) => new THREE.Vector3(
    Number(p && p[0]) || 0, Number(p && p[1]) || 0, Number(p && p[2]) || 0));
}

/** 节点折线总长（用于估算采样密度，避免每次都精确求积分） */
export function pathLength(points) {
  let sum = 0;
  for (let i = 0; i < points.length - 1; i++) sum += points[i].distanceTo(points[i + 1]);
  return sum;
}

/** 把上层对象的整体变换（position / 绕质心的 rotation·scale）套到一组节点与手柄上
 *  —— 与 builder.applyPathTransform 的公式保持一致：世界 = T(offset)·T(C)·R·S·T(-C) */
function applyRefTransform(o, points, handles) {
  const off = Array.isArray(o.position) ? o.position : [0, 0, 0];
  const rot = Array.isArray(o.rotation) ? o.rotation : [0, 0, 0];
  const sc = Array.isArray(o.scale) ? o.scale : [1, 1, 1];
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    deg2rad(rot[0] || 0), deg2rad(rot[1] || 0), deg2rad(rot[2] || 0)));
  const s = new THREE.Vector3(
    Math.max(1e-4, Math.abs(sc[0] ?? 1)),
    Math.max(1e-4, Math.abs(sc[1] ?? 1)),
    Math.max(1e-4, Math.abs(sc[2] ?? 1)));
  // 枢轴必须与 builder.applyPathTransform 一致：对象固化了 o.pivot 时用它（节点编辑不会带动
  // 整体变换），否则退回当前质心 —— 否则引用它的管道 / 滑索会与折曲线本体错位
  const C = new THREE.Vector3();
  const pv = Array.isArray(o.pivot) && o.pivot.length >= 3 ? o.pivot : null;
  if (pv) C.set(Number(pv[0]) || 0, Number(pv[1]) || 0, Number(pv[2]) || 0);
  else if (points.length) { for (const p of points) C.add(p); C.multiplyScalar(1 / points.length); }
  const T = new THREE.Vector3(Number(off[0]) || 0, Number(off[1]) || 0, Number(off[2]) || 0);
  const pt = points.map((p) => p.clone().sub(C).multiply(s).applyQuaternion(q).add(C).add(T));
  // 手柄是相对偏移量：只做旋转 / 缩放，不含平移与质心
  const vec = (v) => new THREE.Vector3(Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0).multiply(s).applyQuaternion(q);
  const hs = handles.map(([a, b]) => {
    const va = vec(a), vb = vec(b);
    return [[va.x, va.y, va.z], [vb.x, vb.y, vb.z]];
  });
  return { points: pt, handles: hs };
}

/**
 * 解析对象的实际路径
 * @returns {{points: THREE.Vector3[], segModes: string[], handles: number[][][], fromRef: boolean}}
 */
export function resolvePath(o, level) {
  if (usesPathRef(o) && level) {
    const src = (level.objects || []).find((x) => x.id === o.pathRef && x.type === 'curve');
    if (src && Array.isArray(src.points) && src.points.length >= MIN_POINTS) {
      const base = toVec3List(src.points);
      // 引用模式要连被引用折曲线的整体变换一起带上，否则移动曲线时引用它的管道 / 滑索不会跟着动
      const t = applyRefTransform(src, base, resolveHandles(src.handles, base));
      return { points: t.points, segModes: src.segModes || [], handles: t.handles, fromRef: true };
    }
  }
  const raw = (o && Array.isArray(o.points) && o.points.length >= MIN_POINTS) ? o.points : FALLBACK;
  const points = toVec3List(raw);
  return {
    points,
    segModes: (o && o.segModes) || [],
    handles: resolveHandles(o && o.handles, points),
    fromRef: false,
  };
}

/**
 * 逐段建曲线：曲线段 = 三次贝塞尔（两端节点的外侧手柄作控制点），直线段 = 直连
 * @returns {THREE.CurvePath}
 */
export function buildCurve(points, segModes, handles) {
  const modes = segModes || [];
  const hs = handles || defaultHandles(points);
  const path = new THREE.CurvePath();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if ((modes[i] || 'curve') === 'line') { path.add(new THREE.LineCurve3(a, b)); continue; }
    const oa = (hs[i] && hs[i][1]) || [0, 0, 0];
    const ib = (hs[i + 1] && hs[i + 1][0]) || [0, 0, 0];
    path.add(new THREE.CubicBezierCurve3(
      a,
      new THREE.Vector3(a.x + oa[0], a.y + oa[1], a.z + oa[2]),
      new THREE.Vector3(b.x + ib[0], b.y + ib[1], b.z + ib[2]),
      b,
    ));
  }
  return path;
}

/** 平滑采样点 / 弧长表 / 总长（div 按路径长度估算，与旧版密度相当） */
export function sampleCurve(curve, approx) {
  const len = Number(approx) > 0 ? Number(approx) : curve.getLength();
  const div = clamp(Math.round(len * 1.4), 24, 600);
  const smooth = curve.getPoints(div);
  const lengths = curve.getLengths(200);
  const total = lengths[lengths.length - 1] || 1;
  return { div, smooth, lengths, total };
}

/** 一次性解析 + 建曲线（滑索 / 折曲线 / 管道共用） */
export function makePath(o, level) {
  const { points, segModes, handles, fromRef } = resolvePath(o, level);
  const curve = buildCurve(points, segModes, handles);
  const { div, smooth, lengths, total } = sampleCurve(curve, pathLength(points));
  return {
    points, segModes, handles, fromRef, curve, div, smooth, lengths, total,
    pointsRaw: points,
    getAt(d, out) { return curve.getPointAt(clamp(d / total, 0, 1), out); },
  };
}

/* ============================================================
   管道截面预设
   ============================================================ */
export const SECTION_OPTIONS = [
  { v: 'circle', l: '圆形' },
  { v: 'square', l: '正方' },
  { v: 'triangle', l: '三角' },
  { v: 'pentagon', l: '五边' },
  { v: 'hexagon', l: '六边' },
  { v: 'octagon', l: '八角' },
  { v: 'star', l: '星形' },
  { v: 'semicircle', l: '半圆槽' },
  { v: 'custom', l: '自定义' },
];

/** 正 n 边形（外接半径 1，phase 为起始角） */
function ngon(n, phase = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    out.push([Math.cos(a), Math.sin(a)]);
  }
  return out;
}

/**
 * 截面轮廓（单位半径，逆时针，不闭合；由 sweepGeometry 隐式闭合）
 * @returns {Array<[number, number]>}
 */
export function sectionProfile(o) {
  const sides = clamp(Math.round(Number(o && o.sectionSides)) || 12, 3, 32);
  const kind = (o && o.section) || 'circle';
  let pts;
  switch (kind) {
    case 'square': pts = ngon(4, Math.PI / 4); break;
    case 'triangle': pts = ngon(3, Math.PI / 2); break;
    case 'pentagon': pts = ngon(5, Math.PI / 2); break;
    case 'hexagon': pts = ngon(6, Math.PI / 2); break;
    case 'octagon': pts = ngon(8, Math.PI / 2 + Math.PI / 8); break;
    case 'star': {
      const inner = clamp(Number(o && o.starInner) || 0.45, 0.05, 1);
      pts = [];
      const n2 = sides * 2;
      for (let i = 0; i < n2; i++) {
        const a = Math.PI / 2 + (i / n2) * Math.PI * 2;
        const r = i % 2 === 0 ? 1 : inner;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      break;
    }
    case 'semicircle': {
      // 上半圆（0 → π）+ 底边直连 → U 形槽
      const n = Math.max(4, sides);
      pts = [];
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI;
        pts.push([Math.cos(a), Math.sin(a)]);
      }
      break;
    }
    case 'custom': {
      const raw = Array.isArray(o && o.sectionPts) ? o.sectionPts : [];
      const clean = raw
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);
      pts = clean.length >= 3 ? clean : ngon(Math.max(3, sides));
      break;
    }
    case 'circle':
    default: pts = ngon(Math.max(3, sides)); break;
  }
  const rot = deg2rad(Number(o && o.sectionRot) || 0);
  if (rot) {
    const c = Math.cos(rot), s = Math.sin(rot);
    pts = pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
  }
  return pts;
}

/** 一条轮廓点列（滤掉非法项，并统一成逆时针：扫掠的侧面 / 封口绕序都按逆时针写死） */
function cleanContour(raw) {
  const pts = (Array.isArray(raw) ? raw : [])
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);
  if (pts.length < 3) return pts;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a < 0 ? pts.reverse() : pts;
}

/**
 * 截面轮廓列表（单位半径，逆时针，不闭合）—— 支持**非连续截面**（多个互不相交的子轮廓，
 * 例如两个不相交的圆）：每条子轮廓各扫一条管，最后合并成同一个几何。
 * 数据来源优先级：sectionDoc（矢量图文档，可含贝塞尔）> sectionPtsList（折线轮廓列表）
 * > 单条 sectionPts / 内置预设（sectionProfile）。
 * @returns {Array<Array<[number, number]>>}
 */
export function sectionProfiles(o) {
  const rot = deg2rad(Number(o && o.sectionRot) || 0);
  const rotate = (pts) => {
    if (!rot) return pts;
    const c = Math.cos(rot), s = Math.sin(rot);
    return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
  };
  const doc = o && o.sectionDoc;
  if (doc && Array.isArray(doc.layers)) {
    const list = docContours(doc).map((c) => cleanContour(c.pts)).filter((p) => p.length >= 3);
    if (list.length) return list.map(rotate);
  }
  const list = Array.isArray(o && o.sectionPtsList) ? o.sectionPtsList : null;
  if (list) {
    const clean = list.map(cleanContour).filter((p) => p.length >= 3);
    if (clean.length) return clean.map(rotate);
  }
  return [sectionProfile(o)];
}
