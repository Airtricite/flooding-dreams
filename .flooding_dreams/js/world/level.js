/* ============================================================
   关卡数据层：schema / 默认值 / 规范化 / 校验 / 统计
   关卡是一份纯 JSON，可存 IndexedDB，也可导出文件
   ============================================================ */
import * as THREE from 'three';
import { APP, PLAYER, EDITOR, DEFAULT_SETTINGS, outsOf, inputKeysOf, exposableOf, MATH_VAR_KEYS, OBJECT_POS_MODES, RAY_FROM_MODES, RAY_TO_MODES, LOOP_START_TYPES } from '../config.js';
import { uid, deepClone, mergeDefaults, clamp, isVec3, deg2rad } from '../core/util.js';
import { migrateLegacySky, normalizeSkyMods } from '../core/sky-modifier.js';
import { OBJECT_TYPES, typeDef, propsOf, createObject } from './objectTypes.js';
import { formulaError } from './formula.js';
import { POSTFX_TOGGLE_KEYS } from '../core/postfx.js';
import { PATH_TYPES } from './paths.js';
import { resolveLiquidStyle, deriveDepthTone } from './liquid-presets.js';
import { normalizeTexMod } from '../core/texture-modifier.js';
import { normalizeParticleEntry } from '../core/particle-presets.js';

export const DEFAULT_LAYER = {
  id: 'layer1', name: '图层 1', visible: true, opacity: 1, blendMode: 'normal', locked: false,
};

export const BLEND_MODES = [
  { v: 'normal', l: '正常' },
  { v: 'multiply', l: '正片叠底' },
  { v: 'screen', l: '滤色' },
  { v: 'overlay', l: '叠加' },
  { v: 'darken', l: '变暗' },
  { v: 'lighten', l: '变亮' },
  { v: 'color-dodge', l: '颜色减淡' },
  { v: 'color-burn', l: '颜色加深' },
  { v: 'hard-light', l: '强光' },
  { v: 'soft-light', l: '柔光' },
  { v: 'difference', l: '差值' },
  { v: 'hue', l: '色相' },
  { v: 'saturation', l: '饱和度' },
  { v: 'color', l: '颜色' },
  { v: 'luminosity', l: '明度' },
];

/* ---------- 关卡默认设置 ---------- */
function defaultLevelSettings() {
  return {
    oxygenRegen: PLAYER.oxygenRegen,
    oxygenRegenDelay: PLAYER.oxygenRegenDelay,
    oxygenMax: PLAYER.oxygenMax,
    healthMax: PLAYER.healthMax,
    gravityScale: 1,
    timeLimit: 120,           // 秒，关卡时长；超时判定失败。0 = 不限时
    startCountdown: true,     // 进入关卡时是否显示开局 3-2-1 倒数（倒完才开始计时 / 触发事件）
    countdownTime: 3,         // 开局倒计时秒数
    deathLimit: 1,            // 死亡次数上限，0 = 无限（无限时在原处重生）
    objective: '',            // 关卡目标文字（显示在 HUD 顶部）
    spawnFixed: '',           // 指定起点对象 id（留空则按权重随机）
    fog: { enabled: true, color: '#6a5c9e', near: 150, far: 1400 },
    ambient: { color: '#a7b6e6', intensity: 0.8 },
    sun: { color: '#fff4e2', intensity: 2, azimuth: 38, hour: 16, shadows: true },
    env: 0.8,                 // 环境反射强度 0~1（用天空盒做 IBL）；0 = 关闭
    sky: 'dream',             // 天空盒：内置 id / 'asset:xxx'（导入全景图）/ 'none'
    skyIntensity: 1,          // 天空亮度
    skyMods: [],              // 天空修饰器列表：{ type, on, p }（几何变形 + 色彩 / 曝光，可叠加）
    bgm: '',                  // 背景音乐：'asset:xxx' / URL / ''（无）
    bgmVolume: 1,             // 背景音乐音量
    voidY: -500,              // 低于此高度判定死亡
  };
}

export function levelSettingsDefs() {
  return [
    { k: 'oxygenRegen', l: '出水后氧气恢复/秒', t: 'num', d: PLAYER.oxygenRegen, min: 0, max: 100, st: 0.5, h: '0 = 不自然恢复' },
    { k: 'oxygenRegenDelay', l: '出水后氧气恢复延迟(秒)', t: 'num', d: PLAYER.oxygenRegenDelay, min: 0, max: 10, st: 0.05,
      h: '脱离游泳状态后等待该时长才开始回氧；避免贴着水面反复探头“刷”氧气' },
    { k: 'oxygenMax', l: '氧气上限', t: 'num', d: 100, min: 5, max: 600, st: 5 },
    { k: 'healthMax', l: '生命上限', t: 'num', d: 100, min: 1, max: 1000, st: 5 },
    { k: 'gravityScale', l: '重力倍率', t: 'num', d: 1, min: 0, max: 3, st: 0.05 },
    { k: 'timeLimit', l: '关卡时长(秒)', t: 'num', d: 120, min: 0, max: 3600, st: 5,
      h: '默认 2 分钟；超时判定失败。0 = 不限时' },
    { k: 'startCountdown', l: '开局倒数', t: 'bool', d: true,
      h: '进入关卡时显示开局 3-2-1 倒数；倒完才开始计时 / 触发事件。关闭则直接开始' },
    { k: 'countdownTime', l: '开局倒数秒数', t: 'num', d: 3, min: 0, max: 10, st: 1,
      h: '仅在启用「开局倒数」时生效' },
    { k: 'deathLimit', l: '死亡上限(0无限)', t: 'num', d: 1, min: 0, max: 99, st: 1,
      h: '达到上限判定失败并返回大厅' },
    { k: 'objective', l: '关卡目标文字', t: 'text', d: '' },
    { k: 'voidY', l: '掉落死亡高度', t: 'num', d: -500, min: -5000, max: 0, st: 10 },
    { k: 'fog.enabled', l: '启用雾', t: 'bool', d: true },
    { k: 'fog.color', l: '雾颜色', t: 'color', d: '#6a5c9e' },
    { k: 'fog.near', l: '雾起点', t: 'num', d: 150, min: 0, max: 5000, st: 10 },
    { k: 'fog.far', l: '雾终点', t: 'num', d: 1400, min: 1, max: 9000, st: 10 },
    { k: 'ambient.color', l: '环境光颜色', t: 'color', d: '#a7b6e6' },
    { k: 'ambient.intensity', l: '环境光强度', t: 'num', d: 0.8, min: 0, max: 4, st: 0.05 },
    { k: 'sun.color', l: '主光颜色', t: 'color', d: '#fff4e2' },
    { k: 'sun.intensity', l: '主光强度', t: 'num', d: 2, min: 0, max: 8, st: 0.05 },
    { k: 'sun.azimuth', l: '主光方位角', t: 'num', d: 38, min: 0, max: 360, st: 1 },
    { k: 'sun.hour', l: '昼夜时间(时)', t: 'num', d: 16, min: 0, max: 24, st: 0.5,
      h: '12.5 = 12:30:00；主光仰角由该时刻推得（直接取代原「主光仰角」），白天为太阳、夜晚为月亮' },
    { k: 'sun.shadows', l: '主光投射阴影', t: 'bool', d: true },
    { k: 'env', l: '环境反射(天空)', t: 'num', d: 0.8, min: 0, max: 1, st: 0.01 },
    { k: 'sky', l: '天空盒', t: 'sky', d: 'dream', h: '内置天空，或导入的全景图（建议 2:1 等距柱状，支持 .png / .jpg / .hdr）' },
    { k: 'skyIntensity', l: '天空亮度', t: 'num', d: 1, min: 0, max: 2.5, st: 0.05 },
    { k: 'skyMods', l: '天空修饰器', t: 'skymods', d: [],
      h: '可叠加的扭曲 / 特殊效果与色彩 / 曝光修饰器（几何变形无缝、两极不撕裂）；点按钮打开修饰器列表' },
    { k: 'bgm', l: '背景音乐(BGM)', t: 'audio', d: '', h: '导入 mp3/ogg/wav 作为本关背景音乐；留空则只有环境音' },
    { k: 'bgmVolume', l: 'BGM 音量', t: 'num', d: 1, min: 0, max: 2, st: 0.05 },
  ];
}

