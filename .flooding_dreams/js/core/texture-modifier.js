/* ============================================================
   贴图修改器（Texture Modifier）
   ------------------------------------------------------------
   概念：以一张贴图素材为「源」，叠若干层算子（调色 / 扭曲失真 / 风格化结构 /
   叠加混合），产出一张**新的贴图素材**。所有加工都在「进入游戏之前」用
   canvas 一次算完（离线烘焙），游戏里只是普通贴图，零运行时开销。

   数据分两半，都随关卡走（本地化、可打包）：
     · 配方（layer stack）：存进 level.texMods，进 level.json，可再次打开编辑
     · 成品（PNG）：写进关卡素材文件夹，作为普通贴图素材被引用
       （配方里的 source / output 都是 'asset:<id>' 字符串，
        collectAssetRefs / rewriteAssetRefs 会自动收集与改写 → 打包 / 复制 / 导入全都自洽）

   几何类算子一律用「环绕取样」，因此只要源图本身四方连续，结果仍然无缝。
   ============================================================ */
import { clamp } from './util.js';

export const TEXMOD_VERSION = 1;
/** 输出尺寸上限（烘焙是离线一次性的，给足清晰度） */
export const TEXMOD_MAX = 2048;
export const TEXMOD_MIN = 64;

export const TEXMOD_CATS = [
  { v: 'color', l: '调色与色彩' },
  { v: 'warp', l: '扭曲与失真' },
  { v: 'style', l: '风格化结构' },
  { v: 'mix', l: '叠加与创意' },
];

export const BLEND_MODES = [
  { v: 'normal', l: '正常' },
  { v: 'multiply', l: '正片叠底' },
  { v: 'screen', l: '滤色' },
  { v: 'overlay', l: '叠加' },
  { v: 'softlight', l: '柔光' },
  { v: 'difference', l: '差值' },
  { v: 'add', l: '线性减淡(加)' },
  { v: 'darken', l: '变暗' },
  { v: 'lighten', l: '变亮' },
];

/** 混合模式 → canvas 合成算子 */
const BLEND_CANVAS = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  softlight: 'soft-light', difference: 'difference', add: 'lighter',
  darken: 'darken', lighten: 'lighten',
};

/* 参数描述（与 objectTypes 的属性描述同构，编辑器据此自动生成控件） */
const N = (k, l, d, min, max, st = 0.01) => ({ k, l, t: 'num', d, min, max, st });
const B = (k, l, d) => ({ k, l, t: 'bool', d });
const C = (k, l, d) => ({ k, l, t: 'color', d });
const SEL = (k, l, d, o) => ({ k, l, t: 'select', d, o });

/**
 * 算子目录。
 *   v  算子 id
 *   l  名称
 *   c  类别
 *   p  参数
 * 特殊算子 'image'：不加工，只把「输入贴图」整层按混合模式叠上去（多层叠加的基础）
 */
