/* ============================================================
   程序化天空球生成 / 烘焙（Sky Lab 引擎）
   ------------------------------------------------------------
   · 一块全屏四边形 + 单个 GLSL 片元着色器，一次算出 2:1 等距柱状全景
   · 模块化：大气散射 / 云 / 星空 / 天体(太阳·月亮) / 自定义图案分布 /
     71 种天空纹理 shader / 真实光学（泛光·地平线霾·镜头光晕·星芒·色调映射·暗角·色差）
   · 全部颜色可自定义；输出线性光经色调映射后再做 sRGB 编码，
     可直接当 equirect 天空盒使用，或导出 PNG
   ============================================================ */
import * as THREE from './three-ns.js';

/* ---------- 71 种「天空纹理」shader（uTexId 索引，见片元着色器 texPattern） ---------- */
export const SKY_TEXTURES = [
  { id: 0, label: '纯净' },
  { id: 1, label: '天顶渐变' },
  { id: 2, label: '双向渐变' },
  { id: 3, label: '三段渐变' },
  { id: 4, label: '五段色阶' },
  { id: 5, label: '硬边色带' },
  { id: 6, label: '密集横纹' },
  { id: 7, label: '细密竖纹' },
  { id: 8, label: '斜条纹' },
  { id: 9, label: '反向斜纹' },
  { id: 10, label: '棋盘' },
  { id: 11, label: '细棋盘' },
  { id: 12, label: '圆点阵' },
  { id: 13, label: '大圆点' },
  { id: 14, label: '同心圆' },
  { id: 15, label: '放射线' },
  { id: 16, label: '极坐标波纹' },
  { id: 17, label: '万花筒' },
  { id: 18, label: '螺旋' },
  { id: 19, label: '双螺旋' },
  { id: 20, label: '正弦波带' },
  { id: 21, label: '双频叠加' },
  { id: 22, label: '同心涟漪' },
  { id: 23, label: '值噪声' },
  { id: 24, label: '分形噪声' },
  { id: 25, label: '湍流' },
  { id: 26, label: '山脊' },
  { id: 27, label: '扭曲噪声' },
  { id: 28, label: '云絮' },
  { id: 29, label: '大理石' },
  { id: 30, label: '木纹' },
  { id: 31, label: '裂纹' },
  { id: 32, label: '细胞' },
  { id: 33, label: '菱形晶格' },
  { id: 34, label: '砖格' },
  { id: 35, label: '三角格' },
  { id: 36, label: '摩尔纹' },
  { id: 37, label: '干涉环' },
  { id: 38, label: '等离子' },
  { id: 39, label: '电流' },
  { id: 40, label: '经纬网' },
  { id: 41, label: '赤道光带' },
  { id: 42, label: '极冠' },
  { id: 43, label: '半球分割' },
  { id: 44, label: '象限色块' },
  { id: 45, label: '随机方块' },
  { id: 46, label: '哈希亮点' },
  { id: 47, label: '抖动噪点' },
  { id: 48, label: '点阵渐变' },
  { id: 49, label: '条纹位移' },
  { id: 50, label: '波纹畸变' },
  { id: 51, label: '极光幕' },
  { id: 52, label: '极光辉' },
  { id: 53, label: '光柱' },
  { id: 54, label: '地平线雾' },
  { id: 55, label: '星空底' },
  { id: 56, label: '星云洗' },
  { id: 57, label: '光斑' },
  { id: 58, label: '分形条纹' },
  { id: 59, label: '阶梯渐变' },
  { id: 60, label: '抖动渐变' },
  { id: 61, label: '晶格' },
  { id: 62, label: '波纹网格' },
  { id: 63, label: '网格噪声' },
  { id: 64, label: '斑驳' },
  { id: 65, label: '云顶' },
  { id: 66, label: '熔岩纹' },
  { id: 67, label: '回声环' },
  { id: 68, label: '单光晕' },
  { id: 69, label: '双光晕' },
  { id: 70, label: '波纹极光' },
];

/* ---------- 自定义空中图案分布的图案类型 ---------- */
export const PATTERN_TYPES = [
  { id: 0, label: '方格阵列' },
  { id: 1, label: '圆点阵列' },
  { id: 2, label: '同心环' },
  { id: 3, label: '螺旋' },
  { id: 4, label: '波浪线' },
  { id: 5, label: '随机散布' },
  { id: 6, label: '花瓣' },
  { id: 7, label: '涟漪' },
];

/* ---------- 图案分布范围 ---------- */
export const PATTERN_DISTS = [
  { id: 0, label: '全球' },
  { id: 1, label: '上半球' },
  { id: 2, label: '赤道带' },
  { id: 3, label: '两极区' },
];

/* ---------- 色调映射 ---------- */
export const TONE_MODES = [
  { id: 0, label: '线性截断' },
  { id: 1, label: 'Reinhard' },
  { id: 2, label: '指数' },
  { id: 3, label: 'ACES 电影' },
];

/** 全部可调参数默认值（键名与着色器 uniform 一一对应） */
export const SKY_DEFAULTS = {
  seed: 7,

  /* 天空纹理 shader */
  texId: 2, texAmt: 0.0, texA: '#1b1840', texB: '#e8a7c8',

  /* 大气 */
  atmAmt: 0.65, density: 1.0, rayleigh: 1.0, mie: 0.6, mieG: 0.76, turbidity: 2.2,
  zenith: '#2a2350', horizon: '#e8a7c8', ground: '#191634',

  /* 云 */
  cloudOn: 1, cloudCover: 0.45, cloudDensity: 1.0, cloudSharp: 0.28,
  cloudAlt: 0.35, cloudScale: 1.6, cloudLit: '#ffd9b8', cloudDark: '#4b3f7d', cloudSilver: 0.5,

  /* 星空 */
  starOn: 1, starDensity: 0.22, starBright: 1.0, starSize: 0.18,
  starColor: '#ffffff', nebula: 0.3, nebulaColor: '#8f7bb8', milkyWay: 0.35,

  /* 天体 */
  sunOn: 1, sunAz: 138, sunEl: 9, sunSize: 1.6, sunColor: '#fff0c8', sunGlow: 1.0,
  moonOn: 0, moonAz: 228, moonEl: 34, moonSize: 3.2, moonPhase: 0.35, moonColor: '#d8e4ff', moonGlow: 0.7,

  /* 自定义空中图案 */
  patOn: 0, patType: 0, patCount: 8, patSize: 0.3, patAlpha: 0.5,
  patRot: 0, patDist: 0, patColor: '#ffffff',

  /* 真实光学 */
  exposure: 1.15, contrast: 1.05, saturation: 1.05, tone: 3,
  haze: 0.4, hazeColor: '#ffd9b8',
  chroma: 0.0, vignette: 0.28, flare: 0.35, spikes: 0.35,

  /* 昼夜：hour 只参与 JS 侧推导（天体位置 / 天空亮度），不直接进着色器。
     默认 6.4 时 ≈ 太阳仰角 9°，与下面调的这套「低阳黄昏」预设一致 */
  hour: 6.4, bright: 1,
};

