/* ============================================================
   角色皮肤编辑器（独立窗口）
   ------------------------------------------------------------
   · 选中 / 导入 .glb / .gltf / .obj 模型资产，3D 预览（轨道相机）
   · 涂画皮肤：复用 PaintManager 的笔触引擎 —— 每个材质一张画布贴图，
     画布直接挂到材质 map 上，笔触 uv 与模型 uv 一一对应
   · 挂件：内置基础几何 / 其它模型资产，挂到身体部位（优先骨骼，无骨骼按包围盒）
   · 结果按「模型资产 id」存进 store.kv，游玩时 morph 到该模型会自动套用
   ============================================================ */
import * as THREE from 'three';
import { $, el, clear, toast, confirmBox } from './dom.js';
import { GridSelect, streamAssetOptions } from './grid-picker.js';
import { PaintManager } from '../world/paint.js';
import { setPaintResolver } from '../core/materials.js';
import { store } from '../core/storage.js';
import { clamp, uid, deepClone, deg2rad, saveBlob, pickFile, readFileText } from '../core/util.js';
import { assetBlob, blobToDataURL } from '../core/level-assets.js';
import { cloneSkinned, loadAvatarTemplate, matchClips, clearAvatarCache } from '../player/avatar.js';

export const SKIN_SIZE = 1024;
const SKIN_PREFIX = 'skin:';

const DEFAULT_LAYERS = [{ id: 'skin', name: '皮肤', visible: true, opacity: 1, blendMode: 'normal' }];

/** 身体锚点 */
export const ANCHOR_DEFS = [
  { v: 'root', l: '整体' },
  { v: 'head', l: '头部' },
  { v: 'torso', l: '躯干' },
  { v: 'back', l: '背部' },
  { v: 'handL', l: '左手' },
  { v: 'handR', l: '右手' },
  { v: 'feet', l: '脚部' },
];
const BONE_PATTERNS = {
  head: /head|neck/i,
  torso: /spine|chest|torso|hips|pelvis/i,
  back: /spine|chest|torso/i,
  handL: /(hand|wrist).*(_?l\b|left)|(_?l\b|left).*(hand|wrist)/i,
  handR: /(hand|wrist).*(_?r\b|right)|(_?r\b|right).*(hand|wrist)/i,
  feet: /foot|ankle|toe/i,
};

export const SHAPES = [
  { v: 'box', l: '立方体' },
  { v: 'sphere', l: '球体' },
  { v: 'cylinder', l: '圆柱' },
  { v: 'cone', l: '圆锥' },
  { v: 'torus', l: '圆环' },
  { v: 'capsule', l: '胶囊' },
  { v: 'model', l: '模型素材' },
];

/* ============================================================
   存档（挂在模型素材上，跟着素材走）
   ============================================================ */
export async function loadSkin(assetId) {
  if (!assetId) return null;
  try {
    const rec = await store.getAssetMeta(assetId);
    if (rec && rec.skin) return rec.skin;
  } catch (e) { /* 往下找旧存档 */ }
  // 兼容早期版本：那时把皮肤存在全局 kv 里
  try { return await store.kvGet(SKIN_PREFIX + assetId, null); } catch (e) { return null; }
}
export async function saveSkin(assetId, cfg) {
  if (!assetId) return false;
  try {
    const rec = await store.setAssetSkin(assetId, cfg);
    if (!rec) return false;
    // 清掉旧版本的 kv 副本，避免以后读到过期数据
    try { await store.del('kv', SKIN_PREFIX + assetId); } catch (e) { /* ignore */ }
    return true;
  } catch (e) { return false; }
}
export async function deleteSkin(assetId) {
  if (!assetId) return;
  try { await store.setAssetSkin(assetId, null); } catch (e) { /* ignore */ }
  try { await store.del('kv', SKIN_PREFIX + assetId); } catch (e) { /* ignore */ }
}

/* ============================================================
   角色包 .fdchar
   ------------------------------------------------------------
   一个 JSON 文件装下「模型 + 皮肤 + 挂件模型」，字节全部 base64 内嵌：
   换台机器、丢进别的关卡、塞进关卡包，都不会缺素材。
   ============================================================ */
export const CHAR_KIND = 'flooding-dreams-char';
export const CHAR_VER = 1;

/** 把模型素材 + 皮肤 + 挂件模型打成一个自包含的角色包对象 */
export async function exportCharacter(assetId) {
  if (!assetId) return null;
  const rec = await store.getAsset(assetId);
  if (!rec || !rec.data) return null;
  const skin = await loadSkin(assetId);
  const modelName = rec.name || 'character.glb';
  const bundle = {
    kind: CHAR_KIND,
    v: CHAR_VER,
    date: Date.now(),
    name: modelName.replace(/\.[^.]*$/, '') || 'character',
    model: { name: modelName, mime: rec.mime || '', data: await blobToDataURL(await assetBlob(rec)) },
    skin: skin ? deepClone(skin) : null,
    accModels: [],
  };
  // 挂件用到的模型素材一并内嵌，别人拿到这个文件就能完整还原角色
  const seen = new Set();
  for (const acc of ((bundle.skin && bundle.skin.accessories) || [])) {
    if (!acc || acc.shape !== 'model' || !acc.assetId || seen.has(acc.assetId)) continue;
    seen.add(acc.assetId);
    try {
      const a = await store.getAsset(acc.assetId);
      if (!a || !a.data) continue;
      bundle.accModels.push({
        id: acc.assetId, name: a.name || '', mime: a.mime || '',
        data: await blobToDataURL(await assetBlob(a)),
      });
    } catch (e) { console.warn('[skin] 角色包内嵌挂件模型失败', acc.assetId, e); }
  }
  return bundle;
}

/** 校验一个角色包（文本或对象），返回 { bundle } 或 { error } */
export function readCharacterBundle(text) {
  let b = null;
  try { b = (typeof text === 'string') ? JSON.parse(text) : text; } catch (e) { /* 下面统一报错 */ }
  if (!b || typeof b !== 'object') return { error: '文件不是有效的角色包' };
  if (b.kind !== CHAR_KIND) return { error: '不是角色包文件（.fdchar）' };
  if (!b.model || !b.model.data) return { error: '角色包里没有模型数据' };
  if (Number(b.v) > CHAR_VER) return { error: '角色包版本过新，请升级游戏后再导入' };
  return { bundle: b };
}

/**
 * 导入角色包：模型 / 挂件模型落成新素材，皮肤挂到新模型素材上。
 * @returns {Promise<{rec?:object, skin?:object, error?:string}>}
 */
