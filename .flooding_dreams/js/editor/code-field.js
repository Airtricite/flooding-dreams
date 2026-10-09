/* ============================================================
   手写代码编辑器（事件「代码块 / JS 表达式」用）
   ------------------------------------------------------------
   项目是纯前端离线的：index.html 的 importmap 只映射本地 vendored 的
   three / cannon，引不进 CodeMirror / Monaco —— 所以这里自绘一个小编辑器：
   · textarea 叠在高亮层上（文字透明、只留光标），左侧是行号槽，三者滚动同步
   · 语法高亮：正则分词 → <span class="tok-*">
   · 自动补全：自绘下拉（.code-ac-host，绝对定位在编辑器内，不占用全局 popover 单例）
     —— 打点号后自动列该根名的成员，正在写标识符时自动列注入全局名 + JS 关键字，
     Ctrl+Space 手动唤出，↑↓ 选择、Enter/Tab 采纳、Esc 收起
   · 实时语法检查：compileScript 的编译结果写进 .code-err
   ============================================================ */
import { el, clear } from '../ui/dom.js';
import { escapeHtml } from '../core/util.js';
import { WORLD_API_DOC, SCRIPT_GLOBALS, API_MEMBERS, scriptError } from '../world/worldapi.js';

/* ---------- 词法 ---------- */
const KEYWORDS = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'break',
  'continue', 'new', 'typeof', 'instanceof', 'in', 'of', 'this', 'null', 'undefined', 'true',
  'false', 'try', 'catch', 'finally', 'throw', 'switch', 'case', 'default', 'class', 'delete',
  'void', 'yield', 'await', 'async', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'console', 'isNaN', 'parseFloat', 'parseInt',
];
const KEYWORD_SET = new Set(KEYWORDS);

/** 注入脚本作用域的全局名（去掉签名部分） */
const GLOBALS = SCRIPT_GLOBALS.map((g) => ({
  n: String(g.n).split('(')[0].trim(),
  d: g.d || '',
}));
const GLOBAL_SET = new Set(GLOBALS.map((g) => g.n));

/** 未知根名（如对象句柄 h.）时用的兜底成员表：所有成员名的并集 */
const ALL_MEMBERS = (() => {
  const s = new Set();
  for (const arr of API_MEMBERS.values()) for (const m of arr) s.add(m);
  return [...s].sort();
})();

/* 分词正则：注释 / 字符串与模板串 / 数字 / 标识符 / 标点 */
const TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:?=+\-*/%<>!&|^~]+)/g;

function tokSpan(cls, text) {
  const t = escapeHtml(text);
  return cls ? '<span class="tok-' + cls + '">' + t + '</span>' : t;
}

/** 源码 → 高亮 HTML（末尾补一个换行，避免最后一行把高度算少） */
function highlight(src) {
  const s = String(src == null ? '' : src);
  let out = '';
  let last = 0;
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out += escapeHtml(s.slice(last, m.index));
    const full = m[0];
    if (m[1]) out += tokSpan('com', full);
    else if (m[2]) out += tokSpan('str', full);
    else if (m[3]) out += tokSpan('num', full);
    else if (m[4]) {
      const fn = !KEYWORD_SET.has(full) && (GLOBAL_SET.has(full) || s[re.lastIndex] === '(');
      out += tokSpan(KEYWORD_SET.has(full) ? 'kw' : (fn ? 'fn' : ''), full);
    } else out += tokSpan('punc', full);
    last = re.lastIndex;
  }
  if (last < s.length) out += escapeHtml(s.slice(last));
  return out + '\n';
}

/** 从 API 目录里抽出「成员 → 说明」，供补全列表显示（按 doc 数组缓存） */
const _descCache = new WeakMap();
function buildDesc(doc) {
  const map = new Map();
  for (const grp of (doc || [])) {
    for (const it of (grp.list || [])) {
      const d = String(it.d || '');
      const text = String(it.n || '').replace(/\([^)]*\)/g, '');
      for (const tok of text.split(/[\s/|]+/)) if (tok.includes('.')) map.set(tok, d);
    }
  }
  return map;
}
function docDesc(doc) {
  if (!doc) return new Map();
  let m = _descCache.get(doc);
  if (!m) { m = buildDesc(doc); _descCache.set(doc, m); }
  return m;
}

