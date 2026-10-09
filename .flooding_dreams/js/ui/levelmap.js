/* ============================================================
   关卡节点地图：把关卡包渲染成一张「节点 + 连线」的剧情地图
   播放界面（只读）与编辑器「关卡包」面板（可拖拽 / 可连线）共用
   坐标用 0~1 归一化，SVG 用 viewBox 0 0 100 100 直接对应百分比
   ============================================================ */
import { el, clear } from './dom.js';
import { isUnlocked, nodeVisible, tierDef } from '../levels/packs.js';
import { diffOf } from '../config.js';
import { t } from '../core/i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const clamp01 = (v) => (v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v);
const clampSize = (v) => (v < 0.02 ? 0.02 : v > 1 ? 1 : v);

export class LevelMap {
  /**
   * @param host 容器元素
   * @param opts.interactive 允许拖动节点
   * @param opts.cleared     已通关关卡 id 集合（Set）
   * @param opts.levelInfo   (levelId) => { name, exists }
   * @param opts.onPick      (node, state) => {}  点击节点
   * @param opts.onChange    () => {}             拖动结束后回调（用于保存）
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.pack = null;
    this.tier = 0;                           // 当前档位（0 = 不分档，显示全部节点）
    this.cleared = opts.cleared instanceof Set ? opts.cleared : new Set();
    this.drag = null;
    this.sDrag = null;                       // 贴纸拖动 / 缩放
    this.selSticker = null;
    this.stickerEdit = opts.stickerEdit !== undefined ? !!opts.stickerEdit : !!opts.interactive;
    this._nodeEls = new Map();
    this._lineEls = [];
    this._stickerEls = new Map();

    this.root = el('div', { class: 'lvm' });
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'lvm-svg');
    this.svg.setAttribute('viewBox', '0 0 100 100');
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this._linesG = document.createElementNS(SVG_NS, 'g');
    this.svg.appendChild(this._linesG);
    // 贴纸层：夹在连线与节点之间，玩家端完全穿透点击
    this.stickerLayer = el('div', { class: 'lvm-stickers' });
    this.nodeLayer = el('div', { class: 'lvm-nodes' });
    this.root.appendChild(this.svg);
    this.root.appendChild(this.stickerLayer);
    this.root.appendChild(this.nodeLayer);
    this.empty = el('div', { class: 'lvm-empty', text: '这个关卡包还没有节点' });
    this.root.appendChild(this.empty);
    host.appendChild(this.root);
    this._bindDrag();
    this._bindStickerDrag();
  }

  setPack(pack, cleared, tier) {
    this.pack = pack;
    if (cleared) this.cleared = cleared;
    if (tier !== undefined) this.tier = Number(tier) || 0;
    this.render();
  }

  /** 只换档位：重新过滤节点 / 连线，不重建实例 */
  setTier(tier) {
    this.tier = Number(tier) || 0;
    this.render();
  }

  /** 重新渲染（节点增删 / 数据整体变化时用） */
  render() {
    const p = this.pack;
    clear(this.nodeLayer);
    clear(this._linesG);
    clear(this.stickerLayer);
    this._nodeEls.clear();
    this._lineEls = [];
    this._stickerEls.clear();
    if (!p) { this.empty.style.display = ''; return; }
    // 档位过滤：只有通用节点与当前档位的备选节点出现
    const nodes = p.nodes.filter((n) => nodeVisible(n, this.tier));
    const visIds = new Set(nodes.map((n) => n.id));
    const edges = p.edges.filter((e) => visIds.has(e[0]) && visIds.has(e[1]));
    // 解锁判定用过滤后的视图：被隐藏的前驱不该卡住节点
    this._view = { ...p, nodes, edges };
    this.empty.style.display = nodes.length ? 'none' : '';

    for (const e of edges) {
      const ln = document.createElementNS(SVG_NS, 'line');
      ln.setAttribute('class', 'lvm-line');
      ln.setAttribute('vector-effect', 'non-scaling-stroke');
      this._linesG.appendChild(ln);
      this._lineEls.push({ a: e[0], b: e[1], el: ln });
    }
    for (const s of p.stickers || []) {
      const se = this._stickerEl(s);
      this._stickerEls.set(s.id, se);
      this.stickerLayer.appendChild(se);
    }
    nodes.forEach((n, i) => {
      const node = this._nodeEl(n, i);
      this._nodeEls.set(n.id, node);
      this.nodeLayer.appendChild(node);
    });
    this._syncPos();
    this.syncStickers();
  }

