/* ============================================================
   Grid 选择器：把原生 <select> 换成「方形 Cell 弹窗」
   - placeholderIcon(text)          枚举型占位图标（精选配色 + emoji/ASCII 符号）
   - openGridPicker(opts)           弹出 Grid 窗口 → Promise<value|null>
   - class GridSelect               替换 <select> 的通用控件（.el 是触发按钮）
   - loadAssetOptions(kind, opts)   素材型选项的异步多线程加载（带缓存，一次性返回）
   - streamAssetOptions(kind, opts) 素材型选项的流式加载（约 20 条一批，边加载边显示）
   - assetGroupSpec()               素材选项的分包规格（内置/外导入 · 按关卡）
   - builtinOpt(x)                  内置枚举（贴图 / 天空）转成可分包的选项

   Cell 点击即选中并自动关闭；列表数据全部异步 / 分片渲染，不阻塞主线程。
   传 group 时切换成「分包文件夹卡片」浏览（ui/folder-grid.js）。
   loader 带 .stream 标记时走流式：每批到达立即上屏（见 streamAssetOptions）。
   ============================================================ */
import { el, clear, modal } from './dom.js';
import { chunkedAppend, streamBatches } from './render-queue.js';
import { skeletonCards, statusLine } from './skeleton.js';
import { renderFolderGrid } from './folder-grid.js';
import { store } from '../core/storage.js';
import { runListTask } from '../core/list-tasks.js';
import {
  listBuiltinRecords, builtinThumbURL, loadBuiltinManifest,
} from '../core/builtin-assets.js';
import { resolveAssetURL } from '../core/settings.js';

/* ============================================================
   占位图标：精选配色 + 现成 emoji / ASCII 符号（缺省取首字符）
   ============================================================ */
function hashInt(s) {
  let h = 0;
  const t = String(s == null ? '' : s);
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return h;
}

/* 梦核色调：青 / 品红 / 金 / 紫 / 绿 / 橙 / 蓝 / 紫罗兰 */
const ICON_PALETTE = [
  ['#6fd6f5', '#2c6f8f'],
  ['#ff8fd6', '#8c2f6d'],
  ['#ffd98a', '#9a6a1e'],
  ['#a99bff', '#4a3d94'],
  ['#7dffb0', '#1f6b45'],
  ['#ff9f7d', '#8f4526'],
  ['#8ad4ff', '#2b5f8c'],
  ['#e39bff', '#5f2b8c'],
];

/** 由文本哈希出稳定配色（渐变） */
function gradientFor(t) {
  const [a, b] = ICON_PALETTE[hashInt(t) % ICON_PALETTE.length];
  return `linear-gradient(135deg,${a},${b})`;
}

/* 关键字 → 现成 emoji / ASCII 符号；命中即用，否则退回首字符 */
const ICON_GLYPHS = [
  [/(音|声|music|sound|bgm|sfx|audio)/i, '♪'],
  [/(贴图|材质|texture|tex|material)/i, '▦'],
  [/(模型|网格|model|mesh)/i, '◆'],
  [/(天空|全景|环境|sky|panorama)/i, '☁'],
  [/(水|洪|water|flood|pool)/i, '≈'],
  [/(门|闸|door|gate)/i, '▯'],
  [/(按钮|开关|button|btn|switch)/i, '◉'],
  [/(方块|砖|block|brick|cube)/i, '▣'],
  [/(终点|目标|旗|goal|finish|flag)/i, '⚑'],
  [/(玩家|角色|人物|player|character|npc)/i, '☺'],
  [/(箭头|方向|arrow|dir)/i, '➤'],
  [/(星|star)/i, '★'],
  [/(心|血|生命|heart|health|hp)/i, '♥'],
  [/(锁|lock)/i, '▤'],
  [/(钥匙|key)/i, '⚿'],
  [/(时间|计时|timer|time|秒)/i, '◷'],
  [/(光|灯|light|lamp)/i, '☀'],
  [/(火|焰|fire|flame)/i, '♨'],
  [/(雪|冰|snow|ice)/i, '❄'],
  [/(雷|电|thunder|lightning)/i, '⚡'],
  [/(云|雾|fog|cloud)/i, '☁'],
];

