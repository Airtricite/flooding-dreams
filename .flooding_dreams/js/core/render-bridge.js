/* ============================================================
   渲染桥接（主线程侧）
   ------------------------------------------------------------
   把主线程的 THREE 场景「描述」成可结构化克隆的数据，发给渲染 Worker 重建镜像；
   并每帧只推送「相机 + 被写过的动态对象矩阵 + 少量共享标量」。

   核心约定：
     · 结构通道低频：仅在 markSceneDirty() 后做一次全场景 traverse（禁止每帧 traverse）
     · 热通道每帧：pushTransform(obj) 收集，帧末汇成一个 Float32Array 一次性发送
     · 贴图经 createImageBitmap 复制后 transfer 给 Worker（主线程贴图本体不受影响）
     · uuid 即跨线程 id（three 自带）
   ============================================================ */
import * as THREE from './three-ns.js';
import { MSG, KIND, HOT_STRIDE } from './render-proto.js';
import { SCREEN_GRADE, SUN_SPEC, SHARED_UNIFORM_KEY, LIQUID_UNIFORMS, PORTAL_UNIFORMS } from './shader-uniforms.js';
import { ADV_UNIFORMS, getReflectionTexture } from '../world/advanced-materials.js';

/* ---------- 需要跨线程同步的材质属性（数值 / 布尔 / 颜色 / 向量） ---------- */
const MAT_SCALAR = [
  'color', 'emissive', 'specular', 'shininess', 'metalness', 'roughness',
  'emissiveIntensity', 'envMapIntensity', 'aoMapIntensity', 'lightMapIntensity',
  'bumpScale', 'displacementScale', 'displacementBias', 'normalScale', 'clearcoat',
  'clearcoatRoughness', 'transmission', 'thickness', 'ior', 'reflectivity', 'iridescence',
  'iridescenceIOR', 'sheen', 'sheenRoughness', 'sheenColor', 'attenuationDistance',
  'size', 'sizeAttenuation', 'linewidth', 'opacity', 'alphaTest', 'premultipliedAlpha',
  'pointSize', 'rotation',
];
const MAT_BOOL = [
  'transparent', 'depthTest', 'depthWrite', 'vertexColors', 'flatShading', 'wireframe',
  'fog', 'toneMapped', 'alphaToCoverage', 'dithering', 'visible',
];
const MAT_ENUM = ['side', 'blending', 'shadowSide', 'colorSpace'];
const TEX_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap',
  'lightMap', 'bumpMap', 'displacementMap', 'clearcoatMap', 'clearcoatNormalMap',
  'clearcoatRoughnessMap', 'transmissionMap', 'thicknessMap', 'specularMap', 'gradientMap',
  'envMap', 'sheenColorMap', 'iridescenceMap', 'specularIntensityMap', 'specularColorMap',
];

function isTyped(a) {
  return ArrayBuffer.isView(a) && !(a instanceof DataView);
}
function cloneTyped(a) {
  if (!a) return null;
  if (isTyped(a)) return a.slice();
  if (Array.isArray(a)) return a.slice();
  return a;
}
function vecToArray(v) {
  if (!v) return null;
  if (v.isColor) return [v.r, v.g, v.b];
  if (v.isMatrix3) return v.elements.slice();
  if (v.isVector4) return [v.x, v.y, v.z, v.w];
  if (v.isVector3) return [v.x, v.y, v.z];
  if (v.isVector2) return [v.x, v.y];
  return null;
}

