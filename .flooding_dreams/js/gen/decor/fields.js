/* ============================================================
   程序化装饰 · L1 语义场层
   ------------------------------------------------------------
   从「已经生成的关卡 JSON」里解析出几张可查询的空间场，
   让后续的装饰知道「哪里能放、往哪贴、水面在哪」：

     · pass(p)    到路线走廊的最近距离（负数 = 落在走廊内）
                  → 可碰撞装饰的唯一红线，M2 起微件散布的密度权重
     · attach(p)  到最近可附着表面的距离与朝向（顶 / 壁 / 底）
                  → 微件的贴附方式（M2 用）
     · waterY     液面高程（没有液体时为 null）
     · structure  主导世界结构（有 meta.generated 就用它，否则从 settings 反推）
     · hasCeiling 是否有顶（决定能不能用「顶挂」与光柱）

   M1 的装饰全是无碰撞的氛围件，所以这里只做「直接查询」就够用；
   等 M2 要批量撒微件时再给 pass / attach 加格点缓存与三线性插值。

   ⚠ 路线近似：生成器调用时请把 realizer 的落点表（states）通过 opts.route 传进来；
     直接装饰一份普通关卡 JSON 时，这里用「从起点出发、偏向上的最近邻链」
     近似恢复路线顺序 —— 只用于算走廊距离，不参与任何可达性判定。
   ============================================================ */
import { clamp, round } from '../../core/util.js';
import { isShellKey } from '../shell.js';

/** 有顶的结构（决定顶挂装饰与光柱是否可用） */
const CEILING_SHELLS = new Set(['sheltered', 'indoor', 'shaft', 'cavern']);

const MAX_ROUTE = 400;     // 路线采样上限（够用且避免 O(n²) 失控）

export function makeFields(level, opts = {}) {
  const solids = collectSolids(level);
  const route = opts.route && opts.route.length
    ? fromStates(opts.route)
    : fromLevel(level, solids);
  const structure = inferStructure(level);
  const waterY = findWaterY(level);
  const bounds = boundsOf(route, solids);

  return {
    structure,
    hasCeiling: CEILING_SHELLS.has(structure),
    waterY,
    route,
    solids,
    bounds,

    /** 到走廊表面的最近距离；< 0 表示点在走廊内 */
    pass(p) {
      let best = Infinity;
      for (const s of route) {
        const d = Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) - s.r;
        if (d < best) best = d;
      }
      return best;
    },

    /** 到最近可附着面的距离与朝向；返回 null 表示附近没有可附着面 */
    attach(p) {
      let best = null;
      for (const b of solids) {
        const dx = Math.abs(p.x - b.cx) - b.hx;
        const dy = Math.abs(p.y - b.cy) - b.hy;
        const dz = Math.abs(p.z - b.cz) - b.hz;
        const ox = Math.max(dx, 0), oy = Math.max(dy, 0), oz = Math.max(dz, 0);
        const dist = (dx <= 0 && dy <= 0 && dz <= 0)
          ? -Math.min(-dx, -dy, -dz)                       // 在盒内 → 负距离
          : Math.hypot(ox, oy, oz);
        if (best && dist >= best.dist) continue;
        // 朝向取「相对半尺寸超出最多」的那一轴：顶面(1) / 底面(-1) / 壁面(0)
        const sx = dx / Math.max(1e-3, b.hx);
        const sy = dy / Math.max(1e-3, b.hy);
        const sz = dz / Math.max(1e-3, b.hz);
        let kind = 'side', ny = 0;
        if (sy >= sx && sy >= sz) { kind = p.y >= b.cy ? 'top' : 'bottom'; ny = p.y >= b.cy ? 1 : -1; }
        best = { dist, kind, ny, box: b };
      }
      return best;
    },

    /** 按归一化位置 u∈[0,1] 取走廊采样点（fx 锚点用） */
    sampleAt(u) {
      const n = route.length;
      if (!n) return null;
      if (n === 1) {
        const s = route[0];
        return { x: s.x, y: s.y, z: s.z, r: s.r };
      }
      const t = clamp(Number(u) || 0, 0, 1) * (n - 1);
      const i = Math.min(n - 2, Math.floor(t));
      const f = t - i;
      const a = route[i], b = route[i + 1];
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        r: a.r + (b.r - a.r) * f,
      };
    },

    /** 把走廊点沿「垂直于行进方向」平移到走廊外侧（dist 为外移距离） */
    aside(sample, dist, side) {
      if (!sample) return null;
      const dir = tangentAt(route, sample);
      const px = -dir.z, pz = dir.x;                       // 水平法线
      const s = side || 1;
      return {
        x: round(sample.x + px * dist * s, 3),
        y: round(sample.y, 3),
        z: round(sample.z + pz * dist * s, 3),
      };
    },
  };
}

