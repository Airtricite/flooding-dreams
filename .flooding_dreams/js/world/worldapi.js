/* ============================================================
   事件脚本世界 API（WorldAPI）
   ------------------------------------------------------------
   · createWorldApi(runtime)：把关卡运行时（builder / level / ctx / vars）
     包成一个「文档化的活体 API」——读取世界一切、交互世界一切、
     空间查询（raycast 等）、世界与流程控制。
   · WORLD_API_DOC / SCRIPT_GLOBALS 是同一份目录，同时供
     编辑器「API 参考」浮层与代码块自动补全使用。
   · compileScript(src, expr)：用 new Function 编译脚本（结果缓存），
     语法错误时返回 { fn:null, err }，绝不抛给调用方。
   ------------------------------------------------------------
   约定：所有坐标一律用 [x, y, z] 数组（与关卡数据同构），
   不使用 THREE.Vector3，避免运行时对象被序列化进存档。
   ============================================================ */
import * as THREE from 'three';
import {
  getObject, childrenOf, worldPosition, objectLabel, objectsOfType,
  removeObjectTree, reparentObject,
} from './level.js';
import { clamp } from '../core/util.js';

/* ============================================================
   脚本编译
   ============================================================ */
/** 注入脚本作用域的全局名（顺序即 new Function 的参数顺序） */
export const SCRIPT_ARGS = [
  'world', 'api', 'player', 'session', 'vars',
  'getVar', 'setVar', 'log', 'vec', 'v3', 'self', 'THREE', 'wait',
];

/** 供自动补全使用的全局说明 */
export const SCRIPT_GLOBALS = [
  { n: 'world', d: '世界 API（读取 / 交互 / 空间查询 / 流程控制），也可写作 api' },
  { n: 'api', d: 'world 的别名' },
  { n: 'player', d: '玩家本体：oxygen / health / feetPos / env / statSpeed …' },
  { n: 'session', d: '会话本体：time / timeScale / status / win() / fail() …' },
  { n: 'vars', d: '事件变量表（活体对象，可直接 vars.x = 1）' },
  { n: 'getVar(name, def)', d: '读事件变量' },
  { n: 'setVar(name, v)', d: '写事件变量' },
  { n: 'log(...)', d: '输出到编辑器「输出」面板' },
  { n: 'vec(x, y, z)', d: '构造坐标数组 [x, y, z]（y 省略时为 0）' },
  { n: 'v3(x, y, z)', d: '构造 THREE.Vector3（做向量运算时用）' },
  { n: 'self', d: '本次执行的上下文：{ event, action, run, payload, triggerObject }' },
  { n: 'THREE', d: 'three.js 命名空间（高级用法）' },
  { n: 'await wait(seconds)', d: '暂停本段事件流程 N 秒后继续（小数可，受 timeScale 影响）' },
];

const _cache = new Map();
const _EMPTY = { fn: () => undefined, err: null };
/** AsyncFunction 构造器：代码块里出现 await / wait(...) 时用 */
const _AsyncFunction = Object.getPrototypeOf(async function () { /* noop */ }).constructor;
const _NEEDS_ASYNC = /\bawait\b|\bwait\s*\(/;

/* ============================================================
   循环看门狗：把脚本里的循环改造成「可被截断」的循环
   ------------------------------------------------------------
   纯 JS 死循环会冻住主线程（帧循环 / 定时器都跑不了），
   唯一能中途叫停的办法是往循环里插检查点：
     while (c)       → while (TICK() && (c))
     for (a; c; d)   → for (a; TICK() && (c); d)
     for (;;)        → for (; TICK() && 1; )
     for (x of y) {} → for (x of y) { if (!TICK()) break; … }
   TICK 是事件运行时每次执行脚本时现造的闭包，它的时间基准来自
   运行时每帧刷新的心跳（events.js 的 _hb）：
   · 循环里 await wait(秒) ⇒ 主线程继续跑帧 ⇒ 心跳前进 ⇒ 不会被截断
   · 同步死循环 ⇒ 心跳冻结 ⇒ 超过 10 秒 TICK 返回 false，循环就地退出，
     脚本跑完后由运行时统一报错（见 events.js 的 SCRIPT_HANG_MSG）
   TICK 返回 false 而不是抛错，是为了保证「无论如何都能退出循环」——
   抛错会被用户自己的 try/catch 吞掉，反而可能继续死循环。
   ============================================================ */
/** 注入到脚本作用域的看门狗函数名（不对用户公开，仅自动插桩使用） */
export const LOOP_TICK_ARG = '__FD_TICK__';

const RE_ID_CH = /[A-Za-z0-9_$]/;
const RE_STR_END = ')]}"\'`';             // 这些字符之后出现的 / 只可能是除号
const RE_AFTER_KW = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void',
  'instanceof', 'new', 'do', 'else', 'yield', 'await', 'default']);

