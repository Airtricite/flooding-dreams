/* ============================================================
   程序化生成 · 世界结构（外壳）
   ------------------------------------------------------------
   用一套「外壳」同时约束几何与渲染：
     · ceiling  : 有顶时的高度上限；顶太低会压低跳跃顶点
     · wall     : 侧墙密度 0~1；越高越封闭
     · openness : 开阔度 0~1；越小越局促
     · pattern  : 推荐的行进转向风格（见 TURN_PATTERNS），决定空间移动的形态

   ★ 世界优先管线里，外壳是**世界蓝图的纵向分带**（world/theme.js）：
     一个世界沿高度分成若干带，从最幽闭一路逃向最开阔
     （洞穴 → 室内 → 竖井 → 半封闭 → 露天 → 开阔）。
     白模（world/whitebox.js）按「风格 × 结构」的文法把每一带长出来。
   ============================================================ */
import { PALETTE } from '../config.js';
import { clamp, mixHex } from '../core/util.js';

/** 行进转向风格：决定这一带的空间形态 */
export const TURN_PATTERNS = {
  coil:     '盘旋（始终朝同一侧拐 → 绕成上升的螺旋）',
  zigzag:   '之字（左右交替拐 → 走廊感）',
  straight: '直进（大段直线 → 冲刺感）',
  wander:   '游走（随机转向 → 开阔感）',
};

export const SHELLS = [
  { key: 'openAir', label: '开阔（无顶 · 无侧墙）', ceiling: 0, wall: 0, openness: 1.0, pattern: 'wander',
    sky: 'dream', fog: { near: 220, far: 2400 }, ambient: 0.55, sun: 2.35 },
  { key: 'outdoor', label: '露天（部分围合）', ceiling: 0, wall: 0.15, openness: 0.85, pattern: 'straight',
    sky: 'dawn', fog: { near: 190, far: 1900 }, ambient: 0.52, sun: 2.2 },
  { key: 'sheltered', label: '半封闭（有顶 · 部分墙）', ceiling: 80, wall: 0.45, openness: 0.60, pattern: 'coil',
    sky: 'void', fog: { near: 120, far: 1100 }, ambient: 0.44, sun: 1.7 },
  { key: 'indoor', label: '室内（顶低 · 全墙）', ceiling: 46, wall: 0.90, openness: 0.30, pattern: 'zigzag',
    sky: 'storm', fog: { near: 60, far: 520 }, ambient: 0.36, sun: 1.1 },
  { key: 'shaft', label: '竖井（高 · 窄）', ceiling: 280, wall: 1.0, openness: 0.18, pattern: 'coil',
    sky: 'night', fog: { near: 90, far: 900 }, ambient: 0.32, sun: 1.4 },
  { key: 'cavern', label: '洞穴（不规则围合）', ceiling: 100, wall: 0.95, openness: 0.22, pattern: 'wander',
    sky: 'none', fog: { near: 50, far: 420 }, ambient: 0.28, sun: 0.9 },
];

/** 复合结构的递进阶梯：从最幽闭 → 最开阔（洪水逃生 = 一路往上往外） */
export const SHELL_LADDER = ['cavern', 'indoor', 'shaft', 'sheltered', 'outdoor', 'openAir'];

export function shellOf(key) {
  return SHELLS.find((s) => s.key === key) || SHELLS[0];
}

export function isShellKey(key) {
  return SHELLS.some((s) => s.key === key);
}

/**
 * 复合结构：**由主题白模模块声明结构阶梯**（world/themes/<主题>.js 的 structures），
 * 再由 world/theme.js 的 structurePlan 做「智能选择 / 搭配 / 排列」。
 * 旧版那个「从 fit 池里随机取一段 + ±1 抖动」的做法已删除 —— 它读不出主题的性格。
 */

/** 用来解析主题的「代表性结构」：显式指定就用它，否则取难度对应的幽闭起点 */
export function anchorShellFor(structure, difficulty) {
  if (isShellKey(structure)) return structure;
  const t = clamp((Number(difficulty) - 1) / 5, 0, 1);
  const i = Math.min(SHELL_LADDER.length - 1, blockStartIx(t) + 1);
  return SHELL_LADDER[i];
}

