/* ============================================================
   液体系统：液面判定 / 氧气影响 / 伤害 / 水下表现
   判定规则（按需求）：液面淹过玩家头部才产生氧气与伤害影响
   ============================================================ */
import * as THREE from 'three';
import { PLAYER, LIQUID_KINDS } from '../config.js';
import { clamp } from '../core/util.js';
import { LIQUID_UNIFORMS } from '../core/materials.js';
import { settings } from '../core/settings.js';
import { audio } from '../core/audio.js';
import { playMatrix } from './level.js';

const _inv = new THREE.Matrix4();
const _lp = new THREE.Vector3();

export class LiquidSystem {
  constructor(builder, opts = {}) {
    this.b = builder;
    this.level = builder.level;
    this.fx = opts.fx || null;
    this.wasUnder = false;
    this.wasInside = false;
    this.underDepth = 0;
    this.current = null;       // 当前生效液体记录
    this.headUnder = false;
    this.inside = false;
  }

  /** 世界坐标点在某液体内的相对位置（归一化到液体局部 0..1） */
  _localPoint(rec, world, out) {
    // 镜像变体：网格矩阵在镜像空间里，玩家坐标在原空间 —— 先换回原空间再求局部坐标
    playMatrix(rec.mesh, this.b.mirror, _inv).invert();
    return out.copy(world).applyMatrix4(_inv);
  }

  /* 网格几何都是「单位尺寸、以原点为中心」（见 objectTypes.buildGeometry），
     因此这里收到的局部坐标就是归一化坐标，可以直接按真实形状判定。
     以前只测包围盒 → 球 / 圆柱 / 圆锥 / 多边形柱 / 圆环 / 楔形液体在水体
     之外的「盒角」也会被判成泡在水里。 */
  _insideUnit(o, x, y, z) {
    if (y < -0.5 || y > 0.5) return false;
    switch (o.shape || 'block') {
      case 'sphere':
        return x * x + y * y + z * z <= 0.25;
      case 'cylinder':
      case 'prism': {
        // 圆柱 / 多边形柱：CylinderGeometry 顶点从 θ=0 开始（x=r·sinθ, z=r·cosθ）
        if (o.shape === 'cylinder') return x * x + z * z <= 0.25;
        const n = clamp(Math.round(o.sides) || 6, 3, 32);
        const seg = (Math.PI * 2) / n;
        let off = (Math.atan2(z, x) - Math.PI / 2) % seg;
        if (off < 0) off += seg;
        const d = 0.5 * Math.cos(Math.PI / n) / Math.cos(off - seg / 2);   // 该角度上多边形边界的半径
        return Math.hypot(x, z) <= d;
      }
      case 'cone': {
        const r = 0.5 * (0.5 - y);          // 顶半径≈0、底半径 0.5
        return x * x + z * z <= r * r;
      }
      case 'torus': {
        const q = Math.hypot(x, y) - 0.35;  // 环面在 XY 平面，轴向为 Z
        return q * q + z * z <= 0.0225;     // 管半径 0.15
      }
      case 'wedge':
        return x >= -0.5 && x <= 0.5 && z >= -0.5 && z <= 0.5 && (x + y) <= 0;  // 斜面为 x+y=0
      default:
        return x >= -0.5 && x <= 0.5 && z >= -0.5 && z <= 0.5;   // 立方体 / 平面 / 未知形状
    }
  }

  /** 检测一个点是否被液体覆盖（必须落在液体自身体积内，而不是液面以下的无限空间） */
  hitPoint(rec, world) {
    const lp = this._localPoint(rec, world, _lp);
    return this._insideUnit(rec.o, lp.x, lp.y, lp.z);
  }

  inVolume(rec, world) {
    return this.hitPoint(rec, world);
  }

  /** 找到影响玩家的液体（最严重的那个） */
  probe(player) {
    const list = this.b.objectsOf('liquid');
    let best = null, head = false, inside = false;
    for (const rec of list) {
      if (!rec.liquid || rec.o.visible === false) continue;
      const o = rec.o;
      const headHit = this.hitPoint(rec, player.headPos);
      const vol = this.inVolume(rec, player.feetPos) || this.inVolume(rec, player.headPos);
      if (!headHit && !vol) continue;
      const drain = Number(o.drainRate ?? 8);
      const kill = !!o.instantKill;
      const score = (kill ? 1000 : 0) + drain;
      if (!best || score > best._score) {
        best = rec;
        best._score = score;
        head = headHit;
        inside = vol || (headHit && this.inVolume(rec, player.feetPos));
      }
    }
    this.current = best;
    this.headUnder = !!head;
    this.inside = !!inside || !!(best && head);
    return best;
  }

