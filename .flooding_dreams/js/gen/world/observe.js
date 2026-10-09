/* ============================================================
   世界优先管线 · Phase C1：观测世界
   ------------------------------------------------------------
   世界已经生成好了（Phase A/B）。这一层**只看，不动**：
   把体素世界读成一份「可行动的地形语义」——

     · 落脚面 pads：自由格 + 下方实心 + 上方 3 格净空 → 能站人的台面；
                     同高度水平连通的一片台面聚成一块 pad（带真实宽深）
     · 连通域 label：空腔的连通块；只保留最大的一块（孤岛不算「世界」）
     · 空间场 dist  ：到最近实体的距离 → 「这里是窄缝还是大厅」
     · 每带（band）的 pad 清单 + 出生 / 终点候选

   下游 route.js 正是拿这份观测结果去**排布跑酷配置**：
   优先落在真实台面上，世界够不着时才补板 —— 这就是
   「极其智能的算法观测生成的世界，再安排跑酷」的字面落点。
   ============================================================ */
import { clamp, round } from '../../core/util.js';
import { makeParam, minCeiling } from '../reach.js';
import {
  cix, inGrid, distanceToSolid, floodFree,
} from './voxel.js';

/** 一片 pad 至少要有的可站格数（≈ 一片能落脚的台面） */
const MIN_PAD_CELLS = 3;

/**
 * @param world buildWorld/evolveWorld 的产物
 * @param wt    世界蓝图
 * @param opts  { P, perBandCap }
 * @returns { pads[], bands[], dist, label, mainLabel, spawnHint, goalHint, stats }
 */
export function observeWorld(world, wt, opts = {}) {
  const g = world.grid;
  const dist = distanceToSolid(g);
  const fl = floodFree(g);
  // 头顶净空口径：玩家站在台面上方，可用高度 = 从脚下那一格起的连续自由格数 × cell
  const P = opts.P || makeParam();
  const headStud = minCeiling(P) + 2;                 // ≈ 16.89 stud

  /* 最大自由连通域 = 这个世界的「主体」 */
  let mainLabel = 0, best = -1;
  for (let i = 0; i < fl.sizes.length; i++) if (fl.sizes[i] > best) { best = fl.sizes[i]; mainLabel = i; }

  const stand = new Uint8Array(g.n);          // 可站格掩码
  const head = new Uint8Array(g.n);           // 头顶净空层数（封顶 15）
  for (let z = 1; z < g.nz - 1; z++) {
    for (let y = 1; y < g.ny - 1; y++) {
      for (let x = 1; x < g.nx - 1; x++) {
        const i = cix(g, x, y, z);
        if (g.occ[i]) continue;
        if (fl.label[i] !== mainLabel) continue;              // 只认主体空腔
        if (!g.occ[i - g.nx]) continue;                       // 下方要实心
        let h = 0;
        for (let k = 1; k <= 15; k++) {
          const j = i + k * g.nx;
          if (!inGrid(g, x, y + k, z) || g.occ[j]) break;
          h++;
        }
        if (h < 2) continue;
        if ((h + 1) * g.cell < headStud) continue;            // 脚下那一格 + 上方 h 格 ≥ 净空口径
        stand[i] = 1;
        head[i] = h;
      }
    }
  }

  /* ---------- 水平连通聚类 → pads ---------- */
  const seen = new Uint8Array(g.n);
  const pads = [];
  const stack = new Int32Array(Math.max(1024, g.n));
  for (let s = 0; s < g.n; s++) {
    if (!stand[s] || seen[s]) continue;
    let top = 0;
    stack[top++] = s;
    seen[s] = 1;
    let cnt = 0, sx = 0, sy = 0, sz = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxHead = 0;
    while (top > 0) {
      const i = stack[--top];
      const x = i % g.nx;
      const y = ((i - x) / g.nx) % g.ny;
      const z = Math.floor(i / (g.nx * g.ny));
      cnt++; sx += x; sy += y; sz += z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      if (head[i] > maxHead) maxHead = head[i];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx2 = x + dx, nz2 = z + dz;
        if (!inGrid(g, nx2, y, nz2)) continue;
        const j = cix(g, nx2, y, nz2);
        if (!stand[j] || seen[j]) continue;
        seen[j] = 1;
        stack[top++] = j;
      }
    }
    if (cnt < MIN_PAD_CELLS) continue;
    const ccx = sx / cnt, ccz = sz / cnt, ccy = sy / cnt;
    const cell = g.cell;
    const spanX = (maxX - minX + 1) * cell;
    const spanZ = (maxZ - minZ + 1) * cell;
    const band = bandIndexOf(wt, g, ccy);
    pads.push({
      x: round(g.ox + (ccx + 0.5) * cell, 3),
      y: round(g.oy + Math.round(ccy) * cell, 3),            // 站立面 = 下方实心格的顶面
      z: round(g.oz + (ccz + 0.5) * cell, 3),
      w: round(spanX, 3),
      d: round(spanZ, 3),
      // hw 是「内切半径」，只用于 navcheck 的吸附容差与显示，封顶 10 免得超大地面
      // 把容差撑到几十 stud（真实的边到边缺口由 route 的方向支撑半径精确算）
      hw: round(clamp(Math.min(spanX, spanZ) / 2, cell * 0.5, 10), 3),
      beam: round(Math.min(spanX, spanZ), 3),
      area: cnt,
      open: round(dist[s] * cell, 3),                        // 这一片的开阔度（到墙距离）
      head: round(maxHead * cell, 3),
      band,
      source: 'world',
      cell: s,
    });
  }

  /* ---------- 按带归组，并给出生 / 终点候选 ---------- */
  const bands = wt.bands.map((b, i) => ({
    i, key: b.key, grammar: b.grammar, y0: b.y0, y1: b.y1,
    shell: b.shell, pattern: b.pattern, theme: b.theme,
    pads: [], minY: Infinity, maxY: -Infinity,
  }));
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    const b = bands[clamp(p.band, 0, bands.length - 1)];
    p.id = i;
    b.pads.push(i);
    b.minY = Math.min(b.minY, p.y);
    b.maxY = Math.max(b.maxY, p.y);
  }

  const byY = pads.slice().sort((a, b) => a.y - b.y);
  const spawnHint = byY.length ? byY[Math.floor(byY.length * 0.03)] : null;
  // 终点：最高 15% 的台面里，挑「最开阔」的那块（逃向天光 → 站到开阔的高处）
  const topCut = byY.slice(Math.max(0, Math.floor(byY.length * 0.85)));
  const goalHint = topCut.length
    ? topCut.reduce((a, b) => (b.y > a.y || (b.y === a.y && b.open > a.open) ? b : a), topCut[0])
    : byY[byY.length - 1] || null;

  return {
    pads, bands, dist, label: fl.label,
    mainLabel,
    spawnHint, goalHint,
    stats: {
      pads: pads.length,
      freeComponents: fl.sizes.length,
      mainComponentRatio: round(best / Math.max(1, g.n), 3),
      standRatio: round(countStand(stand) / Math.max(1, g.n), 4),
      bandPads: bands.map((b) => b.pads.length),
    },
  };
}

