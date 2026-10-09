/* ============================================================
   列表纯任务层（主线程兜底与 Worker 共用同一份实现）
   ------------------------------------------------------------
   ⚠ 依赖白名单：只允许 import pack-schema.js（零依赖）。
     禁止 three / cannon / document / window / store / i18n。
     因为 index.html 的 importmap 不覆盖 Worker，裸 'three' 在 Worker 里解析失败。

   任务：
     levelList  : store 关卡记录 → 投影成卡片元数据 + 统计（剥掉全量 data）
     packList   : 原始关卡包 → normalizePack + 包内档位
     replayList : store kv 记录 → 回放摘要（丢弃逐帧 frames）
     assetList  : 素材记录 → 按 created 倒序
     assetRefs  : 全部关卡数据 → 素材 id → 引用它的关卡 id 列表（素材按关卡分包用）
     prefabList : 预制件索引 → 按 updated 倒序
   ============================================================ */
import { normalizePack, packTiers } from '../levels/pack-schema.js';
import { createPool, yieldFrame } from './job-pool.js';

const CHUNK = 64;

/* ============================================================
   Worker 池（列表专用；懒创建槽位，仅在真正需要时才 spawn）
   ============================================================ */
function listPoolSize() {
  const hc = (typeof navigator !== 'undefined' && Number(navigator.hardwareConcurrency)) || 4;
  return Math.min(2, Math.max(1, Math.floor(hc / 8) + 1));
}
const pool = createPool({
  name: 'list',
  url: new URL('./list-worker.js', import.meta.url),
  size: listPoolSize(),
  timeout: 12000,
});
export function listPoolState() { return pool.available() ? `list:${pool.size()}` : 'list:off'; }

/* ============================================================
   纯逻辑
   ============================================================ */
function isObj(v) { return !!v && typeof v === 'object'; }

/** 由 raw 关卡数据投射出卡片需要的统计；与 levelStats(normalizeLevel(raw)) 对齐 */
function rawStats(data) {
  const objs = isObj(data) && Array.isArray(data.objects) ? data.objects : [];
  const evs = isObj(data) && Array.isArray(data.events) ? data.events : [];
  const ans = isObj(data) && Array.isArray(data.animations) ? data.animations : [];
  let objects = 0;
  let liquids = 0;
  for (const o of objs) {
    if (!isObj(o)) continue;
    objects++;
    if (o.type === 'liquid') liquids++;
  }
  let events = 0;
  for (const e of evs) if (isObj(e)) events++;
  let animations = 0;
  for (const a of ans) if (isObj(a)) animations++;
  return { objects, liquids, events, animations };
}

/** store 记录 → 卡片元数据（剥掉 data，减小跨线程/内存开销） */
function projectLevel(rec, scope) {
  const meta = {
    id: rec.id,
    name: rec.name || '未命名',
    author: rec.author || '玩家',
    description: rec.description || '',
    difficulty: Number(rec.difficulty) || 1,
    updated: rec.updated || 0,
    created: rec.created || 0,
    bytes: rec.bytes || 0,
    builtin: !!rec.builtin,
    packId: rec.packId || '',
    thumb: rec.thumb || null,
    kind: 'user',
    ok: true,
    stats: null,
    bgm: '',
  };
  const d = rec.data;
  if (isObj(d) && isObj(d.settings) && d.settings.bgm) meta.bgm = d.settings.bgm;
  if (scope === 'index') return meta;         // 索引模式不做统计（省掉最贵的遍历）
  try {
    meta.stats = !isObj(d)
      ? { objects: 0, liquids: 0, events: 0, animations: 0 }
      : rawStats(d);
  } catch (e) { meta.ok = false; meta.stats = null; }
  return meta;
}

function levelList(payload, onSlice) {
  let recs = payload.recs;
  if (payload.recsText != null) recs = JSON.parse(payload.recsText);
  const list = Array.isArray(recs) ? recs : [];
  const scope = payload.scope || 'all';
  const out = [];
  let malformed = 0;
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    if (!rec || !rec.id) continue;
    const item = projectLevel(rec, scope);
    if (!item.ok) malformed++;
    out.push(item);
    if (onSlice && (i % CHUNK === CHUNK - 1)) onSlice({ done: i + 1, total: list.length });
  }
  let items = out;
  if (scope === 'saves') {
    items = out.filter((x) => !x.builtin && !x.packId).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }
  if (onSlice) onSlice({ done: list.length, total: list.length });
  return { items, total: items.length, malformed };
}