function glyphFor(t) {
  for (const [re, g] of ICON_GLYPHS) if (re.test(t)) return g;
  return '';
}

/**
 * 方形占位图标
 * @param {string} text  取现成符号或首字符做图标
 * @param {{sym?:string, color?:string}} [opts]
 */
export function placeholderIcon(text, opts = {}) {
  const t = String(text == null ? '' : text).trim();
  const sym = opts.sym || glyphFor(t) || t.slice(0, 1) || '?';
  const bg = opts.color || gradientFor(t);
  return el('span', { class: 'gp-ico sym', style: { background: bg }, text: sym });
}

/** 由 icon 描述生成图标节点；缺省用占位图标 */
function iconNode(icon, label) {
  if (icon && icon.type === 'img' && icon.src) {
    return el('img', { class: 'gp-ico', src: icon.src, alt: '', loading: 'lazy' });
  }
  if (icon && icon.type === 'sym') return placeholderIcon(icon.text || label, { sym: icon.text, color: icon.color });
  if (icon && icon.sym) return placeholderIcon(label, { sym: icon.sym, color: icon.color });
  return placeholderIcon(label);
}

/* ============================================================
   弹出 Grid 窗口
   ============================================================ */
/**
 * openGridPicker({ title, items?, load?, columns?, value, search?, emptyText?, onLoad?, group? })
 *   items: [{ v, l, id?, icon? }]；icon = {type:'img',src} | {type:'sym',text,color} | 省略
 *   load : async () => items，优先于 items；也支持流式 async (emit) => {}
 *          带 .stream 标记的 loader 会边加载边显示：每批 emit(batch) 立即上屏
 *   group: {
 *     modes:    [{k,l}]                    分包模式切换按钮（>=2 个时才显示工具条）
 *     initial:  string                     初始模式（缺省第一个）
 *     groupOf:  (item, mode) => {key,label,hint}|arr|null
 *     rootLabel:(mode) => string           面包屑根的名字
 *     whenReady?: () => Promise            「按关卡」等需要后台统计的模式用
 *     isReady?:   () => boolean
 *   }
 * @returns Promise<value|null>
 */
