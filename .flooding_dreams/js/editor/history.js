/* ============================================================
   编辑器历史：快照式撤销 / 重做（带内存上限） + 复制粘贴
   ============================================================ */
import { EDITOR } from '../config.js';
import { deepClone, uid } from '../core/util.js';
import { getObject, childrenOf } from '../world/level.js';

export class History {
  constructor(opts = {}) {
    this.limit = opts.limit || EDITOR.undoLimit;
    this.maxBytes = opts.maxBytes || EDITOR.maxUndoBytes;
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
    this.onChange = null;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : ''; }
  get redoLabel() { return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : ''; }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.bytes = 0;
    this._changed();
  }

  /** 记录一步：prev 是操作发生【之前】的快照 */
  record(label, prev) {
    if (!prev) return;
    this.undoStack.push({ label: label || '编辑', json: prev, size: prev.length });
    this.bytes += prev.length;
    // 新操作会截断重做链
    for (const r of this.redoStack) this.bytes -= r.size;
    this.redoStack.length = 0;
    this._trim();
    this._changed();
  }

  /** 撤销：返回要恢复的快照 JSON（cur 为当前状态，用于重做） */
  undo(cur) {
    if (!this.undoStack.length) return null;
    const e = this.undoStack.pop();
    this.bytes -= e.size;
    if (cur) {
      this.redoStack.push({ label: e.label, json: cur, size: cur.length });
      this.bytes += cur.length;
    }
    this._changed();
    return e.json;
  }

  redo(cur) {
    if (!this.redoStack.length) return null;
    const e = this.redoStack.pop();
    this.bytes -= e.size;
    if (cur) {
      this.undoStack.push({ label: e.label, json: cur, size: cur.length });
      this.bytes += cur.length;
    }
    this._changed();
    return e.json;
  }

  _trim() {
    while (this.undoStack.length > this.limit || (this.bytes > this.maxBytes && this.undoStack.length > 1)) {
      const e = this.undoStack.shift();
      if (!e) break;
      this.bytes -= e.size;
    }
  }

  _changed() { if (this.onChange) this.onChange(this); }
}

/* ============================================================
   复制 / 粘贴
   ============================================================ */
export function copyObjects(level, ids) {
  const out = [];
  const seen = new Set();
  const walk = (id) => {
    if (!id || seen.has(id)) return;
    const o = getObject(level, id);
    if (!o) return;
    seen.add(id);
    out.push(deepClone(o));
    for (const c of childrenOf(level, id)) walk(c.id);
  };
  for (const id of ids || []) walk(id);
  if (!out.length) return null;
  const idSet = new Set(out.map((o) => o.id));
  const paints = (level.paints || []).filter((p) => idSet.has(p.objectId)).map((p) => deepClone(p));
  return { objects: out, paints };
}

/** 粘贴；parentId 用于把剪贴板里的顶层对象挂到指定编组下 */
export function pasteObjects(level, payload, offset = [0, 0, 0], parentId = null) {
  if (!payload || !payload.objects || !payload.objects.length) return [];
  const map = new Map();
  const copies = payload.objects.map((o) => {
    const c = deepClone(o);
    c.id = uid(o.type.slice(0, 2));
    map.set(o.id, c.id);
    return c;
  });
  for (const c of copies) {
    if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent);
    else c.parent = parentId || null;
    if (Array.isArray(c.position)) {
      c.position = [
        (Number(c.position[0]) || 0) + offset[0],
        (Number(c.position[1]) || 0) + offset[1],
        (Number(c.position[2]) || 0) + offset[2],
      ];
    }
    level.objects.push(c);
  }
  for (const p of payload.paints || []) {
    if (map.has(p.objectId)) level.paints.push({ ...deepClone(p), objectId: map.get(p.objectId) });
  }
  return copies;
}