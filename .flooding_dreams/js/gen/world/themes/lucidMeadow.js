/* ============================================================
   主题白模 · 清醒草原（lucidMeadow）
   ------------------------------------------------------------
   主题身份词：缓坡、花海、孤树、木栅、风车、云影。
   「草原要有草原的样子」= 这套构造必须给出：
     · **起伏的草坡**（噪声地形，坡度平缓，能一路跑上去）
     · **孤树**：树干 + 3×3 可站立的树冠 —— 天然「在树顶之间跳」的跑酷
     · **花海**：成片的抬高花圃（薄板，能站），既是装饰也是落点
     · **木栅 / 干砌石墙 / 风车**：低矮的人造物，给旷野一点尺度参照
   构造上刻意**留白**：草原是开阔的，绝大部分体积是空气，
   跑酷配置才有地方「排布」进去（见 route.js）。

   结构倾向（智能搭配）：露天 → 开阔。草原不长洞穴。
   ============================================================ */
import { MAT, plate, carve, column, blob, pick2, clip, topOf } from './common.js';

export const style = 'meadow';
export const label = '清醒草原';
/** 世界结构的智能搭配阶梯（按开阔度升序；难度决定从哪一层起） */
export const structures = ['sheltered', 'outdoor', 'openAir'];
/** 难度 1 时从阶梯的哪一档起（越难越往下探，越幽闭） */
export const depth = 0.34;

export function build(c) {
  const { g, reg: raw, band, rng, noise, cell } = c;
  // ★ 零散件配额（花圃 / 木栅 / 云影）：孤立小件合并不掉，一件就是一个方块
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0;

  /* ---------- ① 起伏草坡 ----------
     噪声决定厚度（1~2 体素），从 reg.y0 **往下**长 —— 顶面始终是平的，
     于是「草坡」是一层缓起伏的地被，而不是一串尖山（尖山会吃掉净空）。 */
  for (let z = reg.z0; z <= reg.z1; z++) {
    for (let x = reg.x0; x <= reg.x1; x++) {
      const n = noise(x * 0.14 + band.i * 13.7, 0.35, z * 0.14 - band.i * 7.1);
      const bump = n > 0.62 ? 1 : 0;
      for (let k = 0; k <= bump; k++) {
        plate(g, x, z, x, z, y0 - k, k === bump ? MAT.slab : MAT.block);
      }
    }
  }

  /* ---------- ② 花海：成片的抬高花圃（薄板，可站） ---------- */
  const beds = rng.int(3, 6);
  for (let i = 0; i < beds; i++) {
    const p = pick2(rng, reg, 3);
    const w = rng.int(2, 4), d = rng.int(2, 4);
    const y = y0 + rng.int(1, 2);
    if (!deco.spend()) break;
    // 花圃是「浮起的花毯」：只在有空的地方铺，绝不叠死
    for (let z = p.z; z < p.z + d && z <= reg.z1; z++) {
      for (let x = p.x; x < p.x + w && x <= reg.x1; x++) {
        if (g.occ[(z * g.ny + y) * g.nx + x]) continue;
        if (g.occ[(z * g.ny + (y - 1)) * g.nx + x]) continue;
        plate(g, x, z, x, z, y, MAT.ledge);
      }
    }
  }

  /* ---------- ③ 孤树：树干 + 可站立的树冠 ----------
     ★ 树冠离地 ≥ 4 体素（≥ 20 stud）：脚下的草坡仍然是合格落点。 */
  const trees = rng.int(2, 4);
  for (let i = 0; i < trees; i++) {
    const p = pick2(rng, reg, 3);
    const base = topOf(g, p.x, p.z, reg.y0 - 2, reg.y1) + 1;
    const h = rng.int(3, 5);
    const top = Math.min(reg.y1, base + h);
    if (top - base < 2) continue;
    column(g, p.x, p.z, base, top, MAT.col);
    // 树冠：3×3（偶尔 5×5），一层到两层 —— 站上去就是「树顶跳跃」
    const r = rng.chance(0.3) ? 2 : 1;
    blob(g, p.x, top + 1, p.z, r, 1.1, r, MAT.ledge);
    if (rng.chance(0.35)) blob(g, p.x, top + 2, p.z, r - 0.4, 0.9, r - 0.4, MAT.ledge);
  }

  /* ---------- ④ 木栅 / 干砌石墙：低矮人造物 ---------- */
  const walls = rng.int(1, 3);
  for (let i = 0; i < walls; i++) {
    const p = pick2(rng, reg, 4);
    const len = rng.int(3, 7);
    const along = rng.sign();
    const h = rng.int(1, 2);
    if (!deco.spend()) break;
    for (let k = 0; k < len; k++) {
      const x = along > 0 ? p.x + k : p.x;
      const z = along > 0 ? p.z : p.z + k;
      if (x > reg.x1 || z > reg.z1) break;
      for (let y = y0 + 1; y <= y0 + h; y++) {
        if (!g.occ[(z * g.ny + y) * g.nx + x]) plate(g, x, z, x, z, y, MAT.wall);
      }
    }
  }

  /* ---------- ⑤ 风车：一根高塔 + 顶上的平台（地标 + 落点） ---------- */
  if (rng.chance(0.55)) {
    const p = pick2(rng, reg, 5);
    const base = topOf(g, p.x, p.z, reg.y0 - 2, reg.y1) + 1;
    const top = Math.min(reg.y1 - 1, base + rng.int(3, 5));
    column(g, p.x, p.z, base, top, MAT.col);
    plate(g, p.x - 1, p.z - 1, p.x + 1, p.z + 1, top, MAT.ledge);   // 平台
    // 扇叶：两根细横梁（纯观感）
    for (const d of [-1, 1]) {
      plate(g, p.x + d * 2, p.z, p.x + d * 2, p.z, top - 1, MAT.wall);
    }
  }

  /* ---------- ⑥ 云影：一小片悬空的薄云台（可观感、可落脚） ---------- */
  if (rng.chance(0.45)) {
    const p = pick2(rng, reg, 5);
    const y = Math.min(reg.y1 - 1, y0 + rng.int(3, 5));
    const w = rng.int(2, 4);
    if (deco.spend()) {
      for (let z = p.z; z < p.z + 2 && z <= reg.z1; z++) {
        for (let x = p.x; x < p.x + w && x <= reg.x1; x++) {
          if (!g.occ[(z * g.ny + y) * g.nx + x]) plate(g, x, z, x, z, y, MAT.ledge);
        }
      }
    }
  }

  /* ---------- ⑦ 排水沟：一条浅沟（给「局部下降」与涨水留地形） ---------- */
  if (band.i === 0) {
    const p = pick2(rng, reg, 6);
    carve(g, p.x, y0 - 2, p.z, Math.min(reg.x1, p.x + rng.int(4, 7)), y0, p.z + 1);
  }
}