/* ---------- 创建空关卡 ---------- */
export function createEmptyLevel(opt = {}) {
  const id = opt.id || uid('lv');
  const s = mergeDefaults(opt.settings || {}, defaultLevelSettings());
  const level = {
    format: APP.levelFormat,
    version: APP.levelVersion,
    id,
    name: opt.name || '未命名关卡',
    author: opt.author || '玩家',
    description: opt.description || '',
    difficulty: clamp(Number(opt.difficulty) || 1, 0.5, 9.99),
    settings: s,
    objects: [],
    events: [],
    animations: [],
    paintLayers: [{ ...DEFAULT_LAYER }],
    paints: [],
    stickers: [],
    texMods: [],
    meta: { created: Date.now(), updated: Date.now() },
  };
  return level;
}

export function createEmptyObject(type, over = {}) {
  return createObject(type, over);
}

/* ---------- 查询 ---------- */
export function getObject(level, id) {
  if (!id) return null;
  return level.objects.find((o) => o.id === id) || null;
}
export function getEvent(level, id) {
  if (!id) return null;
  return level.events.find((e) => e.id === id) || null;
}
export function getAnim(level, id) {
  if (!id) return null;
  return level.animations.find((a) => a.id === id) || null;
}
export function objectsOfType(level, type) {
  return level.objects.filter((o) => o.type === type);
}
export function childrenOf(level, id) {
  return level.objects.filter((o) => o.parent === id);
}
/** 该对象及其所有后代 */
export function collectTree(level, id, out = []) {
  const o = getObject(level, id);
  if (o) out.push(o);
  for (const c of childrenOf(level, id)) collectTree(level, c.id, out);
  return out;
}
/* ---------- 世界坐标 ----------
   与 builder 的「子级锚点」同一套语义：子对象继承父级的位置 + 旋转，
   但不继承父级的尺寸（网格的 scale 是自身长宽高，传下去会把子级拉变形）。 */
const _wpPos = new THREE.Vector3();
const _wpQuat = new THREE.Quaternion();
const _wpTmp = new THREE.Vector3();
const _wpEuler = new THREE.Euler();
const _wpRot = new THREE.Quaternion();

export function worldPosition(level, o, out = [0, 0, 0]) {
  // 自底向上收集父级链，再自根向下累乘「位置 + 旋转」
  const chain = [];
  let cur = o;
  let guard = 0;
  while (cur && guard++ < 32) {
    chain.push(cur);
    if (PATH_TYPES.has(cur.type)) break;
    cur = cur.parent ? getObject(level, cur.parent) : null;
  }
  _wpPos.set(0, 0, 0);
  _wpQuat.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i];
    if (isVec3(c.position)) {
      _wpTmp.set(c.position[0], c.position[1], c.position[2]).applyQuaternion(_wpQuat);
      _wpPos.add(_wpTmp);
    }
    const r = c.rotation;
    if (isVec3(r) && (r[0] || r[1] || r[2])) {
      _wpRot.setFromEuler(_wpEuler.set(deg2rad(r[0]), deg2rad(r[1]), deg2rad(r[2])));
      _wpQuat.multiply(_wpRot);
    }
  }
  out[0] = _wpPos.x; out[1] = _wpPos.y; out[2] = _wpPos.z;
  return out;
}

/** 对象的「世界朝向」四元数（含父级链旋转），out 缺省返回新 THREE.Quaternion */
const _wpqOut = new THREE.Quaternion();
export function worldQuaternion(level, o, out = _wpqOut) {
  const chain = [];
  let cur = o;
  let guard = 0;
  while (cur && guard++ < 32) {
    chain.push(cur);
    if (PATH_TYPES.has(cur.type)) break;
    cur = cur.parent ? getObject(level, cur.parent) : null;
  }
  _wpQuat.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i];
    const r = c.rotation;
    if (isVec3(r) && (r[0] || r[1] || r[2])) {
      _wpRot.setFromEuler(_wpEuler.set(deg2rad(r[0]), deg2rad(r[1]), deg2rad(r[2])));
      _wpQuat.multiply(_wpRot);
    }
  }
  out.copy(_wpQuat);
  return out;
}

/* ---------- 玩法空间（原空间）vs 渲染空间 ----------
   「镜像」地图变体把整张地图在渲染层左右翻转（session 里 scene.scale.x = -1），
   于是所有 Object3D.matrixWorld 都变成了「镜像空间」里的矩阵；而物理（Cannon）、
   关卡数据、玩家位置、记录仪仍在原空间里跑。所以任何「读世界矩阵再和玩家 / 物理 /
   关卡数据比对」的查询（OBB 接触、液面判定、滑索取点、包围盒、公告板朝向…）
   都必须先用下面两个函数把矩阵换回原空间 —— 否则镜像局里会整体左右错位：
   walljump 贴不上墙、攀爬脱手、水体判定失效、滑索把人甩到镜像位置…
   物体自身的位置 / 旋转 / 缩放（mesh.position 等）本来就是原空间的，不用换算。 */
const _MIRROR_M = new THREE.Matrix4().makeScale(-1, 1, 1);
const _pmMat = new THREE.Matrix4();
const _pmPos = new THREE.Vector3();
const _pmScale = new THREE.Vector3();

/** 取对象的「玩法空间」世界矩阵（mirror=false 时就是 matrixWorld 本身） */
export function playMatrix(mesh, mirror, out) {
  out.copy(mesh.matrixWorld);
  if (mirror) out.premultiply(_MIRROR_M);   // 左乘镜像矩阵：把渲染空间换回原空间
  return out;
}

