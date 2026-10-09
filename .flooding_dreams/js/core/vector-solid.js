/* ============================================================
   2D 矢量图形 → 实体（栅格布尔 + 轮廓化 + 挤出倒角）
   ------------------------------------------------------------
   · toLoops / classifyContours：轮廓规范化、绕向统一（外环逆时针、
     孔洞顺时针）、按「包含深度」分出外环与孔洞
   · booleanContours：两组轮廓分别填进离屏画布，用 canvas 合成算子做
     并 / 交 / 差 / 异或（evenodd 填充），读回 alpha → marching squares
     描边界 → Douglas-Peucker 简化 → 世界坐标轮廓
   · extrudeContours：轮廓 → { verts, faces }（单位空间：XY 归一化到
     最长边 = 1 并居中，Z 为厚度方向）；上下盖用 ShapeUtils.triangulateShape
     （支持孔洞），侧壁逐环成带；边缘倒角 = 沿轮廓逐圈内缩的环
     （round / chamfer / pow），倒角量可按周长做正弦调制
   · vecGeometry：vec 类型对象的 BufferGeometry（盒式投影 uv，烘 scale）
   ============================================================ */
import * as THREE from 'three';
import { docContours, contoursBBox, polyArea, pointInPoly } from './vector-shape.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function unit2(dx, dy) {
  const l = Math.hypot(dx, dy);
  return l > 1e-12 ? [dx / l, dy / l] : [0, 0];
}

function distPtSeg2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t, qy = ay + dy * t;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

/* ============================================================
   轮廓规范化
   ============================================================ */

/** 接受 [[x,y]…] / { pts, closed } 两种写法 → [{ pts:[[x,y]…] }] */
export function toLoops(contours) {
  const out = [];
  for (const c of (contours || [])) {
    let pts = null;
    if (Array.isArray(c) && Array.isArray(c[0])) pts = c;
    else if (c && Array.isArray(c.pts)) pts = c.pts;
    if (!pts) continue;
    const q = [];
    for (const p of pts) {
      if (!p) continue;
      const x = Number(p[0]), y = Number(p[1]);
      if (!isFinite(x) || !isFinite(y)) continue;
      q.push([x, y]);
    }
    if (q.length >= 3) out.push({ pts: dedupePts(q, 1e-9) });
  }
  return out.filter((c) => c.pts.length >= 3);
}

/** 去掉重合点（闭合环的首尾也算相邻） */
export function dedupePts(pts, eps) {
  const e = Number(eps) > 0 ? Number(eps) : 1e-9;
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) <= e && Math.abs(last[1] - p[1]) <= e) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= e && Math.abs(a[1] - b[1]) <= e) out.pop();
    else break;
  }
  return out;
}

/** 每个顶点在闭合周长上的归一化参数 t ∈ [0,1) */
function loopParams(pts) {
  const n = pts.length;
  const cum = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[n] || 1;
  const t = new Array(n);
  for (let i = 0; i < n; i++) t[i] = cum[i] / total;
  return t;
}

/** 环上的一个「内部点」（用于包含判定 / 倒角上限估计） */
function interiorPoint(pts) {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  if (pointInPoly(pts, cx, cy)) return [cx, cy];
  let size = 0;
  for (const p of pts) size = Math.max(size, Math.abs(p[0] - cx), Math.abs(p[1] - cy));
  const eps = Math.max(1e-6, size * 2e-3);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (!pointInPoly(pts, mx, my)) continue;
    const d = unit2(b[0] - a[0], b[1] - a[1]);
    const qx = mx - d[1] * eps, qy = my + d[0] * eps;
    if (pointInPoly(pts, qx, qy)) return [qx, qy];
    return [mx, my];
  }
  return [cx, cy];
}

/**
 * 环上「贴着边界的内点」——嵌套判定的取样点。
 * 不能用形心：带孔环的形心正好落进它自己的孔里，会让「谁包含谁」判反，
 * 结果整块的盖子消失（外环被判成孔洞 → 一组外环都挑不出来）。
 * 取一条边的中点朝环内挪一小步：既严格在环内，又贴着边界，不受其它环干扰。
 */
