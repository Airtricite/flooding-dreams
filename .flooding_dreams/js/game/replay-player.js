/* ============================================================
   回放播放器
   ------------------------------------------------------------
   一个 ReplayPlayer 挂在一个「真实重建的关卡会话」上：
   · 关卡本身照常模拟（液体 / 机关 / 事件 / 动画 / 特效全跑），
     所以门会开、东西会被拿、终点会亮 —— 是真正的「重演」；
   · 玩家本体被改成静态体、位置由采样逐帧驱动（幽灵），
     不参与物理推挤，只用记录里的姿态 / 状态驱动模型动画；
   · 取景有三种：
     direct —— 直录回放：整局原样复现**玩家自己操作的那台相机**（记录里的 cx/cy/cz + ky/kp）。
               第三人称的拉近拉远 / 绕圈 / 抬头低头都一帧不差地再放一遍；当时若切到了
               游戏内第一人称，记下来的机位本来就在眼睛上，所以那几段也照样是对的。
     pov    —— 第一人称：不管当时用的是哪台相机，整局都换成玩家自己的眼睛 ——
               机位重建自记录里的**头部位置**，朝向取身体朝向并提前零点几秒看向将要到的地方
               （见 cine.js 的 `povAim`）；
     cinema —— 电影级运镜：整局 1:1 重演（不删减不留黑场），
               只把「机位与镜头切换」叠上去（Montage：射线挑机位 + 电影剪辑规则，
               斯坦尼康跟拍 / 沉浸 POV / 水面规避）。
   ============================================================ */
import { clamp, damp } from '../core/util.js';
import { audio } from '../core/audio.js';
import { ReplayData } from './replay.js';
import { Montage, PovPlayer, SHOT_TYPES } from './cine.js';

export const REPLAY_MODES = ['direct', 'pov', 'cinema'];
export const REPLAY_MODE_LABEL = { direct: '直录回放', pov: '第一人称', cinema: '电影运镜' };

/** 记录里属于「世界交互」的条目：回放时必须重演，否则地图不会跟着变 */
const WORLD_ACTS = new Set(['doorOpen', 'doorClose', 'click', 'break', 'throw', 'emit']);

/**
 * 「这一段当时是不是游戏内第一人称」的判定半径（studs）的平方。
 * 游戏内第一人称的机位 = 眼睛 + 视线方向 × 0.35，与头部（脚底 + totalH - 0.5）最多
 * 差约 0.9 studs；第三人称就算被墙挤到最近（收缩下限 2.6，从眼睛起算）也在 2 studs 开外。
 * 1.5 落在两者中间，两头都不会误判。
 */
const FIRST_PERSON_EYE2 = 1.5 * 1.5;

