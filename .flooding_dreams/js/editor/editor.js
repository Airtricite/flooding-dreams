/* ============================================================
   编辑器主控
   - 负责：场景/构建器/涂鸦/视口/3D组件/面板 的装配与生命周期
   - 对外提供属性面板、对象树、事件/动画/涂鸦编辑器所需的全部操作 API
   ============================================================ */
import * as THREE from 'three';
import { el, clear, toast, confirmBox, promptBox, formBox, modal, hideScreens, currentScreen } from '../ui/dom.js';
import { settings } from '../core/settings.js';
import { store } from '../core/storage.js';
import { audio } from '../core/audio.js';
import { EDITOR, PHYS } from '../config.js';
import { LevelBuilder } from '../world/builder.js';
import { setEnvIntensity } from '../core/materials.js';
import { PaintManager } from '../world/paint.js';
import {
  getObject, objectLabel, reparentObject, duplicateObjects,
  removeObjectTree, worldPosition, levelStats, validateLevel,
} from '../world/level.js';
import { createObject, typeDef } from '../world/objectTypes.js';
import { portalPresetShape } from '../world/portal.js';
import { round, clamp, sanitizeName } from '../core/util.js';
import { resolveSkyTexture } from '../core/textures.js';
import { disposeReflections, getReflectionTexture, renderGlassCapture } from '../world/advanced-materials.js';
import { collectPostFX } from '../core/postfx.js';
import { collectScreen } from '../core/exposure.js';
import { History, copyObjects, pasteObjects } from './history.js';
import { Viewport } from './viewport.js';
import { EditorGizmo, selectionWorldBox } from './gizmo.js';
import { Outliner } from './outliner.js';
import { Inspector } from './inspector.js';
import { Creator } from './creator.js';
import { EventsEditor } from './events-editor.js';
import { PackPanel } from './pack-panel.js';
import { AnimEditor, closeEaseWindow } from './anim-editor.js';
import { closeCodeWindow } from './code-window.js';
import { PaintEditor, isOverlay } from './paint-editor.js';
import { AssetManager } from './asset-manager.js';
import { PrefabPanel } from './prefab-panel.js';
import { localizeLevelAssets } from '../core/level-assets.js';
import { PATH_TYPES, resolvePath } from '../world/paths.js';
import { PathNodeEditor } from './path-nodes.js';
import { ParkourTools } from './parkour.js';
import { ModelEditor } from './model-editor.js';
import { StickerEditor } from './sticker-editor.js';
import { openSectionEditor } from './section-editor.js';
import { openBooleanDialog, openIslandDialog, convertToPoly } from './solid-ops.js';
import { openGeneratorDialog } from '../gen/ui.js';
import { contextMenu, closeMenu, closePopover } from './widgets.js';
import { openSkyLab, closeSkyLab } from './sky-lab.js';
import { closeSkyModEditor } from './sky-modifier-editor.js';
import { closeParticleEditor } from './particle-editor.js';
import { openNpcEditor, closeNpcEditor, npcEditor } from './npc-editor.js';
import { openVectorEditor, closeVectorEditor } from './vector-editor.js';
import { TextureModifierEditor, openTexModEditor } from './texture-modifier-editor.js';
import { setInfiniteDrag } from './infinite-drag.js';

const MODE_DEFS = [
  { k: 'select', l: '选择', key: 'Digit1' },
  { k: 'translate', l: '移动', key: 'Digit2' },
  { k: 'rotate', l: '旋转', key: 'Digit3' },
  { k: 'scale', l: '缩放', key: 'Digit4' },
  { k: 'combo', l: '组合', key: 'Digit5' },
];
const TABS = [
  { k: 'events', l: '事件编辑器', hint: '左侧选事件 · 节点可拖动 · 拖动端口连线 · 滚轮缩放画布' },
  { k: 'anim', l: '动画编辑器', hint: '单击关键帧改数值/缓动 · 拖动关键帧改时间 · 双击轨道改名 · 空格试播' },
  { k: 'packs', l: '关卡包', hint: '把多个关卡串成剧情地图 · 拖动节点摆位 · 「＋ 连线」连剧情 · 改动自动保存' },
  { k: 'console', l: '输出', hint: '编辑器运行日志' },
];
const REBUILD_KEYS = new Set(['shape', 'sides', 'assetId', 'physicsMode', 'points', 'segModes', 'ropeRadius', 'damage', 'knockback',
  // 路径对象（折曲线 / 管道）与网格修改器：改这些都要重建几何
  'handles', 'radius', 'tubeSeg', 'pathSource', 'pathRef',
  'section', 'sectionSides', 'sectionRadius', 'sectionRot', 'starInner', 'sectionPts',
  'hollow', 'wallThickness', 'capEnds',
  // 曲线墙：墙高 / 墙厚 / 倾角都进扫掠几何
  'wallHeight', 'wallTilt',
  'sourceRef', 'count', 'offsetStep', 'rotStep', 'scaleStep', 'distMode', 'curveRef', 'alignCurve',
  // 传送门：改预设 / 圆角 / 边数都要按预设重排轮廓（见 applyPropChange 的 _portalReshape）
  'shapePreset', 'cornerRadius']);
// 矢量挤出体：这些属性（连同 scale，其 stud 尺度 uv 烘进了几何）改变挤出网格本身
const VEC_GEO_KEYS = new Set(['depth', 'bevelSize', 'bevelProfile', 'bevelSegments',
  'modMode', 'modAmp', 'modFreq', 'modPhase', 'vecShape', 'scale']);
const MATERIAL_KEYS = new Set([
  'color', 'transparency', 'metalness', 'roughness', 'texture', 'textureSize', 'textureFill',
  'roughnessMap', 'normalMap',
  'emissive', 'emissiveIntensity', 'flatShading', 'kind', 'intensity', 'distance',
  // 路径型对象的平滑着色（内部映射到材质 flatShading，见 builder.pathLook）
  'smoothShade',
  'angle', 'penumbra', 'lightType', 'helper', 'castShadow', 'shadowSize', 'flow',
  'fillLevel', 'opacity', 'anchored', 'mass', 'material',
  // 液体视觉（水纹 / 深水变暗 / 围边泡沫）
  'liquidStyle', 'usePresetLook', 'rippleLayers', 'rippleScale', 'rippleSpeed', 'rippleStrength', 'warpSpeed', 'warpScale', 'rippleTint',
  'depthDarken', 'depthAbsorb', 'depthSat', 'depthLight', 'visibilityDepth', 'platformDepth', 'turbidityFollow', 'turbidityColor',
  'edgeFoam', 'foamColor', 'foamWidth', 'foamOpacity',
  // 光照影响（水面特效 / 传送门 / 体积特效 / 文字方块：曝光 + 画面染色 + 光照的比例，0~1）
  'lightInfluence',
  // 体积雾 / 体积光（特效着色器材质 + 伴随灯光）
  'density', 'noiseScale', 'noiseSpeed', 'softness',
  'falloff', 'fadeEnd', 'withLight', 'lightPower', 'lightRange',
  // 高级材质（网格模型：预设 + 反射率 + 图案参数）
  'advMat', 'reflectivity', 'fxScale', 'fxAmp', 'fxColor',
  // 平行视差传送门（视差图层 / 内部 / 外框：都是着色器 uniform）
  'layers', 'depthScale', 'innerColor', 'innerAlpha',
  'frame', 'frameColor', 'frameColor2', 'frameWidth', 'frameGlow', 'frameIntensity',
  'frameSpeed', 'innerGlow', 'edgeSoft',
  // NPC：预设 / 衣服色 / 自定义模型都会重建角色身体（走 builder.syncNpc）
  'preset', 'bodyColor',
  // 文字方块 / 公告板：文字 / 图片 / 富文本 / 底色与对齐都直接烘进贴图材质，必须实时重建
  'text', 'textColor', 'bgColor', 'bgOpacity', 'fontSize', 'bold', 'align', 'valign',
  'mode', 'image', 'baseOpacity', 'rich',
]);

/* ---------- 对象坐标系 ----------
   与 builder 的「子级锚点」同一套语义：沿 parent 链叠加「位置 + 旋转」，不含尺寸
   （网格的 scale 是自身长宽高，传给子级会把子级拉变形）。
   换父级时用它把对象的世界位姿换算到新父级空间，保证子级不会因为 offset 跳走。 */
const _frT = new THREE.Matrix4();
const _frR = new THREE.Matrix4();
const _frE = new THREE.Euler();
function objectFrame(level, o, out = new THREE.Matrix4()) {
  const chain = [];
  let cur = o;
  let guard = 0;
  while (cur && guard++ < 64) {
    chain.push(cur);
    cur = cur.parent ? getObject(level, cur.parent) : null;
  }
  out.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i];
    const p = c.position || [0, 0, 0];
    const r = c.rotation || [0, 0, 0];
    _frT.makeTranslation(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
    _frR.makeRotationFromEuler(_frE.set(
      THREE.MathUtils.degToRad(Number(r[0]) || 0),
      THREE.MathUtils.degToRad(Number(r[1]) || 0),
      THREE.MathUtils.degToRad(Number(r[2]) || 0)));
    out.multiply(_frT).multiply(_frR);
  }
  return out;
}

export class Editor {
  constructor({ engine, input, app }) {
    this.engine = engine;
    this.input = input;
    this.app = app;

    this.root = document.getElementById('editor');
    this.viewDom = document.getElementById('ed-view');
    this.botBody = document.getElementById('ed-bot-body');
    this.botHint = document.getElementById('ed-bot-hint');
    this.titleEl = this.root ? this.root.querySelector('.ed-logo') : null;

    this.level = null;
    this.record0 = null;          // 存档记录（保存时沿用 created）
    this.scene = null;
    this.builder = null;
    this.paint = null;
    this.gizmo = null;
    this.grid = null;
    this.selection = new Set();
    this.history = new History();
    this.dirty = false;
    this.mode = 'translate';
    this.space = 'world';
    this.snapOn = false;
    this.tab = 'events';
    this.leftTab = 'props';
    this.rightTab = 'outliner';
    this.logs = [];
    this.clipboard = null;
    this.opened = false;
    this._hudT = 0;

    this.view = { scene: null, camera: null };
    this.viewport = new Viewport({
      engine, input, dom: this.viewDom,
      getBuilder: () => this.builder,
    });
    this.viewport.enabled = false;

    this._bindDom();
    this._bindKeys();
    this._bindViewport();
  }

