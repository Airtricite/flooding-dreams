/* ============================================================
   材质库：按属性缓存 MeshStandardMaterial（带引用计数，避免内存泄漏）
   ============================================================ */
import * as THREE from './three-ns.js';
import { getTexture } from './textures.js';
import { resolveBuiltinPair } from './builtin-assets.js';
import { hashStr, clamp } from './util.js';
import { resolveLiquidStyle, deriveDepthTone } from '../world/liquid-presets.js';
import {
  getReflectionTexture, onReflectionChange,
} from '../world/advanced-materials.js';
import { textTexture } from '../world/text-canvas.js';
import {
  analyzeTexture, modulationMatrix, modulationKey, isModulationEnabled, applyModulationShader,
} from './material-modulation.js';

const _cache = new Map();   // key -> { mat, refs }
const _repo = new Map();    // key -> key（便于调试）

/* ---------- 画质相关细节（高光反射 / 接缝闭塞阴影） ---------- */
const _mq = { specular: true, ao: true };

/* ---------- 环境反射强度（关卡设置 env：0~1） ----------
   把天空盒 IBL（scene.environment）对标准材质的影响整体缩放。
   乘在材质 envMapIntensity 上（在 baseEnv 之上），只作用于走标准管线的材质；
   高级材质有自己的反射率，不受影响。 */
let _envInt = 1;
export function setEnvIntensity(k) {
  _envInt = clamp(Number(k), 0, 4);
  for (const rec of _cache.values()) tuneMaterial(rec.mat);
  return _envInt;
}

/** 把画质档位应用到单个材质：
    specular → 降低粗糙度并抬高环境反射，让太阳直射光与天空在表面留下高光；
    ao → 启用几何体上烘焙好的顶点 AO（接缝闭塞阴影） */
function tuneMaterial(mat) {
  if (!mat || !mat.isMeshStandardMaterial) return;
  // 高级材质：反射率 / 粗糙度由预设决定，画质档位不改写它
  if (mat.userData && mat.userData.advMat) return;
  const ud = mat.userData;
  if (ud.baseEnv === undefined) ud.baseEnv = mat.envMapIntensity === undefined ? 1 : mat.envMapIntensity;
  if (ud.baseRough === undefined) ud.baseRough = mat.roughness;
  mat.envMapIntensity = (_mq.specular ? ud.baseEnv * 1.5 : ud.baseEnv) * _envInt;
  mat.roughness = _mq.specular ? clamp(ud.baseRough - 0.3, 0.04, 1) : ud.baseRough;
}

/** 画质变化时刷新所有已缓存的材质（高光 / AO） */
export function applyMaterialQuality(q) {
  _mq.specular = !!(q && q.specular);
  _mq.ao = !!(q && q.ao);
  for (const rec of _cache.values()) {
    tuneMaterial(rec.mat);
    if (rec.vcol && rec.mat.vertexColors !== _mq.ao) {
      rec.mat.vertexColors = _mq.ao;
      rec.mat.needsUpdate = true;
    }
  }
  return _mq;
}

/* ============================================================
   材质着色器补丁（画面处理 / 主光高光 / 智能调制 / 高级材质）
   ------------------------------------------------------------
   实现已抽到 shader-patch-registry.js —— 渲染 Worker 需要复现同一套
   onBeforeCompile 注入，必须能 import 一份不依赖 DOM / localStorage 的纯模块。
   这里 re-export，保持既有调用方 import 路径不变。
   ============================================================ */
import {
  SCREEN_GRADE, setScreenGrade, withScreenGradeOff, SUN_SPEC,
  lightInfluenceUniform, captureFlatColor, applyScreenGrade, applySunSpecular,
  applyAdvancedShaderTracked,
} from './shader-patch-registry.js';
export {
  SCREEN_GRADE, setScreenGrade, withScreenGradeOff, SUN_SPEC,
  lightInfluenceUniform, captureFlatColor, applyScreenGrade, applySunSpecular,
};

/* ---------- 水面泡沫 / 体积雾共享 uniform ----------
   定义已下沉到 shader-uniforms.js（worker 安全），这里 re-export 保持既有 import 路径不变。 */
import { FOAM_DEPTH, VOLUME_UNIFORMS, FOG_PASS_UNIFORMS, LIQUID_UNIFORMS } from './shader-uniforms.js';
export { FOAM_DEPTH, VOLUME_UNIFORMS, FOG_PASS_UNIFORMS, LIQUID_UNIFORMS };

/** 材质相关属性键 */
export function materialKey(p, mapOverride, vcol) {
  const map = mapOverride !== undefined ? mapOverride : (p.paintKey || p.texture || '');
  return hashStr([
    p.color || '#ffffff',
    map,
    p.roughnessMap || '',
    p.normalMap || '',
    p.textureSize || 1,
    p.textureFill || '',
    (p.textureOffsetX || 0) + ',' + (p.textureOffsetY || 0),
    p.transparency ?? 0,
    p.metalness ?? 0.05,
    p.roughness ?? 0.72,
    p.emissive || '#000000',
    p.emissiveIntensity ?? 0,
    p.flatShading ? 1 : 0,
    p.wireframe ? 1 : 0,
    p.side ?? 0,
    p.reflective ? 1 : 0,
    p.neonEdge ? 1 : 0,
    // 智能材质调制（默认关）：同名对象开关不同 → 走不同的着色器程序
    p.smartMod === true ? 1 : 0,
    // 高级材质：预设 + 反射率 + 图案参数（图案是注入着色器的，必须进 key）
    p.advMat || '',
    p.advMat ? (p.reflectivity ?? 1) : '',
    p.advMat ? (p.fxScale ?? 1) + ',' + (p.fxAmp ?? 0) + ',' + (p.fxColor || '') : '',
    // 玻璃：折射率 / 边缘吸光（透明度已在上面的 transparency 里）
    p.advMat ? (p.ior ?? 1.5) + ',' + (p.glassAbsorb ?? 0.5) : '',
    vcol ? 'vc' : '',
  ].join('|'));
}

const _mapCache = new Map();
function resolveMap(p, mapOverride) {
  const id = mapOverride !== undefined ? mapOverride : (p.paintKey || p.texture);
  if (!id || id === 'none') return null;
  if (id.startsWith('paint:')) {
    const fn = _paintResolver;
    return fn ? fn(id.slice(6)) : null;
  }
  if (id.startsWith('url:')) {
    const c = _mapCache.get(id);
    if (c) return c;
    const t = new THREE.TextureLoader().load(id.slice(4));
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    _mapCache.set(id, t);
    return t;
  }
  return getTexture(id);
}

let _paintResolver = null;
/** 注册涂鸦贴图解析器；返回上一个解析器，供销毁时还原
    （编辑器与试玩会话会互相嵌套，各自持有一份 PaintManager） */
export function setPaintResolver(fn) { const prev = _paintResolver; _paintResolver = fn || null; return prev; }

let _stickerResolver = null;
/** 注册贴纸解析器（objectId → { rough, normal } 两张画布贴图）；返回上一个，供销毁时还原 */
export function setStickerResolver(fn) { const prev = _stickerResolver; _stickerResolver = fn || null; return prev; }

/**
 * @param p 对象属性
 * @param mapOverride 贴图覆盖（涂鸦用）
 * @param opts.vcol 几何体上是否烘焙了顶点 AO（接缝闭塞阴影）
 * @param opts.baked 几何体的 uv 是否已按平铺 / 九宫格烘焙过（仅立方体填充模式为真）
 * @param opts.studUV 几何体的 uv 已按 stud 尺度烘焙（低模建模体 / 自定义模型 / 扫掠路径）：
 *    材质层 repeat = 1/贴图尺寸(stud)，每格贴图的世界边长 = 贴图尺寸(stud)，
 *    与方块「平铺不拉伸」同一量纲——小=密集，大=稀疏 */
