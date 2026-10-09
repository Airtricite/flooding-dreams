/* ============================================================
   存档列表面板（编辑器入口）
   ============================================================ */
import { $, el, clear, toast, formBox, confirmBox, diffTag } from './dom.js';
import { bindActs } from './menu.js';
import { store } from '../core/storage.js';
import { createEmptyLevel, levelFromJSON, levelToJSON, levelStats } from '../world/level.js';
import { packLevelAssets, unpackLevelAssets } from '../core/level-assets.js';
import { getBuiltinLevels, loadCustomLevels, cloneLevelToSaves } from '../levels/builtin.js';
import { createObject } from '../world/objectTypes.js';
import { createAnimation, createTrack } from '../world/events.js';
import { download, readFileText, sanitizeName, fmtBytes, uid } from '../core/util.js';
import { diffOf } from '../config.js';
import { BatchBar } from './batch.js';
import { runListTask } from '../core/list-tasks.js';
import { chunkedAppend, streamBatches, lowerBound } from './render-queue.js';
import { skeletonCards, statusLine } from './skeleton.js';
import { ensureEntryLevel } from './level-lazy.js';

const TEMPLATES = {
  empty: { l: '空白关卡', d: '一片虚无，从零开始。' },
  room: { l: '涨水房间', d: '一个会不断涨水的房间。' },
  parkour: { l: '跑酷长廊', d: '一连串的平台与跳跃。' },
};

export class SavesPanel {
  /** opts { onEdit(level), onClose() } */
  constructor(opts = {}) {
    this.opts = opts;
    this.root = $('#saves');
    this.grid = $('#sv-grid');
    this.entries = [];
    this.fileInput = $('#lv-import-file');
    this._rev = 0;            // refresh 代际令牌
    this._rc = null;          // 分片渲染句柄
    this._status = null;      // 加载状态行句柄
    this._ac = null;          // 流式加载中止控制器
    this._shown = [];         // 已上屏条目（供增量插入定位）
    this._loading = false;    // 是否正在流式加载
    bindActs(this.root, (act, ev, btn) => {
      if (act === 'close') return this.opts.onClose && this.opts.onClose();
      if (act === 'new') return this.create();
      if (act === 'copybuiltin') return this.copyBuiltin();
      if (act === 'import') return this.fileInput && this.fileInput.click();
      const e = this.entryOf(btn);
      if (!e) return;
      if (act === 'edit' || act === 'card') this.edit(e);
      else if (act === 'export') this.exportLevel(e);
      else if (act === 'clone') this.clone(e);
      else if (act === 'del') this.remove(e);
    });
    if (this.fileInput) {
      this.fileInput.addEventListener('change', async () => {
        const f = this.fileInput.files && this.fileInput.files[0];
        this.fileInput.value = '';
        if (f) await this.importFile(f);
      });
    }

    // 批量操作：多选存档后一次性导出 / 复制 / 删除
    this.batch = new BatchBar({
      host: this.grid,
      itemSelector: '.lv-card',
      idOf: (n) => n.dataset.id,
      actions: [
        { label: '⇩ 导出', title: '把所选存档逐个导出为 .fdlevel 文件', run: (ids) => this.batchExport(ids) },
        { label: '⧉ 复制', title: '把所选存档各复制一份', run: (ids) => this.batchClone(ids) },
        { label: '🗑 删除', cls: 'del', title: '删除所选存档，带二次确认', run: (ids) => this.batchRemove(ids) },
      ],
    });
  }

  entryOf(node) {
    const card = node.classList.contains('lv-card') ? node : node.closest('.lv-card');
    if (!card) return null;
    return this.entries.find((e) => e.id === card.dataset.id) || null;
  }

  async open() { await this.refresh(); }
  async refresh() {
    const rev = ++this._rev;
    if (this._ac) this._ac.abort();
    this._ac = new AbortController();
    const signal = this._ac.signal;
    const grid = this.grid;
    if (grid) { clear(grid); grid.appendChild(skeletonCards(8)); this._status = statusLine(grid, '正在加载存档…'); }
    this.entries = [];
    this._shown = [];
    this._loading = true;
    let recs = [];
    try { recs = (await store.listLevels()) || []; }
    catch (e) { console.warn('[saves] 读取存档失败', e); toast('读取存档失败', 'err'); }
    if (rev !== this._rev) return;
    if (grid) clear(grid);
    if (grid && this._status && this._status.node) grid.appendChild(this._status.node);
    const status = this._status;
    await streamBatches(recs, {
      batchSize: 20,
      signal,
      process: async (slice) => {
        const proj = await runListTask('levelList', { recs: slice, scope: 'saves' });
        return (proj && proj.items) || [];
      },
      onProgress: (i) => { if (status) status.set(`正在解析存档 ${i.done}/${i.total}…`); },
      onBatch: (items) => {
        if (rev !== this._rev) return;
        // 只保留元数据；完整 level 待真正打开时按需读盘规范化
        this._appendEntries(items.map((it) => ({ ...it, level: null, rec: it, stats: it.stats })));
        if (this.batch) this.batch.sync();
      },
    });
    if (rev !== this._rev) return;
    this._loading = false;
    if (this._status) { this._status.remove(); this._status = null; }
    if (this.batch) { this.batch.setAvailable(this.entries.length > 0); this.batch.sync(); }
  }

