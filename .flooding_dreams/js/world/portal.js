/* ============================================================
   平行视差传送门（纯视觉视差窗口，不传送玩家）
   ------------------------------------------------------------
   · 归一化轮廓空间：轮廓点直接取 [-0.5, 0.5]² 的平面局部坐标，
     与引擎「单位几何 + mesh.scale」的约定一致 —— o.scale 天然完成缩放。
   · 轮廓是**闭合环**：外层给的点 + 段模式 + 贝塞尔手柄，
     缺哪儿补哪儿（按环绕 Catmull-Rom 自动推导），最后均匀采样成
     定长 uniform 数组（vec2[64]），渲染时用 SDF 做遮罩与描边。
   · 视差：只由「视差深度(stud)」驱动 —— 每层真实深度 d = 深度倍率 × 视差深度，
     图层等价于贴在「相机前方 camZ + d」处的一幅画面，缩放与位移由同一个 s 推出：
       · 相对大小 s = camZ / (camZ + d)：越深越小（越远）、贴图随之变密；
         相机越近相对传送门平面越小，越远越接近 1:1；d = 0 时恒为 s = 1；
       · 缩放的不动点 = 视线与传送门平面的交点（屏幕中心指着的那一点），
         于是靠近时画面朝注视点收缩；图像位置仍随相机位置走，不会被注视点拖跑；
       · 图层的屏幕移动幅度 = s × 窗口自身的移动 —— 越深动得越少；
       · 屏幕上的大小 ∝ 1/(camZ + d)，深处的图层几乎不随相机移动改变观感大小。
   · 外框 5 种样式：无框 / 标准 / 液态流动 / 故障 / 裂缝，全部是
     同一条 SDF 轮廓上的程序化图案，不额外增加几何与 drawcall。
   ============================================================ */
import * as THREE from '../core/three-ns.js';
import { clamp } from '../core/util.js';
import { getTexture } from '../core/textures.js';
import { applyScreenGrade, lightInfluenceUniform } from '../core/materials.js';
import { newLayer, newPath, docPaths, docHasContent, hasIn, hasOut, nodeIn, nodeOut } from '../core/vector-shape.js';

/** 共享时间轴（builder.update 每帧推进）
    定义已下沉到 core/shader-uniforms.js（worker 安全），这里 re-export 保持既有 import 路径不变。 */
import { PORTAL_UNIFORMS } from '../core/shader-uniforms.js';
export { PORTAL_UNIFORMS };

/** 视差图层上限（着色器里是 6 个独立 sampler + 定长 uniform 数组） */
export const PORTAL_MAX_LAYERS = 6;

/** 轮廓采样点数上限（uniform 数组长度） */
export const OUTLINE_MAX = 64;

/** 外框样式 */
export const PORTAL_FRAME_OPTIONS = [
  { v: 'none',     l: '无框' },
  { v: 'standard', l: '标准' },
  { v: 'liquid',   l: '液态流动' },
  { v: 'glitch',   l: '故障(glitch)' },
  { v: 'crack',    l: '裂缝式' },
];
const FRAME_MODE = { none: 0, standard: 1, liquid: 2, glitch: 3, crack: 4 };

/** 形状预设 */
export const PORTAL_PRESET_OPTIONS = [
  { v: 'roundRect', l: '圆角矩形' },
  { v: 'rect',      l: '矩形' },
  { v: 'ellipse',   l: '椭圆' },
  { v: 'polygon',   l: '多边形' },
  { v: 'free',      l: '自由曲线' },
];

/** 图层混合方式 */
export const PORTAL_BLEND_OPTIONS = [
  { v: 'normal',   l: '正常' },
  { v: 'add',      l: '叠加' },
  { v: 'multiply', l: '正片叠底' },
  { v: 'screen',   l: '滤色' },
];
const BLEND_INDEX = { normal: 0, add: 1, multiply: 2, screen: 3 };

/** 图层平铺模式（关闭平铺时，图像只画一次，边界外透明） */
export const PORTAL_TILE_OPTIONS = [
  { v: 'repeat', l: '重复' },
  { v: 'mirror', l: '镜像无缝' },
  { v: 'clamp',  l: '边缘拉伸' },
];
const TILE_INDEX = { repeat: 0, mirror: 1, clamp: 2 };

/** 视差深度的物理上限（stud）：超过这个深度视差已经没有可感知的差别 */
export const PORTAL_DEPTH_MAX = 1000;

/** 圆角 / 椭圆的四次圆弧贝塞尔逼近系数 */
const K = 0.5522847498;

const DEFAULT_POINTS = [[0.5, 0.5, 0], [-0.5, 0.5, 0], [-0.5, -0.5, 0], [0.5, -0.5, 0]];

/* ============================================================
   形状预设
   ============================================================ */

const zeroH = (n) => Array.from({ length: n }, () => [[0, 0, 0], [0, 0, 0]]);

