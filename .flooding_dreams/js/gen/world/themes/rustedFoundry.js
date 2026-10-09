/* ============================================================
   主题白模 · 锈蚀铸造厂（rustedFoundry）
   ------------------------------------------------------------
   主题身份词：高炉塔、熔炉坑、输送带、悬吊管道、锈桶。
   「铸造厂」的几何主意 = **空心圆塔群 + 坑 + 斜输送带**：
     · 高炉 = 一圈立壁围成的**空心筒**（顶上一圈可站的检修环台）
     · 地上掏一座**熔炉坑**（坑沿护墙）——天然的「局部下降」
     · 一架从低处爬到高处的**斜输送带**（逐级 +1 格的楼梯桥）
   结构倾向（智能搭配）：竖井 → 洞穴 → 室内 → 露天（从厂房里爬出去）。
   ============================================================ */
import { MAT, plate, carve, column, pick2, clip, isFree } from './common.js';

export const style = 'city';
export const label = '锈蚀铸造厂';
export const structures = ['shaft', 'cavern', 'indoor', 'outdoor'];
export const depth = 0.75;

export function build(c) {
  const { g, reg: raw, band, rng } = c;
  // ★ 零散件配额（悬管 / 锈桶）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 7) return;

  /* ---------- ① 高炉塔：空心筒 + 顶部检修环台 ---------- */
  const towers = rng.int(2, 4);
  for (let i = 0; i < towers; i++) {
    const p = pick2(rng, reg, 5);
    const R = rng.int(2, 3);
    const top = Math.min(y1 - 6, y0 + rng.int(4, Math.max(4, Math.round(h * 0.72))));
    if (top <= y0 + 3) continue;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dz);
        if (d < R - 0.6 || d > R + 0.4) continue;         // 只砌筒壁，内腔留空
        const x = p.x + dx, z = p.z + dz;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        for (let y = y0 + 1; y <= top; y++) {
          if ((y - y0) % 4 === 0 && y !== top) continue;  // 每隔几格断开 → 锈蚀缺环
          plate(g, x, z, x, z, y, y === top ? MAT.slab : MAT.wall);
        }
      }
    }
  }

  /* ---------- ② 熔炉坑：地上掏一个深坑 + 坑沿护墙 ---------- */
  if (rng.chance(0.85)) {
    const p = pick2(rng, reg, 5);
    const w = rng.int(2, 4);
    const depth = rng.int(2, 4);
    const x1 = Math.min(reg.x1 - 1, p.x + w), z1 = Math.min(reg.z1 - 1, p.z + w);
    carve(g, p.x, Math.max(0, y0 - depth), p.z, x1, y0, z1);
    plate(g, p.x, p.z, x1, z1, y0 - depth - 1, MAT.block);               // 坑底
    for (let x = p.x - 1; x <= x1 + 1; x++) {
      if (x < reg.x0 + 1 || x > reg.x1 - 1) continue;
      for (const z of [p.z - 1, z1 + 1]) {
        if (z < reg.z0 + 1 || z > reg.z1 - 1 || z + 1 >= reg.z1) continue;
        if (isFree(g, x, y0 + 1, z)) plate(g, x, z, x, z, y0 + 1, MAT.wall);
      }
    }
  }

  /* ---------- ③ 斜输送带：一台逐级爬升的输送桥 ---------- */
  if (rng.chance(0.85)) {
    let x = reg.x0 + 2;
    const z = reg.z0 + rng.int(2, Math.max(2, reg.z1 - reg.z0 - 3));
    const dx = rng.sign();
    const len = Math.min(10, Math.max(4, Math.round(h * 0.55)));
    for (let t = 0; t < len; t++) {
      const y = y0 + 2 + t;
      if (y > y1 - 6 || x <= reg.x0 || x >= reg.x1) break;
      for (let dz = 0; dz <= 1; dz++) {
        if (z + dz >= reg.z1) continue;
        if (isFree(g, x, y, z + dz)) plate(g, x, z + dz, x, z + dz, y, MAT.ledge);
      }
      x += dx;
    }
  }

  /* ---------- ④ 悬吊管道 / 锈桶（零散件） ---------- */
  const bits = rng.int(4, 8);
  for (let i = 0; i < bits; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    if (rng.chance(0.5)) {
      const y = y0 + rng.int(3, Math.max(3, h - 3));      // 悬管
      if (y < y1 - 1 && isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.col);
    } else {
      const hh = rng.int(1, 2);
      for (let k = 1; k <= hh; k++) {
        const y = y0 + k;
        if (y >= y1 - 1) break;
        if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.block);
      }
    }
  }
  // 悬吊桥架：一根横梁吊在两塔之间（纯观感）
  if (deco.spend()) {
    const p = pick2(rng, reg, 4);
    const y = y0 + rng.int(4, Math.max(4, h - 4));
    if (y < y1 - 1) {
      const len = Math.min(6, reg.x1 - 1 - p.x);
      for (let k = 0; k <= len; k++) if (isFree(g, p.x + k, y, p.z)) plate(g, p.x + k, p.z, p.x + k, p.z, y, MAT.roof);
    }
  }
}