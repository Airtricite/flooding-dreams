/* ============================================================
   编辑器小组件：右键菜单 / 浮层 / 色板 / 通用行
   ============================================================ */
import { el, clear, toast } from '../ui/dom.js';
import { GridSelect } from '../ui/grid-picker.js';
import { getObject, objectLabel } from '../world/level.js';
import { PALETTE } from '../config.js';

/* ---------- 右键菜单 ---------- */
let _menu = null;
let _menuOff = null;

export function closeMenu() {
  if (_menuOff) { _menuOff(); _menuOff = null; }
  if (_menu) { _menu.remove(); _menu = null; }
}

export function contextMenu(x, y, items) {
  closeMenu();
  const host = document.getElementById('app') || document.body;
  const m = el('div', { class: 'ctxmenu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { m.appendChild(el('div', { class: 'sep' })); continue; }
    if (it.label && !it.l) { m.appendChild(el('div', { class: 'lab', text: it.label })); continue; }
    m.appendChild(el('button', {
      class: it.danger ? 'danger' : '',
      onclick: (e) => { e.stopPropagation(); closeMenu(); if (it.fn) it.fn(); },
    }, el('span', { style: { width: '14px', textAlign: 'center' }, text: it.ico || '' }),
      el('span', { text: it.l || '' }),
      it.hint ? el('span', { style: { marginLeft: 'auto', color: 'var(--ink-faint)', fontSize: 'calc(10.5px * var(--ui-s) * var(--ui-fs))' }, text: it.hint }) : null));
  }
  host.appendChild(m);
  const w = m.offsetWidth || 170, h = m.offsetHeight || 120;
  m.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  _menu = m;

  const onDown = (e) => { if (!m.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.code === 'Escape') { e.stopPropagation(); closeMenu(); } };
  const onWheel = () => closeMenu();
  const t = setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onWheel, true);
  }, 0);
  _menuOff = () => {
    clearTimeout(t);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('wheel', onWheel, true);
  };
  return m;
}

/* ---------- 浮层 ---------- */
let _pop = null;
let _popOff = null;

export function closePopover() {
  if (_popOff) { _popOff(); _popOff = null; }
  if (_pop) { _pop.remove(); _pop = null; }
}

/**
 * popover({ title, body, x, y, anchor, width, onReady })
 * anchor 为元素时贴在元素下方
 */
export function popover(opts = {}) {
  closePopover();
  const host = document.getElementById('app') || document.body;
  const p = el('div', { class: 'ed-pop' });
  if (opts.title) p.appendChild(el('h4', { text: opts.title }));
  if (opts.body) p.appendChild(typeof opts.body === 'string' ? el('div', { html: opts.body }) : opts.body);
  p.style.width = opts.width ? opts.width + 'px' : '';
  host.appendChild(p);

  let x = opts.x || 0, y = opts.y || 0;
  if (opts.anchor) {
    const r = opts.anchor.getBoundingClientRect();
    x = r.left; y = r.bottom + 6;
  }
  const w = p.offsetWidth || 240, h = p.offsetHeight || 160;
  p.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 10)) + 'px';
  p.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 10)) + 'px';
  _pop = p;

  const onDown = (e) => { if (!p.contains(e.target) && e.target !== opts.anchor) closePopover(); };
  const onKey = (e) => { if (e.code === 'Escape') { e.stopPropagation(); closePopover(); } };
  const t = setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);
  _popOff = () => {
    clearTimeout(t);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    if (opts.onClose) opts.onClose();
  };
  if (opts.onReady) opts.onReady(p);
  return p;
}

/* ---------- 颜色行 ---------- */
export function swatchBar(value, onPick) {
  const bar = el('div', { class: 'colorbar' });
  for (const c of PALETTE) {
    bar.appendChild(el('div', {
      class: 'sw', title: c,
      style: { background: c, outline: c.toLowerCase() === String(value).toLowerCase() ? '2px solid var(--acc)' : 'none' },
      onclick: () => onPick(c),
    }));
  }
  return bar;
}

