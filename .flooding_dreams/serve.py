#!/usr/bin/env python3
"""本地服务器：静态文件（禁用缓存 + 自动版本号） + 存档 API（落盘到 saves/）。

为什么存档放服务器上：浏览器的 IndexedDB / localStorage 按 origin
（协议 + 主机 + 端口）隔离，端口一变存档就换了一套。写到磁盘之后，
无论用哪个端口、哪个浏览器打开，读到的都是同一份。

静态文件出站前会自动给 index.html 的 <script>/<link>/importmap 与每个 .js 的
import 引用加上 ?v=<站点版本>（版本 = 源文件 mtime/大小摘要）。这样改了代码
之后浏览器一定重新下载整张模块图，不会出现「新旧模块混用 → 报缺少导出 →
页面卡在正在初始化」。

存档单元：一个关卡 = 一个文件夹（自带素材，可整体拷走）
  saves/levels/<levelId>/level.json          关卡记录（meta + 数据 + 缩略图）
  saves/levels/<levelId>/assets/<id>.json    素材元数据
  saves/levels/<levelId>/assets/<id>.bin     素材原始字节
  saves/assets/                              旧的全局素材池：只读回退，不再写入

API（都挂在 /api/store/ 下，只允许本机 127.0.0.1 访问）：
  GET  ping                                    -> 探测接口是否可用
  GET  list?store=levels                       -> 全部关卡记录（含旧平铺文件）
  GET  get?store=levels&id=xxx                 -> 单条关卡记录
  POST put?store=levels   (body=JSON 记录)     -> 写入关卡文件夹
  POST del?store=levels&id=xxx                 -> 删除整个关卡文件夹
  POST clear?store=levels                      -> 清空全部关卡
  GET  list?store=assets[&level=xxx]           -> 素材元数据（带 level 只看该关；不带看全部）
  GET  get?store=assets&id=xxx[&level=xxx]     -> 单条素材元数据
  GET  asset?id=xxx[&level=xxx]                -> 素材原始字节
  POST asset?id=xxx[&level=xxx]&meta=<JSON>    -> 写入素材（带 level 写进关卡文件夹）
  POST del?store=assets&id=xxx[&level=xxx]     -> 删除素材
"""
import hashlib
import json
import os
import re
import shutil
import sys
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 站点根目录（index.html 所在处）
SAVE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'saves')
STORES = ('levels', 'assets', 'progress', 'kv')
API = '/api/store/'
MAX_BODY = 512 * 1024 * 1024                      # 单个资源上限
LOCAL_ONLY = ('127.0.0.1', '::1', '::ffff:127.0.0.1')
LEVEL_FILE = 'level.json'                         # 关卡文件夹里的记录文件名
ASSET_DIR = 'assets'                              # 关卡文件夹里的素材子目录


def _dir(name):
    d = os.path.join(SAVE_DIR, name)
    os.makedirs(d, exist_ok=True)
    return d


def _fname(key):
    """把任意 id / 键映射成安全的文件名（稳定即可，不需要可逆）。"""
    safe = re.sub(r'[^A-Za-z0-9._-]', '_', str(key))[:60]
    return safe + '-' + hashlib.md5(str(key).encode('utf-8')).hexdigest()[:10]


def _dir_name(key):
    """关卡文件夹名：可读（id 本身通常已是安全字符）+ 短哈希防碰撞。"""
    safe = re.sub(r'[^A-Za-z0-9._-]', '_', str(key)).strip('._')[:60]
    if not safe:
        safe = 'lv'
    return safe + '-' + hashlib.md5(str(key).encode('utf-8')).hexdigest()[:8]


def _levels_root():
    return _dir('levels')


def _level_dir(level_id, create=False):
    d = os.path.join(_levels_root(), _dir_name(level_id))
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def _level_file(level_id):
    return os.path.join(_level_dir(level_id), LEVEL_FILE)


def _legacy_level_file(level_id):
    """旧结构：saves/levels/<hash>.json（单文件）"""
    return os.path.join(_levels_root(), _fname(level_id) + '.json')


def _asset_dir(level_id):
    return os.path.join(_level_dir(level_id), ASSET_DIR)


def _list_asset_metas(d):
    out = []
    if not os.path.isdir(d):
        return out
    for fn in sorted(os.listdir(d)):
        if fn.endswith('.json'):
            rec = _read_json(os.path.join(d, fn))
            if rec is not None:
                out.append(rec)
    return out


