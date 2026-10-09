/* ============================================================
   程序化装饰 · L3 硬约束投影 + 蓝噪声散布
   ------------------------------------------------------------
   槽位只是候选，这一层负责**否决与落位**。本轮（M2）全部是零风险件
   （`physicsMode:'none'`），所以 H1 在物理上天然成立；但「看起来不穿模、
   不悬空、不挡视线」仍然要真管，于是有四条实打实的约束：

     H1 走廊净空 —— 地贴/潮线件离走廊 > SAFE_R；顶挂件要挂在走廊净空之上。
     H3 预算     —— 件数与估算三角面双上限，超了就地停手。
     H4 不悬空/不穿模 —— 必须贴在真实表面（顶 / 底 / 侧），
                    且**成形后的包围盒与实体重叠不得超过 15%**（超出即否决）。
     H5 液体     —— 潮线件必须贴水面；水下只允许主题的水下母题。
     H6 安全区   —— 起点 8 / 终点 6 半径内禁止尖刺类「危险外观」。

   为什么不用 fields.attach 直接贴面：
     attach 返回「离查询点最近的盒子的那一面」，对地贴这种「往下找地板」的
     需求会挑到旁边的墙（返回 side）。所以这里改用三个直白的足迹查询：
     findTop（脚下最高的顶面）/ findCeiling（头顶最低的底面）/ findSide（竖直范围内的最近侧面）。

   另外两条是「像手工做的」而非「不出错」的：
     · 蓝噪声（抖动格 + 空间哈希最小距离）避免均匀网格感；
     · 同一段内**只用一支主色 + 一支辅助色**，尺寸按 1 : 0.6 : 0.38 递退。
   ============================================================ */
import { clamp, round } from '../../core/util.js';
import { makeSlots } from './slots.js';
import { propsForSlot, trisOf } from './props.js';

/** 走廊安全半径（stud）：与开发文档 §7.1 的 H1 同值 */
export const SAFE_R = 2.5;
/** 成形后的包围盒最多允许与实体重叠的比例（同簇内的自然嵌合） */
const OVERLAP_MAX = 0.15;
/** 危险外观（安全区里不许出现「像会扎人的东西」） */
const DANGER_LOOK = new Set(['stalactite', 'crystal', 'brokenPillar', 'farTower', 'farSpire']);
/** 水下允许的母题 */
const UNDERWATER_OK = new Set(['mushroom', 'crystal', 'rockChunk', 'floatPlate', 'reed']);

const MIN_GAP = { floorDress: 4.5, ledgeDress: 3.5, wallMount: 7.0, ceilingHang: 6.5, waterline: 9.0, farSilhouette: 34 };
/** 空间哈希格边长：要 >= 最大 gap，保证 ±1 邻域一定覆盖到最近的邻居 */
const HASH_CELL = 36;

const DROP_MAX = { floorDress: 14, ledgeDress: 2.5, waterline: 6 };   // 向下找地板的极限
const RISE_MAX = { ceilingHang: 60 };                  // 向上找顶棚的极限（从净空之上再往上找）
const SIDE_MAX = 80;                                   // 侧向找墙的极限（白模的房间比老外壳大得多）

export const DEFAULT_STRUCT_BUDGET = {
  props: 150,       // 结构装饰件数上限（白模已经占了数百个 mesh，这里必须克制）
  tris: 42000,      // 估算三角面上限
};

/**
 * 散布结构装饰。
 * @returns { objects[], stats, rejects }
 */
