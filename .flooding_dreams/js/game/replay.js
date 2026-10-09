/* ============================================================
   游玩混剪记录仪 · 数据层
   ------------------------------------------------------------
   · 采样：按固定频率把玩家的「行动」写进列式数组
     （位置 / 朝向 / 相机 / 姿态 / 速度 / 氧气 / 生命）
   · 事件：死亡、复活、受伤、拾取、用工具、通关（由会话回调写入），
     以及由采样本身推导出的动作切换
     （起跳 / 落地 / 贴墙 / 攀爬 / 滑索 / 滑铲 / 入水 / 缺气 / 冲刺）
   · 高光：把采样折成带评分的片段，供电影级混剪挑选
   · 存档：写进存档层 kv（桌面版落盘 / 浏览器 IndexedDB，与其它存档共用后端）
   ============================================================ */
import { store } from '../core/storage.js';
import { clamp, round, uid } from '../core/util.js';
import { PLAYER } from '../config.js';

export const REPLAY_HZ = 15;             // 采样频率（Hz）
export const REPLAY_MIN_SEC = 3;         // 短于此时长不保存（无意义）
const KEY_PREFIX = 'fd.replay.';
export const REPLAY_VERSION = 1;

/* 姿态枚举：存索引，回放时还原 */
export const STATES = ['normal', 'slide', 'swim', 'walljump', 'climb', 'zipline'];
const STATE_IX = new Map(STATES.map((s, i) => [s, i]));

/* 标志位 */
const FLAG = {
  alive: 1, grounded: 2, onZip: 4, inLiquid: 8, swim: 16, headUnder: 32, invincible: 64,
};

const R = {
  // 位置同理走三位：两位小数在 15Hz 下是 ±0.005 的量化噪声，
  // 逐采样点抖动，人眼读作角色「微微发颤」。三位之后噪声降到像素级以下。
  pos: (v) => round(v, 3),
  ang: (v) => round(v, 3),
  num: (v) => round(v, 2),
  // 时间列单独走三位小数：15Hz 的采样间隔是 1/15 ≈ 0.0667，
  // 只留两位就会在 0.06 / 0.07 之间来回跳 —— 插值出的速度跟着 ±7% 交替，
  // 回放里读作「人物每隔 1/15 秒顿一下」。三位之后误差降到 0.7% 量级。
  time: (v) => round(v, 3),
};

/* ============================================================
   采样器
   ============================================================ */
export class ActionRecorder {
  constructor(level, opts = {}) {
    this.levelId = (level && level.id) || '';
    this.levelName = (level && level.name) || '';
    this.test = !!opts.test;
    this.t = 0;
    this.acc = 0;
    this.n = 0;
    this.events = [];
    this._prev = null;
    // 列式存储：逐列数组，JSON 体积远小于逐帧对象
    // hx/hy/hz = 玩家**头部**世界坐标（`player.headPos`）：POV 的机位就是从这三列重建的，
    // 而不是复用 cx/cy/cz（那是第三人称相机的位姿，拿来当第一人称会得到越肩视角）。
    this.c = {
      t: [], x: [], y: [], z: [], fy: [], ky: [], kp: [],
      st: [], fl: [], sp: [], vy: [], ox: [], hp: [], cx: [], cy: [], cz: [],
      hx: [], hy: [], hz: [],
    };
  }

