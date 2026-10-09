/* ============================================================
   关卡节点地图界面：打开一个「关卡包」→ 看剧情节点地图 → 选节点进关
   只读视图（节点拖动 / 连线在编辑器的「关卡包」面板里做）
   ============================================================ */
import { $, el, clear, toast } from './dom.js';
import { bindActs } from './menu.js';
import { LevelMap } from './levelmap.js';
import { isUnlocked, nodeOf, predecessors, pbInfo, packProgressInfo,
  packTiers, resolveTier, packView, tierDef, loadPackTiers, savePackTier,
  progressMaps, clearedSetOf, canEditPack } from '../levels/packs.js';
import { getBuiltinLevels, loadCustomLevels } from '../levels/builtin.js';
import { store } from '../core/storage.js';
import { mountStar } from './star.js';
import { fmtTime } from '../core/util.js';
import { t } from '../core/i18n.js';
import { mountModifierBar } from './modifier-bar.js';
import { runListTask } from '../core/list-tasks.js';
import { ensureEntryLevel } from './level-lazy.js';

/** 索引模式用不到完整关卡数据，先剥掉 data，避免跨线程克隆整份存档 */
function stripData(rec) {
  if (!rec) return rec;
  return {
    id: rec.id, name: rec.name, author: rec.author, description: rec.description,
    difficulty: rec.difficulty, updated: rec.updated, created: rec.created, bytes: rec.bytes,
    builtin: rec.builtin, packId: rec.packId, thumb: rec.thumb,
  };
}

export class LevelMapPanel {
  /** @param opts { onPlay(level, node, pack), onClose() } */
  constructor(opts = {}) {
    this.opts = opts;
    this.root = $('#lvmap');
    this.titleEl = $('#lvm-title');
    this.subEl = $('#lvm-sub');
    this.stage = $('#lvm-stage');
    this.infoEl = $('#lvm-info');
    this.pack = null;
    this.sel = null;
    this.cleared = new Set();
    this.levels = new Map();     // levelId -> 关卡对象（内置 / 自定义 / 已惰性解析的我的关卡）
    this.levelMeta = new Map();  // levelId -> 我的关卡元数据（惰性：完整关卡按需读盘）
    this.levelRecs = new Map();  // levelId -> 存档记录（编辑包内关卡时带出 packId）
    this.progress = new Map();   // levelId -> 进度记录
    this.levelUpdated = new Map();// levelId -> updated 时间戳
    this.info = null;            // 当前关卡包的整体进度 / 用时
    this.tier = 0;               // 当前档位（0 = 该包不分档）
    this.tierList = [];          // 包内实际存在的档位
    this.tierStore = {};         // packId → 玩家上次选的档位
    this.map = null;
    this.star = null;

    bindActs(this.root, (act) => {
      if (act === 'close') this.close();
    });

    // 难度档位切换条：挂在 stage 左上角，不随节点详情重绘被清掉
    this.tierBar = el('div', { class: 'lvm-tiers hidden' });
    if (this.stage) this.stage.appendChild(this.tierBar);

    // 100% 通关奖励（星星 + 总用时）：挂在 stage 上，不随节点详情重绘被清掉
    this.doneHost = el('div', { class: 'lvm-done hidden' });
    this.doneStarWrap = el('div', { class: 'lvm-star-wrap' });
    this.doneTotalEl = el('div', { class: 'lvm-total', text: '' });
    this.doneHost.appendChild(this.doneStarWrap);
    this.doneHost.appendChild(this.doneTotalEl);
    if (this.stage) this.stage.appendChild(this.doneHost);

    // 地图变体选择条：从节点地图进关时同样生效
    this.variantBar = mountModifierBar($('#lvm-variant'));
  }

  /** 关卡 id → 关卡对象（内置 / 自定义）+ 我的关卡元数据（惰性） */
  async _buildIndex() {
    const map = new Map();
    this.levelUpdated = new Map();
    this.levelRecs = new Map();
    this.levelMeta = new Map();
    try { await loadCustomLevels(); } catch (e) { /* 没有自定义目录时忽略 */ }
    for (const lv of getBuiltinLevels()) { map.set(lv.id, lv); this.levelUpdated.set(lv.id, 0); }
    // 我的关卡：只取元数据（解析交给 Worker，主线程不卡），完整关卡打开时才按需规范化
    try {
      const text = await store.listLevelsText().catch(() => null);
      const recs = text ? null : (await store.listLevels().catch(() => [])).map(stripData);
      const proj = await runListTask(
        'levelList',
        text ? { recsText: text, scope: 'index' } : { recs: recs || [], scope: 'index' },
      );
      for (const it of (proj && proj.items) || []) {
        if (map.has(it.id)) continue;
        const entry = {
          id: it.id, level: null, rec: it,
          name: it.name, description: it.description, difficulty: it.difficulty, updated: it.updated,
        };
        this.levelMeta.set(it.id, entry);
        this.levelRecs.set(it.id, it);
        this.levelUpdated.set(it.id, it.updated || 0);
      }
    } catch (e) { console.warn('[lvmap] 读取我的关卡失败', e); }
    this.levels = map;
    return map;
  }