  _nodeEl(n, i) {
    const info = (this.opts.levelInfo && this.opts.levelInfo(n.levelId)) || {};
    const cleared = !!(n.levelId && this.cleared.has(n.levelId));
    const unlocked = !this.pack || isUnlocked(this._view || this.pack, n, this.cleared);
    const missing = !info.exists;
    const cls = ['lvm-node'];
    if (cleared) cls.push('cleared');
    else if (!unlocked) cls.push('locked');
    else cls.push('cur');
    if (missing) cls.push('missing');
    if (n.color) cls.push('has-color');
    const kids = [
      el('i', { text: cleared ? '✓' : String(i + 1) }),
      el('b', { text: n.title || info.name || '未命名关卡' }),
      el('em', { text: missing ? '关卡已删除' : (cleared ? '已通关' : (unlocked ? '可挑战' : '未解锁')) }),
    ];
    // 徽标行：档位（只在该档出现）+ 难度（编辑器里自定义，0 表示跟随关卡）
    const tags = [];
    if (n.tier > 0) {
      const td = tierDef(n.tier);
      if (td) tags.push(el('span', { class: 'nd-tier', text: t(td.zh), style: { color: td.color } }));
    }
    if (n.diff > 0) {
      const d = diffOf(n.diff);
      tags.push(el('span', { class: 'nd-diff', text: d.label, style: { color: d.color } }));
    }
    if (tags.length) kids.push(el('div', { class: 'nd-tags' }, ...tags));
    const node = el('button', {
      class: cls.join(' '),
      type: 'button',
      title: (n.title || info.name || '未命名关卡') + (missing ? '（关卡不存在）' : ''),
      dataset: { node: n.id },
    }, ...kids);
    if (n.color) node.style.setProperty('--nd-color', n.color);
    node.addEventListener('click', (e) => {
      if (this.drag && this.drag.moved) { e.preventDefault(); return; }
      this.opts.onPick && this.opts.onPick(n, { cleared, unlocked, missing });
    });
    return node;
  }

  _syncPos() {
    const p = this.pack;
    if (!p) return;
    const at = new Map(p.nodes.map((n) => [n.id, n]));
    for (const n of p.nodes) {
      const e = this._nodeEls.get(n.id);
      if (!e) continue;
      e.style.left = (n.x * 100).toFixed(3) + '%';
      e.style.top = (n.y * 100).toFixed(3) + '%';
    }
    for (const l of this._lineEls) {
      const a = at.get(l.a);
      const b = at.get(l.b);
      if (!a || !b) continue;
      l.el.setAttribute('x1', (a.x * 100).toFixed(3));
      l.el.setAttribute('y1', (a.y * 100).toFixed(3));
      l.el.setAttribute('x2', (b.x * 100).toFixed(3));
      l.el.setAttribute('y2', (b.y * 100).toFixed(3));
      const done = !!(a.levelId && this.cleared.has(a.levelId));
      l.el.setAttribute('class', 'lvm-line' + (done ? ' done' : ''));
    }
  }