/** 取对象的「玩法空间」世界旋转（写入 out，返回单位四元数） */
export function playQuat(mesh, mirror, out) {
  playMatrix(mesh, mirror, _pmMat).decompose(_pmPos, out, _pmScale);
  return out.normalize();
}

export function objectLabel(o) {
  if (!o) return '—';
  if (o.name) return o.name;
  const d = OBJECT_TYPES[o.type] || OBJECT_TYPES.mesh;
  if (o.type === 'mesh') return (d.label + ' ' + (o.shape || 'block'));
  if (o.type === 'liquid') return '液体 ' + (o.kind || 'water');
  return d.label;
}

/* ---------- 添加 / 删除 / 移动 ---------- */
export function addObject(level, type, over = {}) {
  const o = createObject(type, over);
  level.objects.push(o);
  return o;
}
export function removeObjectTree(level, id) {
  const list = collectTree(level, id);
  const ids = new Set(list.map((o) => o.id));
  level.objects = level.objects.filter((o) => !ids.has(o.id));
  level.paints = (level.paints || []).filter((p) => !ids.has(p.objectId));
  level.stickers = (level.stickers || []).filter((s) => !ids.has(s.objectId));
  return list.length;
}
export function reparentObject(level, id, parentId) {
  const o = getObject(level, id);
  if (!o) return false;
  if (id === parentId) return false;
  // 防止环
  let p = parentId ? getObject(level, parentId) : null;
  let guard = 0;
  while (p && guard++ < 64) {
    if (p.id === id) return false;
    p = p.parent ? getObject(level, p.parent) : null;
  }
  o.parent = parentId || null;
  return true;
}
export function duplicateObjects(level, ids, offset = [0, 0, 0]) {
  const all = [];
  for (const id of ids) for (const o of collectTree(level, id)) all.push(o);
  const map = new Map();
  const copies = all.map((o) => {
    const c = deepClone(o);
    c.id = uid(o.type.slice(0, 2));
    map.set(o.id, c.id);
    return c;
  });
  for (const c of copies) {
    if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent);
    else if (c.parent && !getObject(level, c.parent)) c.parent = null;
    if (isVec3(c.position) && isVec3(offset)) {
      c.position = [c.position[0] + offset[0], c.position[1] + offset[1], c.position[2] + offset[2]];
    }
    level.objects.push(c);
  }
  // 复制涂鸦
  for (const p of level.paints || []) {
    if (map.has(p.objectId)) {
      level.paints.push({ ...deepClone(p), objectId: map.get(p.objectId) });
    }
  }
  // 复制贴纸（贴纸层跟对象一起走）
  for (const s of level.stickers || []) {
    if (map.has(s.objectId)) {
      level.stickers.push({ ...deepClone(s), id: uid('sk'), objectId: map.get(s.objectId) });
    }
  }
  return copies;
}

/* ============================================================
   规范化：把任意来源的 JSON 补齐为合法结构
   ============================================================ */
export function normalizeLevel(raw, opt = {}) {
  const base = createEmptyLevel(opt);
  if (!raw || typeof raw !== 'object') return base;

  const lv = {
    format: APP.levelFormat,
    version: APP.levelVersion,
    id: raw.id || base.id,
    name: String(raw.name ?? base.name).slice(0, 80) || base.name,
    author: String(raw.author ?? base.author).slice(0, 40),
    description: String(raw.description ?? '').slice(0, 600),
    difficulty: clamp(Number(raw.difficulty) || 1, 0.5, 9.99),
    settings: mergeDefaults(raw.settings || {}, defaultLevelSettings()),
    objects: [],
    events: [],
    animations: [],
    paintLayers: [],
    paints: [],
    stickers: [],
    texMods: [],
    meta: { ...base.meta, ...(raw.meta || {}) },
  };

  /* 天空修饰器：旧存档的 skyPitch / skyWarp 迁移成修饰器列表（就地） */
  migrateLegacySky(lv.settings);
  lv.settings.skyMods = normalizeSkyMods(lv.settings.skyMods);

  /* --- 对象 --- */
  const seen = new Set();
  const rawObjs = Array.isArray(raw.objects) ? raw.objects : [];
  for (const r of rawObjs) {
    if (!r || typeof r !== 'object') continue;
    // 旧版「特效对象」已废除 → 迁移成网格模型 + 高级材质（保留位置/尺寸/颜色，不产生碰撞）
    if (r.type === 'effect') {
      const m = migrateEffectObject(r);
      if (seen.has(m.id)) m.id = uid('me');
      seen.add(m.id);
      lv.objects.push(m);
      continue;
    }
    // 旧版「爬梯(桁架)」已废除 → 迁移成普通方块（保留位置/尺寸/颜色/旋转）
    if (r.type === 'mesh' && r.shape === 'truss') {
      const m = migrateTrussObject(r);
      if (seen.has(m.id)) m.id = uid('me');
      seen.add(m.id);
      lv.objects.push(m);
      continue;
    }
    const type = OBJECT_TYPES[r.type] ? r.type : 'mesh';
    const norm = normalizeObject(type, r);
    // 旧存档没有「水纹颜色」→ 取当前水纹风格的 tint 兜底，保证面板色块与实际一致
    if (type === 'liquid') {
      const style = resolveLiquidStyle(norm);
      if (!norm.rippleTint) norm.rippleTint = style.tint;
      // 旧存档的「深处颜色」→ 迁移为锁色相的深度色调倍率（保留原饱和度 / 亮度，色相跟随液面色）
      if (r.depthSat === undefined && r.depthLight === undefined) {
        const tone = deriveDepthTone(norm.color || style.color, r.deepColor || style.deepColor);
        norm.depthSat = tone.sat;
        norm.depthLight = tone.light;
      }
      // 旧存档「水浑浊度(0~1)」→ 迁移为「能见深度(stud)」（0 = 清澈见底，越大能见越远）
      if (r.turbidity !== undefined && norm.visibilityDepth === undefined) {
        const t = Number(r.turbidity) || 0;
        norm.visibilityDepth = t > 0.001 ? Math.round(20 / t) : 0;
      }
      // 旧存档没有「透明度」字段 → 按风格预设兜底，否则会被当成完全不透明
      if (r.transparency === undefined) norm.transparency = 1 - (style.opacity ?? 0.62);
    }
    if (seen.has(norm.id)) norm.id = uid(type.slice(0, 2));
    seen.add(norm.id);
    lv.objects.push(norm);
  }
  // 清理无效父级
  for (const o of lv.objects) if (o.parent && !seen.has(o.parent)) o.parent = null;

  /* --- 涂鸦图层 --- */
  const rawLayers = Array.isArray(raw.paintLayers) ? raw.paintLayers : [];
  for (const r of rawLayers) {
    if (!r || typeof r !== 'object') continue;
    lv.paintLayers.push({
      id: r.id || uid('ly'),
      name: String(r.name || '图层').slice(0, 40),
      visible: r.visible !== false,
      opacity: clamp(Number(r.opacity ?? 1), 0, 1),
      blendMode: BLEND_MODES.some((b) => b.v === r.blendMode) ? r.blendMode : 'normal',
      locked: !!r.locked,
    });
  }
  if (!lv.paintLayers.length) lv.paintLayers.push({ ...DEFAULT_LAYER });
  const layerIds = new Set(lv.paintLayers.map((l) => l.id));

  /* --- 涂鸦笔画 --- */
  for (const r of (Array.isArray(raw.paints) ? raw.paints : [])) {
    if (!r || !seen.has(r.objectId)) continue;
    if (!layerIds.has(r.layerId)) continue;
    lv.paints.push({
      objectId: r.objectId,
      layerId: r.layerId,
      size: clamp(Number(r.size) || 512, 128, 2048),
      strokes: (Array.isArray(r.strokes) ? r.strokes : []).map(normalizeStroke).filter(Boolean),
    });
  }

  /* --- 贴纸（每个网格模型各自一份贴纸层，图片引用走素材 asset:） --- */
  for (const r of (Array.isArray(raw.stickers) ? raw.stickers : [])) {
    if (!r || !seen.has(r.objectId)) continue;
    if (typeof r.tex !== 'string' || !r.tex.startsWith('asset:')) continue;
    if (lv.stickers.filter((x) => x.objectId === r.objectId).length >= EDITOR.stickerMaxPerObject) continue;
    lv.stickers.push({
      id: r.id || uid('sk'),
      objectId: r.objectId,
      tex: r.tex,
      u: clamp(Number(r.u) || 0, -8, 9),
      v: clamp(Number(r.v) || 0, -8, 9),
      w: clamp(Number(r.w) || 0.25, 0.005, 8),
      h: clamp(Number(r.h) || 0.25, 0.005, 8),
      rot: Number(r.rot) || 0,
      rough: clamp(Number(r.rough ?? 0.45), 0, 1),
      trans: clamp(Number(r.trans ?? 0), 0, 1),
      size: clamp(Math.round(Number(r.size) || EDITOR.defaultStickerSize), 512, 4096),
    });
  }

  /* --- 贴图修改器配方（成品贴图在关卡素材里，配方只记怎么算出来的） --- */
  for (const r of (Array.isArray(raw.texMods) ? raw.texMods : [])) {
    const m = normalizeTexMod(r);
    if (m) lv.texMods.push(m);
  }

  /* --- 事件 --- */
  for (const r of (Array.isArray(raw.events) ? raw.events : [])) {
    if (!r || typeof r !== 'object') continue;
    lv.events.push(normalizeEvent(r));
  }
  // 旧的「按钮被按下 / 到达终点 / 玩家死亡」已并入「由相关触发器触发」：
  // 事件改由引用它的对象（触碰/进入/离开事件字段）驱动，这里把引用补上，老关卡照常能跑
  for (const ev of lv.events) {
    const t = ev.trigger;
    if (t.type !== 'buttonClick' && t.type !== 'goalReached' && t.type !== 'playerDied') continue;
    const legacy = t.type;
    t.type = 'related';
    if (legacy === 'buttonClick' && t.objectId) {
      const btn = lv.objects.find((x) => x.id === t.objectId);
      if (btn && !btn.onTouch) btn.onTouch = ev.id;
    } else if (legacy === 'goalReached') {
      for (const o of lv.objects) if (o.type === 'goal' && !o.onTouch) o.onTouch = ev.id;
    }
    t.objectId = '';
  }

  /* --- 动画 --- */
  for (const r of (Array.isArray(raw.animations) ? raw.animations : [])) {
    if (!r || typeof r !== 'object') continue;
    lv.animations.push(normalizeAnimation(r, seen));
  }

  return lv;
}

