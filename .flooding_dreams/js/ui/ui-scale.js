/* ============================================================
   界面缩放：按分辨率自适应 / 手动，外加可调字体大小
   ------------------------------------------------------------
   两枚根变量驱动全站 UI（CSS 里的 px 长度都写成 calc(Npx * var(...))）：
     --ui-s  ：整体缩放系数（布局 + 字号），auto 模式下 = min(宽/1920, 高/1080) × 1.25
     --ui-fs ：字号附加倍率 = (16 + fontSizePx) / 16，只作用于「功能性文字」，
               艺术性文字（品牌标题 / 开局倒数 / banner / 结算标题）不乘它
   这样低分辨率下界面与文字整体变小；再用手动倍率或字体大小微调。
   ============================================================ */
import { settings } from '../core/settings.js';

const REF_W = 1920;
const REF_H = 1080;
const AUTO_GAIN = 1.25;  // 自动模式整体增益（原基准显示偏小，统一放大 25%）
const AUTO_MIN = 0.5;    // 自动模式的下限，避免超低分辨率把界面缩到看不清
const AUTO_MAX = 1.25;   // 高分屏上限（= 基准尺寸 × 增益，只缩不放超出该值）
const MANUAL_MIN = 0.4;
const MANUAL_MAX = 2;
const FONT_MIN = -8;
const FONT_MAX = 24;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 当前整体缩放系数 */
export function uiScale() {
  const mode = settings.get('ui.scaleMode', 'auto');
  if (mode === 'manual') {
    const v = Number(settings.get('ui.scale', 1));
    return clamp(Number.isFinite(v) ? v : 1, MANUAL_MIN, MANUAL_MAX);
  }
  const w = window.innerWidth || REF_W;
  const h = window.innerHeight || REF_H;
  return clamp(Math.min(w / REF_W, h / REF_H) * AUTO_GAIN, AUTO_MIN, AUTO_MAX);
}

/** 当前字号附加倍率（1 = 原版；fontSize=+8 → 1.5） */
export function uiFontScale() {
  const d = Number(settings.get('ui.fontSize', 0));
  return (16 + clamp(Number.isFinite(d) ? Math.round(d) : 0, FONT_MIN, FONT_MAX)) / 16;
}

/** 把两个系数写进根变量 */
export function applyUiScale() {
  const root = document.documentElement.style;
  root.setProperty('--ui-s', String(uiScale()));
  root.setProperty('--ui-fs', String(uiFontScale()));
}

/** 启动：立即应用一次，并跟随窗口尺寸与设置变化重算 */
export function initUiScale() {
  applyUiScale();
  let raf = 0;
  window.addEventListener('resize', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; applyUiScale(); });
  });
  for (const p of ['ui.scaleMode', 'ui.scale', 'ui.fontSize']) settings.on('change:' + p, applyUiScale);
  return applyUiScale;
}