export class ReplayPlayer {
  /**
   * @param session LevelSession（已构建好的关卡会话）
   * @param rec     记录对象（ActionRecorder.finish 的产物）
   * @param opts    { mode:'direct'|'pov'|'cinema', edits:[], autoplay:true, onEnd:fn }
   */
  constructor(session, rec, opts = {}) {
    this.session = session;
    this.rec = rec || {};
    this.data = new ReplayData(this.rec);
    this.mode = REPLAY_MODES.includes(opts.mode) ? opts.mode : 'direct';
    this.playing = opts.autoplay !== false;
    this.speed = 1;
    this.clock = 0;
    this.onEnd = opts.onEnd || null;
    // 「开始播放」时请求重建整个会话（地图一切重启）：由 App 接手做整关重载
    this.onRestart = opts.onRestart || null;
    // 拖动进度条定位世界：向后拖 = 请求重建会话（世界状态无法回退，见 seek）；
    // 向前拖 = 交给会话把世界从已模拟到的时刻确定性地快进到现在。
    this.onSeekForward = opts.onSeekForward || null;
    this.onSeekRestart = opts.onSeekRestart || null;
    // 是否允许「重建会话」式定位：剪辑面板等浮层打开时为 false（重建会关掉面板 / 打断编辑）
    this.canSeekRestart = opts.canSeekRestart || null;
    this._worldT = 0;          // 世界已经模拟到的回放时刻（正常播放中恒等于 clock）
    this.worldRun = true;      // 本帧世界要不要跟着跑（暂停时为假：动画 / 事件全停）
    this.shake = 0;
    this.fade = 0;
    this.fadeColor = '#000';       // 遮罩颜色（切点转场：黑场 / 通关白场）
    this.edits = opts.edits || null;
    this.variant = opts.variant || null;   // 多样剪辑的「风格 + 种子」（null = 基准排片）

    this._wake = true;         // 需要对齐一次世界（刚进来 / 刚拖过进度条）
    this._maxT = 0;            // 这一次会话播到过的最远时刻（判断「是否播过 / 播完」）

    // BGM 卡点：关卡有背景音乐就分析它的节奏点，运镜切点会被吸附到最近的重音上。
    // 检测是异步的（要先解码），拿到之前先按「拐点吸附」排片，拿到之后再补一版。
    const L = session.level || {};
    this._bgmRef = (L.settings && L.settings.bgm) || '';
    this._bgmVolume = Number((L.settings && L.settings.bgmVolume) ?? 1);   // 回放里的 BGM 由播放器自己起停
    this._rhythm = null;
    this._autoPlan = true;     // 当前 montage 是否为「自动剪」（节奏点表晚到时可以重排）
    this._rhythmKicked = false;
    this._musAcc = 0;          // BGM 对齐的节流计时

    this._srcT = 0;
    this._srcYaw = 0;
    this._camS = {};           // 直录回放取相机位姿的复用对象
    this._evIx = 0;
    this._shotIndex = 0;
    this._shotLabel = '';
    this._shotType = '';
    this._ended = false;

    /* ---------- 幽灵玩家 ---------- */
    const p = session.player;
    this._saved = {
      type: p.body.type,
      collisionResponse: p.body.collisionResponse,
      anchored: p.anchored,
      invincible: p.invincible,
      statInvisible: p.statInvisible,
      inputFrozen: p.inputFrozen,
      modelVisible: p.model ? p.model.visible : true,
    };
    p.setInputFrozen(true);
    p.invincible = true;                    // 回放里不再真的死
    p.setAnchored(true);                    // STATIC：物理推不动它
    p.body.collisionResponse = false;       // 也别去顶门 / 推物件

    /* ---------- 相机 ---------- */
    const ctl = session.cameraCtl;
    this._savedCam = { mode: ctl.mode, wantDist: ctl.wantDist, dist: ctl.dist, fov: session.camera.fov };
    ctl.mode = 'third';
    ctl.wantDist = Math.max(14, Number(ctl.wantDist) || 14);
    ctl.dist = ctl.wantDist;

    this.pov = new PovPlayer(this.data, session.camera.fov);
    this.montage = null;
    if (this.mode === 'cinema') this.buildMontage(opts.edits || null);
  }

  /* ============================================================
     电影运镜
     ============================================================ */
  /**
   * 重新排片（edits 为空则按规则自动剪）
   * @param edits   分段表（编辑后的镜头表；空 = 重新自动剪）
   * @param variant 「风格 + 种子」设定（{ style, seed } | null）。传 undefined = 沿用当前版本；
   *                传新对象 = 换一版（剪遍面板「换一版」）。同一 (style, seed) 排出来的完全一致，
   *                所以会话重启 / 「应用并播放」之后看到的还是刚剪的那一版。
   */
  buildMontage(edits, variant) {
    if (variant !== undefined) this.variant = variant || null;
    const m = new Montage(this.data, {
      world: this.session.builder.world,
      builder: this.session.builder,
      playerBody: this.session.player.body,
      level: this.session.level,
      rhythm: this._resolveRhythm(),
    });
    m.setVariant(this.variant);
    if (edits && edits.length) { m.applyEdits(edits); this._autoPlan = false; }
    else { m.plan(); this._autoPlan = true; }
    this.montage = m;
    this.edits = edits || m.serialize();
    this._shotIndex = 0;
    return m;
  }

