/* ============================================================
   玩家：Roblox R6 方块人 + 物理控制（跑 / 跳 / 滑铲 / 速降 / 游泳 / 贴墙 / 滑索）
   物理体：2×4 stud 方块 + 1 stud 头 → 总高 5；body.position = 脚底
   ============================================================ */
import * as THREE from 'three';
import * as CANNON from 'cannon';
import { PLAYER, PHYS, TOOL_DEFS, LIQUID_KINDS } from '../config.js';
import { clamp, damp, deg2rad } from '../core/util.js';
import { settings } from '../core/settings.js';
import { audio } from '../core/audio.js';
import { Inventory } from './tools.js';
import { PlayerAvatar, buildR6Parts, presetDef } from './avatar.js';
import { worldPosition } from '../world/level.js';
import { applyScreenGrade } from '../core/materials.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _gravMat = new THREE.Matrix4();   // 重力对齐四元数用的临时基矩阵（基 = gRight / up / gFwd）
// 受击反馈去抖窗口（秒）：短时间内重复扣血只播一次音效/震屏，避免事件脚本或
// 多片伤害区域每帧调用 damage() 导致的音效刷屏与镜头狂抖
const HURT_FEEDBACK_CD = 0.15;
const _negN = new THREE.Vector3();      // 挂边刷新时沿板面法线反向探测的临时方向
const _ray = new CANNON.RaycastResult();
const _from = new CANNON.Vec3();
const _to = new CANNON.Vec3();
// 台阶探测：沿前进方向由近到远撒点，并在「垂直方向」补多条车道，覆盖斜向走位时
// 落在脚印斜角上的台阶。原来只有中心一条线（4 点），斜对角上台阶经常探不到 → 卡住。
// ★ 想加/减密度：改下面这一个倍率即可（1 = 单车道 4 点；2 = 双车道 8 点；3 = 三车道 12 点…）
const STEP_PROBE_DENSITY = 3;      // 探测射线密度倍率
const STEP_PROBE_DIST = [0.95, 1.2, 1.5, 1.75];   // 前进方向的基准采样距离（由近到远）
const STEP_PROBE_SPREAD = 1;    // 横向车道最大偏移（≈ 脚印半对角线，斜向时补到盒角）
const STEP_PROBES = (() => {
  const lanes = Math.max(1, Math.round(STEP_PROBE_DENSITY));
  const out = [];
  // 由近到远排序：先试近处的台阶，命中即用
  for (const d of STEP_PROBE_DIST) {
    for (let l = 0; l < lanes; l++) {
      const lat = lanes === 1 ? 0 : (-STEP_PROBE_SPREAD + 2 * STEP_PROBE_SPREAD * l / (lanes - 1));
      out.push([d, lat]);
    }
  }
  return out;
})();
/* ---------- 台阶辅助的触发门槛（「卡住 / 反应慢」基本都出在这几个值上，可调） ---------- */
// 预测射线提前量倍率：>1 会更早抬腿（略大些手感更「跟脚」，太大人会在离台阶还有距离时凭空飘起）
const STEP_PREDICT_MUL = 1.25;
// 预测射线改为「一条斜向下」的射线（原来是 0.3 / 1.05 两条水平射线）：
// 水平射线与固定高度齐平，比它矮的立面会直接从上方掠过 → 薄台阶预测永远不触发，只能等撞上才抬。
// 斜向下的射线从脚印前缘上方起射，水平前进的同时连续下降，扫过整个台阶高度带，
// 任何高度的立面 / 顶面都会被扫到。
const STEP_RISER_UP = 0.35;       // 起点在「脚底 + stepHeight」之上再抬高的余量（先越过矮台阶顶面再斜落）
const STEP_RISER_DOWN = 0.45;     // 终点落到脚底之下的高度（保证扫进矮台阶与地面）
const STEP_RISER_MIN_LEN = 0.35;  // 射线水平长度下限（低速时也保留少量前探距离）
// 最低可抬升高度：原来写死 0.12，比这还矮的薄台阶会被直接过滤掉 → 永远抬不上去 → 死卡
const STEP_MIN_RISE = 0.05;
// 允许「刚离地」多久内仍然抬腿：薄台阶会把盒子顶得微微弹起（airTime 增长），
// 原来 0.3s 的门槛会在最需要抬腿的时候恰好把辅助关掉
const STEP_AIRTIME_MAX = 0.45;
// 着地探测点（相对脚底中心的水平偏移）：中心 + 盒底四角 + 四边中点，覆盖整个 2×1 的脚印。
// 只打中心一条射线时，人站在平台边缘、身体大半探出边缘外，中心射线就打空了；
// 这时往往只剩侧向 / 角接触（法线接近水平，不算“地面”）→ 判定离地 →
// 地面摩擦与低速归零失效，残留的移动速度没人刹住，人就会慢慢滑出边缘。
// 四角取到真实脚印外沿（略内缩 0.05），只要脚印还有一小块压在平台上就能探到支撑；
// 四边中点补上「窄梁 / 斜角平台」只压住一条边的情形。
const GROUND_PROBES = [
  [0, 0],
  [0.95, 0.45], [-0.95, 0.45], [0.95, -0.45], [-0.95, -0.45],
  [0.98, 0], [-0.98, 0], [0, 0.48], [0, -0.48],
];
// 判为「地面支撑」的接触法线竖直分量门槛：脚底踩在平台棱角上时法线是斜的（介于水平与竖直之间），
// 门槛太严（-0.45，约 27°）会漏判 → 人被棱角接触横向顶出边缘。放宽到 -0.25 仍能排除近乎竖直的墙。
const GROUND_NORMAL_MIN = -0.25;
// 着地向下射线的起点高度：抬到脚底之上 0.8，即使脚在台沿处略微陷入平台体内也能从顶面之上起射。
const GROUND_RAY_UP = 0.8;
// 落地防滑窗口时长：高处落到台沿、落地瞬间几乎没水平速度时，在这段时间内按「踩在地面上」刹车，
// 把冲击让棱角接触顶出来的横向速度刹掉（见 _brakeLateral）。
const LAND_GRIP_TIME = 0.2;
// 玩家物理体在 Box 之外附加的内切球列（半径 0.8）：cannon 没有实现 Box×Trimesh 窄相，
// 而 Sphere×Trimesh 已实现，靠这些球让玩家能站上 / 靠住「网格(精确)」碰撞模式的管道与网格修改器。
// 沿身高从脚底到头顶每 BODY_SPHERE_R 一颗（球心间距 = 2×半径 → 相邻球相切，合成面连续无缝隙），

const BODY_SPHERE_R = 0.8;
const BODY_SPHERES = [];
// 滑铲时盒高只剩 slideHalfH*2(=1.5)，比常规球直径(1.6)还矮 —— 常规半径的球一颗都塞不进盒内，
// 沿用它会得到「空球列」，而 cannon 没有 Box×Trimesh 窄相 → 滑铲时就会直接穿过 trimesh。
// 因此滑铲单独用一组「能完全内切进滑铲盒」的小半径球，保证 trimesh 碰撞始终存在。
const SLIDE_SPHERE_R = PLAYER.slideHalfH;
const BODY_SPHERES_SLIDE = [];
{
  for (let y = BODY_SPHERE_R; y <= PLAYER.totalH - BODY_SPHERE_R; y += BODY_SPHERE_R * 2) {
    BODY_SPHERES.push([0, y, 0]);
  }
  const slideH = PLAYER.slideHalfH * 2;
  for (let y = SLIDE_SPHERE_R; y <= slideH - SLIDE_SPHERE_R; y += SLIDE_SPHERE_R * 2) {
    BODY_SPHERES_SLIDE.push([0, y, 0]);
  }
}
// 高速穿透防护的阈值与射线暂存：单步位移一旦超过球半径（0.5），cannon 的 Sphere×Trimesh
// 就可能让球心一步越过三角面并被反向推入网格内部 → 见 _limitSweep
const SWEEP_MAX_STEP = 0.45;   // 单步位移安全上限（球半径 0.5 以内）
const SWEEP_GAP_KEEP = 0.05;   // 压速后仍要保留的「离面间隙」

// 薄平台挂边：胸前水平射线找到板的「边面」，再往里挪一点向上 / 向下各打一条射线量「上下面」的间距，
// 间距够薄（≤ LEDGE_MAX_THICK）就认定是薄平台边缘 → 进入攀爬模式、挂在平台边
const LEDGE_CHEST_Y = PLAYER.totalH * 0.62;  // 探测高度：胸部（总高 5 → 3.1）
// 挂边刷新 / 空中上跳（按住空格）时沿身体高度多点采样：薄板的高度区间很窄，
// 只测胸高的话身体刚上跳一点就会「探不到板」而误判脱手，跳不上去
const LEDGE_PROBE_Y = [LEDGE_CHEST_Y, PLAYER.totalH * 0.44, PLAYER.totalH * 0.18];   // 胸 3.1 / 腰 2.2 / 脚 0.9
const LEDGE_PROBE_Y0 = [LEDGE_CHEST_Y];      // 主动朝平台推进时严格按「胸部附近」判定
const LEDGE_REACH = 1.45;                    // 水平探测距离（玩家水平半径最大 1.12 再留余量）
const LEDGE_INSET = 0.22;                    // 命中边面后往板里挪的距离，让上下射线落在板体内部
const LEDGE_MAX_THICK = 1.2;                 // 上下面最大间距（同时也是上下射线的长度）：更厚就是实心墙 / 大块，不挂边
const LEDGE_DEBOUNCE = 0.02;                 // 判定去抖：0.02s 内只真正做一次射线判定，其间复用上次结果
const LEDGE_DIRS = (() => {                  // 水平探测方向（8 向，兼容任意朝向的平台）
  const out = [];
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    out.push([Math.sin(a), Math.cos(a)]);
  }
  return out;
})();
const _ledgeRes = new CANNON.RaycastResult();    // 水平（找边面）
const _ledgeUp = new CANNON.RaycastResult();     // 向上（找上面）
const _ledgeDown = new CANNON.RaycastResult();   // 向下（找下面）
const _ledgeHead = new CANNON.RaycastResult();   // 向上（量顶面之上的净空，排除砖缝）

const _sweepFrom = new CANNON.Vec3();
const _sweepTo = new CANNON.Vec3();
const _sweepDir = new CANNON.Vec3();
const _sweepRes = new CANNON.RaycastResult();

// _wallSlideInfo 的接触缓冲：曲面上 cannon 的 sphereTrimesh 会对球半径内每个三角面顶点 / 边
// 各生成一条接触，法线方向各异（含指向运动方向的伪接触），需要先收集再聚类求稳定法线。
// 法线一律先投影到「垂直于重力的平面」（默认重力下即水平面，Y 分量恒为 0，与旧逻辑完全一致）。
const WALL_BUF_MAX = 32;
const _wallBufX = new Float32Array(WALL_BUF_MAX);
const _wallBufY = new Float32Array(WALL_BUF_MAX);
const _wallBufZ = new Float32Array(WALL_BUF_MAX);
const _wallBufI = new Float32Array(WALL_BUF_MAX);
// 聚类角度窗口：两条法线夹角 ≤ 60°（点积 ≥ 0.5）视为同一面片/同一面簇
const WALL_CLUSTER_COS = 0.5;
// 只有「输入方向确实在朝面里推」时，才把这个面当成阻挡墙去压制速度；否则视为擦面滑移。
// 曲面 trimesh 上顶点 / 边伪接触的法线会指向运动方向，若仅凭「速度朝向面」就判定成撞墙，
// 会把沿面的前进速度当成「朝墙分量」清掉 → 一贴曲面走就失速 / 被顶回（见 _wallSlideInfo）。
const WALL_PRESS_MIN = 0.1;

/* ---------- 头顶名牌 ---------- */
const TAG_W = 512, TAG_H = 128;
const TAG_FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';

function makeNameTagSprite() {
  const cv = document.createElement('canvas');
  cv.width = TAG_W; cv.height = TAG_H;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const sp = new THREE.Sprite(mat);
  sp.center.set(0.5, 0);                    // 以底边为锚点 → 名牌整体悬在头顶上方
  sp.position.set(0, PLAYER.totalH + 0.7, 0);
  sp.scale.set(5.2, 5.2 * TAG_H / TAG_W, 1);
  sp.renderOrder = 8;
  sp.userData.helper = true;                // 编辑器拾取 / 网格修改器克隆时忽略
  sp.userData.tagCanvas = cv;
  sp.userData.tagTexture = tex;
  sp.userData.tagName = null;
  sp.visible = false;
  return sp;
}

/** 把名字画进名牌画布（浅色字 + 半透明底 + 描边，亮背景也看得清） */
function drawNameTag(sp, name) {
  const cv = sp.userData.tagCanvas;
  const x = cv.getContext('2d');
  x.clearRect(0, 0, TAG_W, TAG_H);
  const pad = 12;
  x.fillStyle = 'rgba(12,10,24,0.55)';
  x.beginPath();
  const r = 22;
  x.moveTo(pad + r, pad);
  x.arcTo(TAG_W - pad, pad, TAG_W - pad, TAG_H - pad, r);
  x.arcTo(TAG_W - pad, TAG_H - pad, pad, TAG_H - pad, r);
  x.arcTo(pad, TAG_H - pad, pad, pad, r);
  x.arcTo(pad, pad, TAG_W - pad, pad, r);
  x.closePath();
  x.fill();

  const size = 64;
  x.font = `700 ${size}px ${TAG_FONT}`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.lineJoin = 'round';
  x.strokeStyle = 'rgba(0,0,0,0.65)';
  x.lineWidth = 8;
  x.strokeText(name, TAG_W / 2, TAG_H / 2);
  x.fillStyle = '#ffffff';
  x.fillText(name, TAG_W / 2, TAG_H / 2);
  sp.userData.tagTexture.needsUpdate = true;
}

export class Player {
  constructor(builder, opts = {}) {
    this.b = builder;
    this.world = builder.world;
    this.input = opts.input || null;
    this.fx = opts.fx || null;
    this.events = opts.events || null;
    this.liquids = opts.liquids || null;
    this.mechanisms = opts.mechanisms || null;
    this.cameraCtl = opts.cameraCtl || null;
    this.hooks = opts.hooks || {};
    this.editor = !!opts.editor;
    // 地图变体「镜像」：地图在渲染层左右翻转，但玩家的操作不反转 ——
    // 按 D 仍要走向屏幕右侧、鼠标右移仍要画面右转，所以左右方向与左右视角增量都要取反
    this.mirror = !!opts.mirror;

    const L = builder.level;
    const st = L.settings || {};
    this.healthMax = Number(st.healthMax) || PLAYER.healthMax;
    this.maxOxygen = Number(st.oxygenMax) || PLAYER.oxygenMax;
    this.oxygenRegen = st.oxygenRegen === undefined ? PLAYER.oxygenRegen : Number(st.oxygenRegen);
    this.oxygenRegenDelay = st.oxygenRegenDelay === undefined
      ? PLAYER.oxygenRegenDelay : Math.max(0, Number(st.oxygenRegenDelay) || 0);
    this.health = this.healthMax;
    this.oxygen = this.maxOxygen;
    this.alive = true;
    this.invincible = false;              // 无敌：通关流程中不再受伤/死亡
    this.deaths = 0;

    /* 运行状态 */
    this.state = 'normal';
    this.grounded = false;
    this.wasGrounded = false;
    this.coyote = 0;
    this.jumpBuf = 0;
    this.slideTimer = 0;
    this.wallTimer = 0;
    this.wallRec = null;
    this.wallNormal = new THREE.Vector3();
    this.wallLeftRec = null;              // 刚跳离/超时脱离的 WallJump 墙：离开接触前不再粘回去
    this.wallLaunchT = 0;                 // WallJump 弹射持续推力的剩余时长
    this.wallLaunchDir = new THREE.Vector3();   // 弹射方向（水平）
    this.wallLaunchOut = 0;               // 弹射横向速度
    this.wallLaunchUp = 0;                // 弹射垂直速度
    this.upLockT = 0;                     // 入水后「上浮 / 跃出水面」锁定的剩余时长
    this.zipline = null;
    this.onZipline = false;
    this.anchored = false;                // 锚定：挂滑索期间关闭物理模拟，到达终点才解开
    this.inputFrozen = false;             // 冻结移动输入（进关倒数期间）：不响应走/跳，只保留视角
    this.zipCool = 0;
    this.climbRec = null;                 // 正在攀爬的攀爬墙
    this.climbNormal = new THREE.Vector3();
    this.climbAxis = 0;                   // 攀爬面所在的局部轴（0=x,1=y,2=z）
    this.climbLocal = 0;                  // 吸附时的局部坐标（用来保持贴面距离）
    this.ledgeTopPoint = null;            // 薄平台挂边时的顶面点（翻越用）
    this.ledgeCool = 0;                   // 薄平台判定的去抖剩余时间（见 _findLedge）
    this._ledgeCache = null;              // 去抖窗口内复用的上次判定结果
    this.climbCool = 0;                   // 跳离后的再次吸附冷却
    this.climbTime = 0;                   // 本次攀爬持续时间（用于翻越判定）
    this.climbHopT = 0;                   // 「快爬」保留上跳速度的剩余时长（此时重新吸附不清零速度）
    this.hopCool = 0;                     // 「快爬」两次上跳之间的最小间隔
    this.climbSfxT = 0;                   // 攀爬音效节流
    this.airTime = 0;
    this.landT = 0;                       // 落地防滑窗口：接住高处落地时被台沿接触顶出来的横向速度
    this._lastVDown = 0;                  // 上一次采样到的「沿重力方向」速度（下落为正，落地冲击判定用）
    this._lastSp = 0;                     // 上一次采样到的横向速度（区分「主动跑动」与「被顶出去」）
    this.leapT = 0;                       // 出水跃起后暂时脱离游泳判定的剩余时长
    this.lateral = 0;
    this.stepAccum = 0;
    this.hurtFlash = 0;
    this._hurtCd = 0;                     // 受击反馈去抖计时
    this.drownAccum = 0;
    this.stepSound = 0;
    this._stepVisOff = 0;                 // 上台阶的视觉补间偏移（负值 = 视觉暂时低于物理）
    this._stepVisVel = 0;                 // 视觉偏移的变化速度（临界阻尼弹簧状态）
    this.footPhase = 0;
    this.lmbBlocked = false;
    this.interact = null;
    this.statSpeed = PLAYER.walkSpeed;
    this.statJump = PLAYER.jumpPower;
    this.statGravity = 1;
    this.gravOverride = null;             // 玩家独立重力向量 [x,y,z]（null = 跟随世界重力 × 重力倍率）
    // 重力坐标系（见 _syncGravityFrame）：_down = 玩家实际重力单位方向（默认 [0,-1,0]），
    // _up = 其反方向；_gRight / _gFwd 是「垂直于重力的平面」的一组正交基（默认重力下 = 世界 X / Z 轴）。
    // 控制器里所有「向上 / 下落 / 横向（水平）」的判定都改读这四个向量：
    // 默认重力下它们恒等于旧写法（_down=(0,-1,0)、基=世界 XZ），行为逐位一致。
    this._down = new THREE.Vector3(0, -1, 0);
    this._up = new THREE.Vector3(0, 1, 0);
    this._gRight = new THREE.Vector3(1, 0, 0);
    this._gFwd = new THREE.Vector3(0, 0, 1);
    // 重力对齐（见 _syncGravityAlign）：把角色局部 +Y（头顶）旋到 _up 的四元数。
    // 基取 (gRight, up, gFwd) —— 与重力平面基同源，所以模型局部 +Z（正面）旋到世界 = gFwd，
    // 模型偏航仍可用平面内的 atan2 表示。默认重力下该四元数恒为单位四元数（姿态零回归）。
    this._gravQuat = new THREE.Quaternion();
    this._gravUp = new THREE.Vector3(0, 1, 0);   // 上次对齐用的 _up（方向未变则复用四元数）
    this._gravQuatDirty = false;                  // 方向变化后置真，待写进物理体（在 preStep 消费）
    this._gravRoot = null;                        // 模型外层对齐容器（见 _buildModel / _applyVisualPos）
    this.statCanSwim = true;
    this.statFrozen = false;
    this.statInvisible = false;
    this.env = { inLiquid: false, liquidRec: null, liquidKind: 'water', swim: false, headUnder: false, depth: 0, instantKill: false, drag: 0, submerge: 0, resist: 0 };
    this.inventory = new Inventory(9);
    this.toolPicks = new Map();   // 本局各工具已拾取次数（即拿即用类工具不进背包，用此计数判上限）
    this.respawnPoint = null;

    this.feetPos = new THREE.Vector3();
    this.headPos = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.lookDir = new THREE.Vector3(0, 0, 1);
    this.yaw = 0;
    this.animTime = 0;
    this.animSpeed = 0;
    this._visualYOff = 0;   // 姿态带来的视觉 Y 偏移（滑铲 / 待机呼吸），由 _updateModel 算出、_applyVisualPos 套用

    this._buildBody();
    this._buildModel();
  }

