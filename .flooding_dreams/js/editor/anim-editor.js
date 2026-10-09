/* ============================================================
   动画编辑器：补间时间线
   - 轨道 = { objectId, property, type, keys:[{t,v,easing}] }
   - 支持 number / vec3 / bool / color 四种关键帧数值
   - 试播使用独立 AnimationSystem，结束/停止时还原对象状态
   ============================================================ */
import { el, clear, toast, promptBox } from '../ui/dom.js';
import { createAnimation, createTrack } from '../world/events.js';
import { AnimationSystem, ANIM_PROPS, propType, defaultValue, sampleTrack, sortKeys } from '../world/animations.js';
import { optSelect, popover, closePopover, contextMenu, swtch } from './widgets.js';
import { getObject, objectLabel } from '../world/level.js';
import { EASINGS, EASING_LABELS, EASING_BEZIERS, PALETTE } from '../config.js';
import { cubicBezier } from '../core/util.js';

/** 自定义曲线弹窗默认控制点 */
const DEFAULT_CURVE = [0.42, 0, 0.58, 1];

/** 缓动名 → 预设曲线控制点（用于在弹窗里回填） */
function curveOf(easing) {
  const p = EASING_BEZIERS.find((x) => x.id === easing);
  return p ? p.v.slice() : DEFAULT_CURVE.slice();
}

/**
 * 自定义缓动曲线窗口（可拖动，独立于关键帧浮层）
 * opts: { curve:[x1,y1,x2,y2], onApply(curve), onClose() }
 */
