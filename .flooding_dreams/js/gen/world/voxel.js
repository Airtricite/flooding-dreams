/* ============================================================
   世界优先管线 · 体素基础设施
   ------------------------------------------------------------
   白模 / 演化 / 观测三层共用的一张体素格与一组算子。
   全部是纯计算（不依赖 three / DOM），所以整条世界管线都能搬进 Worker。

   约定：
     occ[i] = 1 → 实体（可站立、可挡人）
     mat[i]     → 材质槽位（只影响配色分层，不影响几何）
     cell       → 体素边长（stud）；(ox,oy,oz) 是格原点（世界坐标）
   ============================================================ */
import { clamp } from '../../core/util.js';

export function makeGrid(bounds, cell) {
  const c = Math.max(1, Number(cell) || 8);
  const ox = Math.floor(bounds.min.x / c) * c;
  const oy = Math.floor(bounds.min.y / c) * c;
  const oz = Math.floor(bounds.min.z / c) * c;
  const nx = Math.max(1, Math.ceil((bounds.max.x - ox) / c) + 1);
  const ny = Math.max(1, Math.ceil((bounds.max.y - oy) / c) + 1);
  const nz = Math.max(1, Math.ceil((bounds.max.z - oz) / c) + 1);
  const n = nx * ny * nz;
  return {
    cell: c, ox, oy, oz, nx, ny, nz, n,
    occ: new Uint8Array(n),
    mat: new Uint8Array(n),
  };
}

export const cix = (g, x, y, z) => (z * g.ny + y) * g.nx + x;

export const inGrid = (g, x, y, z) => (x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz);

/** 体素中心的世界坐标 */
export const cellCenterX = (g, x) => g.ox + (x + 0.5) * g.cell;
export const cellCenterY = (g, y) => g.oy + (y + 0.5) * g.cell;
export const cellCenterZ = (g, z) => g.oz + (z + 0.5) * g.cell;

/** 世界坐标 → 体素索引（可能越界，调用方先 inGrid） */
export const cxOf = (g, wx) => Math.floor((wx - g.ox) / g.cell);
export const cyOf = (g, wy) => Math.floor((wy - g.oy) / g.cell);
export const czOf = (g, wz) => Math.floor((wz - g.oz) / g.cell);

export function solidAt(g, x, y, z) {
  return inGrid(g, x, y, z) && g.occ[cix(g, x, y, z)] === 1;
}

export function setSolid(g, x, y, z, mat = 0) {
  if (!inGrid(g, x, y, z)) return false;
  const i = cix(g, x, y, z);
  if (g.occ[i]) return false;
  g.occ[i] = 1;
  g.mat[i] = mat;
  return true;
}

export function clearSolid(g, x, y, z) {
  if (!inGrid(g, x, y, z)) return false;
  const i = cix(g, x, y, z);
  if (!g.occ[i]) return false;
  g.occ[i] = 0;
  g.mat[i] = 0;
  return true;
}

/** 实心长方体（体素索引，含端点） */
export function fillBoxIdx(g, x0, y0, z0, x1, y1, z1, mat = 0) {
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) setSolid(g, x, y, z, mat);
    }
  }
}

/** 挖空长方体（体素索引，含端点） */
export function clearBoxIdx(g, x0, y0, z0, x1, y1, z1) {
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) clearSolid(g, x, y, z);
    }
  }
}

/**
 * 到最近**实体**的距离（体素单位），两遍 chamfer（13 邻域）。
 * 观测层用它判断「这里有大的空腔还是贴着墙」，演化层用它切腔壁。
 */
