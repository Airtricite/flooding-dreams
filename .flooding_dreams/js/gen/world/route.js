/* ============================================================
   世界优先管线 · Phase C2：观测 → 排布跑酷
   ------------------------------------------------------------
   世界已经在前面造好了（A 白模 + B 演化）。这一层是「极其智能的算法」：
   它**读**观测结果，然后在这个真实空间里排出一条**跑得通、往上逃、
   有局部下降、空间行动多样**的路线。

   三条设计核心（写死在目标函数里）：
     ① 整体爬升 —— 每一跳的目标高度 dyWant = 剩余爬升 / 剩余步数；
        净爬升 ≤ 0 直接判失败。
     ② 局部下降 —— 只有在「领先理想爬升线」(ahead > 0) 时才允许下沉，
        且下沉深度是固定小量（1.5~3.5 stud），必须几跳内爬回来。
     ③ 空间行动多样性 —— 转向由本带外壳的 pattern 驱动（盘旋 / 之字 /
        直线 / 游走），并叠加岔路平台（detour）造出「直跳快险 / 绕步慢稳」的选择。

   两条落点策略（与旧版最本质的差别）：
     · **优先落在世界真实台面上**（观测到的 pad）—— 世界得到尊重；
     · 世界够不着时才**补一块板**（synth）—— 但补板位置要「贴着世界的墙」，
       不是随手扔在空气里。于是路线是被**安排**进世界的，而不是世界围着路线砌。
   ============================================================ */
import { round, clamp } from '../../core/util.js';
import { makeIdGen } from '../rng.js';
import {
  maxJumpDist, jumpReach, jumpApex, minCeiling, checkLink, canStep, dropTime, STEP_H,
} from '../reach.js';
import { platformDesc, PLAT_T, sane } from './parts.js';
import { buildMechSegment } from './mechRoute.js';
import { makePadIndex } from './observe.js';
import { cix } from './voxel.js';

const DEG = Math.PI / 180;
const MAX_STEPS = 240;
const MAX_DETOUR = 6;
const DIP_MIN = 0.6, DIP_MAX = 1.8;
const FALL_DIP_MIN = 1.5, FALL_DIP_MAX = 3.5;

/* ============================================================
   主入口
   ============================================================ */
