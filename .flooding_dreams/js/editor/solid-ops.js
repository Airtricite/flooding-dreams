/* ============================================================
   编辑器 · 实体运算（SDF 体素内核）
   - 布尔运算：并集 / 差集 / 交集；平滑融合单独作为一项（等价于「带融合半径的并集」）
   - 曲线围成岛屿：把闭合折线沿 Y 拉成棱柱，用平滑并集融进地形
   - 结果统一「烘焙进网格」：对象旋转归零、缩放归一、顶点写进 verts，碰撞体转为网格
     （因为非等比缩放下包围盒碰撞体会失真，精确网格才是正确解）
   - 全程复用编辑器的 JSON 快照撤销：进来先 snap()，落地后 record()
   ============================================================ */
import * as THREE from 'three';
import { el, modal, toast } from '../ui/dom.js';
import { GridSelect } from '../ui/grid-picker.js';
import { round, clamp } from '../core/util.js';
import { createObject } from '../world/objectTypes.js';
import { removeObjectTree } from '../world/level.js';
import { resolvePath } from '../world/paths.js';
import { polyVerts, polyFaces, MAX_POLY_FACES } from '../world/poly-mesh.js';
import {
  makeField, fieldRasterizeMesh, fieldToMesh, bufferGeometryToMesh, meshWorldBox,
  fieldUnionInto, fieldSmoothUnionInto, fieldSubtract, fieldIntersect, fieldIslandPrism,
} from '../world/sdf-kernel.js';

const RES_OPTS = [
  { v: '18', l: '低（快）' }, { v: '26', l: '中' }, { v: '36', l: '高（细）' },
];
const OP_OPTS = [
  { v: 'union', l: '并集　A ∪ B' },
  { v: 'smooth', l: '平滑融合　A ⊕ B' },
  { v: 'subtract', l: '差集　A − B' },
  { v: 'intersect', l: '交集　A ∩ B' },
];

/* ============================================================
   公共小工具
   ============================================================ */

/** 取一个对象参与体素计算的 { verts, faces, matrix }；不可用返回 null */
function meshSource(rec) {
  if (!rec || !rec.mesh || rec.mesh.isMesh !== true) return null;
  const geo = rec.mesh.geometry;
  if (!geo) return null;
  let verts, faces;
  if (rec.type === 'poly') {
    verts = polyVerts(rec.o);
    faces = polyFaces(rec.o);
  } else {
    const m = bufferGeometryToMesh(geo);
    verts = m.verts; faces = m.faces;
  }
  if (!verts || verts.length < 4 || !faces || faces.length < 4) return null;
  rec.mesh.updateWorldMatrix(true, false);
  return { verts, faces, matrix: rec.mesh.matrixWorld.clone() };
}

/** 按「选择顺序」取可参与运算的对象 —— 第一个就是主体 A */
function collectSources(ed) {
  const out = [];
  for (const id of (ed.selection || [])) {
    const rec = ed.builder && ed.builder.objects ? ed.builder.objects.get(id) : null;
    const src = meshSource(rec);
    if (src) out.push({ rec, src });
  }
  return out;
}

function boxUnion(boxes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      if (b.min[i] < min[i]) min[i] = b.min[i];
      if (b.max[i] > max[i]) max[i] = b.max[i];
    }
  }
  if (!Number.isFinite(min[0])) { min[0] = min[1] = min[2] = 0; max[0] = max[1] = max[2] = 1; }
  return { min, max };
}
function boxSize(b) {
  return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}

/** 对象所在的父空间矩阵的逆（编组里的对象要以父空间写回 position） */
function parentInverse(rec) {
  const p = rec.parentNode;
  if (!p) return new THREE.Matrix4();
  p.updateWorldMatrix(true, false);
  return new THREE.Matrix4().copy(p.matrixWorld).invert();
}

/**
 * 把世界空间的一份网格烘焙进对象：重心作为新原点，旋转归零、缩放归一。
 * 顶点表用绝对尺度，所以包围盒碰撞体不再成立 → 顺手把碰撞体切成「网格」。
 */
function applyBakedMesh(rec, mesh) {
  const o = rec.o;
  // 用结果的包围盒中心当新原点
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.verts) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i];
      if (v[i] > max[i]) max[i] = v[i];
    }
  }
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const local = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(parentInverse(rec));
  o.verts = mesh.verts.map((v) => [
    round(v[0] - c[0], 4), round(v[1] - c[1], 4), round(v[2] - c[2], 4),
  ]);
  o.faces = mesh.faces.map((f) => [f[0], f[1], f[2]]);
  o.position = [round(local.x, 4), round(local.y, 4), round(local.z, 4)];
  o.rotation = [0, 0, 0];
  o.scale = [1, 1, 1];
  o.physicsMode = 'mesh';   // 绝对尺度顶点 → 只能用精确网格碰撞
  return c;
}