export function openGridPicker(opts = {}) {
  // 每次打开都重新异步拉取一遍素材选项：导入新素材 / 换缩略图后，图标能自动跟上
  invalidateAssetOptions();
  const group = opts.group || null;
  const modes = (group && Array.isArray(group.modes) && group.modes.length) ? group.modes : null;
  const state = {
    items: null, loaded: false, query: '',
    mode: (group && group.initial) || (modes ? modes[0].k : 'flat'),
    drill: null, drillLabel: '',
    streaming: false, _painted: false,
  };
  let ctxRef = null;
  let grid = null;
  let toolBar = null;
  let searchInp = null;

  /** 当前模式是否需要分包浏览 */
  const grouping = () => !!(group && group.groupOf && state.mode !== 'flat');

  /** 建一个候选项卡片 */
  const makeCell = (it, cur) => {
    const b = el('button', {
      class: 'gp-cell' + (String(it.v) === String(cur) ? ' on' : ''),
      type: 'button',
      title: it.id ? it.l + ' · ' + it.id : String(it.l || ''),
      onclick: () => { if (ctxRef) ctxRef.close(it.v); },
    });
    b.appendChild(iconNode(it.icon, it.l));
    b.appendChild(el('span', { class: 'gp-nm', text: String(it.l == null ? it.v : it.l) }));
    if (it.id) b.appendChild(el('span', { class: 'gp-id', text: it.id }));
    return b;
  };

  const render = () => {
    if (!grid) return;
    const q = state.query.trim().toLowerCase();
    const all = state.items || [];
    const list = q
      ? all.filter((it) => (String(it.l || '') + ' ' + String(it.id || '')).toLowerCase().includes(q))
      : all;

    /* 需要后台统计的分包模式：先给骨架 + 状态行，统计完再重画 */
    if (grouping() && group.isReady && !group.isReady()) {
      clear(grid);
      grid.classList.add('fg-pending');
      grid.appendChild(skeletonCards(8, 'fg-card skel'));
      statusLine(grid, '正在统计各关卡用到的素材…');
      if (group.whenReady) {
        group.whenReady().then(() => { if (grid.isConnected) render(); }).catch(() => {});
      }
      return;
    }
    grid.classList.remove('fg-pending');

    if (grouping()) {
      let drillCount = 0;
      if (state.drill) {
        for (const it of list) {
          const g = group.groupOf(it, state.mode);
          const arr = Array.isArray(g) ? g : [g];
          if (arr.some((x) => x && x.key === state.drill)) drillCount++;
        }
      }
      renderFolderGrid(grid, {
        items: list,
        groupOf: (it) => group.groupOf(it, state.mode),
        groups: group.groups ? group.groups(state.mode) : null,
        sort: opts.sort,
        drill: state.drill,
        drillLabel: state.drillLabel,
        drillCount,
        rootLabel: (group.rootLabel && group.rootLabel(state.mode)) || '全部分包',
        emptyText: opts.emptyText || '（无可选项）',
        iconOf: (it) => it.icon,
        labelOf: (it) => (it.l == null ? it.v : it.l),
        subOf: (it) => it.id || '',
        isActive: (it) => String(it.v) === String(opts.value),
        onOpenGroup: (key, label) => { state.drill = key; state.drillLabel = label; render(); },
        onBack: () => { state.drill = null; state.drillLabel = ''; render(); },
        onPick: (it) => { if (ctxRef) ctxRef.close(it.v); },
      });
      return;
    }

    clear(grid);
    state._painted = false;
    if (!list.length) {
      grid.appendChild(el('div', { class: 'gp-empty', text: state.loaded ? (opts.emptyText || '（无可选项）') : '加载中…' }));
      return;
    }
    const cur = opts.value;
    if (state.streaming) {
      // 流式加载中：同步补齐（后续批次按到达顺序继续往后追加，顺序天然一致）
      for (const it of list) grid.appendChild(makeCell(it, cur));
    } else {
      chunkedAppend(grid, list, (it) => makeCell(it, cur), { firstBatch: 24, perFrame: 12 });
    }
    state._painted = true;
  };

  const applyItems = (items) => {
    state.items = Array.isArray(items) ? items : [];
    state.loaded = true;
    render();
    if (opts.onLoad) opts.onLoad(state.items);
  };

  /** 流式加载：每批到达立即上屏（flat 无搜索时增量追加；搜索 / 分包模式整体重画） */
  const startStream = (loader) => {
    state.items = [];
    state.streaming = true;
    state._painted = false;
    state.loaded = false;
    grid.appendChild(skeletonCards(12, 'gp-cell skel'));

    const emit = (batch) => {
      if (!grid || !grid.isConnected) return;
      const arr = Array.isArray(batch) ? batch : [];
      if (!arr.length) return;
      for (const it of arr) state.items.push(it);
      if (state.query.trim() || grouping()) { render(); return; }
      if (!state._painted) clear(grid);
      const cur = opts.value;
      for (const it of arr) grid.appendChild(makeCell(it, cur));
      state._painted = true;
    };

    Promise.resolve()
      .then(() => loader(emit))
      .then(() => {
        state.streaming = false;
        state.loaded = true;
        if (grid && grid.isConnected) {
          if (state.query.trim() || grouping()) render();
          else if (!state._painted) {
            clear(grid);
            grid.appendChild(el('div', { class: 'gp-empty', text: opts.emptyText || '（无可选项）' }));
          }
        }
        if (opts.onLoad) opts.onLoad(state.items);
      })
      .catch((e) => {
        console.warn('[grid-picker] 流式加载失败', e);
        state.streaming = false;
        state.loaded = true;
        if (grid && grid.isConnected) render();
        if (opts.onLoad) opts.onLoad(state.items);
      });
  };

  /** 分包模式切换（工具条） */
  const paintModes = () => {
    if (!toolBar) return;
    for (const b of toolBar.querySelectorAll('[data-gmode]')) b.classList.toggle('on', b.dataset.gmode === state.mode);
  };

  return modal({
    title: opts.title || '选择',
    cls: 'wide',
    buttons: [{ label: '取消', value: null }],
    escValue: null,
    body: (ctx) => {
      ctxRef = ctx;
      const wrap = el('div', { class: 'gp-modal' });

      const hasSearch = opts.search !== false;
      if (modes && hasSearch) {
        const row = el('div', { class: 'gp-tools' });
        toolBar = el('div', { class: 'gp-modes' });
        for (const m of modes) {
          toolBar.appendChild(el('button', {
            class: 'pf-seg', type: 'button', text: m.l, dataset: { gmode: m.k },
            onclick: () => {
              if (state.mode === m.k) return;
              state.mode = m.k;
              state.drill = null; state.drillLabel = '';
              paintModes();
              render();
            },
          }));
        }
        paintModes();
        row.appendChild(toolBar);
        searchInp = el('input', { class: 'gp-search inp', type: 'search', placeholder: '搜索…' });
        searchInp.addEventListener('input', () => { state.query = searchInp.value; render(); });
        row.appendChild(searchInp);
        wrap.appendChild(row);
      } else if (hasSearch) {
        searchInp = el('input', { class: 'gp-search inp', type: 'search', placeholder: '搜索…' });
        searchInp.addEventListener('input', () => { state.query = searchInp.value; render(); });
        wrap.appendChild(searchInp);
      }

      grid = el('div', { class: 'gp-grid' + (group ? ' gp-groupable' : '') });
      wrap.appendChild(grid);

      if (state.items) { state.loaded = true; render(); }
      else if (typeof opts.load === 'function' && opts.load.stream) {
        startStream(opts.load);
      } else {
        grid.appendChild(skeletonCards(12, 'gp-cell skel'));
        const loader = typeof opts.load === 'function' ? opts.load : async () => (opts.items || []);
        Promise.resolve().then(loader).then(applyItems).catch(() => applyItems([]));
      }
      return wrap;
    },
  });
}