  /* ---------- 拖动节点（仅编辑器） ---------- */
  _bindDrag() {
    if (!this.opts.interactive) return;
    this.root.addEventListener('pointerdown', (e) => {
      const elNode = e.target.closest && e.target.closest('.lvm-node');
      if (!elNode) return;
      const id = elNode.dataset.node;
      const n = ((this.pack && this.pack.nodes) || []).find((x) => x.id === id);
      if (!n) return;
      const r = this.root.getBoundingClientRect();
      this.drag = { n, r, moved: false, sx: e.clientX, sy: e.clientY };
      elNode.classList.add('dragging');
      elNode.setPointerCapture && elNode.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.root.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || this.sDrag) return;
      if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 3) return;
      d.moved = true;
      d.n.x = clamp01((e.clientX - d.r.left) / Math.max(1, d.r.width));
      d.n.y = clamp01((e.clientY - d.r.top) / Math.max(1, d.r.height));
      this._syncPos();
    });
    const end = () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      const e2 = this._nodeEls.get(d.n.id);
      if (e2) e2.classList.remove('dragging');
      if (d.moved) this.opts.onChange && this.opts.onChange();
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
    this.root.addEventListener('pointerleave', end);
  }

  /* ---------- 贴纸（仅编辑器可编辑，玩家端只读展示） ---------- */
  _stickerEl(s) {
    const kids = [el('img', { src: s.src, draggable: 'false', alt: '' })];
    if (this.stickerEdit) kids.push(el('span', { class: 'sh', title: '拖动缩放' }));
    return el('div', {
      class: 'lvm-sticker' + (this.stickerEdit ? ' editing' : '') + (this.selSticker === s.id ? ' sel' : ''),
      dataset: { sticker: s.id },
    }, ...kids);
  }

  syncStickers() {
    const p = this.pack;
    if (!p) return;
    for (const s of p.stickers || []) {
      const e = this._stickerEls.get(s.id);
      if (!e) continue;
      e.style.left = (s.x * 100).toFixed(3) + '%';
      e.style.top = (s.y * 100).toFixed(3) + '%';
      e.style.setProperty('--w', (s.w * 100).toFixed(3) + '%');
      e.style.setProperty('--h', (s.h * 100).toFixed(3) + '%');
      e.style.setProperty('--rot', (s.rot || 0) + 'deg');
    }
  }

  /** 选中某张贴纸并刷新高亮（编辑器用） */
  selectSticker(id) {
    this.selSticker = id || null;
    for (const [sid, e] of this._stickerEls) e.classList.toggle('sel', sid === this.selSticker);
  }

  _bindStickerDrag() {
    if (!this.stickerEdit) return;
    this.root.addEventListener('pointerdown', (e) => {
      const elS = e.target.closest && e.target.closest('.lvm-sticker');
      if (!elS) return;
      const id = elS.dataset.sticker;
      const s = ((this.pack && this.pack.stickers) || []).find((x) => x.id === id);
      if (!s) return;
      const mode = e.target.classList && e.target.classList.contains('sh') ? 'resize' : 'move';
      const r = this.root.getBoundingClientRect();
      this.sDrag = { s, mode, r, moved: false, sx: e.clientX, sy: e.clientY };
      elS.classList.add('dragging');
      elS.setPointerCapture && elS.setPointerCapture(e.pointerId);
      this.selectSticker(s.id);
      this.opts.onStickerSelect && this.opts.onStickerSelect(s);
      e.stopPropagation();
      e.preventDefault();
    });
    this.root.addEventListener('pointermove', (e) => {
      const d = this.sDrag;
      if (!d) return;
      d.moved = true;
      const nx = (e.clientX - d.r.left) / Math.max(1, d.r.width);
      const ny = (e.clientY - d.r.top) / Math.max(1, d.r.height);
      if (d.mode === 'move') {
        d.s.x = clamp01(nx);
        d.s.y = clamp01(ny);
      } else {
        // 以中心为基准：指针到中心的距离换算成宽高
        d.s.w = clampSize(Math.abs(nx - d.s.x) * 2);
        d.s.h = clampSize(Math.abs(ny - d.s.y) * 2);
      }
      this.syncStickers();
    });
    const end = () => {
      const d = this.sDrag;
      if (!d) return;
      this.sDrag = null;
      const e2 = this._stickerEls.get(d.s.id);
      if (e2) e2.classList.remove('dragging');
      if (d.moved) this.opts.onStickerChange && this.opts.onStickerChange(d.s);
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
    this.root.addEventListener('pointerleave', end);
  }

  dispose() {
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this._nodeEls.clear();
    this._lineEls = [];
    this._stickerEls.clear();
  }
}
