/* ============================================================
   世界优先管线 · 主题蓝图（Phase 0）
   ------------------------------------------------------------
   新管线把顺序整个倒过来：**先有世界，再有跑酷，最后才是装饰**。

     Phase 0（本文件）  主题 → 世界蓝图：风格 / 调色 / 液体 / 纵向分层（世界结构带）
     Phase A（whitebox）按蓝图长出「完美的主题白模」——与路线无关的完整空间
     Phase B（evolve）  迭代演化这张白模，把结构调到「好爬、连通、多样」
     Phase C（observe + route + water）
                        观测世界 → 在真实空间上排布跑酷配置 → 填水域
     Phase D（装饰）    最后才铺氛围与微件

   ★ 与旧版最本质的区别：旧版是「先规划路线 → 再围着路线砌墙」，
     世界只是路线的一条隧道；新版世界是独立生成的**一个地方**，
     路线是算法「读」这个世界之后**排布上去的**。
   ============================================================ */
import { clamp, round } from '../../core/util.js';
import { resolveTheme } from '../decor/themes.js';
import {
  SHELLS, shellOf, isShellKey, anchorShellFor, makeShell, themeFor, SHELL_LADDER, blockStartIx,
} from '../shell.js';
import { paramsFor, sectionsFor } from '../difficulty.js';
import { structuresFor, rhythmFor, depthFor, pcgFor } from './themes/index.js';
import { WORLD_STRUCTURES } from './structures.js';

/* ============================================================
   风格：决定「这世界大体长什么样」（几何口吻，不管配色）
   ============================================================ */
export const WORLD_STYLES = {
  /* ---- 4 个基础风格家族（保持不变） ---- */
  city:     { label: '城市街区（正交塔群 · 街道）', texture: 'grid',   rough: 0.72, metal: 0.12, rocky: false },
  building: { label: '建筑内部（楼板 · 柱网 · 走廊）', texture: 'tiles', rough: 0.62, metal: 0.05, rocky: false },
  rock:     { label: '岩体洞穴（不规则围合 · 石柱）', texture: 'noise',  rough: 0.95, metal: 0.0, rocky: true },
  meadow:   { label: '旷野遗迹（低矮体块 · 稀疏尖塔）', texture: 'bricks', rough: 0.88, metal: 0.0, rocky: false },
  /* ---- 20 个主题专属风格（键 = 主题 id；texture 按 style 家族挑：
          rock→noise / building→tiles / city→grid / meadow→bricks ---- */
  crystalCavern:   { label: '水晶洞（放射晶簇穹顶·棱柱）',     texture: 'noise',  rough: 0.55, metal: 0.15, rocky: true },
  volcanicRidge:   { label: '火山脊（同心阶梯台地·环形堤）',   texture: 'noise',  rough: 0.9,  metal: 0.0,  rocky: true },
  skyIslands:      { label: '浮空岛（离岛圆盘·索桥）',         texture: 'bricks', rough: 0.6,  metal: 0.0,  rocky: false },
  sunkenForest:    { label: '沉没森林（树干格网·树冠网）',     texture: 'bricks', rough: 0.85, metal: 0.0,  rocky: false },
  glacierFjord:    { label: '冰川峡湾（之字形峡壁·悬冰架）',   texture: 'noise',  rough: 0.35, metal: 0.1,  rocky: true },
  desertMesa:      { label: '荒漠台地（平顶方台·石柱桥）',     texture: 'bricks', rough: 0.9,  metal: 0.0,  rocky: false },
  swampMangrove:   { label: '沼泽红树（斜插支柱根·板根）',     texture: 'bricks', rough: 0.8,  metal: 0.0,  rocky: false },
  coralReef:       { label: '珊瑚礁（分叉枝状·环礁）',         texture: 'noise',  rough: 0.7,  metal: 0.05, rocky: true },
  rustedFoundry:   { label: '锈蚀铸造厂（空心高炉·斜输送带）', texture: 'grid',   rough: 0.7,  metal: 0.75, rocky: false },
  subwayTerminus:  { label: '地铁终点站（月台·轨道沟）',       texture: 'tiles',  rough: 0.6,  metal: 0.4,  rocky: false },
  neonArcade:      { label: '霓虹街机厅（机柜阵列·灯箱墙）',   texture: 'tiles',  rough: 0.5,  metal: 0.35, rocky: false },
  serverVault:     { label: '服务器地窖（机柜塔·架空地板）',   texture: 'tiles',  rough: 0.4,  metal: 0.8,  rocky: false },
  skyport:         { label: '空中港（悬空圆盘·斜桥）',         texture: 'grid',   rough: 0.5,  metal: 0.6,  rocky: false },
  hydroDam:        { label: '水坝（阶梯坝体·溢洪道）',         texture: 'grid',   rough: 0.75, metal: 0.5,  rocky: false },
  clockworkAtrium: { label: '钟表中庭（同心环廊·摆锤）',       texture: 'tiles',  rough: 0.5,  metal: 0.65, rocky: false },
  mirrorGallery:   { label: '镜廊（平行镜墙·错位门洞）',       texture: 'tiles',  rough: 0.2,  metal: 0.5,  rocky: false },
  hospitalWing:    { label: '废弃病栋（隔间排·主走廊）',       texture: 'tiles',  rough: 0.6,  metal: 0.2,  rocky: false },
  casinoFloor:     { label: '赌场楼层（环形赌台·灯带）',       texture: 'tiles',  rough: 0.45, metal: 0.35, rocky: false },
  drownedLibrary:  { label: '沉没图书馆（书架巷道·外挑搁板）', texture: 'tiles',  rough: 0.7,  metal: 0.05, rocky: false },
  cathedralNave:   { label: '大教堂中殿（巨柱列·尖拱肋）',     texture: 'tiles',  rough: 0.55, metal: 0.1,  rocky: false },
};

