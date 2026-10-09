/* ============================================================
   DOM 小工具：元素创建 / 屏幕切换 / 提示 / 模态框
   ============================================================ */
import { escapeHtml } from '../core/util.js';
import { diffOf, DIFFICULTY } from '../config.js';
import { settings } from '../core/settings.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 创建一个元素：el('div', {class:'x', text:'hi', onclick:fn}, 子元素…) */
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  addKids(n, kids);
  return n;
}

export function addKids(n, kids) {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false || kid === '') continue;
    if (Array.isArray(kid)) { addKids(n, kid); continue; }
    if (kid.nodeType) { n.appendChild(kid); continue; }
    // 控件包装类（如 GridSelect）：直接挂它的根元素
    if (kid.el && kid.el.nodeType) { n.appendChild(kid.el); continue; }
    n.appendChild(document.createTextNode(String(kid)));
  }
  return n;
}

export function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }
export function on(node, type, fn, opts) { node && node.addEventListener(type, fn, opts); return () => node && node.removeEventListener(type, fn, opts); }

/* ============================================================
   屏幕（全屏面板）切换
   ============================================================ */
export const SCREEN_IDS = ['boot', 'loading', 'menu', 'levels', 'lvmap', 'settings', 'help', 'saves', 'replays', 'cine', 'skin', 'texmod', 'pause', 'result'];

export function showScreen(id) {
  for (const s of SCREEN_IDS) {
    const n = document.getElementById(s);
    if (!n) continue;
    n.classList.toggle('show', s === id);
  }
  return id;
}
export function hideScreens() { showScreen(null); }
export function currentScreen() {
  for (const s of SCREEN_IDS) {
    const n = document.getElementById(s);
    if (n && n.classList.contains('show')) return s;
  }
  return null;
}

/* ============================================================
   Toast
   ============================================================ */
export function toast(msg, kind = '', ms = 2200) {
  const box = document.getElementById('toast');
  if (!box) return null;
  const t = el('div', { class: 'toast ' + kind, html: escapeHtml(msg) });
  box.appendChild(t);
  while (box.children.length > 5) box.removeChild(box.firstChild);
  setTimeout(() => {
    t.style.transition = 'opacity .32s, transform .32s';
    t.style.opacity = '0';
    t.style.transform = 'translateY(8px)';
    setTimeout(() => t.remove(), 340);
  }, ms);
  return t;
}

/* ============================================================
   模态框
   ============================================================ */
/**
 * modal({ title, body, buttons, escValue, onReady })
 *   body: HTMLElement | (ctx)=>HTMLElement | string(html)
 *   buttons: [{ label, value, cls }]
 * 返回 Promise<value>，关闭时若未点按钮则为 escValue（默认 null）
 *
 * 支持嵌套：每个弹窗独占一个 .modal-layer 覆盖层，关闭顶层不会影响下层。
 * 这样窗口内（如 GenLevel / formBox）弹出的 Grid 选择器选中关闭后，原窗口仍然保留。
 */
const modalStack = [];

export function modal(opts = {}) {
  const host = document.getElementById('modal');
  if (!host) return Promise.resolve(null);
  const escVal = opts.escValue !== undefined ? opts.escValue : null;
  const box = el('div', { class: 'modal-box' + (opts.cls ? ' ' + opts.cls : '') });
  if (opts.title) box.appendChild(el('h3', { text: opts.title }));
  const bodyEl = el('div', { class: 'modal-body' });
  const ctx = { close: (v) => finish(v === undefined ? null : v) };
  if (typeof opts.body === 'function') bodyEl.appendChild(opts.body(ctx));
  else if (typeof opts.body === 'string') bodyEl.innerHTML = opts.body;
  else if (opts.body) bodyEl.appendChild(opts.body);
  box.appendChild(bodyEl);

  const foot = el('div', { class: 'modal-foot' });
  for (const b of (opts.buttons || [{ label: '确定', value: true, cls: 'primary' }])) {
    foot.appendChild(el('button', {
      class: 'mbtn sm ' + (b.cls || ''),
      text: b.label,
      onclick: () => finish(b.value === undefined ? true : b.value),
    }));
  }
  box.appendChild(foot);
  // 右上角关闭叉：等价于取消（escValue）
  box.appendChild(el('button', {
    class: 'modal-x', type: 'button', title: '关闭（Esc）',
    onclick: () => finish(escVal),
  }));

  const layer = el('div', { class: 'modal-layer' }, box);

  let done = false;
  const rec = { layer };
  const isTop = () => modalStack[modalStack.length - 1] === rec;
  const onKey = (e) => {
    if (!isTop()) return;                        // 只响应最顶层弹窗，避免一次 Esc 关掉整摞
    if (e.code === 'Escape') { e.stopPropagation(); finish(escVal); }
    else if (e.code === 'Enter' && opts.enterValue !== undefined) finish(opts.enterValue);
  };
  // 点击弹窗外（遮罩）即取消；只认顶层遮罩
  const onBack = (e) => {
    if (!isTop()) return;
    if (e.target === layer) finish(escVal);
  };
  function finish(v) {
    if (done) return;
    done = true;
    window.removeEventListener('keydown', onKey, true);
    layer.remove();
    const i = modalStack.indexOf(rec);
    if (i >= 0) modalStack.splice(i, 1);
    if (!modalStack.length) host.classList.add('hidden');   // 全部关完才隐藏遮罩
    resolve(v);
  }
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  host.appendChild(layer);
  host.classList.remove('hidden');
  modalStack.push(rec);
  window.addEventListener('keydown', onKey, true);
  if (opts.backdropClose !== false) layer.addEventListener('mousedown', onBack);
  const focus = box.querySelector('input,textarea,select,button');
  setTimeout(() => { if (focus && document.contains(focus)) focus.focus(); }, 30);
  if (opts.onReady) opts.onReady(box, ctx);
  return p;
}