  /* ============================================================
     生命周期
     ============================================================ */
  open(level, rec) {
    if (!level) return;
    this.level = level;
    this.record0 = rec || null;
    // 素材按「当前关卡」分池：导入的素材写进本关文件夹，素材管理器只列本关的
    store.setAssetScope(level.id);
    // 换了关卡就是换了素材池，属性面板里缓存的下拉列表要重新拉
    if (this.inspector) this.inspector.invalidateAssets();
    this.selection = new Set();
    this.history.clear();
    this.dirty = false;
    this.logs.length = 0;
    // 先把关卡 BGM 解码好：点「试玩」时立刻出声
    if (this.level.settings && this.level.settings.bgm) audio.load(this.level.settings.bgm);

    /* 场景 */
    this._disposeScene();
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.paint = new PaintManager(level, { size: EDITOR.defaultPaintSize });
    this.paint.onChange = () => { this.refreshLayers(); this.dirty = true; };
    this.builder = new LevelBuilder(level, {
      editor: true, physics: false, scene: this.scene,
      paintHas: (id) => this.paint.has(id),
      paintKey: (id) => this.paint.key(id),
      // 导入的图片素材加载完成后再合成一次涂鸦画布：重进关卡时画布底图才不会是空的
      onTexturesReady: () => { if (this.paint) this.paint.rebuildAll(); },
    });
    this.scene.add(this.builder.root);

    /* 环境反射（IBL）：编辑器里也要能实时看到 env / 天空 / 亮度 的效果 */
    this._envKey = null; this._envTex = null;
    this.builder.onSkyApplied = () => this._applyEnvMap();
    this._applyEnvMap();
    // 后处理对象：参数每帧从关卡数据读取，属性面板一改立刻生效
    this.engine.postfx.setProvider((out) => collectPostFX(this.level, out));
    // 体积雾管线：编辑器里同样走半分辨率 + 时域重投影（见 world/volumefog.js）
    this.engine.postfx.setVolumeFog(this.builder.volumeFog);
    // 画面处理对象：同理，改色调映射 / EV / 色彩空间立刻能看到画面变化
    this.engine.setScreenProvider(() => collectScreen(this.level));

    /* 网格辅助 */
    const gs = EDITOR.gridSize;
    const grid = new THREE.GridHelper(gs * 125, 125, 0x7fe3ff, 0x4a4470);
    grid.position.y = 0;
    grid.material.transparent = true;
    grid.material.opacity = 0.24;
    grid.material.depthWrite = false;
    grid.userData.helper = true;
    this.scene.add(grid);
    this.grid = grid;

    this.view.scene = this.scene;
    this.view.camera = this.viewport.camera;
    // 主渲染前先渲一张不含水体的深度图，供水面泡沫做“深度差”判定；
    // 再用半分辨率缓冲捕获「不含玻璃的场景」，供玻璃屏幕空间折射采样
    this.view.beforeRender = (renderer, camera) => {
      if (!this.builder) return;
      this.builder.renderFoamDepth(renderer, camera);
      if (this.builder.usesGlass()) {
        renderGlassCapture(renderer, this.scene, camera, this.builder);
      }
    };

    /* 3D 编辑组件 */
    if (this.gizmo) this.gizmo.dispose();
    this.gizmo = new EditorGizmo({
      scene: this.scene, viewport: this.viewport, dom: this.viewDom,
      getBuilder: () => this.builder, getLevel: () => this.level,
      onLive: () => { this.dirty = true; this._syncBillboardSize(this.selectedRecs()); this.refreshPropsSoft(); },
      onStart: () => { this._gizmoPrev = this.snap(); },
      onEnd: () => {
        const recs = this.selectedRecs();
        this._syncBillboardSize(recs);
        this.record('变换 ' + this.modeLabel(), this._gizmoPrev, { tree: false });
        this.refreshPropsSoft();
        for (const r of recs) this.builder.syncTransform(r);
      },
    });
    this.gizmo.setSnap(this.snapOn);
    this.gizmo.setSpace(this.space);

    /* 路径对象逐节点 3D 编辑（滑索 / 折曲线 / 管道） */
    if (this.nodeEd) this.nodeEd.hide();
    this.nodeEd = new PathNodeEditor(this);

    /* 跑酷制造工具（跳跃验证 / 计时测量）：只是编辑器辅助体，不写进关卡数据 */
    if (!this.parkour) this.parkour = new ParkourTools(this);
    this.parkour.reset();

    /* 面板（只创建一次） */
    if (!this.outliner) this.outliner = new Outliner(this);
    if (!this.inspector) this.inspector = new Inspector(this);
    if (!this.creator) this.creator = new Creator(this);
    if (!this.consoleEl) this.consoleEl = el('div', { class: 'cons' });
    if (!this.eventsEd) this.eventsEd = new EventsEditor(this);
    if (!this.packEd) this.packEd = new PackPanel(this);
    if (!this.animEd) this.animEd = new AnimEditor(this);
    if (!this.paintEd) this.paintEd = new PaintEditor(this);
    if (!this.modelEd) this.modelEd = new ModelEditor(this);
    if (!this.stickerEd) this.stickerEd = new StickerEditor(this);
    else { this.stickerEd.attach(); this.stickerEd.refresh(); }
    if (!this.assetMgr) this.assetMgr = new AssetManager(this);
    this.assetMgr.refresh();
    if (!this.prefabPanel) this.prefabPanel = new PrefabPanel(this);
    if (!this.texModEd) this.texModEd = new TextureModifierEditor(this);

    /* 显示 */
    this.root.classList.remove('hidden');
    this.viewport.enabled = true;
    this.viewport.setRect();
    this.setMode(this.mode, true);
    this.setTab(this.tab);
    this.setLeftTab(this.leftTab);
    this.setRightTab(this.rightTab);
    this.titleEl && (this.titleEl.textContent = '洪梦编辑器 · ' + (level.name || '未命名'));
    this.showHint('中键拖动旋转视角 · WASD 飞行 · Q/E 升降 · Shift 加速 · 滚轮前后移动');

    /* 初始视角：聚焦「起点」（有指定起点就用它），没有起点时才取景全部 */
    this.builder.computeBounds();
    const spawns = level.objects.filter((o) => o.type === 'spawn');
    const fixedSpawn = level.settings && level.settings.spawnFixed;
    const spawn = (fixedSpawn && spawns.find((o) => o.id === fixedSpawn)) || spawns[0] || null;
    if (spawn) this.focusOn([spawn.id]);
    else {
      this.viewport.camera.position.set(60, 45, 60);
      this.viewport.look(0, 0);
      this.viewport.frame(this.builder.bounds, 1.25);
    }

    this.opened = true;
    setInfiniteDrag(true);
    // 异步预编译着色器：编辑器对象多，首帧集中编译会明显卡顿，放到加载后并行做
    this.engine.warmup(this.scene, this.viewport.camera);
    this.refreshPanels();
    this.flushPanels();          // 打开时立刻建好面板，不等下一帧
    this.paintEd.refresh();
    this.log('打开关卡「' + (level.name || '未命名') + '」，' + level.objects.length + ' 个对象', 'ok');
    const v = validateLevel(level);
    for (const w of v.warnings.slice(0, 4)) this.log('⚠ ' + w, 'w');
    for (const e of v.errors.slice(0, 4)) this.log('✕ ' + e, 'e');

    // 素材本地化（懒迁移）：把关卡引用到、但还在旧全局池里的素材拷进本关文件夹
    this._localizeAssets(level);
  }

  /** 把关卡引用到的素材拷进本关文件夹（换新 id + 改写引用），有改动就重建并静默落盘 */
  _localizeAssets(level) {
    localizeLevelAssets(level.id, level).then((r) => {
      if (!r.changed || this.level !== level) return;
      this.log('已本地化 ' + r.changed + ' 个素材（拷入关卡文件夹）', 'i');
      try { this.builder && this.builder.refreshAll(); } catch (e) { /* ignore */ }
      try { this.paint && this.paint.rebuildAll(); } catch (e) { /* ignore */ }
      try { this.applyLevelSettings(); } catch (e) { /* ignore */ }
      if (this.inspector) this.inspector.invalidateAssets();
      if (this.assetMgr) this.assetMgr.refresh();
      if (this.refreshTree) this.refreshTree();
      this.dirty = true;
      this.save(true);
    }).catch((e) => console.warn('[editor] 素材本地化失败', e));
  }

  /** 试玩前挂起（保留数据） */
  suspend() {
    setInfiniteDrag(false);
    // 编辑器里试听过的 BGM 也一起收掉：试玩会用会话自己的 BGM
    audio.stopMusic({ fade: 0.35 });
    this.root.classList.add('hidden');
    this.viewport.enabled = false;
    if (this.gizmo) this.gizmo.detach();
    if (this.nodeEd) this.nodeEd.hide();
    if (this.parkour) this.parkour.hide();
    closeMenu(); closePopover();
    this.paintEd && this.paintEd.setActive(false);
    this.modelEd && this.modelEd.setActive(false);
    this.stickerEd && this.stickerEd.setActive(false);
  }

  /** 试玩结束回到编辑器 */
  resume() {
    if (!this.level) return;
    this.root.classList.remove('hidden');
    setInfiniteDrag(true);
    this.viewport.enabled = true;
    this.viewport.setRect();
    this.engine.postfx.setProvider((out) => collectPostFX(this.level, out));
    this.engine.setScreenProvider(() => collectScreen(this.level));
    // 试玩会话销毁时会释放共用的场景反射贴图，这里必须强制重捕一次，
    // 否则天空没变会走「不必重新捕获」的短路，编辑器里带反射的材质会一直采样已释放的贴图
    this._applyEnvMap(true);
    this.gizmo && this.gizmo.attach(this.selectedRecs());
    this.refreshPanels();
    this.log('返回编辑器', 'i');
  }

