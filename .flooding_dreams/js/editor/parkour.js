/* ============================================================
   跑酷关卡制造工具（编辑器专用，不写进关卡数据）
   - 跳跃验证器：按玩家属性算出「最大同水平面跳跃距离」圈 + 朝鼠标方向的跳跃抛物线
   - 计时测量器：在平台上点出多个节点，自动累加 跑动 / 下落（含原地下落）/ 跳跃 耗时
     两种口径：
       · 3D 寻路（默认）：把关卡表面采样成落点图，在真实几何上 A* 找最快路线，
         能自动处理跳跃、绕路抄近道、转角平台上的切角跳
       · 直线估算：节点之间按直线距离 + 落差公式直接估，快但不看地形
   物理口径与 player.js 一致（实现在 parkour-nav.js 里，两处共用同一套公式）：
     g = PHYS.gravity × 关卡重力倍率，起跳初速 = jumpPower，水平速度上限 = walkSpeed
     跑动起跳 = 空中保持水平速度；原地起跳 = 空中按 airAccel 从 0 加到 walkSpeed
     下落速度被 maxFallSpeed 硬截断
   ============================================================ */
import * as THREE from 'three';
import { el, clear } from '../ui/dom.js';
import { GridSelect } from '../ui/grid-picker.js';
import { PHYS, PLAYER } from '../config.js';
import { worldPosition } from '../world/level.js';
import { NO_PHYSICS } from '../world/builder.js';
import {
  NavGraph, arcPoints, distAt as navDistAt, dropTime as navDropTime,
  hangTime as navHang, jumpTime as navJumpTime, jumpY as navJumpY,
} from './parkour-nav.js';

const HUD_ID = 'ed-parkour-hud';
const C_ACC = 0x7fe3ff;      // 主色（圈 / 跑动）
const C_OK = 0x8affc1;       // 可达
const C_WARN = 0xffa06b;     // 下落
const C_BAD = 0xff4d6d;      // 够不到
const C_JUMP = 0xa08cff;     // 起跳/跳跃段
const DOTS = 200;            // 抛物线采样点上限
const MAX_LOOK = 200;        // 轨迹最多往下外推多少格（防止朝深渊算出一条超长曲线）

const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');

/* ---------- 文本精灵（画布贴图，始终面向相机） ---------- */
function makeLabel(text, color = '#e9f4ff', h = 2.1) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    transparent: true, depthTest: false, depthWrite: false,
  }));
  sp.userData.h = h;
  sp.renderOrder = 1000;
  sp.userData.text = null;
  setLabel(sp, text, color);
  return sp;
}

function setLabel(sp, text, color = '#e9f4ff') {
  if (sp.userData.text === text && sp.userData.color === color) return;
  sp.userData.text = text;
  sp.userData.color = color;
  const size = 40;
  const pad = 16;
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const font = '700 ' + size + 'px "Segoe UI", system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  cv.width = Math.max(8, w);
  cv.height = Math.round(size * 1.7);
  const c = cv.getContext('2d');
  c.font = font;
  c.textBaseline = 'middle';
  const r = 14;
  c.beginPath();
  c.moveTo(r, 0);
  c.arcTo(cv.width, 0, cv.width, cv.height, r);
  c.arcTo(cv.width, cv.height, 0, cv.height, r);
  c.arcTo(0, cv.height, 0, 0, r);
  c.arcTo(0, 0, cv.width, 0, r);
  c.closePath();
  c.fillStyle = 'rgba(10,8,20,.74)';
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(127,227,255,.35)';
  c.stroke();
  c.fillStyle = color;
  c.fillText(text, pad, cv.height / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  try { tex.colorSpace = THREE.SRGBColorSpace; } catch (e) { /* ignore */ }
  if (sp.material.map) sp.material.map.dispose();
  sp.material.map = tex;
  sp.material.needsUpdate = true;
  const h = sp.userData.h;
  sp.scale.set((cv.width / cv.height) * h, h, 1);
}

/* ---------- 场景辅助体 ---------- */
function lineMesh(points, color, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
  const l = new THREE.Line(g, m);
  l.renderOrder = 999;
  l.userData.helper = true;
  return l;
}

function ringMesh(r0, r1, color, seg = 96) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(r0, r1, seg),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .9, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 999;
  m.userData.helper = true;
  return m;
}

function dotMesh(r, color) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(r, 12, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .95, depthTest: false, depthWrite: false }),
  );
  m.renderOrder = 999;
  m.userData.helper = true;
  return m;
}

function disposeTree(node) {
  node.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
  if (node.parent) node.parent.remove(node);
}

export class ParkourTools {
  constructor(ed) {
    this.ed = ed;
    this.active = null;
    this.hud = document.getElementById(HUD_ID);

    this.root = new THREE.Group();
    this.root.userData.helper = true;
    this.root.visible = false;
    this.gJump = new THREE.Group();
    this.gTiming = new THREE.Group();
    this.gJump.visible = false;
    this.gTiming.visible = false;
    this.root.add(this.gJump, this.gTiming);

    /* 参考参数（两个工具共用，默认取玩家属性 / 关卡重力） */
    this.ref = { jumpPower: PLAYER.jumpPower, speed: PLAYER.walkSpeed, gravity: PHYS.gravity, air: false };
    this._anchorInit = false;

    /* 跳跃验证器 */
    this.anchor = new THREE.Vector3(0, 20, 0);
    this.aim = null;              // 鼠标指向的世界点
    this._aimXY = null;           // 鼠标屏幕坐标（用于节流重算）
    this._calcNeed = true;
    this._calcCool = 0;
    this._segNeed = false;        // 计时节点被拖动过，松手时重算
    this._hudCool = 0;            // HUD 进度刷新的节流计时
    this.res = { range: 0, apex: 0, hang: 0, reach: 0, target: 0, drop: 0, ok: false, highOk: true, hit: false, dir: null };

    /* 计时测量器 */
    this.nodes = [];              // Vector3 数组
    this.segModes = [];           // 'auto' | 'run' | 'fall' | 'jump'（仅直线估算模式用）
    this.segInfo = [];            // 每两个节点之间的一条「腿」的汇总
    this.moves = [];              // 展平后的动作序列（跑动 / 跳跃 / 下落），用于画线
    this.total = 0;
    this.drag = null;

    /* 3D 寻路 */
    this.nav = new NavGraph(this);
    this.navMode = true;          // 默认走真实地形寻路
    this.navDirty = true;         // 需要（重新）扫描地形
    this.navErr = '';             // 寻路不可用的原因
    this.planWarn = '';           // 结果上的告警（预算用尽之类）
    this.navMs = 0;               // 本趟寻路耗时

    this._ray = new THREE.Raycaster();

    this._buildJump();
    this._bindHud();
  }

