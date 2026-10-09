/* ============================================================
   高级材质：内置 41 种特殊 / 特效表面材质（用于网格模型）
   - 物理类：只调参数（金属 / 陶瓷 …），零额外开销
   - 图案类：在标准材质上注入一段片元着色器（力场 / 全息 / 熔岩 …）
     走 onBeforeCompile，光照、阴影、IBL、顶点 AO 全部照旧生效
   - 玻璃：屏幕空间折射 / 反射（折射率 / 边缘吸光 / 透明度可调），
     同样走 onBeforeCompile 注入，光照 / 阴影 / 顶点 AO 照旧生效。
     原理：主渲染前把「不含玻璃的场景」渲进一张半分辨率缓冲（颜色 + 深度），
     玻璃片元按屏幕坐标 + 由 refract()/reflect() 投影出的偏移采样该缓冲，
     再用 Beer-Lambert 边缘吸光 + 菲涅尔合成（见 renderGlassCapture）
   - 反射：另做一次性的场景立方体捕获（全关卡共用一张），
     作为玻璃屏幕空间缓冲不可用时的兜底反射（镜像 / 镀铬等高级材质仍用它做 IBL）
   ============================================================ */
import * as THREE from '../core/three-ns.js';

/* ============================================================
   图案种类（片元着色器分支下标）
   ============================================================ */
export const FX_HEX = 0, FX_SHIELD = 1, FX_HOLO = 2, FX_SCANLINE = 3, FX_GRID = 4,
  FX_CIRCUIT = 5, FX_DATA = 6, FX_PLASMA = 7, FX_NEON = 8, FX_TOXIC = 9, FX_LAVA = 10,
  FX_VORTEX = 11, FX_SPIRIT = 12, FX_AURORA = 13, FX_WARP = 14, FX_GLITCH = 15,
  FX_MATRIX = 16, FX_VOID = 17, FX_IRIDESCENT = 18, FX_MARBLE = 19, FX_WEAVE = 20,
  FX_FROST = 21, FX_CAMO = 22, FX_DOTS = 23, FX_STRIPE = 24, FX_VELVET = 25,
  FX_DREAM = 26, FX_WEIRD = 27;

/* ============================================================
   预设表
   g 分组 / fx 图案（-1 = 纯参数，不注入着色器）
   c 颜色 r 粗糙度 m 金属度 t 透明度 e 自发光 ei 自发光强度
   re 反射率 sc 图案密度 amp 图案强度 c2 图案色
   ============================================================ */
const G_GLASS = '玻璃';
const G_METAL = '金属';
const G_ENERGY = '能量 / 发光';
const G_SURFACE = '表面 / 装饰';

