/* ============================================================
   天空修饰器（Sky Modifier）
   ------------------------------------------------------------
   · 一串可叠加的修饰器，作用在「天空盒背景采样」上（scene.background）
   · 分两类：
       geo   几何变形 —— 改采样方向（无缝：连续映射，两极不撕裂）
       color 色彩 / 曝光 —— 改采样结果（乘加 / 曲线 / 色相，都在线性空间）
   · 只作用于背景，不影响环境反射（PMREM）与物理光照
   · 数据契约：level.settings.skyMods = [{ type, on, p:{...} }, ...]
     旧存档的 skyPitch / skyWarp 由 migrateLegacySky() 迁移成对应修饰器
   ============================================================ */

/** 着色器里固定展开的槽位数（超出的修饰器不生效） */
export const SKYMOD_MAX = 8;

export const SKYMOD_GROUPS = [
  { v: 'geo', l: '几何变形' },
  { v: 'color', l: '色彩 / 曝光' },
];

/**
 * 修饰器目录。
 * kind 是写进着色器、用来分支的整数（几何 1..99，色彩 101..199），
 * p 是参数表：t = 'num' | 'int' | 'color'，d 为默认值。
 * 参数按声明顺序写进着色器槽的 A.y, A.z, A.w, B.x, B.y, B.z。
 */
export const SKYMOD_TYPES = [
  /* ---------------- 几何变形（改采样方向） ---------------- */
  {
    v: 'vshift', l: '垂直平移（地面升降）', g: 'geo', kind: 1,
    h: '绕相机水平轴俯仰：画面整体上下平移（地面升降），横线保持笔直、不滚转、无接缝',
    p: [{ k: 'offset', l: '高度(°)', t: 'num', d: 12, min: -45, max: 45, st: 0.5 }],
  },
  {
    v: 'perspective', l: '透视扭曲', g: 'geo', kind: 2,
    h: '等距柱状纬度上的透视映射：地平线附近位移最大，两极其不变形',
    p: [{ k: 'k', l: '强度', t: 'num', d: 0.35, min: -0.9, max: 0.9, st: 0.01 }],
  },
  {
    v: 'zoom', l: '视觉放大 / 缩小', g: 'geo', kind: 3,
    h: '以地平线为基准的垂直方向透视缩放：>1 拉近放大，<1 推远缩小；两极固定且平滑，无削平的极点',
    p: [{ k: 'z', l: '倍率', t: 'num', d: 1.4, min: 0.2, max: 4, st: 0.05 }],
  },
  {
    v: 'barrel', l: '桶形 / 枕形畸变', g: 'geo', kind: 4,
    h: '纬度方向径向畸变：正值枕形、负值桶形；赤道不动、无接缝',
    p: [{ k: 'k', l: '强度', t: 'num', d: 0.3, min: -1.5, max: 1.5, st: 0.01 }],
  },
  {
    v: 'twist', l: '螺旋扭转', g: 'geo', kind: 5,
    h: '经度随纬度扭转：极地螺旋，无接缝',
    p: [{ k: 'k', l: '强度', t: 'num', d: 0.5, min: -3, max: 3, st: 0.05 }],
  },
  {
    v: 'spin', l: '水平旋转（罗盘）', g: 'geo', kind: 6,
    h: '绕世界纵轴旋转天空：左右接缝自然闭合',
    p: [{ k: 'deg', l: '角度(°)', t: 'num', d: 20, min: -180, max: 180, st: 1 }],
  },
  {
    v: 'dome', l: '穹顶压缩 / 展开', g: 'geo', kind: 7,
    h: '两极固定的幂律纬度映射：<1 向地平线挤压，>1 向天顶拉伸',
    p: [{ k: 'e', l: '指数', t: 'num', d: 1.6, min: 0.2, max: 3, st: 0.05 }],
  },
  {
    v: 'wave', l: '波浪摇曳', g: 'geo', kind: 8,
    h: '经度方向的周期起伏：有机波浪；频率取整以保证左右接缝连续',
    p: [
      { k: 'amp', l: '幅度(°)', t: 'num', d: 6, min: 0, max: 40, st: 0.5 },
      { k: 'freq', l: '频率', t: 'int', d: 3, min: 1, max: 12, st: 1 },
      { k: 'phase', l: '相位(°)', t: 'num', d: 0, min: -180, max: 180, st: 5 },
    ],
  },
  /* ---------------- 色彩 / 曝光（改采样结果） ---------------- */
  {
    v: 'exposure', l: '曝光度', g: 'color', kind: 101,
    h: '整体曝光（线性空间乘性，等效 EV：+1 ≈ 亮一倍）',
    p: [{ k: 'ev', l: 'EV', t: 'num', d: 0.5, min: -4, max: 4, st: 0.05 }],
  },
  {
    v: 'brightness', l: '亮度', g: 'color', kind: 102,
    h: '加减式亮度（不改变对比）',
    p: [{ k: 'amt', l: '亮度', t: 'num', d: 0.1, min: -1, max: 1, st: 0.01 }],
  },
  {
    v: 'contrast', l: '对比度', g: 'color', kind: 103,
    h: '以中灰(0.18)为中心的对比拉伸',
    p: [{ k: 'amt', l: '对比', t: 'num', d: 1.3, min: 0, max: 3, st: 0.02 }],
  },
  {
    v: 'saturation', l: '饱和度', g: 'color', kind: 104,
    h: '0 = 灰度，1 = 原样，>1 更艳',
    p: [{ k: 'amt', l: '饱和', t: 'num', d: 1.3, min: 0, max: 3, st: 0.02 }],
  },
  {
    v: 'hue', l: '色相旋转', g: 'color', kind: 105,
    h: '整体色相偏移（YIQ 旋转，保持亮度）',
    p: [{ k: 'deg', l: '角度(°)', t: 'num', d: 20, min: -180, max: 180, st: 1 }],
  },
  {
    v: 'temperature', l: '色温 / 色调', g: 'color', kind: 106,
    h: '正值偏暖（橙红），负值偏冷（青蓝）',
    p: [{ k: 'amt', l: '冷暖', t: 'num', d: 0.2, min: -1, max: 1, st: 0.02 }],
  },
  {
    v: 'gamma', l: '伽马曲线', g: 'color', kind: 107,
    h: '幂律曲线：>1 整体变暗、<1 整体变亮',
    p: [{ k: 'g', l: '伽马', t: 'num', d: 1.2, min: 0.2, max: 3, st: 0.02 }],
  },
  {
    v: 'colorize', l: '染色', g: 'color', kind: 108,
    h: '按亮度向指定颜色着色，强度可调',
    p: [
      { k: 'color', l: '颜色', t: 'color', d: '#4a6cff' },
      { k: 'amt', l: '强度', t: 'num', d: 0.4, min: 0, max: 1, st: 0.02 },
    ],
  },
  {
    v: 'grayscale', l: '灰度', g: 'color', kind: 109,
    h: '去色，保留亮度；强度可调',
    p: [{ k: 'amt', l: '强度', t: 'num', d: 1, min: 0, max: 1, st: 0.05 }],
  },
  {
    v: 'invert', l: '反相', g: 'color', kind: 110,
    h: '颜色反相；强度可调',
    p: [{ k: 'amt', l: '强度', t: 'num', d: 1, min: 0, max: 1, st: 0.05 }],
  },
];

