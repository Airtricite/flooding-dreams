/* ============================================================
   列表处理 · Web Worker 入口
   ------------------------------------------------------------
   纯 JSON 处理（解析 / 投影 / 统计 / 排序），不碰 three、不碰 DOM。
   协议（与 core/job-pool.js 约定）：
     主 → Worker : { type:'task', job, task, payload }
     Worker → 主 : { type:'ready',    caps }
                   { type:'progress', job, info }
                   { type:'done',     job, result, ms }
                   { type:'error',    job, message, stack }
   ============================================================ */
import { handleListJob } from './list-tasks.js';

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'task') return;
  const t0 = Date.now();
  try {
    const result = handleListJob(msg.task, msg.payload || {}, (info) => {
      self.postMessage({ type: 'progress', job: msg.job, info });
    });
    self.postMessage({ type: 'done', job: msg.job, result, ms: Date.now() - t0 });
  } catch (e) {
    self.postMessage({
      type: 'error',
      job: msg.job,
      message: (e && e.message) ? e.message : String(e),
      stack: (e && e.stack) || '',
    });
  }
};

self.postMessage({ type: 'ready', caps: { tasks: ['levelList', 'packList', 'replayList', 'assetList', 'assetRefs', 'prefabList'] } });