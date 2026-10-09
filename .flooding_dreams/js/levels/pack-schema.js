/* ============================================================
   关卡包 · 纯数据结构层（零依赖，可被 Web Worker import）
   ------------------------------------------------------------
   从 packs.js 抽出的「不碰 store / i18n / DOM」的部分：
   结构定义、档位、规范化、视图过滤。
   packs.js 负责 I/O 与 i18n，并在其上再包一层保持既有 API 不变。
   ⚠ 本文件不得 import three / DOM / store / i18n。
   ============================================================ */
import { uid, clamp } from '../core/util.js';

export const MAX_STICKERS = 24;

/**
 * 难度档位：关卡包可按四档游玩，节点可选属于某一档。
 * 档位区间对应关卡难度：标准 1~3.99、高手 4~5.99、专家 6~6.99、Elite 7+（难度名 Nightmare+ 覆盖 7.0~9.99）。
 */
export const PACK_TIERS = [
  { v: 1, key: 'standard', label: 'Standard', zh: '标准', range: '1 ~ 3.99', min: 1, max: 3.999, color: '#7fe3ff' },
  { v: 2, key: 'skilled', label: 'Skilled', zh: '高手', range: '4 ~ 5.99', min: 4, max: 5.999, color: '#b0a0ff' },
  { v: 3, key: 'expert', label: 'Expert', zh: '专家', range: '6 ~ 6.99', min: 6, max: 6.999, color: '#ffd98a' },
  { v: 4, key: 'elite', label: 'Elite', zh: 'Elite', range: '7 ~ 9.99', min: 7, max: 99, color: '#ff6b8a' },
];

/** 档位定义（v 非法返回 null） */
export function tierDef(v) {
  return PACK_TIERS.find((t) => t.v === (Number(v) || 0)) || null;
}

/** 难度数值 → 档位（1~4） */
export function tierOfDiff(d) {
  const v = Number(d) || 0;
  for (const t of PACK_TIERS) if (v >= t.min && v <= t.max) return t.v;
  return v < 1 ? 1 : 4;
}

/** 档位取值归一化：非 1~4 一律视为 0（通用） */
function normTier(v) {
  const t = Math.round(Number(v) || 0);
  return t >= 1 && t <= 4 ? t : 0;
}

/** 包内被节点实际用到的档位（升序）；空数组表示这个包不分档 */
export function packTiers(pack) {
  const set = new Set();
  for (const n of (pack && pack.nodes) || []) {
    const t = normTier(n.tier);
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => a - b);
}

/** 定档：want 有效就用它，否则取包内最低存在档位；包内没有任何档位则为 0 */
export function resolveTier(pack, want) {
  const list = packTiers(pack);
  if (!list.length) return 0;
  const v = Number(want) || 0;
  return list.indexOf(v) >= 0 ? v : list[0];
}

/** 该节点在此档位是否出现（tier 0 的通用节点永远出现） */
export function nodeVisible(n, tier) {
  const t = normTier(n && n.tier);
  return !t || t === (Number(tier) || 0);
}

/** 按档位过滤出的节点与连线（地图渲染、解锁判定都用它，避免隐藏节点挡住解锁链） */
export function packView(pack, tier) {
  const nodes = ((pack && pack.nodes) || []).filter((n) => nodeVisible(n, tier));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = ((pack && pack.edges) || []).filter((e) => ids.has(e[0]) && ids.has(e[1]));
  return Object.assign({}, pack, { nodes, edges });
}

/**
 * 关卡包结构：
 * {
 *   id, name, author, description, unlockAll,
 *   nodes: [{ id, levelId, title, desc, x, y, color, diff, tier }],  // x/y 为 0~1 的归一化坐标
 *   edges: [[fromNodeId, toNodeId]],                                // from 通关后解锁 to
 *   stickers: [{ id, x, y, w, h, rot, src }],                       // 装饰贴纸（src 内嵌 dataURL）
 * }
 * color: '' 表示用主题默认色；diff: 0 表示难度跟随所绑定的关卡；
 * tier: 0 = 通用（任何档位都出现），1~4 = 只在该档位出现。
 */
export function createPack(over = {}, defaultName = '新关卡包') {
  return Object.assign({
    id: uid('pk'),
    name: defaultName,
    author: '',
    description: '',
    unlockAll: false,
    allowEdit: false,     // 是否允许其他玩家编辑（导入方据此决定只读/可编辑）
    imported: false,      // true = 由 .fdpack 导入得到（作者自己的包为 false）
    nodes: [],
    edges: [],
    stickers: [],
  }, over);
}

export function createNode(over = {}) {
  return Object.assign({
    id: uid('nd'),
    levelId: '',
    title: '',
    desc: '',
    x: 0.5,
    y: 0.5,
    color: '',
    diff: 0,
    tier: 0,
  }, over);
}