/* ---------- 光标上下文 ---------- */
const _wRe = /[\w$]/;
/**
 * 光标前的标识符 + 是否紧跟 `.`（dot 时给出根名）
 * rootOk：根名是合法标识符（`world.`）还是别的东西（`)` / `]` → 无法静态判定类型）
 */
function prefixAt(src, pos) {
  let i = pos;
  while (i > 0 && _wRe.test(src[i - 1])) i--;
  const word = src.slice(i, pos);
  const dot = i > 0 && src[i - 1] === '.';
  let root = '';
  if (dot) {
    let k = i - 1;
    while (k > 0 && _wRe.test(src[k - 1])) k--;
    root = src.slice(k, i - 1);
  }
  return { word, dot, root, rootOk: /^[A-Za-z_$][\w$]*$/.test(root), start: i };
}

/** 高亮层里第 pos 个字符的视口坐标（补全浮层定位用） */
function caretXY(codeEl, pos) {
  const range = document.createRange();
  let acc = 0, done = false;
  const walk = (node) => {
    if (done) return;
    if (node.nodeType === 3) {
      const len = node.nodeValue.length;
      if (acc + len >= pos) {
        const at = Math.max(0, Math.min(len, pos - acc));
        range.setStart(node, at);
        range.setEnd(node, at);
        done = true;
        return;
      }
      acc += len;
      return;
    }
    for (const c of node.childNodes) walk(c);
  };
  walk(codeEl);
  if (!done) { range.selectNodeContents(codeEl); range.collapse(false); }
  const r = range.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4, h: r.height || 16 };
}

/* ============================================================
   createCodeField
   ============================================================ */
/**
 * @param {object} opts
 *   value       初始代码
 *   onChange    (value) => void：失焦 / Ctrl+Enter 提交时调用（输入过程不打扰）
 *   onCheck     (err|null) => void：每次语法检查后回调（窗口底部状态行用）
 *   doc         API 目录（默认 WORLD_API_DOC，供补全说明用）
 *   rows        可见行数；传 0 表示不写死高度，由外层（独立窗口）用 flex 撑满
 *   fill        true = 撑满父容器（配合 rows:0）
 *   expr        true = 单表达式模式（校验按表达式编译）
 *   placeholder 占位文字
 * @returns {{el:HTMLElement, getValue:Function, setValue:Function, focus:Function,
 *            closeAc:Function, isAcOpen:Function, destroy:Function}}
 */
