/* ============================================================
   主题白模 · 火山脊（volcanicRidge）
   ------------------------------------------------------------
   主题身份词：阶梯熔岩台地、火山口环形壁、辐射熔岩沟、黑曜石柱。
   「火山脊」的几何主意 = **同心阶梯 + 环形堤**：
     · 一层层**向外扩张**的环状台地（每层抬高几格）→ 绕着火山口盘旋而上
     · 最外圈一圈高耸的**火山口环形壁**，只留一个缺口（破口）
     · 一条从口心辐射出去的**熔岩沟**（挖下去的浅槽）
   结构倾向（智能搭配）：洞穴 → 半封闭 → 露天 → 开阔。
   ============================================================ */
import { MAT, plate, carve, column, pick2, clip, topOf } from './common.js';

export const style = 'rock';
export const label = '火山脊';
export const structures = ['cavern', 'sheltered', 'outdoor', 'openAir'];
export const depth = 0.6;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（熔岩弹 / 黑曜石柱）
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const cx = (reg.x0 + reg.x1) / 2, cz = (reg.z0 + reg.z1) / 2;
  const half = Math.max(4, Math.min(reg.x1 - reg.x0, reg.z1 - reg.z0) / 2);
  const h = Math.max(4, y1 - y0);

  /* ---------- ① 阶梯熔岩台地：环套环、越外越高 ----------
     每层是**环带**（不是圆盘），所以台地正上方永远是火山口空腔 → 逐级可站可跳。 */
  const tiers = Math.min(4, Math.max(2, Math.round(h / 5)));
  for (let t = 0; t < tiers; t++) {
    const y = y0 + 1 + t * Math.max(3, Math.round(h * 0.14));
    if (y >= y1 - 5) break;
    const r0 = half * (0.12 + t * 0.22);
    const r1 = r0 + Math.max(2, half * 0.22);
    for (let z = reg.z0 + 1; z <= reg.z1 - 1; z++) {
      for (let x = reg.x0 + 1; x <= reg.x1 - 1; x++) {
        const d = Math.hypot(x - cx, z - cz);
        if (d < r0 || d > r1) continue;
        // 噪声啃掉一段段边缘 → 台地是「破碎的岩檐」，不是完美圆环
        if (noise(x * 0.2 + t * 5.3, t * 2.1, z * 0.2) < 0.44) continue;
        if (g.occ[(z * g.ny + y) * g.nx + x]) continue;
        plate(g, x, z, x, z, y, t === 0 ? MAT.slab : MAT.ledge);
      }
    }
  }

  /* ---------- ② 火山口环形壁：外圈高墙，只在一处留缺口 ---------- */
  const wallR = half * 0.92;
  const gapA = rng.range(0, Math.PI * 2);
  const wallH = Math.max(3, Math.round(h * 0.4));
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const da = Math.abs(((a - gapA + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (da < 0.5) continue;                                   // 破口
    const x = Math.round(cx + Math.cos(a) * wallR), z = Math.round(cz + Math.sin(a) * wallR);
    if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
    const extra = noise(x * 0.3, a * 3.1, z * 0.3) > 0.55 ? 2 : 0;
    column(g, x, z, y0, Math.min(y1 - 1, y0 + wallH + extra), MAT.wall);
  }

  /* ---------- ③ 辐射熔岩沟：从口心向外的一条下切浅槽 ---------- */
  const dir = rng.range(0, Math.PI * 2);
  for (let r = 2; r <= half + 1; r++) {
    const x = Math.round(cx + Math.cos(dir) * r), z = Math.round(cz + Math.sin(dir) * r);
    if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
    for (let dy = 0; dy <= 2; dy++) carve(g, x, y0 - dy, z, x, y0 - dy, z);
  }

  /* ---------- ④ 熔岩弹 / 黑曜石柱（零散件） ---------- */
  const rocks = rng.int(5, 9);
  for (let i = 0; i < rocks; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    const kind = rng.int(0, 2);
    if (kind === 0) {
      const y = y0 + rng.int(2, Math.max(2, h - 3));          // 悬浮熔岩弹
      if (y < y1 - 1) plate(g, p.x, p.z, p.x, p.z, y, MAT.block);
    } else if (kind === 1) {
      const base = topOf(g, p.x, p.z, y0 - 2, y1) + 1;
      const hh = rng.int(2, 3);
      if (base + hh < y1 - 1) column(g, p.x, p.z, base, base + hh, MAT.col);
    } else {
      for (let k = -1; k <= 1; k++) {                         // 玄武岩柱三连
        const x = p.x + k;
        if (x <= reg.x0 || x >= reg.x1) continue;
        const base = topOf(g, x, p.z, y0 - 2, y1) + 1;
        if (base + 2 < y1 - 1) column(g, x, p.z, base, base + rng.int(2, 3), MAT.col);
      }
    }
  }
}