/* ============================================================
   音频：全程序化合成（无外部音频文件）
   ============================================================ */
import { settings } from './settings.js';
import { clamp } from './util.js';

class AudioSys {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.ambGain = null;
    this.musicGain = null;
    this.ready = false;
    this.noiseBuf = null;
    this._ambNodes = [];
    this._ambKind = null;
    this._underwater = null;
    /* 素材音频（音频文件） */
    this._bufCache = new Map();   // ref -> { buf, status:'loading'|'ok'|'error', waiters:[] }
    this._repl = new Map();       // 音效名 -> { ref, volume, pitch }
    this._music = null;           // 当前 BGM 播放句柄
    this._musicPending = null;    // 素材还没解码完 / 音频未解锁时的待播请求
    this._musicPaused = null;     // 暂停中的 BGM：{ ref, volume, time }，恢复时从原位置接着放
    this.musicPitch = 1;          // BGM 时间拉伸系数（地图变体「加快/减慢」整局跟着改时间流速）
    this._rhythmCache = new Map(); // BGM 节奏点缓存：ref -> { promise, rhythm }
    this._handles = new Set();    // 所有 playRef 播放句柄（场景切换时统一收尾，防止残留循环音）
    this._listener = { x: 0, y: 0, z: 0, yaw: 0 };
    settings.on('change', (p) => { if (p.startsWith('audio') || p === '*') this.applyVolumes(); });
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._flushMusic();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.ambGain = this.ctx.createGain();
      this.musicGain = this.ctx.createGain();
      this.sfxGain.connect(this.master);
      this.ambGain.connect(this.master);
      this.musicGain.connect(this.master);
      // 噪声缓冲
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      this.applyVolumes();
      this.ready = true;
      this._flushMusic();     // 音频刚就绪：把等着的 BGM 立刻接上
      return true;
    } catch (e) { console.warn('[audio] 初始化失败', e); return false; }
  }

  /** 音频系统就绪 / 首次解锁后，把挂起的 BGM 立刻自动播出来 */
  _flushMusic() {
    const q = this._musicPending;
    if (!q) return;
    this._musicPending = null;
    this.playMusic(q.ref, q.opts);
  }

  applyVolumes() {
    if (!this.ctx) return;
    const a = settings.get('audio', {});
    this.master.gain.value = clamp(a.master ?? 0.8, 0, 1);
    this.sfxGain.gain.value = clamp(a.sfx ?? 0.9, 0, 1);
    this.ambGain.gain.value = clamp(a.ambience ?? 0.7, 0, 1);
    this.musicGain.gain.value = clamp(a.music ?? 0.75, 0, 1);
  }

  get t() { return this.ctx ? this.ctx.currentTime : 0; }

  _env(node, t0, a, d, peak = 1, sus = 0) {
    const g = node.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + a);
    if (sus > 0) g.exponentialRampToValueAtTime(Math.max(peak * 0.5, 0.0002), t0 + a + sus);
    g.exponentialRampToValueAtTime(0.0001, t0 + a + sus + d);
  }

  _osc(type, freq, t0, dur, peak, dest, sweepTo) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 1), t0 + dur);
    const g = this.ctx.createGain();
    const out = dest || this.sfxGain;
    this._env(g, t0, Math.min(0.012, dur * 0.2), dur * 0.8, peak);
    o.connect(g); g.connect(out);
    o.start(t0); o.stop(t0 + dur + 0.06);
    return { o, g };
  }

  _noise(t0, dur, peak, filtType, f0, f1, q, dest) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = filtType || 'lowpass';
    f.frequency.setValueAtTime(f0, t0);
    if (f1) f.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t0 + dur);
    f.Q.value = q || 1;
    const g = this.ctx.createGain();
    this._env(g, t0, Math.min(0.02, dur * 0.15), dur * 0.85, peak);
    s.connect(f); f.connect(g); g.connect(dest || this.sfxGain);
    s.start(t0); s.stop(t0 + dur + 0.05);
    return { s, f, g };
  }

  play(name, opts = {}) {
    if (!this.ensure()) return;
    // ① 用户把该音效替换成了音频文件 → 直接播素材
    const rep = this._repl.get(name);
    if (rep) {
      const h = this.playRef(rep.ref, {
        volume: clamp((opts.volume ?? 1) * (rep.volume ?? 1), 0, 4),
        pitch: (opts.pitch ?? 1) * (rep.pitch ?? 1),
        delay: opts.delay || 0,
        loop: !!opts.loop,
      });
      const st = this._bufCache.get(rep.ref);
      if (h || !st || st.status !== 'error') return h;   // 播放成功 / 正在解码：不回退合成音
    }
    const t0 = this.t + (opts.delay || 0);
    const vol = clamp(opts.volume ?? 1, 0, 2);
    try { this['_' + name] ? this['_' + name](t0, vol, opts) : this._click(t0, vol * 0.6); }
    catch (e) { /* ignore */ }
  }

  /* ============================================================
     素材音频（音频文件）：播放 / 解码缓存 / 音效替换 / BGM
     —— 对接口：window.__fd.audio 或 import { audio }
     ============================================================ */

  /** 把 'asset:xxx' 或普通 URL 解析成可直接 fetch 的地址 */
  async _refURL(ref) {
    const s = String(ref || '');
    if (!s) return '';
    if (s.startsWith('asset:')) {
      const { resolveAssetURL } = await import('./settings.js');
      return (await resolveAssetURL(s.slice(6))) || '';
    }
    return s;
  }

  /** 解码并缓存一段音频（同一 ref 只解码一次） */
  load(ref) {
    if (!ref) return Promise.resolve(null);
    const key = String(ref);
    let rec = this._bufCache.get(key);
    if (rec) {
      if (rec.status === 'ok') return Promise.resolve(rec.buf);
      if (rec.status === 'error') return Promise.resolve(null);
      return new Promise((res) => rec.waiters.push(res));
    }
    rec = { buf: null, status: 'loading', waiters: [] };
    this._bufCache.set(key, rec);
    const done = (buf) => {
      rec.buf = buf;
      rec.status = buf ? 'ok' : 'error';
      for (const w of rec.waiters) w(buf);
      rec.waiters = [];
      // 素材到位后处理待播的 BGM
      if (buf && this._musicPending && this._musicPending.ref === key) {
        const q = this._musicPending;
        this._musicPending = null;
        this.playMusic(q.ref, q.opts);
      }
    };
    (async () => {
      try {
        if (!this.ensure()) { done(null); return; }
        const url = await this._refURL(key);
        if (!url) { done(null); return; }
        const res = await fetch(url);
        const arr = await res.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(arr);
        done(buf);
      } catch (e) {
        console.warn('[audio] 音频素材加载失败', key, e);
        done(null);
      }
    })();
    return new Promise((res) => rec.waiters.push(res));
  }

  /** 素材是否已解码就绪 */
  isLoaded(ref) {
    const rec = this._bufCache.get(String(ref || ''));
    return !!(rec && rec.status === 'ok');
  }

  /**
   * 直接播放一段素材音频（一次性 / 循环均可用）
   * opts: { volume, pitch, delay, loop, pan, fadeIn, offset, dest:'sfx'|'music' }
   * 返回句柄 { stop(fade), setVolume(v), setPan(p), playing, ref, startedAt, offset }
   */
  playRef(ref, opts = {}) {
    if (!this.ensure() || !ref) return null;
    const rec = this._bufCache.get(String(ref));
    const buf = rec && rec.buf;
    if (!buf) { if (!rec || rec.status !== 'error') this.load(ref); return null; }
    try {
      const t0 = this.t + (opts.delay || 0);
      const vol = clamp(opts.volume ?? 1, 0, 4);
      const fade = Math.max(0, Number(opts.fadeIn) || 0);
      // 从素材内的某个位置起播（回放拖动进度条 / 让 BGM 跟上回放时间轴时用）
      const off = clamp(Number(opts.offset) || 0, 0, Math.max(0, (buf.duration || 0) - 0.01));
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = !!opts.loop;
      src.playbackRate.value = clamp(opts.pitch ?? 1, 0.1, 4);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(fade > 0 ? 0 : vol, t0);
      if (fade > 0) g.gain.linearRampToValueAtTime(vol, t0 + fade);   // 线性淡入：一出声就能听到
      let out = g;
      let pan = null;
      if (opts.pan !== undefined && this.ctx.createStereoPanner) {
        pan = this.ctx.createStereoPanner();
        pan.pan.value = clamp(Number(opts.pan) || 0, -1, 1);
        g.connect(pan);
        out = pan;
      }
      out.connect(opts.dest === 'music' ? this.musicGain : this.sfxGain);
      src.connect(g);
      src.start(t0, off);
      const handle = {
        ref: String(ref), src, gain: g, pan, playing: true, volume: vol,
        startedAt: t0, offset: off,   // 播放位置查询（getMusicTime）用
        stop: (fadeOut = 0) => {
          if (!handle.playing) { this._handles.delete(handle); return; }
          handle.playing = false;
          this._handles.delete(handle);
          const t1 = this.t;
          try {
            if (fadeOut > 0) {
              g.gain.cancelScheduledValues(t1);
              g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t1);
              g.gain.exponentialRampToValueAtTime(0.0001, t1 + fadeOut);
              src.stop(t1 + fadeOut + 0.02);
            } else src.stop(t1);
          } catch (e) { /* ignore */ }
        },
        setVolume: (v, fade = 0.05) => {
          try {
            const t1 = this.t;
            g.gain.cancelScheduledValues(t1);
            g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t1);
            g.gain.linearRampToValueAtTime(Math.max(clamp(v, 0, 4), 0.0001), t1 + fade);
          } catch (e) { /* ignore */ }
        },
        setPan: (p) => { if (pan) { try { pan.pan.value = clamp(p, -1, 1); } catch (e) { /* ignore */ } } },
      };
      src.onended = () => { handle.playing = false; this._handles.delete(handle); };
      this._handles.add(handle);
      return handle;
    } catch (e) {
      console.warn('[audio] 素材播放失败', ref, e);
      return null;
    }
  }

  /** 监听者（3D 音量/声像用）：一般每帧把玩家位置和朝向传进来 */
  setListener(pos, yaw = 0) {
    if (!pos) return;
    this._listener.x = pos.x ?? 0;
    this._listener.y = pos.y ?? 0;
    this._listener.z = pos.z ?? 0;
    this._listener.yaw = Number(yaw) || 0;
  }

  /** 计算一个世界坐标声源相对监听者的 { volume, pan, dist } */
  spatialize(position, opts = {}) {
    const L = this._listener;
    const p = Array.isArray(position) ? { x: position[0], y: position[1], z: position[2] } : (position || L);
    const dx = (p.x ?? 0) - L.x, dy = (p.y ?? 0) - L.y, dz = (p.z ?? 0) - L.z;
    const dist = Math.hypot(dx, dy, dz);
    const refD = Math.max(0.5, Number(opts.refDistance ?? 12));
    const maxD = Math.max(refD, Number(opts.maxDistance ?? 160));
    if (dist > maxD) return { volume: 0, pan: 0, dist, silent: true };
    const falloff = Math.max(0, Number(opts.falloff ?? 0.6));
    const att = refD / (refD + Math.max(0, dist - refD) * falloff);
    // 右向量（与 player.yaw 同系）→ 声像
    const right = { x: Math.cos(L.yaw), z: -Math.sin(L.yaw) };
    const inv = dist > 0.001 ? 1 / dist : 0;
    const pan = clamp((dx * inv) * right.x + (dz * inv) * right.z, -1, 1);
    return { volume: clamp(att, 0, 1), pan, dist, silent: false };
  }

  /** 播放世界坐标上的一段素材音频（自动音量衰减 + 声像） */
  play3D(ref, opts = {}) {
    const sp = this.spatialize(opts.position, opts);
    if (sp.silent) return null;
    const vol = clamp((opts.volume ?? 1) * sp.volume, 0, 4);
    if (vol <= 0.001) return null;
    return this.playRef(ref, {
      volume: vol, loop: !!opts.loop, pitch: opts.pitch, pan: sp.pan,
      fadeIn: opts.fadeIn ?? (opts.loop ? 0.25 : 0), dest: opts.dest,
    });
  }

  /* ---------- 音效替换表（用素材替换内置合成音效） ---------- */

  /** 让内置音效名（jump/land/splash…）改用某个音频素材；ref 支持 'asset:xxx' 或 URL */
  registerSound(name, ref, opts = {}) {
    if (!name) return false;
    this._repl.set(String(name), {
      ref: String(ref || ''), volume: Number(opts.volume ?? 1) || 1, pitch: Number(opts.pitch ?? 1) || 1,
    });
    if (ref) this.load(ref);
    return true;
  }
  unregisterSound(name) { return this._repl.delete(String(name)); }
  /** 当前替换表：{ 音效名: { ref, volume, pitch } } */
  soundReplacements() {
    const out = {};
    for (const [k, v] of this._repl) out[k] = { ...v };
    return out;
  }
  /** 可替换的内置音效名列表 */
  listSoundNames() { return SOUND_NAMES.slice(); }

  /* ---------- BGM ---------- */

  /**
   * 播放背景音乐（同一首重复调用不会重头开始；素材未解码完 / 音频未解锁都会等就绪后自动播）
   * 地图 BGM 默认**循环播放**（opts.loop 显式传 false 才会只放一遍）。
   * opts.offset 可从素材内某个位置起播（回放让 BGM 跟上播放头时用）。
   */
  playMusic(ref, opts = {}) {
    if (!ref || ref === 'none') { this.stopMusic({ fade: opts.fade ?? 0.6 }); return null; }
    const key = String(ref);
    if (this._music && this._music.ref === key && this._music.playing && !opts.restart) {
      if (opts.volume !== undefined) this._music.setVolume(opts.volume, 0.3);
      return this._music;
    }
    this.stopMusic({ fade: opts.crossFade ?? 0.5 });
    if (!this.ensure()) {
      // 音频还没解锁（等首次用户操作）：先记下来，解锁那一刻立即自动播放
      this._musicPending = { ref: key, opts };
      return null;
    }
    const h = this.playRef(key, {
      loop: opts.loop !== false, volume: opts.volume ?? 1,
      pitch: (opts.pitch ?? 1) * this.musicPitch, fadeIn: opts.fadeIn ?? 0.5, offset: opts.offset, dest: 'music',
    });
    if (!h) {
      // 之前解码失败过（素材一度不可用）：再给一次机会，避免整局都听不到 BGM
      const rec = this._bufCache.get(key);
      if (rec && rec.status === 'error') { this._bufCache.delete(key); this.load(key); }
      this._musicPending = { ref: key, opts };
      return null;
    }
    this._music = h;
    return h;
  }

  stopMusic(opts = {}) {
    this._musicPending = null;
    this._musicPaused = null;
    if (!this._music) return;
    if (this._music.playing) this._music.stop(opts.fade ?? 0.5);
    this._music = null;
  }

  /**
   * 暂停 BGM：记住当前播放位置并停源，恢复时从原位置接着放（真正的暂停，不是静音）。
   * 游戏暂停时调用；没有 BGM 播放中则什么都不做。
   */
  pauseMusic() {
    this._musicPending = null;    // 暂停期间别让挂起的 BGM 自己冒出来
    const h = this._music;
    if (!h) return;
    const dur = this.getMusicDuration();
    let time = 0;
    if (this.ctx && dur > 0) {
      // 源按 playbackRate(= musicPitch) 推进，播放位置要按拉伸系数换算
      const elapsed = this.ctx.currentTime - (h.startedAt || 0);
      time = ((h.offset || 0) + elapsed * (this.musicPitch || 1)) % dur;
      if (time < 0) time += dur;
    }
    this._musicPaused = { ref: h.ref, volume: h.volume ?? 1, time };
    try { h.stop(0.06); } catch (e) { /* ignore */ }
    this._music = null;
  }

  /** 恢复被 pauseMusic 暂停的 BGM（没有暂停中的 BGM 则什么都不做） */
  resumeMusic() {
    const q = this._musicPaused;
    if (!q) return null;
    this._musicPaused = null;
    return this.playMusic(q.ref, { volume: q.volume, offset: q.time, fadeIn: 0.2 });
  }

  /** 场景切换统一收尾：BGM + 环境音 + 所有循环/长音素材一律停掉（不留残留声音） */
  stopAll(opts = {}) {
    const fade = opts.fade ?? 0.4;
    this.stopMusic({ fade });
    this.stopAmbient();
    if (this._underwater) this.setUnderwater(false);   // 别为了关水下滤波去建音频上下文
    for (const h of [...this._handles]) {
      try { h.stop(fade); } catch (e) { /* ignore */ }
    }
    this._handles.clear();
  }

  /** 当前 BGM 的素材引用（'' = 没有） */
  getMusicRef() { return (this._music && this._music.ref) || (this._musicPending && this._musicPending.ref) || ''; }

  /**
   * BGM 时间拉伸系数（1 = 原速）。地图变体改整个世界时间流速时，BGM 跟着一起拉伸 ——
   * 在播放 BGM 前设置（会话构造里），之后所有 playMusic / seekMusic 都会乘上它。
   */
  setMusicPitch(v) { this.musicPitch = clamp(Number(v) || 1, 0.25, 4); }

  /** 某个素材的总时长（秒）；没有 / 还没解码完 = 0。
   *  BGM 还没起播时也要能问（回放要把播放头对到素材位置上，见 ReplayPlayer._syncMusic） */
  getRefDuration(ref) {
    const rec = this._bufCache.get(String(ref || ''));
    return rec && rec.buf ? (rec.buf.duration || 0) : 0;
  }

  /** 当前 BGM 素材的总时长（秒）；没有 BGM / 还没解码完 = 0 */
  getMusicDuration() {
    const h = this._music;
    return h ? this.getRefDuration(h.ref) : 0;
  }

  /** 当前 BGM 播到了素材内的哪个位置（秒，已按循环取模）；没在放 = null */
  getMusicTime() {
    const h = this._music;
    if (!h || !h.playing || !this.ctx) return null;
    const dur = this.getMusicDuration();
    if (!(dur > 0)) return null;
    const raw = this.ctx.currentTime - (h.startedAt || 0) + (h.offset || 0);
    return ((raw % dur) + dur) % dur;
  }

  /**
   * 把当前 BGM 跳到素材内的某个位置（秒）。回放拖动进度条 / 从那暂停恢复时，
   * 用它把音乐重新钉回播放头 —— 否则画面与音乐一错开，卡点就不成立了。
   * 位置变化靠「停掉旧源 + 从新位置重起一个源」实现（Web Audio 的源不支持 seek）。
   */
  seekMusic(sec) {
    const h = this._music;
    if (!h || !h.playing || !this.ctx) return null;
    const rec = this._bufCache.get(h.ref);
    const buf = rec && rec.buf;
    if (!buf || !(buf.duration > 0.05)) return null;
    const off = ((Number(sec) || 0) % buf.duration + buf.duration) % buf.duration;
    const vol = h.gain ? h.gain.gain.value : 1;
    const ref = h.ref;
    try { h.stop(0); } catch (e) { /* ignore */ }
    this._music = null;
    const nh = this.playRef(ref, {
      loop: true, volume: vol, offset: off, fadeIn: 0.03,
      pitch: this.musicPitch, dest: 'music',
    });
    if (nh) this._music = nh;
    return nh;
  }

  /* ---------- BGM 节奏点检测（回放「电影剪辑」卡点用） ---------- */

  /**
   * 分析某段 BGM 的「节奏点」，返回：
   *   { times:[秒…], strengths:[0~1…], count, window, rate, duration }
   * times —— 逐帧频谱里检出的瞬态时刻（鼓点 / 重音），升序；不是等间隔的拍子网格。
   * window —— 吸附窗（半个平均间隔，夹在 0.08~0.22s），切点在这个范围内才被吸附。
   * 结果按 ref 缓存（同一首只算一次）；素材还没解码完会等解码完成再算。
   * 没有明显瞬态（太短 / 长音铺底 / 噪声）返回 null —— 调用方照旧用「拐点吸附」排片。
   */
  analyzeRhythm(ref) {
    const key = String(ref || '');
    if (!key) return Promise.resolve(null);
    let rec = this._rhythmCache.get(key);
    if (rec) {
      if (rec.rhythm) return Promise.resolve(rec.rhythm);
      return rec.promise || Promise.resolve(null);
    }
    rec = { promise: null, rhythm: null };
    this._rhythmCache.set(key, rec);
    rec.promise = (async () => {
      try {
        const buf = await this.load(key);
        if (!buf) return null;
        const rhythm = computeRhythm(buf);
        rec.rhythm = rhythm;
        return rhythm;
      } catch (e) {
        console.warn('[audio] 节奏点检测失败', key, e);
        return null;
      }
    })();
    return rec.promise;
  }

  /** 已算好的节奏点表（没算 / 算不出 = null）。同步取，排片时用。 */
  getRhythm(ref) {
    const rec = this._rhythmCache.get(String(ref || ''));
    return (rec && rec.rhythm) || null;
  }

  /* ---------- 音效配方 ---------- */
  _click(t0, v) { this._osc('square', 950, t0, 0.045, 0.13 * v); }
  _jump(t0, v) { this._osc('triangle', 330, t0, 0.14, 0.20 * v, null, 620); this._noise(t0, 0.09, 0.05 * v, 'highpass', 700, 1800, 1); }
  _land(t0, v) { this._osc('sine', 150, t0, 0.13, 0.24 * v, null, 68); this._noise(t0, 0.1, 0.12 * v, 'lowpass', 900, 240, 1); }
  _splash(t0, v) {
    this._noise(t0, 0.42, 0.28 * v, 'lowpass', 2400, 320, 3);
    this._noise(t0 + 0.02, 0.2, 0.14 * v, 'bandpass', 1400, 500, 6);
  }
  _bubble(t0, v) { this._osc('sine', 420 + Math.random() * 260, t0, 0.11, 0.14 * v, null, 900 + Math.random() * 500); }
  _oxygen(t0, v) {
    for (let i = 0; i < 5; i++) this._bubble(t0 + i * 0.055, v * (0.8 + Math.random() * 0.4));
    this._osc('sine', 520, t0, 0.5, 0.12 * v, null, 1040);
  }
  _pickup(t0, v) { this._osc('triangle', 640, t0, 0.1, 0.18 * v); this._osc('triangle', 960, t0 + 0.08, 0.14, 0.16 * v); }
  _door(t0, v) { this._osc('sawtooth', 90, t0, 0.55, 0.16 * v, null, 220); this._noise(t0, 0.5, 0.1 * v, 'lowpass', 500, 160); }
  _break(t0, v) {
    for (let i = 0; i < 7; i++) this._noise(t0 + i * 0.026, 0.14, 0.16 * v, 'bandpass', 900 + Math.random() * 2600, 400, 5);
  }
  _zipline(t0, v) { this._noise(t0, 0.7, 0.08 * v, 'bandpass', 300, 1600, 8); this._osc('sine', 260, t0, 0.5, 0.08 * v, null, 420); }
  _alarm(t0, v) {
    for (let i = 0; i < 3; i++) { this._osc('square', 780, t0 + i * 0.26, 0.16, 0.1 * v); this._osc('square', 590, t0 + i * 0.26 + 0.13, 0.16, 0.1 * v); }
  }
  _die(t0, v) {
    this._osc('sawtooth', 420, t0, 0.9, 0.2 * v, null, 52);
    this._noise(t0, 0.8, 0.16 * v, 'lowpass', 1600, 120, 2);
    this._osc('sine', 120, t0 + 0.2, 0.8, 0.18 * v, null, 40);
  }
  _win(t0, v) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => { this._osc('triangle', f, t0 + i * 0.13, 0.5, 0.17 * v); this._osc('sine', f * 2, t0 + i * 0.13, 0.36, 0.06 * v); });
    this._osc('sine', 261.6, t0, 1.2, 0.1 * v);
  }
  _hurt(t0, v) { this._noise(t0, 0.2, 0.2 * v, 'bandpass', 420, 180, 4); this._osc('square', 180, t0, 0.16, 0.12 * v, null, 90); }
  _checkpoint(t0, v) { this._osc('triangle', 700, t0, 0.16, 0.14 * v); this._osc('triangle', 1050, t0 + 0.1, 0.22, 0.12 * v); }
  _step(t0, v) { this._noise(t0, 0.07, 0.05 * v, 'lowpass', 700, 260, 1); }
  _ui(t0, v) { this._osc('sine', 620, t0, 0.06, 0.1 * v, null, 880); }

  /* ---------- 环境音 ---------- */
  ambient(kind) {
    if (!this.ensure()) return;
    if (this._ambKind === kind) return;
    this.stopAmbient();
    this._ambKind = kind;
    if (!kind) return;
    const t0 = this.t;
    const mk = (type, f, det, gain, lfoRate) => {
      const o = this.ctx.createOscillator();
      o.type = type; o.frequency.value = f; o.detune.value = det;
      const g = this.ctx.createGain(); g.gain.value = 0;
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      o.connect(lp); lp.connect(g); g.connect(this.ambGain);
      o.start(t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 3.2);
      let lfo = null;
      if (lfoRate) {
        lfo = this.ctx.createOscillator(); lfo.frequency.value = lfoRate;
        const lg = this.ctx.createGain(); lg.gain.value = gain * 0.45;
        lfo.connect(lg); lg.connect(g.gain); lfo.start(t0);
      }
      this._ambNodes.push(o, g, lp, lfo);
      return o;
    };
    if (kind === 'hall') {
      mk('sine', 110, 0, 0.05, 0.06);
      mk('sine', 164.8, 6, 0.035, 0.09);
      mk('triangle', 329.6, -4, 0.014, 0.05);
      mk('sine', 440, 12, 0.01, 0.033);
    } else if (kind === 'game') {
      mk('sine', 82.4, 0, 0.05, 0.05);
      mk('sawtooth', 110, 8, 0.012, 0.04);
      mk('sine', 220, -6, 0.012, 0.07);
    } else if (kind === 'editor') {
      mk('sine', 146.8, 0, 0.028, 0.05);
      mk('sine', 196, 5, 0.022, 0.035);
    }
    // 细碎水声底噪
    if (kind === 'game' || kind === 'hall') {
      const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 0.7;
      const g = this.ctx.createGain(); g.gain.value = 0;
      s.connect(f); f.connect(g); g.connect(this.ambGain);
      s.start(t0); g.gain.linearRampToValueAtTime(0.05, t0 + 4);
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.08;
      const lg = this.ctx.createGain(); lg.gain.value = 0.025;
      lfo.connect(lg); lg.connect(g.gain); lfo.start(t0);
      this._ambNodes.push(s, f, g, lfo, lg);
    }
  }
  stopAmbient() {
    if (!this.ctx) return;
    const t0 = this.t;
    for (const n of this._ambNodes) {
      try {
        if (n.gain) { n.gain.cancelScheduledValues(t0); n.gain.linearRampToValueAtTime(0, t0 + 0.5); }
        if (n.stop) n.stop(t0 + 0.65);
      } catch (e) { /* ignore */ }
    }
    this._ambNodes = [];
    this._ambKind = null;
  }

  /** 水下滤波（进入水中时降低高频） */
  setUnderwater(on) {
    if (!this.ensure()) return;
    if (on === this._underwater) return;
    this._underwater = on;
    if (!this._masterFilter) {
      this._masterFilter = this.ctx.createBiquadFilter();
      this._masterFilter.type = 'lowpass';
      this._masterFilter.frequency.value = 20000;
      this._masterFilter.Q.value = 0.4;
      try {
        this.master.disconnect();
        this.master.connect(this._masterFilter);
        this._masterFilter.connect(this.ctx.destination);
      } catch (e) { this._masterFilter = null; }
    }
    if (!this._masterFilter) return;
    const f = this._masterFilter.frequency;
    f.cancelScheduledValues(this.t);
    f.linearRampToValueAtTime(on ? 520 : 20000, this.t + 0.25);
  }

  /** 提示音（UI） */
  ui(kind = 'ui') { this.play(kind); }

  /* ---------- 便捷别名 ---------- */
  click(v = 1) { this.play('click', { volume: v }); }
  jump(v = 1) { this.play('jump', { volume: v }); }
  land(v = 1) { this.play('land', { volume: v }); }
  splash(v = 1) { this.play('splash', { volume: v }); }
  bubble(v = 1) { this.play('bubble', { volume: v }); }
  oxygen(v = 1) { this.play('oxygen', { volume: v }); }
  pickup(v = 1) { this.play('pickup', { volume: v }); }
  door(v = 1) { this.play('door', { volume: v }); }
  break(v = 1) { this.play('break', { volume: v }); }
  zipline(v = 1) { this.play('zipline', { volume: v }); }
  alarm(v = 1) { this.play('alarm', { volume: v }); }
  die(v = 1) { this.play('die', { volume: v }); }
  win(v = 1) { this.play('win', { volume: v }); }
  hurt(v = 1) { this.play('hurt', { volume: v }); }
  checkpoint(v = 1) { this.play('checkpoint', { volume: v }); }
  step(v = 1) { this.play('step', { volume: v }); }
}

