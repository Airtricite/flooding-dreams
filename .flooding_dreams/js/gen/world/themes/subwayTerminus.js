/* ============================================================
   主题白模 · 地铁终点站（subwayTerminus）
   ------------------------------------------------------------
   主题身份词：月台、轨道沟、隧道拱肋、楼梯、指示灯箱。
   「地铁终点站」的几何主意 = **长向的剖面**：
     横截面永远是「月台 - 轨道沟 - 月台」三段，沿 z 一直延伸 ——
     · 中间挖一条下沉的轨道沟（沟底铺石），两侧抬一格的月台面
     · 每隔几格一榀**拱肋**（两侧立柱 + 顶部弧形肋）
     · 月台末端一段**楼梯**下到轨面
   结构倾向（智能搭配）：室内 → 竖井 → 半封闭。
   ============================================================ */
import { MAT, plate, carve, column, pick2, clip, isFree } from './common.js';

export const style = 'building';
export const label = '地铁终点站';
export const structures = ['shaft', 'indoor', 'sheltered'];
export const depth = 0.85;

export function build(c) {
  const { g, reg: raw, band, rng } = c;
  // ★ 零散件配额（指示牌 / 长椅 / 灯带段）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = y1 - y0;
  const midX = reg.x0 + Math.round((reg.x1 - reg.x0) / 2);
  const rail = Math.max(1, Math.min(2, Math.round((reg.x1 - reg.x0) * 0.12)));

  /* ---------- ① 轨道沟：中间一条下沉的沟，沟底铺石 ---------- */
  for (let z = reg.z0 + 1; z <= reg.z1 - 1; z++) {
    for (let x = midX - rail; x <= midX + rail; x++) {
      if (x <= reg.x0 || x >= reg.x1) continue;
      carve(g, x, Math.max(0, y0 - 2), z, x, y0, z);
      plate(g, x, z, x, z, y0 - 3, MAT.block);                    // 沟底
    }
  }

  /* ---------- ② 拱肋：两侧立柱 + 顶部弧形肋（一条条隧道环） ---------- */
  const baseY = y0 + 6;
  if (baseY < y1 - 1) {
    const x0 = reg.x0 + 1, x1 = reg.x1 - 1;
    for (let z = reg.z0 + 2; z <= reg.z1 - 2; z += 4) {
      for (let x = x0; x <= x1; x++) {
        const t = (x - x0) / Math.max(1, x1 - x0);
        const y = Math.min(y1 - 1, baseY + Math.round(Math.sin(t * Math.PI) * 3));
        if (!g.occ[(z * g.ny + y) * g.nx + x]) plate(g, x, z, x, z, y, MAT.roof);   // 肋
        if ((x === x0 || x === x1) && isFree(g, x, y0 + 2, z)) {
          column(g, x, z, y0 + 2, y - 1, MAT.wall);               // 侧柱
        }
      }
    }
  }

  /* ---------- ③ 月台：轨道沟两侧抬一格的平台（可站） ---------- */
  for (let z = reg.z0 + 1; z <= reg.z1 - 1; z++) {
    for (let x = reg.x0 + 1; x <= reg.x1 - 1; x++) {
      const dx = Math.abs(x - midX);
      if (dx <= rail || dx > rail + 3) continue;
      if (y0 + 6 > y1 - 1) break;                                 // 净空不够就不铺
      if (!g.occ[(z * g.ny + (y0 + 1)) * g.nx + x] && isFree(g, x, y0 + 1, z)) {
        plate(g, x, z, x, z, y0 + 1, MAT.slab);                   // 月台面
        plate(g, x, z, x, z, y0, MAT.block);                      // 月台体
      }
    }
  }

  /* ---------- ④ 楼梯：月台末端下到轨面的一段台阶 ---------- */
  const sz = reg.z0 + rng.int(2, Math.max(2, reg.z1 - reg.z0 - 4));
  const sx = midX + (rail + 1);
  for (let t = 0; t < 3; t++) {
    const y = y0 + 1 - t;
    if (y <= y0 - 3 || sx >= reg.x1 || sz + t >= reg.z1) break;
    for (let k = 0; k <= 1; k++) {
      if (isFree(g, sx, y, sz + t + k)) plate(g, sx, sz + t + k, sx, sz + t + k, y, MAT.ledge);
    }
  }

  /* ---------- ⑤ 指示牌 / 长椅 / 灯带段（零散件） ---------- */
  const bits = rng.int(4, 8);
  for (let i = 0; i < bits; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    if (rng.chance(0.5)) {
      const x = Math.abs(p.x - midX) > rail + 3 ? p.x : p.x + rail + 3;   // 落在月台上
      if (x < reg.x1 - 1 && y0 + 2 < y1 - 1 && isFree(g, x, y0 + 2, p.z)) {
        plate(g, x, p.z, x, p.z, y0 + 2, MAT.ledge);              // 长椅
      }
    } else {
      const y = y1 - 1;
      if (y - 1 > baseY && isFree(g, p.x, y - 1, p.z)) plate(g, p.x, p.z, p.x, p.z, y - 1, MAT.ledge);   // 灯带段
    }
  }
}