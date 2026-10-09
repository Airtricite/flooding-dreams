/* ============================================================
   程序化装饰 · L2 槽位层（Slots）
   ------------------------------------------------------------
   把「装饰往哪放」从无边界搜索变成**有限枚举**：
   沿走廊取样 → 向几个固定方向探表面（`fields.attach`）→ 得到一批槽位。
   每个槽位带着「它贴在什么面上、法线朝哪」，微件只负责按槽位成形。

   槽位种类（与开发文档 §5.3 对齐，本轮落地前五种里的四种 + 水位线）：
     · floorDress   地贴 —— 走廊两侧的**边缘带**（`pass > safeR` 之外）
     · wallMount    壁挂 —— 侧表面，法线水平
     · ceilingHang  顶挂 —— 有顶结构才生成，挂在顶面下沿
     · waterline    潮线 —— 有液体时贴着水面
     · farSilhouette 远景 —— 走廊包围盒之外，只作剪影（不参与可达性）

   ⚠ 所有槽位天然带**冗余**：探不到面、超距离、落在走廊里都会失败，
     由 project.js 统一否决 —— 这一层只负责「提出候选」，不负责「保证合法」。
   ============================================================ */
import { clamp, round } from '../../core/util.js';

/** 槽位口径（stud） */
export const SLOT = {
  edge: 3.6,        // 地贴：从平台边缘再往外多少（必须 > safeR 2.5）
  wallReach: 34,    // 壁挂：离走廊最多探多远才认
  wallUp: 3.0,      // 壁挂：相对落点抬高多少
  ceilGap: 1.6,     // 顶挂：离天花板底面留多少（查询高度用 HANG_LIFT，见下）
  farMin: 40,       // 远景：至少离走廊包围盒多远
  farMax: 110,
};

/** 顶挂件的查询高度：必须高过「跳跃顶点 + 身高」的净空（14.89），留一点余量 */
const HANG_LIFT = 19;

/**
 * 生成候选槽位。
 * @param fields   语义场（makeFields 的产物：route / attach / waterY / bounds）
 * @param sections realizer 的段落记录（可选，用来知道每段结构是否有顶、顶多高）
 * @param budget   目标槽位数（每种槽位的配额）
 */
