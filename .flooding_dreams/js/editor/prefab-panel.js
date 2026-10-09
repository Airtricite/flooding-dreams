/* ============================================================
   预制件工具箱（编辑器左栏「预制件」页签）
   ------------------------------------------------------------
   把关卡里多选出来的一组对象存成预制件，之后可以随时应用回任意关卡。
   两种分包模式：
     · 全局      —— 一个平铺列表，显示工具箱里的全部预制件
     · 按关卡    —— 按「创建自哪个关卡」分成一个个文件夹卡片
   排序：A→Z / Z→A / 创建时间。读取与渲染全部渐进（先骨架、后分片填充）。
   ============================================================ */
import { el, clear, toast, confirmBox, promptBox, formBox } from '../ui/dom.js';
import { pickFile, readFileText, sanitizeName } from '../core/util.js';
import { OBJECT_TYPES } from '../world/objectTypes.js';
import { objectLabel } from '../world/level.js';
import { renderFolderGrid } from '../ui/folder-grid.js';
import { renderPrefabPreview } from './prefab-preview.js';
import { skeletonCards, statusLine } from '../ui/skeleton.js';
import { contextMenu } from './widgets.js';
import {
  PREFAB_EXT, EXTERNAL_GROUP, capturePrefab, listPrefabIndex, getPrefab,
  savePrefab, renamePrefab, deletePrefab, exportPrefabFile, importPrefabFile,
  applyPrefabToLevel,
} from '../core/prefab.js';

/** 排序键 → renderFolderGrid 的 sort 参数 */
const SORTS = [
  { k: 'name', l: 'A→Z' },
  { k: 'nameDesc', l: 'Z→A' },
  { k: 'created', l: '创建时间' },
];

function _sortOpt(key) {
  if (key === 'nameDesc') return { by: 'name', dir: 'desc' };
  if (key === 'created') return { by: 'created', dir: 'desc' };
  return { by: 'name', dir: 'asc' };
}

export class PrefabPanel {
  constructor(ed) {
    this.ed = ed;
    this.host = document.getElementById('prefab-list');
    this.barHost = document.getElementById('prefab-bar');
    this.index = [];
    this.groupMode = 'all';        // 'all' 全局 | 'level' 按关卡
    this.sort = 'name';
    this.query = '';
    this.drill = null;
    this.drillLabel = '';
    this._status = null;
    this._segs = [];
    this._buildBar();
    this._bindHead();
  }

  /* ============================================================
     工具条
     ============================================================ */
  _buildBar() {
    const host = this.barHost;
    if (!host) return;
    clear(host);

    const mkSeg = (label, key, field, title) => {
      const b = el('button', { class: 'pf-seg', type: 'button', text: label, title: title || label });
      b.addEventListener('click', () => {
        this[field] = key;
        if (field === 'groupMode') { this.drill = null; this.drillLabel = ''; }
        this._syncBar();
        this._draw();
      });
      this._segs.push({ node: b, key, field });
      return b;
    };

    const row1 = el('div', { class: 'pf-row' });
    row1.appendChild(el('span', { class: 'pf-lab', text: '分包' }));
    row1.appendChild(mkSeg('全局', 'all', 'groupMode', '显示工具箱里的全部预制件'));
    row1.appendChild(mkSeg('按关卡', 'level', 'groupMode', '按「创建自哪个关卡」分成文件夹卡片'));
    host.appendChild(row1);

    const row2 = el('div', { class: 'pf-row' });
    row2.appendChild(el('span', { class: 'pf-lab', text: '排序' }));
    for (const s of SORTS) row2.appendChild(mkSeg(s.l, s.k, 'sort'));
    host.appendChild(row2);

    const row3 = el('div', { class: 'pf-row' });
    this.searchInp = el('input', {
      class: 'inp sm pf-search', type: 'search', placeholder: '搜索预制件…',
      oninput: () => { this.query = this.searchInp.value; this._draw(); },
    });
    row3.appendChild(this.searchInp);
    host.appendChild(row3);

    host.appendChild(el('div', { class: 'pf-tip', text: '单击应用到关卡 · 右键更多操作' }));
    this._syncBar();
  }

