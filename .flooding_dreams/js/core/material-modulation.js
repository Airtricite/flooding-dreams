/* ============================================================
   智能材质调制（Smart Material Modulation）
   ------------------------------------------------------------
   把对象「颜色」从“直接乘在贴图上”升级为“智能重调制”：
     · 贴图加载时做一次预运算，统计出它的平均色相 / 饱和度（缩到 32×32 采样，之后走缓存）；
     · 运行时用同一个 3×3 颜色矩阵完成重上色 ——
         把贴图的「亮度分量」（沿白轴的灰阶）交给「颜色」染色，
         所以纯灰阶贴图也能被任意染色；
         把贴图的「色度分量」（垂直于白轴的有彩部分）做色相旋转 + 饱和度缩放，
         于是纹理自身的色彩层次（丰富度）被保留下来，而不是被压成一张灰图再染色。
   矩阵直接注入片元着色器（与画面调色同一套做法），每像素只多 3 次乘加，
   不额外占纹理采样、不额外 draw call；换颜色只写 9 个 float，不重编译着色器。
   ============================================================ */
import * as THREE from './three-ns.js';
import { clamp } from './util.js';

/* ---------- 贴图统计（预运算：同一张贴图只算一次） ---------- */
const STAT_SIZE = 32;                 // 统计采样分辨率，足够代表整体色调
const _statCache = new Map();         // tex.uuid -> { image, stats }
let _stat = null;

function statCanvas() {
  if (!_stat) {
    const c = document.createElement('canvas');
    c.width = c.height = STAT_SIZE;
    _stat = { c, x: c.getContext('2d', { willReadFrequently: true }) };
  }
  return _stat;
}

/** tex.image 能否被 canvas 绘制（导入的贴图素材是异步加载的，未就绪时返回 false） */
function isDrawable(img) {
  if (!img) return false;
  const w = img.width || img.naturalWidth || 0;
  const h = img.height || img.naturalHeight || 0;
  if (!w || !h) return false;
  if (img.complete === false) return false;
  return true;
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB 三元组 → HSL（h 为弧度，s / l 取 0~1） */
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) * 0.5, d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h / 6) * Math.PI * 2, s, l };
}

/** 统计贴图的平均色：像素先转到线性空间取均值（与“相乘”的物理含义一致），
    再转回 sRGB 求色相 / 饱和度。结果即“预运算”，按贴图实例缓存。 */
export function analyzeTexture(tex) {
  if (!tex) return null;
  const img = tex.image;
  if (!isDrawable(img)) return null;
  const rec = _statCache.get(tex.uuid);
  if (rec && rec.image === img) return rec.stats;
  let stats = null;
  try {
    const { x } = statCanvas();
    x.clearRect(0, 0, STAT_SIZE, STAT_SIZE);
    x.drawImage(img, 0, 0, STAT_SIZE, STAT_SIZE);
    const px = x.getImageData(0, 0, STAT_SIZE, STAT_SIZE).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;              // 透明像素不参与统计
      r += srgbToLinear(px[i] / 255);
      g += srgbToLinear(px[i + 1] / 255);
      b += srgbToLinear(px[i + 2] / 255);
      n++;
    }
    if (n > 0) {
      const hsl = rgbToHsl(linearToSrgb(r / n), linearToSrgb(g / n), linearToSrgb(b / n));
      stats = { h: hsl.h, s: hsl.s, l: hsl.l };
    }
  } catch (e) { stats = null; }                   // 跨域贴图会污染画布，取像素抛错 → 放弃调制
  _statCache.set(tex.uuid, { image: img, stats });
  return stats;
}

/** 贴图缓存被清空（换关卡）时一并清掉统计缓存 */
export function clearModulationStats() { _statCache.clear(); }

/* ---------- 颜色矩阵 ---------- */
const LUMA = [0.2126, 0.7152, 0.0722];   // Rec.709 亮度权重（与画面调色的饱和度一致）

