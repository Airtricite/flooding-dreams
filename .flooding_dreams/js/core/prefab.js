/* ============================================================
   预制件（Prefab）
   ------------------------------------------------------------
   把关卡里选中的一组对象（连同它们的涂鸦 / 贴纸 / 引用到的素材）
   打成一个自包含的预制件：既可以存进工具箱（本地），也可以导出成
   .fdprefab 文件带走。应用回关卡时换新 id、素材本地化到本关文件夹，
   不依赖来源环境。

   存储（复用已有的 kv store，不新增 store）：
     kv: fd.prefabs          → 索引数组（卡片用，不含对象 / 素材字节）
     kv: fd.prefab.<id>      → 完整记录（objects / paints / stickers / assets）

   文件（.fdprefab）：{ kind, v, game, date, prefab: 完整记录 }
   ============================================================ */
import * as THREE from 'three';
import { store } from './storage.js';
import { uid, deepClone, download, sanitizeName } from './util.js';
import { collectTree, objectLabel } from '../world/level.js';
import { packLevelAssets, unpackLevelAssets } from './level-assets.js';

export const PREFAB_KIND = 'flooding-dreams-prefab';
export const PREFAB_VER = 1;
export const PREFAB_EXT = '.fdprefab';

const INDEX_KEY = 'fd.prefabs';
const REC_KEY = (id) => 'fd.prefab.' + id;
/** 外部导入的预制件在「按来源关卡」分包里归到这一组 */
export const EXTERNAL_GROUP = '__external__';

/* ============================================================
   采集
   ============================================================ */
/** 选中 id → 该对象及其全部后代（去重，保持选择顺序） */
function _collect(level, ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids || []) {
    for (const o of collectTree(level, id)) {
      if (!o || seen.has(o.id)) continue;
      seen.add(o.id);
      out.push(o);
    }
  }
  return out;
}

/** 由首个根对象起个默认名 */
function _defaultName(objects) {
  const roots = objects.filter((o) => !o.parent);
  const first = roots[0] || objects[0];
  const base = first ? objectLabel(first) : '预制件';
  return objects.length > 1 ? base + ' 等 ' + objects.length + ' 件' : base;
}

/**
 * 把编辑器里选中的对象采集成一个预制件记录（不落盘）。
 * @param {object} ed
 * @param {string[]} ids
 * @param {{name?:string, preview?:string}} [opts] preview 为导出时预渲染的 3D 预览图（dataURL）
 * @returns {Promise<object>} 预制件完整记录
 */
export async function capturePrefab(ed, ids, opts = {}) {
  const level = ed && ed.level;
  if (!level) throw new Error('没有打开关卡');
  const picked = _collect(level, ids);
  if (!picked.length) throw new Error('没有可导出的对象');

  const idSet = new Set(picked.map((o) => o.id));
  const objects = picked.map((o) => deepClone(o));
  // 父级不在选择里的对象 → 变成根，否则应用回关卡时会指向不存在的父级
  for (const o of objects) if (o.parent && !idSet.has(o.parent)) o.parent = null;
  const paints = (level.paints || []).filter((p) => idSet.has(p.objectId)).map((p) => deepClone(p));
  const stickers = (level.stickers || []).filter((s) => idSet.has(s.objectId)).map((s) => deepClone(s));

  // 素材连字节一起打包（角色皮肤也随素材走）
  const assets = await packLevelAssets({ objects, paints, stickers });
  const now = Date.now();
  return {
    id: uid('pf'),
    name: String(opts.name || '').trim() || _defaultName(objects),
    author: (level.author || '玩家'),
    created: now,
    updated: now,
    source: { levelId: level.id || '', levelName: level.name || '' },
    imported: false,
    preview: typeof opts.preview === 'string' ? opts.preview : '',
    objects, paints, stickers, assets,
    stats: { objects: objects.length, assets: assets.length },
  };
}

/* ============================================================
   索引 / 读写
   ============================================================ */
/** 索引条目（卡片用的轻量投影，剥掉对象 / 素材字节） */
function _indexEntry(rec) {
  return {
    id: rec.id,
    name: rec.name || '预制件',
    author: rec.author || '',
    created: rec.created || 0,
    updated: rec.updated || 0,
    levelId: (rec.source && rec.source.levelId) || '',
    levelName: (rec.source && rec.source.levelName) || '',
    imported: !!rec.imported,
    preview: rec.preview || '',
    objects: (rec.stats && rec.stats.objects) || (rec.objects || []).length,
    assets: (rec.stats && rec.stats.assets) || (rec.assets || []).length,
    types: [...new Set((rec.objects || []).map((o) => o.type).filter(Boolean))].slice(0, 12),
  };
}