/* ============================================================
   采集
   ============================================================ */

/** 可站立的实体盒（只认 mesh；水平方向按「绕 Y 旋转后的 AABB」算，偏保守） */
function collectSolids(level) {
  const out = [];
  for (const o of (level && level.objects) || []) {
    if (!o || o.type !== 'mesh') continue;
    if ((o.physicsMode || 'box') === 'none') continue;
    if (o.visible === false) continue;
    const p = o.position || [0, 0, 0];
    const s = o.scale || [1, 1, 1];
    const r0 = Math.max(0.01, Math.abs(Number(s[0]) || 1) / 2);
    const hy = Math.max(0.01, Math.abs(Number(s[1]) || 1) / 2);
    const r2 = Math.max(0.01, Math.abs(Number(s[2]) || 1) / 2);
    // M5 的机制（输送带 / 移动平台）是**转过角度**的方块：轴的半宽要按旋转后的
    // 投影算，否则装饰会挂到一块并不存在的位置上。
    const th = (Number((o.rotation || [0, 0, 0])[1]) || 0) * Math.PI / 180;
    const c = Math.abs(Math.cos(th)), sn = Math.abs(Math.sin(th));
    const hx = r0 * c + r2 * sn;
    const hz = r0 * sn + r2 * c;
    out.push({
      cx: Number(p[0]) || 0, cy: Number(p[1]) || 0, cz: Number(p[2]) || 0,
      hx, hy, hz,
      top: (Number(p[1]) || 0) + hy,
      r: Math.min(hx, hz),
    });
  }
  return out;
}

/** 生成器给的落点表 → 走廊采样 */
function fromStates(states) {
  return states.slice(0, MAX_ROUTE).map((s) => ({
    x: Number(s.x) || 0,
    y: Number(s.y) || 0,
    z: Number(s.z) || 0,
    r: Math.max(1.2, Number(s.hw) || 2),
  }));
}

/**
 * 从关卡 JSON 近似恢复路线：
 * 候选点 = 起点 + 所有实体盒的顶面中心 + 终点，
 * 从起点出发按「最近邻 + 向上偏好」串成一条链。
 */
function fromLevel(level, solids) {
  const cands = [];
  const spawn = findFirst(level, 'spawn');
  const goal = findFirst(level, 'goal');
  if (spawn) cands.push(pt(spawn, 2));
  for (const b of solids) cands.push({ x: b.cx, y: b.top, z: b.cz, r: b.r });
  if (goal) cands.push(pt(goal, 2));

  if (cands.length <= 1) return cands.slice();
  const startIx = spawn ? 0 : lowestIx(cands);
  const used = new Array(cands.length).fill(false);
  const chain = [];
  let cur = cands[startIx];
  used[startIx] = true;
  chain.push(cur);

  while (chain.length < Math.min(cands.length, MAX_ROUTE)) {
    let bestIx = -1, bestCost = Infinity;
    for (let i = 0; i < cands.length; i++) {
      if (used[i]) continue;
      const c = cands[i];
      const dh = Math.hypot(c.x - cur.x, c.z - cur.z);
      const dy = c.y - cur.y;
      const cost = dh + Math.max(0, dy) * 1.5;           // 偏向上：路线是「一直往上逃」
      if (cost < bestCost) { bestCost = cost; bestIx = i; }
    }
    if (bestIx < 0) break;
    used[bestIx] = true;
    cur = cands[bestIx];
    chain.push(cur);
  }
  return chain;
}