/* ---------- 通用输入行 ---------- */
/** label 传字符串时为普通文字；传节点时可把开关等控件塞进标签里 */
export function row(label, ...kids) {
  const lb = el('label', { title: typeof label === 'string' ? label : '' });
  if (label instanceof Node) lb.appendChild(label); else lb.textContent = label;
  return el('div', { class: 'prow' }, lb, el('div', { class: 'f' }, ...kids));
}

export function numInput(value, opts = {}) {
  return el('input', {
    type: 'number', value: fmtNum(value),
    step: opts.st ?? 1, min: opts.min, max: opts.max,
    title: opts.h || '',
  });
}

export function fmtNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return String(r);
}

/** 按「量程长度」分档给出滚轮步进：>100→1，>10→0.5，>3→0.1，其余→0.01；无范围时用 st */
export function wheelStep(min, max, st = 0.1) {
  if (min === undefined || max === undefined) return st;
  const span = Math.abs(max - min);
  if (span > 100) return 1;
  if (span > 10) return 0.5;
  if (span > 3) return 0.1;
  return 0.01;
}

/** 数值框微调：按住 Shift + 鼠标悬停滚轮，按步进增减（opts.onEnd 在停止滚动后延迟触发，用于记录撤销） */
export function attachNumWheel(input, opts = {}) {
  const step = opts.step !== undefined ? opts.step : wheelStep(opts.min, opts.max, opts.st ?? 0.1);
  let timer = 0;
  input.addEventListener('wheel', (e) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const cur = Number(input.value);
    let v = (isFinite(cur) ? cur : 0) + (e.deltaY < 0 ? step : -step);
    v = Math.round(v * 1e6) / 1e6;
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    input.value = fmtNum(v);
    if (opts.onStep) opts.onStep(v);
    if (opts.onEnd) { clearTimeout(timer); timer = setTimeout(opts.onEnd, 350); }
  }, { passive: false });
}

export function swtch(on, onChange) {
  const b = el('button', { class: 'switch' + (on ? ' on' : ''), type: 'button' });
  b.addEventListener('click', () => { b.classList.toggle('on'); onChange(b.classList.contains('on')); });
  return b;
}

/** 多选批量编辑：各对象取值不一致时下拉顶部的占位值 */
export const MIXED_VALUE = '\u0000__mixed__';

/** 批量编辑时把控件切到「（混合）」态（值不一致时用） */
export function markMixedSelect(sel, mixed, text = '（混合）') {
  if (!mixed) return;
  if (sel && typeof sel.setMixed === 'function') sel.setMixed(true, text);
}

/** 生成 GridSelect 控件（替换原生 <select>）：点击弹出方形 Cell 选择窗口 */
export function optSelect(options, value, onChange, cls = '') {
  return new GridSelect({
    value,
    cls,
    options,
    placeholder: '（未选择）',
    onChange: (v) => { if (v === MIXED_VALUE) return; if (onChange) onChange(v); },
  });
}

/** 对象下拉选项 */
export function objectOptions(level, filter) {
  const list = (level.objects || []).filter((o) => !filter || filter(o));
  return list.map((o) => ({ v: o.id, l: (o.name || '') + ' · ' + o.type + ' · ' + o.id }));
}

export function animOptions(level) {
  return [{ v: '', l: '（未指定）' }].concat((level.animations || []).map((a) => ({ v: a.id, l: a.name || a.id })));
}

export function eventOptions(level) {
  return [{ v: '', l: '（未指定）' }].concat((level.events || []).map((a) => ({ v: a.id, l: a.name || a.id })));
}

/* ---------- Game Object 引用器 ---------- */
/**
 * 对象引用器：点击即引用「当前视口中已选中的对象」；未选中仅 toast，不弹列表。
 * @param {{ed:any, get:()=>string, commit:(id:string)=>void,
 *          filter?:(o:any)=>boolean, hint?:string, label?:string, allowEmpty?:boolean}} opts
 * @returns HTMLElement（按钮，allowEmpty 时附带一个 ✕ 清除按钮）
 */
