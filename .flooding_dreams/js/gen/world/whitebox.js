/* ============================================================
   世界优先管线 · Phase A：白模程序化生成器
   ------------------------------------------------------------
   目标：**先独立地造出一个「地方」**，与路线无关。
   这里不做任何「跳跃可达性」判断 —— 那是 Phase C 的事。
   白模只回答：「按这个主题、这个空间结构，这里大体长什么样」。

   ★ 体量由**主题专属的 PCG** 画（world/themes/<主题>.js），
     白模只负责把它拼成一个完整的世界：
       ① 逐带调主题 PCG（草原/城市/荧渊/阈限各有一套构造）
       ② 封壳（外墙 / 顶 / 底盆）
       ③ 通风井：把各层的空腔连成一个连通域
       ④ 攀登链：世界自带的、能爬上去的骨架（含「特技段」）
       ⑤ 壁架 / 岛台：把可用落脚面铺满

   ★ 两条「完美的白模」硬要求（新管线里世界必须先站得住脚）：
     ① **可攀爬**：世界自带一条从底到顶的攀登链（climbSpiral）——
        每级抬升一个体素（≈6 stud < 跳跃顶点 6.89），横向推进 3 个体素，
        且逐级错开，保证每一级头顶都有净空。
     ② **有特技段**：链上每隔几级留一段**竖井（riser）或裂谷（chasm）**——
        中间台阶被拿掉，只有滑索 / 攀爬 / WallJump / 游泳才过得去。
        这一段由 Phase C 的机制段模板（world/mechRoute.js）接管，
        于是主轴不再是「一路跳跳跳」。

   ★ 性能：只输出表层体素并三维贪心合并，方块数控制在预算内。
   ============================================================ */
import { clamp, round } from '../../core/util.js';
import { hashSeed, makeRng } from '../rng.js';
import {
  makeGrid, cix, inGrid, setSolid, clearSolid, fillBoxIdx, clearBoxIdx,
  cxOf, cyOf, czOf, cellCenterX, cellCenterY, cellCenterZ,
  gridStats, mergeBoxes, gridWorldBox, makeNoise, cloneGrid,
} from './voxel.js';
import { pcgFor } from './themes/index.js';
import { makeDeco } from './themes/common.js';
import { pickPieces, stampPiece, pieceCatalog } from './themes/pieces.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 体块材质槽位（只影响配色分层，不影响几何） */
export const MAT = { wall: 0, col: 1, slab: 2, roof: 3, block: 4, ledge: 5 };

/* 预算：白模产物会一路拖慢下游（编辑器重建 / NavGraph 射线 / 进关加载）。 */
const MAX_CELLS = 320000;      // 体素总数上限（够 cell=4 的大世界）
/* 合并后方块数上限。★ 2000 → 2400 → **5000**：用户要的是「多体结构」（若干独立体量互相
   咬合），体量越多、表面越碎，方块数就越高；用户已明确允许把预算开到 5000。 */
const MAX_BOXES = 5000;
const MAX_TRIES = 3;           // 超限时「粗化重来」最多 2 次
const MAX_CELL = 6;            // ★ 体素边长硬上限：cell 必须 < 跳跃顶点(6.89)

/* 零散件的总配额（按带均分）：见 themes/common.js 的 makeDeco。
   ★ 150 会让「塔外区域」一加进来就顶穿体块预算（实测 2311），
     所以压到 50 —— 主题该有的零散件仍然有，只是不再失控。 */
const DECO_QUOTA = 50;

/* ============================================================
   多体结构（multi-mass）：世界由**若干独立的体量**拼成
   ------------------------------------------------------------
   旧版每条带都让主题 PCG 把整个矩形横截面画满，再套一圈矩形外墙 ——
   于是无论里面有多少股道 / 环台 / 区域，世界的**外轮廓永远是一个火柴盒**。

   新版先在世界尺度上排一批**体量（mass）**，每个体量自带：
     · 自己的平面轮廓（大小 / 位置都不同）
     · 自己的**起始高度**与**顶面高度**（高低错落 → 轮廓有起伏）
     · 环向散布 + 尺寸足够大 → 相邻体量**互相咬合**（union 是一个多瓣的整体，
       不是一堆飘在空中的孤岛）
   然后每条带只把「与自己相交的那部分体量」交给主题 PCG 去画 ——
   主题 PCG 一行没改（它本来就只认 `reg`）。

   ★ 体量列表是**全局**的（一条体量跨好几条带），所以读出来是「几座塔/几块台地」，
     而不是「一层一层的薄饼」。
   ============================================================ */
const MASS = {
  count: [5, 9],        // 体量个数
  wFrac: [0.26, 0.52],  // 每个体量的平面尺寸（占可用跨度）
  topFrac: [0.38, 1.0], // 顶面高度（占世界高度）→ 高低错落
  baseJitter: 0.12,     // 底面相对世界底部的抖动
  ringR: [0.16, 0.62],  // 体量中心所在的环带半径（占可用半径）
  pieces: [1, 2],       // 每个体量顶上摆几件结构件
};

/* 塔只占中间一段半径，外圈留给「区域」—— 世界才不是一根塔 */
const TOWER = { radiusFrac: 0.5 };

/* 横向区域的口径（单位：体素/级） */
const REGION = {
  count: 3,          // 一圈排几个区域
  tiers: 2,          // 纵向排几圈（带数不够时自动降到 1）
  inner: 0.55,       // 区域环带内界（相对可用半径 rTop）
  outer: 0.97,       // 区域环带外界
  minCells: 4,       // 径向/切向最小格数（不够就不放区域）
  gapCells: 2,       // 连桥与交汇环台之间的缝隙（格）
  deckDrop: 1,       // 区域地台比环台低几格（**不同高 → 不会并成一块巨型 pad**）
  pieces: [1, 2],    // 每个区域拼几件结构件（≥1 竖向 + ≥1 横向由 pickPieces 保证）
};

/** 攀登链的几何口径（单位：体素） */
const CHAIN = {
  footprint: 2,     // 落脚台边长（体素）：2×6 = 12 stud
  advance: 3,       // 沿螺旋每步前进（体素）：3×6 = 18 stud
  // 落脚台上方要清空的体素层数：玩家站在台阶顶面，头顶净空 = clearUp × cell，
  // 必须 ≥ minCeiling(≈14.89)+2 —— 取 4 层，cell 5/6 下都是 20/24 stud，足够。
  clearUp: 4,
  rise: 1,          // 每步抬升（体素）：1×6 = 6 stud < 跳跃顶点 6.89
};

/* ============================================================
   主入口
   ------------------------------------------------------------
   @param wt   world/theme.js 的产物（世界蓝图）
   @param opts { rng, cell }
   @returns { grid, bands[], cell, bounds, stats, boxes, noiseSeed }
   ============================================================ */