def _find_asset(asset_id, level_id=None):
    """定位素材：先按 level 提示直查，再遍历各关卡文件夹，最后回退旧全局池。
    返回 (素材目录, 元数据)，找不到返回 (None, None)。"""
    aid = _fname(asset_id) + '.json'
    if level_id:
        d = _asset_dir(level_id)
        meta = _read_json(os.path.join(d, aid))
        if meta is not None:
            return d, meta
    root = _levels_root()
    for fn in sorted(os.listdir(root)):
        d = os.path.join(root, fn, ASSET_DIR)
        if not os.path.isdir(d):
            continue
        meta = _read_json(os.path.join(d, aid))
        if meta is not None:
            return d, meta
    d = _dir('assets')                       # 旧全局池（兼容回退）
    meta = _read_json(os.path.join(d, aid))
    if meta is not None:
        return d, meta
    return None, None


def _write(path, data):
    """先写临时文件再替换，避免并发写或中断留下半个文件。"""
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def _read_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


# ---------- 关卡（文件夹形态 + 旧平铺文件兼容） ----------
def _list_levels():
    out = []
    root = _levels_root()
    for fn in sorted(os.listdir(root)):
        p = os.path.join(root, fn)
        rec = None
        if os.path.isdir(p):
            rec = _read_json(os.path.join(p, LEVEL_FILE))
        elif fn.endswith('.json'):
            rec = _read_json(p)
        if rec is not None:
            out.append(rec)
    return out


def _get_level(level_id):
    rec = _read_json(_level_file(level_id))
    if rec is not None:
        return rec
    return _read_json(_legacy_level_file(level_id))


def _put_level(rec):
    """写进关卡文件夹，并把旧的平铺文件就地清掉（迁移）。"""
    d = _level_dir(rec['id'], create=True)
    _write(os.path.join(d, LEVEL_FILE), json.dumps(rec, ensure_ascii=False).encode('utf-8'))
    legacy = _legacy_level_file(rec['id'])
    if os.path.exists(legacy):
        os.remove(legacy)


def _del_level(level_id):
    d = _level_dir(level_id)
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
    legacy = _legacy_level_file(level_id)
    if os.path.exists(legacy):
        os.remove(legacy)


def _clear_levels():
    root = _levels_root()
    for fn in os.listdir(root):
        p = os.path.join(root, fn)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif fn.endswith('.json'):
            os.remove(p)


# ---------- 站点资源版本（自动打散浏览器缓存） ----------
# index.html 里的 <script src> / importmap，以及每个 .js 里的 import 引用，
# 出站前统统加上 ?v=<站点版本>。任何源文件一改，版本就变，浏览器必然重新
# 下载整张模块图 —— 否则旧的缓存模块会和新的混在一起，报
# “does not provide an export named ...” 并把页面卡在“正在初始化”。
_JS_REF = re.compile(
    rb"""((?:\bfrom|\bimport)\s*\(?\s*)(['"])(\.{1,2}/[^'"\s)]+?\.(?:js|mjs|css|json))(\?[^'"]*)?\2"""
)
_HTML_REF = re.compile(
    rb"""(['"])(\.{1,2}/[^'"\s)>]+?\.(?:js|mjs|css))(\?[^'"]*)?\1"""
)
_VER = {'t': 0.0, 'v': b'0'}