/**
 * 把字符串 / 注释 / 正则 / 模板字面量的内容抹成空格（长度与换行不变），
 * 于是后面按偏移在原串上扫描关键字时不会扫到字面量里的 for / while。
 */
function maskLiterals(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0, prevCh = '', prevWord = '';
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i + 2; while (j < n && src[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2); blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === c) { j++; break; } j++; }
      blank(i, j); prevCh = c; prevWord = ''; i = j; continue;
    }
    if (c === '/' && (prevCh === '' || (!RE_ID_CH.test(prevCh) && RE_STR_END.indexOf(prevCh) < 0)
      || RE_AFTER_KW.has(prevWord))) {
      let j = i + 1, cls = false, ok = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (cls) { cls = false; j++; continue; }
        if (d === '[') { cls = true; j++; continue; }
        if (d === '/') { j++; ok = true; break; }
        j++;
      }
      if (ok) { blank(i, j); i = j; prevCh = ')'; prevWord = ''; continue; }
    }
    if (RE_ID_CH.test(c)) {
      let j = i; while (j < n && RE_ID_CH.test(src[j])) j++;
      prevWord = src.slice(i, j); prevCh = src[j - 1]; i = j; continue;
    }
    if (!/\s/.test(c)) { prevCh = c; prevWord = ''; }
    i++;
  }
  return out.join('');
}

/** 插桩：返回改造后的源码（无法插桩的地方原样保留） */
function instrumentLoops(src) {
  const masked = maskLiterals(src);
  const ins = [];
  const re = /\b(for|while)\b/g;
  let m;
  while ((m = re.exec(masked))) {
    const kw = m[1];
    const k = m.index;
    if (k > 0 && masked[k - 1] === '.') continue;          // 属性名：obj.for / obj.while
    let j = k + kw.length;
    while (j < masked.length && /\s/.test(masked[j])) j++;
    if (kw === 'for' && masked.startsWith('await', j)) {   // for await (…)
      j += 5; while (j < masked.length && /\s/.test(masked[j])) j++;
    }
    if (masked[j] !== '(') continue;
    let depth = 0, e = j;
    for (; e < masked.length; e++) {
      if (masked[e] === '(') depth++;
      else if (masked[e] === ')') { depth--; if (depth === 0) break; }
    }
    if (e >= masked.length) continue;                      // 括号不配对：交给语法检查报错
    if (kw === 'while') {
      /* do…while 的 while 也走这里，一样被守住 */
      ins.push({ at: j + 1, text: LOOP_TICK_ARG + '() && (' });
      ins.push({ at: e, text: ')' });
      continue;
    }
    /* for：数出头部顶层分号，判断是经典三段式还是 for-of / for-in */
    let d = 0, s1 = -1, s2 = -1;
    for (let q = j + 1; q < e; q++) {
      const c = masked[q];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (c === ';' && d === 0) { if (s1 < 0) s1 = q; else if (s2 < 0) s2 = q; }
    }
    if (s1 >= 0 && s2 >= 0) {
      const cond = src.slice(s1 + 1, s2).trim();
      ins.push({ at: s1 + 1, text: ' ' + LOOP_TICK_ARG + '() && (' + (cond || '1') + ')' });
      continue;
    }
    /* for-of / for-in：条件不可插桩，改在循环体（花括号块）开头插一句 break 守卫 */
    let q = e + 1;
    while (q < masked.length && /\s/.test(masked[q])) q++;
    if (masked[q] === '{') ins.push({ at: q + 1, text: ' if (!' + LOOP_TICK_ARG + '()) break;' });
  }
  if (!ins.length) return src;
  ins.sort((a, b) => b.at - a.at);
  let out = src;
  for (const it of ins) out = out.slice(0, it.at) + it.text + out.slice(it.at);
  return out;
}

