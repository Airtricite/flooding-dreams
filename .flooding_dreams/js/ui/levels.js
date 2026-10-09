/* ============================================================
   关卡选择面板（内置关卡 + 我的关卡）
   ============================================================ */
import { $, el, clear, diffTag, diffLegend, toast, promptBox, confirmBox } from './dom.js';
import { bindActs } from './menu.js';
import { LevelMap } from './levelmap.js';
import { store } from '../core/storage.js';
import { getBuiltinLevels, loadCustomLevels, cloneLevelToSaves } from '../levels/builtin.js';
import { loadPacks, loadPacksRaw, packProgressInfo, packTiers, resolveTier, tierDef, loadPackTiers, savePackTier, upsertPack, deletePack, progressMaps, clearedSetOf } from '../levels/packs.js';
import { mountStar } from './star.js';
import { t } from '../core/i18n.js';
import { levelToJSON, levelStats } from '../world/level.js';
import { runListTask } from '../core/list-tasks.js';
import { chunkedAppend, streamBatches, lowerBound } from './render-queue.js';
import { skeletonCards, statusLine } from './skeleton.js';
import { GridSelect } from './grid-picker.js';
import { ensureEntryLevel } from './level-lazy.js';
import { packLevelAssets } from '../core/level-assets.js';
import { exportPackBundle, readPackBundle, importPackBundle, PACK_EXT } from '../core/pack-file.js';
import { download, fmtTime, sanitizeName, fmtBytes, pickFile, readFileText, uid } from '../core/util.js';
import { diffOf, DIFFICULTY } from '../config.js';
import { audio } from '../core/audio.js';
import { mountModifierBar } from './modifier-bar.js';
import { BatchBar } from './batch.js';

