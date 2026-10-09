/* ============================================================
   渲染宿主（RenderHost）
   ------------------------------------------------------------
   把「渲染」从引擎主循环里抽出来，收口成一层可替换的宿主：
     · InProcHost   —— 今天的行为：renderer 跑在主线程 DOM canvas 上（默认 / 降级回退）
     · WorkerHost   —— 后续：renderer 跑在渲染 Worker 的 OffscreenCanvas 上（见 render-worker.js）

   引擎只与宿主打交道：尺寸 / 画质 / 画面处理 / 环境贴图 / 预热 / 出帧 / 统计 / 销毁。
   上层（builder / editor / advanced-materials 等）通过 engine.renderer 拿到的仍是
   进程内宿主里的那个 WebGLRenderer；WorkerHost 下这些调用需改为在 worker 内进行。
   ============================================================ */
import * as THREE from './three-ns.js';
import { settings } from './settings.js';
import { applyMaterialQuality, setScreenGrade } from './materials.js';
import { setMaxTextureSize } from './textures.js';
import { PostFX } from './postfx.js';
import { BASE_EXPOSURE } from './exposure.js';
import { MSG } from './render-proto.js';
import { RenderBridge } from './render-bridge.js';

/** 运行环境是否具备「渲染 Worker」所需的全部能力（同步能力探测，不做运行时握手） */
export function workerSupported() {
  try {
    return typeof Worker !== 'undefined'
      && typeof OffscreenCanvas !== 'undefined'
      && typeof createImageBitmap === 'function'
      && typeof HTMLCanvasElement !== 'undefined'
      && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
  } catch (e) { return false; }
}

/**
 * 创建渲染宿主。
 * settings.video.renderWorker = off（默认）→ 进程内渲染，行为与改造前完全一致；
 * = on / auto 且环境具备能力 → 渲染跑在 Worker 的 OffscreenCanvas 上（主线程只做物理 / 输入 / 逻辑）。
 * 能力不足或 Worker 构造失败时自动回退 InProcHost。
 * @param {HTMLCanvasElement} canvas
 */
export function createRenderHost(canvas) {
  const mode = settings.get('video.renderWorker', 'off');
  if (mode !== 'off' && workerSupported()) {
    try { return new WorkerHost(canvas); }
    catch (e) { console.warn('[host] 渲染 Worker 创建失败，回退进程内渲染', e); }
  }
  return new InProcHost(canvas);
}

export class InProcHost {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.mode = 'inproc';
    this.canvas = canvas;
    this.offscreen = false;

