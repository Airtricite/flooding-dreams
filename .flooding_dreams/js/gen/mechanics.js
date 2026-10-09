/* ============================================================
   程序化生成 · M5 高级机制层
   ------------------------------------------------------------
   §6 段库里 7~16 项「高级机制」都是**组合配方**（引擎没有内置
   蹦床 / 输送带 / 激光阵 / 节拍球这些类型，全用对象 + 动画拼出来）。
   本层把它们做成**可挂载的机制**，挂在已经铺好的主轴段落上。

   ★ 唯一的红线（对齐 §10 的短期策略）：
     机制只做**旁路 / 加速 / 惩罚**，绝不替换主轴上的那一跳 ——
     主轴永远保留「普通跳跃」的保底路线，于是：
       · 解析自检（reach.js）与 NavGraph 逐边证明的口径完全不变；
       · 机制坏了也不会把关卡变成不可通关。
     落到几何上就是两条硬约束：
       ① 机制里**没有新的必经落脚面**：zipline / liquid / damage 本来就
          无碰撞；walljump / climb 虽然挡人，但都贴在自己的平台侧边
          （横向 ≤ hw + 3.2 的走廊净空里），前向的跳跃抛物线碰不到；
       ② 机制几何一律落在**配置层已经挖空的走廊 / 深坑**里
          （横向 < hw + CARVE.clr、纵向 [顶面 - CARVE.down, 顶面 + up]），
          所以不会嵌进白模石头里。口径直接复用 carve.js 的常量，不另立一套。

   ★ 随机流独立：机制用 rng.fork('mech') 与独立的 idGen，
     所以挂不挂机制，都不影响同一个种子下的路线（落点 / 连接）与平台 id。
   ============================================================ */
import { round, clamp } from '../core/util.js';
import { minCeiling } from './reach.js';
import { CARVE } from './limits.js';

const DEG = Math.PI / 180;
const CLR = CARVE.clr;          // 平台边缘外的水平净空（= 配置层口径）
const DOWN = CARVE.down;        // 平台顶面之下留多少（= 配置层口径）
const upOf = (P) => minCeiling(P) + 2;   // 平台顶面之上留多少（= 配置层的 up）

/* 机制总预算：一关最多挂多少个机制 / 多少个机制对象 */
export const MAX_MECHANISMS = 10;
export const MAX_MECH_OBJECTS = 70;

/* ============================================================
   小工具
   ============================================================ */
const f2 = (v) => round(Number(v) || 0, 2);

/** 垂直于 heading 的水平单位方向 */
function perp(ang) { return { x: -Math.sin(ang), z: Math.cos(ang) }; }

/**
 * 让物体的**本地 +X 轴**对准水平方向 heading 所需的 rotation.y（度）。
 * ★ 符号很容易写反，这里按 three.js 的 Ry(θ) 反推：
 *   Ry(θ)·(1,0,0) = (cosθ, 0, −sinθ)，要它等于 (cos ang, 0, sin ang) → θ = −ang。
 *   （与 mechanisms.js 里 player.yaw = atan2(−n.x, −n.z) 的朝向约定同源。）
 *   写反的后果是把墙横在路线上，所以这一行不要凭感觉改。
 */
function yawDeg(ang) { return round(-ang / DEG, 1); }

/** 从 n 个点里均匀取 k 个下标（含首尾，去重） */
function sampleIdx(n, k) {
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (let i = 0; i < k; i++) out.push(Math.round(i * (n - 1) / (k - 1)));
  return [...new Set(out)];
}

/** 段内平台落点的包围盒 */
function chainBox(chain) {
  const minX = Math.min(...chain.map((n) => n.x));
  const maxX = Math.max(...chain.map((n) => n.x));
  const minY = Math.min(...chain.map((n) => n.y));
  const maxY = Math.max(...chain.map((n) => n.y));
  const minZ = Math.min(...chain.map((n) => n.z));
  const maxZ = Math.max(...chain.map((n) => n.z));
  return { minX, maxX, minY, maxY, minZ, maxZ, spanX: maxX - minX, spanZ: maxZ - minZ };
}

/**
 * 平台在某个水平方向上的「支撑半径」：轴对齐方块的半尺寸在该方向上的投影。
 * 落点记的 hw 是内切半径，平台的角可能伸得比它远，所以按方向单独算。
 */
function support(n, ux, uz) {
  const s = n.size;
  const w = (s && Number(s[0])) || Math.max(2, Number(n.hw) || 2) * 2;
  const d = (s && Number(s[1])) || Math.max(2, Number(n.hw) || 2) * 2;
  return Math.abs(ux) * w / 2 + Math.abs(uz) * d / 2;
}

