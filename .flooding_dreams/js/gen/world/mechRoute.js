/* ============================================================
   世界优先管线 · 机制段模板（主轴上的**必经**机制）
   ------------------------------------------------------------
   开发文档 §6.1 的红线是「机制只做旁路，绝不替换主轴上的那一跳」；
   那条红线的代价就是「只有跳跳跳」。这一层打开了 §10.1 的中期扩展：

     白模在攀登链上留出两段**特技段**（world/whitebox.js 的 FEATURE）：
       · riser 竖井：落差 15~18 stud（> 跳跃顶点 6.89）——跳不上去
       · chasm 裂谷：缺口 28~48 stud（> 平地最大跳距 10.6）——跳不过去
     中间那几级台阶被**拿掉**了，于是这一段只能靠机制过。

   本层就是「谁来接管这一段」的模板库：
     · climb  攀爬墙     —— 贴着竖井侧壁立一面可攀爬的墙（引擎 climb 对象）
     · wall   WallJump 竖井 —— 竖井两侧各立一面弹射墙，蹬墙上行
     · zip    滑索       —— 沿裂谷高挂一条缆绳，抓着飞过去
     · swim   游泳       —— 裂谷里灌一池静态水（液面压在两岸踏步面之下）

   ★ 三条硬约束（与 reach.js 的 MECH 包络一一对应）：
     ① 落点必须在包络内（checkLink 判定）——否则这一段根本不选它；
     ② 装置一律落在白模**已经挖通**的竖井 / 裂谷里（whitebox 里 clear 过），
        实心件（攀爬墙 / WallJump 墙）的偏移量按「踏步面半宽 + 1.2」算，
        绝对不会横在正常跳跃的路线上；
     ③ 主题决定优先级：城市用 WallJump（楼缝）、阈限用攀爬（走廊尽头）、
        草原用滑索（跨谷），荧渊滑索 / 攀爬各半 —— 机制也有主题性格。

   ★ 兜底：这里返回 null 时，route.js 会退回「补板搭桥」的老办法，
     所以机制段只是**更好的解**，不是新的失败点。
   ============================================================ */
import { round, clamp } from '../../core/util.js';
import { MECH, checkLink } from '../reach.js';

const DEG = Math.PI / 180;
const f2 = (v) => round(Number(v) || 0, 2);

/** 主题 → 机制偏好（feat: 'riser' | 'chasm'） */
const PREF_BY_STYLE = {
  city: { riser: ['wall', 'climb'], chasm: ['zip', 'swim'] },
  building: { riser: ['climb', 'wall'], chasm: ['swim', 'zip'] },
  rock: { riser: ['climb', 'wall'], chasm: ['zip', 'swim'] },
  meadow: { riser: ['climb', 'wall'], chasm: ['zip', 'swim'] },
};

/** 让方块**薄轴（本地 +Z）**指向水平方向 (nx, nz) 所需的 rotation.y（度）。
    three.js 的 Ry(θ) 把本地 +Z 映到 (sinθ, cosθ)，所以 θ = atan2(nx, nz)。 */
function yawZ(nx, nz) { return round(Math.atan2(nx, nz) / DEG, 1); }

/** 水平单位方向 A→B */
function dirOf(A, B) {
  const dx = B.x - A.x, dz = B.z - A.z;
  const d = Math.hypot(dx, dz);
  return d > 1e-6 ? { x: dx / d, z: dz / d, d } : { x: 1, z: 0, d: 0 };
}

/** 轴对齐方块在方向 (ux,uz) 上的支撑半径（与 route.js 同口径） */
function support(N, ux, uz) {
  const s = N && N.size;
  const w = (s && Number(s[0])) || Math.max(2, Number(N && N.hw) || 2) * 2;
  const d = (s && Number(s[1])) || Math.max(2, Number(N && N.hw) || 2) * 2;
  return Math.abs(ux) * w / 2 + Math.abs(uz) * d / 2;
}

