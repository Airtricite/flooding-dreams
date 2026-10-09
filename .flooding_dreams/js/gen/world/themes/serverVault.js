/* ============================================================
   主题白模 · 服务器地窖（serverVault）
   ------------------------------------------------------------
   主题身份词：机柜塔、冷通道、架空地板、线缆桥架、制冷深井。
   「地窖」的几何主意 = **星形排布的机柜塔 + 架空地板 + 中央深井**：
     · 机柜不是墙，而是一根根**高瘦的塔**，沿八条射线从中心排出去
     · 脚下是一层架空地板（地板与真地面之间留一层缝）
     · 地窖正中一口**制冷深井**，四周塔头上有线缆桥架
   结构倾向（智能搭配）：洞穴 → 室内 → 竖井（越难越像埋在地底的机房）。
   ============================================================ */
import { MAT, plate, carve, column, pick2, clip, isFree } from './common.js';

export const style = 'building';
export const label = '服务器地窖';
export const structures = ['shaft', 'cavern', 'indoor'];
export const depth = 0.85;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（指示灯 / 线缆段）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 7) return;
  const cx = reg.x0 + Math.round((reg.x1 - reg.x0) / 2);
  const cz = reg.z0 + Math.round((reg.z1 - reg.z0) / 2);
  const half = Math.max(4, Math.min(reg.x1 - reg.x0, reg.z1 - reg.z0) / 2);

  /* ---------- ① 机柜塔：沿八条射线排出去的高瘦柜塔 ---------- */
  const ray = 8;
  for (let i = 0; i < ray; i++) {
    const a = (i / ray) * Math.PI * 2 + rng.range(-0.1, 0.1);
    const steps = Math.round(half * 0.72);
    for (let t = 3; t <= steps; t += 3) {
      const x = Math.round(cx + Math.cos(a) * t), z = Math.round(cz + Math.sin(a) * t);
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) break;
      const top = Math.min(y1 - 2, y0 + rng.int(3, Math.max(3, Math.round(h * 0.62))));
      if (top <= y0 + 2) continue;
      for (let y = y0 + 2; y <= top; y++) {
        if (!isFree(g, x, y, z)) continue;
        plate(g, x, z, x, z, y, y === top ? MAT.ledge : MAT.block);   // 柜体 + 顶盖
      }
    }
  }

  /* ---------- ② 架空地板：一层可走的格子地板（四角留缺口） ---------- */
  if (y0 + 7 < y1) {
    const Y = y0 + 1;
    for (let z = reg.z0 + 1; z <= reg.z1 - 1; z++) {
      for (let x = reg.x0 + 1; x <= reg.x1 - 1; x++) {
        if (((x + z) % 7) === 0) continue;                 // 地板上开的风口
        if (Math.hypot(x - cx, z - cz) < half * 0.2) continue;   // 中央井口
        if (!isFree(g, x, Y, z)) continue;
        plate(g, x, z, x, z, Y, MAT.slab);
      }
    }
  }

  /* ---------- ③ 制冷深井：正中往下掏一口井，井壁一圈护沿 ---------- */
  const pitR = Math.max(1, Math.round(half * 0.18));
  for (let dz = -pitR; dz <= pitR; dz++) {
    for (let dx = -pitR; dx <= pitR; dx++) {
      if (Math.hypot(dx, dz) > pitR + 0.3) continue;
      const x = cx + dx, z = cz + dz;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      carve(g, x, Math.max(0, y0 - 4), z, x, y0 + 2, z);
      plate(g, x, z, x, z, y0 - 5, MAT.block);            // 井底
    }
  }
  for (let i = 0; i < 20; i++) {                          // 井口护沿（可站）
    const a = (i / 20) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(a) * (pitR + 1.4)), z = Math.round(cz + Math.sin(a) * (pitR + 1.4));
    if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
    if (y0 + 7 < y1 && isFree(g, x, y0 + 2, z)) plate(g, x, z, x, z, y0 + 2, MAT.ledge);
  }

  /* ---------- ④ 线缆桥架：贴着天花的一道道横向走线 ---------- */
  const y = y1 - 1;
  if (y > y0 + 5) {
    for (let z = reg.z0 + 2; z <= reg.z1 - 2; z += 5) {
      for (let x = reg.x0 + 1; x <= reg.x1 - 1; x++) {
        if (!isFree(g, x, y, z)) continue;
        if (noise(x * 0.2, z * 0.2, band.i) < 0.25) continue;    // 断断续续的线缆
        plate(g, x, z, x, z, y, MAT.col);
      }
    }
  }

  /* ---------- ⑤ 指示灯 / 线缆段（零散件） ---------- */
  const bits = rng.int(4, 8);
  for (let i = 0; i < bits; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    const yy = y0 + rng.int(3, Math.max(3, h - 3));
    if (yy >= y1 - 1) break;
    if (isFree(g, p.x, yy, p.z)) plate(g, p.x, p.z, p.x, p.z, yy, MAT.ledge);
  }
}