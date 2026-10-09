/* ============================================================
   SDF 体素内核（建模工具的「第二内核」）
   - 和 poly-mesh.js 的网格内核分工：网格内核管点 / 边 / 面、倒角、拉点；
     凡是「拓扑会变」的操作（布尔 / 平滑融合 / 体素雕刻 / 曲线围岛）都走这里
   - 场是均匀网格上的有符号距离，**窄带饱和**：
     只有离表面 band 以内的采样点是精确距离，远处一律钉在 ±band。
     因为 Surface Nets 只关心零等值面，而 min / max / 平滑 min 在零面附近
     完全精确，所以饱和既省时间又不影响结果。
   - 进出都走 verts / faces，和低模建模体是同一份数据，撤销快照照样复用
   ============================================================ */
import * as THREE from 'three';

/** 反提取时的面数上限（和 poly-mesh 的 MAX_POLY_FACES 保持一致） */
export const SDF_MAX_FACES = 20000;

/* ============================================================
   场的基本操作
   ============================================================ */

/**
 * 造一个覆盖 [min, max] 的场。
 * @param {number[]} min 世界空间包围盒下角
 * @param {number[]} max 世界空间包围盒上角
 * @param {number} res   最长边上的格数（6~96）
 * @param {number} pad   包围盒外扩比例，给「往外加料」留余量
 * @param {object} [opts] { minAxisCells, maxCells, minStep }
 *   自适应关键：原来 step 只按「最长边 / res」算，扁平地形（如 64×4×64）的薄轴
 *   只分到 1~2 格 → 体素化后薄特征被抹平、模型看起来「损坏」。
 *   现在保证最薄的一维至少有 minAxisCells 格；同时用 maxCells 给体素总量封顶，
 *   再用 minStep 给面数预算兜底（调用方按表面积传入），三者共同决定最终 step。
 */
export function makeField(min, max, res = 24, pad = 0.12, opts = {}) {
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  let ext = Math.max(size[0], size[1], size[2]);
  if (!(ext > 1e-4)) ext = 1;
  const p = ext * Math.max(0, pad);
  const lo = [min[0] - p, min[1] - p, min[2] - p];
  const hi = [max[0] + p, max[1] + p, max[2] + p];
  const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const big = Math.max(span[0], span[1], span[2], 1e-4);
  let step = big / Math.max(6, Math.min(96, Math.round(res) || 24));

  // ① 薄轴保底：最薄的一维也要分到足够格数，别把薄地形抹平（默认关闭，避免影响其他调用方）
  const minCells = Math.max(0, opts.minAxisCells || 0);
  if (minCells > 0) {
    let thin = Infinity;
    for (const s of size) if (s > ext * 1e-3 && s < thin) thin = s;
    if (Number.isFinite(thin)) step = Math.min(step, thin / minCells);
  }
  // ② 面数预算兜底：调用方按表面积算出的最小步长（避免细化后撞建模面数上限）
  if (opts.minStep > 0) step = Math.max(step, opts.minStep);

  // ③ 体素总量封顶：超了就整体放大步长（宁可粗一点也不能卡死 / 爆内存）；0 = 不限制
  const CAP = opts.maxCells || 0;
  let nx = Math.max(3, Math.ceil(span[0] / step) + 1);
  let ny = Math.max(3, Math.ceil(span[1] / step) + 1);
  let nz = Math.max(3, Math.ceil(span[2] / step) + 1);
  for (let guard = 0; CAP > 0 && guard < 24 && nx * ny * nz > CAP; guard++) {
    step *= Math.cbrt((nx * ny * nz) / CAP) * 1.001;
    nx = Math.max(3, Math.ceil(span[0] / step) + 1);
    ny = Math.max(3, Math.ceil(span[1] / step) + 1);
    nz = Math.max(3, Math.ceil(span[2] / step) + 1);
  }
  const band = step * 2.5;
  const data = new Float32Array(nx * ny * nz);
  data.fill(band);
  return {
    nx, ny, nz, step, band,
    ox: lo[0], oy: lo[1], oz: lo[2],
    data,
  };
}

export function fieldClamp(f) {
  const b = f.band, d = f.data;
  for (let i = 0; i < d.length; i++) {
    if (d[i] > b) d[i] = b; else if (d[i] < -b) d[i] = -b;
  }
  return f;
}

export function fieldFill(f, v) { f.data.fill(v); return f; }