export function planRoute(observed, wt, P, params, rng, opts = {}) {
  const grid = opts.grid;
  const idGen = opts.idGen || makeIdGen(rng);
  const pads = observed.pads || [];
  const maxD = maxJumpDist(P);
  const apex = jumpApex(P);
  const minCeil = minCeiling(P);
  const index = makePadIndex(pads, Math.max(18, maxD * 1.4));
  const dbg = opts.debug || null;          // 可选：逐跳诊断（离线调试用，生产不传）

  const objects = [];
  const nodes = [];
  const edges = [];
  const mainEdges = [];
  const anims = [];              // 机制段带来的动画（移动装置等）
  const mechSegs = [];           // ★ 主轴上的「必经机制段」清单（滑索 / 攀爬 / WallJump / 游泳）
  const featDebug = [];

  const clampBand = (i) => clamp(Math.round(i) || 0, 0, wt.bands.length - 1);
  const bandOfY = (y) => {
    for (let i = 0; i < wt.bands.length; i++) if (y >= wt.bands[i].y0 && y <= wt.bands[i].y1) return i;
    return y < wt.bands[0].y0 ? 0 : wt.bands.length - 1;
  };
  const measure = (A, B) => {
    const dx = B.x - A.x, dz = B.z - A.z;
    const cd = Math.hypot(dx, dz);
    const ux = cd > 1e-6 ? dx / cd : 1, uz = cd > 1e-6 ? dz / cd : 0;
    const gap = Math.max(0, cd - support(A, ux, uz) - support(B, -ux, -uz));
    return { dist: round(gap, 3), centerDist: round(cd, 3), dy: round(B.y - A.y, 3) };
  };
  const moveKind = (e) => {
    if (e.dy < -0.25) return 'fall';
    if (e.dist < 1.2 && canStep(e.dy)) return 'walk';
    return 'jump';
  };
  const pushNode = (st, section) => { nodes.push({ ...st, section: clampBand(section) }); return nodes.length - 1; };
  const addEdge = (move, from, to, kind, section) => {
    const A = nodes[from], B = nodes[to];
    const m = measure(A, B);
    const mv = move || moveKind(m);
    // ★ 非主轴边（岔路 / 旁路）不许非法：验证层会逐边判定，这里先兜一道
    if (kind !== 'main' && !checkLink(P, { move: mv, dist: m.dist, dy: m.dy }).ok) return -1;
    edges.push({ from, to, move: mv, dist: m.dist, dy: m.dy, centerDist: m.centerDist, kind, section: clampBand(section) });
    if (kind === 'main') mainEdges.push(edges.length - 1);
    return edges.length - 1;
  };
  /** 落点太近就不要（跨带几乎重合的两块台面在编辑器里一眼就是坏的） */
  const clash = (x, y, z, hw) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (Math.abs(n.y - y) >= 2.6) continue;
      if (Math.hypot(n.x - x, n.z - z) < (hw + (n.hw || 2)) * 0.55) return true;
    }
    return false;
  };
  const fits = (x, y, z, w, d) => fitsFree(grid, P, x, y, z, w, d, minCeil) && !clash(x, y, z, Math.min(w, d) / 2);
  const openAt = (x, y, z) => openness(grid, observed.dist, x, y, z);

  /* ---------- ① 起点 ----------
     ★ 世界优先管线的要点：路线落在**真实台面**上，起点也不例外。
       · **攀登链模式**（首选）：白模阶段构造保证的螺旋台阶就是从底到顶的骨架，
         直接以它的起点当出生点 —— 它是「一定能站、一定能往上走」的。
       · 没有链时才退回：观测到的最低一块还有下一跳的够宽台面 → 再退回补板。 */
  const cx = grid.ox + grid.nx * grid.cell / 2;
  const cz = grid.oz + grid.nz * grid.cell / 2;
  const usedPads = new Set();
  const cellS = grid.cell;
  const chainList = (opts.chain || []).filter((c) => Number.isFinite(Number(c.y)));
  const chainMode = chainList.length >= 5;
  const spawnPad = chainMode ? null : pickSpawnPad(observed, P);
  let spawnState;
  if (chainMode) {
    const c0 = chainList[0];
    spawnState = {
      x: c0.x, y: c0.y, z: c0.z, angle: rng.range(0, Math.PI * 2),
      hw: cellS, beam: cellS * 2, size: [cellS * 2, cellS * 2], source: 'chain',
    };
  } else if (spawnPad) {
    spawnState = {
      x: spawnPad.x, y: spawnPad.y, z: spawnPad.z,
      angle: rng.range(0, Math.PI * 2),
      hw: spawnPad.hw, beam: spawnPad.beam, size: [spawnPad.w, spawnPad.d],
      source: 'world', pad: spawnPad.id,
    };
  } else {
    const startY = wt.bands[0].y0 + Math.min(16, (wt.bands[0].y1 - wt.bands[0].y0) * 0.4);
    const startSize = Math.max(8, params.restW);
    const spot = findSpot(grid, fits, cx, startY, cz, startSize, rng);
    if (!spot) return null;
    const bIdx = clampBand(bandOfY(spot.y));
    spawnState = {
      x: spot.x, y: spot.y, z: spot.z, angle: rng.range(0, Math.PI * 2),
      hw: startSize / 2, beam: startSize, size: [startSize, startSize], source: 'placed',
    };
    objects.push(platformDesc(idGen, wt.bands[bIdx].theme, spot.x, spot.y, spot.z, startSize, startSize, { color: wt.bands[0].theme.start }));
  }
  const spawnIdx = pushNode(spawnState, bandOfY(spawnState.y));
  if (spawnPad) usedPads.add(spawnPad.id);
  objects.push({ type: 'spawn', over: { id: idGen('sp'), position: [round(spawnState.x, 3), round(spawnState.y + 4, 3), round(spawnState.z, 3)] } });

  /* ---------- ② 终点：世界最高、最开阔的一块台面（逃向天光） ---------- */
  const goalPad = chainMode ? null : pickGoalPad(observed, wt);
  // 链模式：把贪心攀登的目标设成「就在脚下」，让它当轮直接退出，改由链骨架铺主轴
  const guide = chainMode
    ? { x: spawnState.x, y: spawnState.y - 0.5, z: spawnState.z }
    : (goalPad || { x: cx, y: wt.height - 14, z: cz });

  /* ---------- ③ 主轴攀登 ---------- */
  const stepsEstimate = Math.max(10, Math.ceil((guide.y - spawnState.y) / 1.15));
  const mainPath = [spawnIdx];
  let cur = spawnIdx;
  let steps = 0;
  let synthCount = 0;
  let descentCount = 0;
  let featFallback = 0;          // 特技段改用「补板搭桥」兜底的次数（正常应为 0）
  let skippedFeat = 0;           // 特技段彻底接不上的次数（正常应为 0）
  let laneStat = null;           // 多股骨架：换股道 / 分叉段的统计
  const coilDir = rng.sign();

  while (steps < MAX_STEPS) {
    const A = nodes[cur];
    if (A.y >= guide.y - 1.2) break;
    steps++;
    const bandIdx = A.section;
    const band = wt.bands[bandIdx];
    const idealY = spawnState.y + (guide.y - spawnState.y) * (steps / stepsEstimate);
    const ahead = A.y - idealY;
    const dyWant = clamp((guide.y - A.y) / Math.max(1, stepsEstimate - steps), 0.6, 1.8);
    const desired = desiredAngle(A, guide, band, params, rng, steps, coilDir);

    /* --- 候选：观测到的真实台面 ---
       ★ 查询半径要按「中心距」算：edge-to-edge 缺口在射程内时，
         中心距最大可达 射程 + 两块平台的半宽（≈ 10.6 + 12）；给足 2.4×。 */
    const cands = index.near(A.x, A.y, A.z, maxD * 2.4, apex + FALL_DIP_MAX);
    let best = null;
    for (const j of cands) {
      if (usedPads.has(j)) continue;
      const p = pads[j];
      if (p.y - A.y > apex - 0.05) continue;
      const e = measure(A, p);
      // ★ 只跳过「同一块台面」（dist≈0 且同高）；错开一层的台阶式台面 dist 也≈0，
      //   但那是**正当的一步登高**（跳上相邻且重叠的台阶），必须放行。
      if (e.dist < 0.9 && Math.abs(e.dy) < 0.6) continue;
      if (e.dy < -FALL_DIP_MAX) continue;
      if (!checkLink(P, { move: moveKind(e), dist: e.dist, dy: e.dy }).ok) continue;
      const sc = scoreCandidate(e, p, A, desired, guide, ahead, params, maxD, rng, dyWant);
      if (!best || sc > best.sc) best = { j, p, e, sc };
    }

    if (best) {
      if (dbg) dbg.push({ steps, y: round(A.y, 1), take: 'pad', cands: cands.length, dy: best.e.dy, dist: best.e.dist, sc: round(best.sc, 2) });
      const p = best.p;
      const st = {
        x: p.x, y: p.y, z: p.z,
        angle: Math.atan2(p.z - A.z, p.x - A.x),
        hw: p.hw, beam: p.beam, size: [p.w, p.d],
        source: 'world', pad: best.j, open: p.open,
      };
      const ni = pushNode(st, bandOfY(p.y));
      addEdge(best.e.dy < -0.25 ? 'fall' : 'jump', cur, ni, 'main', bandOfY(p.y));
      usedPads.add(best.j);
      cur = ni;
      mainPath.push(ni);
      continue;
    }

    /* --- 世界够不着：补一块板，但要贴着世界的墙、方向朝理想处 --- */
    const s = trySynth(A, {
      grid, P, params, rng, desired, dyWant, maxD, apex, minCeil, ahead, fits, openAt,
    });
    if (s) {
      if (dbg) dbg.push({ steps, y: round(A.y, 1), take: 'synth', cands: cands.length, dy: s.dy });
      const bIdx = bandOfY(s.y);
      objects.push(platformDesc(idGen, wt.bands[bIdx].theme, s.x, s.y, s.z, s.w, s.d, {}));
      const ni = pushNode({ x: s.x, y: s.y, z: s.z, angle: s.angle, hw: s.hw, beam: Math.min(s.w, s.d), size: [s.w, s.d], source: 'placed' }, bIdx);
      addEdge(s.dy < -0.25 ? 'fall' : 'jump', cur, ni, 'main', bIdx);
      cur = ni;
      mainPath.push(ni);
      synthCount++;
      continue;
    }

    /* --- 连补板都放不下：换一次转向重试，仍不行就上跳兜底 --- */
    const rescue = trySynth(A, {
      grid, P, params, rng, desired: desired + rng.range(-1.4, 1.4), dyWant: Math.min(dyWant, apex * 0.5), maxD, apex, minCeil, ahead: 0, fits, openAt, strict: true,
    });
    if (!rescue) {
      if (dbg) {
        dbg.push({
          steps, y: round(A.y, 1), take: 'break', cands: cands.length,
          nearest: pads.slice().map((q) => ({ dy: round(q.y - A.y, 1), d: round(Math.hypot(q.x - A.x, q.z - A.z), 1) }))
            .sort((a, b) => Math.abs(a.dy) - Math.abs(b.dy)).slice(0, 5),
        });
      }
      break;
    }
    const bIdx2 = bandOfY(rescue.y);
    objects.push(platformDesc(idGen, wt.bands[bIdx2].theme, rescue.x, rescue.y, rescue.z, rescue.w, rescue.d, {}));
    const ni2 = pushNode({ x: rescue.x, y: rescue.y, z: rescue.z, angle: rescue.angle, hw: rescue.hw, beam: Math.min(rescue.w, rescue.d), size: [rescue.w, rescue.d], source: 'placed' }, bIdx2);
    addEdge('jump', cur, ni2, 'main', bIdx2);
    cur = ni2;
    mainPath.push(ni2);
    synthCount++;
  }

  /* ---------- ③b 多股骨架：主轴在交汇层换股道，其余股道铺成分叉 ----------
     ★ 「世界能爬上去」的落地：骨架是白模**构造**出来的（每级抬 1 体素、清出头顶净空、
       每 5 级一圈交汇环台把多股连起来），沿它铺主轴，几何上一定通。 */
  if (chainMode) {
    const lanes = (opts.strands && opts.strands.length ? opts.strands : [chainList])
      .map((arr) => (arr || []).filter((n) => Number.isFinite(Number(n.y))));
    const laneMap = lanes.map((arr) => {
      const m = new Map();
      for (const n of arr) m.set(n.level, n);
      return m;
    });
    const maxLevel = lanes.reduce(
      (a, arr) => Math.max(a, arr.reduce((b, n) => Math.max(b, Number(n.level) || 0), 0)), 0,
    );
    const jSet = new Set((opts.junctions || []).map((j) => j.level));
    const laneUse = lanes.map(() => 0);
    const spineLaneAt = new Map();
    let curLane = 0;
    let laneSwitches = 0;
    let branchSegs = 0;

    /** 找主轴在这块踏板上的落点（交汇层上主轴与旁路共用的那个节点） */
    const findSpineNode = (t) => {
      if (!t) return -1;
      for (let k = spine.length - 1; k >= 0; k--) {
        const n = nodes[spine[k]];
        if (!n) continue;
        if (Math.abs(n.y - t.y) < 1.5 && Math.hypot(n.x - t.x, n.z - t.z) < Math.max(3, cellS)) return spine[k];
      }
      return -1;
    };

    /* 交汇环台走道：沿环台从当前节点走到另一股道的踏板。
       ★ 必须**沿圆弧**走，不能走弦：弦离圆周的距离是 R(1−cos(Δθ/2))，
         环台只有 STRANDS.ringWidth 格宽，弦稍微长一点中间那几节就落到环台外面
         —— 解析层看着「缺口≈0」放行，真到 navcheck 一射线就是「这一腿悬空」，
         表现就是**跑酷路线被堵死**。
       所以这里按**角度插值**、半径固定 R，每个节点都精确落在环台上。 */
    const axis = opts.axis || null;
    const ringR = new Map((opts.junctions || [])
      .filter((j) => Number.isFinite(Number(j.radius)))
      .map((j) => [j.level, Number(j.radius) * cellS]));
    const ringCross = (curIdx, target, isMain, level) => {
      const A0 = nodes[curIdx];
      const dx = target.x - A0.x, dz = target.z - A0.z;
      const dist = Math.hypot(dx, dz);
      const hwR = Math.max(2, cellS * 0.5);
      const ang = Math.atan2(dz, dx);
      const R = axis && level != null ? ringR.get(level) : null;
      let prev = curIdx;
      const put = (st, isEnd) => {
        const ni = pushNode(st, bandOfY(st.y));
        addEdge('walk', prev, ni, isMain ? 'main' : 'ring', bandOfY(st.y));
        prev = ni;
        return ni;
      };
      if (axis && Number.isFinite(R) && R > 1) {
        // —— 圆弧走道：从当前角到目标角，半径固定 R，逐节 ≤12 stud ——
        const aF = Math.atan2(A0.z - axis.wz, A0.x - axis.wx);
        const aT = Math.atan2(target.z - axis.wz, target.x - axis.wx);
        let d = aT - aF;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const k = Math.max(1, Math.min(14, Math.ceil(Math.abs(d) * R / 12)));
        for (let i = 1; i <= k; i++) {
          const t = i / k;
          const isEnd = i === k;
          if (isEnd) { put(target, true); continue; }
          const a = aF + d * t;
          put({
            x: round(axis.wx + Math.cos(a) * R, 3),
            y: round(A0.y + (target.y - A0.y) * t, 3),
            z: round(axis.wz + Math.sin(a) * R, 3),
            angle: ang, hw: hwR, beam: hwR * 2, size: [hwR * 2, hwR * 2], source: 'ring',
          }, false);
        }
        return prev;
      }
      // 兜底：没有塔中心（老调用路径）时退回切线分段（每段 ≤12 stud）
      const k = Math.max(1, Math.min(6, Math.ceil(dist / 12)));
      for (let i = 1; i <= k; i++) {
        const t = i / k;
        const isEnd = i === k;
        if (isEnd) { put(target, true); continue; }
        put({
          x: round(A0.x + dx * t, 3),
          y: round(A0.y + (target.y - A0.y) * t, 3),
          z: round(A0.z + dz * t, 3),
          angle: ang, hw: hwR, beam: hwR * 2, size: [hwR * 2, hwR * 2], source: 'ring',
        }, false);
      }
      return prev;
    };

    const spine = [spawnIdx];
    for (let L = 1; L <= maxLevel; L++) {
      /* ★ 交汇层换股道：主轴沿环台走到另一股道的踏板 —— 主轴自己就是「分叉 → 合流」。
         换股道必须**从同一层的踏板起步**（环台是等高的走道，跨层走就变成「走不上去的台阶」），
         所以先确认主轴此刻正站在本股道这一层的踏板上。 */
      if (jSet.has(L - 1) && lanes.length > 1) {
        const laneNode = laneMap[curLane].get(L - 1);
        const tipIdx = spine[spine.length - 1];
        const tip = nodes[tipIdx];
        const others = lanes.map((_, s) => s)
          .filter((s) => s !== curLane && laneMap[s].has(L - 1))
          .filter((s) => {
            const t2 = laneMap[s].get(L - 1);
            return Math.hypot(tip.x - t2.x, tip.z - t2.z) > 4;
          });
        const canSwitch = laneNode && Math.abs(tip.y - laneNode.y) <= 1.5 && others.length;
        if (canSwitch && rng.chance(params.laneSwitchChance == null ? 0.6 : params.laneSwitchChance)) {
          const s2 = others.reduce((a, b) => ((laneUse[a] || 0) <= (laneUse[b] || 0) ? a : b));
          const ni = ringCross(tipIdx, laneMap[s2].get(L - 1), true, L - 1);
          spine.push(ni);
          curLane = s2;
          laneUse[s2] = (laneUse[s2] || 0) + 1;
          laneSwitches++;
        }
      }
      const c = laneMap[curLane].get(L);
      spineLaneAt.set(L, curLane);
      if (!c) continue;                       // 这一级被特技段吃掉了（中间不落台）
      /* 本股道上「上一块踏板」：特技段的起步那一级要用它（竖井 / 裂谷都是按这一对点挖的） */
      let cb = null;
      for (let Lx = L - 1; Lx >= 0; Lx--) {
        const t = laneMap[curLane].get(Lx);
        if (t) { cb = t; break; }
      }
      const cbIn = cb;
      const ci = bandOfY(c.y);
      let prevIdx = spine[spine.length - 1];
      const A = nodes[prevIdx];
      const cState = {
        x: c.x, y: c.y, z: c.z,
        angle: Math.atan2(c.z - A.z, c.x - A.x),
        hw: cellS, beam: cellS * 2, size: [cellS * 2, cellS * 2], source: 'chain',
      };

      /* ---------- ★ 特技段：竖井 / 裂谷 → 交给机制段模板（必经机制） ----------
         白模把这一段中间的台阶拿掉了，落差 / 缺口都超出跳跃包络，
         所以这里必须由机制接管；接不上时才退回「补板搭桥」兜底。 */
      if (c.feat) {
        /* ★ 机制段必须**从上一级链节点起步**：白模正是按「上一级台阶 → 本台阶」这一对
           点挖的竖井 / 裂谷。如果主轴此刻停在别处（上一级没接上链），先把主轴接回来，
           否则机制段会按一对错位的端点去采样净空，永远「摆不下」。 */
        const cb = cbIn || c;
        let fromIdx = prevIdx;
        const tip = nodes[fromIdx];
        const near = Math.hypot(tip.x - cb.x, tip.z - cb.z) < Math.max(2, cellS * 0.6)
          && Math.abs(tip.y - cb.y) < Math.max(2, cellS * 0.6);
        if (!near) {
          const bState = {
            x: cb.x, y: cb.y, z: cb.z,
            angle: Math.atan2(cb.z - tip.z, cb.x - tip.x),
            hw: cellS, beam: cellS * 2, size: [cellS * 2, cellS * 2], source: 'chain',
          };
          const eb = measure(tip, bState);
          if (!checkLink(P, { move: moveKind(eb), dist: eb.dist, dy: eb.dy }).ok) { skippedFeat++; continue; }
          const bi = pushNode(bState, bandOfY(bState.y));
          addEdge(moveKind(eb), fromIdx, bi, 'main', bandOfY(bState.y));
          spine.push(bi);
          fromIdx = bi;
        }
        const A2 = nodes[fromIdx];
        const seg = buildMechSegment(A2, cState, c.feat, {
          P, params, rng, idGen, theme: wt.bands[ci].theme, style: wt.style, wt,
          measure, openAt, sane, debug: featDebug, cell: cellS, grid,
        });
        if (seg) {
          const ni = pushNode(cState, ci);
          for (const o of seg.objects) objects.push(o);
          for (const a of seg.animations) anims.push(a);
          const m = measure(A2, cState);
          addEdge(seg.move, fromIdx, ni, 'main', ci);
          mechSegs.push({
            move: seg.move, label: seg.label, feat: c.feat,
            dist: m.dist, dy: m.dy, section: ci, info: seg.info || null,
            // 占据范围：旁路机制（mechanics.js）不许再往这一段里塞东西
            x: round((A2.x + cState.x) / 2, 2), z: round((A2.z + cState.z) / 2, 2),
            y: round((A2.y + cState.y) / 2, 2),
            r: round(Math.max(m.centerDist / 2 + 8, 14), 1),
          });
          spine.push(ni);
          continue;
        }
        // 兜底：机制摆不出来（极少见）→ 沿这两点补一串板，保证主轴不断
        const line = bridgeLine(A2, cState, {
          cell: cellS, apex, minCeil, fits, measure, moveKind, P,
        });
        if (line && line.length) {
          let ok = true;
          for (const s of line) {
            const bIdx = bandOfY(s.y);
            const e1 = measure(nodes[fromIdx], s);
            if (!checkLink(P, { move: moveKind(e1), dist: e1.dist, dy: e1.dy }).ok) { ok = false; break; }
            objects.push(platformDesc(idGen, wt.bands[bIdx].theme, s.x, s.y, s.z, s.w, s.d, {}));
            const mi = pushNode({ x: s.x, y: s.y, z: s.z, angle: s.angle, hw: s.hw, beam: Math.min(s.w, s.d), size: [s.w, s.d], source: 'placed' }, bIdx);
            addEdge(moveKind(e1), fromIdx, mi, 'main', bIdx);
            fromIdx = mi; spine.push(mi);
          }
          if (ok) {
            const e2 = measure(nodes[fromIdx], cState);
            if (checkLink(P, { move: moveKind(e2), dist: e2.dist, dy: e2.dy }).ok) {
              const ni = pushNode(cState, ci);
              addEdge(moveKind(e2), fromIdx, ni, 'main', ci);
              spine.push(ni);
              synthCount += line.length + 1;
              featFallback++;
              continue;
            }
          }
        }
        // 连兜底都接不上：**跳过这一级**（不推节点）。后一级会用补板把高度爬回来，
        // 主轴依然连续 —— 宁可这一段平庸，也不要整张图作废。
        skippedFeat++;
        continue;
      }

      const ni = pushNode(cState, ci);
      // 花样：在 A 与链上目标之间插「中途点」——造出真实缺口（gap）、横向移动（turn）、
      //   局部下降（descent）与内容量（link 数）。
      // ★ 中途点数量直接决定**跑图占比**（连接条数 → estTime / timeLimit）。
      //   实测「每级按 cell 加码」会把占比顶到 20~59%，远高于目标的 25~35%，
      //   所以这里只留 1~2 个中途点（0.5 概率多插一个），把占比压回目标区间。
      // ★ 交汇层不插中途点：主轴必须**正正落在环台上的那块踏板**，
      //   否则换股道时「沿环台走」会走出一个跨层的台阶（dy 不为 0，走不过去）。
      const nIns = jSet.has(L) ? 0 : clamp(rng.chance(0.5) ? 2 : 1, 1, 3);
      for (let iIns = 0; iIns < nIns; iIns++) {
        if (!rng.chance(0.85)) break;
        const mid = { x: (nodes[prevIdx].x + c.x) / 2, y: (nodes[prevIdx].y + c.y) / 2, z: (nodes[prevIdx].z + c.z) / 2 };
        let ins = null;
        const Ain = nodes[prevIdx];
        // (a0) 下沉->折返：局部下降的唯一可靠来源（模板见 tryDescent）
        if (rng.chance(0.34)) {
          const d = tryDescent(Ain, cState, { grid, P, params, rng, maxD, apex, minCeil, fits, openAt }, rng);
          if (d) ins = { descent: d };
        }
        // (a) 观测到的真实台面
        if (!ins) {
          for (const j of index.near(mid.x, mid.y, mid.z, maxD * 2.0, apex)) {
            if (usedPads.has(j)) continue;
            const p = pads[j];
            if (Math.abs(p.y - mid.y) > apex) continue;
            const e1 = measure(Ain, p), e2 = measure(p, cState);
            if (e1.dist < 1.0 || e2.dist < 1.0) continue;
            if (!checkLink(P, { move: moveKind(e1), dist: e1.dist, dy: e1.dy }).ok) continue;
            if (!checkLink(P, { move: moveKind(e2), dist: e2.dist, dy: e2.dy }).ok) continue;
            ins = { p, e1, e2, pad: j };
            break;
          }
        }
        // (b0) 局部下降：偶尔先往下沉一小步、再爬回链上
        if (!ins && rng.chance(0.16)) {
          const sd2 = cState.angle + rng.sign() * rng.range(40, 80) * DEG;
          const d = trySynth(Ain, {
            grid, P, params, rng, desired: sd2, dyWant: 1.2, dipWant: rng.range(0.8, 1.5),
            maxD, apex, minCeil, ahead: 3.0, fits, openAt,
          });
          if (d) {
            const e2 = measure(d, cState);
            if (e2.dist >= 1.0 && checkLink(P, { move: moveKind(e2), dist: e2.dist, dy: e2.dy }).ok) ins = { synth: d };
          }
        }
        // (b) 补一块横向的板（链附近没有可用真实台面时的主力做法）
        if (!ins) {
          const sd = cState.angle + rng.sign() * rng.range(50, 95) * DEG;
          const s = trySynth(Ain, {
            grid, P, params, rng, desired: sd,
            dyWant: rng.range(1.0, 2.2),
            maxD, apex, minCeil, ahead: rng.chance(0.18) ? 3.0 : 0, fits, openAt,
          });
          if (s) {
            const e2 = measure(s, cState);
            if (e2.dist >= 1.0 && checkLink(P, { move: moveKind(e2), dist: e2.dist, dy: e2.dy }).ok) ins = { synth: s };
          }
        }
        if (!ins) break;
        if (ins.descent) {
          // 下沉 D → 折返 R（两段都带真实缺口）；末段 R→链上目标交给下面的直连逻辑
          const d = ins.descent;
          for (const it of [{ s: d.D, l: d.lAD }, { s: d.R, l: d.lDR }]) {
            const bIdx = bandOfY(it.s.y);
            objects.push(platformDesc(idGen, wt.bands[bIdx].theme, it.s.x, it.s.y, it.s.z, it.s.w, it.s.d, {}));
            const mi = pushNode({ x: it.s.x, y: it.s.y, z: it.s.z, angle: it.s.angle, hw: it.s.hw, beam: Math.min(it.s.w, it.s.d), size: [it.s.w, it.s.d], source: 'placed' }, bIdx);
            addEdge(it.l.move, prevIdx, mi, 'main', bIdx);
            prevIdx = mi; spine.push(mi);
          }
          synthCount += 2;
          descentCount++;
          break;
        } else if (ins.synth) {
          const s = ins.synth;
          const e1 = measure(nodes[prevIdx], s);
          if (!checkLink(P, { move: moveKind(e1), dist: e1.dist, dy: e1.dy }).ok) break;
          const bIdx = bandOfY(s.y);
          objects.push(platformDesc(idGen, wt.bands[bIdx].theme, s.x, s.y, s.z, s.w, s.d, {}));
          const mi = pushNode({ x: s.x, y: s.y, z: s.z, angle: s.angle, hw: s.hw, beam: Math.min(s.w, s.d), size: [s.w, s.d], source: 'placed' }, bIdx);
          addEdge(moveKind(e1), prevIdx, mi, 'main', bIdx);
          prevIdx = mi; spine.push(mi); synthCount++;
        } else {
          const p = ins.p;
          const pn = pushNode({
            x: p.x, y: p.y, z: p.z,
            angle: Math.atan2(p.z - nodes[prevIdx].z, p.x - nodes[prevIdx].x),
            hw: p.hw, beam: p.beam, size: [p.w, p.d], source: 'world', pad: ins.pad,
          }, bandOfY(p.y));
          addEdge(moveKind(ins.e1), prevIdx, pn, 'main', bandOfY(p.y));
          usedPads.add(ins.pad);
          prevIdx = pn; spine.push(pn);
        }
      }
      // 没有中途点：直接沿链上台阶走（保证能爬）
      const e = measure(nodes[prevIdx], cState);
      const mv = moveKind(e);
      if (checkLink(P, { move: mv, dist: e.dist, dy: e.dy }).ok) {
        addEdge(mv, prevIdx, ni, 'main', ci);
        spine.push(ni);
      } else {
        // 链上被蹭到（极少见）：补一块板把连续救回来
        const s = trySynth(nodes[prevIdx], {
          grid, P, params, rng, desired: cState.angle,
          dyWant: Math.min(1.6, Math.abs(e.dy) || 1.2), maxD, apex, minCeil, ahead: 0, fits, openAt, strict: true,
        });
        if (!s) continue;                       // 跳过这一级（链上下一级通常又接得上）
        const e1 = measure(nodes[prevIdx], s);
        if (!checkLink(P, { move: moveKind(e1), dist: e1.dist, dy: e1.dy }).ok) continue;
        const bIdx = bandOfY(s.y);
        objects.push(platformDesc(idGen, wt.bands[bIdx].theme, s.x, s.y, s.z, s.w, s.d, {}));
        const mi = pushNode({ x: s.x, y: s.y, z: s.z, angle: s.angle, hw: s.hw, beam: Math.min(s.w, s.d), size: [s.w, s.d], source: 'placed' }, bIdx);
        addEdge(moveKind(e1), prevIdx, mi, 'main', bIdx);
        synthCount++;
        /* ★ 只有「mi → ni」这条边真的加上去，才把 ni 放进主轴 —— 否则主轴会出现
           「节点没有入边」的断点（walkMain 会报「主轴在第 N 条边断开」）。 */
        const e2 = measure(nodes[mi], cState);
        if (checkLink(P, { move: moveKind(e2), dist: e2.dist, dy: e2.dy }).ok) {
          addEdge(moveKind(e2), mi, ni, 'main', ci);
          spine.push(mi); spine.push(ni);
        } else {
          spine.push(mi);
        }
      }
    }

    /* ---------- ★ 分叉 / 合流：把没被主轴走到的那些股道铺成可选路线 ----------
       两条交汇环台之间，每条股道都是一条「同样从 A 到 B」的独立通道：
       主轴走其中一条，另外的铺成 kind='ring' 的旁路 —— 玩家可以在交汇层
       选「走陡塔」还是「走之字坡道」，两端汇合。这是真分叉，不是装饰性岔路。
       ★ 旁路是**可选内容**：任何一段接不上就整段回滚，绝不影响主轴的可通关性。 */
    // 主轴在某一层的落点（交汇层上，主轴的踏板就在环台上）—— 分叉段与区域旁路共用
    const spineAt = (L) => {
      const l = spineLaneAt.get(L);
      return (l == null ? null : laneMap[l].get(L)) || null;
    };
    const jList = (opts.junctions || []).map((j) => j.level).filter((L) => L > 0 && L <= maxLevel).sort((a, b) => a - b);
    for (let ji = 0; ji + 1 < jList.length; ji++) {
      const La = jList[ji], Lb = jList[ji + 1];
      const sa = spineAt(La), sb = spineAt(Lb);
      if (!sa || !sb) continue;
      for (let s = 0; s < lanes.length; s++) {
        if (s === spineLaneAt.get(La)) continue;
        const a = laneMap[s].get(La), b = laneMap[s].get(Lb);
        if (!a || !b) continue;
        if (ji % 2 === s % 2) continue;          // 隔层铺：控制图规模（每条股道都还会出现）
        const ni0 = findSpineNode(sa);
        const ni1 = findSpineNode(sb);
        if (ni0 < 0 || ni1 < 0) continue;
        // 先把这一段的每一步都预演一遍（不可行就整段放弃）
        const stepsIn = [];
        let prev = a, ok = true;
        for (let L = La + 1; L <= Lb; L++) {
          const nxt = laneMap[s].get(L);
          if (!nxt) continue;
          const m = measure(prev, nxt);
          const jumpOk = checkLink(P, { move: moveKind(m), dist: m.dist, dy: m.dy }).ok;
          const mechOk = !jumpOk && (nxt.feat || prev.feat)
            ? !!buildMechSegment(prev, nxt, nxt.feat || prev.feat, {
              P, params, rng: rng.fork(`br${ji}_${s}_${L}`), idGen, theme: wt.bands[bandOfY(nxt.y)].theme,
              style: wt.style, wt, measure, openAt, sane, cell: cellS, grid,
            })
            : false;
          if (nxt.feat && !jumpOk && !mechOk) { ok = false; break; }
          if (!jumpOk && !mechOk) { ok = false; break; }
          stepsIn.push({ from: prev, to: nxt, m, jumpOk, mechOk, feat: nxt.feat, L });
          prev = nxt;
        }
        if (!ok || !stepsIn.length) continue;
        if (stepsIn[stepsIn.length - 1].L !== Lb) continue;   // 这一段必须走到汇合层（否则合不上）

        // 真正铺：先记快照，失败就回滚（旁路绝不影响主轴）
        const snap = { n: nodes.length, e: edges.length, o: objects.length, a: anims.length, g: mechSegs.length };
        const rollback = () => {
          nodes.length = snap.n; edges.length = snap.e;
          objects.length = snap.o; anims.length = snap.a; mechSegs.length = snap.g;
        };
        try {
          const nx = ringCross(ni0, a, false, La);
          let cur2 = nx;
          for (const st of stepsIn) {
            const target = st.to;
            if (st.jumpOk) {
              const node = pushNode({
                x: target.x, y: target.y, z: target.z,
                angle: Math.atan2(target.z - nodes[cur2].z, target.x - nodes[cur2].x),
                hw: cellS, beam: cellS * 2, size: [cellS * 2, cellS * 2], source: 'chain',
              }, bandOfY(target.y));
              addEdge(moveKind(st.m), cur2, node, 'ring', bandOfY(target.y));
              cur2 = node;
            } else {
              const seg = buildMechSegment(nodes[cur2], target, st.feat, {
                P, params, rng: rng.fork(`bm${ji}_${s}_${st.L}`), idGen, theme: wt.bands[bandOfY(target.y)].theme,
                style: wt.style, wt, measure, openAt, sane, cell: cellS, grid,
              });
              if (!seg) throw new Error('mech');
              const node = pushNode({
                x: target.x, y: target.y, z: target.z,
                angle: Math.atan2(target.z - nodes[cur2].z, target.x - nodes[cur2].x),
                hw: cellS, beam: cellS * 2, size: [cellS * 2, cellS * 2], source: 'chain',
              }, bandOfY(target.y));
              for (const o of seg.objects) objects.push(o);
              for (const an of seg.animations) anims.push(an);
              addEdge(seg.move, cur2, node, 'ring', bandOfY(target.y));
              mechSegs.push({
                move: seg.move, label: seg.label, feat: st.feat, branch: true,
                dist: st.m.dist, dy: st.m.dy, section: bandOfY(target.y), info: seg.info || null,
                x: round((nodes[cur2].x + target.x) / 2, 2), z: round((nodes[cur2].z + target.z) / 2, 2),
                y: round(st.m.dy / 2 + nodes[cur2].y, 2),
                r: round(Math.max(st.m.centerDist / 2 + 8, 14), 1),
              });
              cur2 = node;
            }
          }
          ringCross(cur2, sb, false);
          branchSegs++;
        } catch (e) {
          rollback();
        }
      }
    }

    /* ---------- ★ 横向区域旁路：把塔外的每个区域接成一条可选通道 ----------
       白模在塔外铺了 3 个区域（地台 + 结构件），并在交汇层用连桥接到环台。
       这里沿白模给的**航点链**（环台落点 → 连桥 → 地台）把它接进图里：
       全部是 kind='ring' 的可选边，任何一段验证不过就整段回滚 —— 绝不影响主轴。
       于是整张图的拓扑真正从「一条塔」变成「塔 + 一圈互联区域」。 */
    let regionBranches = 0;
    for (const rg of (opts.regions || [])) {
      const chain0 = rg.chain && rg.chain[0];
      if (!chain0 || !Array.isArray(rg.chain) || rg.chain.length < 2) continue;
      const anchor = spineAt(rg.level);
      if (!anchor) continue;
      const ni0 = findSpineNode(anchor);
      if (ni0 < 0) continue;
      const snap = { n: nodes.length, e: edges.length, o: objects.length, a: anims.length, g: mechSegs.length };
      const rollback = () => {
        nodes.length = snap.n; edges.length = snap.e;
        objects.length = snap.o; anims.length = snap.a; mechSegs.length = snap.g;
      };
      const write = (i) => ({
        x: rg.chain[i].x, y: rg.chain[i].y, z: rg.chain[i].z,
        angle: Math.atan2(rg.chain[i].z - nodes[ni0].z, rg.chain[i].x - nodes[ni0].x),
        hw: cellS, beam: cellS * 2, size: [cellS * 2, cellS * 2], source: 'region',
      });
      try {
        // ① 先沿环台走到区域所在的角向位置（同层；太近就不必走）
        const A0 = nodes[ni0];
        const d0 = Math.hypot(chain0.x - A0.x, chain0.z - A0.z);
        // 太近就不必沿环台走（否则会摆出一个与主轴重合的节点 → 触发「落点重合」）
        let cur2 = d0 > 4 + cellS ? ringCross(ni0, write(0), false, rg.level) : ni0;
        // ② 沿连桥 / 地台的航点走（每段都在一跳之内）
        for (let k = 1; k < rg.chain.length; k++) {
          const st = write(k);
          const m = measure(nodes[cur2], st);
          const mv = moveKind(m);
          if (!checkLink(P, { move: mv, dist: m.dist, dy: m.dy }).ok) throw new Error('region hop');
          const ni = pushNode(st, bandOfY(st.y));
          addEdge(mv, cur2, ni, 'ring', bandOfY(st.y));
          cur2 = ni;
        }
        regionBranches++;
      } catch (e) {
        rollback();
      }
    }

    cur = spine[spine.length - 1];
    mainPath.length = 0;
    for (const k of spine) mainPath.push(k);
    steps = Math.max(steps, spine.length - 1);
    laneStat = { laneSwitches, branchSegs, lanes: lanes.length, regionBranches };
  }

  /* ---------- ④ 收到终点：够得着就直接连，够不着就补一跳 ---------- */
  if (goalPad && nodes[cur].y >= goalPad.y - apex * 0.9) {
    const e = measure(nodes[cur], goalPad);
    if (checkLink(P, { move: 'jump', dist: e.dist, dy: e.dy }).ok && e.dist > 0.6 && !usedPads.has(goalPad.id)) {
      const ni = pushNode({ x: goalPad.x, y: goalPad.y, z: goalPad.z, angle: nodes[cur].angle, hw: goalPad.hw, beam: goalPad.beam, size: [goalPad.w, goalPad.d], source: 'world', pad: goalPad.id }, bandOfY(goalPad.y));
      addEdge('jump', cur, ni, 'main', bandOfY(goalPad.y));
      usedPads.add(goalPad.id);
      cur = ni; mainPath.push(ni);
    }
  }
  if (goalPad && nodes[cur].y < goalPad.y - 1.2) {
    const bridge = bridgeTo(nodes[cur], goalPad, { grid, P, params, rng, maxD, apex, minCeil, fits });
    if (bridge) {
      const bIdx = bandOfY(bridge.y);
      objects.push(platformDesc(idGen, wt.bands[bIdx].theme, bridge.x, bridge.y, bridge.z, bridge.w, bridge.d, {}));
      const mi = pushNode({ x: bridge.x, y: bridge.y, z: bridge.z, angle: bridge.angle, hw: bridge.hw, beam: Math.min(bridge.w, bridge.d), size: [bridge.w, bridge.d], source: 'placed' }, bIdx);
      addEdge('jump', cur, mi, 'main', bIdx);
      const ni = pushNode({ x: goalPad.x, y: goalPad.y, z: goalPad.z, angle: bridge.angle, hw: goalPad.hw, beam: goalPad.beam, size: [goalPad.w, goalPad.d], source: 'world', pad: goalPad.id }, bandOfY(goalPad.y));
      addEdge('jump', mi, ni, 'main', bandOfY(goalPad.y));
      usedPads.add(goalPad.id);
      cur = ni; mainPath.push(mi); mainPath.push(ni);
    }
  }

  /* ---------- ⑤ 终点标记 ---------- */
  const last = nodes[cur];
  objects.push({
    type: 'goal',
    over: {
      id: idGen('gl'),
      position: [round(last.x, 3), round(last.y + 4.5, 3), round(last.z, 3)],
      color: wt.bands[wt.bands.length - 1].theme.goal,
    },
  });

  /* ---------- ⑥ 岔路平台：造出「直跳 / 绕一步」的选择（空间行动多样性） ---------- */
  let detours = 0;
  const mainEdgeList = mainEdges.slice();
  for (const ei of mainEdgeList) {
    if (detours >= MAX_DETOUR) break;
    const e = edges[ei];
    // ★ 不要再按「缺口大小」筛：世界优先管线的链上台阶缺口≈0，
    //   按旧口径筛会把所有主体边都排除掉，于是一条岔路都生不出来。
    if (!e || e.move !== 'jump') continue;
    if (!rng.chance(params.detourChance)) continue;
    const A = nodes[e.from], B = nodes[e.to];
    const made = tryDetour({ index, pads, usedPads, A, B, from: e.from, to: e.to, section: e.section, P, params, rng, maxD, apex, fits, measure, moveKind,
      theme: wt.bands[e.section].theme, idGen, objects, nodes, edges, addEdge, pushNode });
    if (made) detours++;
  }

  /* ---------- ⑦ 深坑（给水 / 熔岩 / 机制用） ---------- */
  const pits = planPits(nodes, edges, mainEdges, P, maxD);

  /* ---------- ⑧ 逐带汇总（decor / mechanics / 报告都要它） ---------- */
  const secRecs = buildSections(wt, nodes, edges, mainEdges);

  return {
    nodes, edges, mainEdges, mainPath, objects, secRecs, pits,
    animations: anims,
    mechSegs,
    featDebug,
    stats: {
      steps,
      synth: synthCount,
      descents: descentCount,
      worldPads: usedPads.size,
      chain: chainMode ? chainList.length : 0,
      chainMode,
      detours,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      // ★ 主轴上的必经机制段（滑索 / 攀爬 / WallJump / 游泳）与特技段兜底计数
      mechSegs: mechSegs.length,
      mechStats: mechSegs.reduce((a, s) => { a[s.move] = (a[s.move] || 0) + 1; return a; }, {}),
      featFallback,
      skippedFeat,
      // ★ 多股骨架：股道数 / 主轴换股道次数 / 分叉段数（结构复杂度的直接读数）
      lanes: laneStat ? laneStat.lanes : 1,
      laneSwitches: laneStat ? laneStat.laneSwitches : 0,
      branchSegs: laneStat ? laneStat.branchSegs : 0,
      // ★ 塔外区域接进图里的条数（「多区域连通」的直接读数）
      regionBranches: laneStat ? laneStat.regionBranches : 0,
    },
  };
}

