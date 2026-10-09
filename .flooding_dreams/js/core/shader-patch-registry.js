/* ============================================================
   材质着色器补丁（主线程与渲染 Worker 共用，纯函数）
   ------------------------------------------------------------
   项目里对标准材质的 onBeforeCompile 注入共有几类，全部在这里集中：
     · 画面处理 applyScreenGrade —— 饱和度 / 染色矩阵 + 光照影响（所有走标准管线的材质）
     · 主光跟随高光 applySunSpecular —— 让 PBR 法线高光随主光移动
     · 智能调制 applyModulationShader —— 在 <map_fragment> 后按矩阵重上色
     · 高级材质 applyAdvancedShader —— 图案类高级材质的特效注入

   为什么要单列：渲染 Worker 需要复现这些注入，但它不能 import materials.js
   （materials.js 会拉进 textures / settings / localStorage 等 DOM 依赖）。
   本模块只依赖 three 与其它 worker 安全的纯模块，两侧 import 同一份。

   主线程注入时会把「补丁参数」记到材质上（_sgLI / _sgRaw / userData.modMat /
   userData._advParams），桥接层据此把参数发到 Worker，由 applyPatchDescriptor
   在镜像材质上原样重放。
   ============================================================ */
import * as THREE from './three-ns.js';
import { clamp } from './util.js';
import { SCREEN_GRADE, SUN_SPEC } from './shader-uniforms.js';
import { applyModulationShader } from './material-modulation.js';
import { applyAdvancedShader } from '../world/advanced-materials.js';

export { SCREEN_GRADE, setScreenGrade, withScreenGradeOff, SUN_SPEC } from './shader-uniforms.js';
export { applyModulationShader } from './material-modulation.js';

/* ---------- 光照影响（Light Influence） ---------- */
export function lightInfluenceUniform(v) {
  return { value: clamp(Number(v ?? 1), 0, 1) };
}
/** 不带该选项的普通材质统一引用这一份「完全跟随」 */
const LI_FULL = { value: 1 };

const LI_EPILOGUE = `{
  vec3 _liSrc = gl_FragColor.rgb;
  #ifdef USE_LI_FLAT
  _liSrc = mix(_liFlat, _liSrc, uLightInf);
  #endif
  vec3 _liGraded = mix(_liSrc, uScreenGrade * _liSrc, uLightInf);
  #if defined( TONE_MAPPING )
  vec3 _liOn = toneMapping(_liGraded);
  vec3 _liOff = toneMapping(_liGraded / max(toneMappingExposure, 1e-4));
  _liGraded = mix(_liOff, _liOn, uLightInf);
  #endif
  gl_FragColor.rgb = _liGraded;
}
`;

const LI_EPILOGUE_RAW = `{
  vec3 _liSrc = gl_FragColor.rgb;
  #if defined( TONE_MAPPING )
  vec3 _liOn = toneMapping(uScreenGrade * _liSrc);
  gl_FragColor.rgb = mix(_liSrc, _liOn, uLightInf);
  #else
  gl_FragColor.rgb = mix(_liSrc, uScreenGrade * _liSrc, uLightInf);
  #endif
}
`;

/** 受光材质：在 <color_fragment> 之后记下「无光照的原始色」(_liFlat)。 */
export function captureFlatColor(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    shader.fragmentShader = '#define USE_LI_FLAT 1\n' + shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  vec3 _liFlat = clamp(diffuseColor.rgb, 0.0, 1.0);',
    );
  };
  mat._liFlatCapture = true;
  return mat;
}

/** 把全局调色矩阵 + 光照影响接到材质上（记录参数供 Worker 复现）。 */
export function applyScreenGrade(mat, liUniform, rawBase) {
  if (!mat || mat._screenGraded) return mat;
  mat._screenGraded = true;
  mat._sgRaw = !!rawBase;
  const li = liUniform || LI_FULL;
  mat._sgLI = li;
  const epilogue = rawBase ? LI_EPILOGUE_RAW : LI_EPILOGUE;
  const prevCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prevCompile) prevCompile.call(this, shader, renderer);
    shader.uniforms.uScreenGrade = SCREEN_GRADE.mat;
    shader.uniforms.uLightInf = li;
    shader.fragmentShader = 'uniform mat3 uScreenGrade;\nuniform float uLightInf;\n' + shader.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      epilogue,
    );
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function () {
    return (prevKey ? prevKey.call(this) : '') + (rawBase ? '|sg2r' : '|sg2');
  };
  return mat;
}