/** 旧版「特效对象」→ 网格模型 + 高级材质（保留外观，且不产生碰撞，避免凭空多出实心体） */
function migrateEffectObject(r) {
  const m = normalizeObject('mesh', r);
  const c = typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#b98cff';
  m.advMat = 'energyShield';
  m.color = c;
  m.emissive = c;
  m.emissiveIntensity = 1.2;
  m.transparency = 0.55;
  m.castShadow = false;
  m.physicsMode = 'none';   // 旧特效没有碰撞，迁移后也不该有
  m.tag = m.tag || '由特效对象迁移';
  return m;
}

/** 旧版「爬梯(桁架)」→ 普通方块（桁架几何已废除，保留尺寸/颜色/旋转与碰撞） */
function migrateTrussObject(r) {
  const m = normalizeObject('mesh', r);
  m.shape = 'block';
  m.tag = m.tag || '由爬梯迁移';
  return m;
}

/* ============================================================
   NPC 对话图（节点图）
   { entry: 入口节点 id, nodes: [{ id, x, y, speaker, text, next, choices: [{ text, to, cond }] }] }
   · next    = 没有选项时自动跳转的下一节点（空 = 对话结束）
   · choices = 玩家可选的分支项；to = 跳转节点（空 = 结束）；cond = 满足才显示的变量名（空 = 总是显示）
   旧存档里 dialogue 是「台词数组」，这里自动升级成一条线性节点图（向后兼容）。
   ============================================================ */
export function emptyDialogue() { return { entry: '', nodes: [] }; }

export function normalizeDialogue(v) {
  const nodes = [];
  const seen = new Set();
  const mk = (n) => {
    const raw = (n && typeof n === 'object') ? n : {};
    let id = String(raw.id || '').slice(0, 24) || uid('d');
    while (seen.has(id)) id = uid('d');
    seen.add(id);
    const node = {
      id,
      x: Number(raw.x) || 0,
      y: Number(raw.y) || 0,
      speaker: String(raw.speaker || '').slice(0, 40),
      text: String(raw.text || '').slice(0, 600),
      next: '',
      choices: [],
    };
    nodes.push(node);
    return { raw, node };
  };

  /* 旧结构：多段台词数组 → 线性节点图 */
  if (Array.isArray(v)) {
    let prev = null;
    for (const ln of v) {
      if (!ln || typeof ln !== 'object') continue;
      const text = String(ln.text || '').slice(0, 600);
      if (!text) continue;
      const { node } = mk({ speaker: ln.speaker, text, x: 40, y: 40 + nodes.length * 120 });
      if (prev) prev.next = node.id;
      prev = node;
    }
    return { entry: nodes.length ? nodes[0].id : '', nodes };
  }

  const src = (v && typeof v === 'object') ? v : {};
  const rawList = Array.isArray(src.nodes) ? src.nodes : [];
  const pairs = [];
  for (const n of rawList) if (n && typeof n === 'object') pairs.push(mk(n));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const { raw, node } of pairs) {
    const nx = String(raw.next || '');
    node.next = (byId.has(nx) && nx !== node.id) ? nx : '';
    const chs = Array.isArray(raw.choices) ? raw.choices : [];
    for (const c of chs) {
      if (!c || typeof c !== 'object') continue;
      const text = String(c.text || '').slice(0, 120);
      if (!text) continue;
      const to = String(c.to || '');
      node.choices.push({ text, to: (byId.has(to) && to !== node.id) ? to : '', cond: String(c.cond || '').slice(0, 40) });
      if (node.choices.length >= 8) break;
    }
    if (node.choices.length) node.next = '';   // 有分支选项时不再自动跳 next
  }
  const entry = byId.has(String(src.entry || '')) ? String(src.entry) : (nodes.length ? nodes[0].id : '');
  return { entry, nodes };
}

