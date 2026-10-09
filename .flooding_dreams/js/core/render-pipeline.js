/* ============================================================
   渲染管线（Worker 侧）
   ------------------------------------------------------------
   把原先跑在主线程 beforeRender / postfx 里的「渲染期」子系统收拢到渲染线程：
     · 泡沫深度预渲染（半分辨率深度图，供水面「深度差」起沫）
     · 遮挡剔除（CPU 软件遮挡剔除，隐藏被完全挡住的物体）
     · 玻璃屏幕空间折射缓冲（半分辨率颜色 + 深度）
     · 体积雾（半分辨率 + 时域累积，由 PostFX 在调色前合成）
     · 后处理（全屏调色 / 泛光 / 特殊效果）
     · 一次性场景反射捕获（高级材质用的立方体贴图 + PMREM）

   这些模块本身只依赖 three + 数值，原样在 Worker 内运行；主线程负责把
   「关卡派生数据」（雾对象 / 玻璃网格 / 是否要泡沫深度 / 反射中心半径）与
   每帧「后处理参数」下发过来，不传 level 对象、不传函数。

   顺序与主线程管线一致（见 session.js 的 view.beforeRender）：
     恢复剔除可见性 → 泡沫深度 → 遮挡剔除 → 玻璃捕获 → 后处理（含体积雾）
   ============================================================ */
import * as THREE from './three-ns.js';
import { PostFX } from './postfx.js';
import { FOAM_DEPTH, withScreenGradeOff } from './shader-uniforms.js';
import { VolumeFog, setFogScale } from '../world/volumefog.js';
import { OcclusionCuller } from '../world/occlusion.js';
import { renderGlassCapture, captureReflections } from '../world/advanced-materials.js';

const _tmpV2 = new THREE.Vector2();

export class RenderPipeline {
  /**
   * @param {THREE.WebGLRenderer} renderer 跑在 OffscreenCanvas 上的渲染器
   * @param {import('./scene-mirror.js').SceneMirror} mirror 镜像场景（提供 scene / objects / recs）
   */
  constructor(renderer, mirror) {
    this.renderer = renderer;
    this.mirror = mirror;
    this.desc = null;               // 渲染子系统描述（见 builder.renderDescriptors）
    this.postfx = new PostFX(renderer, 4);
    this.fog = null;                // VolumeFog（有雾对象时才建）
    this._fogRecs = [];
    this._culler = null;
    this._cullAdapter = null;
    this._foamRT = null;
    this._depthOnlyMat = null;
    this._reflectionDone = false;
    this._framePostfx = null;
    this.postfx.setProvider(() => this._framePostfx);
  }

  /* ---------- 画质 / 子系统描述 ---------- */

  setQuality(q) {
    const antialias = !!(q && q.antialias);
    this.postfx.setSamples(antialias ? 4 : 0);
  }

  /**
   * 下发渲染子系统描述。结构变化（关卡加载 / 对象增删 / 天空更换）时调用一次。
   * desc = {
   *   occlusion: bool, foam: bool, fogScale: number,
   *   fog: [uuid...], glass: [{uuid, advMat}], reflections: {center, radius} | null
   * }
   */
  setDescriptors(desc) {
    this.desc = desc || null;
    if (!desc) return;
    setFogScale(desc.fogScale);
    this._syncFog(desc.fog);
    this._syncCuller(desc.occlusion);
    this._reflectionDone = false;
    if (desc.reflections) this._captureReflections(desc.reflections);
  }

  _syncFog(uuids) {
    const list = uuids || [];
    const need = list.length > 0;
    if (!need) {
      if (this.fog) { this.fog.dispose(); this.fog = null; this.postfx.setVolumeFog(null); }
      this._fogRecs = [];
      return;
    }
    if (!this.fog) {
      // 深度预渲染只保留「关卡本体」：scene 下名为 level 的组，排除挂在场景根的辅助节点
      const near = this.mirror.levelRoot || this.mirror.scene;
      this.fog = new VolumeFog(this.mirror.scene, near);
      this.postfx.setVolumeFog(this.fog);
    }
    // 重建注册（结构可能整棵换了）
    for (const rec of this._fogRecs) this.fog.unregister(rec);
    this._fogRecs = [];
    for (const id of list) {
      const rec = this.mirror.recs.get(id);
      if (!rec || !rec.mesh) continue;
      this.fog.register(rec);
      this._fogRecs.push(rec);
    }
    this.fog.reset();
  }

  _syncCuller(on) {
    if (!on) {
      if (this._culler) { this._culler.dispose(); this._culler = null; }
      return;
    }
    if (!this._culler) {
      const mirror = this.mirror;
      this._cullAdapter = {
        objects: mirror.recs,
        editor: false,
        get root() { return mirror.scene; },
        get cullVersion() { return mirror.cullVersion; },
      };
      this._culler = new OcclusionCuller(this._cullAdapter);
    }
  }

  /* ---------- 每帧 ---------- */

