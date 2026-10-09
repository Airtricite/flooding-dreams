/* ============================================================
   对象树 / 浏览器：层级树、搜索筛选、可见性、拖拽编组、右键菜单
   ============================================================ */
import { el, clear, toast } from '../ui/dom.js';
import { chunkedAppend } from '../ui/render-queue.js';
import { OBJECT_TYPES, TYPE_KEYS, typeDef } from '../world/objectTypes.js';
import { getObject, childrenOf, objectLabel } from '../world/level.js';
import { contextMenu } from './widgets.js';
import { GridSelect } from '../ui/grid-picker.js';

export class Outliner {
  constructor(ed) {
    this.ed = ed;
    this.host = document.getElementById('pane-outliner');
    this.list = document.getElementById('tree');
    this.expanded = new Set();
    this.query = '';
    this.typeFilter = '';
    this._dragId = null;
    this._chunk = null;
    this._build();
  }

  _build() {
    const head = this.host && this.host.querySelector('.pane-head');
    const bar = el('div', { class: 'addline', style: { padding: '3px 5px', margin: '0', flex: 'none', background: 'rgba(0,0,0,.14)' } });
    this.searchInp = el('input', {
      class: 'inp sm', type: 'search', placeholder: '搜索对象…', style: { flex: '1', minWidth: '0' },
      oninput: () => { this.query = this.searchInp.value; this.render(); },
    });
    this.typeSel = new GridSelect({
      value: '',
      cls: 'inp sm',
      options: [{ v: '', l: '全部' }].concat(TYPE_KEYS.map((k) => ({ v: k, l: OBJECT_TYPES[k].label }))),
      onChange: (v) => { this.typeFilter = v; this.render(); },
    });
    this.typeSel.el.style.width = '76px';
    bar.appendChild(this.searchInp);
    bar.appendChild(this.typeSel.el);
    if (head && head.nextSibling) this.host.insertBefore(bar, head.nextSibling);
    else if (head) this.host.appendChild(bar);
    this._bar = bar;

    // 拖到空白区域 → 移出父级（变成顶层对象）
    const body = this.host.querySelector('.pane-body');
    if (body) {
      body.addEventListener('dragover', (e) => { e.preventDefault(); });
      body.addEventListener('drop', (e) => {
        if (e.target.closest('.trow')) return;
        e.preventDefault();
        if (this._dragId) this.ed.reparent(this._dragId, null);
        this._dragId = null;
      });
    }
  }

  refresh() { this.render(); }

  render() {
    const list = this.list;
    if (!list) return;
    const level = this.ed.level;
    // 上一次还没画完的分片队列先取消（搜索框边打字边重画时尤其重要）
    if (this._chunk) { this._chunk.cancel(); this._chunk = null; }
    clear(list);
    const q = (this.query || '').trim().toLowerCase();
    const tf = this.typeFilter;
    if (q || tf) {
      const matches = level.objects.filter((o) => {
        if (tf && o.type !== tf) return false;
        if (!q) return true;
        const label = objectLabel(o).toLowerCase();
        return label.includes(q) || o.type.includes(q) || o.id.toLowerCase().includes(q);
      });
      if (!matches.length) { list.appendChild(el('li', { class: 'empty-note', text: '没有匹配的对象' })); return; }
      this._chunk = chunkedAppend(list, matches, (o) => this.row(o, 1, false), { firstBatch: 40, perFrame: 24 });
      return;
    }
    const roots = level.objects.filter((o) => !o.parent || !getObject(level, o.parent));
    if (!roots.length) {
      list.appendChild(el('li', { class: 'empty-note', html: '还没有对象<br>用顶部「对象创建器」添加' }));
      return;
    }
    this._chunk = chunkedAppend(list, roots, (o) => this.node(o, 1), { firstBatch: 20, perFrame: 12 });
  }

  node(o, depth) {
    const kids = childrenOf(this.ed.level, o.id);
    const li = el('li', {});
    li.appendChild(this.row(o, depth, kids.length > 0));
    if (kids.length && this.expanded.has(o.id)) {
      const ul = el('ul', { class: 'tchild' });
      for (const c of kids) ul.appendChild(this.node(c, depth + 1));
      li.appendChild(ul);
    }
    return li;
  }

