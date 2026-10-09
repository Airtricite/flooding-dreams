/* ============================================================
   存档层
   两档后端，按可用性降级：
     1. server  本地服务器的存档接口（serve.py 或 Electron 桌面版，
                都是同一套 /api/store/ 接口，落盘到 saves/）
     2. idb     浏览器 IndexedDB（miniserve / 普通静态托管打开时），
                此时存档按 origin（含端口）隔离
   存档单元：一个关卡 = 一个文件夹（自带素材，可整体拷走）
     saves/levels/<levelId>/level.json      关卡记录
     saves/levels/<levelId>/assets/<id>.bin 本地化素材（导入时自动拷进来）
   stores:
     levels   { id, name, difficulty, updated, created, builtin, data(JSON对象), thumb }
     assets   { id, name, mime, kind:'model'|'texture', size, created, level, data(Blob/DataURL) }
     progress { id, cleared, bestTime, lastTime, deaths, plays, at, updated, lvUpdated }
              lvUpdated = 通关时该关卡的 updated 时间戳（地图更新后 PB 失效重置）
     kv       { k, v }
   素材的 id 全局唯一，但存放在所属关卡的文件夹里；写/列素材要看
   「当前关卡」（assetScope），读素材只需 id（后端会自己找）。
   ============================================================ */

import {
  isExtendedId, builtinURL, builtinAnyMeta, builtinFamily, THUMB_SCOPE,
} from './builtin-assets.js';

const DB_NAME = 'flooding-dreams';
const DB_VER = 1;
const STORES = ['levels', 'assets', 'progress', 'kv'];
const API = './api/store/';
const MIGRATED = '__idbMigrated';   // “已从浏览器迁移过”标记，存在服务器 kv 里

class Store {
  constructor() {
    this.db = null;
    this.ready = false;
    this.mode = null;               // 'server' | 'desktop' | 'idb'
    this.assetScope = null;         // 当前关卡的素材池（编辑器打开关卡 / 开始游戏时设置）
    this._fallback = new Map();     // IDB 不可用时用内存兜底
    this._boot = null;
  }

  /** 切换「当前关卡」：素材的写入 / 列表都按这个作用域走 */
  setAssetScope(levelId) { this.assetScope = levelId || null; }

