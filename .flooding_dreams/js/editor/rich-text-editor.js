/* ============================================================
   富文本编辑器（文字方块 / 公告板专用）
   - 数据模型：o.rich = [{ t 文本, b 加粗, i 斜体, u 下划线, c 颜色, s 字号倍率 }]
     段落内的 \n 表示换行；水平对齐沿用对象自身的 o.align（整块对齐）
   - 用 contenteditable + 工具栏实现：加粗 / 斜体 / 下划线 / 颜色 / 字号
   - 保存时把 DOM 序列化成 runs（按 computedStyle 还原样式），并镜像一份纯文本到 o.text
   - 打开时若对象没有 rich，就用 o.text + 当前 textColor/fontSize 初始化一份
   ============================================================ */
import { el, modal } from '../ui/dom.js';

const BASE_PX = 18;             // 编辑器里 1 倍字号对应的显示像素（用于 px ↔ 倍率换算）
const TOOL_COLORS = ['#ffffff', '#ffd54a', '#ff6b8a', '#7fe3ff', '#8affc1', '#c9a7ff', '#1b1730'];
const TOOL_SIZES = [
  { s: 0.75, l: '小' }, { s: 1, l: '默认' }, { s: 1.3, l: '大' }, { s: 1.7, l: '特大' },
];

/** rgb(a) 字符串 → #rrggbb（取不到返回 null） */
function hex6(rgb) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(rgb || ''));
  if (!m) return null;
  const h = (n) => Number(n).toString(16).padStart(2, '0');
  return '#' + h(m[1]) + h(m[2]) + h(m[3]);
}

/** 相邻同款式段落合并，减少 runs 数量 */
function pushRun(runs, t, st) {
  if (!t) return;
  const last = runs[runs.length - 1];
  if (last && last.b === st.b && last.i === st.i && last.u === st.u
    && (last.c || null) === (st.c || null) && last.s === st.s) { last.t += t; return; }
  runs.push({ t, b: st.b, i: st.i, u: st.u, c: st.c, s: st.s });
}

/** DOM → runs（样式以 computedStyle 为准，颜色等于基准色时视为「继承」不落数据） */
function serialize(root, baseHex) {
  const runs = [];
  const base = (baseHex || '').toLowerCase();
  const walk = (node, st) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { pushRun(runs, child.nodeValue.replace(/\r?\n/g, ' '), st); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === 'br') { pushRun(runs, '\n', st); continue; }
      const cs = window.getComputedStyle(child);
      const cHex = hex6(cs.color);
      const sc = Math.min(4, Math.max(0.3, (parseFloat(cs.fontSize) || BASE_PX) / BASE_PX));
      const ns = {
        b: st.b || Number(cs.fontWeight) >= 600,
        i: st.i || cs.fontStyle === 'italic',
        u: st.u || String(cs.textDecorationLine || cs.textDecoration || '').indexOf('underline') >= 0,
        c: (cHex && cHex.toLowerCase() !== base) ? cHex : st.c,
        s: Math.abs(sc - 1) > 0.01 ? Math.round(sc * 100) / 100 : st.s,
      };
      walk(child, ns);
    }
  };
  walk(root, { b: false, i: false, u: false, c: null, s: 1 });
  return runs;
}

/** runs → DOM */
function renderRuns(root, runs) {
  root.innerHTML = '';
  for (const r of runs) {
    const parts = String(r.t ?? '').split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) root.appendChild(el('br'));
      const p = parts[i];
      if (!p) continue;
      const span = el('span', { text: p });
      if (r.b) span.style.fontWeight = '700';
      if (r.i) span.style.fontStyle = 'italic';
      if (r.u) span.style.textDecoration = 'underline';
      if (r.c) span.style.color = r.c;
      if (r.s && Math.abs(r.s - 1) > 0.01) span.style.fontSize = (r.s * BASE_PX) + 'px';
      root.appendChild(span);
    }
  }
}

/** 用 runs 或纯文本生成初始富文本数据 */
function seedRuns(o) {
  if (Array.isArray(o.rich) && o.rich.length) return o.rich.map((r) => ({ ...r }));
  const text = String(o.text ?? '');
  return text ? [{ t: text, b: !!o.bold, i: false, u: false, c: null, s: 1 }] : [];
}