/** 矩形 / 圆角矩形：8 节点（四角带圆弧），半径 0 时退化成 4 个尖角 */
function roundRectShape(r) {
  const h = 0.5;
  const rr = clamp(r, 0, 0.499);
  if (rr < 0.002) {
    return {
      points: [[h, h, 0], [-h, h, 0], [-h, -h, 0], [h, -h, 0]],
      handles: zeroH(4),
      segModes: ['line', 'line', 'line', 'line'],
    };
  }
  const pts = [
    [h - rr, h, 0],      // 0 上边右端
    [-h + rr, h, 0],     // 1 上边左端
    [-h, h - rr, 0],     // 2 左边上端
    [-h, -h + rr, 0],    // 3 左边下端
    [-h + rr, -h, 0],    // 4 下边左端
    [h - rr, -h, 0],     // 5 下边右端
    [h, -h + rr, 0],     // 6 右边下端
    [h, h - rr, 0],      // 7 右边上端
  ];
  // 各节点行进方向（逆时针）与两侧手柄长度：圆弧端用 k·r，直边端用 边长的 1/3
  const dirs = [[-1, 0], [-1, 0], [0, -1], [0, -1], [1, 0], [1, 0], [0, 1], [0, 1]];
  const arc = K * rr;
  const lx = (2 * h - 2 * rr) / 3, ly = (2 * h - 2 * rr) / 3;
  // 每个节点：[入手柄长度, 出手柄长度]；入手柄指向上游来的方向（= 行进方向的反向）
  const mags = [
    [arc, lx], [lx, arc], [arc, ly], [ly, arc],
    [arc, lx], [lx, arc], [arc, ly], [ly, arc],
  ];
  const handles = pts.map((_, i) => {
    const [im, om] = mags[i];
    const [dx, dy] = dirs[i];
    return [[-dx * im, -dy * im, 0], [dx * om, dy * om, 0]];
  });
  return { points: pts, handles, segModes: Array(8).fill('curve') };
}

/** 椭圆：4 节点 + 四段圆弧贝塞尔 */
function ellipseShape() {
  const h = 0.5;
  const pts = [[h, 0, 0], [0, h, 0], [-h, 0, 0], [0, -h, 0]];
  const handles = [
    [[0, -K * h, 0], [0, K * h, 0]],
    [[K * h, 0, 0], [-K * h, 0, 0]],
    [[0, K * h, 0], [0, -K * h, 0]],
    [[-K * h, 0, 0], [K * h, 0, 0]],
  ];
  return { points: pts, handles, segModes: Array(4).fill('curve') };
}

/** 正多边形：顶点落在内切半径为 0.5 的圆上，直线段 */
function polygonShape(sides) {
  const n = Math.max(3, Math.round(sides || 6));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + (i / n) * Math.PI * 2;
    pts.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0]);
  }
  return { points: pts, handles: zeroH(n), segModes: Array(n).fill('line') };
}

/**
 * 按预设生成轮廓（'free' 返回 null，表示保留用户手画的点）
 * @returns {{points:number[][], handles:number[][][], segModes:string[]}|null}
 */
export function portalPresetShape(preset, opts = {}) {
  switch (preset) {
    case 'rect': return roundRectShape(0);
    case 'roundRect': return roundRectShape(Number(opts.cornerRadius ?? 0.18));
    case 'ellipse': return ellipseShape();
    case 'polygon': return polygonShape(opts.sides);
    default: return null;
  }
}

/* ============================================================
   闭合环采样 → 定长 uniform 数组
   ============================================================ */

