/* ============================================================
   程序化生成 · 可达性解析层
   ------------------------------------------------------------
   把「这一步跳得过去吗」变成闭式不等式，用来在铺几何之前 / 之后
   做微秒级的自检，避免对每个候选都打射线。
   物理口径与 js/editor/parkour-nav.js 的纯函数、js/player/player.js 完全一致：
     · 起跳直接赋初速 jumpPower
     · 空中按 airAccel 从 0 加速到 walkSpeed（原地起跳才需要加速）
     · 下落速度被 maxFallSpeed 硬截断
   本文件只依赖 config.js 的数值，不引 three，可以脱离浏览器跑。
   ⚠ M5 计划把 parkour-nav.js 的纯函数与这里合并成唯一一份，届时以其中一处为准。
   ============================================================ */
import { PHYS, PLAYER } from '../config.js';

/** 生成一套参考物理口径 p（字段与 parkour.js 的 _param() 保持一致） */
export function makeParam(opt = {}) {
  const gs = Number(opt.gravityScale);
  return {
    v0: Number.isFinite(opt.jumpPower) ? opt.jumpPower : PLAYER.jumpPower,
    sp: Number.isFinite(opt.speed) ? opt.speed : PLAYER.walkSpeed,
    g: PHYS.gravity * (Number.isFinite(gs) && gs > 0 ? gs : 1),
    air: !!opt.air,
  };
}

/* ---------- 纯函数（与 parkour-nav.js 逐行同口径） ---------- */

export function jumpApex(p) { return p.v0 * p.v0 / (2 * p.g); }

/** 水平位移随时间：跑动起跳恒速；原地起跳先按 airAccel 加速到上限再匀速 */
export function distAt(t, p) {
  if (!p.air) return p.sp * t;
  const a = PLAYER.airAccel;
  const t1 = p.sp > 0 ? Math.min(t, p.sp / a) : 0;
  return 0.5 * a * t1 * t1 + p.sp * Math.max(0, t - t1);
}

/** 自由落体在 t 时刻已下落的距离（速度被 maxFallSpeed 截断） */
export function dropAt(t, p) {
  if (t <= 0) return 0;
  const g = p.g, vm = PLAYER.maxFallSpeed, t1 = vm / g, h1 = 0.5 * g * t1 * t1;
  return t <= t1 ? 0.5 * g * t * t : h1 + vm * (t - t1);
}

/** 自由下落 h 格所需时间（含最大下落速度截断） */
export function dropTime(h, p) {
  if (h <= 0) return 0;
  const g = p.g, vm = PLAYER.maxFallSpeed, t1 = vm / g, h1 = 0.5 * g * t1 * t1;
  return h <= h1 ? Math.sqrt(2 * h / g) : t1 + (h - h1) / vm;
}

/** 跳跃相对起跳点的高度随时间 */
export function jumpY(t, p) {
  const ta = p.v0 / p.g;
  if (t <= ta) return p.v0 * t - 0.5 * p.g * t * t;
  return jumpApex(p) - dropAt(t - ta, p);
}

/** 跳跃到相对高度 dy（可为负）所需时间；dy 高于跳跃顶点时返回 NaN */
export function jumpTime(dy, p) {
  const apex = jumpApex(p);
  if (dy > apex) return NaN;
  return p.v0 / p.g + dropTime(apex - dy, p);
}

export function hangTime(p) { return jumpTime(0, p); }

/** 跑动 d 距离所需时间 */
export function runTime(d, p) { return d / Math.max(1e-3, p.sp); }

/* ---------- 派生的「设计尺度」 ---------- */

/** 平地最大跳距（水平，起跳与落点同高） */
export function maxJumpDist(p) { return distAt(hangTime(p), p); }

/** 落到相对高度 dy 处时最多能跨多远（水平）；dy 超过顶点 → NaN */
export function jumpReach(p, dy) {
  const t = jumpTime(dy, p);
  return Number.isFinite(t) ? distAt(t, p) : NaN;
}

/** 玩家抬脚高度（台阶 / 走路能上的落差） */
export const STEP_H = PLAYER.stepHeight;

/** 站人需要的净空高度（身体总高），用于天花板钳制 */
export const BODY_H = PLAYER.totalH;

/**
 * 有顶外壳所需的最小天花板高度。
 * ★ 不能只留「站直的身高」：任何一次跳跃的抛物线都会升到 jumpApex(≈6.89 stud)，
 *   所以顶点处的头顶高度 = apex + 身高，天花板底面必须高过它。
 *   pad 再留一点余量（天花板板块自身的厚度等）。
 */
export function minCeiling(p, pad = 1) { return pad + jumpApex(p) + BODY_H + 2; }

/** 落差是否在「抬脚就能上/下」的范围里（留 8% 余量） */
export function canStep(dy) { return Math.abs(dy) <= STEP_H * 0.92; }

/* ---------- 判定 ---------- */

/**
 * 跳跃：水平缺口 dist（edge-to-edge）、落差 dy 是否够得到。
 * 返回 { ok, t, reach, margin }；margin = reach - dist（负数表示够不到）。
 */