/** 读索引（全部预制件的轻量投影） */
export async function listPrefabIndex() {
  let arr = null;
  try { arr = await store.kvGet(INDEX_KEY, []); } catch (e) { arr = null; }
  return Array.isArray(arr) ? arr : [];
}

/** 写索引：按 id 覆盖或新增，返回新索引数组 */
async function _indexSave(entry) {
  const idx = await listPrefabIndex();
  const i = idx.findIndex((x) => x && x.id === entry.id);
  if (i >= 0) idx[i] = { ...idx[i], ...entry };
  else idx.push(entry);
  await store.kvSet(INDEX_KEY, idx);
  return idx;
}

/** 存一个预制件（完整记录 + 索引） */
export async function savePrefab(rec) {
  if (!rec || !rec.id) throw new Error('预制件记录不合法');
  rec.updated = Date.now();
  rec.stats = { objects: (rec.objects || []).length, assets: (rec.assets || []).length };
  await store.kvSet(REC_KEY(rec.id), rec);
  await _indexSave(_indexEntry(rec));
  return rec;
}

/** 读一个预制件的完整记录 */
export async function getPrefab(id) {
  if (!id) return null;
  try { return (await store.kvGet(REC_KEY(id), null)) || null; } catch (e) { return null; }
}

/** 重命名预制件 */
export async function renamePrefab(id, name) {
  const n = String(name || '').trim();
  if (!id || !n) return null;
  const rec = await getPrefab(id);
  if (rec) { rec.name = n; await store.kvSet(REC_KEY(id), rec); }
  await _indexSave({ id, name: n });
  return n;
}

/** 删除预制件（索引 + 记录） */
export async function deletePrefab(id) {
  if (!id) return;
  const idx = await listPrefabIndex();
  await store.kvSet(INDEX_KEY, idx.filter((x) => x && x.id !== id));
  try { await store.del('kv', REC_KEY(id)); } catch (e) { /* ignore */ }
}

/* ============================================================
   文件（.fdprefab）
   ============================================================ */
/** 记录 → 文件对象 */
export function prefabToBundle(rec) {
  return {
    kind: PREFAB_KIND,
    v: PREFAB_VER,
    game: 'Flooding Dreams',
    date: Date.now(),
    prefab: rec,
  };
}

/** 导出成文件（本地下载） */
export function exportPrefabFile(rec) {
  if (!rec) return null;
  const name = sanitizeName(rec.name || 'prefab', 'prefab') + PREFAB_EXT;
  download(name, JSON.stringify(prefabToBundle(rec)));
  return name;
}

/** 读取并校验一个预制件文件（不写任何数据） */
export function readPrefabFile(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { record: null, error: '文件不是合法的 JSON' }; }
  if (!raw || raw.kind !== PREFAB_KIND) return { record: null, error: '这不是 Flooding Dreams 预制件文件' };
  if (Number(raw.v) > PREFAB_VER) return { record: null, error: `预制件文件版本过新（v${raw.v}），请更新游戏` };
  const p = raw.prefab;
  if (!p || !Array.isArray(p.objects) || !p.objects.length) return { record: null, error: '预制件文件里没有对象' };
  return { record: p, error: null };
}

/**
 * 把一个外部读进来的预制件记录规整成可入库的新记录（换新 id）。
 * 素材保持 dataURL，应用时才会本地化。
 */
export function normalizeImportedPrefab(rec, opts = {}) {
  const objects = (Array.isArray(rec.objects) ? rec.objects : []).map((o) => deepClone(o));
  if (!objects.length) throw new Error('预制件里没有对象');
  const src = rec.source || {};
  const now = Date.now();
  return {
    id: uid('pf'),
    name: String(opts.name || rec.name || '').trim() || _defaultName(objects),
    author: rec.author || '玩家',
    created: rec.created || now,
    updated: now,
    source: { levelId: src.levelId || '', levelName: src.levelName || '' },
    imported: true,
    preview: typeof rec.preview === 'string' ? rec.preview : '',
    objects,
    paints: (Array.isArray(rec.paints) ? rec.paints : []).map((p) => deepClone(p)),
    stickers: (Array.isArray(rec.stickers) ? rec.stickers : []).map((s) => deepClone(s)),
    assets: Array.isArray(rec.assets) ? deepClone(rec.assets) : [],
    stats: { objects: objects.length, assets: (rec.assets || []).length },
  };
}