export function getMaterial(p, mapOverride, opts) {
  const vcol = !!(opts && opts.vcol);
  // 平铺 / 九宫格的重复次数由立方体几何烘焙（见 objectTypes.buildBoxFillGeometry）；
  // 低模建模体 / 自定义模型 / 扫掠路径的 uv 已按 stud 尺度烘焙（studUV）→ repeat = 1/tile；
  // 其余形状的重复次数仍由材质的 repeat 承担。
  const fillBaked = !!(opts && opts.baked);
  const studUV = !!(opts && opts.studUV);
  /** 「贴图尺寸」(stud) → 材质层 repeat：uv 已是 stud 尺度时取倒数 */
  const studRepeat = () => clamp(1 / clamp(Number(p.textureSize) || 1, 0.05, 10000), 0.001, 64);
  const map = resolveMap(p, mapOverride);
  // PBR 贴图（粗糙度 / 法线）：与底贴图一样，导入的图片素材是异步加载的，
  // 必须把「解析出来的贴图实例」编进缓存 key，否则素材就绪后的刷新会命中旧材质
  //
  // 扩充内置素材只列颜色图，同名的法线 / 粗糙度作为附属自动套用
  // （判据与编辑器写回时同源：见 builtin-assets.resolveBuiltinPair。
  //  字段为空 / 'none' → 用配对贴图；字段已是扩充附属 → 跟着底贴图换；
  //  字段是用户自己选的其它贴图 → 原样保留）
  const pair = resolveBuiltinPair(p.texture, p.roughnessMap, p.normalMap);
  const roughMap = pair.rough && pair.rough !== 'none' ? resolveMap({ texture: pair.rough }) : null;
  const normMap = pair.normal && pair.normal !== 'none' ? resolveMap({ texture: pair.normal }) : null;
  // 贴纸层：贴纸同时覆盖它所在的粗糙度 / 法线区域，
  // 用贴纸解析器给出的两张画布贴图整体替换掉对象自带的粗糙度 / 法线贴图
  // （合成时已把对象自带贴图作为底色烘进画布，见 paint.js 的 _compositeMaps）
  let stickerMaps = null;
  if (typeof mapOverride === 'string' && mapOverride.startsWith('paint:') && _stickerResolver) {
    try { stickerMaps = _stickerResolver(mapOverride.slice(6)); } catch (e) { stickerMaps = null; }
  }
  const effRough = stickerMaps ? stickerMaps.rough : roughMap;
  const effNorm = stickerMaps ? stickerMaps.normal : normMap;
  // 解析出来的贴图实例（连同「还没有贴图」这一状态）必须编进缓存 key：
  // 1) 涂鸦贴图是「每个对象一份画布」的独享贴图，导入的关卡副本会原样保留对象 id，
  //    两个关卡里 id 相同的对象否则会命中同一条缓存记录，而那条记录上挂的画布
  //    早随上一关卡的 PaintManager 释放成了 1×1 空白 → 方块整块变黑、贴图全无；
  // 2) 导入的图片素材是异步加载的，首次构建时贴图往往还没就绪（map 为空）。
  //    若只按贴图 id 做 key，素材加载完成后的 syncMaterial 会命中那条「没有贴图」的
  //    旧材质，贴图再也贴不上去（退出关卡重进后自定义贴图不显示）。
  /* ---------- 智能材质调制 ----------
     预运算（贴图平均色相 / 饱和度）在贴图就绪后一次算好并缓存，运行时只生成一个 3×3 矩阵。
     涂鸦 / 贴纸画布不参与（那是用户自己画的内容），高级材质走自己的着色器，也跳过。
     颜色为白 / 灰 / 黑时矩阵为空 → 自动退化成原来的「颜色 × 贴图」相乘，行为不变。 */
  const tintColor = new THREE.Color(p.color || '#ffffff');
  const isPaintMap = !!(map && map.userData && map.userData.paint);
  let modMat = null;
  if (map && !isPaintMap && !(p.advMat && p.advMat !== 'none') && isModulationEnabled(p)) {
    modMat = modulationMatrix(tintColor, analyzeTexture(map));
  }
  // 矩阵指纹进 key：贴图统计是「加载完成后才就绪」的，就绪后指纹变了才会重建材质、补上调制
  const key = materialKey(p, mapOverride, vcol) + '|map:' + (map ? map.uuid : 'none')
    + '|rm:' + (effRough ? effRough.uuid : 'none') + '|nm:' + (effNorm ? effNorm.uuid : 'none')
    + '|bf:' + (fillBaked ? 1 : 0)
    + '|st:' + (studUV ? 1 : 0)
    + (modMat ? '|mod:' + modulationKey(modMat) : '');
  let rec = _cache.get(key);
  if (rec) { rec.refs++; return rec.mat; }
  const transparency = clamp(p.transparency ?? 0, 0, 1);
  const mat = new THREE.MeshStandardMaterial({
    // 调制已把「颜色」烘进矩阵，材质自带的颜色必须给白，否则会被乘第二次
    color: modMat ? new THREE.Color('#ffffff') : tintColor,
    // 贴纸合成贴图里已经烘进了对象自身的粗糙度基准值，材质这层必须给 1，否则会被平方
    roughness: stickerMaps ? 1 : clamp(p.roughness ?? 0.72, 0, 1),
    metalness: clamp(p.metalness ?? 0.05, 0, 1),
    transparent: transparency > 0.001,
    opacity: 1 - transparency,
    map,
    vertexColors: vcol && _mq.ao,
    flatShading: !!p.flatShading,
    wireframe: !!p.wireframe,
    side: p.side === 1 ? THREE.DoubleSide : THREE.FrontSide,
    depthWrite: transparency > 0.55 ? false : true,
  });
  if (p.emissive && p.emissive !== '#000000' && (p.emissiveIntensity ?? 0) > 0) {
    mat.emissive = new THREE.Color(p.emissive);
    mat.emissiveIntensity = p.emissiveIntensity;
  }
  if (mat.map) {
    // 涂鸦画布贴图是每个对象独享的，克隆会导致画布更新后 GPU 贴图不再刷新（涂鸦画不出墨）；
    // 它同时也是“表面贴图”，必须 1:1 铺满（repeat/offset 由合成画布内部处理）
    const isPaint = !!(mat.map.userData && mat.map.userData.paint);
    // 平铺 / 九宫格的重复次数已由几何 uv 烘焙（见 objectTypes.buildBoxFillGeometry），
    // 材质这一层不能再乘一次 repeat，否则会被重复叠加。
    // 仅“拉伸”模式在这里把「贴图尺寸」当作重复次数使用。
    const baked = fillBaked && !isPaint;
    const r = baked ? 1
      : (studUV && !isPaint) ? studRepeat()
      : clamp(Number(p.textureSize) || 1, 0.01, 64);
    if (!isPaint) {
      mat.map = mat.map.clone();
      mat.map.userData._ownClone = true;   // 材质私有的克隆贴图：材质释放时一并卸载（见 releaseMaterial）
      mat.map.needsUpdate = true;
    }
    const flat = isPaint;
    mat.map.wrapS = mat.map.wrapT = isPaint ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    mat.map.repeat.set(flat ? 1 : r, flat ? 1 : r);
    mat.map.offset.set(flat ? 0 : (Number(p.textureOffsetX) || 0), flat ? 0 : (Number(p.textureOffsetY) || 0));
    mat.map.anisotropy = 4;
    mat.map.colorSpace = THREE.SRGBColorSpace;
    if (transparency > 0.001) mat.map.transparent = true;
  }
  /* ---------- PBR 贴图：粗糙度图 / 法线图 ----------
     用线性色彩空间采样（不做 sRGB 解码）；平铺 / 偏移与底贴图保持同一套规则。
     每个材质克隆一份：同一张素材可能被多个对象按不同尺寸 / 偏移引用 */
  if (stickerMaps) {
    // 贴纸合成的粗糙度 / 法线画布是每对象独享的：不克隆、repeat / offset 固定为 1 / 0
    if (stickerMaps.rough) mat.roughnessMap = stickerMaps.rough;
    if (stickerMaps.normal) mat.normalMap = stickerMaps.normal;
  } else if (roughMap || normMap) {
    // 法线 / 粗糙度图跟随「底贴图」的实际 uv 变换：repeat / offset / 循环方式照抄底图，
    // 保证两张图在同一物件上铺贴的大小与底图完全一致（“自动拉伸至底图大小”）。
    // 底图是涂鸦画布等特殊情况（1:1 满铺、ClampToEdge）时也能自动对齐；
    // 没有底贴图（mat.map 为空）时才退回按 textureSize / textureFill 独立计算。
    const hasColor = !!mat.map;
    // 平铺 / 九宫格的重复次数已由几何 uv 烘焙（与底贴图一致），这里不再乘 repeat
    const baked = fillBaked;
    const r = baked ? 1 : (studUV ? studRepeat() : clamp(Number(p.textureSize) || 1, 0.01, 64));
    const ox = Number(p.textureOffsetX) || 0, oy = Number(p.textureOffsetY) || 0;
    const wrapS = hasColor ? mat.map.wrapS : THREE.RepeatWrapping;
    const wrapT = hasColor ? mat.map.wrapT : THREE.RepeatWrapping;
    const repX = hasColor ? mat.map.repeat.x : r;
    const repY = hasColor ? mat.map.repeat.y : r;
    const offX = hasColor ? mat.map.offset.x : ox;
    const offY = hasColor ? mat.map.offset.y : oy;
    const make = (src) => {
      const t = src.clone();
      t.userData._ownClone = true;         // 材质私有的克隆贴图：材质释放时一并卸载（见 releaseMaterial）
      t.colorSpace = THREE.NoColorSpace;   // 线性采样，绝不能跟随底图的 sRGB
      t.wrapS = wrapS; t.wrapT = wrapT;
      t.repeat.set(repX, repY);
      t.offset.set(offX, offY);
      t.anisotropy = 4;
      t.needsUpdate = true;
      return t;
    };
    if (roughMap) mat.roughnessMap = make(roughMap);
    if (normMap) mat.normalMap = make(normMap);
  }
  if (p.envMapIntensity !== undefined) mat.envMapIntensity = p.envMapIntensity;
  /* ---------- 高级材质（内置特殊 / 特效表面材质） ----------
     反射：优先用一次性的场景立方体捕获（真实反映关卡里的物体），
     没有捕获结果时退回 scene.environment 的天空 IBL。 */
  if (p.advMat && p.advMat !== 'none') {
    mat.userData.advMat = p.advMat;
    const refl = getReflectionTexture();
    if (refl) mat.envMap = refl;
    mat.envMapIntensity = clamp(Number(p.reflectivity ?? 1) || 0, 0, 8);
    applyAdvancedShaderTracked(mat, p);   // 图案类注入特效；玻璃类注入立方体折射（并记录参数供 Worker 复现）
  }
  // 智能调制：在 <map_fragment> 之后追加调制代码（贴图色 → 线性后再重上色）
  if (modMat) applyModulationShader(mat, modMat);
  tuneMaterial(mat);      // 高光反射 / 接缝闭塞阴影（按画质档位）
  // 主光跟随高光：让 PBR 法线高光随太阳移动（高级材质有自己的反射，跳过）
  if (!(mat.userData && mat.userData.advMat)) applySunSpecular(mat);
  applyScreenGrade(mat);  // 画面处理：饱和度 / 染色（注入在色调映射之前）
  rec = { mat, refs: 1, key, vcol };
  _cache.set(key, rec);
  _repo.set(key, key);
  return mat;
}

/** 反射贴图重新捕获后，把新贴图刷到已缓存的高级材质上 */
onReflectionChange((tex) => {
  for (const rec of _cache.values()) {
    const m = rec.mat;
    if (!m.userData || !m.userData.advMat) continue;
    if (m.envMap === tex) continue;
    m.envMap = tex || null;
    m.needsUpdate = true;
  }
});

export function releaseMaterial(mat) {
  if (!mat) return;
  for (const [k, rec] of _cache) {
    if (rec.mat === mat) {
      rec.refs--;
      if (rec.refs <= 0) {
        // 材质私有的克隆贴图（底图 / 粗糙度图 / 法线图）必须显式卸载：
        // Material.dispose() 不管贴图，切到 None / 换图后旧贴图会一直占着 GPU 显存。
        // 涂鸦画布 / 贴纸画布 / 共享源贴图没有 _ownClone 标记，不会被误释放。
        for (const t of [mat.map, mat.roughnessMap, mat.normalMap]) {
          if (t && t.userData && t.userData._ownClone) t.dispose();
        }
        rec.mat.dispose();
        _cache.delete(k);
      }
      return;
    }
  }
}