export const ADV_PRESETS = [
  /* ---------- 玻璃 ----------
     屏幕空间折射 / 反射：折射率 / 边缘吸光 / 透明度 全可调。
     glass: true 标记走玻璃屏幕空间着色器；ior 折射率、absorb 边缘吸光强度；
     颜色 c 作为折射 / 吸收的染色，透明度 t 越高越清澈 */
  { v: 'glass', l: '玻璃', g: G_GLASS, fx: -1, glass: true, c: '#bfe8ff', r: 0.02, m: 0.00, t: 0.70, e: '#000000', ei: 0, re: 1.60, sc: 1, amp: 0, c2: '#ffffff', ior: 1.50, absorb: 0.55 },

  /* ---------- 金属 ---------- */
  { v: 'chrome', l: '镀铬', g: G_METAL, fx: -1, c: '#f2f6fa', r: 0.06, m: 1.00, t: 0, e: '#000000', ei: 0, re: 2.20, sc: 1, amp: 0, c2: '#ffffff' },
  { v: 'mirror', l: '镜面', g: G_METAL, fx: -1, c: '#ffffff', r: 0.00, m: 1.00, t: 0, e: '#000000', ei: 0, re: 3.00, sc: 1, amp: 0, c2: '#ffffff' },
  { v: 'gold', l: '黄金', g: G_METAL, fx: -1, c: '#ffd479', r: 0.16, m: 1.00, t: 0, e: '#000000', ei: 0, re: 2.00, sc: 1, amp: 0, c2: '#fff3c4' },
  { v: 'bronze', l: '青铜', g: G_METAL, fx: -1, c: '#cd8a5c', r: 0.30, m: 1.00, t: 0, e: '#000000', ei: 0, re: 1.50, sc: 1, amp: 0, c2: '#e8b98a' },
  { v: 'copper', l: '紫铜', g: G_METAL, fx: -1, c: '#e08a63', r: 0.25, m: 1.00, t: 0, e: '#000000', ei: 0, re: 1.60, sc: 1, amp: 0, c2: '#ffc4a0' },
  { v: 'brushedMetal', l: '拉丝金属', g: G_METAL, fx: FX_STRIPE, c: '#c8ccd4', r: 0.42, m: 0.95, t: 0, e: '#dfe6f2', ei: 0.20, re: 1.20, sc: 26.0, amp: 0.30, c2: '#8a909c' },
  { v: 'metalFoil', l: '金属箔', g: G_METAL, fx: -1, c: '#e8e2ff', r: 0.20, m: 0.90, t: 0, e: '#000000', ei: 0, re: 1.80, sc: 1, amp: 0, c2: '#ffffff' },
  { v: 'liquidMetal', l: '液态金属', g: G_METAL, fx: FX_PLASMA, c: '#dfe6f2', r: 0.02, m: 1.00, t: 0, e: '#9fb4d8', ei: 0.30, re: 2.60, sc: 1.6, amp: 0.35, c2: '#ffffff' },

  /* ---------- 能量 / 发光 ---------- */
  { v: 'forcefield', l: '力场', g: G_ENERGY, fx: FX_HEX, c: '#6ad2ff', r: 0.10, m: 0.10, t: 0.72, e: '#2ea8ff', ei: 1.20, re: 1.40, sc: 1.6, amp: 0.85, c2: '#0a4a8a' },
  { v: 'energyShield', l: '能量护盾', g: G_ENERGY, fx: FX_SHIELD, c: '#7cffd0', r: 0.10, m: 0.15, t: 0.60, e: '#24ffa8', ei: 1.40, re: 1.30, sc: 1.8, amp: 0.90, c2: '#0a6a48' },
  { v: 'hologram', l: '全息投影', g: G_ENERGY, fx: FX_HOLO, c: '#8fe8ff', r: 0.10, m: 0.05, t: 0.70, e: '#59d8ff', ei: 1.60, re: 1.00, sc: 1.4, amp: 0.95, c2: '#1a6a8a' },
  { v: 'scanline', l: '扫描线', g: G_ENERGY, fx: FX_SCANLINE, c: '#9be8ff', r: 0.15, m: 0.10, t: 0.50, e: '#3fc8ff', ei: 1.30, re: 1.10, sc: 1.2, amp: 0.80, c2: '#0a4a6a' },
  { v: 'gridGlow', l: '发光网格', g: G_ENERGY, fx: FX_GRID, c: '#b98cff', r: 0.20, m: 0.15, t: 0.45, e: '#8b5cff', ei: 1.50, re: 1.20, sc: 2.2, amp: 0.90, c2: '#2a1060' },
  { v: 'circuit', l: '电路板', g: G_ENERGY, fx: FX_CIRCUIT, c: '#4dffb8', r: 0.35, m: 0.30, t: 0.20, e: '#16d98a', ei: 1.20, re: 1.10, sc: 3.0, amp: 0.85, c2: '#0a3a28' },
  { v: 'dataStream', l: '数据流', g: G_ENERGY, fx: FX_DATA, c: '#7fe3ff', r: 0.20, m: 0.10, t: 0.35, e: '#2ea8ff', ei: 1.40, re: 1.20, sc: 2.4, amp: 0.90, c2: '#0a2a5a' },
  { v: 'plasma', l: '等离子', g: G_ENERGY, fx: FX_PLASMA, c: '#ff7ad9', r: 0.25, m: 0.10, t: 0.50, e: '#ff3fbf', ei: 1.80, re: 1.20, sc: 2.0, amp: 1.00, c2: '#5a0a4a' },
  { v: 'neonStrips', l: '霓虹灯条', g: G_ENERGY, fx: FX_NEON, c: '#ff5c8a', r: 0.30, m: 0.05, t: 0.25, e: '#ff2d6a', ei: 2.20, re: 1.00, sc: 2.0, amp: 1.00, c2: '#2a0a14' },
  { v: 'toxic', l: '毒液', g: G_ENERGY, fx: FX_TOXIC, c: '#a8ff3f', r: 0.35, m: 0.10, t: 0.55, e: '#6fdc16', ei: 1.10, re: 1.10, sc: 2.0, amp: 0.90, c2: '#1a3a08' },
  { v: 'lavaGlow', l: '熔岩发光', g: G_ENERGY, fx: FX_LAVA, c: '#ff8a3d', r: 0.70, m: 0.05, t: 0, e: '#ff4d10', ei: 1.90, re: 0.80, sc: 3.2, amp: 1.10, c2: '#3a0a00' },
  { v: 'portal', l: '传送门', g: G_ENERGY, fx: FX_VORTEX, c: '#b98cff', r: 0.10, m: 0.15, t: 0.65, e: '#7a4dff', ei: 1.70, re: 1.30, sc: 1.2, amp: 1.00, c2: '#1a0a4a' },
  { v: 'spirit', l: '幽魂', g: G_ENERGY, fx: FX_SPIRIT, c: '#cfe6ff', r: 0.30, m: 0.00, t: 0.80, e: '#8fb8ff', ei: 0.90, re: 1.00, sc: 1.6, amp: 0.70, c2: '#3a4a7a' },
  { v: 'aurora', l: '极光', g: G_ENERGY, fx: FX_AURORA, c: '#7cffd8', r: 0.20, m: 0.10, t: 0.70, e: '#33ffc4', ei: 1.50, re: 1.20, sc: 1.4, amp: 1.00, c2: '#3a0a7a' },
  { v: 'hyperspace', l: '星际穿越', g: G_ENERGY, fx: FX_WARP, c: '#dcdcff', r: 0.15, m: 0.20, t: 0.60, e: '#9c9cff', ei: 1.60, re: 1.40, sc: 1.2, amp: 1.00, c2: '#1a1a5a' },
  { v: 'glitch', l: '数字故障', g: G_ENERGY, fx: FX_GLITCH, c: '#ff5c8a', r: 0.30, m: 0.20, t: 0.40, e: '#ff2d6a', ei: 1.50, re: 1.10, sc: 3.0, amp: 0.95, c2: '#0a3a5a' },
  { v: 'matrix', l: '数据雨', g: G_ENERGY, fx: FX_MATRIX, c: '#5cff8a', r: 0.25, m: 0.10, t: 0.30, e: '#16d94d', ei: 1.40, re: 1.00, sc: 2.4, amp: 0.95, c2: '#062a12' },
  { v: 'voidRift', l: '虚空裂隙', g: G_ENERGY, fx: FX_VOID, c: '#c46bff', r: 0.15, m: 0.10, t: 0.75, e: '#7a2dff', ei: 1.60, re: 1.30, sc: 1.8, amp: 1.05, c2: '#2a0a4a' },

  /* ---------- 表面 / 装饰 ---------- */
  { v: 'pearl', l: '珍珠', g: G_SURFACE, fx: FX_IRIDESCENT, c: '#fff2f6', r: 0.22, m: 0.55, t: 0, e: '#ffe6f0', ei: 0.25, re: 1.80, sc: 1.0, amp: 0.55, c2: '#ffffff' },
  { v: 'oilSlick', l: '油膜', g: G_SURFACE, fx: FX_IRIDESCENT, c: '#2a2a3a', r: 0.12, m: 0.60, t: 0, e: '#000000', ei: 0, re: 1.90, sc: 2.0, amp: 0.95, c2: '#ffffff' },
  { v: 'iridescent', l: '幻彩镭射', g: G_SURFACE, fx: FX_IRIDESCENT, c: '#ffffff', r: 0.18, m: 0.70, t: 0, e: '#000000', ei: 0, re: 2.00, sc: 1.6, amp: 0.80, c2: '#ffffff' },
  { v: 'ceramic', l: '陶瓷', g: G_SURFACE, fx: -1, c: '#f4f0ff', r: 0.28, m: 0.05, t: 0, e: '#000000', ei: 0, re: 1.00, sc: 1, amp: 0, c2: '#ffffff' },
  { v: 'enamel', l: '瓷釉', g: G_SURFACE, fx: -1, c: '#ffe9f2', r: 0.14, m: 0.10, t: 0, e: '#000000', ei: 0, re: 1.30, sc: 1, amp: 0, c2: '#ffffff' },
  { v: 'marble', l: '大理石', g: G_SURFACE, fx: FX_MARBLE, c: '#eceaf4', r: 0.34, m: 0.08, t: 0, e: '#ffffff', ei: 0.10, re: 1.10, sc: 1.2, amp: 0.45, c2: '#6a6480' },
  { v: 'carbonFiber', l: '碳纤维', g: G_SURFACE, fx: FX_WEAVE, c: '#2a2e38', r: 0.32, m: 0.60, t: 0, e: '#5a6478', ei: 0.15, re: 1.30, sc: 12.0, amp: 0.35, c2: '#14161c' },
  { v: 'rubber', l: '橡胶', g: G_SURFACE, fx: -1, c: '#23242c', r: 0.92, m: 0.00, t: 0, e: '#000000', ei: 0, re: 0.50, sc: 1, amp: 0, c2: '#000000' },
  { v: 'camo', l: '迷彩', g: G_SURFACE, fx: FX_CAMO, c: '#6a7a52', r: 0.80, m: 0.02, t: 0, e: '#000000', ei: 0, re: 0.70, sc: 1.4, amp: 0.55, c2: '#3a4230' },
  { v: 'dotMatrix', l: '圆点矩阵', g: G_SURFACE, fx: FX_DOTS, c: '#dfe6ff', r: 0.40, m: 0.20, t: 0, e: '#ffffff', ei: 0.25, re: 1.00, sc: 6.0, amp: 0.55, c2: '#8a94b8' },
  { v: 'stripe', l: '条纹', g: G_SURFACE, fx: FX_STRIPE, c: '#e8e8f0', r: 0.50, m: 0.10, t: 0, e: '#ffffff', ei: 0.10, re: 0.90, sc: 5.0, amp: 0.40, c2: '#5a5a72' },
  { v: 'velvet', l: '丝绒', g: G_SURFACE, fx: FX_VELVET, c: '#8a3a5a', r: 0.95, m: 0.00, t: 0, e: '#ff9ec4', ei: 0.30, re: 0.40, sc: 2.0, amp: 0.60, c2: '#4a1a30' },
  { v: 'dreamcore', l: '梦核', g: G_SURFACE, fx: FX_DREAM, c: '#b98cff', r: 0.30, m: 0.30, t: 0, e: '#8b5cff', ei: 0.55, re: 1.50, sc: 1.2, amp: 0.65, c2: '#4de0ff' },
  { v: 'weirdcore', l: '怪核', g: G_SURFACE, fx: FX_WEIRD, c: '#ffb86b', r: 0.45, m: 0.25, t: 0, e: '#ff8a3d', ei: 0.60, re: 1.20, sc: 2.2, amp: 0.70, c2: '#3a2a1a' },
];