/** (主题 × 结构) → 这一带的白模标签（报告 / UI 用）。
    ★ 体量由主题专属 PCG 画（world/themes/<主题>.js），这里只是给带子起个名字。 */
export function grammarLabel(styleKey, shellKey) {
  const m = pcgFor(styleKey);
  return `${m.label || styleKey}/${shellKey}`;
}

/** 主题没声明风格时，从它的身份关键词确定性猜一个（不占随机流） */
const STYLE_HINT = [
  [/city|urban|street|都市|城市|街区|淹没|沉没/i, 'city'],
  [/hall|corridor|room|building|走廊|室内|楼道|阈限/i, 'building'],
  [/abyss|cavern|cave|deep|rock|洞|渊|岩|矿|荧/i, 'rock'],
  [/meadow|field|ruins|forest|grove|草原|旷野|遗迹|林/i, 'meadow'],
];

export function styleFor(theme) {
  const declared = theme && theme.massing && theme.massing.style;
  if (WORLD_STYLES[declared]) return declared;
  const t = theme || {};
  const hay = [
    t.id, t.label,
    ...(Array.isArray(t.advMat) ? t.advMat : []),
    ...((t.motifs && t.motifs.macro) || []),
    ...((t.motifs && t.motifs.meso) || []),
  ].join(' ');
  for (const [re, s] of STYLE_HINT) if (re.test(hay)) return s;
  return 'building';
}

/** UI 下拉：世界风格（auto = 由主题决定） */
export function styleOptions() {
  return [
    { v: 'auto', l: '自动（按主题决定）' },
    ...Object.keys(WORLD_STYLES).map((k) => ({ v: k, l: `${k}：${WORLD_STYLES[k].label}` })),
  ];
}

/* ============================================================
   世界蓝图
   ============================================================ */

/* ============================================================
   世界结构：智能选择 + 智能搭配 + 智能排列
   ------------------------------------------------------------
   旧版是「从主题 fit 里随机抽一段 + ±1 抖动」——看似随机，其实没有章法：
   每一关的结构序列都差不多，也读不出主题的性格。

   新版由**主题自己**给出结构阶梯（world/themes/<主题>.js 的 structures），
   再分三步排出来：

     ① 智能选择：主题阶梯 ∩ 该关难度允许的档位 —— 越难越往下探（越幽闭），
        于是 Nightmare 从最深处逃，Lucid 直接在开阔处起步。
     ② 智能搭配：只取阶梯的一段**连续区间**，并保证相邻带的开放度不突变
        （突变就在阶梯里插一层中间结构）。
     ③ 智能排列：按主题声明的节奏铺成 count 条带 ——
        rise   一路向上（草原：缓坡 → 露天 → 开阔）
        duplex 两带一循环（城市/荧渊/阈限：室内 ↔ 露天 反复递进）
        收尾一律收到阶梯最开阔的一档（「逃向天光」）。
   ============================================================ */