function boundarySample(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d = unit2(b[0] - a[0], b[1] - a[1]);
    if (d[0] === 0 && d[1] === 0) continue;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const eps = Math.max(1e-9, len * 1e-4);
    const q1 = [mx - d[1] * eps, my + d[0] * eps];
    if (pointInPoly(pts, q1[0], q1[1])) return q1;
    const q2 = [mx + d[1] * eps, my - d[0] * eps];
    if (pointInPoly(pts, q2[0], q2[1])) return q2;
  }
  return interiorPoint(pts);       // 退化环（极薄 / 自交）：退回形心
}

/**
 * 轮廓分类 + 绕向统一。
 * @returns {{ all: Array<{pts:Array, area:number}>,
 *             groups: Array<{outer:number, holes:number[]}> }}
 *          外环统一为逆时针（面积 > 0），孔洞统一为顺时针；
 *          嵌套的「岛」（深度为偶数的内环）自成一组，盖子互不重叠。
 */
export function classifyContours(loops) {
  const all = (loops || []).map((c) => ({ pts: c.pts.map((p) => [p[0], p[1]]), area: 0, sp: null }));
  for (const c of all) { c.area = polyArea(c.pts); c.sp = boundarySample(c.pts); }
  // 包含深度（奇 = 孔洞）
  const depth = new Array(all.length).fill(0);
  for (let i = 0; i < all.length; i++) {
    let d = 0;
    for (let j = 0; j < all.length; j++) {
      if (i === j) continue;
      if (pointInPoly(all[j].pts, all[i].sp[0], all[i].sp[1])) d += 1;
    }
    depth[i] = d;
  }
  // 统一绕向
  for (let i = 0; i < all.length; i++) {
    const wantCCW = (depth[i] % 2) === 0;
    const isCCW = all[i].area > 0;
    if (wantCCW !== isCCW) { all[i].pts.reverse(); all[i].area = -all[i].area; }
  }
  const groups = [];
  for (let i = 0; i < all.length; i++) {
    if (depth[i] % 2 !== 0) continue;
    groups.push({ outer: i, holes: [] });
  }
  for (let i = 0; i < all.length; i++) {
    if (depth[i] % 2 === 0) continue;
    // 归给「包含它、且面积最小的外环」
    let best = -1, bestArea = Infinity;
    for (const g of groups) {
      if (!pointInPoly(all[g.outer].pts, all[i].sp[0], all[i].sp[1])) continue;
      const a = Math.abs(all[g.outer].area);
      if (a < bestArea) { bestArea = a; best = g; }
    }
    if (best !== -1) best.holes.push(i);       // best 是组对象，不能用 best >= 0 判空
  }
  return { all, groups };
}

/* ============================================================
   偏移（向材料内部内缩）—— 倒角环 / 盖子的基础
   ============================================================ */

/**
 * 把闭合轮廓整体向「材料内部」内缩（外环缩小、孔洞扩大）。
 * 靠左法线推进（外环已统一为逆时针、孔洞为顺时针 → 左法线恒指向材料）。
 * @param {Array<[number,number]>} pts
 * @param {number|number[]} d 内缩量；数组 = 逐顶点
 */
export function offsetSolid(pts, d) {
  const n = pts.length;
  if (n < 3) return pts.map((p) => [p[0], p[1]]);
  const per = Array.isArray(d);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    const di = Math.max(0, per ? (Number(d[i]) || 0) : (Number(d) || 0));
    if (di <= 1e-9) { out[i] = [c[0], c[1]]; continue; }
    const vin = unit2(c[0] - p[0], c[1] - p[1]);
    const vout = unit2(q[0] - c[0], q[1] - c[1]);
    // 左法线 = (-vy, vx)
    const n1 = [-vin[1], vin[0]], n2 = [-vout[1], vout[0]];
    let bis = unit2(n1[0] + n2[0], n1[1] + n2[1]);
    if (bis[0] === 0 && bis[1] === 0) bis = n1;
    const cos = bis[0] * n1[0] + bis[1] * n1[1];
    let len = di / Math.max(0.25, cos);       // 斜接
    if (len > di * 5) len = di * 5;           // 斜接限制，避免尖角炸开
    out[i] = [c[0] + bis[0] * len, c[1] + bis[1] * len];
  }
  return out;
}

