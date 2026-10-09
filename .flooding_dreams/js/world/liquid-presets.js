/* ============================================================
   液体风格预设（水纹）——数据驱动
   - 每种液体 = 一组「水纹层」，最多 6 层叠加（不同图案 / 密度 / 方向 / 速度）
   - 层类型编码与 materials.js 的液体着色器一一对应（共 20 种）：
       0 规则波纹  1 噪声浪   2 焦散网格  3 方向条纹
       4 等离子    5 气泡     6 域扭曲    7 细胞浮沫
       8 同心涟漪  9 漩涡     10 脊状浪   11 干涉网格
       12 拉丝流   13 大理石   14 油膜干涉 15 星尘
       16 涟漪扩散 17 鳞片     18 脉动团块 19 沙纹
   - 层数据格式：[类型, 密度, 速度, 方向角(度), 强度]
   - deepColor 只作为「深度吸收」的色调参考：保留它的饱和度 / 亮度，
     色相一律改用液面自身的色相（见 deriveDepthTone），避免深处偏色发脏
   ============================================================ */
import * as THREE from 'three';

/* 20 种水纹图案：l = 中文名（供 i18n），d = 该图案单层加载时的默认层参数 [密度, 速度, 方向角, 强度] */
export const LIQUID_LAYER_TYPES = [
  { v: 0, l: '规则波纹', d: [1.4, 0.8, 0, 0.6] },
  { v: 1, l: '噪声浪', d: [1.2, 0.4, 0, 0.6] },
  { v: 2, l: '焦散网格', d: [1.2, 0.7, 0, 0.6] },
  { v: 3, l: '方向条纹', d: [1.6, 0.7, 30, 0.6] },
  { v: 4, l: '等离子', d: [0.9, 0.5, 0, 0.7] },
  { v: 5, l: '气泡', d: [2.0, 0.8, 0, 0.6] },
  { v: 6, l: '域扭曲', d: [0.8, 0.3, 0, 0.75] },
  { v: 7, l: '细胞浮沫', d: [1.3, 0.4, 0, 0.6] },
  { v: 8, l: '同心涟漪', d: [1.5, 0.6, 0, 0.6] },
  { v: 9, l: '漩涡', d: [1.2, 0.5, 0, 0.7] },
  { v: 10, l: '脊状浪', d: [1.0, 0.4, 0, 0.7] },
  { v: 11, l: '干涉网格', d: [1.3, 0.6, 0, 0.6] },
  { v: 12, l: '拉丝流', d: [1.2, 0.6, 20, 0.65] },
  { v: 13, l: '大理石', d: [1.0, 0.35, 0, 0.7] },
  { v: 14, l: '油膜干涉', d: [1.2, 0.5, 0, 0.7] },
  { v: 15, l: '星尘', d: [1.6, 0.8, 0, 0.8] },
  { v: 16, l: '涟漪扩散', d: [1.4, 0.8, 0, 0.7] },
  { v: 17, l: '鳞片', d: [1.3, 0.5, 0, 0.65] },
  { v: 18, l: '脉动团块', d: [1.1, 0.35, 0, 0.7] },
  { v: 19, l: '沙纹', d: [1.4, 0.5, 0, 0.65] },
];

/* 通用：一套清爽的水面层，其它预设在此基础上替换 */
const W = [0, 1.0, 0.9, 0, 0.55];
const N = [1, 1.4, 0.45, 20, 0.35];