const BY_ID = new Map(ADV_PRESETS.map((p) => [p.v, p]));

/** 高级材质下拉选项（带分组前缀） */
export const ADV_OPTIONS = [{ v: 'none', l: '不使用（标准材质）' }]
  .concat(ADV_PRESETS.map((p) => ({ v: p.v, l: p.g + ' · ' + p.l })));

export function advPreset(id) { return BY_ID.get(id) || null; }

/** 该预设要用的图案下标；-1 = 纯参数材质 */
export function advFxIndex(id) {
  const p = BY_ID.get(id);
  return p ? p.fx : -1;
}

/** 该预设是否为玻璃材质（走立方体贴图折射着色器） */
export function advIsGlass(id) {
  const p = BY_ID.get(id);
  return !!(p && p.glass);
}

/** 把预设写入对象属性（颜色/粗糙度/自发光/反射率/图案参数…）
    选「不使用」时保留用户当前数值，不清空 */
export function applyAdvancedMaterial(o, id) {
  o.advMat = id;
  const p = BY_ID.get(id);
  if (!p) return o;
  o.color = p.c;
  o.roughness = p.r;
  o.metalness = p.m;
  o.transparency = p.t;
  o.emissive = p.e;
  o.emissiveIntensity = p.ei;
  o.reflectivity = p.re;
  o.fxScale = p.sc;
  o.fxAmp = p.amp;
  o.fxColor = p.c2;
  if (p.glass) {              // 玻璃专用参数
    o.ior = p.ior;
    o.glassAbsorb = p.absorb;
  }
  return o;
}

/* ============================================================
   图案着色器
   ============================================================ */
/** 图案动画时间轴（所有高级材质共用，逐帧只更新一次） */
export const ADV_UNIFORMS = { time: { value: 0 } };

/** 顶点着色器：把局部坐标 / 世界坐标 / 世界法线传给片元 */
export const ADV_VERT_CHUNK = `
  vAdvL = position;
  vAdvWP = (modelMatrix * vec4(position, 1.0)).xyz;
  vAdvN = normalize(mat3(modelMatrix) * normal);
`;

const ADV_FRAG_HEAD = `
uniform float uFxTime;
uniform float uFxScale;
uniform float uFxAmp;
uniform vec3  uFxC1;
uniform vec3  uFxC2;
varying vec3 vAdvL;
varying vec3 vAdvWP;
varying vec3 vAdvN;
float advGlow = 0.0;

float advHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float advNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(advHash(i), advHash(i + vec2(1.0, 0.0)), f.x),
             mix(advHash(i + vec2(0.0, 1.0)), advHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float advFbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * advNoise(p); p *= 2.02; a *= 0.5; }
  return s;
}
`;

