/* ============================================================
   程序化装饰 · 主题注册表
   ------------------------------------------------------------
   一个主题 = 一套「氛围 + 皮肤 + 母题」的数据。装饰层只读它，
   不新增引擎对象类型；所有字段都能落到既有对象的属性上：
     · env     → level.settings 的 fog / ambient / sun / sky（只叠加，不夺权：
                 玩法项 gravityScale / timeLimit / objective 一律不碰）
     · postfx  → 一个 postfx 对象（逐项 en 开关）
     · fx      → light / volumelight / fogvol / emitter 的装配参数
     · palette / advMat / liquid / motifs → 供 M2 起的地标与微件使用
   装饰强度 strength 只缩放 fx 数量，不改主题配色。

   ⚠ 主题的 hazard / liquid 皮肤只允许在该关危险「确实是致命的」时启用，
     绝不能把安全水面画成熔岩（见开发文档 §9.0）。
   ============================================================ */
import { clamp } from '../../core/util.js';
import { isShellKey } from '../shell.js';

/** 主题：键即 id */
export const THEMES = {
  /* ------------------------------------------------------------
     自然 / 水态系：开局与低难度的主基调（开阔、明亮、向上）
     ------------------------------------------------------------ */
  lucidMeadow: {
    id: 'lucidMeadow',
    label: '清醒草原',
    fit: ['openAir', 'outdoor'],
    diff: [1.0, 3.0],
    palette: { base: '#5f9e52', accent: '#e9f39a', glow: '#fff3c4', hazard: '#3f8fd8' },
    env: {
      sky: 'dream', skyMul: 1.05,
      fog: { color: '#c8dcc0', near: 260, far: 2600 },
      ambient: { color: '#cfe3ff', mul: 1.05 },
      sun: { color: '#fff4e2', mul: 1.0 },
    },
    postfx: {
      preset: 'dream', saturation: 1.1, temperature: 0.08,
      vignette: 0.2, grain: 0.02, bloom: 0.3, bloomThreshold: 0.7,
    },
    fx: {
      light: { color: '#fff0c8', intensity: 1.1, distance: 200, count: 2, height: 15 },
      beam: null,
      mist: null,
      dust: {
        color: '#fff2b8', alpha: 0.8, count: 3, scale: [26, 14, 26],
        rate: 8, life: 5, size: 1.1, speed: 1.2, up: 0.5, gravity: -0.6, drag: 2.2, soft: true,
      },
    },
    advMat: ['velvet', 'marble', 'iridescent'],
    liquid: 'water',
    /* 白模风格（关卡层用）：一段一段的体块按「风格 × 结构」长出来 */
    massing: { style: 'meadow' },
    motifs: {
      macro: ['缓坡', '花海', '云影'],
      meso: ['花丛簇', '风车', '孤树'],
      micro: ['草叶', '野花', '卵石', '木栅', '云絮'],
    },
    variant: ['midday', 'dusk'],
  },

  /* ------------------------------------------------------------
     人造 / 工业系：中高难度的主基调（沉没、锈蚀、雨雾）
     ------------------------------------------------------------ */
  drownedCity: {
    id: 'drownedCity',
    label: '沉没都市',
    fit: ['outdoor', 'indoor'],
    diff: [1.5, 9.99],
    palette: { base: '#20303a', accent: '#3f6f7a', glow: '#7fe3ff', hazard: '#2f8fd8' },
    env: {
      sky: 'storm', skyMul: 0.75,
      fog: { color: '#31414d', near: 70, far: 600 },
      ambient: { color: '#8fa6c0', mul: 0.85 },
      sun: { color: '#dfe9f2', mul: 0.7 },
    },
    postfx: {
      preset: 'coldmist', saturation: 0.88, temperature: -0.1,
      vignette: 0.35, grain: 0.1, bloom: 0.25, bloomThreshold: 0.85,
    },
    fx: {
      light: { color: '#9fd8ff', intensity: 1.3, distance: 110, count: 3, height: 10 },
      beam: null,
      mist: { color: '#8fa8c8', density: 0.3, count: 3, scale: [40, 18, 40], speed: 0.25 },
      dust: {
        color: '#cfe8ff', alpha: 0.55, count: 3, scale: [30, 16, 30],
        rate: 10, life: 4, size: 1.2, speed: 2, up: 0.25, gravity: 1.5, drag: 1.8, soft: true,
      },
    },
    advMat: ['brushedMetal', 'carbonFiber', 'oilSlick'],
    liquid: 'murkyFlood',
    massing: { style: 'city' },
    motifs: {
      macro: ['淹没区', '潮间带', '坍塌区'],
      meso: ['半淹楼群', '漂浮残骸带', '水下路标'],
      micro: ['路缘碎石', '锈管', '水渍', '漂流木', '警示牌'],
    },
    variant: ['wet', 'dry'],
  },

  /* ------------------------------------------------------------
     自然 / 水态系（深渊）：洞穴与竖井的荧光基调
     ------------------------------------------------------------ */
  bioAbyss: {
    id: 'bioAbyss',
    label: '生物荧渊',
    fit: ['cavern', 'shaft'],
    diff: [2.5, 9.99],
    palette: { base: '#10203a', accent: '#1e5f6e', glow: '#5ff0d0', hazard: '#3ad0a0' },
    env: {
      sky: 'void', skyMul: 0.4,
      fog: { color: '#0d2230', near: 40, far: 340 },
      ambient: { color: '#2b6a7a', mul: 0.75 },
      sun: { color: '#9fe8e0', mul: 0.45 },
    },
    postfx: {
      preset: 'neutral', saturation: 1.15, temperature: -0.12, tint: 0.06,
      vignette: 0.5, grain: 0.06, bloom: 0.55, bloomThreshold: 0.55,
    },
    fx: {
      light: { color: '#5ff0d0', intensity: 1.6, distance: 95, count: 3, height: 9 },
      beam: { color: '#6ff0d8', intensity: 0.45, count: 2, scale: [9, 34, 9] },
      mist: { color: '#1d5a66', density: 0.4, count: 4, scale: [34, 16, 34], speed: 0.2 },
      dust: {
        color: '#8ff8e2', alpha: 0.85, count: 4, scale: [28, 18, 28],
        rate: 14, life: 6, size: 0.9, speed: 1.4, up: 0.35, gravity: -2.5, drag: 2.4, soft: false,
      },
    },
    advMat: ['aurora', 'iridescent', 'spirit'],
    liquid: 'glowWater',
    massing: { style: 'rock' },
    motifs: {
      macro: ['暗层', '荧光层', '热泉'],
      meso: ['荧光菌丘', '巨藻柱', '发光水母群'],
      micro: ['珊瑚枝', '发光孢子', '气孔', '晶簇', '藤须'],
    },
    variant: ['spore', 'thermal'],
  },

  /* ------------------------------------------------------------
     超现实 / 梦境系：阈限空间，靠灯光与留白而不是靠堆物件
     ------------------------------------------------------------ */
  liminalHall: {
    id: 'liminalHall',
    label: '阈限走廊',
    fit: ['indoor', 'sheltered'],
    diff: [2.0, 9.99],
    palette: { base: '#d8cfa8', accent: '#8a7a52', glow: '#fff6d8', hazard: '#c86a5a' },
    env: {
      sky: 'void', skyMul: 0.5,
      fog: { color: '#cfc39a', near: 45, far: 400 },
      ambient: { color: '#e8dcb8', mul: 1.0 },
      sun: { color: '#fff3d0', mul: 0.6 },
    },
    postfx: {
      preset: 'neutral', saturation: 0.92, temperature: 0.12, contrast: 1.06,
      vignette: 0.28, grain: 0.05, bloom: 0.2, bloomThreshold: 0.9,
    },
    fx: {
      light: { color: '#fff6d8', intensity: 1.4, distance: 80, count: 4, height: 8 },
      beam: { color: '#fff6d8', intensity: 0.35, count: 2, scale: [7, 26, 7] },
      mist: null,
      dust: {
        color: '#fff8e0', alpha: 0.35, count: 2, scale: [24, 12, 24],
        rate: 5, life: 6, size: 0.8, speed: 0.8, up: 0.15, gravity: 0.2, drag: 2.6, soft: true,
      },
    },
    advMat: ['ceramic', 'enamel', 'dreamcore'],
    liquid: 'water',
    massing: { style: 'building' },
    motifs: {
      macro: ['无尽走廊', '门厅', '泳池房'],
      meso: ['门列', '荧光灯带', '湿地毯'],
      micro: ['踢脚线', '指示牌', '水渍', '地毯边', '灯管'],
    },
    variant: ['carpet', 'pool'],
  },

  /* ============================================================
     扩充主题（20 个）：每个都有**自己的世界结构**（见 world/themes/<id>.js）
     ------------------------------------------------------------
     · fit 与白模脚本导出的 structures 一致（UI 提示 / 结构搭配都读它）
     · massing.style = 该主题白模的 style（决定角色与材质口吻）
     · palette 贴主题名：水晶洞偏青紫、火山脊偏橙红、赌场偏金红 …
     ============================================================ */
  crystalCavern: {
    id: 'crystalCavern', label: '水晶洞',
    fit: ['shaft', 'cavern', 'indoor', 'sheltered', 'outdoor'], diff: [2.0, 9.99],
    palette: { base: '#1b2440', accent: '#4a6fd0', glow: '#a8e6ff', hazard: '#7a4de0' },
    env: {
      sky: 'none', skyMul: 0.4,
      fog: { color: '#101a33', near: 40, far: 320 },
      ambient: { color: '#5a7ad0', mul: 0.7 },
      sun: { color: '#c9e8ff', mul: 0.5 },
    },
    postfx: { preset: 'neutral', saturation: 1.18, temperature: -0.15, tint: 0.08, vignette: 0.5, grain: 0.05, bloom: 0.6, bloomThreshold: 0.55 },
    fx: {
      light: { color: '#a8e6ff', intensity: 1.6, distance: 100, count: 3, height: 10 },
      beam: { color: '#7fd8ff', intensity: 0.4, count: 2, scale: [8, 30, 8] },
      mist: { color: '#22355e', density: 0.35, count: 3, scale: [34, 16, 34], speed: 0.18 },
      dust: { color: '#cfeaff', alpha: 0.8, count: 4, scale: [26, 16, 26], rate: 12, life: 6, size: 0.9, speed: 1.2, up: 0.3, gravity: -1.6, drag: 2.4, soft: false },
    },
    advMat: ['glass', 'pearl', 'iridescent'], liquid: 'water',
    massing: { style: 'crystalCavern' },
    motifs: {
      macro: ['晶簇层', '晶柱穹顶', '地心晶核'],
      meso: ['放射晶簇', '贯穿晶柱', '环绕晶台'],
      micro: ['碎晶', '晶笋', '晶囊', '钟乳晶', '晶座'],
    },
    variant: ['blue', 'violet'],
  },
  volcanicRidge: {
    id: 'volcanicRidge', label: '火山脊',
    fit: ['cavern', 'sheltered', 'outdoor', 'openAir'], diff: [2.0, 9.99],
    palette: { base: '#3a1c16', accent: '#a33a1e', glow: '#ff9a3d', hazard: '#ff3b10' },
    env: {
      sky: 'storm', skyMul: 0.7,
      fog: { color: '#3a211c', near: 60, far: 520 },
      ambient: { color: '#c07a5a', mul: 0.8 },
      sun: { color: '#ffd0a0', mul: 1.6 },
    },
    postfx: { preset: 'cinematic', saturation: 1.2, temperature: 0.28, vignette: 0.42, grain: 0.08, bloom: 0.7, bloomThreshold: 0.6 },
    fx: {
      light: { color: '#ff9a3d', intensity: 1.5, distance: 110, count: 3, height: 9 },
      beam: null,
      mist: { color: '#6a2f1c', density: 0.3, count: 3, scale: [36, 14, 36], speed: 0.22 },
      dust: { color: '#ffb066', alpha: 0.9, count: 5, scale: [28, 16, 28], rate: 16, life: 5, size: 1.0, speed: 2.4, up: 1.2, gravity: -3, drag: 2, soft: false },
    },
    advMat: ['lavaGlow', 'bronze', 'rubber'], liquid: 'lava',
    massing: { style: 'volcanicRidge' },
    motifs: {
      macro: ['熔岩台地', '火山口', '辐射熔岩沟'],
      meso: ['环状台地', '火山口环壁', '玄武岩柱'],
      micro: ['熔岩弹', '玄武岩柱', '火山渣', '硫磺', '浮石'],
    },
    variant: ['erupt', 'cool'],
  },
  skyIslands: {
    id: 'skyIslands', label: '浮空岛',
    fit: ['sheltered', 'outdoor', 'openAir'], diff: [1.0, 4.5],
    palette: { base: '#3f6ea8', accent: '#a8d8ff', glow: '#fff6d0', hazard: '#7ad0ff' },
    env: {
      sky: 'dream', skyMul: 1.2,
      fog: { color: '#cfe6ff', near: 220, far: 2400 },
      ambient: { color: '#dff0ff', mul: 1.05 },
      sun: { color: '#fff6e0', mul: 1.1 },
    },
    postfx: { preset: 'dream', saturation: 1.12, temperature: 0.05, vignette: 0.18, grain: 0.02, bloom: 0.45, bloomThreshold: 0.72 },
    fx: {
      light: { color: '#fff2d0', intensity: 1.2, distance: 220, count: 3, height: 16 },
      beam: null, mist: null,
      dust: { color: '#ffffff', alpha: 0.7, count: 3, scale: [26, 12, 26], rate: 8, life: 6, size: 1.0, speed: 1.0, up: 0.6, gravity: -0.4, drag: 2.4, soft: true },
    },
    advMat: ['cloud', 'pearl', 'dreamcore'], liquid: 'cloud',
    massing: { style: 'skyIslands' },
    motifs: {
      macro: ['浮空岛群', '云海', '藤桥'],
      meso: ['悬浮平台', '索桥', '悬垂藤幕'],
      micro: ['孤石', '藤须', '云絮', '风旗', '苔簇'],
    },
    variant: ['dawn', 'noon'],
  },
  sunkenForest: {
    id: 'sunkenForest', label: '沉没森林',
    fit: ['cavern', 'sheltered', 'outdoor'], diff: [1.2, 6.0],
    palette: { base: '#22402c', accent: '#3f7a52', glow: '#9fd08a', hazard: '#2f7fa8' },
    env: {
      sky: 'storm', skyMul: 0.7,
      fog: { color: '#2c4636', near: 90, far: 700 },
      ambient: { color: '#7fae8a', mul: 0.8 },
      sun: { color: '#cfe8d0', mul: 0.8 },
    },
    postfx: { preset: 'coldmist', saturation: 0.95, temperature: -0.08, vignette: 0.38, grain: 0.07, bloom: 0.35, bloomThreshold: 0.8 },
    fx: {
      light: { color: '#c8f0a8', intensity: 1.3, distance: 100, count: 3, height: 9 },
      beam: { color: '#bfe8a8', intensity: 0.35, count: 2, scale: [8, 28, 8] },
      mist: { color: '#3a5a44', density: 0.35, count: 3, scale: [36, 16, 36], speed: 0.2 },
      dust: { color: '#dfffc0', alpha: 0.6, count: 3, scale: [26, 14, 26], rate: 10, life: 6, size: 1.0, speed: 0.6, up: 0.2, gravity: -0.8, drag: 2.4, soft: true },
    },
    advMat: ['velvet', 'marble', 'toxic'], liquid: 'sludge',
    massing: { style: 'sunkenForest' },
    motifs: {
      macro: ['树干阵', '树冠网', '淹没层'],
      meso: ['半淹树干', '树冠网', '浮木带'],
      micro: ['浮木', '残桩', '苔藓', '蕨叶', '水泡'],
    },
    variant: ['flood', 'ebb'],
  },
  glacierFjord: {
    id: 'glacierFjord', label: '冰川峡湾',
    fit: ['shaft', 'cavern', 'sheltered', 'outdoor', 'openAir'], diff: [2.2, 9.99],
    palette: { base: '#25405a', accent: '#5f9fd0', glow: '#d8f4ff', hazard: '#2f8fd8' },
    env: {
      sky: 'night', skyMul: 0.8,
      fog: { color: '#2a4258', near: 70, far: 620 },
      ambient: { color: '#8fb8d8', mul: 0.85 },
      sun: { color: '#e0f4ff', mul: 1.0 },
    },
    postfx: { preset: 'coldmist', saturation: 1.05, temperature: -0.28, vignette: 0.4, grain: 0.05, bloom: 0.45, bloomThreshold: 0.7 },
    fx: {
      light: { color: '#d8f4ff', intensity: 1.4, distance: 120, count: 3, height: 10 },
      beam: { color: '#bfe8ff', intensity: 0.4, count: 2, scale: [10, 34, 10] },
      mist: { color: '#3a5670', density: 0.4, count: 3, scale: [40, 18, 40], speed: 0.18 },
      dust: { color: '#eaf8ff', alpha: 0.7, count: 4, scale: [24, 16, 24], rate: 12, life: 5, size: 0.8, speed: 1.6, up: 0.2, gravity: -1.2, drag: 2.2, soft: false },
    },
    advMat: ['glass', 'ceramic', 'pearl'], liquid: 'water',
    massing: { style: 'glacierFjord' },
    motifs: {
      macro: ['之字形峡壁', '深水航道', '横向冰坝'],
      meso: ['悬挑冰架', '悬冰柱', '浮冰块'],
      micro: ['碎冰', '冰锥', '雪堆', '气泡', '冰纹'],
    },
    variant: ['freeze', 'melt'],
  },
  desertMesa: {
    id: 'desertMesa', label: '荒漠台地',
    fit: ['cavern', 'outdoor', 'openAir'], diff: [1.0, 5.0],
    palette: { base: '#8a6a42', accent: '#d8b070', glow: '#ffe6a8', hazard: '#d08a3a' },
    env: {
      sky: 'dawn', skyMul: 1.1,
      fog: { color: '#e0cfa8', near: 180, far: 1700 },
      ambient: { color: '#ffe8c0', mul: 1.0 },
      sun: { color: '#ffd8a0', mul: 1.9 },
    },
    postfx: { preset: 'sunset', saturation: 1.14, temperature: 0.24, vignette: 0.28, grain: 0.05, bloom: 0.4, bloomThreshold: 0.75 },
    fx: {
      light: { color: '#ffe0a0', intensity: 1.3, distance: 160, count: 3, height: 14 },
      beam: null, mist: null,
      dust: { color: '#ffdca0', alpha: 0.85, count: 4, scale: [30, 14, 30], rate: 10, life: 5, size: 1.1, speed: 1.4, up: 0.3, gravity: 1.0, drag: 2.0, soft: true },
    },
    advMat: ['camo', 'marble', 'stripe'], liquid: 'water',
    massing: { style: 'desertMesa' },
    motifs: {
      macro: ['平顶台地', '荒漠', '风蚀拱'],
      meso: ['方台', '石柱桥', '风蚀拱门'],
      micro: ['仙人掌', '砾石', '干柴', '砂纹', '台缘石'],
    },
    variant: ['noon', 'dusk'],
  },
  swampMangrove: {
    id: 'swampMangrove', label: '沼泽红树',
    fit: ['indoor', 'sheltered', 'outdoor'], diff: [1.3, 6.0],
    palette: { base: '#26301c', accent: '#4a6a2c', glow: '#a8c86a', hazard: '#5a8a3a' },
    env: {
      sky: 'storm', skyMul: 0.65,
      fog: { color: '#2e3a22', near: 80, far: 620 },
      ambient: { color: '#8aa86a', mul: 0.78 },
      sun: { color: '#cfe0a8', mul: 0.8 },
    },
    postfx: { preset: 'neutral', saturation: 1.0, temperature: -0.04, vignette: 0.42, grain: 0.09, bloom: 0.3, bloomThreshold: 0.85 },
    fx: {
      light: { color: '#d0e8a0', intensity: 1.2, distance: 95, count: 3, height: 8 },
      beam: { color: '#c0e090', intensity: 0.3, count: 2, scale: [7, 24, 7] },
      mist: { color: '#42512e', density: 0.42, count: 4, scale: [34, 15, 34], speed: 0.16 },
      dust: { color: '#c8e090', alpha: 0.6, count: 3, scale: [24, 14, 24], rate: 11, life: 6, size: 1.0, speed: 0.5, up: 0.2, gravity: -1.0, drag: 2.6, soft: true },
    },
    advMat: ['rubber', 'velvet', 'toxic'], liquid: 'sludge',
    massing: { style: 'swampMangrove' },
    motifs: {
      macro: ['红树林', '泥滩', '暗水沟'],
      meso: ['支柱根', '板根冠', '气生根'],
      micro: ['气根须', '泥点', '藤须', '落叶', '水洼'],
    },
    variant: ['mud', 'brine'],
  },
  coralReef: {
    id: 'coralReef', label: '珊瑚礁',
    fit: ['cavern', 'indoor', 'sheltered', 'outdoor'], diff: [1.8, 7.0],
    palette: { base: '#1d3a44', accent: '#3f8f9a', glow: '#ffb0a0', hazard: '#ff7a5c' },
    env: {
      sky: 'none', skyMul: 0.5,
      fog: { color: '#163842', near: 50, far: 460 },
      ambient: { color: '#5fc0c0', mul: 0.8 },
      sun: { color: '#c8f0e8', mul: 0.7 },
    },
    postfx: { preset: 'underwater', saturation: 1.1, temperature: -0.18, vignette: 0.45, grain: 0.04, bloom: 0.5, bloomThreshold: 0.62 },
    fx: {
      light: { color: '#a8f0e0', intensity: 1.5, distance: 100, count: 3, height: 9 },
      beam: { color: '#9fe8d8', intensity: 0.4, count: 2, scale: [9, 28, 9] },
      mist: { color: '#1e4a52', density: 0.4, count: 4, scale: [36, 16, 36], speed: 0.2 },
      dust: { color: '#cffef0', alpha: 0.75, count: 4, scale: [26, 16, 26], rate: 14, life: 6, size: 0.9, speed: 1.0, up: 0.5, gravity: -0.6, drag: 2.6, soft: true },
    },
    advMat: ['pearl', 'iridescent', 'aurora'], liquid: 'deepsea',
    massing: { style: 'coralReef' },
    motifs: {
      macro: ['珊瑚丛', '环礁', '潟湖'],
      meso: ['树枝珊瑚', '潟湖礁台', '海葵丛'],
      micro: ['珊瑚枝', '海葵', '贝壳', '气泡', '砂砾'],
    },
    variant: ['shallow', 'deep'],
  },
  rustedFoundry: {
    id: 'rustedFoundry', label: '锈蚀铸造厂',
    fit: ['shaft', 'cavern', 'indoor', 'outdoor'], diff: [2.5, 9.99],
    palette: { base: '#33261f', accent: '#8a5a3a', glow: '#ffb066', hazard: '#e05a2a' },
    env: {
      sky: 'storm', skyMul: 0.6,
      fog: { color: '#38291f', near: 55, far: 500 },
      ambient: { color: '#b08a68', mul: 0.8 },
      sun: { color: '#ffcf9a', mul: 1.3 },
    },
    postfx: { preset: 'cinematic', saturation: 1.05, temperature: 0.18, vignette: 0.44, grain: 0.12, bloom: 0.5, bloomThreshold: 0.72 },
    fx: {
      light: { color: '#ffb066', intensity: 1.5, distance: 105, count: 3, height: 9 },
      beam: null,
      mist: { color: '#4a3524', density: 0.35, count: 3, scale: [34, 15, 34], speed: 0.24 },
      dust: { color: '#e8a860', alpha: 0.8, count: 4, scale: [26, 15, 26], rate: 13, life: 5, size: 0.9, speed: 1.8, up: 0.6, gravity: -2, drag: 2.2, soft: false },
    },
    advMat: ['brushedMetal', 'bronze', 'oilSlick'], liquid: 'oil',
    massing: { style: 'rustedFoundry' },
    motifs: {
      macro: ['高炉区', '熔炉坑', '输送带'],
      meso: ['空心高炉', '熔炉坑', '斜输送带'],
      micro: ['锈桶', '悬管', '铆钉', '铁屑', '蒸汽孔'],
    },
    variant: ['dry', 'wet'],
  },
  subwayTerminus: {
    id: 'subwayTerminus', label: '地铁终点站',
    fit: ['shaft', 'indoor', 'sheltered'], diff: [1.5, 8.0],
    palette: { base: '#2a2f38', accent: '#4a5568', glow: '#9fd8ff', hazard: '#d8b24a' },
    env: {
      sky: 'void', skyMul: 0.4,
      fog: { color: '#232830', near: 45, far: 400 },
      ambient: { color: '#7f8fa8', mul: 0.75 },
      sun: { color: '#cfe0f0', mul: 0.7 },
    },
    postfx: { preset: 'neutral', saturation: 0.98, temperature: -0.06, vignette: 0.4, grain: 0.08, bloom: 0.35, bloomThreshold: 0.82 },
    fx: {
      light: { color: '#a8d8ff', intensity: 1.5, distance: 90, count: 4, height: 8 },
      beam: { color: '#9fd0ff', intensity: 0.3, count: 2, scale: [7, 22, 7] },
      mist: null,
      dust: { color: '#cfe8ff', alpha: 0.5, count: 3, scale: [24, 13, 24], rate: 10, life: 5, size: 0.9, speed: 1.4, up: 0.2, gravity: 0.6, drag: 2.0, soft: true },
    },
    advMat: ['enamel', 'brushedMetal', 'dotMatrix'], liquid: 'water',
    massing: { style: 'subwayTerminus' },
    motifs: {
      macro: ['月台', '轨道沟', '隧道拱'],
      meso: ['月台', '拱肋', '楼梯'],
      micro: ['指示牌', '长椅', '灯带段', '闸机', '铁轨'],
    },
    variant: ['rush', 'hollow'],
  },
  neonArcade: {
    id: 'neonArcade', label: '霓虹街机厅',
    fit: ['indoor', 'sheltered', 'outdoor', 'openAir'], diff: [1.6, 9.99],
    palette: { base: '#241238', accent: '#6a2f9a', glow: '#ff5c8a', hazard: '#3fd8ff' },
    env: {
      sky: 'void', skyMul: 0.4,
      fog: { color: '#1c1030', near: 50, far: 460 },
      ambient: { color: '#8a5fc0', mul: 0.8 },
      sun: { color: '#ff9ac8', mul: 0.9 },
    },
    postfx: { preset: 'glitchy', saturation: 1.25, temperature: 0.05, vignette: 0.35, grain: 0.1, bloom: 0.9, bloomThreshold: 0.5 },
    fx: {
      light: { color: '#ff5c8a', intensity: 2.0, distance: 90, count: 4, height: 8 },
      beam: { color: '#3fd8ff', intensity: 0.45, count: 3, scale: [7, 20, 7] },
      mist: null,
      dust: { color: '#ff9ac8', alpha: 0.7, count: 4, scale: [24, 13, 24], rate: 14, life: 5, size: 0.8, speed: 1.6, up: 0.4, gravity: -1.0, drag: 2.2, soft: false },
    },
    advMat: ['neonStrips', 'glitch', 'plasma'], liquid: 'plasma',
    massing: { style: 'neonArcade' },
    motifs: {
      macro: ['街机厅', '灯箱墙', '舞台'],
      meso: ['机柜阵列', '霓虹墙', '舞台地台'],
      micro: ['奖杯塔', '灯管段', '代币', '摇杆', '海报'],
    },
    variant: ['neon', 'blackout'],
  },
  serverVault: {
    id: 'serverVault', label: '服务器地窖',
    fit: ['shaft', 'cavern', 'indoor'], diff: [3.0, 9.99],
    palette: { base: '#101c22', accent: '#2a4a52', glow: '#4dffb8', hazard: '#22d0ff' },
    env: {
      sky: 'none', skyMul: 0.3,
      fog: { color: '#0e1c22', near: 35, far: 300 },
      ambient: { color: '#3f8a8a', mul: 0.7 },
      sun: { color: '#a8f0d8', mul: 0.6 },
    },
    postfx: { preset: 'neutral', saturation: 1.06, temperature: -0.2, vignette: 0.5, grain: 0.06, bloom: 0.6, bloomThreshold: 0.6 },
    fx: {
      light: { color: '#4dffb8', intensity: 1.7, distance: 85, count: 4, height: 7 },
      beam: null,
      mist: { color: '#12303a', density: 0.4, count: 4, scale: [30, 15, 30], speed: 0.14 },
      dust: { color: '#8fffd0', alpha: 0.8, count: 4, scale: [22, 14, 22], rate: 15, life: 6, size: 0.7, speed: 2.0, up: 0.2, gravity: -2.4, drag: 2.4, soft: false },
    },
    advMat: ['circuit', 'carbonFiber', 'dataStream'], liquid: 'matrix',
    massing: { style: 'serverVault' },
    motifs: {
      macro: ['机柜区', '冷通道', '制冷井'],
      meso: ['机柜塔', '架空地板', '线缆桥架'],
      micro: ['指示灯', '线缆段', '风扇', '硬盘', '标签'],
    },
    variant: ['cool', 'hot'],
  },
  skyport: {
    id: 'skyport', label: '空中港',
    fit: ['outdoor', 'openAir'], diff: [2.0, 6.5],
    palette: { base: '#33414f', accent: '#6f8aa8', glow: '#ffd479', hazard: '#ff8a3d' },
    env: {
      sky: 'dawn', skyMul: 1.15,
      fog: { color: '#c8d8e8', near: 200, far: 2100 },
      ambient: { color: '#d8e8ff', mul: 1.0 },
      sun: { color: '#fff0d0', mul: 1.4 },
    },
    postfx: { preset: 'dream', saturation: 1.08, temperature: 0.1, vignette: 0.24, grain: 0.03, bloom: 0.5, bloomThreshold: 0.7 },
    fx: {
      light: { color: '#ffe0a0', intensity: 1.3, distance: 200, count: 3, height: 15 },
      beam: null, mist: null,
      dust: { color: '#ffffff', alpha: 0.6, count: 3, scale: [30, 12, 30], rate: 9, life: 6, size: 1.0, speed: 1.2, up: 0.5, gravity: -0.4, drag: 2.4, soft: true },
    },
    advMat: ['brushedMetal', 'chrome', 'hologram'], liquid: 'cloud',
    massing: { style: 'skyport' },
    motifs: {
      macro: ['停机坪', '登机桥', '塔台'],
      meso: ['圆盘停机坪', '斜廊桥', '塔台'],
      micro: ['导航灯', '旗杆', '货箱', '缆绳', '风向袋'],
    },
    variant: ['day', 'night'],
  },
  hydroDam: {
    id: 'hydroDam', label: '水坝',
    fit: ['cavern', 'indoor', 'sheltered', 'outdoor', 'openAir'], diff: [2.4, 9.99],
    palette: { base: '#22303a', accent: '#4a6f7a', glow: '#8fe8ff', hazard: '#2f8fd8' },
    env: {
      sky: 'storm', skyMul: 0.8,
      fog: { color: '#2a3a44', near: 100, far: 900 },
      ambient: { color: '#8fb0c0', mul: 0.85 },
      sun: { color: '#e0f0ff', mul: 1.2 },
    },
    postfx: { preset: 'coldmist', saturation: 0.96, temperature: -0.14, vignette: 0.38, grain: 0.07, bloom: 0.4, bloomThreshold: 0.78 },
    fx: {
      light: { color: '#bfe8ff', intensity: 1.4, distance: 130, count: 3, height: 11 },
      beam: { color: '#9fd8ff', intensity: 0.35, count: 2, scale: [8, 26, 8] },
      mist: { color: '#3a5460', density: 0.45, count: 4, scale: [40, 17, 40], speed: 0.22 },
      dust: { color: '#dff0ff', alpha: 0.8, count: 4, scale: [28, 16, 28], rate: 13, life: 5, size: 1.0, speed: 2.6, up: 0.5, gravity: 2.5, drag: 1.8, soft: true },
    },
    advMat: ['brushedMetal', 'glass', 'stripe'], liquid: 'water',
    massing: { style: 'hydroDam' },
    motifs: {
      macro: ['阶梯坝体', '溢洪道', '消力池'],
      meso: ['斜面坝', '溢洪道', '闸门柱'],
      micro: ['闸门', '水雾灯', '泄水泡', '栏杆', '铆钉'],
    },
    variant: ['full', 'low'],
  },
  clockworkAtrium: {
    id: 'clockworkAtrium', label: '钟表中庭',
    fit: ['indoor', 'sheltered'], diff: [1.8, 7.5],
    palette: { base: '#3a2f1c', accent: '#8a6a2f', glow: '#ffd479', hazard: '#c86a2a' },
    env: {
      sky: 'void', skyMul: 0.45,
      fog: { color: '#332a18', near: 60, far: 520 },
      ambient: { color: '#d8b878', mul: 0.9 },
      sun: { color: '#ffe6b0', mul: 0.9 },
    },
    postfx: { preset: 'neutral', saturation: 1.05, temperature: 0.16, vignette: 0.34, grain: 0.05, bloom: 0.5, bloomThreshold: 0.68 },
    fx: {
      light: { color: '#ffd479', intensity: 1.6, distance: 100, count: 4, height: 9 },
      beam: { color: '#ffe0a0', intensity: 0.4, count: 2, scale: [8, 26, 8] },
      mist: null,
      dust: { color: '#ffe6b0', alpha: 0.6, count: 3, scale: [26, 14, 26], rate: 9, life: 6, size: 0.8, speed: 0.8, up: 0.2, gravity: 0.4, drag: 2.6, soft: true },
    },
    advMat: ['gold', 'bronze', 'marble'], liquid: 'water',
    massing: { style: 'clockworkAtrium' },
    motifs: {
      macro: ['同心环廊', '摆锤', '表盘'],
      meso: ['环廊', '摆锤', '齿轮组'],
      micro: ['齿轮', '摆锤齿', '指针件', '铆钉', '黄铜屑'],
    },
    variant: ['tick', 'tock'],
  },
  mirrorGallery: {
    id: 'mirrorGallery', label: '镜廊',
    fit: ['shaft', 'cavern', 'indoor', 'sheltered'], diff: [2.0, 9.99],
    palette: { base: '#c8d0dc', accent: '#8fa0b8', glow: '#ffffff', hazard: '#7fd8ff' },
    env: {
      sky: 'void', skyMul: 0.5,
      fog: { color: '#c0ccd8', near: 60, far: 560 },
      ambient: { color: '#e0e8f0', mul: 0.95 },
      sun: { color: '#ffffff', mul: 0.8 },
    },
    postfx: { preset: 'neutral', saturation: 0.9, temperature: -0.02, vignette: 0.3, grain: 0.04, bloom: 0.6, bloomThreshold: 0.65 },
    fx: {
      light: { color: '#ffffff', intensity: 1.5, distance: 95, count: 4, height: 9 },
      beam: { color: '#dff0ff', intensity: 0.4, count: 3, scale: [8, 28, 8] },
      mist: null,
      dust: { color: '#ffffff', alpha: 0.5, count: 3, scale: [26, 14, 26], rate: 9, life: 6, size: 0.8, speed: 0.6, up: 0.2, gravity: 0.2, drag: 2.6, soft: true },
    },
    advMat: ['mirror', 'chrome', 'glass'], liquid: 'mercury',
    massing: { style: 'mirrorGallery' },
    motifs: {
      macro: ['平行镜墙', '错位门洞', '菱形镜顶'],
      meso: ['镜墙廊', '错位门洞', '台座'],
      micro: ['镜片', '碎片', '台座', '踢脚线', '反光点'],
    },
    variant: ['clear', 'fogged'],
  },
  hospitalWing: {
    id: 'hospitalWing', label: '废弃病栋',
    fit: ['cavern', 'indoor'], diff: [2.2, 9.99],
    palette: { base: '#2e3a34', accent: '#5a7a6a', glow: '#d8ffe0', hazard: '#c8d84a' },
    env: {
      sky: 'void', skyMul: 0.35,
      fog: { color: '#28332e', near: 45, far: 400 },
      ambient: { color: '#a8c0b0', mul: 0.8 },
      sun: { color: '#e8f8e0', mul: 0.7 },
    },
    postfx: { preset: 'neutral', saturation: 0.85, temperature: -0.06, vignette: 0.45, grain: 0.1, bloom: 0.28, bloomThreshold: 0.9 },
    fx: {
      light: { color: '#d8ffe0', intensity: 1.4, distance: 85, count: 4, height: 8 },
      beam: { color: '#cff0d8', intensity: 0.3, count: 2, scale: [7, 22, 7] },
      mist: null,
      dust: { color: '#e0ffe8', alpha: 0.45, count: 3, scale: [22, 13, 22], rate: 8, life: 6, size: 0.7, speed: 0.6, up: 0.15, gravity: 0.3, drag: 2.8, soft: true },
    },
    advMat: ['enamel', 'ceramic', 'weirdcore'], liquid: 'water',
    massing: { style: 'hospitalWing' },
    motifs: {
      macro: ['病房排', '主走廊', '手术间'],
      meso: ['隔间', '床台', '手术灯'],
      micro: ['病床', '轮椅', '消毒柜', '指示牌', '输液架'],
    },
    variant: ['clean', 'derelict'],
  },
  casinoFloor: {
    id: 'casinoFloor', label: '赌场楼层',
    fit: ['shaft', 'indoor', 'sheltered', 'outdoor'], diff: [2.0, 9.99],
    palette: { base: '#2a0f18', accent: '#8a1f2f', glow: '#ffd479', hazard: '#ff3b5c' },
    env: {
      sky: 'void', skyMul: 0.4,
      fog: { color: '#26101a', near: 55, far: 480 },
      ambient: { color: '#c08868', mul: 0.85 },
      sun: { color: '#ffcf9a', mul: 0.9 },
    },
    postfx: { preset: 'cinematic', saturation: 1.2, temperature: 0.2, vignette: 0.4, grain: 0.06, bloom: 0.85, bloomThreshold: 0.52 },
    fx: {
      light: { color: '#ffd479', intensity: 1.9, distance: 95, count: 5, height: 8 },
      beam: { color: '#ff5c8a', intensity: 0.4, count: 3, scale: [8, 22, 8] },
      mist: null,
      dust: { color: '#ffcf7a', alpha: 0.75, count: 4, scale: [26, 14, 26], rate: 14, life: 5, size: 0.8, speed: 1.2, up: 0.3, gravity: -1.0, drag: 2.2, soft: false },
    },
    advMat: ['gold', 'neonStrips', 'velvet'], liquid: 'honey',
    massing: { style: 'casinoFloor' },
    motifs: {
      macro: ['赌台层', '环形灯带', '筹码塔'],
      meso: ['环形赌台', '老虎机排', '金色装柱'],
      micro: ['筹码塔', '骰子', '代币', '烟蒂', '灯球'],
    },
    variant: ['win', 'lose'],
  },
  drownedLibrary: {
    id: 'drownedLibrary', label: '沉没图书馆',
    fit: ['shaft', 'cavern', 'sheltered'], diff: [1.9, 8.5],
    palette: { base: '#23303a', accent: '#3f5a6a', glow: '#ffe6b0', hazard: '#3f8fd8' },
    env: {
      sky: 'void', skyMul: 0.35,
      fog: { color: '#1e2a33', near: 45, far: 420 },
      ambient: { color: '#8fa8b8', mul: 0.78 },
      sun: { color: '#e0e8f0', mul: 0.65 },
    },
    postfx: { preset: 'coldmist', saturation: 0.92, temperature: -0.08, vignette: 0.46, grain: 0.09, bloom: 0.35, bloomThreshold: 0.8 },
    fx: {
      light: { color: '#ffe6b0', intensity: 1.4, distance: 90, count: 4, height: 8 },
      beam: { color: '#d8e8f0', intensity: 0.35, count: 2, scale: [7, 24, 7] },
      mist: { color: '#2a3a44', density: 0.4, count: 3, scale: [32, 15, 32], speed: 0.2 },
      dust: { color: '#e8e0c8', alpha: 0.55, count: 3, scale: [24, 14, 24], rate: 9, life: 6, size: 0.8, speed: 0.5, up: 0.2, gravity: 0.5, drag: 2.8, soft: true },
    },
    advMat: ['marble', 'velvet', 'weirdcore'], liquid: 'ink',
    massing: { style: 'drownedLibrary' },
    motifs: {
      macro: ['书架巷道', '阅览台', '下沉水池'],
      meso: ['书架墙', '外挑搁板', '阶梯阅览台'],
      micro: ['书堆', '烛台', '吊灯', '书页', '水渍'],
    },
    variant: ['dry', 'flood'],
  },
  cathedralNave: {
    id: 'cathedralNave', label: '大教堂中殿',
    fit: ['shaft', 'indoor', 'sheltered', 'outdoor', 'openAir'], diff: [2.1, 9.99],
    palette: { base: '#2a2536', accent: '#6a5a8a', glow: '#ffe6a8', hazard: '#c86a5a' },
    env: {
      sky: 'void', skyMul: 0.5,
      fog: { color: '#2a2436', near: 65, far: 620 },
      ambient: { color: '#c8b8d8', mul: 0.88 },
      sun: { color: '#fff0c8', mul: 0.85 },
    },
    postfx: { preset: 'neutral', saturation: 1.0, temperature: 0.1, vignette: 0.4, grain: 0.05, bloom: 0.6, bloomThreshold: 0.66 },
    fx: {
      light: { color: '#ffe6a8', intensity: 1.7, distance: 100, count: 4, height: 10 },
      beam: { color: '#fff0c8', intensity: 0.5, count: 3, scale: [8, 30, 8] },
      mist: { color: '#3a3450', density: 0.3, count: 3, scale: [34, 16, 34], speed: 0.14 },
      dust: { color: '#ffe6b0', alpha: 0.6, count: 3, scale: [26, 15, 26], rate: 9, life: 7, size: 0.9, speed: 0.7, up: 0.4, gravity: -0.2, drag: 2.8, soft: true },
    },
    advMat: ['marble', 'gold', 'iridescent'], liquid: 'water',
    massing: { style: 'cathedralNave' },
    motifs: {
      macro: ['中殿', '尖拱', '祭坛'],
      meso: ['巨柱列', '尖拱肋', '阶梯祭坛'],
      micro: ['烛台', '彩窗片', '长椅', '圣像', '石屑'],
    },
    variant: ['liturgy', 'vespers'],
  },
};