/**
 * 沿 A→B 采样若干点，确认沿途是「通的」。
 * openAt(x,y,z) = 该点到最近实体的距离(stud)；≥ need 就说明身体放得下。
 * ★ 只采**两块踏板之间**的那一段：起终点那一格是踏板本体（实心），
 *   采到它一定判失败（早期就踩过这个坑：短裂谷永远「摆不下」）。
 */
function corridorOk(ctx, A, B, yOff, need = 3.0, n = 8, tag = '') {
  const dx = B.x - A.x, dz = B.z - A.z;
  const cd = Math.hypot(dx, dz);
  if (cd < 1e-6) return true;                         // 竖井：没有水平位移，不用查
  const ux = dx / cd, uz = dz / cd;
  const t0 = Math.min(0.42, (support(A, ux, uz) + 1.5) / cd);
  const t1 = Math.max(0.58, 1 - (support(B, -ux, -uz) + 1.5) / cd);
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * (i / n);
    const x = A.x + dx * t;
    const z = A.z + dz * t;
    const y = A.y + (B.y - A.y) * t + yOff;
    const o = ctx.openAt(x, y, z);
    if (o < need) {
      if (ctx.why) ctx.why.push(`${tag}走廊不通@${i}/${n}(t=${round(t, 2)}):${round(o, 1)}<${need}`);
      return false;
    }
  }
  return true;
}

/* ============================================================
   配方
   ============================================================ */

/** 攀爬墙：贴着竖井侧壁立一面墙 —— 墙顶高过上台，爬上去就能踩上台面 */
function buildClimb(A, B, e, ctx) {
  const { idGen, theme } = ctx;
  if (e.dy > MECH.climb.maxRise || e.dy < 0.5 || e.dist > MECH.climb.maxDist) return null;
  const hw = Math.max(2, Number(A.hw) || 3);
  // 侧向偏移：墙面离踏步边缘 1.2 stud（< climbReach 1.5，伸手就能吸附）
  const t = 2;
  const off = hw + 1.2 + t / 2;
  const ang = Number.isFinite(Number(A.angle)) ? Number(A.angle) : 0;
  const side = { x: Math.cos(ang + Math.PI / 2), z: Math.sin(ang + Math.PI / 2) };
  // 墙可以立在竖井的任一侧：挑**通**的那一侧（攀登链贴着世界边缘时，某一侧会在石头里）
  let sgn = 0, px = 0, pz = 0, o = -1;
  for (const s of [1, -1]) {
    const tx = A.x + side.x * off * s, tz = A.z + side.z * off * s;
    const to = ctx.openAt(tx, A.y + 1.5, tz);
    if (to >= 2.6) { sgn = s; px = tx; pz = tz; o = to; break; }
  }
  if (!sgn) return fail(ctx, 'climb', '两侧墙位都不通');
  const hgt = round(clamp(e.dy + 4, 8, MECH.climb.maxRise + 4), 2);
  const y = round((A.y + B.y) / 2 + 0.5, 2);
  const scale = [f2(Math.max(7, hw * 2 + 2)), hgt, t];
  const pos = [f2(px), y, f2(pz)];
  if (!ctx.sane(pos, scale)) return fail(ctx, 'climb', '尺寸非有限');
  return {
    objects: [{
      type: 'climb',
      over: {
        id: idGen('mc'),
        shape: 'block',
        position: pos,
        rotation: [0, yawZ(side.x * sgn, side.z * sgn), 0],
        scale,
        color: theme.accent,
        climbSpeed: 14, sideSpeed: 7, jumpOff: true, jumpPower: 46, holdNoInput: true,
      },
    }],
    // 诊断用：这一段的墙面朝哪儿（报告里能看出机制是怎么摆的）
    info: { kind: 'climb', off: round(off, 2), h: hgt, side: sgn },
  };
}