export const TEXMOD_OPS = [
  /* ---------- 调色与色彩 ---------- */
  { v: 'hsl', l: '色相 / 饱和度 / 明度', c: 'color', p: [N('hue', '色相', 0, -180, 180, 1), N('sat', '饱和度', 0, -1, 1), N('light', '明度', 0, -1, 1)] },
  { v: 'bc', l: '亮度 / 对比度', c: 'color', p: [N('bright', '亮度', 0, -1, 1), N('contrast', '对比度', 0, -1, 1)] },
  { v: 'levels', l: '色阶 / 伽马', c: 'color', p: [N('inB', '输入黑场', 0, 0, 1), N('inW', '输入白场', 1, 0, 1), N('gamma', '伽马', 1, 0.1, 3), N('outB', '输出黑场', 0, 0, 1), N('outW', '输出白场', 1, 0, 1)] },
  { v: 'tint', l: '单色染色', c: 'color', p: [C('color', '颜色', '#7fb2ff'), N('amount', '强度', 0.5, 0, 1), B('keepLum', '保留明度', true)] },
  { v: 'gradmap', l: '渐变映射', c: 'color', p: [C('colorA', '暗部', '#1b2a4a'), C('colorB', '亮部', '#ffd9a0'), N('amount', '强度', 1, 0, 1)] },
  { v: 'balance', l: '色彩平衡', c: 'color', p: [N('r', '红', 0, -1, 1), N('g', '绿', 0, -1, 1), N('b', '蓝', 0, -1, 1)] },
  { v: 'channel', l: '通道重排', c: 'color', p: [SEL('map', '通道顺序', 'rgb', [
    { v: 'rgb', l: 'RGB' }, { v: 'rbg', l: 'RBG' }, { v: 'grb', l: 'GRB' },
    { v: 'gbr', l: 'GBR' }, { v: 'brg', l: 'BRG' }, { v: 'bgr', l: 'BGR' }]), N('amount', '强度', 1, 0, 1)] },
  { v: 'invert', l: '反相', c: 'color', p: [N('amount', '强度', 1, 0, 1)] },

  /* ---------- 扭曲与失真 ---------- */
  { v: 'noiseWarp', l: '噪波扰动', c: 'warp', p: [N('amount', '幅度', 0.05, 0, 0.25), N('scale', '噪波密度', 8, 1, 64, 1), N('seed', '随机种子', 1, 0, 999, 1)] },
  { v: 'ripple', l: '波纹', c: 'warp', p: [N('amp', '幅度', 0.03, 0, 0.2), N('freq', '频率', 12, 1, 64, 1), N('phase', '相位', 0, 0, 6.283, 0.01), B('vertical', '纵向波纹', false)] },
  { v: 'swirl', l: '漩涡', c: 'warp', p: [N('amount', '强度', 1, -3, 3), N('radius', '半径', 0.5, 0.05, 1), N('cx', '中心X', 0.5, 0, 1), N('cy', '中心Y', 0.5, 0, 1)] },
  { v: 'lens', l: '镜头畸变', c: 'warp', p: [N('amount', '桶形/枕形', 0.25, -1, 1), N('zoom', '缩放', 1, 0.5, 2)] },
  { v: 'polar', l: '极坐标', c: 'warp', p: [SEL('mode', '方向', 'r2p', [{ v: 'r2p', l: '直角→极坐标' }, { v: 'p2r', l: '极坐标→直角' }]), N('rotate', '旋转', 0, 0, 360, 1)] },
  { v: 'pixelate', l: '像素化', c: 'warp', p: [N('size', '像素块', 8, 2, 128, 1)] },
  { v: 'scanline', l: '扫描线', c: 'warp', p: [N('period', '周期', 4, 2, 32, 1), N('strength', '强度', 0.3, 0, 1), B('vertical', '纵向', false)] },
  { v: 'glitch', l: '故障 Glitch', c: 'warp', p: [N('amount', '偏移', 0.08, 0, 0.3), N('slices', '切片数', 12, 1, 64, 1), N('seed', '随机种子', 1, 0, 999, 1), B('colorSplit', '色散', false)] },
  { v: 'blur', l: '模糊', c: 'warp', p: [N('radius', '半径', 2, 0, 16, 0.5)] },
  { v: 'sharpen', l: '锐化', c: 'warp', p: [N('amount', '强度', 1, 0, 3)] },

  /* ---------- 风格化结构 ---------- */
  { v: 'outline', l: '描边', c: 'style', p: [C('color', '颜色', '#101018'), N('width', '线宽', 1, 1, 8, 1), N('threshold', '阈值', 0.25, 0, 1)] },
  { v: 'halftone', l: '半调网点', c: 'style', p: [N('size', '网点间距', 6, 2, 32, 1), N('angle', '角度', 45, 0, 180, 1), N('mix', '混合量', 1, 0, 1)] },
  { v: 'mosaic', l: '马赛克', c: 'style', p: [N('size', '格子', 6, 2, 64, 1), N('gap', '缝隙', 1, 0, 6, 0.5), C('mortar', '缝隙色', '#000000')] },
  { v: 'hex', l: '蜂窝', c: 'style', p: [N('size', '蜂窝大小', 16, 4, 64, 1), N('gap', '缝隙', 0.08, 0, 0.5), C('mortar', '缝隙色', '#000000')] },
  { v: 'brick', l: '砖块重排', c: 'style', p: [N('rows', '行数', 6, 1, 32, 1), N('cols', '列数', 6, 1, 32, 1), N('offset', '错缝', 0.5, 0, 1), N('gap', '缝隙', 1, 0, 8, 0.5), C('mortar', '缝隙色', '#000000')] },
  { v: 'edge', l: '边缘检测', c: 'style', p: [N('strength', '强度', 1, 0, 3), B('color', '彩色边缘', false)] },
  { v: 'posterize', l: '色阶化', c: 'style', p: [N('steps', '色阶数', 6, 2, 16, 1)] },
  { v: 'dither', l: '抖动 Dither', c: 'style', p: [SEL('mode', '矩阵', 'bayer4', [
    { v: 'bayer2', l: 'Bayer 2×2' }, { v: 'bayer4', l: 'Bayer 4×4' },
    { v: 'bayer8', l: 'Bayer 8×8' }, { v: 'noise', l: '噪波' }]), N('levels', '色阶数', 4, 2, 8, 1)] },

  /* ---------- 叠加与创意 ---------- */
  { v: 'image', l: '叠加贴图（混合）', c: 'mix', p: [] },
  { v: 'mirror', l: '镜像', c: 'mix', p: [SEL('mode', '方式', 'quad', [
    { v: 'x', l: '左右镜像' }, { v: 'y', l: '上下镜像' }, { v: 'quad', l: '四象限镜像' }])] },
  { v: 'kaleido', l: '万花筒', c: 'mix', p: [N('segments', '份数', 6, 2, 16, 1), N('rotate', '旋转', 0, 0, 360, 1)] },
  { v: 'tileRearrange', l: '拼块重排', c: 'mix', p: [N('cols', '列数', 4, 1, 16, 1), N('rows', '行数', 4, 1, 16, 1), N('jitter', '位移抖动', 0.3, 0, 1), N('rotate', '旋转', 0, 0, 180, 1), N('seed', '随机种子', 1, 0, 999, 1)] },
  { v: 'glow', l: '辉光', c: 'mix', p: [N('threshold', '阈值', 0.6, 0, 1), N('radius', '半径', 8, 1, 32, 1), N('strength', '强度', 1.2, 0, 3), C('color', '辉光色', '#ffffff')] },
  { v: 'aberration', l: '色散', c: 'mix', p: [N('amount', '偏移', 4, 0, 32, 0.5), N('angle', '方向', 0, 0, 360, 1), B('radial', '径向', false)] },
];