  /** 每帧调用（仅在正式游玩、未倒数时） */
  sample(dt, session) {
    const p = session.player;
    const cam = session.camera;
    const ctl = session.cameraCtl;
    if (!p || !p.body) return;
    this.t += dt;
    this.acc += dt;
    if (this.n > 0 && this.acc < 1 / REPLAY_HZ) return;
    this.acc = 0;

    const b = p.body;
    const st = STATE_IX.get(p.state);
    let fl = 0;
    if (p.alive) fl |= FLAG.alive;
    if (p.grounded) fl |= FLAG.grounded;
    if (p.onZipline) fl |= FLAG.onZip;
    if (p.env.inLiquid) fl |= FLAG.inLiquid;
    if (p.env.swim) fl |= FLAG.swim;
    if (p.env.headUnder) fl |= FLAG.headUnder;
    if (p.invincible) fl |= FLAG.invincible;

    const c = this.c;
    c.t.push(R.time(this.t));
    c.x.push(R.pos(b.position.x)); c.y.push(R.pos(b.position.y)); c.z.push(R.pos(b.position.z));
    c.fy.push(R.ang(p.yaw));
    c.ky.push(R.ang(ctl ? ctl.yaw : 0));
    c.kp.push(R.ang(ctl ? ctl.pitch : 0));
    c.st.push(st === undefined ? 0 : st);
    c.fl.push(fl);
    c.sp.push(R.num(Math.hypot(b.velocity.x, b.velocity.z)));
    c.vy.push(R.num(b.velocity.y));
    c.ox.push(R.num(p.oxygen));
    c.hp.push(R.num(p.health));
    c.cx.push(R.pos(cam.position.x)); c.cy.push(R.pos(cam.position.y)); c.cz.push(R.pos(cam.position.z));
    c.hx.push(R.pos(p.headPos.x)); c.hy.push(R.pos(p.headPos.y)); c.hz.push(R.pos(p.headPos.z));
    this.n++;

    this._detect(p, fl);
    this._prev = {
      grounded: p.grounded, state: p.state, onZip: p.onZipline,
      inLiquid: p.env.inLiquid, swim: p.env.swim, headUnder: p.env.headUnder,
      hp: p.health, ox: p.oxygen, alive: p.alive, sp: Math.hypot(b.velocity.x, b.velocity.z),
    };
  }

  /** 从采样变化推导动作事件（不依赖任何钩子，保证记录完整） */
  _detect(p, fl) {
    const q = this._prev;
    if (!q) return;
    const sp = Math.hypot(p.body.velocity.x, p.body.velocity.z);
    const vy = p.body.velocity.y;
    if (!q.grounded && (fl & FLAG.grounded) && q.alive) this.event('land', { v: Math.abs(q.vy || 0) });
    if (q.grounded && !(fl & FLAG.grounded) && vy > 1 && q.alive) this.event('jump', { v: round(vy, 2) });
    if (q.state !== p.state) {
      if (p.state === 'walljump') this.event('walljump', {});
      else if (p.state === 'climb') this.event('climb', {});
      else if (p.state === 'zipline') this.event('zipline', {});
      else if (p.state === 'slide') this.event('slide', {});
      else if (p.state === 'swim') this.event('swim', {});
    }
    if (!(q.inLiquid) && (fl & FLAG.inLiquid)) this.event('enterWater', {});
    if (!q.headUnder && (fl & FLAG.headUnder)) this.event('dive', {});
    if (q.hp > p.health + 0.5) this.event('hurt', { v: round(q.hp - p.health, 1) });
    if (q.ox >= p.maxOxygen * 0.25 && p.oxygen < p.maxOxygen * 0.25) this.event('lowAir', {});
    if (q.sp <= 26 && sp > 26 && p.grounded) this.event('sprint', { v: round(sp, 1) });
    if (q.alive && !p.alive) this.event('death', {});
    q.vy = vy;
  }

  /** 记录一次事件（会话回调写入） */
  event(k, extra) {
    if (this.n === 0) return;
    const e = { t: R.num(this.t), k };
    if (extra) for (const key in extra) {
      const v = extra[key];
      e[key] = typeof v === 'number' ? round(v, 2) : v;
    }
    this.events.push(e);
  }

  /** 收尾 → 记录对象（无需保存时返回 null） */
  finish(info = {}) {
    if (this.n < 2 || this.t < REPLAY_MIN_SEC) return null;
    return {
      v: REPLAY_VERSION,
      id: 'rp' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      levelId: this.levelId,
      levelName: this.levelName,
      at: Date.now(),
      hz: REPLAY_HZ,
      duration: round(this.t, 2),
      win: !!info.win,
      winAt: Number(info.winAt) || 0,       // 通关于回放时间轴上的精确时刻（秒，毫秒精度；0 = 未通关）
      reason: info.reason || '',
      deaths: Number(info.deaths) || 0,
      playTime: round(Number(info.time) || this.t, 2),
      levelTime: round(Number(info.levelTime) || 0, 2),   // 关卡时长（0 = 不限时）
      test: this.test,
      spawn: info.spawn || null,
      // 本局的地图变体（镜像 / 时间流速）：回放时镜像要一并重演，时间变体不套用（见 modifier.js）
      mod: info.mod || null,
      ev: this.events,
      f: this.c,
    };
  }
}

