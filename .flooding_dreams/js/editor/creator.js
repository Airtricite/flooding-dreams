/* ============================================================
   顶部对象创建器：常用类型快捷按钮 + 全部类型选择面板
   创建位置 = 射线命中的表面（没有则地面，再没有则视点前方）
   ============================================================ */
import * as THREE from 'three';
import { el, clear } from '../ui/dom.js';
import { CATEGORIES, OBJECT_TYPES, TYPE_KEYS, typeDef } from '../world/objectTypes.js';
import { EDITOR, LIQUID_KINDS } from '../config.js';
import { popover, closePopover } from './widgets.js';
import { round } from '../core/util.js';

const QUICK = [
  { t: 'mesh', shape: 'block', ico: '▦', l: '方块' },
  { t: 'mesh', shape: 'sphere', ico: '●', l: '球' },
  { t: 'poly', ico: '✧', l: '低模建模体' },
  { t: 'vec', ico: '⬟', l: '矢量挤出体' },
  { t: 'curve', ico: '∿', l: '折曲线' },
  { t: 'pipe', ico: '⬭', l: '管道' },
  { t: 'meshref', ico: '⁝', l: '网格修改器' },
  { t: 'liquid', ico: '≈', l: '液体' },
  { t: 'spawn', ico: '⚑', l: '起点' },
  { t: 'goal', ico: '★', l: '终点' },
  { t: 'checkpoint', ico: '⛳', l: '检查点' },
  { t: 'button', ico: '⬤', l: '按钮' },
  { t: 'door', ico: '🚪', l: '门' },
  { t: 'walljump', ico: '⇧', l: 'WallJump' },
  { t: 'trigger', ico: '⚡', l: '触发器' },
  { t: 'damage', ico: '☠', l: '伤害区' },
  { t: 'tool', ico: '🔧', l: '工具' },
  { t: 'textblock', ico: '🅣', l: '文字方块' },
  { t: 'billboard', ico: '🖼', l: '公告板' },
  { t: 'light', ico: '💡', l: '灯光' },
  { t: 'group', ico: '⧉', l: '编组' },
];

export class Creator {
  constructor(ed) {
    this.ed = ed;
    this.host = document.getElementById('ed-create');
    this.pointer = null;
    this._build();
    this._bind();
  }

  _bind() {
    const view = document.getElementById('ed-view');
    if (!view) return;
    view.addEventListener('pointermove', (e) => { this.pointer = { x: e.clientX, y: e.clientY }; });
    view.addEventListener('pointerleave', () => { this.pointer = null; });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') closePopover();
    });
  }

  _build() {
    const host = this.host;
    if (!host) return;
    clear(host);
    for (const q of QUICK) host.appendChild(this.tool(q));
    // 全部对象类型入口：放在顶栏原有的模式按钮位（模式按钮已并入视图左下角工具条）
    const more = document.getElementById('ed-more');
    if (!more) return;
    clear(more);
    more.appendChild(el('button', {
      class: 'mbtn sm', title: '全部对象类型',
      onclick: (e) => this.picker(e.currentTarget),
    }, el('span', { text: '＋' }), el('span', { text: '更多对象种类' })));
  }

  tool(q) {
    const def = OBJECT_TYPES[q.t] || OBJECT_TYPES.mesh;
    const label = q.l || def.label;
    return el('button', {
      class: 'ctool', title: '添加「' + label + '」',
      onclick: () => this.place(q.t, q.shape ? { shape: q.shape } : {}),
    }, el('b', { text: q.ico || def.icon }), el('em', { text: label, style: { fontStyle: 'normal' } }));
  }

  /* ---------- 全部类型面板 ---------- */
  picker(anchor) {
    const body = el('div', {});
    for (const cat of CATEGORIES) {
      const items = TYPE_KEYS.filter((k) => OBJECT_TYPES[k].cat === cat.key);
      if (!items.length) continue;
      body.appendChild(el('div', { class: 'pk-cat', text: cat.label }));
      const grid = el('div', { class: 'pgrid' });
      for (const k of items) {
        const def = OBJECT_TYPES[k];
        grid.appendChild(el('button', {
          class: 'pitem', title: '添加' + def.label,
          onclick: () => { closePopover(); this.place(k, {}); },
        }, el('b', { text: def.icon }), def.label));
      }
      body.appendChild(grid);
    }
    body.appendChild(el('div', { class: 'pk-cat', text: '液体种类' }));
    const lg = el('div', { class: 'pgrid' });
    for (const [k, v] of Object.entries(LIQUID_KINDS)) {
      lg.appendChild(el('button', {
        class: 'pitem', title: '添加' + v.label,
        onclick: () => { closePopover(); this.place('liquid', { kind: k }); },
      }, el('b', { text: '≈' }), v.label));
    }
    body.appendChild(lg);
    popover({ title: '对象创建器', body, anchor, width: 340 });
  }

  /* ---------- 放置 ---------- */
  place(type, over = {}) {
    const ed = this.ed;
    if (!ed || !ed.level) return;
    const pos = this.placePos(type);
    if (!pos) return;
    let opts = { ...over, position: pos };
    // 接头：直接把「放置时点到的对象」当宿主，世界落点换算成宿主局部坐标存进 position
    const host = type === 'attachment' ? this._hostHit : null;
    const anchor = host && ed.builder ? ed.builder.groupNodes.get(host.id) : null;
    if (anchor) {
      anchor.updateWorldMatrix(true, false);
      const v = new THREE.Vector3(pos[0], pos[1], pos[2]);
      anchor.worldToLocal(v);
      opts = { ...opts, parent: host.id, position: [v.x, v.y, v.z] };
    }
    const o = ed.spawn(type, opts);
    // 即建即用：放完低模建模体直接进建模模式，省掉「再选中一次 + 按 M」
    if (o && type === 'poly' && ed.modelEd) ed.modelEd.setActive(true);
  }

  placePos(type) {
    const vp = this.ed.viewport;
    if (!vp) return [0, 20, 0];
    const p = this.pointer || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    let point = null;
    this._hostHit = null;
    try {
      const hit = vp.pick(p.x, p.y, { helpers: true });
      // 可当接头宿主的对象：自带网格的实体（液体也算 —— 接头贴液面是主要用法）
      if (hit && hit.rec && hit.rec.mesh && hit.rec.mesh.isMesh) this._hostHit = hit.rec;
      if (hit && hit.rec && (hit.rec.type !== 'liquid' || type === 'attachment')) point = hit.point.clone();
    } catch (e) { /* ignore */ }
    if (!point) point = vp.ground(p.x, p.y, 0);
    if (!point) point = vp.aheadPoint(90);
    if (!point) return [0, 20, 0];

    // 让对象「坐」在命中面上
    const def = typeDef(type);
    const sd = (def.props.find((x) => x.k === 'scale') || {}).d;
    const h = type === 'liquid' ? 12 : (Array.isArray(sd) ? Math.abs(sd[1]) : 1);
    point.y += h / 2;

    const snap = this.ed.snapOn ? EDITOR.snapMove : 0;
    const sn = (v) => (snap ? Math.round(v / snap) * snap : round(v, 2));
    return [sn(point.x), sn(point.y), sn(point.z)];
  }
}