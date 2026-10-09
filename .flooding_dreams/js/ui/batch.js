/* ============================================================
   列表批量操作：多选 + 批量工具栏
   ------------------------------------------------------------
   给任意「卡片 / 行」列表装上批量能力：
   · 工具栏：开关批量模式 / 全选 / 反选 / 清空 + 各列表自定义动作
   · 批量模式下点条目 = 选中（Shift 连选、Ctrl/Cmd 反选），条目自带按钮被拦截
   · 列表每次重渲染后调 sync() 重新贴勾选框；选择按 id 记忆，条目消失自动剔除
   ============================================================ */
import { el } from './dom.js';

export class BatchBar {
  /**
   * @param opts {
   *   host: HTMLElement,             列表容器（条目所在处）
   *   itemSelector: string,          条目选择器，如 '.lv-card'
   *   idOf: (node) => string,        从条目节点取稳定 id
   *   actions?: [{ label, title?, cls?, run(ids: string[]) }],
   *   onModeChange?(on: boolean),
   * }
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.host = opts.host;
    this.itemSelector = opts.itemSelector || '.lv-card';
    this.idOf = opts.idOf || ((n) => n.dataset.id || n.dataset.uid || '');
    this.actions = opts.actions || [];
    this.ids = new Set();
    this.on = false;
    this.available = true;
    this.visible = true;
    this._last = -1;
    this._busy = false;
    this._build();
    this._bindHost();
    this.sync();
  }

  /* ---------- 构建 ---------- */
  _build() {
    this.toggle = el('button', {
      class: 'mini batch-toggle', type: 'button', text: '☑ 批量操作',
      title: '进入批量操作：多选后一次性导出 / 复制 / 删除',
      onclick: () => this.setMode(!this.on),
    });
    this.countEl = el('span', { class: 'batch-n', text: '已选 0' });
    this.tools = el('div', { class: 'batch-tools hidden' },
      this.countEl,
      el('button', { class: 'mini', type: 'button', text: '全选', title: '选中当前列表里的全部条目', onclick: () => this.selectAll() }),
      el('button', { class: 'mini', type: 'button', text: '反选', title: '已选的取消、未选的选上', onclick: () => this.invert() }),
      el('button', { class: 'mini', type: 'button', text: '清空', title: '清空当前选择', onclick: () => this.clear() }),
    );
    this.btns = [];
    if (this.actions.length) {
      this.tools.appendChild(el('span', { class: 'batch-sep' }));
      for (const a of this.actions) {
        const b = el('button', {
          class: 'mini' + (a.cls ? ' ' + a.cls : ''), type: 'button', text: a.label, title: a.title || '',
          disabled: true, onclick: () => this._run(a),
        });
        this.btns.push({ a, b });
        this.tools.appendChild(b);
      }
    }
    this.tools.appendChild(el('span', { class: 'batch-sep' }));
    this.tools.appendChild(el('button', { class: 'mini batch-exit', type: 'button', text: '退出批量', onclick: () => this.setMode(false) }));
    this.bar = el('div', { class: 'batch-bar' }, this.toggle, this.tools);
    if (this.host && this.host.parentNode) this.host.parentNode.insertBefore(this.bar, this.host);
  }

  /** 批量模式下拦截条目自身的点击，改成选中 / 取消选中 */
  _bindHost() {
    if (!this.host) return;
    this.host.addEventListener('click', (ev) => {
      if (!this.on) return;
      const item = ev.target.closest(this.itemSelector);
      if (!item || !this.host.contains(item)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const nodes = this._nodes();
      const idx = nodes.indexOf(item);
      const id = String(this.idOf(item) || '');
      if (!id || idx < 0) return;
      if (ev.shiftKey && this._last >= 0) {
        const a = Math.min(this._last, idx);
        const b = Math.max(this._last, idx);
        for (let i = a; i <= b; i++) { const n = String(this.idOf(nodes[i]) || ''); if (n) this.ids.add(n); }
      } else if (ev.ctrlKey || ev.metaKey) {
        if (this.ids.has(id)) this.ids.delete(id); else this.ids.add(id);
        this._last = idx;
      } else {
        if (this.ids.size === 1 && this.ids.has(id)) this.ids.delete(id);
        else { this.ids.clear(); this.ids.add(id); }
        this._last = idx;
      }
      this.sync();
    }, true);
  }

  /* ---------- 状态 ---------- */
  _nodes() { return this.host ? Array.from(this.host.querySelectorAll(this.itemSelector)) : []; }

  /** 列表重渲染后调用：剔除失效选择 + 重新贴勾选框 */
  sync() {
    if (!this.bar) return;
    if (this.host) this.host.classList.toggle('batch-on', this.on);
    const nodes = this._nodes();
    const live = new Set();
    for (const n of nodes) { const id = String(this.idOf(n) || ''); if (id) live.add(id); }
    for (const id of [...this.ids]) if (!live.has(id)) this.ids.delete(id);
    for (const n of nodes) {
      const old = n.querySelector(':scope > .batch-check');
      if (!this.on) {
        if (old) old.remove();
        n.classList.remove('batch-sel');
        continue;
      }
      const box = old || el('span', { class: 'batch-check' });
      if (!old) n.insertBefore(box, n.firstChild);
      const on = this.ids.has(String(this.idOf(n) || ''));
      box.textContent = on ? '✓' : '';
      box.classList.toggle('on', on);
      n.classList.toggle('batch-sel', on);
    }
    this._update();
  }

  _update() {
    this.tools.classList.toggle('hidden', !this.on);
    this.toggle.classList.toggle('hidden', this.on);
    const n = this.ids.size;
    this.countEl.textContent = '已选 ' + n;
    for (const { b } of this.btns) b.disabled = n === 0 || this._busy;
    this._applyVisible();
  }

  _applyVisible() {
    const show = this.visible && (this.on || this.available);
    this.bar.classList.toggle('hidden', !show);
  }

  setMode(on) {
    const next = !!on;
    if (next === this.on) return;
    this.on = next;
    this.ids.clear();
    this._last = -1;
    this.sync();
    this.opts.onModeChange && this.opts.onModeChange(this.on);
  }

  /** 列表是否为空（空时连开关都不显示） */
  setAvailable(v) { this.available = !!v; this._applyVisible(); }

  /** 面板整体显隐（如关卡 / 关卡包页签切换） */
  setVisible(v) { this.visible = v !== false; this._applyVisible(); }

  selectAll() {
    for (const n of this._nodes()) { const id = String(this.idOf(n) || ''); if (id) this.ids.add(id); }
    this.sync();
  }
  invert() {
    const next = new Set();
    for (const n of this._nodes()) { const id = String(this.idOf(n) || ''); if (id && !this.ids.has(id)) next.add(id); }
    this.ids = next;
    this.sync();
  }
  clear() { this.ids.clear(); this.sync(); }

  /** 当前选中的 id（按列表显示顺序） */
  selected() {
    return this._nodes().map((n) => String(this.idOf(n) || '')).filter((id) => id && this.ids.has(id));
  }

  async _run(a) {
    const ids = this.selected();
    if (!ids.length || this._busy) return;
    this._busy = true;
    this._update();
    try { await a.run(ids); }
    finally { this._busy = false; this.sync(); }
  }

  destroy() { this.bar && this.bar.remove(); this.bar = null; }
}