  close() {
    this.suspend();
    this.opened = false;
    closeEaseWindow();
    closeCodeWindow();
    closeSkyLab();
    closeSkyModEditor();
    closeParticleEditor();
    closeNpcEditor();
    closeVectorEditor();
    if (this._panelRAF) {   // 取消未执行的面板刷新
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._panelRAF);
      else clearTimeout(this._panelRAF);
      this._panelRAF = 0;
    }
    this._treeDirty = false; this._propsDirty = false; this._selRowPending = undefined;
    this.engine.postfx.clear();
    this.engine.postfx.setVolumeFog(null);
    this.engine.setScreenProvider(null);
    this._envKey = null; this._envTex = null;
    if (this.nodeEd) { this.nodeEd.hide(); this.nodeEd = null; }
    if (this.parkour) { this.parkour.dispose(); this.parkour = null; }
    if (this.gizmo) { this.gizmo.dispose(); this.gizmo = null; }
    this._disposeScene();
    this.level = null;
    this.record0 = null;
    this.selection = new Set();
    store.setAssetScope(null);      // 出了编辑器就没有「当前关卡」了
  }

  _disposeScene() {
    try { disposeReflections(); } catch (e) { /* ignore */ }
    if (this.builder) { try { this.builder.dispose(); } catch (e) { /* ignore */ } this.builder = null; }
    if (this.paint) { try { this.paint.dispose(); } catch (e) { /* ignore */ } this.paint = null; }
    if (this.grid) {
      if (this.grid.parent) this.grid.parent.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
      this.grid = null;
    }
    this.scene = null;
    this.view.scene = null;
  }

  onResize() {
    // 编辑器不可见时（如试玩中）不要接管 canvas：此时 #ed-view 尺寸为 0，会把全屏视图压成 2px
    if (!this.opened) return;
    if (!this.root || this.root.classList.contains('hidden')) return;
    this.viewport.setRect();
  }

  /* ============================================================
     输入
     ============================================================ */
  _bindDom() {
    const root = this.root;
    if (!root) return;
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'undo') this.undo();
      else if (act === 'redo') this.redo();
      else if (act === 'save') this.save();
      else if (act === 'test') this.testPlay();
      else if (act === 'test-here') this.testHere();
      else if (act === 'exit') this.exit();
      else if (act === 'level-info') this.levelInfo();
      else if (act === 'group') this.groupSelection();
      else if (act === 'unparent') this.unparentSelection();
      else if (act === 'del') this.deleteSelection();
      else if (act === 'reset-prop') this.refreshProps(true);
      else if (act === 'layer-add') { this.edit('新建图层', () => { this.paint.addLayer(); }); this.refreshLayers(); }
      else if (act === 'layer-del') this.paintEd.removeActiveLayer();
      else if (act === 'texmod-open') openTexModEditor('');
    });
    // 底部页签
    const tabs = document.getElementById('ed-bot-tabs');
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const t = e.target.closest('[data-tab]');
        if (t) this.setTab(t.dataset.tab);
      });
    }
    // 左栏页签（属性 / 图层）
    const ltabs = document.getElementById('ed-left-tabs');
    if (ltabs) {
      ltabs.addEventListener('click', (e) => {
        const t = e.target.closest('[data-ltab]');
        if (t) this.setLeftTab(t.dataset.ltab);
      });
    }
    // 右栏页签（对象树 / 素材）
    const rtabs = document.getElementById('ed-right-tabs');
    if (rtabs) {
      rtabs.addEventListener('click', (e) => {
        const t = e.target.closest('[data-rtab]');
        if (t) this.setRightTab(t.dataset.rtab);
      });
    }
    this._bindResizers();
  }

  /** 面板拖拽：左右栏宽度 / 底部面板高度 */
  _bindResizers() {
    const mid = document.getElementById('ed-mid');
    const left = document.getElementById('ed-left');
    const right = document.getElementById('ed-right');
    const bottom = document.getElementById('ed-bottom');
    if (!mid || !left || !right || !bottom) return;
    for (const h of this.root.querySelectorAll('.ed-rs')) {
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const kind = h.dataset.rs;
        h.classList.add('on');
        h.setPointerCapture(e.pointerId);
        const x0 = e.clientX, y0 = e.clientY;
        const w0 = left.offsetWidth, w1 = right.offsetWidth, h0 = bottom.offsetHeight;
        const onMove = (ev) => {
          const maxSide = Math.max(160, mid.clientWidth - 320);
          if (kind === 'left') left.style.width = clamp(w0 + ev.clientX - x0, 160, maxSide) + 'px';
          else if (kind === 'right') right.style.width = clamp(w1 - ev.clientX + x0, 160, maxSide) + 'px';
          else bottom.style.height = clamp(h0 - ev.clientY + y0, 90, Math.round(window.innerHeight - 160)) + 'px';
          this.onResize();
        };
        const onUp = () => {
          h.classList.remove('on');
          h.removeEventListener('pointermove', onMove);
          h.removeEventListener('pointerup', onUp);
          h.removeEventListener('pointercancel', onUp);
          this.onResize();
        };
        h.addEventListener('pointermove', onMove);
        h.addEventListener('pointerup', onUp);
        h.addEventListener('pointercancel', onUp);
      });
    }
  }

  /** 左栏选项卡：props 属性 / layers 图层 / prefab 预制件 */
  setLeftTab(k) {
    const keys = ['props', 'layers', 'prefab'];
    this.leftTab = keys.includes(k) ? k : 'props';
    const ltabs = document.getElementById('ed-left-tabs');
    if (ltabs) for (const b of ltabs.querySelectorAll('[data-ltab]')) b.classList.toggle('on', b.dataset.ltab === this.leftTab);
    for (const key of keys) {
      const p = document.getElementById('pane-' + key);
      if (p) p.classList.toggle('hidden', this.leftTab !== key);
    }
    if (this.leftTab === 'layers') this.paintEd && this.paintEd.refresh();
    if (this.leftTab === 'prefab') this.prefabPanel && this.prefabPanel.refresh();
  }

  /** 右栏选项卡：outliner 对象树 / assets 素材库 */
  setRightTab(k) {
    this.rightTab = k === 'assets' ? 'assets' : 'outliner';
    const rtabs = document.getElementById('ed-right-tabs');
    if (rtabs) for (const b of rtabs.querySelectorAll('[data-rtab]')) b.classList.toggle('on', b.dataset.rtab === this.rightTab);
    for (const [key, id] of [['outliner', 'pane-outliner'], ['assets', 'pane-assets']]) {
      const p = document.getElementById(id);
      if (p) p.classList.toggle('hidden', this.rightTab !== key);
    }
    if (this.rightTab === 'assets') this.assetMgr && this.assetMgr.refresh();
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (!this.opened || this.app.state !== 'editor') return;
      if (currentScreen()) return;          // 有独立窗口盖在编辑器上（如贴图修改器）时不响应编辑器快捷键
      const t = e.target;
      const tag = (t && t.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (t && t.isContentEditable)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl) {
        switch (e.code) {
          case 'KeyZ': e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return;
          case 'KeyY': e.preventDefault(); this.redo(); return;
          case 'KeyS': e.preventDefault(); this.save(); return;
          case 'KeyC': e.preventDefault(); this.copySelection(); return;
          case 'KeyX': e.preventDefault(); this.cutSelection(); return;
          case 'KeyV': e.preventDefault(); this.pasteClipboard(); return;
          case 'KeyD': e.preventDefault(); this.duplicateSelection(); return;
          case 'KeyG': e.preventDefault(); this.groupSelection(); return;
          case 'KeyA':
            e.preventDefault();
            this.select(this.level.objects.map((o) => o.id));
            return;
          default: return;
        }
      }
      switch (e.code) {
        case 'Digit1': this.setMode('select'); break;
        case 'Digit2': this.setMode('translate'); break;
        case 'Digit3': this.setMode('rotate'); break;
        case 'Digit4': this.setMode('scale'); break;
        case 'Digit5': this.setMode('combo'); break;
        case 'KeyX': this.toggleSnap(); break;
        case 'Space':
          e.preventDefault();
          if (this.tab === 'anim' && this.animEd) this.animEd.togglePlay();
          else this.toggleSpace();
          break;
        case 'KeyF': if (this.selection.size) this.focusOn([...this.selection]); break;
        case 'KeyB':
          e.preventDefault();
          if (this.parkour && this.parkour.active) this.parkour.setActive(null);
          if (this.modelEd && this.modelEd.active) this.modelEd.setActive(false);
          if (this.stickerEd && this.stickerEd.active) this.stickerEd.setActive(false);
          this.paintEd.toggle();
          break;
        case 'KeyM':
          e.preventDefault();
          if (this.parkour && this.parkour.active) this.parkour.setActive(null);
          if (this.paintEd && this.paintEd.active) this.paintEd.setActive(false);
          if (this.stickerEd && this.stickerEd.active) this.stickerEd.setActive(false);
          if (this.modelEd) this.modelEd.toggle();
          break;
        case 'KeyP':
          e.preventDefault();
          if (this.parkour && this.parkour.active) this.parkour.setActive(null);
          if (this.paintEd && this.paintEd.active) this.paintEd.setActive(false);
          if (this.modelEd && this.modelEd.active) this.modelEd.setActive(false);
          if (this.stickerEd) this.stickerEd.toggle();
          break;
        case 'KeyJ': if (this.parkour) this.parkour.toggle('jump'); break;
        case 'KeyT': if (this.parkour) this.parkour.toggle('timing'); break;
        case 'KeyH': this.setVisible([...this.selection], !this._anyVisible()); break;
        case 'Delete': case 'Backspace': e.preventDefault(); this.deleteSelection(); break;
        case 'Escape':
          closeMenu(); closePopover();
          if (this.parkour && this.parkour.active) this.parkour.setActive(null);
          else if (this.stickerEd && this.stickerEd.active) this.stickerEd.setActive(false);
          else if (this.modelEd && this.modelEd.active) this.modelEd.setActive(false);
          else if (this.paintEd.active) this.paintEd.setActive(false);
          else if (this.selection.size) this.select([]);
          break;
        default: break;
      }
    });
  }

  _bindViewport() {
    const dom = this.viewDom;
    if (!dom) return;
    // 框选参考框
    this.marquee = el('div', { id: 'ed-marquee' });
    dom.appendChild(this.marquee);
    let down = null;
    let marquee = false;

    dom.addEventListener('pointerdown', (e) => {
      if (!this.opened || e.button !== 0) return;
      if (isOverlay(e.target)) return;      // 点在 3D 视图上的浮层按钮（变换工具等）：交给按钮
      if (this.parkour && this.parkour.active) { this.parkour.onDown(e); return; }
      if (this.stickerEd && this.stickerEd.active) { this.stickerEd.onDown(e); return; }
      if (this.gizmo && (this.gizmo.dragging || this.gizmo.tc.axis || this.gizmo.hoverFace)) return;
      if (this.paintEd && this.paintEd.active) return;
      if (this.modelEd && this.modelEd.active && this.modelEd.onDown(e)) {
        // 捕获指针：元素拖到视口外也能收到 pointermove / pointerup
        try { dom.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }
      if (this.nodeEd && this.nodeEd.beginDrag(e)) {
        // 捕获指针：拖到视口外也能收到 pointermove / pointerup
        try { dom.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }
      down = { x: e.clientX, y: e.clientY, rect: dom.getBoundingClientRect() };
      marquee = false;
      // 捕获指针：拖到视口外（面板上/窗口边缘）也不会丢事件，框选不会卡住
      try { dom.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    dom.addEventListener('pointermove', (e) => {
      if (this.parkour && this.parkour.active) { this.parkour.onMove(e); return; }
      if (this.stickerEd && this.stickerEd.active) { this.stickerEd.onMove(e); return; }
      if (this.modelEd && this.modelEd.active && this.modelEd.onMove(e)) return;
      if (this.nodeEd && this.nodeEd.dragging) { this.nodeEd.moveDrag(e); return; }
      if (!down || !this.opened) return;
      const dx = Math.abs(e.clientX - down.x);
      const dy = Math.abs(e.clientY - down.y);
      if (!marquee && dx + dy > 5) marquee = true;
      if (!marquee) return;
      const r = down.rect;
      const x1 = Math.min(down.x, e.clientX), y1 = Math.min(down.y, e.clientY);
      const x2 = Math.max(down.x, e.clientX), y2 = Math.max(down.y, e.clientY);
      Object.assign(this.marquee.style, {
        display: 'block',
        left: (x1 - r.left) + 'px', top: (y1 - r.top) + 'px',
        width: (x2 - x1) + 'px', height: (y2 - y1) + 'px',
      });
    });
    dom.addEventListener('pointerup', (e) => {
      if (this.parkour && this.parkour.active) { this.parkour.onUp(e); return; }
      if (this.stickerEd && this.stickerEd.active) { this.stickerEd.onUp(e); return; }
      if (this.modelEd && this.modelEd.active && this.modelEd.onUp(e)) return;
      if (this.nodeEd && this.nodeEd.dragging) { this.nodeEd.endDrag(); return; }
      if (!down) return;
      const start = down;
      const wasMarquee = marquee;
      down = null;
      this.marquee.style.display = 'none';
      if (this.paintEd && this.paintEd.active) return;
      if (wasMarquee) {
        const r = start.rect;
        const x1 = Math.min(start.x, e.clientX), y1 = Math.min(start.y, e.clientY);
        const x2 = Math.max(start.x, e.clientX), y2 = Math.max(start.y, e.clientY);
        // 建模模式：框选的是模型的点 / 边 / 面，不是对象
        if (this.modelEd && this.modelEd.active && this.modelEd.selectInRect(x1, y1, x2, y2, e.shiftKey)) return;
        const ids = [];
        const tmp = { x: 0, y: 0, z: 0 };
        for (const o of this.level.objects) {
          if (o.visible === false) continue;
          const p = worldPosition(this.level, o);
          this.viewport.screenPos(new THREE.Vector3(p[0], p[1], p[2]), tmp);
          if (tmp.x >= x1 && tmp.x <= x2 && tmp.y >= y1 && tmp.y <= y2) ids.push(o.id);
        }
        this.select(ids, e.shiftKey ? 'add' : 'set');
        return;
      }
      this.clickSelect(e.clientX, e.clientY, e.ctrlKey || e.metaKey, e.shiftKey);
    });
    dom.addEventListener('contextmenu', (e) => {
      if (!this.opened) return;
      e.preventDefault();
      if (this.parkour && this.parkour.active) { this.parkour.onContext(e); return; }
      if (this.stickerEd && this.stickerEd.active) { this.stickerEd.onContext(e); return; }
      if (this.paintEd && this.paintEd.active) return;
      const hit = this.viewport.pick(e.clientX, e.clientY, { helpers: true });
      if (hit && hit.rec) {
        if (!this.selection.has(hit.rec.id)) this.select([hit.rec.id]);
        this.objectMenu(e.clientX, e.clientY, hit.rec);
      } else {
        this.select([]);
        this.emptyMenu(e.clientX, e.clientY);
      }
    });
  }

  clickSelect(cx, cy, add, shift) {
    const hit = this.viewport.pick(cx, cy, { helpers: true });
    if (!hit || !hit.rec) { if (!add && !shift) this.select([]); return; }
    const id = hit.rec.id;
    if (add) this.select([id], 'toggle');
    else if (shift) this.select([id], 'add');
    else this.select([id]);
  }

  objectMenu(x, y, rec) {
    const ed = this;
    const ids = [...this.selection];
    const o = rec.o;
    contextMenu(x, y, [
      { label: ids.length > 1 ? ids.length + ' 个对象' : objectLabel(o) },
      // 多选时可直接跳到属性面板批量改公共属性
      ids.length > 1 ? { ico: '🎚', l: '批量修改属性 (' + ids.length + ')', fn: () => ed.setLeftTab('props') } : null,
      { ico: '⌖', l: '聚焦 (F)', fn: () => ed.focusOn(ids) },
      { ico: '⧉', l: '复制 (Ctrl+D)', fn: () => ed.duplicateSelection() },
      { ico: '✎', l: '重命名', fn: () => ed.renameSelection() },
      { sep: true },
      { ico: '⧉', l: '编组 (Ctrl+G)', fn: () => ed.groupSelection() },
      { ico: '↰', l: '移出编组', fn: () => ed.unparentSelection() },
      { ico: o.visible === false ? '👁' : '🚫', l: o.visible === false ? '显示' : '隐藏', fn: () => ed.setVisible(ids, o.visible === false) },
      { ico: '🔒', l: o.frozen ? '解除编辑锁定' : '锁定编辑', fn: () => ed.setFrozen(ids, !o.frozen) },
      { sep: true },
      { ico: '🎨', l: '以此为目标涂鸦 (B)', fn: () => { ed.paintEd.setActive(true); ed.paintEd.setTarget(rec.id); } },
      { sep: true },
      { ico: '◧', l: '实体运算（布尔 / 平滑融合）…', fn: () => { openBooleanDialog(ed); } },
      { ico: '⌒', l: '曲线围成岛屿…', fn: () => { openIslandDialog(ed); } },
      (rec.type === 'mesh' || rec.type === 'vec')
        ? { ico: '⬡', l: '转换为低模建模体', fn: () => { convertToPoly(ed, rec.id); } } : null,
      { sep: true },
      { ico: '🗑', l: '删除 (Del)', danger: true, fn: () => ed.deleteSelection() },
    ]);
  }

  emptyMenu(x, y) {
    const ed = this;
    contextMenu(x, y, [
      { label: '场景' },
      { ico: '▦', l: '在此处放置方块', fn: () => ed.creator.place('mesh', { shape: 'block' }) },
      { ico: '✧', l: '在此处放置低模建模体', fn: () => ed.creator.place('poly', {}) },
      { ico: '≈', l: '在此处放置液体', fn: () => ed.creator.place('liquid', {}) },
      { ico: '＋', l: '全部对象类型…', fn: () => ed.creator.picker(null) },
      { sep: true },
      { ico: '⌒', l: '曲线围成岛屿…', fn: () => { openIslandDialog(ed); } },
      { sep: true },
      { ico: '📋', l: '粘贴 (Ctrl+V)', fn: () => ed.pasteClipboard(), hint: ed.clipboard ? '' : '空' },
      { ico: '▣', l: '全选 (Ctrl+A)', fn: () => ed.select(ed.level.objects.map((o) => o.id)) },
      { ico: '⌖', l: '取景全部', fn: () => ed.viewport.frame(ed.builder.bounds, 1.25) },
      { sep: true },
      { ico: '📊', l: '关卡统计', fn: () => ed.showStats() },
    ]);
  }

  /* ============================================================
     模式 / 提示
     ============================================================ */
  setMode(mode, force) {
    if (mode !== 'select' && mode !== 'translate' && mode !== 'rotate' && mode !== 'scale' && mode !== 'combo') mode = 'translate';
    if (!force && this.mode === mode && this.gizmo && this.gizmo.mode === mode) return;
    this.mode = mode;
    if (this.gizmo) this.gizmo.setMode(mode);
    this._syncModeButtons();
    this.refreshPanels();
  }

  modeLabel() {
    const d = MODE_DEFS.find((m) => m.k === this.mode);
    return d ? d.l : this.mode;
  }

  toggleSpace() {
    this.space = this.space === 'world' ? 'local' : 'world';
    this.gizmo && this.gizmo.setSpace(this.space);
    this._syncModeButtons();
    toast(this.space === 'world' ? '世界坐标系' : '局部坐标系');
  }

  toggleSnap() {
    this.snapOn = !this.snapOn;
    this.gizmo && this.gizmo.setSnap(this.snapOn);
    this._syncModeButtons();
    toast(this.snapOn ? '吸附开启（移动 ' + EDITOR.snapMove + ' / 旋转 ' + EDITOR.snapRotate + '°）' : '吸附关闭');
  }

  _syncModeButtons() {
    const top = document.getElementById('ed-gizmo-bar-top');
    if (top) {
      clear(top);
      for (const m of MODE_DEFS) {
        top.appendChild(el('button', {
          class: this.mode === m.k ? 'on' : '', title: m.l + '（' + m.key.slice(-1) + '）',
          text: m.l, onclick: () => this.setMode(m.k),
        }));
      }
      top.appendChild(el('button', {
        class: this.space === 'local' ? 'on' : '', title: '切换坐标系（空格）',
        text: this.space === 'world' ? '世界' : '局部',
        onclick: () => this.toggleSpace(),
      }));
      top.appendChild(el('button', {
        class: this.snapOn ? 'on' : '', title: '轴向吸附（X）',
        text: this.snapOn ? '吸附' : '自由',
        onclick: () => this.toggleSnap(),
      }));
    }
    const bar = document.getElementById('ed-gizmo-bar');
    if (bar) {
      clear(bar);
      // 跑酷制造工具（编辑器辅助，不进关卡数据）
      const pk = this.parkour;
      bar.appendChild(el('button', {
        class: pk && pk.active === 'jump' ? 'on' : '', title: '跳跃（抛物线）验证器（J）',
        text: '跳跃验证', onclick: () => pk && pk.toggle('jump'),
      }));
      bar.appendChild(el('button', {
        class: pk && pk.active === 'timing' ? 'on' : '', title: '跑酷计时测量器（T）',
        text: '计时测量', onclick: () => pk && pk.toggle('timing'),
      }));
      // 低模建模模式：选中一个「低模建模体」后才能进（M）
      const me = this.modelEd;
      const okModel = !!(me && me.canStart());
      bar.appendChild(el('button', {
        class: (me && me.active ? 'on ' : '') + (okModel || (me && me.active) ? '' : 'dim'),
        title: okModel || (me && me.active)
          ? '低模建模：点 / 边 / 面选择 · 选边倒角 · 雕刻笔刷（M）'
          : '先选中一个「低模建模体」再按 M 进入建模模式',
        text: '建模', onclick: () => me && me.toggle(),
      }));
      // 程序化生成关卡：按难度 / 世界结构自动铺一条可通关的跑酷路线
      bar.appendChild(el('button', {
        class: '', title: '程序化生成关卡：按难度与世界结构自动铺设跑酷路线，并做可通关性自检',
        text: '生成关卡', onclick: () => openGeneratorDialog(this),
      }));
      // 天空工坊：程序化天空球生成 / 烘焙，产出等距柱状全景图当天空盒
      bar.appendChild(el('button', {
        class: '', title: '天空工坊：程序化天空球生成 / 烘焙（云 / 星空 / 大气 / 日月 / 图案 / 71 种纹理 shader / 真实光学），可导出全景图',
        text: '天空工坊', onclick: () => openSkyLab(this),
      }));
      // NPC 编辑器：独立悬浮窗，集中管理关卡里的角色（外观 / 行为 / 交互 / 对话）
      bar.appendChild(el('button', {
        class: '', title: 'NPC 编辑器：独立悬浮窗，管理角色的模型 / 跟随或巡逻行为 / 交互 / 多段对话',
        text: 'NPC 编辑器', onclick: () => openNpcEditor(this),
      }));
      // 高级矢量图编辑器：绘制 / 贝塞尔 / 布尔 / 倒角 / 图层，可导出 SVG、存素材、生成有厚度的模型
      bar.appendChild(el('button', {
        class: '', title: '高级矢量图编辑器：多选 / 贝塞尔 / 布尔运算 / 折角倒圆倒角 / 图层 / 颜色，可导出 SVG、存为素材、生成有厚度的「矢量挤出体」',
        text: '矢量图', onclick: () => this.openVectorEditor({ target: 'free' }),
      }));
      // 贴纸放置：把图片（导入即进素材库）直接贴到模型表面（P）
      const sk = this.stickerEd;
      bar.appendChild(el('button', {
        class: sk && sk.active ? 'on' : '',
        title: '贴纸放置：图片贴到模型表面（覆盖该区域粗糙度 / 法线，保留底层贴图）（P）',
        text: '贴纸', onclick: () => sk && sk.toggle(),
      }));
    }
    const vm = document.getElementById('vh-mode');
    const vs = document.getElementById('vh-space');
    const vn = document.getElementById('vh-snap');
    if (vm) vm.textContent = '组件：' + this.modeLabel();
    if (vs) vs.textContent = this.space === 'world' ? '世界系' : '局部系';
    if (vn) vn.textContent = this.snapOn ? '吸附开' : '吸附关';
  }

  showHint(text, ms = 7000) {
    const h = document.getElementById('ed-freefly-hint');
    if (!h) return;
    h.textContent = text;
    h.classList.remove('hidden');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => h.classList.add('hidden'), ms);
  }

  /* ============================================================
     选择
     ============================================================ */
  selectedRecs() {
    const out = [];
    if (!this.builder) return out;
    for (const id of this.selection) {
      const r = this.builder.objects.get(id);
      if (r) out.push(r);
    }
    return out;
  }

  select(ids, mode = 'set') {
    const next = new Set(mode === 'set' ? [] : this.selection);
    for (const id of ids || []) {
      if (!id) continue;
      if (mode === 'toggle') { if (next.has(id)) next.delete(id); else next.add(id); }
      else next.add(id);
    }
    this.selection = next;
    this._afterSelect();
  }

  _afterSelect() {
    const recs = this.selectedRecs().filter((r) => !r.o.frozen || r.o.frozen === false);
    if (this.gizmo) {
      if (this.mode === 'select') this.gizmo.detach();
      else this.gizmo.attach(recs);
    }
    this._selRowPending = [...this.selection][0] || null;   // 滚动到选中行：跟面板刷新一起做
    this.refreshTree();
    this.refreshProps();
    if (this.nodeEd) this.nodeEd.sync();   // 选中滑索时显示节点手柄
    if (this.modelEd) this.modelEd.sync(); // 建模模式：跟随选择重建点 / 边覆盖层
  }

  focusOn(ids) {
    const recs = [];
    for (const id of ids || []) {
      const r = this.builder && this.builder.objects.get(id);
      if (r) recs.push(r);
    }
    if (!recs.length) return;
    const box = selectionWorldBox(this.level, recs);
    this.viewport.frame(box, 1.4);
  }

  setVisible(ids, on) {
    if (!ids || !ids.length) return;
    const prev = this.snap();
    for (const id of ids) {
      const o = getObject(this.level, id);
      if (o) o.visible = !!on;
    }
    this.builder.refreshAll();
    this.paint.rebuildAll();
    this.record(on ? '显示对象' : '隐藏对象', prev, { tree: true });
    this.refreshProps();
  }

  setFrozen(ids, on) {
    if (!ids || !ids.length) return;
    const prev = this.snap();
    for (const id of ids) {
      const o = getObject(this.level, id);
      if (o) o.frozen = !!on;
    }
    this.record(on ? '锁定对象' : '解除锁定', prev, { tree: true });
    this._afterSelect();
  }

  _anyVisible() {
    for (const id of this.selection) {
      const o = getObject(this.level, id);
      if (o && o.visible !== false) return true;
    }
    return false;
  }

  /* ============================================================
     历史
     ============================================================ */
  snap() {
    if (!this.level) return null;
    try { return JSON.stringify(this.level); }
    catch (e) { return null; }
  }

  record(label, prev, opts = {}) {
    if (!prev) return;
    this.history.record(label, prev);
    this.dirty = true;
    // 关卡几何可能变了：跑酷计时器的落点图作废，下次重算时重扫
    if (this.parkour) this.parkour.invalidateNav();
    this.refreshHistoryButtons();
    if (opts.tree) this.refreshTree();
    if (opts.props) this.refreshProps();
  }

  edit(label, fn, opts = {}) {
    const prev = this.snap();
    try { fn(); } catch (e) { console.error('[editor] edit 失败', e); toast('操作失败：' + e.message, 'err'); return; }
    this.record(label, prev, opts);
  }

  undo() {
    if (!this.history.canUndo) { toast('没有可撤销的操作'); return; }
    const label = this.history.undoLabel;
    const cur = this.snap();
    const json = this.history.undo(cur);
    if (!json) return;
    this._restore(json);
    this.log('撤销：' + label, 'i');
  }

  redo() {
    if (!this.history.canRedo) { toast('没有可重做的操作'); return; }
    const label = this.history.redoLabel;
    const cur = this.snap();
    const json = this.history.redo(cur);
    if (!json) return;
    this._restore(json);
    this.log('重做：' + label, 'i');
  }

  _restore(json) {
    let data;
    try { data = JSON.parse(json); }
    catch (e) { toast('历史数据损坏', 'err'); return; }
    const lv = this.level;
    for (const k of Object.keys(lv)) delete lv[k];
    Object.assign(lv, data);
    // 丢弃已不存在的选择
    const alive = new Set(lv.objects.map((o) => o.id));
    for (const id of [...this.selection]) if (!alive.has(id)) this.selection.delete(id);
    this.paint.rebuildAll();
    this.builder.refreshAll();
    this.builder.computeBounds();
    this.builder.updateSunShadow();
    if (this.parkour) this.parkour.invalidateNav();
    if (this.eventsEd) this.eventsEd.refresh();
    if (this.animEd) this.animEd.refresh();
    this.refreshPanels();
    this.dirty = true;
    this.refreshHistoryButtons();
  }

  refreshHistoryButtons() {
    if (!this.root) return;
    const u = this.root.querySelector('[data-act="undo"]');
    const r = this.root.querySelector('[data-act="redo"]');
    if (u) { u.style.opacity = this.history.canUndo ? '1' : '.35'; u.title = this.history.canUndo ? '撤销：' + this.history.undoLabel + '（Ctrl+Z）' : '撤销'; }
    if (r) { r.style.opacity = this.history.canRedo ? '1' : '.35'; r.title = this.history.canRedo ? '重做：' + this.history.redoLabel + '（Ctrl+Y）' : '重做'; }
    const s = this.root.querySelector('[data-act="save"]');
    if (s) s.textContent = this.dirty ? '保存 •' : '保存';
  }

  /* ============================================================
     对象操作
     ============================================================ */
  spawn(type, over = {}) {
    if (!this.level) return null;
    const prev = this.snap();
    const o = createObject(type, over);
    this.level.objects.push(o);
    let rec = null;
    try {
      rec = this.builder.create(o);
      if (rec) this.builder.postCreate(rec);
    } catch (e) {
      console.error('[editor] 创建失败', e);
      this.level.objects.pop();
      toast('创建失败：' + e.message, 'err');
      return null;
    }
    this.builder.computeBounds();
    this.builder.updateSunShadow();
    this.record('创建 ' + typeDef(type).label, prev, { tree: true });
    this.select([o.id]);
    this.log('添加 ' + objectLabel(o) + ' @ ' + (o.position || []).map((v) => Math.round(v)).join(', '), 'ok');
    return o;
  }

  /**
   * 把「引用折曲线对象」解析出的路径烘焙进对象自身字段
   * —— 「路径来源」从「引用折曲线对象」切回「自身节点」时调用：
   * 烘焙结果与引用模式下的可见形状完全一致（已含被引用折曲线的整体变换），
   * 自身 position / rotation / scale 语义不变（仍由 applyPathTransform 施加）
   */
  bakeRefPath(o) {
    if (!o || !o.pathRef || !this.level) return false;
    // 此刻 o.pathSource 已经写成 'self'，临时切回 'curve' 才能解析出引用路径
    const p = resolvePath(Object.assign({}, o, { pathSource: 'curve' }), this.level);
    if (!p || !p.fromRef) return false;
    const v3 = (v) => [round(v.x, 4), round(v.y, 4), round(v.z, 4)];
    const h3 = (a) => [round(Number(a[0]) || 0, 4), round(Number(a[1]) || 0, 4), round(Number(a[2]) || 0, 4)];
    o.points = p.points.map(v3);
    o.segModes = (p.segModes || []).slice();
    o.handles = p.handles.map(([a, b]) => [h3(a), h3(b)]);
    return true;
  }

  /** 打开富文本编辑器（文字方块 / 公告板）：有改动就实时重建材质并记入撤销栈 */
  async openRichTextEditor(o) {
    if (!o) return;
    const rec = this.builder && this.builder.objects.get(o.id);
    if (!rec) return;
    const prev = this.snap();
    let changed = false;
    try {
      const mod = await import('./rich-text-editor.js');
      changed = await mod.openRichTextEditor(o);
    } catch (e) { console.warn('[editor] 富文本编辑器失败', e); return; }
    if (!changed) return;
    try { this.builder.syncMaterial(rec); } catch (e) { /* ignore */ }
    this.record('编辑富文本', prev, { props: true });
    this.log('编辑富文本', 'i');
  }

  /** 公告板：拖缩放轴后按 scale 反算宽 / 高，保证属性面板与渲染一致（scale 是唯一运行时真值） */
  _syncBillboardSize(recs) {
    for (const r of (recs || [])) {
      if (!r || r.type !== 'billboard' || !r.o) continue;
      const o = r.o;
      const s = Math.max(0.01, Number(o.sizeScale) || 1);
      o.width = Math.max(0.01, (Number(o.scale[0]) || 1) / s);
      o.height = Math.max(0.01, (Number(o.scale[1]) || 1) / s);
    }
  }

  /** 属性变更后的增量刷新 */
  applyPropChange(rec, key, before) {
    if (!this.builder || !rec) return;
    const b = this.builder;
    this.dirty = true;
    // 传送门轮廓（节点 / 段模式 / 手柄 / 平滑度）：只更新着色器 uniform，不进重建
    if (rec.type === 'portal'
      && (key === 'points' || key === 'segModes' || key === 'handles' || key === 'smooth')) {
      try { b.syncMaterial(rec); } catch (e) { /* ignore */ }
      return;
    }
    // 传送门形状预设 / 圆角 / 边数：按预设重排轮廓节点后再走重建
    if (rec.type === 'portal' && (key === 'shapePreset' || key === 'cornerRadius' || key === 'sides')) {
      const shape = portalPresetShape(rec.o.shapePreset, rec.o);
      if (shape) { rec.o.points = shape.points; rec.o.handles = shape.handles; rec.o.segModes = shape.segModes; }
    }
    if (REBUILD_KEYS.has(key)) {
      // 路径来源从「引用折曲线对象」切回「自身节点」：先把当前形状烘焙成自身节点，
      // 否则会露出对象里陈旧的节点坐标，导致手柄与可见曲线完全对不上
      if (key === 'pathSource' && before === 'curve' && rec.o.pathSource !== 'curve'
        && PATH_TYPES.has(rec.type)) this.bakeRefPath(rec.o);
      try {
        const fresh = b.rebuild(rec);
        if (fresh) {
          b.computeBounds();
          b.updateSunShadow();
          if (this.selection.has(fresh.id)) this.gizmo && this.gizmo.attach(this.selectedRecs());
          if (this.nodeEd) this.nodeEd.sync();   // 路径重建后刷新滑索节点手柄
        }
      } catch (e) { console.warn('[editor] 重建对象失败', e); }
      return;
    }
    if (MATERIAL_KEYS.has(key)) {
      try { b.syncMaterial(rec); } catch (e) { /* ignore */ }
      if (key === 'fillLevel' || key === 'flow') b.updateLiquidTransform(rec);
    }
    // 矢量挤出体：形状 / 厚度 / 倒角 / 倒角调制 / 尺寸任一变化都要重算挤出几何（实时预览）
    if (rec.type === 'vec' && VEC_GEO_KEYS.has(key)) {
      try { b.refreshGeometry(rec); } catch (e) { /* ignore */ }
    }
    // 文字方块：缩放改变长宽比 → 文字贴图要按新比例重画（实时预览）
    if (rec.type === 'textblock' && key === 'scale') {
      try { b.syncMaterial(rec); } catch (e) { /* ignore */ }
    }
    // 公告板尺寸：宽 / 高 / UIScale 与 scale 互为镜像（scale 是唯一运行时真值）
    if (rec.type === 'billboard') {
      const o = rec.o;
      const s = Math.max(0.01, Number(o.sizeScale) || 1);
      if (key === 'width' || key === 'height' || key === 'sizeScale') {
        o.width = Math.max(0.01, Number(o.width) || 6);
        o.height = Math.max(0.01, Number(o.height) || 3);
        o.scale = [o.width * s, o.height * s, 1];
      } else if (key === 'scale') {
        o.width = Math.max(0.01, (Number(o.scale[0]) || 1) / s);
        o.height = Math.max(0.01, (Number(o.scale[1]) || 1) / s);
      }
      if (key === 'width' || key === 'height' || key === 'sizeScale' || key === 'scale') {
        try { b.syncMaterial(rec); } catch (e) { /* ignore */ }
      }
    }
    // 首次给对象套用高级材质：打开关卡时若全关没有高级材质会跳过场景反射捕获，这里补做一次
    if (key === 'advMat' && rec.o.advMat && rec.o.advMat !== 'none' && !getReflectionTexture()) {
      try { b.captureReflection(this.engine.renderer); b.syncMaterial(rec); } catch (e) { /* ignore */ }
    }
    try { b.syncTransform(rec); } catch (e) { /* ignore */ }
    if (key === 'position' || key === 'rotation' || key === 'scale') this.gizmo && this.gizmo.update();
    void before;
  }

  afterPropEdit(rec, key) {
    this.dirty = true;
    if (key === 'name' || key === 'visible' || key === 'frozen' || key === 'shape' || key === 'kind') {
      this.refreshTree();
      if (key === 'visible') { this.builder.refreshAll(); this.paint.rebuildAll(); }
    }
    if (rec && rec.type === 'light') this.builder.syncMaterial(rec);
    // 高级材质：选中预设会连带改掉颜色 / 粗糙度 / 自发光等，面板要整体重画
    if (key === 'advMat') this.refreshProps();
    // 水纹风格 / 使用预制外观：会连带改掉颜色、透明度、泡沫等，面板整体重画
    if (key === 'liquidStyle' || key === 'usePresetLook') this.refreshProps();
    // 路径来源 / 截面形状 / 分布方式：会连带改掉别的属性，面板整体重画
    if (key === 'pathSource' || key === 'section' || key === 'distMode') this.refreshProps();
    // 传送门形状预设 / 圆角 / 边数：会重排轮廓节点，节点列表重画
    if (rec && rec.type === 'portal' && (key === 'shapePreset' || key === 'cornerRadius' || key === 'sides')) {
      this.refreshProps();
      if (this.nodeEd) this.nodeEd.sync();
    }
    this.gizmo && this.gizmo.update();
    this.refreshHistoryButtons();
  }

  /**
   * 环境反射（IBL）：按「环境反射 / 天空盒」设置构建 PMREM 环境贴图。
   * PMREM 结果由引擎按天空贴图缓存，重复调用（每次打开编辑器）几乎零开销；
   * 一次性场景反射捕获只在关卡确实用到高级材质时才做（见 builder.captureReflection）。
   */
  _applyEnvMap(force) {
    const b = this.builder;
    if (!b || !this.scene) return;
    const s = this.level.settings || {};
    const envAmp = clamp(Number(s.env ?? 1), 0, 1);
    setEnvIntensity(envAmp);                                // 0 = 关闭反射，1 = 最强
    const key = envAmp > 0 ? String(s.sky || 'dream') : '';
    const tex = key ? resolveSkyTexture(key) : null;
    const same = key === this._envKey && tex === this._envTex;
    this._envKey = key;
    this._envTex = tex;
    const env = tex ? this.engine.buildEnv(tex) : null;   // 命中缓存时无开销
    this.scene.environment = env && env.isTexture ? env : null;
    if (same && !force) return;                            // 天空没变，不必重新捕获场景反射
    b.captureReflection(this.engine.renderer);
  }

  applyLevelSettings() {
    if (!this.builder) return;
    const b = this.builder;
    b.applyEnv();               // 光照 / 雾 / 天空都是就地更新参数，不会重建灯光
    this._applyEnvMap();        // 天空 / 环境反射开关的实时反馈
    // 重力倍率：物理世界立即生效（不需要重开关卡）
    if (b.world) b.world.gravity.y = -PHYS.gravity * (this.level.settings.gravityScale || 1);
    this.dirty = true;
  }

  syncObject(rec) {
    if (!this.builder || !rec) return;
    this.builder.syncTransform(rec);
    this.builder.syncMaterial(rec);
  }

  /**
   * 换父级后把对象的世界位姿换算到新父级空间（before = 换之前的对象坐标系世界矩阵）。
   * 子级的世界位置 / 朝向保持不变 → 不会因为「减去父级 offset」而乱跑。
   * 尺寸（scale）是对象自身的长宽高，不参与继承，因此保持不动。
   */
  _keepWorldPose(o, before, parentObj) {
    const m = new THREE.Matrix4();
    if (parentObj) m.copy(objectFrame(this.level, parentObj)).invert();
    m.multiply(before);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    m.decompose(pos, quat, scl);
    _frE.setFromQuaternion(quat, 'XYZ');
    o.position = [round(pos.x), round(pos.y), round(pos.z)];
    o.rotation = [
      round(THREE.MathUtils.radToDeg(_frE.x)),
      round(THREE.MathUtils.radToDeg(_frE.y)),
      round(THREE.MathUtils.radToDeg(_frE.z)),
    ];
  }

  reparent(id, parentId) {
    const o = getObject(this.level, id);
    if (!o) return;
    if ((o.parent || null) === (parentId || null)) return;
    const prev = this.snap();
    const before = objectFrame(this.level, o);
    if (!reparentObject(this.level, id, parentId)) { toast('不能形成循环父子关系', 'err'); return; }
    this._keepWorldPose(o, before, parentId ? getObject(this.level, parentId) : null);
    this.builder.refreshAll();
    this.paint.rebuildAll();
    this.record('调整层级', prev, { tree: true });
    this._afterSelect();
    this.log((parentId ? '移入父级：' : '移出父级：') + objectLabel(o), 'i');
  }

  async renameSelection() {
    const ids = [...this.selection];
    if (!ids.length) { toast('先选中对象'); return; }
    const first = getObject(this.level, ids[0]);
    const name = await promptBox('名称', first ? (first.name || '') : '', { title: '重命名' });
    if (name === null) return;
    const prev = this.snap();
    ids.forEach((id, i) => {
      const o = getObject(this.level, id);
      if (!o) return;
      o.name = ids.length > 1 && name ? name + ' ' + (i + 1) : name;
    });
    this.record('重命名', prev, { tree: true, props: true });
  }

  duplicateSelection() {
    const ids = [...this.selection];
    if (!ids.length) { toast('先选中对象'); return; }
    const prev = this.snap();
    const copies = duplicateObjects(this.level, ids, [0, 0, 0]);
    if (!copies.length) return;
    this.builder.refreshAll();
    this.paint.rebuildAll();
    this.record('复制对象', prev, { tree: true });
    this.select(copies.map((c) => c.id));
    this.log('复制了 ' + copies.length + ' 个对象', 'ok');
  }

  copySelection() {
    const ids = [...this.selection];
    if (!ids.length) { toast('先选中对象'); return; }
    this.clipboard = copyObjects(this.level, ids);
    toast('已复制 ' + ids.length + ' 个对象');
    this.log('复制 ' + ids.length + ' 个对象到剪贴板', 'i');
  }

  cutSelection() {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.clipboard = copyObjects(this.level, ids);
    this.deleteSelection(true);
    toast('已剪切 ' + ids.length + ' 个对象');
  }

  pasteClipboard() {
    if (!this.clipboard) { toast('剪贴板是空的'); return; }
    const d = this.snapOn ? EDITOR.snapMove * 2 : 4;
    const prev = this.snap();
    const copies = pasteObjects(this.level, this.clipboard, [d, 0, d], null);
    if (!copies.length) return;
    this.builder.refreshAll();
    this.paint.rebuildAll();
    this.record('粘贴对象', prev, { tree: true });
    this.select(copies.map((c) => c.id));
    this.log('粘贴了 ' + copies.length + ' 个对象', 'ok');
  }

  groupSelection() {
    const ids = [...this.selection];
    if (!ids.length) { toast('先选中对象'); return; }
    const prev = this.snap();
    // 中心取「对象坐标系」的世界位置：父级带旋转时也和视口里看到的位置一致
    const pts = ids.map((id) => objectFrame(this.level, getObject(this.level, id)).getPosition(new THREE.Vector3()));
    const c = [0, 1, 2].map((k) => round(pts.reduce((a, p) => a + p.getComponent(k), 0) / Math.max(1, pts.length), 2));
    const g = createObject('group', { name: '编组 ' + (this.level.objects.filter((o) => o.type === 'group').length + 1) });
    g.position = c;
    g.rotation = [0, 0, 0];
    this.level.objects.push(g);
    for (let i = 0; i < ids.length; i++) {
      const o = getObject(this.level, ids[i]);
      if (!o) continue;
      const before = objectFrame(this.level, o);
      o.parent = g.id;
      this._keepWorldPose(o, before, g);      // 位置 + 朝向一起补偿，编组后物体不回跳
    }
    this.builder.refreshAll();
    this.paint.rebuildAll();
    this.record('编组', prev, { tree: true });
    this.select([g.id]);
    this.log('把 ' + ids.length + ' 个对象编入新组', 'ok');
  }

  unparentSelection() {
    const ids = [...this.selection].filter((id) => {
      const o = getObject(this.level, id);
      return o && o.parent;
    });
    if (!ids.length) { toast('选中的对象没有父级'); return; }
    const prev = this.snap();
    for (const id of ids) {
      const o = getObject(this.level, id);
      if (!o) continue;
      const before = objectFrame(this.level, o);
      o.parent = null;
      this._keepWorldPose(o, before, null);
    }
    this.builder.refreshAll();
    this.paint.rebuildAll();
    this.record('移出父级', prev, { tree: true });
    this._afterSelect();
  }

  async deleteSelection(force) {
    const ids = [...this.selection];
    if (!ids.length) { toast('先选中对象'); return; }
    if (!force && ids.length > 8) {
      const ok = await confirmBox('确定删除这 ' + ids.length + ' 个对象吗？', { danger: true, ok: '删除' });
      if (!ok) return;
    }
    const prev = this.snap();
    let n = 0;
    for (const id of ids) n += removeObjectTree(this.level, id);
    this.builder.refreshAll();
    this.paint.rebuildAll();
    this.selection = new Set();
    this.record('删除对象', prev, { tree: true });
    this._afterSelect();
    this.log('删除 ' + n + ' 个对象（Ctrl+Z 可撤销）', 'w');
  }

  /* ============================================================
     面板刷新
     一次操作往往连着触发 2~4 次全量重建（对象树 / 属性面板），而 800 个对象时
     单次重建就有几十毫秒。这里统一「标脏 + 下一帧合并刷新」：
     同一帧内的多次请求只重建一次，操作手感明显更跟手。
     ============================================================ */
  _scheduleRefresh(kind) {
    if (kind === 'tree') this._treeDirty = true;
    else this._propsDirty = true;
    if (this._panelRAF) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame : (f) => setTimeout(f, 0);
    this._panelRAF = raf(() => { this._panelRAF = 0; this._flushRefresh(); });
  }

  _flushRefresh() {
    if (this._treeDirty) {
      this._treeDirty = false;
      this.outliner && this.outliner.refresh();
      if (this._selRowPending !== undefined && this.outliner) {
        this.outliner.selectRow(this._selRowPending);
        this._selRowPending = undefined;
      }
    } else if (this._selRowPending !== undefined && this.outliner) {
      this.outliner.selectRow(this._selRowPending);
      this._selRowPending = undefined;
    }
    if (this._propsDirty) {
      this._propsDirty = false;
      this.inspector && this.inspector.refresh();
    }
  }

  /** 立即刷新（同步）：需要马上拿到新 DOM 的场合用（如打开关卡） */
  flushPanels() {
    if (this._panelRAF) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._panelRAF);
      else clearTimeout(this._panelRAF);
      this._panelRAF = 0;
    }
    this._flushRefresh();
  }

  refreshTree() { this._scheduleRefresh('tree'); }
  refreshProps(force) {
    if (force) this.inspector && (this.inspector.collapsed = new Set());
    this._scheduleRefresh('props');
  }
  refreshPropsSoft() {
    if (!this.inspector) return;
    clearTimeout(this._propT);
    this._propT = setTimeout(() => this.inspector.refresh(), 220);
  }
  refreshLayers() { this.paintEd && this.paintEd.refresh(); }
  refreshPanels() {
    this.refreshTree();
    this.refreshProps();
    this.refreshHistoryButtons();
    this._syncModeButtons();
    if (this.nodeEd) this.nodeEd.sync();
    if (this.modelEd) this.modelEd.sync();
  }

  /* ============================================================
     曲线截面编辑器（弹窗 · 2D 折线画布）
     ============================================================ */
  openSectionEditor(o) {
    if (!o) return null;
    return openSectionEditor(this, o);
  }

  /* ============================================================
     高级 2D 矢量图编辑器（浮窗）
     target: 'free' | 'pipe' | 'portal'
     ============================================================ */
  openVectorEditor(opts = {}) {
    return openVectorEditor(this, opts);
  }
  closeVectorEditor() {
    closeVectorEditor();
  }

  paintInfo(id) {
    if (!this.paint) return '涂鸦：—';
    const arr = this.level.paints || [];
    if (id) {
      const layers = new Set(arr.filter((p) => p.objectId === id).map((p) => p.layerId));
      const strokes = arr.filter((p) => p.objectId === id).reduce((a, p) => a + p.strokes.length, 0);
      return strokes ? '涂鸦：' + layers.size + ' 图层 · ' + strokes + ' 笔' : '涂鸦：无';
    }
    const strokes = arr.reduce((a, p) => a + p.strokes.length, 0);
    return '涂鸦总计：' + arr.length + ' 个对象 · ' + strokes + ' 笔 · ' + (this.level.paintLayers || []).length + ' 图层';
  }

  clearPaint(id) {
    if (!this.paint) return;
    const prev = this.snap();
    if (id) this.paint.clearObject(id, null);
    else {
      for (const s of [...this.paint.surfaces.keys()]) this.paint.clearObject(s, null);
      this.level.paints = [];
    }
    this.paint.rebuildAll();
    this.builder.refreshAll();
    this.record('清空涂鸦', prev, { props: true });
    toast('已清空涂鸦');
  }

  showStats() {
    const st = levelStats(this.level);
    const v = validateLevel(this.level);
    const rows = [
      ['对象总数', st.objects],
      ['网格 / 液体 / 灯光', st.meshes + ' / ' + st.liquids + ' / ' + st.lights],
      ['工具 / 触发器', (st.tools || 0) + ' / ' + (st.byType.trigger || 0)],
      ['事件 / 动画', st.events + ' / ' + st.animations],
      ['液体总体积', st.liquidVolume + ' stud³'],
      ['涂鸦', this.paintInfo(null)],
      ['存档大小', Math.round(JSON.stringify(this.level).length / 1024) + ' KB'],
    ];
    const body = el('div', {});
    const tb = el('table', { style: { width: '100%', fontSize: 'calc(12.5px * var(--ui-s) * var(--ui-fs))', borderCollapse: 'collapse' } });
    for (const [k, val] of rows) {
      tb.appendChild(el('tr', {},
        el('td', { style: { color: 'var(--ink-faint)', padding: '4px 6px' }, text: k }),
        el('td', { style: { padding: '4px 6px' }, text: String(val) })));
    }
    body.appendChild(tb);
    if (v.errors.length || v.warnings.length) {
      body.appendChild(el('div', { style: { marginTop: '10px', fontSize: 'calc(12px * var(--ui-s) * var(--ui-fs))', color: 'var(--acc3)', lineHeight: '1.8' } },
        [...v.errors.map((x) => '✕ ' + x), ...v.warnings.map((x) => '⚠ ' + x)].join('\n')));
    }
    modal({ title: '关卡统计', body, buttons: [{ label: '知道了', value: true, cls: 'primary' }] });
  }

  log(text, kind = 'i') {
    const time = new Date();
    this.logs.push({
      t: time.toTimeString().slice(0, 8),
      text: String(text),
      kind,
    });
    if (this.logs.length > 400) this.logs.shift();
    if (kind === 'e') console.warn('[editor]', text);
    if (this.tab === 'console') this._renderLogs();
  }

  _renderLogs() {
    if (!this.consoleEl) return;
    clear(this.consoleEl);
    for (const r of this.logs) {
      this.consoleEl.appendChild(el('div', { class: r.kind === 'e' ? 'e' : r.kind === 'w' ? 'w' : r.kind === 'ok' ? 't' : 'i', text: r.t + '  ' + r.text }));
    }
    this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
  }

  /* ============================================================
     页签
     ============================================================ */
  setTab(k) {
    this.tab = k;
    const tabs = document.getElementById('ed-bot-tabs');
    if (tabs) {
      for (const b of tabs.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === k);
    }
    const body = this.botBody;
    if (!body) return;
    const map = {
      events: this.eventsEd && this.eventsEd.el,
      anim: this.animEd && this.animEd.el,
      packs: this.packEd && this.packEd.el,
      console: this.consoleEl,
    };
    for (const key in map) {
      const n = map[key];
      if (!n) continue;
      if (n.parentNode !== body) body.appendChild(n);
      n.classList.toggle('hidden', key !== k);
    }
    const def = TABS.find((t) => t.k === k);
    if (this.botHint) this.botHint.textContent = def ? def.hint : '';
    if (k === 'console') this._renderLogs();
    if (k === 'events' && this.eventsEd) this.eventsEd.onShow();
    if (k === 'anim' && this.animEd) this.animEd.onShow();
    if (k === 'packs' && this.packEd) this.packEd.onShow();
    if (k !== 'anim') closeEaseWindow();   // 缓动曲线窗口只在动画页签内有效
    if (k !== 'events') closeCodeWindow(); // 代码编辑器窗口只在事件页签内有效
  }

  /* ============================================================
     存盘 / 试玩 / 退出
     ============================================================ */
  _thumb() {
    try {
      const r = this.engine.renderer;
      r.render(this.scene, this.viewport.camera);
      const src = r.domElement;
      const w = 320, h = Math.max(2, Math.round(320 * src.height / Math.max(1, src.width)));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(src, 0, 0, w, h);
      const url = c.toDataURL('image/jpeg', 0.6);
      return url.length > 120000 ? null : url;
    } catch (e) { return null; }
  }

  async save(silent) {
    if (!this.level) return false;
    try {
      // 兜底：确保引用到的素材都在本关文件夹里（打开关卡时通常已本地化）
      const loc = await localizeLevelAssets(this.level.id, this.level);
      if (loc.changed) {
        try { this.builder && this.builder.refreshAll(); } catch (e) { /* ignore */ }
        if (this.inspector) this.inspector.invalidateAssets();
        if (this.assetMgr) this.assetMgr.refresh();
      }
      await store.saveLevel({
        id: this.level.id,
        name: this.level.name,
        author: this.level.author,
        description: this.level.description,
        difficulty: this.level.difficulty,
        // 包内关卡必须保留归属，否则编辑一次就「漏」回单关卡选关列表
        packId: (this.record0 && this.record0.packId) || this.level.packId || '',
        data: JSON.parse(JSON.stringify(this.level)),
        thumb: silent ? (this.record0 && this.record0.thumb) || null : this._thumb(),
        created: (this.record0 && this.record0.created) || undefined,
      });
      this.dirty = false;
      this.refreshHistoryButtons();
      if (!silent) toast('已保存「' + this.level.name + '」', 'ok');
      this.log('保存关卡（' + Math.round(JSON.stringify(this.level).length / 1024) + ' KB）', 'ok');
      return true;
    } catch (e) {
      console.error('[editor] 保存失败', e);
      toast('保存失败：' + (e && e.message ? e.message : e), 'err', 3600);
      this.log('保存失败：' + e.message, 'e');
      return false;
    }
  }

  /** 试玩（spawn 为「在此处测试」指定的出生点 [x,y,z]，省略则用关卡出生点） */
  async testPlay(spawn) {
    if (!this.level) return;
    if (settings.get('misc.autosaveEditor', true)) await this.save(true);
    this.log(spawn ? '在此处试玩' : '开始试玩', 'i');
    this.suspend();
    this.app.startTest(this.level, spawn);
  }

  /** 「在此处测试」：以选中对象顶部为出生点试玩；未选中则取视口中心射线的落点 */
  testHere() {
    if (!this.level) return;
    this.testPlay(this._testSpawnPoint());
  }

  _testSpawnPoint() {
    const recs = this.selectedRecs();
    if (recs.length) {
      const box = selectionWorldBox(this.level, recs);
      if (!box.isEmpty()) {
        const c = box.getCenter(new THREE.Vector3());
        return [round(c.x, 2), round(box.max.y, 2), round(c.z, 2)];
      }
    }
    // 没选中：射线打到的那个面，其次视口中心正下方的 y=0 平面
    const vp = this.viewport;
    if (!vp) return null;
    const r = vp.dom
      ? vp.dom.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    try {
      const hit = vp.pick(cx, cy);
      if (hit && hit.point) return [round(hit.point.x, 2), round(hit.point.y, 2), round(hit.point.z, 2)];
    } catch (e) { /* ignore */ }
    const g = vp.ground(cx, cy, 0);
    return g ? [round(g.x, 2), 0, round(g.z, 2)] : null;
  }

  async exit() {
    if (this.dirty) {
      const ok = await confirmBox('还有未保存的修改，确定离开编辑器吗？', { danger: true, ok: '放弃修改并离开', cancel: '留在这里' });
      if (!ok) return;
    }
    hideScreens();
    this.app.exitEditor();
  }

  async levelInfo() {
    const lv = this.level;
    const v = await formBox('关卡信息', [
      { k: 'name', l: '关卡名', d: lv.name },
      { k: 'author', l: '作者', d: lv.author },
      { k: 'difficulty', l: '难度 (0.5–9.99)', t: 'num', d: lv.difficulty, st: 0.1, min: 0.5, max: 9.99 },
      { k: 'description', l: '描述', t: 'textarea', d: lv.description },
    ], { ok: '保存' });
    if (!v) return;
    this.edit('关卡信息', () => {
      lv.name = sanitizeName(v.name, '未命名关卡');
      lv.author = String(v.author || '玩家').slice(0, 40);
      lv.difficulty = clamp(Number(v.difficulty) || 1, 0.5, 9.99);
      lv.description = String(v.description || '').slice(0, 600);
    }, { props: true });
    this.titleEl && (this.titleEl.textContent = '洪梦编辑器 · ' + lv.name);
    toast('已更新关卡信息');
  }

  /* ============================================================
     每帧
     ============================================================ */
  update(dt) {
    if (!this.opened) return;
    this.viewport.update(dt);
    if (this.builder) this.builder.update(dt, this.view.camera);
    if (this.paint) this.paint.flush();
    if (this.gizmo && !this.gizmo.dragging && this.mode !== 'select') this.gizmo.update();
    if (this.paintEd && this.paintEd.active) this.paintEd.update(dt);
    if (this.stickerEd && this.stickerEd.active) this.stickerEd.update(dt);
    if (this.parkour && this.parkour.active) this.parkour.update(dt);
    const ne = npcEditor();
    if (ne) ne.update(dt);

    this._hudT -= dt;
    if (this._hudT <= 0) {
      this._hudT = 0.3;
      const st = this.engine.stats;
      const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
      set('vh-fps', st.fps + ' fps');
      set('vh-tris', (st.tris / 1000).toFixed(0) + 'k tri');
      const p = this.viewport.camera.position;
      set('vh-cam', p.x.toFixed(0) + ', ' + p.y.toFixed(0) + ', ' + p.z.toFixed(0));
    }
  }
}