/* ============================================================
   读数：把列式数据包成可插值的时间轴
   ============================================================ */
export class ReplayData {
  constructor(rec) {
    this.rec = rec;
    this.c = rec.f;
    this.n = this.c.t ? this.c.t.length : 0;
    this.duration = rec.duration || (this.n ? this.c.t[this.n - 1] : 0);
  }

  /** 时间 → 采样下标（floor） */
  indexAt(t) {
    const a = this.c.t;
    let lo = 0, hi = this.n - 1;
    if (hi < 0) return 0;
    if (t <= a[0]) return 0;
    if (t >= a[hi]) return hi;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= t) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** 插值取一帧（姿态 / 标志取前一个采样）——位置与朝向走三次样条，其余线性 */
  sampleAt(t, out = {}) {
    const c = this.c;
    const i = this.indexAt(t);
    const j = Math.min(i + 1, this.n - 1);
    const t0 = c.t[i], t1 = c.t[j];
    const u = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
    const L = (a) => a[i] + (a[j] - a[i]) * u;
    out.t = t;
    // 位置与相机轨迹走样条：15Hz 的线性插值是一条「折线」，每 1/15 秒换一次斜率，
    // 回放里读作「人物一格一格地顿」（人物抖动）。样条让位置与速度都连续，
    // 而且严格穿过每一个原始采样点 —— 不产生滞后，不会「跟丢了」。
    out.x = cr(c.x, c.t, i, j, u); out.y = cr(c.y, c.t, i, j, u); out.z = cr(c.z, c.t, i, j, u);
    out.fy = crA(c.fy, c.t, i, j, u);
    out.ky = crA(c.ky, c.t, i, j, u);
    out.kp = cr(c.kp, c.t, i, j, u);
    out.st = c.st[i];
    out.fl = c.fl[i];
    out.sp = L(c.sp);
    out.vy = L(c.vy);
    out.ox = L(c.ox);
    out.hp = L(c.hp);
    out.cx = cr(c.cx, c.t, i, j, u); out.cy = cr(c.cy, c.t, i, j, u); out.cz = cr(c.cz, c.t, i, j, u);
    // 头部位置（POV 用）。旧存档没有这三列 —— 不 bump REPLAY_VERSION（bump 会让所有旧回放
    // 被 `loadReplay` 丢掉），改为在此就地回退：头顶 = 脚底 + (totalH - 0.5)，与游戏内
    // `player.headPos` 的定义完全一致，所以旧回放也能以正确机位播 POV。
    if (c.hx) {
      out.hx = cr(c.hx, c.t, i, j, u); out.hy = cr(c.hy, c.t, i, j, u); out.hz = cr(c.hz, c.t, i, j, u);
    } else {
      out.hx = out.x; out.hy = out.y + PLAYER.totalH - 0.5; out.hz = out.z;
    }
    out.state = STATES[out.st] || 'normal';
    out.alive = !!(out.fl & FLAG.alive);
    out.grounded = !!(out.fl & FLAG.grounded);
    out.onZipline = !!(out.fl & FLAG.onZip);
    out.inLiquid = !!(out.fl & FLAG.inLiquid);
    out.swim = !!(out.fl & FLAG.swim);
    out.headUnder = !!(out.fl & FLAG.headUnder);
    return out;
  }

  /** 取某时刻的世界坐标（脚底） */
  posAt(t, out) {
    out = out || { x: 0, y: 0, z: 0 };
    const s = this.sampleAt(t);
    out.x = s.x; out.y = s.y; out.z = s.z;
    return out;
  }