export class LevelPanel {
  /**
   * @param opts { onPlay(entry), onEdit(entry), onClose(), onOpenSaves(), onOpenPack(pack) }
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.root = $('#levels');
    this.grid = $('#lv-grid');
    this.search = $('#lv-search');
    this.sort = null;
    const sortHost = $('#lv-sort');
    if (sortHost) {
      this.sort = new GridSelect({
        value: 'difficulty', cls: 'inp', placeholder: '按难度',
        options: [
          { v: 'difficulty', l: '按难度' },
          { v: 'name', l: '按名称' },
          { v: 'recent', l: '按最近' },
        ],
        onChange: (v) => { this.sortMode = v; this.render(); },
      });
      sortHost.replaceWith(this.sort.el);
    }
    this.legend = $('#lv-diff-legend');
    this.tabs = $('#lv-tabs');
    this.packs = $('#lv-packs');
    this.hallBtn = this.root ? this.root.querySelector('[data-act="hall"]') : null;
    this.entries = [];
    this.filter = '';
    this.sortMode = 'difficulty';
    this.progress = new Map();
    this.packProgress = new Map();   // packId → Map<levelId, rec>（包内成绩，各自独立）
    this.tab = 'levels';
    this._maps = [];          // 关卡包卡片里的节点地图预览（重建前需 dispose）
    this._stars = [];         // 100% 关卡包卡片上的 shader 星星（重建前需 dispose）
    this.packTierStore = {};  // packId → 玩家所选档位
    this.levelUpdated = new Map();   // levelId → updated 时间戳（用于判定 PB 是否失效）
    this._rev = 0;            // refresh 代际令牌（并发刷新只认最后一次）
    this._packsRev = 0;       // refreshPacks 代际令牌
    this._rc = null;          // 关卡卡片分片渲染句柄（仅过滤 / 排序后的整体重绘用）
    this._rcPacks = null;     // 关卡包卡片分片渲染句柄
    this._packTiers = {};     // packId → 档位列表（Worker 归一化时一并算出）
    this._status = null;      // 加载状态行句柄
    this._ac = null;          // 流式加载的中止控制器（重新刷新时中止上一轮）
    this._shown = [];         // 当前已上屏（排序 + 过滤后）的条目，供增量插入定位
    this._loading = false;    // 是否正在流式加载（加载中重绘走同步追加，保证 DOM 与 _shown 对齐）

    bindActs(this.root, (act, ev, btn) => {
      if (act === 'close') return this.close();
      if (act === 'hall') return this.opts.onHall && this.opts.onHall();
      if (act === 'card') { const e = this.entryOf(btn); if (e) this.play(e); return; }
      if (act === 'saves') return this.opts.onOpenSaves && this.opts.onOpenSaves();
      if (act === 'openpack') {
        const p = (this.packList || []).find((x) => x.id === btn.dataset.pack);
        if (p) this.opts.onOpenPack && this.opts.onOpenPack(p);
        return;
      }
      if (act === 'exportpack') {
        const p = (this.packList || []).find((x) => x.id === btn.dataset.pack);
        if (p) this.exportPack(p);
        return;
      }
      if (act === 'importpack') { this.importPack(); return; }
      const e = this.entryOf(btn);
      if (!e) return;
      if (act === 'play') this.play(e);
      else if (act === 'edit') this.edit(e);
      else if (act === 'editcopy') this.editCopy(e);
      else if (act === 'clone') this.clone(e);
      else if (act === 'export') this.exportLevel(e);
      else if (act === 'del') this.remove(e);
    });

    if (this.legend) { clear(this.legend); this.legend.appendChild(diffLegend()); }

    // 地图变体（镜像 / 时间流速）：选关时就能定，默认交给「意外惊喜」
    this.variantBar = mountModifierBar($('#lv-variant'));

    if (this.search) this.search.addEventListener('input', () => { this.filter = this.search.value.trim().toLowerCase(); this.render(); });
    if (this.tabs) {
      this.tabs.addEventListener('click', (ev) => {
        const b = ev.target.closest('.tab');
        if (b) this.setTab(b.dataset.tab);
      });
    }

    // 批量操作：关卡列表与关卡包列表各一套（卡片多选后一次性导出 / 复制 / 删除）
    this.gridBatch = new BatchBar({
      host: this.grid,
      itemSelector: '.lv-card',
      idOf: (n) => n.dataset.uid,
      actions: [
        { label: '⇩ 导出', title: '把所选关卡逐个导出为 .fdlevel 文件', run: (ids) => this.batchExportLevels(ids) },
        { label: '⧉ 复制', title: '把所选关卡复制到「我的关卡」', run: (ids) => this.batchCloneLevels(ids) },
        { label: '🗑 删除', cls: 'del', title: '删除所选的「我的关卡」（官方 / 自定义关卡不可删）', run: (ids) => this.batchRemoveLevels(ids) },
      ],
    });
    this.packsBatch = new BatchBar({
      host: this.packs,
      itemSelector: '.pk-card',
      idOf: (n) => n.dataset.pack,
      actions: [
        { label: '⬆ 导出', title: '把所选关卡包逐个导出为 .fdpack 文件', run: (ids) => this.batchExportPacks(ids) },
        { label: '⧉ 复制', title: '复制所选关卡包（连同节点地图，不影响原包）', run: (ids) => this.batchClonePacks(ids) },
        { label: '🗑 删除', cls: 'del', title: '删除所选关卡包（包里的关卡不会被删掉）', run: (ids) => this.batchRemovePacks(ids) },
      ],
    });
  }

  /** 顶部页签：关卡 / 关卡包 */
  setTab(t) {
    this.tab = t === 'packs' ? 'packs' : 'levels';
    if (this.tabs) {
      for (const b of this.tabs.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === this.tab);
    }
    const isP = this.tab === 'packs';
    if (this.legend) this.legend.classList.toggle('hidden', isP);
    if (this.grid) this.grid.classList.toggle('hidden', isP);
    if (this.packs) this.packs.classList.toggle('hidden', !isP);
    if (this.gridBatch) this.gridBatch.setVisible(!isP);
    if (this.packsBatch) this.packsBatch.setVisible(isP);
    if (isP) this.refreshPacks();
  }


  entryOf(node) {
    const card = node.classList.contains('lv-card') ? node : node.closest('.lv-card');
    if (!card) return null;
    return this.entries.find((e) => e.uid === card.dataset.uid) || null;
  }

  async open() {
    await this.refresh();
    this.setTab(this.tab);      // 恢复上次的页签（关卡包页会顺带刷新）
    if (this.variantBar) this.variantBar.refresh();   // 冷却局数每局都在变，打开时重算一次
  }
  close() { this.opts.onClose && this.opts.onClose(); }

