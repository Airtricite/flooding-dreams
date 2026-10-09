/* ============================================================
   分片渲染队列 + 流式分批加载
   —— 列表边加载边显示：每批（约 20 条）处理完立刻上屏，
      不用等整份数据齐了才画第一张卡片。
   ============================================================ */
import { yieldFrame } from '../core/job-pool.js';

/**
 * 在已排序数组里找 item 的插入位置（保持既有顺序）。
 * cmp(a, b) 与 Array#sort 一致：<0 表示 a 在前。
 * 相等时插到后面（后到的排在后面，保证「先到先显示」稳定）。
 */
export function lowerBound(arr, item, cmp) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(arr[mid], item) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 流式分批：把 items 按 batchSize 切片，逐批交给 process（异步），
 * 每批处理完立即回调 onBatch，并在批与批之间让出一帧，保证 UI 不卡。
 *
 * @param {Array} items
 * @param {{
 *   batchSize?:number,
 *   process?:(batch:any[], offset:number)=>Promise<any[]>|any[],
 *   onBatch?:(out:any[], offset:number, total:number)=>void,
 *   onProgress?:(info:{done:number,total:number})=>void,
 *   signal?:AbortSignal,
 * }} [opts]
 */
export async function streamBatches(items, opts = {}) {
  const list = items || [];
  const size = Math.max(1, Number(opts.batchSize) || 20);
  const signal = opts.signal || null;
  for (let i = 0; i < list.length; i += size) {
    if (signal && signal.aborted) return;
    const slice = list.slice(i, i + size);
    let out = slice;
    if (typeof opts.process === 'function') {
      try { out = (await opts.process(slice, i)) || []; }
      catch (e) { out = []; }
    }
    if (signal && signal.aborted) return;
    if (opts.onBatch) opts.onBatch(out, i, list.length);
    if (opts.onProgress) opts.onProgress({ done: Math.min(i + size, list.length), total: list.length });
    if (i + size < list.length) await yieldFrame();
  }
}

/* ============================================================
   分片渲染队列：首帧同步画一批，其余每帧画 perFrame 张
   —— 一次性拿到整份数据时，避免一次性建几百个卡片把主线程堵死
   ============================================================ */
/**
 * @param {HTMLElement} host     容器
 * @param {Array} items          数据
 * @param {(item:any, i:number)=>Node} factory  建卡函数
 * @param {{firstBatch?:number, perFrame?:number, onDone?:()=>void}} [opts]
 * @returns {{cancel:()=>void, done:Promise<void>}}
 */
export function chunkedAppend(host, items, factory, opts = {}) {
  const list = items || [];
  const firstBatch = Math.max(0, opts.firstBatch != null ? opts.firstBatch : 24);
  const perFrame = Math.max(1, opts.perFrame || 12);
  let cancelled = false;

  const first = Math.min(firstBatch, list.length);
  for (let i = 0; i < first; i++) host.appendChild(factory(list[i], i));

  let i = first;
  const done = new Promise((resolve) => {
    if (i >= list.length) { if (opts.onDone) opts.onDone(); resolve(); return; }
    const step = () => {
      if (cancelled) { resolve(); return; }
      const end = Math.min(i + perFrame, list.length);
      for (; i < end; i++) host.appendChild(factory(list[i], i));
      if (i >= list.length) { if (opts.onDone) opts.onDone(); resolve(); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  return { cancel() { cancelled = true; }, done };
}