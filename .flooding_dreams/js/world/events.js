/* ============================================================
   事件运行时：变量表 / 触发器 / 动作执行图
   ------------------------------------------------------------
   执行模型（自「线性数组」升级而来，旧关卡行为不变）：
   · 动作仍然存在 ev.actions 数组里（下标稳定，循环配对与其它模块都依赖它）
   · 每个动作有稳定 id；a.next = { 输出槽: [目标动作 id, ...] } 描述执行流
   · a.next 缺失 ⇒ 该节点的 'out' 槽回退到数组里的下一个（旧线性链）
   · 一个槽里放多个目标 = 并行：第一条留在本执行流，其余各 fork 一条新流
     （于是每个并行分支都有自己独立的 wait / 等待直到计时）
   · a.inputs = { 参数字段: { a: 来源动作 id, o: 来源输出槽 } } 描述值接线，
     执行时覆盖该字段的字面量
   ============================================================ */
import * as THREE from 'three';
import {
  ACTION_TYPES, TRIGGER_TYPES, LOOP_START_TYPES, MATH_VARS, outsOf, PLAYER, PHYS,
} from '../config.js';
import { clamp, lerp, ease, deepClone, isVec3, uid, Ease } from '../core/util.js';
import { audio } from '../core/audio.js';
import {
  getObject, getAnim, worldPosition, duplicateObjects, reparentObject,
} from './level.js';
import { createObject } from './objectTypes.js';
import { compileFormula } from './formula.js';
import { createWorldApi, compileScript } from './worldapi.js';
import { resolveSkyTexture } from '../core/textures.js';

const MAX_STEPS_PER_FRAME = 64;
const MAX_LOOP_STEPS = 100000;    // 单次事件执行的循环迭代总上限（防死循环）
const MAX_RUNNERS = 256;          // 并行执行流上限（防循环体内的扇出指数爆炸）
const MAX_VALUE_DEPTH = 16;       // 值接线求值的递归深度上限（防环）
const LOOP_PARK_LIMIT = 3600;     // 循环汇合屏障最多等多少帧（≈60 秒）
const SCRIPT_HANG_MS = 10000;     // 代码块里的循环连续跑多久算卡死（看门狗上限）
const SCRIPT_HANG_MSG = '脚本连续运行超过 10 秒（疑似死循环），已自动截断';

/** 单调时钟（看门狗用；实在没有 performance 就退回 Date.now） */
const nowMs = () => ((typeof performance !== 'undefined' && performance.now)
  ? performance.now() : Date.now());

/** 预扫描动作数组，把 循环开始 ↔ 循环结束 配对（按动作 id，供运行时跳转） */
function pairLoops(actions) {
  const s2e = new Map(), e2s = new Map();
  const stack = [];
  for (const a of actions) {
    if (!a) continue;
    if (LOOP_START_TYPES.includes(a.type)) stack.push(a.id);
    else if (a.type === 'loopEnd') {
      const s = stack.pop();
      if (s === undefined) continue;
      s2e.set(s, a.id);
      e2s.set(a.id, s);
    }
  }
  return { s2e, e2s };
}

/* ---------- 世界变换（位置 + 旋转累乘，与 builder 的子级锚点同一套语义） ---------- */
const _frT = new THREE.Matrix4();
const _frR = new THREE.Matrix4();
const _frE = new THREE.Euler();

function objectFrame(level, o, out = new THREE.Matrix4()) {
  const chain = [];
  let cur = o;
  let guard = 0;
  while (cur && guard++ < 64) {
    chain.push(cur);
    cur = cur.parent ? getObject(level, cur.parent) : null;
  }
  out.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i];
    const p = c.position || [0, 0, 0];
    const r = c.rotation || [0, 0, 0];
    _frT.makeTranslation(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
    _frR.makeRotationFromEuler(_frE.set(
      THREE.MathUtils.degToRad(Number(r[0]) || 0),
      THREE.MathUtils.degToRad(Number(r[1]) || 0),
      THREE.MathUtils.degToRad(Number(r[2]) || 0)));
    out.multiply(_frT).multiply(_frR);
  }
  return out;
}

export class EventRuntime {
  constructor(builder, ctx = {}) {
    this.b = builder;
    this.level = builder.level;
    this.ctx = ctx;                 // { player, mechanisms, liquids, anims, fx, onWin, onDeath, hint }
    this.vars = {};
    this.runners = [];
    this.tweens = [];
    this.timers = [];
    this.waits = [];                // 脚本 await wait(秒) 的挂起项
    this._hb = nowMs();             // 看门狗心跳：每帧刷新，脚本死循环时它冻结
    this.index = new Map();         // eventId -> event
    this.byObject = new Map();      // objectId -> [eventId]
    this.state = new Map();         // eventId -> { fired, cool, t }
    this.opWatchers = [];
    this.loopPairs = new Map();     // eventId -> { s2e, e2s }（按动作 id 配对）
    this.actionMaps = new Map();    // eventId -> Map(actionId -> action)
    this.created = new Set();       // 本局运行时生成出来的对象 id（仅本局有效）
    this.skyDomes = [];             // 天空球渐变用的临时天穹（仅本局有效，停止时清掉）
    this._skyDirty = false;         // 本局是否被事件改过天空（停止时还原）
    this._skySaved = undefined;     // 改动前的原始天空 id
    this._runSeq = 0;
    this.enabled = true;
    // 脚本动作：WorldAPI 只建一次（不是每帧新建）；脚本错误单独记 Map，
    // 绝不写进动作数据对象 —— 那是会被序列化进关卡的。
    this.api = createWorldApi(this);
    this.scriptErrors = new Map();  // actionId -> 最后一次错误文案
    this.buildIndex();
  }

  buildIndex() {
    this.index.clear(); this.byObject.clear(); this.state.clear(); this.timers.length = 0;
    this.waits.length = 0;
    this.loopPairs.clear(); this.actionMaps.clear();
    for (const ev of this.level.events) {
      this.index.set(ev.id, ev);
      this.state.set(ev.id, { fired: false, cool: 0, t: 0, below: false, lastVar: undefined });
      this.loopPairs.set(ev.id, pairLoops(ev.actions || []));   // 循环配对（仅运行时，不写入关卡）
      this.actionMaps.set(ev.id, this._mapActions(ev));
      const t = ev.trigger;
      if (t.type === 'timer') {
        this.timers.push({ id: ev.id, t: Math.max(0, t.time || 0), repeat: !!t.repeat });
      }
      if (t.objectId) {
        const list = this.byObject.get(t.objectId) || this.byObject.set(t.objectId, []).get(t.objectId);
        list.push(ev.id);
      }
      if (t.type === 'variable') {
        this.opWatchers.push({ id: ev.id, name: t.varName, op: t.op, value: t.value });
      }
    }
  }

