/* ============================================================
   MapModifier（地图变体）
   ------------------------------------------------------------
   两种变体，可以单独出现，也可以叠加：
   · mirror —— 整张地图左右镜像。实现放在**渲染层**（场景 scene.scale.x = -1），
     所以几何 / 动画 / 事件位移 / 液体 / 粒子 / 玩家模型全部一起镜像，
     而物理（Cannon）、关卡数据、记录仪仍在原来的空间里跑 —— 玩法完全等价，
     回放也自动是对的（回放继承记录的镜像状态再镜像一次渲染）。
     镜像下玩家的左右操作不反转（按 D 仍向屏幕右侧走），只把鼠标 / 摇杆的
     左右视角增量取反，见 player.js。
   · time —— **整个世界的时间流速**：会话里的 wdt = dt × time，动画、事件里的 wait、
     物理模拟、液体、机关、关卡计时全部按 wdt 推进；BGM 走 playbackRate 一起拉伸。
     只有 UI（倒数 / 提示计时）与相机装置（转视角手感）用真实 dt。

   变体可以手动指定（选关面板的变体选择条），也可以交给「意外惊喜」（默认）：
   每局小概率命中，命中后进入若干局冷却。
   ============================================================ */
import { clamp } from '../core/util.js';
import { store } from '../core/storage.js';

export const SURPRISE_CHANCE = 0.15;   // 意外惊喜的基础概率（1.5/10）
export const SURPRISE_COOLDOWN = 2;    // 命中之后的冷却局数
const COOLDOWN_KEY = 'modifier.cooldown';

/* 手动模式的固定速率与随机池 */
export const SLOW_RATE = 0.85;
export const FAST_RATE = 1.27;
const SLOW_POOL = [0.8, 0.86, 0.9];
const FAST_POOL = [1.20, 1.28, 1.34];

/** 无变体（一场「正常」的关卡） */
export const NO_MODIFIER = Object.freeze({ mirror: false, time: 1, surprise: false });

/** 手动模式：k = 设置里存的值，l = 界面上的说明 */
export const MODIFIER_MODES = [
  { k: 'auto', l: '意外惊喜（默认）' },
  { k: 'off', l: '关闭' },
  { k: 'mirror', l: '镜像' },
  { k: 'slow', l: '减慢 · 时间流速 ×' + SLOW_RATE },
  { k: 'fast', l: '加快 · 时间流速 ×' + FAST_RATE },
  { k: 'mirrorSlow', l: '镜像 + 减慢' },
  { k: 'mirrorFast', l: '镜像 + 加快' },
];

const MODE_KEYS = new Set(MODIFIER_MODES.map((m) => m.k));

/** 时间速率 → 可读文本（1× 返回空串） */
export function timeRateLabel(t) {
  const v = Number(t) || 1;
  if (Math.abs(v - 1) < 0.01) return '';
  return (v < 1 ? '减慢 ×' : '加快 ×') + (Math.round(v * 100) / 100);
}

/** 变体 → 可读文本（无变体返回空串），例如「镜像 + 减慢 ×0.7」 */
export function modifierLabel(m) {
  const parts = [];
  if (m && m.mirror) parts.push('镜像');
  const t = timeRateLabel(m && m.time);
  if (t) parts.push(t);
  return parts.join(' + ');
}

/** 横幅用文本：意外惊喜会带前缀 */
export function modifierText(m) {
  const s = modifierLabel(m);
  if (!s) return '';
  return (m && m.surprise ? '意外惊喜 · ' : '地图变体 · ') + s;
}

export function modifierActive(m) { return !!(m && (m.mirror || Math.abs((Number(m.time) || 1) - 1) > 0.01)); }

/** 把任意输入（字符串模式 / 对象 / null）规整成变体对象 */
export function normalizeModifier(m) {
  if (typeof m === 'string') return modifierOfMode(m);
  const out = { mirror: !!(m && m.mirror), time: 1, surprise: !!(m && m.surprise) };
  const t = Number(m && m.time);
  if (Number.isFinite(t) && t > 0 && Math.abs(t - 1) > 0.01) out.time = clamp(t, 0.25, 3);
  return out;
}

/** 手动模式 → 变体对象（auto 也按「无变体」返回，实际抽取走 rollModifier） */
export function modifierOfMode(mode) {
  switch (MODE_KEYS.has(mode) ? mode : 'auto') {
    case 'mirror': return { mirror: true, time: 1, surprise: false };
    case 'slow': return { mirror: false, time: SLOW_RATE, surprise: false };
    case 'fast': return { mirror: false, time: FAST_RATE, surprise: false };
    case 'mirrorSlow': return { mirror: true, time: SLOW_RATE, surprise: false };
    case 'mirrorFast': return { mirror: true, time: FAST_RATE, surprise: false };
    default: return { ...NO_MODIFIER };   // auto / off
  }
}

export function isAutoMode(mode) { return !MODE_KEYS.has(mode) || mode === 'auto'; }

/** 抽一个意外惊喜：镜像 / 变速 / 两者叠加 */
export function pickSurprise(rnd = Math.random) {
  const r = rnd();
  if (r < 0.36) return { mirror: true, time: 1, surprise: true };
  if (r < 0.72) return { mirror: false, time: pickRate(rnd()), surprise: true };
  return { mirror: true, time: pickRate(rnd()), surprise: true };
}

/** 从一个 [0,1) 随机数挑一个速率：前半段取减慢池，后半段取加快池（池内均匀） */
function pickRate(r) {
  const x = clamp(Number(r) || 0, 0, 0.999999);
  const slow = x < 0.5;
  const pool = slow ? SLOW_POOL : FAST_POOL;
  const u = slow ? x / 0.5 : (x - 0.5) / 0.5;
  return pool[Math.min(pool.length - 1, Math.floor(u * pool.length))];
}

/** 当前冷却状态（选关面板显示用）：{ since, cooling } */
export async function peekCooldown() {
  let rec = null;
  try { rec = await store.kvGet(COOLDOWN_KEY, null); } catch (e) { /* 读不到就当没冷却 */ }
  const since = Math.max(0, Number(rec && rec.since) || 0);
  return { since, cooling: since < SURPRISE_COOLDOWN };
}

/**
 * 按模式抽本局的变体。
 * auto：冷却未过 → 直接空手；冷却已过 → 掷 SURPRISE_CHANCE 的骰子。
 * 无论中不中，auto 都会让冷却计数往前走一格（中了则清零）。
 * @returns {Promise<{mirror:boolean,time:number,surprise:boolean}>}
 */
export async function rollModifier(mode) {
  if (!isAutoMode(mode)) return modifierOfMode(mode);
  const st = await peekCooldown();
  if (!st.cooling && Math.random() < SURPRISE_CHANCE) {
    try { await store.kvSet(COOLDOWN_KEY, { since: 0 }); } catch (e) { /* ignore */ }
    return pickSurprise();
  }
  try { await store.kvSet(COOLDOWN_KEY, { since: st.since + 1 }); } catch (e) { /* ignore */ }
  return { ...NO_MODIFIER };
}
