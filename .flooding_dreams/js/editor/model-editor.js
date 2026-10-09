/* ============================================================
   编辑器 · 低模建模模式（性能优先）
   - 单选一个「低模建模体」后启用，元素模式：对象 / 点 / 边 / 面
   - 点、边的拾取走屏幕空间就近判定：不给每个点建拾取网格，低模下比射线更省
   - 面拾取直接对物体射线，用 geometry.userData.triFace 反查面表下标
   - 拖拽选中元素：默认沿相机平面移动，Shift 锁高度；吸附跟随编辑器的吸附开关
   - 雕刻笔刷：推拉 / 平滑 / 压平，按半径衰减；Alt 反向
   - 拓扑：选边倒角、选中点平滑、删除点 / 面
   - 倒角与删除会改顶点数 → 走 builder.rebuild；雕刻与拖动只改坐标 →
     就地改几何，不销毁重建，保证手感
   ============================================================ */
import * as THREE from 'three';
import { EDITOR } from '../config.js';
import { round, clamp } from '../core/util.js';
import { el, clear, toast } from '../ui/dom.js';
import {
  polyVerts, polyFaces, edgeMap, vertexAdjacency, bevelEdges, smoothVerts,
  isFlatEdge, deleteFaces, deleteVerts, polyGeometry, MAX_POLY_FACES,
} from '../world/poly-mesh.js';
import {
  makeField, fieldRasterizeMesh, fieldToMesh, fieldBrushSphere, fieldBrushSmooth,
  fieldBrushOffset, fieldBrushFlatten, meshWorldBox,
} from '../world/sdf-kernel.js';

const VERT_PX = 9;         // 点拾取的屏幕像素半径
const EDGE_PX = 8;         // 边拾取的屏幕像素半径
const STROKE_MS = 24;      // 雕刻落笔的最小间隔（节流，避免每像素都改一遍顶点）
const VOX_MS = 80;         // 体素笔刷的最小间隔（每笔都要重新反提取，比拉点重）

const C_PT = new THREE.Color('#cfd8ff');
const C_PT_SEL = new THREE.Color('#7fe3ff');
const C_PT_HOVER = new THREE.Color('#ffe066');
const C_EDGE = new THREE.Color('#8ea0c8');
const C_EDGE_SEL = new THREE.Color('#7fe3ff');

const ELEMENTS = [
  { v: 'object', l: '对象', t: '整体变换：用常规变换组件移动 / 旋转 / 缩放' },
  { v: 'vert', l: '点', t: '选择 / 拖动顶点' },
  { v: 'edge', l: '边', t: '选择 / 拖动边，可对选中边倒角' },
  { v: 'face', l: '面', t: '选择 / 拖动三角面' },
];

const VOX_RES = [
  { v: '16', l: '低', t: '体素格子最粗：最快、面数最少' },
  { v: '24', l: '中', t: '默认精度，绝大多数情况够用' },
  { v: '36', l: '高', t: '最细，但面数会明显变多（接近建模上限时请下调）' },
];
const HINT_SELECT = '点 / 边 / 面：单击选中 · Shift 加选 · Ctrl 反选 · 拖拽移动（Shift 锁高度）· 空白处拖动可框选';
const HINT_SCULPT = '雕刻：在模型表面按住拖动 · Alt 反向 · 半径 / 强度见左侧面板';
const HINT_VOXEL = '体素地形：在表面按住拖动 · 加料 / 挖除 / 扩张 / 侵蚀 / 平滑 / 压平（Roblox 同款）· Alt 反向 · 松手才提交（可 Ctrl+Z）';
const VOX_MODES = [
  { v: 'add', l: '加料', t: '球体并集：往表面堆料（Roblox Add）。融合越大越软' },
  { v: 'erase', l: '挖除', t: '球体差集：从表面挖掉一块（Roblox Erase）' },
  { v: 'grow', l: '扩张', t: '局部整体向外长：表面鼓起、棱角变胖（Roblox Grow）。Alt 变侵蚀' },
  { v: 'erode', l: '侵蚀', t: '局部整体向内收：地表塌陷、棱角磨圆（Roblox Erode）。Alt 变扩张' },
  { v: 'smooth', l: '平滑', t: '把范围内的场值向邻域平均：抹掉坑洼与硬棱' },
  { v: 'flatten', l: '压平', t: '把范围里的表面熨到笔头所在的平面（Roblox Flatten）' },
];

/** 二维点到线段的距离平方 */
function segDist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  let t = L > 1e-9 ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x1 + dx * t, qy = y1 + dy * t;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

const _a1 = new THREE.Vector3();
const _a2 = new THREE.Vector3();
const _a3 = new THREE.Vector3();
/** 网格在给定变换下的世界空间表面积：体素化前用来反推「面数预算」允许的最小步长 */
function meshWorldArea(verts, faces, matrix) {
  let area = 0;
  for (const fc of faces) {
    const a = verts[fc[0]], b = verts[fc[1]], c = verts[fc[2]];
    if (!a || !b || !c) continue;
    _a1.set(a[0], a[1], a[2]); if (matrix) _a1.applyMatrix4(matrix);
    _a2.set(b[0], b[1], b[2]); if (matrix) _a2.applyMatrix4(matrix);
    _a3.set(c[0], c[1], c[2]); if (matrix) _a3.applyMatrix4(matrix);
    _a2.sub(_a1); _a3.sub(_a1);
    area += 0.5 * _a2.cross(_a3).length();
  }
  return area;
}

export class ModelEditor {
  constructor(ed) {
    this.ed = ed;
    this.active = false;
    this.element = 'object';     // object | vert | edge | face
    this.tool = 'select';        // select | sculpt
    this.sel = new Set();        // 点/面模式存下标，边模式存 "a_b" 键
    this.hover = -1;
    this.rec = null;
    this.group = null;           // 覆盖层容器（挂在对象网格下，自动跟随整体变换）
    this.points = null;
    this.lines = null;
    this.faceMesh = null;
    this.ring = null;
    this.drag = null;
    this.stroke = null;

    this.bevelAmount = 0.08;
    this.brush = { mode: 'push', radius: 0.9, strength: 0.45, dir: 1 };
    this.vox = { mode: 'add', res: 24, blend: 0.35 };
    this._autoRadius = true;    // 用户没手动调过半径前，进入雕刻时按模型尺寸自动配一把
    this._radiusHinted = false; // 「这一笔没碰到顶点」的提示只弹一次
    this._vfield = null;        // 体素笔画期间常驻的场（一次栅格化，多笔刷修改）
    this._vbackup = null;       // 每笔之前的场快照：这一笔会画空 / 超面数上限时用来撤回
    this._vcenter = null;       // 该笔画的烘焙原点（世界坐标）
    this._vbaked = false;       // 本笔画是否已经把对象变换烘进顶点
    this._vtooHeavy = false;    // 面数超限的提示只弹一次

    this._edges = [];
    this._emap = null;
    this._emapFaces = null;
    this._scr = new Float32Array(0);
    this._p = { x: 0, y: 0, z: 0 };

    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane();
    this._tv = new THREE.Vector3();
    this._tv2 = new THREE.Vector3();

    this._matPt = new THREE.PointsMaterial({
      size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true,
    });
    this._matLine = new THREE.LineBasicMaterial({
      vertexColors: true, depthTest: false, transparent: true, opacity: 0.95,
    });
    this._matFace = new THREE.MeshBasicMaterial({
      color: 0x7fe3ff, transparent: true, opacity: 0.4, depthTest: false,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this._matRing = new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true });

    this._hud = document.getElementById('ed-model-hud');
    this._ui = {};
    this._buildHud();
  }

