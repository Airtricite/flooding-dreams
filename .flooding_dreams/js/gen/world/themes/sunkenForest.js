/* ============================================================
   主题白模 · 沉没森林（sunkenForest）
   ------------------------------------------------------------
   主题身份词：半淹树干阵、树冠网、浮木、水下残桩、苔台。
   「沉没森林」的几何主意 = **规则的树干格网 + 不规则的冠层**：
     · 按固定树距铺一片树干阵（噪声决定哪几株真的长出来）
     · 每株柱头长一片 3×3 冠板（缺角）→ 整片世界是一张「可跳的树冠网」
     · 水底撒浮木与残桩，给「局部下降 / 涨水」留地形
   结构倾向（智能搭配）：洞穴 → 半封闭 → 露天。
   ============================================================ */
import { MAT, plate, column, pick2, clip, isFree } from './common.js';

export const style = 'meadow';
export const label = '沉没森林';
export const structures = ['cavern', 'sheltered', 'outdoor'];
export const depth = 0.55;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（浮木 / 残桩）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = Math.max(2, y1 - y0);
  const step = 4;                                   // 树距（格）：4×cell ≈ 16~24 stud

  /* ---------- ① 树干阵 + ② 树冠网 ----------
     冠板离顶 ≥5 格 → 冠层永远是合格落脚面（并且树顶跳跃成立）。 */
  for (let z = reg.z0 + 2; z <= reg.z1 - 2; z += step) {
    for (let x = reg.x0 + 2; x <= reg.x1 - 2; x += step) {
      const jx = x + rng.int(-1, 1), jz = z + rng.int(-1, 1);
      if (jx <= reg.x0 || jx >= reg.x1 || jz <= reg.z0 || jz >= reg.z1) continue;
      const nz = noise(jx * 0.11 + band.i * 9.3, 0.4, jz * 0.11);
      if (nz < 0.42) continue;                      // 有疏有密 → 不成一片「针海」
      const top = Math.min(y1 - 6, y0 + Math.round(h * (0.35 + nz * 0.5)));
      if (top <= y0 + 2) continue;
      column(g, jx, jz, y0 + 1, top, MAT.col);      // 树干
      for (let dz = -1; dz <= 1; dz++) {            // 树冠：3×3 缺角板
        for (let dx = -1; dx <= 1; dx++) {
          if (dx !== 0 && dz !== 0 && rng.chance(0.7)) continue;
          const cx = jx + dx, cz = jz + dz;
          if (cx <= reg.x0 || cx >= reg.x1 || cz <= reg.z0 || cz >= reg.z1) continue;
          if (!isFree(g, cx, top + 1, cz)) continue;
          plate(g, cx, cz, cx, cz, top + 1, MAT.ledge);
        }
      }
    }
  }

  /* ---------- ③ 水下残桩：半截没入水里的断树 ---------- */
  const stumps = rng.int(4, 7);
  for (let i = 0; i < stumps; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    const hh = rng.int(1, 2);
    for (let k = 1; k <= hh; k++) {
      const y = y0 + k;
      if (y >= y1 - 1) break;
      if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.block);
    }
  }

  /* ---------- ④ 浮木带：水面上漂着的一排木料（可踩） ---------- */
  const logs = rng.int(2, 4);
  for (let i = 0; i < logs; i++) {
    const p = pick2(rng, reg, 3);
    if (!deco.spend()) break;
    const len = rng.int(3, 6);
    const along = rng.sign();
    for (let k = 0; k < len; k++) {
      const x = along > 0 ? p.x + k : p.x;
      const z = along > 0 ? p.z : p.z + k;
      if (x >= reg.x1 || z >= reg.z1) break;
      if (y0 + 5 > y1 - 1) break;
      plate(g, x, z, x, z, y0 + 1, MAT.block);
    }
  }
}