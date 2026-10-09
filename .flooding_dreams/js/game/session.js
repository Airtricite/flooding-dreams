/* ============================================================
   关卡会话：把构建器 / 玩家 / 液体 / 机关 / 事件 / 动画 / 特效装配成可玩场景
   —— 大厅、游戏、编辑器试玩都复用这一层
   ============================================================ */
import * as THREE from 'three';
import { PLAYER, PHYS, diffOf } from '../config.js';
import { clamp, damp, round } from '../core/util.js';
import { settings } from '../core/settings.js';
import { audio } from '../core/audio.js';
import { store } from '../core/storage.js';
import { makeCamera } from '../core/engine.js';
import { resolveSkyTexture } from '../core/textures.js';
import { collectPostFX } from '../core/postfx.js';
import { collectScreen, BASE_EXPOSURE } from '../core/exposure.js';
import { buildLevel } from '../world/builder.js';
import { setEnvIntensity } from '../core/materials.js';
import { disposeReflections, renderGlassCapture } from '../world/advanced-materials.js';
import { FX } from '../world/fx.js';
import { LiquidSystem } from '../world/liquids.js';
import { Mechanisms } from '../world/mechanisms.js';
import { EventRuntime } from '../world/events.js';
import { AnimationSystem } from '../world/animations.js';
import { NpcSystem } from './npc-system.js';
import { PaintManager } from '../world/paint.js';
import { worldPosition } from '../world/level.js';
import { Player } from '../player/player.js';
import { PlayerCamera } from '../player/camera.js';
import { ActionRecorder } from './replay.js';
import { normalizeModifier, modifierText, modifierActive } from './modifier.js';
import { progressKey } from '../levels/packs.js';

const RESPAWN_DELAY = 1.15;

