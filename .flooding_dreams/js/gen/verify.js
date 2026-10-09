/* ============================================================
   程序化生成 · L3 验证层（图）
   ------------------------------------------------------------
   路线是一张图（主轴 + 环台 + 岔路平台），所以验证口径也按图来：
     · **每条边**都过解析判定 —— 只要每条边合法，任何由合法边拼出的路线都成立
     · 主轴必须从 spawn 连续走到 goal（保证「保底可通关」这条路线存在）
     · 非相邻落点重叠检查改为「跨段才拦」：同一段内的环台/岔路平台本来就该挨着
     · 指纹量化两条设计意图：主要往上（净爬升）+ 空间多样性（累计转向、分支数）
   M2 的 NavGraph 逐边证明在 navcheck.js，口径与这里一致。
   ============================================================ */
import { round } from '../core/util.js';
import { maxJumpDist, checkLink, isMechMove, MECH, STEP_H } from './reach.js';
import { fingerprintTarget } from './difficulty.js';

export function verifyGraph(nodes, edges, mainEdges, P, params) {
  const failures = [];
  let mainTime = 0;
  let allTime = 0;

  /* ---------- 1) 逐边解析判定 ---------- */
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const r = checkLink(P, e);
    if (!r.ok) {
      failures.push({
        index: i,
        kind: e.kind,
        move: e.move,
        dist: e.dist,
        dy: e.dy,
        reason: failureReason(e, r),
      });
    }
    if (Number.isFinite(r.t)) {
      allTime += r.t;
      if (e.kind === 'main') mainTime += r.t;
    }
  }

  /* ---------- 2) 主轴连续性：spawn → …… → goal ---------- */
  const main = walkMain(nodes, edges, mainEdges);
  if (!main.ok) {
    failures.push({ index: -1, kind: 'main', move: '-', dist: 0, dy: 0, reason: main.reason });
  }

  /* ---------- 3) 跨段落点重叠 ---------- */
  const ov = overlapScan(nodes);
  // 只有「几乎完全重合」才算真错（两块平台叠在同一个位置，看起来就是坏的）；
  // 一般的挨着/压边只是设计气味，计入指纹 overlaps 上报，不拦生成。
  if (ov.severe) failures.push(ov.severe);

  const goalIdx = main.ok ? main.last : nodes.length - 1;

  return {
    ok: failures.length === 0,
    failures,
    estTime: round(mainTime, 2),
    allEdgeTime: round(allTime, 2),
    fingerprint: { ...fingerprint(nodes, edges, main, P, mainTime, goalIdx), overlaps: ov.count },
    mainOk: main.ok,
  };
}

function failureReason(e, r) {
  if (e.move === 'walk') return `台阶落差 ${e.dy} 超过抬脚高度 ${STEP_H}`;
  if (isMechMove(e.move)) {
    const m = MECH[e.move];
    return `${m.label}段超出包络（缺口 ${e.dist} > ${m.maxDist} 或落差 ${e.dy} 不在 [${-m.maxDrop}, ${m.maxRise}]）`;
  }
  const reach = Number.isFinite(r.reach) ? round(r.reach, 2) : '—';
  if (e.move === 'fall') return `下落水平缺口 ${e.dist} > 可达 ${reach}（落差 ${e.dy}）`;
  return `${e.kind === 'detour' ? '岔路' : e.kind === 'ring' ? '环台' : '主轴'}缺口 ${e.dist} > 可达 ${reach}（落差 ${e.dy}）`;
}

/** 沿主轴边从 0 号节点走到头，检查是否真的连成一条路线（无断点/无环） */
function walkMain(nodes, edges, mainEdges) {
  let cur = 0;
  const path = [0];
  for (let k = 0; k < mainEdges.length; k++) {
    const e = edges[mainEdges[k]];
    if (!e) return { ok: false, reason: `主轴第 ${k + 1} 条边缺失`, path, last: cur };
    if (e.from !== cur) {
      return { ok: false, reason: `主轴在第 ${k + 1} 条边断开（从节点 ${e.from} 出发，期望 ${cur}）`, path, last: cur };
    }
    cur = e.to;
    path.push(cur);
  }
  return { ok: true, reason: '', path, last: cur };
}

/**
 * 落点重叠扫描：**只拦跨段的，且只拦「几乎完全重合」的**。
 * · 同一段里的环台 / 岔路平台本来就该彼此挨着；
 * · 跨段的普通压边（两块挨在一起）只是不好看，不会开出抄近道 ——
 *   同高度挨着等于并成一块更大的平台，玩家照走不误；
 * · 只有间距小于 0.4×落在安全距离以内时，才是「两块几乎摆在同一处」的真空错，
 *   那种情况在编辑器里一眼就能看出是坏的，必须拦。
 * 结果里 count 会作为设计气味计入指纹，便于后续用「横向漂移」优化。
 */