/* ============================================================
   GridSelect：替换原生 <select> 的控件
   ============================================================ */
export class GridSelect {
  /**
   * @param {{value?:any, onChange?:(v:any)=>void, placeholder?:string, cls?:string,
   *          mixed?:boolean, title?:string, group?:object}} [opts]
   *   group：分包规格（见 openGridPicker），传了就多出「分包模式」工具条
   */
  constructor(opts = {}) {
    this.value = opts.value === undefined ? '' : opts.value;
    this.onChange = opts.onChange || null;
    this.placeholder = opts.placeholder || '（未选择）';
    this.title = opts.title || '';
    this.mixed = !!opts.mixed;
    this.group = opts.group || null;
    this.disabled = false;
    this._items = null;      // 已解析的选项（可能为 null = 尚未加载）
    this._loader = null;     // 异步 loader

    this.el = el('button', {
      class: 'gsel' + (opts.cls ? ' ' + opts.cls : ''),
      type: 'button',
    });
    this.el.addEventListener('click', () => this.open());
    this._paint();
    // 有 loader 时后台预热一次，用于显示当前值的名称 / 图标
    if (typeof opts.options === 'function') this.setOptions(opts.options);
    else if (Array.isArray(opts.options)) this.setOptions(opts.options);
  }

  /* ---------- 数据 ---------- */
  /** 传数组（同步枚举）或 async loader（素材 / 关卡） */
  setOptions(itemsOrLoader) {
    if (typeof itemsOrLoader === 'function') {
      this._loader = itemsOrLoader;
      this._items = null;
      // 流式 loader 用 emit 收集，同样能得到完整列表（供显示当前值名称 / 图标）
      const run = itemsOrLoader.stream
        ? () => {
          const acc = [];
          return Promise.resolve(itemsOrLoader((batch) => { for (const it of (batch || [])) acc.push(it); })).then(() => acc);
        }
        : () => Promise.resolve(itemsOrLoader());
      this._ready = run().then((items) => {
        this._items = Array.isArray(items) ? items : [];
        this._paint();
        return this._items;
      }).catch(() => { this._items = []; return this._items; });
    } else {
      this._loader = null;
      this._items = Array.isArray(itemsOrLoader) ? itemsOrLoader : [];
      this._paint();
    }
    return this;
  }

