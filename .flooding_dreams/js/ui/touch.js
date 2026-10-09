/* ============================================================
   触屏操作层（手机 / 平板）
   —— 左下角虚拟摇杆移动，屏幕其余区域拖动转视角，右下角动作按钮，双指捏合缩放
   —— 全部通过 Input 的 setVirtual / addLook / addWheel 注入，
      等价于按下对应按键（沿用设置里的按键绑定，玩家与相机逻辑零改动）
   —— 默认只在触屏设备上启用；可用 ?touch=1 / ?touch=0 强制开关（便于在电脑上调试）
   ============================================================ */
import { $ } from './dom.js';
import { settings } from '../core/settings.js';

const STICK_R = 50;      // 摇杆最大位移（px）
const DEAD = 0.22;       // 摇杆死区
const AXIS = 0.35;       // 单轴判定阈值（超过即等价于按下该方向键）
const LOOK_GAIN = 2.0;   // 触屏拖动转视角增益（手指行程比鼠标短）
const PINCH_GAIN = 0.05; // 双指捏合 → 滚轮缩放

/** 按钮 / 摇杆对应的动作 → 按键绑定名；mouse=true 表示取鼠标键（与桌面左键语义一致） */
const ACTIONS = {
  jump:     { bind: 'jump',         mouse: false },
  dive:     { bind: 'dive',         mouse: false },
  use:      { bind: 'useTool',      mouse: true  },
  view:     { bind: 'cameraToggle', mouse: false },
  forward:  { bind: 'forward',      mouse: false },
  backward: { bind: 'backward',     mouse: false },
  left:     { bind: 'left',         mouse: false },
  right:    { bind: 'right',        mouse: false },
};

const FORCE = new URLSearchParams(location.search).get('touch');
const HAS_TOUCH = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
const COARSE = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches);

function detectTouch() {
  if (FORCE === '1') return true;
  if (FORCE === '0') return false;
  return COARSE && HAS_TOUCH;
}

/** 取某动作当前绑定的按键代码（mouse=true 取鼠标键） */
function codeOf(action, mouse) {
  const arr = settings.get('bindings.' + action.bind, []) || [];
  for (const c of arr) {
    if (mouse ? c.startsWith('Mouse') : !c.startsWith('Mouse')) return c;
  }
  return null;
}