/* ============================================================
   着色器
   ============================================================ */
const VERT = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

varying vec2 vUv;

uniform vec2  uRes;
uniform float uSeed;

uniform vec3  uSunDir;
uniform vec3  uMoonDir;

uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform float uAtmAmt;
uniform float uDensity;
uniform float uRayleigh;
uniform float uMie;
uniform float uMieG;
uniform float uTurbidity;

uniform float uCloudOn;
uniform float uCloudCover;
uniform float uCloudDensity;
uniform float uCloudSharp;
uniform float uCloudAlt;
uniform float uCloudScale;
uniform float uCloudSilver;
uniform vec3  uCloudLit;
uniform vec3  uCloudDark;

uniform float uStarOn;
uniform float uStarDensity;
uniform float uStarBright;
uniform float uStarSize;
uniform float uNebula;
uniform float uMilkyWay;
uniform vec3  uStarColor;
uniform vec3  uNebulaColor;

uniform float uSunOn;
uniform float uSunSize;
uniform float uSunGlow;
uniform vec3  uSunColor;
uniform float uMoonOn;
uniform float uMoonSize;
uniform float uMoonPhase;
uniform float uMoonGlow;
uniform vec3  uMoonColor;

uniform int   uPatType;
uniform float uPatOn;
uniform float uPatCount;
uniform float uPatSize;
uniform float uPatAlpha;
uniform float uPatRot;
uniform float uPatDist;
uniform vec3  uPatColor;

uniform int   uTexId;
uniform float uTexAmt;
uniform vec3  uTexA;
uniform vec3  uTexB;

uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform int   uTone;
uniform float uHaze;
uniform vec3  uHazeColor;
uniform float uChroma;
uniform float uVignette;
uniform float uFlare;
uniform float uSpikes;
uniform float uBright;

const float PI = 3.141592653589793;

/* ---------- 噪声 ---------- */
float hash11(float p){ p = fract(p*0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
float hash31(vec3 p){ p = fract(p*0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y)*p.z); }

float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0 - 2.0*f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++){ s += a*vnoise(p); p = p*2.03 + 17.3; a *= 0.5; }
  return s;
}
float ridged(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++){
    float n = 1.0 - abs(vnoise(p)*2.0 - 1.0);
    s += a*n*n; p = p*2.03 + 7.1; a *= 0.5;
  }
  return s;
}

/* ---------- 等距柱状坐标 <-> 方向 ---------- */
/* 方向 ↔ 等距柱状 UV：严格对齐 three.js 的 equirect 采样约定
   （u = atan(z,x)/2π+0.5，v = asin(y)/π+0.5；贴图默认 flipY → 「画面上方 = 天顶」）。
   注意：quad 的 uv.y = 1 在画面顶部，所以 lat 必须随 uv.y 增大 —— 以前这里取了反号，
   烘焙出的全景图（含实时同步）整体上下颠倒。 */
vec3 dirFromUv(vec2 uv){
  float lon = (uv.x*2.0 - 1.0)*PI;
  float lat = (uv.y - 0.5)*PI;
  float cl = cos(lat);
  return normalize(vec3(cl*cos(lon), sin(lat), cl*sin(lon)));
}
vec2 uvFromDir(vec3 d){
  float lon = atan(d.z, d.x);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  return vec2(lon/(2.0*PI) + 0.5, lat/PI + 0.5);
}
vec3 sphDir(float azDeg, float elDeg){
  float az = radians(azDeg), el = radians(elDeg);
  return normalize(vec3(cos(el)*sin(az), sin(el), cos(el)*cos(az)));
}

/* ---------- 基础渐变（用户自定义颜色） ---------- */
vec3 skyGradient(vec3 rd){
  if (rd.y >= 0.0) return mix(uHorizon, uZenith, pow(clamp(rd.y, 0.0, 1.0), 0.45));
  return mix(uHorizon, uGround, pow(clamp(-rd.y, 0.0, 1.0), 0.5));
}

/* ---------- 大气：解析拟合（Roblox 风格，单次求值、无光线步进） ---------- */
vec3 scattering(vec3 rd, vec3 sd){
  float sunUp = clamp(sd.y, 0.0, 1.0);
  float mu    = max(0.0, dot(rd, sd));
  float ray   = clamp(uRayleigh, 0.0, 3.0);
  float mie   = clamp(uMie, 0.0, 3.0);
  float turb  = clamp(uTurbidity, 0.0, 8.0);
  float dens  = clamp(uDensity, 0.05, 3.0);

  float hz = exp(-max(rd.y, 0.0)/0.30);          // 地平线权重：越贴近地平线空气越厚

  /* 瑞利：天顶偏蓝，靠近地平线变厚 */
  vec3 rayC = vec3(0.24, 0.48, 1.00)*ray*dens*(0.30 + 0.70*hz);

  /* 米氏：太阳周围的白色散射光晕，各向异性靠指数收窄 */
  float g    = clamp(uMieG, 0.0, 0.95);
  float halo = pow(mu, 3.0 + 13.0*g);
  vec3  mieC = vec3(1.00, 0.97, 0.92)*mie*turb*(0.16 + 1.7*halo);

  /* 日落红化：太阳越低，瑞利项越暖，且集中在低空 */
  float dusk = clamp((1.0/(sunUp + 0.16) - 1.0)*0.85, 0.0, 1.0)*hz;
  rayC = mix(rayC, rayC*vec3(1.35, 0.62, 0.34), dusk);

  return (rayC + mieC)*(1.0 + 1.6*hz)*clamp(uAtmAmt, 0.0, 2.0)*0.9;
}

