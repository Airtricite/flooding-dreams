/* ============================================================
   主题白模 · 冰川峡湾（glacierFjord）
   ------------------------------------------------------------
   主题身份词：之字形峡壁、悬挑冰架、悬冰柱、浮冰块、深水航道。
   「冰川峡湾」的几何主意 = **两条之字形的壁 + 中间一条航道**：
     · 沿 z 走的两道平行壁，x 位置按正弦左右折返 → 水道是弯的（不是直筒）
     · 从壁上向航道内挑出的**冰架**（逐块抬高）—— 落脚就在悬挑上
     · 顶板上垂下一排悬冰柱，水里漂着浮冰
   结构倾向（智能搭配）：竖井 → 洞穴 → 半封闭 → 露天 → 开阔。
   ============================================================ */
import { MAT, solid, plate, column, pick2, clip, isFree } from './common.js';

export const style = 'rock';
export const label = '冰川峡湾';
export const structures = ['shaft', 'cavern', 'sheltered', 'outdoor', 'openAir'];
export const depth = 0.7;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（悬冰柱 / 浮冰）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const h = Math.max(3, y1 - y0);
  const span = reg.x1 - reg.x0;
  const mid = reg.x0 + Math.round(span / 2);
  const amp = Math.max(2, Math.round(span * 0.22));

  /* ---------- ① 之字形峡壁：两道左右折返的壁 ---------- */
  const wallH = Math.max(2, Math.round(h * 0.45));
  for (let z = reg.z0 + 1; z <= reg.z1 - 1; z++) {
    const wig = Math.round(Math.sin(z * 0.5 + band.i * 1.7) * amp * 0.5);
    for (const side of [-1, 1]) {
      const wx = mid + side * (amp + wig);
      if (wx <= reg.x0 || wx >= reg.x1) continue;
      column(g, wx, z, y0, Math.min(y1 - 2, y0 + wallH), MAT.wall);
    }
  }

  /* ---------- ② 悬挑冰架：从壁面向航道伸出的可站冰台 ---------- */
  const shelves = rng.int(4, 7);
  for (let i = 0; i < shelves; i++) {
    const side = rng.sign();
    const zz = reg.z0 + rng.int(2, Math.max(2, reg.z1 - reg.z0 - 3));
    const y = y0 + rng.int(2, Math.max(2, h - 6));
    if (y + 5 > y1 || !deco.spend()) continue;
    const out = Math.min(4, amp + 1);
    const wx = mid + side * (amp - 1);
    for (let k = 0; k <= out; k++) {
      const x = wx - side * k;
      if (x <= reg.x0 || x >= reg.x1) break;
      if (!g.occ[(zz * g.ny + y) * g.nx + x]) plate(g, x, zz, x, zz, y, MAT.ledge);
    }
  }

  /* ---------- ③ 悬冰柱：顶板垂下的冰锥 ---------- */
  const spikes = rng.int(6, 10);
  for (let i = 0; i < spikes; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    const len = rng.int(2, 4);
    for (let k = 0; k < len; k++) {
      const y = y1 - 1 - k;
      if (y <= y0 + 2) break;
      if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.block);
    }
  }

  /* ---------- ④ 浮冰块：航道上零散漂着的薄冰（可踩） ---------- */
  const floes = rng.int(3, 5);
  for (let i = 0; i < floes; i++) {
    const p = pick2(rng, reg, 3);
    const y = y0 + rng.int(1, Math.max(1, h - 6));
    if (y + 5 > y1) continue;
    const x1 = Math.min(reg.x1 - 1, p.x + 1), z1 = Math.min(reg.z1 - 1, p.z + 1);
    for (let z = p.z; z <= z1; z++) {
      for (let x = p.x; x <= x1; x++) {
        if (noise(x * 0.4, i * 2.2, z * 0.4) < 0.3) continue;   // 缺角 → 像浮冰
        plate(g, x, z, x, z, y, MAT.slab);
      }
    }
  }

  /* ---------- ⑤ 冰层断面：航道尽头一道横向冰坝（留缺口） ---------- */
  if (rng.chance(0.6)) {
    const zz = reg.z1 - reg.z0 > 6 ? reg.z1 - 2 : reg.z1 - 1;
    const gap = rng.int(reg.x0 + 1, Math.max(reg.x0 + 1, reg.x1 - 1));
    for (let x = reg.x0 + 1; x <= reg.x1 - 1; x++) {
      if (Math.abs(x - gap) < 2) continue;
      const hh = Math.min(y1 - 2, y0 + rng.int(2, Math.max(2, wallH)));
      solid(g, x, y0, zz, x, hh, zz, MAT.slab);
    }
  }
}