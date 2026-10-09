/* ============================================================
   程序化生成 · 对外唯一入口（世界优先管线）
   ------------------------------------------------------------
   新管线的顺序：**先有世界，再有跑酷，最后才是装饰**
     主题 → 白模（Phase A）→ 迭代演化（Phase B）
          → 观测世界 → 排布跑酷 → 填水域（Phase C）→ 装饰（Phase D）

   generate({ difficulty, structure, seed, themeId, ... })
     → { level, report }
   level 是一份合法的 flooding-dreams-level JSON（已过 normalizeLevel），
   可以直接丢给编辑器打开 / 试玩 / 存档。
   ============================================================ */
import { clamp, sanitizeName } from '../core/util.js';
import { createEmptyLevel, normalizeLevel } from '../world/level.js';
import { hashSeed } from './rng.js';
import { generateVerified } from './repair.js';
import { shellSettings, SHELLS, shellOf, dominantShell } from './shell.js';
import { structureList } from './world/structures.js';
import { sectionSummary, graphSummary } from './world/index.js';
import { timeLimitFor, pacingBudget, paramsFor } from './difficulty.js';
import { mechanismSummary } from './mechanics.js';
import { decorate } from './decor/index.js';
import { baselineFromNav } from './decor/verify.js';
import { generateCoreAsync, yieldFrame, workerState, poolSize } from './asyncjob.js';

/** 同步生成（脚本 / 离线调用用；会独占主线程，UI 请用 generateAsync） */
export function generate(opts = {}) {
  const difficulty = clamp(Number(opts.difficulty) || 1, 0.5, 9.99);
  return assemble(generateVerified({ ...opts, difficulty }), opts, difficulty);
}

/**
 * 异步生成（编辑器用）：并行世界候选在 Web Worker 池里跑，
 * 主线程只做 NavGraph 证明、装配与装饰 —— 生成期间界面不卡。
 * @param onProgress (info) => void：{ attempt, attempts, phase, msg, … }
 */
export async function generateAsync(opts = {}, onProgress) {
  const difficulty = clamp(Number(opts.difficulty) || 1, 0.5, 9.99);
  const r = await generateCoreAsync({ ...opts, difficulty }, onProgress);
  if (onProgress) onProgress({ phase: 'assemble', msg: '正在写入关卡…' });
  await yieldFrame();
  return assemble(r, opts, difficulty);
}

