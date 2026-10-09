/* ============================================================
   世界优先管线 · 总编排
   ------------------------------------------------------------
   「先有世界，再有跑酷，最后才是装饰」——本文件就是这条新顺序的执行者：

     Phase 0  theme.worldTheme   主题 → 世界蓝图（风格 / 调色 / 液体 / 纵向分带）
     Phase A  whitebox.buildWorld 主题白模：独立地造出一个「地方」
     Phase B  evolve.evolveWorld  迭代演化世界结构（模拟退火）
     Phase C  observe → route → water
              观测世界 → 在真实空间上排布跑酷 → 填水域（含涨水）
     Phase D  （由外层 index.js 调装饰层）

   产物形状与旧版**完全兼容**（plan / realized / verify），所以
   装饰层、NavGraph 证明、编辑器装配都不需要改口径。

   ★ 纯计算：不依赖 three / DOM —— 整条管线都能搬进 Web Worker（见 worker.js）。
   ============================================================ */
import { clamp, round } from '../../core/util.js';
import { hashSeed, makeRng, makeIdGen } from '../rng.js';
import { paramsFor } from '../difficulty.js';
import { makeParam, isMechMove } from '../reach.js';
import { verifyGraph, checkFingerprint } from '../verify.js';
import { attachMechanisms, mechanismSummary } from '../mechanics.js';
import { worldTheme, WORLD_STYLES } from './theme.js';
import { structureOf } from './structures.js';
import { buildWorld, worldSummary, pieceCatalog } from './whitebox.js';
import { evolveWorld } from './evolve.js';
import { observeWorld } from './observe.js';
import { planRoute } from './route.js';
import { fillWater } from './water.js';
import { worldBlockDesc } from './parts.js';

/**
 * 跑一遍完整的「世界优先」生成（单次，不含重试 / NavGraph）。
 * @param opts { difficulty, structure, structures, seed, sections, themeId, massingStyle,
 *               cell, evolveIters, gravityScale, timeLimit }
 * @returns { plan, realized, verify, fpCheck, world, seed, log, failed }
 */
