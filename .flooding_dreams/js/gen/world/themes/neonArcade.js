/* ============================================================
   主题白模 · 霓虹街机厅（neonArcade）
   ------------------------------------------------------------
   主题身份词：街机柜阵列、灯箱墙、舞台地台、奖杯塔、霓虹。
   「街机厅」的几何主意 = **成排的机柜 + 垂直霓虹墙**：
     · 一排排 1×1 的**街机柜**（柜体 + 顶上发光屏），排间留走道 → 走迷宫般的厅
     · 一整面**灯箱墙**：竖向霓虹条按固定间距铺满一面
     · 中央一座抬高的舞台地台（可站，视线中心）
   结构倾向（智能搭配）：室内 → 半封闭 → 露天 → 开阔。
   ============================================================ */
import { MAT, plate, column, pick2, clip, isFree } from './common.js';

export const style = 'building';
export const label = '霓虹街机厅';
export const structures = ['indoor', 'sheltered', 'outdoor', 'openAir'];
export const depth = 0.6;

export function build(c) {
  const { g, reg: raw, band, rng } = c;
  // ★ 零散件配额（奖杯塔 / 灯管段）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  const aisle = 2;                                       // 走道宽（格）

  /* ---------- ① 街机柜阵列：柜体 + 顶上发光屏 ----------
     机柜高 2 格，顶上放一格发光的「屏」—— 从外部看是一格格的霓虹点阵。 */
  if (h >= 7) {
    const rows = 3;
    for (let r = 0; r < rows; r++) {
      const z = reg.z0 + 2 + r * (aisle + 2);
      if (z >= reg.z1 - 1) break;
      for (let x = reg.x0 + 2; x <= reg.x1 - 2; x += 3) {
        if (rng.chance(0.25)) continue;                  // 有空位 → 厅里不呆板
        const top = y0 + 2;
        if (top + 1 >= y1 - 1) break;
        for (let y = y0 + 1; y <= top; y++) {
          if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.block);
        }
        plate(g, x, z, x, z, top + 1, MAT.ledge);        // 发光屏
      }
    }
  }

  /* ---------- ② 灯箱墙：一整面竖向霓虹条 ---------- */
  const wallX = rng.chance(0.5) ? reg.x1 - 1 : reg.x0 + 1;
  const wallH = Math.min(y1 - 2, y0 + Math.max(4, Math.round(h * 0.7)));
  for (let z = reg.z0 + 1; z <= reg.z1 - 1; z += 2) {
    for (let y = y0 + 2; y <= wallH; y += 1) {
      if (y === wallH && rng.chance(0.5)) continue;
      if (isFree(g, wallX, y, z)) plate(g, wallX, z, wallX, z, y, MAT.col);
    }
  }

  /* ---------- ③ 舞台地台：中央一座抬高两格的圆台 ---------- */
  const cx = reg.x0 + Math.round((reg.x1 - reg.x0) / 2);
  const cz = reg.z0 + Math.round((reg.z1 - reg.z0) / 2);
  const R = Math.max(2, Math.round(Math.min(reg.x1 - reg.x0, reg.z1 - reg.z0) * 0.2));
  if (y0 + 7 < y1) {
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        if (Math.hypot(dx, dz) > R + 0.3) continue;
        if (isFree(g, x, y0 + 2, z)) {
          plate(g, x, z, x, z, y0 + 2, MAT.slab);        // 台面
          plate(g, x, z, x, z, y0 + 1, MAT.block);
        }
      }
    }
    // 舞台灯柱：四角各一根细柱 + 灯头
    for (const [sx, sz] of [[-R, -R], [R, -R], [-R, R], [R, R]]) {
      const x = cx + sx, z = cz + sz;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      column(g, x, z, y0 + 3, Math.min(y1 - 2, y0 + 5), MAT.col);
      plate(g, x, z, x, z, Math.min(y1 - 2, y0 + 6), MAT.ledge);
    }
  }

  /* ---------- ④ 奖杯塔 / 灯管段（零散件） ---------- */
  const bits = rng.int(4, 8);
  for (let i = 0; i < bits; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    if (rng.chance(0.5)) {
      const hh = rng.int(2, 4);                          // 奖杯塔：叠起来的筹码
      for (let k = 1; k <= hh; k++) {
        const y = y0 + k;
        if (y >= y1 - 1) break;
        if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.ledge);
      }
    } else {
      const y = y1 - 2;                                  // 悬吊灯管段
      if (y > y0 + 4 && isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.col);
    }
  }
}