/* ============================================================
   世界结构 · 命名预设注册表
   ------------------------------------------------------------
   一个「命名结构」= 一套**主题专属的世界结构性格**：
     · ladder   该结构适用的世界结构阶梯（元素是 shell.js 的 6 个原子 key，
                按 shell 开阔度升序 —— 从最幽闭一路逃向最开阔）
     · rhythm   阶梯的铺法：rise = 一路向上；duplex = 两带一循环（室内↔露天）
     · dive     难度 1 时「往下探多深」的性格偏移（0~0.5）——
                越大越倾向从幽闭端起步（铁路 / 病栋 / 图书馆这类深埋的）；
                空中港 / 浮空岛这类本就在云上的趋近 0。
     · note     一句话说明「这个结构跟别的结构不同在哪」

   ★ 键 = 主题 id，与 world/themes/<id>.js 一一对应；
     ladder 与对应主题模块导出的 structures **逐项一致**（这里只是把它固化下来，
     供 UI 下拉 / 报告读取，不改主题白模的 build）。
   ★ 这里**不新增几何原子** —— 那 6 个 shell key 才是物理口径。
   ============================================================ */

export const WORLD_STRUCTURES = {
  crystalCavern: {
    id: 'crystalCavern',
    label: '水晶洞（竖井→洞穴→室内→半封闭→露天）',
    ladder: ['shaft', 'cavern', 'indoor', 'sheltered', 'outdoor'],
    rhythm: 'rise',
    dive: 0.4,
    note: '从地心晶核一路竖直掏到露天 —— 全项目唯一「竖井打头」的放射晶簇结构。',
  },
  volcanicRidge: {
    id: 'volcanicRidge',
    label: '火山脊（洞穴→半封闭→露天→开阔）',
    ladder: ['cavern', 'sheltered', 'outdoor', 'openAir'],
    rhythm: 'rise',
    dive: 0.25,
    note: '从火山口底绕同心台地向外扩张 —— 起点在洞里，终点是无顶的熔岩台地。',
  },
  skyIslands: {
    id: 'skyIslands',
    label: '浮空岛（半封闭→露天→开阔）',
    ladder: ['sheltered', 'outdoor', 'openAir'],
    rhythm: 'rise',
    dive: 0.05,
    note: '悬在半空的离散岛群，没有洞也没有井 —— 起始开阔度几乎最高。',
  },
  sunkenForest: {
    id: 'sunkenForest',
    label: '沉没森林（洞穴→半封闭→露天）',
    ladder: ['cavern', 'sheltered', 'outdoor'],
    rhythm: 'rise',
    dive: 0.3,
    note: '从半淹的树干阵爬到树冠网 —— 阶梯短，但每一档都带「水线」落差。',
  },
  glacierFjord: {
    id: 'glacierFjord',
    label: '冰川峡湾（竖井→洞穴→半封闭→露天→开阔）',
    ladder: ['shaft', 'cavern', 'sheltered', 'outdoor', 'openAir'],
    rhythm: 'rise',
    dive: 0.4,
    note: '深水航道两侧是之字形峡壁 —— 竖井与露天之间跨了整整四级，纵向拉伸最长。',
  },
  desertMesa: {
    id: 'desertMesa',
    label: '荒漠台地（洞穴→露天→开阔）',
    ladder: ['cavern', 'outdoor', 'openAir'],
    rhythm: 'rise',
    dive: 0.25,
    note: '从地缝里爬上台地 —— 阶梯里没有「有顶」的中间档，洞一步就跳到露天。',
  },
  swampMangrove: {
    id: 'swampMangrove',
    label: '沼泽红树（室内→半封闭→露天）',
    ladder: ['indoor', 'sheltered', 'outdoor'],
    rhythm: 'rise',
    dive: 0.3,
    note: '以「支柱根棚架」当室内 —— 起点不是洞穴而是矮顶林下，屋顶是活的。',
  },
  coralReef: {
    id: 'coralReef',
    label: '珊瑚礁（洞穴→室内→半封闭→露天）',
    ladder: ['cavern', 'indoor', 'sheltered', 'outdoor'],
    rhythm: 'rise',
    dive: 0.3,
    note: '从潟湖空腔钻过环礁 —— 洞穴之后接「室内」，把礁体内部也当房间用。',
  },
  rustedFoundry: {
    id: 'rustedFoundry',
    label: '锈蚀铸造厂（竖井→洞穴→室内→露天）',
    ladder: ['shaft', 'cavern', 'indoor', 'outdoor'],
    rhythm: 'rise',
    dive: 0.4,
    note: '高炉筒与熔炉坑当竖井与洞穴 —— 残缺的工业阶梯，从室内直通露天厂房外。',
  },
  subwayTerminus: {
    id: 'subwayTerminus',
    label: '地铁终点站（竖井→室内→半封闭）',
    ladder: ['shaft', 'indoor', 'sheltered'],
    rhythm: 'rise',
    dive: 0.5,
    note: '全线埋在隧道里，只到「半封闭」为止 —— 逃出去也看不到天，深埋感最强。',
  },
  neonArcade: {
    id: 'neonArcade',
    label: '霓虹街机厅（室内→半封闭→露天→开阔）',
    ladder: ['indoor', 'sheltered', 'outdoor', 'openAir'],
    rhythm: 'rise',
    dive: 0.28,
    note: '从机柜迷宫走到灯箱墙外的街区 —— 室内起步，却能一路开到露天灯牌下。',
  },
  serverVault: {
    id: 'serverVault',
    label: '服务器地窖（竖井→洞穴→室内）',
    ladder: ['shaft', 'cavern', 'indoor'],
    rhythm: 'rise',
    dive: 0.5,
    note: '星形机柜塔围着一口制冷深井 —— 阶梯短而全在地下，室内就是它的天花板。',
  },
  skyport: {
    id: 'skyport',
    label: '空中港（露天→开阔）',
    ladder: ['outdoor', 'openAir'],
    rhythm: 'rise',
    dive: 0.05,
    note: '只有两档、且都是无顶 —— 云上的停机坪，全程没有一处幽闭。',
  },
  hydroDam: {
    id: 'hydroDam',
    label: '水坝（洞穴→室内→半封闭→露天→开阔）',
    ladder: ['cavern', 'indoor', 'sheltered', 'outdoor', 'openAir'],
    rhythm: 'rise',
    dive: 0.35,
    note: '从坝底水垫顺着阶梯溢洪道走到坝顶 —— 五级齐全，纵向是被水冲出来的一条斜线。',
  },
  clockworkAtrium: {
    id: 'clockworkAtrium',
    label: '钟表中庭（室内→半封闭）',
    ladder: ['indoor', 'sheltered'],
    rhythm: 'rise',
    dive: 0.3,
    note: '只有室内与半封闭两档、全在楼里 —— 最短的阶梯，一圈环廊就登顶。',
  },
  mirrorGallery: {
    id: 'mirrorGallery',
    label: '镜廊（竖井→洞穴→室内→半封闭）',
    ladder: ['shaft', 'cavern', 'indoor', 'sheltered'],
    rhythm: 'rise',
    dive: 0.45,
    note: '两道平行镜墙把空间压成一条深廊 —— 起点是井，终点仍是封闭的镜室。',
  },
  hospitalWing: {
    id: 'hospitalWing',
    label: '废弃病栋（洞穴→室内）',
    ladder: ['cavern', 'indoor'],
    rhythm: 'rise',
    dive: 0.5,
    note: '只分「地下腔」与「病房层」两级 —— 阶梯最短最压抑，逃不出楼体。',
  },
  casinoFloor: {
    id: 'casinoFloor',
    label: '赌场楼层（竖井→室内→半封闭→露天）',
    ladder: ['shaft', 'indoor', 'sheltered', 'outdoor'],
    rhythm: 'rise',
    dive: 0.35,
    note: '中庭天井就是竖井 —— 一层层赌台玩上去，最后从半封闭走到露天看台。',
  },
  drownedLibrary: {
    id: 'drownedLibrary',
    label: '沉没图书馆（竖井→洞穴→半封闭）',
    ladder: ['shaft', 'cavern', 'sheltered'],
    rhythm: 'rise',
    dive: 0.45,
    note: '书架巷道自成一个洞穴，却跳过「室内」直接到半封闭 —— 越往上越像泡水的旧馆。',
  },
  cathedralNave: {
    id: 'cathedralNave',
    label: '大教堂中殿（竖井→室内→半封闭→露天→开阔）',
    ladder: ['shaft', 'indoor', 'sheltered', 'outdoor', 'openAir'],
    rhythm: 'rise',
    dive: 0.4,
    note: '巨柱间的一线天就是竖井 —— 从圣坛一路走到彩窗外的天光，阶梯最完整。',
  },
};

/** 命名结构：未知 id 返回 null（调用方负责兜底） */
export function structureOf(id) {
  return WORLD_STRUCTURES[id] || null;
}

/** 命名结构清单（稳定顺序：按声明次序）—— 报告 / UI 下拉读取 */
export function structureList() {
  return Object.values(WORLD_STRUCTURES);
}