  /** 存档始终按最近更新倒序 */
  _cmp(a, b) { return (b.updated || 0) - (a.updated || 0); }

  /** 增量插入：把新条目按排序插进列表与 DOM */
  _appendEntries(list) {
    const grid = this.grid;
    if (!grid || !list.length) return;
    const cmp = (a, b) => this._cmp(a, b);
    for (const e of list) {
      const i = lowerBound(this.entries, e, cmp);
      this.entries.splice(i, 0, e);
      const j = lowerBound(this._shown, e, cmp);
      this._shown.splice(j, 0, e);
      const cards = grid.querySelectorAll('.lv-card');
      grid.insertBefore(this.card(e), cards[j] || null);
    }
  }

  render() {
    const grid = this.grid;
    if (!grid) return;
    if (this._rc) { this._rc.cancel(); this._rc = null; }
    clear(grid);
    if (this._status && this._status.node) grid.appendChild(this._status.node);
    const list = this.entries.slice().sort((a, b) => this._cmp(a, b));
    this._shown = list;
    if (!list.length) {
      grid.appendChild(el('div', {
        style: { color: 'var(--ink-faint)', padding: 'calc(30px * var(--ui-s)) calc(4px * var(--ui-s))', fontSize: 'calc(13px * var(--ui-s) * var(--ui-fs))', lineHeight: '1.8' },
        html: '还没有任何存档。<br>点右上角「＋ 新建存档」开始，或「导入文件」载入他人分享的 .fdlevel 关卡。',
      }));
      if (this.batch) { this.batch.setAvailable(false); this.batch.sync(); }
      return;
    }
    if (this._loading) {
      for (const e of list) grid.appendChild(this.card(e));
      if (this.batch) { this.batch.setAvailable(true); this.batch.sync(); }
      return;
    }
    this._rc = chunkedAppend(grid, list, (e) => this.card(e), {
      firstBatch: 24, perFrame: 12,
      onDone: () => { if (this.batch) { this.batch.setAvailable(true); this.batch.sync(); } },
    });
  }

  card(e) {
    const d = diffOf(e.difficulty);
    const st = e.stats || (e.level ? levelStats(e.level) : null);
    const card = el('div', { class: 'lv-card', dataset: { id: e.id } });
    const thumb = el('div', { class: 'thumb' });
    thumb.style.setProperty('--c1', d.color);
    thumb.style.setProperty('--c2', '#7fe3ff');
    card.appendChild(thumb);
    card.appendChild(el('div', { class: 'badge', text: fmtBytes(e.bytes || 0) }));
    card.appendChild(el('div', { class: 'c-top' },
      el('div', { style: { flex: '1', minWidth: '0' } },
        el('div', { class: 'c-name', text: e.name || '未命名' }),
        el('div', { class: 'c-author', text: 'by ' + (e.author || '玩家') + ' · ' + new Date(e.updated || Date.now()).toLocaleString() }),
      ),
      diffTag(e.difficulty || 1),
    ));
    card.appendChild(el('div', { class: 'c-desc', text: e.description || '（无描述）' }));
    card.appendChild(el('div', { class: 'c-meta' },
      st ? [`对象 ${st.objects}`, `液体 ${st.liquids}`, `事件 ${st.events}`, `动画 ${st.animations}`].map((t) => el('span', { text: t }))
        : [el('span', { text: '数据损坏' })]));
    card.appendChild(el('div', { class: 'c-btns' },
      el('button', { class: 'mini', dataset: { act: 'edit' }, text: '✎ 编辑' }),
      el('button', { class: 'mini', dataset: { act: 'clone' }, text: '⧉ 复制' }),
      el('button', { class: 'mini', dataset: { act: 'export' }, text: '⇩ 导出' }),
      el('button', { class: 'mini del', dataset: { act: 'del' }, text: '🗑 删除' }),
    ));
    return card;
  }

