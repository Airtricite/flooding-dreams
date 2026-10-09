/* ============================================================
   世界优先管线 · Phase C3：填水域（含「涨水」）
   ------------------------------------------------------------
   这是「洪水逃生」的字面来源：水不是装饰，是**压迫感本身**。
   排完跑酷后，算法测出「路线的脚下有多低、世界有多高」，然后：

     ① 一片**贯穿世界**的大水体（liquid），液面动画从「最低落脚面之下」
        一路升到世界顶 —— 这就是涨水（fillLevel 走 keyframe 轨道）。
        t = 0 时液面在所有落脚面之下，所以：
          · 解析自检（reach.js）的「跑动起跳」口径在 t=0 成立；
          · 玩家一落地就被水追着往上跑，正好对上「整体爬升」的核心。
     ② 深坑灌熔岩（高难度）：坑底一片 instantKill 的岩浆。
     ③ 主题液体皮肤：从装饰主题的 `liquid` 取水纹风格，配色不打架。

   ⚠ 已知边界（与开发文档 §10.3 一致）：静态几何验证只能证明 t=0 的可通关性，
     涨水之后的可通关性依赖「时间轴」，本层不做时序求解 —— 所以液面初始值
     刻意压得很低，给足余量。
   ============================================================ */
import { round, clamp } from '../../core/util.js';
import { sane } from './parts.js';

/** 主题 liquid 字段 → 引擎液体 kind */
function kindOf(themeLiquid) {
  const s = String(themeLiquid || '').toLowerCase();
  if (s.includes('lava') || s.includes('magma')) return 'lava';
  if (s.includes('acid') || s.includes('toxic')) return 'acid';
  return 'water';
}

/**
 * @param route planRoute 的产物（要 nodes / pits）
 * @param world buildWorld 的产物（要 grid 的包围盒）
 * @param wt    世界蓝图
 * @param opts  { P, params, timeLimit, difficulty, idGen, rng }
 * @returns { objects[], animations[], stats }
 */