/** 绕 (1,1,1) 白轴旋转 angle 弧度的 3×3 矩阵（行主序）——标准色相旋转 */
function hueRotation(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const a = (1 - c) / 3, k = Math.sqrt(1 / 3);
  return [
    c + a, a - k * s, a + k * s,
    a + k * s, c + a, a - k * s,
    a - k * s, a + k * s, c + a,
  ];
}

/** 由「颜色」与贴图统计合成 3×3 调制矩阵（线性空间）。
    返回 null = 无需调制（颜色是无彩色 → 保持原来的“直接相乘”行为）。 */
export function modulationMatrix(tint, stats) {
  if (!tint) return null;
  const tr = tint.r, tg = tint.g, tb = tint.b;
  // 「颜色」的 sRGB 感知色相 / 饱和度（与贴图统计同一套度量）
  const th = rgbToHsl(
    clamp(linearToSrgb(tr), 0, 1),
    clamp(linearToSrgb(tg), 0, 1),
    clamp(linearToSrgb(tb), 0, 1),
  );
  if (th.s < 0.04) return null;                    // 白 / 灰 / 黑：退化为直接相乘
  const h0 = stats ? stats.h : 0;
  const s0 = stats ? stats.s : 0;
  let d = th.h - h0;                               // 色相偏移，绕回 [-π, π]
  d = Math.atan2(Math.sin(d), Math.cos(d));
  // 色度缩放：把贴图平均饱和度朝「颜色」靠拢，但只做“半步”靠近（平方根压缩）并收窄上下限。
  // 原来用 th.s/s0 直接做满量程缩放（上限 4）会把贴图里本就鲜艳的区域一起放大到过饱和
  // —— 表现为“颜色稍微拉一点饱和度就高得不行”，故改为温和增益：色度最多放大约 15%。
  const gain = clamp(Math.sqrt(th.s / Math.max(s0, 0.15)), 0.6, 1.15);
  const R = hueRotation(d);
  // Q = I - 1⊗L：取出垂直于白轴的色度分量；R 旋转其色相，gain 缩放其饱和度
  const Q = [
    1 - LUMA[0], -LUMA[1], -LUMA[2],
    -LUMA[0], 1 - LUMA[1], -LUMA[2],
    -LUMA[0], -LUMA[1], 1 - LUMA[2],
  ];
  const P = R.map((v) => v * gain);
  const m = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      // (tint ⊗ L)[i][j] + (gain·R·Q)[i][j]
      let v = [tr, tg, tb][i] * LUMA[j];
      for (let k = 0; k < 3; k++) v += P[i * 3 + k] * Q[k * 3 + j];
      m[i * 3 + j] = v;
    }
  }
  return new THREE.Matrix3().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
}

/** 矩阵指纹（进材质缓存 key 用）：保留 4 位小数，避免浮点噪声让缓存反复失效。
    贴图统计是“加载完成后才就绪”的，指纹变了才会重建材质、把调制补上。 */
export function modulationKey(m) {
  if (!m) return '';
  let s = '';
  for (let i = 0; i < 9; i++) s += m.elements[i].toFixed(4) + ',';
  return s;
}

/** 该对象是否开启智能调制（默认关；只有显式 true 才开启） */
export function isModulationEnabled(p) { return !!(p && p.smartMod === true); }

/** 把调制矩阵注入材质：在 <map_fragment> 之后立即重上色（此时 diffuseColor 已是线性贴图色）。
    必须排在 applyScreenGrade 之前调用，让画面调色串在它后面。 */
export function applyModulationShader(mat, matrix3) {
  if (!mat || !matrix3) return mat;
  mat.userData.modMat = matrix3;
  const prevCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prevCompile) prevCompile.call(this, shader, renderer);
    shader.uniforms.uModMat = { value: matrix3 };
    shader.fragmentShader = 'uniform mat3 uModMat;\n' + shader.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n  diffuseColor.rgb = uModMat * diffuseColor.rgb;',
    );
  };
  // 注入过 onBeforeCompile 的材质必须让程序缓存 key 带上自己的版本号，否则会命中旧程序
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function () {
    return (prevKey ? prevKey.call(this) : '') + '|mod';
  };
  return mat;
}