  /* ============================================================
     物理体
     ============================================================ */
  _buildBody() {
    const w = this.b;
    if (!w.world) return;
    const body = new CANNON.Body({
      mass: 62,
      material: w.playerMat,
      linearDamping: 0.0,
      angularDamping: 1.0,
      fixedRotation: true,
      allowSleep: false,
    });
    body.collisionFilterGroup = 2;
    body.collisionFilterMask = 1;
    body.addShape(new CANNON.Box(new CANNON.Vec3(1, 2.5, 0.5)), new CANNON.Vec3(0, 2.5, 0));
    for (const s of BODY_SPHERES) body.addShape(new CANNON.Sphere(BODY_SPHERE_R), new CANNON.Vec3(s[0], s[1], s[2]));
    this.spheres = BODY_SPHERES;
    body.userData = { player: true };
    w.world.addBody(body);
    this.body = body;
    this.slideShape = false;
    this._attachNeutralBuoyancy();
  }

  /**
   * 物理步进的 preStep 钩子（求解器之后、积分之前），干三件事：
   * 1) 把玩家实际重力对齐成「玩家自身重力向量」——
   *    无独立方向时 = 世界重力 × 重力倍率(statGravity，默认 1 → 与世界完全一致，行为不变)；
   *    有独立方向时（事件「重力变化」只作用于玩家）= 该向量；
   * 2) 游泳 / 攀爬 / 贴墙时抵消玩家重力，否则玩家永远被往下拽（上浮 / 悬挂都失效）；
   * 3) 地面横向刹车（见 _brakeLateral）：站在平台 / 斜坡上时刹住横向力，不随坡下滑。
   */
  _attachNeutralBuoyancy() {
    const world = this.world;
    if (!world || !world.addEventListener || this._preStepFn) return;
    this._preStepFn = () => {
      if (!this.alive || !this.body) return;
      this._syncGravityFrame();                // 先刷新重力坐标系：施力与横向刹车都用同一份方向
      this._syncGravityAlign();                // 刷新重力对齐四元数（方向变化时）
      this._applyGravityAlignToBody();         // 碰撞盒随重力旋转（写在这里，插值不滞后）
      const g = world.gravity;
      const m = this.body.mass;
      const pg = this._gravityVec(g);          // 玩家实际重力向量
      const noGrav = (this.env.inLiquid && this.env.swim && this.statCanSwim && this.leapT <= 0)
        || this.state === 'climb' || this.state === 'walljump';   // 攀爬 / 贴墙时抵消重力，不然会往下滑
      const gZero = g.x === 0 && g.y === 0 && g.z === 0;
      const pgZero = pg.x === 0 && pg.y === 0 && pg.z === 0;
      if (!noGrav && gZero && pgZero) return;
      // cannon 已按世界重力给玩家施力，这里补上差值：
      //   非抵消态 → 补 (pg − g)，使玩家实际受力 = m × pg（默认 pg==g，补 0，与改动前一致）
      //   抵消态   → 补 −g，抵消世界重力
      const fx = noGrav ? -g.x : (pg.x - g.x);
      const fy = noGrav ? -g.y : (pg.y - g.y);
      const fz = noGrav ? -g.z : (pg.z - g.z);
      this.body.force.x += m * fx;
      this.body.force.y += m * fy;
      this.body.force.z += m * fz;
      this._brakeLateral();
    };
    world.addEventListener('preStep', this._preStepFn);
  }

  /** 玩家实际重力向量：有独立方向用独立向量，否则 = 世界重力 × 重力倍率 */
  _gravityVec(worldG) {
    const ov = this.gravOverride;
    if (Array.isArray(ov) && ov.length >= 3) {
      return { x: Number(ov[0]) || 0, y: Number(ov[1]) || 0, z: Number(ov[2]) || 0 };
    }
    const k = Number(this.statGravity);
    const kk = Number.isFinite(k) ? k : 1;
    return { x: worldG.x * kk, y: worldG.y * kk, z: worldG.z * kk };
  }

  /* ============================================================
     重力坐标系（支持任意重力方向：世界重力 × 倍率 / 玩家独立重力）
     - _down / _up：玩家实际重力单位方向与其反方向（默认 (0,-1,0)/(0,1,0)）
     - _gRight / _gFwd：垂直于重力的平面基（默认 = 世界 X / Z 轴）
     所有控制器逻辑都通过下面几个分解函数读写「沿重力 / 横向」的速度分量，
     默认重力下它们与旧的 Y 轴写法数学上完全等价（沿重力分量 = −v.y，横向 = (v.x, 0, v.z)）。
     ============================================================ */
  /**
   * 刷新重力坐标系（每帧 update 开头 + 物理 preStep 各调一次）。
   * 世界重力与玩家独立重力都为 0 时保留上一次的方向（初始 -Y），
   * 这样跳跃 / 着地判定始终有一个参考「下」方向，不会因重力归零而失去参照。
   */
  _syncGravityFrame() {
    const wg = (this.world && this.world.gravity) ? this.world.gravity : { x: 0, y: -PHYS.gravity, z: 0 };
    const pg = this._gravityVec(wg);
    const len = Math.hypot(pg.x, pg.y, pg.z);
    if (len > 1e-6) {
      this._down.set(pg.x / len, pg.y / len, pg.z / len);
      this._up.set(-this._down.x, -this._down.y, -this._down.z);
    }
    // 平面基：参考轴取世界 Y；重力接近 ±Y 时改用世界 Z（避免叉积退化）。
    // 默认重力下恒得 right=(1,0,0) / fwd=(0,0,1)，与旧的世界 XZ 水平面一致。
    const d = this._down;
    const rx = 0, ry = Math.abs(d.y) > 0.999 ? 0 : 1, rz = Math.abs(d.y) > 0.999 ? 1 : 0;
    let x = ry * d.z - rz * d.y, y = rz * d.x - rx * d.z, z = rx * d.y - ry * d.x;
    const rl = Math.hypot(x, y, z) || 1;
    x /= rl; y /= rl; z /= rl;
    this._gRight.set(x, y, z);
    this._gFwd.set(d.y * z - d.z * y, d.z * x - d.x * z, d.x * y - d.y * x);
  }

  /** 速度沿重力方向的分量（下落为正；默认重力下 = −v.y） */
  _vDown(v) { const d = this._down; return v.x * d.x + v.y * d.y + v.z * d.z; }
  /** 把速度的「沿重力分量」改成 alongDown，横向不动（默认重力下 = 把 v.y 改为 −alongDown） */
  _setVDown(v, alongDown) {
    const d = this._down;
    const k = alongDown - (v.x * d.x + v.y * d.y + v.z * d.z);
    v.x += d.x * k; v.y += d.y * k; v.z += d.z * k;
  }
  /** 速度的横向（垂直重力平面内）分量写进 out（默认重力下 = (v.x, 0, v.z)） */
  _vLat(v, out) {
    const d = this._down;
    const vd = v.x * d.x + v.y * d.y + v.z * d.z;
    return out.set(v.x - d.x * vd, v.y - d.y * vd, v.z - d.z * vd);
  }
  /** 把速度的横向整体缩放为 k 倍，沿重力分量不动（默认重力下 = v.x / v.z × k） */
  _scaleLat(v, k) {
    const d = this._down;
    const vd = v.x * d.x + v.y * d.y + v.z * d.z;
    v.x = d.x * vd + (v.x - d.x * vd) * k;
    v.y = d.y * vd + (v.y - d.y * vd) * k;
    v.z = d.z * vd + (v.z - d.z * vd) * k;
  }
  /** 把速度的横向替换为 (x,y,z)，沿重力分量不动（默认重力下 = 只设 v.x / v.z，y 传 0） */
  _setLat(v, x, y, z) {
    const d = this._down;
    const vd = v.x * d.x + v.y * d.y + v.z * d.z;
    v.x = d.x * vd + x; v.y = d.y * vd + y; v.z = d.z * vd + z;
  }
  /** 把「垂直重力平面内」的 (a, b) 偏移换算成世界偏移写进 out（默认重力下 = (a, 0, b)） */
  _gPlaneOffset(a, b, out) {
    const r = this._gRight, f = this._gFwd;
    return out.set(r.x * a + f.x * b, r.y * a + f.y * b, r.z * a + f.z * b);
  }
  /** 世界方向 → 重力平面内的偏航角（绕重力轴；默认重力下 = atan2(x, z)）。用于模型 / 镜头朝向 */
  _planeYaw(x, y, z) {
    const r = this._gRight, f = this._gFwd;
    return Math.atan2(x * r.x + y * r.y + z * r.z, x * f.x + y * f.y + z * f.z);
  }

  /**
   * 刷新「重力对齐四元数」：把角色局部 +Y（头顶）旋到 _up。基取 (gRight, up, gFwd)，
   * 于是局部 +X → gRight、局部 +Z → gFwd，模型偏航仍可用 _planeYaw 表示。
   * 方向未变时直接复用（默认重力下永远走这条，结果恒为单位四元数，零开销、零回归）。
   */
  _syncGravityAlign() {
    const up = this._up;
    const last = this._gravUp;
    if (up.x === last.x && up.y === last.y && up.z === last.z) return;
    last.copy(up);
    _gravMat.makeBasis(this._gRight, up, this._gFwd);
    this._gravQuat.setFromRotationMatrix(_gravMat);
    this._gravQuatDirty = true;
  }

  /**
   * 把重力对齐四元数写进物理体（碰撞盒随重力旋转）。
   * 只在方向变化时写；必须放在 preStep —— cannon 的 integrate 会在本步开头把
   * quaternion 拷进 previousQuaternion，因此插值不会滞后一帧。
   */
  _applyGravityAlignToBody() {
    if (!this._gravQuatDirty || !this.body) return;
    this._gravQuatDirty = false;
    const q = this._gravQuat;
    this.body.quaternion.set(q.x, q.y, q.z, q.w);
    this.body.aabbNeedsUpdate = true;
  }

  /**
   * 地面横向刹车：踩在平台 / 斜坡上（grounded）时把横向速度刹掉，玩家不会顺坡下滑。
   *
   * 为什么必须放在 preStep（求解器之后、integrate 之前）：
   * cannon 的 integrate 会同时更新速度与位置，所以在 _move（step 之前）或 postStep（step 之后）
   * 刹车都拦不住这一步的位移；而求解器每一步都会把重力沿坡面的分量变成一小段横向速度，
   * 只有在这里把它清掉，这一步的水平位移才真的是 0。
   *
   * 「刹住横向力，同时只允许朝控制的方向运动」：
   *   - 站定（无输入）：横向速度直接归零（默认重力下 = v.x / v.z 归零）→ 横向力被刹死；
   *   - 移动（有输入，无墙）：把横向速度投影到控制方向（丢掉垂直于控制方向的分量）→
   *     横向力被刹住，只保留沿控制方向的分量，玩家只能朝控制的方向运动；
   *   - 移动（有输入，抵墙）：改为只清掉「朝墙分量」、保留沿墙切向。若仍投影到控制方向，
   *     会把求解器刚清掉的朝墙分量重新塞回来（45° 斜撞每步往墙里钻一点 → 穿墙），
   *     同时把沿墙切向也砍掉（45° 走不快）。
   * 「横向」= 垂直于重力的平面内（默认重力下即水平面）；沿重力分量（v.y）一律不碰，
   * 重力 / 跳跃 / 落地手感与改动前一致。
   */
  _brakeLateral() {
    if (this.onZipline) return;
    const st = this.state;
    if (st === 'slide' || st === 'climb' || st === 'walljump' || st === 'swim') return;
    const v = this.body.velocity;
    const vd = this._vDown(v);                    // 沿重力分量（下落为正；默认 = −v.y）
    const vu = -vd;                               // 沿反重力分量（默认 = v.y）
    // 刚离地的一小段（coyote）内也照常刹车：站在台沿 / 棱角上时着地判定可能闪断，
    // 这时若直接放行，棱角接触每步顶出来的横向速度没人刹住，人会一点点滑出平台边缘。
    // 跳跃会立刻把 coyote 清零（见 _tryJump），因此起跳不受影响；「向上」速度 vu > 1 时也跳过。
    // 硬着陆后的 landT 窗口同理（见 _probeGround）：接住落地冲击让台沿棱角顶出来的横向速度，
    // 门槛放宽到 vu <= 6 是为了容忍落地的小回弹，正常起跳（vu 高达数十）不受影响。
    const grip = this.grounded || (this.coyote > 0 && vu <= 1) || (this.landT > 0 && vu <= 6);
    if (!grip) return;
    const wall = this._wallN;                     // _move 每帧缓存的「当前顶住的墙」
    const wish = this.wishDir(_v);
    if (wish.lengthSq() > 0.01) {
      if (wall) {
        // 抵墙：绝不能把速度投影到输入方向 —— 那会把接触求解器刚清掉的「朝墙分量」
        // 原样塞回来，斜撞 45° 时每步都往墙里钻一点，薄墙 / 网格体就直接穿过去。
        // 这里只清掉朝墙分量、保留沿墙切向：既不再压墙（防穿墙），45° 时又正好全速沿墙走。
        // 墙法线已投影到垂直重力平面（默认重力下 uy 恒为 0）。
        const into = v.x * wall.ux + v.y * wall.uy + v.z * wall.uz;    // >0 = 正在朝墙里钻
        if (into > 0) { v.x -= wall.ux * into; v.y -= wall.uy * into; v.z -= wall.uz * into; }
        return;
      }
      // 无墙（斜坡防滑 / 边缘防滑）：只保留沿控制方向的分量，刹住横向力。
      // 控制方向先投影到垂直重力的平面（默认重力下就是原 wish 方向）
      this._vLat(wish, _v2);
      const wl = Math.hypot(_v2.x, _v2.y, _v2.z);
      if (wl > 1e-4) {
        _v2.multiplyScalar(1 / wl);
        const along = v.x * _v2.x + v.y * _v2.y + v.z * _v2.z;
        this._setLat(v, _v2.x * along, _v2.y * along, _v2.z * along);
      } else {
        // 控制方向几乎完全沿重力轴（没有可走的横向分量）：横向直接刹死
        this._setLat(v, 0, 0, 0);
      }
    } else {
      this._vLat(v, _v3);
      if (this.grounded || this.landT > 0 || Math.hypot(_v3.x, _v3.y, _v3.z) < 4) {
        // 站定：刹住横向力，不随斜坡下滑；空中（coyote 内）只在残余速度很低时刹死，
        // 主动走出边缘的正常惯性（速度较高）保留，不会把人「钉」在边缘上；
        // 落地防滑窗口内一律刹死 —— 这份横向速度来自冲击，不是玩家的意图
        this._setLat(v, 0, 0, 0);
      }
    }
  }

  setSlideShape(on) {
    if (!this.body || this.slideShape === on) return;
    this.body.shapes.length = 0;
    this.body.shapeOffsets.length = 0;
    this.body.shapeOrientations.length = 0;
    if (on) this.body.addShape(new CANNON.Box(new CANNON.Vec3(1, PLAYER.slideHalfH, 0.5)), new CANNON.Vec3(0, PLAYER.slideHalfH, 0));
    else this.body.addShape(new CANNON.Box(new CANNON.Vec3(1, 2.5, 0.5)), new CANNON.Vec3(0, 2.5, 0));
    const spheres = on ? BODY_SPHERES_SLIDE : BODY_SPHERES;
    const sr = on ? SLIDE_SPHERE_R : BODY_SPHERE_R;
    for (const s of spheres) this.body.addShape(new CANNON.Sphere(sr), new CANNON.Vec3(s[0], s[1], s[2]));
    this.spheres = spheres;
    this.body.updateBoundingRadius();
    this.body.aabbNeedsUpdate = true;
    this.body.updateMassProperties();
    this.slideShape = on;
  }

  get slideActive() { return this.state === 'slide'; }

