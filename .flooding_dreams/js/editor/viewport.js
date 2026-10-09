/* ============================================================
   编辑器视口：自由飞行相机（WASD/QE，越飞越快）+ 中键拖动转视角 + 射线拾取
   ============================================================ */
import * as THREE from 'three';
import { clamp } from '../core/util.js';
import { settings } from '../core/settings.js';
import { worldPosition } from '../world/level.js';
import { faceAtlasUV } from '../world/objectTypes.js';

const ROT_SPEED = 0.0034;

export class Viewport {
  constructor(opts = {}) {
    this.engine = opts.engine;
    this.input = opts.input;
    this.dom = opts.dom;                 // #ed-view
    this.getBuilder = opts.getBuilder;   // () => LevelBuilder
    this.camera = new THREE.PerspectiveCamera(
      settings.get('camera.fov', 78), 16 / 9, 0.15, 9000
    );
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(70, 70, 70);

    this.enabled = true;                 // 编辑器未打开时关闭输入
    this.lookEnabled = true;
    this.wheelHandler = null;            // 外部（涂鸦模式）可覆盖滚轮
    this.moving = false;                 // 是否正在飞行（用于提示）
    this._hold = 0;
    this._rotate = false;
    this._last = { x: 0, y: 0 };
    this._pitch = -0.45;
    this._yaw = 0.72;
    this._applyRot();

    this.raycaster = new THREE.Raycaster();
    // 体积雾网格被挪到独占渲染层（FOG_LAYER = 1，见 world/volumefog.js），拾取要带上它
    this.raycaster.layers.enable(1);
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._tmp = new THREE.Vector3();
    this.flySpeed = Number(settings.get('misc.editorFlySpeed', 60)) || 60;

    this._bind();
    settings.on('change', (p) => {
      if (p === '*' || p === 'misc.editorFlySpeed') this.flySpeed = Number(settings.get('misc.editorFlySpeed', 60)) || 60;
      if (p === '*' || p === 'camera.fov') { this.camera.fov = settings.get('camera.fov', 78); this.camera.updateProjectionMatrix(); }
    });
  }