const ADV_FRAG_BODY = `
void advSurface(inout vec4 dc) {
  vec3 N = normalize(vAdvN);
  vec3 V = normalize(cameraPosition - vAdvWP);
  float fres = pow(1.0 - abs(dot(N, V)), 2.5);
  float t = uFxTime;
  float sc = uFxScale;
  vec3 c1 = uFxC1;
  vec3 c2 = uFxC2;
  vec2 uv = vAdvL.xz;
  float yl = vAdvL.y;
  vec3 pat = c1;
  float glow = 0.0;
  int fx = ADV_FX;

  if (fx == 0 || fx == 1) {                 // 六边形网格（力场 / 护盾）
    vec2 hp = uv * sc;
    vec2 h = vec2(1.0, 1.7320508);
    vec2 p1 = mod(hp, h) - h * 0.5;
    vec2 p2 = mod(hp + h * 0.5, h) - h * 0.5;
    vec2 gv = (dot(p1, p1) < dot(p2, p2)) ? p1 : p2;
    float d = max(abs(gv.y), abs(gv.x) * 0.866 + abs(gv.y) * 0.5);
    float border = smoothstep(0.34, 0.48, d);
    float pulse = 0.62 + 0.38 * sin(t * 2.0);
    glow = border * pulse * 1.15 + fres * (fx == 1 ? 1.30 : 0.95) * pulse;
    pat = mix(c2, c1, border);
  } else if (fx == 2) {                     // 全息投影：扫描线 + 闪烁
    float s = fract(yl * sc * 2.0 - t * 1.5);
    float lines = smoothstep(0.0, 0.32, s) * smoothstep(1.0, 0.68, s);
    float flick = 0.86 + 0.14 * sin(t * 24.0);
    glow = (0.30 + lines * 0.95) * flick + fres * 0.70;
    pat = mix(c2, c1, lines);
  } else if (fx == 3) {                     // 扫描线
    float s = fract(yl * sc * 1.5 - t * 0.8);
    float band = smoothstep(0.88, 1.0, s) + smoothstep(0.12, 0.0, s);
    glow = band * 1.15 + fres * 0.40;
  } else if (fx == 4) {                     // 发光网格
    vec2 g = abs(fract(uv * sc) - 0.5);
    float ln = smoothstep(0.44, 0.50, max(g.x, g.y));
    glow = ln * 1.10 + fres * 0.55;
  } else if (fx == 5) {                     // 电路板
    vec2 gp = uv * sc;
    vec2 cell = floor(gp);
    vec2 f = fract(gp);
    float h = advHash(cell);
    float horiz = step(0.5, h);
    float across = mix(f.x, f.y, horiz);
    float along = mix(f.y, f.x, horiz);
    float trace = (1.0 - smoothstep(0.06, 0.13, abs(across - 0.5)))
                * smoothstep(0.0, 0.14, along) * smoothstep(1.0, 0.86, along);
    float node = 1.0 - smoothstep(0.05, 0.15, length(f - vec2(0.5)));
    float pulse = 0.55 + 0.45 * sin(t * 3.0 - along * 6.0 + h * 6.28);
    glow = (trace + node) * pulse * 1.25 + fres * 0.30;
  } else if (fx == 6) {                     // 数据流
    vec2 gp = vec2(uv.x * sc, yl * sc * 0.35);
    float col = advHash(vec2(floor(gp.x), 0.0));
    float yy = fract(gp.y - t * (0.6 + col * 0.9));
    float seg = smoothstep(0.0, 0.10, yy) * smoothstep(0.55, 0.32, yy);
    glow = seg * step(0.35, col) * 1.45 + fres * 0.30;
    pat = mix(c2, c1, yy);
  } else if (fx == 7) {                     // 等离子 / 液态金属
    float n = advFbm(uv * sc + vec2(t * 0.35, t * 0.22));
    float n2 = advFbm(uv * sc * 2.3 - vec2(t * 0.28, t * 0.40));
    float v = pow(abs(sin((n + n2) * 6.2831 + t)), 1.6);
    glow = v * 1.30 + fres * 0.50;
    pat = mix(c2, c1, n2);
  } else if (fx == 8) {                     // 霓虹灯条
    float s = abs(fract(uv.y * sc) - 0.5) * 2.0;
    float bar = 1.0 - smoothstep(0.42, 0.74, s);
    float d = step(0.5, fract(uv.x * sc * 0.5));
    glow = bar * mix(0.55, 1.25, d) + fres * 0.60;
  } else if (fx == 9) {                     // 毒液
    float n = advFbm(uv * sc + vec2(0.0, -t * 0.30));
    float blobs = smoothstep(0.42, 0.72, n);
    glow = blobs * 1.00 + fres * 0.45;
    pat = mix(c2, c1, n);
  } else if (fx == 10) {                    // 熔岩裂纹
    vec2 gp = uv * sc;
    vec2 cell = floor(gp);
    vec2 f = fract(gp) - 0.5;
    vec2 off = vec2(advHash(cell + 3.1), advHash(cell + 7.7)) - 0.5;
    float crack = 1.0 - smoothstep(0.04, 0.24, length(f - off * 0.6));
    float n = advFbm(uv * sc * 1.7 + t * 0.15);
    float heat = clamp(crack * (0.55 + 0.90 * n), 0.0, 1.5);
    glow = heat * 1.60 + fres * 0.25;
    pat = mix(c2, c1, clamp(n + heat, 0.0, 1.0));
  } else if (fx == 11) {                    // 传送门漩涡
    float ang = atan(uv.y, uv.x);
    float rad = length(uv);
    float sw = fract(ang / 6.2831 + rad * sc * 0.35 - t * 0.35);
    float arms = smoothstep(0.0, 0.12, sw) * smoothstep(0.50, 0.38, sw);
    float fade = 1.0 - smoothstep(0.25, 0.62, rad);
    glow = arms * fade * 1.70 + fres * 0.60;
    pat = mix(c2, c1, sw);
  } else if (fx == 12) {                    // 幽魂
    float n = advFbm(uv * sc * 0.8 + vec2(t * 0.18, -t * 0.12));
    glow = (0.25 + n * 0.90) * (0.40 + fres * 1.10);
    pat = mix(c2, c1, n);
  } else if (fx == 13) {                    // 极光
    float n = advFbm(vec2(uv.x * sc * 0.6, yl * sc * 1.4 + t * 0.5));
    float band = pow(abs(sin(yl * sc * 3.2 + n * 3.5 - t * 0.6)), 3.0);
    glow = band * (0.30 + 0.85 * n) * 1.50;
    pat = mix(c2, c1, 0.5 + 0.5 * sin(yl * 4.0 * sc + t * 0.8 + n));
  } else if (fx == 14) {                    // 星际穿越
    float ang = (atan(uv.y, uv.x) / 6.2831 + 0.5) * 24.0;
    float rad = length(uv);
    float h = advHash(vec2(floor(ang), 0.0));
    float streak = (1.0 - smoothstep(0.0, 0.35, abs(fract(ang) - 0.5))) * step(0.45, h);
    float flow = smoothstep(0.0, 0.9, fract(rad * 1.6 - t * (1.5 + h)));
    glow = streak * flow * 1.60 + fres * 0.40;
  } else if (fx == 15) {                    // 数字故障
    float blk = floor(yl * sc * 3.0);
    float h = advHash(vec2(blk, floor(t * 7.0)));
    float band = step(0.62, h);
    vec2 guv = uv + vec2((advHash(vec2(blk, floor(t * 13.0))) - 0.5) * 0.25 * band, 0.0);
    float n = advFbm(guv * sc * 1.5);
    float off = step(0.55, advHash(vec2(floor(guv.x * sc * 3.0), blk)));
    glow = (band * 0.90 + off * 0.50) * (0.60 + n * 0.80) + fres * 0.40;
    pat = mix(c2, c1, step(0.5, advHash(vec2(blk, floor(t * 7.0) + 3.7))));
  } else if (fx == 16) {                    // 数据雨
    float cols = floor(uv.x * sc * 2.0);
    float h = advHash(vec2(cols, 0.0));
    float yy = fract(uv.y * 0.6 + t * (0.35 + h * 0.70) + h);
    float head = smoothstep(0.0, 0.08, yy) * smoothstep(0.50, 0.20, yy);
    float glyph = step(0.45, advHash(vec2(cols, floor(uv.y * 22.0 + t * 8.0))));
    glow = head * glyph * 1.50 + fres * 0.30;
  } else if (fx == 17) {                    // 虚空裂隙
    float n = advFbm(vec2(uv.x * sc * 1.1, yl * sc * 0.3 + t * 0.35));
    float dv = abs(n - 0.5);
    float tear = 1.0 - smoothstep(0.0, 0.05, dv);
    float halo = 1.0 - smoothstep(0.05, 0.28, dv);
    glow = tear * 1.60 + halo * 0.60 + fres * 0.50;
    pat = mix(c2, c1, halo);
  } else if (fx == 18) {                    // 彩虹薄膜（珍珠 / 油膜 / 镭射）
    float band = sin(fres * 12.0 * sc + t * 0.6 + yl * 4.0);
    vec3 rainbow = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + fres * 1.6 * sc + yl * 0.2));
    glow = (0.35 + 0.45 * band) * (0.35 + fres);
    pat = rainbow;
  } else if (fx == 19) {                    // 大理石纹
    float n = advFbm(uv * sc * 0.6);
    float vein = pow(abs(sin((uv.x + uv.y) * sc * 1.4 + n * 4.0)), 6.0);
    glow = vein * 0.80 + fres * 0.25;
    pat = mix(c2, c1, vein);
  } else if (fx == 20) {                    // 编织（碳纤维）
    float a = step(0.5, fract(uv.x * sc));
    float b = step(0.5, fract(uv.y * sc));
    float w = mix(a, b, step(0.5, fract((uv.x + uv.y) * sc)));
    glow = (0.35 + 0.40 * w) * 0.5 + fres * 0.30;
    pat = mix(c2, c1, w);
  } else if (fx == 21) {                    // 霜晶
    vec2 gp = uv * sc;
    vec2 cell = floor(gp);
    vec2 f = fract(gp) - 0.5;
    float ang = advHash(cell) * 6.2831;
    vec2 dir = vec2(cos(ang), sin(ang));
    float along = abs(dot(f, dir));
    float across = abs(dot(f, vec2(-dir.y, dir.x)));
    float crystal = (1.0 - smoothstep(0.03, 0.09, across)) * (1.0 - smoothstep(0.20, 0.42, along));
    glow = crystal * 0.90 + fres * 0.40;
  } else if (fx == 22) {                    // 迷彩
    float n1 = advFbm(uv * sc * 0.9);
    float n2 = advFbm(uv * sc * 0.9 + 5.2);
    vec3 col = mix(c2, c1, step(0.5, n1));
    pat = mix(dc.rgb, col, 0.75);
    glow = step(0.48, n1 + n2 * 0.35) * 0.18;
  } else if (fx == 23) {                    // 圆点矩阵
    vec2 f = fract(uv * sc) - 0.5;
    glow = (1.0 - smoothstep(0.24, 0.30, length(f))) * 0.90 + fres * 0.40;
  } else if (fx == 24) {                    // 条纹（拉丝 / 装饰条）
    float s = abs(fract((uv.x + uv.y) * sc) - 0.5) * 2.0;
    float band = 1.0 - smoothstep(0.35, 0.55, s);
    pat = mix(c2, c1, band);
    glow = band * 0.25 + fres * 0.35;
  } else if (fx == 25) {                    // 丝绒
    float n = advFbm(uv * sc * 1.6);
    glow = (0.15 + n * 0.30) * fres * 1.40;
    pat = mix(c2, c1, fres);
  } else if (fx == 26) {                    // 梦核
    float n = advFbm(uv * sc * 0.7 + vec2(t * 0.08, t * 0.05));
    float g = 0.5 + 0.5 * sin((uv.x + uv.y) * sc * 1.2 + n * 5.0 + t * 0.4);
    pat = mix(c1, c2, g);
    glow = (0.30 + g * 0.60) * (0.40 + fres * 0.90);
  } else {                                  // 27 怪核
    float n = advFbm(uv * sc + vec2(t * 0.20, -t * 0.15));
    float ring = 1.0 - smoothstep(0.0, 0.18, abs(fract(n * 5.0) - 0.5));
    float scan = step(0.5, fract(yl * sc * 2.0 + t * 0.7));
    glow = ring * 0.80 + scan * 0.25 + fres * 0.50;
    pat = mix(c1, c2, ring);
  }

  advGlow = clamp(glow, 0.0, 2.0);
  dc.rgb = mix(dc.rgb, pat, clamp(advGlow, 0.0, 1.0) * uFxAmp);
  dc.a *= clamp(0.82 + fres * 0.5, 0.0, 1.0);   // 掠射角稍实一点，边缘更像实体
}
`;

