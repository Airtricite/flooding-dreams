/* ============================================================
   粒子编辑器 · 独立弹出窗口
   ------------------------------------------------------------
   · 浮动窗口（复用 .ez-win 外壳，可拖动，单例）
   · 左 = 粒子条目栈（每条 = 一张图像 + 一种扭曲/蒙版动画 + 权重 + 开关）
        同一次发射的粒子按权重从各条目里随机抽取 → 每颗粒子外观 / 动画不同
   · 中 = 选中条目的参数（图像 / 动画 / 权重 / 启用）
   · 右 = 实时预览（真·FX 实例，渲染的就是游戏里那套着色器 → 所见即所得）
   数据写在 emitter 的 o.particles，随关卡 JSON 走
   ============================================================ */
import * as THREE from 'three';
import { el, clear, toast } from '../ui/dom.js';
import { row, numInput, swtch, attachNumWheel } from './widgets.js';
import {
  GridSelect, streamAssetOptions, invalidateAssetOptions, assetGroupSpec,
} from '../ui/grid-picker.js';
import {
  PARTICLE_BUILTINS, PARTICLE_ANIMS, PARTICLE_ANIM_COUNT,
  newParticleEntry, particleEntrySummary, normalizeParticleEntry,
} from '../core/particle-presets.js';
import { isHDRName, isParticleBuiltin, getParticleSprite, ensureTexture } from '../core/textures.js';
import { importAssetFile } from './asset-manager.js';
import { FX } from '../world/fx.js';

let _inst = null;
/** 打开粒子编辑器（ed = 编辑器实例，o = 目标 emitter 对象） */
export function openParticleEditor(ed, o) {
  if (_inst) { _inst.close(); _inst = null; }
  _inst = new ParticleEditor(ed, o);
  return _inst;
}
/** 关闭粒子编辑器（编辑器退出 / 切关卡时调用） */
export function closeParticleEditor() {
  if (_inst) { _inst.close(); _inst = null; }
}

/** 粒子图像选择器的选项：内置 20 种 + 导入的图片素材（异步流式加载） */
function particleImageLoader(getCur) {
  return streamAssetOptions('texture', {
    filter: (a) => !isHDRName(a.l),
    head: () => PARTICLE_BUILTINS.map((x) => ({ v: x.v, l: '内置 · ' + x.l, g: 'builtin', builtin: true })),
    map: (a) => ({
      v: a.v, l: (a.ext ? '扩充：' : '图片：') + a.l, id: a.id, icon: a.icon,
      level: a.level, builtin: false, g: a.g, refs: a.refs,
    }),
    missing: (all) => {
      const cur = getCur ? getCur() : null;
      if (cur && !all.some((x) => String(x.v) === String(cur))) return { v: cur, l: cur + '（已丢失）', g: 'missing' };
      return null;
    },
  });
}

class ParticleEditor {
  constructor(ed, o) {
    this.ed = ed;
    this.o = o || {};
    this.sel = 0;
    this._prev = null;        // 连续编辑（拖数字）的撤销快照
    this._closed = false;
    this._pvRAF = 0;
    this._pvT = 0;
    this.pvAcc = 0;
    this.renderer = null;
    this.pvFx = null;
    this._build();
  }

  _entries() {
    if (!Array.isArray(this.o.particles)) this.o.particles = [];
    this.o.particles = this.o.particles.map((e) => normalizeParticleEntry(e));
    return this.o.particles;
  }