function readVec2(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = Number(v[0]), y = Number(v[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

/**
 * 数据兜底：轮廓点少于 3 个（旧数据 / 被清空）时按当前预设重建，
 * 并保证 segModes 与节点数对齐。就地修改 o。
 */
export function ensurePortalShape(o) {
  const ok = (Array.isArray(o.points) ? o.points : []).filter((p) => readVec2(p));
  if (ok.length < 3) {
    // 轮廓点丢失（旧数据 / 被清空）时，优先由矢量文档重建
    const fromDoc = (o.shapeDoc && docHasContent(o.shapeDoc)) ? portalDocToShape(o.shapeDoc) : null;
    const shape = fromDoc || portalPresetShape(o.shapePreset, o) || portalPresetShape('rect', o);
    o.points = shape.points;
    o.handles = shape.handles;
    o.segModes = shape.segModes;
  }
  if (!Array.isArray(o.segModes) || o.segModes.length !== o.points.length) {
    o.segModes = o.points.map((_, i) => (Array.isArray(o.segModes) && o.segModes[i]) || 'curve');
  }
  migratePortalDepth(o);
  return o;
}

/**
 * 旧数据迁移：早期每层「深度」是真实 stud 值（可 >1），现在改为 0~1 倍率，
 * 全局「视差深度(stud)」负责尺度。检测到旧值就按原有实际深度换算，保持视觉不变。
 * 迁移后所有倍率 ≤1，因此本函数幂等。
 */
function migratePortalDepth(o) {
  const lay = Array.isArray(o.layers) ? o.layers : null;
  if (!lay || !lay.some((L) => L && Number(L.depth) > 1)) return;
  const oldScale = Math.max(1e-3, Number(o.depthScale) || 1);
  let maxStud = 0;
  for (const L of lay) if (L) maxStud = Math.max(maxStud, (Number(L.depth) || 0) * oldScale);
  const newScale = Math.max(60, maxStud);
  for (const L of lay) {
    if (L) L.depth = Math.round(((Number(L.depth) || 0) * oldScale / newScale) * 1000) / 1000;
  }
  o.depthScale = newScale;
}

/* ============================================================
   轮廓 ⇄ 矢量图文档
   复用通用矢量编辑器：文档坐标空间就是轮廓的归一化空间 [-0.5, 0.5]²
   ============================================================ */

/**
 * 轮廓 → 矢量文档（单图层单闭合路径）。
 * 'line' 段不写手柄 —— 与文档「无柄 = 直线段」的语义一致，往返不丢形状。
 */
export function portalShapeToDoc(o) {
  ensurePortalShape(o);
  const pts = (Array.isArray(o.points) ? o.points : []).map((p) => readVec2(p) || [0, 0]);
  const n = pts.length;
  const seg = Array.isArray(o.segModes) ? o.segModes : [];
  const H = portalResolvedHandles(o);
  const nodes = pts.map((p, i) => {
    const nd = { x: p[0], y: p[1] };
    // 第 i 个节点的入手柄属于第 i-1 段、出手柄属于第 i 段（闭合环回绕）
    if (seg[(i - 1 + n) % n] !== 'line') { nd.ix = p[0] + H[i][0][0]; nd.iy = p[1] + H[i][0][1]; }
    if (seg[i % n] !== 'line') { nd.ox = p[0] + H[i][1][0]; nd.oy = p[1] + H[i][1][1]; }
    return nd;
  });
  const layer = newLayer('轮廓');
  layer.paths.push(newPath(nodes, { closed: true }));
  return { layers: [layer] };
}

/**
 * 矢量文档 → 轮廓（取第一条闭合路径，节点 + 贝塞尔手柄原样保留）。
 * 坐标超出 [-0.5, 0.5]² 的部分裁到框内，保证轮廓不越出平面。
 * @returns {{points:number[][], handles:number[][][], segModes:string[]}|null}
 */
export function portalDocToShape(doc) {
  const path = docPaths(doc)
    .map((e) => e.path)
    .find((p) => p.closed !== false && (p.nodes || []).length >= 3);
  if (!path) return null;
  const lim = 0.5;
  const cx = (v) => clamp(Number(v) || 0, -lim, lim);
  const ns = path.nodes;
  const n = ns.length;
  const points = [], handles = [], segModes = [];
  for (let i = 0; i < n; i++) {
    const nd = ns[i];
    const px = cx(nd.x), py = cx(nd.y);
    points.push([px, py, 0]);
    handles.push([
      hasIn(nd) ? [cx(nodeIn(nd)[0]) - px, cx(nodeIn(nd)[1]) - py, 0] : [0, 0, 0],
      hasOut(nd) ? [cx(nodeOut(nd)[0]) - px, cx(nodeOut(nd)[1]) - py, 0] : [0, 0, 0],
    ]);
    const a = ns[i], b = ns[(i + 1) % n];
    segModes.push((hasOut(a) || hasIn(b)) ? 'curve' : 'line');
  }
  return { points, handles, segModes };
}

/**
 * 解析后的手柄表（[[入手柄, 出手柄], ...]，三维向量，z 恒为 0）
 * 供视口节点编辑器显示 / 拖拽用，与 sampleOutline 的自动推导完全一致
 */
export function portalResolvedHandles(o) {
  const pts = (Array.isArray(o.points) ? o.points : []).map((p) => readVec2(p) || [0, 0]);
  const n = pts.length;
  if (n < 3) return [];
  const rawH = Array.isArray(o.handles) ? o.handles : [];
  return pts.map((_, i) => {
    const a = autoHandle(pts, i);
    const h = rawH[i];
    const inV = (Array.isArray(h) && readVec2(h[0])) || [-a[0], -a[1]];
    const outV = (Array.isArray(h) && readVec2(h[1])) || [a[0], a[1]];
    return [[inV[0], inV[1], 0], [outV[0], outV[1], 0]];
  });
}

/** 闭合环上的自动切线（环绕 Catmull-Rom）：(后一点 - 前一点) / 6 */
function autoHandle(points, i) {
  const n = points.length;
  const nx = points[(i + 1) % n], pv = points[(i - 1 + n) % n];
  return [(nx[0] - pv[0]) / 6, (nx[1] - pv[1]) / 6];
}

/**
 * 采样闭合轮廓 → { data: Float32Array(OUTLINE_MAX*2), count }
 * 段模式为 'line' 的段直连，其余按三次贝塞尔；手柄缺失处用自动切线补齐。
 */
export function sampleOutline(o) {
  const rawPts = Array.isArray(o.points) ? o.points : null;
  let pts = (rawPts || []).map(readVec2).filter(Boolean);
  if (pts.length < 3) pts = DEFAULT_POINTS.map((p) => [p[0], p[1]]);
  const n = pts.length;

  const rawSeg = Array.isArray(o.segModes) ? o.segModes : [];
  const rawH = Array.isArray(o.handles) ? o.handles : [];
  const H = pts.map((_, i) => {
    const h = rawH[i];
    const inV = (Array.isArray(h) && readVec2(h[0])) || null;
    const outV = (Array.isArray(h) && readVec2(h[1])) || null;
    const a = autoHandle(pts, i);
    return [inV || [-a[0], -a[1]], outV || [a[0], a[1]]];
  });

  const smooth = clamp(Math.round(Number(o.smooth) || 48), 8, OUTLINE_MAX);
  const lens = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-4;
    lens.push(l); total += l;
  }

  const data = new Float32Array(OUTLINE_MAX * 2);
  let count = 0;
  for (let i = 0; i < n && count < smooth; i++) {
    let segN = Math.round((lens[i] / total) * smooth);
    if (i === n - 1) segN = smooth - count;
    segN = Math.max(1, segN);
    const a = pts[i], b = pts[(i + 1) % n];
    const straight = rawSeg[i] === 'line';
    for (let k = 0; k < segN && count < smooth; k++) {
      const t = k / segN;
      let px, py;
      if (straight) {
        px = a[0] + (b[0] - a[0]) * t;
        py = a[1] + (b[1] - a[1]) * t;
      } else {
        const c1x = a[0] + H[i][1][0], c1y = a[1] + H[i][1][1];
        const c2x = b[0] + H[(i + 1) % n][0][0], c2y = b[1] + H[(i + 1) % n][0][1];
        const u = 1 - t;
        px = u * u * u * a[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * b[0];
        py = u * u * u * a[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * b[1];
      }
      data[count * 2] = px;
      data[count * 2 + 1] = py;
      count++;
    }
  }
  return { data, count: Math.max(3, count) };
}

/** 把采样结果写进材质 uniform（拖节点 / 改形状时逐帧调用，不重建材质） */
export function applyPortalOutline(mat, outline) {
  if (!mat || !mat.uniforms || !mat.uniforms.uPts || !outline) return;
  mat.uniforms.uPts.value.set(outline.data);
  mat.uniforms.uPtCount.value = outline.count;
}

/* ============================================================
   材质
   ============================================================ */

/** 1×1 全透明兜底贴图（未使用的 sampler 必须有绑定，否则部分驱动报错） */
let _fallback = null;
function fallbackTex() {
  if (_fallback) return _fallback;
  const d = new Uint8Array([0, 0, 0, 0]);
  _fallback = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
  _fallback.needsUpdate = true;
  return _fallback;
}

/** 有效视差图层（没选贴图的层直接跳过）
    depth = 深度倍率(0~1)：实际深度 = depth × 全局「视差深度(stud)」uDepthScale */
export function portalLayers(o) {
  const raw = Array.isArray(o.layers) ? o.layers : [];
  const out = [];
  for (const L of raw) {
    if (!L) continue;
    const tex = getTexture(L.tex);
    if (!tex) continue;
    out.push({
      tex,
      ox: Number(L.offsetX) || 0,
      oy: Number(L.offsetY) || 0,
      scale: Math.max(0.05, Number(L.scale) || 1),
      depth: clamp(Number(L.depth ?? 0.5), 0, 1),
      opacity: clamp(Number(L.opacity ?? 1), 0, 1),
      blend: BLEND_INDEX[L.blend] || 0,
      tint: new THREE.Color(L.tint || '#ffffff'),
      tile: L.tile !== false,
      tileMode: TILE_INDEX[L.tileMode] || 0,
    });
    if (out.length >= PORTAL_MAX_LAYERS) break;
  }
  return out;
}

/** 材质重建判据：轮廓几何（points/handles/segModes/smooth）不进 key —— 那部分走 uniform */
export function portalKey(o) {
  const layers = portalLayers(o).map((L) => [
    L.tex.uuid, L.ox.toFixed(3), L.oy.toFixed(3), L.scale.toFixed(3),
    L.depth.toFixed(3), L.opacity.toFixed(3), L.blend, L.tint.getHexString(),
    (L.tile ? 1 : 0) + ':' + L.tileMode,
  ].join(',')).join(';');
  return [
    'ptl7', layers, o.depthScale ?? 1,
    o.innerColor || '#0a0a12', o.innerAlpha ?? 1,
    o.frame || 'standard', o.frameColor || '#9de8ff', o.frameColor2 || '#6a3dff',
    o.frameWidth ?? 0.035, o.frameGlow ?? 1, o.frameIntensity ?? 1,
    o.frameSpeed ?? 1, o.edgeSoft ?? 0.006, o.innerGlow ?? 0.25,
    o.lightInfluence ?? 1,
  ].join('|');
}

const PORTAL_VERT = `
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* 传送门着色核心：uniform 声明 + 轮廓 SDF + 图层采样 + 视差窗口函数。
   独立传送门材质（本文件）与「液体在水面渲染传送门」（core/materials.js 注入）共用这份代码。
   整块都是全局作用域声明（uniform / 函数），可以直接拼进任何片元着色器头部。 */
export const PORTAL_CORE_GLSL = `
  uniform vec2 uPts[64];
  uniform float uPtCount;
  uniform vec3 uCamLocal;
  uniform vec3 uCamDirLocal;    // 相机朝向（对象局部空间，单位向量）：转头也参与视差
  uniform float uUnitZ;         // |scale.z|：局部 z 长度 = 多少 stud
  uniform float uUnitXY;        // 平面内：1 局部单位 = 多少 stud
  uniform sampler2D uT0;
  uniform sampler2D uT1;
  uniform sampler2D uT2;
  uniform sampler2D uT3;
  uniform sampler2D uT4;
  uniform sampler2D uT5;
  uniform vec4 uLayA[6];     // x=偏移X y=偏移Y z=缩放 w=深度倍率(0~1，实际深度 = w × uDepthScale)
  uniform vec4 uLayB[6];     // x=不透明度 y=混合模式 z=预留(1) w=平铺编码(0=不平铺, 1+模式)
  uniform vec3 uLayTint[6];
  uniform float uLayers;
  uniform float uDepthScale;
  uniform vec3 uInnerColor;
  uniform float uInnerAlpha;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p) {
    vec2 q = p;
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * vnoise(q); q *= 2.03; a *= 0.5; }
    return s;
  }

  /* 闭合多边形有向距离（负=内部），带回绕数符号 */
  float sdOutline(vec2 p) {
    float d = dot(p - uPts[0], p - uPts[0]);
    float s = 1.0;
    for (int i = 0; i < 64; i++) {
      if (float(i) < uPtCount) {
        int j = int(mod(float(i) + 1.0, uPtCount));
        vec2 a = uPts[i];
        vec2 b = uPts[j];
        vec2 e = b - a;
        vec2 w = p - a;
        vec2 bq = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-9), 0.0, 1.0);
        d = min(d, dot(bq, bq));
        bvec3 c = bvec3(p.y >= a.y, p.y < b.y, e.x * w.y > e.y * w.x);
        if (all(c) || all(not(c))) s = -s;
      }
    }
    return s * sqrt(d);
  }

  /* 6 个独立 sampler（本项目不使用 sampler 数组，规避驱动兼容风险） */
  vec4 portalSample(float fi, vec2 uv) {
    int i = int(fi + 0.5);
    if (i <= 0) return texture2D(uT0, uv);
    if (i == 1) return texture2D(uT1, uv);
    if (i == 2) return texture2D(uT2, uv);
    if (i == 3) return texture2D(uT3, uv);
    if (i == 4) return texture2D(uT4, uv);
    return texture2D(uT5, uv);
  }

  /* 平铺：0 = 不平铺（只画一次，边界外透明），1+模式 = repeat/mirror/clamp */
  vec4 layerSample(float fi, vec2 uv, float tileCode) {
    if (tileCode < 0.5) {
      vec2 c = clamp(uv, 0.0, 1.0);
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      return portalSample(fi, c) * inside;
    }
    float mode = tileCode - 1.0;
    if (mode < 0.5) return portalSample(fi, fract(uv));
    if (mode < 1.5) return portalSample(fi, abs(fract(uv * 0.5 - 0.5) - 0.5) * 2.0);
    return portalSample(fi, clamp(uv, 0.0, 1.0));
  }

  /** 视差窗口：p = 片元在传送门局部平面上的坐标（[-0.5, 0.5]²），tear = 故障撕裂偏移。
      返回视差图层的颜色与不透明度（逐层按各自混合方式叠在内层底色上）。
      独立传送门材质与「液体在水面渲染传送门」共用这一个函数。 */
  vec4 ptlWindow(vec2 p, vec2 tear) {
    // ---- 视差 ----
    // 每层真实深度 kd = 深度倍率 × 视差深度(stud)，缩放与位移全部由它决定，没有额外强度系数。
    // camZ 取绝对值：相机穿过传送门平面时视差不会突然翻转、也不会发散。
    float camZ = max(abs(uCamLocal.z), 0.05);       // 相机到平面的距离（局部单位）
    float camZStud = camZ * max(uUnitZ, 1e-3);      // 同上，换算成 stud
    float uxy = max(uUnitXY, 1e-3);                 // 平面内：1 局部单位 = 多少 stud
    // 视线与传送门平面的交点（平面局部 xy 单位）= 屏幕中心指着的那一点。
    // 视差的**不动点**取它：景深缩放看上去是朝注视点收缩；
    // 图像位置本身仍由相机位置决定（前进 / 平移照常按透视错位，不会被注视点拖跑）。
    float dzs = uCamDirLocal.z;
    dzs = abs(dzs) < 0.30 ? (dzs < 0.0 ? -0.30 : 0.30) : dzs;
    vec2 pLook = uCamLocal.xy - uCamDirLocal.xy * (uCamLocal.z / dzs) * (max(uUnitZ, 1e-3) / uxy);

    vec3 col = uInnerColor;
    float alpha = uInnerAlpha;
    for (int i = 0; i < 6; i++) {
      if (float(i) < uLayers) {
        vec4 A = uLayA[i];
        vec4 B = uLayB[i];
        float sc = max(A.z, 0.02);
        float kd = A.w * uDepthScale;               // 该层真实深度(stud) —— 视差强度的唯一来源
        // s = 相对大小：图层等价于贴在「相机前方 camZ + 深度」处的一幅画面，于是
        //     · 越深 → 越小（越远），贴图随之变密；
        //     · 相机越近 → 相对传送门平面越小（框在屏幕上变大，框内世界反而缩）；
        //       相机越远 → s → 1，逐渐与传送门平面 1:1；
        //     · 屏幕上的大小 ∝ 1/(camZ+kd)：深的层几乎不随相机移动改变观感大小。
        float s = camZStud / (camZStud + kd);
        // 景深缩放：以 pLook 为不动点，采样范围放大 1/s 倍 → 画面朝注视点缩小 s 倍
        // （kd = 0 时 s = 1，与平面完全 1:1）。
        // 位移与缩放由同一式给出：屏幕上的移动幅度 = s × 窗口自身的移动 ——
        // 越深（s 越小）动得越少，深处的图层像「钉在世界里」的远景。
        float zk = 1.0 / s;
        vec2 par = (zk - 1.0) * (p - pLook) * B.z;
        vec2 uv = (p + vec2(A.x, A.y)) / sc + 0.5 + par / sc + tear;
        vec4 sm = layerSample(float(i), uv, B.w);
        vec3 c = sm.rgb * uLayTint[i];
        float a = clamp(sm.a * B.x, 0.0, 1.0);
        if (B.y < 0.5) {
          col = mix(col, c, a);
          alpha = mix(alpha, 1.0, a);
        } else if (B.y < 1.5) {
          col += c * a;
          alpha = min(1.0, alpha + a);
        } else if (B.y < 2.5) {
          col = mix(col, col * c, a);
          alpha = max(alpha, a);
        } else {
          col = mix(col, 1.0 - (1.0 - col) * (1.0 - c), a);
          alpha = max(alpha, a);
        }
      }
    }
    return vec4(col, alpha);
  }