  /* ---------- 操作 ---------- */
  async create() {
    const f = await formBox('新建关卡', [
      { k: 'name', l: '关卡名称', t: 'text', d: '我的梦' },
      { k: 'difficulty', l: '难度(1~6+)', t: 'num', d: 1, st: 0.1, min: 1, max: 10, h: 'Lucid 1 / Misty 2 / Deep 3 / Drowning 4 / Suffocating 5 / Nightmare 6+' },
      { k: 'description', l: '描述', t: 'textarea', d: '' },
      { k: 'template', l: '模板', t: 'select', d: 'empty', o: Object.entries(TEMPLATES).map(([v, t]) => ({ v, l: t.l })) },
    ], { ok: '创建并编辑' });
    if (!f) return;
    const level = createEmptyLevel({
      id: uid('lv'),
      name: sanitizeName(f.name, '我的梦'),
      difficulty: Number(f.difficulty) || 1,
      description: f.description || '',
    });
    applyTemplate(level, f.template);
    await store.saveLevel({
      id: level.id, name: level.name, author: '玩家', description: level.description,
      difficulty: level.difficulty, data: level,
    });
    this.opts.onEdit && this.opts.onEdit(level, null);
  }

  async importFile(file) {
    try {
      const text = await readFileText(file);
      const res = levelFromJSON(text);
      if (res.error) { toast('导入失败：' + res.error, 'err', 3600); return; }
      const lv = res.level;
      lv.id = uid('lv');
      const prevScope = store.assetScope;
      store.setAssetScope(lv.id);
      try {
        // 文件里带的素材先落到新关卡文件夹，再改写引用，最后整体存盘
        if (res.assets && res.assets.length) await unpackLevelAssets(lv.id, res.assets, lv);
        await store.saveLevel({
          id: lv.id, name: lv.name, author: lv.author || '导入', description: lv.description,
          difficulty: lv.difficulty, data: lv,
        });
      } finally { store.setAssetScope(prevScope); }
      const n = (res.assets && res.assets.length) || 0;
      toast('已导入「' + lv.name + '」' + (n ? '，打包 ' + n + ' 个素材' : ''), 'ok');
      await this.refresh();
    } catch (e) {
      console.error(e);
      toast('导入失败：文件读取错误', 'err');
    }
  }

  /** 打开编辑器：按需读盘规范化该存档 */
  async edit(e) {
    if (!e) return;
    const lv = await ensureEntryLevel(e);
    if (!lv) { toast('关卡数据损坏', 'err'); return; }
    this.opts.onEdit && this.opts.onEdit(lv, e);
  }

  async clone(e) {
    const lv = await ensureEntryLevel(e);
    if (!lv) { toast('关卡数据损坏', 'err'); return; }
    const r = await cloneLevelToSaves(lv);
    if (!r) { toast('复制失败', 'err'); return; }
    toast(r.moved ? '已复制，打包 ' + r.moved + ' 个素材' : '已复制', 'ok');
    await this.refresh();
  }

  /** 把内置 / 自定义关卡复制成一份可编辑的「我的关卡」存档，并直接进编辑器 */
  async copyBuiltin() {
    try { await loadCustomLevels(); } catch (e) { /* ignore */ }
    const list = getBuiltinLevels();
    if (!list.length) { toast('没有可复制的内置关卡', 'err'); return; }
    const f = await formBox('复制内置关卡为可编辑副本', [
      {
        k: 'src', l: '源关卡', t: 'select', d: list[0].id,
        o: list.map((l) => ({ v: l.id, l: l.name + '（' + (l.custom ? '自定义' : '官方') + '）' })),
      },
      {
        k: 'name', l: '新关卡名称', t: 'text', d: '',
        h: '留空则用「原名 副本」。复制出来的是一份独立的「我的关卡」，随便改，不影响原关卡。',
      },
    ], { ok: '复制并编辑' });
    if (!f) return;
    const src = list.find((l) => l.id === f.src);
    if (!src) return;
    const r = await cloneLevelToSaves(src, String(f.name || '').trim() || (src.name + ' 副本'));
    if (!r) { toast('复制失败', 'err'); return; }
    toast('已复制为「' + r.level.name + '」，正在打开编辑器…', 'ok');
    await this.refresh();
    this.opts.onEdit && this.opts.onEdit(r.level, null);
  }

  async exportLevel(e, quiet) {
    const lv = await ensureEntryLevel(e);
    if (!lv) { if (!quiet) toast('关卡数据损坏', 'err'); return false; }
    let assets = [];
    try { assets = await packLevelAssets(lv); }
    catch (err) { console.warn('[saves] 打包素材失败', err); }
    download(sanitizeName(e.name || 'level') + '.fdlevel', levelToJSON(lv, assets));
    if (!quiet) toast('已导出' + (assets.length ? '，打包 ' + assets.length + ' 个素材' : ''), 'ok');
    return true;
  }

  async remove(e) {
    const ok = await confirmBox(`确定删除「${e.name}」吗？`, { title: '删除存档', ok: '删除', danger: true });
    if (!ok) return;
    await store.deleteLevel(e.id);
    toast('已删除', 'ok');
    await this.refresh();
  }