/**
 * 挑出段内跨度最大的几条「缺口」（相邻落点之间），并算出**真正的空气段**：
 * 起点是平台 A 朝 B 一侧的边缘，终点是平台 B 朝 A 一侧的边缘。
 * ★ 实心机制（walljump / climb / 输送带）一律铺在这段空气里，而不是平台旁边：
 *   平台是轴对齐的方块，它的角可能伸得比落点记的内切半宽 hw 远，贴着平台
 *   摆墙就有蹭进平台里的风险；空气段里没有平台，而配置层在缺口沿途同样是
 *   按插值后的 hw 挖的管，铺进去一定在空气中。
 * @returns [{ a, b, x, z, ang, hw, ux, uz, free, yLo, yHi }]
 */
function gapPicks(chain, k, minDist = 5) {
  const list = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i], b = chain[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist < minDist) continue;
    const ux = dx / dist, uz = dz / dist;
    const extA = support(a, ux, uz), extB = support(b, ux, uz);
    const free = dist - extA - extB;
    if (free < 3) continue;                       // 空气段太短，塞不下机制
    const eAx = a.x + ux * extA, eAz = a.z + uz * extA;
    const eBx = b.x - ux * extB, eBz = b.z - uz * extB;
    list.push({
      a, b, i, dist, ux, uz, free,
      x: (eAx + eBx) / 2, z: (eAz + eBz) / 2,
      ang: Math.atan2(dz, dx),
      // 取**较窄**的那块平台：外侧偏移按它算，墙才一定落在配置层挖出的空气里
      hw: Math.min(Math.max(2, Number(a.hw) || 2), Math.max(2, Number(b.hw) || 2)),
      yLo: Math.min(Number(a.y) || 0, Number(b.y) || 0),
      yHi: Math.max(Number(a.y) || 0, Number(b.y) || 0),
    });
  }
  list.sort((p, q) => q.free - p.free);
  return list.slice(0, k);
}

/**
 * 侧向偏移的安全取值。
 * 下限 2.4 是硬性的：玩家碰撞盒半宽 1，主轴通行带按半宽 1.1 算，
 * 墙的内侧面必须在 1.4 之外（= off − 半厚），否则会蹭到沿中线跑跳的玩家。
 * 上限来自配置层的走廊净空：外侧面不许越过 max(2, hw) + CARVE.clr。
 */
function sideOffset(hw, halfT) {
  const lim = Math.max(2, hw) + CLR - 0.2;
  const off = Math.min(Math.max(2.4, hw + 1.8), lim - halfT);
  return off >= 2.4 ? off : 0;                  // 挤不下就返回 0（调用方跳过）
}

/** 位置/尺寸都是有限数才放行（防止 NaN 一路传到关卡 JSON） */
function sane(position, scale) {
  return position.every(Number.isFinite) && (scale || []).every((v) => Number.isFinite(v));
}

/* ============================================================
   主轴通行净空：机制的「不挡路」红线
   ------------------------------------------------------------
   ★ 「路」不是整条被挖空的走廊，而是玩家**真正要走的带**：
       · 每个落点：平台本身（半宽 max(2, hw)）
       · 每条连接：沿线段采样，一条半宽 1.15 的带
         （玩家碰撞盒半宽 1，再留一点余量）
         纵向 [较低顶面 − 3.6, 较高顶面 + up]
     （−3.6 是下沉起伏的深度上限；+up 是跳跃顶点 + 身高 + 余量。）
   为什么需要它：机制是**贴着一段的缺口**摆的，但「另一段」的连接可能从同一个
   落点朝别的方向甩出去 —— 一个 60° 的急转就能让下一条连接的通行带正好扫过
   缺口里那面墙。这是纯几何问题，闭式推不出来，所以直接拿真实几何去挡。
   实心机制（walljump / climb / 有碰撞的 mesh）只要与它相交就被丢掉 ——
   宁可少一个机制，也不要让机制变成一堵横在路上墙。
   ============================================================ */
const CORR_HALF = 1.15;      // 通行带半宽
const CORR_STEP = 1.5;       // 沿连接的采样步长
const CORR_PAD = 3.6;        // 通行带下沿：平台顶面之下（下沉起伏上限）

function corridorOf(nodes, edges, up) {
  const out = [];
  for (const e of edges || []) {
    const a = nodes[e.from], b = nodes[e.to];
    if (!a || !b) continue;
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / CORR_STEP));
    const yLo = Math.min(a.y, b.y) - CORR_PAD;
    const yHi = Math.max(a.y, b.y) + up;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, yLo, yHi, half: CORR_HALF });
    }
  }
  for (const nd of nodes || []) {
    out.push({
      x: nd.x, z: nd.z, yLo: nd.y - CORR_PAD, yHi: nd.y + up,
      half: Math.max(2, Number(nd.hw) || 2),
    });
  }
  return out;
}

/** 有碰撞的机制（无碰撞的 zipline / liquid / damage 不参与挡路判定） */
function isSolid(d) {
  if (!d || !d.over) return false;
  if (d.type === 'walljump' || d.type === 'climb') return true;
  return d.type === 'mesh' && (d.over.physicsMode || 'box') !== 'none';
}