export function fieldAt(f, i, j, k) {
  if (i < 0 || j < 0 || k < 0 || i >= f.nx || j >= f.ny || k >= f.nz) return f.band;
  return f.data[(k * f.ny + j) * f.nx + i];
}

/** 场在世界空间的包围盒 */
export function fieldBox(f) {
  return {
    min: [f.ox, f.oy, f.oz],
    max: [f.ox + (f.nx - 1) * f.step, f.oy + (f.ny - 1) * f.step, f.oz + (f.nz - 1) * f.step],
  };
}

/* ---------- 平滑 min / max（IQ 多项式，k = 融合半径） ---------- */
export function smin(a, b, k) {
  if (!(k > 1e-6)) return a < b ? a : b;
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}
export function smax(a, b, k) { return -smin(-a, -b, k); }

/* ---------- 两场合并（就地写进 dst） ---------- */
export function fieldUnionInto(dst, src) {
  const a = dst.data, b = src.data;
  for (let i = 0; i < a.length; i++) if (b[i] < a[i]) a[i] = b[i];
  return dst;
}
export function fieldSmoothUnionInto(dst, src, k) {
  const a = dst.data, b = src.data;
  const kk = Math.max(0, k);
  if (!(kk > 1e-6)) return fieldUnionInto(dst, src);
  for (let i = 0; i < a.length; i++) a[i] = smin(a[i], b[i], kk);
  return fieldClamp(dst);
}
/** dst = dst 减去 src（挖洞） */
export function fieldSubtract(dst, src) {
  const a = dst.data, b = src.data;
  for (let i = 0; i < a.length; i++) { const v = -b[i]; if (v > a[i]) a[i] = v; }
  return dst;
}
export function fieldSmoothSubtract(dst, src, k) {
  const a = dst.data, b = src.data;
  const kk = Math.max(0, k);
  if (!(kk > 1e-6)) return fieldSubtract(dst, src);
  for (let i = 0; i < a.length; i++) a[i] = smax(a[i], -b[i], kk);
  return fieldClamp(dst);
}
/** 只保留两场的交集 */
export function fieldIntersect(dst, src) {
  const a = dst.data, b = src.data;
  for (let i = 0; i < a.length; i++) { const v = b[i]; if (v > a[i]) a[i] = v; }
  return dst;
}
export function fieldSmoothIntersect(dst, src, k) {
  const a = dst.data, b = src.data;
  const kk = Math.max(0, k);
  if (!(kk > 1e-6)) return fieldIntersect(dst, src);
  for (let i = 0; i < a.length; i++) a[i] = smax(a[i], b[i], kk);
  return fieldClamp(dst);
}
export function cloneField(f) {
  return {
    nx: f.nx, ny: f.ny, nz: f.nz, step: f.step, band: f.band,
    ox: f.ox, oy: f.oy, oz: f.oz, data: new Float32Array(f.data),
  };
}

/* ============================================================
   把三角网格「栅格化」进场
   - 距离：窄带做法 —— 按三角形的主轴投影取二维足迹，再沿法向扫 band 厚度，
     只算足迹范围内的格点，成本 ≈ 三角形面积而不是包围盒体积
   - 符号：沿 +X 打射线数穿越次数（奇 = 内），逐 (y,z) 行批量做，
     和距离无关，所以远处饱和也不影响内外判定
   ============================================================ */

/** 点到三角形的最短距离平方（Ericson 最近点算法，全标量，零分配） */
function pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bpx + w * (cx - bx), qy = bpy + w * (cy - by), qz = bpz + w * (cz - bz);
    return qx * qx + qy * qy + qz * qz;
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  const qx = apx - (v * abx + w * acx), qy = apy - (v * aby + w * acy), qz = apz - (v * abz + w * acz);
  return qx * qx + qy * qy + qz * qz;
}

const _m4 = new THREE.Matrix4();
const _vv = new THREE.Vector3();

/**
 * 把一个网格栅格化进场（覆盖式：调用后 f 里就是该网格的 SDF）。
 * @param {object} f      makeField 造的场
 * @param {Array}  verts  顶点表（局部坐标）
 * @param {Array}  faces  三角面表
 * @param {THREE.Matrix4} matrix 顶点 → 场空间的变换（通常是 mesh.matrixWorld）
 */