export const OP_BY_ID = {};
for (const o of TEXMOD_OPS) OP_BY_ID[o.v] = o;



/* ============================================================
   画布小工具
   ============================================================ */
function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
function cloneCanvas(src, size) {
  const w = size || src.width, h = size || src.height;
  const c = cv(w, h);
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  return c;
}
function data(src) {
  const g = src.getContext('2d', { willReadFrequently: true });
  return g.getImageData(0, 0, src.width, src.height);
}
function put(canvas, img) {
  canvas.getContext('2d').putImageData(img, 0, 0);
  return canvas;
}
const wrap = (v, n) => ((v % n) + n) % n;
const hex2rgb = (h) => {
  const s = String(h || '#000000').replace('#', '');
  const v = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
function luma(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

/** 按 u/v（0..1，可越界 → 环绕）取源图像素（最近邻） */
function sampler(src) {
  const W = src.width, H = src.height;
  const d = data(src).data;
  return (u, v) => {
    const x = wrap(Math.round(u * W - 0.5), W);
    const y = wrap(Math.round(v * H - 0.5), H);
    const i = (y * W + x) * 4;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  };
}

/** 几何重采样：fn(u,v) → [su,sv]（0..1，越界自动环绕），保持无缝 */
function resample(src, fn) {
  const W = src.width, H = src.height;
  const d = data(src).data;
  const out = cv(W, H);
  const img = out.getContext('2d').createImageData(W, H);
  const o = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const uv = fn((x + 0.5) / W, (y + 0.5) / H);
      const sx = wrap(Math.round(uv[0] * W - 0.5), W);
      const sy = wrap(Math.round(uv[1] * H - 0.5), H);
      const si = (sy * W + sx) * 4, di = (y * W + x) * 4;
      o[di] = d[si]; o[di + 1] = d[si + 1]; o[di + 2] = d[si + 2]; o[di + 3] = d[si + 3];
    }
  }
  return put(out, img);
}

/** 逐像素处理：fn(r,g,b,a, x,y) → [r,g,b,a] */
function pixelwise(src, fn) {
  const img = data(src);
  const d = img.data;
  const W = src.width;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const r = fn(d[i], d[i + 1], d[i + 2], d[i + 3], p % W, (p / W) | 0);
    d[i] = r[0]; d[i + 1] = r[1]; d[i + 2] = r[2]; d[i + 3] = r[3];
  }
  return put(src, img);
}

/** 环绕盒式模糊（可多次迭代近似高斯），就地返回新画布 */
function boxBlur(src, radius, pass = 2) {
  const W = src.width, H = src.height;
  if (radius < 0.5) return src;
  const r = Math.max(1, Math.round(radius));
  const out = cv(W, H);
  let buf = new Float32Array(data(src).data);
  const tmp = new Float32Array(buf.length);
  const blurPass = (srcBuf, dstBuf, horizontal) => {
    const n = horizontal ? W : H, m = horizontal ? H : W;
    const step = horizontal ? 4 : W * 4;
    const lineStep = horizontal ? W * 4 : 4;
    const win = 2 * r + 1;
    for (let j = 0; j < m; j++) {
      const base = horizontal ? j * lineStep : j * lineStep;
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += srcBuf[base + wrap(k, n) * step + c];
        for (let i = 0; i < n; i++) {
          dstBuf[base + i * step + c] = sum / win;
          sum -= srcBuf[base + wrap(i - r, n) * step + c];
          sum += srcBuf[base + wrap(i + r + 1, n) * step + c];
        }
      }
    }
  };
  for (let p = 0; p < pass; p++) {
    blurPass(buf, tmp, true);
    blurPass(tmp, buf, false);
  }
  const img = out.getContext('2d').createImageData(W, H);
  for (let i = 0; i < img.data.length; i++) img.data[i] = clamp(buf[i], 0, 255);
  return put(out, img);
}

/* ---------- Bayer 抖动矩阵 ---------- */
function bayerMatrix(n) {
  if (n <= 1) return [[0]];
  const m = bayerMatrix(n / 2);
  const out = [];
  for (let y = 0; y < n; y++) out.push(new Array(n));
  for (let y = 0; y < n / 2; y++) {
    for (let x = 0; x < n / 2; x++) {
      const v = m[y][x] * 4;
      out[y][x] = v;
      out[y][x + n / 2] = v + 2;
      out[y + n / 2][x] = v + 3;
      out[y + n / 2][x + n / 2] = v + 1;
    }
  }
  return out;
}
const BAYER = { 2: bayerMatrix(2), 4: bayerMatrix(4), 8: bayerMatrix(8) };

