/* ============================================================
   机关系统：WallJump / 滑索 / 按钮 / 门 / 工具拾取 / 检查点 / 终点
             / 触发体积 / 伤害体积 / 投掷物
   ============================================================ */
import * as THREE from 'three';
import * as CANNON from 'cannon';
import { TOOL_DEFS, PLAYER } from '../config.js';
import { clamp, lerp, ease, deg2rad, uid, Ease } from '../core/util.js';
import { audio } from '../core/audio.js';
import { worldPosition, worldQuaternion, playMatrix, playQuat } from './level.js';
import { applyScreenGrade } from '../core/materials.js';
import { buildBoxFillGeometry } from './objectTypes.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _e = new THREE.Euler();
const _eUp = new THREE.Vector3(0, 1, 0);      // 发射方向正交基的辅助轴
const _eX = new THREE.Vector3(1, 0, 0);
const _pickO = new THREE.Vector3();      // 交互射线起点（镜像局里换算到渲染空间）
const _pickD = new THREE.Vector3();      // 交互射线方向（同上）
const _wpArr = [0, 0, 0];                // worldPosition 复用输出，避免逐帧分配

/** 加权随机：把条目权重累加成前缀和 */
function buildCum(entries) {
  const cum = new Float64Array(entries.length);
  let sum = 0;
  for (let i = 0; i < entries.length; i++) { sum += Math.max(0, Number(entries[i].weight) || 0); cum[i] = sum; }
  return sum > 0 ? { cum, sum } : null;
}
/** 按前缀和抽一个条目（r ∈ [0,1)） */
function pickCum(entries, pack, r) {
  const x = r * pack.sum;
  for (let i = 0; i < entries.length; i++) if (x < pack.cum[i]) return entries[i];
  return entries[entries.length - 1];
}

/** 纯特效体积：不参与视线交互检测（否则站在雾里会挡住按钮/门等提示） */
const EMIT_FX = new Set(['emitter', 'fogvol', 'volumelight']);

/** 攀爬检测：沿身体高度取样（相对脚底的高度，PLAYER.totalH = 5） */
const CLIMB_SAMPLES = [0.9, 2.2, 3.5];
/** WallJump 检测：沿身体高度取样（相对脚底的高度）。单点取样时矮墙/高墙容易漏判，多点更易贴上 */
const WALLJUMP_SAMPLES = [1.2, 2.2, 3.4];
/** 脚底距顶面多少 studs 以内不再判定为攀爬（爬到离顶 2 studs 就自然脱手） */
const CLIMB_TOP_STOP = 2;
/** 伤害区域默认结算频率（次/秒）：每秒结算多少次伤害；0 = 不结算 */
const DAMAGE_RATE_DEFAULT = 2;
/** 伤害区域检测：沿身体高度「从头到脚」取样（单位 stud，相对脚底；PLAYER.totalH = 5）。
    只取身体中轴，不含左右伸出的手臂（「手不判定」）；多点是为了避免只测胸口时
    脚 / 头单独探进体积却判不中。 */
const DAMAGE_SAMPLES = [0.25, 1.6, 3.0, 4.4, 4.85];
/** 伤害区域特效纹理：每格的世界边长(stud)。越大图案越大 = 越稀疏 */
const DAMAGE_TEX_STUD = 4;

/* ============================================================
   伤害区域「贴面特效」纹理（程序化生成一次后缓存，无外部素材依赖）
   图案 = 斜向警戒条纹 + 网格线。背景全透明（clearRect），条纹之间露出方块本身，
   于是既能看出「贴在方块网格上」，又不会把方块糊成一整块色斑。
   使用方式为「平铺不拉伸」：每格的世界边长 = DAMAGE_TEX_STUD(stud)，
   与方块尺寸无关（见 _ensureDamageShell 的 uv 烘焙）。
   ============================================================ */