export function buildWorld(wt, opts = {}) {
  const t0 = now();
  const rng = opts.rng || makeRng(wt.seedBase || wt.id || 'world');
  let cell = Number.isFinite(Number(opts.cell)) && opts.cell > 0
    ? clamp(Math.round(opts.cell), 4, 10)
    : pickCell(wt);
  const bounds = worldBounds(wt, cell);
  let g = null;
  let boxes = [];
  let tries = 0;
  let chain = [];                 // ★ 必须在循环外声明：它要在循环之后作为产物返回
  let strands = [];               // 多股股道（每条按级排列）
  let junctions = [];             // 交汇环台
  let regions = [];               // 塔外的横向区域（各自带结构件清单）
  let massList = [];              // 多体结构的体量清单
  let topPieces = [];             // 体量顶面摆的结构件
  let skelAxis = null;            // 塔的中心（世界坐标）：环台圆弧走道要用
  const difficulty = clamp(Number(wt.difficulty) || 3, 0.5, 9.99);

  while (tries < MAX_TRIES) {
    tries++;
    g = makeGrid(bounds, cell);
    g.noiseSeed = hashSeed(`${wt.id}|noise|${cell}`);
    const noise = makeNoise(g.noiseSeed);

    /* ---------- ① 逐带铺主题白模（大体量） ----------
       ★ 每一条带都调**主题自己的** PCG：草原画草坡与孤树、城市画街网与塔群、
         荧渊画岩腔与荧光柱、阈限画走廊与门列 —— 主题身份就是这么长出来的。
       ★ 零散件配额：按带均分 DECO_QUOTA，主题 PCG 靠 c.deco.spend() 取用，
         配额用完那类「一格一格」的小件就停手（体块预算的守门人）。 */
    const pcg = pcgFor(wt.style, wt.id);
    const decoPerBand = Math.max(6, Math.round(DECO_QUOTA / Math.max(1, wt.bands.length)));
    /* ★ 先在**世界尺度**上排出多体结构，再让每条带只画「与自己相交的那部分体量」。 */
    const masses = planMasses(g, wt, rng.fork('mass'));
    massList = masses;
    for (const band of wt.bands) {
      const reg = regionOfBand(g, band, wt);
      band.reg = reg;
      // 本带与各体量的交集（同一体量跨多条带，所以读出来是「几座体量」而不是「薄饼」）
      const parts = [];
      for (const m of masses) {
        const y0 = Math.max(reg.y0, m.y0), y1 = Math.min(reg.y1, m.y1);
        if (y1 - y0 < 2) continue;
        const x0 = Math.max(reg.x0, m.x0), x1 = Math.min(reg.x1, m.x1);
        const z0 = Math.max(reg.z0, m.z0), z1 = Math.min(reg.z1, m.z1);
        if (x1 - x0 < 2 || z1 - z0 < 2) continue;
        parts.push({ x0, x1, y0, y1, z0, z1, mi: m.i });
      }
      band.parts = parts.length;
      if (!parts.length) {
        pcg.build({
          g, reg, band, wt, rng: rng.fork(`band${band.i}`), noise, cell, deco: makeDeco(decoPerBand),
        });
        continue;
      }
      const decoEach = Math.max(4, Math.round(decoPerBand / parts.length * 1.6));
      for (const p of parts) {
        pcg.build({
          g, reg: { x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1, z0: p.z0, z1: p.z1 },
          band, wt, noise, cell,
          rng: rng.fork(`band${band.i}m${p.mi}`),
          deco: makeDeco(decoEach),
        });
      }
    }

    /* ---------- ② 边界：外墙 / 顶 / 底盆 ---------- */
    sealShell(g, wt);

    /* ---------- ③ 通风井：上下贯通的一批竖井 ----------
       文法各自成层，层与层之间需要一个「上下贯通」的通道，否则自由空间会碎成
       一堆互不相连的孤立空腔（观测层只认最大连通域，其它全被丢掉）。
       于是打一批从底贯到顶的细竖井：只**移除**实体，不可能破坏可达性，
       反而给了「掉下去 / 局部下降」的天然落点。 */
    ventPass(g, wt, rng.fork('vent'));

    /* ---------- ④ 攀登骨架：多股股道 + 交汇环台 ---------- */
    const skel = climbStrands(g, wt, rng.fork('chain'), cell);
    chain = skel.chain;
    strands = skel.strands;
    junctions = skel.junctions;
    skelAxis = skel.axis;

    /* ---------- ④b 横向区域：塔外一圈「区域」+ 连桥 + 结构件 ---------- */
    regions = districtPass(g, wt, rng.fork('region'), cell, skel, difficulty);

    /* ---------- ④c 体量顶面：摆上结构件 ----------
       每个体量的顶面都是一片天台，正好放「天桥 / 拱廊 / 环形看台 / 柱厅 / 屋顶花园…」，
       于是 24 种结构件真的出现在成品里，而不是只写在库里。 */
    topPieces = massTopPieces(g, wt, rng.fork('mtop'), cell, difficulty, massList);

    /* ---------- ⑤ 壁架 / 岛台：把可用落脚面铺满 ---------- */
    for (const band of wt.bands) {
      const reg = band.reg || regionOfBand(g, band, wt);
      ledgePass({ g, reg, band, wt, rng: rng.fork(`ledge${band.i}`), cell });
    }

    /* ---------- ⑥ 末道保险：把攀登骨架每一级**重新清空并保护** ----------
       世界在这一步之前还跑过区域 / 壁架 / （后面的）演化；任何一层往上写实体
       都可能把主轴那一级的净空堵掉。这里按 paveLane 的原口径把每一级台阶
       重铺一遍并重新标保护 —— 之后谁都不许再碰它。 */
    resecureSpine(g, strands);

    boxes = mergeBoxes(g);
    if (boxes.length <= MAX_BOXES) break;
    // ★ 超预算就**粗化一格重来**（不是 ×1.5+1）：体素边长必须留在 ≤ 6，
    //   否则「一级台阶 = cell stud」会超过跳跃顶点 6.89 stud，攀登链就断了。
    if (cell >= MAX_CELL) break;
    cell = Math.min(MAX_CELL, cell + 1);
    Object.assign(bounds, worldBounds(wt, cell));
  }

  const stats = gridStats(g);
  const topY = g.oy + g.ny * g.cell;
  return {
    grid: g,
    cell: g.cell,
    tries,
    bounds: gridWorldBox(g),
    chain,
    strands,
    junctions,
    regions,
    masses: massList,
    topPieces,
    axis: skelAxis,
    boxes,
    stats,
    topY: round(topY, 3),
    ms: Math.round(now() - t0),
  };
}

/** 体素尺寸：越细世界越像样，但下游越慢。
    细到 cell=4 仍然满足「一级台阶 4 stud < 跳跃顶点 6.89」，所以先从 4~5 起，超预算再加大。 */
function pickCell(wt) {
  const bySize = clamp(Math.round((wt.span || 150) / 42), 4, 5);
  let c = bySize;
  while (c < 9) {
    const nx = Math.ceil((wt.span || 150) / c) + 2;
    const ny = Math.ceil((wt.height || 150) / c) + 4;
    if (nx * nx * ny <= MAX_CELLS) break;
    c++;
  }
  return c;
}

function worldBounds(wt, cell) {
  const half = (wt.span || 150) / 2 + cell;
  return {
    min: { x: -half, y: -cell * 3, z: -half },
    max: { x: half, y: (wt.height || 150) + cell * 3, z: half },
  };
}

/** 一个 band 的体素区域（x/z 留 1 格给边界墙） */
function regionOfBand(g, band, wt) {
  const y0 = clamp(cyOf(g, band.y0), 0, g.ny - 1);
  const y1 = clamp(cyOf(g, band.y1), 0, g.ny - 1);
  return { x0: 1, x1: g.nx - 2, y0, y1, z0: 1, z1: g.nz - 2 };
}

