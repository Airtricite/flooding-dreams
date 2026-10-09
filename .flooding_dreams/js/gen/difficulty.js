/* ============================================================
   程序化生成 · 难度参数表
   ------------------------------------------------------------
   把 Dev/难度模型 里的「时间窗口（per break stage）/ 始发配置 /
   配置控制 / 特色」翻译成生成器可执行的数值旋钮。
  * · timeLimit      = 关卡总时长(秒)。**地图全长固定落在 2:00~3:00（120~180s）**，
 *                    难度只决定余量紧不紧：越难给越少。
 * · targetTraversal= 纯跑图耗时的目标(秒)：决定该铺多少内容。
 *                    经验上 estTime / timeLimit 应落在 25%~50%，
 *                    剩下的才是人因（失误、观察、洪水压迫感）。
 * · sectionTime    = 单个 break stage 的**节奏**预算(秒)：越难越短，
 *                    它只影响「一段有多密」，不再决定关卡总长。
 * · sectionRise    = 一个 break stage 的爬升预算(stud)。
 *                    洪水逃生是「一直往上逃」，路线要有正的净爬升趋势；
 *                    预算给得够就允许中途有下沉的起伏，够不到就一直是最大爬升率。
 * · gapRatio       = 跳跃缺口占「平地最大跳距」的比例（越大越难）
  * · W           = 三种连接段的权重 [平地缺口跳, 阶梯, 下落跳]
  * 同一难度档内按小数在「本档 → 下一档」之间线性插值，保证难度连续。
   ============================================================ */
import { clamp, lerp } from '../core/util.js';
import { DIFFICULTY } from '../config.js';

/**
 * 玩法特性门槛：难度 ≥ minDiff 才允许出现（对应难度模型的「始发配置」）。
 * M1 落地 shortGap / midLongJump / dropDown；M5 把 8 种高级机制挂成旁路；
 * ★ M6 起 walljump / climb / zipline / swim 已经可以当**主轴必经段**使用
 *   （攀登链的竖井 / 裂谷特技段 + world/mechRoute.js，见开发文档 §11.7），
 *   NavGraph 的边类型已同步扩到 m=3 机制边。
 */
export const FEATURES = [
  { id: 'shortGap',    minDiff: 1.0, label: '短间隙跳跃' },
  { id: 'stair',       minDiff: 1.0, label: '台阶 / 缓坡' },
  { id: 'dropDown',    minDiff: 1.0, label: '下落跳' },
  { id: 'zipline',     minDiff: 1.0, label: '滑索' },
  { id: 'trampoline',  minDiff: 1.0, label: '蹦床' },
  { id: 'walljump',    minDiff: 2.0, label: 'WallJump' },
  { id: 'swim',        minDiff: 2.0, label: '立体游泳' },
  { id: 'movingPlat',  minDiff: 2.0, label: '移动平台 / 输送带' },
  { id: 'midLongJump', minDiff: 3.0, label: 'MidLong Jump' },
  { id: 'lavaField',   minDiff: 3.0, label: '熔岩 / 扣血方块' },
  { id: 'laserGrid',   minDiff: 3.0, label: '激光阵' },
  { id: 'rhythmOrb',   minDiff: 3.5, label: 'Rhythm Orbs' },
  { id: 'oneStudBeam', minDiff: 4.0, label: '1 stud 宽梁' },
  { id: 'wallAround',  minDiff: 4.0, label: 'Wall around' },
  { id: 'semiBackJump',minDiff: 4.5, label: 'Semi back jump' },
  { id: 'backJump',    minDiff: 5.0, label: 'Back jump' },
  { id: 'trussShift',  minDiff: 5.0, label: 'Shiftlock truss' },
  { id: 'rhythmTower', minDiff: 5.0, label: 'Rhythm orb tower' },
];

/** 每档一行；数值全部由 paramsFor 在档内插值到下一档 */
/* ★ 一张表 8 行，覆盖 1.0 ~ 9.99 全区间。
   旧版最后一行是 `{ key:'nightmare', min:6.0, max:99 }` —— 于是 **6.0 / 7.0 / 9.99
   拿到的是完全相同的参数**（`nxt` 还是自己，lerp 到什么都不变），用户实测「9.99 的
   难度读数只有 4.99 档」就是这么来的。现在 6.0~7.0 / 7.0~8.0 / 8.0~10.0 各是一行，
   9.99 落到最后一行、且档内继续插值到真正的上限。 */