  /* ============================================================
     窗口骨架
     ============================================================ */
  _build() {
    const win = el('div', { class: 'ez-win pm-win' });
    this.win = win;

    const head = el('div', { class: 'ez-head' },
      el('span', { class: 'ez-title', text: '粒子编辑器' }),
      el('span', { class: 'ez-sub', text: '多条粒子条目 · 每条独立图像与扭曲/蒙版动画 · 按权重随机发射' }),
      el('button', { class: 'ez-x', text: '✕', title: '关闭（Esc）', onclick: () => this.close() }));
    win.appendChild(head);

    this.listEl = el('div', { class: 'pm-list' });
    this.midEl = el('div', { class: 'pm-mid' });
    this.prev = el('div', { class: 'pm-prev' });

    const left = el('div', { class: 'pm-left' }, this.listEl, this._buildAdd());
    const right = el('div', { class: 'pm-right' }, this.prev,
      el('div', { class: 'pm-prevhint', text: '预览为真实发射器着色器：图像 + 该条的扭曲/蒙版动画随寿命播放。' }));
    win.appendChild(el('div', { class: 'pm-body' }, left, this.midEl, right));

    win.appendChild(el('div', { class: 'ez-foot pm-foot' },
      el('span', { class: 'pm-status', text: '颜色 / 大小 / 寿命等取发射器对象自身的属性。' }),
      el('button', { class: 'mbtn sm', text: '关闭', onclick: () => this.close() })));

    const host = document.getElementById('app') || document.body;
    host.appendChild(win);
    const w = win.offsetWidth || 900, h = win.offsetHeight || 560;
    win.style.left = Math.max(8, Math.min(window.innerWidth - w - 12, (window.innerWidth - w) / 2)) + 'px';
    win.style.top = Math.max(8, Math.min(window.innerHeight - h - 12, (window.innerHeight - h) / 2)) + 'px';

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

    this._onKey = (e) => {
      if (e.code !== 'Escape') return;
      /* 有 #modal（GridSelect 选择器 / 确认框）在显示时交给它处理，
         否则一次 Esc 会连本窗口一起关掉 */
      const m = document.getElementById('modal');
      if (m && !m.classList.contains('hidden')) return;
      e.stopPropagation(); e.preventDefault(); this.close();
    };
    window.addEventListener('keydown', this._onKey, true);

    /* 预览渲染器尺寸跟随面板 */
    this._ro = (typeof ResizeObserver !== 'undefined')
      ? new ResizeObserver(() => this._resizePreview())
      : null;
    if (this._ro) this._ro.observe(this.prev);

    this.refresh();
    this._initPreview();
  }