/* ============================================================
   体量布局：在世界尺度上排一批**互相咬合的多体**
   ------------------------------------------------------------
   · 中心沿一个环带撒点（等分角 + 抖动）→ 铺开但不跑出格子
   · 每个体量尺寸取可用跨度的 26%~52% → 相邻体量**必然重叠**（咬合）
   · 每个体量自己的底面（±jitter）与顶面（38%~100% 世界高度）→ 高低错落
   · 再补一条「中心体量」，保证塔所在的中轴也有实体可以依托
   返回 [{ x0,x1, z0,z1, y0,y1, i }]
   ============================================================ */
function planMasses(g, wt, rng) {
  const n = clamp(rng.int(MASS.count[0], MASS.count[1]), 3, 12);
  const cx = (g.nx - 1) / 2, cz = (g.nz - 1) / 2;
  const half = Math.max(6, Math.min(g.nx, g.nz) / 2 - 3);
  const yBot = 1, yTop = Math.max(6, g.ny - 3);
  const W = g.nx - 4, D = g.nz - 4;
  const a0 = rng.range(0, Math.PI * 2);
  const out = [];
  const add = (fcx, fcz, w, d, y0, y1) => {
    const x0 = clamp(Math.round(fcx - w / 2), 1, Math.max(1, g.nx - 3 - w));
    const z0 = clamp(Math.round(fcz - d / 2), 1, Math.max(1, g.nz - 3 - d));
    out.push({
      x0, x1: Math.min(g.nx - 2, x0 + w - 1),
      z0, z1: Math.min(g.nz - 2, z0 + d - 1),
      y0: clamp(Math.round(y0), yBot, yTop), y1: clamp(Math.round(y1), yBot + 3, yTop), i: out.length,
    });
  };
  for (let i = 0; i < n; i++) {
    const w = Math.max(6, Math.round(W * rng.range(MASS.wFrac[0], MASS.wFrac[1])));
    const d = Math.max(6, Math.round(D * rng.range(MASS.wFrac[0], MASS.wFrac[1])));
    const ang = a0 + (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const rad = rng.range(MASS.ringR[0], MASS.ringR[1]) * half;
    const y0 = yBot + yTop * rng.range(0, MASS.baseJitter);
    const y1 = yBot + yTop * rng.range(MASS.topFrac[0], MASS.topFrac[1]);
    add(cx + Math.cos(ang) * rad, cz + Math.sin(ang) * rad, w, d, y0, y1);
  }
  // 中轴体量：塔要穿过去，中轴必须有实体（高度取全场最高，顶住天花）
  const wc = Math.max(8, Math.round(W * rng.range(0.34, 0.46)));
  const dc = Math.max(8, Math.round(D * rng.range(0.34, 0.46)));
  add(cx, cz, wc, dc, yBot, yBot + yTop * rng.range(0.82, 1.0));
  return out;
}

/** 一条带在 y0..y1 之间的 2D 占用掩码（哪一列有实体） */
function bandMask(g, reg) {
  const m = new Uint8Array(g.nx * g.nz);
  for (let y = Math.max(0, reg.y0); y <= Math.min(g.ny - 1, reg.y1); y++) {
    for (let z = Math.max(1, reg.z0); z <= Math.min(g.nz - 2, reg.z1); z++) {
      for (let x = Math.max(1, reg.x0); x <= Math.min(g.nx - 2, reg.x1); x++) {
        if (g.occ[cix(g, x, y, z)]) m[z * g.nx + x] = 1;
      }
    }
  }
  return m;
}

/** 2D 掩码膨胀（切比雪夫半径 r） */
function dilate2(m, nx, nz, r) {
  if (r <= 0) return m;
  const out = new Uint8Array(nx * nz);
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      if (!m[z * nx + x]) continue;
      for (let dz = -r; dz <= r; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= nz) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= nx) continue;
          out[zz * nx + xx] = 1;
        }
      }
    }
  }
  return out;
}

/* ============================================================
   边界：**贴着体量的壳**（不再是「一圈矩形外墙」）
   ------------------------------------------------------------
   旧版把每条带的矩形四边整圈砌墙 + 整块顶板 → 世界的轮廓永远是方的。
   新版先量出**这条带真正有实体的那些列**（2D 占用掩码），再：
     · 侧墙 = 掩码**膨胀 t 格后的外圈**（1 格厚）→ 壳跟着体量的轮廓走，
       丢块的缺口处自然没有墙 → 外轮廓是**错落的体量群**
     · 顶 = 只盖在掩码（膨胀 1）上 → 有体量才有顶
     · 开口：每 3 格留 1 格通道 → 各体量的内腔与外部保持连通
       （观测层只认最大连通域，壳要是全封死，内腔会被整片丢掉）
   · 底盆：只铺在**全世界有体量的那些列**下面 —— 虚空列不铺，
     否则世界底部会出现一块「跨世界的大地面」，被观测层认成一块巨型 pad，
     解析判定会照着它算出一堆假边。
   ============================================================ */
function sealShell(g, wt) {
  const nx = g.nx, nz = g.nz;
  const all = new Uint8Array(nx * nz);
  for (const band of wt.bands) {
    const reg = band.reg;
    if (!reg) continue;
    const m = bandMask(g, reg);
    for (let i = 0; i < m.length; i++) if (m[i]) all[i] = 1;
    const wall = clamp(Number(band.shell.wall) || 0, 0, 1);
    const t = clamp(Math.round(wall * 2.4), 0, 3);
    const near = dilate2(m, nx, nz, Math.max(0, t - 1));
    const far = t > 0 ? dilate2(m, nx, nz, t) : m;
    for (let z = 1; z < nz - 1; z++) {
      for (let x = 1; x < nx - 1; x++) {
        const i = z * nx + x;
        if (!far[i]) continue;
        // 开口：每 3 格留 1 格（保连通）
        if (((x + z) % 3) === 0) continue;
        const shell = !near[i] || !m[i];        // 外圈 / 掩码空洞的内沿
        if (!shell) continue;
        if (t === 0 && !m[i]) continue;         // 开阔结构不砌外墙
        for (let y = Math.max(1, reg.y0); y <= Math.min(g.ny - 2, reg.y1); y++) {
          const j = cix(g, x, y, z);
          if (g.protect && g.protect[j]) continue;      // 骨架清出来的净空不许填
          if (g.occ[j]) continue;
          g.occ[j] = 1; g.mat[j] = MAT.wall;
        }
      }
    }
    // 顶：只盖在有体量的那些列上
    if (band.shell.ceilY > 0) {
      const top = clamp(reg.y1, 0, g.ny - 1);
      const cm = dilate2(m, nx, nz, 1);
      for (let z = 1; z < nz - 1; z++) {
        for (let x = 1; x < nx - 1; x++) {
          if (!cm[z * nx + x]) continue;
          const j = cix(g, x, top, z);
          if (g.protect && g.protect[j]) continue;
          g.occ[j] = 1; g.mat[j] = MAT.roof;
        }
      }
    }
  }
  // 底盆（只铺在有体量的列上）
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      if (!all[z * nx + x]) continue;
      const j = cix(g, x, 0, z);
      g.occ[j] = 1; g.mat[j] = MAT.slab;
    }
  }
}

/* ============================================================
   通风井：一批从底贯到顶的细竖井
   ------------------------------------------------------------
   只**移除**实体，所以不可能破坏可达性；它唯一的作用是把各层的空腔
   连成一个连通域，顺带造出「掉下去 / 局部下降」的天然竖井。
   ============================================================ */