/* ============================================================
   特技段兜底：沿 A→T 补一串可跳的板
   ------------------------------------------------------------
   只在「机制段模板摆不出来」时使用（正常永远不会走到）。
   · 竖井（两点几乎同轴）：在**同一根柱子**上竖向叠台阶，每级抬 ≤ 一跳顶点
   · 裂谷（水平缺口大）：沿直线等分铺板，每段落在一记平跳的射程内
   ============================================================ */
function bridgeLine(A, T, ctx) {
  const { cell, apex, fits, measure, moveKind, P } = ctx;
  const dx = T.x - A.x, dz = T.z - A.z;
  const d = Math.hypot(dx, dz);
  const dy = T.y - A.y;
  const vertical = d < Math.max(4, Number(A.hw) || 3);
  const riseStep = Math.min(apex * 0.85, Math.max(2, cell));
  const steps = vertical
    ? Math.max(2, Math.ceil(Math.abs(dy) / riseStep))
    : Math.max(2, Math.ceil(Math.max(d, 0.1) / Math.max(4, ctx.maxLeg || 8)));
  const out = [];
  const size = Math.max(5, cell * 1.4);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = round(A.x + dx * t, 3);
    const z = round(A.z + dz * t, 3);
    const y = round(A.y + dy * t, 3);
    if (!fits(x, y, z, size, size)) return null;
    out.push({ x, y, z, w: size, d: size, hw: size / 2, angle: Math.atan2(dz, dx) });
  }
  // 逐段落验证：每一跳都必须合法，否则这串板没有意义
  let cur = A;
  for (const s of out) {
    const e = measure(cur, s);
    if (!checkLink(P, { move: moveKind(e), dist: e.dist, dy: e.dy }).ok) return null;
    cur = s;
  }
  return out;
}