  _syncBar() {
    for (const s of this._segs) s.node.classList.toggle('on', this[s.field] === s.key);
  }

  _bindHead() {
    const imp = document.querySelector('[data-act="prefab-import"]');
    if (imp) imp.addEventListener('click', () => this.importFile());
    const rf = document.querySelector('[data-act="prefab-refresh"]');
    if (rf) rf.addEventListener('click', () => this.refresh());
  }

  /* ============================================================
     读取（渐进：先骨架卡，再分片填充）
     ============================================================ */
  async refresh() {
    const host = this.host;
    if (!host) return;
    clear(host);
    host.appendChild(skeletonCards(6, 'fg-card skel'));
    this._status = statusLine(host, '正在读取预制件…');
    let idx = [];
    try { idx = await listPrefabIndex(); } catch (e) { idx = []; }
    if (this._status) { this._status.remove(); this._status = null; }
    this.index = idx;
    this._draw();
  }

  /* ============================================================
     渲染
     ============================================================ */
  _groupOf(it) {
    if (it.levelId) return { key: it.levelId, label: it.levelName || it.levelId };
    return { key: EXTERNAL_GROUP, label: '外部导入' };
  }

  /** 有 3D 预览图就贴预览图，否则用首个对象的类型图标（同一类稳定同色） */
  _iconOf(it) {
    if (it.preview) return { type: 'img', src: it.preview };
    const t = (it.types && it.types[0]) || '';
    const d = OBJECT_TYPES[t];
    return { sym: (d && d.icon) || '⬢' };
  }

  _draw() {
    const host = this.host;
    if (!host) return;
    const q = (this.query || '').trim().toLowerCase();
    const items = q
      ? this.index.filter((it) => (String(it.name || '') + ' ' + String(it.id || '') + ' ' + String(it.levelName || ''))
        .toLowerCase().includes(q))
      : this.index;
    const grouped = this.groupMode === 'level';
    const drill = grouped ? this.drill : null;
    let drillCount = 0;
    if (drill) for (const it of items) if (this._groupOf(it).key === drill) drillCount++;

    renderFolderGrid(host, {
      items,
      groupOf: grouped ? (it) => this._groupOf(it) : null,
      sort: _sortOpt(this.sort),
      drill,
      drillLabel: this.drillLabel,
      drillCount,
      rootLabel: '按关卡分包',
      emptyText: this.index.length
        ? '没有匹配的预制件'
        : '工具箱还是空的：在对象树里选中对象 → 右键「导出为预制件…」',
      iconOf: (it) => this._iconOf(it),
      labelOf: (it) => it.name || it.id,
      subOf: (it) => (it.objects || 0) + ' 对象' + (it.assets ? ' · ' + it.assets + ' 素材' : ''),
      onOpenGroup: (key, label) => { this.drill = key; this.drillLabel = label; this._draw(); },
      onBack: () => { this.drill = null; this.drillLabel = ''; this._draw(); },
      onPick: (it) => this.apply(it),
      onContext: (it, x, y) => this._menu(it, x, y),
    });
  }

  _menu(it, x, y) {
    contextMenu(x, y, [
      { label: it.name || '预制件' },
      { ico: '⊕', l: '应用到当前关卡', fn: () => this.apply(it) },
      { ico: '⇩', l: '导出为文件（' + PREFAB_EXT + '）', fn: () => this.toFile(it) },
      { sep: true },
      { ico: '✎', l: '重命名', fn: () => this.rename(it) },
      { ico: '🗑', l: '删除', danger: true, fn: () => this.remove(it) },
    ]);
  }

  /* ============================================================
     条目操作
     ============================================================ */
  async _full(it) {
    let rec = null;
    try { rec = await getPrefab(it.id); } catch (e) { rec = null; }
    if (!rec) toast('预制件数据缺失', 'err', 2600);
    return rec;
  }