const BASE_STYLES = [
  {
    id: 'water', label: '清水', kind: 'water',
    color: '#2f8fd8', opacity: 0.62, emissive: '#0a2233', emissiveIntensity: 0.18,
    deepColor: '#062a40', absorb: 0.5, tint: '#bfeaff',
    roughness: 0.08, metalness: 0.28, foamColor: '#ffffff',
    layers: [W, N, [2, 0.8, 0.6, 0, 0.3]],
  },
  {
    id: 'deepsea', label: '深海', kind: 'water',
    color: '#0b3f6b', opacity: 0.86, emissive: '#04121f', emissiveIntensity: 0.12,
    deepColor: '#01121f', absorb: 0.85, tint: '#7fd0ff',
    roughness: 0.12, metalness: 0.2, foamColor: '#dff4ff',
    layers: [[1, 0.9, 0.3, 10, 0.5], [0, 1.6, 0.5, 0, 0.3], [6, 1.2, 0.25, 45, 0.35]],
  },
  {
    id: 'pool', label: '泳池瓷砖', kind: 'water',
    color: '#3fb6e0', opacity: 0.55, emissive: '#0b2a3a', emissiveIntensity: 0.2,
    deepColor: '#0a3c52', absorb: 0.4, tint: '#eafcff',
    roughness: 0.06, metalness: 0.3, foamColor: '#ffffff',
    layers: [[2, 1.5, 0.75, 0, 0.7], [0, 2.4, 1.1, 30, 0.35]],
  },
  {
    id: 'acid', label: '酸液', kind: 'acid',
    color: '#8de23a', opacity: 0.72, emissive: '#12240a', emissiveIntensity: 0.5,
    deepColor: '#0a1c04', absorb: 0.6, tint: '#eaff9c',
    roughness: 0.1, metalness: 0.2, foamColor: '#d8ff8a',
    layers: [[5, 1.6, 0.8, 0, 0.6], [1, 1.2, 0.5, 15, 0.45], [4, 0.9, 0.4, 0, 0.3]],
  },
  {
    id: 'lava', label: '熔岩', kind: 'lava',
    color: '#ff5a1e', opacity: 0.94, emissive: '#ff3d00', emissiveIntensity: 1.05,
    deepColor: '#2b0600', absorb: 0.7, tint: '#ffd24a',
    roughness: 0.42, metalness: 0.0, foamColor: '#ffb347',
    layers: [[6, 0.9, 0.35, 0, 0.75], [1, 1.5, 0.28, 40, 0.6], [4, 1.1, 0.22, 0, 0.45], [5, 2.2, 0.5, 0, 0.3]],
  },
  {
    id: 'magma', label: '岩浆漩涡', kind: 'lava',
    color: '#c22a06', opacity: 0.96, emissive: '#ff7a18', emissiveIntensity: 1.2,
    deepColor: '#1b0300', absorb: 0.75, tint: '#fff0a0',
    roughness: 0.5, metalness: 0.0, foamColor: '#ff8a3c',
    layers: [[6, 0.55, 0.3, 0, 0.85], [7, 1.1, 0.35, 0, 0.5], [1, 2.2, 0.4, 25, 0.45]],
  },
  {
    id: 'cola', label: '可乐', kind: 'custom',
    color: '#4a1c08', opacity: 0.88, emissive: '#1b0a02', emissiveIntensity: 0.2,
    deepColor: '#150601', absorb: 0.8, tint: '#c98a4b',
    roughness: 0.1, metalness: 0.25, foamColor: '#e8c9a0',
    layers: [[5, 2.6, 1.3, 0, 0.5], [1, 1.1, 0.5, 0, 0.4], [0, 1.8, 0.9, 0, 0.25]],
  },
  {
    id: 'soda', label: '汽水', kind: 'custom',
    color: '#e8a33c', opacity: 0.6, emissive: '#3a2408', emissiveIntensity: 0.28,
    deepColor: '#5a3a10', absorb: 0.45, tint: '#fff3c9',
    roughness: 0.06, metalness: 0.3, foamColor: '#fffaf0',
    layers: [[5, 3.2, 1.6, 0, 0.65], [2, 1.4, 0.9, 0, 0.4], [1, 1.0, 0.4, 0, 0.25]],
  },
  {
    id: 'juice_orange', label: '橙汁', kind: 'custom',
    color: '#ff8f1f', opacity: 0.8, emissive: '#3a1c02', emissiveIntensity: 0.3,
    deepColor: '#6b3200', absorb: 0.6, tint: '#ffe1a8',
    roughness: 0.14, metalness: 0.18, foamColor: '#fff0d0',
    layers: [[7, 1.5, 0.45, 0, 0.55], [1, 1.8, 0.6, 0, 0.45], [0, 1.2, 0.7, 0, 0.25]],
  },
  {
    id: 'juice_grape', label: '葡萄汁', kind: 'custom',
    color: '#6b2fa8', opacity: 0.85, emissive: '#1c0a33', emissiveIntensity: 0.3,
    deepColor: '#20073d', absorb: 0.7, tint: '#d8b4ff',
    roughness: 0.12, metalness: 0.22, foamColor: '#e9d6ff',
    layers: [[7, 1.3, 0.4, 20, 0.5], [6, 1.0, 0.3, 0, 0.5], [2, 0.9, 0.5, 0, 0.3]],
  },
  {
    id: 'milk', label: '牛奶', kind: 'custom',
    color: '#f4f0e6', opacity: 0.92, emissive: '#2a2620', emissiveIntensity: 0.15,
    deepColor: '#cdc6b8', absorb: 0.3, tint: '#ffffff',
    roughness: 0.35, metalness: 0.05, foamColor: '#ffffff',
    layers: [[1, 1.6, 0.3, 0, 0.4], [0, 1.1, 0.4, 0, 0.3]],
  },
  {
    id: 'sludge', label: '泥沙', kind: 'custom',
    color: '#6b5535', opacity: 0.95, emissive: '#140f07', emissiveIntensity: 0.08,
    deepColor: '#1f180d', absorb: 0.9, tint: '#a08a5e',
    roughness: 0.7, metalness: 0.02, foamColor: '#c9b184',
    layers: [[6, 0.8, 0.18, 0, 0.7], [7, 1.6, 0.22, 0, 0.5], [1, 2.4, 0.3, 60, 0.4]],
  },
  {
    id: 'mud_flow', label: '泥流', kind: 'custom',
    color: '#8a6b3a', opacity: 0.97, emissive: '#171105', emissiveIntensity: 0.1,
    deepColor: '#241a09', absorb: 0.92, tint: '#d0b478',
    roughness: 0.8, metalness: 0.0, foamColor: '#e0cb9a',
    layers: [[3, 1.2, 0.5, 10, 0.6], [6, 1.0, 0.35, 0, 0.55], [1, 2.0, 0.5, 0, 0.35]],
  },
  {
    id: 'oil', label: '机油', kind: 'custom',
    color: '#14161a', opacity: 0.9, emissive: '#0a0b0d', emissiveIntensity: 0.15,
    deepColor: '#050607', absorb: 0.85, tint: '#7f8fa6',
    roughness: 0.05, metalness: 0.75, foamColor: '#9aa6b8',
    layers: [[1, 1.0, 0.2, 0, 0.5], [4, 0.7, 0.25, 0, 0.4], [6, 0.6, 0.15, 0, 0.35]],
  },
  {
    id: 'slime', label: '黏液', kind: 'custom',
    color: '#5fd45a', opacity: 0.88, emissive: '#0d2b0b', emissiveIntensity: 0.55,
    deepColor: '#0a2308', absorb: 0.6, tint: '#c9ffa8',
    roughness: 0.18, metalness: 0.15, foamColor: '#dfffcf',
    layers: [[7, 1.1, 0.4, 0, 0.7], [6, 0.8, 0.3, 30, 0.6], [5, 1.8, 0.55, 0, 0.35]],
  },
  {
    id: 'honey', label: '蜂蜜', kind: 'custom',
    color: '#e8a020', opacity: 0.9, emissive: '#3d2503', emissiveIntensity: 0.35,
    deepColor: '#6b4405', absorb: 0.7, tint: '#fff0bb',
    roughness: 0.22, metalness: 0.1, foamColor: '#fff6d8',
    layers: [[4, 0.6, 0.16, 0, 0.6], [1, 0.9, 0.12, 0, 0.45], [6, 0.5, 0.1, 0, 0.4]],
  },
  {
    id: 'blood', label: '血', kind: 'custom',
    color: '#8e0b12', opacity: 0.93, emissive: '#2a0203', emissiveIntensity: 0.25,
    deepColor: '#2a0203', absorb: 0.88, tint: '#ff8a8a',
    roughness: 0.16, metalness: 0.12, foamColor: '#f2c0c0',
    layers: [[6, 0.9, 0.3, 0, 0.7], [4, 0.8, 0.25, 0, 0.4], [1, 1.5, 0.35, 0, 0.35]],
  },
  {
    id: 'mercury', label: '水银', kind: 'custom',
    color: '#b8c3cc', opacity: 0.98, emissive: '#2b3138', emissiveIntensity: 0.3,
    deepColor: '#4a545c', absorb: 0.4, tint: '#ffffff',
    roughness: 0.02, metalness: 1.0, foamColor: '#e8eef4',
    layers: [[0, 1.6, 0.7, 0, 0.35], [6, 0.7, 0.3, 0, 0.3]],
  },
  {
    id: 'ink', label: '墨水', kind: 'custom',
    color: '#0a0c14', opacity: 0.96, emissive: '#05060b', emissiveIntensity: 0.12,
    deepColor: '#020308', absorb: 0.95, tint: '#6a76a8',
    roughness: 0.06, metalness: 0.4, foamColor: '#8b96c9',
    layers: [[6, 0.6, 0.22, 0, 0.8], [4, 0.5, 0.18, 0, 0.45], [7, 0.9, 0.2, 0, 0.4]],
  },
  {
    id: 'poison', label: '毒液', kind: 'acid',
    color: '#7b1fa8', opacity: 0.85, emissive: '#2a0a3a', emissiveIntensity: 0.7,
    deepColor: '#1a0426', absorb: 0.7, tint: '#e3a8ff',
    roughness: 0.1, metalness: 0.25, foamColor: '#d68aff',
    layers: [[5, 2.0, 1.0, 0, 0.6], [4, 1.0, 0.6, 0, 0.5], [6, 0.8, 0.4, 0, 0.4]],
  },
  {
    id: 'tea', label: '茶', kind: 'custom',
    color: '#8a5a24', opacity: 0.72, emissive: '#2a1a06', emissiveIntensity: 0.2,
    deepColor: '#3a2408', absorb: 0.65, tint: '#e8cfa0',
    roughness: 0.1, metalness: 0.2, foamColor: '#f2e2c4',
    layers: [[0, 1.2, 0.6, 0, 0.45], [1, 1.6, 0.35, 0, 0.35], [2, 0.9, 0.5, 0, 0.25]],
  },
  {
    id: 'galaxy', label: '星河', kind: 'custom',
    color: '#2a1a5e', opacity: 0.9, emissive: '#7a3fd0', emissiveIntensity: 1.1,
    deepColor: '#0a0420', absorb: 0.8, tint: '#c9a8ff',
    roughness: 0.1, metalness: 0.5, foamColor: '#e6d6ff',
    layers: [[6, 0.6, 0.2, 0, 0.8], [5, 3.0, 1.2, 0, 0.55], [7, 1.4, 0.3, 0, 0.5], [4, 0.8, 0.25, 0, 0.4]],
  },
  {
    id: 'dreamcore', label: '梦核', kind: 'custom',
    color: '#7fd8e8', opacity: 0.8, emissive: '#c78fff', emissiveIntensity: 0.85,
    deepColor: '#3a1f6b', absorb: 0.55, tint: '#ffd6f5',
    roughness: 0.12, metalness: 0.35, foamColor: '#ffffff',
    layers: [[6, 0.55, 0.22, 0, 0.75], [4, 0.9, 0.35, 0, 0.55], [5, 2.2, 0.8, 0, 0.45], [0, 1.4, 0.5, 45, 0.3]],
  },
  {
    id: 'weirdcore', label: '怪核', kind: 'custom',
    color: '#c8c85a', opacity: 0.88, emissive: '#5a2f8f', emissiveIntensity: 0.9,
    deepColor: '#2f1b4a', absorb: 0.7, tint: '#a0ffb0',
    roughness: 0.2, metalness: 0.3, foamColor: '#f0ffb0',
    layers: [[7, 0.9, 0.3, 15, 0.8], [3, 1.8, 0.6, 75, 0.5], [6, 1.1, 0.35, 0, 0.55], [5, 2.6, 0.9, 0, 0.35]],
  },
  {
    id: 'void', label: '虚空', kind: 'custom',
    color: '#0b0713', opacity: 0.97, emissive: '#3a1f6b', emissiveIntensity: 0.5,
    deepColor: '#000000', absorb: 1.0, tint: '#8a5cff',
    roughness: 0.08, metalness: 0.4, foamColor: '#9d7bff',
    layers: [[6, 0.5, 0.15, 0, 0.85], [7, 1.0, 0.2, 0, 0.5], [4, 0.6, 0.18, 0, 0.4]],
  },
  {
    id: 'matrix', label: '数据流', kind: 'custom',
    color: '#04240f', opacity: 0.9, emissive: '#26ff7a', emissiveIntensity: 1.0,
    deepColor: '#01120a', absorb: 0.8, tint: '#a8ffcb',
    roughness: 0.1, metalness: 0.35, foamColor: '#7dffb0',
    layers: [[3, 3.4, 1.8, 90, 0.7], [3, 1.6, 0.9, 90, 0.45], [1, 1.0, 0.3, 0, 0.25]],
  },
  {
    id: 'plasma', label: '等离子', kind: 'custom',
    color: '#2a6bff', opacity: 0.85, emissive: '#7fd8ff', emissiveIntensity: 1.15,
    deepColor: '#04102a', absorb: 0.6, tint: '#e0f6ff',
    roughness: 0.06, metalness: 0.4, foamColor: '#c9ecff',
    layers: [[4, 0.7, 0.5, 0, 0.8], [6, 0.9, 0.45, 0, 0.6], [2, 1.3, 0.7, 0, 0.4]],
  },
  {
    id: 'rainbow', label: '彩虹油膜', kind: 'custom',
    color: '#5a4a8f', opacity: 0.75, emissive: '#8f5ad0', emissiveIntensity: 0.7,
    deepColor: '#241a4a', absorb: 0.5, tint: '#ffffff',
    roughness: 0.04, metalness: 0.6, foamColor: '#ffffff',
    layers: [[4, 0.5, 0.3, 0, 0.9], [0, 1.8, 0.7, 25, 0.5], [3, 2.6, 0.5, 115, 0.35]],
  },
  {
    id: 'cloud', label: '云雾', kind: 'custom',
    color: '#d8dcea', opacity: 0.7, emissive: '#5a6280', emissiveIntensity: 0.35,
    deepColor: '#8f97b0', absorb: 0.35, tint: '#ffffff',
    roughness: 0.6, metalness: 0.05, foamColor: '#ffffff',
    layers: [[1, 0.7, 0.18, 0, 0.7], [6, 0.5, 0.14, 0, 0.6], [4, 0.6, 0.12, 0, 0.35]],
  },
  {
    id: 'aurora', label: '极光', kind: 'custom',
    color: '#0f5a6b', opacity: 0.82, emissive: '#3affc9', emissiveIntensity: 1.0,
    deepColor: '#04202a', absorb: 0.65, tint: '#c9fff0',
    roughness: 0.08, metalness: 0.35, foamColor: '#d6fff4',
    layers: [[6, 0.5, 0.2, 30, 0.8], [3, 1.4, 0.5, 20, 0.55], [5, 2.4, 0.7, 0, 0.35]],
  },
];

