/* ============================================================
   对象类型注册表 —— 编辑器 / 运行时共用的唯一契约
   每个类型声明：几何构造、属性表（供属性面板自动生成）、物理形状、行为标记
   属性表条目：{ k:键, l:标签, t:类型, d:默认值, min,max,step, g:分组, o:选项, h:提示 }
   类型 t: num | int | bool | color | vec3 | tex | asset | text | select | ref
           | sound | easing | objlist | tool | anim
   ============================================================ */
import * as THREE from 'three';
import { uid, clamp } from '../core/util.js';
import { LIQUID_KINDS, PLAYER, BUILTIN_TEXTURES, EASINGS, TOOL_DEFS, PHYS } from '../config.js';
import { liquidStyleOptions, applyLiquidStyle, STYLE_BY_KIND } from './liquid-presets.js';
import { ADV_OPTIONS, applyAdvancedMaterial } from './advanced-materials.js';
import { POSTFX_PRESETS, POSTFX_STYLE_OPTIONS } from '../core/postfx.js';
import { TONE_MAPPING_OPTIONS, COLOR_SPACE_OPTIONS } from '../core/exposure.js';
import { SECTION_OPTIONS, sectionProfile } from './paths.js';
import { BOX_TEMPLATE } from './poly-mesh.js';
import { vecPhysicsShape } from '../core/vector-solid.js';
import { newLayer, newPath } from '../core/vector-shape.js';
import { t } from '../core/i18n.js';
import { PORTAL_PRESET_OPTIONS, PORTAL_FRAME_OPTIONS, PORTAL_BLEND_OPTIONS, PORTAL_DEPTH_MAX, portalPresetShape } from './portal.js';

/* ---------- 分组名 ---------- */
export const GROUPS = {
  base: '常规', xform: '变换', look: '外观', tex: '贴图', phys: '物理',
  behave: '行为', event: '事件', adv: '高级', light: '灯光', liquid: '液体',
  fx: '特效', post: '后处理', hier: '层级', pbr: 'PBR 贴图',
  npc: 'NPC 行为', dialog: '对话',
};

const POSTFX_PRESET_OPTIONS = POSTFX_PRESETS.map((p) => ({ v: p.v, l: p.l }));

/* ---------- 可用形状 ---------- */
export const SHAPES = {
  block:    { label: '立方体',   icon: '▦', geo: 'box' },
  sphere:   { label: '球',       icon: '●', geo: 'sphere' },
  prism:    { label: '多边形柱', icon: '⬢', geo: 'prism' },
  cylinder: { label: '圆柱',     icon: '⬤', geo: 'cylinder' },
  wedge:    { label: '楔形',     icon: '◤', geo: 'wedge' },
  cone:     { label: '圆锥',     icon: '▲', geo: 'cone' },
  torus:    { label: '圆环',     icon: '◎', geo: 'torus' },
  model:    { label: '自定义模型', icon: '🧊', geo: 'model' },
};
export const SHAPE_OPTIONS = Object.entries(SHAPES).map(([v, s]) => ({ v, l: s.label }));

/* ---------- NPC 外观预设 ----------
   内置项与 player/avatar.js 的 PLAYER_PRESETS 一一对应（这里只列 key，构建时按 key 取配色）；
   末项「自定义模型」改用导入的 .glb/.gltf 角色素材。 */
export const NPC_PRESET_OPTIONS = [
  { v: 'classic', l: '经典 R6' },
  { v: 'slim', l: '瘦长' },
  { v: 'bulky', l: '壮硕' },
  { v: 'kid', l: '小孩' },
  { v: 'ghost', l: '幽灵' },
  { v: 'neon', l: '霓虹' },
  { v: 'custom', l: '自定义模型' },
];

/* ---------- 通用属性条目工厂 ---------- */
const A = {
  name: () => ({ k: 'name', l: '名称', t: 'text', d: '', g: GROUPS.base, h: '留空则自动命名' }),
  position: () => ({ k: 'position', l: '位置', t: 'vec3', d: [0, 0, 0], g: GROUPS.xform, st: 0.5 }),
  rotation: () => ({ k: 'rotation', l: '旋转(度)', t: 'vec3', d: [0, 0, 0], g: GROUPS.xform, st: 5 }),
  scale: (d = [4, 1, 4]) => ({ k: 'scale', l: '尺寸/缩放', t: 'vec3', d, g: GROUPS.xform, st: 0.5, min: 0.02 }),
  color: (d = '#d9d2ee') => ({ k: 'color', l: '颜色', t: 'color', d, g: GROUPS.look }),
  /** 智能材质调制：默认关。开启后「颜色」不再是“直接乘在贴图上”，
      而是按贴图预先统计的平均色相 / 饱和度做智能重调制（灰阶也能被染色，
      同时保留纹理自身的色彩层次）。颜色为白 / 灰 / 黑时自动退化为原来的相乘 */
  smartMod: () => ({ k: 'smartMod', l: '智能调制', t: 'bool', d: false, g: GROUPS.look,
    h: '开启后「颜色」从“直接乘在贴图上”升级为“智能重调制”：加载时预先统计贴图的平均色相 / 饱和度，' +
      '运行时把贴图的灰阶分量换成「颜色」、有彩分量做色相旋转与饱和度缩放 —— ' +
      '于是灰阶贴图也能被任意染色，同时保留纹理自身的色彩层次(丰富度)。' +
      '「颜色」为白 / 灰 / 黑时自动退化为原来的相乘，不会改变外观；关闭则恢复「颜色 × 贴图」的相乘方式' }),
  transparency: (d = 0) => ({ k: 'transparency', l: '透明度', t: 'num', d, min: 0, max: 1, st: 0.01, g: GROUPS.look }),
  metalness: (d = 0.05) => ({ k: 'metalness', l: '金属光泽度', t: 'num', d, min: 0, max: 1, st: 0.01, g: GROUPS.look }),
  roughness: (d = 0.72) => ({ k: 'roughness', l: '粗糙度', t: 'num', d, min: 0, max: 1, st: 0.01, g: GROUPS.look }),
  advMat: () => ({ k: 'advMat', l: '高级材质', t: 'select', d: 'none', o: ADV_OPTIONS, g: GROUPS.look,
    h: '内置 41 种特殊 / 特效表面材质（玻璃、金属、力场、全息、熔岩…）；选中后会自动套用该材质的推荐参数，' +
      '下面的颜色 / 粗糙度 / 自发光仍可继续微调。「不使用」= 普通标准材质' }),
  reflectivity: () => ({ k: 'reflectivity', l: '反射率', t: 'num', d: 1, min: 0, max: 3, st: 0.05, g: GROUPS.look,
    h: '环境反射强度：0 = 不反射，1 = 预设默认，3 = 镜面级。反射用的是一次性捕获的场景立方体贴图，运行时几乎不耗性能' }),
  fxScale: () => ({ k: 'fxScale', l: '图案密度', t: 'num', d: 1, min: 0.05, max: 32, st: 0.05, g: GROUPS.look,
    h: '仅带图案的高级材质有效：条纹 / 网格 / 六边形等的疏密程度' }),
  fxAmp: () => ({ k: 'fxAmp', l: '图案强度', t: 'num', d: 0.8, min: 0, max: 2, st: 0.05, g: GROUPS.look,
    h: '仅带图案的高级材质有效：0 = 只留底色，越大图案越明显' }),
  fxColor: () => ({ k: 'fxColor', l: '图案色', t: 'color', d: '#ffffff', g: GROUPS.look,
    h: '仅带图案的高级材质有效：图案的副色 / 底色' }),
  /* 玻璃（高级材质 · 屏幕空间折射）：仅当高级材质选「玻璃」时生效 */
  ior: () => ({ k: 'ior', l: '折射率', t: 'num', d: 1.5, min: 1, max: 2.5, st: 0.01, g: GROUPS.look,
    h: '仅玻璃材质有效：介质折射率。空气 1.0、水 1.33、玻璃 1.5、水晶 2.0、钻石 2.42' }),
  glassAbsorb: () => ({ k: 'glassAbsorb', l: '边缘吸光', t: 'num', d: 0.55, min: 0, max: 1, st: 0.01, g: GROUPS.look,
    h: '仅玻璃材质有效：体积吸收强度（Beer-Lambert）。掠射角光程更长，因此边缘更暗 / 更染色，' +
      '吸收染色取对象「颜色」。0 = 通透无色，1 = 边缘吸收最强' }),
  texture: () => ({ k: 'texture', l: '底贴图', t: 'tex', d: 'none', g: GROUPS.tex }),
  /* PBR 贴图：默认折叠在「PBR 贴图」分组里（展开后才显示）。
     粗糙度图与法线图都是用同一套贴图导入 / 选择控件，区别只在材质里的色彩空间 */
  roughnessMap: () => ({ k: 'roughnessMap', l: '粗糙度图', t: 'tex', d: 'none', g: GROUPS.pbr,
    h: 'PBR 粗糙度贴图：像素亮度决定表面粗糙程度（越亮越粗糙）。按线性色彩空间采样，' +
      '与「粗糙度」数值相乘。未设置时使用「粗糙度」数值' }),
  normalMap: () => ({ k: 'normalMap', l: '法线图', t: 'tex', d: 'none', g: GROUPS.pbr,
    h: 'PBR 法线贴图：在不增加面数的前提下表现表面凹凸细节。按线性色彩空间采样，' +
      '需使用切线空间法线图（常见蓝紫色那张）' }),
  /* 顶点 AO 烘焙开关：默认开（接缝处的接触阴影，方块看起来才“坐得住”）。
     程序化生成的大尺度体块（白模）会关掉它 —— 那类方块又大又多，
     每个几何体会被细分到 16 段、还要逐顶点打射线烘焙，代价极高，
     而它们是大平面，AO 收益几乎为零。隐藏项：面板不显示，数据仍然保留。 */
  bakeAO: () => ({ k: 'bakeAO', l: '顶点AO', t: 'bool', d: true, g: GROUPS.adv, hide: true,
    h: '关掉后该对象不做顶点 AO 烘焙，几何体也不会细分（大块体省性能）' }),
  textureFill: () => ({ k: 'textureFill', l: '填充模式', t: 'select', d: 'stretch', g: GROUPS.tex,
    o: [
      { v: 'stretch', l: '拉伸' },
      { v: 'tile', l: '平铺不拉伸' },
      { v: 'nine', l: '九宫格' },
    ],
    h: '拉伸=一张贴图铺满整个面；平铺不拉伸=贴图按原比例整块重复（每格都是正方格，不会被拉扁），' +
      '格子的世界边长只由“贴图尺寸”决定，因此不同大小的物体上图案比例完全一致；' +
      '九宫格=贴图外圈(1/3)嵌进四角，四边与中间等宽平铺（整图等比缩放，不会忽宽忽窄 / 出现接缝）。' +
      '想在贴图上做扰动 / 失真 / 调色等加工，用「贴图修改器」生成一张新贴图素材再引用它' }),
  textureSize: () => ({ k: 'textureSize', l: '贴图尺寸(stud)', t: 'num', d: 1, min: 0.05, max: 10000, st: 0.05, g: GROUPS.tex,
    h: '拉伸=重复次数（铺满整面）；平铺=每格贴图的世界边长(stud)，数值越大图案越大，' +
      '与物体尺寸无关；九宫格=目标边框厚度(stud)，取整后整图等比缩放；低模建模体 / 自定义模型 / 管道 / 曲线墙等 trimesh 一律按' +
      '「每格贴图的世界边长(stud)」计：小=密集，大=稀疏' }),
  castShadow: (d = true) => ({ k: 'castShadow', l: '投射阴影', t: 'bool', d, g: GROUPS.look }),
  flatShading: (d = false) => ({ k: 'flatShading', l: '平面着色', t: 'bool', d, g: GROUPS.look }),
  emissive: () => ({ k: 'emissive', l: '自发光色', t: 'color', d: '#000000', g: GROUPS.look }),
  emissiveIntensity: () => ({ k: 'emissiveIntensity', l: '自发光强度', t: 'num', d: 0, min: 0, max: 8, st: 0.05, g: GROUPS.look }),
  lightInfluence: (g = GROUPS.fx) => ({ k: 'lightInfluence', l: '光照影响', t: 'num', d: 1, min: 0, max: 1, st: 0.05, g,
    h: '该特效受「曝光补偿 / 画面染色(饱和度+染色) / 场景光照」影响的比例：' +
      '0 = 完全不受影响（始终按自身原始亮度 / 颜色绘制），1 = 完全跟随（默认），中间线性混合' }),
  anchored: (d = true) => ({ k: 'anchored', l: '锚定(不模拟物理)', t: 'bool', d, g: GROUPS.phys,
    h: '锚定的物体固定不动；未锚定的会掉落' }),
  mass: (d = 1) => ({ k: 'mass', l: '质量', t: 'num', d, min: 0.01, max: 500, st: 0.1, g: GROUPS.phys }),
  material: () => ({ k: 'material', l: '物理材质', t: 'select', d: 'default', g: GROUPS.phys,
    o: [{ v: 'default', l: '标准' }, { v: 'ice', l: '冰面(滑)' }, { v: 'bouncy', l: '弹性' }] }),
  visible: (d = true) => ({ k: 'visible', l: '可见', t: 'bool', d, g: GROUPS.base,
    h: '关闭后游戏内与编辑器中都隐藏；用事件“显示对象”可再打开' }),
  frozen: () => ({ k: 'frozen', l: '编辑锁定', t: 'bool', d: false, g: GROUPS.base }),
  shape: (d = 'block', allow) => ({ k: 'shape', l: '形状', t: 'select', d, g: GROUPS.base, o: allow || SHAPE_OPTIONS }),
  sides: () => ({ k: 'sides', l: '边数', t: 'int', d: 6, min: 3, max: 32, st: 1, g: GROUPS.base,
    h: '仅多边形柱有效' }),
  assetId: () => ({ k: 'assetId', l: '模型资源', t: 'asset', d: '', g: GROUPS.tex,
    h: '从本地导入 .glb/.gltf/.obj 文件' }),
  physicsMode: () => ({ k: 'physicsMode', l: '碰撞体', t: 'select', d: 'box', g: GROUPS.phys,
    o: [{ v: 'box', l: '包围盒(快)' }, { v: 'mesh', l: '网格(精确/慢)' }, { v: 'none', l: '无碰撞' }] }),

  /* ---------- 路径型对象（滑索 / 折曲线 / 管道）共用 ---------- */
  pathPoints: (d = [[0, 10, 0], [0, 10, 30], [0, 10, 60]]) =>
    ({ k: 'points', l: '节点路径', t: 'vec3list', d, g: GROUPS.behave,
      h: '每个节点的 Y 为高度；曲线段之间由贝塞尔手柄控制弧度（在视图里直接拖手柄）' }),
  segModes: (d = ['curve', 'curve']) =>
    ({ k: 'segModes', l: '段模式', t: 'strlist', d, g: GROUPS.behave,
      o: [{ v: 'curve', l: '曲线' }, { v: 'line', l: '直线' }],
      h: '逐段选择：曲线 = 三次贝塞尔（用两端节点的贝塞尔手柄）；直线 = 直连（忽略手柄）' }),
  handles: () => ({ k: 'handles', l: '贝塞尔手柄', t: 'handles', d: [], g: GROUPS.behave, hide: true,
    h: '每个节点带一对相对手柄 [入手柄, 出手柄]，在视图里直接拖拽调整；' +
      '曲线段用手柄作控制点，直线段忽略手柄；' +
      '条目为空的节点按相邻节点自动推导（Catmull-Rom），未手动画过手柄的路径保持原有平滑外观' }),
  pathSource: () => ({ k: 'pathSource', l: '路径来源', t: 'select', d: 'self', g: GROUPS.behave,
    o: [{ v: 'self', l: '自身节点' }, { v: 'curve', l: '引用折曲线对象' }],
    h: '选「引用折曲线对象」后，路径完全跟随被引用的折曲线（改折曲线，本对象自动重建）；' +
      '此时「位置」作为整体偏移' }),
  pathRef: () => ({ k: 'pathRef', l: '折曲线对象', t: 'objref', of: 'curve', d: '', g: GROUPS.behave,
    h: '仅「路径来源 = 引用折曲线对象」时生效' }),
  radius: (d = 0.18) => ({ k: 'radius', l: '粗细', t: 'num', d, min: 0.02, max: 10000, st: 0.02, g: GROUPS.look }),
  tubeSeg: () => ({ k: 'tubeSeg', l: '截面边数', t: 'int', d: 8, min: 3, max: 16, st: 1, g: GROUPS.look,
    h: '管身横截面的细分：3~5 是明显的多边形管，8 以上接近圆管' }),
  /** 平滑着色：路径型对象（折曲线 / 管道 / 曲线墙）共用。
      内部就是材质的 flatShading 开关（见 builder.pathLook），所以只换材质、不重建几何 */
  smoothShade: (d = true) => ({ k: 'smoothShade', l: '平滑着色', t: 'bool', d, g: GROUPS.look,
    h: '开：顶点法线平滑过渡（管子圆润）；关：按面法线渲染，面与面之间出现硬边' }),
};