    const q = settings.qualityPreset();
    this._quality = q;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: q.antialias,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      logarithmicDepthBuffer: false,
    });
    this.renderer.setClearColor(0x0b0a14, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // r155+ 默认改用物理光照单位，会让既有 intensity 数值明显偏暗；这里沿用传统单位
    if ('useLegacyLights' in this.renderer) this.renderer.useLegacyLights = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = BASE_EXPOSURE;
    this.renderer.shadowMap.enabled = q.shadows;
    // 用 PCFShadowMap 而不是 PCFSoftShadowMap：后者的核宽固定为 1 个阴影贴图 texel，
    // 会把阴影边界往亮处晕开；方块游戏的 texel（0.15~0.9 stud）远大于拼缝外扩量
    // （SEAM_PAD_*，0.004~0.03），于是方块接缝/接触处被晕出一道亮线（漏光）。
    // PCF 的核宽由 light.shadow.radius 控制，太阳光那边把它设为 0（见 builder.updateSunShadow）。
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;
    this.maxPixelRatio = q.pixelRatio;
    // SVG 光栅化的尺寸上限跟随显卡实际能力，避免生成的贴图超出硬件限制
    try { if (this.renderer.capabilities && this.renderer.capabilities.maxTextureSize) setMaxTextureSize(this.renderer.capabilities.maxTextureSize); } catch (e) { /* ignore */ }

    // 后处理管线：关卡里放了「后处理对象」时才由 postfx 接管渲染
    // HDR RT 的 MSAA 跟随画质档位的抗锯齿开关（低/中档位不再强制 4x 多重采样）
    this.postfx = new PostFX(this.renderer, q.antialias ? 4 : 0);

    this._envCache = new Map();   // 源天空贴图 uuid -> PMREM 结果（避免反复重建）
    this._envMap = null;

    applyMaterialQuality(q);      // 后续创建的材质套用高光 / AO 档位
  }

  /** CSS 尺寸 + 设备像素比 → 渲染尺寸（canvas 物理像素由引擎先行写入） */
  setSize(w, h, pr) {
    // 注意：maxPixelRatio 是画质上限（构造 / applyQuality 写入），不在这里改写，
    // 否则窗口在不同 DPI 显示器间移动后倍率只降不升。
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    if (this.postfx) this.postfx.setSize(this.canvas.width, this.canvas.height);
  }

  applyQuality(q) {
    this._quality = q;
    this.maxPixelRatio = q.pixelRatio;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.toneMappingExposure = BASE_EXPOSURE;
    applyMaterialQuality(q);      // 高光反射 / 接缝闭塞阴影
    if (this.postfx) this.postfx.setSamples(q.antialias ? 4 : 0);
  }
  get quality() { return this._quality; }

  /** 复位成引擎默认的画面管线（ACES + sRGB + 基准曝光 + 不调色） */
  resetScreen() {
    this.applyScreen({
      exposure: BASE_EXPOSURE,
      toneMapping: THREE.ACESFilmicToneMapping,
      colorSpace: THREE.SRGBColorSpace,
    });
  }

  /** 只在值真的变了才写：色调映射 / 色彩空间一变，three 要给所有材质重编译着色器 */
  applyScreen(s) {
    const r = this.renderer;
    if (s.toneMapping !== undefined && r.toneMapping !== s.toneMapping) r.toneMapping = s.toneMapping;
    if (s.colorSpace !== undefined && r.outputColorSpace !== s.colorSpace) r.outputColorSpace = s.colorSpace;
    if (Number.isFinite(s.exposure) && r.toneMappingExposure !== s.exposure) r.toneMappingExposure = s.exposure;
    // 饱和度 / 染色只在 CPU 上重算 9 个 float 的共享矩阵，材质侧零改动、零重编译
    const t = s.tint;
    setScreenGrade(s.saturation, t ? t[0] : 1, t ? t[1] : 1, t ? t[2] : 1);
  }

  /**
   * 环境贴图（IBL）：把等距柱状全景图转成 PMREM。
   * PMREM 很贵（约数百毫秒），而同一张天空图在多关 / 编辑器反复打开时会被反复请求，
   * 因此按「源贴图」缓存结果：命中缓存直接复用，不再重建也不销毁。
   * 只保留最近 4 张，超出后释放最旧的（PMREM 贴图比较占显存）。
   */
  buildEnv(equirectTexture) {
    if (!equirectTexture) { this._envMap = null; return null; }
    const key = equirectTexture.uuid || (equirectTexture.source && equirectTexture.source.uuid);
    let tex = key ? this._envCache.get(key) : null;
    if (tex) {
      // LRU：命中后移到末尾
      this._envCache.delete(key);
      this._envCache.set(key, tex);
    } else {
      const pm = new THREE.PMREMGenerator(this.renderer);
      pm.compileEquirectangularShader();
      const rt = pm.fromEquirectangular(equirectTexture);
      pm.dispose();
      tex = rt.texture;
      if (key) this._envCache.set(key, tex);
      while (this._envCache.size > 4) {
        const k = this._envCache.keys().next().value;
        const old = this._envCache.get(k);
        this._envCache.delete(k);
        if (this._envMap !== old) old.dispose();
      }
    }
    this._envMap = tex;
    return tex;
  }
  get envMap() { return this._envMap; }

  /**
   * 预编译场景着色器（异步，避免首帧集中编译造成的卡顿）
   * 不支持 compileAsync 的旧版渲染器退回同步 compile。
   * 返回 Promise：加载界面可等它（以及随后首帧）画完再撤下，避免进关瞬间卡一下。
   */
  async warmup(scene, camera) {
    if (!scene || !camera) return;
    const r = this.renderer;
    try {
      if (typeof r.compileAsync === 'function') {
        await r.compileAsync(scene, camera);
      } else if (typeof r.compile === 'function') {
        r.compile(scene, camera);
      }
    } catch (e) { /* 预编译失败不影响正常渲染 */ }
  }

  /**
   * 出一帧：预渲染钩子 →（后处理 或 直接渲场景/叠加层）→ 统计。
   * 返回渲染统计（供引擎写入 stats），未渲染时返回 null。
   */
  renderFrame(view, dt) {
    const v = view;
    if (!v || !v.scene || !v.camera) return null;
    this.renderer.info.reset();
    // 预渲染（水边泡沫需要的深度图等）：在主渲染之前占用一次渲染，统计数值不受影响
    if (v.beforeRender) {
      try { v.beforeRender(this.renderer, v.camera); } catch (e) { console.error('[host] beforeRender 异常', e); }
      this.renderer.info.reset();
    }
    // 关卡启用了「后处理对象」时由 postfx 接管：渲染到 HDR RT → 全屏调色 → canvas
    let post = false;
    if (this.postfx) {
      try { post = this.postfx.render(this.renderer, v, dt); } catch (e) { console.error('[host] postfx 异常', e); post = false; }
      if (post) this.renderer.setRenderTarget(null);
    }
    if (!post) {
      if (v.overlay) {
        this.renderer.autoClear = false;
        this.renderer.clear(true, true, true);
        this.renderer.render(v.scene, v.camera);
        this.renderer.clearDepth();
        this.renderer.render(v.overlay.scene, v.overlay.camera);
        this.renderer.autoClear = true;
      } else {
        this.renderer.render(v.scene, v.camera);
      }
    }
    return {
      tris: this.renderer.info.render.triangles,
      calls: this.renderer.info.render.calls,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
    };
  }

  /** 进程内渲染无需向别处同步场景结构：空实现，保持接口一致 */
  markSceneDirty() { }

  /** 进程内渲染直接读主线程对象，无需热通道：空实现 */
  hot() { }
  hotAttrs() { }
  hotState() { }
  trackMaterial() { }
  hotMaterial() { }
  hotTexture() { }
  addObject() { }
  removeObject() { }
  /** 渲染子系统描述 / 每帧渲染参数 / 视口：进程内直接跑，无跨线程通道 */
  setRenderDescriptors() { }
  setRenderParamsProvider() { }
  setViewport() { }

  dispose() {
    if (this.postfx) this.postfx.dispose();
    for (const tex of this._envCache.values()) tex.dispose();
    this._envCache.clear();
    this._envMap = null;
    this.renderer.dispose();
  }
}

