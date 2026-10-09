/* ============================================================
   粒子预设：内置粒子图像(20) + 扭曲/蒙版动画(20)
   ------------------------------------------------------------
   · 纯数据模块，不 import 任何东西（贴图绘制见 core/textures.js，
     着色器实现见 world/fx.js）——三处（贴图 / 着色器 / 编辑器 UI）
     必须共用这里的顺序，索引即协议：
       图像索引 = PARTICLE_BUILTINS 的下标
       动画索引 = PARTICLE_ANIMS 的下标（0 = 原样不变形）
   · 一个「粒子条目」= { img, anim, weight, on }：
       img    内置图像 id（'pb/spark'…）或导入素材引用（'asset:…'）
       anim   扭曲/蒙版动画下标
       weight 抽取权重（同一次发射的粒子按权重从各条目里随机挑）
   ============================================================ */

/** 内置粒子图像（白色 + alpha，便于被发射器颜色任意染色） */
export const PARTICLE_BUILTINS = [
  { v: 'pb/glow',     l: '光晕' },
  { v: 'pb/spark',    l: '火花' },
  { v: 'pb/star',     l: '星形' },
  { v: 'pb/dot',      l: '圆点' },
  { v: 'pb/ring',     l: '圆环' },
  { v: 'pb/cross',    l: '十字光' },
  { v: 'pb/smoke',    l: '烟团' },
  { v: 'pb/cloud',    l: '云朵' },
  { v: 'pb/bubble',   l: '泡泡' },
  { v: 'pb/droplet',  l: '水滴' },
  { v: 'pb/flame',    l: '火焰' },
  { v: 'pb/ember',    l: '火屑' },
  { v: 'pb/leaf',     l: '叶片' },
  { v: 'pb/petal',    l: '花瓣' },
  { v: 'pb/snow',     l: '雪花' },
  { v: 'pb/hex',      l: '六边形' },
  { v: 'pb/square',   l: '方块' },
  { v: 'pb/triangle', l: '三角' },
  { v: 'pb/note',     l: '音符' },
  { v: 'pb/rune',     l: '符文' },
];

/** 扭曲 / 蒙版动画（下标 = 着色器里的动画编号，0 为原样） */
export const PARTICLE_ANIMS = [
  { v: 0,  id: 'none',       l: '无（原样）' },
  { v: 1,  id: 'rotate',     l: '旋转' },
  { v: 2,  id: 'pulse',      l: '脉动' },
  { v: 3,  id: 'heartbeat',  l: '心跳' },
  { v: 4,  id: 'wave',       l: '波动' },
  { v: 5,  id: 'swirl',      l: '漩涡' },
  { v: 6,  id: 'ripple',     l: '涟漪' },
  { v: 7,  id: 'dissolve',   l: '噪声溶解' },
  { v: 8,  id: 'erode',      l: '边缘腐蚀' },
  { v: 9,  id: 'turbulence', l: '湍流' },
  { v: 10, id: 'pixelate',   l: '像素化' },
  { v: 11, id: 'scanline',   l: '扫描线' },
  { v: 12, id: 'checker',    l: '棋盘遮罩' },
  { v: 13, id: 'stripes',    l: '条纹遮罩' },
  { v: 14, id: 'radialWipe', l: '径向擦除' },
  { v: 15, id: 'vWipe',      l: '上下溶解' },
  { v: 16, id: 'halftone',   l: '网点' },
  { v: 17, id: 'linearWipe', l: '线性擦除' },
  { v: 18, id: 'glitch',     l: '故障抖动' },
  { v: 19, id: 'strobe',     l: '闪频' },
];

export const PARTICLE_ANIM_COUNT = PARTICLE_ANIMS.length;

const _imgById = new Map(PARTICLE_BUILTINS.map((x) => [x.v, x]));
const _animById = new Map(PARTICLE_ANIMS.map((x) => [x.v, x]));

/** 内置粒子图像是否有效 */
export function isBuiltinParticle(id) { return _imgById.has(String(id || '')); }
/** 内置粒子图像的可读名（非内置 → null） */
export function particleImageLabel(id) {
  const m = _imgById.get(String(id || ''));
  return m ? m.l : null;
}
/** 动画的可读名（越界 → '无（原样）'） */
export function particleAnimLabel(i) {
  const m = _animById.get(Number(i) | 0);
  return m ? m.l : PARTICLE_ANIMS[0].l;
}

/** 新建一个默认粒子条目 */
export function newParticleEntry(img = 'pb/glow', anim = 0) {
  return { img, anim: Number(anim) | 0, weight: 1, on: true };
}

/** 条目的简短摘要（列表里显示用） */
export function particleEntrySummary(e) {
  if (!e) return '';
  const img = particleImageLabel(e.img) || e.img || '（空）';
  const anim = particleAnimLabel(e.anim);
  const w = Number(e.weight);
  const wt = isFinite(w) && w !== 1 ? ' · 权重 ' + (Math.round(w * 100) / 100) : '';
  return img + ' · ' + anim + wt;
}

/** 约束 / 规范化一个条目的取值（容错旧存档） */
export function normalizeParticleEntry(e) {
  if (!e || typeof e !== 'object') return newParticleEntry();
  const anim = Number(e.anim);
  return {
    img: typeof e.img === 'string' ? e.img : 'pb/glow',
    anim: isFinite(anim) ? Math.max(0, Math.min(PARTICLE_ANIM_COUNT - 1, Math.round(anim))) : 0,
    weight: isFinite(Number(e.weight)) ? Math.max(0, Number(e.weight)) : 1,
    on: e.on !== false,
  };
}