export const audio = new AudioSys();

/** 可被素材替换的内置音效名（对接口：audio.listSoundNames()） */
const SOUND_NAMES = ['click', 'jump', 'land', 'splash', 'bubble', 'oxygen', 'pickup', 'door',
  'break', 'zipline', 'alarm', 'die', 'win', 'hurt', 'checkpoint', 'step', 'ui'];

/* 首次用户手势解锁音频 */
export function unlockAudioOnce() {
  const fn = () => { audio.ensure(); window.removeEventListener('pointerdown', fn); window.removeEventListener('keydown', fn); };
  window.addEventListener('pointerdown', fn);
  window.addEventListener('keydown', fn);
}

/* ============================================================
   BGM 节奏点检测（回放「电影剪辑」卡点用）
   ------------------------------------------------------------
   不用 BPM、不估周期：直接在频谱上找「瞬态」（鼓点 / 重音）——
     ① 缩混单声道 → 降采样到 ≈11kHz（抗混叠一阶低通 + 平均）；
     ② 短时傅里叶（128 点 Hann，帧移 64 ≈ 5.8ms）→ 对数压缩的幅度谱；
     ③ 谱通量（spectral flux）= 相邻帧谱的正增量求和 = 起音强度曲线；
     ④ 自适应阈值（局部均值）峰值拣选 + 抛物线插值定时 → 瞬态时刻（升序）。
   阈值用「相对局部均值的对比度」而不是「最大值的百分比」：长音 / 噪声的谱通量
   本来就平坦（峰 ≈ 均值），用百分比阈值会把噪声全检出来；另有全曲「瞬态性」
   判据（均值 / 中值，有鼓点 ≫ 2，平铺素材 ≈ 1）兜底。
   对数压缩让强弱段落（主歌 / 副歌）都能检出 —— 实测整段动态 4 倍仍 100% 命中。
   返回 null = 没有明显瞬态（太短 / 静音 / 长音铺底 / 噪声）→ 调用方照旧「拐点吸附」。
   ============================================================ */
