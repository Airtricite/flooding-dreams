/* ============================================================
   主题白模 · 结构件库（PIECES）+ 智能匹配（pickPieces）
   ------------------------------------------------------------
   旧版的主题 PCG 是「一条带一个整体文法」——带回的体量是**一大坨**，
   读起来大同小异，也说不清「这里到底是什么地方」。

   这一层把世界拆成**可拼装的结构件**（拱廊、天桥、柱厅、螺旋梯、梯田、
   环形看台、栈道、深井、废墟拱门、广场、街区方阵、悬索桥、传送竖井…），
   每个件自带语义标签：

     id / label    结构名（报告与编辑器里直接读）
     styles[]      适用风格（草原 / 城市 / 荧渊 / 阈限；null = 通用）
     shells[]      适用外壳（indoor…openAir；null = 通用）
     vertical      是否提供**竖向连通**（能把人往上带）
     lateral       是否提供**横向连通**（能把两处连起来）
     size[w,h,d]   推荐占地（体素）—— 用来判断「这块地方放得下吗」
     build(c)      往 c 指定的盒子里直接写体素（只画不判，和主题 PCG 同口径）

   ★「智能匹配」落在 pickPieces：按 风格 → 外壳 → 难度 → 可用体积 逐层过滤，
     再保证「每区至少 1 件竖向连通件、多区域时至少 1 件横向连通件」——
     于是世界不是随机堆件，而是**按当前结构带的空间性格选件拼装**。
   ★ 所有件都只画「不挡头顶」的体量：真正站人的是区域的地台与桥面，
     件只往外侧长 —— 保证观测层（observe.js）仍能把台面认成 pad。
   ============================================================ */
import { MAT, plate, solid, carve, column, blob } from './common.js';

/* ============================================================
   结构件注册表（24 件）
   ============================================================ */