  /**
   * 取这首 BGM 的节奏点表（已算好就直接用；没算完就挂一次回调，算好后若是「自动剪」的一版
   * 就重排一次，把切点补卡到重音上）。没有 BGM / 认不出节奏 = null（照旧拐点吸附）。
   */
  _resolveRhythm() {
    const ref = this._bgmRef;
    if (!ref) { this._rhythm = null; return null; }
    const r = audio.getRhythm(ref);
    if (r) { this._rhythm = r; return r; }
    this._rhythm = null;
    if (!this._rhythmKicked) {
      this._rhythmKicked = true;
      audio.analyzeRhythm(ref).then((g) => {
        if (!g || this._bgmRef !== ref) return;
        this._rhythm = g;
        if (this.mode === 'cinema' && this.montage && this._autoPlan) {
          this.montage.setRhythm(g);
          this.montage.plan();
          this.edits = this.montage.serialize();
          this.clock = clamp(this.clock, 0, this.duration);
        }
      }).catch(() => { /* 检测失败：保持拐点吸附 */ });
    }
    return null;
  }

  /** 当前这一版的「风格 + 种子」与可读标签（面板显示 / 会话重启还原） */
  variantInfo() {
    const v = this.montage && this.montage.variant;
    if (!v) return null;
    return { style: v.style, seed: v.seed, label: v.label, text: `${v.label} · 第 ${v.seed} 版` };
  }

  /** 电影剪辑模式：镜头表（可编辑） */
  shotList() { return this.montage ? this.montage.serialize() : []; }
  /** 应用编辑后的镜头表并重排时间轴 */
  applyEdits(list) {
    if (!this.montage) return;
    this.montage.applyEdits(list);
    this.edits = this.montage.serialize();
    this._autoPlan = false;      // 用户手剪过：节奏点表晚到也不再自动覆盖
    this.clock = clamp(this.clock, 0, this.duration);
    this._ended = false;
  }

  /** 当前 BGM 的节奏点信息（面板显示用）：无 BGM / 认不出 = null */
  rhythmInfo() {
    const r = this.rhythm;
    if (!r) return null;
    return { count: r.count || (r.times ? r.times.length : 0), rate: r.rate, window: r.window, duration: r.duration };
  }
  /** 节奏点表（排片用的那个） */
  get rhythm() { return (this.montage && this.montage.rhythm) || this._rhythm || null; }

  /* ============================================================
     传输控制
     ============================================================ */
  get duration() {
    if (this.mode === 'cinema' && this.montage) return this.montage.duration;
    return this.data.duration;
  }
  get progress() { return this.duration > 0 ? clamp(this.clock / this.duration, 0, 1) : 0; }
  get shotCount() { return this.montage ? this.montage.clips.length : 1; }
  get shotIndex() { return this._shotIndex; }
  get shotLabel() { return this._shotLabel; }
  get shotType() { return this._shotType; }
  get shotTypeLabel() { return SHOT_TYPES[this._shotType] ? SHOT_TYPES[this._shotType].label : ''; }
  /** 时间轴刻度（每个镜头的起点，已折进运镜提前量） */
  get marks() {
    if (this.mode !== 'cinema' || !this.montage) return [];
    return this.montage.clips.map((c, i) => ({ i, t: this.montage.shotStartT(i), label: c.label }));
  }