function packList(payload) {
  const raw = Array.isArray(payload.raw) ? payload.raw : [];
  const defaultName = payload.defaultName || '新关卡包';
  const packs = raw.filter((p) => p && p.id).map((p) => normalizePack(p, defaultName));
  const tiers = {};
  for (const p of packs) tiers[p.id] = packTiers(p);
  return { packs, tiers };
}

// 与 game/replay.js 的 KEY_PREFIX / REPLAY_VERSION 保持一致（那里 import 了 three，Worker 不能引）
const REPLAY_KEY_PREFIX = 'fd.replay.';
const REPLAY_VERSION = 1;

function replayList(payload) {
  let kv = payload.kv;
  if (payload.kvText != null) kv = JSON.parse(payload.kvText);
  const list = Array.isArray(kv) ? kv : [];
  const levelId = payload.levelId;
  const out = [];
  for (const r of list) {
    if (!r || typeof r.k !== 'string' || !r.k.startsWith(REPLAY_KEY_PREFIX)) continue;
    const v = r.v;
    if (!v || v.v !== REPLAY_VERSION) continue;
    if (levelId && v.levelId !== levelId) continue;
    const s = v.summary || {};
    out.push({
      id: v.id, levelId: v.levelId, levelName: v.levelName || s.levelName || '未知关卡',
      at: v.at || s.at || 0, duration: v.duration || 0, win: !!v.win,
      deaths: v.deaths || 0, reason: v.reason || '', test: !!v.test,
      clips: s.clips || 0,
    });
  }
  return { items: out.sort((a, b) => b.at - a.at) };
}

function assetList(payload) {
  const recs = Array.isArray(payload.recs) ? payload.recs : [];
  return { items: recs.slice().sort((a, b) => (b.created || 0) - (a.created || 0)) };
}

/* ---------- 素材引用（素材「按关卡分包」的依据） ---------- */
/** 存「裸素材 id」（不带 asset: 前缀）的字段，与 core/level-assets.js 保持一致 */
const BARE_KEYS = ['assetId', 'morphAsset', 'textureAsset'];

/** 收集一份关卡数据里引用到的全部素材 id */
function collectRefs(v, out) {
  if (!v) return;
  if (typeof v === 'string') { if (v.startsWith('asset:')) out.add(v.slice(6)); return; }
  if (Array.isArray(v)) { for (const x of v) collectRefs(x, out); return; }
  if (typeof v !== 'object') return;
  for (const k in v) {
    const val = v[k];
    if (typeof val === 'string') {
      if (val.startsWith('asset:')) out.add(val.slice(6));
      else if (BARE_KEYS.indexOf(k) >= 0 && val) out.add(val);
    } else {
      collectRefs(val, out);
    }
  }
}

/**
 * 全部关卡数据 → { refs: { 素材id: [关卡id…] }, names: { 关卡id: 关卡名 } }
 * 只看关卡数据（不看 asset.level），因为用户要的是「只要该关卡用到某素材就显示」。
 */
function assetRefs(payload, onSlice) {
  let levels = payload.levels;
  if (payload.levelsText != null) levels = JSON.parse(payload.levelsText);
  const list = Array.isArray(levels) ? levels : [];
  const refs = {};
  const names = {};
  for (let i = 0; i < list.length; i++) {
    const lv = list[i];
    if (lv && lv.id) {
      names[lv.id] = lv.name || lv.id;
      const set = new Set();
      collectRefs(lv.data, set);
      for (const id of set) (refs[id] || (refs[id] = [])).push(lv.id);
    }
    if (onSlice && (i % CHUNK === CHUNK - 1)) onSlice({ done: i + 1, total: list.length });
  }
  if (onSlice) onSlice({ done: list.length, total: list.length });
  return { refs, names, count: list.length };
}

function prefabList(payload) {
  const recs = Array.isArray(payload.recs) ? payload.recs : [];
  return { items: recs.slice().sort((a, b) => (Number(b.updated || b.created) || 0) - (Number(a.updated || a.created) || 0)) };
}

/** 同步执行一个任务（Worker 内与主线程兜底共用） */
export function handleListJob(task, payload = {}, onSlice) {
  switch (task) {
    case 'levelList': return levelList(payload, onSlice);
    case 'packList': return packList(payload, onSlice);
    case 'replayList': return replayList(payload, onSlice);
    case 'assetList': return assetList(payload, onSlice);
    case 'assetRefs': return assetRefs(payload, onSlice);
    case 'prefabList': return prefabList(payload, onSlice);
    default: throw new Error('unknown list task: ' + task);
  }
}