/** 收尾：重建全部对象 / 撤销步 / 选中主体 */
function finish(ed, hostId, label, prev, msg) {
  ed.builder.refreshAll();
  if (ed.paint && ed.paint.rebuildAll) ed.paint.rebuildAll();
  ed.record(label, prev, { tree: true });
  ed.select(hostId ? [hostId] : []);
  toast(msg, '', 3600);
  ed.log(label + '：' + msg, 'ok');
}

/* ============================================================
   布尔运算 / 平滑融合
   ============================================================ */
export async function openBooleanDialog(ed) {
  if (!ed || !ed.level) return;
  const pairs = collectSources(ed);
  if (pairs.length < 2) {
    toast('布尔运算需要至少 2 个网格类对象：第一个选中 = 主体 A，其余按选择顺序参与', 'err', 4600);
    return;
  }
  const boxes = pairs.map((p) => meshWorldBox(p.src.verts, p.src.matrix));
  const ext = boxSize(boxUnion(boxes));
  const defBlend = Math.max(0.05, Math.round(ext * 0.06 * 1000) / 1000);

  const opSel = new GridSelect({ value: 'union', cls: 'inp', options: OP_OPTS, onChange: () => sync() });
  const blendInp = el('input', { class: 'inp', type: 'number', min: 0, max: 100, step: 0.01, value: defBlend });
  const resSel = new GridSelect({ value: '26', cls: 'inp', options: RES_OPTS });
  const tip = el('div', { class: 'se-tip' });
  const sync = () => {
    const smooth = opSel.value === 'smooth';
    blendInp.disabled = !smooth;
    blendInp.style.opacity = smooth ? '1' : '.5';
    tip.textContent = '主体 A = ' + (pairs[0].rec.o.name || '第 1 个选中对象')
      + '；参与运算 ' + pairs.length + ' 个，包围盒 ' + ext.toFixed(1) + ' 单位。'
      + (smooth ? '融合半径越大，接缝越圆润（会略微“发胖”）。' : '差集 / 交集按选择顺序依次进行。')
      + '结果是新的低模建模体数据，碰撞体自动切成「网格」。';
  };
  sync();

  const body = el('div', { class: 'se-wrap' },
    el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '运算' }), opSel),
    el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '融合半径' }), blendInp),
    el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '精度' }), resSel),
    tip);

  const v = await modal({
    title: '实体运算（体素内核）',
    body,
    buttons: [{ label: '取消', value: null, cls: 'ghost' }, { label: '执行', value: 'go', cls: 'primary' }],
  });
  if (v !== 'go') return;

  const opt = {
    op: opSel.value,
    res: Number(resSel.value) || 26,
    blend: Math.max(0, Number(blendInp.value) || 0),
  };
  toast('正在计算体素布尔…（对象越大越慢）', '', 1200);
  await new Promise((r) => setTimeout(r, 24));
  runBoolean(ed, pairs, opt);
}