export function distanceToSolid(g) {
  const { nx, ny, nz, n, occ } = g;
  const INF = 1e6;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = occ[i] ? 0 : INF;
  const W = [1, 1.4142136, 1.7320508];
  const step = (i, j, w) => { const v = d[j] + w; if (v < d[i]) d[i] = v; };

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = (z * ny + y) * nx + x;
        if (d[i] === 0) continue;
        if (x > 0) step(i, i - 1, W[0]);
        if (y > 0) step(i, i - nx, W[0]);
        if (z > 0) step(i, i - nx * ny, W[0]);
        if (x > 0 && y > 0) step(i, i - nx - 1, W[1]);
        if (x < nx - 1 && y > 0) step(i, i - nx + 1, W[1]);
        if (x > 0 && z > 0) step(i, i - nx * ny - 1, W[1]);
        if (x < nx - 1 && z > 0) step(i, i - nx * ny + 1, W[1]);
        if (y > 0 && z > 0) step(i, i - nx * ny - nx, W[1]);
        if (y < ny - 1 && z > 0) step(i, i - nx * ny + nx, W[1]);
        if (x > 0 && y > 0 && z > 0) step(i, i - nx * ny - nx - 1, W[2]);
        if (x < nx - 1 && y > 0 && z > 0) step(i, i - nx * ny - nx + 1, W[2]);
        if (x > 0 && y < ny - 1 && z > 0) step(i, i - nx * ny + nx - 1, W[2]);
        if (x < nx - 1 && y < ny - 1 && z > 0) step(i, i - nx * ny + nx + 1, W[2]);
      }
    }
  }
  for (let z = nz - 1; z >= 0; z--) {
    for (let y = ny - 1; y >= 0; y--) {
      for (let x = nx - 1; x >= 0; x--) {
        const i = (z * ny + y) * nx + x;
        if (d[i] === 0) continue;
        if (x < nx - 1) step(i, i + 1, W[0]);
        if (y < ny - 1) step(i, i + nx, W[0]);
        if (z < nz - 1) step(i, i + nx * ny, W[0]);
        if (x < nx - 1 && y < ny - 1) step(i, i + nx + 1, W[1]);
        if (x > 0 && y < ny - 1) step(i, i + nx - 1, W[1]);
        if (x < nx - 1 && z < nz - 1) step(i, i + nx * ny + 1, W[1]);
        if (x > 0 && z < nz - 1) step(i, i + nx * ny - 1, W[1]);
        if (y < ny - 1 && z < nz - 1) step(i, i + nx * ny + nx, W[1]);
        if (y > 0 && z < nz - 1) step(i, i + nx * ny - nx, W[1]);
        if (x < nx - 1 && y < ny - 1 && z < nz - 1) step(i, i + nx * ny + nx + 1, W[2]);
        if (x > 0 && y < ny - 1 && z < nz - 1) step(i, i + nx * ny + nx - 1, W[2]);
        if (x < nx - 1 && y > 0 && z < nz - 1) step(i, i + nx * ny - nx + 1, W[2]);
        if (x > 0 && y > 0 && z < nz - 1) step(i, i + nx * ny - nx - 1, W[2]);
      }
    }
  }
  return d;
}

/**
 * 空腔连通性：把自由体素按 6 邻接分连通块。
 * @returns { label: Int32Array, sizes: number[], count }
 *   label[i] = -1（实体）或连通块编号
 */