/**
 * 倒角量上限：不超过「材料局部半宽」的 0.9 倍，也不超过厚度的一半。
 * 分两部分量：
 *   ① 环内点 → 自身边界：简单 / 凸环的局部半宽；
 *   ② 逐顶点 → 其它环的边：材料的「对面墙」常常在另一个环上。
 * ② 不能省：薄环（外圆 r=1 + 孔 r=0.9）只按 ① 会得出「半宽 = 半径」这种假值，
 * 倒角一开就把两层墙互相推穿 → 侧壁与倒角环交错、盖子翻面，满屏尖刺三角面。
 */
export function bevelLimit(loops, depth) {
  const L = (loops || []).filter((l) => l.pts && l.pts.length >= 3);
  const cap = Math.max(0.005, (Number(depth) || 0.25) * 0.49);
  let lim = cap * 2;                          // 比这更远的距离已不影响最终取值
  // ① 环内点 → 自身边界
  for (const l of L) {
    const ip = interiorPoint(l.pts);
    let d = Infinity;
    for (let i = 0; i < l.pts.length; i++) {
      const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length];
      d = Math.min(d, Math.sqrt(distPtSeg2(ip[0], ip[1], a[0], a[1], b[0], b[1])));
    }
    if (isFinite(d)) lim = Math.min(lim, d * 0.9);
  }
  // ② 跨环：顶点到其它环的边，取 0.45（两边各让一半才不会撞上，留一点余量）
  for (let a = 0; a < L.length; a++) {
    const pa = L[a].pts;
    for (let i = 0; i < pa.length; i++) {
      const px = pa[i][0], py = pa[i][1];
      const reach = lim * 2;                  // lim 只会变小 → 剪枝越来越紧
      for (let b = 0; b < L.length; b++) {
        if (b === a) continue;
        const pb = L[b].pts, nb = pb.length;
        for (let j = 0; j < nb; j++) {
          const q = pb[j], r = pb[(j + 1) % nb];
          const loX = q[0] < r[0] ? q[0] : r[0], hiX = q[0] < r[0] ? r[0] : q[0];
          const loY = q[1] < r[1] ? q[1] : r[1], hiY = q[1] < r[1] ? r[1] : q[1];
          const dx = px < loX ? loX - px : (px > hiX ? px - hiX : 0);
          if (dx > reach) continue;
          const dy = py < loY ? loY - py : (py > hiY ? py - hiY : 0);
          if (dy > reach) continue;
          const d = Math.sqrt(distPtSeg2(px, py, q[0], q[1], r[0], r[1]));
          if (d * 0.45 < lim) lim = d * 0.45;
        }
      }
    }
  }
  if (!isFinite(lim)) lim = cap;
  return Math.max(0.002, Math.min(lim, cap));
}

/* ============================================================
   折线简化（Douglas-Peucker）
   ============================================================ */

