/* ============================================================
   玩家形象（morph）
   - 内置程序化预设形象：数据化的 R6 变体（只改横截面 / 整体缩放 / 颜色，
     部件高度与枢轴一律不变），继续复用 Player 的既有程序动画
   - 导入的骨骼模型（.glb / .gltf）：cloneSkinned + AnimationMixer 状态驱动
   - 注意：vendor 里没有 SkeletonUtils，所以骨骼安全克隆是自己实现的
   ============================================================ */
import * as THREE from 'three';
import { PLAYER } from '../config.js';
import { deg2rad } from '../core/util.js';
import { applyScreenGrade } from '../core/materials.js';

/* ============================================================
   内置预设形象
   w / d：躯干横截面（宽 / 深）倍率；scale：整体缩放；部件枢轴保持不变
   ============================================================ */
export const PLAYER_PRESETS = {
  classic: {
    label: '经典 R6', w: 1, d: 1, scale: 1, opacity: 1, emissive: null,
    colors: { torso: '#4f6bd8', head: '#f2bd94', arm: '#ffd98a', leg: '#2f3550' },
  },
  slim: {
    label: '瘦长', w: 0.62, d: 0.8, scale: 1, opacity: 1, emissive: null,
    colors: { torso: '#5f7ae8', head: '#ffe0c2', arm: '#ffe9b0', leg: '#3a4166' },
  },
  bulky: {
    label: '壮硕', w: 1.12, d: 1.25, scale: 1.08, opacity: 1, emissive: null,
    colors: { torso: '#3f57b0', head: '#f0b98d', arm: '#f5cf82', leg: '#262c44' },
  },
  kid: {
    label: '小孩', w: 0.78, d: 0.85, scale: 0.7, opacity: 1, emissive: null,
    colors: { torso: '#7f8ef5', head: '#ffd9bb', arm: '#ffe6ac', leg: '#454d78' },
  },
  ghost: {
    label: '幽灵', w: 0.86, d: 0.7, scale: 1, opacity: 0.5, emissive: '#9fe8ff',
    colors: { torso: '#8fd6ff', head: '#dff6ff', arm: '#bfeaff', leg: '#7fc4ee' },
  },
  neon: {
    label: '霓虹', w: 1, d: 1, scale: 1, opacity: 1, emissive: '#ff5fd0',
    colors: { torso: '#2a1a4a', head: '#3a2560', arm: '#ff4fd0', leg: '#1a1230' },
  },
};

export function presetOptions() {
  return Object.keys(PLAYER_PRESETS).map((v) => ({ v, l: PLAYER_PRESETS[v].label }));
}

export function presetDef(id) {
  return PLAYER_PRESETS[id] || null;
}

/**
 * 按预设数据拼一套 R6 部件。
 * 尺寸/枢轴与 Player._buildModel 完全一致，只把横截面乘上 w / d，
 * 所以 _updateModel 里的摆臂摆腿公式不需要任何改动。
 */