/** 记一条失败原因（诊断用） */
function fail(ctx, mv, msg) {
  if (ctx.why) ctx.why.push(`${mv}:${msg}`);
  return null;
}

/** WallJump 竖井：两侧各一面弹射墙，蹬墙上行 */
function buildWall(A, B, e, ctx) {
  const { idGen, theme } = ctx;
  if (e.dy > MECH.wall.maxRise || e.dy < 0.5 || e.dist > MECH.wall.maxDist) return null;
  const hw = Math.max(2, Number(A.hw) || 3);
  const t = 1.6;
  const off = hw + 1.8 + t / 2;
  const ang = Number.isFinite(Number(A.angle)) ? Number(A.angle) : 0;
  const side = { x: Math.cos(ang + Math.PI / 2), z: Math.sin(ang + Math.PI / 2) };
  const hgt = round(clamp(e.dy + 5, 9, MECH.wall.maxRise + 5), 2);
  const y = round((A.y + B.y) / 2 + 1, 2);
  const scale = [f2(Math.max(7, hw * 2 + 2)), hgt, t];
  const out = [];
  for (const s of [-1, 1]) {
    const px = A.x + side.x * off * s, pz = A.z + side.z * off * s;
    const o = ctx.openAt(px, A.y + 1.5, pz);
    if (!(o >= 2.6)) return fail(ctx, 'wall', `墙位不通 ${round(o, 1)}`);
    const pos = [f2(px), y, f2(pz)];
    if (!ctx.sane(pos, scale)) return fail(ctx, 'wall', '尺寸非有限');
    out.push({
      type: 'walljump',
      over: {
        id: idGen('mw'),
        shape: 'block',
        position: pos,
        rotation: [0, yawZ(side.x, side.z), 0],
        scale,
        color: theme.wall,
        stickTime: 1.2, pushY: 36, pushOut: 36, pushTime: 0.2, autoLaunch: false,
      },
    });
  }
  return { objects: out, info: { kind: 'wall', off: round(off, 2), h: hgt } };
}

/** 滑索：沿裂谷高挂一条缆绳（首尾在踏步面之上 3.4 stud 的抓取高度） */
function buildZip(A, B, e, ctx) {
  const { idGen, theme, params } = ctx;
  if (e.dy > MECH.zip.maxRise || e.dy < -MECH.zip.maxDrop) return null;
  if (e.dist < 4) return fail(ctx, 'zip', `缺口太小 ${round(e.dist, 1)}`);
  // 缆绳高度与「人挂在绳下」的高度都要是通的
  if (!corridorOk(ctx, A, B, 3.4, 3.0, 9, 'zip:绳')) return null;
  if (!corridorOk(ctx, A, B, -0.4, 3.0, 9, 'zip:身')) return null;
  const n = 4;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    const sag = Math.sin(s * Math.PI) * clamp(e.centerDist * 0.05, 0.4, 2.2);
    pts.push([
      f2(A.x + (B.x - A.x) * s),
      f2(A.y + (B.y - A.y) * s + 3.4 - sag),
      f2(A.z + (B.z - A.z) * s),
    ]);
  }
  const h = clamp(Number(params && params.hazard) || 0, 0, 1);
  return {
    objects: [{
      type: 'zipline',
      over: {
        id: idGen('mz'),
        points: pts,
        segModes: new Array(pts.length - 1).fill('curve'),
        speed: round(44 + h * 30, 1),
        accel: round(18 + h * 20, 1),
        exitPush: round(20 + h * 24, 1),
        color: theme.accent,
        ropeRadius: 0.2,
      },
    }],
    info: { kind: 'zip', span: round(e.centerDist, 1) },
  };
}