  /* ---------- 批量操作 ---------- */
  _pick(ids) { return ids.map((id) => this.entries.find((e) => e.id === id)).filter(Boolean); }

  async batchExport(ids) {
    const list = this._pick(ids);
    let n = 0;
    for (const e of list) if (await this.exportLevel(e, true)) n++;
    toast(n ? `已导出 ${n} 个存档文件` : '没有可导出的存档', n ? 'ok' : 'err');
  }

  async batchClone(ids) {
    const list = this._pick(ids);
    if (!list.length) { toast('没有可复制的存档', 'err'); return; }
    let n = 0;
    for (const e of list) {
      try {
        const lv = await ensureEntryLevel(e);
        if (lv && await cloneLevelToSaves(lv)) n++;
      }
      catch (err) { console.warn('[saves] 批量复制失败', e.name, err); }
    }
    toast(n ? `已复制 ${n} 个存档` : '复制失败', n ? 'ok' : 'err');
    await this.refresh();
  }

  async batchRemove(ids) {
    const list = this._pick(ids);
    if (!list.length) return;
    const ok = await confirmBox(`确定删除所选的 ${list.length} 个存档吗？此操作不可撤销。`, { title: '批量删除存档', ok: '删除', danger: true });
    if (!ok) return;
    for (const e of list) {
      try { await store.deleteLevel(e.id); }
      catch (err) { console.warn('[saves] 批量删除失败', e.name, err); }
    }
    toast(`已删除 ${list.length} 个存档`, 'ok');
    await this.refresh();
  }
}

/* ---------- 模板 ---------- */
function applyTemplate(L, key) {
  if (key === 'room') {
    L.settings.objective = '跑到出口，别被水淹死。';
    addMesh(L, [0, -1, 0], [60, 2, 60], '#cfc6ea', '地板', 'carpet');
    addMesh(L, [0, 14, -30], [60, 30, 2], '#b3a8d8', '墙', 'bricks');
    addMesh(L, [-30, 14, 0], [2, 30, 60], '#b3a8d8', '墙', 'bricks');
    addMesh(L, [30, 14, 0], [2, 30, 60], '#b3a8d8', '墙', 'bricks');
    // 会缓慢上涨的水
    const liq = add(L, 'liquid', { position: [0, 2, 0], scale: [60, 24, 60], kind: 'water', fillLevel: 0.1, name: '洪水' });
    const goal = add(L, 'goal', { position: [0, 6, 26], scale: [8, 12, 8], name: '出口' });
    void goal; void liq;
    add(L, 'spawn', { position: [0, 1, -22], name: '起点' });
    L.animations.push(makeRiseAnim(L, liq, '水位上涨', 90));
  } else if (key === 'parkour') {
    L.settings.objective = '一路跳到终点。';
    addMesh(L, [0, -1, 0], [16, 2, 16], '#cfc6ea', '起点', 'tiles');
    for (let i = 0; i < 6; i++) {
      addMesh(L, [Math.sin(i * 1.1) * 12, 3 + i * 4, -16 - i * 14], [12, 2, 12], ['#ff7fd0', '#7fe3ff', '#8ef5c8'][i % 3], '平台 ' + (i + 1), 'grid');
    }
    add(L, 'goal', { position: [Math.sin(5.5) * 12, 26, -16 - 5 * 14], scale: [8, 12, 8], name: '终点' });
    add(L, 'spawn', { position: [0, 1, 0], name: '起点' });
  } else {
    // 空白关卡：中灰大平台 + 起点 + 终点 + 画面处理对象
    addMesh(L, [0, -1, 0], [40, 2, 40], '#8a8a8a', '平台', 'none');
    add(L, 'spawn', { position: [0, 1, 0], name: '起点' });
    add(L, 'goal', { position: [0, 6, 16], scale: [8, 12, 8], name: '终点' });
    add(L, 'exposure', { position: [0, 20, 0], name: '画面处理' });
  }
}

function add(L, type, over) { const o = createObject(type, over); L.objects.push(o); return o; }
function addMesh(L, pos, scale, color, name, texture) {
  return add(L, 'mesh', { shape: 'block', position: pos, scale, color, name, texture: texture || 'none' });
}
function makeRiseAnim(L, liq, name, dur) {
  const a = createAnimation(name);
  a.duration = dur;
  a.loop = false;
  a.autoplay = true;
  const tr = createTrack(liq.id);
  tr.property = 'fillLevel';
  tr.type = 'number';
  tr.keys = [{ t: 0, v: 0.1, easing: 'easeInOut' }, { t: dur, v: 1, easing: 'linear' }];
  a.tracks = [tr];
  return a;
}