export const PIECES = [
  /* ---------- 横向连通件（多区域连桥的素材） ---------- */
  {
    id: 'skybridge', label: '天桥', lateral: true, vertical: false,
    styles: ['city', 'building', 'meadow'], shells: null, minDiff: 1, size: [7, 3, 2],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const y = Math.min(y1, y0 + 2);
      plate(g, x0, z0, x1, z1, y, MAT.ledge);                 // 桥面（占满，可走）
      column(g, x0, z0, y0, y - 1, MAT.col);                  // 两端桥墩
      column(g, x1, z1, y0, y - 1, MAT.col);
      column(g, x0, z0, y + 1, y + 1, MAT.wall);              // 栏杆柱
      column(g, x1, z1, y + 1, y + 1, MAT.wall);
    },
  },
  {
    id: 'arcade', label: '拱廊', lateral: true, vertical: false,
    styles: ['city', 'building'], shells: ['indoor', 'sheltered', 'outdoor'], minDiff: 1, size: [8, 5, 4],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const top = Math.min(y1, y0 + 4);
      for (let x = x0; x <= x1; x += 2) {                     // 两列柱
        column(g, x, z0, y0, top - 1, MAT.col);
        column(g, x, z1, y0, top - 1, MAT.col);
      }
      plate(g, x0, z0, x1, z1, top, MAT.roof);
      for (let x = x0 + 1; x <= x1 - 1; x += 3) carve(g, x, top, z0 + 1, x, top, z1 - 1);   // 拱洞
    },
  },
  {
    id: 'twinLink', label: '双塔连廊', lateral: true, vertical: true,
    styles: ['city'], shells: null, minDiff: 1, size: [7, 6, 4],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const mid = Math.min(y1 - 2, y0 + 3);
      // 两端的塔
      solid(g, x0, y0, z0, Math.min(x1, x0 + 1), Math.min(y1, y0 + 5), Math.min(z1, z0 + 1), MAT.block);
      solid(g, Math.max(x0, x1 - 1), y0, Math.max(z0, z1 - 1), x1, Math.min(y1, y0 + 5), z1, MAT.block);
      plate(g, x0 + 2, z0, x1 - 2, z1, mid, MAT.ledge);       // 连廊（可走）
      for (let x = x0 + 2; x <= x1 - 2; x += 2) column(g, x, z1, mid + 1, mid + 1, MAT.wall);
    },
  },
  {
    id: 'ringStand', label: '环形看台', lateral: true, vertical: true,
    styles: ['city', 'building'], shells: null, minDiff: 2, size: [7, 4, 7],
    build(c) {
      const { g, rng, x0, y0, z0, x1, y1, z1 } = c;
      const mid = Math.min(y1, y0 + 3);
      // 一圈台阶式看台（半径逐层收）
      for (let k = 0; k < 3; k++) {
        const y = y0 + k;
        const ix0 = x0 + k, ix1 = x1 - k, iz0 = z0 + k, iz1 = z1 - k;
        if (ix0 > ix1 || iz0 > iz1) break;
        plate(g, ix0, iz0, ix1, iz0, y, MAT.ledge);
        plate(g, ix0, iz1, ix1, iz1, y, MAT.ledge);
        plate(g, ix0, iz0, ix0, iz1, y, MAT.ledge);
        plate(g, ix1, iz0, ix1, iz1, y, MAT.ledge);
      }
      plate(g, x0 + 3, z0 + 3, Math.max(x0 + 3, x1 - 3), Math.max(z0 + 3, z1 - 3), mid, MAT.ledge);
      if (rng.chance(0.5)) column(g, Math.round((x0 + x1) / 2), Math.round((z0 + z1) / 2), mid, mid + 1, MAT.col);
    },
  },
  {
    id: 'boardwalk', label: '栈道', lateral: true, vertical: false,
    styles: ['meadow', 'city', 'rock'], shells: null, minDiff: 1, size: [9, 3, 2],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const y = Math.min(y1, y0 + 1);
      plate(g, x0, z0, x1, z1, y, MAT.ledge);
      for (let x = x0; x <= x1; x += 3) column(g, x, z0, y0, y - 1, MAT.col);
    },
  },
  {
    id: 'cliffLedge', label: '悬崖壁架', lateral: true, vertical: false,
    styles: ['rock'], shells: null, minDiff: 1, size: [6, 3, 3],
    build(c) {
      const { g, rng, x0, y0, z0, x1, y1, z1 } = c;
      const y = Math.min(y1, y0 + rng.int(1, 2));
      for (let z = z0; z <= z1; z++) {                        // 一层层往外挑的岩台
        const w = rng.int(1, 2);
        plate(g, x0, z, Math.min(x1, x0 + w + (z - z0)), z, y, MAT.ledge);
      }
    },
  },
  {
    id: 'ruinArch', label: '废墟拱门', lateral: true, vertical: true,
    styles: ['meadow', 'building', 'rock'], shells: null, minDiff: 1, size: [6, 5, 2],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const top = Math.min(y1, y0 + 4);
      for (let y = y0; y <= top - 2; y++) {                   // 两侧残柱
        solid(g, x0, y, z0, Math.min(x1, x0 + 1), y, z1, MAT.block);
        solid(g, Math.max(x0, x1 - 1), y, z0, x1, y, z1, MAT.block);
      }
      plate(g, x0, z0, x1, z1, top, MAT.roof);                // 门楣
      carve(g, x0 + 2, top - 1, z0, Math.max(x0 + 2, x1 - 2), top - 1, z1);   // 门洞
    },
  },
  {
    id: 'foyer', label: '门厅套间', lateral: true, vertical: true,
    styles: ['building'], shells: ['indoor', 'sheltered'], minDiff: 1, size: [8, 5, 7],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const my = Math.round((z0 + z1) / 2);
      for (let y = y0 + 1; y <= Math.min(y1, y0 + 3); y++) {  // 一道内墙带门洞
        for (let x = x0; x <= x1; x++) {
          if (x % 3 === (x0 % 3)) continue;                   // 门
          plate(g, x, my, x, my, y, MAT.wall);
        }
      }
      plate(g, x0, z0, x1, z1, Math.min(y1, y0 + 4), MAT.roof);
    },
  },
  {
    id: 'plaza', label: '广场', lateral: true, vertical: false,
    styles: ['city', 'building', 'meadow'], shells: null, minDiff: 1, size: [9, 2, 9],
    build(c) {
      const { g, rng, x0, y0, z0, x1, y1, z1 } = c;
      plate(g, x0, z0, x1, z1, y0, MAT.slab);                 // 铺装
      for (let z = z0 + 1; z <= z1 - 1; z += 3) {             // 树池 / 灯座（零散但很少）
        for (let x = x0 + 1; x <= x1 - 1; x += 3) {
          if (!rng.chance(0.4)) continue;
          column(g, x, z, y0 + 1, y0 + 1, MAT.col);
        }
      }
      plate(g, x0, z0, x1, z0, Math.min(y1, y0 + 1), MAT.ledge);   // 一侧看台
    },
  },
  {
    id: 'aqueduct', label: '高架渠', lateral: true, vertical: true,
    styles: ['city', 'building'], shells: null, minDiff: 3, size: [9, 6, 3],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const top = Math.min(y1, y0 + 5);
      plate(g, x0, z0, x1, z1, top, MAT.ledge);               // 渠顶走道
      for (const z of [z0, z1]) {                             // 两侧连续拱券
        for (let x = x0; x <= x1; x++) column(g, x, z, top - 1, top - 1, MAT.roof);
      }
      for (let x = x0; x <= x1; x += 3) {                     // 落地墩
        column(g, x, Math.round((z0 + z1) / 2), y0, top - 2, MAT.col);
      }
      plate(g, x0, z0, x1, z1, top - 2, MAT.roof);
    },
  },
  {
    id: 'ropeBridge', label: '悬索桥', lateral: true, vertical: false,
    styles: ['meadow', 'rock', 'city'], shells: null, minDiff: 3, size: [10, 3, 2],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const y = Math.min(y1, y0 + 2);
      const mz = Math.round((z0 + z1) / 2);
      plate(g, x0, mz, x1, mz, y, MAT.ledge);                 // 桥面
      for (let x = x0; x <= x1; x++) {                        // 两侧拉索（悬链近似）
        const t = (x - x0) / Math.max(1, x1 - x0);
        const sag = Math.round(1 + (1 - Math.sin(t * Math.PI)) * 1.5);
        column(g, x, z0, y + sag, y + sag, MAT.wall);
      }
      column(g, x0, z0, y0, y + 2, MAT.col);
      column(g, x1, z1, y0, y + 2, MAT.col);
    },
  },
  {
    id: 'cascade', label: '瀑布台阶', lateral: true, vertical: true,
    styles: ['meadow', 'rock'], shells: null, minDiff: 1, size: [6, 5, 4],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const n = Math.min(4, Math.max(2, y1 - y0));
      for (let k = 0; k < n; k++) {                           // 一级级往外跌的台阶
        const y = Math.min(y1, y0 + k);
        const zz = Math.min(z1, z0 + k);
        plate(g, x0, zz, x1, zz, y, MAT.ledge);
      }
      plate(g, x0, z0, x1, z1, y0 - 1, MAT.block);            // 水底
    },
  },

  /* ---------- 竖向连通件（把区域往上带） ---------- */
  {
    id: 'spiralStair', label: '螺旋梯', lateral: false, vertical: true,
    styles: ['building', 'city', 'rock'], shells: null, minDiff: 1, size: [5, 5, 5],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const cx = Math.round((x0 + x1) / 2), cz = Math.round((z0 + z1) / 2);
      const cx0 = Math.max(x0, cx - 1), cx1 = Math.min(x1, cx + 1);
      const cz0 = Math.max(z0, cz - 1), cz1 = Math.min(z1, cz + 1);
      const top = y1;
      for (let y = y0; y <= top; y++) {
        const k = (y - y0) % 4;
        if (k === 0) plate(g, cx0, cz0, cx1, cz0, y, MAT.ledge);
        else if (k === 1) plate(g, cx1, cz0, cx1, cz1, y, MAT.ledge);
        else if (k === 2) plate(g, cx0, cz1, cx1, cz1, y, MAT.ledge);
        else plate(g, cx0, cz0, cx0, cz1, y, MAT.ledge);
        column(g, cx, cz, y, y, MAT.col);                     // 中柱
      }
      plate(g, cx0, cz0, cx1, cz1, top, MAT.ledge);           // 顶平台
    },
  },
  {
    id: 'terrace', label: '梯田', lateral: true, vertical: true,
    styles: ['meadow', 'rock'], shells: null, minDiff: 1, size: [7, 4, 6],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const n = Math.min(3, Math.max(2, y1 - y0));
      for (let k = 0; k < n; k++) {                           // 退台式田埂
        const y = Math.min(y1, y0 + k);
        const ix1 = Math.max(x0, x1 - k);
        plate(g, x0, z0, ix1, z1, y, MAT.ledge);
        for (let z = z0; z <= z1; z++) column(g, ix1, z, y - 1, y - 1, MAT.wall);   // 田埂
      }
    },
  },
  {
    id: 'colonnade', label: '柱厅', lateral: false, vertical: true,
    styles: ['building', 'city'], shells: null, minDiff: 1, size: [6, 5, 6],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const top = y1;
      for (let z = z0; z <= z1; z += 2) {
        for (let x = x0; x <= x1; x += 2) {
          column(g, x, z, y0, top - 1, MAT.col);
          if (((x + z) % 4) === 0) plate(g, Math.max(x0, x - 1), Math.max(z0, z - 1), Math.min(x1, x + 1), Math.min(z1, z + 1), y0 + 2, MAT.ledge);
        }
      }
      plate(g, x0, z0, x1, z1, top, MAT.roof);                // 柱顶横梁
    },
  },
  {
    id: 'pillarForest', label: '石柱林', lateral: false, vertical: true,
    styles: ['rock'], shells: null, minDiff: 1, size: [7, 6, 7],
    build(c) {
      const { g, rng, x0, y0, z0, x1, y1, z1 } = c;
      const top = y1;
      for (let z = z0; z <= z1; z += 2) {
        for (let x = x0; x <= x1; x += 2) {
          if (!rng.chance(0.62)) continue;
          const t = Math.min(y1, y0 + rng.int(2, Math.max(3, y1 - y0)));
          solid(g, x, y0, z, x, t, z, MAT.col);
          blob(g, x, t, z, 1.1, 0.9, 1.1, MAT.ledge);         // 柱头菌盖
        }
      }
    },
  },
  {
    id: 'dripDome', label: '钟乳穹顶', lateral: true, vertical: false,
    styles: ['rock'], shells: null, minDiff: 1, size: [8, 5, 8],
    build(c) {
      const { g, rng, x0, y0, z0, x1, y1, z1 } = c;
      const cy = y1;
      const cx = Math.round((x0 + x1) / 2), cz = Math.round((z0 + z1) / 2);
      plate(g, x0, z0, x1, z1, cy, MAT.roof);                 // 穹顶
      for (let z = z0 + 1; z <= z1 - 1; z += 2) {             // 垂下的钟乳
        for (let x = x0 + 1; x <= x1 - 1; x += 2) {
          if (Math.hypot(x - cx, z - cz) > (x1 - x0) * 0.42) continue;
          if (!rng.chance(0.5)) continue;
          column(g, x, z, cy - rng.int(1, 2), cy - 1, MAT.block);
        }
      }
      for (let k = 0; k < Math.min(3, y1 - y0); k++) {        // 中央石笋
        plate(g, cx - k, cz - k, cx + k, cz + k, y0 + k, MAT.block);
      }
    },
  },
  {
    id: 'deepWell', label: '深井', lateral: false, vertical: true,
    styles: ['rock', 'building'], shells: ['shaft', 'cavern', 'indoor'], minDiff: 1, size: [5, 6, 5],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const ix0 = x0 + 1, ix1 = x1 - 1, iz0 = z0 + 1, iz1 = z1 - 1;
      for (let y = y0; y <= y1; y++) {                        // 井壁（三面，留一口）
        plate(g, x0, iz0, x0, iz1, y, MAT.wall);
        plate(g, x1, iz0, x1, iz1, y, MAT.wall);
        plate(g, ix0, z1, ix1, z1, y, MAT.wall);
        if ((y - y0) % 2 === 0) plate(g, ix0, iz0, ix1, iz1, y, MAT.ledge);   // 井内旋梯
      }
    },
  },
  {
    id: 'liftShaft', label: '传送竖井', lateral: false, vertical: true,
    styles: ['building', 'city'], shells: null, minDiff: 2, size: [4, 7, 4],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      for (let y = y0; y <= y1; y++) {                        // 井道框
        plate(g, x0, z0, x0, z1, y, MAT.wall);
        plate(g, x1, z0, x1, z1, y, MAT.wall);
        plate(g, x0, z0, x1, z0, y, MAT.wall);
        plate(g, x0, z1, x1, z1, y, MAT.wall);
      }
      plate(g, x0, z0, x1, z1, y0, MAT.ledge);                // 井底
      plate(g, x0, z0, x1, z1, y1, MAT.ledge);                // 井顶
      carve(g, x0 + 1, y0 + 1, z0, x1 - 1, Math.min(y1 - 1, y0 + 3), z0);        // 入口
      carve(g, x0, Math.max(y0 + 1, y1 - 3), z0 + 1, x0, y1 - 1, z1 - 1);        // 出口
    },
  },
  {
    id: 'blockGrid', label: '街区方阵', lateral: false, vertical: true,
    styles: ['city'], shells: null, minDiff: 1, size: [8, 5, 8],
    build(c) {
      const { g, rng, x0, y0, z0, x1, y1, z1 } = c;
      const lot = 3;
      for (let z = z0 + 1; z <= z1 - 1; z += lot) {
        for (let x = x0 + 1; x <= x1 - 1; x += lot) {
          const t = Math.min(y1, y0 + rng.int(1, Math.max(2, y1 - y0)));
          solid(g, x, y0, z, Math.min(x1 - 1, x + 1), t, Math.min(z1 - 1, z + 1), MAT.block);
          plate(g, Math.max(x0, x - 1), Math.max(z0, z - 1), Math.min(x1, x + 2), Math.min(z1, z + 2), t, MAT.roof);
        }
      }
    },
  },
  {
    id: 'podium', label: '塔基裙楼', lateral: true, vertical: true,
    styles: ['city'], shells: null, minDiff: 1, size: [7, 5, 7],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const n = Math.min(3, Math.max(2, y1 - y0));
      for (let k = 0; k < n; k++) {                           // 逐层退台的裙楼
        const y = Math.min(y1, y0 + k * 2);
        const ix0 = Math.min(x1, x0 + k), ix1 = Math.max(x0, x1 - k);
        const iz0 = Math.min(z1, z0 + k), iz1 = Math.max(z0, z1 - k);
        if (ix0 > ix1 || iz0 > iz1) break;
        solid(g, ix0, y, iz0, ix1, y, iz1, MAT.block);
        plate(g, ix0 - 1 < x0 ? x0 : ix0 - 1, iz0 - 1 < z0 ? z0 : iz0 - 1,
          ix1 + 1 > x1 ? x1 : ix1 + 1, iz1 + 1 > z1 ? z1 : iz1 + 1, y, MAT.roof);
      }
    },
  },
  {
    id: 'mesaSteps', label: '台地台阶', lateral: true, vertical: true,
    styles: ['meadow', 'rock'], shells: null, minDiff: 1, size: [7, 4, 5],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const n = Math.min(3, Math.max(2, y1 - y0));
      for (let k = 0; k < n; k++) {                           // 方山式台地
        const y = Math.min(y1, y0 + k * 2);
        const iz0 = Math.min(z1, z0 + k), iz1 = Math.max(z0, z1 - k);
        plate(g, x0, iz0, x1, iz1, y, MAT.ledge);
        plate(g, x0, iz0, x1, iz0, y - 1, MAT.wall);
      }
    },
  },
  {
    id: 'roofGarden', label: '屋顶花园', lateral: true, vertical: false,
    styles: ['city', 'building', 'meadow'], shells: null, minDiff: 1, size: [7, 4, 7],
    build(c) {
      const { g, rng, x0, y0, z0, x1, y1, z1 } = c;
      const y = Math.min(y1, y0 + 3);
      plate(g, x0, z0, x1, z1, y, MAT.slab);                  // 屋顶
      for (let k = 0; k < 3; k++) {                           // 花池 + 树
        const p = { x: rng.int(x0 + 1, Math.max(x0 + 1, x1 - 1)), z: rng.int(z0 + 1, Math.max(z0 + 1, z1 - 1)) };
        column(g, p.x, p.z, y + 1, y + 1, MAT.col);
        blob(g, p.x, y + 2, p.z, 1.1, 0.9, 1.1, MAT.ledge);
      }
    },
  },
  {
    id: 'lookout', label: '瞭望台', lateral: true, vertical: true,
    styles: ['meadow', 'city', 'rock'], shells: null, minDiff: 2, size: [5, 6, 5],
    build(c) {
      const { g, x0, y0, z0, x1, y1, z1 } = c;
      const top = y1;
      for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
        column(g, px, pz, y0, top - 1, MAT.col);
      }
      plate(g, x0, z0, x1, z1, top, MAT.ledge);               // 平台
      for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
        column(g, px, pz, top + 1, top + 1, MAT.wall);        // 栏杆
      }
    },
  },
];

