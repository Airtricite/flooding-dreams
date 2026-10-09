/* ============================================================
   编辑器 · 关卡包面板
   把关卡按剧情串成一张节点地图：新建节点 / 连线 / 拖动摆位 / 自动排布
   改动即时写入 store（kv: levelPacks），与关卡本身的保存互不影响
   ============================================================ */
import { el, clear, toast, promptBox, confirmBox } from '../ui/dom.js';
import { optSelect } from './widgets.js';
import { LevelMap } from '../ui/levelmap.js';
import {
  loadPacksRaw, upsertPack, deletePack, createPack, createNode,
  autoLayout, nodeOf, MAX_STICKERS, canEditPack,
  PACK_TIERS, tierDef, tierOfDiff, packTiers,
} from '../levels/packs.js';
import { getBuiltinLevels, loadCustomLevels } from '../levels/builtin.js';
import { store } from '../core/storage.js';
import { runListTask } from '../core/list-tasks.js';
import { pickFile, readFileText, download, sanitizeName, imageToDataURL, uid } from '../core/util.js';
import { exportPackBundle, readPackBundle, importPackBundle, PACK_EXT } from '../core/pack-file.js';
import { DIFFICULTY } from '../config.js';
import { t } from '../core/i18n.js';

const clamp01 = (v) => (v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v);

export class PackPanel {
  constructor(ed) {
    this.ed = ed;
    this.packs = [];
    this.cur = null;          // 当前关卡包（就地修改后 upsert）
    this.selNode = null;      // 选中节点 id
    this.selSticker = null;   // 选中贴纸 id
    this.previewTier = 0;     // 编辑器预览档位（0 = 全部显示）
    this.linking = false;     // 连线模式：点起点 → 点终点
    this.linkFrom = null;
    this.levelOpts = [];
    this.map = null;

    this.listItems = el('div', { class: 'pkp-items' });
    const list = el('div', { class: 'pkp-list' },
      el('div', { class: 'pkp-list-h' },
        el('button', { class: 'mini', text: '＋ 关卡包', title: '新建关卡包', onclick: () => this.addPack() }),
        el('button', { class: 'mini', text: '⬇ 导入', title: '导入关卡包文件（.fdpack）', onclick: () => this.importPack() }),
        el('button', { class: 'mini', text: '⤢', title: '放大面板', onclick: () => this.toggleTall() })),
      this.listItems);

    this.bar = el('div', { class: 'pkp-bar' });
    this.stage = el('div', { class: 'pkp-stage' });
    const main = el('div', { class: 'pkp-main' }, this.bar, this.stage);

    this.insp = el('div', { class: 'pkp-insp' });

    this.el = el('div', { class: 'pkp' }, list, main, this.insp);
    this._bindStickerDrop();
    this.refresh();
  }

  /** 拖图片文件到地图上即可加贴纸 */
  _bindStickerDrop() {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    this.stage.addEventListener('dragover', (e) => { stop(e); e.dataTransfer.dropEffect = 'copy'; });
    this.stage.addEventListener('drop', async (e) => {
      stop(e);
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      const img = files.find((f) => f.type && f.type.startsWith('image/'));
      if (!img) return;
      const src = await imageToDataURL(img);
      if (!src) { toast(t('无法读取这张图片'), 'err'); return; }
      this.addSticker(src);
    });
  }

  onShow() { this.refresh(); }
  toggleTall() {
    const bot = document.getElementById('ed-bottom');
    if (bot) bot.classList.toggle('tall');
  }

  /* ============================================================
     数据
     ============================================================ */
  async refresh() {
    // 原始包数据交给 Worker 归一化，主线程只拿结果
    try {
      const raw = await loadPacksRaw();
      const proj = await runListTask('packList', { raw, defaultName: t('新关卡包') });
      this.packs = (proj && proj.packs) || [];
    } catch (e) { console.warn('[pack] 读取关卡包失败', e); this.packs = []; }
    if (!this.cur || !this.packs.some((p) => p.id === this.cur.id)) this.cur = this.packs[0] || null;
    this.selNode = null;
    this.selSticker = null;
    this.linking = false;
    this.linkFrom = null;
    await this.loadLevelOptions();
    this.renderList();
    this.renderMap();
    this.renderInsp();
  }

