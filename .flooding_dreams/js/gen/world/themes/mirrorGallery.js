/* ============================================================
   主题白模 · 镜廊（mirrorGallery）
   ------------------------------------------------------------
   主题身份词：平行镜墙、错位门洞、菱形镜顶、台座、无限回廊。
   「镜廊」的几何主意 = **两道平行墙 + 错位的门洞**：
     · 两道长墙夹出一条廊道，墙上按模数开**交错**的门洞 ——
       从廊里望向两侧都是「一眼穿到底的镜面叠影」
     · 廊顶悬一串**菱形镜片**（一格一格的斜置薄板）
     · 廊里摆几座台座（可站的方墩）
   结构倾向（智能搭配）：室内 → 竖井 → 洞穴 → 半封闭（越难越像封闭的镜室）。
   ============================================================ */
import { MAT, plate, column, pick2, clip, isFree } from './common.js';

export const style = 'building';
export const label = '镜廊';
export const structures = ['shaft', 'cavern', 'indoor', 'sheltered'];
export const depth = 0.8;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（菱形镜片 / 台座 / 碎片）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 6) return;
  const M = 5;                                            // 门洞模数（格）
  const along = rng.chance(0.5) ? 'x' : 'z';              // 廊道方向
  const a0 = along === 'x' ? reg.x0 : reg.z0;
  const a1 = along === 'x' ? reg.x1 : reg.z1;
  const b0 = along === 'x' ? reg.z0 : reg.x0;
  const b1 = along === 'x' ? reg.z1 : reg.x1;
  const wallH = Math.min(y1 - 2, y0 + Math.max(3, Math.round(h * 0.6)));

  /* ---------- ① 两道平行墙 + ② 交错的门洞 ----------
     左墙在 a ≡ 0 (mod M) 处开门，右墙在 a ≡ M/2 处开门 —— 门洞不相对，
     于是廊道里永远看不到「一间到底」，只有层层错位的开口。 */
  const w1 = b0 + 1, w2 = b1 - 1;
  for (let a = a0 + 1; a <= a1 - 1; a++) {
    for (const [wallB, phase] of [[w1, 0], [w2, Math.floor(M / 2)]]) {
      const door = ((a - a0 - phase) % M) === 0;
      const hTop = door ? Math.min(wallH, y0 + 3) : wallH;
      for (let y = y0 + 1; y <= hTop; y++) {
        if (door && y <= y0 + 3) continue;                // 门洞
        const x = along === 'x' ? a : wallB;
        const z = along === 'x' ? wallB : a;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        if (noise(x * 0.4, y * 0.3, z * 0.4) < 0.1) continue;        // 零星缺口
        if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.wall);
      }
    }
  }

  /* ---------- ③ 菱形镜顶：廊顶悬一串斜置的薄镜片 ---------- */
  const cy = Math.min(y1 - 1, y0 + Math.round(h * 0.85));
  if (cy > y0 + 5) {
    for (let a = a0 + 2; a <= a1 - 2; a += 3) {
      const bb = b0 + 2 + ((a - a0) % 3);
      const x = along === 'x' ? a : bb;
      const z = along === 'x' ? bb : a;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      if (!deco.spend()) break;
      if (isFree(g, x, cy, z)) plate(g, x, z, x, z, cy, MAT.ledge);   // 镜片（斜置的一格）
      if (isFree(g, x, cy, z + 1)) plate(g, x, z + 1, x, z + 1, cy - 1, MAT.ledge);   // 菱形下尖
    }
  }

  /* ---------- ④ 台座：廊里几座可站的方墩 ---------- */
  const podiums = rng.int(3, 6);
  for (let i = 0; i < podiums; i++) {
    const a = a0 + rng.int(2, Math.max(2, a1 - a0 - 3));
    const bb = b0 + 1 + Math.round((b1 - b0 - 2) / 2);
    const x = along === 'x' ? a : bb;
    const z = along === 'x' ? bb : a;
    if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
    if (!deco.spend()) break;
    const top = y0 + rng.int(2, 3);
    if (top + 5 > y1) continue;
    for (let y = y0 + 1; y <= top; y++) {
      if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.block);
    }
    if (top + 1 < y1 - 1 && isFree(g, x, top + 1, z)) plate(g, x, z, x, z, top + 1, MAT.slab);
  }

  /* ---------- ⑤ 镜面碎片（零散件） ---------- */
  const bits = rng.int(4, 7);
  for (let i = 0; i < bits; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    const y = y0 + rng.int(3, Math.max(3, h - 3));
    if (y >= y1 - 1) break;
    if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.ledge);
  }
}