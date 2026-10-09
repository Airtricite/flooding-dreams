/* ============================================================
   主题白模 · 沉没都市（drownedCity）
   ------------------------------------------------------------
   主题身份词：淹没区、潮间带、坍塌区、半淹楼群、天桥、水下路标。
   「城市要有城市的样子」= 这套构造必须给出：
     · **街道格网**：正交路网 + 抬高的路缘（一眼就是城市，不是随机方块堆）
     · **不等高塔群**：地块格网里立塔，高的顶到本带天花板，矮的塌成瓦砾
     · **天桥 / 连廊**：塔与塔之间架可站立的桥 —— 城市的跑酷就是「在楼顶与天桥之间穿」
     · **坍塌区**：留下一批断裂的楼板与斜靠的残梁
   结构倾向（智能搭配）：室内（淹没的地铁/商场）→ 半封闭 → 露天 → 开阔天台。

   ★ 塔一律**从本带地板往上长**；带与带之间靠「塔尖 + 天桥」自然衔接。
   ============================================================ */
import { MAT, plate, solid, carve, column, pick2, clip } from './common.js';

export const style = 'city';
export const label = '沉没都市';
export const structures = ['indoor', 'sheltered', 'outdoor', 'openAir'];
/** 结构节奏：两带一循环 —— 「淹没的地下 → 露天街区」反复递进 */
export const rhythm = 'duplex';
export const depth = 0.55;

/** 街道格网的模数（体素）：路宽 1，街区 4~5 */
function roadMod(cell) { return Math.max(4, Math.round(26 / cell)); }

export function build(c) {
  const { g, reg: raw, band, rng, noise, cell } = c;
  // ★ 零散件配额（残骸 / 路标杆）：孤立小件合并不掉，一件就是一个方块
  const deco = c.deco || { left: Infinity, spend: () => true };
  const reg = clip(g, raw);
  const y0 = reg.y0;
  const lot = roadMod(cell);
  const H = Math.max(2, reg.y1 - reg.y0);       // 本带可用高度（体素）

  /* ---------- ① 路基 + 街道格网 ----------
     地板整体抬 1 格：格网线留空 → 街道比人行道低一格，城市感立刻出来。 */
  for (let z = reg.z0; z <= reg.z1; z++) {
    for (let x = reg.x0; x <= reg.x1; x++) {
      const onRoad = (x % lot === 0) || (z % lot === 0);
      const y = onRoad ? y0 - 1 : y0;
      plate(g, x, z, x, z, y, onRoad ? MAT.block : MAT.slab);
      if (!onRoad) plate(g, x, z, x, z, y0 - 1, MAT.block);      // 人行道下的路基
    }
  }

  /* ---------- ② 不等高塔群 ----------
     每个街区中心立一栋；高度按「噪声 + 随机」分布，保证有高有矮：
     高的顶到 reg.y1（下一带的楼板），矮的只到 H*0.3。 */
  const towers = [];
  for (let z = reg.z0 + 2; z <= reg.z1 - 2; z += lot) {
    for (let x = reg.x0 + 2; x <= reg.x1 - 2; x += lot) {
      const n = noise(x * 0.09, band.i * 5.3, z * 0.09);
      if (!rng.chance(0.34 + n * 0.5)) continue;
      const w = rng.int(1, 2), d = rng.int(1, 2);
      const tall = rng.chance(0.34 + n * 0.3);
      const hh = tall ? Math.round(H * rng.range(0.72, 0.98)) : Math.round(H * rng.range(0.25, 0.6));
      const top = Math.min(reg.y1 - 1, y0 + Math.max(2, hh));
      const x1 = Math.min(reg.x1, x + w - 1), z1 = Math.min(reg.z1, z + d - 1);
      solid(g, x, y0 + 1, z, x1, top, z1, MAT.block);
      // 楼板 / 天台：顶面铺一层「楼板色」，并给天台留出净空
      plate(g, x - 1, z - 1, x1 + 1, z1 + 1, top, MAT.roof);
      towers.push({ x, z, x1, z1, top, cx: (x + x1) / 2, cz: (z + z1) / 2 });
      // 坍塌：矮塔顶部留一块断裂的斜板（观感）
      if (!tall && rng.chance(0.5)) {
        const bx = x1 + 1;
        if (bx <= reg.x1) {
          plate(g, bx, z, bx, z1, top, MAT.block);
          plate(g, bx, z, bx, z1, top - 1, MAT.block);
        }
      }
    }
  }

  /* ---------- ③ 天桥 / 连廊 ----------
     相邻两栋塔之间架一条 1 格厚的桥，高度取两塔较低天台再低 1~2 格。
     桥面可站 → 「楼顶 → 天桥 → 楼顶」是这套主题最地道的跑酷路线。 */
  const nBridge = Math.min(towers.length - 1, rng.int(2, 5));
  for (let i = 0; i < nBridge; i++) {
    const a = rng.int(0, Math.max(0, towers.length - 2));
    const A = towers[a], B = towers[a + 1];
    if (!A || !B) continue;
    const y = Math.min(A.top, B.top) - rng.int(1, 2);
    if (y <= y0 + 1) continue;
    const x0 = Math.min(A.cx, B.cx) - 0.5, x1 = Math.max(A.cx, B.cx) + 0.5;
    const z0 = Math.min(A.cz, B.cz) - 0.5, z1 = Math.max(A.cz, B.cz) + 0.5;
    // 桥只走一条轴向：谁跨得多就沿谁
    if (x1 - x0 >= z1 - z0) {
      const zz = Math.round((z0 + z1) / 2);
      plate(g, Math.round(x0), zz, Math.round(x1), zz, y, MAT.ledge);
      if (rng.chance(0.5)) plate(g, Math.round(x0), zz, Math.round(x1), zz, y + 1, MAT.wall);
    } else {
      const xx = Math.round((x0 + x1) / 2);
      plate(g, xx, Math.round(z0), xx, Math.round(z1), y, MAT.ledge);
    }
  }

  /* ---------- ④ 淹没痕迹：街道上的残骸与水下路标 ---------- */
  const debris = rng.int(2, 5);
  for (let i = 0; i < debris; i++) {
    const p = pick2(rng, reg, 2);
    const y = y0 + rng.int(0, 1);
    if (!g.occ[(p.z * g.ny + y) * g.nx + p.x]) continue;
    if (!deco.spend()) break;
    const w = rng.int(1, 2);
    plate(g, p.x, p.z, Math.min(reg.x1, p.x + w), Math.min(reg.z1, p.z + w), y + 1, MAT.block);
    if (rng.chance(0.4)) column(g, p.x, p.z, y + 1, y + 2, MAT.col);   // 路标杆
  }

  /* ---------- ⑤ 带内竖井：给「上下贯通」留一条人工电梯井 ----------
     ★ 只砌三面井壁（留一面当走廊口）—— 四面封死会在世界里造出孤立空腔。 */
  if (rng.chance(0.6)) {
    const p = pick2(rng, reg, 4);
    const w = 2;
    carve(g, p.x, reg.y0, p.z, Math.min(reg.x1, p.x + w), reg.y1, Math.min(reg.z1, p.z + w));
    solid(g, p.x - 1, reg.y0, p.z - 1, p.x - 1, reg.y1, p.z + w + 1, MAT.wall);
    solid(g, p.x + w + 1, reg.y0, p.z - 1, p.x + w + 1, reg.y1, p.z + w + 1, MAT.wall);
    solid(g, p.x - 1, reg.y0, p.z - 1, p.x + w + 1, reg.y1, p.z - 1, MAT.wall);
  }
}