export function createCodeField(opts = {}) {
  const descs = docDesc(opts.doc || WORLD_API_DOC);
  const expr = !!opts.expr;

  const gutter = el('div', { class: 'code-gutter' });
  const code = el('code');
  const hl = el('pre', { class: 'code-hl', 'aria-hidden': 'true' }, code);
  const inp = el('textarea', {
    class: 'code-inp', rows: opts.rows || 6, spellcheck: 'false',
    autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off',
    placeholder: opts.placeholder || '',
  });
  inp.value = String(opts.value == null ? '' : opts.value);
  const wrap = el('div', { class: 'code-wrap' }, hl, inp);
  const box = el('div', { class: 'code-ed' }, gutter, wrap);
  const rows = opts.rows || 0;
  if (rows) box.style.height = (rows * 17 + 14) + 'px';   // 行高 / 内边距与 CSS 里的 .code-hl 保持一致
  const errEl = el('div', { class: 'code-err' });
  const acHost = el('div', { class: 'code-ac-host' });    // 补全下拉：挂在编辑器内、绝对定位
  const root = el('div', { class: 'code-host' + (opts.fill ? ' fill' : '') }, box, errEl, acHost);

  /* ---------- 重绘（高亮 / 行号 / 错误）：rAF 节流 ---------- */
  let raf = 0;
  function paint() {
    raf = 0;
    const src = inp.value;
    code.innerHTML = highlight(src);
    // 行号
    const n = src.split('\n').length;
    if (gutter.childElementCount !== n) {
      clear(gutter);
      for (let i = 1; i <= n; i++) gutter.appendChild(el('div', { text: String(i) }));
    }
    syncScroll();
    check();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(paint); }

  function syncScroll() {
    hl.scrollTop = inp.scrollTop;
    hl.scrollLeft = inp.scrollLeft;
    gutter.scrollTop = inp.scrollTop;
  }

  function check() {
    const err = scriptError(inp.value, expr);
    errEl.textContent = err ? '语法错误：' + err : '';
    errEl.classList.toggle('show', !!err);
    if (opts.onCheck) opts.onCheck(err);
  }

  /* ---------- 自动补全（自绘下拉，不占用全局 popover 单例） ---------- */
  let acOpen = false;
  let acList = [];
  let acIx = 0;
  let acStart = 0;
  let acNav = false;         // 用户是否主动导航过（↑↓ / Ctrl+Space）；未导航则 Enter/Tab 不采纳

  function closeAc() {
    if (!acOpen) return false;
    acOpen = false;
    acList = [];
    acNav = false;
    acHost.classList.remove('on');
    clear(acHost);
    return true;
  }

  /** 按光标上下文取候选池 */
  function poolOf(info) {
    if (!info.dot) {
      return GLOBALS.map((g) => ({ n: g.n, d: g.d }))
        .concat(KEYWORDS.map((k) => ({ n: k, d: '' })));
    }
    // 根名不是合法标识符（`)` / `]` 等）→ 无法静态判定类型，退回全量成员名
    if (!info.rootOk) return ALL_MEMBERS.map((m) => ({ n: m, d: '' }));
    const members = API_MEMBERS.get(info.root + '.') || ALL_MEMBERS;
    return members.map((m) => ({ n: m, d: descs.get(info.root + '.' + m) || '' }));
  }

  function candidates() {
    const pos = inp.selectionStart;
    const src = inp.value;
    const info = prefixAt(src, pos);
    const pool = poolOf(info);
    const w = info.word;
    const list = w ? pool.filter((c) => c.n.startsWith(w)) : pool;
    // 去重（全局名与关键字可能重名）
    const seen = new Set();
    const out = [];
    for (const c of list) { if (seen.has(c.n)) continue; seen.add(c.n); out.push(c); }
    return { list: out.slice(0, 80), info, pos };
  }

  function insert(name) {
    const pos = inp.selectionStart;
    inp.setRangeText(name, acStart, pos, 'end');
    schedule();
  }

  /** 光标视口坐标 → 相对 .code-host 的坐标，并按需翻到光标本行上方 */
  function positionAc(list) {
    const xy = caretXY(code, inp.selectionStart);
    const hr = root.getBoundingClientRect();
    const lw = list.offsetWidth || 240;
    const lh = list.offsetHeight || 200;
    let left = xy.x - hr.left;
    left = Math.max(4, Math.min(root.clientWidth - lw - 4, left));
    let top = xy.y - hr.top;
    if (top + lh > root.clientHeight - 4) top = xy.y - hr.top - lh - xy.h - 6;
    list.style.left = Math.round(left) + 'px';
    list.style.top = Math.round(Math.max(4, top)) + 'px';
  }

  /** 重建下拉列表（上下选、输入过滤都走这里） */
  function renderAc() {
    const list = el('div', { class: 'code-ac' });
    for (let i = 0; i < acList.length; i++) {
      const c = acList[i];
      list.appendChild(el('button', {
        class: 'code-ac-i' + (i === acIx ? ' on' : ''),
        // mousedown 而不是 click：不让 textarea 先失焦
        onmousedown: (e) => { e.preventDefault(); pick(i); },
      }, el('b', { text: c.n }), c.d ? el('i', { text: c.d }) : null));
    }
    clear(acHost);
    acHost.appendChild(list);
    acHost.classList.add('on');
    positionAc(list);
    // 让活动项可见（手动算 scrollTop，避免 scrollIntoView 连带滚动外层容器）
    const on = list.children[acIx];
    if (on) {
      if (on.offsetTop < list.scrollTop) list.scrollTop = on.offsetTop;
      else if (on.offsetTop + on.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = on.offsetTop + on.offsetHeight - list.clientHeight;
      }
    }
  }

  function pick(i) {
    const c = acList[i];
    if (!c) return;
    insert(c.n);
    closeAc();
    inp.focus();
  }

  function showAc(r) {
    acStart = r.info.start;
    acIx = Math.min(acIx, r.list.length - 1);
    if (acIx < 0) acIx = 0;
    acList = r.list;
    acOpen = true;
    renderAc();
  }

  /** 手动唤出（Ctrl+Space）：列出全部候选，并开启导航态 */
  function openAc() {
    paint();                                     // 先同步高亮层，才能量到光标位置
    const r = candidates();
    acIx = 0;
    if (!r.list.length) { closeAc(); return; }
    showAc(r);
    acNav = true;
  }

  /** 输入过程中自动触发 */
  function autoAc() {
    const r = candidates();
    if (!r.list.length) { closeAc(); return; }
    const info = r.info;
    if (info.dot) {
      // 点号后：只要该根名有成员就弹
      showAc(r);
      acNav = false;
      return;
    }
    // 标识符输入中：至少 1 个字符、且候选不是「唯一一个恰好等于已输入词」才弹
    if (info.word.length >= 1 && !(r.list.length === 1 && r.list[0].n === info.word)) {
      showAc(r);
      acNav = false;
      return;
    }
    closeAc();
  }

  /* ---------- 事件 ---------- */
  const onInput = () => { schedule(); autoAc(); };
  const onScroll = () => { syncScroll(); if (acOpen) positionAc(acHost.firstChild); };
  const onKey = (e) => {
    if (acOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); acIx = (acIx + 1) % acList.length; acNav = true; renderAc(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); acIx = (acIx - 1 + acList.length) % acList.length; acNav = true; renderAc(); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && acNav) { e.preventDefault(); pick(acIx); return; }
    }
    // Ctrl+Space 在部分输入法下 keydown 的 key 是 'Space' 或 ' '，两个都认
    if ((e.code === 'Space' || e.key === ' ') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openAc(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); return; }
    if (e.key === 'Escape' && acOpen) { e.stopPropagation(); closeAc(); return; }
    // 普通回车 / Tab：先收起下拉，再让 textarea 自己处理
    if (e.key === 'Enter' || e.key === 'Tab') closeAc();
  };
  const onBlur = () => { closeAc(); commit(); };
  const onFocus = () => { /* 交由输入 / Ctrl+Space 触发补全，不自动弹 */ };

  let last = inp.value;
  function commit() {
    const v = inp.value;
    if (v === last) return;
    last = v;
    if (opts.onChange) opts.onChange(v);
  }

  inp.addEventListener('input', onInput);
  inp.addEventListener('keydown', onKey);
  inp.addEventListener('scroll', onScroll);
  inp.addEventListener('blur', onBlur);
  inp.addEventListener('focus', onFocus);

  paint();

  return {
    el: root,
    getValue: () => inp.value,
    setValue: (v) => {
      inp.value = String(v == null ? '' : v);
      last = inp.value;
      paint();
    },
    focus: () => inp.focus(),
    closeAc: () => closeAc(),
    isAcOpen: () => acOpen,
    destroy: () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      closeAc();
      inp.removeEventListener('input', onInput);
      inp.removeEventListener('keydown', onKey);
      inp.removeEventListener('scroll', onScroll);
      inp.removeEventListener('blur', onBlur);
      inp.removeEventListener('focus', onFocus);
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}