/** 简易值噪波（可重复、无缝：对格点做周期哈希） */
function vnoise(x, y, seed, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (a, b) => {
    let n = (wrap(a, period) * 374761393 + wrap(b, period) * 668265263 + seed * 1442695040) | 0;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  };
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/* ============================================================
   算子实现： (srcCanvas, params) → 新画布
   ============================================================ */
const OPS_FN = {
  /* ---------- 调色 ---------- */
  hsl(src, P) {
    const dh = Number(P.hue) || 0, ds = Number(P.sat) || 0, dl = Number(P.light) || 0;
    return pixelwise(src, (r, g, b, a) => {
      let mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
      let h = 0, s = 0, l = (mx + mn) / 2;
      const d = mx - mn;
      if (d > 0) {
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === r / 255) h = ((g - b) / 255) / d + (g < b ? 6 : 0);
        else if (mx === g / 255) h = ((b - r) / 255) / d + 2;
        else h = ((r - g) / 255) / d + 4;
        h /= 6;
      }
      h = (h + dh / 360 + 1) % 1;
      s = clamp(s * (1 + ds), 0, 1);
      l = clamp(dl >= 0 ? l + (1 - l) * dl : l * (1 + dl), 0, 1);
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const f = (t) => {
        t = (t + 1) % 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255, a];
    });
  },
  bc(src, P) {
    const br = (Number(P.bright) || 0) * 255;
    const c = Number(P.contrast) || 0;
    const k = c >= 0 ? 1 / Math.max(0.02, 1 - c) : 1 + c;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = clamp((i - 128) * k + 128 + br, 0, 255);
    return pixelwise(src, (r, g, b, a) => [lut[r | 0], lut[g | 0], lut[b | 0], a]);
  },
  levels(src, P) {
    const inB = clamp(Number(P.inB) || 0, 0, 1) * 255;
    const inW = clamp(P.inW === undefined ? 1 : Number(P.inW), 0, 1) * 255;
    const g = clamp(Number(P.gamma) || 1, 0.1, 3);
    const outB = clamp(Number(P.outB) || 0, 0, 1) * 255;
    const outW = clamp(P.outW === undefined ? 1 : Number(P.outW), 0, 1) * 255;
    const lut = new Uint8ClampedArray(256);
    const range = Math.max(1, inW - inB);
    for (let i = 0; i < 256; i++) {
      const t = clamp((i - inB) / range, 0, 1);
      lut[i] = outB + Math.pow(t, 1 / g) * (outW - outB);
    }
    return pixelwise(src, (r, g2, b, a) => [lut[r | 0], lut[g2 | 0], lut[b | 0], a]);
  },
  tint(src, P) {
    const [tr, tg, tb] = hex2rgb(P.color);
    const k = clamp(Number(P.amount) || 0, 0, 1);
    const keep = P.keepLum !== false;
    return pixelwise(src, (r, g, b, a) => {
      let nr = r * (1 - k) + tr * k, ng = g * (1 - k) + tg * k, nb = b * (1 - k) + tb * k;
      if (keep) {
        const l0 = luma(r, g, b), l1 = Math.max(1e-3, luma(nr, ng, nb));
        const f = l0 / l1;
        nr *= f; ng *= f; nb *= f;
      }
      return [nr, ng, nb, a];
    });
  },
  gradmap(src, P) {
    const A = hex2rgb(P.colorA), Bc = hex2rgb(P.colorB);
    const k = clamp(Number(P.amount) ?? 1, 0, 1);
    return pixelwise(src, (r, g, b, a) => {
      const t = clamp(luma(r, g, b) / 255, 0, 1);
      const mr = A[0] + (Bc[0] - A[0]) * t, mg = A[1] + (Bc[1] - A[1]) * t, mb = A[2] + (Bc[2] - A[2]) * t;
      return [r + (mr - r) * k, g + (mg - g) * k, b + (mb - b) * k, a];
    });
  },
  balance(src, P) {
    const k = 1 + (Number(P.r) || 0), k2 = 1 + (Number(P.g) || 0), k3 = 1 + (Number(P.b) || 0);
    return pixelwise(src, (r, g, b, a) => [r * k, g * k2, b * k3, a]);
  },
  channel(src, P) {
    const m = String(P.map || 'rgb');
    const src3 = { r: 0, g: 1, b: 2 };
    const out = [src3[m[0]], src3[m[1]], src3[m[2]]];
    const k = clamp(Number(P.amount) ?? 1, 0, 1);
    return pixelwise(src, (r, g, b, a) => {
      const c = [r, g, b];
      const nr = c[out[0]], ng = c[out[1]], nb = c[out[2]];
      return [r + (nr - r) * k, g + (ng - g) * k, b + (nb - b) * k, a];
    });
  },
  invert(src, P) {
    const k = clamp(Number(P.amount) ?? 1, 0, 1);
    return pixelwise(src, (r, g, b, a) => [r + (255 - 2 * r) * k, g + (255 - 2 * g) * k, b + (255 - 2 * b) * k, a]);
  },

  /* ---------- 扭曲与失真 ---------- */
  noiseWarp(src, P) {
    const amt = Number(P.amount) || 0;
    const scale = Math.max(1, Number(P.scale) || 8);
    const seed = Math.round(Number(P.seed) || 0);
    return resample(src, (u, v) => {
      const nx = vnoise(u * scale, v * scale, seed, scale) - 0.5;
      const ny = vnoise(u * scale + 37.7, v * scale + 91.3, seed + 7, scale) - 0.5;
      return [u + nx * amt * 2, v + ny * amt * 2];
    });
  },
  ripple(src, P) {
    const amp = Number(P.amp) || 0;
    const freq = Number(P.freq) || 12;
    const ph = Number(P.phase) || 0;
    const vert = !!P.vertical;
    return resample(src, (u, v) => {
      const t = vert ? v : u;
      const d = Math.sin(t * freq * 6.2831853 + ph) * amp;
      return vert ? [u + d, v] : [u, v + d];
    });
  },
  swirl(src, P) {
    const amt = Number(P.amount) || 0;
    const R = Math.max(0.05, Number(P.radius) || 0.5);
    const cx = Number(P.cx) ?? 0.5, cy = Number(P.cy) ?? 0.5;
    return resample(src, (u, v) => {
      const dx = u - cx, dy = v - cy;
      const d = Math.hypot(dx, dy);
      const t = clamp(1 - d / R, 0, 1);
      const a = amt * t * t;
      const s = Math.sin(a), c = Math.cos(a);
      return [cx + dx * c - dy * s, cy + dx * s + dy * c];
    });
  },
  lens(src, P) {
    const amt = Number(P.amount) || 0;
    const zoom = Math.max(0.05, Number(P.zoom) || 1);
    return resample(src, (u, v) => {
      const dx = u - 0.5, dy = v - 0.5;
      const r2 = dx * dx + dy * dy;
      const f = (1 + amt * r2) / zoom;
      return [0.5 + dx * f, 0.5 + dy * f];
    });
  },
  polar(src, P) {
    const rot = (Number(P.rotate) || 0) / 360;
    const r2p = P.mode !== 'p2r';
    return resample(src, (u, v) => {
      if (r2p) {
        const a = u * Math.PI * 2;
        const r = v;
        return [0.5 + Math.cos(a) * r * 0.5, 0.5 + Math.sin(a) * r * 0.5];
      }
      const dx = u - 0.5, dy = v - 0.5;
      const a = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
      const r = Math.hypot(dx, dy) * 2;
      return [(a + rot) % 1, r];
    });
  },
  pixelate(src, P) {
    const n = Math.max(2, Math.round(Number(P.size) || 8));
    const W = src.width, H = src.height;
    const out = cv(W, H);
    const g = out.getContext('2d');
    g.imageSmoothingEnabled = false;
    const tw = Math.max(1, Math.round(W / n)), th = Math.max(1, Math.round(H / n));
    const small = cv(tw, th);
    small.getContext('2d').drawImage(src, 0, 0, tw, th);
    g.drawImage(small, 0, 0, tw, th, 0, 0, W, H);
    return out;
  },
  scanline(src, P) {
    const period = Math.max(2, Number(P.period) || 4);
    const k = clamp(Number(P.strength) || 0, 0, 1);
    const vert = !!P.vertical;
    return pixelwise(src, (r, g, b, a, x, y) => {
      const t = ((vert ? x : y) % period) / period;
      const f = 1 - k * (0.5 - 0.5 * Math.cos(t * 6.2831853));
      return [r * f, g * f, b * f, a];
    });
  },
  glitch(src, P) {
    const amt = Number(P.amount) || 0;
    const slices = Math.max(1, Math.round(Number(P.slices) || 12));
    const seed = Math.round(Number(P.seed) || 0);
    const W = src.width, H = src.height;
    const out = cv(W, H);
    const g = out.getContext('2d');
    g.drawImage(src, 0, 0);
    const rnd = (i) => vnoise(i * 13.7, seed * 3.1, seed, 97);
    for (let i = 0; i < slices; i++) {
      const y0 = Math.floor(i / slices * H);
      const h = Math.ceil(H / slices);
      const dx = (rnd(i) - 0.5) * 2 * amt * W;
      g.drawImage(src, 0, y0, W, h, dx, y0, W, h);
    }
    if (P.colorSplit) {
      const shift = Math.max(1, amt * W * 0.25);
      g.globalCompositeOperation = 'screen';
      g.globalAlpha = 0.5;
      g.drawImage(src, shift, 0);
      g.drawImage(src, -shift, 0);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return out;
  },
  blur(src, P) { return boxBlur(src, Number(P.radius) || 0); },
  sharpen(src, P) {
    const k = Number(P.amount) || 0;
    const blurred = boxBlur(src, 1, 1);
    const A = data(src).data, Bv = data(blurred).data;
    const img = data(src);
    for (let i = 0; i < img.data.length; i += 4) {
      for (let c = 0; c < 3; c++) img.data[i + c] = clamp(A[i + c] + (A[i + c] - Bv[i + c]) * k, 0, 255);
    }
    return put(src, img);
  },

  /* ---------- 风格化结构 ---------- */
  outline(src, P) {
    const [or, og, ob] = hex2rgb(P.color);
    const w = Math.max(1, Math.round(Number(P.width) || 1));
    const th = clamp(Number(P.threshold) ?? 0.25, 0, 1) * 255;
    const W = src.width, H = src.height;
    const s = sampler(src);
    const img = data(src);
    const d = img.data;
    const L = new Float32Array(W * H);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) L[p] = luma(d[i], d[i + 1], d[i + 2]);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W, v = (y + 0.5) / H;
        const gx = (L[wrap(y, H) * W + wrap(x + w, W)] - L[wrap(y, H) * W + wrap(x - w, W)]) / (2 * w);
        const gy = (L[wrap(y + w, H) * W + wrap(x, W)] - L[wrap(y - w, H) * W + wrap(x, W)]) / (2 * w);
        if (Math.hypot(gx, gy) > th) {
          const i = (y * W + x) * 4;
          d[i] = or; d[i + 1] = og; d[i + 2] = ob;
        }
      }
    }
    s;   // 采样器仅用于保持环绕语义，这里直接用索引环绕
    return put(src, img);
  },
  halftone(src, P) {
    const size = Math.max(2, Number(P.size) || 6);
    const ang = (Number(P.angle) || 0) * Math.PI / 180;
    const mix = clamp(Number(P.mix) ?? 1, 0, 1);
    const W = src.width, H = src.height;
    const s = sampler(src);
    const out = cv(W, H);
    const g = out.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    const step = size;
    const cs = Math.cos(ang) * step, sn = Math.sin(ang) * step;
    const diag = Math.ceil((W + H) / step) + 2;
    for (let j = -diag; j < diag; j++) {
      for (let i = -diag; i < diag; i++) {
        const px = i * cs - j * sn + W / 2;
        const py = i * sn + j * cs + H / 2;
        if (px < -step || py < -step || px > W + step || py > H + step) continue;
        const c = s(px / W, py / H);
        const l = luma(c[0], c[1], c[2]) / 255;
        const rr = (1 - l) * step * 0.72;
        const col = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
        g.globalAlpha = mix;
        g.fillStyle = col;
        g.beginPath();
        g.arc(px, py, rr, 0, 6.2831853);
        g.fill();
        g.globalAlpha = 1;
      }
    }
    return out;
  },
  mosaic(src, P) {
    const size = Math.max(2, Number(P.size) || 6);
    const gap = Math.max(0, Number(P.gap) || 0);
    const mortar = String(P.mortar || '#000000');
    const W = src.width, H = src.height;
    const s = sampler(src);
    const out = cv(W, H);
    const g = out.getContext('2d');
    g.fillStyle = mortar;
    g.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += size) {
      for (let x = 0; x < W; x += size) {
        const c = s((x + size / 2) / W, (y + size / 2) / H);
        g.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
        g.fillRect(x + gap / 2, y + gap / 2, size - gap, size - gap);
      }
    }
    return out;
  },
  hex(src, P) {
    const size = Math.max(4, Number(P.size) || 16);
    const gap = clamp(Number(P.gap) || 0, 0, 0.5);
    const mortar = String(P.mortar || '#000000');
    const W = src.width, H = src.height;
    const s = sampler(src);
    const out = cv(W, H);
    const g = out.getContext('2d');
    g.fillStyle = mortar;
    g.fillRect(0, 0, W, H);
    const dx = size * 1.5;
    const dy = size * Math.sqrt(3);
    const cols = Math.ceil(W / dx) + 2, rows = Math.ceil(H / dy) + 2;
    for (let r = -1; r < rows; r++) {
      for (let c = -1; c < cols; c++) {
        const cx = c * dx;
        const cy = r * dy + (c % 2 ? dy / 2 : 0);
        const col = s(cx / W, cy / H);
        g.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
        const R = size * (1 - gap) * 0.52;
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = k * Math.PI / 3;
          const px = wrap(cx + Math.cos(a) * R, W), py = wrap(cy + Math.sin(a) * R, H);
          if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath();
        g.fill();
      }
    }
    return out;
  },
  brick(src, P) {
    const rows = Math.max(1, Math.round(Number(P.rows) || 6));
    const cols = Math.max(1, Math.round(Number(P.cols) || 6));
    const offset = Number(P.offset) || 0;
    const gap = Math.max(0, Number(P.gap) || 0);
    const mortar = String(P.mortar || '#000000');
    const W = src.width, H = src.height;
    const s = sampler(src);
    const out = cv(W, H);
    const g = out.getContext('2d');
    g.fillStyle = mortar;
    g.fillRect(0, 0, W, H);
    const bw = W / cols, bh = H / rows;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2 ? offset : 0) * bw;
      for (let c = -1; c <= cols; c++) {
        const x = c * bw + off;
        const col = s((x + bw / 2) / W, (r * bh + bh / 2) / H);
        g.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
        g.fillRect(x + gap / 2, r * bh + gap / 2, bw - gap, bh - gap);
        if (x < 0) g.fillRect(x + W + gap / 2, r * bh + gap / 2, bw - gap, bh - gap);
      }
    }
    return out;
  },
  edge(src, P) {
    const k = Number(P.strength) || 0;
    const color = !!P.color;
    const W = src.width, H = src.height;
    const d = data(src).data;
    const img = data(src);
    const o = img.data;
    const L = new Float32Array(W * H);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) L[p] = luma(d[i], d[i + 1], d[i + 2]);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const xm = wrap(x - 1, W), xp = wrap(x + 1, W), ym = wrap(y - 1, H), yp = wrap(y + 1, H);
        const i = (y * W + x) * 4;
        let v;
        if (color) {
          const gx = [0, 1, 2].map((c) => d[(y * W + xp) * 4 + c] - d[(y * W + xm) * 4 + c]);
          const gy = [0, 1, 2].map((c) => d[(yp * W + x) * 4 + c] - d[(ym * W + x) * 4 + c]);
          for (let c = 0; c < 3; c++) v = Math.hypot(gx[c], gy[c]) * k;
          o[i] = clamp(Math.hypot(gx[0], gy[0]) * k, 0, 255);
          o[i + 1] = clamp(Math.hypot(gx[1], gy[1]) * k, 0, 255);
          o[i + 2] = clamp(Math.hypot(gx[2], gy[2]) * k, 0, 255);
          continue;
        }
        const gx = L[y * W + xp] - L[y * W + xm];
        const gy = L[yp * W + x] - L[ym * W + x];
        v = clamp(Math.hypot(gx, gy) * k, 0, 255);
        o[i] = o[i + 1] = o[i + 2] = v;
      }
    }
    return put(src, img);
  },
  posterize(src, P) {
    const n = Math.max(2, Math.round(Number(P.steps) || 6));
    const q = 255 / (n - 1);
    return pixelwise(src, (r, g, b, a) => [Math.round(r / q) * q, Math.round(g / q) * q, Math.round(b / q) * q, a]);
  },
  dither(src, P) {
    const n = Math.max(2, Math.round(Number(P.levels) || 4));
    const q = 255 / (n - 1);
    const m = P.mode === 'noise' ? null : (BAYER[Number(String(P.mode || 'bayer4').slice(5))] || BAYER[4]);
    const dim = m ? m.length : 1;
    return pixelwise(src, (r, g, b, a, x, y) => {
      const t = m ? (m[y % dim][x % dim] / (dim * dim) - 0.5) : (vnoise(x, y, 7, 1024) - 0.5);
      const f = (v) => clamp(Math.round(v / q + t) * q, 0, 255);
      return [f(r), f(g), f(b), a];
    });
  },

  /* ---------- 叠加与创意 ---------- */
  mirror(src, P) {
    const mode = String(P.mode || 'quad');
    const W = src.width, H = src.height;
    const out = cv(W, H);
    const g = out.getContext('2d');
    const hw = W / 2, hh = H / 2;
    g.drawImage(src, 0, 0, hw, hh, 0, 0, hw, hh);
    if (mode === 'x' || mode === 'quad') {
      g.save(); g.translate(W, 0); g.scale(-1, 1);
      g.drawImage(src, 0, 0, hw, H, 0, 0, hw, H);
      g.restore();
    }
    if (mode === 'y' || mode === 'quad') {
      g.save(); g.translate(0, H); g.scale(1, -1);
      g.drawImage(src, 0, 0, W, hh, 0, 0, W, hh);
      g.restore();
    }
    return out;
  },
  kaleido(src, P) {
    const seg = Math.max(2, Math.round(Number(P.segments) || 6));
    const rot = (Number(P.rotate) || 0) / 360;
    return resample(src, (u, v) => {
      const dx = u - 0.5, dy = v - 0.5;
      let a = Math.atan2(dy, dx) / Math.PI;
      const r = Math.hypot(dx, dy);
      const s = 2 / seg;
      a = wrap(a - rot, 2 * s);
      if (a > s) a = 2 * s - a;
      const ang = a * Math.PI + rot * 2 * Math.PI;
      return [0.5 + Math.cos(ang) * r, 0.5 + Math.sin(ang) * r];
    });
  },
  tileRearrange(src, P) {
    const cols = Math.max(1, Math.round(Number(P.cols) || 4));
    const rows = Math.max(1, Math.round(Number(P.rows) || 4));
    const jitter = clamp(Number(P.jitter) || 0, 0, 1);
    const rot = (Number(P.rotate) || 0) * Math.PI / 180;
    const seed = Math.round(Number(P.seed) || 1);
    const W = src.width, H = src.height;
    const out = cv(W, H);
    const g = out.getContext('2d');
    const tw = W / cols, th = H / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const n1 = vnoise(c * 5.3, r * 7.1, seed, cols * rows + 3) - 0.5;
        const n2 = vnoise(c * 9.7 + 31, r * 3.3, seed + 11, cols * rows + 3) - 0.5;
        const n3 = vnoise(c * 2.1, r * 13.9 + 17, seed + 23, cols * rows + 3) - 0.5;
        const dx = n1 * jitter * tw * 2;
        const dy = n2 * jitter * th * 2;
        // 从源图随机位置取一块贴到目标格（环绕平移 → 仍然无缝）
        const sx = wrap(c * tw + n3 * tw, W), sy = wrap(r * th + n1 * th, H);
        g.save();
        g.beginPath();
        g.rect(c * tw, r * th, tw, th);
        g.clip();
        g.translate(c * tw + tw / 2 + dx, r * th + th / 2 + dy);
        if (rot) g.rotate(rot);
        g.drawImage(src, -sx, -sy);
        g.drawImage(src, -sx + W, -sy);
        g.drawImage(src, -sx, -sy + H);
        g.drawImage(src, -sx + W, -sy + H);
        g.restore();
      }
    }
    return out;
  },
  glow(src, P) {
    const th = clamp(Number(P.threshold) || 0, 0, 1) * 255;
    const radius = Number(P.radius) || 8;
    const k = Number(P.strength) || 1;
    const [cr, cg, cb] = hex2rgb(P.color);
    const W = src.width, H = src.height;
    const bright = cv(W, H);
    const bd = data(src).data;
    const bi = bright.getContext('2d').createImageData(W, H);
    for (let i = 0; i < bd.length; i += 4) {
      const l = luma(bd[i], bd[i + 1], bd[i + 2]);
      const f = l > th ? (l - th) / Math.max(1, 255 - th) : 0;
      bi.data[i] = cr * f; bi.data[i + 1] = cg * f; bi.data[i + 2] = cb * f;
      bi.data[i + 3] = 255;
    }
    put(bright, bi);
    const blurred = boxBlur(bright, radius, 2);
    const out = cv(W, H);
    const g = out.getContext('2d');
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = clamp(k, 0, 3);
    g.drawImage(blurred, 0, 0);
    return out;
  },
  aberration(src, P) {
    const amt = Number(P.amount) || 0;
    const ang = (Number(P.angle) || 0) * Math.PI / 180;
    const radial = !!P.radial;
    const W = src.width, H = src.height;
    const dx = Math.cos(ang) * amt / W, dy = Math.sin(ang) * amt / H;
    const s = sampler(src);
    const out = cv(W, H);
    const img = out.getContext('2d').createImageData(W, H);
    const o = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W, v = (y + 0.5) / H;
        let ox = dx, oy = dy;
        if (radial) {
          const r = Math.hypot(u - 0.5, v - 0.5);
          ox = dx * r * 2; oy = dy * r * 2;
        }
        const R = s(u + ox, v + oy), G = s(u, v), B = s(u - ox, v - oy);
        const i = (y * W + x) * 4;
        o[i] = R[0]; o[i + 1] = G[1]; o[i + 2] = B[2]; o[i + 3] = G[3];
      }
    }
    return put(out, img);
  },
};

