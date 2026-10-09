/* ============================================================
   主题白模 · 阈限走廊（liminalHall）
   ------------------------------------------------------------
   主题身份词：无尽走廊、门厅、泳池房、门列、荧光灯带、湿地毯。
   「阈限要有阈限的样子」= 这套构造必须给出：
     · **无尽走廊格网**：正交隔墙按模数铺开，隔一段开一个门洞 ——
       一眼看过去是「走不完的走廊」，而不是一个大厅
     · **门列**：连续几个门洞串成一条视觉轴线（也是可穿的捷径）
     · **踢脚线 / 地毯**：地板抬一层 + 墙脚一圈深色带（廉价但极像阈限空间）
     · **泳池房**：一间房里掏一个下凹的池子（涨水/游泳就发生在这里）
     · **灯带**：天花板下沿一条连续的板（顶光带）
   结构倾向（智能搭配）：室内 ↔ 半封闭，越往上越少隔墙（逃出阈限）。
   ============================================================ */
import { MAT, plate, carve, clip } from './common.js';

export const style = 'building';
export const label = '阈限走廊';
export const structures = ['indoor', 'sheltered', 'outdoor'];
/** 结构节奏：两带一循环 —— 「走廊格网 ↔ 半封闭门厅」交替 */
export const rhythm = 'duplex';
export const depth = 0.8;

/** 隔墙模数（体素）：走廊宽度 ≈ 5~6 格 */
function mod(cell) { return Math.max(5, Math.round(32 / cell)); }

export function build(c) {
  const { g, reg: raw, band, rng, cell } = c;
  // ★ 零散件配额（水渍带）：孤立小件合并不掉，一件就是一个方块
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const M = mod(cell);
  const openness = Math.min(1, Math.max(0, Number(band.shell.openness) || 0.3));
  // 越开阔隔墙越矮（逃向天光）：h = 1~4 体素
  const wallH = Math.max(1, Math.round(1 + (1 - openness) * 3));

  /* ---------- ① 地板 + 踢脚线 ---------- */
  plate(g, reg.x0, reg.z0, reg.x1, reg.z1, y0, MAT.slab);
  plate(g, reg.x0, reg.z0, reg.x1, reg.z1, y0 - 1, MAT.block);

  /* ---------- ② 隔墙格网 + 门列 ----------
     沿 x 与 z 两个方向的模数线铺墙；门洞每 M 格开一个（宽 1，高 3 体素），
     于是整层是一张**连通的走廊网**，而不是一堆封闭小间。 */
  const doorEvery = M;
  for (let x = reg.x0 + M; x <= reg.x1 - 1; x += M) {
    for (let z = reg.z0 + 1; z <= reg.z1 - 1; z++) {
      const door = ((z - reg.z0) % doorEvery === 0);
      const hTop = door ? y0 + 3 : y0 + wallH;
      for (let y = y0 + 1; y <= Math.min(y1 - 1, hTop); y++) {
        if (door && y <= y0 + 3) continue;                  // 门洞
        plate(g, x, z, x, z, y, MAT.wall);
      }
    }
  }
  for (let z = reg.z0 + M; z <= reg.z1 - 1; z += M) {
    for (let x = reg.x0 + 1; x <= reg.x1 - 1; x++) {
      const door = ((x - reg.x0) % doorEvery === 0);
      const hTop = door ? y0 + 3 : y0 + wallH;
      for (let y = y0 + 1; y <= Math.min(y1 - 1, hTop); y++) {
        if (door && y <= y0 + 3) continue;
        if (g.occ[(z * g.ny + y) * g.nx + x]) continue;      // 十字路口不重复砌
        plate(g, x, z, x, z, y, MAT.wall);
      }
    }
  }

  /* ---------- ③ 泳池房：一间房里掏出下凹的池子 ---------- */
  if (rng.chance(0.8)) {
    const gx = Math.max(1, Math.floor((reg.x1 - reg.x0) / M) - 1);
    const gz = Math.max(1, Math.floor((reg.z1 - reg.z0) / M) - 1);
    const p = { x: reg.x0 + M * rng.int(1, gx), z: reg.z0 + M * rng.int(1, gz) };
    const w = Math.min(M - 1, 4), d = Math.min(M - 1, 4);
    const depth = rng.int(2, 4);
    const px0 = p.x + 1, pz0 = p.z + 1;
    const px1 = Math.min(reg.x1 - 1, px0 + w - 1), pz1 = Math.min(reg.z1 - 1, pz0 + d - 1);
    for (let z = pz0; z <= pz1; z++) {
      for (let x = px0; x <= px1; x++) carve(g, x, y0 - depth, z, x, y0, z);
    }
    plate(g, px0, pz0, px1, pz1, y0 - depth - 1, MAT.block);      // 池底
    // 池沿：只在池子四周补一圈抬高的台（可站），池面上方必须留空
    for (let z = pz0 - 1; z <= pz1 + 1; z++) {
      for (let x = px0 - 1; x <= px1 + 1; x++) {
        if (x < 1 || z < 1 || x > reg.x1 || z > reg.z1) continue;
        const inPool = x >= px0 && x <= px1 && z >= pz0 && z <= pz1;
        if (inPool) continue;
        if (!g.occ[(z * g.ny + (y0 + 1)) * g.nx + x]) plate(g, x, z, x, z, y0 + 1, MAT.ledge);
      }
    }
  }

  /* ---------- ④ 天花板 + 荧光灯带 ---------- */
  if (Number(band.shell.ceilY) > 0 || openness < 0.7) {
    const cy = Math.min(g.ny - 2, y1);
    plate(g, reg.x0, reg.z0, reg.x1, reg.z1, cy, MAT.roof);
    // 灯带：天花板下沿每 M/2 格一条细板（观感 + 顶部落点）
    const step = Math.max(2, Math.round(M / 2));
    for (let z = reg.z0 + 1; z <= reg.z1 - 1; z += step) {
      plate(g, reg.x0 + 1, z, reg.x1 - 1, z, cy - 1, MAT.ledge);
    }
  }

  /* ---------- ⑤ 湿地毯 / 水渍：地板上一条深色带 ---------- */
  const strips = rng.int(1, 3);
  for (let i = 0; i < strips; i++) {
    const zz = reg.z0 + rng.int(1, Math.max(1, reg.z1 - reg.z0 - 2));
    const len = rng.int(3, 7);
    if (!deco.spend()) break;
    for (let k = 0; k < len; k++) {
      const x = reg.x0 + 1 + k + rng.int(0, M);
      if (x > reg.x1 - 1) break;
      if (g.occ[(zz * g.ny + y0) * g.nx + x]) plate(g, x, zz, x, zz, y0, MAT.ledge);
    }
  }
}