export class LevelSession {
  /**
   * @param {object} opts
   *   engine   引擎实例（取 renderer / 画质）
   *   level    关卡数据（会被规范化过）
   *   input    输入系统（编辑器试玩/游戏）
   *   paint    可选：外部传入的 PaintManager（编辑器复用同一份）
   *   hooks    { onWin, onFail, onDeath, onRespawn, onHint, onBanner, onPickup, onEvent }
   */
  constructor(opts = {}) {
    this.engine = opts.engine || null;
    this.level = opts.level;
    this.input = opts.input || null;
    this.hooks = opts.hooks || {};
    this.isHall = !!opts.hall;
    // 从关卡包节点进来的游玩：成绩存进「包 id + 关卡 id」的复合键，与单关卡成绩互不影响
    this.packId = opts.packId || '';
    this.progressId = progressKey(this.packId, this.level.id);

    const L = this.level;
    this.status = 'playing';         // playing | won | failed
    this.time = 0;
    this.deaths = 0;
    this.deathLimit = Math.max(0, Number(L.settings.deathLimit) || 0);
    this.timeLimit = Math.max(0, Number(L.settings.timeLimit) || 0);
    this.started = false;
    this.respawnTimer = 0;
    this.banner = null;
    this.bannerTimer = 0;
    this.hint = null;
    this.hintTimer = 0;
    this.underTint = 0;
    /* ---------- 游玩记录仪 / 回放 ---------- */
    this.recorder = null;            // ActionRecorder：正式游玩时按 15Hz 采样玩家行动
    this.replay = null;              // ReplayPlayer：接管本会话（回放 / 混剪），关卡照常模拟
    this._recStopTimer = null;       // 胜负后继续录一小段收尾再落盘
    this._recInfo = { win: false, winAt: 0, reason: '', deaths: 0, time: 0 };
    this._recSaved = false;
    // 开局倒数：加载完成后先倒数若干秒（显示在屏幕上），倒数结束才开始计时 / 触发事件。
    // 大厅不算正式游玩，不倒计时（opts.hall）。
    this.countdown = opts.hall ? 0 : Math.max(0, Number(opts.countdown != null ? opts.countdown : 3));

    // 地图变体（MapModifier）：mirror = 渲染层整张地图左右镜像；time = 整个世界的时间流速
    // （回放只继承镜像，时间变体由 ReplayPlayer 自己的播放倍速决定）
    this.modifiers = normalizeModifier(opts.modifiers);
    this.mirror = !!this.modifiers.mirror;
    this.timeScale = this.modifiers.time || 1;
    this.renderCam = null;           // 镜像模式下的出图相机（见 _syncMirrorCamera）

    /* ---------- 场景 ---------- */
    this.scene = new THREE.Scene();
    this.scene.name = 'level:' + L.id;
    this.camera = makeCamera(settings.get('camera.fov', 78), 0.12, 8000);

    this.paint = opts.paint || new PaintManager(L, {});
    // 贴图与外部模型（.glb/.gltf）分别并发加载：进度合并成一条（加载界面只显示一个进度条）
    this._loadStats = { tex: { d: 0, t: 0 }, mdl: { d: 0, t: 0 } };
    const onProgress = (kind) => (done, total) => {
      const s = this._loadStats[kind];
      s.d = done; s.t = total;
      if (opts.onLoadProgress) {
        try { opts.onLoadProgress(this._loadStats.tex.d + this._loadStats.mdl.d,
          this._loadStats.tex.t + this._loadStats.mdl.t); } catch (e) { /* ignore */ }
      }
    };
    this.builder = buildLevel(L, {
      scene: this.scene,
      physics: true,
      editor: false,
      paintHas: (id) => this.paint.has(id),
      // 导入的图片素材加载完成后再合成一次涂鸦画布：重进关卡时画布底图才不会是空的
      onTexturesReady: () => { if (this.paint) this.paint.rebuildAll(); },
      onTextureProgress: onProgress('tex'),
      onModelProgress: onProgress('mdl'),
      // 对象位姿被写过 → 推渲染热通道（渲染 Worker 模式生效；进程内为空实现）
      onHot: (obj, recursive) => { if (this.engine) this.engine.hot(obj, recursive); },
      onState: (obj) => { if (this.engine) this.engine.hotState(obj); },
      onAdd: (obj) => { if (this.engine) this.engine.addObject(obj); },
      onRemove: (obj) => { if (this.engine) this.engine.removeObject(obj); },
      // 运行期新建材质的 uniform（泡沫网格等）→ 一次性热同步（进程内为空实现）
      onMaterial: (mat) => { if (this.engine) this.engine.hotMaterial(mat); },
    });
    this.builder.onObjectChanged = (rec) => this._onObjectChanged(rec);
    // 体积雾管线：关卡里有雾对象时由 PostFX 在半分辨率缓冲里合成（见 world/volumefog.js）
    if (this.engine && this.engine.postfx) this.engine.postfx.setVolumeFog(this.builder.volumeFog);
    // 关卡引用的导入素材（贴图 / 全景图）与外部模型全部就绪的 Promise：
    // 加载界面等待它，资源备齐后再进关（避免进关后贴图 / 模型才一张张、一个个跳出来）
    this._ready = Promise.all([
      this.builder.texturesReady || Promise.resolve(),
      this.builder.modelsReady || Promise.resolve(),
    ]);

    this.fx = new FX(this.scene, settings.qualityPreset().particles === false ? 220 : 900);
    // 柔和粒子池：粒子发射器 soft 模式（烟、雾、泡泡等非发光粒子）
    this.fxSoft = new FX(this.scene, settings.qualityPreset().particles === false ? 140 : 420, { soft: true });
    // 渲染 Worker 模式：粒子动画时间等 uniform 需逐帧同步（进程内为空实现）
    if (this.engine) { this.engine.trackMaterial(this.fx.mat); this.engine.trackMaterial(this.fxSoft.mat); }
    // 发射器里的粒子条目图像（内置 / 导入素材）预注册进图集：避免进关后第一次发射才扩容图集造成卡顿
    this._registerEmitterParticles();

    const ctx = {
      player: null, mechanisms: null, liquids: null, anims: null, fx: this.fx,
      scene: this.scene,             // 事件脚本 / WorldAPI 用
      session: this,
      audio,                         // WorldAPI 的 world.sound / world.audio 直通
      cameraCtl: null,               // 玩家相机控制（建好后回填）
      hint: (text, t) => this.showHint(text, t),
      notice: (text, kind, dur) => this.showNotice(text, kind, dur),
      onWin: () => this.win(),
      onFail: (reason) => this.fail(reason || '事件脚本'),
      // 事件脚本里的 log(...)：转发到编辑器「输出」面板（正常游戏时只有控制台）
      log: (text, kind) => { this.hooks.onLog && this.hooks.onLog(text, kind || 'i'); },
    };
    this.ctx = ctx;

    this.liquids = new LiquidSystem(this.builder, { fx: this.fx });
    this.mechanisms = new Mechanisms(this.builder, {
      fx: this.fx, fxSoft: this.fxSoft, events: null,
      hooks: {
        onWin: (rec) => this.win(rec),
        onPickup: (item) => this._onPickup(item),
        onBreak: () => { },
        onButton: () => { },
      },
    });
    const events = new EventRuntime(this.builder, ctx);
    this.events = events;
    this.mechanisms.events = events;
    this.anims = new AnimationSystem(this.builder, ctx);
    ctx.liquids = this.liquids;
    ctx.anims = this.anims;
    ctx.mechanisms = this.mechanisms;
    ctx.events = events;

    /* ---------- 玩家 ---------- */
    this.cameraCtl = new PlayerCamera(this.camera);
    ctx.cameraCtl = this.cameraCtl;
    this.player = new Player(this.builder, {
      input: this.input,
      fx: this.fx,
      events,
      liquids: this.liquids,
      mechanisms: this.mechanisms,
      cameraCtl: this.cameraCtl,
      mirror: this.mirror,           // 镜像地图：左右操作与左右视角增量取反（手感不反转）
      hooks: {
        onDeath: (cause) => this._onDeath(cause),
        onRespawn: () => this.hooks.onRespawn && this.hooks.onRespawn(this.player),
        onDamage: (n, cause) => this.hooks.onDamage && this.hooks.onDamage(n, cause),
        onHint: (t, d) => this.showHint(t, d),
        onLocked: (info) => this.showHint(info && info.label ? info.label : '打不开', 1.4),
        onToolUsed: (item, kind) => this.hooks.onToolUsed && this.hooks.onToolUsed(item, kind),
        // 玩家对地图的交互动作（开门 / 破坏 / 点击 / 投掷 / 工具事件）→ 记进回放时间轴，
        // 这样回放时地图变化也能被重演（这些动作靠 input 驱动，幽灵状态下不会自己发生）
        onWorldAct: (kind, id, extra) => this.recordEvent(kind, extra ? { id, ...extra } : { id }),
      },
    });
    ctx.player = this.player;

    /* ---------- NPC ---------- */
    this.npcs = new NpcSystem(this.builder, ctx);
    ctx.npcs = this.npcs;

    /* ---------- 出生 ---------- */
    // opts.spawn：编辑器「在此处测试」指定的出生点，覆盖关卡自己的出生点
    const sp = opts.spawn;
    this.spawn = sp ? new THREE.Vector3(sp[0], sp[1], sp[2]) : this.builder.pickSpawn();
    this.player.respawn(this.spawn, true);
    this.player.setRespawn(this.spawn, true);
    // 开局倒数期间锚定玩家：不许走动，倒完（_begin）才解冻
    if (this.countdown > 0) this.player.setInputFrozen(true);

    /* ---------- 视图（交给引擎） ---------- */
    // 镜像变体：整张地图在**渲染层**左右翻转（scene.scale.x = -1），几何 / 动画 / 事件位移 /
    // 液体 / 粒子 / 玩家模型一起镜像；物理、关卡数据、记录仪仍在原空间，玩法完全等价。
    // 代价是要另起一台「镜像相机」出图：直接把相机挂进被镜像的场景里会让相机矩阵行列式为负，
    // 破坏 Three.js 的绕序修正。镜像相机由 _syncMirrorCamera 每帧从 P 空间相机推导。
    if (this.mirror) {
      this.renderCam = makeCamera(this.camera.fov, this.camera.near, this.camera.far);
      // 注意：渲染 Worker 模式下 canvas.width/height 不再是渲染尺寸（控制权已转移给 OffscreenCanvas），
      // 宽高比按 CSS 显示尺寸估算，随后由 engine.resize() 写进 view.camera 纠正。
      const cv = this.engine && this.engine.canvas;
      const cw = cv ? (cv.clientWidth || window.innerWidth) : window.innerWidth;
      const ch = cv ? (cv.clientHeight || window.innerHeight) : window.innerHeight;
      if (cw > 0 && ch > 0) this.renderCam.aspect = cw / ch;
      this.scene.scale.x = -1;
      this.builder.mirror = true;      // 公告板按距离淡出时要把世界坐标换回 P 空间（见 builder.updateBillboards）
      this.scene.updateMatrixWorld(true);
      this._syncMirrorCamera();
    }
    this.view = {
      scene: this.scene,
      camera: this.renderCam || this.camera,
      update: (dt) => this.update(dt),
      // 主渲染前：① 先渲一张不含水体的深度图，供水面泡沫做“深度差”判定
      //           ② 再做遮挡剔除（必须在泡沫深度图之后 —— 那张图要看到完整场景）
      //           ③ 有伤害特效时再渲一张「不含玩家」的低分辨率深度图，
      //              让贴面特效穿玩家可见、被场景正常遮挡（见 mechanisms.renderDamageDepth）
      beforeRender: (renderer, camera) => {
        this.builder.renderFoamDepth(renderer, camera);
        this.builder.cull(camera);
        if (this.mechanisms) this.mechanisms.renderDamageDepth(renderer, camera);
        // 玻璃屏幕空间折射：主渲染前把「不含玻璃的场景」渲进半分辨率缓冲供玻璃采样
        if (this.builder.usesGlass()) {
          renderGlassCapture(renderer, this.scene, camera, this.builder);
        }
      },
    };

    const envAmp = clamp(Number(this.builder.level.settings.env ?? 1), 0, 1);
    setEnvIntensity(envAmp);
    if (this.engine && envAmp > 0) {
      const env = this.engine.buildEnv(resolveSkyTexture(this.builder.level.settings.sky));
      if (env && env.isTexture) this.scene.environment = env;
    }
    // 高级材质的一次性场景反射（全关卡共用一张立方体贴图，运行时零开销）
    this.builder.captureReflection(this.engine && this.engine.renderer);
    // 天空盒换成导入的全景图时是异步加载的，加载完成后重算环境反射
    this.builder.onSkyApplied = () => {
      if (!this.engine) return;
      if (Number(this.builder.level.settings.env) > 0) {
        const env = this.engine.buildEnv(resolveSkyTexture(this.builder.level.settings.sky));
        if (env && env.isTexture) this.scene.environment = env;
      }
      this.builder.captureReflection(this.engine.renderer);
      // 天空换成导入全景图：环境贴图与反射捕获都要重做 → 重新下发渲染子系统描述
      this.engine.setRenderDescriptors(this.builder.renderDescriptors());
      this.engine.markSceneDirty();     // 场景结构需要重新同步
    };
    // 异步预编译着色器：把首帧的集中编译摊到加载阶段之后，避免进关第一帧明显卡顿
    if (this.engine) this.engine.warmup(this.scene, this.renderCam || this.camera);
    // 后处理对象（全屏调色 / 曝光 / 泛光…）：每帧从关卡数据读取参数
    // 进程内模式直接喂给主线程 PostFX；渲染 Worker 模式把参数随帧消息下发给 Worker 内的管线
    if (this.engine && this.engine.postfx) {
      this.engine.postfx.setProvider((out) => collectPostFX(this.builder.level, out));
    } else if (this.engine) {
      this.engine.setRenderParamsProvider(() => collectPostFX(this.builder.level, {}));
    }
    // 渲染子系统描述（雾对象 / 玻璃 / 泡沫深度 / 遮挡剔除 / 反射捕获）：随结构快照一次性下发
    if (this.engine) this.engine.setRenderDescriptors(this.builder.renderDescriptors());
    // 画面处理对象：每帧从关卡数据读取（色调映射 / 曝光 / 色彩空间 / 饱和度 / 染色），水下压暗也在这里一起算
    if (this.engine) {
      this.engine.setScreenProvider(() => {
        const s = collectScreen(this.builder.level);
        const dim = this.underTint * 0.16;
        if (!s) return BASE_EXPOSURE - dim;   // 关卡里没放画面处理对象：只按水下压暗给曝光
        s.exposure -= dim;                    // collectScreen 每帧返回新对象，可以直接改
        return s;
      });
    }
    // 场景构建完成：通知渲染宿主下发一次结构快照（渲染 Worker 模式生效；进程内模式为空实现）
    if (this.engine) this.engine.markSceneDirty();
    audio.ambient(opts.hall ? 'hall' : 'game');
    // 时间流速变体：BGM 也跟着一起拉伸（playbackRate），在起播前设好
    audio.setMusicPitch(this.timeScale);
    // 关卡背景音乐（编辑器「关卡属性 → 背景音乐」里导入的音频素材）：
    // 这里只预解码，真正起播放到 _begin（倒数结束）之后，见 _startBgm
    const bgm = L.settings.bgm;
    if (bgm) {
      audio.load(bgm);      // 先把素材解码好，倒数结束立刻出声
      audio.analyzeRhythm(bgm);   // 顺手分析节奏点（回放「电影剪辑」卡点用）：解码完即算，缓存住
    } else audio.stopMusic({ fade: 0.4 });
  }