export function fieldRasterizeMesh(f, verts, faces, matrix) {
  const n = verts.length;
  const { nx, ny, nz, step, band, data } = f;
  const ox = f.ox, oy = f.oy, oz = f.oz;
  data.fill(band);
  if (!n || !faces || !faces.length) return f;

  // 顶点搬到场空间
  const wp = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    _vv.set(v[0], v[1], v[2]);
    if (matrix) _vv.applyMatrix4(matrix);
    wp[i * 3] = _vv.x; wp[i * 3 + 1] = _vv.y; wp[i * 3 + 2] = _vv.z;
  }

  /* ---------- 1. 窄带无符号距离 ---------- */
  for (let ti = 0; ti < faces.length; ti++) {
    const fc = faces[ti];
    const ia = (fc[0] | 0) * 3, ib = (fc[1] | 0) * 3, ic = (fc[2] | 0) * 3;
    if (ia >= n * 3 || ib >= n * 3 || ic >= n * 3) continue;
    const ax = wp[ia], ay = wp[ia + 1], az = wp[ia + 2];
    const bx = wp[ib], by = wp[ib + 1], bz = wp[ib + 2];
    const cx = wp[ic], cy = wp[ic + 1], cz = wp[ic + 2];

    // 面法线 → 主轴：沿主轴投影后按平面方程补第三个坐标
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nX = e1y * e2z - e1z * e2y;
    let nY = e1z * e2x - e1x * e2z;
    let nZ = e1x * e2y - e1y * e2x;
    const aX = Math.abs(nX), aY = Math.abs(nY), aZ = Math.abs(nZ);
    let axis = 0;
    if (aY >= aX && aY >= aZ) axis = 1;
    else if (aZ >= aX && aZ >= aY) axis = 2;
    const nLen = Math.hypot(nX, nY, nZ);
    if (!(nLen > 1e-12)) continue;   // 退化三角形
    nX /= nLen; nY /= nLen; nZ /= nLen;
    const nMain = axis === 0 ? nX : axis === 1 ? nY : nZ;
    if (Math.abs(nMain) < 1e-6) continue;

    const u0 = axis === 0 ? ay : ax;             // 第一投影轴坐标
    const u1 = axis === 0 ? by : bx;
    const u2 = axis === 0 ? cy : cx;
    const v0 = axis === 2 ? ay : az;             // 第二投影轴坐标
    const v1 = axis === 2 ? by : bz;
    const v2 = axis === 2 ? cy : cz;
    const wA = axis === 0 ? ax : axis === 1 ? ay : az;   // 主轴坐标（平面上的已知点）

    const uMin = Math.min(u0, u1, u2) - band, uMax = Math.max(u0, u1, u2) + band;
    const vMin = Math.min(v0, v1, v2) - band, vMax = Math.max(v0, v1, v2) + band;

    // 主轴按最小角（保证与 u/v 的轴序一致）
    const oMain = axis === 0 ? ox : axis === 1 ? oy : oz;
    const oU = axis === 0 ? oy : ox;
    const oV = axis === 2 ? oy : oz;
    const nU = axis === 0 ? ny : nx;
    const nV = axis === 2 ? ny : nz;

    const iu0 = Math.max(0, Math.floor((uMin - oU) / step));
    const iu1 = Math.min(nU - 1, Math.ceil((uMax - oU) / step));
    const iv0 = Math.max(0, Math.floor((vMin - oV) / step));
    const iv1 = Math.min(nV - 1, Math.ceil((vMax - oV) / step));
    const wSlab = band / Math.abs(nMain);

    for (let iv = iv0; iv <= iv1; iv++) {
      const pv = oV + iv * step;
      for (let iu = iu0; iu <= iu1; iu++) {
        const pu = oU + iu * step;
        // 平面方程求主轴坐标：n·(p - a) = 0
        const dU = pu - (axis === 0 ? ay : ax);
        const dV = pv - (axis === 2 ? ay : az);
        const nUc = axis === 0 ? nY : nX;
        const nVc = axis === 2 ? nY : nZ;
        const pw = wA - (nUc * dU + nVc * dV) / nMain;
        if (!Number.isFinite(pw)) continue;
        const iw0 = Math.max(0, Math.floor((pw - wSlab - oMain) / step));
        const iw1 = Math.min((axis === 0 ? nx : axis === 1 ? ny : nz) - 1,
          Math.ceil((pw + wSlab - oMain) / step));
        for (let iw = iw0; iw <= iw1; iw++) {
          const pMain = oMain + iw * step;
          let gx, gy, gz;
          if (axis === 0) { gx = pMain; gy = pu; gz = pv; }
          else if (axis === 1) { gx = pu; gy = pMain; gz = pv; }
          else { gx = pu; gy = pv; gz = pMain; }
          const d2 = pointTriDist2(gx, gy, gz, ax, ay, az, bx, by, bz, cx, cy, cz);
          const d = Math.sqrt(d2);
          if (d >= band) continue;
          const ii = axis === 0 ? iw : iu;
          const jj = axis === 1 ? iw : (axis === 0 ? iu : iv);
          const kk = axis === 2 ? iw : iv;
          const at = (kk * ny + jj) * nx + ii;
          if (d < data[at]) data[at] = d;
        }
      }
    }
  }

  /* ---------- 2. 符号：沿 +X 奇数穿越 = 内部 ---------- */
  const rows = new Array(ny * nz);
  const jx = step * 1e-4, kx = step * 1.7e-4;   // 极小的抖动，躲开「格点正好压在棱上」的退化
  const pushRow = (j, k, x) => {
    const r = k * ny + j;
    let arr = rows[r];
    if (!arr) { arr = []; rows[r] = arr; }
    arr.push(x);
  };
  for (let ti = 0; ti < faces.length; ti++) {
    const fc = faces[ti];
    const ia = (fc[0] | 0) * 3, ib = (fc[1] | 0) * 3, ic = (fc[2] | 0) * 3;
    if (ia >= n * 3 || ib >= n * 3 || ic >= n * 3) continue;
    const ax = wp[ia], ay = wp[ia + 1], az = wp[ia + 2];
    const bx = wp[ib], by = wp[ib + 1], bz = wp[ib + 2];
    const cx = wp[ic], cy = wp[ic + 1], cz = wp[ic + 2];

    const yMin = Math.min(ay, by, cy), yMax = Math.max(ay, by, cy);
    const zMin = Math.min(az, bz, cz), zMax = Math.max(az, bz, cz);
    const j0 = Math.max(0, Math.ceil((yMin - oy) / step));
    const j1 = Math.min(ny - 1, Math.floor((yMax - oy) / step));
    const k0 = Math.max(0, Math.ceil((zMin - oz) / step));
    const k1 = Math.min(nz - 1, Math.floor((zMax - oz) / step));
    if (j0 > j1 || k0 > k1) continue;

    // (y,z) 平面内的重心坐标（等价于沿 X 射线是否穿过三角形）
    const d = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    if (Math.abs(d) < 1e-12) continue;   // 该三角形在 X 方向是「侧着」的，不参与穿越
    const inv = 1 / d;
    for (let k = k0; k <= k1; k++) {
      const pz = oz + k * step + kx;
      for (let j = j0; j <= j1; j++) {
        const py = oy + j * step + jx;
        const w1 = ((py - ay) * (cz - az) - (pz - az) * (cy - ay)) * inv;
        if (w1 < 0 || w1 > 1) continue;
        const w2 = ((by - ay) * (pz - az) - (bz - az) * (py - ay)) * inv;
        if (w2 < 0 || w1 + w2 > 1) continue;
        pushRow(j, k, ax + w1 * (bx - ax) + w2 * (cx - ax));
      }
    }
  }
  const bnd = f.band;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const arr = rows[k * ny + j];
      const base = (k * ny + j) * nx;
      if (!arr || !arr.length) continue;
      arr.sort((p, q) => p - q);
      let ptr = 0, inside = false;
      for (let i = 0; i < nx; i++) {
        const x = ox + i * step;
        while (ptr < arr.length && arr[ptr] <= x) { ptr++; inside = !inside; }
        const idx = base + i;
        const dist = data[idx];
        if (inside) data[idx] = -Math.min(dist, bnd);
      }
    }
  }
  return f;
}