/* ---------- 事件/引用属性 ---------- */
const REF_TOUCH = () => ({ k: 'onTouch', l: '触碰触发事件', t: 'ref', d: '', g: GROUPS.event, h: '选择要触发的事件' });
const REF_ENTER = () => ({ k: 'onEnter', l: '进入触发事件', t: 'ref', d: '', g: GROUPS.event });
const REF_EXIT = () => ({ k: 'onExit', l: '离开触发事件', t: 'ref', d: '', g: GROUPS.event });

/* ---------- 网格模型通用属性 ---------- */
export const MESH_PROPS = [
  A.name(), A.shape(), A.sides(),
  A.position(), A.rotation(), A.scale(),
  A.color(), A.smartMod(), A.transparency(), A.metalness(), A.roughness(),
  A.texture(), A.textureFill(), A.textureSize(), A.flatShading(),
  A.emissive(), A.emissiveIntensity(),
  A.castShadow(), A.visible(), A.frozen(),
  A.anchored(), A.mass(), A.material(),
  A.assetId(), A.physicsMode(), A.bakeAO(),
];

/** 网格模型（含攀爬墙）的外观表：在「粗糙度」后面插入高级材质相关项 */
const ADV_AFTER_ROUGHNESS = () => [
  A.advMat(), A.reflectivity(), A.fxScale(), A.fxAmp(), A.fxColor(),
  A.ior(), A.glassAbsorb(),
];
export const MESH_PROPS_ADV = MESH_PROPS.flatMap((p) => (
  p.k === 'roughness' ? [p, ...ADV_AFTER_ROUGHNESS()] : p
)).concat([A.roughnessMap(), A.normalMap()]);

/* 液体外观：自发光色与水体颜色统一，不暴露在面板（数据仍保留，供预设写入）；
   液体走自绘材质而非标准材质，智能调制对它无效，同样隐藏 */
const LIQUID_MESH_PROPS = MESH_PROPS.map((p) => (
  (p.k === 'emissive' || p.k === 'smartMod') ? { ...p, hide: true } : p
));

/* ============================================================
   几何构造（全部构造为“单位尺寸”，靠 mesh.scale 缩放）
   ============================================================ */
const _geoCache = new Map();
function cacheGeo(key, make) {
  let g = _geoCache.get(key);
  if (!g) { g = make(); _geoCache.set(key, g); }
  return g;
}

/* ---------- 涂鸦面图集 ----------
   立方体 6 个面各占图集里的一格（3×3，只用前两行）：
   这样每个面拥有独立的 uv 区域，涂鸦只落在被涂的那一面，
   不会因为 6 个面共用 0..1 的 uv 而“一份涂鸦六面都出现”。
   行列数相同 → 每格在画布上是正方形，笔刷不会被拉成椭圆。 */
export const FACE_ATLAS = { cols: 3, rows: 3 };

/** 面序号（= BoxGeometry 分组顺序 px,nx,py,ny,pz,nz）+ 面内 uv → 图集 uv */
export function faceAtlasUV(face, u, v) {
  const f = (((face | 0) % 6) + 6) % 6;
  const col = f % FACE_ATLAS.cols;
  const row = Math.floor(f / FACE_ATLAS.cols);
  return [
    (col + clamp(u, 0, 1)) / FACE_ATLAS.cols,
    (row + clamp(v, 0, 1)) / FACE_ATLAS.rows,
  ];
}

/** 把 BoxGeometry 的 uv 重映射到面图集（每个面的 0..1 落到自己的格子里） */
export function remapBoxAtlasUV(geo) {
  const uv = geo.attributes && geo.attributes.uv;
  const index = geo.index;
  if (!uv || !index || !geo.groups || !geo.groups.length) return geo;
  const seen = new Set();
  geo.groups.forEach((g, f) => {
    const end = g.start + g.count;
    for (let i = g.start; i < end; i++) {
      const vi = index.getX(i);
      if (seen.has(vi)) continue;
      seen.add(vi);
      const p = faceAtlasUV(f, uv.getX(vi), uv.getY(vi));
      uv.setXY(vi, p[0], p[1]);
    }
  });
  uv.needsUpdate = true;
  geo.userData.atlas = true;
  return geo;
}

/** 立方体几何：seg 为每个面的细分数（顶点 AO 需要足够密的顶点才有渐变） */
export function buildBoxGeometry(seg = 1, atlas = false) {
  const s = clamp(Math.round(seg) || 1, 1, 16);
  return cacheGeo((atlas ? 'boxAtlas' : 'box') + s, () => {
    const g = new THREE.BoxGeometry(1, 1, 1, s, s, s);
    return atlas ? remapBoxAtlasUV(g) : g;
  });
}

/* ---------- 贴图填充模式：拉伸 / 平铺不拉伸 / 九宫格 ----------
   立方体逐面换算 uv：平铺时每格都是正方格（贴图不被拉扁），
   九宫格时贴图外圈嵌在四角，四边与中间等宽平铺（整图等比缩放，无忽宽忽窄 / 接缝）。
   平铺：每格的世界边长 = “贴图尺寸”(stud)，与物体 / 面的尺寸无关——
        因此任意物体、任意面上的图案比例完全一致（不会出现大小不同的
        物体上贴图疏密不一）。
   九宫格：边框厚度 ≈ “贴图尺寸”(stud)（取整后整图等比缩放，故略有出入）。 */
export const FILL_MODES = ['stretch', 'tile', 'nine'];
const NINE_INSET = 1 / 3;                     // 九宫格：贴图外圈占比
const NINE_MAX_TILES = 128;                   // 九宫格：单轴最多切分格数（防几何爆炸）
const TILE_STUD_BASE = 1;                     // “贴图尺寸”默认值(stud)
const TEX_STUD_MIN = 0.05;                    // “贴图尺寸”下限(stud)
const TEX_STUD_MAX = 64;                      // “贴图尺寸”上限(stud)

/** “贴图尺寸”(stud) → 合法数值（即每格边长 / 九宫格边框厚度，单位 stud） */
function texSizeStud(size) {
  const n = Number(size);
  return clamp(isFinite(n) && n > 0 ? n : TILE_STUD_BASE, TEX_STUD_MIN, TEX_STUD_MAX);
}

function faceSizes(size) {
  return (size || [1, 1, 1]).map((v) => Math.max(0.001, Math.abs(Number(v) || 1)));
}

/** 填充几何的缓存键：拉伸与尺寸无关（'stretch'），其余按尺寸 / 贴图尺寸 / 细分区分 */
export function boxFillKey(size, seg, fill, texSize) {
  if (fill !== 'tile' && fill !== 'nine') return 'stretch';
  const s = clamp(Math.round(seg) || 1, 1, 16);
  const r = texSizeStud(texSize);
  return [fill, s, r, faceSizes(size).map((v) => v.toFixed(3)).join(',')].join('|');
}

/** 平铺不拉伸：把每个面的 0..1 uv 按“正方格”换算（RepeatWrapping 负责重复）
    每格的世界边长 = 贴图尺寸(stud)，与面尺寸无关，故各面 / 各物体的图案比例一致 */
function remapBoxTileUV(geo, size, texSize) {
  const uv = geo.attributes && geo.attributes.uv;
  const index = geo.index;
  if (!uv || !index || !geo.groups || !geo.groups.length) return geo;
  const S = faceSizes(size);
  // 面序号（px,nx,py,ny,pz,nz）→ 该面 u / v 轴上的世界尺寸（与 BoxGeometry 的 uv 轴一致）
  const dims = [
    [S[2], S[1]], [S[2], S[1]],
    [S[0], S[2]], [S[0], S[2]],
    [S[0], S[1]], [S[0], S[1]],
  ];
  const tile = texSizeStud(texSize);
  const seen = new Set();
  geo.groups.forEach((g, f) => {
    const [W, H] = dims[((f % 6) + 6) % 6];
    const ru = W / tile, rv = H / tile;
    const end = g.start + g.count;
    for (let i = g.start; i < end; i++) {
      const vi = index.getX(i);
      if (seen.has(vi)) continue;
      seen.add(vi);
      uv.setXY(vi, uv.getX(vi) * ru, uv.getY(vi) * rv);
    }
  });
  uv.needsUpdate = true;
  return geo;
}

/** 九宫格：单轴切分——起边框 / 中间若干「整格」平铺 / 末边框。
    ratio = 面长 / 贴图尺寸(stud)，表示这个面按贴图 1/3 为单位应放下多少格。
    取整后所有格（含两侧边框）宽度完全一致 —— 整张贴图被「等比缩放」到面上，
    因此格与格交界处既不会忽宽忽窄、也不会出现相位错位的接缝。
    返回的 u0/u1 是该格在贴图上的坐标（此轴未翻转，另一轴使用时取 1-u 翻面）。 */
function nineAxisCells(ratio) {
  const INS = NINE_INSET;
  // 总格数 = 两侧边框 + 中间平铺格；至少 3 格，且设上限防止超大物体 / 极小贴图几何爆炸
  const tot = clamp(Math.round(ratio) || 3, 3, NINE_MAX_TILES + 2);
  const w = 1 / tot;
  const cells = [{ p0: -0.5, p1: -0.5 + w, u0: 0, u1: INS }];        // 起边框（嵌住贴图外圈）
  for (let k = 1; k < tot - 1; k++) {                               // 中间：等宽平铺
    const p0 = -0.5 + k * w;
    cells.push({ p0, p1: p0 + w, u0: INS, u1: 1 - INS });
  }
  cells.push({ p0: 0.5 - w, p1: 0.5, u0: 1 - INS, u1: 1 });          // 末边框（嵌住贴图外圈）
  return cells;
}