/* 20 种「纯图案」风格：并入「水纹风格」下拉，选中即单独加载该图案。
   patternOnly：套用时只换水纹图案，不改动液体自身的颜色 / 透明度 / 自发光 / 泡沫 / 深度色 */
const PATTERN_STYLES = LIQUID_LAYER_TYPES.map((t) => ({
  id: `pattern_${t.v}`,
  label: `图案·${t.l}`,
  patternOnly: true,
  layers: [[t.v, ...t.d]],
}));

export const LIQUID_STYLES = [...BASE_STYLES, ...PATTERN_STYLES];

const BY_ID = new Map(LIQUID_STYLES.map((s) => [s.id, s]));
/** 液体种类 → 默认风格 */
export const STYLE_BY_KIND = { water: 'water', acid: 'acid', lava: 'lava', custom: 'dreamcore' };

export function getLiquidStyle(id) {
  return BY_ID.get(id) || null;
}

export function liquidStyleOptions() {
  return LIQUID_STYLES.map((s) => ({ v: s.id, l: s.label }));
}

/** 解析出真正生效的风格（未指定 / 无效时按液体种类兜底） */
export function resolveLiquidStyle(o = {}) {
  return getLiquidStyle(o.liquidStyle) || getLiquidStyle(STYLE_BY_KIND[o.kind]) || LIQUID_STYLES[0];
}