export async function importCharacter(text) {
  const r = readCharacterBundle(text);
  if (r.error) return r;
  const b = r.bundle;
  const mime = b.model.mime || '';
  const modelName = b.model.name || 'character.glb';
  const blob = await (await fetch(b.model.data)).blob();
  const rec = await store.saveAsset(new File([blob], modelName, { type: mime || blob.type }), 'model', {
    levelId: null, name: modelName,
  });
  if (!rec) return { error: '模型写入失败' };
  // 挂件模型逐个还原成素材，再把皮肤里的引用改成新 id
  const map = new Map();
  for (const a of (b.accModels || [])) {
    try {
      const ab = await (await fetch(a.data)).blob();
      const an = a.name || 'accessory.glb';
      const ar = await store.saveAsset(new File([ab], an, { type: a.mime || ab.type }), 'model', {
        levelId: null, name: an,
      });
      if (ar && a.id) map.set(a.id, ar.id);
    } catch (e) { console.warn('[skin] 角色包挂件还原失败', a && a.id, e); }
  }
  const skin = b.skin ? deepClone(b.skin) : null;
  if (skin) {
    skin.assetId = rec.id;
    for (const acc of (skin.accessories || [])) {
      if (acc && acc.shape === 'model' && acc.assetId && map.has(acc.assetId)) acc.assetId = map.get(acc.assetId);
    }
    await saveSkin(rec.id, skin);
  }
  clearAvatarCache();
  return { rec, skin };
}

/* ============================================================
   涂画：复用 PaintManager，只换掉「底色填充」这一步
   ============================================================ */
class SkinPaint extends PaintManager {
  constructor(level, opts = {}) {
    // 构造期先别画：baseImgs 还没挂上（super 里就会 composite）
    const strokes = level.paints;
    level.paints = [];
    super(level, { size: opts.size || SKIN_SIZE });
    this.baseImgs = opts.baseImgs || new Map();
    // 皮肤不吃全局 paint 解析器：把构造时被换掉的那个立刻还回去，
    // 否则游玩时关卡里已涂鸦的方块会解析不到画布贴图（涂鸦消失）
    setPaintResolver(this._prevResolver || null);
    level.paints = strokes;
    this.rebuildAll();
  }

  /** 底色 = 模型原贴图（上下翻一次对齐 glTF 的 uv）× 底色乘算；无贴图则纯底色 */
  _fillBase(ctx, obj, size) {
    const key = obj && obj.id;
    const img = (key && this.baseImgs) ? this.baseImgs.get(key) : null;
    const color = (obj && obj.color) || '#ffffff';
    if (img) {
      ctx.save();
      ctx.translate(0, size);
      ctx.scale(1, -1);
      try { ctx.drawImage(img, 0, 0, size, size); } catch (e) { /* ignore */ }
      ctx.restore();
      if (color && color !== '#ffffff') {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, size, size);
        ctx.restore();
      }
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, size, size);
    }
  }
}

/* ============================================================
   通用小件
   ============================================================ */
function cloneSkinMaterial(m) {
  if (Array.isArray(m)) return m.map(cloneSkinMaterial);
  if (!m) return m;
  const c = m.clone();
  c.userData = Object.assign({}, c.userData, { skinOwned: true });
  return c;
}

/**
 * 收集「可涂画」的网格，顺序即材质键 m0 / m1 / …
 *
 * 编辑器与游戏内套用（applySkinToModel）必须走同一个函数、同一套顺序，
 * 存档里的键才能对得上。空 Group（锚点）不含网格，不会打乱序号。
 * 没有 uv 的网格补一份全 0 uv：既能渲染，也让两侧的网格集合一致。
 */
function collectPaintMeshes(root) {
  const list = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
    const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
    if (!pos) return;
    if (!o.geometry.attributes.uv) {
      o.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
    }
    list.push(o);
  });
  return list;
}

function makeGeometry(shape) {
  switch (shape) {
    case 'sphere': return new THREE.SphereGeometry(0.5, 20, 14);
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1);
    case 'cone': return new THREE.ConeGeometry(0.5, 1, 20, 1);
    case 'torus': return new THREE.TorusGeometry(0.4, 0.16, 12, 24);
    case 'capsule':
      return (THREE.CapsuleGeometry)
        ? new THREE.CapsuleGeometry(0.35, 0.6, 6, 14)
        : new THREE.CylinderGeometry(0.4, 0.4, 1, 16);
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

/** 找出身体各锚点：优先骨骼名，找不到就按包围盒在 root 局部空间摆空组 */
export function buildAnchors(root) {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  const worldPts = {
    head: new THREE.Vector3(ctr.x, box.min.y + size.y * 0.92, ctr.z),
    torso: new THREE.Vector3(ctr.x, box.min.y + size.y * 0.55, ctr.z),
    back: new THREE.Vector3(ctr.x, box.min.y + size.y * 0.55, ctr.z - size.z * 0.5),
    handL: new THREE.Vector3(ctr.x - size.x * 0.45, box.min.y + size.y * 0.5, ctr.z),
    handR: new THREE.Vector3(ctr.x + size.x * 0.45, box.min.y + size.y * 0.5, ctr.z),
    feet: new THREE.Vector3(ctr.x, box.min.y + size.y * 0.06, ctr.z),
  };
  const findBone = (re) => {
    let hit = null;
    root.traverse((o) => { if (!hit && o.isBone && re.test(o.name || '')) hit = o; });
    return hit;
  };
  const anchors = new Map();
  // 真实骨骼全部登记成 bone:<名字>：挂件可以精确挂到任意一块骨头上，跟着骨骼动
  root.traverse((o) => {
    if (o.isBone && o.name) anchors.set('bone:' + o.name, o);
  });
  for (const def of ANCHOR_DEFS) {
    if (def.v === 'root') { anchors.set('root', root); continue; }
    const re = BONE_PATTERNS[def.v];
    const bone = re ? findBone(re) : null;
    if (bone) { anchors.set(def.v, bone); continue; }
    const g = new THREE.Group();
    g.name = 'anchor-' + def.v;
    g.position.copy(root.worldToLocal((worldPts[def.v] || ctr).clone()));
    root.add(g);
    anchors.set(def.v, g);
  }
  return anchors;
}

/** 模型自带的骨骼名列表（给挂件锚点下拉用；无骨骼返回空数组） */
export function listBones(root) {
  const out = [];
  if (!root) return out;
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isBone || !o.name || seen.has(o.name)) return;
    seen.add(o.name);
    out.push({ v: 'bone:' + o.name, l: '骨骼 · ' + o.name });
  });
  return out;
}

/** 解析锚点名 → 实际节点。bone:<名字> 精确命中，找不到时退回语义锚点 / 根节点 */
function resolveAnchor(root, anchors, name) {
  const k = String(name || '');
  return (anchors && anchors.get(k)) || (anchors && anchors.get('root')) || root;
}