function normalizeObject(type, r) {
  const def = typeDef(type);
  const o = { id: r.id || uid(type.slice(0, 2)), type, parent: r.parent || null };
  for (const p of def.props) {
    let v = r[p.k];
    // 旧存档「贴图重复」(重复次数) → 迁移为「贴图尺寸」(stud)：
    // 拉伸模式数值含义不变；平铺 / 九宫格原先每格边长 = 1 / 重复次数，故换算为倒数
    if (p.k === 'textureSize' && v === undefined && r.textureRepeat !== undefined) {
      const rep = Number(r.textureRepeat);
      if (isFinite(rep) && rep > 0) {
        v = (p.textureFill === 'tile' || p.textureFill === 'nine') ? 1 / rep : rep;
      }
    }
    // 旧存档的发射器没有「方向发射」字段：保持旧的随机四散喷射，别被默认值悄悄切成方向模型
    // （新对象 / 新存档会显式带上该字段，按默认启用方向发射）
    if (p.k === 'dirEmit' && v === undefined) v = false;
    if (v === undefined || v === null) v = deepClone(p.d);
    switch (p.t) {
      case 'num':
        v = Number(v);
        if (!isFinite(v)) v = Number(p.d) || 0;
        if (p.min !== undefined) v = Math.max(p.min, Math.min(p.max, v));
        break;
      case 'int':
        v = Math.round(Number(v));
        if (!isFinite(v)) v = Number(p.d) || 0;
        if (p.min !== undefined) v = Math.max(p.min, Math.min(p.max, v));
        break;
      case 'bool': v = !!v; break;
      case 'vec3':
        v = isVec3(v) ? v.map(Number) : deepClone(p.d);
        break;
      case 'vec3list': {
        const arr = Array.isArray(v) ? v : [];
        v = arr.filter(isVec3).map((x) => x.map(Number));
        if (!v.length && Array.isArray(p.d) && p.d.length) v = deepClone(p.d);
        break;
      }
      case 'vec2list': {
        const arr = Array.isArray(v) ? v : [];
        v = arr.filter((x) => Array.isArray(x) && x.length >= 2).map((x) => [Number(x[0]) || 0, Number(x[1]) || 0]);
        if (!v.length && Array.isArray(p.d) && p.d.length) v = deepClone(p.d);
        break;
      }
      case 'strlist':
        v = (Array.isArray(v) ? v : []).map((x) => String(x));
        break;
      case 'handles': {
        // [[入手柄, 出手柄], ...]，条目可以是 null（表示按相邻节点自动推导）
        const arr = Array.isArray(v) ? v : [];
        v = arr.map((h) => {
          if (!Array.isArray(h)) return null;
          const inV = isVec3(h[0]) ? h[0].map(Number) : null;
          const outV = isVec3(h[1]) ? h[1].map(Number) : null;
          return (inV || outV) ? [inV, outV] : null;
        });
        break;
      }
      case 'objlist':
        v = (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string');
        break;
      /* 粒子条目：每条 = 图像 + 扭曲/蒙版动画 + 权重，逐条规范化（容错旧存档） */
      case 'particles':
        v = (Array.isArray(v) ? v : []).map((e) => normalizeParticleEntry(e));
        break;
      /* NPC 对话图：节点图结构，旧版台词数组自动升级为线性节点图 */
      case 'dlg':
        v = normalizeDialogue(v);
        break;
      case 'color':
        v = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : String(p.d);
        break;
      case 'select':
        if (p.o && !p.o.some((x) => x.v === v)) v = p.d;
        break;
      case 'text': case 'ref': case 'tex': case 'asset': case 'sound': case 'audio':
        v = v === undefined || v === null ? String(p.d ?? '') : String(v);
        break;
      default: v = deepClone(v === undefined ? p.d : v);
    }
    o[p.k] = v;
  }
  // 公告板：旧存档只有 scale，宽 / 高 / UIScale 是派生属性 → 按 scale 反算，
  // 保证属性面板显示的尺寸与实际渲染一致（scale 始终是唯一运行时真值）
  if (type === 'billboard' && Array.isArray(o.scale)) {
    const s = Math.max(0.01, Number(o.sizeScale) || 1);
    o.width = Math.max(0.01, (Number(o.scale[0]) || 1) / s);
    o.height = Math.max(0.01, (Number(o.scale[1]) || 1) / s);
  }
  // 保留自定义扩展字段（不认识的键丢弃，避免脏数据无限增长）
  if (r.tag !== undefined) o.tag = String(r.tag).slice(0, 64);
  // 后处理对象的「逐项启用」开关（不在 props 表里，单独保留）
  if (type === 'postfx' && r.en && typeof r.en === 'object') {
    const en = {};
    for (const k of POSTFX_TOGGLE_KEYS) if (r.en[k] !== undefined) en[k] = !!r.en[k];
    if (Object.keys(en).length) o.en = en;
  }
  return o;
}

function normalizeStroke(s) {
  if (!s || typeof s !== 'object') return null;
  const pts = (Array.isArray(s.pts) ? s.pts : []).filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);
  if (!pts.length) return null;
  return {
    t: s.t === 'erase' ? 'erase' : 'brush',
    m: s.m === 'mat' ? 'mat' : 'color',
    c: typeof s.c === 'string' ? s.c : '#ff5c8a',
    a: clamp(Number(s.a ?? 1), 0, 1),
    s: clamp(Number(s.s) || 24, 0.5, 800),
    h: clamp(Number(s.h ?? 0.5), 0, 1),
    tex: s.tex ? String(s.tex) : '',
    pts,
  };
}

/* ---------- 事件动作：执行图归一化 ----------
   每个动作有稳定 id；a.next = { 槽: [目标 id] } 是执行边，a.inputs = { 字段: {a,o} }
   是值接线。next 缺失 ⇒ 该块回退「数组里的下一个」（旧线性链），因此旧关卡零迁移。 */
