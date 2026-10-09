/* ============================================================
   NPC 编辑器（编辑器内的独立悬浮窗口）
   ------------------------------------------------------------
   · 浮动窗口（复用 .ez-win 外壳，可拖动，单例，Esc 关闭）
   · 左侧 = 关卡里全部 NPC 的列表（＋ 新建 / 删除）；右侧 = 四页表单
       外观：预设 / 衣服色 / 自定义模型 / 阴影 / 变换
       行为：待命 / 跟随玩家（保持距离）/ 巡逻路径点
       交互：交互半径 / 按键 / 提示 / 自动对话 / 可重复
       对话：节点图（节点卡 + 贝塞尔连线 + 分支选项）
   · 所有改动直接写回对象数据并即时在视口生效，进撤销栈
   ============================================================ */
import * as THREE from 'three';
import { el, clear, confirmBox, toast } from '../ui/dom.js';
import { GridSelect, streamAssetOptions, invalidateAssetOptions } from '../ui/grid-picker.js';
import { store } from '../core/storage.js';
import { uid } from '../core/util.js';
import { importAssetFile, refreshAssetManager } from './asset-manager.js';
import { NPC_PRESET_OPTIONS } from '../world/objectTypes.js';
import { removeObjectTree, objectLabel, normalizeDialogue } from '../world/level.js';

let _npcEd = null;

/** 打开 NPC 编辑器（同一时刻只允许一个窗口） */
export function openNpcEditor(ed) {
  if (_npcEd) { _npcEd.close(); _npcEd = null; }
  _npcEd = new NpcEditor(ed);
  return _npcEd;
}

/** 关闭 NPC 编辑器（编辑器退出 / 切关卡时调用） */
export function closeNpcEditor() {
  if (_npcEd) { _npcEd.close(); _npcEd = null; }
}

/** 当前打开的 NPC 编辑器（未打开时为 null，供编辑器主循环每帧驱动） */
export function npcEditor() { return _npcEd; }

const TABS = [
  { k: 'look', l: '外观' },
  { k: 'behave', l: '行为' },
  { k: 'interact', l: '交互' },
  { k: 'dialog', l: '对话' },
];

const BEHAVIORS = [
  { v: 'idle', l: '原地待命' },
  { v: 'follow', l: '跟随玩家' },
  { v: 'patrol', l: '沿路径巡逻' },
];

const KEYS = [
  { v: 'Mouse0', l: '鼠标左键' }, { v: 'KeyE', l: 'E' }, { v: 'KeyF', l: 'F' },
  { v: 'KeyQ', l: 'Q' }, { v: 'KeyR', l: 'R' }, { v: 'Enter', l: '回车' },
];

/* 对话节点图：画布内边距 / 节点最大分支数（与 level.js 的 normalizeDialogue 一致） */
const DLG_PAD = 24;
const DLG_MAX_CHOICES = 8;
const SVG_NS = 'http://www.w3.org/2000/svg';

class NpcEditor {
  constructor(ed) {
    this.ed = ed;
    this.sel = null;          // 当前编辑的 NPC（关卡对象数据）
    this.tab = 'look';
    this._assets = null;      // 素材缓存（模型下拉用）
    this._sig = '';           // 视口选择签名（用于跟随编辑器选中）
    this._build();
  }

  /* ============================================================
     数据
     ============================================================ */
  npcs() {
    const lv = this.ed.level;
    return lv && Array.isArray(lv.objects) ? lv.objects.filter((o) => o.type === 'npc') : [];
  }

  recOf(o) { return (this.ed.builder && o) ? this.ed.builder.objects.get(o.id) : null; }

  _ensureAssets() {
    if (this._assets) return Promise.resolve(this._assets);
    return store.listAssets().then((list) => { this._assets = list || []; return this._assets; })
      .catch(() => { this._assets = []; return this._assets; });
  }

  /** 写回属性：进撤销栈 + 即时刷新视口（并同步属性面板，避免两边显示不一致） */
  _set(label, apply) {
    const ed = this.ed;
    ed.edit(label, () => {
      apply();
      const o = this.sel;
      const rec = o && this.recOf(o);
      if (rec && !rec.disposed) { ed.builder.syncTransform(rec); ed.builder.syncMaterial(rec); }
    }, { props: true });
  }