  /** 事件（可按时间窗口过滤） */
  eventsIn(t0, t1) {
    const out = [];
    for (const e of this.rec.ev || []) if (e.t >= t0 && e.t <= t1) out.push(e);
    return out;
  }
}

function shortestAngle(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * 段内三次 Hermite（Catmull-Rom 型）：两端点 + 两端切向。
 * 切向按**真实时间间隔**做中心差分、再折算到段参数 u 上 —— 这一条是关键：
 * 时间列只有两位小数，15Hz 的采样间隔在存储里会在 0.06 / 0.07 之间交替，
 * 不做时间折算的话，两个相邻段插出来的速度就会跟着交替 ±7%（只有 0.06 段短、
 * 走得快，0.07 段长、走得慢），肉眼读作「人物每隔 1/15 秒顿一下」。
 * 折算之后速度在节点两侧连续，顿挫消失；位置仍然严格穿过每一个原始采样点。
 * 切向幅度夹在「段长 × 1.5」以内：坐标同样只保留两位小数（±0.005 的量化噪声），
 * 不夹的话样条会把这层噪声放大成比原来更明显的抖。
 * 段本身是一个「瞬移」（重生 / 传送 / 切换第一人称）时退回线性，
 * 免得样条把一次跳跃画成一段回头弧。
 */
function herm(p1, p2, p0, p3, u, ta, tb, tc, td) {
  const d = p2 - p1;
  if (Math.abs(d) > 1.5) return p1 + d * u;
  const g = Math.max(1e-6, tc - tb);                       // 本段时长
  let m1 = (p2 - p0) * g / Math.max(1e-6, tc - ta);
  let m2 = (p3 - p1) * g / Math.max(1e-6, td - tb);
  const lim = Math.abs(d) * 1.5 + 1e-4;
  if (m1 > lim) m1 = lim; else if (m1 < -lim) m1 = -lim;
  if (m2 > lim) m2 = lim; else if (m2 < -lim) m2 = -lim;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1
    + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
}

/** 标量列（i / j 为当前段两端，T 为时间列） */
function cr(a, T, i, j, u) {
  const n = a.length;
  const i0 = i > 0 ? i - 1 : i;
  const j1 = j < n - 1 ? j + 1 : j;
  return herm(a[i], a[j], a[i0], a[j1], u, T[i0], T[i], T[j], T[j1]);
}

/** 角度列：先按最短弧把前后采样「展开」成连续标量，再走同一条样条 */
function crA(a, T, i, j, u) {
  const n = a.length;
  const p1 = a[i];
  const p2 = p1 + shortestAngle(p1, a[j]);
  const p0 = p1 - shortestAngle(a[i > 0 ? i - 1 : i], p1);
  const p3 = p2 + shortestAngle(a[j], a[j < n - 1 ? j + 1 : j]);
  return herm(p1, p2, p0, p3, u, T[i > 0 ? i - 1 : i], T[i], T[j], T[j < n - 1 ? j + 1 : j]);
}

/* ============================================================
   高光扫描
   ------------------------------------------------------------
   规则表给出每种动作的「可拍性」评分、默认时长与优先运镜；
   评分仅供参考，真正的排序还会叠加速度 / 持续时间等强度因子。
   ============================================================ */
export const HIGHLIGHT_RULES = {
  win: { score: 100, label: '通关', dur: 4.6, pref: ['lead', 'orbit', 'crane'] },
  death: { score: 86, label: '阵亡', dur: 2.8, pref: ['pushIn', 'static', 'lowHero'] },
  walljump: { score: 74, label: '贴墙跳', dur: 1.9, pref: ['track', 'lowHero', 'orbit'] },
  zipline: { score: 70, label: '滑索', dur: 2.5, pref: ['lead', 'track', 'topDown'] },
  climb: { score: 64, label: '攀爬', dur: 2.3, pref: ['lowHero', 'crane', 'orbit'] },
  lowAir: { score: 62, label: '缺氧', dur: 2.2, pref: ['pushIn', 'lowHero', 'track'] },
  hurt: { score: 58, label: '受击', dur: 1.7, pref: ['track', 'lowHero', 'pushIn'] },
  dive: { score: 58, label: '入水', dur: 2.1, pref: ['topDown', 'track', 'orbit'] },
  enterWater: { score: 47, label: '入水', dur: 1.9, pref: ['track', 'orbit'] },
  jump: { score: 45, label: '腾空', dur: 1.5, pref: ['lowHero', 'track', 'orbit'] },
  slide: { score: 43, label: '滑铲', dur: 1.4, pref: ['track', 'lead'] },
  pickup: { score: 40, label: '拾取', dur: 1.5, pref: ['orbit', 'track'] },
  sprint: { score: 35, label: '冲刺', dur: 1.7, pref: ['track', 'lead', 'follow'] },
  swim: { score: 36, label: '泅渡', dur: 2.0, pref: ['topDown', 'track'] },
  idle: { score: 10, label: '探索', dur: 2.8, pref: ['static', 'orbit', 'crane'] },
};

/* 可作为「持续段」识别的姿态 */
const RUN_KINDS = { climb: 0.45, zipline: 0.6, swim: 1.1, slide: 0.35 };

/**
 * 扫描高光片段
 * @returns [{ k, t0, t1, score, label, intensity, peakSpeed, pos:{x,y,z}, yaw }]
 */
export function scanHighlights(data, opts = {}) {
  const minScore = opts.minScore != null ? opts.minScore : 0;
  const segs = [];
  const evs = data.rec.ev || [];

  /* 1) 事件型高光 */
  for (const e of evs) {
    const rule = HIGHLIGHT_RULES[e.k];
    if (!rule || e.k === 'land' || e.k === 'swim') continue;
    const dur = rule.dur * (e.k === 'win' ? 1.35 : 1);
    const lead = dur * 0.28;
    segs.push(mkSeg(e.k, e.t - lead, e.t - lead + dur, rule, data, e));
  }

  /* 2) 持续段型高光（攀爬 / 滑索 / 泅渡 / 滑铲 / 腾空） */
  const c = data.c;
  for (const kind in RUN_KINDS) {
    const minDur = RUN_KINDS[kind];
    let start = -1;
    for (let i = 0; i < data.n; i++) {
      const on = c.st[i] === STATE_IX.get(kind);
      if (on && start < 0) start = i;
      if ((!on || i === data.n - 1) && start >= 0) {
        const t0 = c.t[start], t1 = c.t[on ? i : i - 1];
        if (t1 - t0 >= minDur) {
          const rule = HIGHLIGHT_RULES[kind] || HIGHLIGHT_RULES.idle;
          segs.push(mkSeg(kind, t0 - 0.2, t1 + 0.35, rule, data, null));
        }
        start = -1;
      }
    }
  }
  // 腾空段（离地且滞空够久）
  let air = -1;
  for (let i = 0; i < data.n; i++) {
    const airborne = (c.fl[i] & FLAG.grounded) === 0 && (c.fl[i] & FLAG.alive) !== 0;
    if (airborne && air < 0) air = i;
    if ((!airborne || i === data.n - 1) && air >= 0) {
      const t0 = c.t[air], t1 = c.t[airborne ? i : i - 1];
      if (t1 - t0 >= 0.42) segs.push(mkSeg('jump', t0 - 0.15, t1 + 0.25, HIGHLIGHT_RULES.jump, data, null, 0.9));
      air = -1;
    }
  }

  /* 3) 合并重叠 + 排序 */
  segs.sort((a, b) => a.t0 - b.t0);
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.t0 <= last.t1 + 0.35 && (last.score < s.score ? s.t0 - last.t0 < 1.4 : true)) {
      // 重叠：留评分更高的那个，但把时间窗并起来
      if (s.score > last.score) { s.t0 = last.t0; merged[merged.length - 1] = s; }
      else last.t1 = Math.max(last.t1, s.t1);
      continue;
    }
    merged.push(s);
  }

  /* 4) 去重挑选：按评分降序贪心，保证最小间隔 */
  const sorted = [...merged].sort((a, b) => b.score - a.score);
  const picked = [];
  const gap = opts.minGap != null ? opts.minGap : 1.6;
  const maxClips = opts.maxClips || 14;
  for (const s of sorted) {
    if (s.score < minScore) continue;
    if (picked.some((o) => s.t0 < o.t1 + gap && o.t0 < s.t1 + gap) && !(s.k === 'win' || s.k === 'death')) continue;
    picked.push(s);
    if (picked.length >= maxClips) break;
  }
  return picked.sort((a, b) => a.t0 - b.t0).map((s) => ({
    ...s,
    t0: round(clamp(s.t0, 0, data.duration), 2),
    t1: round(clamp(s.t1, 0, data.duration), 2),
  }));
}

