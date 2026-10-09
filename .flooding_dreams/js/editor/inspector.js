/* ============================================================
   属性面板：按 objectTypes 的属性表自动生成控件
   （无选中时显示关卡信息 / 设置）
   ============================================================ */
import { el, clear, toast, confirmBox, promptBox } from '../ui/dom.js';
import {
  GROUPS, propsOf, typeDef, applyLiquidKind, applyLiquidStyle, applyLiquidPattern, applyAdvancedMaterial,
  BUILTIN_TEXTURES, EASINGS, TOOL_DEFS,
} from '../world/objectTypes.js';
import { levelSettingsDefs, getObject, objectLabel, collectTree, childrenOf } from '../world/level.js';
import { postfxToggleState } from '../core/postfx.js';
import { SOUNDS, BUILTIN_SKIES } from '../config.js';
import { openSkyLab } from './sky-lab.js';
import { openSkyModEditor } from './sky-modifier-editor.js';
import { openParticleEditor } from './particle-editor.js';
import {
  PORTAL_BLEND_OPTIONS, PORTAL_MAX_LAYERS, PORTAL_TILE_OPTIONS,
} from '../world/portal.js';
import { store } from '../core/storage.js';
import { resolveAssetURL } from '../core/settings.js';
import { loadHDRTexture, isHDRName, ensureTexture } from '../core/textures.js';
import { audio } from '../core/audio.js';
import { importAssetFile } from './asset-manager.js';
import { row, numInput, swtch, optSelect, swatchBar, listEditor, fmtNum, wheelStep, attachNumWheel, objectOptions, animOptions, eventOptions, MIXED_VALUE, markMixedSelect, objRefButton } from './widgets.js';
import { GridSelect, streamAssetOptions, invalidateAssetOptions, assetGroupSpec, builtinOpt } from '../ui/grid-picker.js';
import { resolveBuiltinPair, extendedDisplayLabel } from '../core/builtin-assets.js';

const EVENT_REF_KEYS = ['onTouch', 'onEnter', 'onExit', 'useEvent'];

/* 批量（多选）编辑：不支持批量改写的属性类型（列表 / 动作型，每人一份数据） */
const BATCH_SKIP_TYPES = new Set(['objlist', 'strlist', 'vec3list', 'vec2list', 'handles', 'layers', 'action', 'particles']);

/** 选中的天空盒若是导入的 .hdr 全景图，先异步解码进缓存再落地设置，避免背景空白 */
async function prepareSkyAsset(id) {
  const key = String(id || '');
  if (!key.startsWith('asset:')) return;
  try {
    const meta = await store.getAssetMeta(key.slice(6));
    if (meta && isHDRName(meta.name)) {
      const url = await resolveAssetURL(key.slice(6));
      if (url) await loadHDRTexture(key, url);
    }
  } catch (e) { /* 加载失败则回落到无天空 */ }
}

/** 合并多个类型下拉的选项（同名 value 只留一个，保持首次出现的顺序） */
function mergeOptions(sets) {
  const seen = new Set();
  const out = [];
  for (const set of sets) {
    for (const o of set) {
      const v = String(o.v);
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(o);
    }
  }
  return out;
}

export class Inspector {
  constructor(ed) {
    this.ed = ed;
    this.host = document.getElementById('props');
    this.title = document.getElementById('props-title');
    // 默认折叠的分组：PBR 贴图（粗糙度 / 法线）藏在「展开」里，需要时点开
    this.collapsed = new Set(['pbr']);
    this._assets = null;
  }

  /* ---------- 入口 ---------- */
  refresh() {
    const host = this.host;
    if (!host) return;
    // 面板整体重建会让滚动位置归零（改个属性滑条就跳回顶部），
    // 重建前后保存 / 恢复滚动位置
    const top = host.scrollTop;
    clear(host);
    const recs = this.ed.selectedRecs();
    if (!recs.length) this.renderLevel();
    else if (recs.length === 1) this.renderObject(recs[0]);
    else this.renderMulti(recs);
    host.scrollTop = top;
  }

  /* ---------- 分组 ---------- */
  group(parent, name, forceOpen) {
    const key = name || '其它';
    const closed = !forceOpen && this.collapsed.has(key);
    const wrap = el('div', { class: 'pgroup' });
    const head = el('div', { class: 'pg-head' + (closed ? ' closed' : '') },
      el('span', { class: 'caret', text: '▾' }),
      el('span', { text: GROUPS[key] || key }));
    const body = el('div', { class: 'pg-body' + (closed ? ' hide' : '') });
    head.addEventListener('click', () => {
      const c = this.collapsed.has(key);
      if (c) this.collapsed.delete(key); else this.collapsed.add(key);
      head.classList.toggle('closed', !c);
      body.classList.toggle('hide', !c);
    });
    wrap.appendChild(head);
    wrap.appendChild(body);
    parent.appendChild(wrap);
    return body;
  }

