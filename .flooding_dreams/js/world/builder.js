/* ============================================================
   场景构建器：把关卡 JSON 变成 THREE 场景 + cannon 物理世界
   编辑器与运行时共用（opts.editor 决定是否显示辅助体）
   ============================================================ */
import * as THREE from 'three';
import * as CANNON from 'cannon';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PHYS, LIQUID_KINDS, TRIGGER_TYPES, SHADOW, PLAYER } from '../config.js';
import { deg2rad, clamp, uid, isVec3 } from '../core/util.js';
import { applyMaterial, getMaterial, getLiquidMaterial, releaseMaterial, createFoamMaterial,
  FOAM_DEPTH, getFogVolumeMaterial, getVolumeLightMaterial, VOLUME_UNIFORMS,
  getTextMaterial, getBillboardMaterial, withScreenGradeOff, SUN_SPEC } from '../core/materials.js';
import { PlayerAvatar, buildR6Parts, presetDef } from '../player/avatar.js';
import { ADV_UNIFORMS, advIsGlass, captureReflections, disposeReflections } from './advanced-materials.js';
import { resolveSkyTexture, registerLevelTextures, setSkyMods } from '../core/textures.js';
import { settings } from '../core/settings.js';
import { buildGeometry, buildBoxGeometry, buildBoxFillGeometry, boxFillKey,
  typeDef, OBJECT_TYPES } from './objectTypes.js';
import { worldPosition, childrenOf, playMatrix, playQuat } from './level.js';
import { PATH_TYPES, makePath, resolvePath, buildCurve, sampleCurve, pathLength, sectionProfiles } from './paths.js';
import { sweepGeometry, sweepProfiles } from './sweep.js';
import { polyGeometry, ensurePoly, polyVerts, polyFaces, nearestSurfacePoint } from './poly-mesh.js';
import { vecGeometry, vecKey } from '../core/vector-solid.js';
import { OcclusionCuller } from './occlusion.js';
import { VolumeFog } from './volumefog.js';
import { PORTAL_UNIFORMS, getPortalMaterial, portalKey, sampleOutline, applyPortalOutline, ensurePortalShape,
  makePortalUniforms, makePortalSurfaceUniforms, PORTAL_CORE_GLSL, PORTAL_SURFACE_HEAD_GLSL, PORTAL_SURFACE_GLSL } from './portal.js';

/* 这些类型在游戏内不渲染自身（纯逻辑体积）。
   伤害区域（damage）不在其中：它的实体网格要在游戏内可见（危险区提示），
   是否显示由对象自身的「可见」属性控制。 */
const LOGIC_ONLY = new Set(['trigger', 'emitter', 'soundblock', 'postfx', 'exposure', 'attachment']);
/* 描边线框（攀爬墙 / WallJump 墙）比本体略大一点，避免与物体面 z-fighting 而闪烁 */
const EDGE_HELPER_GROW = 1.002;
export const NO_PHYSICS = new Set(['liquid', 'damage', 'trigger', 'goal', 'spawn', 'checkpoint',
  'tool', 'projectile', 'light', 'zipline', 'curve', 'group', 'attachment',
  'emitter', 'fogvol', 'volumelight', 'click', 'soundblock', 'postfx', 'exposure', 'billboard',
  'portal', 'npc']);

/* 不参与顶点 AO 烘焙的类型（自绘材质 / 容器 / 逻辑体 / 管状路径 / 可编辑建模体）
   poly 会被频繁重建，而且顶点色会在建模后失效 → 直接不烘焙，保证建模手感 */
const AO_SKIP = new Set(['liquid', 'zipline', 'curve', 'pipe', 'curvewall', 'meshref', 'light', 'group',
  'fogvol', 'volumelight', 'model', 'postfx', 'exposure', 'textblock', 'billboard', 'poly', 'vec', 'attachment',
  'portal', 'npc']);

/* ---------- 昼夜：小时 → 主光（太阳 / 月亮）仰角与外观 ----------
   小时制昼夜参数（12.5 = 12:30:00）：太阳 6:00 升起、12:00 最高、18:00 落下；
   月亮相位相反（18:00 升起、0:00 最高、6:00 落下）。两者谁高就点亮谁 ——
   白天是暖色的太阳、夜晚是冷色的月亮，亮度随高度衰减。直接取代原「主光仰角」。 */
const DAY_PEAK = 85;                          // 天顶仰角（度）
const _cSunset = new THREE.Color('#ff9d5a');  // 日出 / 日落暖色
const _cSunBase = new THREE.Color('#fff4e2'); // 白天主光颜色（来自设置）
const _cMoon = new THREE.Color('#9fb2e0');    // 月光冷色
const _cLight = new THREE.Color();            // 计算结果暂存
/**
 * 昼夜天体：太阳 / 月亮的原始仰角（度，可为负 = 已落到地平线以下）+ 谁是主光。
 * 与 dayNightState 共用同一套模型；天空工坊也用它来按「小时」摆天体。
 */
export function dayNightBodies(hour) {
  const h = ((Number(hour) || 0) % 24 + 24) % 24;
  const sunEl = DAY_PEAK * Math.sin(Math.PI * (h - 6) / 12);
  const moonEl = DAY_PEAK * Math.sin(Math.PI * (h - 18) / 12);
  return { isDay: sunEl >= moonEl, sunEl, moonEl };
}
export function dayNightState(hour) {
  const b = dayNightBodies(hour);
  const elev = clamp(b.isDay ? b.sunEl : b.moonEl, 2, 89);
  const alt = clamp(Math.abs(elev) / DAY_PEAK, 0, 1);   // 0 = 地平线，1 = 天顶
  return { isDay: b.isDay, elev, alt };
}

/* ---------- 顶点 AO（接缝闭塞阴影）参数 ---------- */
const AO_RADIUS = 2.6;        // 遮蔽作用半径(stud)
const AO_STRENGTH = 0.62;     // 遮蔽强度
const AO_MAX_NEIGHBORS = 24;  // 单个顶点最多考虑的邻居数
/* 遮挡体必须探出接收面正面这么多(stud)才算遮挡：低于此值视为「与表面共面贴合」，
   不产生暗部（否则两个 part 平贴时会在接缝两侧压出一圈本不该有的阴影）。 */
const AO_FRONT_EPS = 0.1;

/* 管道碰撞体（网格 trimesh）沿路径的烘焙步长(stud)：渲染网格仍按精细扫掠，只有碰撞体用粗网格 */
const PIPE_COLLISION_STEP = 1;

/* ---------- 静态刚体合批（大关卡性能关键） ----------
   cannon 的 SAP 广相每一步都要「按轴排序世界里的全部刚体」，还会分配 n×n 的碰撞矩阵。
   逐对象建体时，5000 个静态盒体单排序就要几十毫秒，帧率直接掉到个位数。
   做法：把「永不变动的静态盒体」按空间分块并进复合刚体 —— 一个分块一个 body，内部装若干
   盒形（形状的偏移 / 朝向就是对象的世界变换）。body 总数从数千降到数十，物理开销几乎归零，
   碰撞仍是精确盒体（不是 trimesh）。仅游玩模式启用：编辑器要逐对象移动 / 重建 / 拾取，不能合。 */
const MERGE_BODY_TYPES = new Set(['mesh', 'poly', 'climb', 'walljump', 'textblock']);
const BODY_CHUNK = 24;      // 合批分块尺寸(stud)：越大 body 越少，但单个复合体里的盒形越多

/* ---------- 静态网格合批（降低绘制调用） ----------
   5000 个方块各自一个 Mesh = 每帧上万次绘制（主渲染 + 阴影贴图各一遍），CPU 提交开销
   就够把帧率压到个位数。做法：把「普通静态方块」按「材质 + 阴影开关 + 空间分块」合并成
   一个大几何体，绘制调用从数千降到数十~一两百。几何体的世界变换烘焙进顶点，顶点色（AO）
   一并保留；原网格从场景里摘掉但对象记录仍在（拾取 / 遮挡剔除按需跳过）。
   只处理游玩模式的普通 mesh 方块：按钮 / 门 / 被事件改写的对象 / 可破坏对象 / 带标签的
   可交互对象一律不合，保证交互与机关行为不变。 */
const VIS_CHUNK = 48;       // 视觉合批分块尺寸(stud)：分块以便视锥 / 遮挡剔除仍然有效

