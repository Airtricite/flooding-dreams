/* ============================================================
   天空修饰器（Sky Modifier）· 独立弹出窗口
   ------------------------------------------------------------
   · 浮动窗口（复用 .ez-win 外壳，可拖动，单例）
   · 左侧 = 修饰器栈（可加多个：启用 / 上移 / 下移 / 删除）
   · 右侧 = 选中修饰器的参数（参数改动即时作用到编辑器天空）
   · 数据写在 level.settings.skyMods，随关卡 JSON 走；只影响背景，
     环境反射（PMREM）与物理光照不受影响
   ============================================================ */
import { el, clear, toast } from '../ui/dom.js';
import { row, numInput, swtch, attachNumWheel } from './widgets.js';
import { GridSelect } from '../ui/grid-picker.js';
import {
  SKYMOD_GROUPS, SKYMOD_TYPES, SKYMOD_BY_ID, SKYMOD_MAX,
  newSkyMod, skyModSummary,
} from '../core/sky-modifier.js';

let _inst = null;
export function openSkyModEditor(ed) {
  if (_inst) { _inst.close(); _inst = null; }
  _inst = new SkyModEditor(ed);
  return _inst;
}
export function closeSkyModEditor() {
  if (_inst) { _inst.close(); _inst = null; }
}

class SkyModEditor {
  constructor(ed) {
    this.ed = ed;
    this.sel = 0;
    this._prev = null;      // 连续编辑（拖数字 / 吸色）的撤销快照
    this._closed = false;
    this._build();
  }

  _mods() {
    const S = this.ed.level.settings || (this.ed.level.settings = {});
    if (!Array.isArray(S.skyMods)) S.skyMods = [];
    return S.skyMods;
  }

