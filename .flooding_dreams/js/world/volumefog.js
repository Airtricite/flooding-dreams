/* ============================================================
   体积雾管线（VolumeFog）
   ------------------------------------------------------------
   逐对象、全分辨率的体积光线步进太贵（每像素最多 24 步 × 每步一次程序化噪声）。
   这里把它改成「真体积雾」的三段式管线，只在关卡里真的放了雾对象时才接管：

     ① 深度预渲染（半分辨率）：把不透明场景写进一张带深度贴图的 RT。
        半分辨率的雾缓冲没有深度测试，墙后的雾必须靠这张深度图裁掉。
     ② 雾缓冲（半分辨率）：只画雾网格（独占渲染层 FOG_LAYER），预乘输出。
     ③ 时域重投影累积（半分辨率）：用当前帧深度反投影出世界坐标，再用上一帧的
        VP 投回去取历史，按 3×3 邻域钳制后混合 —— 把逐帧抖动的步进噪声抹平，
        于是步数可以从 24 降到 16 而观感更好。

   结果交给 PostFX：在全屏调色 pass 里「预乘 over」叠到场景上（色调映射之前）。

   生命周期：由 LevelBuilder 创建 / 注册 / 销毁；渲染由 PostFX.render 驱动。
   ============================================================ */
import * as THREE from '../core/three-ns.js';
import { FOG_PASS_UNIFORMS } from '../core/shader-uniforms.js';

