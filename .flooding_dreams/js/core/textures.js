/* ============================================================
   程序化贴图库（梦核 / 超现实 / 拼贴风）—— 无外部图片依赖
   ============================================================ */
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { resolveAssetURL } from './settings.js';
import { store } from './storage.js';
import { loadBuiltinManifest, builtinFamily, isExtendedId } from './builtin-assets.js';
import { PARTICLE_BUILTINS } from './particle-presets.js';
import { clearModulationStats } from './material-modulation.js';
import { SKYMOD_MAX, SKYMOD_BY_ID } from './sky-modifier.js';

const _cache = new Map();

function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  return { c, x: ctx };
}
function rnd(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
/** 圆角矩形路径（不依赖 ctx.roundRect，兼容旧浏览器） */
function roundRect(x, px, py, pw, ph, r) {
  const rr = Math.min(r, pw * 0.5, ph * 0.5);
  x.beginPath();
  x.moveTo(px + rr, py);
  x.lineTo(px + pw - rr, py); x.quadraticCurveTo(px + pw, py, px + pw, py + rr);
  x.lineTo(px + pw, py + ph - rr); x.quadraticCurveTo(px + pw, py + ph, px + pw - rr, py + ph);
  x.lineTo(px + rr, py + ph); x.quadraticCurveTo(px, py + ph, px, py + ph - rr);
  x.lineTo(px, py + rr); x.quadraticCurveTo(px, py, px + rr, py);
  x.closePath();
}
/** 向上的箭头路径（顶点在上，带箭杆） */
function chevronUp(x, cx, cy, s) {
  x.beginPath();
  x.moveTo(cx, cy - s);
  x.lineTo(cx + s * 0.86, cy + s * 0.06);
  x.lineTo(cx + s * 0.36, cy + s * 0.06);
  x.lineTo(cx + s * 0.36, cy + s * 0.92);
  x.lineTo(cx - s * 0.36, cy + s * 0.92);
  x.lineTo(cx - s * 0.36, cy + s * 0.06);
  x.lineTo(cx - s * 0.86, cy + s * 0.06);
  x.closePath();
}
function tex(canvas, repeat = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const S = 256;

/* ---------- 各贴图绘制 ---------- */
const painters = {
  grid(x, w, h) {
    x.fillStyle = '#ded8ee'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#b3a9cf'; x.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      const p = (i / 4) * w;
      x.beginPath(); x.moveTo(p, 0); x.lineTo(p, h); x.stroke();
      x.beginPath(); x.moveTo(0, p); x.lineTo(w, p); x.stroke();
    }
    x.strokeStyle = '#8d81b8'; x.lineWidth = 4; x.strokeRect(0, 0, w, h);
  },
  bricks(x, w, h) {
    x.fillStyle = '#8a7f9e'; x.fillRect(0, 0, w, h);
    const bh = h / 8, bw = w / 4;
    const r = rnd(7);
    for (let row = 0; row < 8; row++) {
      const off = (row % 2) * bw * 0.5;
      for (let col = -1; col < 5; col++) {
        const bx = col * bw + off + 2, by = row * bh + 2;
        const tint = 150 + r() * 60;
        x.fillStyle = `rgb(${tint | 0},${(tint * 0.88) | 0},${(tint * 1.05) | 0})`;
        x.fillRect(bx, by, bw - 4, bh - 4);
      }
    }
    x.globalAlpha = 0.14;
    for (let i = 0; i < 260; i++) { x.fillStyle = r() > 0.5 ? '#fff' : '#2a2340'; x.fillRect(r() * w, r() * h, 3, 3); }
    x.globalAlpha = 1;
  },
  cloud(x, w, h) {
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#cfe7ff'); g.addColorStop(0.5, '#f4e6ff'); g.addColorStop(1, '#ffd9ec');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    const r = rnd(21);
    for (let i = 0; i < 26; i++) {
      const cx = r() * w, cy = r() * h, rad = 18 + r() * 54;
      const rg = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
      rg.addColorStop(0, 'rgba(255,255,255,.85)');
      rg.addColorStop(0.55, 'rgba(255,255,255,.35)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = rg; x.beginPath(); x.arc(cx, cy, rad, 0, 6.283); x.fill();
    }
  },
  noise(x, w, h) {
    const img = x.createImageData(w, h), r = rnd(99);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 120 + r() * 120;
      img.data[i] = v * 0.95; img.data[i + 1] = v * 0.92; img.data[i + 2] = v * 1.06; img.data[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    x.globalAlpha = 0.1;
    for (let i = 0; i < 40; i++) { x.fillStyle = '#fff'; x.fillRect(0, r() * h, w, 1); }
    x.globalAlpha = 1;
  },
  tiles(x, w, h) {
    const r = rnd(5);
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      const v = 200 + r() * 55;
      x.fillStyle = `rgb(${v | 0},${(v * 0.96) | 0},${(v * 1.02) | 0})`;
      x.fillRect(a * w / 4, b * h / 4, w / 4 - 2, h / 4 - 2);
    }
    x.strokeStyle = 'rgba(60,50,90,.55)'; x.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      x.beginPath(); x.moveTo(i * w / 4 - 1, 0); x.lineTo(i * w / 4 - 1, h); x.stroke();
      x.beginPath(); x.moveTo(0, i * h / 4 - 1); x.lineTo(w, i * h / 4 - 1); x.stroke();
    }
  },
  arrowsUp(x, w, h) {
    // 背景：深色石板 + 竖向渐变，衬托发光箭头
    const bg = x.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#16213a'); bg.addColorStop(0.55, '#123038'); bg.addColorStop(1, '#0e2030');
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    // 斜向细纹（墙面质感）
    x.globalAlpha = 0.06; x.strokeStyle = '#bfe9ff'; x.lineWidth = 2;
    for (let i = -h; i < w + h; i += 14) {
      x.beginPath(); x.moveTo(i, 0); x.lineTo(i - h, h); x.stroke();
    }
    x.globalAlpha = 1;

    const n = 4, cell = w / n;
    const r = rnd(77);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const ox = a * cell, oy = b * cell, pad = cell * 0.09;
      // 内嵌面板：亮面在上、暗面在下 → 立体凹陷
      x.fillStyle = '#1b2f42';
      roundRect(x, ox + pad, oy + pad, cell - pad * 2, cell - pad * 2, cell * 0.13);
      x.fill();
      x.strokeStyle = 'rgba(180,255,235,.16)'; x.lineWidth = 2; x.stroke();
      x.fillStyle = 'rgba(0,0,0,.28)';
      roundRect(x, ox + pad, oy + cell * 0.5, cell - pad * 2, cell * 0.5 - pad, cell * 0.13);
      x.fill();

      const cx = ox + cell / 2, cy = oy + cell / 2, s = cell * 0.3;
      // 双层箭头（下暗上亮，像向上流动的指示）+ 外发光
      for (let k = 1; k >= 0; k--) {
        const dy = k ? s * 0.5 : -s * 0.18;
        const g = x.createLinearGradient(cx, cy + dy - s, cx, cy + dy + s);
        g.addColorStop(0, k ? 'rgba(90,240,205,.45)' : '#e9fff8');
        g.addColorStop(0.45, k ? 'rgba(58,208,160,.6)' : '#5ff0c4');
        g.addColorStop(1, k ? 'rgba(30,140,120,.4)' : '#17b98d');
        x.save();
        x.shadowColor = k ? 'rgba(60,200,170,.5)' : 'rgba(120,255,225,.75)';
        x.shadowBlur = k ? 8 : 16;
        x.fillStyle = g;
        chevronUp(x, cx, cy + dy, s);
        x.fill();
        x.restore();
      }
    }

    // 顶部微亮 / 底部压暗，强化“向上”的感觉
    const vg = x.createLinearGradient(0, 0, 0, h);
    vg.addColorStop(0, 'rgba(190,255,240,.14)');
    vg.addColorStop(0.5, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.28)');
    x.fillStyle = vg; x.fillRect(0, 0, w, h);
    // 细颗粒
    x.globalAlpha = 0.08;
    for (let i = 0; i < 140; i++) { x.fillStyle = r() > 0.5 ? '#ffffff' : '#04211c'; x.fillRect(r() * w, r() * h, 2, 2); }
    x.globalAlpha = 1;
  },
  stripes(x, w, h) {
    x.fillStyle = '#fdf6e8'; x.fillRect(0, 0, w, h);
    x.save(); x.translate(0, 0); x.rotate(-0.5);
    x.fillStyle = '#ff9ec9';
    for (let i = -h; i < w * 2; i += 42) x.fillRect(i, -h, 18, h * 3);
    x.restore();
  },
  checker(x, w, h) {
    const n = 8, c = w / n;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      x.fillStyle = ((a + b) % 2) ? '#2c2748' : '#f6f0ff';
      x.fillRect(a * c, b * c, c, c);
    }
  },
  carpet(x, w, h) {
    x.fillStyle = '#6a4b7a'; x.fillRect(0, 0, w, h);
    const r = rnd(31);
    for (let i = 0; i < 1400; i++) {
      const v = r();
      x.strokeStyle = v > 0.5 ? 'rgba(255,220,255,.25)' : 'rgba(30,10,50,.3)';
      x.lineWidth = 1.6;
      const cx = r() * w, cy = r() * h;
      x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx, cy + 4); x.stroke();
    }
    x.strokeStyle = 'rgba(255,217,138,.5)'; x.lineWidth = 5;
    x.strokeRect(12, 12, w - 24, h - 24);
    x.strokeRect(26, 26, w - 52, h - 52);
  },
};