/** 主导世界结构：优先用生成器写在 meta 里的，其次从 settings 反推 */
export function inferStructure(level) {
  const g = (level && level.meta && level.meta.generated) || null;
  if (g && isShellKey(g.dominantStructure)) return g.dominantStructure;
  if (g && Array.isArray(g.structures) && g.structures.length) {
    const tally = new Map();
    for (const s of g.structures) if (isShellKey(s)) tally.set(s, (tally.get(s) || 0) + 1);
    let best = null, bn = -1;
    for (const [k, n] of tally) if (n > bn) { best = k; bn = n; }
    if (best) return best;
  }
  // 手工关卡没有 meta.generated → 用雾的浓度当「封闭程度」的代理
  const st = (level && level.settings) || {};
  const far = Number(st.fog && st.fog.far) || 0;
  if (st.sky === 'none') return 'cavern';
  if (far && far <= 500) return 'indoor';
  if (far && far <= 1100) return 'sheltered';
  if (far && far <= 1900) return 'outdoor';
  return 'openAir';
}

/** 液面高程（M1 只处理轴对齐的液体体积；没有液体返回 null） */
function findWaterY(level) {
  let top = null;
  for (const o of (level && level.objects) || []) {
    if (!o || o.type !== 'liquid') continue;
    const p = o.position || [0, 0, 0];
    const s = o.scale || [1, 1, 1];
    const fill = Number.isFinite(Number(o.fillLevel)) ? clamp(Number(o.fillLevel), 0, 1) : 1;
    const t = (Number(p[1]) || 0) + Math.max(0.01, Math.abs(Number(s[1]) || 1)) * 0.5 * fill;
    if (top === null || t > top) top = t;
  }
  return top;
}

function boundsOf(route, solids) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const acc = (x, y, z, r) => {
    min.x = Math.min(min.x, x - r); max.x = Math.max(max.x, x + r);
    min.y = Math.min(min.y, y - r); max.y = Math.max(max.y, y + r);
    min.z = Math.min(min.z, z - r); max.z = Math.max(max.z, z + r);
  };
  for (const s of route) acc(s.x, s.y, s.z, s.r);
  for (const b of solids) acc(b.cx, b.cy, b.cz, Math.max(b.hx, b.hz));
  if (!isFinite(min.x)) { min.x = min.y = min.z = 0; max.x = max.y = max.z = 0; }
  return { min, max };
}

/* ---------- 小工具 ---------- */

/** 路线在采样点处的水平切线（用前后邻居估计） */
function tangentAt(route, s) {
  if (route.length < 2) return { x: 1, z: 0 };
  let best = 0, bd = Infinity;
  for (let i = 0; i < route.length; i++) {
    const d = Math.hypot(route[i].x - s.x, route[i].z - s.z);
    if (d < bd) { bd = d; best = i; }
  }
  const a = route[Math.max(0, best - 1)];
  const b = route[Math.min(route.length - 1, best + 1)];
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  return len > 1e-4 ? { x: dx / len, z: dz / len } : { x: 1, z: 0 };
}

function pt(o, r) {
  const p = o.position || [0, 0, 0];
  return { x: Number(p[0]) || 0, y: Number(p[1]) || 0, z: Number(p[2]) || 0, r };
}

function findFirst(level, type) {
  for (const o of (level && level.objects) || []) if (o && o.type === type) return o;
  return null;
}

function lowestIx(cands) {
  let ix = 0;
  for (let i = 1; i < cands.length; i++) if (cands[i].y < cands[ix].y) ix = i;
  return ix;
}