function normalizeAction(s) {
  const a = s || {};
  const act = {
    id: a.id || uid('a'),
    type: a.type ? String(a.type) : 'wait',
    objectId: a.objectId || '',
    property: a.property || 'position',
    value: deepClone(a.value !== undefined ? a.value : 0),
    vec: isVec3(a.vec) ? a.vec.map(Number) : [0, 0, 0],
    time: Number(a.time) || 0,
    easing: a.easing || 'linear',
    animId: a.animId || '',
    sound: a.sound || 'click',
    volume: a.volume !== undefined ? Number(a.volume) : 1,
    playerField: a.playerField || 'speed',
    tool: a.tool || 'key',
    varName: a.varName || 'var1',
    op: a.op || '=',
    cond: a.cond || '',
    effect: a.effect || 'splash',
    comment: a.comment || '',
    /* 随机数 / 数组 / 循环 追加字段 */
    rmin: a.rmin !== undefined ? a.rmin : 0,
    rmax: a.rmax !== undefined ? Number(a.rmax) : 1,
    isInt: !!a.isInt,
    chance: a.chance !== undefined ? Number(a.chance) : 50,
    destVar: a.destVar || 'tmp',
    srcVar: a.srcVar || 'arr',
    list: a.list !== undefined ? String(a.list) : '1,2,3',
    index: Number(a.index) || 0,
    count: a.count !== undefined ? a.count : 3,
    maxIter: Number(a.maxIter) || 100,
    audio: a.audio || '',
    loopAudio: !!a.loopAudio,
    /* 顶部弹出信息 */
    noticeText: a.noticeText !== undefined ? String(a.noticeText) : '',
    noticeKind: ['warn', 'error', 'success'].includes(a.noticeKind) ? a.noticeKind : 'info',
    /* 天空球渐变（A → B） */
    fromSky: a.fromSky ? String(a.fromSky) : '',
    toSky: a.toSky ? String(a.toSky) : '',
    /* 玩家 morph */
    morphMode: a.morphMode || 'preset',
    morphPreset: a.morphPreset || 'classic',
    morphAsset: a.morphAsset || '',
    morphScale: a.morphScale !== undefined ? Number(a.morphScale) : 1,
    morphYaw: Number(a.morphYaw) || 0,
    morphY: Number(a.morphY) || 0,
    /* 等待 / 等待直到 */
    waitMode: a.waitMode === 'until' ? 'until' : 'time',
    untilCond: a.untilCond === undefined ? '' : String(a.untilCond),
    /* if / 否则如果 的条件行（else 无字段） */
    elifs: (Array.isArray(a.elifs) ? a.elifs : []).map((e) => ({
      cond: (e && e.cond) || '', op: (e && e.op) || '==', value: deepClone(e ? e.value : 0),
    })),
    /* 2D 平台模式（相机以 P 为基准、只朝 n，在法向量 n 的平面内跟随移动） */
    platMode: a.platMode === 'off' ? 'off' : 'on',
    platPoint: isVec3(a.platPoint) ? a.platPoint.map(Number) : [0, 0, 0],
    platNormal: isVec3(a.platNormal) ? a.platNormal.map(Number) : [0, 0, -1],
    platDist: Number(a.platDist) || 22,
    /* 重力变化（作用域 world/player/both；强度为相对标准重力的倍数） */
    gravityTarget: ['world', 'player', 'both'].includes(a.gravityTarget) ? a.gravityTarget : 'world',
    gravityPower: a.gravityPower !== undefined ? Number(a.gravityPower) : 1,
    /* 高级运算 */
    formula: a.formula !== undefined ? String(a.formula) : '',
    /* 对象生成 / 克隆 / 设为子对象 */
    templateId: a.templateId || '',
    posMode: OBJECT_POS_MODES.some((m) => m.v === a.posMode) ? a.posMode : 'rel',
    posRef: a.posRef || '',
    deepTree: !!a.deepTree,
    parent: a.parent || '',
    keepWorld: a.keepWorld !== false,
    /* 脚本块 / JS 表达式块 */
    code: a.code !== undefined ? String(a.code) : '',
    /* 射线检测 */
    rayFromMode: RAY_FROM_MODES.some((m) => m.v === a.rayFromMode) ? a.rayFromMode : 'player',
    rayFromObj: a.rayFromObj || '',
    rayFromVec: isVec3(a.rayFromVec) ? a.rayFromVec.map(Number) : [0, 0, 0],
    rayToMode: RAY_TO_MODES.some((m) => m.v === a.rayToMode) ? a.rayToMode : 'dir',
    rayToObj: a.rayToObj || '',
    rayToVec: isVec3(a.rayToVec) ? a.rayToVec.map(Number) : [0, -1, 0],
    range: a.range !== undefined ? a.range : 20,
    destObj: a.destObj || 'hitObj',
    destPos: a.destPos || 'hitPos',
    destNormal: a.destNormal || 'hitNormal',
    destDist: a.destDist || 'hitDist',
    /* 读取属性 */
    propTarget: ['object', 'player', 'world', 'session'].includes(a.propTarget) ? a.propTarget : 'object',
    propPath: a.propPath !== undefined ? String(a.propPath) : '',
    /* NPC 动作 */
    npcId: a.npcId || '',
    node: a.node !== undefined ? String(a.node) : '',
    npcBehavior: ['idle', 'follow', 'patrol'].includes(a.npcBehavior) ? a.npcBehavior : 'follow',
    npcKeep: a.npcKeep !== undefined ? Number(a.npcKeep) : 7,
    npcOn: a.npcOn !== false,
    sayText: a.sayText !== undefined ? String(a.sayText).slice(0, 300) : '',
    sayTime: a.sayTime !== undefined ? Number(a.sayTime) : 3,
    npcFace: a.npcFace === 'point' ? 'point' : 'player',
    npcClip: a.npcClip !== undefined ? String(a.npcClip).slice(0, 60) : '',
    /* 执行边 / 值接线 / 暴露列表：先原样带过来，随后由 cleanNext / cleanInputs /
       cleanExpose 按「合法槽位、存活目标、可暴露字段」统一清洗（不在这里丢） */
    next: a.next && typeof a.next === 'object' ? a.next : null,
    inputs: a.inputs && typeof a.inputs === 'object' ? a.inputs : null,
    expose: Array.isArray(a.expose) ? a.expose : [],
  };
  for (const k of MATH_VAR_KEYS) act[k] = a[k] !== undefined ? Number(a[k]) || 0 : 0;
  // 重力变化的默认方向朝下；零向量在运行时会被回退成 [0,-1,0]，这里提前补齐以免 UI 与数据不一致
  if (act.type === 'setGravity' && act.vec.every((n) => !n)) act.vec = [0, -1, 0];
  return act;
}

/** 清洗执行边：只留本块真实存在的输出槽，且目标必须是存活动作 */
function cleanNext(act, idSet) {
  const src = act.next;
  if (!src || typeof src !== 'object') return null;
  const out = {};
  for (const o of outsOf(act)) {
    out[o.k] = Array.isArray(src[o.k])
      ? src[o.k].filter((id) => idSet.has(id) && id !== act.id)
      : [];
  }
  return out;                       // 空对象也算「显式」：该块到此为止，不再回退线性链
}

/** 清洗值接线：键必须是本块允许的输入口，来源必须是存活动作 */
function cleanInputs(act, idSet) {
  const src = act.inputs;
  if (!src || typeof src !== 'object') return null;
  const keys = new Set(inputKeysOf(act));
  const out = {};
  for (const k of Object.keys(src)) {
    if (!keys.has(k)) continue;
    const w = src[k];
    if (!w || typeof w !== 'object' || !idSet.has(w.a)) continue;
    out[k] = { a: w.a, o: w.o || 'v' };
  }
  return Object.keys(out).length ? out : null;
}