/* ---------- 71 种天空纹理 shader ---------- */
float texPattern(int id, vec2 uv){
  float n1 = fbm(uv*3.0 + uSeed);
  float n2 = fbm(uv*7.3 - uSeed*1.7);
  float n3 = ridged(uv*4.7 + uSeed*2.3);
  float t = 0.0;
  if (id == 0)       t = 0.0;
  else if (id == 1)  t = uv.y;
  else if (id == 2)  t = abs(uv.y*2.0 - 1.0);
  else if (id == 3)  t = smoothstep(0.0, 0.55, uv.y);
  else if (id == 4)  t = floor(uv.y*5.0)*0.25;
  else if (id == 5)  t = step(0.5, fract(uv.y*6.0));
  else if (id == 6)  t = step(0.5, fract(uv.y*24.0));
  else if (id == 7)  t = step(0.5, fract(uv.x*24.0));
  else if (id == 8)  t = step(0.5, fract((uv.x + uv.y)*12.0));
  else if (id == 9)  t = step(0.5, fract((uv.x - uv.y)*12.0));
  else if (id == 10) t = step(0.5, fract(uv.x*12.0))*step(0.5, fract(uv.y*6.0))
                     + (1.0 - step(0.5, fract(uv.x*12.0)))*(1.0 - step(0.5, fract(uv.y*6.0)));
  else if (id == 11) t = step(0.5, fract(uv.x*40.0))*step(0.5, fract(uv.y*20.0))
                     + (1.0 - step(0.5, fract(uv.x*40.0)))*(1.0 - step(0.5, fract(uv.y*20.0)));
  else if (id == 12) t = smoothstep(0.45, 0.20, length(fract(vec2(uv.x*24.0, uv.y*12.0)) - 0.5));
  else if (id == 13) t = smoothstep(0.45, 0.18, length(fract(vec2(uv.x*6.0, uv.y*3.0)) - 0.5));
  else if (id == 14) t = smoothstep(0.5, 0.0, abs(fract(length(uv - 0.5)*14.0) - 0.5));
  else if (id == 15) t = step(0.5, fract(atan(uv.y - 0.5, uv.x - 0.5)*12.0/PI));
  else if (id == 16) t = sin(length(uv - 0.5)*40.0)*0.5 + 0.5;
  else if (id == 17) t = sin(atan(uv.y - 0.5, uv.x - 0.5)*8.0 + length(uv - 0.5)*20.0)*0.5 + 0.5;
  else if (id == 18) t = fract(atan(uv.y - 0.5, uv.x - 0.5)/PI + length(uv - 0.5)*8.0);
  else if (id == 19) t = fract(atan(uv.y - 0.5, uv.x - 0.5)*2.0/PI + length(uv - 0.5)*16.0);
  else if (id == 20) t = sin(uv.y*20.0)*0.5 + 0.5;
  else if (id == 21) t = (sin(uv.y*18.0) + sin(uv.x*32.0))*0.25 + 0.5;
  else if (id == 22) t = sin(length(uv - vec2(0.5, 0.6))*60.0)*0.5 + 0.5;
  else if (id == 23) t = n1;
  else if (id == 24) t = fbm(uv*5.0 + uSeed);
  else if (id == 25) t = abs(n1*2.0 - 1.0);
  else if (id == 26) t = n3;
  else if (id == 27) t = fbm(uv*4.0 + vec2(n1*2.0, n2*2.0));
  else if (id == 28) t = smoothstep(0.42, 0.78, fbm(uv*6.0 + n2));
  else if (id == 29) t = sin((uv.x*6.0 + n1*3.0)*PI)*0.5 + 0.5;
  else if (id == 30) t = fract(uv.x*10.0 + n1*4.0);
  else if (id == 31) t = smoothstep(0.035, 0.0, abs(fbm(uv*8.0) - 0.5));
  else if (id == 32) t = smoothstep(0.40, 0.0, abs(n1 - 0.5));
  else if (id == 33) {
    float a = abs(fract(uv.x*10.0 + uv.y*10.0) - 0.5);
    float b = abs(fract(uv.x*10.0 - uv.y*10.0) - 0.5);
    t = smoothstep(0.62, 0.20, a + b);
  }
  else if (id == 34) t = step(0.5, fract(uv.y*10.0 + step(0.5, fract(uv.x*8.0))*0.5));
  else if (id == 35) t = step(0.5, fract((uv.x + uv.y)*16.0))*step(0.5, fract((uv.x - uv.y)*16.0));
  else if (id == 36) t = (sin(uv.x*40.0)*sin(uv.y*40.0))*0.5 + 0.5;
  else if (id == 37) t = (sin(length(uv - 0.5)*50.0)*sin(length(uv - vec2(0.3, 0.4))*50.0))*0.5 + 0.5;
  else if (id == 38) t = (sin(uv.x*8.0) + sin(uv.y*8.0) + sin((uv.x + uv.y)*8.0))*0.1667 + 0.5;
  else if (id == 39) t = smoothstep(0.35, 0.55, fbm(uv*10.0 + n1*1.4));
  else if (id == 40) t = max(step(0.96, fract(uv.y*12.0)), step(0.96, fract(uv.x*24.0)));
  else if (id == 41) { float a = (uv.y - 0.5)*6.0; t = exp(-a*a); }
  else if (id == 42) t = smoothstep(0.25, 0.60, abs(uv.y*2.0 - 1.0));
  else if (id == 43) t = step(0.5, uv.y);
  else if (id == 44) t = (step(0.5, uv.x) + step(0.5, uv.y)*2.0)/3.0;
  else if (id == 45) t = hash21(floor(vec2(uv.x*16.0, uv.y*8.0)));
  else if (id == 46) t = step(0.97, hash21(floor(vec2(uv.x*80.0, uv.y*40.0))));
  else if (id == 47) t = hash21(uv*512.0);
  else if (id == 48) t = hash21(floor(vec2(uv.x*60.0, uv.y*30.0)))*uv.y;
  else if (id == 49) t = step(0.5, fract(uv.y*14.0 + n1*2.0));
  else if (id == 50) t = sin((uv.y + n1*0.3)*30.0)*0.5 + 0.5;
  else if (id == 51) { float a = (uv.y - 0.25)*4.0; t = smoothstep(0.5, 0.9, fbm(vec2(uv.x*6.0, uv.y*3.0)))*exp(-a*a); }
  else if (id == 52) { float a = (uv.y - 0.22)*3.5; t = exp(-a*a)*(0.5 + 0.5*sin(uv.x*20.0 + fbm(vec2(uv.x*5.0, uv.y*5.0))*4.0)); }
  else if (id == 53) t = smoothstep(0.5, 0.0, abs(fract(uv.x*18.0) - 0.5))*exp(-uv.y*2.0);
  else if (id == 54) t = exp(-uv.y*uv.y*16.0);
  else if (id == 55) t = step(0.985, hash21(floor(vec2(uv.x*200.0, uv.y*100.0))));
  else if (id == 56) t = smoothstep(0.40, 0.85, fbm(uv*3.5 + uSeed*2.0));
  else if (id == 57) {
    vec2 i = floor(vec2(uv.x*18.0, uv.y*9.0));
    float r = 0.15*hash21(i);
    t = smoothstep(0.35, 0.0, length(fract(vec2(uv.x*18.0, uv.y*9.0)) - 0.5) - r);
  }
  else if (id == 58) t = fract(uv.y*10.0 + n2*2.0);
  else if (id == 59) t = floor(clamp(uv.y, 0.0, 0.999)*8.0)*0.125;
  else if (id == 60) t = step(hash21(uv*300.0), uv.y);
  else if (id == 61) t = smoothstep(0.20, 0.62, abs(fract(uv.x*14.0) - 0.5) + abs(fract(uv.y*7.0) - 0.5));
  else if (id == 62) t = (sin(uv.x*30.0)*sin(uv.y*15.0) + 1.0)*0.5;
  else if (id == 63) t = fbm(floor(uv*vec2(20.0, 10.0)));
  else if (id == 64) t = abs(fbm(uv*3.0) - 0.5)*2.0;
  else if (id == 65) t = smoothstep(0.50, 0.80, 1.0 - abs(n1*2.0 - 1.0));
  else if (id == 66) t = smoothstep(0.50, 0.85, ridged(uv*4.0 + n1));
  else if (id == 67) { float a = fract(length(uv - 0.5)*10.0) - 0.5; t = exp(-a*a*40.0); }
  else if (id == 68) t = exp(-length(uv - 0.5)*6.0);
  else if (id == 69) t = clamp(exp(-length(uv - vec2(0.3, 0.3))*8.0) + exp(-length(uv - vec2(0.7, 0.4))*8.0), 0.0, 1.0);
  else if (id == 70) { float a = (uv.y - 0.3)*3.0; t = (0.5 + 0.5*sin(uv.x*10.0 + fbm(uv*4.0)*6.0))*exp(-a*a); }
  return clamp(t, 0.0, 1.0);
}