  /* ============================================================
     窗口骨架
     ============================================================ */
  _build() {
    const win = el('div', { class: 'ez-win npc-win' });
    this.win = win;

    win.appendChild(el('div', { class: 'ez-head' },
      el('span', { class: 'ez-title', text: 'NPC 编辑器' }),
      el('span', { class: 'ez-sub', text: '模型 / 行为 / 交互 / 对话 · 改动即时生效并随关卡保存' }),
      el('button', { class: 'ez-x', text: '✕', title: '关闭（Esc）', onclick: () => this.close() })));

    this.list = el('div', { class: 'npc-list' });
    this.left = el('div', { class: 'npc-left' },
      el('div', { class: 'npc-lhead' },
        el('span', { text: '关卡 NPC' }),
        el('button', {
          class: 'mini', text: '＋ 新建', title: '在玩家出生点附近新建一个 NPC',
          onclick: () => this.addNpc(),
        })),
      this.list);

    this.tabs = el('div', { class: 'npc-tabs' });
    this.form = el('div', { class: 'npc-form' });
    this.right = el('div', { class: 'npc-right' }, this.tabs, this.form);
    win.appendChild(el('div', { class: 'npc-body' }, this.left, this.right));

    this.status = el('span', { class: 'npc-status', text: '' });
    win.appendChild(el('div', { class: 'ez-foot npc-foot' },
      this.status,
      el('button', { class: 'mbtn sm', text: '删除', onclick: () => this.delNpc() }),
      el('button', { class: 'mbtn sm', text: '关闭', onclick: () => this.close() })));

    /* 挂载 + 拖动 */
    const host = document.getElementById('app') || document.body;
    host.appendChild(win);
    const w = win.offsetWidth || 860, h = win.offsetHeight || 600;
    win.style.left = Math.max(8, Math.min(window.innerWidth - w - 12, (window.innerWidth - w) / 2)) + 'px';
    win.style.top = Math.max(8, Math.min(window.innerHeight - h - 12, (window.innerHeight - h) / 2)) + 'px';

    let drag = null;
    const head = win.querySelector('.ez-head');
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
    const stop = () => { drag = null; };
    head.addEventListener('pointerup', stop);
    head.addEventListener('pointercancel', stop);

    // Esc 关窗（挡住编辑器的全局快捷键）；有 #modal（GridSelect 选择器 / 确认框）在显示时交给它处理
    this._onKey = (e) => {
      if (e.code !== 'Escape') return;
      const m = document.getElementById('modal');
      if (m && !m.classList.contains('hidden')) return;
      e.stopPropagation(); e.preventDefault(); this.close();
    };
    window.addEventListener('keydown', this._onKey, true);

    this.refreshList();
  }

  /* ============================================================
     列表
     ============================================================ */
  refreshList() {
    clear(this.list);
    const list = this.npcs();
    if (!this.sel || !list.includes(this.sel)) {
      this.sel = list[0] || null;
      if (this.sel) this.ed.select([this.sel.id]);
    }
    if (!list.length) {
      this.list.appendChild(el('div', { class: 'npc-empty', text: '关卡里还没有 NPC。点「＋ 新建」添加一个。' }));
    }
    for (const o of list) {
      const row = el('div', {
        class: 'npc-item' + (o === this.sel ? ' on' : ''),
        onclick: () => this.pick(o),
      },
      el('span', { class: 'npc-dot', style: { background: o.bodyColor || '#4f6bd8' } }),
      el('span', { class: 'npc-iname', text: o.name || objectLabel(o) }),
      el('span', { class: 'npc-itag', text: this._behaveLabel(o.behavior) }));
      this.list.appendChild(row);
    }
    this.refreshForm();
  }

  _behaveLabel(b) {
    const f = BEHAVIORS.find((x) => x.v === (b || 'idle'));
    return f ? f.l : '待命';
  }

  pick(o) {
    this.sel = o;
    this.ed.select([o.id]);
    this.refreshList();
  }

  /* ============================================================
     新建 / 删除
     ============================================================ */
  addNpc() {
    const ed = this.ed;
    // 放在视野中心附近（相机前方 16 stud），避免落在奇怪的角落
    const cam = (ed.view && ed.view.camera) || (ed.viewport && ed.viewport.camera);
    let pos = [0, 0, 0];
    if (cam && cam.position) {
      const d = cam.getWorldDirection(new THREE.Vector3());
      pos = [
        Math.round(cam.position.x + d.x * 16),
        Math.round(cam.position.y + d.y * 16),
        Math.round(cam.position.z + d.z * 16),
      ];
    }
    const o = ed.spawn('npc', { name: 'NPC ' + (this.npcs().length + 1), position: pos });
    if (!o) return;
    this.sel = o;
    this.refreshList();
    this.setStatus('已新建 NPC，可在右侧编辑外观 / 行为 / 对话');
  }

  async delNpc() {
    const o = this.sel;
    if (!o) return;
    const ok = await confirmBox(`删除「${o.name || objectLabel(o)}」？`, { title: '删除 NPC' });
    if (!ok) return;
    const ed = this.ed;
    ed.edit('删除 NPC', () => {
      removeObjectTree(ed.level, o.id);
      ed.builder.destroyObject(o.id);
      ed.builder.computeBounds();
      ed.selection.delete(o.id);
    }, { tree: true });
    this.sel = null;
    this._sig = '';
    this.refreshList();
    this.setStatus('已删除');
  }

  /* ============================================================
     表单
     ============================================================ */
  refreshForm() {
    clear(this.tabs);
    clear(this.form);
    this._dg = null;
    const o = this.sel;
    for (const t of TABS) {
      this.tabs.appendChild(el('button', {
        class: 'npc-tab' + (t.k === this.tab ? ' on' : ''), type: 'button', text: t.l,
        onclick: () => { this.tab = t.k; this.refreshForm(); },
      }));
    }
    if (!o) {
      this.form.appendChild(el('div', { class: 'npc-empty', text: '先选择或新建一个 NPC。' }));
      this.setStatus('');
      return;
    }
    if (this.tab === 'look') this._formLook(o);
    else if (this.tab === 'behave') this._formBehave(o);
    else if (this.tab === 'interact') this._formInteract(o);
    else this._formDialog(o);
    this.setStatus(`${o.name || objectLabel(o)} · ${o.behavior || 'idle'} · 对话 ${((o.dialogue && o.dialogue.nodes) || []).length} 个节点`);
  }

  setStatus(text) { if (this.status) this.status.textContent = text || ''; }