/** 造一件挂件（几何 / 模型），返回 { group, owned, model, modelH, tpl } */
async function buildAccessory(acc) {
  const group = new THREE.Group();
  group.name = 'acc-' + acc.id;
  group.userData.skinAcc = true;
  group.position.fromArray(acc.pos || [0, 0, 0]);
  const r = acc.rot || [0, 0, 0];
  group.rotation.set(deg2rad(r[0] || 0), deg2rad(r[1] || 0), deg2rad(r[2] || 0));
  group.scale.setScalar(acc.scale ?? 1);
  const size = acc.size || [0.6, 0.6, 0.6];
  const owned = [];
  let mesh = null;
  let model = null;
  let modelH = 1;
  let tpl = null;

  /* 模型挂件：走素材池（模板缓存 + 骨骼安全克隆），几何是共享的，不能释放 */
  let src = null;
  if (acc.shape === 'model' && acc.assetId) {
    const t = await loadAvatarTemplate(acc.assetId);
    if (t && t.status === 'ok' && t.root) {
      t.refs++;
      tpl = t;
      src = { root: cloneSkinned(t.root) };
    }
  }

  if (src && src.root) {
    const inst = src.root;
    inst.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false; o.frustumCulled = false;
      o.userData.sharedGeometry = true;
      o.material = cloneSkinMaterial(o.material);
      owned.push(o.material);
    });
    inst.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(inst);
    modelH = Math.max(b.getSize(new THREE.Vector3()).y, 1e-3);
    inst.scale.setScalar((size[1] || 0.6) / modelH);
    group.add(inst);
    model = inst;
  } else {
    // 几何挂件；形状填的是 model 但模型缺失时退回立方体，至少看得见、能删
    const geo = makeGeometry(acc.shape === 'model' ? 'box' : acc.shape);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(acc.color || '#ff5c8a'), roughness: 0.5, metalness: 0.05,
    });
    mat.userData.skinOwned = true;
    mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(size[0] || 0.6, size[1] || 0.6, size[2] || 0.6);
    mesh.castShadow = false;
    mesh.userData.skinAcc = true;
    group.add(mesh);
    owned.push(geo, mat);
  }
  return { group, owned, mesh, model, modelH, tpl };
}

function disposeBuilt(b) {
  if (!b) return;
  if (b.group && b.group.parent) b.group.parent.remove(b.group);
  for (const x of b.owned || []) { try { if (x && x.dispose) x.dispose(); } catch (e) { /* ignore */ } }
  if (b.tpl) b.tpl.refs = Math.max(0, b.tpl.refs - 1);
}

/* ============================================================
   把一份皮肤配置套到已建好的模型实例上（游玩时玩家 morph 用）
   返回 { paint, dispose } 或 null
   ============================================================ */
export async function applySkinToModel(root, cfg) {
  if (!root || !cfg) return null;
  root.updateWorldMatrix(true, true);

  // 与编辑器同一个收集函数、同一套顺序 → 存档里的 m0/m1… 才对得上
  const meshes = collectPaintMeshes(root);
  if (!meshes.length) return null;
  const keyMeshes = new Map();
  meshes.forEach((mesh, i) => {
    keyMeshes.set('m' + i, mesh);
    mesh.userData.skinPaintable = true;
  });

  const baseColors = cfg.baseColors || {};
  const baseImgs = new Map();
  const objects = [];
  for (const [k, mesh] of keyMeshes) {
    const m = mesh.material;
    baseImgs.set(k, (m.map && m.map.image) || null);
    objects.push({ id: k, shape: 'plane', color: baseColors[k] || '#ffffff' });
  }

  const layers = (cfg.layers && cfg.layers.length) ? cfg.layers : DEFAULT_LAYERS;
  const level = { paintLayers: deepClone(layers), paints: deepClone(cfg.paints || []), objects };
  const paint = new SkinPaint(level, { size: cfg.size || SKIN_SIZE, baseImgs });

  // 只有被涂过 / 改过底色的网格才换画布贴图，其余保留原始贴图
  const painted = new Set((cfg.paints || []).map((p) => p.objectId));
  for (const [k, mesh] of keyMeshes) {
    if (!painted.has(k) && !baseColors[k]) continue;
    const m = mesh.material;
    m.map = paint.getSurface(k).tex;
    if (m.color) m.color.set(0xffffff);
    m.needsUpdate = true;
  }
  paint.flush();

  const anchors = buildAnchors(root);
  const built = [];
  for (const acc of (cfg.accessories || [])) {
    const anchor = resolveAnchor(root, anchors, acc.anchor);
    const b = await buildAccessory(acc);
    anchor.add(b.group);
    built.push(b);
  }

  return {
    paint,
    dispose() {
      for (const b of built) disposeBuilt(b);
      paint.dispose();
    },
  };
}

/** 读取该模型资产的皮肤配置并套用（avatar.js 调用） */
export async function applySavedSkin(root, assetId) {
  const cfg = await loadSkin(assetId);
  if (!cfg) return null;
  return applySkinToModel(root, cfg);
}

/* ============================================================
   编辑器窗口
   ============================================================ */
export class SkinEditor {
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    this.active = false;
    this.root = $('#skin');
    this.assetId = '';
    this._models = [];

    /* 编辑态 */
    this.tool = 'brush';
    this.color = '#ff5c8a';
    this.alpha = 1;
    this.size = 26;
    this.hardness = 0.5;
    this.baseColor = '#ffffff';
    this.accessories = [];
    this.selAcc = '';
    this.tab = 'paint';
    this._dirty = false;