export function applyMaterial(mesh, p, mapOverride, opts) {
  const next = getMaterial(p, mapOverride, opts);
  // 材质没变：把刚才 getMaterial 多拿的那次引用立刻还回去。
  // 不还的话引用计数只涨不落，材质永远删不掉：画布被释放后它会以「空白贴图」的
  // 形式留在缓存里被后续关卡命中。
  if (mesh.material === next) { releaseMaterial(next); return next; }
  if (mesh.userData._matKey !== undefined) releaseMaterial(mesh.material);
  mesh.material = next;
  mesh.userData._matKey = next.uuid;
  return next;
}

/* 液体波动共享 uniform（LIQUID_UNIFORMS）定义在 shader-uniforms.js（worker 安全），
   顶部已 import + re-export，此处不再重复定义。 */

/* 液体顶点着色器附加声明 */
const LIQ_VERT_HEAD = `
varying vec3 vLiqWP;    // 世界坐标
varying float vLiqLY;   // 局部 y（单位盒：-0.5 底 ~ 0.5 顶）
varying float vLiqH;    // 液体在世界空间的高度(stud)
varying vec3 vLiqWN;    // 世界法线（水纹只铺朝上的液面）
`;
/* 场景深度图的安全采样（液体能见度 / 平台过渡 与 围边泡沫共用）
   ------------------------------------------------------------
   这张深度图是半分辨率的，且只能用 Nearest 过滤：一个深度纹素会同时压住轮廓两侧的
   屏幕像素，于是紧贴物体轮廓的**水面**像素会采到那个物体的深度（水面片元不可能真的被
   前景挡住 —— 那种片元早在深度测试就被丢弃了，这纯属采样泄漏）。泄漏的后果有两种：
     · 采到的深度比水面还近（物体高出液面时就是这样）→ span 被 max(...,0) 归零 →
       此处水体突然只剩 10% 不透明度，露出背后的暗部 → 物体轮廓上一圈细锯齿黑边；
     · 泡沫那边同一个采样让 diffZ 变负 → step(0,diff) 把泡沫整条抹掉 → 泡沫环上出现缺口。
   这里取 2×2 邻域里**最远**的深度当作“背后场景”：泄漏的永远是更近的前景，取最远就把它
   排除干净；同时邻域取值把最近邻过滤留下的 2×2 硬跳变抹平（不再逐纹素突变）。
   深度缓冲值越大越远，所以直接比大小即可。偏移量 = 半个纹素 = 1 个全分辨率像素。 */
const SCENE_DEPTH_MAX_SAMPLE = `
float sampleSceneDepthFar(vec2 uv, vec2 texel) {
  return max(max(texture2D(uSceneDepth, uv + vec2(-texel.x, -texel.y)).x,
                 texture2D(uSceneDepth, uv + vec2( texel.x, -texel.y)).x),
             max(texture2D(uSceneDepth, uv + vec2(-texel.x,  texel.y)).x,
                 texture2D(uSceneDepth, uv + vec2( texel.x,  texel.y)).x));
}
`;