function ventPass(g, wt, rng) {
  const yBot = 1;
  const yTop = g.ny - 2;
  const k = clamp(Math.round((wt.bands.length || 4) * 2), 4, 14);
  const vents = [];
  for (let i = 0; i < k; i++) {
    const x = rng.int(3, Math.max(4, g.nx - 5));
    const z = rng.int(3, Math.max(4, g.nz - 5));
    const w = rng.chance(0.4) ? 2 : 1;
    for (let y = yBot; y <= yTop; y++) {
      for (let dx = 0; dx < w; dx++) {
        for (let dz = 0; dz < w; dz++) clearSolid(g, x + dx, y, z + dz);
      }
    }
    vents.push({ x, z, w });
  }
  return vents;
}

/**
 * 在两点之间清一条宽度 fp 的通道，**沿直线走**（不是先走 x 再走 z 的楼梯）。
 * ★ 必须是直线：特技段（裂谷）的滑索是一条**直的**缆绳，玩家吊在绳下平移 ——
 *   如果走廊是 L 形的，绳子中段就会穿进石头里。同理，机制段模板也是沿线采样净空的。
 * 并把清出来的格子记进保护带 —— 保证「世界自带的路线」真的连得上。
 */
function carvePath(g, ax, az, bx, bz, y0, y1, fp) {
  const dx = bx - ax, dz = bz - az;
  const n = Math.max(Math.abs(dx), Math.abs(dz));
  /* ★ 半径取 ceil(fp/2)：踏步台的**世界中心**落在体素边界上（比 carve 用的角点多半格），
     所以通道要比 fp 宽一圈，采样点（沿踏步中心连线）才一定落在空气里。 */
  const r = Math.max(1, Math.ceil(fp / 2));
  for (let i = 0; i <= n; i++) {
    const t = n <= 0 ? 0 : i / n;
    const x = Math.round(ax + dx * t);
    const z = Math.round(az + dz * t);
    for (let yy = y0; yy <= y1; yy++) {
      for (let dzz = -r; dzz <= r; dzz++) {
        for (let dxx = -r; dxx <= r; dxx++) {
          const px = clamp(x + dxx, 0, g.nx - 1);
          const pz = clamp(z + dzz, 0, g.nz - 1);
          clearSolid(g, px, yy, pz);
          if (g.protect) g.protect[cix(g, px, yy, pz)] = 1;
        }
      }
    }
    if (n <= 0) break;
  }
}

/* ============================================================
   ① 攀登骨架：**多股交织的股道 + 交汇环台**（含「特技段」）
   ------------------------------------------------------------
   旧版只有**一条**螺旋链 —— 于是整张图在拓扑上就是「一条链 + 几条岔路」，
   结构复杂度上不去。新版把它换成：

     · **股道（strand）**：每条在自己的扇区（2π/股道数）里做三角波折返，
       角速度各不相同 → 一条像盘梯、一条像陡塔、一条像之字坡道；
       三条股的**半径曲线是共享的** R(level)，所以每一级都落在同一个圆周上。
     · **交汇环台（ring）**：每 junctionEvery 级，在这一级的圆周上铺一圈
       可行走的环台 —— 三股在同一层被它连起来，于是「换股道」成了真实的分叉 / 合流。
     · **特技段**照旧（竖井 / 裂谷），但不许跨过交汇层：
       riser 竖井 = 连续几级**不横向移动**（只抬高度，中间台阶拿掉）；
       chasm 裂谷 = **一级之内**横跨一个大缺口（弧长按 stud 目标换算）。
       ★ 两者的高度都严格是「每级 +1 体素」，所以**每一级 y = yBot + level 对所有股道成立**
         —— 这是交汇环台能把三股连起来的前提，不要改。

   ★ 每一级都必须可跳：横向弧长由 STRANDS.maxArc 卡死（≤ 2 体素 → 边到边缺口 ≈ 0）。
   ★ 特技段的清理**从上一级台阶之上开始**，首尾两级一定留着。
   ============================================================ */
const FEATURE = {
  riseStud: 15,                  // 竖井的目标落差(stud)：> 跳跃顶点 6.89，跳不上去
  gapStud: 36,                   // 裂谷的目标缺口(stud)：> 平地最大跳距 10.6，跳不过去
  maxLen: 6,                     // 单段竖井最多吃掉几级
  every: [6, 10],                // 每隔多少级安排一段
  chance: 0.8,                   // 到了间隔点上有多大概率真的排
};

/** 多股骨架的口径 */
const STRANDS = {
  count: 3,                      // 股道数（≥2 才有真正的分叉 / 合流）
  junctionEvery: 5,              // 每多少级铺一圈交汇环台
  // 环台宽度（体素）：3 格 —— 换股道的弦会偏离圆周 R(1−cos(Δθ/2))，
  // 太窄时这条弦会踩出环台（换股道 / 区域旁路都会走出「悬空边」）。
  ringWidth: 3,
  rate: [0.15, 0.24, 0.10],      // 各股道在自辖扇区内的角速度（弧度/级）
  maxArc: 2.0,                   // 每级横向弧长上限（体素）→ 保证一跳够得到
};

/**
 * 一条股道的相位表：每级一项 { ang, emit, feat }（y 恒等于 yBot + level）。
 * @param o { steps, cell, sector, rate, base, rAt, isJunction }
 */
function planLane(lrng, o) {
  const { steps, sector, rate, rAt, isJunction } = o;
  const lo = o.base - sector / 2 + 0.12, hi = o.base + sector / 2 - 0.12;
  let ang = lrng.range(lo, hi);
  let dirn = lrng.chance(0.5) ? 1 : -1;
  /** 走一步：角速度取「本股速率」与「弧长上限」的较小者；触到扇区边界就反弹 */
  const step = (a, d, R) => {
    const st = Math.min(rate, STRANDS.maxArc / Math.max(1.5, R));
    let a2 = a + d * st, d2 = d;
    if (a2 > hi) { a2 = clamp(hi - (a2 - hi), lo, hi); d2 = -1; }
    else if (a2 < lo) { a2 = clamp(lo + (lo - a2), lo, hi); d2 = 1; }
    return { ang: a2, dirn: d2 };
  };

  const out = [];
  let L = 0;
  let nextFeat = lrng.int(FEATURE.every[0], FEATURE.every[1]);
  while (L < steps) {
    const nj = (Math.floor(L / STRANDS.junctionEvery) + 1) * STRANDS.junctionEvery;   // 下一个交汇层
    if (L >= nextFeat && !isJunction(L) && nj - L >= 4 && lrng.chance(FEATURE.chance)) {
      const kind = lrng.chance(0.5) ? 'riser' : 'chasm';
      if (kind === 'riser') {
        const len = Math.min(clamp(Math.ceil(FEATURE.riseStud / o.cell), 3, FEATURE.maxLen), nj - L - 1);
        if (len >= 3) {
          for (let i = 0; i < len - 1; i++) out.push({ ang, emit: false, feat: null });
          out.push({ ang, emit: true, feat: 'riser' });                 // 竖井顶：阶梯被拿掉了
          L += len;
          nextFeat = L + lrng.int(FEATURE.every[0], FEATURE.every[1]);
          continue;
        }
      } else {
        // 裂谷：**一级之内**横跨过去（中间不落台，只有滑索 / 游泳过得去）
        const R = Math.max(2, rAt(L + 1));
        const target = FEATURE.gapStud / o.cell;                        // 目标缺口（体素）
        const dA = Math.min(hi - lo, Math.max(0.24, target / R));
        const p1 = o.at(L, ang);
        let a2 = ang + dirn * dA, d2 = dirn;
        /* ★ 撞到扇区边界就**掉头**走，而不是「反弹折回」：
           反弹会把角度差折掉一半（实测只剩 0.7 rad ≈ 3 格），
           再减掉两块台面的支撑半径，边到边缺口就只剩 0~2 stud ——
           机制段模板要求 zip ≥4 / swim ≥5 stud，于是直接拒绝摆件，
           主轴就地卡死（这就是「跑酷路线被堵死」）。 */
        if (a2 > hi || a2 < lo) { d2 = -dirn; a2 = ang + d2 * dA; }
        if (a2 > hi) a2 = hi; else if (a2 < lo) a2 = lo;
        const p2 = o.at(L, a2);
        /* ★ 缺口按**取整后的格子**算，并且要留出两块台面的支撑半径：
           支撑半径 ≈ 1.4×cellS，两块就是 2.8×cellS；要凑够 dist ≥ 5 stud，
           cell=4 时中心距必须 ≥ 5 格。不够就退回普通台阶（宁可不做裂谷，也不能卡死）。 */
        const advCells = Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.z - p1.z));
        if (advCells >= 5) {
          out.push({ ang: a2, emit: true, feat: 'chasm' });
          ang = a2; dirn = d2; L += 1;
          nextFeat = L + lrng.int(FEATURE.every[0], FEATURE.every[1]);
          continue;
        }
      }
    }
    out.push({ ang, emit: true, feat: null });
    const s = step(ang, dirn, rAt(L));
    ang = s.ang; dirn = s.dirn;
    L += 1;
  }
  return out;
}