  /** 打开来源：win / pause 时显示「返回大厅」按钮 */
  setMode(from) {
    this._from = from || 'hall';
    const show = this._from === 'win' || this._from === 'pause';
    if (this.hallBtn) this.hallBtn.classList.toggle('hidden', !show);
  }

  async refresh() {
    const rev = ++this._rev;
    if (this._ac) this._ac.abort();
    this._ac = new AbortController();
    const signal = this._ac.signal;
    const grid = this.grid;
    // 首帧立刻显示骨架屏 + 状态行（列表边加载边显示，主线程不卡）
    if (grid) { clear(grid); grid.appendChild(skeletonCards(8)); this._status = statusLine(grid, '正在加载关卡…'); }
    this.entries = [];
    this._shown = [];
    this._loading = true;
    this.levelRecs = [];
    this.levelNames = new Map();
    this.levelUpdated = new Map();
    // 自定义关卡（js/levels/custom/ 里放文件即生效）
    try { await loadCustomLevels(); } catch (e) { console.warn('[levels] 自定义关卡载入失败', e); }
    if (rev !== this._rev) return;
    // 进度表（含各包成绩）：先拿到，内建 / 用户条目都能带上进度
    let maps = { global: new Map(), byPack: new Map() };
    try { maps = await progressMaps(); } catch (e) { /* ignore */ }
    if (rev !== this._rev) return;
    this.progress = maps.global;          // 单关卡界面只看全局成绩
    this.packProgress = maps.byPack;      // 各关卡包各自的成绩
    // 内置关卡 + 自定义关卡（工厂缓存的单例，自带完整 level）——立即可用，先上屏
    const builtins = [];
    for (const lv of getBuiltinLevels()) {
      const custom = !!lv.custom;
      const id = lv.id;
      this.levelUpdated.set(id, 0);
      builtins.push({
        uid: (custom ? 'c:' : 'b:') + id, id, kind: custom ? 'custom' : 'builtin', level: lv,
        name: lv.name, author: lv.author || (custom ? '自定义' : '洪梦'), description: lv.description || '',
        difficulty: lv.difficulty, updated: 0,
        progress: this.progress.get(id) || null,
      });
    }
    if (grid) clear(grid);            // 去掉骨架，换成真实卡片（状态行仍留在顶部）
    if (grid && this._status && this._status.node) grid.appendChild(this._status.node);
    this._appendEntries(builtins);
    // 我的关卡：每约 20 关一批，投影一批就上屏一批（先加载完的先显示）
    let recs = [];
    try { recs = (await store.listLevels()) || []; }
    catch (e) { console.warn('[levels] 读取存档失败', e); }
    if (rev !== this._rev) return;
    const status = this._status;
    let bgmLeft = 12;
    await streamBatches(recs, {
      batchSize: 20,
      signal,
      process: async (slice) => {
        const proj = await runListTask('levelList', { recs: slice, scope: 'all' });
        return (proj && proj.items) || [];
      },
      onProgress: (i) => { if (status) status.set(`正在解析关卡 ${i.done}/${i.total}…`); },
      onBatch: (items) => {
        if (rev !== this._rev) return;
        const add = [];
        for (const it of items) {
          // 关卡名 / 版本号表：含包内关卡（供关卡包卡片与 PB 失效判定用）
          this.levelRecs.push({ id: it.id, name: it.name, updated: it.updated, builtin: it.builtin, packId: it.packId });
          this.levelNames.set(it.id, it.name || '');
          this.levelUpdated.set(it.id, it.updated || 0);
          // 预解码 BGM：从列表点「开始」时立刻有音乐（只做前 12 条）
          if (it.bgm && bgmLeft > 0) { bgmLeft--; void audio.load(it.bgm); }
          if (it.builtin || it.packId) continue;   // 包内关卡独立隔离：不出现在单关卡选关界面
          add.push({
            uid: 'u:' + it.id, id: it.id, kind: 'user', level: null, rec: it,
            name: it.name, author: it.author, description: it.description,
            difficulty: it.difficulty, updated: it.updated, stats: it.stats, bgm: it.bgm,
            progress: this.progress.get(it.id) || null,
          });
        }
        this._appendEntries(add);
        if (this.gridBatch) this.gridBatch.sync();
      },
    });
    if (rev !== this._rev) return;
    this._loading = false;
    if (this._status) { this._status.remove(); this._status = null; }
    if (this.gridBatch) { this.gridBatch.setAvailable(this.entries.length > 0); this.gridBatch.sync(); }
  }