export class RenderBridge {
  /** @param {(msg:object, transfer?:Transferable[])=>void} post */
  constructor(post) {
    this._post = post;
    this._scene = null;
    this._dirty = true;
    this._building = false;
    this._built = false;
    this._hot = new Map();          // uuid -> Object3D（本帧被写过的）
    this._attrHot = new Map();      // uuid -> Object3D（本帧几何属性变化，如粒子）
    this._stateHot = new Map();     // uuid -> Object3D（本帧可见性 / 透明度变化，如破坏、淡出）
    this._uniformMats = new Set();  // 常驻逐帧同步 uniform 的材质（如粒子动画 uTime）
    this._matHot = new Set();       // 一次性同步 uniform 的材质（运行期新建，如泡沫网格）
    this._dynamicRoots = new Set(); // uuid 集合（可选：常驻推送的动态根）
    this._tex = new Map();          // uuid -> Texture（用于复用/更新）
    this._pending = [];             // 快照发出前的增删消息（泡沫网格等在关卡构建期就产生的增量）
    this._sentScene = false;
    this._renderDesc = null;        // 渲染子系统描述（雾对象 / 玻璃 / 泡沫 / 遮挡 / 反射捕获）
    this._renderParams = null;      // () => postfx 参数（画面后处理 / 体积雾系数）
  }

  /** 设置渲染子系统描述（低频）：随结构快照下发；快照已发则单独补发 */
  setRenderDescriptors(desc) {
    this._renderDesc = desc || null;
    if (this._sentScene && this._renderDesc) {
      try { this._post({ t: MSG.RENDER, render: this._renderDesc }); } catch (e) { /* ignore */ }
    }
  }

  /** 设置每帧渲染参数提供器（画面后处理参数等） */
  setRenderParamsProvider(fn) { this._renderParams = fn || null; }

  attachScene(scene) {
    if (this._scene === scene) return;
    this._scene = scene;
    this._dirty = true;
    this._built = false;
    this._sentScene = false;
    this._pending.length = 0;       // 换场景：上一关的增量不再适用
  }

  /** 显式标记场景结构变化（关卡加载 / 编辑器增删 / 材质几何变更） */
  markSceneDirty() { this._dirty = true; }

  /** 把一个对象加入常驻推流（P2：玩家 / 机关 / 粒子等） */
  trackDynamic(obj) { if (obj && obj.uuid) this._dynamicRoots.add(obj); }

  /** 本帧对象位姿被写过 → 收集，帧末统一发送。
   *  recursive=true 时连同子孙一起推送（玩家 / 机关这类带层级的动态根）。 */
  pushTransform(obj, recursive) {
    if (!obj || !obj.uuid) return;
    this._hot.set(obj.uuid, obj);
    if (recursive) obj.traverse((c) => { if (c.uuid) this._hot.set(c.uuid, c); });
  }

  /** 本帧几何属性被写过 → 收集（只发送 needsUpdate 的通道，发送后复位） */
  pushAttrs(obj) { if (obj && obj.uuid && obj.geometry) this._attrHot.set(obj.uuid, obj); }

  /** 本帧可见性 / 透明度被改过 → 收集（破坏消失、机关淡出等） */
  pushState(obj) { if (obj && obj.uuid) this._stateHot.set(obj.uuid, obj); }

  /** 常驻逐帧同步某材质的 uniform（数值 / 向量 / 颜色 / 矩阵；贴图另走 hotTexture） */
  trackMaterial(mat) { if (mat && mat.uuid) this._uniformMats.add(mat); }

  /** 一次性同步某材质的 uniform：运行期新建的材质（泡沫网格等）在帧末发一次即可 */
  hotMaterial(mat) { if (mat && mat.uuid) this._matHot.add(mat); }

  /** 每帧调用：结构脏则先发快照，再发帧数据 */
  flush(view, dt) {
    if (!view || !view.scene || !view.camera) return;
    this.attachScene(view.scene);
    if (this._dirty && !this._building) {
      this._dirty = false;
      this._building = true;
      this._buildSnapshot(view)
        .then((payload) => {
          this._building = false;
          this._built = true;
          this._sentScene = true;
          if (payload) {
            const transfer = payload.__transfer || [];
            delete payload.__transfer;
            try { this._post({ t: MSG.SCENE, ...payload }, transfer); }
            catch (e) { console.error('[bridge] 场景快照发送失败', e); }
          }
          this._flushPending();     // 快照之后补发构建期产生的增删（父节点此时才存在）
          this._sendFrame(view, dt);
        })
        .catch((e) => {
          this._building = false;
          console.error('[bridge] 场景快照构建失败', e);
        });
      return;
    }
    if (this._sentScene) this._sendFrame(view, dt);
  }

