/* ============================================================
   关卡素材本地化
   一个关卡的存档单元是一个文件夹，素材随关卡走：
     · 导入素材时直接写进「当前关卡」的文件夹（store.saveAsset 负责）
     · 旧存档 / 复制 / 导入关卡时，把引用到的素材拷进目标关卡文件夹
   为了「读素材只看 id」也能定位，每份本地化副本都会换一个全局唯一的新
   id，并同步改写关卡数据里的引用（asset:<id> 字符串 + 裸 id 字段）。
   ------------------------------------------------------------
   扩充内置素材（id 前缀 'bi/'，见 core/builtin-assets.js）不参与本地化 / 复制：
   它本来就在游戏里，引用保持 'asset:bi/…' 即可。但导出打包必须带上它的字节，
   否则别人用「不含扩充内置素材的编译版」打开关卡就会缺贴图。
   ============================================================ */
import { store } from './storage.js';
import {
  isExtendedId, builtinFamily, builtinAnyMeta, loadBuiltinManifest,
} from './builtin-assets.js';

/** 存「裸素材 id」（不带 asset: 前缀）的字段 */
const BARE_KEYS = new Set(['assetId', 'morphAsset', 'textureAsset']);

/** 收集关卡里引用到的素材 id */
export function collectAssetRefs(level) {
  const ids = new Set();
  const walk = (v) => {
    if (!v) return;
    if (typeof v === 'string') { if (v.startsWith('asset:')) ids.add(v.slice(6)); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      for (const k in v) {
        const val = v[k];
        if (BARE_KEYS.has(k) && typeof val === 'string' && val) ids.add(val);
        else walk(val);
      }
    }
  };
  walk(level);
  // 扩充内置颜色图会把同名的法线 / 粗糙度一并带上：运行时是自动套用的（没有显式字段），
  // 导出打包必须显式带上这两张贴图
  for (const id of [...ids]) {
    if (!isExtendedId(id)) continue;
    const fam = builtinFamily(id);
    if (!fam) continue;
    if (fam.normal) ids.add(fam.normal);
    if (fam.rough) ids.add(fam.rough);
  }
  return ids;
}

/** 按 idMap（旧 id → 新 id）就地改写关卡里的素材引用，返回改写处数 */
export function rewriteAssetRefs(level, idMap) {
  let n = 0;
  const walk = (v) => {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v !== 'object') return;
    for (const k in v) {
      const val = v[k];
      if (typeof val === 'string') {
        if (val.startsWith('asset:')) {
          const id = val.slice(6);
          if (idMap.has(id)) { v[k] = 'asset:' + idMap.get(id); n++; }
        } else if (BARE_KEYS.has(k) && idMap.has(val)) {
          v[k] = idMap.get(val);
          n++;
        }
      } else {
        walk(val);
      }
    }
  };
  walk(level);
  return n;
}

/** 素材字节：dataURL / Blob 都能取到 Blob（角色包导出也用这套） */
export async function assetBlob(rec) {
  const d = rec && rec.data;
  if (d instanceof Blob) return d;
  if (typeof d === 'string' && d.startsWith('data:')) return (await fetch(d)).blob();
  return new Blob([d || ''], { type: (rec && rec.mime) || '' });
}

export function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

/* ============================================================
   角色皮肤里的素材引用
   皮肤（含挂件）挂在模型素材记录上，关卡 JSON 里看不到它引用的
   挂件模型 —— 移动 / 打包关卡时得把这些素材一并带上，否则角色到了
   新环境就缺挂件。
   ============================================================ */

/** 收集这些素材的皮肤里引用到的挂件模型 id */
async function _skinRefIds(ids) {
  const out = new Set();
  for (const id of ids) {
    try {
      const rec = await store.getAssetMeta(id);
      for (const acc of ((rec && rec.skin && rec.skin.accessories) || [])) {
        if (acc && acc.shape === 'model' && acc.assetId) out.add(acc.assetId);
      }
    } catch (e) { /* ignore */ }
  }
  return out;
}

/** 皮肤里的挂件模型引用换成新 id（和 rewriteAssetRefs 同步做） */
async function _remapSkinRefs(map, ids) {
  if (!map.size) return;
  for (const id of ids) {
    try {
      const rec = await store.getAssetMeta(id);
      const skin = rec && rec.skin;
      if (!skin || !Array.isArray(skin.accessories)) continue;
      let hit = false;
      for (const acc of skin.accessories) {
        if (acc && acc.shape === 'model' && acc.assetId && map.has(acc.assetId)) {
          acc.assetId = map.get(acc.assetId);
          hit = true;
        }
      }
      if (hit) await store.setAssetSkin(id, skin);
    } catch (e) { /* ignore */ }
  }
}