function runBoolean(ed, pairs, opt) {
  const prev = ed.snap();
  const boxes = pairs.map((p) => meshWorldBox(p.src.verts, p.src.matrix));
  const box = boxUnion(boxes);
  const res = opt.res;

  let acc, tmp;
  try {
    acc = makeField(box.min, box.max, res, 0.06);
    tmp = makeField(box.min, box.max, res, 0.06);
    fieldRasterizeMesh(acc, pairs[0].src.verts, pairs[0].src.faces, pairs[0].src.matrix);
    for (let i = 1; i < pairs.length; i++) {
      fieldRasterizeMesh(tmp, pairs[i].src.verts, pairs[i].src.faces, pairs[i].src.matrix);
      switch (opt.op) {
        case 'subtract': fieldSubtract(acc, tmp); break;
        case 'intersect': fieldIntersect(acc, tmp); break;
        case 'smooth': fieldSmoothUnionInto(acc, tmp, opt.blend); break;
        default: fieldUnionInto(acc, tmp); break;
      }
    }
  } catch (err) {
    console.error('[editor] 布尔运算失败', err);
    toast('布尔运算失败：' + err.message, 'err', 4000);
    return;
  }

  const mesh = fieldToMesh(acc);
  if (!mesh.faces.length) {
    toast('运算结果为空：两个对象可能没有重叠区域，或网格不是闭合体（开口面无法判定内外）', 'err', 5200);
    return;
  }
  if (mesh.faces.length > MAX_POLY_FACES) {
    toast(`结果面数 ${mesh.faces.length} 超过建模上限 ${MAX_POLY_FACES}：把「精度」降到低一档再试`, 'err', 5200);
    return;
  }

  const host = pairs[0].rec;
  try {
    applyBakedMesh(host, mesh);
    for (let i = 1; i < pairs.length; i++) removeObjectTree(ed.level, pairs[i].rec.o.id);
  } catch (err) {
    console.error('[editor] 布尔运算写回失败', err);
    toast('写回失败：' + err.message, 'err', 4000);
    return;
  }
  const label = opt.op === 'subtract' ? '布尔差集' : opt.op === 'intersect' ? '布尔交集'
    : opt.op === 'smooth' ? '布尔平滑融合' : '布尔并集';
  finish(ed, host.o.id, label, prev,
    `${label}完成：${mesh.verts.length} 点 · ${mesh.faces.length} 面（已合并 ${pairs.length} 个对象）`);
}

/* ============================================================
   曲线围成岛屿 · 2D 俯视曲线编辑
   - 轮廓直接在弹窗里的 2D 画布上画 / 拖（世界 XZ 平面俯视），
     不用再去场景里摆一条 3D 折曲线
   - 若选中了折曲线（或管道 / 滑索），会把它投影到 XZ 当初始轮廓，
     交叉 / 多余的点可以直接在画布上修掉
   - 画布只管轮廓（XZ），海岸线的高度由「岛顶 / 岛底」两个参数给
   ============================================================ */

const ISL_W = 460;               // 画布 CSS 宽
const ISL_H = 340;               // 画布 CSS 高
const ISL_HIT = 11;              // 顶点拾取半径（像素）
const ISL_SEG = 10;              // 边拾取半径（像素）
const ISL_MAX = 96;              // 轮廓点数上限
const ISL_CAP = 320;             // 细分后的点数上限（SDF 每个采样格都要遍历所有边）
const ISL_SNAP = 0.5;            // 网格吸附步长（世界单位）

/** Chaikin 一次细分：折线的每个角切成两个点，迭代几次就得到平滑海岸线 */
function chaikin2D(pts, iters) {
  let cur = pts;
  const n = Math.max(0, Math.min(4, iters | 0));
  for (let it = 0; it < n; it++) {
    if (cur.length >= ISL_CAP) break;    // 点数封顶：再细分下去围岛会明显变慢
    const out = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i], b = cur[(i + 1) % cur.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    cur = out;
  }
  return cur;
}

/** 折曲线 / 管道 / 滑索的节点 → 世界坐标点列 */
function curveWorldPoints(ed, rec) {
  const p = resolvePath(rec.o, ed.level);
  if (!p || !p.points || p.points.length < 3) return null;
  rec.mesh.updateWorldMatrix(true, false);
  const mw = rec.mesh.matrixWorld;
  const v = new THREE.Vector3();
  return p.points.map((q) => {
    v.set(Number(q.x) || 0, Number(q.y) || 0, Number(q.z) || 0).applyMatrix4(mw);
    return [v.x, v.y, v.z];
  });
}

/** 去掉重合点：3D 曲线投影到 XZ 后经常出现重复点，会让轮廓退化 */
function dedupe2D(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-4 && Math.abs(last[1] - p[1]) < 1e-4) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-4 && Math.abs(f[1] - l[1]) < 1e-4) out.pop();
    else break;
  }
  return out;
}

/* ---------- 自交检测（只用来提示，不拦生成） ---------- */
function side2D(ax, az, bx, bz, cx, cz) { return (bx - ax) * (cz - az) - (bz - az) * (cx - ax); }
function segCross2D(a, b, c, d) {
  const d1 = side2D(c[0], c[1], d[0], d[1], a[0], a[1]);
  const d2 = side2D(c[0], c[1], d[0], d[1], b[0], b[1]);
  const d3 = side2D(a[0], a[1], b[0], b[1], c[0], c[1]);
  const d4 = side2D(a[0], a[1], b[0], b[1], d[0], d[1]);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
/** 返回自交的边下标集合（边 i = 点 i → 点 i+1） */
function crossEdges2D(pts) {
  const bad = new Set();
  const n = pts.length;
  if (n < 4) return bad;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;   // 相邻边共用顶点
      if (segCross2D(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) { bad.add(i); bad.add(j); }
    }
  }
  return bad;
}