export function floodFree(g) {
  const { nx, ny, nz, n, occ } = g;
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(n);
  const step = [1, -1, nx, -nx, nx * ny, -nx * ny];
  for (let s = 0; s < n; s++) {
    if (occ[s] || label[s] >= 0) continue;
    const id = sizes.length;
    let top = 0;
    stack[top++] = s;
    label[s] = id;
    let cnt = 0;
    while (top > 0) {
      const i = stack[--top];
      cnt++;
      const x = i % nx;
      const y = ((i - x) / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      for (let k = 0; k < 6; k++) {
        const j = i + step[k];
        if (j < 0 || j >= n) continue;
        if (k === 0 && x === nx - 1) continue;
        if (k === 1 && x === 0) continue;
        if (k === 2 && y === ny - 1) continue;
        if (k === 3 && y === 0) continue;
        if (k === 4 && z === nz - 1) continue;
        if (k === 5 && z === 0) continue;
        if (occ[j] || label[j] >= 0) continue;
        label[j] = id;
        stack[top++] = j;
      }
    }
    sizes.push(cnt);
  }
  return { label, sizes, count: sizes.length };
}

/** 表层掩码：至少有一个面暴露在空气里（内部实心看不见也摸不到） */
export function surfaceMask(g) {
  const { nx, ny, nz, occ } = g;
  const mask = new Uint8Array(occ.length);
  const sxz = nx * ny;
  for (let i = 0; i < occ.length; i++) {
    if (!occ[i]) continue;
    const x = i % nx;
    const y = ((i - x) / nx) % ny;
    const z = Math.floor(i / sxz);
    if (x === 0 || x === nx - 1 || !occ[i - 1] || !occ[i + 1]
      || y === 0 || y === ny - 1 || !occ[i - nx] || !occ[i + nx]
      || z === 0 || z === nz - 1 || !occ[i - sxz] || !occ[i + sxz]) {
      mask[i] = 1;
    }
  }
  return mask;
}

/**
 * 三维贪心合并：表层实体 → 最少数量的方块。
 * 单材质才合得动；换材质会把合并从中间切断（所以白模尽量少换材质）。
 * @returns [{ x,y,z,w,h,d,m }]（体素索引单位）
 */
export function mergeBoxes(g) {
  const { nx, ny, nz, occ, mat } = g;
  const n = occ.length;
  const mask = surfaceMask(g);
  const used = new Uint8Array(n);
  const out = [];
  const free = (c) => mask[c] === 1 && used[c] === 0;
  const sxz = nx * ny;

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const c0 = (z * ny + y) * nx + x;
        if (!free(c0)) continue;
        const m = mat[c0];

        let w = 1;
        while (x + w < nx && free(c0 + w) && mat[c0 + w] === m) w++;

        let h = 1;
        growY: while (y + h < ny) {
          const row = ((z * ny) + (y + h)) * nx + x;
          for (let i = 0; i < w; i++) if (!free(row + i) || mat[row + i] !== m) break growY;
          h++;
        }

        let d = 1;
        growZ: while (z + d < nz) {
          const plane = ((z + d) * ny + y) * nx + x;
          for (let j = 0; j < h; j++) {
            const row = plane + j * nx;
            for (let i = 0; i < w; i++) if (!free(row + i) || mat[row + i] !== m) break growZ;
          }
          d++;
        }

        for (let k = 0; k < d; k++) {
          for (let j = 0; j < h; j++) {
            const row = ((z + k) * ny + (y + j)) * nx + x;
            for (let i = 0; i < w; i++) used[row + i] = 1;
          }
        }
        out.push({ x, y, z, w, h, d, m });
      }
    }
  }
  return out;
}

/** 统计：实心数 / 自由数 / 空间占比 */
export function gridStats(g) {
  let solid = 0;
  for (let i = 0; i < g.n; i++) if (g.occ[i]) solid++;
  return { solid, free: g.n - solid, total: g.n, massRatio: g.n ? solid / g.n : 0 };
}

/** 值噪声（三线性插值，确定性）——与旧白模层同口径 */
export function makeNoise(seed) {
  const a = (typeof seed === 'number' ? Math.floor(seed) : 0) >>> 0;
  let s = a || 1;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const at = (x, y, z) => p[(p[(p[x & 255] + y) & 255] + z) & 255] / 255;

  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);
    const c000 = at(xi, yi, zi), c100 = at(xi + 1, yi, zi);
    const c010 = at(xi, yi + 1, zi), c110 = at(xi + 1, yi + 1, zi);
    const c001 = at(xi, yi, zi + 1), c101 = at(xi + 1, yi, zi + 1);
    const c011 = at(xi, yi + 1, zi + 1), c111 = at(xi + 1, yi + 1, zi + 1);
    const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
    const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  };
}

/** 浅拷贝一张格（演化要「试改 → 打分 → 可能回退」，不能就地改坏） */
export function cloneGrid(g) {
  return { ...g, occ: g.occ.slice(), mat: g.mat.slice() };
}

/** 把带索引的格写成「世界坐标包围盒」 */
export function gridWorldBox(g) {
  return {
    min: { x: g.ox, y: g.oy, z: g.oz },
    max: { x: g.ox + g.nx * g.cell, y: g.oy + g.ny * g.cell, z: g.oz + g.nz * g.cell },
  };
}

export { clamp };