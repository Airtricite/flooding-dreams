/* ============================================================
   素材管理器
   外部导入的素材（图片 / 音频 / 模型）统一存在 store 的 assets 里。
   这里提供：统一导入入口 + 查看 / 重命名 / 删除，
   删除时把关卡里对它的引用一并断开（避免留下失效引用）。
   ============================================================ */
import { el, clear, toast, confirmBox, promptBox } from '../ui/dom.js';
import { store } from '../core/storage.js';
import { runListTask } from '../core/list-tasks.js';
import { streamBatches } from '../ui/render-queue.js';
import { statusLine } from '../ui/skeleton.js';
import { resolveAssetURL, forgetAssetURL } from '../core/settings.js';
import { loadTextureFromURL, loadHDRTexture, isHDRName, dropTexture } from '../core/textures.js';
import { pickFile, fmtBytes, saveBlob, sanitizeName } from '../core/util.js';
import { clearAvatarCache } from '../player/avatar.js';
import { BatchBar } from '../ui/batch.js';
import { invalidateAssetOptions } from '../ui/grid-picker.js';
import { texModByOutput } from '../core/texture-modifier.js';
import { openTexModEditor } from './texture-modifier-editor.js';
import { popover } from './widgets.js';

/** 派生的贴图素材被删时，把它对应的贴图修改器配方一并清掉 */
function dropTexModRecipe(level, assetId) {
  if (!level || !Array.isArray(level.texMods)) return false;
  const full = 'asset:' + assetId;
  const n = level.texMods.length;
  level.texMods = level.texMods.filter((m) => !m || m.output !== full);
  return level.texMods.length !== n;
}

/** 引用被断开后的兜底值（按字段名给） */
const REF_FALLBACK = { texture: 'none', sky: 'dream', bgm: '', sound: '' };
/** 存「裸素材 id」（不带 asset: 前缀）的字段 */
const BARE_KEYS = new Set(['assetId', 'morphAsset', 'textureAsset']);
const KIND_LABEL = { texture: '图片素材', audio: '音频素材', model: '模型素材' };
/** 导出素材时按 MIME 补后缀（素材名里已经带后缀就不补） */
const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/vnd.radiance': '.hdr',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'audio/x-wav': '.wav', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac',
  'model/gltf-binary': '.glb', 'model/gltf+json': '.gltf', 'application/octet-stream': '',
};
/** 图片素材导入时接受的文件类型（含 .hdr 全景天空 / .svg 矢量图） */
const IMAGE_ACCEPT = 'image/*,.hdr,.svg';
/** 把素材字节登记进贴图缓存：.hdr 走 RGBELoader，其余走图片解码（.svg 会光栅化） */
async function registerTextureAsset(id, url, name) {
  if (!url) return null;
  return isHDRName(name) ? loadHDRTexture(id, url) : loadTextureFromURL(id, url, name);
}

/* ============================================================
   素材体检：自动判断一条素材能否正常加载，返回问题描述（正常 = null）
   ============================================================ */
const OVERSIZE = 24 * 1024 * 1024;   // 与导入时的上限保持一致
const extOf = (name) => ((String(name || '').match(/\.([a-z0-9]{1,6})$/i) || ['', ''])[1] || '').toLowerCase();

/** 试着用 <img> 解码一个 URL（png/jpg/webp/gif/bmp/svg 都走这里），失败返回 false */
function decodeImageOK(url) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(true);
    im.onerror = () => res(false);
    im.src = url;
  });
}