/**
 * 编译事件脚本。expr=true 时按「单个表达式」编译（自动 return）。
 * 空代码返回空操作（不报错）。
 * 代码里出现 await / wait(...) 时按 async 函数编译，返回 { async:true }，
 * 由事件运行时挂起本流直到 Promise 落定（见 events.js 的 run.pending）。
 * 函数多带一个看门狗参数（LOOP_TICK_ARG），调用方见 events.js 的 runScript。
 */
export function compileScript(src, expr = false) {
  const code = String(src == null ? '' : src);
  if (!code.trim()) return expr ? { fn: () => 0, err: null } : _EMPTY;
  const isAsync = !expr && _NEEDS_ASYNC.test(code);
  const key = (expr ? 'E:' : isAsync ? 'A:' : 'S:') + code;
  const hit = _cache.get(key);
  if (hit) return hit;
  const Fn = isAsync ? _AsyncFunction : Function;
  const wrap = (s) => (expr ? 'return (' + s + '\n);' : s);
  let out;
  try {
    /* 先按原样编译：语法错误时给出的是用户自己代码的报错 */
    /* eslint-disable-next-line no-new-func */
    const plain = new Fn(...SCRIPT_ARGS, LOOP_TICK_ARG, wrap(code));
    let fn = plain;
    try {
      /* eslint-disable-next-line no-new-func */
      fn = new Fn(...SCRIPT_ARGS, LOOP_TICK_ARG, wrap(instrumentLoops(code)));
    } catch (e) {
      fn = plain;         // 插桩失败（极罕见写法）就退回未插桩版本，不影响功能
    }
    out = { fn, err: null, async: isAsync };
  } catch (e) {
    out = { fn: null, err: (e && e.message) || '语法错误' };
  }
  if (_cache.size > 256) _cache.clear();
  _cache.set(key, out);
  return out;
}

/** 语法检查：返回错误文案，OK / 空时返回 null（编辑器用） */
export function scriptError(src, expr = false) {
  return compileScript(src, expr).err;
}

/* ============================================================
   小工具
   ============================================================ */
function toVec3(v, def = [0, 0, 0]) {
  if (Array.isArray(v)) return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
  if (v && typeof v === 'object' && !v.__handle && ('x' in v || 'y' in v || 'z' in v)) {
    return [Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0];
  }
  return def.slice();
}
function isVec3(v) {
  return Array.isArray(v) && v.length >= 3 && v.every((n) => Number.isFinite(Number(n)));
}

/* ============================================================
   API 工厂
   ============================================================ */
/**
 * @param {object} rt EventRuntime（需要 .b / .level / .ctx / .vars / .getVar / .setVar）
 */