  _find(v) {
    if (!this._items) return null;
    return this._items.find((x) => String(x.v) === String(v)) || null;
  }

  /** 选项加载完成（返回完整选项数组），供调用方在加载完后做「取首个 / 校正当前值」 */
  ready() { return this._ready || Promise.resolve(this._items || []); }

  /* ---------- 值 ---------- */
  setValue(v) {
    this.value = v === undefined ? '' : v;
    this.mixed = false;
    this._paint();
    return this;
  }

  setMixed(bool) {
    this.mixed = !!bool;
    this._paint();
    return this;
  }

  setDisabled(bool) {
    this.disabled = !!bool;
    this.el.disabled = this.disabled;
    this.el.classList.toggle('dis', this.disabled);
    return this;
  }

  /* ---------- 触发按钮外观 ---------- */
  _paint() {
    const b = this.el;
    clear(b);
    let item = null;
    let label;
    if (this.mixed) label = '（混合）';
    else if (this.value === '' || this.value === null || this.value === undefined) label = this.placeholder;
    else {
      item = this._find(this.value);
      label = item ? String(item.l == null ? item.v : item.l) : String(this.value);
    }
    b.title = this.title || label;
    const empty = this.value === '' || this.value === null || this.value === undefined;
    if (this.mixed) {
      b.appendChild(el('span', { class: 'gp-ico sym', style: { background: 'var(--line2)' }, text: '–' }));
    } else if (!empty) {
      // 选项未加载完时先用占位图标，加载完再换成真图标
      b.appendChild(iconNode(item && item.icon, label));
    }
    b.appendChild(el('span', { class: 'gsel-nm', text: label }));
    if (item && item.id) b.appendChild(el('span', { class: 'gsel-id', text: item.id }));
    b.classList.toggle('empty', !this.mixed && (this.value === '' || this.value == null));
    b.classList.toggle('mixed', this.mixed);
  }

  /* ---------- 打开弹窗 ---------- */
  async open() {
    if (this.disabled) return;
    const load = this._loader
      ? this._loader
      : async () => this._items || [];
    const v = await openGridPicker({
      title: this.title || '选择',
      load,
      value: this.value,
      group: this.group,
    });
    if (v === null || v === undefined) return;
    this.value = v;
    this.mixed = false;
    this._paint();
    if (this.onChange) this.onChange(v);
  }
}

/* ============================================================
   素材选项的异步加载（Worker 池 + 缓存）
   ============================================================ */
const _assetCache = new Map();

/* ---------- 分包元数据 ----------
   内置枚举（BUILTIN_TEXTURES / BUILTIN_SKIES）用 builtinOpt() 打上 builtin:true；
   导入的素材带 builtin:false + level（所属关卡），被哪些关卡引用（refs）由后台统计补。 */
const _refsMap = new Map();      // 素材 id → 引用它的关卡 id 列表
const _levelNames = new Map();   // 关卡 id → 关卡名
let _refsTask = null;
let _refsReady = false;

/** 「被哪些关卡引用」统计完了吗 */
export function assetRefsReady() { return _refsReady; }

/**
 * 统计各关卡用到的素材（后台 Worker；只跑一次，结果缓存）。
 * server 模式直接把关卡 store 的原始 JSON 文本交给 Worker，连 JSON.parse 都不在主线程。
 */
export function ensureAssetRefs() {
  if (_refsTask) return _refsTask;
  _refsTask = (async () => {
    try {
      const text = await store.listLevelsText();
      const payload = text != null
        ? { levelsText: text }
        : { levels: ((await store.listLevels()) || [])
          .filter((r) => r && r.id)
          .map((r) => ({ id: r.id, name: r.name || '', data: r.data })) };
      const res = await runListTask('assetRefs', payload);
      const refs = (res && res.refs) || {};
      const names = (res && res.names) || {};
      for (const k in names) _levelNames.set(k, names[k]);
      for (const k in refs) _refsMap.set(k, refs[k]);
      // 补进已经建好的选项（弹窗可能还开着，补完直接重画即可）
      for (const [, list] of _assetCache) {
        for (const it of list) if (it && it.id) it.refs = _refsMap.get(it.id) || [];
      }
    } catch (e) {
      console.warn('[grid-picker] 素材引用统计失败', e);
    }
    _refsReady = true;
    return true;
  })();
  return _refsTask;
}