  /* ---------- 结构通道：一次性快照 ---------- */
  async _buildSnapshot(view) {
    const scene = view.scene;
    const nodes = [];
    const geometries = {};
    const materials = {};
    const textures = {};
    const texJobs = [];

    const root = scene;
    const walk = (obj, slot) => {
      const node = this._node(obj, slot);
      nodes.push(node);
      const geo = obj.geometry;
      if (geo && !geometries[geo.uuid]) geometries[geo.uuid] = this._geometry(geo);
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
      for (const m of mats) {
        if (m && !materials[m.uuid]) materials[m.uuid] = this._material(m, textures, texJobs);
      }
      for (const c of obj.children) walk(c, slot);
    };
    walk(root, 0);

    // 环境贴图（scene.environment / background）作为独立材质槽发送
    if (scene.environment && !textures[scene.environment.uuid]) {
      textures[scene.environment.uuid] = this._texture(scene.environment, texJobs);
    }

    const payload = {
      root: {
        uuid: root.uuid,
        background: this._background(scene.background, textures, texJobs),
        environment: scene.environment ? scene.environment.uuid : null,
        fog: this._fog(scene.fog),
        scale: root.scale.toArray(),
      },
      nodes, geometries, materials, textures,
      render: this._renderDesc,
      __transfer: [],
    };

    // 贴图位图：异步生成后放进描述符并 transfer（主线程贴图本体不受影响）
    await this._buildBitmaps(texJobs, textures, payload.__transfer);
    return payload;
  }

  /** 遍历一棵子树，产出对象 / 几何 / 材质 / 贴图描述符 + 贴图位图任务 */
  _collectSubtree(root) {
    const nodes = [], geometries = {}, materials = {}, textures = {}, texJobs = [];
    const walk = (obj) => {
      nodes.push(this._node(obj, 0));
      const geo = obj.geometry;
      if (geo && !geometries[geo.uuid]) geometries[geo.uuid] = this._geometry(geo);
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
      for (const m of mats) {
        if (m && !materials[m.uuid]) materials[m.uuid] = this._material(m, textures, texJobs);
      }
      for (const c of obj.children) walk(c);
    };
    walk(root);
    return { nodes, geometries, materials, textures, texJobs };
  }

  /** 异步生成贴图位图并放进描述符（供结构快照 / 动态新增共用） */
  async _buildBitmaps(texJobs, textures, transfer) {
    for (const job of texJobs) {
      try {
        const bmp = await job.make();
        if (bmp && textures[job.uuid]) {
          textures[job.uuid].bitmap = bmp;    // 引用在 transfer 后自动替换为转移后的位图
          textures[job.uuid].source = 'bitmap';
          transfer.push(bmp);
        } else if (textures[job.uuid]) {
          textures[job.uuid].source = 'none';
        }
      } catch (e) { /* 单张贴图失败不影响整体 */ }
    }
  }

