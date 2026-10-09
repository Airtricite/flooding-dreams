/* ============================================================
   关卡包文件（.fdpack）
   一个关卡包文件 = 节点地图 + 它引用到的【全部关卡的完整副本】+ 这些
   关卡的本地化素材（base64）。导入时不依赖对方环境，即开即用。
   为了不覆盖本机存档、保证可反复导入：
     · 每个关卡都换新 id（并重写素材引用、素材也换新 id）
     · 每个节点 / 每条边 / 关卡包本身都换新 id，节点指向新关卡
   ============================================================ */
import { store } from './storage.js';
import { uid, deepClone } from './util.js';
import { normalizeLevel } from '../world/level.js';
import { getBuiltinLevels, loadCustomLevels } from '../levels/builtin.js';
import { packLevelAssets, unpackLevelAssets } from './level-assets.js';
import { createPack, createNode, normalizePack, upsertPack } from '../levels/packs.js';

export const PACK_KIND = 'flooding-dreams-pack';
export const PACK_VER = 1;
export const PACK_EXT = '.fdpack';

/** 找一个关卡的来源（自定义存档优先，其次内置 / custom 关卡目录） */
async function _sourceOf(levelId) {
  if (!levelId) return null;
  try {
    const rec = await store.getLevel(levelId);
    if (rec && rec.data) {
      return {
        id: levelId, name: rec.name || rec.data.name || '', author: rec.author || '',
        description: rec.description || '', difficulty: Number(rec.difficulty) || 1,
        builtin: !!rec.builtin, data: rec.data,
      };
    }
  } catch (e) { /* 继续找内置 */ }
  try {
    await loadCustomLevels();
    const b = getBuiltinLevels().find((l) => l && l.id === levelId);
    if (b) {
      return {
        id: levelId, name: b.name || '', author: b.author || '',
        description: b.description || '', difficulty: Number(b.difficulty) || 1,
        builtin: true, data: b,
      };
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * 打包一个关卡包：节点地图 + 全部关卡的完整副本 + 素材。
 * 找不到的关卡会记在 missing 里（仍可在别处导入，只是缺那一关）。
 * @returns {Promise<object>} 可直接 JSON.stringify 的包对象
 */
export async function exportPackBundle(pack) {
  const p = normalizePack(pack);
  const ids = [...new Set(p.nodes.map((n) => n.levelId).filter(Boolean))];
  const levels = [];
  const missing = [];
  for (const id of ids) {
    const src = await _sourceOf(id);
    if (!src) { missing.push(id); continue; }
    const data = deepClone(src.data);
    const assets = await packLevelAssets(data);
    levels.push({ ...src, data, assets });
  }
  return {
    kind: PACK_KIND,
    v: PACK_VER,
    game: 'Flooding Dreams',
    date: Date.now(),
    pack: p,
    levels,
    missing,
  };
}

/** 读取并校验一个关卡包文件（不写任何数据） */
export function readPackBundle(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { bundle: null, error: '文件不是合法的 JSON' }; }
  if (!raw || raw.kind !== PACK_KIND) {
    return { bundle: null, error: '这不是 Flooding Dreams 关卡包文件' };
  }
  if (Number(raw.v) > PACK_VER) {
    return { bundle: null, error: `关卡包文件版本过新（v${raw.v}），请更新游戏` };
  }
  if (!raw.pack || !Array.isArray(raw.pack.nodes)) {
    return { bundle: null, error: '关卡包文件缺少节点地图数据' };
  }
  if (!Array.isArray(raw.levels)) raw.levels = [];
  return { bundle: raw, error: null };
}

/**
 * 导入一个关卡包：每个关卡副本落成新关卡（含本地化素材），
 * 节点 / 边 / 关卡包换新 id，节点指向新关卡。不覆盖本机任何存档。
 * @returns {Promise<{pack, levels:number, assets:number, nodes:number, missing:string[]}>}
 */
export async function importPackBundle(bundle) {
  const src = normalizePack(bundle.pack || {});
  const lvMap = new Map();          // 旧关卡 id → 新关卡 id
  let assets = 0;

  // 先建包拿到要用的 id：导入进来的关卡都要带上 packId，才不会漏进单关卡选关列表
  const pack = createPack({
    name: src.name || '导入的关卡包',
    author: src.author || '',
    description: src.description || '',
    unlockAll: !!src.unlockAll,
    allowEdit: !!src.allowEdit,
    imported: true,
    nodes: [], edges: [], stickers: [],
  });

  for (const e of bundle.levels || []) {
    if (!e || !e.data) continue;
    const lv = normalizeLevel(deepClone(e.data));
    const newId = uid('lv');
    lv.id = newId;
    if (e.name) lv.name = e.name;
    if (e.author !== undefined) lv.author = e.author;
    const un = await unpackLevelAssets(newId, e.assets, lv);
    assets += un.changed;
    await store.saveLevel({
      id: newId,
      name: lv.name || e.name || '导入的关卡',
      author: lv.author || e.author || '玩家',
      description: e.description || lv.description || '',
      difficulty: Number(e.difficulty) || Number(lv.difficulty) || 1,
      packId: pack.id,
      created: Date.now(),
      data: lv,
    });
    if (e.id) lvMap.set(e.id, newId);
  }

  // 节点换新 id 并接上新关卡；边随之重映射
  const nodeMap = new Map();
  const nodes = src.nodes.map((n) => {
    const node = createNode({
      levelId: lvMap.get(n.levelId) || '',
      title: n.title, desc: n.desc, x: n.x, y: n.y,
      color: n.color || '', diff: n.diff || 0, tier: n.tier || 0,
    });
    nodeMap.set(n.id, node.id);
    return node;
  });
  const edges = src.edges
    .map((e) => [nodeMap.get(e[0]), nodeMap.get(e[1])])
    .filter((e) => e[0] && e[1]);

  // 贴纸：src 自带 dataURL，原样带过，仅换新 id（避免与本次导入的其他包撞号）
  const stickers = (src.stickers || []).map((s) => ({ ...s, id: uid('st') }));

  pack.nodes = nodes;
  pack.edges = edges;
  pack.stickers = stickers;
  await upsertPack(pack);

  const missing = src.nodes.filter((n) => n.levelId && !lvMap.has(n.levelId)).map((n) => n.levelId);
  return { pack, levels: lvMap.size, assets, nodes: nodes.length, missing };
}