  /* ============================================================
     界面提示
     ============================================================ */
  /** 居中横幅：大字标题 + 可选小字副标题（sub 为 [{ text, color }] 分段，可分别着色）
   *  stroke 为标题描边色（一般是难度分级里的 glow） */
  showBanner(text, dur = 2.2, color, sub = null, stroke = '') {
    this.banner = { text, sub, color, stroke };
    this.bannerTimer = dur;
    this.hooks.onBanner && this.hooks.onBanner(text, dur, color);
  }
  showHint(text, dur = 1.6) {
    if (!settings.get('misc.showHints', true)) return;
    this.hint = text;
    this.hintTimer = dur;
    this.hooks.onHint && this.hooks.onHint(text, dur);
  }
  /** 顶部弹出信息 / 警告（事件动作「显示顶部提示」） */
  showNotice(text, kind = 'info', dur = 3) {
    if (!text) return;
    this.hooks.onNotice && this.hooks.onNotice(text, kind, dur);
  }

  /* ============================================================
     胜负
     ============================================================ */
  win(rec) {
    if (this.replay) return;            // 回放里重演到终点：不改动任何真实流程
    // 大厅里的「终点」是通往选关的传送门，不算通关：不弹通关横幅 / 不放胜利音 / 不记进度
    if (this.isHall) { this.hooks.onWin && this.hooks.onWin({ level: this.level }); return; }
    if (this.status === 'won') return;
    this.status = 'won';
    this._recInfo.win = true;
    // 胜利的「精确时刻」：取记录仪当下的时间轴读数（毫秒级），它就是回放时间轴上的秒数。
    // 不能等收尾录完再拿 this.time —— 那时已经含了 2.6s 收尾尾巴，不是胜利时刻。
    this._recInfo.winAt = round(this.recorder ? this.recorder.t : this.time, 3);
    this.recordEvent('win', {});        // 时间轴上钉一个「通关」标记（运镜剪辑 / 高光扫描都认它）
    this._recStopTimer = 2.6;           // 胜负后再录一段收尾，混剪才有结尾镜头
    this.player.inventory.clear();
    this.player.invincible = true;      // 通关后无敌：不再受伤/死亡
    audio.win();
    this.showBanner('通关！', 2.4, '#8ef5c8');
    const p = this.player;
    this.fx.burst(p.feetPos.clone().add(new THREE.Vector3(0, 3, 0)), '#ffd98a', 46);
    void rec;
    this._saveProgress(true);
    this.hooks.onWin && this.hooks.onWin({
      level: this.level, time: this.time, deaths: this.deaths, health: p.health, oxygen: p.oxygen,
    });
  }

