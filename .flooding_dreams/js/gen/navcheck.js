/* ============================================================
   程序化生成 · NavGraph 全局证明（M2）
   ------------------------------------------------------------
   解析自检（reach.js）只看「两个落点之间的距离够不够」，
   它不知道两个落点之间有没有东西挡着 —— 一堵墙、一块天花板、
   一块伸出来的平台，都能让「数学上够得着」的一跳变成不可能。
   这里把生成的几何原样塞进一个临时 THREE 场景，借编辑器那套
   NavGraph（表面落点采样 + A* + 弧线逐段射线净空）在真实几何上
   把整条路线逐段走一遍。

   为什么不直接 new LevelBuilder：
     · 我们只需要「能打射线的盒子」。LevelBuilder 还会顺带做顶点 AO
       烘焙、贴图注册、物理世界初始化 —— 对一次性验证纯属浪费；
     · NavGraph 只依赖 builder.root / bounds / objects 三个字段，塞一个
       stub 就够，而且判定行为完全一致：
       不设 userData.objectId 就不会被 NO_PHYSICS 当成不可站立而跳过。

   ⚠ 已知边界：NavGraph 的落点采样是网格制（CELL 与自适应步长 2~5 stud），
   比采样步长还窄的平台可能一个落点都没采到。这种情况不会被误判为
   「通过」，而是单独记为 unproven（未证明）并把原因报出来，
   由调用方决定是重试还是接受「仅解析自检」。
   ============================================================ */
import * as THREE from 'three';
import { NavGraph } from '../editor/parkour-nav.js';
import { isMechMove } from './reach.js';

const HINT_ALLOW = 0.6;       // 落点吸附容差(stud)：超出说明该平台没被采样覆盖
const MAX_LEGS = 400;         // 逐边证明的边数上限（再多就截断并如实上报）
const DEFAULT_BUDGET = 9000;  // 整趟证明的时间预算(ms)：图变长后要给够
const SCAN_SLICE = 10;        // 每次扫描推进的时间片(ms)

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');

/**
 * 在真实几何上逐段证明整条路线。
 * @param realized  realizer 的产物（objects / links / states / shell）
 * @param P         物理口径（与 reach.js 的 makeParam 同构）
 * @returns {
 *   ran, ok, blocked, unproven, truncated, reason,
 *   legs[], meshes, nodes, scanMs, ms
 * }
 *   ok        = 全部段落都被证明可通行（blocked / unproven / truncated 全为 0）
 *   blocked   = 真实几何判定「走不通」的段数（需要重试换图）
 *   unproven  = 因采样分辨率不足而无法证明的段数（不算失败，但要如实上报）
 */
