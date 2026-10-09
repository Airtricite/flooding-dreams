/* ============================================================
   玩家背包 / 工具栏逻辑
   ============================================================ */
import { TOOL_DEFS } from '../config.js';
import { uid } from '../core/util.js';

/** 两个「工具」是否算同一件（用于叠加数量）：作用目标ID列表也要一致 */
function sameTargets(a, b) {
  const x = a.targetIds || [], y = b.targetIds || [];
  if (x.length !== y.length) return false;
  return x.every((id) => y.includes(id));
}

export class Inventory {
  constructor(max = 9) {
    this.max = max;
    this.items = [];
    this.selected = 0;
    this.onChange = null;
  }

  add(item) {
    if (!item) return null;
    const same = this.items.find((i) => i.type === item.type && i.name === item.name
      && i.targetTag === item.targetTag && sameTargets(i, item));
    if (same && item.type !== 'key' && item.type !== 'custom') {
      same.count += item.count || 1;
      this.changed();
      return same;
    }
    if (same && item.type === 'key') {
      same.count += item.count || 1;
      this.changed();
      return same;
    }
    if (this.items.length >= this.max) {
      // 塞满时替换最后一个非关键工具
      const i = this.items.map((x, k) => [x, k]).filter(([x]) => x.type === 'custom').pop();
      if (i) this.items[i[1]] = { ...item, key: uid('tool') };
      else return null;
    } else {
      this.items.push({ ...item, key: item.key || uid('tool') });
    }
    if (this.items.length === 1) this.selected = 0;
    this.changed();
    return this.items[this.items.length - 1];
  }

  remove(type, all = true) {
    let removed = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].type !== type) continue;
      removed++;
      if (all || --this.items[i].count <= 0) this.items.splice(i, 1);
      if (!all) break;
    }
    if (removed) this.changed();
    return removed;
  }

  removeByKey(key) {
    const i = this.items.findIndex((x) => x.key === key);
    if (i < 0) return false;
    if (this.items[i].count > 1) this.items[i].count--;
    else this.items.splice(i, 1);
    this.clampSelect();
    this.changed();
    return true;
  }

  has(type) { return this.items.some((i) => i.type === type); }
  /** 背包中「同一工具」的持有总数（有来源ID按来源匹配，否则按类型+名称） */
  countOf(item) {
    if (!item) return 0;
    const sid = item.sourceId || '';
    return this.items.reduce((n, i) => {
      if (sid) return i.sourceId === sid ? n + (i.count || 1) : n;
      return (i.type === item.type && i.name === item.name) ? n + (i.count || 1) : n;
    }, 0);
  }
  /** 是否持有来自某个「工具对象」的物品（门可以指定具体钥匙对象） */
  hasSource(sourceId) {
    if (!sourceId) return false;
    return this.items.some((i) => i.sourceId === sourceId);
  }
  hasWithTarget(id) {
    return this.items.some((i) => (i.targetIds || []).includes(id));
  }
  get(type) { return this.items.find((i) => i.type === type) || null; }
  get current() { return this.items[this.selected] || null; }

  select(i) {
    if (i < 0 || i >= this.items.length) return false;
    this.selected = i;
    this.changed();
    return true;
  }
  /** 取消选择（手上不拿工具） */
  deselect() {
    if (this.selected < 0) return false;
    this.selected = -1;
    this.changed();
    return true;
  }
  cycle(dir) {
    if (!this.items.length) return false;
    this.selected = (this.selected + dir + this.items.length) % this.items.length;
    this.changed();
    return true;
  }
  clampSelect() {
    if (this.selected >= this.items.length) this.selected = Math.max(0, this.items.length - 1);
  }
  clear() { this.items.length = 0; this.selected = 0; this.changed(); }
  changed() { this.onChange && this.onChange(this); }

  /** 工具栏 UI 数据 */
  slots() {
    return this.items.map((i, k) => ({
      ...i,
      index: k,
      active: k === this.selected,
      def: TOOL_DEFS[i.type] || TOOL_DEFS.custom,
    }));
  }
}

export { TOOL_DEFS };