/** 雾网格独占的渲染层：主场景 pass 看不到它，雾 pass 只看它 */
export const FOG_LAYER = 1;

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/* 时域重投影累积：当前帧原始雾 × 上一帧历史 */
const ACCUM_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFog;
uniform sampler2D uHistory;
uniform sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec2 uTexel;
uniform float uBlend;
void main() {
  vec4 cur = texture2D(uFog, vUv);
  // 当前帧深度 → 世界坐标 → 上一帧 VP → 历史采样位置
  float dz = texture2D(uDepth, vUv).x;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, dz * 2.0 - 1.0, 1.0);
  vec4 ws = uInvViewProj * ndc;
  vec3 wp = ws.xyz / ws.w;
  vec4 pv = uPrevViewProj * vec4(wp, 1.0);
  vec2 puv = pv.xy / max(pv.w, 1e-5) * 0.5 + 0.5;
  vec4 hist = vec4(0.0);
  if (pv.w > 0.0 && puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) {
    hist = texture2D(uHistory, puv);
  }
  // 3×3 邻域钳制：重投影错位时把历史拉回当前帧附近，避免拖影
  vec4 mn = cur, mx = cur;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec4 s = texture2D(uFog, vUv + vec2(float(x), float(y)) * uTexel);
      mn = min(mn, s); mx = max(mx, s);
    }
  }
  vec4 ctr = (mn + mx) * 0.5;
  vec4 ext = (mx - mn) * 0.5 + 1e-4;
  hist = ctr + clamp(hist - ctr, -ext, ext);
  gl_FragColor = mix(hist, cur, clamp(uBlend, 0.0, 1.0));
}`;

const _sizeV2 = new THREE.Vector2();
const _clearV = new THREE.Color();

/* ---------- Halton 低差异序列：逐帧抖动步进起点 ---------- */
function halton(i, b) {
  let f = 1, r = 0, n = i;
  while (n > 0) { f /= b; r += f * (n % b); n = Math.floor(n / b); }
  return r;
}

/** 半分辨率系数：低画质再降一档，尽量把雾的开销压住。
 *  由渲染侧按画质注入（主线程从 settings 读，渲染 Worker 里从启动参数读）——
 *  本模块需要能在 Worker 中运行，不能直接 import settings（构造时会碰 localStorage）。 */
let _fogScale = 0.5;
export function setFogScale(k) {
  const v = Number(k);
  if (Number.isFinite(v) && v > 0) _fogScale = v;
}
function fogScale() { return _fogScale; }

export class VolumeFog {
  constructor(scene, root) {
    this.scene = scene;
    this.root = root;
    this.records = new Set();
    this._depth = null;
    this._raw = null;
    this._a = null;          // 历史（上一帧累积结果）
    this._b = null;          // 本帧写入目标（写完后与 _a 交换）
    this._w = 0; this._h = 0;
    this._failed = false;
    this._fresh = true;      // 历史无效（新建 / 尺寸变化 / 关卡切换）→ 本帧只用当前帧
    this._idx = 0;
    this._vp = new THREE.Matrix4();
    this._invVP = new THREE.Matrix4();
    this._prevVP = new THREE.Matrix4();
    this._jitter = new THREE.Vector2();

    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._quad.frustumCulled = false;
    this._passScene = new THREE.Scene();
    this._passScene.add(this._quad);
    this._passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._accum = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: ACCUM_FRAG,
      depthTest: false, depthWrite: false,
      uniforms: {
        uFog: { value: null }, uHistory: { value: null }, uDepth: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2() },
        uBlend: { value: 1 },
      },
    });
    this._depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  }

  /** 是否有可渲染的雾对象（PostFX 据此决定要不要接管这一帧） */
  get active() {
    if (this._failed) return false;
    for (const rec of this.records) if (rec.o && rec.o.visible !== false && rec.mesh) return true;
    return false;
  }

  /** 注册一个雾对象：网格挪到独占层，主场景 pass 不再绘制它 */
  register(rec) {
    this.records.add(rec);
    this._setLayer(rec, this._failed ? 0 : FOG_LAYER);
  }

  unregister(rec) {
    this.records.delete(rec);
  }

  /** 历史作废（关卡重载 / 传送 / 相机被外力改写时调用） */
  reset() { this._fresh = true; }

  _setLayer(rec, layer) {
    const m = rec && rec.mesh;
    if (m && m.layers && m.layers.mask !== (1 << layer)) m.layers.set(layer);
  }

  /** 管线不可用：把雾网格还给主场景 pass（退回逐对象渲染，只是没有半分辨率 / 时域） */
  _releaseLayer() {
    FOG_PASS_UNIFORMS.depthOn.value = 0;
    FOG_PASS_UNIFORMS.depthTex.value = null;
    for (const rec of this.records) this._setLayer(rec, 0);
  }

  _ensure(renderer, w, h) {
    if (this._raw && this._w === w && this._h === h) return true;
    this._disposeTargets();
    try {
      const dt = new THREE.DepthTexture(w, h);
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      this._depth = new THREE.WebGLRenderTarget(w, h, {
        depthTexture: dt, depthBuffer: true, stencilBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      const mk = () => new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
      this._raw = mk(); this._a = mk(); this._b = mk();
      this._w = w; this._h = h;
      this._fresh = true;
      return true;
    } catch (e) {
      console.warn('[volumefog] 半分辨率缓冲创建失败，体积雾退回逐对象渲染', e);
      this._failed = true;
      this._disposeTargets();
      this._releaseLayer();
      return false;
    }
  }

  /**
   * 跑一遍雾管线。渲染器状态由本函数自行保存 / 恢复。
   * @returns 累积后的雾纹理（预乘，半分辨率）；无雾可画时返回 null
   */
  render(renderer, camera) {
    if (this._failed || !camera) return null;
    if (!renderer.capabilities || !renderer.capabilities.isWebGL2) {
      console.warn('[volumefog] 需要 WebGL2，体积雾退回逐对象渲染');
      this._failed = true;
      this._releaseLayer();
      return null;
    }
    const recs = [];
    for (const rec of this.records) if (rec.mesh && rec.o && rec.o.visible !== false) recs.push(rec);
    if (!recs.length) return null;

    const size = renderer.getDrawingBufferSize(_sizeV2);
    const k = fogScale();
    const w = Math.max(2, Math.floor(size.x * k));
    const h = Math.max(2, Math.floor(size.y * k));
    if (!this._ensure(renderer, w, h)) return null;

    // 相机矩阵（主场景 pass 刚跑过，这里的矩阵就是当下的）
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._invVP.copy(this._vp).invert();
    this._idx++;
    this._jitter.set(halton(this._idx, 2), halton(this._idx, 3));

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.getClearColor(_clearV);
    const prevAlpha = renderer.getClearAlpha();
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevBg = this.scene.background;
    const prevLayers = camera.layers.mask;

    /* ① 深度预渲染：不透明场景 → 半分辨率深度图 */
    renderer.shadowMap.autoUpdate = false;
    this.scene.background = null;
    this.scene.overrideMaterial = this._depthMat;
    const hidden = [];
    for (const c of this.scene.children) {
      if (c !== this.root && c.visible) { c.visible = false; hidden.push(c); }
    }
    this.root.traverse((c) => {
      if (!c.visible) return;
      if (c.isMesh) {
        const m = c.material;
        // 半透明 / 不写色 / 粒子 / 线：不是实心遮挡体，进深度图会裁掉本该存在的雾
        if (m && (m.transparent || m.colorWrite === false)) { c.visible = false; hidden.push(c); }
      } else if (c.isPoints || c.isLine || c.isSprite) { c.visible = false; hidden.push(c); }
    });
    renderer.setRenderTarget(this._depth);
    renderer.autoClear = true;
    renderer.render(this.scene, camera);
    this.scene.overrideMaterial = null;
    this.scene.background = prevBg;
    for (const c of hidden) c.visible = true;

    /* ② 雾网格 → 半分辨率预乘缓冲（透明底，只画独占层） */
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this._raw);
    renderer.autoClear = false;
    renderer.clear(true, false, false);
    this.scene.background = null;
    FOG_PASS_UNIFORMS.depthOn.value = 1;
    FOG_PASS_UNIFORMS.depthTex.value = this._depth.depthTexture;
    FOG_PASS_UNIFORMS.res.value.set(this._w, this._h);
    FOG_PASS_UNIFORMS.jitter.value.copy(this._jitter);
    FOG_PASS_UNIFORMS.invViewProj.value.copy(this._invVP);
    camera.layers.set(FOG_LAYER);
    renderer.render(this.scene, camera);
    camera.layers.mask = prevLayers;
    this.scene.background = prevBg;

    /* ③ 时域重投影累积 */
    const u = this._accum.uniforms;
    u.uFog.value = this._raw.texture;
    u.uHistory.value = this._a.texture;
    u.uDepth.value = this._depth.depthTexture;
    u.uInvViewProj.value.copy(this._invVP);
    u.uPrevViewProj.value.copy(this._prevVP);
    u.uTexel.value.set(1 / this._w, 1 / this._h);
    u.uBlend.value = this._fresh ? 1 : 0.3;
    this._quad.material = this._accum;
    renderer.setRenderTarget(this._b);
    renderer.render(this._passScene, this._passCam);
    const t = this._a; this._a = this._b; this._b = t;   // 本帧结果 → 下一帧历史
    this._fresh = false;
    this._prevVP.copy(this._vp);

    // 渲染器状态复位
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
    renderer.setClearColor(_clearV, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadow;
    return this._a.texture;
  }

  _disposeTargets() {
    for (const rt of [this._depth, this._raw, this._a, this._b]) if (rt) rt.dispose();
    this._depth = this._raw = this._a = this._b = null;
    this._w = 0; this._h = 0;
  }

  dispose() {
    FOG_PASS_UNIFORMS.depthOn.value = 0;
    FOG_PASS_UNIFORMS.depthTex.value = null;
    this._disposeTargets();
    this._accum.dispose();
    this._depthMat.dispose();
    this._quad.geometry.dispose();
    this.records.clear();
  }
}