/* ============================================================
   转向：本带外壳的 pattern 决定「空间形态」
   ------------------------------------------------------------
   盘旋 / 之字 / 直线 / 游走 —— 这是「空间行动多样性」的第一层。
   但主轴的底线是**要走到终点**：所以把结果限制在基准朝向 ±75° 之内，
   转得再花也始终朝着出口推进。
   ============================================================ */
function desiredAngle(A, guide, band, params, rng, steps, coilDir) {
  const base = Math.atan2(guide.z - A.z, guide.x - A.x);
  const pat = band.pattern || 'wander';
  let lo = params.turnMin, hi = params.turnMax, scale = 1, dir;
  if (pat === 'straight') { lo *= 0.15; hi *= 0.45; }
  else if (pat === 'coil') { lo = Math.max(lo, 45); hi = Math.max(hi, 92); scale = 0.6; dir = coilDir; }
  else if (pat === 'zigzag') { lo = Math.max(lo, 32); hi = Math.max(hi, 82); scale = 0.55; dir = (steps % 2 === 0 ? 1 : -1); }
  else { scale = 0.7; }
  if (!dir) dir = rng.sign();
  let off = rng.range(lo, hi) * dir * scale * DEG;
  off = clamp(off, -75 * DEG, 75 * DEG);
  return base + off;
}

