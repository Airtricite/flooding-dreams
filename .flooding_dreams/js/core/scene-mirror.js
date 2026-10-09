/* ============================================================
   场景镜像（Worker 侧）
   ------------------------------------------------------------
   按主线程发来的描述符，在 Worker 里重建一棵等价的 THREE 场景树：
     · 结构消息（scene）一次性重建对象 / 几何 / 材质 / 贴图
     · 帧消息（frame）只更新相机、被写过的对象矩阵、少量共享 uniform
     · 自身 rAF 出帧，重复帧合并（只渲染最新状态）
   重建只覆盖渲染所需：不建物理体、不挂游戏逻辑，matrixAutoUpdate=false。
   ============================================================ */
import * as THREE from './three-ns.js';
import { KIND, HOT_STRIDE } from './render-proto.js';
import { SCREEN_GRADE, SUN_SPEC, SHARED_UNIFORMS, LIQUID_UNIFORMS, PORTAL_UNIFORMS } from './shader-uniforms.js';
import { applyPatchDescriptor } from './shader-patch-registry.js';
import { ADV_UNIFORMS } from '../world/advanced-materials.js';
import { RenderPipeline } from './render-pipeline.js';

const COLOR_PROPS = new Set(['color', 'emissive', 'specular', 'sheenColor', 'attenuationColor']);
const VEC2_PROPS = new Set(['normalScale', 'clearcoatNormalScale']);

export class SceneMirror {
  constructor() {
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.objects = new Map();       // uuid -> Object3D
    this.recs = new Map();          // uuid -> 渲染记录（供遮挡剔除 / 泡沫深度 / 体积雾读取）
    this.levelRoot = null;          // 关卡本体容器（scene 下名为 level 的组）
    this.geometries = new Map();
    this.materials = new Map();
    this.textures = new Map();
    this.reflectMats = new Set();   // 需要绑定「场景反射贴图」的材质（高级材质）
    this.cullVersion = 0;           // 对象集合版本号：变了遮挡剔除才重建内部列表
    this.pipeline = null;
    this._envData = null;           // 环境贴图源（ImageBitmap + 参数），场景重建后重挂
    this._envPmrem = null;          // PMREM 结果
    this._envKey = null;
    this._pendingFrame = null;
    this._raf = 0;
    this._running = false;
    this._driven = false;
    this._statsCb = null;
    this.quality = null;
  }

