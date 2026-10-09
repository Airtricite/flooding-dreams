/* ============================================================
   主题白模 · 大教堂中殿（cathedralNave）
   ------------------------------------------------------------
   主题身份词：中殿柱列、尖拱拱肋、侧廊、祭坛台阶、彩窗烛台。
   「大教堂」的几何主意 = **两排巨柱 + 跨过中殿的尖拱肋**：
     · 中殿两侧各一列**巨柱**，柱顶之间跨一道**尖拱肋**（弧线上升到顶点）
     · 柱列外侧是较低的**侧廊**（另一层可站走道）
     · 一端是层层抬高的**祭坛台阶**
   结构倾向（智能搭配）：室内 → 竖井 → 半封闭 → 露天 → 开阔（从圣坛走向天光）。
   ============================================================ */
import { MAT, plate, solid, column, pick2, clip, isFree } from './common.js';

export const style = 'building';
export const label = '大教堂中殿';
export const structures = ['shaft', 'indoor', 'sheltered', 'outdoor', 'openAir'];
export const depth = 0.75;

export function build(c) {
  const { g, reg: raw, band, rng } = c;
  // ★ 零散件配额（烛台 / 彩窗片 / 长椅）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 8) return;
  const along = rng.chance(0.5) ? 'x' : 'z';              // 中殿的长轴
  const a0 = along === 'x' ? reg.x0 : reg.z0;
  const a1 = along === 'x' ? reg.x1 : reg.z1;
  const b0 = along === 'x' ? reg.z0 : reg.x0;
  const b1 = along === 'x' ? reg.z1 : reg.x1;
  const bay = 4;                                          // 柱距（格）
  const colB = [b0 + 2, b1 - 2];                          // 两列巨柱的 b 位置
  const colTop = Math.min(y1 - 2, y0 + Math.max(5, Math.round(h * 0.62)));

  /* ---------- ① 巨柱列 + ② 尖拱肋：柱顶之间跨过中殿的弧线 ---------- */
  for (let a = a0 + 2; a <= a1 - 2; a += bay) {
    for (const bb of colB) {
      const x = along === 'x' ? a : bb;
      const z = along === 'x' ? bb : a;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      if (colTop > y0 + 3 && isFree(g, x, y0 + 1, z)) column(g, x, z, y0 + 1, colTop, MAT.col);
      // 柱头饰（一圈外凸）
      if (isFree(g, x, colTop, z)) plate(g, x, z, x, z, colTop, MAT.ledge);
    }
    /* 尖拱肋：从一列柱顶跨到另一列柱顶，中部抬高（尖拱） */
    const span = colB[1] - colB[0];
    const rise = Math.min(y1 - 2 - colTop, Math.max(2, Math.round(span * 0.5)));
    if (span >= 3 && rise >= 1) {
      for (let k = 0; k <= span; k++) {
        const bb = colB[0] + k;
        const t = k / span;
        const y = colTop + Math.round(Math.sin(t * Math.PI) * rise);       // 拱肋
        const x = along === 'x' ? a : bb;
        const z = along === 'x' ? bb : a;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        if (y >= y1 - 1) continue;
        if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.roof);
      }
    }
  }

  /* ---------- ③ 侧廊：柱列外侧抬一格的走道 ---------- */
  if (h >= 9) {
    for (const outer of [b0 + 1, b1 - 1]) {
      for (let a = a0 + 1; a <= a1 - 1; a++) {
        const x = along === 'x' ? a : outer;
        const z = along === 'x' ? outer : a;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        if (isFree(g, x, y0 + 1, z)) {
          plate(g, x, z, x, z, y0 + 1, MAT.slab);
          plate(g, x, z, x, z, y0, MAT.block);
        }
      }
    }
  }

  /* ---------- ④ 祭坛台阶：一端层层抬高的平台 ---------- */
  const tiers = Math.min(4, Math.max(2, Math.round(h / 4)));
  for (let t = 0; t < tiers; t++) {
    const aa = a1 - 2 - t;
    if (aa <= a0 + 1) break;
    const y = y0 + 1 + t;
    if (y + 5 > y1) break;
    for (let b = b0 + 1; b <= b1 - 1; b++) {
      const x = along === 'x' ? aa : b;
      const z = along === 'x' ? b : aa;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.slab);
      if (isFree(g, x, y - 1, z)) plate(g, x, z, x, z, y - 1, MAT.block);
    }
  }

  /* ---------- ⑤ 彩窗片：高侧墙上一格格的发光窗 ---------- */
  for (const bb of [b0 + 1, b1 - 1]) {
    for (let a = a0 + 3; a <= a1 - 3; a += bay) {
      const x = along === 'x' ? a : bb;
      const z = along === 'x' ? bb : a;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      if (!deco.spend()) break;
      const wy = Math.min(y1 - 2, colTop + 2);
      if (isFree(g, x, wy, z)) plate(g, x, z, x, z, wy, MAT.col);
    }
  }

  /* ---------- ⑥ 烛台 / 长椅（零散件） ---------- */
  const bits = rng.int(4, 8);
  for (let i = 0; i < bits; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    if (rng.chance(0.5)) {
      const hh = rng.int(2, 3);
      for (let k = 1; k <= hh; k++) {
        const y = y0 + k;
        if (y >= y1 - 1) break;
        if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.col);
      }
    } else {
      solid(g, p.x, y0 + 1, p.z, Math.min(reg.x1 - 1, p.x + 1), y0 + 1, p.z, MAT.block);   // 长椅
    }
  }
}