/* ============================================================
   解析图元：直接往场里刷，不需要先造网格
   ============================================================ */

/**
 * 球笔刷。加料用 smin、挖除用 smax，融合半径 k 让新料和旧面之间是软的过渡，
 * 这正是「地形体素平滑」的手感来源 —— 一笔下去会自然鼓包 / 塌陷，不会留硬棱。
 * @param {number} sign +1 加料 / -1 挖除
 */
export function fieldBrushSphere(f, cx, cy, cz, r, sign = 1, k = 0) {
  const { nx, ny, nz, step, band, data } = f;
  const reach = r + Math.max(k, 0) + band;
  const i0 = Math.max(0, Math.floor((cx - reach - f.ox) / step));
  const i1 = Math.min(nx - 1, Math.ceil((cx + reach - f.ox) / step));
  const j0 = Math.max(0, Math.floor((cy - reach - f.oy) / step));
  const j1 = Math.min(ny - 1, Math.ceil((cy + reach - f.oy) / step));
  const k0 = Math.max(0, Math.floor((cz - reach - f.oz) / step));
  const k1 = Math.min(nz - 1, Math.ceil((cz + reach - f.oz) / step));
  const rr = Math.max(1e-4, r);
  const kk = Math.max(0, k);
  for (let kk2 = k0; kk2 <= k1; kk2++) {
    const pz = f.oz + kk2 * step;
    for (let j = j0; j <= j1; j++) {
      const py = f.oy + j * step;
      const dy2 = (py - cy) * (py - cy);
      const row = (kk2 * ny + j) * nx;
      for (let i = i0; i <= i1; i++) {
        const px = f.ox + i * step;
        const d = Math.sqrt((px - cx) * (px - cx) + dy2 + (pz - cz) * (pz - cz)) - rr;
        if (d > band + kk) continue;
        const at = row + i;
        data[at] = sign >= 0 ? smin(data[at], d, kk) : smax(data[at], -d, kk);
      }
    }
  }
  return fieldClamp(f);
}

