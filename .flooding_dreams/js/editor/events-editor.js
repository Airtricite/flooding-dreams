/* ============================================================
   事件编辑器：事件列表 + 节点画布（触发 → 动作链）+ 属性表单
   节点布局只保存在内存中（不写入关卡数据）
   ============================================================ */
import { el, clear, toast, promptBox, modal } from '../ui/dom.js';
import {
  ACTION_TYPES, TRIGGER_TYPES, EASINGS, PLAYER_FIELDS, MORPH_SOURCES,
  OBJECT_PROPS_FOR_EVENTS, SOUNDS, TOOL_DEFS, BUILTIN_SKIES,
  outsOf, insOf, valueOutsOf, isValueOnly, exposableOf, inputKeysOf,
  FIELD_LABELS, OBJECT_POS_MODES, MATH_VARS, RAY_FROM_MODES, RAY_TO_MODES,
} from '../config.js';
import { createEvent, createAction, OP_OPTIONS } from '../world/events.js';
import { formulaError } from '../world/formula.js';
import { scriptError } from '../world/worldapi.js';
import { openCodeWindow } from './code-window.js';
import { objectOptions, optSelect, popover, contextMenu, row, objRefButton } from './widgets.js';
import { GridSelect, streamAssetOptions, invalidateAssetOptions } from '../ui/grid-picker.js';
import { getObject, objectLabel, normalizeDialogue } from '../world/level.js';
import { uid } from '../core/util.js';
import { store } from '../core/storage.js';
import { audio } from '../core/audio.js';
import { importAssetFile } from './asset-manager.js';
import { openSkyLab } from './sky-lab.js';
import { presetOptions, PLAYER_PRESETS } from '../player/avatar.js';

let _audioAssets = [];        // 音频素材缓存（事件动作里的「播放音频文件」用）
let _modelAssets = [];        // 模型素材缓存（事件动作里的「玩家 morph」用）
let _skyAssets = [];          // 贴图素材缓存（事件动作里的「天空球渐变」用）

const EFFECTS = [
  { v: 'splash', l: '水花' }, { v: 'burst', l: '爆裂' },
  { v: 'sparkle', l: '闪光' }, { v: 'hit', l: '撞击' },
];
/* 顶部提示样式（对应 HUD 的 .nt-info / .nt-warn / .nt-error / .nt-success） */
const NOTICE_KINDS = [
  { v: 'info', l: '信息' }, { v: 'warn', l: '警告' },
  { v: 'error', l: '错误' }, { v: 'success', l: '成功' },
];
/* NPC 行为模式（与 objectTypes.js 里 npc.behavior 的取值保持一致） */
const NPC_BEHAVIORS = [
  { v: 'idle', l: '原地待命' },
  { v: 'follow', l: '跟随玩家' },
  { v: 'patrol', l: '沿路径巡逻' },
];
/* NPC 下拉：只列关卡里的 npc 对象 */
const npcOptions = (lv) => [{ v: '', l: '（未指定）' }].concat(objectOptions(lv, (o) => o.type === 'npc'));
/* 对话节点摘要（下拉里显示「说话人：台词…」） */
const dlgPreview = (g, id) => {
  const n = (g.nodes || []).find((x) => x.id === id);
  if (!n) return '（空）';
  const t = String(n.text || '').replace(/\s+/g, ' ').slice(0, 14);
  return (n.speaker ? n.speaker + '：' : '') + (t || '（空台词）');
};

const NODE_W = 196;
const GAP_X = 38;
const PAD = 20;
const PORT_Y = 20;          // 端口相对节点顶部的偏移
const PORT_GAP = 22;        // 多个输出槽 / 值输入口的竖排间距
const ROW_H = 84;           // 自动布局时同层节点的堆叠高度
const DEF_H = 52;           // 量不到高度时的兜底
const TRIG_ID = '\u0000trigger';   // 触发节点的伪 id（只用于连线与布局）

/* 「选择动作类型」面板里的补充说明（新类型的语义提示） */
const PICK_HINTS = {
  ifBlock: '按「满足 / 否则如果 / 否则」分出多条支路',
  mathExpr: '八操作数 a~w + 公式，纯值块（拉取求值）',
  readVar: '读取变量并输出值，纯值块（无执行口）',
  wait: '等待 N 秒，或等待直到接口收到 true',
  createObject: '以关卡已有对象为模板新建一份',
  cloneObject: '复制某个对象的当前运行态数据',
  setParent: '把对象挂到另一个对象下作为子级',
  script: '写一段 JS，能读写世界的一切（可用 await wait(秒) 暂停流程；失焦或 Ctrl+Enter 才落盘）',
  evalExpr: '一段 JS 表达式，结果作为值输出，可接到别的口',
  raycast: '从一点向另一点 / 某方向打一条射线，结果写进变量',
  getProperty: '按路径读取对象的任意字段（支持 rec. 运行时记录）',
  skyCrossfade: '从 A 天空慢慢淡入到 B 天空（内置天空 / 导入的全景图素材均可）',
};

function vecStr(v) {
  return '[' + (v || [0, 0, 0]).map((n) => Math.round(Number(n) * 100) / 100).join(', ') + ']';
}
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
function objName(level, id) {
  const o = id ? getObject(level, id) : null;
  return o ? objectLabel(o) : (id ? '（已删除）' : '未指定对象');
}
/** 音频引用 → 显示名 */
function audioName(ref) {
  if (ref.startsWith('asset:')) {
    const a = _audioAssets.find((x) => x.id === ref.slice(6));
    return a ? a.name : '音频素材';
  }
  return ref.length > 26 ? ref.slice(0, 26) + '…' : ref;
}
/** 模型素材 id → 显示名 */
function modelName(id) {
  if (!id) return '（未选择）';
  const a = _modelAssets.find((x) => x.id === id);
  return a ? a.name : '模型素材';
}

/** 天空引用 → 显示名（内置天空 / 全景图素材 / 无 / 沿用当前） */
function skyName(id) {
  if (!id) return '（沿用当前天空）';
  if (id === 'none') return '无（纯色背景）';
  const b = BUILTIN_SKIES.find((x) => x.id === id);
  if (b) return b.label;
  if (id.startsWith('asset:')) {
    const a = _skyAssets.find((x) => x.id === id.slice(6));
    return a ? a.name : '全景图素材';
  }
  return id;
}

/** 皮肤徽标文案（挂在模型素材上的皮肤 / 挂件） */
function skinTag(skin) {
  const n = ((skin && skin.accessories) || []).length;
  return n ? '✓皮肤+挂件' : '✓皮肤';
}

/**
 * morph 可选模型：本关素材池 + 全局素材池。
 * 「角色皮肤编辑器」在主菜单导入 / 打包还原的角色都落在全局池，只有列进来才选得到。
 * 排序：本关素材在前，带皮肤的在前。
 */
function morphModelList(all, lvId) {
  const list = (all || []).filter((x) => x.kind === 'model'
    && ((x.level || '') === '' || (x.level || '') === (lvId || '')));
  list.sort((p, q) => {
    const lp = (p.level || '') === lvId ? 0 : 1;
    const lq = (q.level || '') === lvId ? 0 : 1;
    if (lp !== lq) return lp - lq;
    const sp = p.skin ? 0 : 1;
    const sq = q.skin ? 0 : 1;
    if (sp !== sq) return sp - sq;
    return String(p.name || '').localeCompare(String(q.name || ''));
  });
  return list;
}

export class EventsEditor {
  constructor(ed) {
    this.ed = ed;
    this.level = () => ed.level;
    this.cur = null;              // 当前事件 id
    this.sel = null;              // { kind:'trigger'|'action', i:number }
    this.pos = new Map();         // nodeKey -> {x,y}：只记「手工拖过」的位置（不落库）
    this.nodeMap = new Map();      // actionId -> 节点元素
    this.trigNode = null;         // 触发节点元素
    this.tall = false;

    /* ---------- 结构 ---------- */
    this.el = el('div', { class: 'ev' });

    this.listItems = el('div', { class: 'ev-items' });
    const list = el('div', { class: 'ev-list' },
      el('div', { class: 'ev-list-h' },
        el('button', { class: 'mini', text: '＋ 事件', title: '新建事件', onclick: () => this.addEvent() }),
        el('button', { class: 'mini', text: '⤢', title: '放大面板', onclick: () => this.toggleTall() })),
      this.listItems);

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'ev-svg');
    this.pad = el('div', { class: 'ev-pad' }, this.svg);
    const canvas = el('div', { class: 'ev-canvas' }, this.pad);

    this.insp = el('div', { class: 'ev-insp' });

    /* 画布角落工具条（自动整理） */
    this.toolbar = el('div', { class: 'ev-toolbar' },
      el('button', { class: 'mini', text: '⤢ 自动整理', title: '把所有「没有手工位置」的节点分层排开', onclick: () => this.autoArrange() }));

    this.el.appendChild(list);
    this.el.appendChild(canvas);
    this.el.appendChild(this.insp);
    this.el.appendChild(this.toolbar);