export function structurePlan(opts = {}) {
  const n = Math.max(1, Math.round(Number(opts.count) || 4));
  const style = WORLD_STYLES[opts.style] ? opts.style : styleFor(opts.theme);
  const themeId = opts.themeId || (opts.theme && opts.theme.id);
  const d = clamp(Number(opts.difficulty) || 1, 0.5, 9.99);

  /* ① 智能选择：主题声明的阶梯（未知主题回退到难度阶梯） */
  let ladder = structuresFor(style, themeId).filter(isShellKey);
  if (!ladder.length) ladder = ladderFrom(d);
  ladder = [...new Set(ladder)].sort((a, b) => shellOf(a).openness - shellOf(b).openness);
  if (!ladder.length) ladder = ['indoor'];

  /* ② 智能搭配：难度决定「往下探多深」，只取阶梯的一段连续区间。
     dive = 0 → 全程停在开阔端；dive = 1 → 从最幽闭的一档起（越难逃得越远）。 */
  const u = clamp((d - 1) / 6, 0, 1);                        // 0 = Lucid，1 = Nightmare
  const dive = clamp(depthFor(style, themeId) + u * 0.5, 0, 1);
  const startIx = Math.max(0, Math.min(ladder.length - 1, Math.round((1 - dive) * (ladder.length - 1))));
  const pool = ladder.slice(startIx);
  // 相邻档的开放度落差太大时，从完整阶梯里补一层中间结构（「搭配」而不是硬拼）
  const bridged = [pool[0]];
  for (let i = 1; i < pool.length; i++) {
    const a = shellOf(bridged[bridged.length - 1]).openness;
    const b = shellOf(pool[i]).openness;
    if (Math.abs(b - a) > 0.45) {
      const mid = ladder.find((k) => {
        const o = shellOf(k).openness;
        return o > Math.min(a, b) + 0.06 && o < Math.max(a, b) - 0.06;
      });
      if (mid && !bridged.includes(mid)) bridged.push(mid);
    }
    bridged.push(pool[i]);
  }

  /* ③ 智能排列：按主题节奏铺 count 条带 */
  const seq = sampleLadder(bridged, rhythmFor(style, themeId), n);
  // 收尾：出口那一带必须是池子里最开阔的（逃向天光）
  if (seq.length && seq[seq.length - 1] !== bridged[bridged.length - 1]) {
    seq[seq.length - 1] = bridged[bridged.length - 1];
  }
  return seq;
}

/** 把阶梯铺成 n 段：rise = 单调推进；duplex = 两带一循环（室内 ↔ 露天） */
function sampleLadder(pool, rhythm, n) {
  const out = [];
  if (rhythm === 'duplex' && n >= 3 && pool.length >= 2) {
    const m = Math.max(1, Math.ceil(n / 2));
    const base = monotone(pool, m);
    for (let i = 0; i < n; i++) {
      const j = Math.min(base.length - 1, Math.floor(i / 2) + (i % 2));
      out.push(base[j]);
    }
  } else {
    out.push(...monotone(pool, n));
  }
  return out;
}

function monotone(pool, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    out.push(pool[clamp(Math.round(t * (pool.length - 1)), 0, pool.length - 1)]);
  }
  return out;
}

/** 按难度从最幽闭到最开阔切一段阶梯（主题没声明结构时的兜底池） */
function ladderFrom(difficulty) {
  const t = clamp((Number(difficulty) - 1) / 5, 0, 1);
  return SHELL_LADDER.slice(blockStartIx(t));
}

/** 纵向分带：显式指定 > 命名结构 preset > 单 shell > 智能计划 */
function resolveBands(opts, params, count, theme, style, rng, preset) {
  const arr = Array.isArray(opts.structures) ? opts.structures.filter(isShellKey) : null;
  if (arr && arr.length) return Array.from({ length: count }, (_, i) => arr[i % arr.length]);
  // ★ 命名结构：直接把 preset 的阶梯铺到各带（等价于 structures = preset.ladder），
  //   节奏按 preset 的 rhythm（duplex 走两带一循环，否则一路向上）。
  if (preset) {
    const ladder = (preset.ladder || []).filter(isShellKey);
    if (ladder.length) {
      const seq = preset.rhythm === 'duplex' ? sampleLadder(ladder, 'duplex', count) : ladder;
      return Array.from({ length: count }, (_, i) => seq[i % seq.length]);
    }
  }
  const st = opts.structure;
  if (isShellKey(st)) return Array.from({ length: count }, () => st);
  return structurePlan({
    theme, themeId: opts.themeId, style, difficulty: params.difficulty, count, rng,
  });
}

/**
 * 主题 → 世界蓝图。
 * @returns {
 *   id, label, style, styleLabel, palette, liquid, fit,
 *   height, span, bands[], seedBase, massingStyle
 * }
 *   bands[i] = { i, key, shell, pattern, grammar, y0, y1, rise, theme(配色) }
 */