/** 落在「主轴必经机制段」的占据范围里？（避免滑索中间横出一面墙这类冲突） */
function hitsAvoid(avoid, d) {
  const p = d && d.over && d.over.position;
  if (!p || !avoid.length) return false;
  for (const a of avoid) {
    if (Math.abs(Number(p[1]) - a.y) > (a.v || 24)) continue;
    if (Math.hypot(Number(p[0]) - a.x, Number(p[2]) - a.z) <= a.r) return true;
  }
  return false;
}

/**
 * 旋转盒（围绕 Y 的 OBB）是否碰到通行净空。
 * 水平面里把采样点投到盒的本地轴上，算「点到 OBB 的距离」；
 * 再要求纵向有重叠 —— 两者都成立才算挡路。
 */
function blocksPath(corr, d) {
  const s = d.over.scale, p = d.over.position, r = d.over.rotation || [0, 0, 0];
  if (!s || !p || !sane(p, s)) return true;          // 数据不健康就当作挡路（丢掉它）
  const hx = Math.abs(s[0]) / 2, hy = Math.abs(s[1]) / 2, hz = Math.abs(s[2]) / 2;
  const th = (Number(r[1]) || 0) * DEG;
  const c = Math.cos(th), sn = Math.sin(th);
  const yLo = p[1] - hy, yHi = p[1] + hy;
  const reach = Math.hypot(hx, hz) + CORR_HALF;      // 廉价预筛：外接半径 + 通行带半宽
  for (let i = 0; i < corr.length; i++) {
    const q = corr[i];
    if (q.yLo >= yHi || q.yHi <= yLo) continue;
    const dx = q.x - p[0], dz = q.z - p[2];
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
    // 本地 +X → (cosθ, −sinθ)，本地 +Z → (sinθ, cosθ)（three.js 的 Ry(θ)）
    const u = dx * c - dz * sn;
    const v = dx * sn + dz * c;
    const ox = Math.max(0, Math.abs(u) - hx);
    const oz = Math.max(0, Math.abs(v) - hz);
    if (Math.hypot(ox, oz) <= q.half) return true;
  }
  return false;
}

/* ============================================================
   机制配方
   ------------------------------------------------------------
   每个 recipe = { id, label, kind, minDiff, weight, budget, build(mc) }
     kind    : aid 旁路/加速 | hazard 惩罚 | setpiece 观感
     minDiff : 始发门槛（对齐 difficulty.FEATURES 的「始发配置」）
     budget  : 这一项最多产出多少对象
   build(mc) → { objects[], animations[] }
     mc = { rng, P, params, theme, shell, idGen, chain, pit, hazard, index }
       · chain  : 本段的落点链（chain[0] 是入口，来自上一段的收尾）
       · pit    : 本段的大缺口深坑（配置层挖的，可能为 null）
   ============================================================ */