export function scatterProps({ fields, sections, theme, rng, idGen, strength = 0.7, budget, spawn, goal }) {
  const lim = { ...DEFAULT_STRUCT_BUDGET, ...(budget || {}) };
  const k = clamp(Number(strength) || 0, 0, 1);
  const objects = [];
  const stats = { placed: 0, tris: 0, byKind: {}, byRecipe: {} };
  const rejects = { pass: 0, surface: 0, fit: 0, spread: 0, safe: 0, water: 0, budget: 0 };

  if (k <= 0 || typeof idGen !== 'function') return { objects, stats, rejects };

  const slots = makeSlots({
    fields, sections, theme, rng,
    budget: {
      floorDress: Math.round(90 * k),
      ledgeDress: Math.round(60 * k),
      wallMount: Math.round(56 * k),
      ceilingHang: Math.round(36 * k),
      waterline: Math.round(18 * k),
      farSilhouette: Math.round(26 * k),
    },
  });
  if (!slots.length) return { objects, stats, rejects };

  const solids = Array.isArray(fields.solids) ? fields.solids : [];
  const waterY = Number.isFinite(fields.waterY) ? fields.waterY : null;
  const hash = new Map();
  const secCount = Math.max(1, (sections || []).length);
  const panels = [];
  for (let i = 0; i < secCount; i++) panels.push(panelOf(theme, i / Math.max(1, secCount - 1), rng));

  for (const slot of slots) {
    if (stats.placed >= lim.props || stats.tris >= lim.tris) { rejects.budget++; continue; }

    /* ---- 找面 ---- */
    let anchor = null;
    if (slot.kind === 'farSilhouette') anchor = { x: slot.x, y: slot.y, z: slot.z, kind: 'ground', box: null };
    else if (slot.kind === 'floorDress') anchor = findTop(solids, slot, DROP_MAX.floorDress);
    else if (slot.kind === 'ledgeDress') anchor = findTop(solids, slot, DROP_MAX.ledgeDress);
    else if (slot.kind === 'waterline') anchor = findTop(solids, slot, DROP_MAX.waterline);
    else if (slot.kind === 'ceilingHang') anchor = findCeiling(solids, slot, RISE_MAX.ceilingHang);
    else if (slot.kind === 'wallMount') anchor = marchToWall(solids, slot, SIDE_MAX);
    if (!anchor) { rejects.surface++; continue; }

    /* ---- H1：离走廊够远 ----
       ★ 必须在**落位之后**判：贴面会把点往下带（地板可能离另一条腿更近），
         用槽位判定会漏掉这一层（复刻脚本抓到过 2 件落进走廊）。
       平台边缘小件与远景豁免：前者是玩家脚边的小件，后者本来就在外面。 */
    if (slot.kind !== 'farSilhouette' && slot.kind !== 'ledgeDress') {
      const need = slot.kind === 'floorDress' || slot.kind === 'waterline' ? SAFE_R : 0.8;
      if (fields.pass(anchor) < need) { rejects.pass++; continue; }
    }

    /* ---- 蓝噪声：与已放的件保持最小距离 ---- */
    const gap = MIN_GAP[slot.kind] || 5;
    if (tooClose(hash, anchor.x, anchor.y, anchor.z, gap)) { rejects.spread++; continue; }

    /* ---- 选配方（平台边缘件借用地贴那套小件） ---- */
    const propSlot = slot.kind === 'ledgeDress' ? 'floorDress' : slot.kind;
    const pool = propsForSlot(propSlot, theme);
    if (!pool.length) { rejects.surface++; continue; }
    const recipe = pickByDistance(pool, rng, stats.byRecipe);

    /* ---- H6：安全区禁止危险外观 ---- */
    if (DANGER_LOOK.has(recipe.id)) {
      const ds = spawn ? dist3(anchor, spawn) : Infinity;
      const dg = goal ? dist3(anchor, goal) : Infinity;
      if (ds < 8 || dg < 6) { rejects.safe++; continue; }
    }

    /* ---- H5：液体规则 ---- */
    if (waterY !== null) {
      if (anchor.y < waterY - 1 && !UNDERWATER_OK.has(recipe.id)) { rejects.water++; continue; }
      if (slot.kind === 'waterline' && Math.abs(anchor.y - waterY) > 3) { rejects.water++; continue; }
    }

    /* ---- 成形：贴面件的朝向要顺着面（壁挂件贴着墙躺，不是横插进去） ---- */
    const size = sizeOf(slot.kind, rng);
    const ctx = {
      x: anchor.x, y: anchor.y, z: anchor.z,
      rotY: yawFor(anchor, rng),
      kind: anchor.kind,
      panel: panels[sectionIndexOf(sections, slot) % panels.length],
      theme, rng, size,
    };
    const over = recipe.make(ctx);
    if (!over || !over.scale) { rejects.surface++; continue; }

    /* ---- 把「锚点」换算成真正的中心：顶面件往上抬半个身高、倒挂件往下垂、壁挂件往外挪 ---- */
    const dim = dimsOf(over);
    placeCenter(over, anchor, dim);

    /* ---- H4：包围盒不许插进实体（贴着的那个面除外），重叠 ≤ 15% ---- */
    const bb = aabbOf(over, dim);
    if (slot.kind !== 'farSilhouette' && !fits(solids, bb, anchor.box)) { rejects.fit++; continue; }

    over.id = idGen(`d${recipe.id.slice(0, 2)}`);
    over.name = `${theme.label}·${recipe.label}`;

    objects.push({ type: 'mesh', over });
    stats.placed++;
    stats.tris += trisOf(over);
    stats.byKind[slot.kind] = (stats.byKind[slot.kind] || 0) + 1;
    stats.byRecipe[recipe.id] = (stats.byRecipe[recipe.id] || 0) + 1;
    addHash(hash, anchor.x, anchor.y, anchor.z);
  }

  stats.tris = Math.round(stats.tris);
  return { objects, stats, rejects };
}

