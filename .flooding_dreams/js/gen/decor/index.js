/* ============================================================
   程序化装饰 · 对外唯一入口（M1）
   ------------------------------------------------------------
   decorate(level, opts) → { level, report }

   M1 的产物全部是「无碰撞」氛围件（光 / 雾 / 粒子 / 光柱 / 后处理）
   加一层 settings 氛围色 —— 因此可达性在数学上不可能被改变，
   这一点再由 proveInvariance 用真实几何寻路「跑两次」证实。

   输入 level 可以是：
     · js/gen 生成器刚产出的关卡（推荐把 realized.states 作为 opts.route 传进来，
       走廊场就是精确的）
     · 任何一份普通关卡 JSON（路线用最近邻链近似恢复，只用于摆氛围）
   输出是一份新的关卡对象；**不改动入参**，对原关卡是纯增量。
   ============================================================ */
import { clamp } from '../../core/util.js';
import { normalizeLevel } from '../../world/level.js';
import { hashSeed, makeRng, makeIdGen } from '../rng.js';
import { THEME_LIST, themeOf, resolveTheme, themeOptions } from './themes.js';
import { makeFields } from './fields.js';
import { buildAmbience, DEFAULT_BUDGET } from './fxbuilder.js';
import { scatterProps, DEFAULT_STRUCT_BUDGET } from './project.js';
import { proveInvariance, paramOf, decorFingerprint } from './verify.js';

export const DEFAULT_DECOR_OPTS = {
  strength: 0.7,     // 0 = 只留氛围 · 1 = 满配
  verify: true,      // 是否跑可达性不变性证明
};

