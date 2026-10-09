/* ============================================================
   静态托管（miniserve 等）下的缓存处理
   ------------------------------------------------------------
   用 serve.py 打开时，出站会自动给 <script>/<link>/import 加上
   ?v=<站点版本>，改完代码刷新即生效；用纯静态服务器（miniserve /
   其它托管）打开时没有这层保护，浏览器可能一直用旧模块，导致页面
   卡在「正在初始化」。

   这个 Service Worker 接管后，会把同源页面用到的 html / js / mjs /
   css / json 请求改为「强制向服务器校验」（cache: 'no-cache'）：
   文件没变就走 304 用缓存（快），文件变了立刻拿到新内容（稳）。
   页面本身只在「首次被接管 / 更新」时自动重载一次，不会循环。
   ============================================================ */
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// 需要保证「刷新即最新」的资源
const FRESH = /\.(?:js|mjs|css|html?|json)$/i;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  const nav = req.mode === 'navigate';
  if (!nav && !FRESH.test(url.pathname)) return;

  event.respondWith((async () => {
    try {
      // no-cache：每次都向服务器校验，变了就取新的，没变仍用缓存
      return await fetch(req, { cache: 'no-cache' });
    } catch (e) {
      try { return await fetch(req); }
      catch (e2) { return new Response('', { status: 503, statusText: 'offline' }); }
    }
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});