/** 游泳：裂谷里灌一池**静态**水（液面压在两岸踏步面之下 1.6 stud） */
function buildSwim(A, B, e, ctx) {
  const { idGen, wt, params } = ctx;
  if (e.dy > MECH.swim.maxRise || e.dy < -MECH.swim.maxDrop) return null;
  if (e.dist < 5) return fail(ctx, 'swim', `缺口太小 ${round(e.dist, 1)}`);
  // 泳道：两岸之间要有容得下身体的水下空间（白模在裂谷里下探过 2 格）
  if (!corridorOk(ctx, A, B, -2.2, 2.6, 9, 'swim:道')) return null;
  const surf = round(Math.min(A.y, B.y) - 1.6, 2);
  const depth = 8;
  const segs = 4;
  const out = [];
  const h = clamp(Number(params && params.hazard) || 0, 0, 1);
  for (let i = 0; i < segs; i++) {
    const t = (i + 0.5) / segs;
    const cx = A.x + (B.x - A.x) * t;
    const cz = A.z + (B.z - A.z) * t;
    const segLen = Math.hypot(B.x - A.x, B.z - A.z) / segs;
    const w = Math.max(8, segLen + 8);
    const pos = [f2(cx), f2(surf - depth / 2), f2(cz)];
    const scale = [f2(w), depth, f2(w)];
    if (!ctx.sane(pos, scale)) continue;
    out.push({
      type: 'liquid',
      over: {
        id: idGen('ms'),
        kind: 'water',
        position: pos, scale,
        fillLevel: 1,
        swim: true, oxygenMode: 'drain', headOnly: true, instantKill: false,
        drainRate: round(5 + h * 12, 1),
        waterResist: 0.15,
        liquidStyle: (wt && wt.liquid) || 'water',
        color: '#2f8fd8', transparency: 0.38,
        emissive: '#0a2233', emissiveIntensity: 0.18,
        roughness: 0.08, metalness: 0.3,
        castShadow: false,
      },
    });
  }
  if (!out.length) return null;
  return { objects: out, info: { kind: 'swim', surface: surf, segs: out.length } };
}

const BUILD = { climb: buildClimb, wall: buildWall, zip: buildZip, swim: buildSwim };

/* ============================================================
   主入口
   ============================================================ */
/**
 * 给一段特技段（竖井 / 裂谷）配一个**必经**机制段。
 * @param A,B  两端落脚点（攀登链上的真实台阶；带 x/y/z/hw/angle/size）
 * @param feat 'riser' | 'chasm'
 * @param ctx  { P, params, rng, idGen, theme, style, wt, measure, openAt, sane }
 * @returns null | { move, label, objects[], animations[], info }
 */
export function buildMechSegment(A, B, feat, ctx) {
  const pref = (PREF_BY_STYLE[ctx.style] || PREF_BY_STYLE.building)[feat] || [];
  if (!pref.length) return null;
  const e = ctx.measure(A, B);
  const tried = [];
  const why = [];
  const c2 = { ...ctx, why };
  for (const mv of pref) {
    if (!checkLink(ctx.P, { move: mv, dist: e.dist, dy: e.dy }).ok) { tried.push(`${mv}:包络外`); continue; }
    let r = null;
    const n0 = why.length;
    try { r = BUILD[mv](A, B, e, c2); } catch (err) { why.push(`${mv}:异常 ${err.message}`); }
    if (r && r.objects && r.objects.length) {
      return { move: mv, label: MECH[mv].label, objects: r.objects, animations: r.animations || [], info: r.info };
    }
    tried.push(`${mv}:摆不下${why.length > n0 ? '[' + why.slice(n0).join('; ') + ']' : ''}`);
  }
  if (ctx.debug) ctx.debug.push({ feat, dist: round(e.dist, 2), dy: round(e.dy, 2), tried });
  return null;
}

/** 报告用：机制段清单摘要 */
export function mechSegmentSummary(list) {
  const stats = {};
  for (const s of list || []) stats[s.move] = (stats[s.move] || 0) + 1;
  return { total: (list || []).length, stats };
}