/* ============================================================
   渲染 Worker 宿主
   ------------------------------------------------------------
   把 #gl 的绘制控制权转移给 OffscreenCanvas，真正出图发生在 Worker 线程：
   主线程的 _loop 只做「物理 + 输入 + 逻辑 + 把场景描述/相机发出去」，不再阻塞在 render()。
   渲染期子系统（后处理 / 体积雾 / 遮挡剔除 / 泡沫深度 / 玻璃捕获 / 反射捕获 / PMREM 环境）
   全部在 Worker 内运行，主线程只下发「关卡派生数据」与每帧参数（见 render-pipeline.js）。
   代价：
     · engine.renderer / engine.postfx 为 null —— 上层不能用它们做渲染期操作，需走本宿主的转发接口；
     · 场景结构通过 markSceneDirty() 做一次快照，热通道逐帧只推被写过的对象。
   ============================================================ */
export class WorkerHost {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const q = settings.qualityPreset();
    this.mode = 'worker';
    this.canvas = canvas;
    this.offscreen = true;
    this._quality = q;
    this.maxPixelRatio = q.pixelRatio;
    this.renderer = null;      // 渲染器在 Worker 内
    this.postfx = null;
    this._ready = false;
    this._failed = false;
    this._queue = [];
    this._stats = null;

    this.bridge = new RenderBridge((msg, transfer) => this._send(msg, transfer));

    const url = new URL('./render-worker.js', import.meta.url);
    this.worker = new Worker(url, { type: 'module' });
    this.worker.onmessage = (ev) => this._onMsg(ev.data);
    this.worker.onerror = (e) => { this._failed = true; console.error('[host] 渲染 Worker 出错', e); };