  /* ============================================================
     动作图导航
     ============================================================ */
  _mapActions(ev) {
    const m = new Map();
    const list = ev.actions || [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a) continue;
      if (!a.id) a.id = uid('a');            // 旧数据兜底（normalizeEvent 已保证，这里再保一层）
      m.set(a.id, a);                        // 注意：不在数据对象上挂运行时字段（会被序列化）
    }
    return m;
  }

  /** 某动作在数组里的下一个动作 id（旧线性链回退用） */
  _nextId(ev, a) {
    const list = ev.actions || [];
    for (let i = list.indexOf(a) + 1; i < list.length; i++) if (list[i]) return list[i].id;
    return null;
  }

  /** 某动作在指定输出槽上的后继 id 列表 */
  targetsOf(ev, a, slot) {
    if (!a) return [];
    const m = this.actionMaps.get(ev.id) || this._mapActions(ev);
    if (a.next) return (a.next[slot] || []).filter((id) => m.has(id));
    if (slot !== 'out') return [];           // 显式槽只在 next 存在时有意义
    const nx = this._nextId(ev, a);
    return nx && m.has(nx) ? [nx] : [];
  }

  /** 该动作的第一个后继（单目标推进用） */
  firstTarget(ev, id) {
    const m = this.actionMaps.get(ev.id) || this._mapActions(ev);
    const a = m.get(id);
    if (!a) return null;
    const t = this.targetsOf(ev, a, 'out');
    return t.length ? t[0] : null;
  }

  /* ============================================================
     值接线取值：有接线读接线，否则读字面量
     ============================================================ */
  /** '#变量名' → 变量里的字符串；否则原样（对象 id / 名称） */
  objIdOf(v) {
    const s = String(v ?? '').trim();
    if (!s) return '';
    if (s.startsWith('#')) return String(this.getVar(s.slice(1), '') ?? '');
    return s;
  }

  /** NPC 动作：取出目标 NPC 的运行态（NPC 系统不可用时返回 null） */
  npcOf(run, a) {
    const sys = this.ctx && this.ctx.npcs;
    if (!sys || typeof sys.byId !== 'function') return null;
    return sys.byId(this.objIdOf(this.inputStr(run, a, 'npcId', a.npcId)));
  }

  /** NPC 动作的目标 id（供 isTalking / 阻塞等待用） */
  npcIdOf(run, a) {
    return this.objIdOf(this.inputStr(run, a, 'npcId', a.npcId));
  }

  /** 数字字段 */
  inputVal(run, a, key, def = 0) {
    const w = a && a.inputs && a.inputs[key];
    if (w) {
      const v = this.evalValue(run, w.a, w.o);
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    }
    return this.numOf(a && a[key], def);
  }

  /** 字符串字段 */
  inputStr(run, a, key, def = '') {
    const w = a && a.inputs && a.inputs[key];
    if (w) {
      const v = this.evalValue(run, w.a, w.o);
      return v === undefined || v === null ? def : String(v);
    }
    const v = a && a[key];
    return v === undefined || v === null || v === '' ? def : String(v);
  }

  /** 向量字段：接线传来的数组按分量取；标量则三个分量都用同一个值 */
  inputVec(run, a, key, def = [0, 0, 0]) {
    const w = a && a.inputs && a.inputs[key];
    if (w) {
      const v = this.evalValue(run, w.a, w.o);
      if (isVec3(v)) return v.map((n) => Number(n) || 0);
      const n = Number(v) || 0;
      return [n, n, n];
    }
    const v = a && a[key];
    return isVec3(v) ? v.map((n) => this.numOf(n, 0)) : def;
  }

  /** 布尔字段（等待直到的继续条件） */
  inputBool(run, a, key, def = false) {
    const w = a && a.inputs && a.inputs[key];
    if (w) {
      const v = this.evalValue(run, w.a, w.o);
      if (typeof v === 'boolean') return v;
      if (Array.isArray(v)) return v.length > 0;
      const n = Number(v);
      if (Number.isFinite(n)) return n !== 0;
      return !!v && String(v) !== 'false' && String(v) !== '0';
    }
    const v = a && a[key];
    return v === undefined || v === null ? def : !!v && v !== 'false' && v !== '0';
  }

  /**
   * 通用字段取值：有接线走接线，否则按字面量（支持 '#变量名'）。
   * 用于既能写数字也能写「字符串 / 数组项」的字段。
   */
  inputAny(run, a, key, literal) {
    const w = a && a.inputs && a.inputs[key];
    if (w) return this.evalValue(run, w.a, w.o);
    return this.valOf(literal);
  }

  /**
   * 求某个动作的某个值输出通道。纯拉取求值（用到才算），不产生副作用。
   * depth 上限防值接线成环。
   */
  evalValue(run, srcId, out, depth = 0) {
    if (depth > MAX_VALUE_DEPTH) return 0;
    const ev = run.ev;
    const m = this.actionMaps.get(ev.id) || this._mapActions(ev);
    const a = m.get(srcId);
    if (!a) return 0;
    switch (a.type) {
      case 'readVar':
        return this.getVar(this.inputStr(run, a, 'varName', 'var1'), 0);
      case 'mathExpr':
        return this.calcMath(run, a, depth + 1);
      case 'evalExpr':
        // 纯表达式块：求值即取结果（无副作用），配合 destVar 也能当普通块用
        return this.runScript(a.code, true, a, run);
      case 'randomNumber': case 'randomPick': case 'randomChance':
      case 'arrayGet': case 'arrayLength': case 'arrayContains':
        // 这些块在执行时已把结果写进 destVar，这里直接读回（不会重掷）
        return this.getVar(a.destVar || 'tmp', 0);
      /* NPC 取值块：直接向 NPC 系统问当前状态 */
      case 'npcGetPos': {
        const sys = this.ctx && this.ctx.npcs;
        return (sys && typeof sys.posOf === 'function') ? sys.posOf(this.npcIdOf(run, a)) : [0, 0, 0];
      }
      case 'npcDistToPlayer': {
        const sys = this.ctx && this.ctx.npcs;
        const d = (sys && typeof sys.distToPlayer === 'function') ? Number(sys.distToPlayer(this.npcIdOf(run, a))) : -1;
        return Number.isFinite(d) ? d : -1;
      }
      case 'npcIsTalking': {
        const sys = this.ctx && this.ctx.npcs;
        return (sys && typeof sys.isTalking === 'function' && sys.isTalking(this.npcIdOf(run, a))) ? 1 : 0;
      }
      default:
        return this.numOf(a.value, 0);
    }
  }

  /** 高级运算块：把八个操作数绑定进公式并求值 */
  calcMath(run, a, depth = 0) {
    const fn = compileFormula(a.formula);
    if (!fn) return 0;                       // 空公式 / 语法错误 ⇒ 惰性返回 0
    const env = {};
    for (const mv of MATH_VARS) env[mv.v] = this.inputVal(run, a, mv.k, 0);
    const r = Number(fn(env));
    void depth;
    return Number.isFinite(r) ? r : 0;       // 除零等非有限结果归 0
  }

  /* ---------- 变量 ---------- */
  getVar(name, def = 0) { return this.vars[name] === undefined ? def : this.vars[name]; }
  setVar(name, v) {
    const old = this.vars[name];
    this.vars[name] = v;
    for (const w of this.opWatchers) {
      if (w.name !== name) continue;
      const st = this.state.get(w.id);
      if (!st) continue;
      if (compare(v, w.op, w.value) && !compare(old, w.op, w.value)) this.emit(w.id, { value: v, old });
    }
  }
  applyOp(name, op, value) {
    const cur = Number(this.getVar(name, 0)) || 0;
    const v = Number(value) || 0;
    switch (op) {
      case '+=': this.setVar(name, cur + v); break;
      case '-=': this.setVar(name, cur - v); break;
      case '*=': this.setVar(name, cur * v); break;
      case '/=': this.setVar(name, v === 0 ? cur : cur / v); break;
      case 'toggle': this.setVar(name, cur ? 0 : 1); break;
      default: this.setVar(name, value); break;
    }
  }

  /* ---------- 变量取值辅助（数组 / #变量引用） ---------- */
  /** 数字字段：支持数字或 '#变量名' */
  numOf(v, def = 0) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : def;
    const s = String(v ?? '').trim();
    if (!s) return def;
    if (s.startsWith('#')) { const n = Number(this.getVar(s.slice(1), 0)); return Number.isFinite(n) ? n : def; }
    const n = Number(s);
    return Number.isFinite(n) ? n : def;
  }
  /** 通用字段：'#变量名' → 变量值；纯数字串 → 数字；其余保持字符串 */
  valOf(v) {
    if (typeof v === 'number') return v;
    const s = String(v ?? '').trim();
    if (s.startsWith('#')) return this.getVar(s.slice(1), 0);
    if (s !== '' && Number.isFinite(Number(s))) return Number(s);
    return v;
  }
  /** 取出数组变量（不是数组时返回空数组） */
  getArray(name) { const v = this.vars[name]; return Array.isArray(v) ? v : []; }

  /* ---------- 触发 ---------- */
  start() {
    for (const ev of this.level.events) {
      if (!ev.enabled) continue;
      if (ev.trigger.type === 'levelStart') this.emit(ev.id, {});
    }
  }

  /** 对象相关的事件入口（被 mechanism 调用） */
  objectEvent(objectId, kind, payload = {}) {
    const rec = this.b.objects.get(objectId);
    const data = rec ? rec.o : getObject(this.level, objectId);
    if (data) {
      const key = kind === 'touch' ? 'onTouch' : kind === 'enter' ? 'onEnter' : kind === 'exit' ? 'onExit' : null;
      if (key && data[key]) this.emit(data[key], { objectId, object: data, ...payload });
    }
    const list = this.byObject.get(objectId);
    if (list) {
      for (const id of list) {
        const ev = this.index.get(id);
        if (!ev || !ev.enabled) continue;
        const tt = ev.trigger.type;
        const want = tt === 'playerTouch' ? 'touch'
          : tt === 'playerEnter' ? 'enter' : tt === 'playerExit' ? 'exit' : null;
        if (want === kind) this.emit(id, { objectId, object: data, ...payload });
      }
    }
  }

  emitTrigger(type, payload = {}) {
    for (const ev of this.level.events) {
      if (!ev.enabled) continue;
      if (ev.trigger.type === type && !ev.trigger.objectId) this.emit(ev.id, payload);
    }
  }

  emit(eventId, payload = {}) {
    if (!this.enabled) return;
    const ev = this.index.get(eventId);
    if (!ev || !ev.enabled) return;
    const st = this.state.get(eventId);
    if (st) {
      if (st.cool > 0) return;
      if (ev.trigger.once && st.fired) return;
      st.fired = true;
      st.cool = 0.08;
    }
    /* 入口：ev.start 的第一个入口留在主流，其余入口各开一条并行流 */
    const m = this.actionMaps.get(ev.id) || this._mapActions(ev);
    const entries = (Array.isArray(ev.start) ? ev.start : []).filter((id) => m.has(id));
    const head = entries.length ? entries[0] : (ev.actions[0] ? ev.actions[0].id : null);
    if (!head) return;
    const run = this._newRun(ev, head, payload, null);
    this.runners.push(run);
    for (let i = 1; i < entries.length; i++) this._fork(run, entries[i]);
  }

  _newRun(ev, node, payload, frame) {
    return {
      id: ++this._runSeq, ev, node,
      wait: 0, hold: null, pending: null,
      payload: payload || {}, steps: 0,
      loops: [], ownerFrame: frame || null,
      forkOf: frame ? frame.owner : 0, dead: false,
    };
  }

  /** 开一条并行流：本流与 fork 出来的流各自拥有独立的 wait / 等待直到 计时 */
  _fork(run, node) {
    if (this.runners.length >= MAX_RUNNERS) {
      if (!this._warnedRunners) { this._warnedRunners = true; console.warn('[events] 并行分支过多，已达上限，忽略后续分支'); }
      return;
    }
    const frame = run.loops.length ? run.loops[run.loops.length - 1] : null;
    if (frame) frame.pending++;
    const child = this._newRun(run.ev, node, run.payload, frame);
    child.loops = run.loops.slice();
    this.runners.push(child);
  }

  /** 流结束时释放它欠下的循环汇合计数 */
  _releaseRun(run) {
    const f = run.ownerFrame;
    if (f && f.pending > 0) f.pending--;
    run.ownerFrame = null;
  }

  stopAll() {
    this.runners.length = 0; this.tweens.length = 0;
    this.waits.length = 0;
    this.created.clear();
    // 重力变化只是本局的临时状态：停下来时把世界重力与玩家重力倍率还原，避免残留到下一局
    try { this.resetGravity(); } catch (e) { /* 还原失败不影响停止流程 */ }
    // 天空球渐变可能正卡在中间：把临时天穹连同贴图引用一起撤掉，
    // 否则重开一局会在场景里留下一层永远不会消失的半透明天空
    for (const d of this.skyDomes.slice()) this._dropDome(d);
    this.skyDomes.length = 0;
    // 事件改过的天空只是本局的显示：把关卡设置里的原始值还回去
    if (this._skyDirty) {
      this._skyDirty = false;
      const s = this.level.settings || (this.level.settings = {});
      s.sky = this._skySaved === undefined ? 'dream' : this._skySaved;
      if (this.b && this.b.applySky) { try { this.b.applySky(); } catch (e) { /* ignore */ } }
    }
  }

  /* ---------- 每帧 ---------- */
  update(dt) {
    this._hb = nowMs();             // 心跳：能跑帧就说明主线程没被脚本占死
    for (const st of this.state.values()) if (st.cool > 0) st.cool -= dt;
    this.updateTimers(dt);
    this.updateSpecialTriggers(dt);
    this.updateWaits(dt);
    this.updateRunners(dt);
    this.updateTweens(dt);
  }

  /* ---------- 脚本 await wait(秒) ---------- */
  /**
   * 代码块里的 wait(秒)：返回一个由本运行时到点 resolve 的 Promise。
   * 秒数按事件时间（dt）计，所以受 timeScale 影响；<=0 立即完成。
   */
  _wait(sec) {
    const t = Math.max(0, Number(sec) || 0);
    if (!(t > 0)) return Promise.resolve();
    return new Promise((resolve) => { this.waits.push({ t, resolve }); });
  }

  updateWaits(dt) {
    for (let i = this.waits.length - 1; i >= 0; i--) {
      const w = this.waits[i];
      w.t -= dt;
      if (w.t <= 0) { this.waits.splice(i, 1); w.resolve(); }
    }
  }

  updateTimers(dt) {
    for (const t of this.timers) {
      const st = this.state.get(t.id);
      if (st && st.cool > 0) continue;
      t.t -= dt;
      if (t.t <= 0) {
        this.emit(t.id, {});
        t.t = t.repeat ? Math.max(0.05, this.index.get(t.id).trigger.time || 1) : Infinity;
      }
    }
  }

  updateSpecialTriggers() {
    const p = this.ctx.player;
    if (!p) return;
    for (const ev of this.level.events) {
      if (!ev.enabled) continue;
      const st = this.state.get(ev.id);
      if (!st) continue;
      if (ev.trigger.type === 'oxygenBelow') {
        const v = Number(ev.trigger.value) || 0;
        const now = p.oxygen <= v;
        if (now && !st.below) { st.below = true; this.emit(ev.id, { value: p.oxygen }); }
        else if (!now && st.below && p.oxygen > v + 5) st.below = false;
      }
    }
  }

  updateRunners(dt) {
    /* 倒序遍历：fork 出来的新流会 push 到数组末尾，倒序不会重复处理它们 */
    for (let r = this.runners.length - 1; r >= 0; r--) {
      const run = this.runners[r];
      if (run.dead) { this._releaseRun(run); this.runners.splice(r, 1); continue; }
      if (run.wait > 0) { run.wait -= dt; if (run.wait > 0) continue; }
      /* 等待直到：被激活后每帧看接口，等到 true 才继续 */
      if (run.hold) {
        if (!this.holdSatisfied(run, run.hold)) continue;
        run.hold = null;
      }
      /* 脚本里的 await wait(秒)：脚本（async）没跑完之前一直挂起本流 */
      if (run.pending) {
        if (!run.pending.done) continue;
        const h = run.pending;
        run.pending = null;
        if (h.a && h.a.destVar && h.v !== undefined) this.setVar(h.a.destVar, h.v);
      }

      const map = this.actionMaps.get(run.ev.id) || this._mapActions(run.ev);
      let guard = 0;
      while (guard++ < MAX_STEPS_PER_FRAME) {
        const a = map.get(run.node);
        if (!a) { run.dead = true; break; }

        /* 循环汇合屏障：本层还有并行分支没跑完，先在 loopEnd 前挂一轮 */
        const fr = run.loops.length ? run.loops[run.loops.length - 1] : null;
        if (a.type === 'loopEnd' && fr && fr.endId === a.id && fr.owner === run.id && fr.pending > 0) {
          if (++fr.parkFrames > LOOP_PARK_LIMIT) {
            if (!fr.warned) { fr.warned = true; console.warn('[events] 循环体内的并行分支长时间未结束，已放行'); }
            fr.pending = 0;
          } else { run.wait = 1e-4; break; }
        }
        if (fr) fr.parkFrames = 0;

        const from = run.node;
        run.outSlot = 'out';
        const res = this.exec(a, run);
        if (run.dead) break;
        if (res === 'stop') { run.dead = true; break; }
        /* 先推进到后继，再挂起：否则下一帧会把「等待」块本身再执行一次（永远等不完） */
        if (run.node === from) this._advance(run, run.outSlot);
        if (!run.node) { run.dead = true; break; }
        if (res === 'wait') break;
      }
    }
  }

  /**
   * 「等待直到」是否已满足：接线口收到 true 才继续；
   * 没接线但写了 untilCond（支持 '#变量名'）时按该表达式的真假判定；
   * 两者都没有 ⇒ 一直等下去。
   */
  holdSatisfied(run, a) {
    /* NPC 对话：等到这段对话结束（玩家选完 / 关掉）才继续 */
    if (a.type === 'npcTalk') {
      const sys = this.ctx && this.ctx.npcs;
      if (!sys || typeof sys.isTalking !== 'function') return true;
      return !sys.isTalking(this.npcIdOf(run, a));
    }
    if (a.inputs && a.inputs.until) return this.inputBool(run, a, 'until', false);
    if (a.untilCond) return !!this.valOf(a.untilCond);
    return false;
  }

  /**
   * 按输出槽推进：槽里第一个目标留在本流（保序），其余各 fork 一条并行流。
   * slot 为 null 表示本支路到此为止。
   */
  _advance(run, slot) {
    if (!slot) { run.node = null; return; }
    const map = this.actionMaps.get(run.ev.id) || this._mapActions(run.ev);
    const a = map.get(run.node);
    const t = this.targetsOf(run.ev, a, slot).filter((id) => map.has(id));
    if (!t.length) { run.node = null; return; }
    run.node = t[0];
    for (let i = 1; i < t.length; i++) this._fork(run, t[i]);
  }

  /** 跳到某动作 id（循环跳转用）。null 表示结束本流 */
  _jump(run, id) {
    if (!id) { run.node = null; return; }
    const map = this.actionMaps.get(run.ev.id) || this._mapActions(run.ev);
    run.node = map.has(id) ? id : null;
  }

  /** 该动作所有输出槽上的目标并集（校验/编辑器用） */
  targetsOfAll(ev, a) {
    const out = [];
    for (const o of outsOf(a)) out.push(...this.targetsOf(ev, a, o.k));
    return out;
  }

  updateTweens(dt) {
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      tw.t += dt;
      const k = clamp(tw.t / tw.dur, 0, 1);
      const v = tw.interp(ease(tw.easing, k));
      tw.apply(v);
      if (k >= 1) {
        if (tw.onDone) { try { tw.onDone(); } catch (e) { console.error(e); } }
        this.tweens.splice(i, 1);
      }
    }
  }

  /* ---------- 动作执行 ---------- */
  exec(a, run) {
    const ctx = this.ctx;
    const p = ctx.player;
    const b = this.b;
    const rec = (id) => (id ? b.objects.get(id) : null);
    switch (a.type) {
      case 'wait': {
        /* 等待直到：被激活后挂起，等接口收到 true 才继续（没有超时，等到为止） */
        if (a.waitMode === 'until') { run.hold = a; return 'wait'; }
        const t = this.inputVal(run, a, 'time', Number(a.time) || 0);
        if (t <= 0) return;
        run.wait = t;
        return 'wait';
      }
      case 'showNotice': {
        const text = this.inputStr(run, a, 'noticeText', String(a.noticeText ?? ''));
        if (text && ctx.notice) ctx.notice(text, a.noticeKind || 'info', this.inputVal(run, a, 'time', Number(a.time) || 3));
        return;
      }
      /* if / elseif / else：命中的槽写进 run.outSlot，由调度器按槽推进 */
      case 'ifBlock': {
        const slots = ['then'];
        const n = Array.isArray(a.elifs) ? a.elifs.length : 0;
        for (let i = 0; i < n; i++) slots.push('elif' + i);
        slots.push('else');
        for (const k of slots) {
          let cond = null;
          if (k === 'then') cond = a;
          else if (k === 'else') cond = null;
          else cond = a.elifs[Number(k.slice(4))];
          if (cond === null) { run.outSlot = k; return; }
          /* 条件变量：没接线时按「变量名」读值（与 whileStart 一致）；接了线直接用线传来的值 */
          const lhs = (cond.inputs && cond.inputs.cond)
            ? this.inputStr(run, cond, 'cond', '')
            : this.getVar(cond.cond || '', 0);
          if (compare(lhs, cond.op, this.inputVal(run, cond, 'value', cond.value))) { run.outSlot = k; return; }
        }
        run.outSlot = null;                       // 全不满足（无 else 路）⇒ 本支路结束
        return;
      }
      /* 纯值块：只做参数读取，本身不产生执行效果（值由 evalValue 拉取） */
      case 'readVar': return;
      case 'mathExpr': {
        /* 写了变量名就顺带写回，方便当普通链式块用；空公式时保持惰性 */
        if (!a.formula) return;
        const v = this.calcMath(run, a);
        if (a.varName) this.applyOp(a.varName, '=', v);
        return;
      }
      case 'showObject': case 'hideObject': {
        const r = rec(this.objIdOf(this.inputStr(run, a, 'objectId', a.objectId)));
        if (r) {
          r.o.visible = a.type === 'showObject';
          b.syncVisibility(r);
          if (a.type === 'showObject') ctx.fx && ctx.fx.sparkle(new THREE.Vector3(...worldPosition(this.level, r.o)), '#ffe6a8', 14, 6);
        }
        return;
      }
      case 'setProperty':
        return this.setObjectProperty(rec(this.objIdOf(this.inputStr(run, a, 'objectId', a.objectId))), a.property,
          this.inputAny(run, a, 'value', a.value));
      case 'moveObject': case 'rotateObject': case 'scaleObject': {
        const r = rec(this.objIdOf(this.inputStr(run, a, 'objectId', a.objectId)));
        if (!r) return;
        const key = a.type === 'moveObject' ? 'position' : a.type === 'rotateObject' ? 'rotation' : 'scale';
        const from = Array.isArray(r.o[key]) ? r.o[key].slice() : [0, 0, 0];
        const to = this.inputVec(run, a, 'vec', isVec3(a.vec) ? a.vec : from);
        const mode = a.type === 'moveObject' ? 'add' : 'set';
        const target = mode === 'add' ? from.map((v, i) => v + to[i]) : to;
        this.tweenVec(run, r, key, from, target, this.inputVal(run, a, 'time', a.time), a.easing);
        return;
      }
      case 'playAnim': { const an = getAnim(this.level, a.animId); if (an && ctx.anims) ctx.anims.play(an.id); return; }
      case 'stopAnim': { if (ctx.anims) ctx.anims.stop(a.animId); return; }
      case 'teleportPlayer': {
        if (!p) return;
        const v = this.inputVec(run, a, 'vec', isVec3(a.vec) ? a.vec : null);
        if (v) { p.teleport(new THREE.Vector3(v[0], v[1], v[2])); audio.door(0.6); }
        return;
      }
      case 'setPlayer': {
        if (!p) return;
        this.setPlayerField(p, a.playerField, this.inputAny(run, a, 'value', a.value));
        return;
      }
      /* ---------- 重力变化：可补间、可按作用域（整个世界 / 指定玩家） ---------- */
      case 'setGravity': {
        this.applyGravity(run, a);
        return;
      }
      case 'morphPlayer': {
        if (!p || typeof p.morph !== 'function') return;
        // 加载导入模型是异步的，这里不阻塞动作链；失败时玩家自动回退到默认形象
        const r = p.morph({
          mode: a.morphMode || 'preset',
          preset: a.morphPreset,
          assetId: a.morphAsset,
          scale: Number(a.morphScale) || 1,
          yawOffset: Number(a.morphYaw) || 0,
          yOffset: Number(a.morphY) || 0,
        });
        if (r && typeof r.catch === 'function') r.catch(() => {});
        return;
      }
      case 'giveTool': {
        if (!p) return;
        // 指定了具体工具对象时，按该对象复制一份（可继承自定义名字 / 图标 / 目标）
        const r = a.toolId ? b.objects.get(a.toolId) : null;
        if (r && ctx.mechanisms && ctx.mechanisms.makeToolItem) p.giveTool(ctx.mechanisms.makeToolItem(r.o, r));
        else p.giveToolByName(a.tool);
        return;
      }
      case 'removeTool': { if (p) p.removeTool(a.tool); return; }
      case 'addOxygen': {
        if (!p) return;
        const v = this.inputVal(run, a, 'value', Number(a.value) || 0);
        if (v >= 0) p.addOxygen(v); else p.takeOxygen(-v);
        audio.oxygen();
        ctx.hint && ctx.hint(v >= 0 ? `氧气 +${v}` : `氧气 ${v}`, 1.2);
        return;
      }
      case 'setLiquid': {
        const r = rec(this.objIdOf(this.inputStr(run, a, 'objectId', a.objectId)));
        if (!r || !r.liquid || !ctx.liquids) return;
        const from = r.liquid.f;
        const to = clamp(this.inputVal(run, a, 'value', Number(a.value) || 0), 0, 1);
        const dur = Math.max(0.02, this.inputVal(run, a, 'time', Number(a.time) || 0.8));
        this.tweens.push({
          t: 0, dur, easing: a.easing,
          interp: (k) => lerp(from, to, k),
          apply: (v) => ctx.liquids.setFill(r, v),
        });
        return;
      }
      case 'killPlayer': { if (p) p.kill('event'); return; }
      case 'winLevel': { ctx.onWin && ctx.onWin(null); return; }
      case 'setVariable': {
        this.applyOp(a.varName, a.op, this.inputAny(run, a, 'value', a.value));
        return;
      }
      case 'playSound': { audio.play(this.inputStr(run, a, 'sound', a.sound || 'click'), { volume: this.inputVal(run, a, 'volume', 1) }); return; }
      case 'playAudio': {
        if (!a.audio) return;
        audio.ensure();
        audio.load(a.audio);
        audio.playRef(a.audio, { volume: this.inputVal(run, a, 'volume', 1), loop: !!a.loopAudio, dest: a.loopAudio ? 'music' : 'sfx' });
        return;
      }
      case 'spawnEffect': {
        if (!ctx.fx) return;
        const target = rec(this.objIdOf(this.inputStr(run, a, 'objectId', a.objectId)));
        const wired = a.inputs && a.inputs.vec;
        const v = wired ? this.inputVec(run, a, 'vec', [0, 0, 0])
          : (isVec3(a.vec) ? a.vec : (target ? worldPosition(this.level, target.o) : [0, 0, 0]));
        const pos = new THREE.Vector3(v[0], v[1], v[2]);
        const eff = a.effect || 'splash';
        if (eff === 'burst') ctx.fx.burst(pos, '#ffd98a', 24);
        else if (eff === 'sparkle') ctx.fx.sparkle(pos, '#fff3c4', 22, 5);
        else if (eff === 'hit') ctx.fx.hit(pos, '#ffffff', 14);
        else ctx.fx.splash(pos, 'water', 20);
        return;
      }
      case 'openDoor': { const r = rec(this.objIdOf(this.inputStr(run, a, 'objectId', a.objectId))); if (r && ctx.mechanisms) ctx.mechanisms.openDoor(r); return; }
      case 'closeDoor': { const r = rec(this.objIdOf(this.inputStr(run, a, 'objectId', a.objectId))); if (r && ctx.mechanisms) ctx.mechanisms.closeDoor(r); return; }

      /* ---------- 天空球渐变：从 A 天空淡入到 B 天空 ---------- */
      case 'skyCrossfade': {
        this.skyCrossfade(run, a);
        return;
      }

      /* ---------- 对象生成 / 克隆 / 挂父级（仅本局有效，不写回关卡数据） ---------- */
      case 'createObject': {
        const src = this.templateRec(run, a);
        if (!src) return;
        const copy = this.spawnCopy(src, !!a.deepTree);
        if (!copy) return;
        this.spawnPos(copy, run, a);
        this.spawnBuild(copy);
        if (a.destVar) this.setVar(a.destVar, copy.id);
        return;
      }
      case 'cloneObject': {
        const src = rec(this.objIdOf(this.inputStr(run, a, 'objectId', a.objectId)));
        if (!src) return;
        const copy = this.spawnCopy(src, !!a.deepTree);
        if (!copy) return;
        this.spawnPos(copy, run, a);
        this.spawnBuild(copy);
        if (a.destVar) this.setVar(a.destVar, copy.id);
        return;
      }
      case 'setParent': {
        const child = rec(this.objIdOf(this.inputStr(run, a, 'objectId', a.objectId)));
        if (!child) return;
        const parentId = this.objIdOf(this.inputStr(run, a, 'parent', a.parent));
        if ((child.o.parent || null) === (parentId || null)) return;
        // 保持世界位置：挂之前记下世界变换，挂之后反解出新的局部位置 / 朝向
        const before = a.keepWorld !== false ? objectFrame(this.level, child.o).clone() : null;
        if (!reparentObject(this.level, child.o.id, parentId || null)) return;
        if (before) {
          const parentObj = parentId ? getObject(this.level, parentId) : null;
          const m = new THREE.Matrix4();
          if (parentObj) m.copy(objectFrame(this.level, parentObj)).invert();
          m.multiply(before);
          const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
          m.decompose(pos, quat, scl);
          _frE.setFromQuaternion(quat, 'XYZ');
          child.o.position = [pos.x, pos.y, pos.z];
          child.o.rotation = [
            THREE.MathUtils.radToDeg(_frE.x),
            THREE.MathUtils.radToDeg(_frE.y),
            THREE.MathUtils.radToDeg(_frE.z),
          ];
        }
        b.rebuild(child);
        return;
      }

      /* ---------- 随机数 ---------- */
      case 'randomNumber': {
        const lo0 = this.inputVal(run, a, 'rmin', 0), hi0 = this.inputVal(run, a, 'rmax', 1);
        const lo = Math.min(lo0, hi0), hi = Math.max(lo0, hi0);
        let v = lo + Math.random() * (hi - lo);
        if (a.isInt) v = Math.floor(v + 0.5);
        else v = Math.round(v * 1000) / 1000;
        this.applyOp(a.varName, a.op || '=', v);
        return;
      }
      case 'randomPick': {
        const arr = this.getArray(this.inputStr(run, a, 'srcVar', a.srcVar));
        const v = arr.length ? arr[Math.floor(Math.random() * arr.length)] : 0;
        this.applyOp(a.varName, a.op || '=', v);
        return;
      }
      case 'randomChance': {
        const pct = clamp(this.inputVal(run, a, 'chance', 50), 0, 100);
        this.applyOp(a.varName, a.op || '=', Math.random() * 100 < pct ? 1 : 0);
        return;
      }

      /* ---------- 数组操作 ---------- */
      case 'arrayCreate': {
        const items = String(a.list ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '').map((s) => this.valOf(s));
        this.setVar(a.varName, items);
        return;
      }
      case 'arrayPush': {
        const arr = this.getArray(a.varName).slice();
        arr.push(this.inputAny(run, a, 'value', a.value));
        this.setVar(a.varName, arr);
        return;
      }
      case 'arrayPop': {
        const arr = this.getArray(a.varName).slice();
        if (!arr.length) return;
        const v = arr.pop();
        this.setVar(a.varName, arr);
        if (a.destVar) this.setVar(a.destVar, v);
        return;
      }
      case 'arrayGet': {
        const arr = this.getArray(a.varName);
        const i = Math.floor(this.inputVal(run, a, 'index', 0));
        const v = i >= 0 && i < arr.length ? arr[i] : 0;
        this.setVar(a.destVar || 'tmp', v);
        return;
      }
      case 'arraySet': {
        const arr = this.getArray(a.varName).slice();
        const i = Math.floor(this.inputVal(run, a, 'index', 0));
        if (i < 0 || i >= arr.length) return;
        arr[i] = this.inputAny(run, a, 'value', a.value);
        this.setVar(a.varName, arr);
        return;
      }
      case 'arrayRemove': {
        const arr = this.getArray(a.varName).slice();
        const v = this.inputAny(run, a, 'value', a.value);
        const out = arr.filter((x) => String(x) !== String(v));
        if (out.length !== arr.length) this.setVar(a.varName, out);
        return;
      }
      case 'arrayLength': {
        this.setVar(a.destVar || 'tmp', this.getArray(a.varName).length);
        return;
      }
      case 'arrayContains': {
        const arr = this.getArray(a.varName);
        const v = this.inputAny(run, a, 'value', a.value);
        this.setVar(a.destVar || 'tmp', arr.some((x) => String(x) === String(v)) ? 1 : 0);
        return;
      }
      case 'arrayShuffle': {
        const arr = this.getArray(a.varName).slice();
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const t2 = arr[i]; arr[i] = arr[j]; arr[j] = t2;
        }
        this.setVar(a.varName, arr);
        return;
      }
      case 'arrayClear': { this.setVar(a.varName, []); return; }

      /* ---------- 循环（按动作 id 跳转，不走数组下标） ---------- */
      case 'loopStart': case 'forEachStart': case 'whileStart': {
        const pairs = this.loopPairs.get(run.ev.id);
        const endId = pairs ? pairs.s2e.get(a.id) : undefined;
        if (endId === undefined) return;                // 未配对（缺少「循环结束」）：按普通动作跳过
        const bodyId = this.firstTarget(run.ev, a.id);
        const afterId = this.firstTarget(run.ev, endId);
        const base = { owner: run.id, startId: a.id, endId, bodyId, afterId, pending: 0, parkFrames: 0 };
        if (a.type === 'loopStart') {
          const total = Math.max(0, Math.floor(this.inputVal(run, a, 'count', 1)));
          if (total <= 0) { this._jump(run, afterId); return; }
          run.loops.push({ ...base, kind: 'count', iter: 0, total, varName: a.varName });
          if (a.varName) this.setVar(a.varName, 1);
          this._jump(run, bodyId);
          return;
        }
        if (a.type === 'forEachStart') {
          const arr = this.getArray(this.inputStr(run, a, 'srcVar', a.srcVar)).slice();  // 快照：循环内改数组不会导致死循环
          if (!arr.length) { this._jump(run, afterId); return; }
          run.loops.push({ ...base, kind: 'each', iter: 0, total: arr.length, arr, varName: a.varName, indexVar: a.destVar });
          if (a.varName) this.setVar(a.varName, arr[0]);
          if (a.destVar) this.setVar(a.destVar, 0);
          this._jump(run, bodyId);
          return;
        }
        const maxIter = Math.max(1, Math.floor(this.inputVal(run, a, 'maxIter', 100)));
        if (!compare(this.getVar(a.cond, 0), a.op, a.value)) { this._jump(run, afterId); return; }
        run.loops.push({ ...base, kind: 'while', iter: 0, total: maxIter, cond: a.cond, op: a.op, value: a.value });
        this._jump(run, bodyId);
        return;
      }
      case 'loopEnd': {
        const fr = run.loops.length ? run.loops[run.loops.length - 1] : null;
        if (!fr || fr.endId !== a.id) return;           // 不是本层循环体的结尾（如 break 后残留）
        if (fr.owner !== run.id) { run.node = null; return; }   // 体内 fork 出来的支路到这里就结束（汇合由屏障负责）
        if (++run.steps > MAX_LOOP_STEPS) { run.dead = true; return; }   // 防死循环
        fr.iter++;
        if (fr.iter < fr.total) {
          if (fr.kind === 'each') {
            if (fr.varName) this.setVar(fr.varName, fr.arr[fr.iter]);
            if (fr.indexVar) this.setVar(fr.indexVar, fr.iter);
          } else if (fr.kind === 'count') {
            if (fr.varName) this.setVar(fr.varName, fr.iter + 1);
          } else if (fr.kind === 'while' && !compare(this.getVar(fr.cond, 0), fr.op, fr.value)) {
            run.loops.pop();                            // 条件不再成立：结束循环
            this._jump(run, fr.afterId);
            return;
          }
          this._jump(run, fr.bodyId);                   // 回到循环体开头
        } else {
          run.loops.pop();
          this._jump(run, fr.afterId);
        }
        return;
      }
      case 'loopBreak': {
        if (!run.loops.length) return;
        const fr = run.loops.pop();
        this._jump(run, fr.afterId);
        return;
      }

      /* ---------- 脚本 / 空间查询（代码级自由度） ---------- */
      case 'script': {
        // 空代码 = 什么都不做（不报错）。填了 destVar 时把 return 的值写进变量。
        // 代码里写了 await wait(秒) 时编译成 async：本流挂起，等脚本跑完再继续。
        const r = this.runScript(a.code, false, a, run);
        if (r && typeof r.then === 'function') {
          const h = { done: false, a, v: undefined };
          run.pending = h;
          r.then((v) => { h.v = v; h.done = true; });
          return 'wait';
        }
        if (a.destVar && r !== undefined) this.setVar(a.destVar, r);
        return;
      }
      case 'raycast': {
        const from = this.rayPoint(run, a, 'From');
        const to = this.rayPoint(run, a, 'To');
        const hit = this.b.raycastClosest(from, to);
        this.setVar(a.destObj || 'hitObj', hit.hit ? hit.objectId : '');
        this.setVar(a.destPos || 'hitPos', hit.point);
        this.setVar(a.destNormal || 'hitNormal', hit.normal);
        this.setVar(a.destDist || 'hitDist', hit.hit ? hit.distance : -1);
        return;
      }
      case 'getProperty': {
        const v = this.readPath(run, a);
        if (a.destVar) this.setVar(a.destVar, v === undefined || v === null ? '' : v);
        return;
      }
      /* ---------- 2D 平台模式（相机控制） ---------- */
      case 'platformMode': {
        const cam = ctx.cameraCtl;
        if (!cam || !cam.setPlatformMode) return;
        if (a.platMode === 'off') { cam.setPlatformMode(null); return; }
        cam.setPlatformMode({
          point: this.inputVec(run, a, 'platPoint', isVec3(a.platPoint) ? a.platPoint : [0, 0, 0]),
          normal: this.inputVec(run, a, 'platNormal', isVec3(a.platNormal) ? a.platNormal : [0, 0, -1]),
          dist: this.inputVal(run, a, 'platDist', Number(a.platDist) || 22),
        });
        return;
      }

      /* ---------- NPC / 角色 ---------- */
      case 'npcTalk': {
        /* 阻塞：对话结束（选完分支 / 玩家关掉）才继续后面的动作 */
        const sys = ctx.npcs;
        if (!sys || typeof sys.startDialogue !== 'function') return;
        const id = this.npcIdOf(run, a);
        if (!id) return;
        if (sys.startDialogue(id, this.inputStr(run, a, 'node', a.node || ''))) { run.hold = a; return 'wait'; }
        return;
      }
      case 'npcSay': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.say !== 'function') return;
        sys.say(this.npcIdOf(run, a), this.inputStr(run, a, 'sayText', a.sayText || ''), '',
          this.inputVal(run, a, 'sayTime', Number(a.sayTime) || 3));
        return;
      }
      case 'npcBehavior': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.setBehavior !== 'function') return;
        sys.setBehavior(this.npcIdOf(run, a), this.inputStr(run, a, 'npcBehavior', a.npcBehavior || 'follow'));
        return;
      }
      case 'npcFollow': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.setBehavior !== 'function') return;
        const id = this.npcIdOf(run, a);
        sys.setBehavior(id, 'follow');
        sys.setKeepDist(id, this.inputVal(run, a, 'npcKeep', Number(a.npcKeep) || 7));
        return;
      }
      case 'npcPatrol': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.setBehavior !== 'function') return;
        sys.setBehavior(this.npcIdOf(run, a), 'patrol');
        return;
      }
      case 'npcStop': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.stop !== 'function') return;
        sys.stop(this.npcIdOf(run, a));
        return;
      }
      case 'npcSpeed': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.setSpeed !== 'function') return;
        sys.setSpeed(this.npcIdOf(run, a), this.inputVal(run, a, 'value', Number(a.value) || 6));
        return;
      }
      case 'npcKeepDist': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.setKeepDist !== 'function') return;
        sys.setKeepDist(this.npcIdOf(run, a), this.inputVal(run, a, 'npcKeep', Number(a.npcKeep) || 7));
        return;
      }
      case 'npcMoveTo': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.moveTo !== 'function') return;
        const v = this.inputVec(run, a, 'vec', isVec3(a.vec) ? a.vec : [0, 0, 0]);
        const sp = this.inputVal(run, a, 'value', Number(a.value) || 0);
        sys.moveTo(this.npcIdOf(run, a), v, sp > 0 ? sp : null);
        return;
      }
      case 'npcWarp': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.warp !== 'function') return;
        sys.warp(this.npcIdOf(run, a), this.inputVec(run, a, 'vec', isVec3(a.vec) ? a.vec : [0, 0, 0]));
        return;
      }
      case 'npcWarpToPlayer': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.warpNearPlayer !== 'function') return;
        sys.warpNearPlayer(this.npcIdOf(run, a), this.inputVal(run, a, 'npcKeep', Number(a.npcKeep) || 6));
        return;
      }
      case 'npcLookAt': {
        const sys = ctx.npcs;
        if (!sys) return;
        const id = this.npcIdOf(run, a);
        if (this.inputStr(run, a, 'npcFace', a.npcFace || 'player') === 'point') {
          sys.lookAtPoint(id, this.inputVec(run, a, 'vec', isVec3(a.vec) ? a.vec : [0, 0, 0]));
        } else sys.lookAtPlayer(id);
        return;
      }
      case 'npcFreeze': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.setFrozen !== 'function') return;
        sys.setFrozen(this.npcIdOf(run, a), this.inputBool(run, a, 'npcOn', a.npcOn !== false));
        return;
      }
      case 'npcVisible': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.setVisible !== 'function') return;
        sys.setVisible(this.npcIdOf(run, a), this.inputBool(run, a, 'npcOn', a.npcOn !== false));
        return;
      }
      case 'npcAnim': {
        const sys = ctx.npcs;
        if (!sys || typeof sys.playClip !== 'function') return;
        sys.playClip(this.npcIdOf(run, a), this.inputStr(run, a, 'npcClip', a.npcClip || ''));
        return;
      }
      default: return;
    }
  }

  /* ---------- 对象生成 / 克隆 ---------- */
  /** 生成对象的模板（只支持以关卡已有对象为模板） */
  templateRec(run, a) {
    const id = this.objIdOf(this.inputStr(run, a, 'templateId', a.templateId));
    return id ? this.b.objects.get(id) : null;
  }

  /**
   * 复制一份对象数据。
   * deepTree 为真时整棵子树深拷贝（内部 parent 重映射、涂鸦一并复制、已分配新 id）；
   * 否则按模板/源对象的字段新建一份（保持形状外观，但不带走子级）。
   */
  spawnCopy(srcRec, deepTree) {
    const src = srcRec.o;
    if (deepTree) {
      const copies = duplicateObjects(this.level, [src.id], [0, 0, 0]);
      return copies.length ? copies[0] : null;
    }
    const over = deepClone(src);
    over.id = uid(String(src.type || 'mesh').slice(0, 2));
    over.parent = null;
    return createObject(src.type, over);
  }

  /** uid() 不查重：把一个对象的 id 换成不撞车的新 id */
  _reId(o) {
    let guard = 0;
    while (guard++ < 64) {
      const clash = this.b.objects.get(o.id) || getObject(this.level, o.id);
      if (!clash || clash === o) break;
      o.id = uid(String(o.type || 'mesh').slice(0, 2));
    }
    return o.id;
  }

  /** 按 posMode 决定生成位置：abs 绝对 / rel 参照对象 + 偏移 / trigger 触发对象 + 偏移 */
  spawnPos(o, run, a) {
    const mode = a.posMode || 'rel';
    let base = null;
    if (mode === 'trigger') {
      const tid = this.objIdOf(run.payload && run.payload.objectId);
      const tr = tid ? this.b.objects.get(tid) : null;
      if (tr) base = worldPosition(this.level, tr.o);
    } else if (mode === 'rel') {
      const rid = this.objIdOf(this.inputStr(run, a, 'posRef', a.posRef));
      const rr = rid ? this.b.objects.get(rid) : null;
      if (rr) base = worldPosition(this.level, rr.o);
    }
    const off = this.inputVec(run, a, 'vec', isVec3(a.vec) ? a.vec : [0, 0, 0]);
    o.position = base
      ? [base[0] + off[0], base[1] + off[1], base[2] + off[2]]
      : [off[0], off[1], off[2]];
    return o;
  }

  /** 落地到世界：补进关卡对象表 → 建网格 → 类型特化 → 更新包围盒 */
  spawnBuild(o) {
    this._reId(o);
    if (!getObject(this.level, o.id)) this.level.objects.push(o);
    const rec = this.b.create(o);
    if (rec) {
      this.b.postCreate(rec);
      this.b.computeBounds();
    }
    this.created.add(o.id);
    return rec;
  }

  tweenVec(run, rec, key, from, to, time, easing) {
    const dur = Math.max(0.01, Number(time) || 0.5);
    this.tweens.push({
      t: 0, dur, easing,
      interp: (k) => [lerp(from[0], to[0], k), lerp(from[1], to[1], k), lerp(from[2], to[2], k)],
      apply: (v) => {
        rec.o[key] = v;
        this.b.syncTransform(rec);
      },
      onDone: () => { rec.o[key] = to; this.b.syncTransform(rec); },
    });
  }

  /* ============================================================
     重力变化
     ------------------------------------------------------------
     · 重力方向 [x,y,z] 先归一化（零向量回退 [0,-1,0]，避免出现「无方向」的重力）
     · 强度 = 标准重力 PHYS.gravity × 关卡重力倍率 × power（power=0 即失重）
     · 作用域：
         world  → 改物理世界重力（所有刚体，含玩家）；玩家不再持有独立重力
         player → 只改玩家自身重力，物理世界不变
         both   → 世界与玩家都设成同一向量（玩家被钉住，之后世界再变也不跟随）
     · dur > 0 时把「从当前向量到目标向量」线性补间，方向与强度一起平滑过渡
     ============================================================ */
  applyGravity(run, a) {
    const target = a.gravityTarget === 'player' ? 'player'
      : a.gravityTarget === 'both' ? 'both' : 'world';
    const dir = this.inputVec(run, a, 'gravityDir', isVec3(a.vec) ? a.vec : [0, -1, 0]);
    const rawP = this.inputVal(run, a, 'gravityPower', a.gravityPower === undefined ? 1 : a.gravityPower);
    const power = Number.isFinite(Number(rawP)) ? Number(rawP) : 1;
    const dur = Math.max(0, Number(this.inputVal(run, a, 'time', a.time)) || 0);
    this.setGravityVector(target, dir, power, dur, a.easing);
  }

  /** 真正落地：把归一化方向 + 强度倍数应用到世界 / 玩家（供动作与代码块共用） */
  setGravityVector(target, dir, power, dur, easing) {
    const b = this.b;
    const p = this.ctx.player;
    const d = isVec3(dir) ? [Number(dir[0]) || 0, Number(dir[1]) || 0, Number(dir[2]) || 0] : [0, -1, 0];
    let len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 1e-6)) { d[0] = 0; d[1] = -1; d[2] = 0; len = 1; }
    const u = [d[0] / len, d[1] / len, d[2] / len];
    const pw = Number.isFinite(Number(power)) ? Number(power) : 1;
    const gscale = (this.level.settings && Number(this.level.settings.gravityScale)) || 1;
    const mag = PHYS.gravity * gscale * pw;
    const to = [u[0] * mag, u[1] * mag, u[2] * mag];
    const jobs = [];
    // 世界目标：改 world.gravity；玩家清掉独立重力 → 自动跟随世界
    if ((target === 'world' || target === 'both') && b && b.world) {
      const g = b.world.gravity;
      jobs.push({ key: 'world', from: [g.x, g.y, g.z],
        apply: (v) => { if (b.world) b.world.gravity.set(v[0], v[1], v[2]); } });
    }
    if (target === 'world' && p) p.gravOverride = null;
    // 玩家目标：写入玩家独立重力向量（世界不变）
    if ((target === 'player' || target === 'both') && p) {
      const cur = Array.isArray(p.gravOverride) ? p.gravOverride.slice(0, 3) : this._inheritGravity();
      jobs.push({ key: 'player', from: cur,
        apply: (v) => { p.gravOverride = [v[0], v[1], v[2]]; } });
    }
    // 同一目标上正在跑的旧重力补间先撤掉，避免两个补间互相打架
    if (jobs.length) {
      for (let i = this.tweens.length - 1; i >= 0; i--) {
        const tw = this.tweens[i];
        if (tw.gKey && jobs.some((j) => j.key === tw.gKey)) this.tweens.splice(i, 1);
      }
    }
    for (const j of jobs) {
      if (!(dur > 0.001)) { j.apply(to); continue; }
      this.tweens.push({
        t: 0, dur, easing, gKey: j.key,
        interp: (k) => [lerp(j.from[0], to[0], k), lerp(j.from[1], to[1], k), lerp(j.from[2], to[2], k)],
        apply: (v) => j.apply(v),
        onDone: () => j.apply(to),
      });
    }
  }

  /** 玩家「继承世界重力」时的实际向量（世界重力 × 玩家重力倍率 statGravity） */
  _inheritGravity() {
    const p = this.ctx.player;
    const k = Number(p && p.statGravity);
    const kk = Number.isFinite(k) ? k : 1;
    const g = (this.b && this.b.world) ? this.b.world.gravity : null;
    return g ? [g.x * kk, g.y * kk, g.z * kk] : [0, -PHYS.gravity * kk, 0];
  }

  /** 把重力还原成关卡默认值（重开一局 / 停止运行时调用，避免上一局的重力残留） */
  resetGravity() {
    const gscale = (this.level.settings && Number(this.level.settings.gravityScale)) || 1;
    if (this.b && this.b.world) this.b.world.gravity.set(0, -PHYS.gravity * gscale, 0);
    const p = this.ctx.player;
    if (p) { p.gravOverride = null; p.statGravity = 1; }
  }

  setObjectProperty(rec, prop, value) {
    if (!rec) return;
    const o = rec.o;
    switch (prop) {
      case 'position': case 'rotation': case 'scale':
        if (isVec3(value)) { o[prop] = value.slice(); this.b.syncTransform(rec); }
        break;
      case 'color': case 'texture': case 'paintKey':
        o[prop] = value; this.b.syncMaterial(rec);
        break;
      case 'transparency': case 'metalness': case 'roughness': case 'emissiveIntensity':
        o[prop] = Number(value) || 0; this.b.syncMaterial(rec);
        break;
      case 'emissive':
        o.emissive = value; this.b.syncMaterial(rec);
        break;
      case 'visible':
        o.visible = !!value; this.b.syncVisibility(rec);
        break;
      case 'castShadow':
        o.castShadow = !!value;
        if (rec.mesh) rec.mesh.castShadow = !!value;
        break;
      case 'fillLevel': {
        if (rec.liquid && this.ctx.liquids) this.ctx.liquids.setFill(rec, clamp(Number(value) || 0, 0, 1));
        break;
      }
      case 'intensity': if (rec.light) { o.intensity = Number(value) || 0; rec.light.intensity = o.intensity; } break;
      case 'damage': o.damage = Number(value) || 0; break;
      case 'speed': o.speed = Number(value) || 0; break;
      case 'opacity': o.transparency = 1 - clamp(Number(value) || 1, 0, 1); this.b.syncMaterial(rec); break;
      case 'anchored': {
        o.anchored = !!value;
        this.b.rebuild(rec);
        break;
      }
      default: o[prop] = value; break;
    }
  }

  setPlayerField(p, field, value) {
    switch (field) {
      case 'speed': p.statSpeed = Number(value) || 19; break;
      case 'jumpPower': p.statJump = Number(value) || 52; break;
      case 'gravityScale': p.statGravity = Number(value) || 1; break;
      case 'oxygen': p.oxygen = clamp(Number(value) || 0, 0, p.maxOxygen); break;
      case 'maxOxygen': p.maxOxygen = clamp(Number(value) || 100, 5, 9999); break;
      case 'health': p.health = clamp(Number(value) || 0, 0, p.healthMax); break;
      case 'canSwim': p.statCanSwim = !!value; break;
      case 'invisible': p.statInvisible = !!value; p.setInvisible(!!value); break;
      case 'frozen': p.statFrozen = !!value; break;
      default: p[field] = value; break;
    }
  }

  /* ============================================================
     天空球渐变（A 天空 crossfade 到 B 天空）
     ------------------------------------------------------------
     做法：背景保持 A 不动，另外在场景里挂一层「天穹」球壳贴 B，
     每帧只推它的不透明度（0 → 1），屏幕上就是 A 与 B 的普通 alpha 混合；
     推到 1 之后撤掉天穹，把关卡天空真正切成 B 并重建环境。
     · 天穹半径贴着相机远平面并每帧跟随相机 ⇒ 永远把相机包在球心，
       既不依赖关卡大小，也不会挡住任何场景几何（只补在背景像素上）
     · 透明 + renderOrder 很低 ⇒ 排在背景之后、水等半透明物之前
     ============================================================ */
  skyCrossfade(run, a) {
    const b = this.b;
    const scene = b && b.scene;
    const s = this.level.settings || {};
    // fromSky 留空 = 沿用关卡当前天空（「从现在的天空渐变过去」）
    const fromKey = this.inputStr(run, a, 'fromSky', a.fromSky || '') || s.sky || 'dream';
    const toKey = this.inputStr(run, a, 'toSky', a.toSky || '');
    const dur = Math.max(0.02, this.inputVal(run, a, 'time', Number(a.time) || 2));
    if (!toKey || toKey === fromKey) return;
    const target = resolveSkyTexture(toKey);
    // 目标天空解析不出来（素材还在加载 / 已被删除）：不硬等，直接切过去
    if (!scene || !target) { this._applySky(fromKey); this._applySky(toKey); return; }

    // 起点必须真的显示着 A：否则先把背景切成 A，「A → B」才有意义
    if ((s.sky || '') !== fromKey) this._applySky(fromKey);

    // 同一目标已在渐变中：直接沿用（避免连点触发器叠出好几层天穹）
    for (const d of this.skyDomes) if (d.toKey === toKey && !d.dead) return;
    // 换目标：把之前没跑完的天穹撤掉（本局同时只保留一层）
    for (const d of this.skyDomes.slice()) this._dropDome(d);

    const cam = b.camera;
    const far = cam && isFinite(cam.far) && cam.far > 1 ? cam.far : 6000;
    const geo = new THREE.SphereGeometry(Math.max(400, far * 0.9), 48, 24);
    // 与 scene.backgroundIntensity 对齐，收尾那一刻不会跳亮度
    const k = clamp(s.skyIntensity === undefined ? 1 : Number(s.skyIntensity) || 0, 0, 4);
    // SphereGeometry 自带 UV 与等距柱状在水平方向互为镜像（u_bg = 1 - u_sphere），
    // 若直接用 MeshBasicMaterial 贴图会整张左右翻转、渐变收尾时横跳；
    // 这里自写 shader 用 1-vUv.x 还原成与 scene.background 完全一致的取法，
    // 并接上 three.js 的色调映射 / 输出色彩空间，保证和最终背景同一套颜色管线
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: target },
        uOpacity: { value: 0 },
        uTint: { value: k },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform float uOpacity;
        uniform float uTint;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(uMap, vec2(1.0 - vUv.x, vUv.y));
          gl_FragColor = vec4(c.rgb * uTint, uOpacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.BackSide, transparent: true,
      depthTest: true, depthWrite: false, fog: false,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    if (cam) dome.position.copy(cam.position);
    scene.add(dome);
    const entry = { dome, geo, mat, toKey, dead: false };
    this.skyDomes.push(entry);

    this.tweens.push({
      t: 0, dur, easing: a.easing,
      interp: (x) => x,
      apply: (x) => {
        mat.uniforms.uOpacity.value = clamp(x, 0, 1);
        const c = b.camera;                    // 跟随相机：球心始终是眼睛
        if (c) dome.position.copy(c.position);
      },
      onDone: () => { this._dropDome(entry); this._applySky(toKey); },
    });
  }

  /** 撤掉一层渐变天穹（几何 / 材质是本次渐变现建的，用完必须销毁） */
  _dropDome(entry) {
    if (!entry || entry.dead) return;
    entry.dead = true;
    const i = this.skyDomes.indexOf(entry);
    if (i >= 0) this.skyDomes.splice(i, 1);
    if (entry.dome && entry.dome.parent) entry.dome.parent.remove(entry.dome);
    try { entry.geo.dispose(); } catch (e) { /* ignore */ }
    try { entry.mat.dispose(); } catch (e) { /* ignore */ }
  }

  /**
   * 把关卡天空切到 key 并重建背景。
   * 原始天空在第一次改动时记下来，本局结束由 stopAll 还回去
   * —— 运行时改的只是这一局的显示，不会把编辑器的关卡设置改脏。
   */
  _applySky(key) {
    if (!key) return;
    const s = this.level.settings || (this.level.settings = {});
    if (s.sky !== key) {
      if (!this._skyDirty) { this._skyDirty = true; this._skySaved = s.sky; }
      s.sky = key;
    }
    if (this.b && this.b.applySky) { try { this.b.applySky(); } catch (e) { /* ignore */ } }
  }

  /* ============================================================
     脚本动作（代码块 / JS 表达式）
     ============================================================ */
  /**
   * 编译并执行一段脚本，返回其返回值。
   * 注入作用域见 worldapi.js 的 SCRIPT_ARGS：
   *   world(api) / player / session / vars / getVar / setVar / log / vec / v3 / self / THREE / wait
   * expr=true 时按「单个表达式」编译（自动 return）。
   * 代码里用了 await wait(秒) 时按 async 编译，这里返回 Promise：
   *   正常 → resolve(返回值)；出错 → 记 _scriptFail 后 resolve(undefined)，绝不 reject。
   * 循环看门狗（worldapi.js 的 instrumentLoops 插桩）每次调用现造一个：
   *   心跳 _hb 由每帧刷新，脚本同步死循环时它冻住，超过 SCRIPT_HANG_MS
   *   看门狗返回 false ⇒ 所有循环就地退出 ⇒ 跑完后统一报错。
   *   循环里有 await wait(秒) 就会跑帧、心跳前进，永远不会被截断。
   * 语法错误 / 运行异常都不会抛出，交 _scriptFail 记录。
   */
  runScript(code, expr, a, run) {
    if (!expr && !String(code == null ? '' : code).trim()) return undefined;   // 空代码：什么都不做
    const c = compileScript(code, expr);
    if (c.err) { this._scriptFail(a, c.err); return undefined; }
    const ctx = this.ctx;
    const wd = { hang: false };
    const tick = () => {
      if (wd.hang) return false;                              // 已截断：所有循环立刻退出
      if (nowMs() - this._hb <= SCRIPT_HANG_MS) return true;
      wd.hang = true;
      this._scriptFail(a, SCRIPT_HANG_MSG);                   // 立刻报错，不等脚本跑完
      return false;
    };
    /* 被看门狗截断时：丢掉返回值（结果变量不写脏数据） */
    const done = (v) => (wd.hang ? undefined : v);
    try {
      const out = c.fn(
        this.api, this.api, ctx.player || null, ctx.session || null, this.vars,
        (n, d) => this.getVar(n, d), (n, v) => this.setVar(n, v),
        (...args) => this._log(args),
        (x, y, z) => [Number(x) || 0, Number(y) || 0, Number(z) || 0],
        (x, y, z) => new THREE.Vector3(Number(x) || 0, Number(y) || 0, Number(z) || 0),
        { event: run ? run.ev : null, action: a, run: run || null, payload: run ? run.payload : null,
          triggerObject: run && run.payload ? run.payload.objectId || '' : '' },
        THREE,
        (sec) => this._wait(sec),
        tick,
      );
      if (c.async && out && typeof out.then === 'function') {
        return out.then((v) => done(v), (e) => { this._scriptFail(a, (e && e.message) || String(e)); return undefined; });
      }
      return done(out);
    } catch (e) {
      this._scriptFail(a, (e && e.message) || String(e));
      return undefined;
    }
  }

  /** 脚本出错：记进独立 Map（不进数据对象）+ 控制台 + 编辑器输出面板 + 一次顶部提示 */
  _scriptFail(a, msg) {
    const key = (a && a.id) || '?';
    if (this.scriptErrors.get(key) === msg) return;   // 同一错误不重复刷屏
    this.scriptErrors.set(key, msg);
    console.error('[事件脚本]', msg, a);
    this._log(['脚本错误：' + msg], 'e');
    if (this.ctx && this.ctx.notice) this.ctx.notice('事件脚本出错：' + msg, 'error', 4);
  }

  /** 脚本里的 log(...)：转发到编辑器「输出」面板，没有面板时落到控制台 */
  _log(args, kind = 'i') {
    const text = (args || []).map(fmtLog).join(' ');
    if (this.ctx && typeof this.ctx.log === 'function') {
      try { this.ctx.log(text, kind); return; } catch (e) { /* 面板出错不影响游戏 */ }
    }
    if (kind === 'e') console.error('[脚本]', text); else console.log('[脚本]', text);
  }

  /* ============================================================
     射线检测 / 读取属性
     ============================================================ */
  /** 射线端点：按「方式 + 参照对象 / 坐标」求世界坐标（side = 'From' | 'To'） */
  rayPoint(run, a, side) {
    const from = side === 'From';
    const mode = a[from ? 'rayFromMode' : 'rayToMode'] || (from ? 'player' : 'dir');
    const objKey = from ? 'rayFromObj' : 'rayToObj';
    const vecKey = from ? 'rayFromVec' : 'rayToVec';
    const fallback = isVec3(a[vecKey]) ? a[vecKey] : (from ? [0, 0, 0] : [0, -1, 0]);
    if (mode === 'player') {
      const p = this.ctx.player;
      if (!p) return [0, 0, 0];
      const f = p.feetPos || p.body.position;
      return [f.x, f.y + PLAYER.bodyH + PLAYER.headH * 0.5, f.z];   // 头部中心 ≈ 眼位
    }
    if (mode === 'object') {
      const rid = this.objIdOf(this.inputStr(run, a, objKey, a[objKey]));
      const r = rid ? this.b.objects.get(rid) : null;
      return r ? worldPosition(this.level, r.o).slice() : [0, 0, 0];
    }
    const v = this.inputVec(run, a, vecKey, fallback);
    if (mode !== 'dir') return v;
    // 方向模式：终点 = 起点 + 归一化方向 × 长度
    const base = this.rayPoint(run, a, 'From');
    const len = Math.max(0, this.inputVal(run, a, 'range', 20));
    const m = Math.hypot(v[0], v[1], v[2]) || 1;
    return [base[0] + v[0] / m * len, base[1] + v[1] / m * len, base[2] + v[2] / m * len];
  }

  /**
   * 读取属性：propTarget(对象/玩家/世界/会话) + propPath 点号路径。
   * 路径以 rec. 开头时从「运行时记录」读（如 rec.body.velocity.x）。
   */
  readPath(run, a) {
    let path = String(this.inputStr(run, a, 'propPath', a.propPath) || '').trim();
    const target = a.propTarget || 'object';
    let root = null;
    if (target === 'object') {
      const rid = this.objIdOf(this.inputStr(run, a, 'objectId', a.objectId));
      const r = rid ? this.b.objects.get(rid) : null;
      if (path.startsWith('rec.')) { root = r; path = path.slice(4); }
      else if (path.startsWith('runtime.')) { root = r; path = path.slice(8); }
      else root = r ? r.o : null;
    } else if (target === 'player') root = this.ctx.player || null;
    else if (target === 'world') root = this.api;
    else if (target === 'session') root = this.ctx.session || null;
    return pathGet(root, path);
  }
}