/** 九宫格盒体：6 个面各切 3×3，四角 / 四边嵌住贴图外圈，四边与中间按格平铺 */
function buildNineBoxGeometry(size, texSize) {
  const S = faceSizes(size);
  const pos = [], nor = [], uv = [], idx = [];
  // [u 轴, v 轴, w 轴, udir, vdir, u 尺寸, v 尺寸, w 方向]（与 BoxGeometry 的面顺序一致）
  const faces = [
    [2, 1, 0, -1, -1, S[2], S[1], 1],
    [2, 1, 0, 1, -1, S[2], S[1], -1],
    [0, 2, 1, 1, 1, S[0], S[2], 1],
    [0, 2, 1, 1, -1, S[0], S[2], -1],
    [0, 1, 2, 1, -1, S[0], S[1], 1],
    [0, 1, 2, -1, -1, S[0], S[1], -1],
  ];
  for (const [ui, vi, wi, udir, vdir, W, H, wdir] of faces) {
    const tile = texSizeStud(texSize);
    const uCells = nineAxisCells(W / tile);
    const vCells = nineAxisCells(H / tile);
    for (const vc of vCells) {
      // v 轴在贴图上翻面（世界 v 越大 → 贴图 v 越小），与旧实现的 tv 一致
      const v0 = 1 - vc.u0, v1 = 1 - vc.u1;
      for (const uc of uCells) {
        const base = pos.length / 3;
        // 顶点顺序（与旧实现一致，保持正面朝向）：b(ix,iy) a(ix+1,iy) c(ix,iy+1) d(ix+1,iy+1)
        const quad = [
          [uc.p0, vc.p0, uc.u0, v0],
          [uc.p1, vc.p0, uc.u1, v0],
          [uc.p0, vc.p1, uc.u0, v1],
          [uc.p1, vc.p1, uc.u1, v1],
        ];
        for (const [gu, gv, uu, vv] of quad) {
          const p = [0, 0, 0], n = [0, 0, 0];
          p[ui] = gu * udir;
          p[vi] = gv * vdir;
          p[wi] = wdir * 0.5;
          n[wi] = wdir;
          pos.push(p[0], p[1], p[2]);
          nor.push(n[0], n[1], n[2]);
          uv.push(uu, vv);
        }
        idx.push(base + 1, base + 0, base + 3, base + 0, base + 2, base + 3);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * 立方体几何（含填充模式）。返回独享几何，调用方负责 dispose。
 * atlas（涂鸦面图集）优先：涂鸦必须每个面独立 uv，此时忽略填充模式。
 */
export function buildBoxFillGeometry(size, seg, fill, texSize, atlas = false) {
  const s = clamp(Math.round(seg) || 1, 1, 16);
  if (atlas || boxFillKey(size, s, fill, texSize) === 'stretch') return buildBoxGeometry(s, atlas).clone();
  const S = faceSizes(size);
  const mode = fill === 'nine' ? 'nine' : 'tile';
  const base = cacheGeo('boxfill|' + boxFillKey(size, s, fill, texSize), () => (mode === 'tile'
    ? remapBoxTileUV(new THREE.BoxGeometry(1, 1, 1, s, s, s), S, texSize)
    : buildNineBoxGeometry(S, texSize)));
  return base.clone();
}

export function buildGeometry(shape, sides = 6) {
  switch (shape) {
    case 'block': return buildBoxGeometry(1);
    case 'plane': return cacheGeo('plane', () => new THREE.PlaneGeometry(1, 1));
    case 'sphere': return cacheGeo('sph', () => new THREE.IcosahedronGeometry(0.5, 3));
    case 'cylinder': return cacheGeo('cyl', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 26, 1));
    case 'cone': return cacheGeo('cone', () => new THREE.CylinderGeometry(0.001, 0.5, 1, 26, 1));
    case 'prism': {
      const n = clamp(Math.round(sides) || 6, 3, 32);
      return cacheGeo('prism' + n, () => new THREE.CylinderGeometry(0.5, 0.5, 1, n, 1));
    }
    case 'torus': return cacheGeo('torus', () => new THREE.TorusGeometry(0.35, 0.15, 14, 30));
    case 'wedge': return cacheGeo('wedge', () => makeWedge());
    default: return cacheGeo('box', () => new THREE.BoxGeometry(1, 1, 1));
  }
}

/** 楔形（直角三角柱）：底面 1×1，高 1，斜面朝 +Z 上方 */
function makeWedge() {
  const g = new THREE.BufferGeometry();
  const v = [
    // 前面 (z=+0.5) 三角形
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
    // 后面 (z=-0.5)
    0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5,
    // 底面
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5,
    -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
    // 背面(竖面 z=+? -> x=-0.5 竖面)
    -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5,
    -0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5,
    // 斜面
    0.5, -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5,
    0.5, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5, -0.5, 0.5,
  ];
  const uv = [];
  for (let i = 0; i < v.length / 3; i++) uv.push((v[i * 3] + 0.5), (v[i * 3 + 1] + 0.5));
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function mergeGeos(list) {
  let posCount = 0, idxCount = 0;
  for (const g of list) { posCount += g.attributes.position.count; idxCount += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(posCount * 3);
  const nor = new Float32Array(posCount * 3);
  const uv = new Float32Array(posCount * 2);
  const idx = new Uint32Array(idxCount);
  let po = 0, io = 0, base = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    pos.set(p.array, po * 3);
    if (n) nor.set(n.array, po * 3);
    if (u) uv.set(u.array, po * 2);
    const cnt = p.count;
    if (g.index) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[io++] = a[i] + base;
    } else {
      for (let i = 0; i < cnt; i++) idx[io++] = i + base;
    }
    po += cnt; base += cnt;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
export { mergeGeos };

/* ============================================================
   类型定义
   ============================================================ */

/** 网格类对象的碰撞体形状推导（供 mesh / climb 等共用） */
export function meshPhysicsShape(p) {
  if (p.shape === 'sphere') return 'sphere';
  if (p.shape === 'prism' || p.shape === 'cylinder' || p.shape === 'cone') return 'cylinder';
  if (p.shape === 'model') return p.physicsMode === 'none' ? 'none' : p.physicsMode === 'mesh' ? 'trimesh' : 'box';
  return p.physicsMode === 'none' ? 'none' : p.physicsMode === 'mesh' ? 'trimesh' : 'box';
}

/** 攀爬墙碰撞体：玩家要「碰到墙」才能攀爬，所以永远有碰撞体（忽略旧档里的“无碰撞”） */
export function climbPhysicsShape(p) {
  if (p.physicsMode === 'mesh') return 'trimesh';
  if (p.shape === 'sphere') return 'sphere';
  if (p.shape === 'prism' || p.shape === 'cylinder' || p.shape === 'cone') return 'cylinder';
  return 'box';
}

/** 生成式物理（管道 / 网格修改器）：碰撞体落在「生成出来的网格」上，而不是对象包围盒 */
export function generatedPhysicsShape(p) {
  return p.physicsMode === 'mesh' ? 'trimesh' : p.physicsMode === 'box' ? 'box' : 'none';
}

/** 生成式物理的碰撞体选项（管道 / 网格修改器共用） */
const GENERATED_PHYSICS_OPTIONS = [
  { v: 'none', l: '无碰撞' },
  { v: 'mesh', l: '网格(精确/慢)' },
  { v: 'box', l: '包围盒(快)' },
];

/* ---------- 传送门默认轮廓 / 图层 ---------- */
const PORTAL_DEFAULT_POINTS = () => portalPresetShape('roundRect', { cornerRadius: 0.18 });
const PORTAL_DEFAULT_LAYERS = () => ([
  { tex: 'noise', offsetX: 0, offsetY: 0, scale: 1.4, depth: 0.1, opacity: 1, blend: 'normal', tint: '#8fb9ff', tile: true, tileMode: 'repeat' },
  { tex: 'cloud', offsetX: 0.1, offsetY: -0.05, scale: 0.7, depth: 0.2, opacity: 0.7, blend: 'screen', tint: '#ffffff', tile: true, tileMode: 'repeat' },
]);

/* ---------- 矢量挤出体的默认图形（圆角方块，保证新建出来就能看见、能编辑） ---------- */
function defaultVecDoc() {
  const r = 0.18, h = 0.5, e = h - r, k = r * 0.5522847498;
  const layer = newLayer('图形');
  layer.paths.push(newPath([
    { x: e, y: h, ix: e + k, iy: h },
    { x: -e, y: h, ox: -e - k, oy: h },
    { x: -h, y: e, ix: -h, iy: e + k },
    { x: -h, y: -e, ox: -h, oy: -e - k },
    { x: -e, y: -h, ix: -e - k, iy: -h },
    { x: e, y: -h, ox: e + k, oy: -h },
    { x: h, y: -e, ix: h, iy: -e - k },
    { x: h, y: e, ox: h, oy: e + k },
  ], { closed: true }));
  return { layers: [layer] };
}

export const OBJECT_TYPES = {

  /* ---------- 网格模型 ---------- */
  mesh: {
    label: '网格模型', icon: '▦', cat: 'mesh', color: '#d9d2ee',
    defaults: {},
    props: MESH_PROPS_ADV,
    solid: true,
    physicsShape: meshPhysicsShape,
  },

  /* ---------- 低模建模体（编辑器内建模：点 / 边 / 面 + 倒角 + 雕刻） ----------
     几何存在 verts / faces 两个隐藏属性里（vec3list，便于撤销快照与存档序列化），
     实际编辑在「建模模式」里做，属性面板只保留外观 / 物理那些通用项。 */
  poly: {
    label: '低模建模体', icon: '✧', cat: 'mesh', color: '#a8e6ff',
    defaults: {},
    props: [
      A.name(),
      A.position(), A.rotation(), A.scale([4, 1, 4]),
      A.color('#a8e6ff'), A.smartMod(), A.transparency(), A.metalness(0.05), A.roughness(0.72),
      A.advMat(), A.reflectivity(), A.fxScale(), A.fxAmp(), A.fxColor(),
      A.ior(), A.glassAbsorb(),
      A.texture(), A.textureFill(), A.textureSize(), A.roughnessMap(), A.normalMap(), A.flatShading(false),
      A.emissive(), A.emissiveIntensity(),
      A.castShadow(), A.visible(), A.frozen(),
      A.anchored(), A.mass(), A.material(),
      { k: 'physicsMode', l: '碰撞体', t: 'select', d: 'box', g: GROUPS.phys,
        o: [{ v: 'box', l: '包围盒(快)' }, { v: 'mesh', l: '网格(精确/慢)' }, { v: 'none', l: '无碰撞' }],
        h: '「网格」按建模结果的三角网做精确碰撞；改这里会重建碰撞体' },
      { k: 'verts', l: '顶点表', t: 'vec3list', d: BOX_TEMPLATE.verts, g: GROUPS.adv, hide: true,
        h: '建模数据（点表）：请在「建模模式」里编辑' },
      { k: 'faces', l: '三角面表', t: 'vec3list', d: BOX_TEMPLATE.faces, g: GROUPS.adv, hide: true,
        h: '建模数据（面表）：每项是 [i, j, k] 三个顶点下标' },
    ],
    solid: true,
    physicsShape: meshPhysicsShape,
  },

  /* ---------- 矢量挤出体（SVG / 矢量图编辑器 → 有厚度的实体） ----------
     图形数据存在 vecShape（矢量图文档：图层 + 贝塞尔路径，可含多个不相交子路径），
     几何在 builder 里按「厚度 + 边缘倒角」现算；支持曲线边缘倒角与倒角沿轮廓调制。 */
  vec: {
    label: '矢量挤出体', icon: '⬟', cat: 'mesh', color: '#bfe9ff',
    defaults: {},
    props: [
      A.name(),
      A.position(), A.rotation(), A.scale([4, 4, 4]),
      { k: 'vecShape', l: '矢量图形', t: 'vecdoc', d: null, g: GROUPS.base, hide: true,
        h: '在「矢量图编辑器」里绘制，或导入 SVG' },
      { k: 'editShape', l: '矢量图编辑器', t: 'action', btn: '✏ 打开矢量图编辑器…', g: GROUPS.base,
        h: '绘制 / 编辑这个挤出体的平面图形（贝塞尔曲线 / 多轮廓 / 布尔运算 / 折角倒角），应用后写回本对象',
        run: (o, ed) => { if (ed && ed.openVectorEditor) ed.openVectorEditor({ target: 'vec', obj: o }); return null; } },
      { k: 'depth', l: '厚度', t: 'num', d: 0.25, min: 0.01, max: 4, st: 0.01, g: GROUPS.base,
        h: '单位空间厚度（相对图形最长边）：世界厚度 = 厚度 × 尺寸 Z' },
      { k: 'bevelSize', l: '边缘倒角', t: 'num', d: 0.03, min: 0, max: 0.5, st: 0.005, g: GROUPS.base,
        h: '沿轮廓（含曲线边缘）的倒角宽度，会自动限制在图形能承受的范围内' },
      { k: 'bevelProfile', l: '倒角剖面', t: 'select', d: 'round', g: GROUPS.base,
        o: [{ v: 'round', l: '圆角' }, { v: 'chamfer', l: '斜切' }, { v: 'pow', l: '幂曲线' }] },
      { k: 'bevelSegments', l: '倒角分段', t: 'int', d: 3, min: 1, max: 16, st: 1, g: GROUPS.base,
        h: '圆角 / 幂曲线的细分段数，越大越顺滑' },
      { k: 'modMode', l: '倒角调制', t: 'select', d: 'none', g: GROUPS.base,
        o: [{ v: 'none', l: '无' }, { v: 'wave', l: '正弦波' }],
        h: '让倒角宽度沿轮廓做周期性变化' },
      { k: 'modAmp', l: '调制幅度', t: 'num', d: 0.5, min: 0, max: 1, st: 0.05, g: GROUPS.base },
      { k: 'modFreq', l: '调制频率', t: 'num', d: 3, min: 0.25, max: 32, st: 0.25, g: GROUPS.base },
      { k: 'modPhase', l: '调制相位', t: 'num', d: 0, min: 0, max: 6.2832, st: 0.1, g: GROUPS.base },
      A.color('#bfe9ff'), A.smartMod(), A.transparency(), A.metalness(0.05), A.roughness(0.72),
      A.advMat(), A.reflectivity(), A.fxScale(), A.fxAmp(), A.fxColor(),
      A.ior(), A.glassAbsorb(),
      A.texture(), A.textureFill(), A.textureSize(), A.roughnessMap(), A.normalMap(), A.flatShading(false),
      A.emissive(), A.emissiveIntensity(),
      A.castShadow(), A.visible(), A.frozen(),
      A.anchored(), A.mass(), A.material(),
      { k: 'physicsMode', l: '碰撞体', t: 'select', d: 'mesh', g: GROUPS.phys,
        o: [{ v: 'mesh', l: '网格(精确/慢)' }, { v: 'none', l: '无碰撞' }],
        h: '按挤出结果的三角网做精确碰撞（形状不是方块，包围盒会严重失真）' },
    ],
    solid: true,
    physicsShape: vecPhysicsShape,
  },

  /* ---------- 液体 ---------- */
  liquid: {
    label: '液体', icon: '≈', cat: 'liquid', color: '#4fa8ff',
    defaults: {},
    props: [
      ...LIQUID_MESH_PROPS,
      { k: 'kind', l: '液体种类', t: 'select', d: 'water', g: GROUPS.liquid,
        o: Object.entries(LIQUID_KINDS).map(([v, x]) => ({ v, l: x.label })) },
      { k: 'oxygenMode', l: '氧气模式', t: 'select', d: 'drain', g: GROUPS.liquid,
        o: [{ v: 'drain', l: '持续扣氧气' }, { v: 'none', l: '不扣氧气' }, { v: 'refill', l: '补充氧气' }],
        h: '自由决定液体对氧气的影响方式' },
      { k: 'drainRate', l: '氧气消耗/秒', t: 'num', d: 8, min: 0, max: 200, st: 0.5, g: GROUPS.liquid },
      { k: 'instantKill', l: '接触即死', t: 'bool', d: false, g: GROUPS.liquid, h: '熔岩默认开启' },
      { k: 'headOnly', l: '淹过头才生效', t: 'bool', d: true, g: GROUPS.liquid,
        h: '开启后只有液面高于玩家头部时才判定' },
      { k: 'swim', l: '立体游泳', t: 'bool', d: true, g: GROUPS.liquid, h: '关闭后玩家在水中会下沉' },
      { k: 'waterResist', l: '水阻(比例)', t: 'num', d: 0.15, min: 0, max: 1, st: 0.01, g: GROUPS.liquid,
        h: '适用于任何触碰：受阻后速度 = 基础速度 × (1 − 水阻 × 淹没比例)；淹没 0% 无阻力，100% 时速度乘以 (1 − 水阻)' },
      { k: 'fillLevel', l: '液面高度(相对顶面)', t: 'num', d: 1, min: 0, max: 1, st: 0.01, g: GROUPS.liquid,
        h: '1 = 满，0 = 空；可用动画/事件动态改变' },
      { k: 'flow', l: '流动感', t: 'num', d: 0.35, min: 0, max: 2, st: 0.05, g: GROUPS.liquid },
      { k: 'damage', l: '接触伤害/秒', t: 'num', d: 0, min: 0, max: 200, st: 1, g: GROUPS.liquid },
      /* --- 围边泡沫 edgefoam --- */
      { k: 'edgeFoam', l: '围边泡沫 edgefoam', t: 'bool', d: true, g: GROUPS.liquid,
        h: '水下岛屿与水面相交处的一圈白边 + 水面外沿泡沫（贴合任意形状的水体）' },
      { k: 'foamColor', l: '泡沫颜色', t: 'color', d: '#ffffff', g: GROUPS.liquid },
      { k: 'foamWidth', l: '泡沫宽度(stud)', t: 'num', d: 4.5, min: 0.4, max: 10000, st: 0.5, g: GROUPS.liquid },
      { k: 'foamOpacity', l: '泡沫不透明度', t: 'num', d: 0.85, min: 0, max: 1, st: 0.05, g: GROUPS.liquid },
      A.lightInfluence(GROUPS.liquid),
      /* --- 水纹风格预设（30 种液体风格 + 20 种独立图案，可多层叠加） --- */
      { k: 'usePresetLook', l: '使用预制外观', t: 'bool', d: true, g: GROUPS.liquid,
        h: '开启：切换「水纹风格」会同时套用预设的颜色 / 透明度 / 自发光 / 泡沫等外观；' +
          '关闭：只切换水纹图案，液体自身属性保持不变' },
      { k: 'liquidStyle', l: '水纹风格', t: 'select', d: 'water', g: GROUPS.liquid,
        o: liquidStyleOptions(),
        h: '30 种液体风格（颜色 + 水纹外观）：清水 / 酸 / 熔岩 / 可乐 / 梦核 / 怪核 / 星河 …；' +
          '末尾 20 项「图案·xxx」是纯图案，选中只单独加载该水纹图案，液体自身外观不变' },
      { k: 'rippleLayers', l: '叠加层数', t: 'int', d: 0, min: 0, max: 4, st: 1, g: GROUPS.liquid,
        h: '0 = 用风格预设的全部层；1~6 = 只取前 N 层（多种水纹可叠加）' },
      { k: 'rippleScale', l: '水纹密度', t: 'num', d: 1, min: 0.1, max: 10, st: 0.1, g: GROUPS.liquid },
      { k: 'rippleSpeed', l: '水纹速度', t: 'num', d: 1, min: 0, max: 20, st: 0.05, g: GROUPS.liquid },
      { k: 'rippleStrength', l: '水纹强度', t: 'num', d: 1, min: 0, max: 10, st: 0.05, g: GROUPS.liquid },
      { k: 'warpSpeed', l: '扭曲速度', t: 'num', d: 1, min: 0, max: 5, st: 0.05, g: GROUPS.liquid,
        h: '扭曲位移场的流动速度（标准值倍数）：1 = 水纹速度的 0.618 倍' },
      { k: 'warpScale', l: '扭曲场大小', t: 'num', d: 1, min: 0.1, max: 5, st: 0.05, g: GROUPS.liquid,
        h: '扭曲位移场的空间尺度（标准值倍数）：1 = 标准，>1 场更大更缓，<1 更细更密。' +
          '扭曲强度恒为「水纹速度」的 0.1 倍，无需单独设置' },
      { k: 'rippleTint', l: '水纹颜色', t: 'color', d: '', g: GROUPS.liquid,
        h: '水纹高光的染色，空 / 未设置时跟随当前水纹风格预设' },
      /* --- 深水变暗（深度吸收：只影响颜色，锁定液面色相，仅调饱和度 / 亮度） --- */
      { k: 'depthDarken', l: '越深越暗', t: 'bool', d: true, g: GROUPS.liquid,
        h: '不在水里时从外面看：水越深越厚的地方越暗' },
      { k: 'depthAbsorb', l: '深度吸收密度', t: 'num', d: 0.5, min: 0, max: 1, st: 0.02, g: GROUPS.liquid,
        h: '越大：越浅的地方就开始变暗（吸收越快）' },
      { k: 'depthLight', l: '深处亮度', t: 'num', d: 0.4, min: 0, max: 1, st: 0.02, g: GROUPS.liquid,
        h: '最深处保留的亮度倍率：0 = 全黑，1 = 不变亮。色相始终跟随液面色，不会偏色发脏' },
      { k: 'depthSat', l: '深处饱和度', t: 'num', d: 1, min: 0, max: 2, st: 0.05, g: GROUPS.liquid,
        h: '最深处保留的饱和度倍率：0 = 完全去饱和（灰），1 = 不变，>1 = 更深更艳' },
      { k: 'visibilityDepth', l: '能见深度', t: 'num', d: 0, min: 0, max: 500, st: 1, g: GROUPS.liquid,
        h: '水面往下能看多深(stud)：水里的物体超过该深度就完全看不见，像雾一样逐渐没入浑浊色（0 = 清澈见底）' },
      { k: 'platformDepth', l: '平台过渡深度', t: 'num', d: 4, min: 0, max: 100, st: 0.5, g: GROUPS.liquid,
        h: '水面离水底平台多深时水才达到满不透明度(stud)：更浅的地方只有满不透明度的 10%（越浅越通透），' +
          '达到该深度即完全不透明。水沫透明度不受影响（0 = 关闭）' },
      { k: 'turbidityFollow', l: '浑浊色跟随液体颜色', t: 'bool', d: true, g: GROUPS.liquid,
        h: '开启：浑浊色 = 液体自身颜色；关闭：使用下面的「浑浊颜色」' },
      { k: 'turbidityColor', l: '浑浊颜色', t: 'color', d: '#2f8fd8', g: GROUPS.liquid,
        h: '仅当关闭「浑浊色跟随液体颜色」时生效' },
      REF_TOUCH(), REF_ENTER(), REF_EXIT(),
    ],
    solid: false, liquid: true,
    physicsShape: () => 'none',
  },

  /* ---------- 伤害区域 ---------- */
  damage: {
    label: '伤害区域', icon: '☠', cat: 'logic', color: '#ff6b8a',
    defaults: {},
    props: [
      ...MESH_PROPS,
      { k: 'damage', l: '伤害/次', t: 'num', d: 20, min: 0, max: 999, st: 1, g: GROUPS.behave,
        h: '每次结算扣掉的血量' },
      { k: 'tickRate', l: '结算频率(次/秒)', t: 'num', d: 2, min: 0, max: 60, st: 0.5, g: GROUPS.behave,
        h: '每秒结算多少次（防抖：避免逐帧扣血导致音效/镜头抖动）。平均伤害/秒 = 伤害/次 × 本次数；0 = 不结算' },
      { k: 'instantKill', l: '秒杀', t: 'bool', d: false, g: GROUPS.behave },
      { k: 'knockback', l: '击退力', t: 'num', d: 0, min: 0, max: 200, st: 1, g: GROUPS.behave,
        h: '从区域中心向外推玩家的力度' },
      REF_ENTER(), REF_EXIT(),
    ],
    solid: false, hazard: true,
    physicsShape: () => 'none',
  },

  /* ---------- 事件触发器 ---------- */
  trigger: {
    label: '事件触发器', icon: '⚡', cat: 'logic', color: '#ffd98a',
    defaults: {},
    props: [
      ...MESH_PROPS,
      { k: 'target', l: '被检测对象', t: 'select', d: 'player', g: GROUPS.behave,
        o: [{ v: 'player', l: '玩家' }, { v: 'any', l: '任意未锚定物体' }, { v: 'specific', l: '指定对象' }] },
      { k: 'targetId', l: '指定对象ID', t: 'ref', d: '', g: GROUPS.behave, h: '仅“指定对象”模式有效' },
      { k: 'once', l: '仅触发一次', t: 'bool', d: false, g: GROUPS.behave },
      { k: 'delay', l: '延迟(秒)', t: 'num', d: 0, min: 0, max: 60, st: 0.1, g: GROUPS.behave },
      { k: 'cooldown', l: '冷却(秒)', t: 'num', d: 0, min: 0, max: 60, st: 0.1, g: GROUPS.behave },
      REF_ENTER(), REF_EXIT(),
    ],
    solid: false, trigger: true,
    physicsShape: () => 'none',
  },

  /* ---------- NPC（角色） ----------
     一个完整的可交互角色：外观（内置 R6 预设 / 导入模型）、行为（待命 / 跟随玩家轨迹 /
     沿路径巡逻）、交互（靠近提示 + 按键或自动触发）、对话（多段台词，由「NPC 编辑器」维护）。
     行为与对话只在游戏运行时生效；编辑器里 NPC 为静态展示，数据全部随关卡序列化。 */
  npc: {
    label: 'NPC', icon: '🧍', cat: 'npc', color: '#9fe8ff',
    defaults: {},
    props: [
      A.name(),
      A.position(), A.rotation(), A.scale([1, 1, 1]),
      /* --- 外观 --- */
      { k: 'preset', l: '外观预设', t: 'select', d: 'classic', g: GROUPS.look, o: NPC_PRESET_OPTIONS,
        h: '内置 R6 风格角色；选「自定义模型」时改用下面的「模型资源」（.glb/.gltf/.obj）' },
      { k: 'bodyColor', l: '衣服颜色', t: 'color', d: '#4f6bd8', g: GROUPS.look,
        h: '覆盖躯干颜色；头部 / 四肢沿用预设配色' },
      A.assetId(),
      A.castShadow(), A.visible(), A.frozen(),
      /* --- 行为 --- */
      { k: 'behavior', l: '行为模式', t: 'select', d: 'idle', g: GROUPS.npc,
        o: [
          { v: 'idle', l: '原地待命' },
          { v: 'follow', l: '跟随玩家' },
          { v: 'patrol', l: '沿路径巡逻' },
        ],
        h: '跟随 = 沿玩家走过的轨迹保持距离地跟上；巡逻 = 在下面的路径点之间来回移动' },
      { k: 'speed', l: '移动速度(stud/s)', t: 'num', d: 6, min: 0.5, max: 40, st: 0.5, g: GROUPS.npc },
      { k: 'followDist', l: '保持距离(stud)', t: 'num', d: 7, min: 1, max: 80, st: 0.5, g: GROUPS.npc,
        h: '跟随玩家时保持的最小距离：玩家走近到该距离内 NPC 停下，走远后沿其轨迹跟上' },
      { k: 'followRun', l: '跑动追赶距离(stud)', t: 'num', d: 18, min: 1, max: 200, st: 1, g: GROUPS.npc,
        h: '与玩家的距离超过该值时加速追赶（动画切到跑动）' },
      { k: 'facePlayer', l: '停下时面向玩家', t: 'bool', d: true, g: GROUPS.npc },
      { k: 'waypoints', l: '巡逻路径点', t: 'vec3list', d: [[0, 0, 0], [0, 0, 12]], g: GROUPS.npc,
        h: '仅「沿路径巡逻」有效：世界坐标下的路径点，NPC 依次经过；Y 为高度' },
      { k: 'patrolLoop', l: '巡逻循环', t: 'bool', d: true, g: GROUPS.npc,
        h: '开启 = 到终点后返回起点循环；关闭 = 到终点停下' },
      /* --- 交互 --- */
      { k: 'interactRange', l: '交互半径(stud)', t: 'num', d: 8, min: 1, max: 60, st: 0.5, g: GROUPS.behave,
        h: '玩家进入该范围内会出现交互提示（可按键对话）' },
      { k: 'interactKey', l: '交互按键', t: 'select', d: 'Mouse0', g: GROUPS.behave,
        o: [
          { v: 'Mouse0', l: '鼠标左键' }, { v: 'KeyE', l: 'E' }, { v: 'KeyF', l: 'F' },
          { v: 'KeyQ', l: 'Q' }, { v: 'KeyR', l: 'R' }, { v: 'Enter', l: '回车' },
        ] },
      { k: 'promptText', l: '交互提示文字', t: 'text', d: '交谈', g: GROUPS.behave },
      { k: 'autoTalk', l: '靠近自动对话', t: 'bool', d: false, g: GROUPS.behave,
        h: '开启后玩家进入交互半径自动开始对话，无需按键' },
      { k: 'talkRepeat', l: '可重复对话', t: 'bool', d: true, g: GROUPS.behave,
        h: '关闭后该 NPC 只对话一次，之后不再触发' },
      /* --- 对话（由 NPC 编辑器维护，属性面板隐藏） --- */
      { k: 'speakerName', l: '对话显示名', t: 'text', d: '', g: GROUPS.dialog, hide: true,
        h: '留空则使用 NPC 名称' },
      { k: 'dialogue', l: '对话图', t: 'dlg', d: { entry: '', nodes: [] }, g: GROUPS.dialog, hide: true,
        h: '由「NPC 编辑器」以节点图方式编辑：每个节点是一句台词，可连出下一句或若干「分支选项」' },
      { k: 'onTalk', l: '对话触发事件', t: 'ref', d: '', g: GROUPS.event,
        h: '每次开始与玩家对话时触发该事件（可用来开门 / 给道具 / 播放音效等）' },
    ],
    solid: false,
    physicsShape: () => 'none',
  },

  /* ---------- 粒子发射器 ---------- */
  emitter: {
    label: '粒子发射器', icon: '✨', cat: 'fx', color: '#ffd98a',
    defaults: { scale: [6, 6, 6], color: '#ffd98a' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([6, 6, 6]),
      { k: 'emitShape', l: '发射区域', t: 'select', d: 'volume', g: GROUPS.fx,
        o: [{ v: 'volume', l: '体积内随机' }, { v: 'surface', l: '体积表面' }, { v: 'point', l: '中心一点' }],
        h: '有体积但不参与碰撞，可当作特效范围使用' },
      { k: 'particles', l: '粒子条目', t: 'particles', d: [], g: GROUPS.fx,
        h: '打开「粒子编辑器」：每条 = 一张粒子图像（20 种内置或上传导入）+ 一种扭曲/蒙版动画（20 种）+ 权重。' +
          '同一次发射的粒子会按权重从各条目里随机抽取 —— 于是每颗粒子的外观与动画都可以不一样。' +
          '不添加条目时按旧版单张贴图（光晕）发射' },
      { k: 'dirEmit', l: '方向发射', t: 'bool', d: true, g: GROUPS.fx,
        h: '开启后按「发射方向 + 发散度」喷射；关闭则沿用旧版随机四散（老关卡保持原样）' },
      { k: 'emitDir', l: '发射方向', t: 'vec3', d: [0, 1, 0], g: GROUPS.fx, st: 0.1,
        h: '对象局部坐标下的喷射方向（会叠加对象自身的旋转）。默认朝上' },
      { k: 'spread', l: '发散度(度)', t: 'num', d: 30, min: 0, max: 180, st: 1, g: GROUPS.fx,
        h: '0° = 笔直一条线；逐渐张开成圆锥（越大越散）；180° = 向整球均匀喷射' },
      { k: 'rate', l: '发射频率(个/秒)', t: 'num', d: 30, min: 0.1, max: 400, st: 1, g: GROUPS.fx },
      { k: 'life', l: '粒子寿命(秒)', t: 'num', d: 1.6, min: 0.05, max: 20, st: 0.1, g: GROUPS.fx },
      { k: 'size', l: '粒子大小', t: 'num', d: 3, min: 0.1, max: 10000, st: 0.1, g: GROUPS.fx },
      { k: 'speed', l: '初速度', t: 'num', d: 6, min: 0, max: 200, st: 0.5, g: GROUPS.fx },
      { k: 'up', l: '向上比例', t: 'num', d: 0.6, min: -1.5, max: 2, st: 0.05, g: GROUPS.fx, hide: true,
        h: '仅「方向发射」关闭时生效（旧版随机喷射）' },
      { k: 'gravity', l: '重力', t: 'num', d: 20, min: -120, max: 400, st: 1, g: GROUPS.fx,
        h: '负值 = 向上加速（烟雾 / 气泡）' },
      { k: 'rise', l: '上升加速度', t: 'num', d: 0, min: -60, max: 120, st: 0.5, g: GROUPS.fx },
      { k: 'drag', l: '空气阻力', t: 'num', d: 1.6, min: 0, max: 10, st: 0.1, g: GROUPS.fx },
      A.color('#ffd98a'), A.transparency(0.62),
      { k: 'alpha', l: '粒子不透明度', t: 'num', d: 0.9, min: 0, max: 1, st: 0.05, g: GROUPS.look },
      { k: 'soft', l: '柔和粒子(普通混合)', t: 'bool', d: false, g: GROUPS.look,
        h: '关闭 = 叠加发光（火花/光点）；开启 = 普通混合（烟尘/雾团）' },
      A.visible(), A.frozen(),
    ],
    solid: false, emitter: true,
    physicsShape: () => 'none',
  },

  /* ---------- 体积雾 ---------- */
  fogvol: {
    label: '体积雾', icon: '☁', cat: 'fx', color: '#cfd8ff',
    defaults: { scale: [20, 12, 20], color: '#a8b6ea' },
    props: [
      A.name(), A.shape(), A.sides(),
      A.position(), A.rotation(), A.scale([20, 12, 20]),
      { k: 'color', l: '雾颜色', t: 'color', d: '#a8b6ea', g: GROUPS.fx },
      { k: 'density', l: '浓度', t: 'num', d: 0.45, min: 0, max: 1, st: 0.02, g: GROUPS.fx },
      { k: 'noiseScale', l: '雾团密度', t: 'num', d: 1, min: 0.05, max: 6, st: 0.05, g: GROUPS.fx },
      { k: 'noiseSpeed', l: '飘动速度', t: 'num', d: 0.35, min: 0, max: 3, st: 0.05, g: GROUPS.fx },
      { k: 'softness', l: '边缘柔化', t: 'num', d: 0.55, min: 0, max: 1, st: 0.05, g: GROUPS.fx },
      A.lightInfluence(),
      A.visible(), A.frozen(),
    ],
    solid: false, fogvol: true,
    physicsShape: () => 'none',
  },

  /* ---------- 体积光 ---------- */
  volumelight: {
    label: '体积光', icon: '🔆', cat: 'fx', color: '#fff3c4',
    defaults: { shape: 'cone', scale: [10, 40, 10], color: '#ffe9b0' },
    props: [
      A.name(),
      A.shape('cone', [{ v: 'cone', l: '圆锥(光锥)' }, { v: 'cylinder', l: '圆柱' }, { v: 'prism', l: '多边形柱' },
        { v: 'block', l: '立方体' }, { v: 'sphere', l: '球' }]),
      A.sides(),
      A.position(), A.rotation(), A.scale([10, 40, 10]),
      { k: 'color', l: '光束颜色', t: 'color', d: '#ffe9b0', g: GROUPS.light },
      { k: 'intensity', l: '光束强度', t: 'num', d: 0.5, min: 0, max: 3, st: 0.05, g: GROUPS.light },
      { k: 'falloff', l: '边缘柔化', t: 'num', d: 2, min: 0.2, max: 8, st: 0.1, g: GROUPS.light,
        h: '越大光束边缘越柔和' },
      { k: 'fadeEnd', l: '末端渐隐', t: 'num', d: 1, min: 0, max: 1, st: 0.05, g: GROUPS.light,
        h: '1 = 越远越淡；0 = 整条光束亮度一致' },
      { k: 'withLight', l: '附带真实光源', t: 'bool', d: true, g: GROUPS.light },
      { k: 'lightPower', l: '光源强度', t: 'num', d: 1.1, min: 0, max: 40, st: 0.05, g: GROUPS.light },
      { k: 'lightRange', l: '光源距离', t: 'num', d: 120, min: 0, max: 2000, st: 1, g: GROUPS.light },
      A.lightInfluence(GROUPS.light),
      A.visible(), A.frozen(),
    ],
    solid: false, volumelight: true,
    physicsShape: () => 'none',
  },

  /* ---------- 声效方块 ---------- */
  soundblock: {
    label: '声效方块', icon: '🔊', cat: 'fx', color: '#7fe3ff',
    defaults: { scale: [10, 10, 10], color: '#7fe3ff' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([10, 10, 10]),
      { k: 'sound', l: '音频文件', t: 'audio', d: '', g: GROUPS.fx,
        h: '导入 mp3 / ogg / wav / m4a，或用 URL；留空不发声' },
      { k: 'trigger', l: '触发方式', t: 'select', d: 'enter', g: GROUPS.behave,
        o: [{ v: 'enter', l: '进入范围响一次' }, { v: 'inside', l: '范围内循环(3D 环绕)' },
          { v: 'auto', l: '关卡开始自动播放' }, { v: 'click', l: '鼠标点击播放' }],
        h: '“进入范围”可配冷却做循环警报；“范围内循环”会随距离衰减和左右环绕' },
      { k: 'prompt', l: '准星提示文字', t: 'text', d: '按 左键 播放音效', g: GROUPS.behave,
        h: '仅“鼠标点击播放”有效' },
      { k: 'volume', l: '音量', t: 'num', d: 1, min: 0, max: 4, st: 0.05, g: GROUPS.fx },
      { k: 'pitch', l: '音调倍率', t: 'num', d: 1, min: 0.25, max: 3, st: 0.05, g: GROUPS.fx },
      { k: 'loop', l: '循环播放', t: 'bool', d: false, g: GROUPS.fx,
        h: '“进入范围/自动播放”模式下是否循环整曲' },
      { k: 'once', l: '仅触发一次', t: 'bool', d: false, g: GROUPS.behave, h: '仅“进入范围”有效' },
      { k: 'cooldown', l: '冷却(秒)', t: 'num', d: 2, min: 0, max: 120, st: 0.1, g: GROUPS.behave,
        h: '站在范围内时每隔这么久再响一次' },
      { k: 'maxDistance', l: '最大可听距离', t: 'num', d: 160, min: 1, max: 2000, st: 10, g: GROUPS.fx },
      { k: 'refDistance', l: '基准距离(满音量)', t: 'num', d: 12, min: 0.5, max: 400, st: 1, g: GROUPS.fx },
      { k: 'falloff', l: '衰减强度', t: 'num', d: 0.6, min: 0, max: 3, st: 0.05, g: GROUPS.fx },
      A.color('#7fe3ff'), A.transparency(0.25),
      A.castShadow(false), A.visible(), A.frozen(),
      REF_TOUCH(), REF_ENTER(), REF_EXIT(),
    ],
    solid: false, sound: true,
    physicsShape: () => 'none',
  },

  /* ---------- 后处理对象（全屏调色 / 曝光 / 特殊效果） ---------- */
  postfx: {
    label: '后处理对象', icon: '🎞', cat: 'fx', color: '#7fe3ff',
    defaults: { scale: [8, 8, 8], color: '#7fe3ff' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([8, 8, 8]),
      { k: 'preset', l: '调色预设', t: 'select', d: 'neutral', o: POSTFX_PRESET_OPTIONS, g: GROUPS.post,
        h: '预设提供底调，下面的滑块在底调上继续微调；整张关卡只生效「优先级」最高的那一个' },
      { k: 'priority', l: '优先级(大者生效)', t: 'num', d: 0, min: -99, max: 99, st: 1, g: GROUPS.post },
      { k: 'strength', l: '整体强度', t: 'num', d: 1, min: 0, max: 1, st: 0.01, g: GROUPS.post,
        h: '0 = 原画面，1 = 完全套用调色' },
      { k: 'exposure', l: '曝光补偿(EV)', t: 'num', d: 0, min: -2, max: 2, st: 0.05, g: GROUPS.post, tog: true,
        h: '每一项左边的方框是「启用」开关：关掉的项目完全不参与渲染（也就几乎不耗性能），' +
          '默认只开曝光补偿，需要哪项效果再勾上' },
      { k: 'contrast', l: '对比度倍率', t: 'num', d: 1, min: 0, max: 2, st: 0.01, g: GROUPS.post, tog: true },
      { k: 'saturation', l: '饱和度倍率', t: 'num', d: 1, min: 0, max: 2, st: 0.01, g: GROUPS.post, tog: true },
      { k: 'temperature', l: '色温(蓝↔黄)', t: 'num', d: 0, min: -1, max: 1, st: 0.02, g: GROUPS.post, tog: true },
      { k: 'tint', l: '色调(绿↔品红)', t: 'num', d: 0, min: -1, max: 1, st: 0.02, g: GROUPS.post, tog: true },
      { k: 'lift', l: '暗部染色', t: 'color', d: '#000000', g: GROUPS.post, tog: true, h: '黑 = 用预设的' },
      { k: 'gain', l: '高光染色', t: 'color', d: '#ffffff', g: GROUPS.post, tog: true, h: '白 = 用预设的' },
      { k: 'vignette', l: '暗角', t: 'num', d: 0, min: -1, max: 1.5, st: 0.02, g: GROUPS.post, tog: true },
      { k: 'grain', l: '胶片颗粒', t: 'num', d: 0, min: -0.3, max: 0.5, st: 0.01, g: GROUPS.post, tog: true },
      { k: 'chromatic', l: '镜头色散', t: 'num', d: 0, min: -1, max: 3, st: 0.02, g: GROUPS.post, tog: true },
      { k: 'bloom', l: '泛光强度', t: 'num', d: 0, min: -0.5, max: 2, st: 0.02, g: GROUPS.post, tog: true,
        h: '泛光最耗性能：关闭时整条泛光链都不会执行' },
      { k: 'bloomThreshold', l: '泛光阈值', t: 'num', d: 0, min: -0.8, max: 1.5, st: 0.02, g: GROUPS.post, tog: true,
        h: '越低越多亮部参与泛光；需同时启用「泛光强度」才有效' },
      { k: 'sharpen', l: '锐化', t: 'num', d: 0, min: -0.5, max: 1.5, st: 0.02, g: GROUPS.post, tog: true },
      { k: 'levels', l: '色阶(海报化, 0关)', t: 'int', d: 0, min: 0, max: 24, st: 1, g: GROUPS.post, tog: true },
      { k: 'fx', l: '特殊效果覆盖', t: 'select', d: '', o: POSTFX_STYLE_OPTIONS, g: GROUPS.post, tog: true,
        h: '默认跟随预设；也可手动指定扫描线 / 像素化 / 镜像 / 故障 / 热成像…' },
      { k: 'fxAmount', l: '特殊效果强度', t: 'num', d: 0.6, min: 0, max: 1, st: 0.02, g: GROUPS.post, tog: true,
        h: '需同时启用「特殊效果覆盖」才有效' },
      { k: 'fxScale', l: '效果密度', t: 'num', d: 220, min: 4, max: 2000, st: 2, g: GROUPS.post, tog: true,
        h: '需同时启用「特殊效果覆盖」才有效' },
      { k: 'timeScale', l: '效果动画速度', t: 'num', d: 1, min: 0, max: 4, st: 0.05, g: GROUPS.post, tog: true,
        h: '需同时启用「特殊效果覆盖」才有效' },
      A.color('#7fe3ff'), A.transparency(0.18),
      A.visible(), A.frozen(),
    ],
    solid: false, postfx: true,
    physicsShape: () => 'none',
  },

  /* ---------- 画面处理对象（色调映射 / 曝光 / 输出色彩空间） ---------- */
  exposure: {
    label: '画面处理对象', icon: '🔅', cat: 'fx', color: '#ffe8a8',
    defaults: { scale: [8, 8, 8], color: '#ffe8a8' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([8, 8, 8]),
      { k: 'toneMapping', l: '色调映射', t: 'select', d: 'aces', o: TONE_MAPPING_OPTIONS, g: GROUPS.post,
        h: '高光的压缩曲线，在材质着色器末尾生效，不产生额外 pass：ACES 电影感最强（默认），' +
          'AgX 高光更柔和，「不做」= 原样输出、亮部容易死白' },
      { k: 'ev', l: '曝光补偿(EV)', t: 'num', d: 0, min: -3, max: 3, st: 0.05, g: GROUPS.post,
        h: '直接改渲染器的色调映射曝光：没有全屏 pass，几乎没有性能开销。' +
          '每 +1 档亮度翻倍，0 = 关卡原本的亮度' },
      { k: 'colorSpace', l: '输出色彩空间', t: 'select', d: 'srgb', o: COLOR_SPACE_OPTIONS, g: GROUPS.post,
        h: '送显前的最后一步编码：sRGB = 显示屏标准（默认）；线性 = 不做 gamma 编码，' +
          '画面会明显偏暗，一般只做素材用' },
      { k: 'saturation', l: '饱和度倍率', t: 'num', d: 1, min: 0, max: 2, st: 0.01, g: GROUPS.post,
        h: '1 = 不变，0 = 完全去色，越大越浓。逐像素只多几次乘加，没有额外 pass' +
          '（只作用于物体，天空盒不受影响）' },
      { k: 'tint', l: '画面染色(ColorTint)', t: 'color', d: '#ffffff', g: GROUPS.post,
        h: '白 = 不染色；选一个颜色会把整幅画面乘上它，只能压暗其它通道、不会提亮' },
      { k: 'priority', l: '优先级(大者生效)', t: 'num', d: 0, min: -99, max: 99, st: 1, g: GROUPS.post,
        h: '整张关卡只生效优先级最高的那一个画面处理对象' },
      A.color('#ffe8a8'), A.transparency(0.18),
      A.visible(), A.frozen(),
    ],
    solid: false,
    physicsShape: () => 'none',
  },

  /* ---------- 点击触发器 ---------- */
  click: {
    label: '点击触发器', icon: '🖱', cat: 'logic', color: '#c9a8ff',
    defaults: { scale: [5, 5, 5], color: '#c9a8ff' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([5, 5, 5]),
      A.color('#c9a8ff'), A.smartMod(), A.transparency(0.55), A.metalness(0.1), A.roughness(0.45),
      A.texture(), A.textureFill(), A.textureSize(),
      { k: 'prompt', l: '准星提示文字', t: 'text', d: '按 左键 触发', g: GROUPS.behave },
      { k: 'clickRange', l: '最大点击范围(stud)', t: 'num', d: 0, min: 0, max: 10000, st: 0.5, g: GROUPS.behave,
        h: '玩家到触发器的直线距离超过该值就点不动；0 = 不限距离' },
      { k: 'once', l: '仅触发一次', t: 'bool', d: false, g: GROUPS.behave },
      { k: 'cooldown', l: '冷却(秒)', t: 'num', d: 0.4, min: 0, max: 60, st: 0.05, g: GROUPS.behave },
      { k: 'clickEffect', l: '点击反馈特效', t: 'bool', d: true, g: GROUPS.behave },
      A.emissive(), { k: 'emissiveIntensity', l: '自发光强度', t: 'num', d: 0.6, min: 0, max: 8, st: 0.05, g: GROUPS.look },
      A.castShadow(false), A.visible(), A.frozen(),
      REF_TOUCH(), REF_ENTER(), REF_EXIT(),
    ],
    solid: false, clickTrigger: true,
    physicsShape: () => 'none',
  },

  /* ---------- 攀爬墙 ---------- */
  climb: {
    label: '攀爬墙', icon: '🧗', cat: 'logic', color: '#8ef5c8',
    defaults: { scale: [6, 24, 2], color: '#9ad9c0' },
    props: [
      ...MESH_PROPS_ADV.filter((p) => p.k !== 'physicsMode' && p.k !== 'scale' && p.k !== 'assetId'),
      A.scale([6, 24, 2]),
      A.assetId(),
      // 攀爬墙必须挡人（玩家碰到墙才能攀爬），因此不提供「无碰撞」
      { ...A.physicsMode(), o: A.physicsMode().o.filter((x) => x.v !== 'none'), h: '攀爬墙需要与玩家碰撞才能攀爬；大体积建议用包围盒' },
      { k: 'climbSpeed', l: '攀爬速度', t: 'num', d: 14, min: 1, max: 60, st: 0.5, g: GROUPS.behave },
      { k: 'sideSpeed', l: '横向移动速度', t: 'num', d: 7, min: 0, max: 40, st: 0.5, g: GROUPS.behave },
      { k: 'jumpOff', l: '可跳跃脱离', t: 'bool', d: true, g: GROUPS.behave },
      { k: 'jumpPower', l: '脱离跳跃力', t: 'num', d: 46, min: 0, max: 180, st: 1, g: GROUPS.behave },
      { k: 'holdNoInput', l: '无输入时悬挂', t: 'bool', d: true, g: GROUPS.behave, h: '关闭后没有输入时会缓慢下滑' },
    ].filter(Boolean),
    solid: true, climb: true,
    physicsShape: climbPhysicsShape,
  },

  /* ---------- WallJump 方块 ---------- */
  walljump: {
    label: 'WallJump 墙', icon: '⇧', cat: 'logic', color: '#3ad0a0',
    defaults: { texture: 'arrowsUp', color: '#f2e9ff' },
    props: [
      ...MESH_PROPS.filter((p) => p.k !== 'shape'),
      A.shape('block', [{ v: 'block', l: '立方体' }, { v: 'prism', l: '多边形柱' }]),
      /* 贴墙时长与推进力：每个 WallJump 墙可单独设置，默认取 config.PLAYER */
      { k: 'stickTime', l: '贴墙时长(秒)', t: 'num', d: PLAYER.wallJumpStickTime, min: 0.1, max: 10, st: 0.1, g: GROUPS.behave },
      { k: 'pushY', l: '向上弹力', t: 'num', d: PLAYER.wallJumpPushY, min: 0, max: 200, st: 1, g: GROUPS.behave },
      { k: 'pushOut', l: '向外弹力', t: 'num', d: PLAYER.wallJumpPushOut, min: 0, max: 200, st: 1, g: GROUPS.behave },
      { k: 'pushTime', l: '推进持续时间(秒)', t: 'num', d: PLAYER.wallJumpPushTime, min: 0, max: 3, st: 0.05, g: GROUPS.behave,
        h: '这期间持续维持弹射速度；0 = 只给一次冲量，会被空中急停很快吃掉' },
      { k: 'autoLaunch', l: '超时自动弹开', t: 'bool', d: false, g: GROUPS.behave },
    ],
    solid: true, walljump: true,
    physicsShape: () => 'box',
  },

  /* ---------- 按钮 ---------- */
  button: {
    label: '按钮', icon: '⬤', cat: 'logic', color: '#7fe3ff',
    defaults: { scale: [3, 3, 1], color: '#ff7fd0' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([3, 3, 1]),
      { k: 'pressDepth', l: '按下深度', t: 'num', d: 0.5, min: 0, max: 10000, st: 0.1, g: GROUPS.behave },
      { k: 'once', l: '仅触发一次', t: 'bool', d: false, g: GROUPS.behave },
      { k: 'holdMode', l: '按住模式', t: 'bool', d: false, g: GROUPS.behave, h: '按住时持续触发，松开触发离开事件' },
      { k: 'cooldown', l: '冷却(秒)', t: 'num', d: 0.25, min: 0, max: 30, st: 0.05, g: GROUPS.behave },
      A.color('#ff7fd0'), A.smartMod(), A.transparency(0), A.metalness(0.2), A.roughness(0.5),
      A.texture(), A.textureFill(), A.textureSize(), A.emissive(), { k: 'emissiveIntensity', l: '自发光强度', t: 'num', d: 0.25, min: 0, max: 8, st: 0.05, g: GROUPS.look },
      A.castShadow(), A.visible(), A.frozen(), A.anchored(true),
      REF_TOUCH(), REF_ENTER(), REF_EXIT(),
    ],
    solid: true, button: true,
    physicsShape: () => 'box',
  },

  /* ---------- 门 ---------- */
  door: {
    label: '门', icon: '🚪', cat: 'logic', color: '#ffd98a',
    defaults: { scale: [8, 12, 1], color: '#8a6ea8' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([8, 12, 1]),
      { k: 'openMode', l: '开门方式', t: 'select', d: 'slide', g: GROUPS.behave,
        o: [{ v: 'slide', l: '侧滑' }, { v: 'swing', l: '旋转打开' }, { v: 'sink', l: '下沉' }, { v: 'fade', l: '溶解' }] },
      { k: 'openAmount', l: '开启幅度', t: 'num', d: 1, min: 0, max: 10000, st: 0.05, g: GROUPS.behave },
      { k: 'openTime', l: '开门耗时(秒)', t: 'num', d: 0.8, min: 0.05, max: 10, st: 0.05, g: GROUPS.behave },
      { k: 'autoClose', l: '自动关闭(秒)', t: 'num', d: 0, min: 0, max: 60, st: 0.5, g: GROUPS.behave, h: '0 = 不自动关闭' },
      { k: 'requiredToolId', l: '需要指定工具对象', t: 'objref', of: 'tool', d: '', g: GROUPS.behave,
        h: '下拉里直接选关卡中的某个「工具」对象（推荐）；留空则不限' },
      { k: 'requiredTool', l: '或按工具类型限制', t: 'tool', d: '', g: GROUPS.behave,
        h: '仅按类型匹配（钥匙 / 破坏锤…），留空则不限；上面指定了对象时以对象为准' },
      { k: 'lockLabel', l: '锁提示文字', t: 'text', d: '需要钥匙', g: GROUPS.behave },
      A.color('#8a6ea8'), A.smartMod(), A.transparency(0), A.metalness(0.25), A.roughness(0.55),
      A.texture(), A.textureFill(), A.textureSize(), A.emissive(), A.emissiveIntensity(),
      A.castShadow(), A.visible(), A.frozen(), A.anchored(true), A.material(),
      { k: 'open', l: '初始已打开', t: 'bool', d: false, g: GROUPS.behave },
    ],
    solid: true, door: true,
    physicsShape: () => 'box',
  },

  /* ---------- 工具拾取 ---------- */
  tool: {
    label: '工具', icon: '🔧', cat: 'item', color: '#8ef5c8',
    defaults: { scale: [3, 3, 3], color: '#ffffff' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([3, 3, 3]),
      { k: 'tool', l: '工具类型', t: 'select', d: 'key',
        o: Object.entries(TOOL_DEFS).map(([v, x]) => ({ v, l: x.label })), g: GROUPS.behave },
      { k: 'toolName', l: '显示名', t: 'text', d: '', g: GROUPS.behave },
      { k: 'toolIcon', l: '图标', t: 'text', d: '', g: GROUPS.behave, h: '留空使用默认图标' },
      { k: 'count', l: '数量', t: 'int', d: 1, min: 1, max: 99, st: 1, g: GROUPS.behave },
      { k: 'pickupLimit', l: '每人拾取上限', t: 'int', d: 1, min: 0, max: 99, st: 1, g: GROUPS.behave,
        h: '每人最多持有/拾取的数量，达到后无法再拾取；0 = 不限制' },
      { k: 'oxygenAmount', l: '补充氧气量', t: 'num', d: 35, min: 0, max: 300, st: 1, g: GROUPS.behave,
        h: '仅氧气球有效：立刻增加额外氧气' },
      { k: 'targetIds', l: '可作用对象ID列表', t: 'objlist', d: [], g: GROUPS.behave,
        h: '破坏/钥匙类工具指定作用目标；投掷类工具指定要扔出去的投掷物对象' },
      { k: 'targetTag', l: '可作用标签', t: 'text', d: '', g: GROUPS.behave, h: '按标签匹配目标（优先于ID列表）' },
      { k: 'throwSpeed', l: '投掷速度', t: 'num', d: 0, min: 0, max: 400, st: 1, g: GROUPS.behave,
        h: '仅投掷类工具：覆盖投掷物的投掷初速，0 = 沿用投掷物对象自身设置' },
      { k: 'projLifeTime', l: '投掷物存活时间(秒)', t: 'num', d: 0, min: 0, max: 120, st: 0.5, g: GROUPS.behave,
        h: '仅投掷类工具：覆盖投掷物的存活时间，0 = 沿用投掷物对象自身设置' },
      { k: 'useEvent', l: '使用时触发事件', t: 'ref', d: '', g: GROUPS.event,
        h: '自定义工具使用时可触发的事件；留空则触发准星目标的触碰事件' },
      { k: 'respawnTime', l: '重生时间(秒)', t: 'num', d: 0, min: 0, max: 120, st: 1, g: GROUPS.behave, h: '0 = 不重生' },
      { k: 'spin', l: '悬浮旋转', t: 'bool', d: true, g: GROUPS.behave },
      { k: 'oneTime', l: '拾取后消失', t: 'bool', d: true, g: GROUPS.behave },
      A.color('#ffffff'), A.smartMod(), A.transparency(0.1), A.metalness(0.5), A.roughness(0.35),
      A.texture(), A.textureFill(), A.textureSize(), A.emissive(), { k: 'emissiveIntensity', l: '自发光强度', t: 'num', d: 0.7, min: 0, max: 8, st: 0.05, g: GROUPS.look },
      A.castShadow(), A.visible(),
    ],
    solid: false, pickup: true,
    physicsShape: () => 'none',
  },

  /* ---------- 投掷物 ---------- */
  projectile: {
    label: '投掷物', icon: '🎯', cat: 'item', color: '#ffa06b',
    defaults: { scale: [1.4, 1.4, 1.4], color: '#ffa06b' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([1.4, 1.4, 1.4]),
      { k: 'ballShape', l: '形状', t: 'select', d: 'sphere',
        o: [{ v: 'sphere', l: '球' }, { v: 'block', l: '方块' }], g: GROUPS.behave },
      { k: 'throwSpeed', l: '投掷初速', t: 'num', d: 90, min: 5, max: 400, st: 1, g: GROUPS.behave },
      { k: 'gravityScale', l: '重力倍率', t: 'num', d: 1, min: 0, max: 4, st: 0.05, g: GROUPS.behave },
      { k: 'lifeTime', l: '存活时间(秒)', t: 'num', d: 12, min: 0.5, max: 120, st: 0.5, g: GROUPS.behave },
      { k: 'bounciness', l: '弹性', t: 'num', d: 0.4, min: 0, max: 1, st: 0.02, g: GROUPS.behave },
      { k: 'damage', l: '伤害', t: 'num', d: 0, min: 0, max: 500, st: 1, g: GROUPS.behave },
      { k: 'breakTargets', l: '可破坏对象ID', t: 'objlist', d: [], g: GROUPS.behave },
      { k: 'infinite', l: '无限投掷', t: 'bool', d: true, g: GROUPS.behave,
        h: '开启后可以无限扔；关闭则每扔一次消耗一件（可扔次数看工具对象的“数量”）' },
      A.color('#ffa06b'), A.smartMod(), A.transparency(0), A.metalness(0.2), A.roughness(0.5),
      A.texture(), A.textureFill(), A.textureSize(), A.emissive(), A.emissiveIntensity(), A.castShadow(), A.visible(),
    ],
    solid: false, projectile: true,
    physicsShape: () => 'none',
  },

  /* ---------- 终点 ---------- */
  goal: {
    label: '终点', icon: '★', cat: 'gameplay', color: '#ffd98a',
    defaults: { scale: [6, 8, 6], color: '#ffe6a8' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([6, 8, 6]),
      { k: 'multi', l: '多个终点随机起点', t: 'bool', d: false, g: GROUPS.behave, h: '开启后与其它终点互斥（只需到达其一）' },
      A.color('#ffe6a8'), A.smartMod(), A.transparency(0.75), A.emissive(), { k: 'emissiveIntensity', l: '自发光强度', t: 'num', d: 2.2, min: 0, max: 8, st: 0.05, g: GROUPS.look },
      A.texture(), A.textureFill(), A.textureSize(), A.castShadow(false), A.visible(),
      REF_TOUCH(),
    ],
    solid: false, goal: true,
    physicsShape: () => 'none',
  },

  /* ---------- 起点 ---------- */
  spawn: {
    label: '起点', icon: '⚑', cat: 'gameplay', color: '#7fe3ff',
    defaults: { scale: [5, 7, 5], color: '#7fe3ff' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([5, 7, 5]),
      { k: 'weight', l: '随机权重', t: 'num', d: 1, min: 0, max: 100, st: 0.1, g: GROUPS.behave, h: '只影响起点被随机选中的概率' },
      A.color('#7fe3ff'), A.transparency(0.82), A.emissive(), { k: 'emissiveIntensity', l: '自发光强度', t: 'num', d: 1.6, min: 0, max: 8, st: 0.05, g: GROUPS.look },
      A.visible(),
    ],
    solid: false, spawn: true,
    physicsShape: () => 'none',
  },

  /* ---------- 检查点 ---------- */
  checkpoint: {
    label: '检查点', icon: '⛳', cat: 'gameplay', color: '#8ef5c8',
    defaults: { scale: [5, 8, 5], color: '#8ef5c8' },
    props: [
      A.name(), A.position(), A.rotation(), A.scale([5, 8, 5]),
      { k: 'refillOxygen', l: '重置氧气', t: 'bool', d: true, g: GROUPS.behave },
      A.color('#8ef5c8'), A.transparency(0.8), A.emissive(), { k: 'emissiveIntensity', l: '自发光强度', t: 'num', d: 1.4, min: 0, max: 8, st: 0.05, g: GROUPS.look },
      A.visible(),
    ],
    solid: false, checkpoint: true,
    physicsShape: () => 'none',
  },

  /* ---------- 灯光 ---------- */
  light: {
    label: '灯光', icon: '💡', cat: 'light', color: '#fff3c4',
    defaults: {},
    props: [
      A.name(), A.position(), A.rotation(),
      { k: 'lightType', l: '灯光类型', t: 'select', d: 'point', g: GROUPS.light,
        o: [{ v: 'directional', l: '平面平行光' }, { v: 'point', l: '点光源' }, { v: 'spot', l: '聚光灯' }] },
      { k: 'color', l: '颜色', t: 'color', d: '#fff3c4', g: GROUPS.light },
      { k: 'intensity', l: '强度', t: 'num', d: 1.6, min: 0, max: 40, st: 0.05, g: GROUPS.light },
      { k: 'distance', l: '照射距离', t: 'num', d: 120, min: 0, max: 2000, st: 1, g: GROUPS.light, h: '0 = 无限' },
      { k: 'angle', l: '聚光角(度)', t: 'num', d: 38, min: 1, max: 89, st: 1, g: GROUPS.light, h: '仅聚光灯有效' },
      { k: 'penumbra', l: '边缘柔化', t: 'num', d: 0.4, min: 0, max: 1, st: 0.05, g: GROUPS.light },
      { k: 'castShadow', l: '投射阴影', t: 'bool', d: false, g: GROUPS.light },
      { k: 'shadowSize', l: '阴影分辨率', t: 'select', d: '1024', g: GROUPS.light,
        o: [{ v: '512', l: '512' }, { v: '1024', l: '1024' }, { v: '2048', l: '2048' }] },
      { k: 'visible', l: '可见', t: 'bool', d: true, g: GROUPS.base },
      { k: 'helper', l: '常显光源标记', t: 'bool', d: true, g: GROUPS.base, h: '编辑器中显示光源位置' },
      A.frozen(),
    ],
    solid: false, light: true,
    physicsShape: () => 'none',
  },

  /* ---------- 滑索 ---------- */
  zipline: {
    label: '滑索', icon: '〰', cat: 'logic', color: '#ff7fd0',
    defaults: {},
    props: [
      A.name(),
      A.position(), A.rotation(), A.scale([1, 1, 1]),
      A.pathPoints([[0, 20, 0], [0, 20, 40], [0, 20, 90]]),
      A.segModes(),
      A.handles(),
      A.pathSource(),
      A.pathRef(),
      { k: 'speed', l: '滑动速度', t: 'num', d: 52, min: 1, max: 300, st: 1, g: GROUPS.behave },
      { k: 'accel', l: '加速度', t: 'num', d: 22, min: 0, max: 300, st: 1, g: GROUPS.behave },
      { k: 'exitPush', l: '末端抛出速度', t: 'num', d: 26, min: 0, max: 200, st: 1, g: GROUPS.behave },
      { k: 'color', l: '缆绳颜色', t: 'color', d: '#ff7fd0', g: GROUPS.look },
      { k: 'ropeRadius', l: '缆绳粗细', t: 'num', d: 0.18, min: 0.02, max: 10000, st: 0.02, g: GROUPS.look },
      { k: 'visible', l: '可见', t: 'bool', d: true, g: GROUPS.base },
      A.frozen(),
    ],
    solid: false, zipline: true,
    physicsShape: () => 'none',
  },

  /* ---------- 折曲线（纯几何路径，可被滑索 / 管道引用） ---------- */
  curve: {
    label: '折曲线', icon: '∿', cat: 'path', color: '#8fd6ff',
    defaults: {},
    props: [
      A.name(), A.position(), A.rotation(), A.scale([1, 1, 1]),
      A.pathPoints(),
      A.segModes(),
      A.handles(),
      A.radius(0.18), A.tubeSeg(), A.smoothShade(),
      A.color('#8fd6ff'), A.transparency(), A.metalness(0.35), A.roughness(0.45),
      A.emissive(), A.emissiveIntensity(), A.castShadow(false),
      A.visible(), A.frozen(),
    ],
    solid: false,
    physicsShape: () => 'none',
  },

  /* ---------- 管道（可自定义截面，路径支持折线 / 曲线） ---------- */
  pipe: {
    label: '管道', icon: '⬭', cat: 'path', color: '#cfd6e8',
    defaults: {},
    props: [
      A.name(), A.position(), A.rotation(), A.scale([1, 1, 1]),
      A.pathSource(), A.pathRef(),
      A.pathPoints(), A.segModes(), A.handles(),
      { k: 'section', l: '截面形状', t: 'select', d: 'circle', o: SECTION_OPTIONS, g: GROUPS.base,
        h: '内置截面预设；选「自定义」后由下面的顶点列表决定形状' },
      { k: 'sectionSides', l: '截面边数', t: 'int', d: 12, min: 3, max: 32, st: 1, g: GROUPS.base,
        h: '圆形 / 星形 / 半圆槽的细分；正方 / 三角 / 五边 / 六边 / 八角用固定边数' },
      { k: 'sectionRadius', l: '截面半径', t: 'num', d: 1, min: 0.05, max: 10000, st: 0.05, g: GROUPS.base },
      { k: 'sectionRot', l: '截面旋转(度)', t: 'num', d: 0, min: -180, max: 180, st: 5, g: GROUPS.base },
      { k: 'starInner', l: '星形内径比', t: 'num', d: 0.45, min: 0.05, max: 1, st: 0.05, g: GROUPS.base,
        h: '仅「星形」截面有效' },
      { k: 'sectionPts', l: '自定义截面顶点', t: 'vec2list', d: [[-1, -1], [1, -1], [1, 1], [-1, 1]], g: GROUPS.base,
        h: '仅「自定义」截面有效：X / Y 为截面的二维坐标（逆时针）' },
      { k: 'sectionPtsList', l: '截面轮廓列表', t: 'vec2lists', d: [], g: GROUPS.base, hide: true,
        h: '非连续截面（多个互不相交的子轮廓）：每条子轮廓各扫一条管再合并；由矢量截面编辑器写入' },
      { k: 'sectionDoc', l: '矢量截面', t: 'vecdoc', d: null, g: GROUPS.base, hide: true,
        h: '矢量截面编辑器写入的图形文档（可含贝塞尔曲线）；有它时优先于顶点列表' },
      { k: 'editSection', l: '截面编辑器', t: 'action', btn: '✏ 打开矢量截面编辑器…', g: GROUPS.base,
        h: '弹出 2D 矢量画布：贝塞尔曲线 / 多轮廓（非连续截面）/ 布尔运算 / 折角倒角，'
          + '编辑结果会切到「自定义」截面',
        run: (o, ed) => { if (ed && ed.openVectorEditor) ed.openVectorEditor({ target: 'pipe', obj: o }); return null; } },
      { k: 'toCustom', l: '转为自定义', t: 'action', btn: '转为自定义截面', g: GROUPS.base,
        h: '把当前预设截面的顶点复制到自定义列表，并把截面形状切到「自定义」',
        run: (o) => ({
          section: 'custom',
          sectionPts: sectionProfile(o).map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]),
        }) },
      { k: 'hollow', l: '空心管壁', t: 'bool', d: false, g: GROUPS.base },
      { k: 'wallThickness', l: '壁厚', t: 'num', d: 0.15, min: 0.02, max: 10000, st: 0.01, g: GROUPS.base,
        h: '仅「空心管壁」开启时有效' },
      { k: 'capEnds', l: '两端封口', t: 'bool', d: true, g: GROUPS.base },
      A.color('#cfd6e8'), A.smartMod(), A.transparency(), A.metalness(0.25), A.roughness(0.4),
      A.texture(), A.textureSize(), A.roughnessMap(), A.normalMap(), A.smoothShade(),
      A.emissive(), A.emissiveIntensity(), A.castShadow(),
      A.visible(), A.frozen(),
      { k: 'physicsMode', l: '碰撞体', t: 'select', d: 'none', g: GROUPS.phys,
        o: GENERATED_PHYSICS_OPTIONS,
        h: '碰撞体附加在「生成出来的管道模型」上（不是对象包围盒）：默认无碰撞，「包围盒」按整条管道、「网格」按扫掠面精确碰撞' },
    ],
    solid: false,
    physicsShape: generatedPhysicsShape,
    generatedPhysics: true,
  },

  /* ---------- 曲线墙（沿路径竖直扫掠的墙板：默认始终竖直，可设墙高 / 墙厚 / 倾角） ---------- */
  curvewall: {
    label: '曲线墙', icon: '▨', cat: 'path', color: '#d8cfc0',
    defaults: {},
    props: [
      A.name(), A.position(), A.rotation(), A.scale([1, 1, 1]),
      A.pathSource(), A.pathRef(),
      A.pathPoints([[0, 0, 0], [0, 0, 20], [0, 0, 40]]), A.segModes(), A.handles(),
      { k: 'wallHeight', l: '墙高', t: 'num', d: 6, min: 0.1, max: 10000, st: 0.5, g: GROUPS.base,
        h: '墙体从路径（基线）向上生长；截面不随路径扭转，所以墙默认始终竖直' },
      { k: 'wallThickness', l: '墙厚', t: 'num', d: 0.6, min: 0.04, max: 10000, st: 0.05, g: GROUPS.base },
      { k: 'wallTilt', l: '倾斜角度(度)', t: 'num', d: 0, min: -85, max: 85, st: 5, g: GROUPS.base,
        h: '0 = 竖直；正值让墙板绕路径方向整体倾斜（斜靠的墙 / 坡面），负值反向' },
      A.smoothShade(), A.color('#d8cfc0'), A.smartMod(), A.transparency(), A.metalness(0.05), A.roughness(0.72),
      A.texture(), A.textureSize(), A.roughnessMap(), A.normalMap(),
      A.emissive(), A.emissiveIntensity(), A.castShadow(),
      A.visible(), A.frozen(),
      { k: 'physicsMode', l: '碰撞体', t: 'select', d: 'mesh', g: GROUPS.phys,
        o: GENERATED_PHYSICS_OPTIONS,
        h: '碰撞体附加在「生成出来的墙板」上：默认「网格」按墙面精确碰撞（墙很薄，「包围盒」会明显偏大）' },
    ],
    solid: false,
    physicsShape: generatedPhysicsShape,
    generatedPhysics: true,
  },

  /* ---------- 网格修改器（引用已有对象，重复偏移变换 / 沿曲线分布） ---------- */
  meshref: {
    label: '网格修改器', icon: '⁝', cat: 'path', color: '#b9a7ff',
    defaults: {},
    props: [
      A.name(), A.position(), A.rotation(), A.scale([1, 1, 1]),
      { k: 'sourceRef', l: '引用对象', t: 'objref', d: '', not: ['meshref'], g: GROUPS.base,
        h: '被复制的源对象（网格 / 编组 / 文字方块 / 折曲线 / 管道…）。修改器自身不渲染几何，只生成副本' },
      { k: 'count', l: '副本数量', t: 'int', d: 5, min: 1, max: 200, st: 1, g: GROUPS.base },
      { k: 'offsetStep', l: '每份偏移', t: 'vec3', d: [6, 0, 0], g: GROUPS.xform, st: 0.5 },
      { k: 'rotStep', l: '每份旋转(度)', t: 'vec3', d: [0, 0, 0], g: GROUPS.xform, st: 5 },
      { k: 'scaleStep', l: '每份缩放', t: 'vec3', d: [1, 1, 1], g: GROUPS.xform, st: 0.05, min: 0.02,
        h: '逐份累乘：第 i 份 = 每份缩放 ^ i' },
      { k: 'distMode', l: '分布方式', t: 'select', d: 'step', g: GROUPS.behave,
        o: [{ v: 'step', l: '按递变量分布' }, { v: 'curve', l: '沿曲线分布' }] },
      { k: 'curveRef', l: '分布曲线', t: 'objref', of: 'curve', d: '', g: GROUPS.behave,
        h: '仅「沿曲线分布」时生效' },
      { k: 'alignCurve', l: '朝向切线', t: 'bool', d: true, g: GROUPS.behave,
        h: '仅「沿曲线分布」时生效：副本沿曲线切线方向朝向' },
      { k: 'physicsMode', l: '碰撞体', t: 'select', d: 'none', g: GROUPS.phys,
        o: GENERATED_PHYSICS_OPTIONS,
        h: '为生成出来的每一份副本各建一个碰撞体，跟随副本的位置 / 旋转 / 缩放；默认无碰撞' },
      A.visible(), A.frozen(),
    ],
    solid: false,
    physicsShape: generatedPhysicsShape,
    generatedPhysics: true,
  },

  /* ---------- 编组（非渲染） ---------- */
  group: {
    label: '编组', icon: '⧉', cat: 'struct', color: '#7d769a',
    defaults: {},
    props: [
      A.name(), A.position(), A.rotation(), A.visible(), A.frozen(),
    ],
    solid: false, isGroup: true,
    physicsShape: () => 'none',
  },

  /* ---------- 接头（attachment） ----------
     把自己当成宿主（父级网格 / 低模体 / 液体）表面上的一个「接口」：
     · 位置 = 宿主局部坐标(stud)，每帧自动吸附到宿主最近的表面并取该面的法线
     · 朝向 = 站立在面上（+Y 对齐面法线），用「旋转」绕法线做 roll
     · 把其他对象设为本接头的子对象，它们就会跟着接头（也就是跟着那个面）一起变换
     液体宿主特例：始终吸附在液面上，随 fillLevel 0~1 升降。 */
  attachment: {
    label: '接头', icon: '🔗', cat: 'struct', color: '#8ef5c8',
    defaults: {},
    props: [
      A.name(),
      { ...A.position(), l: '局部位置(宿主坐标)', st: 0.25,
        h: '在宿主网格局部坐标里的位置(stud)。会吸附到宿主最近的表面，因此只要填「大致方向」即可：' +
          '例如宿主顶面填 (0, 正数, 0)。液体宿主只看 X/Z，Y 始终跟着液面' },
      { ...A.rotation(), h: '相对面基座的旋转(度)：Y 轴 = 绕面法线自转(roll)，X/Z 轴在面内' },
      A.scale([1, 1, 1]),
      { k: 'snap', l: '吸附到宿主表面', t: 'bool', d: true, g: GROUPS.base,
        h: '开启：自动贴到宿主最近的表面并取该面法线；关闭：按给定局部坐标与宿主朝向放置（不贴面）' },
      { k: 'offset', l: '沿法线偏移', t: 'num', d: 0, min: -10000, max: 10000, st: 0.05, g: GROUPS.base,
        h: '沿面法线方向浮动(stud)：正数向外（离表面）、负数向内' },
      A.visible(), A.frozen(),
    ],
    solid: false, attachment: true,
    physicsShape: () => 'none',
  },

  /* ---------- 文字 / 公告板 ---------- */
  textblock: {
    label: '文字方块', icon: '🅣', cat: 'text', color: '#e8e2ff',
    defaults: {},
    props: [
      A.name(), A.position(), A.rotation(), A.scale([8, 4, 0.6]),
      { k: 'text', l: '文字内容', t: 'text', d: '文字', g: GROUPS.look,
        h: '回车换行；超出范围会自动缩小字号；富文本为空时用这里的纯文本' },
      { k: 'rich', l: '富文本', t: 'rich', d: [], hide: true,
        h: '富文本段落（加粗/斜体/下划线/颜色/字号）；存在时优先于纯文本' },
      { k: 'editRich', l: '富文本', t: 'action', btn: '✏ 富文本编辑器…', g: GROUPS.look,
        h: '打开专用富文本编辑器：加粗 / 斜体 / 下划线 / 颜色 / 字号 / 对齐',
        run: (o, ed) => { if (ed && ed.openRichTextEditor) ed.openRichTextEditor(o); return null; } },
      { k: 'textColor', l: '文字颜色', t: 'color', d: '#ffffff', g: GROUPS.look },
      { k: 'bgColor', l: '底色', t: 'color', d: '#2a2440', g: GROUPS.look,
        h: '其余 5 个面显示该底色，只有 +Z 正面写字' },
      { k: 'bgOpacity', l: '底色不透明度', t: 'num', d: 1, min: 0, max: 1, st: 0.05, g: GROUPS.look },
      { k: 'fontSize', l: '字号', t: 'num', d: 72, min: 8, max: 10000, st: 2, g: GROUPS.look },
      { k: 'bold', l: '加粗', t: 'bool', d: true, g: GROUPS.look },
      { k: 'align', l: '水平对齐', t: 'select', d: 'center', g: GROUPS.look,
        o: [{ v: 'left', l: '左对齐' }, { v: 'center', l: '居中' }, { v: 'right', l: '右对齐' }] },
      { k: 'valign', l: '垂直对齐', t: 'select', d: 'center', g: GROUPS.look,
        o: [{ v: 'top', l: '顶部' }, { v: 'center', l: '居中' }, { v: 'bottom', l: '底部' }] },
      A.roughness(), A.metalness(), A.emissive(), A.emissiveIntensity(),
      A.lightInfluence(GROUPS.look),
      A.transparency(), A.castShadow(), A.visible(), A.frozen(),
      A.anchored(), A.mass(), A.material(), A.physicsMode(),
    ],
    solid: true,
    physicsShape: meshPhysicsShape,
  },

  billboard: {
    label: '公告板 Billboard', icon: '🖼', cat: 'text', color: '#ffd98a',
    defaults: {},
    props: [
      A.name(), A.position(), A.rotation(),
      // 版面尺寸：宽 / 高是绝对大小(stud)，UIScale 以宽为基准等比缩放 → 最终尺寸 = 宽高 × UIScale。
      // 内部仍统一写回 scale（单一运行时真值），所以原始 scale 行隐藏，面板只暴露这三个直观属性。
      { ...A.scale([6, 3, 1]), hide: true },
      { k: 'width', l: '版面宽 (stud)', t: 'num', d: 6, min: 0.01, max: 10000, st: 0.1, g: GROUPS.look,
        h: '公告板面片的绝对宽度（stud）' },
      { k: 'height', l: '版面高 (stud)', t: 'num', d: 3, min: 0.01, max: 10000, st: 0.1, g: GROUPS.look,
        h: '公告板面片的绝对高度（stud）' },
      { k: 'sizeScale', l: 'UIScale (等比)', t: 'num', d: 1, min: 0.01, max: 1000, st: 0.05, g: GROUPS.look,
        h: '以宽为基准等比缩放：最终尺寸 = 宽 × UIScale、高 × UIScale' },
      { k: 'mode', l: '内容类型', t: 'select', d: 'text', g: GROUPS.look,
        o: [{ v: 'text', l: '文字' }, { v: 'image', l: '图片' }] },
      { k: 'text', l: '文字内容', t: 'text', d: '提示文字', g: GROUPS.look,
        h: '内容类型为「文字」时显示；富文本为空时用这里的纯文本' },
      { k: 'rich', l: '富文本', t: 'rich', d: [], hide: true,
        h: '富文本段落（加粗/斜体/下划线/颜色/字号）；存在时优先于纯文本' },
      { k: 'editRich', l: '富文本', t: 'action', btn: '✏ 富文本编辑器…', g: GROUPS.look,
        h: '打开专用富文本编辑器：加粗 / 斜体 / 下划线 / 颜色 / 字号 / 对齐',
        run: (o, ed) => { if (ed && ed.openRichTextEditor) ed.openRichTextEditor(o); return null; } },
      { k: 'image', l: '图片', t: 'tex', d: 'none', g: GROUPS.look,
        h: '内容类型为「图片」时显示；可用内置贴图或导入图片' },
      { k: 'textColor', l: '文字颜色', t: 'color', d: '#ffffff', g: GROUPS.look },
      { k: 'bgColor', l: '底色', t: 'color', d: '#1d1830', g: GROUPS.look },
      { k: 'bgOpacity', l: '底色不透明度', t: 'num', d: 0, min: 0, max: 1, st: 0.05, g: GROUPS.look },
      { k: 'fontSize', l: '字号', t: 'num', d: 72, min: 8, max: 10000, st: 2, g: GROUPS.look },
      { k: 'bold', l: '加粗', t: 'bool', d: true, g: GROUPS.look },
      { k: 'align', l: '水平对齐', t: 'select', d: 'center', g: GROUPS.look,
        o: [{ v: 'left', l: '左对齐' }, { v: 'center', l: '居中' }, { v: 'right', l: '右对齐' }] },
      { k: 'valign', l: '垂直对齐', t: 'select', d: 'center', g: GROUPS.look,
        o: [{ v: 'top', l: '顶部' }, { v: 'center', l: '居中' }, { v: 'bottom', l: '底部' }] },
      A.color('#ffffff'),
      { k: 'baseOpacity', l: '基础不透明度', t: 'num', d: 1, min: 0, max: 1, st: 0.05, g: GROUPS.look },
      A.lightInfluence(GROUPS.look),
      { k: 'faceCamera', l: '始终面向玩家', t: 'bool', d: true, g: GROUPS.behave,
        h: '开启后公告板一直转向玩家；关闭则用「旋转」固定朝向' },
      { k: 'fadeEnabled', l: '距离淡入淡出', t: 'bool', d: true, g: GROUPS.behave,
        h: '靠近淡入、远离淡出' },
      { k: 'fadeIn', l: '完全显示距离', t: 'num', d: 40, min: 0, max: 10000, st: 1, g: GROUPS.behave,
        h: '玩家比这个距离近 → 完全不透明' },
      { k: 'fadeOut', l: '完全淡出距离', t: 'num', d: 140, min: 0.5, max: 10000, st: 1, g: GROUPS.behave,
        h: '玩家比这个距离远 → 完全看不见' },
      A.visible(), A.frozen(),
    ],
    solid: false,
    physicsShape: () => 'none',
  },

  /* ---------- 平行视差传送门 ---------- */
  portal: {
    label: '平行视差传送门', icon: '🌀', cat: 'fx', color: '#8fe3ff',
    defaults: {},
    props: [
      A.name(), A.position(), A.rotation(), A.scale([8, 8, 1]),
      /* 形状（归一化轮廓空间：[-0.5, 0.5]² 铺满整片，靠「尺寸/缩放」放大） */
      { k: 'shapePreset', l: '形状预设', t: 'select', d: 'roundRect', o: PORTAL_PRESET_OPTIONS, g: GROUPS.base,
        h: '切换预设会重排轮廓节点；选「自由曲线」后在视图里拖节点手柄自由编辑' },
      { k: 'cornerRadius', l: '圆角半径', t: 'num', d: 0.18, min: 0, max: 0.48, st: 0.01, g: GROUPS.base,
        h: '仅「圆角矩形」有效：0.5 = 半宽全圆角' },
      { k: 'sides', l: '多边形边数', t: 'int', d: 6, min: 3, max: 24, st: 1, g: GROUPS.base,
        h: '仅「多边形」有效' },
      { k: 'smooth', l: '轮廓平滑度', t: 'int', d: 48, min: 8, max: 64, st: 1, g: GROUPS.base,
        h: '轮廓采样点数，越大边缘越顺滑（上限 64）' },
      { k: 'points', l: '轮廓节点', t: 'vec3list', d: PORTAL_DEFAULT_POINTS().points, g: GROUPS.base,
        h: '归一化平面坐标（x/y ∈ [-0.5, 0.5]，z 忽略）；也可在视图里直接拖节点编辑' },
      { k: 'segModes', l: '段模式', t: 'strlist', d: PORTAL_DEFAULT_POINTS().segModes, g: GROUPS.base,
        o: [{ v: 'curve', l: '曲线' }, { v: 'line', l: '直线' }],
        h: '逐段选择：曲线 = 三次贝塞尔（用两端手柄），直线 = 直连（忽略手柄）' },
      { k: 'handles', l: '贝塞尔手柄', t: 'handles', d: [], g: GROUPS.base, hide: true,
        h: '每个节点一对相对手柄 [入手柄, 出手柄]，在视图里直接拖拽调整' },
      { k: 'shapeDoc', l: '矢量轮廓', t: 'vecdoc', d: null, g: GROUPS.base, hide: true,
        h: '矢量轮廓编辑器写入的图形文档；有它时优先于轮廓节点' },
      { k: 'editOutline', l: '矢量轮廓编辑器', t: 'action', btn: '✏ 打开矢量轮廓编辑器…', g: GROUPS.base,
        h: '弹出 2D 矢量画布编辑传送门轮廓（贝塞尔 / 多轮廓 / 布尔 / 倒角）；'
          + '传送门外框限定在 [-0.5, 0.5]² 内，超出部分会被裁到框内',
        run: (o, ed) => { if (ed && ed.openVectorEditor) ed.openVectorEditor({ target: 'portal', obj: o }); return null; } },
      /* 视差图层 */
      { k: 'layers', l: '视差图层', t: 'layers', d: PORTAL_DEFAULT_LAYERS(), g: GROUPS.tex,
        h: '从远到近逐层叠加的平行世界贴图；每层「深度倍率」为 0~1，实际深度 = 深度倍率 × 视差深度(stud)' },
      { k: 'depthScale', l: '视差深度（studs）', t: 'num', d: 60, min: 0, max: PORTAL_DEPTH_MAX, st: 1, g: GROUPS.tex,
        h: '纵深上限（stud）：每层「深度倍率」× 该值 = 该层图像在传送门平面后方的真实距离；'
          + '越深 = 越小 / 越密 / 镜头移动时幅度越小，相机越近则相对传送门平面越小' },
      /* 内部 */
      { k: 'innerColor', l: '内部底色', t: 'color', d: '#0a0a12', g: GROUPS.look },
      { k: 'innerAlpha', l: '内部不透明度', t: 'num', d: 1, min: 0, max: 1, st: 0.05, g: GROUPS.look,
        h: '0 = 内部完全透明（只剩外框）' },
      /* 外框 */
      { k: 'frame', l: '外框样式', t: 'select', d: 'standard', o: PORTAL_FRAME_OPTIONS, g: GROUPS.look },
      { k: 'frameColor', l: '外框主色', t: 'color', d: '#9de8ff', g: GROUPS.look },
      { k: 'frameColor2', l: '外框副色', t: 'color', d: '#6a3dff', g: GROUPS.look,
        h: '液态 / 故障 / 裂缝样式用它与主色混色' },
      { k: 'frameWidth', l: '外框宽度', t: 'num', d: 0.035, min: 0.001, max: 0.4, st: 0.005, g: GROUPS.look,
        h: '归一化轮廓宽度（0.5 = 半宽）' },
      { k: 'frameGlow', l: '外发光', t: 'num', d: 1, min: 0, max: 4, st: 0.05, g: GROUPS.look },
      { k: 'frameIntensity', l: '外框亮度', t: 'num', d: 1, min: 0, max: 4, st: 0.05, g: GROUPS.look },
      { k: 'frameSpeed', l: '动画速度', t: 'num', d: 1, min: 0, max: 8, st: 0.1, g: GROUPS.look,
        h: '液态 / 故障 / 裂缝样式的动态速度' },
      { k: 'innerGlow', l: '内侧边缘光', t: 'num', d: 0.25, min: 0, max: 2, st: 0.05, g: GROUPS.look },
      { k: 'edgeSoft', l: '边缘柔化', t: 'num', d: 0.006, min: 0.0005, max: 0.05, st: 0.001, g: GROUPS.look,
        h: '轮廓边缘的抗锯齿宽度，越小越锐利' },
      A.lightInfluence(GROUPS.look),
      A.visible(), A.frozen(),
    ],
    solid: false,
    physicsShape: () => 'none',
  },
};

/* ---------- 便捷索引 ---------- */
export const TYPE_KEYS = Object.keys(OBJECT_TYPES);
export function typeDef(t) { return OBJECT_TYPES[t] || OBJECT_TYPES.mesh; }
export function propsOf(t) { return typeDef(t).props; }
export function propDef(t, k) { return propsOf(t).find((p) => p.k === k); }

/** 创建对象数据（带默认值） */
export function createObject(type, over = {}) {
  const def = typeDef(type);
  const o = { id: uid(type.slice(0, 2)), type, parent: null };
  for (const p of def.props) {
    if (p.t === 'vec3' || p.t === 'vec3list' || p.t === 'vec2list' || p.t === 'vec2lists' || p.t === 'handles'
      || p.t === 'layers' || p.t === 'dlg' || p.t === 'vecdoc') o[p.k] = JSON.parse(JSON.stringify(p.d));
    else if (p.t === 'objlist' || p.t === 'strlist' || p.t === 'particles' || p.t === 'rich') o[p.k] = JSON.parse(JSON.stringify(p.d || []));
    else if (p.t === 'action') continue;         // 动作型属性不落数据
    // 文字型默认值按当前界面语言落库（如文字方块 / 公告板的默认文字）
    else if (p.t === 'text' && typeof p.d === 'string') o[p.k] = t(p.d);
    else o[p.k] = p.d;
  }
  // 类型特化默认
  if (type === 'liquid') {
    const k = over.kind || 'water';
    const L = LIQUID_KINDS[k] || LIQUID_KINDS.water;
    Object.assign(o, {
      kind: k, color: L.color, transparency: 1 - L.opacity, drainRate: L.drain,
      instantKill: L.kill, swim: L.swim, waterResist: L.resist, scale: [16, 12, 16], position: [0, 6, 0],
      roughness: 0.08, metalness: 0.3, emissiveIntensity: 0.18, emissive: L.emissive,
      castShadow: false, oxygenMode: 'drain',
    });
    applyLiquidStyle(o, STYLE_BY_KIND[k] || 'water');   // 水纹风格预设（颜色/泡沫/深度色）
  }
  if (type === 'walljump') { o.texture = 'arrowsUp'; o.color = '#f2e9ff'; }
  // 伤害区域在游戏内可见：默认给一套半透明警示外观（否则默认不透明度 0 → 会渲染成一块
  // 实心墙，既挡住视线又看不出是危险区）。调用方显式传 over 时仍可覆盖。
  if (type === 'damage') {
    o.color = '#ff6b8a'; o.transparency = 0.5;
    o.emissive = '#ff2d55'; o.emissiveIntensity = 0.7; o.castShadow = false;
  }
  // 矢量挤出体：没给图形时给一个圆角方块，否则几何为空 → 对象不可见也没法编辑
  if (type === 'vec' && !o.vecShape) o.vecShape = defaultVecDoc();
  // 公告板用单面片（+Z 朝外），靠缩放决定大小
  if (type === 'billboard') o.shape = 'plane';
  Object.assign(o, over);
  // 公告板尺寸：宽 / 高（绝对 stud）+ UIScale（等比）→ 统一写回 scale。
  // 调用方显式给了 scale 时以 scale 为准（如预制体 / 复制），并反算回宽高。
  if (type === 'billboard') {
    const sc = (o.sizeScale = Math.max(0.01, Number(o.sizeScale) || 1));
    if (over.scale) {
      o.width = Math.max(0.01, (Number(o.scale[0]) || 1) / sc);
      o.height = Math.max(0.01, (Number(o.scale[1]) || 1) / sc);
    } else {
      o.width = Math.max(0.01, Number(o.width) || 6);
      o.height = Math.max(0.01, Number(o.height) || 3);
      o.scale = [o.width * sc, o.height * sc, 1];
    }
  }
  // 传送门同样是一整片面片，轮廓点直接落在平面局部坐标上
  // （放在 over 之后：调用方显式给的 points 优先，否则按预设重排）
  if (type === 'portal') {
    o.shape = 'plane';
    o.castShadow = false;
    o.receiveShadow = false;
    if (!over.points) {
      const shape = portalPresetShape(o.shapePreset || 'roundRect', o);
      if (shape) { o.points = shape.points; o.handles = shape.handles; o.segModes = shape.segModes; }
    }
  }
  if (o.position && o.position.length === 3) o.position = o.position.map((v) => Number(v) || 0);
  return o;
}

/** 应用“液体种类”预设到已有对象 */
export function applyLiquidKind(o, kind) {
  const L = LIQUID_KINDS[kind] || LIQUID_KINDS.water;
  o.kind = kind;
  o.color = L.color;
  o.transparency = 1 - L.opacity;
  o.drainRate = L.drain;
  o.instantKill = L.kill;
  o.swim = L.swim;
  o.waterResist = L.resist;
  o.emissive = L.emissive;
  o.emissiveIntensity = kind === 'lava' ? 0.85 : 0.18;
  applyLiquidStyle(o, STYLE_BY_KIND[kind] || 'water');   // 同步切换默认水纹风格
  return o;
}

export const CATEGORIES = [
  { key: 'mesh',     label: '网格模型' },
  { key: 'liquid',   label: '液体' },
  { key: 'text',     label: '文字 / 公告板' },
  { key: 'fx',       label: '特效' },
  { key: 'logic',    label: '游戏机制' },
  { key: 'gameplay', label: '关卡元素' },
  { key: 'npc',      label: 'NPC / 角色' },
  { key: 'item',     label: '工具 / 投掷物' },
  { key: 'light',    label: '灯光' },
  { key: 'struct',   label: '结构' },
  { key: 'path',     label: '路径 / 管道 / 修改器' },
];

export { BUILTIN_TEXTURES, EASINGS, TOOL_DEFS };
export { PHYS };
export { applyLiquidStyle, applyLiquidPattern, liquidStyleOptions } from './liquid-presets.js';
export { applyAdvancedMaterial, ADV_OPTIONS } from './advanced-materials.js';