  fail(reason) {
    if (this.replay) return;
    if (this.status !== 'playing') return;
    this.status = 'failed';
    this._recInfo.reason = reason || '';
    this._recStopTimer = 2.2;
    audio.alarm(0.7);
    this.showBanner(reason || '失败…', 2.2, '#ff9fb2');
    this._saveProgress(false);
    this.hooks.onFail && this.hooks.onFail({ level: this.level, reason, time: this.time, deaths: this.deaths });
  }

  _onDeath(cause) {
    this.deaths = this.player.deaths;
    this.recordEvent('death', {});
    if (this.deathLimit > 0 && this.deaths >= this.deathLimit) {
      this.fail('死亡次数用尽');
      return;
    }
    if (this.status !== 'playing') return;
    this.respawnTimer = RESPAWN_DELAY;
    this.showBanner(deathText(cause), 1.4, '#ff9fb2');
    this.hooks.onDeath && this.hooks.onDeath(cause);
  }

  respawn() {
    const p = this.player;
    p.respawn(p.respawnPoint || this.spawn, true);
    this.respawnTimer = 0;
    this.events.emitTrigger('playerRespawn', {});
  }

  _onPickup(item) {
    this.recordEvent('pickup', {});
    audio.pickup();
    this.showHint(`拾取：${item.name}`, 1.5);
    this.hooks.onPickup && this.hooks.onPickup(item);
  }

