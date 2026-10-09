/* ============================================================
   世界优先管线 · Phase B：迭代演化世界结构
   ------------------------------------------------------------
   白模一次成型未必就好爬、好连通、够多样。这一层把体素格当成一个
   可搜索的解空间，用**模拟退火**迭代它：

     打分 Q(世界) = 体量配比 + 空腔连通性 + 落脚面密度 + 纵向层次
                    + 开放度梯度 + 空间多样性
     变异算子     = 挖厅 / 填体块 / 加壁架 / 冲蚀 / 立柱
     接受准则     = 变好就收；变差按 exp(Δ/T) 概率收（T 逐步下降）

   ★ 为什么用「迭代」而不是一次成型：
     一次成型的文法只能保证「局部长得对」；连通性、纵向层次、开放度梯度
     都是**全局性质**，只有反复打分—变异才调得动。这正是新管线对
     「智能」的落点：世界是被搜索出来的，不是被打印出来的。

   ★ 保护带：攀登链清出来的净空有 protect 掩码 —— 任何变异都不许把它填死，
     否则「世界本身能爬上去」这条保证会被演化悄悄破坏。
   ============================================================ */
import { clamp, round } from '../../core/util.js';
import {
  cloneGrid, cix, inGrid, setSolid, clearSolid, clearBoxIdx,
  cyOf, floodFree, distanceToSolid, gridStats, mergeBoxes, makeNoise,
} from './voxel.js';

export const TARGET_MASS = 0.40;

/* 打分权重（和为 1） */
const W = {
  mass: 0.16, conn: 0.26, ledge: 0.20, levels: 0.16, gradient: 0.10, diversity: 0.12,
};

/* ============================================================
   世界质量函数
   ------------------------------------------------------------
   @param g   体素格
   @param wt  世界蓝图（要它的 bands 来算「每带」）
   ============================================================ */
export function scoreWorld(g, wt) {
  const st = gridStats(g);
  const parts = {};

  /* ① 体量配比：太实心没空间，太空洞没世界 */
  parts.mass = clamp(1 - Math.abs(st.massRatio - TARGET_MASS) / 0.25, 0, 1);

  /* ② 连通性：最大的那块自由空间占比（孤岛多 = 世界碎） */
  const fl = floodFree(g);
  let largest = 0;
  let freeSum = 0;
  for (const s of fl.sizes) { freeSum += s; if (s > largest) largest = s; }
  parts.conn = freeSum > 0 ? clamp(largest / freeSum, 0, 1) : 0;

  /* ③ 落脚面密度 + ④ 纵向层次：自由格 + 下方实心 + 上方 3 格净空 = 可站 */
  const bandByY = bandIndexOfY(g, wt);          // 预算好「每个 y 属于哪一带」，避免逐格线性查
  const nb = wt.bands.length;
  const bandFree = new Array(nb).fill(0);
  const bandCells = new Array(nb).fill(0);
  const levelSeen = new Set();
  let ledges = 0;
  for (let z = 1; z < g.nz - 1; z++) {
    for (let y = 1; y < g.ny - 3; y++) {
      const b = bandByY[y];
      for (let x = 1; x < g.nx - 1; x++) {
        const i = cix(g, x, y, z);
        if (b >= 0) bandCells[b]++;
        if (g.occ[i]) continue;
        if (b >= 0) bandFree[b]++;
        if (!g.occ[i - g.nx]) continue;                              // 下方要实心才站得住
        if (g.occ[i + g.nx] || g.occ[i + 2 * g.nx] || g.occ[i + 3 * g.nx]) continue;  // 头顶要净空
        ledges++;
        levelSeen.add(y);
      }
    }
  }
  const lpf = freeSum > 0 ? ledges / freeSum : 0;
  parts.ledge = clamp(1 - Math.abs(lpf - 0.075) / 0.075, 0, 1);
  const wantedLevels = Math.max(4, wt.bands.length * 5);
  parts.levels = clamp(levelSeen.size / wantedLevels, 0, 1);

  /* ⑤ 开放度梯度：越往上越开阔（洪水逃生 = 逃向天光） */
  const ratio = bandCells.map((c, i) => (c > 0 ? bandFree[i] / c : 0));
  parts.gradient = clamp((corr(ratio) + 1) / 2, 0, 1);

  /* ⑥ 空间多样性：自由空间的「到墙距离」分布熵（大空腔 / 走廊 / 窄缝混着来） */
  const d = distanceToSolid(g);
  const bucket = [0, 0, 0, 0];
  const step = g.cell;
  for (let i = 0; i < g.n; i++) {
    if (g.occ[i]) continue;
    const R = d[i] * step;
    if (R < step * 1.5) bucket[0]++;
    else if (R < step * 3) bucket[1]++;
    else if (R < step * 5) bucket[2]++;
    else bucket[3]++;
  }
  parts.diversity = entropy(bucket);

  let total = 0;
  for (const k of Object.keys(W)) total += W[k] * parts[k];
  return { total: round(total, 5), parts, ledges, levels: levelSeen.size, massRatio: round(st.massRatio, 3), conn: round(parts.conn, 3) };
}