  /* ---------- 外观 ---------- */
  _formLook(o) {
    const F = this.form;
    F.appendChild(this._sec('基本', [
      this._text('名称', () => o.name || '', (v) => { o.name = v; this.refreshList(); }, '留空则显示为默认标签'),
      this._select('外观预设', () => o.preset || 'classic', (v) => { o.preset = v; this.refreshForm(); },
        NPC_PRESET_OPTIONS, '内置 R6 风格角色；选「自定义模型」时用下面的模型资源'),
      this._color('衣服颜色', () => o.bodyColor || '#4f6bd8', (v) => { o.bodyColor = v; }, '覆盖躯干颜色，头 / 四肢沿用预设配色'),
    ]));

    if ((o.preset || 'classic') === 'custom') {
      F.appendChild(this._sec('自定义模型', [this._assetRow(o)]));
    }

    F.appendChild(this._sec('渲染', [
      this._bool('投射阴影', () => o.castShadow !== false, (v) => { o.castShadow = v; }),
      this._bool('可见', () => o.visible !== false, (v) => { o.visible = v; this._afterVisible(o); }),
      this._bool('冻结（编辑器内不可选中 / 移动）', () => o.frozen === true, (v) => { o.frozen = v; this._afterVisible(o); }),
    ]));

    F.appendChild(this._sec('变换', [
      this._vec('位置', [0, 0, 0], () => o.position || [0, 0, 0], (v) => { o.position = v; }, 0.5),
      this._vec('旋转(度)', [0, 0, 0], () => o.rotation || [0, 0, 0], (v) => { o.rotation = v; }, 5),
      this._vec('缩放', [1, 1, 1], () => o.scale || [1, 1, 1], (v) => { o.scale = v; }, 0.05),
    ]));
  }

  _afterVisible() {
    // 可见 / 冻结只影响对象树的灰显（视口里的 mesh.visible 由 _set 的 syncMaterial 负责）
    this.ed.refreshTree();
  }

  /** 自定义角色模型（.glb / .gltf / .obj）：下拉 + 导入 */
  _assetRow(o) {
    const loader = streamAssetOptions('model', {
      thumbs: false,
      // o.assetId 存裸素材 id，素材选项默认给 'asset:<id>'，这里统一改回裸 id
      map: (a) => ({ ...a, v: a.id }),
      head: [{ v: '', l: '（无：回退到内置 R6）' }],
      missing: (all) => (o.assetId && !all.some((a) => String(a.v) === String(o.assetId)))
        ? { v: o.assetId, l: o.assetId + '（已丢失）' } : null,
    });
    const sel = new GridSelect({
      value: o.assetId || '', options: loader, cls: 'npc-inp',
      onChange: (v) => this._set('修改 NPC 模型', () => { o.assetId = v; }),
    });
    return this._row('模型资源', [
      sel,
      el('button', {
        class: 'mini', text: '＋ 导入', title: '导入 .glb / .gltf / .obj 角色模型',
        onclick: async () => {
          const rec = await importAssetFile('model', { ed: this.ed });
          if (rec) {
            this._assets = null; await this._ensureAssets(); refreshAssetManager();
            invalidateAssetOptions('model');
            sel.setOptions(loader);
            sel.setValue(rec.id);
            this._set('修改 NPC 模型', () => { o.assetId = rec.id; });
          }
        },
      }),
    ], '角色模型的自动缩放按高度对齐到 5 stud（与玩家同高）');
  }

  /* ---------- 行为 ---------- */
  _formBehave(o) {
    const F = this.form;
    F.appendChild(this._sec('行为', [
      this._select('行为模式', () => o.behavior || 'idle', (v) => { o.behavior = v; this.refreshForm(); },
        BEHAVIORS, '跟随 = 沿玩家走过的轨迹保持距离地跟上；巡逻 = 在路径点之间移动'),
      this._num('移动速度(stud/s)', () => Number(o.speed) || 6, (v) => { o.speed = v; }, 0.5, 40, 0.5),
    ]));

    if ((o.behavior || 'idle') === 'follow') {
      F.appendChild(this._sec('跟随', [
        this._num('保持距离(stud)', () => Number(o.followDist) || 7, (v) => { o.followDist = v; }, 1, 80, 0.5,
          '玩家走近到该距离内 NPC 停下，走远后沿其轨迹跟上'),
        this._num('跑动追赶距离(stud)', () => Number(o.followRun) || 18, (v) => { o.followRun = v; }, 1, 200, 1,
          '与玩家距离超过该值时加速追赶'),
        this._bool('停下时面向玩家', () => o.facePlayer !== false, (v) => { o.facePlayer = v; }),
      ]));
    } else if ((o.behavior || 'idle') === 'patrol') {
      F.appendChild(this._sec('巡逻路径', [this._waypoints(o)]));
      F.appendChild(this._sec('', [
        this._bool('巡逻循环', () => o.patrolLoop !== false, (v) => { o.patrolLoop = v; }, '关闭 = 走到终点后停下'),
      ]));
    } else {
      F.appendChild(this._sec('', [
        el('div', { class: 'npc-hint', text: '「原地待命」的 NPC 不会移动，只做待机呼吸动作，仍可交互对话。' }),
      ]));
    }
  }