/* ---------- 自定义空中图案分布 ---------- */
float patternField(vec3 rd, vec2 uv){
  vec2 p = vec2((uv.x - 0.5)*2.0, (uv.y - 0.5)*2.0);
  float cr = cos(uPatRot), sr = sin(uPatRot);
  p = mat2(cr, -sr, sr, cr)*p;
  float cnt = max(1.0, uPatCount);
  float sz = clamp(uPatSize, 0.02, 1.0);
  float a = 0.0;
  if (uPatType == 0){
    vec2 f = abs(fract(p*cnt) - 0.5);
    a = smoothstep(0.5, 0.5 - sz*0.5, max(f.x, f.y));
  } else if (uPatType == 1){
    a = smoothstep(sz*0.5, sz*0.28, length(fract(p*cnt) - 0.5));
  } else if (uPatType == 2){
    a = smoothstep(sz*0.6, 0.0, abs(fract(length(p)*cnt*0.5) - 0.5));
  } else if (uPatType == 3){
    float ang = atan(p.y, p.x)/6.2831853 + 0.5;
    a = smoothstep(sz*0.5, 0.0, abs(fract(ang + length(p)*cnt*0.5) - 0.5));
  } else if (uPatType == 4){
    float w = sin(p.x*cnt*3.14159)*0.5 + 0.5;
    a = smoothstep(sz*0.5, 0.0, abs(fract((p.y*0.5 + w*0.5)*cnt) - 0.5));
  } else if (uPatType == 5){
    vec2 q = p*cnt;
    vec2 i = floor(q);
    float h = hash21(i);
    a = smoothstep(sz*0.5, 0.0, length(fract(q) - vec2(h, hash21(i + 3.0))))*step(0.35, h);
  } else if (uPatType == 6){
    float ang = atan(p.y, p.x);
    a = smoothstep(sz, 0.0, abs(length(p) - 0.45 - 0.25*cos(ang*cnt)));
  } else {
    a = smoothstep(0.5, 0.0, abs(fract(length(p)*cnt*0.5 + sin(atan(p.y, p.x)*cnt)*0.15) - 0.5));
  }
  if (uPatDist < 0.5)      a *= 1.0;
  else if (uPatDist < 1.5) a *= smoothstep(0.0, 0.18, rd.y);
  else if (uPatDist < 2.5) a *= smoothstep(0.45, 0.0, abs(rd.y));
  else                     a *= smoothstep(0.25, 0.70, abs(rd.y));
  return clamp(a, 0.0, 1.0);
}