/**
 * 把图案注入到标准材质的着色器里
 * @param mat 目标材质（会被就地打补丁）
 * @param p   对象属性
 */
export function applyAdvancedShader(mat, p) {
  if (advIsGlass(p.advMat)) return applyGlassShader(mat, p);
  const fx = advFxIndex(p.advMat);
  if (fx < 0) return mat;
  const scale = Math.max(0.05, Number(p.fxScale ?? 1) || 1);
  const amp = Math.max(0, Number(p.fxAmp ?? 0.8) || 0);
  const c1 = new THREE.Color(p.emissive && p.emissive !== '#000000' ? p.emissive : (p.color || '#ffffff'));
  const c2 = new THREE.Color(p.fxColor || '#000000');
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFxTime = ADV_UNIFORMS.time;
    shader.uniforms.uFxScale = { value: scale };
    shader.uniforms.uFxAmp = { value: amp };
    shader.uniforms.uFxC1 = { value: c1 };
    shader.uniforms.uFxC2 = { value: c2 };
    shader.vertexShader = 'varying vec3 vAdvL;\nvarying vec3 vAdvWP;\nvarying vec3 vAdvN;\n'
      + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + ADV_VERT_CHUNK);
    shader.fragmentShader = 'const int ADV_FX = ' + fx + ';\n'
      + shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + ADV_FRAG_HEAD + ADV_FRAG_BODY)
        .replace('#include <color_fragment>', '#include <color_fragment>\n  advSurface(diffuseColor);')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n  totalEmissiveRadiance += uFxC1 * advGlow * uFxAmp;');
  };
  // 同一材质外观但图案不同 → 必须是不同的着色器程序
  mat.customProgramCacheKey = () => 'adv' + fx;
  return mat;
}

