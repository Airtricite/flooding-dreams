/* ============================================================
   世界优先管线 · 搜索核心（纯计算层，可在 Worker 里跑）
   ------------------------------------------------------------
   一次「世界 → 跑酷 → 水」的生成未必就合格，所以这里管重试与验收：
     · 解析自检不过      → 几何上就跳不过去，换种子
     · 净爬升 ≤ 0        → 不是「往上逃」的图，换种子
     · 跑图耗时太短      → 内容量没铺够（撑不起 1:30~2:00），换种子
   每失败一次就收紧缺口比例（越往后越保守），与旧版同一套修复策略。

   ★ 重试很便宜：解析自检是微秒级的，根本不会走到昂贵的 NavGraph。
   ★ 并行版在 asyncjob.js（Worker 池一次跑多条「世界」候选，再挑最好的）。
   ============================================================ */
import { clamp } from '../core/util.js';
import { worldCore } from './world/index.js';

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 一次生成是否达标（解析层能判的都在这里） */
export function coreViable(rec) {
  if (!rec || !rec.plan || !rec.realized || !rec.verify) return { ok: false, why: 'no-graph' };
  if (!rec.verify.ok) return { ok: false, why: 'analytic', n: rec.verify.failures.length };
  const fp = rec.verify.fingerprint;
  if (!(fp.netRise > 0)) return { ok: false, why: 'netRise', v: fp.netRise };
  // 内容量门槛：地图要撑得起关卡时长。世界优先管线的天然步幅更大（体素台阶 5 stud
// 一级），所以这里只拦「几乎没内容」的退化图，不再按旧口径卡 15%。
  const minTime = Math.max(6, rec.plan.timeLimit * 0.06);
  if (rec.verify.estTime < minTime) return { ok: false, why: 'short', v: rec.verify.estTime };
  return { ok: true };
}

/**
 * 候选世界的综合得分（并行多候选时用它挑榜首）。
 * 三条设计核心各占一份：世界质量 / 难度指纹贴合 / 往上逃成色 / 空间多样性。
 */
export function coreScore(rec) {
  if (!rec || !rec.verify) return -Infinity;
  const fp = rec.verify.fingerprint;
  const target = rec.plan.params.gapRatio;
  const gapFit = 1 - Math.min(1, Math.abs(fp.maxGapRatio - target) / 0.3);
  const worldQ = rec.world ? (rec.world.score || 0) : 0;
  return 1.2 * worldQ
    + 0.8 * gapFit
    + 0.5 * clamp(fp.climbRatio, 0, 1)
    + 0.4 * clamp(fp.netRise / 120, 0, 1)
    + 0.3 * clamp(fp.turnSumDeg / 4200, 0, 1)
    + 0.2 * clamp(fp.choices / 8, 0, 1);
}

/**
 * 顺序重试（主线程兜底 / 同步 generate 用）。
 * @param hooks { onProgress, check }
 *   check(rec) → boolean：解析过了但不要它（repair 在这里叠 NavGraph 证明）
 */
export function searchCore(opts = {}, hooks = {}) {
  const { onProgress, check } = hooks;
  const attempts = Math.max(1, Math.min(24, Math.round(Number(opts.attempts) || 6)));
  const baseSeed = opts.seed == null || opts.seed === '' ? String(Date.now()) : String(opts.seed);
  const log = [];
  let last = null;
  let best = null;

  for (let a = 0; a < attempts; a++) {
    const seed = a === 0 ? baseSeed : `${baseSeed}#${a}`;
    const o = { ...opts, seed };
    if (a > 0) o.gapScale = Math.max(0.5, 1 - 0.03 * a);   // 越往后缺口越保守

    let rec;
    try {
      rec = worldCore(o, {
        onProgress: (info) => { if (onProgress) onProgress({ attempt: a + 1, attempts, ...info }); },
      });
    } catch (e) {
      log.push({ attempt: a + 1, seed, error: (e && e.message) || String(e) });
      continue;
    }
    const v = coreViable(rec);
    const entry = {
      attempt: a + 1, seed,
      ok: !!(rec.verify && rec.verify.ok),
      why: v.ok ? '' : v.why,
      failures: rec.verify ? rec.verify.failures.length : 0,
      first: rec.verify && rec.verify.failures[0] ? rec.verify.failures[0].reason : null,
      netRise: rec.verify ? rec.verify.fingerprint.netRise : 0,
      estTime: rec.verify ? rec.verify.estTime : 0,
      pads: rec.verify ? rec.verify.fingerprint.nodeCount : 0,
      score: round2(coreScore(rec)),
      boxes: rec.world ? rec.world.boxes : 0,
    };
    log.push(entry);
    if (onProgress) {
      onProgress({
        attempt: a + 1, attempts, ok: entry.ok, netRise: entry.netRise,
        estTime: entry.estTime, boxes: entry.boxes, pads: entry.pads, why: entry.why,
      });
    }

    last = rec;
    if (!v.ok) { if (!best && rec.verify && rec.verify.ok) best = rec; continue; }

    const accept = check ? !!check(rec, entry) : true;
    if (accept) return { ...rec, attempts: a + 1, log, failed: false };
    if (!best) best = rec;
  }

  const out = best || last;
  return {
    ...(out || { plan: null, realized: null, verify: null, fpCheck: null, world: null, wt: null, seed: baseSeed }),
    attempts,
    log,
    failed: !(out && out.verify && out.verify.ok),
  };
}

export { round2 };