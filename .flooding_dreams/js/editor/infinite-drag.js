/* ============================================================
   拖拽位置锁定（Pointer Lock）
   在 3D 视口里按下鼠标开始拖拽的那一刻就锁定光标：光标停在按下时的位置，
   之后所有位移都由 movementX/Y 累加，拖拽不会被窗口边界截断，也不会
   出现“光标跑到窗口外”的情况。
   每一步位移都立即把合成出来的“虚拟光标”（按下位置 + 累计位移）重发给
   既有拖拽代码，因此视角 / gizmo / 框选 / 涂鸦都无需改动。

   注意：three 自带的 TransformControls 一旦发现 pointerLockElement 存在，
   就会忽略事件坐标、直接拿屏幕中心做射线（vendor/three-addons/controls/
   TransformControls.js 的 getPointer），gizmo 会因此完全拖不动。
   编辑器打开期间把该属性在 document 实例上遮蔽为 null，坐标完全由我们提供。
   ============================================================ */

let enabled = false;     // 仅编辑器打开时生效
let chain = null;        // 按下时的元素链（重发事件用；元素被重绘时回退到仍存在的祖先）
let locked = false;
let skipFirst = false;   // 刚锁定的第一帧位移不可信（浏览器会补发一段跳变）
let vx = 0, vy = 0;      // 虚拟光标 = 按下位置 + 累计位移
let busy = false;        // 正在重发事件，避免递归
let shimmed = false;     // 是否已遮蔽 document.pointerLockElement

/* 真正的锁定状态（遮蔽后 document.pointerLockElement 恒为 null） */
const _lockDesc = typeof Document !== 'undefined'
  ? Object.getOwnPropertyDescriptor(Document.prototype, 'pointerLockElement') : null;

function realLockElement() {
  try {
    if (_lockDesc && _lockDesc.get) return _lockDesc.get.call(document);
  } catch (e) { /* ignore */ }
  return null;
}

function shim(on) {
  if (on === shimmed) return;
  try {
    if (on) Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => null });
    else delete document.pointerLockElement;
    shimmed = on;
  } catch (e) { shimmed = false; }
}

/** 编辑器打开 / 关闭时切换 */
export function setInfiniteDrag(on) {
  enabled = !!on;
  shim(enabled);
  if (!enabled) {
    try { document.exitPointerLock(); } catch (e) { /* ignore */ }
    end();
  }
}

function lock() {
  if (locked || !enabled || !document.body) return;
  if (!document.body.requestPointerLock) return;
  try {
    const p = document.body.requestPointerLock();
    if (p && p.catch) p.catch(() => { /* 未获得授权：保持原生拖拽 */ });
  } catch (e) { /* ignore */ }
}

/** 元素可能已被重绘移除，取链上第一个还在文档里的节点 */
function aliveTarget() {
  if (!chain) return null;
  for (const n of chain) if (n.isConnected) return n;
  return null;
}

function resend(type, src) {
  const t = aliveTarget();
  if (!t) return;
  busy = true;
  try {
    t.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: vx, clientY: vy, screenX: vx, screenY: vy,
      pointerId: (src && src.pointerId) || 1,
      pointerType: (src && src.pointerType) || 'mouse',
      button: (src && src.button) || 0,
      buttons: type === 'pointerup' ? 0 : (src && src.buttons) || 0,
      isPrimary: true,
    }));
  } finally { busy = false; }
}

function end() {
  chain = null;
  skipFirst = false;
  try { document.exitPointerLock(); } catch (e) { /* ignore */ }
}

/** 只有 3D 视口内的拖拽才锁光标（面板 / 菜单里的拖拽保持原生行为） */
function inViewport(target) {
  const el = target && target.closest ? target.closest('#ed-view') : null;
  return !!el;
}

/* 视口浮层里的按钮 / 滑块 / 下拉：绝不能锁光标。
   一旦锁定，pointerup 会被浏览器投递到 body，按钮收不到 click ——
   这正是「涂鸦/橡皮/材质章、移动/旋转/缩放按钮点了没反应」的原因。 */
const CTRL_SEL = 'button,input,select,textarea,label,a,[role="button"],[contenteditable="true"]';
function isControl(target) {
  return !!(target && target.closest && target.closest(CTRL_SEL));
}

window.addEventListener('pointerdown', (e) => {
  if (busy || !enabled) return;
  if (e.button !== 0 && e.button !== 1) return;
  if (isControl(e.target)) return;        // 工具条 / 表单控件：交给原生点击
  let target = inViewport(e.target) ? e.target : null;
  // 上一次拖拽的锁定还没解除时，事件会被投递到 body：按坐标自己找目标，
  // 否则“点几下之后 3D 视图里就再也拖不动了”
  if (!target && realLockElement()) {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (isControl(hit)) return;
    if (inViewport(hit)) target = hit;
  }
  if (!target) return;
  chain = [];
  for (let n = target; n && n !== document; n = n.parentNode) chain.push(n);
  vx = e.clientX; vy = e.clientY;    // 锁定在按下时刻的位置
  skipFirst = true;
  lock();
  if (target !== e.target) {         // 起点被锁定时，补发一份给视口
    e.stopImmediatePropagation();
    resend('pointerdown', e);
  }
}, true);

window.addEventListener('pointermove', (e) => {
  if (busy || !enabled || !chain || !locked) return;
  if (skipFirst) { skipFirst = false; return; }
  vx += e.movementX || 0;
  vy += e.movementY || 0;
  e.stopImmediatePropagation();
  resend('pointermove', e);          // 变换在这一步同步应用完
}, true);

window.addEventListener('pointerup', (e) => {
  if (busy || !enabled || !chain) return;
  if (locked) { e.stopImmediatePropagation(); resend('pointerup', e); }
  end();
}, true);

window.addEventListener('pointercancel', () => { end(); }, true);

document.addEventListener('pointerlockchange', () => {
  locked = !!realLockElement();
  if (locked) { skipFirst = true; return; }
  // 锁定被提前解除（例如按了 Esc）：补一个 pointerup，别让拖拽卡住
  if (chain) { resend('pointerup', null); chain = null; }
});