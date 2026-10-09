/* ============================================================
   渲染 Worker 入口
   ------------------------------------------------------------
   持有 OffscreenCanvas + WebGLRenderer + 镜像场景（SceneMirror）。
   主线程发来的消息：
     init / resize / quality / screen / env / scene / frame / clear / dispose
   回传：
     ready（能力） / stats（节流） / error / lost
   importmap 不覆盖 Worker，因此这里只走相对路径（three-ns.js）。
   ============================================================ */
import { MSG, STATS_INTERVAL } from './render-proto.js';
import { SceneMirror } from './scene-mirror.js';

let mirror = null;
let statsTimer = 0;

function post(msg, transfer) {
  try { self.postMessage(msg, transfer || []); }
  catch (e) { /* 结构克隆失败：忽略该条消息 */ }
}

function handleInit(m) {
  try {
    mirror = new SceneMirror();
    const caps = mirror.init(m.canvas, m);
    if (m.quality) mirror.applyQuality(m.quality);
    if (m.screen) mirror.applyScreen(m.screen);
    post({ t: MSG.READY, caps });
  } catch (e) {
    post({ t: MSG.ERROR, message: String(e && e.message || e), stack: e && e.stack });
  }
}

function handle(m) {
  try {
    switch (m.t) {
      case MSG.INIT: handleInit(m); break;
      case MSG.RESIZE: if (mirror) mirror.setSize(m.width, m.height, m.pixelRatio); break;
      case MSG.QUALITY: if (mirror) mirror.applyQuality(m.quality); break;
      case MSG.SCREEN: if (mirror) mirror.applyScreen(m.screen); break;
      case MSG.SCENE: if (mirror) mirror.applyScene(m); break;
      case MSG.RENDER:
        if (mirror && mirror.pipeline) { mirror.pipeline.setDescriptors(m.render); mirror.pipeline.refreshGlassMap(); }
        break;
      case MSG.VIEWPORT: if (mirror) mirror.setViewport(m.rect); break;
      case MSG.ENV: if (mirror) mirror.applyEnv(m); break;
      case MSG.FRAME: if (mirror) mirror.applyFrame(m); break;
      case MSG.ADD: if (mirror) mirror.applyAdd(m); break;
      case MSG.REMOVE: if (mirror) mirror.applyRemove(m.uuids); break;
      case MSG.TEX: if (mirror) mirror.applyTex(m.items); break;
      case MSG.CLEAR: if (mirror) mirror.disposeScene(); break;
      case MSG.DISPOSE:
        if (mirror) mirror.dispose();
        mirror = null;
        if (statsTimer) clearInterval(statsTimer);
        break;
      default: break;
    }
  } catch (e) {
    post({ t: MSG.ERROR, message: String(e && e.message || e), stack: e && e.stack });
  }
}

self.onmessage = (ev) => handle(ev.data);

// 统计节流回传：禁止每帧 postMessage
statsTimer = setInterval(() => {
  if (mirror && mirror.lastStats) post({ t: MSG.STATS, stats: mirror.lastStats });
}, STATS_INTERVAL);

// 上下文丢失：通知主线程整体回退 / 重建
self.addEventListener && self.addEventListener('error', (e) => {
  post({ t: MSG.ERROR, message: String(e && e.message || e) });
});
