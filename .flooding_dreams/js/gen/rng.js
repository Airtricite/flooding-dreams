/* ============================================================
   程序化生成 · 种子随机
   ------------------------------------------------------------
   所有随机都必须走这里：同 seed + 同参数 → 逐字节相同的关卡。
   生成器内部禁止直接调用 Math.random()（util.uid 也不行，
   它带了 Date.now 与 Math.random，所以对象 id 用 makeIdGen 生成）。
   ============================================================ */

/** 字符串 → uint32（FNV-1a）；null / undefined 也能稳定得到一个种子 */
export function hashSeed(s) {
  const str = String(s == null ? '' : s);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：32 位状态、分布够好、实现极小 */
export function makeRng(seed) {
  let a = (typeof seed === 'number' ? Math.floor(seed) : hashSeed(seed)) >>> 0;

  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng = {
    seed: a,
    next,
    /** [lo, hi) 浮点 */
    range: (lo, hi) => lo + (hi - lo) * next(),
    /** [lo, hi] 整数（含两端） */
    int: (lo, hi) => lo + Math.floor((hi - lo + 1) * next()),
    pick: (arr) => arr[Math.min(arr.length - 1, Math.floor(next() * arr.length))],
    chance: (p) => next() < p,
    sign: () => (next() < 0.5 ? -1 : 1),
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = out[i]; out[i] = out[j]; out[j] = t;
      }
      return out;
    },
    /** 按权重取一项：pairs = [[value, weight], ...]；权重全为 0 时取第一项 */
    weighted(pairs) {
      let total = 0;
      for (const p of pairs) total += Math.max(0, p[1] || 0);
      if (!(total > 0)) return pairs.length ? pairs[0][0] : undefined;
      let r = next() * total;
      for (const p of pairs) {
        r -= Math.max(0, p[1] || 0);
        if (r <= 0) return p[0];
      }
      return pairs[pairs.length - 1][0];
    },
    /** 派生独立的子随机流（同一 tag 结果稳定复现，互不干扰主序列） */
    fork: (tag) => makeRng(hashSeed(a + '|' + tag)),
  };

  return rng;
}

/**
 * 确定性 id 生成器。
 * 项目里 util.uid 依赖 Date.now / Math.random，会导致同 seed 生成不同 JSON，
 * 所以生成器自己发号（仍然只用 rng，保证可复现）。
 */
export function makeIdGen(rng) {
  let n = 0;
  return (prefix = 'g') => `${prefix}${(n++).toString(36)}${rng.int(0, 1295).toString(36)}`;
}