  _onObjectChanged(rec) {
    void rec;
  }

  /** 把关卡里所有发射器用到的粒子图像（内置 / 导入素材）预注册进对应的粒子池图集 */
  _registerEmitterParticles() {
    try {
      for (const rec of this.builder.objectsOf('emitter')) {
        const o = rec && rec.o;
        if (!o || !Array.isArray(o.particles)) continue;
        const pool = (o.soft === true && this.fxSoft) ? this.fxSoft : (this.fx || this.fxSoft);
        if (!pool) continue;
        for (const e of o.particles) {
          if (e && e.on !== false && e.img) pool.registerImage(e.img);
        }
      }
    } catch (e) { /* 预注册失败不影响进关：发射时仍会按需注册 */ }
  }

  async _saveProgress(cleared) {
    const L = this.level;
    try {
      const prev = (await store.getProgress(this.progressId)) || {};
      // 地图版本：关卡每次保存 updated 都会变。PB 只在同一版本内有效，地图更新即重置。
      // 内置 / custom 关卡没有存档记录 → 版本恒为 0，PB 一直有效。
      let lvUpdated = prev.lvUpdated != null ? prev.lvUpdated : 0;
      if (cleared) {
        const lrec = await store.getLevel(L.id).catch(() => null);
        lvUpdated = lrec ? (lrec.updated || 0) : 0;
      }
      // 旧记录没有 lvUpdated：只有用户关卡（updated>0）视为失效，内置关卡的历史 PB 予以保留
      const stale = prev.lvUpdated != null ? prev.lvUpdated !== lvUpdated : lvUpdated > 0;
      const prevBest = stale ? 0 : (prev.bestTime || 0);
      const rec = {
        cleared: cleared || prev.cleared || false,
        bestTime: cleared ? (prevBest > 0 ? Math.min(prevBest, this.time) : this.time) : prevBest,
        lastTime: this.time,
        deaths: this.deaths,
        plays: (prev.plays || 0) + 1,
        at: Date.now(),
        lvUpdated,
      };
      if (!isFinite(rec.bestTime)) rec.bestTime = 0;
      await store.setProgress(this.progressId, rec);
    } catch (e) { /* 忽略存档失败 */ }
  }

  /* ============================================================
     游玩记录仪 / 回放
     ============================================================ */
  /** 开始记录本局（正式游玩；试验模式用 opts.test 标记） */
  startRecord(opts = {}) {
    if (this.recorder || this.replay) return null;
    this.recorder = new ActionRecorder(this.level, opts);
    this._recInfo = { win: false, winAt: 0, reason: '', deaths: 0, time: 0 };
    this._recSaved = false;
    return this.recorder;
  }

  /** 记录一次事件（由 hooks / 上层调用） */
  recordEvent(kind, extra) { if (this.recorder) this.recorder.event(kind, extra); }

  /** 收尾并落盘（只发一次）：land/赢/输后调用 */
  _emitRecord() {
    this._recStopTimer = null;
    if (this._recSaved || !this.recorder) return;
    this._recSaved = true;
    const r = this.recorder;
    this.recorder = null;
    const sp = this.spawn;
    const rec = r.finish({
      ...this._recInfo,
      time: this.time,
      deaths: this.deaths,
      levelTime: this.timeLimit,          // 关卡时长：回放保存阈值按它算百分比
      spawn: sp ? [sp.x, sp.y, sp.z] : null,
      // 本局的地图变体：回放要按它把「镜像」重演出来
      mod: modifierActive(this.modifiers) ? { ...this.modifiers } : null,
    });
    if (rec) this.hooks.onReplay && this.hooks.onReplay(rec);
  }

  /** 立刻收尾（中途退出 / 销毁时） */
  stopRecord(info) {
    if (info) Object.assign(this._recInfo, info);
    this._emitRecord();
  }

  /** 挂上回放播放器（回放 / 混剪）：关卡照常模拟，玩家与相机交给它 */
  setReplay(rp) {
    this.replay = rp || null;
    if (rp) {
      this.countdown = 0;
      this.recorder = null;
      this._recStopTimer = null;
      this._recSaved = true;      // 回放中不再产生新记录
      this.banner = null; this.hint = null;
    }
  }