/** 网格步长：让屏幕上一小格大约 46px */
function gridStep(scale) {
  const raw = 46 / Math.max(1e-6, scale);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m > 5 ? 10 : m > 2 ? 5 : m > 1 ? 2 : 1) * p;
}

export async function openIslandDialog(ed) {
  if (!ed || !ed.level) return;
  const recs = (ed.selectedRecs ? ed.selectedRecs() : []);
  // 地形宿主：优先用选中里的「低模建模体」，没有就新建一个
  const terrainRec = recs.find((r) => r.type === 'poly' && meshSource(r));

  // 参考范围：有宿主就用宿主的包围盒，否则用视口中心
  let box = null;
  if (terrainRec) {
    terrainRec.mesh.updateWorldMatrix(true, false);
    box = meshWorldBox(polyVerts(terrainRec.o), terrainRec.mesh.matrixWorld);
  }
  const ahead = (ed.viewport && ed.viewport.aheadPoint) ? ed.viewport.aheadPoint(60) : null;
  const c0 = box
    ? [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]
    : [ahead ? ahead.x : 0, ahead ? ahead.y : 0, ahead ? ahead.z : 0];
  const spanX = box ? box.max[0] - box.min[0] : 0;
  const spanZ = box ? box.max[2] - box.min[2] : 0;
  const dia = box ? Math.max(spanX, spanZ, 1) : 24;

  // 初始轮廓：优先把选中的折曲线投影到 XZ，否则给一个圆
  const curveRec = recs.find((r) => r.type === 'curve' || r.type === 'pipe' || r.type === 'zip');
  let seedFrom = '';
  let seed = null;
  if (curveRec) {
    const wp = curveWorldPoints(ed, curveRec);
    if (wp) {
      const p2 = dedupe2D(wp.map((p) => [round(p[0], 4), round(p[2], 4)]));
      if (p2.length >= 3) { seed = p2; seedFrom = curveRec.o.name || '折曲线'; }
    }
  }
  if (!seed) {
    const r = box ? Math.max(2, Math.min(spanX, spanZ) * 0.32) : 12;
    seed = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      seed.push([round(c0[0] + Math.cos(a) * r, 3), round(c0[2] + Math.sin(a) * r, 3)]);
    }
  }
  const start = seed.map((p) => p.slice());
  let pts = seed.map((p) => p.slice());

  /* ---------- 参数控件 ---------- */
  const modeSel = new GridSelect({
    value: 'add', cls: 'inp',
    options: [
      { v: 'add', l: '造岛（往上加陆地）' },
      { v: 'cut', l: '挖湖（沿轮廓往下挖）' },
    ],
  });
  const topInp = el('input', {
    class: 'inp', type: 'number', step: 0.1,
    value: round((box ? box.max[1] : c0[1]) + Math.max(1, dia * 0.1), 3),
  });
  const botInp = el('input', {
    class: 'inp', type: 'number', step: 0.1,
    value: round(box ? box.min[1] : c0[1] - Math.max(2, dia * 0.1), 3),
  });
  const blendInp = el('input', {
    class: 'inp', type: 'number', min: 0, max: 100, step: 0.01,
    value: Math.max(0.2, Math.round(dia * 0.05 * 1000) / 1000),
  });
  const smoothInp = el('input', { class: 'inp', type: 'number', min: 0, max: 4, step: 1, value: 2 });
  const resSel = new GridSelect({ value: '26', cls: 'inp', options: RES_OPTS });

  /* ---------- 画布 ---------- */
  const canvas = el('canvas', { style: { display: 'block', width: ISL_W + 'px', height: ISL_H + 'px' } });
  const stat = el('span', { class: 'se-stat' });
  const warn = el('span', { class: 'se-stat', style: { color: '#ff9db1' } });

  let view = { cx: c0[0], cz: c0[2], scale: 1 };
  let sel = -1, hover = -1, drag = -1, pan = null, snapOn = true, dpr = 1;

  const toScr = (p) => [ISL_W / 2 + (p[0] - view.cx) * view.scale, ISL_H / 2 + (p[1] - view.cz) * view.scale];
  const toWorld = (sx, sy) => [view.cx + (sx - ISL_W / 2) / view.scale, view.cz + (sy - ISL_H / 2) / view.scale];
  const evPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (ISL_W / Math.max(1, r.width)),
      (e.clientY - r.top) * (ISL_H / Math.max(1, r.height))];
  };
  const snapPt = (p) => [Math.round(p[0] / ISL_SNAP) * ISL_SNAP, Math.round(p[1] / ISL_SNAP) * ISL_SNAP];

  /** 把轮廓和地形范围都装进画布 */
  function fit() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
    }
    if (box) {
      minX = Math.min(minX, box.min[0]); maxX = Math.max(maxX, box.max[0]);
      minZ = Math.min(minZ, box.min[2]); maxZ = Math.max(maxZ, box.max[2]);
    }
    if (!Number.isFinite(minX)) {
      minX = c0[0] - dia / 2; maxX = c0[0] + dia / 2;
      minZ = c0[2] - dia / 2; maxZ = c0[2] + dia / 2;
    }
    const w = Math.max(maxX - minX, 1), h = Math.max(maxZ - minZ, 1);
    view.cx = (minX + maxX) / 2;
    view.cz = (minZ + maxZ) / 2;
    view.scale = clamp(Math.min(ISL_W / (w * 1.2), ISL_H / (h * 1.2)), 0.02, 40);
  }

  function hitVert(x, y) {
    let best = -1, bd = ISL_HIT * ISL_HIT;
    for (let i = 0; i < pts.length; i++) {
      const s = toScr(pts[i]);
      const d = (s[0] - x) * (s[0] - x) + (s[1] - y) * (s[1] - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function hitSeg(x, y) {
    if (pts.length < 2) return null;
    let best = null, bd = ISL_SEG * ISL_SEG;
    for (let i = 0; i < pts.length; i++) {
      const a = toScr(pts[i]), b = toScr(pts[(i + 1) % pts.length]);
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
    ctx.clearRect(0, 0, ISL_W, ISL_H);

    // 网格
    const gs = gridStep(view.scale);
    const x0 = view.cx - (ISL_W / 2) / view.scale, x1 = view.cx + (ISL_W / 2) / view.scale;
    const z0 = view.cz - (ISL_H / 2) / view.scale, z1 = view.cz + (ISL_H / 2) / view.scale;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    for (let x = Math.ceil(x0 / gs) * gs; x <= x1; x += gs) {
      const sx = ISL_W / 2 + (x - view.cx) * view.scale;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, ISL_H); ctx.stroke();
    }
    for (let z = Math.ceil(z0 / gs) * gs; z <= z1; z += gs) {
      const sy = ISL_H / 2 + (z - view.cz) * view.scale;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(ISL_W, sy); ctx.stroke();
    }
    // 世界原点的两根轴
    ctx.strokeStyle = 'rgba(255,255,255,.2)';
    if (x0 <= 0 && x1 >= 0) {
      const sx = ISL_W / 2 - view.cx * view.scale;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, ISL_H); ctx.stroke();
    }
    if (z0 <= 0 && z1 >= 0) {
      const sy = ISL_H / 2 - view.cz * view.scale;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(ISL_W, sy); ctx.stroke();
    }
    // 宿主地形范围（虚线框）
    if (box) {
      const a = toScr([box.min[0], box.min[2]]), b = toScr([box.max[0], box.max[2]]);
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,.24)';
      ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.setLineDash([]);
    }

    const bad = crossEdges2D(pts);

    // 轮廓
    if (pts.length >= 2) {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const s = toScr(pts[i]);
        if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
      }
      ctx.closePath();
      if (pts.length >= 3) { ctx.fillStyle = 'rgba(127,227,255,.13)'; ctx.fill(); }
      ctx.strokeStyle = '#7fe3ff';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      if (bad.size) {                       // 自交的边标红：这些地方会被抵消
        ctx.strokeStyle = '#ff6b8a';
        ctx.lineWidth = 2.2;
        for (const i of bad) {
          const a = toScr(pts[i]), b = toScr(pts[(i + 1) % pts.length]);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        }
      }
    }

    // 细分后的海岸线预览
    const iters = Math.max(0, Math.min(4, Number(smoothInp.value) | 0));
    if (iters > 0 && pts.length >= 3) {
      const sm = chaikin2D(pts, iters);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(138,255,193,.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < sm.length; i++) {
        const s = toScr(sm[i]);
        if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 顶点
    for (let i = 0; i < pts.length; i++) {
      const s = toScr(pts[i]);
      ctx.beginPath();
      ctx.arc(s[0], s[1], (i === sel || i === hover) ? 5.2 : 3.8, 0, Math.PI * 2);
      ctx.fillStyle = i === sel ? '#ffe066' : (i === 0 ? '#8affc1' : '#cfd8ff');
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 状态行
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    area = Math.abs(area) / 2;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
    }
    const sw = Number.isFinite(minX) ? maxX - minX : 0;
    const sh = Number.isFinite(minZ) ? maxZ - minZ : 0;
    stat.textContent = pts.length + ' 个点 · 面积 ' + area.toFixed(1)
      + ' · ' + sw.toFixed(1) + ' × ' + sh.toFixed(1) + '（XZ）';
    warn.textContent = bad.size ? '轮廓自交：红边处的海岸线会被抵消，拖开或右键删点' : '';
    canvas.style.cursor = pan ? 'grabbing' : (hover >= 0 ? 'grab' : 'crosshair');
  }

  /* ---------- 交互 ---------- */
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = evPos(e);
    const i = hitVert(x, y);
    // 中键 / Alt+左键（不在点上）→ 平移；Alt 落在点上时留给拖点（临时关吸附）
    if (e.button === 1 || (e.button === 0 && e.altKey && i < 0)) {
      pan = { x, y, cx: view.cx, cz: view.cz };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
      return;
    }
    if (e.button === 2) {                                          // 右键删点
      if (i >= 0 && pts.length > 3) { pts.splice(i, 1); sel = -1; draw(); }
      else if (i >= 0) toast('至少要保留 3 个点', 'err');
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (i >= 0) {                                                  // 拖点
      sel = i; drag = i;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      draw();
      e.preventDefault();
      return;
    }
    if (pts.length >= ISL_MAX) { toast('轮廓点数已达上限 ' + ISL_MAX + ' 个', 'err'); return; }
    const seg = hitSeg(x, y);
    let p = toWorld(x, y);
    if (snapOn) p = snapPt(p);
    p = [round(p[0], 4), round(p[1], 4)];
    if (seg) {                                                     // 点在边上 → 插点
      pts.splice(seg.i + 1, 0, p);
      sel = seg.i + 1;
    } else {                                                       // 点在空白处 → 加点（沿着画）
      pts.push(p);
      sel = pts.length - 1;
    }
    drag = sel;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    draw();
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = evPos(e);
    if (pan) {
      view.cx = pan.cx - (x - pan.x) / view.scale;
      view.cz = pan.cz - (y - pan.y) / view.scale;
      draw();
      return;
    }
    if (drag < 0) {
      const i = hitVert(x, y);
      if (i !== hover) { hover = i; draw(); }
      return;
    }
    let p = toWorld(x, y);
    if (snapOn && !e.altKey) p = snapPt(p);
    pts[drag] = [round(p[0], 4), round(p[1], 4)];
    draw();
  });

  const endPointer = () => { drag = -1; pan = null; draw(); };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = evPos(e);
    const before = toWorld(x, y);
    view.scale = clamp(view.scale * (e.deltaY > 0 ? 1 / 1.12 : 1.12), 0.02, 40);
    const after = toWorld(x, y);
    view.cx += before[0] - after[0];
    view.cz += before[1] - after[1];
    draw();
  }, { passive: false });

  /* ---------- 工具条 ---------- */
  const mkBtn = (label, title, fn) => el('button', { class: 'mini', text: label, title, onclick: fn });
  const tools = el('div', { class: 'ph-row' },
    mkBtn('删点', '删除选中的点（也可以直接右键点）', () => {
      if (sel < 0) { toast('先在画布上点选一个点', 'err'); return; }
      if (pts.length <= 3) { toast('至少要保留 3 个点', 'err'); return; }
      pts.splice(sel, 1);
      sel = -1;
      draw();
    }),
    mkBtn('撤销', '删掉最后加的点', () => {
      if (!pts.length) return;
      pts.pop();
      sel = -1;
      draw();
    }),
    mkBtn('清空', '清掉整条轮廓，重新画', () => { pts = []; sel = -1; draw(); }),
    mkBtn('重置', seedFrom ? '还原成「' + seedFrom + '」投影出来的轮廓' : '还原成打开时的轮廓', () => {
      pts = start.map((p) => p.slice());
      sel = -1;
      fit();
      draw();
    }),
    mkBtn('适合视野', '把轮廓和地形范围都装进画布', () => { fit(); draw(); }),
  );

  const snapRow = el('div', { class: 'ph-row' },
    el('label', { class: 'se-chk' },
      el('input', {
        type: 'checkbox', checked: true,
        onchange: (e) => { snapOn = !!e.target.checked; },
      }),
      el('span', { text: '吸附 0.5（按住 Alt 临时关闭）' })),
    el('span', { class: 'ph-lab', text: '滚轮缩放 · 中键平移' }),
  );

  smoothInp.addEventListener('input', draw);

  const tip = '左键空白处加点 · 拖点改形状 · 点边插点 · 右键删点 · 滚轮缩放 · 中键（或 Alt+左键）平移。'
    + '轮廓只用 XZ，海岸线高度由「岛顶 / 岛底」决定。'
    + (seedFrom ? '初始轮廓来自「' + seedFrom + '」的 XZ 投影，可直接在画布上改。' : '')
    + (terrainRec ? '结果会融进选中的低模建模体。'
      : '当前没选中低模建模体，会新建一个「岛屿」建模体；挖湖需要先选中一个低模建模体当宿主。')
    + '融合半径让海岸线自然收边，别超过岛宽的 1/4。';

  const body = el('div', { class: 'se-wrap' },
    canvas,
    el('div', { class: 'ph-row' }, stat, warn),
    tools,
    el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '模式' }), modeSel,
      el('span', { class: 'ph-lab', text: '精度' }), resSel),
    el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '岛顶高度 Y' }), topInp,
      el('span', { class: 'ph-lab', text: '岛底高度 Y' }), botInp),
    el('div', { class: 'ph-row' }, el('span', { class: 'ph-lab', text: '融合半径' }), blendInp,
      el('span', { class: 'ph-lab', text: '曲线细分' }), smoothInp),
    snapRow,
    el('div', { class: 'se-tip', text: tip }),
  );

  // 画布按 DPR 铺满，避免 Retina 上发虚
  dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(ISL_W * dpr);
  canvas.height = Math.round(ISL_H * dpr);
  fit();
  draw();

  const v = await modal({
    title: '曲线围成岛屿',
    body,
    buttons: [{ label: '取消', value: null, cls: 'ghost' }, { label: '生成', value: 'go', cls: 'primary' }],
  });
  if (v !== 'go') return;
  if (pts.length < 3) {
    toast('轮廓至少需要 3 个点', 'err', 4600);
    return;
  }

  const opt = {
    cut: modeSel.value === 'cut',
    top: Number(topInp.value) || 0,
    bot: Number(botInp.value) || 0,
    blend: Math.max(0, Number(blendInp.value) || 0),
    smooth: Math.max(0, Math.min(4, Number(smoothInp.value) | 0)),
    res: Number(resSel.value) || 26,
  };
  toast('正在生成岛屿…', '', 1200);
  await new Promise((r) => setTimeout(r, 24));
  runIsland(ed, { terrainRec, poly: pts.map((p) => [p[0], p[1]]), box }, opt);
}

