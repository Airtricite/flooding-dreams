/* ============================================================
   引擎：主循环 / 视口 / 画质 / 统计
   ------------------------------------------------------------
   渲染本体收口到 RenderHost（见 render-host.js）：
     · 主线程默认 InProcHost（renderer 跑在主线程 DOM canvas 上）
     · 渲染 Worker 模式下为 WorkerHost（renderer 跑在 OffscreenCanvas 上）
   引擎自身只保留「与 DOM / 布局 / 主循环时序」相关的事，不再直接持有 renderer。
   ============================================================ */
import * as THREE from './three-ns.js';
import { settings } from './settings.js';
import { clamp } from './util.js';
import { createRenderHost } from './render-host.js';

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.host = createRenderHost(canvas);
    this._quality = settings.qualityPreset();
    this.clock = new THREE.Clock();
    this.view = null;             // { scene, camera, update(dt), beforeRender, afterRender, overlay }
    this.running = false;
    this.paused = false;
    this.rect = null;             // { x, y, w, h } 视口区域（编辑器用）
    this.stats = { fps: 0, ms: 0, tris: 0, calls: 0, geometries: 0, textures: 0 };
    this._raf = 0;
    this._frames = 0; this._acc = 0;
    // 画面处理来源：关卡里放了「画面处理对象」时由它决定色调映射 / 曝光 / 输出色彩空间
    this.screenProvider = null;
    this.subsystems = [];

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas.parentElement || document.body);
    }
    this.resize();
  }

  get renderer() { return this.host.renderer; }
  get postfx() { return this.host.postfx; }

  setView(view) { this.view = view; }

  /**
   * 画面处理来源：每帧回调，返回数字（只给曝光）或
   * { exposure, toneMapping, colorSpace, saturation, tint }；传 null 复位成引擎默认。
   * 「画面处理对象」用它把这几项直接写进渲染器 / 共享调色矩阵——没有额外 pass
   */
  setScreenProvider(fn) {
    this.screenProvider = fn || null;
    if (!fn) this.host.resetScreen();
  }

  registerSub(s) { this.subsystems.push(s); }

  emitResize(w, h) {
    const list = this._resizeCbs || [];
    for (const f of list) { try { f(w, h); } catch (e) { console.error(e); } }
  }
  onResize(fn) { (this._resizeCbs = this._resizeCbs || []).push(fn); }

  /** rect=null 全屏；否则为编辑器视口区域 */
  setRect(rect) {
    const c = this.rect;
    // 矩形未变化则不重复布局：编辑器 onResize → setRect 的回环会在这里断开
    if (c && rect && c.x === rect.x && c.y === rect.y && c.w === rect.w && c.h === rect.h) return;
    this.rect = rect;
    this.resize();
  }

  resize() {
    // emitResize 的回调里可能再次调用 resize（如编辑器视口重算），加锁避免无限递归
    if (this._inResize) { this._again = true; return; }
    this._inResize = true;
    try {
      const pr = Math.min(window.devicePixelRatio || 1, this.host.maxPixelRatio);
      let w, h;
      if (this.rect) {
        w = Math.max(2, Math.round(this.rect.w));
        h = Math.max(2, Math.round(this.rect.h));
        this.canvas.style.left = this.rect.x + 'px';
        this.canvas.style.top = this.rect.y + 'px';
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
      } else {
        w = window.innerWidth; h = window.innerHeight;
        this.canvas.style.left = '0px'; this.canvas.style.top = '0px';
        this.canvas.style.width = '100%'; this.canvas.style.height = '100%';
      }
      // 渲染 Worker 模式下 canvas 的绘制控制权已转移给 OffscreenCanvas，写 width/height 会抛错：
      // 渲染尺寸改由 host.setSize 转发给 Worker 内的渲染器。
      if (!this.host.offscreen) {
        this.canvas.width = Math.max(2, Math.round(w * pr));
        this.canvas.height = Math.max(2, Math.round(h * pr));
      }
      this.host.setSize(w, h, pr);
      if (this.view && this.view.camera && this.view.camera.isPerspectiveCamera) {
        this.view.camera.aspect = w / h;
        this.view.camera.updateProjectionMatrix();
      }
      this.emitResize(w, h);
    } finally {
      this._inResize = false;
    }
    // 回调期间若又请求过一次 resize（尺寸已变），补做一次
    if (this._again) { this._again = false; this.resize(); }
  }

  get size() {
    const r = this.canvas.getBoundingClientRect();
    return { w: r.width, h: r.height, x: r.left, y: r.top };
  }

  applyQuality() {
    const q = settings.qualityPreset();
    this._quality = q;
    this.host.applyQuality(q);
    this.resize();
    this.emitResize(this.canvas.clientWidth, this.canvas.clientHeight);
  }
  get quality() { return this._quality; }

  /** 场景结构变化（关卡加载 / 编辑器增删 / 材质几何变更）→ 通知渲染宿主下发快照 */
  markSceneDirty() { if (this.host && this.host.markSceneDirty) this.host.markSceneDirty(); }

  /** 本帧被写过位姿的对象 → 推送热通道（渲染 Worker 模式下生效；进程内为空实现）。
   *  recursive=true 时连同子孙一起推送。 */
  hot(obj, recursive) { if (this.host && this.host.hot) this.host.hot(obj, recursive); }

  /** 本帧几何属性被写过（粒子位置 / 颜色…）→ 推热通道 */
  hotAttrs(obj) { if (this.host && this.host.hotAttrs) this.host.hotAttrs(obj); }

  /** 本帧可见性 / 透明度被改过（破坏消失、机关淡出）→ 推热通道 */
  hotState(obj) { if (this.host && this.host.hotState) this.host.hotState(obj); }

  /** 常驻逐帧同步某材质的 uniform（粒子动画时间等） */
  trackMaterial(mat) { if (this.host && this.host.trackMaterial) this.host.trackMaterial(mat); }

  /** 一次性同步某材质的 uniform（运行期新建的材质，如泡沫网格） */
  hotMaterial(mat) { if (this.host && this.host.hotMaterial) this.host.hotMaterial(mat); }

  /** 渲染子系统描述（雾对象 / 玻璃 / 泡沫 / 遮挡 / 反射捕获）：结构变化时下发一次 */
  setRenderDescriptors(desc) { if (this.host && this.host.setRenderDescriptors) this.host.setRenderDescriptors(desc); }

  /** 每帧渲染参数提供器（后处理 / 体积雾系数）：Worker 模式下随帧消息下发 */
  setRenderParamsProvider(fn) { if (this.host && this.host.setRenderParamsProvider) this.host.setRenderParamsProvider(fn); }

  /** 视口区域（编辑器 / 大厅分屏）：Worker 模式下转发 setViewport/setScissor */
  setViewport(rect) { if (this.host && this.host.setViewport) this.host.setViewport(rect); }

  /** 贴图内容热更新（图集扩容等，uuid 不变） */
  hotTexture(tex) { if (this.host && this.host.hotTexture) this.host.hotTexture(tex); }

  /** 运行时新增 / 移除对象（投掷物 / 生成的物体） */
  addObject(obj) { if (this.host && this.host.addObject) this.host.addObject(obj); }
  removeObject(obj) { if (this.host && this.host.removeObject) this.host.removeObject(obj); }

  /** 环境贴图（IBL）：委托给渲染宿主（PMREM 逻辑见 render-host.js） */
  buildEnv(equirectTexture) { return this.host.buildEnv(equirectTexture); }
  get envMap() { return this.host.envMap; }

  /** 预编译场景着色器（异步，避免首帧集中编译造成的卡顿） */
  warmup(scene, camera) { return this.host.warmup(scene, camera); }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this._loop();
  }
  stop() { this.running = false; cancelAnimationFrame(this._raf); }

  _loop = () => {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);
    const raw = this.clock.getDelta();
    const dt = clamp(raw, 0, 1 / 15);
    this.stats.ms = raw * 1000;

    // FPS
    this._frames++; this._acc += raw;
    if (this._acc >= 0.5) { this.stats.fps = Math.round(this._frames / this._acc); this._frames = 0; this._acc = 0; }

    if (!this.paused && this.view && this.view.update) {
      try { this.view.update(dt); } catch (e) { console.error('[engine] update 异常', e); }
    }

    // 画面处理对象：色调映射 / 曝光 / 输出色彩空间 / 饱和度 / 染色，不做任何额外 pass
    if (this.screenProvider) {
      const s = this.screenProvider();
      if (s === null || s === undefined) this.host.resetScreen();
      else this.host.applyScreen(typeof s === 'number' ? { exposure: s } : s);
    }

    const st = this.host.renderFrame(this.view, dt);
    if (st) {
      this.stats.tris = st.tris;
      this.stats.calls = st.calls;
      this.stats.geometries = st.geometries;
      this.stats.textures = st.textures;
    }
    const v = this.view;
    if (v && v.afterRender) { try { v.afterRender(dt); } catch (e) { console.error(e); } }
  };

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    if (this._ro) this._ro.disconnect();
    this.host.dispose();
  }
}

/* ---------- 常用相机工具 ---------- */
export function makeCamera(fov = 78, near = 0.12, far = 6000) {
  const c = new THREE.PerspectiveCamera(fov, 16 / 9, near, far);
  c.rotation.order = 'YXZ';
  return c;
}

/** 屏幕坐标 → NDC（相对 canvas 实际显示区域） */
export function pointerNDC(engine, clientX, clientY, out = new THREE.Vector2()) {
  const r = engine.canvas.getBoundingClientRect();
  out.x = ((clientX - r.left) / r.width) * 2 - 1;
  out.y = -((clientY - r.top) / r.height) * 2 + 1;
  return out;
}

export const THREE_NS = THREE;