  /** 关卡名 / 是否存在（内置命中内存对象，我的关卡用元数据） */
  _infoOf(id) {
    const lv = this.levels.get(id);
    if (lv) return { name: lv.name, exists: true };
    const m = this.levelMeta.get(id);
    return { name: m ? m.name : '', exists: !!m };
  }

  /** 取完整关卡对象（我的关卡按需读盘规范化并缓存） */
  async _resolveLevel(id) {
    const lv = this.levels.get(id);
    if (lv) return lv;
    const entry = this.levelMeta.get(id);
    if (!entry) return null;
    const full = await ensureEntryLevel(entry);
    if (full) this.levels.set(id, full);
    return full;
  }

  open(pack) {
    this.pack = pack;
    this.sel = null;
    if (this.titleEl) this.titleEl.textContent = (pack && pack.name) || '关卡包';
    if (this.subEl) this.subEl.textContent = (pack && pack.description) || '';
    if (this.variantBar) this.variantBar.refresh();
    this.refresh();
  }

  async refresh() {
    this.levels = await this._buildIndex();
    // 成绩独立隔离：只读本包自己的进度，与单关卡成绩互不影响
    const maps = await progressMaps();
    this.progress = this.pack ? (maps.byPack.get(this.pack.id) || new Map()) : maps.global;
    this.cleared = clearedSetOf(this.progress);
    // 档位：记住玩家上次选的，没记录就用包内最低存在档位
    this.tierStore = await loadPackTiers();
    this.tierList = this.pack ? packTiers(this.pack) : [];
    this.tier = this.pack ? resolveTier(this.pack, this.tierStore[this.pack.id]) : 0;
    this.info = this.pack
      ? packProgressInfo(this.pack, this.progress, this.levelUpdated, this.tier) : null;
    if (this.map) { this.map.dispose(); this.map = null; }
    if (this.stage) {
      this.map = new LevelMap(this.stage, {
        interactive: false,
        cleared: this.cleared,
        levelInfo: (id) => this._infoOf(id),
        onPick: (node) => { this.sel = node; this.renderInfo(); },
      });
      this.map.setPack(this.pack, this.cleared, this.tier);
    }
    this.renderTiers();
    this.renderSummary();
    this.renderInfo();
  }

  /** 难度档位切换条：只列出包内真正存在的档位 */
  renderTiers() {
    const bar = this.tierBar;
    if (!bar) return;
    clear(bar);
    const list = this.tierList || [];
    bar.classList.toggle('hidden', list.length === 0);
    if (!list.length) return;
    bar.appendChild(el('span', { class: 'lvm-tiers-l', text: t('难度档位') }));
    for (const v of list) {
      const td = tierDef(v);
      if (!td) continue;
      bar.appendChild(el('button', {
        class: 'tb' + (v === this.tier ? ' on' : ''),
        type: 'button',
        text: t(td.zh),
        title: t(td.zh) + ' · ' + t('对应关卡难度 ') + td.range,
        onclick: () => this.setTier(v),
      }));
    }
  }

  /** 切档位：只重排地图与统计，不重建关卡索引 */
  async setTier(v) {
    if (!this.pack || v === this.tier) return;
    this.tier = v;
    const td = tierDef(v);
    if (td) toast(t('难度档位：') + t(td.zh) + ' · ' + t('对应关卡难度 ') + td.range, '', 1600);
    if (this.sel && !packView(this.pack, v).nodes.some((n) => n.id === this.sel.id)) this.sel = null;
    if (this.map) this.map.setTier(v);
    this.info = packProgressInfo(this.pack, this.progress, this.levelUpdated, v);
    await savePackTier(this.pack.id, v);
    this.tierStore[this.pack.id] = v;
    this.renderTiers();
    this.renderSummary();
    this.renderInfo();
  }

  /** 100% 通关：显示 shader 星星 + 关卡包总用时 */
  renderSummary() {
    const info = this.info;
    const complete = !!(info && info.complete);
    if (this.doneHost) this.doneHost.classList.toggle('hidden', !complete);
    if (!complete) {
      if (this.star) { this.star.dispose(); this.star = null; }
      return;
    }
    if (!this.star) this.star = mountStar(this.doneStarWrap, { size: 84 });
    if (this.doneTotalEl) this.doneTotalEl.textContent = t('总用时 ') + fmtTime(info.totalTime || 0);
  }