export function createWorldApi(rt) {
  const b = rt.b;
  const level = rt.level;
  const ctx = rt.ctx || {};
  const vars = rt.vars || {};      // 事件变量表（活体对象，脚本里可直接读写）

  /* ---------- 对象解析 ---------- */
  /** 任意写法 → 关卡对象数据（id / 对象名 / 句柄 / 数据对象） */
  function find(spec) {
    if (!spec) return null;
    if (typeof spec === 'object') {
      if (spec.__handle) return getObject(level, spec.id);
      if (spec.id) return getObject(level, spec.id) || null;
      return null;
    }
    const s = String(spec);
    return getObject(level, s) || level.objects.find((o) => o.name === s) || null;
  }
  function recOf(spec) {
    const o = find(spec);
    return o ? (b.objects.get(o.id) || null) : null;
  }

  /** 通用点解析：数组 / {x,y,z} / 对象 / 句柄 / 玩家 */
  function point(spec, def = [0, 0, 0]) {
    if (isVec3(spec)) return toVec3(spec);
    if (spec && typeof spec === 'object' && !spec.__handle && !spec.id
      && ('x' in spec || 'y' in spec || 'z' in spec)) return toVec3(spec, def);
    const p = ctx.player;
    if (spec === 'player' || spec === p) {
      return p && p.feetPos ? [p.feetPos.x, p.feetPos.y, p.feetPos.z] : def.slice();
    }
    const o = find(spec);
    if (o) return worldPosition(level, o).slice();
    return def.slice();
  }

  /* ---------- 对象句柄 ---------- */
  function handle(id) {
    const o = () => getObject(level, id);
    const rec = () => b.objects.get(id) || null;
    const h = {
      __handle: true,
      id,
      get exists() { return !!o(); },
      get data() { return o(); },
      get rec() { return rec(); },
      type: () => { const x = o(); return x ? String(x.type || '') : ''; },
      name: () => objectLabel(o()),
      pos: () => toVec3(o() && o().position),
      rot: () => toVec3(o() && o().rotation),
      scale: () => toVec3(o() && o().scale),
      worldPos: () => { const x = o(); return x ? worldPosition(level, x).slice() : [0, 0, 0]; },
      prop: (k) => { const x = o(); return x ? x[k] : undefined; },
      visible: () => { const x = o(); return !x || x.visible !== false; },
      parentId: () => { const x = o(); return (x && x.parent) || ''; },
      parent: () => { const x = o(); return x && x.parent ? handle(x.parent) : null; },
      children: () => childrenOf(level, id).map((c) => handle(c.id)),
      set: (k, v) => { const r = rec(); if (r) rt.setObjectProperty(r, k, v); return h; },
      move: (d) => {
        const x = o(); if (!x) return h;
        const p = toVec3(x.position), q = toVec3(d);
        return h.set('position', [p[0] + q[0], p[1] + q[1], p[2] + q[2]]);
      },
      moveTo: (v) => h.set('position', toVec3(v)),
      rotate: (d) => {
        const x = o(); if (!x) return h;
        const p = toVec3(x.rotation), q = toVec3(d);
        return h.set('rotation', [p[0] + q[0], p[1] + q[1], p[2] + q[2]]);
      },
      scaleTo: (v) => h.set('scale', toVec3(v, [1, 1, 1])),
      show: () => h.set('visible', true),
      hide: () => h.set('visible', false),
      color: (c) => h.set('color', c),
      prop3: (k, v) => h.set(k, v),
      open: () => { const r = rec(); if (r && ctx.mechanisms) ctx.mechanisms.openDoor(r); return h; },
      close: () => { const r = rec(); if (r && ctx.mechanisms) ctx.mechanisms.closeDoor(r); return h; },
      setFill: (f) => { const r = rec(); if (r && ctx.liquids) ctx.liquids.setFill(r, clamp(Number(f) || 0, 0, 1)); return h; },
      clone: (opts) => spawn(h, opts),
      reparent: (p, keepWorld = true) => api.reparent(h, p, keepWorld),
      remove: () => { api.remove(h); },
    };
    return h;
  }

  /* ---------- 生成 / 克隆 / 删除 / 挂父级 ---------- */
  function spawn(spec, opts = {}) {
    const src = recOf(spec);
    if (!src) return null;
    const deep = opts.deep !== false;
    const copy = rt.spawnCopy(src, deep);
    if (!copy) return null;
    if (opts.pos !== undefined) copy.position = toVec3(opts.pos);
    const rec = rt.spawnBuild(copy);
    if (opts.parent) {
      const pid = (find(opts.parent) || {}).id || '';
      if (pid && reparentObject(level, copy.id, pid)) {
        if (opts.keepWorld === false) { /* 保持局部坐标 */ } else if (isVec3(opts.pos)) { /* 已显式定位 */ }
        if (rec) b.rebuild(rec);
      }
    }
    return handle(copy.id);
  }

  function reparent(childSpec, parentSpec, keepWorld = true) {
    const child = find(childSpec);
    if (!child) return false;
    const pid = parentSpec ? ((find(parentSpec) || {}).id || null) : null;
    if ((child.parent || null) === pid) return true;
    const before = keepWorld ? { pos: toVec3(child.position), rot: toVec3(child.rotation) } : null;
    if (!reparentObject(level, child.id, pid)) return false;
    if (before && !pid) { child.position = before.pos; child.rotation = before.rot; }
    const rec = b.objects.get(child.id);
    if (rec) b.rebuild(rec);
    return true;
  }

  function remove(spec) {
    const o = find(spec);
    if (!o) return 0;
    const victim = recOf(o.id);
    const n = removeObjectTree(level, o.id);
    b.destroyObject(o.id);
    void victim;
    b.computeBounds();
    rt.created.delete(o.id);
    return n;
  }

  /* ---------- 空间查询 ---------- */
  /** opts: { mask, group, hitPlayer, visual, skipBackfaces } */
  function raycast(from, to, opts = {}) {
    const a = point(from), c = point(to);
    return b.raycastClosest(a, c, opts) || { hit: false, objectId: '', type: '', point: c, normal: [0, 0, 0], distance: -1, rec: null };
  }
  function raycastDir(from, dir, range = 100, opts = {}) {
    const a = point(from), d = toVec3(dir);
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const to = [a[0] + d[0] / len * range, a[1] + d[1] / len * range, a[2] + d[2] / len * range];
    return raycast(a, to, opts);
  }
  function raycastAll(from, to, opts = {}) {
    const a = point(from), c = point(to);
    return b.raycastAll(a, c, opts) || [];
  }

  /** 遍历世界对象：pred(handle, o) 为真才收 */
  function query(pred, center = null, maxDist = Infinity) {
    const c = center ? point(center) : null;
    const out = [];
    for (const rec of b.objects.values()) {
      const o = rec.o;
      if (!o) continue;
      const h = handle(o.id);
      if (pred && !pred(h, o)) continue;
      let d = 0;
      if (c) {
        const p = worldPosition(level, o);
        d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
        if (d > maxDist) continue;
      }
      out.push({ handle: h, id: o.id, type: o.type, name: objectLabel(o), distance: d });
    }
    return out;
  }

  function inRadius(center, r, opts = {}) {
    const rad = Math.max(0, Number(r) || 0);
    const list = query((h, o) => (opts.type ? o.type === opts.type : true)
      && (opts.visibleOnly ? h.visible() : true), center, rad);
    list.sort((a, c) => a.distance - c.distance);
    return list;
  }
  function nearest(center, opts = {}) {
    return inRadius(center, opts.range === undefined ? Infinity : opts.range, opts)[0] || null;
  }
  function distance(a, c) {
    const p = point(a), q = point(c);
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  }
  function lineOfSight(a, c, opts = {}) {
    return !raycast(a, c, opts).hit;
  }

  /* ---------- 玩家 / 会话 ---------- */
  const p = () => ctx.player;
  function setPlayer(field, value) { const pl = p(); if (pl) rt.setPlayerField(pl, field, value); }

  function teleport(spec) {
    const pl = p(); if (!pl) return;
    const v = point(spec, [0, 0, 0]);
    pl.teleport(new THREE.Vector3(v[0], v[1], v[2]));
  }

  /* ---------- 摄像机 ---------- */
  const cam = () => ctx.cameraCtl || null;
  const camera = {
    get firstPerson() { const c = cam(); return !!(c && c.isFirstPerson); },
    mode: () => { const c = cam(); return c ? c.mode : 'third'; },
    setMode(m) { const c = cam(); if (c) c.mode = m === 'first' ? 'first' : 'third'; },
    toggle: () => { const c = cam(); return c ? c.toggleMode() : null; },
    shake: (v) => { const c = cam(); if (c) c.shake(Number(v) || 0); },
    look: (dx, dy) => { const c = cam(); if (c) c.look(Number(dx) || 0, Number(dy) || 0); },
    zoom: (d) => { const c = cam(); if (c) c.zoom(Number(d) || 0); },
    pos: () => { const c = cam(); return c && c.camera ? toVec3(c.camera.position) : [0, 0, 0]; },
  };

  /* ---------- 汇总 ---------- */
  const api = {
    /* 元信息 */
    get level() { return level; },
    get scene() { return ctx.scene || (b.scene || null); },
    get builder() { return b; },
    get session() { return ctx.session || null; },
    get time() { return (ctx.session && ctx.session.time) || 0; },
    get player() { return p(); },

    /* 读取 */
    get: (spec) => { const o = find(spec); return o ? handle(o.id) : null; },
    obj: (spec) => find(spec),
    has: (spec) => !!find(spec),
    all: (type) => (type ? objectsOfType(level, type) : level.objects.slice()).map((o) => handle(o.id)),
    ids: (type) => (type ? objectsOfType(level, type) : level.objects.slice()).map((o) => o.id),
    count: (type) => (type ? objectsOfType(level, type) : level.objects).length,
    find: (pred) => query(pred).map((x) => x.handle),
    query,
    label: (spec) => objectLabel(find(spec)),
    pos: (spec) => { const o = find(spec); return o ? toVec3(o.position) : [0, 0, 0]; },
    worldPos: (spec) => { const o = find(spec); return o ? worldPosition(level, o).slice() : [0, 0, 0]; },
    prop: (spec, key, def) => { const o = find(spec); return o ? (o[key] === undefined ? def : o[key]) : def; },
    vars,

    /* 交互 */
    set: (spec, key, value) => { const r = recOf(spec); if (r) rt.setObjectProperty(r, key, value); return api; },
    moveTo: (spec, v) => api.set(spec, 'position', toVec3(v)),
    moveBy: (spec, d) => { const o = find(spec); if (o) api.set(spec, 'position', [toVec3(o.position)[0] + toVec3(d)[0], toVec3(o.position)[1] + toVec3(d)[1], toVec3(o.position)[2] + toVec3(d)[2]]); return api; },
    show: (spec) => api.set(spec, 'visible', true),
    hide: (spec) => api.set(spec, 'visible', false),
    color: (spec, c) => api.set(spec, 'color', c),
    open: (spec) => { const r = recOf(spec); if (r && ctx.mechanisms) ctx.mechanisms.openDoor(r); return api; },
    close: (spec) => { const r = recOf(spec); if (r && ctx.mechanisms) ctx.mechanisms.closeDoor(r); return api; },
    setFill: (spec, f) => { const r = recOf(spec); if (r && ctx.liquids) ctx.liquids.setFill(r, clamp(Number(f) || 0, 0, 1)); return api; },
    spawn,
    clone: spawn,
    remove,
    reparent,

    /* 子系统（本体直通） */
    get liquids() { return ctx.liquids || null; },
    get anims() { return ctx.anims || null; },
    get fx() { return ctx.fx || null; },
    get audio() { return ctx.audio || null; },
    get mechanisms() { return ctx.mechanisms || null; },
    playAnim: (id) => { if (ctx.anims) ctx.anims.play(id); },
    stopAnim: (id) => { if (ctx.anims) ctx.anims.stop(id); },

    /* 空间查询 */
    raycast, raycastDir, raycastAll, inRadius, nearest, distance, lineOfSight,

    /* 玩家 */
    teleport,
    setPlayer,
    /**
     * 改重力方向 / 强度。
     * @param {number[]} dir 重力方向 [x,y,z]（自动归一化；零向量回退朝下）
     * @param {{target?:'world'|'player'|'both', power?:number, time?:number, easing?:string}} [opts]
     *   target: world=整个物理世界(含玩家) / player=仅玩家 / both=世界与玩家
     *   power : 强度倍率（1 = 标准重力，0 = 失重，负数 = 反向）
     *   time  : > 0 时用该秒数平滑补间
     */
    setGravity: (dir, opts = {}) => {
      rt.setGravityVector(opts.target || 'world', dir,
        opts.power === undefined ? 1 : opts.power, Number(opts.time) || 0, opts.easing);
      return api;
    },
    get gravity() { const w = b && b.world; return w ? [w.gravity.x, w.gravity.y, w.gravity.z] : [0, 0, 0]; },
    damage: (n = 10) => { const pl = p(); if (pl) pl.damage(Number(n) || 0, 'event'); },
    kill: (cause) => { const pl = p(); if (pl) pl.kill(cause || 'event'); },
    oxygen: (v) => { const pl = p(); if (!pl) return; const n = Number(v) || 0; if (n >= 0) pl.addOxygen(n); else pl.takeOxygen(-n); },
    giveTool: (name) => { const pl = p(); if (pl) pl.giveToolByName(name); },
    morph: (opts) => { const pl = p(); return pl && typeof pl.morph === 'function' ? pl.morph(opts || {}) : null; },

    /* 流程 / 提示 */
    notice: (text, kind = 'info', dur = 3) => { if (ctx.notice) ctx.notice(String(text), kind, dur); },
    hint: (text, dur = 1.6) => { if (ctx.hint) ctx.hint(String(text), dur); },
    log: (...a) => { log(...a); },
    win: () => { if (ctx.onWin) ctx.onWin(null); },
    fail: (reason) => { if (ctx.onFail) ctx.onFail(reason || 'event'); },
    get timeScale() { return api.session ? api.session.timeScale : 1; },
    set timeScale(v) { const s = api.session; if (s) s.timeScale = clamp(Number(v) || 1, 0.05, 8); },

    /* 世界本体 */
    camera,

    /* 变量 */
    getVar: (name, def) => rt.getVar(name, def),
    setVar: (name, v) => rt.setVar(name, v),
    addVar: (name, v) => rt.applyOp(name, '+=', v),

    /* 播放音效 */
    sound: (name, opts) => { if (ctx.audio) ctx.audio.play(String(name), opts || {}); },
  };

  return api;
}