export function decorate(level, opts = {}) {
  if (!level || !Array.isArray(level.objects)) {
    return { level, report: { ok: false, reason: '传进来的不是一份关卡对象' } };
  }

  const g = (level.meta && level.meta.generated) || {};
  const seed = (opts.seed != null && opts.seed !== '')
    ? String(opts.seed)
    : String(g.seed != null ? g.seed : 1);
  const stRaw = Number(opts.strength);
  const strength = clamp(Number.isFinite(stRaw) ? stRaw : DEFAULT_DECOR_OPTS.strength, 0, 1);

  /* ---------- 生成器的落点表 / 连接表（有的话，可达性验证走「逐段」口径） ---------- */
  const rz = opts.realized || null;
  const states = opts.states || (rz && rz.states) || null;
  const links = opts.links || (rz && rz.links) || null;
  // 图结构（关卡层 M3）：整张图的落点表 + 连接表。给了就按**逐边**证明所有可选路线，
  // 没给则退回只证主轴（states/links）。
  const nodes = opts.nodes || (rz && rz.nodes) || null;
  const edges = opts.edges || (rz && rz.edges) || null;
  const ceilTop = opts.ceilTop != null ? opts.ceilTop : (rz && rz.ceilTop);

  /* ---------- 语义场（先算，主题选择要用到它推出来的世界结构） ---------- */
  const fields = makeFields(level, { route: states || opts.route });

  /* ---------- 主题：先选（用独立随机流），再按主题派生正式随机流 ---------- */
  const baseRng = makeRng(hashSeed(`${level.id || 'lv'}|${seed}|theme`));
  const theme = resolveTheme({
    themeId: opts.themeId,
    structure: opts.structure || fields.structure,
    difficulty: Number(level.difficulty) || 1,
    rng: baseRng,
  });
  const rng = makeRng(hashSeed(`${level.id || 'lv'}|${seed}|${theme.id}|${strength.toFixed(2)}`));
  const idGen = makeIdGen(rng);

  /* ---------- 装配（与 realizer 同一套描述约定：{ type, over }） ---------- */
  const amb = buildAmbience({
    level, theme, fields, rng,
    strength,
    budget: opts.budget,
    idGen,
    // 后处理默认不加（见 fxbuilder.js 的说明）
    postfx: opts.postfx === true,
  });
  // 合并成「本当落进关卡」的扁平对象：指纹要读 type / position / color，所以必须带着 type
  /* ---------- M2 结构装饰：槽位 → 硬约束投影 → 微件 ----------
     全部是零风险件（`physicsMode:'none'`），所以可达性在数学上不可能被改变；
     「不穿模 / 不悬空 / 不挡视线」由 project.js 的 H1/H4/H5/H6 把关。 */
  const struct = (opts.props === false || opts.structureDecor === false)
    ? { objects: [], stats: null, rejects: null }
    : scatterProps({
      fields,
      sections: rz && rz.sections ? rz.sections : null,
      theme, rng, idGen,
      strength,
      budget: opts.structBudget,
      spawn: objPoint(level, 'spawn'),
      goal: objPoint(level, 'goal'),
    });

  const decoObjects = [...amb.objects, ...struct.objects].map((o) => ({ type: o.type, ...o.over }));

  const decorated = applyDecoration(level, decoObjects, amb.settings, { theme, seed, strength });

  /* ---------- ★ 可达性不变性证明（有落点表 → 与关卡层同口径的逐段证明） ---------- */
  const navOpts = {
    off: opts.verify === false,
    states, links, ceilTop,
    // 图结构：给了就按逐边证明**所有可选路线**（主轴 + 环台 + 岔路）
    nodes, edges,
    // ★ 主轴上的必经机制段（滑索 / 攀爬 / WallJump / 游泳）：证明时按机制口径验
    mechLinks: (opts.realized && opts.realized.mechLinks) || null,
    // 关卡层刚证过的基线（repair 的 navProve 结果）→ 装饰层不必再证一遍
    baseline: opts.navBaseline || null,
    ...(opts.nav || {}),
  };
  const P = paramOf(decorated);
  const verification = proveInvariance(level, decorated, P, navOpts);

  const fingerprint = decorFingerprint({
    theme, strength, deco: decoObjects, fields,
    navDelta: verification.navDelta,
  });
  decorated.meta.generated.decor.fingerprint = fingerprint;

  const skipped = !!verification.skipped;
  const rejected = verification.invariant === false;      // ★ 装饰改变了可达性
  const unproven = !skipped && verification.invariant === null;

  const report = {
    ok: !rejected && !unproven,
    rejected,
    unproven,
    themeId: theme.id,
    themeLabel: theme.label,
    seed,
    strength,
    structure: fields.structure,
    hasCeiling: fields.hasCeiling,
    objects: decoObjects.length,
    stats: amb.stats,
    /** M2 结构装饰：件数 / 各槽位分布 / 各母题分布 / 估算三角面 */
    struct: struct.stats,
    /** 各条硬约束否决了多少候选（调试用：全被否决说明主题与结构不匹配） */
    structRejects: struct.rejects,
    settings: Object.keys(amb.settings),
    budget: { ...DEFAULT_BUDGET, ...(opts.budget || {}), ...DEFAULT_STRUCT_BUDGET, ...(opts.structBudget || {}) },
    verification,
    /** 验证口径：perLeg（与关卡层同口径，有落点表）/ global（降级单次 spawn→goal） */
    verifyMode: verification.mode || (skipped ? 'off' : 'n/a'),
    /** 基线自己就有问题的段落：别被 ok=true 掩盖 */
    baseline: verification.baseline || null,
    /** 基线是否复用了关卡层刚跑过的证明（省掉一次最贵的 NavGraph） */
    baselineReused: !!(verification.before && verification.before.fromNav),
    collidableAdded: verification.collidableAdded,
    fingerprint,
    reason: verification.reason,
  };

  /* ---------- 兜底：真被证伪就整份退回原关卡，绝不把挡路的装饰交出去 ----------
     （M1 的产物全在 NO_PHYSICS 里，理论上不可能触发；触发即说明有 bug。） */
  if (report.rejected) {
    return {
      level,
      report: { ...report, reason: `装饰被证伪并已放弃：${verification.reason}` },
    };
  }

  return { level: normalizeLevel(decorated), report };
}

/* ============================================================
   增量拼装：只追加对象、只叠加氛围 settings
   ============================================================ */

function applyDecoration(level, decoObjects, envSettings, { theme, seed, strength }) {
  const gen = { ...((level.meta && level.meta.generated) || {}) };
  gen.decor = { themeId: theme.id, themeLabel: theme.label, seed, strength, version: 1 };

  return {
    ...level,
    // envSettings 里的 fog / ambient / sun 已是整块合成好的对象，浅合并即整体替换
    settings: { ...(level.settings || {}), ...(envSettings || {}) },
    objects: [...level.objects, ...decoObjects],
    meta: { ...(level.meta || {}), generated: gen },
  };
}

/* 对外再导出：UI 需要主题下拉与预算默认值 */
export { themeOptions, THEME_LIST, themeOf, DEFAULT_BUDGET, DEFAULT_STRUCT_BUDGET };

/** 取某个类型对象的坐标（spawn / goal 的安全区判定用） */
function objPoint(level, type) {
  for (const o of (level && level.objects) || []) {
    if (!o || o.type !== type) continue;
    const p = o.position || [0, 0, 0];
    return { x: Number(p[0]) || 0, y: Number(p[1]) || 0, z: Number(p[2]) || 0 };
  }
  return null;
}