  /**
   * 开始播放。
   * 「开始播放」= 从停止状态起播（播完后再播 / 停在 0 上播）：地图必须跟着重启一遍 ——
   * 上一遍开过的门、砸开的墙、扔出去的投掷物在同一个世界里是退不回去的，
   * 与其在当前世界里「倒带」（永远倒不干净），不如整个会话重建。由 App 的 onRestart 接手。
   * 从暂停恢复（播到一半按 ▶）不算「开始播放」，继续往下放就好。
   */
  play() {
    const needRestart = !!this.onRestart && (this._ended || (this.clock <= 0.001 && this._maxT > 0.5));
    if (needRestart) {
      this.playing = false;
      this._ended = false;
      this.onRestart();
      return;
    }
    this._ended = false;
    this.playing = true;
    this._syncMusic(true);      // 从暂停恢复：把 BGM 钉回播放头（卡点不因暂停而错位）
  }
  pause() { this.playing = false; audio.pauseMusic(); }
  toggle() { this.playing ? this.pause() : this.play(); }
  setSpeed(v) {
    this.speed = clamp(Number(v) || 1, 0.25, 3);
    if (this.speed === 1) this._syncMusic(true);   // 回到 1× 时重新对齐（其余倍速不对齐音乐）
  }
  /**
   * 拖动进度条定位。
   * 世界里的门 / 破坏 / 动画（如洪水水位）/ 液体 / 物理都是「单向流逝」的，无法原地倒带，
   * 所以分两种走法：
   *   · 向前（t 已在世界模拟过的范围内）→ 交给会话把世界从 `_worldT` 确定性快进到 t，实时、廉价；
   *   · 向后（t < 世界已模拟到的时刻）→ 世界状态退不回去，交回 App 重建整个会话再快进到 t。
   * 两种情况都先把幽灵 / 相机瞬时对齐到新时刻，让拖动本身立刻有画面反馈。
   */
  seek(t) {
    const goal = clamp(Number(t) || 0, 0, this.duration);
    this.clock = goal;
    this._ended = false;
    this._maxT = Math.max(this._maxT, this.clock);
    // 拖进度条后让相机直接跳到新机位（不插值穿墙）
    if (this.montage) this.montage._clipIx = -1;

    const canRestart = this.onSeekRestart && (!this.canSeekRestart || this.canSeekRestart());
    if (goal < this._worldT - 0.02 && canRestart) {
      // 向后：交给 App 重建会话（重建后会把世界快进到 goal），这里只先对齐幽灵给个反馈
      this._applyGhost(this._resolveSrcT(goal), 1 / 60);
      this.onSeekRestart(goal, this.playing);
      return;
    }

    if (goal > this._worldT + 0.02 && this.onSeekForward) {
      // 向前：会话把世界补到 goal（内部会重演这段时间里的世界交互与动画）
      this.onSeekForward(goal);
    } else {
      // 原地 / 没有回调：把这里错过的世界变化补齐（门开到终态 / 物碎 / 开关），再对齐幽灵。
      // 不重置 _evIx：正常播放中它已指向「下一个未重演的事件」，重置会把整段事件再放一遍
      // （emit 会重复触发动画）。仅「无重建回调时的倒退」才退回重置。
      if (goal < this._worldT - 0.02) this._evIx = 0;
      this._drain(goal, true);
      this._applyGhost(this._resolveSrcT(goal), 1 / 60);
      this._worldT = goal;
    }
    this._syncMusic(true);      // BGM 也跟着跳，否则拖完进度条重音就全错位了
  }

  /**
   * 无渲染地推进一步（回放定位快进用）：只推时钟、重演记录里的世界交互、对齐幽灵，
   * 不碰音乐 / 相机 / 震屏 —— 那些由会话的快进循环之外负责。
   */
  stepTo(h) {
    this.clock = clamp(this.clock + h, 0, this.duration);
    if (this.clock > this._maxT) this._maxT = this.clock;
    this._drain(this.clock, false);
    this._applyGhost(this._resolveSrcT(this.clock), h);
    this._worldT = this.clock;
  }
  /** 跳到下一个 / 上一个镜头 */
  step(dir) {
    if (this.mode !== 'cinema' || !this.montage || !this.montage.clips.length) return;
    const cs = this.montage.clips;
    let i = dir > 0 ? this._shotIndex + 1 : this._shotIndex - 1;
    i = clamp(i, 0, cs.length - 1);
    // 落点是「那一镜在播放时间轴上上屏的时刻」（已折进运镜提前量），不能再直接用 outT0
    this.seek(this.montage.shotStartT(i) + 0.001);
  }
  /** 切模式（direct ↔ pov ↔ cinema）。三种模式时间轴 1:1 相同，所以直接把播放头带过去 */
  setMode(mode) {
    const m = REPLAY_MODES.includes(mode) ? mode : 'direct';
    if (m === this.mode) return this.mode;
    this.mode = m;
    if (m === 'cinema' && !this.montage) this.buildMontage(null);
    this._ended = false;
    return this.mode;
  }
  /** 依次切模式（直录回放 → 第一人称 → 电影运镜 → 直录回放） */
  cycleMode() {
    return this.setMode(REPLAY_MODES[(REPLAY_MODES.indexOf(this.mode) + 1) % REPLAY_MODES.length]);
  }