let _dmgShellTex = null;
function damageShellTexture() {
  if (_dmgShellTex) return _dmgShellTex;
  if (typeof document === 'undefined') return null;      // 无 DOM（如 Worker）：退化成纯色辉光
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const x = c.getContext('2d');
  x.clearRect(0, 0, N, N);
  // 斜向（45°）警戒条纹：旋转后铺满整张图，任意平铺都不断裂
  x.save();
  x.translate(N / 2, N / 2);
  x.rotate(-Math.PI / 4);
  x.translate(-N / 2, -N / 2);
  const step = N / 1;
  x.fillStyle = 'rgba(255,255,255,0.9)';
  for (let i = -N; i < N * 2; i += step) x.fillRect(i, -N, step * 0.45, N * 3);
  x.restore();
  // 网格线：每 1/4 一条更亮的线，强化「贴网格」的格感
  x.strokeStyle = 'rgba(255,255,255,1)';
  x.lineWidth = 2.5;
  for (let i = 1; i < 4; i++) {
    const p = (i / 4) * N;
    x.beginPath(); x.moveTo(p, 0); x.lineTo(p, N); x.stroke();
    x.beginPath(); x.moveTo(0, p); x.lineTo(N, p); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;   // 重复次数由贴面几何的 uv 烘焙（见 _ensureDamageShell），这里固定 1
  t.repeat.set(1, 1);
  t.anisotropy = 4;
  t.needsUpdate = true;
  _dmgShellTex = t;
  return t;
}

/* ============================================================
   伤害特效的「世界深度」遮挡 —— 穿玩家可见、被世界遮挡
   ------------------------------------------------------------
   玩家模型是实心且写深度的，只要走深度测试就一定会被玩家挡住；而 three 没有
   「按物体排除深度」的开关（本项目渲染器还关了 stencil，也没法用模具缓冲）。
   做法（参考水体泡沫的深度差，见 builder.renderFoamDepth）：
     ① 额外渲一张低分辨率深度图，里面只留「实心关卡几何」——
        玩家（挂在 scene 根上）、半透明物、粒子 / 线条 / 精灵都排除在外；
     ② 贴面特效改成 depthTest=false 画在最上层（于是不会被玩家挡），
        再在片元里查这张深度图，被世界挡住的像素直接 discard。
   只在有效果激活时才渲（多数帧附近没有伤害区 → 几乎零开销）。
   ============================================================ */
const DMG_DEPTH = {
  tex: { value: null },
  res: { value: new THREE.Vector2(1, 1) },   // 主画布尺寸（归一化屏幕坐标用，与深度图分辨率无关）
  on: { value: 0 },                          // 0 = 深度图不可用（退化为普通深度测试）
};
const _dmgBufSize = new THREE.Vector2();

/** 给贴面材质注入「世界深度遮挡」：被世界挡住即 discard（玩家不在深度图里 → 不被玩家挡）。
    注意：面材质（MeshBasicMaterial）的片元着色器里有 `#include <common>`，线材质
    （LineBasicMaterial）里没有 —— 所以不能挂在 `<common>` 上，改成在 `void main()` 前直接
    声明 uniform 与检测代码（对两者都成立）。 */
function injectDamageDepth(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDmgDepth = DMG_DEPTH.tex;
    shader.uniforms.uDmgRes = DMG_DEPTH.res;
    shader.uniforms.uDmgOn = DMG_DEPTH.on;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform sampler2D uDmgDepth;
uniform vec2 uDmgRes;
uniform float uDmgOn;
void main() {
  if (uDmgOn > 0.5) {
    float sd = texture2D(uDmgDepth, gl_FragCoord.xy / uDmgRes).r;
    if (sd + 1.0e-5 < gl_FragCoord.z) discard;
  }`);
  };
  mat.customProgramCacheKey = () => 'dmg-depth';
  mat.depthTest = false;
  return mat;
}

/* ---------- OBB 相交工具 ---------- */
/** point（世界）相对单位立方体对象的局部归一化坐标 */
export function toLocal(rec, point, out = _v, mirror = false) {
  playMatrix(rec.mesh, mirror, _m).invert();
  return out.copy(point).applyMatrix4(_m);
}
/** 判断点是否在（扩张 margin 世界单位的）OBB 内，返回接触法线（世界） */
export function obbContact(target, point, margin = 0, outNormal = _v2, mirror = false) {
  const o = target.o;
  const s = o.scale || [1, 1, 1];
  const lp = toLocal(target, point, _v, mirror);
  const sx = Math.max(0.001, Math.abs(s[0])), sy = Math.max(0.001, Math.abs(s[1])), sz = Math.max(0.001, Math.abs(s[2]));
  const mx = margin / sx, my = margin / sy, mz = margin / sz;
  const dx = Math.abs(lp.x) - 0.5 - mx;
  const dy = Math.abs(lp.y) - 0.5 - my;
  const dz = Math.abs(lp.z) - 0.5 - mz;
  if (dx > 0 || dy > 0 || dz > 0) return null;
  // 穿透最浅的轴 = 接触轴。必须换算成「世界单位」再比较：
  // dx/dy/dz 是各自除以缩放后的局部量，非等比缩放时不同轴之间不可比 —— 比如又高又薄的墙，
  // 竖直穿透被 Y 缩放一除就变得很小，会被误判成最浅轴（法线变成顶/底面 → 墙判定失败）
  let axis = 0, best = -Infinity;
  const arr = [dx * sx, dy * sy, dz * sz];
  for (let i = 0; i < 3; i++) if (arr[i] > best) { best = arr[i]; axis = i; }
  const sign = [lp.x, lp.y, lp.z][axis] >= 0 ? 1 : -1;
  const n = outNormal.set(0, 0, 0);
  n.setComponent(axis, sign);
  // 转到世界（去除缩放影响）
  n.applyQuaternion(playQuat(target.mesh, mirror, _q)).normalize();
  return { normal: n, axis, sign, point: lp.clone(), depth: -best };
}

/**
 * 攀爬墙用：obbContact 判定出的接触轴是竖直轴（顶面/底面）时，改判为「较浅的那个水平轴」。
 * 攀爬面只看侧面 —— 玩家贴墙往上爬到顶面附近时，取样点的最浅穿透轴必然翻成竖直轴，
 * 若按普通逻辑丢弃这一帧，玩家就会在离顶还剩一步时脱手（爬不上去）。
 * 取样点在横向已经离开墙面（超出扩张 reach 后的范围），或横向仍在实体内部（站在顶面上）时返回 false。
 */
function climbFaceAxis(rec, point, reach, c, mirror = false) {
  const o = rec.o;
  const s = o.scale || [1, 1, 1];
  const lp = toLocal(rec, point, _v, mirror);
  const sx = Math.max(0.001, Math.abs(s[0])), sz = Math.max(0.001, Math.abs(s[2]));
  // 到实体侧面的横向外距（世界单位）：侧面在 |lp| * scale = 0.5 * scale 处
  const ox = Math.abs(lp.x) * sx - 0.5 * sx;
  const oz = Math.abs(lp.z) * sz - 0.5 * sz;
  // 必须横向「在实体侧面的外侧」才算贴墙。站在实体顶面 / 底面时横向坐标仍落在实体内，
  // 若这里也算贴墙，玩家站上墙顶边缘就会误吸附，且贴面目标点在实体内部 →
  // 攀爬的贴面力（stick）会把玩家按进实体里（穿墙）→ 所以直接判为不贴墙
  if (ox <= 0 && oz <= 0) return false;
  const dx = ox - reach, dz = oz - reach;
  if (dx > 0 || dz > 0) return false;                            // 已经横向离开墙面
  const axis = dx > dz ? 0 : 2;
  const sign = (axis === 0 ? lp.x : lp.z) >= 0 ? 1 : -1;
  c.axis = axis;
  c.sign = sign;
  c.normal.set(0, 0, 0).setComponent(axis, sign).applyQuaternion(playQuat(rec.mesh, mirror, _q)).normalize();
  c.point.copy(lp);
  c.depth = -(axis === 0 ? dx : dz);
  return true;
}

/* ============================================================
   机制管理器
   ============================================================ */
export class Mechanisms {
  constructor(builder, opts = {}) {
    this.b = builder;
    this.fx = opts.fx || null;
    this.fxSoft = opts.fxSoft || null;   // 柔和粒子池（粒子发射器 soft 模式用）
    this.events = opts.events || null;
    this.hooks = opts.hooks || {};       // { onWin, onDeath, onPrompt, onPickup, onChange }
    this.projectiles = [];
    this.prompt = null;
    this.tmpVec = new THREE.Vector3();
  }

  /** 玩法空间的 OBB 接触检测：镜像变体下自动把对象矩阵换回原空间（见 level.js 的 playMatrix） */
  obb(rec, point, margin = 0, outNormal) {
    return obbContact(rec, point, margin, outNormal, !!this.b.mirror);
  }

  /** 玩家身体某高度处的探测点（沿重力反方向抬高 h，默认重力下 = feetPos.y + h），写进 out */
  _bodyProbe(player, h, out) {
    const fp = player.feetPos;
    const up = player._up || { x: 0, y: 1, z: 0 };
    return out.set(fp.x + up.x * h, fp.y + up.y * h, fp.z + up.z * h);
  }

  /* ============================================================
     WallJump：找墙 / 贴墙判定
     ============================================================ */
  findWalljump(player) {
    const list = this.b.objectsOf('walljump');
    if (!list.length) return null;
    const fx = player.feetPos.x, fy = player.feetPos.y, fz = player.feetPos.z;
    const reach = PLAYER.wallJumpReach;
    // 玩家当前的重力方向（贴墙判定用）：默认重力下 = (0,-1,0)
    const dn = player._down || { x: 0, y: -1, z: 0 };
    let best = null;
    // 沿身体高度多点取样：只测胸口一点时，矮墙（低于胸口）或高台边缘都会漏判 → 任一点命中即可贴墙
    for (const rec of list) {
      for (let i = 0; i < WALLJUMP_SAMPLES.length; i++) {
        const hOff = WALLJUMP_SAMPLES[i];   // 沿重力反方向抬高取样点（默认重力下 = y + hOff）
        _v3.set(fx - dn.x * hOff, fy - dn.y * hOff, fz - dn.z * hOff);   // 注意：不可用 _v，obbContact 内部会写它
        const c = this.obb(rec, _v3, reach);
        if (!c) continue;
        // 「顶面 / 底面」不算墙：法线接近玩家重力轴的面（默认重力下即原来的 |n.y| 判据）不算
        if (Math.abs(c.normal.x * dn.x + c.normal.y * dn.y + c.normal.z * dn.z) > PLAYER.wallJumpMaxTilt) continue;
        if (!best || c.depth < best.depth) best = { rec, normal: c.normal.clone(), depth: c.depth };
      }
    }
    return best;
  }

  applyWalljumpLaunch(player, wall) {
    const n = wall.normal;
    const o = wall.rec.o;
    // 持续推力：在对象自己的「推进持续时间」内维持弹射速度（只给一次冲量会被空中急停立刻吃掉）
    player.startWallLaunch(
      n.x, n.z,
      Number.isFinite(Number(o.pushOut)) ? Number(o.pushOut) : PLAYER.wallJumpPushOut,
      Number.isFinite(Number(o.pushY)) ? Number(o.pushY) : PLAYER.wallJumpPushY,
      Number.isFinite(Number(o.pushTime)) ? Number(o.pushTime) : PLAYER.wallJumpPushTime,
    );
    // 朝向 = 背对墙面（在重力平面内的偏航角；默认重力下 = atan2(-n.x, -n.z)，与旧写法一致）
    player.yaw = player._planeYaw ? player._planeYaw(-n.x, -n.y, -n.z) : Math.atan2(-n.x, -n.z);
    audio.jump(0.85);
    this.fx && this.fx.sparkle(player.feetPos, '#8ef5c8', 14, 4);
    this.emitObjectEvent(wall.rec.o, 'touch');
  }

  /* ============================================================
     攀爬墙：与梯子同功能，形状/尺寸由对象自定义
     ============================================================ */
  /** 玩家胸口是否贴在某个攀爬体积上（返回 {rec, normal, axis, point, depth}） */
  findClimb(player) {
    const list = this.b.objectsOf('climb');
    if (!list.length) return null;
    // 沿身体高度多取样：脚 / 腰 / 胸 / 头，任一取样点贴住攀爬面即算接触。
    // 单点取样在「速爬」高速上升或身体与墙面成角度时容易漏判，导致中途脱手。
    const fx = player.feetPos.x, fy = player.feetPos.y, fz = player.feetPos.z;
    const reach = PLAYER.climbReach;
    const up = player._up || { x: 0, y: 1, z: 0 };   // 重力反方向（默认重力下 = (0,1,0)）
    let best = null;
    for (const rec of list) {
      if (!rec.mesh || rec.o.visible === false) continue;
      // 脚底距顶面 ≤ CLIMB_TOP_STOP studs 就不再判定为攀爬。沿墙自身的高度方向量
      // （倾斜的墙面也按墙面自己的「上」算），所以用脚底的局部 y 换算成世界距离。
      const sy = Math.max(0.001, Math.abs((rec.o.scale || [1, 1, 1])[1]));
      const feetLocal = toLocal(rec, _v3.set(fx, fy, fz), _v, this.b.mirror);
      if ((0.5 - feetLocal.y) * sy <= CLIMB_TOP_STOP) continue;
      for (let i = 0; i < CLIMB_SAMPLES.length; i++) {
        const hOff = CLIMB_SAMPLES[i];
        _v3.set(fx + up.x * hOff, fy + up.y * hOff, fz + up.z * hOff);   // 沿重力方向取样（默认重力下 = y + hOff）
        const c = this.obb(rec, _v3, reach);
        if (!c) continue;
        // 顶面/底面本身不是攀爬面（那是站脚的地方）；但爬到墙顶附近时取样点的最浅穿透轴
        // 会从侧面翻成竖直轴，若直接丢帧玩家会在离顶一步时脱手 → 改用较浅的水平轴继续算贴墙
        if (c.axis === 1 && !climbFaceAxis(rec, _v3, reach, c, this.b.mirror)) continue;
        // 接近水平的面（相对玩家重力而言）不算，防止把地板 / 天花板当墙爬
        if (Math.abs(c.normal.x * up.x + c.normal.y * up.y + c.normal.z * up.z) > PLAYER.climbMaxTilt) continue;
        if (!best || c.depth < best.depth) best = { rec, normal: c.normal.clone(), axis: c.axis, point: c.point, depth: c.depth };
      }
    }
    return best;
  }

  /* ============================================================
     点击触发（点击触发器 / 按钮被鼠标点击）
     ============================================================ */
  /** 点击触发器的冷却计时（按钮的冷却在 updateButtons 里） */
  updateClicks(dt) {
    for (const rec of this.b.objectsOf('click')) {
      const st = rec.state;
      if (st.cool > 0) st.cool = Math.max(0, st.cool - dt);
    }
  }

  /** 玩家是否在点击触发器的「最大点击范围」内（玩家脚底 → 触发器中心直线距离）；0 = 不限距离 */
  inClickRange(rec, player) {
    const max = Number(rec.o.clickRange) || 0;
    if (max <= 0 || !player) return true;
    const wp = worldPosition(this.b.level, rec.o);
    const p = player.feetPos;
    return Math.hypot(wp[0] - p.x, wp[1] - p.y, wp[2] - p.z) <= max;
  }

  fireClick(rec, player) {
    if (!rec) return false;
    if (rec.type === 'click' && !this.inClickRange(rec, player)) return false;
    const o = rec.o;
    const st = rec.state;
    if (st.cool === undefined) { st.cool = 0; st.clicked = false; }
    if (st.cool > 0) return false;
    if (o.once && st.clicked) return false;
    st.clicked = true;
    st.cool = Math.max(0, Number(o.cooldown) || 0);
    // 声效方块：点击即播放
    if (rec.type === 'soundblock') {
      this.playBlockSound(rec, worldPosition(this.b.level, o));
      this.emitObjectEvent(o, 'touch');
      this.emitObjectEvent(o, 'enter');
      return true;
    }
    if (o.clickEffect !== false) {
      const wp = new THREE.Vector3(...worldPosition(this.b.level, o));
      this.fx && this.fx.hit(wp, o.color || '#c9a8ff', 12);
    }
    audio.click();
    this.emitObjectEvent(o, 'touch');
    this.emitObjectEvent(o, 'enter');
    this.hooks.onButton && this.hooks.onButton(rec);
    return true;
  }

  /* ============================================================
     粒子发射器：体积内持续生成粒子（不参与碰撞）
     ============================================================ */
  updateEmitters(dt) {
    const list = this.b.objectsOf('emitter');
    if (!list.length) return;
    for (const rec of list) {
      const o = rec.o;
      if (o.visible === false) continue;
      const st = rec.state;
      if (st.acc === undefined) st.acc = 0;
      const rate = Math.max(0, Number(o.rate) || 0);
      if (rate <= 0) continue;
      st.acc += rate * dt;
      let n = Math.floor(st.acc);
      if (n <= 0) continue;
      st.acc -= n;
      if (n > 48) n = 48;                                  // 单帧上限，避免卡顿
      const pool = (o.soft === true && this.fxSoft) ? this.fxSoft : (this.fx || this.fxSoft);
      if (!pool) continue;
      const wp = worldPosition(this.b.level, o);
      const s = o.scale || [1, 1, 1];
      const mode = o.emitShape || 'volume';

      /* ---------- 发射方向 + 发散度 ----------
         dirEmit=true 时走「方向 + 圆锥/球」模型：spread=0° 一条直线，越大越散，
         180° 即整球；false 时沿用旧版随机喷射（老关卡 / 程序化装饰不受影响）。 */
      const useDir = o.dirEmit === true;
      const base = _v, uAx = _v2, vAx = _v3;
      let cosMax = -1;
      if (useDir) {
        const dl = o.emitDir || [0, 1, 0];
        base.set(Number(dl[0]) || 0, Number(dl[1]) || 0, Number(dl[2]) || 0);
        if (base.lengthSq() < 1e-6) base.set(0, 1, 0);
        base.normalize().applyQuaternion(worldQuaternion(this.b.level, o, _q));
        const spread = clamp(Number(o.spread ?? 30), 0, 180);
        cosMax = Math.cos(deg2rad(spread));
        // 与 base 垂直的一组正交基，用来在圆锥内均匀取方向
        const helper = Math.abs(base.y) < 0.99 ? _eUp : _eX;
        uAx.crossVectors(base, helper).normalize();
        vAx.crossVectors(base, uAx).normalize();
      }

      /* ---------- 粒子条目（图像 + 扭曲/蒙版动画 + 权重） ---------- */
      const entries = Array.isArray(o.particles)
        ? o.particles.filter((e) => e && e.on !== false && (Number(e.weight) || 0) > 0)
        : null;
      const cum = entries && entries.length ? buildCum(entries) : null;
      const baseSpeed = Number(o.speed) || 6;

      for (let i = 0; i < n; i++) {
        let rx = 0, ry = 0, rz = 0;
        if (mode === 'surface') {
          const ax = Math.floor(Math.random() * 3);
          const sg = Math.random() < 0.5 ? 0.5 : -0.5;
          const r = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
          r[ax] = sg;
          rx = r[0]; ry = r[1]; rz = r[2];
        } else if (mode !== 'point') {
          rx = Math.random() - 0.5; ry = Math.random() - 0.5; rz = Math.random() - 0.5;
        }

        const opt = {
          color: o.color || '#ffd98a',
          size: Math.max(0.1, Number(o.size) || 3) * (0.7 + Math.random() * 0.6),
          speed: baseSpeed,
          up: Number(o.up ?? 0.6),
          life: Math.max(0.05, Number(o.life) || 1.6) * (0.75 + Math.random() * 0.5),
          gravity: Number(o.gravity ?? 20),
          drag: Number(o.drag ?? 1.6),
          rise: Number(o.rise ?? 0),
          alpha: Number(o.alpha ?? 0.9),
        };

        if (cum) {
          const e = pickCum(entries, cum, Math.random());
          opt.tex = pool.texIndex(e.img);
          opt.anim = Number(e.anim) | 0;
          opt.seed = Math.random();
        }

        if (useDir) {
          // 在 base 为轴、半顶角 spread 的圆锥（或整球）内均匀取方向
          const cosT = 1 - Math.random() * (1 - cosMax);
          const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
          const phi = Math.random() * Math.PI * 2;
          const cp = Math.cos(phi), sp2 = Math.sin(phi);
          const dx = base.x * cosT + (uAx.x * cp + vAx.x * sp2) * sinT;
          const dy = base.y * cosT + (uAx.y * cp + vAx.y * sp2) * sinT;
          const dz = base.z * cosT + (uAx.z * cp + vAx.z * sp2) * sinT;
          const spd = baseSpeed * (0.7 + Math.random() * 0.6);
          opt.dir = [dx * spd, dy * spd, dz * spd];
        }

        pool.emit(wp[0] + rx * s[0], wp[1] + ry * s[1], wp[2] + rz * s[2], opt);
      }
    }
  }

  /* ============================================================
     滑索
     ============================================================ */
  /** 滑索头部（起点）世界坐标 */
  zipHead(rec, out = _v3) {
    return rec.zip.pointAt(0, out);
  }

  /** 玩家身体胶囊到某点的最近距离 */
  distToPlayer(player, p) {
    // 到玩家「胶囊轴（脚底→头顶）」沿重力方向的距离：先把 p 相对脚底的偏移分解为
    // 沿重力分量 + 横向分量，沿重力分量夹在 [0, 身高] 内再合成（默认重力下 = 原来的 y 夹取版）
    const fp = player.feetPos, hp = player.headPos;
    const up = player._up || { x: 0, y: 1, z: 0 };
    const vx = p.x - fp.x, vy = p.y - fp.y, vz = p.z - fp.z;
    const along = vx * up.x + vy * up.y + vz * up.z;
    const lx = vx - up.x * along, ly = vy - up.y * along, lz = vz - up.z * along;
    const hx = hp.x - fp.x, hy = hp.y - fp.y, hz = hp.z - fp.z;
    const total = hx * up.x + hy * up.y + hz * up.z;
    const c = clamp(along, 0, total);
    const da = along - c;
    return Math.hypot(lx, ly, lz, da);
  }

  /**
   * 找可抓取的滑索：只在滑索「头部」（起点）的球形范围内判定
   * （不像以前那样逐段比对整条缆绳），球体贴着玩家胶囊，更容易触发。
   */
  findZipline(player, radius = PLAYER.zipGrabRadius) {
    let best = null;
    for (const rec of this.b.objectsOf('zipline')) {
      if (!rec.zip) continue;
      const d = this.distToPlayer(player, this.zipHead(rec));
      if (d <= radius && (!best || d < best.dist)) best = { rec, dist: d, t: 0 };
    }
    return best;
  }

  /** 靠近滑索头部即自动抓住（触碰开始端就开始滑） */
  updateZiplines(dt, player) {
    if (player.onZipline || !player.alive || player.zipCool > 0) return;
    const z = this.findZipline(player);
    if (z) this.attachZipline(player, z.rec, 0);
  }

  attachZipline(player, rec, startT = 0) {
    player.zipline = {
      rec,
      d: clamp(startT, 0, 1) * rec.zip.total,
      speed: rec.o.speed || 52,
      dir: 1,
    };
    player.state = 'zipline';
    player.onZipline = true;
    player.jumpBuf = 0;
    player.setAnchored(true);               // 上索即锚定：物理不再插手，位置完全由滑索驱动
    player.body.collisionResponse = false;
    player.body.velocity.set(0, 0, 0);
    audio.zipline();
    return true;
  }

  detachZipline(player, launched = true) {
    const z = player.zipline;
    player.zipline = null;
    player.onZipline = false;
    player.setAnchored(false);              // 滑到末端（或死亡重生）才解开锚固，中途不脱离
    player.body.collisionResponse = true;
    player.state = 'normal';
    if (z && launched) {
      const rec = z.rec;
      const t = clamp(z.d / rec.zip.total, 0, 1);
      const tan = rec.zip.tangentAt(t, _v).normalize();
      // 末端抛出速度：0 = 竖直掉落，越大抛得越远。沿缆绳末端方向抛出，
      // 末端向下倾斜时只取水平分量，避免刚脱索就被砸向地面
      const push = Math.max(0, Number(rec.o.exitPush ?? 26));
      // 「向上」分量取切线沿重力反方向的分量（默认重力下 = tan.y），避免刚脱索就被砸向地面
      const up = player._up || { x: 0, y: 1, z: 0 };
      const dn = player._down || { x: 0, y: -1, z: 0 };
      const upComp = tan.x * up.x + tan.y * up.y + tan.z * up.z;
      const vyUp = Math.max(0, upComp) * push * 0.5;
      const bv = player.body.velocity;
      bv.set(tan.x * push, tan.y * push, tan.z * push);
      // 把「沿重力方向的分量」替换为 −vyUp（默认重力下 = 把 v.y 设为 vyUp）
      const k = (-vyUp) - (bv.x * dn.x + bv.y * dn.y + bv.z * dn.z);
      bv.x += dn.x * k; bv.y += dn.y * k; bv.z += dn.z * k;
      player.velocity.copy(bv);
    }
    return true;
  }

  updateZipline(player, dt) {
    const z = player.zipline;
    if (!z) return;
    const rec = z.rec;
    const o = rec.o;
    z.speed = Math.min((o.speed || 52) * 1.6, z.speed + (o.accel || 22) * dt);
    z.d += z.speed * dt * z.dir;
    const total = rec.zip.total;
    if (z.d >= total) {
      z.d = total;
      this.detachZipline(player, true);
      return;
    }
    if (z.d <= 0) { z.d = 0; this.detachZipline(player, true); return; }
    const t = clamp(z.d / total, 0, 1);
    const p = rec.zip.pointAt(t, _v);
    const tan = rec.zip.tangentAt(t, _v2);
    const hang = 3.7;
    const up = player._up || { x: 0, y: 1, z: 0 };
    // 吊挂 = 从缆绳点沿重力方向下移 hang（默认重力下 = y − hang）
    player.setFeet(p.x - up.x * hang, p.y - up.y * hang, p.z - up.z * hang);
    player.velocity.set(tan.x * z.speed, tan.y * z.speed, tan.z * z.speed);
    // 朝向 = 沿滑索前进方向（重力平面内的偏航角；默认重力下 = atan2(-tan.x, -tan.z)）
    player.yaw = player._planeYaw ? player._planeYaw(-tan.x, -tan.y, -tan.z) : Math.atan2(-tan.x, -tan.z);
  }

  /* ============================================================
     按钮
     ============================================================ */
  updateButtons(dt, player) {
    for (const rec of this.b.objectsOf('button')) {
      if (!rec.mesh || rec.o.visible === false) continue;
      const o = rec.o;
      const st = rec.state;
      if (st.cool === undefined) { st.cool = 0; st.pressed = false; st.used = false; st.touch = false; st.contact = false; st.n = null; }
      st.cool = Math.max(0, st.cool - dt);
      // 接触判定一律用「基座位置」：按钮按下后本体是会移动的，
      // 拿移动后的位置判定会在「接触 → 退开 → 丢失接触 → 弹回」之间循环，按钮就会抽搐
      rec.mesh.position.set(o.position[0], o.position[1], o.position[2]);
      rec.mesh.updateMatrixWorld(true);
      const probe = this._bodyProbe(player, 2.2, _v);
      const c = this.obb(rec, probe, st.touch ? 1.25 : 1.05);   // 已接触时放宽一点，边界上不反复通断
      const depth = Math.max(0, Number(o.pressDepth) || 0.5);
      const touching = !!c;   // 只有玩家身体接触才会按下（按钮已不支持鼠标点击）
      st.touch = touching;
      // 压入方向：按玩家贴在按钮的哪个「侧面」来定，而不是取穿透最浅的轴。
      // 又高又薄的按钮上，穿透最浅的轴会在 X/Y/Z 之间来回跳，按钮就会朝不同方向乱窜。
      // 方向只在刚接触那一帧定一次，按住期间锁住；松开时保留，回弹才不会拐到别的轴上
      if (c) {
        if (!st.contact) {
          const lp = c.point;
          const s = o.scale || [1, 1, 1];
          const ex = (Math.abs(lp.x) - 0.5) * Math.abs(s[0] || 1);   // 该面「露在外面」的世界距离
          const ez = (Math.abs(lp.z) - 0.5) * Math.abs(s[2] || 1);
          const ax = ez >= ex ? 2 : 0;
          const sg = (ax === 2 ? lp.z : lp.x) >= 0 ? 1 : -1;
          _v2.set(0, 0, 0).setComponent(ax, sg);
          _v2.applyQuaternion(playQuat(rec.mesh, this.b.mirror, _q)).normalize();
          st.n = [_v2.x, _v2.y, _v2.z];
        }
        st.contact = true;
      } else st.contact = false;
      st.target = touching ? depth : 0;           // 正值 = 沿接触法线反向压入（远离玩家的一侧）
      st.cur = lerp(st.cur ?? 0, st.target, 1 - Math.exp(-16 * dt));
      let n = st.n;
      if (!n) {
        // 兜底：没有记录过接触方向时，沿自身正面法线（本地 -Z）压入
        _v3.set(0, 0, -1).applyQuaternion(playQuat(rec.mesh, this.b.mirror, _q)).normalize();
        n = [_v3.x, _v3.y, _v3.z];
      }
      rec.mesh.position.set(o.position[0] - n[0] * st.cur, o.position[1] - n[1] * st.cur, o.position[2] - n[2] * st.cur);
      if (this.b.onHot) this.b.onHot(rec.mesh);
      const down = st.cur > depth * 0.55;
      if (down && !st.pressed && st.cool <= 0 && !(o.once && st.used)) {
        st.pressed = true; st.cool = Number(o.cooldown) || 0.25; st.used = true;
        audio.click();
        this.fx && this.fx.hit(_v.set(o.position[0], o.position[1], o.position[2]), o.color || '#ff7fd0', 10);
        this.emitObjectEvent(o, 'touch');
        this.emitObjectEvent(o, 'enter');
        this.hooks.onButton && this.hooks.onButton(rec);
      } else if (!down && st.pressed) {
        st.pressed = false;
        this.emitObjectEvent(o, 'exit');
      }
      // 按住模式：持续触发
      if (o.holdMode && down && st.cool <= 0) {
        st.cool = Math.max(0.08, Number(o.cooldown) || 0.25);
        this.emitObjectEvent(o, 'touch');
      }
    }
  }

  /* ============================================================
     门
     ============================================================ */
  updateDoors(dt) {
    for (const rec of this.b.objectsOf('door')) {
      const st = rec.state;
      if (st.t === undefined) {
        st.t = rec.o.open ? 1 : 0;
        st.auto = 0;
        st.base = {
          pos: new THREE.Vector3(...rec.o.position),
          quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(
            deg2rad(rec.o.rotation[0]), deg2rad(rec.o.rotation[1]), deg2rad(rec.o.rotation[2]))),
        };
        this.applyDoorState(rec, st.t);
      }
      if (st.auto > 0) {
        st.auto -= dt;
        if (st.auto <= 0) this.closeDoor(rec, true);
      }
      const speed = 1 / Math.max(0.05, Number(rec.o.openTime) || 0.8);
      const goal = st.want || 0;
      if (Math.abs(st.t - goal) > 0.001) {
        const dir = Math.sign(goal - st.t);
        st.t = clamp(st.t + dir * speed * dt, 0, 1);
        if (dir > 0 && st.t > goal) st.t = goal;
        if (dir < 0 && st.t < goal) st.t = goal;
        this.applyDoorState(rec, st.t);
      }
    }
  }

  applyDoorState(rec, t) {
    const o = rec.o;
    const st = rec.state;
    if (!st.base) return;
    const f = ease('easeInOut', t);
    const mode = o.openMode || 'slide';
    const base = st.base;
    const s = o.scale;
    if (mode === 'slide') {
      const off = (Number(o.openAmount) || 1) * s[0] * 0.98 * f;
      const local = new THREE.Vector3(-off, 0, 0).applyQuaternion(base.quat);
      _v.copy(base.pos).add(local);
      this.setDoorTransform(rec, _v, base.quat);
    } else if (mode === 'swing') {
      const ang = (Number(o.openAmount) || 1) * Math.PI * 0.5 * f;
      const pivotLocal = new THREE.Vector3(-s[0] / 2, 0, 0);
      const pivotWorld = _v2.copy(pivotLocal).applyQuaternion(base.quat).add(base.pos);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
      const rel = new THREE.Vector3().copy(base.pos).sub(pivotWorld);
      rel.applyQuaternion(q);
      _v.copy(pivotWorld).add(rel);
      const nq = _q.copy(base.quat).premultiply(q).normalize();
      this.setDoorTransform(rec, _v, nq);
    } else if (mode === 'sink') {
      const off = (Number(o.openAmount) || 1) * s[1] * 0.98 * f;
      _v.set(o.position[0], o.position[1] - off, o.position[2]);
      this.setDoorTransform(rec, _v, base.quat);
    } else {
      // fade：只做透明度
      this.setDoorTransform(rec, base.pos, base.quat);
      if (rec.meshes) for (const m of rec.meshes) {
        if (m.isMesh && m.material) {
          m.material.transparent = true;
          m.material.opacity = clamp(1 - f, 0.001, 1);
          m.material.depthWrite = f < 0.5;
          if (this.b.onState) this.b.onState(m);
        }
      }
    }
    const blocked = t > 0.45 && mode !== 'fade';
    if (rec.body) {
      rec.body.collisionResponse = !blocked;
      if (rec.body.type === CANNON.Body.STATIC) {
        rec.body.aabbNeedsUpdate = true;
        rec.body.updateAABB();
      }
    }
  }

  setDoorTransform(rec, pos, quat) {
    if (rec.mesh) {
      rec.mesh.position.copy(pos);
      rec.mesh.quaternion.copy(quat);
      rec.mesh.updateMatrixWorld(true);
    }
    if (rec.body) {
      const parentNode = rec.o.parent ? this.b.groupNodes.get(rec.o.parent) : null;
      if (parentNode) {
        parentNode.updateMatrixWorld(true);
        const inv = playMatrix(parentNode, this.b.mirror, _m2).invert();
        _m.compose(pos, quat, new THREE.Vector3(1, 1, 1)).premultiply(inv);
        // 父级带缩放时 _m 含缩放，必须 decompose 掉只取旋转，
        // 否则 setFromRotationMatrix 会得到非单位四元数、把碰撞体放大
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        _m.decompose(p, q, s);
        rec.body.position.set(p.x, p.y, p.z);
        rec.body.quaternion.set(q.x, q.y, q.z, q.w);
      } else {
        rec.body.position.set(pos.x, pos.y, pos.z);
        rec.body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
      }
      rec.body.aabbNeedsUpdate = true;
      rec.body.updateAABB();
    }
    if (rec.helperGroup) {
      rec.helperGroup.position.copy(pos);
      rec.helperGroup.quaternion.copy(quat);
    }
    // 子级锚点与本体同级、共享同一坐标系：门/机关运动时不走 builder.syncTransform，
    // 所以这里要把变换同步给锚点，挂在门下的子对象才能跟着门一起开关
    const anchor = this.b.groupNodes.get(rec.id);
    if (anchor) {
      anchor.position.copy(pos);
      anchor.quaternion.copy(quat);
    }
    // 渲染热通道：门/机关本体 + 子级锚点（挂在门下的子对象）一起推送
    if (this.b.onHot) {
      this.b.onHot(rec.mesh, true);
      if (anchor) this.b.onHot(anchor, true);
    }
  }

  openDoor(rec, silent) {
    if (!rec || rec.type !== 'door') return false;
    const st = rec.state;
    if (st.t === undefined) this.updateDoors(0);
    if ((st.want || 0) >= 1) return false;
    st.want = 1;
    st.auto = Number(rec.o.autoClose) > 0 ? Number(rec.o.autoClose) : 0;
    rec.o.open = true;
    if (!silent) audio.door();
    return true;
  }
  closeDoor(rec, silent) {
    if (!rec || rec.type !== 'door') return false;
    const st = rec.state;
    if (st.t === undefined) this.updateDoors(0);
    st.want = 0;
    st.auto = 0;
    rec.o.open = false;
    if (!silent) audio.door(1.2);
    return true;
  }

  /* ---------- 门交互（需要工具） ---------- */
  /** 指定了具体工具对象时，返回该对象（含名字），否则 null */
  requiredToolObject(rec) {
    const id = rec.o && rec.o.requiredToolId;
    if (!id) return null;
    const r = this.b && this.b.objects.get(id);
    return r ? r.o : null;
  }

  canOpenDoor(player, rec) {
    const o = rec.o;
    const ref = this.requiredToolObject(rec);
    if (ref) {
      const need = ref.id;
      const has = player.inventory && player.inventory.hasSource(need);
      const nm = ref.name || (TOOL_DEFS[ref.tool] || { label: '工具' }).label || '工具';
      return {
        ok: has,
        label: has ? `按 左键 用「${nm}」开门` : (o.lockLabel || `需要「${nm}」`),
        need,
        needObject: ref,
        has,
      };
    }
    const need = o.requiredTool;
    if (!need) return { ok: true, label: '按 左键 开门' };
    const has = player.hasTool(need);
    const L = TOOL_DEFS[need] || { label: need };
    return {
      ok: has,
      label: has ? `按 左键 用 ${L.label} 开门` : (o.lockLabel || `需要${L.label}`),
      need,
      has,
    };
  }

  /* ============================================================
     工具拾取
     ============================================================ */
  updatePickups(dt, player) {
    for (const rec of this.b.objectsOf('tool')) {
      const o = rec.o;
      const st = rec.state;
      if (st.hidden === undefined) { st.hidden = false; st.timer = 0; }
      if (st.hidden) {
        st.timer -= dt;
        if (st.timer <= 0 && Number(o.respawnTime) > 0) {
          st.hidden = false;
          if (rec.mesh) { rec.mesh.visible = rec.visible; if (this.b.onState) this.b.onState(rec.mesh); }
          this.fx && this.fx.sparkle(_v.set(o.position[0], o.position[1], o.position[2]), o.color || '#8ef5c8', 16, 6);
        }
        continue;
      }
      if (rec.mesh) {
        if (o.spin !== false) {
          rec.mesh.rotation.y += dt * 1.6;
          rec.mesh.position.y = o.position[1] + Math.sin(this.b.time * 2 + o.position[0]) * 0.6;
        }
        rec.mesh.visible = rec.visible;
        if (this.b.onHot) this.b.onHot(rec.mesh);
      }
      const probe = this._bodyProbe(player, 2.5, _v);
      const c = this.obb(rec, probe, 1.4);
      if (!c) continue;
      const item = this.makeToolItem(o, rec);
      // 每人拾取上限：背包持有 + 本局已拾取 达到上限则无法拾取（默认 1，0 = 不限制）
      const limit = o.pickupLimit === undefined ? 1 : Math.max(0, Number(o.pickupLimit) || 0);
      if (limit > 0 && player.toolHeldCount(item) >= limit) continue;
      const px = o.position[0], py = o.position[1], pz = o.position[2];
      // 氧气球：即拿即用，直接「拓展」氧气（可超出上限），不进入背包
      if (item.type === 'oxygen') {
        player.addOxygen(item.oxygenAmount || 35, true);
        player.markToolPicked(item);
        audio.pickup();
        this.fx && this.fx.sparkle(_v.set(px, py, pz), o.color || '#7fe3ff', 22, 7);
        this.hooks.onPickup && this.hooks.onPickup(item);
        this._consumePickup(o, rec, st);
        this.emitObjectEvent(o, 'touch');
        continue;
      }
      player.giveTool(item);
      player.markToolPicked(item);
      audio.pickup();
      this.fx && this.fx.sparkle(_v.set(px, py, pz), o.color || '#8ef5c8', 22, 7);
      this.hooks.onPickup && this.hooks.onPickup(item);
      this._consumePickup(o, rec, st);
      this.emitObjectEvent(o, 'touch');
    }
  }

  /** 拾取后的消耗处理：一次性则隐藏（可配置重生），否则进入冷却 */
  _consumePickup(o, rec, st) {
    if (o.oneTime !== false) {
      st.hidden = true;
      st.timer = Number(o.respawnTime) || 0;
      if (rec.mesh) rec.mesh.visible = false;
      if (st.timer <= 0) { st.hidden = true; st.timer = Infinity; if (rec.mesh) rec.mesh.visible = false; }
      if (rec.mesh && this.b.onState) this.b.onState(rec.mesh);
    } else {
      st.timer = 1.2;
    }
  }

  /** 死亡/重生后重置所有拾取点：恢复显示并清空计时（又能再拿） */
  resetPickups() {
    for (const rec of this.b.objectsOf('tool')) {
      const st = rec.state;
      st.hidden = false;
      st.timer = 0;
      if (rec.mesh) { rec.mesh.visible = rec.visible; if (this.b.onState) this.b.onState(rec.mesh); }
    }
  }

  makeToolItem(o, rec) {
    const def = TOOL_DEFS[o.tool] || TOOL_DEFS.custom;
    return {
      key: uid('tool'),
      type: o.tool || 'custom',
      name: o.toolName || def.label,
      icon: o.toolIcon || def.icon,
      count: Number(o.count) || 1,
      oxygenAmount: Number(o.oxygenAmount) || 35,
      targetIds: Array.isArray(o.targetIds) ? o.targetIds.slice() : [],
      targetTag: o.targetTag || '',
      throwSpeed: Number(o.throwSpeed) || 0,
      projLifeTime: Number(o.projLifeTime) || 0,
      useEvent: o.useEvent || '',
      sourceId: rec ? rec.id : '',
    };
  }

  /* ============================================================
     检查点 / 终点 / 伤害体积 / 触发器
     ============================================================ */
  updateZones(dt, player) {
    // 本帧是否有伤害特效激活：由 _damageAmbience 置位，renderDamageDepth 读取
    // （多数帧附近没有伤害区 → 不渲那张深度图，几乎零开销）
    this._dmgAnyActive = false;
    // 检查点
    for (const rec of this.b.objectsOf('checkpoint')) {
      const st = rec.state;
      if (st.done === undefined) st.done = false;
      if (st.done) continue;
      const probe = this._bodyProbe(player, 2.5, _v);
      if (!this.obb(rec, probe, 0.6)) continue;
      st.done = true;
      player.setRespawn(_v2.set(...worldPosition(this.b.level, rec.o)), rec.o.refillOxygen !== false);
      audio.checkpoint();
      this.fx && this.fx.sparkle(_v2, rec.o.color || '#8ef5c8', 26, 8);
      this.emitObjectEvent(rec.o, 'touch');
      this.emitObjectEvent(rec.o, 'enter');
    }
    // 终点
    for (const rec of this.b.objectsOf('goal')) {
      const probe = this._bodyProbe(player, 2.5, _v);
      if (!this.obb(rec, probe, 0.4)) continue;
      this.fx && this.fx.sparkle(_v.set(...worldPosition(this.b.level, rec.o)), '#ffd98a', 40, 12);
      this.emitObjectEvent(rec.o, 'touch');
      this.hooks.onWin && this.hooks.onWin(rec);
      break;
    }
    // 伤害区域
    for (const rec of this.b.objectsOf('damage')) {
      const o = rec.o;
      const st = rec.state;
      if (st.in === undefined) { st.in = false; st.cool = 0; }
      // 沿身体高度「从头到脚」多点取样（只取身体中轴，不含左右伸出的手臂）：
      // 任一点落在体积内即判为接触 —— 只测胸口一点时，脚踩进去 / 头探进去都会漏判。
      let now = false;
      for (let i = 0; i < DAMAGE_SAMPLES.length; i++) {
        const probe = this._bodyProbe(player, DAMAGE_SAMPLES[i], _v3);
        if (this.obb(rec, probe, 0.4)) { now = true; break; }
      }
      st.cool = Math.max(0, st.cool - dt);
      if (o.instantKill) { if (now) { player.kill('zone'); return; } }
      else if (now) {
        const hit = Math.max(0, Number(o.damage) || 0);       // 伤害/次
        // 去抖：按「结算频率」离散结算，避免逐帧扣血造成的抖动与反馈刷屏。
        // 平均伤害/秒 = 伤害/次 × 频率；频率 0 = 不结算
        const raw = Number(o.tickRate);
        const hz = Number.isFinite(raw) ? Math.max(0, raw) : DAMAGE_RATE_DEFAULT;
        if (hz > 0 && st.cool <= 0) {
          player.damage(hit, 'zone');
          st.cool = 1 / hz;
        }
      }
      if (now && o.knockback > 0) {
        const dir = this._bodyProbe(player, 2.5, _v2);
        const wp = new THREE.Vector3(...worldPosition(this.b.level, o));
        const up = player._up || { x: 0, y: 1, z: 0 };
        dir.sub(wp).normalize();
        if (dir.lengthSq() < 0.01) dir.set(up.x, up.y, up.z);
        // 击退 = 沿「体积→玩家」方向的全量速度，但把「沿重力反方向的分量」钳为非负并额外 +2 抬升
        // （默认重力下 = 原来 Math.max(0, dir.y)·A + 2 的写法）
        const A = o.knockback * dt * 10;
        const dUp = dir.x * up.x + dir.y * up.y + dir.z * up.z;
        const addUp = (Math.max(0, dUp) - dUp) * A + 2;
        player.push(dir.x * A + up.x * addUp, dir.y * A + up.y * addUp, dir.z * A + up.z * addUp);
      }
      if (now && !st.in) { st.in = true; this.emitObjectEvent(o, 'enter'); }
      else if (!now && st.in) { st.in = false; this.emitObjectEvent(o, 'exit'); }
      this._damageAmbience(rec, player, dt);
    }
    // 事件触发器
    for (const rec of this.b.objectsOf('trigger')) {
      const o = rec.o;
      const st = rec.state;
      if (st.in === undefined) { st.in = false; st.cool = 0; st.done = false; }
      st.cool = Math.max(0, st.cool - dt);
      let now = false;
      if (o.target === 'any') now = this.anyDynamicInside(rec, player);
      else now = !!this.obb(rec, this._bodyProbe(player, 2.5, _v), 0.4);
      if (now && !st.in) {
        st.in = true;
        if (!(o.once && st.done) && st.cool <= 0) {
          st.done = true;
          st.cool = Number(o.cooldown) || 0;
          const fire = () => { this.emitObjectEvent(o, 'enter'); this.emitObjectEvent(o, 'touch'); };
          if (Number(o.delay) > 0) setTimeout(() => { if (!this.b.level || rec.disposed) return; fire(); }, Number(o.delay) * 1000);
          else fire();
        }
      } else if (!now && st.in) {
        st.in = false;
        if (!(o.once && st.done)) this.emitObjectEvent(o, 'exit');
      }
    }
  }

  anyDynamicInside(rec, player) {
    if (this.obb(rec, this._bodyProbe(player, 2.5, _v), 0.4)) return true;
    for (const other of this.b.objects.values()) {
      if (!other.body || other.body.type !== CANNON.Body.DYNAMIC) continue;
      if (!this.obb(rec, _v.set(other.body.position.x, other.body.position.y, other.body.position.z), 0.4)) continue;
      return true;
    }
    return false;
  }

  emitObjectEvent(o, which) {
    if (!this.events) return;
    this.events.objectEvent(o.id, which, { object: o });
  }

  /* ============================================================
     声效方块：按触发方式播放音频素材（3D 衰减 + 左右声像）
     ============================================================ */
  updateSoundBlocks(dt, player) {
    const list = this.b.objectsOf('soundblock');
    if (!list.length) return;
    for (const rec of list) {
      const o = rec.o;
      const st = rec.state;
      if (st.in === undefined) { st.in = false; st.cool = 0; st.auto = false; st.done = false; st.playing = null; }
      st.cool = Math.max(0, st.cool - dt);
      const ref = o.sound;
      if (!ref) {
        if (st.playing) { st.playing.stop(0.25); st.playing = null; }
        continue;
      }
      const wp = worldPosition(this.b.level, o);
      const mode = o.trigger || 'enter';
      if (mode === 'click') continue;                 // 点击由 fireClick 处理
      const probe = this._bodyProbe(player, 2.5, _v);
      const now = !!this.obb(rec, probe, 0.5);
      if (mode === 'auto') {
        if (!st.auto) { st.auto = true; st.playing = this.playBlockSound(rec, wp); }
        if (st.playing) this.followSoundBlock(rec, st.playing, wp);
      } else if (mode === 'inside') {
        if (now && !st.playing) {
          st.playing = this.playBlockSound(rec, wp, true);
          this.emitObjectEvent(o, 'enter');
        } else if (!now && st.playing) {
          st.playing.stop(0.4);
          st.playing = null;
          this.emitObjectEvent(o, 'exit');
        }
        if (st.playing) this.followSoundBlock(rec, st.playing, wp);
      } else {
        // enter：进入范围响一次，站着不动则按冷却重复
        if (now && st.cool <= 0 && !(o.once && st.done)) {
          st.cool = Math.max(0, Number(o.cooldown) || 0);
          st.done = true;
          this.playBlockSound(rec, wp);
          this.emitObjectEvent(o, 'touch');
        }
        if (now !== st.in) {
          st.in = now;
          this.emitObjectEvent(o, now ? 'enter' : 'exit');
        }
      }
    }
  }

  /** 播放一个声效方块的音频（返回句柄，素材未就绪时返回 null） */
  playBlockSound(rec, wp, forceLoop) {
    const o = rec.o;
    const loop = forceLoop || o.loop === true;
    const h = audio.play3D(o.sound, {
      position: wp || worldPosition(this.b.level, o),
      volume: Number(o.volume ?? 1),
      pitch: Number(o.pitch ?? 1),
      loop,
      maxDistance: Number(o.maxDistance ?? 160),
      refDistance: Number(o.refDistance ?? 12),
      falloff: Number(o.falloff ?? 0.6),
      fadeIn: loop ? 0.4 : 0,
    });
    audio.load(o.sound);          // 未解码完时先把素材加载起来
    return h || null;
  }

  /** 循环中的音源随玩家移动实时更新音量与声像 */
  followSoundBlock(rec, handle, wp) {
    const o = rec.o;
    const sp = audio.spatialize(wp, {
      maxDistance: Number(o.maxDistance ?? 160),
      refDistance: Number(o.refDistance ?? 12),
      falloff: Number(o.falloff ?? 0.6),
    });
    const vol = Math.max(0.0005, sp.silent ? 0 : sp.volume * Number(o.volume ?? 1));
    handle.setVolume(vol, 0.12);
    handle.setPan(sp.pan);
  }

  /* ============================================================
     投掷物
     ============================================================ */
  throwProjectile(templateRec, from, dir, speedScale = 1, overrides = null) {
    const b = this.b;
    if (!b.world || !templateRec) return null;
    const o = templateRec.o;
    const s = o.scale;
    const shape = o.ballShape === 'block'
      ? new CANNON.Box(new CANNON.Vec3(s[0] / 2, s[1] / 2, s[2] / 2))
      : new CANNON.Sphere(Math.max(s[0], s[1], s[2]) * 0.5);
    const body = new CANNON.Body({
      mass: 1.2, shape, material: b.mats.bouncy,
      position: new CANNON.Vec3(from.x, from.y, from.z),
      linearDamping: 0.02,
    });
    const sp = ((overrides && Number(overrides.throwSpeed)) || Number(o.throwSpeed) || 90) * speedScale;
    body.velocity.set(dir.x * sp, dir.y * sp, dir.z * sp);
    body.userData = { projectile: true, gravityScale: Number(o.gravityScale) || 1 };
    b.world.addBody(body);

    // 外观直接用「指定对象」自身的几何与材质（贴图 / 九宫格 / 透明 / 自发光全部沿用），
    // 这样扔出去的就是关卡里摆放的那个东西；对象没网格时才退回程序化球 / 方块
    const src = templateRec.mesh;
    const geo = (src && src.isMesh && src.geometry)
      ? src.geometry.clone()
      : (o.ballShape === 'block'
        ? new THREE.BoxGeometry(s[0], s[1], s[2])
        : new THREE.SphereGeometry(Math.max(s[0], s[1], s[2]) * 0.5, 14, 10));
    let mat;
    if (src && src.material) {
      mat = Array.isArray(src.material) ? src.material.map((m) => m.clone()) : src.material.clone();
    } else {
      mat = new THREE.MeshStandardMaterial({
        color: o.color || '#ffa06b', roughness: o.roughness ?? 0.5, metalness: o.metalness ?? 0.2,
        emissive: new THREE.Color(o.emissive || '#000000'), emissiveIntensity: o.emissiveIntensity ?? 0,
      });
    }
    // 画面处理：饱和度 / 染色（克隆出来的材质丢了注入，这里补上）
    if (Array.isArray(mat)) mat.forEach(applyScreenGrade);
    else applyScreenGrade(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = o.castShadow !== false;
    mesh.position.set(from.x, from.y, from.z);   // 先与物理体对齐，否则生成的那一帧会闪现在原点
    b.root.add(mesh);
    if (b.onAdd) b.onAdd(mesh);   // 渲染 Worker 模式：增量同步新生成的投掷物
    const rec = {
      body, mesh, tpl: templateRec,
      life: (overrides && Number(overrides.lifeTime)) || Number(o.lifeTime) || 12,
      dead: false,
      damage: Number(o.damage) || 0, breakTargets: (o.breakTargets || []).slice(),
    };
    this.projectiles.push(rec);
    audio.click(0.7);
    return rec;
  }

  updateProjectiles(dt, player) {
    const g = -196.2 * (this.b.level.settings.gravityScale || 1);
    // 世界重力方向（用于把「投掷物重力倍率」的额外冲量施加在重力轴上，而不是固定世界 Y）
    const gw = (this.b.world && this.b.world.gravity) ? this.b.world.gravity : { x: 0, y: g, z: 0 };
    const gl = Math.hypot(gw.x, gw.y, gw.z);
    const gdx = gl > 1e-6 ? gw.x / gl : 0, gdy = gl > 1e-6 ? gw.y / gl : -1, gdz = gl > 1e-6 ? gw.z / gl : 0;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      const gs = p.body.userData.gravityScale ?? 1;
      if (gs !== 1) {
        const k = g * (gs - 1) * p.body.mass;   // 默认重力下 gd=(0,-1,0) → force.y += -g·(gs-1)·mass，与旧写法一致
        p.body.force.x += gdx * k; p.body.force.y += gdy * k; p.body.force.z += gdz * k;
      }
      p.mesh.position.set(p.body.position.x, p.body.position.y, p.body.position.z);
      p.mesh.quaternion.set(p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w);
      // 命中判定
      let hit = false;
      if (p.breakTargets.length) {
        for (const id of p.breakTargets) {
          const target = this.b.objects.get(id);
          if (!target || target.o.visible === false) continue;
          if (this.obb(target, _v.set(p.body.position.x, p.body.position.y, p.body.position.z), 1.2)) {
            this.breakObject(target, player);
            hit = true;
            break;
          }
        }
      }
      if (!hit && p.damage > 0) {
        const bp = this._bodyProbe(player, 2, _v);   // 玩家身体中部（默认重力下 = feetPos.y + 2）
        const d = Math.hypot(
          bp.x - p.body.position.x,
          bp.y - p.body.position.y,
          bp.z - p.body.position.z);
        if (d < 2.6) { player.damage(p.damage, 'projectile'); hit = true; }
      }
      if (!hit && p.body.position.y < (this.b.level.settings.voidY ?? -900)) hit = true;
      if (hit || p.life <= 0) {
        this.fx && this.fx.hit(_v.set(p.body.position.x, p.body.position.y, p.body.position.z),
          p.tpl.o.color || '#ffa06b', 16);
        this.b.world.removeBody(p.body);
        this.b.root.remove(p.mesh);
        if (this.b.onRemove) this.b.onRemove(p.mesh);
        p.mesh.geometry.dispose();
        const mm = p.mesh.material;
        if (Array.isArray(mm)) mm.forEach((x) => x.dispose()); else mm.dispose();
        this.projectiles.splice(i, 1);
      }
    }
    if (this.projectiles.length > 24) {
      const p = this.projectiles.shift();
      this.b.world.removeBody(p.body);
      this.b.root.remove(p.mesh);
      if (this.b.onRemove) this.b.onRemove(p.mesh);
      p.mesh.geometry.dispose();
      const m = p.mesh.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m.dispose();
    }
  }

  clearProjectiles() {
    for (const p of this.projectiles) {
      this.b.world && this.b.world.removeBody(p.body);
      this.b.root.remove(p.mesh);
      if (this.b.onRemove) this.b.onRemove(p.mesh);
      p.mesh.geometry.dispose();
      const m = p.mesh.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m.dispose();
    }
    this.projectiles.length = 0;
  }

  /* ============================================================
     破坏对象（工具 / 投掷物）
     ============================================================ */
  breakObject(rec, player) {
    if (!rec) return false;
    const o = rec.o;
    const wp = new THREE.Vector3(...worldPosition(this.b.level, o));
    this.fx && this.fx.burst(wp, o.color || '#d9d2ee', 26);
    audio.break();
    o.visible = false;
    if (rec.mesh) { rec.mesh.visible = false; if (this.b.onState) this.b.onState(rec.mesh); }
    this.b.releaseBody(rec);   // 合批过的盒形要从分块复合体里一并摘掉
    rec.broken = true;
    this.emitObjectEvent(o, 'touch');
    this.hooks.onBreak && this.hooks.onBreak(rec);
    this.events && this.events.emitTrigger('objectBroken', { objectId: rec.id });
    if (player) player.shake(0.35);
    return true;
  }

  /* ============================================================
     交互拾取（视线内可交互物，用于屏蔽 LMB 下潜 + 提示）
     ============================================================ */
  getRaycastTargets() {
    if (this._targets && this._targetsStamp === this.b.objects.size) return this._targets;
    const arr = [];
    for (const rec of this.b.objects.values()) {
      if (!rec.mesh || !rec.visible) continue;
      if (rec.type === 'light' || rec.type === 'group' || rec.type === 'zipline') continue;
      if (rec.type === 'curve' || rec.type === 'meshref') continue;   // 纯几何路径 / 修改器容器不参与交互
      if (rec.type === 'spawn') continue;       // 起点标记就在脚下，会挡住准星（破坏 / 自定义工具要用准星目标）
      if (EMIT_FX.has(rec.type)) continue;      // 特效体积不参与交互视线检测
      // 声效方块只有“点击播放”模式才可被准星选中
      if (rec.type === 'soundblock' && rec.o.trigger !== 'click') continue;
      // 已被重建/销毁的旧网格（parent 为空）不能再参与射线检测
      if (rec.meshes) for (const m of rec.meshes) if (m.isMesh && m.parent) arr.push(m);
      else if (rec.mesh.isMesh && rec.mesh.parent) arr.push(rec.mesh);
    }
    this._targets = arr;
    this._targetsStamp = this.b.objects.size;
    return arr;
  }

  /** 从相机发出的射线找到可交互对象 */
  pick(origin, dir, maxDist = 42) {
    const targets = this.getRaycastTargets();
    if (!targets.length) return null;
    // 镜像变体：网格的 matrixWorld 在镜像空间里，射线也换算过去再打；
    // 命中的 point 再换回原空间，因为粒子 / 工具效果都在原空间里生成
    const mir = !!this.b.mirror;
    const ro = mir ? _pickO.set(-origin.x, origin.y, origin.z) : origin;
    const rd = mir ? _pickD.set(-dir.x, dir.y, dir.z) : dir;
    const ray = new THREE.Raycaster(ro, rd, 0.1, maxDist);
    const hits = ray.intersectObjects(targets, false);
    for (const h of hits) {
      const id = h.object.userData.objectId;
      const rec = id && this.b.objects.get(id);
      if (!rec) continue;
      if (h.object.isMesh && h.object.material && h.object.material.opacity < 0.08) continue;
      const info = this.interactInfo(rec);
      // info 为 null 的普通物体（网格 / 攀爬墙以外的实体）也要返回：
      // 破坏工具、自定义工具需要拿它当「准星目标」，返回 null 会让这些工具永远打不中东西
      if (mir) h.point.x = -h.point.x;
      return { rec, dist: h.distance, point: h.point, info };
    }
    return null;
  }

  /** 该对象是否可交互（返回 {label, kind, clickable}）
      clickable=true 表示「左键可交互」→ 会屏蔽左键速降/滑铲/下潜；
      终点 / 检查点 / 攀爬墙 / 液体等只是信息展示，不屏蔽左键 */
  interactInfo(rec) {
    const o = rec.o;
    if (!rec.visible) return null;
    if (rec.type === 'door') {
      return { kind: 'door', clickable: true, label: o.open ? '按 左键 关门' : (o.requiredTool ? '门（需要工具）' : '按 左键 开门') };
    }
    if (rec.type === 'click') {
      return { kind: 'click', clickable: true, label: o.prompt || '按 左键 触发' };
    }
    if (rec.type === 'button') return { kind: 'button', clickable: false, label: '触碰按下' };
    if (rec.type === 'soundblock') return { kind: 'sound', clickable: true, label: o.prompt || '按 左键 播放音效' };
    if (rec.type === 'climb') return { kind: 'climb', clickable: false, label: '按 W 向上攀爬 / 空格跳离' };
    if (rec.type === 'tool') return { kind: 'tool', clickable: false, label: '靠近拾取' };
    if (rec.type === 'goal') return { kind: 'goal', clickable: false, label: '终点' };
    if (rec.type === 'checkpoint') return { kind: 'checkpoint', clickable: false, label: '检查点' };
    if (rec.type === 'liquid') return { kind: 'liquid', clickable: false, label: '液体' };
    // 伤害区域的具体文案（伤害% 依玩家最大生命换算）由 player 侧覆写，见 player.damagePrompt
    if (rec.type === 'damage') return { kind: 'damage', clickable: false, label: '伤害区域' };
    return null;
  }

  /* ============================================================
     伤害区域「靠近时」的专属特效（贴面）
     ------------------------------------------------------------
     不飘在空气里，而是「贴在方块网格本身」：
       · 贴面辉光层 —— 与方块同形、外扩 2% 的普通混合壳，沿方块表面整体亮起；
         壳上贴一张程序化「斜向警戒条纹 + 网格线」纹理，并缓慢斜向流动，
         让表面看得出纹样而不是一块纯色光斑（见 damageShellTexture）。
         纹理为「平铺不拉伸」：每格世界边长固定为 DAMAGE_TEX_STUD，方块大小无关、不被拉扁。
         用普通混合而非加色：加色会被方块自身的亮度冲淡，纹理在强光下就糊了；
         材质本身是 MeshBasicMaterial（不受光照），配合普通混合 → 任何光照下都清晰。
       · 网格边线   —— EdgesGeometry 描出方块的真实网格棱边，清晰可辨
     两者强度都由「玩家距离」驱动：越近越亮、带脉动，进到体积内最浓；
     用低不透明度 / 细线克制，只作辨识提示、不抢画面主体。
     ============================================================ */
  _damageAmbience(rec, player, dt) {
    const o = rec.o;
    // 不可见 / 无害区域：不亮，并收起贴面特效
    const dmg = Math.max(0, Number(o.damage) || 0);
    if (!rec.visible || (!o.instantKill && dmg <= 0)) { this._hideDamageShell(rec); return; }
    const wp = worldPosition(this.b.level, o, _wpArr);
    const s = o.scale || [1, 1, 1];
    const rx = Math.max(0.5, Math.abs(s[0]) * 0.5);
    const ry = Math.max(0.5, Math.abs(s[1]) * 0.5);
    const rz = Math.max(0.5, Math.abs(s[2]) * 0.5);
    const R = Math.max(rx, ry, rz) + 10;              // 感知半径 = 体积半尺寸 + 10 stud
    const dx = player.feetPos.x - wp[0], dy = player.feetPos.y - wp[1], dz = player.feetPos.z - wp[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > R) { this._hideDamageShell(rec); return; }
    const near = 1 - dist / R;                        // 0 边缘 → 1 中心
    if (!this._ensureDamageShell(rec)) return;
    this._ambT = (this._ambT || 0) + dt;
    const st = rec.state;
    if (st.ambPh === undefined) st.ambPh = Math.random() * 6.2831;   // 每个方块相位错开
    const pulse = 0.5 + 0.5 * Math.sin(this._ambT * (3 + near * 5) + st.ambPh);
    const k = near * (0.45 + 0.55 * pulse);           // 距离 × 脉动
    // 贴面纹理缓慢流动：斜向滚动、越近滚得越快，避免静止成一坨色块
    if (rec.dmgMap) {
      const flow = this._ambT * (0.10 + near * 0.25) + st.ambPh;
      rec.dmgMap.offset.set((flow * 0.7) % 1, flow % 1);
    }
    this._dmgAnyActive = true;                        // 本帧有效果 → 需要渲那张深度图（见 renderDamageDepth）
    const useDepth = DMG_DEPTH.on.value > 0.5;        // 深度图不可用时退回普通深度测试（玩家会挡住，但不至于穿墙）
    rec.dmgGlow.visible = true;
    rec.dmgGlow.material.opacity = k * 0.55;          // 贴面纹理：普通混合，略提高比例保证亮度下可辨
    rec.dmgGlow.material.depthTest = !useDepth;
    if (rec.dmgEdge) {
      rec.dmgEdge.visible = true;
      rec.dmgEdge.material.opacity = Math.min(0.85, k * 1.1);
      rec.dmgEdge.material.depthTest = !useDepth;
    }
  }

  /** 收起贴面特效（不可见 / 远离 / 无害时） */
  _hideDamageShell(rec) {
    if (rec.dmgGlow) rec.dmgGlow.visible = false;
    if (rec.dmgEdge) rec.dmgEdge.visible = false;
  }

  /** 懒创建「贴面」特效层：与方块同形，挂在网格下随变换一起走 */
  _ensureDamageShell(rec) {
    const mesh = rec.mesh;
    if (rec.dmgGlow && rec.dmgGlow.parent === mesh) return rec.dmgGlow;   // 已就绪（网格重建后失效则重建）
    if (!mesh || !mesh.isMesh) return null;
    const color = new THREE.Color(rec.o.color || '#ff6b8a');
    // 特效几何：按「平铺不拉伸」把 uv 烘进几何 —— 每格的世界边长 = DAMAGE_TEX_STUD(stud)，
    // 与方块尺寸无关，所以方块多大 / 多扁，格子大小都一致、图案不会被拉扁
    //（与方块本体的 textureFill='tile' 同一套换算，见 objectTypes.buildBoxFillGeometry）。
    // 几何是单位盒，随父级 mesh.scale 一起缩放，正好等于方块尺寸。
    const geo = buildBoxFillGeometry(rec.o.scale || [1, 1, 1], 1, 'tile', DAMAGE_TEX_STUD);
    // 纹理按方块各克隆一份：克隆只复制「偏移/重复」等参数，底层图像数据仍共享，
    // 目的是让每个方块能各自滚动纹理（见 _damageAmbience），互不同步。
    // uv 已烘焙，材质层 repeat 固定为 1。
    const src = damageShellTexture();
    const map = src ? src.clone() : null;
    if (map) { map.repeat.set(1, 1); map.needsUpdate = true; }
    // 用普通混合而非加色：加色只会「叠亮」底色，方块被场景光照亮时底色已经很亮，
    // 叠上去几乎看不出，纹理就糊了。普通混合直接按自身颜色覆盖，底色明暗都不影响纹理可辨；
    // 纹理背景是全透明的，所以条纹之间的空隙仍是方块本身，不会被压暗。
    const glow = new THREE.Mesh(geo, injectDamageDepth(new THREE.MeshBasicMaterial({
      color, map, transparent: true, opacity: 0, depthWrite: false, blending: THREE.NormalBlending,
    })));
    glow.scale.setScalar(1.02);
    glow.renderOrder = 8;
    glow.visible = false;
    glow.frustumCulled = false;
    mesh.add(glow);
    // 网格边线：描出方块真实棱边，让「贴网格」的辨识更明确
    let edges = null;
    try {
      edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), injectDamageDepth(new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.NormalBlending,
      })));
      edges.scale.setScalar(1.02);
      edges.renderOrder = 9;
      edges.visible = false;
      edges.frustumCulled = false;
      mesh.add(edges);
    } catch (_) { edges = null; }
    rec.dmgGlow = glow;
    rec.dmgMap = map;
    rec.dmgEdge = edges;
    return glow;
  }

  /* ---------- 伤害特效的「世界深度」预渲染（低分辨率） ----------
     产出一张「只含实心关卡几何」的深度图：玩家（挂在场景根上）、半透明物、
     粒子 / 线条 / 精灵一律排除。贴面特效以 depthTest=false 画在最上层（于是不被
     玩家挡），再在片元里查这张图，被世界挡住的像素直接 discard ——
     最终效果：穿玩家可见、被墙 / 方块正常遮挡。
     只有本帧有效果（this._dmgAnyActive）时才渲，且用 1/4 分辨率的缓冲
     （填充量降到 1/16），主渲染开销与帧数都不变。
     流程与水体泡沫的深度预渲染一致，见 builder.renderFoamDepth。 */
  renderDamageDepth(renderer, camera) {
    if (!this._dmgAnyActive || !renderer || !camera || !this.b || !this.b.scene) {
      DMG_DEPTH.on.value = 0;      // 深度图不可用 → 贴面材质退回普通深度测试（不会穿墙）
      return;
    }
    const buf = renderer.getDrawingBufferSize(_dmgBufSize);
    const w = Math.max(2, Math.floor(buf.x * 0.25));
    const h = Math.max(2, Math.floor(buf.y * 0.25));
    if (!this._dmgRT || this._dmgRT.width !== w || this._dmgRT.height !== h) {
      if (this._dmgRT) this._dmgRT.dispose();
      const dt = new THREE.DepthTexture(w, h);
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      const rt = new THREE.WebGLRenderTarget(w, h, {
        depthTexture: dt, stencilBuffer: false, depthBuffer: true,
      });
      rt.texture.minFilter = THREE.NearestFilter;
      rt.texture.magFilter = THREE.NearestFilter;
      this._dmgRT = rt;
    }
    if (!this._dmgDepthMat) this._dmgDepthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    // 半透明物 / 粒子 / 线条 / 精灵都不是「实心边界」，排除（贴面特效自身也是透明的，一并排除）
    const hidden = [];
    this.b.root.traverse((c) => {
      if (!c.visible) return;
      if (c.isMesh) {
        const m = c.material;
        if (m && (m.transparent || m.colorWrite === false)) { c.visible = false; hidden.push(c); }
      } else if (c.isPoints || c.isLine || c.isSprite) {
        c.visible = false; hidden.push(c);
      }
    });
    const scene = this.b.scene;
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    // 只保留关卡本体：玩家、编辑器 gizmo / 网格 / 粒子都挂在场景根上，全部排除
    const hiddenKids = [];
    for (const c of scene.children) {
      if (c !== this.b.root && c.visible) { c.visible = false; hiddenKids.push(c); }
    }
    scene.overrideMaterial = this._dmgDepthMat;
    scene.background = null;
    renderer.autoClear = true;
    renderer.shadowMap.autoUpdate = false;   // 预渲染用不到光照，别让阴影在同一帧渲两遍
    renderer.setRenderTarget(this._dmgRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    for (const c of hiddenKids) c.visible = true;
    for (const m of hidden) m.visible = true;

    DMG_DEPTH.tex.value = this._dmgRT.depthTexture;
    DMG_DEPTH.res.value.copy(buf);   // 归一化屏幕坐标：与深度图分辨率无关
    DMG_DEPTH.on.value = 1;
  }

  /* ============================================================
     逐帧
     ============================================================ */
  update(dt, player) {
    this.updateButtons(dt, player);
    this.updateClicks(dt);
    this.updateDoors(dt);
    this.updatePickups(dt, player);
    this.updateZones(dt, player);
    this.updateProjectiles(dt, player);
    this.updateEmitters(dt);
    this.updateSoundBlocks(dt, player);
    this.updateZiplines(dt, player);
    if (player.onZipline) this.updateZipline(player, dt);
  }
}

export { worldPosition };