/* ============================================================
   候选台面打分：把三条设计核心写成目标函数
   ============================================================ */
function scoreCandidate(e, p, A, desired, guide, ahead, params, maxD, rng, dyWant) {
  const gapRatio = e.dist / maxD;
  const gapMatch = 1 - Math.min(1, Math.abs(gapRatio - params.gapRatio) / 0.45);
  const ang = Math.atan2(p.z - A.z, p.x - A.x);
  const align = Math.cos(ang - desired);
  const progress = (p.y - A.y) / Math.max(1, guide.y - A.y);
  const rise = e.dy;
  const want = Math.max(0.6, Number(dyWant) || 1.2);

  let s = 1.5 * progress + 1.55 * gapMatch + 0.95 * align;
  if (rise >= 0) s += 0.45 * clamp(rise / 1.8, 0, 1);
  else if (ahead > 1.5 && rise >= -FALL_DIP_MAX) s += 0.6;      // 领先才允许的局部下降
  else s -= 3.2;                                                // 落后还下沉 → 重罚
  // 步子别迈太大：一记 5 stud 的台阶虽然能上，但那是「楼梯」不是跑酷，
  // 而且会让内容量（连接条数）塌下来。超过 2.6×dyWant 就开始扣分。
  s -= 1.0 * Math.max(0, rise - 2.6 * want) / want;
  s += 0.85;                                                    // 落在真实台面上的奖励
  if (p.beam <= 3.2) s += 0.25;                                 // 窄台面给一点加成
  s += rng.range(0, 0.45);
  return s;
}