  /* ============================================================
     BGM 跟随回放时间轴（卡点的前提）
     ------------------------------------------------------------
     切点是按「BGM 重音」摆的（montage 的节奏点吸附），所以画面与音乐必须落在同一个
     时钟上：暂停再恢复 / 拖进度条之后，BGM 得重新钉回播放头，否则重音会越错越远。
     做法：位置偏移时重启一次音乐源（Web Audio 的源不支持 seek），偏移小于阈值不动它。
     倍速播放时不拉伸音乐（卡点本来就不成立），因此也跳过对齐，免得反复重启。
     ============================================================ */
  _syncMusic(force) {
    if (!this._bgmRef || !this.playing) return;   // 没有 BGM / 暂停中不碰音乐（暂停由 pause() 收掉）
    if (clamp(Number(this.speed) || 1, 0.25, 3) !== 1) return;
    const md = audio.getRefDuration(this._bgmRef);   // 素材时长：还没起播时也要能算出播放头位置
    if (!(md > 0.05)) return;                        // 还没解码完：解码完那次 sync 会把它放起来
    const want = ((this.clock % md) + md) % md;
    if (audio.getMusicTime() === null) {
      // 还没在放（刚进回放 / 素材刚解码完 / 从暂停恢复）：直接按播放头起播，一出声就对在拍上
      audio.playMusic(this._bgmRef, { volume: this._bgmVolume, offset: want, loop: true, fadeIn: 0.2 });
      return;
    }
    const cur = audio.getMusicTime();
    const d = ((cur - want + md / 2) % md + md) % md - md / 2;   // 最短弧差
    if (force || Math.abs(d) > 0.35) audio.seekMusic(want);
  }

  /* ============================================================
     每帧①：推进时钟 + 把幽灵摆到记录位置（在液体 / 机关之前）
     ============================================================ */
  advance(dt) {
    if (this.playing) {
      this.clock += dt * this.speed;
      if (this.clock >= this.duration + 0.25) {
        this.clock = this.duration;
        this.playing = false;
        if (!this._ended) { this._ended = true; this.onEnd && this.onEnd(); }
      }
    }
    const t = this.clock;
    if (t > this._maxT) this._maxT = t;
    // 本帧世界要不要跟着跑：暂停 = 世界彻底静止（机关 / 门 / 关卡动画 / 液体 / 物理 / 粒子全停），
    // 只有「拖过进度条 / 刚进来」的那一帧例外 —— 那时必须把世界对齐到新时刻，否则画面和状态对不上。
    this.worldRun = this.playing || this._wake;
    this._wake = false;

    // 记录里的条目：震屏（只在该时刻触发一次）+ 世界交互重演（开门 / 破坏 / 点击 / 投掷）
    this._drain(t, false);
    this.shake = Math.max(0, this.shake - dt * 3.4);

    const srcT = this._resolveSrcT(t);
    this._srcT = srcT;

    // 全程连续：时间轴与记录 1:1，一帧都不删。镜头之间的接缝由 Montage 的转场处理 ——
    // 能直接接上的硬切、位移大得看不下去的在切点 ±0.3s 淡一次黑场 / 白场、
    // 中间那档用贝塞尔飞渡插过去（都在 cine.js 里按两端姿态与射线可达性自动决定）。
    if (this.mode === 'cinema' && this.montage) {
      // 这三项都描述「此刻屏幕上那一镜」，必须走 Montage 的**相机时间**（含运镜提前量），
      // 不能直接用播放时间 —— 否则镜头已经切过去了，字幕 / 镜头名还停在上一条。
      this._shotIndex = this.montage.shotIndexAt(t);
      const ti = this.montage.titleAt(t);
      this._shotLabel = ti ? ti.label : '';
      this._shotType = this.montage.shotTypeAt(t);
    } else {
      this._shotLabel = ''; this._shotType = '';
    }

    // BGM 对齐：按固定间隔校正一次（偏移超阈值才会重启音乐源），保持画面重音与音乐同钟；
    // 音乐还没响（刚进回放 / 素材刚解码完）时每帧试一次，让它一开播就出声。
    if (this.playing && this._bgmRef) {
      this._musAcc += dt;
      // 非强制：仅当偏差超阈值才重启音乐源。之前这里传 true，导致每 0.5s 停源重起一次，
      // 波形被切断 → 每半秒一声「咔哒」。刚解码完 / 还没起播的情况由 _syncMusic 内部起播兜住。
      if (this._musAcc >= 0.5 || !audio.getMusicRef()) { this._musAcc = 0; this._syncMusic(false); }
    }

    this._applyGhost(srcT, dt);
  }