  /* ============================================================
     每帧
     ============================================================ */
  update(dt) {
    // 回放：关卡（液体 / 机关 / 事件 / 动画 / 特效）照常跑，玩家与相机由 ReplayPlayer 接管
    if (this.replay) { this._updateReplay(dt); return; }
    const p = this.player;
    // 世界时间：地图变体「加快 / 减慢」改的是**整个时间流速** ——
    // 动画、事件里的 wait、物理模拟、液体、机关、关卡计时全部按 wdt 推进；
    // UI（倒数 / 提示计时）与相机装置（转视角手感）仍用真实 dt。
    const wdt = dt * this.timeScale;

    // 开局倒数（显示在 HUD 上）：倒完才算正式开始 —— 才开始计时、才触发关卡事件
    if (!this.started) {
      if (this.countdown > 0) {
        this.countdown -= dt;
        if (this.countdown <= 0) { this.countdown = 0; this._begin(); }
      } else {
        this._begin();
      }
    }

    if (this.bannerTimer > 0) { this.bannerTimer -= dt; if (this.bannerTimer <= 0) this.banner = null; }
    if (this.hintTimer > 0) { this.hintTimer -= dt; if (this.hintTimer <= 0) this.hint = null; }

    this.builder.update(wdt, this.camera);
    this.events.update(wdt);
    this.anims.update(wdt);
    audio.setListener(p.feetPos, this._listenerYaw());   // 3D 音效（声效方块）用监听者

    if (this.status === 'playing' && this.started) this.time += wdt;

    if (!p.alive) {
      if (this.status === 'playing' && this.respawnTimer > 0) {
        this.respawnTimer -= wdt;
        if (this.respawnTimer <= 0) this.respawn();
      }
    } else if (this.status === 'playing') {
      p.update(wdt);
      this.liquids.update(wdt, p);
      this.mechanisms.update(wdt, p);
      this.npcs.update(wdt, p);
      this._checkVoid();
      this._checkTime();
    } else {
      p.update(wdt);
    }

    this.builder.stepPhysics(wdt);
    p.syncVisual && p.syncVisual();   // 步进后再对齐一次模型位置：与相机同帧采样补间值，避免人物抖动
    if (this.engine && p.visualRoot) this.engine.hot(p.visualRoot, true);   // 玩家模型树推渲染热通道
    this.fx.update(wdt);
    this.fxSoft.update(wdt);
    if (this.engine) {
      // 粒子几何属性 + 图集贴图推渲染热通道（渲染 Worker 模式生效）
      this.engine.hotAttrs(this.fx.points);
      this.engine.hotAttrs(this.fxSoft.points);
      if (this.fx._atlasDirty) { this.fx._atlasDirty = false; this.engine.hotTexture(this.fx._atlasTex); }
      if (this.fxSoft._atlasDirty) { this.fxSoft._atlasDirty = false; this.engine.hotTexture(this.fxSoft._atlasTex); }
    }
    this.cameraCtl.update(dt, p, this.builder.world);
    // 2D 平台模式：视角锁定，鼠标解绑（释放指针锁定，光标可自由移动）
    if (this.cameraCtl.platformOn && this.input && this.input.pointerLocked) this.input.exitLock();
    this._underwaterFx(dt);
    this._recordTick(wdt);
    this._syncMirrorCamera();
  }

  /** 镜像变体下声像也要翻面：监听者假想朝向转 180°，左右声像随之交换 */
  _listenerYaw() { return this.mirror ? this.player.yaw + Math.PI : this.player.yaw; }

  /**
   * 镜像变体：把 P 空间相机（this.camera，玩家 / 交互射线用的那台）的位姿镜像到出图相机。
   * 位置按 x=0 平面取反；朝向做镜面共轭 q' = (x, -y, -z, w)（= S·R·S），
   * 这样出图是一张纯水平镜像的画面，且渲染相机自身仍是真旋转（行列式 +1）。
   * 宽高比由引擎写进 view.camera（= 镜像相机），这里同步回 P 空间相机。
   */
  _syncMirrorCamera() {
    const r = this.renderCam;
    if (!r) return;
    const c = this.camera;
    c.aspect = r.aspect;
    r.position.set(-c.position.x, c.position.y, c.position.z);
    r.quaternion.set(c.quaternion.x, -c.quaternion.y, -c.quaternion.z, c.quaternion.w);
    r.fov = c.fov; r.near = c.near; r.far = c.far;
    r.updateProjectionMatrix();
    r.updateMatrixWorld(true);
  }