    this._bindPad();
    this.refresh();
  }

  onShow() { this.refresh(); requestAnimationFrame(() => this._drawLines()); }

  toggleTall() {
    this.tall = !this.tall;
    const bot = document.getElementById('ed-bottom');
    if (bot) bot.classList.toggle('tall', this.tall);
    requestAnimationFrame(() => this._drawLines());
  }

  /* ============================================================
     事件增删
     ============================================================ */
  addEvent() {
    const ed = this.ed;
    const lv = ed.level;
    if (!lv) return;
    const ev = createEvent('事件 ' + ((lv.events || []).length + 1));
    ed.edit('新建事件', () => { lv.events.push(ev); }, {});
    this.cur = ev.id;
    this.sel = { kind: 'trigger' };
    this.refresh();
    ed.log('新建事件：' + ev.name, 'ok');
  }

  async renameEvent(ev) {
    const n = await promptBox('事件名称', ev.name || '', { title: '重命名事件' });
    if (n === null) return;
    this.ed.edit('重命名事件', () => { ev.name = n || '事件'; }, {});
    this.refresh();
  }

  delEvent(ev) {
    const ed = this.ed;
    ed.edit('删除事件', () => {
      const i = ed.level.events.indexOf(ev);
      if (i >= 0) ed.level.events.splice(i, 1);
    }, {});
    if (this.cur === ev.id) { this.cur = null; this.sel = null; }
    this.refresh();
  }

  toggleEvent(ev, on) {
    const ed = this.ed;
    ed.edit(on ? '启用事件' : '禁用事件', () => { ev.enabled = !!on; }, {});
    this.refresh();
  }

  /* ============================================================
     动作增删
     ============================================================ */
  addAction(ev, type, anchor) {
    const ed = this.ed;
    const a = createAction(type || 'wait');
    ed.edit('添加动作', () => { ev.actions.push(a); }, {});
    const idx = ev.actions.length - 1;
    this.sel = { kind: 'action', i: idx };
    this.refresh();
    if (!type) this._actionPicker(ev, idx, anchor);
    else ed.log('添加动作：' + (ACTION_TYPES[type] ? ACTION_TYPES[type].label : type), 'i');
  }

  delAction(ev, i) {
    const ed = this.ed;
    const a = ev.actions[i];
    ed.edit('删除动作', () => {
      if (!a) { ev.actions.splice(i, 1); return; }
      /* 结构性清理：从所有执行边 / 值接线 / 入口里摘掉这个 id（同一闭包内完成） */
      for (const x of ev.actions) {
        if (x === a) continue;
        if (x.next && typeof x.next === 'object') {
          for (const k of Object.keys(x.next)) {
            x.next[k] = (x.next[k] || []).filter((id) => id !== a.id);
          }
        }
        if (x.inputs && typeof x.inputs === 'object') {
          for (const k of Object.keys(x.inputs)) {
            if (x.inputs[k] && x.inputs[k].a === a.id) delete x.inputs[k];
          }
        }
      }
      if (Array.isArray(ev.start)) {
        ev.start = ev.start.filter((id) => id !== a.id);
        if (!ev.start.length) ev.start = null;
      }
      const at = ev.actions.indexOf(a);
      if (at >= 0) ev.actions.splice(at, 1);
      this.pos.delete(this._keyOf('action', a.id));
    }, {});
    this.sel = { kind: 'trigger' };
    this.refresh();
  }

  moveAction(ev, from, to) {
    if (from === to || to < 0 || to > ev.actions.length) return;
    const ed = this.ed;
    ed.edit('调整动作顺序', () => {
      const [a] = ev.actions.splice(from, 1);
      ev.actions.splice(from < to ? to - 1 : to, 0, a);
    }, {});
    this.sel = { kind: 'action', i: from < to ? to - 1 : to };
    this.refresh();
  }

  _actionPicker(ev, insertAt, anchor) {
    const groups = [
      { t: '对象', list: ['showObject', 'hideObject', 'setProperty', 'moveObject', 'rotateObject', 'scaleObject', 'openDoor', 'closeDoor'] },
      { t: '玩家', list: ['teleportPlayer', 'platformMode', 'setPlayer', 'morphPlayer', 'giveTool', 'removeTool', 'addOxygen', 'killPlayer'] },
      { t: '世界', list: ['setGravity'] },
      { t: '流程', list: ['wait', 'ifBlock', 'readVar', 'mathExpr', 'winLevel', 'setVariable', 'showNotice', 'playSound', 'playAudio', 'spawnEffect', 'playAnim', 'stopAnim', 'setLiquid', 'skyCrossfade'] },
      { t: '随机数', list: ['randomNumber', 'randomPick', 'randomChance'] },
      { t: '数组', list: ['arrayCreate', 'arrayPush', 'arrayPop', 'arrayGet', 'arraySet', 'arrayRemove', 'arrayLength', 'arrayContains', 'arrayShuffle', 'arrayClear'] },
      { t: '循环', list: ['loopStart', 'forEachStart', 'whileStart', 'loopEnd', 'loopBreak'] },
      { t: '对象生成', list: ['createObject', 'cloneObject', 'setParent'] },
      { t: '脚本 / 查询', list: ['script', 'evalExpr', 'raycast', 'getProperty'] },
      { t: 'NPC', list: ['npcTalk', 'npcSay', 'npcBehavior', 'npcFollow', 'npcPatrol', 'npcStop', 'npcSpeed', 'npcKeepDist', 'npcMoveTo', 'npcWarp', 'npcWarpToPlayer', 'npcLookAt', 'npcFreeze', 'npcVisible', 'npcAnim', 'npcGetPos', 'npcDistToPlayer', 'npcIsTalking'] },
    ];
    const body = el('div', {});
    for (const g of groups) {
      body.appendChild(el('div', { class: 'pg-head', style: { cursor: 'default' }, text: g.t }));
      const grid = el('div', { class: 'pgrid', style: { marginBottom: '8px' } });
      for (const k of g.list) {
        const d = ACTION_TYPES[k];
        if (!d) continue;
        grid.appendChild(el('button', {
          class: 'pitem', title: PICK_HINTS[k] ? (d.label + '：' + PICK_HINTS[k]) : d.label,
          onclick: () => { closeNow(); this._setActionType(ev, insertAt, k); },
        }, el('b', { text: d.icon }), el('i', { text: d.label })));
      }
      body.appendChild(grid);
    }
    const p = popover({
      title: '选择动作类型',
      body, anchor: anchor || this.el, width: 360,
      onReady: () => requestAnimationFrame(() => this._drawLines()),
    });
    function closeNow() { p && p.remove(); }
  }

  /** 换类型：保留 id（否则指向它的边会全部悬空），并把边 / 接线归拢到新类型的合法槽位上 */
  _setActionType(ev, i, type) {
    const ed = this.ed;
    ed.edit('修改动作类型', () => {
      const a = ev.actions[i];
      if (!a) return;
      const id = a.id;
      const oldNext = a.next || null;
      const fresh = createAction(type);
      for (const k of Object.keys(a)) delete a[k];
      Object.assign(a, fresh);
      a.id = id;                              // 关键：id 必须保留
      if (!oldNext) return;
      const slots = outsOf(a).map((o) => o.k);
      /* 旧边归拢：有 out 槽就迁到 out，否则第一个槽；新类型没有的槽直接丢弃 */
      const merged = {};
      for (const k of slots) merged[k] = [];
      const keep = merged.out !== undefined ? 'out' : slots[0];
      for (const k of Object.keys(oldNext)) {
        const tgt = (oldNext[k] || []).filter((x) => x && x !== a.id);
        if (!tgt.length) continue;
        const dest = merged[k] !== undefined ? k : keep;
        if (!dest) continue;
        for (const x of tgt) if (!merged[dest].includes(x)) merged[dest].push(x);
      }
      a.next = merged;
      /* 丢弃新类型不再存在的值接线键 */
      if (a.inputs && typeof a.inputs === 'object') {
        const keys = new Set(inputKeysOf(a));
        for (const k of Object.keys(a.inputs)) if (!keys.has(k)) delete a.inputs[k];
      }
      if (Array.isArray(a.expose)) {
        const ok = new Set(exposableOf(a));
        a.expose = a.expose.filter((k) => ok.has(k));
      }
    }, {});
    this.sel = { kind: 'action', i };
    this.refresh();
  }

  /* ============================================================
     刷新
     ============================================================ */
  refresh() {
    if (!this.ed.level) return;
    const lv = this.ed.level;
    if (this.cur && !lv.events.some((e) => e.id === this.cur)) { this.cur = null; this.sel = null; }
    if (!this.cur && lv.events.length) this.cur = lv.events[0].id;
    this._renderList();
    this._renderCanvas();
    this._renderInspector();
    requestAnimationFrame(() => this._drawLines());
  }

  _renderList() {
    const lv = this.ed.level;
    clear(this.listItems);
    if (!lv.events.length) {
      this.listItems.appendChild(el('div', { class: 'hint', style: { padding: '14px 8px', textAlign: 'center' }, text: '还没有事件\n点上方「＋ 事件」开始' }));
      return;
    }
    for (const ev of lv.events) {
      const d = TRIGGER_TYPES[ev.trigger.type] || {};
      const rowEl = el('div', {
        class: 'ev-item' + (ev.id === this.cur ? ' sel' : ''),
        title: (d.label || ev.trigger.type) + ' · ' + ev.actions.length + ' 个动作',
        onclick: () => { this.cur = ev.id; this.sel = { kind: 'trigger' }; this.refresh(); },
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: ev.name },
            { ico: '✎', l: '重命名', fn: () => this.renameEvent(ev) },
            { ico: ev.enabled ? '🚫' : '▶', l: ev.enabled ? '禁用' : '启用', fn: () => this.toggleEvent(ev, !ev.enabled) },
            { sep: true },
            { ico: '🗑', l: '删除事件', danger: true, fn: () => this.delEvent(ev) },
          ]);
        },
      },
        el('span', { class: 'dot' + (ev.enabled ? '' : ' off') }),
        el('span', { class: 'en', text: ev.name || '事件' }),
        el('span', { class: 'lmeta', text: (d.icon || '') + ' ' + ev.actions.length }));
      this.listItems.appendChild(rowEl);
    }
  }

  /* ---------- 节点定位 ---------- */
  /** 手工位置在内存里的键：按动作 id（而非下标）存，重排后位置跟着节点走 */
  _keyOf(kind, id) { return (kind === 'trigger' ? TRIG_ID : id); }

  _manualPos(kind, id) { return this.pos.get(this._keyOf(kind, id)) || null; }

  /** 某动作在 exec 链上的后继 id 列表（与运行时 targetsOf 的隐式回退保持一致） */
  _succOf(ev, a, i) {
    if (a.next && typeof a.next === 'object') {
      const out = [];
      for (const o of outsOf(a)) {
        for (const id of (a.next[o.k] || [])) if (id && !out.includes(id)) out.push(id);
      }
      return out;
    }
    const nx = ev.actions[i + 1];
    return (o1 => (o1 && o1.id ? [o1.id] : []))(nx);
  }

  /** 事件入口动作 id 列表（ev.start 为空则回退 actions[0]） */
  _entryIds(ev) {
    const ids = (Array.isArray(ev.start) && ev.start.length)
      ? ev.start.filter((id) => ev.actions.some((a) => a.id === id))
      : [];
    if (ids.length) return ids;
    return ev.actions.length && ev.actions[0] ? [ev.actions[0].id] : [];
  }

  /**
   * 分层自动布局：层号 = 从入口出发的最长路径，同层按数组顺序纵向堆叠。
   * 返回 Map(nodeKey -> {x,y})，只负责「没有手工位置」的节点。
   */
  _layout(ev) {
    const acts = ev.actions || [];
    const idx = new Map(acts.map((a, i) => [a.id, i]));
    const layer = new Map();                       // actionId -> 层号
    const entries = this._entryIds(ev);
    const q = [];
    for (const id of entries) { layer.set(id, 1); q.push({ id, d: 1 }); }
    let guard = 0;
    while (q.length && guard++ < 8000) {
      const cur = q.shift();
      const i = idx.get(cur.id);
      if (i === undefined) continue;
      for (const t of this._succOf(ev, acts[i], i)) {
        const nd = Math.min(cur.d + 1, 60);
        if ((layer.get(t) ?? -1) < nd) { layer.set(t, nd); q.push({ id: t, d: nd }); }
      }
    }
    /* 孤儿节点（没被任何入口连到）统一放到第 1 层，跟着数组顺序排 */
    for (const a of acts) if (!layer.has(a.id)) layer.set(a.id, 1);

    const out = new Map();
    out.set(TRIG_ID, { x: PAD, y: PAD + 14 });
    const rows = new Map();                        // 层号 -> 已放数量
    for (const a of acts) {
      const L = layer.get(a.id) || 1;
      const k = rows.get(L) || 0;
      rows.set(L, k + 1);
      out.set(a.id, { x: PAD + L * (NODE_W + GAP_X), y: PAD + 14 + k * ROW_H });
    }
    return out;
  }

  /** 当前手工位置 / 自动位置合并后的节点坐标 */
  _getPos(ev, kind, i, layout) {
    const a = kind === 'action' ? (ev.actions[i] || null) : null;
    const id = kind === 'trigger' ? TRIG_ID : (a ? a.id : TRIG_ID);
    const man = this._manualPos(kind, id);
    if (man) return man;
    const lay = layout && layout.get(id);
    return lay ? { x: lay.x, y: lay.y } : { x: PAD, y: PAD + 14 };
  }

  /** 自动整理：清掉本事件的手工位置，交给分层布局 */
  autoArrange() {
    const ev = this._ev();
    if (!ev) return;
    this.pos.delete(TRIG_ID);
    for (const a of ev.actions) this.pos.delete(a.id);
    this.refresh();
    this.ed.log('自动整理节点', 'i');
  }

  _renderCanvas() {
    const lv = this.ed.level;
    const ev = lv.events.find((e) => e.id === this.cur);
    this.nodes = [];
    this.nodeMap = new Map();
    this.trigNode = null;
    for (const n of [...this.pad.querySelectorAll('.enode')]) n.remove();
    if (!ev) {
      this.pad.style.width = '100%';
      this.pad.style.height = '100%';
      this._drawLines();
      return;
    }
    const layout = this._layout(ev);
    /* 触发节点 */
    const tp = this._getPos(ev, 'trigger', 0, layout);
    const tnode = this._node(ev, 'trigger', 0, tp, TRIGGER_TYPES[ev.trigger.type] || {}, this._triggerSummary(ev), null);
    this.pad.appendChild(tnode);
    this.trigNode = tnode;

    /* 动作节点 */
    ev.actions.forEach((a, i) => {
      const p = this._getPos(ev, 'action', i, layout);
      const d = ACTION_TYPES[a.type] || {};
      const node = this._node(ev, 'action', i, p, d, this._actionSummary(ev, a), a);
      this.pad.appendChild(node);
      this.nodeMap.set(a.id, node);
    });
    /* 尾部添加按钮（摆在布局右侧） */
    let maxL = 1;
    for (const a of ev.actions) maxL = Math.max(maxL, ((layout.get(a.id) || {}).x || PAD) / (NODE_W + GAP_X));
    this.addNode = el('div', {
      class: 'enode', style: { left: (PAD + (Math.round(maxL) + 1) * (NODE_W + GAP_X)) + 'px', top: (PAD + 14) + 'px', width: '150px', background: 'rgba(127,227,255,.08)', borderStyle: 'dashed' },
    }, el('div', { class: 'eb', style: { textAlign: 'center' } },
      el('button', {
        class: 'mini', text: '＋ 添加动作',
        onclick: (e) => this.addAction(ev, null, e.target),
      })));
    this.addNode.dataset.add = '1';
    this.pad.appendChild(this.addNode);
    this._resizePad();
  }

  /** 端口元素工厂：kind = 'in' | 'out'；in 用 data-key（字段名），out 用 data-slot（槽名） */
  _port(pt, kind, key, top, title) {
    return el('div', {
      class: 'ev-port ' + (pt === 'value' ? 'v ' : '') + (kind === 'in' ? 'inp' : 'out'),
      style: { top: top + 'px' },
      dataset: kind === 'in' ? { pt, key } : { pt, slot: key },
      title: title || '',
    });
  }

  _node(ev, kind, i, pos, def, summary, a) {
    const selected = this.sel && this.sel.kind === kind && (kind === 'trigger' || this.sel.i === i);
    const valueOnly = kind === 'action' && isValueOnly(a);
    const isCond = kind === 'action' && a.type === 'ifBlock';
    const cls = 'enode ' + (kind === 'trigger' ? 'evt' : valueOnly ? 'val' : isCond ? 'cond' : 'act') + (selected ? ' sel' : '');
    const head = el('div', { class: 'eh' },
      el('span', { text: def.icon || '•' }),
      el('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: def.label || (kind === 'trigger' ? '触发' : '动作') }));
    const node = el('div', { class: cls, style: { left: pos.x + 'px', top: pos.y + 'px', width: NODE_W + 'px' } }, head,
      el('div', { class: 'eb', text: summary }));
    if (kind === 'action') {
      node.appendChild(el('span', {
        class: 'ex', text: '✕', title: '删除动作',
        onclick: (e) => { e.stopPropagation(); this.delAction(ev, i); },
      }));
    }

    /* exec 输入口（顶部一个；触发 / 纯值块没有） */
    if (kind === 'action' && !valueOnly) {
      node.appendChild(this._port('exec', 'in', 'exec', PORT_Y, '执行入口（可接多条）'));
    }
    /* exec 输出口：按 outsOf 竖排，带槽名标签 */
    const outs = kind === 'action' ? (valueOnly ? [] : outsOf(a)) : [{ k: 'out', l: '', t: 'exec' }];
    outs.forEach((o, oi) => {
      const top = PORT_Y + oi * PORT_GAP;
      node.appendChild(this._port('exec', 'out', o.k, top, '从这里拖出可建立连线' + (o.l ? '（' + o.l + '）' : '')));
      if (o.l) node.appendChild(el('span', { class: 'ev-plabel', style: { top: (top - 3) + 'px' }, text: o.l }));
    });
    /* 值输入口（左侧）：固定输入口 + 已暴露参数（纯值块同样有值输入口，只是没有执行口） */
    const ins = kind === 'action' ? insOf(a) : [];
    ins.forEach((x, j) => {
      const top = PORT_Y + 18 + j * PORT_GAP;
      node.appendChild(this._port('value', 'in', x.k, top, '值输入：' + (x.l || x.k)));
    });
    /* 值输出口（右侧、方形、异色） */
    const vouts = kind === 'action' ? valueOutsOf(a) : [];
    vouts.forEach((x, j) => {
      const top = PORT_Y + 18 + j * PORT_GAP;
      node.appendChild(this._port('value', 'out', x.k, top, '值输出：拖到别的块的值输入口'));
    });
    const nPorts = Math.max(outs.length, ins.length, vouts.length);
    if (nPorts > 1) node.style.minHeight = (PORT_Y + nPorts * PORT_GAP + 10) + 'px';
    if (outs.some((o) => o.l)) node.classList.add('ports');

    node.dataset.kind = kind;
    node.dataset.i = String(i);
    node.dataset.id = kind === 'trigger' ? TRIG_ID : (a && a.id) || '';
    node._pos = pos;
    this.nodes.push(node);
    return node;
  }

  _resizePad() {
    let w = 0, h = 0;
    for (const n of [...this.pad.querySelectorAll('.enode')]) {
      w = Math.max(w, parseFloat(n.style.left) + n.offsetWidth + PAD + 40);
      h = Math.max(h, parseFloat(n.style.top) + (n.offsetHeight || DEF_H) + PAD);
    }
    this.pad.style.width = Math.max(100, w) + 'px';
    this.pad.style.height = Math.max(100, h) + 'px';
    this.svg.setAttribute('width', Math.max(100, w));
    this.svg.setAttribute('height', Math.max(100, h));
    this.svg.setAttribute('viewBox', '0 0 ' + Math.max(100, w) + ' ' + Math.max(100, h));
  }

  /* ---------- 连线 ---------- */
  /** 节点上某个端口（选择器）的画布坐标 */
  _portPos(node, sel) {
    if (!node) return null;
    const p = sel ? node.querySelector(sel) : null;
    if (!p) return null;
    return {
      x: node.offsetLeft + p.offsetLeft + p.offsetWidth / 2,
      y: node.offsetTop + p.offsetTop + p.offsetHeight / 2,
    };
  }

  _path(x1, y1, x2, y2, cls) {
    const dx = Math.max(26, Math.abs(x2 - x1) / 2);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (cls) p.setAttribute('class', cls);
    p.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    this.svg.appendChild(p);
    return p;
  }

  /** 真边渲染器：exec 边按 outsOf 槽位，值边按 a.inputs（虚线异色），触发按 ev.start */
  _drawLines() {
    if (!this.svg) return;
    clear(this.svg);
    const ev = this._ev();
    if (!ev || !this.nodeMap || !this.trigNode) return;

    /* 触发 → 入口 */
    if (this.trigNode) {
      const from = this._portPos(this.trigNode, '.ev-port[data-slot="out"][data-pt="exec"]');
      for (const id of this._entryIds(ev)) {
        const to = this._portPos(this.nodeMap.get(id), '.ev-port[data-pt="exec"][data-key="exec"]');
        if (from && to) this._path(from.x, from.y, to.x, to.y, 'e');
      }
    }

    /* 动作 exec 边 */
    ev.actions.forEach((a, i) => {
      const node = this.nodeMap.get(a.id);
      if (!node || isValueOnly(a)) return;
      const outs = outsOf(a);
      outs.forEach((o, oi) => {
        const from = this._portPos(node, `.ev-port[data-pt="exec"][data-slot="${o.k}"]`);
        if (!from) return;
        let targets;
        if (a.next && typeof a.next === 'object') targets = (a.next[o.k] || []);
        else targets = (o.k === 'out' && ev.actions[i + 1]) ? [ev.actions[i + 1].id] : [];
        for (const tid of targets) {
          if (tid === a.id) continue;
          const to = this._portPos(this.nodeMap.get(tid), '.ev-port[data-pt="exec"][data-key="exec"]');
          if (to) this._path(from.x, from.y, to.x, to.y, 'e');
        }
      });
    });

    /* 值接线（虚线异色） */
    ev.actions.forEach((a) => {
      const node = this.nodeMap.get(a.id);
      if (!node || !a.inputs) return;
      for (const k of Object.keys(a.inputs)) {
        const w = a.inputs[k];
        if (!w || !w.a) continue;
        const src = this.nodeMap.get(w.a);
        if (!src) continue;
        const to = this._portPos(node, `.ev-port[data-pt="value"][data-key="${k}"]`);
        const from = this._portPos(src, `.ev-port[data-pt="value"][data-slot="${w.o || 'v'}"]`);
        if (from && to) this._path(from.x, from.y, to.x, to.y, 'v');
      }
    });
  }

  /* ---------- 拖动 / 连线交互 ---------- */
  _bindPad() {
    let drag = null;
    const clearDroppable = () => { for (const n of this.pad.querySelectorAll('.enode.droppable')) n.classList.remove('droppable'); };

    this.pad.addEventListener('pointerdown', (e) => {
      const node = e.target.closest && e.target.closest('.enode');
      if (!node) return;
      if (node.dataset.add) return;                     // 尾部「＋ 添加动作」不做拖动
      const port = e.target.closest && e.target.closest('.ev-port');
      const ev = this._ev();
      if (port && port.classList.contains('out') && !e.shiftKey) {
        /* 从输出口拖出 = 建立连线 */
        drag = { link: { node, pt: port.dataset.pt, slot: port.dataset.slot, id: node.dataset.id, kind: node.dataset.kind } };
        if (ev) for (const [, n] of this.nodeMap) if (this._compatible(ev, drag.link, n)) n.classList.add('droppable');
      } else {
        if (e.target.closest('.mini')) return;
        drag = {
          node, x0: e.clientX, y0: e.clientY,
          l0: parseFloat(node.style.left), t0: parseFloat(node.style.top),
          moved: false,
          sort: !!(port && port.classList.contains('out')),   // Shift+拖端口 = 旧的「拖拽调整顺序」手势
        };
        this.sel = { kind: node.dataset.kind, i: Number(node.dataset.i) };
        if (ev) { this._renderInspector(); }
        for (const n of this.pad.querySelectorAll('.enode')) n.classList.toggle('sel', n === node);
      }
      e.preventDefault();
      try { this.pad.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    this.pad.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const rect = this.pad.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (drag.link) { this._previewLink(drag, x, y); return; }
      const dx = e.movementX || (e.clientX - drag.x0);
      const dy = e.movementY || (e.clientY - drag.y0);
      drag.x0 = e.clientX; drag.y0 = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      if (!drag.moved) return;
      const nx = Math.max(2, parseFloat(drag.node.style.left) + dx);
      const ny = Math.max(2, parseFloat(drag.node.style.top) + dy);
      drag.node.style.left = nx + 'px';
      drag.node.style.top = ny + 'px';
      drag.node._pos.x = nx; drag.node._pos.y = ny;
      this.pos.set(this._keyOf(drag.node.dataset.kind, drag.node.dataset.id), { x: nx, y: ny });
      this._resizePad();
      this._drawLines();
    });

    const finish = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      clearDroppable();
      if (this._ghost) { this._ghost.remove(); this._ghost = null; }
      const ev = this._ev();
      if (d.link) {
        if (!ev) return;
        const stack = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [];
        const portEl = stack.find((n) => n.classList && n.classList.contains('ev-port'));
        const hostEl = (stack.find((n) => n.classList && n.classList.contains('enode')))
          || (document.elementFromPoint(e.clientX, e.clientY) || {}).closest?.('.enode');
        if (hostEl && hostEl.dataset.add) { this._addAndConnect(ev, d.link); return; }
        const host = hostEl && hostEl.dataset.kind === 'action' ? hostEl : null;
        if (!host || !this._compatible(ev, d.link, host)) { this._drawLines(); return; }
        /* 只有落在「同类输入口」上才走精确接线；exec↔值 混投则退回默认口，避免建出错类型的边 */
        const onPort = portEl && portEl.closest('.enode') === host
          && portEl.classList.contains('inp') && portEl.dataset.pt === d.link.pt;
        if (onPort && d.link.pt === 'value') {
          const a = ev.actions.find((x) => x.id === host.dataset.id);
          const key = portEl.dataset.key;
          if (insOf(a).some((x) => x.k === key)) { this._connect(ev, d.link, host.dataset.id, key, 'value'); return; }
        } else if (onPort && d.link.pt === 'exec') {
          this._connect(ev, d.link, host.dataset.id, null, 'exec'); return;
        }
        this._connect(ev, d.link, host.dataset.id, this._firstKey(ev, d.link, host.dataset.id), d.link.pt);
        return;
      }
      if (d.moved) this._drawLines();
      /* Shift+拖端口（旧手势）：落到别的动作上 = 调整数组顺序 */
      if (d.sort && ev && d.node.dataset.kind === 'action' && e.type === 'pointerup') {
        const stack = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [];
        const hostEl = stack.find((n) => n.classList && n.classList.contains('enode'));
        if (hostEl && hostEl.dataset.add) this.moveAction(ev, Number(d.node.dataset.i), ev.actions.length);
        else if (hostEl && hostEl.dataset.kind === 'action') this.moveAction(ev, Number(d.node.dataset.i), Number(hostEl.dataset.i));
      }
    };
    this.pad.addEventListener('pointerup', finish);
    this.pad.addEventListener('pointercancel', finish);
    this.pad.addEventListener('dblclick', (e) => {
      const node = e.target.closest && e.target.closest('.enode');
      if (!node || node.dataset.kind !== 'action') return;
      this._actionPicker(this._ev(), Number(node.dataset.i), node);
    });
    this.pad.addEventListener('contextmenu', (e) => {
      const node = e.target.closest && e.target.closest('.enode');
      if (!node) return;
      e.preventDefault();
      const ev = this._ev();
      if (!ev) return;
      const items = [];
      const port = e.target.closest && e.target.closest('.ev-port');
      if (port) { items.push(...this._portMenu(ev, node, port)); items.push({ sep: true }); }
      if (node.dataset.kind === 'action') {
        const i = Number(node.dataset.i);
        items.push({ label: '动作 ' + (i + 1) });
        items.push({ ico: '🔄', l: '更换类型…', fn: () => this._actionPicker(ev, i, node) });
        items.push({ ico: '⧉', l: '复制一份', fn: () => this.dupAction(ev, i) });
        if (i > 0) items.push({ ico: '↑', l: '上移', fn: () => this.moveAction(ev, i, i - 1) });
        if (i < ev.actions.length - 1) items.push({ ico: '↓', l: '下移', fn: () => this.moveAction(ev, i, i + 2) });
        items.push({ sep: true });
        items.push({ ico: '🗑', l: '删除动作', danger: true, fn: () => this.delAction(ev, i) });
      } else {
        items.push({ label: '触发条件' });
        items.push({ ico: '＋', l: '添加动作…', fn: () => this.addAction(ev, null, node) });
      }
      items.push({ sep: true });
      items.push({ ico: '✎', l: '重命名事件', fn: () => this.renameEvent(ev) });
      contextMenu(e.clientX, e.clientY, items);
    });
  }

  /* ---------- 连线合法性 / 建立 / 断开 ---------- */
  /** 节点显示名（右键菜单 / 接口小节用） */
  _nodeLabel(ev, id) {
    if (id === TRIG_ID) return '触发条件';
    const i = ev.actions.findIndex((a) => a.id === id);
    if (i < 0) return '（已删除）';
    const a = ev.actions[i];
    return (ACTION_TYPES[a.type] || {}).label || a.type;
  }

  /** 值图 / 执行图里 dst 能否到达 src（用于成环检测） */
  _reaches(ev, startId, targetId, mode) {
    const idx = new Map(ev.actions.map((a, i) => [a.id, i]));
    const seen = new Set();
    const stack = [startId];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
      const id = stack.pop();
      if (id === targetId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const i = idx.get(id);
      if (i === undefined) continue;
      const a = ev.actions[i];
      if (mode === 'value') {
        for (const k of Object.keys(a.inputs || {})) { const w = a.inputs[k]; if (w && w.a) stack.push(w.a); }
      } else {
        for (const t of this._succOf(ev, a, i)) stack.push(t);
      }
    }
    return false;
  }

  /** 源端口能不能接到这个节点（类型匹配、非自环、不成环） */
  _compatible(ev, src, node) {
    if (!node || node.dataset.kind !== 'action') return false;
    const id = node.dataset.id;
    if (!id || id === src.id) return false;
    const a = ev.actions.find((x) => x.id === id);
    if (!a) return false;
    if (src.pt === 'exec') {
      if (isValueOnly(a)) return false;
      if (this._reaches(ev, id, src.id, 'exec')) return false;
      return true;
    }
    if (!insOf(a).length) return false;
    /* 值边 src → dst 表示「dst 读 src」；成环的条件是 src 反过来已经（间接）读了 dst */
    if (this._reaches(ev, src.id, id, 'value')) return false;
    return true;
  }

  /** 落到节点本体（非端口）时选一个默认输入键 */
  _firstKey(ev, src, id) {
    const a = ev.actions.find((x) => x.id === id);
    if (!a) return null;
    if (src.pt === 'exec') return null;
    const ins = insOf(a);
    const free = ins.find((x) => !(a.inputs && a.inputs[x.k]));
    return (free || ins[0] || {}).k || null;
  }

  /** 保证动作有显式 next（首次建边时物化），隐式 'out' 后继原样保留 */
  _ensureNext(ev, a) {
    if (a.next && typeof a.next === 'object') return a.next;
    const m = {};
    for (const o of outsOf(a)) m[o.k] = [];
    const i = ev.actions.indexOf(a);
    const nx = ev.actions[i + 1];
    if (m.out !== undefined && nx && nx.id) m.out = [nx.id];
    a.next = m;
    return m;
  }

  /** 首次编辑这个事件时，把隐式线性链物化成显式 next（已有 next 或 start 则跳过） */
  materializeChain(ev) {
    if (!ev || !Array.isArray(ev.actions)) return;
    if (ev.start || ev.actions.some((a) => a.next)) return;
    ev.actions.forEach((a, i) => {
      const nx = ev.actions[i + 1];
      a.next = nx && nx.id ? { out: [nx.id] } : {};
    });
  }

  /** 建立连线：src（输出口）→ dst（输入口） */
  _connect(ev, src, dstId, key, pt) {
    const ed = this.ed;
    ed.edit('建立连线', () => {
      this.materializeChain(ev);
      if (src.kind === 'trigger') {
        const list = Array.isArray(ev.start) ? ev.start.slice() : [];
        if (!list.includes(dstId)) list.push(dstId);
        ev.start = list;
        return;
      }
      const s = ev.actions.find((x) => x.id === src.id);
      if (!s) return;
      if (pt === 'value') {
        const d = ev.actions.find((x) => x.id === dstId);
        if (!d || !key || !insOf(d).some((x) => x.k === key)) return;
        d.inputs = d.inputs || {};
        d.inputs[key] = { a: src.id, o: src.slot || 'v' };   // 值输入口只接一条，重连即替换
        return;
      }
      const m = this._ensureNext(ev, s);
      const slot = src.slot || 'out';
      const arr = Array.isArray(m[slot]) ? m[slot] : (m[slot] = []);
      if (!arr.includes(dstId)) arr.push(dstId);
    }, {});
    this.refresh();
  }

  /** 拖到尾部「＋ 添加动作」上：新建动作并连上（同一个撤销步骤） */
  _addAndConnect(ev, src) {
    const ed = this.ed;
    ed.edit('添加动作并连线', () => {
      const a = createAction('wait');
      if (src.pt === 'value') a.expose = ['time'];
      ev.actions.push(a);
      this.materializeChain(ev);
      if (src.kind === 'trigger') {
        ev.start = Array.isArray(ev.start) ? ev.start.concat([a.id]) : [a.id];
      } else {
        const s = ev.actions.find((x) => x.id === src.id);
        if (s) {
          const m = this._ensureNext(ev, s);
          const slot = src.slot || 'out';
          const arr = Array.isArray(m[slot]) ? m[slot] : (m[slot] = []);
          if (!arr.includes(a.id)) arr.push(a.id);
        }
      }
      if (src.pt === 'value') a.inputs = { time: { a: src.id, o: src.slot || 'v' } };
    }, {});
    this.sel = { kind: 'action', i: ev.actions.length - 1 };
    this.refresh();
  }

  /** 断开：执行输出槽上的一条边 */
  _cutExec(ev, srcId, slot, targetId) {
    this.ed.edit('断开连线', () => {
      const s = ev.actions.find((x) => x.id === srcId);
      if (!s) return;
      const m = this._ensureNext(ev, s);
      if (!Array.isArray(m[slot])) return;
      m[slot] = targetId ? m[slot].filter((id) => id !== targetId) : [];
    }, {});
    this.refresh();
  }

  /** 断开：触发入口 */
  _cutEntry(ev, targetId) {
    this.ed.edit('断开连线', () => {
      if (!Array.isArray(ev.start)) return;
      ev.start = ev.start.filter((id) => id !== targetId);
    }, {});
    this.refresh();
  }

  /** 断开：值接线（目标输入口） */
  _cutValue(ev, targetId, key) {
    this.ed.edit('断开连线', () => {
      const t = ev.actions.find((x) => x.id === targetId);
      if (!t || !t.inputs) return;
      delete t.inputs[key];
      if (!Object.keys(t.inputs).length) t.inputs = null;
    }, {});
    this.refresh();
  }

  /** 端口右键菜单 */
  _portMenu(ev, node, port) {
    const items = [];
    const pt = port.dataset.pt;
    const isOut = port.classList.contains('out');
    if (isOut) {
      const id = node.dataset.id;
      if (node.dataset.kind === 'trigger') {
        items.push({ label: '触发输出' });
        const ents = Array.isArray(ev.start) ? ev.start.filter((x) => ev.actions.some((a) => a.id === x)) : [];
        if (!ents.length) items.push({ ico: '⛔', l: '入口为默认链（无需断开）' });
        for (const x of ents) items.push({ ico: '✂', l: '断开 → ' + this._nodeLabel(ev, x), fn: () => this._cutEntry(ev, x) });
        return items;
      }
      if (pt === 'value') {
        items.push({ label: '值输出' });
        const users = ev.actions.filter((a) => a.inputs && Object.keys(a.inputs).some((k) => a.inputs[k] && a.inputs[k].a === id && (a.inputs[k].o || 'v') === port.dataset.slot));
        if (!users.length) items.push({ ico: '⛔', l: '（未被使用）' });
        for (const u of users) items.push({ ico: '✂', l: '断开 → ' + this._nodeLabel(ev, u.id), fn: () => this._cutValue(ev, u.id, Object.keys(u.inputs).find((k) => u.inputs[k] && u.inputs[k].a === id && (u.inputs[k].o || 'v') === port.dataset.slot)) });
        return items;
      }
      const slot = port.dataset.slot || 'out';
      const s = ev.actions.find((x) => x.id === id);
      const i = ev.actions.indexOf(s);
      let targets;
      if (s && s.next && typeof s.next === 'object') targets = (s.next[slot] || []).slice();
      else targets = (slot === 'out' && s && ev.actions[i + 1]) ? [ev.actions[i + 1].id] : [];
      items.push({ label: '输出槽「' + slot + '」' });
      if (!targets.length) items.push({ ico: '⛔', l: '（没有连线）' });
      for (const t of targets) items.push({ ico: '✂', l: '断开 → ' + this._nodeLabel(ev, t), fn: () => this._cutExec(ev, id, slot, t) });
      return items;
    }
    /* 输入口 */
    if (pt === 'value') {
      const key = port.dataset.key;
      const t = ev.actions.find((x) => x.id === node.dataset.id);
      const w = t && t.inputs && t.inputs[key];
      items.push({ label: '值输入「' + (FIELD_LABELS[key] || key) + '」' });
      if (w) items.push({ ico: '✂', l: '断开此连线（来自 ' + this._nodeLabel(ev, w.a) + '）', fn: () => this._cutValue(ev, node.dataset.id, key) });
      else items.push({ ico: '⛔', l: '（未接线）' });
      return items;
    }
    const tid = node.dataset.id;
    const sources = [];
    ev.actions.forEach((a, i) => { if (this._succOf(ev, a, i).includes(tid)) sources.push(a.id); });
    if (this._entryIds(ev).includes(tid)) sources.push(TRIG_ID);
    items.push({ label: '执行入口' });
    if (!sources.length) items.push({ ico: '⛔', l: '（没有来源）' });
    for (const sid of sources) {
      items.push({
        ico: '✂', l: '断开 ← ' + this._nodeLabel(ev, sid),
        fn: () => (sid === TRIG_ID ? this._cutEntry(ev, tid) : this._cutExec(ev, sid, this._slotOf(ev, sid, tid), tid)),
      });
    }
    return items;
  }

  /** 找到 sid 连到 tid 的槽键 */
  _slotOf(ev, sid, tid) {
    const s = ev.actions.find((x) => x.id === sid);
    if (!s) return 'out';
    if (s.next && typeof s.next === 'object') {
      for (const o of outsOf(s)) if ((s.next[o.k] || []).includes(tid)) return o.k;
      return 'out';
    }
    return 'out';
  }

  /** 「复制一份」：复制体分配新 id，自身边保留，且没有别的节点指向复制体 */
  dupAction(ev, i) {
    const src = ev.actions[i];
    if (!src) return;
    this.ed.edit('复制动作', () => {
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid('a');
      if (copy.next) copy.next = JSON.parse(JSON.stringify(src.next));
      ev.actions.splice(i + 1, 0, copy);
    }, {});
    this.sel = { kind: 'action', i: i + 1 };
    this.refresh();
  }

  _previewLink(drag, x, y) {
    const L = drag.link;
    const sel = `.ev-port[data-pt="${L.pt}"]` + (L.slot !== undefined ? `[data-slot="${L.slot}"]` : '');
    const from = this._portPos(L.node, sel)
      || { x: L.node.offsetLeft + L.node.offsetWidth, y: L.node.offsetTop + PORT_Y };
    const dx = Math.max(26, Math.abs(x - from.x) / 2);
    if (!this._ghost) {
      this._ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      this._ghost.setAttribute('class', L.pt === 'value' ? 'ghost v' : 'ghost');
      this.svg.appendChild(this._ghost);
    }
    this._ghost.setAttribute('d', `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${x - dx} ${y}, ${x} ${y}`);
  }

  _ev() {
    const lv = this.ed.level;
    return lv ? lv.events.find((e) => e.id === this.cur) || null : null;
  }

  /* ============================================================
     摘要文本
     ============================================================ */
  _triggerSummary(ev) {
    const t = ev.trigger;
    const d = TRIGGER_TYPES[t.type] || {};
    const p = [d.label || t.type];
    if (t.objectId) p.push(objName(this.ed.level, t.objectId));
    switch (t.type) {
      case 'timer': p.push((t.repeat ? '每 ' : '延迟 ') + (t.time || 0) + ' 秒'); break;
      case 'oxygenBelow': p.push('低于 ' + t.value); break;
      case 'variable': p.push(t.varName + ' ' + t.op + ' ' + t.value); break;
      default: break;
    }
    if (t.once) p.push('仅一次');
    return p.join(' · ');
  }

  _actionSummary(ev, a) {
    const d = ACTION_TYPES[a.type] || {};
    const p = [d.label || a.type];
    const P = OBJECT_PROPS_FOR_EVENTS[a.property] || {};
    switch (a.type) {
      case 'showObject': case 'hideObject': case 'openDoor': case 'closeDoor': case 'playAnim': case 'stopAnim':
        break;
      case 'skyCrossfade':
        p.push(skyName(a.fromSky) + ' → ' + skyName(a.toSky));
        p.push(a.time + 's');
        return p.join(' · ');
      case 'setProperty':
        p.push(objName(this.ed.level, a.objectId));
        p.push((P.label || a.property) + ' → ' + (P.type === 'vec3' ? vecStr(a.value) : String(a.value)));
        return p.join(' · ');
      case 'moveObject': case 'rotateObject': case 'scaleObject':
        p.push(objName(this.ed.level, a.objectId));
        p.push(vecStr(a.vec) + ' · ' + a.time + 's');
        return p.join(' · ');
      case 'teleportPlayer': p.push(vecStr(a.vec)); return p.join(' · ');
      case 'platformMode':
        if (a.platMode === 'off') { p.push('退出'); return p.join(' · '); }
        p.push('朝向 ' + vecStr(a.platNormal));
        return p.join(' · ');
      case 'setPlayer':
        p.push((PLAYER_FIELDS[a.playerField] || {}).label || a.playerField);
        p.push('= ' + a.value);
        return p.join(' · ');
      case 'setGravity': {
        const t = a.gravityTarget || 'world';
        p.push(t === 'player' ? '仅玩家' : t === 'both' ? '世界与玩家' : '全局世界');
        p.push('方向 ' + vecStr(a.vec || [0, -1, 0]));
        p.push('强度 ×' + (a.gravityPower === undefined ? 1 : a.gravityPower));
        if (Number(a.time) > 0) p.push(a.time + 's');
        return p.join(' · ');
      }
      case 'morphPlayer': {
        const m = a.morphMode || 'preset';
        if (m === 'default') { p.push('还原默认形象'); return p.join(' · '); }
        if (m === 'preset') {
          p.push('预设形象');
          p.push((PLAYER_PRESETS[a.morphPreset] || {}).label || a.morphPreset || 'classic');
          return p.join(' · ');
        }
        p.push('模型资产');
        p.push(modelName(a.morphAsset));
        p.push(`×${a.morphScale} · ${a.morphYaw}°`);
        return p.join(' · ');
      }
      case 'giveTool': case 'removeTool': {
        const t = a.toolId ? getObject(this.ed.level, a.toolId) : null;
        p.push(t ? objectLabel(t) : ((TOOL_DEFS[a.tool] || {}).label || a.tool));
        return p.join(' · ');
      }
      case 'addOxygen': p.push((a.value >= 0 ? '+' : '') + a.value); return p.join(' · ');
      case 'setLiquid': p.push(objName(this.ed.level, a.objectId)); p.push('液面 ' + Math.round(a.value * 100) + '% · ' + a.time + 's'); return p.join(' · ');
      case 'setVariable': p.push(a.varName + ' ' + a.op + ' ' + a.value); return p.join(' · ');
      case 'playSound': p.push(a.sound + ' @' + a.volume); return p.join(' · ');
      case 'playAudio': p.push(a.audio ? (audioName(a.audio) + (a.loopAudio ? ' · 循环' : '')) : '（未选择音频）'); return p.join(' · ');
      /* 随机数 */
      case 'randomNumber':
        p.push(a.varName + ' = ' + (a.isInt ? '整数' : '小数') + ' [' + a.rmin + ', ' + a.rmax + ']');
        return p.join(' · ');
      case 'randomPick': p.push(a.srcVar + ' → ' + a.varName); return p.join(' · ');
      case 'randomChance': p.push(a.varName + ' = 1 的概率 ' + a.chance + '%'); return p.join(' · ');
      /* 数组 */
      case 'arrayCreate': p.push(a.varName + ' = [' + (a.list || '').slice(0, 18) + ']'); return p.join(' · ');
      case 'arrayPush': p.push(a.varName + ' ＋ ' + a.value); return p.join(' · ');
      case 'arrayPop': p.push(a.varName + ' → ' + (a.destVar || '（丢弃）')); return p.join(' · ');
      case 'arrayGet': p.push(a.varName + '[' + a.index + '] → ' + a.destVar); return p.join(' · ');
      case 'arraySet': p.push(a.varName + '[' + a.index + '] = ' + a.value); return p.join(' · ');
      case 'arrayRemove': p.push('从 ' + a.varName + ' 删除 ' + a.value); return p.join(' · ');
      case 'arrayLength': p.push('长度(' + a.varName + ') → ' + a.destVar); return p.join(' · ');
      case 'arrayContains': p.push(a.varName + ' 含 ' + a.value + '? → ' + a.destVar); return p.join(' · ');
      case 'arrayShuffle': case 'arrayClear': return p.join(' · ');
      /* 循环 */
      case 'loopStart': p.push(a.count + ' 次' + (a.varName ? ' · 计数 → ' + a.varName : '')); return p.join(' · ');
      case 'forEachStart': p.push(a.srcVar + ' → ' + (a.varName || 'item') + (a.destVar ? ' · 下标 → ' + a.destVar : '')); return p.join(' · ');
      case 'whileStart': p.push('当 ' + (a.cond || 'var1') + ' ' + a.op + ' ' + a.value + ' · 上限 ' + a.maxIter); return p.join(' · ');
      case 'loopEnd': case 'loopBreak': return p.join(' · ');
      case 'spawnEffect': p.push((EFFECTS.find((x) => x.v === a.effect) || {}).l || a.effect); p.push(vecStr(a.vec)); return p.join(' · ');
      /* ---------- 新流程块 ---------- */
      case 'ifBlock': {
        p.push('若 ' + (a.cond || 'var1') + ' ' + a.op + ' ' + a.value);
        const n = (a.elifs || []).length;
        if (n) p.push('否则如果 ' + n + ' 条');
        p.push('否则 → 停止支路');
        return p.join(' · ');
      }
      case 'readVar': p.push('读取 ' + (a.varName || 'var1') + ' → 值'); return p.join(' · ');
      case 'mathExpr': {
        const f = String(a.formula || '').trim();
        p.push(f ? ('v = ' + (f.length > 26 ? f.slice(0, 26) + '…' : f)) : '（公式为空，结果为 0）');
        if (a.varName) p.push('写回 ' + a.varName);
        return p.join(' · ');
      }
      /* ---------- 对象生成 ---------- */
      case 'createObject': {
        p.push('模板 ' + (a.templateId ? objName(this.ed.level, a.templateId) : '（未指定）'));
        p.push(this._posDesc(a));
        if (a.destVar) p.push('id → ' + a.destVar);
        return p.join(' · ');
      }
      case 'cloneObject': {
        p.push(objName(this.ed.level, a.objectId));
        p.push(this._posDesc(a));
        if (a.deepTree) p.push('连子树');
        if (a.destVar) p.push('id → ' + a.destVar);
        return p.join(' · ');
      }
      case 'setParent': {
        p.push(objName(this.ed.level, a.objectId) + ' → 父级 ' + (a.parent ? objName(this.ed.level, a.parent) : '（无 / 解除）'));
        if (a.keepWorld !== false) p.push('保持世界位置');
        return p.join(' · ');
      }
      case 'wait': {
        if (a.waitMode === 'until') {
          const w = a.inputs && a.inputs.until;
          p.push('等待直到 ' + (w ? '接口收到 true' : (a.untilCond ? '#' + a.untilCond : '接口收到 true')));
        } else p.push(a.time + ' 秒');
        return p.join(' · ');
      }
      /* ---------- 脚本 / 查询 ---------- */
      case 'script': {
        const c = String(a.code || '').trim().replace(/\s+/g, ' ');
        p.push(c ? (c.length > 26 ? c.slice(0, 26) + '…' : c) : '（空代码）');
        if (a.destVar) p.push('→ ' + a.destVar);
        return p.join(' · ');
      }
      case 'evalExpr': {
        const c = String(a.code || '').trim().replace(/\s+/g, ' ');
        p.push(c ? (c.length > 28 ? c.slice(0, 28) + '…' : c) : '（空 = 0）');
        return p.join(' · ');
      }
      case 'raycast': {
        p.push(this._rayPointDesc(a, 'From') + ' → ' + this._rayPointDesc(a, 'To'));
        p.push('射程 ' + a.range);
        p.push('结果 → ' + (a.destObj || 'hitObj'));
        return p.join(' · ');
      }
      case 'getProperty': {
        const tm = a.propTarget || 'object';
        const tn = tm === 'object' ? objName(this.ed.level, a.objectId)
          : tm === 'player' ? '玩家' : tm === 'world' ? '世界' : '会话';
        p.push(tn + '.' + (a.propPath || '？'));
        if (a.destVar) p.push('→ ' + a.destVar);
        return p.join(' · ');
      }
      case 'showNotice': {
        const k = (NOTICE_KINDS.find((x) => x.v === a.noticeKind) || NOTICE_KINDS[0]).l;
        p.push(k + '：「' + String(a.noticeText || '').replace(/\n/g, ' ').slice(0, 20) + '」· ' + a.time + 's');
        return p.join(' · ');
      }
      /* NPC / 角色 */
      case 'npcTalk':
        p.push(objName(this.ed.level, a.npcId));
        p.push(a.node ? ('从节点 ' + a.node) : '从入口');
        return p.join(' · ');
      case 'npcSay':
        p.push(objName(this.ed.level, a.npcId));
        p.push('「' + String(a.sayText || '').replace(/\n/g, ' ').slice(0, 20) + '」');
        return p.join(' · ');
      case 'npcBehavior': case 'npcFollow': case 'npcPatrol': case 'npcStop':
      case 'npcSpeed': case 'npcKeepDist': case 'npcMoveTo': case 'npcWarp':
      case 'npcWarpToPlayer': case 'npcLookAt': case 'npcFreeze': case 'npcVisible':
      case 'npcAnim': case 'npcGetPos': case 'npcDistToPlayer': case 'npcIsTalking': {
        p.push(objName(this.ed.level, a.npcId));
        if (a.type === 'npcBehavior') p.push((NPC_BEHAVIORS.find((x) => x.v === (a.npcBehavior || 'follow')) || {}).l || a.npcBehavior);
        else if (a.type === 'npcFollow' || a.type === 'npcKeepDist' || a.type === 'npcWarpToPlayer') p.push('保持 ' + a.npcKeep);
        else if (a.type === 'npcSpeed') p.push('速度 ' + a.value);
        else if (a.type === 'npcMoveTo') p.push(vecStr(a.vec) + (Number(a.value) > 0 ? (' · ' + a.value + ' stud/s') : ''));
        else if (a.type === 'npcWarp') p.push(vecStr(a.vec));
        else if (a.type === 'npcLookAt') p.push((a.npcFace === 'point') ? ('坐标 ' + vecStr(a.vec)) : '面向玩家');
        else if (a.type === 'npcFreeze' || a.type === 'npcVisible') p.push(a.npcOn === false ? '关' : '开');
        else if (a.type === 'npcAnim') p.push(a.npcClip ? ('片段 ' + a.npcClip) : '恢复自动');
        return p.join(' · ');
      }
      default: break;
    }
    if (a.objectId) p.push(objName(this.ed.level, a.objectId));
    return p.join(' · ');
  }

  /* ============================================================
     属性表单
     ============================================================ */
  _renderInspector() {
    const insp = this.insp;
    // 代码编辑在独立窗口里，这里重建属性面板不会影响它（窗口自己管生命周期）
    clear(insp);
    const ev = this._ev();
    if (!ev) {
      insp.appendChild(el('div', { class: 'hint', text: '选择一个事件后\n在这里编辑触发条件与动作参数' }));
      return;
    }
    let target, def, label;
    if (this.sel && this.sel.kind === 'action' && ev.actions[this.sel.i]) {
      target = ev.actions[this.sel.i];
      def = ACTION_TYPES[target.type] || {};
      label = '动作 · ' + (def.label || target.type);
    } else {
      this.sel = { kind: 'trigger', i: 0 };
      target = ev.trigger;
      def = TRIGGER_TYPES[target.type] || {};
      label = '触发 · ' + (def.label || target.type);
    }
    insp.appendChild(el('div', { class: 'pg-head', style: { cursor: 'default' }, text: label }));
    if (this.sel.kind === 'trigger') {
      insp.appendChild(row('事件名', el('input', {
        type: 'text', value: ev.name || '',
        onchange: (e) => this._set('重命名事件', () => { ev.name = e.target.value; }),
      })));
      insp.appendChild(row('启用', this._switch(ev.enabled !== false, (v) => this._set('启用/禁用事件', () => { ev.enabled = v; }))));
      insp.appendChild(row('类型', optSelect(
        Object.keys(TRIGGER_TYPES).map((k) => ({ v: k, l: (TRIGGER_TYPES[k].icon || '') + ' ' + TRIGGER_TYPES[k].label })),
        target.type,
        (v) => this._setTriggerType(ev, v))));
      insp.appendChild(row('仅触发一次', this._switch(!!target.once, (v) => this._set('修改触发条件', () => { target.once = v; }))));
    }
    for (const key of (def.ui || [])) {
      const node = this._field(key, target, ev);
      if (node) insp.appendChild(node);
    }
    if (this.sel.kind === 'trigger' && def.h) {
      insp.appendChild(el('div', { class: 'hint', style: { marginTop: '4px' }, text: def.h }));
    }
    if (this.sel.kind === 'action') {
      insp.appendChild(this._portSection(target));
      insp.appendChild(el('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
        el('button', { class: 'mini', text: '更换类型…', onclick: (e) => this._actionPicker(ev, this.sel.i, e.target) }),
        el('button', { class: 'mini', text: '🗑 删除', onclick: () => this.delAction(ev, this.sel.i) })));
    }
    insp.appendChild(el('div', { style: { marginTop: '10px', fontSize: 'calc(10.5px * var(--ui-s) * var(--ui-fs))', color: 'var(--ink-faint)', lineHeight: '1.6' },
      text: '提示：从块右侧的输出口拖到另一个块的输入口即可连线（执行边走实线，值接线走虚线）；Shift+拖端口是旧的调整顺序手势，也可用右键「上移 / 下移」。右键端口可「断开此连线」。数字 / 对象字段可填 #变量名。' }));
  }

  /* ---------- 接口小节：列出当前端口 + 暴露参数 ---------- */
  _portSection(a) {
    const box = el('div', { class: 'ports-sec' });
    box.appendChild(el('div', { class: 'pg-head', style: { cursor: 'default', marginTop: '8px' }, text: '接口' }));
    const line = (t, items) => {
      const wrap = el('div', { class: 'port-line' });
      wrap.appendChild(el('span', { class: 'pl', text: t }));
      if (!items.length) wrap.appendChild(el('span', { class: 'pv', style: { color: 'var(--ink-faint)' }, text: '（无）' }));
      else for (const it of items) wrap.appendChild(el('span', { class: 'pv' + (it.on ? ' on' : ''), title: it.h || '', text: it.l }));
      return wrap;
    };
    const valueOnly = isValueOnly(a);
    if (!valueOnly) {
      box.appendChild(line('执行输出', outsOf(a).map((o) => ({ l: o.l || '输出' }))));
      box.appendChild(line('执行输入', [{ l: '执行入口（可接多条）' }]));
    }
    box.appendChild(line('值输入', insOf(a).map((x) => ({ l: (x.l || x.k) + (a.inputs && a.inputs[x.k] ? ' ←已接' : ''), on: !!(a.inputs && a.inputs[x.k]), h: x.k }))));
    box.appendChild(line('值输出', valueOutsOf(a).map((x) => ({ l: x.l || '值' }))));
    /* 暴露参数菜单 */
    const exp = exposableOf(a);
    const not = exp.filter((k) => !(a.expose || []).includes(k));
    box.appendChild(el('button', {
      class: 'mini', text: '＋ 暴露参数…', disabled: !not.length,
      title: not.length ? '把参数暴露成值输入口，供外部接线' : '该块没有更多可暴露的参数',
      onclick: (e) => {
        if (!not.length) return;
        const body = el('div', {});
        for (const k of not) body.appendChild(el('button', {
          class: 'pitem', style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px' },
          text: (FIELD_LABELS[k] || k) + '  ' + k,
          onclick: () => { p.remove(); this._toggleExpose(a, k, true); },
        }));
        const p = popover({ title: '选择要暴露的参数', body, anchor: e.target, width: 220 });
      },
    }));
    return box;
  }

  /** 暴露 / 取消暴露某个参数（同一闭包内清理对应的值接线） */
  _toggleExpose(a, key, on) {
    this.ed.edit(on ? '暴露参数' : '取消暴露参数', () => {
      const list = Array.isArray(a.expose) ? a.expose.slice() : [];
      if (on) { if (!list.includes(key)) list.push(key); }
      else {
        a.expose = list.filter((k) => k !== key);
        if (a.inputs && a.inputs[key]) {
          delete a.inputs[key];
          if (!Object.keys(a.inputs).length) a.inputs = null;
        }
        return;
      }
      a.expose = list;
    }, {});
    this.refresh();
  }

  /** 属性行标签：可暴露的字段旁注入「暴露」开关（row 的 label 支持传节点） */
  _lab(a, key, text, titled) {
    if (!a || !exposableOf(a).includes(key)) return text;
    const on = Array.isArray(a.expose) && a.expose.includes(key);
    const b = el('button', {
      class: 'exp-btn' + (on ? ' on' : ''), type: 'button',
      title: on ? '已暴露为值输入口（点击取消）' : '暴露为值输入口，供外部接线',
      text: on ? '◉' : '◎',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); this._toggleExpose(a, key, !on); },
    });
    return el('span', { class: 'lb-wrap' }, el('span', { text: titled || text }), b);
  }

  /** 某字段是否已接线（属性面板显示用） */
  _wired(a, key) {
    return !!(a && a.inputs && a.inputs[key]);
  }

  _setTriggerType(ev, type) {
    this.ed.edit('修改触发类型', () => {
      const t = ev.trigger;
      t.type = type;
    }, {});
    this.sel = { kind: 'trigger' };
    this.refresh();
  }

  _set(label, fn) {
    this.ed.edit(label, fn, {});
    this.refresh();
  }

  _switch(on, onChange) {
    const b = el('button', { class: 'switch' + (on ? ' on' : ''), type: 'button' });
    b.addEventListener('click', () => {
      b.classList.toggle('on');
      onChange(b.classList.contains('on'));
    });
    return b;
  }

  /* ---------- 模型 / 皮肤选择窗口 ---------- */
  /** 打开网格选择窗口：卡片列出模型素材（带皮肤徽标），点一张即选中 */
  _pickMorphModel(a) {
    const lvId = (this.ed.level && this.ed.level.id) || '';
    return modal({
      title: '选择模型 / 皮肤',
      cls: 'wide',
      body: (ctx) => {
        const grid = el('div', { class: 'pick-grid' });
        const rebuild = async () => {
          let all = [];
          try { all = await store.listAssets(null); } catch (e) { /* ignore */ }
          const list = morphModelList(all, lvId);
          _modelAssets = list;
          clear(grid);
          if (!list.length) {
            grid.appendChild(el('div', { class: 'pick-empty', text: '还没有模型素材，先点上面的「＋ 导入模型」' }));
            return;
          }
          for (const x of list) grid.appendChild(this._modelPickCard(x, a.morphAsset, lvId, () => ctx.close(x.id)));
        };
        const toolbar = el('div', { class: 'pick-toolbar' },
          el('button', {
            class: 'mbtn sm', text: '＋ 导入模型', title: '导入 .glb / .gltf / .obj 角色模型',
            onclick: async () => {
              // 统一走素材管理器导入：素材库里也会同步出现
              const rec = await importAssetFile('model', { ed: this.ed });
              if (!rec) return;
              this._set('导入模型素材', () => { a.morphAsset = rec.id; });
              await rebuild();
            },
          }),
        );
        rebuild();
        return el('div', {}, toolbar, grid);
      },
      buttons: [{ label: '关闭', value: null }],
      escValue: null,
    }).then((v) => {
      if (typeof v === 'string' && v) this._set('选择模型资产', () => { a.morphAsset = v; });
    });
  }

  /** 一张模型卡片：图标 + 名字 + 皮肤 / 全局徽标 */
  _modelPickCard(x, curId, lvId, onPick) {
    return el('div', {
      class: 'pick-card' + (x.id === curId ? ' sel' : ''),
      title: x.name || x.id,
      onclick: onPick,
    },
      el('div', { class: 'pick-ico', text: '🧍' }),
      el('div', { class: 'pick-name', text: x.name || x.id }),
      el('div', { class: 'pick-tags' },
        x.skin ? el('span', { class: 'pick-tag skin', text: skinTag(x.skin) }) : null,
        ((x.level || '') === '' && lvId) ? el('span', { class: 'pick-tag', text: '全局' }) : null,
      ),
    );
  }

  /** 「天空球渐变」的一行：天空下拉（内置 + 本关全景图素材 + 无）+ 打开天空工坊 */
  _skyRow(a, key, label, hint) {
    const loader = async () => {
      const all = await store.listAssets();
      _skyAssets = (all || []).filter((x) => x.kind === 'texture');
      const out = [{ v: '', l: skyName('') }];
      for (const x of BUILTIN_SKIES) out.push({ v: x.id, l: x.label });
      out.push({ v: 'none', l: skyName('none') });
      for (const x of _skyAssets) out.push({ v: 'asset:' + x.id, l: '全景图：' + x.name, id: x.id });
      // 引用已经失效（素材被删）时也要让用户看见，别静默回落成「沿用当前天空」
      if (a[key] && !BUILTIN_SKIES.some((x) => x.id === a[key]) && a[key] !== 'none'
        && !_skyAssets.some((x) => 'asset:' + x.id === a[key])) {
        out.push({ v: a[key], l: a[key].startsWith('asset:') ? '全景图素材（已失效）' : a[key] });
      }
      return out;
    };
    const sel = new GridSelect({
      value: a[key] || '', options: loader,
      onChange: (v) => this._set('选择天空', () => { a[key] = v; }),
    });
    return row(this._lab(a, key, label, hint), sel, el('button', {
      class: 'mini', text: '工坊', title: '打开天空工坊：程序化生成 / 烘焙等距柱状全景图',
      onclick: () => openSkyLab(this.ed),
    }));
  }

  _field(key, a, ev) {
    const lv = this.ed.level;
    switch (key) {
      case 'object':
        return row(this._lab(a, 'objectId', '对象'), objRefButton({
          ed: this.ed, get: () => a.objectId || '', allowEmpty: true,
          commit: (id) => this._set('选择事件对象', () => { a.objectId = id; }),
        }));
      case 'property':
        return row('属性', optSelect(
          Object.keys(OBJECT_PROPS_FOR_EVENTS).map((k) => ({ v: k, l: OBJECT_PROPS_FOR_EVENTS[k].label })),
          a.property,
          (v) => this._set('选择属性', () => {
            const old = OBJECT_PROPS_FOR_EVENTS[a.property] || {};
            const nd = OBJECT_PROPS_FOR_EVENTS[v] || {};
            a.property = v;
            if (!a._keepValue) {
              if (nd.type === 'vec3' && !Array.isArray(a.value)) a.value = [0, 0, 0];
              if (old.type === 'vec3' && Array.isArray(a.value) && nd.type !== 'vec3') a.value = 0;
            }
          })));
      case 'value':
        if (a.type === 'npcSpeed') {
          return row(this._lab(a, 'value', '速度(stud/s)'), el('input', {
            type: 'number', step: 0.5, min: 0, value: Number(a.value) || 0,
            onchange: (e) => this._set('修改速度', () => { a.value = Math.max(0, Number(e.target.value) || 0); }),
          }));
        }
        if (a.type === 'npcMoveTo') {
          return row(this._lab(a, 'value', '速度(0=自身)'), el('input', {
            type: 'number', step: 0.5, min: 0, value: Number(a.value) || 0,
            onchange: (e) => this._set('修改速度', () => { a.value = Math.max(0, Number(e.target.value) || 0); }),
          }));
        }
        return this._valueRow(a);
      case 'vec': {
        if (a.type === 'npcLookAt' && (a.npcFace || 'player') !== 'point') return null;   // 面向玩家时坐标无效
        const nm = (a.type === 'npcMoveTo' || a.type === 'npcWarp' || a.type === 'npcLookAt') ? '目标坐标' : '位移';
        return this._vecRow(a, nm, a.vec);
      }
      case 'time':
        if (a.type === 'wait' && a.waitMode === 'until') return null;   // 等待直到模式不需要秒数
        return row(this._lab(a, 'time', a.type === 'showNotice' ? '显示时长(秒)' : '时长(秒)'), el('input', {
          type: 'number', step: 0.05, min: 0, max: 600, value: a.time,
          onchange: (e) => this._set('修改时长', () => { a.time = Math.max(0, Number(e.target.value) || 0); }),
        }));
      case 'easing':
        return row('缓动', optSelect(EASINGS.map((x) => ({ v: x, l: x })), a.easing, (v) => this._set('修改缓动', () => { a.easing = v; })));
      case 'anim':
        return row('动画', optSelect(
          [{ v: '', l: '（未指定）' }].concat((lv.animations || []).map((x) => ({ v: x.id, l: x.name || x.id }))),
          a.animId, (v) => this._set('选择动画', () => { a.animId = v; })));
      case 'sound':
        return row(this._lab(a, 'sound', '音效'), optSelect(Object.keys(SOUNDS).map((k) => ({ v: k, l: k })), a.sound, (v) => this._set('选择音效', () => { a.sound = v; })));
      case 'volume':
        return row(this._lab(a, 'volume', '音量'), el('input', {
          type: 'range', min: 0, max: 1, step: 0.05, value: a.volume,
          oninput: (e) => { a.volume = Number(e.target.value) || 0; },
          onchange: () => this._set('修改音量', () => {}),
        }));
      case 'playerField':
        return row('字段', optSelect(
          Object.keys(PLAYER_FIELDS).map((k) => ({ v: k, l: PLAYER_FIELDS[k].label })),
          a.playerField, (v) => this._set('选择玩家字段', () => { a.playerField = v; })));
      /* ---------- 重力变化 ---------- */
      case 'gravity': {
        const box = el('div', {});
        box.appendChild(row('作用目标', optSelect([
          { v: 'world', l: '全局世界（所有物体，含玩家）' },
          { v: 'player', l: '仅玩家' },
          { v: 'both', l: '世界与玩家' },
        ], a.gravityTarget || 'world', (v) => this._set('修改作用目标', () => { a.gravityTarget = v; }))));
        box.appendChild(row(this._lab(a, 'gravityDir', '重力方向'),
          Array.isArray(a.vec) ? el('span', { text: vecStr(a.vec) }) : el('span', { text: '(0, -1, 0)' })));
        box.appendChild(this._vecRow(a, '', Array.isArray(a.vec) ? a.vec : [0, -1, 0], 'vec', '修改重力方向'));
        box.appendChild(row(this._lab(a, 'gravityPower', '重力强度'), el('input', {
          type: 'number', step: 0.05, value: a.gravityPower === undefined ? 1 : a.gravityPower,
          style: { width: '90px' }, title: '1 = 标准重力，0 = 失重，负数 = 反向',
          onchange: (e) => this._set('修改重力强度', () => {
            const v = Number(e.target.value);
            a.gravityPower = isFinite(v) ? v : 1;
          }),
        })));
        box.appendChild(row(this._lab(a, 'time', '时长(秒)'), el('input', {
          type: 'number', step: 0.05, min: 0, value: a.time, style: { width: '90px' },
          onchange: (e) => this._set('修改时长', () => { a.time = Math.max(0, Number(e.target.value) || 0); }),
        })));
        box.appendChild(row('缓动', optSelect(EASINGS.map((x) => ({ v: x, l: x })), a.easing,
          (v) => this._set('修改缓动', () => { a.easing = v; }))));
        box.appendChild(row('', el('div', { class: 'hint', text: '方向会自动归一化；重力强度 = 标准重力(196.2) × 关卡重力倍率 × 该值；时长 > 0 时方向与强度平滑过渡。' })));
        return box;
      }
      /* ---------- 玩家 morph ---------- */
      case 'morphSource':
        return el('div', {},
          row('模式', optSelect(MORPH_SOURCES, a.morphMode || 'preset',
            (v) => this._set('选择 morph 模式', () => { a.morphMode = v; }))),
          row('', el('div', { class: 'hint', text: 'morph 只在游玩 / 试玩中生效' })));
      case 'morphFit': {
        const mode = a.morphMode || 'preset';
        if (mode === 'default') {
          return row('说明', el('div', { class: 'hint', text: '还原为关卡默认形象' }));
        }
        if (mode === 'preset') {
          return row('预设形象', optSelect(presetOptions(), a.morphPreset || 'classic',
            (v) => this._set('选择预设形象', () => { a.morphPreset = v; })));
        }
        /* 模型 / 皮肤：素材一多下拉就拖不完，改成按钮打开网格选择窗口 */
        const lvId = (this.ed.level && this.ed.level.id) || '';
        const curBox = el('div', { class: 'pick-cur' });
        const renderCur = () => {
          clear(curBox);
          const rec = _modelAssets.find((x) => x.id === a.morphAsset) || null;
          const nm = modelName(a.morphAsset);
          curBox.appendChild(el('span', { class: 'pick-cur-name', text: nm, title: nm }));
          if (rec && rec.skin) curBox.appendChild(el('span', { class: 'pick-tag skin', text: skinTag(rec.skin) }));
          curBox.appendChild(el('button', {
            class: 'mini', text: '选择…', title: '选择模型 / 皮肤',
            onclick: () => this._pickMorphModel(a),
          }));
          if (a.morphAsset) curBox.appendChild(el('button', {
            class: 'mini', text: '✕', title: '清除',
            onclick: () => this._set('清除模型资产', () => { a.morphAsset = ''; }),
          }));
        };
        renderCur();
        // 每次都重新拉：素材库里的重命名 / 删除、皮肤编辑器新存的皮肤都要能立刻反映
        store.listAssets(null).then((all) => {
          _modelAssets = morphModelList(all, lvId);
          renderCur();
        }).catch(() => { /* 读不到素材时保持原样 */ });
        const num = (key, step) => el('input', {
          type: 'number', step, value: a[key], style: { width: '80px' },
          onchange: (e) => this._set('修改模型适配', () => {
            const v = Number(e.target.value);
            a[key] = isFinite(v) ? v : 0;
          }),
        });
        return el('div', {},
          row('模型资产', curBox),
          row('整体缩放', num('morphScale', 0.05)),
          row('朝向偏移(度)', num('morphYaw', 5)),
          row('垂直偏移', num('morphY', 0.1)));
      }
      case 'tool':
        return row('工具类型', optSelect(Object.keys(TOOL_DEFS).map((k) => ({ v: k, l: TOOL_DEFS[k].label })), a.tool, (v) => this._set('选择工具', () => { a.tool = v; })));
      case 'toolref': {
        return row('或复制该工具对象', objRefButton({
          ed: this.ed, get: () => a.toolId || '', allowEmpty: true,
          filter: (o) => o.type === 'tool', hint: '需要选类型为「工具」的对象',
          commit: (id) => this._set('选择工具对象', () => { a.toolId = id; }),
        }));
      }
      case 'varName':   // readVar / mathExpr 的 varName（写回变量）与 var 同义
      case 'var':
        return row(this._lab(a, 'varName', a.type === 'mathExpr' ? '写回变量' : '变量名'), el('input', {
          type: 'text', value: a.varName || '',
          onchange: (e) => this._set('修改变量名', () => { a.varName = e.target.value || 'var1'; }),
        }));
      case 'op':
        return row('运算', optSelect(OP_OPTIONS, a.op, (v) => this._set('修改运算', () => { a.op = v; })));
      case 'cond':
        return row(this._lab(a, 'cond', '条件变量'), el('input', {
          type: 'text', value: a.cond || '',
          onchange: (e) => this._set('修改条件', () => { a.cond = e.target.value || 'var1'; }),
        }));
      case 'repeat':
        return row('重复', this._switch(!!a.repeat, (v) => this._set('修改重复', () => { a.repeat = v; })));
      case 'effect':
        return row(this._lab(a, 'effect', '特效'), optSelect(EFFECTS, a.effect, (v) => this._set('选择特效', () => { a.effect = v; })));
      case 'skyFrom':
        return this._skyRow(a, 'fromSky', '起始天空', '从这张天空开始淡出；留空 = 从关卡当前天空开始');
      case 'skyTo':
        return this._skyRow(a, 'toSky', '渐变到', '淡入到这张天空；与起始天空相同则不做任何事');
      case 'noticeText':
        return row(this._lab(a, 'noticeText', '提示内容'), el('textarea', {
          class: 'inp', style: { minHeight: '52px', width: '100%' }, value: a.noticeText || '',
          onchange: (e) => this._set('修改提示内容', () => { a.noticeText = e.target.value; }),
        }));
      case 'noticeKind':
        return row('提示样式', optSelect(NOTICE_KINDS, a.noticeKind || 'info',
          (v) => this._set('修改提示样式', () => { a.noticeKind = v; })));

      /* ---------- 随机数 / 数组 / 循环 字段 ---------- */
      case 'range': {
        const mk = (key, val) => el('input', {
          type: 'number', step: 0.1, value: Number(val) || 0, style: { width: '66px' },
          onchange: (e) => this._set('修改随机范围', () => { a[key] = e.target.value === '' ? 0 : (isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value)); }),
        });
        return el('div', { class: 'vecrow' }, el('label', {}, this._lab(a, 'rmin', '范围')),
          el('div', { class: 'vs', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            mk('rmin', a.rmin), el('span', { style: { color: 'var(--ink-faint)' }, text: '~' }), mk('rmax', a.rmax),
            this._switch(a.isInt !== false, (v) => this._set('修改取整', () => { a.isInt = v; })),
            el('span', { style: { fontSize: 'calc(10.5px * var(--ui-s) * var(--ui-fs))', color: 'var(--ink-faint)' }, text: '取整' })));
      }
      case 'chance':
        return row(this._lab(a, 'chance', '概率%'), el('input', {
          type: 'number', step: 5, min: 0, max: 100, value: a.chance,
          onchange: (e) => this._set('修改概率', () => { a.chance = clampNum(Number(e.target.value), 0, 100); }),
        }));
      case 'srcVar':
        return row(this._lab(a, 'srcVar', '源数组名'), el('input', {
          type: 'text', value: a.srcVar || '', style: { width: '110px' },
          onchange: (e) => this._set('修改数组名', () => { a.srcVar = e.target.value || 'arr'; }),
        }));
      case 'destVar':
        return row(this._lab(a, 'destVar', '结果变量名'), el('input', {
          type: 'text', value: a.destVar || '', style: { width: '110px' },
          onchange: (e) => this._set('修改变量名', () => { a.destVar = e.target.value || 'tmp'; }),
        }));
      case 'list':
        return row('初始值', el('input', {
          type: 'text', value: a.list ?? '', placeholder: '逗号分隔，如 1,2,3',
          onchange: (e) => this._set('修改初始值', () => { a.list = e.target.value; }),
        }));
      case 'index':
        return row(this._lab(a, 'index', '下标'), el('input', {
          type: 'number', step: 1, value: a.index,
          onchange: (e) => this._set('修改下标', () => { a.index = Math.round(Number(e.target.value) || 0); }),
        }));
      case 'count':
        return row(this._lab(a, 'count', '次数'), el('input', {
          type: 'text', value: a.count ?? 3, title: '可填 #变量名',
          onchange: (e) => this._set('修改次数', () => { a.count = e.target.value === '' ? 0 : (isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value)); }),
        }));
      case 'maxIter':
        return row(this._lab(a, 'maxIter', '最大次数'), el('input', {
          type: 'number', step: 1, min: 1, max: 100000, value: a.maxIter, title: '防止死循环',
          onchange: (e) => this._set('修改上限', () => { a.maxIter = Math.max(1, Math.round(Number(e.target.value) || 100)); }),
        }));
      case 'audio': {
        const loader = streamAssetOptions('audio', {
          thumbs: false,
          head: [{ v: '', l: '（无）' }],
          missing: (all) => (a.audio && !all.some((x) => String(x.v) === String(a.audio)))
            ? { v: a.audio, l: (a.audio.startsWith('asset:') ? '音频素材' : a.audio) + '（已失效）' } : null,
        });
        const sel = new GridSelect({
          value: a.audio || '', options: loader,
          onChange: (v) => this._set('选择音频文件', () => { a.audio = v; }),
        });
        return row('音频文件', sel, el('button', {
          class: 'mini', text: '▶', title: '试听',
          onclick: () => {
            if (!a.audio) return;
            audio.ensure();
            audio.load(a.audio);
            if (!audio.playRef(a.audio, { volume: 1, dest: 'sfx' })) toast('音频正在加载，稍后自动可听（或文件已失效）', '', 2200);
          },
        }));
      }
      case 'loopAudio':
        return row('循环播放', this._switch(!!a.loopAudio, (v) => this._set('修改循环', () => { a.loopAudio = v; })));

      /* ---------- 等待 / 等待直到 ---------- */
      case 'waitMode':
        return row('等待方式', optSelect(
          [{ v: 'time', l: '等待 N 秒' }, { v: 'until', l: '等待直到接口为真' }],
          a.waitMode || 'time',
          (v) => this._set('修改等待方式', () => { a.waitMode = v; })));
      case 'untilCond': {
        if (a.waitMode !== 'until') return null;
        return el('div', {},
          row('继续条件', el('input', {
            type: 'text', value: a.untilCond || '', placeholder: '变量名（留空则等接口收到 true）',
            title: '留空时只看左侧「until」值输入口是否收到 true',
            onchange: (e) => this._set('修改继续条件', () => { a.untilCond = e.target.value; }),
          })),
          row('', el('div', { class: 'hint', text: '接口优先：值输入口「until」收到 true 才继续；未接线时按变量名取真假。' })));
      }

      /* ---------- 高级运算 ---------- */
      case 'formula': {
        const hint = el('div', { class: 'hint' });
        const setHint = (v) => {
          const err = v ? formulaError(v) : null;
          hint.style.color = err ? 'var(--bad)' : 'var(--ink-faint)';
          hint.textContent = err ? ('语法错误：' + err)
            : (v ? '语法正确。可用 a b c d x y z w 及 sin/cos/log/ln/clamp…' : '留空 ⇒ 结果 0 且不写变量');
        };
        setHint(a.formula || '');
        return el('div', {},
          row(this._lab(a, 'formula', '公式'), el('input', {
            type: 'text', class: 'inp', value: a.formula || '',
            placeholder: '如 (a+b-c*d/x+y^2)*sin(y)',
            oninput: (e) => setHint(e.target.value),
            onchange: (e) => this._set('修改公式', () => { a.formula = e.target.value; }),
          })),
          row('', hint));
      }
      case 'mathArgs': {
        const box = el('div', {});
        for (const m of MATH_VARS) {
          const wired = this._wired(a, m.k);
          box.appendChild(row(this._lab(a, m.k, m.v),
            el('input', {
              type: 'number', step: 0.1, value: Number(a[m.k]) || 0, style: { width: '78px' },
              disabled: wired, title: wired ? '已接线：运行时用接线值覆盖' : '字面量',
              onchange: (e) => this._set('修改操作数', () => { a[m.k] = Number(e.target.value) || 0; }),
            }),
            el('span', { class: 'wire-tag' + (wired ? ' on' : ''), text: wired ? '已接线' : '字面量' })));
        }
        box.appendChild(row('', el('div', { class: 'hint', text: '公式里用 a b c d x y z w 引用上面八个操作数；点标签旁 ◎ 可暴露成值输入口。' })));
        return box;
      }

      /* ---------- 对象生成 / 克隆 / 设为子对象 ---------- */
      case 'templateId':
        return row(this._lab(a, 'templateId', '模板对象'), objRefButton({
          ed: this.ed, get: () => a.templateId || '', allowEmpty: true,
          commit: (id) => this._set('选择模板对象', () => { a.templateId = id; }),
        }));
      case 'parent':
        return row(this._lab(a, 'parent', '父对象'), objRefButton({
          ed: this.ed, get: () => a.parent || '', allowEmpty: true,
          commit: (id) => this._set('选择父对象', () => { a.parent = id; }),
        }));
      case 'spawnWhere': {
        const box = el('div', {});
        box.appendChild(row('位置方式', optSelect(OBJECT_POS_MODES, a.posMode || 'rel',
          (v) => this._set('修改位置方式', () => { a.posMode = v; }))));
        if (a.posMode === 'rel') {
          box.appendChild(row('参照对象', objRefButton({
            ed: this.ed, get: () => a.posRef || '', allowEmpty: true,
            commit: (id) => this._set('选择参照对象', () => { a.posRef = id; }),
          })));
        }
        box.appendChild(row('', el('div', {
          class: 'hint',
          text: a.posMode === 'trigger' ? '以触发对象的位置为基准再叠加位移'
            : a.posMode === 'rel' ? '参照对象的世界坐标 + 位移' : '绝对坐标；位移分量可填 #变量名',
        })));
        return box;
      }
      case 'spawnOpts':
        return el('div', {},
          row('深拷贝子树', this._switch(!!a.deepTree, (v) => this._set('修改深拷贝', () => { a.deepTree = v; }))),
          row('', el('div', { class: 'hint', text: '开启后连子对象一起复制（内部父子关系会重映射）' })));
      case 'keepWorld':
        return row('保持世界位置', this._switch(a.keepWorld !== false,
          (v) => this._set('修改保持世界位置', () => { a.keepWorld = v; })));

      /* ---------- if / 否则如果 / 否则 ---------- */
      case 'ifConds': {
        const box = el('div', {});
        const mkCond = (o, label, delFn) => {
          const r = el('div', { class: 'cond-row' }, el('span', { class: 'cond-lab', text: label }));
          r.appendChild(el('input', {
            type: 'text', value: o.cond || '', placeholder: '变量', style: { width: '66px' },
            onchange: (e) => this._set('修改条件', () => { o.cond = e.target.value || 'var1'; }),
          }));
          r.appendChild(optSelect(OP_OPTIONS, o.op, (v) => this._set('修改运算', () => { o.op = v; }), 'op').el);
          r.appendChild(el('input', {
            type: 'text', value: (o.value === undefined ? 0 : o.value), style: { width: '60px' }, title: '可填 #变量名',
            onchange: (e) => this._set('修改比较值', () => { o.value = e.target.value; }),
          }));
          if (delFn) r.appendChild(el('button', { class: 'mini', text: '✕', title: '删除这一条否则如果', onclick: delFn }));
          return r;
        };
        box.appendChild(mkCond(a, '满足', null));
        (a.elifs || []).forEach((e, i) => box.appendChild(mkCond(e, '否则如果' + (i + 1), () => this.delElif(a, i))));
        box.appendChild(el('button', { class: 'mini', text: '＋ 添加否则如果', onclick: () => this.addElif(a) }));
        box.appendChild(el('div', { class: 'hint', style: { marginTop: '4px' }, text: '「否则」槽无额外条件；全不满足且「否则」没连线时，该支路结束。' }));
        return box;
      }
      /* ---------- 脚本 / 表达式 ---------- */
      case 'code': {
        const isExpr = a.type === 'evalExpr';
        const src = String(a.code || '');
        const lines = src ? src.split('\n') : [];
        const first = (lines[0] || '').trim();
        const err = src ? scriptError(src, isExpr) : null;
        return el('div', { class: 'code-sec' },
          row('', el('div', { class: 'code-head' },
            el('span', { class: 'code-tip', text: isExpr ? 'JS 表达式：结果作为值输出' : 'JS 代码块：读写世界的一切' }))),
          el('div', { class: 'code-mini', title: src || '（空代码）' },
            el('div', { class: 'cm-line', text: src ? (first || '（以空行开头）') + (lines.length > 1 ? ' …' : '') : '（空代码）' }),
            el('div', { class: 'cm-meta' },
              el('span', { class: 'cm-ok' + (err ? ' bad' : ''), text: err ? '语法错误' : '语法正常' }),
              el('span', { text: lines.length + ' 行' }))),
          el('button', {
            class: 'mini', text: '✎ 打开代码编辑器',
            onclick: () => openCodeWindow({
              value: src, expr: isExpr,
              onChange: (v) => this._set('修改代码', () => { a.code = v; }),
            }),
          }));
      }

      /* ---------- 射线检测 ---------- */
      case 'rayFromTo': {
        const box = el('div', {});
        box.appendChild(row('起点', optSelect(RAY_FROM_MODES, a.rayFromMode || 'player',
          (v) => this._set('修改射线起点', () => { a.rayFromMode = v; }))));
        if (a.rayFromMode === 'object') {
          box.appendChild(row('起点对象', objRefButton({
            ed: this.ed, get: () => a.rayFromObj || '', allowEmpty: true,
            commit: (id) => this._set('选择起点对象', () => { a.rayFromObj = id; }),
          })));
        } else if (a.rayFromMode === 'abs') {
          box.appendChild(this._vecRow(a, '起点坐标', a.rayFromVec, 'rayFromVec', '修改起点坐标'));
        }
        box.appendChild(row('终点', optSelect(RAY_TO_MODES, a.rayToMode || 'dir',
          (v) => this._set('修改射线终点', () => { a.rayToMode = v; }))));
        if (a.rayToMode === 'object') {
          box.appendChild(row('终点对象', objRefButton({
            ed: this.ed, get: () => a.rayToObj || '', allowEmpty: true,
            commit: (id) => this._set('选择终点对象', () => { a.rayToObj = id; }),
          })));
        } else if (a.rayToMode === 'abs') {
          box.appendChild(this._vecRow(a, '终点坐标', a.rayToVec, 'rayToVec', '修改终点坐标'));
        } else {
          box.appendChild(this._vecRow(a, '方向', a.rayToVec, 'rayToVec', '修改射线方向'));
        }
        box.appendChild(row('', el('div', { class: 'hint', text: a.rayToMode === 'dir'
          ? '方向会自动归一化，长度由下面的「射程」决定（方向分量可填 #变量名）。'
          : '从起点指向终点；命中点落在两点之间才算命中。' })));
        return box;
      }
      case 'rayOut': {
        const box = el('div', {});
        box.appendChild(row(this._lab(a, 'range', '射程长度'), el('input', {
          type: 'number', step: 1, min: 0, value: a.range, style: { width: '90px' }, title: '可填 #变量名',
          onchange: (e) => this._set('修改射程', () => {
            a.range = e.target.value === '' ? 0
              : (isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value));
          }),
        })));
        const mk = (key, label, ph) => row(label, el('input', {
          type: 'text', value: a[key] || '', style: { width: '110px' }, placeholder: ph,
          onchange: (e) => this._set('修改结果变量名', () => { a[key] = e.target.value; }),
        }));
        box.appendChild(mk('destObj', '命中对象 id →', 'hitObj'));
        box.appendChild(mk('destPos', '命中坐标 →', 'hitPos'));
        box.appendChild(mk('destNormal', '命中法线 →', 'hitNormal'));
        box.appendChild(mk('destDist', '命中距离 →', 'hitDist'));
        box.appendChild(row('', el('div', { class: 'hint', text: '未命中时：对象 id 为空串，坐标 / 法线为零向量，距离为 -1。变量名留空则不写。' })));
        return box;
      }

      /* ---------- 2D 平台模式 ---------- */
      case 'platform': {
        const box = el('div', {});
        box.appendChild(row('模式', optSelect([
          { v: 'on', l: '进入 2D 平台模式' },
          { v: 'off', l: '退出（回到普通视角）' },
        ], a.platMode || 'on', (v) => this._set('修改平台模式', () => { a.platMode = v; }))));
        if ((a.platMode || 'on') !== 'off') {
          box.appendChild(this._vecRow(a, '基准点 P', a.platPoint, 'platPoint', '修改基准点'));
          box.appendChild(this._vecRow(a, '朝向 n', a.platNormal, 'platNormal', '修改朝向'));
          box.appendChild(row('镜头距离', el('input', {
            type: 'number', step: 1, min: 1, value: a.platDist, style: { width: '90px' },
            onchange: (e) => this._set('修改镜头距离', () => { a.platDist = Math.max(1, Number(e.target.value) || 22); }),
          })));
          box.appendChild(row('', el('div', { class: 'hint', text: '相机以 P 为基准、只朝 n 方向，在与 n 垂直的平面内跟随玩家移动；进入后鼠标解绑可自由移动。' })));
        }
        return box;
      }

      /* ---------- 读取属性 ---------- */
      case 'propTarget':
        return row('读取目标', optSelect([
          { v: 'object', l: '关卡对象' }, { v: 'player', l: '玩家' },
          { v: 'world', l: '世界（API）' }, { v: 'session', l: '会话' },
        ], a.propTarget || 'object', (v) => this._set('修改读取目标', () => { a.propTarget = v; })));
      case 'propPath': {
        const box = el('div', {});
        if ((a.propTarget || 'object') === 'object') {
          box.appendChild(row(this._lab(a, 'objectId', '对象'), objRefButton({
            ed: this.ed, get: () => a.objectId || '', allowEmpty: true,
            commit: (id) => this._set('选择事件对象', () => { a.objectId = id; }),
          })));
        }
        box.appendChild(row('路径', el('input', {
          type: 'text', class: 'inp', value: a.propPath || '',
          placeholder: (a.propTarget || 'object') === 'object'
            ? '如 position  /  rec.body.velocity.y  /  surface.visible'
            : '如 oxygen  /  time  /  env.inLiquid',
          onchange: (e) => this._set('修改读取路径', () => { a.propPath = e.target.value; }),
        })));
        box.appendChild(row('', el('div', { class: 'hint', text: '用 . 逐层深入（如 position.y、rec.body.velocity）；对象目标支持 rec. 前缀读运行时记录。读不到时写空串。' })));
        return box;
      }
      /* ---------- NPC ---------- */
      case 'npc':
        return row(this._lab(a, 'npcId', 'NPC'), objRefButton({
          ed: this.ed, get: () => a.npcId || '', allowEmpty: true,
          filter: (o) => o.type === 'npc', hint: '需要选类型为「NPC」的对象',
          commit: (id) => this._set('选择 NPC', () => { a.npcId = id; }),
        }));
      case 'npcNode': {
        const o = a.npcId ? getObject(lv, a.npcId) : null;
        const g = normalizeDialogue(o && o.dialogue);
        const opts = [{ v: '', l: g.entry ? ('（入口 · ' + dlgPreview(g, g.entry) + '）') : '（入口 · 对话图为空）' }];
        for (const n of g.nodes) {
          opts.push({ v: n.id, l: dlgPreview(g, n.id) + (n.id === g.entry ? ' ·入口' : '') });
        }
        if (a.node && !g.nodes.some((n) => n.id === a.node)) opts.push({ v: a.node, l: '（已失效 ' + a.node + '）' });
        return el('div', {},
          row(this._lab(a, 'node', '起始节点'), optSelect(opts, a.node || '',
            (v) => this._set('选择起始节点', () => { a.node = v; }))),
          row('', el('div', {
            class: 'hint',
            text: o ? '节点图在 NPC 编辑器的「对话」页编辑；留空则从入口节点开始' : '请先在上面选择一个 NPC',
          })));
      }
      case 'npcText':
        return row(this._lab(a, 'sayText', '台词'), el('input', {
          type: 'text', class: 'inp', value: a.sayText || '', maxlength: 300, placeholder: '说点什么…',
          onchange: (e) => this._set('修改台词', () => { a.sayText = String(e.target.value).slice(0, 300); }),
        }));
      case 'sayTime':
        return row(this._lab(a, 'sayTime', '显示时长(秒)'), el('input', {
          type: 'number', step: 0.5, min: 0.5, max: 60, value: Number(a.sayTime) || 3, style: { width: '90px' },
          onchange: (e) => this._set('修改显示时长', () => { a.sayTime = Math.max(0.5, Number(e.target.value) || 3); }),
        }));
      case 'npcBehavior':
        return row(this._lab(a, 'npcBehavior', '行为'), optSelect(NPC_BEHAVIORS, a.npcBehavior || 'follow',
          (v) => this._set('选择行为', () => { a.npcBehavior = v; })));
      case 'npcKeep':
        return row(this._lab(a, 'npcKeep', '保持距离(stud)'), el('input', {
          type: 'number', step: 0.5, min: 0, max: 200, value: Number(a.npcKeep) || 0, style: { width: '90px' },
          onchange: (e) => this._set('修改保持距离', () => { a.npcKeep = Math.max(0, Number(e.target.value) || 0); }),
        }));
      case 'npcFace':
        return row(this._lab(a, 'npcFace', '面向'), optSelect(
          [{ v: 'player', l: '玩家' }, { v: 'point', l: '指定坐标' }],
          a.npcFace || 'player', (v) => this._set('选择面向', () => { a.npcFace = v; })));
      case 'npcOn':
        return row(this._lab(a, 'npcOn', a.type === 'npcFreeze' ? '冻结' : '显示'), this._switch(a.npcOn !== false,
          (on) => this._set(a.type === 'npcFreeze' ? '切换冻结' : '切换显示', () => { a.npcOn = on; })));
      case 'npcClip':
        return row(this._lab(a, 'npcClip', '动画片段名'), el('input', {
          type: 'text', class: 'inp', value: a.npcClip || '', maxlength: 60, placeholder: '留空 = 恢复自动状态机',
          onchange: (e) => this._set('修改动画片段', () => { a.npcClip = String(e.target.value).slice(0, 60); }),
        }));
      default: return null;
    }
  }

  /** if 块：追加一条「否则如果」 */
  addElif(a) {
    this._set('添加否则如果', () => {
      if (!Array.isArray(a.elifs)) a.elifs = [];
      a.elifs.push({ cond: 'var1', op: '==', value: 0 });
      if (a.next && typeof a.next === 'object') a.next['elif' + (a.elifs.length - 1)] = [];
    });
  }

  /** if 块：删除一条「否则如果」，并在同一闭包内重排 next 的 elifN 槽键 */
  delElif(a, i) {
    this._set('删除否则如果', () => {
      if (!Array.isArray(a.elifs) || !a.elifs[i]) return;
      const old = (a.next && typeof a.next === 'object') ? a.next : null;
      a.elifs.splice(i, 1);
      if (!old) return;
      const m = { then: old.then || [], else: old.else || [] };
      for (let k = 0; k < a.elifs.length; k++) m['elif' + k] = old['elif' + (k >= i ? k + 1 : k)] || [];
      a.next = m;
    });
  }

  _valueRow(a) {
    const P = OBJECT_PROPS_FOR_EVENTS[a.property] || { type: 'number' };
    if (P.type === 'vec3') return this._vecRow(a, '数值', a.value);
    if (P.type === 'bool') {
      return row(this._lab(a, 'value', '数值'), this._switch(!!a.value, (v) => this._set('修改数值', () => { a.value = v; })));
    }
    if (P.type === 'color') {
      return row(this._lab(a, 'value', '数值'), el('input', {
        type: 'color', value: typeof a.value === 'string' && a.value[0] === '#' ? a.value : '#ffffff',
        onchange: (e) => this._set('修改数值', () => { a.value = e.target.value; }),
      }));
    }
    return row(this._lab(a, 'value', '数值'), el('input', {
      type: 'number', step: 0.1, value: Number(a.value) || 0,
      onchange: (e) => this._set('修改数值', () => { a.value = Number(e.target.value) || 0; }),
    }));
  }

  _vecRow(a, label, vec, key = 'vec', undo = '修改向量') {
    const vs = el('div', { class: 'vs' });
    ['X', 'Y', 'Z'].forEach((ax, i) => {
      vs.appendChild(el('div', { class: 'vw' },
        el('label', { text: ax }),
        el('input', {
          type: 'number', step: 0.5, value: Math.round((Number(vec && vec[i]) || 0) * 1000) / 1000,
          onchange: (e) => this._set(undo, () => {
            const v = Array.isArray(a[key]) ? a[key] : (a[key] = [0, 0, 0]);
            v[i] = Number(e.target.value) || 0;
          }),
        })));
    });
    const lb = key === 'vec' ? this._lab(a, 'vec', label) : label;
    // 空标签不渲染（否则会占掉固定宽度把 X/Y/Z 输入框挤到右边，和上面的行错位）
    return el('div', { class: 'vecrow' }, lb ? el('label', {}, lb) : null, vs);
  }

  /** 对象生成块的位置描述（摘要用） */
  _posDesc(a) {
    const m = OBJECT_POS_MODES.find((x) => x.v === a.posMode) || OBJECT_POS_MODES[0];
    if (a.posMode === 'rel') {
      return m.l + (a.posRef ? '：' + objName(this.ed.level, a.posRef) : '（未指定参照）') + ' ' + vecStr(a.vec);
    }
    return m.l + ' ' + vecStr(a.vec);
  }

  /** 射线端点描述（摘要用） */
  _rayPointDesc(a, side) {
    const from = side === 'From';
    const list = from ? RAY_FROM_MODES : RAY_TO_MODES;
    const mode = (from ? a.rayFromMode : a.rayToMode) || 'player';
    const m = list.find((x) => x.v === mode) || list[0];
    if (mode === 'player') return '玩家处';
    if (mode === 'object') return objName(this.ed.level, (from ? a.rayFromObj : a.rayToObj) || '');
    return m.l + vecStr(from ? a.rayFromVec : a.rayToVec);
  }
}

export { objName };