  /** 可选关卡：内置 / 自定义 / 我的关卡（我的关卡只取元数据，解析交给 Worker） */
  async loadLevelOptions() {
    const out = [];
    try { await loadCustomLevels(); } catch (e) { /* 没有自定义目录时忽略 */ }
    for (const lv of getBuiltinLevels()) out.push({ id: lv.id, name: lv.name + (lv.custom ? '（自定义）' : ''), difficulty: Number(lv.difficulty) || 1 });
    try {
      const text = await store.listLevelsText().catch(() => null);
      const recs = text ? null : await store.listLevels().catch(() => []);
      const proj = await runListTask(
        'levelList',
        text ? { recsText: text, scope: 'index' } : { recs: recs || [], scope: 'index' },
      );
      for (const it of (proj && proj.items) || []) {
        // 包内关卡独立隔离：其它包的关卡不出现在这里（本能编辑当前包的关卡）
        if (it.packId && it.packId !== (this.cur && this.cur.id)) continue;
        if (!out.some((o) => o.id === it.id)) out.push({ id: it.id, name: it.name || '未命名', difficulty: Number(it.difficulty) || 1 });
      }
    } catch (e) { /* 忽略 */ }
    this.levelOpts = out;
  }

  /** 当前关卡包是否可编辑：作者自己的包可编辑；导入的包看作者是否放开 */
  editable() {
    return canEditPack(this.cur);
  }

  async persist(what) {
    if (!this.cur) return;
    if (!this.editable()) return;      // 只读包：任何改动都不落盘
    try { await upsertPack(this.cur); } catch (e) {
      console.error('[pack] 保存失败', e);
      this.ed.log('关卡包保存失败：' + (e && e.message ? e.message : e), 'e');
      return;
    }
    if (what) this.ed.log('关卡包：' + what, 'ok');
  }

  /* ============================================================
     关卡包增删
     ============================================================ */
  async addPack() {
    const name = await promptBox('关卡包名称', t('新的故事'), { title: '新建关卡包' });
    if (name === null) return;
    const p = createPack({ name: name || t('新的故事'), author: this.ed.level ? this.ed.level.author : '' });
    this.packs.push(p);
    this.cur = p;
    this.selNode = null;
    await this.persist('新建「' + p.name + '」');
    this.renderList();
    this.renderMap();
    this.renderInsp();
  }

  async renamePack() {
    if (!this.cur) return;
    const name = await promptBox('关卡包名称', this.cur.name || '', { title: '重命名关卡包' });
    if (name === null) return;
    this.cur.name = name || t('未命名关卡包');
    await this.persist('重命名为「' + this.cur.name + '」');
    this.renderList();
    this.renderInsp();
  }

  async delPack() {
    if (!this.cur) return;
    const ok = await confirmBox(`确定删除关卡包「${this.cur.name}」吗？（不会删除里面的关卡）`,
      { title: '删除关卡包', ok: '删除', danger: true });
    if (!ok) return;
    const name = this.cur.name;
    await deletePack(this.cur.id);
    this.cur = null;
    this.ed.log('删除关卡包「' + name + '」', 'w');
    await this.refresh();
  }