  row(o, depth, hasKids) {
    const ed = this.ed;
    const def = typeDef(o.type);
    const sel = ed.selection.has(o.id);
    const r = el('div', {
      class: 'trow' + (sel ? ' sel' : '') + (o.visible === false ? ' dim' : ''),
      dataset: { id: o.id },
      draggable: 'true',
      title: objectLabel(o) + ' · ' + def.label + ' · ' + o.id,
    });
    r.appendChild(el('span', {
      class: 'tw', text: hasKids ? (this.expanded.has(o.id) ? '▾' : '▸') : '',
      onclick: (e) => {
        e.stopPropagation();
        if (!hasKids) return;
        if (this.expanded.has(o.id)) this.expanded.delete(o.id); else this.expanded.add(o.id);
        this.render();
      },
    }));
    const icon = o.type === 'mesh' ? (typeDef(o.type).icon) : def.icon;
    r.appendChild(el('span', { class: 'ti', text: icon }));
    r.appendChild(el('span', { class: 'tn', text: objectLabel(o) }));
    r.appendChild(el('span', {
      class: 'tv', text: '⌖', title: '聚焦',
      onclick: (e) => { e.stopPropagation(); ed.focusOn([o.id]); },
    }));
    r.appendChild(el('span', {
      class: 'eye', text: o.visible === false ? '🚫' : '👁', title: '显示 / 隐藏',
      onclick: (e) => { e.stopPropagation(); ed.setVisible([o.id], o.visible === false); },
    }));

    r.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (!ed.selection.has(o.id)) ed.select([o.id]);
      }
    });
    r.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) ed.select([o.id], 'toggle');
      else if (e.shiftKey) ed.select([o.id], 'add');
      else ed.select([o.id]);
    });
    r.addEventListener('dblclick', () => ed.focusOn([o.id]));
    r.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!ed.selection.has(o.id)) ed.select([o.id]);
      this.menu(e.clientX, e.clientY, o);
    });
    r.addEventListener('dragstart', (e) => {
      this._dragId = o.id;
      try { e.dataTransfer.setData('text/plain', o.id); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* ignore */ }
    });
    r.addEventListener('dragend', () => { this._dragId = null; });
    r.addEventListener('dragover', (e) => { e.preventDefault(); r.style.outline = '1px solid var(--acc)'; });
    r.addEventListener('dragleave', () => { r.style.outline = 'none'; });
    r.addEventListener('drop', (e) => {
      e.preventDefault();
      r.style.outline = 'none';
      const from = this._dragId;
      this._dragId = null;
      if (!from || from === o.id) return;
      // 任何对象都能当父级（不只是编组）：拖到哪一行就成为哪一行的子级
      this.expanded.add(o.id);          // 展开落点，方便看到刚拖进去的子级
      ed.reparent(from, o.id);
    });
    return r;
  }

  menu(x, y, o) {
    const ed = this.ed;
    const ids = ed.selection.has(o.id) ? [...ed.selection] : [o.id];
    const inGroup = o.parent && getObject(ed.level, o.parent);
    contextMenu(x, y, [
      { label: ids.length > 1 ? ids.length + ' 个对象' : objectLabel(o) },
      { ico: '✎', l: '重命名', fn: () => ed.renameSelection() },
      { ico: '⧉', l: '复制 (Ctrl+D)', fn: () => ed.duplicateSelection() },
      { ico: '📋', l: '复制到剪贴板 (Ctrl+C)', fn: () => ed.copySelection() },
      { sep: true },
      { ico: '⧉', l: '编组 (Ctrl+G)', fn: () => ed.groupSelection() },
      { ico: '↰', l: inGroup ? '移出父级' : '移出父级（无父级）',
        hint: inGroup ? objectLabel(getObject(ed.level, o.parent)) : '', fn: () => ed.unparentSelection() },
      { sep: true },
      { ico: '📦', l: '导出为预制件…', hint: (ids.length > 1 ? ids.length + ' 个对象' : ''),
        fn: () => { if (ed.prefabPanel) ed.prefabPanel.exportSelection(ids); } },
      { sep: true },
      { ico: o.visible === false ? '👁' : '🚫', l: o.visible === false ? '显示' : '隐藏', fn: () => ed.setVisible(ids, o.visible === false) },
      { ico: '🔒', l: o.frozen ? '解除编辑锁定' : '锁定编辑', fn: () => ed.setFrozen(ids, !o.frozen) },
      { ico: '⌖', l: '聚焦 (F)', fn: () => ed.focusOn(ids) },
      { sep: true },
      { ico: '🗑', l: '删除 (Del)', danger: true, fn: () => ed.deleteSelection() },
    ]);
  }

  selectRow(id) {
    const r = this.list && this.list.querySelector('.trow[data-id="' + id + '"]');
    if (r && r.scrollIntoView) r.scrollIntoView({ block: 'nearest' });
  }
}