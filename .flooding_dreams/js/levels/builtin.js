/* ============================================================
   内置关卡注册表（本版本为「无内置关卡」精简版）
   ------------------------------------------------------------
   为保持引擎 / 编辑器可正常运行，这里把内置关卡工厂留空：
   游戏照常启动，只是「关卡选择」里没有任何官方关卡。

   想加入自己的关卡（自定义关卡机制保持不变）：
   1) 在编辑器里做好关卡，点「⇩ 导出」得到 .fdlevel 文件（本质是 JSON）
   2) 把文件放进 js/levels/custom/ 目录
   3) 在 js/levels/custom/index.json 的数组里写上文件名，例如
      ["我的关卡.fdlevel", "第二关.json"]
   重新载入游戏后，它就会出现在「关卡选择」里（标记为“自定义”）
   ============================================================ */
import { normalizeLevel, cloneLevel } from '../world/level.js';
import { store } from '../core/storage.js';
import { copyLevelAssets } from '../core/level-assets.js';
import { sanitizeName } from '../core/util.js';

/* ---------- 内置关卡工厂（本版本为空，不含任何内置关卡） ---------- */
const FACTORIES = [];
let _cache = null;

export function getBuiltinLevels() {
  if (_cache) return _cache;
  _cache = FACTORIES.map((f) => {
    try { return f(); } catch (e) { console.error('[builtin] 关卡构造失败', e); return null; }
  }).filter(Boolean);
  return _cache;
}
export function getBuiltinLevel(id) {
  return getBuiltinLevels().find((l) => l.id === id) || null;
}
/**
 * 重新跑一次工厂，拿一份全新的内置关卡（不走会被就地改写的那份单例缓存）。
 * 编辑器打开关卡前用它取源数据：编辑 / 素材本地化都会就地改写传入的关卡对象，
 * 若直接复用 getBuiltinLevels() 里那份，改脏后连正常游玩、重开都会跟着变。
 */
export function freshBuiltinLevel(id) {
  for (const f of FACTORIES) {
    try {
      const lv = f();
      if (lv && lv.id === id) return lv;
    } catch (e) { console.error('[builtin] 关卡构造失败', e); }
  }
  return null;
}
export function isBuiltinLevel(id) { return !!getBuiltinLevel(id); }
export function builtinThumb(level) {
  return level ? level.difficulty : 1;
}

/* ============================================================
   复制为「我的关卡」（可编辑副本）
   ------------------------------------------------------------
   内置 / 自定义关卡来自代码或静态文件，本身不可写；想改它们，
   必须先复制成一份「我的关卡」存档。复制时要：
     · 换新 id（内置关卡的 id 不能被存档占用，否则会盖住内置版本）；
     · 内置关卡从工厂重跑一份干净数据 —— getBuiltinLevels() 里那份是
       全局单例，玩过一局 / 开过一次编辑器就可能被就地改写；
     · 素材跟着走（copyLevelAssets 把引用的素材拷进新关卡文件夹并改写引用）。
   ============================================================ */
/**
 * @param src  源关卡对象（内置 / 自定义 / 我的关卡都行）
 * @param name 新关卡名（留空用「原名 副本」）
 * @returns {Promise<{level: object, moved: number}|null>} 复制出来并已存盘的关卡
 */
export async function cloneLevelToSaves(src, name) {
  if (!src) return null;
  const srcId = src.id || '';
  // 内置关卡：工厂重跑拿干净数据；自定义 / 我的关卡返回 null → 用传入的这份
  const base = (srcId && freshBuiltinLevel(srcId)) || src;
  const lv = cloneLevel(base, sanitizeName(String(name || '').trim() || (base.name + ' 副本'), '关卡 副本'));
  lv.author = '玩家';

  const prevScope = store.assetScope;
  store.setAssetScope(lv.id);
  let moved = 0;
  try {
    const r = await copyLevelAssets(srcId, lv.id, lv);
    moved = (r && r.changed) || 0;
    await store.saveLevel({
      id: lv.id, name: lv.name, author: lv.author,
      description: lv.description, difficulty: lv.difficulty, data: lv,
    });
  } finally { store.setAssetScope(prevScope); }
  return { level: lv, moved };
}

/* ---------- 自定义关卡（放文件即生效，无需改代码） ---------- */
const CUSTOM_DIR = new URL('./custom/', import.meta.url);
let _custom = null;

/** 读取 js/levels/custom/index.json 里列出的关卡文件，并并入关卡列表 */
export async function loadCustomLevels() {
  if (_custom) return _custom;
  _custom = [];
  try {
    const res = await fetch(new URL('index.json', CUSTOM_DIR));
    if (!res.ok) return _custom;
    const raw = await res.json();
    const files = Array.isArray(raw) ? raw : (raw.files || []);
    for (const f of files) {
      try {
        const r = await fetch(new URL(f, CUSTOM_DIR));
        if (!r.ok) { console.warn('[builtin] 自定义关卡不存在：' + f); continue; }
        const lv = normalizeLevel(await r.json());
        lv.custom = true;
        _custom.push(lv);
      } catch (e) { console.warn('[builtin] 自定义关卡读取失败：' + f, e); }
    }
  } catch (e) { /* 没有自定义目录时静默跳过 */ }
  if (_custom.length) {
    const list = getBuiltinLevels();
    for (const lv of _custom) if (!list.some((x) => x.id === lv.id)) list.push(lv);
  }
  return _custom;
}