/* ---------- 星空 ---------- */
float starField(vec3 rd, float density, float size){
  vec3 p = rd*110.0;
  vec3 i = floor(p);
  float h = hash31(i);
  if (h >= density) return 0.0;
  vec3 c = vec3(hash31(i + 7.0), hash31(i + 19.0), hash31(i + 41.0));
  float d = length(fract(p) - c);
  return smoothstep(size, 0.0, d)*(0.35 + 0.65*hash31(i + 71.0));
}
float milkyBand(vec3 rd){
  vec3 axis = normalize(vec3(0.42 + uSeed*0.03, 0.55, -0.62));
  float d = abs(dot(rd, axis));
  float b = exp(-(d*d)/0.010);
  return b*(0.35 + 0.85*fbm(rd.xz*3.0 + rd.y*1.7 + uSeed));
}
float nebulaField(vec3 rd){
  float n = fbm(rd.xz*2.4 + rd.y*1.3 + uSeed*1.7);
  float m = fbm(rd.xz*5.1 - rd.y*2.0 + uSeed);
  return smoothstep(0.42, 0.85, n*0.7 + m*0.3);
}

/* ---------- 云 ---------- */
vec3 cloudLayer(vec3 col, vec3 rd, vec3 sd){
  if (rd.y <= 0.012) return col;
  float alt = mix(0.18, 1.5, clamp(uCloudAlt, 0.0, 1.0));
  vec2 cp = (rd.xz/max(rd.y, 0.03))*alt + vec2(uSeed*4.3, uSeed*2.1);
  float sc = max(0.15, uCloudScale);
  float n = fbm(cp*sc);
  n = mix(n, fbm(cp*sc*2.6 + n*1.8), 0.45);
  float thr = 1.0 - clamp(uCloudCover, 0.0, 0.98);
  float sh = max(0.02, uCloudSharp);
  float a = smoothstep(thr, thr + sh, n);
  a *= smoothstep(0.012, 0.10, rd.y);
  a = clamp(a*clamp(uCloudDensity, 0.0, 2.0), 0.0, 1.0);
  if (a <= 0.002) return col;
  vec2 sunOff = sd.xz*max(0.2, sd.y)*0.5;
  float ln = fbm((cp + sunOff)*sc);
  float lit = smoothstep(0.30, 0.85, n*0.55 + ln*0.45);
  vec3 cc = mix(uCloudDark, uCloudLit, lit);
  float thin = 1.0 - abs(a*2.0 - 1.0);
  vec3 rdn = normalize(vec3(rd.x, max(0.15, rd.y), rd.z));
  float toSun = pow(max(0.0, dot(rdn, sd)), 6.0);
  cc += uCloudLit*uCloudSilver*thin*toSun*0.9;
  return mix(col, cc, a);
}

/* ---------- 太阳 / 月亮 ---------- */
vec3 sunDisc(vec3 rd, vec3 sd){
  float ang = acos(clamp(dot(rd, sd), -1.0, 1.0));
  float rad = radians(max(0.05, uSunSize));
  float disc = 1.0 - smoothstep(rad*0.72, rad, ang);
  float glow = exp(-ang/max(0.02, rad*12.0));
  float wide = exp(-ang/0.55);
  float above = clamp(sd.y*8.0 + 0.6, 0.0, 1.0);
  return uSunColor*(disc*10.0*above + glow*1.2*uSunGlow*(0.4 + 0.6*above) + wide*0.15*uSunGlow);
}
vec3 moonDisc(vec3 rd){
  vec3 md = uMoonDir;
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), md));
  vec3 up = cross(md, right);
  vec2 q = vec2(dot(rd, right), dot(rd, up));
  float rad = radians(max(0.05, uMoonSize));
  vec2 nq = q/rad;
  float r = length(nq);
  float disc = 1.0 - smoothstep(0.94, 1.0, r);
  float z = sqrt(max(0.0, 1.0 - min(r*r, 1.0)));
  float th = uMoonPhase*PI;
  float lit = smoothstep(-0.02, 0.06, nq.x*sin(th) + z*cos(th));
  float crater = 0.82 + 0.18*fbm(nq*3.0 + 5.0);
  float above = clamp(md.y*8.0 + 0.5, 0.0, 1.0);
  float ang = acos(clamp(dot(rd, md), -1.0, 1.0));
  float glow = exp(-ang/max(0.03, rad*8.0));
  return uMoonColor*(disc*lit*crater*3.0*above + glow*0.6*uMoonGlow)*(0.3 + 0.7*uMoonGlow);
}

/* ---------- 镜头光晕 / 星芒（解析拟合，不做多 tap 重建采样） ---------- */
vec3 flareTerms(vec3 rd, vec3 sd, vec2 uv){
  float sunVis = smoothstep(-0.03, 0.06, sd.y);
  if (sunVis <= 0.001) return vec3(0.0);
  vec3 outC = vec3(0.0);
  if (uSpikes > 0.001){
    /* 星芒：把视线投影到太阳的正交基上，十字方向用指数尖峰拟合 */
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), sd));
    vec3 up = cross(sd, right);
    vec2 q = vec2(dot(rd, right), dot(rd, up));
    float ang = acos(clamp(dot(rd, sd), -1.0, 1.0));
    float core = exp(-ang/0.25);
    float sp = exp(-abs(q.x)/0.006) + exp(-abs(q.y)/0.006);
    outC += uSunColor*sp*core*uSpikes*0.30;
  }
  if (uFlare > 0.001){
    /* 光晕：单个屏幕空间拖影圆盘拟合 */
    vec2 p = uv - 0.5;
    vec2 s = uvFromDir(sd) - 0.5;
    float f = smoothstep(0.14, 0.0, length(p + s*0.75));
    outC += uSunColor*f*uFlare*sunVis*2.2;
  }
  return outC;
}