/** id → 件（外部按 id 取用时不必遍历） */
export const PIECE_BY_ID = PIECES.reduce((m, p) => { m[p.id] = p; return m; }, {});

/* ============================================================
   智能匹配：给一块「区域场地」选出合适的一组结构件
   ------------------------------------------------------------
   ctx = { style, shell, openness, difficulty, box:{w,h,d}, rng, count }
   逐层过滤（风格 → 外壳 → 难度 → 体积），再保证结构上的两种连通性：
     · 至少 1 件 vertical（把区域往上带 —— 竖向连通）
     · 至少 1 件 lateral （把区域与别处连起来 —— 横向连通）
   返回 [{ id, label, vertical, lateral, def }]
   ============================================================ */
export function pickPieces(ctx = {}) {
  const {
    style, shell, difficulty = 3, rng,
    box = { w: 8, h: 5, d: 8 }, count = 3,
  } = ctx;
  const d = Math.max(1, Number(difficulty) || 1);
  const fits = (p) => p.size[0] <= box.w + 1 && p.size[1] <= box.h + 1 && p.size[2] <= box.d + 1;

  const byStyle = PIECES.filter((p) => fits(p) && (!p.styles || p.styles.includes(style)));
  const pool = byStyle.filter((p) => !p.shells || p.shells.includes(shell));
  let cand = pool.length ? pool : byStyle;
  if (!cand.length) cand = PIECES.filter(fits);
  const open = Math.max(0, Math.min(1, Number(ctx.openness) || 0.5));
  // 「是否存在显式声明」的件更贴主题，加分；体积越贴合场地越加分；开阔场地偏好横向件
  const score = (p) => {
    let s = 0;
    if (p.styles) s += 2;
    if (p.shells) s += 1;
    const area = box.w * box.d, pa = p.size[0] * p.size[2];
    s += 1.5 * (1 - Math.min(1, Math.abs(pa - area) / Math.max(1, area)));
    if (open > 0.6 && p.lateral) s += 0.6;
    if (open < 0.4 && p.vertical) s += 0.4;
    return s;
  };
  const picked = [];
  const take = (pred) => {
    const list = cand.filter(pred).filter((p) => !picked.includes(p));
    if (!list.length) return null;
    list.sort((a, b) => score(b) - score(a));
    const k = rng ? Math.min(list.length - 1, rng.int(0, Math.min(2, list.length - 1))) : 0;
    picked.push(list[k]);
    return list[k];
  };
  take((p) => p.vertical);              // ① 竖向连通件
  take((p) => p.lateral);               // ② 横向连通件
  const need = Math.max(1, Math.round(count));
  while (picked.length < need && take(() => true)) { /* ③ 补足 */ }
  return picked.map((p) => ({ id: p.id, label: p.label, vertical: !!p.vertical, lateral: !!p.lateral, def: p }));
}

/** 把一件结构件画进指定盒子；返回它的可读摘要 */
export function stampPiece(g, entry, box, rng) {
  const def = entry && entry.def;
  if (!def) return null;
  const x0 = box.x0, y0 = box.y0, z0 = box.z0;
  const x1 = Math.max(x0, box.x1), y1 = Math.max(y0, box.y1), z1 = Math.max(z0, box.z1);
  def.build({
    g, rng, x0, y0, z0, x1, y1, z1,
    w: x1 - x0 + 1, h: y1 - y0 + 1, d: z1 - z0 + 1, cell: g.cell,
  });
  return { id: def.id, label: def.label, vertical: !!def.vertical, lateral: !!def.lateral };
}

/** 报告 / UI 用：结构件总目录（按 id 排序，稳定输出） */
export function pieceCatalog() {
  return PIECES.map((p) => ({
    id: p.id, label: p.label,
    styles: p.styles || ['*'], shells: p.shells || ['*'],
    vertical: !!p.vertical, lateral: !!p.lateral, size: p.size.slice(),
  })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export { MAT };