  get dragging() { return !!this.drag || !!this.stroke; }

  /* ============================================================
     开关
     ============================================================ */
  canStart() {
    const recs = this.ed.selectedRecs ? this.ed.selectedRecs() : [];
    return recs.length === 1 && recs[0].type === 'poly' && !!recs[0].mesh ? recs[0] : null;
  }

  toggle() { this.setActive(!this.active); }

  setActive(on) {
    on = !!on;
    if (on === this.active) return this.active;
    if (on) {
      const rec = this.canStart();
      if (!rec) { this.ed.showHint('请先选中一个「低模建模体」，再按 M 进入建模模式', 2800); return false; }
      // 与涂鸦 / 跑酷工具互斥（工具栏位置是共用的）
      if (this.ed.paintEd && this.ed.paintEd.active) this.ed.paintEd.setActive(false);
      if (this.ed.parkour && this.ed.parkour.active) this.ed.parkour.setActive(null);
      this.rec = rec;
      this.sel.clear();
      this.hover = -1;
      this.active = true;
      this._showHud(true);
      this.sync();
      this.ed.showHint(this.tool === 'sculpt' ? HINT_SCULPT : HINT_SELECT, 5200);
    } else {
      this.active = false;
      this._hideOverlay();
      this._showHud(false);
      this.rec = null;
      this.sel.clear();
      this.drag = null;
      this.stroke = null;
      // 退出后把整体变换组件还回去
      const ed = this.ed;
      if (ed.gizmo && ed.mode !== 'select') {
        try { ed.gizmo.attach(ed.selectedRecs()); } catch (e) { /* ignore */ }
      }
    }
    return this.active;
  }

