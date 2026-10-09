/* ============================================================
   主题白模 · 赌场楼层（casinoFloor）
   ------------------------------------------------------------
   主题身份词：层叠赌台、环形灯带、筹码塔、老虎机排、金红。
   「赌场」的几何主意 = **环形台 + 正上方的环形灯带**：
     · 赌台是**带中心洞的圆环**（玩家围坐的那种半圆台），散在楼层各处
     · 每张赌台正上方几格吊一圈**环形灯带**（挖空中心的环，留足净空）
     · 一排排老虎机（成排矮柜）+ 一堆筹码塔
   结构倾向（智能搭配）：室内 → 竖井 → 半封闭 → 露天（一层层玩上去）。
   ============================================================ */
import { MAT, plate, column, pick2, clip, isFree } from './common.js';

export const style = 'building';
export const label = '赌场楼层';
export const structures = ['shaft', 'indoor', 'sheltered', 'outdoor'];
export const depth = 0.8;

export function build(c) {
  const { g, reg: raw, band, rng } = c;
  // ★ 零散件配额（筹码塔 / 老虎机 / 骰子）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 8) return;
  const half = Math.max(3, Math.min(reg.x1 - reg.x0, reg.z1 - reg.z0) / 2);
  const cx = reg.x0 + Math.round((reg.x1 - reg.x0) / 2);
  const cz = reg.z0 + Math.round((reg.z1 - reg.z0) / 2);

  /* ---------- ① 层叠赌台：带中心洞的圆环台（台面抬两格） ---------- */
  const tables = rng.int(2, 4);
  const seats = [];
  for (let i = 0; i < tables; i++) {
    const R = rng.int(2, 3);
    const a = (i / tables) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const rr = rng.range(0.2, 0.7) * half;
    const tcx = Math.round(cx + Math.cos(a) * rr), tcz = Math.round(cz + Math.sin(a) * rr);
    const y = y0 + 2;
    if (y + 5 > y1) continue;
    let cells = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = tcx + dx, z = tcz + dz;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        const d = Math.hypot(dx, dz);
        if (d < R - 1 || d > R + 0.3) continue;             // 只保留环带 → 中心留洞
        if (isFree(g, x, y, z)) {
          plate(g, x, z, x, z, y, MAT.ledge);               // 台面
          plate(g, x, z, x, z, y - 1, MAT.block);           // 台体
          cells++;
        }
      }
    }
    if (cells < 3) continue;
    /* ---------- ② 环形灯带：赌台正上方几格的**空心环** ---------- */
    const ly = Math.min(y1 - 1, y + 6);
    if (ly > y + 5) {
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          const x = tcx + dx, z = tcz + dz;
          if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
          const d = Math.hypot(dx, dz);
          if (d < R - 0.6 || d > R + 0.3) continue;
          if (isFree(g, x, ly, z)) plate(g, x, z, x, z, ly, MAT.col);
        }
      }
    }
    seats.push({ x: tcx, z: tcz, R, y });
  }

  /* ---------- ③ 老虎机排：成排的矮柜（面向中央） ---------- */
  const rows = 2;
  for (let r = 0; r < rows; r++) {
    const z = reg.z0 + 2 + r * 3;
    if (z >= reg.z1 - 1) break;
    for (let x = reg.x0 + 2; x <= reg.x1 - 2; x += 2) {
      if (rng.chance(0.3)) continue;
      if (!deco.spend()) break;
      const top = y0 + 1;
      for (let y = y0 + 1; y <= top; y++) {
        if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.block);
      }
      if (isFree(g, x, top + 1, z)) plate(g, x, z, x, z, top + 1, MAT.ledge);   // 屏幕
    }
  }

  /* ---------- ④ 筹码塔 / 骰子（零散件） ---------- */
  const towers = rng.int(5, 9);
  for (let i = 0; i < towers; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    if (rng.chance(0.65)) {
      const hh = rng.int(3, 5);                              // 筹码塔：细高叠柱
      for (let k = 1; k <= hh; k++) {
        const y = y0 + k;
        if (y >= y1 - 1) break;
        if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.ledge);
      }
    } else {
      const y = y0 + rng.int(3, Math.max(3, h - 3));         // 悬吊的金色灯球
      if (y < y1 - 1 && isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.col);
    }
  }

  /* ---------- ⑤ 金色装柱：中央一根缠灯的金柱（地标） ---------- */
  if (deco.spend() && h >= 10) {
    const top = Math.min(y1 - 6, y0 + Math.round(h * 0.7));
    if (top > y0 + 3 && isFree(g, cx, y0 + 1, cz)) {
      column(g, cx, cz, y0 + 1, top, MAT.col);
      for (let y = y0 + 3; y <= top; y += 3) {
        if (isFree(g, cx + 1, y, cz)) plate(g, cx + 1, cz, cx + 1, cz, y, MAT.ledge);
      }
    }
  }
}