  /** 巡逻路径点编辑器（世界坐标） */
  _waypoints(o) {
    const wrap = el('div', { class: 'npc-wps' });
    const list = Array.isArray(o.waypoints) ? o.waypoints : (o.waypoints = []);
    const rebuild = () => { this.refreshForm(); };

    list.forEach((wp, i) => {
      const row = el('div', { class: 'npc-wp' });
      row.appendChild(el('span', { class: 'npc-wpidx', text: String(i + 1) }));
      for (let k = 0; k < 3; k++) {
        const inp = el('input', {
          class: 'npc-num', type: 'number', step: 0.5, value: Number(wp[k]) || 0,
          onchange: () => {
            const v = Number(inp.value) || 0;
            this._set('修改巡逻路径点', () => { list[i][k] = v; });
          },
        });
        row.appendChild(inp);
      }
      row.appendChild(el('button', {
        class: 'mini', text: '↑', title: '上移', disabled: i === 0,
        onclick: () => { this._set('调整巡逻路径点', () => { const t = list[i - 1]; list[i - 1] = list[i]; list[i] = t; }); rebuild(); },
      }));
      row.appendChild(el('button', {
        class: 'mini', text: '✕', title: '删除该点',
        onclick: () => { this._set('删除巡逻路径点', () => { list.splice(i, 1); }); rebuild(); },
      }));
      wrap.appendChild(row);
    });

    wrap.appendChild(el('div', { class: 'npc-wpbtns' },
      el('button', {
        class: 'mini', text: '＋ 添加点（用 NPC 当前位置）',
        onclick: () => {
          this._set('添加巡逻路径点', () => {
            list.push([Math.round(o.position?.[0] || 0), Math.round(o.position?.[1] || 0), Math.round(o.position?.[2] || 0)]);
          });
          rebuild();
        },
      })));
    if (list.length < 2) {
      wrap.appendChild(el('div', { class: 'npc-hint', text: '至少需要 2 个路径点才会开始巡逻（少于 2 个时 NPC 原地不动）。' }));
    }
    return wrap;
  }

  /* ---------- 交互 ---------- */
  _formInteract(o) {
    this.form.appendChild(this._sec('交互', [
      this._num('交互半径(stud)', () => Number(o.interactRange) || 8, (v) => { o.interactRange = v; }, 1, 60, 0.5,
        '玩家进入该范围会出现交互提示'),
      this._select('交互按键', () => o.interactKey || 'Mouse0', (v) => { o.interactKey = v; }, KEYS),
      this._text('提示文字', () => o.promptText || '', (v) => { o.promptText = v; }, '显示在准星提示里的动作名'),
      this._bool('靠近自动对话', () => o.autoTalk === true, (v) => { o.autoTalk = v; }, '开启后进入范围自动开始对话，无需按键'),
      this._bool('可重复对话', () => o.talkRepeat !== false, (v) => { o.talkRepeat = v; }, '关闭后该 NPC 只对话一次'),
      this._eventRow(o),
    ]));
    this.form.appendChild(this._sec('', [
      el('div', { class: 'npc-hint', text: '对话时玩家移动被临时冻结；节点有「分支选项」时用 ↑↓ / 数字键 / 左键选择，没有分支时按左键 / 空格继续，Esc 结束。' }),
    ]));
  }

  /** 对话触发事件（下拉选择关卡事件） */
  _eventRow(o) {
    const events = (this.ed.level && this.ed.level.events) || [];
    const opts = [{ v: '', l: '（不触发）' }].concat(events.map((ev) => ({ v: ev.id, l: ev.name || ev.id })));
    const sel = new GridSelect({
      value: o.onTalk || '', options: opts, cls: 'npc-inp',
      onChange: (v) => this._set('修改 NPC 触发事件', () => { o.onTalk = v; }),
    });
    return this._row('对话触发事件', [sel], '每次开始与玩家对话时触发（开门 / 给道具 / 播音效…）');
  }

  /* ---------- 对话（节点图） ---------- */
  _formDialog(o) {
    const g = normalizeDialogue(o.dialogue);
    o.dialogue = g;
    const F = this.form;

    F.appendChild(this._sec('说话人', [
      this._text('对话显示名', () => o.speakerName || '', (v) => { o.speakerName = v; }, '留空则使用 NPC 名称；节点里单独填了说话人时以节点为准'),
    ]));

    /* 条件判断说明（默认收起，点「条件 ?」展开） */
    const help = el('div', { class: 'dlg-help', style: { display: 'none' } },
      el('b', { text: '选项的「条件」怎么用（变量名判断）' }),
      el('div', { text: '· 留空 = 该选项总是显示；填一个变量名（如 has_key）= 只有当这个变量为「真」时才出现。' }),
      el('div', { text: '· 变量由事件动作「设置变量」（setVariable）写入，脚本块 / 数组 / 随机数块也能写。' }),
      el('div', { text: '· 判定为真：数字 ≠ 0；非空数组；非空字符串（"0" 和 "false" 算假）。没被赋过值的变量等于 0 → 不显示。' }),
      el('div', { text: '· 例：玩家拿到钥匙时用「设置变量」把 has_key 设为 1，节点里那个条件填 has_key 的选项才会出现。' }));

    const head = el('div', { class: 'dlg-bar' },
      el('span', { class: 'dlg-count', text: '' }),
      el('button', { class: 'mini', text: '＋ 新节点', title: '在图里空白处双击也可以新建', onclick: () => this._dlgAdd() }),
      el('button', { class: 'mini', text: '↺ 整理布局', title: '按分支深度重新排列所有节点', onclick: () => this._dlgLayout(true) }),
      el('button', {
        class: 'mini', text: '条件 ?', title: '分支选项的条件变量怎么写',
        onclick: () => { help.style.display = help.style.display === 'none' ? '' : 'none'; },
      }));
    const wrap = el('div', { class: 'npc-dlgwrap' });
    const canvas = el('div', { class: 'dlg-canvas' });
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'dlg-svg');
    canvas.appendChild(svg);
    wrap.appendChild(canvas);