const SUN_SPEC_GLSL = `
uniform vec3  uSunSpecDir;
uniform vec3  uSunSpecColor;
uniform float uSunSpecStrength;
`;

const SUN_SPEC_BODY = `
{
  vec3  ssN = normalize(normal);
  vec3  ssV = geometryViewDir;
  vec3  ssL = normalize((viewMatrix * vec4(uSunSpecDir, 0.0)).xyz);
  vec3  ssH = normalize(ssL + ssV);
  float ssNdotL = max(dot(ssN, ssL), 0.0);
  float ssNdotH = max(dot(ssN, ssH), 0.0);
  float ssExp = mix(240.0, 6.0, clamp(roughnessFactor, 0.04, 1.0));
  vec3  ssTint = mix(uSunSpecColor, uSunSpecColor * diffuseColor.rgb, metalnessFactor);
  totalSpecular += ssTint * uSunSpecStrength * pow(ssNdotH, ssExp) * ssNdotL * 0.25;
}
`;

/** 给标准 PBR 材质追加「跟随主光」的镜面高光项 */
export function applySunSpecular(mat) {
  if (!mat || !mat.isMeshStandardMaterial || mat._sunSpec) return mat;
  mat._sunSpec = true;
  const prevCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prevCompile) prevCompile.call(this, shader, renderer);
    shader.uniforms.uSunSpecDir = SUN_SPEC.dir;
    shader.uniforms.uSunSpecColor = SUN_SPEC.color;
    shader.uniforms.uSunSpecStrength = SUN_SPEC.strength;
    shader.fragmentShader = SUN_SPEC_GLSL + shader.fragmentShader.replace(
      '#include <opaque_fragment>', SUN_SPEC_BODY + '\n#include <opaque_fragment>');
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function () {
    return (prevKey ? prevKey.call(this) : '') + '|sunspec';
  };
  return mat;
}

/** 高级材质注入（记录参数供 Worker 复现） */
export function applyAdvancedShaderTracked(mat, p) {
  applyAdvancedShader(mat, p);
  mat.userData._advParams = {
    preset: p.advMat,
    scale: Math.max(0.05, Number(p.fxScale ?? 1) || 1),
    amp: Math.max(0, Number(p.fxAmp ?? 0.8) || 0),
    c1: new THREE.Color(p.emissive && p.emissive !== '#000000' ? p.emissive : (p.color || '#ffffff')).toArray(),
    c2: new THREE.Color(p.fxColor || '#000000').toArray(),
  };
  return mat;
}

/**
 * Worker 侧：按描述符在镜像材质上重放补丁。顺序必须与主线程 getMaterial 一致：
 * 高级材质 → 调制 → 主光高光 → 画面处理（后 wrap 的先执行）。
 * @param mat 镜像材质
 * @param d   { adv, mod, sun, sg } 补丁描述符（桥接层从材质标记提取）
 */
export function applyPatchDescriptor(mat, d) {
  if (!mat || !d) return mat;
  if (d.adv && d.adv.preset) {
    applyAdvancedShaderTracked(mat, {
      advMat: d.adv.preset, fxScale: d.adv.scale, fxAmp: d.adv.amp,
      emissive: `#${new THREE.Color(d.adv.c1[0], d.adv.c1[1], d.adv.c1[2]).getHexString()}`,
      color: '#ffffff',
      fxColor: `#${new THREE.Color(d.adv.c2[0], d.adv.c2[1], d.adv.c2[2]).getHexString()}`,
    });
  }
  if (d.mod) {
    const m = new THREE.Matrix3().set(d.mod[0], d.mod[1], d.mod[2], d.mod[3], d.mod[4], d.mod[5], d.mod[6], d.mod[7], d.mod[8]);
    applyModulationShader(mat, m);
  }
  if (d.flat) captureFlatColor(mat);
  if (d.sun) applySunSpecular(mat);
  if (d.sg) applyScreenGrade(mat, lightInfluenceUniform(d.li), !!d.raw);
  return mat;
}
