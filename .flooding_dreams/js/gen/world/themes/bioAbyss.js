/* ============================================================
   主题白模 · 生物荧渊（bioAbyss）
   ------------------------------------------------------------
   主题身份词：暗层、荧光层、热泉、荧光菌丘、巨藻柱、发光水母。
   「荧渊要有荧渊的样子」= 这套构造必须给出：
     · **不规则岩腔**：噪声腔壁围出一个腔体（不是方盒子），顶底都长钟乳/石笋
     · **巨藻柱 / 荧光柱**：从底贯到顶的细柱，柱头有可站立的荧光囊 ——
       这是深渊里最地道的跑酷：绕着发光柱盘旋往上
     · **热泉 / 水腔**：地板上掏出的水盆，留给涨水与游泳
     · **悬空孢子台**：零散的薄板，飘在腔体各处（观感 + 落点）
   结构倾向（智能搭配）：洞穴 ↔ 竖井（全暗、幽闭），难度越高越往下探。
   ============================================================ */
import { MAT, plate, solid, carve, column, blob, pick2, clip, topOf } from './common.js';

export const style = 'rock';
export const label = '生物荧渊';
export const structures = ['shaft', 'cavern', 'sheltered'];
/** 结构节奏：两带一循环 —— 「竖井 ↔ 岩腔」交替，暗层与荧光层互相嵌套 */
export const rhythm = 'duplex';
export const depth = 0.75;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（石笋 / 钟乳 / 孢子台）：它们一格一格、合并不掉，是体块数的主要来源
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const cx = (reg.x0 + reg.x1) / 2;
  const cz = (reg.z0 + reg.z1) / 2;
  const half = Math.min(reg.x1 - reg.x0, reg.z1 - reg.z0) / 2;
  const openness = Math.min(1, Math.max(0, Number(band.shell.openness) || 0.25));

  /* ---------- ① 不规则岩腔 ----------
     腔半径随外壳开阔度变化；腔壁用噪声扰动，于是「该开的地方开、该合的地方合」。
     ★ 只在腔体外围砌一圈 **有限厚度** 的岩壁（R*0.7 ~ R*1.35），再往外留空 ——
       外圈由封壳层负责；否则整带被填成一块石头（实体占比 0.5，逼着体素边长变粗）。 */
  const R = half * (0.7 + openness * 0.3);
  for (let z = reg.z0; z <= reg.z1; z++) {
    for (let x = reg.x0; x <= reg.x1; x++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d < R * 0.78 || d > R * 1.22) continue;        // 腔心空气 / 壁外留空
      for (let y = y0; y <= y1; y++) {
        const n = noise(x * 0.16, y * 0.13 + band.i * 3.1, z * 0.16);
        if (d < R * (0.92 + (n - 0.5) * 0.4)) continue;    // 噪声腔壁：能开也能合
        solid(g, x, y, z, x, y, z, MAT.wall);
      }
    }
  }

  /* ---------- ② 地板 / 顶板：石笋与钟乳 ---------- */
  for (let z = reg.z0 + 1; z < reg.z1; z++) {
    for (let x = reg.x0 + 1; x < reg.x1; x++) {
      if (Math.hypot(x - cx, z - cz) > R * 0.95) continue;
      if (rng.chance(0.07)) {
        const h = rng.int(1, 3);
        if (deco.spend()) column(g, x, z, y0, Math.min(y1 - 1, y0 + h), MAT.block);   // 石笋
      } else if (rng.chance(0.055)) {
        const h = rng.int(1, 3);
        if (deco.spend()) column(g, x, z, Math.max(y0 + 1, y1 - h), y1, MAT.block);   // 钟乳
      }
    }
  }

  /* ---------- ③ 巨藻柱 / 荧光柱（地标 + 落点） ---------- */
  const pillars = rng.int(2, 4);
  for (let i = 0; i < pillars; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const r = rng.range(0.15, 0.62) * half;
    const px = Math.round(cx + Math.cos(ang) * r);
    const pz = Math.round(cz + Math.sin(ang) * r);
    if (px <= reg.x0 || px >= reg.x1 || pz <= reg.z0 || pz >= reg.z1) continue;
    const w = rng.chance(0.3) ? 2 : 1;
    solid(g, px, y0 + 1, pz, px + w - 1, y1 - 1, pz + w - 1, MAT.col);
    // 柱头荧光囊：可站立，形状不规则
    blob(g, px + (w - 1) / 2, y1 - 1, pz + (w - 1) / 2, 1.6, 1.0, 1.6, MAT.ledge);
    // 柱身每隔几格伸出一圈「叶台」——盘旋上行的落脚点
    for (let y = y0 + 2; y < y1 - 1; y += rng.int(4, 5)) {
      const side = rng.sign();
      plate(g, px - 1, pz, px + w, pz, y, MAT.ledge);
      if (side < 0) plate(g, px, pz - 1, px, pz + w, y, MAT.ledge);
    }
  }

  /* ---------- ④ 悬空孢子台 ---------- */
  const pads = rng.int(3, 6);
  for (let i = 0; i < pads; i++) {
    const p = pick2(rng, reg, 3);
    const y = y0 + rng.int(1, Math.max(1, y1 - y0 - 2));
    const w = rng.int(1, 3), d = rng.int(1, 3);
    if (!deco.spend()) break;
    for (let z = p.z; z < p.z + d && z < reg.z1; z++) {
      for (let x = p.x; x < p.x + w && x < reg.x1; x++) {
        if (g.occ[(z * g.ny + y) * g.nx + x]) continue;
        if (g.occ[(z * g.ny + (y - 1)) * g.nx + x]) continue;   // 底下要空 → 真的是「悬空」
        plate(g, x, z, x, z, y, MAT.ledge);
      }
    }
  }

  /* ---------- ⑤ 热泉水盆：掏一个浅盆，交给涨水/游泳用 ---------- */
  if (rng.chance(0.75)) {
    const p = pick2(rng, reg, 5);
    const w = rng.int(3, 6);
    // 只在地板那一带掏，别把腔壁掏穿
    const floorTop = topOf(g, p.x, p.z, y0 - 1, y0 + 3);
    const bot = Math.max(y0 - 2, floorTop - rng.int(2, 4));
    for (let z = p.z; z < p.z + w && z < reg.z1; z++) {
      for (let x = p.x; x < p.x + w && x < reg.x1; x++) {
        carve(g, x, bot, z, x, floorTop, z);
      }
    }
    // 盆地：给水留底
    plate(g, p.x - 1, p.z - 1, Math.min(reg.x1, p.x + w), Math.min(reg.z1, p.z + w), bot - 1, MAT.block);
  }
}