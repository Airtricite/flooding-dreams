/* ============================================================
   输入系统：键盘 + 鼠标 + 滚轮 + 指针锁定 + 动作映射
   ============================================================ */
import { settings } from './settings.js';
import { clamp, Bus } from './util.js';

const MOUSE_CODES = ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4'];

export class Input extends Bus {
  constructor(el) {
    super();
    this.el = el;
    this.down = new Set();
    this.justPressed = new Set();
    this.justReleased = new Set();
    this.msDown = new Set();
    this.msPressed = new Set();
    this.msReleased = new Set();
    this.mouse = { x: 0, y: 0, ndcX: 0, ndcY: 0, dx: 0, dy: 0, wheel: 0 };
    this.wheelAccum = 0;
    this.pointerLocked = false;
    this.wantLock = false;
    this._lockPending = false;
    this.dragLookButton = 'Mouse2';   // 非锁定环境下按住此键拖动转视角（null 关闭）
    this.touchLooking = false;        // 触屏拖动转视角中（由 TouchControls 写入）
    this.blockContext = true;
    this.sensitivityScale = 1;
    this.enabled = true;
    this.prevMouse = { x: 0, y: 0 };
    this._lastMove = { x: 0, y: 0 };
    this._listeners = [];
    this._bind();
  }

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _bind() {
    const el = this.el;
    this._on(window, 'keydown', (e) => {
      if (!this.enabled) return;
      if (e.repeat) { this.emit('repeat', e.code); return; }
      // 输入框中不拦截按键
      const tag = (e.target && e.target.tagName) || '';
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
      if (!inField) {
        this.down.add(e.code);
        this.justPressed.add(e.code);
        this.emit('keydown', e.code, e);
        if (['Tab', 'Space', 'F1', 'F3'].includes(e.code) || (e.code === 'KeyS' && (e.ctrlKey || e.metaKey))) e.preventDefault();
        if (e.code === 'Tab') e.preventDefault();
      }
    });
    this._on(window, 'keyup', (e) => {
      this.down.delete(e.code);
      this.justReleased.add(e.code);
      this.emit('keyup', e.code, e);
    });
    this._on(window, 'blur', () => this.clearAll());

    this._on(el, 'mousedown', (e) => {
      if (!this.enabled) return;
      const code = 'Mouse' + e.button;
      this.msDown.add(code); this.msPressed.add(code);
      this.emit('mousedown', e.button, e);
      if (e.button === 1) e.preventDefault();
    });
    this._on(window, 'mouseup', (e) => {
      const code = 'Mouse' + e.button;
      this.msDown.delete(code); this.msReleased.add(code);
      this.emit('mouseup', e.button, e);
      if (e.button === 1) e.preventDefault();
    });
    this._on(el, 'contextmenu', (e) => { if (this.blockContext) e.preventDefault(); });
    this._on(el, 'auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

    this._on(window, 'mousemove', (e) => {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
      this.mouse.ndcX = (this.mouse.x / r.width) * 2 - 1;
      this.mouse.ndcY = -(this.mouse.y / r.height) * 2 + 1;
      if (this.pointerLocked) {
        const s = settings.get('mouse.sensitivity', 1) * this.sensitivityScale;
        const inv = settings.get('mouse.invertY', false) ? -1 : 1;
        this.mouse.dx += e.movementX * s;
        this.mouse.dy += e.movementY * s * inv;
        this.emit('look', e.movementX * s, e.movementY * s * inv);
      } else if (this.dragLookButton && this.msDown.has(this.dragLookButton)) {
        // 指针锁定不可用时的兜底：按住右键拖动转视角
        const s = settings.get('mouse.sensitivity', 1) * this.sensitivityScale;
        const inv = settings.get('mouse.invertY', false) ? -1 : 1;
        this.mouse.dx += e.movementX * s;
        this.mouse.dy += e.movementY * s * inv;
        this.emit('look', e.movementX * s, e.movementY * s * inv);
      } else {
        this.mouse.dx = 0; this.mouse.dy = 0;
      }
      this.emit('mousemove', e);
    });

    this._on(el, 'wheel', (e) => {
      e.preventDefault();
      const d = Math.sign(e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
      this.mouse.wheel += d;
      this.wheelAccum += d;
      this.emit('wheel', d, e);
    }, { passive: false });

    this._on(document, 'pointerlockchange', () => {
      const locked = document.pointerLockElement === el || document.pointerLockElement === document.body;
      if (this.pointerLocked !== locked) {
        this.pointerLocked = locked;
        if (!locked) { this.mouse.dx = 0; this.mouse.dy = 0; }
        this.emit('lock', locked);
      }
    });
    this._on(document, 'pointerlockerror', () => {
      this.pointerLocked = false;
      this.emit('lockerror');
    });
  }

  requestLock() {
    if (this.pointerLocked || this._lockPending) return;
    if (!this.el || !this.el.requestPointerLock || !this.el.isConnected) return;
    this._lockPending = true;
    // 某些环境下会同步抛错或返回被拒绝的 Promise（WrongDocumentError 等），都要吞掉
    const attempt = (opts) => {
      let p = null;
      try { p = opts ? this.el.requestPointerLock(opts) : this.el.requestPointerLock(); }
      catch (e) { return Promise.reject(e); }
      return (p && typeof p.then === 'function') ? p : Promise.resolve();
    };
    attempt({ unadjustedMovement: true })
      .catch(() => attempt(null))
      .catch(() => this.emit('lockerror'));
    setTimeout(() => { this._lockPending = false; }, 600);
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  clearAll() {
    this.down.clear(); this.msDown.clear();
    this.mouse.dx = 0; this.mouse.dy = 0; this.wheelAccum = 0;
    this.emit('blur');
  }

  /* ---------- 原始查询 ---------- */
  keyDown(code) { return this.down.has(code); }
  keyPressed(code) { return this.justPressed.has(code); }
  mouseDown(b) { return this.msDown.has('Mouse' + b); }
  mousePressed(b) { return this.msPressed.has('Mouse' + b); }
  mouseReleased(b) { return this.msReleased.has('Mouse' + b); }

  /** 某动作是否被按下（含鼠标键） */
  act(name) {
    const arr = settings.get('bindings.' + name, []);
    for (const c of arr) {
      if (c.startsWith('Mouse')) { if (this.msDown.has(c)) return true; }
      else if (this.down.has(c)) return true;
    }
    return false;
  }
  actPressed(name) {
    const arr = settings.get('bindings.' + name, []);
    for (const c of arr) {
      if (c.startsWith('Mouse')) { if (this.msPressed.has(c)) return true; }
      else if (this.justPressed.has(c)) return true;
    }
    return false;
  }
  actReleased(name) {
    const arr = settings.get('bindings.' + name, []);
    for (const c of arr) {
      if (c.startsWith('Mouse')) { if (this.msReleased.has(c)) return true; }
      else if (this.justReleased.has(c)) return true;
    }
    return false;
  }

  /** 某动作是否由「键盘键」按下（忽略鼠标键绑定） */
  actKey(name) {
    const arr = settings.get('bindings.' + name, []);
    for (const c of arr) if (!c.startsWith('Mouse') && this.down.has(c)) return true;
    return false;
  }
  actKeyPressed(name) {
    const arr = settings.get('bindings.' + name, []);
    for (const c of arr) if (!c.startsWith('Mouse') && this.justPressed.has(c)) return true;
    return false;
  }
  /** 某动作是否由「鼠标键」按下（忽略键盘绑定） */
  actMouse(name) {
    const arr = settings.get('bindings.' + name, []);
    for (const c of arr) if (c.startsWith('Mouse') && this.msDown.has(c)) return true;
    return false;
  }
  actMousePressed(name) {
    const arr = settings.get('bindings.' + name, []);
    for (const c of arr) if (c.startsWith('Mouse') && this.msPressed.has(c)) return true;
    return false;
  }

  /** 是否处于「可转视角」状态（指针锁定或右键拖拽兜底或触屏拖动） */
  get looking() {
    return this.pointerLocked || (!!this.dragLookButton && this.msDown.has(this.dragLookButton)) || this.touchLooking;
  }

  /* ---------- 外部注入（触屏等） ---------- */

  /**
   * 虚拟按键：与真实按键共用同一套状态，因此 act()/actPressed() 等无需改动。
   * 传 'Mouse0' 这类代码时写入鼠标状态，传 'Space' 这类代码时写入键盘状态。
   */
  setVirtual(code, on) {
    if (!code) return;
    if (code.startsWith('Mouse')) {
      if (on) { if (!this.msDown.has(code)) { this.msDown.add(code); this.msPressed.add(code); } }
      else if (this.msDown.has(code)) { this.msDown.delete(code); this.msReleased.add(code); }
      return;
    }
    if (on) { if (!this.down.has(code)) { this.down.add(code); this.justPressed.add(code); } }
    else if (this.down.has(code)) { this.down.delete(code); this.justReleased.add(code); }
  }

  /** 注入视角增量（触屏拖动），与鼠标移动共用同一套灵敏度设置 */
  addLook(dx, dy) {
    const s = settings.get('mouse.sensitivity', 1) * this.sensitivityScale;
    const inv = settings.get('mouse.invertY', false) ? -1 : 1;
    this.mouse.dx += dx * s;
    this.mouse.dy += dy * s * inv;
    this.emit('look', dx * s, dy * s * inv);
  }

  /** 注入滚轮增量（触屏双指缩放） */
  addWheel(d) {
    this.mouse.wheel += d;
    this.wheelAccum += d;
    this.emit('wheel', d, null);
  }

  /** 取出并清空鼠标横向/纵向增量 */
  takeLook() {
    const dx = this.mouse.dx, dy = this.mouse.dy;
    this.mouse.dx = 0; this.mouse.dy = 0;
    return { dx, dy };
  }
  takeWheel() { const w = this.wheelAccum; this.wheelAccum = 0; return w; }

  /** 由引擎在每帧末尾调用 */
  endFrame() {
    this.justPressed.clear();
    this.justReleased.clear();
    this.msPressed.clear();
    this.msReleased.clear();
  }

  /** 捕获下一次按键（用于按键绑定 UI） */
  captureNext() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (code) => { if (done) return; done = true; cleanup(); resolve(code); };
      const kd = (e) => { e.preventDefault(); finish(e.code); };
      const md = (e) => { e.preventDefault(); finish('Mouse' + e.button); };
      const cleanup = () => { window.removeEventListener('keydown', kd, true); window.removeEventListener('mousedown', md, true); };
      window.addEventListener('keydown', kd, true);
      window.addEventListener('mousedown', md, true);
    });
  }

  destroy() {
    for (const [t, ty, fn, o] of this._listeners) t.removeEventListener(ty, fn, o);
    this._listeners.length = 0;
  }
}
export { MOUSE_CODES };