function overlapScan(nodes) {
  let count = 0;
  let severe = null;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.section === b.section) continue;
      if (Math.abs(a.y - b.y) >= 3) continue;
      const need = (a.beam + b.beam) * 0.45;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d >= need) continue;
      count++;
      // 「几乎完全重合」= 水平极近 **且高度也几乎一样**。只判水平会让
      // 「错开一层的台阶式落点」被误判成坏（世界优先管线里到处都是这种台阶）。
      if (!severe && d < need * 0.25 && Math.abs(a.y - b.y) < 1.2) {
        severe = {
          index: j - 1, kind: 'overlap', move: 'overlap',
          dist: round(d, 2), dy: round(b.y - a.y, 2),
          reason: `第 ${i + 1} 与第 ${j + 1} 个落点几乎完全重合（水平距离 ${round(d, 2)} < ${round(need * 0.25, 2)}，且高度差 ${round(Math.abs(a.y - b.y), 2)} < 1.2）`,
        };
      }
    }
  }
  return { severe, count };
}

/**
 * 难度指纹：描述这张图「实际长什么样」。
 * 洪水逃生的两条设计意图单独量化：
 *   · 主要往上 → netRise / riseSum / climbRatio
 *   · 空间移动多样性 → turnSumDeg（主轴累计转向）+ 分支数（环台 + 岔路）
 */
export function fingerprint(nodes, edges, main, P, estTime, goalIdx) {
  const maxD = Math.max(1e-3, maxJumpDist(P));
  const byKind = { main: 0, ring: 0, detour: 0 };
  let jumpCount = 0, walkCount = 0, fallCount = 0;
  let narrow = 0, totalDist = 0;
  let maxGapRatio = 0, sumGapRatio = 0, gapN = 0;
  const mechCount = { zip: 0, climb: 0, wall: 0, swim: 0 };

  for (const e of edges) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    if (e.move === 'jump') {
      jumpCount++;
      const r = e.dist / maxD;
      gapN++; sumGapRatio += r;
      if (r > maxGapRatio) maxGapRatio = r;
    } else if (e.move === 'walk') walkCount++;
    else if (e.move === 'fall') fallCount++;
    else if (mechCount[e.move] != null) mechCount[e.move]++;
    totalDist += e.centerDist || 0;
    if ((nodes[e.to] && nodes[e.to].beam || 99) <= 3.2) narrow++;
  }

  /* 纵向趋势与转向：都沿主轴量（那才是玩家真正会走的最快路线） */
  const path = main && main.path && main.path.length ? main.path : [0];
  let netRise = 0, riseSum = 0, dropSum = 0, turnRad = 0;
  const g = nodes[goalIdx] || nodes[nodes.length - 1] || { y: 0 };
  const s0 = nodes[0] || { y: 0 };
  netRise = (Number(g.y) || 0) - (Number(s0.y) || 0);
  for (let i = 1; i < path.length; i++) {
    const a = nodes[path[i - 1]], b = nodes[path[i]];
    if (!a || !b) continue;
    const d = (Number(b.y) || 0) - (Number(a.y) || 0);
    if (d >= 0) riseSum += d; else dropSum += -d;
    turnRad += Math.abs(angDiff(b.angle, a.angle));
  }
  const vertical = riseSum + dropSum;
  const n = Math.max(1, edges.length);

  return {
    maxGapRatio: round(maxGapRatio, 3),
    meanGapRatio: round(gapN ? sumGapRatio / gapN : 0, 3),
    narrowRatio: round(narrow / n, 3),
    jumpCount, walkCount, fallCount,
    mechCount,
    mechEdges: mechCount.zip + mechCount.climb + mechCount.wall + mechCount.swim,
    edgeCount: edges.length,
    nodeCount: nodes.length,
    mainEdges: byKind.main || 0,
    ringEdges: byKind.ring || 0,
    detourEdges: byKind.detour || 0,
    choices: (byKind.ring || 0) + (byKind.detour || 0),
    totalDist: round(totalDist, 1),
    estTime: round(estTime || 0, 2),
    /* 洪水逃生的两条设计意图 */
    netRise: round(netRise, 2),
    riseSum: round(riseSum, 2),
    dropSum: round(dropSum, 2),
    climbRatio: round(vertical > 1e-6 ? riseSum / vertical : 0, 3),
    turnSumDeg: Math.round(turnRad * 180 / Math.PI),
  };
}

/** 把角度差归一化到 [-π, π] */
function angDiff(a, b) {
  let d = (Number(a) || 0) - (Number(b) || 0);
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 指纹 vs 目标 */
export function checkFingerprint(fp, params) {
  const target = fingerprintTarget(params.difficulty);
  const deltas = {
    gapRatio: round(fp.maxGapRatio - target.gapRatio, 3),
    meanGapRatio: round(fp.meanGapRatio - target.meanGapRatio, 3),
    narrowRatio: round(fp.narrowRatio - target.narrowRatio, 3),
  };
  const tol = 0.14;
  const ok = Math.abs(deltas.gapRatio) <= tol && Math.abs(deltas.narrowRatio) <= tol + 0.12;
  return { ok, deltas, target };
}