/* ============================================================
   表面查询（足迹包含 + 高度排序）
   ============================================================ */

/** 脚下「最高」的顶面：顶面在脚下、足迹包含该点 */
function findTop(solids, p, maxDrop, margin = 1.2) {
  let best = null;
  for (const b of solids) {
    if (!inFoot(b, p, margin)) continue;
    const top = b.cy + b.hy;
    if (top > p.y + 0.6) continue;
    const d = p.y - top;
    if (d > maxDrop) continue;
    if (!best || d < best.d) best = { d, b, y: top };
  }
  return best ? { x: p.x, y: best.y, z: p.z, kind: 'top', box: best.b } : null;
}

/** 头顶「最低」的底面：底面在头顶上方、足迹包含该点 */
function findCeiling(solids, p, maxRise, margin = 1.2) {
  let best = null;
  for (const b of solids) {
    if (!inFoot(b, p, margin)) continue;
    const bot = b.cy - b.hy;
    if (bot < p.y - 0.6) continue;
    const d = bot - p.y;
    if (d > maxRise) continue;
    if (!best || d < best.d) best = { d, b, y: bot };
  }
  return best ? { x: p.x, y: best.y, z: p.z, kind: 'bottom', box: best.b } : null;
}

/** 竖直范围内最近的侧面：返回法线（±x / ±z），壁挂件的朝向与出挑都靠它 */
function findSide(solids, p, maxReach) {
  let best = null;
  for (const b of solids) {
    if (p.y < b.cy - b.hy || p.y > b.cy + b.hy) continue;
    const dx = p.x - b.cx, dz = p.z - b.cz;
    const ox = Math.abs(dx) - b.hx;
    const oz = Math.abs(dz) - b.hz;
    const useX = ox <= oz;
    // ★ 另一轴必须落在面的范围内 —— 否则「贴」到的其实是墙的延长线之外，
    //   锚点会飘在半空（复刻脚本抓到过 19 件这种悬空）
    if (useX ? oz > 1.0 : ox > 1.0) continue;
    const d = useX ? ox : oz;
    if (d < -0.5 || d > maxReach) continue;
    if (!best || d < best.d) {
      best = { d, b, axis: useX ? 'x' : 'z', sign: ((useX ? dx : dz) >= 0 ? 1 : -1) };
    }
  }
  if (!best) return null;
  const b = best.b;
  if (best.axis === 'x') {
    return { x: b.cx + best.sign * b.hx, y: p.y, z: p.z, kind: 'side', nx: best.sign, ny: 0, nz: 0, box: b };
  }
  return { x: p.x, y: p.y, z: b.cz + best.sign * b.hz, kind: 'side', nx: 0, ny: 0, nz: best.sign, box: b };
}

/** 从落点朝**外**走到第一面墙：壁挂件贴的应该是「这个房间的墙」，
 *  而不是「凑巧离得近的一个盒子侧面」。
 *  白模的房间很大（墙常在 30~80 stud 外），所以沿槽位给的方向步进探测，
 *  一旦走进实体就把锚点钉在刚穿过的那张面上，法线朝内（背向外）。
 *  @param slot 需要带 dirX / dirZ（单位向量，由 slots.js 按路线切向的垂直方向给出） */