  /** 当前排序比较器（与 render 保持一致） */
  _cmp(a, b) {
    const s = this.sortMode;
    if (s === 'name') return a.name.localeCompare(b.name, 'zh');
    if (s === 'recent') return (b.updated || 0) - (a.updated || 0);
    if (a.kind !== b.kind) return a.kind === 'user' ? -1 : 1;
    return lab(a.difficulty) - lab(b.difficulty) || a.name.localeCompare(b.name, 'zh');
  }

  _pass(e) {
    if (!this.filter) return true;
    return (e.name + ' ' + e.author + ' ' + e.description).toLowerCase().includes(this.filter);
  }

  /** 增量插入：把新条目按当前排序插进列表与 DOM，不重建已有卡片 */
  _appendEntries(list) {
    const grid = this.grid;
    if (!grid || !list.length) return;
    const cmp = (a, b) => this._cmp(a, b);
    for (const e of list) {
      const i = lowerBound(this.entries, e, cmp);
      this.entries.splice(i, 0, e);
      if (!this._pass(e)) continue;
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
    const list = this.entries.filter((e) => this._pass(e));
    list.sort((a, b) => this._cmp(a, b));
    this._shown = list;
    if (!list.length) {
      grid.appendChild(el('div', { style: { color: 'var(--ink-faint)', padding: 'calc(30px * var(--ui-s)) calc(4px * var(--ui-s))', fontSize: 'calc(13px * var(--ui-s) * var(--ui-fs))' }, text: '没有符合条件的关卡。' }));
      if (this.gridBatch) { this.gridBatch.setAvailable(false); this.gridBatch.sync(); }
      return;
    }
    // 加载中整体重绘：同步追加，保证 DOM 顺序与 _shown 严格对齐（此时列表通常还小）
    if (this._loading) {
      for (const e of list) grid.appendChild(this.card(e));
      if (this.gridBatch) { this.gridBatch.setAvailable(true); this.gridBatch.sync(); }
      return;
    }
    // 分片建卡：首帧先画一批，其余每帧几张
    this._rc = chunkedAppend(grid, list, (e) => this.card(e), {
      firstBatch: 24, perFrame: 12,
      onDone: () => { if (this.gridBatch) { this.gridBatch.setAvailable(true); this.gridBatch.sync(); } },
    });
  }

  card(e) {
    const d = diffOf(e.difficulty);
    const st = e.stats || (e.level ? levelStats(e.level) : null);
    const prev = DIFFICULTY[Math.max(0, DIFFICULTY.indexOf(d) - 1)];
    const card = el('div', { class: 'lv-card' + (e.kind === 'user' ? '' : ' builtin'), dataset: { uid: e.uid } });
    const thumb = el('div', { class: 'thumb' });
    thumb.style.setProperty('--c1', d.color);
    thumb.style.setProperty('--c2', prev.color);
    card.appendChild(thumb);
    if (e.progress && e.progress.cleared) {
      card.appendChild(el('div', { class: 'badge cleared', text: '✓ 已通关' }));
    } else if (e.progress && e.progress.bestTime) {
      card.appendChild(el('div', { class: 'badge', text: '最佳 ' + fmtTime(e.progress.bestTime) }));
    } else if (e.kind === 'builtin') {
      card.appendChild(el('div', { class: 'badge', text: '官方' }));
    } else if (e.kind === 'custom') {
      card.appendChild(el('div', { class: 'badge', text: '自定义' }));
    } else {
      card.appendChild(el('div', { class: 'badge', text: '我的' }));
    }
    card.appendChild(el('div', { class: 'c-top' },
      el('div', { style: { flex: '1', minWidth: '0' } },
        el('div', { class: 'c-name', text: e.name }),
        el('div', { class: 'c-author', text: 'by ' + e.author }),
      ),
      diffTag(e.difficulty),
    ));
    card.appendChild(el('div', { class: 'c-desc', text: e.description || '（无描述）' }));
    const meta = [];
    if (st) meta.push(`对象 ${st.objects}`, `液体 ${st.liquids}`, `事件 ${st.events}`);
    if (e.rec) meta.push(fmtBytes(e.rec.bytes));
    if (e.updated) meta.push(new Date(e.updated).toLocaleDateString());
    card.appendChild(el('div', { class: 'c-meta' }, meta.map((m) => el('span', { text: m }))));
    card.appendChild(el('div', { class: 'c-btns' },
      el('button', { class: 'mini', dataset: { act: 'play' }, text: '▶ 开始' }),
      e.kind === 'user'
        ? el('button', { class: 'mini', dataset: { act: 'edit' }, text: '✎ 编辑' })
        : el('button', {
          class: 'mini', dataset: { act: 'editcopy' }, text: '✎ 复制并编辑',
          title: '官方 / 自定义关卡不可直接修改：先复制一份到「我的关卡」，再打开编辑器',
        }),
      el('button', { class: 'mini', dataset: { act: 'clone' }, text: '⧉ 复制' }),
      el('button', { class: 'mini', dataset: { act: 'export' }, text: '⇩ 导出' }),
      e.kind === 'user' ? el('button', { class: 'mini del', dataset: { act: 'del' }, text: '🗑 删除' }) : null,
    ));
    return card;
  }

  /* ============================================================
     关卡包页签：把若干关卡按剧情串起来的节点地图
     ============================================================ */
  async refreshPacks() {
    const box = this.packs;
    if (!box) return;
    const rev = ++this._packsRev;
    if (this._rcPacks) { this._rcPacks.cancel(); this._rcPacks = null; }
    for (const m of this._maps) m.dispose();
    for (const s of this._stars) s.dispose();
    this._maps = [];
    this._stars = [];
    const head = () => el('div', { class: 'pk-head' },
      el('button', { class: 'mini', dataset: { act: 'importpack' }, text: '⬇ 导入关卡包', title: '导入关卡包文件（.fdpack）' }),
      el('span', { class: 'pk-head-hint', text: '关卡包文件自带节点地图、全部关卡与素材，导入后即开即用' }),
    );
    clear(box);
    box.appendChild(head());
    box.appendChild(skeletonCards(3, 'pk-card skel'));
    // 原始包数据交给 Worker 归一化（normalizePack + 档位），主线程只渲染
    let raw = [];
    try { raw = await loadPacksRaw(); } catch (e) { console.warn('[levels] 关卡包读取失败', e); }
    if (rev !== this._packsRev) return;
    try { this.packTierStore = await loadPackTiers(); } catch (e) { this.packTierStore = {}; }
    if (rev !== this._packsRev) return;
    const proj = await runListTask('packList', { raw, defaultName: t('新关卡包') }, {
      onProgress: (i) => { if (this._status) this._status.set(`正在解析关卡包 ${i.done}/${i.total}…`); },
    });
    if (rev !== this._packsRev) return;
    const list = (proj && proj.packs) || [];
    this._packTiers = (proj && proj.tiers) || {};
    this.packList = list;
    clear(box);
    box.appendChild(head());
    if (!list.length) {
      box.appendChild(el('div', {
        class: 'lv-empty',
        text: '还没有关卡包。到 编辑器 →「关卡包」面板里新建，把若干关卡按剧情串成一张地图；也可以导入一个 .fdpack 关卡包文件。',
      }));
      if (this.packsBatch) { this.packsBatch.setAvailable(false); this.packsBatch.sync(); }
      return;
    }
    // 分片建卡：地图渲染较重，首帧 3 张、其余每帧 2 张
    this._rcPacks = chunkedAppend(box, list, (p) => this.packCard(p), {
      firstBatch: 3, perFrame: 2,
      onDone: () => { if (this.packsBatch) { this.packsBatch.setAvailable(true); this.packsBatch.sync(); } },
    });
  }

  packCard(p) {
    const info = new Map(this.entries.map((e) => [e.id, e.level ? e.level.name : e.name]));
    for (const [id, name] of (this.levelNames || new Map())) if (!info.has(id)) info.set(id, name);
    // 关卡包成绩独立隔离：只用本包自己的进度记录，与单关卡成绩互不影响
    const prog = (this.packProgress && this.packProgress.get(p.id)) || new Map();
    const cleared = clearedSetOf(prog);
    // 档位：跟随玩家上次所选（没记录则取包内最低存在档位）
    const tiers = (this._packTiers && this._packTiers[p.id]) || packTiers(p);
    const tier = resolveTier(p, (this.packTierStore || {})[p.id]);
    const pg = packProgressInfo(p, prog, this.levelUpdated, tier);
    const total = pg.total;
    const done = pg.done;
    const card = el('div', { class: 'pk-card' + (pg.complete ? ' done' : ''), dataset: { pack: p.id } });
    card.appendChild(el('div', { class: 'pk-top' },
      el('div', { style: { flex: '1', minWidth: '0' } },
        el('div', { class: 'pk-name', text: p.name || '未命名关卡包' }),
        el('div', { class: 'pk-author', text: 'by ' + (p.author || '洪梦') }),
      ),
      el('div', { class: 'pk-count', text: `已通关 ${done}/${total}` }),
    ));
    card.appendChild(el('div', { class: 'pk-desc', text: p.description || '（无描述）' }));
    // 难度档位：只列出包内真正存在的档位（存在某档的节点才会出现该档）
    if (tiers.length) {
      const row = el('div', { class: 'pk-tiers' },
        el('span', { class: 'pk-tiers-l', text: t('难度档位') }));
      for (const v of tiers) {
        const td = tierDef(v);
        if (!td) continue;
        const btn = el('button', {
          class: 'pk-tier' + (v === tier ? ' on' : ''),
          type: 'button',
          text: t(td.zh),
          title: t(td.zh) + ' · ' + t('对应关卡难度 ') + td.range,
          onclick: () => this.setPackTier(p.id, v),
        });
        btn.style.setProperty('--tier-color', td.color);
        row.appendChild(btn);
      }
      card.appendChild(row);
    }
    const stage = el('div', { class: 'pk-map' });
    card.appendChild(stage);
    if (total) {
      const map = new LevelMap(stage, {
        interactive: false,
        cleared,
        levelInfo: (id) => ({ name: info.get(id) || '', exists: info.has(id) }),
      });
      map.setPack(p, cleared, tier);
      this._maps.push(map);
    } else {
      stage.appendChild(el('div', { class: 'pk-map-empty', text: '（这个关卡包还没有节点）' }));
    }
    // 全部通关：卡片上盖一颗 shader 星星
    if (pg.complete) {
      const wrap = el('div', { class: 'pk-star-wrap' });
      stage.appendChild(wrap);
      this._stars.push(mountStar(wrap, { size: 58 }));
    }
    // 只有全部通关才显示关卡包总用时（各关 PB 求和）
    if (pg.complete && pg.totalTime != null) {
      card.appendChild(el('div', { class: 'pk-total', text: t('全部通关 · 总用时 ') + fmtTime(pg.totalTime) }));
    }
    card.appendChild(el('div', { class: 'pk-btns' },
      el('button', { class: 'mini', dataset: { act: 'openpack', pack: p.id }, text: '▶ 开始剧情' }),
      el('button', { class: 'mini', dataset: { act: 'exportpack', pack: p.id }, text: '⬆ 导出', title: '导出关卡包文件（含节点地图与全部关卡副本、素材）' }),
    ));
    return card;
  }

  /** 切换某个关卡包的难度档位（列表卡片 / 地图详情共用同一份记录） */
  async setPackTier(packId, tier) {
    if (!packId) return;
    this.packTierStore[packId] = Number(tier) || 0;
    await savePackTier(packId, tier);
    await this.refreshPacks();
  }

  /* ---------- 关卡包文件：导出 / 导入 ---------- */
  async exportPack(p, quiet) {
    if (!p) return false;
    try {
      const bundle = await exportPackBundle(p);
      download(sanitizeName(p.name || '关卡包', '关卡包') + PACK_EXT, JSON.stringify(bundle));
      const miss = bundle.missing.length ? '，' + bundle.missing.length + ' 个节点未绑定到关卡' : '';
      if (!quiet) toast('已导出关卡包（' + bundle.levels.length + ' 个关卡副本' + miss + '）', bundle.missing.length ? 'err' : 'ok');
      return true;
    } catch (e) {
      console.warn('[levels] 导出关卡包失败', e);
      if (!quiet) toast('导出失败：' + (e && e.message ? e.message : e), 'err');
      return false;
    }
  }

  async importPack() {
    const file = await pickFile(PACK_EXT + ',.json');
    if (!file) return;
    let text;
    try { text = await readFileText(file); }
    catch (e) { toast('读取文件失败', 'err'); return; }
    const { bundle, error } = readPackBundle(text);
    if (error) { toast(error, 'err'); return; }
    try {
      const r = await importPackBundle(bundle);
      toast('已导入关卡包「' + r.pack.name + '」：' + r.levels + ' 个关卡、' + r.assets + ' 个素材', 'ok');
      if (r.missing.length) toast('部分节点未绑定到关卡（对方缺关卡）', 'err');
      await this.refresh();
      this.setTab('packs');
    } catch (e) {
      console.warn('[levels] 导入关卡包失败', e);
      toast('导入失败：' + (e && e.message ? e.message : e), 'err');
    }
  }

  /** 已通关关卡 id 集合（进度记录里 cleared 为真） */
  clearedSet() {
    const set = new Set();
    for (const [id, r] of this.progress) if (r && r.cleared) set.add(id);
    return set;
  }

  async play(e) {
    if (!e) return;
    const lv = await ensureEntryLevel(e);
    if (!lv) { toast('关卡数据损坏，无法开始', 'err'); return; }
    this.opts.onPlay && this.opts.onPlay(e);
  }

  /** 打开编辑器：用户关卡按需读盘规范化后再交给编辑器 */
  async edit(e) {
    if (!e) return;
    if (e.kind === 'user') {
      const lv = await ensureEntryLevel(e);
      if (!lv) { toast('关卡数据损坏', 'err'); return; }
    }
    this.opts.onEdit && this.opts.onEdit(e);
  }

  async clone(e) {
    const lv = await ensureEntryLevel(e);
    if (!lv) { toast('关卡数据损坏', 'err'); return; }
    const name = await promptBox('新关卡名称', e.name + ' 副本', { title: '复制关卡' });
    if (name === null) return;
    const r = await cloneLevelToSaves(lv, name);
    if (!r) { toast('复制失败', 'err'); return; }
    toast(r.moved ? `已复制到“我的关卡”，打包 ${r.moved} 个素材` : '已复制到“我的关卡”', 'ok');
    await this.refresh();
  }

  /** 内置 / 自定义关卡：复制一份可编辑副本，并直接打开编辑器继续改 */
  async editCopy(e) {
    const lv = await ensureEntryLevel(e);
    if (!lv) { toast('关卡数据损坏', 'err'); return; }
    const name = await promptBox(
      '复制为可编辑副本',
      e.name + ' 副本',
      { title: '复制并编辑', ok: '复制并编辑' },
    );
    if (name === null) return;
    const r = await cloneLevelToSaves(lv, name);
    if (!r) { toast('复制失败', 'err'); return; }
    toast(`已复制为「${r.level.name}」，正在打开编辑器…`, 'ok');
    await this.refresh();
    this.opts.onEdit && this.opts.onEdit({ level: r.level, rec: null });
  }

  async exportLevel(e, quiet) {
    const lv = await ensureEntryLevel(e);
    if (!lv) { if (!quiet) toast('关卡数据损坏', 'err'); return false; }
    let assets = [];
    try { assets = await packLevelAssets(lv); }
    catch (err) { console.warn('[levels] 打包素材失败', err); }
    download(sanitizeName(e.name) + '.fdlevel', levelToJSON(lv, assets));
    if (!quiet) toast('已导出关卡文件' + (assets.length ? '，打包 ' + assets.length + ' 个素材' : ''), 'ok');
    return true;
  }

  async remove(e) {
    if (e.kind !== 'user') return;
    const ok = await confirmBox(`确定删除「${e.name}」吗？此操作不可撤销。`, { title: '删除关卡', ok: '删除', danger: true });
    if (!ok) return;
    await store.deleteLevel(e.id);
    toast('已删除「' + e.name + '」', 'ok');
    await this.refresh();
  }

  /* ============================================================
     批量操作：关卡列表
     ============================================================ */
  _pickLevels(ids) { return ids.map((id) => this.entries.find((e) => e.uid === id)).filter(Boolean); }

  async batchExportLevels(ids) {
    const list = this._pickLevels(ids);
    let n = 0;
    for (const e of list) if (await this.exportLevel(e, true)) n++;
    toast(n ? `已导出 ${n} 个关卡文件` : '没有可导出的关卡', n ? 'ok' : 'err');
  }

  async batchCloneLevels(ids) {
    const list = this._pickLevels(ids);
    if (!list.length) { toast('没有可复制的关卡', 'err'); return; }
    let n = 0;
    for (const e of list) {
      try {
        const lv = await ensureEntryLevel(e);
        if (lv && await cloneLevelToSaves(lv, e.name + ' 副本')) n++;
      }
      catch (err) { console.warn('[levels] 批量复制失败', e.name, err); }
    }
    toast(n ? `已复制 ${n} 个关卡到「我的关卡」` : '复制失败', n ? 'ok' : 'err');
    await this.refresh();
  }

  async batchRemoveLevels(ids) {
    const picked = this._pickLevels(ids);
    const list = picked.filter((e) => e.kind === 'user');
    const skip = picked.length - list.length;
    if (!list.length) { toast('所选里没有可删除的「我的关卡」（官方 / 自定义关卡不可删）', 'err'); return; }
    const ok = await confirmBox(
      `确定删除所选的 ${list.length} 个关卡吗？此操作不可撤销。` + (skip ? `（另有 ${skip} 个官方 / 自定义关卡会自动跳过）` : ''),
      { title: '批量删除关卡', ok: '删除', danger: true },
    );
    if (!ok) return;
    for (const e of list) {
      try { await store.deleteLevel(e.id); }
      catch (err) { console.warn('[levels] 批量删除失败', e.name, err); }
    }
    toast(`已删除 ${list.length} 个关卡`, 'ok');
    await this.refresh();
  }

  /* ============================================================
     批量操作：关卡包列表
     ============================================================ */
  _pickPacks(ids) { return ids.map((id) => (this.packList || []).find((p) => p.id === id)).filter(Boolean); }

  async batchExportPacks(ids) {
    const list = this._pickPacks(ids);
    let n = 0;
    for (const p of list) if (await this.exportPack(p, true)) n++;
    toast(n ? `已导出 ${n} 个关卡包文件` : '没有可导出的关卡包', n ? 'ok' : 'err');
  }

  /** 复制关卡包：换新 id、节点 / 连线 / 贴纸全部重新编号，原包不受影响 */
  async batchClonePacks(ids) {
    const all = await loadPacks();
    let n = 0;
    for (const id of ids) {
      const p = all.find((x) => x.id === id);
      if (!p) continue;
      const copy = JSON.parse(JSON.stringify(p));
      copy.id = uid('pk');
      copy.name = (p.name || '关卡包') + ' 副本';
      const map = new Map();
      copy.nodes = (copy.nodes || []).map((nd) => { const nid = uid('nd'); map.set(nd.id, nid); return { ...nd, id: nid }; });
      copy.edges = (copy.edges || []).map((e) => [map.get(e[0]), map.get(e[1])]).filter((e) => e[0] && e[1]);
      copy.stickers = (copy.stickers || []).map((s) => ({ ...s, id: uid('st') }));
      try { await upsertPack(copy); n++; }
      catch (err) { console.warn('[levels] 复制关卡包失败', p.name, err); }
    }
    toast(n ? `已复制 ${n} 个关卡包` : '复制失败', n ? 'ok' : 'err');
    await this.refreshPacks();
  }

  async batchRemovePacks(ids) {
    const list = this._pickPacks(ids);
    if (!list.length) return;
    const ok = await confirmBox(
      `确定删除所选的 ${list.length} 个关卡包吗？关卡包里的关卡不会被删除。`,
      { title: '批量删除关卡包', ok: '删除', danger: true },
    );
    if (!ok) return;
    for (const p of list) {
      try { await deletePack(p.id); }
      catch (err) { console.warn('[levels] 删除关卡包失败', p.name, err); }
    }
    toast(`已删除 ${list.length} 个关卡包`, 'ok');
    await this.refreshPacks();
  }
}

function lab(v) { return Number(v) || 1; }