/* ============================================================
   玻璃 · 屏幕空间折射 / 反射（半分辨率缓冲）
   ------------------------------------------------------------
   每帧主渲染前，把「不含玻璃的场景」渲进一张半分辨率缓冲（颜色 + 深度），
   玻璃片元按屏幕坐标采样它：
     · 折射：refract(-V, N, 1/ior) 从玻璃表面外推一小段距离 → 投影回屏幕得到采样偏移
     · 色散：R / G / B 用略微不同的折射率各采一条通道 → 边缘彩色分离
     · 反射：reflect(-V, N) 同样投影出偏移后采样（屏幕空间反射）
     · 吸收：由深度缓冲还原「背景深度 − 玻璃表面深度」得到厚度，Beer-Lambert 边缘吸光
     · 菲涅尔：掠射角反射占比更高
   缓冲不可用时（尚未捕获 / 关卡里没有玻璃）退回标准材质的 PBR 反射，保证玻璃始终可见。
   ============================================================ */
const _glClamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* 半分辨率屏幕空间缓冲：所有玻璃材质共享同一组 uniform 对象（逐帧只写一次） */
export const GLASS_SS = {
  color: { value: null },                    // 半分辨率场景颜色（线性 HDR）
  depth: { value: null },                    // 半分辨率场景深度
  proj: { value: new THREE.Matrix4() },      // 主相机投影矩阵（片元着色器默认不提供）
  near: { value: 0.1 },
  far: { value: 6000 },
  amount: { value: 0 },                      // 1 = 缓冲可用；0 = 退回标准材质 PBR
};

/* 兜底反射用的一次性场景立方体贴图分辨率（镜像 / 镀铬等高级材质的 IBL 也用它） */
const CAPTURE_SIZE = 1024;

/** 取渲染器支持的最大各向异性过滤等级 */
function _maxAniso(renderer) {
  try {
    const c = renderer && renderer.capabilities;
    return Math.max(1, (c && c.getMaxAnisotropy && c.getMaxAnisotropy()) || 1);
  } catch (e) { return 1; }
}

const GLASS_VERT_CHUNK = `
  vGlassWP = (modelMatrix * vec4(position, 1.0)).xyz;
  vGlassN = normalize(mat3(modelMatrix) * normal);
`;

const GLASS_FRAG_PARS = `
uniform sampler2D uSSColor;
uniform sampler2D uSSDepth;
uniform mat4  uProj;
uniform float uCamNear;
uniform float uCamFar;
uniform float uSSAmount;         // 1 = 半分辨率屏幕空间缓冲可用
uniform float uGlassIor;
uniform float uGlassAbsorb;
uniform float uGlassClarity;
uniform float uGlassThick;       // 折射 / 反射采样外推距离（世界单位）
uniform float uGlassDispersion;  // 色散强度（RGB 折射率差）
uniform vec3  uGlassTint;
varying vec3 vGlassWP;
varying vec3 vGlassN;

/* 透视深度 [0,1] → 视图空间线性距离 */
float glassLinDepth(float d) {
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uCamNear * uCamFar) / (uCamFar + uCamNear - ndc * (uCamFar - uCamNear));
}

/* 世界点 → 屏幕 uv；点在相机后方（w <= 0）时返回 z = -1 作为无效标记 */
vec3 glassProj(vec3 wp) {
  vec4 c = uProj * (viewMatrix * vec4(wp, 1.0));
  if (c.w <= 1e-4) return vec3(0.0, 0.0, -1.0);
  return vec3(c.xy / c.w * 0.5 + 0.5, 1.0);
}
`;

/* 插在 <opaque_fragment> 之前：用屏幕空间采样结果替换标准光照输出。
   outgoingLight 在此处已算好（标准 PBR：环境反射 + 高光 + 自发光），作为兜底反射。 */