export function buildR6Parts(def, opts = {}) {
  const d = def || PLAYER_PRESETS.classic;
  const w = d.w ?? 1;
  const dep = d.d ?? 1;
  const c = d.colors || {};
  const opacity = d.opacity ?? 1;
  const solid = opacity >= 1;

  const mk = (gw, gh, gd, color, x, y, z) => {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color), roughness: 0.62, metalness: 0.04,
      transparent: !solid, opacity,
    });
    if (d.emissive) mat.emissive = new THREE.Color(d.emissive);
    applyScreenGrade(mat);   // 画面处理：饱和度 / 染色
    const m = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, gd), mat);
    m.position.set(x, y, z);
    m.castShadow = solid;
    m.receiveShadow = true;
    m.userData.avatarOwned = true;
    return m;
  };

  const skin = opts.skin || '#f2bd94';
  const torso = mk(2 * w, 2, 1 * dep, c.torso || '#4f6bd8', 0, 3, 0);
  const head = mk(1 * w, 1, 1 * dep, c.head || skin, 0, 4.5, 0);
  const fz = 0.5 * dep + 0.01;
  // 脸贴在 head 正面：坐标相对 head 中心（head 在 y=4.5），不能直接用 root 坐标
  const face = mk(0.7 * w, 0.28, 0.02, '#2a2338', 0, 0.12, fz);
  face.castShadow = false;
  head.add(face);
  const face2 = mk(0.7 * w, 0.12, 0.02, '#2a2338', 0, -0.24, fz);
  face2.castShadow = false;
  head.add(face2);

  const armL = new THREE.Group(); armL.position.set(-1.5, 4, 0);
  const armR = new THREE.Group(); armR.position.set(1.5, 4, 0);
  armL.add(mk(1 * w, 2, 1 * dep, c.arm || '#ffd98a', 0, -1, 0));
  armR.add(mk(1 * w, 2, 1 * dep, c.arm || '#ffd98a', 0, -1, 0));
  const legL = new THREE.Group(); legL.position.set(-0.5, 2, 0);
  const legR = new THREE.Group(); legR.position.set(0.5, 2, 0);
  legL.add(mk(1 * w, 2, 1 * dep, c.leg || '#2f3550', 0, -1, 0));
  legR.add(mk(1 * w, 2, 1 * dep, c.leg || '#2f3550', 0, -1, 0));

  const root = new THREE.Group();
  root.name = 'r6-preset';
  root.add(torso, head, armL, armR, legL, legR);
  const s = d.scale ?? 1;
  if (s !== 1) root.scale.setScalar(s);     // 整体缩放（脚底仍在 y=0，不会悬空）
  return { root, torso, head, armL, armR, legL, legR, parts: [torso, head, armL, armR, legL, legR] };
}

/* ============================================================
   骨骼安全克隆
   three 的 SkinnedMesh.copy() 是 this.skeleton = source.skeleton（共享骨架），
   直接 clone(true) 出来的克隆体骨骼不会跟着自己的动画动。
   这里按官方 SkeletonUtils.clone 的算法重绑骨架。
   ============================================================ */
function parallelTraverse(a, b, cb) {
  cb(a, b);
  for (let i = 0; i < a.children.length; i++) parallelTraverse(a.children[i], b.children[i], cb);
}

export function cloneSkinned(src) {
  const srcLookup = new Map();
  const dstLookup = new Map();
  const clone = src.clone(true);
  parallelTraverse(src, clone, (s, d) => { srcLookup.set(d, s); dstLookup.set(s, d); });
  clone.traverse((node) => {
    if (!node.isSkinnedMesh) return;
    const srcMesh = srcLookup.get(node);
    if (!srcMesh) return;
    node.skeleton = srcMesh.skeleton.clone();
    node.bindMatrix.copy(srcMesh.bindMatrix);
    node.skeleton.bones = srcMesh.skeleton.bones.map((b) => dstLookup.get(b) || b);
    node.bind(node.skeleton, node.bindMatrix);
  });
  return clone;
}

/* ============================================================
   角色模型模板（每个 assetId 只解析一次，实例每次 cloneSkinned）
   刻意不复用 builder.js 的 fetchModel：那是单实例缓存，
   玩家与场景里同 assetId 的模型对象会抢同一个 Object3D。
   ============================================================ */
const _tplCache = new Map();

function disposeObject(root) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x && x.dispose());
    else if (m) m.dispose();
  });
}

function disposeTemplate(tpl) {
  if (!tpl || tpl.dead) return;
  tpl.dead = true;
  if (tpl.refs > 0) return;     // 还有实例在用，等最后一个实例释放
  disposeObject(tpl.root);
}

function maybeDisposeTemplate(tpl) {
  if (tpl && tpl.dead && tpl.refs <= 0) disposeObject(tpl.root);
}

/** 清空模板缓存（导入新模型 / 素材变更后调用）。有实例在用时延迟释放。 */
export function clearAvatarCache(assetId) {
  if (assetId) {
    const t = _tplCache.get(assetId);
    _tplCache.delete(assetId);
    if (t) t.then(disposeTemplate).catch(() => {});
    return;
  }
  for (const t of _tplCache.values()) t.then(disposeTemplate).catch(() => {});
  _tplCache.clear();
}

/**
 * 解析角色模型资产。
 * 返回 { root, clips, height, status, refs, dead, assetId }
 * - root：已水平居中、脚底对齐 y=0、缩放为 1 的模板
 * - height：模板原始高度（实例用它算自动适配缩放）
 * - status：ok / missing / error
 */
