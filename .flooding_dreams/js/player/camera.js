/* ============================================================
   玩家视角：第三人称环绕 / 第一人称 / 碰撞收缩 / 震屏
   ============================================================ */
import * as THREE from 'three';
import * as CANNON from 'cannon';
import { PLAYER } from '../config.js';
import { settings } from '../core/settings.js';
import { clamp, lerp, damp } from '../core/util.js';

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _rmat = new THREE.Matrix4();     // 非默认重力下构造镜头朝向的临时基矩阵
const _rr = new THREE.Vector3();       // 镜头右方（基列 X）
const _ru = new THREE.Vector3();       // 镜头上方（基列 Y）
const _rb = new THREE.Vector3();       // 镜头后方（基列 Z = -前方）
const _hit = new CANNON.RaycastResult();

export class PlayerCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = -0.16;
    this.dist = settings.get('camera.thirdDistance', 21);
    this.wantDist = this.dist;
    this.mode = settings.get('camera.defaultMode', 'third');
    this.shakeAmt = 0;
    this.shakeT = 0;
    this.fovKick = 0;
    this.roll = 0;
    this.sens = 1;
    this.firstPersonThreshold = 1;
    this.maxDist = settings.get('camera.maxDistance', 90);
    this.minDist = 0;
    this.occluded = false;
    this.lookTarget = new THREE.Vector3();
    // 重力参考系（由 update 从 player 取）：默认重力下 up=(0,1,0)、right=(1,0,0)、fwd=(0,0,1)，
    // 与旧的「固定世界 Y 上方向」逐位一致；非默认重力时镜头绕重力轴环绕、上方向跟重力。
    this.gUp = new THREE.Vector3(0, 1, 0);
    this.gRight = new THREE.Vector3(1, 0, 0);
    this.gFwd = new THREE.Vector3(0, 0, 1);
    // 2D 平台模式：以点 P 为基准、只朝方向 n，相机在与 n 垂直的平面内跟随玩家移动
    this.platform = null;
    this._platInit = false;
  }

  /**
   * 进入 / 退出 2D 平台模式。
   * cfg = { point:[x,y,z] 基准点, normal:[x,y,z] 朝向, dist: 镜头距离 }；传 null 退出。
   */
  setPlatformMode(cfg) {
    if (!cfg) { this.platform = null; this._platInit = false; return; }
    const n = new THREE.Vector3(
      Number(cfg.normal && cfg.normal[0]) || 0,
      Number(cfg.normal && cfg.normal[1]) || 0,
      Number(cfg.normal && cfg.normal[2]) || 0,
    );
    if (n.lengthSq() < 1e-6) n.set(0, 0, -1);
    n.normalize();
    this.platform = {
      point: new THREE.Vector3(
        Number(cfg.point && cfg.point[0]) || 0,
        Number(cfg.point && cfg.point[1]) || 0,
        Number(cfg.point && cfg.point[2]) || 0,
      ),
      normal: n,
      dist: Math.max(1, Number(cfg.dist) || 22),
    };
    this._platInit = false;
  }

  get platformOn() { return !!this.platform; }

  toggleMode() {
    this.mode = this.mode === 'first' ? 'third' : 'first';
    if (this.mode === 'third' && this.wantDist < 6) this.wantDist = settings.get('camera.thirdDistance', 21);
    return this.mode;
  }

  look(dx, dy) {
    if (this.platform) return;   // 平台模式：视角锁定，鼠标解绑
    const s = (0.0022 * this.sens) * settings.get('mouse.sensitivity', 1);
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    const lim = Math.PI / 2 - 0.03;
    this.pitch = clamp(this.pitch, -lim, lim);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  zoom(delta) {
    if (this.platform) return;   // 平台模式：固定视角，忽略缩放
    // 滚轮上滚（delta<0）= 拉远 zoom out，下滚 = 拉近 zoom in
    this.wantDist = clamp(this.wantDist + delta * 3.2, this.minDist, this.maxDist);
    if (this.wantDist < this.firstPersonThreshold) this.mode = 'first';
    else if (this.mode === 'first') this.mode = 'third';
  }

  shake(amount) { this.shakeAmt = Math.min(1.4, this.shakeAmt + amount); }

  update(dt, player, world) {
    if (this.platform) { this._updatePlatform(dt, player); return; }
    const smooth = settings.get('mouse.smooth', 0.18);
    const k = smooth > 0.001 ? 1 - Math.pow(1 - clamp(smooth, 0, 0.9), dt * 60) : 1;
    void k;
    // 重力参考系：默认重力下 up=(0,1,0)、right=(1,0,0)、fwd=(0,0,1) —— 与旧的固定世界轴逐位一致
    if (player._up) this.gUp = player._up;
    if (player._gRight) this.gRight = player._gRight;
    if (player._gFwd) this.gFwd = player._gFwd;
    const up = this.gUp, gr = this.gRight, gf = this.gFwd;
    // 目标位置：优先用 Cannon 内置的 interpolatedPosition（固定步长补间），避免视觉抖动
    const bp = (player.body && player.body.interpolatedPosition) || player.feetPos;
    // 上台阶的视觉补间：物理是瞬间上去的，相机叠同一个偏移（沿反重力方向；默认重力下即世界 Y）
    const so = player._stepVisOff || 0;
    const feetX = bp.x + up.x * so, feetY = bp.y + up.y * so, feetZ = bp.z + up.z * so;
    // 目标距离
    const first = this.mode === 'first' || this.wantDist < this.firstPersonThreshold;
    this.dist = damp(this.dist, first ? 0 : this.wantDist, 12, dt);
    // 取景中心 / 眼睛高度都沿反重力方向抬高（默认重力下 = 只改 y）
    const pivotH = player.slideActive ? 1.5 : PLAYER.eyeOffset;
    const eyeH = player.slideActive ? 1.4 : PLAYER.eyeOffset;
    this.lookTarget.set(feetX + up.x * pivotH, feetY + up.y * pivotH, feetZ + up.z * pivotH);
    const eyeX = feetX + up.x * eyeH, eyeY = feetY + up.y * eyeH, eyeZ = feetZ + up.z * eyeH;

    const sinP = Math.sin(this.pitch), cosP = Math.cos(this.pitch);
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    // 镜头前方 = 水平前方 × cosP + 反重力方向 × sinP；水平前方 = -sinY·gr - cosY·gf
    // （默认重力下 = (-sinY·cosP, sinP, -cosY·cosP)，与旧写法逐位一致）
    const hf = -sinY * cosP, hb = -cosY * cosP;
    _dir.set(
      gr.x * hf + gf.x * hb + up.x * sinP,
      gr.y * hf + gf.y * hb + up.y * sinP,
      gr.z * hf + gf.z * hb + up.z * sinP,
    ).normalize();

    if (first) {
      this.camera.position.set(eyeX + _dir.x * 0.35, eyeY + _dir.y * 0.35, eyeZ + _dir.z * 0.35);
    } else {
      _from.set(eyeX, eyeY, eyeZ);
      _to.copy(_from).addScaledVector(_dir, -this.dist);
      let use = this.dist;
      if (world) {
        _hit.reset();
        world.raycastClosest(
          new CANNON.Vec3(_from.x, _from.y, _from.z),
          new CANNON.Vec3(_to.x, _to.y, _to.z),
          { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: true },
          _hit);
        if (_hit.hasHit) {
          const d = _from.distanceTo(new THREE.Vector3(_hit.hitPointWorld.x, _hit.hitPointWorld.y, _hit.hitPointWorld.z));
          if (d < use) { use = Math.max(2.6, d - 0.5); this.occluded = true; }
          else this.occluded = false;
        } else this.occluded = false;
      }
      this.camera.position.copy(_from).addScaledVector(_dir, -use);
    }

    // 震屏
    this._applyShake(dt);

    // 侧移轻微倾斜
    const rollTarget = clamp(-player.lateral * settings.get('camera.rollAmount', 0.35) * 0.014, -0.12, 0.12);
    this.roll = damp(this.roll, player.swimming ? rollTarget * 1.6 : rollTarget, 6, dt);
    // 朝向
    if (up.x === 0 && up.y === 1 && up.z === 0) {
      // 默认重力：沿用旧的 YXZ 欧拉写法（逐位一致）
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(this.pitch, this.yaw, this.roll);
    } else {
      // 非默认重力：用重力平面基构造镜头朝向 —— 局部 -Z = 前方、局部 +Y ≈ 反重力方向
      const rX = cosY * gr.x - sinY * gf.x, rY = cosY * gr.y - sinY * gf.y, rZ = cosY * gr.z - sinY * gf.z;   // 镜头右方
      _rr.set(rX, rY, rZ);
      _ru.set(rY * _dir.z - rZ * _dir.y, rZ * _dir.x - rX * _dir.z, rX * _dir.y - rY * _dir.x);   // 上方 = 右方 × 前方
      _rb.set(-_dir.x, -_dir.y, -_dir.z);
      _rmat.makeBasis(_rr, _ru, _rb);
      this.camera.quaternion.setFromRotationMatrix(_rmat);
      if (Math.abs(this.roll) > 1e-5) this.camera.rotateZ(this.roll);   // 侧移倾斜绕镜头前轴
    }

    // FOV
    const base = settings.get('camera.fov', 78);
    const kick = settings.get('camera.fovKick', true);
    const spd = Math.hypot(player.velocity.x, player.velocity.z);
    const target = base + (kick ? clamp(spd / PLAYER.walkSpeed, 0, 2.4) * 4.2 : 0) + (player.swimming ? -4 : 0);
    this.fovKick = damp(this.fovKick || base, target, 6, dt);
    if (Math.abs(this.camera.fov - this.fovKick) > 0.05) {
      this.camera.fov = this.fovKick;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * 2D 平台模式每帧：相机只朝 n 方向，在与 n 垂直、过基准点 P 的平面内跟随玩家移动
   * （取玩家在平面上的投影作为取景中心，再沿 -n 退开 dist 得到机位）。
   */
  _updatePlatform(dt, player) {
    const pl = this.platform;
    const n = pl.normal;
    // 重力参考系：平台模式的镜头「上方向」也跟重力（默认重力下 = (0,1,0)，与旧写法一致）
    if (player._up) this.gUp = player._up;
    if (player._gRight) this.gRight = player._gRight;
    if (player._gFwd) this.gFwd = player._gFwd;
    const up = this.gUp;
    const bp = (player.body && player.body.interpolatedPosition) || player.feetPos;
    const so = player._stepVisOff || 0;
    const feet = _from.set(bp.x + up.x * so, bp.y + up.y * so, bp.z + up.z * so);
    this.lookTarget.copy(feet);
    // 玩家相对 P 的偏移在平面上的投影（去掉沿 n 的分量）
    const rel = _to.copy(feet).sub(pl.point);
    rel.addScaledVector(n, -rel.dot(n));
    const target = _dir.copy(pl.point).add(rel).addScaledVector(n, -pl.dist);
    if (!this._platInit) { this.camera.position.copy(target); this._platInit = true; }
    else {
      const k = Math.min(1, 1 - Math.pow(0.0008, dt));   // 平滑跟随，避免抖动
      this.camera.position.lerp(target, k);
    }
    // 震屏
    this._applyShake(dt);
    this.camera.up.copy(up);
    this.camera.lookAt(
      this.camera.position.x + n.x,
      this.camera.position.y + n.y,
      this.camera.position.z + n.z,
    );
    this.camera.fov = settings.get('camera.fov', 78);
    this.camera.updateProjectionMatrix();
  }

  /**
   * 震屏：位移沿重力参考系叠加（默认重力下 = 世界 X/Y/Z，与旧写法逐位一致）。
   * 放在非默认重力下也始终是「屏幕空间的抖动」，不会歪到无关的世界分量上。
   */
  _applyShake(dt) {
    if (this.shakeAmt <= 0.001) return;
    this.shakeT += dt * 34;
    const a = this.shakeAmt * settings.get('camera.shake', 1) * 0.6;
    const sx = Math.sin(this.shakeT * 1.7) * a * 0.4;
    const sy = Math.sin(this.shakeT * 2.3 + 1.1) * a * 0.4;
    const sz = Math.sin(this.shakeT * 1.9 + 2.2) * a * 0.4;
    const r = this.gRight, u = this.gUp, f = this.gFwd;
    this.camera.position.x += r.x * sx + u.x * sy + f.x * sz;
    this.camera.position.y += r.y * sx + u.y * sy + f.y * sz;
    this.camera.position.z += r.z * sx + u.z * sy + f.z * sz;
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.4);
  }

  /** 相机朝向（用于移动 / 投掷 / 交互射线） */
  forward(out = new THREE.Vector3()) {
    if (this.platform) return out.copy(this.platform.normal).normalize();
    const sinP = Math.sin(this.pitch), cosP = Math.cos(this.pitch);
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    const up = this.gUp, gr = this.gRight, gf = this.gFwd;
    // 与 update() 同一套重力参考系（默认重力下 = 旧的 (-sinY·cosP, sinP, -cosY·cosP)，逐位一致）
    const hf = -sinY * cosP, hb = -cosY * cosP;
    return out.set(
      gr.x * hf + gf.x * hb + up.x * sinP,
      gr.y * hf + gf.y * hb + up.y * sinP,
      gr.z * hf + gf.z * hb + up.z * sinP,
    ).normalize();
  }
  origin(out = new THREE.Vector3()) { return out.copy(this.camera.position); }

  get isFirstPerson() { return !this.platform && (this.mode === 'first' || this.wantDist < this.firstPersonThreshold); }

  applySettings() {
    this.maxDist = settings.get('camera.maxDistance', 90);
    this.wantDist = clamp(this.wantDist, 0, this.maxDist);
    this.camera.fov = settings.get('camera.fov', 78);
    this.camera.updateProjectionMatrix();
  }
}

export { lerp };