/** 清洗暴露参数：只留本块允许暴露的字段 */
function cleanExpose(act) {
  const src = act.expose;
  if (!Array.isArray(src)) return [];
  const ok = new Set(exposableOf(act));
  return src.filter((k) => ok.has(k));
}

function normalizeEvent(r) {
  const src = r || {};
  const actions = (Array.isArray(src.actions) ? src.actions : []).map(normalizeAction);
  const ids = new Set(actions.map((a) => a.id));
  migrateBranch(actions);
  for (const a of actions) {
    a.next = cleanNext(a, ids);
    a.inputs = cleanInputs(a, ids);
    a.expose = cleanExpose(a);
  }
  let start = null;
  if (Array.isArray(src.start)) {
    const list = src.start.filter((id) => ids.has(id));
    if (list.length) start = list;
  }
  return {
    id: src.id || uid('ev'),
    name: String(src.name || '事件').slice(0, 60),
    enabled: src.enabled !== false,
    trigger: {
      type: src.trigger && src.trigger.type ? src.trigger.type : 'levelStart',
      objectId: (src.trigger && src.trigger.objectId) || '',
      time: Number(src.trigger && src.trigger.time) || 0,
      repeat: !!(src.trigger && src.trigger.repeat),
      value: Number(src.trigger && src.trigger.value) || 0,
      varName: (src.trigger && src.trigger.varName) || '',
      op: (src.trigger && src.trigger.op) || '==',
      once: !!(src.trigger && src.trigger.once),
    },
    start,
    actions,
  };
}

/**
 * 旧「条件分支」块迁移为 if 块：
 * 条件成立 → 原来的线性后继（then 路）；不成立 → 结束（else 路留空）。
 * 旧行为是「不成立就停止」，所以迁移后 other 块仍走各自的隐式线性链，行为完全一致。
 */
function migrateBranch(actions) {
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.type !== 'branch') continue;
    a.type = 'ifBlock';
    if (!Array.isArray(a.elifs)) a.elifs = [];
    if (!a.next || typeof a.next !== 'object') {
      const nxt = actions[i + 1] ? actions[i + 1].id : null;
      a.next = { then: nxt ? [nxt] : [], else: [] };
    }
  }
}

function normalizeAnimation(r, idSet) {
  const tracks = (Array.isArray(r.tracks) ? r.tracks : []).map((t) => ({
    objectId: (t && t.objectId) || '',
    property: (t && t.property) || 'position',
    type: (t && t.type) || 'vec3',
    keys: (Array.isArray(t && t.keys) ? t.keys : []).map((k) => ({
      t: Math.max(0, Number(k && k.t) || 0),
      v: deepClone(k ? k.v : 0),
      easing: (k && k.easing) || 'linear',
      ease: Array.isArray(k && k.ease) ? k.ease.slice(0, 4).map(Number) : undefined,
    })).sort((a, b) => a.t - b.t),
  })).filter((t) => t.objectId && idSet.has(t.objectId));
  let dur = Number(r.duration) || 0;
  for (const t of tracks) for (const k of t.keys) dur = Math.max(dur, k.t);
  return {
    id: r.id || uid('an'),
    name: String(r.name || '动画').slice(0, 60),
    duration: Math.max(0.1, dur || 1),
    loop: !!r.loop,
    pingpong: !!r.pingpong,
    autoplay: !!r.autoplay,
    enabled: r.enabled !== false,
    tracks,
  };
}

/* ============================================================
   校验
   ============================================================ */
export function validateLevel(level) {
  const errors = [], warnings = [];
  if (!level || typeof level !== 'object') return { ok: false, errors: ['关卡数据无效'], warnings };
  if (!level.objects.length) warnings.push('关卡里没有任何对象');

  const ids = new Set(level.objects.map((o) => o.id));
  const spawns = objectsOfType(level, 'spawn');
  const goals = objectsOfType(level, 'goal');
  if (!spawns.length) warnings.push('没有放置「起点」，玩家会从天空掉落');
  if (!goals.length) warnings.push('没有放置「终点」，这关无法通关');

  const dupCount = level.objects.length - ids.size;
  if (dupCount > 0) errors.push(`存在 ${dupCount} 个重复的对象 ID`);

  for (const o of level.objects) {
    if (o.parent && !ids.has(o.parent)) errors.push(`对象「${objectLabel(o)}」的父级不存在`);
    if (!isVec3(o.position)) errors.push(`对象「${objectLabel(o)}」位置无效`);
    if (PATH_TYPES.has(o.type) && o.pathSource !== 'curve' && (!o.points || o.points.length < 2)) {
      warnings.push(`「${objectLabel(o)}」至少需要 2 个节点`);
    }
    if (PATH_TYPES.has(o.type) && o.pathSource === 'curve') {
      const src = o.pathRef ? getObject(level, o.pathRef) : null;
      if (!src) errors.push(`「${objectLabel(o)}」引用的折曲线对象不存在`);
      else if (src.type !== 'curve') warnings.push(`「${objectLabel(o)}」引用的对象「${objectLabel(src)}」不是折曲线`);
    }
    if (o.type === 'pipe' && o.section === 'custom' && (!o.sectionPts || o.sectionPts.length < 3)) {
      warnings.push(`管道「${objectLabel(o)}」的自定义截面少于 3 个顶点，将回退为圆形`);
    }
    if (o.type === 'meshref') {
      const src = o.sourceRef ? getObject(level, o.sourceRef) : null;
      if (!src) warnings.push(`网格修改器「${objectLabel(o)}」未指定引用对象`);
      else if (src.type === 'meshref') errors.push(`网格修改器「${objectLabel(o)}」不能引用另一个网格修改器`);
      if (o.distMode === 'curve' && !o.curveRef) warnings.push(`网格修改器「${objectLabel(o)}」选择沿曲线分布，但未指定分布曲线`);
    }
    if (o.type === 'liquid') {
      if (!o.anchored && o.physicsMode === 'mesh') warnings.push('液体使用网格物理会严重卡顿');
    }
    if (o.physicsMode === 'mesh') warnings.push(`「${objectLabel(o)}」使用精确网格碰撞，性能开销大`);
    if (o.type === 'mesh' && o.shape === 'model' && !o.assetId) warnings.push(`「${objectLabel(o)}」未选择模型资源`);
    if (o.type === 'door' && o.requiredToolId) {
      const t = getObject(level, o.requiredToolId);
      if (!t) errors.push(`门「${objectLabel(o)}」指定的工具对象不存在`);
      else if (t.type !== 'tool') warnings.push(`门「${objectLabel(o)}」指定的对象「${objectLabel(t)}」不是工具`);
    } else if (o.type === 'door' && o.requiredTool && !objectsOfType(level, 'tool').some((t2) => t2.tool === o.requiredTool)) {
      warnings.push(`门「${objectLabel(o)}」需要工具「${o.requiredTool}」，但关卡里没有该工具`);
    }
  }

  for (const ev of level.events) {
    if (!ev.actions.length) warnings.push(`事件「${ev.name}」没有任何动作`);
    if (ev.trigger.objectId && !ids.has(ev.trigger.objectId)) errors.push(`事件「${ev.name}」的触发对象不存在`);
    const alive = new Set(ev.actions.map((a) => a.id));
    const open = [];
    for (const a of ev.actions) {
      if (a.objectId && !ids.has(a.objectId) && needsObject(a.type)) errors.push(`事件「${ev.name}」中动作引用的对象不存在`);
      if (a.animId && !getAnim(level, a.animId)) warnings.push(`事件「${ev.name}」引用了不存在的动画`);
      if (a.templateId && !ids.has(a.templateId)) warnings.push(`事件「${ev.name}」的「生成对象」找不到模板对象`);
      if (a.parent && !ids.has(a.parent)) warnings.push(`事件「${ev.name}」的「设为子对象」父对象不存在`);
      if (a.type === 'mathExpr' && a.formula) {
        const fe = formulaError(a.formula);
        if (fe) warnings.push(`事件「${ev.name}」的高级运算公式有误：${fe}`);
      }
      if (a.type === 'ifBlock') {
        const nx = a.next || {};
        const anyOut = ['then', 'else'].some((k) => (nx[k] || []).length)
          || (a.elifs || []).some((_, i) => (nx['elif' + i] || []).length);
        if (!anyOut) warnings.push(`事件「${ev.name}」的条件判断没有连出任何分支`);
      }
      if ((a.type === 'createObject' || a.type === 'cloneObject') && a.posMode === 'rel' && !a.posRef) {
        warnings.push(`事件「${ev.name}」的生成位置选了「相对对象」但没指定参照对象`);
      }
      /* 悬空的执行边 / 值接线（指向已删除的动作） */
      for (const o of outsOf(a)) {
        const list = a.next && a.next[o.k];
        if (Array.isArray(list) && list.some((t) => !alive.has(t))) errors.push(`事件「${ev.name}」有连线指向已删除的动作`);
      }
      for (const k of Object.keys(a.inputs || {})) {
        const w = a.inputs[k];
        if (!w || !alive.has(w.a)) errors.push(`事件「${ev.name}」有参数接线指向已删除的动作`);
      }
      /* 循环配对 */
      if (LOOP_START_TYPES.includes(a.type)) open.push(a);
      else if (a.type === 'loopEnd') {
        if (!open.length) warnings.push(`事件「${ev.name}」有「循环结束」没有对应的「循环开始」`);
        else open.pop();
      }
    }
    for (const s of open) warnings.push(`事件「${ev.name}」的「${s.type}」没有对应的「循环结束」`);
    const cyc = findEdgeCycle(ev);
    if (cyc) errors.push(`事件「${ev.name}」的执行连线成环：${cyc}`);
  }

  // 涂鸦图层一致性
  const lids = new Set(level.paintLayers.map((l) => l.id));
  for (const p of level.paints) {
    if (!ids.has(p.objectId)) warnings.push('部分涂鸦数据找不到对应对象，已忽略');
    if (!lids.has(p.layerId)) warnings.push('部分涂鸦数据引用了已删除的图层，已忽略');
  }
  return { ok: errors.length === 0, errors, warnings };
}