/** 收集被事件 / 动画 / 其它对象引用的对象 id：这些对象运行时会被改写，不能并入静态合批 */
function collectManagedIds(level) {
  const known = new Set();
  for (const o of (level && level.objects) || []) if (o && o.id) known.add(o.id);
  const out = new Set();
  const walk = (v, depth) => {
    if (v == null || depth > 8) return;
    if (typeof v === 'string') { if (known.has(v)) out.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') for (const k in v) walk(v[k], depth + 1);
  };
  walk(level && level.events, 0);
  walk(level && level.animations, 0);
  walk(level && level.settings, 0);
  // 对象自身携带的引用：父级 / 网格修改器源 / 折曲线引用 / 工具的可破坏目标…
  // （跳过 id 本身，否则每个对象都会把自己算成「被引用」）
  for (const o of (level && level.objects) || []) {
    if (!o || typeof o !== 'object') continue;
    for (const k in o) {
      if (k === 'id' || k === 'verts' || k === 'faces') continue;
      const v = o[k];
      if (typeof v === 'string') { if (known.has(v)) out.add(v); }
      else if (Array.isArray(v)) { for (const x of v) if (typeof x === 'string' && known.has(x)) out.add(x); }
    }
  }
  return out;
}

/* ---------- 拼缝防漏光 ---------- */
/* 相邻方块的面严格共面、但两边顶点密度不一致时（不同尺寸的方块共用同一套归一化细分，
   见 blockSeg），光栅化会在共享棱上留下亚像素裂缝，透过裂缝能看到背后的天空 → 接缝处
   出现一条细亮线（尤其开了接缝闭塞阴影 AO 后对比更强）。
   做法：把方块几何体按“固定世界尺度”轻微外扩，让相邻的两块面互相压住，把裂缝盖掉。
   几何体是 1×1×1 单位体、由 mesh.scale 放大，所以要按各轴尺寸换算外扩比例。 */
const SEAM_PAD_RATIO = 0.012;   // 外扩量 = 该轴尺寸 × 此比例
const SEAM_PAD_MIN = 0.004;     // 外扩量下限(stud)：小方块至少要盖住亚像素裂缝
const SEAM_PAD_MAX = 0.03;      // 外扩量上限(stud)：大方块别把接缝顶得太明显

/** 单个轴的面外扩量（世界单位） */
function seamPad(sizeAxis) {
  return clamp(sizeAxis * SEAM_PAD_RATIO, SEAM_PAD_MIN, SEAM_PAD_MAX);
}

/** 立方体几何体按固定世界尺度外扩（pos/uv 关系不变，只把顶点往外挪一点） */
function expandBoxSeam(geo, size) {
  const sz = [0, 1, 2].map((i) => Math.max(0.001, Math.abs(Number(size[i]) || 1)));
  const k = sz.map((v) => 1 + (2 * seamPad(v)) / v);
  geo.scale(k[0], k[1], k[2]);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/* ---------- 物理材质表 ---------- */
function physMaterial(world, kind) {
  const p = kind === 'ice' ? PHYS.iceMaterial : kind === 'bouncy' ? PHYS.bouncyMaterial : PHYS.defaultMaterial;
  const m = new CANNON.Material(kind || 'default');
  m.friction = p.friction;
  m.restitution = p.restitution;
  return m;
}

/* 泡沫网格高出液面的高度(stud)：让泡沫沿岸边物体向上再渐隐一圈 */
const FOAM_SPILL = 1;

/* 有平顶 + 垂直侧壁的形状才能向上延伸（球 / 锥 / 环没有可攀的侧壁） */
const FOAM_FLAT_TOP = new Set(['block', 'cylinder', 'prism']);

/* ---------- 泡沫形状编码（与 createFoamMaterial 的 uShape 对应） ---------- */
function foamShapeCode(shape) {
  if (shape === 'sphere' || shape === 'cylinder' || shape === 'cone' || shape === 'torus') return 1;
  if (shape === 'prism') return 2;
  return 0;
}

const _tmpV = new THREE.Vector3();
const _tmpE2V = new THREE.Vector3();
const _tmpBox = new THREE.Box3();
const _playM = new THREE.Matrix4();     // 玩法空间世界矩阵的取用临时量（见 level.js 的 playMatrix）
const _tmpQ = new THREE.Quaternion();
const _tmpQ2 = new THREE.Quaternion();
const _tmpE = new THREE.Euler();
const _tmpV2 = new THREE.Vector2();
const _tmpM = new THREE.Matrix4();      // 传送门视差：世界 → 对象局部的临时矩阵
const _tmpDir3 = new THREE.Vector3();    // 传送门：相机朝向（局部空间）

/** 液体子集传送门的隐形占位材质：visible=false → 渲染器直接跳过（不画、零 drawcall），
    但编辑器拾取只看 mesh.visible，所以本体依然能被选中、拖拽轮廓节点。
    材质本体不参与渲染，也就没有 dispose 的必要，全场景共用一个。 */
let _portalGhostMat = null;
/** 构建器实例序号：液体子集传送门的材质 key 里带上它 —— 材质缓存是全页面共享的，
    编辑器与试玩会话各自持有一份构建器时，同名对象 id 不能命中同一份「带逐对象 uniform」的材质 */
let _builderSeq = 0;
function portalGhostMaterial() {
  if (!_portalGhostMat) {
    // DoubleSide：拾取（raycast）会按材质的面朝向做剔除，单面的话从背面就选不中
    _portalGhostMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    _portalGhostMat.visible = false;
  }
  return _portalGhostMat;
}

/* ---------- 接头（attachment）的临时量 ---------- */
const _attPL = new THREE.Vector3();     // 宿主「网格局部空间」里的表面落点
const _attNL = new THREE.Vector3();     // 同上空间里的面法线
const _attWp = new THREE.Vector3();     // 世界落点
const _attN = new THREE.Vector3();      // 世界法线
const _attS = new THREE.Vector3();
const _attPin = [0, 0, 0];              // 传给 nearestSurfacePoint 的坐标数组
const _attQ1 = new THREE.Quaternion();
const _attQ2 = new THREE.Quaternion();
const _attE1 = new THREE.Euler();
const _attM1 = new THREE.Matrix4();
const _attM2 = new THREE.Matrix4();
const _attM3 = new THREE.Matrix4();
const _attNm = new THREE.Matrix3();
const _attX = new THREE.Vector3();
const _attZ = new THREE.Vector3();
const _attRef = new THREE.Vector3();

/** 接头宿主：能提供「表面」的网格（普通方块 / 会变形的低模体 / 液体 / 攀爬面） */
function isSurfaceHost(rec) {
  const m = rec && rec.mesh;
  if (!m || !m.isMesh || !m.geometry || m.isGroup) return false;
  const t = rec.type;
  return t === 'mesh' || t === 'poly' || t === 'liquid' || t === 'climb' || t === 'walljump';
}

/** 立方体式六面吸附（把单位空间里的点推到 ±0.5 表面，并取该面法线） */
function _boxSnap(px, py, pz) {
  const ax = Math.abs(px), ay = Math.abs(py), az = Math.abs(pz);
  if (ax > 1e-6 && ax >= ay && ax >= az) {
    const s = px >= 0 ? 1 : -1;
    _attPL.set(s * 0.5, clamp(py, -0.5, 0.5), clamp(pz, -0.5, 0.5));
    _attNL.set(s, 0, 0);
  } else if (ay > 1e-6 && ay >= az) {
    const s = py >= 0 ? 1 : -1;
    _attPL.set(clamp(px, -0.5, 0.5), s * 0.5, clamp(pz, -0.5, 0.5));
    _attNL.set(0, s, 0);
  } else if (az > 1e-6) {
    const s = pz >= 0 ? 1 : -1;
    _attPL.set(clamp(px, -0.5, 0.5), clamp(py, -0.5, 0.5), s * 0.5);
    _attNL.set(0, 0, s);
  } else {
    _attPL.set(0, 0.5, 0);              // 落在中心：默认顶面
    _attNL.set(0, 1, 0);
  }
}

/**
 * 求宿主表面上离接头「参考点」最近的落点与法线，写入 _attPL / _attNL（宿主网格局部空间）。
 * 参考点 = 接头数据里的 position（宿主局部坐标，stud），内部按宿主 scale 换算成几何单位空间。
 * - liquid：X/Z 吸附到液面范围内，Y 恒为液面（本地 +0.5，随 fillLevel 升降）
 * - poly（会变形的三角网）：就近三角面投影 + 上次命中面缓存
 * - 其余形状：球面径向 / 圆柱侧壁+端盖 / 立方体六面
 * 返回 true 表示取到了表面。
 */
function sampleHostSurface(host, o, rec) {
  const m = host.mesh;
  const s = m.scale;
  const px = Number(o.position?.[0]) || 0;
  const py = Number(o.position?.[1]) || 0;
  const pz = Number(o.position?.[2]) || 0;
  const sx = Math.max(1e-4, Math.abs(s.x));
  const sy = Math.max(1e-4, Math.abs(s.y));
  const sz = Math.max(1e-4, Math.abs(s.z));
  const t = host.type;

  if (t === 'liquid') {
    // 液体本地 +0.5 就是液面（见 updateLiquidTransform）→ Y 不看参考点，始终落在液面上
    _attPL.set(clamp(px / sx, -0.5, 0.5), 0.5, clamp(pz / sz, -0.5, 0.5));
    _attNL.set(0, 1, 0);
    return true;
  }

  if (t === 'poly') {
    _attPin[0] = px / sx; _attPin[1] = py / sy; _attPin[2] = pz / sz;
    const r = nearestSurfacePoint(polyVerts(host.o), polyFaces(host.o), _attPin, rec._attFace ?? -1);
    if (!r) return false;
    rec._attFace = r.face;
    _attPL.set(r.point[0], r.point[1], r.point[2]);
    _attNL.set(r.normal[0], r.normal[1], r.normal[2]);
    return true;
  }

  const ux = px / sx, uy = py / sy, uz = pz / sz;
  const shape = host.o.shape || 'block';
  if (shape === 'sphere') {
    const r = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (r < 1e-6) { _attPL.set(0, 0.5, 0); _attNL.set(0, 1, 0); return true; }
    const k = 0.5 / r;
    _attPL.set(ux * k, uy * k, uz * k);
    _attNL.set(ux / r, uy / r, uz / r);
    return true;
  }
  if (shape === 'cylinder' || shape === 'prism') {
    const rr = Math.sqrt(ux * ux + uz * uz);
    const yc = clamp(uy, -0.5, 0.5);
    if (rr < 1e-6) { _attPL.set(0, yc >= 0 ? 0.5 : -0.5, 0); _attNL.set(0, yc >= 0 ? 1 : -1, 0); return true; }
    const sideD = (rr - 0.5) * (rr - 0.5);                  // 到侧壁的距离²
    const capY = py >= 0 ? 0.5 : -0.5;
    const capD = ux * ux + uz * uz + (uy - capY) * (uy - capY);   // 到最近端盖的距离²
    if (sideD <= capD) {
      _attPL.set(ux / rr * 0.5, yc, uz / rr * 0.5);
      _attNL.set(ux / rr, 0, uz / rr);
    } else {
      _attPL.set(clamp(ux, -0.5, 0.5), capY, clamp(uz, -0.5, 0.5));
      _attNL.set(0, py >= 0 ? 1 : -1, 0);
    }
    return true;
  }
  _boxSnap(ux, uy, uz);
  return true;
}

/**
 * 面基座：+Y 对齐面法线 n（世界），面内 X 取宿主世界 X 轴（退化时取 Z 轴）。
 * out 得到「站立在面上」的朝向四元数；接头自身的「旋转」再叠在它之上（Y 即绕法线自转）。
 */
function _faceBasis(n, hostWorld, out) {
  _attRef.setFromMatrixColumn(hostWorld, 0);
  _attRef.addScaledVector(n, -_attRef.dot(n));
  if (_attRef.lengthSq() < 1e-8) {
    _attRef.setFromMatrixColumn(hostWorld, 2);
    _attRef.addScaledVector(n, -_attRef.dot(n));
  }
  if (_attRef.lengthSq() < 1e-8) {
    _attRef.set(0, 0, 1).cross(n);
    if (_attRef.lengthSq() < 1e-8) _attRef.set(1, 0, 0);
  }
  _attRef.normalize();
  _attZ.crossVectors(_attRef, n).normalize();     // Z = X × Y
  _attX.crossVectors(n, _attZ);                   // X = Y × Z（重新正交化）
  _attM3.makeBasis(_attX, n, _attZ);
  return out.setFromRotationMatrix(_attM3);
}

/* ---------- 空间查询（事件脚本用）的临时量 ---------- */
const _rcFrom = new CANNON.Vec3();
const _rcTo = new CANNON.Vec3();
const _rcRes = new CANNON.RaycastResult();
const _rcRay = new THREE.Raycaster();
const _rcA = new THREE.Vector3();
const _rcB = new THREE.Vector3();
const _rcDir = new THREE.Vector3();

/* 体积雾材质的独享 token 序号（见 getFogVolumeMaterial 的 token 说明） */
let _fogSeq = 0;

/* ---------- 自定义模型资源缓存 ---------- */
const _modelCache = new Map();   // assetId -> Promise<rec>（并发去重，同一素材只解析一次）
const _modelLoading = new Map(); // assetId -> Promise<rec>（加载中，用于去重与进度）
const _modelReady = new Map();   // assetId -> rec（解析完成，供同步读取）

/** 对象 scale 的稳定键：低模建模体 / 模型的 uv 烘了 scale，scale 变了要重烘 */
function studScaleKey(o) {
  return (o.scale || [1, 1, 1]).map((v) => +(Number(v) || 1).toFixed(4)).join(',');
}

/** 给缺 uv 的几何体补一份「盒式投影」uv：按顶点法线选主轴，取另两轴的局部坐标。
    与低模建模体（polyGeometry）同一套规则，保证贴图在这些 trimesh 上不被拉伸，
    且「贴图尺寸」能正常缩放（材质层的 repeat 会乘在这份 uv 上）。 */
function ensureBoxUV(geo) {
  const pos = geo.attributes.position;
  if (!pos) return;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const nor = geo.attributes.normal;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) { u = pz; v = py; }
    else if (ay >= ax && ay >= az) { u = px; v = pz; }
    else { u = px; v = py; }
    uv[i * 2] = u + 0.5; uv[i * 2 + 1] = v + 0.5;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.userData.boxUV = true;   // 标记自动盒投影 uv：挂载实例时按 stud 尺度重烘（见 _bakeModelStudUV）
}

async function fetchModel(assetId) {
  if (_modelCache.has(assetId)) return _modelCache.get(assetId);
  if (_modelLoading.has(assetId)) return _modelLoading.get(assetId);
  const p = (async () => {
    const rec = { group: null, box: new THREE.Box3(), status: 'error' };
    try {
      const { resolveAssetURL } = await import('../core/settings.js');
      const url = await resolveAssetURL(assetId);
      if (!url) { rec.status = 'missing'; return rec; }
      let assetName = '';
      try { assetName = (await store_getName(assetId)) || ''; } catch (e) { /* ignore */ }
      const ext = (assetName.split('.').pop() || '').toLowerCase();
      let obj = null;
      if (ext === 'obj') {
        const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
        obj = await new OBJLoader().loadAsync(url);
      } else {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const gltf = await new GLTFLoader().loadAsync(url);
        obj = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      }
      if (!obj) { rec.status = 'error'; return rec; }
      // 归一化到单位尺寸（最长边 = 1），由 mesh.scale 还原
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const maxd = Math.max(size.x, size.y, size.z) || 1;
      const center = box.getCenter(new THREE.Vector3());
      const holder = new THREE.Group();
      obj.position.sub(center);
      const s = 1 / maxd;
      obj.scale.multiplyScalar(s);
      holder.add(obj);
      const norm = new THREE.Box3().setFromObject(holder);
      obj.traverse((c) => {
        if (c.isMesh) {
          c.castShadow = true; c.receiveShadow = true;
          // 模型缺少 uv 时按「盒式投影」补一份（与低模建模体同一套做法）：
          // 若只填空 uv(全 0)，贴图只会采样到同一个像素（整片纯色），
          // 而且「贴图尺寸」的缩放将完全失效 —— 表现为拖尺寸毫无变化。
          if (c.geometry && !c.geometry.attributes.uv) ensureBoxUV(c.geometry);
        }
      });
      rec.group = holder; rec.box = norm; rec.status = 'ok';
      return rec;
    } catch (e) {
      console.warn('[builder] 模型加载失败', assetId, e);
      rec.status = 'error';
      return rec;
    } finally {
      _modelLoading.delete(assetId);
    }
  })();
  _modelLoading.set(assetId, p);
  _modelCache.set(assetId, p);
  p.then((rec) => { _modelReady.set(assetId, rec); }, () => { /* 失败也已缓存，忽略 */ });
  return p;
}
async function store_getName(assetId) {
  const { store } = await import('../core/storage.js');
  const r = await store.getAssetMeta(assetId);
  return r ? r.name : '';
}

/** 解析完成的模型记录（未就绪返回 null）。用于需要同步拿到的场景（如进关前预热） */
export function getLoadedModel(assetId) { return _modelReady.get(assetId) || null; }

/**
 * 收集关卡里引用到的外部模型素材 id：
 *   · 网格模型对象的 assetId
 *   · 事件动作 morph 用的 morphAsset（角色模型）
 */
export function collectModelAssetIds(level) {
  const ids = new Set();
  const walk = (v, d) => {
    if (!v || d > 8) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
    if (typeof v !== 'object') return;
    for (const k in v) {
      const val = v[k];
      if ((k === 'assetId' || k === 'morphAsset') && typeof val === 'string' && val) ids.add(val);
      else walk(val, d + 1);
    }
  };
  walk(level, 0);
  return [...ids];
}

/* 同时解析的模型数量上限：GLB 解析（几何 + 贴图）很吃内存，一次全上容易卡顿甚至 OOM */
const MODEL_PRELOAD_CONCURRENCY = 4;

/**
 * 预加载关卡里引用的全部外部模型（.glb / .gltf / .obj）。
 * 相比「碰到对象才按需加载」：
 *   · 进关前统一并发加载，加载界面可显示进度，避免进关后模型一个个“跳出来”
 *   · 事件动作（morphAsset）里用到的角色模型也提前备好，事件触发时零等待
 *   · 命中缓存的重复引用只解析一次
 * 注：GLTFLoader 在 Chromium 下默认用 ImageBitmapLoader，贴图解码本身就在主线程之外完成。
 * onProgress(done, total)：每有一个模型就绪回调一次
 */
export function preloadModels(level, onProgress) {
  const ids = collectModelAssetIds(level);
  const total = ids.length;
  if (!total) return Promise.resolve();
  let done = 0;
  const notify = () => { if (onProgress) { try { onProgress(done, total); } catch (e) { /* ignore */ } } };
  notify();
  const queue = ids.slice();
  const run = async () => {
    while (queue.length) {
      const id = queue.shift();
      try { await fetchModel(id); } catch (e) { /* ignore */ }
      done++; notify();
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(MODEL_PRELOAD_CONCURRENCY, total); i++) workers.push(run());
  return Promise.all(workers);
}

export function clearModelCache() { _modelCache.clear(); _modelLoading.clear(); _modelReady.clear(); }

/* ---------- 路径型对象（滑索 / 折曲线 / 管道）的旋转·缩放枢轴 ----------
   整体变换公式是 世界 = T(position)·T(C)·R·S·T(-C)，枢轴 C 取「路径质心」。
   质心会随节点编辑改变 —— 若每次重建都按新质心换算，拖一个节点就会让整条路径
   整体滑移 (I - R·S)·ΔC（旋转为 0 且缩放为 1 时恰好看不出来）。
   所以：只要对象带上了非平凡变换（有旋转 / 缩放），就把当时的质心固化进 o.pivot，
   之后编辑节点继续用这个固定枢轴，整体变换不再跟着动。 */

/** 读取对象里固化的枢轴（没有 / 非法则返回 null） */
function pathPivot(o) {
  const p = o && o.pivot;
  if (!Array.isArray(p) || p.length < 3) return null;
  const v = new THREE.Vector3(Number(p[0]), Number(p[1]), Number(p[2]));
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? v : null;
}

/** 是否「无旋转、无缩放」（此时枢轴取什么值都不影响结果；判定口径与 applyPathTransform 一致） */
function pathXformTrivial(o) {
  const r = (o && o.rotation) || [0, 0, 0];
  const s = (o && o.scale) || [1, 1, 1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(Number(r[i]) || 0) > 1e-6) return false;
    let sv = Number(s[i]);
    if (!Number.isFinite(sv)) sv = 1;
    if (Math.abs(Math.max(1e-4, Math.abs(sv)) - 1) > 1e-6) return false;
  }
  return true;
}

/** 路径型对象的材质参数：统一把「平滑着色」开关映射成材质的 flatShading。
    管道 / 折曲线 / 曲线墙共用这一个入口（建几何时与 syncMaterial 时都要走，否则改开关不生效）。 */
function pathLook(o) {
  return o && o.smoothShade === false ? { ...o, flatShading: true } : o;
}

/* ============================================================
   对象记录
   ============================================================ */
export class SceneObject {
  constructor(builder, data) {
    this.b = builder;
    this.id = data.id;
    this.type = data.type;
    this.o = data;
    this.def = typeDef(data.type);
    this.generatedPhysics = !!(this.def && this.def.generatedPhysics);   // 碰撞体来自生成网格（管道 / 网格修改器）
    this.group = null;      // 编组容器（group 类型）
    this.mesh = null;       // 主渲染对象
    this.body = null;       // cannon body（合批后为 null，见 bodyMerged）
    this.bodyMerged = false;   // 静态盒体是否已并入分块复合刚体
    this.mergedChunk = null;   // 所属分块复合刚体
    this.mergedShape = null;   // 在分块里的盒形（销毁 / 破坏时从这里摘掉）
    this.batched = false;      // 渲染网格是否已并进静态合批（原网格已从场景摘掉）
    this.helpers = [];
    this.model = null;
    this.liquid = null;     // { mesh, top:f }
    this.foamMesh = null;   // 围边泡沫网格（edgefoam，复用液体几何）
    this.zip = null;        // { curve, rope, lengths, total, mode }
    this.state = {};        // 机关运行时状态
    this.disposed = false;
  }
  get visible() { return this.o.visible !== false; }
  get worldPos() { return worldPosition(this.b.level, this.o); }
}

/* ============================================================
   构建器
   ============================================================ */
export class LevelBuilder {
  constructor(level, opts = {}) {
    this.level = level;
    this.uid = ++_builderSeq;
    this.editor = !!opts.editor;
    this.physics = opts.physics !== false;
    // 地图变体「镜像」：由会话设置。场景在渲染层被 x 取反，
    // 这里只用于把公告板的世界坐标换回原空间（见 updateBillboards）
    this.mirror = false;
    this.root = new THREE.Group();
    this.root.name = 'level';
    this.objects = new Map();       // id -> SceneObject
    this.byType = new Map();        // type -> SceneObject[]
    this.groupNodes = new Map();    // id -> THREE.Object3D（父容器）
    this.scene = opts.scene || null;
    // 体积雾管线：雾对象改由 PostFX 在色调映射前用半分辨率缓冲合成（见 volumefog.js）
    this.volumeFog = new VolumeFog(this.scene, this.root);
    this.paintHas = opts.paintHas || null;   // (id) => bool
    this.paintKey = opts.paintKey || null;   // (id) => 'paint:xxx'
    this.onTexturesReady = opts.onTexturesReady || null;   // 导入素材异步加载完成后的回调（涂鸦画布要重合成）
    this.onTextureProgress = opts.onTextureProgress || null;   // (loaded, total) 导入素材加载进度
    this.onModelProgress = opts.onModelProgress || null;   // (loaded, total) 外部模型（.glb/.gltf）加载进度
    // 对象位姿每帧被写过时回调（渲染 Worker 模式下据此推热通道；进程内模式为 null）
    this.onHot = opts.onHot || null;
    // 对象可见性 / 透明度被改过时回调（破坏消失、机关淡出；渲染 Worker 模式下增量同步）
    this.onState = opts.onState || null;
    // 运行时新增 / 移除对象回调（投掷物 / 动态生成物；渲染 Worker 模式下增量同步）
    this.onAdd = opts.onAdd || null;
    this.onRemove = opts.onRemove || null;
    // 某材质的 uniform 被改写时回调（围边泡沫；渲染 Worker 模式下一次性同步该材质）
    this.onMaterial = opts.onMaterial || null;
    this.texturesReady = null;   // 关卡引用的导入素材全部就绪的 Promise（加载界面据此等待）
    this.modelsReady = null;     // 关卡引用的外部模型全部就绪的 Promise（加载界面据此等待）
    this.time = 0;
    this.bounds = new THREE.Box3();
    this.onObjectChanged = null;
    this.culler = null;        // 遮挡剔除（运行时按设置懒创建，见 cull()）
    this.cullVersion = 0;      // 对象集合版本号：变了遮挡剔除才重建内部列表

    // 静态刚体合批（见文件顶部说明）：仅游玩模式启用，编辑器 / 生成校验逐对象建体
    this._staticBodyMerge = this.physics && !this.editor && opts.staticBodyMerge !== false;
    this._bodyChunks = new Map();   // '材质|cellX,cellY,cellZ' -> CANNON.Body（复合体）
    this._managedIds = null;        // 被事件 / 动画引用的对象 id（懒构建）
    this._batchMeshes = [];         // 静态合批生成的合并网格（销毁时统一释放几何体）
    this._visualBatched = false;

    if (this.physics) {
      const w = new CANNON.World({ gravity: new CANNON.Vec3(0, -PHYS.gravity * (level.settings.gravityScale || 1), 0) });
      w.broadphase = new CANNON.SAPBroadphase(w);
      w.allowSleep = true;
      w.solver.iterations = PHYS.solverIterations;
      w.defaultContactMaterial.friction = PHYS.defaultMaterial.friction;
      w.defaultContactMaterial.restitution = PHYS.defaultMaterial.restitution;
      this.world = w;
      this.mats = {
        default: physMaterial(w, 'default'),
        ice: physMaterial(w, 'ice'),
        bouncy: physMaterial(w, 'bouncy'),
      };
      this.playerMat = new CANNON.Material('player');
      this.playerMat.friction = 0.0;
      this.playerMat.restitution = 0.0;
      for (const k in this.mats) {
        w.addContactMaterial(new CANNON.ContactMaterial(this.mats[k], this.playerMat, {
          friction: k === 'ice' ? 0.02 : 0.12, restitution: 0,
        }));
      }
    }

    this.build();
  }

  /* ---------- 全量构建 ---------- */
  /**
   * 构建顺序：父对象必须先于子对象建出来（子对象要挂到父级的「子级锚点」下）。
   * 这里做一次 DFS 拓扑排序：数组顺序即兄弟顺序，父级永远排在子级前面。
   * （坏数据 / 成环的对象走末尾兜底，一样能建出来，不会丢失）
   */
  buildOrder() {
    const list = (this.level && this.level.objects) || [];
    const ids = new Set(list.map((o) => o && o.id));
    const kids = new Map();     // 父 id -> 子对象[]
    const roots = [];
    for (const o of list) {
      if (!o || !o.id) continue;
      const pid = o.parent && ids.has(o.parent) ? o.parent : null;
      if (!pid) { roots.push(o); continue; }
      const arr = kids.get(pid);
      if (arr) arr.push(o); else kids.set(pid, [o]);
    }
    const out = [];
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || seen.has(o.id) || depth > 64) return;
      seen.add(o.id);
      out.push(o);
      const arr = kids.get(o.id);
      if (arr) for (const c of arr) walk(c, depth + 1);
    };
    for (const o of roots) walk(o, 0);
    for (const o of list) if (o && o.id && !seen.has(o.id)) walk(o, 0);
    return out;
  }

  build() {
    // 批量构建期间不要逐个对象烘 AO：每个对象都重烤会变成 O(N²)
    // （重建时必须全量重烤，因为邻居集合完全变了）。这里统一在末尾 applyAO() 做一次。
    if (this._staticBodyMerge) this._managedIds = collectManagedIds(this.level);
    this._batching = true;
    try {
      for (const o of this.buildOrder()) this.create(o);
      // 后处理：液体/滑索/灯光等依赖世界坐标
      for (const rec of this.objects.values()) this.postCreate(rec);
    } finally {
      this._batching = false;
    }
    this.finalizeBodyChunks();   // 合批刚体：统一算一次包围盒（宽相依赖它）
    // 包围盒必须先算出来：太阳阴影相机的范围要按它来定（否则退回 three 默认的 ±5，远处方块全都没有阴影）
    this.computeBounds();
    this.applyEnv();
    this.applyAO();          // 顶点 AO 烘焙（接缝闭塞阴影），依赖全部实体的包围盒
    // 关卡里引用的导入贴图是异步加载的，加载完刷新一次材质
    // 返回的 Promise 供加载界面等待：素材就绪后再进关，避免贴图一张张跳出来
    this.texturesReady = registerLevelTextures(this.level, () => {
      // 涂鸦画布的底图是对象自带贴图（可能是导入的图片素材）：素材就绪后必须重合成一次，
      // 否则重进关卡时画布底图是空的（自定义贴图不显示）
      if (this.onTexturesReady) { try { this.onTexturesReady(); } catch (e) { /* ignore */ } }
      for (const rec of [...this.objects.values()]) {
        if (rec.batched) continue;   // 已合批：材质／几何已被合并网格接管，不再逐对象刷新
        try { this.syncMaterial(rec); } catch (e) { /* ignore */ }
      }
      this.applySky();   // 导入的全景天空图加载完成后生效
    }, this.onTextureProgress);
    // 外部模型（.glb/.gltf/.obj）同样在构建结束后统一并发预加载：
    // 与贴图加载并行，加载界面显示进度，进关时模型已就绪（不会一个个跳出来）
    this.modelsReady = preloadModels(this.level, this.onModelProgress);
  }

  /**
   * 关卡里是否有对象真正用到高级材质（只有网格模型 / 攀爬墙支持）
   * —— 用于判断要不要做一次性场景反射捕获（很贵，没有高级材质就完全没必要）
   */
  usesAdvancedMaterial() {
    const lv = this.level;
    if (!lv || !lv.objects) return false;
    for (const o of lv.objects) {
      if (!o) continue;
      if (o.type !== 'mesh' && o.type !== 'climb') continue;
      if (o.advMat && o.advMat !== 'none') return true;
    }
    return false;
  }

  /** 关卡里是否有玻璃物体（决定要不要渲半分辨率屏幕空间折射缓冲） */
  usesGlass() {
    const lv = this.level;
    if (!lv || !lv.objects) return false;
    for (const o of lv.objects) {
      if (!o) continue;
      if ((o.type === 'mesh' || o.type === 'climb' || o.type === 'poly' || o.type === 'vec') && advIsGlass(o.advMat)) return true;
    }
    return false;
  }

  /**
   * 一次性场景反射捕获（供高级材质使用）
   * 关卡加载后渲 6 个面一次，全关卡共用一张立方体贴图，运行时零开销。
   * 天空 / 环境反射变化后可以再调一次刷新。
   * 关卡里没有高级材质时直接跳过（捕获很贵，且贴图无从被采样）。
   */
  captureReflection(renderer) {
    if (!renderer || !this.scene) return null;
    if (!this.usesAdvancedMaterial()) {
      disposeReflections();       // 换到没有高级材质的关卡时，释放上一关残留的捕获贴图
      return null;
    }
    const empty = !this.bounds || this.bounds.isEmpty();
    const c = empty ? new THREE.Vector3() : this.bounds.getCenter(new THREE.Vector3());
    const s = empty ? new THREE.Vector3(80, 40, 80) : this.bounds.getSize(new THREE.Vector3());
    // 捕获用的环境贴图不能带画面调色（饱和度 / 染色），否则反射面会被染两次
    return withScreenGradeOff(
      () => captureReflections(renderer, this.scene, c, Math.max(s.x, s.y, s.z)),
    );
  }

  parentNode(id) {
    if (!id) return this.root;
    const p = this.groupNodes.get(id);
    return p || this.root;
  }

  create(o) {
    if (this.objects.has(o.id)) return this.objects.get(o.id);
    this.cullVersion++;
    const rec = new SceneObject(this, o);
    if (rec.def && rec.def.solid) this._foamDirty = true;   // 实体增删会影响围边泡沫
    this.objects.set(o.id, rec);
    const list = this.byType.get(o.type) || this.byType.set(o.type, []).get(o.type);
    list.push(rec);

    const parent = this.parentNode(o.parent);
    if (o.type === 'group') {
      const g = new THREE.Group();
      g.name = o.id;
      g.userData.objectId = o.id;
      g.userData.type = 'group';
      g.position.set(...(o.position || [0, 0, 0]));
      g.rotation.set(deg2rad(o.rotation?.[0] || 0), deg2rad(o.rotation?.[1] || 0), deg2rad(o.rotation?.[2] || 0));
      g.visible = o.visible !== false;
      rec.group = g;
      parent.add(g);
      this.groupNodes.set(o.id, this.makeAnchor(rec, parent));
      return rec;
    }

    /* ---------- 接头（attachment） ----------
       挂在宿主（父级）的锚点下，节点自身的世界变换由 updateAttachment 每帧按
       「宿主表面落点 + 面法线」反算出来。子对象挂在本节点上 → 相对这个面变换。
       宿主是液体时跟着 fillLevel 升降；宿主是会变形的 poly 时始终贴住当前形状。 */
    if (o.type === 'attachment') {
      const node = new THREE.Group();
      node.name = 'attach:' + o.id;
      node.userData.objectId = o.id;
      node.userData.type = 'attachment';
      node.visible = o.visible !== false;
      rec.group = node;                 // 借用 group 字段当变换节点（本类型没有 rec.mesh）
      parent.add(node);
      if (this.editor) this.addAttachmentHelper(rec, node);
      this.groupNodes.set(o.id, node);
      this.updateAttachment(rec);
      return rec;
    }

    switch (o.type) {
      case 'light': this.makeLight(rec, parent); break;
      case 'zipline': this.makeZipline(rec, parent); break;
      case 'curve': this.makeCurve(rec, parent); break;
      case 'pipe': this.makePipe(rec, parent); break;
      case 'curvewall': this.makeCurveWall(rec, parent); break;
      case 'meshref': this.makeMeshRef(rec, parent); break;
      case 'liquid': this.makeLiquid(rec, parent); break;
      case 'poly': this.makePoly(rec, parent); break;
      case 'vec': this.makeVec(rec, parent); break;
      case 'portal': this.makePortal(rec, parent); break;
      case 'npc': this.makeNpc(rec, parent); break;
      default: this.makeMesh(rec, parent); break;
    }
    // 子级锚点：任何对象都能当父级 —— 子对象挂在这上面，跟随本对象的位置 / 旋转
    this.groupNodes.set(o.id, this.makeAnchor(rec, parent));
    if (this.physics && !NO_PHYSICS.has(o.type)) {
      if (rec.generatedPhysics) this.makeGeneratedBody(rec);
      else this.makeBody(rec);
    }
    return rec;
  }

  /**
   * 子级锚点（子对象的父容器）：与对象本体同级挂在「父级坐标系」里，
   * 位置 / 旋转取自对象数据 → 锚点的世界变换就是父对象的位置 + 旋转。
   * 锚点自身不带尺寸（scale 恒为 1）：网格的 scale 是自身长宽高（默认 [4,1,4]），
   * 若让子级继承它，子级会被一起拉变形。所以子对象只跟随父级的位置 + 旋转。
   */
  makeAnchor(rec, parent) {
    const o = rec.o;
    const a = new THREE.Group();
    a.name = 'anchor:' + o.id;
    a.userData.anchorOf = o.id;
    a.position.set(...(o.position || [0, 0, 0]));
    const r = o.rotation || [0, 0, 0];
    a.rotation.set(deg2rad(r[0] || 0), deg2rad(r[1] || 0), deg2rad(r[2] || 0));
    a.visible = o.visible !== false;
    parent.add(a);
    return a;
  }

  postCreate(rec) {
    if (rec.type === 'liquid') this.setupLiquid(rec);
    if (rec.type === 'light') this.setupLight(rec);
    // 给主渲染节点打标：渲染 Worker 侧据此建立渲染记录（遮挡剔除 / 泡沫深度 / 体积雾）
    this._tagRender(rec);
  }

  /** 主渲染节点标记（节点分类元数据）：跨线程只传 type / shape，不传对象 */
  _tagRender(rec) {
    const tag = { type: rec.type, shape: (rec.o && rec.o.shape) || null };
    const hosts = [];
    if (rec.mesh) hosts.push(rec.mesh);
    if (rec.group && rec.group !== rec.mesh) hosts.push(rec.group);
    for (const h of hosts) {
      if (!h.userData) h.userData = {};
      h.userData.__o = tag;
    }
  }

  /** 是否需要「不含水体的场景深度图」（围边泡沫 / 能见深度 / 平台过渡判定） */
  _needsFoamDepth() {
    if (this.editor) return false;
    for (const rec of this.objectsOf('liquid')) {
      const o = rec.o;
      if (!o || o.visible === false || rec.visible === false) continue;
      const foamOn = o.edgeFoam !== false && clamp(Number(o.foamOpacity ?? 0.85), 0, 1) > 0.004;
      if (foamOn) return true;
      if (Number(o.visibilityDepth) > 0.001) return true;
      if (Number(o.platformDepth ?? 4) > 0.001) return true;
    }
    return false;
  }

  /**
   * 渲染子系统描述（低频）：渲染 Worker 侧据此重建泡沫深度 / 遮挡剔除 / 体积雾 /
   * 玻璃捕获 / 反射捕获。只传 uuid 与数值，不传 THREE 对象、不传函数。
   * 关卡加载完成、天空更换、画质切换后各下发一次即可。
   */
  renderDescriptors() {
    const fog = [];
    for (const rec of this.objectsOf('fogvol')) {
      if (rec.mesh) fog.push(rec.mesh.uuid);
    }
    const glass = [];
    if (this.usesGlass()) {
      for (const rec of this.objects.values()) {
        const o = rec.o;
        if (!o) continue;
        if (o.type !== 'mesh' && o.type !== 'climb' && o.type !== 'poly' && o.type !== 'vec') continue;
        if (!advIsGlass(o.advMat)) continue;
        const list = rec.meshes || (rec.mesh ? [rec.mesh] : []);
        for (const m of list) if (m) glass.push({ uuid: m.uuid, advMat: o.advMat });
      }
    }
    let reflections = null;
    if (this.usesAdvancedMaterial()) {
      const empty = !this.bounds || this.bounds.isEmpty();
      const c = empty ? new THREE.Vector3() : this.bounds.getCenter(new THREE.Vector3());
      const s = empty ? new THREE.Vector3(80, 40, 80) : this.bounds.getSize(new THREE.Vector3());
      // 镜像变体：整张地图在渲染层 x 取反，反射捕获中心同样要翻到渲染空间
      reflections = { center: [this.mirror ? -c.x : c.x, c.y, c.z], radius: Math.max(s.x, s.y, s.z) };
    }
    return {
      occlusion: !this.editor && settings.get('video.occlusionCulling', true) !== false,
      foam: this._needsFoamDepth(),
      fogScale: settings.get('video.fogScale', 0.5),
      fog,
      glass,
      reflections,
    };
  }

  /* ---------- 几何体选择 ---------- */
  /** 该对象是否已涂鸦（涂鸦方块用面图集几何，6 个面各有独立 uv） */
  hasPaint(rec) {
    return !!(this.paintHas && this.paintHas(rec.id));
  }

  /** 是否使用面图集几何（涂鸦方块 / 文字方块：每个面独占一格 uv） */
  useAtlas(rec) {
    return this.hasPaint(rec) || rec.type === 'textblock';
  }

  /** 是否为顶点 AO 的接收者（自绘材质 / 逻辑体 / 容器不参与） */
  isAOReceiver(rec) {
    const o = rec.o;
    if (!o || AO_SKIP.has(rec.type)) return false;
    if (o.bakeAO === false) return false;      // 逐对象退出（程序化大块体默认关，省几何细分与烘焙）
    return (o.shape || 'block') !== 'model';
  }

  /**
   * 单对象几何体：
   * ① 立方体按世界尺寸细分——顶点够密才能在接缝处烘焙出 AO 渐变；
   * ② 涂鸦中的立方体换成 3×2 面图集（涂鸦只落在被涂的那一面，不会六面重复）；
   * ③ 贴图填充模式（平铺不拉伸 / 九宫格）按面尺寸换算 uv——尺寸变了要重建；
   * ④ AO 接收者用独享几何（顶点色逐对象写入）；其余仍共享缓存几何。
   */
  makeGeometry(rec) {
    const o = rec.o;
    const shape = o.shape || 'block';
    // 公告板：只有一块面片，只渲染面朝玩家的那一面
    // （原来用盒体，六个面都贴图，绕到背后会看到一份镜像的内容）
    if (rec.type === 'billboard' && !this.hasPaint(rec)) {
      rec.geoAtlas = false;
      rec.geoFill = 'stretch';
      rec.geoKey = 'stretch';
      rec.ownGeometry = false;        // 面片走共享缓存几何，销毁时不能 dispose
      return buildGeometry('plane');
    }
    if (shape === 'block') {
      const s = o.scale || [1, 1, 1];
      const seg = this.blockSeg(o);
      const atlas = this.useAtlas(rec);
      const fill = this.blockFill(rec, atlas);
      const g = buildBoxFillGeometry(s, seg, fill, o.textureSize, atlas);
      expandBoxSeam(g, s);            // 拼缝防漏光：轻微外扩盖住共面接缝的亚像素裂缝
      g.userData.atlas = atlas;
      rec.geoAtlas = atlas;
      rec.geoFill = fill;
      rec.geoKey = boxFillKey(s, seg, fill, o.textureSize);
      rec.ownGeometry = true;
      return g;
    }
    rec.geoAtlas = false;
    rec.geoFill = 'stretch';
    rec.geoKey = 'stretch';
    const own = this.isAOReceiver(rec);
    rec.ownGeometry = own;
    const base = buildGeometry(shape, o.sides);
    return own ? base.clone() : base;
  }

  /** 立方体细分段数：顶点要靠近棱边，接缝处才能烘焙出 AO 渐变。
   *  不烘焙 AO 的对象（程序化大块体）没有这个需求 → 直接最低分段，省下十几倍三角面。 */
  blockSeg(o) {
    if (o && o.bakeAO === false) return 4;
    const s = (o && o.scale) || [1, 1, 1];
    return clamp(Math.round(Math.max(Math.abs(s[0] || 1), Math.abs(s[1] || 1), Math.abs(s[2] || 1)) / 1.2), 4, 16);
  }

  /** 立方体的填充模式：涂鸦（面图集）优先——涂鸦要求每面独立 uv，此时一律按拉伸 */
  blockFill(rec, atlas) {
    const f = (rec.o && rec.o.textureFill) || 'stretch';
    if (atlas || (f !== 'tile' && f !== 'nine')) return 'stretch';
    return f;
  }

  /* ---------- 文字方块 / 公告板 ---------- */
  /** 文字贴图的长宽比：文字方块看正面（宽×高），公告板看面片尺寸 */
  textAspect(o) {
    const s = (o && o.scale) || [1, 1, 1];
    const w = Math.abs(Number(s[0]) || 1);
    const h = Math.max(0.001, Math.abs(Number(s[1]) || 1));
    return clamp(w / h, 0.2, 5);
  }

  /** 公告板材质：每块独享（透明度逐帧改写），销毁时由 ownMaterial 负责 dispose */
  makeBillboardMaterial(rec) {
    rec.ownMaterial = true;
    return getBillboardMaterial(rec.o, this.textAspect(rec.o));
  }

  /** 文字方块 / 公告板：材质由文字贴图生成，文字或尺寸（长宽比）变了要重做 */
  textKey(rec) {
    const o = rec.o;
    return [o.text, o.rich ? JSON.stringify(o.rich) : '', o.textColor, o.bgColor, o.bgOpacity,
      o.fontSize, o.bold, o.align,
      o.valign, o.mode, o.image, o.color, o.transparency, o.emissive, o.emissiveIntensity,
      o.lightInfluence ?? 1,
      this.textAspect(o).toFixed(3)].join('|');
  }

  syncTextMaterial(rec) {
    const o = rec.o;
    const key = this.textKey(rec);
    if (rec.textKey === key && rec.mesh && rec.mesh.material) return;
    rec.textKey = key;
    const next = rec.type === 'billboard' ? this.makeBillboardMaterial(rec)
      : getTextMaterial(o, this.textAspect(o));
    const cur = rec.mesh && rec.mesh.material;
    if (cur === next) return;
    if (rec.ownMaterial) { if (cur) cur.dispose(); }
    else releaseMaterial(cur);
    if (rec.mesh) rec.mesh.material = next;
  }

  /* ---------- 平行视差传送门 ---------- */

  /**
   * 传送门：一整块 1×1 面片（局部 XY 平面），轮廓点 / 视差图层全部在着色器里算，
   * 轮廓走 uniform（拖节点时只更新数组，不重编译着色器）。
   * · 独立摆放：本体自己渲染窗口，材质每对象独享（由 ownMaterial 负责 dispose）。
   * · 挂在液体对象下（液体子集）：**本体不渲染**，只是给编辑器留一块隐形占位片；
   *   视差窗口由父级液体在自己的水面上画出来（见 refreshLiquidPortal）。
   */
  makePortal(rec, parent) {
    const o = rec.o;
    ensurePortalShape(o);
    rec.ownGeometry = false;                 // 共享的 1×1 面片几何，销毁时不能 dispose
    const liq = this.portalParent(rec);
    rec.ownMaterial = !liq;
    const mat = liq ? portalGhostMaterial() : getPortalMaterial(o);
    if (liq) {
      rec.portal = this.makePortalConfig(rec);
      applyPortalOutline(rec.portal, sampleOutline(o));
    } else {
      rec.portalKey = portalKey(o);
      applyPortalOutline(mat, sampleOutline(o));
    }
    const mesh = new THREE.Mesh(buildGeometry('plane'), mat);
    mesh.userData.objectId = o.id;
    mesh.position.set(...o.position);
    mesh.rotation.set(deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2]));
    mesh.scale.set(...o.scale);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 5;                    // 不透明物之后画，像一扇“窗”盖在背景上
    rec.mesh = mesh;
    rec.meshes = [mesh];
    parent.add(mesh);
    if (!rec.visible) mesh.visible = false;
    // 液体子集：相机数据由液体那边的 onBeforeRender 写（本体材质 visible=false，永远不渲染）
    if (!liq) this.bindPortal(mesh, rec);
    else this.refreshLiquidPortal(liq);
    return mesh;
  }

  /** 父对象是液体时返回该液体记录（传送门作为它的「液体子集」），否则 null */
  portalParent(rec) {
    const pid = rec.o && rec.o.parent;
    if (!pid) return null;
    const p = this.objects.get(pid);
    return (p && p.type === 'liquid' && p.o) ? p : null;
  }

  /** 该液体的水面上承载的传送门：一个液体只画一个窗口（第一个带注入配置的子传送门） */
  liquidPortal(liqRec) {
    if (!liqRec || !liqRec.o) return null;
    const ports = this.byType.get('portal');
    if (!ports) return null;
    for (const pr of ports) {
      if (pr.portal && pr.o && pr.o.parent === liqRec.o.id) return pr;
    }
    return null;
  }

  /** 液体子集注入的材质 key：必须带上对象 id —— uniform 是逐对象的，
      两片水面上参数完全相同的传送门不能共用同一个液体材质实例 */
  portalSurfaceKey(rec) { return 'ptlw|' + this.uid + '|' + rec.id + '|' + portalKey(rec.o); }

  /** 液体子集传送门的注入包：共享 uniform 对象 + 共享 GLSL 片段（materials.js 不认识 portal.js）。
      uniforms 对象被液体材质与传送门本体共同持有：逐帧写一处，两边看到的都是同一份数据。 */
  makePortalConfig(rec) {
    const o = rec.o;
    return {
      key: this.portalSurfaceKey(rec),
      core: PORTAL_CORE_GLSL,
      head: PORTAL_SURFACE_HEAD_GLSL,
      body: PORTAL_SURFACE_GLSL,
      uniforms: Object.assign(makePortalUniforms(o), makePortalSurfaceUniforms(o)),
    };
  }

  /** 该液体的材质：把「在水面渲染传送门」注入进去；没有子传送门时回到普通液体材质 */
  refreshLiquidPortal(liqRec) {
    if (!liqRec || liqRec.type !== 'liquid' || !liqRec.mesh || !liqRec.o) return;
    const pr = this.liquidPortal(liqRec);
    liqRec.liquidPortalRec = pr || null;    // 逐帧的 onBeforeRender 直接读缓存，不再扫列表
    const cfg = pr ? pr.portal : null;
    if (cfg) {
      // 窗口沿岸的水沫直接沿用承载它的液体的「围边泡沫」参数
      const lo = liqRec.o;
      const on = lo.edgeFoam !== false;
      cfg.uniforms.uPtFoamW.value = on ? Math.max(0.4, Number(lo.foamWidth ?? 4.5)) : 0;
      cfg.uniforms.uPtFoamA.value = on ? clamp(Number(lo.foamOpacity ?? 0.85), 0, 1) : 0;
      cfg.uniforms.uPtFoamColor.value.set(lo.foamColor || '#ffffff');
    }
    const mat = getLiquidMaterial(liqRec.o.kind || 'water', liqRec.o, cfg);
    if (liqRec.mesh.material !== mat) {
      releaseMaterial(liqRec.mesh.material);
      liqRec.mesh.material = mat;
    } else {
      releaseMaterial(mat);   // 材质没变：把刚才多拿的那次引用立刻还回去，否则引用计数只涨不落
    }
    this.bindLiquidPortal(liqRec.mesh, liqRec);
    this.updateFoam(liqRec);
  }

  /** 把相机位置 / 朝向 / 缩放换算写进传送门 uniform：视差需要相机在**传送门局部**的位置。
      独立材质与液体水面注入共用同一份 uniform 对象，所以两边走同一个写入函数。 */
  writePortalView(u, mesh, scale) {
    if (!u || !u.uCamLocal || !mesh) return;
    const cam = this.camera;
    if (!cam) return;
    _tmpM.copy(mesh.matrixWorld).invert();
    _tmpV.copy(cam.position);
    if (this.mirror) _tmpV.x = -_tmpV.x;
    _tmpV.applyMatrix4(_tmpM);
    u.uCamLocal.value.copy(_tmpV);
    // 相机朝向（局部空间）：换算成等效横向位移，让转头也有视差
    cam.getWorldDirection(_tmpDir3);
    if (this.mirror) _tmpDir3.x = -_tmpDir3.x;
    _tmpDir3.transformDirection(_tmpM);
    if (u.uCamDirLocal) u.uCamDirLocal.value.copy(_tmpDir3);
    // 缩放会随时被拖拽改变：局部 ↔ stud 的换算每帧刷一次，避免为了改缩放重建材质
    const sc = scale || [1, 1, 1];
    if (u.uUnitZ) u.uUnitZ.value = Math.abs(Number(sc[2]) || 1) || 1;
    if (u.uUnitXY) u.uUnitXY.value = Math.max(0.01, (Math.abs(Number(sc[0]) || 1) + Math.abs(Number(sc[1]) || 1)) * 0.5);
  }

  /** 独立传送门：逐帧喂相机数据（材质被渲染时才会触发） */
  bindPortal(mesh, rec) {
    if (!mesh || !mesh.isMesh) return;
    mesh.onBeforeRender = () => {
      this.writePortalView(mesh.material && mesh.material.uniforms, mesh, rec.o && rec.o.scale);
    };
  }

  /**
   * 液体子集：相机数据与「世界 → 传送门局部」矩阵必须在**液体渲染之前**写好 ——
   * 传送门本体不渲染（材质 visible=false），它的 onBeforeRender 永远不会被调用。
   */
  bindLiquidPortal(mesh, liqRec) {
    if (!mesh || !mesh.isMesh) return;
    mesh.onBeforeRender = () => {
      const pr = liqRec.liquidPortalRec;
      if (!pr || !pr.mesh || !pr.portal) return;
      const pm = pr.mesh;
      pm.updateWorldMatrix(true, false);
      const u = pr.portal.uniforms;
      this.writePortalView(u, pm, pr.o.scale);
      u.uPtW2L.value.copy(pm.matrixWorld).invert();
    };
  }

  /** 传送门刷新：轮廓走 uniform，图层 / 外框参数变了才换材质 */
  syncPortal(rec) {
    const o = rec.o;
    ensurePortalShape(o);
    const liq = this.portalParent(rec);
    if (liq) {
      // 液体子集：本体没有材质，只维护水面注入用的那份 uniform
      const key = this.portalSurfaceKey(rec);
      if (!rec.portal || rec.portal.key !== key) rec.portal = this.makePortalConfig(rec);
      else rec.portal.uniforms.uPtEdge.value = clamp(Number(o.edgeSoft ?? 0.006), 0.0005, 0.05);
      // 轮廓是编辑期的高频数据：换过 uniform 对象或拖完节点后都要立刻补上
      applyPortalOutline(rec.portal, sampleOutline(o));
      // 从独立形态改成液体子集时，把自绘材质换成隐形占位
      if (rec.ownMaterial && rec.mesh) {
        rec.ownMaterial = false;
        const cur = rec.mesh.material;
        if (cur && cur !== portalGhostMaterial()) cur.dispose();
        rec.mesh.material = portalGhostMaterial();
      }
      this.refreshLiquidPortal(liq);
      if (rec.mesh) rec.mesh.visible = rec.visible;
      return;
    }
    // 独立传送门
    if (rec.portal) rec.portal = null;
    const key = portalKey(o);
    if (rec.ownMaterial !== true || rec.portalKey !== key || !rec.mesh.material || !rec.mesh.material.uniforms) {
      rec.portalKey = key;
      const cur = rec.mesh.material;
      const next = getPortalMaterial(o);
      if (cur && cur !== next && cur !== portalGhostMaterial()) cur.dispose();
      rec.mesh.material = next;
      rec.ownMaterial = true;
      this.bindPortal(rec.mesh, rec);
    }
    applyPortalOutline(rec.mesh.material, sampleOutline(o));
    if (rec.mesh) rec.mesh.visible = rec.visible;
  }

  /* ---------- 网格模型 ---------- */

  /** 体积雾的独享材质 token：每个雾对象一份材质（逐对象矩阵 uniform 不能被共用） */
  fogToken(rec) {
    if (!rec.fogToken) rec.fogToken = 'fv' + (++_fogSeq);
    return rec.fogToken;
  }

  /**
   * 体积雾：绘制前把物体矩阵喂给自绘材质（步进需要模型矩阵与逆矩阵），
   * 并按「相机是否在体积内部」切换渲染面——在内部时看到的是盒子背面，
   * 不改面渲染的话「走进雾里」会整块消失。
   * 用 onBeforeRender 而不是每帧在 update 里写：物体被编组、被物理补间、
   * 或材质被属性面板换新时，这里都能拿到当下正确的矩阵与材质。
   */
  bindFogVolume(mesh) {
    if (!mesh || !mesh.isMesh) return;
    mesh.onBeforeRender = () => {
      const mat = mesh.material;
      const u = mat && mat.uniforms;
      if (!u || !u.uModel) return;
      u.uModel.value.copy(mesh.matrixWorld);
      u.uInvModel.value.copy(mesh.matrixWorld).invert();
      const cam = this.camera;
      if (!cam) return;
      // 镜像变体：uInvModel 是「镜像空间」的世界→局部矩阵（着色器里的世界坐标也是镜像空间的），
      // 所以相机位置要一并换算到镜像空间，否则「人走进雾里」的判定会左右反掉
      _tmpV.copy(cam.position);
      if (this.mirror) _tmpV.x = -_tmpV.x;
      _tmpV.applyMatrix4(u.uInvModel.value);
      const inside = Math.abs(_tmpV.x) < 0.5 && Math.abs(_tmpV.y) < 0.5 && Math.abs(_tmpV.z) < 0.5;
      const side = inside ? THREE.BackSide : THREE.FrontSide;
      if (mat.side !== side) mat.side = side;
    };
  }

  /* ---------- 低模建模体 ----------
     几何完全由对象数据里的 verts / faces 生成（单位空间，尺寸交给 scale），
     所以不经过 makeGeometry 的共享缓存，每个对象一份独享几何。 */
  makePoly(rec, parent) {
    const o = rec.o;
    ensurePoly(o);                       // 数据损坏时用单位方块兜底
    const geo = polyGeometry(o);
    rec.polyStudKey = studScaleKey(o);   // uv 里烘了 scale → scale 变了要重烘（见 refreshGeometry）
    const mesh = new THREE.Mesh(geo, getMaterial(o, this.mapOverride(rec), { studUV: true }));
    const p = o.position || [0, 0, 0];
    const r = o.rotation || [0, 0, 0];
    const sc = o.scale || [1, 1, 1];
    mesh.userData.objectId = o.id;
    mesh.position.set(p[0], p[1], p[2]);
    mesh.rotation.set(deg2rad(r[0]), deg2rad(r[1]), deg2rad(r[2]));
    mesh.scale.set(sc[0], sc[1], sc[2]);
    mesh.castShadow = o.castShadow !== false;
    mesh.receiveShadow = true;
    mesh.userData.ownGeometry = true;
    mesh.visible = rec.visible;
    rec.ownGeometry = true;
    rec.mesh = mesh;
    rec.meshes = [mesh];
    parent.add(mesh);
    return mesh;
  }

  /* ---------- 矢量挤出体 ----------
     形状来自 vecShape（矢量图文档），厚度 / 倒角参数现算几何（单位空间，尺寸交给 scale），
     同样不经过共享几何缓存；uv 里烘了 scale → scale 变了要重烘（见 refreshGeometry）。 */
  makeVec(rec, parent) {
    const o = rec.o;
    const geo = vecGeometry(o);
    rec.vecKey = vecKey(o);
    const mesh = new THREE.Mesh(geo, getMaterial(o, this.mapOverride(rec), { studUV: true }));
    const p = o.position || [0, 0, 0];
    const r = o.rotation || [0, 0, 0];
    const sc = o.scale || [1, 1, 1];
    mesh.userData.objectId = o.id;
    mesh.position.set(p[0], p[1], p[2]);
    mesh.rotation.set(deg2rad(r[0]), deg2rad(r[1]), deg2rad(r[2]));
    mesh.scale.set(sc[0], sc[1], sc[2]);
    mesh.castShadow = o.castShadow !== false;
    mesh.receiveShadow = true;
    mesh.userData.ownGeometry = true;
    mesh.visible = rec.visible;
    rec.ownGeometry = true;
    rec.mesh = mesh;
    rec.meshes = [mesh];
    parent.add(mesh);
    return mesh;
  }

  makeMesh(rec, parent) {
    const o = rec.o;
    const geo = this.makeGeometry(rec);
    // 立方体填充模式（平铺 / 九宫格）的 uv 已烘焙进几何，材质层不能再乘 repeat；
    // 其它形状（含自定义模型）没有烘焙 → 由材质的 repeat 承担「贴图尺寸」的缩放
    const matOpts = { baked: rec.geoFill === 'tile' || rec.geoFill === 'nine', studUV: o.shape === 'model' };
    const mat = o.type === 'fogvol' ? getFogVolumeMaterial(o, this.fogToken(rec))
      : o.type === 'volumelight' ? getVolumeLightMaterial(o)
      : o.type === 'textblock' ? getTextMaterial(o, this.textAspect(o))
      : o.type === 'billboard' ? this.makeBillboardMaterial(rec)
      : getMaterial(o, this.mapOverride(rec), matOpts);
    if (o.type === 'textblock' || o.type === 'billboard') rec.textKey = this.textKey(rec);
    let mesh;
    if (o.shape === 'model') {
      mesh = new THREE.Group();
      mesh.userData.objectId = o.id;
      mesh.position.set(...o.position);
      mesh.rotation.set(deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2]));
      mesh.scale.set(...o.scale);
      // 预加载已就绪（重进关卡 / 编辑器重建）时直接放模型，省掉“占位方块→模型”的跳变，
      // 也让包围盒与着色器预热能覆盖到它；否则先摆占位物、异步替换
      const ready = getLoadedModel(o.assetId);
      if (ready && ready.group) {
        this._attachModel(rec, mesh, ready, mat, o);
      } else {
        const ph = this.makePlaceholder(rec, mat);
        mesh.add(ph);
        rec.placeholder = ph;
        rec.pendingModel = true;
        fetchModel(o.assetId).then((m) => {
          if (rec.disposed || !rec.mesh) return;
          if (m.group) {
            this._attachModel(rec, rec.mesh, m, mat, o);
            this.onObjectChanged && this.onObjectChanged(rec);
          }
          rec.pendingModel = false;
          this.cullVersion++;          // 模型（或兜底占位块）就位 → 让遮挡剔除重建形状缓存
        }).catch(() => { rec.pendingModel = false; this.cullVersion++; });
      }
    } else {
      mesh = new THREE.Mesh(geo, mat);
      mesh.userData.objectId = o.id;
      mesh.position.set(...o.position);
      mesh.rotation.set(deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2]));
      mesh.scale.set(...o.scale);
      rec.meshes = [mesh];
    }
    mesh.castShadow = o.castShadow !== false;
    mesh.receiveShadow = true;
    if (rec.ownGeometry) mesh.userData.ownGeometry = true;
    if (o.type === 'fogvol') {
      mesh.castShadow = false; mesh.receiveShadow = false; mesh.renderOrder = 6;
      this.bindFogVolume(mesh);
      this.volumeFog.register(rec);   // 挪到独占渲染层，交给半分辨率雾管线
    }
    if (o.type === 'volumelight') { mesh.castShadow = false; mesh.receiveShadow = false; mesh.renderOrder = 7; }
    if (o.type === 'billboard') { mesh.castShadow = false; mesh.receiveShadow = false; }
    mesh.visible = rec.visible && !(LOGIC_ONLY.has(o.type) && !this.editor);
    rec.mesh = mesh;
    parent.add(mesh);

    if (!rec.visible || (LOGIC_ONLY.has(o.type) && !this.editor)) mesh.visible = false;
    // 编辑器辅助体
    if (this.editor && LOGIC_ONLY.has(o.type)) this.addVolumeHelper(rec, parent, o.color || '#ffd98a');
    if (this.editor && o.type === 'walljump') this.addEdgeHelper(rec, mesh);
    if (this.editor && o.type === 'climb') this.addEdgeHelper(rec, mesh);
    // 体积光：可选附带一盏真实点光源（放在光锥起点）
    if (o.type === 'volumelight') this.makeVolLight(rec);
    // 构建完成后新增/重建的对象：立刻补一次 AO 烘焙
    // （批量构建时跳过——末尾的 applyAO() 会全量重烤一次，避免 O(N²)）
    if (this._aoReady && !this._batching) this.refreshAO(rec);
    return mesh;
  }

  /* ---------- 体积光附带光源 ---------- */
  makeVolLight(rec) {
    const o = rec.o;
    if (o.withLight === false) return null;
    const l = new THREE.PointLight(new THREE.Color(o.color || '#ffe9b0'),
      Number(o.lightPower ?? 1.1), Number(o.lightRange ?? 120), 1.6);
    l.castShadow = false;
    l.visible = rec.visible;
    this.root.add(l);
    rec.volLight = l;
    this.updateVolLightPos(rec);
    return l;
  }

  removeVolLight(rec) {
    if (rec.volLight && rec.volLight.parent) rec.volLight.parent.remove(rec.volLight);
    rec.volLight = null;
  }

  /** 点光源放在光锥起点（本地 +Y 顶端，随旋转/缩放/父级变化） */
  updateVolLightPos(rec) {
    const l = rec.volLight;
    if (!l || !rec.mesh) return;
    const o = rec.o;
    rec.mesh.getWorldPosition(_tmpV);
    // 光源挂在 root 下，root 的局部空间就是原空间 —— 镜像局里要把世界坐标换回来
    if (this.mirror) _tmpV.x = -_tmpV.x;
    _tmpQ.setFromEuler(_tmpE.set(deg2rad(o.rotation?.[0] || 0), deg2rad(o.rotation?.[1] || 0), deg2rad(o.rotation?.[2] || 0)));
    _tmpE2V.set(0, Math.abs(o.scale?.[1] || 1) * 0.5, 0).applyQuaternion(_tmpQ);
    l.position.set(_tmpV.x + _tmpE2V.x, _tmpV.y + _tmpE2V.y, _tmpV.z + _tmpE2V.z);
    l.visible = rec.visible && o.visible !== false;
  }

  makePlaceholder(rec, mat) {
    const o = rec.o;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    mesh.castShadow = o.castShadow !== false;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** 把解析好的模型实例挂到模型对象的容器上（替换掉占位物） */
  _attachModel(rec, host, m, mat, o) {
    rec.model = m.group;
    const c = m.group.clone(true);
    host.updateMatrixWorld(true);
    c.updateMatrixWorld(true);
    const sc = (o.scale || [1, 1, 1]).map((v) => Number(v) || 1);
    // host 局部（不含 host 自身缩放）→ 实例网格的相对变换，供 uv 重烘 / scale 变化后重烘复用
    const hostInv = new THREE.Matrix4().copy(host.matrixWorld).invert();
    c.traverse((x) => {
      if (x.isMesh) {
        x.material = mat; x.castShadow = o.castShadow !== false; x.receiveShadow = true;
        // 自动盒投影的网格：uv 从归一化空间重烘成 stud 尺度（贴图尺寸=每格 stud，与方块平铺对齐）
        if (x.geometry && x.geometry.userData && x.geometry.userData.boxUV) {
          this._bakeModelStudUV(x, sc, new THREE.Matrix4().multiplyMatrices(hostInv, x.matrixWorld));
        }
      }
    });
    rec._studScaleKey = sc.join(',');
    rec.meshes = [c];
    if (rec.placeholder) { host.remove(rec.placeholder); rec.placeholder = null; }
    host.add(c);
    rec.modelBox = m.box.clone();
  }

  /** 把自动盒投影（geometry.userData.boxUV）的模型网格 uv 重烘成 stud 尺度：
      uv = 对象局部坐标（stud），材质层 repeat = 1/贴图尺寸(stud)。
      几何体在实例间共享 → 只新建 uv 属性，position / normal / index 仍与缓存共享。
      rel = 网格在 host 局部空间的相对变换（不含 host 缩放），scale 变化时可复用重烘。 */
  _bakeModelStudUV(mesh, hostScale, rel) {
    const src = mesh.geometry;
    const pos = src.attributes.position;
    if (!pos || !pos.count) return;
    const nor = src.attributes.normal;
    const n = pos.count;
    const _v = new THREE.Vector3(), _n = new THREE.Vector3();
    const nm = new THREE.Matrix3().getNormalMatrix(rel);
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      _v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(rel);
      let nx = 0, ny = 0, nz = 1;
      if (nor) {
        _n.set(nor.getX(i), nor.getY(i), nor.getZ(i)).applyMatrix3(nm).normalize();
        nx = _n.x; ny = _n.y; nz = _n.z;
      }
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      if (ax >= ay && ax >= az) { uv[i * 2] = _v.z * hostScale[2]; uv[i * 2 + 1] = _v.y * hostScale[1]; }
      else if (ay >= ax && ay >= az) { uv[i * 2] = _v.x * hostScale[0]; uv[i * 2 + 1] = _v.z * hostScale[2]; }
      else { uv[i * 2] = _v.x * hostScale[0]; uv[i * 2 + 1] = _v.y * hostScale[1]; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', pos);
    if (nor) g.setAttribute('normal', nor);
    if (src.index) g.setIndex(src.index);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    mesh.geometry = g;
    mesh.userData.ownGeometry = true;
    mesh.userData._studRel = rel;
  }

  mapOverride(rec) {
    if (this.paintHas && this.paintHas(rec.id)) return 'paint:' + rec.id;
    return undefined;
  }

  /** 涂鸦开始 / 清除、填充模式或尺寸变化后：立方体几何需要重建
      （面图集版的每个面各有独立 uv，涂鸦才会只落在被涂的那一面；
        平铺 / 九宫格的 uv 是按面尺寸烘焙的，尺寸一改就得重算） */
  refreshGeometry(rec) {
    if (!rec.mesh || !rec.mesh.isMesh) return;
    // 路径型对象（滑索 / 折曲线 / 管道）的几何是沿路径扫掠出来的，没有 shape 属性，
    // 若按立方体分支重建会把整条路径换成一个小方块（改个颜色对象就"消失"）→ 直接跳过
    if (PATH_TYPES.has(rec.type)) return;
    // 低模建模体的几何来自 verts / faces，走方块分支会把整块模型换成一个小方块 → 跳过。
    // 但 uv 里烘了 scale（stud 尺度）→ scale 变了要重烘几何
    if (rec.type === 'poly') {
      const key = studScaleKey(rec.o);
      if (key === rec.polyStudKey) return;
      rec.polyStudKey = key;
      const old = rec.mesh.geometry;
      rec.mesh.geometry = polyGeometry(rec.o);
      rec.mesh.userData.ownGeometry = true;
      if (old) old.dispose();
      if (this._aoReady) this.refreshAO(rec);
      return;
    }
    // 矢量挤出体：形状 / 厚度 / 倒角 / scale 任一变化都要重算几何（uv 里烘了 scale）
    if (rec.type === 'vec') {
      const key = vecKey(rec.o);
      if (key === rec.vecKey) return;
      rec.vecKey = key;
      const old = rec.mesh.geometry;
      rec.mesh.geometry = vecGeometry(rec.o);
      rec.mesh.userData.ownGeometry = true;
      if (old) old.dispose();
      return;
    }
    if ((rec.o.shape || 'block') !== 'block') return;
    const o = rec.o;
    const atlas = this.useAtlas(rec);
    const key = boxFillKey(o.scale, this.blockSeg(o), this.blockFill(rec, atlas), o.textureSize);
    if (atlas === !!rec.geoAtlas && key === rec.geoKey) return;
    const old = rec.mesh.geometry;
    const g = this.makeGeometry(rec);
    rec.mesh.geometry = g;
    rec.mesh.userData.ownGeometry = true;
    if (old) old.dispose();
    if (this._aoReady) this.refreshAO(rec);
  }

  /* ---------- 液体 ---------- */
  makeLiquid(rec, parent) {
    const o = rec.o;
    const f = clamp(o.fillLevel ?? 1, 0, 1);
    const geo = buildGeometry(o.shape || 'block', o.sides);
    const mat = getLiquidMaterial(o.kind || 'water', o);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.objectId = o.id;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 4;
    rec.mesh = mesh;
    rec.meshes = [mesh];
    rec.liquid = { f, mesh, kind: o.kind || 'water' };
    parent.add(mesh);
    this.updateLiquidTransform(rec);
    // 编辑器液面线
    if (this.editor) {
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: o.color || '#4fa8ff', transparent: true, opacity: 0.7 })
      );
      line.userData.objectId = o.id;
      rec.surfaceLine = line;
      parent.add(line);
      this.updateLiquidTransform(rec);
    }
    return mesh;
  }

  updateLiquidTransform(rec) {
    const o = rec.o;
    // 以对象数据 o.fillLevel 为准（编辑器属性面板 / 动画预览都会写这里），并回写运行时状态
    const f = clamp(o.fillLevel ?? (rec.liquid ? rec.liquid.f : 1), 0, 1);
    if (rec.liquid) rec.liquid.f = f;
    const sy = Math.max(0.001, o.scale[1]);
    const mesh = rec.mesh;
    mesh.position.set(o.position[0], o.position[1] + sy * (f - 1) / 2, o.position[2]);
    mesh.rotation.set(deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2]));
    mesh.scale.set(Math.max(0.001, o.scale[0]), Math.max(0.001, sy * f), Math.max(0.001, o.scale[2]));
    mesh.updateMatrixWorld(true);
    if (rec.surfaceLine) {
      rec.surfaceLine.position.copy(mesh.position);
      rec.surfaceLine.rotation.copy(mesh.rotation);
      rec.surfaceLine.scale.copy(mesh.scale);
      rec.surfaceLine.visible = rec.visible;
    }
    this.updateFoam(rec);
  }

  setupLiquid(rec) {
    rec.mesh.updateMatrixWorld(true);
    rec.liquid.inv = new THREE.Matrix4().copy(rec.mesh.matrixWorld).invert();
  }

  /* ---------- 接头（attachment） ---------- */
  /** 编辑器辅助：接头显示为一个小点（恒定屏幕像素大小）。
      刻意不做 always-on-top —— 保持正常深度测试，被墙面挡住时就该看不见，
      这样才和别的对象一样有「前后关系」，不会隔着地形冒出来干扰观察。 */
  addAttachmentHelper(rec, node) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const mat = new THREE.PointsMaterial({
      color: (rec.def && rec.def.color) || '#8ef5c8',
      size: 7,
      sizeAttenuation: false,   // 不随距离缩放：远近都是同样大小的一个点
      transparent: true,
      opacity: 0.95,
      depthWrite: false,        // 不写深度（不遮挡别人），但仍参与深度测试（会被别人挡住）
    });
    const dot = new THREE.Points(geo, mat);
    dot.position.set(0, 0.04, 0);   // 沿面法线抬一点点，避免与宿主表面共面而闪烁
    dot.frustumCulled = false;      // 单点几何的包围球没有半径，视口边缘会被误剔除
    dot.userData.helper = true;
    dot.userData.objectId = rec.id;
    dot.renderOrder = 6;
    node.add(dot);
    rec.helpers.push(dot);
    return dot;
  }

  /**
   * 把接头摆到宿主表面上：
   * ① 取宿主「网格局部空间」的落点 + 面法线（液体 / poly / 各种形状，见 sampleHostSurface）
   * ② 换算到世界：点走 matrixWorld，法线走法线矩阵
   * ③ 沿法线加 offset；朝向上 +Y 对齐法线，再叠接头自身的「旋转」（Y = 绕法线自转 = roll）
   * ④ 用「父级世界逆 × 期望世界」得到本节点在父级坐标系里的局部变换
   *
   * 注意：不能把接头挂进宿主 mesh 之下 —— 宿主的 scale（液体是 sy*f）会顺着场景图
   * 把子对象一起拉变形。所以接头只挂在宿主锚点下，自己每帧反算变换。
   */
  updateAttachment(rec) {
    const o = rec.o;
    const node = rec.group;
    if (!node) return;
    const parent = node.parent || this.root;
    parent.updateWorldMatrix(true, false);
    _attM1.copy(parent.matrixWorld).invert();

    _attE1.set(deg2rad(o.rotation?.[0] || 0), deg2rad(o.rotation?.[1] || 0), deg2rad(o.rotation?.[2] || 0));
    _attQ2.setFromEuler(_attE1);
    _attS.set(...(o.scale || [1, 1, 1]));

    const host = o.parent ? this.objects.get(o.parent) : null;
    let snapped = false;
    if (o.snap !== false && isSurfaceHost(host)) {
      if (sampleHostSurface(host, o, rec)) {
        const hm = host.mesh;
        hm.updateWorldMatrix(true, false);
        _attWp.copy(_attPL).applyMatrix4(hm.matrixWorld);
        _attNm.getNormalMatrix(hm.matrixWorld);
        _attN.copy(_attNL).applyMatrix3(_attNm).normalize();
        _attWp.addScaledVector(_attN, Number(o.offset) || 0);
        _faceBasis(_attN, hm.matrixWorld, _attQ1);
        _attQ1.multiply(_attQ2);
        snapped = true;
      }
    }
    if (!snapped) {
      // 未吸附（或宿主不可用）：按「宿主局部坐标 + 自身旋转」直接摆放
      _attWp.set(...(o.position || [0, 0, 0])).applyMatrix4(parent.matrixWorld);
      _attQ1.copy(_attQ2);
    }

    _attM2.compose(_attWp, _attQ1, _attS);
    _attM1.multiply(_attM2);
    _attM1.decompose(node.position, node.quaternion, node.scale);
    node.visible = o.visible !== false;

    // 动了才通知子对象重算静态碰撞体（水面逐帧升降时这条会被频繁触发，但只有真的位移才走到）
    const last = rec._attWp;
    if (!last) { rec._attWp = _attWp.clone(); this.syncChildBodies(rec.id); }
    else if (last.distanceToSquared(_attWp) > 1e-6) {
      last.copy(_attWp);
      this.syncChildBodies(rec.id);
    }
  }

  /** 每帧：宿主可能是液体（fillLevel 变化）或会变形的低模体 → 接头必须跟着重新贴合 */
  updateAttachments() {
    const list = this.byType.get('attachment');
    if (!list || !list.length) return;
    for (const rec of list) this.updateAttachment(rec);
  }

  /* ---------- 围边泡沫 edgefoam ---------- */
  /** 物体世界包围盒（8 角点，兼容旋转 / 父级编组） */
  worldBoxOf(rec, out) {
    const mesh = rec.mesh;
    if (!mesh || mesh.isGroup) return out.makeEmpty();
    out.makeEmpty();
    // 镜像变体：包围盒要给玩法空间（回放运镜 / AO 都用原空间坐标）
    const pm = playMatrix(mesh, this.mirror, _playM);
    for (let i = 0; i < 8; i++) {
      _tmpV.set((i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5).applyMatrix4(pm);
      out.expandByPoint(_tmpV);
    }
    return out;
  }

  /**
   * 刷新液体的围边泡沫：
   * ① 水面外沿 —— 靠近液面 + 靠近水平轮廓边缘（在液体自身几何上渲染，贴合任意形状）
   * ② 水中岛屿 —— 与液面相交的实体四周的白边（按世界坐标画圆环）
   */
  updateFoam(rec) {
    const o = rec.o;
    if (!rec.liquid || !rec.mesh) return;
    const mesh = rec.mesh;
    const opacity = clamp(Number(o.foamOpacity ?? 0.85), 0, 1);
    const on = o.edgeFoam !== false && opacity > 0.004 && rec.visible && o.visible !== false;
    if (!on) { this.clearFoam(rec); return; }
    const band = Math.max(0.4, Number(o.foamWidth ?? 4.5));
    this.root.updateMatrixWorld(true);

    // 泡沫网格复用液体的几何与变换 → 球体 / 多边形柱 / 异形网格都不会错位
    let created = false;
    if (!rec.foamMesh || rec.foamMesh.geometry !== mesh.geometry) {
      this.clearFoam(rec);
      const fm = new THREE.Mesh(mesh.geometry, createFoamMaterial(o.lightInfluence));
      fm.renderOrder = 5;              // 液体(4)之上
      fm.frustumCulled = false;
      fm.castShadow = false;
      fm.receiveShadow = false;
      fm.userData.helper = true;       // 编辑器拾取时忽略
      fm.userData.objectId = rec.id;
      rec.foamMesh = fm;
      (mesh.parent || this.root).add(fm);
      created = true;
    }
    const fm = rec.foamMesh;
    fm.position.copy(mesh.position);
    fm.quaternion.copy(mesh.quaternion);
    fm.scale.copy(mesh.scale);
    // 平顶形状：泡沫网格沿自身 Y 轴向上多出 FOAM_SPILL stud（顶盖由着色器压回真实液面，
    // 多出来的那截只留在侧壁上），用于在液面之上沿岸边物体再渐隐一圈
    const upStud = FOAM_FLAT_TOP.has(o.shape) ? FOAM_SPILL : 0;
    if (upStud > 0) {
      fm.scale.y = mesh.scale.y + FOAM_SPILL;
      fm.position.add(new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion).multiplyScalar(FOAM_SPILL * 0.5));
    }
    fm.visible = true;
    fm.updateMatrixWorld(true);

    const ls = new THREE.Vector3().setFromMatrixScale(fm.matrixWorld);
    const u = fm.material.uniforms;
    u.uUpStud.value = upStud;
    u.uFlatTop.value = upStud > 0 ? 1 : 0;
    u.uBandStud.value = band;
    u.uColor.value.set(o.foamColor || '#ffffff');
    u.uOpacity.value = opacity;
    u.uLightInf.value = clamp(Number(o.lightInfluence ?? 1), 0, 1);
    u.uScale.value.set(Math.abs(ls.x), Math.abs(ls.y), Math.abs(ls.z));
    u.uShape.value = foamShapeCode(o.shape || 'block');
    u.uSides.value = Number(o.sides) || 6;

    // 渲染 Worker 模式：新建的泡沫网格走增量同步（位姿已在上面设好）；
    // 既有网格走热通道（位姿）+ 材质 uniform 一次性同步（进程内为空实现）
    if (created) { if (this.onAdd) this.onAdd(fm); }
    else if (this.onHot) this.onHot(fm);
    if (this.onMaterial) this.onMaterial(fm.material);

    // ② 水面与其它物体的交线不再靠枚举岛屿（对球 / 多边形柱 / 导入模型都会错位）：
    //    改用深度差在着色器里判定（见 renderFoamDepth），任意形状相交都能正确起沫。
  }

  /* ---------- 深度差泡沫：半分辨率深度预渲染 ----------
     把除水体/泡沫以外的场景渲进一张深度图，泡沫着色器比较
     “该像素处的场景深度”与“水面自身深度”，差值小 = 水面紧贴其它物体
     = 岸边，于是在那里生成泡沫。 */
  renderFoamDepth(renderer, camera) {
    if (!renderer || !camera || !this.scene) return;
    const liquids = this.objectsOf('liquid');
    let any = false;
    for (const rec of liquids) {
      if (!rec.visible || !rec.o || rec.o.visible === false) continue;
      // 围边泡沫需要它做“深度差”判定；能见深度 / 平台过渡深度需要它做判定
      if (rec.foamMesh && rec.foamMesh.visible) { any = true; break; }
      if (Number(rec.o.visibilityDepth) > 0.001) { any = true; break; }
      if (Number(rec.o.platformDepth ?? 4) > 0.001) { any = true; break; }
    }
    if (!any) { FOAM_DEPTH.on.value = 0; return; }
    const buf = renderer.getDrawingBufferSize(_tmpV2);
    const w = Math.max(2, Math.floor(buf.x * 0.5));
    const h = Math.max(2, Math.floor(buf.y * 0.5));
    if (!this._foamRT || this._foamRT.width !== w || this._foamRT.height !== h) {
      if (this._foamRT) this._foamRT.dispose();
      const dt = new THREE.DepthTexture(w, h);
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      const rt = new THREE.WebGLRenderTarget(w, h, {
        depthTexture: dt, stencilBuffer: false, depthBuffer: true,
      });
      rt.texture.minFilter = THREE.NearestFilter;
      rt.texture.magFilter = THREE.NearestFilter;
      this._foamRT = rt;
    }
    if (!this._depthOnlyMat) {
      this._depthOnlyMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    }
    // 水体与泡沫自身不进深度图（只保留它们后面的场景）；
    // 半透明物体 / 粒子 / 线条也跳过：它们不是实心边界，会激出假泡沫
    const hidden = [];
    for (const rec of liquids) {
      if (rec.mesh && rec.mesh.visible) { rec.mesh.visible = false; hidden.push(rec.mesh); }
      if (rec.surfaceLine && rec.surfaceLine.visible) { rec.surfaceLine.visible = false; hidden.push(rec.surfaceLine); }
      if (rec.foamMesh && rec.foamMesh.visible) { rec.foamMesh.visible = false; hidden.push(rec.foamMesh); }
    }
    this.root.traverse((c) => {
      if (!c.visible) return;
      if (c.isMesh) {
        const m = c.material;
        if (m && (m.transparent || m.colorWrite === false)) { c.visible = false; hidden.push(c); }
      } else if (c.isPoints || c.isLine || c.isSprite) {
        c.visible = false; hidden.push(c);
      }
    });
    const prevOverride = this.scene.overrideMaterial;
    const prevBg = this.scene.background;
    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    // 只保留关卡本体：编辑器 gizmo / 网格 / 粒子都在场景根上，不该在水面上激出泡沫
    const hiddenKids = [];
    for (const c of this.scene.children) {
      if (c !== this.root && c.visible) { c.visible = false; hiddenKids.push(c); }
    }
    this.scene.overrideMaterial = this._depthOnlyMat;
    this.scene.background = null;
    renderer.autoClear = true;
    // 预渲染用不到光照：关掉阴影图更新，别让阴影在同一帧里渲染两遍
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this._foamRT);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.autoClear = prevAutoClear;
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBg;
    for (const c of hiddenKids) c.visible = true;
    for (const m of hidden) m.visible = true;

    FOAM_DEPTH.scene.value = this._foamRT.depthTexture;
    FOAM_DEPTH.res.value.set(buf.x, buf.y);   // 归一化屏幕坐标：与深度图分辨率无关
    FOAM_DEPTH.near.value = camera.near;
    FOAM_DEPTH.far.value = camera.far;
    FOAM_DEPTH.on.value = 1;
  }

  clearFoam(rec) {
    const fm = rec.foamMesh;
    if (fm) {
      if (this.onRemove) this.onRemove(fm);   // 渲染 Worker 模式：增量移除泡沫网格
      if (fm.parent) fm.parent.remove(fm);
      if (fm.material) fm.material.dispose();   // 几何是液体共享的，不能释放
    }
    rec.foamMesh = null;
  }

  /* ---------- 灯光 ---------- */
  makeLight(rec, parent) {
    const o = rec.o;
    const color = new THREE.Color(o.color || '#fff3c4');
    let l;
    const t = o.lightType || 'point';
    if (t === 'directional') l = new THREE.DirectionalLight(color, o.intensity ?? 1.6);
    else if (t === 'spot') l = new THREE.SpotLight(color, o.intensity ?? 1.6, o.distance || 0, deg2rad(o.angle || 38), o.penumbra ?? 0.4, 1.4);
    else l = new THREE.PointLight(color, o.intensity ?? 1.6, o.distance || 0, 1.6);
    l.position.set(...o.position);
    l.castShadow = !!o.castShadow && settings.get('video.shadows', true);
    if (l.castShadow) {
      const size = Number(o.shadowSize) || 1024;
      l.shadow.mapSize.set(size, size);
      // 与太阳光同一套规则（见 updateSunShadow）：偏移会把接触阴影从方块接缝处抬走造成漏光，
      // 必须按阴影相机的世界深度跨度归零，不能写死一个常数（原 -0.0012 在 500 跨度的相机里
      // 等于抬开 0.6 stud）。
      const lspan = Math.max(1, l.shadow.camera.far - l.shadow.camera.near);
      l.shadow.normalBias = 0;
      l.shadow.bias = -0.004 / lspan;
      l.shadow.radius = 0;
    }
    rec.light = l;
    parent.add(l);
    if (t === 'directional' || t === 'spot') {
      const target = new THREE.Object3D();
      rec.lightTarget = target;
      parent.add(target);
      l.target = target;
      this.updateLightDir(rec);
    }
    rec.mesh = l;
    if (this.editor && o.helper !== false) this.addLightHelper(rec, parent);
  }

  updateLightDir(rec) {
    const o = rec.o;
    const r = o.rotation || [0, 0, 0];
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(deg2rad(r[0]), deg2rad(r[1]), deg2rad(r[2])));
    if (rec.lightTarget) {
      const p = worldPosition(this.level, o);
      rec.lightTarget.position.set(p[0] + dir.x * 200, p[1] + dir.y * 200, p[2] + dir.z * 200);
      rec.lightTarget.updateMatrixWorld();
    }
    if (rec.light && rec.light.isSpotLight) {
      rec.light.target = rec.lightTarget || rec.light.target;
    }
  }

  setupLight(rec) {
    const o = rec.o;
    const l = rec.light;
    if (!l) return;
    rec.light.visible = rec.visible;
    if (l.shadow && l.castShadow) {
      l.shadow.camera.near = 0.6;
      l.shadow.camera.far = Math.max(60, (o.distance || 120) * 1.4);
      if (l.shadow.camera.isPerspectiveCamera) l.shadow.camera.fov = Math.max(30, (o.angle || 38) * 2.4);
      l.shadow.camera.updateProjectionMatrix();
    }
  }

  addLightHelper(rec, parent) {
    const o = rec.o;
    const color = new THREE.Color(o.color || '#fff3c4');
    const g = new THREE.Group();
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.7, (o.scale?.[0] || 3) * 0.16), 10, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
    );
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.16, 6, 18),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 })
    );
    ring.rotation.x = Math.PI / 2;
    g.add(bulb, ring);
    g.position.set(...o.position);
    g.userData.objectId = o.id;
    g.userData.helper = true;
    rec.helpers.push(g, bulb, ring);
    parent.add(g);
    rec.helperGroup = g;
  }

  /* ---------- 滑索 ---------- */
  makeZipline(rec, parent) {
    const o = rec.o;
    // 路径解析（支持「引用折曲线对象」）
    const path = makePath(o, this.level);
    const { curve, div, smooth, total, lengths, pointsRaw, segModes } = path;
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(smooth, false, 'catmullrom', 0.2), div, o.ropeRadius || 0.18, 5, false);
    const mat = getMaterial({ color: o.color || '#ff7fd0', metalness: 0.6, roughness: 0.35, emissive: o.color || '#ff7fd0', emissiveIntensity: 0.25 });
    const rope = new THREE.Mesh(geo, mat);
    rope.userData.objectId = o.id;
    rope.castShadow = false;
    rope.receiveShadow = false;
    parent.add(rope);
    rec.mesh = rope;
    rec.meshes = [rope];
    rec.zip = {
      curve, total, lengths, points: smooth,
      segModes, pointsRaw,
      ...this.pathGetter(rec, curve),
      getAt(d, out) { return curve.getPointAt(clamp(d / total, 0, 1), out); },
    };
    this.finishPath(rec, pointsRaw);
    // 节点手柄由编辑器 PathNodeEditor 提供（可拖拽），这里不再生成静态标记
  }

  /* ---------- 折曲线（纯几何管状路径，可被滑索 / 管道引用） ---------- */
  makeCurve(rec, parent) {
    const o = rec.o;
    const path = makePath(o, this.level);
    const { curve, div } = path;
    const seg = clamp(Math.round(Number(o.tubeSeg) || 8), 3, 16);
    const geo = new THREE.TubeGeometry(curve, div, Math.max(0.02, Number(o.radius) || 0.18), seg, false);
    const mat = getMaterial(pathLook({
      color: o.color || '#8fd6ff', metalness: o.metalness, roughness: o.roughness,
      emissive: o.emissive, emissiveIntensity: o.emissiveIntensity, transparency: o.transparency,
      smoothShade: o.smoothShade,
    }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.objectId = o.id;
    mesh.userData.ownGeometry = true;
    rec.ownGeometry = true;
    mesh.castShadow = o.castShadow === true;
    mesh.receiveShadow = false;
    parent.add(mesh);
    rec.mesh = mesh;
    rec.meshes = [mesh];
    // 与滑索同结构，供路径类逻辑直接复用
    rec.zip = {
      curve, total: path.total, lengths: path.lengths, points: path.smooth,
      segModes: path.segModes, pointsRaw: path.pointsRaw,
      ...this.pathGetter(rec, curve),
      getAt(d, out) { return curve.getPointAt(clamp(d / path.total, 0, 1), out); },
    };
    this.finishPath(rec, path.pointsRaw);
  }

  /* ---------- 管道（任意截面沿路径扫掠） ---------- */
  makePipe(rec, parent) {
    const o = rec.o;
    const { points, segModes, handles } = resolvePath(o, this.level);
    const curve = buildCurve(points, segModes, handles);
    const sampled = sampleCurve(curve, pathLength(points));
    const R = Math.max(0.05, Number(o.sectionRadius) || 1);
    // 截面可以是**多条互不相交的子轮廓**（非连续截面）→ 每条各扫一条管再合并
    const profs = sectionProfiles(o).map((c) => c.map(([x, y]) => [x * R, y * R]));
    const div = clamp(Math.round(curve.getLength() * 3), 24, 400);
    const sweepOpts = {
      capEnds: o.capEnds !== false,
      hollow: !!o.hollow,
      wallThickness: o.wallThickness,
    };
    const geo = sweepProfiles(curve, profs, div, sweepOpts);
    const mat = getMaterial(pathLook(o), this.mapOverride(rec), { studUV: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.objectId = o.id;
    mesh.userData.ownGeometry = true;
    rec.ownGeometry = true;
    mesh.castShadow = o.castShadow !== false;
    mesh.receiveShadow = true;
    mesh.visible = rec.visible && !(LOGIC_ONLY.has(o.type) && !this.editor);
    parent.add(mesh);
    rec.mesh = mesh;
    rec.meshes = [mesh];
    // 碰撞用粗网格的扫掠参数（见 makeGeneratedBody）：
    // 渲染网格保持精细，只有 trimesh 碰撞体按 PIPE_COLLISION_STEP 重新扫掠一份
    rec.pipeSweep = { curve, profs, opts: sweepOpts };
    rec.zip = {
      curve, total: sampled.total, lengths: sampled.lengths, points: sampled.smooth,
      segModes, pointsRaw: points,
      ...this.pathGetter(rec, curve),
      getAt(d, out) { return curve.getPointAt(clamp(d / sampled.total, 0, 1), out); },
    };
    this.finishPath(rec, points);
  }

  /* ---------- 曲线墙（沿路径竖直扫掠的墙板：默认始终竖直，可设墙高 / 墙厚 / 倾角） ---------- */
  makeCurveWall(rec, parent) {
    const o = rec.o;
    const { points, segModes, handles } = resolvePath(o, this.level);
    const curve = buildCurve(points, segModes, handles);
    const sampled = sampleCurve(curve, pathLength(points));
    const H = Math.max(0.1, Number(o.wallHeight) || 6);
    const T = Math.max(0.04, Number(o.wallThickness) || 0.6);
    // 截面（逆时针）：X = 墙厚方向（水平、垂直于路径），Y = 墙高方向（默认竖直）
    // 基线落在路径上 —— 节点拖到地面，墙就从地面立起来
    const prof = [[-T / 2, 0], [T / 2, 0], [T / 2, H], [-T / 2, H]];
    // 墙板是「很薄很高」的直纹面，轮廓（剪影）完全由这串扫掠折线决定：
    // 细分不足时，放大后墙边会露出一段段折角，看起来就是锯齿。
    // 按弧长取 ~0.1 stud 一段，并把上限放宽以照顾超长墙。
    const div = clamp(Math.round(curve.getLength() * 10), 24, 4000);
    // upright：截面不随路径扭转（墙始终竖直）；tilt：绕路径切线的倾角
    const sweepOpts = { capEnds: true, upright: true, tilt: deg2rad(Number(o.wallTilt) || 0) };
    const geo = sweepGeometry(curve, prof, div, sweepOpts);
    const mat = getMaterial(pathLook(o), this.mapOverride(rec), { studUV: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.objectId = o.id;
    mesh.userData.ownGeometry = true;
    rec.ownGeometry = true;
    mesh.castShadow = o.castShadow !== false;
    mesh.receiveShadow = true;
    mesh.visible = rec.visible && !(LOGIC_ONLY.has(o.type) && !this.editor);
    parent.add(mesh);
    rec.mesh = mesh;
    rec.meshes = [mesh];
    // 与管道同构：trimesh 碰撞按同一套扫掠参数重做一份粗网格（见 makeGeneratedBody）
    rec.pipeSweep = { curve, profs: [prof], opts: sweepOpts };
    rec.zip = {
      curve, total: sampled.total, lengths: sampled.lengths, points: sampled.smooth,
      segModes, pointsRaw: points,
      ...this.pathGetter(rec, curve),
      getAt(d, out) { return curve.getPointAt(clamp(d / sampled.total, 0, 1), out); },
    };
    this.finishPath(rec, points);
  }

  /** 路径型对象收尾：确定旋转 / 缩放枢轴（路径质心）并套用对象变换 */
  finishPath(rec, points) {
    const o = rec.o;
    const c = new THREE.Vector3();
    const n = (points && points.length) || 0;
    if (n) { for (const p of points) c.add(p); c.multiplyScalar(1 / n); }
    // 无旋转 / 无缩放时枢轴跟随质心（此时取值不影响结果，gizmo 手柄也更直观）；
    // 有非平凡变换时用固化的枢轴，否则「编辑节点 → 质心变 → 整体变换变 → 整条路径滑移」
    const pivot = pathXformTrivial(o) ? c : (pathPivot(o) || c);
    rec.pathCenter = pivot;
    o.pivot = [pivot.x, pivot.y, pivot.z];
    this.applyPathTransform(rec);
  }

  /** 路径型对象的整体变换：几何是绝对节点坐标，position 平移、rotation / scale 绕路径中心 */
  applyPathTransform(rec) {
    const o = rec.o;
    const m = rec.mesh;
    if (!o || !m) return;
    const C = rec.pathCenter || new THREE.Vector3();
    // 变换刚变成非平凡（有旋转 / 缩放）时立刻固化当前枢轴：之后编辑节点不再带动整体变换
    if (!pathXformTrivial(o) && !pathPivot(o)) o.pivot = [C.x, C.y, C.z];
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      deg2rad(o.rotation?.[0] || 0), deg2rad(o.rotation?.[1] || 0), deg2rad(o.rotation?.[2] || 0)));
    const s = new THREE.Vector3(
      Math.max(1e-4, Math.abs(o.scale?.[0] ?? 1)),
      Math.max(1e-4, Math.abs(o.scale?.[1] ?? 1)),
      Math.max(1e-4, Math.abs(o.scale?.[2] ?? 1)));
    m.quaternion.copy(q);
    m.scale.copy(s);
    // 世界 = T(offset) · T(C) · R · S · T(-C)：绕 C 旋转缩放，再叠加 position 平移
    const cs = C.clone().multiply(s).applyQuaternion(q);
    const off = Array.isArray(o.position) ? o.position : [0, 0, 0];
    m.position.set(
      (Number(off[0]) || 0) + C.x - cs.x,
      (Number(off[1]) || 0) + C.y - cs.y,
      (Number(off[2]) || 0) + C.z - cs.z);
  }

  /** 路径取点 / 切线（归一化参数 t）：把对象自身的整体变换（mesh 的 T·R·S）一并烘焙进去，
   *  这样移动 / 旋转 / 缩放滑索、折曲线后，乘坐点、脱离方向、沿曲线分布都会跟着走 */
  pathGetter(rec, curve) {
    // 镜像变体：取点要回到玩法空间，否则滑索会把玩家送到镜像后的位置
    const bake = (v) => {
      const mesh = rec.mesh;
      if (!mesh) return v;
      mesh.updateWorldMatrix(true, false);
      return v.applyMatrix4(playMatrix(mesh, this.mirror, _playM));
    };
    const bakeDir = (v) => {
      const mesh = rec.mesh;
      if (!mesh) return v;
      mesh.updateWorldMatrix(true, false);
      return v.transformDirection(playMatrix(mesh, this.mirror, _playM));
    };
    return {
      pointAt(t, out) { return bake(curve.getPointAt(clamp(t, 0, 1), out)); },
      tangentAt(t, out) { return bakeDir(curve.getTangentAt(clamp(t, 0, 1), out)); },
    };
  }

  /* ---------- 网格修改器（引用已有对象，按递变量 / 曲线重复复制） ---------- */
  makeMeshRef(rec, parent) {
    const o = rec.o;
    const grp = new THREE.Group();
    grp.name = o.id;
    grp.userData.objectId = o.id;
    grp.position.set(...(o.position || [0, 0, 0]));
    grp.rotation.set(deg2rad(o.rotation?.[0] || 0), deg2rad(o.rotation?.[1] || 0), deg2rad(o.rotation?.[2] || 0));
    grp.scale.set(...(o.scale || [1, 1, 1]));
    grp.visible = rec.visible;
    parent.add(grp);
    rec.mesh = grp;

    const src = o.sourceRef ? this.objects.get(o.sourceRef) : null;
    const base = src ? (src.mesh || src.group) : null;
    if (!base) {
      // 源未就绪：编辑器里给个占位提示，游戏内什么都不渲染
      if (this.editor) {
        const h = new THREE.Mesh(
          new THREE.BoxGeometry(4, 4, 4),
          new THREE.MeshBasicMaterial({ color: '#ff6b6b', wireframe: true }));
        h.userData.helper = true;
        grp.add(h);
        rec.helpers.push(h);
      }
      return;
    }

    const count = clamp(Math.round(Number(o.count) || 1), 1, 200);
    const offStep = o.offsetStep || [6, 0, 0];
    const rotStep = o.rotStep || [0, 0, 0];
    const scaleStep = o.scaleStep || [1, 1, 1];
    const byCurve = o.distMode === 'curve';
    const csrc = byCurve && o.curveRef ? this.objects.get(o.curveRef) : null;
    const cpath = (csrc && csrc.zip) ? csrc.zip : null;

    for (let i = 0; i < count; i++) {
      const c = base.clone(true);
      c.traverse((x) => {
        x.userData.objectId = o.id;
        x.userData.ownGeometry = false;   // 与源共享几何，销毁时不能 dispose
      });
      // 剔除源对象自带的辅助体
      const drop = [];
      c.traverse((x) => { if (x.userData.helper) drop.push(x); });
      for (const x of drop) if (x.parent) x.parent.remove(x);

      if (cpath && cpath.total) {
        const t = count > 1 ? i / (count - 1) : 0;
        const p = cpath.pointAt(t, new THREE.Vector3());
        c.position.copy(p);
        if (o.alignCurve !== false) {
          const tan = cpath.tangentAt(t, new THREE.Vector3()).normalize();
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tan);
          const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            deg2rad(rotStep[0] || 0) * i, deg2rad(rotStep[1] || 0) * i, deg2rad(rotStep[2] || 0) * i));
          c.quaternion.copy(q).multiply(rot);
        } else {
          c.rotation.set(deg2rad(rotStep[0] || 0) * i, deg2rad(rotStep[1] || 0) * i, deg2rad(rotStep[2] || 0) * i);
        }
      } else {
        c.position.set((offStep[0] || 0) * i, (offStep[1] || 0) * i, (offStep[2] || 0) * i);
        c.rotation.set(deg2rad(rotStep[0] || 0) * i, deg2rad(rotStep[1] || 0) * i, deg2rad(rotStep[2] || 0) * i);
        const sx = Math.pow(Math.max(0.02, Math.abs(scaleStep[0] || 1)), i);
        const sy = Math.pow(Math.max(0.02, Math.abs(scaleStep[1] || 1)), i);
        const sz = Math.pow(Math.max(0.02, Math.abs(scaleStep[2] || 1)), i);
        c.scale.set(sx, sy, sz);
      }
      c.visible = true;
      grp.add(c);
    }
    // 记下源的当前状态，避免下一拍 syncMeshRefs 立刻又重建一次
    base.updateWorldMatrix(true, false);
    rec._srcSig = { uuid: base.uuid, mat: (base.material && base.material.uuid) || '', m: Array.from(base.matrixWorld.elements) };
  }

  /** 源对象变化时自动重建修改器（限频，见 update） */
  syncMeshRefs(dt) {
    const list = this.byType.get('meshref');
    if (!list || !list.length) return;
    this._meshRefTimer = (this._meshRefTimer || 0) + dt;
    if (this._meshRefTimer < 0.15) return;
    this._meshRefTimer = 0;
    for (const rec of list) {
      const o = rec.o;
      const src = o.sourceRef ? this.objects.get(o.sourceRef) : null;
      const node = src ? (src.mesh || src.group) : null;
      const s = rec._srcSig;
      if (!node) {
        // 源不存在：从「有源」变成「无源」时重建一次，之后保持
        if (s) { rec._srcSig = null; try { this.rebuild(rec); } catch (e) { /* ignore */ } }
        continue;
      }
      node.updateWorldMatrix(true, false);
      const m = node.matrixWorld.elements;
      // 材质换代（改颜色 / 贴图 / 自发光…）也要跟着换，否则副本会停在旧材质
      const mu = (node.material && node.material.uuid) || '';
      const changed = !s || s.uuid !== node.uuid || s.mat !== mu || !s.m || s.m.some((v, k) => v !== m[k]);
      if (!changed) continue;
      const sig = { uuid: node.uuid, mat: mu, m: Array.from(m) };
      rec._srcSig = sig;
      try {
        const fresh = this.rebuild(rec);
        if (fresh) fresh._srcSig = sig;   // 重建后立刻打标，避免下一拍再次重建
      } catch (e) { /* ignore */ }
    }
  }

  /* ============================================================
     NPC 角色
     一个 NPC = root Group（位置 / 旋转 / 缩放）+ 身体。身体两种来源：
       - 内置预设：avatar.js 的程序化 R6 部件（运行时由 NpcSystem 摆臂摆腿）
       - 自定义模型：导入的 .glb/.gltf，交给 PlayerAvatar 异步加载（失败则保留 R6 兜底）
     行为 / 对话由游戏侧 NpcSystem 驱动，这里只负责「长什么样」。
     ============================================================ */
  makeNpc(rec, parent) {
    const o = rec.o;
    const root = new THREE.Group();
    root.name = 'npc:' + o.id;
    root.userData.objectId = o.id;
    root.userData.type = 'npc';
    root.position.set(...(o.position || [0, 0, 0]));
    const r = o.rotation || [0, 0, 0];
    root.rotation.set(deg2rad(r[0] || 0), deg2rad(r[1] || 0), deg2rad(r[2] || 0));
    root.scale.set(...(o.scale || [1, 1, 1]));
    root.visible = rec.visible;
    parent.add(root);
    rec.mesh = root;
    rec.npcR6 = null;        // R6 部件引用（含枢轴），程序化姿态用
    rec.npcAvatar = null;    // PlayerAvatar（自定义模型用，含 mixer）
    rec._npcSig = '';
    this.buildNpcBody(rec, root);
  }

  /** 外观签名：预设 / 衣服色 / 自定义模型资源，任一变化才重建身体 */
  npcSignature(o) {
    return [(o.preset || 'classic'), (o.bodyColor || ''), (o.preset === 'custom' ? (o.assetId || '') : '')].join('|');
  }

  buildNpcBody(rec, root) {
    const o = rec.o;
    // 先卸掉旧身体（导入模型实例 + 皮肤 / R6 几何）
    if (rec.npcAvatar) { rec.npcAvatar.dispose(); rec.npcAvatar = null; }
    for (const ch of root.children.slice()) { this.disposeNpcNode(ch); root.remove(ch); }
    rec.npcR6 = null;
    rec.npcR6Group = null;
    rec._npcSig = this.npcSignature(o);

    // 始终先摆内置 R6：既是「非自定义」的最终形象，也是自定义模型加载期间的占位 / 失败兜底
    this._buildNpcR6(rec, root);
    if (o.preset !== 'custom' || !o.assetId) return;

    const av = new PlayerAvatar(root, {});
    rec.npcAvatar = av;
    av.apply({ assetId: o.assetId, scale: 1 }).then((ok) => {
      if (rec.disposed || rec.npcAvatar !== av) return;
      // 模型就位 → 收起 R6 占位；失败（ok=false）则保持 R6 兜底
      if (ok && rec.npcR6Group) rec.npcR6Group.visible = false;
    }).catch(() => { /* 保持 R6 兜底 */ });
  }

  _buildNpcR6(rec, root) {
    const o = rec.o;
    const def = presetDef(o.preset) || presetDef('classic');
    // 衣服颜色只覆盖躯干；头部 / 四肢沿用预设配色
    const d = Object.assign({}, def, {
      colors: Object.assign({}, def.colors, { torso: o.bodyColor || def.colors.torso }),
    });
    const built = buildR6Parts(d);
    const g = new THREE.Group();
    g.name = 'npc-r6';
    g.add(built.root);
    g.traverse((x) => {
      if (!x.isMesh) return;
      x.userData.npcGeo = true;             // 几何 / 材质归 NPC 所有，销毁时释放
      x.castShadow = !!o.castShadow;
      x.receiveShadow = true;
    });
    root.add(g);
    rec.npcR6 = built;                      // { root, torso, head, armL, armR, legL, legR, parts }
    rec.npcR6Group = g;
  }

  /** 释放 NPC 子节点里自有的几何 / 材质（导入模型的释放交给 PlayerAvatar） */
  disposeNpcNode(node) {
    node.traverse((x) => {
      if (!x.isMesh || !x.userData.npcGeo) return;
      if (x.geometry) x.geometry.dispose();
      const m = x.material;
      if (Array.isArray(m)) m.forEach((k) => k && k.dispose());
      else if (m) m.dispose();
    });
  }

  /** NPC 外观增量同步：可见性 / 阴影 + 外观签名变化时才重建身体 */
  syncNpc(rec) {
    if (rec.disposed) return;
    const root = rec.mesh;
    if (!root) return;
    root.visible = rec.visible;
    if (this.npcSignature(rec.o) !== rec._npcSig) { this.buildNpcBody(rec, root); return; }
    // 仅有阴影开关变化时不重建身体，直接翻转标记
    const cast = !!rec.o.castShadow;
    root.traverse((x) => { if (x.isMesh) x.castShadow = cast; });
  }

  /* ---------- 物理体 ---------- */
  makeBody(rec) {
    const o = rec.o;
    const def = rec.def;
    const kind = def.physicsShape ? def.physicsShape(o) : 'box';
    if (kind === 'none') return null;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2])));
    const quat = new CANNON.Quaternion(q.x, q.y, q.z, q.w);
    const wp = worldPosition(this.level, o);
    const anchored = o.anchored !== false || o.anchored === undefined;
    const mass = anchored ? 0 : Math.max(0.05, Number(o.mass) || 1);
    const body = new CANNON.Body({
      mass,
      material: this.mats[o.material] || this.mats.default,
      type: anchored ? CANNON.Body.STATIC : CANNON.Body.DYNAMIC,
      linearDamping: 0.02,
      angularDamping: 0.12,
      allowSleep: !anchored,
      sleepSpeedLimit: 0.6,
      sleepTimeLimit: 0.6,
    });
    body.userData = { objectId: o.id, type: o.type };
    const s = (o.scale || [1, 1, 1]).map((v) => Math.max(0.01, Math.abs(v)));

    if (kind === 'sphere') {
      body.addShape(new CANNON.Sphere(Math.max(s[0], s[1], s[2]) * 0.5));
    } else if (kind === 'cylinder') {
      const r = (s[0] + s[2]) * 0.25;
      const segs = o.shape === 'prism' ? clamp(Math.round(o.sides) || 6, 3, 16) : 10;
      body.addShape(new CANNON.Cylinder(r, r, s[1], segs));
    } else if (kind === 'trimesh') {
      const geo = rec.meshes && rec.meshes[0] && rec.meshes[0].isMesh ? rec.meshes[0].geometry : null;
      // 顶点少于一个三角形（空图形 / 退化几何）时退回盒体，避免 CANNON.Trimesh 收到空数组
      if (geo && geo.attributes.position && geo.attributes.position.count >= 3) {
        const pos = geo.attributes.position.array;
        const verts = new Float32Array(pos.length);
        for (let i = 0; i < pos.length; i += 3) {
          verts[i] = pos[i] * s[0];
          verts[i + 1] = pos[i + 1] * s[1];
          verts[i + 2] = pos[i + 2] * s[2];
        }
        const idx = geo.index ? Array.from(geo.index.array)
          : Array.from({ length: geo.attributes.position.count }, (_, i) => i);
        body.addShape(new CANNON.Trimesh(verts, idx));
      } else {
        body.addShape(new CANNON.Box(new CANNON.Vec3(s[0] / 2, s[1] / 2, s[2] / 2)));
      }
    } else {
      body.addShape(new CANNON.Box(new CANNON.Vec3(s[0] / 2, s[1] / 2, s[2] / 2)));
    }
    body.position.set(wp[0], wp[1], wp[2]);
    body.quaternion.copy(quat);
    if (o.parent) {
      // 父级旋转需叠加，直接用品格世界矩阵更准确。
      // 注意 rec.mesh.matrix 含缩放，必须 decompose 掉缩放只取旋转：
      // setFromRotationMatrix 要求纯旋转矩阵，喂带缩放的矩阵会得到非单位四元数，
      // cannon 会按 |q|² 把碰撞体放大（编组后贴住就飞起来 / 能穿过去的元凶）。
      const parentNode = this.groupNodes.get(o.parent);
      if (parentNode) {
        parentNode.updateMatrixWorld(true);
        const m = new THREE.Matrix4().multiplyMatrices(playMatrix(parentNode, this.mirror, _playM), rec.mesh.matrix);
        const pos = new THREE.Vector3();
        const rot = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        m.decompose(pos, rot, scl);
        body.position.set(pos.x, pos.y, pos.z);
        body.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      }
    }
    // 静态盒体合批：并入空间分块的复合刚体（对象本身不再持有独立 body）
    if (this._mergeStaticBody(rec, body)) return null;
    this.world.addBody(body);
    rec.body = body;
    return body;
  }

  /* ---------- 静态刚体合批 ---------- */
  /** 该对象能否并入静态合批：只在游玩模式、只会并「永不改写的普通静态盒体」 */
  _mergeAllowed(rec) {
    if (!this._staticBodyMerge) return false;
    const o = rec.o;
    if (!o || !MERGE_BODY_TYPES.has(o.type)) return false;
    if (o.parent) return false;                        // 保守：子对象不合并（父级变换会连带改世界位置）
    if (o.tag === 'breakable') return false;           // 运行时可被工具破坏 → 需要独立刚体
    if (this._managedIds && this._managedIds.has(o.id)) return false;   // 事件 / 动画会改写它
    return true;
  }

  /** 把一个静态盒体并入所在分块的复合刚体；成功返回 true（调用方就不再 addBody） */
  _mergeStaticBody(rec, body) {
    if (!this._mergeAllowed(rec)) return false;
    if (body.type !== CANNON.Body.STATIC) return false;
    const shapes = body.shapes;
    if (shapes.length !== 1) return false;
    const shape = shapes[0];
    if (!shape || shape.halfExtents === undefined) return false;   // 只合并盒体（cannon 的 Box 有 halfExtents）
    const p = body.position, q = body.quaternion;
    const cx = Math.floor(p.x / BODY_CHUNK), cy = Math.floor(p.y / BODY_CHUNK), cz = Math.floor(p.z / BODY_CHUNK);
    const key = `${rec.o.material || 'default'}|${cx},${cy},${cz}`;
    let chunk = this._bodyChunks.get(key);
    if (!chunk) {
      chunk = new CANNON.Body({ mass: 0, material: body.material, type: CANNON.Body.STATIC });
      chunk.userData = { chunk: true, objectId: '', type: '' };
      this._bodyChunks.set(key, chunk);
      this.world.addBody(chunk);
    }
    // 命中反查：射线打在复合体上，靠 shape.userData 还原是哪个对象（见 _rayHit）
    shape.userData = { objectId: rec.o.id, type: rec.o.type };
    chunk.addShape(shape, new CANNON.Vec3(p.x, p.y, p.z), new CANNON.Quaternion(q.x, q.y, q.z, q.w));
    // 原独立刚体不再进世界：清空形状即可（对象侧改用体记录）
    shapes.length = 0;
    body.shapeOffsets.length = 0;
    body.shapeOrientations.length = 0;
    body.world = null;
    rec.body = null;
    rec.bodyMerged = true;
    rec.mergedChunk = chunk;
    rec.mergedShape = shape;
    return true;
  }

  /** 合批刚体统一算一次包围盒：SAP 宽相与射线 AABB 查询都依赖 body.aabb */
  finalizeBodyChunks() {
    for (const chunk of this._bodyChunks.values()) {
      chunk.aabbNeedsUpdate = true;
      chunk.updateAABB();
    }
    if (this.world && this.world.broadphase) this.world.broadphase.dirty = true;
  }

  /** 释放对象占用的刚体：合批过的先从分块里摘掉盒形，其余从世界移除 */
  releaseBody(rec) {
    if (rec.mergedChunk && rec.mergedShape) {
      rec.mergedChunk.removeShape(rec.mergedShape);
      rec.mergedChunk.aabbNeedsUpdate = true;
      rec.mergedChunk.updateAABB();
      rec.mergedChunk = null;
      rec.mergedShape = null;
    }
    rec.bodyMerged = false;
    if (rec.body) {
      if (this.world && rec.body.world) this.world.removeBody(rec.body);
      rec.body = null;
    }
  }

  /* ---------- 生成式物理体（管道 / 网格修改器） ----------
   * 管道几何是沿路径扫掠出来的绝对坐标、修改器会复制出多份副本，
   * 用对象本体的 position / scale 套包围盒完全不匹配 → 碰撞形状必须逐个取自
   * 「生成出来的网格」的世界变换。
   * 体变换只取平移 + 旋转（root 的世界变换），缩放烘焙进形状顶点，
   * 这样运行时平移 / 旋转对象只需更新 body 变换，不用重建形状。 */
  makeGeneratedBody(rec) {
    const o = rec.o;
    const kind = rec.def && rec.def.physicsShape ? rec.def.physicsShape(o) : 'none';
    if (kind === 'none') return null;
    const root = rec.mesh;
    if (!root) return null;
    root.updateWorldMatrix(true, true);
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    rec._genScale = new THREE.Vector3();
    playMatrix(root, this.mirror, _playM).decompose(wp, wq, rec._genScale);
    const invBody = new THREE.Matrix4()
      .compose(wp, wq, new THREE.Vector3(1, 1, 1)).invert();

    const meshes = [];
    root.traverse((x) => {
      if (x.isMesh && !x.userData.helper && x.geometry && x.geometry.attributes && x.geometry.attributes.position) meshes.push(x);
    });
    if (!meshes.length) return null;

    const body = new CANNON.Body({ mass: 0, material: this.mats[o.material] || this.mats.default, type: CANNON.Body.STATIC });
    body.userData = { objectId: o.id, type: o.type };
    for (const m of meshes) {
      const local = new THREE.Matrix4().multiplyMatrices(invBody, playMatrix(m, this.mirror, _playM));
      if (kind === 'trimesh') {
        // 管道：碰撞体不用精细的渲染网格，按步长 0.5 stud 重新扫掠一份粗网格
        const sw = rec.pipeSweep;
        const coarse = sw ? sweepProfiles(sw.curve, sw.profs,
          Math.max(2, Math.round(sw.curve.getLength() / PIPE_COLLISION_STEP)), sw.opts) : null;
        const geo = coarse || m.geometry;
        const pos = geo.attributes.position.array;
        const verts = new Float32Array(pos.length);
        for (let i = 0; i < pos.length; i += 3) {
          _tmpV.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(local);
          verts[i] = _tmpV.x; verts[i + 1] = _tmpV.y; verts[i + 2] = _tmpV.z;
        }
        const idx = geo.index ? Array.from(geo.index.array)
          : Array.from({ length: geo.attributes.position.count }, (_, i) => i);
        body.addShape(new CANNON.Trimesh(verts, idx));
        if (coarse) coarse.dispose();
      } else {
        const geo = m.geometry;
        if (!geo.boundingBox) geo.computeBoundingBox();
        const c = new THREE.Vector3();
        const h = new THREE.Vector3();
        geo.boundingBox.getCenter(c);
        geo.boundingBox.getSize(h);
        h.multiplyScalar(0.5);
        const t = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        local.decompose(t, q, s);
        h.set(Math.abs(h.x * s.x), Math.abs(h.y * s.y), Math.abs(h.z * s.z));
        c.applyMatrix4(local);
        body.addShape(
          new CANNON.Box(new CANNON.Vec3(Math.max(0.02, h.x), Math.max(0.02, h.y), Math.max(0.02, h.z))),
          new CANNON.Vec3(c.x, c.y, c.z),
          new CANNON.Quaternion(q.x, q.y, q.z, q.w));
      }
    }
    if (!body.shapes.length) return null;
    body.position.set(wp.x, wp.y, wp.z);
    body.quaternion.set(wq.x, wq.y, wq.z, wq.w);
    this.world.addBody(body);
    rec.body = body;
    return body;
  }

  /** 生成式物理体的形状是按旧缩放烘焙的：缩放变化时整体重做 */
  rebuildGeneratedBody(rec) {
    this.releaseBody(rec);
    if (this.physics) this.makeGeneratedBody(rec);
  }

  /* ---------- 体积辅助体（编辑器） ---------- */
  addVolumeHelper(rec, parent, color) {
    const o = rec.o;
    const g = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, wireframe: false, depthWrite: false })
    );
    const e = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75 })
    );
    g.add(e);
    g.position.set(...o.position);
    g.rotation.set(deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2]));
    g.scale.set(...o.scale);
    g.userData.objectId = o.id;
    g.userData.helper = true;
    rec.helpers.push(g, e);
    parent.add(g);
    rec.helperGroup = g;
  }

  addEdgeHelper(rec, mesh) {
    const e = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: 0x3ad0a0, transparent: true, opacity: 0.6 })
    );
    // 与 mesh 同级挂载 → 不随父级变换，必须由 syncTransform 手动跟随
    e.scale.copy(mesh.scale).multiplyScalar(EDGE_HELPER_GROW);
    e.position.copy(mesh.position);
    e.rotation.copy(mesh.rotation);
    e.userData.objectId = rec.id;
    e.userData.helper = true;
    e.userData.followMesh = true;              // 标记：变换时要跟着 mesh 一起更新
    e.userData.helperGrow = EDGE_HELPER_GROW;  // 保持「略大一点」的比例
    rec.helpers.push(e);
    this.parentNode(rec.o.parent).add(e);
  }

  /* ---------- 环境（雾 / 天空 / 主光） ----------
     只改参数、不重建对象：重建会让阴影贴图重新分配，表现为“调一个滑块，
     太阳/阴影突然一跳”；同时太阳方向每次都按 azimuth / 昼夜时刻重算，
     调方位角/昼夜时刻要立刻生效（旧代码把方向缓存死了，改什么都动不了） */
  applyEnv() {
    const s = this.level.settings || {};
    if (!this.scene) return;
    /* 雾 */
    if (s.fog && s.fog.enabled !== false && settings.get('video.fog', true)) {
      const f = this.scene.fog;
      if (f && f.isFog) {
        f.color.set(s.fog.color || '#5b4f8a');
        f.near = s.fog.near ?? 90;
        f.far = s.fog.far ?? 760;
      } else {
        this.scene.fog = new THREE.Fog(s.fog.color || '#5b4f8a', s.fog.near ?? 90, s.fog.far ?? 760);
      }
    } else {
      this.scene.fog = null;
    }
    this.applySky();
    /* 环境光（半球光）：天光取天空色，地面反射压暗 */
    const ambColor = s.ambient?.color || '#b9a9ea';
    const ambInt = s.ambient?.intensity ?? 0.72;
    if (this.ambient && this.ambient.parent) {
      this.ambient.color.set(ambColor);
      this.ambient.intensity = ambInt;
    } else {
      this.ambient = new THREE.HemisphereLight(ambColor, '#2a2340', ambInt);
      this.root.add(this.ambient);
    }
    /* 主光（太阳 / 月亮）：仰角由昼夜时刻推得，白天暖色、夜晚冷色并随高度衰减 */
    const sun = s.sun || {};
    const st = dayNightState(sun.hour);
    const az = deg2rad(sun.azimuth ?? 38), el = deg2rad(st.elev);
    this._sunDir = new THREE.Vector3(
      Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)
    ).normalize();
    const baseInt = sun.intensity ?? 2;
    const k = clamp(st.alt / 0.3, 0, 1);          // 天光因子：仅在地平线附近明显衰减
    let lightColor, lightInt;
    if (st.isDay) {
      _cSunBase.set(sun.color || '#fff4e2');
      lightColor = _cLight.copy(_cSunset).lerp(_cSunBase, k);
      lightInt = baseInt * (0.3 + 0.7 * k);
    } else {
      lightColor = _cMoon;
      lightInt = baseInt * (0.08 + 0.22 * k);
    }
    if (this.sun && this.sun.parent) {
      this.sun.color.copy(lightColor);
      this.sun.intensity = lightInt;
    } else {
      this.sun = new THREE.DirectionalLight(lightColor.clone(), lightInt);
      this.root.add(this.sun);
      this.root.add(this.sun.target);
    }
    /* 主光跟随高光：把方向 / 颜色 / 强度写进材质共享 uniform。
       只写几个 float，不重编译着色器 —— 拖动方位角 / 昼夜时刻时 PBR 法线高光实时跟随。
       方向取 |y|（与阴影相机的 dirTo 一致）：仰角为负时太阳落到地平线下，实际光照仍来自上方 */
    SUN_SPEC.dir.value.set(this._sunDir.x, Math.abs(this._sunDir.y), this._sunDir.z).normalize();
    SUN_SPEC.color.value.copy(lightColor);
    SUN_SPEC.strength.value = clamp(lightInt, 0, 8);
    this.sun.castShadow = !!sun.shadows && settings.get('video.shadows', true);
    const size = settings.qualityPreset().shadowSize || 2048;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    this.updateSunShadow();   // 阴影相机的范围 / 偏移都在这里统一算（含 bias、normalBias）
  }

  /** 天空盒（可替换）：内置天空 / 导入的全景图 / 无；
      「环境反射」开关只管反射（scene.environment），不参与背景，天空由「天空盒」决定；
      亮度按关卡设置原样呈现（编辑器所见即游戏所得，否则拖「天空亮度」会看着没反应） */
  applySky() {
    if (!this.scene) return;
    const s = this.level.settings || {};
    /* 修饰器列表（几何变形 + 色彩 / 曝光）：作用在背景采样上，实时生效；
       没天空贴图时也照写，切到有天空时立即是设定好的效果 */
    setSkyMods(s.skyMods);
    const tex = resolveSkyTexture(s.sky);
    this.scene.background = tex;
    if (!tex) return;
    const k = s.skyIntensity === undefined ? 1 : clamp(Number(s.skyIntensity) || 0, 0, 4);
    this.scene.backgroundIntensity = k;
    if (this.onSkyApplied) { try { this.onSkyApplied(); } catch (e) { /* ignore */ } }
  }

  updateSunShadow() {
    if (!this.sun) return;
    const b = this.bounds;
    const empty = !b || b.isEmpty();
    const c = empty ? new THREE.Vector3() : b.getCenter(new THREE.Vector3());
    const size = empty ? new THREE.Vector3(140, 70, 140) : b.getSize(new THREE.Vector3());
    if (!this._sunDir) this._sunDir = new THREE.Vector3(0.5, 0.78, 0.36).normalize();
    /* 正交视锥必须紧贴场景 AABB —— 半边长就是「每个 texel 覆盖多少世界尺寸」的分母：
       原来按包围球对角线 ×0.55 估，比实际需要大一倍多，texel 也跟着大一倍多，
       阴影边缘就会出现明显的锯齿台阶。这里把 AABB 投影到光源正面的两个轴上，
       取能罩住它的最小方形半边长（盒体沿某轴的半跨度 = 0.5·Σ|aᵢ|·sizeᵢ）。
       注意 ax/ay 只用于取分量绝对值，符号与 three 内部的 lookAt 基准无关。 */
    const dirTo = new THREE.Vector3(this._sunDir.x, Math.abs(this._sunDir.y), this._sunDir.z).normalize(); // 由场景指向光源
    const ax = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dirTo);                     // 光源「右」
    if (ax.lengthSq() < 1e-8) ax.set(1, 0, 0); else ax.normalize();
    const ay = new THREE.Vector3().crossVectors(dirTo, ax).normalize();                                 // 光源「上」
    const halfAlong = (a) => 0.5 * (Math.abs(a.x) * size.x + Math.abs(a.y) * size.y + Math.abs(a.z) * size.z);
    const margin = 4;
    const r = clamp(Math.max(halfAlong(ax), halfAlong(ay)) + margin, 16, 900);
    const halfDepth = halfAlong(dirTo) + margin;      // 沿光源方向的半跨度
    const dist = r * 2.4 + 160;
    this.sun.target.position.set(c.x, c.y, c.z);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(
      c.x + this._sunDir.x * dist,
      c.y + Math.abs(this._sunDir.y) * dist,
      c.z + this._sunDir.z * dist
    );
    const cam = this.sun.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = Math.max(1, dist - halfDepth);
    cam.far = dist + halfDepth;
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
    /* ---------- 阴影偏移：压自阴影条纹，同时不把接缝接触阴影抬走 ----------
       网格曲面 / 曲线墙这类连续曲面在太阳光下出现亮暗相间的「阴影纹」(shadow acne)：
       · bias = 在阴影相机深度轴上平移比较深度，对「面与光线的夹角」不敏感。接收面越接近
         与光线平行，一个 texel 内接收面自身的深度变化越大，固定 bias 永远追不上 → 条纹。
       · normalBias = 沿接收面法线把采样点抬离表面，抬开量投影到光线方向 = normalBias·sin(夹角)，
         随夹角自适应增大，是唯一能压住掠射面条纹的方式。取 2 个 texel：盖住一个 texel 内的
         深度突变，又远小于旧的「0.9·texel / 上限 0.6」（接缝外扩量 SEAM_PAD_* 只有
         0.004~0.03 stud，0.6 会把接触阴影整片抬走），再压一个 0.2 stud 的硬上限兜底。
       · bias 仍按「世界长度 / 跨度」写成 -0.004 stud：作用在归一化深度上，直接写常数会被
         关卡尺寸放大（原来 -0.0008 实际抬开半个 stud）。
       · 阴影边缘的锯齿由 PCF 核宽抹平，见下面 radius 的算法。想更硬/更软改 config.js 的
         SHADOW.softness。 */
    const span = Math.max(1, cam.far - cam.near);                          // 阴影相机的世界深度跨度
    const texel = (2 * r) / (this.sun.shadow.mapSize.x || 2048);           // 每个 texel 覆盖的世界尺寸
    this.sun.shadow.normalBias = Math.min(texel * 2, 0.2);
    this.sun.shadow.bias = -0.004 / span;
    this.sun.shadow.radius = clamp(SHADOW.softness / texel, SHADOW.radiusMin, SHADOW.radiusMax);
  }

  computeBounds() {
    const b = this.bounds;
    b.makeEmpty();
    for (const rec of this.objects.values()) {
      if (rec.type === 'light' || rec.type === 'group') continue;
      // 路径型（滑索 / 折曲线 / 管道）与网格修改器：实际范围由几何决定，position ± scale 不适用
      if (PATH_TYPES.has(rec.type) || rec.type === 'meshref') {
        const node = rec.mesh || rec.group;
        if (node) { node.updateWorldMatrix(true, false); b.expandByObject(node); }
        continue;
      }
      if (!rec.o.position) continue;
      const p = worldPosition(this.level, rec.o);
      const s = rec.o.scale || [1, 1, 1];
      b.expandByPoint(new THREE.Vector3(p[0] - Math.abs(s[0]) / 2, p[1] - Math.abs(s[1]) / 2, p[2] - Math.abs(s[2]) / 2));
      b.expandByPoint(new THREE.Vector3(p[0] + Math.abs(s[0]) / 2, p[1] + Math.abs(s[1]) / 2, p[2] + Math.abs(s[2]) / 2));
    }
    if (b.isEmpty()) b.setFromCenterAndSize(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 100));
    this.updateSunShadow();      // 太阳阴影相机必须跟着地图范围走
    return b;
  }

  /* ============================================================
     顶点 AO 烘焙（接缝闭塞阴影）
     两个 part 贴在一起时，接触处的顶点被邻居遮挡 → 顶点色压暗，
     于是贴图/底色之上出现柔和的接缝暗部，画面才有层次感。
     ============================================================ */
  /** 所有实体的世界包围盒（AO 遮挡体） */
  collectAABBs() {
    const out = [];
    for (const rec of this.objects.values()) {
      if (rec.disposed) continue;
      if (!rec.def || !rec.def.solid) continue;
      if (!rec.mesh || rec.mesh.isGroup) continue;
      if (rec.o.visible === false) continue;
      const b = this.worldBoxOf(rec, _tmpBox);
      if (b.isEmpty()) continue;
      // 除轴对齐包围盒外，记下 OBB：本体几何是 ±0.5 的单位盒，由 mesh.matrixWorld 变换到世界。
      // 只按 AABB 判定时，旋转过的方块其 AABB 会鼓出一大圈，会把不在表面正面的邻居也算成遮挡。
      const e = rec.mesh.matrixWorld.elements;
      out.push({
        rec, min: b.min.clone(), max: b.max.clone(), i: out.length,
        ax: [e[0], e[1], e[2]], ay: [e[4], e[5], e[6]], az: [e[8], e[9], e[10]],
        org: [e[12], e[13], e[14]],
      });
    }
    return out;
  }

  /** 全量烘焙（构建结束后调用一次） */
  applyAO() {
    this.root.updateMatrixWorld(true);
    this._aoBoxes = this.collectAABBs();
    this._aoGrid = buildAOGrid(this._aoBoxes);
    // 画质档位关掉 AO 时不烘焙：材质同样不会启用顶点色（见 materials.js applyMaterialQuality），
    // 两者必须一致，否则顶点色变了但没有 color 属性
    const preset = settings.qualityPreset ? settings.qualityPreset() : null;
    if (preset && preset.ao === false) {
      this._aoReady = true;
      this.batchStaticMeshes();
      return;
    }
    // 周围没有别的遮挡体的对象：顶点 AO 必然全白 → 整块跳过（稀疏大关卡省下大量逐顶点计算）
    const isolated = new Set();
    for (const b of this._aoBoxes) {
      if (b.rec && !hasNeighborBox(b, this._aoGrid)) isolated.add(b.rec);
    }
    for (const rec of this.objects.values()) {
      if (isolated.has(rec)) continue;
      if (!this.isAOReceiver(rec) || !rec.mesh || !rec.mesh.isMesh) continue;
      if (!rec.mesh.geometry || !rec.mesh.geometry.attributes.position) continue;
      rec.mesh.updateMatrixWorld(true);
      bakeVertexAO(rec.mesh, rec, this._aoBoxes, this._aoGrid);
      rec.aoBaked = true;
      this.syncMaterial(rec);        // 换成带顶点色的材质变体
    }
    this._aoReady = true;
    this.batchStaticMeshes();      // AO 烘完再合批：顶点色要一并并进合并几何体
  }

  /* ---------- 静态网格合批 ---------- */
  /** 该对象能否并入静态网格合批：只并游玩模式里的「普通静态方块」 */
  _visualBatchAllowed(rec) {
    if (!this._staticBodyMerge) return false;    // 与刚体合批同一开关（仅游玩模式）
    const o = rec.o;
    if (!o || o.type !== 'mesh') return false;
    if (o.parent || o.tag) return false;                       // 子对象 / 带标签的可交互对象
    if (o.visible === false) return false;
    if ((o.shape || 'block') !== 'block') return false;
    if (!rec.ownGeometry) return false;                        // 共享基础几何不能就地变换
    if (rec.ownMaterial || this.hasPaint(rec) || this.useAtlas(rec)) return false;
    if (this._managedIds && this._managedIds.has(o.id)) return false;
    // 导入素材（asset:）的材质要等异步加载完成后才定稿，合批会让贴图刷新不到合并网格
    for (const k of ['texture', 'roughnessMap', 'normalMap']) {
      const v = o[k];
      if (typeof v === 'string' && (v.startsWith('asset:') || v.startsWith('file:'))) return false;
    }
    const m = rec.mesh;
    if (!m || !m.isMesh || !m.geometry || !m.material || Array.isArray(m.material)) return false;
    if (m.material.transparent || m.material.colorWrite === false) return false;
    return true;
  }

  /** 几何体的属性签名：属性集合与是否带索引要一致才能合并 */
  _geoSignature(geo) {
    let sig = geo.index ? 'i' : 'n';
    const names = Object.keys(geo.attributes).sort();
    for (const n of names) sig += ',' + n;
    return sig;
  }

  /** 把普通静态方块按「材质 + 阴影 + 空间分块」合并；每个合并网格一个绘制调用 */
  batchStaticMeshes() {
    if (this._visualBatched || !this._staticBodyMerge) return;
    this._visualBatched = true;
    this.root.updateMatrixWorld(true);
    const groups = new Map();
    for (const rec of this.objects.values()) {
      if (rec.disposed || rec.batched) continue;
      if (!this._visualBatchAllowed(rec)) continue;
      const m = rec.mesh;
      const p = worldPosition(this.level, rec.o);
      const cell = `${Math.floor(p[0] / VIS_CHUNK)},${Math.floor(p[1] / VIS_CHUNK)},${Math.floor(p[2] / VIS_CHUNK)}`;
      const key = `${m.material.uuid}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}|${this._geoSignature(m.geometry)}|${cell}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = []);
      g.push(rec);
    }
    for (const recs of groups.values()) {
      if (recs.length < 2) continue;             // 单个对象没有合批收益，保持原样
      // 就地烘焙世界变换（原几何体随后不再逐对象渲染，直接把它并进合并几何体即可）
      const geos = [];
      for (const rec of recs) {
        const m = rec.mesh;
        m.updateWorldMatrix(true, false);
        m.geometry.applyMatrix4(m.matrixWorld);
        geos.push(m.geometry);
      }
      const merged = mergeGeometries(geos, false);
      if (!merged) {                              // 属性不兼容（理论上不会）：还原并保持原样
        for (const rec of recs) {
          const inv = new THREE.Matrix4().copy(rec.mesh.matrixWorld).invert();
          rec.mesh.geometry.applyMatrix4(inv);
        }
        continue;
      }
      const src = recs[0].mesh;
      const mesh = new THREE.Mesh(merged, src.material);
      mesh.castShadow = src.castShadow;
      mesh.receiveShadow = src.receiveShadow;
      this.root.add(mesh);
      this._batchMeshes.push(mesh);
      for (const rec of recs) {
        const m = rec.mesh;
        if (m.parent) m.parent.remove(m);        // 从场景摘掉（对象记录仍保留 rec.mesh 引用）
        m.geometry.dispose();                    // 原始几何体已并入合并网格，不再渲染
        rec.batched = true;
      }
    }
    if (this._batchMeshes.length) this.cullVersion++;   // 让遮挡剔除按新对象集合重建
  }

  /** 单对象重新烘焙（对象新增 / 移动 / 几何体换代时） */
  refreshAO(rec) {
    if (!rec.mesh || !rec.mesh.isMesh || !rec.mesh.geometry) return;
    if (rec.disposed || !this.isAOReceiver(rec)) return;
    const preset = settings.qualityPreset ? settings.qualityPreset() : null;
    if (preset && preset.ao === false) { rec.aoBaked = false; return; }
    this.root.updateMatrixWorld(true);
    this._aoBoxes = this.collectAABBs();
    this._aoGrid = buildAOGrid(this._aoBoxes);
    bakeVertexAO(rec.mesh, rec, this._aoBoxes, this._aoGrid);
    rec.aoBaked = true;
    this.syncMaterial(rec);
    this._aoSet && this._aoSet.delete(rec);
  }

  /** 实体移动后标记重烤（限频在 update 里统一处理，避免拖拽时每帧重算） */
  markAODirty(rec) {
    if (!rec.aoBaked) return;
    if (!this._aoSet) this._aoSet = new Set();
    this._aoSet.add(rec);
  }

  flushAO(dt) {
    if (!this._aoSet || !this._aoSet.size) return;
    this._aoTimer = (this._aoTimer || 0) + dt;
    if (this._aoTimer < 0.1) return;
    this._aoTimer = 0;
    const list = [...this._aoSet];
    this._aoSet.clear();
    for (const rec of list.slice(0, 6)) {
      try { this.refreshAO(rec); } catch (e) { /* ignore */ }
    }
  }

  /* ============================================================
     增量更新（编辑器实时修改用）
     ============================================================ */
  syncTransform(rec) {
    const o = rec.o;
    const p = rec.mesh || rec.group;
    if (!p) return;
    // 接头：位置 / 朝向由「宿主表面 + 面法线」决定，不能按普通对象直接摆放
    if (rec.type === 'attachment') { this.updateAttachment(rec); return; }
    // 子级锚点：子对象跟随本对象的位置 / 旋转（锚点 scale 恒为 1，父级尺寸不传给子级）
    const anchor = this.groupNodes.get(o.id);
    if (anchor) {
      anchor.position.set(...(o.position || [0, 0, 0]));
      const r = o.rotation || [0, 0, 0];
      anchor.rotation.set(deg2rad(r[0] || 0), deg2rad(r[1] || 0), deg2rad(r[2] || 0));
      anchor.visible = o.visible !== false;
    }
    if (rec.group) {
      p.position.set(...o.position);
      p.rotation.set(deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2]));
      p.visible = o.visible !== false;
      return;
    }
    if (rec.type === 'liquid') this.updateLiquidTransform(rec);
    else if (PATH_TYPES.has(rec.type)) this.applyPathTransform(rec);
    else if (rec.type === 'light') {
      p.position.set(...o.position);
      this.updateLightDir(rec);
      if (rec.helperGroup) rec.helperGroup.position.set(...o.position);
    } else {
      p.position.set(...o.position);
      p.rotation.set(deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2]));
      p.scale.set(...o.scale);
      // 平铺 / 九宫格的 uv 是按面尺寸烘焙的 → 尺寸改了要重算几何
      if (rec.geoFill && rec.geoFill !== 'stretch') this.refreshGeometry(rec);
      // 文字方块：正面长宽比变了 → 文字贴图要按新比例重画
      if (rec.type === 'textblock') this.syncTextMaterial(rec);
    }
    // 与 mesh 同级挂载的辅助体（攀爬墙 / WallJump 墙的描边线框）不随父级变换，必须手动同步；
    // 挂在 mesh / helperGroup 下的辅助体（体积框的描边、灯泡等）由父级带过去，无需处理
    for (const h of rec.helpers) {
      if (!h.userData.followMesh) continue;
      h.position.copy(p.position);
      h.rotation.copy(p.rotation);
      h.scale.copy(p.scale).multiplyScalar(h.userData.helperGrow || 1);
    }
    if (rec.helperGroup && rec.helperGroup !== p) {
      rec.helperGroup.position.copy(p.position);
      rec.helperGroup.rotation.copy(p.rotation);
      if (rec.type !== 'light') rec.helperGroup.scale.copy(p.scale);
    }
    if (rec.body && rec.body.type === CANNON.Body.STATIC && !rec.o.parent) {
      rec.body.position.set(o.position[0], o.position[1], o.position[2]);
    }
    this.syncStaticBodyTransform(rec);
    if (rec.volLight) this.updateVolLightPos(rec);
    // 实体移动会改变它与液面的相交关系 → 下一帧刷新围边泡沫
    if (rec.type !== 'liquid' && rec.def && rec.def.solid) this._foamDirty = true;
    // 也会改变它与邻居的遮挡关系 → 顶点 AO 重新烘焙（限频，见 flushAO）
    if (rec.type !== 'liquid') this.markAODirty(rec);
    // 折曲线整体变换（移动 / 旋转 / 缩放）后，引用它的管道 / 滑索 / 网格修改器
    // 的节点是烘焙进几何的，必须重建才能跟着动
    if (rec.type === 'curve') this.syncPathDependents(rec.id);
    // 子对象的网格已经通过场景图跟着父级走了，但静态碰撞体不会自己动 → 整棵子树重算一次
    this.syncChildBodies(rec.id);
  }

  /** 父级变换后，子对象（含更深的后代）的静态碰撞体位置需要重算 */
  syncChildBodies(id, depth = 0) {
    if (depth > 16 || !this.level) return;
    for (const c of childrenOf(this.level, id)) {
      const rec = this.objects.get(c.id);
      if (rec && rec.body && !rec.generatedPhysics) {
        // 父级刚改过变换，矩阵还是上一帧的 → 先把祖先链刷一遍再取世界矩阵
        if (rec.mesh) rec.mesh.updateWorldMatrix(true, false);
        this.syncStaticBodyTransform(rec);
      }
      this.syncChildBodies(c.id, depth + 1);
    }
  }

  /** 折曲线变化后重建引用它的对象（带重入保护，避免重建链里反复触发） */
  syncPathDependents(id) {
    if (this._depSync) return;
    this._depSync = true;
    try {
      for (const dep of [...this.objects.values()]) {
        const d = dep.o;
        if (d.pathRef === id || d.curveRef === id) {
          try { this.rebuild(dep); } catch (e) { /* ignore */ }
        }
      }
    } finally { this._depSync = false; }
  }

  syncStaticBodyTransform(rec) {
    const body = rec.body;
    if (!body || body.type !== CANNON.Body.STATIC) return;
    const o = rec.o;
    if (rec.generatedPhysics) {
      // 生成式物理：形状取自生成网格的局部空间，体变换直接跟 root 的世界变换
      const root = rec.mesh;
      if (!root) return;
      root.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      const ws = new THREE.Vector3();
      playMatrix(root, this.mirror, _playM).decompose(wp, wq, ws);
      const old = rec._genScale;
      if (!old || Math.abs(old.x - ws.x) > 1e-4 || Math.abs(old.y - ws.y) > 1e-4 || Math.abs(old.z - ws.z) > 1e-4) {
        this.rebuildGeneratedBody(rec);
        return;
      }
      body.position.set(wp.x, wp.y, wp.z);
      body.quaternion.set(wq.x, wq.y, wq.z, wq.w);
      return;
    }
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      deg2rad(o.rotation[0]), deg2rad(o.rotation[1]), deg2rad(o.rotation[2])));
    let wp = worldPosition(this.level, o);
    if (o.parent && rec.mesh) {
      const parentNode = this.groupNodes.get(o.parent);
      if (parentNode) {
        parentNode.updateMatrixWorld(true);
        const m = new THREE.Matrix4().multiplyMatrices(playMatrix(parentNode, this.mirror, _playM), rec.mesh.matrix);
        // 同 makeBody：必须 decompose 掉缩放，否则四元数非单位、碰撞体会被放大
        const scl = new THREE.Vector3();
        m.decompose(_tmpV, q, scl);
        wp = [_tmpV.x, _tmpV.y, _tmpV.z];
      }
    }
    body.position.set(wp[0], wp[1], wp[2]);
    body.quaternion.set(q.x, q.y, q.z, q.w);
    body.aabbNeedsUpdate = true;
    body.updateAABB();
  }

  /** 材质/外观变化 */
  syncMaterial(rec) {
    const o = rec.o;
    // NPC：外观由「预设 / 衣服色 / 模型资源」决定，rec.mesh 是 Group，不能走下面的通用材质路径
    if (rec.type === 'npc') { this.syncNpc(rec); return; }
    if (rec.type === 'liquid') {
      // 液体自己的外观 + 贴在这片水面上的传送门（液体子集）一起刷新
      this.refreshLiquidPortal(rec);
      return;
    }
    if (rec.type === 'light' && rec.light) {
      rec.light.color.set(o.color || '#fff3c4');
      rec.light.intensity = o.intensity ?? 1.6;
      if (rec.light.distance !== undefined) rec.light.distance = o.distance || 0;
      if (rec.light.angle !== undefined) {
        rec.light.angle = deg2rad(o.angle || 38);
        rec.light.penumbra = o.penumbra ?? 0.4;
      }
      rec.light.visible = rec.visible;
      if (rec.helpers.length) for (const h of rec.helpers) if (h.material && h.material.color) h.material.color.set(o.color || '#fff3c4');
      return;
    }
    // 体积特效材质（体积雾 / 体积光）：换成对应的自绘材质
    if (rec.type === 'fogvol' || rec.type === 'volumelight') {
      const next = rec.type === 'fogvol' ? getFogVolumeMaterial(o, this.fogToken(rec)) : getVolumeLightMaterial(o);
      if (rec.mesh.material !== next) {
        releaseMaterial(rec.mesh.material);
        rec.mesh.material = next;
      }
      if (rec.type === 'volumelight') {
        if (o.withLight === false) this.removeVolLight(rec);
        else {
          if (!rec.volLight) this.makeVolLight(rec);
          if (rec.volLight) {
            rec.volLight.color.set(o.color || '#ffe9b0');
            rec.volLight.intensity = Number(o.lightPower ?? 1.1);
            rec.volLight.distance = Number(o.lightRange ?? 120);
            rec.volLight.visible = rec.visible && o.visible !== false;
            this.updateVolLightPos(rec);
          }
        }
      }
      if (rec.mesh) rec.mesh.visible = rec.visible;
      return;
    }
    // 文字方块 / 公告板：材质由文字贴图生成
    if (rec.type === 'textblock' || rec.type === 'billboard') {
      this.syncTextMaterial(rec);
      if (rec.mesh) rec.mesh.visible = rec.visible;
      return;
    }
    // 传送门：轮廓走 uniform（不重编译），图层 / 外框参数变了才换材质
    if (rec.type === 'portal') {
      this.syncPortal(rec);
      return;
    }
    const mapOverride = this.mapOverride(rec);
    this.refreshGeometry(rec);
    // 路径型对象的外观参数要统一过 pathLook（平滑着色开关 → 材质 flatShading）
    const look = PATH_TYPES.has(o.type) ? pathLook(o) : o;
    // 已烘焙顶点 AO 的对象用 vertexColors 材质变体（接缝闭塞阴影）；
    // baked：立方体填充（平铺 / 九宫格）的 uv 已烘焙进几何 → 材质层 repeat 固定为 1；
    // studUV：低模建模体 / 自定义模型 / 扫掠路径的 uv 已按 stud 尺度烘焙 → repeat = 1/贴图尺寸(stud)
    const opts = {
      vcol: !!rec.aoBaked,
      baked: rec.geoFill === 'tile' || rec.geoFill === 'nine',
      studUV: o.type === 'poly' || o.type === 'vec' || o.type === 'pipe' || o.type === 'curvewall' || o.shape === 'model',
    };
    // 自定义模型：scale 变了要把 stud 尺度 uv 重烘一遍（材质 repeat 与 scale 无关）
    if (o.shape === 'model' && rec.meshes) {
      const sk = studScaleKey(o);
      if (rec._studScaleKey !== sk) {
        rec._studScaleKey = sk;
        const sc = (o.scale || [1, 1, 1]).map((v) => Number(v) || 1);
        for (const m of rec.meshes) {
          m.traverse && m.traverse((x) => {
            if (x.isMesh && x.userData._studRel) this._bakeModelStudUV(x, sc, x.userData._studRel);
          });
        }
      }
    }
    if (rec.meshes) {
      for (const m of rec.meshes) {
        if (m.isMesh) applyMaterial(m, look, mapOverride, opts);
        else m.traverse && m.traverse((x) => { if (x.isMesh && !x.userData.keepMaterial) applyMaterial(x, look, mapOverride, opts); });
      }
    }
    if (rec.mesh && rec.mesh.material && rec.mesh.type === 'Mesh') {
      const mat = getMaterial(look, mapOverride, opts);
      // 材质没变时把多拿的引用还回去，否则引用计数只涨不落、材质永不释放，
      // 旧画布被释放后会以「空白贴图」的身份继续被缓存命中（方块变黑）
      if (rec.mesh.material === mat) releaseMaterial(mat);
      else { releaseMaterial(rec.mesh.material); rec.mesh.material = mat; }
    }
    const vis = rec.visible && !(LOGIC_ONLY.has(o.type) && !this.editor);
    if (rec.mesh) rec.mesh.visible = vis;
    if (rec.surfaceLine) rec.surfaceLine.visible = rec.visible;
    if (rec.foamMesh) rec.foamMesh.visible = rec.visible;
    if (rec.light) rec.light.visible = rec.visible;
    if (rec.group) rec.group.visible = rec.visible;
  }

  syncVisibility(rec) { this.syncMaterial(rec); }

  /** 结构变化（形状/资源/路径）→ 重建该对象，并联动重建引用它的对象 */
  rebuild(rec, seen) {
    const id = rec.id;
    const data = rec.o;
    const parentId = data.parent;
    // 子对象挂在「子级锚点」下，而锚点会随本体一起销毁 → 先把锚点里的子级接过来，
    // 本体重建后再挂到新锚点下。否则重建一个父级会把整棵子树从场景里摘掉。
    const oldAnchor = this.groupNodes.get(id);
    const kids = oldAnchor ? oldAnchor.children.slice() : null;
    this.destroyObject(id);
    const fresh = this.create(data);
    if (fresh) this.postCreate(fresh);
    if (kids && kids.length) {
      const anchor = this.groupNodes.get(id);
      if (anchor) for (const k of kids) anchor.add(k);
    }
    void parentId;
    if (rec.mesh || rec.group) this.computeBounds();
    // 曲线 / 源对象变了，引用它的管道、滑索、网格修改器必须一起重建才会同步
    const guard = seen || new Set();
    guard.add(id);
    for (const dep of [...this.objects.values()]) {
      if (guard.has(dep.id)) continue;
      const d = dep.o;
      if (d.pathRef === id || d.curveRef === id || d.sourceRef === id) this.rebuild(dep, guard);
    }
    return fresh;
  }

  destroyObject(id) {
    const rec = this.objects.get(id);
    if (!rec) return;
    this.cullVersion++;
    rec.disposed = true;
    this.releaseBody(rec);
    this.removeVolLight(rec);
    if (rec.type === 'fogvol' && this.volumeFog) this.volumeFog.unregister(rec);
    // NPC：导入模型实例 / R6 几何都挂在 root 下，先释放再移除（root 本身没有材质 / 几何）
    if (rec.type === 'npc') {
      if (rec.npcAvatar) { rec.npcAvatar.dispose(); rec.npcAvatar = null; }
      if (rec.mesh) for (const ch of rec.mesh.children.slice()) this.disposeNpcNode(ch);
      rec.npcR6 = null; rec.npcR6Group = null;
    }
    if (rec.mesh) {
      if (rec.mesh.parent) rec.mesh.parent.remove(rec.mesh);
      if (rec.mesh.material) {
        if (rec.ownMaterial) rec.mesh.material.dispose();   // 公告板等独享材质
        else releaseMaterial(rec.mesh.material);
      }
      if (rec.mesh.geometry && rec.mesh.userData.ownGeometry) rec.mesh.geometry.dispose();
    }
    if (rec.group && rec.group.parent) rec.group.parent.remove(rec.group);
    for (const h of rec.helpers) {
      if (h.parent) h.parent.remove(h);
      if (h.geometry) h.geometry.dispose();
      if (h.material) { Array.isArray(h.material) ? h.material.forEach((m) => m.dispose()) : h.material.dispose(); }
    }
    if (rec.surfaceLine) { if (rec.surfaceLine.parent) rec.surfaceLine.parent.remove(rec.surfaceLine); rec.surfaceLine.geometry.dispose(); rec.surfaceLine.material.dispose(); }
    this.clearFoam(rec);
    if (rec.def && rec.def.solid) this._foamDirty = true;   // 实体移除会影响围边泡沫
    rec.helpers = [];
    const list = this.byType.get(rec.type);
    if (list) { const i = list.indexOf(rec); if (i >= 0) list.splice(i, 1); }
    this.objects.delete(id);
    // 液体子集传送门被删掉后，父级液体要回到普通液体材质（不能留着注入的水面窗口）
    if (rec.portal) {
      const own = this.objects.get(rec.o && rec.o.parent);
      if (own && own.type === 'liquid') this.refreshLiquidPortal(own);
    }
    // 子级锚点与本体同级，不会跟着本体一起移除 → 单独摘掉（子对象在各自 destroy 时处理）
    const anchor = this.groupNodes.get(id);
    if (anchor && anchor.parent) anchor.parent.remove(anchor);
    this.groupNodes.delete(id);
  }

  /** 数据整体替换（撤销/重做后调用） */
  refreshAll() {
    for (const rec of [...this.objects.values()]) this.destroyObject(rec.id);
    this.objects.clear(); this.byType.clear(); this.groupNodes.clear();
    // 清掉环境节点后重建
    if (this.ambient && this.ambient.parent) this.ambient.parent.remove(this.ambient);
    if (this.sun && this.sun.parent) this.sun.parent.remove(this.sun);
    this.build();
  }

  objectsOf(type) { return this.byType.get(type) || []; }

  /* ============================================================
     遮挡剔除（CPU 软件遮挡剔除）
     ============================================================ */
  /**
   * 主渲染前调用一次（见 session 的 view.beforeRender）：
   * 把被完全挡住的物体隐藏，减少顶点处理 / 光栅化 / 阴影投射开销。
   * 编辑器里不启用；设置项关闭时立即销毁剔除器并恢复全部可见性。
   */
  cull(camera) {
    const on = !this.editor && settings.get('video.occlusionCulling', true) !== false;
    if (!on) {
      if (this.culler) { this.culler.dispose(); this.culler = null; }
      return;
    }
    if (!this.culler) this.culler = new OcclusionCuller(this);
    this.culler.run(camera);
  }

  /* ============================================================
     每帧
     ============================================================ */
  update(dt, camera) {
    if (camera) this.camera = camera;
    // 先把上一帧被遮挡剔除隐藏的对象恢复可见：本帧的机关 / 事件 / 射线
    // 都要看到完整场景（Raycaster 会跳过 visible === false 的对象）
    if (this.culler) this.culler.restore();
    this.time += dt;
    VOLUME_UNIFORMS.time.value = this.time;   // 体积雾 / 体积光 的动画时间轴
    ADV_UNIFORMS.time.value = this.time;      // 高级材质的图案动画时间轴
    PORTAL_UNIFORMS.time.value = this.time;   // 传送门外框的动画时间轴
    // 液体矩阵
    for (const rec of this.objectsOf('liquid')) {
      this.setupLiquid(rec);
      if (this.onHot && rec.mesh) this.onHot(rec.mesh, true);
    }
    // 接头贴面：宿主可能是液体（fillLevel 0~1）或会变形的低模体，必须每帧重新贴合
    this.updateAttachments();
    // 实体增删/移动后刷新围边泡沫（只在这些时刻做，避免逐帧开销）
    if (this._foamDirty) {
      this._foamDirty = false;
      for (const rec of this.objectsOf('liquid')) this.updateFoam(rec);
    }
    // 动态物体回写：使用 Cannon 内置的 interpolatedPosition / interpolatedQuaternion 做固定步长补间
    // world.step(timeStep, dt, maxSubSteps) 已经按 accumulator / dt 算好插值，直接读即可
    for (const rec of this.objects.values()) {
      if (!rec.body || rec.body.type !== CANNON.Body.DYNAMIC) continue;
      if (rec.body.sleepState === CANNON.Body.SLEEPING) continue;
      if (rec.mesh) {
        const bp = rec.body.interpolatedPosition;
        const bq = rec.body.interpolatedQuaternion;
        if (bp) rec.mesh.position.set(bp.x, bp.y, bp.z);
        if (bq) rec.mesh.quaternion.set(bq.x, bq.y, bq.z, bq.w);
        if (this.onHot) this.onHot(rec.mesh);
      }
      if (rec.o.parent) { /* 动态物体脱离父级 */ }
    }
    this.flushAO(dt);   // 移动过的对象限频重烤顶点 AO
    this.updateBillboards();
    this.syncMeshRefs(dt);   // 网格修改器：源对象变化时自动重建
  }

  /** 公告板：始终面向玩家 + 按距离淡入淡出（每帧，开销正比于公告板数量） */
  updateBillboards() {
    const list = this.byType.get('billboard');
    if (!list || !list.length) return;
    const cam = this.camera;
    for (const rec of list) {
      const o = rec.o;
      const m = rec.mesh;
      if (!m) continue;
      if (cam && o.faceCamera !== false) {
        _tmpE.set(deg2rad(o.rotation?.[0] || 0), deg2rad(o.rotation?.[1] || 0), deg2rad(o.rotation?.[2] || 0));
        _tmpQ.setFromEuler(_tmpE);
        if (m.parent && m.parent !== this.root) {
          // 挂在编组下：把相机朝向换算到父级局部空间，再叠上自身旋转
          // （镜像局里父级的世界旋转也是镜像空间的，必须换回原空间才能算出正确的局部朝向）
          playQuat(m.parent, this.mirror, _tmpQ2).invert();
          m.quaternion.copy(_tmpQ2).multiply(cam.quaternion).multiply(_tmpQ);
        } else {
          m.quaternion.copy(cam.quaternion).multiply(_tmpQ);
        }
      }
      let op = clamp(Number(o.baseOpacity ?? 1), 0, 1);
      if (cam && o.fadeEnabled !== false) {
        m.getWorldPosition(_tmpV);
        // 镜像变体：场景被 x 取反，世界坐标也反着 —— 换回原空间再算距离才是真实远近
        if (this.mirror) _tmpV.x = -_tmpV.x;
        const d = _tmpV.distanceTo(cam.position);
        const near = Math.max(0, Number(o.fadeIn ?? 40));
        const far = Math.max(near + 0.01, Number(o.fadeOut ?? 140));
        const k = 1 - clamp((d - near) / (far - near), 0, 1);
        op *= k * k * (3 - 2 * k);       // smoothstep：两端过渡更柔和
      }
      // 编辑器里保底可见，方便选中 / 观察实际效果
      if (this.editor) op = Math.max(op, 0.25);
      if (m.material && m.material.opacity !== op) m.material.opacity = op;
      m.visible = rec.visible && op > 0.004;
      if (this.onHot) this.onHot(m);
    }
  }

  /** 物理步进（渲染帧 → 固定步长） */
  stepPhysics(dt) {
    if (!this.world) return;
    this.world.step(PHYS.timeStep, dt, PHYS.maxSubSteps);
  }

  /* ============================================================
     空间查询（事件脚本 / WorldAPI 用）
     ------------------------------------------------------------
     命中对象反查靠 body.userData.objectId（建体时写入，见 create / postCreate）。
     归一化结果：{ hit, objectId, type, player, point:[x,y,z], normal:[x,y,z], distance, rec }
     未命中时 hit=false、objectId=''、distance=-1、point=终点、normal=[0,0,0]。
     · 默认走 cannon 物理射线，在「玩法空间」里打 —— 镜像局无需换算（物理在
       原空间跑，见 level.js 顶部关于「玩法空间 vs 渲染空间」的说明）。
     · opts.visual=true 时改走 THREE.Raycaster（命中可视网格），此时是渲染空间，
       镜像局需左右翻转换算。
     opts: { mask, group, hitPlayer, skipBackfaces, visual }
     ============================================================ */
  raycastClosest(fromArr, toArr, opts) {
    const list = this._raycast(fromArr, toArr, opts);
    return list.length ? list[0] : noRayHit(toArr);
  }

  raycastAll(fromArr, toArr, opts) {
    const o = opts ? { ...opts, all: true } : { all: true };
    return this._raycast(fromArr, toArr, o);
  }

  _raycast(fromArr, toArr, opts) {
    const o = opts || {};
    const f = Array.isArray(fromArr) ? fromArr : [0, 0, 0];
    const t = Array.isArray(toArr) ? toArr : [0, 0, 0];
    if (o.visual) return this._visualRaycast(f, t);
    if (!this.world) return [];
    // 默认沿用玩家的过滤方式（group 2 / mask 1）：只命中关卡的静态几何，不撞到玩家自己。
    // 想连玩家一起命中时用 hitPlayer —— 玩家的 mask 只接受 group 1，射线要按 group 1 打。
    const opt = {
      collisionFilterGroup: Number.isFinite(o.group) ? o.group : (o.hitPlayer ? 1 : 2),
      collisionFilterMask: Number.isFinite(o.mask) ? o.mask : (o.hitPlayer ? 3 : 1),
      skipBackfaces: o.skipBackfaces !== false,
    };
    _rcFrom.set(Number(f[0]) || 0, Number(f[1]) || 0, Number(f[2]) || 0);
    _rcTo.set(Number(t[0]) || 0, Number(t[1]) || 0, Number(t[2]) || 0);
    const out = [];
    if (o.all) {
      // raycastAll 复用同一份 result 逐个回调，必须在回调里就把数据抄出来
      this.world.raycastAll(_rcFrom, _rcTo, opt, (res) => { out.push(this._rayHit(res)); });
      out.sort((a, c) => a.distance - c.distance);
    } else {
      _rcRes.reset();
      this.world.raycastClosest(_rcFrom, _rcTo, opt, _rcRes);
      if (_rcRes.hasHit) out.push(this._rayHit(_rcRes));
    }
    return out;
  }

  /** cannon 命中结果 → 纯数据 */
  _rayHit(res) {
    // 合批后命中的是复合刚体：对象身份挂在命中的那个盒形上（见 _mergeStaticBody）
    const ud = (res.shape && res.shape.userData) || (res.body && res.body.userData) || {};
    const pt = res.hitPointWorld;
    const n = res.hitNormalWorld;
    const oid = ud.objectId || '';
    return {
      hit: true,
      objectId: oid,
      type: ud.type || '',
      player: !!ud.player,
      point: [pt.x, pt.y, pt.z],
      normal: [n.x, n.y, n.z],
      distance: Number.isFinite(res.distance) ? res.distance : -1,
      rec: oid ? (this.objects.get(oid) || null) : null,
    };
  }

  /** 可视网格射线（opts.visual）：对 rec.mesh / rec.group 求交，返回按距离排序的命中 */
  _visualRaycast(f, t) {
    const scene = this.scene;
    if (scene && scene.updateMatrixWorld) scene.updateMatrixWorld(true);
    const mir = this.mirror;
    _rcA.set(Number(f[0]) || 0, Number(f[1]) || 0, Number(f[2]) || 0);
    _rcB.set(Number(t[0]) || 0, Number(t[1]) || 0, Number(t[2]) || 0);
    if (mir) { _rcA.x = -_rcA.x; _rcB.x = -_rcB.x; }   // 渲染空间是镜像的，先换过去
    _rcDir.copy(_rcB).sub(_rcA);
    const len = _rcDir.length();
    if (len < 1e-6) return [];
    _rcRay.set(_rcA, _rcDir.divideScalar(len));
    _rcRay.near = 0;
    _rcRay.far = len;
    const out = [];
    for (const rec of this.objects.values()) {
      if (rec.disposed || !rec.o) continue;
      const obj = rec.mesh || rec.group;
      if (!obj || obj.visible === false) continue;
      const hits = _rcRay.intersectObject(obj, true);
      for (const h of hits) {
        const p = h.point.clone();
        const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
        if (mir) { p.x = -p.x; n.x = -n.x; }           // 换算回玩法空间
        out.push({
          hit: true, objectId: rec.o.id, type: rec.o.type, player: false,
          point: [p.x, p.y, p.z], normal: [n.x, n.y, n.z], distance: h.distance, rec,
        });
      }
    }
    out.sort((a, c) => a.distance - c.distance);
    return out;
  }

  /* ---------- 玩家出生点 ---------- */
  pickSpawn(rng = Math.random) {
    const list = this.objectsOf('spawn');
    if (!list.length) return new THREE.Vector3(0, 20, 0);
    const fixed = this.level.settings?.spawnFixed;
    if (fixed) {
      const rec = this.objects.get(fixed);
      if (rec) return new THREE.Vector3(...worldPosition(this.level, rec.o));
    }
    let total = 0;
    for (const r of list) total += Math.max(0.01, Number(r.o.weight) || 1);
    let x = rng() * total;
    for (const r of list) {
      x -= Math.max(0.01, Number(r.o.weight) || 1);
      if (x <= 0) return new THREE.Vector3(...worldPosition(this.level, r.o));
    }
    return new THREE.Vector3(...worldPosition(this.level, list[0].o));
  }
  pickGoal() {
    const list = this.objectsOf('goal');
    if (!list.length) return null;
    const multi = list.filter((r) => r.o.multi);
    const pool = multi.length ? multi : list;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  dispose() {
    if (this.culler) { this.culler.dispose(); this.culler = null; }
    if (this.volumeFog) { this.volumeFog.dispose(); this.volumeFog = null; }
    for (const rec of [...this.objects.values()]) this.destroyObject(rec.id);
    this.objects.clear(); this.byType.clear(); this.groupNodes.clear();
    for (const m of this._batchMeshes) {   // 静态合批的合并网格：几何体由本模块创建，需释放
      if (m.parent) m.parent.remove(m);
      if (m.geometry) m.geometry.dispose();
    }
    this._batchMeshes.length = 0;
    this._bodyChunks.clear();
    if (this.root.parent) this.root.parent.remove(this.root);
    this.root.traverse((c) => {
      if (c.isMesh && c.userData.ownGeometry && c.geometry) c.geometry.dispose();
    });
    this.scene = null;
    this.level = null;
  }
}

function dir3(v) { return new THREE.Vector3(v.x, v.y, v.z); }

/** 射线未命中时的归一化空结果（point = 射线终点） */
function noRayHit(toArr) {
  const t = Array.isArray(toArr) ? toArr : [0, 0, 0];
  return {
    hit: false, objectId: '', type: '', player: false,
    point: [Number(t[0]) || 0, Number(t[1]) || 0, Number(t[2]) || 0],
    normal: [0, 0, 0], distance: -1, rec: null,
  };
}

/* ============================================================
   顶点 AO（接缝闭塞阴影）
   思路：每个顶点在自己的法线半球内被邻近实体遮挡多少，就把顶点色压暗多少。
   两个 part 贴在一起时接触面附近的顶点被邻居挡住 → 接缝处自然出现暗部，
   这是层级感 / 体积感的主要来源（比全局环境光乘系数有效得多）。
   ============================================================ */

/** 点到轴对齐盒的最近点距离（点在盒内返回 0） */
function distPointBox(px, py, pz, box) {
  const dx = px < box.min.x ? box.min.x - px : (px > box.max.x ? px - box.max.x : 0);
  const dy = py < box.min.y ? box.min.y - py : (py > box.max.y ? py - box.max.y : 0);
  const dz = pz < box.min.z ? box.min.z - pz : (pz > box.max.z ? pz - box.max.z : 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 把三维格子坐标打包成一个整数当 Map 键（比字符串拼接快得多，减少每顶点的开销）
    基数 65536：可表示 ±32768 个格子（远超任何关卡的坐标范围），且乘积仍在安全整数内 */
const AO_CELL_OFFSET = 32768;
const AO_CELL_BASE = 65536;
function aoCellKey(x, y, z) {
  return ((x + AO_CELL_OFFSET) * AO_CELL_BASE + (y + AO_CELL_OFFSET)) * AO_CELL_BASE + (z + AO_CELL_OFFSET);
}

/** 把遮挡体按 AO_RADIUS 分格，查询顶点时只看邻近格子（避免 O(顶点×物体)） */
function buildAOGrid(boxes) {
  const cell = AO_RADIUS;
  const grid = new Map();
  const big = [];      // 超大盒（跨越很多格子）单独列出，避免格子数量爆炸
  for (const b of boxes) {
    const spanX = (b.max.x - b.min.x) / cell, spanY = (b.max.y - b.min.y) / cell, spanZ = (b.max.z - b.min.z) / cell;
    if (spanX * spanY * spanZ > 256) { big.push(b); continue; }
    for (let x = Math.floor(b.min.x / cell) - 1; x <= Math.floor(b.max.x / cell) + 1; x++) {
      for (let y = Math.floor(b.min.y / cell) - 1; y <= Math.floor(b.max.y / cell) + 1; y++) {
        for (let z = Math.floor(b.min.z / cell) - 1; z <= Math.floor(b.max.z / cell) + 1; z++) {
          const k = aoCellKey(x, y, z);
          let list = grid.get(k);
          if (!list) grid.set(k, list = []);
          list.push(b);
        }
      }
    }
  }
  return { grid, big, cell, seen: new Int32Array(boxes.length), stamp: 0 };
}

/* 顶点 AO 烘焙的临时量：跨对象复用，避免逐对象分配（5000 个对象时分配开销很可观） */
const _aoNM = new THREE.Matrix3();
const _aoWP = new THREE.Vector3();
const _aoWN = new THREE.Vector3();

/** 两个轴对齐盒的间距（重叠为 0） */
function aabbGap(a, b) {
  const dx = a.min.x > b.max.x ? a.min.x - b.max.x : (b.min.x > a.max.x ? b.min.x - a.max.x : 0);
  const dy = a.min.y > b.max.y ? a.min.y - b.max.y : (b.min.y > a.max.y ? b.min.y - a.max.y : 0);
  const dz = a.min.z > b.max.z ? a.min.z - b.max.z : (b.min.z > a.max.z ? b.min.z - a.max.z : 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 该盒 AO_RADIUS 范围内是否存在别的遮挡体：没有的话顶点 AO 必然全白，逐顶点烘焙可以整块跳过 */
function hasNeighborBox(b, aoGrid) {
  const cell = aoGrid.cell;
  const grid = aoGrid.grid;
  const big = aoGrid.big;
  const x0 = Math.floor((b.min.x - AO_RADIUS) / cell), x1 = Math.floor((b.max.x + AO_RADIUS) / cell);
  const y0 = Math.floor((b.min.y - AO_RADIUS) / cell), y1 = Math.floor((b.max.y + AO_RADIUS) / cell);
  const z0 = Math.floor((b.min.z - AO_RADIUS) / cell), z1 = Math.floor((b.max.z + AO_RADIUS) / cell);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        const list = grid.get(aoCellKey(x, y, z));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const o = list[k];
          if (o !== b && aabbGap(b, o) < AO_RADIUS) return true;
        }
      }
    }
  }
  for (let k = 0; k < big.length; k++) {
    const o = big[k];
    if (o !== b && aabbGap(b, o) < AO_RADIUS) return true;
  }
  return false;
}

/**
 * 烘焙一个网格的顶点 AO 到 geometry.attributes.color
 * @param mesh 待烘焙网格（matrixWorld 已更新）
 * @param rec  SceneObject（用于排除自身）
 */
function bakeVertexAO(mesh, rec, boxes, aoGrid) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  if (!pos) return;
  const nor = geo.attributes.normal;
  const count = pos.count;
  let color = geo.attributes.color;
  if (!color || color.count !== count) {
    color = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    geo.setAttribute('color', color);
  }
  const m = mesh.matrixWorld;
  const nm = _aoNM.getNormalMatrix(m);
  const wp = _aoWP;
  const wn = _aoWN;
  const cell = aoGrid.cell;
  const grid = aoGrid.grid;
  const big = aoGrid.big;
  // 每个顶点去重候选盒：同一格内的盒会被重复登记，用时间戳数组避免重复计算。
  // seen / stamp 挂在 AO 网格上跨对象复用——逐对象新建 Int32Array(物体数) 会产生大量分配。
  const seen = aoGrid.seen;
  let stamp = aoGrid.stamp;
  // 候选盒的判定提出来复用（每个顶点都新建闭包会带来大量分配）
  let occ = 0, used = 0;
  const consider = (b) => {
    if (used >= AO_MAX_NEIGHBORS) return;
    const idx = b.i;
    if (seen[idx] === stamp) return;
    seen[idx] = stamp;
    if (b.rec === rec) return;                       // 自身不算遮挡
    if (distPointBox(wp.x, wp.y, wp.z, b) >= AO_RADIUS) return;   // AABB 粗筛（真实距离只会更大）
    // 把顶点换算到遮挡体的局部单位盒（几何体是 ±0.5 的立方体）
    const ax = b.ax, ay = b.ay, az = b.az, org = b.org;
    const rx = wp.x - org[0], ry = wp.y - org[1], rz = wp.z - org[2];
    const lx = (rx * ax[0] + ry * ax[1] + rz * ax[2]) / (ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]);
    const ly = (rx * ay[0] + ry * ay[1] + rz * ay[2]) / (ay[0] * ay[0] + ay[1] * ay[1] + ay[2] * ay[2]);
    const lz = (rx * az[0] + ry * az[1] + rz * az[2]) / (az[0] * az[0] + az[1] * az[1] + az[2] * az[2]);
    // 遮挡体必须落在该表面的「正面」：沿法线看，盒的最远角要探出顶点之前。
    // 只按距离判定会把位于表面背面（如方块下方的地面）和与表面共面贴合的邻居也算成遮挡，
    // 于是两个 part 平贴时接缝两侧会压出一圈本不该有的暗部。
    const nx = wn.x * ax[0] + wn.y * ax[1] + wn.z * ax[2];   // 法线在盒各局部轴上的投影
    const ny = wn.x * ay[0] + wn.y * ay[1] + wn.z * ay[2];
    const nz = wn.x * az[0] + wn.y * az[1] + wn.z * az[2];
    const front = (nx >= 0 ? 0.5 - lx : -0.5 - lx) * nx
                + (ny >= 0 ? 0.5 - ly : -0.5 - ly) * ny
                + (nz >= 0 ? 0.5 - lz : -0.5 - lz) * nz;
    if (front <= AO_FRONT_EPS) return;
    used++;
    // 顶点到遮挡体最近点的偏移（局部）
    const ox = clamp(lx, -0.5, 0.5) - lx;
    const oy = clamp(ly, -0.5, 0.5) - ly;
    const oz = clamp(lz, -0.5, 0.5) - lz;
    let ux, uy, uz, dist;
    if (ox === 0 && oy === 0 && oz === 0) {
      // 顶点落在盒内 / 盒面上（贴合的两个 part 常见）：用顶点指向盒中心的方向
      ux = org[0] - wp.x; uy = org[1] - wp.y; uz = org[2] - wp.z;
      const l = Math.hypot(ux, uy, uz);
      if (l < 1e-4) return;
      ux /= l; uy /= l; uz /= l;
      dist = 0;                                      // 贴在盒上，遮蔽最重
    } else {
      // 顶点 → 最近点 的世界方向（先把局部偏移变换回世界）
      const wx = ox * ax[0] + oy * ay[0] + oz * az[0];
      const wy = ox * ax[1] + oy * ay[1] + oz * az[1];
      const wz = ox * ax[2] + oy * ay[2] + oz * az[2];
      dist = Math.hypot(wx, wy, wz);
      if (dist < 1e-4 || dist >= AO_RADIUS) return;
      const k = -1 / dist;                           // 取反：沿用原判定，用「遮挡体 → 顶点」方向
      ux = wx * k; uy = wy * k; uz = wz * k;
    }
    const facing = clamp((ux * wn.x + uy * wn.y + uz * wn.z) * 0.5 + 0.5, 0, 1);
    if (facing <= 0) return;
    const f = 1 - dist / AO_RADIUS;
    occ += facing * f * f;                            // 越近越黑，随距离平方衰减
  };

  for (let i = 0; i < count; i++) {
    wp.fromBufferAttribute(pos, i).applyMatrix4(m);
    if (nor) wn.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
    else wn.set(0, 1, 0);
    const near = grid.get(aoCellKey(Math.floor(wp.x / cell), Math.floor(wp.y / cell), Math.floor(wp.z / cell)));
    stamp++;
    occ = 0; used = 0;
    if (near) {
      for (let k = 0; k < near.length; k++) consider(near[k]);
    }
    for (let k = 0; k < big.length; k++) consider(big[k]);
    const ao = clamp(1 - occ * AO_STRENGTH, 0.25, 1);
    color.setXYZ(i, ao, ao, ao);
  }
  color.needsUpdate = true;
  geo.computeBoundingSphere();
  aoGrid.stamp = stamp;      // 时间戳跨对象延续，保证去重表始终有效
}

/* ---------- 便捷入口 ---------- */
export function buildLevel(level, opts = {}) {
  const b = new LevelBuilder(level, opts);
  if (opts.scene) opts.scene.add(b.root);
  return b;
}
export { TRIGGER_TYPES, OBJECT_TYPES, LIQUID_KINDS };