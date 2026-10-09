/* ============================================================
   共享着色器 uniform（主线程与渲染 Worker 共用）
   ------------------------------------------------------------
   这些 uniform 被注入到大量材质的片元着色器里（画面调色矩阵 / 主光跟随高光）。
   主线程写值、渲染 Worker 读值 —— 两侧各持有一份同名模块实例，桥接层每帧把
   主线程这份的数值同步给 Worker 那份（见 render-bridge.js）。

   本模块只依赖 three，可在 Worker 中安全 import（不碰 DOM / localStorage）。
   ============================================================ */
import * as THREE from './three-ns.js';

/* ---------- 画面处理：饱和度 / 染色（全局共享的 3×3 颜色矩阵） ---------- */
export const SCREEN_GRADE = { mat: { value: new THREE.Matrix3() } };

const _grade = { sat: 1, r: 1, g: 1, b: 1 };

/** 更新全局调色矩阵：s = 饱和度倍率（1 不变），r/g/b = 染色（1 = 不染） */
export function setScreenGrade(s, r, g, b) {
  const sat = Number.isFinite(s) ? s : 1;
  const cr = Number.isFinite(r) ? r : 1;
  const cg = Number.isFinite(g) ? g : 1;
  const cb = Number.isFinite(b) ? b : 1;
  if (sat === _grade.sat && cr === _grade.r && cg === _grade.g && cb === _grade.b) return;
  _grade.sat = sat; _grade.r = cr; _grade.g = cg; _grade.b = cb;
  // 亮度守恒的饱和度：out = mix(vec3(luma), c, sat)；再左乘染色（对角矩阵）
  const inv = 1 - sat, lr = 0.2126 * inv, lg = 0.7152 * inv, lb = 0.0722 * inv;
  SCREEN_GRADE.mat.value.set(
    (lr + sat) * cr, lg * cr, lb * cr,
    lr * cg, (lg + sat) * cg, lb * cg,
    lr * cb, lg * cb, (lb + sat) * cb,
  );
}

/** 临时把全局调色矩阵置为恒等：反射捕获这类离屏渲染不能带上画面调色，
    否则染过色的环境贴图会被材质再染一次（反射面出现二次染色） */
export function withScreenGradeOff(fn) {
  const m = SCREEN_GRADE.mat.value;
  const saved = m.clone();
  m.identity();
  try { return fn(); }
  finally { m.copy(saved); }
}

/* ---------- 主光跟随高光（PBR 镜面高光跟随主光 / 太阳） ----------
   方向 / 颜色 / 强度来自这里，builder.applyEnv 在主光变化时写入主线程这份；
   渲染 Worker 那份由桥接层每帧同步。 */
export const SUN_SPEC = {
  dir: { value: new THREE.Vector3(0.5, 0.78, 0.36).normalize() },
  color: { value: new THREE.Color('#fff0d8') },
  strength: { value: 1.35 },
};

/* ---------- 水面泡沫：深度差判定所需的共享 uniform ----------
   原先定义在 materials.js（依赖 DOM），但这批 uniform 由渲染侧（泡沫深度预渲染）
   每帧写入；渲染 Worker 模式下写入方在 Worker，因此下沉到本模块，两侧共用同一份定义。
   materials.js 继续 re-export，主线程既有引用不受影响。 */
export const FOAM_DEPTH = {
  scene: { value: null },                    // sampler2D：不含水体的场景深度
  res: { value: new THREE.Vector2(1, 1) },   // 画布绘制缓冲尺寸（归一化 gl_FragCoord 用）
  near: { value: 0.12 },
  far: { value: 8000 },
  on: { value: 0 },
};

/* ---------- 体积雾 / 体积光共享时间轴（由渲染侧每帧推进） ---------- */
export const VOLUME_UNIFORMS = { time: { value: 0 } };

/* ---------- 液体波动 / 围边泡沫共享时间轴（所有液体材质共享同一份） ----------
   原先定义在 materials.js（依赖 DOM），但渲染 Worker 也要推进它，
   因此下沉到本模块，两侧共用同一份定义。materials.js 继续 re-export。 */
export const LIQUID_UNIFORMS = { time: { value: 0 } };

/* ---------- 传送门外框动画时间轴 ----------
   原先定义在 world/portal.js（依赖 textures/materials 等 DOM 模块），
   渲染 Worker 也要推进它，因此下沉到本模块；portal.js 继续 re-export。 */
export const PORTAL_UNIFORMS = { time: { value: 0 } };

/* ---------- 体积雾 pass 的共享 uniform：所有雾材质引用同一批对象，
   由 VolumeFog 每帧统一改写一次（深度裁剪 + 抖动 + 反投影矩阵）。 ---------- */
export const FOG_PASS_UNIFORMS = {
  depthOn: { value: 0 },
  depthTex: { value: null },
  res: { value: new THREE.Vector2(1, 1) },
  jitter: { value: new THREE.Vector2() },
  invViewProj: { value: new THREE.Matrix4() },
};

/* ---------- 共享 uniform 注册表（跨线程「引用同步」用） ----------
   很多材质把上面这些 uniform **对象**直接挂进自己的 uniforms（同一份引用，改一处全体生效）。
   渲染 Worker 里材质是按描述符重建的：若按值序列化，主线程这边值还是 null（如泡沫深度图尚未
   生成）就会丢字段，且值型 uniform 无法共享同一引用。
   因此桥接层识别「这个 uniform 对象是注册表里的哪一个」，只发一个 key；Worker 侧再取回
   自己线程里的同名对象，于是两侧始终是各自那份模块单例里的同一个引用。 */
export const SHARED_UNIFORMS = {
  'grade.mat': SCREEN_GRADE.mat,
  'sun.dir': SUN_SPEC.dir,
  'sun.color': SUN_SPEC.color,
  'sun.strength': SUN_SPEC.strength,
  'foam.scene': FOAM_DEPTH.scene,
  'foam.res': FOAM_DEPTH.res,
  'foam.near': FOAM_DEPTH.near,
  'foam.far': FOAM_DEPTH.far,
  'foam.on': FOAM_DEPTH.on,
  'vol.time': VOLUME_UNIFORMS.time,
  'liquid.time': LIQUID_UNIFORMS.time,
  'portal.time': PORTAL_UNIFORMS.time,
  'fog.depthOn': FOG_PASS_UNIFORMS.depthOn,
  'fog.depthTex': FOG_PASS_UNIFORMS.depthTex,
  'fog.res': FOG_PASS_UNIFORMS.res,
  'fog.jitter': FOG_PASS_UNIFORMS.jitter,
  'fog.invViewProj': FOG_PASS_UNIFORMS.invViewProj,
};

/** uniform 对象 → key（桥接层 encode 用） */
export const SHARED_UNIFORM_KEY = new Map();
for (const k in SHARED_UNIFORMS) SHARED_UNIFORM_KEY.set(SHARED_UNIFORMS[k], k);
