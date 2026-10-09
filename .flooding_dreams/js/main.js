/* ============================================================
   入口
   ============================================================ */
import { App } from './app.js';
import { toast } from './ui/dom.js';
import { audio } from './core/audio.js';
import { init as initI18n } from './core/i18n.js';
import { initTooltips } from './ui/tooltip.js';
import { initUiScale } from './ui/ui-scale.js';

// 界面缩放：尽早写入根变量，避免启动时闪一下原尺寸
initUiScale();

const boot = document.getElementById('boot');
const bootMsg = document.getElementById('boot-msg');

function fatal(msg, err) {
  console.error('[main]', msg, err);
  if (bootMsg) bootMsg.innerHTML = '出错了：' + String(msg).replace(/[<>&]/g, '');
  if (boot) boot.classList.add('show');
  toast('出错了：' + msg, 'err', 6000);
}

window.addEventListener('error', (e) => {
  console.error('[window.error]', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled]', e.reason);
});

let app;
// 界面语言：装上文本挂钩（同步）并异步加载上次选的语言包，之后再启动
const i18nReady = initI18n();
initTooltips();   // 全局悬浮提示 + 使用手册（按钮注入主菜单与编辑器顶栏）
try {
  app = new App(document.getElementById('gl'));
  window.__fd = app;       // 调试用
  window.__fd.audio = audio;   // 音频对接口：替换音效 / 播放 BGM / 播放素材
  window.FDAudio = audio;
  // 安卓壳：系统返回键交给 App 处理（关面板 / 开关暂停），
  // 返回 false 表示已经退无可退，壳子会把应用退回桌面。
  if (window.AndroidHost) {
    window.__fdBack = () => {
      try { return !!app.back(); } catch (e) { console.warn('[android] back', e); return false; }
    };
  }
  i18nReady.catch((e) => console.warn('[i18n]', e))
    .then(() => app.boot().catch((e) => fatal(e && e.message ? e.message : String(e), e)));
} catch (e) {
  fatal(e && e.message ? e.message : String(e), e);
}

export { app };