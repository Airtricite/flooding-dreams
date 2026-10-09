/* ============================================================
   程序化装饰 · 验证层
   ------------------------------------------------------------
   M1 的头号硬指标：★ 可达性不变 ★

   口径与关卡层**完全对齐**（js/gen/navcheck.js）：
     · 有 route（realizer 的落点表 states + links）时 → **逐段证明**
       spawn→goal 的单次全局 A* 是一条更严的要求（它要求整张落点图连通），
       实测在 4/6 张生成关卡上连「装饰前」都走不通，会让不变性判定退化成
       「前后都不通」这种空洞为真 —— 所以不能拿它当主口径。
     · 没有 route（普通关卡 JSON）时 → 降级为单次 spawn→goal，并如实标注口径。

   判定：装饰前后**逐段可通行结论逐位一致**（legSig 完全相同）才算不变。
   另外单独上报 two 个事实，不做粉饰：
     · baseline.blocked / unproven —— 基线自己就有问题的段，别被 true 掩盖
     · collidableAdded —— 装饰是否新增了碰撞体（M1 恒为 0；M2 起才会 > 0，
       那时靠逐段签名继续兜住「新增的碰撞体有没有真的挡路」）
   ============================================================ */
import * as THREE from 'three';
import { NavGraph } from '../../editor/parkour-nav.js';
import { navProve } from '../navcheck.js';
import { makeParam } from '../reach.js';
import { round } from '../../core/util.js';

const DODGE = 8;               // 吸附超过这个距离就说明「请求点不在可站立面上」，标注存疑
const SCAN_SLICE = 10;         // 每次扫描推进的时间片(ms)
const DEFAULT_BUDGET = 1500;   // 单次全局证明的时间预算(ms)
const PERLEG_BUDGET = 3000;    // 单次逐段证明的时间预算(ms)
const MAX_STEPS = 200000;      // 扫描循环硬上限，防死循环

/** 会挡人的对象类型（与 builder 的碰撞口径一致） */
const COLLIDABLE = new Set(['mesh', 'poly', 'pipe', 'climb', 'walljump']);

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 关卡物理口径（与关卡层 reach.makeParam 同一套数值） */
export function paramOf(level) {
  const gs = Number(level && level.settings && level.settings.gravityScale);
  return makeParam({ gravityScale: Number.isFinite(gs) && gs > 0 ? gs : 1 });
}

/** 关卡里的碰撞体数量（「装饰没新增碰撞体」这条事实用它度量） */
export function collidableCount(level) {
  let n = 0;
  for (const o of (level && level.objects) || []) {
    if (!o || !COLLIDABLE.has(o.type)) continue;
    if (o.type === 'mesh' && (o.physicsMode || 'box') === 'none') continue;
    if (o.visible === false) continue;
    n++;
  }
  return n;
}

/**
 * 证明「起点 → 终点」可通行。
 * @param opts.states / opts.links / opts.ceilTop  生成器的落点表与连接表（给了就走逐段口径）
 * @returns { ran, mode, ok, reason, blocked, unproven, truncated, legSig, legCount,
 *            meshes, nodes, cost, snapA, snapB, ms }
 */
export function proveReachability(level, P, opts = {}) {
  const states = Array.isArray(opts.states) ? opts.states : [];
  const links = Array.isArray(opts.links) ? opts.links : [];
  if (states.length >= 2 && links.length) return provePerLeg(level, P, opts, states, links);
  return proveGlobal(level, P, opts);
}

/* ============================================================
   口径 A：逐段证明（与关卡层同口径，首选）
   ============================================================ */