  /* ---------- 通用控件 ---------- */
  /**
   * def: 属性定义；get/set 读写数据
   * opts: { after: fn, label: 撤销标签 }
   */
  field(parent, def, get, set, opts = {}) {
    const ed = this.ed;
    const label = opts.label || def.l || def.k;
    // opts.toggle：把「启用」方框放进标签里（后处理对象逐项开关用）
    const labelEl = opts.toggle
      ? el('span', { class: 'tog-lab' }, opts.toggle, el('span', { text: label }))
      : label;
    const t = def.t;
    /* 批量（多选）编辑：opts.multi 时 get() 取首个选中对象的值，opts.values() 拿到全部值；
       各对象取值不一致的项显示为「混合」，避免把首个对象的值冒充成所有人的值 */
    const multi = !!opts.multi;
    const sameNow = (pick) => {
      if (!multi || !opts.values) return true;
      const vs = opts.values();
      if (!vs || vs.length < 2) return true;
      const k = (x) => JSON.stringify(pick ? pick(x) : x);
      const a = k(vs[0]);
      for (let i = 1; i < vs.length; i++) if (k(vs[i]) !== a) return false;
      return true;
    };
    const mixedNow = () => multi && !sameNow();
    let prev = null;
    const liveSet = (v) => {
      if (prev === null) prev = ed.snap();
      set(v);
      if (opts.after) opts.after(v);
    };
    const endLive = () => {
      if (prev === null) return;
      ed.record(label, prev);
      prev = null;
    };
    const commit = (v) => {
      const p = ed.snap();
      set(v);
      if (opts.after) opts.after(v);
      ed.record(label, p);
    };

    /* --- 布尔 --- */
    if (t === 'bool') {
      const sw = swtch(!!get(), (v) => { sw.classList.remove('mixed'); commit(v); });
      if (mixedNow()) { sw.classList.add('mixed'); sw.title = '所选对象取值不一致：点击即统一设置'; }
      parent.appendChild(row(labelEl, sw));
      return;
    }

    /* --- 颜色 --- */
    if (t === 'color') {
      const inp = el('input', { type: 'color', value: get() || '#ffffff' });
      if (mixedNow()) { inp.classList.add('mixed'); inp.title = '所选对象颜色不一致'; }
      inp.addEventListener('input', () => { inp.classList.remove('mixed'); liveSet(inp.value); });
      inp.addEventListener('change', endLive);
      const block = el('div', {}, row(labelEl, inp));
      const val = get() || '#ffffff';
      block.appendChild(swatchBar(val, (c) => { commit(c); inp.value = c; }));
      parent.appendChild(block);
      return;
    }

    /* --- 向量 --- */
    if (t === 'vec3') {
      const v = get() || [0, 0, 0];
      const wrap = el('div', { class: 'vecrow' }, el('label', { text: label, title: def.h || '' }));
      const box = el('div', { class: 'vs' });
      ['X', 'Y', 'Z'].forEach((axis, i) => {
        const w = el('div', { class: 'vw' });
        // 该轴在各对象上取值不一致 → 留空显示「混合」，改动时只写这一轴（不覆盖别的轴）
        const axMixed = multi && !sameNow((x) => (x ? x[i] : null));
        const inp = el('input', {
          type: 'number', value: axMixed ? '' : fmtNum(v[i]), step: def.st ?? 0.5, title: axis,
          placeholder: axMixed ? '混合' : '', class: axMixed ? 'mixed' : '',
        });
        const setAxis = (val) => {
          if (multi && opts.setAxis) {
            if (prev === null) prev = ed.snap();
            opts.setAxis(i, val);
            if (opts.after) opts.after(val);
            return;
          }
          const arr = (get() || [0, 0, 0]).slice();
          arr[i] = val;
          liveSet(arr);
        };
        inp.addEventListener('input', () => {
          const n = Number(inp.value);
          if (inp.value === '' || !isFinite(n)) return;
          setAxis(n);
        });
        const done = () => {
          if (axMixed && inp.value === '') { endLive(); return; }
          inp.value = fmtNum((get() || [0, 0, 0])[i]);
          endLive();
        };
        inp.addEventListener('change', done);
        inp.addEventListener('blur', done);
        attachNumWheel(inp, {
          step: def.st ?? 0.5,
          onStep: (val) => { setAxis(val); inp.value = fmtNum(val); },
          onEnd: endLive,
        });
        w.appendChild(el('label', { text: axis }));
        w.appendChild(inp);
        box.appendChild(w);
      });
      wrap.appendChild(box);
      parent.appendChild(wrap);
      return;
    }

    /* --- 数值 --- */
    if (t === 'num' || t === 'int') {
      const st = def.st ?? (t === 'int' ? 1 : 0.1);
      const numMixed = mixedNow();
      const num = el('input', {
        type: 'number', value: numMixed ? '' : fmtNum(get()), step: st, min: def.min, max: def.max,
        placeholder: numMixed ? '混合' : '',
      });
      if (numMixed) { num.classList.add('mixed'); num.title = '所选对象取值不一致：输入即统一设置'; }
      const clamp = (v) => {
        if (!isFinite(v)) v = 0;
        if (def.min !== undefined) v = Math.max(def.min, v);
        if (def.max !== undefined) v = Math.min(def.max, v);
        return t === 'int' ? Math.round(v) : v;
      };
      // 输入过程中先按原样生效（可自由输入小数点），失焦 / 回车时再 clamp 并回写
      let dirty = false;
      num.addEventListener('input', () => {
        const v = Number(num.value);
        if (num.value === '' || !isFinite(v)) return;
        dirty = true;
        num.classList.remove('mixed');
        liveSet(t === 'int' ? Math.round(v) : v);
      });
      const apply = () => {
        const was = dirty;
        if (dirty) { dirty = false; liveSet(clamp(Number(num.value))); }
        // 批量且原本就是「混合」、用户又没改：保持空白，别把首个对象的值填进去
        if (was || !mixedNow()) num.value = fmtNum(get());
        else num.value = '';
        endLive();
      };
      num.addEventListener('change', apply);
      num.addEventListener('blur', apply);
      // Shift + 悬停滚轮微调（步进按量程分档，整数属性至少 1）
      const wst = t === 'int' ? Math.max(1, wheelStep(def.min, def.max, st)) : wheelStep(def.min, def.max, st);
      attachNumWheel(num, {
        min: def.min, max: def.max, step: wst,
        onStep: (v) => { dirty = false; liveSet(t === 'int' ? Math.round(v) : v); num.value = fmtNum(get()); },
        onEnd: endLive,
      });
      parent.appendChild(row(labelEl, num));
      return;
    }

    /* --- 下拉 --- */
    if (t === 'select') {
      const sel = optSelect(def.o || [], get(), (v) => commit(v));
      markMixedSelect(sel, mixedNow());
      parent.appendChild(row(labelEl, sel));
      return;
    }
    if (t === 'easing') {
      const sel = optSelect(EASINGS.map((v) => ({ v, l: v })), get(), (v) => commit(v));
      markMixedSelect(sel, mixedNow());
      parent.appendChild(row(labelEl, sel));
      return;
    }
    if (t === 'sound') {
      const sel = optSelect(Object.keys(SOUNDS).map((v) => ({ v, l: v })), get(), (v) => commit(v));
      markMixedSelect(sel, mixedNow());
      parent.appendChild(row(labelEl, sel));
      return;
    }
    if (t === 'tool') {
      const sel = optSelect([{ v: '', l: '（无）' }].concat(Object.entries(TOOL_DEFS).map(([v, x]) => ({ v, l: x.label }))), get(), (v) => commit(v));
      markMixedSelect(sel, mixedNow());
      parent.appendChild(row(labelEl, sel));
      return;
    }
    if (t === 'anim') {
      const sel = optSelect(animOptions(this.ed.level), get(), (v) => commit(v));
      markMixedSelect(sel, mixedNow());
      parent.appendChild(row(labelEl, sel));
      return;
    }

    /* --- 引用（事件 / 动画 / 对象） --- */
    if (t === 'ref') {
      // 事件 / 动画引用不是 Game Object → Grid 选择器；对象引用 → 对象引用器
      if (EVENT_REF_KEYS.includes(def.k)) {
        const sel = optSelect(eventOptions(this.ed.level), get(), (v) => commit(v));
        markMixedSelect(sel, mixedNow());
        parent.appendChild(row(labelEl, sel));
      } else {
        parent.appendChild(row(labelEl, objRefButton({ ed: this.ed, get, commit, allowEmpty: true })));
      }
      return;
    }

    /* --- 指定具体对象（可限定类型 of / 排除类型 not，如“指定某个工具对象”） --- */
    if (t === 'objref') {
      const ofList = def.of ? (Array.isArray(def.of) ? def.of : [def.of]) : null;
      const notList = def.not || null;
      const ok = (x) => {
        if (ofList && !ofList.includes(x.type)) return false;
        if (notList && notList.includes(x.type)) return false;
        return true;
      };
      const hint = ofList ? '需要选类型为「' + ofList.map((k) => typeDef(k).label).join(' / ') + '」的对象' : '';
      parent.appendChild(row(labelEl, objRefButton({
        ed: this.ed, get, commit, hint, allowEmpty: true,
        filter: (ofList || notList) ? ok : null,
      })));
      return;
    }

    /* --- 贴图 --- */
    if (t === 'tex') {
      // 内置贴图 + 导入的图片素材（异步 Worker 加载，带缩略图）
      const loader = streamAssetOptions('texture', {
        filter: (a) => !isHDRName(a.l),
        head: () => BUILTIN_TEXTURES.map((x) => builtinOpt(x)),
        map: (a) => ({ v: a.v, l: (a.ext ? '扩充：' : '图片：') + a.l, id: a.id, icon: a.icon, level: a.level, builtin: false, g: a.g, refs: a.refs }),
        missing: (all) => {
          const cur = get();
          // 引用的图片素材不在列表里（被删除 / 还没加载完）时给出占位，别让选择器静默回落成内置贴图
          if (cur && !all.some((x) => String(x.v) === String(cur))) {
            // 扩充内置的法线 / 粗糙度不会出现在列表里（列表只列颜色图）→ 按可读名字展示，不是「已丢失」
            const ext = extendedDisplayLabel(cur);
            if (ext) return { v: cur, l: ext, g: 'extended' };
            return { v: cur, l: '图片：' + cur + '（已丢失）', g: 'missing' };
          }
          return null;
        },
      });
      // 选中的素材贴图可能当前会话还没加载过：先确保加载进缓存再落地，否则材质拿不到图会变黑
      const sel = new GridSelect({ value: get(), options: loader, group: assetGroupSpec(), onChange: async (v) => { await ensureTexture(v); commit(v); } });
      if (mixedNow()) sel.setMixed(true);
      parent.appendChild(row(labelEl, sel,
        el('button', {
          class: 'mini', text: '＋图', title: '导入图片作为贴图',
          onclick: async () => {
            const rec = await this.importAsset('texture');
            if (!rec) return;
            invalidateAssetOptions('texture');
            sel.setOptions(loader);
            sel.setValue('asset:' + rec.id);
            commit(sel.value);
          },
        })));
      return;
    }

    /* --- 天空盒（内置天空 / 导入的全景图） --- */
    if (t === 'sky') {
      const loader = streamAssetOptions('texture', {
        ext: 'sky',
        head: () => [{ v: 'none', l: '无（纯色背景）', g: 'none' }].concat(BUILTIN_SKIES.map((x) => builtinOpt(x))),
        map: (a) => ({ v: a.v, l: (a.ext ? '扩充全景：' : '全景图：') + a.l, id: a.id, icon: a.icon, level: a.level, builtin: false, g: a.g, refs: a.refs }),
        missing: (all) => {
          const cur = get();
          if (cur && cur !== 'none' && !all.some((x) => String(x.v) === String(cur))) {
            return { v: cur, l: '全景图：' + cur + '（已丢失）', g: 'missing' };
          }
          return null;
        },
      });
      const sel = new GridSelect({
        value: get() || 'none',
        options: loader,
        group: assetGroupSpec(),
        onChange: async (v) => { await prepareSkyAsset(v); commit(v); },
      });
      if (mixedNow()) sel.setMixed(true);
      parent.appendChild(row(labelEl, sel,
        el('button', {
          class: 'mini', text: '工坊', title: '天空工坊：程序化生成 / 烘焙等距柱状全景图，可直接设为天空盒',
          onclick: () => openSkyLab(this.ed),
        }),
        el('button', {
          class: 'mini', text: '＋图', title: '导入全景图作为天空盒（2:1 等距柱状图，支持 .png / .jpg / .hdr）',
          onclick: async () => {
            const rec = await this.importAsset('texture');
            if (!rec) return;
            invalidateAssetOptions('texture');
            const v = 'asset:' + rec.id;
            sel.setOptions(loader);
            sel.setValue(v);
            await prepareSkyAsset(v);
            commit(v);
          },
        })));
      return;
    }

    /* --- 天空修饰器（弹出「修饰器列表」窗口，可加多个） --- */
    if (t === 'skymods') {
      const cur = get();
      const list = Array.isArray(cur) ? cur : [];
      const n = list.filter((m) => m && m.on !== false).length;
      parent.appendChild(row(labelEl,
        el('button', {
          class: 'mini', title: def.h || '打开天空修饰器列表',
          text: list.length ? ('编辑修饰器（' + n + '/' + list.length + '）') : '编辑修饰器…',
          onclick: () => openSkyModEditor(this.ed),
        }),
        list.length ? el('button', {
          class: 'mini danger', text: '清空', title: '移除全部天空修饰器',
          onclick: () => commit([]),
        }) : null));
      return;
    }

    /* --- 粒子条目（弹出「粒子编辑器」窗口，可加多条） --- */
    if (t === 'particles') {
      const cur = get();
      const list = Array.isArray(cur) ? cur : [];
      const n = list.filter((e) => e && e.on !== false).length;
      parent.appendChild(row(labelEl,
        el('button', {
          class: 'mini', title: def.h || '打开粒子编辑器',
          text: list.length ? ('编辑粒子（' + n + '/' + list.length + '）') : '编辑粒子…',
          onclick: () => openParticleEditor(this.ed, opts.obj),
        }),
        list.length ? el('button', {
          class: 'mini danger', text: '清空', title: '移除全部粒子条目',
          onclick: () => commit([]),
        }) : null));
      return;
    }

    /* --- 音频素材（BGM / 声效方块） --- */
    if (t === 'audio') {
      const loader = streamAssetOptions('audio', {
        thumbs: false,
        head: [{ v: '', l: '（无）', g: 'none' }],
        missing: (all) => {
          const cur = get();
          if (cur && !all.some((x) => String(x.v) === String(cur))) return { v: cur, l: cur + '（已丢失）', g: 'missing' };
          return null;
        },
      });
      const isBgm = def.k === 'bgm';
      let prev = null;                       // 试听句柄
      const stopPrev = () => {
        if (prev && prev.stop) { try { prev.stop(0.25); } catch (e) { /* ignore */ } }
        prev = null;
        if (isBgm) audio.stopMusic({ fade: 0.25 });
        syncTgl();
      };
      const previewing = () => {
        const ref = get();
        if (!ref) return false;
        if (isBgm) return audio.getMusicRef() === ref;
        return !!(prev && prev.playing);
      };
      let tgl = null;
      const syncTgl = () => { if (tgl) tgl.classList.toggle('on', previewing()); };
      const sel = new GridSelect({
        value: get(), options: loader, group: assetGroupSpec(),
        onChange: (v) => { stopPrev(); commit(v); },
      });
      if (mixedNow()) sel.setMixed(true);
      /* 试听：切换开关（播放 / 停止），替换掉原来只能播放的单向按钮 */
      tgl = swtch(false, (on) => {
        const ref = get();
        stopPrev();
        if (!on) return;
        if (!ref) { toast('先选一段音频', '', 1800); return; }
        audio.ensure();
        const vol = isBgm ? Number((this.ed.level.settings || {}).bgmVolume ?? 1) : 1;
        prev = isBgm
          ? audio.playMusic(ref, { volume: vol, fadeIn: 0.35, restart: true })
          : audio.playRef(ref, { volume: vol, dest: 'sfx' });
        if (!prev && !isBgm) toast('音频正在解码，稍后自动可听（或文件已失效）', '', 2400);
        syncTgl();
      });
      tgl.title = isBgm ? '播放 / 停止试听背景音乐' : '播放 / 停止试听';
      parent.appendChild(row(labelEl, tgl, sel,
        el('button', {
          class: 'mini', text: '＋音', title: '导入音频文件（mp3 / ogg / wav / m4a）',
          onclick: async () => {
            const rec = await this.importAsset('audio');
            if (!rec) return;
            invalidateAssetOptions('audio');
            sel.setOptions(loader);
            sel.setValue('asset:' + rec.id);
            commit(sel.value);
          },
        })));
      return;
    }

    /* --- 模型资源 --- */
    if (t === 'asset') {
      const loader = streamAssetOptions('model', {
        thumbs: false,
        // assetId 字段存裸素材 id（BARE_KEYS），素材选项默认给 'asset:<id>'，这里统一改回裸 id
        map: (a) => ({ ...a, v: a.id }),
        head: [{ v: '', l: '（无）', g: 'none' }],
        missing: (all) => {
          const cur = get();
          if (cur && !all.some((x) => String(x.v) === String(cur))) return { v: cur, l: cur + '（已丢失）', g: 'missing' };
          return null;
        },
      });
      const sel = new GridSelect({ value: get(), options: loader, group: assetGroupSpec(), onChange: (v) => commit(v) });
      if (mixedNow()) sel.setMixed(true);
      parent.appendChild(row(labelEl, sel, el('button', {
        class: 'mini', text: '＋模', title: '导入 .glb / .gltf / .obj 模型',
        onclick: async () => {
          const rec = await this.importAsset('model');
          if (!rec) return;
          invalidateAssetOptions('model');
          sel.setOptions(loader);
          sel.setValue(rec.id);
          commit(rec.id);
        },
      })));
      return;
    }

    /* --- 对象 ID 列表 --- */
    if (t === 'objlist') {
      const ed = this.ed;
      const items = get() || [];
      const box = listEditor(items,
        (id) => {
          const o = getObject(ed.level, id);
          return el('span', {
            style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: id,
            text: o ? objectLabel(o) + '（' + id + '）' : (id + '（已不存在）'),
          });
        },
        (arr) => commit(arr.slice()),
        null);
      /* 手动指定：输入对象名 / ID，或用“取所选”按钮把当前选中对象加进来 */
      const listId = 'objdl-' + (this._dlSeq = (this._dlSeq || 0) + 1);
      const dl = el('datalist', { id: listId });
      for (const o of (ed.level.objects || [])) {
        dl.appendChild(el('option', { value: o.id, label: objectLabel(o) + ' · ' + o.type }));
      }
      const inp = el('input', {
        class: 'inp sm', list: listId, style: { flex: '1', minWidth: '0' },
        placeholder: '对象名 / ID，回车添加',
      });
      const addById = (raw) => {
        const key = String(raw || '').trim();
        if (!key) return;
        const list = ed.level.objects || [];
        const o = list.find((x) => x.id === key)
          || list.find((x) => (x.name || '') === key)
          || list.find((x) => (x.name || '').toLowerCase() === key.toLowerCase());
        if (!o) { toast('找不到对象「' + key + '」', 'err', 2000); return; }
        if (items.includes(o.id)) { toast('已在列表中', '', 1600); return; }
        items.push(o.id);
        commit(items.slice());
        inp.value = '';
        ed.refreshProps();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.code === 'Enter') { e.preventDefault(); addById(inp.value); }
      });
      inp.addEventListener('change', () => { if (inp.value.trim()) addById(inp.value); });
      const line = el('div', { class: 'addline' }, inp,
        el('button', { class: 'mini', text: '＋', title: '添加该对象', onclick: () => addById(inp.value) }),
        el('button', {
          class: 'mini', text: '取所选', title: '把当前选中的对象全部加进来',
          onclick: () => {
            let n = 0;
            for (const id of ed.selection) { if (!items.includes(id)) { items.push(id); n++; } }
            if (!n) { toast('请先在视口 / 对象树里选中要添加的对象', '', 1800); return; }
            commit(items.slice());
            ed.refreshProps();
          },
        }));
      box.appendChild(dl);
      box.appendChild(line);
      parent.appendChild(row(labelEl, box));
      return;
    }

    /* --- 字符串列表（def.o 存在时用下拉选择，如「段模式」的直线/曲线） --- */
    if (t === 'strlist') {
      const items = get() || [];
      const choices = def.o || null;
      const box = listEditor(items,
        (s, i) => {
          if (choices) {
            return optSelect(choices, s, (v) => { items[i] = v; commit(items.slice()); });
          }
          const inp = el('input', { value: s, style: { flex: '1', minWidth: '0', background: 'transparent', border: 'none', outline: 'none', font: 'inherit' } });
          inp.addEventListener('change', () => { items[i] = inp.value; commit(items.slice()); });
          return inp;
        },
        (arr) => commit(arr.slice()),
        (arr) => arr.push(choices ? choices[0].v : 'tag' + (arr.length + 1)));
      parent.appendChild(row(labelEl, box));
      return;
    }

    /* --- 坐标点列表（滑索路径） --- */
    if (t === 'vec3list') {
      const items = get() || [];
      const box = listEditor(items,
        (p, i) => {
          const wrap = el('div', { style: { display: 'flex', gap: '3px', flex: '1' } });
          ['x', 'y', 'z'].forEach((ax, k) => {
            const inp = el('input', {
              type: 'number', value: fmtNum(p[k]), step: 1,
              style: { width: '100%', background: 'rgba(0,0,0,.3)', border: '1px solid var(--line2)', borderRadius: '4px', font: 'inherit', padding: '1px 3px' },
            });
            inp.addEventListener('change', () => { items[i][k] = Number(inp.value) || 0; commit(items); });
            wrap.appendChild(inp);
          });
          return wrap;
        },
        (arr) => commit(arr.slice()),
        (arr) => {
          const recs = this.ed.selectedRecs();
          const p = recs.length ? (recs[0].o.position || [0, 0, 0]).slice() : [0, 0, 0];
          arr.push([Math.round(p[0]), Math.round(p[1]), Math.round(p[2])]);
        });
      parent.appendChild(row(labelEl, box));
      return;
    }

    /* --- 二维坐标点列表（管道自定义截面） --- */
    if (t === 'vec2list') {
      const items = get() || [];
      const box = listEditor(items,
        (p, i) => {
          const wrap = el('div', { style: { display: 'flex', gap: '3px', flex: '1' } });
          ['x', 'y'].forEach((ax, k) => {
            const inp = el('input', {
              type: 'number', value: fmtNum(p[k]), step: 0.1,
              style: { width: '100%', background: 'rgba(0,0,0,.3)', border: '1px solid var(--line2)', borderRadius: '4px', font: 'inherit', padding: '1px 3px' },
            });
            inp.addEventListener('change', () => { items[i][k] = Number(inp.value) || 0; commit(items); });
            wrap.appendChild(inp);
          });
          return wrap;
        },
        (arr) => commit(arr.slice()),
        (arr) => arr.push([1, 1]));
      parent.appendChild(row(labelEl, box));
      return;
    }

    /* --- 视差图层列表（平行视差传送门）：每层一张卡片 --- */
    if (t === 'layers') {
      const items = get() || [];
      const box = listEditor(items,
        (L, i) => {
          const card = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', flex: '1', minWidth: '0' } });

          // 贴图选择 + 导入（异步 Worker 加载）
          const texRow = el('div', { style: { display: 'flex', gap: '3px' } });
          const texLoader = streamAssetOptions('texture', {
            filter: (a) => !isHDRName(a.l),
            head: () => BUILTIN_TEXTURES.map((x) => builtinOpt(x)),
            map: (a) => ({ v: a.v, l: (a.ext ? '扩充：' : '图片：') + a.l, id: a.id, icon: a.icon, level: a.level, builtin: false, g: a.g, refs: a.refs }),
            missing: (all) => (L.tex && !all.some((x) => String(x.v) === String(L.tex)))
              ? { v: L.tex, l: '图片：' + L.tex + '（已丢失）', g: 'missing' } : null,
          });
          const sel = new GridSelect({
            value: L.tex, options: texLoader, cls: 'sm', group: assetGroupSpec(),
            onChange: async (v) => { await ensureTexture(v); L.tex = v; commit(items.slice()); },
          });
          texRow.appendChild(sel.el);
          texRow.appendChild(el('button', {
            class: 'mini', text: '＋图', title: '导入图片作为该层贴图',
            onclick: async () => {
              const rec = await this.importAsset('texture');
              if (!rec) return;
              invalidateAssetOptions('texture');
              sel.setOptions(texLoader);
              L.tex = 'asset:' + rec.id;
              sel.setValue(L.tex);
              commit(items.slice());
            },
          }));
          card.appendChild(texRow);

          // 数值小格：偏移 / 缩放 / 深度倍率 / 不透明度（输入即生效，实时刷新视差）
          const numCell = (label, key, st, min, max) => {
            const inp = el('input', {
              type: 'number', value: fmtNum(L[key]), step: st, min, max, title: label,
              style: { width: '100%', background: 'rgba(0,0,0,.3)', border: '1px solid var(--line2)', borderRadius: '4px', font: 'inherit', padding: '1px 3px' },
            });
            inp.addEventListener('input', () => {
              const v = Number(inp.value);
              if (inp.value === '' || !isFinite(v)) return;
              L[key] = v;
              liveSet(items.slice());
            });
            const done = () => {
              let v = Number(inp.value);
              if (inp.value === '' || !isFinite(v)) v = L[key];
              if (min !== undefined) v = Math.max(min, v);
              if (max !== undefined) v = Math.min(max, v);
              if (v !== L[key]) { L[key] = v; liveSet(items.slice()); }
              endLive();
              inp.value = fmtNum(L[key]);
            };
            inp.addEventListener('change', done);
            inp.addEventListener('blur', done);
            return el('div', { style: { flex: '1', minWidth: '0' } },
              el('div', { style: { fontSize: 'calc(9.5px * var(--ui-s) * var(--ui-fs))', color: 'var(--ink-faint)' }, text: label }), inp);
          };
          card.appendChild(el('div', { style: { display: 'flex', gap: '3px' } },
            numCell('偏移X', 'offsetX', 0.05), numCell('偏移Y', 'offsetY', 0.05),
            numCell('缩放', 'scale', 0.05, 0.05)));
          card.appendChild(el('div', { style: { display: 'flex', gap: '3px' } },
            numCell('深度倍率', 'depth', 0.001, 0, 1), numCell('不透明', 'opacity', 0.05, 0, 1)));

          // 平铺开关 + 平铺模式（关闭后图像只画一次，边界外透明）
          const tileRow = el('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } });
          tileRow.appendChild(el('span', { style: { fontSize: 'calc(9.5px * var(--ui-s) * var(--ui-fs))', color: 'var(--ink-faint)' }, text: '平铺' }));
          const tileOn = L.tile !== false;
          tileRow.appendChild(swtch(tileOn, (on) => { L.tile = on; commit(items.slice()); }));
          const tileSel = new GridSelect({
            value: L.tileMode || 'repeat', options: PORTAL_TILE_OPTIONS, cls: 'sm',
            onChange: (v) => { L.tileMode = v; commit(items.slice()); },
          });
          tileSel.setDisabled(!tileOn);
          tileRow.appendChild(tileSel.el);
          card.appendChild(tileRow);

          // 混合方式 + 染色
          const blendRow = el('div', { style: { display: 'flex', gap: '3px', alignItems: 'center' } });
          const bl = new GridSelect({
            value: L.blend || 'normal', options: PORTAL_BLEND_OPTIONS, cls: 'sm',
            onChange: (v) => { L.blend = v; commit(items.slice()); },
          });
          blendRow.appendChild(bl.el);
          const tint = el('input', {
            type: 'color', value: L.tint || '#ffffff', title: '该层染色',
            style: { width: '32px', height: '20px', padding: '0', border: 'none', background: 'none' },
          });
          tint.addEventListener('input', () => { L.tint = tint.value; liveSet(items.slice()); });
          tint.addEventListener('change', endLive);
          blendRow.appendChild(tint);
          card.appendChild(blendRow);
          return card;
        },
        (arr) => commit(arr.slice()),
        (arr) => {
          if (arr.length >= PORTAL_MAX_LAYERS) { toast('视差图层最多 ' + PORTAL_MAX_LAYERS + ' 层', '', 2000); return; }
          arr.push({ tex: 'noise', offsetX: 0, offsetY: 0, scale: 1, depth: 0.1, opacity: 1, blend: 'normal', tint: '#ffffff', tile: true, tileMode: 'repeat' });
        });
      parent.appendChild(row(labelEl, box));
      return;
    }

    /* --- 动作按钮（如管道的「截面编辑器」/「转为自定义截面」） --- */
    if (t === 'action') {
      const btn = el('button', {
        class: 'mini', text: def.btn || label, title: def.h || '',
        onclick: () => {
          const obj = opts.obj;
          if (!obj || typeof def.run !== 'function') return;
          // 传入编辑器实例：动作型属性可以自己开弹窗 / 自己记撤销
          const patch = def.run(obj, ed);
          if (!patch || !Object.keys(patch).length) return;
          const p = ed.snap();
          for (const k of Object.keys(patch)) obj[k] = patch[k];
          const b = ed.builder;
          const rec = b && b.objects.get(obj.id);
          if (b && rec) {
            try {
              const fresh = b.rebuild(rec);
              if (fresh) { b.computeBounds(); b.updateSunShadow(); }
            } catch (e) { /* ignore */ }
          }
          ed.record(label, p);
          if (ed.gizmo) ed.gizmo.attach(ed.selectedRecs());
          if (ed.nodeEd) ed.nodeEd.sync();
          ed.refreshProps();
        },
      });
      parent.appendChild(row(labelEl, btn));
      return;
    }

    /* --- 文本 --- */
    const isLong = def.k === 'description' || (opts.long === true);
    const txtMixed = mixedNow();
    if (isLong) {
      const ta = el('textarea', { class: 'inp', style: { minHeight: '58px', width: '100%' }, value: txtMixed ? '' : (get() || '') });
      ta.addEventListener('input', () => liveSet(ta.value));
      ta.addEventListener('change', endLive);
      ta.addEventListener('blur', endLive);
      const block = el('div', {}, el('div', { class: 'prow' }, el('label', { text: label })), ta);
      parent.appendChild(block);
      return;
    }
    const inp = el('input', {
      type: 'text', value: txtMixed ? '' : (get() || ''),
      placeholder: txtMixed ? '（混合）' : (def.d || ''),
    });
    inp.addEventListener('input', () => liveSet(inp.value));
    inp.addEventListener('change', endLive);
    inp.addEventListener('blur', endLive);
    inp.addEventListener('keydown', (e) => { if (e.code === 'Enter') inp.blur(); });
    parent.appendChild(row(labelEl, inp));
  }

  /** 统一走素材管理器导入（素材管理器里也会同步出现） */
  async importAsset(kind) {
    const rec = await importAssetFile(kind, { ed: this.ed });
    if (rec) { this._assets = null; await this.ensureAssets(); }
    return rec;
  }

  async ensureAssets() {
    if (this._assets) return this._assets;
    try { this._assets = await store.listAssets(); }
    catch (e) { this._assets = []; }
    return this._assets;
  }

  /** 素材库变动（导入 / 重命名 / 删除）后让下拉重新拉一次列表 */
  invalidateAssets() { this._assets = null; }

  /* ============================================================
     属性写入（单个对象 / 批量共用）
     ============================================================ */
  /** 写一个属性并做连带处理 + 增量刷新（液体种类、水纹风格、高级材质等） */
  setProp(rec, key, v) {
    const o = rec.o;
    const before = o[key];
    o[key] = v;
    // 扩充内置底贴图：把同名的法线 / 粗糙度一并写进对象。
    // 显式落数据（而不是只在构建材质时隐式套用）的好处：面板看得见、导出自带、
    // 存盘 / 预览一致；用户自己选过的贴图不会被覆盖（规则见 builtin-assets）。
    if (key === 'texture') {
      const pair = resolveBuiltinPair(v, o.roughnessMap, o.normalMap);
      if (pair.rough !== o.roughnessMap) o.roughnessMap = pair.rough || 'none';
      if (pair.normal !== o.normalMap) o.normalMap = pair.normal || 'none';
    }
    if (key === 'kind') applyLiquidKind(o, v);
    // 「使用预制外观」关闭时，切水纹只换图案，不动液体自身属性
    if (key === 'liquidStyle') {
      if (o.usePresetLook === false) applyLiquidPattern(o, v);
      else applyLiquidStyle(o, v);
    }
    if (key === 'usePresetLook' && v) applyLiquidStyle(o, o.liquidStyle);   // 打开开关立即套用预制外观
    if (key === 'advMat') applyAdvancedMaterial(o, v);   // 套用高级材质的推荐参数
    this.ed.applyPropChange(rec, key, before);
  }

  /** 对象重建（改形状 / 路径等）后旧记录会被销毁：批量操作前换成构建器里的当前记录 */
  liveRecs(recs) {
    const b = this.ed.builder;
    if (!b) return recs;
    return recs.map((r) => b.objects.get(r.id) || r);
  }

  /** 批量：把同一个值写进所有选中对象（数组等引用值逐个深拷贝） */
  setPropAll(recs, key, v) {
    const val = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
    for (const rec of this.liveRecs(recs)) this.setProp(rec, key, val);
  }

  /** 批量：只改向量的某一轴（其余轴保持各对象原值，不被首个对象覆盖） */
  setPropAxisAll(recs, key, i, v) {
    for (const rec of this.liveRecs(recs)) {
      const cur = rec.o[key];
      const arr = Array.isArray(cur) ? cur.slice() : [0, 0, 0];
      arr[i] = v;
      this.setProp(rec, key, arr);
    }
  }

  /** 批量编辑后的收尾：全局性刷新（对象树 / 面板重画 / 显隐）只做一次，灯光逐个同步 */
  afterBatchEdit(recs, key) {
    const ed = this.ed;
    const live = this.liveRecs(recs);
    ed.afterPropEdit(live[0], key);
    for (const r of live) if (r.o.type === 'light') ed.builder.syncMaterial(r);
  }

  /** 批量：所有选中对象都有的属性（同名同类型才算；下拉选项取并集） */
  batchProps(recs) {
    const maps = recs.map((r) => {
      const m = new Map();
      for (const p of propsOf(r.o.type)) if (!m.has(p.k)) m.set(p.k, p);
      return m;
    });
    const out = [];
    for (const def of propsOf(recs[0].o.type)) {
      if (def.hide || BATCH_SKIP_TYPES.has(def.t)) continue;
      let ok = true;
      const optSets = [];
      for (const m of maps) {
        const d = m.get(def.k);
        if (!d || d.t !== def.t) { ok = false; break; }
        if (d.o) optSets.push(d.o);
      }
      if (!ok) continue;
      out.push(optSets.length > 1 ? { ...def, o: mergeOptions(optSets) } : def);
    }
    return out;
  }

  /* ============================================================
     单个对象
     ============================================================ */
  renderObject(rec) {
    const ed = this.ed;
    const o = rec.o;
    const host = this.host;
    if (this.title) this.title.textContent = '属性 · ' + typeDef(o.type).label;

    /* 头部 */
    const head = el('div', { class: 'obj-head' });
    head.appendChild(el('div', { class: 'on', text: objectLabel(o) }));
    const pObj = o.parent ? getObject(ed.level, o.parent) : null;
    head.appendChild(el('div', { class: 'oid', text: o.type + ' · ' + o.id + (o.parent ? ' · 父级 ' + (pObj ? objectLabel(pObj) : o.parent + '（已丢失）') : '') }));
    head.appendChild(el('div', { class: 'addline' },
      el('button', { class: 'mini', text: '✎ 重命名', onclick: () => this.ed.renameSelection() }),
      el('button', { class: 'mini', text: '⧉ 复制', onclick: () => this.ed.duplicateSelection() }),
      el('button', { class: 'mini', text: '⌖ 聚焦', onclick: () => this.ed.focusOn([o.id]) }),
      el('button', { class: 'mini', text: '🗑 删除', onclick: () => this.ed.deleteSelection() }),
    ));
    host.appendChild(head);

    /* 按分组生成 */
    const props = propsOf(o.type);
    let cur = null, box = null;
    for (const def of props) {
      if (def.hide) continue;        // 只落数据、不上面板（如路径的贝塞尔手柄）
      const g = def.g || 'base';
      if (g !== cur) { cur = g; box = this.group(host, g); }
      const setter = (v) => this.setProp(rec, def.k, v);
      const opts = {
        label: def.l,
        after: () => ed.afterPropEdit(rec, def.k),
        obj: o,          // 动作型属性（action）需要直接读写对象数据
      };
      // 带 tog 标记的（后处理对象每一项）在标签前放一个启用开关
      const tg = def.tog ? this.toggleBox(o, def) : null;
      if (tg) opts.toggle = tg.node;
      this.field(box, def, () => o[def.k], setter, opts);
      if (tg) tg.sync();
    }

    /* 层级：任何对象都能作为父级（换父级时子对象保持世界位姿，不会因为 offset 跳走） */
    const hbox = this.group(host, 'hier');
    hbox.appendChild(this.parentRow(o));

    /* 其它信息 */
    const extra = this.group(host, 'adv', true);
    extra.appendChild(el('div', {
      class: 'prow',
      style: { fontSize: 'calc(10.5px * var(--ui-s) * var(--ui-fs))', color: 'var(--ink-faint)', lineHeight: '1.6' },
      text: '世界坐标：' + (rec.worldPos || []).map((v) => Math.round(v)).join(', '),
    }));
    extra.appendChild(el('div', {
      class: 'prow',
      style: { fontSize: 'calc(10.5px * var(--ui-s) * var(--ui-fs))', color: 'var(--ink-faint)' },
      text: this.ed.paintInfo(rec.id),
    }));
    extra.appendChild(el('div', { class: 'addline' },
      el('button', { class: 'mini', text: '🧹 清空涂鸦', onclick: () => this.ed.clearPaint(rec.id) }),
      el('button', { class: 'mini', text: '拾取此对象', onclick: () => this.ed.focusOn([o.id]) }),
    ));
  }

  /**
   * 「父级对象」行：引用当前视口选中的对象作为父级（对象引用器，不弹列表）。
   * 换父级走 ed.reparent（自动补偿世界位姿，子级不会因为 offset 跳走）；
   * 引用器排除自己与自己的后代，避免成环。
   */
  parentRow(o) {
    const ed = this.ed;
    const level = ed.level;
    const banned = new Set(collectTree(level, o.id).map((x) => x.id));
    const kids = childrenOf(level, o.id);
    const ref = objRefButton({
      ed,
      get: () => o.parent || '',
      commit: (id) => ed.reparent(o.id, id || null),
      filter: (p) => !banned.has(p.id),
      hint: '不能把对象挂到它自己或它自己的子级下',
      allowEmpty: true,
    });
    const wrap = el('div', {});
    wrap.appendChild(row('父级对象', ref));
    if (kids.length) {
      const names = kids.slice(0, 4).map((k) => objectLabel(k)).join('、');
      wrap.appendChild(el('div', {
        class: 'prow',
        style: { fontSize: 'calc(10.5px * var(--ui-s) * var(--ui-fs))', color: 'var(--ink-faint)' },
        text: '子对象 ' + kids.length + ' 个：' + names + (kids.length > 4 ? ' …' : ''),
      }));
    }
    return wrap;
  }

  /**
   * 逐项启用开关（后处理对象用）：状态存在对象的 en 表里
   * 关掉的项目不参与渲染（着色器里整段编译掉，泛光之类的重活也不再执行）
   * 返回 { node, sync }：node 塞进属性标签，sync 在行建好后调一次同步灰显状态
   */
  toggleBox(o, def) {
    const on = postfxToggleState(o)[def.k];
    const cb = el('input', {
      type: 'checkbox', class: 'togcb', checked: !!on,
      title: '启用 / 禁用「' + def.l + '」：禁用后这一项不参与渲染（几乎不耗性能）',
    });
    cb.addEventListener('pointerdown', (e) => e.stopPropagation());
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const prev = this.ed.snap();
      // 落库成完整的开关表，后续读到的就是明确值
      o.en = Object.assign(postfxToggleState(o), { [def.k]: cb.checked });
      this.ed.record((cb.checked ? '启用 ' : '禁用 ') + def.l, prev);
      sync();
    });
    const sync = () => {
      const prow = cb.closest('.prow');
      if (!prow) return;
      prow.classList.add('togrow');
      prow.classList.toggle('togoff', !cb.checked);
      for (const c of prow.querySelectorAll('input:not(.togcb), select')) c.disabled = !cb.checked;
    };
    return { node: cb, sync };
  }

  /* ============================================================
     多选
     ============================================================ */
  renderMulti(recs) {
    const host = this.host;
    if (this.title) this.title.textContent = '属性 · 多选';
    host.appendChild(el('div', { class: 'obj-head' },
      el('div', { class: 'on', text: recs.length + ' 个对象' }),
      el('div', { class: 'oid', text: '公共属性可批量修改 · 可用 3D 组件同时移动 / 旋转 / 缩放' })));
    const box = this.group(host, 'base', true);
    const listWrap = el('div', { class: 'listbox', style: { maxHeight: '190px' } });
    for (const r of recs) {
      listWrap.appendChild(el('div', { class: 'li', onclick: () => this.ed.select([r.id]) },
        el('span', { text: typeDef(r.o.type).icon }),
        el('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: objectLabel(r.o) }),
      ));
    }
    box.appendChild(listWrap);
    box.appendChild(el('div', { class: 'addline' },
      el('button', { class: 'mini', text: '⧉ 编组', onclick: () => this.ed.groupSelection() }),
      el('button', { class: 'mini', text: '⌖ 聚焦', onclick: () => this.ed.focusOn([...this.ed.selection]) }),
      el('button', { class: 'mini', text: '🗑 删除', onclick: () => this.ed.deleteSelection() }),
    ));
    this.alignTools(box, recs);

    /* ---------- 批量属性 ---------- */
    const props = this.batchProps(recs);
    if (!props.length) {
      host.appendChild(el('div', { class: 'empty-note', text: '所选对象没有可批量修改的公共属性' }));
      return;
    }
    host.appendChild(el('div', {
      class: 'empty-note',
      style: { padding: '7px 8px', textAlign: 'left', lineHeight: '1.65' },
      text: '下面列出这 ' + recs.length + ' 个对象的公共属性，修改会同时生效；'
        + '显示「混合」的项表示各对象当前取值不同。',
    }));
    let cur = null, gbox = null;
    for (const def of props) {
      const g = def.g || 'base';
      if (g !== cur) { cur = g; gbox = this.group(host, g); }
      this.field(gbox, def, () => recs[0].o[def.k], (v) => this.setPropAll(recs, def.k, v), {
        label: def.l,
        multi: true,
        values: () => recs.map((r) => r.o[def.k]),
        setAxis: (i, v) => this.setPropAxisAll(recs, def.k, i, v),
        after: () => this.afterBatchEdit(recs, def.k),
      });
    }
  }

  /** 多选时有用的对齐工具 */
  alignTools(box, recs) {
    const ed = this.ed;
    const axis = { x: 0, y: 1, z: 2 };
    const mk = (label, fn) => el('button', { class: 'mini', text: label, onclick: fn });
    const align = (k) => {
      const vals = recs.map((r) => (r.o.position || [0, 0, 0])[k]);
      const v = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
      ed.edit('对齐', () => {
        for (const r of recs) {
          if (!Array.isArray(r.o.position)) continue;
          r.o.position[k] = Math.round(v * 1000) / 1000;
          ed.builder.syncTransform(r);
        }
      }, { tree: false });
    };
    box.appendChild(el('div', {
      class: 'prow', style: { fontSize: 'calc(10.5px * var(--ui-s) * var(--ui-fs))', color: 'var(--ink-faint)', marginTop: '6px' }, text: '对齐坐标',
    }));
    box.appendChild(el('div', { class: 'addline' },
      mk('X 对齐', () => align(axis.x)),
      mk('Y 对齐', () => align(axis.y)),
      mk('Z 对齐', () => align(axis.z)),
    ));
  }

  /* ============================================================
     关卡（无选中）
     ============================================================ */
  renderLevel() {
    const ed = this.ed;
    const lv = ed.level;
    const host = this.host;
    if (this.title) this.title.textContent = '关卡属性';

    const head = el('div', { class: 'obj-head' },
      el('div', { class: 'on', text: lv.name || '未命名关卡' }),
      el('div', { class: 'oid', text: '难度 ' + Number(lv.difficulty || 1).toFixed(1) + ' · ' + lv.objects.length + ' 对象 · ' + lv.events.length + ' 事件 · ' + lv.animations.length + ' 动画' }));
    host.appendChild(head);

    const info = this.group(host, 'base', true);
    this.field(info, { k: 'name', l: '关卡名', t: 'text', d: '未命名关卡' }, () => lv.name,
      (v) => { lv.name = v; if (ed.titleEl) ed.titleEl.textContent = '洪梦编辑器 · ' + v; }, { label: '关卡名' });
    this.field(info, { k: 'author', l: '作者', t: 'text' }, () => lv.author, (v) => { lv.author = v; }, { label: '作者' });
    this.field(info, { k: 'difficulty', l: '难度', t: 'num', d: 1, min: 0.5, max: 9.99, st: 0.1 }, () => lv.difficulty,
      (v) => { lv.difficulty = v; ed.refreshTree(); }, { label: '难度' });
    this.field(info, { k: 'description', l: '描述', t: 'text' }, () => lv.description, (v) => { lv.description = v; }, { label: '描述', long: true });

    const set = this.group(host, 'behave');
    /* 梦属性存在 level.settings 下（fog.color / sun.azimuth / env …），
       读写都必须从 settings 起步，否则面板显示不到真实值、改动也落不到生效的位置 */
    const S = () => (lv.settings || (lv.settings = {}));
    const setPath = (path, v) => {
      const parts = path.split('.');
      let o = S();
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] || (o[parts[i]] = {});
      o[parts[parts.length - 1]] = v;
      ed.applyLevelSettings();
    };
    for (const def of levelSettingsDefs()) {
      const stored = def.k.split('.').reduce((o, k) => (o ? o[k] : undefined), S());
      const d = { ...def, t: def.t === 'text' ? 'text' : def.t };
      this.field(set, d, () => {
        const v = def.k.split('.').reduce((o, k) => (o ? o[k] : undefined), S());
        return v === undefined ? stored : v;
      }, (v) => setPath(def.k, v), { label: def.l, long: def.t === 'text' });
    }

    /* 关卡健康检查 */
    const adv = this.group(host, 'adv', true);
    const warns = [];
    const spawns = lv.objects.filter((o) => o.type === 'spawn').length;
    const goals = lv.objects.filter((o) => o.type === 'goal').length;
    if (!spawns) warns.push('缺少起点（玩家会从 (0,20,0) 出生）');
    if (!goals) warns.push('缺少终点（无法通关）');
    if (!lv.objects.some((o) => o.type === 'mesh' || o.type === 'liquid')) warns.push('还没有任何地形 / 液体');
    if (lv.events.some((e) => !e.actions.length)) warns.push('存在没有动作的事件');
    adv.appendChild(el('div', {
      class: 'prow', style: { display: 'block', fontSize: 'calc(10.5px * var(--ui-s) * var(--ui-fs))', lineHeight: '1.75', color: warns.length ? 'var(--acc3)' : 'var(--ink-faint)' },
      html: warns.length ? warns.map((w) => '⚠ ' + w).join('<br>') : '✓ 关卡结构看起来没问题',
    }));
    adv.appendChild(el('div', { class: 'addline' },
      el('button', { class: 'mini', text: '🏁 关卡统计', onclick: () => ed.showStats() }),
      el('button', { class: 'mini', text: '🗑 清空涂鸦', onclick: () => ed.clearPaint(null) }),
    ));
  }
}