  _buildAdd() {
    const imgSel = new GridSelect({
      value: 'pb/glow', cls: 'inp', group: assetGroupSpec(),
      options: particleImageLoader(() => imgSel.value),
      onChange: (v) => ensureTexture(v),
    });
    const animSel = new GridSelect({
      value: '0', cls: 'inp',
      options: PARTICLE_ANIMS.map((a) => ({ v: String(a.v), l: a.l })),
    });
    return el('div', { class: 'pm-add' }, imgSel.el, animSel.el, el('button', {
      class: 'mini', text: '＋ 添加条目',
      onclick: () => {
        const img = imgSel.value || 'pb/glow';
        const anim = Number(animSel.value) | 0;
        if (!img) { toast('请先选择粒子图像', 'err'); return; }
        ensureTexture(img);
        this._structural('添加粒子条目', () => {
          this._entries().push(newParticleEntry(img, anim));
          this.sel = this._entries().length - 1;
        });
      },
    }));
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    window.removeEventListener('keydown', this._onKey, true);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._pvRAF) { cancelAnimationFrame(this._pvRAF); this._pvRAF = 0; }
    if (this.pvFx) { try { this.pvFx.dispose(); } catch (e) { /* ignore */ } this.pvFx = null; }
    if (this.renderer) { try { this.renderer.dispose(); } catch (e) { /* ignore */ } this.renderer = null; }
    if (this._prev != null) this._end();
    if (this.win && this.win.parentNode) this.win.parentNode.removeChild(this.win);
    if (_inst === this) _inst = null;
    if (this.ed && this.ed.refreshProps) this.ed.refreshProps();
  }

  /* ============================================================
     实时预览（复用游戏同款 FX 着色器 → 所见即所得）
     ============================================================ */
  _initPreview() {
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
      renderer.setClearColor(0x0a0d16, 1);
      this.prev.appendChild(renderer.domElement);
      this.renderer = renderer;
    } catch (e) {
      this.renderer = null;
    }
    if (!this.renderer) {
      this.prev.appendChild(el('div', { class: 'pm-nogl', text: '当前环境无法创建预览渲染器（图形功能不可用）。' }));
      return;
    }
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    cam.position.set(0, 0, 7);
    this.pvScene = scene;
    this.pvCam = cam;
    this.pvFx = new FX(scene, 160, { soft: !!this.o.soft });
    this._resizePreview();

    const loop = () => {
      if (this._closed) return;
      this._pvRAF = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.05, this._pvT ? (now - this._pvT) / 1000 : 0.016);
      this._pvT = now;
      this._pvStep(dt);
      this.renderer.render(scene, cam);
    };
    this._pvRAF = requestAnimationFrame(loop);
  }

  _resizePreview() {
    if (!this.renderer) return;
    const w = Math.max(80, this.prev.clientWidth || 260);
    const h = Math.max(80, this.prev.clientHeight || 300);
    this.renderer.setSize(w, h, false);
    if (this.pvCam) { this.pvCam.aspect = w / h; this.pvCam.updateProjectionMatrix(); }
  }

  _pvStep(dt) {
    const fx = this.pvFx;
    if (!fx) return;
    const e = this._entries()[this.sel];
    const life = Math.max(0.5, Number(this.o.life) || 1.6);
    const interval = life / 7;                 // 让 ~7 颗不同年龄的粒子同时在屏
    this.pvAcc += dt;
    const color = this.o.color || '#ffd98a';
    const size = Math.max(0.6, Math.min(3, Number(this.o.size) || 1.5));
    const alpha = Math.max(0.2, Math.min(1, Number(this.o.alpha) ?? 0.9));
    let guard = 0;
    while (this.pvAcc >= interval && guard++ < 8) {
      this.pvAcc -= interval;
      const opt = {
        color, size: size * (0.85 + Math.random() * 0.3), speed: 0, up: 0,
        life, gravity: 0, drag: 0, rise: 0, alpha,
      };
      if (e) { opt.tex = fx.texIndex(e.img); opt.anim = Number(e.anim) | 0; opt.seed = Math.random(); }
      fx.emit((Math.random() - 0.5) * 1.8, (Math.random() - 0.5) * 1.8, (Math.random() - 0.5) * 1.4, opt);
    }
    fx.update(dt);
  }

  /* ============================================================
     应用 / 撤销
     ============================================================ */
  _begin() { if (this._prev == null) this._prev = this.ed.snap(); }
  _end() {
    if (this._prev == null) return;
    const prev = this._prev;
    this._prev = null;
    this.ed.record('粒子条目', prev, { props: true });
  }
  /** 结构性改动（增删 / 排序 / 开关）：一次撤销 + 重画面板 */
  _structural(label, fn) {
    this.ed.edit(label, fn, { props: true });
    this.refresh();
  }

  /* ============================================================
     列表 + 参数
     ============================================================ */
  refresh() {
    this._buildList();
    this._buildParams();
  }

  _thumbFor(img) {
    const c = el('canvas', { class: 'pm-thumb', width: 34, height: 34 });
    const x = c.getContext('2d');
    x.clearRect(0, 0, 34, 34);
    let src = null;
    if (isParticleBuiltin(img)) {
      const t = getParticleSprite(img);
      src = t && t.image;
    }
    if (src) { try { x.drawImage(src, 2, 2, 30, 30); } catch (e) { /* ignore */ } }
    else {
      x.fillStyle = 'rgba(255,255,255,.22)';
      x.beginPath(); x.arc(17, 17, 7, 0, Math.PI * 2); x.fill();
    }
    return c;
  }

  _buildList() {
    clear(this.listEl);
    const entries = this._entries();
    if (!entries.length) {
      this.listEl.appendChild(el('div', { class: 'pm-empty', text: '还没有粒子条目。下方选好图像与动画后添加。' }));
      return;
    }
    entries.forEach((e, i) => {
      const r = el('div', { class: 'pm-row' + (i === this.sel ? ' sel' : '') + (e.on === false ? ' off' : '') });
      r.appendChild(this._thumbFor(e.img));
      r.appendChild(el('div', { class: 'pm-rowmain' },
        el('div', { class: 'pm-name', text: (i + 1) + '. ' + particleEntrySummary(e) })));
      r.appendChild(el('div', { class: 'pm-acts' },
        el('button', {
          class: 'mini', text: e.on === false ? '·' : '👁', title: '启用 / 停用该条目',
          onclick: (ev) => { ev.stopPropagation(); this._structural('粒子条目开关', () => { e.on = e.on === false; }); },
        }),
        el('button', {
          class: 'mini', text: '↑', title: '上移',
          onclick: (ev) => { ev.stopPropagation(); this._move(i, -1); },
        }),
        el('button', {
          class: 'mini', text: '↓', title: '下移',
          onclick: (ev) => { ev.stopPropagation(); this._move(i, 1); },
        }),
        el('button', {
          class: 'mini danger', text: '✕', title: '删除该条目',
          onclick: (ev) => { ev.stopPropagation(); this._remove(i); },
        })));
      r.addEventListener('click', () => { this.sel = i; this.refresh(); });
      this.listEl.appendChild(r);
    });
  }

  _move(i, d) {
    const entries = this._entries();
    const j = i + d;
    if (j < 0 || j >= entries.length) return;
    this._structural('粒子条目排序', () => {
      const [e] = entries.splice(i, 1);
      entries.splice(j, 0, e);
      this.sel = j;
    });
  }

  _remove(i) {
    this._structural('删除粒子条目', () => {
      this._entries().splice(i, 1);
      const n = this._entries().length;
      this.sel = Math.max(0, Math.min(this.sel, n - 1));
    });
  }

  _buildParams() {
    clear(this.midEl);
    const e = this._entries()[this.sel];
    if (!e) {
      this.midEl.appendChild(el('div', { class: 'pm-empty', text: '选中一个条目以编辑参数。' }));
      return;
    }
    this.midEl.appendChild(el('div', { class: 'pm-title', text: '条目 ' + (this.sel + 1) }));

    this.midEl.appendChild(row('启用', swtch(e.on !== false, (v) => {
      this._structural('粒子条目开关', () => { e.on = !!v; });
    })));

    /* 图像（内置 20 种 / 导入素材） */
    const loader = particleImageLoader(() => e.img);
    const imgSel = new GridSelect({
      value: e.img, cls: 'inp', group: assetGroupSpec(),
      options: loader,
      onChange: async (v) => { await ensureTexture(v); this._structural('粒子图像', () => { e.img = v; }); },
    });
    this.midEl.appendChild(row('图像', imgSel,
      el('button', {
        class: 'mini', text: '＋图', title: '导入图片作为粒子图像',
        onclick: async () => {
          const rec = await importAssetFile('texture', { ed: this.ed });
          if (!rec) return;
          invalidateAssetOptions('texture');
          const v = 'asset:' + rec.id;
          await ensureTexture(v);
          imgSel.setOptions(loader);
          imgSel.setValue(v);
          this._structural('粒子图像', () => { e.img = v; });
        },
      })));

    /* 扭曲 / 蒙版动画 */
    const animSel = new GridSelect({
      value: String(e.anim | 0), cls: 'inp',
      options: PARTICLE_ANIMS.map((a) => ({ v: String(a.v), l: a.l })),
      onChange: (v) => { this._structural('粒子动画', () => { e.anim = Math.max(0, Math.min(PARTICLE_ANIM_COUNT - 1, Number(v) | 0)); }); },
    });
    this.midEl.appendChild(row('扭曲动画', animSel));

    /* 抽取权重（同一发射里按权重随机挑条目） */
    const wInp = numInput(e.weight, { min: 0, st: 0.1 });
    const setW = (v) => {
      const n = Number(v);
      if (!isFinite(n) || n < 0) return false;
      this._begin();
      e.weight = n;
      this._syncRow();
      return true;
    };
    wInp.addEventListener('input', () => { setW(wInp.value); });
    wInp.addEventListener('change', () => { if (setW(wInp.value)) wInp.value = e.weight; this._end(); this._buildList(); });
    wInp.addEventListener('blur', () => { wInp.value = e.weight; this._end(); });
    attachNumWheel(wInp, {
      min: 0, step: 0.1,
      onStep: (v) => { setW(v); wInp.value = e.weight; },
      onEnd: () => { this._end(); this._buildList(); },
    });
    this.midEl.appendChild(row('权重', wInp));

    if (!isParticleBuiltin(e.img)) {
      this.midEl.appendChild(el('div', {
        class: 'pm-hint',
        text: '该条使用导入素材图像；导入资源会在使用它的存档里自动本地化打包。',
      }));
    }
  }

  /** 参数变化时只刷新列表里的摘要文字，避免整块重建打断输入焦点 */
  _syncRow() {
    const rows = this.listEl.querySelectorAll('.pm-row');
    const r = rows[this.sel];
    if (!r) return;
    const sub = r.querySelector('.pm-name');
    const e = this._entries()[this.sel];
    if (sub && e) sub.textContent = (this.sel + 1) + '. ' + particleEntrySummary(e);
  }
}