/** 体素平滑：把球内的场值向邻域平均推，等效于「低通滤波掉地形上的坑洼与硬棱」 */
export function fieldBrushSmooth(f, cx, cy, cz, r, strength = 0.5, iterations = 1) {
  const { nx, ny, nz, step, data } = f;
  const i0 = Math.max(1, Math.floor((cx - r - f.ox) / step));
  const i1 = Math.min(nx - 2, Math.ceil((cx + r - f.ox) / step));
  const j0 = Math.max(1, Math.floor((cy - r - f.oy) / step));
  const j1 = Math.min(ny - 2, Math.ceil((cy + r - f.oy) / step));
  const k0 = Math.max(1, Math.floor((cz - r - f.oz) / step));
  const k1 = Math.min(nz - 2, Math.ceil((cz + r - f.oz) / step));
  if (i0 > i1 || j0 > j1 || k0 > k1) return f;
  const rr = Math.max(1e-4, r);
  const s = Math.max(0.01, Math.min(1, strength));
  const tmp = new Float32Array((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1));
  const w = i1 - i0 + 1, h = j1 - j0 + 1;
  for (let it = 0; it < Math.max(1, iterations | 0); it++) {
    for (let k = k0; k <= k1; k++) {
      const pz = f.oz + k * step;
      for (let j = j0; j <= j1; j++) {
        const py = f.oy + j * step;
        for (let i = i0; i <= i1; i++) {
          const px = f.ox + i * step;
          const dist = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy) + (pz - cz) * (pz - cz));
          if (dist >= rr) { tmp[((k - k0) * h + (j - j0)) * w + (i - i0)] = data[(k * ny + j) * nx + i]; continue; }
          const at = (k * ny + j) * nx + i;
          const sum = data[at]
            + data[at - 1] + data[at + 1]
            + data[at - nx] + data[at + nx]
            + data[at - nx * ny] + data[at + nx * ny];
          const avg = sum / 7;
          const t = dist / rr;
          const fall = (1 - t * t) * (1 - t * t);
          tmp[((k - k0) * h + (j - j0)) * w + (i - i0)] = data[at] + (avg - data[at]) * s * fall;
        }
      }
    }
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          data[(k * ny + j) * nx + i] = tmp[((k - k0) * h + (j - j0)) * w + (i - i0)];
        }
      }
    }
  }
  return f;
}

/* ---------- Roblox 同款：扩张 / 侵蚀 / 压平 ---------- */

/**
 * 形态学「扩张 / 侵蚀」（Roblox 地形工具的 Grow / Erode）。
 * 对 SDF 做常量偏移：扩张 = 场值减 t（实体向外长 t）；侵蚀 = 场值加 t（实体向内缩 t）。
 * 只作用在笔刷球内、按半径衰减，所以是局部鼓包 / 塌陷，而不是把整个模型整体放大缩小。
 * 远处格点饱和在 ±band，只要 t < band，符号不会被误翻 → 不会凭空多出 / 抹掉一整块。
 * @param {number} sign +1 扩张 / -1 侵蚀
 */