/** 只在本文件内使用：合并分片结果 */
function mergeResults(task, parts) {
  if (task === 'packList') {
    const packs = [];
    const tiers = {};
    for (const p of parts) { packs.push(...p.packs); Object.assign(tiers, p.tiers); }
    return { packs, tiers };
  }
  if (task === 'assetRefs') {
    const refs = {};
    const names = {};
    let count = 0;
    for (const p of parts) {
      Object.assign(names, p.names || {});
      count += p.count || 0;
      for (const id in (p.refs || {})) {
        const cur = refs[id] || (refs[id] = []);
        for (const lv of p.refs[id]) if (cur.indexOf(lv) < 0) cur.push(lv);
      }
    }
    return { refs, names, count };
  }
  const items = [];
  let malformed = 0;
  for (const p of parts) { items.push(...p.items); malformed += p.malformed || 0; }
  if (task === 'levelList') return { items, total: items.length, malformed };
  if (task === 'replayList') return { items: items.sort((a, b) => b.at - a.at) };
  return { items };   // assetList / prefabList：各分片已按时间倒序，保持顺序即可
}

/* ============================================================
   统一入口（UI 只调这一个）
   ============================================================ */
function countOf(payload) {
  if (Array.isArray(payload.recs)) return payload.recs.length;
  if (Array.isArray(payload.raw)) return payload.raw.length;
  if (Array.isArray(payload.kv)) return payload.kv.length;
  if (Array.isArray(payload.assetRecs)) return payload.assetRecs.length;
  if (Array.isArray(payload.levels)) return payload.levels.length;
  return 0;
}
function approxBytes(payload) {
  if (typeof payload.recsText === 'string') return payload.recsText.length;
  if (typeof payload.kvText === 'string') return payload.kvText.length;
  if (typeof payload.levelsText === 'string') return payload.levelsText.length;
  const recs = payload.recs || payload.raw || payload.kv || [];
  let n = 0;
  for (const r of recs) n += (r && r.bytes) || 256;
  return n;
}
/** 小列表走 Worker 反而更慢（线程启动 + 克隆），直接主线程跑 */
function shouldThread(payload) {
  if (typeof payload.recsText === 'string') return payload.recsText.length >= 256 * 1024;
  if (typeof payload.kvText === 'string') return payload.kvText.length >= 256 * 1024;
  if (typeof payload.levelsText === 'string') return payload.levelsText.length >= 128 * 1024;
  const n = countOf(payload);
  if (!n) return false;
  return n >= 12 || approxBytes(payload) >= 256 * 1024;
}

/** 主线程兜底：分片执行 + 让出帧，避免把卡顿变成一次长阻塞 */
async function runLocalChunked(task, payload, opts) {
  let p = payload;
  if (typeof p.recsText === 'string') p = { ...p, recs: JSON.parse(p.recsText), recsText: null };
  if (typeof p.kvText === 'string') p = { ...p, kv: JSON.parse(p.kvText), kvText: null };
  if (typeof p.levelsText === 'string') p = { ...p, levels: JSON.parse(p.levelsText), levelsText: null };
  const key = Array.isArray(p.recs) ? 'recs' : Array.isArray(p.raw) ? 'raw'
    : Array.isArray(p.kv) ? 'kv' : Array.isArray(p.levels) ? 'levels' : null;
  if (!key) return handleListJob(task, p);
  const arr = p[key];
  if (arr.length <= CHUNK) return handleListJob(task, p);
  const parts = [];
  for (let i = 0; i < arr.length; i += CHUNK) {
    parts.push(handleListJob(task, { ...p, [key]: arr.slice(i, i + CHUNK) }));
    if (opts && opts.onProgress) opts.onProgress({ done: Math.min(i + CHUNK, arr.length), total: arr.length });
    await yieldFrame();
  }
  return mergeResults(task, parts);
}

/**
 * 跑一个列表任务：优先 Worker，失败/超时/中止/数据太小 → 主线程分片兜底。
 * @returns 任务结果（结构见 handleListJob）
 */
export async function runListTask(task, payload, opts = {}) {
  if (shouldThread(payload)) {
    const res = await pool.run(task, payload, {
      onProgress: opts.onProgress, signal: opts.signal, timeout: opts.timeout,
    });
    if (res) return res;
    if (opts.onLocalFallback) opts.onLocalFallback();
  }
  return runLocalChunked(task, payload, opts);
}