/* ---------- 合成整个天空（线性光） ---------- */
vec3 renderSky(vec2 uv){
  vec3 rd = dirFromUv(uv);
  vec3 sd = uSunDir;
  vec3 col = skyGradient(rd);

  if (uAtmAmt > 0.001) col += scattering(rd, sd)*uAtmAmt;

  if (uTexAmt > 0.001){
    vec3 base = mix(uTexA, uTexB, texPattern(uTexId, uv));
    col = mix(col, base, clamp(uTexAmt, 0.0, 1.0));
  }

  if (uStarOn > 0.5 && rd.y > -0.02){
    float above = smoothstep(-0.02, 0.12, rd.y);
    vec3 st = uStarColor*starField(rd, 0.02 + uStarDensity*0.35, 0.03 + uStarSize*0.22)*uStarBright;
    if (uMilkyWay > 0.001) st += uStarColor*milkyBand(rd)*0.30*uMilkyWay;
    if (uNebula > 0.001) st += uNebulaColor*nebulaField(rd)*0.55*uNebula;
    col += st*above;
  }

  if (uCloudOn > 0.5) col = cloudLayer(col, rd, sd);

  if (uPatOn > 0.5) col = mix(col, uPatColor, patternField(rd, uv)*uPatAlpha);

  if (uHaze > 0.001){
    float hz = exp(-abs(rd.y)/0.07);
    col = mix(col, uHazeColor, clamp(uHaze*hz*0.85, 0.0, 1.0));
  }

  if (uSunOn > 0.5) col += sunDisc(rd, sd);
  if (uMoonOn > 0.5) col += moonDisc(rd);
  if (uFlare > 0.001 || uSpikes > 0.001) col += flareTerms(rd, sd, uv);
  return col;
}

/* ---------- 曝光 / 色调映射 / 对比 / 饱和 / 暗角 → sRGB ---------- */
vec3 tonemap(vec3 c, int t){
  if (t == 0) return clamp(c, 0.0, 1.0);
  if (t == 1) return c/(c + vec3(1.0));
  if (t == 2) return 1.0 - exp(-c);
  vec3 a = c*(2.51*c + 0.03);
  vec3 b = c*(2.43*c + 0.59) + 0.14;
  return clamp(a/b, 0.0, 1.0);
}
vec3 grade(vec3 lin){
  vec3 c = lin*max(0.0, uExposure);
  c = tonemap(c, uTone);
  c = pow(clamp(c, 0.0, 1.0), vec3(1.0/2.2));
  c = clamp((c - 0.5)*max(0.0, uContrast) + 0.5, 0.0, 1.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, max(0.0, uSaturation));
  vec2 d = vUv - 0.5;
  return clamp(c*(1.0 - uVignette*dot(d, d)*2.4), 0.0, 1.0);
}