function mkSeg(kind, t0, t1, rule, data, ev, boost) {
  const mid = clamp((t0 + t1) / 2, 0, data.duration);
  const s = data.sampleAt(mid);
  let peak = 0;
  for (let t = t0; t <= t1; t += 0.2) peak = Math.max(peak, data.sampleAt(clamp(t, 0, data.duration)).sp);
  const dur = Math.max(0.2, t1 - t0);
  const intensity = clamp(rule.score / 100 * 0.55 + peak / 34 * 0.3 + clamp(dur / 3, 0, 1) * 0.15 + (boost || 0) * 0.1, 0, 1);
  return {
    k: kind,
    label: rule.label,
    t0: Math.max(0, t0),
    t1: Math.min(data.duration, t1),
    score: rule.score + peak * 1.1 + dur * 2 + (ev && ev.v ? Math.min(12, ev.v * 0.25) : 0),
    intensity,
    peakSpeed: round(peak, 1),
    pos: { x: round(s.x, 2), y: round(s.y, 2), z: round(s.z, 2) },
    yaw: round(s.fy, 3),
    pref: rule.pref,
    evKind: ev ? ev.k : kind,
  };
}

/** 单帧 / 无高光时的兜底：把整局均分成若干探索镜头 */
export function fillerHighlights(data, need) {
  const out = [];
  const span = data.duration / Math.max(1, need);
  for (let i = 0; i < need; i++) {
    const t0 = i * span;
    const t1 = Math.min(data.duration, t0 + Math.min(3.2, span * 0.9));
    if (t1 - t0 < 0.6) continue;
    const rule = HIGHLIGHT_RULES.idle;
    out.push(mkSeg('idle', t0, t1, rule, data, null));
  }
  return out;
}