/** 把一条素材记录复制进 dstLevelId 的文件夹（换新 id），返回新记录 */
async function _copyInto(dstLevelId, rec, srcLevelId) {
  const full = rec.data ? rec : await store.getAsset(rec.id, srcLevelId || null);
  if (!full || !full.data) return null;
  const blob = await assetBlob(full);
  const name = full.name || full.id || 'asset';
  const file = new File([blob], name, { type: full.mime || blob.type || '' });
  const copy = await store.saveAsset(file, full.kind || 'texture', { levelId: dstLevelId, name, created: full.created });
  // 角色皮肤挂在模型素材上，跟着素材一起搬（否则关卡里的角色换个环境就没了皮肤）。
  // 皮肤可能很大（涂画数据），单独写元数据而不是塞进 saveAsset 的 extra。
  if (copy && full.skin) await store.setAssetSkin(copy.id, full.skin);
  return copy;
}

/**
 * 懒迁移：把关卡引用到、但还没在本关文件夹里的素材拷进来（换新 id 并改写引用）。
 * 已在关卡素材池里的引用保持原样。幂等、廉价。
 * @returns {Promise<{changed:number, map:Map}>}
 */
export async function localizeLevelAssets(levelId, level) {
  const map = new Map();
  if (!levelId || !level) return { changed: 0, map };
  await loadBuiltinManifest();
  const ids = collectAssetRefs(level);
  for (const id of await _skinRefIds(ids)) ids.add(id);    // 角色挂件用到的模型素材
  if (!ids.size) return { changed: 0, map };
  let pool = new Set();
  try { pool = new Set((await store.listAssets(levelId)).map((a) => a.id)); } catch (e) { /* ignore */ }
  for (const id of ids) {
    if (pool.has(id)) continue;
    if (isExtendedId(id)) continue;                        // 扩充内置素材本来就在游戏里，不本地化
    try {
      const copy = await _copyInto(levelId, { id }, null);   // null：服务器全局搜索（其它关卡 / 旧全局池）
      if (copy) map.set(id, copy.id);
    } catch (e) { console.warn('[level-assets] 本地化失败', id, e); }
  }
  if (map.size) {
    rewriteAssetRefs(level, map);
    // 皮肤里的挂件引用要跟着换新 id：新拷进来的，加上本来就在本关池子里的角色素材
    const local = [...ids].filter((id) => pool.has(id));
    await _remapSkinRefs(map, [...local, ...map.values()]);
  }
  return { changed: map.size, map };
}

/**
 * 复制关卡时把素材一并复制到新关卡的文件夹（换新 id 并改写引用）。
 * @returns {Promise<{changed:number, map:Map}>}
 */
export async function copyLevelAssets(srcLevelId, dstLevelId, level) {
  const map = new Map();
  if (!dstLevelId || !level) return { changed: 0, map };
  await loadBuiltinManifest();
  const ids = collectAssetRefs(level);
  for (const id of await _skinRefIds(ids)) ids.add(id);    // 角色挂件用到的模型素材
  for (const id of ids) {
    if (isExtendedId(id)) continue;                        // 扩充内置素材跟着游戏走，不复制
    try {
      const copy = await _copyInto(dstLevelId, { id }, srcLevelId || null);
      if (copy) map.set(id, copy.id);
    } catch (e) { console.warn('[level-assets] 复制素材失败', id, e); }
  }
  if (map.size) {
    rewriteAssetRefs(level, map);
    await _remapSkinRefs(map, [...map.values()]);   // 皮肤里的挂件模型引用跟着换新 id
  }
  return { changed: map.size, map };
}

/** 导出用：把关卡引用到的素材打成 base64 列表
 *  扩充内置素材也会被打进来（这样别人用「不含扩充内置素材的编译版」也能正常打开），
 *  并在颜色图条目上记下 fam（同名的法线 / 粗糙度 id），供导入方写回材质字段。 */