export function worldCore(opts = {}, hooks = {}) {
  const onProgress = hooks.onProgress;
  const t0 = Date.now();
  const difficulty = clamp(Number(opts.difficulty) || 1, 0.5, 9.99);
  const params = paramsFor(difficulty);
  // 修复策略：重试时收紧缺口比例（越往后越保守），不改难度定的其它旋钮
  if (Number.isFinite(Number(opts.gapScale)) && Number(opts.gapScale) !== 1) {
    params.gapRatio = clamp(params.gapRatio * Number(opts.gapScale), 0.38, 0.99);
  }
  const seed = opts.seed == null || opts.seed === '' ? String(Date.now()) : String(opts.seed);
  const rng = makeRng(hashSeed(seed));
  const P = makeParam({
    gravityScale: Number.isFinite(Number(opts.gravityScale)) ? Number(opts.gravityScale) : 1,
  });
  const idGen = makeIdGen(rng.fork('id'));
  const log = [];

  const phase = (name, msg) => {
    if (onProgress) onProgress({ phase: name, msg });
  };

  /* ---------- Phase 0：主题 → 世界蓝图 ---------- */
  phase('theme', '正在解析主题与世界结构…');
  const wt = worldTheme({
    difficulty, themeId: opts.themeId, structure: opts.structure,
    structures: opts.structures, sections: opts.sections,
    massingStyle: opts.massingStyle, rng: rng.fork('theme'),
  });

  /* ---------- Phase A：主题白模 ---------- */
  phase('whitebox', `正在按「${wt.styleLabel}」造世界（${wt.bandCount} 个结构带）…`);
  const world = buildWorld(wt, { rng: rng.fork('whitebox'), cell: opts.cell });
  log.push({ phase: 'whitebox', ms: world.ms, boxes: world.boxes.length, cells: world.grid.n });

  /* ---------- Phase B：迭代演化世界结构 ---------- */
  phase('evolve', '正在迭代演化世界结构（模拟退火）…');
  const te = Date.now();
  evolveWorld(world, wt, { rng: rng.fork('evolve'), iters: opts.evolveIters });
  world.evolve.ms = Date.now() - te;
  log.push({ phase: 'evolve', ms: world.evolve.ms, ...world.evolve, trail: undefined, parts: undefined });

  /* ---------- Phase C1：观测世界 ---------- */
  phase('observe', '正在观测世界（落脚面 / 连通 / 空间场）…');
  const observed = observeWorld(world, wt, { P });
  log.push({ phase: 'observe', ...observed.stats });

  /* ---------- Phase C2：排布跑酷 ---------- */
  phase('route', `正在排布跑酷配置（观测到 ${observed.pads.length} 块可用台面）…`);
  const route = planRoute(observed, wt, P, params, rng.fork('route'), {
    grid: world.grid, idGen,
    chain: world.chain,
    // ★ 多股骨架：strands = 每条股道按级排列的踏板；junctions = 交汇环台（换股道的地方）
    strands: world.strands,
    junctions: world.junctions,
    // ★ 塔外的横向区域：连桥落点 / 地台 / 结构件（route 把它们当可选旁路接进图里）
    regions: world.regions,
    // ★ 塔中心（世界坐标）：环台走道要沿**圆弧**走，不能走弦
    axis: world.axis,
  });
  if (!route) {
    return { plan: null, realized: null, verify: null, fpCheck: null, world, wt, seed, log, failed: true, reason: '世界没有可用落脚面' };
  }

  /* ---------- Phase C3：填水域（含涨水） ---------- */
  phase('water', '正在填水域（涨水轨道）…');
  const timeLimit = Number.isFinite(Number(opts.timeLimit))
    ? Number(opts.timeLimit)
    : params.timeLimit;
  const water = fillWater(route, world, wt, {
    P, params, difficulty, timeLimit, idGen, rng: rng.fork('water'),
  });

  /* ---------- 高级机制（旁路 / 加速 / 惩罚；不改主轴） ---------- */
  phase('mech', '正在挂高级机制（滑索 / WallJump / 攀爬 / 输送带…）…');
  const mech = attachMechanisms({
    rng, P, params, nodes: route.nodes, edges: route.edges, secRecs: route.secRecs,
    // 复用机制层的「深坑」口径：世界层的 pits 直接喂进去
    mass: { carve: { pits: route.pits }, topY: world.topY },
    exclude: new Set(['swimSection']),   // 世界层已自带涨水，别再灌一池静态水
    // ★ 主轴上已经是必经机制段的地方（滑索 / 攀爬 / WallJump / 游泳）留白：
    //   旁路机制不许再往同一段塞东西，否则滑索中间会横出一面墙。
    avoid: (route.mechSegs || []).map((s) => ({ x: s.x, y: s.y, z: s.z, r: s.r, v: 26 })),
  });

  /* ---------- 装配对象：世界体块 → 跑酷平台 → 机制 → 水体 ---------- */
  const objects = [];
  const boxList = worldBoxes(world, wt, idGen);
  for (const o of boxList) objects.push(o);
  for (const o of route.objects) objects.push(o);
  for (const o of mech.objects) objects.push(o);
  for (const o of water.objects) objects.push(o);

  /* ---------- 解析自检 ---------- */
  const verify = verifyGraph(route.nodes, route.edges, route.mainEdges, P, params);
  const fpCheck = checkFingerprint(verify.fingerprint, params);

  /* ---------- 主轴视图（装饰层的走廊场用） ---------- */
  const mainPath = route.mainPath.slice();
  const states = mainPath.map((i) => route.nodes[i]).filter(Boolean);
  const links = [];
  for (const ei of route.mainEdges) {
    const e = route.edges[ei];
    if (!e) continue;
    const a = route.nodes[e.from], b = route.nodes[e.to];
    if (!a || !b) continue;
    links.push({
      move: e.move, dist: e.dist, dy: e.dy, centerDist: e.centerDist,
      from: { x: a.x, y: a.y, z: a.z },
      to: { x: b.x, y: b.y, z: b.z, hw: b.hw, beam: b.beam },
    });
  }

  const anims = [
    ...(route.animations || []),
    ...(mech.animations || []),
    ...(water.animations || []),
  ];
  // ★ 事件（开局涨水…）：纯数据，关卡层 normalizeEvent 会补默认字段
  const events = [...(water.events || [])];
  const ceilTop = Math.max(
    world.topY,
    ...wt.bands.map((b) => b.shell.ceilY || 0),
  );

  const plan = {
    seed, difficulty, params, P, rng,
    structure: opts.structure || 'composite',
    theme: wt.theme, themeId: wt.id, themeLabel: wt.label,
    worldTheme: wt,
    shells: wt.bands.map((b) => b.key),
    sections: route.secRecs.map((r) => ({ kind: r.kind, rise: r.rise, shell: r.key, pattern: r.pattern })),
    timeLimit, targetTraversal: params.targetTraversal,
    massingStyle: wt.style,
    climbBudget: wt.climbBudget,
  };

  const realized = {
    objects,
    nodes: route.nodes,
    edges: route.edges,
    mainEdges: route.mainEdges,
    mainPath,
    states, links,
    sections: route.secRecs,
    // 世界（白模 + 演化）——新的三段管线里的「世界」这一层
    world: worldSummary(world),
    worldBoxes: boxList.length,
    worldInfo: {
      style: wt.style, styleLabel: wt.styleLabel,
      // ★ 世界风格 id（= 风格键或主题 id）与世界结构 id / 名称：报告与 UI 直接读，别让它退化成默认值
      styleId: wt.style,
      structureId: wt.structureId,
      structureLabel: wt.structureLabel,
      bandCount: wt.bandCount,
      grammarChain: wt.bands.map((b) => b.grammar).join(' → '),
      height: wt.height, span: wt.span,
      evolve: world.evolve,
      score: world.score,
      observe: observed.stats,
      // ★ 横向区域：每个区域的地台高度 / 连桥半径 / 用到的结构件（报告与 UI 直接读）
      regions: (world.regions || []).map((r) => ({
        tier: r.tier, level: r.level, deckY: r.deckY,
        angle: round(r.ang * 180 / Math.PI, 1), radius: r.radius,
        band: r.band, cells: r.cells,
        pieces: (r.pieces || []).map((p) => p.label),
      })),
      regionPieces: (world.regions || []).reduce((a, r) => a + (r.pieces || []).length, 0),
      // ★ 多体结构：体量清单（各自的平面轮廓 + 顶面高度）—— 「世界是几个体量」的直接读数
      masses: (world.masses || []).map((m) => ({
        i: m.i,
        box: [m.x0, m.y0, m.z0, m.x1, m.y1, m.z1],
        top: round(m.y1, 0),
      })),
      massCount: (world.masses || []).length,
      topPieces: (world.topPieces || []).map((p) => ({ id: p.id, label: p.label, mass: p.mass, y: p.y })),
      // 结构件库目录（24 种）与本次真正用到的那几种（区域 + 体量天台）
      pieceCatalog: pieceCatalog(),
      piecesUsed: [...new Set([
        ...(world.regions || []).flatMap((r) => (r.pieces || []).map((p) => p.label)),
        ...(world.topPieces || []).map((p) => p.label),
      ])],
    },
    observe: observed.stats,
    routeStats: route.stats,
    pits: route.pits,
    water: water.stats,
    mechanisms: mech,
    // ★ 主轴上的必经机制段（滑索 / 攀爬 / WallJump / 游泳）：NavGraph 证明要按它逐段验
    mechSegs: route.mechSegs || [],
    featDebug: route.featDebug || [],
    mechLinks: (route.edges || [])
      .map((e, i) => (isMechMove(e.move) ? { i, move: e.move, from: e.from, to: e.to } : null))
      .filter(Boolean)
      .map((e) => {
        const a = route.nodes[e.from], b = route.nodes[e.to];
        return {
          move: e.move, index: e.i,
          a: { x: a.x, y: a.y, z: a.z, hw: a.hw },
          b: { x: b.x, y: b.y, z: b.z, hw: b.hw },
        };
      }),
    animations: anims,
    events,
    ceilTop,
    theme: wt.theme,
    timeLimit, targetTraversal: params.targetTraversal,
    box: boxOf(route.nodes),
  };

  const res = {
    plan, realized, verify, fpCheck,
    world, wt, seed, attempt: 1,
    log, failed: !verify.ok,
  };
  log.push({ phase: 'verify', ok: verify.ok, failures: verify.failures.length, netRise: verify.fingerprint.netRise, estTime: verify.estTime, ms: Date.now() - t0 });
  return res;
}

