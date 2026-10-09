/* ============================================================
   世界优先管线 · 零件（描述层）
   ------------------------------------------------------------
   与既有引擎对象约定一致：{ type, over }，交给 normalizeObject 补默认值。
   平台 / 方块一律 mesh（默认包围盒碰撞）——**绝不能用 NO_PHYSICS 里的类型
   当站立面**，否则跳跃检测器会直接跳过它。
   ============================================================ */
import { round, clamp, mixHex } from '../../core/util.js';
import { PLAT_T } from '../limits.js';
import { MAT } from './whitebox.js';

/** 平台描述（topY = 顶面高度） */
export function platformDesc(idGen, theme, x, topY, z, w, d, over = {}) {
  if (typeof idGen !== 'function') throw new Error('gen: idGen 缺失');
  return {
    type: 'mesh',
    over: {
      id: idGen('pl'),
      shape: 'block',
      position: [round(x, 3), round(topY - PLAT_T / 2, 3), round(z, 3)],
      scale: [round(w, 3), PLAT_T, round(d, 3)],
      color: (theme && theme.plat) || '#8a86b8',
      texture: 'grid',
      textureSize: Math.max(1, Math.round(Math.max(w, d) / 8)),
      roughness: 0.72,
      metalness: 0.05,
      bakeAO: false,
      ...over,
    },
  };
}

/** 世界体块（白模 / 演化产物）→ mesh */
export function worldBlockDesc(idGen, box, bandTheme, styleDef) {
  const mat = box.mat;
  const rocky = !!(styleDef && styleDef.rocky);
  return {
    type: 'mesh',
    over: {
      id: idGen('wb'),
      shape: 'block',
      position: [box.x, box.y, box.z],
      scale: [box.sx, box.sy, box.sz],
      color: matColor(bandTheme, mat, rocky),
      texture: (styleDef && styleDef.texture) || 'tiles',
      textureSize: clamp(Math.round(Math.max(box.sx, box.sz) / 16), 1, 64),
      roughness: (styleDef && styleDef.rough) || 0.8,
      metalness: (styleDef && styleDef.metal) || 0.05,
      // ★ 关掉顶点 AO：白模方块大又多，AO 会把几何细分到 16 段并逐顶点打射线，
      //   进关 / 编辑器重建开销极大，而大平面几乎收不到 AO 收益
      bakeAO: false,
    },
  };
}

/** 体块材质 → 颜色（按所在带的主题配色分层） */
export function matColor(bandTheme, mat, rocky) {
  const t = bandTheme || {};
  const wall = t.wall || '#3b3559';
  const plat = t.plat || '#8a86b8';
  const alt = t.platAlt || '#b9a7ff';
  const ceil = t.ceil || '#2a2740';
  const accent = t.accent || '#8fd6ff';
  switch (mat) {
    case MAT.col: return mixHex(wall, '#ffffff', 0.10);
    case MAT.slab: return mixHex(plat, wall, 0.35);
    case MAT.roof: return ceil;
    case MAT.block: return rocky ? mixHex(wall, '#000000', 0.18) : mixHex(alt, wall, 0.3);
    case MAT.ledge: return mixHex(alt, accent, 0.35);
    default: return wall;
  }
}

/** 位置 / 尺寸都健康才放行（防止 NaN 一路传到关卡 JSON） */
export function sane(position, scale) {
  return position.every(Number.isFinite) && (scale || []).every((v) => Number.isFinite(v));
}

export { PLAT_T };