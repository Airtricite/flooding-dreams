/* ============================================================
   Flooding Dreams — 跑酷寻路（编辑器专用）
   把关卡里「站得住人的实体表面」采样成落点图，再用 A* 求两个落点之间
   最快的通行路线：跑动沿表面、跳跃走抛物线、下落走自由落体。
   - 落点扫描分帧推进（step(budgetMs)），不会卡住编辑器
   - 边不预先计算：A* 展开时按需生成，出队时才用射线校验（懒验证），
     所以「能不能跳过去 / 切角会不会撞」都是真算出来的
   - 物理口径与 player.js 一致：起跳直接赋初速 jumpPower，空中按 airAccel
     从 0 加速到 walkSpeed，下落速度被 maxFallSpeed 硬截断
   ============================================================ */
import * as THREE from 'three';
import { PLAYER } from '../config.js';
import { NO_PHYSICS } from '../world/builder.js';

/* ---------- 采样参数 ---------- */
/* ★ 寻路范围（想再大/再小就改这三个数）：
   pad = max(PAD_MIN, PAD_JUMP_MUL × 满速跳距)，即节点盒四周往外多扫多少格。
   外扩越大越容易找到「绕出去抄近道」的路线，代价是落点更多、扫描更久。 */
const PAD_MIN = 40;           // 外扩下限(stud)
const PAD_JUMP_MUL = 3.2;     // 外扩 = 这个倍数 × 满速跳距（跳距≈10.6 → ≈34 格）
const PAD_EDGE = 24;          // 允许超出关卡包围盒多少（太小会把抄近道的地形裁掉）
const STEP_MIN = 2.0;         // 采样步长下限(stud)
const STEP_MAX = 5;           // 上限（区域太大时被迫粗化）
const MAX_COLUMNS = 6000;     // 目标列数上限：决定实际采样步长（调大=更细但更慢）
const SLOPE_MIN = 0.62;       // 可站立坡度：表面法线 ny 下限（≈52°）
const MIN_GAP = 0.45;         // 同一列里两层表面近于此值算作同一层
const HEAD_PAD = 0.12;        // 头顶净空检测的抬高量
const CELL = 12;              // 空间哈希格边长(stud)

/* ---------- 搜索参数 ---------- */
/* 注意：射线检测没有加速结构，每一条射线都要遍历全场景网格，很贵，
   所以展开数 / 校验数 / 单条边的探测段数 / 单条腿的耗时都必须封顶。 */
const WALK_MID_TOL = 0.62;    // 跑动边：中点地面与两端连线的允许偏差
const MARCH_STEP = 0.8;       // 抛物线净空检测的目标步长(stud)
const MARCH_MAX = 44;         // 单条边最多探测段数
const MAX_EXPAND = 12000;     // A* 最多展开节点数
const MAX_MARK = 1400;        // 一趟搜索最多做多少次边校验
const BUDGET_MS = 220;        // 单条腿的寻路时间上限，超时按当前结果收手（范围大→路线长，需要更多预算）
const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/* ============================================================
   物理口径（纯函数；p = { v0 起跳初速, sp 水平速度, g 重力, air 是否原地起跳 }）
   ============================================================ */
export function jumpApex(p) { return p.v0 * p.v0 / (2 * p.g); }

/** 水平位移随时间：跑动起跳恒速；原地起跳先按 airAccel 加速到上限再匀速 */
export function distAt(t, p) {
  if (!p.air) return p.sp * t;
  const a = PLAYER.airAccel;
  const t1 = p.sp > 0 ? Math.min(t, p.sp / a) : 0;
  return 0.5 * a * t1 * t1 + p.sp * Math.max(0, t - t1);
}

/** 自由落体在 t 时刻已下落的距离（速度被 maxFallSpeed 截断） */
export function dropAt(t, p) {
  if (t <= 0) return 0;
  const g = p.g, vm = PLAYER.maxFallSpeed, t1 = vm / g, h1 = 0.5 * g * t1 * t1;
  return t <= t1 ? 0.5 * g * t * t : h1 + vm * (t - t1);
}

/** 自由下落 h 格所需时间（含最大下落速度截断） */
export function dropTime(h, p) {
  if (h <= 0) return 0;
  const g = p.g, vm = PLAYER.maxFallSpeed, t1 = vm / g, h1 = 0.5 * g * t1 * t1;
  return h <= h1 ? Math.sqrt(2 * h / g) : t1 + (h - h1) / vm;
}

/** 跳跃相对起跳点的高度随时间（先抛物上升，过顶点后按截断的自由落体下降） */
export function jumpY(t, p) {
  const ta = p.v0 / p.g;
  if (t <= ta) return p.v0 * t - 0.5 * p.g * t * t;
  return jumpApex(p) - dropAt(t - ta, p);
}

/** 跳跃到相对高度 dy（可为负）所需时间；dy 高于跳跃顶点时返回 NaN */
export function jumpTime(dy, p) {
  const apex = jumpApex(p);
  if (dy > apex) return NaN;
  return p.v0 / p.g + dropTime(apex - dy, p);
}

