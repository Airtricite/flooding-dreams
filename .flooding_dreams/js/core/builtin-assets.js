/* ============================================================
   扩充内置素材
   ------------------------------------------------------------
   .flooding_dreams/assets/ 里的 CC0 贴图与 HDR 全景图，由 gen-asset-manifest.mjs
   汇总成 manifest.json，编辑器 / 游戏可以直接选用，不需要先导入。

   约定：
     · 素材 id = 'bi/' + 相对 assets 的路径（真实素材 id 是 'a…'，不会冲突）
     · 关卡里引用写成 'asset:bi/…'，与导入素材走同一套解析链路
       （见 core/settings.js resolveAssetURL、core/storage.js getAssetMeta）
     · 法线 / 粗糙度不单独列出，作为颜色图的「附属」，选中颜色图时自动套用
     · 缩略图 256×256：首次启动时批量缩好、存进存档后端（thumb scope），
       之后直接复用；任何一步失败都退回占位图标，不影响使用（防故障）
     · 编译版可能不含 assets 目录：清单读不到 → available=false，
       所有入口静默降级，关卡里遗留的 'asset:bi/…' 引用按「已丢失」处理
   ============================================================ */

/** 素材 id 前缀（扩充内置素材） */
export const BI_PREFIX = 'bi/';
/** 相对站点根的资产目录 */
const BASE = '.flooding_dreams/assets/';
/** 缩略图存放在存档后端的独立 scope（不占任何关卡，也不会出现在素材管理器里） */
export const THUMB_SCOPE = '__bithumb__';
/** 缩略图边长 */
export const THUMB_SIZE = 256;

const MANIFEST_URL = './' + BASE + 'manifest.json';

/** id 是否指向扩充内置素材 */
export function isExtendedId(id) { return typeof id === 'string' && id.startsWith(BI_PREFIX); }

/** 逐段编码相对路径（含中文 / 空格 / 括号） */
function encPath(p) {
  return String(p || '').split('/').map((s) => encodeURIComponent(s)).join('/');
}

/** 扩充内置素材的原始文件 URL（读不到清单也能算出来，仅用于容错） */
export function builtinURL(id) {
  if (!isExtendedId(id)) return null;
  const p = String(id).slice(BI_PREFIX.length);
  if (!p || p.indexOf('..') >= 0) return null;
  return './' + BASE + encPath(p);
}

/* ============================================================
   清单加载（只读，永不影响主流程）
   ============================================================ */
let _promise = null;
let _state = { available: false, items: [], byId: new Map(), error: '' };
/** 附属贴图（法线 / 粗糙度）id → { owner: 所属颜色图 id, role: 'normal'|'rough' } */
const _sibOwner = new Map();

/** 由扩展名猜 MIME（附属贴图不在清单里，得自己算） */
function mimeOf(path) {
  const p = String(path || '').toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.hdr')) return 'image/vnd.radiance';
  if (p.endsWith('.tga')) return 'image/x-tga';
  if (p.endsWith('.exr')) return 'image/x-exr';
  return 'image/jpeg';
}

/**
 * 读取扩充内置素材清单（缓存一次；失败 → available:false，不是异常）
 * @returns {Promise<{available:boolean, items:Array, byId:Map, error:string}>}
 */