  /* ============================================================
     后端选择：优先服务器存档，其次 IndexedDB
     ============================================================ */
  boot() {
    if (!this._boot) this._boot = this._bootRun();
    return this._boot;
  }
  async _bootRun() {
    try {
      const r = await fetch(API + 'ping', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok) {
          this.mode = 'server';
          console.log('[store] 本地存档模式：' + (j.root || API));
          await this._migrateFromIDB();
          return this.mode;
        }
      }
    } catch (e) { /* 没有接口，用浏览器存储 */ }
    this.mode = 'idb';
    return this.mode;
  }
  async _onServer() { return (await this.boot()) === 'server'; }

  /* ---------- 服务器接口 ---------- */
  async _srvFetch(act, params, init) {
    const q = new URLSearchParams(params || {});
    const r = await fetch(API + act + '?' + q.toString(), init);
    if (!r.ok) throw new Error('store ' + act + ' ' + r.status);
    return r.json();
  }
  async _srvPut(store, rec) {
    await this._srvFetch('put', { store }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rec),
    });
    return rec;
  }
  _srvGet(store, id) { return this._srvFetch('get', { store, id }); }
  _srvAll(store, extra) { return this._srvFetch('list', { store, ...(extra || {}) }); }
  async _srvDel(store, id) { await this._srvFetch('del', { store, id }, { method: 'POST' }); }
  async _srvClear(store) { await this._srvFetch('clear', { store }, { method: 'POST' }); }

  /** 把一条资源记录（data 是 dataURL 或 Blob）写进服务器 */
  async _srvPutAssetRec(rec) {
    let blob = rec.data;
    if (typeof blob === 'string') blob = await (await fetch(blob)).blob();
    else if (!(blob instanceof Blob)) blob = new Blob([blob || ''], { type: rec.mime || '' });
    const meta = {
      id: rec.id, name: rec.name || '', mime: rec.mime || '', kind: rec.kind || 'texture',
      size: rec.size || blob.size, created: rec.created || Date.now(),
      level: rec.level || '',
    };
    const q = new URLSearchParams({ id: rec.id, meta: JSON.stringify(meta) });
    if (rec.level) q.set('level', rec.level);
    const r = await fetch(API + 'asset?' + q.toString(), { method: 'POST', body: blob });
    if (!r.ok) throw new Error('store asset ' + r.status);
  }

  /** 首次连上服务器时，把浏览器里已有的存档搬过去（只搬一次） */
  async _migrateFromIDB() {
    try {
      if (await this._srvGet('kv', MIGRATED)) return;
      const remote = await this._srvAll('levels');
      if (remote.length) { await this._srvPut('kv', { k: MIGRATED, v: true }); return; }
      const levels = await this._idbAll('levels');
      const progress = await this._idbAll('progress');
      const assets = await this._idbAll('assets');
      if (!levels.length && !progress.length && !assets.length) return;
      for (const r of levels) await this._srvPut('levels', r);
      for (const r of progress) await this._srvPut('progress', r);
      for (const r of assets) await this._srvPutAssetRec(r);
      await this._srvPut('kv', { k: MIGRATED, v: true });
      console.log(`[store] 已把浏览器存档迁移到服务器：关卡 ${levels.length} / 进度 ${progress.length} / 资源 ${assets.length}`);
    } catch (e) { console.warn('[store] 迁移旧存档失败', e); }
  }

  /* ============================================================
     IndexedDB
     ============================================================ */
  open() {
    if (this._p) return this._p;
    this._p = new Promise((resolve) => {
      if (!('indexedDB' in window)) { console.warn('[store] IndexedDB 不可用，使用内存兜底'); resolve(false); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { resolve(false); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('levels')) db.createObjectStore('levels', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => { this.db = req.result; this.ready = true; resolve(true); };
      req.onerror = () => { console.warn('[store] 打开失败', req.error); resolve(false); };
      req.onblocked = () => resolve(false);
    });
    return this._p;
  }

  _tx(store, mode) {
    const tx = this.db.transaction(store, mode);
    return tx.objectStore(store);
  }
  _req(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  async _idbPut(store, val) {
    if (!await this.open()) { this._fallback.set(store + ':' + val.id, val); return val; }
    await this._req(this._tx(store, 'readwrite').put(val));
    return val;
  }
  async _idbGet(store, id) {
    if (!await this.open()) return this._fallback.get(store + ':' + id) || null;
    return (await this._req(this._tx(store, 'readonly').get(id))) || null;
  }
  async _idbAll(store) {
    if (!await this.open()) {
      return [...this._fallback.entries()].filter(([k]) => k.startsWith(store + ':')).map(([, v]) => v);
    }
    return (await this._req(this._tx(store, 'readonly').getAll())) || [];
  }
  async _idbDel(store, id) {
    if (!await this.open()) { this._fallback.delete(store + ':' + id); return; }
    await this._req(this._tx(store, 'readwrite').delete(id));
  }
  async _idbClear(store) {
    if (!await this.open()) { for (const k of [...this._fallback.keys()]) if (k.startsWith(store + ':')) this._fallback.delete(k); return; }
    await this._req(this._tx(store, 'readwrite').clear());
  }

  /* ============================================================
     通用读写（levels / progress / kv 都是纯 JSON，两条后端通用）
     ============================================================ */
  async put(store, val) {
    if (await this._onServer()) return this._srvPut(store, val);
    return this._idbPut(store, val);
  }
  async get(store, id) {
    if (await this._onServer()) return this._srvGet(store, id);
    return this._idbGet(store, id);
  }
  async all(store) {
    if (await this._onServer()) return this._srvAll(store);
    return this._idbAll(store);
  }
  /**
   * 只读：拿整个 store 的原始 JSON 文本（server 模式）。
   * 让列表的 JSON.parse 也离开主线程（交给 Worker）；idb 模式返回 null（调用方改用 all()）。
   */
  async allText(store) {
    if (!await this._onServer()) return null;
    const r = await fetch(API + 'list?store=' + encodeURIComponent(store), { cache: 'no-store' });
    if (!r.ok) throw new Error('store list ' + r.status);
    return r.text();
  }
  async del(store, id) {
    if (await this._onServer()) return this._srvDel(store, id);
    return this._idbDel(store, id);
  }
  async clear(store) {
    if (await this._onServer()) return this._srvClear(store);
    return this._idbClear(store);
  }

  /* ---------- 关卡 ---------- */
  saveLevel(meta) {
    const rec = {
      id: meta.id,
      name: meta.name || '未命名',
      author: meta.author || '玩家',
      description: meta.description || '',
      difficulty: Number(meta.difficulty) || 1,
      builtin: !!meta.builtin,
      packId: meta.packId || '',      // 所属关卡包 id（非空 = 包内关卡，不出现在任何选关列表）
      created: meta.created || Date.now(),
      updated: Date.now(),
      bytes: 0,
      data: meta.data || null,
      thumb: meta.thumb || null,
    };
    try { rec.bytes = JSON.stringify(rec.data).length; } catch (e) { rec.bytes = 0; }
    return this.put('levels', rec);
  }
  getLevel(id) { return this.get('levels', id); }
  listLevels() { return this.all('levels'); }
  /** 只读：关卡列表的原始 JSON 文本（server 模式），供 Worker 解析；idb 模式返回 null */
  listLevelsText() { return this.allText('levels'); }
  /** 删关卡 = 删它整个文件夹（连本地化素材一起删），与服务器语义一致 */
  async deleteLevel(id) {
    if (await this._onServer()) return this._srvDel('levels', id);   // 整个关卡文件夹一起删，素材自然也清空
    try {
      const all = await this._idbAll('assets');
      for (const r of all) if ((r.level || '') === id) await this._idbDel('assets', r.id);
    } catch (e) { console.warn('[store] 删除关卡素材失败', id, e); }
    return this._idbDel('levels', id);
  }

  /* ---------- 资源 ---------- */
  async saveAsset(file, kind, extra) {
    const opt = extra || {};
    const id = opt.id || ('a' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
    // 默认写进「当前关卡」的素材文件夹（本地化）；替换同一素材时传 opt.id 原样覆盖
    const level = opt.levelId === undefined ? (this.assetScope || '') : (opt.levelId || '');
    const rest = { ...opt };
    delete rest.id; delete rest.levelId;
    const name = opt.name || file.name || '';
    const mime = file.type || opt.mime || '';
    if (await this._onServer()) {
      const meta = {
        id, name, mime, kind: kind || 'texture',
        size: file.size, created: opt.created || Date.now(), level, ...rest,
      };
      const q = new URLSearchParams({ id, meta: JSON.stringify(meta) });
      if (level) q.set('level', level);
      const r = await fetch(API + 'asset?' + q.toString(), { method: 'POST', body: file });
      if (!r.ok) throw new Error('store asset ' + r.status);
      return { ...meta, data: file };
    }
    let data;
    const maxInline = 1.6 * 1024 * 1024; // 小文件存 dataURL，便于随关卡导出
    if (file.size <= maxInline) {
      data = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = () => rej(r.error);
        r.readAsDataURL(file);
      });
    } else {
      data = file; // Blob 直接存 IDB（不参与导出）
    }
    const rec = { id, name, mime, kind: kind || 'texture', size: file.size, created: opt.created || Date.now(), level, ...rest, data };
    await this._idbPut('assets', rec);
    return rec;
  }
  /** 读素材字节：只需 id（带 level 只是给后端一个直查提示，找不到会自动全局搜索） */
  async getAsset(id, levelId) {
    // 扩充内置素材：字节不在存档里，直接取站点上的原文件（导出打包时也走这里）
    if (isExtendedId(id)) return this._builtinAsset(id);
    const lv = levelId === undefined ? this.assetScope : levelId;
    if (await this._onServer()) {
      const meta = await this.getAssetMeta(id, levelId);
      if (!meta) return null;
      const q = new URLSearchParams({ id });
      if (lv) q.set('level', lv);
      const r = await fetch(API + 'asset?' + q.toString(), { cache: 'no-store' });
      meta.data = r.ok ? await r.blob() : null;
      return meta;
    }
    return this._idbGet('assets', id);
  }
  /** 只要元数据、不要文件字节（模型加载时查名字用，避免白下载大文件） */
  async getAssetMeta(id, levelId) {
    if (isExtendedId(id)) return this._builtinMeta(id);
    const lv = levelId === undefined ? this.assetScope : levelId;
    if (await this._onServer()) {
      const params = { store: 'assets', id };
      if (lv) params.level = lv;
      const m = await this._srvFetch('get', params);
      if (m) delete m.data;
      return m || null;
    }
    const rec = await this._idbGet('assets', id);
    return rec ? { ...rec, data: undefined } : null;
  }
  /** 扩充内置素材的元数据（清单未加载 / 无 assets 目录 → null，调用方按「已丢失」处理） */
  _builtinMeta(id) {
    const m = builtinAnyMeta(id);
    if (!m) return null;
    const fam = builtinFamily(id);
    // name 用「文件名」而不是展示名：各处靠 .hdr 后缀判断 RGBE 全景图，
    // 物化成普通素材 / 打包导出时也用得上这个文件名
    const base = String(id).split('/').pop() || id;
    return {
      id, name: base, label: m.label || m.name, mime: m.mime, kind: 'texture',
      size: m.size, created: 0, level: '', ext: true, cat: m.cat,
      normalMap: fam ? fam.normal : null, roughnessMap: fam ? fam.rough : null,
    };
  }
  /** 扩充内置素材的字节（fetch 站点原文件；失败 → null） */
  async _builtinAsset(id) {
    const meta = this._builtinMeta(id);
    if (!meta) return null;
    const url = builtinURL(id);
    if (!url) return { ...meta, data: null };
    try {
      const r = await fetch(url, { cache: 'no-store' });
      return { ...meta, data: r.ok ? await r.blob() : null };
    } catch (e) {
      return { ...meta, data: null };
    }
  }
  /**
   * 列出素材：默认列「当前关卡」的素材池；显式传 null 列全部
   * （各关卡文件夹 + 旧的全局池，用于统计用量）。
   */
  async listAssets(levelId) {
    const lv = levelId === undefined ? this.assetScope : levelId;
    if (await this._onServer()) {
      const all = await this._srvAll('assets', lv ? { level: lv } : null);
      // 不带 scope 的「全部」要把扩充内置素材的缩略图缓存剔掉，别混进素材管理器 / 选择器
      return lv ? all : (all || []).filter((r) => r && (r.level || '') !== THUMB_SCOPE);
    }
    const all = await this._idbAll('assets');
    if (!lv) return all.filter((r) => (r.level || '') !== THUMB_SCOPE);
    return all.filter((r) => (r.level || '') === lv);
  }
  async deleteAsset(id, levelId) {
    const lv = levelId === undefined ? this.assetScope : levelId;
    if (await this._onServer()) {
      const params = { store: 'assets', id };
      if (lv) params.level = lv;
      await this._srvFetch('del', params, { method: 'POST' });
      return;
    }
    return this._idbDel('assets', id);
  }
  /** 重命名素材（只改元数据，不动字节） */
  async renameAsset(id, name) {
    const rec = await this.getAssetMeta(id);
    if (!rec) return null;
    rec.name = String(name || '').trim() || rec.name;
    if (await this._onServer()) {
      // 服务器按 id 定位到素材所在的关卡文件夹，把元数据原样覆盖（字节留在 .bin 里）
      const params = { store: 'assets' };
      if (this.assetScope) params.level = this.assetScope;
      await this._srvFetch('put', params, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rec),
      });
      return rec;
    }
    const full = await this._idbGet('assets', id);
    if (!full) return null;
    full.name = rec.name;
    await this._idbPut('assets', full);
    return full;
  }

  /**
   * 把「角色皮肤」挂到模型素材上（只改元数据，不动字节）。
   * 皮肤跟着素材走：关卡本地化 / 打包导出时素材被复制，皮肤也就一起过去了，
   * 关卡因此可以自带角色，不依赖对方的全局存档。
   */
  async setAssetSkin(id, skin) {
    if (!id) return null;
    const rec = await this.getAssetMeta(id);
    if (!rec) return null;
    rec.skin = skin || null;
    if (await this._onServer()) {
      const params = { store: 'assets' };
      if (this.assetScope) params.level = this.assetScope;
      await this._srvFetch('put', params, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rec),
      });
      return rec;
    }
    const full = await this._idbGet('assets', id);
    if (!full) return null;
    full.skin = rec.skin;
    await this._idbPut('assets', full);
    return full;
  }

  /* ---------- 进度 ---------- */
  async getProgress(id) { return (await this.get('progress', id)) || null; }
  async setProgress(id, patch) {
    const cur = (await this.getProgress(id)) || { id, cleared: false, bestTime: 0, deaths: 0, plays: 0 };
    const rec = { ...cur, ...patch, id, updated: Date.now() };
    await this.put('progress', rec);
    return rec;
  }
  listProgress() { return this.all('progress'); }

  /* ---------- KV ---------- */
  async kvGet(k, def = null) {
    const r = await this.get('kv', k);
    return r ? r.v : def;
  }
  kvSet(k, v) { return this.put('kv', { k, v }); }

  /* ---------- 维护 ---------- */
  async usage() {
    let bytes = 0;
    try {
      const lv = await this.listLevels();
      const as = await this.listAssets(null);       // null = 全部（含旧全局池）
      for (const r of lv) bytes += (r.bytes || 0) + (typeof r.thumb === 'string' ? r.thumb.length : 0);
      // 扩充内置素材的缩略图缓存不算用户占用（那是游戏自己的缓存）
      for (const r of as) if ((r.level || '') !== THUMB_SCOPE) bytes += r.size || 0;
    } catch (e) { /* ignore */ }
    return bytes;
  }
  async estimateQuota() {
    if (navigator.storage && navigator.storage.estimate) {
      try { return await navigator.storage.estimate(); } catch (e) { return null; }
    }
    return null;
  }
  /** 导出全部数据（备份） */
  async exportAll() {
    return {
      kind: 'flooding-dreams-backup', version: 1, date: Date.now(),
      levels: await this.listLevels(),
      progress: await this.listProgress(),
    };
  }
  /** 清理「当前关卡」文件夹里没有被本关引用的素材（素材已是每关独享） */
  async gcAssets(levelId) {
    const lv = levelId === undefined ? this.assetScope : levelId;
    if (!lv) return 0;
    const rec = await this.getLevel(lv);
    if (!rec || !rec.data) return 0;
    const used = new Set();
    const walk = (v) => {
      if (!v) return;
      if (typeof v === 'string') {
        // 贴图 / 天空盒 / 音频的引用都是 'asset:<id>' 这种字符串
        if (v.startsWith('asset:')) used.add(v.slice(6));
        return;
      }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (typeof v === 'object') {
        // 模型 / 角色形象引用直接存裸 id
        if (typeof v.assetId === 'string') used.add(v.assetId);
        if (typeof v.textureAsset === 'string') used.add(v.textureAsset);
        if (typeof v.morphAsset === 'string') used.add(v.morphAsset);
        for (const k in v) walk(v[k]);
      }
    };
    walk(rec.data);
    const assets = await this.listAssets(lv);
    let n = 0;
    for (const a of assets) if (!used.has(a.id)) { await this.deleteAsset(a.id, lv); n++; }
    return n;
  }
}

export const store = new Store();
