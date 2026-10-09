/* ============================================================
   世界优先管线 · 异步多线程编排
   ------------------------------------------------------------
   目标：**生成时界面不卡，而且一次跑多条世界候选并行挑选**。

   分工：
     · 纯计算（主题 / 白模 / 演化 / 观测 / 跑酷 / 水域 / 解析自检）
       → **Worker 池**（worker.js）。它不依赖 three / DOM，可以整体搬走。
       每条候选世界跑在一个池槽里 —— 这就是「迭代技术 + 异步多线程」：
       一次并行 N 条不同的世界，主线程按（世界质量 + 难度指纹 + 往上逃成色）
       挑出榜首，再交给昂贵的 NavGraph 证明。
     · NavGraph 逐边证明要 three 的射线 → 只能在主线程，但只跑 1~2 次。

   可靠性：Worker 不是必须的。池建不起来 / 模块加载失败 / 超时 /
   后台标签页被冻结 → 自动退回主线程顺序生成（search.js）。

   ⚠ 池长期驻留（复用实例，避免每次重新加载模块），关闭页面由浏览器回收。
   ============================================================ */
import { clamp } from '../core/util.js';
import { searchCore, coreViable, coreScore } from './search.js';
import { navProve } from './navcheck.js';

const JOB_TIMEOUT = 45000;      // 单作业最长等待（涨水世界比旧版重一点）
const MAX_ROUNDS = 3;           // NavGraph 判定走不通 → 换一批候选再来
const POOL_MAX = 4;             // 池上限（每条候选一张体素格，别开太多）

let _pool = [];                 // [{ w, broken, job }]
let _jobId = 0;

/** 让浏览器画一帧（把进度刷到屏幕上，再继续跑同步重活） */
export function yieldFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** 并行度：CPU 逻辑核数的一半（留一半给渲染），夹在 2~4 */
function workerCount() {
  const hc = (typeof navigator !== 'undefined' && Number(navigator.hardwareConcurrency)) || 4;
  return clamp(Math.floor(hc / 2) || 2, 2, POOL_MAX);
}

function spawnWorker() {
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onerror = () => { /* 由每个作业的 onErr 处理 */ };
    return { w, broken: false, job: 0 };
  } catch (e) {
    return { w: null, broken: true, job: 0 };
  }
}

function ensurePool(n) {
  while (_pool.length < n) {
    const slot = spawnWorker();
    if (!slot.w) break;
    _pool.push(slot);
  }
  return _pool;
}

/** 在某个池槽上跑一次生成；失败/超时返回 null（调用方退回主线程） */
function runOnSlot(slot, opts, onProgress, lane) {
  const w = slot.w;
  if (!w || slot.broken) return Promise.resolve(null);
  const job = ++_jobId;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      resolve(v);
    };
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.job !== job) return;
      if (m.type === 'progress') { if (onProgress) onProgress(m.info, lane); return; }
      if (m.type === 'done') { finish(m.core); return; }
      if (m.type === 'error') {
        console.warn('[gen] Worker 生成失败，退回主线程', m.message);
        slot.broken = true;
        finish(null);
      }
    };
    const onErr = () => { slot.broken = true; try { w.terminate(); } catch (e) { /* ignore */ } finish(null); };
    const timer = setTimeout(() => { slot.broken = true; try { w.terminate(); } catch (e) { /* ignore */ } finish(null); }, JOB_TIMEOUT);
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    try { w.postMessage({ type: 'generate', job, opts }); } catch (e) { slot.broken = true; finish(null); }
  });
}

/**
 * 一次并行 N 条世界候选。
 * @returns 候选核心结果数组（可能为空 = Worker 不可用）
 */
async function runLanes(opts, lanes, onProgress) {
  const pool = ensurePool(lanes).filter((s) => !s.broken);
  if (!pool.length) return [];
  const base = opts.seed == null || opts.seed === '' ? String(Date.now()) : String(opts.seed);
  const jobs = pool.slice(0, lanes).map((slot, i) => {
    const host = { width: i, seed: `${base}~L${i}`, lane: i };
    return runOnSlot(slot, { ...opts, ...host }, onProgress, i);
  });
  const res = await Promise.all(jobs);
  return res.filter(Boolean);
}

/**
 * 完整核心流程：并行候选世界 → 挑榜首 → NavGraph 证明（+ 走不通换一批）。
 * 返回结构与 index.assemble 兼容。
 */
export async function generateCoreAsync(opts = {}, onProgress) {
  const navMode = opts.navMode === 'off' || opts.navMode === 'strict' ? opts.navMode : 'try';
  const baseSeed = opts.seed == null || opts.seed === '' ? String(Date.now()) : String(opts.seed);
  const lanes = clamp(Math.round(Number(opts.lanes) || workerCount()), 1, POOL_MAX);
  const rounds = navMode === 'off' ? 1 : MAX_ROUNDS;
  let last = null;
  let usedLanes = 0;

  for (let round = 0; round < rounds; round++) {
    const seed = round === 0 ? baseSeed : `${baseSeed}~R${round}`;
    if (onProgress) {
      onProgress({ phase: 'search', msg: `并行演化 ${lanes} 条世界候选（第 ${round + 1} 轮）…` });
    }
    let cores = await runLanes({ ...opts, seed, navMode: 'off' }, lanes, (info, lane) => {
      if (onProgress) onProgress({ ...info, lane, lanes, round: round + 1 });
    });

    if (!cores.length) {
      // Worker 不可用 → 主线程顺序兜底
      if (onProgress) onProgress({ attempt: 0, attempts: 0, main: true });
      await yieldFrame();
      const one = searchCore({ ...opts, seed, navMode: 'off' }, {
        onProgress: (info) => { if (onProgress) onProgress({ ...info, main: true }); },
      });
      cores = one ? [one] : [];
    }
    usedLanes = Math.max(usedLanes, cores.length);
    if (!cores.length) { continue; }

    const viable = cores.filter((c) => coreViable(c).ok);
    const graded = (viable.length ? viable : cores).slice().sort((a, b) => coreScore(b) - coreScore(a));
    const chosen = graded[0];
    if (!chosen || !chosen.realized || !chosen.plan) { last = chosen || last; continue; }

    let nav = null;
    if (navMode !== 'off') {
      if (onProgress) onProgress({ phase: 'nav', msg: `正在真实几何上证明可通关（第 ${round + 1} 轮）…` });
      await yieldFrame();
      nav = navProve(chosen.realized, chosen.plan.P, opts.nav || {});
      const blocked = nav.blocked > 0;
      const strictFail = navMode === 'strict' && !nav.ok;
      if (blocked || strictFail) { last = { ...chosen, nav }; continue; }
    }
    return {
      ...chosen,
      nav,
      navMode,
      navProven: !!(nav && nav.ok),
      attempts: cores.length,
      lanes: usedLanes,
      candidates: cores.map((c) => ({ seed: c.seed, score: c.world ? c.world.score : null, viable: coreViable(c).ok })),
    };
  }

  const out = last || null;
  return {
    ...(out || {}),
    navMode,
    navProven: !!(out && out.nav && out.nav.ok),
    attempts: out && out.attempts != null ? out.attempts : 0,
    lanes: usedLanes,
  };
}

/** Worker 池是否已经用上了（报告 / 日志用） */
export function workerState() {
  const live = _pool.filter((s) => !s.broken && s.w).length;
  return live ? `pool:${live}` : 'unavailable';
}

/** 池规模（供 UI 提示「异步多线程」开了几条） */
export function poolSize() { return workerCount(); }