/* ============================================================
   存档
   ============================================================ */
export async function saveReplay(rec) {
  if (!rec) return null;
  const k = KEY_PREFIX + rec.id;
  rec.summary = {
    levelName: rec.levelName, duration: rec.duration, win: rec.win,
    deaths: rec.deaths, at: rec.at, test: rec.test, clips: 0,
  };
  await store.put('kv', { k, id: k, v: rec });
  return rec;
}

export async function listReplays(levelId) {
  let all = [];
  try { all = await store.all('kv'); } catch (e) { return []; }
  const out = [];
  for (const r of all || []) {
    if (!r || typeof r.k !== 'string' || !r.k.startsWith(KEY_PREFIX)) continue;
    const v = r.v;
    if (!v || v.v !== REPLAY_VERSION) continue;
    if (levelId && v.levelId !== levelId) continue;
    const s = v.summary || {};
    out.push({
      id: v.id, levelId: v.levelId, levelName: v.levelName || s.levelName || '未知关卡',
      at: v.at || s.at || 0, duration: v.duration || 0, win: !!v.win,
      deaths: v.deaths || 0, reason: v.reason || '', test: !!v.test,
      clips: s.clips || 0,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function loadReplay(id) {
  const k = KEY_PREFIX + id;
  const r = await store.get('kv', k);
  const v = r && r.v ? r.v : (r && r.f ? r : null);
  if (!v || !v.f) return null;
  return v;
}

export async function deleteReplay(id) {
  await store.del('kv', KEY_PREFIX + id);
}

/** 记录里出现过的关卡 id（回放面板按关卡分组用） */
export async function replayLevelIds() {
  const list = await listReplays();
  return [...new Set(list.map((r) => r.levelId).filter(Boolean))];
}

export { FLAG as REPLAY_FLAG, uid as replayUid };