  /**
   * @param {OffscreenCanvas} canvas
   * @param {object} opts { width, height, pixelRatio, quality }
   */
  init(canvas, opts) {
    const q = opts.quality || {};
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !!q.antialias,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      logarithmicDepthBuffer: false,
    });
    this.renderer.setClearColor(0x0b0a14, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if ('useLegacyLights' in this.renderer) this.renderer.useLegacyLights = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = !!q.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.quality = q;
    this.setSize(opts.width, opts.height, opts.pixelRatio);
    this.scene = new THREE.Scene();
    this.scene.name = 'mirror';
    this.camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.12, 8000);
    this.camera.rotation.order = 'YXZ';
    this.camera.matrixAutoUpdate = false;
    this.pipeline = new RenderPipeline(this.renderer, this);
    this.pipeline.setQuality(q);
    this._start();
    return { maxTextureSize: this.renderer.capabilities.maxTextureSize, webgl2: this.renderer.capabilities.isWebGL2 !== false };
  }

  setSize(w, h, pr) {
    this.renderer.setPixelRatio(pr || 1);
    this.renderer.setSize(w, h, false);
  }

  /** 编辑器 / 大厅视口矩形（CSS 像素）；null = 全画布 */
  setViewport(r) {
    if (!r) return;
    this.renderer.setViewport(r.x || 0, r.y || 0, r.w, r.h);
    this.renderer.setScissor(r.x || 0, r.y || 0, r.w, r.h);
    this.renderer.setScissorTest(!!r.scissor);
  }

  applyQuality(q) {
    this.quality = q;
    this.renderer.shadowMap.enabled = !!q.shadows;
    if (this.pipeline) this.pipeline.setQuality(q);
  }

  applyScreen(s) {
    const r = this.renderer;
    if (s.toneMapping !== undefined && r.toneMapping !== s.toneMapping) r.toneMapping = s.toneMapping;
    if (s.colorSpace !== undefined && r.outputColorSpace !== s.colorSpace) r.outputColorSpace = s.colorSpace;
    if (Number.isFinite(s.exposure) && r.toneMappingExposure !== s.exposure) r.toneMappingExposure = s.exposure;
  }

  /* ---------- 结构通道 ---------- */
  applyScene(d) {
    this.disposeScene();
    // 根节点
    const root = new THREE.Scene();
    root.name = 'mirror';
    root.uuid = d.root.uuid;
    root.scale.fromArray(d.root.scale || [1, 1, 1]);
    root.matrixAutoUpdate = true;
    this.scene = root;
    this.objects.set(root.uuid, root);
    this._applyBackground(root, d.root.background);
    this._applyFog(root, d.root.fog);

    // 贴图 → 几何 → 材质
    for (const id in d.textures) this.textures.set(id, this._buildTexture(d.textures[id]));
    for (const id in d.geometries) this.geometries.set(id, this._buildGeometry(d.geometries[id]));
    for (const id in d.materials) this.materials.set(id, this._buildMaterial(d.materials[id]));

    // 第一遍：建对象 + 挂父节点（描述符已是父在前）
    const skinned = [];
    for (const n of d.nodes) {
      const obj = this._buildObject(n);
      if (!obj) continue;
      this.objects.set(n.uuid, obj);
      // 只给「关卡对象的主渲染节点」建渲染记录（builder 打标 userData.__o）：
      // 遮挡剔除 / 泡沫深度 / 体积雾按这些记录工作，与主线程 builder.objects 一一对应
      if (n.o) this.recs.set(n.uuid, this._rec(n, obj));
      const parent = n.parent ? this.objects.get(n.parent) : root;
      (parent || root).add(obj);
      if (n.kind === KIND.SKINNED) skinned.push(n);
    }
    // 第二遍：骨骼 / 蒙皮（骨骼对象此时已全部建好）
    for (const n of skinned) this._bindSkeleton(n);

    // 环境贴图交给 ENV 通道（PMREM 在 Worker 内做）；场景重建后重挂已缓存的结果
    this._applyEnvTo(root);
    root.updateMatrixWorld(true);
    // 关卡本体容器（builder.root.name === 'level'）：泡沫深度 / 体积雾只保留它，
    // 排除编辑器 gizmo / 图纸 / 粒子等挂在场景根上的辅助节点
    this.levelRoot = root.getObjectByName('level') || root;

    this.cullVersion++;
    if (this.pipeline) {
      this.pipeline.setDescriptors(d.render);
      this.pipeline.refreshGlassMap();
    }
  }

  /** 节点描述符 → 渲染记录（遮挡剔除 / 泡沫深度 / 体积雾共用） */
  _rec(n, obj) {
    const o = n.o || {};
    return {
      uuid: n.uuid,
      mesh: obj,
      type: o.type || 'mesh',
      o: { type: o.type || 'mesh', shape: o.shape || null, visible: true },
      disposed: false,
      batched: false,
      pendingModel: false,
    };
  }

  _buildObject(n) {
    let obj = null;
    switch (n.kind) {
      case KIND.GROUP: obj = new THREE.Group(); break;
      case KIND.BONE: obj = new THREE.Bone(); break;
      case KIND.MESH: obj = new THREE.Mesh(this.geometries.get(n.geometry), this._mat(n.material)); break;
      case KIND.SKINNED: obj = new THREE.SkinnedMesh(this.geometries.get(n.geometry), this._mat(n.material)); break;
      case KIND.POINTS: obj = new THREE.Points(this.geometries.get(n.geometry), this._mat(n.material)); break;
      case KIND.LINE: obj = new THREE.Line(this.geometries.get(n.geometry), this._mat(n.material)); break;
      case KIND.LINE_SEGMENTS: obj = new THREE.LineSegments(this.geometries.get(n.geometry), this._mat(n.material)); break;
      case KIND.LINE_LOOP: obj = new THREE.LineLoop(this.geometries.get(n.geometry), this._mat(n.material)); break;
      case KIND.SPRITE: obj = new THREE.Sprite(this._mat(n.material)); break;
      case KIND.LIGHT: obj = this._buildLight(n.light); break;
      case KIND.INSTANCED: {
        const geo = this.geometries.get(n.geometry);
        const mat = this._mat(n.material);
        obj = new THREE.InstancedMesh(geo, mat, n.count || 0);
        if (n.instanceMatrix) {
          obj.instanceMatrix = new THREE.InstancedBufferAttribute(n.instanceMatrix, 16);
          obj.instanceMatrix.needsUpdate = true;
        }
        if (n.instanceColor) {
          obj.instanceColor = new THREE.InstancedBufferAttribute(n.instanceColor, 3);
          obj.instanceColor.needsUpdate = true;
        }
        break;
      }
      default: obj = new THREE.Group();
    }
    obj.uuid = n.uuid;
    obj.name = n.name || '';
    obj.matrixAutoUpdate = false;
    obj.matrix.fromArray(n.matrix);
    obj.matrixWorldNeedsUpdate = true;
    obj.visible = n.visible !== false;
    obj.renderOrder = n.renderOrder || 0;
    obj.castShadow = !!n.castShadow;
    obj.receiveShadow = !!n.receiveShadow;
    obj.frustumCulled = n.frustumCulled !== false;
    if (n.layers !== undefined && obj.layers) obj.layers.mask = n.layers;
    if (n.center && obj.isSprite) obj.center.fromArray(n.center);
    return obj;
  }

  _mat(ref) {
    if (Array.isArray(ref)) return ref.map((id) => this.materials.get(id));
    return ref ? (this.materials.get(ref) || new THREE.MeshBasicMaterial()) : new THREE.MeshBasicMaterial();
  }

  /* ---------- 灯光重建（类型 + 参数 + 阴影 + 目标点） ---------- */
  _buildLight(d) {
    if (!d) return new THREE.AmbientLight(0xffffff, 1);
    const color = new THREE.Color(d.color);
    let l;
    switch (d.type) {
      case 'hemisphere': l = new THREE.HemisphereLight(color, new THREE.Color(d.groundColor), d.intensity); break;
      case 'directional': l = new THREE.DirectionalLight(color, d.intensity); break;
      case 'spot': l = new THREE.SpotLight(color, d.intensity, d.distance || 0, d.angle || 0, d.penumbra || 0, d.decay != null ? d.decay : 1); break;
      case 'point': l = new THREE.PointLight(color, d.intensity, d.distance || 0, d.decay != null ? d.decay : 1); break;
      case 'rectarea': l = new THREE.RectAreaLight(color, d.intensity, d.width || 1, d.height || 1); break;
      default: l = new THREE.AmbientLight(color, d.intensity);
    }
    l.matrixAutoUpdate = true;   // 下面由 _buildObject 统一改为 false 并写入矩阵

    // 方向性 / 聚光：目标点用世界坐标写入独立 target（加入场景树，避免被父变换影响）
    if ((d.type === 'directional' || d.type === 'spot') && d.target) {
      const t = l.target;
      if (t) {
        t.position.set(d.target[0], d.target[1], d.target[2]);
        t.matrixAutoUpdate = false;
        t.updateMatrix();
        t.matrixWorld.copy(t.matrix);
        if (this.scene) this.scene.add(t);
      }
    }

    l.castShadow = !!d.castShadow;
    const sh = d.shadow;
    if (d.castShadow && sh) {
      if (sh.mapSize) l.shadow.mapSize.set(sh.mapSize[0], sh.mapSize[1]);
      if (sh.bias != null) l.shadow.bias = sh.bias;
      if (sh.normalBias != null) l.shadow.normalBias = sh.normalBias;
      if (sh.radius != null) l.shadow.radius = sh.radius;
      const c = sh.camera, sc = l.shadow.camera;
      if (c && sc) {
        if (c.near != null) sc.near = c.near;
        if (c.far != null) sc.far = c.far;
        if (c.isOrthographic) {
          if (c.left != null) sc.left = c.left;
          if (c.right != null) sc.right = c.right;
          if (c.top != null) sc.top = c.top;
          if (c.bottom != null) sc.bottom = c.bottom;
        } else {
          if (c.fov != null) sc.fov = c.fov;
          if (c.aspect != null) sc.aspect = c.aspect;
        }
        if (c.zoom != null && 'zoom' in sc) sc.zoom = c.zoom;
        if (sc.updateProjectionMatrix) sc.updateProjectionMatrix();
      }
    }
    return l;
  }

  _bindSkeleton(n) {
    const obj = this.objects.get(n.uuid);
    if (!obj || !n.skeleton) return;
    const bones = n.skeleton.bones.map((id) => this.objects.get(id)).filter(Boolean);
    if (bones.length < 2) return;
    try {
      const inverses = (n.skeleton.boneInverses || []).map((m) => {
        const mm = new THREE.Matrix4(); mm.fromArray(m); return mm;
      });
      obj.skeleton = new THREE.Skeleton(bones, inverses);
      if (n.bindMatrix) obj.bindMatrix.fromArray(n.bindMatrix);
      if (n.bindMode) obj.bindMode = n.bindMode;
      obj.bind(obj.skeleton, obj.bindMatrix);
    } catch (e) { /* 蒙皮失败退回静态网格 */ }
  }

  _buildGeometry(d) {
    const geo = new THREE.BufferGeometry();
    geo.uuid = d.uuid;
    geo.name = d.name || '';
    for (const name in d.attributes) {
      const a = d.attributes[name];
      if (!a || !a.array) continue;
      geo.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize, !!a.normalized));
    }
    if (d.index && d.index.array) geo.setIndex(new THREE.BufferAttribute(d.index.array, 1));
    if (d.groups && d.groups.length) for (const g of d.groups) geo.addGroup(g.start, g.count, g.materialIndex);
    if (d.drawRange) geo.setDrawRange(d.drawRange.start, d.drawRange.count);
    return geo;
  }

  _buildTexture(d) {
    let tex = null;
    if (d.source === 'data' && d.data) {
      tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
    } else if (d.source === 'bitmap' && d.bitmap) {
      tex = new THREE.Texture(d.bitmap);
      tex.needsUpdate = true;
    } else {
      tex = new THREE.Texture();
    }
    tex.uuid = d.uuid;
    tex.name = d.name || '';
    if (d.colorSpace !== undefined) tex.colorSpace = d.colorSpace;
    if (d.wrapS !== undefined) tex.wrapS = d.wrapS;
    if (d.wrapT !== undefined) tex.wrapT = d.wrapT;
    if (d.magFilter !== undefined) tex.magFilter = d.magFilter;
    if (d.minFilter !== undefined) tex.minFilter = d.minFilter;
    if (d.anisotropy !== undefined) tex.anisotropy = d.anisotropy;
    if (d.flipY !== undefined) tex.flipY = d.flipY;
    if (d.generateMipmaps !== undefined) tex.generateMipmaps = d.generateMipmaps;
    if (d.mapping !== undefined) tex.mapping = d.mapping;
    if (d.repeat) tex.repeat.fromArray(d.repeat);
    if (d.offset) tex.offset.fromArray(d.offset);
    if (d.center) tex.center.fromArray(d.center);
    if (d.rotation !== undefined) tex.rotation = d.rotation;
    tex.needsUpdate = true;
    return tex;
  }

  _buildMaterial(d) {
    let mat;
    if (d.shader) {
      const Ctor = d.shader.raw ? THREE.RawShaderMaterial : THREE.ShaderMaterial;
      mat = new Ctor({
        vertexShader: d.shader.vertexShader,
        fragmentShader: d.shader.fragmentShader,
        defines: d.shader.defines || {},
      });
      this._applyUniforms(mat, d.shader.uniforms);
    } else {
      mat = this._newMaterialByType(d.type);
    }
    mat.uuid = d.uuid;
    mat.name = d.name || '';
    const p = d.props || {};
    for (const k in p) {
      if (k === 'userData') continue;
      const v = p[k];
      if (COLOR_PROPS.has(k)) { if (mat[k] && mat[k].isColor) mat[k].fromArray(v); }
      else if (VEC2_PROPS.has(k)) { if (mat[k] && mat[k].isVector2) mat[k].fromArray(v); }
      else { try { mat[k] = v; } catch (e) { /* 只读属性忽略 */ } }
    }
    if (p.userData && mat.userData) Object.assign(mat.userData, p.userData);
    // 贴图槽
    for (const k in (d.textures || {})) {
      const t = this.textures.get(d.textures[k]);
      if (t) mat[k] = t;
    }
    if (d.patch) { try { applyPatchDescriptor(mat, d.patch); } catch (e) { /* 补丁失败退原材质 */ } }
    // 高级材质要绑「一次性场景反射贴图」：这是 Worker 自己捕获的纹理，主线程只发一个标记
    if (d.reflect) this.reflectMats.add(mat);
    mat.needsUpdate = true;
    return mat;
  }

  _newMaterialByType(type) {
    switch (type) {
      case 'MeshBasicMaterial': return new THREE.MeshBasicMaterial();
      case 'MeshLambertMaterial': return new THREE.MeshLambertMaterial();
      case 'MeshPhongMaterial': return new THREE.MeshPhongMaterial();
      case 'MeshToonMaterial': return new THREE.MeshToonMaterial();
      case 'MeshNormalMaterial': return new THREE.MeshNormalMaterial();
      case 'MeshMatcapMaterial': return new THREE.MeshMatcapMaterial();
      case 'MeshDepthMaterial': return new THREE.MeshDepthMaterial();
      case 'MeshPhysicalMaterial': return new THREE.MeshPhysicalMaterial();
      case 'MeshStandardMaterial': return new THREE.MeshStandardMaterial();
      case 'PointsMaterial': return new THREE.PointsMaterial();
      case 'SpriteMaterial': return new THREE.SpriteMaterial();
      case 'LineBasicMaterial': return new THREE.LineBasicMaterial();
      case 'LineDashedMaterial': return new THREE.LineDashedMaterial();
      default: return new THREE.MeshStandardMaterial();
    }
  }

  _decodeUniform(u) {
    switch (u.t) {
      case 'color': return new THREE.Color(u.v[0], u.v[1], u.v[2]);
      case 'v2': return new THREE.Vector2(u.v[0], u.v[1]);
      case 'v3': return new THREE.Vector3(u.v[0], u.v[1], u.v[2]);
      case 'v4': return new THREE.Vector4(u.v[0], u.v[1], u.v[2], u.v[3]);
      case 'm3': return new THREE.Matrix3().fromArray(u.v);
      case 'm4': return new THREE.Matrix4().fromArray(u.v);
      case 'arr': return u.v.slice();
      default: return u.v;
    }
  }

  _applyUniforms(mat, uniforms) {
    if (!uniforms) return;
    for (const name in uniforms) {
      const u = uniforms[name];
      // 共享 uniform：取回本线程模块单例里的同一个 uniform 对象（改一处全体生效）
      if (u.t === 'shared') {
        const so = SHARED_UNIFORMS[u.key];
        if (so && mat.uniforms) mat.uniforms[name] = so;
        continue;
      }
      if (u.t === 'tex') {
        const t = this.textures.get(u.id);
        if (t && mat.uniforms) mat.uniforms[name] = { value: t };
        continue;
      }
      const val = this._decodeUniform(u);
      const target = mat.uniforms && mat.uniforms[name];
      if (target) target.value = val; else if (mat.uniforms) mat.uniforms[name] = { value: val };
    }
  }

  /* ---------- 材质 uniform 热更新（不含贴图） ---------- */
  applyMatUniforms(items) {
    if (!items) return;
    for (const it of items) {
      const mat = this.materials.get(it.mat);
      if (!mat || !mat.uniforms) continue;
      for (const name in it.uniforms) {
        const u = it.uniforms[name];
        if (u.t === 'tex') continue;
        const val = this._decodeUniform(u);
        if (mat.uniforms[name]) mat.uniforms[name].value = val;
        else mat.uniforms[name] = { value: val };
      }
    }
  }

  /* ---------- 几何属性热更新（粒子等） ---------- */
  applyAttrs(items) {
    if (!items) return;
    for (const it of items) {
      const obj = this.objects.get(it.uuid);
      const geo = obj && obj.geometry;
      if (!geo) continue;
      for (const name in it.attrs) {
        const d = it.attrs[name];
        if (!d || !d.array) continue;
        const cur = geo.attributes[name];
        if (cur && cur.array && cur.array.length === d.array.length && cur.array.constructor === d.array.constructor) {
          cur.array.set(d.array);
          cur.needsUpdate = true;
        } else {
          geo.setAttribute(name, new THREE.BufferAttribute(d.array, d.itemSize, !!d.normalized));
        }
      }
      if (geo.computeBoundingSphere && geo.boundingSphere) { /* 保留原包围球 */ }
    }
  }

  /* ---------- 可见性 / 透明度热更新（破坏消失、机关淡出等） ---------- */
  applyState(items) {
    if (!items) return;
    for (const it of items) {
      const obj = this.objects.get(it.uuid);
      if (!obj) continue;
      if (it.visible !== undefined) obj.visible = it.visible;
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
      if (it.opacities) {
        for (let i = 0; i < mats.length && i < it.opacities.length; i++) {
          if (mats[i] && typeof it.opacities[i] === 'number') mats[i].opacity = it.opacities[i];
        }
      }
    }
  }

  /* ---------- 贴图内容热更新（图集扩容等，uuid 不变） ---------- */
  applyTex(items) {
    if (!items) return;
    for (const it of items) {
      if (!it || !it.bitmap) continue;
      let tex = this.textures.get(it.uuid);
      if (!tex) { tex = new THREE.Texture(); tex.uuid = it.uuid; this.textures.set(it.uuid, tex); }
      tex.image = it.bitmap;
      const p = it.props || {};
      if (p.colorSpace !== undefined) tex.colorSpace = p.colorSpace;
      if (p.wrapS !== undefined) tex.wrapS = p.wrapS;
      if (p.wrapT !== undefined) tex.wrapT = p.wrapT;
      if (p.magFilter !== undefined) tex.magFilter = p.magFilter;
      if (p.minFilter !== undefined) tex.minFilter = p.minFilter;
      if (p.flipY !== undefined) tex.flipY = p.flipY;
      if (p.generateMipmaps !== undefined) tex.generateMipmaps = p.generateMipmaps;
      if (p.repeat) tex.repeat.fromArray(p.repeat);
      if (p.offset) tex.offset.fromArray(p.offset);
      tex.needsUpdate = true;
    }
  }

  /* ---------- 运行时新增对象 ---------- */
  applyAdd(d) {
    if (!d || !d.nodes) return;
    for (const id in d.textures) if (!this.textures.has(id)) this.textures.set(id, this._buildTexture(d.textures[id]));
    for (const id in d.geometries) if (!this.geometries.has(id)) this.geometries.set(id, this._buildGeometry(d.geometries[id]));
    for (const id in d.materials) if (!this.materials.has(id)) this.materials.set(id, this._buildMaterial(d.materials[id]));
    const parent = this.objects.get(d.parent) || this.scene;
    const skinned = [];
    for (const n of d.nodes) {
      if (this.objects.has(n.uuid)) continue;
      const obj = this._buildObject(n);
      if (!obj) continue;
      this.objects.set(n.uuid, obj);
      if (n.o) this.recs.set(n.uuid, this._rec(n, obj));
      const p = n.parent ? this.objects.get(n.parent) : parent;
      (p || parent).add(obj);
      if (n.kind === KIND.SKINNED) skinned.push(n);
    }
    for (const n of skinned) this._bindSkeleton(n);
    this.cullVersion++;
    if (this.pipeline) this.pipeline.refreshGlassMap();
    this._objectsDirty = true;
  }

  /* ---------- 运行时移除对象 ---------- */
  applyRemove(uuids) {
    if (!uuids) return;
    for (const id of uuids) {
      const obj = this.objects.get(id);
      if (!obj) continue;
      if (obj.parent) obj.parent.remove(obj);
      this.objects.delete(id);
      this.recs.delete(id);
    }
    this.cullVersion++;
    if (this.pipeline) this.pipeline.refreshGlassMap();
    this._objectsDirty = true;
  }

  _applyBackground(root, bg) {
    if (!bg) { root.background = null; return; }
    if (bg.type === 'color') root.background = new THREE.Color(bg.color[0], bg.color[1], bg.color[2]);
    else if (bg.type === 'texture') root.background = this.textures.get(bg.id) || null;
    else root.background = null;
  }

  _applyFog(root, f) {
    if (!f) { root.fog = null; return; }
    const c = new THREE.Color(f.color[0], f.color[1], f.color[2]);
    root.fog = f.type === 'exp2' ? new THREE.FogExp2(c, f.density) : new THREE.Fog(c, f.near, f.far);
  }

  /* ---------- 环境贴图（PMREM 在 Worker 内做） ---------- */
  /** ENV 消息：主线程把等距柱状全景图的位图 copy 过来，这里 PMREM 后挂到场景 environment */
  applyEnv(d) {
    this._envData = d && d.bitmap ? d : null;
    if (this._envPmrem) { try { this._envPmrem.dispose(); } catch (e) { /* ignore */ } this._envPmrem = null; }
    if (this._envData) this._buildEnvPmrem();
    if (this.scene) this._applyEnvTo(this.scene);
  }

  _buildEnvPmrem() {
    const d = this._envData;
    if (!d || !this.renderer) return;
    let tex = null;
    try {
      tex = new THREE.Texture(d.bitmap);
      tex.mapping = d.mapping !== undefined ? d.mapping : THREE.EquirectangularReflectionMapping;
      if (d.colorSpace !== undefined) tex.colorSpace = d.colorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      const pm = new THREE.PMREMGenerator(this.renderer);
      pm.compileEquirectangularShader();
      const rt = pm.fromEquirectangular(tex);
      pm.dispose();
      this._envPmrem = rt.texture;
    } catch (e) {
      console.warn('[mirror] 环境贴图 PMREM 失败', e);
    } finally {
      if (tex) { try { tex.dispose(); } catch (e) { /* ignore */ } }
    }
  }

  _applyEnvTo(root) {
    if (root) root.environment = this._envPmrem || null;
  }

  /* ---------- 热通道 ---------- */
  applyFrame(msg) {
    const cam = msg.camera;
    const c = this.camera;
    if (!c) return;
    if (cam.isPerspective) {
      c.fov = cam.fov; c.near = cam.near; c.far = cam.far; c.zoom = cam.zoom || 1; c.aspect = cam.aspect;
      c.isPerspectiveCamera = true;
    }
    c.matrixWorld.fromArray(cam.matrixWorld);
    c.matrixWorldInverse.fromArray(cam.matrixWorldInverse);
    c.projectionMatrix.fromArray(cam.projectionMatrix);
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
    if (cam.position) c.position.fromArray(cam.position);
    if (cam.quaternion) c.quaternion.fromArray(cam.quaternion);
    c.layers.mask = cam.layers;
    c.updateMatrixWorld();
    // 动态对象矩阵（局部矩阵 → 由 three 在出帧时经父链重算 matrixWorld）
    const { ids, hot } = msg;
    if (ids && hot) {
      for (let i = 0; i < ids.length; i++) {
        const obj = this.objects.get(ids[i]);
        if (!obj) continue;
        const off = i * HOT_STRIDE;
        obj.matrix.fromArray(hot, off);
        obj.matrixAutoUpdate = false;
        obj.matrixWorldNeedsUpdate = true;
      }
    }
    // 共享 uniform
    if (msg.uniforms) {
      if (msg.uniforms.screenGrade) SCREEN_GRADE.mat.value.fromArray(msg.uniforms.screenGrade);
      const s = msg.uniforms.sunSpec;
      if (s) {
        SUN_SPEC.dir.value.fromArray(s.dir);
        SUN_SPEC.color.value.fromArray(s.color);
        SUN_SPEC.strength.value = s.strength;
      }
    }
    ADV_UNIFORMS.time.value = msg.time || 0;
    LIQUID_UNIFORMS.time.value = msg.liquidTime || 0;
    PORTAL_UNIFORMS.time.value = msg.portalTime || 0;
    // 材质 uniform / 几何属性热更新（粒子动画与属性）
    this.applyMatUniforms(msg.matUniforms);
    this.applyAttrs(msg.attrs);
    this.applyState(msg.states);
    this._pendingFrame = msg;
  }

  /* ---------- 出帧 ---------- */
  _start() {
    if (this._running) return;
    this._running = true;
    const tick = () => {
      if (!this._running) return;
      this._raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(tick) : setTimeout(tick, 16);
      this._renderOnce();
    };
    tick();
  }
  stop() { this._running = false; if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf); }

  _renderOnce() {
    if (!this.scene || !this.camera) return;
    const r = this.renderer;
    try {
      if (this.pipeline) this.pipeline.render(this.camera, this._pendingFrame);
      else { r.info.reset(); r.render(this.scene, this.camera); }
    } catch (e) { /* 单帧异常不致命 */ }
    this.lastStats = {
      tris: r.info.render.triangles,
      calls: r.info.render.calls,
      geometries: r.info.memory.geometries,
      textures: r.info.memory.textures,
    };
  }

  disposeScene() {
    if (!this.scene) return;
    for (const tex of this.textures.values()) { try { tex.dispose(); } catch (e) { /* ignore */ } }
    for (const m of this.materials.values()) { try { m.dispose(); } catch (e) { /* ignore */ } }
    for (const g of this.geometries.values()) { try { g.dispose(); } catch (e) { /* ignore */ } }
    this.objects.clear(); this.recs.clear(); this.textures.clear();
    this.materials.clear(); this.geometries.clear(); this.reflectMats.clear();
    this.cullVersion++;
    if (this.scene.uuid !== undefined) { try { this.scene.clear(); } catch (e) { /* ignore */ } }
  }

  dispose() {
    this.stop();
    if (this.pipeline) { try { this.pipeline.dispose(); } catch (e) { /* ignore */ } this.pipeline = null; }
    this.disposeScene();
    if (this._envPmrem) { try { this._envPmrem.dispose(); } catch (e) { /* ignore */ } this._envPmrem = null; }
    this._envData = null;
    if (this.renderer) { try { this.renderer.dispose(); } catch (e) { /* ignore */ } }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }
}