  /** 每帧：把液体的影响作用到玩家身上 */
  update(dt, player) {
    if (settings.get('video.waterWaves', true)) LIQUID_UNIFORMS.time.value += dt;
    const rec = this.probe(player);
    const o = rec ? rec.o : null;
    const kind = o ? (o.kind || 'water') : 'water';
    const L = LIQUID_KINDS[kind] || LIQUID_KINDS.water;

    // 给玩家环境信息（游泳 / 上浮 / 视觉）
    // 游泳判定：必须「水淹没头部」才能游泳；头露出水面时只能在水里行走 / 下沉
    player.env.inLiquid = !!rec;
    player.env.liquidRec = rec;
    player.env.liquidKind = kind;
    player.env.swim = rec ? (o.swim !== false && this.headUnder) : false;
    player.env.headUnder = this.headUnder;
    player.env.depth = rec ? this.depth(rec, player.feetPos) : 0;
    player.env.instantKill = rec ? !!o.instantKill : false;
    // 水阻(比例)：适用于任何触碰，按「身体淹没比例」插值 —— 0% 无阻力，100% 达到满阻。
    // 这里算出的是「生效水阻 = 满阻值 × 淹没比例」，玩家侧按 速度 × (1 − 生效水阻) 施加。
    // 淹没比例 = 液面高出脚底的高度 / 玩家总高，因此浅水行走只有很小的阻力，整个人沉入才吃满。
    const submerge = rec
      ? clamp((this.surfaceY(rec) - player.feetPos.y) / PLAYER.totalH, 0, 1)
      : 0;
    player.env.submerge = submerge;
    player.env.resist = rec ? Math.max(0, Number(o.waterResist ?? L.resist ?? 0)) * submerge : 0;
    // waterDrag：仅游泳状态生效（行为不变，只收窄到游泳状态）
    player.env.drag = player.env.swim ? PLAYER.waterDrag : 0;

    if (!rec) {
      if (this.wasUnder) { audio.setUnderwater(false); this.fx && this.fx.splashOut(player.headPos); }
      this.wasUnder = false;
      this.wasInside = false;
      this.underDepth = 0;
      return;
    }

    const headUnder = this.headUnder;
    // 入水 / 出水
    if (headUnder && !this.wasUnder) {
      audio.splash();
      audio.setUnderwater(true);
      this.fx && this.fx.splash(player.headPos, kind, 26);
    } else if (!headUnder && this.wasUnder) {
      audio.setUnderwater(false);
      this.fx && this.fx.splashOut(player.headPos);
    }
    if (this.inside && !this.wasInside && !headUnder) {
      audio.splash(0.5);
      this.fx && this.fx.splash(player.feetPos, kind, 12);
    }
    this.wasUnder = headUnder;
    this.wasInside = this.inside;
    this.underDepth = this.depth(rec, player.feetPos);

    // 距离水面很近时冒泡
    if (headUnder && Math.random() < dt * 6) {
      this.fx && this.fx.bubble(player.headPos, 0.5);
    }

    // ---------- 氧气 ----------
    const affected = o.headOnly === false ? this.inside : headUnder;
    const mode = o.oxygenMode || 'drain';
    if (affected && mode !== 'none') {
      if (mode === 'refill') {
        const amt = Math.max(1, Number(o.drainRate ?? 8)) * dt;
        player.addOxygen(amt);
      } else {
        const rate = Math.max(0, Number(o.drainRate ?? L.drain));
        player.takeOxygen(rate * dt, kind);
      }
    }

    // ---------- 伤害 ----------
    // 秒杀只在玩家真正「进入液体」（头部入水 / 游泳状态）时生效；
    // 仅仅踩到水面、站在浅水底部不算进入，不触发秒杀
    if (o.instantKill && this.headUnder) {
      player.kill('liquid');
      return;
    }
    const dmg = Math.max(0, Number(o.damage) || 0);
    if (dmg > 0 && affected) player.damage(dmg * dt, 'liquid');
    if (kind === 'acid' && affected && Math.random() < dt * 3) {
      this.fx && this.fx.bubble(player.headPos, 0.7);
    }
  }

  /** 玩家脚底到液面的深度（正数表示在水面以下） */
  depth(rec, world) {
    const lp = this._localPoint(rec, world, _lp);
    return (0.5 - lp.y) * Math.abs(rec.o.scale[1] || 1);
  }

  /** 设置液面高度（事件/动画用） */
  setFill(rec, v) {
    if (!rec || !rec.liquid) return;
    rec.liquid.f = clamp(Number(v) || 0, 0, 1);
    rec.o.fillLevel = rec.liquid.f;
    this.b.updateLiquidTransform(rec);
    rec.mesh.updateMatrixWorld(true);
    this.b.setupLiquid(rec);
  }

  /* 液面高度 → 世界 Y */
  surfaceY(rec) {
    if (!rec || !rec.liquid) return -Infinity;
    const o = rec.o;
    return o.position[1] + Math.max(0.001, o.scale[1]) * (rec.liquid.f - 0.5);
  }
}

export { PLAYER };