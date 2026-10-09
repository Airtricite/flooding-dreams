/* ============================================================
   遮挡剔除（CPU 软件遮挡剔除）
   —— 用一张低分辨率的 1/w 深度缓冲区，把「不透明遮挡体」光栅化进去，
      再逐个测试其它物体：缓冲里每个像素都比它更近 → 完全被挡住 → 隐藏，
      省掉它的顶点处理、光栅化与阴影投射。

   判定按物体的**真实三角面**做（不是包围盒）：
   · 方块（shape === 'block'，几何就是一个立方体表面）走快速路径：8 个角
     + 三个可见面，结果与逐三角形等价，但便宜得多。
   · 其它网格（球 / 圆柱 / 楔形 / 低模 poly / 导入的 .glb 模型…）一律用真实
     三角形：当遮挡体时只写「真的会画出来的面」（按材质面朝向剔背面），
     被剔除时只测「自己真的占到的像素」。凹形 / 镂空 / 薄片因此都能正确判定，
     不会像拿包围盒那样把凹陷处的像素也算成实心。

   关键约定（改动前务必理解，否则会出现「物体凭空消失」）：
   · 缓冲区存 qz = 1/w：它在屏幕空间线性可插值，越大越近；背景 = 0。
     写入用 z-max（取更近的），因此与写入顺序无关。
   · 遮挡体按「由近到远」排序，逐个「先测试、没被挡住的才写进缓冲」。
     不排序的话物体自己的深度会把所在格子压住，测试永远失败（自遮挡），
     一个也剔不掉了。
   · 被判为被挡住的遮挡体不再写缓冲：它已经比现有缓冲更远，写进去也
     抬不高任何最小值，只会白费时间。
   · 判定的深度阈值 th 取包围盒 8 个角里最大的 qz：1/w 在盒内是凸函数，
     最大值必在角上，所以它是物体真实最近点的上界。阈值偏大 = 判定偏严
     = 只会少剔，不会误剔。
   · 屏幕包围盒上的每个像素都必须被遮挡体盖住才算完全遮挡；有一个像素
     没盖住 → 判定可见。宁可多画，不能漏画。
   · 保守光栅化（否则会出现「贴着遮挡体轮廓露出的物件整块消失」）：
     缓冲区只有 128 宽，1 个低分辨率像素 = 十几个真实像素，
     若按「像素中心在三角形内」来标记，遮挡体轮廓外约半个像素的假覆盖
     就能把只露出一条小于 1 像素宽边缘的物件整个判成被挡住。
     因此写入时要求像素**整块**落在三角形内（向内收缩半个像素），
     判定时要求三角形**碰到的**像素都要检查（向外扩张半个像素）。
   · 跨近平面 / 投影异常 / 三角形过多 / 编辑器 → 一律不剔除（判可见）。
     包围盒 8 个角都在近平面之外 ⇒ 盒内所有点的 w 都够大（w 对顶点线性），
     所以逐三角形时不会出现面片跨近平面。
   · 蒙皮（SkinnedMesh）/ 形变（morph）网格的顶点位置在 GPU 上算，静止
     姿态的三角形和实际画面不符 → 不许剔除（见 parts.partial）。
   ============================================================ */
import * as THREE from '../core/three-ns.js';

/* 永远不剔除、也永远不当遮挡体的类型：
   纯逻辑体积、液体（有专属泡沫 / 水面流程）、容器、公告板（始终朝向相机）、
   灯光与体积雾、路径扫掠体（几何由节点决定）、网格修改器（几何由源对象决定） */
const NEVER_CULL = new Set([
  'trigger', 'damage', 'emitter', 'soundblock', 'postfx', 'exposure',
  'liquid', 'group', 'billboard', 'light', 'fogvol', 'volumelight',
  'zipline', 'curve', 'pipe', 'meshref',
  'npc',        // 会跑动的角色：形状随每帧姿态变，既不当遮挡体也不剔除
]);

const REL_EPS = 0.02;         // 深度比较的相对容差：给拼缝外扩 / 浮点误差留余量
const NEAR_GUARD = 1.02;      // 八个角都要在 near*1.02 之外才敢参与剔除
const BASE_W = 128;           // 缓冲区基础宽度（像素）
const BASE_H_MIN = 48;
const BASE_H_MAX = 160;
const MIN_OCC_AREA = 12;      // 遮挡体在缓冲区上至少要有这么多像素，太小就别当遮挡体
const BUDGET_MUL = 40;        // 每帧光栅化像素预算 = 缓冲区像素数 × 该系数
const MAX_TRIS_OCC = 512;     // 当遮挡体的三角形上限（超了不当遮挡体，避免拖慢整帧）
const MAX_TRIS_CULL = 2048;   // 逐三角形判定的上限（超了退回包围盒矩形判定）
const VERT_BUDGET = 20000;    // 每帧投影的顶点数上限（逐三角形判定时每面 3 个顶点）