export const SKYMOD_BY_ID = {};
for (const t of SKYMOD_TYPES) SKYMOD_BY_ID[t.v] = t;

/** 某类型的默认参数对象 */
export function defaultSkyModParams(type) {
  const t = SKYMOD_BY_ID[type];
  const p = {};
  if (t) for (const d of t.p) p[d.k] = d.d;
  return p;
}

/** 新建一个修饰器 */
export function newSkyMod(type) {
  return { type, on: true, p: defaultSkyModParams(type) };
}

/** 规范修饰器列表：丢弃未知类型、补齐 / 夹取参数、截断到 SKYMOD_MAX */
export function normalizeSkyMods(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const m of list) {
    if (!m || !SKYMOD_BY_ID[m.type]) continue;
    const t = SKYMOD_BY_ID[m.type];
    const p = {};
    for (const d of t.p) {
      const raw = m.p ? m.p[d.k] : undefined;
      if (d.t === 'color') { p[d.k] = typeof raw === 'string' ? raw : d.d; continue; }
      let v = Number(raw);
      if (!isFinite(v)) v = d.d;
      if (d.t === 'int') v = Math.round(v);
      if (d.min !== undefined) v = Math.max(d.min, v);
      if (d.max !== undefined) v = Math.min(d.max, v);
      p[d.k] = v;
    }
    out.push({ type: m.type, on: m.on !== false, p });
  }
  return out.slice(0, SKYMOD_MAX);
}

/** 旧存档迁移：settings.skyPitch / skyWarp → skyMods（就地修改 settings） */
export function migrateLegacySky(settings) {
  const S = settings || {};
  if (!Array.isArray(S.skyMods)) {
    S.skyMods = [];
    const p = Number(S.skyPitch) || 0;
    const w = Number(S.skyWarp) || 0;
    if (Math.abs(p) > 0.001) { const m = newSkyMod('vshift'); m.p.offset = p; S.skyMods.push(m); }
    if (Math.abs(w) > 0.001) { const m = newSkyMod('perspective'); m.p.k = w; S.skyMods.push(m); }
  } else {
    S.skyMods = normalizeSkyMods(S.skyMods);
  }
  delete S.skyPitch;
  delete S.skyWarp;
  return S.skyMods;
}

/** 一句话描述某个修饰器的当前参数（面板 / 列表用） */
export function skyModSummary(m) {
  const t = SKYMOD_BY_ID[m && m.type];
  if (!t) return '';
  const p = (m && m.p) || {};
  return t.p.map((d) => {
    const v = p[d.k];
    if (d.t === 'color') return v || d.d;
    const n = Number(v);
    return d.l + ' ' + (isFinite(n) ? (d.t === 'int' ? n : n.toFixed(2).replace(/\.?0+$/, '') || '0') : d.d);
  }).join(' · ');
}