  /**
   * 出这一帧（替代裸 renderer.render）。
   * @param {THREE.Camera} camera
   * @param {object} frame 主线程帧消息（取 postfx / dt）
   */
  render(camera, frame) {
    const renderer = this.renderer;
    const scene = this.mirror.scene;
    if (!scene || !camera) return;
    const dt = frame ? frame.dt || 0 : 0;
    this._framePostfx = frame ? frame.postfx || null : null;

    const desc = this.desc || {};
    // 上一帧被剔除隐藏的物体先恢复：泡沫深度图要看到完整场景
    if (this._culler) this._culler.restore();

    renderer.info.reset();
    if (desc.foam) this._renderFoamDepth(camera);
    else FOAM_DEPTH.on.value = 0;
    if (desc.occlusion && this._culler) {
      try { this._culler.run(camera); } catch (e) { /* 剔除失败不影响出帧 */ }
    }
    if (desc.glass && desc.glass.length) {
      try { renderGlassCapture(renderer, scene, camera, this._glassBuilder()); } catch (e) { /* ignore */ }
    }

    let post = false;
    try {
      post = this.postfx.render(renderer, { scene, camera }, dt);
    } catch (e) {
      console.error('[pipeline] postfx 异常', e);
      post = false;
    }
    if (post) renderer.setRenderTarget(null);
    if (!post) {
      renderer.render(scene, camera);
    }
  }

  /* ---------- 泡沫深度（半分辨率深度预渲染） ---------- */
  _renderFoamDepth(camera) {
    const renderer = this.renderer;
    const scene = this.mirror.scene;
    const buf = renderer.getDrawingBufferSize(_tmpV2);
    const w = Math.max(2, Math.floor(buf.x * 0.5));
    const h = Math.max(2, Math.floor(buf.y * 0.5));
    if (!this._foamRT || this._foamRT.width !== w || this._foamRT.height !== h) {
      if (this._foamRT) this._foamRT.dispose();
      const dt = new THREE.DepthTexture(w, h);
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      const rt = new THREE.WebGLRenderTarget(w, h, {
        depthTexture: dt, stencilBuffer: false, depthBuffer: true,
      });
      rt.texture.minFilter = THREE.NearestFilter;
      rt.texture.magFilter = THREE.NearestFilter;
      this._foamRT = rt;
    }
    if (!this._depthOnlyMat) this._depthOnlyMat = new THREE.MeshBasicMaterial({ colorWrite: false });

    // 水体与泡沫自身不进深度图（只保留它们后面的场景）
    const hidden = [];
    for (const rec of this.mirror.recs.values()) {
      if (rec.o.type !== 'liquid') continue;
      const m = rec.mesh;
      if (m && m.visible) { m.visible = false; hidden.push(m); }
    }
    // 半透明 / 粒子 / 线条不是实心边界，会激出假泡沫（泡沫网格材质 transparent → 一并排除）
    scene.traverse((c) => {
      if (!c.visible) return;
      if (c.isMesh) {
        const m = c.material;
        if (m && (m.transparent || m.colorWrite === false)) { c.visible = false; hidden.push(c); }
      } else if (c.isPoints || c.isLine || c.isSprite) {
        c.visible = false; hidden.push(c);
      }
    });
    // 只保留关卡本体：编辑器 gizmo / 网格 / 粒子都在场景根上，不该在水面上激出泡沫
    const levelRoot = this.mirror.levelRoot || scene;
    const hiddenKids = [];
    for (const c of scene.children) {
      if (c !== levelRoot && c.visible) { c.visible = false; hiddenKids.push(c); }
    }

    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    scene.overrideMaterial = this._depthOnlyMat;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;
    renderer.setRenderTarget(this._foamRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    for (const c of hiddenKids) c.visible = true;
    for (const m of hidden) m.visible = true;

    FOAM_DEPTH.scene.value = this._foamRT.depthTexture;
    FOAM_DEPTH.res.value.set(buf.x, buf.y);
    FOAM_DEPTH.near.value = camera.near;
    FOAM_DEPTH.far.value = camera.far;
    FOAM_DEPTH.on.value = 1;
  }

  /* ---------- 玻璃：把玻璃网格列表包装成 renderGlassCapture 认的「构建器」 ---------- */
  _glassBuilder() {
    if (!this._glassMap) this._glassMap = new Map();
    return { objects: this._glassMap };
  }

  refreshGlassMap() {
    const list = (this.desc && this.desc.glass) || [];
    if (!this._glassMap) this._glassMap = new Map();
    this._glassMap.clear();
    for (const g of list) {
      const obj = this.mirror.objects.get(g.uuid);
      if (obj) this._glassMap.set(g.uuid, { o: { advMat: g.advMat || 'glass' }, mesh: obj });
    }
  }

  /* ---------- 一次性场景反射捕获（高级材质） ---------- */
  _captureReflections(r) {
    if (this._reflectionDone || !r) return;
    this._reflectionDone = true;
    const c = r.center || [0, 0, 0];
    const center = new THREE.Vector3(c[0], c[1], c[2]);
    let tex = null;
    try {
      // 捕获用的环境贴图不能带画面调色（饱和度 / 染色），否则反射面会被染两次
      tex = withScreenGradeOff(() => captureReflections(this.renderer, this.mirror.scene, center, r.radius));
    } catch (e) { /* 反射捕获失败：高级材质退回天空 IBL */ }
    if (tex && this.mirror.reflectMats) {
      for (const mat of this.mirror.reflectMats) {
        try { mat.envMap = tex; mat.needsUpdate = true; } catch (e) { /* ignore */ }
      }
    }
  }

  dispose() {
    if (this.fog) { this.fog.dispose(); this.fog = null; }
    if (this._culler) { this._culler.dispose(); this._culler = null; }
    if (this._foamRT) { this._foamRT.dispose(); this._foamRT = null; }
    if (this._depthOnlyMat) { this._depthOnlyMat.dispose(); this._depthOnlyMat = null; }
    this.postfx.dispose();
    FOAM_DEPTH.on.value = 0;
    FOAM_DEPTH.scene.value = null;
    this._fogRecs = [];
    this._glassMap = null;
  }
}