export function worldTheme(opts = {}) {
  const difficulty = clamp(Number(opts.difficulty) || 1, 0.5, 9.99);
  const params = paramsFor(difficulty);
  const rng = opts.rng;
  const theme = opts.theme || resolveTheme({
    themeId: opts.themeId,
    structure: anchorShellFor(opts.structure, difficulty),
    difficulty,
    rng,
  });

  const style = WORLD_STYLES[opts.massingStyle] ? opts.massingStyle : styleFor(theme);

  /* ★ 命名结构：opts.structure 命中 WORLD_STRUCTURES 时，用该 preset 的阶梯当本关结构阶梯，
     并把它的 id / label 记进蓝图供报告用（composite / 单 shell 两条老路径不受影响）。 */
  const preset = opts.structure && WORLD_STRUCTURES[opts.structure] ? WORLD_STRUCTURES[opts.structure] : null;
  const structOverride = !!(preset && !(Array.isArray(opts.structures) && opts.structures.length));

  /* 纵向预算：**爬升预算与世界高度解耦** ——
     爬升由难度决定（sectionRise × 内容量），世界高度 = 爬升 + 上下留白；
     带数只决定「切成几段」（每带 ≈ 26 stud，约 5~7 个体素），
     所以每一条结构带都是一个能站人、能形成空间感的「大地形层」。
     ★ ×1.35 与 layout 上限 26：世界更高 → 攀登链更长 → 连接条数更多，
       跑图耗时（内容量）才撑得起关卡时长（目标占比 25%~35%）。 */
  const layout = Number(opts.sections) || sectionsFor(params);
  const climbBudget = params.sectionRise * clamp(layout, 8, 26) * 1.35;
  // ★ 命名结构：带数直接取阶梯长度（plan.shells 就是该 preset 的 ladder）；
  //   其余路径维持按爬升预算切的 3~8 带。
  const bandCount = structOverride
    ? preset.ladder.filter(isShellKey).length
    : clamp(Math.round(climbBudget / 30), 3, 8);
  const keys = resolveBands(opts, params, bandCount, theme, style, rng, structOverride ? preset : null);

  const padTop = 34;                                   // 出口平台之上留出的天光空间
  const padBot = 22;                                   // 起点平台之下的余量
  const height = round(climbBudget + padTop + padBot, 3);
  const span = round(clamp(height * 0.72, 130, 300), 3);   // 水平尺度：路线要拐得开

  // 每带的爬升预算：均分后再向高处略加权（越接近出口节奏越紧）
  const wsum = keys.reduce((a, _, i) => a + (0.85 + (bandCount === 1 ? 0 : i / (bandCount - 1)) * 0.3), 0);
  const rises = keys.map((_, i) => climbBudget * (0.85 + (bandCount === 1 ? 0 : i / (bandCount - 1)) * 0.3) / wsum);

  const minCeil = 15;                                   // 只作外壳低顶的抬升参考，精确值在 reach 层
  let y = 0;
  const bands = [];
  for (let i = 0; i < bandCount; i++) {
    const key = keys[i];
    const shell = makeShell(key, span / Math.max(1, Math.sqrt(bandCount)), minCeil);
    // 每带自己的配色：同一主题，越往上越靠 accent（逃向天光）
    const bt = themeFor(theme, { ...shell, openness: bandOpenness(key, i, bandCount) }, rng);
    const h = rises[i] * 1.0 + (i === 0 ? padBot : 0) + (i === bandCount - 1 ? padTop : 0);
    bands.push({
      i,
      key,
      shell,
      pattern: shell.pattern,
      pcg: style,
      grammar: grammarLabel(style, key),
      y0: round(y, 3),
      y1: round(y + h, 3),
      rise: round(rises[i], 3),
      theme: bt,
    });
    y += h;
  }
  // 归一：把累计高度对齐到 height（四舍五入误差）
  bands[bands.length - 1].y1 = height;

  return {
    id: theme.id,
    label: theme.label,
    theme,
    difficulty,
    style,
    styleLabel: WORLD_STYLES[style].label,
    structureId: structOverride ? preset.id : 'composite',
    structureLabel: structOverride ? preset.label : '复合（逐带递进）',
    structures: bands.map((b) => b.key),
    palette: (theme && theme.palette) || {},
    liquid: (theme && theme.liquid) || 'water',
    fit: (theme && theme.fit) || [],
    massingStyle: style,
    height,
    span,
    climbBudget: round(climbBudget, 3),
    bandCount,
    bands,
    patterns: bands.map((b) => b.pattern),
  };
}

/** 世界结构的「开放度」沿纵向递进：越往上越开阔（无顶的带直接给 1） */
function bandOpenness(key, i, n) {
  const base = shellOf(key).openness;
  const u = n <= 1 ? 1 : i / (n - 1);
  return clamp(base * 0.7 + u * 0.3, 0, 1);
}

export { SHELLS, shellOf, isShellKey };