/** 按相位表铺一条股道的几何（越界自动裁；保护带照旧） */
function paveLane(g, plan, o) {
  const { yBot, fp, clearUp, at, mark } = o;
  const nodes = [];
  let prev = null;
  for (let L = 0; L < plan.length; L++) {
    const st = plan[L];
    const y = yBot + L;
    if (y + clearUp >= g.ny) break;
    if (!st.emit) continue;                          // 特技段中间：不落台（通道由端点那一段挖通）
    const p = at(L, st.ang);
    const x0 = clamp(p.x, 1, g.nx - 2 - fp);
    const z0 = clamp(p.z, 1, g.nz - 2 - fp);

    /* 与上一级之间：正常段清一条 fp 宽的缓坡通道；特技段清一整段竖井 / 裂谷 */
    if (prev) {
      if (st.feat === 'riser') {
        for (let yy = prev.y + 1; yy <= y + clearUp; yy++) {
          clearBoxIdx(g, x0 - 2, yy, z0 - 2, x0 + fp + 1, yy, z0 + fp + 1);
          protectBox(g, x0 - 2, yy, z0 - 2, x0 + fp + 1, yy, z0 + fp + 1);
        }
      } else if (st.feat === 'chasm') {
        const yLo = Math.min(prev.y, y) - 2;
        const yHi = Math.max(prev.y, y) + clearUp + 2;
        carvePath(g, prev.x0, prev.z0, x0, z0, yLo, yHi, fp);
        for (let yy = yLo; yy <= yHi + 1; yy++) {
          for (const q of [prev, { x0, z0 }]) {
            clearBoxIdx(g, q.x0 - 1, yy, q.z0 - 1, q.x0 + fp, yy, q.z0 + fp);
            protectBox(g, q.x0 - 1, yy, q.z0 - 1, q.x0 + fp, yy, q.z0 + fp);
          }
        }
        fillBoxIdx(g, prev.x0, prev.y, prev.z0, prev.x0 + fp - 1, prev.y, prev.z0 + fp - 1, MAT.ledge);
      } else {
        carvePath(g, prev.x0, prev.z0, x0, z0, y, y + clearUp, fp);
      }
    }
    clearBoxIdx(g, x0, y, z0, x0 + fp - 1, y + clearUp, z0 + fp - 1);
    fillBoxIdx(g, x0, y, z0, x0 + fp - 1, y, z0 + fp - 1, MAT.ledge);
    protectBox(g, x0, y, z0, x0 + fp - 1, y + clearUp, z0 + fp - 1);

    const from = prev;
    prev = { x0, z0, y, feat: st.feat };
    nodes.push({
      x: round(cellCenterX(g, x0) + (fp - 1) * g.cell / 2, 3),
      y: round(g.oy + (y + 1) * g.cell, 3),                 // 站立面 = 台阶顶面
      z: round(cellCenterZ(g, z0) + (fp - 1) * g.cell / 2, 3),
      cell: g.cell,
      level: L,
      strand: mark,
      feat: st.feat || null,
      vx: x0, vz: z0, vy: y,
      dCells: from ? Math.max(Math.abs(x0 - from.x0), Math.abs(z0 - from.z0), Math.abs(y - from.y)) : 0,
      dyCells: from ? y - from.y : 0,
    });
  }
  return nodes;
}

/** 交汇环台：在这一级圆周上铺一圈可行走的台面（把各股道连起来） */
function layRing(g, cx, cz, R, y, clearUp) {
  if (y + clearUp >= g.ny) return;
  const hw = STRANDS.ringWidth / 2;
  const ri = Math.ceil(R + hw) + 1;
  const x0 = Math.max(1, Math.floor(cx - ri)), x1 = Math.min(g.nx - 2, Math.ceil(cx + ri));
  const z0 = Math.max(1, Math.floor(cz - ri)), z1 = Math.min(g.nz - 2, Math.ceil(cz + ri));
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d < R - hw - 0.4 || d > R + hw + 0.4) continue;
      clearSolid(g, x, y, z);                          // 环台是**挖出来的走道**：先清再铺
      setSolid(g, x, y, z, MAT.ledge);
      clearBoxIdx(g, x, y + 1, z, x, y + clearUp, z);
      protectBox(g, x, y, z, x, y + clearUp, z);
    }
  }
}

/**
 * 骨架总装：N 条股道 + 交汇环台。
 * @returns { chain, strands, junctions }
 *   chain      第一条股道的节点（与旧口径兼容：出生点 / 终点 / 报告都用它）
 *   strands    [[node...], ...] 每条股道按级排列（交汇层上各股各有一块踏板，都在环台上）
 *   junctions  [{ level, y, radius }] 交汇环台
 */
