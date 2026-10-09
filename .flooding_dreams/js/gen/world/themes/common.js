/* ============================================================
   主题白模 · 公共画笔
   ------------------------------------------------------------
   每个主题一个文件（lucidMeadow / drownedCity / bioAbyss / liminalHall），
   它们**直接写体素**，不再共用一套「风格 × 结构」的通用文法 ——
   于是「草原像草原、城市像城市」是构造出来的，而不是交叉出来的。

   本文件只提供与 voxel.js 之间的薄封装（越界自动裁、坐标系一致），
   所有主题都从这里拿画笔，保证口径统一。

   坐标约定：全部是**体素索引**（x, y, z），单位 voxel，边长 = g.cell。
   ============================================================ */
import { setSolid, clearSolid, fillBoxIdx, clearBoxIdx, inGrid } from '../voxel.js';

/** 体块材质槽位（与 whitebox.js 的 MAT 同源，只影响配色分层） */
export const MAT = { wall: 0, col: 1, slab: 2, roof: 3, block: 4, ledge: 5 };

export const ri = (v) => Math.round(Number(v) || 0);

/** 单格实心 */
export function put(g, x, y, z, m = MAT.wall) { return setSolid(g, x, y, z, m); }

/** 单格挖空 */
export function cut(g, x, y, z) { return clearSolid(g, x, y, z); }

/** 实心长方体（含端点） */
export function solid(g, x0, y0, z0, x1, y1, z1, m = MAT.wall) {
  fillBoxIdx(g, x0, y0, z0, x1, y1, z1, m);
}

/** 挖空长方体（含端点） */
export function carve(g, x0, y0, z0, x1, y1, z1) {
  clearBoxIdx(g, x0, y0, z0, x1, y1, z1);
}

/** 一层水平板 */
export function plate(g, x0, z0, x1, z1, y, m = MAT.slab) {
  if (!inGrid(g, x0, y, z0)) return;
  fillBoxIdx(g, x0, y, z0, x1, y, z1, m);
}

/** 一根竖柱 */
export function column(g, x, z, y0, y1, m = MAT.col) {
  for (let y = y0; y <= y1; y++) setSolid(g, x, y, z, m);
}

/** 椭球团块（树冠 / 岩瘤 / 荧光囊） */
export function blob(g, cx, cy, cz, rx, ry, rz, m = MAT.ledge) {
  const x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx);
  const y0 = Math.floor(cy - ry), y1 = Math.ceil(cy + ry);
  const z0 = Math.floor(cz - rz), z1 = Math.ceil(cz + rz);
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / Math.max(0.4, rx);
        const dy = (y - cy) / Math.max(0.4, ry);
        const dz = (z - cz) / Math.max(0.4, rz);
        if (dx * dx + dy * dy + dz * dz <= 1) setSolid(g, x, y, z, m);
      }
    }
  }
}

/** 把区域裁到格子内，返回安全端点（很多主题要在边界上画东西） */
export function clip(g, reg) {
  return {
    x0: Math.max(1, reg.x0), x1: Math.min(g.nx - 2, reg.x1),
    y0: Math.max(1, reg.y0), y1: Math.min(g.ny - 2, reg.y1),
    z0: Math.max(1, reg.z0), z1: Math.min(g.nz - 2, reg.z1),
  };
}

/** 区域内随机取个点（整数体素） */
export function pick2(rng, reg, margin = 1) {
  return {
    x: rng.int(reg.x0 + margin, Math.max(reg.x0 + margin, reg.x1 - margin)),
    z: rng.int(reg.z0 + margin, Math.max(reg.z0 + margin, reg.z1 - margin)),
  };
}

/** 这片格子上方是不是「空」的（主题画东西前先确认不叠死） */
export function isFree(g, x, y, z) { return inGrid(g, x, y, z) && !g.occ[(z * g.ny + y) * g.nx + x]; }

/** 从 y 往上找第一格实心的顶面（没有就返回 y0） */
export function topOf(g, x, z, y0, y1) {
  for (let y = y1; y >= y0; y--) if (g.occ[(z * g.ny + y) * g.nx + x]) return y;
  return y0 - 1;
}

/* ============================================================
   「零散件」配额
   ------------------------------------------------------------
   石笋 / 钟乳 / 花圃 / 路标杆 / 灯带 … 这类**一格一格、彼此孤立**的小件，
   三维贪心合并几乎合不掉 —— 一件就是最终一个方块。它们才是体块预算失控的
   真凶（荧渊一条带就能长出七八十根石笋）。于是给每一次主题 build 发一个配额，
   每投一件都要 spend()，配额用完这一类件就自然停手：
   世界更干净，体块数也不再被零散件顶穿 MAX_BOXES。
   ============================================================ */
export function makeDeco(cap) {
  const n = Math.max(0, Math.round(Number(cap) || 0));
  let used = 0;
  return {
    cap: n,
    get used() { return used; },
    get left() { return Math.max(0, n - used); },
    /** 试着投 k 件；配额不够返回 false（调用方就别投了） */
    spend(k = 1) { if (used + k > n) return false; used += k; return true; },
  };
}