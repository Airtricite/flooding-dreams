/* ============================================================
   应用主控：状态机 boot → menu → hall → levels → game → result
   ============================================================ */
import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { settings } from './core/settings.js';
import { store } from './core/storage.js';
import { audio, unlockAudioOnce } from './core/audio.js';
import { getSkyTexture } from './core/textures.js';
import { initBuiltinThumbs } from './core/builtin-assets.js';
import { fmtTime, deepClone, round, clamp } from './core/util.js';
import { LevelSession } from './game/session.js';
import { ReplayPlayer } from './game/replay-player.js';
import { saveReplay, listReplays, loadReplay, deleteReplay } from './game/replay.js';
import { Hall } from './game/hall.js';
import { loadCustomLevels, getBuiltinLevels, freshBuiltinLevel } from './levels/builtin.js';
import { runListTask } from './core/list-tasks.js';
import { normalizeLevel } from './world/level.js';
import { levelHasScripts } from './world/events.js';
import { loadPackTiers, resolveTier, packView, nodeOf } from './levels/packs.js';
import { showScreen, hideScreens, currentScreen, toast, confirmBox, $, el, clear } from './ui/dom.js';
import { MainMenu, HallBar, PauseMenu, ResultPanel } from './ui/menu.js';
import { Hud } from './ui/hud.js';
import { TouchControls } from './ui/touch.js';
import { LevelPanel } from './ui/levels.js';
import { LevelMapPanel } from './ui/level-map-panel.js';
import { SavesPanel } from './ui/saves.js';
import { SettingsPanel } from './ui/settings.js';
import { HelpPanel } from './ui/help.js';
import { ReplayPanel, ReplayHud, CinePanel } from './ui/replay.js';
import { rollModifier, normalizeModifier, NO_MODIFIER } from './game/modifier.js';
import { SkinEditor } from './ui/skin-editor.js';
import { Backdrop } from './ui/backdrop.js';
import { disposeTextTextures } from './world/text-canvas.js';
import { tpl } from './core/i18n.js';

const REPLAY_KEEP = 20;      // 最多保留多少条回放记录