let _ezWin = null;
function openEaseWindow(opts = {}) {
  if (_ezWin) { _ezWin.close(); _ezWin = null; }
  const curve = (Array.isArray(opts.curve) && opts.curve.length >= 4 ? opts.curve.slice(0, 4) : DEFAULT_CURVE.slice()).map(Number);

  const cv = el('canvas', { class: 'ez-canvas', width: 264, height: 264 });
  const ctx = cv.getContext('2d');
  const demo = el('div', { class: 'ez-demo' });
  const dot = el('div', { class: 'ez-dot' });
  demo.appendChild(dot);
  const numInps = [];

  const win = el('div', { class: 'ez-win' });
  const head = el('div', { class: 'ez-head' },
    el('span', { class: 'ez-title', text: '缓动曲线' }),
    el('span', { class: 'ez-sub', text: '拖动画布上的两个手柄调整曲线' }),
    el('button', { class: 'ez-x', text: '✕', title: '关闭', onclick: () => close() }));
  const bodyEl = el('div', { class: 'ez-body' });
  win.appendChild(head);
  win.appendChild(bodyEl);

  /* ---------- 画布绘制 ---------- */
  const PAD = 30;
  const yMin = -0.5, yMax = 1.5;
  const px = (x) => PAD + x * (cv.width - PAD * 2);
  const py = (y) => PAD + (1 - (y - yMin) / (yMax - yMin)) * (cv.height - PAD * 2);

  function draw() {
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    /* 网格 */
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gx = px(i / 4), gy = py(i / 4 * 1 + 0);
      ctx.beginPath(); ctx.moveTo(gx, PAD); ctx.lineTo(gx, h - PAD); ctx.stroke();
      const v = yMin + (i / 4) * (yMax - yMin);
      ctx.beginPath(); ctx.moveTo(PAD, py(v)); ctx.lineTo(w - PAD, py(v)); ctx.stroke();
    }
    /* 0/1 参考线 */
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath(); ctx.moveTo(PAD, py(0)); ctx.lineTo(w - PAD, py(0)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD, py(1)); ctx.lineTo(w - PAD, py(1)); ctx.stroke();
    /* 线性参考对角线 */
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(px(0), py(0)); ctx.lineTo(px(1), py(1)); ctx.stroke();
    ctx.setLineDash([]);
    /* 控制线 */
    ctx.strokeStyle = 'rgba(127,227,255,.4)';
    ctx.beginPath(); ctx.moveTo(px(0), py(0)); ctx.lineTo(px(curve[0]), py(curve[1])); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px(1), py(1)); ctx.lineTo(px(curve[2]), py(curve[3])); ctx.stroke();
    /* 曲线 */
    ctx.strokeStyle = '#7fe3ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 100; i++) {
      const u = i / 100;
      const bx = 3 * curve[0] * u * (1 - u) * (1 - u) + 3 * curve[2] * u * u * (1 - u) + u * u * u;
      const by = 3 * curve[1] * u * (1 - u) * (1 - u) + 3 * curve[3] * u * u * (1 - u) + u * u * u;
      const x = px(bx), y = py(by);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    /* 端点 */
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    for (const [ax, ay] of [[0, 0], [1, 1]]) {
      ctx.beginPath(); ctx.arc(px(ax), py(ay), 3.5, 0, Math.PI * 2); ctx.fill();
    }
    /* 手柄 */
    ctx.fillStyle = '#ffd98a';
    ctx.beginPath(); ctx.arc(px(curve[0]), py(curve[1]), 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff9ecb';
    ctx.beginPath(); ctx.arc(px(curve[2]), py(curve[3]), 6, 0, Math.PI * 2); ctx.fill();
    /* 当前进度标记 */
    if (_phase !== null) {
      const ey = cubicBezier(curve[0], curve[1], curve[2], curve[3], _phase);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(px(_phase), py(ey), 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  /* ---------- 手柄拖拽 ---------- */
  let dragIdx = -1;
  /** 屏幕坐标 → 画布坐标（画布 CSS 尺寸可能被拉伸） */
  const toCanvas = (e) => {
    const r = cv.getBoundingClientRect();
    return [(e.clientX - r.left) * (cv.width / Math.max(1, r.width)),
      (e.clientY - r.top) * (cv.height / Math.max(1, r.height))];
  };
  const toCurve = (e) => {
    const [mx, my] = toCanvas(e);
    const x = (mx - PAD) / (cv.width - PAD * 2);
    const y = yMin + (1 - (my - PAD) / (cv.height - PAD * 2)) * (yMax - yMin);
    return [Math.max(0, Math.min(1, x)), Math.max(yMin, Math.min(yMax, y))];
  };
  cv.addEventListener('pointerdown', (e) => {
    const [mx, my] = toCanvas(e);
    const d1 = Math.hypot(mx - px(curve[0]), my - py(curve[1]));
    const d2 = Math.hypot(mx - px(curve[2]), my - py(curve[3]));
    dragIdx = d1 <= d2 ? 0 : 1;
    if (Math.min(d1, d2) > 24) { dragIdx = -1; return; }
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    syncFromDrag(e);
    e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => { if (dragIdx >= 0) syncFromDrag(e); });
  const endDrag = () => { dragIdx = -1; };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);

  function syncFromDrag(e) {
    const [x, y] = toCurve(e);
    curve[dragIdx * 2] = Math.round(x * 1000) / 1000;
    curve[dragIdx * 2 + 1] = Math.round(y * 1000) / 1000;
    syncNums();
    draw();
  }

  /* ---------- 数值输入 ---------- */
  const nums = el('div', { class: 'ez-nums' });
  [['P1 X', 0, 0, 1], ['P1 Y', 1, -0.5, 1.5], ['P2 X', 2, 0, 1], ['P2 Y', 3, -0.5, 1.5]].forEach(([lab, i, mn, mx]) => {
    const inp = el('input', {
      class: 'inp', type: 'number', step: 0.01, min: mn, max: mx, value: curve[i],
      oninput: () => {
        let v = Number(inp.value);
        if (!isFinite(v)) return;
        curve[i] = Math.max(mn, Math.min(mx, v));
        draw();
      },
      onchange: () => { inp.value = curve[i]; },
    });
    numInps.push(inp);
    nums.appendChild(el('label', {}, el('span', { text: lab }), inp));
  });

  function syncNums() { numInps.forEach((inp, i) => { inp.value = curve[i]; }); }

  /* ---------- 预设 ---------- */
  const presets = el('div', { class: 'ez-presets' });
  for (const p of EASING_BEZIERS) {
    presets.appendChild(el('button', {
      class: 'mini', text: p.label,
      onclick: () => { curve.length = 0; curve.push(...p.v); syncNums(); draw(); },
    }));
  }

  /* ---------- 预览动画 ---------- */
  let _phase = null;
  let raf = 0;
  const start = performance.now();
  const tick = () => {
    _phase = ((performance.now() - start) % 1400) / 1400;
    const eased = cubicBezier(curve[0], curve[1], curve[2], curve[3], _phase);
    const dw = demo.clientWidth || 260, dh = demo.clientHeight || 34;
    dot.style.left = (6 + _phase * (dw - 12)) + 'px';
    dot.style.top = (6 + (1 - Math.max(0, Math.min(1, eased))) * (dh - 12)) + 'px';
    draw();
    raf = requestAnimationFrame(tick);
  };

  /* ---------- 按钮 ---------- */
  const foot = el('div', { class: 'ez-foot' },
    el('button', { class: 'mbtn sm', text: '取消', onclick: () => close() }),
    el('button', {
      class: 'mbtn sm primary', text: '应用曲线',
      onclick: () => { if (opts.onApply) opts.onApply(curve.slice()); close(); },
    }));
  bodyEl.appendChild(cv);
  bodyEl.appendChild(presets);
  bodyEl.appendChild(nums);
  bodyEl.appendChild(el('div', { class: 'ez-label', text: '预览' }));
  bodyEl.appendChild(demo);
  bodyEl.appendChild(foot);

  /* ---------- 拖拽移动 ---------- */
  const host = document.getElementById('app') || document.body;
  host.appendChild(win);
  const w = win.offsetWidth || 300, h = win.offsetHeight || 420;
  let left = window.innerWidth - w - 300, top = 96;
  if (opts.anchor) {
    const r = opts.anchor.getBoundingClientRect();
    left = r.right + 12;
    top = r.top;
  }
  win.style.left = Math.max(8, Math.min(window.innerWidth - w - 12, left)) + 'px';
  win.style.top = Math.max(8, Math.min(window.innerHeight - h - 12, top)) + 'px';
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    win.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx)) + 'px';
    win.style.top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - drag.dy)) + 'px';
  });
  const endMove = () => { drag = null; };
  head.addEventListener('pointerup', endMove);
  head.addEventListener('pointercancel', endMove);

  const onKey = (e) => {
    if (e.code !== 'Escape') return;
    // 有 #modal（GridSelect 选择器 / 确认框）在显示时交给它处理，避免一次 Esc 连本窗口一起关掉
    const m = document.getElementById('modal');
    if (m && !m.classList.contains('hidden')) return;
    e.stopPropagation(); close();
  };
  window.addEventListener('keydown', onKey, true);

  function close() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener('keydown', onKey, true);
    win.remove();
    if (_ezWin && _ezWin.win === win) _ezWin = null;
    if (opts.onClose) opts.onClose();
  }

  syncNums();
  draw();
  raf = requestAnimationFrame(tick);
  _ezWin = { win, close, curve };
  return _ezWin;
}