  /** 参考物理口径（parkour-nav.js 的纯函数都吃这个对象） */
  _param() {
    return { v0: this.v0, sp: this.sp, g: this.g, air: !!this.ref.air };
  }

  /** 参考参数签名：变了就要作废寻路的边校验缓存 */
  _navSig() {
    return [this.v0, this.sp, this.g, this.ref.air ? 1 : 0].join(',');
  }

  /* ============================================================
     生命周期
     ============================================================ */
  /** 换关卡 / 打开编辑器时复位 */
  reset() {
    const ed = this.ed;
    const gs = (ed.level && ed.level.settings && ed.level.settings.gravityScale) || 1;
    this.ref.jumpPower = PLAYER.jumpPower;
    this.ref.speed = PLAYER.walkSpeed;
    this.ref.gravity = PHYS.gravity * gs;
    this.nodes = [];
    this.segModes = [];
    this.segInfo = [];
    this.moves = [];
    this.total = 0;
    this.drag = null;
    this.aim = null;
    this._aimXY = null;
    this._calcNeed = true;
    this._segNeed = false;
    this.nav.clear();
    this.navDirty = true;
    this.navErr = '';
    this.planWarn = '';
    this.navMs = 0;
    this._anchorToSpawn();
    if (this.active === 'timing') this._syncTiming();
    else if (this.active === 'jump') this._updateJump();
    else this._refreshHud();
  }

  toggle(kind) {
    this.setActive(this.active === kind ? null : kind);
  }

  setActive(kind) {
    const ed = this.ed;
    const next = (kind === 'jump' || kind === 'timing') ? kind : null;
    if (this.active === next && !next) return;
    this.active = next;
    this.drag = null;
    this._segNeed = false;
    const scene = ed.scene;
    if (next) {
      // 涂鸦 HUD 与工具 HUD 占同一块位置，两者不同时开
      if (ed.paintEd && ed.paintEd.active) ed.paintEd.setActive(false);
      if (scene && this.root.parent !== scene) scene.add(this.root);
      if (!this._anchorInit) { this._anchorToSpawn(); this._anchorInit = true; }
    }
    this.root.visible = !!next;
    this.gJump.visible = next === 'jump';
    this.gTiming.visible = next === 'timing';
    if (this.hud) this.hud.classList.toggle('hidden', !next);
    if (next) {
      this._buildHud();
      if (next === 'jump') this._updateJump();
      else this._syncTiming();
      ed.showHint(next === 'jump'
        ? '跳跃验证器：左键点地面设起跳点 · 移动鼠标看轨迹 · Esc 退出'
        : '跑酷计时器：左键点平台加节点 · 拖动节点可移动（松手后重新寻路）· 右键节点删除 · Esc 退出');
    } else if (this.hud) {
      clear(this.hud);
    }
    ed._syncModeButtons();
  }

  /** 编辑器退出 / 试玩前收起 */
  hide() {
    if (this.active) this.setActive(null);
    else if (this.hud) this.hud.classList.add('hidden');
    this.drag = null;
  }

  dispose() {
    this.hide();
    disposeTree(this.gJump);
    disposeTree(this.gTiming);
    if (this.root.parent) this.root.parent.remove(this.root);
  }

  /* ============================================================
     参考参数 → 物理口径
     ============================================================ */
  get g() { return Math.max(1e-3, Number(this.ref.gravity) || PHYS.gravity); }
  get v0() { return Math.max(0, Number(this.ref.jumpPower) || 0); }
  get sp() { return Math.max(0, Number(this.ref.speed) || 0); }

  /* 以下物理口径全部委托给 parkour-nav.js 的纯函数，保证与寻路用的是同一套公式 */

  /** 滞空时间（回到起跳高度） */
  hangTime() { return navHang(this._param()); }

  /** 水平位移随时间：跑动起跳 = 恒速；原地起跳 = 空中加速到上限再匀速 */
  distAt(t) { return navDistAt(t, this._param()); }

  /** 某相对高度 dy（可为负）的跳跃可用时间：取落到该高度的时刻（下降段）；跳不到返回 NaN */
  timeAtHeight(dy) { return navJumpTime(dy, this._param()); }

  /** 自由下落 h 格所需时间（含最大下落速度上限） */
  fallTime(h) { return navDropTime(h, this._param()); }

  /** 轨迹外推的时间上限（最多往下看 MAX_LOOK 格） */
  tCap() {
    const t = this.timeAtHeight(-MAX_LOOK);
    return Number.isFinite(t) ? Math.max(this.hangTime(), t) : this.hangTime();
  }