export function hangTime(p) { return jumpTime(0, p); }

/**
 * 一段跳/落动作的弧线采样点（用于绘制与净空检测）。
 * 水平剖面按 d/hr 整体缩放：满速的弧会飞过头，玩家可以在空中刹车落到更近的点。
 * mode: 1 = 跳跃（有起跳初速），2 = 自由下落（直接走下去）
 */
export function arcPoints(a, b, mode, p, n = 20) {
  const dy = b.y - a.y;
  const dx = b.x - a.x, dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  const out = [];
  // a / b 可能只是 {x,y,z} 的采样落点，也可能带了原向量
  const V = (q) => new THREE.Vector3(q.x, q.y, q.z);
  if (d < 1e-4 && Math.abs(dy) < 1e-4) { out.push(V(a), V(b)); return out; }
  const ux = d > 1e-6 ? dx / d : 0, uz = d > 1e-6 ? dz / d : 0;
  let T, prof;
  if (mode === 2) {
    T = dropTime(-dy, p);
    const hr = Math.max(1e-6, p.sp * T);
    prof = (t) => ({ h: p.sp * t * (d / hr), y: -dropAt(t, p) });
  } else {
    T = jumpTime(dy, p);
    if (!Number.isFinite(T)) T = hangTime(p);
    const hr = Math.max(1e-6, distAt(T, p));
    prof = (t) => ({ h: distAt(t, p) * (d / hr), y: jumpY(t, p) });
  }
  if (!(T > 1e-4)) { out.push(V(a), V(b)); return out; }
  for (let i = 0; i <= n; i++) {
    const s = prof(T * (i / n));
    out.push(new THREE.Vector3(a.x + ux * s.h, a.y + s.y, a.z + uz * s.h));
  }
  return out;
}

