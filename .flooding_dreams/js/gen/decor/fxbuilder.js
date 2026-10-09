/* ============================================================
   程序化装饰 · 氛围装配（M1）
   ------------------------------------------------------------
   把主题的 env / postfx / fx 落成真实对象与 settings 覆盖。
   M1 只产出「无碰撞」类型：
     light / volumelight / fogvol / emitter / postfx
   —— 全在 builder 的 NO_PHYSICS 集合里，所以数学上不可能影响
      可达性（零风险模式的全部内容）。

   ★ settings 只叠加、不夺权：
     · 只写 fog / ambient / sun / sky / skyIntensity / env
     · 玩法项（gravityScale / timeLimit / deathLimit / objective / voidY）一律不碰
     · 雾只收不放（min）：主题只能比骨架预设更浓，不能看得更远，
       否则会露出骨架没打算给玩家看的远景破绽
   ============================================================ */
import { clamp, round } from '../../core/util.js';
import { POSTFX_TOGGLE_KEYS } from '../../core/postfx.js';

/** 一张关卡能承受的氛围预算（超出就按 光 > 粒子 > 雾 > 光柱 的顺序裁） */
export const DEFAULT_BUDGET = {
  objects: 420,   // 装饰对象总数上限
  lights: 6,      // 真实动态光源上限（Three.js 光源一多就掉帧）
  emitters: 12,
  beams: 4,
  mist: 6,
};

/** 主题累加数量：强度只缩放 fx 数量，不改配色。
 *  strength = 0 → 一件氛围都不加（只写调色与雾/光色），这是移动端与「老关卡只换配色」的入口 */
function fxCount(base, strength) {
  return Math.max(0, Math.round(base * clamp(strength, 0, 1)));
}

/**
 * 环境叠加：返回可直接 shallow-merge 进 level.settings 的片段。
 * 只包含氛围键，绝不包含玩法键。
 */
export function blendEnv(base, theme) {
  const env = (theme && theme.env) || {};
  const b = base || {};
  const bFog = b.fog || {};
  const bAmb = b.ambient || {};
  const bSun = b.sun || {};

  const fog = { ...bFog, enabled: true };
  if (env.fog) {
    if (env.fog.color) fog.color = env.fog.color;
    fog.near = minNum(bFog.near, env.fog.near);
    fog.far = minNum(bFog.far, env.fog.far);
  }

  const sky = env.sky || b.sky || 'dream';
  return {
    fog,
    ambient: {
      ...bAmb,
      color: (env.ambient && env.ambient.color) || bAmb.color,
      intensity: clamp(num(bAmb.intensity, 0.5) * num(env.ambient && env.ambient.mul, 1), 0.05, 0.8),
    },
    sun: {
      ...bSun,
      color: (env.sun && env.sun.color) || bSun.color,
      intensity: clamp(num(bSun.intensity, 2.2) * num(env.sun && env.sun.mul, 1), 0, 6),
    },
    sky,
    skyIntensity: clamp(num(b.skyIntensity, 1) * num(env.skyMul, 1), 0, 3),
    // 天空为 none 时环境贴图无意义（与 shellSettings 同口径）
    env: sky !== 'none',
  };
}

/**
 * 装配氛围。
 * @returns { objects[], settings, stats }
 *   objects  = 可直接 push 进 level.objects 的 { type, over } 描述
 *   settings = blendEnv 的结果（调用方负责 shallow-merge）
 */
