/* ============================================================
   天空工坊：程序化天空球生成 / 烘焙
   ------------------------------------------------------------
   · 浮动窗口（复用 .ez-win 外壳，可拖动，z-index 95，单例）
   · 左侧 = 2:1 等距柱状实时预览 + 导出分辨率；右侧 = 全部模块参数
   · 参数改动即时重烘焙预览（requestAnimationFrame 合并）
   · 结果可实时同步到编辑器天空 / 导出 PNG / 存成关卡素材（全景图）并启用
   ============================================================ */
import * as THREE from 'three';
import { el, clear, toast } from '../ui/dom.js';
import { GridSelect } from '../ui/grid-picker.js';
import { settings, resolveAssetURL } from '../core/settings.js';
import { store } from '../core/storage.js';
import { loadTextureFromURL, setLiveSkyTexture } from '../core/textures.js';
import { dayNightBodies } from '../world/builder.js';
import { saveBlob, clamp } from '../core/util.js';
import {
  SKY_TEXTURES, PATTERN_TYPES, PATTERN_DISTS, TONE_MODES,
  withDefaults, SkyBaker,
} from '../core/sky-gen.js';
import { refreshAssetManager } from './asset-manager.js';

/* 预览精度档：预览面板只有 ~300px 宽，512×256 已经够清晰。
   烘焙偏慢时自动降档 —— 宁可糊一点，也不能让拖滑杆卡死编辑器 */
const PREVIEW_SIZES = [[512, 256], [384, 192], [256, 128]];
const RESOS = [
  { w: 1024, h: 512, label: '1024 × 512（快）' },
  { w: 2048, h: 1024, label: '2048 × 1024（推荐）' },
  { w: 4096, h: 2048, label: '4096 × 2048（高清）' },
];

let _lab = null;
/* 烘焙器跨窗口复用：天空着色器编译一次要 3 秒左右，关掉再打开不该再等一遍。
   真正的销毁放在 closeSkyLab()（编辑器整体退出时） */
let _baker = null;

/** 打开天空工坊（同一时刻只允许一个窗口） */
export function openSkyLab(ed) {
  if (_lab) { _lab.close(); _lab = null; }
  _lab = new SkyLab(ed);
  return _lab;
}

/** 关闭天空工坊（编辑器退出 / 切关卡时调用） */
export function closeSkyLab() {
  if (_lab) { _lab.close(); _lab = null; }
  if (_baker) { _baker.dispose(); _baker = null; }
}

class SkyLab {
  constructor(ed) {
    this.ed = ed;
    this.params = withDefaults(settings.get('skyLab', null));
    this._ctl = {};         // key → { rng, num }：改「时间」时要就地刷新天体 / 亮度滑杆
    // 昼夜时间默认跟随关卡主光的 hour —— 天空工坊也按小时值摆天体、定亮度
    const hh = ed && ed.level && ed.level.settings && ed.level.settings.sun
      ? ed.level.settings.sun.hour : undefined;
    if (hh !== undefined && hh !== null && isFinite(Number(hh))) this.params.hour = Number(hh);
    this._applyHour();
    this.baker = null;
    this.liveTex = null;
    this.live = false;
    this.res = 1;
    this.pv = 0;            // 预览精度档（见 PREVIEW_SIZES）
    this._prevSky = null;
    this._job = 0;          // 排队中的烘焙（rAF / timeout id）
    this._bakes = 0;        // 已完成的烘焙次数
    this._bakeMs = 0;       // 最近一次烘焙耗时
    this._ready = false;    // 着色器是否已编译好（编译期间只推进度条，不渲染）
    this._compiling = false;
    this._done = false;     // 窗口是否已关（挡住异步编译回来后的 DOM 操作）
    this._build();
    // 首次编译要三四秒（驱动侧），整段挂在主线程上会「点开就卡死」。
    // 这里先让窗口画出来，再走异步编译 + 进度条，编译期间界面一直是活的
    this._syncStatus('正在准备天空着色器…');
    this._schedule(true);
  }