    /* 3D */
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400);
    this.modelSlot = new THREE.Group();
    this.scene.add(this.modelSlot);
    this.cam = { target: new THREE.Vector3(0, 2.5, 0), dist: 12, yaw: 0.7, pitch: 0.22 };
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this.inst = null;
    this.mixer = null;
    this.paint = null;
    this.anchors = new Map();
    this._accRecs = new Map();      // accId -> { group, mesh, model, modelH }
    this._meshKey = new Map();      // mesh -> key
    this._keyMesh = new Map();      // key -> mesh
    this._baseImgs = new Map();
    this.boneOpts = [];             // 模型真实骨骼名（挂件锚点可选）
    this._paintLevel = null;
    this._stroke = null;
    this._drag = null;

    this._buildScene();
    this._buildUI();
    this._bind();
  }

  /* ---------- 场景 ---------- */
  _buildScene() {
    this.scene.background = null;
    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x2a2a44, 1.0));
    const dir = new THREE.DirectionalLight(0xffffff, 1.15);
    dir.position.set(4, 9, 6);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0x9fd0ff, 0.35);
    dir2.position.set(-5, 3, -6);
    this.scene.add(dir2);
    const grid = new THREE.GridHelper(40, 40, 0x3a3f66, 0x24273f);
    grid.position.y = 0;
    grid.material.opacity = 0.55;
    grid.material.transparent = true;
    this.scene.add(grid);
    this._applyCamera();
  }

  _applyCamera() {
    const t = this.cam.target;
    const cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    this.camera.position.set(
      t.x + this.cam.dist * cp * Math.sin(this.cam.yaw),
      t.y + this.cam.dist * sp,
      t.z + this.cam.dist * cp * Math.cos(this.cam.yaw),
    );
    this.camera.lookAt(t);
  }

  /* ---------- 界面 ---------- */
  _buildUI() {
    const host = $('#skin-side');
    if (!host) return;
    this.side = host;
    clear(host);

    /* 头部 */
    const head = el('div', { class: 'skin-head' },
      el('h2', { text: '角色皮肤编辑器' }),
      el('button', { class: 'xbtn', 'data-skin': 'close', text: '✕' }),
    );
    host.appendChild(head);

    /* 模型选择 */
    this.assetSel = new GridSelect({
      cls: 'inp sm',
      value: this.assetId || '',
      onChange: (v) => this._pickAsset(v),
    });
    this.assetSel.el.id = 'skin-asset';
    this.statusEl = el('span', { class: 'skin-status', text: '选择或导入一个模型' });
    host.appendChild(el('div', { class: 'skin-block' },
      el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '角色模型' }), this.assetSel),
      el('div', { class: 'skin-row2' },
        el('button', { class: 'mbtn sm', 'data-skin': 'import', text: '＋ 导入 glb/gltf' }),
        el('button', { class: 'mbtn sm', 'data-skin': 'reload', text: '↻ 重新加载' }),
      ),
      el('div', { class: 'skin-row2' },
        el('button', { class: 'mbtn sm', 'data-skin': 'exportchar', text: '↧ 导出角色包' }),
        el('button', { class: 'mbtn sm', 'data-skin': 'importchar', text: '↥ 导入角色包' }),
      ),
      this.statusEl,
    ));

    /* 分页 */
    host.appendChild(el('div', { class: 'skin-tabbar' },
      el('button', { class: 'tab on', 'data-skin-tab': 'paint', text: '涂画皮肤' }),
      el('button', { class: 'tab', 'data-skin-tab': 'gear', text: '挂件' }),
    ));

    this.panePaint = el('div', { class: 'skin-pane' });
    this.paneGear = el('div', { class: 'skin-pane hidden' });
    host.appendChild(this.panePaint);
    host.appendChild(this.paneGear);
    this._buildPaintPane();
    this._buildGearPane();

    /* 底部 */
    host.appendChild(el('div', { class: 'skin-foot' },
      el('button', { class: 'mbtn sm primary', 'data-skin': 'save', text: '保存皮肤' }),
      el('button', { class: 'mbtn sm', 'data-skin': 'resetpaint', text: '清空涂画' }),
      el('button', { class: 'mbtn sm danger', 'data-skin': 'delete', text: '删除皮肤' }),
    ));

    /* 提示 + 笔刷光标 */
    const tip = $('#skin-tip');
    if (tip) tip.textContent = '左键按住模型 = 涂画 · 空白处拖动 = 旋转 · 右键拖动 = 平移 · 滚轮 = 缩放';
    this.cursor = el('div', { class: 'skin-cursor', style: { display: 'none' } });
    if (this.root) this.root.appendChild(this.cursor);
  }

  _buildPaintPane() {
    const p = this.panePaint;
    clear(p);
    this._toolBtns = new Map();
    const tools = el('div', { class: 'skin-tools' });
    for (const t of [{ v: 'brush', l: '🖌 画笔' }, { v: 'eraser', l: '🧽 橡皮' }]) {
      const b = el('button', {
        class: 'sk-tool' + (this.tool === t.v ? ' on' : ''), text: t.l,
        onclick: () => { this.tool = t.v; this._syncTools(); },
      });
      this._toolBtns.set(t.v, b);
      tools.appendChild(b);
    }
    p.appendChild(tools);
    p.appendChild(this._row('颜色', el('input', { type: 'color', class: 'inp skin-color', value: this.color, oninput: (e) => { this.color = e.target.value; } })));
    p.appendChild(this._row('不透明度', this._range(0.05, 1, 0.01, this.alpha, (v) => { this.alpha = v; })));
    p.appendChild(this._row('笔刷大小', this._range(2, 200, 1, this.size, (v) => { this.size = v; })));
    p.appendChild(this._row('笔刷硬度', this._range(0, 1, 0.01, this.hardness, (v) => { this.hardness = v; })));
    this.baseColorInput = el('input', { type: 'color', class: 'inp', value: this.baseColor, oninput: (e) => this._setBaseColor(e.target.value) });
    p.appendChild(this._row('底色', this.baseColorInput));
    p.appendChild(el('div', { class: 'skin-hint', text: '底色会乘到模型原贴图上；无贴图的材质则整体铺成底色。' }));
  }

  _buildGearPane() {
    const p = this.paneGear;
    clear(p);
    this.anchorSel = this._select(this._anchorOptions(), 'torso', null);
    this.shapeSel = this._select(SHAPES, 'box', (v) => {
      if (this.selAcc) { const a = this._accById(this.selAcc); if (a) { a.shape = v; this._rebuildAcc(); } }
    });
    p.appendChild(el('div', { class: 'skin-block' },
      el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '锚点' }), this.anchorSel),
      el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '形状' }), this.shapeSel),
      el('button', { class: 'mbtn sm primary', 'data-skin': 'addgear', text: '＋ 添加挂件' }),
    ));
    this.gearList = el('div', { class: 'skin-gear-list' });
    this.gearProps = el('div', { class: 'skin-gear-props' });
    p.appendChild(el('div', { class: 'skin-hint', text: '锚点选「骨骼 · 名字」把挂件绑到骨骼上，它会跟着模型动画一起动。' }));
    p.appendChild(this.gearList);
    p.appendChild(this.gearProps);
  }

  /* ---------- 锚点 ---------- */
  /** 锚点下拉的选项：语义锚点 + 模型自带的真实骨骼 */
  _anchorOptions() {
    return ANCHOR_DEFS.map((d) => ({ v: d.v, l: d.l })).concat(this.boneOpts || []);
  }

  /** 重建锚点下拉（换了模型 / 骨骼列表变了）。keep 为空则尽量保留原选中项 */
  _fillAnchorSel(keep) {
    if (!this.anchorSel) return;
    const opts = this._anchorOptions();
    const cur = keep || this.anchorSel.value || 'torso';
    const has = opts.some((o) => o.v === cur);
    this.anchorSel.setOptions(opts);
    this.anchorSel.setValue(has ? cur : 'torso');
  }

  /** 锚点的显示名（骨骼锚点没有中文字义，直接显示骨骼名） */
  _anchorLabel(v) {
    const d = ANCHOR_DEFS.find((a) => a.v === v);
    if (d) return d.l;
    const s = String(v || '');
    if (s.startsWith('bone:')) return '骨骼 · ' + s.slice(5);
    return s || '整体';
  }

  _row(label, node) {
    return el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: label }), node);
  }

  _range(min, max, step, val, fn) {
    return el('input', { type: 'range', class: 'inp', min, max, step, value: val, oninput: (e) => fn(Number(e.target.value)) });
  }

  _select(list, value, fn) {
    return new GridSelect({
      cls: 'inp sm',
      value,
      options: list,
      onChange: (v) => { if (fn) fn(v); },
    });
  }

  _num(val, step, fn) {
    return el('input', { type: 'number', class: 'inp sm skin-num', step, value: val, oninput: (e) => fn(Number(e.target.value) || 0) });
  }

  _syncTools() {
    if (this._toolBtns) for (const [v, b] of this._toolBtns) b.classList.toggle('on', v === this.tool);
  }

  _status(t) { if (this.statusEl) this.statusEl.textContent = t; }

  /* ---------- 事件 ---------- */
  _bind() {
    if (this.root) {
      this.root.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-skin-tab]');
        if (tab) { this._setTab(tab.dataset.skinTab); return; }
        const btn = e.target.closest('[data-skin]');
        if (!btn) return;
        this._act(btn.dataset.skin);
      });
    }
    const cv = this.engine.canvas;
    cv.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.cam.dist = clamp(this.cam.dist * (e.deltaY > 0 ? 1.12 : 0.89), 1.2, 90);
      this._applyCamera();
    }, { passive: false });
    cv.addEventListener('contextmenu', (e) => { if (this.active) e.preventDefault(); });
    cv.addEventListener('pointerdown', (e) => this._onDown(e));
    cv.addEventListener('pointermove', (e) => this._onMove(e));
    cv.addEventListener('pointerup', (e) => this._onUp(e));
    cv.addEventListener('pointercancel', (e) => this._onUp(e));
    cv.addEventListener('pointerleave', () => { if (this.cursor) this.cursor.style.display = 'none'; });
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.code === 'KeyB') { this._setTab('paint'); }
      else if (e.code === 'KeyG') { this._setTab('gear'); }
    });
  }

  _setTab(tab) {
    this.tab = tab;
    if (this.panePaint) this.panePaint.classList.toggle('hidden', tab !== 'paint');
    if (this.paneGear) this.paneGear.classList.toggle('hidden', tab !== 'gear');
    for (const b of this.root ? this.root.querySelectorAll('[data-skin-tab]') : []) {
      b.classList.toggle('on', b.dataset.skinTab === tab);
    }
    this._updateCursorMode();
  }

  async _act(act) {
    if (act === 'close') { this.app.closeSkin(); return; }
    if (act === 'import') await this._importModel();
    else if (act === 'reload') await this._loadModel(this.assetId);
    else if (act === 'save') await this._save();
    else if (act === 'resetpaint') this._clearPaint();
    else if (act === 'delete') await this._deleteSkinFile();
    else if (act === 'addgear') this._addAcc();
    else if (act === 'exportchar') await this._exportChar();
    else if (act === 'importchar') await this._importChar();
  }

  /* ---------- 开关 ---------- */
  async open() {
    if (!this.root) return;
    this.active = true;
    this.cursor && (this.cursor.style.display = 'none');
    this.app._useView({ scene: this.scene, camera: this.camera });
    // 切到本编辑器相机后必须同步一次视口：相机构造时 aspect=1，
    // 引擎只在 resize/setRect 时刷新当前相机 aspect，不主动同步会全屏拉伸
    this.engine.resize();
    this._applyCamera();
    this._setTab(this.tab || 'paint');     // 同步页签高亮与画布光标状态
    await this._refreshAssets();
    if (!this.assetId && this._models.length) this.assetId = this._models[0].id;
    this.assetSel && this.assetSel.setValue(this.assetId || '');
    await this._loadModel(this.assetId);
    this._dirty = false;
  }

  close() {
    this.active = false;
    this._disposeStroke();
    this._disposeAcc();
    this._disposePaint();
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer = null; }
    if (this.inst) {
      if (this.inst.parent) this.inst.parent.remove(this.inst);
      this.inst.traverse((o) => {
        if (!o.isMesh) return;
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => { if (x && x.userData && x.userData.skinOwned) x.dispose(); });
        else if (m && m.userData && m.userData.skinOwned) m.dispose();
      });
      this.inst = null;
    }
    if (this.tpl) { this.tpl.refs = Math.max(0, this.tpl.refs - 1); this.tpl = null; }
    this.anchors = new Map();
    this.boneOpts = [];
    this._meshKey = new Map();
    this._keyMesh = new Map();
    this._baseImgs = new Map();
    this.engine.canvas.style.cursor = '';
    if (this.cursor) this.cursor.style.display = 'none';
  }

  update(dt) {
    if (this.mixer) this.mixer.update(dt);
  }

  /* ---------- 资产 ---------- */
  async _refreshAssets() {
    // 流式：分批读出模型素材，先到先显示；ready() 拿到完整列表后再回填 _models
    const load = streamAssetOptions('model', {
      thumbs: false,
      // 模型资源的 assetId 字段存「裸素材 id」（不带 asset: 前缀，见 asset-manager BARE_KEYS），
      // 而素材选项的默认值是 'asset:<id>'，这里统一改回裸 id，否则选中后加载会找不到素材
      map: (o) => ({ ...o, v: o.id }),
      head: [{ v: '', l: '（未选择）' }],
      missing: (all) => (all.some((o) => o.id) ? null : [{ v: '', l: '（还没有模型素材）' }]),
    });
    if (!this.assetSel) {
      const acc = [];
      await load((batch) => { for (const o of (batch || [])) acc.push(o); });
      this._models = acc.filter((o) => o.id).map((o) => ({ id: o.id, name: o.l }));
      return;
    }
    this.assetSel.setOptions(load);
    const all = await this.assetSel.ready();
    this._models = all.filter((o) => o.id).map((o) => ({ id: o.id, name: o.l }));
    const none = !this._models.length;
    this.assetSel.placeholder = none ? '（还没有模型素材）' : '（未选择）';
    this.assetSel.setValue(this.assetId || '');
  }

  async _importModel() {
    let rec = null;
    try {
      const { importAssetFile } = await import('../editor/asset-manager.js');
      rec = await importAssetFile('model');
    } catch (e) { console.warn('[skin] 导入失败', e); }
    if (!rec) return;
    this.assetId = rec.id;
    this._dirty = false;
    await this._refreshAssets();
    await this._loadModel(this.assetId);
  }

  async _pickAsset(id) {
    if (id === this.assetId) return;
    if (this._dirty) {
      const ok = await confirmBox('切换模型会丢弃当前未保存的编辑，继续？');
      if (!ok) { if (this.assetSel) this.assetSel.setValue(this.assetId || ''); return; }
    }
    this.assetId = id;
    this._dirty = false;
    await this._loadModel(id);
  }

  /* ---------- 模型 ---------- */
  async _loadModel(assetId) {
    this._disposeStroke();
    this._disposeAcc();
    this._disposePaint();
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer = null; }
    if (this.inst) {
      if (this.inst.parent) this.inst.parent.remove(this.inst);
      this.inst.traverse((o) => {
        if (!o.isMesh) return;
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => { if (x && x.userData && x.userData.skinOwned) x.dispose(); });
        else if (m && m.userData && m.userData.skinOwned) m.dispose();
      });
      this.inst = null;
    }
    if (this.tpl) { this.tpl.refs = Math.max(0, this.tpl.refs - 1); this.tpl = null; }
    this.anchors = new Map();
    this.boneOpts = [];
    this.accessories = [];
    this.selAcc = '';
    this._accRecs = new Map();
    this._renderGear();

    if (!assetId) { this._status('先导入一个 .glb / .gltf 模型'); return; }
    this._status('正在加载模型…');
    const tpl = await loadAvatarTemplate(assetId);
    if (!this.active) return;
    if (!tpl || tpl.status !== 'ok' || !tpl.root) {
      this._status('模型加载失败（' + ((tpl && tpl.status) || 'error') + '）');
      return;
    }
    this.tpl = tpl; tpl.refs++;

    const inst = cloneSkinned(tpl.root);
    inst.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false;
      o.userData.sharedGeometry = true;
      if (Array.isArray(o.material)) { o.material = o.material.map(cloneSkinMaterial); return; }
      // 每个网格独立克隆一份材质。很多角色模型的左右肢体共用同一份材质、
      // uv 又互为镜像，共享材质会让一笔同时画到对称的两侧 —— 每网格一份颜色。
      o.material = cloneSkinMaterial(o.material);
    });
    // 顺序即材质键 m0/m1…（与 applySkinToModel 完全一致）
    const meshes = collectPaintMeshes(inst);
    meshes.forEach((o) => { o.userData.skinPaintable = true; });
    this.modelSlot.add(inst);
    this.inst = inst;

    /* 待机动画（有的话） */
    if (tpl.clips && tpl.clips.length) {
      this.mixer = new THREE.AnimationMixer(inst);
      const cm = matchClips(tpl.clips);
      const clip = cm.Idle || tpl.clips[0];
      if (clip) this.mixer.clipAction(clip).play();
    }

    /* 统一摆成 ~5 studs 高，方便取景、也让挂件尺寸可预期 */
    inst.updateWorldMatrix(true, true);
    let box = new THREE.Box3().setFromObject(inst);
    let size = box.getSize(new THREE.Vector3());
    const s = 5 / Math.max(size.y, 1e-3);
    inst.scale.multiplyScalar(s);
    inst.updateWorldMatrix(true, true);
    box = new THREE.Box3().setFromObject(inst);
    size = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    this.cam.target.copy(ctr);
    this.cam.dist = Math.max(4.5, size.length() * 1.15);
    this.cam.pitch = 0.22;
    this._applyCamera();

    this.anchors = buildAnchors(inst);
    this.boneOpts = listBones(inst);      // 模型真实骨骼，挂件可精确挂上去跟着动
    this._fillAnchorSel();

    /* 读存档 */
    let cfg = null;
    try { cfg = await loadSkin(assetId); } catch (e) { /* ignore */ }
    if (!this.active) return;

    /* 建涂画系统 */
    this._setupPaint(meshes, cfg);
    /* 挂件 */
    this.accessories = (cfg && Array.isArray(cfg.accessories)) ? deepClone(cfg.accessories) : [];
    this.selAcc = this.accessories.length ? this.accessories[0].id : '';
    await this._buildAccGroups();
    this._renderGear();

    this._dirty = false;
    const n = this.accessories.length;
    this._status('已加载：' + (tpl.root.name || assetId) + (cfg ? '（含已保存皮肤）' : '') + (n ? ' · 挂件 ' + n : ''));
  }

  _setupPaint(meshes, cfg) {
    this._paintLevel = { paintLayers: deepClone(DEFAULT_LAYERS), paints: [], objects: [] };
    this._baseImgs = new Map();
    this._meshKey = new Map();      // mesh -> key
    this._keyMesh = new Map();      // key -> mesh
    const baseColors = (cfg && cfg.baseColors) || {};
    const layers = (cfg && cfg.layers && cfg.layers.length) ? cfg.layers : DEFAULT_LAYERS;
    this._paintLevel.paintLayers = deepClone(layers);
    this._paintLevel.paints = deepClone((cfg && cfg.paints) || []);
    this.baseColor = '#ffffff';

    // 有存档就全信存档；没有存档时，「无贴图的纯色材质」用材质本色当底色，
    // 这样换上画布贴图后模型长相不变（否则会被铺成白色）
    const hasSavedColors = !!(cfg && cfg.baseColors);
    (meshes || []).forEach((mesh, i) => {
      const key = 'm' + i;
      const mat = mesh.material;
      const img = (mat.map && mat.map.image) || null;
      this._meshKey.set(mesh, key);
      this._keyMesh.set(key, mesh);
      this._baseImgs.set(key, img);
      let col;
      if (hasSavedColors) col = baseColors[key] || '#ffffff';
      else if (!img && mat.color && mat.color.getHex() !== 0xffffff) col = '#' + mat.color.getHexString();
      else col = '#ffffff';
      this._paintLevel.objects.push({ id: key, shape: 'plane', color: col });
      if (col !== '#ffffff' && this.baseColor === '#ffffff') this.baseColor = col;
    });
    if (this.baseColorInput) this.baseColorInput.value = this.baseColor;

    this.paint = new SkinPaint(this._paintLevel, { size: SKIN_SIZE, baseImgs: this._baseImgs });

    // 画布贴图懒挂：只给「有涂画 / 改过底色」的网格立刻挂上，其余保留原贴图 ——
    // 多网格模型能省下每网格一张 1024² 画布，首笔落下 / 改底色时再挂（_attachMap）。
    const painted = new Set(this._paintLevel.paints.map((p) => p.objectId));
    for (const o of this._paintLevel.objects) {
      if (painted.has(o.id) || o.color !== '#ffffff') this._attachMap(o.id);
    }
  }

  /** 把该网格的画布贴图挂上去（幂等）；懒挂载的入口 */
  _attachMap(key) {
    const mesh = this._keyMesh.get(key);
    if (!mesh || !this.paint) return;
    const mat = mesh.material;
    const tex = this.paint.getSurface(key).tex;
    if (mat.map === tex) return;
    mat.map = tex;
    if (mat.color) mat.color.set(0xffffff);
    mat.needsUpdate = true;
    this.paint.markDirty(key);
    this.paint.flush();
  }

  _disposePaint() {
    if (this.paint) { try { this.paint.dispose(); } catch (e) { /* ignore */ } this.paint = null; }
    this._paintLevel = null;
  }

  /* ---------- 涂画 ---------- */
  _hit(cx, cy) {
    if (!this.inst) return null;
    const r = this.engine.canvas.getBoundingClientRect();
    this._ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this.camera);
    const hits = this._ray.intersectObject(this.modelSlot, true);
    for (const h of hits) {
      const o = h.object;
      if (!o || !o.isMesh || !o.userData.skinPaintable) continue;
      if (!h.uv || Array.isArray(o.material)) continue;
      const key = this._meshKey.get(o);
      if (!key) continue;
      return { uv: [h.uv.x, h.uv.y], key };
    }
    return null;
  }

  _onDown(e) {
    if (!this.active) return;
    this._drag = { x: e.clientX, y: e.clientY, mode: 'idle', button: e.button };
    if (e.button === 0 && this.tab === 'paint') {
      const hit = this._hit(e.clientX, e.clientY);
      if (hit) {
        this._startStroke(hit);
        this._drag.mode = 'paint';
        try { this.engine.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
        return;
      }
    }
    this._drag.mode = (e.button === 2) ? 'pan' : 'orbit';
    try { this.engine.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  _onMove(e) {
    if (!this.active) return;
    /* 笔刷光标 */
    if (this.cursor) {
      // 涂画页：光标始终跟随（拖动涂画时也在）；其余页或旋转/平移中隐藏
      if (this.tab === 'paint' && (!this._drag || this._drag.mode === 'paint')) {
        const r = this.engine.canvas.getBoundingClientRect();
        this.cursor.style.display = 'block';
        this.cursor.style.width = this.size + 'px';
        this.cursor.style.height = this.size + 'px';
        this.cursor.style.left = (e.clientX - r.left) + 'px';
        this.cursor.style.top = (e.clientY - r.top) + 'px';
      } else {
        this.cursor.style.display = 'none';
      }
    }
    if (!this._drag) return;
    if (this._drag.mode === 'paint') {
      const hit = this._hit(e.clientX, e.clientY);
      if (!hit) return;
      if (!this._stroke || hit.key !== this._stroke.key) { this._endStroke(); this._startStroke(hit); return; }
      this.paint.strokePoint(this._stroke.active, hit.uv);
      this.paint.flush();
      return;
    }
    const dx = e.clientX - this._drag.x;
    const dy = e.clientY - this._drag.y;
    this._drag.x = e.clientX; this._drag.y = e.clientY;
    if (this._drag.mode === 'orbit') {
      this.cam.yaw -= dx * 0.008;
      this.cam.pitch = clamp(this.cam.pitch + dy * 0.006, -0.35, 1.35);
    } else {
      const s = this.cam.dist * 0.0016;
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
      this.cam.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
    }
    this._applyCamera();
  }

  _onUp() {
    if (this._drag && this._drag.mode === 'paint') this._endStroke();
    this._drag = null;
  }

  _startStroke(hit) {
    if (!this.paint) return;
    this._attachMap(hit.key);          // 懒挂：第一次涂到才把画布贴图换上
    const layerId = this._paintLevel.paintLayers[0].id;
    const active = this.paint.beginStroke(hit.key, layerId, {
      tool: this.tool === 'eraser' ? 'eraser' : 'brush',
      mode: 'color',
      color: this.color,
      alpha: this.alpha,
      size: this.size,
      hardness: this.hardness,
    });
    this._stroke = { key: hit.key, active };
    this.paint.strokePoint(active, hit.uv);
    this.paint.flush();
    this._dirty = true;
  }

  _endStroke() {
    if (!this._stroke || !this.paint) { this._stroke = null; return; }
    this.paint.endStroke(this._stroke.active.s);
    this.paint.flush();
    this._stroke = null;
  }

  _disposeStroke() { this._stroke = null; }

  _setBaseColor(color) {
    this.baseColor = color;
    if (!this._paintLevel) return;
    for (const o of this._paintLevel.objects) o.color = color;
    for (const key of this._keyMesh.keys()) this._attachMap(key);   // 改底色要立刻可见：这时才挂上懒挂的画布
    this.paint.flush();
    this._dirty = true;
  }

  _clearPaint() {
    if (!this.paint) return;
    for (const key of this._keyMesh.keys()) this.paint.clearObject(key, null);
    this.paint.flush();
    this._dirty = true;
    toast('已清空涂画');
  }

  _updateCursorMode() {
    if (!this.engine || !this.engine.canvas) return;
    this.engine.canvas.style.cursor = this.active && this.tab === 'paint' ? 'crosshair' : '';
  }

  /* ---------- 挂件 ---------- */
  _accById(id) { return this.accessories.find((a) => a.id === id) || null; }

  _addAcc() {
    const shape = this.shapeSel ? this.shapeSel.value : 'box';
    const acc = {
      id: uid('acc'),
      anchor: this.anchorSel ? this.anchorSel.value : 'torso',
      shape,
      assetId: shape === 'model' ? ((this._models[0] && this._models[0].id) || '') : '',
      color: '#ff5c8a',
      size: [0.6, 0.6, 0.6],
      pos: [0, 0, 0],
      rot: [0, 0, 0],
      scale: 1,
    };
    this.accessories.push(acc);
    this.selAcc = acc.id;
    this._buildAccGroups().then(() => this._renderGear());
    this._dirty = true;
  }

  _disposeAcc() {
    for (const b of this._accRecs.values()) disposeBuilt(b);
    this._accRecs = new Map();
  }

  async _buildAccGroups() {
    this._disposeAcc();
    for (const acc of this.accessories) {
      const anchor = resolveAnchor(this.inst, this.anchors, acc.anchor);
      if (!anchor) continue;
      const b = await buildAccessory(acc);
      anchor.add(b.group);
      this._accRecs.set(acc.id, b);
    }
  }

  _applyAccLive(acc) {
    const b = this._accRecs.get(acc.id);
    if (!b) return;
    b.group.position.fromArray(acc.pos || [0, 0, 0]);
    const r = acc.rot || [0, 0, 0];
    b.group.rotation.set(deg2rad(r[0] || 0), deg2rad(r[1] || 0), deg2rad(r[2] || 0));
    b.group.scale.setScalar(acc.scale ?? 1);
    const size = acc.size || [0.6, 0.6, 0.6];
    if (b.mesh) { b.mesh.scale.set(size[0] || 0.6, size[1] || 0.6, size[2] || 0.6); b.mesh.material.color.set(acc.color || '#ff5c8a'); }
    if (b.model) b.model.scale.setScalar((size[1] || 0.6) / (b.modelH || 1));
  }

  _rebuildAcc() {
    this._dirty = true;
    this._buildAccGroups().then(() => this._renderGear());
  }

  _renderGear() {
    if (!this.gearList) return;
    /* 列表 */
    clear(this.gearList);
    if (!this.accessories.length) {
      this.gearList.appendChild(el('div', { class: 'skin-hint', text: '还没有挂件。选好锚点与形状后点「添加挂件」。' }));
    }
    for (const acc of this.accessories) {
      const shapeLabel = (SHAPES.find((s) => s.v === acc.shape) || {}).l || acc.shape;
      const anchorLabel = this._anchorLabel(acc.anchor);
      this.gearList.appendChild(el('div', {
        class: 'skin-gear-item' + (acc.id === this.selAcc ? ' sel' : ''),
        onclick: () => { this.selAcc = acc.id; this._renderGear(); },
      },
        el('span', { class: 'skin-gear-dot', style: { background: acc.color || '#ff5c8a' } }),
        el('span', { class: 'skin-gear-name', text: anchorLabel + ' · ' + shapeLabel }),
        el('button', { class: 'xbtn tiny', text: '✕', onclick: (e) => { e.stopPropagation(); this._delAcc(acc.id); } }),
      ));
    }
    /* 属性 */
    clear(this.gearProps);
    const acc = this._accById(this.selAcc);
    if (!acc) return;
    const live = () => { this._applyAccLive(acc); this._dirty = true; };
    this.gearProps.appendChild(el('div', { class: 'skin-sub', text: '挂件属性' }));
    this.gearProps.appendChild(this._row('锚点', this._select(this._anchorOptions(), acc.anchor, (v) => { acc.anchor = v || 'root'; this._rebuildAcc(); })));
    this.gearProps.appendChild(this._row('形状', this._select(SHAPES, acc.shape, (v) => { acc.shape = v; this._rebuildAcc(); })));
    if (acc.shape === 'model') {
      const opts = this._models.map((m) => ({ v: m.id, l: m.name || m.id }));
      if (!opts.length) opts.push({ v: '', l: '（无模型素材）' });
      this.gearProps.appendChild(this._row('模型素材', this._select(opts, acc.assetId, (v) => { acc.assetId = v; this._rebuildAcc(); })));
    }
    this.gearProps.appendChild(this._row('颜色', el('input', { type: 'color', class: 'inp', value: acc.color || '#ff5c8a', oninput: (e) => { acc.color = e.target.value; live(); } })));
    this.gearProps.appendChild(this._vec3('尺寸', acc.size, live, 0.05));
    this.gearProps.appendChild(this._vec3('位置', acc.pos, live, 0.05));
    this.gearProps.appendChild(this._vec3('旋转°', acc.rot, live, 5));
    this.gearProps.appendChild(this._row('缩放', this._range(0.1, 4, 0.05, acc.scale ?? 1, (v) => { acc.scale = v; live(); })));
  }

  _vec3(label, arr, fn, step) {
    const a = arr || [0, 0, 0];
    const xs = [0, 1, 2].map((i) => this._num(a[i] || 0, step, (v) => { a[i] = v; fn(); }));
    return el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: label }), ...xs);
  }

  _delAcc(id) {
    const i = this.accessories.findIndex((a) => a.id === id);
    if (i < 0) return;
    this.accessories.splice(i, 1);
    if (this.selAcc === id) this.selAcc = this.accessories.length ? this.accessories[0].id : '';
    this._rebuildAcc();
  }

  /* ---------- 保存 ---------- */
  async _save() {
    if (!this.assetId) { toast('先选一个模型', 'err'); return; }
    if (!this.paint) { toast('还没有可保存的皮肤', 'err'); return; }
    const baseColors = {};
    for (const o of this._paintLevel.objects) baseColors[o.id] = o.color;
    const cfg = {
      version: 1,
      assetId: this.assetId,
      size: this.paint.size,
      layers: deepClone(this._paintLevel.paintLayers),
      baseColors,
      paints: deepClone(this._paintLevel.paints),
      accessories: deepClone(this.accessories),
      updated: Date.now(),
    };
    const ok = await saveSkin(this.assetId, cfg);
    if (ok) {
      this._dirty = false;
      this._status('已保存 · ' + new Date().toLocaleTimeString());
      toast('皮肤已保存，游玩时使用该模型会自动套用', 'ok');
    } else {
      toast('保存失败', 'err');
    }
  }

  /* ---------- 角色包（.fdchar，自包含：模型 / 皮肤 / 挂件全在一个文件里） ---------- */
  async _exportChar() {
    if (!this.assetId) { toast('先选一个模型', 'err'); return; }
    this._status('正在打包角色…');
    let bundle = null;
    try { bundle = await exportCharacter(this.assetId); } catch (e) { console.warn('[skin] 打包失败', e); }
    if (!bundle) { this._status('打包失败'); toast('打包失败：读不到模型素材', 'err'); return; }
    const name = (bundle.name || 'character') + '.fdchar';
    saveBlob(name, new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
    this._status('已导出 ' + name + '（模型 / 皮肤 / 挂件都在文件里）');
    toast('角色包已导出：' + name, 'ok');
  }

  async _importChar() {
    const file = await pickFile('.fdchar,.json');
    if (!file) return;
    let text = '';
    try { text = await readFileText(file); } catch (e) { toast('读取失败', 'err'); return; }
    const chk = readCharacterBundle(text);
    if (chk.error) { toast(chk.error, 'err', 3200); return; }
    this._status('正在导入角色包…');
    const res = await importCharacter(text);
    if (res.error) { this._status('导入失败'); toast(res.error, 'err', 3200); return; }
    this.assetId = res.rec.id;
    this._dirty = false;
    await this._refreshAssets();
    await this._loadModel(this.assetId);
    toast('已导入角色：' + (res.rec.name || res.rec.id), 'ok');
  }

  async _deleteSkinFile() {
    if (!this.assetId) return;
    const ok = await confirmBox('删除该模型已保存的皮肤？（画面上的编辑仍在，可重新保存）', { danger: true });
    if (!ok) return;
    await deleteSkin(this.assetId);
    this._status('已删除该模型的皮肤存档');
    toast('皮肤存档已删除');
  }
}