function climbStrands(g, wt, rng, cell) {
  const yBot = 1;
  const yTop = clamp(cyOf(g, wt.bands[wt.bands.length - 1].y1) - 1, 1, g.ny - 2);
  const steps = Math.max(10, yTop - yBot);
  const cx = (g.nx - 1) / 2, cz = (g.nz - 1) / 2;
  /* ★ 塔只爬到「可用半径」的一半 —— 外面那一圈留给横向区域（districtPass）。
     旧版塔直接顶到格子边缘，于是世界上除了塔再放不下别的体量。 */
  const rTop = Math.max(7, Math.min(g.nx, g.nz) / 2 - 3);
  const rMax = Math.max(5, rTop * TOWER.radiusFrac);
  /* ★ 起始半径不能太小：半径 < 5 格时，扇区内的弧长不足以跨出「裂谷」那个缺口
     （36 stud ≈ 7~9 格），机制段就摆不下。5 格是最小的可用半径。 */
  const R0 = Math.max(5, rMax * 0.45);
  const dR = (rMax - R0) / steps;
  const dir = rng.sign();
  const a0 = rng.range(0, Math.PI * 2);
  const fp = CHAIN.footprint;
  const clearUp = CHAIN.clearUp;
  const rAt = (L) => R0 + clamp(L, 0, steps) * dR;
  const at = (L, ang) => ({
    x: Math.round(cx + Math.cos(ang) * rAt(L)),
    z: Math.round(cz + Math.sin(ang) * rAt(L)),
  });
  const isJ = (L) => L > 0 && L < steps && L % STRANDS.junctionEvery === 0;

  if (!g.protect) g.protect = new Uint8Array(g.n);
  const n = clamp(STRANDS.count, 1, 4);
  const sector = (Math.PI * 2) / n;
  const strands = [];
  for (let s = 0; s < n; s++) {
    const lrng = rng.fork(`lane${s}`);
    const plan = planLane(lrng, {
      steps, cell, sector, rAt, at, isJunction: isJ,
      rate: STRANDS.rate[s % STRANDS.rate.length],
      base: a0 + dir * s * sector,
    });
    strands.push(paveLane(g, plan, { yBot, fp, clearUp, cell, at, mark: s }));
  }

  const junctions = [];
  for (let L = STRANDS.junctionEvery; L < steps; L += STRANDS.junctionEvery) {
    const R = rAt(L);
    if (R < 2.5) continue;
    layRing(g, cx, cz, R, yBot + L, clearUp);
    junctions.push({
      level: L, y: round(g.oy + (yBot + L + 1) * g.cell, 3),
      radius: round(R, 2),
    });
  }
  return {
    chain: strands[0] || [], strands, junctions,
    // 给「横向区域」用的塔坐标（cx/cz 是格坐标的中心，半径一律以**格**为单位）
    // wx/wz = 同一中心的世界坐标：route.js 沿环台走圆弧时要绕着它转
    axis: {
      cx, cz, yBot, steps, rTop, rMax, R0, dR, rAt, a0, dir,
      wx: round(g.ox + (cx + 0.5) * g.cell, 3),
      wz: round(g.oz + (cz + 0.5) * g.cell, 3),
    },
  };
}

/* ============================================================
   ⑥ 横向区域（「世界不再只是一根塔」）
   ------------------------------------------------------------
   攀登骨架是**一根居中的塔**；外面这一圈按角扇区切成 3 个**区域**
   （街区 / 洞厅 / 台地 / 看台…），每个区域是一整片可站地台 + 2~3 件结构件
   （world/themes/pieces.js 的智能匹配件），再用**连桥**接到塔的交汇环台上。

   ★ 于是拓扑从「一条塔」变成「塔（中枢）+ 一圈区域」：
     区域是体量、是空间、是可选路线，而不是装饰。
   ★ 关键的两个几何口径：
     ① 区域地台比环台**低 deckDrop 格** —— 不同高度就不会在观测层并成
        一块「跨世界的巨型 pad」（那会让解析判定算出一堆假边）；
        1 格的落差又是合法的一步（跳 / 落都成立），连通性不受影响。
     ② 连桥从环台**外侧**起步（半径 R+gapCells 之外），只往区域方向铺，
        绝不清理环台/股道上方的净空。
   ============================================================ */
function districtPass(g, wt, rng, cell, skel, difficulty) {
  const { cx, cz, yBot, rTop, rMax, rAt } = skel.axis;
  const js = (skel.junctions || []).slice().sort((a, b) => a.level - b.level);
  if (js.length < 2) return [];
  const rc0 = Math.max(Math.round(rMax) + REGION.gapCells, Math.round(rTop * REGION.inner));
  const rc1 = Math.min(Math.round(rTop * REGION.outer), Math.floor(rTop));
  if (rc1 - rc0 + 1 < REGION.minCells) return [];
  const arcHalf = clamp(Math.round((rc1 - rc0 + 1) * 0.6), 2, 7);   // 切向半宽（格）
  const n = clamp(REGION.count, 2, 4);
  const tiers = wt.bands.length >= 5 ? clamp(REGION.tiers, 1, 2) : 1;
  const clearUp = CHAIN.clearUp;
  const regions = [];

  for (let t = 0; t < tiers; t++) {
    const jIx = clamp(Math.round(((t + 1) / (tiers + 1)) * (js.length - 1)), 0, js.length - 1);
    const j = js[jIx];
    const L = j.level;
    const yDeck = yBot + L - REGION.deckDrop;              // 地台（比环台低一格）
    if (yDeck < 2 || yDeck + clearUp + 2 >= g.ny) continue;
    const rRing = Number(j.radius) || rAt(L);
    const base = skel.axis.a0 + (t % 2) * (Math.PI / n);

    for (let k = 0; k < n; k++) {
      const ang = base + k * (Math.PI * 2 / n) + rng.range(-0.05, 0.05);
      const patch = [];
      const ri = Math.ceil(rc1) + 1;
      const x0 = Math.max(1, Math.floor(cx - ri)), x1 = Math.min(g.nx - 2, Math.ceil(cx + ri));
      const z0 = Math.max(1, Math.floor(cz - ri)), z1 = Math.min(g.nz - 2, Math.ceil(cz + ri));
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx, dz = z - cz;
          const d = Math.hypot(dx, dz);
          if (d < rc0 - 0.5 || d > rc1 + 0.5) continue;
          if (Math.abs(angDiff(ang, Math.atan2(dz, dx))) * d > arcHalf) continue;
          if (g.protect && g.protect[cix(g, x, yDeck, z)]) continue;   // 骨架净空不许填
          setSolid(g, x, yDeck, z, MAT.slab);              // 地台面
          setSolid(g, x, yDeck - 1, z, MAT.block);         // 地台底
          clearBoxIdx(g, x, yDeck + 1, z, x, yDeck + clearUp, z);
          protectBox(g, x, yDeck, z, x, yDeck + clearUp, z);
          patch.push({ x, z });
        }
      }
      if (patch.length < REGION.minCells * 2) continue;

      /* 连桥：从环台外侧沿半径铺到区域（同高、2×2 一组 → 连续可走） */
      const rad0 = rRing + REGION.gapCells;
      const nStep = Math.max(1, Math.ceil(rc0 - rad0));
      for (let i = 0; i <= nStep; i++) {
        const r = rad0 + (rc0 - rad0) * (i / nStep);
        const px = Math.round(cx + Math.cos(ang) * r);
        const pz = Math.round(cz + Math.sin(ang) * r);
        for (let dz = 0; dz <= 1; dz++) {
          for (let dx = 0; dx <= 1; dx++) {
            const bx = px + dx, bz = pz + dz;
            if (g.protect && g.protect[cix(g, bx, yDeck, bz)]) continue;   // 骨架净空不许填
            setSolid(g, bx, yDeck, bz, MAT.ledge);
            clearBoxIdx(g, bx, yDeck + 1, bz, bx, yDeck + clearUp, bz);
            protectBox(g, bx, yDeck, bz, bx, yDeck + clearUp, bz);
          }
        }
      }

      /* 结构件：按「风格 → 外壳 → 难度 → 体积」匹配，保证至少一件竖向 + 一件横向 */
      const band = bandOfWorldY(wt, yDeck, g);
      const box = { w: Math.min(arcHalf * 2, rc1 - rc0 + 1), h: clearUp, d: Math.min(arcHalf * 2, rc1 - rc0 + 1) };
      const pc = clamp(rng.int(REGION.pieces[0], REGION.pieces[1]), 1, 4);
      const chosen = pickPieces({
        style: wt.style, shell: band.key, openness: band.shell.openness,
        difficulty, box, rng, count: pc,
      });
      const placed = [];
      for (const entry of chosen) {
        const w = clamp(entry.def.size[0], 2, box.w + 1);
        const h = clamp(entry.def.size[1], 2, box.h);
        const d = clamp(entry.def.size[2], 2, box.d + 1);
        /* 件的盒子只往 +x/+z 长，锚点选在环带内缘时会一路长到塔的交汇环台上
           （在环台那一层加实体 → 把换股道的走道堵死）。唯一必须守的是**内侧半径**：
           在盒子上取 9 个采样点（4 角 + 4 边中点 + 心），都不许比 `rc0 - 0.5` 更靠内。
           往外 / 往角向溢出无所谓（那一片本来就是空的）。 */
        const safeBox = (x0, z0, x1, z1) => {
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          const pts = [[x0, z0], [x1, z0], [x0, z1], [x1, z1],
            [mx, z0], [mx, z1], [x0, mz], [x1, mz], [mx, mz]];
          for (const [px, pz] of pts) if (Math.hypot(px - cx, pz - cz) < rc0 - 0.5) return false;
          return true;
        };
        let b = null;
        for (let a = 0; a < 12 && !b; a++) {
          const cand = patch[rng.int(0, patch.length - 1)];
          const cx1 = Math.min(g.nx - 3, cand.x + w - 1), cz1 = Math.min(g.nz - 3, cand.z + d - 1);
          if (!safeBox(cand.x, cand.z, cx1, cz1)) continue;
          b = { x0: cand.x, y0: yDeck + 1, z0: cand.z, x1: cx1, y1: yDeck + h, z1: cz1 };
        }
        if (!b) continue;
        const st = stampPiece(g, entry, b, rng.fork(`piece${t}_${k}_${entry.id}`));
        if (st) placed.push(st);
        protectBox(g, b.x0, b.y0, b.z0, b.x1, b.y1 + 2, b.z1);
      }
      /* 航点链：环台落点（上行一格）→ 连桥 → 地台中心。
         交给 route.js 把区域接成一条**可选旁路**（逐段验证 + 失败整段回滚）。 */
      const chain = [];
      const rp = Math.round(cx + Math.cos(ang) * rRing);
      const rz = Math.round(cz + Math.sin(ang) * rRing);
      chain.push({
        x: round(g.ox + (rp + 0.5) * g.cell, 3),
        y: round(g.oy + (yBot + L + 1) * g.cell, 3),          // 环台顶面
        z: round(g.oz + (rz + 0.5) * g.cell, 3),
      });
      const radEnd = Math.min(rc1, (rc0 + rc1) / 2 + 1);
      for (let r = rad0; r <= radEnd + 1e-6; r += 1.5) {
        const px = Math.round(cx + Math.cos(ang) * r);
        const pz = Math.round(cz + Math.sin(ang) * r);
        chain.push({
          x: round(g.ox + (px + 0.5) * g.cell, 3),
          y: round(g.oy + (yDeck + 1) * g.cell, 3),           // 地台顶面
          z: round(g.oz + (pz + 0.5) * g.cell, 3),
        });
      }

      regions.push({
        tier: t, ang: round(ang, 3), level: L, deckY: round(g.oy + (yDeck + 1) * g.cell, 3),
        radius: round(rRing, 2), inner: rc0, outer: rc1,
        cells: patch.length, band: band.i, pieces: placed, chain,
      });
    }
  }
  return regions;
}