/** 每个 y（体素层）属于哪一条结构带；-1 = 不在任何带里 */
function bandIndexOfY(g, wt) {
  const arr = new Int16Array(g.ny).fill(-1);
  for (let i = 0; i < wt.bands.length; i++) {
    const y0 = Math.max(0, cyOf(g, wt.bands[i].y0));
    const y1 = Math.min(g.ny - 1, cyOf(g, wt.bands[i].y1));
    for (let y = y0; y <= y1; y++) if (arr[y] < 0) arr[y] = i;
  }
  return arr;
}
function corr(v) {
  const n = v.length;
  if (n < 2) return 0;
  let mv = 0, mx = 0;
  for (let i = 0; i < n; i++) { mv += v[i]; mx += i; }
  mv /= n; mx /= n;
  let num = 0, dv = 0, dx = 0;
  for (let i = 0; i < n; i++) {
    const a = v[i] - mv, b = i - mx;
    num += a * b; dv += a * a; dx += b * b;
  }
  if (dv <= 1e-9 || dx <= 1e-9) return 0;
  return num / Math.sqrt(dv * dx);
}
function entropy(bucket) {
  const sum = bucket.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return 0;
  let h = 0;
  for (const c of bucket) {
    if (!c) continue;
    const p = c / sum;
    h -= p * Math.log(p);
  }
  return clamp(h / Math.log(bucket.length), 0, 1);
}

/* ============================================================
   模拟退火
   ------------------------------------------------------------
   @param world buildWorld 的产物
   @param wt    世界蓝图
   @param opts  { rng, iters, temp }
   @returns 同一个 world（grid 已被替换成最优解）+ evolve 报告
   ============================================================ */
export function evolveWorld(world, wt, opts = {}) {
  const rng = opts.rng;
  const g0 = world.grid;
  const n = g0.n;
  const iters = clamp(Math.round(Number(opts.iters) || (700000 / Math.max(1, n) + 45)), 35, 190);
  const protect = g0.protect || null;

  let cur = cloneGrid(g0);
  if (protect) cur.protect = protect;          // 掩码共享（只读）
  let curScore = scoreWorld(cur, wt);
  let best = cur;
  let bestScore = curScore;
  let accepted = 0;
  const noise = makeNoise((g0.noiseSeed || 1) ^ 0x9e3779b9);
  const T0 = Number(opts.temp) || 0.06;

  const log = [];
  for (let it = 0; it < iters; it++) {
    const T = T0 * (1 - it / iters) + 1e-4;
    const cand = mutate(cur, rng, noise);
    if (!cand) continue;
    const sc = scoreWorld(cand, wt);
    const d = sc.total - curScore.total;
    if (d >= 0 || rng.next() < Math.exp(d / T)) {
      cur = cand;
      curScore = sc;
      accepted++;
      if (sc.total > bestScore.total) {
        bestScore = sc;
        best = cand;
        log.push({ it, total: sc.total, mass: sc.massRatio, conn: sc.conn, ledges: sc.ledges });
      }
    }
  }

  /* 写回最优解 */
  g0.occ.set(best.occ);
  g0.mat.set(best.mat);
  world.grid = g0;
  // ★ 几何变了，白模的产物必须重算：否则下游拿到的还是「演化前」的体块
  world.boxes = mergeBoxes(g0);
  world.stats = gridStats(g0);
  world.score = bestScore.total;
  world.evolve = {
    iters,
    accepted,
    score: bestScore.total,
    parts: bestScore.parts,
    massRatio: bestScore.massRatio,
    conn: bestScore.conn,
    ledges: bestScore.ledges,
    levels: bestScore.levels,
    improved: round(bestScore.total - scoreWorld(g0, wt).total, 4),
    trail: log.slice(-8),
  };
  return world;
}