export function canJump(p, dist, dy) {
  const t = jumpTime(dy, p);
  if (!Number.isFinite(t)) return { ok: false, t: NaN, reach: NaN, margin: -Infinity };
  const reach = distAt(t, p);
  return { ok: dist <= reach, t, reach, margin: reach - dist };
}

/**
 * 自由下落：从起跳平台边沿跑出去，落到低处 |dy| 的位置。
 * dist 是 edge-to-edge 的保守缺口，所以可用射程就是 水平速度 × 下落时间
 * （跑到边沿那段是在地面上跑的，不计入空中射程）。
 */
export function canDrop(p, dist, dy) {
  const h = -dy;
  if (!(h > 0)) return { ok: false, t: 0, reach: 0, margin: -Infinity };
  const t = dropTime(h, p);
  const reach = p.sp * t;
  return { ok: dist <= reach, t, reach, margin: reach - dist };
}

/** 走路：落差在抬脚范围内即可（连续地面，无缺口） */
export function canWalk(p, dist, dy) {
  const ok = canStep(dy);
  return { ok, t: ok ? runTime(dist, p) : NaN, reach: Infinity, margin: ok ? 1 : -1 };
}

/* ============================================================
   机制边（M6）：滑索 / 攀爬 / WallJump / 游泳
   ------------------------------------------------------------
   开发文档 §10.1 的中期扩展落在这一节：主轴不再只有「跳 / 落 / 走」，
   世界白模（world/whitebox.js）会在攀登链上留出**竖井 / 裂谷**两段特技段，
   由机制段模板（world/mechRoute.js）用滑索 / 攀爬 / WallJump / 游泳接管。

   ★ 这里给的是**保守包络**，不是逐帧模拟：
     包络内的落点，模板一定能摆出对应装置（几何 + 无碰撞一起保证）。
     物理口径对齐 config.js：
       zipline speed=52 accel=22 exitPush=26
       climb   climbSpeed=14 sideSpeed=7 climbReach=1.5
       walljump pushY=36 pushOut=36 stickTime=1.2
       swim    swimSpeed=22 waterLeap=70
     超时估算（时间）用于「跑图占比」，取量级即可（真人在这些段上乘 2~2.5 倍）。
   ============================================================ */
export const MECH_MOVES = ['zip', 'climb', 'wall', 'swim'];

export const MECH = {
  /** 滑索：沿绳飞行 —— 水平射程远超跳跃，但**上坡有限**（靠 exitPush 兜一点）。
      裂谷是一级之内横跨过去的（高度也涨一级），所以 maxRise 要容得下 1 个体素 = 4~6 stud。 */
  zip: { label: '滑索', maxDist: 46, maxRise: 8, maxDrop: 26, speed: 52 },
  /** 游泳：水平慢但稳，落差很小（水面基本是平的） */
  swim: { label: '游泳', maxDist: 34, maxRise: 7, maxDrop: 10, speed: 22 },
  /** 攀爬墙：竖直为主，吸附半径内的横向也能跟一点 */
  climb: { label: '攀爬', maxDist: 10, maxRise: 24, maxDrop: 3, speed: 14 },
  /** WallJump 竖井：蹬墙弹射，一次蹬墙抬一大截 */
  wall: { label: 'WallJump', maxDist: 8, maxRise: 28, maxDrop: 3, speed: 30 },
};

export function isMechMove(mv) { return MECH_MOVES.includes(mv); }

/**
 * 机制边判定：dist 是 edge-to-edge 的水平缺口，dy 是落差。
 * 返回 { ok, t, reach, margin }（与 canJump 同构，verify 层直接用 t）。
 */
export function canMechMove(p, mv, dist, dy) {
  const m = MECH[mv];
  if (!m) return { ok: false, t: NaN, reach: NaN, margin: -Infinity };
  const d = Math.max(0, Number(dist) || 0);
  const y = Number(dy) || 0;
  const ok = d <= m.maxDist && y <= m.maxRise && y >= -m.maxDrop;
  // 耗时：走完这一段装置的时间（水平 / 竖直各按自己的速度）
  const t = ok
    ? Math.max(0.35, (mv === 'climb' || mv === 'wall' ? Math.abs(y) / m.speed : d / m.speed) + 0.35)
    : NaN;
  const reach = m.maxDist;
  return { ok, t, reach, margin: ok ? reach - d : -Infinity };
}

/** 统一入口：按连接方式判定 */
export function checkLink(p, link) {
  const dist = Math.max(0, Number(link.dist) || 0);
  const dy = Number(link.dy) || 0;
  switch (link.move) {
    case 'walk': return canWalk(p, dist, dy);
    case 'fall': return canDrop(p, dist, dy);
    case 'rest': return { ok: true, t: 0, reach: Infinity, margin: 1 };
    case 'zip': case 'climb': case 'wall': case 'swim':
      return canMechMove(p, link.move, dist, dy);
    case 'jump':
    default: return canJump(p, dist, dy);
  }
}