/* ============================================================
   补板：世界够不着时，在空中放一块台面
   ------------------------------------------------------------
   不是随手乱放 —— 生成 10 个候选（不同转向 / 落差 / 缺口 / 尺寸），
   只保留**空间放得下**的，再按「贴着世界的墙（open 小）+ 朝向理想」挑最好的。
   贴着墙放 → 看起来像是世界本来就长这样，而不是飘在空中的浮岛。
   ============================================================ */
function trySynth(A, ctx) {
  const { grid, P, params, rng, desired, dyWant, maxD, apex, ahead, fits, openAt, strict } = ctx;
  let best = null;
  const n = strict ? 14 : 10;
  for (let k = 0; k < n; k++) {
    const ang = desired + rng.range(-1, 1) * (strict ? 1.0 : 0.7);
    let dy;
    if (ctx.dipWant != null) {
      // 局部下降：明确往下沉一小步（深度压在 1.6 之内，才爬得回来）
      dy = -round(clamp(Math.abs(ctx.dipWant), 0.6, 1.6), 3);
    } else if (!strict && ahead > 1.8 && rng.chance(0.20)) {
      dy = -round(Math.min(rng.range(DIP_MIN, DIP_MAX), ahead * 0.5), 3);   // 局部下降
    } else {
      dy = round(clamp(dyWant * rng.range(0.9, 1.12), DIP_MIN, 1.8), 3);
    }
    // ★ 向下是「自由下落」，射程口径完全不同（只有水平速度 × 下落时间）：
    //   用跳跃射程去算下落缺口，会生成一条解析层判定为「够不到」的非法边。
    const reach = dy < -0.25 ? P.sp * dropTime(-dy, P) : jumpReach(P, dy);
    if (!Number.isFinite(reach) || reach < 2) continue;
    const size = rng.range(Math.max(2, params.beamMin), Math.max(3, params.beamMax));
    const hw = size / 2;
    const gap = clamp(reach * params.gapRatio * rng.range(1 - params.gapJitter, 1 + params.gapJitter), 1.2, Math.max(1.2, reach - 0.2));
    if (!(gap > 0.8)) continue;
    // 起点一侧的半径要用**方向支撑半径**：大地面沿轴向能伸到几十 stud，
    // 用内切 hw(≤10) 会把补板摆进地面里，边到边缺口也就算错了。
    const supA = support(A, Math.cos(ang), Math.sin(ang));
    const x = A.x + Math.cos(ang) * (supA + gap + hw);
    const z = A.z + Math.sin(ang) * (supA + gap + hw);
    const y = A.y + dy;
    if (!fits(x, y, z, size, size)) continue;
    const open = openAt(x, y, z);
    const wallHug = clamp(1 - open / (maxD * 1.1), 0, 1);
    const gapMatch = 1 - Math.min(1, Math.abs((gap / maxD) - params.gapRatio) / 0.45);
    const align = Math.cos(ang - desired);
    const sc = 1.3 * wallHug + gapMatch + 0.8 * align + rng.range(0, 0.25);
    const cand = { x: round(x, 3), y: round(y, 3), z: round(z, 3), w: round(size, 3), d: round(size, 3), hw, dy, angle: ang, sc, open: round(open, 2) };
    if (!sane([cand.x, cand.y, cand.z], [cand.w, cand.d])) continue;
    if (!best || sc > best.sc) best = cand;
  }
  return best;
}

/** 连接口径（模块级）：给定两个「带 size 的落点」，算出边与移动类型 */
function linkOf(A, B) {
  const e = mkEdge(A, B);
  const mv = e.dy < -0.25 ? 'fall'
    : (e.dist < 1.2 && Math.abs(e.dy) <= STEP_H * 0.9 ? 'walk' : 'jump');
  return { move: mv, dist: e.dist, dy: e.dy, centerDist: e.centerDist };
}