`;
/* 独立传送门片元着色器 = 核心 + 外框 / 内沿辉光 / 故障撕裂 */
const PORTAL_FRAG = PORTAL_CORE_GLSL + `
  uniform float uTime;
  uniform vec3 uFrameColor;
  uniform vec3 uFrameColor2;
  uniform float uFrameWidth;
  uniform float uFrameGlow;
  uniform float uFrameIntensity;
  uniform float uFrameSpeed;
  uniform float uFrameMode;
  uniform float uEdgeSoft;
  uniform float uInnerGlow;
  varying vec2 vLocal;

  void main() {
    vec2 p = vLocal;
    float sd = sdOutline(p);
    float t = uTime * uFrameSpeed;
    float fw = max(uFrameWidth, 0.0015);
    float m = 1.0 - smoothstep(-uEdgeSoft, uEdgeSoft, sd);   // 内部遮罩
    /* 内对齐外框：整条框完全落在轮廓内侧，不会越过平面边界被裁掉。
       di = 轮廓内侧深度（轮廓上为 0，越往里越大）；outAA 负责外沿 1px 抗锯齿。
       aa 用屏幕空间导数，所以不论传送门多大 / 离相机多近，框线始终是清晰的 1px 级过渡。 */
    float aa = max(fwidth(sd), 1e-5) * 1.1;
    float di = max(-sd, 0.0);
    float outAA = 1.0 - smoothstep(0.0, aa, sd);

    // 故障样式：整块内部按行横向撕裂
    vec2 tear = vec2(0.0);
    if (uFrameMode > 2.5 && uFrameMode < 3.5) {
      float row = floor(p.y * 34.0);
      float hb = hash21(vec2(row, floor(t * 9.0)));
      tear.x = (hb - 0.5) * 0.09 * step(0.68, hb);
    }

    vec4 win = ptlWindow(p, tear);
    vec3 col = win.rgb;
    float alpha = win.a;

    // ---- 内部边缘光 ----
    col += uFrameColor * (m * (1.0 - smoothstep(0.0, fw * 3.5, di))) * uInnerGlow;

    // ---- 轮廓装饰：5 种外框样式 ----
    vec3 fcol = uFrameColor;
    float amt = 0.0;
    float halo = 0.0;
    if (uFrameMode > 3.5) {
      // 裂缝：边缘被噪声撕开，带尖锐的裂缝尖刺
      float n = fbm(p * (4.2 / fw) + 3.7) - 0.5;
      float dd = abs(di + n * fw * 1.1);
      float b2 = 1.0 - smoothstep(fw * 0.45, fw * 0.9, dd);
      float spike = pow(clamp(1.0 - di / (fw * 1.6), 0.0, 1.0), 8.0);
      amt = outAA * (b2 * (0.55 + 0.9 * (0.5 - n)) + spike * 0.6);
      fcol = mix(uFrameColor2, uFrameColor, clamp(0.5 - n * 1.8, 0.0, 1.0));
    } else if (uFrameMode > 2.5) {
      // 故障：按行随机错位 + 亮度闪烁
      float row = floor(p.y * 34.0);
      float hb = hash21(vec2(row, floor(t * 9.0)));
      float shift = (hb - 0.5) * fw * 2.4 * step(0.62, hb);
      float dd = abs(di + shift);
      amt = outAA * (1.0 - smoothstep(fw * 0.45, fw + aa, dd))
        * (0.6 + 0.7 * hash21(vec2(row, floor(t * 17.0))));
      fcol = mix(uFrameColor, uFrameColor2, step(0.5, hb));
    } else if (uFrameMode > 1.5) {
      // 液态流动：轮廓内沿被噪声扰动，颜色沿轮廓流动
      float wob = fbm(p * (2.6 / fw) + vec2(t * 0.7, -t * 0.5)) - 0.5;
      float dd = max(di - wob * fw * 0.7, 0.0);
      float b2 = 1.0 - smoothstep(fw * 0.35, fw * 1.1 + aa, dd);
      float flow = fbm(vec2(p.x * 5.0 + p.y * 1.7 + t * 1.6, p.y * 4.0 - t * 1.2));
      amt = outAA * b2 * (0.45 + 0.85 * flow);
      fcol = mix(uFrameColor2, uFrameColor, clamp(flow * 1.5, 0.0, 1.0));
    } else if (uFrameMode > 0.5) {
      amt = outAA * (1.0 - smoothstep(fw - aa, fw + aa, di));
    }
    if (uFrameMode > 0.5) {
      halo = (1.0 - smoothstep(0.0, fw * 4.5, di)) * outAA * 0.22 * uFrameGlow;
    }
    float glow = clamp((amt + halo) * uFrameIntensity, 0.0, 3.0);

    vec3 outCol = col + fcol * glow;
    float outA = max(alpha * m, clamp(glow, 0.0, 1.0) * 0.95);
    if (outA <= 0.003) discard;
    gl_FragColor = vec4(outCol, outA);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ============================================================
   液体子集：由「父级液体」在自己的水面上渲染传送门
   ------------------------------------------------------------
   传送门挂在液体对象下时，本体不再渲染（它的 mesh 只是一块用于拾取 /
   轮廓节点编辑的隐形占位片），窗口改由液体材质在**朝上的液面**上画出来：
   液体正常跑完自己的水渲染（LIQ_FRAG_BODY）之后，把片元换算到传送门局部
   空间，落在外框轮廓里就叠上视差图层，轮廓外侧再压一圈沿岸水沫。
   ============================================================ */

/** 水面渲染所需的额外 uniform（全局作用域声明） */
export const PORTAL_SURFACE_HEAD_GLSL = `
  uniform mat4 uPtW2L;      // 世界（镜像空间）→ 传送门局部，含缩放
  uniform float uPtEdge;    // 窗口边缘抗锯齿宽度（轮廓局部单位）
  uniform float uPtFoamW;   // 窗口沿岸水沫宽度(stud)，0 = 关闭
  uniform float uPtFoamA;   // 水沫不透明度
  uniform vec3 uPtFoamColor;
`;

/** 注入到液体片元着色器（必须排在 LIQ_FRAG_BODY 之后） */
export const PORTAL_SURFACE_GLSL = `
  {
    // 边缘抗锯齿宽度：把屏幕足迹换算成轮廓局部单位，这样传送门无论大小 / 远近，
    // 窗口边缘都是 1px 级的过渡（导数必须在统一控制流里取，所以写在 if 之外）
    float ptlPx = max(fwidth(vLiqWP.x), fwidth(vLiqWP.z)) / max(uUnitXY, 1e-3);
    float ptlAA = max(uPtEdge, ptlPx * 0.8);
    // lqUpFace 由 LIQ_FRAG_BODY 在同一作用域里算好：只有朝上的液面才承载窗口
    if (lqUpFace > 0.004) {
      // 片元（世界坐标）→ 传送门局部：lp.xy 就是轮廓所在平面内的坐标
      vec3 lp = (uPtW2L * vec4(vLiqWP, 1.0)).xyz;
      // 沿岸水沫：窗口轮廓外侧一小圈。宽度按 stud 给定，这里换算成轮廓局部单位，
      // 于是传送门缩放变化时泡沫宽度始终是真实尺寸（和围边泡沫同一套参数）。
      float q = max(uPtFoamW / max(uUnitXY, 1e-3), 0.0015);
      // 便宜的外接方框剔除：轮廓点都在 [-0.5, 0.5]² 内（留一点余量给自由曲线与泡沫），
      // 水面上绝大多数片元都落在窗口外，直接跳过 64 段 SDF 循环
      if (max(abs(lp.x), abs(lp.y)) < 0.5 + q + ptlAA + 0.25) {
        float sd = sdOutline(lp.xy);
        float ins = 1.0 - smoothstep(-ptlAA, ptlAA, sd);
        if (uPtFoamW > 0.001 && uPtFoamA > 0.004) {
          float fn = fbm(lp.xy * (3.4 / q) + 11.3);
          float foam = (1.0 - smoothstep(q * 0.15, q * (0.55 + 0.85 * fn), max(sd, 0.0))) * (1.0 - ins);
          diffuseColor.rgb = mix(diffuseColor.rgb, uPtFoamColor, foam * lqUpFace * uPtFoamA);
        }
        if (ins > 0.004) {
          vec4 win = ptlWindow(lp.xy, vec2(0.0));
          float k = ins * lqUpFace * clamp(win.a, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, win.rgb, k);
        }
      }
    }
  }
`;

/** 水面渲染所需的额外 uniform（每个液体子集传送门一份，由 builder 逐帧写） */
export function makePortalSurfaceUniforms(o) {
  return {
    uPtW2L: { value: new THREE.Matrix4() },
    uPtEdge: { value: clamp(Number(o.edgeSoft ?? 0.006), 0.0005, 0.05) },
    uPtFoamW: { value: 0 },
    uPtFoamA: { value: 0 },
    uPtFoamColor: { value: new THREE.Color(1, 1, 1) },
  };
}

/**
 * 传送门着色 uniform（独立材质 与「液体在水面渲染传送门」共用同一份对象：
 * 相机相关的 uniform 由 builder 逐帧写进这些对象，两边的着色器看到的是同一份数据）
 */
export function makePortalUniforms(o) {
  const layers = portalLayers(o);
  // 视差在**对象局部空间**里做：每层深度以真实 stud 传入（kd = 深度倍率 × 视差深度），
  // 相机到平面的距离换算成同一单位 camZStud = camZ * uUnitZ，
  // 由相对大小 s = camZStud/(camZStud+kd) 推出采样缩放 1/s，
  // 并以「视线与传送门平面的交点」为不动点施加 —— 缩放与位移一体，观感符合透视。
  const sx = Math.abs(Number(o.scale?.[0]) || 1), sy = Math.abs(Number(o.scale?.[1]) || 1);
  const sz = Math.abs(Number(o.scale?.[2]) || 1) || 1;
  const layA = [], layB = [], layTint = [];
  for (let i = 0; i < PORTAL_MAX_LAYERS; i++) {
    const L = layers[i];
    // w = 该层深度倍率(0~1)
    layA.push(new THREE.Vector4(L ? L.ox : 0, L ? L.oy : 0, L ? L.scale : 1, L ? L.depth : 0));
    // w = 平铺编码：0 = 不平铺；1+模式 = repeat(1) / mirror(2) / clamp(3)
    const tileCode = L && L.tile ? 1 + L.tileMode : 0;
    layB.push(new THREE.Vector4(L ? L.opacity : 0, L ? L.blend : 0, 1, tileCode));
    layTint.push(L ? L.tint : new THREE.Color(1, 1, 1));
  }
  const fb = fallbackTex();
  const tex = (i) => ({ value: layers[i] ? layers[i].tex : fb });
  return {
    uPts: { value: new Float32Array(OUTLINE_MAX * 2) },
    uPtCount: { value: 3 },
    uCamLocal: { value: new THREE.Vector3(0, 0, 1) },
    uCamDirLocal: { value: new THREE.Vector3(0, 0, -1) },
    uUnitZ: { value: sz },
    uUnitXY: { value: Math.max(0.01, (sx + sy) * 0.5) },
    uT0: tex(0), uT1: tex(1), uT2: tex(2), uT3: tex(3), uT4: tex(4), uT5: tex(5),
    uLayA: { value: layA },
    uLayB: { value: layB },
    uLayTint: { value: layTint },
    uLayers: { value: layers.length },
    uDepthScale: { value: clamp(Number(o.depthScale ?? 60), 0, PORTAL_DEPTH_MAX) },
    uInnerColor: { value: new THREE.Color(o.innerColor || '#0a0a12') },
    uInnerAlpha: { value: clamp(Number(o.innerAlpha ?? 1), 0, 1) },
  };
}

/**
 * 传送门材质（独立窗口形态）：每个对象独享，由 builder 在销毁时 dispose（rec.ownMaterial = true）。
 * 挂在液体下时不会用到它 —— 那种情况由液体材质在水面上渲染（见 core/materials.js）。
 */
export function getPortalMaterial(o) {
  const li = lightInfluenceUniform(o.lightInfluence);
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(makePortalUniforms(o), {
      uTime: PORTAL_UNIFORMS.time,
      uLightInf: li,                    // 光照影响（受曝光补偿 / 画面染色 / 光照的比例）
      uFrameColor: { value: new THREE.Color(o.frameColor || '#9de8ff') },
      uFrameColor2: { value: new THREE.Color(o.frameColor2 || '#6a3dff') },
      uFrameWidth: { value: clamp(Number(o.frameWidth ?? 0.035), 0.001, 0.5) },
      uFrameGlow: { value: clamp(Number(o.frameGlow ?? 1), 0, 4) },
      uFrameIntensity: { value: clamp(Number(o.frameIntensity ?? 1), 0, 4) },
      uFrameSpeed: { value: clamp(Number(o.frameSpeed ?? 1), 0, 8) },
      uFrameMode: { value: FRAME_MODE[o.frame] || 0 },
      uEdgeSoft: { value: clamp(Number(o.edgeSoft ?? 0.006), 0.0005, 0.05) },
      uInnerGlow: { value: clamp(Number(o.innerGlow ?? 0.25), 0, 2) },
    }),
    vertexShader: PORTAL_VERT,
    fragmentShader: PORTAL_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  mat.userData.selfDrawn = true;
  // 自绘材质必须给程序缓存 key 一个稳定值，否则每次重建材质都会重新编译着色器
  mat.customProgramCacheKey = () => 'portal-v7';
  applyScreenGrade(mat, li);   // 画面处理：饱和度 / 染色 + 光照影响
  return mat;
}