export const MECHANICS = {

  /* ---------- 滑索：沿本段落点链高挂一条缆绳，抓着飞过去（无碰撞） ---------- */
  zipline: {
    id: 'zipline', label: '滑索', kind: 'aid', minDiff: 1.0, weight: 1.1, budget: 1,
    build(mc) {
      const { rng, theme, idGen, chain, hazard: h } = mc;
      const pts = sampleIdx(chain.length, 4).map((i) => {
        const n = chain[i];
        return [f2(n.x), f2(n.y + 3.4), f2(n.z)];
      });
      // 中段多下坠一点，缆绳才有自然垂度（首尾保持抓取高度：头部在 4 stud 抓取半径内）
      for (let i = 1; i + 1 < pts.length; i++) pts[i][1] = f2(pts[i][1] - rng.range(0.4, 1.6));
      if (pts.length < 2) return { objects: [] };
      const obj = {
        type: 'zipline',
        over: {
          id: idGen('zp'),
          points: pts,
          segModes: new Array(pts.length - 1).fill('curve'),
          speed: round(38 + h * 46, 1),
          accel: round(14 + h * 28, 1),
          exitPush: round(18 + h * 26, 1),
          color: theme.accent,
          ropeRadius: 0.2,
        },
      };
      return { objects: [obj] };
    },
  },

  /* ---------- WallJump 竖井：在本段最大的两条缺口里各砌一对 WallJump 墙 ----------
     墙立在缺口正中的两侧，内侧面离中线 ≥ 1.6（玩家半宽 1 + 余量）——
     沿中线跑跳蹭不到它，但贴过去就能弹射，于是「不够的一跳」有了旁路。 */
  walljumpChute: {
    id: 'walljumpChute', label: 'WallJump 竖井', kind: 'aid', minDiff: 2.0, weight: 1.0, budget: 4,
    build(mc) {
      const { P, theme, idGen, chain } = mc;
      const up = upOf(P);
      const hgt = round(clamp(up - 4, 6, 14), 2);
      const out = [];
      for (const g of gapPicks(chain, 2)) {
        const off = sideOffset(g.hw, 0.8);          // 厚 1.6 → 半厚 0.8
        if (!off) continue;
        const p = perp(g.ang);
        const y = round(g.yLo - 3 + hgt / 2, 2);    // 下沿不越过顶面 -7 的净空下限
        for (const side of [-1, 1]) {
          const pos = [f2(g.x + p.x * off * side), y, f2(g.z + p.z * off * side)];
          const scale = [f2(clamp(g.free * 0.94, 4, 16)), hgt, 1.6];
          if (!sane(pos, scale)) continue;
          out.push({
            type: 'walljump',
            over: {
              id: idGen('wj'),
              shape: 'block',
              position: pos,
              rotation: [0, yawDeg(g.ang), 0],
              scale,
              color: theme.wall,
              stickTime: 1.2, pushY: 36, pushOut: 36, pushTime: 0.2, autoLaunch: false,
            },
          });
        }
      }
      return { objects: out };
    },
  },

  /* ---------- 攀爬墙：在本段最大缺口的一侧砌一面可攀爬的墙 ----------
     底边压在下落平台的高度、顶边高过较高平台 —— 「爬上去」的旁路。 */
  climbWall: {
    id: 'climbWall', label: '攀爬墙', kind: 'aid', minDiff: 2.0, weight: 0.9, budget: 1,
    build(mc) {
      const { P, theme, idGen, chain } = mc;
      const up = upOf(P);
      const g = gapPicks(chain, 1)[0];
      if (!g) return { objects: [] };
      const off = sideOffset(g.hw, 1.0);            // 厚 2 → 半厚 1
      if (!off) return { objects: [] };
      const p = perp(g.ang);
      const yBot = g.yLo - 2;
      const hgt = round(clamp((g.yHi - g.yLo) + 2 + up * 0.55, 8, up), 2);
      const pos = [f2(g.x + p.x * off), round(yBot + hgt / 2, 2), f2(g.z + p.z * off)];
      const scale = [f2(clamp(g.free * 0.8, 4, 14)), hgt, 2];
      if (!sane(pos, scale)) return { objects: [] };
      return {
        objects: [{
          type: 'climb',
          over: {
            id: idGen('cl'),
            shape: 'block',
            position: pos,
            rotation: [0, yawDeg(g.ang), 0],
            scale,
            color: theme.accent,
            climbSpeed: 14, sideSpeed: 7, jumpOff: true, jumpPower: 46, holdNoInput: true,
          },
        }],
      };
    },
  },

  /* ---------- 输送带：本段跨度最大的那条连接下方铺一条带齿的踏板阵列 ----------
     铺在平台顶面之下 4.2（在平台底板下方一点点）：跳跃抛物线碰不到它，
     但掉下来能落在上面走过去 —— 是一条「慢、稳」的兜底旁路。 */
  conveyorBelt: {
    id: 'conveyorBelt', label: '输送带', kind: 'aid', minDiff: 2.0, weight: 0.9, budget: 3,
    build(mc) {
      const { theme, idGen, chain } = mc;
      const g = gapPicks(chain, 1, 4)[0];
      if (!g) return { objects: [] };
      const y = round(g.yLo - 4.6, 2);              // 4.6 < DOWN(7)：仍在走廊净空里
      const out = [];
      const segs = 3;
      const total = clamp(g.free * 0.94, 3, 26);
      const sl = (total / segs) * 0.86;
      for (let i = 0; i < segs; i++) {
        const t = (i + 0.5) / segs - 0.5;            // -1/3, 0, +1/3：铺在空气段正中
        const pos = [f2(g.x + g.ux * total * t), y, f2(g.z + g.uz * total * t)];
        const scale = [f2(sl), 0.6, 3.4];
        if (!sane(pos, scale)) continue;
        out.push({
          type: 'mesh',
          over: {
            id: idGen('cv'),
            shape: 'block',
            position: pos,
            rotation: [0, yawDeg(g.ang), 0],
            scale,
            color: i % 2 ? theme.platAlt : theme.wall,
            texture: 'grid',
            textureSize: 2,
            roughness: 0.5, metalness: 0.45,
            bakeAO: false,
          },
        });
      }
      return { objects: out };
    },
  },

  /* ---------- 游泳区：在所有平台顶面**之下**灌一池水 ----------
     水面必须低于所有平台顶面 —— 否则跳跃会变成游泳，解析自检的
     「跑动起跳」口径就不再成立。掉进水里则能游（浅层）或从深坑游上来。 */
  swimSection: {
    id: 'swimSection', label: '游泳区', kind: 'aid', minDiff: 2.0, weight: 1.0, budget: 1,
    build(mc) {
      const { theme, idGen, chain, pit, hazard: h } = mc;
      const box = chainBox(chain);
      const surf = round(box.minY - 1.6, 2);         // 液面在所有平台顶面之下
      let cx, cz, w, d, bot;
      if (pit) {
        cx = pit.x; cz = pit.z;
        w = d = Math.max(10, pit.w * 0.92);
        bot = Math.max(pit.y - pit.depth + 2, surf - 24);   // 深坑只灌上层 24 stud，别把水体做太大
      } else {
        cx = (box.minX + box.maxX) / 2; cz = (box.minZ + box.maxZ) / 2;
        w = Math.max(12, box.spanX + 16); d = Math.max(12, box.spanZ + 16);
        bot = surf - 6;
      }
      const hgt = Math.max(2, surf - bot);
      const pos = [f2(cx), f2(surf - hgt / 2), f2(cz)];
      const scale = [f2(w), f2(hgt), f2(d)];
      if (!sane(pos, scale)) return { objects: [] };
      return {
        objects: [{
          type: 'liquid',
          over: {
            id: idGen('sw'),
            kind: 'water',
            position: pos,
            scale,
            fillLevel: 1,
            swim: true, oxygenMode: 'drain', headOnly: true, instantKill: false,
            drainRate: round(6 + h * 14, 1),
            waterResist: 0.15,
            color: '#2f8fd8', transparency: 0.38,
            emissive: '#0a2233', emissiveIntensity: 0.18,
            roughness: 0.08, metalness: 0.3,
            castShadow: false,
          },
        }],
      };
    },
  },

  /* ---------- 熔岩场：深坑底部灌熔岩 + 几块观感碎片（碎片无碰撞） ---------- */
  lavaField: {
    id: 'lavaField', label: '熔岩场', kind: 'hazard', minDiff: 3.0, weight: 1.0, budget: 5,
    build(mc) {
      const { rng, theme, idGen, pit } = mc;
      if (!pit) return { objects: [] };
      const top = round(pit.y - 6, 2);               // 岩浆面在坑口之下 6（平台顶面之下 9）
      const bot = Math.max(pit.y - pit.depth + 2, top - 16);
      const hgt = Math.max(2, top - bot);
      const w = Math.max(10, pit.w * 0.92);
      const pos = [f2(pit.x), f2(top - hgt / 2), f2(pit.z)];
      const scale = [f2(w), f2(hgt), f2(w)];
      const out = [];
      if (sane(pos, scale)) {
        out.push({
          type: 'liquid',
          over: {
            id: idGen('lv'),
            kind: 'lava',
            position: pos, scale,
            fillLevel: 1,
            swim: false, instantKill: true, headOnly: false,
            color: '#ff5a1e', transparency: 0.06,
            emissive: '#3a0d00', emissiveIntensity: 0.85,
            roughness: 0.5, metalness: 0.1,
            castShadow: false,
          },
        });
      }
      // 平台碎片：坑壁/岩浆上的观感石（physicsMode none → 不参与寻路，也不会挡路）
      const n = rng.int(2, 3);
      for (let i = 0; i < n; i++) {
        const ang = rng.range(0, Math.PI * 2);
        const r = rng.range(0.2, 0.4) * pit.w;
        const p2 = [f2(pit.x + Math.cos(ang) * r), f2(top + rng.range(1, 6)), f2(pit.z + Math.sin(ang) * r)];
        const s2 = [f2(rng.range(2.4, 5.2)), f2(rng.range(1.2, 2.8)), f2(rng.range(2.4, 5.2))];
        if (!sane(p2, s2)) continue;
        out.push({
          type: 'mesh',
          over: {
            id: idGen('fr'),
            shape: 'prism', sides: rng.int(5, 7),
            position: p2,
            rotation: [0, round(rng.range(0, 360), 1), 0],
            scale: s2,
            color: theme.wall,
            roughness: 0.95, metalness: 0.02,
            physicsMode: 'none', bakeAO: false,
          },
        });
      }
      return { objects: out };
    },
  },

  /* ---------- 激光阵：深坑口下方的一张横竖光网（damage 体积，无碰撞） ---------- */
  laserGrid: {
    id: 'laserGrid', label: '激光阵', kind: 'hazard', minDiff: 3.0, weight: 1.0, budget: 6,
    build(mc) {
      const { idGen, pit } = mc;
      if (!pit) return { objects: [] };
      const gy = round(pit.y - 5, 2);                // 坑口之下 5：远在下沉起伏（最多 3.5）之下
      const span = pit.w * 0.94;
      const half = (pit.w * 0.9) / 2;
      const out = [];
      for (let i = -1; i <= 1; i++) {
        const t = (half / 2) * i * 1.6;
        out.push(damageBar(idGen, pit.x + t, gy, pit.z, 0, span));
        out.push(damageBar(idGen, pit.x, gy, pit.z + t, 90, span));
      }
      return { objects: out.filter(Boolean) };
    },
  },

  /* ---------- 移动平台：深坑里横向巡游的观赏平台（引擎不会带着玩家走，只做压迫感） ---------- */
  movingPlatform: {
    id: 'movingPlatform', label: '移动平台', kind: 'setpiece', minDiff: 2.0, weight: 0.7, budget: 1,
    build(mc) {
      const { rng, theme, idGen, pit } = mc;
      if (!pit) return { objects: [], animations: [] };
      const w = clamp(pit.w * 0.3, 5, 14);
      // 坑口之下 20：既在路线下方，又超出装饰层「下探 14 stud 找地面」的抓取范围，
      // 免得装饰件被吸附到这个会动的平台上（平台一走就变成悬空的装饰）
      const y = round(pit.y - 20, 2);
      const span = Math.max(4, pit.w * 0.3);
      const x0 = round(pit.x - span, 2), x1 = round(pit.x + span, 2);
      const pos = [x0, y, f2(pit.z)];
      const scale = [f2(w), 1.2, f2(w)];
      if (!sane(pos, scale)) return { objects: [], animations: [] };
      const id = idGen('mp');
      const cyc = round(rng.range(5, 9), 2);
      return {
        objects: [{
          type: 'mesh',
          over: {
            id, shape: 'block',
            position: pos, scale,
            color: theme.platAlt,
            texture: 'grid', textureSize: 2,
            roughness: 0.6, metalness: 0.25,
            physicsMode: 'box', bakeAO: false,
          },
        }],
        animations: [{
          id: idGen('an'),
          name: '移动平台',
          duration: cyc,
          loop: true, pingpong: true, autoplay: true, enabled: true,
          tracks: [{
            objectId: id, property: 'position', type: 'vec3',
            keys: [
              { t: 0, v: pos, easing: 'easeInOut' },
              { t: round(cyc / 2, 2), v: [x1, y, f2(pit.z)], easing: 'easeInOut' },
            ],
          }],
        }],
      };
    },
  },

  /* ---------- 弹床：缺口下方的一张弹性网 ----------
     铺在平台顶面之下 5 stud（跳跃抛物线碰不到它），掉下来会被弹回去 ——
     「慢、稳」的兜底旁路，也是这一关里唯一会把人**弹上天**的东西。 */
  trampoline: {
    id: 'trampoline', label: '弹床', kind: 'aid', minDiff: 1.0, weight: 0.8, budget: 3,
    build(mc) {
      const { theme, idGen, chain } = mc;
      const g = gapPicks(chain, 1, 4)[0];
      if (!g) return { objects: [] };
      const y = round(g.yLo - 5.0, 2);              // 5.0 < DOWN(7)：仍在配置层走廊净空里
      const n = clamp(Math.round(g.free / 6), 1, 2);
      const total = clamp(g.free * 0.9, 3, 22);
      const out = [];
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        const pos = [f2(g.x + g.ux * total * t), y, f2(g.z + g.uz * total * t)];
        const scale = [f2((total / n) * 0.88), 0.8, 4.4];
        if (!sane(pos, scale)) continue;
        out.push({
          type: 'mesh',
          over: {
            id: idGen('tr'),
            shape: 'block',
            position: pos,
            rotation: [0, yawDeg(g.ang), 0],
            scale,
            color: theme.accent,
            material: 'bouncy',                     // 引擎的高弹性材质：restitution 0.72
            texture: 'grid', textureSize: 2,
            roughness: 0.55, metalness: 0.15, bakeAO: false,
          },
        });
      }
      return { objects: out };
    },
  },

  /* ---------- 节拍球：一组会「呼吸」的发光球（纯观感；无碰撞，不挡路） ---------- */
  rhythmOrb: {
    id: 'rhythmOrb', label: '节拍球', kind: 'setpiece', minDiff: 3.0, weight: 0.8, budget: 3,
    build(mc) {
      const { rng, theme, idGen, chain } = mc;
      if (!chain.length) return { objects: [], animations: [] };
      const objects = [];
      const animations = [];
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        const nd = chain[rng.int(0, chain.length - 1)];
        if (!nd) continue;
        const s = round(rng.range(2.2, 3.4), 2);
        const pos = [f2(nd.x + rng.range(-7, 7)), f2(nd.y + rng.range(4, 9)), f2(nd.z + rng.range(-7, 7))];
        const scale = [s, s, s];
        if (!sane(pos, scale)) continue;
        const id = idGen('ro');
        objects.push({
          type: 'mesh',
          over: {
            id, shape: 'sphere', position: pos, scale,
            color: theme.start, emissive: theme.start, emissiveIntensity: 1.5,
            roughness: 0.25, metalness: 0.1,
            physicsMode: 'none',                     // 无碰撞：绝不参与通行判定
            castShadow: false, bakeAO: false,
          },
        });
        const cyc = round(rng.range(1.6, 2.8), 2);
        const big = [round(s * 1.22, 2), round(s * 1.22, 2), round(s * 1.22, 2)];
        animations.push({
          id: idGen('an'),
          name: '节拍呼吸',
          duration: cyc, loop: true, pingpong: true, autoplay: true, enabled: true,
          tracks: [{
            objectId: id, property: 'scale', type: 'vec3',
            keys: [
              { t: 0, v: scale, easing: 'easeInOut' },
              { t: round(cyc / 2, 2), v: big, easing: 'easeInOut' },
            ],
          }],
        });
      }
      return { objects, animations };
    },
  },

  /* ---------- 定时激光：会开合的激光闸门（damage 体积 + 缩放动画；无碰撞） ----------
     与 laserGrid 的区别：它不是一直张着的死网，而是「张开 → 收起」循环，
     掉下去要卡节拍才过得去（开发文档 §10.2 的时序机关，只在坑里做压迫感）。 */
  timedLaser: {
    id: 'timedLaser', label: '定时激光', kind: 'hazard', minDiff: 3.0, weight: 0.9, budget: 6,
    build(mc) {
      const { idGen, pit, rng } = mc;
      if (!pit) return { objects: [], animations: [] };
      const gy = round(pit.y - 5, 2);
      const span = pit.w * 0.94;
      const half = (pit.w * 0.9) / 2;
      const objects = [];
      const animations = [];
      const cyc = round(rng.range(1.4, 3.2), 2);
      for (let i = -1; i <= 1; i++) {
        const t = (half / 2) * i * 1.6;
        for (const [bx, bz, yaw] of [[pit.x + t, pit.z, 0], [pit.x, pit.z + t, 90]]) {
          const d = damageBar(idGen, bx, gy, bz, yaw, span);
          if (!d) continue;
          objects.push(d);
          const s = d.over.scale;
          animations.push({
            id: idGen('an'),
            name: '激光开合',
            duration: cyc, loop: true, pingpong: true, autoplay: true, enabled: true,
            tracks: [{
              objectId: d.over.id, property: 'scale', type: 'vec3',
              keys: [
                { t: 0, v: s, easing: 'easeInOut' },
                { t: round(cyc / 2, 2), v: [f2(s[0]), 0.06, 0.06], easing: 'easeInOut' },
              ],
            }],
          });
        }
      }
      return { objects, animations };
    },
  },
};