function runIsland(ed, ctx, opt) {
  const prev = ed.snap();
  const poly = chaikin2D(ctx.poly, opt.smooth);
  const sign = opt.cut ? -1 : 1;

  // 场范围：宿主地形包围盒（没有宿主就只按轮廓）+ 轮廓范围 + 上下高度范围
  let cMinX = Infinity, cMaxX = -Infinity, cMinZ = Infinity, cMaxZ = -Infinity;
  for (const p of poly) {
    if (p[0] < cMinX) cMinX = p[0];
    if (p[0] > cMaxX) cMaxX = p[0];
    if (p[1] < cMinZ) cMinZ = p[1];
    if (p[1] > cMaxZ) cMaxZ = p[1];
  }
  const bx = ctx.box;
  const min = [
    Math.min(cMinX, bx ? bx.min[0] : cMinX),
    Math.min(opt.top, opt.bot, bx ? bx.min[1] : Math.min(opt.top, opt.bot)),
    Math.min(cMinZ, bx ? bx.min[2] : cMinZ),
  ];
  const max = [
    Math.max(cMaxX, bx ? bx.max[0] : cMaxX),
    Math.max(opt.top, opt.bot, bx ? bx.max[1] : Math.max(opt.top, opt.bot)),
    Math.max(cMaxZ, bx ? bx.max[2] : cMaxZ),
  ];

  let field;
  try {
    field = makeField(min, max, opt.res, 0.06);
    if (ctx.terrainRec) {
      const src = meshSource(ctx.terrainRec);
      if (src) fieldRasterizeMesh(field, src.verts, src.faces, src.matrix);
    }
    fieldIslandPrism(field, poly, opt.top, opt.bot, opt.blend, sign);
  } catch (err) {
    console.error('[editor] 曲线围岛失败', err);
    toast('生成失败：' + err.message, 'err', 4000);
    return;
  }

  const mesh = fieldToMesh(field);
  if (!mesh.faces.length) {
    toast('结果为空：轮廓可能退化，或「岛顶 / 岛底」高度反了', 'err', 4800);
    return;
  }
  if (mesh.faces.length > MAX_POLY_FACES) {
    toast(`结果面数 ${mesh.faces.length} 超过建模上限 ${MAX_POLY_FACES}：把「精度」降到低一档再试`, 'err', 5200);
    return;
  }

  let hostId = null;
  try {
    if (ctx.terrainRec) {
      applyBakedMesh(ctx.terrainRec, mesh);
      hostId = ctx.terrainRec.o.id;
    } else {
      const min0 = [Infinity, Infinity, Infinity];
      const max0 = [-Infinity, -Infinity, -Infinity];
      for (const v2 of mesh.verts) {
        for (let i = 0; i < 3; i++) {
          if (v2[i] < min0[i]) min0[i] = v2[i];
          if (v2[i] > max0[i]) max0[i] = v2[i];
        }
      }
      const c = [(min0[0] + max0[0]) / 2, (min0[1] + max0[1]) / 2, (min0[2] + max0[2]) / 2];
      const o = createObject('poly', { name: opt.cut ? '湖' : '岛屿', position: c });
      o.verts = mesh.verts.map((v2) => [
        round(v2[0] - c[0], 4), round(v2[1] - c[1], 4), round(v2[2] - c[2], 4),
      ]);
      o.faces = mesh.faces.map((f) => [f[0], f[1], f[2]]);
      o.rotation = [0, 0, 0];
      o.scale = [1, 1, 1];
      o.physicsMode = 'mesh';
      ed.level.objects.push(o);
      hostId = o.id;
    }
  } catch (err) {
    console.error('[editor] 曲线围岛写回失败', err);
    toast('写回失败：' + err.message, 'err', 4000);
    return;
  }

  finish(ed, hostId, opt.cut ? '曲线挖湖' : '曲线围岛', prev,
    `${opt.cut ? '挖湖' : '造岛'}完成：轮廓 ${poly.length} 点 → 模型 ${mesh.verts.length} 点 · ${mesh.faces.length} 面`);
}