function provePerLeg(level, P, opts, states, links) {
  const t0 = now();
  // 图结构（关卡层 M3）：优先用整张图的落点表 + 连接表，按逐边证明；
  // 没有图信息的老关卡退回「把主轴折线当成边」。
  const nodes = Array.isArray(opts.nodes) && opts.nodes.length >= 2 ? opts.nodes : states;
  let edges = Array.isArray(opts.edges) && opts.edges.length ? opts.edges : null;
  if (!edges) {
    edges = links.map((l, i) => ({
      from: i, to: i + 1, kind: 'main',
      move: l.move, dist: l.dist, dy: l.dy, centerDist: l.centerDist,
    }));
  }
  const realized = {
    // navcheck 只读 type / over，归一化后的对象本来就是扁平的 → 直接把对象当 over 传
    objects: (level && level.objects || []).map((o) => ({ type: o.type, over: o })),
    nodes,
    edges,
    mechLinks: Array.isArray(opts.mechLinks) ? opts.mechLinks : [],
    ceilTop: numOr(opts.ceilTop, 0),
  };

  let r;
  try {
    r = navProve(realized, P, { budgetMs: numOr(opts.budgetMs, PERLEG_BUDGET) });
  } catch (e) {
    return emptyLeg('逐段证明异常：' + (e && e.message ? e.message : e), Math.round(now() - t0));
  }

  const legs = r.legs || [];
  const bad = legs.filter((l) => !l.ok);
  return {
    ran: !!r.ran,
    mode: 'perLeg',
    ok: !!r.ok,
    reason: r.reason || '',
    blocked: numOr(r.blocked, 0),
    unproven: numOr(r.unproven, 0),
    truncated: !!r.truncated,
    mechLegs: numOr(r.mechLegs, 0),
    mechBlocked: numOr(r.mechBlocked, 0),
    legSig: legs.map((l) => (l.ok ? '1' : '0')).join(''),
    legCount: legs.length,
    badLegs: bad.slice(0, 6).map((l) => ({ i: l.i, move: l.move, reason: l.reason })),
    meshes: numOr(r.meshes, 0),
    nodes: numOr(r.nodes, 0),
    cost: NaN,
    snapA: NaN,
    snapB: NaN,
    scanMs: numOr(r.scanMs, 0),
    ms: numOr(r.ms, Math.round(now() - t0)),
  };
}

function emptyLeg(reason, ms) {
  return {
    ran: false, mode: 'perLeg', ok: false, reason, blocked: 0, unproven: 0, truncated: false,
    legSig: '', legCount: 0, badLegs: [], meshes: 0, nodes: 0,
    cost: NaN, snapA: NaN, snapB: NaN, scanMs: 0, ms,
  };
}

/* ============================================================
   口径 B：单次 spawn → goal（没有落点表时的降级口径）
   ============================================================ */

function proveGlobal(level, P, opts = {}) {
  const t0 = now();
  const budget = numOr(opts.budgetMs, DEFAULT_BUDGET);
  const empty = {
    ran: false, mode: 'global', ok: false, reason: '', blocked: 0, unproven: 0, truncated: false,
    legSig: '', legCount: 0, badLegs: [], meshes: 0, nodes: 0,
    cost: NaN, snapA: NaN, snapB: NaN, scanMs: 0, ms: 0,
  };

  const spawn = findFirst(level, 'spawn');
  const goal = findFirst(level, 'goal');
  if (!spawn || !goal) return { ...empty, reason: '关卡缺少 spawn 或 goal，无法证明' };

  const group = new THREE.Group();
  const geos = [];
  const mat = new THREE.MeshBasicMaterial();
  for (const o of (level && level.objects) || []) {
    if (!o || o.type !== 'mesh') continue;
    if ((o.physicsMode || 'box') === 'none') continue;
    if (o.visible === false) continue;
    const s = o.scale || [1, 1, 1];
    const p = o.position || [0, 0, 0];
    const g = new THREE.BoxGeometry(
      Math.max(0.01, Math.abs(numOr(s[0], 1))),
      Math.max(0.01, Math.abs(numOr(s[1], 1))),
      Math.max(0.01, Math.abs(numOr(s[2], 1))),
    );
    const m = new THREE.Mesh(g, mat);
    m.position.set(numOr(p[0], 0), numOr(p[1], 0), numOr(p[2], 0));
    m.updateMatrix();
    group.add(m);
    geos.push(g);
  }
  group.updateMatrixWorld(true);

  const cleanup = () => {
    for (const g of geos) { try { g.dispose(); } catch (e) { /* ignore */ } }
    try { mat.dispose(); } catch (e) { /* ignore */ }
  };

  if (!geos.length) {
    cleanup();
    return { ...empty, reason: '没有可站立的实体几何' };
  }

  const box = routeBox(level, spawn, goal);
  const stub = { root: group, bounds: box.clone(), objects: new Map() };
  const nav = new NavGraph({ ed: { builder: stub }, _param: () => P });

  nav.begin(box);
  let guard = 0;
  let truncated = false;
  while (nav.phase === 'sample' && guard++ < MAX_STEPS) {
    nav.step(SCAN_SLICE);
    if (now() - t0 > budget * 0.7) { truncated = true; break; }
  }
  const nodeCount = nav.count;

  if (!nav.ready || truncated) {
    cleanup();
    return { ...empty, meshes: geos.length, nodes: nodeCount, truncated, ms: Math.round(now() - t0), reason: '地形扫描未完成（超出预算）' };
  }
  if (!nav.usable) {
    cleanup();
    return { ...empty, meshes: geos.length, nodes: nodeCount, ms: Math.round(now() - t0), reason: '没扫到任何可站立的表面' };
  }
  nav.setSig([P.v0, P.sp, P.g, P.air ? 1 : 0].join(','));

  const r = nav.path(vecOf(spawn), vecOf(goal), P);
  cleanup();

  const snapA = numOr(r.snapA, NaN), snapB = numOr(r.snapB, NaN);
  return {
    ran: true,
    mode: 'global',
    ok: !!r.ok,
    reason: r.reason || '',
    blocked: r.ok ? 0 : 1,
    unproven: 0,
    truncated: false,
    legSig: r.ok ? '1' : '0',
    legCount: 1,
    badLegs: r.ok ? [] : [{ i: 0, move: '?', reason: r.reason || '走不通' }],
    meshes: geos.length,
    nodes: nodeCount,
    cost: numOr(r.cost, NaN),
    snapA, snapB,
    suspectSnap: !!(snapA > DODGE || snapB > DODGE),
    overBudget: !!nav.overBudget,
    scanMs: 0,
    ms: Math.round(now() - t0),
  };
}

