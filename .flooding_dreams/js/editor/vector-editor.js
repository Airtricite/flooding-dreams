/* ============================================================
   高级 2D 矢量图编辑器（浮动窗 · Canvas）
   ------------------------------------------------------------
   一个编辑器三处复用（constraint 决定坐标空间与「应用」的写回目标）：
     · free        —— 自由矢量图：存素材 / 导出 SVG / 生成「矢量挤出体」对象
     · pipe        —— 管道截面：坐标空间 = 单位半径（参考圈 r=1），
                      应用后写回 sectionDoc / sectionPtsList / sectionPts
     · portal      —— 传送门轮廓：坐标空间 = [-0.5, 0.5]²（多一个方框限制），
                      应用后写回 points / handles / segModes / shapeDoc

   能力：绘制（钢笔）/ 选择（Shift 多选、框选）/ 拖点 / 贝塞尔手柄 /
         段上插点（Ctrl+点）/ Alt 删点 / 折角倒圆与倒角（含正弦调制）/
         布尔运算（并·减·交·异或，栅格辅助轮廓化）/ 图层 / 颜色 /
         导入 SVG / 导出 SVG / 存为素材。
   非连续平面图形（多个互不相交的子路径）天然支持：文档就是多路径集合。
   ============================================================ */
import { el, clear, toast } from '../ui/dom.js';
import { store } from '../core/storage.js';
import { round } from '../core/util.js';
import { invalidateAssetOptions } from '../ui/grid-picker.js';
import { refreshAssetManager } from './asset-manager.js';
import {
  newDoc, newLayer, newPath, cloneDoc, clonePath, docPaths,
  flattenPath, docContours, contoursToDoc, pathsBBox, polyArea, pointInPoly,
  segmentPoints, hasIn, hasOut, filletPath, parseSVG, docToSVG, transformPath,
} from '../core/vector-shape.js';
import { booleanContours } from '../core/vector-solid.js';
import { portalShapeToDoc, portalDocToShape } from '../world/portal.js';
import { sectionProfiles } from '../world/paths.js';

const W = 520;                 // 画布 CSS 尺寸（正方形）
const H = 520;                 // 画布 CSS 尺寸（正方形）
const HIT = 7;                 // 节点 / 手柄拾取半径（像素）
const EDGE = 7;                // 路径描边拾取半径（像素）
const SNAP = 0.025;            // 网格吸附步长（文档空间）
const MAX_NODES = 400;         // 单条路径节点上限（再多挤出 / 扫掠都会变重）

let _inst = null;
export function openVectorEditor(ed, opts = {}) {
  if (_inst) { _inst.close(); _inst = null; }
  _inst = new VectorEditor(ed, opts);
  return _inst;
}
export function closeVectorEditor() {
  if (_inst) { _inst.close(); _inst = null; }
}
export function vectorEditor() { return _inst; }

/** 单位空间椭圆路径（kappa 近似，逆时针） */
function ellipsePath(r, cx = 0, cy = 0, opts = {}) {
  const k = 0.5522847498, o = r * k;
  return newPath([
    { x: cx + r, y: cy, ox: cx + r, oy: cy + o, ix: cx + r, iy: cy - o },
    { x: cx, y: cy + r, ox: cx - o, oy: cy + r, ix: cx + o, iy: cy + r },
    { x: cx - r, y: cy, ox: cx - r, oy: cy - o, ix: cx - r, iy: cy + o },
    { x: cx, y: cy - r, ox: cx + o, oy: cy - r, ix: cx - o, iy: cy - r },
  ], opts);
}

/* ============================================================
   浮窗
   ============================================================ */
class VectorEditor {
  constructor(ed, opts) {
    this.ed = ed;
    this.opts = opts || {};
    this.target = this.opts.target || 'free';
    this.obj = this.opts.obj || null;
    this.constraint = this.target === 'pipe' ? 'pipe' : (this.target === 'portal' ? 'portal' : 'free');
    this._prev = ed && ed.snap ? ed.snap() : null;

    this.doc = this._loadDoc();
    this.activeLayer = this.doc.layers[0] ? this.doc.layers[0].id : null;
    this.selPaths = new Set();            // 选中的路径 id（可多选）
    this.activePath = null;               // 显示节点 / 手柄的那条路径 id
    this.selNodes = new Set();            // activePath 上选中的节点下标
    this.tool = 'select';
    this.snapOn = true;
    this.draw = null;                     // 绘制中的新路径节点 [{x,y}]
    this.drag = null;
    this.box = null;
    this.bevel = { r: 0.08, profile: 'round', amp: 0, freq: 3 };
    this.view = { k: 200, ox: W / 2, oy: H / 2 };
    this._closed = false;

    this._build();
    this._fitView();
    if (this.target === 'free' && !this.opts.doc) {
      this.selPaths = new Set(this.doc.layers[0].paths.map((p) => p.id));
      this.activePath = this.doc.layers[0].paths[0].id;
    }
    this._refreshPanels();
    this._draw();
  }

  /* ============================================================
     载入 / 写回
     ============================================================ */
  _loadDoc() {
    const o = this.obj;
    if (this.target === 'vec' && o) {
      if (o.vecShape && Array.isArray(o.vecShape.layers)) {
        const d = cloneDoc(o.vecShape);
        if (d.layers.some((l) => l.paths.length)) return d;
      }
    }
    if (this.target === 'pipe' && o) {
      if (o.sectionDoc && Array.isArray(o.sectionDoc.layers)) {
        const d = cloneDoc(o.sectionDoc);
        if (d.layers.some((l) => l.paths.length)) return d;
      }
      const list = sectionProfiles(o).filter((p) => p.length >= 3);
      if (list.length) return contoursToDoc(list, { name: '截面' });
      return contoursToDoc([ellipsePath(0.9).nodes.map((n) => [n.x, n.y])], { name: '截面' });
    }
    if (this.target === 'portal' && o) {
      if (o.shapeDoc && Array.isArray(o.shapeDoc.layers)) {
        const d = cloneDoc(o.shapeDoc);
        if (d.layers.some((l) => l.paths.length)) return d;
      }
      return portalShapeToDoc(o);
    }
    if (this.opts.doc) {
      const d = cloneDoc(this.opts.doc);
      if (d.layers.some((l) => l.paths.length)) return d;
    }
    // 自由矢量图：给一个椭圆起手，省得对着空画布发呆
    const d = newDoc();
    d.layers[0].paths.push(ellipsePath(0.32));
    return d;
  }

