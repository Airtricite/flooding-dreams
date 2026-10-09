/* ============================================================
   分包文件夹网格（folder grid）
   ------------------------------------------------------------
   把一串项目「按给定类」归成一个个文件夹卡片，卡片上用马赛克预览
   内含项目的图标；点文件夹钻进去看里面的项目，面包屑可返回。

   两种使用方式：
     · renderFolderGrid(host, { items, groupOf, ... })   分组浏览 + 钻取
     · renderFolderGrid(host, { items, groupOf:null, ... })  平铺项目卡片

   所有渲染都走 chunkedAppend（分片 DOM），列表再大也不阻塞主线程。
   ============================================================ */
import { el, clear } from './dom.js';
import { chunkedAppend } from './render-queue.js';
import { placeholderIcon } from './grid-picker.js';

const NO_GROUP = '__none__';

/** 由 icon 描述（或省略）生成图标节点 */
function _icon(icon, label) {
  if (icon && icon.type === 'img' && icon.src) {
    return el('img', { class: 'gp-ico', src: icon.src, alt: '', loading: 'lazy' });
  }
  if (icon && icon.type === 'sym') return placeholderIcon(icon.text || label, { sym: icon.text, color: icon.color });
  if (icon && icon.sym) return placeholderIcon(label, { sym: icon.sym, color: icon.color });
  return placeholderIcon(label);
}

/**
 * 文件夹卡片上的预览图标马赛克（2×2，最多 max 张小图标）。
 * @param {any[]} items
 * @param {{max?:number, iconOf?:(it:any)=>any, labelOf?:(it:any)=>string}} [opts]
 */
export function folderMosaic(items, opts = {}) {
  const max = opts.max || 4;
  const iconOf = opts.iconOf || (() => null);
  const labelOf = opts.labelOf || ((it) => (it && (it.name || it.l)) || '');
  const list = Array.isArray(items) ? items : [];
  const box = el('div', { class: 'fg-mos' });
  const n = Math.min(max, list.length);
  for (let i = 0; i < max; i++) {
    const cell = el('div', { class: 'fg-mc' });
    if (i < n) cell.appendChild(_icon(iconOf(list[i]), labelOf(list[i])));
    box.appendChild(cell);
  }
  return box;
}

/* ---------- 排序 ---------- */
function _cmp(a, b, by) {
  if (by === 'created' || by === 'updated') {
    return (Number(a[by]) || 0) - (Number(b[by]) || 0);
  }
  return String(a.name || a.l || a.id || '').localeCompare(String(b.name || b.l || b.id || ''), 'zh-Hans-CN');
}

function _sortList(list, sort) {
  const by = (sort && sort.by) || 'name';
  const dir = sort && sort.dir === 'desc' ? -1 : 1;
  return list.slice().sort((a, b) => _cmp(a, b, by) * dir);
}

function _sortGroups(groups, sort) {
  const by = (sort && sort.by) || 'name';
  const dir = sort && sort.dir === 'desc' ? -1 : 1;
  return groups.slice().sort((a, b) => {
    if (by === 'created' || by === 'updated') {
      const ta = a.items.reduce((m, it) => Math.max(m, Number(it[by]) || 0), 0);
      const tb = b.items.reduce((m, it) => Math.max(m, Number(it[by]) || 0), 0);
      return (ta - tb) * dir;
    }
    return String(a.label || '').localeCompare(String(b.label || ''), 'zh-Hans-CN') * dir;
  });
}

/* ---------- 分组 ---------- */
/** 一个项目归属的分组（groupOf 可以返回单个、数组（多归属）或 null） */
function _groupsOf(groupOf, it) {
  let g = null;
  try { g = groupOf ? groupOf(it) : null; } catch (e) { g = null; }
  const arr = Array.isArray(g) ? g : [g];
  return arr.filter((x) => x && x.key);
}

function _group(items, groupOf, preset) {
  const map = new Map();
  if (Array.isArray(preset)) {
    for (const g of preset) {
      if (!g || !g.key) continue;
      map.set(g.key, { key: g.key, label: g.label || g.key, hint: g.hint || '', items: [] });
    }
  }
  const add = (g, it) => {
    if (!map.has(g.key)) map.set(g.key, { key: g.key, label: g.label || g.key, hint: g.hint || '', items: [] });
    map.get(g.key).items.push(it);
  };
  for (const it of items) {
    const gs = _groupsOf(groupOf, it);
    if (!gs.length) add({ key: NO_GROUP, label: '未分组' }, it);   // 多归属：同一个项目进多个文件夹
    else for (const g of gs) add(g, it);
  }
  return [...map.values()].filter((g) => g.items.length);
}