/* ============================================================
   转换为低模建模体
   - 基础网格对象（mesh）/ 矢量挤出体（vec）：把当前几何烘焙成 poly 的 verts / faces
   - 世界空间烘焙：旋转归零、缩放归一、碰撞体转「网格」，外观保持不变
   - 顶点是绝对尺度 → 与布尔 / 围岛写回同一套数据形态，之后即可进低模建模器自由编辑
   ============================================================ */
export function convertToPoly(ed, id) {
  if (!ed || !ed.level) return;
  const rec = ed.builder && ed.builder.objects ? ed.builder.objects.get(id) : null;
  if (!rec) return;
  if (rec.type === 'poly') { toast('该对象已经是低模建模体', '', 2000); return; }
  const src = meshSource(rec);
  if (!src) { toast('该对象没有可用的网格几何，无法转换', 'err', 4200); return; }
  if (src.faces.length > MAX_POLY_FACES) {
    toast(`面数 ${src.faces.length} 超过建模上限 ${MAX_POLY_FACES}：请先降低精度再转换`, 'err', 5200);
    return;
  }

  const prev = ed.snap();
  const v = new THREE.Vector3();
  const mesh = {
    verts: src.verts.map((p) => {
      v.set(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0).applyMatrix4(src.matrix);
      return [v.x, v.y, v.z];
    }),
    faces: src.faces.map((f) => [f[0], f[1], f[2]]),
  };

  try {
    applyBakedMesh(rec, mesh);
    rec.o.type = 'poly';            // 走 refreshAll 重建：几何按 poly 的 verts / faces 生成
  } catch (err) {
    console.error('[editor] 转换为低模建模体失败', err);
    toast('转换失败：' + err.message, 'err', 4000);
    return;
  }

  finish(ed, rec.o.id, '转换为低模建模体', prev,
    `已转换为低模建模体：${mesh.verts.length} 点 · ${mesh.faces.length} 面（可在低模建模器中继续编辑）`);
}