/** 素材选项的分包规格：内置 vs 外导入 / 按关卡（只要该关卡用到某素材，就出现在它的分包里） */
export function assetGroupSpec() {
  const SRC = [
    { key: 'none', label: '不使用' },
    { key: 'builtin', label: '内置素材' },
    { key: 'extended', label: '扩充内置素材' },
    { key: 'imported', label: '外导入素材' },
    { key: 'missing', label: '已丢失的引用' },
  ];
  const labelOf = (k) => (SRC.find((x) => x.key === k) || {}).label || k;
  return {
    modes: [
      { k: 'flat', l: '全部' },
      { k: 'src', l: '内置/外导入' },
      { k: 'level', l: '按关卡' },
    ],
    initial: 'flat',
    isReady: assetRefsReady,
    whenReady: ensureAssetRefs,
    rootLabel: (mode) => (mode === 'src' ? '内置 / 外导入' : '按关卡分包'),
    groupOf: (it, mode) => {
      const special = it.g || (it.builtin ? 'builtin' : '');
      if (mode === 'src') {
        const k = special || 'imported';
        return { key: k, label: labelOf(k) };
      }
      if (mode === 'level') {
        if (special) return { key: special, label: labelOf(special) };
        const own = it.level || '';
        const ids = (it.refs && it.refs.length) ? it.refs.slice() : (own ? [own] : []);
        if (!ids.length) return { key: '__unused__', label: '未被任何关卡引用' };
        // 一个素材可能被多个关卡用到 → 每个关卡的分包里都放一份
        return ids.map((id, i) => ({
          key: id,
          label: _levelNames.get(id) || (id === own ? '当前关卡素材' : id),
          hint: (i === 0 && ids.length > 1) ? '共 ' + ids.length + ' 关' : '',
        }));
      }
      return null;
    },
    /** 只在这些模式用预置顺序（不使用 → 内置 → 外导入 → 丢失），其余按排序键排 */
    groups: (mode) => (mode === 'src' ? SRC : null),
  };
}

/** 内置枚举（贴图 / 天空）→ 可分包的 Grid 选项 */
export function builtinOpt(x) {
  const v = x.id !== undefined ? x.id : x.v;
  const l = x.label !== undefined ? x.label : x.l;
  return { v, l, builtin: true };
}

/**
 * 素材选项的公共构建：分 20 条一批，批内并行解析缩略图；带 emit 时逐批回调。
 * @param {string} [kind]
 * @param {{thumbs?:boolean, refresh?:boolean, ext?:('tex'|'sky'|'all'|false),
 *          filter?:(a:any)=>boolean}} [opts]
 * @param {((batch:any[])=>void)|null} [emit]
 */