/* ---------- 脚本动作的辅助 ---------- */
/** log(...) 的参数格式化（对象句柄 / 错误 / 循环引用都不炸） */
function fmtLog(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v.__handle) return '{对象 ' + v.id + '}';
  if (v instanceof Error) return v.message;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

/** 按点号路径取值（空路径 = 目标本身） */
function pathGet(root, path) {
  let cur = root;
  for (const k of String(path || '').split('.')) {
    if (!k) continue;
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

/* ---------- 比较运算 ---------- */
export function compare(a, op, b) {
  const na = Number(a) || 0, nb = Number(b) || 0;
  switch (op) {
    case '==': return String(a) === String(b) || na === nb;
    case '!=': return !(String(a) === String(b) || na === nb);
    case '>': return na > nb;
    case '<': return na < nb;
    case '>=': return na >= nb;
    case '<=': return na <= nb;
    default: return false;
  }
}

export const OP_OPTIONS = [
  { v: '=', l: '=' }, { v: '+=', l: '+=' }, { v: '-=', l: '-=' }, { v: '*=', l: '*=' },
  { v: '/=', l: '/=' }, { v: 'toggle', l: '翻转' }, { v: '==', l: '等于' }, { v: '!=', l: '不等于' },
  { v: '>', l: '大于' }, { v: '<', l: '小于' }, { v: '>=', l: '≥' }, { v: '<=', l: '≤' },
];

export function createEvent(name) {
  return {
    id: uid('ev'), name: name || '事件', enabled: true,
    trigger: { type: 'levelStart', objectId: '', time: 1, repeat: false, value: 0, varName: '', op: '==', once: false },
    start: null,              // 入口动作 id 列表（null = 用 actions[0]，旧关卡零迁移）
    actions: [],
  };
}
export function createAction(type) {
  const t = type || 'wait';
  return {
    type: t, objectId: '', property: 'position', value: 0,
    vec: t === 'setGravity' ? [0, -1, 0] : [0, 0, 0],
    time: 1, easing: 'linear', animId: '', sound: 'click', volume: 1, playerField: 'speed',
    tool: 'key', varName: 'var1', op: '=', cond: '', effect: 'splash', comment: '',
    /* 随机数 / 数组 / 循环 追加字段 */
    rmin: 0, rmax: 1, isInt: true, chance: 50, destVar: 'tmp', srcVar: 'arr',
    list: '1,2,3', index: 0, count: 3, maxIter: 100, audio: '', loopAudio: false,
    /* 顶部提示 */
    noticeText: '', noticeKind: 'info',
    /* 天空球渐变 */
    fromSky: '', toSky: '',
    /* 玩家 morph */
    morphMode: 'preset', morphPreset: 'classic', morphAsset: '', morphScale: 1, morphYaw: 0, morphY: 0,
    /* 执行图（id + 输出目标；不落库时为隐式线性链） */
    id: uid('a'), next: null,
    /* 值接线与暴露参数 */
    inputs: null, expose: [],
    /* 等待 / 等待直到 */
    waitMode: 'time', untilCond: '',
    /* if / elseif / else */
    elifs: [],
    /* 高级运算 */
    formula: '', argA: 0, argB: 0, argC: 0, argD: 0, argX: 0, argY: 0, argZ: 0, argW: 0,
    /* 对象生成 / 克隆 / 挂父级 */
    templateId: '', posMode: 'rel', posRef: '', deepTree: false, parent: '', keepWorld: true,
    /* 脚本块 / JS 表达式块 */
    code: '',
    /* 射线检测 */
    rayFromMode: 'player', rayFromObj: '', rayFromVec: [0, 0, 0],
    rayToMode: 'dir', rayToObj: '', rayToVec: [0, -1, 0], range: 20,
    destObj: 'hitObj', destPos: 'hitPos', destNormal: 'hitNormal', destDist: 'hitDist',
    /* 读取属性 */
    propTarget: 'object', propPath: '',
    /* 2D 平台模式 */
    platMode: 'on', platPoint: [0, 0, 0], platNormal: [0, 0, -1], platDist: 22,
    /* 重力变化（vec 默认朝下，零向量会在运行时回退成 [0,-1,0]） */
    gravityTarget: 'world', gravityPower: 1,
    /* NPC / 角色 */
    npcId: '', node: '', npcBehavior: 'follow', npcKeep: 7, npcOn: true,
    sayText: '', sayTime: 3, npcFace: 'player', npcClip: '',
  };
}

/** 关卡里是否存在非空脚本（导入第三方关卡时的安全闸门用） */
export function levelHasScripts(level) {
  for (const ev of ((level && level.events) || [])) {
    for (const a of ((ev && ev.actions) || [])) {
      if (!a) continue;
      if ((a.type === 'script' || a.type === 'evalExpr') && String(a.code || '').trim()) return true;
    }
  }
  return false;
}

export function createAnimation(name) {
  return { id: uid('an'), name: name || '动画', duration: 2, loop: false, pingpong: false, autoplay: false, enabled: true, tracks: [] };
}
export function createTrack(objectId) {
  return { objectId: objectId || '', property: 'position', type: 'vec3', keys: [] };
}

export { ACTION_TYPES, TRIGGER_TYPES, Ease, deepClone };