/* 液体片元着色器附加声明 + 水纹图案库 */
const LIQ_FRAG_HEAD = `
uniform float uRipTime;
uniform float uRipScale;
uniform float uRipSpeed;
uniform float uRipStrength;
uniform float uWarpScale;   // 扭曲场大小（标准值倍数）
uniform float uWarpSpeed;   // 扭曲速度（标准值倍数，1 = 水纹速度的 0.618 倍）
uniform float uLyCount;
uniform vec4 uLyA[6];    // x=图案类型 y=密度 z=速度 w=强度
uniform vec2 uLyD[6];    // 图案方向
uniform vec3 uRipTint;   // 水纹高光染色
uniform float uDepthOn;
uniform float uDepthAbsorb;    // 深度吸收密度（越大越快变暗）
uniform float uDepthSat;       // 深处饱和度倍率（锁定色相）
uniform float uDepthLight;     // 深处亮度倍率（0 = 全黑，1 = 不变）
uniform float uVisDepth;       // 能见深度(stud)：视线在水里穿过该长度即完全看不见（0 = 清澈见底）
uniform float uPlatDepth;      // 平台过渡深度(stud)：水面离水底多深才达到满不透明度（0 = 关闭）
uniform vec3 uTurbColor;       // 浑浊色（默认跟随液体颜色）
uniform sampler2D uSceneDepth; // 不含水体的场景深度图（能见度用）
uniform vec2 uResolution;
uniform float uCamNear;
uniform float uCamFar;
uniform float uDepthTexOn;
varying vec3 vLiqWP;
varying float vLiqLY;
varying float vLiqH;
varying vec3 vLiqWN;

/* 深度缓冲值(0..1) → 视空间距离（与围边泡沫同一套线性化） */
float lqLinearZ(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uCamNear * uCamFar) / (uCamFar + uCamNear - z * (uCamFar - uCamNear));
}

/* ---- HSL 工具：深处色只在液面自身色相上压饱和度 / 亮度，绝不换色相 ---- */
vec3 lqRgb2Hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  float h = 0.0, s = 0.0;
  if (d > 1e-5) {
    s = l > 0.5 ? d / max(2.0 - mx - mn, 1e-5) : d / max(mx + mn, 1e-5);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
float lqHue2Rgb(float p, float q, float tt) {
  if (tt < 0.0) tt += 1.0;
  if (tt > 1.0) tt -= 1.0;
  if (tt < 1.0 / 6.0) return p + (q - p) * 6.0 * tt;
  if (tt < 0.5) return q;
  if (tt < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - tt) * 6.0;
  return p;
}
vec3 lqHsl2Rgb(vec3 hsl) {
  float s = clamp(hsl.y, 0.0, 1.0);
  float l = clamp(hsl.z, 0.0, 1.0);
  if (s < 1e-5) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(lqHue2Rgb(p, q, hsl.x + 1.0 / 3.0),
              lqHue2Rgb(p, q, hsl.x),
              lqHue2Rgb(p, q, hsl.x - 1.0 / 3.0));
}

/* ---- 水纹图案库（20 种，可任意叠层）
   0 规则波纹  1 噪声浪  2 焦散  3 方向条纹  4 等离子  5 气泡  6 域扭曲  7 细胞浮沫
   8 同心涟漪  9 漩涡   10 脊状浪 11 干涉网格 12 拉丝流 13 大理石 14 油膜干涉
   15 星尘     16 涟漪扩散 17 鳞片  18 脉动团块 19 沙纹
   （下标与 liquid-presets.js 的 LIQUID_LAYER_TYPES 一一对应） ---- */
float lqHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float lqNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lqHash(i), lqHash(i + vec2(1.0, 0.0)), f.x),
             mix(lqHash(i + vec2(0.0, 1.0)), lqHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float lqFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * lqNoise(p); p = p * 2.03 + vec2(11.3, 7.7); a *= 0.5; }
  return s;
}
/* 平滑噪声位移场：两级 value noise（smoothstep 插值，连续无极值台阶）叠加成的
   二维扭曲场。返回各轴 -1..1 的连续偏移，本身没有任何格点，
   用它去弯折水纹的相位与明暗，可彻底打散周期性。 */
vec2 lqWarp(vec2 p) {
  return (vec2(lqNoise(p * 0.9 + 3.1), lqNoise(p * 1.1 + 11.7)) - 0.5)
       + (vec2(lqNoise(p * 2.3 - 5.3), lqNoise(p * 2.7 + 2.9)) - 0.5) * 0.5;
}
/* 细胞噪声：返回最近特征点距离（F1） */
float lqCell(vec2 p) {
  vec2 n = floor(p), f = fract(p);
  float d = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = vec2(lqHash(n + g), lqHash(n + g + vec2(31.7, 17.3)));
      d = min(d, length(g + o - f));
    }
  }
  return d;
}
${SCENE_DEPTH_MAX_SAMPLE}
`;
/* 注入到 <color_fragment> 之后：① 能见深度雾（垫底） ② 多层动态水纹 ③ 深水变暗 */
const LIQ_FRAG_BODY = `
  // 视线方向的世界竖直分量 |dy|/|d|：平台过渡与深水吸收都要用它，
  // 原来两处各自 normalize 一次（各含一次 sqrt + 三次除法），这里只算一次。
  float lqVy = 1.0;
  if (uDepthOn > 0.5 || (uDepthTexOn > 0.5 && (uVisDepth > 0.001 || uPlatDepth > 0.001))) {
    vec3 vdv = vLiqWP - cameraPosition;
    lqVy = abs(vdv.y) / max(length(vdv), 1e-4);
  }
  // ---- 能见深度雾（垫底） + 平台过渡 ----
  // 两个效果用的是同一张场景深度图和同一条视线跨度，合并成一次深度取样 + 一次线性化，
  // 避免每个水面片元取两遍深度图（这是全屏纹理读取，不能指望编译器一定帮你合并）
  if (uDepthTexOn > 0.5 && (uVisDepth > 0.001 || uPlatDepth > 0.001)) {
    // 本片元(水面) 与 其背后场景 的视空间距离 = 视线在水里穿过的长度(stud)
    // 深度图按 2×2 邻域取最远值（见 sampleSceneDepthFar）：紧贴物体轮廓的水面像素
    // 否则会采到该物体的深度，水体会在那里突然变透明 → 轮廓上一圈细锯齿黑边
    float span = max(lqLinearZ(sampleSceneDepthFar(gl_FragCoord.xy / uResolution, 1.0 / uResolution))
                     - lqLinearZ(gl_FragCoord.z), 0.0);
    // 能见深度：水面往下能看多深（背后物体在水里越深越看不见，逐渐没入浑浊色）
    // 放在最前面当“底色”：水纹 / 深水变暗都叠在它上面，不会被浑浊盖掉
    if (uVisDepth > 0.001) {
      float fog = smoothstep(0.0, uVisDepth, span);   // 达到能见深度即完全看不见
      diffuseColor.rgb = mix(diffuseColor.rgb, uTurbColor, fog);
      diffuseColor.a = mix(diffuseColor.a, 1.0, fog);
    }
    // 平台过渡：按「水面离水底平台的距离」调不透明度（水沫是独立材质，不受影响）
    // 浅 → 只有满不透明度的 10%；达到平台过渡深度（默认 4 stud）→ 满不透明度
    if (uPlatDepth > 0.001) {
      float floorDist = span * lqVy;                        // 水面 → 水底平台的垂直距离(stud)
      float solid = smoothstep(0.0, uPlatDepth, floorDist);
      diffuseColor.a = mix(diffuseColor.a * 0.1, diffuseColor.a, solid);
    }
  }
  // ---- 多层动态水纹（图案类型见 js/world/liquid-presets.js） ----
  // 只有「朝上的液面」才铺水纹：竖直侧壁 / 朝下的底面按世界 xz 投影只会把图案
  // 拉成条纹，既不好看又要全额付出噪声代价，这里按世界法线的朝上程度直接渐出。
  vec2 lqRq = vLiqWP.xz * (0.5 * uRipScale);
  // 屏幕足迹 LOD：一个屏幕像素在水纹空间里跨过的距离。超过约一个波长时，
  // 水纹已经在做子像素采样 —— 既看不清又会在相机移动时闪烁。
  // 于是按足迹把水纹整块淡出（等于给程序化水纹做了一次 mip 截断），
  // 远水面上那几十次 hash + 位移场被完全跳过，近处细节分毫不动。
  // 注意：导数必须写在最外层的统一控制流里（下面 if 带逐片元的 upFace，不能包住它）
  float lqRipLod = max(length(dFdx(lqRq)), length(dFdy(lqRq)));
  float lqRipFade = 1.0 - smoothstep(0.55, 2.0, lqRipLod);
  float lqUpFace = smoothstep(-0.05, 0.4, vLiqWN.y);
  float lqRipW = lqRipFade * lqUpFace;
  if (uLyCount > 0.5 && uRipStrength > 0.001 && lqRipW > 0.004) {
    vec2 q = lqRq;
    float t = uRipTime * uRipSpeed;
    // 位移场：整片水纹的走向被连续弯折，不再贴着世界网格。
    // 每个片元只采样这一次（2 个倍频 × 2 轴 = 4 次噪声），所有层共用；
    // lqWarp 内部已经含 0.9/1.1/2.3/2.7 四个频率，最细的一档比水纹波长还细，
    // 所以「大尺度弯曲 + 小尺度打散」两种作用都在，不需要再叠一层。
    // 三个量各由编辑器参数决定：
    //  · 扭曲强度 = 水纹速度 × 0.1（位移场弯折水纹坐标的幅度）
    //  · 扭曲速度 = 水纹速度 × 0.618 × uWarpSpeed（uWarpSpeed 为标准值倍数，1 = 0.618 倍）
    //  · 扭曲场大小 = uWarpScale（标准值倍数：>1 场更大更缓，<1 更细更密）
    float wStrength = uRipSpeed * 0.1;
    float wSpeed = uRipSpeed * 0.618 * uWarpSpeed;
    vec2 wdir = normalize(vec2(0.13, 0.085));   // 漂移方向（沿用原对角方向）
    vec2 dw = lqWarp(q * 0.25 / uWarpScale + wdir * (uRipTime * wSpeed));
    q += dw * wStrength;
    float acc = 0.0, wsum = 0.0;
    for (int i = 0; i < 6; i++) {
      if (float(i) < uLyCount) {
        vec4 A = uLyA[i];
        // 各层加不同的固定偏移，避免多层对齐成规整图案
        vec2 uv = (q + vec2(float(i) * 13.7, float(i) * 7.3)) * A.y;
        vec2 dir = uLyD[i];
        if (dir.x != 0.0 || dir.y != 0.0) uv = vec2(uv.x * dir.x - uv.y * dir.y, uv.x * dir.y + uv.y * dir.x);
        float sp = A.z * t;
        float v = 0.5;
        if (A.x < 0.5) {          // 规则波纹：相位（由上面的位移场弯折）与明暗都随平滑噪声起伏
          float a = sin(uv.x * 2.2 + sp);
          float b = cos(uv.y * 1.9 - sp * 0.85);
          float amp = 0.7 + 0.6 * (dw.x + 0.5);   // 复用位移场做明暗强度调制，零额外噪声采样
          v = 0.5 + 0.5 * a * b * amp;
        } else if (A.x < 1.5) {   // 噪声浪
          v = lqFbm(uv * 1.7 + vec2(sp * 0.5, -sp * 0.35));
        } else if (A.x < 2.5) {   // 焦散：互相耦合的波面 + 位移场弯折，亮斑散乱不成网格
          vec2 w = uv * 1.1 + vec2(sp * 0.4, sp * 0.28);
          float a = sin(w.x * 1.7 + sin(w.y * 1.5 + sp * 0.2) * 2.4);
          float b = sin(w.y * 1.9 + sin(w.x * 1.6 - sp * 0.15) * 2.4);
          v = pow(clamp(1.0 - abs(a * b) * 0.8, 0.0, 1.0), 2.2);
        } else if (A.x < 3.5) {   // 方向条纹
          v = 0.5 + 0.5 * sin(uv.x * 3.0 - sp * 1.4 + lqFbm(uv * 0.5) * 2.0);
        } else if (A.x < 4.5) {   // 等离子
          v = 0.5 + 0.25 * sin(uv.x * 1.3 + sp) + 0.25 * sin(uv.y * 1.1 - sp * 0.7)
                + 0.25 * sin((uv.x + uv.y) * 0.9 + sp * 0.4);
        } else if (A.x < 5.5) {   // 气泡
          v = smoothstep(0.45, 0.05, lqCell(uv * 2.6 + vec2(sp * 0.25, -sp * 0.2)));
        } else if (A.x < 6.5) {   // 域扭曲
          vec2 w = vec2(lqFbm(uv * 0.7 + sp * 0.3), lqFbm(uv * 0.7 + 5.2 - sp * 0.24));
          v = lqFbm(uv * 1.4 + w * 1.8);
        } else if (A.x < 7.5) {   // 细胞浮沫
          v = 1.0 - smoothstep(0.0, 0.55, lqCell(uv * 1.9 - vec2(sp * 0.18, sp * 0.14)));
        } else if (A.x < 8.5) {   // 同心涟漪
          v = 0.5 + 0.5 * sin(length(uv) * 2.4 - sp * 1.6 + dw.x * 2.0);
        } else if (A.x < 9.5) {   // 漩涡：极坐标螺旋臂
          vec2 cc = uv - 0.5;
          float cr = length(cc) * 5.0 + 0.001;
          float ca = atan(cc.y, cc.x);
          v = 0.5 + 0.5 * sin(ca * 3.0 + cr * 2.2 - sp * 1.4);
        } else if (A.x < 10.5) {  // 脊状浪：锐化的噪声脊线，像流动筋脉
          float rn = lqFbm(uv * 1.3 + vec2(sp * 0.35, -sp * 0.22));
          v = 1.0 - abs(rn * 2.0 - 1.0);
          v *= v;
        } else if (A.x < 11.5) {  // 干涉网格：两组正交波叠出的摩尔纹
          v = 0.5 + 0.5 * sin(uv.x * 2.6 + sp) * sin(uv.y * 2.35 - sp * 0.9);
        } else if (A.x < 12.5) {  // 拉丝流：沿一个方向强烈拉伸的细密条纹
          v = lqFbm(vec2(uv.x * 1.2, uv.y * 0.28) + vec2(-sp * 0.8, sp * 0.05));
        } else if (A.x < 13.5) {  // 大理石：噪声扭曲的平行纹带
          float mm = lqFbm(uv * 0.8 + dw * 0.6);
          v = 0.5 + 0.5 * sin((uv.x + uv.y * 0.35) * 2.2 + mm * 5.0 - sp);
        } else if (A.x < 14.5) {  // 油膜干涉：多层薄膜叠加出的细密条带
          float os = sin(uv.x * 3.4 + sp) + sin(uv.y * 2.8 - sp * 1.3)
                   + sin((uv.x - uv.y) * 4.1 + sp * 0.7);
          v = 0.5 + 0.5 * sin(os * 1.6);
        } else if (A.x < 15.5) {  // 星尘：稀疏亮点闪烁
          float sh = lqHash(floor(uv * 3.0) + floor(sp * 0.5 + 13.0));
          v = smoothstep(0.9, 1.0, sh) * (0.5 + 0.5 * sin(sp * 3.0 + sh * 40.0));
        } else if (A.x < 16.5) {  // 涟漪扩散：从随机格点扩散的水波
          float cd = lqCell(uv * 2.0 + vec2(sp * 0.1, 0.0));
          v = 0.5 + 0.5 * sin(cd * 12.0 - sp * 2.0);
        } else if (A.x < 17.5) {  // 鳞片：错位叠压的圆弧（鱼鳞 / 水波鳞纹）
          vec2 sg = uv * 2.2;
          sg.x += mod(floor(sg.y), 2.0) * 0.5;
          vec2 sf = fract(sg) - 0.5;
          v = 0.5 + 0.5 * sin(length(sf) * 12.0 - sp * 1.5);
        } else if (A.x < 18.5) {  // 脉动团块：缓慢膨胀收缩的圆团
          v = smoothstep(0.35, 0.75, lqFbm(uv * 0.9 + vec2(sp * 0.2, sp * 0.1)));
        } else {                  // 沙纹：风向交错的不对称波纹条带
          float sw = lqFbm(vec2(uv.x * 0.6, uv.y * 2.4) + vec2(sp * 0.4, 0.0));
          v = 0.5 + 0.5 * sin(uv.y * 4.0 + sw * 3.0 - sp * 1.2);
        }
        acc += clamp(v, 0.0, 1.0) * A.w;
        wsum += A.w;
      }
    }
    float lum = wsum > 0.0 ? acc / wsum : 0.5;
    float k = (lum - 0.5) * uRipStrength * lqRipW;
    diffuseColor.rgb *= clamp(1.0 + k * 1.15, 0.22, 2.4);
    diffuseColor.rgb = mix(diffuseColor.rgb, uRipTint, clamp(max(k, 0.0) * 0.8, 0.0, 0.62));
  }
  // ---- 越深越厚越暗（锁色相，可调饱和度 / 亮度） ----
  if (uDepthOn > 0.5) {
    // 视线穿过水体的“垂直落差”：顶/底面 = 整个水深，侧面 = 该点距液面的深度
    float drop = mix((0.5 - vLiqLY) * vLiqH, vLiqH, smoothstep(0.35, 0.5, vLiqLY));
    float thick = drop / max(lqVy, 0.22);
    float att = exp(-uDepthAbsorb * thick);
    // 深处色 = 液面自身色相 + 压过的饱和度 / 亮度（不再乘固定深色，避免偏色发脏）
    vec3 hsl = lqRgb2Hsl(diffuseColor.rgb);
    vec3 deep = lqHsl2Rgb(vec3(hsl.x, hsl.y * uDepthSat, hsl.z * uDepthLight));
    diffuseColor.rgb = mix(deep, diffuseColor.rgb, att);
  }
`;

