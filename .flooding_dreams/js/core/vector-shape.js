/* ============================================================
   2D 矢量图形核心（矢量图编辑器 / 矢量挤出体 / 管道截面 共用）
   ------------------------------------------------------------
   · 文档模型：doc = { layers: [ { id, name, visible, locked, color, paths: [Path] } ] }
   · Path = 一条子路径；一个图层里放多条互不相交的 Path 即「非连续平面图形」
     Path = { id, closed, visible, fill, stroke, strokeWidth, opacity,
              nodes: [ { x, y, ix, iy, ox, oy } ] }
       ix/iy = 入控制柄（绝对坐标；缺省 = 直线），ox/oy = 出控制柄
   · 坐标系：数学系（Y 向上），与截面编辑器一致；
     导入 SVG（Y 向下）时自动翻转，导出时再翻回去（视觉一致）
   · 本模块不依赖 DOM / three，纯计算 + 字符串（parseSVG 用到 DOMParser）
   ============================================================ */

/* ============================================================
   模型构造
   ============================================================ */

let _seq = 0;
/** 生成短 id */
export function uid(prefix) {
  _seq += 1;
  return (prefix || 'v') + _seq.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

export const DEFAULT_FILL = '#7fe3ff';
export const DEFAULT_STROKE = 'none';

/** 新建一条路径 */
export function newPath(nodes, opts = {}) {
  return {
    id: opts.id || uid('p'),
    closed: opts.closed !== false,
    visible: opts.visible !== false,
    fill: opts.fill || DEFAULT_FILL,
    stroke: opts.stroke || DEFAULT_STROKE,
    strokeWidth: Number(opts.strokeWidth) || 0,
    opacity: opts.opacity === undefined ? 1 : Number(opts.opacity),
    nodes: (nodes || []).map((n) => {
      const c = { x: Number(n.x) || 0, y: Number(n.y) || 0 };
      if (n.ix !== undefined && n.ix !== null) { c.ix = Number(n.ix); c.iy = Number(n.iy); }
      if (n.ox !== undefined && n.ox !== null) { c.ox = Number(n.ox); c.oy = Number(n.oy); }
      return c;
    }),
  };
}

/** 新建图层 */
export function newLayer(name, color) {
  return {
    id: uid('l'),
    name: name || '图层',
    visible: true,
    locked: false,
    color: color || DEFAULT_FILL,
    paths: [],
  };
}

/** 新建空文档 */
export function newDoc() {
  const l = newLayer('图层 1');
  return { layers: [l] };
}

export function cloneNode(n) {
  const c = { x: n.x, y: n.y };
  if (n.ix !== undefined && n.ix !== null) { c.ix = n.ix; c.iy = n.iy; }
  if (n.ox !== undefined && n.ox !== null) { c.ox = n.ox; c.oy = n.oy; }
  return c;
}

export function clonePath(p) {
  return {
    id: p.id, closed: p.closed, visible: p.visible !== false,
    fill: p.fill, stroke: p.stroke, strokeWidth: p.strokeWidth || 0,
    opacity: p.opacity === undefined ? 1 : p.opacity,
    nodes: (p.nodes || []).map(cloneNode),
  };
}

export function cloneDoc(doc) {
  const d = doc && Array.isArray(doc.layers) ? doc : newDoc();
  return {
    layers: d.layers.map((l) => ({
      id: l.id, name: l.name, visible: l.visible !== false, locked: !!l.locked,
      color: l.color || DEFAULT_FILL,
      paths: (l.paths || []).map(clonePath),
    })),
  };
}

/** 文档里所有可见路径（带所属图层） */
export function docPaths(doc) {
  const out = [];
  const ls = (doc && doc.layers) || [];
  for (const l of ls) {
    if (l.visible === false) continue;
    for (const p of (l.paths || [])) if (p.visible !== false) out.push({ layer: l, path: p });
  }
  return out;
}

export function docHasContent(doc) {
  const ls = (doc && doc.layers) || [];
  for (const l of ls) for (const p of (l.paths || [])) if ((p.nodes || []).length >= 2) return true;
  return false;
}

/* ============================================================
   基础几何
   ============================================================ */

export function nodeIn(n) {
  return (n.ix === undefined || n.ix === null) ? [n.x, n.y] : [n.ix, n.iy];
}
export function nodeOut(n) {
  return (n.ox === undefined || n.ox === null) ? [n.x, n.y] : [n.ox, n.oy];
}
/** 该节点某侧的柄是否「真实存在」（与锚点重合视为直线） */
export function hasIn(n) { return (n.ix !== undefined && n.ix !== null) && (Math.abs(n.ix - n.x) > 1e-6 || Math.abs(n.iy - n.y) > 1e-6); }
export function hasOut(n) { return (n.ox !== undefined && n.ox !== null) && (Math.abs(n.ox - n.x) > 1e-6 || Math.abs(n.oy - n.y) > 1e-6); }

/** 第 i 段（i → i+1，闭合时最后一段回到 0）的控制点，返回 [p0, c1, c2, p3] 或 null */
export function segmentPoints(path, i) {
  const ns = path.nodes || [];
  const n = ns.length;
  if (n < 2) return null;
  const j = (i + 1) % n;
  if (!path.closed && i >= n - 1) return null;
  const a = ns[i], b = ns[j];
  const straight = !hasOut(a) && !hasIn(b);
  const c1 = nodeOut(a), c2 = nodeIn(b);
  return { p0: [a.x, a.y], c1, c2, p3: [b.x, b.y], straight, j };
}

export function cubicPoint(p0, c1, c2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1],
  ];
}