/* ============================================================
   体量里的结构件（天台 / 平台 / 台地）
   ------------------------------------------------------------
   每个体量内部有一堆**台面**（带地板、梯田顶、天台、壁架层…）。
   这里从体量底面往上每 3 级扫一次，找「本层实心 + 上方 5 格净空 + 成片」
   的锚点片区，按 风格 → 外壳 → 难度 → 体积 匹配结构件摆上去。
   ★ 于是 24 种结构件真的出现在成品里（而不是只写在库里）；
   ★ 不许压到骨架净空（`g.protect`），也不许越出体量的平面轮廓。
   ============================================================ */
function massTopPieces(g, wt, rng, cell, difficulty, masses) {
  const placed = [];
  for (const m of masses || []) {
    const cap = clamp(rng.int(MASS.pieces[0], MASS.pieces[1]) + 1, 1, 4);
    let used = 0;
    for (let y = m.y0 + 2; y <= m.y1 - 1 && used < cap; y += 3) {
      const anchors = [];
      for (let z = m.z0; z <= m.z1; z++) {
        for (let x = m.x0; x <= m.x1; x++) {
          if (!g.occ[cix(g, x, y, z)]) continue;                 // 本层要实心（脚下站得住）
          if (g.protect && g.protect[cix(g, x, y + 1, z)]) continue;   // 不压骨架净空
          let free = true;
          for (let k = 1; k <= 5; k++) {
            if (!inGrid(g, x, y + k, z) || g.occ[cix(g, x, y + k, z)]) { free = false; break; }
          }
          if (free) anchors.push({ x, z });
        }
      }
      if (anchors.length < 8) continue;                          // 要成片，不能是孤零零一格
      const band = bandOfWorldY(wt, y, g);
      const box = {
        w: Math.min(9, m.x1 - m.x0 + 1), d: Math.min(9, m.z1 - m.z0 + 1), h: 5,
      };
      const chosen = pickPieces({
        style: wt.style, shell: band.key, openness: band.shell.openness,
        difficulty, box, rng, count: 1,
      });
      for (const entry of chosen) {
        const w = clamp(entry.def.size[0], 2, box.w);
        const d = clamp(entry.def.size[2], 2, box.d);
        const h = clamp(entry.def.size[1], 2, box.h);
        const a = anchors[rng.int(0, anchors.length - 1)];
        const b = {
          x0: a.x, y0: y + 1, z0: a.z,
          x1: Math.min(m.x1, a.x + w - 1), y1: y + h, z1: Math.min(m.z1, a.z + d - 1),
        };
        let ok = true;
        for (let yy = b.y0; yy <= b.y1 && ok; yy++) {
          for (let z = b.z0; z <= b.z1 && ok; z++) {
            for (let x = b.x0; x <= b.x1 && ok; x++) {
              if (g.protect && g.protect[cix(g, x, yy, z)]) ok = false;   // 整个盒子都不许压骨架
            }
          }
        }
        if (!ok) continue;
        const st = stampPiece(g, entry, b, rng.fork(`mt${m.i}_${y}_${entry.id}`));
        if (st) { placed.push({ ...st, mass: m.i, y: round(g.oy + (y + 1) * g.cell, 3) }); used++; }
        protectBox(g, b.x0, b.y0, b.z0, b.x1, b.y1 + 2, b.z1);
      }
    }
  }
  return placed;
}

/** 这一层（格坐标）落在世界的哪一条带 */
function bandOfWorldY(wt, cy, g) {
  const wy = g.oy + cy * g.cell;
  for (const b of wt.bands) if (wy >= b.y0 && wy <= b.y1) return b;
  return wt.bands[wt.bands.length - 1];
}