void main(){
  vec2 uv = vUv;
  /* 天空亮度：昼夜时间越低越暗（夜间把整幅天空压暗，含天体 / 云 / 大气） */
  vec3 lin = renderSky(uv)*max(0.0, uBright);
  /* 色差拟合：按到画面中心的径向距离给 R / B 通道做方向性微缩放，
     取代过去「重建采样三次全场景」的做法（编译体积与运行开销都大幅下降） */
  if (uChroma > 0.001){
    float k = uChroma*0.9*dot(uv - 0.5, uv - 0.5);
    lin *= vec3(1.0 + k, 1.0, 1.0 - k);
  }
  gl_FragColor = vec4(grade(lin), 1.0);
}
`;

/* ---------- 颜色 / 方向工具 ---------- */
/** '#rrggbb' → sRGB 0..1（不走 three 的颜色管理，避免被转成线性） */
function hex01(hex) {
  let h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (!isFinite(n)) return [0, 0, 0];
  return [((n >> 16) & 255)/255, ((n >> 8) & 255)/255, (n & 255)/255];
}
/** sRGB → 线性（着色器内部按线性光计算） */
function srgbToLin(c) { return c <= 0.04045 ? c/12.92 : Math.pow((c + 0.055)/1.055, 2.4); }
function setCol(v, hex) {
  const s = hex01(hex);
  v.set(srgbToLin(s[0]), srgbToLin(s[1]), srgbToLin(s[2]));
  return v;
}
function sphDir(azDeg, elDeg) {
  const az = azDeg*Math.PI/180;
  const el = Math.max(-88, Math.min(88, elDeg))*Math.PI/180;
  return new THREE.Vector3(Math.cos(el)*Math.sin(az), Math.sin(el), Math.cos(el)*Math.cos(az)).normalize();
}

function makeUniforms() {
  const V3 = () => ({ value: new THREE.Vector3() });
  const F = (v) => ({ value: v });
  return {
    uRes: { value: new THREE.Vector2(1024, 512) },
    uSeed: F(7),
    uSunDir: V3(), uMoonDir: V3(),

    uZenith: V3(), uHorizon: V3(), uGround: V3(),
    uAtmAmt: F(0.65), uDensity: F(1), uRayleigh: F(1), uMie: F(0.6), uMieG: F(0.76), uTurbidity: F(2.2),

    uCloudOn: F(1), uCloudCover: F(0.45), uCloudDensity: F(1), uCloudSharp: F(0.28),
    uCloudAlt: F(0.35), uCloudScale: F(1.6), uCloudSilver: F(0.5), uCloudLit: V3(), uCloudDark: V3(),

    uStarOn: F(1), uStarDensity: F(0.22), uStarBright: F(1), uStarSize: F(0.18),
    uNebula: F(0.3), uMilkyWay: F(0.35), uStarColor: V3(), uNebulaColor: V3(),

    uSunOn: F(1), uSunSize: F(1.6), uSunGlow: F(1), uSunColor: V3(),
    uMoonOn: F(0), uMoonSize: F(3.2), uMoonPhase: F(0.35), uMoonGlow: F(0.7), uMoonColor: V3(),

    uPatType: F(0), uPatOn: F(0), uPatCount: F(8), uPatSize: F(0.3),
    uPatAlpha: F(0.5), uPatRot: F(0), uPatDist: F(0), uPatColor: V3(),

    uTexId: F(2), uTexAmt: F(0), uTexA: V3(), uTexB: V3(),

    uExposure: F(1.15), uContrast: F(1.05), uSaturation: F(1.05), uTone: F(3),
    uHaze: F(0.4), uHazeColor: V3(), uChroma: F(0), uVignette: F(0.28),
    uFlare: F(0.35), uSpikes: F(0.35), uBright: F(1),
  };
}

function applyUniforms(u, p) {
  u.uRes.value.set(p._w || 1024, p._h || 512);
  u.uSeed.value = Number(p.seed) || 0;
  u.uSunDir.value.copy(sphDir(Number(p.sunAz) || 0, Number(p.sunEl) || 0));
  u.uMoonDir.value.copy(sphDir(Number(p.moonAz) || 0, Number(p.moonEl) || 0));

  setCol(u.uZenith.value, p.zenith); setCol(u.uHorizon.value, p.horizon); setCol(u.uGround.value, p.ground);
  u.uAtmAmt.value = Number(p.atmAmt); u.uDensity.value = Math.max(0.05, Number(p.density));
  u.uRayleigh.value = Number(p.rayleigh); u.uMie.value = Number(p.mie);
  u.uMieG.value = Number(p.mieG); u.uTurbidity.value = Math.max(0, Number(p.turbidity));

  u.uCloudOn.value = p.cloudOn ? 1 : 0; u.uCloudCover.value = Number(p.cloudCover);
  u.uCloudDensity.value = Number(p.cloudDensity); u.uCloudSharp.value = Number(p.cloudSharp);
  u.uCloudAlt.value = Number(p.cloudAlt); u.uCloudScale.value = Number(p.cloudScale);
  u.uCloudSilver.value = Number(p.cloudSilver);
  setCol(u.uCloudLit.value, p.cloudLit); setCol(u.uCloudDark.value, p.cloudDark);

  u.uStarOn.value = p.starOn ? 1 : 0; u.uStarDensity.value = Number(p.starDensity);
  u.uStarBright.value = Number(p.starBright); u.uStarSize.value = Number(p.starSize);
  u.uNebula.value = Number(p.nebula); u.uMilkyWay.value = Number(p.milkyWay);
  setCol(u.uStarColor.value, p.starColor); setCol(u.uNebulaColor.value, p.nebulaColor);

  u.uSunOn.value = p.sunOn ? 1 : 0; u.uSunSize.value = Number(p.sunSize);
  u.uSunGlow.value = Number(p.sunGlow); setCol(u.uSunColor.value, p.sunColor);
  u.uMoonOn.value = p.moonOn ? 1 : 0; u.uMoonSize.value = Number(p.moonSize);
  u.uMoonPhase.value = Number(p.moonPhase); u.uMoonGlow.value = Number(p.moonGlow);
  setCol(u.uMoonColor.value, p.moonColor);

  u.uPatOn.value = p.patOn ? 1 : 0; u.uPatType.value = Number(p.patType) | 0;
  u.uPatCount.value = Number(p.patCount); u.uPatSize.value = Number(p.patSize);
  u.uPatAlpha.value = Number(p.patAlpha); u.uPatRot.value = (Number(p.patRot) || 0)*Math.PI/180;
  u.uPatDist.value = Number(p.patDist) | 0; setCol(u.uPatColor.value, p.patColor);

  u.uTexId.value = Number(p.texId) | 0; u.uTexAmt.value = Number(p.texAmt);
  setCol(u.uTexA.value, p.texA); setCol(u.uTexB.value, p.texB);

  u.uExposure.value = Number(p.exposure); u.uContrast.value = Number(p.contrast);
  u.uSaturation.value = Number(p.saturation); u.uTone.value = Number(p.tone) | 0;
  u.uHaze.value = Number(p.haze); setCol(u.uHazeColor.value, p.hazeColor);
  u.uChroma.value = Number(p.chroma); u.uVignette.value = Number(p.vignette);
  u.uFlare.value = Number(p.flare); u.uSpikes.value = Number(p.spikes);
  u.uBright.value = p.bright === undefined ? 1 : Number(p.bright);
}

/** 补齐缺省参数 */
export function withDefaults(p) { return Object.assign({}, SKY_DEFAULTS, p || {}); }

/* ============================================================
   烘焙器：一块全屏四边形 + WebGL 渲染目标（懒创建，用完 dispose）
   ============================================================ */
export class SkyBaker {
  constructor() {
    this._r = null;
    this._scene = null;
    this._cam = null;
    this._mat = null;
    this.canvas = null;
    this.error = '';
    this._warm = false;
    this._warming = null;
    this._lost = false;    // WebGL 上下文是否已丢失（丢失 / 恢复期间不能渲染）
    this._ok = null;       // 已确认链接成功的 program（只在换过程序之后校验一次）
  }

  /** 造一份新的全屏四边形 + 天空材质：首次建、上下文恢复、程序失效重建都走这里 */
  _makeScene() {
    if (this._mat) { try { this._mat.dispose(); } catch (e) { /* ignore */ } }
    if (this._scene) {
      try { this._scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); } catch (e) { /* ignore */ }
    }
    this._mat = new THREE.ShaderMaterial({
      uniforms: makeUniforms(),
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._mat);
    quad.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(quad);
    this._ok = null;
    this._warm = false;
    this._warming = null;
  }

  _ensure() {
    if (this._r) return true;
    try {
      const canvas = document.createElement('canvas');
      const r = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
      r.setPixelRatio(1);
      r.outputColorSpace = THREE.LinearSRGBColorSpace;   // 着色器里已自行做 sRGB 编码
      r.toneMapping = THREE.NoToneMapping;
      r.setClearColor(0x000000, 1);
      /* 上下文丢失 / 恢复：three 自己会重建 GL 资源，但材质里那个旧程序在旧上下文里
         已经作废（恢复后继续用就是 useProgram: program not valid），必须换一份新材质。
         丢失期间不 preventDefault 浏览器就不会尝试恢复，所以这里必须吃掉默认行为。 */
      canvas.addEventListener('webglcontextlost', (e) => {
        try { e.preventDefault(); } catch (err) { /* ignore */ }
        this._lost = true;
        this._ok = null;
        this._warm = false;
        this._warming = null;
        this.error = '渲染上下文已丢失（显卡驱动重置 / 上下文过多），正在等待恢复';
        console.warn('[sky-gen] WebGL 上下文丢失');
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this._lost = false;
        this.error = '';
        this._makeScene();
        console.warn('[sky-gen] WebGL 上下文已恢复，天空材质已重建');
      });
      this.canvas = canvas;
      this._r = r;
      this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
      this._makeScene();
      return true;
    } catch (e) {
      this.error = e && e.message ? e.message : String(e);
      console.error('[sky-gen] WebGL 初始化失败', e);
      return false;
    }
  }

  /**
   * 建好 WebGL 上下文（同步，实测首次要一秒上下）。
   * 天空工坊把它和「编译着色器」分成两步调用：好让界面说清楚现在卡在哪一步，
   * 而不是一整段什么都不显示的黑箱。
   */
  prepare() { return this._ensure(); }

  /**
   * 异步预热着色器：编译 / 链接交给 KHR_parallel_shader_compile，由驱动在
   * 后台线程做，主线程每 10ms 只轮询一次完成状态 —— 同步路径要一口气卡住
   * 主线程三四秒，这里最长停顿只有几十到几百毫秒，界面照样能画进度条。
   * 没有该扩展的老渲染器退回同步 compile()（会卡，但只卡这一次）。
   */
  warmup() {
    if (this._warm) return Promise.resolve(true);
    if (this._warming) return this._warming;
    if (!this._ensure()) return Promise.resolve(false);
    if (this._lost) return Promise.resolve(false);
    let p = null;
    try {
      p = typeof this._r.compileAsync === 'function' ? this._r.compileAsync(this._scene, this._cam) : null;
    } catch (e) { p = null; }
    if (!p || typeof p.then !== 'function') {
      try { this._r.compile(this._scene, this._cam); } catch (e) { /* ignore */ }
      this._warm = true;
      return Promise.resolve(true);
    }
    this._warming = Promise.race([
      p.then(() => true).catch(() => false),
      /* 兜底：compileAsync 靠 KHR_parallel_shader_compile 的完成状态回调，
         驱动不给完成状态（编译报错 / 老驱动）时这个 Promise 会永远不 resolve，
         界面就卡死在「正在编译天空着色器…」。超时后强制同步编译一次，
         把真正的原因（链接日志）交给 render() 的 _programOk 报出来 */
      new Promise((r) => setTimeout(() => r('timeout'), 4000)),
    ]).then((res) => {
      if (res === 'timeout') {
        try { this._r.compile(this._scene, this._cam); } catch (e) { /* ignore */ }
        this._warm = true;
        this._warming = null;
        return true;
      }
      /* 预编译失败不能当成成功上报：以前这里吞掉异常仍然返回 true，
         结果就是「编译没成功 → 渲染出来全黑 → 导出空白 PNG」谁也不吭声 */
      this._warm = res === true;
      if (!this._warm) {
        this._warming = null;
        if (!this.error) this.error = '天空着色器编译失败';
      }
      return this._warm;
    });
    return this._warming;
  }

  /**
   * 程序是不是真的链接成功了（换了程序才查一次，避免每帧都等驱动）。
   * 失败时把驱动给的原文写进 this.error —— 也就是「为什么是黑图」的真正原因。
   */
  _programOk() {
    if (this._lost) { if (!this.error) this.error = '渲染上下文已丢失，正在等待恢复'; return false; }
    const gl = this._r.getContext();
    if (!gl) { this.error = '拿不到 WebGL 上下文'; return false; }
    if (gl.isContextLost()) { this._lost = true; this.error = '渲染上下文已丢失（显卡驱动重置 / 上下文过多），正在等待恢复'; return false; }
    const pr = this._r.properties && this._mat ? this._r.properties.get(this._mat).currentProgram : null;
    if (!pr || pr === this._ok) return true;
    let link = false;
    try { link = gl.getProgramParameter(pr.program, gl.LINK_STATUS) === true; } catch (e) { link = false; }
    if (link) { this._ok = pr; this.error = ''; return true; }
    const d = pr.diagnostics;
    const log = (d && (d.programLog || (d.fragmentShader && d.fragmentShader.log))) || '';
    this.error = ('天空着色器链接失败' + (log ? '：' + String(log).replace(/\s+/g, ' ').slice(0, 160) : '（驱动没给出原因）'));
    return false;
  }

  /** 渲染到内部画布并返回它（尺寸 = w×h）；失败返回 null 并把原因写进 this.error */
  render(params, w, h) {
    if (!this._ensure()) return null;
    if (!this._programOk()) {
      /* 上下文丢失就等恢复，别硬来 */
      if (this._lost) return null;
      /* 程序作废 / 首次编译失败 / 上下文刚恢复：换一份材质重来。
         以前这里用 _tries 只允许重试一次并把计数留在 1，
         结果「第一次失败 → 之后每次 render 直接返回 null」，
         导出 PNG / 同步到编辑器 / 存为素材三个动作会一起永久失败。 */
      this._makeScene();
    }
    const p = withDefaults(params);
    p._w = w; p._h = h;
    applyUniforms(this._mat.uniforms, p);
    // 尺寸没变就别碰 canvas.width —— 每次赋值都会重新分配一块 drawing buffer
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this._r.setSize(w, h, false);
    }
    this._r.render(this._scene, this._cam);
    return this._programOk() ? this.canvas : null;
  }

  /** 渲染并导出 PNG Blob */
  toBlob(params, w, h) {
    const c = this.render(params, w, h);
    if (!c) return Promise.resolve(null);
    return new Promise((res) => {
      try { c.toBlob((b) => res(b), 'image/png'); } catch (e) { res(null); }
    });
  }

  dispose() {
    try { if (this._mat) this._mat.dispose(); } catch (e) { /* ignore */ }
    try { if (this._scene) this._scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); } catch (e) { /* ignore */ }
    try { if (this._r) this._r.dispose(); } catch (e) { /* ignore */ }
    try { if (this._r && this._r.forceContextLoss) this._r.forceContextLoss(); } catch (e) { /* ignore */ }
    this._r = null; this._scene = null; this._cam = null; this._mat = null; this.canvas = null;
    this._warm = false; this._warming = null; this._lost = false; this._ok = null;
  }
}