/* ============================================================
   A* 用的二叉堆（存 [key, 节点索引] 二元组，按「入堆那一刻的 key」排序）
   注意：不能只存节点索引再去读「实时 f 数组」比较——同一节点被更优路线
   重复入堆后，数组里的旧条目 key 变了，堆序当场被破坏，pop() 就不再返回
   最小值，A* 会算出次优路线（平地上多绕一次跳跃就是这么来的）。
   过期条目在 pop() 之后由调用方按 key 判定丢弃。
   ============================================================ */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(key, idx) {
    const a = this.a;
    a.push([key, idx]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* ============================================================
   落点图 + 寻路
   ============================================================ */
export class NavGraph {
  constructor(pk) {
    this.pk = pk;
    this.ed = pk.ed;
    this.ray = new THREE.Raycaster();
    this._down = new THREE.Vector3(0, -1, 0);
    this._up = new THREE.Vector3(0, 1, 0);
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._m3 = new THREE.Matrix3();
    this._m3b = new THREE.Matrix3();
    this._m4 = new THREE.Matrix4();
    this._skipCache = new WeakMap();
    this.clear();
  }

  /** 参考物理口径（由工具面板当前参数决定） */
  _param() { return this.pk._param(); }

  /* ---------- 状态 ---------- */
  clear() {
    this.phase = 'idle';          // idle | sample | ready
    this.nodes = [];              // { x,y,z, ny, cx,cz }
    this.cols = new Map();        // "cx,cz" -> [nodeIdx]
    this.hash = new Map();        // "hx,hz" -> [nodeIdx]
    this.box = null;
    this.req = null;              // 上次实际扫描覆盖的立体范围
    this.dirty = true;
    this.progress = 0;
    this.count = 0;
    this.scanMs = 0;
    this.edgeCache = new Map();
    this.sig = '';
    this.overBudget = false;
    this.marks = 0;
    this.top = 0;
    /* ★ 机制边（M6）：主轴上的**必经**机制段（滑索 / 攀爬 / WallJump / 游泳）。
       由生成器（world/index.js 的 mechLinks）注入，本类只负责把它们接进落点图，
       并按各自的动作方式做净空校验 —— NavGraph 的 run / jump / fall 口径不变。 */
    this.mech = [];
    this.mechEdge = new Map();      // "i:j" → 该机制段的描述
    this._mechRes = null;           // 解析后的机制边（节点下标）
  }

  get ready() { return this.phase === 'ready'; }
  get busy() { return this.phase === 'sample'; }
  get usable() { return this.nodes.length > 0; }

  /** 关卡几何变了：标脏，下次需要时重扫 */
  invalidate() { this.dirty = true; }

  /** 参考参数变了：边校验结果作废（可达范围变了） */
  setSig(sig) {
    if (sig === this.sig) return;
    this.sig = sig;
    this.edgeCache.clear();
  }

  /**
   * 注入「必经机制段」（生成器给的主轴机制边）。
   * @param list [{ move:'zip'|'climb'|'wall'|'swim', a:{x,y,z,hw}, b:{x,y,z,hw} }]
   */
  setMech(list) {
    this.mech = Array.isArray(list) ? list : [];
    this._mechRes = null;
    this.mechEdge.clear();
    this.edgeCache.clear();
  }

  /* ============================================================
     扫描（分帧）
     ============================================================ */
  /** 需要时启动扫描；已在扫描返回 false；已就绪且覆盖需求区域返回 true */
  ensure(box) {
    if (this.phase === 'sample') return false;
    if (this.phase === 'ready' && !this.dirty && box && this.req && this.req.containsBox(box)) return true;
    this.begin(box);
    return false;
  }

  begin(box) {
    const b = this.ed.builder;
    this.nodes = [];
    this.cols = new Map();
    this.hash = new Map();
    this.edgeCache.clear();
    this._mechRes = null;
    this.mechEdge.clear();
    this.progress = 0;
    this.count = 0;
    this.ix = 0; this.iz = 0;
    if (!b || !box) { this.phase = 'idle'; return; }
    this.phase = 'sample';
    this._t0 = now();

    /* 扫描区域：需求区域外扩（够抄近道），再按关卡范围裁剪 */
    const lb = b.bounds && !b.bounds.isEmpty() ? b.bounds : null;
    const p = this._param();
    const pad = Math.max(PAD_MIN, PAD_JUMP_MUL * distAt(hangTime(p), p));
    const padV = Math.max(16, Math.min(64, pad * 0.5));
    let x0 = box.min.x - pad, x1 = box.max.x + pad;
    let z0 = box.min.z - pad, z1 = box.max.z + pad;
    if (lb) {
      x0 = Math.max(lb.min.x - PAD_EDGE, x0); x1 = Math.min(lb.max.x + PAD_EDGE, x1);
      z0 = Math.max(lb.min.z - PAD_EDGE, z0); z1 = Math.min(lb.max.z + PAD_EDGE, z1);
    }
    if (!(x1 - x0 > 0.1) || !(z1 - z0 > 0.1)) { x0 = box.min.x - 8; x1 = box.max.x + 8; z0 = box.min.z - 8; z1 = box.max.z + 8; }
    this.x0 = x0; this.z0 = z0;
    this.top = Math.max(box.max.y, lb ? lb.max.y : box.max.y) + 4;
    this.req = new THREE.Box3(
      new THREE.Vector3(x0, Math.min(box.min.y, lb ? lb.min.y : box.min.y) - padV, z0),
      new THREE.Vector3(x1, this.top, z1),
    );
    const span = Math.max(x1 - x0, z1 - z0);
    let step = Math.min(STEP_MAX, Math.max(STEP_MIN, span / Math.sqrt(MAX_COLUMNS)));
    // 硬上限：区域太大时继续粗化，保证列数不会爆（射线很贵）
    while (step < 24 && ((x1 - x0) / step + 1) * ((z1 - z0) / step + 1) > MAX_COLUMNS * 1.6) step *= 1.15;
    this.cell = step;              // 注意：不能叫 step，否则会盖掉 step() 方法
    this.nx = Math.max(1, Math.round((x1 - x0) / this.cell) + 1);
    this.nz = Math.max(1, Math.round((z1 - z0) / this.cell) + 1);
  }

  /** 推进扫描；返回是否这一帧扫完 */
  step(budgetMs = 6) {
    if (this.phase !== 'sample') return false;
    const b = this.ed.builder;
    if (!b) { this.phase = 'idle'; return false; }
    const t0 = now();
    let n = 0;
    while (this.ix < this.nx) {
      const x = this.x0 + this.ix * this.cell;
      const z = this.z0 + this.iz * this.cell;
      this._column(b, x, z, this.ix, this.iz);
      this.iz++;
      if (this.iz >= this.nz) { this.iz = 0; this.ix++; }
      if ((++n & 15) === 0 && now() - t0 >= budgetMs) break;
    }
    this.progress = (this.ix + this.iz / Math.max(1, this.nz)) / Math.max(1, this.nx);
    this.count = this.nodes.length;
    if (this.ix >= this.nx) {
      this.phase = 'ready';
      this.dirty = false;
      this.progress = 1;
      this.scanMs = now() - this._t0;
      return true;
    }
    return false;
  }

  /** 单列采样：从上往下打一条射线，收集所有可站立的表面 */
  _column(b, x, z, cx, cz) {
    const ray = this.ray;
    ray.near = 0; ray.far = Infinity;
    ray.set(this._o.set(x, this.top, z), this._down);
    const hits = ray.intersectObjects(b.root.children, true);
    if (!hits.length) return;
    let last = Infinity;
    for (const h of hits) {
      if (!h.object.visible || this._hidden(h.object)) continue;
      if (this._skip(h.object)) continue;
      if (last - h.point.y < MIN_GAP) { last = h.point.y; continue; }
      last = h.point.y;
      const ny = this._normalY(h);
      if (ny < SLOPE_MIN) continue;
      if (!this._headroom(b, x, h.point.y, z)) continue;
      this._push(h.point.x, h.point.y, h.point.z, ny, cx, cz);
    }
  }

  /** 头顶净空：站人的高度内不能有实体 */
  _headroom(b, x, y, z) {
    const ray = this.ray;
    ray.set(this._o.set(x, y + HEAD_PAD, z), this._up);
    ray.far = PLAYER.totalH - HEAD_PAD;
    const hits = ray.intersectObjects(b.root.children, true);
    for (const h of hits) {
      if (!h.object.visible || this._hidden(h.object)) continue;
      if (this._skip(h.object)) continue;
      return false;
    }
    return true;
  }

  _push(x, y, z, ny, cx, cz) {
    const i = this.nodes.length;
    this.nodes.push({ x, y, z, ny, cx, cz });
    const ck = cx + ',' + cz;
    let cl = this.cols.get(ck);
    if (!cl) { cl = []; this.cols.set(ck, cl); }
    cl.push(i);
    const hk = Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
    let hl = this.hash.get(hk);
    if (!hl) { hl = []; this.hash.set(hk, hl); }
    hl.push(i);
  }

  /** 物体（含父级）被隐藏 */
  _hidden(o) {
    let n = o, guard = 0;
    while (n && guard++ < 24) {
      if (n.visible === false) return true;
      n = n.parent;
    }
    return false;
  }

  /** 不可站立的物体：编辑器辅助体 / 无碰撞类型（液体、触发器、标记、门把手等） */
  _skip(o) {
    let v = this._skipCache.get(o);
    if (v !== undefined) return v;
    const b = this.ed.builder;
    let n = o, guard = 0;
    v = false;
    while (n && guard++ < 24) {
      if (n.userData) {
        if (n.userData.helper) { v = true; break; }
        const id = n.userData.objectId;
        if (id && b) {
          const rec = b.objects.get(id);
          if (rec && NO_PHYSICS.has(rec.o.type)) { v = true; break; }
        }
      }
      n = n.parent;
    }
    this._skipCache.set(o, v);
    return v;
  }

  /** 命中面的世界法线 Y 分量 */
  _normalY(h) {
    if (!h.face) return 0;
    const o = h.object;
    this._n.copy(h.face.normal);
    if (o.isInstancedMesh && h.instanceId != null) {
      o.getMatrixAt(h.instanceId, this._m4);
      this._m3b.getNormalMatrix(this._m4);
      this._n.applyMatrix3(this._m3b);
    }
    this._m3.getNormalMatrix(o.matrixWorld);
    this._n.applyMatrix3(this._m3).normalize();
    return Math.abs(this._n.y);
  }

  /* ============================================================
     查询
     ============================================================ */
  nearest(v, maxR = Infinity) {
    const nodes = this.nodes;
    let best = -1, bd = maxR * maxR;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const dx = n.x - v.x, dy = n.y - v.y, dz = n.z - v.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) { bd = d2; best = i; }
    }
    return best;
  }

  /* ============================================================
     寻路
     ============================================================ */
  /**
   * a3/b3：世界坐标（用户放的两个节点）
   * p：{ v0, sp, g, air }
   * 返回 { ok, cost, moves[], snapA, snapB, reason, expanded, ms }
   */
  path(a3, b3, p) {
    const t0 = now();
    this.marks = 0;
    this.overBudget = false;
    if (!this.ready) return { ok: false, reason: '地形还没扫描完' };
    const ia = this.nearest(a3, 12);
    const ib = this.nearest(b3, 12);
    if (ia < 0 || ib < 0) return { ok: false, reason: '附近没有可站立的表面（把节点放到平台面上）' };

    const nodes = this.nodes;
    const n = nodes.length;
    const g = new Float64Array(n).fill(Infinity);
    const f = new Float64Array(n);
    const prev = new Int32Array(n).fill(-1);
    const emode = new Uint8Array(n);
    const etime = new Float64Array(n);
    const checked = new Uint8Array(n);
    const done = new Uint8Array(n);
    const goal = nodes[ib];
    const hOf = (i) => {
      const q = nodes[i];
      return Math.hypot(q.x - goal.x, q.y - goal.y, q.z - goal.z) / Math.max(1e-3, p.sp);
    };
    const heap = new Heap();
    g[ia] = 0; f[ia] = hOf(ia); checked[ia] = 1; prev[ia] = -1;
    heap.push(f[ia], ia);
    let expanded = 0;

    while (heap.size && expanded < MAX_EXPAND) {
      if ((expanded & 31) === 0 && now() - t0 > BUDGET_MS) break;   // 射线很贵，超预算就收手
      const top = heap.pop();
      const i = top[1];
      if (done[i]) continue;
      if (!(g[i] < Infinity)) continue;          // 这条边已被判死，等别的父节点再来
      if (top[0] > f[i] + 1e-9) continue;        // 过期条目：之后又被更优路线重新入过堆
      if (!checked[i]) {
        const v = this._validate(prev[i], i, emode[i], p);
        if (!v) {
          // 这条边过不去：丢掉，等别的父节点再来
          g[i] = Infinity; prev[i] = -1;
          continue;
        }
        if (v.t) etime[i] = v.t;      // 用校验时算出的准确耗时（坠落要先跑到边沿）
        checked[i] = 1;
      }
      done[i] = 1;
      expanded++;
      if (i === ib) {
        const res = this._build(prev, emode, etime, ia, ib, a3, b3, p);
        res.expanded = expanded;
        res.ms = now() - t0;
        res.overBudget = this.overBudget;
        return res;
      }
      const succ = this._succ(i, p);
      for (let k = 0; k < succ.length; k++) {
        const e = succ[k];
        const j = e.j;
        if (done[j]) continue;
        const ng = g[i] + e.t;
        if (ng >= g[j]) continue;
        g[j] = ng; prev[j] = i; emode[j] = e.m; etime[j] = e.t; checked[j] = 0;
        f[j] = ng + hOf(j);
        heap.push(f[j], j);
      }
    }
    const timeout = now() - t0 > BUDGET_MS;
    return {
      ok: false,
      reason: timeout ? '寻路超时（路线太长 / 地形太碎）'
        : expanded >= MAX_EXPAND ? '路线太长，搜索超出预算' : '这个方向走不通',
      expanded, ms: now() - t0,
    };
  }

  /* ============================================================
     机制边（M6）：滑索 / 攀爬 / WallJump / 游泳
     ------------------------------------------------------------
     生成器在攀登链上留出「竖井 / 裂谷」特技段，只有机制过得去。
     这里把它们接进落点图：起点落点 → 终点落点 一条类型为 3 的边，
     出队校验时按动作方式做净空射线（NavGraph 的 run/jump/fall 口径不变）。
     ============================================================ */
  /** 解析机制边：起点/终点各自吸附到最近的落点（只在每次扫描后做一次） */
  _mechResolve() {
    if (this._mechRes) return this._mechRes;
    const out = [];
    this.mechEdge.clear();
    for (const mk of this.mech) {
      if (!mk || !mk.a || !mk.b) continue;
      const ra = Math.max(6, (Number(mk.a.hw) || 3) + 3);
      const rb = Math.max(6, (Number(mk.b.hw) || 3) + 3);
      const i = this.nearest(this._o.set(mk.a.x, mk.a.y, mk.a.z), ra);
      const j = this.nearest(this._o.set(mk.b.x, mk.b.y, mk.b.z), rb);
      if (i < 0 || j < 0 || i === j) continue;
      const a = this.nodes[i], b = this.nodes[j];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      const dy = b.y - a.y;
      // 耗时口径与 reach.js 的 MECH 一致（用于 A* 的代价）
      const sp = mk.move === 'zip' ? 52 : mk.move === 'swim' ? 22 : mk.move === 'wall' ? 30 : 14;
      const t = Math.max(0.35, (mk.move === 'climb' || mk.move === 'wall' ? Math.abs(dy) / sp : d / sp) + 0.35);
      out.push({ i, j, mk, t });
      this.mechEdge.set(i + ':' + j, mk);
    }
    this._mechRes = out;
    return out;
  }

  /** 机制边真正经过的路径（也用于画出该段的走法） */
  _mechPts(mk, a, b) {
    if (mk.move === 'climb' || mk.move === 'wall') {
      // 竖直上攀：沿竖井轴线
      return [
        new THREE.Vector3(a.x, Math.min(a.y, b.y) + 0.8, a.z),
        new THREE.Vector3(b.x, Math.max(a.y, b.y) + 0.8, b.z),
      ];
    }
    if (mk.move === 'swim') {
      /* 游泳：贴着液面下方平移。
         ★ 两端要**从踏板边缘之外**起射：液面在踏步面之下，从踏板中心起射等于在石头里起射。 */
      const y = Math.min(a.y, b.y) - 1.2;
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-6) return [new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(b.x, y, b.z)];
      const ux = dx / d, uz = dz / d;
      const oa = (Number(a.hw) || 3) + 1, ob = (Number(b.hw) || 3) + 1;
      return [
        new THREE.Vector3(a.x + ux * oa, y, a.z + uz * oa),
        new THREE.Vector3(b.x - ux * ob, y, b.z - uz * ob),
      ];
    }
    // 滑索：沿缆绳高度（踏步面之上 3.4 stud）平移
    const y = (a.y + b.y) / 2 + 3.4;
    return [new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(b.x, y, b.z)];
  }

  /** 机制边的净空校验：沿该动作真正经过的路径打射线 */
  _mechClear(mk, a, b) {
    return this._clearPts(this._mechPts(mk, a, b));
  }

  /**
   * 直接证明一条机制边（不进 A*）。
   * 生成器给的机制段是**指定**的装置（滑索 / 攀爬墙 / WallJump 竖井 / 泳池），
   * 所以证明方式就是「按该动作真正经过的路径打射线」——
   * 与解析层（reach.js 的 MECH 包络）一起构成这条边的完整证据。
   * @returns { ok, reason, snapA, snapB }
   */
  proveMech(a3, b3, move) {
    if (!this.ready) return { ok: false, reason: '地形还没扫描完' };
    const ia = this.nearest(a3, 12);
    const ib = this.nearest(b3, 12);
    if (ia < 0 || ib < 0) return { ok: false, reason: '附近没有可站立的表面（机制段两端没被采样到）' };
    const a = this.nodes[ia], b = this.nodes[ib];
    const ok = this._mechClear({ move }, a, b);
    return {
      ok,
      reason: ok ? '' : `${move} 机制段净空不通过（沿途撞到实体）`,
      snapA: a3.distanceTo(new THREE.Vector3(a.x, a.y, a.z)),
      snapB: b3.distanceTo(new THREE.Vector3(b.x, b.y, b.z)),
    };
  }

  /**
   * 展开一个落点的后继（这里只做廉价的可达性判断，
   * 真正「会不会撞墙」留给出队时的 _validate 用射线判定）
   */
  _succ(i, p) {
    const nodes = this.nodes;
    const a = nodes[i];
    const out = [];
    const stepH = PLAYER.stepHeight;

    /* ---------- 机制边：生成器声明的必经段落（滑索 / 攀爬 / WallJump / 游泳） ---------- */
    if (this.mech.length) {
      for (const e of this._mechResolve()) {
        if (e.i === i) out.push({ j: e.j, m: 3, t: e.t });
      }
    }

    /* 跑动：相邻采样列上高度接近的落点（同一层地面 / 台阶 / 斜坡） */
    for (let d = 0; d < NB8.length; d++) {
      const list = this.cols.get((a.cx + NB8[d][0]) + ',' + (a.cz + NB8[d][1]));
      if (!list) continue;
      let b1 = -1, d1 = 1e9, b2 = -1, d2 = 1e9;
      for (let k = 0; k < list.length; k++) {
        const j = list[k];
        const ad = Math.abs(nodes[j].y - a.y);
        if (ad > stepH) continue;
        if (ad < d1) { b2 = b1; d2 = d1; b1 = j; d1 = ad; }
        else if (ad < d2) { b2 = j; d2 = ad; }
      }
      if (b1 >= 0) out.push({ j: b1, m: 0, t: this._runTime(a, nodes[b1], p) });
      if (b2 >= 0) out.push({ j: b2, m: 0, t: this._runTime(a, nodes[b2], p) });
    }

    /* 跳跃 / 自由下落：空间哈希里够得着的落点。
       注意：只有「直线跑不过去」的落点才值得生成跳 / 落边，
       否则平地上会冒出一大堆「跳」——玩家一路走就行了。
       （转角抄近道仍然成立：那条直线如果正好跨过缺口，就会判为不可走） */
    const rMax = Math.max(2, distAt(hangTime(p), p) * 1.02);
    const apex = jumpApex(p);
    const c0 = Math.floor((a.x - rMax) / CELL), c1 = Math.floor((a.x + rMax) / CELL);
    const e0 = Math.floor((a.z - rMax) / CELL), e1 = Math.floor((a.z + rMax) / CELL);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = e0; cz <= e1; cz++) {
        const list = this.hash.get(cx + ',' + cz);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const j = list[k];
          if (j === i) continue;
          const b = nodes[j];
          const dy = b.y - a.y;
          const d = Math.hypot(b.x - a.x, b.z - a.z);
          if (d < 0.25 || d > rMax) continue;
          if (dy > apex * 0.98) continue;
          const tj = jumpTime(dy, p);
          const canJump = Number.isFinite(tj) && d <= distAt(tj, p) * 1.02;
          const tf = dy < -0.4 ? dropTime(-dy, p) : 0;
          const canFall = tf > 0 && d <= p.sp * tf + 0.05;
          if (!canJump && !canFall) continue;
          if (this._walkable(a, b)) continue;    // 走着就能到，不必跳也不必摔
          if (canJump) out.push({ j, m: 1, t: tj });
          if (canFall) out.push({ j, m: 2, t: tf });
        }
      }
    }
    return out;
  }

  /**
   * 「走过去」判定：沿 a→b 的直线逐列查采样表，看能不能一路踩过去。
   * 纯 Map 查表，不打射线，所以可以放心地给每个候选落点做门控。
   * 每一列按人的身体高度分两种情况：
   *   · 最高的那层就在身体范围内（比抬脚高度还高）→ 挡脚，走不过去
   *   · 最高的那层高过头顶 → 从底下穿过去，落脚面取头顶以下最高的一层
   * 任何一列没有落脚面（缺口 / 悬崖）、或与当前高度差超过 stepHeight → 走不过去。
   */
  _walkable(a, b) {
    if (!this.cell) return true;
    const dx = b.x - a.x, dz = b.z - a.z;
    const d = Math.hypot(dx, dz);
    const tol = PLAYER.stepHeight + 0.15;
    if (d < 1e-4) return Math.abs(b.y - a.y) <= tol;
    const nSeg = Math.max(1, Math.ceil(d / Math.max(1, this.cell * 0.5)));
    let y = a.y;
    for (let k = 1; k <= nSeg; k++) {
      const s = k / nSeg;
      const cx = Math.round((a.x + dx * s - this.x0) / this.cell);
      const cz = Math.round((a.z + dz * s - this.z0) / this.cell);
      const list = this.cols.get(cx + ',' + cz);
      if (!list) return false;
      let top = -Infinity, below = -Infinity;
      for (let m = 0; m < list.length; m++) {
        const yy = this.nodes[list[m]].y;
        if (yy > top) top = yy;
        if (yy <= y + tol && yy > below) below = yy;
      }
      if (below === -Infinity) return false;          // 脚下没有能踩的面
      if (top - y > tol && top - y <= PLAYER.totalH) return false;   // 挡住身体
      if (y - below > tol) return false;              // 断层
      y = below;
    }
    return true;
  }

  _runTime(a, b, p) {
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    return d / Math.max(1e-3, p.sp);
  }

  /** 边校验（带缓存）：跑动看中点是否有连续地面，跳/落看弧线净空
   *  返回 false = 过不去；返回 { t } = 过得去，t 是这条边的准确耗时 */
  _validate(i, j, m, p) {
    if (i < 0) return false;
    const key = i + ':' + j + ':' + m;
    const c = this.edgeCache.get(key);
    if (c !== undefined) return c;
    if (this.marks >= MAX_MARK) {
      // 预算用尽：按几何近似放行，并在结果里标注
      this.overBudget = true;
      return { t: 0 };
    }
    this.marks++;
    const a = this.nodes[i], b = this.nodes[j];
    let out = false;
    if (m === 0) {
      if (Math.abs(b.y - a.y) <= PLAYER.stepHeight + 0.05 && this._walkMid(a, b)) {
        out = { t: this._runTime(a, b, p) };
      }
    } else if (m === 1) {
      const tj = jumpTime(b.y - a.y, p);
      const pts = arcPoints(a, b, 1, p, this._segCount(a, b));
      if (Number.isFinite(tj) && this._clearPts(pts)) out = { t: tj, pts };
    } else if (m === 3) {
      // 机制边：按动作方式核查净空（滑索沿缆绳、攀爬沿竖井、游泳贴液面）
      const mk = this.mechEdge.get(i + ':' + j);
      if (mk && this._mechClear(mk, a, b)) out = { t: 0 };
    } else {
      // 坠落：先在地上跑到边沿，掉出去才自由落体
      const arc = this.fallArc(a, b, p);
      if (arc && this._clearPts(arc.pts)) out = { t: arc.t, pts: arc.pts };
    }
    this.edgeCache.set(key, out);
    return out;
  }

  /** 弧线的探测段数（按弧长切，上限 MARCH_MAX） */
  _segCount(a, b) {
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    return Math.max(4, Math.min(MARCH_MAX, Math.ceil(len / MARCH_STEP) + 2));
  }

  /** 跑动边：两点之间的地面上必须真有落脚点（挡住墙、缺口、断崖） */
  _walkMid(a, b) {
    const bd = this.ed.builder;
    if (!bd) return false;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, my = (a.y + b.y) / 2;
    // 台阶 / 斜坡上中点正好落在两级之间，容差要跟着落差放宽
    const tol = WALK_MID_TOL + Math.abs(b.y - a.y) * 0.75;
    const ray = this.ray;
    ray.near = 0; ray.far = Infinity;
    ray.set(this._o.set(mx, Math.max(this.top, my + 3), mz), this._down);
    const hits = ray.intersectObjects(bd.root.children, true);
    for (const h of hits) {
      if (!h.object.visible || this._hidden(h.object)) continue;
      if (this._skip(h.object)) continue;
      return Math.abs(h.point.y - my) <= tol;
    }
    return false;
  }

  /**
   * 坠落弧线：玩家先在地上按水平速度跑到平台边沿，离开边沿之后才自由落体。
   * 返回 { pts, t }；返回 null 表示「其实掉不下去」——
   * 要么一路都有地面（目标就在同一块平台下方），要么落得太远刹不住。
   */
  fallArc(a, b, p) {
    const bd = this.ed.builder;
    if (!bd) return null;
    const dx = b.x - a.x, dz = b.z - a.z;
    const d = Math.hypot(dx, dz);
    const dy = b.y - a.y;
    const sp = Math.max(1e-3, p.sp);
    const Tf = dropTime(-dy, p);
    if (!(Tf > 1e-4)) return null;
    if (d < 1e-4) return null;

    /* 1) 找边沿：沿水平速度前进，脚下还有地面就说明人还在平台上 */
    const PROBE = 0.7, TOL = 0.45;
    const ux = dx / d, uz = dz / d;
    let edge = 0, grounded = true;
    while (grounded && edge < d) {
      edge = Math.min(d, edge + PROBE);
      grounded = this._groundBelow(a.x + ux * edge, a.y, a.z + uz * edge, TOL);
    }
    if (grounded) return null;                        // 一路都有地面：掉不下去
    edge = Math.max(0, edge - PROBE * 0.5);           // 边沿落在最后两个探针之间

    /* 2) 边沿之后才是自由落体：Tf 内落 dy，水平还差 rest，靠空中刹车控制 */
    const rest = Math.max(0, d - edge);
    const spAir = rest / Tf;
    if (spAir > sp + 0.05) return null;               // 要飞这么远就刹不住 → 够不到

    const nAir = Math.max(2, Math.min(MARCH_MAX, Math.ceil(Math.hypot(rest, Math.abs(dy)) / MARCH_STEP) + 2));
    const pts = [new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(a.x + ux * edge, a.y, a.z + uz * edge)];
    for (let i = 1; i <= nAir; i++) {
      const t = Tf * (i / nAir);
      const h = edge + spAir * t;
      pts.push(new THREE.Vector3(a.x + ux * h, a.y - dropAt(t, p), a.z + uz * h));
    }
    return { pts, t: edge / sp + Tf };
  }

  /** 脚下 y 附近有没有地面（用来判断人还在不在平台上） */
  _groundBelow(x, y, z, tol) {
    const bd = this.ed.builder;
    const ray = this.ray;
    ray.near = 0; ray.far = Infinity;
    ray.set(this._o.set(x, y + 0.6, z), this._down);
    const hits = ray.intersectObjects(bd.root.children, true);
    for (const h of hits) {
      if (!h.object.visible || this._hidden(h.object)) continue;
      if (this._skip(h.object)) continue;
      return Math.abs(h.point.y - y) <= tol;          // 只看最上面那层
    }
    return false;
  }

  /** 沿给定的弧线逐段射线：撞到实体就说明这条路走不通 */
  _clearPts(pts) {
    const bd = this.ed.builder;
    if (!bd) return false;
    const ray = this.ray;
    ray.near = 0;
    for (let k = 1; k < pts.length; k++) {
      const s = pts[k - 1], c = pts[k];
      const vx = c.x - s.x, vy = c.y - s.y, vz = c.z - s.z;
      const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (len < 1e-4) continue;
      ray.set(this._o.set(s.x, s.y, s.z), this._d.set(vx / len, vy / len, vz / len));
      ray.far = Math.max(1e-4, len - 0.06);       // 末尾留一点余量：不要打到自己落点那张面
      const hits = ray.intersectObjects(bd.root.children, true);
      for (const h of hits) {
        if (h.distance < 0.12) continue;          // 贴着起点的那张面不算（起跳/走边沿时就在它上面）
        if (!h.object.visible || this._hidden(h.object)) continue;
        if (this._skip(h.object)) continue;
        return false;
      }
    }
    return true;
  }

  /** 回溯路径 → 动作序列（跑动 / 跳跃 / 下落） */
  _build(prev, emode, etime, ia, ib, a3, b3, p) {
    const nodes = this.nodes;
    const chain = [];
    for (let i = ib, guard = 0; i >= 0 && guard++ < 200000; i = prev[i]) {
      chain.push(i);
      if (i === ia) break;
    }
    chain.reverse();

    const moves = [];
    const v = (n) => new THREE.Vector3(n.x, n.y, n.z);
    /* 校验时算过的弧线直接复用（保证画出来的路 = 校验通过的那条） */
    const cachedPts = (i, j, m) => {
      const c = this.edgeCache.get(i + ':' + j + ':' + m);
      return c && c.pts ? c.pts : null;
    };
    let runPts = [a3.clone()];
    /* 起点/终点要吸附到落点图上（用户点的位置未必正好在网格落点上），
       少写这一笔会让第一段画成从用户点到第二个落点的斜线 */
    const addRun = (q) => {
      const last = runPts[runPts.length - 1];
      if (last.distanceToSquared(q) > 1e-6) runPts.push(q);
    };
    addRun(v(nodes[chain[0]]));
    const flushRun = () => {
      if (runPts.length < 2) return;
      let d = 0;
      for (let i = 1; i < runPts.length; i++) d += runPts[i].distanceTo(runPts[i - 1]);
      if (d < 1e-4) return;
      moves.push({ mode: 'run', pts: runPts, d, dy: runPts[runPts.length - 1].y - runPts[0].y, t: d / Math.max(1e-3, p.sp) });
    };
    for (let k = 1; k < chain.length; k++) {
      const i = chain[k - 1], j = chain[k];
      const m = emode[j];
      const na = nodes[i], nb = nodes[j];
      if (m === 0) {
        addRun(v(nb));
        continue;
      }
      flushRun();
      const mk = m === 3 ? this.mechEdge.get(i + ':' + j) : null;
      const pts = mk ? this._mechPts(mk, na, nb)
        : (cachedPts(i, j, m) || arcPoints(v(na), v(nb), m, p, this._segCount(na, nb)));
      moves.push({
        mode: m === 1 ? 'jump' : m === 2 ? 'fall' : (mk ? mk.move : 'mech'),
        pts,
        d: Math.hypot(nb.x - na.x, nb.z - na.z),
        dy: nb.y - na.y,
        t: etime[j],
      });
      runPts = [v(nb)];
    }
    addRun(v(nodes[chain[chain.length - 1]]));
    addRun(b3.clone());
    flushRun();

    let cost = 0;
    for (const mv of moves) cost += mv.t;
    const first = nodes[chain[0]], lastN = nodes[chain[chain.length - 1]];
    return {
      ok: true,
      cost,
      moves,
      snapA: a3.distanceTo(v(first)),
      snapB: b3.distanceTo(v(lastN)),
      reason: '',
    };
  }
}