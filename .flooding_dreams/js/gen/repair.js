/* ============================================================
   程序化生成 · L4 修复层（搜索核心 + NavGraph 证明）
   ------------------------------------------------------------
   闭环：
     规划 → 实例化 → 解析自检（便宜） → NavGraph 全局证明（贵）
   任一关不过就换个种子重来（等价于「段内重采样」），并且每失败一次
   就把缺口比例收紧一点（越往后越保守）。

   纯计算的那一半在 search.js（可在 Worker 里跑）；这里只负责把
   **NavGraph 证明**这一层叠上去（它要 three 的射线，只能在主线程）。

   三级门槛，语义分开：
     · 解析自检不过          → 这一跳数学上就够不到，换种子
     · 净爬升 ≤ 0            → 不是「往上逃」的图，换种子
     · NavGraph 判定走不通    → 几何真的挡住了，换种子
     · NavGraph 采样没覆盖    → 不算失败，如实记成 unproven
       （strict 模式下才当失败处理）
   ============================================================ */
import { searchCore } from './search.js';
import { navProve } from './navcheck.js';

/** navMode: 'off' 只做解析自检 | 'try' 尽力证明（默认）| 'strict' 必须全部证明 */
export function generateVerified(opts = {}) {
  const navMode = opts.navMode === 'off' || opts.navMode === 'strict' ? opts.navMode : 'try';

  const r = searchCore(opts, {
    check: (rec, entry) => {
      if (navMode === 'off') return true;
      const nav = navProve(rec.realized, rec.plan.P, opts.nav || {});
      rec.nav = nav;
      entry.nav = { ok: nav.ok, blocked: nav.blocked, unproven: nav.unproven, truncated: nav.truncated, ms: nav.ms };
      if (!nav.ok) entry.navReason = nav.reason;
      const navBlocked = nav.blocked > 0;
      const navStrictFail = navMode === 'strict' && !nav.ok;
      return !navBlocked && !navStrictFail;
    },
  });

  const nav = r.nav || null;
  return {
    ...r,
    navMode,
    navProven: !!(nav && nav.ok),
  };
}