function countStand(stand) {
  let c = 0;
  for (let i = 0; i < stand.length; i++) if (stand[i]) c++;
  return c;
}

function bandIndexOf(wt, g, cy) {
  const wy = g.oy + cy * g.cell;
  for (let i = 0; i < wt.bands.length; i++) {
    const b = wt.bands[i];
    if (wy >= b.y0 && wy <= b.y1) return i;
  }
  return wt.bands.length - 1;
}

/* ============================================================
   空间索引：给 route.js 做「这一带附近有哪些台面」的邻近查询
   ============================================================ */
export function makePadIndex(pads, cell = 24) {
  const map = new Map();
  const key = (ix, iz) => ix * 100003 + iz;
  const ixOf = (v) => Math.floor(v / cell);
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    const k = key(ixOf(p.x), ixOf(p.z));
    let arr = map.get(k);
    if (!arr) { arr = []; map.set(k, arr); }
    arr.push(i);
  }
  /** 在半径 r 内取候选 pad（粗筛 + 精确距离） */
  const near = (x, y, z, r, yTol) => {
    const span = Math.ceil(r / cell);
    const out = [];
    for (let dx = -span; dx <= span; dx++) {
      for (let dz = -span; dz <= span; dz++) {
        const arr = map.get(key(ixOf(x) + dx, ixOf(z) + dz));
        if (!arr) continue;
        for (const i of arr) {
          const p = pads[i];
          if (Math.abs(p.y - y) > (yTol || r)) continue;
          if (Math.hypot(p.x - x, p.z - z) <= r) out.push(i);
        }
      }
    }
    return out;
  };
  return { near, map };
}