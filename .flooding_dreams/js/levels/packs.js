/* ============================================================
   关卡包（Level Pack）：把若干关卡按剧情串成一张节点地图
   —— 打开关卡包 → 进入节点地图 → 逐个推进（像故事游戏那样）
   数据存进 store 的 kv（键 'levelPacks'），不改动存档结构

   纯数据结构（结构定义 / 档位 / 规范化 / 视图过滤 / 自动排布）已抽到
   pack-schema.js，那里零依赖、可被 Web Worker import；本文件只负责
   I/O、i18n 与进度汇总，并把 schema 原样再导出，保持既有 API 不变。
   ============================================================ */
import { store } from '../core/storage.js';
import { t } from '../core/i18n.js';
import * as schema from './pack-schema.js';

const KV_KEY = 'levelPacks';
const TIER_KV = 'packTiers';

export const {
  MAX_STICKERS, PACK_TIERS, tierDef, tierOfDiff, packTiers, resolveTier,
  nodeVisible, packView, nodeOf, predecessors, isUnlocked, isCleared,
  canEditPack, autoLayout,
} = schema;

/* ---------- 创建 / 规范化：注入 i18n 默认名 ---------- */
export function createPack(over = {}) { return schema.createPack(over, t('新关卡包')); }
export function createNode(over = {}) { return schema.createNode(over); }
export function normalizePack(p) { return schema.normalizePack(p, t('新关卡包')); }

/** 读出全部关卡包（原始，不归一化；供 Worker 归一化用） */
export async function loadPacksRaw() {
  let raw = null;
  try { raw = await store.kvGet(KV_KEY, []); } catch (e) { raw = []; }
  return Array.isArray(raw) ? raw : [];
}

/** 读出全部关卡包（损坏数据自动跳过） */
export async function loadPacks() {
  return (await loadPacksRaw()).filter((p) => p && p.id).map(normalizePack);
}

export function savePacks(list) {
  return store.kvSet(KV_KEY, (list || []).map(normalizePack));
}

export async function getPack(id) {
  const list = await loadPacks();
  return list.find((p) => p.id === id) || null;
}

/** 新增或覆盖一个关卡包 */
export async function upsertPack(pack) {
  const list = await loadPacks();
  const p = normalizePack(pack);
  const i = list.findIndex((x) => x.id === p.id);
  if (i >= 0) list[i] = p; else list.push(p);
  await savePacks(list);
  return p;
}

/** 删除关卡包：连同它独占的包内关卡一起删除（包内关卡不出现在任何选关列表，只能随包清理） */
export async function deletePack(id) {
  const list = await loadPacks();
  await savePacks(list.filter((p) => p.id !== id));
  try {
    const levels = await store.listLevels();
    for (const r of levels || []) {
      if (r && r.packId === id) await store.deleteLevel(r.id);
    }
  } catch (e) { console.warn('[pack] 清理包内关卡失败', e); }
}

/** 从 store 读出「已通关关卡 id」集合 */
export async function clearedLevels() {
  const set = new Set();
  try {
    const list = await store.listProgress();
    for (const r of list || []) {
      if (r && r.cleared && r.id) set.add(r.id);
    }
  } catch (e) { /* ignore */ }
  return set;
}

/** 关卡 id → 进度记录（一次读盘，供关卡包汇总与节点 PB 展示用） */
export async function progressMap() {
  const map = new Map();
  try {
    const list = await store.listProgress();
    for (const r of list || []) if (r && r.id) map.set(r.id, r);
  } catch (e) { /* ignore */ }
  return map;
}

/**
 * 进度存储键：包内游玩用「包 id + 关卡 id」的复合键，与单关卡成绩彻底隔离。
 * packId 为空 → 就是普通关卡进度键。
 */
export function progressKey(packId, levelId) {
  return packId ? packId + '|' + levelId : levelId;
}

/**
 * 读一次盘，把进度拆成两份：
 *   global  Map<levelId, rec>         —— 单关卡选关界面用
 *   byPack  Map<packId, Map<levelId, rec>> —— 各关卡包独立的进度
 */
export async function progressMaps() {
  const global = new Map();
  const byPack = new Map();
  try {
    const list = await store.listProgress();
    for (const r of list || []) {
      if (!r || !r.id) continue;
      const i = String(r.id).indexOf('|');
      if (i > 0) {
        const pid = r.id.slice(0, i);
        const lid = r.id.slice(i + 1);
        if (!byPack.has(pid)) byPack.set(pid, new Map());
        byPack.get(pid).set(lid, r);
      } else {
        global.set(r.id, r);
      }
    }
  } catch (e) { /* ignore */ }
  return { global, byPack };
}

/** 从 progressMap / progressMaps 的任一份 Map 生成「已通关关卡 id」集合 */
export function clearedSetOf(map) {
  const set = new Set();
  if (map && map.forEach) map.forEach((rec, id) => { if (rec && rec.cleared && id) set.add(id); });
  return set;
}

/**
 * 单关 PB 是否仍然有效：地图更新（关卡 updated 变化）即失效。
 * 内置 / custom 关卡没有存档记录，版本恒为 0，PB 一直有效。
 * @param rec        进度记录
 * @param curUpdated 当前该关卡的 updated 时间戳（内置/自定义传 0）
 */
export function pbInfo(rec, curUpdated) {
  const cleared = !!(rec && rec.cleared);
  const cur = Number(curUpdated) || 0;
  const stale = cleared && (rec.lvUpdated != null ? rec.lvUpdated !== cur : cur > 0);
  const best = (!stale && rec && Number(rec.bestTime)) || 0;
  return { cleared, stale, valid: cleared && !stale, best };
}

/**
 * 关卡包整体进度与用时。
 * @param pack 关卡包
 * @param prog Map<levelId, 进度记录>
 * @param upd  Map<levelId, updated 时间戳>
 * @param tier 当前档位（0 = 不分档，全部节点都算）
 * @returns {{ total, done, complete, totalTime, nodes: Map<nodeId, {cleared,stale,valid,best}> }}
 *          totalTime 仅在全部通关（done===total && total>0）时为数字，否则 null
 */
export function packProgressInfo(pack, prog, upd, tier) {
  const nodes = new Map();
  const levels = packView(pack, tier).nodes;
  let done = 0;
  let sum = 0;
  for (const n of levels) {
    const info = pbInfo(prog && prog.get(n.levelId), upd && upd.get(n.levelId));
    nodes.set(n.id, info);
    if (info.cleared) done++;
    sum += info.best || 0;
  }
  const total = levels.length;
  const complete = total > 0 && done === total;
  return { total, done, complete, totalTime: complete ? sum : null, nodes };
}

/* ---------- 玩家上次选的档位（按关卡包记） ---------- */
export async function loadPackTiers() {
  let raw = null;
  try { raw = await store.kvGet(TIER_KV, {}); } catch (e) { raw = {}; }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export async function savePackTier(packId, tier) {
  if (!packId) return;
  const m = await loadPackTiers();
  m[packId] = Number(tier) || 0;
  try { await store.kvSet(TIER_KV, m); } catch (e) { /* ignore */ }
}