async function buildAssetBase(kind, opts, emit) {
  const key = String(kind || '*');
  const pass = (b) => (opts.filter ? b.filter(opts.filter) : b);
  // 扩充内置素材（.flooding_dreams/assets）是否混入：默认贴图类选择器带上，其余不带
  const ext = opts.ext !== undefined ? opts.ext : (kind === 'texture' ? 'tex' : false);
  const extCacheKey = ext ? key + '#ext:' + ext : key;
  const cached = (!opts.refresh && _assetCache.get(extCacheKey)) || null;
  if (cached) {
    if (emit) await streamBatches(cached, { batchSize: 20, onBatch: (b) => emit(pass(b)) });
    return cached;
  }
  const recs = await store.listAssets(null);             // 全部素材
  const slim = recs.map((r) => ({ id: r.id, name: r.name, kind: r.kind, created: r.created, mime: r.mime, level: r.level }));
  const res = await runListTask('assetList', { recs: slim });
  let list = res.items || [];
  if (kind) list = list.filter((x) => x.kind === kind);
  const wantThumb = opts.thumbs !== undefined ? opts.thumbs : (kind === 'texture');
  const base = [];
  await streamBatches(list, {
    batchSize: 20,
    process: async (slice) => Promise.all(slice.map(async (a) => {
      let icon = null;
      if (wantThumb) {
        try {
          const src = await resolveAssetURL(a.id);
          if (src) icon = { type: 'img', src };
        } catch (e) { /* 缩略图失败则退回占位图标 */ }
      }
      return {
        v: 'asset:' + a.id, l: a.name || a.id, id: a.id, icon,
        builtin: false, level: a.level || '',
        refs: _refsMap.has(a.id) ? _refsMap.get(a.id) : null,
      };
    })),
    onBatch: (b) => { for (const o of b) base.push(o); if (emit) emit(pass(b)); },
  });
  if (ext) {
    try {
      await loadBuiltinManifest();
      const want = ext === 'all' ? null : ext;      // 'tex' 只要贴图，'sky' 只要 .hdr 全景
      const eo = listBuiltinRecords(want).map((r) => ({
        v: 'asset:' + r.id, l: r.label || r.name, id: r.id,
        icon: (() => { const u = builtinThumbURL(r.id); return u ? { type: 'img', src: u } : null; })(),
        builtin: false, ext: true, g: 'extended', level: '',
        refs: _refsMap.has(r.id) ? _refsMap.get(r.id) : null,
      }));
      for (const o of eo) base.push(o);
      if (emit && eo.length) emit(pass(eo));
    } catch (e) { console.warn('[grid-picker] 扩充内置素材清单读取失败', e); }
  }
  _assetCache.set(extCacheKey, base);
  return base;
}

/**
 * 读取素材列表并转成 Grid 选项（一次性拿全量）。
 * @param {string} [kind]        'texture' | 'audio' | 'model' …（空 = 全部）
 * @param {{filter?:(a:any)=>boolean, thumbs?:boolean, refresh?:boolean,
 *          ext?:('tex'|'sky'|'all'|false)}} [opts]
 * @returns Promise<Array<{v,l,id,icon,builtin,level,refs}>>
 */
export async function loadAssetOptions(kind, opts = {}) {
  const base = await buildAssetBase(kind, opts, null);
  return opts.filter ? base.filter(opts.filter) : base;
}

/**
 * 生成「流式素材选项 loader」：先发 head（内置 / 无 / 等固定项），
 * 再按 20 条一批把素材陆续 emit，最后按 missing 补一项（如「已丢失」）。
 * 返回的函数带 .stream 标记，可直接当 openGridPicker / GridSelect 的 load。
 * @param {string} kind
 * @param {{head?:Array|(()=>Array), map?:(a:any)=>any, missing?:(all:any[])=>any|null,
 *          filter?:(a:any)=>boolean, thumbs?:boolean, refresh?:boolean,
 *          ext?:('tex'|'sky'|'all'|false)}} [opts]
 */
export function streamAssetOptions(kind, opts = {}) {
  const fn = async (emit) => {
    const head = (typeof opts.head === 'function' ? opts.head() : (opts.head || [])).slice();
    const all = [];
    if (head.length) { for (const h of head) all.push(h); emit(head); }
    await buildAssetBase(kind, { filter: opts.filter, thumbs: opts.thumbs, refresh: opts.refresh, ext: opts.ext }, (batch) => {
      const mapped = opts.map ? batch.map(opts.map) : batch;
      for (const o of mapped) all.push(o);
      emit(mapped);
    });
    if (opts.missing) {
      const m = opts.missing(all);
      if (m) emit(Array.isArray(m) ? m : [m]);
    }
  };
  fn.stream = true;
  return fn;
}

/** 素材增删后清缓存，下次打开重新读取 */
export function invalidateAssetOptions(kind) {
  if (kind === undefined) { _assetCache.clear(); return; }
  const p = String(kind || '*') + '#ext:';
  for (const k of [..._assetCache.keys()]) {
    if (k === String(kind || '*') || k.startsWith(p)) _assetCache.delete(k);
  }
}