export function fieldBrushOffset(f, cx, cy, cz, r, amount, sign = 1) {
  const { nx, ny, nz, step, band, data } = f;
  const t = Math.min(Math.max(0, amount), band * 0.85);
  if (!(t > 0)) return f;
  const i0 = Math.max(0, Math.floor((cx - r - f.ox) / step));
  const i1 = Math.min(nx - 1, Math.ceil((cx + r - f.ox) / step));
  const j0 = Math.max(0, Math.floor((cy - r - f.oy) / step));
  const j1 = Math.min(ny - 1, Math.ceil((cy + r - f.oy) / step));
  const k0 = Math.max(0, Math.floor((cz - r - f.oz) / step));
  const k1 = Math.min(nz - 1, Math.ceil((cz + r - f.oz) / step));
  const rr = Math.max(1e-4, r);
  for (let kk = k0; kk <= k1; kk++) {
    const pz = f.oz + kk * step;
    const dz2 = (pz - cz) * (pz - cz);
    for (let j = j0; j <= j1; j++) {
      const py = f.oy + j * step;
      const dy2 = (py - cy) * (py - cy) + dz2;
      const row = (kk * ny + j) * nx;
      for (let i = i0; i <= i1; i++) {
        const px = f.ox + i * step;
        const dist = Math.sqrt((px - cx) * (px - cx) + dy2);
        if (dist >= rr) continue;
        const tt = dist / rr;
        const fall = (1 - tt * tt) * (1 - tt * tt);
        const at = row + i;
        let v = data[at] - sign * t * fall;
        if (v > band) v = band; else if (v < -band) v = -band;
        data[at] = v;
      }
    }
  }
  return f;
}

/**
 * 压平（Roblox Flatten）：把笔刷球内的表面朝「过 (px,py,pz)、法线 (nx_,ny_,nz_)」的平面拉。
 * 平面的有符号距离做为目标值，按衰减插值 —— 表面被逐渐「熨」到这个平面上。
 */
export function fieldBrushFlatten(f, cx, cy, cz, r, nx_, ny_, nz_, px, py, pz, strength = 0.5) {
  const { nx, ny, nz, step, band, data } = f;
  const s = Math.max(0.01, Math.min(1, strength));
  // 法线归一化
  let ln = Math.hypot(nx_, ny_, nz_);
  if (!(ln > 1e-6)) { nx_ = 0; ny_ = 1; nz_ = 0; ln = 1; }
  const ux = nx_ / ln, uy = ny_ / ln, uz = nz_ / ln;
  const i0 = Math.max(0, Math.floor((cx - r - f.ox) / step));
  const i1 = Math.min(nx - 1, Math.ceil((cx + r - f.ox) / step));
  const j0 = Math.max(0, Math.floor((cy - r - f.oy) / step));
  const j1 = Math.min(ny - 1, Math.ceil((cy + r - f.oy) / step));
  const k0 = Math.max(0, Math.floor((cz - r - f.oz) / step));
  const k1 = Math.min(nz - 1, Math.ceil((cz + r - f.oz) / step));
  const rr = Math.max(1e-4, r);
  for (let kk = k0; kk <= k1; kk++) {
    const pz2 = f.oz + kk * step;
    for (let j = j0; j <= j1; j++) {
      const py2 = f.oy + j * step;
      for (let i = i0; i <= i1; i++) {
        const px2 = f.ox + i * step;
        const dist = Math.sqrt((px2 - cx) * (px2 - cx) + (py2 - cy) * (py2 - cy) + (pz2 - cz) * (pz2 - cz));
        if (dist >= rr) continue;
        const tt = dist / rr;
        const fall = (1 - tt * tt) * (1 - tt * tt);
        const plane = (px2 - px) * ux + (py2 - py) * uy + (pz2 - pz) * uz;
        const at = (kk * ny + j) * nx + i;
        let v = data[at] + (plane - data[at]) * s * fall;
        if (v > band) v = band; else if (v < -band) v = -band;
        data[at] = v;
      }
    }
  }
  return f;
}