export function makeSlots({ fields, sections, theme, rng, budget = {} }) {
  const route = (fields && fields.route) || [];
  const out = [];
  if (!route.length) return out;

  const quota = {
    floorDress: clamp(Math.round(num(budget.floorDress, 90)), 0, 400),
    ledgeDress: clamp(Math.round(num(budget.ledgeDress, 60)), 0, 300),
    wallMount: clamp(Math.round(num(budget.wallMount, 56)), 0, 300),
    ceilingHang: clamp(Math.round(num(budget.ceilingHang, 36)), 0, 200),
    waterline: clamp(Math.round(num(budget.waterline, 18)), 0, 120),
    farSilhouette: clamp(Math.round(num(budget.farSilhouette, 26)), 0, 120),
  };

  const waterY = Number.isFinite(fields.waterY) ? fields.waterY : null;
  const box = fields.bounds || null;

  /* 沿走廊均匀取样（按配额决定取样数，取样点多于配额，让否决有回旋余地） */
  const n = route.length;
  const base = Math.max(quota.floorDress, quota.wallMount, quota.ceilingHang, 8);
  const step = Math.max(1, Math.floor(n / base));

  let fi = 0, li = 0, wi = 0, ci = 0;
  for (let i = 0; i < n && (fi + li + wi + ci) < (quota.floorDress + quota.wallMount + quota.ceilingHang) * 3; i += step) {
    const s = route[i];
    const hw = Math.max(1.2, Number(s.r) || 2);
    const side = rng.sign();
    /* 侧向一律取「行进方向的水平法线」—— 用 ±x 当侧向在盘旋/之字路线里会指错 */
    const perp = perpAt(route, i);
    const px = perp.x * side;
    const pz = perp.z * side;

    /* ---- 平台边缘小件：**玩家脚边**（最显眼的一档）----
       落在平台顶面上、离落点中心 0.7×半宽（避开落脚区），
       且只给「站得下」的平台（窄梁不放，免得看起来像路障）。 */
    if (li < quota.ledgeDress && hw >= 2.5) {
      const off = hw * 0.7;
      out.push({
        kind: 'ledgeDress',
        x: s.x + (rng.chance(0.5) ? px * off : rng.range(-off * 0.5, off * 0.5)),
        y: s.y,
        z: s.z + (rng.chance(0.5) ? rng.range(-off * 0.5, off * 0.5) : pz * off),
        at: i, hw,
      });
      li++;
    }

    /* ---- 地贴：两侧边缘带（**随距离外推**：走廊净空把附近的楼板掏掉了，
           固定贴边很容易找不到地板，所以在外推距离上随机） ---- */
    if (fi < quota.floorDress) {
      for (const sgn of [1, -1]) {
        if (fi >= quota.floorDress) break;
        const off = hw + rng.range(3.6, 10);
        out.push({ kind: 'floorDress', x: s.x + px * sgn * off, y: s.y - 1, z: s.z + pz * sgn * off, at: i, hw });
        fi++;
      }
    }

    /* ---- 壁挂：朝外一点的位置，带**朝外方向**，由 project.js 走到第一面墙 ---- */
    if (wi < quota.wallMount) {
      out.push({
        kind: 'wallMount',
        x: s.x + px * (hw + 2.6),
        y: s.y + SLOT.wallUp,
        z: s.z + pz * (hw + 2.6),
        dirX: px, dirZ: pz,
        at: i, hw,
      });
      wi++;
    }

    /* ---- 顶挂：**从「玩家跳跃净空之上」往上找顶** ----
       不能钉在 shell 的 ceilY 上：白模的顶是噪声/楼板决定的，实际顶面常常不在那儿。
       于是给一个查询高度（净空之上 19 stud），由 project.js 的 findCeiling 往上找 60 stud，
       找到谁就吊在谁下面 —— 找不到（比如室内顶太低、吊下来会挡跳）就不生成。 */
    if (ci < quota.ceilingHang) {
      const off = hw + 4;
      const ax = rng.chance(0.5);
      const sgn = rng.sign();
      out.push({
        kind: 'ceilingHang',
        x: s.x + (ax ? sgn * off : rng.range(-off * 0.4, off * 0.4)),
        y: s.y + HANG_LIFT,
        z: s.z + (ax ? rng.range(-off * 0.4, off * 0.4) : sgn * off),
        at: i, hw,
      });
      ci++;
    }
  }

  /* ---- 潮线：贴着水面 ---- */
  if (waterY !== null) {
    const m = Math.min(quota.waterline, Math.max(1, Math.floor(n / 8)));
    for (let k = 0; k < m; k++) {
      const t = (k + 0.5) / m;
      const s = route[Math.min(n - 1, Math.floor(t * (n - 1)))];
      out.push({
        kind: 'waterline',
        x: s.x + rng.range(-8, 8), y: waterY, z: s.z + rng.range(-8, 8),
        at: Math.min(n - 1, Math.floor(t * (n - 1))), hw: Math.max(1.2, Number(s.r) || 2),
      });
    }
  }

  /* ---- 远景：走廊包围盒之外的一圈剪影（只在外向开阔时生成） ---- */
  if (box && quota.farSilhouette > 0) {
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const rad = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
    for (let k = 0; k < quota.farSilhouette; k++) {
      const ang = (k / quota.farSilhouette) * Math.PI * 2 + rng.range(-0.12, 0.12);
      const r = rad + rng.range(SLOT.farMin, SLOT.farMax);
      out.push({
        kind: 'farSilhouette',
        x: cx + Math.cos(ang) * r,
        y: num(box.min.y, 0) - rng.range(20, 44),
        z: cz + Math.sin(ang) * r,
        at: -1, hw: 6,
      });
    }
  }

  return out.map((s) => ({ ...s, x: round(s.x, 3), y: round(s.y, 3), z: round(s.z, 3) }));
}

function num(v, d) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

/** 路线在 i 处的水平法线（垂直于行进方向，单位长度） */
function perpAt(route, i) {
  const a = route[Math.max(0, i - 1)];
  const b = route[Math.min(route.length - 1, i + 1)];
  let tx = b.x - a.x;
  let tz = b.z - a.z;
  const len = Math.hypot(tx, tz);
  if (!(len > 1e-4)) return { x: 1, z: 0 };
  tx /= len; tz /= len;
  return { x: -tz, z: tx };
}