/* ============================================================
   变异算子
   ------------------------------------------------------------
   每个算子返回一张试改过的新格（原格不动）—— 退火要能「回退」。
   ============================================================ */
function mutate(g, rng, noise) {
  const kind = rng.weighted([
    ['room', 0.30], ['mass', 0.24], ['ledge', 0.22], ['erode', 0.14], ['pillar', 0.10],
  ]);
  const x = rng.int(1, g.nx - 2);
  const z = rng.int(1, g.nz - 2);
  const y = rng.int(2, g.ny - 3);
  const c = cloneGrid(g);
  if (c.protect) c.protect = g.protect;
  const prot = (cx, cy2, cz) => g.protect && inGrid(g, cx, cy2, cz) && g.protect[cix(g, cx, cy2, cz)];

  switch (kind) {
    case 'room': {                       // 挖厅：掏一块空腔（增加空间与多样性）
      const w = rng.int(1, 3);
      const hh = rng.int(1, 3);
      // ★ 不许挖到攀登链：破坏性变异也必须尊重保护带，否则「世界能爬上去」会被悄悄毁掉
      if (anyProtected(g, x - w, y, z - w, x + w, y + hh, z + w)) return null;
      clearBoxIdx(c, x - w, y, z - w, x + w, y + hh, z + w);
      break;
    }
    case 'mass': {                       // 填体块：补回体量（不许埋掉攀登链）
      const w = rng.int(0, 1);
      const h = rng.int(0, 2);
      if (prot(x, y, z)) return null;
      for (let dy = 0; dy <= h; dy++) {
        for (let dz = -w; dz <= w; dz++) {
          for (let dx = -w; dx <= w; dx++) {
            if (prot(x + dx, y + dy, z + dz)) continue;
            setSolid(c, x + dx, y + dy, z + dz, 4);
          }
        }
      }
      break;
    }
    case 'ledge': {                      // 加壁架：直接增加可用落脚面
      const w = rng.int(0, 1);
      const d2 = rng.chance(0.5) ? w : 0;
      if (prot(x, y, z)) return null;
      for (let dx = 0; dx <= w; dx++) {
        for (let dz = 0; dz <= d2; dz++) {
          const px = x + dx, pz = z + dz;
          let ok = true;
          for (let dy = 1; dy <= 3; dy++) if (g.occ[cix(g, px, y + dy, pz)]) { ok = false; break; }
          if (ok) setSolid(c, px, y, pz, 5);
        }
      }
      break;
    }
    case 'erode': {                      // 冲蚀：贴着墙削薄（让世界更透气）
      if (prot(x, y, z)) return null;                           // 不许冲掉攀登链
      const d = distanceToSolid(g);
      if (d[cix(g, x, y, z)] * g.cell > g.cell * 4) return null;   // 只在贴墙处冲
      clearSolid(c, x, y, z);
      break;
    }
    default: {                           // 立柱：竖着长一根结构（增加纵向层次）
      const h = rng.int(2, 5);
      for (let dy = 0; dy < h; dy++) {
        if (prot(x, y + dy, z)) break;
        setSolid(c, x, y + dy, z, 1);
      }
      break;
    }
  }
  if (noise) { /* 噪声留给未来做「风蚀」用；这里保持确定性即可 */ }
  return c;
}

/** 一段体素范围内是否碰到受保护格（攀登链） */
function anyProtected(g, x0, y0, z0, x1, y1, z1) {
  if (!g.protect) return false;
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!inGrid(g, x, y, z)) continue;
        if (g.protect[cix(g, x, y, z)]) return true;
      }
    }
  }
  return false;
}

/* ============================================================
   精英库：多个候选世界并行生成，挑最高分的那个
   ------------------------------------------------------------
   异步多线程的落点 —— 每个候选在世界里跑一遍（A → B），
   主线程拿分数排序，取榜首进入 Phase C。
   ============================================================ */
export function rankWorlds(list) {
  const arr = (list || []).filter((w) => w && w.score != null);
  arr.sort((a, b) => b.score - a.score);
  return {
    best: arr[0] || null,
    rest: arr.slice(1),
    spread: arr.length > 1 ? round(arr[0].score - arr[arr.length - 1].score, 4) : 0,
    count: arr.length,
  };
}