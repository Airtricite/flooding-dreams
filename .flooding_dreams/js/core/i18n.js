/* ============================================================
   多语言（i18n）
   —— 以「中文原文」作为 key，运行时查表替换；
      没有对应译文的条目自动回退中文，因此语言包可以逐步补全
   —— 支持原地切换（不刷新页面）：
      ① 给 textContent / title / placeholder 等写入挂钩，自动记住原文并输出译文
      ② 切换时把记住过的文本按新语言重写一遍
   —— 拼接文本请用 t('...') 或 tpl('用时 {0}', x) 手动包裹
   ============================================================ */
import { settings } from './settings.js';

/** 支持的语言（zh 是原文，不需要语言包） */
export const LANGS = [
  { v: 'zh', l: '简体中文', native: '简体中文' },
  { v: 'en', l: 'English', native: 'English' },
  { v: 'fr', l: 'Français', native: 'Français' },
  { v: 'es', l: 'Español', native: 'Español' },
  { v: 'de', l: 'Deutsch', native: 'Deutsch' },
  { v: 'ja', l: '日本語', native: '日本語' },
  { v: 'ko', l: '한국어', native: '한국어' },
];

/** 语言包按需加载（显式映射，避免动态拼接路径在部分浏览器上的问题） */
const LOADERS = {
  en: () => import('../i18n/en.js'),
  fr: () => import('../i18n/fr.js'),
  es: () => import('../i18n/es.js'),
  de: () => import('../i18n/de.js'),
  ja: () => import('../i18n/ja.js'),
  ko: () => import('../i18n/ko.js'),
};

/** 含汉字（用于快速判断"这段文本是否需要翻译"） */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 需要一起翻译的属性 */
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

let cur = 'zh';
let dict = null;          // Map<原文, 译文>
let byFirst = null;       // Map<首字, 原文[]>（按长度降序）——拼接文本的子串兜底用
let internal = false;     // 内部写入标记（避免译文被当成原文再次记录）
let titleSrc = null;      // 浏览器标签标题的原文（见 refreshAll 里的说明）
const REC_TEXT = new Map();   // Node -> 原文
const REC_ATTR = new Map();   // Element -> { 属性名: 原文 }
const REC_HTML = new Map();   // Element -> 原文（innerHTML 写入，仅少量"带 <br> 的空状态提示"）

/** 语言包对象 → 查表用的 Map（额外登记去掉首尾空白的版本，便于匹配带缩进的原文） */
function toDict(obj) {
  const m = new Map();
  for (const [k, v] of Object.entries(obj || {})) {
    m.set(k, v);
    const t = k.trim();
    if (t !== k && !m.has(t)) m.set(t, v);
  }
  return m;
}

/** 建立「首字 → 候选原文」索引（长度 < 2 的 key 不参与子串替换，避免单字误伤） */
function buildPartIndex() {
  byFirst = null;
  if (!dict) return;
  byFirst = new Map();
  for (const k of dict.keys()) {
    if (k.length < 2) continue;
    const c = k[0];
    let a = byFirst.get(c);
    if (!a) { a = []; byFirst.set(c, a); }
    a.push(k);
  }
  for (const a of byFirst.values()) a.sort((x, y) => y.length - x.length);
}

/** 子串兜底：把 '最佳 12.3s' 这类拼接文本里的中文片段逐个替换 */
function translateParts(s) {
  if (!byFirst) return s;
  let out = '';
  let i = 0;
  let changed = false;
  while (i < s.length) {
    const cands = byFirst.get(s[i]);
    let hit = null;
    if (cands) {
      for (const k of cands) { if (s.startsWith(k, i)) { hit = k; break; } }
    }
    if (hit) { out += dict.get(hit); i += hit.length; changed = true; }
    else { out += s[i]; i++; }
  }
  return changed ? out : s;
}

/** 把一段（可能带缩进的）原文翻译成当前语言，保留首尾空白 */
function translateRaw(v) {
  if (!dict || typeof v !== 'string') return v;
  const s = v.trim();
  if (!s) return v;
  const tr = dict.get(s);
  if (tr !== undefined) return v.replace(s, tr);
  return v.replace(s, translateParts(s));   // 整串没命中 → 按片段替换
}

/* ---------- 文本 / 属性写入挂钩 ---------- */
let _setText = null;
let _setHTML = null;
function writeText(node, s) {
  if (!_setText) { node.textContent = s; return; }
  internal = true;
  try { _setText.call(node, s); } finally { internal = false; }
}