  /* ============================================================
     导入 / 导出关卡包文件
     ============================================================ */
  async exportPack() {
    if (!this.cur) return;
    const name = this.cur.name || '关卡包';
    // 打包读的是「存档里的关卡」，编辑器里刚涂鸦 / 刚导入的贴图与音频可能还没落盘：
    // 先静默存一次，否则导出的是旧版本，导入后就会缺内容
    const ed = this.ed;
    if (ed && ed.level && ed.dirty && this.cur.nodes.some((n) => n.levelId === ed.level.id)) {
      try { await ed.save(true); } catch (e) { console.warn('[pack] 导出前保存失败', e); }
    }
    try {
      const bundle = await exportPackBundle(this.cur);
      download(sanitizeName(name, '关卡包') + PACK_EXT, JSON.stringify(bundle));
      const miss = bundle.missing.length ? `，${bundle.missing.length} 个节点未绑定到关卡` : '';
      this.ed.log(`导出关卡包「${name}」：${bundle.levels.length} 个关卡副本${miss}`, 'ok');
      if (bundle.missing.length) toast('部分节点未绑定关卡，已跳过', 'warn');
    } catch (e) {
      console.error('[pack] 导出失败', e);
      this.ed.log('导出关卡包失败：' + (e && e.message ? e.message : e), 'e');
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
      await this.refresh();
      const p = this.packs.find((x) => x.id === r.pack.id);
      if (p) this.selectPack(p);
      this.ed.log(`导入关卡包「${r.pack.name}」：${r.levels} 个关卡、${r.assets} 个素材、${r.nodes} 个节点`, 'ok');
      if (r.missing.length) toast('部分节点未绑定到关卡（对方缺关卡）', 'warn');
    } catch (e) {
      console.error('[pack] 导入失败', e);
      toast('导入失败：' + (e && e.message ? e.message : e), 'err');
    }
  }

  selectPack(p) {
    if (!p || (this.cur && p.id === this.cur.id)) return;
    this.cur = p;
    this.selNode = null;
    this.linking = false;
    this.linkFrom = null;
    this.renderList();
    this.renderMap();
    this.renderInsp();
  }

  /* ============================================================
     节点 / 连线
     ============================================================ */
  addNode() {
    if (!this.cur) { toast('先新建一个关卡包', 'err'); return; }
    const used = new Set(this.cur.nodes.map((n) => n.levelId));
    const free = this.levelOpts.find((o) => !used.has(o.id));
    const n = this.cur.nodes.length;
    const last = this.cur.nodes[n - 1];
    const node = createNode({
      levelId: free ? free.id : '',
      x: last ? clamp01(last.x + 0.14) : 0.5,
      y: last ? clamp01(last.y + 0.1) : 0.5,
      tier: this.previewTier || 0,
    });
    this.cur.nodes.push(node);
    this.selNode = node.id;
    this.persist('新增节点');
    this.map.render();
    this.renderInsp();
  }

  delNode(id) {
    if (!this.cur) return;
    const i = this.cur.nodes.findIndex((n) => n.id === id);
    if (i < 0) return;
    this.cur.nodes.splice(i, 1);
    this.cur.edges = this.cur.edges.filter((e) => e[0] !== id && e[1] !== id);
    if (this.selNode === id) this.selNode = null;
    this.persist('删除节点');
    this.map.render();
    this.renderInsp();
  }

  addEdge(from, to) {
    if (!this.cur || from === to) return;
    if (this.cur.edges.some((e) => e[0] === from && e[1] === to)) {
      this.linking = false; this.linkFrom = null;
      this.renderBar();
      return;
    }
    this.cur.edges.push([from, to]);
    this.linking = false;
    this.linkFrom = null;
    this.persist('新增连线');
    this.map.render();
    this.renderBar();
    this.renderInsp();
  }

  delEdge(a, b) {
    if (!this.cur) return;
    this.cur.edges = this.cur.edges.filter((e) => !(e[0] === a && e[1] === b));
    this.persist('删除连线');
    this.map.render();
    this.renderInsp();
  }

  toggleLink() {
    if (!this.cur) return;
    this.linking = !this.linking;
    this.linkFrom = null;
    this.renderBar();
    this.renderInsp();
  }

  doAutoLayout() {
    if (!this.cur || !this.cur.nodes.length) return;
    autoLayout(this.cur);
    this.persist('自动排布');
    this.map.render();
  }