  /* ============================================================
     R6 模型
     ============================================================ */
  _buildModel() {
    const g = new THREE.Group();
    g.name = 'player';
    // 旋转顺序 YXZ：先偏航(Y)、再俯仰(X)。默认的 XYZ 会把俯仰绕在「世界 X 轴」上，
    // 一旦角色朝向不是 ±Z，滑铲 / 游泳的前倾就变成侧翻 → 姿势七歪八扭。
    // YXZ 让俯仰绕角色自身的右轴，任何朝向下前倾都正确。
    g.rotation.order = 'YXZ';
    const mk = (w, h, d, color, x, y, z, emissive) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({
        color: new THREE.Color(color), roughness: 0.62, metalness: 0.04,
      }));
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      if (emissive) m.material.emissive = new THREE.Color(emissive);
      applyScreenGrade(m.material);   // 画面处理：饱和度 / 染色
      return m;
    };
    const skin = this.editor ? '#f5c9a0' : '#f2bd94';
    this.torso = mk(2, 2, 1, '#4f6bd8', 0, 3, 0);
    this.head = mk(1, 1, 1, skin, 0, 4.5, 0);
    // 脸（正面小贴块）：作为 head 的子节点，坐标必须是「相对 head」的局部坐标，
    // 之前写的是 root 坐标（4.62 等）→ 黑块飘在头顶上方约 4 stud 处
    const face = mk(0.7, 0.28, 0.02, '#2a2338', 0, 0.12, 0.51);
    face.castShadow = false;
    this.head.add(face);
    const face2 = mk(0.7, 0.12, 0.02, '#2a2338', 0, -0.24, 0.51);
    face2.castShadow = false;
    this.head.add(face2);

    this.armL = new THREE.Group(); this.armL.position.set(-1.5, 4, 0);
    this.armR = new THREE.Group(); this.armR.position.set(1.5, 4, 0);
    const armMeshL = mk(1, 2, 1, '#ffd98a', 0, -1, 0);
    const armMeshR = mk(1, 2, 1, '#ffd98a', 0, -1, 0);
    this.armL.add(armMeshL); this.armR.add(armMeshR);
    this.legL = new THREE.Group(); this.legL.position.set(-0.5, 2, 0);
    this.legR = new THREE.Group(); this.legR.position.set(0.5, 2, 0);
    this.legL.add(mk(1, 2, 1, '#2f3550', 0, -1, 0));
    this.legR.add(mk(1, 2, 1, '#2f3550', 0, -1, 0));

    // 三层形象容器：R6 默认 / R6 预设变体 / 导入的骨骼模型
    this.r6Base = new THREE.Group(); this.r6Base.name = 'r6-base';
    this.r6Preset = new THREE.Group(); this.r6Preset.name = 'r6-preset';
    this.avatarSlot = new THREE.Group(); this.avatarSlot.name = 'avatar-slot';
    this.r6Base.add(this.torso, this.head, this.armL, this.armR, this.legL, this.legR);
    g.add(this.r6Base, this.r6Preset, this.avatarSlot);
    // 头顶名牌（Sprite 始终面向相机），文字与开关都读设置
    this.nameTag = makeNameTagSprite();
    g.add(this.nameTag);
    this.model = g;
    this.parts = [this.torso, this.head, this.armL, this.armR, this.legL, this.legR];
    // 当前驱动程序姿态的骨架（默认 R6，切预设时指向预设部件）
    this.rigBase = { torso: this.torso, head: this.head, armL: this.armL, armR: this.armR, legL: this.legL, legR: this.legR };
    this.rig = this.rigBase;
    this.presetId = '';
    this._presetParts = null;
    // 模型外层「重力对齐」容器：其 quaternion = _gravQuat（局部 +Y 对着 _up），位置 = 脚底世界坐标。
    // g 本身仍只承载「局部偏航（绕重力轴）+ 姿态前倾」，回放里直接写 p.model.rotation.y 也不受影响。
    // 默认重力下 _gravQuat 恒为单位四元数，容器等价于一个平移节点 —— 与改动前完全一致。
    this._gravRoot = new THREE.Group();
    this._gravRoot.name = 'player-grav';
    this._gravRoot.add(g);
    if (this.b.scene) this.b.scene.add(this._gravRoot);
    else if (this.b.root) this.b.root.add(this._gravRoot);
    this.avatar = new PlayerAvatar(this.avatarSlot, { targetHeight: PLAYER.totalH });
    this.setInvisible(false);
  }

  setInvisible(on) {
    this.statInvisible = on;
    const visible = !on;
    for (const p of this.parts) p.visible = visible;
  }

  /** 锚定（等同于物体的「锚定(无物理)」）：body 转静态，不再被重力/速度积分推走 */
  setAnchored(on) {
    on = !!on;
    if (this.anchored === on) return;
    this.anchored = on;
    if (!this.body) return;
    this.body.type = on ? CANNON.Body.STATIC : CANNON.Body.DYNAMIC;
    this.body.velocity.set(0, 0, 0);
    this.body.updateMassProperties();
    this.body.aabbNeedsUpdate = true;
  }

  /** 冻结移动输入：进关倒数期间把玩家钉在原处 —— 不响应走/跳/爬，只保留鼠标视角与物理下落（落回地面） */
  setInputFrozen(on) { this.inputFrozen = !!on; }

  /* ============================================================
     形象 morph
     ============================================================ */
  /**
   * 改变玩家形象。
   * cfg = { mode:'preset'|'model'|'default', preset, assetId, scale, yawOffset, yOffset }
   * - preset：内置程序化 R6 变体（同步生效）
   * - model ：导入的 .glb / .obj（异步加载，加载期间保持原形象可见）
   * - default：还原经典 R6
   */
  async morph(cfg) {
    const c = cfg || {};
    if (c.mode === 'model') {
      this._clearPreset();
      return this.avatar ? this.avatar.apply(c) : false;
    }
    if (this.avatar) this.avatar.restore();
    if (c.mode === 'preset' && c.preset) return this.setPreset(c.preset);
    return this.restoreDefault();
  }

  /** 切到内置预设形象 */
  setPreset(id) {
    const def = presetDef(id);
    if (!def) return false;
    const built = buildR6Parts(def, { skin: this.editor ? '#f5c9a0' : '#f2bd94' });
    this._clearPreset();
    this.r6Preset.add(built.root);
    this._presetParts = built;
    this.rig = built;
    this.presetId = id;
    return true;
  }

  /** 还原默认 R6 形象 */
  restoreDefault() {
    this._clearPreset();
    return true;
  }

  _clearPreset() {
    if (this._presetParts) {
      const root = this._presetParts.root;
      if (root.parent) root.parent.remove(root);
      root.traverse((o) => {
        if (!o.isMesh) return;
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this._presetParts = null;
    }
    if (this.presetId) this.presetId = '';
    this.rig = this.rigBase;
  }

  /** 供角色动画消费的只读状态快照 */
  _animState() {
    return {
      alive: this.alive, state: this.state, grounded: this.grounded,
      vy: this.body ? this.body.velocity.y : 0, speed: this.speed,
      onZipline: this.onZipline, inLiquid: this.env.inLiquid,
      swim: this.env.swim, headUnder: this.env.headUnder,
    };
  }

  /* ============================================================
     输入方向（相机空间 → 世界）
     ============================================================ */
  wishDir(out = new THREE.Vector3()) {
    const i = this.input;
    if (!i) return out.set(0, 0, 0);
    let fx = 0, fz = 0;
    if (i.act('forward')) fz += 1;
    if (i.act('backward')) fz -= 1;
    if (i.act('left')) fx -= 1;
    if (i.act('right')) fx += 1;
    // 镜像地图：世界左右是反的，把左右的「操作」再翻回来 —— 按 D 依旧向屏幕右侧走
    if (this.mirror) fx = -fx;
    if (fx === 0 && fz === 0) return out.set(0, 0, 0);
    // 2D 平台模式：前方 = 相机朝向 n（投影到垂直重力的平面），右方 = 前方 × 上，让 WASD 仍贴合屏幕方向
    if (this.cameraCtl && this.cameraCtl.platformOn) {
      const n = this.cameraCtl.platform.normal;
      const up = this._up;
      const nd = n.x * up.x + n.y * up.y + n.z * up.z;
      let fpx = n.x - up.x * nd, fpy = n.y - up.y * nd, fpz = n.z - up.z * nd;
      const fl = Math.hypot(fpx, fpy, fpz);
      if (fl < 1e-4) { const f = this._gFwd; fpx = -f.x; fpy = -f.y; fpz = -f.z; }
      else { fpx /= fl; fpy /= fl; fpz /= fl; }
      const rx = fpy * up.z - fpz * up.y, ry = fpz * up.x - fpx * up.z, rz = fpx * up.y - fpy * up.x;   // 前方 × 上
      out.set(fx * rx + fz * fpx, fx * ry + fz * fpy, fx * rz + fz * fpz);
      return out.normalize();
    }
    const yaw = this.cameraCtl ? this.cameraCtl.yaw : this.yaw;
    // 镜头前方（水平）= -sinY·gRight - cosY·gFwd，镜头右方 = cosY·gRight - sinY·gFwd
    // （默认重力下 gRight=(1,0,0) / gFwd=(0,0,1) → 与旧的 (fx·cosY-fz·sinY, 0, -fx·sinY-fz·cosY) 逐位一致）
    const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
    const aR = fx * cosY - fz * sinY;      // 沿镜头右方的系数
    const aF = -fx * sinY - fz * cosY;     // 沿平面另一轴（gFwd）的系数
    const r = this._gRight, f = this._gFwd;
    out.set(aR * r.x + aF * f.x, aR * r.y + aF * f.y, aR * r.z + aF * f.z);
    return out.normalize();
  }

  camForward(out = new THREE.Vector3()) {
    if (this.cameraCtl) return this.cameraCtl.forward(out);
    return out.set(0, 0, 1);
  }

  /* ============================================================
     每帧更新
     ============================================================ */
  update(dt) {
    this.animTime += dt;
    if (!this.alive) { this._updateModel(dt); return; }
    const b = this.b;
    const v = this.body.velocity;
    this._syncGravityFrame();     // 刷新重力坐标系（_down / _up / 平面基）：本帧所有重力相对逻辑都读它
    this._syncGravityAlign();     // 刷新重力对齐四元数：模型随重力转向（默认重力下恒为单位四元数）
    const up = this._up;
    this.zipCool = Math.max(0, this.zipCool - dt);
    this.climbCool = Math.max(0, this.climbCool - dt);
    this.climbHopT = Math.max(0, this.climbHopT - dt);
    this.hopCool = Math.max(0, this.hopCool - dt);
    this.ledgeCool = Math.max(0, this.ledgeCool - dt);
    this.climbSfxT = Math.max(0, this.climbSfxT - dt);
    this.leapT = Math.max(0, this.leapT - dt);
    this.upLockT = Math.max(0, this.upLockT - dt);
    this.wallLaunchT = Math.max(0, this.wallLaunchT - dt);
    this.landT = Math.max(0, this.landT - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this._hurtCd = Math.max(0, this._hurtCd - dt);
    this.headPos.set(this.body.position.x + up.x * (PLAYER.totalH - 0.5),
      this.body.position.y + up.y * (PLAYER.totalH - 0.5),
      this.body.position.z + up.z * (PLAYER.totalH - 0.5));

    this._probeGround(dt);
    this._stepVisUpdate(dt);      // 上台阶的视觉补间（只动视觉层，不影响物理）
    if (this.inputFrozen) {
      // 进关倒数：把玩家钉在原处 —— 不响应移动明细，水平速度清零；
      // 竖直方向仍交给物理（出生点在地面之上时自然落回地面），视角照常可转
      v.x = 0; v.z = 0;
      this._handleLookInput();
      this._updateOxygen(dt);
      this._updateInteract();
      this._updateModel(dt);
      this.feetPos.set(this.body.position.x, this.body.position.y, this.body.position.z);
      this.velocity.set(v.x, v.y, v.z);
      void b;
      return;
    }
    this._handleActions(dt);
    this._move(dt);
    this._limitSweep();
    this._updateOxygen(dt);
    this._updateInteract();
    this._updateModel(dt);

    this.feetPos.set(this.body.position.x, this.body.position.y, this.body.position.z);
    this.velocity.set(v.x, v.y, v.z);
    void b;
  }

  /* ---------- 地面 / 墙 ---------- */
  _probeGround(dt) {
    const p = this.body.position;
    const up = this._up;
    let grounded = false;
    // 1) 物理接触法线
    if (this.world) {
      for (const c of this.world.contacts) {
        if (c.bi !== this.body && c.bj !== this.body) continue;
        const n = c.bi === this.body ? c.ni : { x: -c.ni.x, y: -c.ni.y, z: -c.ni.z };
        // n 指向对方 → 若指向「反重力方向（上方）」则对方在地面。棱角接触的法线是斜的，门槛放宽见 GROUND_NORMAL_MIN
        if (n.x * up.x + n.y * up.y + n.z * up.z >= GROUND_NORMAL_MIN) continue;
        grounded = true;
        break;
      }
      // 2) 沿重力方向的射线（更稳）：中心 + 盒底四角 + 四边中点都探一遍，
      //    站在边缘时只要有一处踩到可站立顶面就算着地。
      //    探测点铺在「垂直于重力的平面」上（默认重力下 = 原来的世界 XZ 脚印，逐点等价）
      if (!grounded) {
        for (const [oa, ob] of GROUND_PROBES) {
          this._gPlaneOffset(oa, ob, _v);
          _from.set(p.x + _v.x + up.x * GROUND_RAY_UP,
            p.y + _v.y + up.y * GROUND_RAY_UP,
            p.z + _v.z + up.z * GROUND_RAY_UP);
          _to.set(p.x + _v.x - up.x * 0.55, p.y + _v.y - up.y * 0.55, p.z + _v.z - up.z * 0.55);
          _ray.reset();
          this.world.raycastClosest(_from, _to, { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: true }, _ray);
          const hn = _ray.hitNormalWorld;
          if (_ray.hasHit && hn.x * up.x + hn.y * up.y + hn.z * up.z > 0.5) {
            grounded = true;
            break;
          }
        }
      }
    }
    this.wasGrounded = this.grounded;
    this.grounded = grounded && this.state !== 'zipline' && this.state !== 'walljump' && this.state !== 'climb';
    if (this.grounded) {
      this.coyote = PLAYER.coyoteTime;
      this.airTime = 0;
      if (!this.wasGrounded && this.state !== 'swim') {
        const fall = Math.abs(this._lastVDown || 0);
        if (fall > 26) audio.land(clamp(fall / 90, 0.25, 1));
        if (fall > 60) this.shake(0.3);
      }
    } else {
      this.coyote = Math.max(0, this.coyote - dt);
      this.airTime += dt;
    }
    // 硬着陆判定：上一步还在快速「沿重力下坠」（_lastVDown > 9），这一步沿重力速度被接触求解几乎止住
    // （下坠速度掉了 6 以上）→ 落地。高处落到「靠近台沿」的位置时，冲击会让盒角 / 球底与平台棱角
    // 产生横向接触，把人往外顶出来一份横向速度；若落地前几乎没横向速度（不是主动跑着落下），
    // 就开一个短暂的防滑窗口，把它刹住（见 _brakeLateral）。
    const vdNow = this._vDown(this.body.velocity);
    if (this._lastVDown > 9 && this._lastVDown - vdNow > 6 && this._lastSp < 6) {
      this.landT = Math.max(this.landT, LAND_GRIP_TIME);
    }
    this._lastVDown = vdNow;
    this._vLat(this.body.velocity, _v3);
    this._lastSp = Math.hypot(_v3.x, _v3.y, _v3.z);
  }

  /* ---------- 高速穿透防护 ----------
   * cannon 的 Sphere×Trimesh 没有「球心在三角面哪一侧」的判定：球心一旦在一步内越过面，
   * 接触法线就反向、把玩家往网格里推（实测 v>60 起偶发穿进管道，v=240 必穿）；
   * Box 类窄相在同样速度下也会陷进薄平台。因此每步落地前沿运动方向、从各内切球心
   * 各探一条 v·dt 的射线，命中就把速度压到「单步位移不超过安全值，且这一步不跨过该面」。 */
  _limitSweep() {
    if (!this.world) return;
    const v = this.body.velocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    const step = speed * PHYS.timeStep;      // 物理固定步长下的单步位移
    if (step <= SWEEP_MAX_STEP) return;      // 普通行走 / 跳跃落地不会进入这里
    const p = this.body.position;
    const reach = step + SWEEP_GAP_KEEP;
    _sweepDir.set(v.x / speed, v.y / speed, v.z / speed);
    let gap = Infinity;
    let hitN = null;
    for (const s of this.spheres) {
      _sweepFrom.set(p.x + s[0], p.y + s[1], p.z + s[2]);
      _sweepTo.set(_sweepFrom.x + _sweepDir.x * reach, _sweepFrom.y + _sweepDir.y * reach, _sweepFrom.z + _sweepDir.z * reach);
      _sweepRes.reset();
      this.world.raycastClosest(_sweepFrom, _sweepTo, { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: true }, _sweepRes);
      if (_sweepRes.hasHit && _sweepRes.distance < gap) {
        gap = _sweepRes.distance;
        hitN = _sweepRes.hitNormalWorld;
      }
    }
    if (!isFinite(gap) || !hitN) return;
    // 法线方向（指向表面为负）的速度限制在 60 studs/s 以内；切线分量完全保留
    // 原来的整体按比例缩放（vn 含切线分量）会让玩家沿斜墙/管道滑也被减速，这里改为只钳法线
    const LIMIT = 60;
    const vn = v.x * hitN.x + v.y * hitN.y + v.z * hitN.z;
    if (vn < -LIMIT) {
      const over = vn + LIMIT;
      v.x -= hitN.x * over;
      v.y -= hitN.y * over;
      v.z -= hitN.z * over;
    }
  }

  /* ---------- 动作输入 ---------- */
  /** 处理视角旋转（倒数冻结期间也照常生效） */
  _handleLookInput() {
    const i = this.input;
    if (!i || !i.looking) return;
    const l = i.takeLook();
    // 镜像地图：画面左右是反的，视角的左右增量也要反 —— 鼠标右移依旧画面右转
    const dx = this.mirror ? -l.dx : l.dx;
    if (dx || l.dy) this.cameraCtl && this.cameraCtl.look(dx, l.dy);
  }

  _handleActions(dt) {
    const i = this.input;
    if (!i) return;
    const jumpPressed = i.actPressed('jump');
    const jumpHeld = !!(i.act && i.act('jump'));
    if (jumpPressed) this.jumpBuf = PLAYER.jumpBuffer;
    else this.jumpBuf = Math.max(0, this.jumpBuf - dt);

    // 视角
    this._handleLookInput();
    const wheel = i.takeWheel();
    if (wheel) this.cameraCtl && this.cameraCtl.zoom(wheel);
    if (i.actPressed('cameraToggle')) this.cameraCtl && this.cameraCtl.toggleMode();

    // 数字键选工具：1~9 选择 / 再按一次取消，0 取消选择（只做选择，不拿在手上）
    for (let n = 1; n <= 9; n++) {
      if (!i.keyPressed('Digit' + n)) continue;
      const idx = n - 1;
      if (this.inventory.current && this.inventory.selected === idx) this.inventory.deselect();
      else this.inventory.select(idx);
    }
    if (i.keyPressed('Digit0')) this.inventory.deselect();

    const diveDown = this._diveDown();
    const divePressed = this._divePressed();
    const usePressed = i.actPressed('useTool');

    // 滑铲未结束时松开滑铲键 → 立即停止滑铲
    if (this.state === 'slide' && !diveDown) this._endSlide();

    // 滑索中：只能滑到末端自动脱离，中途不得脱离（跳跃 / 下潜键都无效）
    if (this.onZipline) return;

    // 贴墙
    if (this.state === 'walljump') {
      if (jumpPressed) {
        this.mechanisms && this.mechanisms.applyWalljumpLaunch(this, { rec: this.wallRec, normal: this.wallNormal });
        this._endWall();
        this.jumpBuf = 0;
      }
      return;
    }

    // 攀爬：按空格上跳（按住 = 连续上跳 / 快爬，松手后不再吸附）
    if (this.state === 'climb') {
      if (jumpPressed || (jumpHeld && this.hopCool <= 0)) this._climbHop();
      this.jumpBuf = 0;
      return;
    }

    // 水下（头部没入）：空格上浮 / 下潜键下潜
    if (this.env.inLiquid && this.env.swim && this.statCanSwim && this.leapT <= 0) {
      if (usePressed && this.lmbBlocked) this.useSelected();
      return;
    }

    // 地面 / 空中：按住跳跃键 = 落地瞬间自动再跳（不会空中连跳）
    if (jumpPressed || (jumpHeld && this.grounded)) this._tryJump();
    if (divePressed) {
      if (this.grounded) this._trySlide();
      else this._dive();
    } else if (usePressed && this.lmbBlocked) {
      this.useSelected();
    }
  }

  /** 下潜 / 速降 / 滑铲是否按住：键盘键（F）永远可用，鼠标左键仅在瞄准可交互物时被屏蔽 */
  _diveDown() {
    const i = this.input;
    if (!i) return false;
    if (i.actKey && i.actKey('dive')) return true;
    return !!(i.actMouse && i.actMouse('dive') && !this.lmbBlocked);
  }
  _divePressed() {
    const i = this.input;
    if (!i) return false;
    if (i.actKeyPressed && i.actKeyPressed('dive')) return true;
    return !!(i.actMousePressed && i.actMousePressed('dive') && !this.lmbBlocked);
  }

  _tryJump() {
    if (this.grounded || this.coyote > 0) {
      // 起跳速度给到「反重力方向」：横向分量保留，沿重力分量整体替换成跳跃速度
      // （默认重力下即 v.y = statJump，与改动前一致）
      this._setVDown(this.body.velocity, -this.statJump);
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuf = 0;
      audio.jump();
      if (this.state === 'slide') this._endSlide();
      this.events && this.events.emitTrigger('playerJump', {});
    } else {
      // 尝试抓滑索 / 贴墙
      const z = this.mechanisms && this.mechanisms.findZipline(this);
      if (z) {
        this.mechanisms.attachZipline(this, z.rec, 0);
        this.jumpBuf = 0;
      }
    }
  }

  _trySlide() {
    if (this.state === 'slide') return;   // 无冷却：滑铲结束即可再次起滑
    const v = this.body.velocity;
    const w = this.wishDir(_v);
    // 允许静止起滑：没有移动输入时朝镜头前方滑
    const dir = w.lengthSq() > 0.01 ? w : this.camForward(_v2).setY(0).normalize();
    if (dir.lengthSq() < 0.01) return;
    // 滑行方向投影到「垂直于重力的平面」（默认重力下 = 原水平方向，行为不变）
    this._vLat(dir, _v3);
    const dl = Math.hypot(_v3.x, _v3.y, _v3.z);
    if (dl < 1e-4) return;
    _v3.multiplyScalar(1 / dl);
    this.state = 'slide';
    this.slideTimer = PLAYER.slideDuration;
    this.setSlideShape(true);
    this._slideDir = _v3.clone();
    // 滑铲速度 = 行动速度：横向设为滑行方向 × 速度，沿重力分量（下落）不动
    this._setLat(v, _v3.x * this.statSpeed, _v3.y * this.statSpeed, _v3.z * this.statSpeed);
    audio.land(0.5);
    this.fx && this.fx.hit(_v.set(this.body.position.x, this.body.position.y + 0.3, this.body.position.z), '#cfc8e8', 8);
  }

  _endSlide() {
    if (this.state !== 'slide') return;
    this.state = 'normal';
    this.slideTimer = 0;
    this.setSlideShape(false);
  }

  _dive() {
    const v = this.body.velocity;
    // 速降：把「沿重力方向」的下落速度抬到 diveSpeed 以上（默认重力下即 v.y = min(v.y, -diveSpeed)）
    if (this._vDown(v) < PLAYER.diveSpeed) this._setVDown(v, PLAYER.diveSpeed);
    audio.click(0.4);
  }

  /* ---------- 贴墙 ---------- */
  /** 空中碰到 WallJump 墙 → 贴上；返回是否已进入贴墙状态 */
  _tryWalljump() {
    if (this.state === 'walljump' || this.state === 'climb' || this.onZipline) return false;
    if (this.grounded) { this.wallLeftRec = null; return false; }   // 落地后重新允许贴墙
    if (this.env.inLiquid) return false;
    const w = this.mechanisms && this.mechanisms.findWalljump(this);
    if (!w) { this.wallLeftRec = null; return false; }              // 已离开墙面
    if (this.wallLeftRec === w.rec) return false;                   // 刚脱离的这面墙：不再粘回去（超时后能真正掉下去）
    this.state = 'walljump';
    this.wallRec = w.rec;
    this.wallNormal.copy(w.normal);
    const stick = Number(w.rec.o.stickTime);              // 每个 WallJump 墙自己的贴墙时长
    this.wallTimer = Number.isFinite(stick) && stick > 0 ? stick : PLAYER.wallJumpStickTime;
    this.body.velocity.set(0, 0, 0);
    audio.land(0.35);
    this.fx && this.fx.sparkle(_v.set(this.body.position.x, this.body.position.y + 2.5, this.body.position.z), '#8ef5c8', 10, 3);
    return true;
  }

  _endWall() {
    this.wallLeftRec = this.wallRec || this.wallLeftRec;   // 记住这面墙：贴附期间一直在墙边，避免松手后又粘回去
    this.state = 'normal';
    this.wallRec = null;
    this.wallTimer = 0;
  }

  /**
   * WallJump 弹射：不是一次性给速度，而是在 time 秒内持续把速度推向「斜向上外」。
   * 只给一次冲量的话，空中急停(airFriction)会在几帧内把横向弹力吃掉，玩家几乎飞不出去。
   * time 由每个 WallJump 对象自己的「推进持续时间」决定，缺省回落 config。
   */
  startWallLaunch(nx, nz, out, up, time) {
    this.wallLaunchDir.set(nx, 0, nz);
    this.wallLaunchOut = out;
    this.wallLaunchUp = up;
    const t = Number(time);
    this.wallLaunchT = t > 0 ? t : 0;
    // 弹射速度 = 横向(离墙) + 沿反重力方向的「上」分量（默认重力下 = (nx*out, up, nz*out)）
    const u = this._up;
    this.body.velocity.set(nx * out + u.x * up, u.y * up, nz * out + u.z * up);
  }
  _endWallLaunch() {
    this.wallLaunchT = 0;
  }

  _updateWalljump(dt) {
    const rec = this.wallRec;
    const still = rec && this.mechanisms && this.mechanisms.findWalljump(this);
    const same = still && still.rec === rec;
    this.wallTimer -= dt;
    const v = this.body.velocity;
    v.set(0, 0, 0);
    if (!same) {
      // 尝试维持贴附位置
      if (!still) { this._endWall(); return; }
      this.wallRec = still.rec;
      this.wallNormal.copy(still.normal);
    }
    if (this.wallTimer <= 0) {
      if (rec && rec.o.autoLaunch) this.mechanisms.applyWalljumpLaunch(this, { rec, normal: this.wallNormal });
      this._endWall();
    }
  }

  /* ============================================================
     攀爬墙（与梯子同功能，形状/尺寸完全由对象自定义）
     - 靠近攀爬体积 + 朝墙输入 → 吸附
     - W/S 上下爬，A/D 沿墙面横移，按住空格连续上跳（快爬）
     - 爬到体积顶部自动翻越（对象可关）
     ============================================================ */

  /** 尝试吸附攀爬墙，成功返回 true */
  _tryClimb() {
    const m = this.mechanisms;
    if (!m || !m.findClimb) return false;
    if (this.climbCool > 0 || this.onZipline || this.state === 'walljump') return false;
    // 攀爬有两个来源：① 编辑器里的「攀爬墙」体积；② 胸前够得着的薄平台边缘（见 _findLedge）
    const c = m.findClimb(this) || this._findLedge();
    if (!c) return false;
    const wish = this.wishDir(_v3);
    // 「朝墙推」= 玩家输入方向与「墙面在重力平面内的法线」的点积（默认重力下 = wish.x·n.x + wish.z·n.z）
    const up = this._up;
    const cn = c.normal;
    const nUp = cn.x * up.x + cn.y * up.y + cn.z * up.z;
    const into = -(wish.x * (cn.x - up.x * nUp) + wish.y * (cn.y - up.y * nUp) + wish.z * (cn.z - up.z * nUp));
    const i = this.input;
    const fwd = !!(i && i.act && i.act('forward'));              // 是否按住前进键
    const jumpHeld = !!(i && i.act && i.act('jump'));            // 是否按住跳跃键（= 按住空格持续上跳）
    if (this.climbHopT > 0) {
      // 「速爬」保留窗口：刚从这面墙/平台边跳离，只要还按着前进、或还按着跳跃（继续上跳）就继续吸附。
      // 不再要求镜头对准墙面 —— 身体 / 镜头与墙成角度时也能判定攀爬，
      // 这样每次速爬都能稳定接回，不会中途脱手；两个键都松开才视为想离开
      if (!fwd && !jumpHeld) return false;
    } else if (into <= 0.15) {
      // 没朝墙推就不吸附（不再只管地面）：
      // 原来这个检查带 grounded 条件，空中贴着板 / 墙侧滑（输入方向几乎与墙面平行、into≈0）
      // 也会被吸住，而吸住后按着 W 立刻满足翻越条件 → 被瞬移进板里，看起来就是贴墙侧滑穿过去了
      return false;
    }
    this.state = 'climb';
    this.climbRec = c.rec;
    this.climbNormal.copy(c.normal);
    this.climbAxis = c.axis;
    // 吸附时所在的局部坐标（贴面保持用）：攀爬体积取接触点，薄平台边取玩家自身在该轴上的位置
    this.climbLocal = c.ledge ? this._axisCoord(c.axis) : c.point.getComponent(c.axis);
    this.ledgeTopPoint = c.ledge ? c.topPoint : null;    // 薄平台顶面点（翻越用，攀爬体积走 climbTopY）
    this.climbTime = 0;
    this._endSlide();
    // 「快爬」循环中重新吸附：保留上跳速度（否则会被清零，无法连跳上升）
    if (this.climbHopT <= 0) {
      this.body.velocity.set(0, 0, 0);
      audio.land(0.3);
      this.fx && this.fx.sparkle(_v.set(this.body.position.x + up.x * 2.4, this.body.position.y + up.y * 2.4, this.body.position.z + up.z * 2.4), '#cfe9ff', 8, 2.6);
    }
    // 吸附瞬间就已经按着空格 → 立刻上跳。
    // 按键判定（_handleActions）在 _move 之前跑，吸附后要等下一帧才轮到它，
    // 而那时 hopCool 可能还有残留 → 于是「按住了却只挂住不动」，看起来就是上跳失败。
    // 这里在吸附当帧直接补一次上跳，冷却仍由 hopCool 节流（保持上跳节奏）
    if (jumpHeld && this.hopCool <= 0) this._climbHop();
    return true;
  }

  /** 攀爬中的每帧移动 */
  _updateClimb(dt) {
    const m = this.mechanisms;
    const rec = this.climbRec;
    if (!m || !rec) { this._endClimb(false); return; }
    const isLedge = !!rec.ledge;                                // 挂在薄平台边缘（伪攀爬体积）？
    // 挂边刷新必须沿「板面法线反向」探测：横移时 wish 与板面平行，若按 wish 打射线会平行掠过板面
    const cn0 = this.climbNormal;
    const c = isLedge ? this._findLedge(_negN.set(-cn0.x, -cn0.y, -cn0.z)) : m.findClimb(this);
    // 一帧没检测到不再施加 0.45s 吸附冷却：速爬途中短暂脱判会立刻接回，
    // 避免「中途判定不上」直接掉下去；真正离开攀爬面时（超出检测范围）依然会脱离
    if (!c) { this._endClimb(false); this.climbCool = PLAYER.climbHopCool; return; }
    if (c.rec !== rec) { this.climbRec = c.rec; }              // 相邻体积之间无缝切换
    this.climbNormal.copy(c.normal);
    const o = this.climbRec.o;
    // 换了一根轴（绕到侧面）时，重新记录贴面目标，避免被弹开
    if (c.axis !== this.climbAxis) {
      this.climbAxis = c.axis;
      this.climbLocal = isLedge ? this._axisCoord(c.axis) : c.point.getComponent(c.axis);
    }

    const wish = this.wishDir(_v3);
    const n = this.climbNormal;
    // 上下爬直接用「前进 / 后退」键判定，不依赖镜头是否正对墙面：
    // 镜头 / 身体与墙成角度时 W 依然稳定向上爬，速爬不会中途卡在半空
    const i = this.input;
    const into = clamp((i && i.act('forward') ? 1 : 0) - (i && i.act('backward') ? 1 : 0), -1, 1);
    // 墙面切向（左手/右手横移方向）= 重力方向 × 墙面法线（默认重力下 = (-n.z, 0, n.x)）
    const up = this._up;
    const tx = n.y * up.z - n.z * up.y;
    const ty = n.z * up.x - n.x * up.z;
    const tz = n.x * up.y - n.y * up.x;
    const side = wish.x * tx + wish.y * ty + wish.z * tz;

    const upSpeed = Number(o.climbSpeed) || PLAYER.climbSpeed;
    const sideSpeed = Number(o.sideSpeed) || PLAYER.climbSideSpeed;
    const v = this.body.velocity;

    // 顶部翻越只保留给「薄平台挂边」：薄板必须翻上去才能站到顶面，否则永远上不去
    // 攀爬墙不再自动翻越 —— 玩家爬到体积上沿后自然脱手，不会被提前瞬移到平台顶
    this.climbTime += dt;
    if (isLedge) {
      const tp = this.ledgeTopPoint;
      // 「想往上」既可以是按着 W，也可以是按住空格连续上跳
      const upIntent = into > 0.15 || !!(i && i.act && i.act('jump'));
      if (tp !== null && upIntent) {
        const p = this.body.position;
        // 脚底 / 顶面沿重力方向的坐标（默认重力下 = 脚底 Y / 顶面 Y）
        const feetA = p.x * up.x + p.y * up.y + p.z * up.z;
        const topA = tp.x * up.x + tp.y * up.y + tp.z * up.z;
        const reachLedge = feetA + 2.2 >= topA - 1.8;               // 手抓边缘
        const blocked = this.climbTime > 0.3 && this._vDown(v) > -2;   // 上方有外沿挡住（想爬却爬不动）
        const headNearLedge = blocked && feetA + PLAYER.totalH >= topA - 1.8;
        if (reachLedge || headNearLedge) {
          // 往板里挪太多会整个人跨过窄薄板（落到板另一侧 = 穿墙），所以先量一下板宽，
          // 窄板只挪到板中线上；宽板 / 测不到对侧就仍用原来的 1.6
          const shift = this._ledgeShift(n, 1.6);
          const bx = p.x - n.x * shift, by = p.y - n.y * shift, bz = p.z - n.z * shift;   // 水平挪进板里一点
          const h = (topA - feetA) + 0.15;                     // 从脚底抬到「顶面 + 0.15」沿重力方向的距离
          this._endClimb(false);
          this.setFeet(bx + up.x * h, by + up.y * h, bz + up.z * h);
          const vy = Number(o.jumpPower) || PLAYER.jumpPower;
          this._setLat(this.body.velocity, -n.x * 9, -n.y * 9, -n.z * 9);
          this._setVDown(this.body.velocity, -Math.min(vy, 22));
          audio.jump(0.8);
          return;
        }
      }
    }

    // 无输入时是否悬停（holdNoInput=false 则缓慢下滑）
    let vy = into * upSpeed;
    if (Math.abs(into) < 0.05 && o.holdNoInput === false) vy = -upSpeed * 0.35;
    this._setVDown(v, damp(this._vDown(v), -vy, 14, dt));
    // 沿墙面横移（横向 = 垂直重力平面内的两个基向量；默认重力下 = v.x / v.z）
    const gr = this._gRight, gf = this._gFwd;
    let ur = v.x * gr.x + v.y * gr.y + v.z * gr.z;
    let uf = v.x * gf.x + v.y * gf.y + v.z * gf.z;
    ur = damp(ur, side * sideSpeed, 12, dt);
    uf = damp(uf, side * sideSpeed, 12, dt);
    this._setLat(v, gr.x * ur + gf.x * uf, gr.y * ur + gf.y * uf, gr.z * ur + gf.z * uf);
    // 贴面保持：按“当前局部坐标 vs 吸附时的局部坐标”的误差，沿接触轴做修正
    // （攀爬体积通常没有碰撞体，不能用普通推力，否则会一直往里钻）
    let stick;
    if (isLedge) {
      // 薄平台边：吸附坐标就是玩家自身在该轴上的位置，误差 = 离边缘的漂移量
      stick = clamp((this.climbLocal - this._axisCoord(this.climbAxis)) * 9, -10, 10);
    } else {
      const axisScale = Math.abs((o.scale || [1, 1, 1])[c.axis]) || 1;
      const err = this.climbLocal - c.point.getComponent(c.axis);
      stick = clamp(err * axisScale * 9, -10, 10);
    }
    v.x += n.x * stick; v.z += n.z * stick; v.y += n.y * stick;

    // 爬行音效
    if (Math.abs(vy) > 0.5 || Math.abs(side) > 0.1) {
      this.stepSound -= dt * (Math.abs(vy) + Math.abs(side) * 2) * 0.18;
      if (this.stepSound <= 0) { this.stepSound = 0.4; audio.step(0.35); }
    }
  }

  /* ============================================================
     薄平台挂边（攀爬的第二个来源）
     - 胸前朝 8 个水平方向打射线，找到板的竖直「边面」
     - 从命中点往板体里挪一点，向上 / 向下各打一条射线，量出「上下面」的间距
     - 间距 ≤ LEDGE_MAX_THICK → 认定是薄平台边缘，返回与 findClimb 同构的信息（rec.ledge = true）
     之后交给 _updateClimb：W/S 上下、A/D 横移、空格上跳、到顶自动翻越
     ============================================================ */
  /**
   * 翻越时往板里挪的距离：
   * 固定挪 1.6 的话，比 1.6 窄的薄板会被整个人跨过去（落到板另一侧 —— 就是「穿墙」）。
   * 这里量一下板在当前轴上的宽度，窄板只挪到板中线上；板很宽 / 测不到对侧就用默认值。
   */
  _ledgeShift(n, def) {
    const world = this.world, body = this.body;
    if (!world || !body) return def;
    const opt = { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: true };
    const p = body.position;
    const up = this._up;
    // 起射点抬到「胸前」：沿重力方向抬高 LEDGE_CHEST_Y（默认重力下 = y + 3.1）
    const fx = p.x + up.x * LEDGE_CHEST_Y, fy = p.y + up.y * LEDGE_CHEST_Y, fz = p.z + up.z * LEDGE_CHEST_Y;
    const ex = -n.x, ey = -n.y, ez = -n.z;                 // 指向板里（法线在重力平面内，无沿重力分量）
    // ① 玩家到板面的距离
    _from.set(fx, fy, fz);
    _to.set(fx + ex * LEDGE_REACH, fy + ey * LEDGE_REACH, fz + ez * LEDGE_REACH);
    _ray.reset();
    world.raycastClosest(_from, _to, opt, _ray);
    if (!_ray.hasHit) return def;
    const near = _ray.body, d = _ray.distance;
    // ② 从刚过近壁处继续往里打，看能不能命中同一块板的对侧壁
    const s = d + 0.06;
    _from.set(fx + ex * s, fy + ey * s, fz + ez * s);
    _to.set(fx + ex * (s + LEDGE_REACH), fy + ey * (s + LEDGE_REACH), fz + ez * (s + LEDGE_REACH));
    _ray.reset();
    world.raycastClosest(_from, _to, opt, _ray);
    if (!_ray.hasHit || _ray.body !== near) return def;    // 对侧不是同一块板 → 板够宽
    return clamp(d + (_ray.distance + 0.06) * 0.5, 0.2, def);   // 挪到板中线，且不超过默认值
  }

  _findLedge(into) {
    // 去抖：一次「靠近平台边」会被 _tryClimb / _updateClimb 反复调用，而一次判定要打
    // 最多 3 高 × 8 向 + 2 条测厚射线。0.02s 窗口内直接复用上次结果，避免同一瞬间
    // 成堆地判定（也就不会反复吸附 / 脱手抖成一片）
    if (this.ledgeCool > 0) return this._ledgeCache;
    this.ledgeCool = LEDGE_DEBOUNCE;
    return (this._ledgeCache = this._probeLedge(into));
  }

  /** 薄平台挂边的实际射线判定（去抖包装见 _findLedge） */
  _probeLedge(into) {
    const world = this.world;
    const body = this.body;
    if (!world || !body) return null;
    // 探测方向：
    //   ① 传入方向 into（挂边中刷新，沿板面法线反向）→ 直接朝板里打一条，横移时也不会误判脱手
    //   ② 有移动输入 → 朝输入方向打一条（「朝它推」的平台一定落在 ±90° 内），最省射线
    //   ③ 空中且没有输入 → 8 向扇形，保证自由下落 / 按住空格上跳贴着平台边也能抓到
    const explicit = into !== undefined && into !== null;
    const wish = explicit ? null : this.wishDir(_v3);
    const moving = !explicit && wish.lengthSq() > 0.01;
    if (!explicit && !moving && this.grounded) return null;   // 站着不动不吸附，避免路过 / 静止时被吸住
    const count = (explicit || moving) ? 1 : LEDGE_DIRS.length;
    // 挂边刷新 / 空中上跳：沿身体高度多点采样；主动朝平台推进：只按「胸部附近」判定
    const hs = (explicit || !moving) ? LEDGE_PROBE_Y : LEDGE_PROBE_Y0;
    const p = body.position;
    const up = this._up, gr = this._gRight, gf = this._gFwd;
    // 显式方向投影到垂直重力平面内（默认重力下 = (into.x, 0, into.z)，与旧的只取 x/z 一致）
    let inRight = 0, inFwd = 0;
    if (explicit) {
      const iUp = into.x * up.x + into.y * up.y + into.z * up.z;
      const px = into.x - up.x * iUp, py = into.y - up.y * iUp, pz = into.z - up.z * iUp;
      inRight = px * gr.x + py * gr.y + pz * gr.z;
      inFwd = px * gf.x + py * gf.y + pz * gf.z;
    }
    // 第一遍：只找「最近的竖直边面」（不量厚度，避免每个候选都多打 2 条射线）
    let dist = Infinity, hitBody = null, ux = 0, uz = 0;
    let hx = 0, hy = 0, hz = 0;
    const optH = { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: true };
    for (let hi = 0; hi < hs.length; hi++) {
      const off = hs[hi];
      // 采样点沿重力方向抬高（默认重力下 = y + off）
      const sx = p.x + up.x * off, sy = p.y + up.y * off, sz = p.z + up.z * off;
      for (let k = 0; k < count; k++) {
        // 探测方向：显式 / 输入方向用其重力平面分量；扇形则用重力平面基展开 8 向
        let dx, dy, dz;
        if (explicit) { dx = gr.x * inRight + gf.x * inFwd; dy = gr.y * inRight + gf.y * inFwd; dz = gr.z * inRight + gf.z * inFwd; }
        else if (moving) { dx = wish.x; dy = wish.y; dz = wish.z; }
        else { dx = gr.x * LEDGE_DIRS[k][0] + gf.x * LEDGE_DIRS[k][1]; dy = gr.y * LEDGE_DIRS[k][0] + gf.y * LEDGE_DIRS[k][1]; dz = gr.z * LEDGE_DIRS[k][0] + gf.z * LEDGE_DIRS[k][1]; }
        _from.set(sx, sy, sz);
        _to.set(sx + dx * LEDGE_REACH, sy + dy * LEDGE_REACH, sz + dz * LEDGE_REACH);
        _ledgeRes.reset();
        world.raycastClosest(_from, _to, optH, _ledgeRes);
        if (!_ledgeRes.hasHit || _ledgeRes.distance >= dist) continue;
        const nn = _ledgeRes.hitNormalWorld;
        const ur = nn.x * gr.x + nn.y * gr.y + nn.z * gr.z;
        const uf = nn.x * gf.x + nn.y * gf.y + nn.z * gf.z;
        const h = Math.hypot(ur, uf);
        if (h < 0.7) continue;                                     // 命中接近水平的面（地面 / 板顶）：没有可挂的边
        dist = _ledgeRes.distance;
        hitBody = _ledgeRes.body;
        ux = ur / h; uz = uf / h;                                  // 边面法线（重力平面内，指向玩家）
        hx = _ledgeRes.hitPointWorld.x; hy = _ledgeRes.hitPointWorld.y; hz = _ledgeRes.hitPointWorld.z;
      }
    }
    if (dist === Infinity) return null;
    // 边面法线的世界方向（重力平面内）
    const nwx = gr.x * ux + gf.x * uz, nwy = gr.y * ux + gf.y * uz, nwz = gr.z * ux + gf.z * uz;
    // 第二遍：从命中点往板体里挪一点，向上 / 向下各打一条射线，量出板的厚度
    // 量厚度时射线从板体内部出发，必须关掉 skipBackfaces，否则顶面会因是背面而被滤掉
    const ix = hx - nwx * LEDGE_INSET, iy = hy - nwy * LEDGE_INSET, iz = hz - nwz * LEDGE_INSET;
    const optT = { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: false };
    _from.set(ix, iy, iz);
    _to.set(ix + up.x * LEDGE_MAX_THICK, iy + up.y * LEDGE_MAX_THICK, iz + up.z * LEDGE_MAX_THICK);
    _ledgeUp.reset();
    world.raycastClosest(_from, _to, optT, _ledgeUp);
    _from.set(ix, iy, iz);
    _to.set(ix - up.x * LEDGE_MAX_THICK, iy - up.y * LEDGE_MAX_THICK, iz - up.z * LEDGE_MAX_THICK);
    _ledgeDown.reset();
    world.raycastClosest(_from, _to, optT, _ledgeDown);
    if (!_ledgeUp.hasHit || !_ledgeDown.hasHit) return null;      // 上下探不到 → 厚墙 / 实心块
    // 必须是同一块板的上、下两个面（且法线方向正确：上面朝重力反方向、下面朝重力方向）
    if (_ledgeUp.body !== hitBody || _ledgeDown.body !== hitBody) return null;
    const upN = _ledgeUp.hitNormalWorld, dnN = _ledgeDown.hitNormalWorld;
    if (upN.x * up.x + upN.y * up.y + upN.z * up.z < 0.7) return null;
    if (dnN.x * up.x + dnN.y * up.y + dnN.z * up.z > -0.7) return null;
    // 顶面点（翻越判定用）：从板内点沿重力反方向抬 LEDGE_UP.distance
    const dUp = _ledgeUp.distance;
    const topPoint = new THREE.Vector3(ix + up.x * dUp, iy + up.y * dUp, iz + up.z * dUp);
    // 顶面之上必须有玩家身高的净空：一摞薄砖里每一块砖自身上下两个面都很近（都 ≤ LEDGE_MAX_THICK），
    // 若不查净空，两块砖相接的砖缝（上下砖的侧棱）也会被判成「薄平台边」→ 玩家能贴着砖缝一路吸附
    // 上爬、站在砖缝里。真正的薄平台边顶面之上是空的，据此过滤（skipBackfaces 关掉，
    // 起射点在实心体内时也能命中其底面 → 上方有邻居砖的缝一律命中被排除）。
    _from.set(topPoint.x + up.x * (PLAYER.totalH + 0.2), topPoint.y + up.y * (PLAYER.totalH + 0.2), topPoint.z + up.z * (PLAYER.totalH + 0.2));
    _to.set(topPoint.x + up.x * 0.03, topPoint.y + up.y * 0.03, topPoint.z + up.z * 0.03);
    _ledgeHead.reset();
    world.raycastClosest(_from, _to, { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: false }, _ledgeHead);
    if (_ledgeHead.hasHit) return null;                            // 上方被挡 → 不是可翻越的平台边
    return {
      rec: this._ensureLedgeRec(),
      dist,
      normal: new THREE.Vector3(nwx, nwy, nwz),
      axis: Math.abs(ux) >= Math.abs(uz) ? 0 : 2,                  // 0 = 重力平面右基向量，2 = 前基向量
      topPoint,
      point: null,
    };
  }

  /** 薄平台挂边用的伪攀爬体积：不进 b.objects，只给 _updateClimb 读属性（复用同一个对象） */
  _ensureLedgeRec() {
    if (!this._lRec) {
      this._lRec = {
        id: 'ledge', type: 'climb', ledge: true, mesh: null,
        o: {
          climbSpeed: PLAYER.climbSpeed,
          sideSpeed: PLAYER.climbSideSpeed,
          jumpOff: true,      // 空格可跳离
          holdNoInput: true,  // 无输入时挂住（不缓慢下滑）
          scale: [1, 1, 1],
        },
      };
    }
    return this._lRec;
  }

  /** 玩家当前在某个重力参考轴上的坐标（0 = 重力平面右基向量, 1 = 重力反方向, 2 = 重力平面前基向量）
   *  薄平台边用它做贴面保持。默认重力下三个基向量即世界 X / Y / Z，与旧写法逐位一致。 */
  _axisCoord(axis) {
    const p = this.body.position;
    const a = axis === 0 ? this._gRight : axis === 2 ? this._gFwd : this._up;
    return p.x * a.x + p.y * a.y + p.z * a.z;
  }

  /**
   * 攀爬「快爬」：按住跳跃键连续上跳
   * - 以极小横向速度 + 一定垂直速度跳离攀爬物
   * - 这段时间内保留上跳速度，玩家按前进 / 按住空格再次贴回攀爬物时不失速
   * - 按住空格 = 连续上跳，循环上升（比普通攀爬更快）
   */
  _climbHop() {
    const rec = this.climbRec;
    const o = rec ? rec.o : null;
    if (o && o.jumpOff === false) { this._endClimb(true); return; }   // 该攀爬物不允许跳离
    const n = this.climbNormal;
    this._endClimb(false);                       // 静默脱离（不带走 _endClimb 的 0.45s 吸附冷却）
    this.climbCool = PLAYER.climbHopCool;        // 极短冷却后即可重新吸附
    this.climbHopT = PLAYER.climbHopKeep;        // 保留上跳速度窗口
    this.hopCool = Math.max(PLAYER.climbHopCool * 2, 0.2);
    const v = this.body.velocity;
    // 按着前进键时上跳带一点「向外」分量（方便空中调整、也便于反复接回墙面）；
    // 只按空格上跳时不往外推：否则会一点点漂离墙面 / 平台边，再也接不回去
    const i = this.input;
    const fwd = !!(i && i.act && i.act('forward'));
    const out = fwd ? PLAYER.climbHopOut : 0;
    this._setLat(v, n.x * out, n.y * out, n.z * out);
    this._setVDown(v, -PLAYER.climbHopSpeed);
    if (this.climbSfxT <= 0) {
      this.climbSfxT = 0.16;
      audio.jump(0.5);
    }
    const up = this._up;
    this.fx && this.fx.sparkle(_v.set(this.body.position.x + up.x * 2.2, this.body.position.y + up.y * 2.2, this.body.position.z + up.z * 2.2), '#8ef5c8', 6, 2.4);
  }

  /** 脱离攀爬（jump=true 时向外跳离） */
  _endClimb(jump = false) {
    if (this.state !== 'climb') return;
    const rec = this.climbRec;
    const o = rec ? rec.o : null;
    const n = this.climbNormal;
    this.state = 'normal';
    this.climbRec = null;
    this.ledgeTopPoint = null;
    this.climbTime = 0;
    this.climbCool = 0.45;                 // 短暂禁止再次吸附，让跳跃能真正离墙
    const v = this.body.velocity;
    const up = this._up;
    if (jump) {
      if (o && o.jumpOff === false) {
        v.set(0, 0, 0);                    // 该攀爬墙不允许跳离，只能往上爬或往下退
        this.climbCool = 0.1;
      } else {
        const push = Number(o && o.jumpPower) || PLAYER.jumpPower;
        const po = PLAYER.wallJumpPushOut * 0.7;
        this._setLat(v, n.x * po, n.y * po, n.z * po);
        this._setVDown(v, -push);
        audio.jump(0.9);
        this.fx && this.fx.sparkle(_v.set(this.body.position.x + up.x * 2.4, this.body.position.y + up.y * 2.4, this.body.position.z + up.z * 2.4), '#8ef5c8', 12, 3);
      }
    } else {
      this._scaleLat(v, 0.25);
      const aDown = this._vDown(v);
      if (aDown < 0) this._setVDown(v, aDown * 0.3);   // 仍在上升（沿重力反方向）才衰减
    }
  }

  /* ---------- 移动 ---------- */
  _move(dt) {
    const v = this.body.velocity;
    const gUp = this._up;            // 反重力方向（默认 = +Y）

    if (this.onZipline) return;                 // 由 mechanism 接管
    if (this.state === 'walljump') { this._updateWalljump(dt); return; }
    if (this.statFrozen) { v.set(0, 0, 0); return; }

    const wish = this.wishDir(_v);
    // 水阻(比例)：任何触碰液体都生效 —— 速度 = 基础速度 × (1 − 水阻 × 淹没比例)，0% 无阻力 / 100% 满阻
    const resist = clamp(this.env.resist || 0, 0, 1);
    // 水里（头露出水面）走路会慢一些；出水跃起后不受影响
    const wading = this.env.inLiquid && !this.env.headUnder && this.leapT <= 0;
    const speed = this.statSpeed * (wading ? 1 : 1) * (1 - resist);

    if (this.env.inLiquid && this.env.swim && this.statCanSwim && this.leapT <= 0) {
      /* ---------- 游泳（仅当水淹没头部） ----------
         WASD 相对镜头四向游动；空格上浮、下潜键下潜；
         头部接近水面时按住上浮键 → 直接跃出水面 */
      const entering = this.state !== 'swim';   // 刚沉入水面的那一帧
      this.state = 'swim';
      this._endSlide();
      // 刚入水：短时间内禁用「上浮 / 跃出水面」，防止贴着水面反复跳跃躲氧气
      if (entering) this.upLockT = PLAYER.waterUpLock;
      const i = this.input;
      const up = !!(i && i.act('jump')) && this.upLockT <= 0;
      const down = this._diveDown();
      const surf = (this.liquids && this.env.liquidRec) ? this.liquids.surfaceY(this.env.liquidRec) : null;
      if (up && surf !== null && this.headPos.y > surf - 1.5) {
        // 跃出水面：给一个「反重力方向」的跃起速度并短暂脱离游泳判定，交给空气物理
        this.leapT = PLAYER.waterLeapTime;
        this._setVDown(v, -PLAYER.waterLeap);
        this.state = 'normal';
        audio.jump(0.85);
        this.fx && this.fx.splash(this.headPos, this.env.liquidKind, 24);
        this.events && this.events.emitTrigger('playerJump', {});
      } else {
        const target = this.statSpeed * (1 - resist);   // 游泳速度 = 行动速度 × (1 − 水阻)
        const rate = PLAYER.swimAccel / Math.max(1, target);
        // 只在水面（垂直重力）平面内 damp 横向速度：沿重力分量交给下面的浮力 / 下潜逻辑
        this._vLat(v, _v2);
        this._setLat(v,
          damp(_v2.x, wish.x * target, rate, dt),
          damp(_v2.y, wish.y * target, rate, dt),
          damp(_v2.z, wish.z * target, rate, dt));
        // 刚沉入水面：把落水惯性直接砍到上限内，否则会因惯性一头扎很深
        if (entering && this._vDown(v) > PLAYER.swimEnterSink) this._setVDown(v, PLAYER.swimEnterSink);
        // 无输入 → 保持静止（既不缓降也不上浮，浮力与重力自行抵消）
        const vTarget = target * PLAYER.swimVerticalMul;   // 上浮 / 下潜 = 1.2 倍游泳速度
        let ty = 0;                                        // 目标「反重力方向」速度（默认重力下 = 目标 v.y）
        if (up) ty = vTarget;
        else if (down) ty = -vTarget;
        const vu = -this._vDown(v);                        // 当前反重力方向速度（默认重力下 = v.y）
        // 还在往下走而目标不是下潜时，用更大的刹车倍率收掉残余惯性
        const vyRate = (ty >= 0 && vu < 0) ? rate * PLAYER.swimRiseBrake : rate * 0.9;
        this._setVDown(v, -damp(vu, ty, vyRate, dt));
        return;
      }
    }

    if (this.state === 'swim') this.state = 'normal';

    /* ---------- 攀爬墙 ---------- */
    if (this.state === 'climb') { this._updateClimb(dt); return; }
    if (this._tryClimb()) { this._updateClimb(dt); return; }

    /* ---------- WallJump 墙：空中碰到墙就贴上去 ---------- */
    if (this._tryWalljump()) { this._updateWalljump(dt); return; }

    /* ---------- 滑铲 ---------- */
    if (this.state === 'slide') {
      this.slideTimer -= dt;
      const dir = this._slideDir || this._vLat(v, _v3).normalize();
      this._slideDir = dir;
      const target = this.statSpeed;   // 滑铲全程与行动速度相等
      // 只把「横向」速度 damp 到滑行速度，沿重力分量（下落）交给重力
      this._vLat(v, _v2);
      this._setLat(v,
        damp(_v2.x, dir.x * target, 6, dt),
        damp(_v2.y, dir.y * target, 6, dt),
        damp(_v2.z, dir.z * target, 6, dt));
      if (this.slideTimer <= 0) this._endSlide();
      else return;
    }

    /* ---------- WallJump 弹射：持续推力 ----------
       这 0.5s 内每帧都把速度维持成「斜向上外」，否则空中急停会立刻吃掉横向弹力 */
    if (this.wallLaunchT > 0) {
      if (this.grounded || this.env.inLiquid || this.state === 'climb') {
        this._endWallLaunch();          // 落地 / 入水 / 抓住攀爬墙 → 立刻结束推力
      } else {
        const d = this.wallLaunchDir;
        v.set(d.x * this.wallLaunchOut + gUp.x * this.wallLaunchUp,
          gUp.y * this.wallLaunchUp,
          d.z * this.wallLaunchOut + gUp.z * this.wallLaunchUp);
        return;
      }
    }

    /* ---------- 常规 ----------
       站在平台上（grounded）时直接「刹住横向力」，用脚本速度取代物理摩擦：
       cannon 会用 matA.friction × matB.friction 覆盖接触摩擦，而玩家材质摩擦是 0 →
       玩家实际没有任何物理摩擦，斜坡上重力沿坡面的分量会每帧累积成人往坡下滑。
       这里的做法是：
         - 站定（无输入）：把横向速度直接归零，横向力被刹死，不会顺坡溜；
         - 移动（有输入）：先把当前横向速度投影到控制方向（丢掉垂直于控制方向的分量，
           即刹住横向力），再沿控制方向加速 → 只允许朝控制的方向运动；
       这里的「横向」= 垂直于重力的平面内（默认重力下即水平面）；沿重力分量一律不碰，
       重力 / 跳跃 / 落地都与改动前一致。
       空中不加这个约束，保留原来的 airAccel / airFriction 惯性手感。 */
    const maxSpeed = speed;
    const wishActive = wish.lengthSq() > 0.01;
    // 控制方向投影到「垂直于重力的平面」并归一化（默认重力下它就是 wish 本身）：
    // 之后所有「沿控制方向」的速度分解都用它，避免把速度推进重力轴（穿地 / 顶着地板走）
    this._vLat(wish, _v3);
    const wlen = Math.hypot(_v3.x, _v3.y, _v3.z);
    const wishL = wlen > 1e-4 ? _v3.multiplyScalar(1 / wlen) : null;
    // 抵墙检测（每帧一次，供本帧所有物理子步复用）：
    // 抵墙时下面不做「只保留输入方向分量」的投影 —— 该投影会把求解器刚清掉的朝墙分量
    // 重新塞回来（斜撞 45° 时每步往墙里钻一点 → 穿墙），也会把沿墙切向砍掉（45° 走不快）。
    // 改为照常沿输入方向加速，交给 _applyWallSlide / 求解器压掉朝墙分量，只留沿墙切向
    // → 45° 时正好全速沿墙走。无墙时维持原斜坡防滑逻辑。
    // 分支：只有「输入方向确实在朝面里推」（intoWish > WALL_PRESS_MIN）才算抵墙。输入沿面走的
    // 擦面滑移不当墙 —— 曲面 trimesh 上顶点 / 边伪接触的法线会指向运动方向，若仅凭速度朝向
    // 就判成抵墙，会把沿面的前进速度当成「朝墙分量」清掉 → 一贴曲面走就失速 / 被顶回。
    const wi = this.grounded ? this._wallSlideInfo(wishActive ? wish : null) : null;
    this._wallN = wi && wi.intoWish > WALL_PRESS_MIN ? wi : null;
    if (this.grounded) {
      if (wishActive && wishL) {
        if (this._wallN) {
          // 抵墙：沿控制方向加速，不投影（见上）
          v.x += wishL.x * PLAYER.walkAccel * dt;
          v.y += wishL.y * PLAYER.walkAccel * dt;
          v.z += wishL.z * PLAYER.walkAccel * dt;
        } else {
          // 刹住横向力：只保留沿控制方向的速度分量
          const along = v.x * wishL.x + v.y * wishL.y + v.z * wishL.z;
          this._setLat(v, wishL.x * along, wishL.y * along, wishL.z * along);
          // 反向输入（急转弯 / 急停）给更大加速度，抵消惯性带来的“打滑感”
          const back = along < -0.35 && Math.abs(along) > 1;
          const accel = PLAYER.walkAccel * (back ? PLAYER.turnAccel : 1);
          v.x += wishL.x * accel * dt;
          v.y += wishL.y * accel * dt;
          v.z += wishL.z * accel * dt;
        }
      } else {
        // 站定（或控制方向完全沿重力轴）：刹住横向力，不随斜坡下滑
        this._setLat(v, 0, 0, 0);
      }
    } else if (wishActive && wishL) {
      const accel = PLAYER.airAccel;
      v.x += wishL.x * accel * dt;
      v.y += wishL.y * accel * dt;
      v.z += wishL.z * accel * dt;
    } else {
      // 空中松开移动键：急停（只刹横向，沿重力分量交给重力；保留原本的空中惯性手感）
      const f = clamp(1 - PLAYER.airFriction * dt, 0, 1);
      this._scaleLat(v, f);
    }
    // 速度上限按「横向速度」计算（沿重力分量不受限，最高速由下面的 maxFallSpeed 单独限制）
    this._vLat(v, _v2);
    const sp = Math.hypot(_v2.x, _v2.y, _v2.z);
    if (sp > maxSpeed) {
      const k = maxSpeed / sp;
      if (this.grounded) this._scaleLat(v, k);
      else {
        // 空中只限制“输入方向上的速度”，保留惯性
        const dot = wishL ? (v.x * wishL.x + v.y * wishL.y + v.z * wishL.z) / (sp || 1) : 0;
        if (dot > 0.2) this._scaleLat(v, k);
      }
    }

    // 阻挡面压制：顶住墙面 / 台阶侧面 / 横放圆柱侧面时，按「运动方向与面的夹角」非线性压制水平速度
    //   - 与面夹角 0°（平行着走）：不压制 → 全速沿面前行
    //   - 夹角 45°：衰减一半
    //   - 夹角 90°（垂直压面）：水平速度归 0，钻不进薄墙 / 台阶 / 圆柱
    if (this.grounded && this._wallN) this._applyWallSlide(this._wallN);

    if (this.grounded && sp < 0.4) this._setLat(v, 0, 0, 0);

    // 台阶 / 薄片平台辅助：放在「低速归零」之后调用，这样抬上去的同一帧可以直接把水平速度
    // 补回全速，抵掉「撞到台沿那一帧法向速度被接触求解清掉 → 再慢慢加速」造成的顿挫
    if (wishActive) this._stepAssist(wish, speed, dt);

    // 速降只在下潜键「按下那一次」生效（见 _dive），不按住持续下压
    // 最高速限制：沿重力方向的下落速度不超过 maxFallSpeed（默认重力下即 v.y ≥ -maxFallSpeed）
    if (this._vDown(v) > PLAYER.maxFallSpeed) this._setVDown(v, PLAYER.maxFallSpeed);

    // 脚步声
    if (this.grounded && sp > 6) {
      this.stepSound -= dt * (sp / 6);
      if (this.stepSound <= 0) { this.stepSound = 0.34; audio.step(clamp(sp / 24, 0.3, 1)); }
    }
  }

  /**
   * 台阶 / 薄片平台辅助：向前方探一个「不超过 stepHeight 的落点」，把玩家抬上去。
   * - 用向下射线找前方可站立的顶面，因此薄片（薄板 / 台阶边缘）也能识别
   * - 起点高于台阶高度、或起点已在障碍内部（skipBackfaces 不命中）时不动 → 高墙照旧挡住
   * - 抬腿触发是「预测式」的：本帧内会撞上台阶侧面就立刻抬，不让接触求解先把速度清掉
   * - 物理位移是「瞬间」的：直接写体位置最干脆，不会和接触求解互相顶出抖动；
   *   看起来的平滑抬升交给视觉层（_stepVisStart / _stepVisUpdate）
   */
  _stepAssist(wish, speed, dt) {
    if (!this.world || wish.lengthSq() < 0.01) return;
    const v = this.body.velocity;
    const up = this._up;
    // 只在地面或刚离地（沿重力的慢速下落）时抬腿，避免空中乱吸
    const canStep = this.grounded || this.coyote > 0 ||
      (this.airTime < STEP_AIRTIME_MAX && -this._vDown(v) <= 3);
    if (!canStep) return;
    const p = this.body.position;
    // 前进方向投影到「垂直于重力的平面」并归一化（默认重力下它就是 wish 本身）；
    // 横向分量退化（控制方向完全沿重力轴）时放弃，避免 normalize 出 NaN
    this._vLat(wish, _v);
    const dl = Math.hypot(_v.x, _v.y, _v.z);
    if (dl < 1e-4) return;
    const dir = _v.multiplyScalar(1 / dl);
    const H = PLAYER.stepHeight;
    // 触发条件（满足其一）：
    //  a) 预测式：本帧内会撞上近似竖直的立面 → 提前一帧抬腿。接触求解根本没机会把
    //     水平速度清掉，「卡一下」的源头就没了（否则每级台阶都要丢一帧位移、再重新加速）
    //  b) 兜底：已经顶着竖直面了（接触法线判定），照旧抬腿。
    //     这里用「宽松阈值」：薄台阶的棱角接触法线偏斜（水平分量常不到 0.7），按严格阈值
    //     会漏判成「没挡着」→ 辅助不触发 → 人就一直顶着它站着不动。
    //     放宽不会有副作用：真正决定能不能抬起来的是下面的探测循环（找不到 stepHeight
    //     以内的可站立顶面就放弃），所以「松一点只是多试几次，绝不会把高墙也抬上去」
    if (!this._willHitRiser(dir, dt) && !this._blockedAhead(dir, 0.2, 0.45)) return;
    // 由近到远依次探测：取最近的一个「不超过 stepHeight 的可站立顶面」
    // 每条车道沿 dir 前进 d、再沿垂直方向偏移 lat，斜向走位时也能探到脚印斜角上的台阶。
    // 车道偏移在「垂直于重力的平面」内做（默认重力下 = 原来的世界 XZ 偏移）：
    // dir 在该平面内的坐标为 (dirA, dirB)，同平面内转 90° 的 side = (-dirB, dirA)
    const r = this._gRight, f = this._gFwd;
    const dirA = dir.x * r.x + dir.y * r.y + dir.z * r.z;
    const dirB = dir.x * f.x + dir.y * f.y + dir.z * f.z;
    let dy = 0;
    for (let k = 0; k < STEP_PROBES.length; k++) {
      const d = STEP_PROBES[k][0];
      const lat = STEP_PROBES[k][1];
      this._gPlaneOffset(dirA * d - dirB * lat, dirB * d + dirA * lat, _v3);
      _from.set(p.x + _v3.x + up.x * (H + 0.35),
        p.y + _v3.y + up.y * (H + 0.35),
        p.z + _v3.z + up.z * (H + 0.35));
      _to.set(p.x + _v3.x - up.x * 0.45, p.y + _v3.y - up.y * 0.45, p.z + _v3.z - up.z * 0.45);
      _ray.reset();
      this.world.raycastClosest(_from, _to, { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: true }, _ray);
      const hn = _ray.hitNormalWorld;
      // 可站立的顶面：法线朝向「反重力方向」（默认重力下 = 原来的 hitNormalWorld.y ≥ 0.5）
      if (!_ray.hasHit || hn.x * up.x + hn.y * up.y + hn.z * up.z < 0.5) continue;
      // 抬升量沿重力轴量（默认重力下即高度差）
      const d2 = (_ray.hitPointWorld.x - p.x) * up.x + (_ray.hitPointWorld.y - p.y) * up.y
        + (_ray.hitPointWorld.z - p.z) * up.z;
      if (d2 <= STEP_MIN_RISE || d2 > H + 0.02) continue;           // 平地 / 太高
      dy = d2;
      break;
    }
    if (dy <= 0) return;
    p.x += up.x * dy; p.y += up.y * dy; p.z += up.z * dy;   // 沿重力轴瞬间站上台阶顶面
    if (this._vDown(v) > 0) this._setVDown(v, 0);           // 不要让残余下落速度立刻把人拽回去
    // 万一没来得及预测、还是被接触求解清掉了速度，这里直接补回全速，
    // 免得要等 walkAccel 从 0 重新加速（约 0.2s）才恢复 → 上楼梯一卡一卡的元凶
    const want = speed || PLAYER.walkSpeed;
    this._vLat(v, _v2);
    if (Math.hypot(_v2.x, _v2.y, _v2.z) < want) {
      this._setLat(v, dir.x * want, dir.y * want, dir.z * want);
    }
    this.body.aabbNeedsUpdate = true;
    this._stepVisStart(dy);                      // 视觉层从原高度补间追上
  }

  /**
   * 预测式台沿探测：本帧内会不会撞上台阶（侧面立面或可站立的矮顶面）。
   * 从脚印前缘、脚底上方 stepHeight+余量 起射，沿前进方向「斜向下」落到脚底下方：
   * 水平前进的同时连续下降，因此会扫过整个台阶高度带 —— 不再像原来的水平射线那样
   * 只能覆盖 0.3 / 1.05 两个固定高度（比它矮的薄台阶被从上方掠过 → 预测不触发）。
   * 命中「近似竖直的立面」→ 台阶；命中「近乎水平的顶面」且高度在可抬升范围内 → 也是台阶。
   * 斜坡（法线介于两者之间）与脚下平地（高度不够）不算，交给物理 / 兜底逻辑处理。
   */
  _willHitRiser(dir, dt) {
    const w = this.world;
    if (!w || !(dt > 0)) return false;
    const up = this._up;
    const down = this._down;
    const v = this.body.velocity;
    this._vLat(v, _v3);                                   // 横向速度（默认重力下 = (v.x, 0, v.z)）
    const sp = Math.hypot(_v3.x, _v3.y, _v3.z);
    if (sp < 0.5) return false;
    // dir 在重力平面内的两个分量（默认重力下 = dir.x / dir.z）
    const r = this._gRight, f = this._gFwd;
    const dirA = dir.x * r.x + dir.y * r.y + dir.z * r.z;
    const dirB = dir.x * f.x + dir.y * f.y + dir.z * f.z;
    const ax = Math.abs(dirA), az = Math.abs(dirB);
    // 盒半深 (1, 0.5) 与内切球 (x=±0.5, r=0.8) 沿 dir 的支撑距离取大者 → 脚印前缘
    const hd = Math.max(ax * 1 + az * 0.5, ax * 0.5 + 0.8);
    const H = PLAYER.stepHeight;
    const p = this.body.position;
    // 起点：脚印前缘、脚底「上方」H+余量（高于台阶顶面，先越过矮台阶再斜落到其上）
    // 终点：再向前「本帧位移 + 余量」的水平距离，落到脚底「下方」→ 射线斜向下扫过整条高度带
    // 平移量都在重力平面内算，竖直偏移沿重力轴（默认重力下即原来的世界 XZ + Y）
    const len = sp * dt * STEP_PREDICT_MUL + STEP_RISER_MIN_LEN;
    this._gPlaneOffset(dirA * hd, dirB * hd, _v3);
    _from.set(p.x + _v3.x + up.x * (H + STEP_RISER_UP),
      p.y + _v3.y + up.y * (H + STEP_RISER_UP),
      p.z + _v3.z + up.z * (H + STEP_RISER_UP));
    this._gPlaneOffset(dirA * (hd + len), dirB * (hd + len), _v3);
    _to.set(p.x + _v3.x - up.x * STEP_RISER_DOWN,
      p.y + _v3.y - up.y * STEP_RISER_DOWN,
      p.z + _v3.z - up.z * STEP_RISER_DOWN);
    _ray.reset();
    w.raycastClosest(_from, _to, { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: true }, _ray);
    if (!_ray.hasHit) return false;
    const n = _ray.hitNormalWorld;
    // 沿重力分量与横向分量：默认重力下分别为 -n.y 与 hypot(n.x, n.z)
    const nd = n.x * down.x + n.y * down.y + n.z * down.z;
    const nh = Math.hypot(n.x - down.x * nd, n.y - down.y * nd, n.z - down.z * nd);
    if (nh > 0.8) return true;                            // 近似竖直的立面（台阶侧面）
    if (n.x * up.x + n.y * up.y + n.z * up.z > 0.9) {     // 近乎水平的顶面（台阶顶）：需在可抬升高度内
      const dy = (_ray.hitPointWorld.x - p.x) * up.x + (_ray.hitPointWorld.y - p.y) * up.y
        + (_ray.hitPointWorld.z - p.z) * up.z;
      return dy > STEP_MIN_RISE && dy <= H + 0.02;
    }
    return false;                                         // 斜坡 / 其他倾斜面：交给物理照常走上去
  }

  /**
   * 前方是否顶着「挡住去路」的面（用接触法线判断，比射线省且不会打到玩家自己）。
   * 法线取绝对值后与移动方向比对，所以不依赖 cannon 接触法线的朝向约定。
   * 只有法线「垂直于重力」的面才算挡（地面 / 天花板 / 缓坡都不挡）。
   * @param {number} [minDot] 运动方向与该面法线的朝向程度下限（1 = 完全正对着推）
   * @param {number} [minH]   法线「垂直重力」分量下限（1 = 完全竖直的面；薄台阶棱角的法线偏斜，需放宽）
   */
  _blockedAhead(dir, minDot = 0.35, minH = 0.7) {
    const w = this.world;
    if (!w) return false;
    const d = this._down;
    for (const c of w.contacts) {
      if (c.bi !== this.body && c.bj !== this.body) continue;
      const ux = c.bi === this.body ? c.ni.x : -c.ni.x;
      const uy = c.bi === this.body ? c.ni.y : -c.ni.y;
      const uz = c.bi === this.body ? c.ni.z : -c.ni.z;
      // 法线投影到「垂直于重力的平面」（默认重力下 = (ux, 0, uz)）
      const nd = ux * d.x + uy * d.y + uz * d.z;
      const hx = ux - d.x * nd, hy = uy - d.y * nd, hz = uz - d.z * nd;
      const h = Math.hypot(hx, hy, hz);
      if (h < minH) continue;                                  // 地面 / 天花板 / 斜坡：不算挡
      if (Math.abs((dir.x * hx + dir.y * hy + dir.z * hz) / h) < minDot) continue;  // 不是朝着它推
      return true;
    }
    return false;
  }

  /**
   * 上台阶的「视觉补间」起点。物理上已经瞬间站到台阶顶面了，这里只记一笔
   * 「视觉暂时比物理低了 dy」，让模型与相机在随后 ~0.25s 内平滑追上。
   * 只加位移、不动速度：连续上台阶时速度是连续的，不会每级台阶都「起步-刹住」地顿一下。
   */
  _stepVisStart(dy) {
    // 连续上台阶时累加，但最多落后一个台阶高度，避免视觉越落越远
    this._stepVisOff = Math.max(-PLAYER.stepHeight, Math.min(0, this._stepVisOff || 0) - dy);
  }

  /**
   * 推进视觉补间：_stepVisOff 是「视觉相对物理」的竖直偏移（负值 = 视觉暂时偏低），
   * 用临界阻尼弹簧收敛回 0。相比指数衰减（第一帧就冲掉 30%，起步是个小顿挫），
   * 弹簧起步速度从 0 平滑加速、末段平滑刹住，且重复触发时速度连续 —— 连续上楼梯也顺。
   * 只动视觉层，绝不碰 body（碰了就会和接触求解互相顶出抖动）。
   */
  _stepVisUpdate(dt) {
    let off = this._stepVisOff;
    let vel = this._stepVisVel || 0;
    if (!off && !vel) return;
    const w = 34;                    // 角频率：整段约 0.18s 收敛完（越大抬腿视觉越快跟上，太大会显得「弹」）
    const k = w * w;
    const c = 2 * w;                 // 临界阻尼
    // 定步长子步进：显式积分在 dt > 2/w 时会发散（进关首帧 dt 可能很大），
    // 拆子步后既稳定又与帧率无关
    let left = Math.min(dt, 0.1);
    while (left > 1e-4) {
      const s = Math.min(left, 1 / 120);
      vel += (-off * k - vel * c) * s;
      off += vel * s;
      left -= s;
    }
    if (off > -0.003 && off < 0.003 && Math.abs(vel) < 0.06) {
      this._stepVisOff = 0;
      this._stepVisVel = 0;
      return;
    }
    this._stepVisOff = off;
    this._stepVisVel = vel;
  }

  /**
   * 找出当前「顶着」的那个阻挡面：任何法线「接近垂直于重力」的面都算 —— 竖直墙、台阶侧面、
   * 横放圆柱的侧面；地面 / 天花板 / 缓坡（法线接近重力轴）不算。
   * 返回指离该面的单位法线 (ux, uy, uz)（已投影到垂直重力的平面；默认重力下 uy 恒为 0）
   * 与朝向程度 into = cos(运动方向与该面法线的夹角)
   * （等价于 sin(运动方向与该面的夹角)），以及仅按「输入方向」算的 intoWish；
   * 无阻挡面返回 null。intoWish 用于分支判定（见下）：只有输入确实在朝面里推才算墙。
   * into 的判定基准取「输入方向」与「实际横向速度方向」中更朝向面的那个：
   * 让 _applyWallSlide 的压制强度对「被接触求解 / 惯性带偏」的斜向撞墙也生效。
   *
   * 注意：曾经这里还要求「墙面同时盖住脚和脖子」（射线探两处）才算墙，但那只覆盖高墙 ——
   * 台阶侧面、横放圆柱的侧面都会被判成「不算墙」而完全不压制，玩家顶着它们走就会钻过去。
   * 现在按「接触法线是否接近垂直于重力」判定，高度不再参与，所有挡路的面统一处理。
   *
   * 曲面（管道 / 网格修改器等 trimesh）上不能只取「最朝向运动方向」的那一条接触：
   * cannon 的 sphereTrimesh 会对球半径内每个三角面「顶点 / 边」各生成一条接触，
   * 其法线方向各异 —— 玩家沿曲面走时，恰是这些指向运动方向的伪接触得到最大 into，
   * 被选中后 _brakeLateral / _applyWallSlide 会把沿面的前进速度当成「朝墙分量」清掉
   * → 一贴曲面走就失速 / 被顶回。改为：先收集全部挡路接触，再按角度聚类，
   * 取「成员最多」的一簇（真实整面接触会聚成大簇，孤立伪接触成不了簇）加权平均得到
   * 代表法线；正对墙（全体同向）时结果与原来一致，曲面上则不再被单个伪接触带偏。
   *
   * 分支判定：仅靠聚类还不够 —— 曲面上的伪接触也可能凑成一簇。真正可靠的分支依据是
   * 「玩家有没有真的朝这个面推」：调用方（_move）只在 intoWish > WALL_PRESS_MIN 时才把它
   * 当成阻挡墙（挤压 / 斜撞，压制防穿透）；输入沿面走的擦面滑移一律不当墙，改用常规的
   * 「投影到输入方向」刹车 —— 该投影同样会清掉朝面分量（防穿透），但完整保留沿面前进速度，
   * 于是曲面上无论法线怎么抖都不再被误清速度。
   */
  _wallSlideInfo(dir) {
    const body = this.body;
    const world = this.world;
    if (!body || !world) return null;
    const down = this._down;
    const vel = body.velocity;
    // 实际速度的横向（垂直重力平面内）单位方向；默认重力下 = 原来的 (vel.x, 0, vel.z) / |…|
    const vd = vel.x * down.x + vel.y * down.y + vel.z * down.z;
    let svx = vel.x - down.x * vd, svy = vel.y - down.y * vd, svz = vel.z - down.z * vd;
    const vlen = Math.hypot(svx, svy, svz);
    if (vlen > 1e-4) { svx /= vlen; svy /= vlen; svz /= vlen; }
    else { svx = 0; svy = 0; svz = 0; }
    const dx = dir ? dir.x : 0, dy = dir ? dir.y : 0, dz = dir ? dir.z : 0;
    if (!vlen && !dx && !dy && !dz) return null;
    let cnt = 0;
    for (const c of world.contacts) {
      if (c.bi !== body && c.bj !== body) continue;
      const si = c.bi === body ? 1 : -1;
      const nx = c.ni.x * si, ny = c.ni.y * si, nz = c.ni.z * si;
      // 法线投影到「垂直于重力的平面」：横向分量太小的（地面 / 天花板 / 缓坡）不挡路
      const nd = nx * down.x + ny * down.y + nz * down.z;
      const hx = nx - down.x * nd, hy = ny - down.y * nd, hz = nz - down.z * nd;
      const h = Math.hypot(hx, hy, hz);
      if (h < 0.8) continue;
      if (cnt >= WALL_BUF_MAX) break;
      _wallBufX[cnt] = hx / h;
      _wallBufY[cnt] = hy / h;
      _wallBufZ[cnt] = hz / h;
      _wallBufI[cnt] = Math.max(dx * _wallBufX[cnt] + dy * _wallBufY[cnt] + dz * _wallBufZ[cnt],
        svx * _wallBufX[cnt] + svy * _wallBufY[cnt] + svz * _wallBufZ[cnt]);
      cnt++;
    }
    if (!cnt) return null;
    // 以每条法线为参考，数出 ±60° 内（点积 ≥ WALL_CLUSTER_COS）的邻居数，取成员最多的一簇
    let bestCnt = 0, ref = -1;
    for (let i = 0; i < cnt; i++) {
      let m = 0;
      for (let j = 0; j < cnt; j++) {
        if (_wallBufX[i] * _wallBufX[j] + _wallBufY[i] * _wallBufY[j] + _wallBufZ[i] * _wallBufZ[j] >= WALL_CLUSTER_COS) m++;
      }
      if (m > bestCnt) { bestCnt = m; ref = i; }
    }
    if (ref < 0) return null;
    // 该簇内按朝向程度加权平均（+0.05 让 into≤0 的同面成员也贡献一点权重），归一化得代表法线
    let ax = 0, ay = 0, az = 0;
    for (let j = 0; j < cnt; j++) {
      if (_wallBufX[ref] * _wallBufX[j] + _wallBufY[ref] * _wallBufY[j] + _wallBufZ[ref] * _wallBufZ[j] < WALL_CLUSTER_COS) continue;
      const w = Math.max(0, _wallBufI[j]) + 0.05;
      ax += _wallBufX[j] * w;
      ay += _wallBufY[j] * w;
      az += _wallBufZ[j] * w;
    }
    const al = Math.hypot(ax, ay, az);
    if (al < 1e-4) return null;
    const ux = ax / al, uy = ay / al, uz = az / al;
    const intoWish = dx * ux + dy * uy + dz * uz;     // 仅按输入方向：是否在朝面里推
    const into = Math.max(intoWish, svx * ux + svy * uy + svz * uz);
    return into > 0 ? { ux, uy, uz, into, intoWish } : null;
  }

  /**
   * 阻挡面压制：把横向（垂直重力平面内的）速度整体乘 (1 - sin²θ)，θ = 运动方向与阻挡面的夹角。
   *   0°（平行着面走）→ sinθ = 0   → 系数 1   ：全速沿面前行
   *   45°              → sinθ ≈ .71 → 系数 0.5 ：滑移速度衰减一半
   *   90°（垂直压面）   → sinθ = 1   → 系数 0   ：完全静止，钻进不去
   * 非线性（平方）补间；沿重力分量（贴墙下落 / 踩墙，默认重力下即竖直速度）不受影响。
   * 压制的是整个横向速度而不只是切向：只削切向会把速度方向「扳正」得越来越垂直于面，
   * 玩家以更正的姿态持续压进薄墙 / 台阶 / 圆柱侧面，物理求解跟不上就穿透了。
   */
  _applyWallSlide(wall) {
    const k = wall.into * wall.into;                 // sin²θ
    if (k <= 0) return;
    this._scaleLat(this.body.velocity, 1 - k);
  }

  /* ---------- 氧气 / 生命 ---------- */
  _updateOxygen(dt) {
    // 氧气耗尽 → 立刻死亡（不论是否还在液体里）
    if (this.oxygen <= 0) { this.kill('drown'); return; }
    // 只有「液体真的在影响氧气」时才停掉自然回氧，判定与 LiquidSystem 的 affected 一致：
    // 默认（淹过头才生效）→ 只有头没入液面才停；该液体关掉「淹过头才生效」→ 身体碰到液体就停。
    // 仅仅踩到水面 / 站在浅水里（头露出水面）不算，仍然照常回氧。
    const lo = this.env.liquidRec ? this.env.liquidRec.o : null;
    const affects = this.env.inLiquid && (this.env.headUnder || (!!lo && lo.headOnly === false));
    if (affects) { this._airT = 0; return; }   // 液体内部由 LiquidSystem 处理
    // 刚离开水体的一小段时间内不恢复：避免贴着水面反复探头“刷”氧气
    // 等待时长 = config 的 oxygenRegenDelay（关卡可在设置里覆盖）
    this._airT = (this._airT || 0) + dt;
    if (this._airT < this.oxygenRegenDelay) return;
    if (this.oxygenRegen > 0 && this.oxygen < this.maxOxygen) {
      this.oxygen = Math.min(this.maxOxygen, this.oxygen + this.oxygenRegen * dt);
    }
  }

  takeOxygen(n, kind) {
    this.oxygen = Math.max(0, this.oxygen - n);
    if (this.oxygen <= 0) this.kill(kind || 'drown');
  }
  addOxygen(n, allowExtra = false) {
    const before = this.oxygen;
    // allowExtra：拓展氧气（可超出上限，形成“额外氧气”），供氧气球等即拿即用道具使用
    this.oxygen = allowExtra ? Math.max(0, this.oxygen + n) : clamp(this.oxygen + n, 0, this.maxOxygen);
    if (this.oxygen > before + 0.5) audio.oxygen();
    return this.oxygen - before;
  }

  damage(n, cause) {
    if (!this.alive || this.invincible || n <= 0) return;
    this.health -= n;
    this.hurtFlash = Math.min(1.2, this.hurtFlash + n * 0.02 + 0.15);
    // 数值照常结算；音效 / 震屏做去抖，避免逐帧或短时间内多次扣血刷屏
    if (this._hurtCd <= 0) {
      this._hurtCd = HURT_FEEDBACK_CD;
      if (this.hurtFlash > 0.3) audio.hurt(clamp(n / 20, 0.2, 1));
      this.shake(n * 0.012);
    }
    this.hooks.onDamage && this.hooks.onDamage(n, cause);
    if (this.health <= 0) this.kill(cause || 'damage');
  }

  kill(cause) {
    if (!this.alive || this.invincible) return;
    this.alive = false;
    this.health = 0;
    this.deaths++;
    this.body.velocity.set(0, 0, 0);
    audio.die();
    this.fx && this.fx.burst(_v.set(this.body.position.x, this.body.position.y + 2.5, this.body.position.z), '#ff8fb0', 40);
    if (this.onZipline) { this.mechanisms && this.mechanisms.detachZipline(this, false); }
    this.hooks.onDeath && this.hooks.onDeath(cause || 'unknown');
  }

  respawn(pos, refill = true) {
    const p = pos || this.respawnPoint || this.b.pickSpawn();
    this.alive = true;
    this.state = 'normal';
    this.setSlideShape(false);
    this.climbRec = null;
    this.climbCool = 0.4;
    this.climbTime = 0;
    this.ledgeTopPoint = null;
    this.wallLeftRec = null;
    this.upLockT = 0;
    this._endWallLaunch();
    this.toolPicks.clear();   // 死亡/重生后重置拾取上限（又能再拿）
    this.mechanisms && this.mechanisms.resetPickups && this.mechanisms.resetPickups();
    this.setInvisible(false);
    this.body.collisionResponse = true;
    this.setAnchored(false);
    this.onZipline = false;
    this.zipline = null;
    this.leapT = 0;
    this.body.velocity.set(0, 0, 0);
    // 出生点抬高一截，避免卡进地面：沿「反重力方向」抬（默认重力下即 +Y）
    this.teleport(new THREE.Vector3(p.x + this._up.x * 1.2, p.y + this._up.y * 1.2, p.z + this._up.z * 1.2));
    if (refill) {
      this.health = this.healthMax;
      this.oxygen = this.maxOxygen;
    } else {
      this.health = this.healthMax;
    }
    this.hurtFlash = 0;
    this.drownAccum = 0;
    this.env.inLiquid = false;
    audio.setUnderwater(false);
    this.hooks.onRespawn && this.hooks.onRespawn();
  }

  setRespawn(vec, refill) {
    const y = Array.isArray(vec) ? vec[1] : vec.y;
    const x = Array.isArray(vec) ? vec[0] : vec.x;
    const z = Array.isArray(vec) ? vec[2] : vec.z;
    // 检查点坐标是脚底位置，存档点抬高一截避免重生卡进地面：沿「反重力方向」抬（默认重力下即 +Y）
    this.respawnPoint = new THREE.Vector3(x + this._up.x, y + this._up.y, z + this._up.z);
    if (refill) { this.oxygen = this.maxOxygen; this.health = this.healthMax; }
  }

  /* ---------- 位置操作 ---------- */
  teleport(v) {
    this.body.position.set(v.x, v.y, v.z);
    this.body.velocity.set(0, 0, 0);
    this.body.aabbNeedsUpdate = true;
    this._stepVisOff = 0;                 // 瞬移 / 重生后作废未走完的视觉补间
    this._stepVisVel = 0;
  }
  setFeet(x, y, z) {
    this.body.position.set(x, y, z);
    this.body.aabbNeedsUpdate = true;
    this._stepVisOff = 0;
    this._stepVisVel = 0;
  }
  push(x, y, z) {
    const v = this.body.velocity;
    v.x += x; v.y += y; v.z += z;
  }
  shake(a) { this.cameraCtl && this.cameraCtl.shake(a); }

  /* ============================================================
     工具 / 交互
     ============================================================ */
  hasTool(type) { return this.inventory.has(type); }
  giveTool(item) { return this.inventory.add(item); }
  giveToolByName(type) {
    const def = TOOL_DEFS[type] || TOOL_DEFS.custom;
    return this.inventory.add({
      type, name: def.label, icon: def.icon, count: 1, oxygenAmount: 35, targetIds: [], targetTag: '',
    });
  }
  removeTool(type) { return this.inventory.remove(type, true); }
  /** 该工具的「持有数」：背包持有 + 本局已拾取（即拿即用类工具不进背包，用计数补足） */
  toolHeldCount(item) {
    if (!item) return 0;
    return this.inventory.countOf(item) + (this.toolPicks.get(toolKey(item)) || 0);
  }
  /** 记录一次拾取（用于「每人拾取上限」判定） */
  markToolPicked(item) {
    if (!item) return;
    const k = toolKey(item);
    this.toolPicks.set(k, (this.toolPicks.get(k) || 0) + 1);
  }

  _updateInteract() {
    this.interact = null;
    if (!this.mechanisms || !this.cameraCtl) { this.lmbBlocked = !!this.inventory.current; return; }
    const origin = _v.copy(this.cameraCtl.camera.position);
    const dir = this.camForward(_v2);
    let hit = this.mechanisms.pick(origin, dir, 44);
    // 非游泳状态：准星指向液体 → 显示液体扣氧 / 伤害信息（游泳中不显示，避免遮挡）
    if (hit && hit.rec.type === 'liquid') {
      hit = this.swimming ? null : {
        rec: hit.rec, dist: hit.dist, point: hit.point,
        info: { kind: 'liquid', clickable: false, label: liquidPrompt(hit.rec.o) },
      };
    }
    // 准星指向伤害区域 → 显示「伤害(n%每t秒)」（n = 单次伤害占最大生命的百分比，n/t 最多 1 位小数）
    if (hit && hit.rec.type === 'damage') {
      hit.info = { kind: 'damage', clickable: false, label: damagePrompt(hit.rec.o, this.healthMax) };
    }
    // 点击触发器超出「最大点击范围」：不显示准星提示，也不算可交互
    if (hit && hit.rec.type === 'click' && !this.mechanisms.inClickRange(hit.rec, this)) hit.info = null;
    this.interact = hit;
    // 只有「左键可交互」的对象（门 / 点击触发器 / 声效方块）与手持工具才屏蔽左键速降
    this.lmbBlocked = !!(hit && hit.info && hit.info.clickable) || !!this.inventory.current;
    if (hit && hit.rec.type === 'door') {
      const info = this.mechanisms.canOpenDoor(this, hit.rec);
      hit.info = { kind: 'door', clickable: true, label: info.label, locked: !info.ok };
    }
  }

  /** 使用当前选中的工具 / 与视线目标交互 */
  useSelected() {
    const item = this.inventory.current;
    const hit = this.interact;
    // 1) 视线交互优先
    if (hit) {
      if (hit.rec.type === 'door') {
        const info = this.mechanisms.canOpenDoor(this, hit.rec);
        if (!info.ok) { audio.click(0.4); this.hooks.onLocked && this.hooks.onLocked(info); return false; }
        const closing = !!hit.rec.o.open;
        if (closing) this.mechanisms.closeDoor(hit.rec);
        else this.mechanisms.openDoor(hit.rec);
        // 记进回放时间轴：幽灵状态下没人按左键，开门这一下必须重演，否则回放里门永远关着
        this.hooks.onWorldAct && this.hooks.onWorldAct(closing ? 'doorClose' : 'doorOpen', hit.rec.id);
        // 用工具开门要消耗掉对应的那一件：门没指定工具就不消耗（谁都能推门）；
        // 指定了具体工具对象就消耗那一个，只指定类型就消耗手上同类型的那个
        if (info.need) {
          const used = info.needObject
            ? this.inventory.items.find((i) => i.sourceId === info.needObject.id)
            : this.inventory.items.find((i) => i.type === info.need);
          if (used) {
            this.hooks.onToolUsed && this.hooks.onToolUsed(used, used.type);
            this.inventory.removeByKey(used.key);
          }
        }
        return true;
      }
      // 点击触发器 / 声效方块：左键点击即视为可交互对象被“触碰”
      // （按钮不支持点击，只能靠身体触碰按下）
      if (hit.rec.type === 'click' || hit.rec.type === 'soundblock') {
        const ok = this.mechanisms.fireClick(hit.rec, this);
        if (!ok) audio.click(0.35);      // 冷却中 / 已触发过
        else this.hooks.onWorldAct && this.hooks.onWorldAct('click', hit.rec.id);
        return ok;
      }
    }
    if (!item) { audio.click(0.35); return false; }
    switch (item.type) {
      case 'oxygen': {
        const gain = this.addOxygen(item.oxygenAmount || 35, true);
        this.fx && this.fx.sparkle(_v.set(this.body.position.x, this.body.position.y + 4.5, this.body.position.z), '#7fe3ff', 20, 5);
        this.hooks.onToolUsed && this.hooks.onToolUsed(item, 'oxygen', gain);
        this.inventory.removeByKey(item.key);
        return true;
      }
      case 'key': {
        // 开门本身在「视线交互优先」里处理过了，能走到这里说明没瞄准门
        audio.click(0.4);
        this.hooks.onHint && this.hooks.onHint('瞄准一扇需要钥匙的门', 1.4);
        return false;
      }
      case 'breaker': {
        if (hit && this.canBreak(hit.rec, item)) {
          this.mechanisms.breakObject(hit.rec, this);
          this.hooks.onWorldAct && this.hooks.onWorldAct('break', hit.rec.id);
          this.hooks.onToolUsed && this.hooks.onToolUsed(item, 'break', hit.rec.o);
          this.inventory.removeByKey(item.key);
          return true;
        }
        audio.click(0.4);
        this.hooks.onHint && this.hooks.onHint('瞄准可破坏的障碍物', 1.4);
        return false;
      }
      case 'throw': {
        const tpl = this.findProjectile(item);
        if (!tpl) { audio.click(0.4); return false; }
        const dir = this.camForward(_v2);
        // 起点必须在「角色身前」：第三人称下相机在角色身后，用相机位置会把投掷物扔到背后
        const origin = _v.set(this.feetPos.x, this.feetPos.y + PLAYER.eyeOffset, this.feetPos.z)
          .addScaledVector(dir, 2.2);
        this.mechanisms.throwProjectile(tpl, origin, dir, 1, item);
        // 投掷物飞出去是看得见的地图变化：把「起点 + 方向」记下来，回放时原样再扔一次
        this.hooks.onWorldAct && this.hooks.onWorldAct('throw', tpl.id, {
          px: origin.x, py: origin.y, pz: origin.z, dx: dir.x, dy: dir.y, dz: dir.z,
        });
        this.shake(0.16);
        this.hooks.onToolUsed && this.hooks.onToolUsed(item, 'throw');
        // 投掷物对象关掉「无限投掷」后，每扔一次消耗一件（数量见工具对象的“数量”）
        if (tpl.o.infinite === false) this.inventory.removeByKey(item.key);
        return true;
      }
      default: {
        // 自定义工具：优先触发指定事件，未指定则触发目标的触碰事件
        if (item.useEvent && this.events) {
          this.events.emit(item.useEvent, { objectId: item.sourceId || '', tool: item.type });
          this.hooks.onWorldAct && this.hooks.onWorldAct('emit', '', { ev: item.useEvent, tool: item.type });
          this.hooks.onToolUsed && this.hooks.onToolUsed(item, 'custom');
          return true;
        }
        if (hit) { this.mechanisms.emitObjectEvent(hit.rec.o, 'touch'); return true; }
        return false;
      }
    }
  }

  canBreak(rec, item) {
    const o = rec.o;
    if (item.targetIds && item.targetIds.includes(rec.id)) return true;
    if (item.targetTag && o.tag && item.targetTag === o.tag) return true;
    if (!item.targetIds.length && !item.targetTag) return o.tag === 'breakable' || hasTouchEvent(o);
    return false;
  }

  findProjectile(item) {
    const list = this.b.objectsOf('projectile');
    if (!list.length) return null;
    if (item.targetIds && item.targetIds.length) {
      for (const id of item.targetIds) {
        const r = this.b.objects.get(id);
        if (r && r.type === 'projectile') return r;
      }
    }
    if (item.targetTag) {
      const r = list.find((x) => x.o.tag === item.targetTag);
      if (r) return r;
    }
    return list[0];
  }

  /* ============================================================
     视觉动画
     ============================================================ */
  _updateModel(dt) {
    const g = this.model;
    if (!g) return;
    // 头顶名牌：随设置实时开关 / 改名；第一人称或隐身时隐藏
    this._syncNameTag(this.statInvisible || !!(this.cameraCtl && this.cameraCtl.isFirstPerson));
    const v = this.body.velocity;
    // 横向速度（垂直重力平面内；默认重力下 = hypot(v.x, v.z)，逐位一致）
    const vd = this._vDown(v);
    const sp = Math.hypot(v.x - this._down.x * vd, v.y - this._down.y * vd, v.z - this._down.z * vd);
    this.animSpeed = damp(this.animSpeed, sp, 10, dt);
    // 侧移量：速度在「模型右方」上的分量（模型局部 +X 旋到世界 = cosY·gRight − sinY·gFwd）
    const vr = v.x * this._gRight.x + v.y * this._gRight.y + v.z * this._gRight.z;
    const vf = v.x * this._gFwd.x + v.y * this._gFwd.y + v.z * this._gFwd.z;
    this.lateral = (vr * Math.cos(this.yaw) - vf * Math.sin(this.yaw));

    // 朝向：移动方向优先，静止时背对镜头（第三人称看到角色背面）
    let targetYaw = this.cameraCtl ? this.cameraCtl.yaw + Math.PI : this.yaw;
    if (sp > 2.2) targetYaw = this._planeYaw(v.x, v.y, v.z);
    // 按住鼠标中键：身体朝向镜头方向（不含俯仰）
    if (this.input && this.input.mouseDown(1) && this.cameraCtl) targetYaw = this.cameraCtl.yaw + Math.PI;
    // 攀爬时正面朝向墙面
    if (this.state === 'climb' && this.climbRec) targetYaw = this._planeYaw(-this.climbNormal.x, -this.climbNormal.y, -this.climbNormal.z);
    let d = targetYaw - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 12);
    g.rotation.y = this.yaw;

    const first = this.cameraCtl && this.cameraCtl.isFirstPerson;
    // 第一人称隐藏整个角色本体（只留镜头）
    const hidden = first || this.statInvisible;
    const morphed = !!(this.avatar && this.avatar.active);
    const presetOn = !!this.presetId;
    this.r6Base.visible = !hidden && !morphed && !presetOn;
    this.r6Preset.visible = !hidden && !morphed && presetOn;
    this.avatarSlot.visible = !hidden && morphed;

    // 导入模型：姿态交给骨骼动画，跳过下面的程序化姿态块
    if (morphed) {
      const mlean = this.state === 'slide' ? -1.15
        : this.onZipline ? 0.12 : this.state === 'climb' ? 0.16 : 0;
      g.rotation.x = damp(g.rotation.x, mlean, 9, dt);
      this._visualYOff = this.state === 'slide' ? 0.25 : 0;
      this._applyVisualPos();
      this.avatar.update(dt, this._animState());
      return;
    }

    // 状态姿态
    const R = this.rig || this.rigBase;
    let lean = 0, armSwing = 0, legSwing = 0, armRotX = 0, legRotX = 0;
    this._visualYOff = 0;
    if (this.state === 'slide') {
      lean = -1.15;
      armRotX = 1.2; legRotX = -0.25;
      this._visualYOff = 0.25;
    } else if (this.onZipline) {
      armRotX = -2.5; legRotX = 0.35;
      lean = 0.12;
    } else if (this.state === 'walljump') {
      armRotX = -1.9; legRotX = 0.2;
    } else if (this.state === 'climb') {
      // 攀爬：双手上举交替抓握，双腿蹬踏
      this.footPhase += dt * (2.6 + Math.abs(v.y) * 0.1);
      armRotX = -2.5 + Math.sin(this.footPhase * 2) * 0.42;
      legRotX = Math.sin(this.footPhase * 2 + 1.2) * 0.45 - 0.15;
      lean = 0.16;
    } else if (this.state === 'swim' || (this.env.inLiquid && this.env.swim)) {
      if (sp > 1.5 || this.input) {
        this.footPhase += dt * (2.2 + sp * 0.25);
        armRotX = -1.5 + Math.sin(this.footPhase * 2) * 1.1;
        legRotX = Math.sin(this.footPhase * 2 + 1.2) * 0.7;
        // 俯仰现在正确地绕角色右轴生效（YXZ）：原来 0.9 rad ≈ 51° 是在「侧翻」状态下调的，
        // 真的前倾 51° 会像扎猛子；收到 0.45 rad ≈ 26°，读作向前游泳
        lean = 0.45;
      }
    } else if (!this.grounded) {
      armRotX = v.y > 6 ? -2.2 : -1.4;
      legRotX = v.y > 0 ? 0.35 : -0.3;
    } else if (sp > 0.6) {
      this.footPhase += dt * (1.2 + sp * 0.42);
      const amp = clamp(sp / 22, 0, 1) * 0.95;
      armSwing = Math.sin(this.footPhase * 2) * amp;
      legSwing = Math.sin(this.footPhase * 2) * amp;
      // 移动时身体保持直立（不再前倾）
    } else {
      this.footPhase += dt * 1.4;
      armSwing = Math.sin(this.footPhase) * 0.045;
      legSwing = 0;
      this._visualYOff = Math.sin(this.footPhase * 1.6) * 0.045;
    }

    this._applyVisualPos();
    g.rotation.x = damp(g.rotation.x, lean, 9, dt);
    R.armL.rotation.x = damp(R.armL.rotation.x, armRotX + armSwing, 12, dt);
    R.armR.rotation.x = damp(R.armR.rotation.x, armRotX - armSwing, 12, dt);
    R.armL.rotation.z = damp(R.armL.rotation.z, this.state === 'walljump' || this.state === 'climb' ? 0.5 : 0.05, 8, dt);
    R.armR.rotation.z = damp(R.armR.rotation.z, this.state === 'walljump' || this.state === 'climb' ? -0.5 : -0.05, 8, dt);
    R.legL.rotation.x = damp(R.legL.rotation.x, legRotX + legSwing, 12, dt);
    R.legR.rotation.x = damp(R.legR.rotation.x, legRotX - legSwing, 12, dt);
    // 头部轻微看向相机俯仰
    if (!first) {
      R.head.rotation.x = damp(R.head.rotation.x, clamp(this.cameraCtl ? -this.cameraCtl.pitch * 0.5 : 0, -0.5, 0.5), 6, dt);
    }
    // 出水/入水时身体下沉
    if (this.state === 'walljump' && this.wallRec) {
      const o = this.wallRec.o;
      void o;
    }
  }

  /**
   * 把模型摆到「当前 render 时刻」的位置：读 Cannon 的 interpolatedPosition
   * （world.step 的 accumulator 补间结果，见 vendor/cannon-es.js step()）。
   */
  _applyVisualPos() {
    const g = this.model;
    const root = this._gravRoot;
    if (!g || !this.body || !root) return;
    const ip = this.body.interpolatedPosition || this.body.position;
    // 外层容器：位置 = 脚底世界坐标，朝向 = 重力对齐四元数（默认重力下 = 单位四元数，等价于纯平移）
    root.position.set(ip.x, ip.y, ip.z);
    root.quaternion.copy(this._gravQuat);
    // 姿态偏移（滑铲 / 呼吸）与上台阶视觉补间都沿「局部 +Y」= 反重力方向（默认重力下即世界 Y）
    g.position.set(0, (this._visualYOff || 0) + (this._stepVisOff || 0), 0);
  }

  /**
   * 物理步进之后重新对齐视觉位置。
   * 必须与相机同帧采样：相机在 stepPhysics 之后读插值值，
   * 若模型只在 p.update（stepPhysics 之前）写一次，两者会差一拍 —— 
   * Cannon 的补间系数 t 在 60fps 物理 + 高刷渲染下会来回摆动，模型就会相对相机抖动。
   */
  syncVisual() { this._applyVisualPos(); }

  /** 模型可视化根（渲染 Worker 模式下逐帧推热通道用；默认重力下即 _gravRoot） */
  get visualRoot() { return this._gravRoot || this.model; }

  /** 头顶名牌：读设置决定显示与文字（改名时重画一次画布） */
  _syncNameTag(hide) {
    const tag = this.nameTag;
    if (!tag) return;
    const on = settings.get('player.showName', true) !== false;
    const name = String(settings.get('player.name', '') || '').trim();
    if (!on || !name) { tag.visible = false; return; }
    if (tag.userData.tagName !== name) {
      tag.userData.tagName = name;
      drawNameTag(tag, name);
    }
    tag.visible = !hide;
  }

  /* ---------- 对外信息（HUD） ---------- */
  get speed() { return Math.hypot(this.body.velocity.x, this.body.velocity.z); }
  get isMoving() { return this.speed > 1.5; }
  /** 是否处于游泳状态（相机用来做 FOV/侧倾） */
  get swimming() { return this.state === 'swim' || !!(this.env.inLiquid && this.env.swim); }
  /** 是否被液体淹过头顶（HUD 水下表现） */
  get underwater() { return !!(this.env.inLiquid && this.env.headUnder); }

  dispose() {
    if (this.body && this.world) this.world.removeBody(this.body);
    if (this.avatar) { this.avatar.dispose(); this.avatar = null; }
    this._clearPreset();
    if (this.nameTag) {
      const t = this.nameTag.userData.tagTexture;
      if (t) t.dispose();
      this.nameTag.material.dispose();
      this.nameTag = null;
    }
    if (this.model) {
      if (this.model.parent) this.model.parent.remove(this.model);
      this.model.traverse((c) => {
        if (!c.isMesh) return;
        if (c.geometry && !c.userData.sharedGeometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
    }
    this.model = null;
    if (this._gravRoot) {
      if (this._gravRoot.parent) this._gravRoot.parent.remove(this._gravRoot);
      this._gravRoot = null;
    }
    this.body = null;
  }
}

function hasTouchEvent(o) { return !!(o.onTouch || o.onEnter || o.onExit); }

/** 工具身份键：有来源ID按来源区分（同一工具对象），否则按类型+名称 */
function toolKey(item) {
  return item.sourceId ? item.type + '#' + item.sourceId : item.type + '|' + (item.name || '');
}

/** 伤害区域提示文案：伤害(n%每t秒)
    n = 单次伤害占玩家最大生命的百分比，t = 结算间隔（秒 = 1/频率）；两者最多保留 1 位小数 */
function damagePrompt(o, healthMax) {
  const r1 = (v) => String(Math.round(Number(v) * 10) / 10);
  if (o.instantKill) return '伤害(秒杀)';
  const hit = Math.max(0, Number(o.damage) || 0);
  const raw = Number(o.tickRate);
  const hz = Number.isFinite(raw) ? Math.max(0, raw) : 2;   // 与机制默认结算频率一致
  if (hit <= 0) return '伤害(无)';
  if (!(hz > 0)) return '伤害(不结算)';
  const max = Math.max(1, Number(healthMax) || 1);
  return `伤害(${r1((hit / max) * 100)}%每${r1(1 / hz)}秒)`;
}

/** 液体提示文案：液体种类 + 扣氧 / 伤害信息 */
function liquidPrompt(o) {
  const L = LIQUID_KINDS[o.kind] || LIQUID_KINDS.water;
  if (o.instantKill) return `${L.label} · 立刻致命`;
  const num = (v) => String(Math.round(Number(v) * 10) / 10);
  const parts = [L.label];
  const mode = o.oxygenMode || 'drain';
  if (mode === 'refill') parts.push('补充氧气');
  else if (mode !== 'none') {
    const drain = Math.max(0, Number(o.drainRate ?? L.drain));
    if (drain > 0) parts.push(`氧气 -${num(drain)}/秒`);
  }
  const dmg = Math.max(0, Number(o.damage) || 0);
  if (dmg > 0) parts.push(`伤害 ${num(dmg)}/秒`);
  return parts.join(' · ');
}

export { PLAYER, deg2rad, worldPosition };