const ROWS = [
  { key: 'lucid', min: 1.0, max: 2.0,
    timeLimit: 150, targetTraversal: 61, sectionTime: 24, sectionRise: 5,
    gapRatio: 0.70, gapJitter: 0.05,
    beamMin: 8, beamMax: 13, restW: 18,
    stepRise: 1.30, stepCountMin: 2, stepCountMax: 3,
    dip: 1.6, turnMin: 10, turnMax: 35, riseChance: 0.45,
    detourChance: 0.35, detourHighChance: 0.25,
    segPerSectionMin: 4, segPerSectionMax: 6,
    hazard: 0.0,
    mechChance: 0.12,
    W: [0.62, 0.30, 0.08] },

  { key: 'misty', min: 2.0, max: 3.0,
    timeLimit: 148, targetTraversal: 57, sectionTime: 12, sectionRise: 6,
    gapRatio: 0.78, gapJitter: 0.06,
    beamMin: 6.5, beamMax: 11, restW: 15,
    stepRise: 1.40, stepCountMin: 2, stepCountMax: 4,
    dip: 1.9, turnMin: 15, turnMax: 50, riseChance: 0.48,
    detourChance: 0.40, detourHighChance: 0.35,
    segPerSectionMin: 4, segPerSectionMax: 6,
    hazard: 0.10,
    mechChance: 0.22,
    W: [0.55, 0.30, 0.15] },

  { key: 'deep', min: 3.0, max: 4.0,
    timeLimit: 146, targetTraversal: 54, sectionTime: 10, sectionRise: 7,
    gapRatio: 0.85, gapJitter: 0.06,
    beamMin: 5, beamMax: 9, restW: 12,
    stepRise: 1.50, stepCountMin: 2, stepCountMax: 4,
    dip: 2.2, turnMin: 20, turnMax: 60, riseChance: 0.48,
    detourChance: 0.45, detourHighChance: 0.45,
    segPerSectionMin: 4, segPerSectionMax: 7,
    hazard: 0.30,
    mechChance: 0.34,
    W: [0.47, 0.33, 0.20] },

  { key: 'drowning', min: 4.0, max: 5.0,
    timeLimit: 144, targetTraversal: 51, sectionTime: 6, sectionRise: 8,
    gapRatio: 0.91, gapJitter: 0.05,
    beamMin: 3.5, beamMax: 7, restW: 10,
    stepRise: 1.55, stepCountMin: 2, stepCountMax: 5,
    dip: 2.6, turnMin: 25, turnMax: 70, riseChance: 0.45,
    detourChance: 0.50, detourHighChance: 0.50,
    segPerSectionMin: 5, segPerSectionMax: 8,
    hazard: 0.50,
    mechChance: 0.46,
    W: [0.42, 0.36, 0.22] },

  { key: 'suffocating', min: 5.0, max: 6.0,
    timeLimit: 140, targetTraversal: 49, sectionTime: 3, sectionRise: 10,
    gapRatio: 0.95, gapJitter: 0.04,
    beamMin: 2.5, beamMax: 5.5, restW: 8,
    stepRise: 1.60, stepCountMin: 3, stepCountMax: 5,
    dip: 3.0, turnMin: 30, turnMax: 80, riseChance: 0.45,
    detourChance: 0.55, detourHighChance: 0.55,
    segPerSectionMin: 5, segPerSectionMax: 8,
    hazard: 0.70,
    mechChance: 0.56,
    W: [0.40, 0.38, 0.22] },

  { key: 'nightmare', min: 6.0, max: 7.0,
    timeLimit: 136, targetTraversal: 46, sectionTime: 1, sectionRise: 11,
    gapRatio: 0.98, gapJitter: 0.02,
    beamMin: 1.6, beamMax: 4, restW: 6,
    stepRise: 1.60, stepCountMin: 3, stepCountMax: 6,
    dip: 3.4, turnMin: 35, turnMax: 90, riseChance: 0.50,
    detourChance: 0.60, detourHighChance: 0.60,
    segPerSectionMin: 5, segPerSectionMax: 9,
    hazard: 1.00,
    mechChance: 0.66,
    W: [0.45, 0.33, 0.22] },

  { key: 'nightmarePlus', min: 7.0, max: 8.0,
    timeLimit: 132, targetTraversal: 45, sectionTime: 1, sectionRise: 12,
    gapRatio: 0.99, gapJitter: 0.02,
    beamMin: 1.2, beamMax: 3.4, restW: 5,
    stepRise: 1.60, stepCountMin: 3, stepCountMax: 7,
    dip: 3.6, turnMin: 38, turnMax: 95, riseChance: 0.52,
    detourChance: 0.62, detourHighChance: 0.62,
    segPerSectionMin: 6, segPerSectionMax: 10,
    hazard: 1.00,
    mechChance: 0.72,
    W: [0.44, 0.34, 0.22] },

  { key: 'nightmarePlus', min: 8.0, max: 9.0,
    timeLimit: 128, targetTraversal: 44, sectionTime: 1, sectionRise: 13,
    gapRatio: 0.995, gapJitter: 0.015,
    beamMin: 1.0, beamMax: 3.0, restW: 4,
    stepRise: 1.60, stepCountMin: 3, stepCountMax: 7,
    dip: 3.8, turnMin: 40, turnMax: 100, riseChance: 0.54,
    detourChance: 0.64, detourHighChance: 0.64,
    segPerSectionMin: 6, segPerSectionMax: 11,
    hazard: 1.00,
    mechChance: 0.78,
    W: [0.44, 0.34, 0.22] },

  /* ★ 绝对上限行：9.0~9.99 —— 用户实测的「9.99」落在这一行，
     于是 6.0 / 7.0 / 8.0 / 9.99 是四个**真的不同**的难度。 */
  { key: 'nightmarePlus', min: 9.0, max: 10.0,
    timeLimit: 124, targetTraversal: 43, sectionTime: 1, sectionRise: 14,
    gapRatio: 0.998, gapJitter: 0.01,
    beamMin: 0.8, beamMax: 2.6, restW: 3,
    stepRise: 1.60, stepCountMin: 3, stepCountMax: 8,
    dip: 4.0, turnMin: 42, turnMax: 105, riseChance: 0.56,
    detourChance: 0.66, detourHighChance: 0.66,
    segPerSectionMin: 7, segPerSectionMax: 12,
    hazard: 1.00,
    mechChance: 0.84,
    W: [0.44, 0.34, 0.22] },
];

