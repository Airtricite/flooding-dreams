/* ============================================================
   主题白模 · 水晶洞（crystalCavern）
   ------------------------------------------------------------
   主题身份词：放射晶簇、晶柱穹顶、地心晶核、碎晶 beach。
   「水晶洞」的几何主意 = **放射状**：
     · 一圈向内倾斜的晶柱在高处收拢成**晶柱穹顶**（锥壳，不是实心岩体）
     · 基座上长出一丛沿四周斜生的**放射晶棒**（2~4 根/丛）
     · 洞心一根贯穿的高晶柱 + 柱头晶囊 = 地标与落点
   结构倾向（智能搭配）：竖井 → 洞穴 → 室内 → 半封闭 → 露天（一路逃出地心）。
   ============================================================ */
import { MAT, solid, plate, column, blob, pick2, clip, isFree } from './common.js';

export const style = 'rock';
export const label = '水晶洞';
export const structures = ['shaft', 'cavern', 'indoor', 'sheltered', 'outdoor'];
export const depth = 0.85;

export function build(c) {
  const { g, reg: raw, band, rng, noise } = c;
  // ★ 零散件配额（碎晶 / 晶簇笋）：孤立小件合并不掉，一件就是一个方块
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0, y1 = reg.y1;
  const cx = (reg.x0 + reg.x1) / 2, cz = (reg.z0 + reg.z1) / 2;
  const half = Math.max(3, Math.min(reg.x1 - reg.x0, reg.z1 - reg.z0) / 2);
  const openness = Math.min(1, Math.max(0.15, Number(band.shell.openness) || 0.22));
  const R = half * (0.5 + openness * 0.35);
  const h = Math.max(4, y1 - y0);

  /* ---------- ① 晶柱穹顶：一圈**向内收拢**的晶柱 ----------
     柱脚在外圈、柱头收到内圈 → 从下往上看是一顶锥形晶壳；
     柱与柱之间全是空气，所以穹顶不占体积，只给轮廓。 */
  const spokes = rng.int(8, 12);
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + rng.range(-0.08, 0.08);
    const top = Math.min(y1 - 1, y0 + Math.round(h * rng.range(0.55, 0.95)));
    for (let y = y0 + 1; y <= top; y++) {
      const u = (y - y0) / Math.max(1, top - y0);
      const r = R * (1 - u * 0.62);                       // 越往上越靠内
      const x = Math.round(cx + Math.cos(a) * r), z = Math.round(cz + Math.sin(a) * r);
      if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1) continue;
      plate(g, x, z, x, z, y, y === top ? MAT.ledge : MAT.col);
    }
  }

  /* ---------- ② 放射状晶簇：基座上斜生出的晶棒丛 ---------- */
  const clusters = rng.int(3, 6);
  for (let i = 0; i < clusters; i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(0.25, 0.8) * R;
    const bx = Math.round(cx + Math.cos(a) * r), bz = Math.round(cz + Math.sin(a) * r);
    if (bx <= reg.x0 + 1 || bx >= reg.x1 - 1 || bz <= reg.z0 + 1 || bz >= reg.z1 - 1) continue;
    const rays = rng.int(3, 5);
    for (let k = 0; k < rays; k++) {
      const dir = (k / rays) * Math.PI * 2 + a;
      const dx = Math.cos(dir) >= 0 ? 1 : -1;
      const dz = Math.sin(dir) >= 0 ? 1 : -1;
      const len = rng.int(2, 4);
      for (let t = 1; t <= len; t++) {
        const x = bx + dx * t, z = bz + dz * t, y = y0 + t;
        if (x <= reg.x0 || x >= reg.x1 || z <= reg.z0 || z >= reg.z1 || y > y1 - 1) break;
        plate(g, x, z, x, z, y, MAT.block);               // 斜向晶棒
      }
    }
    if (deco.spend()) plate(g, bx, bz, bx, bz, y0, MAT.ledge);   // 晶座
  }

  /* ---------- ③ 洞心高晶柱：贯穿 + 柱头晶囊 + 环绕晶台 ---------- */
  const px = Math.round(cx), pz = Math.round(cz);
  const top = Math.min(y1 - 2, y0 + rng.int(4, 8));
  if (px > reg.x0 && px < reg.x1 && pz > reg.z0 && pz < reg.z1 && top > y0 + 1) {
    column(g, px, pz, y0 + 1, top, MAT.col);
    blob(g, px, top + 1, pz, 1.5, 0.9, 1.5, MAT.ledge);        // 柱头晶囊（可站）
    for (let y = y0 + 3; y < top - 1; y += 4) {
      plate(g, px - 1, pz, px + 1, pz, y, MAT.ledge);          // 环绕晶台
    }
  }

  /* ---------- ④ 地面晶簇笋（零散件） ---------- */
  const spikes = rng.int(4, 8);
  for (let i = 0; i < spikes; i++) {
    const p = pick2(rng, reg, 2);
    if (!deco.spend()) break;
    const hh = rng.int(1, 3);
    for (let k = 0; k <= hh; k++) {
      const y = y0 + k;
      if (y >= y1 - 1) break;
      if (isFree(g, p.x, y, p.z)) plate(g, p.x, p.z, p.x, p.z, y, MAT.block);
    }
  }
  // 顶部钟乳晶：从穹顶垂几根（纯观感）
  if (deco.spend()) {
    const p = pick2(rng, reg, 3);
    const len = rng.int(2, 3);
    for (let k = 0; k < len; k++) {
      const y = y1 - 1 - k;
      if (y <= y0 + 1) break;
      plate(g, p.x, p.z, p.x, p.z, y, MAT.block);
    }
  }
}