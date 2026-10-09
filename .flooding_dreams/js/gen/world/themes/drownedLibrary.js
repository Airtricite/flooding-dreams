/* ============================================================
   主题白模 · 沉没图书馆（drownedLibrary）
   ------------------------------------------------------------
   主题身份词：书架巷道、阶梯阅览台、下沉水池、吊灯、纸页。
   「图书馆」的几何主意 = **平行的书架墙 + 外挑搁板**：
     · 一道道的书架墙按模数平行排列，夹出一条条巷道
     · 每面书架墙上每隔两层**外挑一格搁板** → 书架的分层轮廓（也是落脚点）
     · 巷道尽头一座**阶梯阅览台**（层层抬高的看台）
     · 底层掏一片下沉水池（涨水/游泳发生在这里）
   结构倾向（智能搭配）：洞穴 → 竖井 → 半封闭（越难越像泡在水里的旧馆）。
   ============================================================ */
import { MAT, plate, carve, column, pick2, clip, isFree } from './common.js';

export const style = 'building';
export const label = '沉没图书馆';
export const structures = ['shaft', 'cavern', 'sheltered'];
export const depth = 0.7;

export function build(c) {
  const { g, reg: raw, band, rng } = c;
  // ★ 零散件配额（书堆 / 烛台 / 吊灯）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  if (h < 7) return;
  const M = 5;                                            // 书架间距（格）
  const along = rng.chance(0.5) ? 'x' : 'z';
  const a0 = along === 'x' ? reg.x0 : reg.z0;
  const a1 = along === 'x' ? reg.x1 : reg.z1;
  const b0 = along === 'x' ? reg.z0 : reg.x0;
  const b1 = along === 'x' ? reg.z1 : reg.x1;
  const wallH = Math.min(y1 - 2, y0 + Math.max(4, Math.round(h * 0.62)));

  /* ---------- ① 书架墙：平行排开的高墙 ---------- */
  for (let b = b0 + 2; b <= b1 - 2; b += M) {
    for (let a = a0 + 1; a <= a1 - 1; a++) {
      for (let y = y0 + 1; y <= wallH; y++) {
        const x = along === 'x' ? a : b;
        const z = along === 'x' ? b : a;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
        if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.wall);
      }
      /* ---------- ② 外挑搁板：每隔两层向巷道伸出一格 ---------- */
      for (let y = y0 + 3; y <= wallH - 1; y += 3) {
        for (const side of [-1, 1]) {
          const bb = b + side;
          if (bb <= reg.z0 || bb >= reg.z1) continue;
          const x = along === 'x' ? a : bb;
          const z = along === 'x' ? bb : a;
          if (x <= reg.x0 || x >= reg.x1) continue;
          if (!deco.spend()) break;
          if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.ledge);
        }
      }
    }
  }

  /* ---------- ③ 阶梯阅览台：尽头一座层层抬高的看台 ---------- */
  const tiers = Math.min(4, Math.max(2, Math.round(h / 4)));
  for (let t = 0; t < tiers; t++) {
    const bb = b1 - 2 - t;
    if (bb <= b0 + 1) break;
    const y = y0 + 1 + t;
    if (y + 5 > y1) break;
    for (let a = a0 + 1; a <= a1 - 1; a++) {
      const x = along === 'x' ? a : bb;
      const z = along === 'x' ? bb : a;
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      if (isFree(g, x, y, z)) plate(g, x, z, x, z, y, MAT.slab);
      if (isFree(g, x, y - 1, z)) plate(g, x, z, x, z, y - 1, MAT.block);
    }
  }

  /* ---------- ④ 下沉水池：底层掏一片浅池 ---------- */
  if (rng.chance(0.8)) {
    const p = pick2(rng, reg, 4);
    const w = rng.int(3, 5);
    const x1 = Math.min(reg.x1 - 1, p.x + w), z1 = Math.min(reg.z1 - 1, p.z + w);
    for (let z = p.z; z <= z1; z++) {
      for (let x = p.x; x <= x1; x++) carve(g, x, y0 - 2, z, x, y0, z);
    }
    plate(g, p.x - 1, p.z - 1, Math.min(reg.x1 - 1, x1 + 1), Math.min(reg.z1 - 1, z1 + 1), y0 - 3, MAT.block);   // 池底
  }

  /* ---------- ⑤ 吊灯：从顶垂下的灯杆 + 灯盘 ---------- */
  const lamps = rng.int(2, 3);
  for (let i = 0; i < lamps; i++) {
    const p = pick2(rng, reg, 3);
    if (!deco.spend()) break;
    const ly = Math.min(y1 - 1, y0 + Math.round(h * 0.8));
    if (ly <= y0 + 5) break;
    column(g, p.x, p.z, ly, y1 - 1, MAT.col);
    if (isFree(g, p.x, ly - 1, p.z)) plate(g, p.x, p.z, p.x, p.z, ly - 1, MAT.ledge);
  }

  /* ---------- ⑥ 书堆 / 烛台（零散件） ---------- */
  const books = rng.int(4, 8);
  for (let i = 0; i < books; i++) {
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