/* ---------- 卡片 ---------- */
function _folderCard(g, opts) {
  const card = el('button', {
    class: 'fg-card folder', type: 'button',
    title: g.label + '（' + g.items.length + ' 项）',
    onclick: () => { if (opts.onOpenGroup) opts.onOpenGroup(g.key, g.label, g.items.length); },
  });
  card.appendChild(el('span', { class: 'fg-tab' }));
  card.appendChild(folderMosaic(g.items, { iconOf: opts.iconOf, labelOf: opts.labelOf }));
  card.appendChild(el('span', { class: 'gp-nm fg-nm', text: g.label }));
  card.appendChild(el('span', { class: 'gp-id fg-ct', text: g.items.length + ' 项' + (g.hint ? ' · ' + g.hint : '') }));
  return card;
}

function _itemCard(it, opts) {
  const label = String(it.name || it.l || it.id || '');
  const on = !!(opts.isActive && opts.isActive(it));
  const card = el('button', {
    class: 'fg-card item' + (on ? ' on' : ''), type: 'button',
    title: label + (it.id ? ' · ' + it.id : ''),
    onclick: () => { if (opts.onPick) opts.onPick(it); },
  });
  card.appendChild(_icon(opts.iconOf && opts.iconOf(it), label));
  card.appendChild(el('span', { class: 'gp-nm fg-nm', text: label }));
  const sub = opts.subOf && opts.subOf(it);
  if (sub) card.appendChild(el('span', { class: 'gp-id fg-ct', text: String(sub) }));
  if (opts.onContext) {
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); opts.onContext(it, e.clientX, e.clientY); });
  }
  return card;
}

/* ---------- 面包屑 ---------- */
function _crumbs(opts) {
  const bar = el('div', { class: 'fg-crumb' });
  bar.appendChild(el('button', {
    class: 'fg-cr', type: 'button', text: opts.rootLabel || '全部分包',
    title: '返回分包列表',
    onclick: () => { if (opts.onBack) opts.onBack(); },
  }));
  bar.appendChild(el('span', { class: 'fg-cr-sep', text: '›' }));
  bar.appendChild(el('span', { class: 'fg-cr on', text: String(opts.drillLabel || opts.drill || '') }));
  const ct = opts.drillCount;
  if (ct !== undefined && ct !== null) bar.appendChild(el('span', { class: 'fg-cr-ct', text: '(' + ct + ')' }));
  return bar;
}

/* ============================================================
   主入口
   ============================================================ */
/**
 * @param {HTMLElement} host 容器（会被清空）
 * @param {{
 *   items?: any[],
 *   groupOf?: (it:any)=>{key:string,label?:string,hint?:string}|null,
 *   groups?: Array<{key:string,label:string,hint?:string}>,
 *   sort?: {by?:'name'|'created'|'updated', dir?:'asc'|'desc'},
 *   drill?: string|null, drillLabel?: string, drillCount?: number,
 *   rootLabel?: string, emptyText?: string,
 *   iconOf?: (it:any)=>any, labelOf?: (it:any)=>string,
 *   subOf?: (it:any)=>string, isActive?: (it:any)=>boolean,
 *   onOpenGroup?: (key:string,label:string,count:number)=>void,
 *   onBack?: ()=>void,
 *   onPick?: (it:any)=>void,
 *   onContext?: (it:any,x:number,y:number)=>void,
 * }} opts
 * @returns {{items:any[], groups:any[]|null}}
 */
export function renderFolderGrid(host, opts = {}) {
  const out = { items: [], groups: null };
  if (!host) return out;
  // 上一次还没画完的分片队列先取消，避免切分包 / 换排序时旧数据混进来
  if (host.__fgChunk) { host.__fgChunk.cancel(); host.__fgChunk = null; }
  clear(host);
  const queue = (list, factory) => { host.__fgChunk = chunkedAppend(host, list, factory, { firstBatch: 16, perFrame: 10 }); };

  const all = Array.isArray(opts.items) ? opts.items : [];
  const groupOf = opts.groupOf || null;
  const drill = opts.drill || null;

  /* 钻入某个分包：只看该分包里的项目 */
  if (drill) {
    const list = _sortList(all.filter((it) => _groupsOf(groupOf, it).some((g) => g.key === drill)), opts.sort);
    out.items = list;
    host.appendChild(_crumbs(opts));
    if (!list.length) {
      host.appendChild(el('div', { class: 'gp-empty', text: opts.emptyText || '（这个分包是空的）' }));
      return out;
    }
    queue(list, (it) => _itemCard(it, opts));
    return out;
  }

  /* 分包浏览（给了 groups 预置就按预置顺序，否则按 sort 排） */
  if (groupOf) {
    const built = _group(all, groupOf, opts.groups);
    const groups = Array.isArray(opts.groups) ? built : _sortGroups(built, opts.sort);
    out.groups = groups;
    if (!groups.length) {
      host.appendChild(el('div', { class: 'gp-empty', text: opts.emptyText || '（没有可选项）' }));
      return out;
    }
    queue(groups, (g) => _folderCard(g, opts));
    return out;
  }

  /* 平铺 */
  const list = _sortList(all, opts.sort);
  out.items = list;
  if (!list.length) {
    host.appendChild(el('div', { class: 'gp-empty', text: opts.emptyText || '（没有可选项）' }));
    return out;
  }
  queue(list, (it) => _itemCard(it, opts));
  return out;
}