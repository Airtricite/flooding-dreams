/* ============================================================
   主题白模 · 浮空岛（skyIslands）
   ------------------------------------------------------------
   主题身份词：悬浮平台、藤桥、悬垂藤幕、空中孤石、云海。
   「浮空岛」的几何主意 = **离散的岛 + 索桥**：
     · 每座岛是「上平面可站、下锥收成根」的圆盘 —— 世界其余全是空气
     · 相邻的岛用一条**中间下垂**的 1 格宽藤桥连起来（索桥的抛物线感）
     · 岛底垂一串细藤、空间里撒几块孤石
   结构倾向（智能搭配）：半封闭 → 露天 → 开阔（越往上越飘）。
   ============================================================ */
import { MAT, plate, pick2, clip } from './common.js';

export const style = 'meadow';
export const label = '浮空岛';
export const structures = ['sheltered', 'outdoor', 'openAir'];
export const depth = 0.15;

export function build(c) {
  const { g, reg: raw, band, rng } = c;
  // ★ 零散件配额（孤石 / 藤幕）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 6) return;                                   // 太薄的空间不长浮空岛

  /* ---------- ① 悬浮平台：3~5 座圆盘岛 ----------
     岛面离顶 ≥5 格 → 站上去头顶永远有 4 格以上净空。 */
  const isls = [];
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const p = pick2(rng, reg, 5);
    const r = rng.int(2, 4);
    const y = y0 + rng.int(3, Math.max(3, h - 7));
    if (y + 5 > y1) continue;
    let cells = 0;
    for (let z = p.z - r; z <= p.z + r; z++) {
      for (let x = p.x - r; x <= p.x + r; x++) {
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        const d = Math.hypot(x - p.x, z - p.z);
        if (d > r + 0.35) continue;
        if (!g.occ[(z * g.ny + y) * g.nx + x]) { plate(g, x, z, x, z, y, MAT.slab); cells++; }
        plate(g, x, z, x, z, y - 1, MAT.block);        // 岛体
        if (d < r - 1.1) plate(g, x, z, x, z, y - 2, MAT.block);   // 根锥
      }
    }
    if (cells >= 3) isls.push({ x: p.x, z: p.z, y, r });
  }

  /* ---------- ② 藤桥：相邻岛的索桥（中段下垂） ---------- */
  for (let i = 1; i < isls.length; i++) {
    const a = isls[i - 1], b = isls[i];
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z));
    if (steps < 2 || !deco.spend()) continue;
    for (let t = 0; t <= steps; t++) {
      const u = t / steps;
      const x = Math.round(a.x + (b.x - a.x) * u);
      const z = Math.round(a.z + (b.z - a.z) * u);
      const sag = Math.round(Math.sin(u * Math.PI) * Math.min(2, Math.abs(a.y - b.y) + 1));
      const y = Math.round(a.y + (b.y - a.y) * u) - sag;       // 下垂 → 索桥
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      if (y <= y0 || y >= y1 - 1) continue;
      plate(g, x, z, x, z, y, MAT.ledge);
    }
  }

  /* ---------- ③ 悬垂藤幕：岛底挂一串细藤（纯观感） ---------- */
  for (const is of isls) {
    if (!rng.chance(0.6) || !deco.spend()) continue;
    for (let k = 0; k < rng.int(2, 4); k++) {
      const y = is.y - 3 - k;
      if (y <= y0 + 1) break;
      plate(g, is.x, is.z, is.x, is.z, y, MAT.col);
    }
  }

  /* ---------- ④ 空中孤石 ---------- */
  const rocks = rng.int(4, 7);
  for (let i = 0; i < rocks; i++) {
    const p = pick2(rng, reg, 3);
    const y = y0 + rng.int(2, Math.max(2, h - 3));
    if (y + 4 > y1 || !deco.spend()) break;
    plate(g, p.x, p.z, p.x, p.z, y, MAT.block);
  }
}