function toggleFullscreen() {
  const d = document;
  if (d.fullscreenElement) { if (d.exitFullscreen) d.exitFullscreen(); return; }
  const el = d.documentElement;
  if (el.requestFullscreen) { const p = el.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
}

export class TouchControls {
  constructor(app) {
    this.app = app;
    this.input = app.input;
    this.root = $('#tui');
    this.stick = $('#tui-stick');
    this.knob = this.stick ? this.stick.querySelector('i') : null;
    this.lookArea = $('#tui-look');
    this.v = new Map();          // 动作 -> 虚拟按键是否按下
    this.pointers = new Map();   // pointerId -> { role, x, y }
    this.pinch = 0;
    this.active = false;
    this._bind();
    if (detectTouch()) this.setActive(true);
    else if (FORCE !== '0' && HAS_TOUCH) {
      // 检测不到的混合设备：真的被触摸时再启用
      window.addEventListener('touchstart', () => this.setActive(true), { once: true, passive: true });
    }
    window.addEventListener('blur', () => this.reset());
  }

  /* ---------- 启用 / 停用 ---------- */
  setActive(on) {
    on = !!on;
    if (on === this.active) return;
    this.active = on;
    if (this.root) this.root.classList.toggle('hidden', !on);
    const hud = document.getElementById('hud');
    if (hud) hud.classList.toggle('touch', on);   // 让 HUD 底部内容上移
    if (!on) this.reset();
  }

  /** 每帧由 App 调用：面板打开 / 暂停 / 冻结 / 进编辑器时释放所有按键 */
  tick() {
    if (!this.active) return;
    const a = this.app;
    if (a.overlay || a.paused || a.frozen || a.state === 'editor') this.reset();
  }

  /** 释放全部虚拟输入（松手、失焦、暂停时调用） */
  reset() {
    if (!this.pointers.size && !this.v.size) return;
    this.pointers.clear();
    for (const [k, on] of [...this.v]) if (on) this._set(k, false);
    this.v.clear();
    if (this.knob) this.knob.style.transform = '';
    this.input.touchLooking = false;
    this.pinch = 0;
    for (const b of this.root ? this.root.querySelectorAll('.tui-btn.on') : []) b.classList.remove('on');
  }

  _blocked() { const a = this.app; return !!(a.overlay || a.paused || a.frozen); }

  /* ---------- 虚拟按键注入 ---------- */
  _set(action, on) {
    on = !!on;
    if (!!this.v.get(action) === on) return;
    this.v.set(action, on);
    const a = ACTIONS[action];
    if (!a) return;
    const code = codeOf(a, a.mouse);
    if (code) this.input.setVirtual(code, on);
  }

  /* ---------- 事件绑定 ---------- */
  _bind() {
    const root = this.root;
    if (!root) return;

    // 拖动转视角 / 双指缩放（铺满屏幕，按钮与摇杆在其上层且先于它接收事件）
    const look = this.lookArea;
    if (look) {
      look.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!this.active || this._blocked()) return;
        try { look.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        this.pointers.set(e.pointerId, { role: 'look', x: e.clientX, y: e.clientY });
        this.pinch = 0;
        this._syncLooking();
      });
      look.addEventListener('pointermove', (e) => {
        const p = this.pointers.get(e.pointerId);
        if (!p || p.role !== 'look') return;
        e.preventDefault();
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        if (this._looks().length >= 2) { this._pinchUpdate(); return; }   // 双指 = 缩放，不转视角
        this.input.addLook(dx * LOOK_GAIN, dy * LOOK_GAIN);
      });
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        look.addEventListener(t, (e) => {
          const p = this.pointers.get(e.pointerId);
          if (!p || p.role !== 'look') return;
          this.pointers.delete(e.pointerId);
          this.pinch = 0;
          this._syncLooking();
        });
      }
      look.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // 摇杆
    const st = this.stick;
    if (st) {
      st.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!this.active || this._blocked()) return;
        try { st.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        this.pointers.set(e.pointerId, { role: 'stick' });
        this._stickTo(e);
      });
      st.addEventListener('pointermove', (e) => {
        const p = this.pointers.get(e.pointerId);
        if (!p || p.role !== 'stick') return;
        e.preventDefault();
        this._stickTo(e);
      });
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        st.addEventListener(t, (e) => {
          const p = this.pointers.get(e.pointerId);
          if (!p || p.role !== 'stick') return;
          this.pointers.delete(e.pointerId);
          this._stickVec(0, 0);
        });
      }
      st.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // 动作按钮
    for (const btn of root.querySelectorAll('[data-tk]')) {
      const tk = btn.dataset.tk;
      if (tk === 'pause') { btn.addEventListener('click', () => this.app.setPaused(true)); continue; }
      if (tk === 'full') { btn.addEventListener('click', () => toggleFullscreen()); continue; }
      if (!ACTIONS[tk]) continue;
      const down = (e) => {
        e.preventDefault();
        if (!this.active || this._blocked()) return;
        try { btn.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        btn.classList.add('on');
        this._set(tk, true);
      };
      const up = () => { btn.classList.remove('on'); this._set(tk, false); };
      btn.addEventListener('pointerdown', down);
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(t, up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  /* ---------- 摇杆 → 方向键 ---------- */
  _stickTo(e) {
    const r = this.stick.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const m = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, STICK_R / m);
    if (this.knob) this.knob.style.transform = `translate(${(dx * k).toFixed(1)}px, ${(dy * k).toFixed(1)}px)`;
    this._stickVec(dx / STICK_R, dy / STICK_R);
  }

  /** 摇杆向量 → 前进 / 后退 / 左 / 右（屏幕上方为前进） */
  _stickVec(x, y) {
    const m = Math.hypot(x, y);
    if (m < DEAD) {
      this._set('forward', false); this._set('backward', false);
      this._set('left', false); this._set('right', false);
      return;
    }
    const nx = x / m, ny = y / m;
    this._set('forward', ny < -AXIS);
    this._set('backward', ny > AXIS);
    this._set('left', nx < -AXIS);
    this._set('right', nx > AXIS);
  }

  /* ---------- 视角 / 缩放 ---------- */
  _looks() { return [...this.pointers.values()].filter((p) => p.role === 'look'); }
  _syncLooking() { this.input.touchLooking = this._looks().length > 0; }
  _pinchUpdate() {
    const pts = this._looks();
    if (pts.length < 2) return;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (this.pinch) this.input.addWheel((d - this.pinch) * PINCH_GAIN);
    this.pinch = d;
  }
}