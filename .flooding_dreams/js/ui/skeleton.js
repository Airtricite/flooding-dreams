/* ============================================================
   列表加载占位：骨架卡 + 状态行
   ============================================================ */
import { el } from './dom.js';

/** n 张骨架卡（复用 .lv-card 的尺寸/圆角，内容用灰条） */
export function skeletonCards(n = 12, cls = 'lv-card skel') {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    frag.appendChild(el('div', { class: cls },
      el('div', { class: 'skel-thumb' }),
      el('div', { class: 'skel-line' }),
      el('div', { class: 'skel-line short' }),
    ));
  }
  return frag;
}

/** 一行状态文案（返回句柄，可 set / remove；node 供增量插入时保持位置） */
export function statusLine(host, text) {
  const node = el('div', { class: 'list-status', text: text || '' });
  host.appendChild(node);
  return {
    node,
    set(t) { node.textContent = t || ''; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
  };
}