  /** 按节点所绑定关卡的难度，自动归入对应档位（未绑定 / 无难度 → 通用） */
  autoTiers() {
    if (!this.cur || !this.cur.nodes.length) return;
    for (const n of this.cur.nodes) {
      const o = this.levelOpts.find((x) => x.id === n.levelId);
      n.tier = o && o.difficulty ? tierOfDiff(o.difficulty) : 0;
    }
    this.persist('按难度自动分档');
    this.renderBar();
    this.map.render();
    this.renderInsp();
  }

  /** 把所有节点设回通用档（所有档位都出现） */
  clearTiers() {
    if (!this.cur || !this.cur.nodes.length) return;
    for (const n of this.cur.nodes) n.tier = 0;
    this.previewTier = 0;
    this.persist('全部设为通用');
    this.renderBar();
    this.map.render();
    this.renderInsp();
  }

  /* ============================================================
     贴纸
     ============================================================ */
  addSticker(src) {
    if (!this.cur) { toast(t('先新建或选中一个关卡包'), 'err'); return; }
    if (!src) return;
    this.cur.stickers = this.cur.stickers || [];
    if (this.cur.stickers.length >= MAX_STICKERS) { toast(`最多 ${MAX_STICKERS} 张贴纸`, 'warn'); return; }
    const s = { id: uid('st'), x: 0.5, y: 0.5, w: 0.22, h: 0.22, rot: 0, src };
    this.cur.stickers.push(s);
    this.selSticker = s.id;
    this.map.render();
    this.map.selectSticker(s.id);
    this.persist('添加贴纸');
    this.renderInsp();
  }

  async pickSticker() {
    const file = await pickFile('image/*');
    if (!file) return;
    const src = await imageToDataURL(file);
    if (!src) { toast(t('无法读取这张图片'), 'err'); return; }
    this.addSticker(src);
  }