export async function packLevelAssets(level) {
  await loadBuiltinManifest();
  const ids = collectAssetRefs(level);
  for (const id of await _skinRefIds(ids)) ids.add(id);    // 角色挂件用到的模型素材
  const out = [];
  for (const id of ids) {
    try {
      const rec = await store.getAsset(id);
      if (!rec || !rec.data) continue;
      const blob = await assetBlob(rec);
      const entry = {
        id, name: rec.name || '', mime: rec.mime || blob.type || '',
        kind: rec.kind || 'texture', size: blob.size, data: await blobToDataURL(blob),
        // 角色皮肤随素材打包；导入方拿到的是新 id，皮肤也就跟着新 id 落地
        skin: rec.skin || null,
      };
      if (isExtendedId(id)) {
        entry.ext = true;
        const fam = builtinFamily(id);
        entry.fam = fam || null;    // 只有颜色图有 fam；法线 / 粗糙度自身为 null
      }
      out.push(entry);
    } catch (e) { console.warn('[level-assets] 打包素材失败', id, e); }
  }
  return out;
}

/**
 * 导入用：把关卡文件里带的素材写进新关卡文件夹（换新 id 并改写引用）。
 *   · 本机也有这条扩充内置素材 → 不落盘，引用保持 'asset:bi/…'（省事、省空间）
 *   · 本机没有（不含扩充内置素材的编译版）→ 像普通素材一样物化，
 *     并把颜色图的法线 / 粗糙度写回关卡对象的字段（否则材质只有颜色图）
 * @returns {Promise<{changed:number, map:Map}>}
 */
export async function unpackLevelAssets(dstLevelId, bundle, level) {
  const map = new Map();
  if (!dstLevelId || !Array.isArray(bundle) || !bundle.length) return { changed: 0, map };
  await loadBuiltinManifest();
  for (const a of bundle) {
    if (!a || !a.data) continue;
    // 本机已有这条扩充内置素材 → 沿用原 id，不必物化
    if (isExtendedId(a.id) && builtinAnyMeta(a.id)) continue;
    try {
      const blob = await (await fetch(a.data)).blob();
      const name = a.name || a.id || 'asset';
      const file = new File([blob], name, { type: a.mime || blob.type || '' });
      const copy = await store.saveAsset(file, a.kind || 'texture', { levelId: dstLevelId, name });
      // 角色皮肤跟素材一起落进新关卡文件夹（单独写元数据，不塞进 extra）
      if (copy && a.skin) await store.setAssetSkin(copy.id, a.skin);
      if (copy && a.id) map.set(a.id, copy.id);
    } catch (e) { console.warn('[level-assets] 还原素材失败', a && a.id, e); }
  }
  // 物化过的扩充内置颜色图：把法线 / 粗糙度写回对象字段（随后 rewrite 一并换成新 id）
  applyPackedFamilies(level, bundle, map);
  if (map.size) {
    rewriteAssetRefs(level, map);
    await _remapSkinRefs(map, [...map.values()]);    // 皮肤里的挂件模型引用跟着换新 id
  }
  return { changed: map.size, map };
}

/**
 * 把「打包进来的扩充内置材质族」写回关卡对象：本机没有该扩充素材时，
 * 颜色图会被物化成普通素材，此时必须显式给出法线 / 粗糙度字段，否则只剩颜色图。
 * 只写原来为空 / 'none' 的字段，不动用户自己的设置。
 */
function applyPackedFamilies(level, bundle, map) {
  const plan = new Map();      // 原颜色图 id → { rough, normal }（新 id 或仍可用的原 id）
  for (const a of bundle) {
    if (!a || !a.fam || !a.id) continue;
    const pick = (old) => {
      if (!old) return null;
      if (map.has(old)) return map.get(old);              // 被物化 → 用新 id
      return builtinAnyMeta(old) ? old : null;            // 本机已有 → 保留原 id；都没有 → 丢弃
    };
    // 颜色图本身仍可用（本机有）且附属也可用 → 运行时能自动派生，无需写回
    const keepColor = !map.has(a.id) && builtinAnyMeta(a.id);
    const rough = pick(a.fam.rough);
    const normal = pick(a.fam.normal);
    if (keepColor && (!a.fam.rough || rough === a.fam.rough) && (!a.fam.normal || normal === a.fam.normal)) continue;
    plan.set(a.id, { rough, normal });
  }
  if (!plan.size) return;
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const tex = typeof v.texture === 'string' ? v.texture : (typeof v.textureAsset === 'string' ? v.textureAsset : '');
    const bare = tex.startsWith('asset:') ? tex.slice(6) : tex;
    const p = bare ? plan.get(bare) : null;
    if (p) {
      if (p.rough && (!v.roughnessMap || v.roughnessMap === 'none')) v.roughnessMap = 'asset:' + p.rough;
      if (p.normal && (!v.normalMap || v.normalMap === 'none')) v.normalMap = 'asset:' + p.normal;
    }
    for (const k in v) walk(v[k]);
  };
  walk(level);
}