export function navProve(realized, P, opts = {}) {
  const t0 = now();
  const nodes = (realized && realized.nodes) || [];
  const edges = (realized && realized.edges) || [];
  const empty = { ran: true, ok: false, blocked: 0, unproven: 0, truncated: false, mechLegs: 0, mechBlocked: 0, legs: [], meshes: 0, nodes: 0, scanMs: 0, ms: 0 };

  if (edges.length < 1) return { ...empty, reason: '没有需要证明的连接' };

  /* ---------- 1. 把生成出来的实体方块搭成临时场景 ---------- */
  const group = new THREE.Group();
  const geos = [];
  const mat = new THREE.MeshBasicMaterial();
  for (const d of (realized.objects || [])) {
    if (!d || d.type !== 'mesh') continue;
    const o = d.over || {};
    if ((o.physicsMode || 'box') === 'none') continue;    // 无碰撞 → 不参与寻路
    if (o.visible === false) continue;
    const s = o.scale || [1, 1, 1];
    const p = o.position || [0, 0, 0];
    const g = new THREE.BoxGeometry(
      Math.max(0.01, Number(s[0]) || 1),
      Math.max(0.01, Number(s[1]) || 1),
      Math.max(0.01, Number(s[2]) || 1),
    );
    const m = new THREE.Mesh(g, mat);
    m.position.set(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
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

  /* ---------- 2. 组装 stub builder 并扫描地形 ---------- */
  const box = routeBox(nodes, realized.ceilTop);
  const stub = { root: group, bounds: box.clone(), objects: new Map() };
  const nav = new NavGraph({ ed: { builder: stub }, _param: () => P });

  nav.begin(box);
  let guard = 0;
  while (nav.phase === 'sample' && guard++ < 200000) nav.step(SCAN_SLICE);
  const scanMs = now() - t0;
  const nodeCount = nav.count;

  if (!nav.ready) {
    cleanup();
    return { ...empty, meshes: geos.length, scanMs, ms: now() - t0, reason: '地形扫描未完成' };
  }
  if (!nav.usable) {
    cleanup();
    return { ...empty, meshes: geos.length, scanMs, ms: now() - t0, reason: '没扫到任何可站立的表面' };
  }
  nav.setSig([P.v0, P.sp, P.g, P.air ? 1 : 0].join(','));
  // ★ 主轴上的必经机制段（滑索 / 攀爬 / WallJump / 游泳）：接进落点图，
  //   否则「世界优先管线」特技段那几条边会被判成 blocked（它们本来就跳不过去）。
  if (realized.mechLinks && realized.mechLinks.length) nav.setMech(realized.mechLinks);

  /* ---------- 3. 逐边 A* 证明 ----------
     图结构下不再按「相邻落点」迭代，而是遍历**每一条边**：
     主轴边守住 spawn→goal 的保底路线，环台边与岔路边守住所有可选路线。 */
  const budget = Number(opts.budgetMs) || DEFAULT_BUDGET;
  const legs = [];
  let blocked = 0, unproven = 0, truncated = false, overBudget = false;
  let mechLegs = 0, mechBlocked = 0;

  for (let i = 0; i < edges.length; i++) {
    if (i >= MAX_LEGS) { truncated = true; break; }
    if (now() - t0 > budget) { truncated = true; break; }

    const e = edges[i];
    const a = nodes[e.from], b = nodes[e.to];
    if (!a || !b) { unproven++; continue; }

    /* ★ 机制边（滑索 / 攀爬 / WallJump / 游泳）：走**直接证明**，不进 A*。
       它们本来就跳不过去，A*（只认 run/jump/fall）会给假阴性。 */
    if (isMechMove(e.move)) {
      mechLegs++;
      const pm = nav.proveMech(
        new THREE.Vector3(a.x, a.y, a.z),
        new THREE.Vector3(b.x, b.y, b.z),
        e.move,
      );
      legs.push({
        i, kind: e.kind || 'main', move: e.move, from: e.from, to: e.to,
        ok: !!pm.ok, mech: true, reason: pm.reason || '',
        snapA: pm.snapA, snapB: pm.snapB, ms: 0, expanded: 0,
      });
      if (!pm.ok) { mechBlocked++; blocked++; }
      continue;
    }

    const r = nav.path(
      new THREE.Vector3(a.x, a.y, a.z),
      new THREE.Vector3(b.x, b.y, b.z),
      P,
    );
    const leg = {
      i,
      kind: e.kind || 'main',
      move: e.move,
      from: e.from,
      to: e.to,
      ok: false,
      reason: '',
      snapA: r.snapA,
      snapB: r.snapB,
      ms: r.ms,
      expanded: r.expanded,
    };
    if (r.overBudget) { leg.overBudget = true; overBudget = true; }

    if (r.ok) {
      // 吸附超限 = 请求点被吸附到了别的平台（多半是目标平台没被采样到），
      // 这时 ok 很可能是「两个点都吸附到同一块平台」的假通过，必须拦掉
      const limA = (Number(a.hw) || 2) + HINT_ALLOW;
      const limB = (Number(b.hw) || 2) + HINT_ALLOW;
      if ((r.snapA || 0) <= limA && (r.snapB || 0) <= limB) {
        leg.ok = true;
      } else {
        leg.reason = `落点吸附超限（${f2(r.snapA)}/${f2(r.snapB)} > ${f2(limA)}/${f2(limB)}）`
          + '：该平台没被落点采样覆盖';
        unproven++;
      }
    } else if (/没有可站立的表面/.test(r.reason || '')) {
      leg.reason = (r.reason || '') + '（该平台没被落点采样覆盖）';
      unproven++;
    } else {
      leg.reason = r.reason || '这个方向走不通';
      blocked++;
    }
    legs.push(leg);
  }

  cleanup();

  const ms = now() - t0;
  const ok = blocked === 0 && unproven === 0 && !truncated;
  return {
    ran: true,
    ok,
    blocked,
    unproven,
    truncated,
    overBudget,
    mechLegs,
    mechBlocked,
    legs,
    meshes: geos.length,
    nodes: nodeCount,
    scanMs: Math.round(scanMs),
    ms: Math.round(ms),
    reason: ok ? ''
      : blocked ? (mechBlocked
        ? `有 ${mechBlocked} 段必经机制段在真实几何上不通（另外 ${blocked - mechBlocked} 段走不通）`
        : `有 ${blocked} 段在真实几何上走不通`)
        : truncated ? '证明超出预算，未跑完全部段落'
          : `${unproven} 段因采样分辨率不足未能证明`,
  };
}

/**
 * 路线的包围盒。
 * ceilTop = 所有段落里最高的天花板高度（0 = 全程无顶）；
 * 上界要抬到它之上，否则射线可能从天花板板块内部起射，什么都打不到。
 */
function routeBox(states, ceilTop) {
  const box = new THREE.Box3();
  let maxY = -Infinity;
  for (const s of states) {
    const hw = Math.max(2, Number(s.hw) || 2);
    const y = Number(s.y) || 0;
    maxY = Math.max(maxY, y);
    box.expandByPoint(new THREE.Vector3(s.x - hw, y - 1, s.z - hw));
    box.expandByPoint(new THREE.Vector3(s.x + hw, y + 1, s.z + hw));
  }
  const ceil = Number(ceilTop) || 0;
  const top = ceil > 0 ? Math.max(ceil + 12, maxY + 12) : maxY + 12;
  box.expandByPoint(new THREE.Vector3(box.min.x, box.min.y - 2, box.min.z));
  box.expandByPoint(new THREE.Vector3(box.max.x, top, box.max.z));
  return box;
}