  /* ---------- 事件 ---------- */
  _bind() {
    const d = this.dom;
    if (!d) return;
    this._onDown = (e) => {
      if (!this.enabled) return;
      if (e.button === 1 || (e.button === 0 && e.altKey && this.lookEnabled)) {
        this._rotate = true;
        this._last.x = e.clientX; this._last.y = e.clientY;
        e.preventDefault();
        try { d.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
    };
    this._onMove = (e) => {
      if (!this.enabled || !this._rotate) return;
      const dx = e.clientX - this._last.x;
      const dy = e.clientY - this._last.y;
      this._last.x = e.clientX; this._last.y = e.clientY;
      this.look(dx, dy);
    };
    this._onUp = () => { this._rotate = false; };
    this._onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      if (this.wheelHandler) { this.wheelHandler(e); return; }
      this.zoom(-Math.sign(e.deltaY));
    };
    this._onCtx = (e) => e.preventDefault();
    d.addEventListener('pointerdown', this._onDown);
    d.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    d.addEventListener('wheel', this._onWheel, { passive: false });
    d.addEventListener('contextmenu', this._onCtx);
  }

  dispose() {
    const d = this.dom;
    if (!d) return;
    d.removeEventListener('pointerdown', this._onDown);
    d.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    d.removeEventListener('wheel', this._onWheel);
    d.removeEventListener('contextmenu', this._onCtx);
  }

  /* ---------- 视图尺寸 ---------- */
  setRect() {
    const r = this.dom.getBoundingClientRect();
    this.engine.setRect({ x: r.left, y: r.top, w: r.width, h: r.height });
    this.camera.aspect = Math.max(0.1, r.width / Math.max(1, r.height));
    this.camera.updateProjectionMatrix();
  }

  /* ---------- 相机 ---------- */
  _applyRot() {
    this.camera.rotation.set(this._pitch, this._yaw, 0);
  }
  look(dx, dy) {
    this._yaw -= dx * ROT_SPEED;
    this._pitch = clamp(this._pitch - dy * ROT_SPEED, -1.52, 1.52);
    this._applyRot();
  }
  zoom(dir) {
    this._tmp.set(0, 0, -1).applyQuaternion(this.camera.quaternion).multiplyScalar(clamp(this.flySpeed * 0.22, 5, 90) * dir);
    this.camera.position.add(this._tmp);
  }

  update(dt) {
    if (!this.enabled) { this.moving = false; return; }
    const i = this.input;
    // 按住 Ctrl / Meta 时一律不飞行：这些组合键是编辑器快捷键（Ctrl+D 复制等），
    // 否则同一次按键会被当作 WASD 飞行输入，导致复制时相机跟着跑。
    if (i.keyDown('ControlLeft') || i.keyDown('ControlRight') || i.keyDown('MetaLeft') || i.keyDown('MetaRight')) {
      this.moving = false;
      this._hold = Math.max(0, this._hold - dt * 3.5);
      return;
    }
    const f = (i.keyDown('KeyW') ? 1 : 0) - (i.keyDown('KeyS') ? 1 : 0);
    const r = (i.keyDown('KeyD') ? 1 : 0) - (i.keyDown('KeyA') ? 1 : 0);
    const u = (i.keyDown('KeyE') ? 1 : 0) - (i.keyDown('KeyQ') ? 1 : 0);
    this.moving = !!(f || r || u);
    if (this.moving) this._hold += dt;
    else this._hold = Math.max(0, this._hold - dt * 3.5);
    if (!this.moving) return;
    const boost = i.keyDown('ShiftLeft') || i.keyDown('ShiftRight');
    // 越飞越快，完全松开后恢复到初始速度
    const ramp = clamp(1 + this._hold * 1.15, 1, 8);
    const sp = this.flySpeed * ramp * (boost ? 3.4 : 1);
    const c = this.camera;
    const up = u;
    if (r) c.translateX(r * sp * dt);
    if (up) c.translateY(up * sp * dt);
    if (f) c.translateZ(-f * sp * dt);
  }

  /** 取景到包围盒 */
  frame(box, pad = 1.5) {
    if (!box || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const radius = Math.max(12, s.length() * 0.5);
    const dist = clamp(radius * pad / Math.tan((this.camera.fov * Math.PI / 180) / 2), 30, 4000);
    const dir = new THREE.Vector3(0.55, 0.62, 0.55).normalize();
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.lookAt(c);
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this._pitch = e.x; this._yaw = e.y;
    this._applyRot();
  }

  /** 聚焦到某个点（保持方向，靠近） */
  focus(point, radius = 12) {
    const dist = clamp(radius * 3.4 / Math.tan((this.camera.fov * Math.PI / 180) / 2), 14, 1200);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.camera.position.copy(point).addScaledVector(dir, -dist);
  }

  /* ---------- 拾取 ---------- */
  ndc(clientX, clientY, out = this._ndc) {
    const r = this.dom.getBoundingClientRect();
    out.x = ((clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    out.y = -((clientY - r.top) / Math.max(1, r.height)) * 2 + 1;
    return out;
  }

  /**
   * 射线拾取：返回 { rec, point, uv, object, distance } 或 null
   * opts.helpers=false 时忽略辅助体
   */
  pick(clientX, clientY, opts = {}) {
    const b = this.getBuilder();
    if (!b) return null;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hits = this.raycaster.intersectObjects(b.root.children, true);
    for (const h of hits) {
      if (!h.object.visible) continue;
      if (h.object.userData.helper && opts.helpers !== true) continue;
      if (opts.skipLiquid && h.object.userData.type === 'liquid') continue;
      const id = findObjectId(h.object);
      if (!id) continue;
      const rec = b.objects.get(id);
      if (!rec) continue;
      let uv = h.uv ? [h.uv.x, h.uv.y] : null;
      // 立方体的涂鸦画布是面图集：还没涂过的对象用的是普通几何体，
      // 它的面内 uv(0..1) 要先换算到该面在图集里的格子，否则涂鸦会落到整张贴图上
      if (uv && h.face && (rec.o.shape || 'block') === 'block' && rec.geoAtlas !== true) {
        uv = faceAtlasUV(h.face.materialIndex, uv[0], uv[1]);
      }
      // face 供贴纸轮廓取表面法线（法线在 h.object 局部空间，用 matrixWorld 转到世界）
      return { rec, object: h.object, point: h.point.clone(), uv, face: h.face || null, distance: h.distance };
    }
    return null;
  }

  /** 与水平面（y=h）求交，用于在空地上放置物体 */
  ground(clientX, clientY, y = 0) {
    this._plane.constant = -y;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const out = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this._plane, out);
    return hit ? out : null;
  }

  /** 世界坐标 → 视口内屏幕坐标（用于框选） */
  screenPos(v, out = { x: 0, y: 0 }) {
    const r = this.dom.getBoundingClientRect();
    const p = this._tmp.copy(v).project(this.camera);
    out.x = r.left + (p.x * 0.5 + 0.5) * r.width;
    out.y = r.top + (-p.y * 0.5 + 0.5) * r.height;
    out.z = p.z;
    return out;
  }

  /** 视口中心（视点前方 dist 处） */
  aheadPoint(dist = 60) {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    return this.camera.position.clone().addScaledVector(dir, dist);
  }
}

function findObjectId(obj) {
  let n = obj;
  let guard = 0;
  while (n && guard++ < 24) {
    if (n.userData && n.userData.objectId) return n.userData.objectId;
    n = n.parent;
  }
  return null;
}

/** 世界坐标（对象数据） */
export function objWorldPos(level, o) {
  const p = worldPosition(level, o);
  return new THREE.Vector3(p[0], p[1], p[2]);
}