/** 确认框 → Promise<boolean> */
export async function confirmBox(text, opts = {}) {
  const v = await modal({
    title: opts.title || '确认',
    body: el('div', { style: { fontSize: 'calc(13.5px * var(--ui-s) * var(--ui-fs))', lineHeight: '1.7' }, text }),
    buttons: [
      { label: opts.cancel || '取消', value: false },
      { label: opts.ok || '确定', value: true, cls: opts.danger ? 'danger' : 'primary' },
    ],
    escValue: false,
    enterValue: true,
  });
  return v === true;
}

/** 单行文本输入 → Promise<string|null> */
export async function promptBox(label, value = '', opts = {}) {
  const inp = el('input', { class: 'inp', value, placeholder: opts.placeholder || '' });
  const box = el('div', {}, el('div', { class: 'frm' }, el('label', { text: label }), inp));
  const v = await modal({
    title: opts.title || '输入',
    body: box,
    buttons: [
      { label: '取消', value: null },
      { label: opts.ok || '确定', value: '@ok', cls: 'primary' },
    ],
    escValue: null,
    enterValue: '@ok',
    onReady: () => { inp.focus(); inp.select(); },
  });
  return v === '@ok' ? String(inp.value || '') : null;
}

/**
 * 表单 → Promise<object|null>
 * fields: [{ k, l, t:'text'|'num'|'bool'|'color'|'select'|'textarea', d, o:[{v,l}], min, max, st, h }]
 */
export async function formBox(title, fields, opts = {}) {
  const inputs = {};
  const body = el('div', {});
  for (const f of fields) {
    const wrap = el('div', { class: 'frm' });
    wrap.appendChild(el('label', { text: f.l || f.k, title: f.h || '' }));
    const col = el('div', { class: 'frm-col' });
    let inp;
    if (f.t === 'bool') {
      inp = el('button', { class: 'switch' + (f.d ? ' on' : ''), type: 'button' });
      inp.addEventListener('click', () => inp.classList.toggle('on'));
      inputs[f.k] = () => inp.classList.contains('on');
    } else if (f.t === 'select') {
      const { GridSelect } = await import('./grid-picker.js');
      inp = new GridSelect({
        value: f.d === undefined ? '' : f.d,
        cls: 'inp',
        options: (f.o || []).map((o) => ({ v: o.v, l: o.l })),
        placeholder: f.ph || '（未选择）',
      });
      inputs[f.k] = () => inp.value;
    } else if (f.t === 'textarea') {
      inp = el('textarea', { class: 'inp', value: f.d ?? '' });
      inputs[f.k] = () => inp.value;
    } else if (f.t === 'num') {
      inp = el('input', { class: 'inp', type: 'number', value: f.d ?? 0, step: f.st ?? 1, min: f.min, max: f.max });
      inputs[f.k] = () => Number(inp.value) || 0;
    } else if (f.t === 'color') {
      inp = el('input', { class: 'inp', type: 'color', value: f.d || '#ffffff', style: { padding: 'calc(2px * var(--ui-s))', height: 'calc(32px * var(--ui-s))' } });
      inputs[f.k] = () => inp.value;
    } else {
      inp = el('input', { class: 'inp', value: f.d ?? '' });
      inputs[f.k] = () => inp.value;
    }
    col.appendChild(inp.el && inp.el.nodeType ? inp.el : inp);
    if (f.h && f.t !== 'bool') col.appendChild(el('div', { class: 'frm-hint', text: f.h }));
    wrap.appendChild(col);
    body.appendChild(wrap);
  }
  const v = await modal({
    title,
    body,
    cls: opts.cls,
    buttons: [
      { label: '取消', value: null },
      { label: opts.ok || '确定', value: '@ok', cls: 'primary' },
    ],
    escValue: null,
  });
  if (v !== '@ok') return null;
  const out = {};
  for (const k in inputs) out[k] = inputs[k]();
  return out;
}

/* ============================================================
   常用片段
   ============================================================ */
export function diffTag(v) {
  const d = diffOf(v);
  return el('span', {
    class: 'diff-tag',
    text: d.label + ' ' + Number(v).toFixed(1),
    style: { color: d.color, background: d.glow },
  });
}

export function diffLegend() {
  const wrap = el('div', { class: 'diff-legend' });
  for (const d of DIFFICULTY) {
    wrap.appendChild(el('div', { class: 'dl' },
      el('span', { class: 'dot', style: { background: d.color } }),
      el('span', { text: `${d.label} ${d.zh} ${d.min.toFixed(1)}–${d.max.toFixed(2)}` }),
    ));
  }
  return wrap;
}

/** 按键码 → 友好名称 */
export function bindName(code) { return settings.constructor.keyName(code); }