export function objRefButton(opts) {
  const { ed, get, commit, filter } = opts;
  const wrap = el('span', { class: 'objref-wrap' });
  const btn = el('button', { class: 'mini objref', type: 'button' });
  let clr = null;
  const paint = () => {
    const id = get();
    const o = id ? getObject(ed.level, id) : null;
    btn.textContent = o ? (objectLabel(o) + ' · ' + o.type + ' · ' + o.id) : '（无引用）';
    btn.title = o ? '引用：' + btn.textContent + '\n点击可改为引用当前视口选中的对象' : '点击引用当前视口选中的对象';
    btn.classList.toggle('empty', !o);
    if (clr) clr.style.display = o ? '' : 'none';
  };
  btn.addEventListener('click', () => {
    const first = [...ed.selection][0];
    const o = first ? getObject(ed.level, first) : null;
    if (!o) { toast('请先在视口 / 对象树里选中一个对象', '', 2000); return; }
    if (filter && !filter(o)) { toast(opts.hint || '该类型不能作为引用对象', 'err', 2200); return; }
    commit(o.id);
    paint();
  });
  wrap.appendChild(btn);
  if (opts.allowEmpty) {
    clr = el('button', {
      class: 'mini objref-x', type: 'button', text: '✕', title: '清除引用',
      onclick: () => { commit(''); paint(); },
    });
    wrap.appendChild(clr);
  }
  paint();
  return wrap;
}

/** 简易列表编辑（vec3list / strlist / objlist 用）
 *  支持：单击选中、Ctrl/Cmd 加选、Shift 范围连选、「移除选中」批量删除、单项 ✕ 删除
 */
export function listEditor(items, render, onChange, addFn) {
  const box = el('div', {});
  const list = el('div', { class: 'listbox' });
  const sel = new Set();      // 选中项下标
  let anchor = -1;            // Shift 连选锚点
  const commit = () => onChange(items);
  const removeAt = (idxs) => {
    const uniq = [...new Set(idxs)].sort((a, b) => b - a);
    for (const i of uniq) items.splice(i, 1);
    sel.clear();
    anchor = -1;
    rebuild();
    syncBar();
    commit();
  };
  const rebuild = () => {
    clear(list);
    for (const i of [...sel]) if (i >= items.length) sel.delete(i);
    if (!items.length) list.appendChild(el('div', { class: 'li', style: { color: 'var(--ink-faint)' }, text: '（空）' }));
    items.forEach((it, i) => {
      const rowEl = el('div', { class: 'li' + (sel.has(i) ? ' sel' : '') }, render(it, i));
      rowEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('input,textarea,select,button')) return;   // 输入框 / 按钮不参与选中
        e.preventDefault();
        if (e.shiftKey && anchor >= 0) {
          const a = Math.min(anchor, i), b = Math.max(anchor, i);
          sel.clear();
          for (let k = a; k <= b; k++) sel.add(k);
        } else if (e.ctrlKey || e.metaKey) {
          if (sel.has(i)) sel.delete(i); else sel.add(i);
          anchor = i;
        } else {
          sel.clear();
          sel.add(i);
          anchor = i;
        }
        rebuild();
        syncBar();
      });
      rowEl.appendChild(el('button', {
        class: 'rm', type: 'button', text: '✕', title: '移除该项',
        onclick: (e) => { e.stopPropagation(); removeAt([i]); },
      }));
      list.appendChild(rowEl);
    });
  };
  box.appendChild(list);

  /* 底部操作条：批量移除选中 */
  const bar = el('div', { class: 'addline' });
  const syncBar = () => {
    clear(bar);
    const n = sel.size;
    if (n) bar.appendChild(el('button', {
      class: 'mini danger', type: 'button', text: '✕ 移除选中 (' + n + ')',
      onclick: () => removeAt([...sel]),
    }));
    if (addFn) bar.appendChild(el('button', {
      class: 'mini', type: 'button', text: '＋ 添加',
      onclick: () => { addFn(items); rebuild(); syncBar(); commit(); },
    }));
    bar.style.display = bar.childElementCount ? '' : 'none';
  };
  rebuild();
  syncBar();
  box.appendChild(bar);
  return box;
}