  /** 输出时间 → 源时间：电影模式与记录 1:1（不删减、不压缩），两种模式完全一致 */
  _resolveSrcT(t) {
    return clamp(t, 0, this.data.duration);
  }

  /* ============================================================
     记录里的世界变化：按时刻重演到会话上
     ============================================================ */
  /** 消费记录里到期的条目。instant = 拖动进度条时的「快进补齐」 */
  _drain(t, instant) {
    const evs = this.rec.ev || [];
    while (this._evIx < evs.length && evs[this._evIx].t <= t) {
      const e = evs[this._evIx++];
      if (!instant) this._shakeFrom(e);
      if (WORLD_ACTS.has(e.k)) this._worldAct(e, instant);
    }
  }

  /** 记录里的动作 → 震屏（只在该时刻触发一次） */
  _shakeFrom(e) {
    // 震屏强度整体下调：游玩时震屏是「反馈」，回放时只是在看片 ——
    // 观看时的大幅度震动只会晕，宁可欠一点。
    if (e.k === 'land') this.shake = Math.min(0.7, this.shake + 0.16);
    else if (e.k === 'hurt' || e.k === 'death') this.shake = Math.min(0.85, this.shake + 0.4);
    else if (e.k === 'walljump' || e.k === 'climb') this.shake = Math.min(0.7, this.shake + 0.12);
  }

  /**
   * 重演一次玩家对地图的交互。
   * 这些动作原本靠 input（左键 / 工具）触发，回放时幽灵锁着输入不会自己发生，
   * 所以必须在记录的时刻原样再调一次对应的机关接口 —— 否则门永远关着、
   * 被砸开的墙、被扳动的开关都不会出现，地图看起来「没变」。
   * instant（拖进度条）：门直接落到终态、点击 / 破坏重放、投掷跳过（过去的投掷物不必再飞一遍）。
   */
  _worldAct(e, instant) {
    const M = this.session.mechanisms;
    const rec = e.id ? this.session.builder.objects.get(e.id) : null;
    switch (e.k) {
      case 'doorOpen':
      case 'doorClose': {
        if (!rec || rec.type !== 'door') return;
        const open = e.k === 'doorOpen';
        if (open) M.openDoor(rec); else M.closeDoor(rec);
        if (instant) {
          rec.state.want = open ? 1 : 0;
          rec.state.t = rec.state.want;
          M.applyDoorState(rec, rec.state.t);
        }
        break;
      }
      case 'click':
        if (rec) M.fireClick(rec, this.session.player);
        break;
      case 'break':
        if (rec && !rec.broken) M.breakObject(rec, this.session.player);
        break;
      case 'emit':
        if (e.ev) this.session.events.emit(e.ev, { tool: e.tool || '' });
        break;
      case 'throw':
        if (instant || !rec || !rec.mesh || rec.o.visible === false) return;
        M.throwProjectile(rec,
          { x: e.px, y: e.py, z: e.pz },
          { x: e.dx, y: e.dy, z: e.dz }, 1, null);
        break;
      default: break;
    }
  }