function installHooks() {
  if (_setText) return;
  const d = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  _setText = d.set;
  Object.defineProperty(Node.prototype, 'textContent', {
    configurable: true,
    enumerable: d.enumerable,
    get: d.get,
    set(v) {
      if (internal || typeof v !== 'string') { _setText.call(this, v); return; }
      if (v && v.length <= 240 && HAN.test(v)) {
        REC_TEXT.set(this, v);
        _setText.call(this, translateRaw(v));
        return;
      }
      REC_TEXT.delete(this);
      _setText.call(this, v);
    },
  });

  const dHtml = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (dHtml && dHtml.set) {
    _setHTML = dHtml.set;
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true,
      enumerable: dHtml.enumerable,
      get: dHtml.get,
      set(v) {
        if (internal || typeof v !== 'string') { _setHTML.call(this, v); return; }
        if (v && v.length <= 2000 && HAN.test(v)) {
          REC_HTML.set(this, v);
          _setHTML.call(this, translateRaw(v));
          return;
        }
        REC_HTML.delete(this);
        _setHTML.call(this, v);
      },
    });
  }

  const _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (!internal && typeof value === 'string' && ATTRS.indexOf(name) >= 0 && value && HAN.test(value)) {
      let m = REC_ATTR.get(this);
      if (!m) { m = {}; REC_ATTR.set(this, m); }
      m[name] = value;
      _setAttr.call(this, name, translateRaw(value));
      return;
    }
    _setAttr.call(this, name, value);
  };
}

/* ---------- 首帧扫描：把已经存在的静态文本 / 属性纳入管辖 ---------- */
/** 扫描一棵子树里已有的中文文本与属性（HTML 里写死的文案） */
export function apply(root = document.body) {
  if (!root) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const texts = [];
  let n = w.nextNode();
  while (n) {
    const v = n.nodeValue;
    if (v && v.trim() && v.length <= 240 && HAN.test(v)) {
      REC_TEXT.set(n, v);
      texts.push(n);
    }
    n = w.nextNode();
  }
  for (const node of texts) writeText(node, translateRaw(REC_TEXT.get(node)));

  const els = root.querySelectorAll ? root.querySelectorAll('[' + ATTRS.join('],[') + ']') : [];
  for (const el of els) {
    for (const k of ATTRS) {
      const v = el.getAttribute(k);
      if (v && HAN.test(v)) {
        let m = REC_ATTR.get(el);
        if (!m) { m = {}; REC_ATTR.set(el, m); }
        m[k] = v;
        el.setAttribute(k, translateRaw(v));
      }
    }
  }
}

/* ---------- 切换语言 ---------- */
function refreshAll() {
  for (const [node, src] of REC_TEXT) {
    if (!node.isConnected) { REC_TEXT.delete(node); continue; }
    writeText(node, translateRaw(src));
  }
  for (const [el, m] of REC_ATTR) {
    if (!el.isConnected) { REC_ATTR.delete(el); continue; }
    for (const k in m) el.setAttribute(k, translateRaw(m[k]));
  }
  for (const [el, src] of REC_HTML) {
    if (!el.isConnected) { REC_HTML.delete(el); continue; }
    internal = true;
    try { _setHTML.call(el, translateRaw(src)); } finally { internal = false; }
  }
  // 标签页标题：浏览器缓存了 <title> 的文本，改里面的文本节点不会反映到 document.title，
  // 必须用 document.title 这个 setter 重新写一次
  if (titleSrc !== null) document.title = translateRaw(titleSrc);
}

/**
 * 切换语言（原地生效，不刷新页面）
 * @param {string} code zh / en / fr / es / de / ja / ko
 */
export async function setLang(code) {
  if (!LANGS.some((x) => x.v === code)) return false;
  cur = code;
  dict = null;
  if (code !== 'zh' && LOADERS[code]) {
    try {
      const mod = await LOADERS[code]();
      dict = toDict((mod && mod.default) || mod);
    } catch (e) {
      console.warn('[i18n] 语言包加载失败：' + code, e);
    }
  }
  buildPartIndex();
  settings.set('lang', code, true);
  document.documentElement.lang = code === 'zh' ? 'zh-CN' : code;
  refreshAll();
  window.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: code } }));
  return true;
}

/** 启动：装挂钩 + 读取上次选择的语言 + 翻译首屏 */
export async function init() {
  installHooks();
  const code = settings.get('lang', 'zh');
  if (code && code !== 'zh' && LOADERS[code]) {
    try {
      const mod = await LOADERS[code]();
      dict = toDict((mod && mod.default) || mod);
      cur = code;
      document.documentElement.lang = code;
    } catch (e) { console.warn('[i18n] 语言包加载失败：' + code, e); }
  }
  buildPartIndex();
  apply(document.body);
  apply(document.head);
  titleSrc = document.title;
  document.title = translateRaw(titleSrc);
  return cur;
}

/* ---------- 对外 API ---------- */
/** 翻译一段原文（查不到就原样返回） */
export function t(s) {
  if (typeof s !== 'string' || !dict) return s;
  const r = dict.get(s);
  return r === undefined ? s : r;
}
/** 模板翻译：tpl('用时 {0}', 12) → 'Time 12' */
export function tpl(s, ...args) {
  let out = t(s);
  for (let i = 0; i < args.length; i++) out = out.split('{' + i + '}').join(String(args[i]));
  return out;
}
/** 当前语言代码 */
export function lang() { return cur; }
/** 语言是否处于原文（中文）状态 */
export function isDefault() { return cur === 'zh'; }