  /**
   * 按模型的世界尺寸自动配一把笔刷半径。
   * 低模的顶点非常稀疏：默认 0.9 的半径放到「4×1×4」的方块上，一笔下去
   * 一个顶点都罩不住，看起来就像雕刻失灵 —— 所以进雕刻时先按尺寸给个够用的值。
   * 体素模式按半径决定场分辨率，所以口径更粗一些（0.3 倍边长）。
   */
  _fitBrushRadius() {
    const rec = this.rec;
    if (!rec || !rec.mesh || !this._autoRadius) return;
    const g = rec.mesh.geometry;
    if (!g || !g.attributes.position) return;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) return;
    rec.mesh.updateWorldMatrix(true, false);
    const sc = new THREE.Vector3();
    rec.mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
    const size = bb.getSize(new THREE.Vector3());
    const maxWorld = Math.max(
      Math.abs(size.x * sc.x), Math.abs(size.y * sc.y), Math.abs(size.z * sc.z));
    if (!(maxWorld > 1e-4)) return;
    const vox = this.tool === 'voxel';
    const lo = vox ? 1 : 0.5, hi = vox ? 40 : 12, k = vox ? 0.3 : 0.6;
    this.brush.radius = Math.round(clamp(maxWorld * k, lo, hi) * 100) / 100;
    if (this._ui.rad) { this._ui.rad.max = String(hi); this._ui.rad.value = String(this.brush.radius); }
    if (this._ui.radNum) this._ui.radNum.textContent = this.brush.radius.toFixed(2);
  }

  /** 元素模式 / 雕刻 / 体素模式下把整体变换组件收起来，避免和元素手柄抢输入 */
  enforceGizmo() {
    const ed = this.ed;
    if (!ed.gizmo) return;
    if (this.active && (this.element !== 'object' || this.tool !== 'select')) {
      try { ed.gizmo.detach(); } catch (e) { /* ignore */ }
    }
  }

  setElement(v) {
    if (!ELEMENTS.some((e) => e.v === v) || this.element === v) return;
    this.element = v;
    this.sel.clear();
    this.hover = -1;
    this._syncHud();
    this.sync();
    this.ed.showHint(v === 'object' ? '对象模式：用常规变换组件整体编辑' : HINT_SELECT, 3600);
  }

  setTool(v) {
    if (!['select', 'sculpt', 'voxel'].includes(v)) return;
    if (this.tool === v) return;
    this.tool = v;
    this.sel.clear();
    if (v !== 'select') this._fitBrushRadius();
    this._syncHud();
    this.sync();
    this.ed.showHint(v === 'voxel' ? HINT_VOXEL : v === 'sculpt' ? HINT_SCULPT : HINT_SELECT, 4600);
  }

  /* ============================================================
     选择变化 / 重建后的同步
     ============================================================ */
  sync() {
    const ed = this.ed;
    if (!this.active) { this._hideOverlay(); return; }
    const recs = ed.selectedRecs ? ed.selectedRecs() : [];
    const rec = (recs.length === 1 && recs[0].type === 'poly' && recs[0].mesh) ? recs[0] : null;
    if (!rec) {
      this.rec = null;
      this.sel.clear();
      this._hideOverlay();
      this._setStat('未选中建模体');
      return;
    }
    if (this.rec !== rec) { this.rec = rec; this.sel.clear(); this.hover = -1; }
    // 笔画进行中不要重配半径：体素每次反提取几何都在变，半径跟着跳会很难用
    if (this.tool !== 'select' && !this.stroke) this._fitBrushRadius();
    this.enforceGizmo();
    if (this.element === 'object' && this.tool === 'select') {
      this._hideOverlay();
      this._setStat();
      return;
    }
    this._buildOverlay();
    this._refresh();
  }

  /* ============================================================
     覆盖层（点 / 边 / 面高亮 / 笔刷环）
     ============================================================ */
  _ensureGroup() {
    const rec = this.rec;
    if (!rec || !rec.mesh) return null;
    if (this.group && this.group.parent === rec.mesh) return this.group;
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    this.group = new THREE.Group();
    this.group.name = 'model-overlay';
    this.group.userData.helper = true;
    rec.mesh.add(this.group);
    this.points = null;
    this.lines = null;
    this.faceMesh = null;
    return this.group;
  }

  _buildOverlay() {
    const g = this._ensureGroup();
    if (!g) return;
    const el0 = this.element;

    // 体素模式：几何每反提取一次就换一套，给几万个点 / 边建拾取缓冲纯属白烧内存 → 只留笔刷环
    if (this.tool === 'voxel') {
      if (this.points) this.points.visible = false;
      if (this.lines) this.lines.visible = false;
      if (this.faceMesh) this.faceMesh.visible = false;
      this._ensureRing(g);
      return;
    }

    const verts = polyVerts(this.rec.o);
    const list = this._edgeList();
    const n = verts.length;

    if (!this.points || this._ptN !== n) {
      if (this.points) { g.remove(this.points); this.points.geometry.dispose(); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      this.points = new THREE.Points(geo, this._matPt);
      this.points.userData.helper = true;
      this.points.frustumCulled = false;
      this.points.renderOrder = 26;
      this.points.raycast = () => {};     // 拾取全部自研，别让射线再算一遍
      g.add(this.points);
      this._ptN = n;
    }
    if (!this.lines || this._lnN !== list.length) {
      if (this.lines) { g.remove(this.lines); this.lines.geometry.dispose(); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(list.length * 6), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(list.length * 6), 3));
      this.lines = new THREE.LineSegments(geo, this._matLine);
      this.lines.userData.helper = true;
      this.lines.frustumCulled = false;
      this.lines.renderOrder = 25;
      this.lines.raycast = () => {};
      g.add(this.lines);
      this._lnN = list.length;
    }
    if (!this.faceMesh) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 3), 3));
      this.faceMesh = new THREE.Mesh(geo, this._matFace);
      this.faceMesh.userData.helper = true;
      this.faceMesh.frustumCulled = false;
      this.faceMesh.renderOrder = 27;
      this.faceMesh.raycast = () => {};
      g.add(this.faceMesh);
    }
    this._ensureRing(g);
    this.points.visible = el0 !== 'face';
    this.lines.visible = el0 === 'edge' || el0 === 'vert';
    this._matPt.size = el0 === 'vert' ? 9 : 5;
    this._fillBuffers();
  }

  /** 笔刷环：拆过覆盖层后要重新挂回新容器（环本身复用，不重建） */
  _ensureRing(g) {
    if (!this.ring) {
      const pts = [];
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      this.ring = new THREE.LineLoop(geo, this._matRing);
      this.ring.userData.helper = true;
      this.ring.frustumCulled = false;
      this.ring.renderOrder = 28;
      this.ring.visible = false;
      this.ring.raycast = () => {};
      g.add(this.ring);
    } else if (this.ring.parent !== g) {
      g.add(this.ring);
    }
  }

  _hideOverlay() {
    if (this.ring) this.ring.visible = false;
    if (this.group) {
      // 覆盖层每次 sync 都会重建，几何是临时缓冲 → 拆下来时顺手释放，别攒 GPU 缓冲
      for (const n of [this.points, this.lines, this.faceMesh]) {
        if (n && n.geometry) n.geometry.dispose();
      }
      if (this.group.parent) this.group.parent.remove(this.group);
      this.group = null;
    }
    this.points = null;
    this.lines = null;
    this.faceMesh = null;
    this._ptN = -1;
    this._lnN = -1;
  }

  /** 把当前顶点 / 边坐标与选中配色写进覆盖层缓冲 */
  _fillBuffers() {
    const rec = this.rec;
    if (!rec || !this.points) return;
    // 体素模式的覆盖层里没有点 / 边缓冲，也不该为几万面的模型重建拓扑索引
    if (this.tool === 'voxel') return;
    const verts = polyVerts(rec.o);
    const list = this._edgeList();
    const pa = this.points.geometry.attributes.position;
    const ca = this.points.geometry.attributes.color;
    const el0 = this.element;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      pa.setXYZ(i, v[0], v[1], v[2]);
      const c = (el0 !== 'edge' && this.sel.has(i)) ? C_PT_SEL
        : (el0 !== 'edge' && this.hover === i) ? C_PT_HOVER : C_PT;
      ca.setXYZ(i, c.r, c.g, c.b);
    }
    pa.needsUpdate = true; ca.needsUpdate = true;

    const la = this.lines.geometry.attributes.position;
    const lc = this.lines.geometry.attributes.color;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const a = verts[e.a], b = verts[e.b];
      if (!a || !b) continue;
      la.setXYZ(2 * i, a[0], a[1], a[2]);
      la.setXYZ(2 * i + 1, b[0], b[1], b[2]);
      const c = (el0 === 'edge' && this.sel.has(e.k)) ? C_EDGE_SEL
        : (el0 === 'edge' && this.hover === i) ? C_PT_HOVER : C_EDGE;
      lc.setXYZ(2 * i, c.r, c.g, c.b);
      lc.setXYZ(2 * i + 1, c.r, c.g, c.b);
    }
    la.needsUpdate = true; lc.needsUpdate = true;
    this._fillFaceHighlight();
  }

  _fillFaceHighlight() {
    const rec = this.rec;
    if (!rec || !this.faceMesh) return;
    const faces = polyFaces(rec.o);
    const verts = polyVerts(rec.o);
    const sel = (this.element === 'face') ? [...this.sel] : [];
    const arr = new Float32Array(Math.max(1, sel.length) * 9);
    let w = 0;
    for (const fi of sel) {
      const f = faces[fi];
      if (!f) continue;
      for (const vi of f) {
        const v = verts[vi];
        if (!v) continue;
        arr[w++] = v[0]; arr[w++] = v[1]; arr[w++] = v[2];
      }
    }
    if (!w) { this.faceMesh.visible = false; return; }
    const trimmed = arr.slice(0, w);
    this.faceMesh.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(trimmed, 3));
    this.faceMesh.geometry = geo;
    this.faceMesh.visible = true;
  }

  /** 只重写坐标（雕刻 / 拖顶点时用，不重建缓冲） */
  _fillPositions() {
    const rec = this.rec;
    if (!rec || !this.points) return;
    if (this.tool === 'voxel') return;
    const verts = polyVerts(rec.o);
    const list = this._edgeList();
    const pa = this.points.geometry.attributes.position;
    for (let i = 0; i < verts.length && i < pa.count; i++) {
      pa.setXYZ(i, verts[i][0], verts[i][1], verts[i][2]);
    }
    pa.needsUpdate = true;
    const la = this.lines && this.lines.geometry.attributes.position;
    if (la) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const a = verts[e.a], b = verts[e.b];
        if (!a || !b) continue;
        la.setXYZ(2 * i, a[0], a[1], a[2]);
        la.setXYZ(2 * i + 1, b[0], b[1], b[2]);
      }
      la.needsUpdate = true;
    }
    this._fillFaceHighlight();
  }

  _refresh() {
    if (this.group) this._fillBuffers();
    this._setStat();
  }

  /* ============================================================
     拓扑索引
     ============================================================ */
  _edgeList() {
    const o = this.rec ? this.rec.o : null;
    const faces = polyFaces(o);
    if (this._emapFaces !== faces) {
      this._emapFaces = faces;
      this._emap = edgeMap(faces);
      this._emapVerts = polyVerts(o);
      // 共面边（平面内部的剖分对角线）不展示、不可拾取：方块该显示 12 条棱而不是 18 条
      this._edges = [...this._emap.values()]
        .filter((e) => !isFlatEdge(this._emapVerts, faces, e));
    }
    return this._edges;
  }

  _allKeys() {
    if (this.element === 'vert') return polyVerts(this.rec.o).map((_, i) => i);
    if (this.element === 'face') return polyFaces(this.rec.o).map((_, i) => i);
    if (this.element === 'edge') return this._edgeList().map((e) => e.k);
    return [];
  }

  /** 当前选择影响到的顶点下标集合 */
  _affectedVerts() {
    const out = new Set();
    const o = this.rec ? this.rec.o : null;
    if (!o) return out;
    if (this.element === 'vert') { for (const i of this.sel) out.add(i | 0); return out; }
    if (this.element === 'edge') {
      for (const k of this.sel) {
        const e = this._emap && this._emap.get(k);
        if (e) { out.add(e.a); out.add(e.b); }
      }
      return out;
    }
    const faces = polyFaces(o);
    for (const fi of this.sel) {
      const f = faces[fi];
      if (f) { out.add(f[0]); out.add(f[1]); out.add(f[2]); }
    }
    return out;
  }

  /* ============================================================
     屏幕投影与拾取
     ============================================================ */
  _project() {
    const rec = this.rec;
    if (!rec || !rec.mesh) return null;
    const verts = polyVerts(rec.o);
    const n = verts.length;
    if (this._scr.length < n * 3) this._scr = new Float32Array(n * 3);
    const vp = this.ed.viewport;
    rec.mesh.updateWorldMatrix(true, false);
    const mw = rec.mesh.matrixWorld;
    const r = vp.dom.getBoundingClientRect();
    const cam = vp.camera;
    // 逐顶点投影；rect 只取一次，避免每个顶点都触发一次布局读取
    for (let i = 0; i < n; i++) {
      const p = this._tv.fromArray(verts[i]).applyMatrix4(mw).project(cam);
      this._scr[i * 3] = r.left + (p.x * 0.5 + 0.5) * r.width;
      this._scr[i * 3 + 1] = r.top + (-p.y * 0.5 + 0.5) * r.height;
      this._scr[i * 3 + 2] = p.z;
    }
    return r;
  }

  _pickVert(cx, cy) {
    let best = -1, bd = VERT_PX * VERT_PX;
    for (let i = 0; i < this._scr.length / 3; i++) {
      if (this._scr[i * 3 + 2] > 1) continue;
      const dx = this._scr[i * 3] - cx, dy = this._scr[i * 3 + 1] - cy;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  _pickEdge(cx, cy) {
    const list = this._edgeList();
    let best = -1, bd = EDGE_PX * EDGE_PX;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const za = this._scr[e.a * 3 + 2], zb = this._scr[e.b * 3 + 2];
      if (za > 1 || zb > 1) continue;
      const d = segDist2(cx, cy,
        this._scr[e.a * 3], this._scr[e.a * 3 + 1],
        this._scr[e.b * 3], this._scr[e.b * 3 + 1]);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  _pickFace(cx, cy) {
    const vp = this.ed.viewport;
    const rec = this.rec;
    if (!rec || !rec.mesh) return -1;
    rec.mesh.updateWorldMatrix(true, false);
    vp.raycaster.setFromCamera(vp.ndc(cx, cy), vp.camera);
    const hits = vp.raycaster.intersectObject(rec.mesh, false);
    const h = hits.find((x) => x.object.visible !== false);
    if (!h) return -1;
    const map = h.object.geometry && h.object.geometry.userData.triFace;
    const ti = h.faceIndex | 0;
    return (map && map[ti] !== undefined) ? map[ti] : ti;
  }

  /** 命中元素 → { key, hover }；key 是选择集合里用的键 */
  _pick(cx, cy) {
    this._project();
    if (this.element === 'vert') {
      const i = this._pickVert(cx, cy);
      return i < 0 ? null : { key: i, hover: i };
    }
    if (this.element === 'edge') {
      const i = this._pickEdge(cx, cy);
      if (i < 0) return null;
      return { key: this._edgeList()[i].k, hover: i };
    }
    if (this.element === 'face') {
      const fi = this._pickFace(cx, cy);
      return fi < 0 ? null : { key: fi, hover: fi };
    }
    return null;
  }

  _raycastMesh(cx, cy) {
    const vp = this.ed.viewport;
    const rec = this.rec;
    if (!vp || !rec || !rec.mesh) return null;
    rec.mesh.updateWorldMatrix(true, false);
    vp.raycaster.setFromCamera(vp.ndc(cx, cy), vp.camera);
    const hits = vp.raycaster.intersectObject(rec.mesh, false);
    return hits.find((x) => x.object.visible !== false) || null;
  }

  /* ============================================================
     指针：按下 / 移动 / 抬起
     ============================================================ */
  onDown(e) {
    if (!this.active || !this.rec || e.button !== 0) return false;
    if (this.ed.snapOn === undefined) return false;   // 防御：编辑器未就绪

    if (this.tool === 'voxel') {
      const hit = this._raycastMesh(e.clientX, e.clientY);
      if (!hit) return false;
      return this._beginVoxelStroke(hit, e);
    }
    if (this.tool === 'sculpt') {
      const hit = this._raycastMesh(e.clientX, e.clientY);
      if (!hit) return false;
      this._beginStroke(hit, e);
      return true;
    }
    if (this.element === 'object') return false;      // 交给常规变换组件

    const hit = this._pick(e.clientX, e.clientY);
    const add = e.shiftKey, toggle = e.ctrlKey || e.metaKey;
    if (!hit) {
      if (!add && !toggle && this.sel.size) { this.sel.clear(); this._refresh(); }
      return false;                                   // 交给编辑器做框选
    }
    if (toggle) { if (this.sel.has(hit.key)) this.sel.delete(hit.key); else this.sel.add(hit.key); }
    else if (add) this.sel.add(hit.key);
    else if (!this.sel.has(hit.key)) { this.sel.clear(); this.sel.add(hit.key); }
    this.hover = hit.hover;
    this._refresh();
    this._beginMove(e);
    return true;
  }

  onMove(e) {
    if (!this.active) return false;
    if (this.stroke) { this._strokeMove(e); return true; }
    if (this.drag) { this._moveDrag(e); return true; }

    // 悬停高亮 / 笔刷环
    if (this.tool !== 'select') {
      const hit = this._raycastMesh(e.clientX, e.clientY);
      this._placeRing(hit);
      if (this.tool !== 'sculpt') return false;       // 体素模式不拾取元素
      return false;                                   // 让相机拖动等照常工作
    }
    if (this.element === 'object') return false;
    const hit = this._pick(e.clientX, e.clientY);
    const hv = hit ? hit.hover : -1;
    if (hv !== this.hover) { this.hover = hv; this._refresh(); }
    return false;
  }

  onUp() {
    if (this.stroke) {
      const st = this.stroke;
      this.stroke = null;
      this._vfield = null;
      this._vbackup = null;
      this._vcenter = null;
      this._vbaked = false;
      this._placeRing(null);
      if (st.moved) { this._endEdit(st.vox ? '体素雕刻建模体' : '雕刻建模体', st.prev); return true; }
      return false;
    }
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      if (d.moved) { this._endEdit('编辑建模体元素', d.prev); return true; }
      return false;
    }
    return false;
  }

  /* ---------- 元素拖拽 ---------- */
  _beginMove(e) {
    const vp = this.ed.viewport;
    const rec = this.rec;
    const verts = polyVerts(rec.o);
    const idx = this._affectedVerts();
    if (!idx.size || !verts.length) return;
    const c = new THREE.Vector3();
    for (const i of idx) { const v = verts[i]; if (v) c.add(this._tv.set(v[0], v[1], v[2])); }
    c.divideScalar(idx.size);

    rec.mesh.updateWorldMatrix(true, false);
    const mw = rec.mesh.matrixWorld;
    const wp = this._tv.copy(c).applyMatrix4(mw).clone().add(new THREE.Vector3());
    const normal = e.shiftKey
      ? new THREE.Vector3(0, 1, 0)
      : vp.camera.getWorldDirection(new THREE.Vector3()).negate();
    this._plane.setFromNormalAndCoplanarPoint(normal, wp);
    vp.raycaster.setFromCamera(vp.ndc(e.clientX, e.clientY), vp.camera);
    const hitP = new THREE.Vector3();
    if (!vp.raycaster.ray.intersectPlane(this._plane, hitP)) return;

    const targets = [...idx];
    this.drag = {
      prev: this.ed.snap(),
      plane: this._plane.clone(),
      offset: hitP.clone().sub(wp),
      invWorld: new THREE.Matrix4().copy(mw).invert(),
      anchor: c.clone(),
      targets,
      base: targets.map((i) => verts[i].slice()),
      moved: false,
    };
  }

  _moveDrag(e) {
    const d = this.drag;
    const vp = this.ed.viewport;
    if (!d || !vp) return;
    vp.raycaster.setFromCamera(vp.ndc(e.clientX, e.clientY), vp.camera);
    const p = new THREE.Vector3();
    if (!vp.raycaster.ray.intersectPlane(d.plane, p)) return;
    p.sub(d.offset).applyMatrix4(d.invWorld);
    let dx = p.x - d.anchor.x, dy = p.y - d.anchor.y, dz = p.z - d.anchor.z;
    if (this.ed.snapOn) {
      const s = Math.max(0.05, Number(EDITOR.snapMove) || 1) / 4;
      dx = Math.round(dx / s) * s; dy = Math.round(dy / s) * s; dz = Math.round(dz / s) * s;
    }
    const verts = polyVerts(this.rec.o);
    for (let k = 0; k < d.targets.length; k++) {
      const i = d.targets[k];
      const b = d.base[k];
      verts[i] = [round(b[0] + dx), round(b[1] + dy), round(b[2] + dz)];
    }
    d.moved = true;
    this._commitMeshGeometry();
  }

  /* ---------- 雕刻笔刷 ---------- */
  _beginStroke(hit, e) {
    const rec = this.rec;
    this.stroke = {
      prev: this.ed.snap(),
      moved: false,
      invert: !!e.altKey,
      last: 0,
      adj: vertexAdjacency(polyFaces(rec.o), polyVerts(rec.o).length),
    };
    this._applyBrush(hit);
  }

  _strokeMove(e) {
    const st = this.stroke;
    if (!st) return;
    if (e.altKey !== st.invert) st.invert = !!e.altKey;
    const now = performance.now();
    if (now - st.last < (st.vox ? VOX_MS : STROKE_MS)) return;
    st.last = now;
    const hit = this._raycastMesh(e.clientX, e.clientY);
    if (!hit) return;
    if (st.vox) this._applyVoxelBrush(hit); else this._applyBrush(hit);
    this._placeRing(hit);
  }

  /**
   * 落一次笔刷。
   * 半径按「世界尺寸」给定，所以先在世界上算距离与方向，
   * 再用物体矩阵的逆把位移换算回本地坐标 —— 物体带非等比缩放（默认就是 4×1×4）时也不会歪。
   */
  _applyBrush(hit) {
    const rec = this.rec;
    const st = this.stroke;
    if (!rec || !rec.mesh || !hit) return;
    const o = rec.o;
    const verts = polyVerts(o);
    const mw = rec.mesh.matrixWorld;
    const nLocal = hit.face ? hit.face.normal : null;
    const nWorld = nLocal
      ? this._tv.set(nLocal.x, nLocal.y, nLocal.z)
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mw)).normalize().clone()
      : new THREE.Vector3(0, 1, 0);
    const invLin = new THREE.Matrix3().setFromMatrix4(mw).invert();

    const r = Math.max(0.02, Number(this.brush.radius) || 1);
    const str = clamp(Number(this.brush.strength) || 0.5, 0.01, 1);
    const mode = this.brush.mode;
    const sign = (st && st.invert ? -1 : 1) * (this.brush.dir >= 0 ? 1 : -1);
    const wv = new THREE.Vector3();
    const delta = new THREE.Vector3();
    let moved = 0;

    for (let i = 0; i < verts.length; i++) {
      const p = verts[i];
      wv.fromArray(p).applyMatrix4(mw);
      const dist = wv.distanceTo(hit.point);
      if (dist >= r) continue;
      const t = dist / r;
      const f = 1 - t * t;
      const w = f * f;

      if (mode === 'smooth') {
        const nb = st && st.adj ? st.adj[i] : null;
        if (!nb || !nb.size) continue;
        let sx = 0, sy = 0, sz = 0;
        for (const j of nb) { const q = verts[j]; sx += q[0]; sy += q[1]; sz += q[2]; }
        const m = nb.size;
        delta.set((sx / m - p[0]) * w * str, (sy / m - p[1]) * w * str, (sz / m - p[2]) * w * str);
        verts[i] = [round(p[0] + delta.x), round(p[1] + delta.y), round(p[2] + delta.z)];
        moved++;
        continue;
      }

      if (mode === 'flatten') {
        const d0 = this._tv2.copy(wv).sub(hit.point).dot(nWorld);
        delta.copy(nWorld).multiplyScalar(-d0 * w * str);
      } else {
        // 推拉：位移量按半径的比例给，笔画密时不会一下拉飞
        delta.copy(nWorld).multiplyScalar(sign * w * r * 0.22 * str);
      }
      const ld = delta.applyMatrix3(invLin);
      verts[i] = [round(p[0] + ld.x), round(p[1] + ld.y), round(p[2] + ld.z)];
      moved++;
    }
    // 一笔下去一个顶点都没罩住：低模顶点稀疏时很容易发生，明确告诉用户而不是静默无效
    if (st) st.moved = st.moved || moved > 0;
    if (!moved && !this._radiusHinted) {
      this._radiusHinted = true;
      this.ed.showHint('这一笔没碰到任何顶点：把「半径」调大再试（低模的顶点很稀疏）', 4200);
    }
    this._commitMeshGeometry();
  }

  _placeRing(hit) {
    if (!this.ring) return;
    if (!hit || this.tool === 'select') { this.ring.visible = false; return; }
    const rec = this.rec;
    const mw = rec.mesh.matrixWorld;
    rec.mesh.worldToLocal(this._tv.copy(hit.point));
    this.ring.position.copy(this._tv);
    const nl = hit.face ? hit.face.normal : null;
    if (nl) {
      const n = this._tv.set(nl.x, nl.y, nl.z).normalize();
      this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    }
    // 半径是世界的，环挂在物体本地空间 → 按世界缩放折算
    const s = new THREE.Vector3();
    mw.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    const r = Math.max(0.02, Number(this.brush.radius) || 1);
    this.ring.scale.set(r / Math.max(1e-6, Math.abs(s.x)), r / Math.max(1e-6, Math.abs(s.y)), 1);
    this.ring.visible = true;
  }

  /* ---------- 体素笔刷（加料 / 挖除 / 体素平滑） ---------- */
  /**
   * 起笔：把当前建模体在世界空间栅格化成一张 SDF 场，整笔期间常驻。
   * 每一笔只改场、再反提取一次网格（Surface Nets），松手才记撤销 ——
   * 比「每笔重新栅格化一遍」快一个量级。
   */
  _beginVoxelStroke(hit, e) {
    const rec = this.rec;
    if (!rec || !rec.mesh) return false;
    const verts = polyVerts(rec.o);
    const faces = polyFaces(rec.o);
    if (verts.length < 3 || !faces.length) { toast('建模体没有可用的几何数据', 'err'); return false; }
    rec.mesh.updateWorldMatrix(true, false);
    const mw = rec.mesh.matrixWorld.clone();
    const wbox = meshWorldBox(verts, mw);
    const res = Math.round(clamp(Number(this.vox.res) || 24, 12, 48));
    const r = Math.max(0.05, Number(this.brush.radius) || 1);
    const ext = Math.max(
      wbox.max[0] - wbox.min[0], wbox.max[1] - wbox.min[1], wbox.max[2] - wbox.min[2], 1e-3);
    // 外扩必须至少覆盖笔刷半径：否则「加料」会在场边界被平切 → 看起来像模型被削平 / 损坏
    const pad = clamp(r / ext, 0.16, 0.5);
    // 面数预算：Surface Nets 面数 ≈ 世界表面积 / step²，反推允许的最小步长
    const area = meshWorldArea(verts, faces, mw);
    const minStep = Math.sqrt(area / (MAX_POLY_FACES * 0.6));
    const f = makeField(wbox.min, wbox.max, res, pad, { minStep, minAxisCells: 3, maxCells: 900000 });
    fieldRasterizeMesh(f, verts, faces, mw);

    // 先试提取一次：场里没表面、或面数直接超限，就整个拒绝，别让用户白画半天
    const probe = fieldToMesh(f, 0);
    if (!probe.faces.length) {
      toast('体素化失败：没提取到表面，提高「精度」或换个体积更大的模型再试', 'err', 4200);
      return false;
    }
    if (probe.faces.length > MAX_POLY_FACES) {
      toast(`体素结果约 ${probe.faces.length} 个三角面，已超过建模上限 ${MAX_POLY_FACES}：请降低「精度」`, 'err', 4600);
      return false;
    }

    if (r < f.step * 0.9) {
      this.ed.showHint('笔刷半径比体素格子还小，几乎画不动：调大「半径」或降低「精度」', 4200);
    }

    this._vfield = f;
    this._vbackup = new Float32Array(f.data.length);
    this._vcenter = [
      (wbox.min[0] + wbox.max[0]) / 2,
      (wbox.min[1] + wbox.max[1]) / 2,
      (wbox.min[2] + wbox.max[2]) / 2,
    ];
    this._vbaked = false;
    this._vtooHeavy = false;
    this.stroke = { prev: this.ed.snap(), moved: false, invert: !!e.altKey, last: performance.now(), vox: true };
    this._applyVoxelBrush(hit);
    return true;
  }

  _applyVoxelBrush(hit) {
    const f = this._vfield;
    const st = this.stroke;
    const rec = this.rec;
    if (!f || !rec || !rec.mesh || !hit) return;
    const bk = this._vbackup;
    if (bk && bk.length === f.data.length) bk.set(f.data);

    const r = Math.max(0.05, Number(this.brush.radius) || 1);
    const str = clamp(Number(this.brush.strength) || 0.5, 0.05, 1);
    const mode = this.vox.mode;
    const invert = !!(st && st.invert);
    const hp = hit.point;

    if (mode === 'smooth') {
      fieldBrushSmooth(f, hp.x, hp.y, hp.z, r, str * 0.9, 2);
    } else if (mode === 'flatten') {
      const n = hit.face
        ? this._tv.set(hit.face.normal.x, hit.face.normal.y, hit.face.normal.z)
          .applyMatrix3(new THREE.Matrix3().getNormalMatrix(rec.mesh.matrixWorld)).normalize().clone()
        : new THREE.Vector3(0, 1, 0);
      fieldBrushFlatten(f, hp.x, hp.y, hp.z, r, n.x, n.y, n.z, hp.x, hp.y, hp.z, str);
    } else if (mode === 'grow' || mode === 'erode') {
      // 扩张 / 侵蚀：对场做常量偏移，Alt 在两个方向之间互换。
      // 每次落笔的偏移量按格子尺度给（很小），笔画持续拖动时逐笔累积成平滑的隆起 / 塌陷。
      let sg = mode === 'grow' ? 1 : -1;
      if (invert) sg = -sg;
      const t = Math.min(str * f.step * 0.9, f.band * 0.85);
      fieldBrushOffset(f, hp.x, hp.y, hp.z, r, t, sg);
    } else {
      const sub = (mode === 'erase') !== invert;
      const n = hit.face
        ? this._tv.set(hit.face.normal.x, hit.face.normal.y, hit.face.normal.z)
          .applyMatrix3(new THREE.Matrix3().getNormalMatrix(rec.mesh.matrixWorld)).normalize().clone()
        : new THREE.Vector3(0, 1, 0);
      // 球心沿法线偏一点：加料时埋进表面里、挖除时浮在表面外，笔头才「贴」得住
      const off = sub ? r * 0.5 : -r * 0.35;
      fieldBrushSphere(f,
        hp.x + n.x * off, hp.y + n.y * off, hp.z + n.z * off,
        r, sub ? -1 : 1, r * clamp(Number(this.vox.blend) || 0, 0, 1));
    }

    const mesh = fieldToMesh(f, 0);
    if (!mesh.faces.length || mesh.faces.length > MAX_POLY_FACES) {
      // 会画空 / 会超上限：把这一笔整个撤回（场上一次成功状态留在备份里）
      if (bk && bk.length === f.data.length) f.data.set(bk);
      if (mesh.faces.length > MAX_POLY_FACES && !this._vtooHeavy) {
        this._vtooHeavy = true;
        toast(`这一笔会超过建模上限 ${MAX_POLY_FACES} 面，已撤销：请降低「精度」或缩小半径`, 'err', 4200);
      }
      return;
    }
    if (st) st.moved = true;
    this._commitVoxMesh(mesh);
  }

  /**
   * 把体素结果写回建模体。
   * 场是在世界空间算的 → 第一次提交时把对象的整体变换「烘」进顶点：
   * 旋转 / 缩放归零、顶点变绝对尺度、位置挪到结果包围盒中心在父空间的位置。
   * 顶点一旦变成绝对尺度，包围盒碰撞体必然失真 → 强制走 trimesh。
   */
  _commitVoxMesh(mesh) {
    const rec = this.rec;
    if (!rec || !rec.mesh) return;
    const o = rec.o;
    const c = this._vcenter;
    if (!this._vbaked) {
      const inv = this._parentInverse(rec);
      const local = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(inv);
      o.position = [round(local.x, 4), round(local.y, 4), round(local.z, 4)];
      o.rotation = [0, 0, 0];
      o.scale = [1, 1, 1];
      o.physicsMode = 'mesh';
      rec.mesh.position.copy(local);
      rec.mesh.quaternion.identity();
      rec.mesh.scale.set(1, 1, 1);
      rec.mesh.updateMatrixWorld(true);
      this._vbaked = true;
    }
    const out = new Array(mesh.verts.length);
    for (let i = 0; i < mesh.verts.length; i++) {
      const v = mesh.verts[i];
      out[i] = [round(v[0] - c[0], 4), round(v[1] - c[1], 4), round(v[2] - c[2], 4)];
    }
    o.verts = out;
    o.faces = mesh.faces.map((fc) => [fc[0] | 0, fc[1] | 0, fc[2] | 0]);
    this._emapFaces = null;
    const g = polyGeometry(o);
    const old = rec.mesh.geometry;
    rec.mesh.geometry = g;
    if (old && old !== g) old.dispose();
    this.sync();
  }

  /** 对象所处父空间的逆矩阵：世界坐标的结果要折回 o.position 所在的坐标系 */
  _parentInverse(rec) {
    const p = rec && rec.mesh ? rec.mesh.parent : null;
    if (!p) return new THREE.Matrix4();
    p.updateWorldMatrix(true, false);
    return new THREE.Matrix4().copy(p.matrixWorld).invert();
  }

  /* ============================================================
     几何提交
     ============================================================ */
  /** 顶点数不变的就地提交：只改坐标 + 重算法线，不销毁重建对象 */
  _commitMeshGeometry() {
    const rec = this.rec;
    const g = rec && rec.mesh && rec.mesh.geometry;
    if (!g) return;
    const verts = polyVerts(rec.o);
    const pa = g.attributes.position;
    for (let i = 0; i < verts.length && i < pa.count; i++) {
      pa.setXYZ(i, verts[i][0], verts[i][1], verts[i][2]);
    }
    pa.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this._fillPositions();
  }

  /** 一次编辑结束：需要精确碰撞时重建对象（trimesh 形状要跟着变），然后记一步撤销 */
  _endEdit(label, prev) {
    const rec = this.rec;
    if (!rec) return;
    this._emapFaces = null;   // 顶点动过 → 边的共面性可能变了，重建拓扑索引
    if ((rec.o.physicsMode || 'box') === 'mesh') {
      try {
        const fresh = this.ed.builder.rebuild(rec);
        if (fresh) this.rec = fresh;
      } catch (err) { /* ignore */ }
    }
    this.ed.record(label, prev);
    this._syncHud();
    this.sync();
  }

  /** 拓扑变化（顶点数变了）后的统一收尾 */
  _afterTopology(label, prev) {
    const rec = this.rec;
    if (!rec) return;
    this.sel.clear();
    this.hover = -1;
    this._emapFaces = null;
    try {
      const fresh = this.ed.builder.rebuild(rec);
      if (fresh) this.rec = fresh;
    } catch (err) { /* ignore */ }
    this.ed.record(label, prev);
    this.sync();
  }

  /* ============================================================
     拓扑 / 选择操作
     ============================================================ */
  doBevel() {
    if (this.element !== 'edge') { toast('倒角只在「边」元素模式下可用', 'err'); return; }
    if (!this.sel.size) { toast('先选中至少一条边（可框选多条）', 'err'); return; }
    const rec = this.rec;
    if (!rec) return;
    const prev = this.ed.snap();
    const res = bevelEdges(rec.o, [...this.sel], this.bevelAmount);
    if (!res.ok) {
      toast(res.reason === 'toobig' ? '面数已达建模上限，无法继续倒角'
        : res.reason === 'flat' ? '选中的都是平面内部的边（不算棱），换个棱上的边再倒角'
          : '选中的边不可倒角：需要恰好属于 2 个面（模型的开放边 / 边界边先跳过）', 'err', 3600);
      return;
    }
    toast(`已倒角 ${res.edges} 条边（新增 ${res.added} 个顶点）`
      + (res.flat ? `，另有 ${res.flat} 条平面内部的边被跳过` : ''));
    this._afterTopology('选边倒角', prev);
  }

  doSmooth() {
    const rec = this.rec;
    if (!rec) return;
    const idx = this._affectedVerts();
    if (!idx.size) { toast('先选中要平滑的点 / 边 / 面', 'err'); return; }
    const prev = this.ed.snap();
    smoothVerts(rec.o, idx, 0.55, 1);
    this._commitMeshGeometry();
    this.ed.record('平滑建模体顶点', prev);
    this.sync();
  }

  doDelete() {
    const rec = this.rec;
    if (!rec) return;
    if (!this.sel.size) { toast('先选中要删除的元素', 'err'); return; }
    if (this.element === 'edge') { toast('「边」模式不支持删除：请切到「点」或「面」', 'err'); return; }
    const prev = this.ed.snap();
    const n = this.element === 'vert' ? deleteVerts(rec.o, this.sel) : deleteFaces(rec.o, this.sel);
    if (!n) { toast('删除失败：不能把模型删空', 'err'); return; }
    toast(`已删除 ${n} 个${this.element === 'vert' ? '顶点' : '三角面'}`);
    this._afterTopology(this.element === 'vert' ? '删除顶点' : '删除面', prev);
  }

  selectAll() { this.sel = new Set(this._allKeys()); this._refresh(); }
  selectNone() { this.sel.clear(); this._refresh(); }
  selectInvert() {
    const all = this._allKeys();
    const next = new Set();
    for (const k of all) if (!this.sel.has(k)) next.add(k);
    this.sel = next;
    this._refresh();
  }

  /** 框选（编辑器把矩形传进来；x1..y1 / x2..y2 为客户端像素） */
  selectInRect(x1, y1, x2, y2, additive) {
    if (!this.active || this.element === 'object' || this.tool !== 'select') return false;
    this._project();
    const inRect = (i) => {
      if (this._scr[i * 3 + 2] > 1) return false;
      const x = this._scr[i * 3], y = this._scr[i * 3 + 1];
      return x >= x1 && x <= x2 && y >= y1 && y <= y2;
    };
    if (!additive) this.sel.clear();
    if (this.element === 'vert') {
      for (let i = 0; i < this._scr.length / 3; i++) if (inRect(i)) this.sel.add(i);
    } else if (this.element === 'edge') {
      for (const e of this._edgeList()) if (inRect(e.a) && inRect(e.b)) this.sel.add(e.k);
    } else {
      const faces = polyFaces(this.rec.o);
      for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        if (inRect(f[0]) && inRect(f[1]) && inRect(f[2])) this.sel.add(i);
      }
    }
    this._refresh();
    return true;
  }

  /* ============================================================
     HUD
     ============================================================ */
  _buildHud() {
    const host = this._hud;
    if (!host) return;
    clear(host);
    const btn = (k, text, title) => el('button', { class: 'mini', dataset: { mb: k }, title, text });
    const row = (...kids) => el('div', { class: 'ph-row' }, ...kids);
    const lab = (t) => el('span', { class: 'ph-lab', text: t });

    host.appendChild(row(lab('元素'),
      ...ELEMENTS.map((e) => btn('el:' + e.v, e.l, e.t)),
      el('button', { class: 'mini', dataset: { mb: 'close' }, style: { marginLeft: 'auto' }, text: '✕', title: '退出建模模式 (M)' })));
    host.appendChild(row(lab('工具'), btn('tool:select', '选择'), btn('tool:sculpt', '雕刻'),
      btn('tool:voxel', '体素', 'SDF 体素地形：喜欢 Roblox 那样的 add / erase / grow / erode / smooth / flatten，改完自动重提取网格（适合改地形）')));

    // 选择工具：选择集 + 拓扑操作
    const selBox = el('div', {});
    this._ui.selBox = selBox;
    selBox.appendChild(row(lab('选择'), btn('act:all', '全选'), btn('act:none', '清空'), btn('act:invert', '反选')));
    const bev = el('input', { type: 'range', min: 0.005, max: 0.4, step: 0.005, value: this.bevelAmount });
    this._ui.bevelNum = el('span', { class: 'ph-num', text: this.bevelAmount.toFixed(3) });
    bev.addEventListener('input', () => {
      this.bevelAmount = Number(bev.value);
      this._ui.bevelNum.textContent = this.bevelAmount.toFixed(3);
    });
    selBox.appendChild(row(lab('倒角'), bev, this._ui.bevelNum, btn('act:bevel', '倒角选中边')));
    selBox.appendChild(row(lab('编辑'), btn('act:smooth', '平滑选中'), btn('act:del', '删除所选')));
    host.appendChild(selBox);

    // 笔刷公用参数：雕刻与体素共用同一把半径 / 强度
    const brushBox = el('div', {});
    this._ui.brushBox = brushBox;
    const rad = el('input', { type: 'range', min: 0.1, max: 12, step: 0.05, value: this.brush.radius });
    this._ui.rad = rad;
    this._ui.radNum = el('span', { class: 'ph-num', text: this.brush.radius.toFixed(2) });
    rad.addEventListener('input', () => {
      this.brush.radius = Number(rad.value);
      this._ui.radNum.textContent = this.brush.radius.toFixed(2);
      this._autoRadius = false;     // 用户自己定过半径了，之后不再自动配
      this._radiusHinted = false;
    });
    brushBox.appendChild(row(lab('半径'), rad, this._ui.radNum));
    const stg = el('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: this.brush.strength });
    this._ui.stgNum = el('span', { class: 'ph-num', text: this.brush.strength.toFixed(2) });
    stg.addEventListener('input', () => {
      this.brush.strength = Number(stg.value);
      this._ui.stgNum.textContent = this.brush.strength.toFixed(2);
    });
    brushBox.appendChild(row(lab('强度'), stg, this._ui.stgNum));
    host.appendChild(brushBox);

    // 雕刻
    const sculptBox = el('div', {});
    this._ui.sculptBox = sculptBox;
    sculptBox.appendChild(row(lab('笔刷'), btn('bm:push', '推拉'), btn('bm:smooth', '平滑'), btn('bm:flatten', '压平'),
      btn('bdir', '反向', '当前推 / 拉方向，按住 Alt 也可临时反向')));
    host.appendChild(sculptBox);

    // 体素
    const voxBox = el('div', {});
    this._ui.voxBox = voxBox;
    voxBox.appendChild(el('div', { class: 'ph-row vox-modes' },
      lab('笔刷'), ...VOX_MODES.map((m) => btn('vm:' + m.v, m.l, m.t))));
    const blend = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: this.vox.blend });
    this._ui.blendNum = el('span', { class: 'ph-num', text: this.vox.blend.toFixed(2) });
    blend.addEventListener('input', () => {
      this.vox.blend = Number(blend.value);
      this._ui.blendNum.textContent = this.vox.blend.toFixed(2);
    });
    voxBox.appendChild(row(lab('融合'), blend, this._ui.blendNum,
      el('span', { class: 'ph-lab', text: '越大越软（平滑过渡）' })));
    voxBox.appendChild(row(lab('精度'), ...VOX_RES.map((r2) => btn('vres:' + r2.v, r2.l, r2.t))));
    host.appendChild(voxBox);

    this._ui.stat = el('div', { class: 'ph-row' });
    host.appendChild(this._ui.stat);

    host.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-mb]') : null;
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      this._onHud(b.dataset.mb);
    });
    host.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  _onHud(k) {
    if (k === 'close') { this.setActive(false); return; }
    if (k.startsWith('el:')) { this.setElement(k.slice(3)); return; }
    if (k.startsWith('tool:')) { this.setTool(k.slice(5)); return; }
    if (k.startsWith('bm:')) { this.brush.mode = k.slice(3); this._syncHud(); this.ed.showHint(HINT_SCULPT, 3200); return; }
    if (k.startsWith('vm:')) { this.vox.mode = k.slice(3); this._syncHud(); this.ed.showHint(HINT_VOXEL, 3200); return; }
    if (k.startsWith('vres:')) { this.vox.res = Number(k.slice(5)) || 24; this._syncHud(); return; }
    if (k === 'bdir') { this.brush.dir = -this.brush.dir; this._syncHud(); return; }
    switch (k) {
      case 'act:all': this.selectAll(); break;
      case 'act:none': this.selectNone(); break;
      case 'act:invert': this.selectInvert(); break;
      case 'act:bevel': this.doBevel(); break;
      case 'act:smooth': this.doSmooth(); break;
      case 'act:del': this.doDelete(); break;
      default: break;
    }
  }

  _showHud(on) {
    if (!this._hud) return;
    this._hud.classList.toggle('hidden', !on);
    if (on) this._syncHud();
  }

  _syncHud() {
    const host = this._hud;
    if (!host || host.classList.contains('hidden')) return;
    for (const b of host.querySelectorAll('[data-mb]')) {
      const k = b.dataset.mb;
      let on = false;
      if (k.startsWith('el:')) on = this.element === k.slice(3);
      else if (k.startsWith('tool:')) on = this.tool === k.slice(5);
      else if (k.startsWith('bm:')) on = this.brush.mode === k.slice(3);
      else if (k.startsWith('vm:')) on = this.vox.mode === k.slice(3);
      else if (k.startsWith('vres:')) on = String(this.vox.res) === k.slice(5);
      else if (k === 'bdir') on = this.brush.dir < 0;
      b.classList.toggle('on', on);
    }
    if (this._ui.selBox) this._ui.selBox.classList.toggle('hidden', this.tool !== 'select');
    if (this._ui.brushBox) this._ui.brushBox.classList.toggle('hidden', this.tool === 'select');
    if (this._ui.sculptBox) this._ui.sculptBox.classList.toggle('hidden', this.tool !== 'sculpt');
    if (this._ui.voxBox) this._ui.voxBox.classList.toggle('hidden', this.tool !== 'voxel');
    const bevBtn = host.querySelector('[data-mb="act:bevel"]');
    if (bevBtn) bevBtn.classList.toggle('on', this.element === 'edge' && this.sel.size > 0);
    this._setStat();
  }

  _setStat(override) {
    if (!this._ui.stat) return;
    if (override) { this._ui.stat.textContent = override; return; }
    const rec = this.rec;
    if (!rec) { this._ui.stat.textContent = ''; return; }
    const nv = polyVerts(rec.o).length;
    const nf = polyFaces(rec.o).length;
    const sel = this.sel.size;
    this._ui.stat.textContent = `${nv} 点 · ${nf} 面 · 已选 ${sel}`
      + (this.element === 'edge' ? '（边）' : this.element === 'vert' ? '（点）' : this.element === 'face' ? '（面）' : '');
  }
}