/* ============================================================
   不变性
   ============================================================ */

/**
 * 可达性不变性：装饰前后各证明一次。
 * invariant = true  逐段结论逐位一致（口径 A）/ 全局结论一致（口径 B）
 * invariant = false ★ 装饰改变了某一段的可通行结论 —— 必须降强度或回退
 * invariant = null  跑不起来（缺几何/起终点），如实上报而不是假装通过
 */
export function proveInvariance(before, after, P, opts = {}) {
  if (opts.off) {
    return { invariant: null, skipped: true, reason: '按要求跳过验证', before: null, after: null, navDelta: null, legsChanged: null, collidableAdded: 0 };
  }

  /* ★ 基线复用：关卡层的 repair 已经对**同一份几何**跑过一次逐边证明，
     装饰层不必再证一遍（这是每次生成里最贵的一步之一）。
     只在「跑完了、没被预算截断」时才敢复用，否则老实地自己证一次。 */
  const reuse = opts.baseline && opts.baseline.ran && !opts.baseline.truncated
    ? opts.baseline : null;
  const a = reuse || proveReachability(before, P, opts);
  const b = proveReachability(after, P, opts);
  const bothRan = a.ran && b.ran;

  let invariant = null;
  let legsChanged = null;
  let reason = '';

  if (bothRan) {
    if (a.mode === 'perLeg') {
      if (a.legSig === b.legSig && a.legCount === b.legCount) {
        invariant = true; legsChanged = 0;
      } else {
        invariant = false;
        legsChanged = countDiff(a.legSig, b.legSig);
        reason = `装饰改变了 ${legsChanged} 段的可通行结论（逐段）`;
      }
    } else {
      invariant = a.ok === b.ok;
      legsChanged = invariant ? 0 : 1;
      if (!invariant) reason = `装饰改变了可达性（装饰前 ok=${a.ok}，装饰后 ok=${b.ok}）`;
    }
  } else {
    reason = `未证明：${a.reason || b.reason || '条件不足'}`;
  }

  const collidableAdded = collidableCount(after) - collidableCount(before);
  const navDelta = (bothRan && Number.isFinite(a.cost) && a.cost > 1e-6 && Number.isFinite(b.cost))
    ? round((b.cost - a.cost) / a.cost, 4)
    : null;

  return {
    invariant,
    skipped: false,
    mode: a.mode,
    before: a,
    after: b,
    navDelta,
    legsChanged,
    collidableAdded,
    /** 基线自己就有问题的段落 —— 不要因为有 invariant=true 就以为这张图没问题 */
    baseline: bothRan ? { blocked: a.blocked, unproven: a.unproven, truncated: a.truncated } : null,
    reason,
  };
}

/** 两个签名在第几个位置起不一样（含长度不一致） */
function countDiff(sa, sb) {
  let n = 0;
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) if (sa[i] !== sb[i]) n++;
  return n;
}

/**
 * 把关卡层 navcheck 的逐边结果，转成装饰层「基线」的形状 ——
 * 这样装饰层可以复用关卡层刚跑过的证明，而不必对同一份几何再证一遍。
 * 只要有任何不确定（没跑 / 没采到几何 / 被预算截断 / 一条边都没证），
 * 一律返回 null，让调用方老老实实自己证 —— 绝不拿半份结果冒充基线。
 */
export function baselineFromNav(nav) {
  if (!nav || !nav.ran || nav.truncated) return null;
  const legs = nav.legs || [];
  if (!legs.length) return null;
  return {
    ran: true,
    mode: 'perLeg',
    ok: !!nav.ok,
    reason: nav.reason || '',
    blocked: numOr(nav.blocked, 0),
    unproven: numOr(nav.unproven, 0),
    truncated: false,
    legSig: legs.map((l) => (l.ok ? '1' : '0')).join(''),
    legCount: legs.length,
    badLegs: legs.filter((l) => !l.ok).slice(0, 6).map((l) => ({ i: l.i, move: l.move, reason: l.reason })),
    meshes: numOr(nav.meshes, 0),
    nodes: numOr(nav.nodes, 0),
    cost: NaN,
    snapA: NaN,
    snapB: NaN,
    scanMs: numOr(nav.scanMs, 0),
    ms: numOr(nav.ms, 0),
    fromNav: true,
  };
}

