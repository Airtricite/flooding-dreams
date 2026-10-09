/* ============================================================
   主题白模 · 空中港（skyport）
   ------------------------------------------------------------
   主题身份词：停机坪、登机桥、塔台、帆桁、导航灯。
   「空中港」的几何主意 = **几片悬在空中的大圆盘 + 斜桥**：
     · 每片停机坪是一个**带边圈**的大圆盘（边圈比盘面高一格 → 看得见的「柏油盘」）
     · 盘与盘之间用**斜登机桥**连起来（一路爬升，像登机廊桥）
     · 一座塔台（细柱 + 大顶）作为地标
   结构倾向（智能搭配）：露天 → 开阔（本来就在云上，没有洞）。
   ============================================================ */
import { MAT, plate, column, pick2, clip, isFree } from './common.js';

export const style = 'city';
export const label = '空中港';
export const structures = ['outdoor', 'openAir'];
export const depth = 0.1;

export function build(c) {
  const { g, reg: raw, band, rng } = c;
  // ★ 零散件配额（导航灯 / 旗杆 / 货箱）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 6) return;

  /* ---------- ① 停机坪：带边圈的大圆盘 ---------- */
  const pads = [];
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const p = pick2(rng, reg, 6);
    const R = rng.int(3, 5);
    const y = y0 + rng.int(2, Math.max(2, h - 7));
    if (y + 5 > y1) continue;
    let cells = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = p.x + dx, z = p.z + dz;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        const d = Math.hypot(dx, dz);
        if (d > R + 0.3) continue;
        if (d > R - 0.8) {
          // 边圈：比盘面高一格 → 盘有一圈围沿（但仍然全是空气在上方）
          if (isFree(g, x, y + 1, z)) plate(g, x, z, x, z, y + 1, MAT.ledge);
          continue;
        }
        if (!g.occ[(z * g.ny + y) * g.nx + x]) { plate(g, x, z, x, z, y, MAT.slab); cells++; }
        plate(g, x, z, x, z, y - 1, MAT.block);
      }
    }
    if (cells >= 4) pads.push({ x: p.x, z: p.z, y, R });
  }

  /* ---------- ② 斜登机桥：盘与盘之间的爬升廊桥 ---------- */
  for (let i = 1; i < pads.length; i++) {
    const a = pads[i - 1], b = pads[i];
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z));
    if (steps < 2 || !deco.spend()) continue;
    for (let t = 0; t <= steps; t++) {
      const u = t / steps;
      const x = Math.round(a.x + (b.x - a.x) * u);
      const z = Math.round(a.z + (b.z - a.z) * u);
      const y = Math.round(a.y + (b.y - a.y) * u);
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1 || y + 5 > y1) continue;
      for (let dz = 0; dz <= 1; dz++) {                    // 桥面 2 格宽
        if (z + dz >= reg.z1 || !isFree(g, x, y, z + dz)) continue;
        plate(g, x, z + dz, x, z + dz, y, MAT.ledge);
      }
    }
  }

  /* ---------- ③ 塔台：细柱 + 宽顶 ---------- */
  if (rng.chance(0.7)) {
    const p = pick2(rng, reg, 4);
    const top = Math.min(y1 - 6, y0 + rng.int(4, Math.max(4, Math.round(h * 0.7))));
    if (top > y0 + 3) {
      column(g, p.x, p.z, y0 + 1, top, MAT.col);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = p.x + dx, z = p.z + dz;
          if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
          plate(g, x, z, x, z, top + 1, MAT.roof);          // 塔顶观察室
        }
      }
    }
  }

  /* ---------- ④ 导航灯 / 旗杆 / 货箱（零散件） ---------- */
  const bits = rng.int(5, 9);
  for (let i = 0; i < bits; i++) {
    const p = pick2(rng, reg, 3);
    if (!deco.spend()) break;
    const kind = rng.int(0, 2);
    if (kind === 0) {
      const y = y0 + rng.int(3, Math.max(3, h - 3));        // 悬空导航灯
      if (y < y1 - 1 && isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.ledge);
    } else if (kind === 1) {
      const base = y0 + 1;                                   // 旗杆
      if (base + 3 < y1 - 1 && isFree(g, p.x, base + 1, p.z)) column(g, p.x, p.z, base, base + 3, MAT.col);
    } else {
      if (y0 + 2 < y1 - 1 && isFree(g, p.x, y0 + 2, p.z)) plate(g, p.x, p.z, p.x, p.z, y0 + 2, MAT.block);
    }
  }
}