export function loadBuiltinManifest() {
  if (_promise) return _promise;
  _promise = (async () => {
    try {
      const r = await fetch(MANIFEST_URL, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const raw = Array.isArray(j && j.items) ? j.items : [];
      const items = [];
      const byId = new Map();
      _sibOwner.clear();
      for (const it of raw) {
        if (!it || !it.path) continue;
        const rec = {
          id: BI_PREFIX + it.path,
          name: String(it.name || it.path),
          cat: String(it.cat || ''),
          kind: it.kind === 'sky' ? 'sky' : 'tex',
          mime: it.mime || '',
          size: Number(it.size) || 0,
          normal: it.normal ? BI_PREFIX + it.normal : null,
          rough: it.rough ? BI_PREFIX + it.rough : null,
        };
        rec.label = rec.cat ? rec.cat + ' · ' + rec.name : rec.name;
        items.push(rec);
        byId.set(rec.id, rec);
        if (rec.normal) _sibOwner.set(rec.normal, { owner: rec.id, role: 'normal' });
        if (rec.rough) _sibOwner.set(rec.rough, { owner: rec.id, role: 'rough' });
      }
      _state = { available: items.length > 0, items, byId, error: '' };
    } catch (e) {
      // 没有 assets 目录（精简编译版）/ 静态托管读不到 → 静默降级
      _state = { available: false, items: [], byId: new Map(), error: String((e && e.message) || e) };
    }
    return _state;
  })();
  return _promise;
}

/** 清单是否已就绪且可用（同步查询，用于「要不要显示这一组」） */
export function builtinAvailable() { return _state.available; }
/** 同步取一条扩充内置素材的元数据（清单未加载 / 不存在 → null） */
export function builtinMeta(id) { return _state.byId.get(id) || null; }

/** 颜色图对应的法线 / 粗糙度（扩充内置 id），没有则返回 null */
export function builtinFamily(id) {
  const m = _state.byId.get(id);
  if (!m || !m.normal && !m.rough) return null;
  return { normal: m.normal || null, rough: m.rough || null };
}

/** 去掉 'asset:' 前缀（素材引用有两种写法：'asset:<id>' 与裸 id） */
export function bareAssetId(v) {
  const s = String(v == null ? '' : v);
  return s.startsWith('asset:') ? s.slice(6) : s;
}

/** 是不是「扩充内置附属贴图」（法线 / 粗糙度）的引用 */
export function isExtendedSiblingRef(v) {
  const b = bareAssetId(v);
  if (!isExtendedId(b)) return false;
  const m = builtinAnyMeta(b);
  return !!(m && !m.color);
}

/**
 * 底贴图换成扩充内置颜色图时，配套的法线 / 粗糙度应该取什么。
 * 规则：
 *   · 字段为空 / 'none'            → 用配对贴图
 *   · 字段是扩充内置的附属贴图      → 换成当前底贴图的配对（换了底贴图要跟着换）
 *   · 字段是用户自己选的其它贴图    → 原样保留（不覆盖用户的选择）
 * @param {*} texture 底贴图引用
 * @param {*} roughCur 当前粗糙度图引用
 * @param {*} normCur 当前法线图引用
 * @returns {{rough:*, normal:*}} 处理后的引用（无扩充配对时原样返回）
 */
export function resolveBuiltinPair(texture, roughCur, normCur) {
  const bare = bareAssetId(texture);
  const fam = isExtendedId(bare) ? builtinFamily(bare) : null;
  if (!fam) return { rough: roughCur, normal: normCur };
  const fix = (cur, alt) => {
    if (!alt) return cur;
    if (!cur || cur === 'none' || isExtendedSiblingRef(cur)) return 'asset:' + alt;
    return cur;
  };
  return { rough: fix(roughCur, fam.rough), normal: fix(normCur, fam.normal) };
}

/**
 * 通用元数据查询：颜色图与它的附属贴图（法线 / 粗糙度）都能查到。
 * 附属贴图不在清单里，按所属颜色图反查（名字 / 分类沿用颜色图，MIME 按扩展名猜）。
 * @returns {{name:string, mime:string, size:number, cat:string, kind:string,
 *            color:boolean, role?:('normal'|'rough')}|null}
 */
export function builtinAnyMeta(id) {
  const m = _state.byId.get(id);
  if (m) {
    return { name: m.name, label: m.label, mime: m.mime, size: m.size, cat: m.cat, kind: m.kind, color: true };
  }
  const s = _sibOwner.get(id);
  if (!s) return null;
  const o = _state.byId.get(s.owner);
  return {
    name: (o && o.name) || String(id).split('/').pop() || id,
    label: (o && o.label) || '',
    mime: mimeOf(id), size: 0, cat: (o && o.cat) || '', kind: 'tex',
    color: false, role: s.role,
  };
}

/**
 * 选择器里的显示名：扩充内置素材（含没被列出来的附属贴图）返回可读标签，其它返回 null。
 * 用于「当前值不在选项列表里」时，别把它标成「已丢失」。
 */
export function extendedDisplayLabel(v) {
  const b = bareAssetId(v);
  if (!isExtendedId(b)) return null;
  const m = builtinAnyMeta(b);
  if (!m) return '扩充内置素材（原文件缺失）';
  if (m.color) return '扩充内置：' + (m.label || m.name);
  const role = m.role === 'rough' ? '粗糙度' : '法线';
  return '扩充内置 · ' + role + '：' + (m.label || m.name || '');
}

/**
 * 站点后端能直接读到的「素材记录」视图（与 store 记录同形），
 * 供选择器把扩充素材与导入素材混在一起列出。
 * @param {string} [kind] 'tex' | 'sky'（空 = 全部）
 */
export function listBuiltinRecords(kind) {
  if (!_state.available) return [];
  const out = [];
  for (const m of _state.items) {
    if (kind && m.kind !== kind) continue;
    out.push({
      id: m.id, name: m.label, kind: 'texture', size: m.size, mime: m.mime,
      created: 0, level: '', ext: true, cat: m.cat, label: m.label,
    });
  }
  return out;
}

/* ============================================================
   256×256 缩略图（首次启动生成一次，之后复用）
   ============================================================ */
const READY = new Set();          // 已有缩略图的扩充素材 id
let _thumbPromise = null;
let _progress = { done: 0, total: 0 };

export function builtinThumbURL(id) {
  if (!READY.has(id)) return null;
  return './api/store/asset?id=' + encodeURIComponent(id) + '&level=' + encodeURIComponent(THUMB_SCOPE);
}
export function builtinThumbReady(id) { return READY.has(id); }
export function builtinThumbProgress() { return { ..._progress }; }

/** 等比裁切绘制到 256×256（居中，覆盖式） */
function drawThumb(bmp, size) {
  const C = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(size, size)
    : (() => { const c = document.createElement('canvas'); c.width = size; c.height = size; return c; })();
  const x = C.getContext('2d');
  x.imageSmoothingQuality = 'high';
  const iw = bmp.width || size, ih = bmp.height || size;
  const s = Math.max(size / iw, size / ih);
  const dw = iw * s, dh = ih * s;
  x.drawImage(bmp, (size - dw) / 2, (size - dh) / 2, dw, dh);
  return C;
}
function toBlob(C, size, mime, quality) {
  if (C.convertToBlob) return C.convertToBlob({ type: mime, quality });
  return new Promise((res) => C.toBlob((b) => res(b), mime, quality));
}

async function makeThumbBlob(url, name) {
  // .hdr 是 RGBE 半浮点数据，ImageBitmap 解不了 → 交给上层退占位图标
  if (/\.hdr$/i.test(String(name || ''))) return null;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return null;
  const src = await r.blob();
  const bmp = await createImageBitmap(src);
  try {
    const C = drawThumb(bmp, THUMB_SIZE);
    return await toBlob(C, THUMB_SIZE, 'image/jpeg', 0.82);
  } finally {
    if (bmp && bmp.close) { try { bmp.close(); } catch (e) { /* ignore */ } }
  }
}

/**
 * 首次启动时把缺的缩略图缩好并存进后端；幂等、可并发调用。
 * 失败（含无 assets 目录）一律静默跳过，调用方可继续用占位图标。
 * @param {(p:{done:number,total:number})=>void} [onProgress]
 * @returns {Promise<{generated:number, ready:number}>}
 */
export function initBuiltinThumbs(onProgress) {
  if (_thumbPromise) {
    if (onProgress) {
      const t = setInterval(() => {
        onProgress(builtinThumbProgress());
        if (_progress.total && _progress.done >= _progress.total) clearInterval(t);
      }, 400);
      setTimeout(() => clearInterval(t), 60000);
    }
    return _thumbPromise;
  }
  _thumbPromise = (async () => {
    let generated = 0;
    try {
      const st = await loadBuiltinManifest();
      if (!st.available) return { generated: 0, ready: 0 };
      const { store } = await import('./storage.js');
      // 已有的缩略图（同一份存档后端里恢复，重启后不用再缩）
      try {
        const have = await store.listAssets(THUMB_SCOPE);
        for (const r of (have || [])) if (r && r.id) READY.add(r.id);
      } catch (e) { /* 读不到就当全都没有，下面重建 */ }
      const todo = st.items.filter((m) => !READY.has(m.id));
      _progress = { done: 0, total: todo.length };
      if (onProgress) onProgress(builtinThumbProgress());
      let i = 0;
      const worker = async () => {
        while (i < todo.length) {
          const m = todo[i++];
          try {
            const blob = await makeThumbBlob(builtinURL(m.id), m.name);
            if (!blob) continue;
            const file = new File([blob], (m.name || 'thumb') + '.thumb.jpg', { type: 'image/jpeg' });
            await store.saveAsset(file, 'texture', { id: m.id, levelId: THUMB_SCOPE, name: m.name, created: 0 });
            READY.add(m.id);
            generated++;
          } catch (e) { /* 单张失败不影响其它 */ }
          _progress.done++;
          if (onProgress && (_progress.done % 8 === 0 || _progress.done >= _progress.total)) onProgress(builtinThumbProgress());
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } catch (e) {
      console.warn('[builtin] 缩略图初始化失败，改用占位图标', e);
    }
    return { generated, ready: READY.size };
  })();
  return _thumbPromise;
}