export function fillWater(route, world, wt, opts = {}) {
  const { params, idGen, rng } = opts;
  const grid = world.grid;
  const objects = [];
  const animations = [];
  const events = [];                 // ★ 事件（开局涨水…）：纯数据，交给关卡层 normalizeEvent
  const difficulty = Number(opts.difficulty) || 1;
  const timeLimit = Number(opts.timeLimit) || 120;
  const hazard = clamp(Number(params && params.hazard) || 0, 0, 1);

  const minX = grid.ox;
  const maxX = grid.ox + grid.nx * grid.cell;
  const minZ = grid.oz;
  const maxZ = grid.oz + grid.nz * grid.cell;
  const basinTop = round(grid.oy + grid.cell, 3);
  const wSpan = maxX - minX;
  const dSpan = maxZ - minZ;

  /* 路线的「脚下最低点」：液面 t=0 必须压在它之下（否则跳跃变游泳） */
  let minFoot = Infinity;
  for (const n of route.nodes || []) minFoot = Math.min(minFoot, Number(n.y) || 0);
  if (!Number.isFinite(minFoot)) minFoot = basinTop + 20;

  /* ---------- ① 涨水：贯穿世界的一条大水体 ----------
     ★ 「开局就涨」：t=0 液面只压在最低落脚面**之下 0.8 stud**（贴着脚），
       于是玩家一落地水就在脚边、且第一跳的「跑动起跳」口径在 t=0 仍然成立。
     ★ 节奏按开发文档的「时间窗口(per break stage)」分阶：每个 break stage 升一段、
       段的接缝处留一个短平台（呼应 §4.0 的「break stage 收尾是宽安全平台」），
       水是「一阵一阵顶上来」的，而不是一条匀速直线。 */
  const surface0 = round(minFoot - 0.8, 3);                 // 初始液面：最低落脚面之下（贴脚）
  const stageSec = Math.max(1, Number(params && params.sectionTime) || 8);
  const stages = clamp(Math.round(timeLimit / stageSec), 3, 24);
  const top = round(world.topY + 24, 3);
  const bottom = basinTop;
  const h = Math.max(4, top - bottom);
  const f0 = clamp((surface0 - bottom) / h, 0.01, 0.9);
  const f1 = 0.98;
  const pos = [round((minX + maxX) / 2, 3), round(bottom + h / 2, 3), round((minZ + maxZ) / 2, 3)];
  const scale = [round(wSpan, 3), round(h, 3), round(dSpan, 3)];

  const floodId = idGen('fl');
  if (sane(pos, scale)) {
    objects.push({
      type: 'liquid',
      over: {
        id: floodId,
        kind: kindOf(wt.liquid),
        position: pos,
        scale,
        fillLevel: round(f0, 4),
        swim: true,
        oxygenMode: 'drain',
        headOnly: true,
        instantKill: false,
        drainRate: round(6 + hazard * 16, 1),
        waterResist: 0.14,
        // 水纹风格跟着主题走（normalize 会用 resolveLiquidStyle 兜底）
        liquidStyle: wt.liquid,
        flow: round(0.3 + hazard * 0.5, 2),
        castShadow: false,
        edgeFoam: true,
      },
    });
    /* ★ 涨水轨道：分 stages 段，段内匀速、段末短暂停顿（= break stage 的节奏），
       正好在关卡时限内淹到顶 */
    const span = round(timeLimit * 0.96, 2);
    const keys = [];
    for (let k = 0; k <= stages; k++) {
      const t = round(span * (k / stages), 2);
      const v = round(f0 + (f1 - f0) * (k / stages), 4);
      keys.push({ t, v, easing: 'linear' });
      // 段末平台：水停一小会儿（不超过本段时长的 1/4），给「跑完一段喘口气」
      if (k < stages) {
        const hold = Math.min(0.8, (span / stages) * 0.25);
        keys.push({ t: round(t + hold, 2), v, easing: 'linear' });
      }
    }
    const animId = idGen('an');
    animations.push({
      id: animId,
      name: '洪水上涨（开局即涨）',
      duration: round(timeLimit, 2),
      loop: false, pingpong: false, autoplay: true, enabled: true,
      tracks: [{
        objectId: floodId,
        property: 'fillLevel',
        type: 'number',
        keys,
      }],
    });

    /* ★ 开局事件：关卡一开始就触发「水上升」——播涨水动画 + 提示玩家。
       纯数据对象（不含 three），落到关卡里由 normalizeEvent/normalizeAction 补默认字段。 */
    events.push({
      name: '开局涨水',
      enabled: true,
      trigger: { type: 'levelStart' },
      start: null,
      actions: [
        { type: 'playAnim', animId },
        {
          type: 'notice',
          noticeText: `洪水开始上涨：${stages} 段 · 约 ${Math.round(timeLimit)}s 淹到顶`,
          noticeKind: 'warn',
        },
      ],
    });
  }

  /* ---------- ② 深坑灌熔岩（高难度） ---------- */
  let lavaCount = 0;
  if (difficulty >= 2.6) {
    for (const pit of route.pits || []) {
      if (!rng.chance(0.35 + hazard * 0.5)) continue;
      const topY = round(pit.y - 6, 2);
      const bot = Math.max(pit.y - pit.depth + 2, topY - 16);
      const hh = Math.max(2, topY - bot);
      const w = Math.max(10, pit.w * 0.92);
      const p2 = [pit.x, round(topY - hh / 2, 2), pit.z];
      const s2 = [round(w, 2), round(hh, 2), round(w, 2)];
      if (!sane(p2, s2)) continue;
      objects.push({
        type: 'liquid',
        over: {
          id: idGen('lv'),
          kind: 'lava',
          position: p2, scale: s2,
          fillLevel: 1,
          swim: false, instantKill: true, headOnly: false,
          color: '#ff5a1e', transparency: 0.06,
          emissive: '#3a0d00', emissiveIntensity: 0.9,
          roughness: 0.5, metalness: 0.1,
          castShadow: false,
        },
      });
      lavaCount++;
      if (lavaCount >= 4) break;
    }
  }

  return {
    objects,
    animations,
    events,
    stats: {
      flood: objects.length > 0,
      surface0: round(surface0, 2),
      fill0: round(f0, 3),
      fill1: f1,
      riseTotal: round((f1 - f0) * h, 1),
      floodKind: kindOf(wt.liquid),
      // ★ 开局即涨的分阶节奏（来自文档的「时间窗口 per break stage」）
      startsAtZero: true,
      stages,
      stageSec: round(stageSec, 2),
      events: events.length,
      lava: lavaCount,
      ms: 0,
    },
  };
}