export function buildAmbience({ level, theme, fields, rng, strength = 0.7, budget, idGen, postfx = false }) {
  const lim = { ...DEFAULT_BUDGET, ...(budget || {}) };
  const settings = blendEnv((level && level.settings) || {}, theme);
  const out = [];
  const stats = { light: 0, beam: 0, mist: 0, dust: 0, postfx: 0, skipped: 0 };

  /* ---------- 后处理：**默认不加** ----------
     后处理是逐帧全屏开销，进关时还要现编译着色器，把加载拖得更久；
     主题里的 postfx 字段保留，但只有显式 opts.postfx === true 才启用。 */
  const pf = postfx ? postfxDesc(theme, idGen) : null;
  if (pf) { out.push(pf); stats.postfx = 1; }

  if (!fields.route.length) {
    return { objects: out, settings, stats };            // 没有路线 → 只给色彩
  }

  /* ---------- 锚点：沿走廊均匀取样 ---------- */
  const fireAt = (n) => anchors(fields, n, rng);

  /* ---------- 1) 环境点光（最要紧：玩家得看得清路） ---------- */
  const L = theme.fx && theme.fx.light;
  if (L) {
    const n = Math.min(fxCount(L.count, strength), lim.lights);
    for (const s of fireAt(n)) {
      const p = fields.aside(s, s.r + 6 + rng.range(0, 6), rng.sign());
      if (!p) continue;
      out.push({
        type: 'light',
        over: {
          id: idGen('dl'),
          name: `${theme.label}·环境光`,
          lightType: 'point',
          position: [p.x, round(s.y + num(L.height, 10), 3), p.z],
          color: L.color,
          intensity: num(L.intensity, 1.2),
          distance: num(L.distance, 120),
          castShadow: false,
          helper: false,
          visible: true,
        },
      });
      stats.light++;
    }
  }

  /* ---------- 2) 粒子（主题识别度最高的一件） ---------- */
  const D = theme.fx && theme.fx.dust;
  if (D) {
    const n = Math.min(fxCount(D.count, strength), lim.emitters);
    for (const s of fireAt(n)) {
      const sc = D.scale || [26, 14, 26];
      out.push({
        type: 'emitter',
        over: {
          id: idGen('de'),
          name: `${theme.label}·粒子`,
          emitShape: 'volume',
          position: [round(s.x, 3), round(s.y + num(sc[1], 14) * 0.5 - 2, 3), round(s.z, 3)],
          scale: [num(sc[0], 26), num(sc[1], 14), num(sc[2], 26)],
          color: D.color,
          alpha: num(D.alpha, 0.8),
          rate: num(D.rate, 10),
          life: num(D.life, 5),
          size: num(D.size, 1),
          speed: num(D.speed, 1.2),
          up: num(D.up, 0.3),
          gravity: num(D.gravity, 0),
          rise: num(D.rise, 0),
          drag: num(D.drag, 2),
          soft: !!D.soft,
          dirEmit: false,     // 程序化生成沿用旧的上升/重力模型，不启用方向发射
        },
      });
      stats.dust++;
    }
  }

  /* ---------- 3) 体积雾（局部潮气 / 沼雾） ---------- */
  const M = theme.fx && theme.fx.mist;
  if (M) {
    const n = Math.min(fxCount(M.count, strength), lim.mist);
    for (const s of fireAt(n)) {
      const sc = M.scale || [36, 16, 36];
      const p = fields.aside(s, rng.range(0, 10) * rng.sign(), 1);
      if (!p) continue;
      out.push({
        type: 'fogvol',
        over: {
          id: idGen('df'),
          name: `${theme.label}·体积雾`,
          shape: 'sphere',
          position: [p.x, round(s.y + num(sc[1], 16) * 0.5 - 3, 3), p.z],
          scale: [num(sc[0], 36), num(sc[1], 16), num(sc[2], 36)],
          color: M.color,
          density: num(M.density, 0.35),
          noiseScale: 1,
          noiseSpeed: num(M.speed, 0.25),
          softness: 0.55,
        },
      });
      stats.mist++;
    }
  }

  /* ---------- 4) 体积光柱（最花哨，预算不够就先裁它） ---------- */
  const B = theme.fx && theme.fx.beam;
  if (B) {
    const n = Math.min(fxCount(B.count, strength), lim.beams);
    for (const s of fireAt(n)) {
      const sc = B.scale || [8, 30, 8];
      out.push({
        type: 'volumelight',
        over: {
          id: idGen('dv'),
          name: `${theme.label}·光柱`,
          shape: 'cone',
          position: [round(s.x, 3), round(s.y + num(sc[1], 30) * 0.5, 3), round(s.z, 3)],
          scale: [num(sc[0], 8), num(sc[1], 30), num(sc[2], 8)],
          color: B.color,
          intensity: num(B.intensity, 0.4),
          falloff: 2,
          fadeEnd: 1,
          // 不附带真实光源：光束本身只是 mesh，省掉一盏动态光
          withLight: false,
          visible: true,
        },
      });
      stats.beam++;
    }
  }

  /* ---------- 5) 按对象总预算裁剪（从最有用的开始留） ---------- */
  const kept = trimToBudget(out, lim.objects);
  stats.skipped = out.length - kept.length;
  return { objects: kept, settings, stats: recount(kept, stats) };
}

/* ============================================================
   零件
   ============================================================ */

function postfxDesc(theme, idGen) {
  const src = (theme && theme.postfx) || null;
  if (!src || !src.preset) return null;
  const over = { id: idGen('dp'), name: `${theme.label}·调色`, preset: src.preset, priority: 1 };
  const en = {};
  for (const k of POSTFX_TOGGLE_KEYS) {
    if (src[k] === undefined) continue;
    over[k] = src[k];
    en[k] = true;                                        // 逐项开关：写了才启用
  }
  over.strength = num(src.strength, 1);
  over.en = en;
  return { type: 'postfx', over };
}

/** 沿走廊均匀取 n 个锚点（带轻微抖动，避免整齐排列）；n ≤ 0 时返回空 */
function anchors(fields, n, rng) {
  const total = Math.round(Number(n) || 0);
  if (total <= 0) return [];
  const out = [];
  for (let i = 0; i < total; i++) {
    let u = (i + 0.5) / total;
    if (total > 1) u = clamp(u + rng.range(-0.05, 0.05), 0.02, 0.98);
    const s = fields.sampleAt(u);
    if (s) out.push(s);
  }
  return out;
}

/** 按「后加的更容易被裁」的顺序保留：这里 out 已经按重要性入队，直接截断即可 */
function trimToBudget(objects, max) {
  const cap = Math.max(0, Math.round(num(max, DEFAULT_BUDGET.objects)));
  return objects.length <= cap ? objects : objects.slice(0, cap);
}

function recount(objects, stats) {
  const out = { light: 0, beam: 0, mist: 0, dust: 0, postfx: 0, skipped: stats.skipped || 0 };
  for (const o of objects) {
    if (o.type === 'light') out.light++;
    else if (o.type === 'volumelight') out.beam++;
    else if (o.type === 'fogvol') out.mist++;
    else if (o.type === 'emitter') out.dust++;
    else if (o.type === 'postfx') out.postfx++;
  }
  return out;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 两个数取更小（用于「雾只收不放」）；缺项时取另一个 */
function minNum(a, b) {
  const x = Number(a), y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return Math.min(x, y);
  if (Number.isFinite(x)) return x;
  if (Number.isFinite(y)) return y;
  return a;
}