function marchToWall(solids, slot, maxLen) {
  const dx = Number(slot.dirX) || 0;
  const dz = Number(slot.dirZ) || 0;
  if (!dx && !dz) return null;
  const y = slot.y;
  const step = 4;
  for (let t = 2.4; t <= maxLen; t += step) {
    const x = slot.x + dx * t;
    const z = slot.z + dz * t;
    for (const b of solids) {
      if (y < b.cy - b.hy || y > b.cy + b.hy) continue;
      const ox = Math.abs(x - b.cx) - b.hx;
      const oz = Math.abs(z - b.cz) - b.hz;
      if (ox > 0 || oz > 0) continue;              // 还没进这个盒子
      // 走进了实体 → 钉在刚穿过的那张面上（取主方向对应的面）
      if (Math.abs(dx) >= Math.abs(dz)) {
        const sx = dx >= 0 ? -1 : 1;               // 面朝内
        return { x: b.cx + sx * b.hx, y, z, kind: 'side', nx: sx, ny: 0, nz: 0, box: b };
      }
      const sz = dz >= 0 ? -1 : 1;
      return { x, y, z: b.cz + sz * b.hz, kind: 'side', nx: 0, ny: 0, nz: sz, box: b };
    }
  }
  return null;
}

function inFoot(b, p, m) {
  return p.x >= b.cx - b.hx - m && p.x <= b.cx + b.hx + m
    && p.z >= b.cz - b.hz - m && p.z <= b.cz + b.hz + m;
}

/* ============================================================
   成形后的几何：朝向 / 中心 / 包围盒 / 是否放得下
   ============================================================ */

/** 壁挂件顺着墙躺（局部 X 指向墙的切向），其余随机转；都带一点抖动免得整齐 */
function yawFor(anchor, rng) {
  const jitter = rng.range(-14, 14);
  if (anchor.kind === 'side') return (anchor.nx !== 0 ? 90 : 0) + jitter;
  return rng.range(0, 360);
}

/** 每秒 90° 的整数倍会交换轴（管道那类横放件），用它能还原真实外接尺寸 */
function quarter(deg) {
  return Math.abs(Math.round((Number(deg) || 0) / 90)) % 2 === 1;
}

/** 世界朝向下的外接尺寸：h = 竖直高度，ax/az = 水平投影（含偏航） */
function dimsOf(over) {
  const s = over.scale || [1, 1, 1];
  let w = Math.abs(Number(s[0])) || 1;
  let h = Math.abs(Number(s[1])) || 1;
  let d = Math.abs(Number(s[2])) || 1;
  const r = over.rotation || [0, 0, 0];
  if (quarter(r[0])) { const t = h; h = d; d = t; }
  if (quarter(r[2])) { const t = w; w = h; h = t; }
  const yaw = (Number(r[1]) || 0) * Math.PI / 180;
  const c = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw));
  return { w, h, d, ax: w * c + d * sn, az: w * sn + d * c };
}

/** 锚点 → 真正中心：顶面件抬半个高、倒挂件垂下去、壁挂件只出挑「厚度的一半」 */
function placeCenter(over, anchor, dim) {
  const p = over.position || [0, 0, 0];
  let cy = anchor.y;
  let cx = anchor.x;
  let cz = anchor.z;
  if (anchor.kind === 'top') cy = anchor.y + dim.h / 2;
  else if (anchor.kind === 'bottom') cy = anchor.y - dim.h / 2;
  else if (anchor.kind === 'side') {
    const out = 0.5 * Math.min(dim.ax, dim.az);
    cx = anchor.x + (anchor.nx || 0) * out;
    cz = anchor.z + (anchor.nz || 0) * out;
  }
  over.position = [round(cx, 3), round(cy, 3), round(cz, 3)];
  return over;
}

function aabbOf(over, dim) {
  const p = over.position || [0, 0, 0];
  return {
    cx: Number(p[0]) || 0, cy: Number(p[1]) || 0, cz: Number(p[2]) || 0,
    hx: dim.ax / 2, hy: dim.h / 2, hz: dim.az / 2,
  };
}