const GLASS_FRAG_BODY = `
{
  vec3 gN = normalize(vGlassN);
  vec3 gV = normalize(cameraPosition - vGlassWP);
  float gNdV = clamp(dot(gN, gV), 0.0, 1.0);
  float gF0 = pow((uGlassIor - 1.0) / (uGlassIor + 1.0), 2.0);
  float gF = clamp(gF0 + (1.0 - gF0) * pow(1.0 - gNdV, 5.0), 0.0, 1.0);

  vec3 gRefl = outgoingLight;      // 兜底反射（缓冲不可用时）
  vec3 gRefr = outgoingLight;
  float gThick = 0.0;

  if (uSSAmount > 0.5) {
    vec3 pj = glassProj(vGlassWP);
    vec2 uvP = pj.xy;
    /* 采样外推距离：反射路与折射路分开
       —— 折射路的位移由「折射率」直接驱动：ior 越大，折射弯折越强、屏幕偏移越大。
          空气 1.0 几乎不弯；1.33 水偏弱；1.5 玻璃中等；2.0~2.4 水晶 / 钻石明显 */
    float iorK = max(uGlassIor, 1.0);
    float reflDist = max(uGlassThick, 0.01);
    float refrDist = reflDist * (0.25 + (iorK - 1.0) * 3.0);
    vec2 lo = vec2(0.001);
    vec2 hi = vec2(0.999);

    /* ---- 反射：屏幕空间反射 ---- */
    vec3 rj = glassProj(vGlassWP + reflect(-gV, gN) * reflDist);
    vec2 reflOff = rj.z > 0.0 ? (rj.xy - uvP) : vec2(0.0);
    gRefl = texture2D(uSSColor, clamp(uvP + reflOff, lo, hi)).rgb;

    /* ---- 折射 + 色散：R / G / B 三路不同折射率各采一条通道 ---- */
    float dsp = max(uGlassDispersion, 0.0);
    vec3 vR = refract(-gV, gN, 1.0 / max(iorK * (1.0 - dsp), 1.0));
    vec3 vG = refract(-gV, gN, 1.0 / max(iorK, 1.0));
    vec3 vB = refract(-gV, gN, 1.0 / max(iorK * (1.0 + dsp), 1.0));
    if (dot(vG, vG) < 1e-6) { vG = -gV; }            // 全反射：退回直射方向
    if (dot(vR, vR) < 1e-6) { vR = vG; }
    if (dot(vB, vB) < 1e-6) { vB = vG; }
    vec3 jR = glassProj(vGlassWP + vR * refrDist);
    vec3 jG = glassProj(vGlassWP + vG * refrDist);
    vec3 jB = glassProj(vGlassWP + vB * refrDist);
    vec2 oR = jR.z > 0.0 ? (jR.xy - uvP) : vec2(0.0);
    vec2 oG = jG.z > 0.0 ? (jG.xy - uvP) : vec2(0.0);
    vec2 oB = jB.z > 0.0 ? (jB.xy - uvP) : vec2(0.0);
    vec3 cR = texture2D(uSSColor, clamp(uvP + oR, lo, hi)).rgb;
    vec3 cG = texture2D(uSSColor, clamp(uvP + oG, lo, hi)).rgb;
    vec3 cB = texture2D(uSSColor, clamp(uvP + oB, lo, hi)).rgb;
    gRefr = vec3(cR.r, cG.g, cB.b);

    /* ---- 厚度：背景深度 − 玻璃表面深度（做体积吸收用） ---- */
    float zGlass = glassLinDepth(gl_FragCoord.z);
    float zBack = glassLinDepth(texture2D(uSSDepth, clamp(uvP + oG, lo, hi)).r);
    gThick = clamp(zBack - zGlass, 0.0, 4000.0);
  }

  /* ---- 体积吸收：厚度 + 掠射光程 → 边缘更暗 / 更染色 ---- */
  float gPath = gThick * 0.10 + 1.0 / max(gNdV, 0.15);
  vec3 gTransmit = exp(-(vec3(1.0) - uGlassTint) * (uGlassAbsorb * 0.9 * gPath));
  vec3 gMilky = uGlassTint * 0.35 + vec3(0.05);
  vec3 gBody = mix(gMilky, gRefr * gTransmit, clamp(uGlassClarity, 0.0, 1.0));
  vec3 gGlass = mix(gBody, gRefl, gF);

  outgoingLight = mix(outgoingLight, gGlass, clamp(uGlassClarity * 0.3 + 0.7, 0.0, 1.0));
  diffuseColor.a = 1.0;   // 采样结果 ≈ 背景，按不透明输出（避免半透明排序互相遮挡）
}
`;

/**
 * 把玻璃屏幕空间折射 / 反射注入到标准材质里
 * @param mat 目标材质（会被就地打补丁）
 * @param p   对象属性
 */
export function applyGlassShader(mat, p) {
  const ior = _glClamp(Number(p.ior) || 1.5, 1.0, 2.5);
  const absorb = _glClamp(Number(p.glassAbsorb) || 0, 0, 1);
  const clarity = _glClamp(Number(p.transparency) || 0, 0, 1);
  const tint = new THREE.Color(p.color || '#ffffff');
  const rough = _glClamp(Number(p.roughness) || 0, 0, 1);
  // 色散强度随折射率增大（空气无感、钻石明显）
  const dispersion = _glClamp((ior - 1.0) * 0.05, 0.0, 0.08);
  // 基准采样外推距离（反射用）；折射路会在着色器里再按折射率放大
  const thick = _glClamp(1.5 + rough * 5.0 + (ior - 1.0) * 1.5, 1.0, 8.0);
  mat.onBeforeCompile = (shader) => {
    // 半分辨率屏幕空间缓冲：共享 uniform，逐帧由 renderGlassCapture 写入
    shader.uniforms.uSSColor = GLASS_SS.color;
    shader.uniforms.uSSDepth = GLASS_SS.depth;
    shader.uniforms.uProj = GLASS_SS.proj;
    shader.uniforms.uCamNear = GLASS_SS.near;
    shader.uniforms.uCamFar = GLASS_SS.far;
    shader.uniforms.uSSAmount = GLASS_SS.amount;
    shader.uniforms.uGlassIor = { value: ior };
    shader.uniforms.uGlassAbsorb = { value: absorb };
    shader.uniforms.uGlassClarity = { value: clarity };
    shader.uniforms.uGlassTint = { value: tint };
    shader.uniforms.uGlassThick = { value: thick };
    shader.uniforms.uGlassDispersion = { value: dispersion };
    shader.vertexShader = 'varying vec3 vGlassWP;\nvarying vec3 vGlassN;\n'
      + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + GLASS_VERT_CHUNK);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLASS_FRAG_PARS)
      .replace('#include <opaque_fragment>', GLASS_FRAG_BODY + '\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'advglass';
  return mat;
}

/* ============================================================
   一次性场景反射
   - 关卡加载后渲 6 个面一次，得到全关卡共用的一张立方体贴图
   - 运行时零开销：所有高级材质直接采样它做「简单的一次反射」
   - 捕获时临时隐藏需要反射的物体自身与编辑辅助体，避免自我遮挡
   ============================================================ */
let _rt = null;
let _cam = null;
let _tex = null;
let _pmRT = null;      // 由立方体捕获生成的 PMREM 结果（材质真正用的是它）
const _subs = [];

export function getReflectionTexture() { return _tex; }

/** 订阅反射贴图变化（材质缓存用它把新贴图刷到已有材质上） */
export function onReflectionChange(fn) { _subs.push(fn); }

export function setReflectionTexture(tex) {
  _tex = tex || null;
  for (const fn of _subs) { try { fn(_tex); } catch (e) { /* ignore */ } }
}

/**
 * 捕获场景反射
 * @param renderer WebGLRenderer
 * @param scene    要捕获的场景
 * @param center   捕获点（一般取关卡包围盒中心）
 * @param radius   捕获范围（决定近远裁剪面）
 * @returns 立方体贴图（失败返回 null）
 */