const _inv = new THREE.Matrix4();
const _mvp = new THREE.Matrix4();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _nv = new THREE.Vector3();

/** 投影条目：一个物体包围盒的 8 个角（世界 / 屏幕 / qz），复用避免每帧分配 */
function newEntry() {
  return {
    rec: null, box: true, qz: 0, x0: 0, y0: 0, x1: 0, y1: 0,
    wx: new Float32Array(8), wy: new Float32Array(8), wz: new Float32Array(8),
    sx: new Float32Array(8), sy: new Float32Array(8), q8: new Float32Array(8),
  };
}

/** 六个面的角点序号（4 个一圈）：角点编号 n = (i<<2)|(j<<1)|k，见 _project */
const FACES = (() => {
  const out = [];
  for (let axis = 0; axis < 3; axis++) {
    for (let s = 0; s < 2; s++) {
      if (axis === 0) out.push([s << 2, (s << 2) | 1, (s << 2) | 3, (s << 2) | 2]);
      else if (axis === 1) out.push([s << 1, (s << 1) | 1, (s << 1) | 5, (s << 1) | 4]);
      else out.push([s, 2 | s, 6 | s, 4 | s]);
    }
  }
  return out;
})();

export class OcclusionCuller {
  constructor(builder) {
    this.b = builder;
    this.version = -1;          // 与 builder.cullVersion 对齐；变了才重建列表
    this.occluders = [];
    this.cullables = [];
    this._hidden = [];          // 本帧被本模块隐藏的对象
    this._list = [];            // 本帧参与光栅化的遮挡体
    this.occEntries = [];       // 与 occluders 一一对应的投影条目（对象集合变化时重建）
    this._scratch = null;       // 非遮挡体测试用的临时条目
    this._w = 0; this._h = 0;
    this._buf = null;
    this._px = 0;               // 本帧已尝试光栅化的像素数
    this._vv = 0;               // 本帧已投影的顶点数
    this._budget = 0;
    this._near = 0.12;
    this._camX = 0; this._camY = 0; this._camZ = 0;
    this.stats = { occluders: 0, candidates: 0, culled: 0 };
  }

  /* ---------- 恢复可见性 ---------- */
  /** 把本模块隐藏过的对象恢复成可见。任何依赖 mesh.visible 的逻辑之前都要先调它 */
  restore() {
    const hs = this._hidden;
    for (let i = 0; i < hs.length; i++) {
      const rec = hs[i];
      const m = rec.mesh;
      if (m && !m.visible && rec._cullVis) m.visible = true;
      rec._cullVis = false;
    }
    hs.length = 0;
  }

  dispose() {
    this.restore();
    this.occluders.length = 0;
    this.cullables.length = 0;
    this.occEntries.length = 0;
    this._list.length = 0;
    this._scratch = null;
    this._buf = null;
    this.version = -1;
  }