/** 放得下吗：与所有实体的重叠体积占比 ≤ 15%（贴着的那个面不计） */
function fits(solids, bb, attachBox) {
  if (!solids.length) return true;
  const vol = Math.max(1e-6, 8 * bb.hx * bb.hy * bb.hz);
  let ov = 0;
  for (const b of solids) {
    if (b === attachBox) continue;
    const ox = Math.min(bb.cx + bb.hx, b.cx + b.hx) - Math.max(bb.cx - bb.hx, b.cx - b.hx);
    if (ox <= 0) continue;
    const oy = Math.min(bb.cy + bb.hy, b.cy + b.hy) - Math.max(bb.cy - bb.hy, b.cy - b.hy);
    if (oy <= 0) continue;
    const oz = Math.min(bb.cz + bb.hz, b.cz + b.hz) - Math.max(bb.cz - bb.hz, b.cz - b.hz);
    if (oz <= 0) continue;
    ov += ox * oy * oz;
    if (ov / vol > OVERLAP_MAX) return false;
  }
  return true;
}

/* ============================================================
   蓝噪声（抖动格 + 空间哈希最小距离）
   ============================================================ */
function tooClose(hash, x, y, z, gap) {
  const cx = Math.floor(x / HASH_CELL), cz = Math.floor(z / HASH_CELL);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const list = hash.get(`${cx + i}|${cz + j}`);
      if (!list) continue;
      for (const p of list) {
        if (Math.abs(p[1] - y) > gap) continue;
        if (Math.hypot(p[0] - x, p[2] - z) < gap) return true;
      }
    }
  }
  return false;
}

function addHash(hash, x, y, z) {
  const key = `${Math.floor(x / HASH_CELL)}|${Math.floor(z / HASH_CELL)}`;
  const list = hash.get(key);
  if (list) list.push([x, y, z]);
  else hash.set(key, [[x, y, z]]);
}

/* ============================================================
   配方挑选 / 尺寸 / 配色
   ============================================================ */
/** 少用的配方优先（母题复现：1~2 个高频 + 其余点缀），同分随机 */
function pickByDistance(pool, rng, used) {
  let best = null, bestScore = Infinity;
  for (const p of pool) {
    const n = used[p.id] || 0;
    const score = n + rng.range(0, 0.9);
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best || pool[0];
}

/** 尺寸：主件 1.0，从件按黄金递退 0.6 / 0.38（跨尺度一致性）；
 *  平台边缘件刻意更小 —— 它就摆在玩家脚边，大了像路障 */
function sizeOf(kind, rng) {
  if (kind === 'farSilhouette') return rng.range(0.8, 1.6);
  if (kind === 'ledgeDress') return rng.range(0.34, 0.58);
  const r = rng.next();
  if (r < 0.52) return rng.range(0.88, 1.18);
  if (r < 0.82) return 0.6 * rng.range(0.9, 1.12);
  return 0.38 * rng.range(0.9, 1.15);
}

/** 同段一支主色 + 一支辅助色 */
function panelOf(theme, t, rng) {
  const pal = (theme && theme.palette) || {};
  const base = pal.base || '#3b3559';
  const accent = pal.accent || '#8a7a52';
  const u = clamp(Number(t) || 0, 0, 1);
  const main = mixHex(base, accent, clamp(0.25 + u * 0.5 + rng.range(-0.08, 0.08), 0, 1));
  const second = pal.glow || mixHex(base, accent, clamp(0.7 + u * 0.3, 0, 1));
  return { main, accent: second };
}

/** 槽位属于哪一段：按「最近段包围盒中心」归属（槽位只带路线采样下标，不能直接当段下标用） */
function sectionIndexOf(sections, slot) {
  const list = sections || [];
  if (!list.length) return 0;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const b = list[i].box;
    if (!b) continue;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const d = Math.hypot(slot.x - cx, slot.z - cz);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/* ---------- 小工具 ---------- */
function dist3(a, b) {
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
}

function mixHex(a, b, t) {
  const A = hex(a), B = hex(b);
  const k = clamp(Number(t) || 0, 0, 1);
  return '#' + [0, 1, 2].map((i) => Math.round(A[i] + (B[i] - A[i]) * k).toString(16).padStart(2, '0')).join('');
}
function hex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
  const v = m ? parseInt(m[1], 16) : 0x808080;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