function distPtSeg2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t, qy = ay + dy * t;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

/** 自适应细分三次贝塞尔 → 折线（tol 为弦高容差） */
function flattenCubic(p0, c1, c2, p3, tol, out, depth) {
  if (depth > 16) { out.push([p3[0], p3[1]]); return; }
  const d = Math.max(
    distPtSeg2(c1[0], c1[1], p0[0], p0[1], p3[0], p3[1]),
    distPtSeg2(c2[0], c2[1], p0[0], p0[1], p3[0], p3[1]),
  );
  if (d <= tol * tol) { out.push([p3[0], p3[1]]); return; }
  // de Casteljau 在 t=0.5 处切分
  const m01 = [(p0[0] + c1[0]) / 2, (p0[1] + c1[1]) / 2];
  const m12 = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
  const m23 = [(c2[0] + p3[0]) / 2, (c2[1] + p3[1]) / 2];
  const m012 = [(m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2];
  const m123 = [(m12[0] + m23[0]) / 2, (m12[1] + m23[1]) / 2];
  const mid = [(m012[0] + m123[0]) / 2, (m012[1] + m123[1]) / 2];
  flattenCubic(p0, m01, m012, mid, tol, out, depth + 1);
  flattenCubic(mid, m123, m23, p3, tol, out, depth + 1);
}

const FLAT_TOL = 0.004;   // 单位空间弦高容差（约千分之四 stud）

/** 路径 → 折线 { pts, closed }；tol 为弦高容差（单位空间） */
export function flattenPath(path, tol) {
  const ns = (path && path.nodes) || [];
  const t = Number(tol) > 0 ? Number(tol) : FLAT_TOL;
  if (!ns.length) return { pts: [], closed: !!path.closed };
  if (ns.length === 1) return { pts: [[ns[0].x, ns[0].y]], closed: !!path.closed };
  const out = [[ns[0].x, ns[0].y]];
  const segs = path.closed ? ns.length : ns.length - 1;
  for (let i = 0; i < segs; i++) {
    const s = segmentPoints(path, i);
    if (!s) continue;
    if (s.straight) out.push([s.p3[0], s.p3[1]]);
    else flattenCubic(s.p0, s.c1, s.c2, s.p3, t, out, 0);
  }
  return { pts: out, closed: !!path.closed };
}

/** 文档 → 轮廓列表（编辑器 / 挤出体 / 管道截面 共用） */
export function docContours(doc, tol) {
  const out = [];
  for (const { path } of docPaths(doc)) {
    const f = flattenPath(path, tol);
    if (f.pts.length >= 2) out.push(f);
  }
  return out;
}

/** 纯折线轮廓 → 单图层文档 */
export function contoursToDoc(contours, opts = {}) {
  const layer = newLayer(opts.name || '图层 1', opts.color || DEFAULT_FILL);
  const list = contours || [];
  for (const c of list) {
    const pts = Array.isArray(c) && Array.isArray(c[0]) ? c : (c && c.pts) || [];
    if (pts.length < 2) continue;
    const closed = Array.isArray(c) ? true : (c.closed !== false);
    layer.paths.push(newPath(pts.map((p) => ({ x: p[0], y: p[1] })), {
      closed, fill: opts.fill || DEFAULT_FILL, stroke: opts.stroke || DEFAULT_STROKE,
    }));
  }
  return { layers: [layer] };
}

export function pathsBBox(paths, tol) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    const f = flattenPath(p, tol);
    for (const q of f.pts) {
      if (q[0] < minX) minX = q[0];
      if (q[1] < minY) minY = q[1];
      if (q[0] > maxX) maxX = q[0];
      if (q[1] > maxY) maxY = q[1];
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function contoursBBox(contours) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of (contours || [])) {
    const pts = Array.isArray(c) && Array.isArray(c[0]) ? c : (c && c.pts) || [];
    for (const q of pts) {
      if (q[0] < minX) minX = q[0];
      if (q[1] < minY) minY = q[1];
      if (q[0] > maxX) maxX = q[0];
      if (q[1] > maxY) maxY = q[1];
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** 多边形有向面积（>0 = 逆时针） */
export function polyArea(pts) {
  const n = (pts || []).length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function polyIsClockwise(pts) { return polyArea(pts) < 0; }

/** 射线法：点是否在多边形内 */
export function pointInPoly(pts, x, y) {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    const hit = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

/* ============================================================
   折角倒圆 / 倒角（fillet）
   ============================================================ */

/** 单位化 */
function unit(v) {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-9 ? [v[0] / l, v[1] / l] : [0, 0];
}
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * 折线折转处倒角/倒圆：把每个拐角替换成一段圆弧（贝塞尔）或一条直切边。
 * @param {object} path
 * @param {{radius?:number, profile?:'round'|'chamfer', weights?:number[],
 *          modulation?:{mode?:'none'|'wave', amp?:number, freq?:number, phase?:number}}} opts
 * @returns {object} 新 Path（不改原对象）
 */
export function filletPath(path, opts = {}) {
  const ns = path.nodes || [];
  const n = ns.length;
  const rBase = Math.max(0, Number(opts.radius) || 0);
  const profile = opts.profile === 'chamfer' ? 'chamfer' : 'round';
  const weights = Array.isArray(opts.weights) ? opts.weights : null;
  const mod = opts.modulation || null;
  const out = clonePath(path);
  if (n < 3 || rBase <= 1e-6) return out;

  const closed = path.closed !== false;
  const res = [];
  for (let i = 0; i < n; i++) {
    const corner = closed || (i > 0 && i < n - 1);
    const B = ns[i];
    if (!corner) { res.push(cloneNode(B)); continue; }
    const A = ns[(i - 1 + n) % n];
    const C = ns[(i + 1) % n];
    const u = unit([A.x - B.x, A.y - B.y]);
    const w = unit([C.x - B.x, C.y - B.y]);
    const dot = clampN(u[0] * w[0] + u[1] * w[1], -1, 1);
    const theta = Math.acos(dot);             // 拐角内角
    if (theta < 0.08 || theta > Math.PI - 0.08) { res.push(cloneNode(B)); continue; }
    let r = rBase;
    if (weights && isFinite(weights[i])) r *= Math.max(0, weights[i]);
    if (mod && mod.mode === 'wave') {
      const t = n > 1 ? i / n : 0;
      r *= 1 + (Number(mod.amp) || 0) * Math.sin(Math.PI * 2 * (Number(mod.freq) || 1) * t + (Number(mod.phase) || 0));
    }
    const lenBA = Math.hypot(A.x - B.x, A.y - B.y);
    const lenBC = Math.hypot(C.x - B.x, C.y - B.y);
    // 切点回退距离 d = r / tan(θ/2)，必须不超过相邻边长的一半（θ 尖锐时 d 远大于 r）
    const tanHalf = Math.tan(theta / 2);
    r = Math.min(r, 0.499 * lenBA * tanHalf, 0.499 * lenBC * tanHalf);
    if (r < 1e-5) { res.push(cloneNode(B)); continue; }
    const d = r / tanHalf;
    const P = [B.x + u[0] * d, B.y + u[1] * d];
    const Q = [B.x + w[0] * d, B.y + w[1] * d];
    if (profile === 'chamfer') {
      res.push({ x: P[0], y: P[1] });
      res.push({ x: Q[0], y: Q[1] });
      continue;
    }
    // 圆弧 → 三次贝塞尔近似
    const sweep = Math.PI - theta;                  // 圆心角
    const h = (4 / 3) * Math.tan(sweep / 4) * r;
    const bis = unit([u[0] + w[0], u[1] + w[1]]);   // 指向圆心
    const O = [B.x + bis[0] * (r / Math.sin(theta / 2)), B.y + bis[1] * (r / Math.sin(theta / 2))];
    const vP = [P[0] - O[0], P[1] - O[1]];
    const vQ = [Q[0] - O[0], Q[1] - O[1]];
    const ccw = (vP[0] * vQ[1] - vP[1] * vQ[0]) > 0;
    const tP = ccw ? [-vP[1], vP[0]] : [vP[1], -vP[0]];
    const tQ = ccw ? [-vQ[1], vQ[0]] : [vQ[1], -vQ[0]];
    const nP = { x: P[0], y: P[1], ox: P[0] + tP[0] * h, oy: P[1] + tP[1] * h };
    const nQ = { x: Q[0], y: Q[1], ix: Q[0] - tQ[0] * h, iy: Q[1] - tQ[1] * h };
    res.push(nP, nQ);
  }
  out.nodes = res;
  return out;
}

/** 折线 → 倒圆后的折线 */
export function filletPolyline(pts, opts = {}) {
  const p = newPath((pts || []).map((q) => ({ x: q[0], y: q[1] })), { closed: true });
  return flattenPath(filletPath(p, opts), opts.tol).pts;
}

/* ============================================================
   2x3 仿射矩阵 [a, b, c, d, e, f]：x' = a x + c y + e, y' = b x + d y + f
   ============================================================ */

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export function matTranslate(tx, ty) { return [1, 0, 0, 1, tx, ty]; }
export function matScale(sx, sy) { return [sx, 0, 0, sy, 0, 0]; }
export function matRotate(deg, cx = 0, cy = 0) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

/** 解析 SVG transform 属性 → 矩阵 */
export function parseTransform(str) {
  let m = IDENTITY.slice();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let hit;
  while ((hit = re.exec(String(str || '')))) {
    const name = hit[1].toLowerCase();
    const nums = (hit[2].match(/-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || []).map(Number);
    let t = IDENTITY.slice();
    if (name === 'matrix' && nums.length >= 6) t = nums.slice(0, 6);
    else if (name === 'translate') t = matTranslate(nums[0] || 0, nums[1] || 0);
    else if (name === 'scale') t = matScale(nums.length > 1 ? nums[0] : (nums[0] || 1), nums.length > 1 ? nums[1] : (nums[0] || 1));
    else if (name === 'rotate') t = matRotate(nums[0] || 0, nums[1] || 0, nums[2] || 0);
    else if (name === 'skewx') t = [1, 0, Math.tan((nums[0] || 0) * Math.PI / 180), 1, 0, 0];
    else if (name === 'skewy') t = [1, Math.tan((nums[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
    m = matMul(m, t);
  }
  return m;
}

/** 对整条路径施加仿射变换（含控制柄） */
export function transformPath(path, m) {
  const p = clonePath(path);
  const tp = (x, y) => matApply(m, x, y);
  p.nodes = p.nodes.map((n) => {
    const [x, y] = tp(n.x, n.y);
    const c = { x, y };
    if (hasIn(n)) { const [ix, iy] = tp(n.ix, n.iy); c.ix = ix; c.iy = iy; }
    if (hasOut(n)) { const [ox, oy] = tp(n.ox, n.oy); c.ox = ox; c.oy = oy; }
    return c;
  });
  return p;
}

/* ============================================================
   SVG path 数据解析（d 属性 → 子路径）
   ============================================================ */

/** 顺序扫描器：命令字母 + 数字；A 命令的两个 flag 单独按单字符读 */
function scanner(d) {
  let i = 0;
  const s = String(d || '');
  const isW = (c) => c === ' ' || c === ',' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  return {
    skipW() { while (i < s.length && isW(s[i])) i++; },
    eof() { this.skipW(); return i >= s.length; },
    peekCmd() { this.skipW(); return /[MmLlHhVvCcSsQqTtAaZz]/.test(s[i] || '') ? s[i] : ''; },
    cmd() { this.skipW(); const c = s[i]; if (/[MmLlHhVvCcSsQqTtAaZz]/.test(c || '')) { i++; return c; } return ''; },
    num() {
      this.skipW();
      const m = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(s.slice(i));
      if (!m) return NaN;
      i += m[0].length;
      return parseFloat(m[0]);
    },
    flag() { this.skipW(); const c = s[i]; if (c === '0' || c === '1') { i++; return c === '1' ? 1 : 0; } return NaN; },
  };
}

/** 单位弧 → 三次贝塞尔集合（SVG A 命令） */
function arcToCubics(x1, y1, rx, ry, phiDeg, large, sweep, x2, y2) {
  if (Math.abs(x1 - x2) < 1e-9 && Math.abs(y1 - y2) < 1e-9) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < 1e-9 || ry < 1e-9) return [[x1, y1, x2, y2, x2, y2]];   // 退化 → 直线
  const phi = phiDeg * Math.PI / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
  const sign = large !== sweep ? 1 : -1;
  let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / (den || 1e-12)));
  const cxp = co * (rx * y1p) / ry;
  const cyp = co * -(ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const d2 = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1e-12);
    const a = Math.acos(clampN(d2, -1, 1));
    return (ux * vy - uy * vx) < 0 ? -a : a;
  };
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= Math.PI * 2;
  else if (sweep && dth < 0) dth += Math.PI * 2;
  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
  const out = [];
  const k = (4 / 3) * Math.tan(Math.abs(dth) / (4 * segs));
  let t0 = th1;
  const pt = (t) => [
    cx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP,
    cy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP,
  ];
  const der = (t) => [
    -rx * Math.sin(t) * cosP - ry * Math.cos(t) * sinP,
    -rx * Math.sin(t) * sinP + ry * Math.cos(t) * cosP,
  ];
  for (let s = 0; s < segs; s++) {
    const t1 = t0 + dth / segs;
    const p0 = pt(t0), p3 = pt(t1);
    const d0 = der(t0), d1 = der(t1);
    const sgn = dth >= 0 ? 1 : -1;
    const c1 = [p0[0] + sgn * k * d0[0], p0[1] + sgn * k * d0[1]];
    const c2 = [p3[0] - sgn * k * d1[0], p3[1] - sgn * k * d1[1]];
    out.push([p0[0], p0[1], c1[0], c1[1], c2[0], c2[1], p3[0], p3[1]]);
    t0 = t1;
  }
  return out;
}

/**
 * 解析 d 属性 → [{ nodes, closed }]
 * 支持 M m L l H h V v C c S s Q q T t A a Z z（含隐式重复）
 */
export function parsePathData(d) {
  const sc = scanner(d);
  const subs = [];
  let cur = null;               // { nodes, closed }
  let cx = 0, cy = 0;           // 当前点
  let sx = 0, sy = 0;           // 子路径起点
  let lastC = null;             // 上一个三次控制点（S）
  let lastQ = null;             // 上一个二次控制点（T）

  const start = (x, y) => { cur = { nodes: [{ x, y }], closed: false }; subs.push(cur); cx = x; cy = y; sx = x; sy = y; };
  const line = (x, y) => { if (!cur) start(x, y); else { cur.nodes.push({ x, y }); cx = x; cy = y; } };
  const curve = (c1x, c1y, c2x, c2y, x, y) => {
    if (!cur) start(cx, cy);
    const last = cur.nodes[cur.nodes.length - 1];
    last.ox = c1x; last.oy = c1y;
    cur.nodes.push({ x, y, ix: c2x, iy: c2y });
    cx = x; cy = y;
  };
  const close = () => {
    if (!cur) return;
    cur.closed = true;
    const f = cur.nodes[0], l = cur.nodes[cur.nodes.length - 1];
    if (cur.nodes.length > 1 && Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) cur.nodes.pop();
    cx = f.x; cy = f.y;
  };

  while (!sc.eof()) {
    let cmd = sc.cmd();
    if (!cmd) break;
    let rel = cmd >= 'a' && cmd <= 'z';
    const C = cmd.toUpperCase();
    if (C === 'M') {
      let first = true;
      do {
        let x = sc.num(), y = sc.num();
        if (isNaN(x) || isNaN(y)) break;
        if (rel) { x += cx; y += cy; }
        if (first) { start(x, y); first = false; } else line(x, y);
      } while (!sc.eof() && sc.peekCmd() === '');
    } else if (C === 'L') {
      do {
        let x = sc.num(), y = sc.num();
        if (isNaN(x) || isNaN(y)) break;
        if (rel) { x += cx; y += cy; }
        line(x, y);
      } while (!sc.eof() && sc.peekCmd() === '');
    } else if (C === 'H') {
      do {
        let x = sc.num();
        if (isNaN(x)) break;
        if (rel) x += cx;
        line(x, cy);
      } while (!sc.eof() && sc.peekCmd() === '');
    } else if (C === 'V') {
      do {
        let y = sc.num();
        if (isNaN(y)) break;
        if (rel) y += cy;
        line(cx, y);
      } while (!sc.eof() && sc.peekCmd() === '');
    } else if (C === 'C') {
      do {
        const a = sc.num(), b = sc.num(), c = sc.num(), dd = sc.num(), e = sc.num(), f = sc.num();
        if ([a, b, c, dd, e, f].some(isNaN)) break;
        const x = rel ? e + cx : e, y = rel ? f + cy : f;
        const c1x = rel ? a + cx : a, c1y = rel ? b + cy : b;
        const c2x = rel ? c + cx : c, c2y = rel ? dd + cy : dd;
        curve(c1x, c1y, c2x, c2y, x, y);
        lastC = [c2x, c2y];
      } while (!sc.eof() && sc.peekCmd() === '');
    } else if (C === 'S') {
      do {
        const c = sc.num(), dd = sc.num(), e = sc.num(), f = sc.num();
        if ([c, dd, e, f].some(isNaN)) break;
        const x = rel ? e + cx : e, y = rel ? f + cy : f;
        const c2x = rel ? c + cx : c, c2y = rel ? dd + cy : dd;
        const c1x = lastC ? 2 * cx - lastC[0] : cx;
        const c1y = lastC ? 2 * cy - lastC[1] : cy;
        curve(c1x, c1y, c2x, c2y, x, y);
        lastC = [c2x, c2y];
      } while (!sc.eof() && sc.peekCmd() === '');
    } else if (C === 'Q') {
      do {
        const a = sc.num(), b = sc.num(), e = sc.num(), f = sc.num();
        if ([a, b, e, f].some(isNaN)) break;
        const x = rel ? e + cx : e, y = rel ? f + cy : f;
        const qx = rel ? a + cx : a, qy = rel ? b + cy : b;
        const c1x = cx + 2 / 3 * (qx - cx), c1y = cy + 2 / 3 * (qy - cy);
        const c2x = x + 2 / 3 * (qx - x), c2y = y + 2 / 3 * (qy - y);
        curve(c1x, c1y, c2x, c2y, x, y);
        lastQ = [qx, qy];
      } while (!sc.eof() && sc.peekCmd() === '');
    } else if (C === 'T') {
      do {
        const e = sc.num(), f = sc.num();
        if ([e, f].some(isNaN)) break;
        const x = rel ? e + cx : e, y = rel ? f + cy : f;
        const qx = lastQ ? 2 * cx - lastQ[0] : cx;
        const qy = lastQ ? 2 * cy - lastQ[1] : cy;
        const c1x = cx + 2 / 3 * (qx - cx), c1y = cy + 2 / 3 * (qy - cy);
        const c2x = x + 2 / 3 * (qx - x), c2y = y + 2 / 3 * (qy - y);
        curve(c1x, c1y, c2x, c2y, x, y);
        lastQ = [qx, qy];
      } while (!sc.eof() && sc.peekCmd() === '');
    } else if (C === 'A') {
      do {
        const rx = sc.num(), ry = sc.num(), rot = sc.num();
        const laf = sc.flag(), sf = sc.flag();
        const e = sc.num(), f = sc.num();
        if ([rx, ry, rot, laf, sf, e, f].some((v) => typeof v !== 'number' || isNaN(v))) break;
        const x = rel ? e + cx : e, y = rel ? f + cy : f;
        const cubics = arcToCubics(cx, cy, rx, ry, rot, laf, sf, x, y);
        for (const cu of cubics) {
          if (cu[2] === cu[6] && cu[3] === cu[7] && cu[0] === cu[2]) { line(cu[6], cu[7]); continue; }
          curve(cu[2], cu[3], cu[4], cu[5], cu[6], cu[7]);
        }
      } while (!sc.eof() && sc.peekCmd() === '');
    } else if (C === 'Z') {
      close();
      if (cur) { /* 后续命令从起点继续 */ }
    }
    lastC = (C === 'C' || C === 'S') ? lastC : null;
    lastQ = (C === 'Q' || C === 'T') ? lastQ : null;
  }
  return subs.filter((s) => s.nodes.length >= 2);
}

/* ============================================================
   SVG 解析（DOM）
   ============================================================ */

/** 圆 / 椭圆 → 贝塞尔（kappa 近似） */
function ellipseNodes(cx, cy, rx, ry) {
  const k = 0.5522847498;
  const ox = rx * k, oy = ry * k;
  return [
    { x: cx, y: cy - ry, ox: cx + ox, oy: cy - ry, ix: cx - ox, iy: cy - ry },
    { x: cx + rx, y: cy, ox: cx + rx, oy: cy + oy, ix: cx + rx, iy: cy - oy },
    { x: cx, y: cy + ry, ox: cx - ox, oy: cy + ry, ix: cx + ox, iy: cy + ry },
    { x: cx - rx, y: cy, ox: cx - rx, oy: cy - oy, ix: cx - rx, iy: cy + oy },
  ];
}

function numAttr(el, name, dflt) {
  const v = parseFloat(el.getAttribute(name));
  return isFinite(v) ? v : dflt;
}

/** 解析元素上的填充 / 描边样式（属性 + 内联 style 合并） */
function styleOf(el) {
  const s = {};
  const style = el.getAttribute('style') || '';
  for (const part of style.split(';')) {
    const i = part.indexOf(':');
    if (i > 0) s[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  const get = (k) => {
    const v = el.getAttribute(k);
    return v !== null ? v.trim() : (s[k] !== undefined ? s[k] : undefined);
  };
  return {
    fill: get('fill'),
    stroke: get('stroke'),
    strokeWidth: parseFloat(get('stroke-width')),
    opacity: parseFloat(get('opacity')),
  };
}

function nodesToPath(nodes, closed, el, fallbackFill) {
  const st = styleOf(el);
  const fill = (st.fill === undefined || st.fill === '' ) ? fallbackFill : st.fill;
  return newPath(nodes, {
    closed,
    fill: !fill || fill === 'none' ? 'none' : fill,
    stroke: !st.stroke || st.stroke === 'none' ? 'none' : st.stroke,
    strokeWidth: isFinite(st.strokeWidth) ? st.strokeWidth : 0,
    opacity: isFinite(st.opacity) ? st.opacity : 1,
  });
}

/** 递归遍历 SVG 元素，累积变换矩阵 */
function walkSVG(el, m, out, fill) {
  const tag = (el.tagName || '').toLowerCase().replace(/^svg:/, '');
  const local = matMul(m, parseTransform(el.getAttribute('transform')));
  const push = (nodes, closed) => {
    const p = nodesToPath(nodes, closed, el, fill);
    out.push(transformPath(p, matMul(flipMatrix, local)));
  };

  if (tag === 'path') {
    const subs = parsePathData(el.getAttribute('d') || '');
    for (const s of subs) {
      const p = nodesToPath(s.nodes, s.closed, el, fill);
      out.push(transformPath(p, matMul(flipMatrix, local)));
    }
    return;
  }
  if (tag === 'rect') {
    const x = numAttr(el, 'x', 0), y = numAttr(el, 'y', 0);
    const w = numAttr(el, 'width', 0), h = numAttr(el, 'height', 0);
    if (w > 0 && h > 0) push([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], true);
    return;
  }
  if (tag === 'circle') {
    const r = numAttr(el, 'r', 0);
    if (r > 0) push(ellipseNodes(numAttr(el, 'cx', 0), numAttr(el, 'cy', 0), r, r), true);
    return;
  }
  if (tag === 'ellipse') {
    const rx = numAttr(el, 'rx', 0), ry = numAttr(el, 'ry', 0);
    if (rx > 0 && ry > 0) push(ellipseNodes(numAttr(el, 'cx', 0), numAttr(el, 'cy', 0), rx, ry), true);
    return;
  }
  if (tag === 'line') {
    push([{ x: numAttr(el, 'x1', 0), y: numAttr(el, 'y1', 0) }, { x: numAttr(el, 'x2', 0), y: numAttr(el, 'y2', 0) }], false);
    return;
  }
  if (tag === 'polyline' || tag === 'polygon') {
    const nums = (el.getAttribute('points') || '').match(/-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    const nodes = [];
    for (let i = 0; i + 1 < nums.length; i += 2) nodes.push({ x: +nums[i], y: +nums[i + 1] });
    if (nodes.length >= 2) push(nodes, tag === 'polygon');
    return;
  }
  if (tag === 'defs' || tag === 'clippath' || tag === 'mask' || tag === 'style' || tag === 'title' || tag === 'desc') return;
  // 容器：继承 fill
  let childFill = fill;
  const own = styleOf(el).fill;
  if (own && own !== 'none' && own !== 'inherit') childFill = own;
  for (const c of el.children) walkSVG(c, local, out, childFill);
}

// 导入时把 SVG 的 Y 向下翻成我们的 Y 向上
let flipMatrix = [1, 0, 0, -1, 0, 0];

/**
 * 解析 SVG 文本 → { paths, width, height, viewBox }
 * @param {string} text
 * @param {{flipY?:boolean}} opts
 */
export function parseSVG(text, opts = {}) {
  const doc = new DOMParser().parseFromString(String(text || ''), 'image/svg+xml');
  const bad = doc.querySelector('parsererror');
  const root = doc.documentElement;
  if (bad || !root || (root.tagName || '').toLowerCase().replace(/^svg:/, '') !== 'svg') {
    return { paths: [], width: 0, height: 0, viewBox: null };
  }
  flipMatrix = opts.flipY === false ? IDENTITY.slice() : [1, 0, 0, -1, 0, 0];
  const out = [];
  for (const c of root.children) walkSVG(c, IDENTITY.slice(), out, null);
  const vbAttr = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const vb = vbAttr.length === 4 && vbAttr.every((v) => isFinite(v)) ? vbAttr : null;
  const w = vb ? vb[2] : numAttr(root, 'width', 0);
  const h = vb ? vb[3] : numAttr(root, 'height', 0);
  return { paths: out, width: w, height: h, viewBox: vb };
}

/* ============================================================
   SVG 序列化
   ============================================================ */

const fmt = (v) => {
  const r = Math.round(v * 10000) / 10000;
  return String(r);
};

/** 单条路径 → d 属性字符串 */
export function pathToD(path) {
  const ns = path.nodes || [];
  if (!ns.length) return '';
  let d = 'M' + fmt(ns[0].x) + ' ' + fmt(ns[0].y);
  const segs = path.closed ? ns.length : ns.length - 1;
  const n = ns.length;
  for (let i = 0; i < segs; i++) {
    const s = segmentPoints(path, i);
    if (!s) continue;
    const isClosing = path.closed && s.j === 0;
    if (s.straight) {
      if (isClosing) continue;                 // Z 会补上这条直线
      d += 'L' + fmt(s.p3[0]) + ' ' + fmt(s.p3[1]);
    } else {
      d += 'C' + fmt(s.c1[0]) + ' ' + fmt(s.c1[1]) + ' ' + fmt(s.c2[0]) + ' ' + fmt(s.c2[1])
        + ' ' + fmt(s.p3[0]) + ' ' + fmt(s.p3[1]);
    }
  }
  if (path.closed) d += 'Z';
  return d;
}

/**
 * 文档 → SVG 字符串（导出用；Y 翻回向下，视觉与编辑器一致）
 * @param {object} doc
 * @param {{padding?:number, background?:string, precision?:number}} opts
 */
export function docToSVG(doc, opts = {}) {
  const paths = docPaths(doc).map((x) => x.path);
  const bb = pathsBBox(paths);
  const pad = Number(opts.padding) || 0;
  const minX = bb.minX - pad, minY = bb.minY - pad;
  const w = Math.max(1, bb.w + pad * 2), h = Math.max(1, bb.h + pad * 2);
  const flipY = bb.minY + bb.maxY;   // y' = -y + flipY → 内容仍落在 [bb.minY, bb.maxY] 内
  const body = [];
  body.push('<g transform="translate(0 ' + fmt(flipY) + ') scale(1 -1)" fill-rule="evenodd">');
  for (const { path } of docPaths(doc)) {
    const d = pathToD(path);
    if (!d) continue;
    const attrs = ['d="' + d + '"'];
    attrs.push('fill="' + (path.fill && path.fill !== 'none' ? esc(path.fill) : 'none') + '"');
    if (path.stroke && path.stroke !== 'none') {
      attrs.push('stroke="' + esc(path.stroke) + '"');
      attrs.push('stroke-width="' + fmt(path.strokeWidth || 1) + '"');
      attrs.push('stroke-linejoin="round"');
    }
    const op = path.opacity === undefined ? 1 : path.opacity;
    if (op < 1) attrs.push('opacity="' + fmt(op) + '"');
    body.push('<path ' + attrs.join(' ') + '/>');
  }
  body.push('</g>');
  const bg = opts.background ? '<rect x="' + fmt(minX) + '" y="' + fmt(minY) + '" width="' + fmt(w) + '" height="' + fmt(h) + '" fill="' + esc(opts.background) + '"/>' : '';
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + fmt(minX) + ' ' + fmt(minY) + ' ' + fmt(w) + ' ' + fmt(h)
    + '" width="' + fmt(w) + '" height="' + fmt(h) + '">\n'
    + bg + body.join('\n') + '\n</svg>\n';
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }