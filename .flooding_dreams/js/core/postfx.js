/* ============================================================
   后处理管线（自研，vendor 版 three 里没有 EffectComposer）
   ------------------------------------------------------------
   渲染流程：
     ① 场景 → HDR RenderTarget（线性空间，three 对 RT 不做色调映射 / sRGB 编码）
     ② 泛光：亮度提取 + 可分离高斯模糊（1/4 分辨率，两次迭代）
     ③ 全屏 pass：曝光 → 泛光叠加 → 色彩校正 → 特殊效果 → ACES → sRGB
   性能约定（每一项都可在「后处理对象」里单独启用/禁用，默认只开曝光补偿）：
     · 关掉的项目不参与着色器变体：连纹理采样都不发生（同一套组合只编译一次，之后走缓存）
     · 泛光链路只在泛光启用时才跑，且降到 1/4 分辨率
     · 全部项目都是中性值时不接管渲染，直接交给引擎普通路径（零开销）
     · RT 的 MSAA 数量跟随画质档位的「抗锯齿」设置，低/中档位不再强制 4x
   ============================================================ */
import * as THREE from './three-ns.js';
import { clamp } from './util.js';

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const _sizeV2 = new THREE.Vector2();
const BLACK_RGB = [0, 0, 0];
const WHITE_RGB = [1, 1, 1];

/* ---------- 全屏调色 pass ---------- */
/* USE_* / STYLE / STRENGTH_MODE 由 JS 按需拼在源码前面，未启用的分支整段被编译掉 */
const GRADE_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tFog;
uniform vec2  uTexel;
uniform float uTime;
uniform float uToneExp;                  // 渲染器基础曝光 / 0.6（ACES 缩放）
uniform float uExposure, uContrast, uSaturation, uTemperature, uTint, uVignette;
uniform float uGrain, uChromatic, uSharpen, uBloomAmt, uLevels, uStrength;
uniform float uFxAmount, uFxScale;
uniform vec3  uLift, uGain;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/* three 的 ACESFilmic 拟合（含 output matrix），保证开/关后处理观感一致 */
vec3 acesFilm(vec3 color) {
  const mat3 IN = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  const mat3 OUT = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  color = IN * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = a / b;
  return clamp(OUT * color, 0.0, 1.0);
}

vec3 lin2srgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(0.4166667)) - 0.055, step(vec3(0.0031308), c));
}

#if STYLE == 7
/* 热成像伪彩 */
vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.01, 0.01, 0.22), vec3(0.34, 0.04, 0.55), smoothstep(0.0, 0.28, t));
  c = mix(c, vec3(0.78, 0.09, 0.34), smoothstep(0.24, 0.5, t));
  c = mix(c, vec3(1.0, 0.45, 0.08), smoothstep(0.46, 0.72, t));
  c = mix(c, vec3(1.0, 0.92, 0.34), smoothstep(0.7, 0.9, t));
  return mix(c, vec3(1.0), smoothstep(0.88, 1.0, t));
}
#endif

void main() {
  vec2 uv = vUv;

#if STYLE == 2 || STYLE == 4 || STYLE == 5
  /* ---- 特殊效果对采样坐标的扰动 ---- */
  #if STYLE == 2                          // 像素化
    float px = max(8.0, uFxScale);
    vec2 grid = vec2(px, max(8.0, px * 0.5625));
    uv = (floor(uv * grid) + 0.5) / grid;
  #elif STYLE == 4                        // 镜像分割
    uv.x = mix(uv.x, abs(uv.x - 0.5), uFxAmount);
  #else                                   // 故障抖动
    float row = floor(uv.y * 64.0);
    float n = hash21(vec2(row, floor(uTime * 11.0)));
    float band = step(0.76, n) * (n - 0.76) * 3.0;
    uv.x = fract(uv.x + (hash21(vec2(row, 7.0)) - 0.5) * 0.12 * uFxAmount * band);
    uv.y = clamp(uv.y + (band - 0.05) * 0.006 * uFxAmount, 0.001, 0.999);
  #endif
#endif

  vec2 d = uv - 0.5;
  vec3 base;
#ifdef USE_CHROMA
  /* 镜头色散 */
  vec2 o = d * uChromatic * 0.012;
  base = vec3(
    texture2D(tScene, uv + o).r,
    texture2D(tScene, uv).g,
    texture2D(tScene, uv - o).b
  );
#else
  base = texture2D(tScene, uv).rgb;
#endif

#ifdef USE_SHARPEN
  /* 4 邻域反锐化 */
  vec3 blur = texture2D(tScene, uv + vec2(uTexel.x, 0.0)).rgb
            + texture2D(tScene, uv - vec2(uTexel.x, 0.0)).rgb
            + texture2D(tScene, uv + vec2(0.0, uTexel.y)).rgb
            + texture2D(tScene, uv - vec2(0.0, uTexel.y)).rgb;
  base += (base - blur * 0.25) * uSharpen;
#endif

#ifdef USE_FOG
  /* 体积雾：半分辨率缓冲上采样，预乘 over（rgb 已乘 alpha）；必须放在色调映射之前 */
  vec4 fog = texture2D(tFog, uv);
  base = fog.rgb + base * (1.0 - fog.a);
#endif

  float ev = exp2(uExposure);
#ifdef USE_BLOOM
  vec3 c = (base + texture2D(tBloom, uv).rgb * uBloomAmt) * ev;
#else
  vec3 c = base * ev;
#endif
  vec3 graded = c;

  /* ---- 色彩校正 ---- */
#ifdef USE_SAT
  graded = mix(vec3(dot(graded, LUMA)), graded, uSaturation);
#endif
#ifdef USE_CONTRAST
  graded = (graded - 0.5) * uContrast + 0.5;
#endif
#ifdef USE_WB
  graded += vec3(uTemperature * 0.30, uTemperature * 0.02, -uTemperature * 0.32);
  graded += vec3(uTint * 0.10, -uTint * 0.22, uTint * 0.10);
#endif
#ifdef USE_LIFTG
  graded = graded * uGain + uLift * (vec3(1.0) - graded);
#endif
#ifdef USE_LEVELS
  graded = floor(graded * uLevels + 0.5) / uLevels;
#endif

#if STYLE == 1 || STYLE == 3 || STYLE == 6 || STYLE == 7
  /* ---- 颜色类特殊效果 ---- */
  #if STYLE == 1                          // 扫描线
    float s = 0.5 + 0.5 * sin(uv.y * max(60.0, uFxScale * 3.0) * 3.14159 + uTime * 4.0);
    graded *= 1.0 - uFxAmount * 0.5 * s;
  #elif STYLE == 3                        // 半调网点
    float l = clamp(dot(graded, LUMA), 0.0, 1.0);
    vec2 g = fract(uv * max(20.0, uFxScale * 0.5)) - 0.5;
    graded = mix(graded, vec3(step(length(g), sqrt(l) * 0.5)), uFxAmount);
  #elif STYLE == 6                        // 梦境柔光（径向拖尾）
    vec3 soft = vec3(0.0);
    for (int i = 1; i <= 3; i++) {
      float k = float(i) * 0.008 * uFxAmount;
      soft += texture2D(tScene, uv - d * k).rgb + texture2D(tScene, uv + d * k).rgb;
    }
    graded += soft / 6.0 * uFxAmount * 0.9;
  #else                                   // 热成像
    graded = mix(graded, heat(dot(graded, LUMA)), uFxAmount);
  #endif
#endif

#ifdef USE_VIGNETTE
  /* ---- 镜头暗角（成像端衰减，放在色调映射之前） ---- */
  float vig = smoothstep(1.25, 0.28, length(d) * 1.42);
  graded *= mix(1.0, vig, clamp(uVignette, 0.0, 1.5));
#endif

#if STRENGTH_MODE == 2
  vec3 outc = acesFilm(graded * uToneExp);
#elif STRENGTH_MODE == 0
  vec3 outc = acesFilm(base * ev * uToneExp);
#else
  /* ---- 色调映射 + 强度混合（0 = 原画面，1 = 全效果） ---- */
  vec3 toneOff = acesFilm(base * ev * uToneExp);
  vec3 toneOn  = acesFilm(graded * uToneExp);
  vec3 outc = mix(toneOff, toneOn, clamp(uStrength, 0.0, 1.0));
#endif

#ifdef USE_GRAIN
  /* ---- 胶片颗粒（显示空间） ---- */
  float g = hash21(uv * vec2(1920.0, 1080.0) + fract(uTime * 1.7) * 137.0) - 0.5;
  outc += g * uGrain;
#endif

  gl_FragColor = vec4(lin2srgb(clamp(outc, 0.0, 1.0)), 1.0);
}`;

/* ---------- 泛光：亮度提取 ---------- */
const BRIGHT_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float uThreshold, uKnee;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + max(uKnee, 0.02), l), 1.0);
}`;

/* ---------- 泛光：可分离高斯模糊 ---------- */
const BLUR_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDir;
void main() {
  vec3 s = texture2D(tSrc, vUv).rgb * 0.227027;
  s += (texture2D(tSrc, vUv + uDir * 1.3846).rgb + texture2D(tSrc, vUv - uDir * 1.3846).rgb) * 0.316216;
  s += (texture2D(tSrc, vUv + uDir * 3.2308).rgb + texture2D(tSrc, vUv - uDir * 3.2308).rgb) * 0.070270;
  gl_FragColor = vec4(s, 1.0);
}`;

/* ============================================================
   预设（电影级调色 / 特殊效果）
   预设提供“底调”，对象上的滑块在此基础上叠加微调
   ============================================================ */
export const POSTFX_STYLES = [
  { v: 'none', l: '无' },
  { v: 'scanlines', l: '扫描线' },
  { v: 'pixelate', l: '像素化' },
  { v: 'halftone', l: '半调网点' },
  { v: 'mirror', l: '镜像分割' },
  { v: 'glitch', l: '故障抖动' },
  { v: 'dream', l: '梦境柔光' },
  { v: 'thermal', l: '热成像' },
];
const STYLE_CODE = { none: 0, scanlines: 1, pixelate: 2, halftone: 3, mirror: 4, glitch: 5, dream: 6, thermal: 7 };

/** 预设：style + 各参数的基准值（对象滑块 = 在此之上的偏移/倍率） */
export const POSTFX_PRESETS = [
  { v: 'neutral', l: '中性校色（默认）', style: 'none',
    exposure: 0, contrast: 1.05, saturation: 1.04, temperature: 0.02, tint: 0,
    lift: '#000000', gain: '#ffffff', vignette: 0.18, grain: 0.015, chromatic: 0,
    bloom: 0.25, threshold: 0.9, sharpen: 0.18, levels: 0 },
  { v: 'cinematic', l: '电影级调色（青橙）', style: 'none',
    exposure: -0.05, contrast: 1.16, saturation: 1.06, temperature: 0.10, tint: 0.02,
    lift: '#16202f', gain: '#ffdcb4', vignette: 0.42, grain: 0.05, chromatic: 0.25,
    bloom: 0.4, threshold: 0.78, sharpen: 0.3, levels: 0 },
  { v: 'dream', l: '梦境柔光', style: 'dream',
    exposure: 0.05, contrast: 1.02, saturation: 1.14, temperature: 0.16, tint: 0.04,
    lift: '#2a1f3a', gain: '#fff0d0', vignette: 0.3, grain: 0.03, chromatic: 0.2,
    bloom: 0.8, threshold: 0.6, sharpen: 0.08, levels: 0 },
  { v: 'sunset', l: '夕阳暖调', style: 'none',
    exposure: 0.05, contrast: 1.1, saturation: 1.16, temperature: 0.3, tint: 0.06,
    lift: '#241026', gain: '#ffe0b0', vignette: 0.35, grain: 0.04, chromatic: 0.15,
    bloom: 0.6, threshold: 0.62, sharpen: 0.22, levels: 0 },
  { v: 'coldmist', l: '冷雾青蓝', style: 'none',
    exposure: -0.05, contrast: 1.1, saturation: 0.94, temperature: -0.22, tint: -0.04,
    lift: '#0f2233', gain: '#e8f6ff', vignette: 0.35, grain: 0.03, chromatic: 0.1,
    bloom: 0.35, threshold: 0.8, sharpen: 0.25, levels: 0 },
  { v: 'noir', l: '黑白胶片', style: 'none',
    exposure: 0.05, contrast: 1.3, saturation: 0, temperature: 0, tint: 0,
    lift: '#101018', gain: '#f2f2ee', vignette: 0.5, grain: 0.14, chromatic: 0,
    bloom: 0.35, threshold: 0.75, sharpen: 0.35, levels: 0 },
  { v: 'highcontrast', l: '高反差戏剧', style: 'none',
    exposure: -0.15, contrast: 1.45, saturation: 0.9, temperature: 0, tint: 0,
    lift: '#0a0f1a', gain: '#ffffff', vignette: 0.45, grain: 0.06, chromatic: 0,
    bloom: 0.45, threshold: 0.72, sharpen: 0.4, levels: 0 },
  { v: 'poster', l: '色阶海报', style: 'none',
    exposure: 0.05, contrast: 1.2, saturation: 1.25, temperature: 0.05, tint: 0,
    lift: '#000000', gain: '#ffffff', vignette: 0.3, grain: 0, chromatic: 0,
    bloom: 0.3, threshold: 0.8, sharpen: 0, levels: 5 },
  { v: 'vhs', l: 'VHS 复古录像', style: 'scanlines',
    exposure: 0.1, contrast: 1.08, saturation: 1.25, temperature: 0.18, tint: 0,
    lift: '#241a2e', gain: '#fff3d8', vignette: 0.4, grain: 0.22, chromatic: 0.9,
    bloom: 0.5, threshold: 0.7, sharpen: 0.1, levels: 0 },
  { v: 'nightvision', l: '夜视仪', style: 'scanlines',
    exposure: 0.4, contrast: 1.15, saturation: 0.2, temperature: -0.1, tint: 0.7,
    lift: '#04120a', gain: '#c8ffc8', vignette: 0.75, grain: 0.3, chromatic: 0.3,
    bloom: 0.7, threshold: 0.55, sharpen: 0.2, levels: 0 },
  { v: 'thermal', l: '热成像', style: 'thermal',
    exposure: 0.2, contrast: 1.1, saturation: 1, temperature: 0, tint: 0,
    lift: '#000000', gain: '#ffffff', vignette: 0.4, grain: 0.08, chromatic: 0.2,
    bloom: 0.5, threshold: 0.65, sharpen: 0.2, levels: 0 },
  { v: 'underwater', l: '水下调色', style: 'dream',
    exposure: -0.1, contrast: 0.98, saturation: 0.92, temperature: -0.3, tint: -0.08,
    lift: '#062030', gain: '#bfeaff', vignette: 0.5, grain: 0.05, chromatic: 0.35,
    bloom: 0.4, threshold: 0.7, sharpen: 0.1, levels: 0 },
  { v: 'glitchy', l: '故障艺术', style: 'glitch',
    exposure: 0, contrast: 1.12, saturation: 1.2, temperature: 0.05, tint: 0.1,
    lift: '#120a1e', gain: '#ffe9ff', vignette: 0.35, grain: 0.1, chromatic: 1.2,
    bloom: 0.5, threshold: 0.7, sharpen: 0.2, levels: 0 },
];
const PRESET_BY_KEY = {};
for (const p of POSTFX_PRESETS) PRESET_BY_KEY[p.v] = p;
const STYLE_OPTIONS = [{ v: '', l: '按预设' }].concat(POSTFX_STYLES);

export const POSTFX_STYLE_OPTIONS = STYLE_OPTIONS;

/* ============================================================
   每项效果的启用开关
   存在对象上的 o.en = { 键: true/false }；缺失时用默认值：
   只有「曝光补偿」默认开启，其余默认关闭（关掉的项目不参与渲染，也就几乎不耗性能）
   ============================================================ */
export const POSTFX_TOGGLE_KEYS = [
  'exposure', 'contrast', 'saturation', 'temperature', 'tint', 'lift', 'gain',
  'vignette', 'grain', 'chromatic', 'bloom', 'bloomThreshold', 'sharpen', 'levels',
  'fx', 'fxAmount', 'fxScale', 'timeScale',
];
/** 只有曝光补偿默认开启 */
export const POSTFX_TOGGLE_DEFAULT_ON = { exposure: true };

/** 读出对象的开关状态（补齐缺失项） */
export function postfxToggleState(o) {
  const src = (o && o.en) || {};
  const out = {};
  for (const k of POSTFX_TOGGLE_KEYS) {
    out[k] = src[k] === undefined ? !!POSTFX_TOGGLE_DEFAULT_ON[k] : !!src[k];
  }
  return out;
}

export function defaultPostFXParams(out = {}) {
  return resolvePostFX({ preset: 'neutral', en: {} }, out);
}

const _c = new THREE.Color();
function toRGB(hex, fallback) {
  const h = typeof hex === 'string' && /^#?[0-9a-f]{6}$/i.test(hex.replace('#', '')) ? hex : fallback;
  _c.set(h);
  return [_c.r, _c.g, _c.b];
}

/** 单个后处理对象 → 着色器参数（预设底调 + 对象滑块，逐项按开关决定是否参与） */
export function resolvePostFX(o, out = {}) {
  const base = PRESET_BY_KEY[o.preset] || PRESET_BY_KEY.neutral;
  const n = (v, d) => {
    const x = Number(v);
    return v === '' || v === null || v === undefined || Number.isNaN(x) ? d : x;
  };
  const on = postfxToggleState(o);

  out.exposure = on.exposure ? base.exposure + n(o.exposure, 0) : 0;
  out.contrast = clamp(on.contrast ? base.contrast * n(o.contrast, 1) : 1, 0, 4);
  out.saturation = clamp(on.saturation ? base.saturation * n(o.saturation, 1) : 1, 0, 4);
  out.temperature = clamp(on.temperature ? base.temperature + n(o.temperature, 0) : 0, -1.5, 1.5);
  out.tint = clamp(on.tint ? base.tint + n(o.tint, 0) : 0, -1.5, 1.5);
  out.vignette = clamp(on.vignette ? base.vignette + n(o.vignette, 0) : 0, 0, 1.5);
  out.grain = clamp(on.grain ? base.grain + n(o.grain, 0) : 0, 0, 0.6);
  out.chromatic = clamp(on.chromatic ? base.chromatic + n(o.chromatic, 0) : 0, 0, 4);
  out.bloom = clamp(on.bloom ? base.bloom + n(o.bloom, 0) : 0, 0, 3);
  out.bloomThreshold = clamp(on.bloomThreshold ? base.threshold + n(o.bloomThreshold, 0) : 0.9, 0, 3);
  out.sharpen = clamp(on.sharpen ? base.sharpen + n(o.sharpen, 0) : 0, 0, 1.5);
  const lv = n(o.levels, 0);
  out.levels = on.levels ? (lv > 1.5 ? Math.round(lv) : base.levels) : 0;
  out.style = on.fx ? (STYLE_CODE[o.fx || base.style] ?? 0) : 0;
  out.fxAmount = clamp(on.fxAmount ? n(o.fxAmount, 0.6) : 1, 0, 1);
  out.fxScale = clamp(on.fxScale ? n(o.fxScale, 220) : 220, 4, 4096);
  out.timeScale = on.timeScale ? n(o.timeScale, 1) : 1;
  out.strength = clamp(n(o.strength, 1), 0, 1);
  out.lift = on.lift ? toRGB(o.lift && o.lift !== '#000000' ? o.lift : base.lift, '#000000') : BLACK_RGB;
  out.gain = on.gain ? toRGB(o.gain && o.gain !== '#ffffff' ? o.gain : base.gain, '#ffffff') : WHITE_RGB;

  /* 着色器变体开关：决定哪些分支会被编译进这一版着色器 */
  const liftg = out.lift[0] + out.lift[1] + out.lift[2] > 1e-4 ||
    Math.abs(out.gain[0] - 1) + Math.abs(out.gain[1] - 1) + Math.abs(out.gain[2] - 1) > 1e-4;
  out.fx = {
    bloom: out.bloom > 0.002,
    chroma: out.chromatic > 0.001,
    sharpen: out.sharpen > 0.001,
    grain: out.grain > 0.0005,
    vignette: out.vignette > 0.001,
    liftg,
    levels: out.levels > 1.5,
    wb: out.temperature !== 0 || out.tint !== 0,
    sat: out.saturation !== 1,
    contrast: out.contrast !== 1,
    style: out.style,
    sMode: out.strength >= 0.999 ? 2 : (out.strength <= 0.001 ? 0 : 1),
  };
  /* 全部中性 = 与不做后处理完全一致 → 引擎可以走普通渲染路径 */
  out.neutral = out.exposure === 0 && !out.fx.bloom && !out.fx.chroma && !out.fx.sharpen &&
    !out.fx.grain && !out.fx.vignette && !out.fx.liftg && !out.fx.levels && !out.fx.wb &&
    !out.fx.sat && !out.fx.contrast && out.fx.style === 0;
  return out;
}

/* 真正的「中性」参数：所有项目关掉，只有 ACES + sRGB + 曝光 —— 与引擎默认渲染路径完全一致。
   关卡里没有「后处理对象」、但有体积雾时，管线仍然要接管一帧（雾必须在色调映射前合成），
   这时就用这一套参数，观感与不做后处理时相同。 */
const NEUTRAL_TOGGLES = {};
for (const k of POSTFX_TOGGLE_KEYS) NEUTRAL_TOGGLES[k] = false;
const NEUTRAL_PARAMS = resolvePostFX({ preset: 'neutral', en: NEUTRAL_TOGGLES });

/** 取关卡里生效的后处理对象（priority 最大者），没有则返回 null */
export function collectPostFX(level, out = {}) {
  const list = level && level.objects;
  if (!list || !list.length) return null;
  let best = null, bp = -Infinity;
  for (const o of list) {
    if (!o || o.type !== 'postfx' || o.visible === false) continue;
    const p = Number(o.priority) || 0;
    if (p > bp) { bp = p; best = o; }
  }
  return best ? resolvePostFX(best, out) : null;
}

/* ============================================================
   管线本体
   ============================================================ */
export class PostFX {
  /** samples: HDR RT 的 MSAA 数量（0 = 关闭，跟随画质档位） */
  constructor(renderer, samples = 4) {
    this.renderer = renderer;
    this.provider = null;          // (out) => params | null
    this.active = false;
    this.params = defaultPostFXParams();
    this.time = 0;
    this._w = 2; this._h = 2;
    this._rt = null;
    this._bA = null; this._bB = null;
    this._hdr = !!renderer.capabilities.isWebGL2;
    this._samples = this._hdr ? Math.max(0, samples | 0) : 0;
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._quad.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(this._quad);
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    /* 调色 pass 按「启用组合」编译多份变体，同一组合只编译一次 */
    this._gradeCache = new Map();
    this._grade = null;
    this._texelV = new THREE.Vector2(0.5, 0.5);   // 所有变体共用，改一处即可
    this._bright = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uThreshold: { value: 0.85 }, uKnee: { value: 0.3 } },
    });
    this._blur = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
    });
    this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this._black.needsUpdate = true;
    // 全透明黑：体积雾启用但本帧没画出雾时用它，合成结果 = 原画面
    this._clearFog = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this._clearFog.needsUpdate = true;
    this._fog = null;      // VolumeFog（由 LevelBuilder 创建 / 销毁，这里只借用）
  }

  /** 体积雾管线（world/volumefog.js）；传 null 解绑 */
  setVolumeFog(fog) { this._fog = fog || null; }

  /** 参数来源：每帧回调，返回 null 表示本帧不用后处理 */
  setProvider(fn) { this.provider = fn || null; if (!fn) this.active = false; }
  clear() { this.provider = null; this.active = false; }

  /** MSAA 数量（画质档位的抗锯齿）；变化时重建 RT */
  setSamples(n) {
    const s = this._hdr ? Math.max(0, n | 0) : 0;
    if (s === this._samples) return;
    this._samples = s;
    if (this._rt) { this._rt.dispose(); this._rt = null; }
  }

  setSize(w, h) {
    const nw = Math.max(2, Math.floor(w));
    const nh = Math.max(2, Math.floor(h));
    if (nw === this._w && nh === this._h && this._rt) return;
    this._w = nw; this._h = nh;
    const type = this._hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    if (this._rt) this._rt.dispose();
    this._rt = new THREE.WebGLRenderTarget(nw, nh, {
      type, depthBuffer: true, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this._rt.texture.colorSpace = THREE.NoColorSpace;   // 线性 HDR：色调映射交给全屏 pass
    if (this._samples) this._rt.samples = this._samples;
    // 泛光链路跑在 1/4 分辨率：模糊本来就糊，肉眼几乎无差别，但填充率省 4 倍
    const bw = Math.max(2, Math.floor(nw / 4));
    const bh = Math.max(2, Math.floor(nh / 4));
    for (const k of ['_bA', '_bB']) {
      if (this[k]) this[k].dispose();
      this[k] = new THREE.WebGLRenderTarget(bw, bh, {
        type, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
      this[k].texture.colorSpace = THREE.NoColorSpace;
    }
    this._texelV.set(1 / nw, 1 / nh);
    this._bw = bw; this._bh = bh;
  }

  _pass(mat, target) {
    this._quad.material = mat;
    this.renderer.autoClear = false;      // 全屏四边形覆盖整个目标，不必清屏
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._scene, this._cam);
  }

  /** 按启用组合取（或编译）调色材质 */
  _gradeMaterial(f, fogOn) {
    const key = (f.bloom ? 1 : 0) | (f.chroma ? 2 : 0) | (f.sharpen ? 4 : 0) | (f.grain ? 8 : 0) |
      (f.vignette ? 16 : 0) | (f.liftg ? 32 : 0) | (f.levels ? 64 : 0) | (f.wb ? 128 : 0) |
      (f.sat ? 256 : 0) | (f.contrast ? 512 : 0) | (f.style << 10) | (f.sMode << 16) |
      (fogOn ? 1 << 18 : 0);
    const hit = this._gradeCache.get(key);
    if (hit) return hit;
    let defs = '';
    if (fogOn) defs += '#define USE_FOG\n';
    if (f.bloom) defs += '#define USE_BLOOM\n';
    if (f.chroma) defs += '#define USE_CHROMA\n';
    if (f.sharpen) defs += '#define USE_SHARPEN\n';
    if (f.grain) defs += '#define USE_GRAIN\n';
    if (f.vignette) defs += '#define USE_VIGNETTE\n';
    if (f.liftg) defs += '#define USE_LIFTG\n';
    if (f.levels) defs += '#define USE_LEVELS\n';
    if (f.wb) defs += '#define USE_WB\n';
    if (f.sat) defs += '#define USE_SAT\n';
    if (f.contrast) defs += '#define USE_CONTRAST\n';
    defs += `#define STYLE ${f.style | 0}\n#define STRENGTH_MODE ${f.sMode | 0}\n`;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: defs + GRADE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tScene: { value: null }, tBloom: { value: null }, tFog: { value: null },
        uTexel: { value: this._texelV },
        uTime: { value: 0 }, uToneExp: { value: 1.06 / 0.6 },
        uExposure: { value: 0 }, uContrast: { value: 1 }, uSaturation: { value: 1 },
        uTemperature: { value: 0 }, uTint: { value: 0 }, uVignette: { value: 0.2 },
        uGrain: { value: 0 }, uChromatic: { value: 0 }, uSharpen: { value: 0 },
        uBloomAmt: { value: 0 }, uLevels: { value: 0 }, uStrength: { value: 1 },
        uFxAmount: { value: 0.6 }, uFxScale: { value: 220 },
        uLift: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      },
    });
    // 变体数量有限（开关组合是离散的），缓存住避免反复编译；超出上限时淘汰一个非当前使用的
    if (this._gradeCache.size > 48) {
      for (const [k, m] of this._gradeCache) {
        if (m === this._grade) continue;
        this._gradeCache.delete(k);
        m.dispose();
        break;
      }
    }
    this._gradeCache.set(key, mat);
    return mat;
  }

  _applyUniforms(p) {
    const u = this._grade.uniforms;
    u.uToneExp.value = (this.renderer.toneMappingExposure || 1) / 0.6;
    u.uExposure.value = p.exposure;
    u.uContrast.value = p.contrast;
    u.uSaturation.value = p.saturation;
    u.uTemperature.value = p.temperature;
    u.uTint.value = p.tint;
    u.uVignette.value = p.vignette;
    u.uGrain.value = p.grain;
    u.uChromatic.value = p.chromatic;
    u.uSharpen.value = p.sharpen;
    u.uBloomAmt.value = p.bloom;
    u.uLevels.value = p.levels;
    u.uStrength.value = p.strength;
    u.uFxAmount.value = p.fxAmount;
    u.uFxScale.value = p.fxScale;
    u.uLift.value.fromArray(p.lift);
    u.uGain.value.fromArray(p.gain);
  }

  /**
   * 渲染一帧（含泛光链）。返回 false 表示本帧不启用后处理，交给引擎走普通路径
   * view: { scene, camera, overlay? }
   */
  render(renderer, view, dt) {
    if (!view || !view.scene || !view.camera) { this.active = false; return false; }
    // 体积雾必须在色调映射之前合成：只要关卡里有雾对象，本帧就得接管
    const fog = this._fog;
    const fogOn = !!(fog && fog.scene && fog.active && view.camera);
    let p = this.provider ? this.provider(this.params) : null;
    if (p && p.neutral) p = null;
    if (!p && !fogOn) { this.active = false; return false; }
    this.active = true;
    const params = p || NEUTRAL_PARAMS;
    this.time += (dt || 0) * (params.timeScale === undefined ? 1 : params.timeScale);

    const size = renderer.getDrawingBufferSize(_sizeV2);
    this.setSize(size.x, size.y);

    this._grade = this._gradeMaterial(params.fx, fogOn);
    this._applyUniforms(params);
    this._grade.uniforms.uTime.value = this.time;

    /* ① 场景 → HDR RT */
    const prevAuto = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this._rt);
    renderer.render(view.scene, view.camera);
    if (view.overlay) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(view.overlay.scene, view.overlay.camera);
    }
    renderer.autoClear = prevAuto;

    /* ①b 体积雾：半分辨率 + 时域累积，合成在调色 pass 里（预乘 over，色调映射之前） */
    let fogTex = this._clearFog;
    if (fogOn) {
      const t = fog.render(renderer, view.camera);
      if (t) fogTex = t;
    }
    this._grade.uniforms.tFog.value = fogTex;

    /* ② 泛光链（只在泛光启用时跑） */
    let bloomTex = this._black;
    if (params.fx.bloom) {
      this._bright.uniforms.tSrc.value = this._rt.texture;
      this._bright.uniforms.uThreshold.value = params.bloomThreshold;
      this._pass(this._bright, this._bA);
      const n = params.bloom > 0.9 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const k = (1 + i * 1.6) * 0.5;      // 1/4 分辨率下的等效半径（原先半分辨率时是 k/1）
        this._blur.uniforms.tSrc.value = this._bA.texture;
        this._blur.uniforms.uDir.value.set(k / this._bw, 0);
        this._pass(this._blur, this._bB);
        this._blur.uniforms.tSrc.value = this._bB.texture;
        this._blur.uniforms.uDir.value.set(0, k / this._bh);
        this._pass(this._blur, this._bA);
      }
      bloomTex = this._bA.texture;
    }

    /* ③ 全屏调色 → canvas */
    this._grade.uniforms.tScene.value = this._rt.texture;
    this._grade.uniforms.tBloom.value = bloomTex;
    renderer.setRenderTarget(null);
    this._quad.material = this._grade;
    renderer.render(this._scene, this._cam);
    renderer.autoClear = prevAuto;
    return true;
  }

  dispose() {
    this.clear();
    if (this._rt) this._rt.dispose();
    if (this._bA) this._bA.dispose();
    if (this._bB) this._bB.dispose();
    if (this._black) this._black.dispose();
    if (this._clearFog) this._clearFog.dispose();
    this._fog = null;
    this._quad.geometry.dispose();
    for (const m of this._gradeCache.values()) m.dispose();
    this._gradeCache.clear();
    this._grade = null;
    this._bright.dispose();
    this._blur.dispose();
    this._rt = this._bA = this._bB = null;
  }
}