/** 主题清单（供 UI 下拉用） */
export const THEME_LIST = Object.values(THEMES);

/** id → 主题；未知 id 返回 null（调用方负责回退） */
export function themeOf(id) {
  const t = THEMES[id];
  return t && t.id === id ? t : null;
}

/** 主题下拉选项（含适配的世界结构，方便 UI 提示） */
export function themeOptions() {
  return THEME_LIST.map((t) => ({
    v: t.id,
    l: `${t.label}（适配 ${t.fit.map((k) => SHELL_KEY_LABEL[k] || k).join(' / ')}）`,
  }));
}

const SHELL_KEY_LABEL = {
  openAir: '开阔', outdoor: '露天', sheltered: '半封闭',
  indoor: '室内', shaft: '竖井', cavern: '洞穴',
};

/**
 * 选主题：
 *   1. 显式指定且存在 → 用它；
 *   2. 否则在「世界结构命中 + 难度带命中」的候选里随机取；
 *   3. 再退：只命中结构 → 再退：全部（保证永远选得出一个）。
 */
export function resolveTheme({ themeId, structure, difficulty, rng } = {}) {
  const explicit = themeId ? themeOf(themeId) : null;
  if (explicit) return explicit;

  const st = isShellKey(structure) ? structure : null;
  const d = clamp(Number(difficulty) || 1, 0.5, 9.99);
  const inDiff = (t) => d >= t.diff[0] - 1e-6 && d <= t.diff[1] + 1e-6;

  const pools = [
    THEME_LIST.filter((t) => st && t.fit.includes(st) && inDiff(t)),
    THEME_LIST.filter((t) => st && t.fit.includes(st)),
    THEME_LIST.filter((t) => inDiff(t)),
    THEME_LIST,
  ];
  const pool = pools.find((p) => p.length) || THEME_LIST;
  return rng ? rng.pick(pool) : pool[0];
}