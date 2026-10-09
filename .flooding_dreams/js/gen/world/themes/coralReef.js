/* ============================================================
   主题白模 · 珊瑚礁（coralReef）
   ------------------------------------------------------------
   主题身份词：树枝珊瑚、环礁圈、潟湖礁台、海葵、暖水。
   「珊瑚礁」的几何主意 = **分叉的枝状体 + 一圈断续环礁**：
     · 珊瑚丛：主干 + 两级分叉（每级再分一支）→ 真·枝状轮廓
     · 大圈断续的礁石围出一片**潟湖空腔**（中间是水，外面是礁）
     · 潟湖里搭几片抬高的礁台 + 海底的海葵丛
   结构倾向（智能搭配）：洞穴 → 室内 → 半封闭 → 露天。
   ============================================================ */
import { MAT, plate, column, pick2, clip, isFree } from './common.js';

export const style = 'rock';
export const label = '珊瑚礁';
export const structures = ['cavern', 'indoor', 'sheltered', 'outdoor'];
export const depth = 0.65;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（海葵 / 珊瑚枝）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = Math.max(3, y1 - y0);
  const cx = (reg.x0 + reg.x1) / 2, cz = (reg.z0 + reg.z1) / 2;
  const half = Math.max(4, Math.min(reg.x1 - reg.x0, reg.z1 - reg.z0) / 2);

  /* ---------- ① 树枝珊瑚：主干 + 两级分叉 ---------- */
  const colonies = rng.int(3, 5);
  for (let i = 0; i < colonies; i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(0.15, 0.68) * half;
    const bx = Math.round(cx + Math.cos(a) * r), bz = Math.round(cz + Math.sin(a) * r);
    if (bx <= reg.x0 + 2 || bx >= reg.x1 - 2 || bz <= reg.z0 + 2 || bz >= reg.z1 - 2) continue;
    const top = Math.min(y1 - 4, y0 + rng.int(3, 5));
    if (top <= y0 + 1) continue;
    for (let y = y0 + 1; y <= top; y++) plate(g, bx, bz, bx, bz, y, MAT.col);   // 主干
    if (!deco.spend()) break;
    for (const d of [-1, 1]) {                           // 一级分叉（沿 x 斜上）
      const len = rng.int(2, 3);
      for (let t = 1; t <= len; t++) {
        const x = bx + d * t, y = top + t;
        if (x <= reg.x0 || x >= reg.x1 || y > y1 - 4) break;
        plate(g, x, bz, x, bz, y, MAT.ledge);
        if (t === len) {                                 // 二级分叉（沿 z 再分一支）
          const z2 = bz + d, y2 = y + 1;
          if (z2 > reg.z0 && z2 < reg.z1 && y2 <= y1 - 4) plate(g, x, z2, x, z2, y2, MAT.ledge);
        }
      }
    }
  }

  /* ---------- ② 环礁圈：大圈断续礁石，中间留潟湖 ---------- */
  const ringR = half * 0.86;
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * Math.PI * 2;
    if (noise(Math.cos(a) * 3.1, a * 2.3, Math.sin(a) * 3.1) < 0.44) continue;   // 断续
    const x = Math.round(cx + Math.cos(a) * ringR), z = Math.round(cz + Math.sin(a) * ringR);
    if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
    const hh = rng.int(1, 3);
    column(g, x, z, y0, Math.min(y1 - 2, y0 + hh), MAT.slab);
  }

  /* ---------- ③ 潟湖礁台：抬高的珊瑚台（可站） ---------- */
  const shelves = rng.int(3, 5);
  for (let i = 0; i < shelves; i++) {
    const p = pick2(rng, reg, 3);
    const y = y0 + rng.int(1, Math.max(1, h - 6));
    if (y + 5 > y1 || !deco.spend()) continue;
    const w = rng.int(1, 2);
    for (let z = p.z; z <= p.z + w && z < reg.z1; z++) {
      for (let x = p.x; x <= p.x + w && x < reg.x1; x++) plate(g, x, z, x, z, y, MAT.ledge);
    }
  }

  /* ---------- ④ 海葵 / 珊瑚枝（零散件） ---------- */
  const bits = rng.int(5, 9);
  for (let i = 0; i < bits; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    const hh = rng.int(1, 2);
    for (let k = 1; k <= hh; k++) {
      const y = y0 + k;
      if (y >= y1 - 1) break;
      if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.block);
    }
    if (p.x + 1 < reg.x1) plate(g, p.x + 1, p.z, p.x + 1, p.z, y0 + 1, MAT.block);   // 侧枝
  }
}