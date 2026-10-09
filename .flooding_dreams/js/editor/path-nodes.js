/* ============================================================
   路径对象逐节点 3D 编辑（滑索 / 折曲线 / 管道 / 传送门轮廓 共用）
   - 选中路径对象后，每个节点上出现可拖拽手柄（3D 组件）
   - 节点球：首节点绿、末节点红、中间黄
   - 每个节点带一对贝塞尔手柄（小球 + 牵引线）：拖拽 = 调整曲线弧度
       · 默认两侧反向联动（拖一侧，另一侧对称跟随）
       · Alt + 拖 = 只动这一侧（不联动）
       · 直线段两端的手柄自动隐藏（该段忽略手柄）
   - 段中点（八面体）：拖拽 = 在该段插入新节点；Alt+点 = 切换直线/曲线
   - Alt+点节点球 = 删除该节点（节点数 > 2 时）
   - 传送门轮廓是**闭合环**：所有节点同色，段数 = 节点数（含末→首那一段），
     节点坐标是归一化的 [-0.5, 0.5]²；手柄容器反向缩放后球体在非等比缩放下仍保持圆形
   - 拖拽：默认沿「相机平面」自由移动；按住 Shift 锁定高度（水平面）
   - 拖动中实时重建几何；松手提交撤销点
   - 「路径来源 = 引用折曲线对象」时隐藏手柄（路径由被引用对象决定）
   ============================================================ */
import * as THREE from 'three';
import { EDITOR } from '../config.js';
import { round, clamp } from '../core/util.js';
import { PATH_TYPES, CURVE_NODE_TYPES, usesPathRef, resolveHandles, toVec3List } from '../world/paths.js';
import { portalResolvedHandles } from '../world/portal.js';

const NODE_START = '#7fffb0';
const NODE_END = '#ff9a9a';
const NODE_MID = '#ffd86b';
const NODE_ON = '#7fe3ff';
const NODE_PORTAL = '#8fe3ff';     // 传送门轮廓：闭合环没有首末之分
const SEG_MID = '#7fe3ff';
const H_OUT = '#7fe3ff';
const H_IN = '#ffb27f';
const H_ON = '#ffffff';

const HINT = '拖动节点移动 · 拖手柄调贝塞尔曲线 · 拖中点插入节点 · Alt+点节点删除 · ' +
  'Alt+点中点切换直线/曲线 · Alt+拖手柄单独调整 · Shift 锁高度';
const HINT_PORTAL = '拖动节点改变轮廓 · 拖手柄调贝塞尔曲线 · 拖中点插入节点 · ' +
  'Alt+点节点删除 · Alt+点中点切换直线/曲线 · Alt+拖手柄单独调整';

export class PathNodeEditor {
  constructor(ed) {
    this.ed = ed;
    this.group = null;      // 手柄容器（挂在对象的父级节点上）
    this.rec = null;        // 当前显示手柄的路径记录
    this.portal = false;    // 当前记录是否传送门（闭合环轮廓）
    this.nodes = [];        // THREE.Mesh[]（下标 = 节点序号）
    this.mids = [];         // THREE.Mesh[]（下标 = 段序号，第 i 段的中点）
    this.hIn = [];          // THREE.Mesh[]（下标 = 节点序号，入手柄球）
    this.hOut = [];         // THREE.Mesh[]（下标 = 节点序号，出手柄球）
    this.lines = [];        // [{ geo, line, side }]（下标 = 2*i + (in?0:1)）
    this._all = [];         // 供射线检测的合并列表
    this.drag = null;
    this._geo = new THREE.SphereGeometry(0.85, 14, 10);
    this._geoMid = new THREE.OctahedronGeometry(0.6);
    this._geoH = new THREE.SphereGeometry(0.5, 10, 8);
    this._matStart = new THREE.MeshBasicMaterial({ color: NODE_START, depthTest: false });
    this._matEnd = new THREE.MeshBasicMaterial({ color: NODE_END, depthTest: false });
    this._matMid = new THREE.MeshBasicMaterial({ color: NODE_MID, depthTest: false });
    this._matPortal = new THREE.MeshBasicMaterial({ color: NODE_PORTAL, depthTest: false });
    this._matOn = new THREE.MeshBasicMaterial({ color: NODE_ON, depthTest: false });
    this._matSeg = new THREE.MeshBasicMaterial({ color: SEG_MID, depthTest: false, transparent: true, opacity: 0.8 });
    this._matHIn = new THREE.MeshBasicMaterial({ color: H_IN, depthTest: false });
    this._matHOut = new THREE.MeshBasicMaterial({ color: H_OUT, depthTest: false });
    this._matHOn = new THREE.MeshBasicMaterial({ color: H_ON, depthTest: false });
    this._matLIn = new THREE.LineBasicMaterial({ color: H_IN, depthTest: false, transparent: true, opacity: 0.55 });
    this._matLOut = new THREE.LineBasicMaterial({ color: H_OUT, depthTest: false, transparent: true, opacity: 0.55 });
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane();
    this._tmp = new THREE.Vector3();
    this._lastPreview = 0;
    this._hintRef = null;   // 已提示过「路径来自引用折曲线」的对象 id
  }

