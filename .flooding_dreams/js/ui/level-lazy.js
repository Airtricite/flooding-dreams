/* ============================================================
   惰性关卡：列表只用元数据（剥掉全量 data）渲染；
   真正需要完整关卡（开始 / 编辑 / 导出）时才按需读单条 + 规范化。
   ------------------------------------------------------------
   为什么要惰性：Worker 不能 import world/level.js（裸 three 在 Worker 里无法解析），
   所以 normalizeLevel 只能在主线程做；列表就不该对每条记录都做一遍。
   ============================================================ */
import { store } from '../core/storage.js';
import { normalizeLevel } from '../world/level.js';

/** 给条目挂上惰性 loader（幂等；已有完整 level 则跳过） */
export function installLazyLevel(entry) {
  if (!entry || entry._levelP || entry.level) return entry;
  entry._levelP = (async () => {
    let data = null;
    if (entry.rec && entry.rec.data) data = entry.rec.data;
    else {
      const rec = await store.getLevel(entry.id);
      data = rec && rec.data;
    }
    if (!data) return null;
    const lv = normalizeLevel(data);
    lv.id = entry.id;           // 存档 id 为准（与节点地图既有约定一致）
    entry.level = lv;
    return lv;
  })();
  return entry;
}

/** 取条目的完整关卡对象（内置/自定义直接命中；用户关卡按需读盘规范化） */
export async function ensureEntryLevel(entry) {
  if (!entry) return null;
  if (entry.level) return entry.level;
  installLazyLevel(entry);
  return entry._levelP || null;
}