/* ============================================================
   API 参考目录（编辑器浮层 + 自动补全）
   ============================================================ */
export const WORLD_API_DOC = [
  {
    t: '读取世界',
    list: [
      { n: 'world.get(idOrName)', d: '取对象句柄；不存在返回 null。也接受对象名。' },
      { n: 'world.obj(id)', d: '取底层关卡对象数据（可直接读写字段）' },
      { n: 'world.all(type?)', d: '全部对象句柄数组，可按类型过滤' },
      { n: 'world.ids(type?) / world.count(type?)', d: '全部对象 id / 数量' },
      { n: 'world.find(handle => bool)', d: '按条件筛选对象（返回句柄数组）' },
      { n: 'world.pos(spec) / world.worldPos(spec)', d: '局部坐标 / 世界坐标' },
      { n: 'world.prop(spec, key, def?)', d: '读任意字段' },
      { n: 'world.vars / getVar(name) / setVar(name, v)', d: '事件变量表' },
    ],
  },
  {
    t: '对象句柄',
    list: [
      { n: 'h.id / h.data / h.rec / h.exists', d: 'id / 数据 / 运行时记录 / 是否存在' },
      { n: 'h.pos() h.rot() h.scale() h.worldPos()', d: '读取变换（返回 [x,y,z]）' },
      { n: 'h.prop(k) h.visible() h.parent() h.children() h.name() h.type()', d: '读取属性 / 层级' },
      { n: 'h.set(k, v) h.move(d) h.moveTo(v) h.rotate(d) h.scaleTo(v)', d: '写属性 / 位移 / 旋转 / 缩放' },
      { n: 'h.show() h.hide() h.color(c)', d: '可见性与颜色' },
      { n: 'h.open() h.close() h.setFill(f)', d: '开门 / 关门 / 设液面高度(0~1)' },
      { n: 'h.clone(opts) h.reparent(p, keepWorld) h.remove()', d: '克隆 / 挂父级 / 删除' },
    ],
  },
  {
    t: '生成与结构',
    list: [
      { n: 'world.spawn(template, { pos, parent, deep })', d: '以已有对象为模板生成一份，返回句柄' },
      { n: 'world.reparent(child, parent, keepWorld?)', d: '挂父级（parent 为空 = 移出）' },
      { n: 'world.remove(spec)', d: '删除对象及其子树' },
    ],
  },
  {
    t: '空间查询',
    list: [
      { n: 'world.raycast(from, to, opts?)', d: '射线：{ hit, objectId, type, point, normal, distance, rec }' },
      { n: 'world.raycastDir(from, dir, range, opts?)', d: '按方向打射线' },
      { n: 'world.raycastAll(from, to, opts?)', d: '穿透射线：全部命中（按距离排序）' },
      { n: 'world.inRadius(center, r, opts?)', d: '范围内对象：[{ handle, id, type, name, distance }]' },
      { n: 'world.nearest(center, opts?)', d: '最近的对象（opts.type / opts.range 过滤）' },
      { n: 'world.distance(a, b) / world.lineOfSight(a, b)', d: '两点距离 / 视线是否通畅' },
      { n: '坐标写法', d: '[x,y,z] / {x,y,z} / 对象 id / 句柄 / "player"' },
      { n: 'opts', d: '{ mask, group, hitPlayer, visual, skipBackfaces } —— hitPlayer 可命中玩家，visual 走可视网格' },
    ],
  },
  {
    t: '玩家',
    list: [
      { n: 'player.oxygen / health / maxOxygen / healthMax', d: '玩家数值' },
      { n: 'player.feetPos / body.position / env', d: '位置与所处环境（inLiquid / headUnder …）' },
      { n: 'world.setPlayer(field, v)', d: '改玩家属性：speed / jumpPower / gravityScale / oxygen / health / canSwim / invisible / frozen' },
      { n: 'world.setGravity(dir, { target, power, time, easing })', d: '改重力方向：dir 自动归一化；target = world(全局,含玩家)/player(仅玩家)/both；power = 强度倍率；time > 0 平滑补间' },
      { n: 'world.gravity', d: '当前世界重力向量 [x,y,z]；玩家独立重力见 player.gravOverride（null = 跟随世界）' },
      { n: 'world.teleport(spec) / world.kill() / world.damage(n)', d: '传送 / 击杀 / 扣血' },
      { n: 'world.oxygen(n)', d: '增减氧气（负数扣氧）' },
      { n: 'world.giveTool(name) / world.morph(opts)', d: '给予工具 / 变形象' },
    ],
  },
  {
    t: '世界与流程',
    list: [
      { n: 'world.notice(text, kind?, dur?)', d: '顶部提示（kind: info/warn/error/success）' },
      { n: 'world.hint(text, dur?)', d: '屏幕提示' },
      { n: 'world.sound(name, opts?)', d: '播放音效（jump / door / win / alarm …）' },
      { n: 'world.playAnim(id) / world.stopAnim(id)', d: '播放 / 停止关卡动画' },
      { n: 'world.camera.setMode("first"|"third")', d: '切换视角；shake(v) 震屏；look(dx,dy) 转视角' },
      { n: 'world.win() / world.fail(reason?)', d: '通关 / 失败' },
      { n: 'world.timeScale', d: '世界时间流速（0.05~8）' },
      { n: 'world.session / world.time / world.scene / world.builder', d: '会话、时间、场景、构建器本体' },
      { n: 'log(...) / world.log(...)', d: '输出到编辑器「输出」面板' },
    ],
  },
  {
    t: '语法提示',
    list: [
      { n: 'await wait(秒)', d: '暂停本段事件流程 N 秒后继续（小数可，受 timeScale 影响；只有写了 await 才会挂起）' },
      { n: 'return 值', d: '代码块填了「结果变量」时，return 的值会写进该变量' },
      { n: '表达式块', d: '「JS 表达式」块只写一个表达式，其结果作为值输出接到别的口' },
      { n: '循环超时会截断', d: '循环连续跑满 10 秒（判断为死循环）会被自动截断并报错；循环里 await wait(秒) 一下就不会被杀' },
    ],
  },
];

