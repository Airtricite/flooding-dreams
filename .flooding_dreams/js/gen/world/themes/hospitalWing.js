/* ============================================================
   主题白模 · 废弃病栋（hospitalWing）
   ------------------------------------------------------------
   主题身份词：病房隔间、病床、走廊、手术灯、担架坡。
   「病栋」的几何主意 = **一排排小隔间 + 一条主走廊**：
     · 沿一个方向用隔墙切出一排**同模数的隔间**，每间里一张抬高两格的床台
     · 隔间之间留一条贯通的主走廊（正对灯带）
     · 廊顶吊一盏**手术灯**（长杆 + 圆形灯盘）
   结构倾向（智能搭配）：室内 → 洞穴（越难越像陷进地下的旧病栋）。
   ============================================================ */
import { MAT, plate, column, blob, pick2, clip, isFree } from './common.js';

export const style = 'building';
export const label = '废弃病栋';
export const structures = ['cavern', 'indoor'];
export const depth = 0.85;

export function build(c) {
  const { g, reg: raw, band, rng } = c;
  // ★ 零散件配额（病床 / 轮椅 / 消毒柜）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 6) return;
  const M = 6;                                            // 隔间模数（格）
  const along = rng.chance(0.5) ? 'x' : 'z';
  const a0 = along === 'x' ? reg.x0 : reg.z0;
  const a1 = along === 'x' ? reg.x1 : reg.z1;
  const b0 = along === 'x' ? reg.z0 : reg.x0;
  const b1 = along === 'x' ? reg.z1 : reg.x1;
  const wallH = Math.min(y1 - 2, y0 + Math.max(3, Math.round(h * 0.55)));
  const aisleB = b0 + 1;                                  // 主走廊（贴一侧）

  /* ---------- ① 病房隔间：隔墙按模数切开，每间一张抬高床台 ---------- */
  for (let a = a0 + 1; a <= a1 - 1; a++) {
    const isWall = ((a - a0) % M) === 0;
    if (isWall) {
      for (let b = aisleB + 2; b <= b1 - 1; b++) {         // 隔墙（走廊一侧留开口）
        for (let y = y0 + 1; y <= wallH; y++) {
          const x = along === 'x' ? a : b;
          const z = along === 'x' ? b : a;
          if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
          if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.wall);
        }
      }
    }
    // 床台：每间靠里侧摆一张抬高两格的床（可站）
    const cellIdx = Math.floor((a - a0) / M);
    if (!isWall && ((a - a0) % M) === Math.floor(M / 2) && cellIdx % 1 === 0) {
      const b = b1 - 2;
      const x = along === 'x' ? a : b;
      const z = along === 'x' ? b : a;
      if (x > reg.x0 && x < reg.x1 && z > reg.z0 && z < reg.z1 && h >= 8) {
        for (let k = 0; k <= 1; k++) {
          const xx = along === 'x' ? x + k : x, zz = along === 'x' ? z : z + k;
          if (isFree(g, xx, y0 + 2, zz)) {
            plate(g, xx, zz, xx, zz, y0 + 2, MAT.slab);    // 床面
            plate(g, xx, zz, xx, zz, y0 + 1, MAT.block);   // 床体
          }
        }
        // 床头隔板（观感）
        if (deco.spend()) {
          const bx = along === 'x' ? x + 2 : x, bz = along === 'x' ? z : z + 2;
          if (bx < reg.x1 && bz < reg.z1 && isFree(g, bx, y0 + 3, bz)) plate(g, bx, bz, bx, bz, y0 + 3, MAT.wall);
        }
      }
    }
  }

  /* ---------- ② 主走廊：抬一格的走道（贯穿全带） ---------- */
  if (h >= 7) {
    for (let a = a0 + 1; a <= a1 - 1; a++) {
      for (let k = 0; k <= 1; k++) {
        const b = aisleB + k;
        const x = along === 'x' ? a : b;
        const z = along === 'x' ? b : a;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        if (isFree(g, x, y0 + 1, z)) {
          plate(g, x, z, x, z, y0 + 1, MAT.slab);
          plate(g, x, z, x, z, y0, MAT.block);
        }
      }
    }
  }

  /* ---------- ③ 手术灯：长杆 + 圆形灯盘（悬在走廊上方） ---------- */
  const la = a0 + rng.int(3, Math.max(3, a1 - a0 - 3));
  const lb = aisleB + 1;
  const lx = along === 'x' ? la : lb;
  const lz = along === 'x' ? lb : la;
  if (lx > reg.x0 && lx < reg.x1 && lz > reg.z0 && lz < reg.z1 && h >= 9) {
    const armTop = Math.min(y1 - 1, y0 + Math.round(h * 0.85));
    const armBot = y0 + 5;
    if (armBot < armTop) {
      column(g, lx, lz, armBot, armTop, MAT.col);
      blob(g, lx, armBot - 1, lz, 1.4, 0.6, 1.4, MAT.ledge);      // 灯盘（可站）
    }
  }

  /* ---------- ④ 担架坡：一段上下的斜板 ---------- */
  if (rng.chance(0.7) && h >= 8) {
    let b = aisleB + 2;
    const a = a0 + rng.int(2, Math.max(2, a1 - a0 - 6));
    for (let t = 0; t < 4; t++) {
      const y = y0 + 3 - t;
      const x = along === 'x' ? a + t : b;
      const z = along === 'x' ? b : a + t;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1 || y <= y0 + 1) break;
      if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.ledge);
    }
  }

  /* ---------- ⑤ 轮椅 / 消毒柜（零散件） ---------- */
  const bits = rng.int(4, 8);
  for (let i = 0; i < bits; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    const hh = rng.int(1, 2);
    for (let k = 1; k <= hh; k++) {
      const y = y0 + k;
      if (y >= y1 - 1) break;
      if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.block);
    }
  }
}