export async function loadAvatarTemplate(assetId) {
  if (!assetId) return { root: null, clips: [], height: 1, status: 'missing', refs: 0, dead: false, assetId: '' };
  if (_tplCache.has(assetId)) return _tplCache.get(assetId);
  const p = (async () => {
    const tpl = { root: null, clips: [], height: 1, status: 'error', refs: 0, dead: false, assetId };
    try {
      const { resolveAssetURL } = await import('../core/settings.js');
      const url = await resolveAssetURL(assetId);
      if (!url) { tpl.status = 'missing'; return tpl; }
      let name = '';
      try {
        const { store } = await import('../core/storage.js');
        const rec = await store.getAsset(assetId);
        name = (rec && rec.name) || '';
      } catch (e) { /* ignore */ }
      const ext = (name.split('.').pop() || '').toLowerCase();
      let obj = null;
      let clips = [];
      if (ext === 'obj') {
        const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
        obj = await new OBJLoader().loadAsync(url);
      } else {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const gltf = await new GLTFLoader().loadAsync(url);
        obj = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        clips = (gltf.animations || []).slice();
      }
      if (!obj) { tpl.status = 'error'; return tpl; }

      obj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      // 按高度适配：T-pose 手臂张开会把 x 撑得很宽，用高度才稳
      let h = size.y;
      if (!(h > 1e-4)) h = Math.max(size.x, size.z, 1e-4);
      obj.position.set(-center.x, -box.min.y, -center.z);
      obj.traverse((c) => {
        if (!c.isMesh) return;
        c.castShadow = true;
        c.receiveShadow = true;
        if (c.geometry && !c.geometry.attributes.uv) {
          c.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(c.geometry.attributes.position.count * 2), 2));
        }
      });
      tpl.root = obj;
      tpl.clips = clips;
      tpl.height = h;
      tpl.status = 'ok';
      return tpl;
    } catch (e) {
      console.warn('[avatar] 角色模型加载失败', assetId, e);
      tpl.status = 'error';
      return tpl;
    }
  })();
  _tplCache.set(assetId, p);
  return p;
}

/* ============================================================
   clip 名模糊匹配
   ============================================================ */
const CLIP_ALIASES = {
  Idle:  ['idle', 'stand', 'breathing', 'breath', 'wait'],
  Walk:  ['walking', 'walk', 'wander'],
  Run:   ['running', 'run', 'sprint', 'jog'],
  Jump:  ['jumpup', 'jump', 'leap'],
  Fall:  ['falling', 'fall', 'airdown', 'drop'],
  Swim:  ['swimming', 'swim', 'float', 'tread'],
  Climb: ['climbing', 'climb', 'ladder', 'wallhang', 'hang', 'zip'],
  Slide: ['sliding', 'slide', 'roll', 'dash'],
  Die:   ['die', 'death', 'dying', 'dead'],
};

/** 归一化：取最后一个 '|' 之后（兼容 Blender Armature|Walk / Mixamo 前缀），再去掉非字母数字 */
function normalizeClipName(n) {
  let s = String(n || '');
  const i = s.lastIndexOf('|');
  if (i >= 0) s = s.slice(i + 1);
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function matchClips(clips) {
  const out = {};
  const list = (clips || []).map((c) => ({ c, n: normalizeClipName(c.name) }));
  for (const key of Object.keys(CLIP_ALIASES)) {
    const aliases = CLIP_ALIASES[key].map(normalizeClipName);
    let hit = list.find((x) => aliases.includes(x.n));
    if (!hit) hit = list.find((x) => aliases.some((a) => a.length >= 3 && x.n.includes(a)));
    if (!hit) hit = list.find((x) => x.n.length >= 3 && aliases.some((a) => a.includes(x.n)));
    if (hit) out[key] = hit.c;
  }
  if (!out.Idle && list.length) out.Idle = list[0].c;   // 兜底：第一段当待机
  return out;
}

/* ============================================================
   实例
   ============================================================ */
function cloneOwnMaterial(m) {
  if (Array.isArray(m)) return m.map(cloneOwnMaterial);
  if (!m) return m;
  const c = m.clone();
  c.userData.avatarOwned = true;
  return c;
}

function disposeOwnMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => { if (x && x.userData && x.userData.avatarOwned) x.dispose(); });
    else if (m && m.userData && m.userData.avatarOwned) m.dispose();
  });
}