/* ---------- 供自动补全用的扁平成员表 ---------- */
/** 顶层成员：{ 'world.': [...], 'h.': [...] } 形态的简易索引 */
export const API_MEMBERS = (() => {
  const map = new Map();
  const add = (k, arr) => map.set(k, arr);
  add('world.', ['get', 'obj', 'has', 'all', 'ids', 'count', 'find', 'query', 'label', 'pos', 'worldPos', 'prop',
    'set', 'moveTo', 'moveBy', 'show', 'hide', 'color', 'open', 'close', 'setFill', 'spawn', 'clone', 'remove',
    'reparent', 'raycast', 'raycastDir', 'raycastAll', 'inRadius', 'nearest', 'distance', 'lineOfSight',
    'teleport', 'setPlayer', 'setGravity', 'gravity', 'damage', 'kill', 'oxygen', 'giveTool', 'morph', 'notice', 'hint', 'log', 'win', 'fail',
    'playAnim', 'stopAnim', 'sound', 'camera', 'vars', 'session', 'time', 'timeScale', 'level', 'scene', 'builder',
    'player', 'liquids', 'anims', 'fx', 'audio', 'mechanisms', 'getVar', 'setVar', 'addVar']);
  add('player.', ['oxygen', 'maxOxygen', 'health', 'healthMax', 'feetPos', 'body', 'env', 'statSpeed', 'statJump',
    'statGravity', 'gravOverride', 'statCanSwim', 'statInvisible', 'statFrozen', 'alive', 'yaw']);
  add('session.', ['time', 'timeScale', 'status', 'win', 'fail', 'player', 'level']);
  add('camera.', ['firstPerson', 'mode', 'setMode', 'toggle', 'shake', 'look', 'zoom', 'pos']);
  return map;
})();