  _rebuild() {
    const b = this.ed && this.ed.builder;
    if (!b || !this.obj) return;
    const rec = b.objects.get(this.obj.id);
    if (!rec) return;
    try {
      const fresh = b.rebuild(rec);
      if (fresh) { b.computeBounds(); b.updateSunShadow(); }
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
     文档遍历辅助
     ============================================================ */
  _layerOf(id) { return this.doc.layers.find((l) => l.id === id) || null; }
  _find(id) {
    for (const l of this.doc.layers) for (const p of l.paths) if (p.id === id) return { layer: l, path: p };
    return null;
  }
  _activeLayer() {
    return this._layerOf(this.activeLayer) || this.doc.layers[0] || null;
  }
  /** 选中的 { layer, path } 列表（按文档顺序） */
  _selList() {
    const out = [];
    for (const l of this.doc.layers) for (const p of l.paths) if (this.selPaths.has(p.id)) out.push({ layer: l, path: p });
    return out;
  }
  _activeEntry() { return this.activePath ? this._find(this.activePath) : null; }

  /* ============================================================
     坐标换算
     ============================================================ */
  toScr(x, y) { return [this.view.ox + x * this.view.k, this.view.oy - y * this.view.k]; }
  toWorld(sx, sy) { return [(sx - this.view.ox) / this.view.k, (this.view.oy - sy) / this.view.k]; }
  _snapPt(p) {
    if (!this.snapOn) return p;
    return [Math.round(p[0] / SNAP) * SNAP, Math.round(p[1] / SNAP) * SNAP];
  }

  _fitView() {
    const half = this.constraint === 'pipe' ? 1 : (this.constraint === 'portal' ? 0.5 : null);
    if (half != null) {
      this.view.k = (Math.min(W, H) / 2) / (half * 1.22);
      this.view.ox = W / 2; this.view.oy = H / 2;
      return;
    }
    const paths = docPaths(this.doc).map((x) => x.path);
    const bb = pathsBBox(paths);
    if (!(bb.w > 0 || bb.h > 0)) { this.view.k = 200; this.view.ox = W / 2; this.view.oy = H / 2; return; }
    this.view.k = (Math.min(W, H) * 0.82) / Math.max(bb.w, bb.h);
    this.view.ox = W / 2 - ((bb.minX + bb.maxX) / 2) * this.view.k;
    this.view.oy = H / 2 + ((bb.minY + bb.maxY) / 2) * this.view.k;
  }

  /** 把一组路径整体缩放居中到约束框内 */
  _fitPathsIntoBox(paths) {
    const half = this.constraint === 'pipe' ? 1 : (this.constraint === 'portal' ? 0.5 : null);
    if (half == null || !paths.length) return false;
    const bb = pathsBBox(paths);
    if (!(bb.w > 1e-6 || bb.h > 1e-6)) return false;
    const k = Math.min(half / Math.max(1e-6, bb.w / 2), half / Math.max(1e-6, bb.h / 2));
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    const m = [k, 0, 0, k, -cx * k, -cy * k];
    for (const p of paths) p.nodes = transformPath(p, m).nodes;
    return true;
  }

  /* ============================================================
     DOM 骨架
     ============================================================ */
  _build() {
    const TITLE = {
      free: '矢量图编辑器', pipe: '管道截面·矢量编辑器',
      portal: '传送门轮廓·矢量编辑器', vec: '矢量挤出体·图形编辑器',
    };
    const SUB = {
      pipe: '坐标空间 = 单位半径（虚线参考圈 r=1）· 应用后写回管道截面',
      portal: '坐标空间 = [-0.5, 0.5]²（虚线方框）· 超出部分会被裁到框内',
      vec: '绘制这个挤出体的平面图形 · 应用后写回对象（厚度 / 倒角在属性面板调）',
      free: '绘制 / 编辑矢量图形 · 可导出 SVG、存为素材、生成有厚度的模型',
    };
    const win = el('div', { class: 'ez-win ve-win' });
    this.win = win;
    win.appendChild(el('div', { class: 'ez-head' },
      el('span', { class: 'ez-title', text: TITLE[this.target] || TITLE.free }),
      el('span', { class: 'ez-sub', text: SUB[this.target] || SUB.free }),
      el('button', { class: 'ez-x', text: '✕', title: '关闭（Esc）', onclick: () => this.close() })));

    this.canvas = el('canvas', { class: 've-canvas' });
    this.layersEl = el('div', { class: 've-layers' });
    this.styleEl = el('div', { class: 've-style' });
    this.statusEl = el('span', { class: 've-stat' });

    const left = el('div', { class: 've-left' },
      el('div', { class: 've-sec', text: '图层' }),
      this.layersEl,
      el('div', { class: 've-row' },
        el('button', { class: 'mini', text: '＋ 新建图层', title: '在末尾添加一个图层', onclick: () => this._addLayer() }),
        el('button', { class: 'mini', text: '🗑 删除', title: '删除当前图层（至少保留一个）', onclick: () => this._delLayer() })),
      el('div', { class: 've-sec', text: '样式（选中路径）' }),
      this.styleEl,
      el('div', { class: 've-sec', text: '布尔运算' }),
      el('div', { class: 've-row' },
        this._btn('并', '合并选中路径', () => this._boolean('union')),
        this._btn('减', '用最上层减去其它选中路径', () => this._boolean('subtract')),
        this._btn('交', '取选中路径的交集', () => this._boolean('intersect')),
        this._btn('异或', '取选中路径的对称差', () => this._boolean('xor'))),
      el('div', { class: 've-sec', text: '折角倒圆 / 倒角' }),
      el('div', { class: 've-row' },
        el('span', { class: 've-lab', text: '半径' }),
        this._num(this.bevel.r, 0.005, 0.005, (v) => { this.bevel.r = v; }),
        el('select', {
          class: 've-sel',
          onchange: (e) => { this.bevel.profile = e.target.value; },
        }, el('option', { value: 'round', text: '倒圆' }), el('option', { value: 'chamfer', text: '倒角' })),
        this._btn('倒', '对选中的路径施加折角倒圆 / 倒角', () => this._doFillet())),
      el('div', { class: 've-row' },
        el('span', { class: 've-lab', text: '调制' }),
        el('span', { class: 've-lab', text: '幅' }),
        this._num(this.bevel.amp, 0.05, 0, (v) => { this.bevel.amp = v; }, 1),
        el('span', { class: 've-lab', text: '频' }),
        this._num(this.bevel.freq, 1, 1, (v) => { this.bevel.freq = v; }, 4)),
      el('div', { class: 've-sec', text: '路径操作' }),
      el('div', { class: 've-row' },
        this._btn('复制', '复制选中的路径', () => this._dup()),
        this._btn('删除', '删除选中的路径', () => this._delPaths()),
        this._btn('适配到框', '把全部路径缩放居中到约束框内', () => this._fitAll()),
        this._btn('反向', '反转选中路径的节点方向', () => this._reverse())));

    const tools = el('div', { class: 've-tools' },
      this._tool('选择', 'select'),
      this._tool('绘制', 'draw'),
      this._btn('闭合绘制', '把正在绘制的折线闭合成路径（Enter）', () => this._finishDraw(true)),
      this._btn('结束绘制', '把正在绘制的折线作为开放路径结束（Esc）', () => this._finishDraw(false)),
      el('span', { class: 've-lab', text: '吸附' }),
      el('input', {
        type: 'checkbox', checked: true,
        onchange: (e) => { this.snapOn = !!e.target.checked; },
      }));

    const hint = el('div', { class: 've-tip', text:
      '左键选 / 拖 · Shift 多选 · 空白拖动框选 · Ctrl+点路径插点 · Alt+点节点删点 · '
      + '手柄拖动成曲线（Alt 单独动一侧）· 滚轮缩放 · 中键或空格拖动平移 · Del 删除' });

    const body = el('div', { class: 've-body' },
      left,
      el('div', { class: 've-main' }, tools, this.canvas,
        el('div', { class: 've-row' }, this.statusEl), hint));

    win.appendChild(body);

    const foot = el('div', { class: 'ez-foot ve-foot' },
      this._btn('导入 SVG…', '导入一个 SVG 文件为矢量路径', () => this._pickSvg()),
      this._btn('导出 SVG', '把当前矢量图导出为 SVG 文件', () => this._exportSvg()),
      this._btn('存为素材', '把当前矢量图存为图片素材（可当贴图用）', () => this._saveAsset()),
      this._btn('生成挤出体', '按当前矢量图生成一个有厚度的「矢量挤出体」对象', () => this._spawnVec()));
    if (this.target !== 'free') {
      this.footPrimary = el('button', { class: 'mbtn primary', text: '应用', onclick: () => this._apply() });
      foot.appendChild(this.footPrimary);
    }
    foot.appendChild(el('button', { class: 'mbtn', text: '关闭', onclick: () => this.close() }));
    win.appendChild(foot);

    const host = document.getElementById('app') || document.body;
    host.appendChild(win);
    const ww = win.offsetWidth || 860, wh = win.offsetHeight || 620;
    win.style.left = Math.max(8, Math.min(window.innerWidth - ww - 12, (window.innerWidth - ww) / 2)) + 'px';
    win.style.top = Math.max(8, Math.min(window.innerHeight - wh - 12, (window.innerHeight - wh) / 2)) + 'px';

    let mdrag = null;
    const head = win.querySelector('.ez-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = win.getBoundingClientRect();
      mdrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!mdrag) return;
      win.style.left = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - mdrag.dx)) + 'px';
      win.style.top = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - mdrag.dy)) + 'px';
    });
    const stopDrag = () => { mdrag = null; };
    head.addEventListener('pointerup', stopDrag);
    head.addEventListener('pointercancel', stopDrag);

    this._onKey = (e) => {
      const m = document.getElementById('modal');
      if (m && !m.classList.contains('hidden')) return;
      if (e.code === 'Escape') {
        e.stopPropagation(); e.preventDefault();
        if (this.draw) { this.draw = null; this._draw(); return; }
        this.close();
        return;
      }
      if (e.code === 'Enter' && this.draw) { e.stopPropagation(); e.preventDefault(); this._finishDraw(true); return; }
      if ((e.code === 'Delete' || e.code === 'Backspace') && this.selPaths.size) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
        e.stopPropagation(); e.preventDefault();
        this._delPaths();
      }
    };
    window.addEventListener('keydown', this._onKey, true);

    this._bindCanvas();
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = H + 'px';
  }

  _btn(label, title, fn) { return el('button', { class: 'mini', text: label, title, onclick: fn }); }
  _num(value, st, min, onChange, max) {
    const inp = el('input', { class: 've-num', type: 'number', value: String(value), step: st, min });
    if (max !== undefined) inp.max = max;
    inp.addEventListener('input', () => {
      const v = Number(inp.value);
      if (isFinite(v)) onChange(v);
    });
    return inp;
  }
  _tool(label, tool) {
    const b = el('button', {
      class: 'mini' + (this.tool === tool ? ' on' : ''), text: label,
      onclick: () => {
        this.tool = tool;
        if (tool !== 'draw') this.draw = null;
        this.win.querySelectorAll('.ve-tools .mini').forEach((n) => n.classList.remove('on'));
        b.classList.add('on');
        this._draw();
      },
    });
    return b;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('keydown', this._onSpace);
    window.removeEventListener('keyup', this._onSpace);
    if (this.win && this.win.parentNode) this.win.parentNode.removeChild(this.win);
    if (_inst === this) _inst = null;
  }

  /* ============================================================
     面板
     ============================================================ */
  _refreshPanels() {
    clear(this.layersEl);
    for (const l of this.doc.layers) {
      const cur = l.id === this.activeLayer;
      const row = el('div', { class: 've-lrow' + (cur ? ' on' : '') });
      row.appendChild(el('button', {
        class: 've-eye' + (l.visible === false ? ' off' : ''), text: l.visible === false ? '◌' : '●',
        title: '显示 / 隐藏', onclick: (e) => { e.stopPropagation(); l.visible = l.visible === false; this._refreshPanels(); this._draw(); },
      }));
      row.appendChild(el('input', {
        type: 'color', class: 've-sw', value: this._css(l.color),
        onchange: (e) => { l.color = e.target.value; this._draw(); },
      }));
      row.appendChild(el('span', { class: 've-lname', text: l.name + '（' + l.paths.length + '）' }));
      row.appendChild(el('button', {
        class: 've-eye' + (l.locked ? ' on' : ''), text: l.locked ? '🔒' : '🔓',
        title: '锁定 / 解锁（锁定时不可点选）', onclick: (e) => { e.stopPropagation(); l.locked = !l.locked; this._refreshPanels(); this._draw(); },
      }));
      row.addEventListener('click', () => {
        this.activeLayer = l.id;
        if (l.paths.length) { this.activePath = l.paths[l.paths.length - 1].id; this.selNodes.clear(); }
        this._refreshPanels(); this._draw();
      });
      this.layersEl.appendChild(row);
    }

    clear(this.styleEl);
    const list = this._selList();
    const first = list[0] ? list[0].path : null;
    const fill = first ? this._css(first.fill) : '#7fe3ff';
    const stroke = first ? this._css(first.stroke) : '#ffffff';
    this.styleEl.appendChild(el('div', { class: 've-row' },
      el('span', { class: 've-lab', text: '填充' }),
      el('input', { type: 'color', class: 've-sw', value: fill, oninput: (e) => this._style('fill', e.target.value) }),
      el('span', { class: 've-lab', text: '描边' }),
      el('input', { type: 'color', class: 've-sw', value: stroke, oninput: (e) => this._style('stroke', e.target.value) }),
      el('button', { class: 'mini', text: '无描边', onclick: () => this._style('stroke', 'none') }),
      el('button', { class: 'mini', text: '无填充', onclick: () => this._style('fill', 'none') })));
    this.styleEl.appendChild(el('div', { class: 've-row' },
      el('span', { class: 've-lab', text: '描边宽' }),
      this._num(first ? (first.strokeWidth || 0.02) : 0.02, 0.005, 0, (v) => this._style('strokeWidth', v)),
      el('span', { class: 've-lab', text: '不透明度' }),
      this._num(first ? (first.opacity === undefined ? 1 : first.opacity) : 1, 0.05, 0, (v) => this._style('opacity', v), 1)));

    this._status();
  }

  _css(v) {
    const s = String(v || '');
    return /^#[0-9a-f]{6}$/i.test(s) ? s : '#7fe3ff';
  }

  _status() {
    const n = docPaths(this.doc).length;
    const nodes = docPaths(this.doc).reduce((a, x) => a + (x.path.nodes || []).length, 0);
    this.statusEl.textContent = `路径 ${n} · 节点 ${nodes} · 选中 ${this.selPaths.size}`
      + (this.activePath ? ` · 当前 ${this.selNodes.size} 个选中节点` : '')
      + ` · 缩放 ${Math.round(this.view.k)}px/单位`;
  }

  /* ---------- 样式 / 图层 / 路径操作 ---------- */
  _style(prop, value) {
    const list = this._selList();
    if (!list.length) { toast('先选中路径再改样式', 'warn', 1600); return; }
    for (const { path } of list) path[prop] = prop === 'strokeWidth' ? Math.max(0, Number(value) || 0) : value;
    this._draw();
    if (prop !== 'fill' && prop !== 'stroke') this._refreshPanels();
  }

  _addLayer() {
    const l = newLayer('图层 ' + (this.doc.layers.length + 1));
    this.doc.layers.push(l);
    this.activeLayer = l.id;
    this._refreshPanels();
  }
  _delLayer() {
    if (this.doc.layers.length <= 1) { toast('至少要保留一个图层', 'err'); return; }
    const l = this._activeLayer();
    if (!l) return;
    for (const p of l.paths) this.selPaths.delete(p.id);
    this.doc.layers = this.doc.layers.filter((x) => x !== l);
    this.activeLayer = this.doc.layers[0].id;
    if (!this._find(this.activePath)) this.activePath = null;
    this._refreshPanels(); this._draw();
  }

  _dup() {
    const list = this._selList();
    if (!list.length) { toast('先选中路径', 'warn', 1600); return; }
    const news = [];
    for (const { layer, path } of list) {
      const c = clonePath(path);
      c.id = 'p' + Math.random().toString(36).slice(2, 9);
      for (const n of c.nodes) { n.x += 0.03; n.y -= 0.03; if (hasIn(n)) { n.ix += 0.03; n.iy -= 0.03; } if (hasOut(n)) { n.ox += 0.03; n.oy -= 0.03; } }
      layer.paths.push(c);
      news.push(c.id);
    }
    this.selPaths = new Set(news);
    this.activePath = news[news.length - 1];
    this.selNodes.clear();
    this._refreshPanels(); this._draw();
  }

  _delPaths() {
    const list = this._selList();
    if (!list.length) { toast('先选中路径', 'warn', 1600); return; }
    for (const { layer, path } of list) layer.paths = layer.paths.filter((p) => p !== path);
    this.selPaths.clear();
    this.activePath = null;
    this.selNodes.clear();
    this._refreshPanels(); this._draw();
  }

  _reverse() {
    const list = this._selList();
    if (!list.length) return;
    for (const { path } of list) {
      // 反转节点顺序时必须交换入 / 出手柄（手柄是按「段」的语义挂的）
      for (const n of path.nodes) {
        const ix = n.ix, iy = n.iy, ox = n.ox, oy = n.oy;
        if (ox === undefined && ix === undefined) continue;
        if (ix !== undefined) { n.ox = ix; n.oy = iy; } else { delete n.ox; delete n.oy; }
        if (ox !== undefined) { n.ix = ox; n.iy = oy; } else { delete n.ix; delete n.iy; }
      }
      path.nodes.reverse();
    }
    this.selNodes.clear();
    this._refreshPanels(); this._draw();
  }

  _fitAll() {
    if (this.constraint === 'free') { this._fitView(); this._draw(); return; }
    const paths = docPaths(this.doc).map((x) => x.path);
    if (!this._fitPathsIntoBox(paths)) { toast('没有可适配的路径', 'warn', 1600); return; }
    this._draw();
  }

  _doFillet() {
    const list = this._selList();
    if (!list.length) { toast('先选中路径', 'warn', 1600); return; }
    if (this.bevel.r <= 0) { toast('倒角半径要大于 0', 'err', 1600); return; }
    let maxN = 0;
    for (const { path } of list) {
      if ((path.nodes || []).length < 3) continue;
      const np = filletPath(path, {
        radius: this.bevel.r,
        profile: this.bevel.profile,
        modulation: this.bevel.amp ? { mode: 'wave', amp: this.bevel.amp, freq: this.bevel.freq } : null,
      });
      path.nodes = np.nodes;
      maxN = Math.max(maxN, path.nodes.length);
    }
    if (maxN > MAX_NODES) toast('节点偏多（' + maxN + '），挤出 / 扫掠会更重', 'warn', 2600);
    this.activePath = this.activePath || (list[0] && list[0].path.id) || null;
    this._refreshPanels(); this._draw();
  }

  /* ============================================================
     布尔运算（栅格辅助轮廓化）
     ============================================================ */
  _boolean(op) {
    const list = this._selList();
    if (list.length < 2) { toast('布尔运算需要先选中 2 条以上路径（Shift 多选）', 'err', 2600); return; }
    const rings = list.map(({ path }) => flattenPath(path, 0.002).pts).filter((p) => p.length >= 3);
    if (rings.length < 2) { toast('选中路径的有效轮廓不足', 'err'); return; }
    // 减：用列表最后一条（最上层）当被减对象
    let acc = [rings[rings.length - 1]];
    for (let i = rings.length - 2; i >= 0; i--) {
      const r = booleanContours(acc, [rings[i]], op);
      acc = r.map((c) => c.pts);
      if (!acc.length) break;
    }
    if (!acc.length) { toast('布尔结果为空', 'warn', 2000); return; }
    const host = list[list.length - 1].layer;
    const style = list[list.length - 1].path;
    for (const { layer, path } of list) layer.paths = layer.paths.filter((p) => p !== path);
    const news = [];
    for (const ring of acc) {
      if (ring.length < 3) continue;
      const p = newPath(ring.map((q) => ({ x: round(q[0], 4), y: round(q[1], 4) })), {
        closed: true, fill: style.fill, stroke: style.stroke,
        strokeWidth: style.strokeWidth, opacity: style.opacity,
      });
      host.paths.push(p);
      news.push(p.id);
    }
    if (!news.length) { toast('布尔结果为空', 'warn', 2000); return; }
    this.selPaths = new Set(news);
    this.activePath = news[0];
    this.selNodes.clear();
    this._refreshPanels(); this._draw();
    toast('布尔运算完成：' + acc.length + ' 条轮廓', 'ok', 2200);
  }

  /* ============================================================
     导入 / 导出 / 素材 / 挤出体
     ============================================================ */
  _pickSvg() {
    const inp = el('input', { type: 'file', accept: '.svg,image/svg+xml', style: { display: 'none' } });
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (!f) return;
      f.text().then((t) => this._importSvgText(t, f.name)).catch(() => toast('读取 SVG 失败', 'err'));
    });
    document.body.appendChild(inp);
    inp.click();
  }

  _importSvgText(text, name) {
    let res = null;
    try { res = parseSVG(text); } catch (e) { res = null; }
    if (!res || !res.paths.length) { toast('SVG 中没有可用的路径', 'err', 2600); return; }
    const layer = newLayer(String(name || '导入').replace(/\.svg$/i, '').slice(0, 18) || '导入');
    layer.paths = res.paths;
    this.doc.layers.push(layer);
    this.activeLayer = layer.id;
    const fitted = this._fitPathsIntoBox(layer.paths);
    this.selPaths = new Set(layer.paths.map((p) => p.id));
    this.activePath = layer.paths[0].id;
    this.selNodes.clear();
    this._refreshPanels(); this._draw();
    toast('已导入 ' + res.paths.length + ' 条路径' + (fitted ? '（已适配到约束框）' : ''), 'ok', 2600);
  }

  _exportSvg() {
    let svg = '';
    try { svg = docToSVG(this.doc, { padding: 0.02 }); } catch (e) { toast('导出失败：' + e.message, 'err'); return; }
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'vector-' + Date.now().toString(36) + '.svg' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
    toast('已导出 SVG', 'ok');
  }

  async _saveAsset() {
    let svg = '';
    try { svg = docToSVG(this.doc, { padding: 0.02 }); } catch (e) { toast('生成 SVG 失败：' + e.message, 'err'); return; }
    const name = 'vector-' + Date.now().toString(36) + '.svg';
    try {
      const file = new File([svg], name, { type: 'image/svg+xml' });
      const rec = await store.saveAsset(file, 'texture', { name });
      invalidateAssetOptions('texture');
      refreshAssetManager();
      toast('已存为素材：' + (rec && rec.name ? rec.name : name), 'ok', 2600);
    } catch (e) {
      toast('存为素材失败：' + (e && e.message ? e.message : e), 'err', 3200);
    }
  }

  _spawnVec() {
    const ed = this.ed;
    if (!ed || !ed.spawn) return;
    const contours = docContours(this.doc).filter((c) => c.pts.length >= 3);
    if (!contours.length) { toast('当前矢量图没有可用轮廓（至少 3 个点）', 'err', 2600); return; }
    let pos = [0, 4, 0];
    try {
      const p = ed.viewport && ed.viewport.aheadPoint(24);
      if (p) pos = [round(p.x, 2), round(p.y, 2), round(p.z, 2)];
    } catch (e) { /* ignore */ }
    const o = ed.spawn('vec', { name: '矢量挤出体', position: pos, vecShape: cloneDoc(this.doc) });
    if (!o) return;
    toast('已生成「矢量挤出体」：轮廓 ' + contours.length + ' 条（可在属性面板调厚度 / 倒角）', 'ok', 3600);
  }

  /* ============================================================
     应用（pipe / portal / vec）
     ============================================================ */
  _apply() {
    if (this.constraint === 'pipe') return this._applyPipe();
    if (this.constraint === 'portal') return this._applyPortal();
    if (this.target === 'vec') return this._applyVec();
    this.close();
    return true;
  }

  _applyPipe() {
    const o = this.obj;
    if (!o) return false;
    const contours = docContours(this.doc).filter((c) => c.pts.length >= 3);
    if (!contours.length) { toast('截面至少需要一条 3 点以上的轮廓', 'err', 2400); return false; }
    const prev = this._prev || (this.ed.snap ? this.ed.snap() : null);
    o.section = 'custom';
    o.sectionRot = 0;                                     // 旋转已烘进点位
    o.sectionDoc = cloneDoc(this.doc);
    o.sectionPtsList = contours.map((c) => c.pts.map((p) => [round(p[0], 4), round(p[1], 4)]));
    o.sectionPts = o.sectionPtsList[0];
    this._rebuild();
    if (this.ed.record) this.ed.record('编辑管道截面（矢量）', prev);
    if (this.ed.nodeEd) this.ed.nodeEd.sync();
    if (this.ed.refreshProps) this.ed.refreshProps();
    if (this.ed.showHint) this.ed.showHint('管道截面已应用：' + contours.length + ' 条轮廓', 3200);
    toast('管道截面已应用（' + contours.length + ' 条轮廓）', 'ok', 2400);
    return true;
  }

  _applyVec() {
    const o = this.obj;
    if (!o) return false;
    const contours = docContours(this.doc).filter((c) => c.pts.length >= 3);
    if (!contours.length) { toast('图形至少需要一条 3 点以上的轮廓', 'err', 2400); return false; }
    const prev = this._prev || (this.ed.snap ? this.ed.snap() : null);
    o.vecShape = cloneDoc(this.doc);
    this._rebuild();
    if (this.ed.record) this.ed.record('编辑矢量挤出体图形', prev);
    if (this.ed.refreshProps) this.ed.refreshProps();
    if (this.ed.showHint) this.ed.showHint('矢量图形已应用：' + contours.length + ' 条轮廓', 3200);
    toast('矢量图形已应用（' + contours.length + ' 条轮廓）', 'ok', 2400);
    return true;
  }

  _applyPortal() {
    const o = this.obj;
    if (!o) return false;
    const src = docPaths(this.doc).filter((e) => e.path.closed !== false && (e.path.nodes || []).length >= 3);
    if (!src.length) { toast('轮廓至少需要 3 个点', 'err', 2400); return false; }
    let shape = null;
    if (src.length === 1) {
      // 只有一条轮廓：节点与贝塞尔手柄原样交给传送门（走栅格往返会被拍成折线）
      shape = portalDocToShape(this.doc);
    } else {
      // 多条轮廓 → 先并成一条（取面积最大的外轮廓当遮罩）
      let rings = src.map((e) => flattenPath(e.path, 0.002).pts).filter((p) => p.length >= 3);
      let acc = [rings[0]];
      for (let i = 1; i < rings.length; i++) acc = booleanContours(acc, [rings[i]], 'union').map((c) => c.pts);
      if (acc.length) rings = acc;
      let best = rings[0], ba = -1;
      for (const r of rings) { const a = Math.abs(polyArea(r)); if (a > ba) { ba = a; best = r; } }
      shape = portalDocToShape(contoursToDoc([best]));
    }
    if (!shape || shape.points.length < 3) { toast('轮廓至少需要 3 个点', 'err', 2400); return false; }
    const prev = this._prev || (this.ed.snap ? this.ed.snap() : null);
    o.points = shape.points;
    o.handles = shape.handles;
    o.segModes = shape.segModes;
    o.shapePreset = 'free';
    o.shapeDoc = cloneDoc(this.doc);
    this._rebuild();
    if (this.ed.record) this.ed.record('编辑传送门矢量轮廓', prev);
    if (this.ed.nodeEd) this.ed.nodeEd.sync();
    if (this.ed.refreshProps) this.ed.refreshProps();
    if (this.ed.showHint) this.ed.showHint('传送门轮廓已应用（' + shape.points.length + ' 个节点）', 3200);
    toast('传送门轮廓已应用', 'ok', 2400);
    return true;
  }

  /* ============================================================
     绘制
     ============================================================ */
  _path2D(path) {
    const p = new Path2D();
    const ns = (path && path.nodes) || [];
    if (!ns.length) return p;
    const s0 = this.toScr(ns[0].x, ns[0].y);
    p.moveTo(s0[0], s0[1]);
    const segs = path.closed ? ns.length : ns.length - 1;
    for (let i = 0; i < segs; i++) {
      const s = segmentPoints(path, i);
      if (!s) continue;
      const b = this.toScr(s.p3[0], s.p3[1]);
      if (s.straight) { p.lineTo(b[0], b[1]); continue; }
      const c1 = this.toScr(s.c1[0], s.c1[1]);
      const c2 = this.toScr(s.c2[0], s.c2[1]);
      p.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], b[0], b[1]);
    }
    if (path.closed) p.closePath();
    return p;
  }

  _draw() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    /* 网格 */
    const k = this.view.k;
    const stepWorld = (() => {
      const want = 40 / k;                       // 目标屏幕 40px 一格
      const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, want))));
      const m = want / pow;
      return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
    })();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    const wTL = this.toWorld(0, 0), wBR = this.toWorld(W, H);
    for (let x = Math.ceil(wTL[0] / stepWorld) * stepWorld; x <= wBR[0]; x += stepWorld) {
      const sx = this.toScr(x, 0)[0];
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    }
    for (let y = Math.ceil(wBR[1] / stepWorld) * stepWorld; y <= wTL[1]; y += stepWorld) {
      const sy = this.toScr(0, y)[1];
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
    }
    /* 坐标轴 */
    ctx.strokeStyle = 'rgba(255,255,255,.2)';
    const o0 = this.toScr(0, 0);
    ctx.beginPath(); ctx.moveTo(0, o0[1]); ctx.lineTo(W, o0[1]); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(o0[0], 0); ctx.lineTo(o0[0], H); ctx.stroke();

    /* 约束参考 */
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(127,227,255,.35)';
    if (this.constraint === 'pipe') {
      ctx.beginPath(); ctx.arc(o0[0], o0[1], k, 0, Math.PI * 2); ctx.stroke();
    } else if (this.constraint === 'portal') {
      const a = this.toScr(-0.5, 0.5), b = this.toScr(0.5, -0.5);
      ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    }
    ctx.setLineDash([]);

    /* 路径 */
    const list = docPaths(this.doc);
    for (const { layer, path } of list) {
      const p2 = this._path2D(path);
      if (path.fill && path.fill !== 'none' && path.closed) {
        ctx.globalAlpha = path.opacity === undefined ? 1 : Math.max(0, Math.min(1, path.opacity));
        ctx.fillStyle = path.fill;
        ctx.fill(p2, 'evenodd');
      }
      ctx.globalAlpha = 1;
      const sel = this.selPaths.has(path.id);
      const isActive = this.activePath === path.id;
      ctx.strokeStyle = sel ? '#ffe066' : (isActive ? '#9ff' : (path.stroke && path.stroke !== 'none' ? path.stroke : layer.color));
      ctx.lineWidth = (path.stroke && path.stroke !== 'none' && path.strokeWidth > 0 ? Math.max(1, path.strokeWidth * k) : 0)
        || (sel ? 2.2 : 1.6);
      ctx.stroke(p2);
    }

    /* 绘制中的折线 */
    if (this.draw && this.draw.length) {
      ctx.strokeStyle = '#8affc1';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      this.draw.forEach((q, i) => {
        const s = this.toScr(q.x, q.y);
        if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
      });
      ctx.stroke();
      for (const q of this.draw) {
        const s = this.toScr(q.x, q.y);
        ctx.beginPath(); ctx.arc(s[0], s[1], 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#8affc1'; ctx.fill();
      }
    }

    /* 当前路径的节点与手柄 */
    const ae = this._activeEntry();
    if (ae && ae.layer.visible !== false && ae.path.visible !== false) {
      const ns = ae.path.nodes || [];
      ctx.lineWidth = 1;
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i];
        const s = this.toScr(n.x, n.y);
        const on = this.selNodes.has(i);
        for (const side of ['in', 'out']) {
          const has = side === 'in' ? hasIn(n) : hasOut(n);
          if (!has || !on) continue;
          const hx = side === 'in' ? n.ix : n.ox, hy = side === 'in' ? n.iy : n.oy;
          const hs = this.toScr(hx, hy);
          ctx.strokeStyle = 'rgba(255,255,255,.45)';
          ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(hs[0], hs[1]); ctx.stroke();
          ctx.beginPath(); ctx.arc(hs[0], hs[1], 3.5, 0, Math.PI * 2);
          ctx.fillStyle = side === 'in' ? '#7fb2ff' : '#ff9fb2'; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(s[0], s[1], on ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = on ? '#ffe066' : '#cfd8ff'; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
      }
    }

    /* 框选 */
    if (this.box) {
      ctx.strokeStyle = 'rgba(127,227,255,.8)';
      ctx.fillStyle = 'rgba(127,227,255,.12)';
      const x = Math.min(this.box.x0, this.box.x1), y = Math.min(this.box.y0, this.box.y1);
      const w = Math.abs(this.box.x1 - this.box.x0), h = Math.abs(this.box.y1 - this.box.y0);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }

    this._status();
  }

  _evPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (W / Math.max(1, r.width)),
      (e.clientY - r.top) * (H / Math.max(1, r.height))];
  }

  /* ---------- 命中测试 ---------- */
  _hitNode(sx, sy) {
    const ae = this._activeEntry();
    if (!ae || ae.layer.locked) return -1;
    const ns = ae.path.nodes || [];
    let best = -1, bd = HIT * HIT;
    for (let i = 0; i < ns.length; i++) {
      const s = this.toScr(ns[i].x, ns[i].y);
      const d = (s[0] - sx) * (s[0] - sx) + (s[1] - sy) * (s[1] - sy);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  _hitHandle(sx, sy) {
    const ae = this._activeEntry();
    if (!ae || ae.layer.locked) return null;
    const ns = ae.path.nodes || [];
    let best = null, bd = HIT * HIT;
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      for (const side of ['in', 'out']) {
        const has = side === 'in' ? hasIn(n) : hasOut(n);
        if (!has) continue;
        const s = this.toScr(side === 'in' ? n.ix : n.ox, side === 'in' ? n.iy : n.oy);
        const d = (s[0] - sx) * (s[0] - sx) + (s[1] - sy) * (s[1] - sy);
        if (d < bd) { bd = d; best = { index: i, side }; }
      }
    }
    return best;
  }

  _hitPath(sx, sy) {
    const w = this.toWorld(sx, sy);
    const tol = EDGE / Math.max(1e-6, this.view.k);
    const list = docPaths(this.doc);
    for (let i = list.length - 1; i >= 0; i--) {
      const { layer, path } = list[i];
      if (layer.locked || path.visible === false) continue;
      const f = flattenPath(path, tol * 0.4);
      if (f.pts.length < 2) continue;
      if (this._nearPoly(f.pts, f.closed, w[0], w[1], tol)) return path.id;
      if (path.closed && path.fill && path.fill !== 'none' && pointInPoly(f.pts, w[0], w[1])) return path.id;
    }
    return null;
  }

  _nearPoly(pts, closed, x, y, tol) {
    const n = pts.length;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = l2 > 1e-12 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a[0] + dx * t, qy = a[1] + dy * t;
      if ((x - qx) * (x - qx) + (y - qy) * (y - qy) <= tol * tol) return true;
    }
    return false;
  }

  /** 段上最近点 → { i, t }（i 为段起点下标，t 为该段参数） */
  _nearestOnPath(path, x, y) {
    const ns = (path && path.nodes) || [];
    const n = ns.length;
    const segs = path.closed ? n : n - 1;
    let best = null, bd = Infinity;
    for (let i = 0; i < segs; i++) {
      const s = segmentPoints(path, i);
      if (!s) continue;
      for (let k = 0; k <= 24; k++) {
        const t = k / 24;
        const q = s.straight
          ? [s.p0[0] + (s.p3[0] - s.p0[0]) * t, s.p0[1] + (s.p3[1] - s.p0[1]) * t]
          : this._cubicAt(s, t);
        const d = (q[0] - x) * (q[0] - x) + (q[1] - y) * (q[1] - y);
        if (d < bd) { bd = d; best = { i, t }; }
      }
    }
    return best;
  }

  _cubicAt(s, t) {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [
      a * s.p0[0] + b * s.c1[0] + c * s.c2[0] + d * s.p3[0],
      a * s.p0[1] + b * s.c1[1] + c * s.c2[1] + d * s.p3[1],
    ];
  }

  /** 在段 i 的参数 t 处插入节点（三次贝塞尔按 de Casteljau 精确切分） */
  _insertOnSegment(path, i, t) {
    const ns = path.nodes || [];
    if (ns.length >= MAX_NODES) { toast('节点已达上限', 'warn', 1800); return false; }
    const s = segmentPoints(path, i);
    if (!s) return false;
    if (s.straight) {
      const q = { x: s.p0[0] + (s.p3[0] - s.p0[0]) * t, y: s.p0[1] + (s.p3[1] - s.p0[1]) * t };
      ns.splice(i + 1, 0, q);
      return true;
    }
    const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const m01 = lerp(s.p0, s.c1), m12 = lerp(s.c1, s.c2), m23 = lerp(s.c2, s.p3);
    const m012 = lerp(m01, m12), m123 = lerp(m12, m23);
    const mid = lerp(m012, m123);
    const a = ns[i], b = ns[s.j];
    a.ox = m01[0]; a.oy = m01[1];
    b.ix = m23[0]; b.iy = m23[1];
    ns.splice(i + 1, 0, { x: mid[0], y: mid[1], ix: m012[0], iy: m012[1], ox: m123[0], oy: m123[1] });
    return true;
  }

  /* ============================================================
     画布交互
     ============================================================ */
  _bindCanvas() {
    const cv = this.canvas;
    let pan = null;

    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = this._evPos(e);
      const before = this.toWorld(sx, sy);
      const f = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      this.view.k = Math.max(8, Math.min(20000, this.view.k * f));
      const after = this.toWorld(sx, sy);
      this.view.ox += (after[0] - before[0]) * this.view.k;
      this.view.oy -= (after[1] - before[1]) * this.view.k;
      this._draw();
    }, { passive: false });

    cv.addEventListener('pointerdown', (e) => {
      const [sx, sy] = this._evPos(e);
      // 中键 / 空格：平移
      if (e.button === 1 || (e.button === 0 && this._space)) {
        pan = { cx: e.clientX, cy: e.clientY, ox: this.view.ox, oy: this.view.oy };
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
        return;
      }
      if (e.button === 2) {                        // 右键：删掉命中的节点
        const i = this._hitNode(sx, sy);
        if (i >= 0) this._deleteNode(i);
        return;
      }
      if (e.button !== 0) return;

      if (this.tool === 'draw') { this._drawClick(sx, sy, e); return; }

      /* 手柄 */
      const h = this._hitHandle(sx, sy);
      if (h) {
        const ae = this._activeEntry();
        this.drag = { kind: 'handle', index: h.index, side: h.side, path: ae.path, free: !!e.altKey };
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        this._draw();
        e.preventDefault();
        return;
      }
      /* 节点 */
      const ni = this._hitNode(sx, sy);
      if (ni >= 0) {
        if (e.altKey) { this._deleteNode(ni); return; }
        if (e.shiftKey || e.ctrlKey || e.metaKey) { if (this.selNodes.has(ni)) this.selNodes.delete(ni); else this.selNodes.add(ni); }
        else if (!this.selNodes.has(ni)) { this.selNodes = new Set([ni]); }
        const ae = this._activeEntry();
        this.drag = { kind: 'node', path: ae.path, last: this.toWorld(sx, sy) };
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        this._draw();
        e.preventDefault();
        return;
      }
      /* 路径（Ctrl+点 = 插点） */
      const pid = this._hitPath(sx, sy);
      if (pid) {
        const ent = this._find(pid);
        if (e.ctrlKey || e.metaKey) {
          const w = this.toWorld(sx, sy);
          const near = this._nearestOnPath(ent.path, w[0], w[1]);
          if (near && this._insertOnSegment(ent.path, near.i, near.t)) {
            this.activePath = pid;
            this.selPaths.add(pid);
            this.selNodes = new Set([near.i + 1]);
            this._refreshPanels(); this._draw();
          }
          return;
        }
        if (e.shiftKey) { if (this.selPaths.has(pid)) this.selPaths.delete(pid); else this.selPaths.add(pid); }
        else if (!this.selPaths.has(pid)) this.selPaths = new Set([pid]);
        this.activePath = pid;
        this.selNodes.clear();
        const w = this.toWorld(sx, sy);
        this.drag = { kind: 'path', last: w };
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        this._refreshPanels(); this._draw();
        e.preventDefault();
        return;
      }
      /* 空白：框选 */
      if (!e.shiftKey) this.selPaths.clear();
      this.box = { x0: sx, y0: sy, x1: sx, y1: sy };
      this.drag = { kind: 'box' };
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      this._draw();
    });

    cv.addEventListener('pointermove', (e) => {
      if (pan) {
        this.view.ox = pan.ox + (e.clientX - pan.cx);
        this.view.oy = pan.oy + (e.clientY - pan.cy);
        this._draw();
        return;
      }
      if (!this.drag) return;
      const [sx, sy] = this._evPos(e);
      const d = this.drag;
      if (d.kind === 'box') {
        if (this.box) { this.box.x1 = sx; this.box.y1 = sy; }
        this._draw();
        return;
      }
      let w = this.toWorld(sx, sy);
      if (this.snapOn && !e.altKey) w = this._snapPt(w);
      if (d.kind === 'node') {
        const dx = w[0] - d.last[0], dy = w[1] - d.last[1];
        const ns = d.path.nodes || [];
        const idx = this.selNodes.size ? [...this.selNodes] : [];
        for (const i of idx) {
          const n = ns[i];
          if (!n) continue;
          n.x += dx; n.y += dy;
          if (hasIn(n)) { n.ix += dx; n.iy += dy; }
          if (hasOut(n)) { n.ox += dx; n.oy += dy; }
        }
        d.last = w;
      } else if (d.kind === 'path') {
        const dx = w[0] - d.last[0], dy = w[1] - d.last[1];
        for (const { path } of this._selList()) {
          for (const n of path.nodes) {
            n.x += dx; n.y += dy;
            if (hasIn(n)) { n.ix += dx; n.iy += dy; }
            if (hasOut(n)) { n.ox += dx; n.oy += dy; }
          }
        }
        d.last = w;
      } else if (d.kind === 'handle') {
        const n = (d.path.nodes || [])[d.index];
        if (n) {
          if (d.side === 'in') { n.ix = w[0]; n.iy = w[1]; } else { n.ox = w[0]; n.oy = w[1]; }
          if (!d.free && !e.altKey) {
            // 默认两侧反向联动，曲线保持平滑
            if (d.side === 'in') { n.ox = 2 * n.x - n.ix; n.oy = 2 * n.y - n.iy; }
            else { n.ix = 2 * n.x - n.ox; n.iy = 2 * n.y - n.oy; }
          }
        }
      }
      this._draw();
    });

    const up = () => {
      pan = null;
      const d = this.drag;
      this.drag = null;
      if (d && d.kind === 'box' && this.box) {
        const x0 = Math.min(this.box.x0, this.box.x1), x1 = Math.max(this.box.x0, this.box.x1);
        const y0 = Math.min(this.box.y0, this.box.y1), y1 = Math.max(this.box.y0, this.box.y1);
        let last = null;
        for (const { layer, path } of docPaths(this.doc)) {
          if (layer.locked) continue;
          for (const n of (path.nodes || [])) {
            const s = this.toScr(n.x, n.y);
            if (s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1) {
              this.selPaths.add(path.id);
              last = path.id;
              break;
            }
          }
        }
        if (last) this.activePath = last;
        this.box = null;
        this._refreshPanels();
      }
      this._draw();
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);

    // 空格键：临时平移
    this._onSpace = (e) => { if (e.code === 'Space') this._space = e.type === 'keydown'; };
    window.addEventListener('keydown', this._onSpace);
    window.addEventListener('keyup', this._onSpace);
  }

  _deleteNode(i) {
    const ae = this._activeEntry();
    if (!ae) return;
    const ns = ae.path.nodes || [];
    const min = ae.path.closed ? 3 : 2;
    if (ns.length <= min) { toast('至少需要保留 ' + min + ' 个节点', 'warn', 1800); return; }
    ns.splice(i, 1);
    this.selNodes.clear();
    this._refreshPanels(); this._draw();
  }

  _drawClick(sx, sy, e) {
    const w = this._snapPt(this.toWorld(sx, sy));
    if (!this.draw) this.draw = [];
    // 点回起点附近 → 闭合
    if (this.draw.length >= 2) {
      const s0 = this.toScr(this.draw[0].x, this.draw[0].y);
      if (Math.hypot(s0[0] - sx, s0[1] - sy) <= HIT + 3) { this._finishDraw(true); return; }
    }
    this.draw.push({ x: round(w[0], 4), y: round(w[1], 4) });
    this._draw();
  }

  _finishDraw(closed) {
    const pts = this.draw;
    this.draw = null;
    if (!pts || pts.length < (closed ? 3 : 2)) { toast('绘制至少需要 ' + (closed ? 3 : 2) + ' 个点', 'warn', 1800); this._draw(); return; }
    const layer = this._activeLayer();
    if (!layer) { this._draw(); return; }
    const p = newPath(pts.map((q) => ({ x: q.x, y: q.y })), { closed: !!closed, fill: layer.color });
    layer.paths.push(p);
    this.selPaths = new Set([p.id]);
    this.activePath = p.id;
    this.selNodes.clear();
    this.tool = 'select';
    this.win.querySelectorAll('.ve-tools .mini').forEach((n) => n.classList.remove('on'));
    const btn = this.win.querySelectorAll('.ve-tools .mini')[0];
    if (btn) btn.classList.add('on');
    this._refreshPanels(); this._draw();
  }
}