/** 试着加载音频元数据，无法解码返回 false（超时按正常处理，避免慢解码误报） */
function decodeAudioOK(url) {
  return new Promise((res) => {
    let done = false;
    const a = new Audio();
    const fin = (ok) => {
      if (done) return;
      done = true;
      a.removeAttribute('src');
      try { a.load(); } catch (e) { /* ignore */ }
      res(ok);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => fin(true);
    a.onerror = () => fin(false);
    setTimeout(() => fin(true), 4000);
    a.src = url;
  });
}

/** 读 URL 头部文本 / 字节（blob: / data: 都在本地，不再走网络） */
async function urlHeadText(url, n) {
  try { const b = await (await fetch(url)).blob(); return await b.slice(0, n).text(); } catch (e) { return ''; }
}
async function urlHeadBytes(url, n) {
  try { const b = await (await fetch(url)).blob(); return new Uint8Array(await b.slice(0, n).arrayBuffer()); } catch (e) { return new Uint8Array(); }
}
async function urlText(url) {
  try { const b = await (await fetch(url)).blob(); return await b.text(); } catch (e) { return ''; }
}

/**
 * 体检一条素材。
 * @returns {Promise<string[]|null>} 问题描述数组；一切正常返回 null
 */
async function diagnoseAsset(rec) {
  const issues = [];
  const name = String(rec.name || '');
  const mime = String(rec.mime || '').toLowerCase();
  const kind = rec.kind || 'texture';
  const ext = extOf(name);

  /* 元数据层面：文件名 / 体积 */
  if (!name.trim()) issues.push('素材没有名称，可能是导入中断留下的残缺记录。');
  if (!rec.size) issues.push('文件内容为空（0 字节），字节可能没有成功写入。');
  else if (rec.size > OVERSIZE) issues.push('文件过大（' + fmtBytes(rec.size) + '，超过 24MB 上限），加载时可能被拒绝。');

  /* 登记类型与文件内容 / MIME 是否一致 */
  const looksImage = mime.startsWith('image/') || ext === 'svg' || ext === 'hdr';
  const looksAudio = mime.startsWith('audio/');
  const looksModel = /glb|gltf|obj/.test(ext) || mime.indexOf('gltf') >= 0;
  const hasHint = !!(mime || ext);
  const got = mime || ('.' + ext);
  if (hasHint) {
    if (kind === 'texture' && !looksImage) issues.push('登记为「图片」，但文件是 ' + got + '，类型与内容不符。');
    else if (kind === 'audio' && !looksAudio) issues.push('登记为「音频」，但文件是 ' + got + '，类型与内容不符。');
    else if (kind === 'model' && !looksModel && mime !== 'application/octet-stream') issues.push('登记为「模型」，但文件是 ' + got + '，类型与内容不符。');
  }

  /* 字节层面：能不能取到实际文件 */
  let url = null;
  try { url = await resolveAssetURL(rec.id); } catch (e) { url = null; }
  if (!url) {
    issues.push('素材文件缺失：存档里只有登记信息，找不到实际文件字节（可能存档损坏、文件被清理，或该素材没有随关卡本地化）。');
    return issues;
  }

  /* 内容层面：结构 / 解码校验 */
  if (kind === 'texture') {
    if (ext === 'hdr') {
      const h = await urlHeadText(url, 32);
      if (!/^#\?(RADIANCE|RGBE)/.test(h)) issues.push('不是有效的 HDR 全景图（.hdr 文件头异常），可能已损坏。');
    } else if (!(await decodeImageOK(url))) {
      issues.push('图片无法解码：文件可能已损坏，或使用了浏览器不支持的图片格式。');
    }
  } else if (kind === 'model') {
    if (ext === 'glb') {
      const b = await urlHeadBytes(url, 4);
      if (!(b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46)) issues.push('不是有效的 GLB 模型（文件头魔数错误），可能已损坏。');
    } else if (ext === 'gltf') {
      const t = await urlText(url);
      try {
        const j = JSON.parse(t);
        if (!j || (!j.asset && !j.meshes)) issues.push('GLTF 内容缺少必要字段，可能不是有效的模型文件。');
      } catch (e) { issues.push('GLTF 解析失败：不是合法的 JSON，文件可能已损坏。'); }
    } else if (ext === 'obj') {
      const t = await urlText(url);
      if (!/\S/.test(t)) issues.push('OBJ 文件内容为空。');
    }
  } else if (kind === 'audio') {
    if (!(await decodeAudioOK(url))) issues.push('音频无法解码：文件可能已损坏，或使用了浏览器不支持的音频格式。');
  }

  return issues.length ? issues : null;
}

let _mgr = null;                              // 当前编辑器里的管理器实例
export function registerAssetManager(m) { _mgr = m; }
export function refreshAssetManager() { if (_mgr) _mgr.refresh(); }

/**
 * 统一导入入口：所有「导入素材」的按钮都走这里，
 * 保证任何地方导入的素材都会登记进素材管理器。
 * @param {'texture'|'audio'|'model'} kind
 * @param {{ed?:object}} opts
 * @returns {Promise<object|null>} 素材记录
 */
export async function importAssetFile(kind, opts = {}) {
  const accept = kind === 'model' ? '.glb,.gltf,.obj'
    : kind === 'audio' ? 'audio/*,.mp3,.ogg,.wav,.m4a,.aac,.flac' : IMAGE_ACCEPT;
  const file = await pickFile(accept);
  if (!file) return null;
  if (file.size > 24 * 1024 * 1024) { toast('文件过大（>24MB）', 'err'); return null; }
  let rec = null;
  try {
    rec = await store.saveAsset(file, kind);
  } catch (e) {
    console.error('[asset] 导入失败', e);
    toast('导入失败：' + (e && e.message ? e.message : e), 'err', 3200);
    return null;
  }
  if (!rec) return null;
  // 图片素材登记进贴图缓存：选成贴图 / 天空盒后立刻生效（.hdr 走 RGBELoader）
  if (kind === 'texture') {
    try {
      const url = await resolveAssetURL(rec.id);
      if (url) await registerTextureAsset('asset:' + rec.id, url, rec.name || file.name);
    } catch (e) { /* 注册失败不影响素材本身 */ }
  }
  // 模型素材：丢弃角色模板缓存，避免玩家 morph 用到旧几何
  if (kind === 'model') clearAvatarCache();
  toast('已导入 ' + file.name, 'ok');
  if (opts.ed && opts.ed.log) opts.ed.log('导入资源 ' + file.name + '（' + fmtBytes(file.size) + '）', 'i');
  // 属性面板里的贴图 / 全景图 / 音频 / 模型下拉缓存了素材列表，导入后必须失效，
  // 否则下拉里看不到刚导入的素材（会静默回落成内置贴图）
  invalidateAssetOptions();
  if (opts.ed && opts.ed.inspector && opts.ed.inspector.invalidateAssets) opts.ed.inspector.invalidateAssets();
  refreshAssetManager();
  return rec;
}

/**
 * 断开关卡里对某个素材的全部引用（就地修改 level）
 * @returns {string[]} 被断开的引用路径，供日志 / 提示用
 */
export function clearAssetRefs(level, assetId) {
  const full = 'asset:' + assetId;
  const hit = [];
  const walk = (v, path) => {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return; }
    if (typeof v !== 'object') return;
    for (const k in v) {
      const val = v[k];
      if (typeof val === 'string' && (val === full || (BARE_KEYS.has(k) && val === assetId))) {
        v[k] = REF_FALLBACK[k] !== undefined ? REF_FALLBACK[k] : '';
        hit.push(path + '.' + k);
      } else {
        walk(val, path + '.' + k);
      }
    }
  };
  walk(level, '');
  return hit;
}

/* ============================================================
   面板
   ============================================================ */
export class AssetManager {
  constructor(ed) {
    this.ed = ed;
    this.host = document.getElementById('asset-list');
    this.recs = [];
    this._rev = 0;            // refresh 代际令牌
    this._ac = null;          // 流式加载中止控制器
    this._status = null;      // 加载状态行句柄
    this._diagQ = [];         // 体检队列
    this._diagRunning = false;
    this._bind();
    registerAssetManager(this);
  }

  _bind() {
    const add = (act, kind) => {
      const b = document.querySelector('[data-act="' + act + '"]');
      if (b) b.addEventListener('click', async () => {
        const rec = await importAssetFile(kind, { ed: this.ed });
        if (rec) this.ed && this.ed.refreshProps && this.ed.refreshProps();
      });
    };
    add('asset-import-tex', 'texture');
    add('asset-import-audio', 'audio');
    add('asset-import-model', 'model');
    const rf = document.querySelector('[data-act="asset-refresh"]');
    if (rf) rf.addEventListener('click', () => this.refresh());

    // 批量操作：多选素材后一次性导出 / 复制 / 删除
    this.batch = new BatchBar({
      host: this.host,
      itemSelector: '.arow',
      idOf: (n) => n.dataset.assetId,
      actions: [
        { label: '⇩ 导出', title: '把所选素材原文件导出到本地', run: (ids) => this.batchExport(ids) },
        { label: '⧉ 复制', title: '复制所选素材（生成一份新的素材）', run: (ids) => this.batchDuplicate(ids) },
        { label: '🗑 删除', cls: 'del', title: '删除所选素材（同时断开引用）', run: (ids) => this.batchRemove(ids) },
      ],
    });
  }

  async refresh() {
    if (!this.host) return;
    const rev = ++this._rev;
    if (this._ac) this._ac.abort();
    this._ac = new AbortController();
    const signal = this._ac.signal;
    clear(this.host);
    this.recs = [];
    this._diagQ = [];
    this._status = statusLine(this.host, '正在加载素材…');
    let light = [];
    try {
      // 只取渲染 / 操作需要的元数据，剥掉素材字节（大）
      const all = (await store.listAssets()) || [];
      light = all.map((r) => ({ id: r.id, name: r.name, kind: r.kind, size: r.size, created: r.created, mime: r.mime, level: r.level }));
    } catch (e) { light = []; }
    if (rev !== this._rev) return;
    // 固定按导入时间倒序：先排好序，再分批上屏即可保持顺序
    light.sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0));
    await streamBatches(light, {
      batchSize: 20,
      signal,
      process: async (slice) => {
        const proj = await runListTask('assetList', { recs: slice });
        return (proj && proj.items) || slice;
      },
      onProgress: (i) => { if (this._status) this._status.set(`正在加载素材 ${i.done}/${i.total}…`); },
      onBatch: (items) => {
        if (rev !== this._rev) return;
        for (const rec of items) this._appendRow(rec);
        if (this.batch) this.batch.sync();
      },
    });
    if (rev !== this._rev) return;
    if (this._status) { this._status.remove(); this._status = null; }
    if (!this.recs.length) {
      this.host.appendChild(el('div', { class: 'asset-empty', text: '还没有导入任何素材' }));
      if (this.batch) { this.batch.setAvailable(false); this.batch.sync(); }
      return;
    }
    if (this.batch) { this.batch.setAvailable(true); this.batch.sync(); }
  }

  /** 增量追加一行素材（先到先显示） */
  _appendRow(rec) {
    const host = this.host;
    if (!host) return;
    this.recs.push(rec);
    const row = el('div', { class: 'arow', dataset: { assetId: rec.id } });
    row.appendChild(this._thumb(rec));
    row.appendChild(el('div', { class: 'amain' },
      el('div', { class: 'aname', title: rec.name || '', text: rec.name || '' }),
      el('div', { class: 'ameta', text: (KIND_LABEL[rec.kind] || '素材') + ' · ' + fmtBytes(rec.size || 0) })));
    // 加载异常时才显示的黄色感叹号（体检结果异步刷新进来）
    const warn = el('span', { class: 'awarn hidden' });
    row.appendChild(warn);
    if (rec.kind === 'texture' && !isHDRName(rec.name)) {
      const lv = this.ed && this.ed.level;
      const derived = !!(lv && texModByOutput(lv, rec.id));
      row.appendChild(el('button', {
        class: 'mini', text: derived ? '🎛' : '✦',
        title: derived ? '用贴图修改器编辑这条配方' : '以此贴图为源，用贴图修改器派生一张新贴图',
        onclick: () => openTexModEditor('asset:' + rec.id),
      }));
    }
    row.appendChild(el('button', {
      class: 'mini', text: '⇄', title: '替换素材（覆盖同一素材，关卡里的引用不用改）',
      onclick: () => this.replace(rec),
    }));
    row.appendChild(el('button', {
      class: 'mini', text: '✎', title: '重命名素材',
      onclick: () => this.rename(rec),
    }));
    row.appendChild(el('button', {
      class: 'mini danger', text: '🗑', title: '删除素材（同时断开引用）',
      onclick: () => this.remove(rec),
    }));
    host.appendChild(row);
    this._enqueueDiag(rec, row, warn);
    return row;
  }

  /** 逐条体检（限流，避免一次性解码 / 读取太多素材），结果异步补上感叹号 */
  _enqueueDiag(rec, row, warn) {
    this._diagQ.push([rec, row, warn]);
    if (!this._diagRunning) this._drainDiagnostics();
  }

  async _drainDiagnostics() {
    if (this._diagRunning) return;
    this._diagRunning = true;
    const rev = this._rev;
    const one = async () => {
      while (this._diagQ.length) {
        if (rev !== this._rev) return;
        const [rec, row, warn] = this._diagQ.shift();
        let issues = null;
        try { issues = await diagnoseAsset(rec); } catch (e) { issues = null; }
        if (!issues || !warn.isConnected) continue;
        warn.textContent = '⚠';
        warn.title = '加载异常，点击查看原因';
        warn.classList.remove('hidden');
        row.classList.add('warn');
        warn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          popover({
            title: '⚠ 素材加载异常', anchor: warn, width: 320,
            body: el('div', { class: 'awarn-body' },
              el('div', { class: 'awarn-name', text: rec.name || rec.id }),
              ...issues.map((t) => el('div', { class: 'awarn-issue', text: '· ' + t }))),
          });
        });
      }
    };
    await Promise.all([one(), one(), one(), one()]);
    this._diagRunning = false;
    if (this._diagQ.length && rev === this._rev) this._drainDiagnostics();
  }

  _thumb(rec) {
    const box = el('div', { class: 'athumb' });
    if (rec.kind === 'texture') {
      if (isHDRName(rec.name)) {
        box.appendChild(el('span', { text: 'HDR' }));   // .hdr 无法用 <img> 预览
      } else {
        const img = el('img', { alt: '' });
        resolveAssetURL(rec.id).then((u) => { if (u) img.src = u; }).catch(() => {});
        box.appendChild(img);
      }
    } else {
      box.appendChild(el('span', { text: rec.kind === 'audio' ? '♪' : '🧊' }));
    }
    return box;
  }

  async rename(rec) {
    const name = await promptBox('素材名称', rec.name || '', { title: '重命名素材' });
    if (name === null) return;
    const n = String(name).trim();
    if (!n || n === rec.name) return;
    await store.renameAsset(rec.id, n);
    toast('已重命名为「' + n + '」', 'ok');
    await this.refresh();
    if (this.ed && this.ed.inspector) this.ed.inspector.invalidateAssets();
    if (this.ed && this.ed.refreshProps) this.ed.refreshProps();
  }

  /** 替换素材：新文件覆盖同一素材 id 的本地副本，关卡里已有的引用不用改 */
  async replace(rec) {
    const accept = rec.kind === 'model' ? '.glb,.gltf,.obj'
      : rec.kind === 'audio' ? 'audio/*,.mp3,.ogg,.wav,.m4a,.aac,.flac' : IMAGE_ACCEPT;
    const file = await pickFile(accept);
    if (!file) return;
    if (file.size > 24 * 1024 * 1024) { toast('文件过大（>24MB）', 'err'); return; }
    try {
      await store.saveAsset(file, rec.kind || 'texture', {
        id: rec.id, name: rec.name || file.name, created: rec.created,
      });
    } catch (e) {
      console.error('[asset] 替换失败', e);
      toast('替换失败：' + (e && e.message ? e.message : e), 'err', 3200);
      return;
    }
    // 旧字节的所有缓存都要丢掉：URL / 贴图 / 模型模板
    forgetAssetURL(rec.id);
    dropTexture('asset:' + rec.id);
    if (rec.kind === 'model') clearAvatarCache();
    if (rec.kind === 'texture') {
      try {
        const url = await resolveAssetURL(rec.id);
        if (url) await registerTextureAsset('asset:' + rec.id, url, rec.name || file.name);
      } catch (e) { /* 注册失败不影响素材本身 */ }
    }
    toast('已替换「' + (rec.name || '') + '」', 'ok');
    if (this.ed && this.ed.log) this.ed.log('替换素材 ' + (rec.name || rec.id), 'i');
    // 关卡里用到它的物体要换上新字节
    try { if (this.ed && this.ed.builder) this.ed.builder.refreshAll(); } catch (e) { /* ignore */ }
    await this.refresh();
    if (this.ed && this.ed.inspector) this.ed.inspector.invalidateAssets();
    if (this.ed && this.ed.refreshProps) this.ed.refreshProps();
  }

  async remove(rec) {
    const ok = await confirmBox('删除素材「' + (rec.name || '') + '」？关卡里引用它的对象会被一并断开。',
      { title: '删除素材', danger: true, ok: '删除' });
    if (!ok) return;
    await store.deleteAsset(rec.id);
    forgetAssetURL(rec.id);
    dropTexture('asset:' + rec.id);

    const ed = this.ed;
    let n = 0;
    /* 素材是每关独享的，只断开当前关卡的引用即可（可撤销） */
    if (ed && ed.level) {
      const prev = ed.snap();
      const hit = clearAssetRefs(ed.level, rec.id);
      // 派生贴图被删 → 生成它的那条配方也一并清掉，避免留下算不出来的配方
      const droppedRecipe = dropTexModRecipe(ed.level, rec.id);
      n += hit.length + (droppedRecipe ? 1 : 0);
      if (hit.length || droppedRecipe) {
        try { ed.builder && ed.builder.refreshAll(); } catch (e) { /* ignore */ }
        try { ed.paint && ed.paint.rebuildAll(); } catch (e) { /* ignore */ }
        try { ed.applyLevelSettings(); } catch (e) { /* ignore */ }
        ed.record('删除素材', prev);
        if (ed.refreshTree) ed.refreshTree();
      }
    }

    toast(n ? '已删除素材，断开 ' + n + ' 处引用' : '已删除素材', 'ok');
    await this.refresh();
    if (ed && ed.inspector) ed.inspector.invalidateAssets();
    if (ed && ed.refreshProps) ed.refreshProps();
  }

  /* ============================================================
     批量操作
     ============================================================ */
  _pick(ids) { return ids.map((id) => this.recs.find((r) => r.id === id)).filter(Boolean); }

  /** 取素材原始字节（服务器 / IndexedDB 两种后端统一成 Blob） */
  async _blob(rec) {
    const full = await store.getAsset(rec.id);
    const data = full && full.data;
    if (!data) return null;
    if (typeof data === 'string') return (await fetch(data)).blob();
    return data instanceof Blob ? data : null;
  }

  _fileName(rec) {
    const base = sanitizeName(rec.name || rec.id, rec.id);
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
    return base + (MIME_EXT[rec.mime] || '');
  }

  async batchExport(ids) {
    const list = this._pick(ids);
    let n = 0;
    for (const rec of list) {
      try {
        const blob = await this._blob(rec);
        if (!blob) continue;
        saveBlob(this._fileName(rec), blob);
        n++;
      } catch (e) { console.warn('[asset] 导出失败', rec.name, e); }
    }
    toast(n ? `已导出 ${n} 个素材文件` : '没有可导出的素材', n ? 'ok' : 'err');
  }

  async batchDuplicate(ids) {
    const list = this._pick(ids);
    let n = 0;
    for (const rec of list) {
      try {
        const blob = await this._blob(rec);
        if (!blob) continue;
        const file = new File([blob], this._fileName(rec), { type: rec.mime || '' });
        const copy = await store.saveAsset(file, rec.kind || 'texture', { name: (rec.name || '素材') + ' 副本' });
        if (copy && rec.kind === 'texture') {
          const url = await resolveAssetURL(copy.id);
          if (url) await registerTextureAsset('asset:' + copy.id, url, copy.name || rec.name);
        }
        n++;
      } catch (e) { console.warn('[asset] 复制失败', rec.name, e); }
    }
    toast(n ? `已复制 ${n} 个素材` : '复制失败', n ? 'ok' : 'err');
    await this.refresh();
    if (this.ed && this.ed.inspector) this.ed.inspector.invalidateAssets();
    if (this.ed && this.ed.refreshProps) this.ed.refreshProps();
  }

  async batchRemove(ids) {
    const list = this._pick(ids);
    if (!list.length) return;
    const ok = await confirmBox(`删除所选的 ${list.length} 个素材？关卡里引用它们的对象会被一并断开。`,
      { title: '批量删除素材', danger: true, ok: '删除' });
    if (!ok) return;
    const ed = this.ed;
    const prev = ed && ed.level ? ed.snap() : null;
    let refs = 0;
    for (const rec of list) {
      try { await store.deleteAsset(rec.id); }
      catch (e) { console.warn('[asset] 删除失败', rec.name, e); }
      forgetAssetURL(rec.id);
      dropTexture('asset:' + rec.id);
      if (rec.kind === 'model') clearAvatarCache();
      if (ed && ed.level) {
        refs += clearAssetRefs(ed.level, rec.id).length;
        if (dropTexModRecipe(ed.level, rec.id)) refs += 1;
      }
    }
    /* 引用断开后整体刷新一次（可撤销），避免逐个素材重建场景 */
    if (ed && ed.level && refs) {
      try { ed.builder && ed.builder.refreshAll(); } catch (e) { /* ignore */ }
      try { ed.paint && ed.paint.rebuildAll(); } catch (e) { /* ignore */ }
      try { ed.applyLevelSettings(); } catch (e) { /* ignore */ }
      ed.record('批量删除素材', prev);
      if (ed.refreshTree) ed.refreshTree();
    }
    toast(refs ? `已删除 ${list.length} 个素材，断开 ${refs} 处引用` : `已删除 ${list.length} 个素材`, 'ok');
    await this.refresh();
    if (ed && ed.inspector) ed.inspector.invalidateAssets();
    if (ed && ed.refreshProps) ed.refreshProps();
  }
}