const _hslTmp = { h: 0, s: 0, l: 0 };
function _hsl(hex, fallback) {
  const c = new THREE.Color(hex || fallback);
  c.getHSL(_hslTmp);
  return { s: _hslTmp.s, l: _hslTmp.l };
}
function _optNum(v) {
  return (v === undefined || v === null || v === '') ? null : Number(v);
}

/** 深度吸收的「锁色相」色调：
    只取参考深色（deepColor）的饱和度 / 亮度，换算成相对液面色的倍率，
    色相完全由液面自身的颜色决定 —— 所以水越深只会变暗 / 变淡，不会偏成另一种颜色。
    显式传入 depthSat / depthLight（编辑器调参）时以调参为准。 */
export function deriveDepthTone(baseHex, deepHex, depthSat, depthLight) {
  const b = _hsl(baseHex, '#2f8fd8');
  const d = _hsl(deepHex, '#062a40');
  const so = _optNum(depthSat);
  const lo = _optNum(depthLight);
  const sat = so !== null ? so : (b.s > 0.02 ? d.s / b.s : 1);
  const light = lo !== null ? lo : (b.l > 0.02 ? d.l / b.l : 0.4);
  return {
    sat: Math.min(2, Math.max(0, sat)),
    light: Math.min(1, Math.max(0, light)),
  };
}