/* ============================================================
   配方（recipe）数据模型
   ============================================================ */
export function defaultLayer(opId) {
  const op = OP_BY_ID[opId];
  const params = {};
  if (op) for (const p of op.p) params[p.k] = p.d;
  return {
    id: 'tl' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    op: opId,
    enabled: true,
    opacity: 1,
    blend: 'normal',
    input: opId === 'image' ? '' : 'below',   // 'below' 下层结果 / 'source' 源图 / 'asset:<id>' 贴图素材
    params,
  };
}

export function newTexMod(name, source) {
  return {
    version: TEXMOD_VERSION,
    id: 'tm' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    name: String(name || '贴图修改器'),
    source: source || '',
    output: '',
    size: 512,
    layers: [],
    created: Date.now(),
  };
}

/** 归一化（读存档 / 导入关卡时用）：丢弃未知算子，补齐参数默认值 */
export function normalizeTexMod(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = newTexMod(raw.name, raw.source);
  out.id = raw.id || out.id;
  out.output = typeof raw.output === 'string' ? raw.output : '';
  out.size = clamp(Math.round(Number(raw.size) || 512), TEXMOD_MIN, TEXMOD_MAX);
  out.created = raw.created || out.created;
  const list = Array.isArray(raw.layers) ? raw.layers : [];
  out.layers = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const op = OP_BY_ID[r.op];
    if (!op) continue;
    const l = defaultLayer(r.op);
    l.id = r.id || l.id;
    l.enabled = r.enabled !== false;
    l.opacity = clamp(Number(r.opacity ?? 1), 0, 1);
    l.blend = BLEND_CANVAS[r.blend] ? r.blend : 'normal';
    l.input = typeof r.input === 'string' ? r.input : (r.op === 'image' ? '' : 'below');
    for (const p of op.p) {
      const v = r.params && r.params[p.k];
      l.params[p.k] = v === undefined || v === null ? p.d : v;
    }
    out.layers.push(l);
  }
  return out;
}