  async pasteSticker() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('no clipboard api');
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = (it.types || []).find((tp) => tp.startsWith('image/'));
        if (!type) continue;
        const blob = await it.getType(type);
        const src = await imageToDataURL(blob);
        if (src) { this.addSticker(src); return; }
      }
      toast(t('剪贴板里没有图片'), 'warn');
    } catch (e) {
      toast(t('无法读取剪贴板，请改用「上传图片」或把图片拖进地图'), 'err');
    }
  }

  delSticker(id) {
    if (!this.cur) return;
    this.cur.stickers = (this.cur.stickers || []).filter((s) => s.id !== id);
    if (this.selSticker === id) this.selSticker = null;
    this.map.render();
    this.map.selectSticker(this.selSticker);
    this.persist('删除贴纸');
    this.renderInsp();
  }

  raiseSticker(id) {
    const arr = this.cur && this.cur.stickers;
    if (!arr) return;
    const i = arr.findIndex((s) => s.id === id);
    if (i < 0 || i === arr.length - 1) return;
    const [s] = arr.splice(i, 1);
    arr.push(s);
    this.map.render();
    this.map.selectSticker(this.selSticker);
    this.persist('调整贴纸层序');
    this.renderInsp();
  }

  /* ============================================================
     渲染：左列表
     ============================================================ */
  renderList() {
    clear(this.listItems);
    if (!this.packs.length) {
      this.listItems.appendChild(el('div', { class: 'pkp-hint', text: '还没有关卡包。\n点上方「＋ 关卡包」新建，再把关卡串成地图。' }));
      return;
    }
    for (const p of this.packs) {
      const item = el('div', {
        class: 'pkp-item' + (this.cur && p.id === this.cur.id ? ' sel' : ''),
        onclick: () => this.selectPack(p),
      },
        el('span', { class: 'pn', text: p.name || '未命名关卡包' }),
        el('span', { class: 'pc', text: String(p.nodes.length) }),
      );
      this.listItems.appendChild(item);
    }
  }

  /* ============================================================
     渲染：中间地图 + 工具条
     ============================================================ */
  renderMap() {
    if (this.map) { this.map.dispose(); this.map = null; }
    clear(this.stage);
    // 档位失效（节点被改回通用 / 包已更换）时回落到「全部」
    if (!this.cur) this.previewTier = 0;
    else if (this.previewTier && packTiers(this.cur).indexOf(this.previewTier) < 0) this.previewTier = 0;
    this.renderBar();
    if (!this.cur) {
      this.stage.appendChild(el('div', { class: 'pkp-empty', text: '新建或选中一个关卡包后，在这里摆节点、连剧情线。' }));
      return;
    }
    this.map = new LevelMap(this.stage, {
      interactive: this.editable(),      // 只读包：地图不可拖动编辑
      stickerEdit: this.editable(),
      cleared: new Set(),
      levelInfo: (id) => {
        const o = this.levelOpts.find((x) => x.id === id);
        return { name: o ? o.name : '', exists: !!o };
      },
      onPick: (node) => this.onPick(node),
      onChange: () => this.persist('移动节点'),
      onStickerSelect: (s) => { this.selSticker = s.id; this.renderInsp(); },
      onStickerChange: (s) => { void s; this.persist('移动贴纸'); },
    });
    this.map.selSticker = this.selSticker;
    this.map.setPack(this.cur, new Set(), this.previewTier);
  }

  /** 编辑器预览档位：0 = 全部显示，其余过滤掉别的档位节点 */
  setPreview(v) {
    this.previewTier = Number(v) || 0;
    if (this.cur) {
      const exist = packTiers(this.cur);
      if (this.previewTier && exist.indexOf(this.previewTier) < 0) this.previewTier = 0;
    } else {
      this.previewTier = 0;
    }
    this.renderBar();
    if (this.map) this.map.setTier(this.previewTier);
    this.renderInsp();
  }

  onPick(node) {
    if (this.linking) {
      if (!this.linkFrom) {
        this.linkFrom = node.id;
        this.renderBar();
        this.ed.showHint('再点一个节点作为终点（右键 / Esc 取消）');
      } else {
        this.addEdge(this.linkFrom, node.id);
      }
      return;
    }
    this.selNode = this.selNode === node.id ? null : node.id;
    this.renderInsp();
  }

  renderBar() {
    clear(this.bar);
    const on = !!this.cur;
    const can = this.editable();
    if (on && !can) {
      this.bar.appendChild(el('span', { class: 'pkp-bar-hint', text: t('这个关卡包为只读（作者未开放编辑），只能预览与游玩') }));
      this.bar.appendChild(el('button', {
        class: 'mini', text: '▶ 预览地图', title: '以玩家视角打开这张剧情地图',
        onclick: () => this.ed.app && this.ed.app.openLevelMap(this.cur, 'editor'),
      }));
      return;
    }
    this.bar.appendChild(el('button', {
      class: 'mini', text: '＋ 节点', title: '添加一个剧情节点', disabled: !on,
      onclick: () => this.addNode(),
    }));
    this.bar.appendChild(el('button', {
      class: 'mini' + (this.linking ? ' on' : ''),
      text: this.linking ? (this.linkFrom ? '选终点…' : '选起点…') : '＋ 连线',
      title: '连接两个节点（前一个通关后解锁后一个）', disabled: !on,
      onclick: () => this.toggleLink(),
    }));
    this.bar.appendChild(el('button', {
      class: 'mini', text: '⇢ 自动排布', title: '按连线关系自动摆放节点', disabled: !on,
      onclick: () => this.doAutoLayout(),
    }));
    this.bar.appendChild(el('span', { class: 'pkp-bar-hint', text: this.linking
      ? '连线模式：依次点击起点、终点节点'
      : '拖动节点可调整位置 · 改动自动保存' }));
    if (on) {
      const exist = packTiers(this.cur);
      if (exist.length) {
        const tb = el('div', { class: 'pkp-tierbar' },
          el('span', { class: 'tb-l', text: t('预览档位') }));
        tb.appendChild(el('button', {
          class: 'mini' + (!this.previewTier ? ' on' : ''),
          text: t('全部'),
          title: t('显示全部节点（含各档位备选节点）'),
          onclick: () => this.setPreview(0),
        }));
        for (const v of exist) {
          const td = tierDef(v);
          if (!td) continue;
          tb.appendChild(el('button', {
            class: 'mini' + (this.previewTier === v ? ' on' : ''),
            text: t(td.zh),
            title: t('仅预览 ') + t(td.zh) + t(' 档（难度 ') + td.range + '）',
            onclick: () => this.setPreview(v),
          }));
        }
        this.bar.appendChild(tb);
      }
      this.bar.appendChild(el('button', {
        class: 'mini', text: '▶ 预览地图', title: '以玩家视角打开这张剧情地图',
        onclick: () => this.ed.app && this.ed.app.openLevelMap(this.cur, 'editor'),
      }));
    }
  }

  /* ============================================================
     渲染：右侧属性
     ============================================================ */
  renderInsp() {
    const box = this.insp;
    clear(box);
    if (!this.cur) {
      box.appendChild(el('div', { class: 'pkp-hint', text: '未选中关卡包' }));
      return;
    }
    const p = this.cur;
    const can = this.editable();
    box.appendChild(el('div', { class: 'pkp-sec', text: '关卡包' }));
    if (!can) box.appendChild(el('div', { class: 'pkp-hint', text: t('该关卡包由他人导入且作者未开放编辑，仅可查看、导出与游玩。') }));
    box.appendChild(this.field('名称', el('input', {
      class: 'inp', value: p.name || '', disabled: !can,
      onchange: (e) => { p.name = e.target.value; this.persist('重命名'); this.renderList(); },
    })));
    box.appendChild(this.field('作者', el('input', {
      class: 'inp', value: p.author || '', disabled: !can,
      onchange: (e) => { p.author = e.target.value; this.persist('修改作者'); },
    })));
    box.appendChild(this.field('描述', el('textarea', {
      class: 'inp', rows: 2, disabled: !can,
      onchange: (e) => { p.description = e.target.value; this.persist('修改描述'); },
    }, p.description || '')));
    const cb = el('input', {
      type: 'checkbox', checked: !!p.unlockAll, disabled: !can,
      onchange: (e) => { p.unlockAll = e.target.checked; this.persist('切换解锁方式'); this.map.render(); },
    });
    box.appendChild(el('label', { class: 'pkp-chk' }, cb, el('span', { text: '全部解锁（不看连线，所有节点都能进）' })));
    // 是否允许其他玩家编辑：作者导出后，导入方据此决定可编辑 / 只读
    const ecb = el('input', {
      type: 'checkbox', checked: !!p.allowEdit, disabled: !can,
      onchange: (e) => { p.allowEdit = e.target.checked; this.persist('切换是否允许他人编辑'); },
    });
    box.appendChild(el('label', { class: 'pkp-chk' }, ecb, el('span', { text: t('允许其他玩家编辑这个关卡包（含包内关卡）') })));
    box.appendChild(el('div', { class: 'pkp-btns' },
      el('button', { class: 'mini', text: '⬆ 导出包', title: '导出关卡包文件（含节点地图与全部关卡副本、素材）', onclick: () => this.exportPack() }),
      can ? el('button', { class: 'mini', text: '✎ 重命名', onclick: () => this.renamePack() }) : null,
      can ? el('button', { class: 'mini danger', text: '🗑 删除关卡包', onclick: () => this.delPack() }) : null,
    ));

    /* ---------- 难度档位 ---------- */
    const tiers = packTiers(p);
    box.appendChild(el('div', { class: 'pkp-sec', text: t('难度档位') + '（' + tiers.length + '）' }));
    const row = el('div', { class: 'pkp-tierrow' });
    const order = [0, ...PACK_TIERS.map((td) => td.v)];
    const count = new Map();
    for (const nd of p.nodes) { const k = Number(nd.tier) || 0; count.set(k, (count.get(k) || 0) + 1); }
    for (const k of order) {
      const c = count.get(k) || 0;
      if (k !== 0 && !c) continue;
      const td = k ? tierDef(k) : null;
      const pill = el('span', { class: 'pkp-tierpill', title: td ? td.range : t('所有档位都出现') },
        el('span', { class: 'tp-n', text: td ? t(td.zh) : t('通用') }),
        el('span', { class: 'tp-c', text: String(c) }),
      );
      if (td) pill.style.setProperty('--tier-color', td.color);
      row.appendChild(pill);
    }
    box.appendChild(row);
    box.appendChild(el('div', { class: 'pkp-hint', text: t('只有包内存在对应档位节点时，该档位才会出现在玩家的档位选择里。通用节点在所有档位都出现。') }));
    if (can) {
      box.appendChild(el('div', { class: 'pkp-btns' },
        el('button', { class: 'mini', text: t('按难度自动分档'), title: t('按节点所绑定关卡的难度自动归入对应档位'), onclick: () => this.autoTiers() }),
        el('button', { class: 'mini', text: t('全部设为通用'), onclick: () => this.clearTiers() }),
      ));
    }
    // 只读包：不渲染节点 / 贴纸 / 连线的编辑区
    if (!can) return;

    /* ---------- 选中节点 ---------- */
    const n = nodeOf(p, this.selNode);
    if (n) {
      box.appendChild(el('div', { class: 'pkp-sec', text: '节点 · ' + (n.title || n.levelId || '未命名') }));
      const lvOpts = [{ v: '', l: '（未绑定关卡）' }];
      for (const o of this.levelOpts) lvOpts.push({ v: o.id, l: o.name });
      if (n.levelId && !this.levelOpts.some((o) => o.id === n.levelId)) {
        lvOpts.push({ v: n.levelId, l: n.levelId + '（已不存在）' });
      }
      const sel = optSelect(lvOpts, n.levelId || '', (v) => {
        n.levelId = v;
        this.persist('绑定关卡');
        this.map.render();
        this.renderInsp();
      }, 'inp');
      box.appendChild(this.field('关卡', sel));
      box.appendChild(this.field('标题', el('input', {
        class: 'inp', value: n.title || '', placeholder: '留空则用关卡名',
        onchange: (e) => { n.title = e.target.value; this.persist('修改节点标题'); this.map.render(); },
      })));
      box.appendChild(this.field('剧情文字', el('textarea', {
        class: 'inp', rows: 3, placeholder: '节点地图上显示的剧情描述',
        onchange: (e) => { n.desc = e.target.value; this.persist('修改节点剧情'); },
      }, n.desc || '')));
      // 自定义颜色（默认 = 主题色）
      box.appendChild(this.field('颜色', el('div', { class: 'pkp-color' },
        el('input', {
          type: 'color', value: n.color || '#7fe3ff', title: t('节点自定义颜色'),
          oninput: (e) => { n.color = e.target.value; this.map.render(); },
          onchange: () => this.persist('修改节点颜色'),
        }),
        el('button', {
          class: 'mini', text: '默认', title: t('恢复主题默认颜色'),
          onclick: () => { n.color = ''; this.persist('清除节点颜色'); this.map.render(); this.renderInsp(); },
        }),
      )));
      // 难度标签（0 = 跟随所绑定关卡）
      const diffMatch = n.diff ? DIFFICULTY.find((d) => Math.abs(n.diff - d.min) < 0.001) : null;
      const dOpts = [{ v: '0', l: t('继承（跟随关卡）') }];
      for (const d of DIFFICULTY) dOpts.push({ v: String(d.min), l: d.label + ' ' + d.zh });
      const dsel = optSelect(dOpts, diffMatch ? String(diffMatch.min) : '0', (v) => {
        n.diff = Number(v) || 0;
        this.persist('修改节点难度');
        this.map.render();
      }, 'inp');
      box.appendChild(this.field('难度', dsel));
      // 档位（0 = 通用，所有档位都出现；否则仅该档位出现）
      const tierMatch = PACK_TIERS.some((td) => n.tier === td.v) ? n.tier : 0;
      const tOpts = [{ v: '0', l: t('通用（所有档位都出现）') }];
      for (const td of PACK_TIERS) tOpts.push({ v: String(td.v), l: t(td.zh) + '（' + td.range + '）' });
      const tsel = optSelect(tOpts, String(tierMatch), (v) => {
        n.tier = Number(v) || 0;
        this.persist('修改节点档位');
        this.renderBar();
        this.map.render();
        this.renderInsp();
      }, 'inp');
      box.appendChild(this.field('档位', tsel));
      box.appendChild(el('div', { class: 'pkp-btns' },
        el('button', { class: 'mini danger', text: '🗑 删除节点', onclick: () => this.delNode(n.id) }),
      ));
    }

    /* ---------- 贴纸 ---------- */
    const stks = p.stickers || [];
    box.appendChild(el('div', { class: 'pkp-sec', text: t('贴纸') + '（' + stks.length + '）' }));
    box.appendChild(el('div', { class: 'pkp-btns' },
      el('button', { class: 'mini', text: t('＋ 上传图片'), title: t('选择本地图片作为贴纸'), onclick: () => this.pickSticker() }),
      el('button', { class: 'mini', text: t('📋 粘贴'), title: t('从剪贴板粘贴图片（也可直接把图片拖进地图）'), onclick: () => this.pasteSticker() }),
    ));
    if (!stks.length) {
      box.appendChild(el('div', { class: 'pkp-hint', text: t('还没有贴纸。上传 / 粘贴 / 拖入图片，在地图上做装饰。') }));
    }
    for (const s of stks) {
      const row = el('div', {
        class: 'pkp-stk' + (s.id === this.selSticker ? ' sel' : ''),
        onclick: () => { this.selSticker = s.id; this.map && this.map.selectSticker(s.id); this.renderInsp(); },
      },
        el('img', { src: s.src, alt: '' }),
        el('input', {
          class: 'inp sm', type: 'number', min: '5', max: '100', title: t('大小（%）'),
          value: String(Math.round((s.w || 0.2) * 100)),
          onclick: (e) => e.stopPropagation(),
          oninput: (e) => {
            const v = Math.max(5, Math.min(100, Number(e.target.value) || 22)) / 100;
            s.w = v; s.h = v; this.map && this.map.syncStickers();
          },
          onchange: () => this.persist('修改贴纸大小'),
        }),
        el('input', {
          class: 'inp sm', type: 'number', min: '0', max: '359', title: t('旋转（度）'),
          value: String(Math.round(s.rot || 0)),
          onclick: (e) => e.stopPropagation(),
          oninput: (e) => { s.rot = ((Number(e.target.value) || 0) % 360 + 360) % 360; this.map && this.map.syncStickers(); },
          onchange: () => this.persist('旋转贴纸'),
        }),
        el('button', { class: 'mini', text: '⤒', title: t('置顶'), onclick: (e) => { e.stopPropagation(); this.raiseSticker(s.id); } }),
        el('button', { class: 'mini danger', text: '✕', title: t('删除贴纸'), onclick: (e) => { e.stopPropagation(); this.delSticker(s.id); } }),
      );
      box.appendChild(row);
    }

    /* ---------- 连线列表 ---------- */
    const nameOf = (id) => {
      const x = nodeOf(p, id);
      return x ? (x.title || x.levelId || '未命名') : '（已删除）';
    };
    box.appendChild(el('div', { class: 'pkp-sec', text: '剧情连线（' + p.edges.length + '）' }));
    if (!p.edges.length) {
      box.appendChild(el('div', { class: 'pkp-hint', text: '还没有连线。点「＋ 连线」把节点串起来。' }));
    } else {
      for (const e of p.edges) {
        box.appendChild(el('div', { class: 'pkp-edge' },
          el('span', { class: 'pe', text: nameOf(e[0]) + ' → ' + nameOf(e[1]) }),
          el('button', { class: 'mini danger', text: '✕', title: '删除这条连线', onclick: () => this.delEdge(e[0], e[1]) }),
        ));
      }
    }
  }

  field(label, ctl) {
    return el('label', { class: 'pkp-field' }, el('span', { class: 'pf-l', text: label }), ctl);
  }
}