/** 把一次「世界 + 跑酷 + 证明」的结果装配成完整关卡 + 报告（主线程） */
export function assemble(r, opts = {}, difficulty = 1) {
  const { plan, realized, verify } = r;
  if (!plan || !realized || !verify) {
    throw new Error('生成失败：没得到可用的世界'
      + (r && r.reason ? `（${r.reason}）` : '（换个种子或降低难度再试）')
      + (r && r.world ? ` · 已生成 ${r.world.boxes ? r.world.boxes.length : 0} 个体块` : ''));
  }
  const wi = realized.worldInfo || {};

  /* ---------- 关卡骨架 ---------- */
  const level = createEmptyLevel({
    id: opts.id || 'gen_' + hashSeed(plan.seed).toString(36),
    name: sanitizeName(opts.name || defaultName(plan), '程序生成关'),
    author: opts.author || '洪梦 · 世界生成器',
    description: opts.description || defaultDesc(plan, verify, realized),
    difficulty,
  });

  /* ---------- 设置 ----------
     复合世界结构下雾 / 天空取「占比最大」的那一带来定（主导结构）。 */
  const sections = plan.sections.length;
  const limit = timeLimitFor(difficulty, verify.estTime);
  const dom = dominantShell(realized.sections);
  const fp = verify.fingerprint;
  Object.assign(level.settings, shellSettings(dom), {
    timeLimit: Number.isFinite(Number(opts.timeLimit)) ? Number(opts.timeLimit) : plan.timeLimit,
    // 一命通：没有检查点，死一次即结束（与「洪水逃生」语义一致）
    deathLimit: Number.isFinite(Number(opts.deathLimit)) ? Number(opts.deathLimit) : 1,
    voidY: -900,
    objective: opts.objective
      || `一命逃到发光的终点 · 净爬升 ${Math.round(fp.netRise)} stud · `
        + `${fp.choices} 条可选路线 · 洪水正在上涨（${plan.params.tier.label} ${difficulty.toFixed(1)}）`,
  });

  /* ---------- 对象：只给最小必要字段，其余交给 normalizeObject ---------- */
  level.objects = realized.objects.map((d) => ({ type: d.type, ...d.over }));
  if (realized.animations && realized.animations.length) level.animations = realized.animations;
  // ★ 开局事件（水上升…）：只给最小字段，其余交给 normalizeEvent / normalizeAction
  if (realized.events && realized.events.length) level.events = realized.events;

  const mechSummary = mechanismSummary(realized.mechanisms);
  const world = realized.world || null;
  level.meta = {
    ...level.meta,
    generated: {
      seed: plan.seed,
      difficulty,
      pipeline: 'world-first/v1',
      // 世界结构：从幽闭一路逃向开阔的纵向分带
      structures: (realized.sections || []).map((s) => s.key),
      dominantStructure: dom.key,
      themeId: plan.themeId,
      bands: (realized.sections || []).map((s) => s.grammar || s.key),
      graph: graphSummary(realized),
      netRise: fp.netRise,
      fingerprint: fp,
      // ★ 主轴上的「必经机制段」（滑索 / 攀爬 / WallJump / 游泳）：
      //   编辑器算耗时 / 证明时必须按机制口径验，否则会把它们当成「跳不过去」。
      mechLinks: (realized.mechLinks || []).map((m) => ({ move: m.move, a: m.a, b: m.b })),
      mechSegs: (realized.routeStats || {}).mechStats || null,
      attempts: r.attempts,
      lanes: r.lanes,
      analytic: !r.failed,
      navProven: r.navProven,
      navMode: r.navMode,
      // Phase A/B：世界（白模 + 演化）
      world: world ? {
        style: wi.style,
        styleLabel: wi.styleLabel,
        cell: world.cell,
        boxes: world.boxes,
        cells: world.cells,
        massRatio: world.massRatio,
        bandCount: wi.bandCount,
        grammarChain: wi.grammarChain,
        height: wi.height,
        span: wi.span,
        evolve: wi.evolve,
        score: wi.score,
        // ★ 多体结构（若干互相咬合的体量）+ 塔外区域 + 用到的结构件（报告/工具都能读）
        masses: wi.masses || [],
        massCount: wi.massCount || 0,
        topPieces: wi.topPieces || [],
        regions: wi.regions || [],
        piecesUsed: wi.piecesUsed || [],
        pieceCatalog: (wi.pieceCatalog || []).map((p) => p.id),
      } : null,
      observe: wi.observe || null,
      route: realized.routeStats || null,
      water: realized.water || null,
      // Phase C 的机制（旁路 / 加速 / 惩罚，不改主轴）
      mechanisms: mechSummary ? mechSummary.stats : null,
    },
  };

  const out = normalizeLevel(level);
  const report = {
    ok: !r.failed,
    navProven: r.navProven,
    navMode: r.navMode,
    nav: r.nav ? summarizeNav(r.nav) : null,
    attempts: r.attempts,
    lanes: r.lanes || 0,
    candidates: r.candidates || null,
    estTime: verify.estTime,
    pacingBudget: pacingBudget(difficulty, sections),
    timeLimit: out.settings.timeLimit,
    traversalRatio: out.settings.timeLimit ? round2(verify.estTime / out.settings.timeLimit) : 0,
    deathLimit: out.settings.deathLimit,
    sections,
    sectionInfo: sectionSummary(realized),
    graph: graphSummary(realized),
    bands: (realized.sections || []).map((s) => s.grammar || s.key),
    structures: plan.shells,
    dominantStructure: dom.key,
    structureLabel: dom.label.split('（')[0],
    themeId: plan.themeId,
    themeLabel: plan.themeLabel,
    /* ---- 世界（Phase A/B） ---- */
    world,
    worldInfo: wi,
    evolve: wi.evolve || null,
    score: wi.score,
    /* ---- 观测 / 跑酷 / 水域（Phase C） ---- */
    observe: wi.observe || null,
    route: realized.routeStats || null,
    water: realized.water || null,
    // ★ 开局事件（水上升…）
    events: realized.events || [],
    mechanisms: mechSummary,
    pits: (realized.pits || []).length,
    netRise: fp.netRise,
    ceilTop: realized.ceilTop,
    fingerprint: fp,
    fpCheck: r.fpCheck,
    failures: verify.failures,
    log: r.log,
    worker: workerState(),
    poolSize: poolSize(),
  };

  /* ---------- 可选：装饰层（Phase D）
     opts.decor = true | { themeId, strength, budget, verify }；也可只给 opts.themeId。
     ★ 主题 id 默认沿用关卡层解析出来的那个，两层的配色才会是同一套。 */
  if (opts.decor || opts.themeId) {
    const d = decorate(out, {
      ...(opts.decor && typeof opts.decor === 'object' ? opts.decor : null),
      themeId: opts.themeId || plan.themeId,
      seed: opts.decorSeed,
      realized,
      navBaseline: opts.decorBaseline === false ? null : baselineFromNav(r.nav),
    });
    report.decor = d.report;
    return { level: d.level, report };
  }

  return { level: out, report };
}

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 把 NavGraph 的报告压成 UI 够用的形状 */
function summarizeNav(nav) {
  return {
    ok: nav.ok,
    blocked: nav.blocked,
    unproven: nav.unproven,
    truncated: nav.truncated,
    overBudget: !!nav.overBudget,
    reason: nav.reason,
    meshes: nav.meshes,
    nodes: nav.nodes,
    scanMs: nav.scanMs,
    ms: nav.ms,
    legs: (nav.legs || []).length,
    // ★ 机制边（滑索 / 攀爬 / WallJump / 游泳）：按机制口径单独证明的那几条
    mechLegs: nav.mechLegs || 0,
    mechBlocked: nav.mechBlocked || 0,
    failedLegs: (nav.legs || []).filter((l) => !l.ok).slice(0, 8),
  };
}