/** 给选区包一层带样式的 span（用于颜色 / 字号；b/i/u 交给 execCommand） */
function wrapSelection(root, style) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;
  const span = el('span');
  Object.assign(span.style, style);
  try { range.surroundContents(span); }
  catch (e) { span.appendChild(range.extractContents()); range.insertNode(span); }
  sel.removeAllRanges();
  const r2 = document.createRange();
  r2.selectNodeContents(span);
  sel.addRange(r2);
  root.focus();
}

/**
 * 打开富文本编辑器；用户点「保存」且有改动时写回 o.rich / o.text / o.align。
 * @returns {Promise<boolean>} 是否产生了改动
 */
export async function openRichTextEditor(o) {
  if (!o) return false;
  const before = JSON.stringify({ rich: o.rich, text: o.text, align: o.align, bold: o.bold });
  let align = o.align === 'left' || o.align === 'right' ? o.align : 'center';

  const editable = el('div', {
    class: 'rte-edit',
    contenteditable: 'true',
    style: { color: o.textColor || '#ffffff', textAlign: align },
  });
  renderRuns(editable, seedRuns(o));

  // 回车插入 <br> 而不是新 div，序列化更简单
  editable.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak'); }
  });

  const mkBtn = (label, title, fn) => {
    const b = el('button', { class: 'mini', text: label, title, type: 'button' });
    b.addEventListener('mousedown', (e) => e.preventDefault());   // 保住选区
    b.addEventListener('click', fn);
    return b;
  };
  const cmd = (c) => () => { document.execCommand(c, false, null); editable.focus(); };

  const colorInp = el('input', {
    type: 'color', value: '#ffd54a', title: '文字颜色',
    style: { width: 'calc(34px * var(--ui-s))', height: 'calc(26px * var(--ui-s))',
      padding: '0', border: 'none', background: 'transparent', cursor: 'pointer' },
  });
  colorInp.addEventListener('mousedown', (e) => e.stopPropagation());
  colorInp.addEventListener('input', () => wrapSelection(editable, { color: colorInp.value }));

  const sizeSel = el('select', { class: 'inp', title: '字号' });
  sizeSel.appendChild(el('option', { value: '', text: '字号' }));
  for (const s of TOOL_SIZES) sizeSel.appendChild(el('option', { value: String(s.s), text: s.l }));
  sizeSel.addEventListener('mousedown', (e) => e.stopPropagation());
  sizeSel.addEventListener('change', () => {
    if (sizeSel.value) wrapSelection(editable, { fontSize: (Number(sizeSel.value) * BASE_PX) + 'px' });
    sizeSel.value = '';
  });

  const alignBtn = (v) => mkBtn(v === 'left' ? '⯇' : v === 'right' ? '⯈' : '≡',
    '水平对齐', () => { align = v; editable.style.textAlign = v; editable.focus(); });

  const toolbar = el('div', { class: 'rte-bar' },
    mkBtn('B', '加粗', cmd('bold')),
    mkBtn('I', '斜体', cmd('italic')),
    mkBtn('U', '下划线', cmd('underline')),
    colorInp,
    sizeSel,
    el('span', { class: 'rte-sep' }),
    alignBtn('left'), alignBtn('center'), alignBtn('right'),
    el('span', { class: 'rte-sep' }),
    mkBtn('清除格式', '清空全部文字', () => {
      editable.innerHTML = '';
      align = 'center';
      editable.style.textAlign = 'center';
      editable.focus();
    }),
  );

  const tip = el('div', { class: 'se-tip', text:
    '选中文字后点 B / I / U 或挑颜色、字号；换行用回车。'
    + '对象自身的「字号 / 文字颜色」作为基准，富文本里单独设过的才覆盖。' });

  const body = el('div', { class: 'rte-wrap' }, toolbar, editable, tip);

  const v = await modal({
    title: '富文本编辑器',
    body,
    buttons: [
      { label: '取消', value: null, cls: 'ghost' },
      { label: '保存', value: 'ok', cls: 'primary' },
    ],
    onReady: () => {
      editable.focus();
      const sel = window.getSelection();
      if (sel) { const r = document.createRange(); r.selectNodeContents(editable); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    },
  });
  if (v !== 'ok') return false;

  const runs = serialize(editable, hex6(o.textColor) || '#ffffff');
  if (runs.length) {
    o.rich = runs;
    o.text = runs.map((r) => r.t).join('');
  } else {
    o.rich = [];
  }
  o.align = align;

  return JSON.stringify({ rich: o.rich, text: o.text, align: o.align, bold: o.bold }) !== before;
}