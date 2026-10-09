/* ============================================================
   主题白模 · 荒漠台地（desertMesa）
   ------------------------------------------------------------
   主题身份词：平顶台地、石柱桥、风蚀拱门、仙人掌、砾石。
   「荒漠台地」的几何主意 = **平顶的方台 + 台上台下的落差**：
     · 台地只砌「台顶板 + 四周岩壁」的**壳**，内部是空腔（省体素，也真的像岩台）
     · 台与台之间用一排细石柱撑起的**过桥板**连起来
     · 一座风蚀拱门（两柱 + 横梁）作为地标
   结构倾向（智能搭配）：洞穴 → 露天 → 开阔（荒漠是从地缝里爬出来见天光）。
   ============================================================ */
import { MAT, solid, plate, column, pick2, clip, isFree } from './common.js';

export const style = 'meadow';
export const label = '荒漠台地';
export const structures = ['cavern', 'outdoor', 'openAir'];
export const depth = 0.5;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（仙人掌 / 砾石 / 台地缘石）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 7) return;

  /* ---------- ① 平顶台地：只砌台顶 + 四壁的壳 ---------- */
  const mesas = [];
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const p = pick2(rng, reg, 4);
    const w = rng.int(2, 4), d = rng.int(2, 4);
    const top = Math.min(y1 - 6, y0 + rng.int(4, Math.max(4, h - 7)));
    if (top <= y0 + 3) continue;
    const x0 = Math.max(reg.x0 + 1, p.x - w), x1 = Math.min(reg.x1 - 1, p.x + w);
    const z0 = Math.max(reg.z0 + 1, p.z - d), z1 = Math.min(reg.z1 - 1, p.z + d);
    if (x1 - x0 < 2 || z1 - z0 < 2) continue;
    solid(g, x0, top, z0, x1, top, z1, MAT.slab);            // 台顶（一整片可站）
    for (let y = y0 + 1; y <= top - 1; y++) {                // 四壁（噪声缺口 → 风蚀）
      for (let x = x0; x <= x1; x++) {
        if (noise(x * 0.31, y * 0.21 + i, z0 * 0.31) > 0.26) solid(g, x, y, z0, x, y, z0, MAT.block);
        if (noise(x * 0.31, y * 0.21 + i, z1 * 0.31) > 0.26) solid(g, x, y, z1, x, y, z1, MAT.block);
      }
      for (let z = z0 + 1; z < z1; z++) {
        if (noise(x0 * 0.31, y * 0.21 + i, z * 0.31) > 0.26) solid(g, x0, y, z, x0, y, z, MAT.block);
        if (noise(x1 * 0.31, y * 0.21 + i, z * 0.31) > 0.26) solid(g, x1, y, z, x1, y, z, MAT.block);
      }
    }
    mesas.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, y: top });
  }

  /* ---------- ② 石柱桥：台地之间的一排细柱 + 过桥板 ---------- */
  for (let i = 1; i < mesas.length; i++) {
    const a = mesas[i - 1], b = mesas[i];
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z));
    if (steps < 2 || !deco.spend()) continue;
    for (let t = 0; t <= steps; t++) {
      const u = t / steps;
      const x = Math.round(a.x + (b.x - a.x) * u);
      const z = Math.round(a.z + (b.z - a.z) * u);
      const y = Math.round(a.y + (b.y - a.y) * u);
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      if (y + 5 > y1) continue;
      plate(g, x, z, x, z, y, MAT.ledge);                    // 桥面
      if (t % 3 === 0 && y > y0 + 2) column(g, x, z, y0 + 1, y - 1, MAT.col);   // 桥墩
    }
  }

  /* ---------- ③ 风蚀拱门：两柱 + 横梁 ---------- */
  if (rng.chance(0.65)) {
    const p = pick2(rng, reg, 5);
    const ytop = Math.min(y1 - 6, y0 + rng.int(4, Math.max(4, Math.round(h * 0.4))));
    const w = rng.int(2, 3);
    if (ytop > y0 + 3 && p.x + w < reg.x1 && p.z < reg.z1 - 1) {
      column(g, p.x, p.z, y0 + 1, ytop, MAT.col);
      column(g, p.x + w, p.z, y0 + 1, ytop, MAT.col);
      solid(g, p.x, ytop + 1, p.z, p.x + w, ytop + 1, p.z, MAT.roof);
    }
  }

  /* ---------- ④ 仙人掌 / 砾石（零散件） ---------- */
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
      if (p.x - 1 > reg.x0) plate(g, p.x - 1, p.z, p.x - 1, p.z, y0 + 2, MAT.col);   // 侧臂
    } else {
      plate(g, p.x, p.z, p.x, p.z, y0 + 1, MAT.block);
    }
  }
}