/** 一根激光条（沿本地 X 展开的细长伤害体积） */
function damageBar(idGen, x, y, z, yaw, len) {
  const pos = [f2(x), f2(y), f2(z)];
  const scale = [f2(len), 1.2, 0.6];
  if (!sane(pos, scale)) return null;
  return {
    type: 'damage',
    over: {
      id: idGen('lz'),
      shape: 'block',
      position: pos,
      rotation: [0, round(yaw, 1), 0],
      scale,
      color: '#ff6b8a', transparency: 0.35,
      emissive: '#ff2a4d', emissiveIntensity: 2.4,
      damage: 55, knockback: 0, instantKill: false,
      castShadow: false,
    },
  };
}

/* ============================================================
   抽取与挂载
   ============================================================ */

/** 该难度下可用的机制（按 minDiff 门槛筛掉，对齐 §4 参数表的「始发配置」） */
export function allowedMechanics(difficulty) {
  const d = Number(difficulty) || 1;
  return Object.values(MECHANICS).filter((m) => d >= m.minDiff);
}

/** 加权抽一项：危险类机制的权重随 hazard 上升，助跑类保持基础权重 */
export function pickMechanism(rng, params, exclude) {
  const d = Number(params && params.difficulty) || 1;
  const h = clamp(Number(params && params.hazard) || 0, 0, 1);
  const pairs = Object.values(MECHANICS)
    .filter((m) => d >= m.minDiff && !(exclude && exclude.has(m.id)))
    .map((m) => [m.id, m.weight * (m.kind === 'hazard' ? 0.4 + h * 1.6 : 1)]);
  if (!pairs.length) return null;
  return rng.weighted(pairs) || null;
}