/* 液体：在水渲染（含可选的水面传送门）之后记下「无光照的原始色」，供光照影响按比例回退 */
const LI_FLAT_CAPTURE = '\n  #define USE_LI_FLAT 1\n  vec3 _liFlat = clamp(diffuseColor.rgb, 0.0, 1.0);\n';

/**
 * 液体材质（半透明、多层水纹、深水吸收；水面保持静止不做顶点波动）
 * @param ptl 可选。「挂在液体下的传送门」注入包（由 builder 组装，避免 materials ↔ portal 循环导入）：
 *            { key, core, head, body, uniforms }，液体跑完自己的水渲染后再在水面上画这个视差窗口。
 *            挂了传送门的液体必须是独立材质实例 —— key 里带上 ptl.key。
 */
export function getLiquidMaterial(kind, p = {}, ptl = null) {
  const style = resolveLiquidStyle(p);
  const li = lightInfluenceUniform(p.lightInfluence);
  const preset = style.layers || [];
  // rippleLayers：0 = 用预设的全部层；1..6 = 只取前 N 层（可自行叠层）
  const want = clamp(Math.round(Number(p.rippleLayers ?? 0)), 0, 6);
  const n = want > 0 ? Math.min(want, preset.length) : preset.length;
  const ripScale = clamp(Number(p.rippleScale ?? 1), 0.05, 12);
  const ripSpeed = Number(p.rippleSpeed ?? 1);
  const ripStrength = clamp(Number(p.rippleStrength ?? 1), 0, 3);
  // 扭曲场大小（标准值倍数）：1 = 标准，>1 场更大更缓，<1 更细更密
  const warpScale = clamp(Number(p.warpScale ?? 1), 0.05, 12);
  // 扭曲速度（标准值倍数）：1 = 水纹速度的 0.618 倍
  const warpSpeed = clamp(Number(p.warpSpeed ?? 1), 0, 20);
  const depthOn = p.depthDarken !== false;
  const color = p.color || style.color || '#2f8fd8';
  const deepRef = p.deepColor || style.deepColor || '#062a40';
  // 深度吸收：锁定液面色相，只用「深处饱和度 / 亮度倍率」（未给定则按预设深色反推）
  const tone = deriveDepthTone(color, deepRef, p.depthSat, p.depthLight);
  const absorb = clamp(Number(p.depthAbsorb ?? style.absorb ?? 0.5), 0, 1);
  // 能见深度(stud)：水面往下能看多深，0 = 清澈见底
  const visDepth = clamp(Number(p.visibilityDepth ?? 0), 0, 2000);
  // 平台过渡深度(stud)：水面离水底平台多深时水才达到满不透明度，0 = 关闭
  const platDepth = clamp(Number(p.platformDepth ?? 4), 0, 500);
  // 液体对象存的是「透明度」(0=不透明)，预设外观与面板改的都是它 → 换算成材质 opacity
  const transparency = p.transparency !== undefined ? clamp(Number(p.transparency) || 0, 0, 1) : null;
  // 浑浊色：默认跟随液体自身颜色，可用「浑浊色跟随液体颜色」开关 + 自定义色覆盖
  const turbColor = (p.turbidityFollow === false && p.turbidityColor) ? p.turbidityColor : color;
  const tint = p.rippleTint || style.tint || p.color || '#ffffff';
  const key = ['liquid', kind, style.id, n, ripScale, ripSpeed, ripStrength, warpScale, warpSpeed, depthOn ? 1 : 0,
    deepRef, tone.sat, tone.light, visDepth, platDepth, turbColor, absorb, tint, color,
    p.opacity ?? '', transparency ?? '', p.emissive ?? '',
    p.emissiveIntensity ?? 0, p.roughness ?? '', p.metalness ?? '',
    p.lightInfluence ?? 1,
    ptl ? ptl.key : ''].join('|');
  let rec = _cache.get(key);
  if (rec) { rec.refs++; return rec.mat; }
  const opacity = p.opacity !== undefined ? p.opacity
    : (transparency !== null ? 1 - transparency : (style.opacity ?? 0.62));
  const rough = clamp(Number(p.roughness ?? style.roughness ?? 0.08), 0, 1);
  const metal = clamp(Number(p.metalness ?? style.metalness ?? 0.28), 0, 1);
  const emi = p.emissiveIntensity !== undefined ? p.emissiveIntensity : (style.emissiveIntensity ?? 0.18);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    roughness: rough,
    metalness: metal,
    side: THREE.DoubleSide,
    depthWrite: false,
    emissive: new THREE.Color(p.emissive || style.emissive || color),
    emissiveIntensity: emi,
  });
  mat.userData.liquid = true;
  tuneMaterial(mat);      // 水面高光反射（AO 会自动跳过液体）
  // 多层水纹 + 深度吸收：只改着色器注入，零 CPU 开销（水面本身保持静止）
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRipTime = LIQUID_UNIFORMS.time;
    shader.uniforms.uRipScale = { value: ripScale };
    shader.uniforms.uRipSpeed = { value: ripSpeed };
    shader.uniforms.uRipStrength = { value: ripStrength };
    shader.uniforms.uWarpScale = { value: warpScale };
    shader.uniforms.uWarpSpeed = { value: warpSpeed };
    shader.uniforms.uLyCount = { value: n };
    shader.uniforms.uRipTint = { value: new THREE.Color(tint) };
    shader.uniforms.uDepthOn = { value: depthOn ? 1 : 0 };
    shader.uniforms.uDepthAbsorb = { value: absorb * 0.03 };
    shader.uniforms.uDepthSat = { value: tone.sat };
    shader.uniforms.uDepthLight = { value: tone.light };
    shader.uniforms.uVisDepth = { value: visDepth };
    shader.uniforms.uPlatDepth = { value: platDepth };
    shader.uniforms.uTurbColor = { value: new THREE.Color(turbColor) };
    // 能见度雾需要“不含水体的场景深度图”（与围边泡沫共用同一张预渲染深度图）
    shader.uniforms.uSceneDepth = FOAM_DEPTH.scene;
    shader.uniforms.uResolution = FOAM_DEPTH.res;
    shader.uniforms.uCamNear = FOAM_DEPTH.near;
    shader.uniforms.uCamFar = FOAM_DEPTH.far;
    shader.uniforms.uDepthTexOn = FOAM_DEPTH.on;
    // 水纹层：类型 / 密度 / 速度 / 强度 + 方向向量
    const A = [], D = [];
    for (let i = 0; i < 6; i++) {
      const L = preset[i] || [1, 1, 0, 0, 0];
      A.push(new THREE.Vector4(L[0] || 0, L[1] ?? 1, L[2] ?? 0, (L[4] ?? 0.4) * ripStrength));
      const rad = ((L[3] || 0) * Math.PI) / 180;
      D.push(new THREE.Vector2(Math.cos(rad), Math.sin(rad)));
    }
    shader.uniforms.uLyA = { value: A };
    shader.uniforms.uLyD = { value: D };
    // 液体子集传送门：共享传送门的 uniform 对象（builder 逐帧写，两边看到同一份数据）
    if (ptl) Object.assign(shader.uniforms, ptl.uniforms);

    shader.vertexShader = LIQ_VERT_HEAD + shader.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLiqWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vLiqLY = position.y;
        vLiqH = length(modelMatrix[1].xyz);
        vLiqWN = normalize(mat3(modelMatrix) * normal);`);

    // 注入顺序：先跑完液体自己的水渲染，再叠传送门的水面窗口
    shader.fragmentShader = (ptl ? LIQ_FRAG_HEAD + ptl.core + ptl.head : LIQ_FRAG_HEAD)
      + shader.fragmentShader.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n' + LIQ_FRAG_BODY + (ptl ? ptl.body : '') + LI_FLAT_CAPTURE);
  };
  // 注入过 onBeforeCompile 的材质必须让 three 的程序缓存 key 带上源码版本号，
  // 否则同一页面内重建的液体材质会命中旧程序、新着色器永远不生效
  mat.customProgramCacheKey = () => (ptl ? 'liquidfx5p' : 'liquidfx5');
  applyScreenGrade(mat, li);  // 画面处理：饱和度 / 染色 + 光照影响（链在液体注入之后）
  _cache.set(key, { mat, refs: 1, key });
  return mat;
}

/* ============================================================
   围边泡沫 edgefoam 材质（自绘 ShaderMaterial，不参与光照）
   —— 直接渲染在液体自身的几何上（共用 geometry + transform），
      所以立方体 / 球 / 多边形柱 / 任意异形网格都不会错位。
      泡沫 = 液体自身外沿 + 深度差：
      预渲染一张不含水体的场景深度图，把水面片元的深度与它在屏幕上的
      场景深度相减，差值越小说明水面正贴着别的物体 → 生成泡沫
      （岸边、水中岛屿四周、贴墙处），这是泡沫最可靠的做法。
   ============================================================ */

/** 泡沫水深差所需的共享 uniform（builder 每帧预渲染深度图后写入）
    —— 定义在 shader-uniforms.js（worker 安全），此处仅保留说明。 */

export function createFoamMaterial(lightInfluence) {
  const li = lightInfluenceUniform(lightInfluence);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: LIQUID_UNIFORMS.time,
      uColor: { value: new THREE.Color('#ffffff') },
      uOpacity: { value: 0.85 },
      uLightInf: li,                   // 光照影响（受曝光补偿 / 画面染色 / 光照的比例）
      uBandStud: { value: 4.5 },       // 泡沫带宽度(stud)
      uScale: { value: new THREE.Vector3(1, 1, 1) },   // 泡沫网格的世界缩放
      uUpStud: { value: 0 },           // 泡沫网格高出液面的量(stud)，0 = 不向上延伸
      uFlatTop: { value: 0 },          // 1 = 平顶形状（顶盖需压回真实液面）
      uShape: { value: 0 },            // 0 盒 / 1 圆(球·柱·锥) / 2 多边形柱
      uSides: { value: 6 },
      uSceneDepth: FOAM_DEPTH.scene,
      uResolution: FOAM_DEPTH.res,
      uCamNear: FOAM_DEPTH.near,
      uCamFar: FOAM_DEPTH.far,
      uDepthOn: FOAM_DEPTH.on,
    },
    vertexShader: `
      varying vec3 vLocal;
      varying vec3 vWorld;
      uniform vec3 uScale;
      uniform float uUpStud;
      uniform float uFlatTop;
      void main() {
        vec3 p = position;
        // 平顶形状：顶盖顶点压回真实液面，使向上多出的那截只体现在侧壁上
        if (uFlatTop > 0.5 && p.y > 0.499 && normal.y > 0.7) {
          p.y = 0.5 - uUpStud / max(abs(uScale.y), 0.001);
        }
        vLocal = p;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      varying vec3 vLocal;
      varying vec3 vWorld;
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uBandStud;
      uniform vec3 uScale;
      uniform float uUpStud;
      uniform float uShape;
      uniform float uSides;
      uniform sampler2D uSceneDepth;
      uniform vec2 uResolution;
      uniform float uCamNear;
      uniform float uCamFar;
      uniform float uDepthOn;

      float fHash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float fNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(fHash(i), fHash(i + vec2(1.0, 0.0)), f.x),
                   mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fFbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { s += a * fNoise(p); p = p * 2.03 + vec2(5.1, 9.3); a *= 0.5; }
        return s;
      }
      /* 到水平轮廓边缘的距离（单位盒局部坐标，向内为正） */
      float edgeDist() {
        vec2 p = vLocal.xz;
        if (uShape < 0.5) return min(0.5 - abs(p.x), 0.5 - abs(p.y));
        float r = length(p);
        if (uShape < 1.5) return 0.5 - r;
        float seg = 6.2831853 / max(uSides, 3.0);
        float a = mod(atan(p.y, p.x) + seg * 0.5, seg) - seg * 0.5;
        return 0.5 * cos(seg * 0.5) / max(cos(a), 0.08) - r;
      }
      /* 深度缓冲值(0..1) → 视空间距离 */
      float linearZ(float d) {
        float z = d * 2.0 - 1.0;
        return (2.0 * uCamNear * uCamFar) / (uCamFar + uCamNear - z * (uCamFar - uCamNear));
      }