    F.appendChild(el('div', { class: 'npc-sec' },
      el('div', { class: 'npc-sech', text: '对话图（节点 / 分支选项）' }),
      el('div', { class: 'npc-secb' },
        head,
        wrap,
        help,
        el('div', { class: 'npc-hint', text: '拖动节点标题可移动 · 从右侧圆点拖到另一个节点左侧圆点即可连线（右键圆点断开）· 有分支选项时玩家用 ↑↓ / 数字键 / 左键选择 · 选项的「条件变量」填变量名，为真时才显示' }))));

    this._dg = { o, g, wrap, canvas, svg, head, cards: new Map(), ports: new Map() };

    wrap.addEventListener('dblclick', (e) => {
      if (e.target.closest('.dlg-node')) return;
      const r = canvas.getBoundingClientRect();
      this._dlgAdd(Math.round((e.clientX - r.left - DLG_PAD) / 20) * 20, Math.round((e.clientY - r.top - DLG_PAD) / 20) * 20);
    });

    /* 位置全是 (0,0) 的对话图（手写 / 导入的数据）先摆一遍 */
    if (g.nodes.length > 1 && !g.nodes.some((n) => n.x || n.y)) this._dlgLayout(false);
    this._dlgRender();
  }

  /* ---------- 节点图：渲染 ---------- */
  _dlgRender() {
    const DG = this._dg;
    if (!DG) return;
    for (const c of DG.cards.values()) c.remove();
    DG.cards.clear();
    DG.ports.clear();
    for (const n of DG.g.nodes) {
      const card = this._dlgCard(n);
      DG.cards.set(n.id, card);
      DG.canvas.appendChild(card);
    }
    this._dlgSize();
    this._dlgDraw();
    const cnt = DG.head.querySelector('.dlg-count');
    if (cnt) {
      const ei = DG.g.nodes.findIndex((n) => n.id === DG.g.entry);
      cnt.textContent = `${DG.g.nodes.length} 个节点 · 入口 ${ei >= 0 ? '#' + (ei + 1) : '未设'}`;
    }
    /* 窗口刚插入时容器可能还没布局完（端口矩形为 0，连线会退化成点），下一帧按真实尺寸重画一次 */
    requestAnimationFrame(() => {
      if (this._dg !== DG) return;
      this._dlgSize();
      this._dlgDraw();
    });
  }

  /** 画布尺寸按节点包围盒撑开（节点可拖到画布任意位置） */
  _dlgSize() {
    const DG = this._dg;
    if (!DG) return;
    let w = 360, h = 260;
    for (const c of DG.cards.values()) {
      w = Math.max(w, (Number(c.dataset.x) || 0) + c.offsetWidth + DLG_PAD * 2);
      h = Math.max(h, (Number(c.dataset.y) || 0) + c.offsetHeight + DLG_PAD * 2);
    }
    DG.canvas.style.width = w + 'px';
    DG.canvas.style.height = h + 'px';
    DG.svg.setAttribute('width', String(w));
    DG.svg.setAttribute('height', String(h));
  }

  /** 端口中心（画布坐标系） */
  _dlgPortPt(portEl) {
    const DG = this._dg;
    if (!DG || !portEl) return null;
    const r = portEl.getBoundingClientRect();
    const c = DG.canvas.getBoundingClientRect();
    return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
  }

  /** 重画全部连线（next 实线 / 分支虚线） */
  _dlgDraw() {
    const DG = this._dg;
    if (!DG) return;
    clear(DG.svg);
    const pt = (key) => this._dlgPortPt(DG.ports.get(key));
    const add = (a, b, cls) => {
      if (!a || !b) return;
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + 50} ${a.y}, ${b.x - 50} ${b.y}, ${b.x} ${b.y}`);
      p.setAttribute('class', 'dlg-link' + (cls ? ' ' + cls : ''));
      DG.svg.appendChild(p);
    };
    for (const n of DG.g.nodes) {
      if (n.next) add(pt(n.id + ':next'), pt(n.next + ':in'));
      (n.choices || []).forEach((c, i) => { if (c.to) add(pt(n.id + ':c' + i), pt(c.to + ':in'), 'branch'); });
    }
  }

  /* ---------- 节点卡 ---------- */
  _dlgCard(n) {
    const DG = this._dg;
    const card = el('div', { class: 'dlg-node' + (DG.g.entry === n.id ? ' entry' : '') });
    card.dataset.id = n.id;
    card.dataset.x = String(n.x);
    card.dataset.y = String(n.y);
    card.style.left = (n.x + DLG_PAD) + 'px';
    card.style.top = (n.y + DLG_PAD) + 'px';

    /* 标题行：序号 + 说话人 + 删除（兼作拖动把手） */
    const head = el('div', { class: 'dlg-hhead' });
    head.appendChild(el('span', { class: 'dlg-idx', text: '#' + (DG.g.nodes.indexOf(n) + 1) }));
    const spk = el('input', { class: 'dlg-inp', value: n.speaker || '', placeholder: '说话人' });
    spk.addEventListener('pointerdown', (e) => e.stopPropagation());
    spk.addEventListener('change', () => { const v = spk.value; this._set('修改对话说话人', () => { n.speaker = v; }); });
    head.appendChild(spk);
    head.appendChild(el('button', { class: 'dlg-x', text: '✕', title: '删除该节点', onclick: () => this._dlgDel(n) }));
    card.appendChild(head);

    /* 台词 */
    const ta = el('textarea', { class: 'dlg-inp dlg-ta', value: n.text || '', placeholder: '台词内容…' });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('change', () => { const v = ta.value; this._set('修改对话台词', () => { n.text = v; }); });
    card.appendChild(ta);

    /* 分支选项 */
    const cbox = el('div', { class: 'dlg-choices' });
    (n.choices || []).forEach((c, i) => cbox.appendChild(this._dlgChoiceRow(n, c, i)));
    if (n.choices && n.choices.length) card.appendChild(cbox);

    /* 底部按钮 */
    card.appendChild(el('div', { class: 'dlg-foot' },
      el('button', {
        class: 'mini', text: '＋ 分支', title: '添加一个玩家可选的对话选项（最多 8 个）',
        onclick: () => this._dlgAddChoice(n),
      }),
      el('button', {
        class: 'mini' + (DG.g.entry === n.id ? ' on' : ''), text: DG.g.entry === n.id ? '★ 入口' : '☆ 入口',
        title: '把该节点设为对话入口（对话从这里开始）',
        onclick: () => this._dlgSetEntry(n),
      }),
      el('button', { class: 'mini', text: '⧉', title: '复制节点', onclick: () => this._dlgDup(n) }),
      el('button', { class: 'mini', text: '断开', title: '清除该节点的全部出边', onclick: () => this._dlgUnlink(n, null) })));

    /* 端口：左侧入 / 右侧出 */
    const inP = el('div', { class: 'dlg-port in', title: '输入口：从别的节点连过来' });
    const outP = el('div', { class: 'dlg-port out', title: '输出口：拖到目标节点左侧圆点 = 继续' });
    card.appendChild(inP);
    card.appendChild(outP);
    DG.ports.set(n.id + ':in', inP);
    DG.ports.set(n.id + ':next', outP);
    if (n.next) outP.classList.add('on');
    this._dlgWire(n, { t: 'next' }, outP);
    if (n.choices && n.choices.length) outP.classList.add('off');

    /* 拖动节点 */
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, textarea')) return;
      const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
      let moved = false;
      const move = (ev) => {
        moved = true;
        n.x = Math.max(0, Math.round(ox + (ev.clientX - sx)));
        n.y = Math.max(0, Math.round(oy + (ev.clientY - sy)));
        card.dataset.x = String(n.x);
        card.dataset.y = String(n.y);
        card.style.left = (n.x + DLG_PAD) + 'px';
        card.style.top = (n.y + DLG_PAD) + 'px';
        this._dlgSize();
        this._dlgDraw();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (!moved) return;
        const nx = n.x, ny = n.y;
        n.x = ox; n.y = oy;                       // 还原后提交，撤销记到拖动前的值
        this._set('移动对话节点', () => { n.x = nx; n.y = ny; });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    });
    return card;
  }

  /** 一行分支选项：口 + 选项文字 + 条件 + 删除 */
  _dlgChoiceRow(n, c, i) {
    const DG = this._dg;
    const r = el('div', { class: 'dlg-choice' + (c.to ? ' linked' : '') });
    const port = el('div', { class: 'dlg-port out cport', title: '拖到目标节点左侧圆点 = 选择后跳转（右键断开）' });
    const txt = el('input', { class: 'dlg-inp', value: c.text || '', placeholder: '选项文字' });
    const cond = el('input', { class: 'dlg-inp dlg-cond', value: c.cond || '', placeholder: '条件', title: '变量名：为真时才显示该选项（留空 = 总是显示）' });
    txt.addEventListener('pointerdown', (e) => e.stopPropagation());
    cond.addEventListener('pointerdown', (e) => e.stopPropagation());
    txt.addEventListener('change', () => { const v = txt.value; this._set('修改分支选项', () => { c.text = v; }); });
    cond.addEventListener('change', () => { const v = cond.value.slice(0, 40); this._set('修改分支条件', () => { c.cond = v; }); });
    r.appendChild(port);
    r.appendChild(txt);
    r.appendChild(cond);
    r.appendChild(el('button', { class: 'dlg-x sm', text: '✕', title: '删除该选项', onclick: () => this._dlgDelChoice(n, i) }));
    DG.ports.set(n.id + ':c' + i, port);
    this._dlgWire(n, { t: 'choice', i }, port);
    return r;
  }

  /** 端口交互：拖拽连线 / 右键断开 */
  _dlgWire(n, kind, outP) {
    if (!outP) return;
    outP.addEventListener('pointerdown', (e) => this._dlgBeginLink(n, kind, outP, e));
    outP.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      this._dlgUnlink(n, kind);
    });
  }

  /** 从某个输出口拖线到目标节点 */
  _dlgBeginLink(n, kind, portEl, e) {
    const DG = this._dg;
    if (!DG) return;
    if (kind.t === 'next' && (n.choices || []).length) {
      toast('该节点已有分支选项：请从选项行右侧的圆点连线', 'warn');
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const from = this._dlgPortPt(portEl);
    if (!from) return;
    const ghost = document.createElementNS(SVG_NS, 'path');
    ghost.setAttribute('class', 'dlg-link temp');
    DG.svg.appendChild(ghost);
    let hit = null;
    const setHit = (id) => {
      if (hit === id) return;
      const old = hit && DG.cards.get(hit);
      if (old) old.classList.remove('drop');
      hit = id;
      const now = hit && DG.cards.get(hit);
      if (now) now.classList.add('drop');
    };
    const move = (ev) => {
      const r = DG.canvas.getBoundingClientRect();
      const p = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      ghost.setAttribute('d', `M ${from.x} ${from.y} C ${from.x + 50} ${from.y}, ${p.x - 50} ${p.y}, ${p.x} ${p.y}`);
      const elm = document.elementFromPoint(ev.clientX, ev.clientY);
      const card = elm && elm.closest ? elm.closest('.dlg-node') : null;
      setHit(card && card.dataset.id !== n.id ? card.dataset.id : null);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost.remove();
      const to = hit;                     // 先取出落点，再清高亮（setHit 会把 hit 置空）
      setHit(null);
      if (!to) { this._dlgDraw(); return; }
      if (kind.t === 'next') {
        this._set('连接对话节点', () => { n.next = to; });
      } else {
        const c = (n.choices || [])[kind.i];
        if (!c) { this._dlgDraw(); return; }
        this._set('连接分支选项', () => { c.to = to; });
      }
      this._dlgRender();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ---------- 节点图：增删改 ---------- */
  _dlgAdd(x, y) {
    const DG = this._dg;
    if (!DG) return;
    const g = DG.g;
    let nx = x, ny = y;
    if (nx === undefined || ny === undefined) {
      nx = 30;
      ny = 0;
      for (const n of g.nodes) ny = Math.max(ny, n.y + 200);
    }
    const node = { id: uid('d'), x: Math.max(0, nx), y: Math.max(0, ny), speaker: '', text: '', next: '', choices: [] };
    this._set('添加对话节点', () => {
      g.nodes.push(node);
      if (!g.entry) g.entry = node.id;
    });
    this._dlgRender();
    const card = DG.cards.get(node.id);
    if (card) { const ta = card.querySelector('textarea'); if (ta) ta.focus(); }
  }

  _dlgDup(n) {
    const DG = this._dg;
    if (!DG) return;
    const cp = {
      id: uid('d'), x: n.x + 40, y: n.y + 40, speaker: n.speaker, text: n.text, next: n.next,
      choices: (n.choices || []).map((c) => ({ text: c.text, to: c.to, cond: c.cond })),
    };
    this._set('复制对话节点', () => { DG.g.nodes.push(cp); });
    this._dlgRender();
  }

  _dlgDel(n) {
    const DG = this._dg;
    if (!DG) return;
    const g = DG.g;
    this._set('删除对话节点', () => {
      const i = g.nodes.indexOf(n);
      if (i >= 0) g.nodes.splice(i, 1);
      for (const x of g.nodes) {
        if (x.next === n.id) x.next = '';
        for (const c of x.choices || []) if (c.to === n.id) c.to = '';
      }
      if (g.entry === n.id) g.entry = g.nodes.length ? g.nodes[0].id : '';
    });
    this._dlgRender();
  }

  _dlgSetEntry(n) {
    const DG = this._dg;
    if (!DG) return;
    if (DG.g.entry === n.id) return;
    this._set('设置对话入口', () => { DG.g.entry = n.id; });
    this._dlgRender();
  }

  _dlgAddChoice(n) {
    const DG = this._dg;
    if (!DG) return;
    if ((n.choices || []).length >= DLG_MAX_CHOICES) { toast(`一个节点最多 ${DLG_MAX_CHOICES} 个分支选项`, 'warn'); return; }
    this._set('添加分支选项', () => {
      if (!Array.isArray(n.choices)) n.choices = [];
      // 选项文字留空会在存档规范化时被丢弃，这里给个占位文字，免得刚连好线就消失
      n.choices.push({ text: '选项' + (n.choices.length + 1), to: '', cond: '' });
      if (n.choices.length === 1) n.next = '';   // 有分支后不再自动「继续」
    });
    this._dlgRender();
  }

  _dlgDelChoice(n, i) {
    const DG = this._dg;
    if (!DG) return;
    this._set('删除分支选项', () => { (n.choices || []).splice(i, 1); });
    this._dlgRender();
  }

  /** kind = null：清掉全部出边；{t:'next'}：清「继续」；{t:'choice',i}：清某个分支 */
  _dlgUnlink(n, kind) {
    const DG = this._dg;
    if (!DG) return;
    this._set('断开对话连线', () => {
      if (!kind) {
        n.next = '';
        for (const c of n.choices || []) c.to = '';
        return;
      }
      if (kind.t === 'next') n.next = '';
      else if ((n.choices || [])[kind.i]) n.choices[kind.i].to = '';
    });
    this._dlgRender();
  }

  /** 按分支深度分层排列（commit = 记一条撤销） */
  _dlgLayout(commit) {
    const DG = this._dg;
    if (!DG) return;
    const g = DG.g;
    const nodes = g.nodes;
    if (!nodes.length) return;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const start = byId.has(g.entry) ? g.entry : nodes[0].id;
    const depth = new Map([[start, 0]]);
    const queue = [start];
    let maxD = 0;
    while (queue.length) {
      const id = queue.shift();
      const n = byId.get(id);
      if (!n) continue;
      const d = depth.get(id);
      maxD = Math.max(maxD, d);
      for (const t of [n.next].concat((n.choices || []).map((c) => c.to))) {
        if (!t || !byId.has(t) || depth.has(t)) continue;
        depth.set(t, d + 1);
        queue.push(t);
      }
    }
    for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, maxD + 1);   // 未被引用的节点排到最后
    const colRow = new Map();
    const pos = [];
    for (const n of nodes) {                       // 同层按原顺序（sort 稳定），保持可预期
      const col = depth.get(n.id);
      const row = colRow.get(col) || 0;
      colRow.set(col, row + 1);
      pos.push([n, 30 + col * 280, 24 + row * 220]);
    }
    if (commit) this._set('整理对话布局', () => { for (const [n, x, y] of pos) { n.x = x; n.y = y; } });
    else for (const [n, x, y] of pos) { n.x = x; n.y = y; }
    if (commit) this._dlgRender();
  }

  /* ============================================================
     控件工厂
     ============================================================ */
  _sec(title, rows) {
    const parts = [];
    if (title) parts.push(el('div', { class: 'npc-sech', text: title }));
    parts.push(el('div', { class: 'npc-secb' }, rows));
    return el('div', { class: 'npc-sec' }, parts);
  }

  _row(label, ctl, hint) {
    return el('div', { class: 'npc-row', title: hint || '' },
      el('span', { class: 'npc-lab', text: label }),
      el('div', { class: 'npc-ctl' }, ctl));
  }

  _num(label, get, set, min, max, step, hint) {
    const clampV = (v) => Math.min(max, Math.max(min, Number(v) || 0));
    const val = clampV(get());
    const rng = el('input', { class: 'npc-rng', type: 'range', min, max, step, value: val });
    const num = el('input', { class: 'npc-num', type: 'number', min, max, step, value: val });

    const live = (n) => {
      const o = this.sel;
      if (!o) return;
      set(n);
      const rec = this.recOf(o);
      if (rec && !rec.disposed) this.ed.builder.syncTransform(rec);
    };

    // 拖动时即时改数据（不入栈），松手才记一次撤销：先还原到拖动前的值，再走带撤销的提交
    let dragFrom = null;
    rng.addEventListener('pointerdown', () => { dragFrom = clampV(get()); });
    rng.addEventListener('input', () => {
      const n = clampV(rng.value);
      num.value = String(n);
      live(n);
    });
    rng.addEventListener('change', () => {
      const n = clampV(rng.value);
      const from = dragFrom != null ? dragFrom : clampV(get());
      dragFrom = null;
      num.value = String(n);
      set(from);
      this._set('修改 NPC 属性', () => set(n));
    });
    num.addEventListener('change', () => {
      const n = clampV(num.value);
      num.value = String(n); rng.value = String(n);
      this._set('修改 NPC 属性', () => set(n));
    });
    return this._row(label, [rng, num], hint);
  }

  _color(label, get, set, hint) {
    const inp = el('input', { class: 'npc-col', type: 'color', value: get() });
    inp.addEventListener('change', () => { const v = inp.value; this._set('修改 NPC 颜色', () => set(v)); });
    return this._row(label, inp, hint);
  }

  _bool(label, get, set, hint) {
    const on = !!get();
    const btn = el('button', {
      class: 'npc-tgl' + (on ? ' on' : ''), type: 'button', text: on ? '开' : '关',
      onclick: () => {
        const next = !btn.classList.contains('on');
        btn.classList.toggle('on', next);
        btn.textContent = next ? '开' : '关';
        this._set('修改 NPC 开关', () => set(next));
      },
    });
    return this._row(label, btn, hint);
  }

  _select(label, get, set, options, hint) {
    const sel = new GridSelect({
      value: get(), options, cls: 'npc-inp',
      onChange: (v) => this._set('修改 NPC 属性', () => set(v)),
    });
    return this._row(label, sel, hint);
  }

  _text(label, get, set, hint) {
    const inp = el('input', { class: 'npc-inp', value: get() });
    inp.addEventListener('change', () => { const v = inp.value; this._set('修改 NPC 文本', () => set(v)); });
    return this._row(label, inp, hint);
  }

  _vec(label, def, get, set, step) {
    const cur = get() || def;
    const inputs = [];
    for (let i = 0; i < 3; i++) {
      inputs.push(el('input', {
        class: 'npc-num', type: 'number', step, value: Number(cur[i]) || 0,
        onchange: () => {
          const v = inputs.map((x) => Number(x.value) || 0);
          this._set('修改 NPC ' + label, () => set(v));
        },
      }));
    }
    return this._row(label, inputs, 'X / Y / Z');
  }

  /* ============================================================
     与编辑器选择同步
     ============================================================ */
  update() {
    // 撤销 / 重做会整体重建 level.objects，这里按 id 重新绑定，避免继续编辑已废弃的对象
    if (this.sel && Array.isArray(this.ed.level.objects) && !this.ed.level.objects.includes(this.sel)) {
      const id = this.sel.id;
      this.sel = this.ed.level.objects.find((o) => o.type === 'npc' && o.id === id) || null;
      this._sig = '';
      this.refreshList();
      return;
    }
    const ids = this.ed.selection;
    const sig = [...ids].join(',');
    if (sig === this._sig) return;
    this._sig = sig;
    const first = ids.size ? this.ed.builder.objects.get([...ids][0]) : null;
    const o = first && first.o && first.o.type === 'npc' ? first.o : null;
    if (o && o !== this.sel) { this.sel = o; this.refreshList(); }
  }

  /* ============================================================
     关闭
     ============================================================ */
  close() {
    window.removeEventListener('keydown', this._onKey, true);
    if (this.win && this.win.parentNode) this.win.parentNode.removeChild(this.win);
    if (_npcEd === this) _npcEd = null;
  }
}