  /* ---------- 回放：关卡照常模拟，玩家 / 相机交给 ReplayPlayer ---------- */
  _updateReplay(dt) {
    const p = this.player;
    if (!this.started) { this.started = true; this.events.start(); }   // 不解冻玩家：幽灵由记录驱动

    if (this.bannerTimer > 0) { this.bannerTimer -= dt; if (this.bannerTimer <= 0) this.banner = null; }
    if (this.hintTimer > 0) { this.hintTimer -= dt; if (this.hintTimer <= 0) this.hint = null; }

    this.replay.advance(dt);              // ① 推进播放时钟（内部已按倍速）+ 把幽灵摆到记录位置
                                          //    并重演记录里的世界交互（开门 / 破坏 / 点击 / 投掷）
    this.time = this.replay._srcT || 0;
    audio.setListener(p.feetPos, this._listenerYaw());

    // ② 地图时间：倍速回放时，地图上的一切（机关 / 门 / 关卡动画 / 液体 / 物理 / 粒子）
    //    都要跟着时间拉伸，否则幽灵按 2× 走、门还在用 1× 的速度慢慢开。
    //    按物理定步长切分：3× 下也不会因为 dt 过大而丢物理子步 / 穿透。
    //    ★ 暂停时整段跳过：暂停 = 世界真的静止（动画 / 机关 / 事件 / 液体 / 粒子全停），
    //      而不是只把播放头冻住、世界还在自己跑 —— 否则一暂停就看到门还在开、水还在荡。
    //      worldRun 只在「正在播」或「刚拖过进度条（要对齐一次）」时为真。
    if (this.replay.worldRun) {
      let left = clamp(dt * (this.replay.speed || 1), 0, 0.5);
      for (let guard = 0; left > 1e-5 && guard < 12; guard++) {
        const h = Math.min(PHYS.timeStep, left);
        this._stepReplayWorld(h);
        left -= h;
      }
      this.replay._worldT = this.replay.clock;   // 世界已模拟到此刻（拖动定位判断前进 / 倒退用）
    }

    p.syncVisual && p.syncVisual();
    this.replay.applyCamera(dt);          // ③ 姿态 + 取景（相机本身仍用真实 dt：抖动 / 阻尼不受倍速影响）
    this._underwaterFx(dt);
    this._syncMirrorCamera();             // ④ 本局带「镜像」变体时：回放也照样左右镜像
  }

  /** 回放的一步世界模拟：机关 / 门 / 关卡动画 / 液体 / 物理 / 粒子，全部按 h 推进 */
  _stepReplayWorld(h) {
    const p = this.player;
    this.builder.update(h, this.camera);
    this.events.update(h);
    this.anims.update(h);
    this.liquids.update(h, p);
    this.mechanisms.update(h, p);
    this.builder.stepPhysics(h);
    this.fx.update(h);
    this.fxSoft.update(h);
  }

  /**
   * 回放定位：把世界从 from（秒）确定性地重演到 t（秒）。
   * · 重建会话后的首次定位：from = 0 —— 世界从初始状态从头重演一遍，
   *   门 / 破坏 / 动画（洪水水位等）/ 液体 / 物理 / 粒子全部回到 t 该有的样子；
   * · 拖动进度条向前：from = 世界已模拟到的时刻 —— 只补中间这一段，实时廉价。
   * 全程按物理定步长推进，并同步驱动幽灵玩家（记录里的世界交互也在这一刻重演）。
   */
  simulateReplayTo(t, from) {
    const rp = this.replay;
    if (!rp) return;
    const goal = clamp(Number(t) || 0, 0, rp.duration);
    const start = clamp(Number(from) || 0, 0, goal);
    if (!this.started) { this.started = true; this.events.start(); }   // 事件脚本要先起，动画才会被触发
    const step = PHYS.timeStep || 1 / 60;
    rp.clock = start;
    rp._worldT = start;
    let guard = 0;
    while (rp.clock < goal && guard++ < 400000) {
      const h = Math.min(step, goal - rp.clock);
      rp.stepTo(h);
      this._stepReplayWorld(h);
    }
    rp.clock = goal;
    rp._worldT = goal;
    rp.shake = 0;        // 快进期间累积的震屏不是「这一刻」的，清掉
    rp._wake = false;
    this.time = rp.clock;
  }

  /** 记录仪：按帧采样，并在胜负后继续录一小段收尾 */
  _recordTick(dt) {
    if (!this.recorder) return;
    if (!this.started) return;          // 开局倒数不算游玩：别把这段站着不动的画面录进去
    this.recorder.sample(dt, this);
    if (this._recStopTimer == null) return;
    this._recStopTimer -= dt;
    if (this._recStopTimer <= 0) this._emitRecord();
  }

  /** 正式开始：倒数结束（或无需倒数）后触发一次关卡事件 */
  _begin() {
    if (this.started) return;
    this.started = true;
    this.player.setInputFrozen(false);   // 倒数结束：解冻玩家，放开移动
    this.events.start();
    this._startBgm();
    if (this.level.settings.objective) this.showHint(this.level.settings.objective, 3.4);
    // 开场标题卡：大字地图名（用难度配色），副标题列难度与地图变体（变体单独配色）
    if (!this.isHall) {
      const d = diffOf(this.level.difficulty);
      const sub = [{ text: d.label + ' ' + Number(this.level.difficulty).toFixed(1), color: d.color }];
      const mod = modifierText(this.modifiers);
      if (mod) sub.push({ text: mod, color: '#c9b6ff' });
      this.showBanner(this.level.name, 3.4, d.color, sub, d.glow);
    }
  }

  /** 起播本关 BGM（倒数结束后调用；回放中由 ReplayPlayer 自己接管） */
  _startBgm() {
    if (this.replay) return;
    const bgm = this.level.settings.bgm;
    if (bgm) audio.playMusic(bgm, { volume: Number(this.level.settings.bgmVolume ?? 1), fadeIn: 0.45 });
    else audio.stopMusic({ fade: 0.4 });
  }