    const off = canvas.transferControlToOffscreen();
    this.offscreenCanvas = off;
    const cssW = canvas.clientWidth || window.innerWidth;
    const cssH = canvas.clientHeight || window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    this.worker.postMessage({
      t: MSG.INIT, canvas: off,
      width: cssW, height: cssH, pixelRatio: pr,
      quality: q,
      screen: { exposure: BASE_EXPOSURE, toneMapping: THREE.ACESFilmicToneMapping, colorSpace: THREE.SRGBColorSpace },
    }, [off]);
  }

  _send(msg, transfer) {
    if (this._failed) return;
    const w = this.worker;
    if (!w) return;
    if (this._ready) { try { w.postMessage(msg, transfer || []); } catch (e) { /* ignore */ } }
    else this._queue.push([msg, transfer || []]);
  }

  _onMsg(m) {
    switch (m.t) {
      case MSG.READY:
        this._ready = true;
        try { if (m.caps && m.caps.maxTextureSize) setMaxTextureSize(m.caps.maxTextureSize); } catch (e) { /* ignore */ }
        for (const [msg, tr] of this._queue) { try { this.worker.postMessage(msg, tr); } catch (e) { /* ignore */ } }
        this._queue.length = 0;
        break;
      case MSG.STATS:
        this._stats = m.stats;
        break;
      case MSG.ERROR:
        console.error('[host] 渲染 Worker 报告错误', m.message, m.stack || '');
        break;
      case MSG.LOST:
        this._failed = true;
        console.error('[host] 渲染 Worker WebGL 上下文丢失');
        break;
      default: break;
    }
  }

  setSize(w, h, pr) {
    this._send({ t: MSG.RESIZE, width: w, height: h, pixelRatio: pr });
  }

  applyQuality(q) {
    this._quality = q;
    this.maxPixelRatio = q.pixelRatio;
    this._send({ t: MSG.QUALITY, quality: q });
  }
  get quality() { return this._quality; }

  applyScreen(s) {
    // 饱和度 / 染色在 CPU 上合成 3×3 矩阵（主线程这份 uniform 会被桥接层每帧同步给 Worker）
    const t = s.tint;
    setScreenGrade(s.saturation, t ? t[0] : 1, t ? t[1] : 1, t ? t[2] : 1);
    // 只把「会触发着色器重编译」的色调映射 / 色彩空间 / 曝光发过去，且值没变就不发
    const key = `${s.toneMapping}|${s.colorSpace}|${s.exposure}`;
    if (key === this._screenKey) return;
    this._screenKey = key;
    this._send({ t: MSG.SCREEN, screen: s });
  }
  resetScreen() {
    this.applyScreen({ exposure: BASE_EXPOSURE, toneMapping: THREE.ACESFilmicToneMapping, colorSpace: THREE.SRGBColorSpace });
  }

  markSceneDirty() { this.bridge.markSceneDirty(); }

  /** 本帧被写过位姿的对象 → 热通道（每帧帧末随相机一起下发） */
  hot(obj, recursive) { this.bridge.pushTransform(obj, recursive); }
  hotAttrs(obj) { this.bridge.pushAttrs(obj); }
  hotState(obj) { this.bridge.pushState(obj); }
  trackMaterial(mat) { this.bridge.trackMaterial(mat); }
  hotMaterial(mat) { this.bridge.hotMaterial(mat); }
  hotTexture(tex) { this.bridge.hotTexture(tex); }
  addObject(obj) { this.bridge.addObject(obj); }
  removeObject(obj) { this.bridge.removeObject(obj); }

  /** 渲染子系统描述（雾对象 / 玻璃 / 泡沫 / 遮挡 / 反射捕获）：结构变化时下发一次 */
  setRenderDescriptors(desc) { this.bridge.setRenderDescriptors(desc); }

  /** 每帧渲染参数提供器（后处理 / 体积雾系数）：帧消息里随 postfx 字段下发 */
  setRenderParamsProvider(fn) { this.bridge.setRenderParamsProvider(fn); }

  /** 视口区域（编辑器 / 大厅分屏）：渲染器跑在 Worker 内，需转发 setViewport/setScissor */
  setViewport(rect) { this._send({ t: MSG.VIEWPORT, rect: rect || null }); }

  /**
   * 环境贴图（IBL）：主线程把等距柱状全景图 copy 成 ImageBitmap 发过去，
   * PMREM 由 Worker 内用 OffscreenCanvas 上的渲染器完成（见 scene-mirror.applyEnv）。
   * 返回 null —— 主线程侧不持有 PMREM 结果，scene.environment 由镜像侧自行应用。
   */
  buildEnv(equirectTexture) {
    const img = equirectTexture && equirectTexture.image;
    if (!img || typeof createImageBitmap !== 'function') return null;
    if (!(img.width || img.naturalWidth)) return null;
    const props = {
      mapping: equirectTexture.mapping,
      colorSpace: equirectTexture.colorSpace,
    };
    createImageBitmap(img, { colorSpaceConversion: 'none' })
      .then((bitmap) => {
        try { this._send({ t: MSG.ENV, bitmap, mapping: props.mapping, colorSpace: props.colorSpace }, [bitmap]); }
        catch (e) { /* ignore */ }
      })
      .catch(() => { /* 全景图不可用：跳过 IBL */ });
    return null;
  }
  get envMap() { return null; }

  /** 预编译由 Worker 首帧自身承担，这里直接返回 */
  warmup() { return Promise.resolve(); }

  renderFrame(view, dt) {
    this.bridge.flush(view, dt);
    return this._stats;
  }

  dispose() {
    try { this.bridge.dispose(); this.worker.postMessage({ t: MSG.DISPOSE }); } catch (e) { /* ignore */ }
    try { this.worker.terminate(); } catch (e) { /* ignore */ }
    this.worker = null;
  }
}