/** 关闭缓动曲线窗口（离开动画页签 / 退出编辑器时调用） */
export function closeEaseWindow() {
  if (_ezWin) { _ezWin.close(); _ezWin = null; }
}

const KEY_SNAP = 0.05;

/* 节拍吸附：细分数只能是 1/4、1/8、1/16 音符 */
const BEAT_DIVS = [4, 8, 16];
const BEAT_DIV_LABELS = { 4: '1/4 音符', 8: '1/8 音符', 16: '1/16 音符' };
const DEFAULT_BPM = 120;
const DEFAULT_BEAT_DIV = 4;

function propLabel(p) {
  const map = {
    position: '位置', rotation: '旋转', scale: '缩放', color: '颜色', transparency: '透明度',
    metalness: '金属度', roughness: '粗糙度', emissiveIntensity: '自发光', fillLevel: '液面',
    intensity: '灯光强度', visible: '可见', opacity: '不透明度',
  };
  return map[p] || p;
}
function clone(v) { return Array.isArray(v) ? v.slice() : v; }

export class AnimEditor {
  constructor(ed) {
    this.ed = ed;
    this.cur = null;              // 当前动画 id
    this.curTrack = -1;
    this.curKey = -1;
    this.t = 0;                   // 播放头时间
    this.zoom = 1;
    this.playing = false;
    this.preview = true;          // 试播/拖动时临时修改对象
    this._prev = null;
    this._sys = null;
    this._sysBuilder = null;
    this._raf = 0;
    this._last = 0;

    /* ---------- 结构 ---------- */
    this.el = el('div', { class: 'tl' });

    this.selAnim = optSelect([{ v: '', l: '（无动画）' }], '', (v) => {
      this._stopPlay();
      this.cur = v || null;
      this.curTrack = -1;
      this.curKey = -1;
      this.t = 0;
      this.refresh();
    });
    this.nameInp = el('input', { class: 'inp', type: 'text', value: '', onchange: (e) => this._rename(e.target.value) });
    this.durInp = el('input', { class: 'inp', type: 'number', step: 0.1, min: 0.1, max: 600, value: 2, onchange: (e) => this._setDur(e.target.value) });
    this.zoomInp = el('input', { class: 'inp', type: 'range', min: 0.3, max: 3, step: 0.1, value: 1, oninput: (e) => { this.zoom = Number(e.target.value) || 1; this._renderLanes(); } });
    this.playBtn = el('button', { class: 'mini tlb', text: '▶ 试播', title: '空格试播', onclick: () => this.togglePlay() });

    /* 节拍吸附设置：BPM / 细分（最细 1/16 音符）；按住 Alt 临时进入「不对齐」模式 */
    this._alt = false;
    window.addEventListener('keydown', (e) => { if (e.key === 'Alt') this._alt = true; });
    window.addEventListener('keyup', (e) => { if (e.key === 'Alt') this._alt = false; });
    window.addEventListener('blur', () => { this._alt = false; });
    this.beatBtn = this._toggleBtn('♩ 节拍吸附', () => this._beatSnap(), (v) => this._setBeat('beatSnap', v));
    this.bpmInp = el('input', {
      class: 'inp', type: 'number', min: 20, max: 400, step: 1, value: DEFAULT_BPM, title: '每分钟拍数（BPM）',
      onchange: (e) => this._setBeat('bpm', Math.min(400, Math.max(20, Math.round(Number(e.target.value) || DEFAULT_BPM)))),
    });
    this.divSel = optSelect(
      BEAT_DIVS.map((d) => ({ v: String(d), l: BEAT_DIV_LABELS[d] })),
      String(DEFAULT_BEAT_DIV),
      (v) => this._setBeat('beatDiv', Number(v)));

    this.bar = el('div', { class: 'tl-bar' },
      el('span', { class: 'ph-lab', text: '动画' }), this.selAnim,
      el('button', { class: 'mini', text: '＋', title: '新建动画', onclick: () => this.addAnim() }),
      el('button', { class: 'mini', text: '🗑', title: '删除动画', onclick: () => this.delAnim() }),
      el('span', { class: 'ph-lab', text: '名称' }), this.nameInp,
      el('span', { class: 'ph-lab', text: '时长' }), this.durInp,
      this.playBtn,
      el('button', { class: 'mini', text: '■', title: '回到起点', onclick: () => { this._stopPlay(); this.t = 0; this._renderLanes(); } }),
      el('span', { class: 'ph-lab', text: '缩放' }), this.zoomInp,
      el('span', { class: 'ph-lab', text: 'BPM' }), this.bpmInp, this.divSel, this.beatBtn,
      el('span', { class: 'ph-lab tl-alt-hint', text: '按住 Alt 不对齐' }));

    const loops = el('span', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginLeft: '6px' } });
    this.loopBtn = this._toggleBtn('循环', () => !!this._anim() && !!this._anim().loop, (v) => this._setFlag('loop', v));
    this.pingBtn = this._toggleBtn('往返', () => !!this._anim() && !!this._anim().pingpong, (v) => this._setFlag('pingpong', v));
    this.autoBtn = this._toggleBtn('自动播放', () => !!this._anim() && !!this._anim().autoplay, (v) => this._setFlag('autoplay', v));
    this.pvBtn = this._toggleBtn('实时预览', () => this.preview, (v) => { this.preview = v; if (!v) this._restorePreview(); });
    loops.appendChild(this.loopBtn);
    loops.appendChild(this.pingBtn);
    loops.appendChild(this.autoBtn);
    loops.appendChild(this.pvBtn);
    this.bar.appendChild(loops);

    this.trackList = el('div', { class: 'tl-tracks' });
    this.lanes = el('div', { class: 'tl-lanes' });
    this.main = el('div', { class: 'tl-main' }, this.trackList, this.lanes);

    this.el.appendChild(this.bar);
    this.el.appendChild(this.main);

    this._bindLanes();
    this.refresh();
  }

  onShow() { this.refresh(); }

  _anim() {
    const lv = this.ed.level;
    if (!lv || !this.cur) return null;
    return (lv.animations || []).find((a) => a.id === this.cur) || null;
  }

  _toggleBtn(label, get, set) {
    const b = el('button', { class: 'mini' + (get() ? ' on' : ''), text: label, title: label });
    b.addEventListener('click', () => {
      set(!get());
      b.classList.toggle('on', get());
    });
    return b;
  }

  /* ============================================================
     节拍吸附（BPM Beats，最细 1/16 音符）
     ============================================================ */
  /** 当前动画的节拍参数：period=一拍（1/4 音符）时长，step=细分步长 */
  _beat() {
    const an = this._anim();
    if (!an) return null;
    const bpm = Math.min(400, Math.max(20, Number(an.bpm) || DEFAULT_BPM));
    const div = BEAT_DIVS.includes(Number(an.beatDiv)) ? Number(an.beatDiv) : DEFAULT_BEAT_DIV;
    const period = 60 / bpm;              // 四分音符 = 一拍
    return { bpm, div, period, step: period * (4 / div) };
  }

  /** 是否开启节拍吸附（默认开） */
  _beatSnap() {
    const an = this._anim();
    return !!(an && an.beatSnap !== false);
  }

  /** 时间吸附：free=true（按住 Alt）时不对齐；否则按节拍网格，无动画时退回 KEY_SNAP */
  _snap(t, free) {
    const x = Math.max(0, Number(t) || 0);
    if (free) return x;
    const b = this._beat();
    if (!b || !this._beatSnap()) return Math.round(x / KEY_SNAP) * KEY_SNAP;
    return Math.max(0, Math.round(Math.round(x / b.step) * b.step * 10000) / 10000);
  }

  _setBeat(k, v) {
    const an = this._anim();
    if (!an) return;
    this.ed.edit('修改节拍设置', () => { an[k] = v; }, {});
    this.refresh();
  }

  /** 节拍网格背景（拍=亮线，细分=暗线）；线太密或未开启吸附时返回 null */
  _beatGrid(pps) {
    const b = this._beat();
    if (!b || !this._beatSnap()) return null;
    const periodPx = b.period * pps;
    const stepPx = b.step * pps;
    const layers = [];
    if (periodPx >= 4) layers.push(`repeating-linear-gradient(90deg,rgba(127,227,255,.28) 0 1px,transparent 1px ${periodPx}px)`);
    if (stepPx >= 4 && stepPx < periodPx - 0.5) layers.push(`repeating-linear-gradient(90deg,rgba(255,255,255,.10) 0 1px,transparent 1px ${stepPx}px)`);
    if (!layers.length) return null;
    return { image: layers.join(','), position: '0 0' };
  }

  /* ============================================================
     动画增删改
     ============================================================ */
  addAnim() {
    const ed = this.ed;
    const lv = ed.level;
    if (!lv) return;
    const an = createAnimation('动画 ' + ((lv.animations || []).length + 1));
    ed.edit('新建动画', () => { lv.animations.push(an); }, {});
    this.cur = an.id;
    this.refresh();
    ed.log('新建动画：' + an.name, 'ok');
  }

  delAnim() {
    const an = this._anim();
    if (!an) return;
    const ed = this.ed;
    ed.edit('删除动画', () => {
      const i = ed.level.animations.indexOf(an);
      if (i >= 0) ed.level.animations.splice(i, 1);
    }, {});
    this.cur = null;
    this.refresh();
  }

  async _rename(name) {
    const an = this._anim();
    if (!an) return;
    this.ed.edit('重命名动画', () => { an.name = name || '动画'; }, {});
    this.refresh();
  }

  _setDur(v) {
    const an = this._anim();
    if (!an) return;
    const d = Math.max(0.1, Number(v) || 1);
    this.ed.edit('修改时长', () => { an.duration = Math.round(d * 100) / 100; }, {});
    this.refresh();
  }

  _setFlag(k, v) {
    const an = this._anim();
    if (!an) return;
    this.ed.edit('修改动画设置', () => { an[k] = !!v; }, {});
    this.refresh();
  }

  /* ============================================================
     轨道
     ============================================================ */
  addTrackFor(prop) {
    const ed = this.ed;
    const an = this._anim();
    if (!an) { toast('先新建/选择一个动画'); return; }
    const ids = [...ed.selection];
    if (!ids.length) { toast('先在视口或对象树里选中对象'); return; }
    const type = propType(prop);
    ed.edit('新建轨道', () => {
      for (const id of ids) {
        if (an.tracks.some((t) => t.objectId === id && t.property === prop)) continue;
        const o = getObject(ed.level, id);
        const track = createTrack(id);
        track.property = prop;
        track.type = type;
        const base = o && o[prop] !== undefined ? o[prop] : defaultValue(prop);
        track.keys = [{ t: 0, v: clone(base), easing: 'easeInOut' }];
        an.tracks.push(track);
      }
    }, {});
    this.curTrack = an.tracks.length - 1;
    this.refresh();
  }

  delTrack(i) {
    const an = this._anim();
    if (!an || !an.tracks[i]) return;
    const ed = this.ed;
    ed.edit('删除轨道', () => { an.tracks.splice(i, 1); }, {});
    if (this.curTrack >= an.tracks.length) this.curTrack = an.tracks.length - 1;
    this.refresh();
  }

  _propPicker(anchor) {
    const body = el('div', {});
    body.appendChild(el('div', { class: 'pg-head', style: { cursor: 'default' }, text: '选择一个属性（作用于选中对象）' }));
    const grid = el('div', { class: 'pgrid' });
    for (const p of ANIM_PROPS) {
      grid.appendChild(el('button', {
        class: 'pitem', title: p,
        onclick: () => { closePopover(); this.addTrackFor(p); },
      }, el('b', { text: p === 'position' ? '➡' : p === 'rotation' ? '⟳' : p === 'scale' ? '⤢' : p === 'color' ? '🎨' : '◐' }),
        el('i', { text: propLabel(p) })));
    }
    body.appendChild(grid);
    popover({ title: '新建轨道', body, anchor, width: 320 });
  }

  /* ============================================================
     关键帧
     ============================================================ */
  _keys() {
    const an = this._anim();
    if (!an || !an.tracks[this.curTrack]) return null;
    return an.tracks[this.curTrack].keys;
  }

  addKeyAt(t, trackIndex, free) {
    const an = this._anim();
    if (!an) return;
    const ti = trackIndex === undefined ? this.curTrack : trackIndex;
    const tr = an.tracks[ti];
    if (!tr) return;
    const ed = this.ed;
    const st = this._snap(t, free);
    const rec = ed.builder && ed.builder.objects.get(tr.objectId);
    let v;
    if (tr.keys.length) v = clone(sampleTrack(tr, st) ?? defaultValue(tr.property));
    else v = clone(rec && rec.o[tr.property] !== undefined ? rec.o[tr.property] : defaultValue(tr.property));
    if (tr.type === 'number' && typeof v === 'string') v = 0;
    if (tr.type === 'bool') v = !!v;
    ed.edit('添加关键帧', () => {
      tr.keys.push({ t: st, v, easing: 'easeInOut' });
      sortKeys(tr);
    }, {});
    this.curTrack = ti;
    this.refresh();
    this._selectKeyNearest(st);
  }

  _selectKeyNearest(t) {
    const keys = this._keys();
    if (!keys || !keys.length) { this.curKey = -1; return; }
    let best = 0;
    for (let i = 1; i < keys.length; i++) {
      if (Math.abs(keys[i].t - t) < Math.abs(keys[best].t - t)) best = i;
    }
    this.curKey = best;
    this._renderLanes();
  }

  delKey(ti, ki) {
    const an = this._anim();
    if (!an || !an.tracks[ti]) return;
    const ed = this.ed;
    ed.edit('删除关键帧', () => { an.tracks[ti].keys.splice(ki, 1); }, {});
    this.curKey = -1;
    this.refresh();
  }

  editKey(ti, ki, anchor) {
    const an = this._anim();
    const tr = an && an.tracks[ti];
    const k = tr && tr.keys[ki];
    if (!k) return;
    const ed = this.ed;
    const body = el('div', {});
    const commit = (label, fn) => {
      const prev = ed.snap();
      fn();
      ed.record(label, prev);
      this.refresh();
    };
    /* 时间（跟随节拍吸附：开启时按细分网格对齐） */
    const kStep = (this._beatSnap() && this._beat()) ? this._beat().step : KEY_SNAP;
    body.appendChild(el('div', { class: 'prow' },
      el('label', { text: '时间' }),
      el('div', { class: 'f' }, el('input', {
        type: 'number', step: kStep, min: 0, value: k.t,
        onchange: (e) => { commit('修改关键帧时间', () => { k.t = this._snap(Number(e.target.value) || 0, false); sortKeys(tr); }); closeAll(); },
      }))));
    /* 数值 */
    body.appendChild(this._valueEditor(tr, k, commit));
    /* 缓动（预设 + 自定义曲线） */
    const easeWrap = el('div', { class: 'f', style: { display: 'flex', gap: '5px', alignItems: 'center' } });
    const easeOpts = EASINGS.map((x) => ({ v: x, l: EASING_LABELS[x] || x }));
    easeOpts.push({ v: 'custom', l: EASING_LABELS.custom });
    const easeSel = optSelect(easeOpts, k.easing || 'linear', (v) => {
      if (v === 'custom') {
        this._easeWindow(k, commit, easeWrap, () => {
          easeSel.setValue(k.easing === 'custom' ? 'custom' : (k.easing || 'linear'));
        });
        return;
      }
      commit('修改缓动', () => { k.easing = v; });
    });
    easeSel.el.style.flex = '1';
    const curveBtn = el('button', {
      class: 'mini', text: '◠ 编辑曲线', title: '打开缓动曲线窗口',
      onclick: () => this._easeWindow(k, commit, easeWrap),
    });
    easeWrap.appendChild(easeSel.el);
    easeWrap.appendChild(curveBtn);
    body.appendChild(el('div', { class: 'prow' }, el('label', { text: '缓动' }), easeWrap));
    body.appendChild(el('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
      el('button', { class: 'mini', text: '🗑 删除关键帧', onclick: () => { this.delKey(ti, ki); closeAll(); } })));
    const p = popover({ title: '关键帧 · ' + propLabel(tr.property), body, anchor, width: 250 });
    function closeAll() { p && p.remove(); }
  }

  /** 打开自定义缓动曲线窗口（独立窗口，可拖动） */
  _easeWindow(k, commit, anchor, onClose) {
    const cur = k.easing === 'custom' && Array.isArray(k.ease) ? k.ease.slice(0, 4) : curveOf(k.easing);
    openEaseWindow({
      curve: cur,
      anchor,
      onApply: (c) => commit('修改缓动曲线', () => { k.easing = 'custom'; k.ease = c.slice(); }),
      onClose,
    });
  }

  _valueEditor(tr, k, commit) {
    const wrap = el('div', { class: 'prow' }, el('label', { text: '数值' }));
    const f = el('div', { class: 'f' });
    if (tr.type === 'vec3') {
      wrap.className = 'vecrow';
      const vs = el('div', { class: 'vs' });
      if (!Array.isArray(k.v)) k.v = [0, 0, 0];
      ['X', 'Y', 'Z'].forEach((ax, i) => {
        vs.appendChild(el('div', { class: 'vw' }, el('label', { text: ax }),
          el('input', {
            type: 'number', step: 0.5, value: k.v[i],
            onchange: (e) => commit('修改数值', () => { k.v[i] = Number(e.target.value) || 0; }),
          })));
      });
      wrap.appendChild(vs);
      return wrap;
    }
    if (tr.type === 'bool') {
      f.appendChild(swtch(!!k.v, (v) => commit('修改数值', () => { k.v = v; })));
      wrap.appendChild(f);
      return wrap;
    }
    if (tr.type === 'color') {
      f.appendChild(el('input', {
        type: 'color', value: typeof k.v === 'string' && k.v[0] === '#' ? k.v : '#ffffff',
        onchange: (e) => commit('修改数值', () => { k.v = e.target.value; }),
      }));
      const bar = el('div', { class: 'colorbar', style: { flex: '1' } });
      for (const c of PALETTE.slice(0, 12)) {
        bar.appendChild(el('div', { class: 'sw', title: c, style: { background: c }, onclick: () => commit('修改数值', () => { k.v = c; }) }));
      }
      f.appendChild(bar);
      wrap.appendChild(f);
      return wrap;
    }
    f.appendChild(el('input', {
      type: 'number', step: 0.1, value: Number(k.v) || 0,
      onchange: (e) => commit('修改数值', () => { k.v = Number(e.target.value) || 0; }),
    }));
    wrap.appendChild(f);
    return wrap;
  }

  /* ============================================================
     渲染
     ============================================================ */
  refresh() {
    const lv = this.ed.level;
    if (!lv) return;
    if (this.cur && !(lv.animations || []).some((a) => a.id === this.cur)) this.cur = null;
    if (!this.cur && (lv.animations || []).length) this.cur = lv.animations[0].id;

    /* 选择器 */
    const opts = (lv.animations || []).map((a) => ({ v: a.id, l: (a.name || a.id) + ' · ' + a.duration + 's' }));
    this.selAnim.setOptions([{ v: '', l: opts.length ? '（选择动画）' : '（无动画）' }].concat(opts));
    this.selAnim.setValue(this.cur || '');

    const an = this._anim();
    this.nameInp.value = an ? (an.name || '') : '';
    this.durInp.value = an ? an.duration : 2;
    this.nameInp.disabled = this.durInp.disabled = !an;
    if (this.loopBtn) this.loopBtn.classList.toggle('on', !!(an && an.loop));
    if (this.pingBtn) this.pingBtn.classList.toggle('on', !!(an && an.pingpong));
    if (this.autoBtn) this.autoBtn.classList.toggle('on', !!(an && an.autoplay));
    /* 节拍设置 */
    if (this.beatBtn) this.beatBtn.classList.toggle('on', this._beatSnap());
    if (this.bpmInp) {
      this.bpmInp.value = an ? (Number(an.bpm) || DEFAULT_BPM) : DEFAULT_BPM;
      this.bpmInp.disabled = !an;
    }
    if (this.divSel) {
      const div = an && BEAT_DIVS.includes(Number(an.beatDiv)) ? Number(an.beatDiv) : DEFAULT_BEAT_DIV;
      this.divSel.setValue(String(div));
      this.divSel.setDisabled(!an);
    }
    this.playBtn.textContent = this.playing ? '■ 停止' : '▶ 试播';

    this._renderTracks();
    this._renderLanes();
  }

  _renderTracks() {
    clear(this.trackList);
    const an = this._anim();
    if (!an) {
      this.trackList.appendChild(el('div', { class: 'tl-empty', text: '暂无动画' }));
      return;
    }
    /* 添加轨道的入口 */
    const addBtn = el('div', { class: 'tl-track', style: { color: 'var(--acc)' } },
      el('span', { style: { width: '12px' }, text: '＋' }),
      el('span', { class: 'sname', text: '新建轨道（作用于选中对象）' }));
    addBtn.addEventListener('click', (e) => this._propPicker(e.currentTarget));
    this.trackList.appendChild(addBtn);

    an.tracks.forEach((tr, i) => {
      const rec = this.ed.builder && this.ed.builder.objects.get(tr.objectId);
      const o = getObject(this.ed.level, tr.objectId);
      const rowEl = el('div', {
        class: 'tl-track' + (i === this.curTrack ? ' sel' : ''),
        title: (o ? objectLabel(o) : tr.objectId) + ' · ' + propLabel(tr.property) + ' · ' + tr.keys.length + ' 帧',
        onclick: () => { this.curTrack = i; this.refresh(); },
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: propLabel(tr.property) },
            { ico: '⌖', l: '选中该对象', fn: () => this.ed.select([tr.objectId]) },
            { ico: '＋', l: '在播放头添加关键帧', fn: () => this.addKeyAt(this.t, i, this._alt) },
            { ico: '⇥', l: '末帧添加关键帧', fn: () => this.addKeyAt(an.duration, i) },
            { sep: true },
            { ico: '🗑', l: '删除轨道', danger: true, fn: () => this.delTrack(i) },
          ]);
        },
      },
        el('span', { style: { width: '12px', color: 'var(--ink-faint)' }, text: '≡' }),
        el('span', { class: 'sname', text: rec ? objectLabel(rec.o) : (o ? objectLabel(o) : '（对象已删除）') }),
        el('span', { class: 'sprop', text: propLabel(tr.property) }),
        el('span', { class: 'rm', text: '✕', title: '删除轨道', onclick: (e) => { e.stopPropagation(); this.delTrack(i); } }));
      const nameEl = rowEl.querySelector('.sname');
      nameEl.addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        if (!o) return;
        const n = await promptBox('对象名称', o.name || '', { title: '重命名轨道对象' });
        if (n === null) return;
        this.ed.edit('重命名对象', () => { o.name = n; }, {});
        this.ed.refreshTree();
        this.refresh();
      });
      this.trackList.appendChild(rowEl);
    });
  }

  _renderLanes() {
    const an = this._anim();
    const scrollLeft = this.lanes.scrollLeft;
    const scrollTop = this.lanes.scrollTop;
    clear(this.lanes);
    if (!an) {
      this.lanes.appendChild(el('div', { class: 'tl-empty', text: '新建动画后即可编辑关键帧' }));
      return;
    }
    const pps = 62 * this.zoom;
    const dur = Math.max(0.2, an.duration || 2);
    const width = Math.max(dur * pps + 160, 420);
    this._pps = pps;

    /* 节拍网格背景（拍=亮线 / 细分=暗线），标尺与轨道行共用 */
    const grid = this._beatGrid(pps);
    const gridStyle = grid ? { backgroundImage: grid.image, backgroundPosition: grid.position } : {};

    /* 标尺 */
    const ruler = el('div', { class: 'tl-ruler', style: { width: width + 'px', ...gridStyle } });
    const step = pps >= 90 ? 0.5 : 1;
    for (let t = 0; t <= dur + 0.001; t += step) {
      ruler.appendChild(el('div', { class: 'tick', style: { left: (t * pps) + 'px' }, text: (t % 1 === 0 ? t + 's' : '') }));
    }
    this.lanes.appendChild(ruler);

    /* 轨道行 */
    an.tracks.forEach((tr, i) => {
      const lane = el('div', {
        class: 'tl-lane', style: { width: width + 'px', ...gridStyle },
        dataset: { ti: String(i) },
        oncontextmenu: (e) => {
          e.preventDefault();
          const t = this._tAt(e);
          contextMenu(e.clientX, e.clientY, [
            { label: propLabel(tr.property) + ' @ ' + t.toFixed(2) + 's' },
            { ico: '＋', l: '在此添加关键帧', fn: () => this.addKeyAt(t, i, this._alt) },
            { sep: true },
            { ico: '🗑', l: '删除轨道', danger: true, fn: () => this.delTrack(i) },
          ]);
        },
      });
      tr.keys.forEach((k, ki) => {
        const sel = i === this.curTrack && ki === this.curKey;
        const easeLab = EASING_LABELS[k.easing] || k.easing || 'linear';
        const keyEl = el('div', {
          class: 'tl-key' + (sel ? ' sel' : ''), style: { left: (k.t * pps) + 'px' },
          title: k.t.toFixed(2) + 's · ' + easeLab, dataset: { ti: String(i), ki: String(ki) },
        });
        lane.appendChild(keyEl);
      });
      this.lanes.appendChild(lane);
    });

    /* 播放头 */
    this.playEl = el('div', { class: 'tl-play', style: { left: (this.t * pps) + 'px' } });
    this.lanes.appendChild(this.playEl);
    this.lanes.scrollLeft = scrollLeft;
    this.lanes.scrollTop = scrollTop;
  }

  _tAt(e) {
    const r = this.lanes.getBoundingClientRect();
    return Math.max(0, (e.clientX - r.left + this.lanes.scrollLeft) / (this._pps || 62));
  }

  /** 取当前 DOM 里的关键帧元素（浮层定位锚点用；重绘后旧引用会失效） */
  _keyEl(ti, ki) {
    return this.lanes.querySelector(`.tl-key[data-ti="${ti}"][data-ki="${ki}"]`) || this.lanes;
  }

  /* ============================================================
     交互
     ============================================================ */
  _bindLanes() {
    let drag = null;
    this.lanes.addEventListener('pointerdown', (e) => {
      const keyEl = e.target.closest && e.target.closest('.tl-key');
      if (keyEl) {
        if (e.button === 2) return;
        this.curTrack = Number(keyEl.dataset.ti);
        this.curKey = Number(keyEl.dataset.ki);
        const an = this._anim();
        const tr = an.tracks[this.curTrack];
        drag = { ti: this.curTrack, ki: this.curKey, t0: tr.keys[this.curKey].t, x0: e.clientX, moved: false, prev: this.ed.snap() };
        keyEl.classList.add('sel');
        e.preventDefault();
        try { this.lanes.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }
      const lane = e.target.closest && e.target.closest('.tl-lane');
      if (lane) {
        this.curTrack = Number(lane.dataset.ti);
        this.curKey = -1;
        this._scrub(this._tAt(e));
        this._renderTracks();
        this._renderLanes();
        return;
      }
      /* 点标尺 → 移动播放头 */
      if (e.target.closest('.tl-ruler')) this._scrub(this._tAt(e));
    });

    this.lanes.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dh = (e.clientX - drag.x0) / (this._pps || 62);
      if (Math.abs(e.clientX - drag.x0) > 2) drag.moved = true;
      if (!drag.moved) return;
      const an = this._anim();
      const tr = an && an.tracks[drag.ti];
      if (!tr) return;
      const k = tr.keys[drag.ki];
      if (!k) return;
      k.t = this._snap(drag.t0 + dh, e.altKey || this._alt);   // 按住 Alt = 不对齐，自由放置
      tr.keys.sort((a, b) => a.t - b.t);
      drag.ki = tr.keys.indexOf(k);        // 排序后跟随同一个关键帧，避免拖到别的帧上
      this.curKey = drag.ki;               // 选中态一起跟随，拖过其它帧时高亮不跳错
      this._renderLanes();
      if (this.preview) this._applyAt(k.t);
    });

    const up = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.moved) {
        // 单击关键帧 → 直接打开关键帧编辑浮层（时间 / 数值 / 缓动 / 删除）
        this.curTrack = d.ti;
        this.curKey = d.ki;
        this._renderTracks();
        this._renderLanes();
        this.editKey(d.ti, d.ki, this._keyEl(d.ti, d.ki));
        return;
      }
      if (!d.prev) return;
      this.ed.record('移动关键帧', d.prev);
      this.ed.log('移动关键帧 → ' + this.t + 's', 'i');
    };
    this.lanes.addEventListener('pointerup', up);
    this.lanes.addEventListener('pointercancel', up);

    /* 右键关键帧：编辑 / 删除 */
    this.lanes.addEventListener('contextmenu', (e) => {
      const keyEl = e.target.closest && e.target.closest('.tl-key');
      const an = this._anim();
      if (!keyEl || !an) return;
      const ti = Number(keyEl.dataset.ti);
      const ki = Number(keyEl.dataset.ki);
      const tr = an.tracks[ti];
      const k = tr && tr.keys[ki];
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      this.curTrack = ti;
      this.curKey = ki;
      this._renderTracks();
      this._renderLanes();
      contextMenu(e.clientX, e.clientY, [
        { label: propLabel(tr.property) + ' @ ' + k.t.toFixed(2) + 's' },
        { ico: '✎', l: '编辑关键帧…', fn: () => this.editKey(ti, ki, this._keyEl(ti, ki)) },
        { ico: '🗑', l: '删除关键帧', danger: true, fn: () => this.delKey(ti, ki) },
      ]);
    });

    this.lanes.addEventListener('dblclick', (e) => {
      const lane = e.target.closest && e.target.closest('.tl-lane');
      if (!lane) return;
      const ti = Number(lane.dataset.ti);
      const keyEl = e.target.closest('.tl-key');
      if (keyEl) { this.editKey(ti, Number(keyEl.dataset.ki), keyEl); return; }
      this.addKeyAt(this._tAt(e), ti, e.altKey);
    });
  }

  /** 拖动播放头：按帧采样并写入对象（临时预览） */
  _scrub(t) {
    this.t = Math.max(0, t);
    if (this.playEl) this.playEl.style.left = (this.t * (this._pps || 62)) + 'px';
    if (this.preview) this._applyAt(this.t);
  }

  /* ============================================================
     试播
     ============================================================ */
  togglePlay() {
    if (this.playing) { this._stopPlay(); return; }
    const an = this._anim();
    if (!an) { toast('先新建/选择一个动画'); return; }
    if (!an.tracks.length) { toast('该动画还没有轨道'); return; }
    if (this.preview) this._savePreview();
    this.sys = this._sysFor();
    this.sys.play(an.id);
    this.playing = true;
    this._last = performance.now();
    this.playBtn.textContent = '■ 停止';
    const tick = () => {
      if (!this.playing) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      this.sys.update(dt);
      const st = this.sys.active.get(an.id);
      this.t = st ? Math.max(0, st.t) : (an.duration || 1);
      if (this.playEl) this.playEl.style.left = (this.t * (this._pps || 62)) + 'px';
      const cycles = ((now - this._playStart) / 1000) / Math.max(0.1, an.duration);
      if (!this.sys.active.size || cycles > 2.2) { this._stopPlay(); return; }
      this._raf = requestAnimationFrame(tick);
    };
    this._playStart = performance.now();
    this._raf = requestAnimationFrame(tick);
  }

  _stopPlay() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (this.playing) {
      this.playing = false;
      if (this.sys) this.sys.stopAll();
      this._restorePreview();
    }
    this.playBtn.textContent = '▶ 试播';
  }

  _sysFor() {
    const b = this.ed.builder;
    if (this._sysBuilder !== b) {
      this._sys = new AnimationSystem(b, {
        liquids: {
          setFill: (rec, v) => { rec.o.fillLevel = v; try { b.updateLiquidTransform(rec); } catch (e) { /* ignore */ } },
        },
      });
      this._sysBuilder = b;
    }
    return this._sys;
  }

  _savePreview() {
    if (this._prev) return;
    this._prev = this.ed.snap();
  }

  _restorePreview() {
    if (!this._prev) return;
    const json = this._prev;
    this._prev = null;
    this.ed._restore(json);
    this.refresh();
  }

  /** 采样当前动画并写到对象上（不记历史） */
  _applyAt(t) {
    const an = this._anim();
    if (!an) return;
    const b = this.ed.builder;
    const sys = this._sysFor();
    for (const tr of an.tracks) {
      const rec = b.objects.get(tr.objectId);
      if (!rec || !tr.keys.length) continue;
      const v = sampleTrack(tr, t);
      if (v === null || v === undefined) continue;
      sys.write(rec, tr.property, v, tr.type);
    }
  }
}

export { ANIM_PROPS };