/** 只切换水纹图案，保留液体自身的颜色 / 透明度 / 自发光 / 泡沫 / 深度色等外观参数 */
export function applyLiquidPattern(o, id) {
  const s = getLiquidStyle(id) || resolveLiquidStyle({ kind: o.kind });
  o.liquidStyle = s.id;
  return o;
}

/** 把风格预设应用到已有液体对象（颜色 / 透明度 / 自发光 / 泡沫 / 水纹色 / 深度吸收）；
    「纯图案」风格（patternOnly）只换水纹图案，其余外观参数保持不变 */
export function applyLiquidStyle(o, id) {
  const s = getLiquidStyle(id) || resolveLiquidStyle({ kind: o.kind });
  o.liquidStyle = s.id;
  if (s.patternOnly) return o;
  o.color = s.color;
  o.transparency = 1 - s.opacity;
  o.emissive = s.emissive;
  o.emissiveIntensity = s.emissiveIntensity;
  // 深度吸收：写入锁色相的饱和度 / 亮度倍率（由预设深色反推），色相跟随液面色
  const tone = deriveDepthTone(s.color, s.deepColor);
  o.depthSat = tone.sat;
  o.depthLight = tone.light;
  o.depthAbsorb = s.absorb;
  o.roughness = s.roughness;
  o.metalness = s.metalness;
  o.foamColor = s.foamColor;
  o.rippleTint = s.tint;
  return o;
}