function computeRhythm(buf) {
  const sr = buf.sampleRate || 44100;
  const nCh = buf.numberOfChannels || 1;
  const total = buf.length;
  const dur = total / sr;
  if (!total || dur < 4) return null;                  // 太短：检不出节奏
  let dec = 1;                                         // 降采样到 ≈11kHz：瞬态够用，省算力
  while (sr / dec > 16000 && dec < 8) dec *= 2;
  const sr2 = sr / dec;
  const n = Math.floor(total / dec);
  if (n < 512) return null;

  /* ① 缩混 + 降采样；峰值归一，结果与 BGM 音量无关 */
  const ch = [];
  for (let c = 0; c < nCh; c++) ch.push(buf.getChannelData(c));
  const invCh = 1 / nCh;
  const a = Math.exp(-2 * Math.PI * Math.min(5000, sr2 * 0.45) / sr);
  const x = new Float32Array(n);
  let lp = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    let v = 0, cnt = 0;
    for (let k = 0; k < dec; k++) {
      const j = i * dec + k;
      if (j >= total) break;
      let s = ch[0][j];
      for (let c = 1; c < nCh; c++) s += ch[c][j];
      lp += a * (s * invCh - lp);
      v += lp; cnt++;
    }
    v = cnt ? v / cnt : v;
    x[i] = v;
    const av = v < 0 ? -v : v;
    if (av > peak) peak = av;
  }
  if (peak < 1e-5) return null;                        // 整段静音
  const kPk = 1 / peak;
  for (let i = 0; i < n; i++) x[i] *= kPk;

  /* ②③ 短时谱 → 谱通量 */
  const N = 128, HOP = 64;                             // 窗 ≈11.6ms / 帧移 ≈5.8ms
  const hopSec = HOP / sr2;
  const frames = Math.floor((n - N) / HOP) + 1;
  if (frames < 32) return null;
  const bins = N >> 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const G = 16;                                        // 对数压缩增益（峰值归一后）
  const prevLog = new Float32Array(bins);
  const flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) { re[i] = x[off + i] * hann[i]; im[i] = 0; }
    fftInPlace(re, im, N);
    let sum = 0;
    for (let b = 1; b < bins; b++) {                   // 丢掉 DC（bin 0）
      const v = Math.log1p(G * Math.sqrt(re[b] * re[b] + im[b] * im[b]));
      const d = v - prevLog[b];                        // 正增量（半波整流）
      if (f > 0 && d > 0) sum += d;
      prevLog[b] = v;                                  // 就地滚动：这一帧成为下一帧的参照
    }
    flux[f] = sum;
  }

  /* ④ 平滑 → 归一 → 瞬态性判据 → 峰值拣选 */
  const m = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const p0 = i > 0 ? flux[i - 1] : flux[i];
    const p1 = i + 1 < frames ? flux[i + 1] : flux[i];
    m[i] = (p0 + flux[i] + p1) / 3;
  }
  let mx = 0, sum = 0;
  for (let i = 0; i < frames; i++) { if (m[i] > mx) mx = m[i]; sum += m[i]; }
  if (!(mx > 0)) return null;
  const kMx = 1 / mx;
  for (let i = 0; i < frames; i++) m[i] *= kMx;
  const sorted = Float32Array.from(m).sort();           // 中值：全曲「瞬态性」判据
  const crest = (sum * kMx / frames) / (sorted[frames >> 1] + 1e-9);
  if (crest < 2) return null;                          // 谱通量平坦：长音 / 噪声 → 无节奏点

  const pre = new Float64Array(frames + 1);            // 前缀和：O(1) 取局部均值
  for (let i = 0; i < frames; i++) pre[i + 1] = pre[i] + m[i];
  const ww = Math.max(2, Math.round(0.2 / hopSec));    // 局部基准窗 ±0.2s
  const DELTA = 0.08, LAM = 2.0, CONTRAST = 1.5, MIN_GAP = 0.09;
  const times = [], strengths = [];
  for (let i = 2; i < frames - 2; i++) {
    if (m[i] <= m[i - 1] || m[i] < m[i + 1]) continue; // 局部极大
    if (m[i] < m[i - 2] || m[i] < m[i + 2]) continue;
    const lo = i - ww > 0 ? i - ww : 0;
    const hi = i + ww + 1 < frames ? i + ww + 1 : frames;
    const base = (pre[hi] - pre[lo]) / (hi - lo);
    if (m[i] <= DELTA || m[i] <= LAM * base || m[i] <= CONTRAST * base) continue;
    const y0 = m[i - 1], y1 = m[i], y2 = m[i + 1];
    const den = y0 - 2 * y1 + y2;
    let d = Math.abs(den) > 1e-12 ? 0.5 * (y0 - y2) / den : 0;   // 抛物线插值：亚帧定时
    if (d > 0.5) d = 0.5; else if (d < -0.5) d = -0.5;
    const t = (i + d) * hopSec;
    const last = times.length - 1;
    if (last >= 0 && t - times[last] < MIN_GAP) {      // 挨太近：只留强的
      if (y1 > strengths[last]) { times[last] = t; strengths[last] = y1; }
      continue;
    }
    times.push(t); strengths.push(y1);
  }
  if (times.length < 4 || times.length < dur * 0.25) return null;   // 太稀疏：不值得卡点
  const rate = times.length / dur;
  return {
    times, strengths, count: times.length,
    window: clamp(0.5 / rate, 0.08, 0.22),             // 吸附窗 = 半个平均间隔
    rate, duration: dur,
  };
}

/** 原地 radix-2 FFT（Cooley-Tukey），长度必须是 2 的幂 */
function fftInPlace(re, im, n) {
  for (let i = 1, j = 0; i < n; i++) {                 // 位反转置换
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {             // 蝶形
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;                              // 旋转因子（递推）
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const jr = i + k + half;
        const vr = re[jr] * cr - im[jr] * ci;
        const vi = re[jr] * ci + im[jr] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[jr] = ur - vr; im[jr] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}