/**
 * 给整张图挂机制。
 * ★ 必须在主轴 / 白模都铺完之后调用：这里只**追加**对象，
 *   不碰 nodes / edges，所以主轴「保底可通关」的结论不受影响。
 * ★ 有碰撞的机制再过一道「主轴通行净空」的几何筛（blocksPath），
 *   撞上的单个对象直接丢掉 —— 机制绝不挡路。
 *
 * @param input { rng, P, params, nodes, edges, secRecs, mass }
 * @returns { objects[], animations[], stats{}, list[], rejected }
 */
export function attachMechanisms(input) {
  const { rng, P, params, nodes, edges, secRecs, mass } = input;
  const out = { objects: [], animations: [], stats: {}, list: [], rejected: 0 };
  if (!(Number(params.mechChance) > 0) || !nodes || !nodes.length) return out;
  const exclude = input.exclude || null;      // 例：世界层自带涨水时排除 swimSection

  const mrng = rng.fork('mech');            // 独立随机流：不扰动主轴的随机序列
  const idg = makeMechIdGen(mrng);
  const pits = (mass && mass.carve && mass.carve.pits) || [];
  const corr = corridorOf(nodes, edges, upOf(P));
  const avoid = input.avoid || [];          // 主轴必经机制段占据的范围（不许重叠）

  let prev = nodes[0];
  /* ★ 一段可以挂**多处**机制：难度越高、危险度越高，一段里叠得越多 ——
     这是「配置丰富」的密度旋钮（总量仍受 MAX_MECHANISMS / MAX_MECH_OBJECTS 约束）。 */
  const perSection = clamp(Math.round(2 + (Number(params.hazard) || 0) * 1.5), 2, 4);
  for (let si = 0; si < secRecs.length; si++) {
    const pts = nodes.filter((n) => n.section === si);
    if (pts.length < 2) { if (pts.length) prev = pts[pts.length - 1]; continue; }
    const chain = [prev, ...pts];
    prev = pts[pts.length - 1];

    for (let slot = 0; slot < perSection; slot++) {
      if (out.list.length >= MAX_MECHANISMS) break;
      if (out.objects.length >= MAX_MECH_OBJECTS) break;
      if (!mrng.chance(params.mechChance)) continue;

      const theme = secRecs[si].theme
        || { wall: '#3b3559', accent: '#8fd6ff', platAlt: '#b9a7ff' };
      const pit = pits.find((p) => p.section === si) || null;
      /* 抽到的机制可能因为「这一段没有深坑」「空气段太短」而摆不出来 ——
         再抽一次就好，别把机会浪费掉（最多试 2 次）。 */
      let objs = null;
      for (let tryIdx = 0; tryIdx < 2 && objs === null; tryIdx++) {
        const id = pickMechanism(mrng, params, exclude);
        const m = id ? MECHANICS[id] : null;
        if (!m) break;
        let r;
        try {
          r = m.build({
            rng: mrng, P, params, theme, shell: secRecs[si].shell,
            idGen: idg, chain, pit, hazard: clamp(Number(params.hazard) || 0, 0, 1), index: si,
          }) || {};
        } catch (e) {
          r = {};
        }
        const raw = (r.objects || []).filter(Boolean);
        // ★ 挡路的实心件当场丢掉；无碰撞的（zipline / liquid / damage）不参与
        // ★ 主轴必经机制段（滑索 / 攀爬 / WallJump / 游泳）占据的范围里也不许摆东西
        const keep = raw.filter((d) => {
          if (isSolid(d) || d.type === 'zipline') {
            if (blocksPath(corr, d) || hitsAvoid(avoid, d)) { out.rejected++; return false; }
          }
          return true;
        }).slice(0, m.budget);
        if (keep.length) objs = { m, keep, animations: r.animations || [] };
      }
      if (!objs) continue;

      for (const o of objs.keep) out.objects.push(o);
      for (const a of objs.animations) out.animations.push(a);
      out.stats[objs.m.id] = (out.stats[objs.m.id] || 0) + 1;
      out.list.push({
        section: si, id: objs.m.id, label: objs.m.label, kind: objs.m.kind,
        objects: objs.keep.length,
        ids: objs.keep.map((o) => o.over && o.over.id).filter(Boolean),
      });
    }
  }

  /* 兜底：对象数超上限时**从后往前砍**（而不是整份丢掉）——
     宁可少几个机制，也不要一关一个机制都没有（早期是整份丢，密度一高就变空关）。 */
  while (out.objects.length > MAX_MECH_OBJECTS && out.list.length) {
    const last = out.list.pop();
    out.objects = out.objects.slice(0, out.objects.length - last.objects);
    if (last.ids && last.ids.length) {
      const gone = new Set(last.ids);
      out.animations = out.animations.filter((a) => !(a.tracks || []).some((tr) => gone.has(tr.objectId)));
    }
    out.stats[last.id] = (out.stats[last.id] || 1) - 1;
    if (out.stats[last.id] <= 0) delete out.stats[last.id];
  }
  return out;
}

/** 机制专用 id 生成器（与主 idGen 分开，保证平台 id 不因挂机制而改变） */
function makeMechIdGen(rng) {
  let n = 0;
  return (prefix = 'gm') => `${prefix}${(n++).toString(36)}${rng.int(0, 1295).toString(36)}`;
}

/** 报告用的摘要 */
export function mechanismSummary(mech) {
  if (!mech || !mech.list || !mech.list.length) return null;
  return {
    total: mech.list.length,
    objects: mech.objects.length,
    animations: (mech.animations || []).length,
    // 被「主轴通行净空」挡下来的实心件数量（诊断用：正常应该是 0 或个位数）
    rejected: Number(mech.rejected) || 0,
    stats: { ...mech.stats },
    sections: mech.list.map((m) => ({ section: m.section, id: m.id, label: m.label, kind: m.kind })),
  };
}
