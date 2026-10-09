/* ============================================================
   曲线截面编辑器（弹窗 · 2D 折线画布）
   - 给管道（pipe）的横截面做可视化编辑：直接拖点改轮廓
   - 左键拖点 · 空白处点线插入新点 · 右键删点 · 滚轮缩放
   - 画布工作在「单位半径」空间（与 sectionProfile 一致），实际大小由「截面半径」决定
   - 应用时把轮廓写回 o.sectionPts 并切到 section='custom'，
     同时把 sectionRot 归零（旋转已经烘进点位，避免二次旋转）
   ============================================================ */
import { el, modal, toast } from '../ui/dom.js';
import { sectionProfile } from '../world/paths.js';
import { round } from '../core/util.js';

const W = 420;              // 画布 CSS 尺寸（正方形）
const HIT_R = 11;           // 点拾取半径（像素）
const SEG_R = 10;           // 边拾取半径（像素）
const MAX_PTS = 96;         // 点数上限：再多久会拖慢管道扫掠
const SNAP = 0.05;          // 网格吸附步长（单位半径空间）

/** Chaikin 一次细分：折线变圆顺，点数翻倍 */
function chaikin(pts) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  return out;
}

/** 关于竖直轴左右对称：补镜像点后按极角重排（保持逆时针） */
function mirrorX(pts) {
  const all = [];
  for (const p of pts) { all.push([p[0], p[1]]); all.push([-p[0], p[1]]); }
  all.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
  const out = [];
  for (const p of all) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-4 && Math.abs(last[1] - p[1]) < 1e-4) continue;
    out.push(p);
  }
  if (out.length > 2) {
    const f = out[0], l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-4 && Math.abs(f[1] - l[1]) < 1e-4) out.pop();
  }
  return out;
}

/**
 * 打开截面编辑器
 * @param {object} ed 编辑器实例
 * @param {object} o  管道对象数据
 */