${SCENE_DEPTH_MAX_SAMPLE}

      void main() {
        float scXZ = max((abs(uScale.x) + abs(uScale.z)) * 0.5, 0.001);
        float bxz = uBandStud / scXZ;                                   // 水平带宽（局部单位）
        float by = min(uBandStud / max(abs(uScale.y), 0.001), 0.45);    // 垂直带宽（局部单位）
        float byOut = uUpStud / max(abs(uScale.y), 0.001);   // 液面之上多出的那截（局部单位）
        float surfY = 0.5 - byOut;                           // 真实液面在泡沫网格局部坐标下的高度
        float t = uTime;
        float d = edgeDist();
        float top = smoothstep(surfY - by, surfY, vLocal.y);
        float upf = 1.0 - clamp((vLocal.y - surfY) / max(byOut, 0.0001), 0.0, 1.0);  // 液面以上 1 stud 渐隐
        float above = smoothstep(0.0, 0.02, vLocal.y - surfY);                      // 1 = 已在液面之上

        // ---- 提前剔除（必须放在噪声采样之前）----
        // 泡沫网格用的就是液体自身的几何，整个水体都在跑这段着色器；而绝大多数
        // 片元（大水体内部、水下侧壁、底面）最后都会被 discard。这里先算一个
        // 「不含噪声的上界」：n1 / n2 / band 全部取对泡沫最有利的极值，
        // 连最有利的取值都到不了可见阈值就直接扔掉，省掉下面 2 次 fFbm（8 次噪声）。
        //   外沿上界 = (1-smoothstep(edge*0.4, edge, d))*0.7*mix(0.55,1,n2) + 贴边白边
        //            edge = bxz*(0.55+0.85*n1) ≤ bxz*(0.55+0.85*0.9375)
        //   岸边上界 = shoreRaw*0.95 + shoreRaw*0.45 = shoreRaw*1.4，
        //            band = uBandStud*(0.7+0.9*n1) ≤ uBandStud*(0.7+0.9*0.9375)
        //   （mix(0.22,1,top) 与 above 的渐隐因子都 ≤ 1，一并按 1 计）
        float edgeMax = bxz * (0.55 + 0.85 * 0.9375);
        float aUB = (1.0 - smoothstep(edgeMax * 0.4, edgeMax, d)) * 0.7
                  + (1.0 - smoothstep(0.0, bxz * 0.28, d)) * 0.4;
        float diffZ = 0.0;        // 水面与背后场景的视空间深度差（下面岸边泡沫直接复用，
        if (uDepthOn > 0.5) {     // 不再对同一片元取第二遍全屏深度图）
          // 与液体同一个取法（2×2 邻域取最远）：贴物体轮廓的水面像素否则会采到该物体的深度，
          // diffZ 变负 → 下面 step(0,diff) 会把这一圈泡沫整条抹掉 → 泡沫环上出现锯齿缺口
          diffZ = linearZ(sampleSceneDepthFar(gl_FragCoord.xy / uResolution, 1.0 / uResolution))
                - linearZ(gl_FragCoord.z);
          float bandMax = uBandStud * (0.7 + 0.9 * 0.9375);
          aUB += (1.0 - smoothstep(bandMax * 0.3, bandMax, diffZ)) * step(0.0, diffZ) * 1.4;
        }
        if (aUB * uOpacity <= 0.004) discard;

        // 两层噪声：大尺度决定泡沫带宽起伏，小尺度做细碎颗粒
        vec2 np = vWorld.xz;
        float n1 = fFbm(np * 0.5 + vec2(t * 0.18, -t * 0.12));
        float n2 = fFbm(np * 2.1 - vec2(t * 0.26, t * 0.21));

        // ① 液体自身外沿（水与空气的交界）
        float edge = bxz * (0.55 + 0.85 * n1);
        float a = (1.0 - smoothstep(edge * 0.4, edge, d)) * 0.7;      // 陡峭衰减 → 外沿利落不糊
        a *= mix(0.55, 1.0, n2);
        a += (1.0 - smoothstep(0.0, bxz * 0.28, d)) * 0.4;            // 贴边一圈实心白边
        a *= mix(0.22, 1.0, top);                                     // 越靠近液面越明显

        // ② 深度差：水面与其它物体相交处（岸边 / 岛屿四周 / 贴墙）
        float shoreRaw = 0.0;
        if (uDepthOn > 0.5) {
          float diff = diffZ;                       // 复用上面那次深度图采样
          float band = uBandStud * (0.7 + 0.9 * n1);
          shoreRaw = 1.0 - smoothstep(band * 0.3, band, diff);
          shoreRaw *= step(0.0, diff);
          shoreRaw *= mix(0.35, 1.0, n2);
          shoreRaw *= mix(0.25, 1.0, top);
          // 水面到背后物体的「垂直落差」(stud)：平整平台刚被水没过时 ≈ 0，水位继续上升才逐渐拉大。
          // 用它给水面上的泡沫做渐入，避免整片平台被没过那一瞬间 pop 出一滩水沫。
          // 背后物体与水面片元在同一条视线上：垂直落差 = 视线深度差 × 视线竖直分量 / 前向分量。
          vec3 rd = normalize(vWorld - cameraPosition);
          float fwd = max(-dot(viewMatrix[2].xyz, rd), 0.05);    // 视线前向分量（掠射角保护）
          float vgap = abs(diff * rd.y / fwd);
          float shore = shoreRaw * smoothstep(0.0, 1.0, vgap);   // 渐入：落差 0 → 1 stud 达到满泡沫
          a += shore * 0.95;
          a += smoothstep(0.78, 0.98, fNoise(np * 3.6 + vec2(-t * 0.32, t * 0.26))) * shore * 0.45;
        }

        // 液面以上：只保留贴着岸边物体的泡沫，并沿岸边物体向上 1 stud 渐隐。
        // 这里用未渐入的 shoreRaw：贴墙那圈泡沫在水线处落差 ≈ 0，用 shore 会被整圈削掉。
        a *= mix(1.0, upf * smoothstep(0.04, 0.30, shoreRaw), above);
        a = clamp(a, 0.0, 1.0) * uOpacity;
        if (a <= 0.004) discard;
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  applyScreenGrade(mat, li);  // 画面处理：饱和度 / 染色 + 光照影响
  return mat;
}

/* ============================================================
   体积特效：体积雾 / 体积光
   共享时间轴（由 builder.update 每帧推进），几何用单位形状 + mesh.scale
   VOLUME_UNIFORMS / FOG_PASS_UNIFORMS 定义在 shader-uniforms.js（worker 安全），
   顶部已 re-export。
   ============================================================ */

/* ---------- 体积雾的「密度场预积分」LUT ----------
   原先每一步进都要现场算 2 个八度的程序化噪声（8 角 × 2 = 16 次哈希），
   最多 24 步就是 ~384 次哈希 / 像素 —— 这是雾卡顿的主因。
   改成开工前把同一套噪声一次性烘进一张可平铺的 3D 贴图，步进时只需 1 次三线性采样。
   LUT 覆盖 FOG_LUT_CELLS 个噪声晶格：采样坐标要除以 CELLS，平铺周期 = CELLS 个晶格。 */