const _builtinIds = ['grid', 'bricks', 'cloud', 'noise', 'tiles', 'arrowsUp', 'stripes',
  'checker', 'carpet'];

/** 获取内置贴图（同步）。id 为空/未知 → null */
export function getTexture(id) {
  if (!id || id === 'none') return null;
  // 导入的图片素材（asset: / file:）已在 registerLevelTextures / 导入时注册进缓存，直接复用
  if (_cache.has(id)) return _cache.get(id);
  if (id.startsWith('asset:') || id.startsWith('file:')) return null;
  const p = painters[id];
  if (!p) return null;
  const { c, x } = cv(S, S);
  try { p(x, S, S); } catch (e) { console.warn('[tex]', id, e); }
  const t = tex(c);
  _cache.set(id, t);
  return t;
}

/** 贴图预览 dataURL（编辑器 UI 用） */
export function texturePreviewURL(id, size = 48) {
  if (!id || id === 'none') return null;
  const key = `prev:${id}:${size}`;
  if (_cache.has(key)) return _cache.get(key);
  const p = painters[id];
  if (!p) return null;
  const { c, x } = cv(size, size);
  try { p(x, size, size); } catch (e) { /* ignore */ }
  const url = c.toDataURL();
  _cache.set(key, url);
  return url;
}

/* ---------- SVG 素材：矢量按需光栅化成高分辨率位图 ----------
   <img> 直接加载 SVG 时，浏览器按 SVG 的固有尺寸（viewBox / width / height）光栅化，
   这个尺寸往往很小；贴到大物体上就会被放大成马赛克。这里把 SVG 源按最长边重绘到
   一张高分辨率画布（改写 width/height 但保留 viewBox，浏览器才会矢量重绘），
   再作为贴图，保证放大后依然锐利、没有像素块与锯齿。 */

/** SVG 光栅化的最长边上限 */
const SVG_RASTER_MAX = 2048;
let _svgRasterMax = SVG_RASTER_MAX;
/** 引擎拿到渲染器后告知硬件支持的最大贴图尺寸，避免光栅化超出上限 */
export function setMaxTextureSize(n) {
  const v = Number(n);
  if (isFinite(v) && v >= 256) _svgRasterMax = Math.min(SVG_RASTER_MAX, Math.floor(v));
}

/** 素材名是否指向 SVG 矢量图 */
export function isSVGName(name) { return /\.svgz?$/i.test(String(name || '')); }
/** 常见位图后缀：已知是位图时走快速路径，免去类型嗅探 */
const RASTER_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|ico|tiff?|hdr)$/i;

/** 加载图片 URL 为 HTMLImageElement */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

/** 解析一个 SVG 长度值：去掉 px / pt 等单位；百分比与非法值返回 NaN */
function svgLength(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.endsWith('%')) return NaN;      // 百分比相对视口，无法当固有尺寸
  const n = parseFloat(s);
  return isFinite(n) ? n : NaN;
}

/** 从 SVG 源码解析固有尺寸（viewBox 优先，其次 width/height，兜底 300×150） */
function svgIntrinsicSize(text) {
  const attrs = (text.match(/<svg\b[^>]*>/i) || [''])[0];
  const vb = attrs.match(/viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)/i);
  if (vb && Math.abs(+vb[3]) > 0 && Math.abs(+vb[4]) > 0) {
    return { vb: `${+vb[1]} ${+vb[2]} ${+vb[3]} ${+vb[4]}`, w: Math.abs(+vb[3]), h: Math.abs(+vb[4]) };
  }
  const ww = svgLength((attrs.match(/\bwidth\s*=\s*["']([^"']+)["']/i) || [])[1]);
  const hh = svgLength((attrs.match(/\bheight\s*=\s*["']([^"']+)["']/i) || [])[1]);
  if (ww > 0 && hh > 0) return { vb: `0 0 ${ww} ${hh}`, w: ww, h: hh };
  return { vb: '0 0 300 150', w: 300, h: 150 };
}

/**
 * 把 SVG 源按目标像素尺寸重写：保留 viewBox，替换 width/height。
 * 注意：viewBox 必须作为「属性」写回（`viewBox="…"`）。若只把值拼进标签，
 * 会生成 `<svg 0 0 100 100 …>` —— 属性名不能以数字开头，XML 畸形，
 * <img> 加载 SVG 时严格按 XML 解析会直接报错（贴图就永远不显示）。
 * 重写后自检必须带 viewBox，否则返回 null（调用方退回原始 SVG，至少能按固有尺寸显示）。
 */
function rewriteSvgSize(text, size, vb) {
  const m = text.match(/<svg\b[^>]*>/i);
  if (!m) return null;
  const open = m[0]
    .replace(/\swidth\s*=\s*["'][^"']*["']/i, '')
    .replace(/\sheight\s*=\s*["'][^"']*["']/i, '')
    .replace(/\sviewBox\s*=\s*["'][^"']*["']/i, '')
    .replace(/<svg\b/i, `<svg viewBox="${vb}" width="${size.w}" height="${size.h}"`);
  if (!/\bviewBox\s*=/.test(open)) return null;
  return text.slice(0, m.index) + open + text.slice(m.index + m[0].length);
}