  /* ============================================================
     骨架
     ============================================================ */
  _build() {
    const win = el('div', { class: 'ez-win sm-win' });
    this.win = win;

    const head = el('div', { class: 'ez-head' },
      el('span', { class: 'ez-title', text: '天空修饰器' }),
      el('span', { class: 'ez-sub', text: '几何变形 + 色彩 / 曝光 · 可叠加 · 无缝' }),
      el('button', { class: 'ez-x', text: '✕', title: '关闭（Esc）', onclick: () => this.close() }));
    win.appendChild(head);

    this.listEl = el('div', { class: 'sm-list' });
    this.rightEl = el('div', { class: 'sm-right' });

    const left = el('div', { class: 'sm-left' }, this.listEl, this._buildAdd());
    win.appendChild(el('div', { class: 'sm-body' }, left, this.rightEl));

    win.appendChild(el('div', { class: 'ez-foot sm-foot' },
      el('span', { class: 'sm-status', text: '几何修饰按列表顺序作用于采样方向，色彩 / 曝光修饰再作用于结果。' }),
      el('button', { class: 'mbtn sm', text: '关闭', onclick: () => this.close() })));

    const host = document.getElementById('app') || document.body;
    host.appendChild(win);
    const w = win.offsetWidth || 720, h = win.offsetHeight || 520;
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
      win.style.left = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - drag.dx)) + 'px';
      win.style.top = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - drag.dy)) + 'px';
    });
    const stopDrag = () => { drag = null; };
    head.addEventListener('pointerup', stopDrag);
    head.addEventListener('pointercancel', stopDrag);

    this._onKey = (e) => {
      if (e.code !== 'Escape') return;
      /* 有 #modal（GridSelect 选择器 / 确认框）在显示时，Esc 交给它处理，
         否则一次 Esc 会连本窗口一起关掉 */
      const m = document.getElementById('modal');
      if (m && !m.classList.contains('hidden')) return;
      e.stopPropagation(); e.preventDefault(); this.close();
    };
    window.addEventListener('keydown', this._onKey, true);

    this.refresh();
  }

  _buildAdd() {
    const catSel = new GridSelect({
      value: SKYMOD_GROUPS[0].v, cls: 'inp sm',
      options: SKYMOD_GROUPS,
      onChange: () => fillTypes(),
    });
    const typeSel = new GridSelect({ value: '', cls: 'inp sm', options: [] });
    const fillTypes = () => {
      const opts = SKYMOD_TYPES.filter((t) => t.g === catSel.value).map((t) => ({ v: t.v, l: t.l }));
      typeSel.setOptions(opts);
      typeSel.setValue(opts.length ? opts[0].v : '');
    };
    fillTypes();

    return el('div', { class: 'sm-add' }, catSel.el, typeSel.el, el('button', {
      class: 'mini', text: '＋ 添加修饰器',
      onclick: () => {
        const type = typeSel.value;
        if (!SKYMOD_BY_ID[type]) return;
        if (this._mods().length >= SKYMOD_MAX) { toast('最多 ' + SKYMOD_MAX + ' 个修饰器', 'err'); return; }
        const m = newSkyMod(type);
        this._structural('添加天空修饰器', () => {
          this._mods().push(m);
          this.sel = this._mods().length - 1;
        });
      },
    }));
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    window.removeEventListener('keydown', this._onKey, true);
    if (this._prev != null) { this._end(); }
    if (this.win && this.win.parentNode) this.win.parentNode.removeChild(this.win);
    if (_inst === this) _inst = null;
    if (this.ed && this.ed.refreshProps) this.ed.refreshProps();
  }

  /* ============================================================
     应用 / 撤销
     ============================================================ */
  _applyLive() {
    try { this.ed.applyLevelSettings(); } catch (e) { /* ignore */ }
  }
  _begin() { if (this._prev == null) this._prev = this.ed.snap(); }
  _end() {
    if (this._prev == null) return;
    const prev = this._prev;
    this._prev = null;
    this.ed.record('天空修饰器', prev, { props: true });
  }
  /** 结构性改动（增删 / 排序 / 开关）：一次撤消 + 重画面板 */
  _structural(label, fn) {
    this.ed.edit(label, fn, { props: true });
    this._applyLive();
    this.refresh();
  }

  /* ============================================================
     列表 + 参数
     ============================================================ */
  refresh() {
    this._buildList();
    this._buildParams();
  }

  _buildList() {
    clear(this.listEl);
    const mods = this._mods();
    if (!mods.length) {
      this.listEl.appendChild(el('div', { class: 'sm-empty', text: '还没有修饰器。在下方选择类型后添加。' }));
      return;
    }
    mods.forEach((m, i) => {
      const t = SKYMOD_BY_ID[m.type];
      const r = el('div', { class: 'sm-row' + (i === this.sel ? ' sel' : '') + (m.on === false ? ' off' : '') });
      r.appendChild(el('div', { class: 'sm-rowmain' },
        el('div', { class: 'sm-name', text: (i + 1) + '. ' + (t ? t.l : m.type) }),
        el('div', { class: 'sm-sub', text: skyModSummary(m) })));
      r.appendChild(el('div', { class: 'sm-acts' },
        el('button', {
          class: 'mini', text: m.on === false ? '·' : '👁', title: '启用 / 停用该修饰器',
          onclick: (e) => {
            e.stopPropagation();
            this._structural('天空修饰器开关', () => { m.on = m.on === false; });
          },
        }),
        el('button', {
          class: 'mini', text: '↑', title: '上移',
          onclick: (e) => { e.stopPropagation(); this._move(i, -1); },
        }),
        el('button', {
          class: 'mini', text: '↓', title: '下移',
          onclick: (e) => { e.stopPropagation(); this._move(i, 1); },
        }),
        el('button', {
          class: 'mini danger', text: '✕', title: '删除该修饰器',
          onclick: (e) => { e.stopPropagation(); this._remove(i); },
        })));
      r.addEventListener('click', () => { this.sel = i; this.refresh(); });
      this.listEl.appendChild(r);
    });
  }

  _move(i, d) {
    const mods = this._mods();
    const j = i + d;
    if (j < 0 || j >= mods.length) return;
    this._structural('天空修饰器排序', () => {
      const [m] = mods.splice(i, 1);
      mods.splice(j, 0, m);
      this.sel = j;
    });
  }

  _remove(i) {
    this._structural('删除天空修饰器', () => {
      this._mods().splice(i, 1);
      const n = this._mods().length;
      this.sel = Math.max(0, Math.min(this.sel, n - 1));
    });
  }

  _buildParams() {
    clear(this.rightEl);
    const mods = this._mods();
    const m = mods[this.sel];
    if (!m) {
      this.rightEl.appendChild(el('div', { class: 'sm-empty', text: '选中一个修饰器以编辑参数。' }));
      return;
    }
    const t = SKYMOD_BY_ID[m.type];
    if (!t) return;

    this.rightEl.appendChild(el('div', { class: 'sm-title', text: t.l }));
    if (t.h) this.rightEl.appendChild(el('div', { class: 'sm-hint', text: t.h }));
    this.rightEl.appendChild(row('启用', swtch(m.on !== false, (v) => {
      this._structural('天空修饰器开关', () => { m.on = !!v; });
    })));
    for (const d of t.p) {
      this.rightEl.appendChild(row(d.l || d.k, this._paramControl(m, d)));
    }
  }

  _paramControl(m, d) {
    if (d.t === 'color') {
      const c = el('input', { class: 'sm-color', type: 'color', value: m.p[d.k] || '#ffffff' });
      c.addEventListener('input', () => { this._begin(); m.p[d.k] = c.value; this._applyLive(); this._syncRow(); });
      c.addEventListener('change', () => { this._end(); this._buildList(); });
      return c;
    }
    const inp = numInput(m.p[d.k], { min: d.min, max: d.max, st: d.st });
    const setVal = (v) => {
      let n = Number(v);
      if (!isFinite(n)) return false;
      if (d.min !== undefined) n = Math.max(d.min, n);
      if (d.max !== undefined) n = Math.min(d.max, n);
      if (d.t === 'int') n = Math.round(n);
      this._begin();
      m.p[d.k] = n;
      this._applyLive();
      this._syncRow();
      return true;
    };
    inp.addEventListener('input', () => { setVal(inp.value); });
    inp.addEventListener('change', () => { if (setVal(inp.value)) inp.value = m.p[d.k]; this._end(); this._buildList(); });
    inp.addEventListener('blur', () => { inp.value = m.p[d.k]; this._end(); });
    attachNumWheel(inp, {
      min: d.min, max: d.max, step: d.st,
      onStep: (v) => { setVal(v); inp.value = m.p[d.k]; },
      onEnd: () => { this._end(); this._buildList(); },
    });
    return inp;
  }

  /** 参数变化时只刷新列表里的摘要文字，避免整块重建打断输入焦点 */
  _syncRow() {
    const rows = this.listEl.querySelectorAll('.sm-row');
    const r = rows[this.sel];
    if (!r) return;
    const sub = r.querySelector('.sm-sub');
    const m = this._mods()[this.sel];
    if (sub && m) sub.textContent = skyModSummary(m);
  }
}