  get dragging() { return !!this.drag; }

  /* ============================================================
     显示 / 隐藏手柄
     ============================================================ */
  /** 选择或数据变化后调用 */
  sync() {
    const ed = this.ed;
    const recs = ed.selectedRecs ? ed.selectedRecs() : [];
    const r0 = recs.length === 1 ? recs[0] : null;
    // 引用模式：路径完全由被引用的折曲线决定，这里没有可拖的节点
    if (r0 && PATH_TYPES.has(r0.type) && usesPathRef(r0.o)) {
      this.hide();
      if (this._hintRef !== r0.id) {
        this._hintRef = r0.id;
        ed.showHint('路径来自引用的折曲线：节点请到那条折曲线上编辑；'
          + '把「路径来源」改成「自身节点」即可在此直接拖拽（会保持当前形状）', 6000);
      }
      return;
    }
    if (this._hintRef) this._hintRef = null;
    const refPath = r0 && PATH_TYPES.has(r0.type) && usesPathRef(r0.o);
    const rec = (r0 && CURVE_NODE_TYPES.has(r0.type) && !refPath
      && Array.isArray(r0.o.points) && r0.o.points.length) ? r0 : null;
    if (!rec || !ed.builder || this.drag) { if (!this.drag) this.hide(); return; }
    // 手柄挂在对象网格上：节点坐标是对象局部坐标，网格自带 position / rotation / scale 变换，
    // 挂在网格下能让手柄随对象的整体变换一起走，拖拽换算也会自动带上该变换
    const anchor = rec.mesh || ed.builder.parentNode(rec.o.parent);
    const n = rec.o.points.length;
    // 闭合环（传送门）：段数 = 节点数（含末→首那一段）；开放路径：段数 = 节点数 - 1
    const midCount = rec.type === 'portal' ? n : Math.max(0, n - 1);
    const need = this.nodes.length !== n || this.mids.length !== midCount;
    if (this.rec !== rec || !this.group || this.group.parent !== anchor || need) {
      this.hide();
      this.rec = rec;
      this.group = new THREE.Group();
      this.group.name = 'path-node-handles';
      anchor.add(this.group);
      this._build();
    } else {
      this._place();
    }
  }

  hide() {
    this._disposeLines();
    if (this.group) {
      if (this.group.parent) this.group.parent.remove(this.group);
      this.group = null;
    }
    this.nodes = [];
    this.mids = [];
    this.hIn = [];
    this.hOut = [];
    this._all = [];
    this.rec = null;
    this.drag = null;
  }

  _disposeLines() {
    for (const l of this.lines) { if (l.geo) l.geo.dispose(); }
    this.lines = [];
  }