/** SVG（URL / Blob）→ 高分辨率画布，等比缩放到最长边 = _svgRasterMax */
async function svgToCanvas(source) {
  const text = typeof source === 'string' ? await (await fetch(source)).text() : await source.text();
  const { vb, w, h } = svgIntrinsicSize(text);
  const scale = _svgRasterMax / Math.max(w, h);
  const size = { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  const shown = rewriteSvgSize(text, size, vb) || text;
  const objURL = URL.createObjectURL(new Blob([shown], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(objURL);
    const { c, x } = cv(size.w, size.h);
    x.drawImage(img, 0, 0, size.w, size.h);
    return c;
  } finally {
    URL.revokeObjectURL(objURL);
  }
}

/** URL → 可注册为贴图的像素源（SVG 走矢量重绘，其余走图片解码） */
async function resolveImageSource(url, name) {
  const svgHint = isSVGName(name) || /^data:image\/svg\+xml/i.test(url);
  if (svgHint) return svgToCanvas(url);
  if (RASTER_EXT_RE.test(String(name || '')) || /^data:image\//i.test(url)) return loadImage(url);
  // 名字未知（blob URL 且没带后缀）：读一下 blob 头判断类型，避免 SVG 被当成位图放大
  try {
    const blob = await (await fetch(url)).blob();
    const head = blob.type ? '' : (await blob.text()).slice(0, 512);
    if (/svg/i.test(blob.type) || /<svg[\s>]/i.test(head)) return svgToCanvas(blob);
    if (/^image\//i.test(blob.type)) return loadImage(url);
  } catch (e) { /* 嗅探失败则按普通图片处理 */ }
  return loadImage(url);
}

/** 加载外部图片（dataURL / URL）为纹理 */
export function textureFromURL(url, opts = {}) {
  const key = 'url:' + url + ':' + JSON.stringify(opts);
  if (_cache.has(key)) return _cache.get(key);
  const t = new THREE.TextureLoader().load(url, (tx) => {
    tx.colorSpace = THREE.SRGBColorSpace;
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    tx.anisotropy = 4;
    tx.needsUpdate = true;
  });
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  _cache.set(key, t);
  return t;
}

/* ---------- 外部图片资源（导入的贴图 / 材质图章） ---------- */

/** 注册任意图片源（HTMLImageElement / canvas）为可复用贴图，id 建议用 'asset:xxx' */
export function registerTexture(id, image) {
  if (!id || !image) return null;
  const key = String(id);
  const old = _cache.get(key);
  if (old && old.image === image) return old;
  const isCanvas = typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement;
  const t = isCanvas ? new THREE.CanvasTexture(image) : new THREE.Texture(image);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  // 缩小走三线性 mipmap、放大走线性插值：消除贴图缩小 / 掠射角下的锯齿闪烁
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  _cache.set(key, t);
  return t;
}

/** 加载 URL 为贴图并注册（返回 Promise<Texture|null>）；name 用于识别 SVG */
export function loadTextureFromURL(id, url, name) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    resolveImageSource(url, name)
      .then((src) => resolve(src ? registerTexture(id, src) : null))
      .catch(() => resolve(null));
  });
}

export function hasTexture(id) { return !!id && _cache.has(String(id)); }

/**
 * 确保一张贴图已就绪：导入的 'asset:xxx' 素材若还没进缓存，就地异步加载。
 * 用于「选了素材贴图但当前会话还没加载过它」的场景（否则材质会拿不到贴图）。
 * 同一 id 的并发请求会合并。返回 Promise<boolean>（最终是否可用）。
 */
const _ensuring = new Map();
export function ensureTexture(id) {
  const key = String(id || '');
  if (!key || key === 'none') return Promise.resolve(false);
  if (_cache.has(key)) return Promise.resolve(true);
  if (!key.startsWith('asset:')) return Promise.resolve(false);
  if (_ensuring.has(key)) return _ensuring.get(key);
  const p = (async () => {
    try {
      const bare = key.slice(6);
      if (isExtendedId(bare)) await loadBuiltinManifest();
      const meta = await store.getAssetMeta(bare);
      const url = await resolveAssetURL(bare);
      if (!url) return false;
      const tex = isHDRName(meta && meta.name)
        ? await loadHDRTexture(key, url)
        : await loadTextureFromURL(key, url, meta && meta.name);
      // 选了扩充内置颜色图 → 顺带把对应的法线 / 粗糙度也加载好，材质才能直接套用
      if (tex && isExtendedId(bare)) await loadBuiltinFamily(key);
      return !!tex;
    } catch (e) { return false; }
    finally { _ensuring.delete(key); }
  })();
  _ensuring.set(key, p);
  return p;
}

/** 加载扩充内置颜色图的法线 / 粗糙度兄弟贴图（已缓存 / 加载失败都静默跳过） */
function loadBuiltinFamily(colorKey) {
  const fam = builtinFamily(colorKey.slice(6));
  if (!fam) return Promise.resolve();
  const jobs = [];
  for (const sib of [fam.normal, fam.rough]) {
    if (!sib) continue;
    const k = 'asset:' + sib;
    if (_cache.has(k) || _ensuring.has(k)) continue;
    jobs.push(ensureTexture(k));
  }
  return jobs.length ? Promise.all(jobs) : Promise.resolve();
}

/**
 * 取一张贴图的「像素源」画布（贴图修改器的输入）。
 *   · 内置程序化贴图：按 size 重绘
 *   · 已注册的 asset:/file: 贴图：从缓存的 Texture.image 绘制
 *   · 尚未注册的素材：异步解析 URL → 解码 → 注册，再绘制
 * HDR 全景图不是 2D 贴图，返回 null。
 */
export async function textureSourceCanvas(id, size = 512) {
  const key = String(id || '');
  const px = Math.max(1, Math.round(size));
  if (!key || key === 'none') return null;
  const p = painters[key];
  if (p) {
    const { c, x } = cv(px, px);
    try { p(x, px, px); } catch (e) { console.warn('[tex]', key, e); }
    return c;
  }
  if (_hdrIds.has(key)) return null;
  let t = _cache.get(key);
  if (!t || !t.image) {
    try {
      const bare = key.startsWith('asset:') ? key.slice(6) : key;
      const url = await resolveAssetURL(bare);
      if (!url) return null;
      const meta = key.startsWith('asset:') ? await store.getAssetMeta(bare) : null;
      t = await loadTextureFromURL(key, url, meta && meta.name);
    } catch (e) { t = null; }
  }
  const img = t && t.image;
  if (!img) return null;
  const { c, x } = cv(px, px);
  try { x.drawImage(img, 0, 0, px, px); } catch (e) { return null; }
  return c;
}

/** 丢弃某个贴图（删除素材 / 素材被替换时用），顺带清掉它的天空盒克隆 */
export function dropTexture(id) {
  const key = String(id || '');
  if (!key) return;
  const t = _cache.get(key);
  if (t && t.dispose) { try { t.dispose(); } catch (e) { /* ignore */ } }
  _cache.delete(key);
  const s = _skyCache.get(key);
  if (s && s.dispose) { try { s.dispose(); } catch (e) { /* ignore */ } }
  _skyCache.delete(key);
  const h = _hdrCache.get(key);
  if (h && h.dispose) { try { h.dispose(); } catch (e) { /* ignore */ } }
  _hdrCache.delete(key);
  _hdrIds.delete(key);
}

/**
 * 扫描关卡里用到的 'asset:xxx' 贴图并异步注册
 * done 回调在全部注册后触发（可用于刷新材质）
 * onProgress(loaded, total)：素材加载进度（含已缓存/失败的计数，用于加载界面）
 *
 * 全部素材并发加载：素材一多时，逐个 await（IndexedDB 读 + 图片解码）会串行叠加，
 * 是自定义贴图关卡加载慢的主因。这里先并发解析 URL，再并发解码图片。
 */
export async function registerLevelTextures(level, done, onProgress) {
  const ids = new Set();
  const walk = (v, d) => {
    if (!v || d > 7) return;
    if (typeof v === 'string') { if (v.startsWith('asset:')) ids.add(v.slice(6)); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
    if (typeof v === 'object') { for (const k in v) walk(v[k], d + 1); }
  };
  walk(level, 0);
  // 扩充内置素材要先等清单就绪，否则解析不到（无 assets 的编译版会直接跳过）
  if ([...ids].some(isExtendedId)) { try { await loadBuiltinManifest(); } catch (e) { /* ignore */ } }
  // 关卡里引用了扩充内置颜色图 → 把对应的法线 / 粗糙度也算进来（导出打包也需要它们）
  for (const id of [...ids]) {
    if (!isExtendedId(id)) continue;
    const fam = builtinFamily(id);
    if (!fam) continue;
    if (fam.normal) ids.add(fam.normal);
    if (fam.rough) ids.add(fam.rough);
  }
  const list = [...ids].filter((id) => !hasTexture('asset:' + id) && !_hdrIds.has('asset:' + id));
  const total = list.length;
  let changed = 0;
  let loaded = 0;
  const report = () => { if (onProgress) { try { onProgress(loaded, total); } catch (e) { /* ignore */ } } };
  report();
  try {
    if (total) {
      // 1) 并发解析所有素材 URL（IndexedDB / blob URL）
      const urls = await Promise.all(list.map(async (id) => {
        try { return await resolveAssetURL(id); } catch (e) { return null; }
      }));
      // 1.5) 并发取素材元数据：按名字区分 .hdr（RGBE）与普通图片
      const metas = await Promise.all(list.map(async (id) => {
        try { return await store.getAssetMeta(id); } catch (e) { return null; }
      }));
      // 2) 并发解码：.hdr 走 RGBELoader，其余走图片解码
      await Promise.all(list.map(async (id, i) => {
        const url = urls[i];
        if (url) {
          try {
            const meta = metas[i];
            const tex = isHDRName(meta && meta.name)
              ? await loadHDRTexture('asset:' + id, url)
              : await loadTextureFromURL('asset:' + id, url, meta && meta.name);
            if (tex) changed++;
          } catch (e) { /* ignore */ }
        }
        loaded++;
        report();
      }));
    }
  } finally {
    // 无论成功失败，只要加载到了新贴图就刷新一次材质
    if (changed && done) { try { done(changed); } catch (e) { console.error(e); } }
  }
  return changed;
}

/* ---------- 天空 / 环境（可替换天空盒） ---------- */
const SKY_W = 1024, SKY_H = 512;
const _skyCache = new Map();

/* 导入的 .hdr 全景天空：RGBE 解码成半浮点贴图，单独缓存（不参与等距柱状克隆） */
const _hdrCache = new Map();
const _hdrIds = new Set();
let _hdrLoader = null;
function hdrLoader() { if (!_hdrLoader) _hdrLoader = new RGBELoader(); return _hdrLoader; }
/** 素材名是否指向 HDR 全景图（RGBE） */
export function isHDRName(name) { return /\.hdr$/i.test(String(name || '')); }

/**
 * 加载 .hdr 全景图为天空贴图（等距柱状反射映射）。
 * 解码后是线性半浮点数据，直接交给背景程序 / PMREM 使用。
 */
export function loadHDRTexture(id, url) {
  return new Promise((resolve) => {
    const key = String(id || '');
    if (!key || !url) { resolve(null); return; }
    const hit = _hdrCache.get(key);
    if (hit) { resolve(hit); return; }
    hdrLoader().load(url, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      tex.needsUpdate = true;
      _hdrCache.set(key, tex);
      _hdrIds.add(key);
      resolve(tex);
    }, undefined, (err) => {
      console.warn('[tex] HDR 加载失败', key, err);
      resolve(null);
    });
  });
}

/* 每种天空的垂直渐变（0 = 天顶，1 = 天底） */
const SKY_GRADS = {
  dream: [[0, '#1b1840'], [0.38, '#4b3f7d'], [0.52, '#8f7bb8'], [0.60, '#e8a7c8'],
    [0.68, '#ffd6b0'], [0.80, '#7d6aa8'], [1, '#191634']],
  night: [[0, '#04061a'], [0.42, '#0b1030'], [0.54, '#161d47'], [0.62, '#232c5e'],
    [0.78, '#0e1330'], [1, '#04050e']],
  dawn: [[0, '#241a44'], [0.34, '#5b3a72'], [0.50, '#c06a86'], [0.58, '#f0a978'],
    [0.66, '#ffe6bd'], [0.80, '#9a86b8'], [1, '#241c3c']],
  deep: [[0, '#04121f'], [0.40, '#0a2e46'], [0.52, '#135a72'], [0.60, '#1f8b8e'],
    [0.74, '#0d4459'], [1, '#03121c']],
  void: [[0, '#0a0616'], [0.44, '#1a0e33'], [0.55, '#2b1150'], [0.64, '#4a1a6b'],
    [0.80, '#1b0d2c'], [1, '#07030f']],
  storm: [[0, '#1a1c26'], [0.44, '#333748'], [0.55, '#5a6070'], [0.62, '#8d93a0'],
    [0.76, '#3c4152'], [1, '#15171f']],
};

/**
 * 取内置天空盒贴图（等距柱状全景）
 * id 见 config.js 的 BUILTIN_SKIES，未收录的 id 回落到 dream
 */
export function getSkyTexture(id = 'dream') {
  const key = SKY_GRADS[id] ? id : 'dream';
  const hit = _skyCache.get(key);
  if (hit) return hit;
  const { c, x } = cv(SKY_W, SKY_H);
  const g = x.createLinearGradient(0, 0, 0, SKY_H);
  for (const [p, col] of SKY_GRADS[key]) g.addColorStop(p, col);
  x.fillStyle = g; x.fillRect(0, 0, SKY_W, SKY_H);
  const r = rnd(777 + key.length * 131);
  if (key === 'night' || key === 'void') {
    // 星空 + 星云
    for (let i = 0; i < 150; i++) {
      const cx = r() * SKY_W, cy = r() * SKY_H * 0.5, rad = 60 + r() * 200;
      const rg = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
      rg.addColorStop(0, `rgba(${key === 'void' ? '190,120,255' : '130,170,255'},.14)`);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = rg; x.beginPath(); x.arc(cx, cy, rad, 0, 6.283); x.fill();
    }
    for (let i = 0; i < 420; i++) {
      const cx = r() * SKY_W, cy = r() * SKY_H * 0.72, s = r() * 1.7 + 0.4;
      x.fillStyle = `rgba(255,255,255,${0.25 + r() * 0.7})`;
      x.beginPath(); x.arc(cx, cy, s, 0, 6.283); x.fill();
    }
  } else if (key === 'deep') {
    // 水下光柱
    for (let i = 0; i < 26; i++) {
      const cx = r() * SKY_W, w = 30 + r() * 90;
      const rg = x.createLinearGradient(cx, 0, cx + w * 0.4, SKY_H);
      rg.addColorStop(0, 'rgba(180,255,255,.20)');
      rg.addColorStop(1, 'rgba(180,255,255,0)');
      x.fillStyle = rg;
      x.beginPath(); x.moveTo(cx, 0); x.lineTo(cx + w, 0); x.lineTo(cx + w * 1.7, SKY_H); x.lineTo(cx + w * 0.5, SKY_H); x.fill();
    }
  } else {
    // 梦核光斑 + 云带
    for (let i = 0; i < 90; i++) {
      const cx = r() * SKY_W, cy = 60 + r() * 300, rad = 20 + r() * 120;
      const rg = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
      const hue = key === 'storm' ? '200,205,215' : key === 'dawn' ? '255,210,190' : (r() > 0.5 ? '255,220,240' : '190,225,255');
      rg.addColorStop(0, `rgba(${hue},.30)`);
      rg.addColorStop(1, `rgba(${hue},0)`);
      x.fillStyle = rg; x.beginPath(); x.arc(cx, cy, rad, 0, 6.283); x.fill();
    }
    for (let i = 0; i < 40; i++) {
      const cx = r() * SKY_W, cy = 120 + r() * 240, rad = 40 + r() * 130;
      const rg = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
      rg.addColorStop(0, key === 'storm' ? 'rgba(150,158,175,.30)' : 'rgba(255,255,255,.22)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = rg; x.beginPath(); x.arc(cx, cy, rad, 0, 6.283); x.fill();
    }
  }
  // 地平线暖光晕（黄昏 / 晨曦）
  if (key === 'dream' || key === 'dawn') {
    const rg = x.createRadialGradient(SKY_W * 0.5, SKY_H * 0.62, 0, SKY_W * 0.5, SKY_H * 0.62, 300);
    rg.addColorStop(0, 'rgba(255,236,205,.55)');
    rg.addColorStop(1, 'rgba(255,236,205,0)');
    x.fillStyle = rg; x.fillRect(0, 0, SKY_W, SKY_H);
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  _skyCache.set(key, t);
  return t;
}

/* 「天空工坊」实时预览用的天空贴图：由编辑器把刚烘焙出来的画布注册进来，
   关卡设置里用 sky = 'skylab:live' 引用它（不进存档，仅编辑器内即时预览） */
let _liveSky = null;
export function setLiveSkyTexture(tex) { _liveSky = tex || null; }

/* ---------- 天空盒修饰器：几何变形 + 色彩 / 曝光 ----------
   scene.background 走 three 内置的背景程序（ShaderLib.backgroundCube）：
   等距柱状全景会先被转成立方体贴图，再按「视线方向」采样，
   纹理自身的 offset / repeat 完全不参与 —— 所以几何修饰只能作用在方向上。
   这里在模块加载时给该着色器打一个补丁，注入固定 SKYMOD_MAX 个槽位：
     几何槽（kind 1..99）：在采样前改写视线方向（无缝连续映射）；
     色彩槽（kind 101..199）：在采样后改写 texColor（线性空间）。
   只改背景采样，环境反射（PMREM）与物理光照不受影响。

   槽位用「单独的 vec4 uniform」而不是 vec4 数组：three 克隆材质 uniform 时
   会把数组 slice 成新数组、且 vec4 数组上传要求元素带 toArray()；
   而单个 vec4 的 value 若是「普通对象」，克隆时是共享引用、上传又按分量缓存，
   于是改 .x/.y/.z/.w 即时生效 —— 既不重编译着色器，也不重建背景贴图。
   空槽 / 未启用的修饰器写成 kind = 0，着色器里直接跳过。 */

/* 槽位的 uniform 数据（普通对象，被 three 克隆后仍是同一引用） */
const _skyModA = [];
const _skyModB = [];
for (let i = 0; i < SKYMOD_MAX; i++) {
  _skyModA.push({ x: 0, y: 0, z: 0, w: 0 });
  _skyModB.push({ x: 0, y: 0, z: 0, w: 0 });
}

/** 生成「逐槽调用」的 GLSL 行 */
function skySlotLines(fn, varName) {
  let s = '';
  for (let i = 0; i < SKYMOD_MAX; i++) {
    s += '\t' + varName + ' = ' + fn + '( ' + varName + ', uSkyMA' + i + '.x, uSkyMA' + i + ', uSkyMB' + i + ' );\n';
  }
  return s;
}

const SKY_MOD_GLSL = `
uniform vec4 uSkyMA0; uniform vec4 uSkyMB0;
uniform vec4 uSkyMA1; uniform vec4 uSkyMB1;
uniform vec4 uSkyMA2; uniform vec4 uSkyMB2;
uniform vec4 uSkyMA3; uniform vec4 uSkyMB3;
uniform vec4 uSkyMA4; uniform vec4 uSkyMB4;
uniform vec4 uSkyMA5; uniform vec4 uSkyMB5;
uniform vec4 uSkyMA6; uniform vec4 uSkyMB6;
uniform vec4 uSkyMA7; uniform vec4 uSkyMB7;

float smLon( vec3 d ){ return atan( d.z, d.x ); }
float smLat( vec3 d ){ return asin( clamp( d.y, -1.0, 1.0 ) ); }
vec3 smFromLonLat( float lon, float lat ){
	lat = clamp( lat, -1.570796326795, 1.570796326795 );
	float cl = cos( lat );
	return vec3( cl * cos( lon ), sin( lat ), cl * sin( lon ) );
}
/* 色相旋转（YIQ，保持亮度） */
vec3 smHue( vec3 c, float a ){
	vec3 yiq = vec3(
		dot( c, vec3( 0.299, 0.587, 0.114 ) ),
		dot( c, vec3( 0.5959, -0.2746, -0.3213 ) ),
		dot( c, vec3( 0.2115, -0.5227, 0.3112 ) ) );
	float ca = cos( a ), sa = sin( a );
	yiq = vec3( yiq.x, yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca );
	return vec3( yiq.x + 0.956 * yiq.y + 0.621 * yiq.z,
	             yiq.x - 0.272 * yiq.y - 0.647 * yiq.z,
	             yiq.x - 1.106 * yiq.y + 1.703 * yiq.z );
}
/* 单个几何修饰：改写视线方向，全部为连续映射（无接缝） */
vec3 skyGeoStep( vec3 d, float kind, vec4 A, vec4 B ){
	if ( kind < 0.5 || kind > 99.5 ) return d;
	float lon = smLon( d ), lat = smLat( d );
	if ( kind < 1.5 ) {                       /* 垂直平移：绕「相机右轴」俯仰（Rodrigues）——
	                                             画面整体上下平移；绕世界轴会随朝向退化成滚转，故不用 */
		vec3 r = normalize( vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] ) );
		float a = A.y, cp = cos( a ), sp = sin( a );
		return normalize( d * cp + cross( r, d ) * sp + r * dot( r, d ) * ( 1.0 - cp ) );
	} else if ( kind < 2.5 ) {                /* 透视扭曲（Möbius，两极不动） */
		float k = clamp( A.y, -0.95, 0.95 );
		float t = lat * 0.636619772368;
		t = ( t - k ) / ( 1.0 - k * t );
		return smFromLonLat( lon, t * 1.570796326795 );
	} else if ( kind < 3.5 ) {                /* 视觉缩放：竖直角分量缩放后归一化（= atan( z·tan lat )）
	                                             两极固定且平滑，不会出现被削平的极点 */
		return normalize( vec3( d.x, A.y * d.y, d.z ) );
	} else if ( kind < 4.5 ) {                /* 桶形 / 枕形 */
		return smFromLonLat( lon, lat * ( 1.0 + A.y * lat * lat ) );
	} else if ( kind < 5.5 ) {                /* 螺旋扭转 */
		return smFromLonLat( lon + A.y * lat, lat );
	} else if ( kind < 6.5 ) {                /* 水平旋转 */
		return smFromLonLat( lon + A.y, lat );
	} else if ( kind < 7.5 ) {                /* 穹顶压缩 / 展开（两极固定） */
		float e = max( A.y, 0.05 );
		float s = sign( lat ), m = abs( lat ) / 1.570796326795;
		return smFromLonLat( lon, s * pow( m, e ) * 1.570796326795 );
	} else if ( kind < 8.5 ) {                /* 波浪摇曳（频率取整保证接缝连续） */
		float f = floor( A.z + 0.5 );
		return smFromLonLat( lon, lat + A.y * sin( f * lon + A.w ) );
	}
	return d;
}
/* 单个色彩 / 曝光修饰：改写采样结果（线性空间） */
vec3 skyColStep( vec3 c, float kind, vec4 A, vec4 B ){
	if ( kind < 99.5 ) return c;
	float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	if ( kind < 101.5 ) { c *= exp2( A.y ); }                                       /* 曝光 */
	else if ( kind < 102.5 ) { c += vec3( A.y ); }                                  /* 亮度 */
	else if ( kind < 103.5 ) { c = vec3( 0.18 ) + ( c - vec3( 0.18 ) ) * A.y; }     /* 对比度 */
	else if ( kind < 104.5 ) { c = mix( vec3( lum ), c, A.y ); }                    /* 饱和度 */
	else if ( kind < 105.5 ) { c = smHue( c, A.y ); }                               /* 色相 */
	else if ( kind < 106.5 ) { c *= vec3( max( 1.0 + A.y, 0.0 ), 1.0, max( 1.0 - A.y, 0.0 ) ); } /* 色温 */
	else if ( kind < 107.5 ) { c = pow( max( c, vec3( 0.0 ) ), vec3( max( A.y, 0.05 ) ) ); }     /* 伽马 */
	else if ( kind < 108.5 ) { c = mix( c, vec3( A.y, A.z, A.w ) * ( 0.15 + lum ), B.x ); }      /* 染色 */
	else if ( kind < 109.5 ) { c = mix( c, vec3( lum ), A.y ); }                    /* 灰度 */
	else if ( kind < 110.5 ) { c = mix( c, max( vec3( 1.0 ) - c, vec3( 0.0 ) ), A.y ); }         /* 反相 */
	return c;
}
vec3 skyModDir( vec3 d ){
${skySlotLines('skyGeoStep', 'd')}	return normalize( d );
}
vec3 skyModColor( vec3 c ){
${skySlotLines('skyColStep', 'c')}	return c;
}
`;

let _skyPatched = false;

/** 给 three 的背景着色器注入修饰器槽位（只在首次加载时执行） */
function patchSkyShader() {
  if (_skyPatched) return;
  _skyPatched = true;
  const lib = THREE.ShaderLib && THREE.ShaderLib.backgroundCube;
  if (!lib || !lib.fragmentShader) return;
  /* 已经有人打过补丁（本模块被加载两次：版本号变化、热更、双实例）：
     绝不能再注入一遍 —— 重复的 uniform / 函数声明会让背景着色器链接失败
     （天空全黑）。改为把自己接到已存在的 uniform 上，保证 setSkyMods 仍生效。
     注意：这个判断必须在写 lib.uniforms 之前，否则会把上一实例的 uniform
     对象替换掉，已建好的背景材质就再也收不到 setSkyMods 的更新了。 */
  if (lib.fragmentShader.indexOf('skyModDir') >= 0) {
    for (let i = 0; i < SKYMOD_MAX; i++) {
      const a = lib.uniforms['uSkyMA' + i], b = lib.uniforms['uSkyMB' + i];
      if (a && a.value) _skyModA[i] = a.value;
      if (b && b.value) _skyModB[i] = b.value;
    }
    return;
  }
  for (let i = 0; i < SKYMOD_MAX; i++) {
    lib.uniforms['uSkyMA' + i] = { value: _skyModA[i] };
    lib.uniforms['uSkyMB' + i] = { value: _skyModB[i] };
  }
  lib.fragmentShader = lib.fragmentShader
    .replace('varying vec3 vWorldDirection;', 'varying vec3 vWorldDirection;\n' + SKY_MOD_GLSL)
    .replace(
      'vec4 texColor = textureCube( envMap, vec3( flipEnvMap * vWorldDirection.x, vWorldDirection.yz ) );',
      'vec3 skyDir = skyModDir( normalize( vWorldDirection ) );\n\t\tvec4 texColor = textureCube( envMap, vec3( flipEnvMap * skyDir.x, skyDir.yz ) );',
    )
    .replace(
      'vec4 texColor = textureCubeUV( envMap, vWorldDirection, backgroundBlurriness );',
      'vec4 texColor = textureCubeUV( envMap, skyModDir( normalize( vWorldDirection ) ), backgroundBlurriness );',
    )
    .replace(
      'texColor.rgb *= backgroundIntensity;',
      'texColor.rgb *= backgroundIntensity;\n\t\ttexColor.rgb = skyModColor( texColor.rgb );',
    );
}
patchSkyShader();

/** sRGB 十六进制 → 线性 rgb（0..1） */
function _hexToLinear(hex) {
  const s = String(hex || '#ffffff').replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full, 16);
  const f = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return {
    r: f(((n >> 16) & 255) / 255),
    g: f(((n >> 8) & 255) / 255),
    b: f((n & 255) / 255),
  };
}

/**
 * 设置天空盒修饰器列表（level.settings.skyMods）。
 * 参数按类型声明顺序写进槽位：kind → A.x，参数 → A.y, A.z, A.w, B.x, B.y, B.z。
 * 空槽 / 未启用 → kind = 0（着色器跳过）。超出 SKYMOD_MAX 的忽略。
 */
export function setSkyMods(mods) {
  const list = Array.isArray(mods) ? mods : [];
  for (let i = 0; i < SKYMOD_MAX; i++) {
    const a = _skyModA[i], b = _skyModB[i];
    a.x = a.y = a.z = a.w = 0;
    b.x = b.y = b.z = b.w = 0;
    const m = list[i];
    const t = m && m.on !== false ? SKYMOD_BY_ID[m.type] : null;
    if (!t) continue;
    const p = m.p || {};
    const num = (k, dv) => { const v = Number(p[k]); return isFinite(v) ? v : dv; };
    const k = t.kind;
    a.x = k;
    if (k === 1) a.y = num('offset', 0) * Math.PI / 180;
    else if (k === 2) a.y = Math.max(-0.95, Math.min(0.95, num('k', 0)));
    else if (k === 3) a.y = Math.max(0.05, Math.min(8, num('z', 1)));
    else if (k === 4) a.y = Math.max(-3, Math.min(3, num('k', 0)));
    else if (k === 5) a.y = Math.max(-6, Math.min(6, num('k', 0)));
    else if (k === 6) a.y = num('deg', 0) * Math.PI / 180;
    else if (k === 7) a.y = Math.max(0.05, Math.min(4, num('e', 1)));
    else if (k === 8) { a.y = num('amp', 0) * Math.PI / 180; a.z = Math.round(num('freq', 1)); a.w = num('phase', 0) * Math.PI / 180; }
    else if (k >= 101) {
      if (k === 101) a.y = num('ev', 0);                                            /* 曝光（参数键为 ev，不是 amt） */
      else if (k === 108) { const c = _hexToLinear(p.color); a.y = c.r; a.z = c.g; a.w = c.b; b.x = num('amt', 0); }
      else if (k === 105) a.y = num('deg', 0) * Math.PI / 180;
      else if (k === 107) a.y = Math.max(0.05, Math.min(4, num('g', 1)));
      else if (k === 104) a.y = num('amt', 1);
      else if (k === 109 || k === 110) a.y = num('amt', 1);
      else a.y = num('amt', 0);
    }
  }
}

/**
 * 解析关卡里的天空盒设置
 * 支持内置 id / 'asset:xxx'（导入的全景图）/ 'skylab:live'（天空工坊实时预览）/ 'none'（纯色背景）
 */
export function resolveSkyTexture(id) {
  const key = String(id || 'dream');
  if (key === 'none') return null;
  if (key === 'skylab:live') return _liveSky;
  if (key.startsWith('asset:')) {
    // 导入的 .hdr 全景图：已由 RGBELoader 解码并缓存，直接复用
    const hdr = _hdrCache.get(key);
    if (hdr) return hdr;
    const src = _cache.get(key);
    if (!src || !src.image) return null;
    let t = _skyCache.get(key);
    if (t && t.image === src.image) return t;
    t = src.clone();                       // 克隆以免影响该图片作为普通贴图时的用法
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    _skyCache.set(key, t);
    return t;
  }
  return getSkyTexture(key);
}

let _cloudSprite = null;
export function getCloudSprite() {
  if (_cloudSprite) return _cloudSprite;
  const { c, x } = cv(128, 128);
  const rg = x.createRadialGradient(64, 64, 0, 64, 64, 62);
  rg.addColorStop(0, 'rgba(255,255,255,.95)');
  rg.addColorStop(0.45, 'rgba(255,255,255,.5)');
  rg.addColorStop(0.8, 'rgba(255,240,255,.15)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = rg; x.fillRect(0, 0, 128, 128);
  _cloudSprite = new THREE.CanvasTexture(c);
  _cloudSprite.colorSpace = THREE.SRGBColorSpace;
  return _cloudSprite;
}

let _glowSprite = null;
export function getGlowSprite() {
  if (_glowSprite) return _glowSprite;
  const { c, x } = cv(128, 128);
  const rg = x.createRadialGradient(64, 64, 0, 64, 64, 62);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.25, 'rgba(255,255,255,.6)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = rg; x.fillRect(0, 0, 128, 128);
  _glowSprite = new THREE.CanvasTexture(c);
  _glowSprite.colorSpace = THREE.SRGBColorSpace;
  return _glowSprite;
}

let _bubbleSprite = null;
export function getBubbleSprite() {
  if (_bubbleSprite) return _bubbleSprite;
  const { c, x } = cv(64, 64);
  const rg = x.createRadialGradient(32, 32, 0, 32, 32, 30);
  rg.addColorStop(0, 'rgba(255,255,255,.1)');
  rg.addColorStop(0.75, 'rgba(255,255,255,.35)');
  rg.addColorStop(0.92, 'rgba(255,255,255,.85)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = rg; x.fillRect(0, 0, 64, 64);
  _bubbleSprite = new THREE.CanvasTexture(c);
  _bubbleSprite.colorSpace = THREE.SRGBColorSpace;
  return _bubbleSprite;
}

/* ---------- 内置粒子贴图（20 种，程序化绘制，白色 + alpha 便于染色） ---------- */
const PB = 128;                                   // 每种粒子贴图的边长
const _pbIds = new Set(PARTICLE_BUILTINS.map((x) => x.v));
const _pbCache = new Map();

/** id 是否为内置粒子图像 */
export function isParticleBuiltin(id) { return _pbIds.has(String(id || '')); }

/** 画一个以 (cx,cy) 为中心、半径 r 的柔和白色圆 */
function pbSoft(x, cx, cy, r, top = 1, mid = 0.5) {
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, 'rgba(255,255,255,' + top + ')');
  g.addColorStop(0.55, 'rgba(255,255,255,' + mid + ')');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
}
/** 正 n 角星路径（外半径 R，内半径 r，尖角朝上） */
function pbStarPath(x, cx, cy, n, R, r) {
  x.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const rad = i % 2 ? r : R;
    const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
  }
  x.closePath();
}

/** 逐种绘制（s = 画布边长） */
function pbPaint(id, x, s) {
  const c = s / 2;
  x.clearRect(0, 0, s, s);
  switch (id) {
    case 'pb/glow': {
      // 默认粒子：外柔晕 + 明亮内核，层次更分明、叠加发光时更通透
      pbSoft(x, c, c, c * 0.99, 0.42, 0.16);
      pbSoft(x, c, c, c * 0.5, 1, 0.5);
      break;
    }
    case 'pb/dot': {
      pbSoft(x, c, c, c * 0.8, 0.55, 0.22);
      pbSoft(x, c, c, c * 0.4, 1, 0.6);
      break;
    }
    case 'pb/spark': {
      pbSoft(x, c, c, c * 0.62, 0.8, 0.24);
      x.fillStyle = 'rgba(255,255,255,1)';
      pbStarPath(x, c, c, 4, c * 0.98, c * 0.11); x.fill();
      break;
    }
    case 'pb/star': {
      pbSoft(x, c, c, c * 0.55, 0.55, 0.2);
      x.fillStyle = 'rgba(255,255,255,1)';
      pbStarPath(x, c, c, 5, c * 0.94, c * 0.4); x.fill();
      break;
    }
    case 'pb/ring': {
      const g = x.createRadialGradient(c, c, c * 0.3, c, c, c * 0.94);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.72, 'rgba(255,255,255,0)');
      g.addColorStop(0.86, 'rgba(255,255,255,0.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.beginPath(); x.arc(c, c, c * 0.94, 0, Math.PI * 2); x.fill();
      break;
    }
    case 'pb/cross': {
      pbSoft(x, c, c, c * 0.55, 0.75, 0.2);
      x.fillStyle = 'rgba(255,255,255,1)';
      const w = s * 0.06;
      x.fillRect(c - w / 2, s * 0.06, w, s * 0.88);
      x.fillRect(s * 0.06, c - w / 2, s * 0.88, w);
      break;
    }
    case 'pb/smoke': {
      pbSoft(x, c * 0.78, c * 1.1, c * 0.62, 0.85, 0.4);
      pbSoft(x, c * 1.3, c * 0.86, c * 0.7, 0.8, 0.35);
      pbSoft(x, c * 0.95, c * 0.82, c * 0.78, 0.9, 0.4);
      break;
    }
    case 'pb/cloud': {
      pbSoft(x, c * 0.7, c * 1.12, c * 0.5, 0.95, 0.5);
      pbSoft(x, c * 1.32, c * 1.12, c * 0.5, 0.95, 0.5);
      pbSoft(x, c * 1.0, c * 0.86, c * 0.6, 1, 0.55);
      x.fillStyle = 'rgba(255,255,255,0.9)';
      x.fillRect(c * 0.7, c * 1.05, c * 0.62, c * 0.55);
      break;
    }
    case 'pb/bubble': {
      const g = x.createRadialGradient(c, c, c * 0.2, c, c, c * 0.95);
      g.addColorStop(0, 'rgba(255,255,255,0.05)');
      g.addColorStop(0.72, 'rgba(255,255,255,0.3)');
      g.addColorStop(0.9, 'rgba(255,255,255,0.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.beginPath(); x.arc(c, c, c * 0.95, 0, Math.PI * 2); x.fill();
      pbSoft(x, c * 0.68, c * 0.66, c * 0.2, 0.9, 0.4);
      break;
    }
    case 'pb/droplet': {
      x.fillStyle = 'rgba(255,255,255,0.95)';
      x.beginPath();
      x.moveTo(c, s * 0.08);
      x.bezierCurveTo(c * 1.62, c * 0.86, c * 1.5, c * 1.72, c, c * 1.72);
      x.bezierCurveTo(c * 0.5, c * 1.72, c * 0.38, c * 0.86, c, s * 0.08);
      x.closePath(); x.fill();
      pbSoft(x, c * 0.78, c * 1.24, c * 0.26, 0.7, 0.2);
      break;
    }
    case 'pb/flame': {
      const g = x.createRadialGradient(c, c * 1.2, c * 0.1, c, c * 1.1, c * 1.0);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.6)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.beginPath();
      x.moveTo(c, s * 0.06);
      x.bezierCurveTo(c * 1.72, c * 0.9, c * 1.36, c * 1.78, c, c * 1.78);
      x.bezierCurveTo(c * 0.64, c * 1.78, c * 0.28, c * 0.9, c, s * 0.06);
      x.closePath(); x.fill();
      break;
    }
    case 'pb/ember': {
      pbSoft(x, c, c, c * 0.6, 1, 0.55);
      x.fillStyle = 'rgba(255,255,255,0.9)';
      x.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const rr = c * (0.42 + (i % 2) * 0.16);
        const px = c + Math.cos(a) * rr, py = c + Math.sin(a) * rr;
        if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
      }
      x.closePath(); x.fill();
      break;
    }
    case 'pb/leaf': {
      x.fillStyle = 'rgba(255,255,255,0.95)';
      x.beginPath();
      x.moveTo(c * 0.35, c * 1.75);
      x.quadraticCurveTo(c * 0.05, c * 0.7, c * 1.65, c * 0.25);
      x.quadraticCurveTo(c * 1.75, c * 1.3, c * 0.35, c * 1.75);
      x.closePath(); x.fill();
      x.strokeStyle = 'rgba(160,160,160,0.6)'; x.lineWidth = s * 0.02;
      x.beginPath(); x.moveTo(c * 0.35, c * 1.75); x.lineTo(c * 1.6, c * 0.35); x.stroke();
      break;
    }
    case 'pb/petal': {
      x.fillStyle = 'rgba(255,255,255,0.95)';
      x.beginPath();
      x.moveTo(c, s * 0.12);
      x.bezierCurveTo(c * 1.95, c * 0.75, c * 1.6, c * 1.85, c, c * 1.85);
      x.bezierCurveTo(c * 0.4, c * 1.85, c * 0.05, c * 0.75, c, s * 0.12);
      x.closePath(); x.fill();
      pbSoft(x, c, c * 1.25, c * 0.3, 0.5, 0.15);
      break;
    }
    case 'pb/snow': {
      x.strokeStyle = 'rgba(255,255,255,0.95)';
      x.lineCap = 'round';
      x.lineWidth = s * 0.045;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        x.beginPath(); x.moveTo(c, c);
        x.lineTo(c + Math.cos(a) * c * 0.86, c + Math.sin(a) * c * 0.86); x.stroke();
        const bx = c + Math.cos(a) * c * 0.52, by = c + Math.sin(a) * c * 0.52;
        x.beginPath();
        x.moveTo(bx, by);
        x.lineTo(bx + Math.cos(a + 0.9) * c * 0.24, by + Math.sin(a + 0.9) * c * 0.24);
        x.moveTo(bx, by);
        x.lineTo(bx + Math.cos(a - 0.9) * c * 0.24, by + Math.sin(a - 0.9) * c * 0.24);
        x.stroke();
      }
      break;
    }
    case 'pb/hex': {
      x.strokeStyle = 'rgba(255,255,255,0.95)';
      x.lineWidth = s * 0.07; x.lineJoin = 'round';
      x.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
        const px = c + Math.cos(a) * c * 0.84, py = c + Math.sin(a) * c * 0.84;
        if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
      }
      x.closePath(); x.stroke();
      break;
    }
    case 'pb/square': {
      x.fillStyle = 'rgba(255,255,255,0.95)';
      roundRect(x, s * 0.16, s * 0.16, s * 0.68, s * 0.68, s * 0.16); x.fill();
      break;
    }
    case 'pb/triangle': {
      x.fillStyle = 'rgba(255,255,255,0.95)';
      x.beginPath();
      x.moveTo(c, s * 0.12); x.lineTo(s * 0.9, s * 0.86); x.lineTo(s * 0.1, s * 0.86);
      x.closePath(); x.fill();
      break;
    }
    case 'pb/note': {
      x.fillStyle = 'rgba(255,255,255,0.95)';
      x.beginPath(); x.ellipse(c * 0.72, c * 1.42, c * 0.34, c * 0.26, -0.35, 0, Math.PI * 2); x.fill();
      x.fillRect(c * 0.98, c * 0.32, s * 0.08, c * 1.18);
      x.beginPath();
      x.moveTo(c * 1.02, c * 0.32);
      x.quadraticCurveTo(c * 1.62, c * 0.44, c * 1.66, c * 0.92);
      x.quadraticCurveTo(c * 1.5, c * 0.66, c * 1.02, c * 0.64);
      x.closePath(); x.fill();
      break;
    }
    case 'pb/rune': {
      x.strokeStyle = 'rgba(255,255,255,0.95)';
      x.lineWidth = s * 0.05; x.lineCap = 'round';
      x.beginPath(); x.arc(c, c, c * 0.82, 0, Math.PI * 2); x.stroke();
      x.beginPath();
      x.moveTo(c, c * 0.3); x.lineTo(c, c * 1.7);
      x.moveTo(c * 0.3, c); x.lineTo(c * 1.7, c);
      x.moveTo(c * 0.48, c * 0.48); x.lineTo(c * 1.52, c * 1.52);
      x.moveTo(c * 1.52, c * 0.48); x.lineTo(c * 0.48, c * 1.52);
      x.stroke();
      break;
    }
    default: pbSoft(x, c, c, c * 0.9, 1, 0.5);
  }
}

/** 取内置粒子贴图（同步；非内置 id → null） */
export function getParticleSprite(id) {
  const key = String(id || '');
  if (!_pbIds.has(key)) return null;
  const hit = _pbCache.get(key);
  if (hit) return hit;
  const { c, x } = cv(PB, PB);
  try { pbPaint(key, x, PB); } catch (e) { console.warn('[pb]', key, e); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  _pbCache.set(key, t);
  return t;
}

/** 生成涂鸦用空白画布纹理 */
export function makePaintTexture(size = 512) {
  const { c, x } = cv(size, size);
  x.clearRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  t.userData.canvas = c;
  t.userData.ctx = x;
  return t;
}

export function disposeTextureCache() {
  for (const v of _cache.values()) if (v && v.dispose) v.dispose();
  _cache.clear();
  for (const v of _hdrCache.values()) if (v && v.dispose) v.dispose();
  _hdrCache.clear();
  _hdrIds.clear();
  for (const v of _pbCache.values()) if (v && v.dispose) v.dispose();
  _pbCache.clear();
  clearModulationStats();   // 贴图没了，调制用的统计缓存也一并清掉
}

export const TEXTURE_IDS = _builtinIds;