/** 世界体块 → mesh 对象（按体块所在高度选该带的配色） */
function worldBoxes(world, wt, idGen) {
  const g = world.grid;
  const out = [];
  const styleDef = WORLD_STYLES[wt.style] || WORLD_STYLES.building;
  for (const box of world.boxes) {
    const sx = box.w * g.cell, sy = box.h * g.cell, sz = box.d * g.cell;
    const cx = g.ox + (box.x + box.w / 2) * g.cell;
    const cy = g.oy + (box.y + box.h / 2) * g.cell;
    const cz = g.oz + (box.z + box.d / 2) * g.cell;
    const band = wt.bands.find((b) => cy >= b.y0 - g.cell && cy <= b.y1 + g.cell) || wt.bands[wt.bands.length - 1];
    out.push(worldBlockDesc(idGen, {
      mat: box.m, x: round(cx, 3), y: round(cy, 3), z: round(cz, 3),
      sx: round(sx, 3), sy: round(sy, 3), sz: round(sz, 3),
    }, band.theme, styleDef));
  }
  return out;
}

function boxOf(points) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points || []) {
    const hw = Math.max(2, Number(p.hw) || 2);
    min.x = Math.min(min.x, p.x - hw); max.x = Math.max(max.x, p.x + hw);
    min.y = Math.min(min.y, p.y); max.y = Math.max(max.y, p.y);
    min.z = Math.min(min.z, p.z - hw); max.z = Math.max(max.z, p.z + hw);
  }
  if (!isFinite(min.x)) { min.x = min.y = min.z = 0; max.x = max.y = max.z = 0; }
  return { min, max };
}

/* ============================================================
   报告摘要（与旧版同名，供外层 index.js / 装饰层读）
   ============================================================ */
export function sectionSummary(realized) {
  return (realized.sections || []).map((r) => ({
    key: r.key,
    pattern: r.pattern,
    kind: r.kind,
    grammar: r.grammar,
    themeId: r.themeId,
    points: r.points.length,
    span: r.box ? round(Math.max(r.box.max.x - r.box.min.x, r.box.max.z - r.box.min.z), 1) : 0,
    ceilY: (r.shell && r.shell.ceilY) || 0,
  }));
}

export function graphSummary(realized) {
  const by = { main: 0, ring: 0, detour: 0 };
  for (const e of realized.edges || []) by[e.kind] = (by[e.kind] || 0) + 1;
  return {
    nodes: (realized.nodes || []).length,
    edges: (realized.edges || []).length,
    main: by.main || 0,
    ring: by.ring || 0,
    detour: by.detour || 0,
    choices: (by.ring || 0) + (by.detour || 0),
  };
}

export { mechanismSummary };