  /* ============================================================
     窗口骨架
     ============================================================ */
  _build() {
    const win = el('div', { class: 'ez-win sl-win' });
    this.win = win;

    const head = el('div', { class: 'ez-head' },
      el('span', { class: 'ez-title', text: '天空工坊' }),
      el('span', { class: 'ez-sub', text: '程序化天空球生成 / 烘焙 · 等距柱状全景 2:1' }),
      el('button', { class: 'ez-x', text: '✕', title: '关闭（Esc）', onclick: () => this.close() }));
    win.appendChild(head);

    /* ---------- 左：预览 ---------- */
    const pv = PREVIEW_SIZES[0];
    this.prev = el('canvas', { class: 'sl-prev', width: pv[0], height: pv[1] });
    this.prevCtx = this.prev.getContext('2d');

    this.resSel = new GridSelect({
      cls: 'sl-sel',
      value: String(this.res),
      options: RESOS.map((r, i) => ({ v: String(i), l: '导出 ' + r.label })),
      onChange: (v) => { this.res = Number(v) || 0; this._syncStatus(); },
    });

    this.liveBtn = el('button', {
      class: 'mini sl-tgl', title: '把当前天空实时同步为编辑器的天空盒（仅编辑器内预览，不入存档）',
      text: '同步到编辑器天空', onclick: () => this._setLive(!this.live),
    });

    /* 编译进度条：只在首次编译着色器期间出现（进度是按时长估的，所以卡在 95%，
       真正的 100% 只在拿到编译完成回调后给） */
    this.progBar = el('i', { class: 'sl-progbar' });
    this.prog = el('div', { class: 'sl-prog' }, this.progBar);

    const left = el('div', { class: 'sl-left' },
      this.prev,
      this.prog,
      el('div', { class: 'sl-info', text: '预览为等距柱状全景（上=天顶，下=天底）；拖动右侧滑杆即时重算。' }),
      el('div', { class: 'sl-row2' }, this.liveBtn),
      el('div', { class: 'sl-row2' }, this.resSel),
      el('div', { class: 'sl-row2' },
        el('button', { class: 'mini', text: '随机化', title: '随机种子与天气参数', onclick: () => this.randomize() }),
        el('button', { class: 'mini', text: '重置', title: '恢复全部默认参数', onclick: () => this.reset() })),
      el('div', { class: 'sl-row2' },
        el('button', {
          class: 'mini', text: '取用关卡主光', title: '把太阳方位 / 仰角设成当前关卡主光的方向',
          onclick: () => this._useLevelSun(),
        })));
    /* ---------- 右：参数 ---------- */
    this.right = el('div', { class: 'sl-right' });

    const body = el('div', { class: 'sl-body' }, left, this.right);
    win.appendChild(body);

    /* ---------- 底：动作 ---------- */
    this.status = el('span', { class: 'sl-status', text: '' });
    const foot = el('div', { class: 'ez-foot sl-foot' },
      this.status,
      el('button', { class: 'mbtn sm', text: '关闭', onclick: () => this.close() }),
      el('button', {
        class: 'mbtn sm primary', text: '导出 PNG',
        title: '按所选分辨率烘焙并下载等距柱状全景图',
        onclick: () => this.exportPNG(),
      }),
      el('button', {
        class: 'mbtn sm primary', text: '存为素材并应用',
        title: '烘焙成图 → 存进本关素材 → 设为天空盒（随关卡一起导出）',
        onclick: () => this.saveAsAsset(),
      }));
    win.appendChild(foot);

    /* ---------- 挂载 + 拖动 ---------- */
    const host = document.getElementById('app') || document.body;
    host.appendChild(win);
    const w = win.offsetWidth || 900, h = win.offsetHeight || 620;
    win.style.left = Math.max(8, Math.min(window.innerWidth - w - 12, (window.innerWidth - w)/2)) + 'px';
    win.style.top = Math.max(8, Math.min(window.innerHeight - h - 12, (window.innerHeight - h)/2)) + 'px';

    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = win.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      win.style.left = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - drag.dx)) + 'px';
      win.style.top = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - drag.dy)) + 'px';
    });
    const stopDrag = () => { drag = null; };
    head.addEventListener('pointerup', stopDrag);
    head.addEventListener('pointercancel', stopDrag);

    // Esc 关窗（挡住编辑器的全局快捷键）；有 #modal（GridSelect 选择器 / 确认框）在显示时交给它处理
    this._onKey = (e) => {
      if (e.code !== 'Escape') return;
      const m = document.getElementById('modal');
      if (m && !m.classList.contains('hidden')) return;
      e.stopPropagation(); e.preventDefault(); this.close();
    };
    window.addEventListener('keydown', this._onKey, true);

    this._buildControls();
  }

  /* ============================================================
     参数控件
     ============================================================ */
  _buildControls() {
    clear(this.right);
    this._ctl = {};
    const p = this.params;

    const secs = [
      this._sec('天空纹理 Shader（' + SKY_TEXTURES.length + ' 种）', [
        this._select('纹理', 'texId', SKY_TEXTURES, '71 种程序化天空纹理，可与下面的渐变 / 大气叠加'),
        this._num('混合强度', 'texAmt', 0, 1, 0.01, '0 = 只用渐变与大气；1 = 完全用该纹理'),
        this._color('主色', 'texA'),
        this._color('副色', 'texB'),
      ]),
      this._sec('大气', [
        this._num('散射强度', 'atmAmt', 0, 2, 0.01, '瑞利 / 米氏单次散射的叠加量，太阳越低越红'),
        this._color('天顶色', 'zenith'),
        this._color('地平线色', 'horizon'),
        this._color('地面色', 'ground'),
        this._num('大气密度', 'density', 0.2, 3, 0.05),
        this._num('瑞利散射', 'rayleigh', 0, 3, 0.05, '分子散射：越大蓝天越浓、日落越红'),
        this._num('米氏散射', 'mie', 0, 3, 0.05, '气溶胶散射：越大天空越发白、光晕越强'),
        this._num('米氏各向异性', 'mieG', 0, 0.95, 0.01, '越大太阳周围的白色光环越集中'),
        this._num('浊度', 'turbidity', 0, 8, 0.1, '空气浑浊度：影响整体霾感'),
      ]),
      this._sec('云', [
        this._bool('启用云层', 'cloudOn'),
        this._num('覆盖率', 'cloudCover', 0, 1, 0.01),
        this._num('不透明度', 'cloudDensity', 0, 2, 0.02),
        this._num('边缘锐度', 'cloudSharp', 0.02, 0.6, 0.005, '越小云越柔和蓬松'),
        this._num('云层高度', 'cloudAlt', 0, 1, 0.01, '越高透视越平、云越远'),
        this._num('云团尺度', 'cloudScale', 0.3, 6, 0.05),
        this._num('银边强度', 'cloudSilver', 0, 2, 0.02, '云块朝太阳一侧的透光亮边'),
        this._color('受光色', 'cloudLit'),
        this._color('暗部色', 'cloudDark'),
      ]),
      this._sec('星空', [
        this._bool('启用星空', 'starOn'),
        this._num('星星密度', 'starDensity', 0, 1, 0.01),
        this._num('亮度', 'starBright', 0, 3, 0.05),
        this._num('星点大小', 'starSize', 0, 1, 0.01),
        this._color('星星颜色', 'starColor'),
        this._num('银河', 'milkyWay', 0, 1.5, 0.02),
        this._num('星云', 'nebula', 0, 1.5, 0.02),
        this._color('星云颜色', 'nebulaColor'),
      ]),
      this._sec('昼夜时间', [
        this._time('时间(时)', 'hour', '与关卡主光同一套昼夜模型：白天太阳高、夜晚月亮高，并同步推得天空亮度'),
        this._num('天空亮度', 'bright', 0.02, 2, 0.01, '整幅天空的明暗倍数（由时间驱动，可手动微调）'),
      ]),
      this._sec('天体（太阳 / 月亮）', [
        this._bool('启用太阳', 'sunOn'),
        this._num('太阳方位', 'sunAz', 0, 360, 1),
        this._num('太阳仰角', 'sunEl', -90, 90, 0.5, '负数 = 已落到地平线以下，只留余晖（由「时间」驱动）'),
        this._num('太阳视直径°', 'sunSize', 0.2, 20, 0.1),
        this._num('太阳光晕', 'sunGlow', 0, 3, 0.05),
        this._color('太阳颜色', 'sunColor'),
        this._bool('启用月亮', 'moonOn'),
        this._num('月亮方位', 'moonAz', 0, 360, 1),
        this._num('月亮仰角', 'moonEl', -90, 90, 0.5, '由「时间」驱动：太阳落山时月亮升到高处'),
        this._num('月亮视直径°', 'moonSize', 0.5, 20, 0.1),
        this._num('月相', 'moonPhase', -1, 1, 0.01, '-1 / 1 = 新月，0 = 满月'),
        this._num('月亮光晕', 'moonGlow', 0, 2, 0.05),
        this._color('月亮颜色', 'moonColor'),
      ]),
      this._sec('自定义空中图案分布', [
        this._bool('启用图案', 'patOn'),
        this._select('图案', 'patType', PATTERN_TYPES, '阵列 / 圆点 / 同心环 / 螺旋 / 波浪 / 散布 / 花瓣 / 涟漪'),
        this._num('数量', 'patCount', 1, 40, 1),
        this._num('单元大小', 'patSize', 0.02, 1, 0.01),
        this._num('旋转°', 'patRot', 0, 360, 1),
        this._select('分布范围', 'patDist', PATTERN_DISTS),
        this._num('不透明度', 'patAlpha', 0, 1, 0.01),
        this._color('图案颜色', 'patColor'),
      ]),
      this._sec('真实光学', [
        this._num('曝光', 'exposure', 0.1, 3, 0.01),
        this._num('对比度', 'contrast', 0, 2, 0.01),
        this._num('饱和度', 'saturation', 0, 2, 0.01),
        this._select('色调映射', 'tone', TONE_MODES),
        this._num('地平线霾', 'haze', 0, 1, 0.01),
        this._color('霾颜色', 'hazeColor'),
        this._num('镜头光晕', 'flare', 0, 2, 0.02),
        this._num('星芒', 'spikes', 0, 2, 0.02, '太阳的衍射十字星芒'),
        this._num('色差', 'chroma', 0, 3, 0.05, '非 0 时重建采样，预览会变慢'),
        this._num('暗角', 'vignette', 0, 1, 0.01),
      ]),
      this._sec('随机种子', [
        this._num('种子', 'seed', 0, 999, 1, '决定云 / 星空 / 星云的随机形态'),
      ]),
    ];
    for (const s of secs) this.right.appendChild(s);
  }

  _sec(title, rows) {
    const body = el('div', { class: 'sl-secb' }, rows);
    const head = el('button', {
      class: 'sl-sech', type: 'button',
      onclick: () => { body.classList.toggle('hidden'); head.classList.toggle('off'); },
    }, el('span', { class: 'sl-arrow', text: '▾' }), el('span', { text: title }));
    return el('div', { class: 'sl-sec' }, head, body);
  }

  _row(label, ctl, hint) {
    return el('div', { class: 'sl-row', title: hint || '' },
      el('span', { class: 'sl-lab', text: label }), el('div', { class: 'sl-ctl' }, ctl));
  }

  _num(label, key, min, max, step, hint) {
    const val = Number(this.params[key]);
    const rng = el('input', { class: 'sl-rng', type: 'range', min, max, step, value: val });
    const num = el('input', { class: 'sl-num', type: 'number', min, max, step, value: val });
    this._ctl[key] = { rng, num };
    const commit = (v, from) => {
      let n = Number(v);
      if (!isFinite(n)) return;
      n = clamp(n, min, max);
      this.params[key] = n;
      if (from !== 'rng') rng.value = String(n);
      if (from !== 'num') num.value = String(n);
      this.changed();
    };
    rng.addEventListener('input', () => commit(rng.value, 'rng'));
    num.addEventListener('change', () => commit(num.value, 'num'));
    return this._row(label, [rng, num], hint);
  }

  /**
   * 昼夜时间：0–24 的小时值。改动时用同一套模型推出太阳 / 月亮的原始仰角与
   * 天空亮度，并就地回写那几个滑杆 —— 注意不能重建控件，否则会打断正在进行的拖动。
   */
  _time(label, key, hint) {
    const val = Number(this.params[key]);
    const rng = el('input', { class: 'sl-rng', type: 'range', min: 0, max: 24, step: 0.1, value: val });
    const num = el('input', { class: 'sl-num', type: 'number', min: 0, max: 24, step: 0.1, value: val });
    this._ctl[key] = { rng, num };
    const commit = (v, from) => {
      let n = Number(v);
      if (!isFinite(n)) return;
      n = clamp(Math.round(n * 10) / 10, 0, 24);
      this.params[key] = n;
      if (from !== 'rng') rng.value = String(n);
      if (from !== 'num') num.value = String(n);
      this._applyHour();
      this.changed();
    };
    rng.addEventListener('input', () => commit(rng.value, 'rng'));
    num.addEventListener('change', () => commit(num.value, 'num'));
    return this._row(label, [rng, num], hint);
  }

  /** 用「昼夜时间」小时值推导天体位置与天空亮度（与关卡主光同一套模型） */
  _applyHour() {
    const b = dayNightBodies(this.params.hour);
    const r2 = (v) => Math.round(clamp(v, -90, 90) * 100) / 100;
    this.params.sunEl = r2(b.sunEl);          // 太阳：正午最高，夜间沉到地平线以下
    this.params.moonEl = r2(b.moonEl);        // 月亮：与太阳反相，午夜最高
    /* 天空亮度：太阳贴近地平线时开始衰减，落到地平线下方后进入月夜（最低 ~0.10）。
       曲线特意让默认低阳（约 9°）时仍接近 1，避免「重置」后观感被明显改暗 */
    let f = clamp((b.sunEl + 2) / 12, 0, 1);
    f = f * f * (3 - 2 * f);
    this.params.bright = Math.round((0.10 + 0.90 * f) * 100) / 100;
    this._syncCtl('sunEl'); this._syncCtl('moonEl'); this._syncCtl('bright');
  }

  /** 把某个参数的最新值就地写回它的滑杆 / 数字框（不触发表单事件） */
  _syncCtl(key) {
    const c = this._ctl && this._ctl[key];
    if (!c) return;
    const v = String(this.params[key]);
    if (c.rng.value !== v) c.rng.value = v;
    if (c.num.value !== v) c.num.value = v;
  }

  _color(label, key) {
    const inp = el('input', { class: 'sl-col', type: 'color', value: this.params[key] });
    inp.addEventListener('input', () => { this.params[key] = inp.value; this.changed(); });
    return this._row(label, inp);
  }

  _bool(label, key) {
    const on = !!this.params[key];
    const btn = el('button', {
      class: 'sl-tgl' + (on ? ' on' : ''), type: 'button', text: on ? '开' : '关',
      onclick: () => {
        const next = this.params[key] ? 0 : 1;
        this.params[key] = next;
        btn.classList.toggle('on', !!next);
        btn.textContent = next ? '开' : '关';
        this.changed();
      },
    });
    return this._row(label, btn);
  }

  _select(label, key, options, hint) {
    const cur = Number(this.params[key]);
    const sel = new GridSelect({
      cls: 'sl-sel',
      value: String(cur),
      options: options.map((o) => ({ v: String(o.id), l: o.label })),
      onChange: (v) => { this.params[key] = Number(v) || 0; this.changed(); },
    });
    return this._row(label, sel, hint);
  }

  /* ============================================================
     预览 / 同步
     ============================================================ */
  changed() {
    settings.set('skyLab', this.params, true);
    this._schedule(false);
  }

  /**
   * 把烘焙排到下一帧（同一时刻只排一次）。
   * first = true 时多等一帧：rAF 回调跑在绘制之前，套两层才能保证
   * 「窗口已经出现在屏幕上」再开始那段几秒的着色器编译。
   */
  _schedule(first) {
    if (this._job) return;
    const go = () => { this._job = 0; this.update(); };
    this._job = first
      ? requestAnimationFrame(() => requestAnimationFrame(go))
      : requestAnimationFrame(go);
  }

  /** 烘焙入口：着色器还没编译好就先走编译（带进度条），编译好了再渲染 */
  update() {
    if (!this.baker) this.baker = _baker || (_baker = new SkyBaker());
    if (!this._ready) { this._startCompile(); return; }
    this._bake();
  }

  /**
   * 首次准备天空着色器，分两步：
   *   ① 建 WebGL 上下文 —— 同步，实测要一秒多，驱动侧没得异步（先把提示画出来再动手）
   *   ② 编译着色器     —— 走 KHR_parallel_shader_compile，实测 200ms 上下、主线程只停十几毫秒
   * 两条路都拿不到驱动的真实百分比，所以进度条做成不确定态（流动的走马灯）：
   * 只表示「在干活」，绝不假装知道进度。
   */
  _startCompile() {
    if (this._compiling) return;
    this._compiling = true;
    // 先让这句提示和进度条真正画到屏幕上，再去做那段会占住主线程的同步操作
    this.prog.classList.add('on');
    this.status.textContent = '正在创建天空渲染器…';
    const painted = new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    painted.then(() => {
      if (this._done) return undefined;
      this.baker.prepare();
      this.status.textContent = '正在编译天空着色器…';
      return this.baker.warmup();
    }).then((ok) => {
      if (this._done) return;
      this._compiling = false;
      this.prog.classList.remove('on');
      /* 编译没成功也照样往下走一次：SkyBaker 渲染时会换一份材质重试，
         真不行就把驱动给的原文报到状态栏 —— 总比留一张黑图一声不吭强 */
      this._ready = true;
      if (!ok) this._syncStatus('天空着色器未编译成功，正在重试…');
      this._bake();
    });
  }

  /** 真正渲染一帧预览 */
  _bake() {
    const w = this.prev.width, h = this.prev.height;
    const t0 = performance.now();
    const src = this.baker.render(this.params, w, h);
    if (!src) { this._syncStatus('渲染失败：' + (this.baker.error || '未知错误')); return; }
    const x = this.prevCtx;
    x.clearRect(0, 0, w, h);
    x.drawImage(src, 0, 0, w, h);
    this._bakeMs = performance.now() - t0;
    this._bakes++;
    if (this.live) this._pushLive();
    this._syncStatus();
    this._autoTune();
  }

  /** 烘焙太慢就自动降一档预览精度（首帧含编译耗时，不代表稳态，不参与判定） */
  _autoTune() {
    if (this._bakes < 3 || this._bakeMs <= 300) return;
    if (this.pv >= PREVIEW_SIZES.length - 1) return;
    this.pv++;
    const s = PREVIEW_SIZES[this.pv];
    this.prev.width = s[0]; this.prev.height = s[1];
    this.prevCtx = this.prev.getContext('2d');
    toast('预览偏慢，已自动降到 ' + s[0] + '×' + s[1], '', 2400);
    this._schedule(false);
  }

  _syncStatus(extra) {
    const r = RESOS[this.res];
    this.status.textContent = extra || ('预览 ' + this.prev.width + '×' + this.prev.height
      + ' · 导出 ' + r.w + '×' + r.h
      + (this.live ? ' · 已同步到编辑器天空' : ''));
  }

  _pushLive() {
    const c = this.baker && this.baker.canvas;
    if (!c) return;
    if (!this.liveTex) {
      this.liveTex = new THREE.CanvasTexture(c);
      this.liveTex.mapping = THREE.EquirectangularReflectionMapping;
      this.liveTex.colorSpace = THREE.SRGBColorSpace;
      setLiveSkyTexture(this.liveTex);
    }
    this.liveTex.needsUpdate = true;
    const s = this.ed.level && this.ed.level.settings;
    if (!s) return;
    if (s.sky !== 'skylab:live') { this._prevSky = s.sky; s.sky = 'skylab:live'; }
    this.ed.applyLevelSettings();
  }

  _setLive(on) {
    if (this.live === on) return;
    this.live = on;
    this.liveBtn.classList.toggle('on', on);
    this.liveBtn.textContent = on ? '同步中（点击停止）' : '同步到编辑器天空';
    if (on) {
      this._pushLive();
    } else {
      setLiveSkyTexture(null);
      const s = this.ed.level && this.ed.level.settings;
      if (s && s.sky === 'skylab:live') { s.sky = this._prevSky || 'dream'; this.ed.applyLevelSettings(); }
      if (this.liveTex) { try { this.liveTex.dispose(); } catch (e) { /* ignore */ } this.liveTex = null; }
    }
    this._syncStatus();
    toast(on ? '天空已同步到编辑器（保存关卡时不会带上这张临时天空）' : '已停止同步', '', 2200);
  }

  /* ============================================================
     预设操作
     ============================================================ */
  randomize() {
    const p = this.params;
    p.seed = Math.floor(Math.random()*1000);
    p.cloudCover = clamp(p.cloudCover + (Math.random() - 0.5)*0.6, 0.05, 0.95);
    p.cloudAlt = clamp(p.cloudAlt + (Math.random() - 0.5)*0.5, 0, 1);
    p.cloudScale = clamp(p.cloudScale*(0.6 + Math.random()*0.9), 0.3, 6);
    p.sunAz = Math.round(Math.random()*360);
    p.hour = Math.round(Math.random()*24*10)/10;    // 昼夜时间：随机时刻 → 天体位置 / 亮度随之而来
    this._applyHour();
    p.atmAmt = clamp(p.atmAmt + (Math.random() - 0.5)*0.5, 0, 2);
    p.turbidity = clamp(p.turbidity*(0.5 + Math.random()), 0, 8);
    p.saturation = clamp(0.9 + Math.random()*0.5, 0, 2);
    this._buildControls();
    this.changed();
  }

  reset() {
    this.params = withDefaults(null);
    this._applyHour();
    settings.set('skyLab', this.params, true);
    this._buildControls();
    this.changed();
  }

  _useLevelSun() {
    const sun = (this.ed.level && this.ed.level.settings && this.ed.level.settings.sun) || {};
    if (sun.azimuth !== undefined) this.params.sunAz = Number(sun.azimuth);
    if (sun.hour !== undefined) { this.params.hour = Number(sun.hour) || 0; this._applyHour(); }
    if (sun.color) this.params.sunColor = sun.color;
    this._buildControls();
    this.changed();
    toast('已取用关卡主光的昼夜时间 / 方位 / 颜色', '', 2000);
  }

  /* ============================================================
     产出
     ============================================================ */
  async exportPNG() {
    const r = RESOS[this.res];
    this._syncStatus('正在烘焙 ' + r.w + '×' + r.h + ' …');
    const blob = await this.baker.toBlob(this.params, r.w, r.h);
    /* 渲不出来就不给文件：以前这里会把一张全黑的画布照样导成 PNG，
       用户只会看到「导出成功但图是空的」，真正的原因一个字都看不见 */
    if (!blob) {
      const why = this.baker.error || '未知错误';
      this._syncStatus('烘焙失败：' + why);
      toast('导出失败：' + why, 'err', 3600);
      return;
    }
    saveBlob('sky_' + r.w + 'x' + r.h + '_' + Date.now() + '.png', blob);
    toast('已导出 ' + r.w + '×' + r.h + ' 全景图', 'ok');
    this.update();
    if (this.ed.log) this.ed.log('导出天空全景图 ' + r.w + '×' + r.h, 'i');
  }

  async saveAsAsset() {
    const r = RESOS[this.res];
    this._syncStatus('正在烘焙并保存素材 …');
    const blob = await this.baker.toBlob(this.params, r.w, r.h);
    if (!blob) {
      const why = this.baker.error || '未知错误';
      this._syncStatus('烘焙失败：' + why);
      toast('烘焙失败：' + why, 'err', 3600);
      return;
    }
    const name = '天空工坊 ' + new Date().toLocaleString('zh-CN', { hour12: false });
    let rec = null;
    try {
      const file = new File([blob], name + '.png', { type: 'image/png' });
      rec = await store.saveAsset(file, 'texture', { name });
    } catch (e) {
      toast('保存素材失败：' + (e && e.message ? e.message : e), 'err', 3200);
      this._syncStatus('保存素材失败');
      return;
    }
    if (!rec) { toast('保存素材失败', 'err'); this._syncStatus('保存素材失败'); return; }
    try {
      const url = await resolveAssetURL(rec.id);
      if (url) await loadTextureFromURL('asset:' + rec.id, url, rec.name);
    } catch (e) { /* 注册失败不影响素材本身 */ }

    this._setLive(false);
    const s = this.ed.level && this.ed.level.settings;
    if (s) { s.sky = 'asset:' + rec.id; this.ed.applyLevelSettings(); }
    if (this.ed.inspector && this.ed.inspector.invalidateAssets) this.ed.inspector.invalidateAssets();
    refreshAssetManager();
    toast('已存为关卡素材并设为天空盒（' + r.w + '×' + r.h + '）', 'ok', 2600);
    if (this.ed.log) this.ed.log('天空工坊生成全景图并设为天空盒：' + name, 'i');
    this.update();
  }

  /* ============================================================
     关闭
     ============================================================ */
  close() {
    if (this._job) { cancelAnimationFrame(this._job); clearTimeout(this._job); this._job = 0; }
    this._done = true;                   // 还在异步编译的话，回来后别再碰 DOM
    this._compiling = false;
    window.removeEventListener('keydown', this._onKey, true);
    this._setLive(false);
    setLiveSkyTexture(null);
    if (this.baker) this.baker = null;   // 只放手，不销毁：着色器要留着重开复用（见 _baker）
    if (this.win && this.win.parentNode) this.win.parentNode.removeChild(this.win);
    if (_lab === this) _lab = null;
  }
}