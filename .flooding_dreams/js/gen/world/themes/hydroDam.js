/* ============================================================
   主题白模 · 水坝（hydroDam）
   ------------------------------------------------------------
   主题身份词：阶梯坝体、溢洪道、闸门柱、坝顶步道、泄水雾。
   「水坝」的几何主意 = **一片斜面 + 一条阶梯溢洪道**：
     · 坝体是一面**带台阶的斜墙**：沿一个方向每退一格就抬一格（不是竖直的墙）
     · 斜墙正中开一条**溢洪道**：一条宽槽从坝顶一级级跌到底部水垫
     · 坝顶一条**步道**（可站），正面立几根闸门柱
   结构倾向（智能搭配）：洞穴 → 室内 → 半封闭 → 露天 → 开阔（沿坝顶一路走出去）。
   ============================================================ */
import { MAT, plate, carve, column, solid, pick2, clip, isFree } from './common.js';

export const style = 'city';
export const label = '水坝';
export const structures = ['cavern', 'indoor', 'sheltered', 'outdoor', 'openAir'];
export const depth = 0.8;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（闸门柱 / 水雾灯 / 泄水泡）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 6) return;
  const along = rng.chance(0.5) ? 'x' : 'z';              // 坝体沿哪个方向展开
  const a0 = along === 'x' ? reg.x0 : reg.z0;
  const a1 = along === 'x' ? reg.x1 : reg.z1;
  const b0 = along === 'x' ? reg.z0 : reg.x0;
  const b1 = along === 'x' ? reg.z1 : reg.x1;

  /* ---------- ① 阶梯坝体：每退一格抬一格，形成斜面 ----------
     斜面沿 b 方向推进 h 格；坝体只有 1 格厚 → 省体素，形状却完整。 */
  const run = Math.min(b1 - b0 - 1, Math.max(3, Math.round(h * 0.9)));
  for (let t = 0; t < run; t++) {
    const y = y0 + 1 + Math.min(h - 6, t);
    if (y > y1 - 3) break;
    const bb = b0 + 1 + t;
    for (let a = a0 + 1; a <= a1 - 1; a++) {
      // 坝面上按噪声开几个泄水孔（不是一堵死墙）
      if (noise(a * 0.26, t * 0.7, bb * 0.26) < 0.16) continue;
      const x = along === 'x' ? a : bb;
      const z = along === 'x' ? bb : a;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, t % 2 ? MAT.block : MAT.wall);
    }
  }

  /* ---------- ② 溢洪道：斜墙正中开一条宽槽，一级级跌水 ---------- */
  const midA = Math.round((a0 + a1) / 2);
  const wide = Math.max(1, Math.round((a1 - a0) * 0.12));
  for (let t = 0; t < run; t++) {
    for (let k = -wide; k <= wide; k++) {
      const a = midA + k, bb = b0 + 1 + t;
      const x = along === 'x' ? a : bb;
      const z = along === 'x' ? bb : a;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      carve(g, x, y0, z, x, Math.min(y1 - 2, y0 + 1 + t), z);          // 掏穿泄水
      if (isFree(g, x, y0 + 1, z)) plate(g, x, z, x, z, y0 + 1, MAT.slab);   // 跌水台
    }
  }

  /* ---------- ③ 坝顶步道：最高一层盘面（可站），带几根闸门柱 ---------- */
  const topY = Math.min(y1 - 6, y0 + 1 + Math.min(h - 6, run));
  if (topY > y0 + 3) {
    for (let a = a0 + 1; a <= a1 - 1; a++) {
      const bb = b0 + run;
      const x = along === 'x' ? a : bb;
      const z = along === 'x' ? bb : a;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      if (Math.abs(a - midA) <= wide) continue;                       // 溢洪道口不铺
      if (isFree(g, x, topY, z)) plate(g, x, z, x, z, topY, MAT.slab);
    }
    const gates = rng.int(3, 6);
    for (let i = 0; i < gates && deco.spend(); i++) {
      const a = a0 + rng.int(2, Math.max(2, a1 - a0 - 2));
      const x = along === 'x' ? a : b0 + run - 1;
      const z = along === 'x' ? b0 + run - 1 : a;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      const hh = Math.min(y1 - 2, topY + 2);
      column(g, x, z, topY + 1, hh, MAT.col);                         // 闸门柱
    }
  }

  /* ---------- ④ 水垫 / 水雾灯（零散件） ---------- */
  const bits = rng.int(4, 7);
  for (let i = 0; i < bits; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    const y = y0 + rng.int(2, Math.max(2, h - 3));
    if (y < y1 - 1 && isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.ledge);
  }
  // 坝底的消力池：挖一层浅池
  if (rng.chance(0.7)) {
    const bb = Math.min(b1 - 1, b0 + run + 2);
    for (let a = a0 + 1; a <= a1 - 1; a++) {
      const x = along === 'x' ? a : bb;
      const z = along === 'x' ? bb : a;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      solid(g, x, y0 - 1, z, x, y0 - 1, z, MAT.block);
    }
  }
}