/* 需要插值的数值键（W 是三元素数组，单独处理） */
const NUM_KEYS = [
  'timeLimit', 'targetTraversal', 'sectionTime', 'sectionRise',
  'gapRatio', 'gapJitter', 'beamMin', 'beamMax', 'restW',
  'stepRise', 'stepCountMin', 'stepCountMax',
  'dip', 'turnMin', 'turnMax', 'riseChance',
  'detourChance', 'detourHighChance',
  'segPerSectionMin', 'segPerSectionMax',
  'hazard', 'mechChance',
];
/* 必须保持整数的键 */
const INT_KEYS = new Set([
  'stepCountMin', 'stepCountMax', 'segPerSectionMin', 'segPerSectionMax',
]);

function rowIndex(d) {
  // ★ 用 `d < r.max`（不是 ≤）：整数档位（d=3.0 / 6.0 …）应该落到**下一档**的第一格，
  //   否则 `tier` 会显示成上一档（数值其实已经插值到下一档，标签却是旧的）。
  for (let i = 0; i < ROWS.length; i++) {
    const r = ROWS[i];
    if (d >= r.min && d < r.max) return i;
  }
  return d < ROWS[0].min ? 0 : ROWS.length - 1;
}

/** 难度值 → 所在档（与 config.DIFFICULTY 同一套 key） */
export function tierOf(d) {
  const row = ROWS[rowIndex(clamp(Number(d) || 1, 0.5, 9.99))];
  const t = DIFFICULTY.find((x) => x.key === row.key);
  return t || DIFFICULTY[0];
}

/**
 * 难度值 → 生成参数。
 * 在「本档 → 下一档」之间按档内进度插值；最后一档的进度按 6.0~7.0 计。
 */