/** 关卡里是否已有引用这张（派生的）素材的修改器 */
export function texModByOutput(level, assetId) {
  const full = 'asset:' + String(assetId || '');
  const list = (level && level.texMods) || [];
  return list.find((m) => m && m.output === full) || null;
}



/* ============================================================
   烘焙：把配方算成一张画布（进入游戏之前一次性完成）
   ============================================================ */
export function texModSize(cfg, src) {
  const s = Math.round(Number(cfg && cfg.size) || 0);
  if (s) return clamp(s, TEXMOD_MIN, TEXMOD_MAX);
  const w = (src && src.width) || 512;
  return clamp(w, TEXMOD_MIN, TEXMOD_MAX);
}

/**
 * @param {object} cfg 配方
 * @param {HTMLCanvasElement} sourceCanvas 源贴图像素
 * @param {{resolve?:(id:string,size:number)=>HTMLCanvasElement|null}} opts
 * @returns {HTMLCanvasElement} 烘焙结果（size×size）
 */
export function bakeTexMod(cfg, sourceCanvas, opts = {}) {
  const size = texModSize(cfg, sourceCanvas);
  const src = cloneCanvas(sourceCanvas || cv(size, size), size);
  let acc = cloneCanvas(src);
  for (const layer of ((cfg && cfg.layers) || [])) {
    if (!layer || layer.enabled === false) continue;
    if (!OP_BY_ID[layer.op]) continue;
    let c;
    const inId = layer.input;
    const external = inId && inId !== 'below' && inId !== 'source';
    if (external) {
      c = opts.resolve ? opts.resolve(inId, size) : null;
      if (!c) c = cloneCanvas(acc);
    } else {
      c = cloneCanvas(inId === 'source' ? src : acc);
    }
    if (layer.op !== 'image') {
      const fn = OPS_FN[layer.op];
      if (fn) {
        try { c = fn(c, layer.params || {}, { size, resolve: opts.resolve }) || c; }
        catch (e) { console.warn('[texmod] 算子失败', layer.op, e); }
      }
    }
    const g = acc.getContext('2d');
    g.save();
    g.globalAlpha = clamp(Number(layer.opacity ?? 1), 0, 1);
    g.globalCompositeOperation = BLEND_CANVAS[layer.blend] || 'source-over';
    g.drawImage(c, 0, 0, size, size);
    g.restore();
  }
  return acc;
}

/** 烘焙结果 → PNG Blob（写进存档素材文件夹） */
export function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), 'image/png');
    else resolve(null);
  });
}