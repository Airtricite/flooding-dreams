/* ============================================================
   3D 编辑组件：选择 / 移动 / 旋转 / 缩放
   - 单选中：直接操作对象本体（父级空间精确）
   - 多选中：代理物体 + 增量矩阵运算
   - 支持世界/局部坐标系、吸附（轴向吸附）
   ============================================================ */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EDITOR } from '../config.js';
import { deg2rad, rad2deg, round } from '../core/util.js';
import { worldPosition, getObject } from '../world/level.js';
import { PATH_TYPES } from '../world/paths.js';

// 六面缩放柄的轴向配色（X 红 / Y 绿 / Z 蓝），悬停时统一高亮
const FACE_COLORS = [0xff5555, 0x66dd66, 0x5599ff];
const FACE_HOVER = 0xffdd55;
// 组合模式：八个角点（自由缩放）的配色
const CORNER_COLOR = 0xf2f2f2;
// 圆环默认躺在 XY 平面（轴 = +Z）：把轴旋到 X / Y / Z 三个方向的固定旋转
const RING_AXIS_ROT = [
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
  new THREE.Quaternion(),
];

export class EditorGizmo {
  constructor(opts = {}) {
    this.scene = opts.scene;
    this.viewport = opts.viewport;
    this.dom = opts.dom;
    this.getBuilder = opts.getBuilder;
    this.getLevel = opts.getLevel;
    this.onLive = opts.onLive || null;     // 拖动中：数据已改，需要 UI 刷新
    this.onStart = opts.onStart || null;   // 开始拖动（记录撤销点）
    this.onEnd = opts.onEnd || null;       // 结束拖动（提交撤销）

    this.recs = [];
    this.mode = 'translate';
    this.space = 'world';
    this.snap = false;
    this.proxy = new THREE.Object3D();
    this.proxy.name = 'editor-gizmo-proxy';
    this.proxyInScene = false;

    this.tc = new TransformControls(this.viewport.camera, this.dom);
    this.tc.size = 0.92;
    this.tc.setMode('translate');
    this.tc.setSpace('world');
    this.tc.visible = false;
    this.scene.add(this.tc);
    this.tc.addEventListener('mouseDown', () => {
      this._snapshot();
      if (this.onStart) this.onStart(this.recs);
    });
    this.tc.addEventListener('mouseUp', () => {
      if (this.onEnd) this.onEnd(this.recs);
    });
    this.tc.addEventListener('objectChange', () => this._apply());
    this._unbindTC();
    this._bindPointer();
    this._buildFaceHandles();
    this._buildComboHandles();
  }

  /* ============================================================
     六面缩放柄
     ------------------------------------------------------------
     不用 TransformControls 的缩放柄（它是以中心对称缩放的），改成对象六个面上
     各一个小方块：拖某个面只改这一侧的尺寸，对面保持不动。
     手柄挂在场景里（世界空间），每帧按相机距离换算成恒定屏幕大小，
     拖动时的射线/轴向计算全在「对象的父节点空间」里做 —— 与 o.position /
     o.scale 同一套坐标，所以父节点带旋转缩放时也不会算歪。
     ============================================================ */
  _buildFaceHandles() {
    this.faceGroup = new THREE.Group();
    this.faceGroup.name = 'editor-face-scale';
    this.faceGroup.visible = false;
    this.faceGroup.userData.helper = true;
    this.scene.add(this.faceGroup);
    this._raycaster = new THREE.Raycaster();
    this._hoverFace = null;
    this._hoverBody = false;
    this._faceDrag = null;
    this.faceHandles = [];
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (let ax = 0; ax < 3; ax++) {
      for (const sign of [1, -1]) {
        // 缩放柄始终置顶：关闭深度测试/写入，避免被物体各部件遮挡。
        // 必须用 transparent 让它进「透明队列」——不透明队列永远先于透明队列渲染，
        // 否则半透明的液体(renderOrder 4) / 围边泡沫(5) 会在它之后画上来把它盖住。
        const mat = new THREE.MeshBasicMaterial({
          color: FACE_COLORS[ax], fog: false, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData.helper = true;
        mesh.userData.face = { ax, sign };
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = 40;         // 高于液体(4) / 泡沫(5) / 体积光(7) / 粒子(9,10) / 路径节点(20~22)
        this.faceGroup.add(mesh);
        this.faceHandles.push(mesh);
      }
    }
  }

  /* ============================================================
     组合手柄：六面移动 + 三环旋转 + 八角自由缩放
     ------------------------------------------------------------
     三种柄同时显示在对象上，拾取优先级：
       · 面中心小方块（复用上面的 faceHandles）→ 该面单侧缩放（与「缩放」工具一致）
       · 八个角点小方块 → 三轴独立、对角锚定的自由缩放
       · 六个面中心以外的表面区域 → 沿命中面的法线平移
       · 三个彩色圆环（绕对象中心的 X / Y / Z 轴）→ 旋转（被物体挡住的那半段不可拾取）
     与「六面缩放」用的是同一套屏幕恒定尺寸 / 节点空间换算。
     ============================================================ */
  _buildComboHandles() {
    this.ringGroup = new THREE.Group();
    this.ringGroup.name = 'editor-combo-rings';
    this.ringGroup.visible = false;
    this.ringGroup.userData.helper = true;
    this.scene.add(this.ringGroup);

    this.cornerGroup = new THREE.Group();
    this.cornerGroup.name = 'editor-combo-corners';
    this.cornerGroup.visible = false;
    this.cornerGroup.userData.helper = true;
    this.scene.add(this.cornerGroup);

    // 圆环：单位半径、细管径；走正常的深度测试 —— 环落在物体后方的部分被物体挡住
    // （不写深度，避免半透明的环挡住别的半透明物体）
    this._ringGeo = new THREE.TorusGeometry(1, 0.02, 6, 96);
    this.ringHandles = [];
    for (let ax = 0; ax < 3; ax++) {
      const mat = new THREE.MeshBasicMaterial({
        color: FACE_COLORS[ax], fog: false, transparent: true, opacity: 0.9, depthWrite: false,
      });
      const mesh = new THREE.Mesh(this._ringGeo, mat);
      mesh.userData.helper = true;
      mesh.userData.ring = { ax };
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      this.ringGroup.add(mesh);
      this.ringHandles.push(mesh);
    }

    this._cornerGeo = new THREE.BoxGeometry(1, 1, 1);
    this.cornerHandles = [];
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        for (const sz of [1, -1]) {
          // 角点（自由缩放）同样始终置顶：同面柄，走透明队列 + 关深度测试
          const mat = new THREE.MeshBasicMaterial({
            color: CORNER_COLOR, fog: false, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
          });
          const mesh = new THREE.Mesh(this._cornerGeo, mat);
          mesh.userData.helper = true;
          mesh.userData.corner = { sx, sy, sz };
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.frustumCulled = false;
          mesh.renderOrder = 40;
          this.cornerGroup.add(mesh);
          this.cornerHandles.push(mesh);
        }
      }
    }

    this._comboDrag = null;
  }