export function paramsFor(difficulty) {
  const d = clamp(Number(difficulty) || 1, 0.5, 9.99);
  const i = rowIndex(d);
  const cur = ROWS[i];
  const nxt = ROWS[Math.min(ROWS.length - 1, i + 1)];
  // ★ 档内进度：每行 max-min = 1（最后一行 2），所以 u = d - min 的小数部分
  const span = Math.max(0.25, cur.max - cur.min);
  const u = clamp((d - cur.min) / span, 0, 1);

  const out = { difficulty: d, key: cur.key };
  for (const k of NUM_KEYS) {
    const v = lerp(cur[k], nxt[k], u);
    out[k] = INT_KEYS.has(k) ? Math.max(1, Math.round(v)) : v;
  }
  // 三个连接段的权重也要连续变化
  const w = [0, 1, 2].map((j) => lerp(cur.W[j], nxt.W[j], u));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  out.W = w.map((x) => x / sum);

  out.tier = tierOf(d);
  out.stepRise = Math.min(out.stepRise, 1.60);   // 必须 ≤ 抬脚高度(1.8) 的 92%
  out.features = allowedFeatures(d);
  return out;
}

/** 该难度允许出现的玩法特性 id 集合 */
export function allowedFeatures(difficulty) {
  const d = Number(difficulty) || 1;
  const set = new Set();
  for (const f of FEATURES) if (d >= f.minDiff) set.add(f.id);
  return set;
}

/** 难度指纹的目标值（M2 起用于严格验收：指纹落在容差内才算「难度对得上」） */
export function fingerprintTarget(difficulty) {
  const p = paramsFor(difficulty);
  // 窄段占比：平台宽度在 [beamMin, beamMax] 均匀取，所以「≤3.2 stud 的占比」可直接推出来
  const span = Math.max(0.001, p.beamMax - p.beamMin);
  const narrowRatio = clamp((3.2 - p.beamMin) / span, 0, 1);
  return {
    gapRatio: p.gapRatio,
    meanGapRatio: p.gapRatio * 0.78,
    narrowRatio,
    // M1 还没落地危险体积与节拍玩法，先如实标成未实现（M3 起接上）
    hazardDensity: 0,
    pendingHazards: p.hazard,
    jumpPerSection: 1.4 + p.hazard * 0.8,
  };
}

/** 段落数上下限：太少关卡空、太多对象爆 */
export const MIN_SECTIONS = 8;
/* ★ 22 → 26：现在总时长是 2:00~3:00，内容量要跟着抬一点，
   否则「跑步占比」（estTime/timeLimit）会掉到 20% 以下（实测）。 */
export const MAX_SECTIONS = 26;

/**
 * 该铺多少段：由「纯跑图目标耗时」反推。
 * 单条连接的经验耗时 ≈ 0.36s（跳跃滞空 0.53s、阶梯边走 0.15s 的加权平均，
 * 实测标定值 —— 早期按 0.5s 估会少铺三成内容）。
 * 每段还要算上收尾的休息平台。
 */
export function sectionsFor(params) {
  const segs = (params.segPerSectionMin + params.segPerSectionMax) / 2;
  const perSection = (segs + 1) * LINK_TIME;
  const n = Math.round((Number(params.targetTraversal) || 30) / Math.max(0.2, perSection));
  return Math.max(MIN_SECTIONS, Math.min(MAX_SECTIONS, n));
}

/** 单条连接的经验耗时(秒)：用于按目标跑图耗时反推内容量 */
export const LINK_TIME = 0.36;

/**
 * 关卡总时长(秒)：**固定落在 120~180s**（2:00~3:00），难度只决定余量紧不紧。
 * 兜底：图特别长时也必须给够，否则生成出来的关卡自己不可通关。
 */
export function timeLimitFor(difficulty, estTime) {
  const p = paramsFor(difficulty);
  // ★ 全长必须落在 2:00~3:00（120~180s）：低于 120 也抬到 120（给足人因余量），
  //   高于 180 才封顶（图特别长时 2.2 倍兜底会顶穿上限）
  return clamp(Math.max(p.timeLimit, Math.ceil((Number(estTime) || 0) * 2.2)), 120, 180);
}

/** 节奏预算(秒)：段时窗口 × 段数。只作报告参考 —— 玩家实际用不到这么多时间。 */
export function pacingBudget(difficulty, sections) {
  const p = paramsFor(difficulty);
  const n = Math.max(1, Math.round(Number(sections) || 1));
  return Math.round(p.sectionTime * n);
}

export { ROWS as DIFFICULTY_ROWS };