/** 读文件 + 入库（导入到工具箱） */
export async function importPrefabFile(text, opts = {}) {
  const { record, error } = readPrefabFile(text);
  if (error || !record) return { record: null, error: error || '预制件文件无效' };
  const nr = normalizeImportedPrefab(record, opts);
  await savePrefab(nr);
  return { record: nr, error: null };
}

/* ============================================================
   应用到当前关卡
   ============================================================ */
/** 预制件根对象的位置中心（近似） */
function _centerOf(objects) {
  const roots = objects.filter((o) => !o.parent);
  const pts = (roots.length ? roots : objects).filter((o) => Array.isArray(o.position));
  if (!pts.length) return [0, 0, 0];
  const c = [0, 1, 2].map((k) => pts.reduce((a, o) => a + (Number(o.position[k]) || 0), 0) / pts.length);
  return c;
}

/** 落点偏移：把预制件摆到相机前方（无相机时用固定偏移） */
function _placementOffset(ed, objects) {
  const c = _centerOf(objects);
  const cam = ed && ed.viewport && ed.viewport.camera;
  if (!cam) return [8, 0, 8];
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).multiplyScalar(24);
  const t = cam.position.clone().add(dir);
  return [t.x - c[0], t.y - c[1], t.z - c[2]];
}

/**
 * 把预制件里的对象（含涂鸦 / 贴纸 / 素材）插进当前关卡。
 * 换新对象 id、素材本地化进本关文件夹并改写引用，可撤销。
 * @param {object} ed
 * @param {object} rec 预制件完整记录
 * @param {{offset?:number[]}} [opts] offset 缺省时摆到相机前方
 * @returns {Promise<{ids:string[], assets:number}>}
 */
export async function applyPrefabToLevel(ed, rec, opts = {}) {
  const level = ed && ed.level;
  if (!level) throw new Error('没有打开关卡');
  if (!rec || !Array.isArray(rec.objects) || !rec.objects.length) throw new Error('预制件是空的');

  const prev = ed.snap();
  const graph = {
    objects: rec.objects.map((o) => deepClone(o)),
    paints: (Array.isArray(rec.paints) ? rec.paints : []).map((p) => deepClone(p)),
    stickers: (Array.isArray(rec.stickers) ? rec.stickers : []).map((s) => deepClone(s)),
  };

  /* 1. 素材落地到本关文件夹（换新 id 并改写 graph 里的引用） */
  let assets = 0;
  if (Array.isArray(rec.assets) && rec.assets.length) {
    const un = await unpackLevelAssets(level.id, rec.assets, graph);
    assets = un.changed;
  }

  /* 2. 换新对象 id + 重映射父子关系 */
  const map = new Map();
  for (const o of graph.objects) {
    const n = uid((o.type || 'o').slice(0, 2));
    map.set(o.id, n);
    o.id = n;
  }
  for (const o of graph.objects) o.parent = o.parent ? (map.get(o.parent) || null) : null;

  /* 3. 涂鸦 / 贴纸跟随新 id（贴纸另换自己的 id） */
  graph.paints = graph.paints.filter((p) => map.has(p.objectId));
  for (const p of graph.paints) p.objectId = map.get(p.objectId);
  graph.stickers = graph.stickers.filter((s) => map.has(s.objectId));
  for (const s of graph.stickers) { s.objectId = map.get(s.objectId); s.id = uid('sk'); }

  /* 4. 落点偏移：只偏移根对象，保持内部相对布局 */
  const off = Array.isArray(opts.offset) ? opts.offset : _placementOffset(ed, graph.objects);
  for (const o of graph.objects) {
    if (o.parent) continue;
    if (!Array.isArray(o.position)) continue;
    o.position = [
      (Number(o.position[0]) || 0) + off[0],
      (Number(o.position[1]) || 0) + off[1],
      (Number(o.position[2]) || 0) + off[2],
    ];
  }

  /* 5. 并入关卡并重建 */
  for (const o of graph.objects) level.objects.push(o);
  level.paints = level.paints || [];
  level.stickers = level.stickers || [];
  for (const p of graph.paints) level.paints.push(p);
  for (const s of graph.stickers) level.stickers.push(s);

  try { ed.builder && ed.builder.refreshAll(); } catch (e) { /* ignore */ }
  try { ed.builder && ed.builder.computeBounds(); } catch (e) { /* ignore */ }
  try { ed.paint && ed.paint.rebuildAll(); } catch (e) { /* ignore */ }
  if (ed.inspector && ed.inspector.invalidateAssets) ed.inspector.invalidateAssets();
  if (ed.assetMgr) ed.assetMgr.refresh();

  ed.record('应用预制件', prev, { tree: true });
  const ids = [...map.values()];
  ed.select(ids);
  ed.dirty = true;
  return { ids, assets };
}