  _checkVoid() {
    const voidY = Number(this.level.settings.voidY ?? PLAYER.respawnFallY);
    if (this.player.feetPos.y < voidY) this.player.kill('void');
  }

  _checkTime() {
    if (this.timeLimit > 0 && this.time > this.timeLimit) this.fail('时间耗尽');
  }

  /* ---------- 水下视觉 ---------- */
  _underwaterFx(dt) {
    const p = this.player;
    const on = p.alive && p.env.inLiquid && p.env.headUnder;
    // 水下滤色跟随当前液体自身颜色（不再使用关卡全局参数）
    const liq = p.env.liquidRec;
    const tint = new THREE.Color((liq && liq.o && liq.o.color) || '#2f8fd8');
    const target = on ? 1 : 0;
    this.underTint = damp(this.underTint, target, on ? 9 : 5, dt);
    const fog = this.scene.fog;
    if (fog && fog.isFog) {
      const base = this._baseFog || (this._baseFog = {
        color: fog.color.clone(), near: fog.near, far: fog.far,
      });
      if (this.underTint > 0.01) {
        fog.color.copy(base.color).lerp(tint, this.underTint * 0.9);
        fog.near = base.near * (1 - this.underTint * 0.75);
        fog.far = base.far * (1 - this.underTint * 0.72);
      } else if (this._wasUnderTint) {
        fog.color.copy(base.color); fog.near = base.near; fog.far = base.far;
      }
      this._wasUnderTint = this.underTint > 0.01;
    }
    // 曝光（含水下压暗）统一由 engine 的 screenProvider 每帧写入
  }

  /* ============================================================
     HUD 数据
     ============================================================ */
  hudInfo() {
    const p = this.player;
    const L = this.level;
    const d = diffOf(L.difficulty);
    const it = p.interact;
    let prompt = '';
    if (it && it.info) {
      if (it.info.kind === 'door' && it.info.locked) prompt = `<b>${esc(it.info.label)}</b>`;
      else prompt = `<b>${esc(it.info.label)}</b>`;
    } else if (this.npcs && this.npcs.prompt) {
      // 视野里没有可交互物体时，退到「附近的 NPC」提示
      prompt = this.npcs.prompt;
    } else if (p.inventory.current && p.inventory.current.type !== 'custom') {
      prompt = '';
    }
    return {
      name: L.name,
      diff: d,
      diffText: d.label + ' ' + Number(L.difficulty).toFixed(1),
      time: this.time,
      deaths: p.deaths,
      timeLimit: this.timeLimit,
      objective: L.settings.objective || '',
      health: clamp(p.health, 0, p.healthMax),
      healthMax: p.healthMax,
      oxygen: clamp(p.oxygen, 0, p.maxOxygen),
      oxygenMax: p.maxOxygen,
      extraOxygen: Math.max(0, p.oxygen - p.maxOxygen),
      under: !!(p.env.inLiquid && p.env.headUnder),
      tools: p.inventory.slots(),
      prompt,
      banner: this.banner,
      hint: this.hint,
      countdown: this.countdown > 0 ? Math.ceil(this.countdown) : 0,
      status: this.status,
      crosshairPick: !!it,
    };
  }

  /* ============================================================
     生命周期
     ============================================================ */
  /** 关卡引用的导入素材（自定义贴图 / 全景图）与外部模型（.glb/.gltf）全部就绪的 Promise */
  whenReady() { return this._ready || Promise.resolve(); }

  /** 暂停 / 恢复：BGM 跟着一起暂停（从原位置接着放） */
  setPaused(on) {
    const v = !!on;
    if (v === this.paused) { this.paused = v; return; }
    this.paused = v;
    if (v) audio.pauseMusic();
    else audio.resumeMusic();
  }

  dispose() {
    // 中途退出也算一局：把记录收尾（时长太短会自动丢弃）
    this.stopRecord();
    if (this.replay) { this.replay.dispose(); this.replay = null; }
    // 关卡结束：BGM / 环境音 / 循环音（事件与声效方块留下的）全部收掉，别带到下一个场景
    audio.stopAll({ fade: 0.5 });
    if (this.engine && this.engine.postfx) { this.engine.postfx.clear(); this.engine.postfx.setVolumeFog(null); }
    if (this.engine) this.engine.setScreenProvider(null);
    this.events.stopAll();
    this.anims.stopAll();
    this.npcs.dispose();
    this.player.dispose();
    this.fx.dispose();
    this.fxSoft.dispose();
    this.builder.dispose();
    disposeReflections();
    this.mechanisms.clearProjectiles();
    if (!this._keepPaint) this.paint.dispose();
    this.scene.clear();
  }
}

function deathText(cause) {
  switch (cause) {
    case 'drown': return '你窒息了…';
    case 'liquid': return '你被液体吞没…';
    case 'lava': return '熔岩吞噬了你';
    case 'zone': return '你被撕碎了…';
    case 'void': return '你坠入了虚空…';
    default: return '你死了…';
  }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

export { worldPosition };