  /** 单选带几何 / 变换的对象时用六面柄；路径型（滑索 / 折曲线 / 管道）、分组沿用原来的缩放柄 */
  get _faceScaleActive() {
    if (this.mode !== 'scale' || this.recs.length !== 1) return false;
    const rec = this.recs[0];
    if (!rec || !rec.mesh || rec.group || PATH_TYPES.has(rec.type)) return false;
    const o = rec.o || {};
    // 负缩放（镜像）对象的面对侧不成立，沿用原来的缩放柄
    return Array.isArray(o.scale) && Array.isArray(o.position) && o.scale.every((v) => v > 0);
  }

  /** 组合模式：条件与六面柄一致（单选、带几何 / 变换的对象、正缩放） */
  get _comboActive() {
    if (this.mode !== 'combo' || this.recs.length !== 1) return false;
    const rec = this.recs[0];
    if (!rec || !rec.mesh || rec.group || PATH_TYPES.has(rec.type)) return false;
    const o = rec.o || {};
    return Array.isArray(o.scale) && Array.isArray(o.position) && o.scale.every((v) => v > 0);
  }

  /** 对象自身几何在该轴上的局部范围（几何都是单位大小，缺省 -0.5 ~ 0.5） */
  _localExtent(rec, ax) {
    let box = rec.modelBox || null;
    const g = rec.mesh && rec.mesh.geometry;
    if (!box && g) {
      if (!g.boundingBox) g.computeBoundingBox();
      box = g.boundingBox;
    }
    if (box && box.min && box.max) {
      const lo = box.min.getComponent(ax), hi = box.max.getComponent(ax);
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi - lo > 1e-4) return [lo, hi];
    }
    return [-0.5, 0.5];
  }

  /** 手柄的屏幕恒定尺寸（世界单位）：随相机距离线性放大，近处按等效距离保底 */
  _handleSize(worldPos) {
    const dist = this.viewport.camera.position.distanceTo(worldPos);
    const k = EDITOR.faceHandleScale || 0.04;
    return Math.max(k * (EDITOR.faceHandleMinDist || 3), dist * k) * this.tc.size;
  }

  /** 每帧摆放六个手柄：位置贴在对象各面中心，大小随相机距离保持恒定 */
  _updateFaceHandles() {
    if (!this._faceScaleActive && !this._comboActive) { this.faceGroup.visible = false; return; }
    const rec = this.recs[0];
    const proxy = this.proxy;
    proxy.updateWorldMatrix(true, false);
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    const ws = new THREE.Vector3();
    proxy.matrixWorld.decompose(wp, wq, ws);
    const size = this._handleSize(wp);
    for (const h of this.faceHandles) {
      const { ax, sign } = h.userData.face;
      const ext = this._localExtent(rec, ax)[sign > 0 ? 1 : 0];
      h.position.set(0, 0, 0).setComponent(ax, ext).applyMatrix4(proxy.matrixWorld);
      h.quaternion.copy(wq);
      h.scale.setScalar(size);
      h.material.color.setHex(h === this._hoverFace ? FACE_HOVER : FACE_COLORS[ax]);
    }
    this.faceGroup.visible = true;
  }

  /** 每帧摆放三环 + 八角：圆环位于对象中心、半径略大于半对角线；角点贴在八个角上 */
  _updateComboHandles() {
    if (!this._comboActive) {
      this.ringGroup.visible = false;
      this.cornerGroup.visible = false;
      return;
    }
    const rec = this.recs[0];
    const proxy = this.proxy;
    proxy.updateWorldMatrix(true, false);
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    const ws = new THREE.Vector3();
    proxy.matrixWorld.decompose(wp, wq, ws);
    const size = this._handleSize(wp);
    const ext = [0, 1, 2].map((ax) => this._localExtent(rec, ax));

    // 圆环半径：对象半对角线（含父节点缩放）与手柄尺寸取大者
    let sq = 0;
    for (let ax = 0; ax < 3; ax++) {
      const half = Math.max(Math.abs(ext[ax][0]), Math.abs(ext[ax][1])) * Math.abs(ws.getComponent(ax));
      sq += half * half;
    }
    const R = Math.max(EDITOR.comboRingScale || 1.15, 1) *
      Math.max(Math.sqrt(sq), size * 2.2);
    const localMode = this.space === 'local';
    for (const r of this.ringHandles) {
      const ax = r.userData.ring.ax;
      r.position.copy(wp);
      r.quaternion.identity();
      if (localMode) r.quaternion.copy(wq);
      r.quaternion.multiply(RING_AXIS_ROT[ax]);
      r.scale.setScalar(R);
      r.material.color.setHex(r === this._hoverFace ? FACE_HOVER : FACE_COLORS[ax]);
    }
    this.ringGroup.visible = true;

    // 八个角点：几何局部坐标的八个角，经对象世界矩阵摆到世界空间
    const cs = size * (EDITOR.comboCornerScale || 0.9);
    for (const c of this.cornerHandles) {
      const { sx, sy, sz } = c.userData.corner;
      const sgn = [sx, sy, sz];
      c.position.set(0, 0, 0);
      for (let ax = 0; ax < 3; ax++) c.position.setComponent(ax, ext[ax][sgn[ax] > 0 ? 1 : 0]);
      c.position.applyMatrix4(proxy.matrixWorld);
      c.quaternion.copy(wq);
      c.scale.setScalar(cs);
      c.material.color.setHex(c === this._hoverFace ? FACE_HOVER : CORNER_COLOR);
    }
    this.cornerGroup.visible = true;
  }

  /* ============================================================
     选中液体时的特殊处理
     ------------------------------------------------------------
     水面 / 围边泡沫都是半透明物体（renderOrder 4 / 5）且不写深度，
     柄的绘制本身已经排在它们之后（见 _buildFaceHandles 的注释），
     但圆环的「可拾取性」是用「射线先打到被选中物体的距离」来卡的：
     _meshDist 取的是水面自身网格 —— 对液体来说，视线基本都会先穿过
     水面才碰到圆环，于是圆环看得见却点不到。
     所以单选液体时跳过这层遮挡判定：水不遮挡环的绘制，也就不该挡它的拾取。
     （实体墙挡住圆环时的拾取行为与原来一致：_meshDist 只测被选中物体。）
     ============================================================ */
  get _liquidSel() {
    return this.recs.length === 1 && !!this.recs[0] && this.recs[0].type === 'liquid';
  }

  /** 依据当前模式决定显示哪套柄 */
  _refreshGizmo() {
    const faces = this._faceScaleActive;
    const combo = this._comboActive;
    this.tc.detach();
    if (faces || combo) {
      this.tc.visible = false;
      this._updateFaceHandles();
      this._updateComboHandles();
      return;
    }
    this.faceGroup.visible = false;
    this.ringGroup.visible = false;
    this.cornerGroup.visible = false;
    this._hoverFace = null;
    this._hoverBody = false;
    if (this.recs.length) { this.tc.attach(this.proxy); this.tc.visible = true; }
    else this.tc.visible = false;
  }

  _ray(e) {
    const p = this._pointer(e);
    this._raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), this.viewport.camera);
    return this._raycaster;
  }

  /** 柄拾取：缩放柄（面中心小方块 + 八个角点）→ 圆环 → 无（交回给物体表面判定） */
  _hitHandle(e) {
    const ray = this._ray(e);
    const nearest = (group) => {
      if (!group || !group.visible) return null;
      group.updateMatrixWorld(true);
      return ray.intersectObjects(group.children, false)[0] || null;
    };
    // 1) 缩放部分优先：面中心与角点里离相机最近的那个
    const scales = [nearest(this.faceGroup), nearest(this.cornerGroup)].filter(Boolean);
    if (scales.length) return scales.sort((a, b) => a.distance - b.distance)[0].object;
    // 2) 圆环：被物体挡住的那半段不参与拾取，与画面上的遮挡保持一致；
    //    单选液体时水面不参与遮挡（水在环之前绘制且不写深度），故跳过这层判定
    const ring = nearest(this.ringGroup);
    if (ring && (this._liquidSel || ring.distance < this._meshDist(ray))) return ring.object;
    return null;
  }

  /** 射线打到被选中物体网格的最近距离（没打到为 Infinity） */
  _meshDist(ray) {
    const rec = this.recs[0];
    if (!rec || !rec.mesh) return Infinity;
    const hit = ray.intersectObject(rec.mesh, true)[0];
    return hit ? hit.distance : Infinity;
  }

  _hoverFaceAt(e) {
    if (!this._faceScaleActive && !this._comboActive) {
      this._hoverFace = null;
      this._hoverBody = false;
      return;
    }
    this._hoverFace = this._hitHandle(e);
    // 组合模式：柄之外还悬在物体表面上 → 按下就是沿该面法线平移，
    // 这个标记让编辑器别把同一次按下当成框选的起手
    this._hoverBody = !this._hoverFace && this._comboActive && !!this._pickSurface(e);
  }

  /** 射线与「过 A、方向 u（单位向量）的直线」最近点在该直线上的参数 */
  _lineParam(O, D, A, u) {
    const w0x = O.x - A.x, w0y = O.y - A.y, w0z = O.z - A.z;
    const a = D.dot(D), b = D.dot(u), c = u.dot(u);
    const d = D.x * w0x + D.y * w0y + D.z * w0z;
    const e = u.x * w0x + u.y * w0y + u.z * w0z;
    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-8) return null;   // 视线几乎与轴平行，保持上一次结果
    return (a * e - b * d) / denom;
  }

  _startFaceDrag(h) {
    const rec = this.recs[0];
    const proxy = this.proxy;
    const { ax, sign } = h.userData.face;
    this._snapshot();
    if (this.onStart) this.onStart(this.recs);
    const [lo, hi] = this._localExtent(rec, ax);
    const axisLocal = new THREE.Vector3().setComponent(ax, 1).applyQuaternion(proxy.quaternion);
    const s0 = proxy.scale.getComponent(ax);
    const g = sign > 0 ? lo : hi;              // 对面（固定不动的那个面）
    this._faceDrag = {
      rec, ax, sign, g,
      span: Math.abs(hi - lo) || 1,
      axisLocal,
      u: axisLocal.clone().multiplyScalar(sign),   // 被拖动的面的外法线
      A0: proxy.position.clone().addScaledVector(axisLocal, g * s0),   // 固定面中心（父节点空间）
      inv: this._start[0].inv.clone(),
    };
  }

  _moveFaceDrag(e) {
    const d = this._faceDrag;
    if (!d) return;
    const ray = this._ray(e).ray;                  // Raycaster → Ray（origin / direction 在 ray 上）
    const O = ray.origin.clone().applyMatrix4(d.inv);
    const D = ray.direction.clone().transformDirection(d.inv).normalize();
    const t = this._lineParam(O, D, d.A0, d.u);
    if (t === null) return;
    let size = t;                                  // 固定面到被拖面的距离 = 该轴长度
    if (this.snap) {
      const sn = Math.max(0.01, EDITOR.snapScale);
      size = Math.round(size / sn) * sn;
    }
    size = Math.max(0.02, size);
    const sNew = Math.max(0.02, size / d.span);
    const center = d.A0.clone().addScaledVector(d.axisLocal, -d.g * sNew);
    const o = d.rec.o;
    const b = this.getBuilder();
    o.scale[d.ax] = round(sNew);
    o.position = [round(center.x), round(center.y), round(center.z)];
    // 代理同步到新位姿，手柄才贴着面走
    this.proxy.scale.setComponent(d.ax, sNew);
    this.proxy.position.copy(center);
    if (b) b.syncTransform(d.rec);
    this._updateFaceHandles();
    this._updateComboHandles();
    if (this.onLive) this.onLive(this.recs, 'scale');
  }

  _endFaceDrag() {
    if (!this._faceDrag) return;
    this._faceDrag = null;
    if (this.onEnd) this.onEnd(this.recs);
  }

  /* ============================================================
     组合模式拖拽
     ------------------------------------------------------------
     三套柄都不走 TransformControls：射线换算到「对象的父节点空间」后自己算，
     和 o.position / o.rotation / o.scale 是同一套坐标，父节点带旋转缩放也不会算歪。
     拖拽期间只改这两三个字段 + 同步代理，然后 syncTransform 让网格立刻跟上。
     ============================================================ */
  /** 世界射线 → 节点空间的 { O, D } */
  _nodeRay(e, inv) {
    const ray = this._ray(e).ray;
    return {
      O: ray.origin.clone().applyMatrix4(inv),
      D: ray.direction.clone().transformDirection(inv).normalize(),
    };
  }

  /** 视线与「过 C、法线 n 的平面」的交点（节点空间），近平行时返回 null */
  _planePoint(e, inv, C, n) {
    const { O, D } = this._nodeRay(e, inv);
    const denom = D.dot(n);
    if (Math.abs(denom) < 1e-5) return null;
    const t = C.clone().sub(O).dot(n) / denom;
    return O.addScaledVector(D, t);
  }

  /** 组合模式：按在物体表面（不是柄）上 → 沿命中面的法线平移 */
  _startSurfaceMove(e) {
    const f = this._pickSurface(e);
    if (!f) return false;
    this._startFaceMove(f, e);
    return true;
  }

  /** 射线打在物体表面上时落在哪个面：取包围盒局部坐标里最靠外的一个轴 */
  _pickSurface(e) {
    const rec = this.recs[0];
    if (!rec || !rec.mesh) return null;
    const hit = this._ray(e).intersectObject(rec.mesh, true)[0];
    if (!hit) return null;
    const p = hit.point.clone().applyMatrix4(this._nodeInv(rec));
    let ax = 0, best = -Infinity;
    for (let a = 0; a < 3; a++) {
      const ext = this._localExtent(rec, a);
      const half = Math.max(Math.abs(ext[0]), Math.abs(ext[1])) * Math.abs(this.proxy.scale.getComponent(a));
      const rel = half > 1e-6 ? Math.abs(p.getComponent(a) - this.proxy.position.getComponent(a)) / half : 0;
      if (rel > best) { best = rel; ax = a; }
    }
    const sign = p.getComponent(ax) - this.proxy.position.getComponent(ax) >= 0 ? 1 : -1;
    return { ax, sign };
  }

  /** 对象父节点（gizmo 所在的节点空间）的世界逆矩阵 */
  _nodeInv(rec) {
    const b = this.getBuilder();
    const node = b.parentNode(rec.o.parent);
    node.updateWorldMatrix(true, false);
    return new THREE.Matrix4().copy(node.matrixWorld).invert();
  }

  /** 面柄（组合模式）= 沿该面法线平移；facet = { ax, sign } */
  _startFaceMove(facet, e) {
    const rec = this.recs[0];
    const proxy = this.proxy;
    const { ax, sign } = facet;
    this._snapshot();
    if (this.onStart) this.onStart(this.recs);
    const [lo, hi] = this._localExtent(rec, ax);
    const axisLocal = new THREE.Vector3().setComponent(ax, 1).applyQuaternion(proxy.quaternion);
    const ext = sign > 0 ? hi : lo;
    const A0 = proxy.position.clone().addScaledVector(axisLocal, ext * proxy.scale.getComponent(ax));
    const inv = this._start[0].inv.clone();
    const { O, D } = this._nodeRay(e, inv);
    this._comboDrag = {
      kind: 'move', rec, ax, axisLocal, A0, inv,
      t0: this._lineParam(O, D, A0, axisLocal),
      pos0: proxy.position.clone(),
    };
  }

  _moveComboMove(e, d) {
    const { O, D } = this._nodeRay(e, d.inv);
    const t = this._lineParam(O, D, d.A0, d.axisLocal);
    if (t === null) return;
    if (d.t0 === null) { d.t0 = t; return; }   // 起手视线与轴平行，用第一帧补基准
    let dl = t - d.t0;
    if (this.snap) {
      const sn = Math.max(0.01, EDITOR.snapMove);
      dl = Math.round(dl / sn) * sn;
    }
    const p = d.pos0.clone().addScaledVector(d.axisLocal, dl);
    d.rec.o.position = [round(p.x), round(p.y), round(p.z)];
    this.proxy.position.copy(p);
    const b = this.getBuilder();
    if (b) b.syncTransform(d.rec);
    this._updateFaceHandles();
    this._updateComboHandles();
    if (this.onLive) this.onLive(this.recs, 'translate');
  }

  /** 角点柄 = 三轴独立、对角锚定的自由缩放（拖某个角时对角那个角固定不动） */
  _startCornerDrag(h) {
    const rec = this.recs[0];
    const proxy = this.proxy;
    const { sx, sy, sz } = h.userData.corner;
    const sgn = [sx, sy, sz];
    this._snapshot();
    if (this.onStart) this.onStart(this.recs);
    const axes = [0, 1, 2].map((ax) => new THREE.Vector3().setComponent(ax, 1).applyQuaternion(proxy.quaternion));
    const ext = [0, 1, 2].map((ax) => this._localExtent(rec, ax));
    const s0 = [proxy.scale.x, proxy.scale.y, proxy.scale.z];
    // 对角（固定不动）那个角的局部坐标
    const anchorExt = [0, 1, 2].map((ax) => ext[ax][sgn[ax] > 0 ? 0 : 1]);
    const anchor = proxy.position.clone();
    for (let ax = 0; ax < 3; ax++) anchor.addScaledVector(axes[ax], anchorExt[ax] * s0[ax]);
    this._comboDrag = {
      kind: 'corner', rec, sgn, axes, anchor, anchorExt, s0,
      span: [0, 1, 2].map((ax) => Math.abs(ext[ax][1] - ext[ax][0]) || 1),
      inv: this._start[0].inv.clone(),
    };
  }

  _moveComboCorner(e, d) {
    const { O, D } = this._nodeRay(e, d.inv);
    const sNew = d.s0.slice();
    for (let ax = 0; ax < 3; ax++) {
      const t = this._lineParam(O, D, d.anchor, d.axes[ax]);
      if (t === null) continue;
      let s = t / (d.sgn[ax] * d.span[ax]);
      if (this.snap) {
        const sn = Math.max(0.01, EDITOR.snapScale);
        s = Math.round(s / sn) * sn;
      }
      sNew[ax] = Math.max(0.02, s);
    }
    // 锚点固定 → 中心 = 锚点 − Σ(轴 i × 锚点局部坐标 × 新缩放 i)
    const center = d.anchor.clone();
    for (let ax = 0; ax < 3; ax++) center.addScaledVector(d.axes[ax], -d.anchorExt[ax] * sNew[ax]);
    const o = d.rec.o;
    o.scale = [round(sNew[0]), round(sNew[1]), round(sNew[2])];
    o.position = [round(center.x), round(center.y), round(center.z)];
    this.proxy.scale.set(sNew[0], sNew[1], sNew[2]);
    this.proxy.position.copy(center);
    const b = this.getBuilder();
    if (b) b.syncTransform(d.rec);
    this._updateFaceHandles();
    this._updateComboHandles();
    if (this.onLive) this.onLive(this.recs, 'scale');
  }

  /** 圆环柄 = 绕对象中心、以该环轴为轴旋转 */
  _startRingDrag(h, e) {
    const rec = this.recs[0];
    const proxy = this.proxy;
    const ax = h.userData.ring.ax;
    this._snapshot();
    if (this.onStart) this.onStart(this.recs);
    const st = this._start[0];
    const localAxis = new THREE.Vector3().setComponent(ax, 1);
    // 环轴（节点空间）：世界系取世界轴，局部系取对象自身轴
    const n = this.space === 'local'
      ? localAxis.clone().applyQuaternion(proxy.quaternion)
      : localAxis.clone().applyQuaternion(st.pqInv);
    const center = proxy.position.clone();
    const inv = st.inv.clone();
    const P0 = this._planePoint(e, inv, center, n);
    this._comboDrag = {
      kind: 'ring', rec, localAxis, n, center, inv,
      q0: proxy.quaternion.clone(),
      ref: P0 ? P0.sub(center) : null,
    };
  }

  _moveComboRing(e, d) {
    const P = this._planePoint(e, d.inv, d.center, d.n);
    if (!P) return;
    const v = P.sub(d.center);
    if (v.lengthSq() < 1e-8) return;
    if (!d.ref) { d.ref = v.clone(); return; }
    const cross = new THREE.Vector3().crossVectors(d.ref, v);
    let delta = Math.atan2(cross.dot(d.n), d.ref.dot(v));
    if (!Number.isFinite(delta)) return;
    if (this.snap) {
      const sn = deg2rad(Math.max(0.1, EDITOR.snapRotate));
      delta = Math.round(delta / sn) * sn;
    }
    const dq = new THREE.Quaternion().setFromAxisAngle(d.localAxis, delta);
    const q = this.space === 'local' ? d.q0.clone().multiply(dq) : dq.clone().multiply(d.q0);
    const o = d.rec.o;
    this.proxy.quaternion.copy(q);
    if (Array.isArray(o.rotation)) {
      const eu = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      o.rotation = [round(rad2deg(eu.x)), round(rad2deg(eu.y)), round(rad2deg(eu.z))];
    }
    const b = this.getBuilder();
    if (b) b.syncTransform(d.rec);
    this._updateFaceHandles();
    this._updateComboHandles();
    if (this.onLive) this.onLive(this.recs, 'rotate');
  }

  _moveComboDrag(e) {
    const d = this._comboDrag;
    if (!d) return;
    if (d.kind === 'move') this._moveComboMove(e, d);
    else if (d.kind === 'corner') this._moveComboCorner(e, d);
    else if (d.kind === 'ring') this._moveComboRing(e, d);
  }

  _endComboDrag() {
    if (!this._comboDrag) return;
    this._comboDrag = null;
    if (this.onEnd) this.onEnd(this.recs);
  }

  /** 摘掉 TransformControls 自带的 canvas 绑定（拖拽完全由 _bindPointer 驱动） */
  _unbindTC() {
    const tc = this.tc;
    const d = tc && tc.domElement;
    if (!d) return;
    const pairs = [
      ['pointerdown', tc._onPointerDown],
      ['pointermove', tc._onPointerHover],
      ['pointerup', tc._onPointerUp],
    ];
    for (const [type, fn] of pairs) if (fn) d.removeEventListener(type, fn);
  }

  /* ============================================================
     指针输入：gizmo 自己驱动 TransformControls
     ------------------------------------------------------------
     three 的 TransformControls 在编辑器里有两个坑，会让 gizmo 完全拖不动：
     1) getPointer() 只要看到 document.pointerLockElement 存在，就无视事件坐标
        直接返回屏幕中心 —— 光标被锁定后射线固定打在屏幕正中，拖动毫无反应；
     2) onPointerDown / onPointerUp 会对事件调用 setPointerCapture /
        releasePointerCapture —— 编辑器里锁定期间事件由 infinite-drag 合成重发，
        合成事件里的指针 id 不是浏览器的“活动指针”，这两次调用会抛
        InvalidStateError / NotFoundError，在控制台刷红字。
     所以彻底不依赖它的 DOM 绑定：那三个监听在构造函数里直接摘掉（_unbindTC），
     自己监听指针事件、自己维护“虚拟光标”（按下位置 + 累计位移），
     直接调用 tc 的 pointerHover / pointerDown / pointerMove / pointerUp。
     ============================================================ */
  _bindPointer() {
    const d = this.dom;
    if (!d) return;
    this._vc = { x: 0, y: 0 };       // 虚拟光标（视口坐标系，像素）
    this._vcLast = { x: 0, y: 0 };   // 上一个事件的原始坐标（用来判断坐标是否被冻结）

    // 坐标一律由虚拟光标提供：彻底不看 pointerLockElement
    this.tc._getPointer = (e) => this._pointer(e);

    const once = (e) => {
      if (e.__fdGizmo) return false;
      e.__fdGizmo = true;
      return true;
    };
    const inView = (e) => d.contains(e.target) || e.target === document.body;

    this._hDown = (e) => {
      if (!this.tc.enabled || !once(e) || e.button !== 0 || !inView(e)) return;
      // 手柄优先：命中面块 / 圆环 / 角点就直接进入对应拖拽，不交给 TransformControls
      const h = this._hitHandle(e);
      this._hoverBody = false;
      if (h) {
        if (h.userData.ring) { this._startRingDrag(h, e); return; }
        if (h.userData.corner) { this._startCornerDrag(h); return; }
        if (h.userData.face) { this._startFaceDrag(h); return; }
      }
      // 组合模式：柄之外按在物体表面上 = 沿该面法线平移
      if (this._comboActive && this._startSurfaceMove(e)) return;
      // 直接调用 tc 的指针方法绕过了它的每帧更新：_parentScale 等矩阵量必须现刷一次，
      // 否则（挂上代理后还没渲染过一帧就按下）它是 (0,0,0)，位移会被除成 NaN
      this.tc.updateMatrixWorld();
      const p = this._pointer(e);
      this.tc.pointerHover(p);
      this.tc.pointerDown(p);          // 只有射线命中轴上才会 dragging = true
    };
    this._hMove = (e) => {
      if (!this.tc.enabled || !once(e)) return;
      if (this._faceDrag) { this._moveFaceDrag(e); return; }
      if (this._comboDrag) { this._moveComboDrag(e); return; }
      const p = this._pointer(e, -1);
      if (this.tc.dragging) this.tc.pointerMove(p);
      else { this.tc.pointerHover(p); this._hoverFaceAt(e); }
    };
    this._hUp = (e) => {
      if (!once(e)) return;
      if (this._faceDrag) { this._endFaceDrag(); return; }
      if (this._comboDrag) { this._endComboDrag(); return; }
      if (!this.tc.dragging) return;
      this.tc.pointerUp(this._pointer(e, 0));
    };

    // 视口内正常收到；指针被锁定 / 移出视口时事件可能只到 window（同一事件用标记去重）
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      const h = ev === 'pointerdown' ? this._hDown : ev === 'pointermove' ? this._hMove : this._hUp;
      d.addEventListener(ev, h);
      window.addEventListener(ev, h, true);
    }
  }

  /** 虚拟光标 → 归一化设备坐标（pointer.button 由调用方指定） */
  _pointer(e, button) {
    const c = this._cursor(e);
    const r = this.dom.getBoundingClientRect();
    const w = r.width || 1, h = r.height || 1;
    return {
      x: (c.x - r.left) / w * 2 - 1,
      y: -((c.y - r.top) / h) * 2 + 1,
      button: button === undefined ? (e.button || 0) : button,
    };
  }

  /** 更新虚拟光标：坐标变了就用坐标，坐标没变（被冻结）就按位移增量累加 */
  _cursor(e) {
    if (e.__fdVC) return this._vc;
    e.__fdVC = true;
    const cx = Number.isFinite(e.clientX) ? e.clientX : this._vc.x;
    const cy = Number.isFinite(e.clientY) ? e.clientY : this._vc.y;
    if (cx === this._vcLast.x && cy === this._vcLast.y) {
      this._vc.x += e.movementX || 0;
      this._vc.y += e.movementY || 0;
    } else {
      this._vc.x = cx;
      this._vc.y = cy;
      this._vcLast.x = cx;
      this._vcLast.y = cy;
    }
    return this._vc;
  }

  /* ---------- 选择 ---------- */
  attach(recs) {
    this.recs = (recs || []).filter((r) => r && r.o);
    if (!this.recs.length) { this.detach(); return; }
    const b = this.getBuilder();
    if (!b) { this.detach(); return; }

    if (this.recs.length === 1) {
      const rec = this.recs[0];
      const node = b.parentNode(rec.o.parent);
      if (this.proxy.parent !== node) node.add(this.proxy);
      this._syncProxyToData(rec);
    } else {
      if (this.proxy.parent !== b.root) b.root.add(this.proxy);
      const c = new THREE.Vector3();
      for (const rec of this.recs) c.add(new THREE.Vector3(...worldPosition(this.getLevel(), rec.o)));
      c.multiplyScalar(1 / this.recs.length);
      this.proxy.position.copy(c);
      this.proxy.quaternion.identity();
      this.proxy.scale.set(1, 1, 1);
    }
    this._refreshGizmo();
  }

  detach() {
    this.tc.detach();
    this.tc.visible = false;
    this.faceGroup.visible = false;
    this.ringGroup.visible = false;
    this.cornerGroup.visible = false;
    this._hoverFace = null;
    this._hoverBody = false;
    this.recs = [];
  }

  setMode(mode) {
    if (mode === 'select') { this.mode = 'select'; this.detach(); return; }
    this.mode = mode || 'translate';
    // 「组合」不是 TransformControls 的模式：多选 / 不支持的对象的兜底走平移
    this.tc.setMode(this.mode === 'combo' ? 'translate' : this.mode);
    if (!this.recs.length) {
      this.tc.visible = false;
      this.faceGroup.visible = false;
      this.ringGroup.visible = false;
      this.cornerGroup.visible = false;
      return;
    }
    this._refreshGizmo();
  }

  setSpace(space) {
    this.space = space === 'local' ? 'local' : 'world';
    this.tc.setSpace(this.space);
    // 组合模式的圆环朝向跟着坐标系走（局部系 = 对象自身三轴）
    if (this._comboActive) this._updateComboHandles();
  }

  setSnap(on) {
    this.snap = !!on;
    this.tc.setTranslationSnap(this.snap ? EDITOR.snapMove : null);
    this.tc.setRotationSnap(this.snap ? deg2rad(EDITOR.snapRotate) : null);
    this.tc.setScaleSnap(this.snap ? EDITOR.snapScale : null);
  }

  get active() { return this.recs.length > 0; }
  get dragging() { return !!this.tc.dragging || !!this._faceDrag || !!this._comboDrag; }
  /** 光标是否停在六面缩放柄上（编辑器据此避免在按柄时启动相机 / 框选） */
  get hoverFace() { return !!this._hoverFace || !!this._hoverBody; }

  /** 外部改动后同步代理位置 */
  update() {
    if (!this.recs.length) {
      this.faceGroup.visible = false;
      this.ringGroup.visible = false;
      this.cornerGroup.visible = false;
      return;
    }
    if (this.tc.dragging || this._faceDrag || this._comboDrag) return;
    if (this.recs.length === 1) this._syncProxyToData(this.recs[0]);
    this._updateFaceHandles();
    this._updateComboHandles();
  }

  _syncProxyToData(rec) {
    const o = rec.o;
    // 路径型对象（滑索 / 折曲线 / 管道）：几何是绝对节点坐标，position 平移、
    // rotation / scale 绕路径中心 → 把 gizmo 放到「路径中心 + position」上，变换枢轴才对得上
    if (PATH_TYPES.has(rec.type) && rec.pathCenter) {
      const p = o.position || [0, 0, 0];
      this.proxy.position.set(
        rec.pathCenter.x + (Number(p[0]) || 0),
        rec.pathCenter.y + (Number(p[1]) || 0),
        rec.pathCenter.z + (Number(p[2]) || 0));
      if (Array.isArray(o.rotation)) this.proxy.rotation.set(deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2]));
      else this.proxy.rotation.set(0, 0, 0);
      if (Array.isArray(o.scale)) this.proxy.scale.set(Math.max(0.02, o.scale[0]), Math.max(0.02, o.scale[1]), Math.max(0.02, o.scale[2]));
      else this.proxy.scale.set(1, 1, 1);
      return;
    }
    if (Array.isArray(o.position)) this.proxy.position.set(o.position[0], o.position[1], o.position[2]);
    if (Array.isArray(o.rotation)) this.proxy.rotation.set(deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2]));
    if (Array.isArray(o.scale)) this.proxy.scale.set(
      Math.max(0.02, o.scale[0]), Math.max(0.02, o.scale[1]), Math.max(0.02, o.scale[2])
    );
  }

  /* ---------- 拖动 ---------- */
  _snapshot() {
    const b = this.getBuilder();
    const lv = this.getLevel();
    this._proxyStart = {
      pos: this.proxy.position.clone(),
      quat: this.proxy.quaternion.clone(),
      scale: this.proxy.scale.clone(),
    };
    this._start = this.recs.map((rec) => {
      const node = b.parentNode(rec.o.parent);
      node.updateWorldMatrix(true, false);
      const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
      const pq = new THREE.Quaternion();
      node.getWorldQuaternion(pq);
      const lq = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        deg2rad(rec.o.rotation ? rec.o.rotation[0] : 0),
        deg2rad(rec.o.rotation ? rec.o.rotation[1] : 0),
        deg2rad(rec.o.rotation ? rec.o.rotation[2] : 0), 'XYZ'));
      const wp = new THREE.Vector3(...worldPosition(lv, rec.o));
      return {
        rec,
        position: Array.isArray(rec.o.position) ? rec.o.position.slice() : null,
        rotation: Array.isArray(rec.o.rotation) ? rec.o.rotation.slice() : null,
        scale: Array.isArray(rec.o.scale) ? rec.o.scale.slice() : null,
        inv,
        pqInv: pq.clone().invert(),
        wp,
        wq: pq.clone().multiply(lq),
      };
    });
  }

  _apply() {
    const b = this.getBuilder();
    if (!b || !this.recs.length) return;
    if (this.recs.length === 1) {
      const rec = this.recs[0];
      const o = rec.o;
      const p = this.proxy;
      const st = this._start && this._start[0];
      // 路径型对象：几何是绝对节点坐标，gizmo 站在「路径中心 + position」上，
      // 平移只改 position 的增量（不改节点），旋转 / 缩放只改自身变换
      if (st && PATH_TYPES.has(rec.type)) {
        if (this.tc.mode === 'translate') {
          if (st.position) {
            const d = p.position.clone().sub(this._proxyStart.pos);
            o.position = [round(st.position[0] + d.x), round(st.position[1] + d.y), round(st.position[2] + d.z)];
          }
        } else {
          if (Array.isArray(o.rotation)) o.rotation = [round(rad2deg(p.rotation.x)), round(rad2deg(p.rotation.y)), round(rad2deg(p.rotation.z))];
          if (Array.isArray(o.scale)) o.scale = [round(Math.max(0.02, p.scale.x)), round(Math.max(0.02, p.scale.y)), round(Math.max(0.02, p.scale.z))];
        }
        for (const r of this.recs) b.syncTransform(r);
        if (this.onLive) this.onLive(this.recs, this.mode);
        return;
      }
      if (Array.isArray(o.position)) o.position = [round(p.position.x), round(p.position.y), round(p.position.z)];
      if (Array.isArray(o.rotation)) o.rotation = [round(rad2deg(p.rotation.x)), round(rad2deg(p.rotation.y)), round(rad2deg(p.rotation.z))];
      if (Array.isArray(o.scale)) o.scale = [round(Math.max(0.02, p.scale.x)), round(Math.max(0.02, p.scale.y)), round(Math.max(0.02, p.scale.z))];
    } else {
      this._applyMulti();
    }
    for (const rec of this.recs) b.syncTransform(rec);
    if (this.onLive) this.onLive(this.recs, this.mode);
  }

  _applyMulti() {
    const p = this.proxy;
    const s0 = this._proxyStart;
    if (!s0) return;
    const mode = this.tc.mode;
    const dPos = p.position.clone().sub(s0.pos);
    const dQuat = p.quaternion.clone().multiply(s0.quat.clone().invert());
    const dScale = new THREE.Vector3(
      s0.scale.x ? p.scale.x / s0.scale.x : 1,
      s0.scale.y ? p.scale.y / s0.scale.y : 1,
      s0.scale.z ? p.scale.z / s0.scale.z : 1
    );
    const pivot = s0.pos.clone();
    for (const s of this._start) {
      const o = s.rec.o;
      if (mode === 'translate') {
        // 路径型对象的几何是绝对节点坐标，整体平移只改 o.position（不改节点）
        this._setLocalPos(s, s.wp.clone().add(dPos));
      } else if (mode === 'rotate') {
        const wp = s.wp.clone().sub(pivot).applyQuaternion(dQuat).add(pivot).add(dPos);
        this._setLocalPos(s, wp);
        if (s.rotation) {
          const lq = s.pqInv.clone().multiply(dQuat.clone().multiply(s.wq));
          const e = new THREE.Euler().setFromQuaternion(lq, 'XYZ');
          o.rotation = [round(rad2deg(e.x)), round(rad2deg(e.y)), round(rad2deg(e.z))];
        }
      } else if (mode === 'scale') {
        if (s.scale) {
          o.scale = [
            round(Math.max(0.02, s.scale[0] * dScale.x)),
            round(Math.max(0.02, s.scale[1] * dScale.y)),
            round(Math.max(0.02, s.scale[2] * dScale.z)),
          ];
        }
        const wp = s.wp.clone().sub(pivot).multiply(dScale).add(pivot).add(dPos);
        this._setLocalPos(s, wp);
      }
    }
  }

  _setLocalPos(s, worldVec) {
    if (!s.position) return;
    const v = worldVec.clone().applyMatrix4(s.inv);
    s.rec.o.position = [round(v.x), round(v.y), round(v.z)];
  }

  dispose() {
    const d = this.dom;
    if (d && this._hDown) {
      for (const [ev, h] of [
        ['pointerdown', this._hDown], ['pointermove', this._hMove],
        ['pointerup', this._hUp], ['pointercancel', this._hUp],
      ]) {
        d.removeEventListener(ev, h);
        window.removeEventListener(ev, h, true);
      }
      this._hDown = this._hMove = this._hUp = null;
    }
    this.tc.detach();
    this.tc.dispose();
    if (this.tc.parent) this.tc.parent.remove(this.tc);
    if (this.proxy.parent) this.proxy.parent.remove(this.proxy);
    if (this.faceGroup) {
      for (const h of this.faceHandles) h.material.dispose();
      if (this.faceHandles[0]) this.faceHandles[0].geometry.dispose();
      if (this.faceGroup.parent) this.faceGroup.parent.remove(this.faceGroup);
      this.faceHandles = [];
      this.faceGroup = null;
    }
    if (this.ringGroup) {
      for (const r of this.ringHandles) r.material.dispose();
      if (this._ringGeo) this._ringGeo.dispose();
      if (this.ringGroup.parent) this.ringGroup.parent.remove(this.ringGroup);
      this.ringHandles = [];
      this.ringGroup = null;
      this._ringGeo = null;
    }
    if (this.cornerGroup) {
      for (const c of this.cornerHandles) c.material.dispose();
      if (this._cornerGeo) this._cornerGeo.dispose();
      if (this.cornerGroup.parent) this.cornerGroup.parent.remove(this.cornerGroup);
      this.cornerHandles = [];
      this.cornerGroup = null;
      this._cornerGeo = null;
    }
    this._faceDrag = null;
    this._comboDrag = null;
  }
}

export function selectionWorldBox(level, recs) {
  const box = new THREE.Box3();
  for (const rec of recs) {
    const o = getObject(level, rec.id);
    if (!o) continue;
    const p = worldPosition(level, o);
    const s = o.scale || [1, 1, 1];
    box.expandByPoint(new THREE.Vector3(p[0] - Math.abs(s[0]) / 2, p[1] - Math.abs(s[1]) / 2, p[2] - Math.abs(s[2]) / 2));
    box.expandByPoint(new THREE.Vector3(p[0] + Math.abs(s[0]) / 2, p[1] + Math.abs(s[1]) / 2, p[2] + Math.abs(s[2]) / 2));
  }
  return box;
}