/* ============================================================
   画面处理对象：零额外 pass 的画面调色
   （色调映射 / 曝光 / 输出色彩空间 / 饱和度 / 染色）
   ------------------------------------------------------------
   色调映射、曝光、输出色彩空间都是渲染器级设置，作用在材质 fragment shader 的收尾处：
   色调映射是一段内置曲线，曝光只是它的一个乘子，输出色彩空间是最后一步编码。
   饱和度与染色同理 —— 预先在 CPU 上合成一个 3×3 颜色矩阵，注入到同一个位置
   （见 core/materials.js），每像素只多 3 次乘加。
   合起来没有任何额外 pass、没有全屏 shader、没有额外纹理采样。
   （「后处理对象」里的「曝光补偿 / 饱和度」走的是全屏调色 pass，权重更大；
     只想整体调画面时用本对象最省。）
   覆盖范围：场景里走标准管线的材质（物体 / 导入模型 / 液体 / 文字 / 体积 / 玩家）。
   天空盒是 three 内部的背景程序、雾在色调映射之后才叠加，所以这两项只跟着
   渲染器级的色调映射 / 曝光变，不参与饱和度与染色。
   与「后处理对象」同时启用时，后处理管线自己完成 ACES + sRGB 编码，
   这里的「色调映射 / 输出色彩空间」只影响不走后处理时的画布；曝光与调色仍会传给后处理。
   ============================================================ */
import * as THREE from './three-ns.js';
import { clamp } from './util.js';

/** 没有画面处理对象时的基准曝光（引擎初始化 / 画质切换 / 退出关卡复位） */
export const BASE_EXPOSURE = 1.06;

/* 下拉里存的是字符串（存档 JSON 友好），这里再映射回 THREE 常量 */
const TONE_MAPPING = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  cineon: THREE.CineonToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  linear: THREE.LinearToneMapping,
  none: THREE.NoToneMapping,
};
export const TONE_MAPPING_OPTIONS = [
  { v: 'aces', l: 'ACES 电影级' },
  { v: 'agx', l: 'AgX（柔和高光）' },
  { v: 'cineon', l: 'Cineon 胶片' },
  { v: 'reinhard', l: 'Reinhard' },
  { v: 'linear', l: '线性' },
  { v: 'none', l: '不做色调映射' },
];

const COLOR_SPACE = {
  srgb: THREE.SRGBColorSpace,
  linear: THREE.LinearSRGBColorSpace,
};
export const COLOR_SPACE_OPTIONS = [
  { v: 'srgb', l: 'sRGB（标准）' },
  { v: 'linear', l: '线性' },
];

const _tintColor = new THREE.Color();

/** 取数字属性：空 / 非法值用默认 */
function num(v, d) {
  const x = Number(v);
  return v === '' || v === null || v === undefined || Number.isNaN(x) ? d : x;
}

/**
 * 单个画面处理对象 → { exposure, toneMapping, colorSpace, saturation, tint }
 * EV 是相对基准的档数（+1 档亮度翻倍）；saturation 是倍率（1 = 不变）；tint 是 0..1 的线性 RGB（1 = 不染）
 */
export function resolveScreen(o, out = {}) {
  const ev = clamp(Number(o.ev) || 0, -3, 3);
  out.ev = ev;
  out.exposure = BASE_EXPOSURE * Math.pow(2, ev);
  out.toneMapping = TONE_MAPPING[o.toneMapping] ?? THREE.ACESFilmicToneMapping;
  out.colorSpace = COLOR_SPACE[o.colorSpace] ?? THREE.SRGBColorSpace;
  out.saturation = clamp(num(o.saturation, 1), 0, 3);
  const hex = typeof o.tint === 'string' && /^#?[0-9a-f]{6}$/i.test(o.tint.replace('#', '')) ? o.tint : '#ffffff';
  _tintColor.set(hex);
  out.tint = [_tintColor.r, _tintColor.g, _tintColor.b];
  return out;
}

/** 取关卡里生效的画面处理对象（priority 最大者），没有则返回 null */
export function collectScreen(level, out = {}) {
  const list = level && level.objects;
  if (!list || !list.length) return null;
  let best = null, bp = -Infinity;
  for (const o of list) {
    // 类型键沿用 'exposure'：老关卡存档里存的就是它，换键会让已有关卡丢对象
    if (!o || o.type !== 'exposure' || o.visible === false) continue;
    const p = Number(o.priority) || 0;
    if (p > bp) { bp = p; best = o; }
  }
  return best ? resolveScreen(best, out) : null;
}