const FOG_LUT_SIZE = 64;     // 每轴 64 体素
const FOG_LUT_CELLS = 8;     // 覆盖 8 个晶格（8 体素/晶格，三线性插值足够还原软团形状）
let _fogLut = null;
let _fogLutTried = false;
let _webgl2 = null;

/** 是否 WebGL2（3D 贴图 / 深度贴图需要）；结果只探测一次 */
function hasWebGL2() {
  if (_webgl2 === null) {
    try { _webgl2 = !!document.createElement('canvas').getContext('webgl2'); }
    catch (e) { _webgl2 = false; }
  }
  return _webgl2;
}

/** 周期性哈希：格子坐标按 P 取模，保证烘出的贴图能无缝平铺 */
function lutHash(x, y, z, P) {
  x = ((x % P) + P) % P; y = ((y % P) + P) % P; z = ((z % P) + P) % P;
  let n = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** 周期性值噪声（与着色器里的 vNoise 同构：格子哈希 + 平滑插值） */
function lutNoise(x, y, z, P) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const c000 = lutHash(ix, iy, iz, P), c100 = lutHash(ix + 1, iy, iz, P);
  const c010 = lutHash(ix, iy + 1, iz, P), c110 = lutHash(ix + 1, iy + 1, iz, P);
  const c001 = lutHash(ix, iy, iz + 1, P), c101 = lutHash(ix + 1, iy, iz + 1, P);
  const c011 = lutHash(ix, iy + 1, iz + 1, P), c111 = lutHash(ix + 1, iy + 1, iz + 1, P);
  const x00 = c000 + (c100 - c000) * fx, x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx, x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

/** 烘焙可平铺的雾密度场（2 个八度，与着色器里的 vFbm 权重一致）；只做一次 */
function fogDensityLUT() {
  if (_fogLutTried) return _fogLut;
  _fogLutTried = true;
  if (!hasWebGL2()) return null;    // 没有 3D 贴图 → 退回程序化噪声
  const N = FOG_LUT_SIZE, P = FOG_LUT_CELLS;
  const data = new Uint8Array(N * N * N * 4);
  const inv = 1 / N;
  for (let z = 0; z < N; z++) {
    const wz = z * inv;
    for (let y = 0; y < N; y++) {
      const wy = y * inv;
      for (let x = 0; x < N; x++) {
        const wx = x * inv;
        const d = 0.58 * lutNoise(wx * P, wy * P, wz * P, P)
          + 0.29 * lutNoise(wx * 2 * P, wy * 2 * P, wz * 2 * P, 2 * P);
        const b = d <= 0 ? 0 : d >= 1 ? 255 : (d * 255 + 0.5) | 0;
        const o = ((z * N + y) * N + x) * 4;
        data[o] = b; data[o + 1] = b; data[o + 2] = b; data[o + 3] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  _fogLut = tex;
  return tex;
}

/* 程序化 3D 噪声（无 3D 贴图时的退路，与 LUT 的统计特性一致）
   只用 2 个八度：体积雾每个像素要采样十几到几十次，多加一个八度就等于片元开销翻倍 */
const VOL_NOISE_GLSL = `
  float vHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vNoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(vHash(i + vec3(0.0, 0.0, 0.0)), vHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                   mix(vHash(i + vec3(0.0, 1.0, 0.0)), vHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(vHash(i + vec3(0.0, 0.0, 1.0)), vHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                   mix(vHash(i + vec3(0.0, 1.0, 1.0)), vHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  }
  float vFbm(vec3 p) {
    return 0.58 * vNoise(p) + 0.29 * vNoise(p * 2.03);
  }
  float vRand(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }
`;

/**
 * 体积雾材质：真正的体积光线步进（raymarch）。
 *
 * 为什么必须步进：雾对象的几何是「单位立方体壳」，每个片元都落在盒子表面上。
 * 早先按「到盒子中心的距离」做边缘淡出（m = max(|x|,|y|,|z|)、edge = 1 - smoothstep(inner, 0.5, m)），
 * 而壳上 m 恒为 0.5 → edge 恒为 0 → alpha 恒为 0 被 discard，所以「什么都没有显示」。
 * 现在改成：从相机出发沿视线与单位盒解析求交，在交得的区间里按步长采样程序化噪声累积消光，
 * 越靠近盒子边界越淡，得到的是有体积感的雾团，而不是一张贴在方块上的雾图片。
 *
 * 优化（配合 VolumeFog 管线，见 world/volumefog.js）：
 *   · 密度场预积分：噪声不再逐步现场计算，改采样一张预热好的可平铺 3D 贴图（1 次采样 / 步）；
 *   · 边界盒裁剪：① 解析法只走盒子内部区间  ② 再用场景深度把区间截到第一个不透明表面
 *     （半分辨率 pass 不接深度测试，墙后的雾必须靠这一步挡住）③ 过薄的区间直接丢弃；
 *   · 半分辨率 + 时域重投影：本材质只把雾写进半分辨率缓冲，累积与重投影在 VolumeFog 里做，
 *     这里按帧抖动起点（uJitter）把条带噪声交给时域去噪。
 *
 * 性能：步数按「视线真正穿过的世界厚度」自适应（6 ~ 16 步），累积到 98% 不透明就提前退出；
 * 相机在体积内部时改画背面，走进雾里也看得见，且无论内外都只画一遍。
 *
 * @param token 每个雾对象必须传一个独享 token（builder 传 rec.fogToken）：
 *              uModel / uInvModel 是逐对象的 uniform，而 three.js 对「同一材质连续绘制」
 *              不会重新上传 uniform —— 共用材质会让第二个雾对象用上第一个的矩阵。
 */
export function getFogVolumeMaterial(p = {}, token = '') {
  const color = p.color || '#a8b6ea';
  const li = lightInfluenceUniform(p.lightInfluence);
  const density = clamp(Number(p.density ?? 0.45), 0, 1);
  const scale = clamp(Number(p.noiseScale ?? 1), 0.05, 12);
  const speed = clamp(Number(p.noiseSpeed ?? 0.35), 0, 6);
  const soft = clamp(Number(p.softness ?? 0.55), 0, 1);
  const lut = fogDensityLUT();
  const key = ['fogvol', token, color, density, scale, speed, soft, lut ? 1 : 0, p.lightInfluence ?? 1].join('|');
  let rec = _cache.get(key);
  if (rec) { rec.refs++; return rec.mat; }
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: VOLUME_UNIFORMS.time,
      uColor: { value: new THREE.Color(color) },
      uDensity: { value: density },
      uScale: { value: scale },
      uSpeed: { value: speed },
      uSoft: { value: soft },
      uLightInf: li,                   // 光照影响（受曝光补偿 / 画面染色 / 光照的比例）
      uModel: { value: new THREE.Matrix4() },
      uInvModel: { value: new THREE.Matrix4() },
      // 下面这几个由 VolumeFog 每帧统一改写（共享同一批 uniform 对象，不必逐个材质写）
      uDepthOn: FOG_PASS_UNIFORMS.depthOn,
      uDepthTex: FOG_PASS_UNIFORMS.depthTex,
      uRes: FOG_PASS_UNIFORMS.res,
      uJitter: FOG_PASS_UNIFORMS.jitter,
      uInvViewProj: FOG_PASS_UNIFORMS.invViewProj,
      uNoiseTex: { value: lut },
    },
    defines: lut ? { USE_LUT: 1 } : {},
    vertexShader: `
      varying vec3 vLocal;
      varying vec3 vWP;
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: VOL_NOISE_GLSL + `
      #define FOG_STEPS 16
      #define FOG_CELLS ${FOG_LUT_CELLS}.0
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uDensity;
      uniform float uScale;
      uniform float uSpeed;
      uniform float uSoft;
      uniform mat4 uModel;
      uniform mat4 uInvModel;
      uniform mat4 uInvViewProj;
      uniform vec2 uRes;
      uniform vec2 uJitter;
      uniform float uDepthOn;
      uniform sampler2D uDepthTex;
      #ifdef USE_LUT
      uniform highp sampler3D uNoiseTex;
      #endif
      varying vec3 vLocal;
      varying vec3 vWP;

      /* 采样密度场：有 LUT 时 1 次三线性采样（预积分），否则退回程序化噪声 */
      float fogDensity(vec3 q) {
        #ifdef USE_LUT
        return texture(uNoiseTex, q / FOG_CELLS).r;
        #else
        return vFbm(q);
        #endif
      }

      void main() {
        // 相机位置与视线方向换算到体积的局部空间（单位盒 ±0.5）
        vec3 ro = (uInvModel * vec4(cameraPosition, 1.0)).xyz;
        vec3 rdw = normalize(vWP - cameraPosition);
        vec3 rdu = (uInvModel * vec4(rdw, 0.0)).xyz;   // 局部空间里的视线（未归一化）
        float k = length(rdu);
        if (k < 1e-6) discard;
        vec3 rd = rdu / k;
        float wscale = 1.0 / k;    // 局部单位长度 = 多少个世界单位(stud)
        // 与单位盒求交；把 0 分量换成极小值，避免 0/0 变成 NaN 把 min/max 污染掉
        vec3 srd = rd + (1.0 - abs(sign(rd))) * 1e-5;
        vec3 inv = 1.0 / srd;
        vec3 ta = (vec3(-0.5) - ro) * inv;
        vec3 tb = (vec3(0.5) - ro) * inv;
        vec3 lo = min(ta, tb);
        vec3 hi = max(ta, tb);
        float t0 = max(max(max(lo.x, lo.y), lo.z), 0.0);
        float t1 = min(min(hi.x, hi.y), hi.z);
        if (t1 <= t0) discard;

        // 边界盒裁剪②：把区间截到「视线第一次撞上不透明几何」处。
        // 半分辨率缓冲没有场景深度，不做这一步墙后的雾会直接盖在墙上。
        if (uDepthOn > 0.5) {
          vec2 duv = gl_FragCoord.xy / uRes;
          float dz = texture2D(uDepthTex, duv).x;
          if (dz < 1.0) {
            vec4 ndc = vec4(duv * 2.0 - 1.0, dz * 2.0 - 1.0, 1.0);
            vec4 ws = uInvViewProj * ndc;
            vec3 wp = ws.xyz / ws.w;
            // 把交点换算到体积局部空间，再投影到局部视线上 —— 得到与 t0/t1 同一尺度的 t。
            // （不能用「世界距离 × 缩放」：盒子非等比缩放时这个比值是随方向变的）
            vec3 plw = (uInvModel * vec4(wp, 1.0)).xyz;
            float tScene = dot(plw - ro, rd);
            t1 = min(t1, tScene);
            if (t1 <= t0) discard;
          }
        }

        float span = t1 - t0;              // 穿过的局部长度
        float wlen = span * wscale;        // 穿过的世界厚度(stud)
        if (wlen < 0.35) discard;          // 边界盒裁剪③：过薄的区间不值得步进
        // 步数随厚度自适应：薄雾块少采样（省性能），厚雾块多采样（雾团细节不丢）
        float n = clamp(wlen * 0.55, 6.0, float(FOG_STEPS));
        float dt = span / n;
        float dtw = dt * wscale;           // 单步的世界长度
        float sigma = uDensity * 0.22;     // 每 stud 的消光系数
        // 上下界不能相等（smoothstep 在 edge0 == edge1 时结果未定义）
        float fadeFrom = mix(0.499, 0.06, clamp(uSoft, 0.0, 1.0));
        vec3 drift = vec3(0.0, uTime * uSpeed * 0.16, uTime * uSpeed * 0.09);
        // 抖动步进起点：固定步长会在雾里留下同心条带；抖动交给时域重投影抹平
        float t = t0 + dt * vRand(gl_FragCoord.xy + uJitter);
        float trans = 1.0;
        for (int i = 0; i < FOG_STEPS; i++) {
          if (float(i) >= n || trans < 0.02) break;
          vec3 pl = ro + rd * t;
          // 靠近盒子边界时淡出，避免看到一个方盒子的硬边
          float m = max(max(abs(pl.x), abs(pl.y)), abs(pl.z));
          float softEdge = 1.0 - smoothstep(fadeFrom, 0.5, m);
          if (softEdge > 0.002) {
            vec3 pw = (uModel * vec4(pl, 1.0)).xyz;   // 噪声按世界坐标采样：相邻雾块能接上
            float d = fogDensity(pw * (0.055 * uScale) + drift) * 1.7 * softEdge;
            trans *= 1.0 - clamp(d * sigma * dtw, 0.0, 1.0);
          }
          t += dt;
        }
        float a = 1.0 - trans;
        if (a <= 0.004) discard;
        // 预乘输出：VolumeFog 的累积缓冲与合成 pass 都按「预乘 over」处理
        gl_FragColor = vec4(uColor * a, clamp(a, 0.0, 0.97));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.FrontSide, fog: false,
    premultipliedAlpha: true,
  });
  mat.userData.volume = 'fog';
  applyScreenGrade(mat, li);  // 画面处理：饱和度 / 染色 + 光照影响
  _cache.set(key, { mat, refs: 1, key });
  return mat;
}

/** 体积光材质：叠加光束（轮廓亮、朝向镜头面淡），沿本地 Y 轴渐隐 */
export function getVolumeLightMaterial(p = {}) {
  const color = p.color || '#ffe9b0';
  const li = lightInfluenceUniform(p.lightInfluence);
  const intensity = clamp(Number(p.intensity ?? 0.5), 0, 4);
  const falloff = clamp(Number(p.falloff ?? 2), 0.2, 10);
  const fade = clamp(Number(p.fadeEnd ?? 1), 0, 1);
  const key = ['volbeam', color, intensity, falloff, fade, p.lightInfluence ?? 1].join('|');
  let rec = _cache.get(key);
  if (rec) { rec.refs++; return rec.mat; }
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity * 0.55 },
      uFalloff: { value: falloff },
      uFade: { value: fade },
      uLightInf: li,                   // 光照影响（受曝光补偿 / 画面染色 / 光照的比例）
    },
    vertexShader: `
      varying vec3 vLocal;
      varying vec3 vWN;
      varying vec3 vWP;
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        vWN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uFalloff;
      uniform float uFade;
      varying vec3 vLocal;
      varying vec3 vWN;
      varying vec3 vWP;
      void main() {
        vec3 V = normalize(cameraPosition - vWP);
        float rim = 1.0 - abs(dot(normalize(vWN), V));      // 轮廓处最亮
        float soft = pow(clamp(rim, 0.0, 1.0), uFalloff);
        float t = clamp(vLocal.y + 0.5, 0.0, 1.0);          // 1 = 光源端(+Y)，0 = 末端
        float h = mix(1.0, t, uFade);
        float a = uIntensity * soft * h;
        if (a <= 0.004) discard;
        gl_FragColor = vec4(uColor, clamp(a, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    blending: THREE.AdditiveBlending,
  });
  mat.userData.volume = 'beam';
  applyScreenGrade(mat, li);  // 画面处理：饱和度 / 染色 + 光照影响
  _cache.set(key, { mat, refs: 1, key });
  return mat;
}

/* ============================================================
   文字方块 / 公告板材质
   ============================================================ */

/** 文字方块材质：文字烘在面图集贴图上（只有 +Z 正面有字），走标准 PBR 光照 */
export function getTextMaterial(p = {}, aspect = 1) {
  const map = textTexture({
    text: p.text, color: p.textColor, bg: p.bgColor, bgOpacity: p.bgOpacity,
    fontSize: p.fontSize, bold: p.bold, align: p.align, valign: p.valign,
    runs: p.rich, aspect, atlas: true,
  });
  const emissive = p.emissive || '#000000';
  const ei = clamp(Number(p.emissiveIntensity ?? 0), 0, 8);
  const transparency = clamp(p.transparency ?? 0, 0, 1);
  const key = ['textblk', map.uuid, emissive, ei, transparency,
    p.roughness ?? 0.72, p.metalness ?? 0.05, p.lightInfluence ?? 1].join('|');
  let rec = _cache.get(key);
  if (rec) { rec.refs++; return rec.mat; }
  const li = lightInfluenceUniform(p.lightInfluence);
  const mat = new THREE.MeshStandardMaterial({
    map,
    roughness: clamp(p.roughness ?? 0.72, 0, 1),
    metalness: clamp(p.metalness ?? 0.05, 0, 1),
    transparent: transparency > 0.001,
    opacity: 1 - transparency,
    depthWrite: transparency > 0.55 ? false : true,
  });
  if (emissive !== '#000000' && ei > 0) {
    mat.emissive = new THREE.Color(emissive);
    mat.emissiveIntensity = ei;
  }
  mat.userData.selfDrawn = true;    // 文字贴图是自绘的，画质档位不改写它
  captureFlatColor(mat);            // 记下无光照的原始色，供光照影响回退
  applyScreenGrade(mat, li);        // 画面处理：饱和度 / 染色 + 光照影响
  _cache.set(key, { mat, refs: 1, key });
  return mat;
}

/**
 * 公告板材质：始终面向玩家，可装文字或图片。只有面朝玩家的那一面会被渲染，
 * 背面（玩家绕到背后时）直接不画。
 * 透明度由「距离淡入淡出」逐帧改写，所以每次返回独立材质（不走共享缓存，
 * 由 builder 在销毁时 dispose）。
 */
export function getBillboardMaterial(p = {}, aspect = 1) {
  const img = p.mode === 'image' ? (getTexture(p.image) || null) : null;
  const map = img || textTexture({
    text: p.text, color: p.textColor, bg: p.bgColor, bgOpacity: p.bgOpacity,
    fontSize: p.fontSize, bold: p.bold, align: p.align, valign: p.valign,
    runs: p.rich, aspect,
  });
  const mat = new THREE.MeshBasicMaterial({
    map,
    color: new THREE.Color(img ? (p.color || '#ffffff') : '#ffffff'),
    transparent: true,
    opacity: clamp(Number(p.baseOpacity ?? 1), 0, 1),
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: true,
  });
  mat.userData.selfDrawn = true;
  const li = lightInfluenceUniform(p.lightInfluence);
  applyScreenGrade(mat, li, true);
  return mat;
}

/* 供 builder 释放时识别体积特效材质 */
export function isVolumeMaterial(mat) { return !!(mat && mat.userData && mat.userData.volume); }

/** 无光照材质（编辑器辅助 / 线框 / 箭头） */
const _basic = new Map();
export function getBasicMaterial(color, opts = {}) {
  const key = 'basic|' + color + '|' + (opts.opacity ?? 1) + '|' + (opts.side ?? 0) + '|' + (opts.depthTest === false ? 'nt' : 't');
  let m = _basic.get(key);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
    side: opts.side === 1 ? THREE.DoubleSide : THREE.FrontSide,
    depthTest: opts.depthTest !== false,
    depthWrite: opts.depthWrite !== false && (opts.opacity ?? 1) >= 1,
    toneMapped: false,
  });
  _basic.set(key, m);
  return m;
}

export function disposeMaterialCache() {
  for (const rec of _cache.values()) rec.mat.dispose();
  _cache.clear();
  for (const m of _basic.values()) m.dispose();
  _basic.clear();
  for (const t of _mapCache.values()) t.dispose();
  _mapCache.clear();
}

export function materialCacheStats() {
  let refs = 0;
  for (const r of _cache.values()) refs += r.refs;
  return { count: _cache.size, refs, basic: _basic.size };
}

/** 是否与材质有关（属性面板 / 变更检测） */
export const MATERIAL_PROPS = [
  'color', 'texture', 'paintKey', 'textureSize', 'textureFill', 'transparency', 'metalness',
  'roughness', 'emissive', 'emissiveIntensity', 'flatShading', 'wireframe', 'side',
  // 高级材质（网格模型）
  'advMat', 'reflectivity', 'fxScale', 'fxAmp', 'fxColor',
  // 玻璃（高级材质 · 屏幕空间折射）
  'ior', 'glassAbsorb',
];
