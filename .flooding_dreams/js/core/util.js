/* ============================================================
   通用工具函数
   ============================================================ */

let _uid = 0;
export function uid(prefix = 'o') {
  _uid++;
  return `${prefix}${Date.now().toString(36).slice(-5)}${_uid.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function damp(a, b, lambda, dt) { return lerp(a, b, 1 - Math.exp(-lambda * dt)); }
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const deg2rad = (d) => d * Math.PI / 180;
export const rad2deg = (r) => r * 180 / Math.PI;
export const round = (v, p = 3) => { const m = Math.pow(10, p); return Math.round(v * m) / m; };
export const approx = (a, b, e = 1e-4) => Math.abs(a - b) < e;

export function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const o = {};
  for (const k in v) o[k] = deepClone(v[k]);
  return o;
}
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
export function mergeDefaults(target, defaults) {
  const out = Array.isArray(defaults) ? [] : {};
  for (const k in defaults) {
    const d = defaults[k];
    const t = target ? target[k] : undefined;
    out[k] = (d && typeof d === 'object' && !Array.isArray(d))
      ? mergeDefaults(t, d)
      : (t === undefined ? deepClone(d) : t);
  }
  if (target && typeof target === 'object') {
    for (const k in target) if (!(k in defaults)) out[k] = deepClone(target[k]);
  }
  return out;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function fmtTime(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
/** 精确到毫秒：回放元数据（通关时刻等）用，播放进度仍用 fmtTime 的百分秒 */
export function fmtTimeMs(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec * 1000) % 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
export function sanitizeName(s, fallback = '未命名') {
  const t = String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  return t || fallback;
}
export function download(filename, text) {
  saveBlob(filename, new Blob([text], { type: 'application/json;charset=utf-8' }));
}
export function pickFile(accept, multiple = false) {
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept; i.multiple = multiple;
    i.onchange = () => res(multiple ? Array.from(i.files || []) : (i.files && i.files[0]) || null);
    i.click();
  });
}
export function readFileText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    r.readAsText(file);
  });
}
export function readFileDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}
export function readFileArrayBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });
}

/**
 * 图片文件 → 压缩后的 dataURL（关卡包贴纸用）。
 * 缩到最长边 maxDim、优先 webp，控制体积，避免关卡包 JSON 膨胀。
 * 失败返回 null。
 */
export async function imageToDataURL(file, maxDim = 512, quality = 0.85) {
  if (!file) return null;
  let bmp = null;
  try { bmp = await createImageBitmap(file); } catch (e) { bmp = null; }
  if (!bmp) {
    // 退回 <img> + objectURL
    try {
      const url = URL.createObjectURL(file);
      bmp = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img); img.onerror = rej;
        img.src = url;
      });
      const out = _drawScaled(bmp, maxDim, quality);
      URL.revokeObjectURL(url);
      return out;
    } catch (e) { return null; }
  }
  return _drawScaled(bmp, maxDim, quality);
}

function _drawScaled(src, maxDim, quality) {
  const w0 = src.width || src.naturalWidth || 0;
  const h0 = src.height || src.naturalHeight || 0;
  if (!w0 || !h0) return null;
  const k = Math.min(1, maxDim / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  if (!cx) return null;
  cx.drawImage(src, 0, 0, w, h);
  let out = '';
  try { out = cv.toDataURL('image/webp', quality); } catch (e) { out = ''; }
  if (!out || out.indexOf('data:image/webp') !== 0) {
    try { out = cv.toDataURL('image/png'); } catch (e) { out = ''; }
  }
  return out && out.startsWith('data:image/') ? out : null;
}

/** 极简事件总线 */
export class Bus {
  constructor() { this.m = new Map(); }
  on(k, fn) { (this.m.get(k) || this.m.set(k, []).get(k)).push(fn); return () => this.off(k, fn); }
  off(k, fn) { const a = this.m.get(k); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
  emit(k, ...a) {
    const l = this.m.get(k);
    if (l) for (let i = 0; i < l.length; i++) { try { l[i](...a); } catch (e) { console.error('[bus]', k, e); } }
  }
  clear() { this.m.clear(); }
}

/** 简易对象池 */
export class Pool {
  constructor(factory, reset) { this.factory = factory; this.reset = reset; this.free = []; }
  get() { return this.free.pop() || this.factory(); }
  put(o) { this.reset && this.reset(o); this.free.push(o); }
}

/** 颜色工具：'#rrggbb' <-> 数值 */
export function hexToRgb01(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16) || 0;
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
}
export function rgb01ToHex(r, g, b) {
  const c = (x) => Math.round(clamp(x, 0, 1) * 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
export function mixHex(a, b, t) {
  const A = hexToRgb01(a), B = hexToRgb01(b);
  return rgb01ToHex(lerp(A.r, B.r, t), lerp(A.g, B.g, t), lerp(A.b, B.b, t));
}
export function luminance(hex) {
  const c = hexToRgb01(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** tween 缓动 */
export const Ease = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  step: () => 0,
};
/** 三次贝塞尔缓动：固定端点 (0,0)/(1,1)，控制点 (x1,y1)/(x2,y2)；给定 x 求 y */
export function cubicBezier(x1, y1, x2, y2, t) {
  const x = clamp(t, 0, 1);
  if (x === 0 || x === 1) return x;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (u) => ((ax * u + bx) * u + cx) * u;
  const sy = (u) => ((ay * u + by) * u + cy) * u;
  const dx = (u) => (3 * ax * u + 2 * bx) * u + cx;
  let u = x;                                   // 牛顿迭代求 u 使 sx(u)=x
  for (let i = 0; i < 8; i++) {
    const d = sx(u) - x;
    if (Math.abs(d) < 1e-6) break;
    const k = dx(u);
    if (Math.abs(k) < 1e-6) break;
    u -= d / k;
    u = clamp(u, 0, 1);
  }
  return sy(u);
}

/** tween 缓动：name 为预设名或 [x1,y1,x2,y2] 自定义贝塞尔曲线 */
export function ease(name, t) {
  const x = clamp(t, 0, 1);
  if (Array.isArray(name) && name.length >= 4) {
    return cubicBezier(Number(name[0]), Number(name[1]), Number(name[2]), Number(name[3]), x);
  }
  return (Ease[name] || Ease.linear)(x);
}

/** 按属性类型插值 */
export function interpValue(type, a, b, t) {
  switch (type) {
    case 'vec3':
    case 'array': return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    case 'number': return lerp(a, b, t);
    case 'color': return mixHex(a, b, t);
    case 'bool': return t >= 1 ? b : a;
    default: return t >= 1 ? b : a;
  }
}
export const isVec3 = (v) => Array.isArray(v) && v.length === 3 &&
  v.every((x) => typeof x === 'number');

/** 稳定字符串 hash（用于缓存键） */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** 带标题的确认框（在 modal 中） */
export function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }

export function throttle(fn, ms) {
  let last = 0, timer = null, pend = null;
  return function (...a) {
    const now = performance.now();
    pend = a;
    if (now - last >= ms) { last = now; fn.apply(null, pend); }
    else if (!timer) {
      timer = setTimeout(() => { timer = null; last = performance.now(); fn.apply(null, pend); }, ms - (now - last));
    }
  };
}
export function debounce(fn, ms) {
  let t = null;
  return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); };
}
/**
 * 保存一个 Blob 到本地。
 * 桌面 / 浏览器走 <a download>；安卓壳里这条路是失效的 —— WebView 不处理
 * blob: 形式的下载（点下去毫无反应），所以改成先把字节 POST 给本地服务落成
 * 临时文件，再调原生走系统的「另存为」，由用户挑保存位置。
 */
export function saveBlob(name, blob) {
  const host = window.AndroidHost;
  if (host && host.saveFile) {
    fetch('./api/export?name=' + encodeURIComponent(name), { method: 'POST', body: blob })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && j.ok) host.saveFile(j.name || name); })
      .catch((e) => console.warn('[save] 导出失败', e));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}