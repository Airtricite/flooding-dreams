/* ============================================================
   世界优先管线 · Web Worker 入口
   ------------------------------------------------------------
   整条世界管线（主题 → 白模 → 演化 → 观测 → 跑酷 → 水域 → 解析自检）
   都不碰 three、也不碰 DOM，所以可以整体搬进工作线程。

   协议（与 asyncjob.js 约定）：
     主 → Worker : { type:'generate', job, opts }
     Worker → 主 : { type:'progress', job, info }
                   { type:'done',     job, core, ms }
                   { type:'error',    job, message }
   ⚠ 结构化克隆：函数（plan.rng）与重体（world 的体素格 / wt）必须剔掉。
   ============================================================ */
import { worldCore } from './world/index.js';

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'generate') return;
  const t0 = Date.now();
  try {
    const r = worldCore(msg.opts || {}, {
      onProgress: (info) => self.postMessage({ type: 'progress', job: msg.job, info }),
    });
    self.postMessage({ type: 'done', job: msg.job, core: cloneable(r), ms: Date.now() - t0 });
  } catch (e) {
    self.postMessage({
      type: 'error',
      job: msg.job,
      message: (e && e.message) ? e.message : String(e),
      stack: (e && e.stack) || '',
    });
  }
};

/** 只留能过结构化克隆、且下游真正需要的字段 */
function cloneable(r) {
  const plan = r.plan ? { ...r.plan } : null;
  if (plan) {
    delete plan.rng;          // 函数过不了线程边界
    delete plan.worldTheme;   // 蓝图里挂着 shell/theme 对象，装饰层不需要
  }
  return {
    plan,
    realized: r.realized || null,
    verify: r.verify || null,
    fpCheck: r.fpCheck || null,
    nav: null,                       // NavGraph 证明在主线程做（要 three 的射线）
    world: r.world ? { score: r.world.score, boxes: r.world.boxes.length, evolve: r.world.evolve } : null,
    seed: r.seed,
    attempt: r.attempt,
    attempts: r.attempts,
    lanes: r.lanes,
    log: r.log || [],
    failed: !!r.failed,
    reason: r.reason || '',
  };
}