/** 难度 → 从阶梯的哪一档起（0 = 最幽闭；主题没声明结构时用它兜底） */
export function blockStartIx(t) {
  if (t < 0.3) return 3;    // 半封闭起（Lucid：基本是露天/开阔）
  if (t < 0.7) return 2;    // 竖井起（Misty / Deep）
  return 0;                 // 洞穴起（Drowning 以上：从最深处逃）
}

/**
 * 生成具体外壳实例。
 * span     = 世界水平尺度（用于侧墙长度、包围盒留白）
 * minCeil  = 本关物理口径下可用的最低天花板高度（reach.minCeiling）。
 *            外壳预设的顶如果比它低，会被抬到它 —— 否则玩家在贴顶的平台上
 *            一跳就会撞天花板，这条路线根本走不通。
 */
export function makeShell(key, span, minCeil = 0) {
  const d = shellOf(key);
  const spanS = Math.max(60, Number(span) || 120);
  const ceil = d.ceiling > 0 ? Math.max(d.ceiling, Math.ceil(Number(minCeil) || 0)) : 0;
  return {
    ...d,
    span: spanS,
    ceilY: ceil,                 // 有顶时的天花板高度；无顶为 0
    margin: marginFor(spanS),
    wallThickness: 4,
  };
}

function marginFor(span) {
  return Math.round(clamp(Math.max(60, Number(span) || 120) * 0.18, 16, 60));
}

/**
 * 全局渲染设置：复合结构下雾 / 天空只能取一套，
 * 就取「占比最大」的那一段（按连接数），并在报告里标出主导结构。
 */
export function dominantShell(sections) {
  const tally = new Map();
  for (const s of sections || []) {
    const k = s.shell && s.shell.key ? s.shell.key : 'openAir';
    tally.set(k, (tally.get(k) || 0) + Math.max(1, (s.links || 0)));
  }
  let best = 'openAir', bestN = -1;
  for (const [k, n] of tally) if (n > bestN) { best = k; bestN = n; }
  return shellOf(best);
}

/** 外壳 → 关卡 settings 片段（雾 / 天空 / 环境光 / 太阳） */
export function shellSettings(shell) {
  const s = {
    fog: { enabled: true, near: shell.fog.near, far: shell.fog.far },
    ambient: { intensity: shell.ambient },
    sun: { intensity: shell.sun },
    sky: shell.sky,
    env: shell.sky !== 'none',
  };
  if (shell.key === 'cavern') { s.fog.color = '#2b2438'; s.skyIntensity = 0.4; }
  else if (shell.key === 'indoor') { s.fog.color = '#4a4460'; s.skyIntensity = 0.6; }
  else if (shell.key === 'shaft') { s.fog.color = '#3a3357'; s.skyIntensity = 0.7; }
  else if (shell.key === 'sheltered') { s.fog.color = '#4b4470'; s.skyIntensity = 0.8; }
  return s;
}

/**
 * 主题配色：**从装饰主题的调色板取**，而不是随机挑 ——
 * 否则世界平台的颜色会和装饰层的氛围主题打架。
 *
 * 每一条带用自己的外壳调用一次，于是同一套主题在不同结构里呈现不同明度：
 *   越开阔 → 平台越接近主题的 accent（越往上越亮，正好对上「逃向天光」）；
 *   越幽闭 → 越接近 base 并压暗墙体。
 * 返回的对象与旧接口同构（plat/platAlt/start/wall/ceil/goal）。
 */
export function themeFor(theme, shell, rng) {
  const pal = (theme && theme.palette) || {};
  const openness = clamp(Number(shell && shell.openness) || 0.5, 0, 1);
  const base = pal.base || rng.pick(PALETTE.filter((c) => c !== '#161327' && c !== '#3b3559'));
  const accent = pal.accent || rng.pick(PALETTE.filter((c) => c !== '#161327'));
  const glow = pal.glow || accent;
  // 开放度决定「平台色靠 base 还是靠 accent」
  const t = clamp(0.34 + openness * 0.36, 0, 1);
  return {
    themeId: (theme && theme.id) || 'custom',
    plat: mixHex(base, accent, t),
    platAlt: mixHex(base, accent, clamp(t + 0.22, 0, 1)),
    start: glow,
    wall: mixHex(base, '#000000', 0.28),
    ceil: mixHex(base, '#000000', 0.46),
    goal: glow,
    accent,
  };
}