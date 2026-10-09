/* ============================================================
   通用 Worker 任务池
   ------------------------------------------------------------
   与 gen/asyncjob.js 的加固手法同构（超时 / error → broken → terminate
   → 返回 null 让调用方退回主线程），但契约更通用：任意 task + payload。

   为什么单独一个池而不复用 asyncjob：
     asyncjob 顶层 import navcheck.js（裸 three），且语义是「世界候选」；
     列表管线只需要 1~2 个槽的通用池，两者互不干扰。

   可靠性：Worker 不是必须的。池建不起来 / 模块加载失败 / 超时 /
   后台标签页被冻结 → run() 一律 resolve(null)，调用方走主线程兜底。
   ⚠ 池长期驻留（复用实例，避免每次重新加载模块），关闭页面由浏览器回收。
   ============================================================ */

/** 让浏览器画一帧（把进度刷到屏幕上，再继续跑同步重活） */
export function yieldFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * @param {object} cfg
 * @param {string} cfg.name      日志用（如 'list'）
 * @param {URL}    cfg.url       worker 入口（new URL('./x-worker.js', import.meta.url)）
 * @param {number} [cfg.size]    池槽数（默认 1）
 * @param {number} [cfg.timeout] 默认作业超时 ms（默认 12000）
 */
export function createPool(cfg) {
  const name = cfg.name || 'pool';
  const url = cfg.url;
  const maxSize = Math.max(1, Number(cfg.size) || 1);
  const defaultTimeout = Number(cfg.timeout) || 12000;

  const slots = [];        // [{ w, broken, load }]
  let _jobId = 0;
  let _dead = false;       // 全池不可用：不再尝试重建
  let _logged = false;

  function logDeadOnce() {
    if (_logged) return;
    _logged = true;
    console.info(`[${name}] Worker 池不可用，退回主线程`);
  }

  function spawn() {
    let w;
    try { w = new Worker(url, { type: 'module' }); }
    catch (e) { return null; }
    const slot = { w, broken: false, load: 0 };
    // 模块图加载失败会在这里触发
    w.addEventListener('error', () => {
      slot.broken = true;
      try { w.terminate(); } catch (e) { /* ignore */ }
    });
    return slot;
  }

  function ensure() {
    if (_dead || slots.length) return;
    for (let i = 0; i < maxSize; i++) {
      const s = spawn();
      if (!s) { _dead = true; break; }
      slots.push(s);
    }
  }

  function pick() {
    // 优先空闲槽
    for (const s of slots) if (!s.broken && s.load === 0) return s;
    // 还有余量就扩
    if (!_dead && slots.length < maxSize) {
      const s = spawn();
      if (s) { slots.push(s); return s; }
      _dead = true;
    }
    // 全忙：挑负载最低的（同一槽内的作业由 worker 顺序执行）
    let best = null;
    for (const s of slots) if (!s.broken && (!best || s.load < best.load)) best = s;
    return best;
  }

  return {
    /**
     * 跑一个任务；worker 不可用 / 失败 / 超时 / 中止 → null
     * @param {string} task
     * @param {object} payload  必须可结构化克隆
     * @param {{timeout?:number, onProgress?:(info:any)=>void, signal?:AbortSignal}} [opts]
     */
    run(task, payload, opts = {}) {
      ensure();
      const slot = pick();
      if (!slot || slot.broken) { logDeadOnce(); return Promise.resolve(null); }
      const job = ++_jobId;
      slot.load++;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { slot.w.removeEventListener('message', onMsg); slot.w.removeEventListener('error', onErr); } catch (e) { /* ignore */ }
          if (opts.signal) { try { opts.signal.removeEventListener('abort', onAbort); } catch (e) { /* ignore */ } }
          slot.load--;
          resolve(v);
        };
        const onMsg = (ev) => {
          const m = ev.data || {};
          if (m.job !== job) return;
          if (m.type === 'progress') { if (opts.onProgress) opts.onProgress(m.info); return; }
          if (m.type === 'done') { finish(m.result); return; }
          if (m.type === 'error') {
            console.warn(`[${name}] 任务失败，退回主线程`, m.message);
            finish(null);
          }
        };
        const onErr = () => {
          slot.broken = true;
          try { slot.w.terminate(); } catch (e) { /* ignore */ }
          finish(null);
        };
        const onAbort = () => finish(null);
        const timer = setTimeout(() => {
          slot.broken = true;
          try { slot.w.terminate(); } catch (e) { /* ignore */ }
          finish(null);
        }, Number(opts.timeout) || defaultTimeout);
        slot.w.addEventListener('message', onMsg);
        slot.w.addEventListener('error', onErr);
        if (opts.signal) {
          if (opts.signal.aborted) { finish(null); return; }
          opts.signal.addEventListener('abort', onAbort);
        }
        try { slot.w.postMessage({ type: 'task', job, task, payload }); }
        catch (e) { slot.broken = true; finish(null); }
      });
    },
    /** 至少有一个可用槽 */
    available() { return slots.some((s) => !s.broken); },
    size() { return slots.filter((s) => !s.broken).length; },
    busy() { return slots.filter((s) => !s.broken && s.load > 0).length; },
    dispose() {
      for (const s of slots) { try { s.w.terminate(); } catch (e) { /* ignore */ } }
      slots.length = 0;
      _dead = true;
    },
  };
}