/**
 * 在 A 附近、按**指定落差 dy**（可正可负）放一块板。
 * 与 trySynth 的区别：落差是外部指定的、射程口径按方向自动切换（上跳用跳跃射程、
 * 下坠用自由落体射程），所以能用来拼「下沉->折返」这种先下后上的模板。
 */
function synthAt(A, ctx, dy, angBase) {
  const { P, params, rng, maxD, fits, openAt } = ctx;
  const reach = dy < -0.25 ? P.sp * dropTime(-dy, P) : jumpReach(P, dy);
  if (!Number.isFinite(reach) || reach < 1.5) return null;
  let best = null;
  for (let k = 0; k < 14; k++) {
    const ang = angBase + rng.range(-0.9, 0.9);
    const size = rng.range(Math.max(2, params.beamMin), Math.max(3, params.beamMax));
    const hw = size / 2;
    const gap = clamp(reach * params.gapRatio * rng.range(0.75, 1.05), 1.0, Math.max(1.0, reach - 0.3));
    const supA = support(A, Math.cos(ang), Math.sin(ang));
    const x = A.x + Math.cos(ang) * (supA + gap + hw);
    const z = A.z + Math.sin(ang) * (supA + gap + hw);
    const y = A.y + dy;
    if (!fits(x, y, z, size, size)) continue;
    const open = openAt(x, y, z);
    const sc = clamp(1 - open / (maxD * 1.1), 0, 1) + rng.range(0, 0.3);
    const cand = { x: round(x, 3), y: round(y, 3), z: round(z, 3), w: round(size, 3), d: round(size, 3), hw, angle: ang, sc };
    if (!best || sc > best.sc) best = cand;
  }
  return best;
}

/* ============================================================
   段落模板：「下沉 -> 折返」
   ------------------------------------------------------------
   ★ 为什么必须专门做模板：攀登链是**连续上升**的台阶，链的下方正好被上一级台面
     占住净空，随手往下补一块板一定 `fits` 失败 —— 这就是局部下降一直长不出来的原因。

   模板把「一次下沉 + 两次爬升」摊成三段（相对进入点 A 的高度）：
        A(y0) ──下落 h1──> D(y0−h1) ──上跳 h2──> R(y0−h1+h2) ──上跳──> T(链上目标)
   约束（保证每一跳都合法）：
        · h1 ∈ [1.4, 3.2]                      ← 下沉深度，落在开发文档的 dip 区间
        · h2 ∈ [1.3, min(3.4, apex−h1−1.3)]    ← 折返的第一次爬升，且 h1+h2 ≤ apex
        · R→T 的落差 = (T.y − y0) − (h2 − h1)  ← 由链的步高决定，必须 ≤ apex
   为了让 D/R 不落在「链台正下方」那根被占住的柱子上，D 先**横向甩出去**
   （±35°~85°），R 再折向目标 —— 于是它同时带来了横向移动与真实缺口。
   ============================================================ */
function tryDescent(A, T, ctx, rng) {
  const { P, apex } = ctx;
  const h1 = rng.range(1.4, 3.2);
  const h2Max = Math.min(3.4, apex - h1 - 1.3);
  if (h2Max < 1.3) return null;
  const base = Math.atan2(T.z - A.z, T.x - A.x);
  for (let attempt = 0; attempt < 5; attempt++) {
    const side = rng.sign();
    const h2 = rng.range(1.3, h2Max);
    const D = synthAt(A, ctx, -h1, base + side * rng.range(35, 85) * DEG);
    if (!D) continue;
    const lAD = linkOf(A, D);
    if (!(lAD.dist >= 1.0 && checkLink(P, lAD).ok)) continue;
    const R = synthAt(D, ctx, h2, Math.atan2(T.z - D.z, T.x - D.x) + side * rng.range(-45, 45) * DEG);
    if (!R) continue;
    const lDR = linkOf(D, R);
    if (!(lDR.dist >= 1.0 && checkLink(P, lDR).ok)) continue;
    const lRT = linkOf(R, T);
    if (!(lRT.dist >= 1.0 && checkLink(P, lRT).ok)) continue;
    return { D, R, lAD, lDR, lRT, h1: round(h1, 2), h2: round(h2, 2) };
  }
  return null;
}

/** 起点 / 兜底：把整个世界按粗格子扫一遍，找一个放得下的位置
    ★ 只做「移除不了实体、也一定找得到空腔」的搜索：从底部往上逐层扫，
      第一次命中就返回 —— 只要世界里有**任何**开阔空间（攀登链保证有），就一定成功。 */
function findSpot(grid, fits, cx, y, cz, size, rng) {
  const cell = grid.cell;
  const yBase = grid.oy + Math.round((y - grid.oy) / cell) * cell;   // 对齐到体素边界
  const lat = Math.max(2, Math.ceil(size / cell) + 1);               // 水平扫描步长（体素）
  const ox = rng.int(0, lat - 1);
  const oz = rng.int(0, lat - 1);
  const spanY = cell * 10;
  for (let dy = 0; dy <= spanY; dy += cell) {
    const yy = yBase + dy;
    for (let cz2 = 2 + oz; cz2 < grid.nz - 2; cz2 += lat) {
      for (let cx2 = 2 + ox; cx2 < grid.nx - 2; cx2 += lat) {
        const x = grid.ox + (cx2 + 0.5) * cell;
        const z = grid.oz + (cz2 + 0.5) * cell;
        if (fits(x, yy, z, size, size)) return { x: round(x, 3), y: round(yy, 3), z: round(z, 3) };
      }
    }
  }
  return null;
}

/** 出生点候选：最低的、**而且确实还有下一跳**的够宽台面
    ★ 关键：最低的那块台面可能是世界底部的水槽（四面无路），
      落在那里会让路线第 1 步就卡死。所以这里会先验证「它上面还够得着一块台面」。 */
function pickSpawnPad(observed, P) {
  const pads = (observed && observed.pads) || [];
  if (!pads.length) return null;
  const ok = pads.filter((p) => (p.hw || 0) >= 3);          // 太窄的台面不适合当出生点
  const pool = (ok.length ? ok : pads).slice().sort((a, b) => a.y - b.y);
  const apex = jumpApex(P);
  for (const p of pool) {
    for (const q of pads) {
      if (q === p) continue;
      const dy = q.y - p.y;
      if (dy > apex - 0.05 || dy < -FALL_DIP_MAX) continue;
      const e = mkEdge(p, q);
      // 同上：同一块台面（dist≈0 且同高）不算「下一跳」；错开的台阶算
      if (e.dist < 0.9 && Math.abs(e.dy) < 0.6) continue;
      if (checkLink(P, { move: dy < -0.25 ? 'fall' : 'jump', dist: e.dist, dy }).ok) return p;
    }
  }
  return pool[0] || pads[0];
}

/** 朝目标台面补最后一跳（尽量落在它的下风处） */
function bridgeTo(A, goalPad, ctx) {
  const { grid, P, params, rng, maxD, apex, fits } = ctx;
  const base = Math.atan2(goalPad.z - A.z, goalPad.x - A.x);
  for (let k = 0; k < 10; k++) {
    const ang = base + rng.range(-0.6, 0.6);
    const dy = clamp((goalPad.y - A.y) * 0.55, 0.6, apex * 0.85);
    const reach = jumpReach(P, dy);
    if (!Number.isFinite(reach)) continue;
    const size = clamp((params.beamMin + params.beamMax) * 0.5, 3, 9);
    const hw = size / 2;
    const gap = Math.min(reach * 0.85, Math.max(1.5, Math.hypot(goalPad.x - A.x, goalPad.z - A.z) * 0.6));
    const supA = support(A, Math.cos(ang), Math.sin(ang));
    const x = A.x + Math.cos(ang) * (supA + gap + hw);
    const z = A.z + Math.sin(ang) * (supA + gap + hw);
    const y = A.y + dy;
    if (!fits(x, y, z, size, size)) continue;
    return { x: round(x, 3), y: round(y, 3), z: round(z, 3), w: round(size, 3), d: round(size, 3), hw, angle: ang };
  }
  return null;
}

/* ============================================================
   岔路平台：主轴相邻两点之间塞一块偏离主线的台面
   ------------------------------------------------------------
   直达边保留 → 「直跳（快、险）」与「绕一步（慢、稳）」成为真实选择。
   优先用**观测到的真实台面**当岔路点；没有合适的才补板。
   ============================================================ */