/** 角度差归一到 [-π, π] */
function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 末道保险：把攀登骨架每一级重铺 + 重新保护（口径与 paveLane 一致） */
function resecureSpine(g, strands) {
  if (!g.protect) g.protect = new Uint8Array(g.n);
  const fp = CHAIN.footprint, clearUp = CHAIN.clearUp;
  for (const lane of strands || []) {
    for (const n of lane || []) {
      if (!Number.isFinite(n.vx) || !Number.isFinite(n.vy) || !Number.isFinite(n.vz)) continue;
      const x1 = Math.min(g.nx - 2, n.vx + fp - 1);
      const z1 = Math.min(g.nz - 2, n.vz + fp - 1);
      if (x1 < n.vx || z1 < n.vz) continue;
      if (n.vy + clearUp >= g.ny) continue;
      clearBoxIdx(g, n.vx, n.vy, n.vz, x1, n.vy + clearUp, z1);
      fillBoxIdx(g, n.vx, n.vy, n.vz, x1, n.vy, z1, MAT.ledge);   // 重铺这一级台阶
      protectBox(g, n.vx, n.vy, n.vz, x1, n.vy + clearUp, z1);
    }
  }
}

/** 把一整块标进保护带（演化 / 壁架都不许碰） */
function protectBox(g, x0, y0, z0, x1, y1, z1) {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (inGrid(g, x, y, z)) g.protect[cix(g, x, y, z)] = 1;
      }
    }
  }
}

/* ============================================================
   ② 壁架 / 岛台：把可用落脚面铺满
   ------------------------------------------------------------
   规则（保证净空）：同一列上下 3 个体素之内不许叠第二块。
   分布：贴墙的壁架（挑檐 / 岩台）+ 少量内部岛台。
   越开阔的带越稀疏（留出大空间），越幽闭的带越密（贴壁的层级感）。
   ============================================================ */
function ledgePass(c) {
  const { g, reg, band, cell, rng } = c;
  const openness = clamp(Number(band.shell.openness) || 0.5, 0, 1);
  const density = clamp(0.55 - openness * 0.3, 0.15, 0.6);
  const step = Math.max(1, Math.round(champ(14, 20, cell) / cell));   // 壁架层间距（≥14 stud）
  const depth = rng.int(1, 2);

  for (let y = reg.y0 + 1; y <= reg.y1 - 1; y += step) {
    // --- 贴墙壁架：四边各随机铺一段 ---
    for (const side of [0, 1, 2, 3]) {
      if (!rng.chance(density + 0.25)) continue;
      const len = rng.int(2, Math.max(3, Math.floor((reg.x1 - reg.x0) * 0.6)));
      const off = rng.int(0, Math.max(0, (side < 2 ? reg.x1 - reg.x0 : reg.z1 - reg.z0) - len));
      for (let i = 0; i < len; i++) {
        const a = side < 2 ? reg.x0 + off + i : reg.z0 + off + i;
        for (let d = 0; d < depth; d++) {
          const cxy = side === 0 ? [a, reg.z0 + d] : side === 1 ? [a, reg.z1 - d]
            : side === 2 ? [reg.x0 + d, a] : [reg.x1 - d, a];
          placeLedge(g, cxy[0], y, cxy[1]);
        }
      }
    }
    // --- 内部岛台：稀疏，给「绕一步」的空间 ---
    if (rng.chance(density)) {
      const n = rng.int(1, 2);
      for (let i = 0; i < n; i++) {
        const w = rng.int(1, 2);
        const x = rng.int(reg.x0 + 1, reg.x1 - 1 - w);
        const z = rng.int(reg.z0 + 1, reg.z1 - 1 - w);
        for (let dx = 0; dx <= w; dx++) {
          for (let dz = 0; dz <= w; dz++) placeLedge(g, x + dx, y, z + dz);
        }
      }
    }
  }
}

/** 放一块壁架：上方 4 格要有净空、且与下方 4 格内已有的壁架不重叠（两条都为了「站得住」）
    ★ 净空口径：玩家站在壁架顶面，头顶可用高度 = 上方自由体素数 × cell，
      必须 ≥ reach.minCeiling（≈14.89）+ 余量；cell 5/6 下 4 格 = 20/24 stud。 */
function placeLedge(g, x, y, z) {
  if (!inGrid(g, x, y, z)) return;
  if (g.protect && g.protect[cix(g, x, y, z)]) return;
  for (let dy = 1; dy <= 4; dy++) {
    if (inGrid(g, x, y + dy, z) && g.occ[cix(g, x, y + dy, z)]) return;   // 头顶净空
    const j = cix(g, x, y - dy, z);
    if (inGrid(g, x, y - dy, z) && g.occ[j] && g.mat[j] === MAT.ledge) return; // 不叠壁架
  }
  setSolid(g, x, y, z, MAT.ledge);
}

function champ(lo, hi, v) { return clamp(Number(v) || lo, lo, hi); }

/* ============================================================
   体素 → 世界块（8 个数字一组，交给 world/index.js 上色与落盘）
   ============================================================ */
export function boxList(world) {
  const g = world.grid;
  return world.boxes.map((b) => {
    const sx = b.w * g.cell, sy = b.h * g.cell, sz = b.d * g.cell;
    const cx = g.ox + (b.x + b.w / 2) * g.cell;
    const cy = g.oy + (b.y + b.h / 2) * g.cell;
    const cz = g.oz + (b.z + b.d / 2) * g.cell;
    return {
      mat: b.m, x: round(cx, 3), y: round(cy, 3), z: round(cz, 3),
      sx: round(sx, 3), sy: round(sy, 3), sz: round(sz, 3),
      top: round(cy + sy / 2, 3),
    };
  });
}

export function worldSummary(world) {
  if (!world) return null;
  return {
    cell: world.cell,
    tries: world.tries,
    cells: world.grid.n,
    solidCells: world.stats.solid,
    massRatio: round(world.stats.massRatio, 3),
    boxes: world.boxes.length,
    chainSteps: (world.chain || []).length,
    strandCount: (world.strands || []).length,
    strandSteps: (world.strands || []).map((s) => s.length),
    junctions: (world.junctions || []).length,
    // ★ 多体结构：体量个数 / 各自的顶面高度（「世界是几个体量，不是一根火柴盒」的读数）
    masses: (world.masses || []).length,
    massTops: [...new Set((world.masses || []).map((m) => Math.round(m.y1)))].sort((a, b) => a - b),
    topPieces: (world.topPieces || []).length,
    topPieceIds: [...new Set((world.topPieces || []).map((p) => p.id))],
    // ★ 塔外的横向区域 + 每个区域用到的结构件（「世界不再只是一根塔」的读数）
    regions: (world.regions || []).length,
    regionTiers: [...new Set((world.regions || []).map((r) => r.tier))].length,
    regionPieces: (world.regions || []).reduce((a, r) => a + (r.pieces || []).length, 0),
    pieceIds: [...new Set((world.regions || []).flatMap((r) => (r.pieces || []).map((p) => p.id)))],
    topY: world.topY,
    box: world.bounds,
    ms: world.ms,
  };
}

export { cloneGrid, hashSeed, makeRng, gridStats, mergeBoxes, cyOf, cxOf, czOf, pieceCatalog };