/* ---------- 二维多边形工具（曲线围岛用） ---------- */
function polyInside(px, pz, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1];
    const xj = poly[j][0], zj = poly[j][1];
    if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) hit = !hit;
  }
  return hit;
}
function segDist2D(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const L = dx * dx + dz * dz;
  let t = L > 1e-12 ? ((px - x1) * dx + (pz - z1) * dz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x1 + dx * t, qz = z1 + dz * t;
  return Math.hypot(px - qx, pz - qz);
}

/**
 * 曲线围成的岛屿：把闭合折线沿 Y 方向拉成一个棱柱（上顶 yTop、下底 yBot），
 * 再用平滑并集融进场地形 —— 海岸线因为 smax 的圆角而自然收边。
 * @param {number[][]} poly  [[x, z], …] 闭合折线（世界坐标，XZ 平面）
 * @param {number} sign +1 造岛 / -1 挖湖
 */
export function fieldIslandPrism(f, poly, yTop, yBot, blend = 0, sign = 1) {
  if (!poly || poly.length < 3) return f;
  const { nx, ny, nz, step, band, data } = f;
  let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (const p of poly) {
    if (p[0] < xMin) xMin = p[0]; if (p[0] > xMax) xMax = p[0];
    if (p[1] < zMin) zMin = p[1]; if (p[1] > zMax) zMax = p[1];
  }
  const k = Math.max(0, blend);
  const reach = k + band;
  const i0 = Math.max(0, Math.floor((xMin - reach - f.ox) / step));
  const i1 = Math.min(nx - 1, Math.ceil((xMax + reach - f.ox) / step));
  const k0 = Math.max(0, Math.floor((zMin - reach - f.oz) / step));
  const k1 = Math.min(nz - 1, Math.ceil((zMax + reach - f.oz) / step));
  const j0 = Math.max(0, Math.floor((Math.min(yTop, yBot) - reach - f.oy) / step));
  const j1 = Math.min(ny - 1, Math.ceil((Math.max(yTop, yBot) + reach - f.oy) / step));
  const top = Math.max(yTop, yBot), bot = Math.min(yTop, yBot);
  for (let kk = k0; kk <= k1; kk++) {
    const pz = f.oz + kk * step;
    for (let i = i0; i <= i1; i++) {
      const px = f.ox + i * step;
      // XZ 平面的有符号距离：内负外正
      let dEdge = Infinity;
      for (let s = 0, q = poly.length - 1; s < poly.length; q = s++) {
        const d = segDist2D(px, pz, poly[q][0], poly[q][1], poly[s][0], poly[s][1]);
        if (d < dEdge) dEdge = d;
      }
      const d2 = polyInside(px, pz, poly) ? -dEdge : dEdge;
      const row = (kk * ny) * nx + i;
      for (let j = j0; j <= j1; j++) {
        const py = f.oy + j * step;
        // 棱柱 = max(二维距离, 水平面的上下裁切)；用 smax 把棱边倒圆
        let dv = py - top;
        const db = bot - py;
        if (db > dv) dv = db;
        const d = k > 1e-6 ? smax(d2, dv, k) : Math.max(d2, dv);
        const at = row + j * nx;
        if (sign >= 0) data[at] = smin(data[at], d, k);
        else data[at] = smax(data[at], -d, k);
      }
    }
  }
  return fieldClamp(f);
}

/* ============================================================
   Surface Nets 反提取：场 → 三角网格
   每个「符号有变」的格子里放一个顶点（放在边交点均值处），
   每条「符号有变」的格边对应一个四边形 → 拆两个三角。
   比 Marching Cubes 顶点少、面均匀，正好符合「低模」的口味。
   ============================================================ */
const CORNER = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const CEDGE = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export function fieldToMesh(f, iso = 0) {
  const { nx, ny, nz, step, data } = f;
  const ox = f.ox, oy = f.oy, oz = f.oz;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  if (cx < 1 || cy < 1 || cz < 1) return { verts: [], faces: [] };

  const cellIdx = new Int32Array(cx * cy * cz).fill(-1);
  const vout = [];
  const cv = new Float64Array(8);
  const sample = (i, j, k) => data[(k * ny + j) * nx + i] - iso;

  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNER[c];
          const v = sample(i + o[0], j + o[1], k + o[2]);
          cv[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let e = 0; e < 12; e++) {
          const a = CEDGE[e][0], b = CEDGE[e][1];
          const va = cv[a], vb = cv[b];
          if ((va < 0) === (vb < 0)) continue;
          const den = va - vb;
          const t = Math.abs(den) > 1e-12 ? va / den : 0.5;
          const oa = CORNER[a], ob = CORNER[b];
          sx += oa[0] + (ob[0] - oa[0]) * t;
          sy += oa[1] + (ob[1] - oa[1]) * t;
          sz += oa[2] + (ob[2] - oa[2]) * t;
          cnt++;
        }
        if (!cnt) continue;
        cellIdx[(k * cy + j) * cx + i] = vout.length / 3;
        vout.push(ox + (i + sx / cnt) * step, oy + (j + sy / cnt) * step, oz + (k + sz / cnt) * step);
      }
    }
  }
  if (!vout.length) return { verts: [], faces: [] };

  const cellAt = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= cx || j >= cy || k >= cz)
    ? -1 : cellIdx[(k * cy + j) * cx + i];
  const faces = [];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    faces.push([a, b, c]);
    faces.push([a, c, d]);
  };

  // 沿 X 的格边 → 上下左右四个格子围成的四边形
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const v0 = sample(i, j, k), v1 = sample(i + 1, j, k);
        if ((v0 < 0) === (v1 < 0)) continue;
        const c0 = cellAt(i, j - 1, k - 1), c1 = cellAt(i, j, k - 1);
        const c2 = cellAt(i, j, k), c3 = cellAt(i, j - 1, k);
        if (v0 < 0) quad(c0, c1, c2, c3); else quad(c3, c2, c1, c0);
      }
    }
  }
  // 沿 Y 的格边
  for (let k = 1; k < nz - 1; k++) {
    for (let i = 1; i < nx - 1; i++) {
      for (let j = 0; j < ny - 1; j++) {
        const v0 = sample(i, j, k), v1 = sample(i, j + 1, k);
        if ((v0 < 0) === (v1 < 0)) continue;
        const a = cellAt(i, j, k), b = cellAt(i, j, k - 1);
        const c = cellAt(i - 1, j, k - 1), d = cellAt(i - 1, j, k);
        if (v0 < 0) quad(a, b, c, d); else quad(d, c, b, a);
      }
    }
  }
  // 沿 Z 的格边
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      for (let k = 0; k < nz - 1; k++) {
        const v0 = sample(i, j, k), v1 = sample(i, j, k + 1);
        if ((v0 < 0) === (v1 < 0)) continue;
        const a = cellAt(i - 1, j, k), b = cellAt(i - 1, j - 1, k);
        const c = cellAt(i, j - 1, k), d = cellAt(i, j, k);
        if (v0 < 0) quad(a, b, c, d); else quad(d, c, b, a);
      }
    }
  }

  // 去掉没被任何面引用的顶点（边界格子可能留下孤点）
  const verts = [];
  const remap = new Int32Array(vout.length / 3).fill(-1);
  for (const fce of faces) {
    for (const vi of fce) {
      if (remap[vi] < 0) {
        remap[vi] = verts.length;
        verts.push([vout[vi * 3], vout[vi * 3 + 1], vout[vi * 3 + 2]]);
      }
    }
  }
  const outFaces = faces.map((fce) => [remap[fce[0]], remap[fce[1]], remap[fce[2]]]);
  return { verts, faces: outFaces };
}