  _build() {
    this._disposeLines();
    const pts = (this.rec && this.rec.o.points) || [];
    this.portal = !!(this.rec && this.rec.type === 'portal');
    this.nodes = [];
    this.mids = [];
    this.hIn = [];
    this.hOut = [];
    this._syncGroupScale();
    for (let i = 0; i < pts.length; i++) {
      const mat = this.portal ? this._matPortal
        : (i === 0 ? this._matStart : (i === pts.length - 1 ? this._matEnd : this._matMid));
      const m = new THREE.Mesh(this._geo, mat);
      m.renderOrder = 20;
      m.frustumCulled = false;
      m.userData.helper = true;
      m.userData.pathNode = i;
      this.group.add(m);
      this.nodes.push(m);
    }
    // 闭合环：段数 = 节点数（末→首那一段也要一个中点）；开放路径：段数 = 节点数 - 1
    const midCount = this.portal ? pts.length : Math.max(0, pts.length - 1);
    for (let i = 0; i < midCount; i++) {
      const m = new THREE.Mesh(this._geoMid, this._matSeg);
      m.renderOrder = 20;
      m.frustumCulled = false;
      m.userData.helper = true;
      m.userData.pathMid = i;
      this.group.add(m);
      this.mids.push(m);
    }
    for (let i = 0; i < pts.length; i++) {
      this.hIn.push(this._addHandle(i, 'in'));
      this.hOut.push(this._addHandle(i, 'out'));
    }
    this._all = this.nodes.concat(this.mids, this.hIn, this.hOut);
    this._place();
  }

  /** 传送门的节点坐标是归一化轮廓坐标（[-0.5,0.5]²），而网格自带非等比 scale，
      手柄如果直接挂上去会被一起拉扁、放大。把容器反向缩放成 1/scale 后，
      容器的世界矩阵回到刚体变换：球体恢复正圆，且「容器局部坐标 = 归一化坐标 × scale」，
      拖拽时只需再除回 scale 即得归一化坐标 */
  _syncGroupScale() {
    if (!this.group) return;
    const s = (this.portal && this.rec && this.rec.o.scale) || null;
    if (!s) { this.group.scale.set(1, 1, 1); return; }
    const sx = Number(s[0]) || 1, sy = Number(s[1]) || 1, sz = Number(s[2]) || 1;
    this.group.scale.set(1 / sx, 1 / sy, 1 / sz);
  }

  /** 归一化轮廓坐标 → 手柄容器局部坐标（乘回对象 scale） */
  _toGroup(x, y, z) {
    const s = (this.rec && this.rec.o.scale) || [1, 1, 1];
    const sx = Number(s[0]) || 1, sy = Number(s[1]) || 1, sz = Number(s[2]) || 1;
    return new THREE.Vector3(x * sx, y * sy, z * sz);
  }

  /** 手柄容器局部坐标 → 归一化轮廓坐标（除回对象 scale） */
  _toNorm(v) {
    const s = (this.rec && this.rec.o.scale) || [1, 1, 1];
    const sx = Number(s[0]) || 1, sy = Number(s[1]) || 1, sz = Number(s[2]) || 1;
    return new THREE.Vector3(v.x / sx, v.y / sy, v.z / sz);
  }