  /** 把玩家本体摆成记录里的样子（静态幽灵：物理不参与，只做视觉与判定源） */
  _applyGhost(srcT, dt) {
    const p = this.session.player;
    const s = this.data.sampleAt(clamp(srcT, 0, this.data.duration));
    const b = p.body;
    b.position.set(s.x, s.y, s.z);
    // 速度按「朝向 × 记录的水平速率」还原：给动画层用（步频 / 摆臂 / 侧移）
    b.velocity.set(Math.sin(s.fy) * s.sp, s.vy, Math.cos(s.fy) * s.sp);
    b.aabbNeedsUpdate = true;
    p.velocity.set(b.velocity.x, b.velocity.y, b.velocity.z);

    p.state = s.state;
    p.onZipline = s.onZipline;
    p.grounded = s.grounded;
    p.alive = s.alive;
    p.health = s.hp;
    p.oxygen = s.ox;
    // 藏不藏角色：
    // · 第一人称模式整局都是玩家自己的眼睛（机位重建自头位置 `hx/hy/hz`），必须恒藏 ——
    //   否则镜头会卡在模型的颅内壁里；
    // · 运镜模式只在当前分镜是「沉浸 POV」时藏（那一镜同样把机位放在头上，求解函数与
    //   PovPlayer 是同一个 `povAim`）；其余机位都在主体身后几 studs 外，角色必须露出来，
    //   否则回放会变成空镜头；
    // · 直录回放：机位就是玩家当时真正在用的那台相机 —— 第三人称时本体当然要露出来
    //   （能看到自己，才是「当时看到的样子」）；只有那几段当时切了游戏内第一人称的
    //   （机位贴在眼睛上，离头部不到 1 stud）才把本体藏掉，免得镜头卡在头里。
    let hide;
    if (this.mode === 'pov') hide = true;
    else if (this.mode === 'cinema') hide = !!(this.montage && this.montage.shotTypeAt(srcT) === 'pov');
    else {
      const dx = s.cx - s.hx, dy = s.cy - s.hy, dz = s.cz - s.hz;
      hide = dx * dx + dy * dy + dz * dz < FIRST_PERSON_EYE2;
    }
    p.statInvisible = hide;
    p.yaw = s.fy;
    this._srcYaw = s.fy;
    p.feetPos.set(s.x, s.y, s.z);
    // 头部直接用记录列（旧存档由 `ReplayData.sampleAt` 按脚底 + totalH - 0.5 回退补齐）
    p.headPos.set(s.hx, s.hy, s.hz);
    p._stepVisOff = 0;
    p._stepVisVel = 0;
    void dt;
  }