  _node(obj, slot) {
    let kind = KIND.GROUP;
    if (obj.isLight) kind = KIND.LIGHT;
    else if (obj.isInstancedMesh) kind = KIND.INSTANCED;
    else if (obj.isSkinnedMesh) kind = KIND.SKINNED;
    else if (obj.isPoints) kind = KIND.POINTS;
    else if (obj.isSprite) kind = KIND.SPRITE;
    else if (obj.isLineSegments) kind = KIND.LINE_SEGMENTS;
    else if (obj.isLineLoop) kind = KIND.LINE_LOOP;
    else if (obj.isLine) kind = KIND.LINE;
    else if (obj.isBone) kind = KIND.BONE;
    else if (obj.isMesh) kind = KIND.MESH;
    obj.updateMatrix();
    const n = {
      uuid: obj.uuid,
      parent: obj.parent ? obj.parent.uuid : null,
      kind, slot,
      name: obj.name || '',
      matrix: obj.matrix.elements.slice(),
      matrixAutoUpdate: obj.matrixAutoUpdate,
      visible: obj.visible,
      renderOrder: obj.renderOrder,
      castShadow: !!obj.castShadow,
      receiveShadow: !!obj.receiveShadow,
      frustumCulled: obj.frustumCulled !== false,
      layers: obj.layers ? obj.layers.mask : 1,
      material: Array.isArray(obj.material) ? obj.material.map((m) => m.uuid)
        : (obj.material ? obj.material.uuid : null),
      geometry: obj.geometry ? obj.geometry.uuid : null,
    };
    // 节点分类元数据（builder 标注）：供 Worker 侧遮挡剔除 / 体积雾 / 泡沫深度复用
    if (obj.userData && obj.userData.__o) {
      n.o = { type: obj.userData.__o.type, shape: obj.userData.__o.shape || null };
    }
    if (kind === KIND.INSTANCED) {
      n.count = obj.count;
      n.instanceMatrix = cloneTyped(obj.instanceMatrix.array);
      if (obj.instanceColor) n.instanceColor = cloneTyped(obj.instanceColor.array);
    }
    if (kind === KIND.LIGHT) {
      n.light = this._light(obj);
    }
    if (kind === KIND.SPRITE) {
      n.center = obj.center ? obj.center.toArray() : null;
    }
    if (kind === KIND.SKINNED) {
      n.bindMode = obj.bindMode;
      n.bindMatrix = obj.bindMatrix ? obj.bindMatrix.elements.slice() : null;
      const sk = obj.skeleton;
      if (sk) {
        n.skeleton = {
          bones: sk.bones.map((b) => b.uuid),
          boneInverses: sk.boneInverses.map((m) => m.elements.slice()),
        };
      }
    }
    return n;
  }

  /* ---------- 灯光：类型 + 通用参数 + 阴影 + 目标点（世界位置） ---------- */
  _light(obj) {
    const d = {
      type: 'ambient',
      color: obj.color ? obj.color.getHex() : 0xffffff,
      intensity: obj.intensity !== undefined ? obj.intensity : 1,
    };
    if (obj.isHemisphereLight) {
      d.type = 'hemisphere';
      d.groundColor = obj.groundColor ? obj.groundColor.getHex() : 0x000000;
    } else if (obj.isDirectionalLight) d.type = 'directional';
    else if (obj.isSpotLight) {
      d.type = 'spot';
      d.distance = obj.distance;
      d.decay = obj.decay;
      d.angle = obj.angle;
      d.penumbra = obj.penumbra;
    } else if (obj.isPointLight) {
      d.type = 'point';
      d.distance = obj.distance;
      d.decay = obj.decay;
    } else if (obj.isRectAreaLight) {
      d.type = 'rectarea';
      d.width = obj.width;
      d.height = obj.height;
    } else if (obj.isAmbientLight) d.type = 'ambient';

    if (d.type === 'directional' || d.type === 'spot') {
      const t = obj.target;
      if (t) {
        t.updateMatrixWorld(true);
        d.target = [t.matrixWorld.elements[12], t.matrixWorld.elements[13], t.matrixWorld.elements[14]];
      } else {
        d.target = [0, 0, 0];
      }
    }

    d.castShadow = !!obj.castShadow;
    if (obj.shadow) {
      const sh = obj.shadow;
      d.shadow = {
        mapSize: sh.mapSize ? [sh.mapSize.x, sh.mapSize.y] : null,
        bias: sh.bias,
        normalBias: sh.normalBias,
        radius: sh.radius,
        camera: null,
      };
      const c = sh.camera;
      if (c) {
        d.shadow.camera = {
          near: c.near, far: c.far,
          left: c.left, right: c.right, top: c.top, bottom: c.bottom,
          fov: c.fov, aspect: c.aspect, zoom: c.zoom,
          isOrthographic: !!c.isOrthographicCamera,
        };
      }
    }
    return d;
  }