  /** 建一个手柄球 + 一条「节点 → 手柄」的牵引线 */
  _addHandle(i, side) {
    const m = new THREE.Mesh(this._geoH, side === 'in' ? this._matHIn : this._matHOut);
    m.renderOrder = 22;
    m.frustumCulled = false;
    m.userData.helper = true;
    m.userData.pathHandle = i;
    m.userData.pathSide = side;
    this.group.add(m);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geo, side === 'in' ? this._matLIn : this._matLOut);
    line.renderOrder = 21;
    line.frustumCulled = false;
    line.userData.helper = true;
    this.group.add(line);
    this.lines.push({ geo, line, side });
    return m;
  }

  /** 当前节点的解析后手柄（含自动推导） */
  _handles(i) {
    const o = this.rec && this.rec.o;
    const raw = (o && o.points) || [];
    if (this.portal) return portalResolvedHandles(o)[i] || [[0, 0, 0], [0, 0, 0]];
    const hs = resolveHandles(o && o.handles, toVec3List(raw));
    return hs[i] || [[0, 0, 0], [0, 0, 0]];
  }

  /** 视口里改动了传送门轮廓 → 丢弃矢量文档缓存，下次打开矢量编辑器时按当前轮廓重建 */
  _dropPortalDoc() {
    const o = this.rec && this.rec.o;
    if (o && this.portal && o.shapeDoc) o.shapeDoc = null;
  }

  _place() {
    const rec = this.rec;
    if (!rec) return;
    const raw = rec.o.points || [];
    const n = raw.length;
    const modes = rec.o.segModes || [];
    const portal = rec.type === 'portal';
    // 传送门：容器局部坐标 = 归一化坐标 × scale（见 _syncGroupScale）
    const toGroup = (v) => (portal ? this._toGroup(v.x, v.y, v.z) : v);

    if (portal) {
      // 对象缩放可能在选中期间被改动（编辑器会原地重建网格），这里重算一次容器反向缩放
      this._syncGroupScale();
      const hs = portalResolvedHandles(rec.o);
      for (let i = 0; i < n; i++) {
        const p = raw[i];
        if (!p) continue;
        const gv = toGroup(new THREE.Vector3(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0));
        if (this.nodes[i]) this.nodes[i].position.copy(gv);
        const h = hs[i] || [[0, 0, 0], [0, 0, 0]];
        const pin = toGroup(new THREE.Vector3((Number(p[0]) || 0) + h[0][0], (Number(p[1]) || 0) + h[0][1], (Number(p[2]) || 0) + h[0][2]));
        const pout = toGroup(new THREE.Vector3((Number(p[0]) || 0) + h[1][0], (Number(p[1]) || 0) + h[1][1], (Number(p[2]) || 0) + h[1][2]));
        // 闭合环：第 i 个节点的入手柄属于第 i-1 段、出手柄属于第 i 段（末节点回绕到第 0 段）
        const inUse = (modes[(i - 1 + n) % n] || 'curve') !== 'line';
        const outUse = (modes[i % n] || 'curve') !== 'line';
        const mi = this.hIn[i], mo = this.hOut[i];
        if (mi) { mi.visible = inUse; mi.position.copy(pin); }
        if (mo) { mo.visible = outUse; mo.position.copy(pout); }
        const li = this.lines[2 * i], lo = this.lines[2 * i + 1];
        if (li) { li.line.visible = inUse; this._setLine(li.geo, gv, pin); }
        if (lo) { lo.line.visible = outUse; this._setLine(lo.geo, gv, pout); }
      }
      for (let i = 0; i < this.mids.length; i++) {
        const a = raw[i], b = raw[(i + 1) % n];
        if (!a || !b) continue;
        this.mids[i].position.copy(toGroup(new THREE.Vector3(
          (Number(a[0]) + Number(b[0])) / 2,
          (Number(a[1]) + Number(b[1])) / 2,
          (Number(a[2]) + Number(b[2])) / 2,
        )));
      }
      return;
    }

    const vecs = toVec3List(raw);
    const hs = resolveHandles(rec.o.handles, vecs);

    for (let i = 0; i < this.nodes.length; i++) {
      if (vecs[i]) this.nodes[i].position.copy(vecs[i]);
    }
    for (let i = 0; i < this.mids.length; i++) {
      const a = vecs[i], b = vecs[i + 1];
      if (a && b) this.mids[i].position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    }
    for (let i = 0; i < n; i++) {
      const v = vecs[i];
      if (!v) continue;
      const inUse = i > 0 && (modes[i - 1] || 'curve') !== 'line';
      const outUse = i < n - 1 && (modes[i] || 'curve') !== 'line';
      const h = hs[i] || [[0, 0, 0], [0, 0, 0]];
      const pin = v.clone().add(new THREE.Vector3(h[0][0], h[0][1], h[0][2]));
      const pout = v.clone().add(new THREE.Vector3(h[1][0], h[1][1], h[1][2]));

      const mi = this.hIn[i], mo = this.hOut[i];
      if (mi) { mi.visible = inUse; mi.position.copy(pin); }
      if (mo) { mo.visible = outUse; mo.position.copy(pout); }

      const li = this.lines[2 * i], lo = this.lines[2 * i + 1];
      if (li) { li.line.visible = inUse; this._setLine(li.geo, v, pin); }
      if (lo) { lo.line.visible = outUse; this._setLine(lo.geo, v, pout); }
    }
  }

  _setLine(geo, a, b) {
    const pos = geo.attributes.position;
    if (!pos) return;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
  }

  /* ============================================================
     拖拽
     ============================================================ */
  /** 返回 true 表示已接管本次指针按下 */
  beginDrag(e) {
    if (this.drag || !this._all.length || !this.group) return false;
    const vp = this.ed.viewport;
    if (!vp) return false;
    this._ray.setFromCamera(vp.ndc(e.clientX, e.clientY, this._ndc), vp.camera);
    const hit = this._ray.intersectObjects(this._all, false).find((x) => x.object.visible !== false);
    if (!hit) return false;
    const mesh = hit.object;
    const rec = this.rec;
    if (!rec) return false;

    // 段中点
    if (mesh.userData.pathMid !== undefined) {
      const i = mesh.userData.pathMid | 0;
      if (e.altKey) { this._toggleSeg(i); return true; }
      return this._insertAt(i, e);
    }

    // 贝塞尔手柄
    if (mesh.userData.pathHandle !== undefined) {
      const i = mesh.userData.pathHandle | 0;
      const side = mesh.userData.pathSide === 'in' ? 'in' : 'out';
      const ok = this._beginDrag({ kind: 'handle', index: i, side }, mesh, e, null);
      if (ok) mesh.material = this._matHOn;
      return ok;
    }

    // 节点球
    const index = mesh.userData.pathNode | 0;
    if (e.altKey) { this._deleteNode(index); return true; }
    if (!rec.o.points[index]) return false;
    const ok = this._beginDrag({ kind: 'node', index }, mesh, e, null);
    if (ok) mesh.material = this._matOn;
    return true;
  }

  /**
   * 建立拖拽状态
   * @param {{kind:'node'|'handle', index:number, side?:string}} target
   * @param {THREE.Mesh} mesh  被拖的把手（用于高亮与实时跟随）
   * @param {PointerEvent} e
   * @param {*} prevOverride  把插点与拖动合并成一个撤销步
   */
  _beginDrag(target, mesh, e, prevOverride) {
    const vp = this.ed.viewport;
    const rec = this.rec;
    if (!vp || !rec) return false;
    const pts = rec.o.points || [];
    const arr = pts[target.index];
    if (!arr) return false;
    this._ray.setFromCamera(vp.ndc(e.clientX, e.clientY, this._ndc), vp.camera);

    this.group.updateWorldMatrix(true, false);
    const portal = rec.type === 'portal';
    let local = new THREE.Vector3(Number(arr[0]) || 0, Number(arr[1]) || 0, Number(arr[2]) || 0);
    if (target.kind === 'handle') {
      const h = this._handles(target.index);
      const off = target.side === 'in' ? h[0] : h[1];
      local.add(new THREE.Vector3(off[0], off[1], off[2]));
    }
    // 传送门：数据是归一化坐标，容器局部坐标要先乘回对象 scale
    if (portal) local = this._toGroup(local.x, local.y, local.z);
    const wp = this._tmp.copy(local).applyMatrix4(this.group.matrixWorld).clone();

    const normal = e.shiftKey
      ? new THREE.Vector3(0, 1, 0)                                      // 锁高度：水平面移动（传送门轮廓用不到）
      : vp.camera.getWorldDirection(new THREE.Vector3()).negate();      // 默认：与相机平行的平面
    this._plane.setFromNormalAndCoplanarPoint(normal, wp);
    const hitP = new THREE.Vector3();
    if (!this._ray.ray.intersectPlane(this._plane, hitP)) return false;

    this.drag = {
      rec,
      portal,
      kind: target.kind,
      index: target.index,
      side: target.side || null,
      free: !!e.altKey,          // 手柄：只动这一侧，不联动
      mesh,
      plane: this._plane.clone(),
      offset: hitP.clone().sub(wp),
      invParent: new THREE.Matrix4().copy(this.group.matrixWorld).invert(),
      prev: prevOverride || this.ed.snap(),
      moved: false,
    };
    this.ed.showHint(portal ? HINT_PORTAL : HINT, 4200);
    return true;
  }

  moveDrag(e) {
    const d = this.drag;
    if (!d) return;
    const vp = this.ed.viewport;
    if (!vp) return;
    this._ray.setFromCamera(vp.ndc(e.clientX, e.clientY, this._ndc), vp.camera);
    const p = new THREE.Vector3();
    if (!this._ray.ray.intersectPlane(d.plane, p)) return;
    p.sub(d.offset);
    if (this.ed.snapOn && !d.portal) {
      const s = Math.max(0.05, Number(EDITOR.snapMove) || 1);
      p.set(Math.round(p.x / s) * s, Math.round(p.y / s) * s, Math.round(p.z / s) * s);
    }
    const local = p.applyMatrix4(d.invParent);
    if (d.kind === 'node') {
      const arr = d.rec.o.points[d.index];
      if (d.portal) {
        // 归一化轮廓坐标：限制在 [-0.5, 0.5]² 内，保证轮廓不越出平面
        const nrm = this._toNorm(local);
        if (arr) {
          arr[0] = round(clamp(nrm.x, -0.5, 0.5), 4);
          arr[1] = round(clamp(nrm.y, -0.5, 0.5), 4);
          arr[2] = 0;
        }
      } else if (arr) {
        arr[0] = round(local.x); arr[1] = round(local.y); arr[2] = round(local.z);
      }
      d.mesh.position.copy(local);
    } else {
      this._writeHandle(d, local);
    }
    d.moved = true;
    this._place();
    this._preview();
  }

  /** 手柄拖拽落库：写入本节点的显式手柄（默认两侧反向联动） */
  _writeHandle(d, local) {
    const o = d.rec.o;
    const pts = o.points || [];
    const arr = pts[d.index];
    if (!arr) return;
    // 传送门：容器局部坐标要除回对象 scale，才是归一化手柄偏移
    const p = d.portal ? this._toNorm(local) : local;
    const off = p.clone().sub(new THREE.Vector3(Number(arr[0]) || 0, Number(arr[1]) || 0, Number(arr[2]) || 0));
    const v = [round(off.x), round(off.y), round(off.z)];

    if (!Array.isArray(o.handles)) o.handles = [];
    while (o.handles.length < pts.length) o.handles.push(null);
    let slot = o.handles[d.index];
    if (!Array.isArray(slot) || !Array.isArray(slot[0]) || !Array.isArray(slot[1])) {
      const h = this._handles(d.index);
      slot = [h[0].slice(), h[1].slice()];
    }
    const inV = slot[0].slice();
    const outV = slot[1].slice();
    const tgt = d.side === 'in' ? inV : outV;
    tgt[0] = v[0]; tgt[1] = v[1]; tgt[2] = v[2];
    if (!d.free) {
      const opp = d.side === 'in' ? outV : inV;
      opp[0] = -v[0]; opp[1] = -v[1]; opp[2] = -v[2];
    }
    o.handles[d.index] = [inV, outV];
  }

  /** 拖动中重建几何（节流，避免每帧重建） */
  _preview() {
    const d = this.drag;
    if (!d) return;
    const now = performance.now();
    if (now - this._lastPreview < 40) return;
    this._lastPreview = now;
    const b = this.ed.builder;
    if (!b) return;
    try {
      const fresh = b.rebuild(d.rec);
      if (fresh) {
        this.rec = fresh; d.rec = fresh;
        // 重建会销毁旧网格，手柄容器挂在网格下会跟着被移除 → 重新挂到新网格上
        if (this.group && fresh.mesh && this.group.parent !== fresh.mesh) fresh.mesh.add(this.group);
      }
    } catch (err) { /* ignore */ }
  }

  endDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this._restoreMat(d);
    if (!d.moved) return;
    this._dropPortalDoc();
    const b = this.ed.builder;
    if (b) {
      try { b.rebuild(d.rec); } catch (err) { /* ignore */ }
    }
    this.ed.record(d.kind === 'handle' ? '调整贝塞尔手柄' : '编辑路径节点', d.prev);
    this.ed.refreshPropsSoft();
    this.sync();
  }

  _restoreMat(d) {
    if (!d.mesh) return;
    if (d.kind === 'handle') d.mesh.material = d.side === 'in' ? this._matHIn : this._matHOut;
    else d.mesh.material = this._nodeMat(d.index);
  }

  _nodeMat(index) {
    if (this.portal) return this._matPortal;
    const n = (this.rec && this.rec.o.points) ? this.rec.o.points.length : 0;
    if (index === 0) return this._matStart;
    if (index === n - 1) return this._matEnd;
    return this._matMid;
  }

  /* ============================================================
     段中点：插入节点 / 切换段模式
     ============================================================ */
  _insertAt(i, e) {
    const ed = this.ed;
    const b = ed.builder;
    const rec = this.rec;
    if (!rec || !b) return false;
    const pts = rec.o.points;
    const n = pts.length;
    const portal = rec.type === 'portal';
    const a = pts[i];
    const c = portal ? pts[(i + 1) % n] : pts[i + 1];
    if (!a || !c) return false;
    // 闭合环：末段（末节点 → 首节点）插入时新节点追加在数组末尾
    const at = portal ? ((i + 1) % n === 0 ? n : i + 1) : i + 1;
    const prev = ed.snap();
    const np = [round((Number(a[0]) + Number(c[0])) / 2),
      round((Number(a[1]) + Number(c[1])) / 2), round((Number(a[2]) + Number(c[2])) / 2)];
    pts.splice(at, 0, np);
    const modes = rec.o.segModes || (rec.o.segModes = []);
    // 插入前的段数：开放路径 = 节点数 - 1；闭合环 = 节点数（下标 = 段的起始节点序号）
    const want = portal ? n : n - 1;
    while (modes.length < want) modes.push('curve');
    modes.splice(at, 0, modes[i] || 'curve');
    // 手柄表（若已显式化）同步插一个「自动」条目，保持下标对齐
    const hs = rec.o.handles;
    if (Array.isArray(hs)) hs.splice(Math.min(at, hs.length), 0, null);
    this._dropPortalDoc();

    let fresh = rec;
    try { const f = b.rebuild(rec); if (f) fresh = f; } catch (err) { /* ignore */ }
    this.rec = fresh;
    this._build();
    ed.record('插入路径节点', prev);
    ed.refreshPropsSoft();

    const mesh = this.nodes[at];
    if (!mesh) return true;
    const ok = this._beginDrag({ kind: 'node', index: at }, mesh, e, prev);
    if (ok) mesh.material = this._matOn;
    return true;
  }

  _toggleSeg(i) {
    const ed = this.ed;
    const b = ed.builder;
    const rec = this.rec;
    if (!rec || !b) return;
    const modes = rec.o.segModes || (rec.o.segModes = []);
    // 开放路径：段数 = 节点数 - 1；闭合环：段数 = 节点数
    const want = rec.type === 'portal' ? rec.o.points.length : rec.o.points.length - 1;
    while (modes.length < want) modes.push('curve');
    const prev = ed.snap();
    modes[i] = (modes[i] || 'curve') === 'line' ? 'curve' : 'line';
    this._dropPortalDoc();
    try { b.rebuild(rec); } catch (err) { /* ignore */ }
    ed.record('切换段模式', prev);
    ed.refreshPropsSoft();
    this.sync();
  }

  /* ============================================================
     Alt + 点节点球：删除节点
     ============================================================ */
  _deleteNode(index) {
    const ed = this.ed;
    const b = ed.builder;
    const rec = this.rec;
    if (!rec || !b) return;
    const portal = rec.type === 'portal';
    const pts = rec.o.points;
    const min = portal ? 3 : 2;
    if (pts.length <= min) {
      ed.showHint(portal ? '传送门轮廓至少需要 3 个节点，无法再删除' : '路径至少需要 2 个节点，无法再删除', 2200);
      return;
    }
    const prev = ed.snap();
    pts.splice(index, 1);
    const modes = rec.o.segModes || (rec.o.segModes = []);
    if (modes.length) modes.splice(Math.min(index, modes.length - 1), 1);
    const hs = rec.o.handles;
    if (Array.isArray(hs) && index < hs.length) hs.splice(index, 1);
    this._dropPortalDoc();
    try { b.rebuild(rec); } catch (err) { /* ignore */ }
    ed.record('删除路径节点', prev);
    ed.refreshPropsSoft();
    this.sync();
  }
}