/**
 * 把一个 THREE.BufferGeometry 摊成 verts / faces（局部坐标）。
 * 布尔运算的参与方不一定都是「低模建模体」——方块、网格模型也能参与，
 * 统一在这里转成同一份数据表示。
 */
export function bufferGeometryToMesh(geo) {
  if (!geo || !geo.attributes || !geo.attributes.position) return { verts: [], faces: [] };
  const pos = geo.attributes.position;
  const n = pos.count;
  const verts = new Array(n);
  for (let i = 0; i < n; i++) verts[i] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
  const faces = [];
  const idx = geo.index;
  if (idx) {
    for (let i = 0; i + 2 < idx.count; i += 3) {
      faces.push([idx.getX(i) | 0, idx.getX(i + 1) | 0, idx.getX(i + 2) | 0]);
    }
  } else {
    for (let i = 0; i + 2 < n; i += 3) faces.push([i, i + 1, i + 2]);
  }
  return { verts, faces };
}

/** 世界空间包围盒（供调用方决定场的范围），verts 会按 matrix 变换 */
export function meshWorldBox(verts, matrix) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const m = matrix || _m4.identity();
  for (const v of verts) {
    _vv.set(v[0], v[1], v[2]).applyMatrix4(m);
    if (_vv.x < min[0]) min[0] = _vv.x;
    if (_vv.y < min[1]) min[1] = _vv.y;
    if (_vv.z < min[2]) min[2] = _vv.z;
    if (_vv.x > max[0]) max[0] = _vv.x;
    if (_vv.y > max[1]) max[1] = _vv.y;
    if (_vv.z > max[2]) max[2] = _vv.z;
  }
  if (!Number.isFinite(min[0])) { min[0] = min[1] = min[2] = 0; max[0] = max[1] = max[2] = 1; }
  return { min, max };
}