  /* ============================================================
     跳跃验证器：3D 辅助体
     ============================================================ */
  _buildJump() {
    this.jRing = ringMesh(0.97, 1, C_ACC, 128);
    this.gJump.add(this.jRing);
    this.jRingLabel = makeLabel('', '#9fd8ff');
    this.gJump.add(this.jRingLabel);

    this.jCurve = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(DOTS * 3), 3)),
      new THREE.LineBasicMaterial({ color: C_OK, transparent: true, opacity: .75, depthTest: false, depthWrite: false }),
    );
    this.jCurve.geometry.setDrawRange(0, 0);
    this.jCurve.frustumCulled = false;
    this.jCurve.renderOrder = 999;
    this.jCurve.userData.helper = true;
    this.gJump.add(this.jCurve);

    this.jDots = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.19, 8, 6),
      new THREE.MeshBasicMaterial({ color: C_OK, transparent: true, opacity: .95, depthTest: false, depthWrite: false }),
      DOTS,
    );
    this.jDots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.jDots.count = 0;
    this.jDots.frustumCulled = false;
    this.jDots.renderOrder = 999;
    this.jDots.userData.helper = true;
    this.gJump.add(this.jDots);

    this.jAnchor = dotMesh(0.36, C_ACC);
    this.gJump.add(this.jAnchor);
    this.jAnchorPost = lineMesh([new THREE.Vector3(), new THREE.Vector3()], C_ACC, .8);
    this.gJump.add(this.jAnchorPost);

    this.jLand = ringMesh(0.52, 0.86, C_OK, 40);
    this.gJump.add(this.jLand);
    this.jLandLabel = makeLabel('', '#c8ffe2');
    this.gJump.add(this.jLandLabel);

    this.jAim = ringMesh(0.62, 0.95, C_BAD, 40);
    this.gJump.add(this.jAim);
    this.jAimPost = lineMesh([new THREE.Vector3(), new THREE.Vector3()], C_BAD, .8);
    this.gJump.add(this.jAimPost);
    this.jAimLabel = makeLabel('', '#ffc9d6');
    this.gJump.add(this.jAimLabel);
  }

  _anchorToSpawn() {
    const ed = this.ed, b = ed.builder;
    let v = null;
    if (b) {
      const fixed = ed.level && ed.level.settings && ed.level.settings.spawnFixed;
      const rec = fixed ? b.objects.get(fixed) : b.objectsOf('spawn')[0];
      if (rec) {
        const p = worldPosition(ed.level, rec.o);
        v = new THREE.Vector3(p[0], p[1], p[2]);
      }
    }
    this.anchor.copy(v || new THREE.Vector3(0, 20, 0));
    this._calcNeed = true;
  }

  /** 用鼠标位置算出瞄准点（命中物体表面，没命中就投到起跳点所在水平面） */
  _aimFromScreen(cx, cy) {
    const vp = this.ed.viewport;
    if (!vp) return null;
    let p = null;
    const hit = vp.pick(cx, cy, { helpers: false, skipLiquid: true });
    if (hit) p = hit.point.clone();
    else p = vp.ground(cx, cy, this.anchor.y);
    if (!p) p = vp.aheadPoint(60).clone();
    return p;
  }

  _recalcAim() {
    const ed = this.ed;
    const xy = this._aimXY || (ed.creator && ed.creator.pointer) || null;
    const cx = xy ? xy.x : (ed.viewDom ? ed.viewDom.getBoundingClientRect().left + ed.viewDom.clientWidth / 2 : 0);
    const cy = xy ? xy.y : (ed.viewDom ? ed.viewDom.getBoundingClientRect().top + ed.viewDom.clientHeight / 2 : 0);
    this.aim = this._aimFromScreen(cx, cy);
  }

  /** 抛物线取点 + 沿弧线求落地 */
  _trace(dir, tEnd) {
    const A = this.anchor;
    const p = this._param();
    const maxT = Math.max(0.05, tEnd);
    const stop = this._march(dir, maxT);
    const tStop = stop ? stop.t : maxT;
    const n = Math.max(8, Math.min(DOTS - 2, Math.round(tStop * 60) + 2));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = tStop * (i / n);
      const h = this.distAt(t);
      pts.push(new THREE.Vector3(
        A.x + dir.x * h,
        A.y + navJumpY(t, p),
        A.z + dir.z * h,
      ));
    }
    if (stop) {
      pts.push(stop.point.clone());
      return { pts, end: stop.point.clone(), hit: true };
    }
    return { pts, end: pts[pts.length - 1].clone(), hit: false };
  }

  /**
   * 沿抛物线按固定空间步长前进，找第一处实心表面。
   * 每步只发一条射线（步长约 0.8 格），比逐采样点发射线便宜得多。
   */
  _march(dir, maxT) {
    const b = this.ed.builder;
    if (!b) return null;
    const A = this.anchor, g = this.g, v0 = this.v0, sp = this.sp;
    const p = this._param();
    const STEP = 0.8;
    const ray = this._ray;
    ray.near = 0;
    const a = this._aTmp || (this._aTmp = new THREE.Vector3());
    const c = this._cTmp || (this._cTmp = new THREE.Vector3());
    const dv = this._dTmp || (this._dTmp = new THREE.Vector3());
    const at = (t, out) => {
      const h = this.distAt(t);
      return out.set(A.x + dir.x * h, A.y + navJumpY(t, p), A.z + dir.z * h);
    };
    at(0, a);
    let t = 0;
    for (let i = 0; i < 400 && t < maxT; i++) {
      // 弧长速度 ≈ 水平速度 + 竖直速度（竖直速度同样被 maxFallSpeed 截断）；用它把「0.8 格」换算成 dt
      const vy = Math.max(-PLAYER.maxFallSpeed, v0 - g * t);
      const speed = Math.max(1e-3, Math.hypot(sp || 1, vy));
      t = Math.min(maxT, t + STEP / speed);
      at(t, c);
      const dx = c.x - a.x, dy = c.y - a.y, dz = c.z - a.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-4) continue;
      dv.set(dx / len, dy / len, dz / len);
      ray.set(a, dv);
      ray.far = len;
      const h = this._firstSolid(ray.intersectObjects(b.root.children, true));
      if (h) return { t, point: h.point.clone() };
      a.copy(c);
    }
    return null;
  }

  _firstSolid(hits) {
    for (const h of hits) {
      const o = h.object;
      if (!o.visible) continue;
      if (this._isHelperOrNoPhysics(o)) continue;
      return h;
    }
    return null;
  }

  /** 辅助体 / 无碰撞的类型（液体、触发器、标记等）不算落地 */
  _isHelperOrNoPhysics(obj) {
    const b = this.ed.builder;
    let o = obj;
    let guard = 0;
    while (o && guard++ < 24) {
      if (o.userData) {
        if (o.userData.helper) return true;
        const id = o.userData.objectId;
        if (id && b) {
          const rec = b.objects.get(id);
          if (rec && NO_PHYSICS.has(rec.o.type)) return true;
        }
      }
      o = o.parent;
    }
    return false;
  }

  _updateJump() {
    const res = this.res;
    const v0 = this.v0, g = this.g;
    const A = this.anchor;

    /* 参数派生的固有量 */
    res.hang = this.hangTime();
    res.apex = v0 * v0 / (2 * g);
    res.range = this.distAt(res.hang);

    /* 圈：最大同水平面跳跃距离 */
    this.jRing.position.set(A.x, A.y + 0.06, A.z);
    this.jRing.scale.set(Math.max(0.01, res.range), Math.max(0.01, res.range), 1);
    this.jRingLabel.position.set(A.x, A.y + 1.5, A.z);
    setLabel(this.jRingLabel, '最大跳距 ' + f2(res.range) + ' 格');

    /* 起跳点标记 */
    this.jAnchor.position.copy(A);
    this.jAnchorPost.geometry.setFromPoints([A.clone(), A.clone().setY(A.y + 2.4)]);
    this.jAnchorPost.geometry.attributes.position.needsUpdate = true;

    if (!this.aim) { this._recalcAim(); }
    const aim = this.aim;
    if (!aim) return;

    /* 方向：从起跳点指向鼠标（水平） */
    let dx = aim.x - A.x, dz = aim.z - A.z;
    const dl = Math.hypot(dx, dz);
    if (dl < 1e-3) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.ed.viewport.camera.quaternion);
      dx = fwd.x; dz = fwd.z;
      const l2 = Math.hypot(dx, dz) || 1;
      dx /= l2; dz /= l2;
    } else { dx /= dl; dz /= dl; }
    const dir = new THREE.Vector3(dx, 0, dz);

    res.target = dl;
    res.drop = aim.y - A.y;

    /* 到鼠标所在高度（下降段）的时刻；跳不到那么高就只画到滞空结束 */
    const th = this.timeAtHeight(res.drop);
    res.highOk = Number.isFinite(th);
    const tEnd = Math.min(Number.isFinite(th) ? Math.max(res.hang, th) : res.hang, this.tCap());

    const tr = this._trace(dir, tEnd);
    res.hit = tr.hit;

    /* 曲线 */
    const pos = this.jCurve.geometry.attributes.position;
    const n = Math.min(DOTS, tr.pts.length);
    for (let i = 0; i < n; i++) pos.setXYZ(i, tr.pts[i].x, tr.pts[i].y, tr.pts[i].z);
    pos.needsUpdate = true;
    this.jCurve.geometry.setDrawRange(0, n);

    /* 采样点（弹道圆点） */
    const cnt = Math.min(DOTS, n);
    const m4 = this._m4 || (this._m4 = new THREE.Matrix4());
    for (let i = 0; i < cnt; i++) {
      m4.makeTranslation(tr.pts[i].x, tr.pts[i].y, tr.pts[i].z);
      this.jDots.setMatrixAt(i, m4);
    }
    this.jDots.count = cnt;
    this.jDots.instanceMatrix.needsUpdate = true;

    /* 落点与实际射程 */
    const end = tr.end;
    res.reach = Math.hypot(end.x - A.x, end.z - A.z);
    res.ok = res.highOk && res.reach + 0.05 >= res.target;

    const col = res.ok ? C_OK : C_BAD;
    this.jCurve.material.color.setHex(col);
    this.jDots.material.color.setHex(col);
    this.jLand.material.color.setHex(col);
    this.jLand.position.set(end.x, end.y + 0.06, end.z);
    this.jLandLabel.position.set(end.x, end.y + 1.5, end.z);
    setLabel(this.jLandLabel, (tr.hit ? '落点 ' : '落空（没打到实体）') + f2(res.reach) + ' 格');

    /* 鼠标目标标记 */
    this.jAim.position.set(aim.x, aim.y + 0.06, aim.z);
    this.jAim.material.color.setHex(col);
    this.jAimPost.geometry.setFromPoints([aim.clone(), aim.clone().setY(aim.y + 4)]);
    this.jAimPost.geometry.attributes.position.needsUpdate = true;
    this.jAimPost.material.color.setHex(col);
    this.jAimLabel.position.set(aim.x, aim.y + 4.8, aim.z);
    setLabel(this.jAimLabel, (res.ok ? '可跳达 ' : '够不到 ') + f2(res.target) + ' 格', res.ok ? '#c8ffe2' : '#ffc9d6');

    this._refreshHud();
  }

  /* ============================================================
     计时测量器：规划（直线估算 / 3D 寻路）与渲染
     ============================================================ */
  _segMode(i) {
    const m = this.segModes[i];
    if (m && m !== 'auto') return m;
    const a = this.nodes[i], b = this.nodes[i + 1];
    if (!a || !b) return 'run';
    const dy = b.y - a.y;
    // 抬脚就能上去的高度（stepHeight）不算跳，只有真跨不过去才按跳跃算
    const step = PLAYER.stepHeight;
    if (dy < -(step + 0.2)) return 'fall';
    if (dy > step + 0.2) return 'jump';
    return 'run';
  }

  /** 关卡几何被编辑过：作废落点图，下次重算时重扫 */
  invalidateNav() {
    if (!this.nav) return;
    this.nav.invalidate();
    this.nav.clear();
    this.navDirty = true;
  }

  /** 手动重扫地形 */
  rescanNav() {
    this.nav.clear();
    this.navDirty = true;
    if (this.active === 'timing') this._syncTiming();
  }

  /** 节点包围盒 = 寻路需要覆盖的范围 */
  _nodeBox() {
    const b = new THREE.Box3();
    for (const p of this.nodes) b.expandByPoint(p);
    return b;
  }

  /** 需要时启动地形扫描；返回是否已经可用 */
  _ensureNav() {
    if (!this.navMode || this.nodes.length < 2) return false;
    this.nav.setSig(this._navSig());
    /* ★ 关卡自带的「必经机制段」（生成器写进 meta.generated.mechLinks）：接进落点图。
       否则编辑器算耗时 / 证明时会把滑索 / 攀爬 / WallJump / 游泳段当成「跳不过去」。 */
    const ml = (this.ed && this.ed.level && this.ed.level.meta
      && this.ed.level.meta.generated && this.ed.level.meta.generated.mechLinks) || null;
    if (this._mechSig !== ml) {
      this._mechSig = ml;
      this.nav.setMech(ml || []);
    }
    return this.nav.ensure(this._nodeBox());
  }

  /** 全量重算：扫描（需要时）+ 规划 + 渲染 */
  _syncTiming() {
    this._ensureNav();
    this._planTiming();
    this._renderTiming();
    this._refreshHud();
  }

  /* ---------- 规划 ---------- */
  /** 算每两个节点之间的耗时；只算数据，不碰 3D 辅助体 */
  _planTiming() {
    this.segInfo = [];
    this.moves = [];
    this.total = 0;
    this.navErr = '';
    this.planWarn = '';
    this.navMs = 0;
    if (this.nodes.length < 2) return;

    let useNav = false;
    if (this.navMode) {
      if (this.nav.ready && this.nav.usable) useNav = true;
      else if (this.nav.busy) this.navErr = '地形扫描中…暂时按直线估算';
      else this.navErr = '地形没扫到可站立的表面（把节点放到平台面上）';
    }
    if (useNav) this._planNav();
    else this._planDirect();
  }

  /** 单腿的直线估算（不看地形，纯距离 + 落差公式） */
  _legDirect(i, p) {
    const a = this.nodes[i], b = this.nodes[i + 1];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const dy = b.y - a.y;
    const mode = this._segMode(i);
    const tRun = this.sp > 0 ? d / this.sp : 0;
    let t = tRun, warn = '', code = 0;

    if (mode === 'fall') {
      t = Math.max(tRun, navDropTime(Math.max(0, -dy), p));
      code = 2;
    } else if (mode === 'jump') {
      const th = navJumpTime(Math.max(0, dy), p);
      if (!Number.isFinite(th)) { warn = '跳不到这个高度'; t = navHang(p); }
      else {
        t = Math.max(tRun, th);
        const reach = navDistAt(th, p);
        if (d > reach + 0.05) warn = '水平距离超出跳距 ' + f2(reach);
      }
      code = 1;
    }
    return { t, mode, d, dy, warn, code, place: mode === 'fall' && d < 1.5 };
  }

  /** 把一条直线估算的腿写进 moves / segInfo；fail=true 时画成红色（寻路失败后的兜底） */
  _pushDirectLeg(i, p, warnOverride, fail) {
    const g = this._legDirect(i, p);
    const a = this.nodes[i], b = this.nodes[i + 1];
    const pts = g.code ? arcPoints(a, b, g.code, p, 14)
      : [a.clone().setY(a.y + 0.9), b.clone().setY(b.y + 0.9)];
    const warn = warnOverride || g.warn;
    const m0 = this.moves.length;
    this.moves.push({ mode: g.mode, pts, d: g.d, dy: g.dy, t: g.t, warn, place: g.place, fail: !!fail });
    this.segInfo.push({
      t: g.t, mode: g.mode, d: g.d, dy: g.dy, warn, place: g.place, m0, m1: m0 + 1, nav: false, fail: !!fail,
      hops: { run: g.mode === 'run' ? 1 : 0, jump: g.mode === 'jump' ? 1 : 0, fall: g.mode === 'fall' ? 1 : 0 },
    });
    this.total += g.t;
  }

  /** 直线估算：不看地形，按水平距离 + 落差公式估 */
  _planDirect() {
    const p = this._param();
    for (let i = 0; i + 1 < this.nodes.length; i++) this._pushDirectLeg(i, p);
  }

  /** 3D 寻路：在真实地形上求最快路线（逐「腿」调用 A*） */
  _planNav() {
    const p = this._param();
    const t0 = this._tNow();
    for (let i = 0; i + 1 < this.nodes.length; i++) {
      const a = this.nodes[i], b = this.nodes[i + 1];
      const r = this.nav.path(a, b, p);

      if (!r.ok) {
        // 寻路失败时退化为直线估算，至少让用户看到时间数字（画成红色并给出原因）
        this._pushDirectLeg(i, p, (r.reason || '找不到路线') + '，已退化为直线估算', true);
        continue;
      }
      if (r.overBudget) this.planWarn = '路径校验预算用尽：部分可达性按几何近似判定';

      const m0 = this.moves.length;
      const hops = { run: 0, jump: 0, fall: 0 };
      let t = 0;
      for (const mv of r.moves) {
        this.moves.push({ mode: mv.mode, pts: mv.pts, d: mv.d, dy: mv.dy, t: mv.t, warn: '' });
        if (hops[mv.mode] !== undefined) hops[mv.mode]++;
        t += mv.t;
      }
      this.total += t;

      const snap = Math.max(r.snapA || 0, r.snapB || 0);
      this.segInfo.push({
        t, mode: 'nav', d: 0, dy: 0, place: false, nav: true, hops,
        warn: snap > 1.2 ? '节点离落脚面 ' + f2(snap) + ' 格，已吸附到最近的表面' : '',
        m0, m1: this.moves.length,
      });
    }
    this.navMs = this._tNow() - t0;
  }

  _tNow() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

  /* ---------- 渲染 ---------- */
  _renderTiming() {
    disposeTree(this.gTiming);
    this.gTiming = new THREE.Group();
    this.gTiming.visible = this.active === 'timing';
    this.root.add(this.gTiming);
    this.gPath = new THREE.Group();
    this.gNodes = new THREE.Group();
    this.gTiming.add(this.gPath, this.gNodes);
    this.nodeDots = [];
    this.nodePosts = [];
    this.nodeLabels = [];

    /* 路径：逐段动作（跑动沿表面 / 跳跃抛物线 / 下落弧线） */
    for (const mv of this.moves) {
      const col = mv.fail ? C_BAD : (mv.mode === 'jump' ? C_JUMP : mv.mode === 'fall' ? C_WARN : C_ACC);
      if (mv.pts && mv.pts.length > 1) this.gPath.add(lineMesh(mv.pts, col, mv.fail ? .95 : .8));
      if (mv.place) {
        // 原地下落：补一条竖直落差线，让「原地站定再往下掉」一眼看得出来
        const a = mv.pts[0], b = mv.pts[mv.pts.length - 1];
        this.gPath.add(lineMesh([a.clone(), new THREE.Vector3(a.x, b.y, a.z)], col, .9));
      }
    }

    /* 每两个节点之间标一次耗时 */
    for (let i = 0; i + 1 < this.nodes.length; i++) {
      const info = this.segInfo[i];
      if (!info) continue;
      const a = this.nodes[i], b = this.nodes[i + 1];
      const lab = makeLabel(f2(info.t) + 's', info.warn ? '#ffc9d6' : '#dff0ff', 1.7);
      lab.position.set((a.x + b.x) / 2, (a.y + b.y) / 2 + 2.4, (a.z + b.z) / 2);
      this.gPath.add(lab);
    }

    /* 节点圆点 / 竖线 / 累计时间（拖动时只更新这一组） */
    let acc = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const p = this.nodes[i];
      const dot = dotMesh(i === 0 ? 0.62 : 0.5, i === 0 ? C_OK : C_ACC);
      dot.position.copy(p);
      this.gNodes.add(dot);
      this.nodeDots.push(dot);

      const post = lineMesh([p.clone(), p.clone().setY(p.y + 3)], C_ACC, .55);
      this.gNodes.add(post);
      this.nodePosts.push(post);

      const lab = makeLabel(i === 0 ? '起点 A · 0.00s' : ('第 ' + (i + 1) + ' 点 · ' + f2(acc) + 's'), '#dff0ff', 1.9);
      lab.position.set(p.x, p.y + 3.9, p.z);
      this.gNodes.add(lab);
      this.nodeLabels.push(lab);

      if (i > 0) acc += this.segInfo[i - 1] ? this.segInfo[i - 1].t : 0;
    }
  }

  /** 拖动节点时只挪节点视觉：不重算路径，也不重做画布贴图 */
  _syncNodeVisuals() {
    if (!this.nodeDots || !this.nodeDots.length) return;
    const n = Math.min(this.nodes.length, this.nodeDots.length);
    for (let i = 0; i < n; i++) {
      const p = this.nodes[i];
      this.nodeDots[i].position.copy(p);
      const pos = this.nodePosts[i].geometry.attributes.position;
      pos.setXYZ(0, p.x, p.y, p.z);
      pos.setXYZ(1, p.x, p.y + 3, p.z);
      pos.needsUpdate = true;
      this.nodeLabels[i].position.set(p.x, p.y + 3.9, p.z);
    }
  }

  _addNode(p) {
    this.nodes.push(p);
    this._syncTiming();
    this.ed.showHint('节点 ' + this.nodes.length + '：' + f1(p.x) + ', ' + f1(p.y) + ', ' + f1(p.z)
      + ' · 合计 ' + f2(this.total) + ' 秒', 2600);
  }

  _removeNode(i) {
    if (i < 0 || i >= this.nodes.length) return;
    this.nodes.splice(i, 1);
    this.segModes.splice(i, 1);
    this._syncTiming();
  }

  /** 拾取自己放的节点圆点（不参与视口 pick，独立射线） */
  _pickNode(cx, cy) {
    const vp = this.ed.viewport;
    if (!vp || !this.nodes.length) return -1;
    this._ray.near = 0;
    this._ray.far = Infinity;
    this._ray.setFromCamera(vp.ndc(cx, cy), vp.camera);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const p = this.nodes[i];
      // 点到射线的距离（用 2 米容差近似圆点半径）
      const v = this._tmpV || (this._tmpV = new THREE.Vector3());
      v.copy(p).sub(this._ray.ray.origin);
      const along = v.dot(this._ray.ray.direction);
      if (along < 0) continue;
      const perp = v.addScaledVector(this._ray.ray.direction, -along).length();
      if (perp > 1.6) continue;
      // 距离相机更近（屏幕更靠前）的优先
      if (along < bestD) { bestD = along; best = i; }
    }
    return best;
  }

  /* ============================================================
     HUD
     ============================================================ */
  _bindHud() {
    if (!this.hud) return;
    // HUD 上的控件不要穿透到视口（视口那层已用 isOverlay 拦住，这里再保险一次）
    this.hud.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button,input,select,label')) e.stopPropagation();
    });
  }

  _buildHud() {
    const host = this.hud;
    if (!host) return;
    clear(host);
    const isJump = this.active === 'jump';

    host.appendChild(el('div', { class: 'pk-hd' },
      el('b', { text: isJump ? '跳跃验证器' : '跑酷计时器' }),
      el('span', { class: 'pk-x', text: '✕', title: '关闭（Esc）', onclick: () => this.setActive(null) })));

    /* 参考参数（与真实玩家属性同口径，可手动改） */
    host.appendChild(el('div', { class: 'pk-sub', text: '参考属性' }));
    host.appendChild(this._numRow('跳跃初速', 'jumpPower', 1));
    host.appendChild(this._numRow('水平速度', 'speed', 1));
    host.appendChild(this._numRow('重力', 'gravity', 5));
    host.appendChild(el('div', { class: 'ph-row' },
      el('span', { class: 'ph-lab', text: '起跳方式' }),
      new GridSelect({
        value: this.ref.air ? 'air' : 'full',
        cls: 'inp sm',
        options: [
          { v: 'full', l: '跑动起跳（满速）' },
          { v: 'air', l: '原地起跳（空中加速）' },
        ],
        onChange: (v) => { this.ref.air = v === 'air'; this._paramChanged(); },
      })));

    if (isJump) {
      host.appendChild(el('div', { class: 'pk-sub', text: '起跳点' }));
      this.hudAnchor = el('div', { class: 'pk-stat' });
      host.appendChild(this.hudAnchor);
      host.appendChild(el('div', { class: 'ph-row' },
        el('button', { class: 'mini', text: '锚到起点', onclick: () => { this._anchorToSpawn(); this._calcNeed = true; this._updateJump(); } }),
        el('button', { class: 'mini', text: '锚到选中对象', onclick: () => this._anchorToSelection() }),
        el('button', { class: 'mini', text: '原地重算', onclick: () => { this._recalcAim(); this._updateJump(); } })));
      host.appendChild(el('div', { class: 'pk-sub', text: '结果' }));
      this.hudS1 = el('div', { class: 'pk-stat' });
      this.hudS2 = el('div', { class: 'pk-stat' });
      this.hudS3 = el('div', { class: 'pk-stat' });
      host.appendChild(this.hudS1);
      host.appendChild(this.hudS2);
      host.appendChild(this.hudS3);
      host.appendChild(el('div', { class: 'pk-hint', text: '左键点地面设起跳点 · 移动鼠标看轨迹 · 圈 = 同水平面最大跳距' }));
    } else {
      host.appendChild(el('div', { class: 'pk-sub', text: '路径' }));
      this.hudMode = new GridSelect({
        value: this.navMode ? 'nav' : 'line',
        cls: 'inp sm',
        options: [
          { v: 'nav', l: '3D 寻路（真实地形）' },
          { v: 'line', l: '直线估算（不看地形）' },
        ],
        onChange: (v) => { this.navMode = v === 'nav'; this._syncTiming(); },
      });
      host.appendChild(el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '口径' }), this.hudMode));
      this.hudTerrain = el('div', { class: 'pk-stat' });
      host.appendChild(this.hudTerrain);
      this.hudTotal = el('div', { class: 'pk-total' });
      host.appendChild(this.hudTotal);
      this.hudWarn = el('div', { class: 'pk-warn hidden' });
      host.appendChild(this.hudWarn);
      this.hudList = el('div', { class: 'pk-list' });
      host.appendChild(this.hudList);
      host.appendChild(el('div', { class: 'ph-row' },
        el('button', { class: 'mini', text: '重扫地形', title: '关卡几何改过之后手动重扫', onclick: () => this.rescanNav() }),
        el('button', { class: 'mini', text: '撤销末节点', onclick: () => this._removeNode(this.nodes.length - 1) }),
        el('button', { class: 'mini', text: '清空', onclick: () => { this.nodes = []; this.segModes = []; this.navDirty = true; this._syncTiming(); } })));
      host.appendChild(el('div', { class: 'pk-hint', text: '左键点平台加节点 · 拖动节点移动（松手后重新寻路）· 右键节点删除 · 净空按中心线判定' }));
    }
    this._refreshHud();
  }

  _numRow(label, key, step) {
    const inp = el('input', {
      class: 'inp sm', type: 'number', value: String(this.ref[key]), step: String(step), min: '0',
      onchange: () => {
        const v = Number(inp.value);
        if (isFinite(v)) {
          this.ref[key] = key === 'gravity' ? Math.max(1, v) : Math.max(0, v);
          this._paramChanged();
        }
        inp.value = String(this.ref[key]);      // 回写被纠正后的值
      },
    });
    return el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: label }), inp);
  }

  _paramChanged() {
    this._calcNeed = true;
    if (this.active === 'jump') this._updateJump();
    else if (this.active === 'timing') this._syncTiming();
  }

  _anchorToSelection() {
    const recs = this.ed.selectedRecs();
    if (!recs.length) { this.ed.showHint('先选中一个对象，再锚到它', 2000); return; }
    const p = worldPosition(this.ed.level, recs[0].o);
    this.anchor.set(p[0], p[1], p[2]);
    this._calcNeed = true;
    if (this.active === 'jump') this._updateJump();
  }

  _refreshHud() {
    if (!this.hud || !this.active) return;
    if (this.active === 'jump') {
      const A = this.anchor, r = this.res;
      if (this.hudAnchor) this.hudAnchor.textContent = '起跳点 ' + f1(A.x) + ', ' + f1(A.y) + ', ' + f1(A.z);
      if (this.hudS1) this.hudS1.textContent = '最大同水平面跳距 ' + f2(r.range) + ' 格 · 跳跃高度 ' + f2(r.apex) + ' 格 · 滞空 ' + f2(r.hang) + ' 秒';
      if (this.hudS2) {
        this.hudS2.textContent = this.aim
          ? '朝鼠标方向：射程 ' + f2(r.reach) + ' 格（目标 ' + f2(r.target) + ' 格，落差 ' + f2(r.drop) + '）'
          : '把鼠标移到视口里看轨迹';
      }
      if (this.hudS3) {
        this.hudS3.textContent = !this.aim ? '' : (r.highOk
          ? (r.ok ? '✓ 可以跳到鼠标位置' : '✕ 够不到（差 ' + f2(Math.max(0, r.target - r.reach)) + ' 格）')
          : '✕ 跳不了这么高（超过 ' + f2(r.apex) + ' 格）');
        this.hudS3.className = 'pk-stat ' + (r.ok ? 'ok' : 'bad');
      }
    } else {
      if (this.hudMode) this.hudMode.setValue(this.navMode ? 'nav' : 'line');

      if (this.hudTerrain) {
        const nv = this.nav;
        let s;
        if (!this.navMode) s = '直线估算模式，不扫描地形';
        else if (nv.busy) s = '扫描中 ' + Math.round(nv.progress * 100) + '% · 已找到 ' + nv.count + ' 个落点';
        else if (nv.ready) s = '已扫 ' + nv.count + ' 个落点 · 用 ' + f1(nv.scanMs) + ' ms';
        else s = '未扫描';
        this.hudTerrain.textContent = '地形：' + s;
        this.hudTerrain.className = 'pk-stat' + (this.navMode && !nv.ready ? ' bad' : '');
      }

      if (this.hudTotal) {
        const parts = [this.nodes.length + ' 个节点', '合计 ' + f2(this.total) + ' 秒'];
        if (this.navMode && this.navMs > 0) parts.push('寻路 ' + f1(this.navMs) + ' ms');
        if (this.nodes.length < 2) parts.push('（至少要两个点）');
        this.hudTotal.textContent = parts.join(' · ');
      }

      if (this.hudWarn) {
        const w = [this.navErr, this.planWarn].filter(Boolean);
        this.hudWarn.textContent = w.join(' · ');
        this.hudWarn.classList.toggle('hidden', !w.length);
      }

      if (this.hudList) {
        clear(this.hudList);
        const name = { run: '跑动', fall: '下落', jump: '跳跃' };
        for (let i = 0; i + 1 < this.nodes.length; i++) {
          const s = this.segInfo[i];
          if (!s) continue;
          const kids = [el('span', { class: 'pk-seg-i', text: (i + 1) + '→' + (i + 2) })];
          if (s.nav) {
            const h = [];
            if (s.hops.run) h.push('跑 ' + s.hops.run);
            if (s.hops.jump) h.push('跳 ' + s.hops.jump);
            if (s.hops.fall) h.push('落 ' + s.hops.fall);
            kids.push(el('b', { text: '寻路' }));
            kids.push(el('span', { text: h.join(' · ') || '原地' }));
          } else {
            kids.push(el('b', { text: name[s.mode] + (s.place ? '·原地' : '') }));
            kids.push(el('span', { text: '距离 ' + f2(s.d) }));
            kids.push(el('span', { text: (s.mode === 'run' ? '落差 ' : s.mode === 'fall' ? '下落 ' : '升高 ') + f2(Math.abs(s.dy)) }));
          }
          kids.push(el('em', { text: f2(s.t) + 's' }));

          const row = el('div', { class: 'pk-seg' + (s.warn ? ' bad' : '') }, ...kids);
          if (s.warn) row.appendChild(el('span', { class: 'pk-warn', text: '⚠ ' + s.warn }));
          if (s.nav) {
            row.title = '由 3D 寻路得出（想手动改判定方式请切到「直线估算」）';
          } else {
            row.title = '点击切换判定方式（自动 → 跑动 → 下落 → 跳跃）';
            row.addEventListener('click', () => {
              const cur = this.segModes[i] && this.segModes[i] !== 'auto' ? this.segModes[i] : 'auto';
              const next = cur === 'auto' ? 'run' : cur === 'run' ? 'fall' : cur === 'fall' ? 'jump' : 'auto';
              this.segModes[i] = next;
              this._syncTiming();
            });
          }
          this.hudList.appendChild(row);
        }
        if (this.nodes.length < 2) {
          this.hudList.appendChild(el('div', { class: 'pk-hint', text: '还没放够节点：点第一个平台设 A 点，再点下一步落脚处设 B 点' }));
        }
      }
    }
  }

  /* ============================================================
     输入（由 editor 转发）
     ============================================================ */
  onDown(e) {
    if (!this.active) return;
    const ed = this.ed, vp = ed.viewport;
    if (!vp) return;
    if (this.active === 'jump') {
      // 左键点地面 = 把起跳点挪过去（点到空处则不动）
      const hit = vp.pick(e.clientX, e.clientY, { helpers: false, skipLiquid: true });
      const p = hit ? hit.point : vp.ground(e.clientX, e.clientY, this.anchor.y);
      if (p) {
        this.anchor.set(p.x, p.y, p.z);
        this._aimXY = { x: e.clientX, y: e.clientY };
        this._calcNeed = true;
        this._updateJump();
        ed.showHint('起跳点已设为 ' + f1(p.x) + ', ' + f1(p.y) + ', ' + f1(p.z), 2200);
      }
      return;
    }
    /* 计时器：拖节点 / 加节点 */
    const i = this._pickNode(e.clientX, e.clientY);
    if (i >= 0) {
      this.drag = { i };
      try { ed.viewDom.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      return;
    }
    const hit = vp.pick(e.clientX, e.clientY, { helpers: false, skipLiquid: true });
    const p = hit ? hit.point : vp.ground(e.clientX, e.clientY, 0);
    if (p) this._addNode(p.clone().add(new THREE.Vector3(0, 0.02, 0)));
  }

  onMove(e) {
    if (!this.active) return;
    if (e.buttons === 0 && this.drag) this.drag = null;   // 丢了 pointerup 兜底
    if (this.hud && e.target && e.target.closest && e.target.closest('#' + HUD_ID)) return;
    if (this.active === 'jump') {
      this._aimXY = { x: e.clientX, y: e.clientY };
      this._calcNeed = true;
      return;
    }
    if (this.drag) {
      const vp = this.ed.viewport;
      const cur = this.nodes[this.drag.i];
      const hit = vp.pick(e.clientX, e.clientY, { helpers: false, skipLiquid: true });
      const p = hit ? hit.point : vp.ground(e.clientX, e.clientY, cur ? cur.y : 0);
      if (p) {
        this.nodes[this.drag.i] = p.clone();
        // 拖动中只挪节点视觉（每帧一次）；路径等松手后再重新寻路，免得每个 pointermove 都跑一遍 A*
        this._segNeed = true;
      }
    }
  }

  onUp() {
    if (!this.active) return;
    this.drag = null;
    if (this._segNeed) { this._segNeed = false; this._syncTiming(); }
  }

  onContext(e) {
    if (!this.active || this.active !== 'timing') return;
    const i = this._pickNode(e.clientX, e.clientY);
    if (i >= 0) this._removeNode(i);
  }

  /* ============================================================
     每帧
     ============================================================ */
  update(dt) {
    if (!this.active) return;
    if (this.active === 'timing') {
      this._hudCool = (this._hudCool || 0) - dt;

      /* 拖动节点：只挪节点视觉，路径等松手后再重算 */
      if (this.drag) this._syncNodeVisuals();
      else if (this._segNeed) { this._segNeed = false; this._syncTiming(); }

      /* 分帧推进地形扫描（一次 6ms，不卡编辑器） */
      if (this.navMode && this.nav.busy) {
        if (this.nav.step(6)) {
          this.navDirty = false;
          this._syncTiming();                  // 扫完立刻出结果
        } else if (this._hudCool <= 0) {
          this._hudCool = 0.1;                 // 进度别每帧写 DOM
          this._refreshHud();
        }
      } else if (this.navDirty) {
        this.navDirty = false;
        this._syncTiming();
      }
      return;
    }
    this._calcCool -= dt;
    if (this._calcNeed && this._calcCool <= 0) {
      this._calcNeed = false;
      this._calcCool = 0.07;      // 节流：轨迹要射线求落地，别每帧都算
      this._recalcAim();
      this._updateJump();
    }
  }
}