  _geometry(geo) {
    const attributes = {};
    for (const name in geo.attributes) {
      const a = geo.attributes[name];
      attributes[name] = { array: cloneTyped(a.array), itemSize: a.itemSize, normalized: a.normalized };
    }
    return {
      uuid: geo.uuid,
      name: geo.name || '',
      attributes,
      index: geo.index ? { array: cloneTyped(geo.index.array) } : null,
      groups: geo.groups ? geo.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })) : [],
      drawRange: { start: geo.drawRange.start, count: geo.drawRange.count },
      morphTargetsRelative: !!geo.morphTargetsRelative,
    };
  }

  _material(mat, textures, texJobs) {
    const d = { uuid: mat.uuid, type: mat.type || 'Material', name: mat.name || '' };
    // ShaderMaterial：直接带源码 + uniforms
    if (mat.isShaderMaterial || mat.isRawShaderMaterial) {
      d.shader = {
        vertexShader: mat.vertexShader || '',
        fragmentShader: mat.fragmentShader || '',
        defines: Object.assign({}, mat.defines),
        uniforms: this._uniforms(mat.uniforms, textures, texJobs),
        raw: !!mat.isRawShaderMaterial,
      };
    }
    const props = {};
    for (const k of MAT_SCALAR) {
      const v = mat[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') props[k] = v;
      else { const arr = vecToArray(v); if (arr) props[k] = arr; }
    }
    for (const k of MAT_BOOL) if (typeof mat[k] === 'boolean') props[k] = mat[k];
    for (const k of MAT_ENUM) if (mat[k] !== undefined) props[k] = mat[k];
    if (mat.userData) props.userData = this._plainUserData(mat.userData);
    d.props = props;
    // 贴图槽
    const tex = {};
    const refl = getReflectionTexture();
    for (const k of TEX_SLOTS) {
      const t = mat[k];
      if (t && t.isTexture) {
        // 反射捕获贴图由 Worker 内自建（PMREM），不按 uuid 发送：打标后由其生成时回填
        if (refl && t === refl) { d.reflect = true; continue; }
        tex[k] = t.uuid;
        if (!textures[t.uuid]) textures[t.uuid] = this._texture(t, texJobs);
      }
    }
    d.textures = tex;
    const patch = this._patch(mat);
    if (patch) d.patch = patch;
    return d;
  }

  _uniforms(uniforms, textures, texJobs) {
    const out = {};
    if (!uniforms) return out;
    for (const name in uniforms) {
      const u = uniforms[name];
      // 共享 uniform：与主线程模块单例同一引用（泡沫深度 / 体积雾 / 调色 / 主光）
      // → 只发 key，Worker 侧取回自己线程里的同名单例，两侧始终共享同一引用。
      const sk = u && typeof u === 'object' ? SHARED_UNIFORM_KEY.get(u) : null;
      if (sk) { out[name] = { t: 'shared', key: sk }; continue; }
      const v = u && u.value;
      if (v === undefined) continue;
      if (v && v.isTexture) {
        out[name] = { t: 'tex', id: v.uuid };
        if (!textures[v.uuid]) textures[v.uuid] = this._texture(v, texJobs);
      } else if (v && v.isColor) out[name] = { t: 'color', v: [v.r, v.g, v.b] };
      else if (v && v.isVector4) out[name] = { t: 'v4', v: [v.x, v.y, v.z, v.w] };
      else if (v && v.isVector3) out[name] = { t: 'v3', v: [v.x, v.y, v.z] };
      else if (v && v.isVector2) out[name] = { t: 'v2', v: [v.x, v.y] };
      else if (v && v.isMatrix3) out[name] = { t: 'm3', v: v.elements.slice() };
      else if (v && v.isMatrix4) out[name] = { t: 'm4', v: v.elements.slice() };
      else if (typeof v === 'number' || typeof v === 'boolean') out[name] = { t: 'n', v };
      else if (Array.isArray(v)) out[name] = { t: 'arr', v: v.slice() };
    }
    return out;
  }

  _texture(tex, texJobs) {
    const d = {
      uuid: tex.uuid,
      name: tex.name || '',
      colorSpace: tex.colorSpace,
      wrapS: tex.wrapS, wrapT: tex.wrapT,
      magFilter: tex.magFilter, minFilter: tex.minFilter,
      anisotropy: tex.anisotropy,
      flipY: tex.flipY,
      generateMipmaps: tex.generateMipmaps,
      premultiplyAlpha: tex.premultiplyAlpha,
      mapping: tex.mapping,
      repeat: tex.repeat ? [tex.repeat.x, tex.repeat.y] : [1, 1],
      offset: tex.offset ? [tex.offset.x, tex.offset.y] : [0, 0],
      center: tex.center ? [tex.center.x, tex.center.y] : [0, 0],
      rotation: tex.rotation || 0,
      source: 'none',
    };
    const img = tex.image;
    if (tex.isDataTexture && img && img.data) {
      d.source = 'data';
      d.data = cloneTyped(img.data);
      d.width = img.width; d.height = img.height;
      d.format = tex.format; d.type = tex.type;
    } else if (img && (img.width || img.naturalWidth)) {
      d.width = img.width || img.naturalWidth;
      d.height = img.height || img.naturalHeight;
      d.source = 'bitmap';
      texJobs.push({
        uuid: tex.uuid,
        make: async () => {
          try {
            if (typeof createImageBitmap !== 'function') return null;
            return await createImageBitmap(img, { colorSpaceConversion: 'none' });
          } catch (e) { return null; }
        },
      });
    }
    return d;
  }

  _background(bg, textures, texJobs) {
    if (!bg) return null;
    if (bg.isColor) return { type: 'color', color: [bg.r, bg.g, bg.b] };
    if (bg.isTexture) {
      if (!textures[bg.uuid]) textures[bg.uuid] = this._texture(bg, texJobs);
      return { type: 'texture', id: bg.uuid };
    }
    return null;
  }

  _fog(fog) {
    if (!fog) return null;
    return {
      type: fog.isFogExp2 ? 'exp2' : 'fog',
      color: [fog.color.r, fog.color.g, fog.color.b],
      near: fog.near, far: fog.far, density: fog.density,
    };
  }

  _patch(mat) {
    const d = {};
    const ud = mat.userData;
    if (ud && ud.advMat) d.adv = ud._advParams || { preset: ud.advMat, scale: 1, amp: 0.8, c1: [1, 1, 1], c2: [0, 0, 0] };
    if (ud && ud.modMat && ud.modMat.elements) d.mod = ud.modMat.elements.slice();
    if (mat._liFlatCapture) d.flat = true;
    if (mat._sunSpec) d.sun = true;
    if (mat._screenGraded) { d.sg = true; d.li = (mat._sgLI && mat._sgLI.value) ?? 1; d.raw = !!mat._sgRaw; }
    return Object.keys(d).length ? d : null;
  }

  _plainUserData(ud) {
    const out = {};
    for (const k in ud) {
      const v = ud[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    }
    return out;
  }

  /* ---------- 热通道：每帧 ---------- */
  _sendFrame(view, dt) {
    const cam = view.camera;
    cam.updateMatrixWorld();
    const camera = {
      matrixWorld: cam.matrixWorld.elements.slice(),
      projectionMatrix: cam.projectionMatrix.elements.slice(),
      matrixWorldInverse: cam.matrixWorldInverse.elements.slice(),
      position: cam.position.toArray(),
      quaternion: cam.quaternion.toArray(),
      fov: cam.fov, near: cam.near, far: cam.far, zoom: cam.zoom,
      aspect: cam.aspect,
      isPerspective: !!cam.isPerspectiveCamera,
      isOrtho: !!cam.isOrthographicCamera,
      left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom,
      layers: cam.layers ? cam.layers.mask : 1,
    };
    // 动态对象矩阵（含常驻动态根）
    const list = [];
    for (const obj of this._hot.values()) if (obj.parent) list.push(obj);
    for (const obj of this._dynamicRoots) if (obj.parent) list.push(obj);
    this._hot.clear();
    const hot = new Float32Array(list.length * HOT_STRIDE);
    let o = 0;
    for (const obj of list) {
      // 发「局部矩阵」而非世界矩阵：镜像侧据此 + 父链重算 matrixWorld，
      // 这样嵌套层级（玩家模型 / 机关）与根节点镜像缩放都能正确还原。
      obj.updateMatrixWorld();
      const e = obj.matrix.elements;
      for (let i = 0; i < 16; i++) hot[o + i] = e[i];
      o += HOT_STRIDE;
    }
    // uuid 无法放进 Float32Array → 用并行数组发送
    const ids = list.map((obj) => obj.uuid);

    const msg = {
      t: MSG.FRAME,
      camera,
      hot,
      ids,
      time: ADV_UNIFORMS && ADV_UNIFORMS.time ? ADV_UNIFORMS.time.value : 0,
      liquidTime: LIQUID_UNIFORMS.time.value,
      portalTime: PORTAL_UNIFORMS.time.value,
      dt: dt || 0,
      uniforms: {
        screenGrade: SCREEN_GRADE.mat.value.elements.slice(),
        sunSpec: {
          dir: SUN_SPEC.dir.value.toArray(),
          color: SUN_SPEC.color.value.toArray(),
          strength: SUN_SPEC.strength.value,
        },
      },
      attrs: this._sendAttrs(),
      states: this._sendStates(),
      matUniforms: this._sendMatUniforms(),
      postfx: this._renderParams ? this._renderParams() : null,
    };
    try { this._post(msg); } catch (e) { console.error('[bridge] 帧发送失败', e); }
  }

  /* ---------- 几何属性热通道：只发 needsUpdate 的通道，发完复位 ---------- */
  _sendAttrs() {
    if (!this._attrHot.size) return null;
    const items = [];
    for (const obj of this._attrHot.values()) {
      const geo = obj.geometry;
      if (!geo) continue;
      const attrs = {};
      let any = false;
      for (const name in geo.attributes) {
        const a = geo.attributes[name];
        if (!a || !a.needsUpdate) continue;
        attrs[name] = { array: cloneTyped(a.array), itemSize: a.itemSize, normalized: !!a.normalized };
        a.needsUpdate = false;   // 进程内模式无渲染器上传，主线程手动复位避免逐帧重发
        any = true;
      }
      if (any) items.push({ uuid: obj.uuid, attrs });
    }
    this._attrHot.clear();
    return items.length ? items : null;
  }

  /* ---------- 对象状态热通道：可见性 / 透明度 ---------- */
  _sendStates() {
    if (!this._stateHot.size) return null;
    const items = [];
    for (const obj of this._stateHot.values()) {
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
      const opacities = mats.map((m) => (typeof m.opacity === 'number' ? m.opacity : 1));
      items.push({ uuid: obj.uuid, visible: obj.visible !== false, opacities });
    }
    this._stateHot.clear();
    return items.length ? items : null;
  }

  /* ---------- 材质 uniform 热通道（不含贴图；贴图走 hotTexture） ---------- */
  _sendMatUniforms() {
    if (!this._uniformMats.size && !this._matHot.size) return null;
    const items = [];
    const seen = new Set();
    const push = (mat) => {
      if (!mat || !mat.uuid || seen.has(mat.uuid) || !mat.uniforms) return;
      seen.add(mat.uuid);
      const out = {};
      for (const name in mat.uniforms) {
        const uo = mat.uniforms[name];
        // 共享 uniform 由 Worker 侧读同名模块单例，无需逐帧发值
        if (uo && typeof uo === 'object' && SHARED_UNIFORM_KEY.has(uo)) continue;
        const v = uo && uo.value;
        const enc = this._uniformValue(v);
        if (enc) out[name] = enc;
      }
      if (Object.keys(out).length) items.push({ mat: mat.uuid, uniforms: out });
    };
    for (const mat of this._uniformMats) push(mat);
    for (const mat of this._matHot) push(mat);
    this._matHot.clear();
    return items.length ? items : null;
  }

  _uniformValue(v) {
    if (v === undefined || v === null) return null;
    if (v.isTexture) return null;                       // 贴图不走这里
    if (v.isColor) return { t: 'color', v: [v.r, v.g, v.b] };
    if (v.isVector4) return { t: 'v4', v: [v.x, v.y, v.z, v.w] };
    if (v.isVector3) return { t: 'v3', v: [v.x, v.y, v.z] };
    if (v.isVector2) return { t: 'v2', v: [v.x, v.y] };
    if (v.isMatrix3) return { t: 'm3', v: v.elements.slice() };
    if (v.isMatrix4) return { t: 'm4', v: v.elements.slice() };
    if (typeof v === 'number' || typeof v === 'boolean') return { t: 'n', v };
    if (Array.isArray(v)) return { t: 'arr', v: v.slice() };
    return null;
  }

  /* ---------- 贴图内容热更新（uuid 不变，就地替换 image） ---------- */
  hotTexture(tex) {
    if (!tex || !tex.uuid) return;
    const img = tex.image;
    if (!img) return;
    const props = {
      colorSpace: tex.colorSpace, wrapS: tex.wrapS, wrapT: tex.wrapT,
      magFilter: tex.magFilter, minFilter: tex.minFilter,
      flipY: tex.flipY, generateMipmaps: tex.generateMipmaps,
      repeat: tex.repeat ? [tex.repeat.x, tex.repeat.y] : null,
      offset: tex.offset ? [tex.offset.x, tex.offset.y] : null,
    };
    const done = (bitmap) => {
      if (!bitmap) return;
      try { this._post({ t: MSG.TEX, items: [{ uuid: tex.uuid, bitmap, props }] }, [bitmap]); }
      catch (e) { /* ignore */ }
    };
    if (typeof createImageBitmap === 'function' && (img.width || img.naturalWidth)) {
      createImageBitmap(img, { colorSpaceConversion: 'none' }).then(done).catch(() => { });
    }
  }

  /* ---------- 运行时新增 / 移除对象（投掷物等） ---------- */
  /** 快照发出前先把增删攒起来：快照尚未到达时父节点在 Worker 侧还不存在 */
  _emit(msg, transfer) {
    if (this._sentScene) { try { this._post(msg, transfer); } catch (e) { /* ignore */ } }
    else this._pending.push([msg, transfer || []]);
  }
  _flushPending() {
    if (!this._pending.length) return;
    const list = this._pending;
    this._pending = [];
    for (const [msg, tr] of list) { try { this._post(msg, tr); } catch (e) { /* ignore */ } }
  }

  async addObject(obj) {
    if (!obj || !obj.uuid || !obj.parent) return;
    const d = this._collectSubtree(obj);
    const transfer = [];
    await this._buildBitmaps(d.texJobs, d.textures, transfer);
    this._emit({
      t: MSG.ADD,
      parent: obj.parent.uuid,
      nodes: d.nodes, geometries: d.geometries, materials: d.materials, textures: d.textures,
    }, transfer);
  }

  removeObject(obj) {
    if (!obj || !obj.uuid) return;
    const uuids = [];
    obj.traverse((c) => { if (c.uuid) uuids.push(c.uuid); });
    this._emit({ t: MSG.REMOVE, uuids });
  }

  clearHot() {
    this._hot.clear();
    this._attrHot.clear();
    this._stateHot.clear();
    this._dynamicRoots.clear();
  }

  dispose() {
    this._hot.clear();
    this._attrHot.clear();
    this._stateHot.clear();
    this._uniformMats.clear();
    this._matHot.clear();
    this._dynamicRoots.clear();
    this._pending.length = 0;
    this._scene = null;
    try { this._post({ t: MSG.DISPOSE }); } catch (e) { /* ignore */ }
  }
}