export class App {
  constructor(canvas) {
    this.engine = new Engine(canvas || $('#gl'));
    this.input = new Input(this.engine.canvas);
    this.state = 'boot';         // boot | menu | hall | game | editor
    this.paused = false;
    this.overlay = false;        // 有全屏面板打开
    this.frozen = false;         // 冻结逻辑更新（结算界面）
    this.session = null;
    this.hall = null;
    this.editor = null;
    this.replay = null;          // ReplayPlayer：当前正在回放（回放 / 混剪）
    this._replayEndPending = false;       // 回放播完了：等下一帧统一退出（不能在手柄回调里直接拆会话）
    this._replayRestartOnClose = false;   // 关剪辑面板后要重播（= 地图一切重启）
    this._replayRestarting = false;       // 正在重启回放：整关重载是异步的，期间再点无效
    this._replayPendingSeek = null;       // 重建期间又拖了进度条：记下最新落点，重建完再补一次
    this._lastReplay = null;     // 刚录下来的那份（结算面板 / 暂停菜单用）
    this.entry = null;           // 当前游戏条目
    this.pack = null;            // 当前所在的关卡包（从节点地图进来的）
    this.testing = false;
    this.testPoints = [];        // 编辑器试玩：测试位点（E 记录 / R 传送），随编辑器会话保留
    this.testPointIx = -1;       // 当前选中的测试位点下标
    this._testSpawn = null;      // 「在此处测试」指定的出生点
    this._lockTimer = 0;
    this._loadToken = 0;         // 加载序号：新的加载会让旧的加载作废
    this._loadPrev = null;       // 加载界面弹出前的界面（加载失败时回退用）
    this._scriptAck = new Set(); // 已确认过「含脚本」的关卡 id（本次会话内不再重复弹窗）

    /* ---------- 渲染包装（引擎每帧调用） ---------- */
    this.wrapper = { scene: null, camera: null, update: (dt) => this._frame(dt) };
    this.engine.setView(this.wrapper);
    this.engine.onResize(() => { if (this.editor) this.editor.onResize(); });

    /* ---------- UI ---------- */
    this.hud = new Hud({ onToolSelect: (i) => this.session && this.session.player.inventory.select(i) });
    this.hud.onLockClick = () => this._tryLock();
    this.touch = new TouchControls(this);   // 触屏设备：摇杆 / 拖动转视角 / 动作按钮
    this.menu = new MainMenu({
      onPlay: () => this.playHall(),
      onReplays: () => this.openReplays(),
      onSkin: () => this.openSkin(),
      onEditor: () => this.openSaves(),
      onSettings: () => this.openSettings('menu'),
      onHelp: () => this.openHelp('menu'),
    });
    this.hallbar = new HallBar({
      onMenu: () => this.goMenu(),
      onLevels: () => this.openLevels('hall'),
      onSettings: () => this.openSettings('hall'),
    });
    this.pauseMenu = new PauseMenu({
      onResume: () => this.setPaused(false),
      onRestart: () => this.restartLevel(),
      onLevels: () => this.openLevels('pause'),
      onSettings: () => this.openSettings('pause'),
      onQuit: () => this.goHall(),
      onReplay: () => this.openLatestReplay(),
    });
    this.resultPanel = new ResultPanel({
      onAgain: () => this.restartLevel(),
      onHall: () => this.goHall(),
      onReplay: (mode) => this.openLatestReplay(mode),
    });
    this.levelPanel = new LevelPanel({
      onPlay: (e) => this.startLevel(e.level, { entry: e }),
      onEdit: (e) => this.openEditor(e.level, e.rec),
      onClose: () => this.closeOverlay('levels'),
      onHall: () => this.goHall(),
      onOpenSaves: () => this.openSaves(),
      onOpenPack: (pack) => this.openLevelMap(pack, this._panelFrom),
    });
    this.mapPanel = new LevelMapPanel({
      onPlay: (level, node, pack) => this.startLevel(level, {
        entry: { id: level.id, name: level.name, difficulty: level.difficulty, level, kind: 'pack', pack, node },
      }),
      // 包内关卡只能从关卡包里点开编辑（不出现在任何选关列表）
      onEdit: (level, rec) => this.openEditor(level, rec),
      onClose: () => this.closeOverlay('lvmap'),
    });
    this.savesPanel = new SavesPanel({
      onEdit: (level, rec) => this.openEditor(level, rec),
      onClose: () => this.closeOverlay('saves'),
    });
    this.settingsPanel = new SettingsPanel({
      onClose: () => this.closeOverlay('settings'),
      onChange: (path) => this._onSettingsChanged(path),
    });
    this.helpPanel = new HelpPanel({ onClose: () => this.closeOverlay('help') });
    this.replayPanel = new ReplayPanel({
      onPlay: (id, mode) => this.playReplay(id, mode),
      onDelete: (id) => this.deleteReplayRec(id),
      onDeleteMany: (ids) => this.deleteReplayRecs(ids),
      onClear: () => this.clearReplays(),
      onClose: () => this.closeOverlay('replays'),
    });
    this.cinePanel = new CinePanel({
      onClose: () => this.closeCine(),
      // 「应用并播放」：先记下「关面板后要从头重播」，由 closeCine 统一处理 ——
      // 这里不能直接 play()：剪辑把整局时间轴改了，必须连地图一起重启才是干净的一遍
      onApplied: () => { this._replayRestartOnClose = true; this.closeCine(); toast('已应用剪辑，从头播放', 'ok', 1600); },
    });
    this.replayHud = new ReplayHud({
      onBack: () => this.exitReplay(),
      onCine: () => this.openCine(),
    });
    this.skinEditor = new SkinEditor(this);   // 角色皮肤编辑器（独立窗口，画布全屏 + 浮层面板）

    /* ---------- 试玩「测试位点」悬浮面板（仅编辑器试玩时显示） ---------- */
    this.testPanel = $('#hud-testpts');
    if (this.testPanel) {
      this.testPanel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tp]');
        if (!btn) return;
        const act = btn.dataset.tp;
        if (act === 'fold') this.testPanel.classList.toggle('fold');
        else if (act === 'del') this._removeTestPoint(Number(btn.dataset.i));
        else if (act === 'goto') { this._selectTestPoint(Number(btn.dataset.i)); this.gotoTestPoint(); }
      });
    }

    /* ---------- 输入事件 ---------- */
    this.input.on('lock', (locked) => this._onLock(locked));
    this.engine.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (this.state === 'hall' || this.state === 'game') this._tryLock();
    });
    window.addEventListener('keydown', (e) => this._onKey(e));

    unlockAudioOnce();   // 首次用户操作解锁音频；挂起的 BGM 会在这一刻立刻自动播放
  }

  /* ============================================================
     启动
     ============================================================ */
  async boot() {
    const fill = $('#boot-fill');
    const msg = $('#boot-msg');
    const step = async (pct, text, fn) => {
      if (fill) fill.style.width = pct + '%';
      if (msg) msg.textContent = text;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 10)));
      if (fn) await fn();
    };
    try {
      await step(8, '正在打开梦的门缝…', async () => { await store.open(); });
      await step(30, '正在生成天空与材质…', async () => { getSkyTexture(); });
      await step(52, '正在铺开云海…', async () => {
        this.backdrop = new Backdrop(this.engine);
        this._useView(this.backdrop.view);
      });
      await step(74, '正在清点梦境档案…', async () => {
        const list = await store.listLevels();
        void list;
        // 载入 js/levels/custom/ 里的自定义关卡（可替换内置关卡）
        await loadCustomLevels();
      });
      await step(92, '准备好了。', null);
    } catch (e) {
      console.error('[boot] 初始化失败', e);
      if (msg) msg.textContent = '初始化失败：' + (e && e.message ? e.message : e);
      return;
    }
    this.engine.start();
    if (fill) fill.style.width = '100%';
    // 扩充内置素材的缩略图：首次启动缩一次并落盘，之后直接复用；
    // 纯后台跑，失败 / 无 assets 目录（精简编译版）都静默降级到占位图标
    initBuiltinThumbs().catch((e) => console.warn('[builtin] 缩略图初始化失败', e));
    setTimeout(() => this.goMenu(), 220);
  }

  /* ============================================================
     视图
     ============================================================ */
  _useView(view) {
    if (!view) return;
    // 编辑器视图由 viewport.setRect 自己管理 canvas 区域；切到其它视图（含编辑器试玩）必须全屏
    if (this.editor && view !== this.editor.view) this.engine.setRect(null);
    // 编辑器可以用 overlay 叠加
    this.wrapper.scene = view.scene;
    this.wrapper.camera = view.camera;
    this.wrapper.overlay = view.overlay || null;
    this.wrapper.afterRender = view.afterRender || null;
    this.wrapper.beforeRender = view.beforeRender || null;
  }

  /* ============================================================
     加载界面
     ============================================================ */
  /** 等一帧再继续：让加载界面先画出来（关卡构建是同步的，会卡住主线程） */
  _nextFrame() { return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); }

  _loadingOpen(name, msg) {
    const cur = currentScreen();
    // 已经在加载中再次发起加载时，沿用最初的来源界面（失败时能正确回退）
    this._loadPrev = (cur && cur !== 'loading') ? cur : this._loadPrev;
    const n = $('#load-name');
    if (n) n.textContent = name || '';
    this._loadingProgress(6, msg || '正在加载…');
    showScreen('loading');
  }
  _loadingProgress(pct, msg) {
    const f = $('#load-fill');
    if (f) f.style.width = Math.max(0, Math.min(100, pct)) + '%';
    const m = $('#load-msg');
    if (m && msg) m.textContent = msg;
  }
  /** 加载失败：回到弹出加载界面之前的那一屏 */
  _loadingFail() {
    if (this._loadPrev) showScreen(this._loadPrev);
    else hideScreens();
    this._loadPrev = null;
  }

  /* ============================================================
     状态切换
     ============================================================ */
  /* 场景切换时的音频收尾：上一个场景的 BGM / 环境音 / 循环音一律停掉，
     否则回到菜单、进编辑器、换关卡之后还会残留（多处场景都会出问题） */
  _stopAudio() {
    audio.stopAll({ fade: 0.3 });
  }

  /** 当前场景（关卡 / 大厅）该放的 BGM 与环境音 */
  _playSessionAudio() {
    const s = this.session || (this.hall && this.hall.session);
    if (!s) return;
    const st = (s.level && s.level.settings) || {};
    audio.ambient(this.hall && s === this.hall.session ? 'hall' : 'game');
    if (st.bgm) audio.playMusic(st.bgm, { volume: Number(st.bgmVolume ?? 1), fadeIn: 0.45 });
    else audio.stopMusic({ fade: 0.4 });
  }

  goMenu() {
    this._loadToken++;           // 作废进行中的加载
    this._clearReplay();
    this.state = 'menu';
    this.paused = false;
    this.overlay = false;
    this.frozen = false;
    this.entry = null;
    this.pack = null;
    this._stopAudio();
    store.setAssetScope(null);
    hideScreens();
    showScreen('menu');
    this.hallbar.show(false);
    this.hud.show(false);
    this.hud.setLockHint(false);
    this.input.exitLock();
    if (this.backdrop) this._useView(this.backdrop.view);
  }

  async playHall() {
    const token = ++this._loadToken;   // 作废进行中的关卡加载
    // 首次建造大厅：给加载界面（大厅本身很小，通常一闪而过）
    if (!this.hall) {
      this._loadingOpen('云端卧室', '正在铺开云海…');
      await this._nextFrame();
      await this._nextFrame();
      if (token !== this._loadToken) return;
      this.hall = new Hall({
        engine: this.engine, input: this.input,
        onOpenLevels: () => this.openLevels('hall'),
        onHint: (t) => { /* 大厅提示走 hud */ void t; },
      });
      this._loadingProgress(70, '正在准备场景…');
      try { await this.hall.session.whenReady(); } catch (e) { /* ignore */ }
      if (token !== this._loadToken) return;
      // 同关卡：先把大厅视图交给引擎并等缓存 / 首帧渲染完，再撤下加载界面
      this.state = 'loading';
      this._useView(this.hall.view);
      this._loadingProgress(92, '正在渲染场景…');
      await this.engine.warmup(this.hall.session.scene, this.hall.view.camera);
      if (token !== this._loadToken) return;
      await this._nextFrame();
      await this._nextFrame();
      if (token !== this._loadToken) return;
      this._loadingProgress(100, '准备就绪');
    } else {
      this.hall.reset(); this._playSessionAudio();   // 重进大厅：把停掉的 BGM / 环境音放回来
    }
    this.state = 'hall';
    this.paused = false;
    this.overlay = false;
    hideScreens();
    this.hallbar.show(true);
    this.hud.show(true);
    this.hud.setHallMode(true);
    this.hud.reset();
    this._useView(this.hall.view);
    this._tryLock();
  }

  goHall() {
    // 试玩中「返回大厅」= 回到编辑器
    if (this.testing && this.editor && this.editor.opened) { this._exitTest(); return; }
    this._clearReplay();
    if (this.session) { this.session.dispose(); this.session = null; }
    this.testing = false;
    this.pack = null;            // 回大厅即离开关卡包
    store.setAssetScope(null);
    this.playHall();
  }

  /* ---------- 关卡 ---------- */
  async startLevel(level, opts = {}) {
    if (!level) { toast('关卡数据无效', 'err'); return; }
    // 脚本安全闸门：事件里的 JS 代码块会执行任意代码，含脚本的关卡首次进入前弹窗确认。
    // 编辑器「试玩 / 在此处测试」（opts.test）跑的是作者自己写的脚本，不打扰。
    if (!opts.test && levelHasScripts(level) && !this._scriptAck.has(level.id)) {
      const ok = await confirmBox(
        '这张地图的事件里含有 JS 代码块，进入后会执行任意代码 —— 只在你信任它的来源时继续。',
        { title: '该关卡包含脚本', ok: '仍然进入', danger: true },
      );
      if (!ok) return;
      this._scriptAck.add(level.id);
    }
    this._clearReplay();        // 先撤掉正在进行的回放（要趁旧会话还在，好恢复幽灵状态）
    if (this.session) { this.session.dispose(); this.session = null; }
    this._stopAudio();          // 清掉上一关残留的 BGM / 环境音，新关卡在会话构造里重新放
    // 每次进入关卡都用一份全新的关卡数据：会话运行期会就地改写对象状态
    // （事件的 showObject/setProperty、位移/旋转/缩放补间、被打碎的物件等），
    // 若直接复用同一份数据，重开关卡时这些状态会残留下来（事件不会重置）
    const lv = deepClone(level);
    this.entry = opts.entry || this.entry;
    this.pack = (this.entry && this.entry.pack) || opts.pack || null;
    this.testing = !!opts.test;
    // 素材按关卡分池：解析本关素材时给服务器一个直查提示
    store.setAssetScope(lv.id);

    const token = ++this._loadToken;
    this._loadingOpen(lv.name, '正在构建梦境…');
    // 本局的地图变体：读冷却计数也是异步的，先定下来再建场景
    const mods = await this._resolveModifiers(opts);
    if (token !== this._loadToken) return;
    // 关卡构建（对象 / 物理 / AO）是同步的，会独占主线程：先让加载界面画出来
    await this._nextFrame();
    await this._nextFrame();
    if (token !== this._loadToken) return;

    let session = null;
    try {
      session = new LevelSession({
        engine: this.engine,
        level: lv,
        input: this.input,
        spawn: opts.spawn || null,   // 编辑器「在此处测试」指定的出生点
        hall: false,
        packId: (this.pack && this.pack.id) || '',   // 包内游玩：成绩存独立复合键
        modifiers: mods,             // 地图变体（镜像 / 时间流速）
        // 正式进入游戏：加载完先倒数（显示在屏幕上），倒完才开始计时；试玩不倒计时。
        // 关卡可在编辑器里关闭「开局倒数」或改秒数（level.settings.startCountdown / countdownTime）
        countdown: opts.test ? 0
          : (lv.settings.startCountdown === false ? 0 : Math.max(0, Number(lv.settings.countdownTime ?? 3))),
        onLoadProgress: (done, total) => {
          const pct = total > 0 ? 40 + Math.round((done / total) * 55) : 95;
          this._loadingProgress(pct, `正在加载素材与模型（${done}/${total}）…`);
        },
        hooks: {
          onWin: (rec) => this._onWin(rec),
          onFail: (rec) => this._onFail(rec),
          onDeath: () => { },
          onDamage: (n) => this.hud.flashDamage(n),
          onHint: () => { },
          onBanner: () => { },
          onNotice: (text, kind, dur) => this.hud.notice(text, kind, dur),
          // 事件脚本里的 log(...) → 编辑器「输出」面板（正常游戏时没有面板，落控制台）
          onLog: (text, kind) => { if (this.editor) this.editor.log(text, kind); },
          onPickup: () => { },
          onReplay: (rec) => this._onReplayRecorded(rec),
        },
      });
    } catch (e) {
      console.error('[app] 关卡加载失败', e);
      this._loadingFail();
      toast('关卡加载失败：' + (e && e.message ? e.message : e), 'err', 4200);
      if (this.testing) this._exitTest();
      return;
    }
    // 构建期间又发起了新的加载（例如连点两次回放 / 快速换关）：这份会话立刻销毁，
    // 绝不允许它留在场景里 —— 否则看到的就是上一份地图的残留
    if (token !== this._loadToken) {
      try { session.dispose(); } catch (e) { /* ignore */ }
      return;
    }
    this.session = session;
    // 等关卡引用的导入素材（自定义贴图 / 全景图 / 外部模型 .glb/.gltf）全部就绪再进关，
    // 避免进去之后贴图才一张张、模型才一个个“跳出来”
    this._loadingProgress(40, '正在加载素材与模型…');
    try { await session.whenReady(); } catch (e) { console.warn('[app] 素材加载失败', e); }
    if (token !== this._loadToken) return;   // 期间又发起了新的加载 / 玩家已离开
    // 先把关卡视图交给引擎（加载界面仍盖在上层），并等所有着色器预编译完成，
    // 再等两帧让首帧真正画到画布上 —— 这样撤下加载界面时看到的就是完整渲染好的画面，
    // 不会出现进关后模型 / 贴图才一个个“跳出来”或卡一下的情况。
    // state 先记为 loading：这几帧只渲染、不推进会话模拟（等正式进关才开始倒数 / 计时）
    this.state = 'loading';
    this._useView(session.view);
    this._loadingProgress(92, '正在渲染场景…');
    await this.engine.warmup(session.scene, session.view.camera);
    if (token !== this._loadToken) return;
    await this._nextFrame();
    await this._nextFrame();
    if (token !== this._loadToken) return;

    this._loadingProgress(100, '准备就绪');
    this.state = 'game';
    this.paused = false;
    this.frozen = false;
    this.overlay = false;
    hideScreens();
    this.hallbar.show(false);
    this.hud.show(!opts.replay);
    this.hud.setHallMode(false);
    this.hud.reset();
    this._showTestPanel(this.testing && !opts.replay);

    if (opts.replay) {
      // 回放 / 运镜：挂上播放器，由它驱动幽灵玩家与相机
      const rp = new ReplayPlayer(session, opts.replay.rec, {
        mode: opts.replay.mode,
        edits: opts.replay.edits || null,
        variant: opts.replay.variant || null,
        autoplay: opts.replay.autoplay !== false,
        // 播完自动退出：不能在会话的 update 里直接拆会话（正在遍历它），
        // 记一个待办，交给下一帧的帧首处理
        onEnd: () => { this._replayEndPending = true; },
        // 「开始播放」要求地图一切重启：由 App 重建整个会话（详见 restartReplay）
        onRestart: () => { void this.restartReplay(); },
        // 拖动进度条「向前」：世界已模拟过这一段之后，交给会话确定性快进到目标（实时、廉价）
        onSeekForward: (t) => session.simulateReplayTo(t, Number(rp._worldT) || 0),
        // 拖动进度条「向后」：世界状态退不回去，重建整个会话再快进到目标时刻
        onSeekRestart: (t, playing) => { void this.restartReplay(t, playing); },
        // 剪辑面板等浮层打开时不允许重建（重建会 hideScreens 关掉面板、打断编辑），
        // 此时退回旧的「只对齐幽灵 + 即时补齐世界」行为
        canSeekRestart: () => !this.overlay,
      });
      session.setReplay(rp);
      // 带定位进入（重建会话后拖动进度条）：世界从 0 从头确定性重演到目标时刻，
      // 门 / 破坏 / 动画（洪水水位等）/ 液体 / 物理 / 粒子全部回到那一刻该有的样子
      const seekTo = Number(opts.replay.seekTo) || 0;
      if (seekTo > 0) session.simulateReplayTo(seekTo, 0);
      this.replay = rp;
      this.replayHud.setPlayer(rp);
      this.replayHud.show(true);
      this.replayHud.refresh();
      this._useView(session.view);
      return;
    }

    // 正式游玩：开始记录这一局的行动（供回放 / 运镜）
    session.startRecord({ test: this.testing });
    this.replayHud.show(false);
    this._useView(session.view);
    this._tryLock();
  }

  /**
   * 彻底从零重新加载关卡数据：按关卡 id 回到最初来源重新读取
   * （编辑器当前关卡 / 内置 / 自定义 / 我的存档），而不是复用内存里那份。
   * 关卡包里引用的关卡同样走这里，因为它们本质上就是内置 / 自定义 / 我的关卡。
   */
  async reloadLevelData() {
    const e = this.entry;
    if (!e) return null;
    // 试玩：数据在编辑器里，取编辑器当前状态
    if (e.kind === 'test') return (this.editor && this.editor.level) || e.level || null;
    if (e.id) {
      try { await loadCustomLevels(); } catch (err) { console.warn('[app] 自定义关卡载入失败', err); }
      // 存档优先、其次内置：编辑器保存过的关卡（含内置关卡的改动）在重开时才能被用上
      try {
        const rec = await store.getLevel(e.id);
        if (rec && rec.data) { const lv = normalizeLevel(deepClone(rec.data)); lv.id = rec.id; return lv; }
      } catch (err) { console.warn('[app] 关卡重新加载失败', err); }
      const builtin = freshBuiltinLevel(e.id);   // 重跑工厂：不返回会被就地改写的单例
      if (builtin) return normalizeLevel(builtin);
    }
    // 兜底：真找不到来源就用手里这份（深拷贝一份，别让会话把这份原始数据改脏）
    return e.level ? normalizeLevel(deepClone(e.level)) : null;
  }

  /**
   * 定下本局的地图变体（MapModifier）：
   * · 显式传了 modifiers（重开本关）→ 沿用，别让人死一次地图就变回来；
   * · 回放 → 只继承记录里的「镜像」（时间变体由播放器自己的倍速决定，不叠加）；
   * · 编辑器试玩 → 不套变体，保证所见即所得；
   * · 其余 → 按选关面板的设置抽取（默认「意外惊喜」，命中后有冷却）。
   */
  async _resolveModifiers(opts) {
    if (opts.modifiers) return normalizeModifier(opts.modifiers);
    if (opts.replay) {
      const m = opts.replay.rec && opts.replay.rec.mod;
      return { mirror: !!(m && m.mirror), time: 1, surprise: false };
    }
    if (opts.test) return { ...NO_MODIFIER };
    return rollModifier(settings.get('modifier.mode', 'auto'));
  }

  async restartLevel() {
    if (!this.entry) { this.goHall(); return; }
    this.paused = false;
    const test = this.testing;      // 试玩状态要沿用（否则「返回大厅」会回不到编辑器）
    const entry = this.entry;
    // 重开沿用本局已经抽到的变体：地图不该在重试时突然镜像回去 / 换速率
    const modifiers = this.session ? normalizeModifier(this.session.modifiers) : null;
    const level = await this.reloadLevelData();
    // 重新加载是异步的（我的关卡要读存档）：期间玩家可能已经退出关卡 / 回到菜单，
    // 这时不能再把刚重开的关卡塞回去（否则会把人从大厅硬拉回游戏）
    if (this.entry !== entry || this.state !== 'game') return;
    if (!level) { toast('关卡数据已失效，无法重新开始', 'err'); this.goHall(); return; }
    this.startLevel(level, { entry, test, spawn: test ? this._testSpawn : null, modifiers });
  }

  _onWin(rec) {
    if (this.testing) { toast('试玩完成：通关', 'ok'); setTimeout(() => this._exitTest(), 600); return; }
    audio.win(0.6);
    this.frozen = false;
    // 通关后玩家无敌（不受伤/不死亡），直接弹出关卡选择，可继续在关卡里自由走动
    if (this.session && this.session.player) this.session.player.invincible = true;
    if (rec) toast('通关！用时 ' + fmtTime(rec.time) + ' · 死亡 ' + rec.deaths, 'ok', 2600);
    // 关卡包里的关卡：当前档位下若下一节点无分支，直接自动进入；否则回到节点地图继续剧情
    if (this.pack) { this._onPackWin(this.pack); return; }
    this.openLevels('win');
  }

  /**
   * 关卡包通关处理：当前难度档位下，若当前节点的下一节点唯一（无分支），
   * 通关后自动进入该节点；有分支（0 条或 ≥2 条出边）时回到节点地图让玩家选择。
   */
  async _onPackWin(pack) {
    const node = this.entry && this.entry.node;
    let next = null;
    if (node) {
      try { next = await this._packNextNode(pack, node); } catch (e) { next = null; }
    }
    if (next && next.levelId) {
      const level = await this._loadPackLevel(next.levelId);
      if (level) {
        toast('自动进入下一关：' + (next.title || level.name), 'ok', 2400);
        this.startLevel(level, {
          entry: { id: level.id, name: level.name, difficulty: level.difficulty, level, kind: 'pack', pack, node: next },
        });
        return;
      }
    }
    this.openLevelMap(pack, 'win');
  }

  /** 当前档位下 node 的唯一后继节点；有分支（0 或 ≥2 条出边）时返回 null */
  async _packNextNode(pack, node) {
    const tiers = await loadPackTiers();
    const tier = resolveTier(pack, tiers[pack.id]);
    const view = packView(pack, tier);
    const outs = [];
    for (const e of view.edges || []) if (e[0] === node.id && outs.indexOf(e[1]) < 0) outs.push(e[1]);
    if (outs.length !== 1) return null;
    return nodeOf(view, outs[0]);
  }

  /** 按关卡 id 取一份干净的关卡对象（我的存档优先，其次内置 / 自定义） */
  async _loadPackLevel(id) {
    if (!id) return null;
    try { await loadCustomLevels(); } catch (e) { /* 没有自定义目录时忽略 */ }
    try {
      const rec = await store.getLevel(id);
      if (rec && rec.data) { const lv = normalizeLevel(deepClone(rec.data)); lv.id = rec.id; return lv; }
    } catch (e) { /* ignore */ }
    const builtin = freshBuiltinLevel(id);
    if (builtin) return normalizeLevel(builtin);
    const cached = getBuiltinLevels().find((l) => l.id === id);
    return cached ? normalizeLevel(deepClone(cached)) : null;
  }

  _onFail(rec) {
    if (this.replay) return;      // 回放里重演到失败：不走真实结算
    if (this.testing) { toast('试玩结束：失败', 'err'); setTimeout(() => this._exitTest(), 600); return; }
    // 结算界面会把逻辑更新冻住，收尾计时不会自己跑完 —— 在这里立刻把本局记录收尾落盘
    if (this.session) this.session.stopRecord();
    const rp = this._lastReplay;
    this.frozen = true;
    this.input.exitLock();
    this.overlay = true;
    this.resultPanel.fill({
      win: false,
      title: '梦碎了',
      sub: (rec && rec.reason) || '再来一次吧',
      stats: [
        { l: '坚持', v: fmtTime(rec ? rec.time : 0) },
        { l: '死亡', v: String(rec ? rec.deaths : 0) },
      ],
      hasNext: false,
      replay: !!rp,
      cine: !!(rp && rp.win),
    });
    showScreen('result');
  }

  /* ============================================================
     回放 / 混剪
     ============================================================ */
  /** 一局打完：按阈值决定要不要落盘（记录仪在会话里已经收尾） */
  async _onReplayRecorded(rec) {
    this._lastReplay = rec;
    // 阈值：本局时长要达到关卡时长的百分之多少才值得存（关卡不限时 / 阈值为 0 时全都存）
    const pct = clamp(Number(settings.get('replay.saveRatio', 30)) || 0, 0, 200);
    const need = (Number(rec.levelTime) || 0) * pct / 100;
    // 通关局无论如何都留下 —— 它是解锁电影级剪辑的凭据
    if (!rec.win && need > 0 && rec.duration < need) {
      toast(`本局太短（${fmtTime(rec.duration)} < 关卡时长的 ${Math.round(pct)}%），未占存档位`, 'warn', 3200);
      return;
    }
    try { await saveReplay(rec); } catch (e) { console.warn('[replay] 保存失败', e); }
    // 只保留最近若干条，避免存档无限膨胀
    try {
      const all = await listReplays();
      for (const r of all.slice(REPLAY_KEEP)) await deleteReplay(r.id);
    } catch (e) { /* ignore */ }
    this.pauseMenu.setReplayAvailable(true);
    if (rec.win) toast('已存回放 · 通关解锁「电影级运镜剪辑」（菜单 → 游玩回放）', 'ok', 4200);
    else toast('本局回放已保存（菜单 → 游玩回放）', 'ok', 3000);
  }

  /** 退出回放：撤掉播放器与幽灵状态 */
  _clearReplay() {
    if (this.replay) { try { this.replay.dispose(); } catch (e) { console.warn(e); } }
    this.replay = null;
    if (this.replayHud) this.replayHud.show(false);
  }

  /**
   * 按关卡 id 彻底重新取一份干净的关卡数据（回放专用）。
   * 回放是「重演」，必须从最初来源重新读一份：上一局游玩会在内存里就地改写
   * 对象状态（开的门、拿的道具、被打碎的东西），素材本地化也会改写引用；
   * 内置关卡更是全局单例，直接复用会让两次回放互相串味。
   * 来源优先级：我的存档 → 内置（重跑工厂拿全新一份）→ 自定义（深拷贝）→ 兜底深拷贝。
   */
  async _loadLevelById(id) {
    if (!id) return null;
    try { await loadCustomLevels(); } catch (e) { /* ignore */ }
    try {
      const r = await store.getLevel(id);
      // 存档读出来的 data 也先深拷贝再规范化：后端可能是内存里的那份，
      // 规范化会就地补字段，别把库里的原始数据改脏
      if (r && r.data) { const lv = normalizeLevel(deepClone(r.data)); lv.id = r.id; return lv; }
    } catch (e) { /* ignore */ }
    const b = freshBuiltinLevel(id);              // 不走会被就地改写的单例缓存
    if (b) return normalizeLevel(b);
    const cached = getBuiltinLevels().find((l) => l.id === id);
    if (cached) return normalizeLevel(deepClone(cached));
    return null;
  }

  async openReplays() {
    this._panelFrom = 'menu';
    this.overlay = true;
    this.input.exitLock();
    hideScreens();
    showScreen('replays');
    await this.refreshReplays();
  }

  async refreshReplays() {
    let items = [];
    try {
      // 解析交给 Worker：server 模式直接拿原始文本，idb 模式把整表交给线程池
      const text = await store.allText('kv').catch(() => null);
      const kv = text ? null : await store.all('kv').catch(() => []);
      const proj = await runListTask('replayList', text ? { kvText: text } : { kv: kv || [] });
      items = (proj && proj.items) || [];
    } catch (e) { console.warn('[replay] 列表读取失败', e); }
    this.replayPanel.open(items);
  }

  async deleteReplayRec(id) {
    if (!(await confirmBox('删除这条回放记录？'))) return;
    try { await deleteReplay(id); } catch (e) { /* ignore */ }
    await this.refreshReplays();
  }

  /** 批量删除回放：只弹一次确认 */
  async deleteReplayRecs(ids) {
    if (!ids || !ids.length) return;
    if (!(await confirmBox(`删除所选的 ${ids.length} 条回放记录？`, { title: '批量删除回放', danger: true }))) return;
    for (const id of ids) {
      try { await deleteReplay(id); } catch (e) { /* ignore */ }
    }
    await this.refreshReplays();
  }

  async clearReplays() {
    if (!(await confirmBox('删除全部回放记录？', { danger: true }))) return;
    try {
      const all = await listReplays();
      for (const r of all) await deleteReplay(r.id);
    } catch (e) { /* ignore */ }
    await this.refreshReplays();
  }

  /** 播放某条回放（mode: 'direct' | 'pov' | 'cinema'） */
  async playReplay(id, mode) {
    const rec = await loadReplay(id);
    if (!rec) { toast('回放记录已失效', 'err'); return; }
    if (mode === 'cinema' && !rec.win) { toast('通关后才解锁电影级剪辑', 'warn'); mode = 'direct'; }
    const level = await this._loadLevelById(rec.levelId);
    if (!level) { toast('找不到该回放对应的关卡', 'err'); return; }
    await this.startLevel(level, {
      entry: { id: level.id, name: level.name, difficulty: level.difficulty, level, kind: 'replay' },
      replay: { rec, mode: mode || 'direct' },
    });
  }

  /** 结算面板 / 暂停菜单：看刚打完那局的回放 */
  async openLatestReplay(mode) {
    let rec = this._lastReplay;
    if (!rec) {
      try {
        const all = await listReplays();
        if (all.length) rec = await loadReplay(all[0].id);
      } catch (e) { /* ignore */ }
    }
    if (!rec) { toast('还没有回放记录', 'err'); return; }
    if (mode === 'cinema' && !rec.win) mode = 'direct';
    const level = await this._loadLevelById(rec.levelId);
    if (!level) { toast('找不到该回放对应的关卡', 'err'); return; }
    await this.startLevel(level, {
      entry: { id: level.id, name: level.name, difficulty: level.difficulty, level, kind: 'replay' },
      replay: { rec, mode: mode || 'direct' },
    });
  }

  /** 离开回放：一律回主菜单 */
  exitReplay() {
    this._replayEndPending = false;
    // 收尾分两步、各自兜异常：任何一步炸掉都不许把玩家留在一张「已经拆掉的地图」上
    // （会话拆了、视图却还指着它的场景 = 画面冻在地图里，而界面回不去）。
    const rp = this.replay;
    this.replay = null;
    try { if (rp) rp.dispose(); } catch (e) { console.warn('[replay] 幽灵收尾失败', e); }
    try { if (this.session) this.session.dispose(); } catch (e) { console.warn('[replay] 会话销毁失败', e); }
    this.session = null;
    // 退出即回主菜单（而不是回放列表 / 大厅）：回放看完就该回到「外面」，
    // 从哪儿进来都一样 —— 之前按来路分派，播完只剩一个「回列表」，
    // 想回主菜单还得再点一次，看起来就像卡在关卡里。
    this.goMenu();
  }

  /**
   * 从头重播当前回放，并且「地图一切重启」：直接重建整个会话
   * （builder / 机关 / 事件 / 液体 / 物理世界全部换新），而不是在当前世界里倒带 ——
   * 上一遍开过的门、砸开的墙、扔出去的投掷物，只有重建才清得干净。
   * 剪辑好的镜头表（edits）原样带过去，所以「应用并播放」看到的就是刚剪的那版。
   * @param seekTo   定位到的时间（秒，0 = 从头）。拖动进度条向后时用它把世界快进到该时刻。
   * @param resumePlaying 重建后是否继续播放（默认 true；拖动进度条时沿用拖动前的播放状态）
   */
  async restartReplay(seekTo, resumePlaying) {
    const goal = clamp(Number(seekTo) || 0, 0, this.replay ? this.replay.duration : 0);
    const playing = resumePlaying !== false;
    // 重载要跨越好几帧：期间若又拖了进度条，只记下最新落点，等这次重建完再补一次，
    // 不重复发起（否则连点「播放」/ 连续拖动会堆出一串互相打断的会话重建）
    if (this._replayRestarting) { this._replayPendingSeek = { t: goal, playing }; return; }
    const rp = this.replay;
    const entry = this.entry;
    if (!rp || !entry) return;
    const rec = rp.rec;
    const mode = rp.mode;
    const edits = rp.edits || null;
    const variant = rp.variant || null;      // 多样剪辑：重启后仍是同一版（同一 (style, seed) 逐字段一致）
    this._replayRestarting = true;
    try {
      const level = await this.reloadLevelData();
      // 重载是异步的（我的关卡要读存档）：期间玩家可能已经退出回放 / 回到菜单，这时不能再塞回去
      if (this.entry !== entry || this.state !== 'game') return;
      if (!level) { toast('关卡数据已失效，无法重播', 'err'); return; }
      this.paused = false;
      this.overlay = false;
      await this.startLevel(level, {
        entry,
        replay: { rec, mode, edits, variant, autoplay: playing, seekTo: goal },
      });
    } finally {
      this._replayRestarting = false;
      const pend = this._replayPendingSeek;
      this._replayPendingSeek = null;
      // 重建期间又拖了进度条：落点变了才补一次（没变就沿用刚重建好的这一版）
      if (pend && this.replay && this.state === 'game' && Math.abs(pend.t - goal) > 0.05) {
        void this.restartReplay(pend.t, pend.playing);
      }
    }
  }

  /** 打开电影级运镜剪辑面板（仅通关记录可用） */
  openCine() {
    const rp = this.replay;
    if (!rp) return;
    if (!rp.rec || !rp.rec.win) { toast('通关后才解锁电影级运镜剪辑', 'warn'); return; }
    if (rp.mode !== 'cinema') rp.setMode('cinema');
    rp.pause();
    this.overlay = true;
    this._panelFrom = 'cine';
    hideScreens();
    showScreen('cine');
    this.cinePanel.open(rp);
  }

  closeCine() {
    this.overlay = false;
    this._panelFrom = null;
    hideScreens();
    const restart = this._replayRestartOnClose;
    this._replayRestartOnClose = false;
    if (!this.replay) return;
    // 「应用并播放」= 从头播一遍刚剪好的片子，地图连同世界状态一起重启；
    // 单纯关掉面板则继续往下放。
    if (restart) void this.restartReplay();
    else this.replay.play();
  }

  /* ---------- 角色皮肤编辑器 ---------- */
  /** 打开角色皮肤编辑器（独立窗口：画布全屏，左侧浮层面板） */
  async openSkin() {
    this._panelFrom = 'menu';
    this.overlay = true;
    this.input.exitLock();
    this.engine.setRect(null);       // 画布必须全屏，编辑器面板浮在上面
    hideScreens();
    showScreen('skin');
    try { await this.skinEditor.open(); } catch (e) { console.warn('[skin] 打开失败', e); }
  }

  /** 关闭角色皮肤编辑器：一律回主菜单（画布恢复云海） */
  closeSkin() {
    this.overlay = false;
    this._panelFrom = null;
    try { this.skinEditor.close(); } catch (e) { console.warn('[skin] 关闭失败', e); }
    this.goMenu();
  }

  /** 回放模式下的按键 */
  _onReplayKey(e) {
    const rp = this.replay;
    if (!rp) return;
    if (e.code === 'Escape') { this.exitReplay(); return; }
    if (e.code === 'Space') { e.preventDefault(); rp.toggle(); }
    else if (e.code === 'ArrowLeft') rp.step(-1);
    else if (e.code === 'ArrowRight') rp.step(1);
    else if (e.code === 'KeyC') rp.cycleMode();
    else if (e.code === 'KeyP') this.openCine();
    else if (e.code === 'ArrowUp') rp.setSpeed(Math.min(3, rp.speed + 0.25));
    else if (e.code === 'ArrowDown') rp.setSpeed(Math.max(0.25, rp.speed - 0.25));
  }

  /* ---------- 暂停 ---------- */
  setPaused(on) {
    if (this.state !== 'game') return;
    this.paused = !!on;
    if (this.session) this.session.setPaused(this.paused);
    if (on) {
      this.overlay = true;
      showScreen('pause');
      this.input.exitLock();
    } else {
      this.overlay = false;
      hideScreens();
      this._tryLock();
    }
  }

  /* ============================================================
     面板
     ============================================================ */
  openLevels(from) {
    this._panelFrom = from || 'hall';
    this.overlay = true;
    this.input.exitLock();
    if (this._panelFrom === 'pause') this.paused = true;
    this.levelPanel.setMode(this._panelFrom);
    showScreen('levels');
    this.levelPanel.open();
  }

  /** 打开关卡包的节点地图（from: hall / levels / win / pause / editor） */
  openLevelMap(pack, from) {
    if (!pack) return;
    this._panelFrom = from || 'hall';
    this.overlay = true;
    this.input.exitLock();
    if (this._panelFrom === 'pause') this.paused = true;
    hideScreens();
    showScreen('lvmap');
    this.mapPanel.open(pack);
  }

  async openSaves() {
    this._panelFrom = 'menu';
    this.overlay = true;
    this.input.exitLock();
    hideScreens();
    showScreen('saves');
    await this.savesPanel.refresh();
  }

  openSettings(from) {
    this._panelFrom = from || 'menu';
    this.overlay = true;
    this.input.exitLock();
    showScreen('settings');
    this.settingsPanel.open();
  }

  openHelp(from) {
    this._panelFrom = from || 'menu';
    this.overlay = true;
    showScreen('help');
    this.helpPanel.open();
  }

  /** 关闭当前面板，回到来源 */
  closeOverlay(id) {
    const from = this._panelFrom;
    this.overlay = false;
    if (from === 'pause' && this.state === 'game') {
      showScreen('pause');
      return;
    }
    if (from === 'win' && this.state === 'game') {
      // 通关后的关卡选择：关闭即返回关卡继续自由走动（玩家已无敌）
      hideScreens();
      this._tryLock();
      return;
    }
    if (from === 'editor') {
      hideScreens();
      return;
    }
    if (id === 'levels' && from === 'hall' && this.state === 'hall' && this.hall) {
      // 大厅里退出选关：把玩家传送回初始点，否则仍站在传送门里会立刻又触发选关
      hideScreens();
      this.hall.returnToSpawn();
      this._tryLock();
      return;
    }
    hideScreens();
    if (this.state === 'menu') showScreen('menu');
  }

  _onSettingsChanged(path) {
    if (path === '*' || path.startsWith('video.')) this.engine.applyQuality();
    if (path === '*' || path.startsWith('camera.') || path.startsWith('mouse.')) {
      const s = this.session || (this.hall && this.hall.session);
      if (s && s.cameraCtl && s.cameraCtl.applySettings) s.cameraCtl.applySettings();
    }
  }

  /* ============================================================
     编辑器
     ============================================================ */
  async openEditor(level, rec) {
    if (!level) { toast('关卡数据损坏', 'err'); return; }
    const token = ++this._loadToken;   // 作废进行中的加载
    this._clearReplay();
    this._loadingOpen(level.name, '正在打开编辑器…');
    await this._nextFrame();
    await this._nextFrame();
    if (token !== this._loadToken) return;
    // 每次进编辑器都彻底重新加载地图：按 id 回到来源重新读一份，
    // 不复用调用方手里那份内存关卡（上一局游玩 / 上一次编辑会就地改写对象状态、
    // 素材本地化也会改写引用；内置关卡更是全局单例，改脏后连游玩都会跟着变）
    const fresh = await this._freshLevelForEdit(level);
    if (token !== this._loadToken) return;
    if (fresh) level = fresh;
    try {
      if (!this.editor) {
        const mod = await import('./editor/editor.js');
        this.editor = new mod.Editor({ engine: this.engine, input: this.input, app: this });
      }
      if (token !== this._loadToken) return;
      this.state = 'editor';
      this.overlay = false;
      this._stopAudio();          // 从大厅/关卡直接进编辑器时，别把上一处的 BGM 带进来
      this.testPoints = [];       // 换了关卡：测试位点重来
      this.testPointIx = -1;
      this._testSpawn = null;
      this._showTestPanel(false);
      this.hallbar.show(false);
      this.hud.show(false);
      this.hud.setLockHint(false);
      this.input.exitLock();
      // editor.open 是同步重活（建对象 / 物理 / AO）：让加载界面盖住它，之后再收
      this.editor.open(level, rec);
      this._loadingProgress(100, '准备就绪');
      hideScreens();
      this._useView(this.editor.view);
    } catch (e) {
      console.error('[app] 编辑器启动失败', e);
      toast('编辑器启动失败：' + (e && e.message ? e.message : e), 'err', 4200);
      this.goMenu();
    }
  }

  /**
   * 进编辑器前重新取一份干净的关卡数据（与 reloadLevelData 同一套来源优先级：
   * 我的存档 → 内置 / 自定义）。拿不到来源时至少深拷贝一份，
   * 保证编辑器永远改不到调用方那份共享对象。
   */
  async _freshLevelForEdit(level) {
    const id = level && level.id;
    if (id) {
      try { await loadCustomLevels(); } catch (e) { console.warn('[app] 自定义关卡载入失败', e); }
      try {
        const rec = await store.getLevel(id);
        if (rec && rec.data) { const lv = normalizeLevel(rec.data); lv.id = rec.id; return lv; }
      } catch (e) { console.warn('[app] 编辑器关卡重新加载失败', e); }
      const builtin = freshBuiltinLevel(id);
      if (builtin) return builtin;
      const cached = getBuiltinLevels().find((l) => l.id === id);   // 自定义关卡（静态文件载入）
      if (cached) return deepClone(cached);
    }
    return deepClone(level);
  }

  exitEditor() {
    if (this.editor) this.editor.close();
    this.engine.setRect(null);
    this.goMenu();
  }

  /** 编辑器里点“试玩”（spawn 为「在此处测试」指定的出生点 [x,y,z]，可省略） */
  startTest(level, spawn) {
    this._testSpawn = spawn || null;
    // 「在此处测试」指定的点直接算作第一个测试位点：试玩中按 R 就能回到这里
    if (spawn) this._addTestPoint(spawn[0], spawn[1], spawn[2]);
    this._testEntry = { id: level.id, name: level.name, difficulty: level.difficulty, level, kind: 'test' };
    this.startLevel(level, { entry: this._testEntry, test: true, spawn: this._testSpawn });
  }

  _exitTest() {
    this._loadToken++;           // 作废进行中的加载
    this._clearReplay();
    if (this.session) { this.session.dispose(); this.session = null; }
    this._stopAudio();          // 试玩结束回到编辑器：把试玩关卡的 BGM / 环境音也停掉
    this.testing = false;
    this._testSpawn = null;
    this._showTestPanel(false);
    this.state = 'editor';
    this.paused = false;
    this.frozen = false;
    this.overlay = false;
    hideScreens();
    this.hud.show(false);
    this.hud.setLockHint(false);
    this.input.exitLock();
    if (this.editor) {
      this.editor.resume();
      this._useView(this.editor.view);
    } else {
      this.goMenu();
    }
  }

  /* ============================================================
     编辑器试玩：测试位点（E 记录 / R 传送，仅试玩中可用）
     ============================================================ */
  /** 记入一个位点（已存在则只选中它），返回下标 */
  _addTestPoint(x, y, z) {
    const same = (p) => Math.abs(p.x - x) < 0.05 && Math.abs(p.y - y) < 0.05 && Math.abs(p.z - z) < 0.05;
    let i = this.testPoints.findIndex(same);
    if (i < 0) { this.testPoints.push({ x, y, z }); i = this.testPoints.length - 1; }
    this.testPointIx = i;
    return i;
  }

  /** E：把玩家当前站位记为测试位点 */
  markTestPoint() {
    const s = this.session;
    if (!this.testing || !s || !s.player || !s.player.alive) return;
    const f = s.player.feetPos;
    const i = this._addTestPoint(round(f.x, 2), round(f.y, 2), round(f.z, 2));
    this.renderTestPanel();
    toast(tpl('已记录测试位点 {0}：{1}', i + 1, fmtPos(this.testPoints[i])), 'ok', 1600);
  }

  /** R：传送到当前选中的测试位点 */
  gotoTestPoint() {
    if (!this.testing) return;
    if (!this.testPoints.length) { toast('还没有测试位点：按 E 记录当前站位', 'err', 1800); return; }
    const s = this.session;
    if (!s || !s.player || s.status !== 'playing') return;
    const i = this.testPointIx >= 0 && this.testPointIx < this.testPoints.length ? this.testPointIx : 0;
    this.testPointIx = i;
    s.player.respawn(this.testPoints[i], true);
    this.renderTestPanel();
    toast(tpl('传送至测试位点 {0}', i + 1), 'ok', 1300);
  }

  _selectTestPoint(i) {
    if (!(i >= 0) || i >= this.testPoints.length) return;
    this.testPointIx = i;
    this.renderTestPanel();
  }

  _removeTestPoint(i) {
    if (!(i >= 0) || i >= this.testPoints.length) return;
    this.testPoints.splice(i, 1);
    if (this.testPointIx >= this.testPoints.length) this.testPointIx = this.testPoints.length - 1;
    this.renderTestPanel();
  }

  _showTestPanel(on) {
    if (!this.testPanel) return;
    this.testPanel.classList.toggle('hidden', !on);
    if (on) this.renderTestPanel();
  }

  renderTestPanel() {
    const list = $('#hud-testpts-list');
    if (!this.testPanel || !list) return;
    clear(list);
    this.testPoints.forEach((pt, i) => {
      list.appendChild(el('li', { class: 'tp-row' + (i === this.testPointIx ? ' on' : '') },
        el('b', { class: 'tp-ix', text: String(i + 1) }),
        el('span', { class: 'tp-pos', text: fmtPos(pt) }),
        el('button', { class: 'tp-btn', title: '传送至该位点', dataset: { tp: 'goto', i: String(i) }, text: '传送' }),
        el('button', { class: 'tp-btn del', title: '删除该位点', dataset: { tp: 'del', i: String(i) }, text: '✕' }),
      ));
    });
    this.testPanel.classList.toggle('empty', this.testPoints.length === 0);
  }

  /* ============================================================
     指针锁定
     ============================================================ */
  _tryLock() {
    if (this.state !== 'hall' && this.state !== 'game') return;
    if (this.replay) return;      // 回放不需要锁鼠标
    if (this.overlay) return;
    if (this.touch && this.touch.active) return;   // 触屏设备没有指针锁定，靠拖动转视角
    // 2D 平台模式：鼠标解绑，不再请求指针锁定
    if (this.session && this.session.cameraCtl && this.session.cameraCtl.platformOn) return;
    this.input.requestLock();
    this._lockTimer = 0.7;
  }

  _onLock(locked) {
    if (locked) { this.hud.setLockHint(false); return; }
    if (this.replay) return;      // 回放里失焦不弹暂停
    // 2D 平台模式本来就是解绑状态：失焦不是暂停信号
    if (this.session && this.session.cameraCtl && this.session.cameraCtl.platformOn) { this.hud.setLockHint(false); return; }
    if (this.overlay || this.state === 'menu' || this.state === 'editor') { return; }
    if (this.state === 'game') {
      if (!this.paused && !this.frozen) this.setPaused(true);
    } else if (this.state === 'hall') {
      this.hud.setLockHint(true);
    }
  }

  _onKey(e) {
    if (this.state === 'editor') return;   // 编辑器有自己的按键处理
    if (this.replay) { this._onReplayKey(e); return; }   // 回放有自己的按键
    // 编辑器试玩专属：E 记录测试位点 / R 传送至测试位点
    if (this.testing && this.state === 'game' && !e.repeat && !this.paused && !this.overlay && !this.frozen) {
      if (e.code === 'KeyE') { this.markTestPoint(); return; }
      if (e.code === 'KeyR') { this.gotoTestPoint(); return; }
    }
    if (e.code === 'Escape') this.back();
  }

  /**
   * 「返回」：Esc 与安卓返回键共用。
   * 关掉最上面一层，或在关卡里开关暂停；返回 false 表示已经退无可退
   * （安卓壳据此把应用退回桌面）。
   */
  back() {
    if (this.replay) {
      if (this.overlay && currentScreen() === 'cine') this.closeCine();
      else this.exitReplay();
      return true;
    }
    if (this.overlay) {
      // 面板由自身的关闭按钮处理；返回键直接关掉最上层
      if (currentScreen() === 'levels') this.closeOverlay('levels');
      else if (currentScreen() === 'lvmap') this.closeOverlay('lvmap');
      else if (currentScreen() === 'settings') this.closeOverlay('settings');
      else if (currentScreen() === 'help') this.closeOverlay('help');
      else if (currentScreen() === 'saves') this.closeOverlay('saves');
      else if (currentScreen() === 'skin') this.closeSkin();
      else if (currentScreen() === 'pause') this.setPaused(false);
      else if (currentScreen() === 'result') this.goHall();
      return true;
    }
    if (this.state === 'game') { this.setPaused(!this.paused); return true; }
    if (this.state === 'hall' && !this.input.pointerLocked) { this.goMenu(); return true; }
    return false;
  }

  /* ============================================================
     每帧
     ============================================================ */
  _frame(dt) {
    // 回放播到结尾：回放器是在「自己的一帧里」发现播完的，此时直接把会话拆掉
    // 会拆在它自己的调用栈上（正在用它已经 dispose 的对象）。推迟到帧首、拆完再往下走。
    if (this._replayEndPending) {
      this._replayEndPending = false;
      this.exitReplay();
      return;      // 会话已经在上面拆掉了，这一帧不能再按旧的 state 往下走
    }
    if (this.state === 'hall' && this.hall) {
      if (!this.overlay && !this.paused) this.hall.update(dt);
      this.hud.update(this.hall.session.hudInfo());
    } else if (this.state === 'game' && this.session) {
      if (!this.paused && !this.frozen) this.session.update(dt);
      if (this.replay) this.replayHud.refresh();
      else this.hud.update(this.session.hudInfo());
    } else if (this.state === 'editor' && this.editor) {
      this.editor.update(dt);
    } else if (this.skinEditor && this.skinEditor.active) {
      this.skinEditor.update(dt);       // 皮肤编辑器：驱动待机动画 / 相机
    } else if (this.backdrop && this.state === 'menu') {
      this.backdrop.update(dt);
    }

    // 锁定提示（显示若干秒后自动淡出；任何一次点击会重新计时）；触屏设备不需要锁鼠提示
    if (this._lockTimer > 0) this._lockTimer -= dt;
    const wantHint = !this.overlay && !this.input.pointerLocked && this._lockTimer <= 0 &&
      !this.replay &&
      !(this.session && this.session.cameraCtl && this.session.cameraCtl.platformOn) &&
      !(this.touch && this.touch.active) &&
      (this.state === 'hall' || this.state === 'game');
    if (wantHint) {
      if (this._hintT === undefined || this._hintT > 0) {
        if (this._hintT === undefined) this._hintT = 7;
        this._hintT -= dt;
        if (!this.hud.lockHint) this.hud.setLockHint(true);
      } else if (this.hud.lockHint) this.hud.setLockHint(false);
    } else {
      this._hintT = 7;
      if (this.hud.lockHint) this.hud.setLockHint(false);
    }

    if (this.touch) this.touch.tick();
    this.input.endFrame();
  }

  dispose() {
    if (this.session) this.session.dispose();
    if (this.hall) this.hall.dispose();
    if (this.editor) this.editor.close();
    disposeTextTextures();       // 释放文字方块 / 公告板的 canvas 贴图
    this.engine.dispose();
  }
}

/** 测试位点坐标显示：x, y, z */
function fmtPos(p) {
  return p.x.toFixed(1) + ', ' + p.y.toFixed(1) + ', ' + p.z.toFixed(1);
}