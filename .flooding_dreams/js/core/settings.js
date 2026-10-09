/* ============================================================
   设置：加载 / 保存 / 变更通知
   ============================================================ */
import { DEFAULT_SETTINGS } from '../config.js';
import { deepClone, mergeDefaults, Bus } from './util.js';
import { isExtendedId, builtinURL } from './builtin-assets.js';

const LS_KEY = 'fd.settings.v1';

class Settings extends Bus {
  constructor() {
    super();
    this.data = deepClone(DEFAULT_SETTINGS);
    this.load();
  }
  load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) this.data = mergeDefaults(JSON.parse(raw), DEFAULT_SETTINGS);
    } catch (e) { console.warn('[settings] 读取失败', e); }
  }
  save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.data)); }
    catch (e) { console.warn('[settings] 保存失败', e); }
  }
  get(path, fallback) {
    const p = path.split('.');
    let cur = this.data;
    for (const k of p) { if (cur == null || typeof cur !== 'object') return fallback; cur = cur[k]; }
    return cur === undefined ? fallback : cur;
  }
  set(path, value, silent) {
    const p = path.split('.');
    let cur = this.data;
    for (let i = 0; i < p.length - 1; i++) {
      if (cur[p[i]] == null || typeof cur[p[i]] !== 'object') cur[p[i]] = {};
      cur = cur[p[i]];
    }
    cur[p[p.length - 1]] = value;
    this.save();
    if (!silent) this.emit('change', path, value);
    this.emit('change:' + path, value);
  }
  reset() {
    this.data = deepClone(DEFAULT_SETTINGS);
    this.save();
    this.emit('change', '*', null);
  }
  /** 检测某个按键码是否绑定到某动作 */
  isBound(action, code) {
    const arr = this.data.bindings[action];
    return Array.isArray(arr) ? arr.includes(code) : arr === code;
  }
  setBinding(action, codes) {
    this.data.bindings[action] = Array.isArray(codes) ? codes.slice(0, 3) : [codes];
    this.save();
    this.emit('change', 'bindings.' + action, this.data.bindings[action]);
  }
  /** 反查：某键码绑定了哪些动作 */
  actionsFor(code) {
    const out = [];
    for (const a in this.data.bindings) if (this.isBound(a, code)) out.push(a);
    return out;
  }
  /** 画质档位 → 具体参数（specular=高光反射，ao=接缝闭塞阴影） */
  qualityPreset() {
    const q = this.data.video.quality;
    if (q === 'low')  return { shadows: false, antialias: false, pixelRatio: 1, shadowSize: 512,  particles: false, fog: true,  waterWaves: false, specular: false, ao: false };
    if (q === 'medium') return { shadows: true,  antialias: false, pixelRatio: Math.min(1.25, this.data.video.maxPixelRatio), shadowSize: 1024, particles: true, fog: true, waterWaves: true, specular: true, ao: false };
    if (q === 'high') return { shadows: true,  antialias: true,  pixelRatio: Math.min(2, this.data.video.maxPixelRatio),    shadowSize: 4096, particles: true, fog: true, waterWaves: true, specular: true, ao: true };
    // auto：根据设备粗略判定
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 8;
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    // 手机 / 平板：GPU 与散热都受限，auto 档一律压在中低画质，不进 high
    // （high 的 4096 阴影贴图 + 抗锯齿 + AO 在手机上基本等于幻灯片）
    if (mobile) {
      if (cores <= 4 || mem <= 4) return { shadows: false, antialias: false, pixelRatio: 1, shadowSize: 512, particles: false, fog: true, waterWaves: false, specular: false, ao: false };
      return { shadows: true, antialias: false, pixelRatio: Math.min(1.25, this.data.video.maxPixelRatio), shadowSize: 1024, particles: true, fog: true, waterWaves: true, specular: true, ao: false };
    }
    if (cores <= 4 || mem <= 4) return { shadows: true, antialias: false, pixelRatio: 1, shadowSize: 1024, particles: true, fog: true, waterWaves: true, specular: true, ao: false };
    return { shadows: true, antialias: true, pixelRatio: Math.min(1.5, this.data.video.maxPixelRatio), shadowSize: 4096, particles: true, fog: true, waterWaves: true, specular: true, ao: true };
  }
  /** 按键码 → 友好名称 */
  static keyName(code) {
    if (!code) return '未绑定';
    if (code === 'Mouse0') return '鼠标左键';
    if (code === 'Mouse1') return '鼠标中键';
    if (code === 'Mouse2') return '鼠标右键';
    if (code.startsWith('Mouse')) return '鼠标' + code.slice(5);
    const m = {
      Space: '空格', ShiftLeft: '左Shift', ShiftRight: '右Shift', ControlLeft: '左Ctrl',
      ControlRight: '右Ctrl', AltLeft: '左Alt', AltRight: '右Alt', Escape: 'Esc',
      Enter: '回车', Tab: 'Tab', Backspace: '退格', Delete: 'Delete', Backquote: '`',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
      NumpadAdd: '小键盘+', NumpadSubtract: '小键盘-', CapsLock: 'CapsLock',
    };
    if (m[code]) return m[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return '小键盘' + code.slice(6);
    return code;
  }
}

export const settings = new Settings();

/* ---------- 导入的资源（图片/模型）以 IDB 保存，这里管理 URL 缓存 ---------- */
const assetURLCache = new Map();
export async function resolveAssetURL(assetId) {
  if (!assetId) return null;
  if (assetURLCache.has(assetId)) return assetURLCache.get(assetId);
  // 扩充内置素材直接拼站点路径，没有后端 / 没有 assets 目录时返回 null（调用方退占位）
  if (isExtendedId(assetId)) {
    const url = builtinURL(assetId);
    if (url) assetURLCache.set(assetId, url);
    return url;
  }
  const { store } = await import('./storage.js');
  const rec = await store.getAsset(assetId);
  if (!rec || !rec.data) return null;
  let url;
  if (typeof rec.data === 'string' && rec.data.startsWith('data:')) url = rec.data;
  else {
    const blob = rec.data instanceof Blob ? rec.data : new Blob([rec.data], { type: rec.mime || 'application/octet-stream' });
    url = URL.createObjectURL(blob);
  }
  assetURLCache.set(assetId, url);
  return url;
}
export function forgetAssetURL(assetId) {
  const u = assetURLCache.get(assetId);
  if (u && u.startsWith('blob:')) URL.revokeObjectURL(u);
  assetURLCache.delete(assetId);
}
export function clearAssetURLs() {
  for (const u of assetURLCache.values()) if (u.startsWith('blob:')) URL.revokeObjectURL(u);
  assetURLCache.clear();
}