function tryDetour(rc) {
  const { index, pads, usedPads, A, B, from, to, section, P, params, rng, maxD, theme, idGen, objects, nodes, edges, addEdge, pushNode, fits, measure, moveKind } = rc;
  const baseAng = Math.atan2(B.z - A.z, B.x - A.x);
  const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 };
  const ok2 = (st) => {
    const l1 = measure(A, st), l2 = measure(st, B);
    if (l1.dist < 1.0 || l2.dist < 1.0) return null;
    if (!checkLink(P, { move: moveKind(l1), dist: l1.dist, dy: l1.dy }).ok) return null;
    if (!checkLink(P, { move: moveKind(l2), dist: l2.dist, dy: l2.dy }).ok) return null;
    return { l1, l2 };
  };

  // ① 先在观测到的台面里找一块「偏离中线」的
  const cands = index.near(mid.x, mid.y, mid.z, maxD * 1.05, maxD * 0.9);
  for (const j of cands) {
    if (usedPads.has(j)) continue;
    const M = pads[j];
    const dev = Math.abs(angDiff(Math.atan2(M.z - A.z, M.x - A.x), baseAng));
    if (dev < 35 * DEG || dev > 105 * DEG) continue;      // 要真的「绕」出去
    const st = {
      x: M.x, y: M.y, z: M.z, angle: Math.atan2(M.z - A.z, M.x - A.x),
      hw: M.hw, beam: M.beam, size: [M.w, M.d], source: 'world', pad: j, branch: true,
    };
    const chk = ok2(st);
    if (!chk) continue;
    const ni = pushNode(st, M.band);
    addEdge(moveKind(chk.l1), from, ni, 'detour', section);
    addEdge(moveKind(chk.l2), ni, to, 'detour', section);
    usedPads.add(j);
    return true;
  }

  // ② 没有合适的真实台面 → 补一块偏离中线的板
  for (let k = 0; k < 4; k++) {
    const dir = rng.sign();
    const th = rng.range(50, 80) * DEG * dir;
    const leg1 = maxD * rng.range(0.55, 0.78);
    const ang = baseAng + th;
    const high = rng.chance(params.detourHighChance);
    const dy = high ? rng.range(1.2, 1.6) : -rng.range(0.7, Math.min(params.dip, 2.0));
    const size = clamp((params.beamMin + params.beamMax) * 0.45, 2.5, Math.max(2.5, maxD * 0.5));
    const hw = size / 2;
    const x = A.x + Math.cos(ang) * leg1;
    const z = A.z + Math.sin(ang) * leg1;
    const y = A.y + dy;
    if (fits && !fits(x, y, z, size, size)) continue;
    const st = { x: round(x, 3), y: round(y, 3), z: round(z, 3), angle: ang, hw, beam: size, size: [size, size], source: 'placed', branch: true };
    const chk = ok2(st);
    if (!chk) continue;
    objects.push(platformDesc(idGen, theme, x, y, z, size, size, { color: theme.accent }));
    const ni = pushNode(st, section);
    addEdge(moveKind(chk.l1), from, ni, 'detour', section);
    addEdge(moveKind(chk.l2), ni, to, 'detour', section);
    return true;
  }
  return false;
}

const mkEdge = (A, B) => {
  const dx = B.x - A.x, dz = B.z - A.z;
  const cd = Math.hypot(dx, dz);
  const ux = cd > 1e-6 ? dx / cd : 1, uz = cd > 1e-6 ? dz / cd : 0;
  const gap = Math.max(0, cd - support(A, ux, uz) - support(B, -ux, -uz));
  return { move: 'jump', dist: round(gap, 3), centerDist: round(cd, 3), dy: round(B.y - A.y, 3) };
};

/**
 * 轴对齐方块在方向 (ux, uz) 上的支撑半径（半宽在该方向上的投影）。
 * 平台一律没有旋转，所以这个公式是**精确的边到边口径** ——
 * 比「内切半径」保守得多也准得多：大地面不会被误当成小平台。
 */
function support(N, ux, uz) {
  const s = N && N.size;
  const w = (s && Number(s[0])) || Number(N && N.w) || Math.max(2, Number(N && N.hw) || 2) * 2;
  const d = (s && Number(s[1])) || Number(N && N.d) || Math.max(2, Number(N && N.hw) || 2) * 2;
  return Math.abs(ux) * w / 2 + Math.abs(uz) * d / 2;
}
function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* ============================================================
   几何查询：这块地方放得下吗 / 有多开阔
   ============================================================ */
export function fitsFree(grid, P, x, y, z, w, d, minCeil) {
  const cell = grid.cell;
  const head = (Number(minCeil) || 15) + 2;
  // ★ 只检查「落脚面之上」——平台本来就是**摆在已有实体之上**的（贴在台面 / 楼板上）：
  //   平台自身的板厚会与下方实体重叠，那是正常的；能不能放，只看站上去之后头顶够不够。
  //   之前把落脚面之下也算进净空，导致「站在楼板上」永远判失败 → 起点找不到位置。
  const cy0 = Math.floor((y + 0.02 - grid.oy) / cell);
  const cy1 = Math.floor((y + head - grid.oy) / cell);
  const pts = [
    [x - w / 2, z - d / 2], [x + w / 2, z - d / 2],
    [x - w / 2, z + d / 2], [x + w / 2, z + d / 2],
    [x, z],
  ];
  for (const [px, pz] of pts) {
    const cx2 = Math.floor((px - grid.ox) / cell);
    const cz2 = Math.floor((pz - grid.oz) / cell);
    if (cx2 < 0 || cz2 < 0 || cx2 >= grid.nx || cz2 >= grid.nz) return false;
    for (let cy = cy0; cy <= cy1; cy++) {
      if (cy < 0 || cy >= grid.ny) return false;
      if (grid.occ[cix(grid, cx2, cy, cz2)]) return false;
    }
  }
  return true;
}

export function openness(grid, dist, x, y, z) {
  if (!dist) return 0;
  const cx2 = Math.floor((x - grid.ox) / grid.cell);
  const cy = Math.floor((y - grid.oy) / grid.cell);
  const cz2 = Math.floor((z - grid.oz) / grid.cell);
  if (cx2 < 0 || cy < 0 || cz2 < 0 || cx2 >= grid.nx || cy >= grid.ny || cz2 >= grid.nz) return 0;
  return dist[cix(grid, cx2, cy, cz2)] * grid.cell;
}

/* ============================================================
   终点的选择：世界最高、最开阔的台面
   ============================================================ */
function pickGoalPad(observed, wt) {
  const pads = observed.pads || [];
  if (!pads.length) return null;
  const topBands = pads.filter((p) => p.band >= wt.bands.length - 2);
  const pool = topBands.length ? topBands : pads;
  return pool.reduce((a, b) => (b.y > a.y + 0.5 ? b : (Math.abs(b.y - a.y) <= 0.5 && b.open > a.open ? b : a)), pool[0]);
}

/* ============================================================
   深坑：主轴上的大缺口底下掏空的竖井（悬崖 / 熔岩 / 移动平台用）
   ============================================================ */
function planPits(nodes, edges, mainEdges, P, maxD) {
  const pits = [];
  const used = new Set();
  const cands = mainEdges.map((i) => ({ e: edges[i], i }))
    .filter(({ e }) => e && e.move === 'jump' && e.dist > maxD * 0.55)
    .sort((a, b) => b.e.dist - a.e.dist);
  const cap = 4;
  for (const { e, i } of cands) {
    if (pits.length >= cap) break;
    if (used.has(e.section)) continue;
    const a = nodes[e.from], b = nodes[e.to];
    if (!a || !b) continue;
    used.add(e.section);
    const w = clamp(e.dist * 1.1 + 12, 20, 72);
    const depth = clamp(36 + e.dist * 1.4, 44, 120);
    const topY = Math.min(a.y, b.y) - 3;
    pits.push({
      edge: i, section: e.section,
      x: round((a.x + b.x) / 2, 3), z: round((a.z + b.z) / 2, 3), y: round(topY, 3),
      w: round(w, 1), depth: round(depth, 1),
    });
  }
  return pits;
}

/* ============================================================
   逐带汇总：decor / mechanics / 报告都按「带」读
   ============================================================ */
function buildSections(wt, nodes, edges, mainEdges) {
  const recs = wt.bands.map((b) => ({
    key: b.key, shell: b.shell, pattern: b.pattern, kind: 'spine', theme: b.theme,
    themeId: (b.theme && b.theme.themeId) || wt.id, grammar: b.grammar,
    points: [], links: 0, rise: 0, box: null,
  }));
  for (const n of nodes) {
    const r = recs[clamp(n.section, 0, recs.length - 1)];
    r.points.push({ x: n.x, y: n.y, z: n.z, hw: n.hw, beam: n.beam });
  }
  for (const e of edges) {
    const r = recs[clamp(e.section, 0, recs.length - 1)];
    r.links++;
  }
  for (const r of recs) {
    r.box = boxOf(r.points);
    r.rise = r.points.length
      ? round(Math.max(...r.points.map((p) => p.y)) - Math.min(...r.points.map((p) => p.y)), 3)
      : 0;
  }
  return recs;
}

function boxOf(points) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    const hw = Math.max(2, Number(p.hw) || 2);
    min.x = Math.min(min.x, p.x - hw); max.x = Math.max(max.x, p.x + hw);
    min.y = Math.min(min.y, p.y); max.y = Math.max(max.y, p.y);
    min.z = Math.min(min.z, p.z - hw); max.z = Math.max(max.z, p.z + hw);
  }
  if (!isFinite(min.x)) { min.x = min.y = min.z = 0; max.x = max.y = max.z = 0; }
  return { min, max };
}

export { STEP_H };