  /* ============================================================
     每帧②：驱动模型 + 相机取景（在物理步进之后）
     ============================================================ */
  applyCamera(dt) {
    const session = this.session;
    const p = session.player;
    // 模型：环境（p.env）刚由 LiquidSystem 按幽灵位置算好，此刻更新姿态最准
    if (p.model) {
      // _updateModel 内部会拿 cameraCtl.yaw 当朝向目标做阻尼（回放里 cameraCtl 是不动的），
      // 所以进来前把朝向钉在记录值上，出来后再钉一次，避免角色朝着一个陈旧方向慢慢偏。
      // dt 按倍速放大：行走 / 游泳 / 攀爬的步频与骨骼动画也要跟地图一起时间拉伸，
      // 否则 2× 回放里幽灵在「月球漫步」
      p.yaw = this._srcYaw;
      p._updateModel(dt * (this.speed || 1));
      p.yaw = this._srcYaw;
      p.model.rotation.y = this._srcYaw;
    }

    const cam = session.camera;
    if (this.mode === 'cinema' && this.montage) {
      this.montage.update(this.clock, cam, dt);
      // 遮罩由 Montage 算好（切点 ±0.3s 的黑场 / 白场）：转场是运镜的一部分，
      // 所以不在这里做二次阻尼 —— 包络本身就是平滑的 s 形，再滤波只会拖长黑场。
      this.fade = this.montage.fade;
      this.fadeColor = this.montage.fadeColor;
    } else if (this.mode === 'pov') {
      // dt 走真实时间：POV 俯仰的平滑是「视觉抖动」的治理，抖动本来就按真实时间读，
      // 所以倍速回放时不跟着拉伸（与电影模式那条 POV 分镜的 dt 口径保持一致）。
      this.pov.update(this._srcT, cam, dt);
      this.fade = damp(this.fade, 0, 9, dt);
      this.fadeColor = '#000';
    } else {
      // 直录回放：机位与朝向都直接取自记录（cx/cy/cz + ky/kp），也就是玩家当时真正在
      // 操作的那台相机 —— 第三人称的拉近拉远 / 绕圈 / 抬头低头都原样再放一遍。
      // 15Hz 的采样已由 `ReplayData` 走样条插值（含角度最短弧），所以运动是连续的。
      const s = this.data.sampleAt(this._srcT, this._camS);
      cam.up.set(0, 1, 0);                       // 运镜模式可能给过 roll，先还原
      cam.position.set(s.cx, s.cy, s.cz);
      cam.rotation.order = 'YXZ';                // 与 PlayerCamera 一致：YXZ 下 (x, y) = (俯仰, 偏航)
      cam.rotation.set(s.kp, s.ky, 0);           // 侧倾没记录（幅度 ≤0.12 rad），回放里不复现
      if (Math.abs(cam.fov - this._savedCam.fov) > 0.05) {
        cam.fov = this._savedCam.fov;            // 从运镜模式切回来时把视场角还回去
        cam.updateProjectionMatrix();
      }
      this.fade = damp(this.fade, 0, 9, dt);
      this.fadeColor = '#000';
    }

    if (this.shake > 0.001 && this.mode !== 'direct') {
      // 直录回放不叠这一层：记录里的 cx/cy/cz 本来就是带游戏内震屏采下来的，
      // 再叠一次等于把震屏放大一倍，也不再是「玩家当时看到的画面」。
      // 低频小幅：原先 clock*34 再乘 1.7~2.3 ≈ 10Hz 的高频位移、幅度还能到 0.3+ studs，
      // 正是「大幅度高频抖动」—— 晕 3D 的头号来源。改成 1~1.6Hz 的缓慢摇晃：
      // 冲击感还在，但人眼能把它解释成「镜头被撞了一下」，而不是画面在失控乱抖。
      const a = this.shake * 0.12 * (this.mode === 'cinema' ? 0.55 : 1);
      const t = this.clock * 7.5;
      cam.position.x += Math.sin(t) * a;
      cam.position.y += Math.sin(t * 1.37 + 1.1) * a * 0.85;
      cam.position.z += Math.sin(t * 1.19 + 2.2) * a;
    }
  }

  /* ============================================================
     收尾
     ============================================================ */
  dispose() {
    const session = this.session;
    const p = session.player;
    const s = this._saved;
    p.body.type = s.type;
    p.body.collisionResponse = s.collisionResponse;
    p.anchored = s.anchored;
    p.invincible = s.invincible;
    p.statInvisible = s.statInvisible;
    p.inputFrozen = s.inputFrozen;
    p.body.updateMassProperties();
    p.body.velocity.set(0, 0, 0);
    p.body.aabbNeedsUpdate = true;
    if (p.model) p.model.visible = s.modelVisible;

    const ctl = session.cameraCtl;
    ctl.mode = s.mode;
    ctl.wantDist = s.wantDist;
    ctl.dist = s.dist;
    const cam = session.camera;
    cam.rotation.order = 'YXZ';
    cam.rotation.set(0, 0, 0);
    cam.up.set(0, 1, 0);
    cam.position.set(0, 0, 0);
    if (Math.abs(cam.fov - this._savedCam.fov) > 0.01) {
      cam.fov = this._savedCam.fov;
      cam.updateProjectionMatrix();
    }
    this.montage = null;
  }
}