function defaultName(plan) {
  return `${plan.params.tier.label} ${plan.difficulty.toFixed(1)} · 世界生成关`;
}

function defaultDesc(plan, verify, realized) {
  const fp = verify.fingerprint;
  const wi = realized.worldInfo || {};
  const chain = (realized.sections || [])
    .map((s) => shellOf(s.key).label.split('（')[0]).join(' → ');
  const mech = mechanismSummary(realized.mechanisms);
  const w = realized.water;
  return `世界优先程序化生成（种子 ${plan.seed}）：`
    + `世界「${wi.styleLabel || '—'}」${wi.bandCount || 0} 个纵向结构带（${wi.grammarChain || ''}），`
    + `体块 ${realized.worldBoxes || 0}，质量分 ${(wi.score || 0).toFixed(3)}；`
    + `世界结构 ${chain}；多体结构 ${wi.massCount || 0} 个互相咬合的体量`
    + `（顶面高度 ${[...new Set((wi.masses || []).map((m) => m.top))].sort((a, b) => a - b).join('/')}），`
    + `塔外 ${(wi.regions || []).length} 个横向区域；`
    + `结构件 ${(wi.regionPieces || 0) + (wi.topPieces || []).length} 件`
    + `（${(wi.piecesUsed || []).join(' / ') || '—'}，库 ${(wi.pieceCatalog || []).length} 种）；`
    + `主题「${plan.themeLabel}」。`
    + `跑酷排布：观测到 ${((wi.observe && wi.observe.pads) || 0)} 块真实台面，`
    + `补板 ${(realized.routeStats && realized.routeStats.synth) || 0} 处，`
    + `${fp.mainEdges} 主轴 + ${fp.detourEdges} 岔路（共 ${fp.nodeCount} 落点 / ${fp.edgeCount} 连接）；`
    + `净爬升 ${Math.round(fp.netRise)} stud（向上占比 ${Math.round(fp.climbRatio * 100)}%），`
    + `累计转向 ${fp.turnSumDeg}°。`
    + (w && w.flood ? `洪水：t=0 液面 ${w.surface0}，涨水总量 ${w.riseTotal} stud。` : '')
    + (mech ? `高级机制 ${mech.total} 处（${Object.keys(mech.stats).join(' / ')}）。` : '')
    + `一命通，无检查点。`;
}

/** 世界结构下拉选项：复合递进放在第一项，其后是 6 个 shell 原子与 20 个命名结构 */
export function structureOptions() {
  return [
    { v: 'composite', l: '复合（逐带递进：洞穴 → 室内 → 竖井 → 半封闭 → 露天 → 开阔）' },
    ...SHELLS.map((s) => ({ v: s.key, l: s.label })),
    ...structureList().map((p) => ({ v: p.id, l: p.label, h: p.note })),
  ];
}

/** 只取难度参数（供 UI 预览用） */
export function previewParams(difficulty) {
  return paramsFor(difficulty);
}