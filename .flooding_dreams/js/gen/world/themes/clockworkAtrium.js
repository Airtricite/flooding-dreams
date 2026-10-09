/* ============================================================
   主题白模 · 钟表中庭（clockworkAtrium）
   ------------------------------------------------------------
   主题身份词：同心环廊、摆锤、齿轮、表盘墙、黄铜。
   「钟表中庭」的几何主意 = **两层同心环廊 + 一根摆锤**：
     · 中庭四周是两圈**同心环廊**（内圈高、外圈低），中间整片是空腔
     · 空腔正中吊一根**倾斜的摆锤**（沿高度左右偏移 → 摆动的手臂）
     · 一面墙上嵌一个**表盘**（竖直平面里的刻度环）
   结构倾向（智能搭配）：室内 → 半封闭（钟表是室内机械）。
   ============================================================ */
import { MAT, plate, column, blob, pick2, clip, isFree } from './common.js';

export const style = 'building';
export const label = '钟表中庭';
export const structures = ['indoor', 'sheltered'];
export const depth = 0.7;

export function build(c) {
  const { g, reg: raw, band, rng } = c;
  // ★ 零散件配额（齿轮 / 摆锤齿 / 指针件）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  const cx = reg.x0 + Math.round((reg.x1 - reg.x0) / 2);
  const cz = reg.z0 + Math.round((reg.z1 - reg.z0) / 2);
  const half = Math.max(4, Math.min(reg.x1 - reg.x0, reg.z1 - reg.z0) / 2);

  /* ---------- ① 两层同心环廊：外低内高，中庭留空 ---------- */
  const rings = [
    { r: half * 0.92, y: y0 + 1 },
    { r: half * 0.55, y: y0 + Math.max(4, Math.round(h * 0.42)) },
  ];
  for (const ring of rings) {
    if (ring.y + 5 > y1) continue;
    const w = Math.max(1, Math.round(half * 0.12));
    for (let i = 0; i < 52; i++) {
      const a = (i / 52) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * ring.r), z = Math.round(cz + Math.sin(a) * ring.r);
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      for (let k = 0; k <= w; k++) {                    // 廊宽：向内铺几格
        const xx = Math.round(cx + Math.cos(a) * (ring.r - k));
        const zz = Math.round(cz + Math.sin(a) * (ring.r - k));
        if (xx <= reg.x0 || xx >= reg.x1 || zz <= reg.z0 || zz >= reg.z1) continue;
        if (isFree(g, xx, ring.y, zz)) plate(g, xx, zz, xx, zz, ring.y, MAT.slab);
      }
      // 环廊外缘立柱（把廊吊起来）
      if (i % 4 === 0) {
        const base = y0 + 1;
        if (ring.y - 1 > base && isFree(g, x, base + 1, z)) column(g, x, z, base + 1, ring.y - 1, MAT.col);
      }
    }
    // 廊栏：外缘再高一格的细栏（观感，不挡上方净空）
    if (deco.spend()) {
      for (let i = 0; i < 52; i += 6) {
        const a = (i / 52) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(a) * (ring.r + 0.6)), z = Math.round(cz + Math.sin(a) * (ring.r + 0.6));
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        if (ring.y + 1 < y1 - 1 && isFree(g, x, ring.y + 1, z)) plate(g, x, z, x, z, ring.y + 1, MAT.wall);
      }
    }
  }

  /* ---------- ② 摆锤：从顶垂下的长臂，沿高度左右偏移 ---------- */
  const swing = Math.max(2, Math.round(half * 0.45));
  const armTop = Math.min(y1 - 2, y0 + Math.round(h * 0.9));
  const len = Math.max(3, Math.round(h * 0.6));
  for (let k = 0; k < len; k++) {
    const t = k / len;
    const y = armTop - k;
    if (y <= y0 + 1) break;
    const x = cx + Math.round(Math.sin(t * Math.PI * 0.8) * swing);   // 摆动轨迹
    if (x <= reg.x0 || x >= reg.x1) continue;
    if (isFree(g, x, y, cz)) plate(g, x, cz, x, cz, y, MAT.col);
  }
  blob(g, cx + swing, y0 + 2, cz, 1.4, 1.2, 1.4, MAT.block);          // 摆锤（可站）

  /* ---------- ③ 表盘墙：一面竖直墙上的刻度环 ---------- */
  const wallX = rng.chance(0.5) ? reg.x1 - 1 : reg.x0 + 1;
  const fx = wallX, fy = y0 + Math.max(4, Math.round(h * 0.5));
  const R = Math.max(2, Math.round(half * 0.5));
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const y = fy + Math.round(Math.sin(a) * R);
    const z = cz + Math.round(Math.cos(a) * R);
    if (y <= y0 || y >= y1 - 1 || z <= reg.z0 || z >= reg.z1) continue;
    if (isFree(g, fx, y, z)) plate(g, fx, z, fx, z, y, MAT.ledge);    // 刻度环
  }

  /* ---------- ④ 齿轮（零散件，挂在环廊下） ---------- */
  const gears = rng.int(4, 7);
  for (let i = 0; i < gears; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    const y = y0 + rng.int(3, Math.max(3, h - 3));
    if (y >= y1 - 1) break;
    if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.block);
  }
}