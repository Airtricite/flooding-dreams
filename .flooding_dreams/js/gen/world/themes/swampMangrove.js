/* ============================================================
   主题白模 · 沼泽红树（swampMangrove）
   ------------------------------------------------------------
   主题身份词：支柱根、板根、泥滩、气生根、暗水。
   「沼泽红树」的几何主意 = **斜插的支柱根**（红树林最认得出来的轮廓）：
     · 每株红树一根主干，主干中部向四周斜插 2~4 根支柱根到泥面
     · 柱头一片不规则板根冠板（可站）——天然「树间跳跃」
     · 泥滩小岛与垂下的气生根须
   结构倾向（智能搭配）：室内 → 半封闭 → 露天。
   ============================================================ */
import { MAT, plate, column, pick2, clip, isFree } from './common.js';

export const style = 'meadow';
export const label = '沼泽红树';
export const structures = ['indoor', 'sheltered', 'outdoor'];
export const depth = 0.5;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（气生根须 / 泥滩缘石）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 7) return;

  /* ---------- ① 红树：主干 + 斜向支柱根 + ② 板根冠板 ---------- */
  const trees = rng.int(3, 6);
  for (let i = 0; i < trees; i++) {
    const p = pick2(rng, reg, 4);
    const top = Math.min(y1 - 6, y0 + rng.int(4, Math.max(4, Math.round(h * 0.62))));
    if (top <= y0 + 2) continue;
    column(g, p.x, p.z, y0 + 1, top, MAT.col);
    const roots = rng.int(2, 4);
    for (let k = 0; k < roots; k++) {
      const a = (k / roots) * Math.PI * 2 + rng.range(-0.35, 0.35);
      const dx = Math.cos(a) >= 0 ? 1 : -1;
      const dz = Math.sin(a) >= 0 ? 1 : -1;
      const len = rng.int(2, 3);
      for (let t = 1; t <= len; t++) {
        const x = p.x + dx * t, z = p.z + dz * t;
        const y = y0 + 1 + (len - t);                     // 从主干中部斜插到泥面
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1 || y >= y1 - 1) break;
        plate(g, x, z, x, z, y, MAT.block);
      }
    }
    for (let dz = -1; dz <= 1; dz++) {                    // 板根冠板（不规则）
      for (let dx = -1; dx <= 1; dx++) {
        if (rng.chance(0.25)) continue;
        const x = p.x + dx, z = p.z + dz;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        if (!isFree(g, x, top + 1, z)) continue;
        plate(g, x, z, x, z, top + 1, MAT.ledge);
      }
    }
  }

  /* ---------- ③ 泥滩小岛：水底一片抬高滩地 ---------- */
  const banks = rng.int(2, 4);
  for (let i = 0; i < banks; i++) {
    const p = pick2(rng, reg, 3);
    const r = rng.int(1, 2);
    for (let z = p.z - r; z <= p.z + r; z++) {
      for (let x = p.x - r; x <= p.x + r; x++) {
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        if (Math.hypot(x - p.x, z - p.z) > r + 0.3) continue;
        plate(g, x, z, x, z, y0 + 1, MAT.block);
      }
    }
  }

  /* ---------- ④ 气生根须：从冠层垂下的细根（零散件） ---------- */
  const wisps = rng.int(4, 7);
  for (let i = 0; i < wisps; i++) {
    const p = pick2(rng, reg, 3);
    if (!deco.spend()) break;
    const y = y0 + rng.int(3, Math.max(3, h - 4));
    const len = rng.int(1, 3);
    for (let k = 0; k < len; k++) {
      const yy = y - k;
      if (yy <= y0 + 1) break;
      if (isFree(g, p.x, yy, p.z)) plate(g, p.x, p.z, p.x, p.z, yy, MAT.col);
    }
  }

  /* ---------- ⑤ 暗水沟：泥面上一道浅沟（给涨水留地形） ---------- */
  if (rng.chance(0.6)) {
    const zz = reg.z0 + rng.int(2, Math.max(2, reg.z1 - reg.z0 - 2));
    const len = rng.int(4, 8);
    for (let k = 0; k < len; k++) {
      const x = reg.x0 + 1 + k;
      if (x >= reg.x1) break;
      if (noise(x * 0.3, y0, zz * 0.3) < 0.35) continue;
      plate(g, x, zz, x, zz, y0 - 1, MAT.block);
    }
  }
}