/** 修正缺失字段 / 越界坐标 */
export function normalizePack(p, defaultName = '新关卡包') {
  const pack = createPack(p || {}, defaultName);
  pack.nodes = (Array.isArray(pack.nodes) ? pack.nodes : []).filter((n) => n && n.id).map((n) => ({
    id: n.id,
    levelId: n.levelId || '',
    title: n.title || '',
    desc: n.desc || '',
    x: clamp(Number(n.x ?? 0.5) || 0, 0, 1),
    y: clamp(Number(n.y ?? 0.5) || 0, 0, 1),
    color: /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(n.color || '')) ? String(n.color).toLowerCase() : '',
    diff: clamp(Number(n.diff) || 0, 0, 6),
    tier: normTier(n.tier),
  }));
  const ids = new Set(pack.nodes.map((n) => n.id));
  pack.edges = (Array.isArray(pack.edges) ? pack.edges : [])
    .filter((e) => Array.isArray(e) && e.length === 2 && ids.has(e[0]) && ids.has(e[1]) && e[0] !== e[1]);
  // 贴纸：只保留自包含的图片 dataURL（否则导出后对方看不到）。保留原 id，避免每次保存都变。
  pack.stickers = (Array.isArray(pack.stickers) ? pack.stickers : [])
    .filter((s) => s && typeof s.src === 'string' && s.src.startsWith('data:image/'))
    .slice(0, MAX_STICKERS)
    .map((s) => ({
      id: s.id || uid('st'),
      x: clamp(Number(s.x ?? 0.5) || 0, 0, 1),
      y: clamp(Number(s.y ?? 0.5) || 0, 0, 1),
      w: clamp(Number(s.w ?? 0.2) || 0.2, 0.02, 1),
      h: clamp(Number(s.h ?? 0.2) || 0.2, 0.02, 1),
      rot: ((Number(s.rot) || 0) % 360 + 360) % 360,
      src: s.src,
    }));
  return pack;
}

export function nodeOf(pack, nodeId) {
  return ((pack && pack.nodes) || []).find((n) => n.id === nodeId) || null;
}

/** 某个节点的前驱（必须先通关才能解锁它） */
export function predecessors(pack, nodeId) {
  return ((pack && pack.edges) || []).filter((e) => e[1] === nodeId).map((e) => e[0]);
}

/**
 * 节点是否已解锁
 * @param cleared 已通关的关卡 id 集合（Set）
 * 规则：允许全部解锁 / 没有前驱（起始节点）/ 任一前驱所在关卡已通关
 */
export function isUnlocked(pack, node, cleared) {
  if (pack && pack.unlockAll) return true;
  const pre = predecessors(pack, node.id);
  if (!pre.length) return true;
  return pre.some((pid) => {
    const pn = nodeOf(pack, pid);
    return !!(pn && pn.levelId && cleared && cleared.has(pn.levelId));
  });
}

/** 节点所在关卡是否已通关 */
export function isCleared(node, cleared) {
  return !!(node && node.levelId && cleared && cleared.has(node.levelId));
}

/** 这个关卡包当前是否可编辑：作者自己的包永远可编辑；导入的包看作者是否放开 */
export function canEditPack(pack) {
  return !!(pack && (!pack.imported || pack.allowEdit));
}

/* ============================================================
   自动排布：按 edges 做分层（BFS），同层再纵向排开
   只在节点还没被手动摆过（或用户点「自动排布」）时使用
   ============================================================ */
export function autoLayout(pack) {
  const nodes = (pack && pack.nodes) || [];
  if (!nodes.length) return pack;
  const outs = new Map(nodes.map((n) => [n.id, []]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of pack.edges || []) {
    if (!outs.has(e[0]) || !indeg.has(e[1])) continue;
    outs.get(e[0]).push(e[1]);
    indeg.set(e[1], indeg.get(e[1]) + 1);
  }
  // 层号 = 最长路径长度（保证前驱一定在更靠前的层）
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  let frontier = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  if (!frontier.length) frontier = [nodes[0].id];       // 全是环时兜底
  const seen = new Set(frontier);
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const to of outs.get(id) || []) {
        layer.set(to, Math.max(layer.get(to), layer.get(id) + 1));
        if (!seen.has(to)) { seen.add(to); next.push(to); }
      }
    }
    frontier = next;
  }
  const byLayer = new Map();
  for (const n of nodes) {
    const l = layer.get(n.id) || 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(n);
  }
  const keys = [...byLayer.keys()].sort((a, b) => a - b);
  const maxL = Math.max(1, keys.length - 1);
  for (const l of keys) {
    const col = byLayer.get(l);
    col.forEach((n, i) => {
      n.x = keys.length === 1 ? 0.5 : 0.1 + (l / maxL) * 0.8;
      n.y = col.length === 1 ? 0.5 : 0.16 + (i / (col.length - 1)) * 0.68;
    });
  }
  return pack;
}