/* ============================================================
   独立代码编辑器窗口（事件「代码块 / JS 表达式」用）
   ------------------------------------------------------------
   · 可拖动窗口（复用 .ez-win 外壳样式），z-index 94
   · 左侧是手写代码编辑器（语法高亮 + 自动补全），右侧常驻世界 API 参考
   · 底部是实时语法状态 + 取消 / 保存；Ctrl+Enter 保存并关闭
   · Escape：补全开着先收起补全，否则关窗
   · 单例：同一时刻只允许一个代码编辑器窗口
   ============================================================ */
import { el } from '../ui/dom.js';
import { WORLD_API_DOC } from '../world/worldapi.js';
import { createCodeField } from './code-field.js';

let _cwWin = null;

/**
 * 打开代码编辑器窗口
 * @param {object} opts
 *   value    初始代码
 *   expr     true = 单表达式模式（校验按表达式编译）
 *   onChange (value) => void：点「保存」/ Ctrl+Enter 时调用（点「取消」不调用）
 */
export function openCodeWindow(opts = {}) {
  if (_cwWin) { _cwWin.close(); _cwWin = null; }
  const expr = !!opts.expr;

  const win = el('div', { class: 'ez-win cw-win' });
  const head = el('div', { class: 'ez-head' },
    el('span', { class: 'ez-title', text: expr ? 'JS 表达式' : 'JS 代码块' }),
    el('span', { class: 'ez-sub', text: 'Ctrl+Enter 保存并关闭 · Esc 关闭' }),
    el('button', { class: 'ez-x', text: '✕', title: '关闭', onclick: () => close() }));

  /* ---------- 编辑器 ---------- */
  const status = el('span', { class: 'cw-status', text: '' });
  const field = createCodeField({
    value: opts.value || '',
    expr,
    rows: 0,
    fill: true,
    placeholder: expr
      ? 'world.raycast(player, "door").hit ? 1 : 0'
      : 'const h = world.get("obj_1");\nif (h) h.move([0, 1, 0]);\nawait wait(1);   // 暂停 1 秒再往下走',
    onCheck: (err) => {
      status.textContent = err ? '语法错误：' + err : '语法正常';
      status.classList.toggle('bad', !!err);
    },
  });

  /* ---------- 右侧 API 参考 ---------- */
  const doc = el('div', { class: 'cw-doc' },
    el('div', { class: 'api-ref' }, WORLD_API_DOC.map((g) => [
      el('div', { class: 'ar-head', text: g.t }),
      ...(g.list || []).map((it) => el('div', { class: 'ar-item' },
        el('b', { text: it.n }), el('span', { text: it.d || '' }))),
    ])));

  const foot = el('div', { class: 'ez-foot cw-foot' },
    status,
    el('button', { class: 'mbtn sm', text: '取消', onclick: () => close() }),
    el('button', { class: 'mbtn sm primary', text: '保存', onclick: () => save() }));

  win.appendChild(head);
  win.appendChild(el('div', { class: 'cw-body' }, field.el, doc));
  win.appendChild(foot);

  /* ---------- 拖拽移动 ---------- */
  const host = document.getElementById('app') || document.body;
  host.appendChild(win);
  const w = win.offsetWidth || 760, h = win.offsetHeight || 460;
  win.style.left = Math.max(8, Math.min(window.innerWidth - w - 12, (window.innerWidth - w) / 2)) + 'px';
  win.style.top = Math.max(8, Math.min(window.innerHeight - h - 12, (window.innerHeight - h) / 2)) + 'px';
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { head.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    win.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx)) + 'px';
    win.style.top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - drag.dy)) + 'px';
  });
  const endMove = () => { drag = null; };
  head.addEventListener('pointerup', endMove);
  head.addEventListener('pointercancel', endMove);

  /* ---------- 键盘 ---------- */
  const onKey = (e) => {
    if (e.code === 'Escape') {
      e.stopPropagation();
      if (field.isAcOpen()) { field.closeAc(); return; }
      close();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      save();
    }
  };
  window.addEventListener('keydown', onKey, true);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    field.destroy();
    win.remove();
    if (_cwWin && _cwWin.win === win) _cwWin = null;
    if (opts.onClose) opts.onClose();
  }
  function save() {
    const v = field.getValue();
    close();
    if (opts.onChange) opts.onChange(v);
  }

  field.focus();
  _cwWin = { win, close, field };
  return _cwWin;
}

/** 关闭代码编辑器窗口（离开事件页签 / 退出编辑器时调用） */
export function closeCodeWindow() {
  if (_cwWin) { _cwWin.close(); _cwWin = null; }
}