def _site_version():
    """取站点版本：index.html + js/styles/vendor 下所有文件的 (路径, mtime, 大小) 摘要。"""
    now = time.time()
    if now - _VER['t'] < 0.5:
        return _VER['v']
    h = hashlib.md5()
    targets = [os.path.join(ROOT, 'index.html')]
    for sub in ('js', 'styles', 'vendor'):
        targets.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), sub))
    for t in targets:
        if os.path.isfile(t):
            files = [t]
        elif os.path.isdir(t):
            files = []
            for base, dirs, names in os.walk(t):
                dirs.sort()
                files += [os.path.join(base, n) for n in sorted(names)]
        else:
            continue
        for fp in files:
            try:
                st = os.stat(fp)
            except OSError:
                continue
            h.update(('%s|%d|%d;' % (os.path.relpath(fp, ROOT), st.st_mtime_ns, st.st_size)).encode('utf-8'))
    _VER['t'] = now
    _VER['v'] = h.hexdigest()[:10].encode('ascii')
    return _VER['v']


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def translate_path(self, path):
        """存档目录不通过静态文件服务对外暴露（任何编码写法都拦掉）。"""
        p = os.path.abspath(super().translate_path(path))
        if p == SAVE_DIR or p.startswith(SAVE_DIR + os.sep):
            return os.path.join(ROOT, '__not_found__')
        return p

    # ---------- 收发工具 ----------
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data, mime):
        self.send_response(200)
        self.send_header('Content-Type', mime or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n < 0 or n > MAX_BODY:
            return None
        buf = bytearray()
        while len(buf) < n:
            chunk = self.rfile.read(min(1 << 20, n - len(buf)))
            if not chunk:
                break
            buf += chunk
        return bytes(buf)

    @staticmethod
    def _q(query):
        return {k: v[0] for k, v in parse_qs(query).items()}

    def _local(self):
        return self.client_address[0] in LOCAL_ONLY

    # ---------- 路由 ----------
    # ---------- 静态文件：给模块引用加上版本号后再发出去 ----------
    def _serve_stamped(self, path):
        p = self.translate_path(path)
        if os.path.isdir(p):
            if not path.endswith('/'):
                return False                     # 交给默认实现做 301
            p = os.path.join(p, 'index.html')
        ext = os.path.splitext(p)[1].lower()
        if ext not in ('.js', '.mjs', '.html', '.htm') or not os.path.isfile(p):
            return False
        try:
            with open(p, 'rb') as f:
                data = f.read()
        except OSError:
            return False
        if len(data) > 1200000:
            return False                         # 大文件（三方库）不扫内容，它们的 URL 由引用方打标
        v = _site_version()

        def rep_js(m):
            sep, q, spec = m.group(1), m.group(2), m.group(3)
            return sep + q + spec + b'?v=' + v + q

        def rep_html(m):
            q, spec = m.group(1), m.group(2)
            return q + spec + b'?v=' + v + q

        out = (_HTML_REF if ext in ('.html', '.htm') else _JS_REF).sub(
            rep_html if ext in ('.html', '.htm') else rep_js, data)
        if out == data:
            return False                         # 没有本地引用，按原样发
        ctype = self.guess_type(p)
        if ext in ('.js', '.mjs') or not ctype:
            ctype = 'text/javascript'            # 模块脚本必须带 JS MIME，否则浏览器直接拒收
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)
        return True

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith(API):
            self._api_get(u.path[len(API):].strip('/'), self._q(u.query))
            return
        if self._serve_stamped(u.path):
            return
        super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path.startswith(API):
            self._api_post(u.path[len(API):].strip('/'), self._q(u.query))
            return
        self.send_error(404, 'Not Found')

    # ---------- 存档 API ----------
    def _api_get(self, act, q):
        if not self._local():
            self._json({'ok': False, 'error': 'forbidden'}, 403)
            return
        if act == 'ping':
            self._json({'ok': True, 'root': SAVE_DIR, 'stores': list(STORES)})
            return
        name = 'assets' if act == 'asset' else q.get('store', '')
        if name not in STORES:
            self._json({'ok': False, 'error': 'bad store'}, 400)
            return
        level = q.get('level') or ''
        if act == 'list':
            if name == 'levels':
                self._json(_list_levels())
                return
            if name == 'assets':
                if level:
                    self._json(_list_asset_metas(_asset_dir(level)))
                    return
                # 不带 level：返回全部（各关卡文件夹 + 旧全局池）
                root = _levels_root()
                out = []
                for fn in sorted(os.listdir(root)):
                    d = os.path.join(root, fn, ASSET_DIR)
                    if os.path.isdir(d):
                        out.extend(_list_asset_metas(d))
                out.extend(_list_asset_metas(_dir('assets')))
                self._json(out)
                return
            d = _dir(name)
            out = []
            for fn in sorted(os.listdir(d)):
                if fn.endswith('.json'):
                    rec = _read_json(os.path.join(d, fn))
                    if rec is not None:
                        out.append(rec)
            self._json(out)
            return
        if act == 'get':
            key = q.get('id') or q.get('k') or ''
            if name == 'levels':
                self._json(_get_level(key))
                return
            if name == 'assets':
                _d, meta = _find_asset(key, level)
                self._json(meta)
                return
            self._json(_read_json(os.path.join(_dir(name), _fname(key) + '.json')))
            return
        if act == 'asset':
            key = q.get('id') or ''
            d, meta = _find_asset(key, level)
            if not meta:
                self.send_error(404, 'asset not found')
                return
            binp = os.path.join(d, _fname(key) + '.bin')
            data = b''
            if os.path.exists(binp):
                with open(binp, 'rb') as f:
                    data = f.read()
            self._bytes(data, meta.get('mime'))
            return
        self.send_error(404, 'Not Found')

    def _api_post(self, act, q):
        if not self._local():
            self._json({'ok': False, 'error': 'forbidden'}, 403)
            return
        name = 'assets' if act == 'asset' else q.get('store', '')
        if name not in STORES:
            self._json({'ok': False, 'error': 'bad store'}, 400)
            return
        level = q.get('level') or ''
        if act == 'put':
            raw = self._body()
            try:
                rec = json.loads(raw.decode('utf-8')) if raw else None
            except Exception:
                rec = None
            key = rec.get('id') or rec.get('k') if isinstance(rec, dict) else None
            if not key:
                self._json({'ok': False, 'error': 'bad record'}, 400)
                return
            if name == 'levels':
                _put_level(rec)                     # 一个关卡 = 一个文件夹
                self._json({'ok': True})
                return
            if name == 'assets':
                # 只改元数据（重命名）：定位到素材所在的关卡文件夹后原样覆盖 .json
                d, old = _find_asset(key, level)
                if not old:
                    self._json({'ok': False, 'error': 'asset not found'}, 404)
                    return
                meta = dict(rec)
                meta.pop('data', None)
                meta['id'] = key
                _write(os.path.join(d, _fname(key) + '.json'),
                       json.dumps(meta, ensure_ascii=False).encode('utf-8'))
                self._json({'ok': True})
                return
            _write(os.path.join(_dir(name), _fname(key) + '.json'),
                   json.dumps(rec, ensure_ascii=False).encode('utf-8'))
            self._json({'ok': True})
            return
        if act == 'asset':
            key = q.get('id') or ''
            try:
                meta = json.loads(q.get('meta') or '{}')
            except Exception:
                meta = None
            raw = self._body()
            if not key or not isinstance(meta, dict) or raw is None:
                self._json({'ok': False, 'error': 'bad asset'}, 400)
                return
            meta.pop('data', None)                  # 字节单独存 .bin，元数据不含 data
            meta['id'] = key
            # 带 level → 写进该关卡文件夹（素材本地化）；否则写旧全局池
            d = _asset_dir(level) if level else _dir('assets')
            os.makedirs(d, exist_ok=True)
            _write(os.path.join(d, _fname(key) + '.bin'), raw)
            _write(os.path.join(d, _fname(key) + '.json'),
                   json.dumps(meta, ensure_ascii=False).encode('utf-8'))
            self._json({'ok': True})
            return
        if act in ('del', 'clear'):
            if act == 'del':
                key = q.get('id') or q.get('k') or ''
                if name == 'levels':
                    _del_level(key)
                    self._json({'ok': True})
                    return
                if name == 'assets':
                    d, meta = _find_asset(key, level)
                    if not meta:
                        self._json({'ok': True})
                        return
                    for ext in ('.json', '.bin'):
                        p = os.path.join(d, _fname(key) + ext)
                        if os.path.exists(p):
                            os.remove(p)
                    self._json({'ok': True})
                    return
                for ext in ('.json', '.bin'):
                    p = os.path.join(_dir(name), _fname(key) + ext)
                    if os.path.exists(p):
                        os.remove(p)
            else:
                if name == 'levels':
                    _clear_levels()
                    self._json({'ok': True})
                    return
                d = _dir(name)
                for fn in os.listdir(d):
                    if fn.endswith('.json') or fn.endswith('.bin'):
                        os.remove(os.path.join(d, fn))
            self._json({'ok': True})
            return
        self.send_error(404, 'Not Found')


def _port_busy(port, iface):
    import socket
    host = '127.0.0.1' if iface in ('', '0.0.0.0', '::') else iface
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex((host, port)) == 0


def main():
    # 端口可以随便变：存档在 saves/ 里，不跟端口绑定
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8010
    iface = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'
    os.makedirs(SAVE_DIR, exist_ok=True)
    if _port_busy(port, iface):
        # 多个进程同时绑同一端口时 Windows 会互相“抢”，浏览器可能一直连到
        # 那个还在跑旧代码的进程上，于是页面卡在“正在初始化”。直接不启动。
        print(f'端口 {port} 上已经有一个服务在跑，多半是上次启动的旧服务器。')
        print('请先结束它再启动（否则你看到的可能一直是旧代码）：')
        print(f'  Windows: netstat -ano | findstr :{port}   →   taskkill /PID <pid> /F')
        sys.exit(1)
    handler = partial(Handler, directory=ROOT)
    with ThreadingHTTPServer((iface, port), handler) as httpd:
        print(f'Flooding Dreams 本地服务器: http://localhost:{port}/')
        print(f'存档目录: {SAVE_DIR}  (Ctrl+C 停止)')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