/* ============================================================
   装饰指纹（开发文档 §8.2 的可算部分）
   M2/M3 才会补 clutter（局部密度熵）与 motifEntropy（母题分布熵）——
   那两项要等地标与微件落地后才有意义，这里如实不填。
   ⚠ 传进来的 deco 必须是「已合并的描述」（{ type, ...over }）：
     只传 over 会读不到 type，litRatio / fxCount 会恒为 0。
   ============================================================ */

export function decorFingerprint({ theme, strength, deco, fields, navDelta }) {
  const list = deco || [];
  const n = Math.max(1, list.length);
  let sumY = 0, sumY2 = 0, lit = 0, fx = 0;
  const colors = new Set();
  for (const o of list) {
    const p = o.position || [0, 0, 0];
    const y = numOr(p[1], 0);
    sumY += y; sumY2 += y * y;
    if (o.color) colors.add(bucketColor(o.color));
    const emits = o.type === 'light' || o.type === 'volumelight'
      || (o.type === 'emitter' && o.soft === false);
    if (emits) lit++;
    if (o.type === 'light' || o.type === 'volumelight' || o.type === 'fogvol'
      || o.type === 'emitter' || o.type === 'postfx') fx++;
  }
  const meanY = sumY / n;
  const varY = Math.max(0, sumY2 / n - meanY * meanY);

  return {
    themeId: theme ? theme.id : '',
    strength: round(numOr(strength, 0), 2),
    decoCount: list.length,
    density: round(list.length / Math.max(1, routeLength(fields)), 4),
    verticality: round(Math.sqrt(varY), 2),
    colorSpread: colors.size,
    litRatio: round(lit / n, 3),
    fxCount: fx,
    navDelta: navDelta === null || navDelta === undefined ? null : navDelta,
  };
}

/* ============================================================
   小工具
   ============================================================ */

function vecOf(o) {
  const p = o.position || [0, 0, 0];
  return new THREE.Vector3(numOr(p[0], 0), numOr(p[1], 0), numOr(p[2], 0));
}

/** 包住所有几何 + 起终点的包围盒（上界抬高，避免射线从内部起射） */
function routeBox(level, spawn, goal) {
  const box = new THREE.Box3();
  for (const o of (level && level.objects) || []) {
    if (!o || o.type !== 'mesh') continue;
    if ((o.physicsMode || 'box') === 'none' || o.visible === false) continue;
    const p = o.position || [0, 0, 0];
    const s = o.scale || [1, 1, 1];
    const hx = Math.abs(numOr(s[0], 1)) / 2 + 1;
    const hy = Math.abs(numOr(s[1], 1)) / 2 + 1;
    const hz = Math.abs(numOr(s[2], 1)) / 2 + 1;
    const x = numOr(p[0], 0), y = numOr(p[1], 0), z = numOr(p[2], 0);
    box.expandByPoint(new THREE.Vector3(x - hx, y - hy, z - hz));
    box.expandByPoint(new THREE.Vector3(x + hx, y + hy, z + hz));
  }
  box.expandByPoint(vecOf(spawn));
  box.expandByPoint(vecOf(goal));
  if (box.isEmpty()) return new THREE.Box3(new THREE.Vector3(-20, -20, -20), new THREE.Vector3(20, 40, 20));
  const min = box.min.clone(), max = box.max.clone();
  min.y -= 4;
  max.y += 16;
  return new THREE.Box3(min, max);
}

/** 路线折线总长（用于密度归一化） */
function routeLength(fields) {
  const r = (fields && fields.route) || [];
  let len = 0;
  for (let i = 1; i < r.length; i++) {
    len += Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y, r[i].z - r[i - 1].z);
  }
  if (len < 1e-3 && fields && fields.bounds) {
    const b = fields.bounds;
    len = Math.max(1, Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z));
  }
  return len;
}

/** 颜色粗分桶：把相近色算作同一种，避免凉点噪声让颜色数虚高 */
function bucketColor(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c));
  if (!m) return String(c);
  const v = parseInt(m[1], 16);
  const q = (x) => Math.round(x / 48);
  return `${q((v >> 16) & 255)},${q((v >> 8) & 255)},${q(v & 255)}`;
}

function findFirst(level, type) {
  for (const o of (level && level.objects) || []) if (o && o.type === type) return o;
  return null;
}

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}