  /* ---------- 右侧节点详情 ---------- */
  renderInfo() {
    const box = this.infoEl;
    if (!box) return;
    clear(box);
    const p = this.pack;
    if (!p) return;
    const n = this.sel;
    if (!n) {
      box.appendChild(el('div', { class: 'lvm-tip', text: '点击地图上的节点查看关卡信息' }));
      return;
    }
    const lv = this.levels.get(n.levelId);
    const meta = this.levelMeta.get(n.levelId);
    const hasLevel = !!(lv || meta);
    const view = packView(p, this.tier);
    const cleared = !!(n.levelId && this.cleared.has(n.levelId));
    const unlocked = isUnlocked(view, n, this.cleared);
    box.appendChild(el('div', { class: 'lvm-i-head' },
      el('div', { class: 'lvm-i-name', text: n.title || (lv && lv.name) || (meta && meta.name) || '未命名关卡' }),
      el('div', {
        class: 'lvm-i-state ' + (cleared ? 'ok' : (unlocked ? 'cur' : 'no')),
        text: cleared ? '已通关' : (unlocked ? '可挑战' : '未解锁'),
      }),
    ));
    // 档位备选节点：说明它只在哪一档出现
    const ntd = n.tier > 0 ? tierDef(n.tier) : null;
    if (ntd) {
      box.appendChild(el('div', { class: 'lvm-i-tier', style: { color: ntd.color },
        text: t('仅 ') + t(ntd.zh) + t(' 档出现（难度 ') + ntd.range + '）' }));
    }
    // 单关最佳时间（地图更新后自动失效）
    const pinfo = pbInfo(this.progress.get(n.levelId), this.levelUpdated.get(n.levelId));
    if (pinfo.cleared) {
      box.appendChild(el('div', {
        class: 'lvm-i-pb' + (pinfo.stale ? ' stale' : ''),
        text: pinfo.stale ? t('地图已更新，最佳成绩已失效') : (t('最佳 ') + fmtTime(pinfo.best)),
      }));
    }
    const desc = n.desc || (lv && lv.description) || (meta && meta.description) || '';
    box.appendChild(el('div', { class: 'lvm-i-desc', text: desc || '（无描述）' }));
    if (!n.levelId || !hasLevel) {
      box.appendChild(el('div', { class: 'lvm-i-warn', text: '该节点还没有绑定关卡，请到编辑器「关卡包」面板里设置。' }));
      return;
    }
    if (!unlocked) {
      const names = predecessors(view, n.id).map((id) => nodeOf(view, id))
        .filter(Boolean).map((x) => x.title || x.levelId || '前置关卡').join('、');
      box.appendChild(el('div', { class: 'lvm-i-warn', text: '需要先通关：' + (names || '前置关卡') }));
      return;
    }
    box.appendChild(el('div', { class: 'lvm-i-btns' },
      el('button', {
        class: 'mbtn sm primary',
        text: cleared ? '↻ 再玩一次' : '▶ 开始',
        onclick: () => this.playSelected(),
      }),
      // 包内关卡只能从这里点开编辑（不出现在任何选关列表）；作者放开编辑权时才显示
      canEditPack(p) ? el('button', {
        class: 'mbtn sm',
        text: '✎ 编辑此关卡',
        title: '打开编辑器修改这个关卡节点绑定的关卡',
        onclick: () => this.editSelected(),
      }) : null,
    ));
  }

  /** 编辑当前选中的节点关卡（只有可编辑的包才走到这里） */
  async editSelected() {
    const n = this.sel;
    const p = this.pack;
    if (!n || !p) return;
    const lv = await this._resolveLevel(n.levelId);
    if (!lv) { toast('该节点还没有绑定关卡', 'err'); return; }
    let rec = this.levelRecs.get(n.levelId) || null;
    if (rec && !rec.data) { try { const full = await store.getLevel(n.levelId); if (full) rec = full; } catch (e) { /* ignore */ } }
    this.opts.onEdit && this.opts.onEdit(lv, rec);
  }

  async playSelected() {
    const n = this.sel;
    const p = this.pack;
    if (!n || !p) return;
    const lv = await this._resolveLevel(n.levelId);
    if (!lv) { toast('该节点还没有绑定关卡', 'err'); return; }
    if (!isUnlocked(packView(p, this.tier), n, this.cleared)) {
      toast('这个节点还没解锁，先通关前置关卡', 'err'); return;
    }
    this.opts.onPlay && this.opts.onPlay(lv, n, p);
  }

  close() {
    if (this.star) { this.star.dispose(); this.star = null; }
    if (this.doneHost) this.doneHost.classList.add('hidden');
    this.opts.onClose && this.opts.onClose();
  }
}