const AIR_HOLD = 0.08;      // Jump / Fall 之间最小保持时间，避免落地前抖动

export class PlayerAvatar {
  constructor(parent, opts = {}) {
    this.targetHeight = opts.targetHeight || PLAYER.totalH || 5;

    /* root 由 Player 每帧写 position / rotation（与 R6 层同源）
       fit 负责朝向偏移 / 垂直偏移，holder 负责自动适配缩放 —— 三者互不干扰 */
    this.root = new THREE.Group();
    this.root.name = 'avatar';
    this.fit = new THREE.Group();
    this.holder = new THREE.Group();
    this.fit.add(this.holder);
    this.root.add(this.fit);
    if (parent) parent.add(this.root);

    this.mode = 'none';       // none / model
    this.status = 'none';     // none / loading / ok / noanim / missing / error
    this.current = '';
    this.clipMap = {};
    this.mixer = null;
    this.model = null;
    this._action = null;
    this._tpl = null;
    this._token = 0;
    this._gear = 0;           // 速度档位（滞回用）
    this._hold = 0;
  }

  /** 是否正在展示导入模型（静态模型 noanim 也算，否则 .obj 会看不见） */
  get active() { return this.mode === 'model' && (this.status === 'ok' || this.status === 'noanim'); }

  /** 切到导入模型；加载期间保持原形象可见，由 token 丢弃过期请求 */
  async apply(cfg) {
    this.restore();                       // 先卸旧的（内部 ++_token 会作废在途请求）
    const token = ++this._token;
    this.mode = 'model';
    this.status = 'loading';
    const assetId = (cfg && cfg.assetId) || '';
    if (!assetId) { this.mode = 'none'; this.status = 'missing'; return false; }

    let tpl = null;
    try { tpl = await loadAvatarTemplate(assetId); } catch (e) { tpl = null; }
    if (token !== this._token) return false;              // 被更晚的 morph 抢占
    if (!tpl || tpl.status !== 'ok' || !tpl.root) {
      this.mode = 'none';
      this.status = (tpl && tpl.status) || 'error';
      return false;
    }

    this._tpl = tpl;
    tpl.refs++;

    const inst = cloneSkinned(tpl.root);
    inst.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;               // 蒙皮包围球是 bind pose 的，不关会被误剔除
      o.userData.sharedGeometry = true;      // 几何归模板，实例不释放
      o.material = cloneOwnMaterial(o.material);
    });
    this.holder.add(inst);
    this.model = inst;

    const userScale = Number(cfg && cfg.scale);
    const s = (isFinite(userScale) && userScale > 0 ? userScale : 1) * (this.targetHeight / (tpl.height || 1));
    this.holder.scale.setScalar(s);
    this.fit.rotation.y = deg2rad(Number(cfg && cfg.yawOffset) || 0);
    this.fit.position.y = Number(cfg && cfg.yOffset) || 0;

    this.mixer = new THREE.AnimationMixer(inst);
    this.clipMap = matchClips(tpl.clips);
    this.current = '';
    this._action = null;
    this._gear = 0;
    this._hold = 0;
    this.status = tpl.clips.length ? 'ok' : 'noanim';

    /* 该模型在「角色皮肤编辑器」里存过的皮肤（涂画 + 挂件）自动套上。
       动态 import：避免 avatar → skin-editor → avatar 的静态循环依赖。 */
    try {
      const { applySavedSkin } = await import('../ui/skin-editor.js');
      if (token === this._token) {
        const skin = await applySavedSkin(inst, assetId);
        if (skin && token === this._token) inst.userData.skin = skin;
        else if (skin) skin.dispose();
      }
    } catch (e) { console.warn('[avatar] 皮肤套用失败', e); }
    return true;
  }

  /** 卸掉导入模型，回到「无形象层」 */
  restore() {
    this._token++;
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot());
      this.mixer = null;
    }
    if (this.model) {
      // 皮肤持有画布贴图 / 挂件几何，先释放再丢模型
      const skin = this.model.userData && this.model.userData.skin;
      if (skin && typeof skin.dispose === 'function') {
        try { skin.dispose(); } catch (e) { /* ignore */ }
        this.model.userData.skin = null;
      }
      if (this.model.parent) this.model.parent.remove(this.model);
      disposeOwnMaterials(this.model);
      this.model = null;
    }
    if (this._tpl) {
      this._tpl.refs = Math.max(0, this._tpl.refs - 1);
      maybeDisposeTemplate(this._tpl);
      this._tpl = null;
    }
    this.clipMap = {};
    this.current = '';
    this._action = null;
    this.mode = 'none';
    this.status = 'none';
    this.holder.scale.setScalar(1);
    this.fit.rotation.y = 0;
    this.fit.position.y = 0;
  }

  /** 每帧：只驱动 mixer + 切 clip，不写 root 的 position / rotation */
  update(dt, st) {
    if (!this.mixer) return;
    this.mixer.update(dt);
    this._hold = Math.max(0, this._hold - dt);
    const want = this._choose(st);
    const name = this._resolve(want.names);
    if (!name || name === this.current) return;
    const airPair = (name === 'Jump' || name === 'Fall') && (this.current === 'Jump' || this.current === 'Fall');
    if (airPair && this._hold > 0) return;
    this._play(name, want.fade);
    if (airPair) this._hold = AIR_HOLD;
  }

  dispose() {
    this.restore();
    if (this.root.parent) this.root.parent.remove(this.root);
  }

  /* ---------- 内部 ---------- */
  _resolve(names) {
    for (const n of names) if (this.clipMap[n]) return n;
    return '';
  }

  /** 玩家状态 → 目标 clip 候选列表（按序取第一个存在的）+ 交叉淡入时长 */
  _choose(st) {
    const s = st || {};
    const speed = Number(s.speed) || 0;
    const vy = Number(s.vy) || 0;
    const grounded = !!s.grounded;

    // 速度档位滞回，避免跑动时 Run / Walk 来回闪
    if (this._gear >= 2) { if (speed < 9) this._gear = speed > 0.4 ? 1 : 0; }
    else if (this._gear === 1) { if (speed > 12) this._gear = 2; else if (speed < 0.4) this._gear = 0; }
    else if (speed > 12) this._gear = 2;
    else if (speed > 0.8) this._gear = 1;

    if (!s.alive) return { names: ['Die', 'Fall', 'Idle'], fade: 0.12 };
    if (s.onZipline) return { names: ['Climb', 'Hang', 'Idle'], fade: 0.2 };
    if (s.state === 'climb') return { names: ['Climb', 'Idle'], fade: 0.18 };
    if (s.state === 'walljump') return { names: ['Climb', 'Hang', 'Jump'], fade: 0.15 };
    if (s.state === 'swim' || (s.inLiquid && s.swim)) return { names: ['Swim', 'Float', 'Idle'], fade: 0.25 };
    if (s.state === 'slide') return { names: ['Slide', 'Roll', 'Run'], fade: 0.14 };
    if (!grounded && vy > 1.5) return { names: ['Jump', 'Fall'], fade: 0.1 };
    if (!grounded && vy < -1.5) return { names: ['Fall', 'Jump'], fade: 0.14 };
    if (grounded && this._gear >= 2) return { names: ['Run', 'Walk'], fade: 0.18 };
    if (grounded && this._gear >= 1) return { names: ['Walk', 'Run'], fade: 0.18 };
    return { names: ['Idle', 'Walk'], fade: 0.22 };
  }

  /** 顺序不能错：reset → setLoop → crossFadeFrom(prev) → play */
  _play(name, fade) {
    const clip = this.clipMap[name];
    if (!clip || !this.mixer) return false;
    const next = this.mixer.clipAction(clip);
    if (next === this._action) { this.current = name; return true; }
    next.reset();
    next.setLoop(name === 'Die' ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = (name === 'Die');
    next.setEffectiveWeight(1);
    next.enabled = true;
    if (this._action && this._action.isRunning()) next.crossFadeFrom(this._action, fade, false);
    next.play();
    this._action = next;
    this.current = name;
    return true;
  }
}