export function captureReflections(renderer, scene, center, radius) {
  if (!renderer || !scene) return null;
  try {
    if (!_rt) {
      _rt = new THREE.WebGLCubeRenderTarget(CAPTURE_SIZE, {
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
      _cam = new THREE.CubeCamera(0.5, 8000, _rt);
    }
    // 各向异性过滤：这是「消锯齿 + 去糊」的关键 —— 掠射角沿射线各向压缩采样，
    // 既不会选到过高 mip 层级糊掉，也不会因欠采样产生锯齿
    _rt.texture.anisotropy = _maxAniso(renderer);
    const c = center || { x: 0, y: 0, z: 0 };
    const r = Math.max(1, Number(radius) || 1);
    _cam.position.set(c.x, c.y, c.z);
    // CubeCamera 自身没有 near / far / updateProjectionMatrix，裁剪范围要设到它的 6 个子相机上
    const cNear = 0.5;
    const cFar = Math.max(600, r * 4 + 400);
    for (const sub of _cam.children) {
      sub.near = cNear;
      sub.far = cFar;
      sub.updateProjectionMatrix();
    }
    _cam.updateMatrixWorld(true);

    // 捕获前临时隐藏编辑辅助体（网格 / 坐标轴等），别让它们出现在反射里
    const hidden = [];
    scene.traverse((x) => {
      if (!x.visible) return;
      if ((x.userData || {}).helper) { hidden.push(x); x.visible = false; }
    });
    _cam.update(renderer, scene);
    for (const x of hidden) x.visible = true;

    // 立方体纹理必须过一遍 PMREM 才能被标准材质当作 IBL 采样
    // （three 的 getIBLRadiance / getIBLIrradiance 只在 ENVMAP_TYPE_CUBE_UV 下生效）
    const pm = new THREE.PMREMGenerator(renderer);
    pm.compileCubemapShader();
    const pmrt = pm.fromCubemap(_rt.texture);
    pm.dispose();
    if (_pmRT) _pmRT.dispose();
    _pmRT = pmrt;
    setReflectionTexture(_pmRT.texture);
    return _pmRT.texture;
  } catch (e) {
    console.warn('[advanced-materials] 场景反射捕获失败，高级材质将退回天空 IBL', e);
    return null;
  }
}

/** 释放反射 / 折射资源（切场景时调用） */
export function disposeReflections() {
  setReflectionTexture(null);
  disposeGlassCapture();
  if (_pmRT) { _pmRT.dispose(); _pmRT = null; }
  if (_rt) { _rt.dispose(); _rt = null; _cam = null; }
}

/* ============================================================
   玻璃屏幕空间缓冲捕获（半分辨率）
   - 每帧主渲染前调用一次：把「不含玻璃的场景」渲进半分辨率缓冲（颜色 + 深度）
   - 玻璃材质逐帧只采样这张缓冲，不额外做 CubeCamera / PMREM
   - 缓冲不可用时 GLASS_SS.amount = 0 → 玻璃退回标准材质的 PBR 反射（始终可见）
   - 玻璃网格列表每次从 builder 对象表直接筛（o.advMat 为玻璃），不遍历场景
   ============================================================ */
let _ssRT = null;
const _ssSize = new THREE.Vector2();
const _glassMeshes = [];   // 复用数组，避免每帧新建

/** 收集场景里所有使用玻璃材质的网格（优先走 builder，退化为遍历场景） */
function _collectGlassMeshes(scene, builder, out) {
  out.length = 0;
  if (builder && builder.objects) {
    for (const rec of builder.objects.values()) {
      if (!rec || !rec.o || !advIsGlass(rec.o.advMat)) continue;
      const list = rec.meshes || (rec.mesh ? [rec.mesh] : null);
      if (!list) continue;
      for (const m of list) if (m) out.push(m);
    }
    return out;
  }
  scene.traverse((n) => {
    const m = n.material;
    if (!m) return;
    if (Array.isArray(m)) {
      for (const mm of m) {
        if (mm && mm.userData && advIsGlass(mm.userData.advMat)) { out.push(n); return; }
      }
    } else if (m.userData && advIsGlass(m.userData.advMat)) {
      out.push(n);
    }
  });
  return out;
}

/**
 * 渲染半分辨率屏幕空间折射缓冲（主渲染前调用）
 * @param renderer WebGLRenderer
 * @param scene    场景
 * @param camera   主相机（与后续主渲染同一台）
 * @param builder  场景构建器（用于快速取玻璃网格列表；可省略）
 * @returns 本帧缓冲是否可用
 */
export function renderGlassCapture(renderer, scene, camera, builder) {
  if (!renderer || !scene || !camera) { GLASS_SS.amount.value = 0; return false; }
  const list = _collectGlassMeshes(scene, builder, _glassMeshes);
  if (!list.length) { GLASS_SS.amount.value = 0; return false; }

  // 半分辨率缓冲：颜色线性 HDR（half float）+ 深度（供厚度 / 吸收用）
  const size = renderer.getDrawingBufferSize(_ssSize);
  const w = Math.max(2, Math.floor(size.x * 0.5));
  const h = Math.max(2, Math.floor(size.y * 0.5));
  if (!_ssRT || _ssRT.width !== w || _ssRT.height !== h) {
    if (_ssRT) _ssRT.dispose();
    _ssRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthTexture: new THREE.DepthTexture(w, h),
    });
    _ssRT.texture.colorSpace = THREE.NoColorSpace;
  }

  // 捕获时隐藏玻璃自身（避免自我遮挡），阴影沿用在主渲染里已算好的一套
  const was = [];
  for (const m of list) { was.push(m.visible); m.visible = false; }
  const prevAuto = renderer.autoClear;
  const prevShadowAuto = renderer.shadowMap.autoUpdate;
  renderer.autoClear = true;
  renderer.shadowMap.autoUpdate = false;   // 复用上一帧阴影贴图，避免捕获再渲一遍阴影
  renderer.setRenderTarget(_ssRT);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.shadowMap.autoUpdate = prevShadowAuto;
  renderer.autoClear = prevAuto;
  for (let i = 0; i < list.length; i++) list[i].visible = was[i];

  // 写入共享 uniform（所有玻璃材质引用同一组对象）
  GLASS_SS.color.value = _ssRT.texture;
  GLASS_SS.depth.value = _ssRT.depthTexture;
  GLASS_SS.proj.value.copy(camera.projectionMatrix);
  GLASS_SS.near.value = camera.near;
  GLASS_SS.far.value = camera.far;
  GLASS_SS.amount.value = 1;
  return true;
}

/** 释放半分辨率屏幕空间缓冲 */
export function disposeGlassCapture() {
  GLASS_SS.color.value = null;
  GLASS_SS.depth.value = null;
  GLASS_SS.amount.value = 0;
  if (_ssRT) { _ssRT.dispose(); _ssRT = null; }
}