export function openSectionEditor(ed, o) {
  if (!o || !ed) return null;
  const start = sectionProfile(o).map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);
  if (start.length < 3) { toast('当前截面不足 3 个点，无法编辑', 'err'); return null; }

  let pts = start;
  let view = 1.6;           // 视野半径（单位空间）
  let drag = -1;            // 正在拖的点下标
  let sel = -1;             // 选中点下标
  let snapOn = true;
  let dpr = 1;

  const canvas = el('canvas', { style: { display: 'block', width: W + 'px', height: W + 'px' } });
  const stat = el('span', { class: 'se-stat' });
  const scaleLab = el('span', { class: 'se-stat' });

  /* ---------- 坐标换算 ---------- */
  const k = () => (W / 2) / view;
  const toScr = (p) => [W / 2 + p[0] * k(), W / 2 - p[1] * k()];
  const toSpace = (x, y) => [(x - W / 2) / k(), (W / 2 - y) / k()];
  const evPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (W / Math.max(1, r.width)),
      (e.clientY - r.top) * (W / Math.max(1, r.height))];
  };

  function hitVert(x, y) {
    let best = -1, bd = HIT_R * HIT_R;
    for (let i = 0; i < pts.length; i++) {
      const s = toScr(pts[i]);
      const d = (s[0] - x) * (s[0] - x) + (s[1] - y) * (s[1] - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** 最近的一条边 → { i, x, y }（i 为线段起点下标，x/y 是投影点，像素坐标） */
  function hitSeg(x, y) {
    let best = null, bd = SEG_R * SEG_R;
    for (let i = 0; i < pts.length; i++) {
      const a = toScr(pts[i]);
      const b = toScr(pts[(i + 1) % pts.length]);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = dx * dx + dy * dy;
      let t = L > 1e-9 ? ((x - a[0]) * dx + (y - a[1]) * dy) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a[0] + dx * t, qy = a[1] + dy * t;
      const d = (x - qx) * (x - qx) + (y - qy) * (y - qy);
      if (d < bd) { bd = d; best = { i, qx, qy }; }
    }
    return best;
  }

  /* ---------- 绘制 ---------- */
  function draw() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, W);

    // 网格（每 0.25）
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    const step = Math.max(0.05, Math.round((view / 4) * 20) / 20);
    for (let v = -4; v <= 4; v += step) {
      const sx = W / 2 + v * k();
      const sy = W / 2 - v * k();
      if (sx >= 0 && sx <= W) { ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, W); ctx.stroke(); }
      if (sy >= 0 && sy <= W) { ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke(); }
    }
    // 坐标轴
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.beginPath(); ctx.moveTo(0, W / 2); ctx.lineTo(W, W / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, W); ctx.stroke();
    // 单位圆参考
    ctx.strokeStyle = 'rgba(127,227,255,.28)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.arc(W / 2, W / 2, k(), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    // 轮廓
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const s = toScr(pts[i]);
      if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(127,227,255,.14)';
    ctx.fill();
    ctx.strokeStyle = '#7fe3ff';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // 点
    for (let i = 0; i < pts.length; i++) {
      const s = toScr(pts[i]);
      ctx.beginPath();
      ctx.arc(s[0], s[1], i === sel ? 5.5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === sel ? '#ffe066' : (i === 0 ? '#8affc1' : '#cfd8ff');
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    stat.textContent = pts.length + ' 个点';
    scaleLab.textContent = '视野 ±' + view.toFixed(2);
  }

  /* ---------- 交互 ---------- */
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = evPos(e);
    const i = hitVert(x, y);
    if (e.button === 2) {                       // 右键删点
      if (i >= 0 && pts.length > 3) {
        pts.splice(i, 1);
        sel = -1;
        draw();
      }
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (i >= 0) {
      sel = i;
      drag = i;
      // 固定鼠标：拖到画布外也能继续（与编辑器里的拖拽手感一致）
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      draw();
      e.preventDefault();
      return;
    }
    // 空白处：命中某条边就往那段里插一个点
    const hit = hitSeg(x, y);
    if (hit && pts.length < MAX_PTS) {
      const p = toSpace(hit.qx, hit.qy);
      pts.splice(hit.i + 1, 0, [round(p[0], 4), round(p[1], 4)]);
      sel = hit.i + 1;
      drag = sel;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      draw();
      e.preventDefault();
      return;
    }
    sel = -1;
    draw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const [x, y] = evPos(e);
    let p = toSpace(x, y);
    if (snapOn && !e.altKey) p = [Math.round(p[0] / SNAP) * SNAP, Math.round(p[1] / SNAP) * SNAP];
    pts[drag] = [round(p[0], 4), round(p[1], 4)];
    draw();
  });

  const endDrag = () => { drag = -1; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    view = Math.min(4, Math.max(0.5, view * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
    draw();
  }, { passive: false });

  /* ---------- 工具条 ---------- */
  const mkBtn = (label, title, fn) => el('button', {
    class: 'mini', text: label, title, onclick: fn,
  });

  const tools = el('div', { class: 'ph-row' },
    mkBtn('圆化', 'Chaikin 细分：折线变圆顺（点数翻倍）', () => {
      if (pts.length * 2 > MAX_PTS) { toast('点数已达上限，无法继续圆化', 'err'); return; }
      pts = chaikin(pts);
      sel = -1;
      draw();
    }),
    mkBtn('左右对称', '按竖直轴镜像补齐（保持逆时针）', () => {
      const out = mirrorX(pts);
      if (out.length < 3) { toast('对称后点数不足', 'err'); return; }
      pts = out;
      sel = -1;
      draw();
      if (pts.length > MAX_PTS) toast('点数较多（' + pts.length + '），管道扫掠会更重', 'warn', 3000);
    }),
    mkBtn('删点', '删除选中的点（也可以直接右键点）', () => {
      if (sel < 0) { toast('先在画布上点选一个点', 'err'); return; }
      if (pts.length <= 3) { toast('至少要保留 3 个点', 'err'); return; }
      pts.splice(sel, 1);
      sel = -1;
      draw();
    }),
    mkBtn('重置', '还原为打开时的轮廓', () => {
      pts = start.map((p) => p.slice());
      sel = -1;
      draw();
    }),
  );

  const snapRow = el('div', { class: 'ph-row' },
    el('label', { class: 'se-chk' },
      el('input', {
        type: 'checkbox', checked: true,
        onchange: (e) => { snapOn = !!e.target.checked; },
      }), el('span', { text: '吸附 0.05（按住 Alt 临时关闭）' })),
    el('span', { class: 'ph-lab', text: '滚轮缩放' }),
  );

  const body = el('div', { class: 'se-wrap' },
    canvas,
    el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '点数' }), stat,
      el('span', { class: 'ph-lab', text: '缩放' }), scaleLab),
    tools,
    snapRow,
    el('div', { class: 'se-tip', text: '左键拖点 · 空白处点线插入点 · 右键删点 · 滚轮缩放。应用后截面类型会切到「自定义」。' }),
  );

  // 画布按 DPR 铺满，避免 Retina 上发虚
  dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(W * dpr);
  draw();

  modal({
    title: '截面编辑器 · ' + (o.name || '管道'),
    body,
    buttons: [
      { label: '取消', value: null },
      { label: '应用', value: 'apply', cls: 'primary' },
    ],
  }).then((v) => {
    if (v !== 'apply') return;
    if (pts.length < 3) { toast('截面至少需要 3 个点', 'err'); return; }
    applySection(ed, o, pts);
  });
  return null;
}

/** 写回轮廓并重建管道 */
function applySection(ed, o, pts) {
  const prev = ed.snap();
  o.section = 'custom';
  o.sectionPts = pts.map((p) => [round(p[0], 4), round(p[1], 4)]);
  o.sectionRot = 0;            // 旋转已烘进点位，避免再转一次
  const b = ed.builder;
  const rec = b && b.objects.get(o.id);
  if (b && rec) {
    try {
      const fresh = b.rebuild(rec);
      if (fresh) { b.computeBounds(); b.updateSunShadow(); }
    } catch (e) { /* ignore */ }
  }
  ed.record('编辑管道截面', prev);
  if (ed.gizmo) ed.gizmo.attach(ed.selectedRecs());
  if (ed.nodeEd) ed.nodeEd.sync();
  ed.refreshProps();
  ed.showHint('管道截面已应用（截面类型：自定义，共 ' + pts.length + ' 个点）', 3600);
}