function needsObject(actionType) {
  return ['showObject', 'hideObject', 'setProperty', 'moveObject', 'rotateObject',
    'scaleObject', 'setLiquid', 'openDoor', 'closeDoor', 'cloneObject', 'setParent'].includes(actionType);
}

/**
 * 执行连线成环检测（沿 next 槽 + 隐式线性链走）。
 * 循环块的回跳是隐式的（按 id 配对），不会体现在 next 上，所以正常循环不会误报。
 * @returns {string|null} 环上的动作类型串；无环返回 null
 */
function findEdgeCycle(ev) {
  const byId = new Map();
  ev.actions.forEach((a, i) => { if (a) byId.set(a.id, a); });
  const state = new Map();          // action -> 1 在栈上 / 2 已完成
  const path = [];
  const walk = (a) => {
    if (!a) return null;
    const s = state.get(a) || 0;
    if (s === 1) return path.slice(path.indexOf(a)).concat(a).map((x) => x.type).join(' → ');
    if (s === 2) return null;
    state.set(a, 1);
    path.push(a);
    const slots = outsOf(a);
    for (const o of slots) {
      const list = (a.next && a.next[o.k]) || [];
      for (const t of list) { const r = walk(byId.get(t)); if (r) return r; }
    }
    if (!a.next) {                  // 隐式线性链：数组里的下一个
      const r = walk(ev.actions[ev.actions.indexOf(a) + 1]);
      if (r) return r;
    }
    path.pop();
    state.set(a, 2);
    return null;
  };
  const entries = (Array.isArray(ev.start) && ev.start.length) ? ev.start : null;
  const firsts = entries ? entries.map((id) => byId.get(id)) : [ev.actions[0]];
  for (const f of firsts) { const r = walk(f); if (r) return r; }
  return null;
}

/* ============================================================
   统计（菜单里显示关卡规模）
   ============================================================ */
export function levelStats(level) {
  if (!level) return { objects: 0, meshes: 0, liquids: 0, events: 0, animations: 0, lights: 0, tutorials: 0 };
  const byType = {};
  let liquidVolume = 0;
  for (const o of level.objects) {
    byType[o.type] = (byType[o.type] || 0) + 1;
    if (o.type === 'liquid') {
      const s = o.scale || [0, 0, 0];
      liquidVolume += Math.abs(s[0] * s[1] * s[2]);
    }
  }
  return {
    objects: level.objects.length,
    meshes: byType.mesh || 0,
    liquids: byType.liquid || 0,
    lights: byType.light || 0,
    tools: byType.tool || 0,
    events: level.events.length,
    animations: level.animations.length,
    byType,
    liquidVolume: Math.round(liquidVolume),
  };
}

/* ---------- 序列化 ---------- */
/** @param {Array} [assets] 本地化素材（base64），随关卡一起导出，使文件自包含 */
export function levelToJSON(level, assets) {
  const out = deepClone(level);
  out.format = APP.levelFormat;
  out.version = APP.levelVersion;
  out.meta = { ...(out.meta || {}), updated: Date.now() };
  if (assets && assets.length) out.assets = assets;
  return JSON.stringify(out);
}
export function levelFromJSON(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { level: null, error: '文件不是合法的 JSON' }; }
  if (!raw || (raw.format && raw.format !== APP.levelFormat)) {
    return { level: null, error: '这不是 Flooding Dreams 关卡文件' };
  }
  // normalizeLevel 会丢掉未知顶层字段，所以素材要先取出来
  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  return { level: normalizeLevel(raw), error: null, assets };
}
export function cloneLevel(level, rename) {
  const c = normalizeLevel(deepClone(level));
  c.id = uid('lv');
  c.name = rename || (level.name + ' 副本');
  c.meta = { created: Date.now(), updated: Date.now() };
  return c;
}

export { defaultLevelSettings };