  /* ---------- 材质 / 形状 ---------- */
  /** 材质是否完全不透明（数组材质要求全部满足） */
  _matOpaque(mat) {
    if (!mat) return false;
    const arr = Array.isArray(mat) ? mat : [mat];
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      if (!m || m.transparent === true || m.colorWrite === false) return false;
    }
    return true;
  }

  /** 物体（含模型容器下的所有网格）是否整体不透明 */
  _opaque(obj) {
    let any = false, ok = true;
    const visit = (x) => {
      if (x.isMesh) {
        any = true;
        if (!this._matOpaque(x.material)) ok = false;
      }
      const ch = x.children;
      for (let i = 0; i < ch.length && ok; i++) visit(ch[i]);
    };
    visit(obj);
    return any && ok;
  }

  /**
   * 收集物体里可以逐三角形判定的网格（顶点数组 + 索引），缓存在 rec 上：
   * 几何 / 结构变了（换几何、模型挂载完成）才重建。
   * partial = 含蒙皮 / 形变 / 实例化网格 —— 这种物体的包围盒也算不准，整个不剔除。
   */
  _partsOf(rec) {
    const host = rec.mesh;
    const key = host.isMesh
      ? 'm' + host.uuid + '.' + (host.geometry ? host.geometry.uuid : '')
      : 'g' + ((rec.meshes && rec.meshes[0]) ? rec.meshes[0].uuid : '');
    if (rec._ocParts && rec._ocKey === key) return rec._ocParts;
    const list = [];
    let tris = 0, partial = false;
    const visit = (x) => {
      if (x.isMesh) {
        const g = x.geometry;
        const pa = g && g.attributes ? g.attributes.position : null;
        if (pa && !x.isSkinnedMesh && !x.isInstancedMesh
          && !(g.morphAttributes && g.morphAttributes.position)) {
          const idx = g.index ? g.index.array : null;
          const n = idx ? idx.length : pa.count;
          list.push({
            mesh: x, pos: pa.array, idx, n,
            // side：0 正面 / 1 背面 / 2 双面；数组材质（多材质网格）一律不当遮挡体
            side: Array.isArray(x.material) ? -1 : (x.material ? x.material.side : 0),
          });
          tris += n / 3;
        } else {
          partial = true;
        }
      }
      const ch = x.children;
      for (let i = 0; i < ch.length; i++) visit(ch[i]);
    };
    visit(host);
    const parts = { list: list, tris: tris, partial: partial };
    rec._ocParts = parts;
    rec._ocKey = key;
    return parts;
  }

  /** 能否走「盒体」快速路径：几何就是一个立方体表面（方块 / 文字方块等） */
  _isBox(rec, host, parts) {
    if (!host.isMesh || parts.list.length !== 1 || parts.list[0].mesh !== host) return false;
    // poly 是独享几何（形状由 verts / faces 决定），o.shape 缺省时会误当成方块
    if (rec.type === 'poly') return false;
    if ((rec.o.shape || 'block') !== 'block') return false;
    // 只有 o.shape 说“方块”还不够：曲线墙这类扫掠几何根本没有 shape 字段，会走缺省的
    // 'block'。一旦按盒体快速路径走，光栅化就会拿包围盒 8 个角重建一个 **实心盒子** 写进
    // 深度缓冲 —— 真实几何只是那条弯墙，它盒内盒后的一整片物件也会跟着被误剔（成片消失）。
    // 所以这里再按几何本身复核：真方块的面片都贴在自身包围盒的六个面上。
    const geo = host.geometry;
    const ud = geo && geo.userData;
    if (ud && ud.ocBoxShape !== undefined) return ud.ocBoxShape;
    const ok = this._boxTris(parts.list[0]);
    if (ud) ud.ocBoxShape = ok;       // 与 _ocParts 同步失效：几何换掉就换 key
    return ok;
  }

  /**
   * 三角形是否都贴在自身包围盒的六个面上 —— 即几何就是「实心立方体表面」。
   * 注意不能只看顶点（竖直的曲线墙每个顶点都在 y=min/max 上，照样能骗过顶点级的检查），
   * 必须逐三角形要求「三个顶点都压在同一轴上同一个极值」。曲面 / 扫掠 / 镂空 / 十字形
   * 一定存在这样的三角形：三个顶点不共面于盒子的任何一个面 → 判为非方块，走逐三角形判定。
   * 方块（含细分 / 平铺 / 九宫格 / 涂鸦图集 / 拼缝外扩）的三角形永远落在 ±min/max 平面上。
   */
  _boxTris(p) {
    const pos = p.pos;
    const n = p.n;
    if (!pos || n < 9 || n % 3 !== 0) return false;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i + 2 < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
    if (!(ex > 0) || !(ey > 0) || !(ez > 0)) return false;   // 平面 / 退化几何
    const eps = 1e-4 * Math.max(ex, Math.max(ey, ez));
    const idx = p.idx;
    for (let t = 0; t + 2 < n; t += 3) {
      const i0 = (idx ? idx[t] : t) * 3;
      const i1 = (idx ? idx[t + 1] : t + 1) * 3;
      const i2 = (idx ? idx[t + 2] : t + 2) * 3;
      // 三个顶点必须同在 min 面或同在 max 面上（只要求「都在某一端」会漏判：
      // 竖直弯墙的侧面两角在 y=min、一角在 y=max，那样也会被放过去）
      const low = (a, b, c, lo) => a - lo <= eps && b - lo <= eps && c - lo <= eps;
      const high = (a, b, c, hi) => hi - a <= eps && hi - b <= eps && hi - c <= eps;
      const flat = (a, b, c, lo, hi) => low(a, b, c, lo) || high(a, b, c, hi);
      if (flat(pos[i0], pos[i1], pos[i2], minX, maxX)) continue;
      if (flat(pos[i0 + 1], pos[i1 + 1], pos[i2 + 1], minY, maxY)) continue;
      if (flat(pos[i0 + 2], pos[i1 + 2], pos[i2 + 2], minZ, maxZ)) continue;
      return false;
    }
    return true;
  }

  /* ---------- 列表维护 ---------- */
  /** 对象集合变了才重建：分「遮挡体（自己也要判定）」与「只当被剔除对象」两组 */
  _sync() {
    const b = this.b;
    if (!b || this.version === b.cullVersion) return;
    this.version = b.cullVersion;
    const occ = [];
    const cul = [];
    for (const rec of b.objects.values()) {
      if (!rec || rec.disposed || !rec.o) continue;
      if (rec.batched) continue;                         // 已并进静态合批：由合并网格自己视锥剔除
      if (rec.o.visible === false) continue;              // 数据层已隐藏 → 不碰
      if (rec.pendingModel) continue;                     // 模型还没挂上来（占位方块）：形状不准
      if (NEVER_CULL.has(rec.o.type)) continue;
      const host = rec.mesh;
      if (!host) continue;
      const parts = this._partsOf(rec);
      if (!parts.list.length || parts.partial) continue;  // 拿不到准确形状 → 完全不剔除
      const box = this._isBox(rec, host, parts);
      rec._ocBox = box;
      // 不透明才能当遮挡体：透明物体画不出实心遮挡，写进缓冲会把后面的东西误剔
      if (this._opaque(host) && (box || parts.tris <= MAX_TRIS_OCC)) occ.push(rec);
      else cul.push(rec);
    }
    this.occluders = occ;
    this.cullables = cul;
    // 投影条目与遮挡体一一对应，随对象集合一起重建（之后每帧复用，零分配）
    const ents = this.occEntries;
    ents.length = 0;
    for (let i = 0; i < occ.length; i++) ents.push(newEntry());
  }

  /* ---------- 每帧入口 ---------- */
  run(camera) {
    this.restore();
    const b = this.b;
    if (!b || b.editor || !b.root) return;
    const cam = camera;
    if (!cam || !cam.isPerspectiveCamera) return;
    this._sync();

    this._ensure(cam);
    const W = this._w;
    const H = this._h;
    const buf = this._buf;
    buf.fill(0);
    this._px = 0;
    this._vv = 0;
    this._budget = W * H * BUDGET_MUL;
    this._near = cam.near > 0 ? cam.near : 0.12;

    // 世界矩阵必须是最新的：update 里改过 position / 物理回写过插值位置
    b.root.updateMatrixWorld(true);
    cam.updateMatrixWorld();
    _inv.copy(cam.matrixWorld).invert();
    _mvp.multiplyMatrices(cam.projectionMatrix, _inv);
    const ce = cam.matrixWorld.elements;
    this._camX = ce[12]; this._camY = ce[13]; this._camZ = ce[14];

    const list = this._list;
    list.length = 0;

    // ① 收集遮挡体（不透明物体），按最近点排序 → 由近到远
    const ents = this.occEntries;
    for (let i = 0; i < this.occluders.length; i++) {
      const rec = this.occluders[i];
      const m = rec.mesh;
      if (!m || m.visible === false) continue;
      const e = ents[i];
      if (this._project(rec, W, H, MIN_OCC_AREA, e)) list.push(e);
    }
    list.sort((a, c) => c.qz - a.qz);

    // ② 由近到远：先测试，没被挡住的才写进缓冲（避免自遮挡）
    let culled = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (this._occluded(e, W, buf)) { this._hide(e.rec); culled++; continue; }
      if (this._px < this._budget && this._stillOpaque(e.rec)) this._write(e, W, buf);
    }

    // ③ 其余可剔除对象统一测试（不写缓冲，不会自遮挡）。
    //    预算重新计数：不然 ① 把预算吃光后这里一个也判不出来
    this._px = 0;
    this._vv = 0;
    if (!this._scratch) this._scratch = newEntry();
    const sc = this._scratch;
    for (let i = 0; i < this.cullables.length; i++) {
      const rec = this.cullables[i];
      const m = rec.mesh;
      if (!m || m.visible === false) continue;
      if (!this._project(rec, W, H, 0, sc)) continue;
      if (this._occluded(sc, W, buf)) { this._hide(rec); culled++; }
    }

    this.stats.occluders = list.length;
    this.stats.candidates = this.cullables.length;
    this.stats.culled = culled;
    list.length = 0;
  }

  /* ---------- 缓冲区 ---------- */
  _ensure(cam) {
    const aspect = cam.aspect > 0 ? cam.aspect : 16 / 9;
    const w = BASE_W;
    const h = Math.min(BASE_H_MAX, Math.max(BASE_H_MIN, Math.round(BASE_W / aspect)));
    if (this._buf && this._w === w && this._h === h) return;
    this._w = w; this._h = h;
    this._buf = new Float32Array(w * h);
  }

  /* ---------- 投影：把物体（所有部件）包围盒的角投到屏幕 ----------
     角点编号 n = (i<<2)|(j<<1)|k，i/j/k 对应 X/Y/Z 轴的 min(0) / max(1)。
     返回 false 表示「不参与剔除」（跨界 / 全在屏外 / 太小 / 退化）。 */
  _project(rec, W, H, minArea, out) {
    const parts = rec._ocParts;
    if (!parts || !parts.list.length) return false;
    const me = _mvp.elements;
    const nearLimit = this._near * NEAR_GUARD;
    const e = out || newEntry();
    const wx = e.wx, wy = e.wy, wz = e.wz, sx = e.sx, sy = e.sy, q8 = e.q8;
    const single = parts.list.length === 1;   // 单体网格才需要世界角点（盒体路径用）
    let k = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, qz = 0;

    for (let pi = 0; pi < parts.list.length; pi++) {
      const pm = parts.list[pi].mesh;
      const geo = pm.geometry;
      let bb = geo.boundingBox;
      if (!bb) { geo.computeBoundingBox(); bb = geo.boundingBox; }
      if (!bb || bb.isEmpty()) continue;
      const m = pm.matrixWorld.elements;
      const ox = m[12], oy = m[13], oz = m[14];
      const xx = m[0], xy = m[1], xz = m[2];
      const yx = m[4], yy = m[5], yz = m[6];
      const zx = m[8], zy = m[9], zz = m[10];
      for (let n = 0; n < 8; n++, k++) {
        const ux = (n & 4) ? bb.max.x : bb.min.x;
        const uy = (n & 2) ? bb.max.y : bb.min.y;
        const uz = (n & 1) ? bb.max.z : bb.min.z;
        const px = ox + ux * xx + uy * yx + uz * zx;
        const py = oy + ux * xy + uy * yy + uz * zy;
        const pz = oz + ux * xz + uy * yz + uz * zz;
        const cw = me[3] * px + me[7] * py + me[11] * pz + me[15];
        if (!(cw > nearLimit)) return false;        // 跨近平面 / 在相机背后 → 不剔除
        const inv = 1 / cw;
        if (inv > qz) qz = inv;
        const ndcX = (me[0] * px + me[4] * py + me[8] * pz + me[12]) * inv;
        const ndcY = (me[1] * px + me[5] * py + me[9] * pz + me[13]) * inv;
        const px2 = (ndcX * 0.5 + 0.5) * W;
        const py2 = (0.5 - ndcY * 0.5) * H;
        const s = k & 7;
        if (single) { wx[s] = px; wy[s] = py; wz[s] = pz; }
        sx[s] = px2; sy[s] = py2; q8[s] = inv;
        if (px2 < minX) minX = px2;
        if (px2 > maxX) maxX = px2;
        if (py2 < minY) minY = py2;
        if (py2 > maxY) maxY = py2;
      }
    }
    if (!(maxX >= minX)) return false;
    if (maxX < 0 || minX > W || maxY < 0 || minY > H) return false;
    // 包围盒向外取整：多测像素 = 更难判被挡住 = 保守
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(W - 1, Math.floor(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(H - 1, Math.floor(maxY));
    if (x1 < x0 || y1 < y0) return false;
    if (minArea && (x1 - x0 + 1) * (y1 - y0 + 1) < minArea) return false;
    e.rec = rec;
    e.box = single && rec._ocBox === true;
    e.qz = qz; e.x0 = x0; e.y0 = y0; e.x1 = x1; e.y1 = y1;
    return true;
  }

  /* ---------- 遮挡判定 ---------- */
  /** 该物体是否被完全挡住（整流由 _write 负责，这里只看不写） */
  _occluded(e, W, buf) {
    if (e.box) return this._occludedBox(e, W, buf);
    const parts = e.rec && e.rec._ocParts;
    if (!parts) return false;
    if (parts.tris > MAX_TRIS_CULL) return this._occludedBox(e, W, buf);  // 太密 → 退回矩形判定
    return this._eachTri(e.rec, 0, W, buf, e.qz * (1 + REL_EPS));
  }

  /** 包围盒矩形判定：矩形内每个像素都要被遮挡体盖住 */
  _occludedBox(e, W, buf) {
    const th = e.qz * (1 + REL_EPS);
    const x0 = e.x0, x1 = e.x1, y0 = e.y0, y1 = e.y1;
    for (let py = y0; py <= y1; py++) {
      let idx = py * W + x0;
      for (let px = x0; px <= x1; px++, idx++) {
        if (buf[idx] <= th) return false;
      }
    }
    return true;
  }

  /** 写入深度缓冲：方块走盒体面片，其余走真实三角形 */
  _write(e, W, buf) {
    if (e.box) { this._raster(e, W, buf); return; }
    this._eachTri(e.rec, 1, W, buf, 0);
  }

  /** 写缓冲前的最后一道检查：材质可能在本帧被改成了透明（列表是按版本缓存的） */
  _stillOpaque(rec) {
    const m = rec.mesh;
    return m.isMesh ? this._matOpaque(m.material) : this._opaque(m);
  }

  /**
   * 遍历物体的真实三角面：本地顶点 → 世界 → 屏幕，交给 _tri / _triTest。
   * mode 0：遮挡判定（只测不写；发现没被盖住的像素立刻返回 false = 可见）
   * mode 1：写进深度缓冲（按材质面朝向剔掉背面，只写真的会显示出来的面）
   * 返回 true 表示「跑完，且判定为被挡住 / 已写入」。
   */
  _eachTri(rec, mode, W, buf, th) {
    const H = this._h;                             // 缓冲区高（与 W 配对；缺了它这里会抛 ReferenceError）
    const parts = rec._ocParts;
    if (!parts) return mode === 1;                 // 没部件：判定一律按可见
    const me = _mvp.elements;
    const nearLimit = this._near * NEAR_GUARD;
    const ccx = this._camX, ccy = this._camY, ccz = this._camZ;
    for (let pi = 0; pi < parts.list.length; pi++) {
      const p = parts.list[pi];
      if (mode === 1 && p.side < 0) continue;          // 多材质网格：不当遮挡体
      if (p.mesh.visible === false) continue;          // 这个部件自身被隐藏了
      const n = p.n;
      if (this._vv + n > VERT_BUDGET) return mode === 1;   // 超预算：判定一律按可见
      this._vv += n;
      const m = p.mesh.matrixWorld.elements;
      const det = m[0] * (m[5] * m[10] - m[6] * m[9])
        - m[4] * (m[1] * m[10] - m[2] * m[9])
        + m[8] * (m[1] * m[6] - m[2] * m[5]);
      const flip = det < 0 ? -1 : 1;                   // 镜像（负行列式）：绕序判定取反
      const side = p.side;
      const pos = p.pos, idx = p.idx;
      for (let t = 0; t + 2 < n; t += 3) {
        const i0 = idx ? idx[t] * 3 : t;
        const i1 = idx ? idx[t + 1] * 3 : t + 3;
        const i2 = idx ? idx[t + 2] * 3 : t + 6;
        const a0 = pos[i0], a1 = pos[i0 + 1], a2 = pos[i0 + 2];
        const ax = m[12] + a0 * m[0] + a1 * m[4] + a2 * m[8];
        const ay = m[13] + a0 * m[1] + a1 * m[5] + a2 * m[9];
        const az = m[14] + a0 * m[2] + a1 * m[6] + a2 * m[10];
        const wa = me[3] * ax + me[7] * ay + me[11] * az + me[15];
        if (!(wa > nearLimit)) { if (mode === 0) return false; continue; }
        const qa = 1 / wa;
        const sax = ((me[0] * ax + me[4] * ay + me[8] * az + me[12]) * qa * 0.5 + 0.5) * W;
        const say = (0.5 - (me[1] * ax + me[5] * ay + me[9] * az + me[13]) * qa * 0.5) * H;
        const b0 = pos[i1], b1 = pos[i1 + 1], b2 = pos[i1 + 2];
        const bx = m[12] + b0 * m[0] + b1 * m[4] + b2 * m[8];
        const by = m[13] + b0 * m[1] + b1 * m[5] + b2 * m[9];
        const bz = m[14] + b0 * m[2] + b1 * m[6] + b2 * m[10];
        const wb = me[3] * bx + me[7] * by + me[11] * bz + me[15];
        if (!(wb > nearLimit)) { if (mode === 0) return false; continue; }
        const qb = 1 / wb;
        const sbx = ((me[0] * bx + me[4] * by + me[8] * bz + me[12]) * qb * 0.5 + 0.5) * W;
        const sby = (0.5 - (me[1] * bx + me[5] * by + me[9] * bz + me[13]) * qb * 0.5) * H;
        const c0 = pos[i2], c1 = pos[i2 + 1], c2 = pos[i2 + 2];
        const cx = m[12] + c0 * m[0] + c1 * m[4] + c2 * m[8];
        const cy = m[13] + c0 * m[1] + c1 * m[5] + c2 * m[9];
        const cz = m[14] + c0 * m[2] + c1 * m[6] + c2 * m[10];
        const wc = me[3] * cx + me[7] * cy + me[11] * cz + me[15];
        if (!(wc > nearLimit)) { if (mode === 0) return false; continue; }
        const qc = 1 / wc;
        const scx = ((me[0] * cx + me[4] * cy + me[8] * cz + me[12]) * qc * 0.5 + 0.5) * W;
        const scy = (0.5 - (me[1] * cx + me[5] * cy + me[9] * cz + me[13]) * qc * 0.5) * H;

        if (mode === 1) {
          // 世界法线 (b-a)×(c-a)；d e t < 0（镜像）时朝向要取反，才和渲染器的绕序修正一致
          const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
          const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
          const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
          const face = (nx * (ccx - ax) + ny * (ccy - ay) + nz * (ccz - az)) * flip;
          if (side === 0 ? face <= 0 : (side === 1 ? face >= 0 : false)) continue;
          this._tri(sax, say, qa, sbx, sby, qb, scx, scy, qc, W, buf);
        } else if (!this._triTest(sax, say, sbx, sby, scx, scy, W, buf, th)) {
          return false;
        }
      }
    }
    return true;
  }

  _hide(rec) {
    const m = rec.mesh;
    if (!m || m.visible === false) return;
    m.visible = false;
    rec._cullVis = true;
    this._hidden.push(rec);
  }

  /* ---------- 光栅化（盒体快速路径：最多写 3 个可见面） ---------- */
  _raster(e, W, buf) {
    const wx = e.wx, wy = e.wy, wz = e.wz, sx = e.sx, sy = e.sy, q8 = e.q8;
    // 盒子中心 = 角点 0（min,min,min）与 7（max,max,max）的中点
    const cx = (wx[0] + wx[7]) * 0.5;
    const cy = (wy[0] + wy[7]) * 0.5;
    const cz = (wz[0] + wz[7]) * 0.5;
    const camX = this._camX, camY = this._camY, camZ = this._camZ;

    for (let fi = 0; fi < 6; fi++) {
      const f = FACES[fi];
      const a = f[0], b = f[1], c = f[2], d = f[3];
      const fcx = (wx[a] + wx[b] + wx[c] + wx[d]) * 0.25;
      const fcy = (wy[a] + wy[b] + wy[c] + wy[d]) * 0.25;
      const fcz = (wz[a] + wz[b] + wz[c] + wz[d]) * 0.25;
      // 面法线 = (b-a) × (d-a)，再按「从中心指向面」修正朝外（镜像局也正确）
      _vA.set(wx[b] - wx[a], wy[b] - wy[a], wz[b] - wz[a]);
      _vB.set(wx[d] - wx[a], wy[d] - wy[a], wz[d] - wz[a]);
      _nv.crossVectors(_vA, _vB);
      if (_nv.x * (fcx - cx) + _nv.y * (fcy - cy) + _nv.z * (fcz - cz) < 0) _nv.negate();
      // 背面剔除：法线背对相机的面画不到，省一半光栅化
      if (_nv.x * (camX - fcx) + _nv.y * (camY - fcy) + _nv.z * (camZ - fcz) <= 0) continue;
      this._tri(sx[a], sy[a], q8[a], sx[b], sy[b], q8[b], sx[c], sy[c], q8[c], W, buf);
      this._tri(sx[a], sy[a], q8[a], sx[c], sy[c], q8[c], sx[d], sy[d], q8[d], W, buf);
    }
  }

  /**
   * 屏幕空间三角形：用边函数取重心坐标，线性插值 qz = 1/w，z-max 写入。
   * 保守：只有**整块**落在三角形内的像素才写入（每条边向内收缩半个像素），
   * 这样缓冲区里任何非零值都代表「这个像素被实心几何真正盖住」。
   */
  _tri(x0, y0, q0, x1, y1, q1, x2, y2, q2, W, buf) {
    const lox = Math.min(x0, x1, x2), hix = Math.max(x0, x1, x2);
    const loy = Math.min(y0, y1, y2), hiy = Math.max(y0, y1, y2);
    const ix0 = Math.max(0, Math.ceil(lox - 0.5));
    const ix1 = Math.min(W - 1, Math.floor(hix - 0.5));
    if (ix1 < ix0) return;
    const H = this._h;
    const iy0 = Math.max(0, Math.ceil(loy - 0.5));
    const iy1 = Math.min(H - 1, Math.floor(hiy - 0.5));
    if (iy1 < iy0) return;
    const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (area > -1e-9 && area < 1e-9) return;
    const inv = 1 / area;
    this._px += (ix1 - ix0 + 1) * (iy1 - iy0 + 1);

    const A0 = x2 - x1, B0 = y1 - y2;
    const A1 = x0 - x2, B1 = y2 - y0;
    const A2 = x1 - x0, B2 = y0 - y1;
    // 半个像素的边值变化量 → 用作「整块在内部」的判据（A 管 y 方向、B 管 x 方向）
    const e0 = (Math.abs(A0) + Math.abs(B0)) * 0.5;
    const e1 = (Math.abs(A1) + Math.abs(B1)) * 0.5;
    const e2 = (Math.abs(A2) + Math.abs(B2)) * 0.5;
    const startX = ix0 + 0.5;
    for (let py = iy0; py <= iy1; py++) {
      const yy = py + 0.5;
      let w0 = A0 * (yy - y1) + B0 * (startX - x1);
      let w1 = A1 * (yy - y2) + B1 * (startX - x2);
      let w2 = A2 * (yy - y0) + B2 * (startX - x0);
      let idx = py * W + ix0;
      for (let px = ix0; px <= ix1; px++, idx++, w0 += B0, w1 += B1, w2 += B2) {
        if (!((w0 >= e0 && w1 >= e1 && w2 >= e2) || (w0 <= -e0 && w1 <= -e1 && w2 <= -e2))) continue;
        const q = (w0 * q0 + w1 * q1 + w2 * q2) * inv;
        if (q > buf[idx]) buf[idx] = q;
      }
    }
  }

  /**
   * 屏幕空间三角形：像素是否全被缓冲盖住。false = 有像素露出（可见）。
   * 保守：三角形**碰到**的像素都要检查（每条边向外扩张半个像素，遍历范围
   * 也多算一圈），所以只露出半个低分辨率像素宽的小物件不会被误判成被挡住。
   */
  _triTest(x0, y0, x1, y1, x2, y2, W, buf, th) {
    const lox = Math.min(x0, x1, x2), hix = Math.max(x0, x1, x2);
    const loy = Math.min(y0, y1, y2), hiy = Math.max(y0, y1, y2);
    const ix0 = Math.max(0, Math.ceil(lox - 0.5) - 1);
    const ix1 = Math.min(W - 1, Math.floor(hix - 0.5) + 1);
    if (ix1 < ix0) return true;
    const H = this._h;
    const iy0 = Math.max(0, Math.ceil(loy - 0.5) - 1);
    const iy1 = Math.min(H - 1, Math.floor(hiy - 0.5) + 1);
    if (iy1 < iy0) return true;
    const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (area > -1e-9 && area < 1e-9) return true;    // 退化三角形：不占像素
    this._px += (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
    if (this._px > this._budget) return false;       // 超预算 → 判可见（保守）

    const A0 = x2 - x1, B0 = y1 - y2;
    const A1 = x0 - x2, B1 = y2 - y0;
    const A2 = x1 - x0, B2 = y0 - y1;
    const e0 = (Math.abs(A0) + Math.abs(B0)) * 0.5;
    const e1 = (Math.abs(A1) + Math.abs(B1)) * 0.5;
    const e2 = (Math.abs(A2) + Math.abs(B2)) * 0.5;
    const startX = ix0 + 0.5;
    for (let py = iy0; py <= iy1; py++) {
      const yy = py + 0.5;
      let w0 = A0 * (yy - y1) + B0 * (startX - x1);
      let w1 = A1 * (yy - y2) + B1 * (startX - x2);
      let w2 = A2 * (yy - y0) + B2 * (startX - x0);
      let idx = py * W + ix0;
      for (let px = ix0; px <= ix1; px++, idx++, w0 += B0, w1 += B1, w2 += B2) {
        if (!((w0 >= -e0 && w1 >= -e1 && w2 >= -e2) || (w0 <= e0 && w1 <= e1 && w2 <= e2))) continue;
        if (buf[idx] <= th) return false;            // 这个像素露出来了 → 可见
      }
    }
    return true;
  }
}