function dpOpen(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j - i < 2) continue;
    let maxD = -1, maxK = -1;
    for (let k = i + 1; k < j; k++) {
      const d = distPtSeg2(pts[k][0], pts[k][1], pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
      if (d > maxD) { maxD = d; maxK = k; }
    }
    if (maxK > 0 && maxD > tol * tol) {
      keep[maxK] = 1;
      stack.push([i, maxK], [maxK, j]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** 闭合折线简化：取最远点对切成两条开链分别简化 */
export function simplifyClosed(pts, tol) {
  const n = pts.length;
  const t = Number(tol) || 0;
  if (n < 5 || t <= 0) return pts.map((p) => [p[0], p[1]]);
  let a = 0, b = 1, best = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
      const d = dx * dx + dy * dy;
      if (d > best) { best = d; a = i; b = j; }
    }
  }
  const c1 = [];
  for (let i = a; i <= b; i++) c1.push(pts[i]);
  const c2 = [];
  for (let i = b; i < n; i++) c2.push(pts[i]);
  for (let i = 0; i <= a; i++) c2.push(pts[i]);
  const s1 = dpOpen(c1, t);
  const s2 = dpOpen(c2, t);
  const out = s1.slice(0, s1.length - 1).concat(s2.slice(0, s2.length - 1));
  return out.length >= 3 ? out : pts.map((p) => [p[0], p[1]]);
}

/* ============================================================
   栅格化 + marching squares（布尔运算）
   ============================================================ */

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * 二值掩码 → 边界环（像素坐标，格点空间）。内部恒在 r = (-vy, vx) 一侧。
 * 掩码为 0 / 1，交点在格边中点。
 */
export function marchingSquares(mask, W, H) {
  const segs = [];
  const at = (x, y) => ((x < 0 || y < 0 || x >= W || y >= H) ? 0 : mask[y * W + x]);
  const push = (p, q, ix, iy) => {
    const rx = -(q[1] - p[1]), ry = q[0] - p[0];
    const mx = (p[0] + q[0]) / 2 - ix, my = (p[1] + q[1]) / 2 - iy;
    if (rx * mx + ry * my > 0) segs.push([p[0], p[1], q[0], q[1]]);
    else segs.push([q[0], q[1], p[0], p[1]]);
  };
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = at(x, y), b = at(x + 1, y), c = at(x + 1, y + 1), d = at(x, y + 1);
      if (!(a | b | c | d)) continue;
      const top = [x + 0.5, y], right = [x + 1, y + 0.5];
      const bottom = [x + 0.5, y + 1], left = [x, y + 0.5];
      if (a) push(top, left, x, y);
      if (b) push(right, top, x + 1, y);
      if (c) push(bottom, right, x + 1, y + 1);
      if (d) push(left, bottom, x, y + 1);
    }
  }
  const keyOf = (x, y) => (Math.round(x * 2) * 1048576 + Math.round(y * 2));
  const starts = new Map();
  for (let i = 0; i < segs.length; i++) {
    const k = keyOf(segs[i][0], segs[i][1]);
    const arr = starts.get(k);
    if (arr) arr.push(i); else starts.set(k, [i]);
  }
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const loop = [];
    let cur = i;
    for (let guard = 0; guard <= segs.length; guard++) {
      used[cur] = 1;
      const s = segs[cur];
      loop.push([s[0], s[1]]);
      const cand = starts.get(keyOf(s[2], s[3]));
      let next = -1;
      if (cand) for (const c of cand) if (!used[c]) { next = c; break; }
      if (next < 0) break;
      cur = next;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/**
 * 栅格辅助的 2D 布尔运算。
 * @param {Array} a 轮廓 A（[[x,y]…] / {pts} 均可）
 * @param {Array} b 轮廓 B
 * @param {'union'|'subtract'|'intersect'|'xor'} op A op B
 * @param {{resolution?:number, simplify?:number}} opts
 *        resolution = 栅格最长边像素数（默认 640）；simplify = 简化容差（世界单位，
 *        默认 1.2 像素的等效长度）
 * @returns {Array<{pts:Array, closed:boolean}>}
 */
export function booleanContours(a, b, op, opts = {}) {
  const la = toLoops(a), lb = toLoops(b);
  if (!la.length && !lb.length) return [];
  if (!lb.length || op === 'none') return la.map((c) => ({ pts: c.pts.map((p) => [p[0], p[1]]), closed: true }));
  if (!la.length) return op === 'union' ? lb.map((c) => ({ pts: c.pts.map((p) => [p[0], p[1]]), closed: true })) : [];
  const bb = contoursBBox(la.concat(lb));
  const pad = Math.max(1e-6, Math.max(bb.w, bb.h) * 0.03);
  const minX = bb.minX - pad, minY = bb.minY - pad;
  const wUnit = bb.w + pad * 2, hUnit = bb.h + pad * 2;
  const res = clamp(Math.round(Number(opts.resolution) || 640), 64, 2048);
  const s = res / Math.max(wUnit, hUnit);
  const W = Math.max(8, Math.ceil(wUnit * s)), H = Math.max(8, Math.ceil(hUnit * s));
  let ctx = null;
  try {
    const cv = makeCanvas(W, H);
    ctx = cv.getContext('2d', { willReadFrequently: true }) || cv.getContext('2d');
  } catch (e) { ctx = null; }
  if (!ctx) return la.map((c) => ({ pts: c.pts.map((p) => [p[0], p[1]]), closed: true }));

  const tracePath = (loops) => {
    ctx.beginPath();
    for (const l of loops) {
      for (let i = 0; i < l.pts.length; i++) {
        const px = (l.pts[i][0] - minX) * s;
        const py = H - (l.pts[i][1] - minY) * s;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
  };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#fff';
  tracePath(la);
  ctx.fill('evenodd');
  if (op === 'subtract') ctx.globalCompositeOperation = 'destination-out';
  else if (op === 'intersect') ctx.globalCompositeOperation = 'destination-in';
  else if (op === 'xor') ctx.globalCompositeOperation = 'xor';
  tracePath(lb);
  ctx.fill('evenodd');
  ctx.globalCompositeOperation = 'source-over';

  const img = ctx.getImageData(0, 0, W, H).data;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = img[i * 4 + 3] > 127 ? 1 : 0;
  const px = marchingSquares(mask, W, H);
  const tolPx = Number(opts.simplify) > 0 ? Number(opts.simplify) : 1.2 / s;
  const out = [];
  for (const loop of px) {
    const world = loop.map((p) => [minX + p[0] / s, minY + (H - p[1]) / s]);
    const simp = simplifyClosed(world, tolPx);
    if (simp.length >= 3) out.push({ pts: simp, closed: true });
  }
  return out;
}

/* ============================================================
   挤出（含边缘倒角 / 倒角调制）
   ============================================================ */

/** 倒角剖面：u=0 贴侧壁 → u=1 贴盖子；返回 [径向内缩比, 高度比] */
function profileFn(kind, u) {
  if (kind === 'chamfer') return [u, u];
  if (kind === 'pow') {
    const e = 0.55;
    return [1 - Math.pow(1 - u, 1 / e), Math.pow(u, 1 / e)];
  }
  const a = u * Math.PI / 2;
  return [1 - Math.cos(a), Math.sin(a)];
}

/** 逐顶点倒角量（含按周长的正弦调制） */
function bevelArrayFor(pts, base, mod) {
  const n = pts.length;
  const out = new Array(n).fill(base);
  if (base <= 1e-9 || !mod || mod.mode !== 'wave') return out;
  const t = loopParams(pts);
  const amp = Number(mod.amp) || 0;
  const freq = Number(mod.freq) || 1;
  const phase = Number(mod.phase) || 0;
  for (let i = 0; i < n; i++) {
    out[i] = base * Math.max(0, 1 + amp * Math.sin(Math.PI * 2 * freq * t[i] + phase));
  }
  return out;
}

function pushRing(xy, z, verts) {
  const base = verts.length;
  const perVertex = Array.isArray(z);
  for (let i = 0; i < xy.length; i++) {
    verts.push([xy[i][0], xy[i][1], perVertex ? (Number(z[i]) || 0) : (Number(z) || 0)]);
  }
  return base;
}

/** 两圈等长顶点之间的侧带（低 z → 高 z，外法线朝外） */
function strip(baseA, baseB, n, faces) {
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([baseA + i, baseA + j, baseB + j]);
    faces.push([baseA + i, baseB + j, baseB + i]);
  }
}

/**
 * 给 three 的 triangulateShape 用的点。
 * 它内部会对首尾点调 .equals()（removeDupEndPts），传朴素 { x, y } 会直接抛
 * TypeError → 三角化静默失败。带上这个方法即可正常走 Earcut（支持凹多边形 + 孔洞）。
 */
function triPt(p) {
  const o = { x: p[0], y: p[1] };
  o.equals = (q) => !!q && q.x === o.x && q.y === o.y;
  return o;
}

/**
 * 轮廓 → 单位空间实体网格数据。
 * XY：轮廓按包围盒归一化（最长边 = 1，居中）；Z：±depth/2。
 * @param {Array} contours 世界轮廓
 * @param {{depth?:number, bevelSize?:number, bevelSegments?:number,
 *          bevelProfile?:'round'|'chamfer'|'pow',
 *          modulation?:{mode?:'none'|'wave', amp?:number, freq?:number, phase?:number},
 *          simplify?:number}} opts
 * @returns {{verts:number[][], faces:number[][]}}
 */
export function extrudeContours(contours, opts = {}) {
  const verts = [], faces = [];
  const raw = toLoops(contours);
  if (!raw.length) return { verts, faces };

  // 归一化：最长边 = 1、居中
  const bb = contoursBBox(raw);
  const md = Math.max(bb.w, bb.h) || 1;
  const k = 1 / md, cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  const simp = Number(opts.simplify) > 0 ? Number(opts.simplify) : 0;
  const loops = raw.map((c) => {
    let p = c.pts.map((q) => [(q[0] - cx) * k, (q[1] - cy) * k]);
    if (simp > 0) p = simplifyClosed(p, simp * k);
    return { pts: p };
  }).filter((c) => c.pts.length >= 3);
  if (!loops.length) return { verts, faces };

  const depth = Math.max(1e-4, Number(opts.depth) || 0.25);
  const capZ = depth / 2;

  // 倒角量：先受几何上限约束，再逐顶点调制
  const mod = opts.modulation && opts.modulation.mode === 'wave' ? opts.modulation : null;
  const amp = mod ? Math.abs(Number(mod.amp) || 0) : 0;
  const lim = bevelLimit(loops, depth) / Math.max(1, 1 + amp);
  let bevel = Math.max(0, Number(opts.bevelSize) || 0);
  bevel = Math.min(bevel, lim);
  const segsTotal = clamp(Math.round(Number(opts.bevelSegments) || 3), 1, 24);
  const segs = opts.bevelProfile === 'chamfer' ? 1 : segsTotal;

  const cls = classifyContours(loops);
  const bevOf = cls.all.map((c) => bevelArrayFor(c.pts, bevel, mod));

  // ---------- 侧壁 + 倒角环 ----------
  for (let i = 0; i < cls.all.length; i++) {
    const pts = cls.all[i].pts;
    const bev = bevOf[i];
    const n = pts.length;
    const ringAt = (u) => {
      const [pr, ph] = profileFn(opts.bevelProfile, u);
      return {
        xy: offsetSolid(pts, bev.map((b) => b * pr)),
        zTop: bev.map((b) => capZ - b * (1 - ph)),
        zBot: bev.map((b) => -(capZ - b * (1 - ph))),
      };
    };
    const hasBev = bev.some((b) => b > 1e-9);
    // 侧壁：低 z → 高 z
    const wb = pushRing(pts, ringAt(0).zBot, verts);
    const wt = pushRing(pts, ringAt(0).zTop, verts);
    strip(wb, wt, n, faces);
    if (!hasBev) continue;
    // 上倒角：u 从 0（贴侧壁）到 1（贴盖子）
    let prev = wt;
    for (let s = 1; s <= segs; s++) {
      const r = ringAt(s / segs);
      const cur = pushRing(r.xy, r.zTop, verts);
      strip(prev, cur, n, faces);
      prev = cur;
    }
    // 下倒角：z 递增 → u 从 1（贴底盖）到 0（贴侧壁）
    let prevB = null;
    for (let s = segs; s >= 0; s--) {
      const r = ringAt(s / segs);
      const cur = pushRing(r.xy, r.zBot, verts);
      if (prevB !== null) strip(prevB, cur, n, faces);
      prevB = cur;
    }
  }

  // ---------- 上下盖（逐组：外环 + 其孔洞） ----------
  for (const g of cls.groups) {
    const outerPts = offsetSolid(cls.all[g.outer].pts, bevOf[g.outer]);
    const holesPts = g.holes.map((h) => offsetSolid(cls.all[h].pts, bevOf[h]));
    const outer2 = outerPts.map(triPt);
    const holes2 = holesPts.map((h) => h.map(triPt));
    let tris = null;
    try { tris = THREE.ShapeUtils.triangulateShape(outer2, holes2); } catch (e) { tris = null; }
    // 三角化失败 = 轮廓退化（自交 / 点数不足）：宁可不盖章，也不要铺一扇穿透轮廓的错误三角面
    if (!tris || !tris.length) continue;
    // 顶点表与 all2 同源（triangulateShape 可能就地裁掉首尾重合点，索引以裁剪后的为准）
    const all2 = outer2.slice();
    for (const h of holes2) for (const p of h) all2.push(p);
    const pushPoly = (pts2, z) => {
      const base = verts.length;
      for (const p of pts2) verts.push([p.x, p.y, z]);
      return base;
    };
    const top = pushPoly(outer2, capZ);
    for (const h of holes2) pushPoly(h, capZ);
    const bot = pushPoly(outer2, -capZ);
    for (const h of holes2) pushPoly(h, -capZ);
    for (const t of tris) {
      const A = all2[t[0]], B = all2[t[1]], C = all2[t[2]];
      if (!A || !B || !C) continue;
      const ori = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
      if (ori >= 0) faces.push([top + t[0], top + t[1], top + t[2]]);
      else faces.push([top + t[0], top + t[2], top + t[1]]);
      faces.push([bot + t[0], bot + t[2], bot + t[1]]);
    }
  }
  return { verts, faces };
}

/* ============================================================
   vec 对象：网格数据 + BufferGeometry
   ============================================================ */

/** 形状文档 → 单位空间 { verts, faces }；无有效轮廓返回 null */
export function vecMeshData(o) {
  const doc = o && o.vecShape;
  if (!doc) return null;
  let loops = docContours(doc, 0);
  if (!loops.length) return null;
  const bb = contoursBBox(loops);
  const md = Math.max(bb.w, bb.h);
  if (md > 2) loops = docContours(doc, md * 0.0015);
  const data = extrudeContours(loops, {
    depth: o.depth,
    bevelSize: o.bevelSize,
    bevelSegments: o.bevelSegments,
    bevelProfile: o.bevelProfile,
    modulation: {
      mode: o.modMode, amp: o.modAmp, freq: o.modFreq, phase: o.modPhase,
    },
  });
  return data.faces.length ? data : null;
}

/** 形状 / 厚度 / 倒角摘要（几何重建判定用） */
export function vecKey(o) {
  if (!o) return '';
  return JSON.stringify([
    o.scale || null,
    o.depth, o.bevelSize, o.bevelSegments, o.bevelProfile,
    o.modMode, o.modAmp, o.modFreq, o.modPhase, o.vecShape || null,
  ]);
}

/** 盒式投影 uv（与低模建模体同一套规则：主轴选另两轴坐标，乘 scale 烘成 stud） */
function boxUV(geo, verts, faces, scale) {
  const n = verts.length;
  const uv = new Float32Array(n * 2);
  const done = new Uint8Array(n);
  const nor = geo.attributes.normal;
  const sc = (scale && scale.length >= 3 ? scale : [1, 1, 1]).map((v) => Number(v) || 1);
  for (const f of faces) {
    const a = f[0] | 0;
    if (a >= n || done[a]) continue;
    const nx = nor ? nor.getX(a) : 0, ny = nor ? nor.getY(a) : 0, nz = nor ? nor.getZ(a) : 1;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const axis = (ax >= ay && ax >= az) ? 0 : (ay >= az ? 1 : 2);
    const i0 = axis === 0 ? 1 : 0;
    const i1 = axis === 2 ? 1 : 2;
    for (const vi of [f[0] | 0, f[1] | 0, f[2] | 0]) {
      if (vi >= n || done[vi]) continue;
      done[vi] = 1;
      uv[vi * 2] = verts[vi][i0] * sc[i0];
      uv[vi * 2 + 1] = verts[vi][i1] * sc[i1];
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** vec 对象 → BufferGeometry（索引化 + 顶点法线 + 盒式投影 uv） */
export function vecGeometry(o) {
  const geo = new THREE.BufferGeometry();
  const data = vecMeshData(o);
  if (!data) {
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geo.setIndex([]);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
  const verts = data.verts, faces = data.faces;
  const n = verts.length;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = verts[i][0]; pos[i * 3 + 1] = verts[i][1]; pos[i * 3 + 2] = verts[i][2];
  }
  const idx = [];
  for (const f of faces) {
    const a = f[0] | 0, b = f[1] | 0, c = f[2] | 0;
    if (a >= n || b >= n || c >= n) continue;
    if (a === b || b === c || a === c) continue;
    idx.push(a, b, c);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  if (idx.length) geo.computeVertexNormals();
  boxUV(geo, verts, faces, (o && o.scale) || [1, 1, 1]);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** 碰撞体形状推导：只有「无碰撞 / 精确网格」两种（形状不是方块，包围盒会严重失真） */
export function vecPhysicsShape(p) {
  return p.physicsMode === 'none' ? 'none' : 'trimesh';
}