  async apply(it) {
    const ed = this.ed;
    if (!ed || !ed.level) { toast('先打开一个关卡', 'err'); return; }
    const rec = await this._full(it);
    if (!rec) return;
    try {
      const r = await applyPrefabToLevel(ed, rec);
      if (ed.log) {
        ed.log('应用预制件「' + rec.name + '」：' + r.ids.length + ' 个对象'
          + (r.assets ? '，本地化 ' + r.assets + ' 个素材' : ''), 'ok');
      }
      toast('已应用预制件「' + rec.name + '」', 'ok');
    } catch (e) {
      console.error('[prefab] 应用失败', e);
      toast('应用失败：' + (e && e.message ? e.message : e), 'err', 3200);
    }
  }

  async toFile(it) {
    const rec = await this._full(it);
    if (!rec) return;
    const name = exportPrefabFile(rec);
    if (name) toast('已导出 ' + name, 'ok');
  }

  async rename(it) {
    const v = await promptBox('预制件名称', it.name || '', { title: '重命名预制件' });
    if (v === null) return;
    const name = String(v).trim();
    if (!name || name === it.name) return;
    await renamePrefab(it.id, name);
    await this.refresh();
  }

  async remove(it) {
    const ok = await confirmBox(
      '删除预制件「' + (it.name || '') + '」？只移除工具箱里的这份副本，关卡里的对象不受影响。',
      { title: '删除预制件', danger: true, ok: '删除' });
    if (!ok) return;
    await deletePrefab(it.id);
    await this.refresh();
    toast('已删除预制件', 'ok');
  }

  /* ============================================================
     从文件导入
     ============================================================ */
  async importFile() {
    const file = await pickFile(PREFAB_EXT + ',.json,application/json');
    if (!file) return;
    let text = '';
    try { text = await readFileText(file); }
    catch (e) { toast('读取文件失败', 'err'); return; }
    const base = String(file.name || '').replace(/\.fdprefab$/i, '');
    const r = await importPrefabFile(text, { name: sanitizeName(base, '') });
    if (r.error) { toast(r.error, 'err', 3400); return; }
    toast('已导入预制件「' + r.record.name + '」', 'ok');
    await this.refresh();
  }

  /* ============================================================
     从当前选择导出（对象树右键菜单调用）
     ============================================================ */
  async exportSelection(ids) {
    const ed = this.ed;
    if (!ed || !ed.level) { toast('先打开一个关卡', 'err'); return null; }
    const list = (Array.isArray(ids) && ids.length ? ids : [...(ed.selection || [])]).filter(Boolean);
    if (!list.length) { toast('先选中对象', 'err'); return null; }
    const first = ed.level.objects.find((o) => o.id === list[0]) || null;
    const def = (first ? objectLabel(first) : '预制件') + (list.length > 1 ? ' 等 ' + list.length + ' 件' : '');

    const v = await formBox('导出为预制件', [
      { k: 'name', l: '名称', t: 'text', d: def },
      {
        k: 'to', l: '导出到', t: 'select', d: 'toolbox',
        o: [{ v: 'toolbox', l: '预制件工具箱' }, { v: 'file', l: '文件（' + PREFAB_EXT + '）' }],
        h: '存进工具箱可随时复用；导出为文件便于分享给其他人（素材一并打包）',
      },
    ], { ok: '导出' });
    if (!v) return null;

    const name = String(v.name || '').trim() || def;
    // 导出时自动空拍一张 3D 预览图（纯平面内容不拍，退回类型图标）
    let preview = '';
    try { preview = renderPrefabPreview(ed, list) || ''; } catch (e) { preview = ''; }
    let rec = null;
    try { rec = await capturePrefab(ed, list, { name, preview }); }
    catch (e) { toast('导出失败：' + (e && e.message ? e.message : e), 'err', 3400); return null; }

    const detail = '（' + rec.objects.length + ' 对象 / ' + rec.assets.length + ' 素材）';
    if (v.to === 'file') {
      const fn = exportPrefabFile(rec);
      if (ed.log) ed.log('导出预制件文件 ' + fn + detail, 'ok');
      toast('已导出 ' + fn, 'ok');
      return rec;
    }
    await savePrefab(rec);
    if (ed.log) ed.log('存入预制件工具箱「' + rec.name + '」' + detail, 'ok');
    toast('已存入预制件工具箱「' + rec.name + '」', 'ok');
    if (ed.setLeftTab) ed.setLeftTab('prefab');
    await this.refresh();
    return rec;
  }
}