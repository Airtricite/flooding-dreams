/* ============================================================
   程序化装饰 · 微件配方（概念 → 组合配方）
   ------------------------------------------------------------
   纪律与关卡层一致：**不新增引擎类型**，每个装饰概念都用现成类型拼出来。
   本轮（M2）全部是**零风险**件：`physicsMode:'none'`，
   因此可达性在数学上不可能被改变（M1 的证明口径原样成立）。

   ★ 性能纪律（刚踩过的坑）：
     · 一律 `bakeAO:false` —— 不做顶点 AO、立方体也不细分到 16 段；
     · 优先用**非立方体形状**（cone / prism / cylinder / sphere）：这些走
       共享缓存几何（`buildGeometry`），不像 block 那样每件独占一份几何；
     · 不用真实动态光源：需要发光就用 `emissive`（灯数计入 budget ≤ 6）。

   每个配方声明 `when`（主题关键词）与 `slots`（能落在哪种槽位），
   由 project.js 负责挑配方、定尺寸、定色并过硬约束。
   ============================================================ */
import { clamp, round } from '../../core/util.js';

/** 主题关键词 → 生物群系（决定挑哪些配方；确定性，不占随机流） */
export function biomeOf(theme) {
  const t = theme || {};
  const hay = [
    t.id, t.label,
    ...(Array.isArray(t.advMat) ? t.advMat : []),
    ...((t.motifs && t.motifs.macro) || []),
    ...((t.motifs && t.motifs.meso) || []),
    ...((t.motifs && t.motifs.micro) || []),
  ].join(' ');
  return hay;
}

/* ---------- 配方 ----------
   make(ctx) 返回「除 id / name 之外的 over」；ctx = { x,y,z,yaw,normal,panel,theme,rng,size,base } */
const R = (() => {
  const mesh = (shape, extra) => (ctx) => {
    const s = ctx.size;
    const sc = [
      round(extra.w * s, 3),
      round(extra.h * s, 3),
      round(extra.d * s, 3),
    ];
    const over = {
      shape,
      position: [round(ctx.x, 3), round(ctx.y, 3), round(ctx.z, 3)],
      rotation: [extra.rx || 0, round(ctx.rotY, 1), extra.rz || 0],
      scale: sc,
      color: extra.color(ctx),
      texture: extra.texture || 'none',
      roughness: extra.roughness === undefined ? 0.85 : extra.roughness,
      metalness: extra.metalness === undefined ? 0 : extra.metalness,
      transparency: extra.transparency || 0,
      emissive: !!extra.emissive,
      emissiveIntensity: extra.emissive ? (extra.emissiveIntensity || 1.2) : 0,
      physicsMode: 'none',
      bakeAO: false,
      castShadow: extra.castShadow !== false,
    };
    if (extra.sides && (shape === 'prism' || shape === 'cylinder' || shape === 'cone')) over.sides = extra.sides;
    return over;
  };

  const dark = (ctx, k) => mix(ctx.panel.main, '#000000', k);
  const light = (ctx, k) => mix(ctx.panel.main, ctx.panel.accent, k);

  return {
    /* 草丛：细长圆锥 —— 便宜、剪影清楚 */
    grassTuft: {
      id: 'grassTuft', label: '草丛', slots: ['floorDress'],
      when: /meadow|grass|field|grove|forest|lucid|草原|野|林|草/i,
      make: mesh('cone', {
        w: 1.1, h: 3.2, d: 1.1, sides: 5,
        color: (c) => light(c, 0.55), roughness: 0.95,
      }),
    },
    /* 芦苇：更高的锥，贴水/贴边 */
    reed: {
      id: 'reed', label: '芦苇', slots: ['waterline', 'floorDress'],
      when: /water|flood|swamp|marsh|湖|水|沼|潮/i,
      make: mesh('cone', {
        w: 0.7, h: 5.0, d: 0.7,
        color: (c) => light(c, 0.35), roughness: 0.95,
      }),
    },
    /* 发光菌菇：扁球 + 自发光（不用动态光） */
    mushroom: {
      id: 'mushroom', label: '发光菌菇', slots: ['floorDress'],
      when: /abyss|bio|glow|spore|fung|cave|cavern|荧|菌|孢|渊|洞/i,
      make: mesh('sphere', {
        w: 1.8, h: 0.9, d: 1.8,
        color: (c) => c.panel.accent, emissive: true, emissiveIntensity: 1.6, roughness: 0.5,
      }),
    },
    /* 晶簇：细高锥，自发光 */
    crystal: {
      id: 'crystal', label: '晶簇', slots: ['floorDress', 'wallMount'],
      when: /crystal|ice|cavern|abyss|quartz|晶|冰|洞/i,
      make: mesh('cone', {
        w: 1.0, h: 4.2, d: 1.0, sides: 6,
        color: (c) => light(c, 0.7), emissive: true, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.2,
      }),
    },
    /* 碎石块：多边形柱（共享几何） */
    rockChunk: {
      id: 'rockChunk', label: '碎石', slots: ['floorDress'],
      fallback: true,   // 任何主题都合理：通用兜底件
      when: /rock|stone|cave|cavern|ruin|meadow|city|岩|石|洞|遗迹|野|城市/i,
      make: mesh('prism', {
        w: 2.0, h: 1.3, d: 2.0, sides: 6,
        color: (c) => dark(c, 0.32), roughness: 0.98,
      }),
    },
    /* 钟乳石：倒挂的锥 */
    stalactite: {
      id: 'stalactite', label: '钟乳石', slots: ['ceilingHang'],
      when: /cave|cavern|rock|abyss|洞|岩|渊/i,
      make: mesh('cone', {
        w: 1.4, h: 4.6, d: 1.4, rx: 180, sides: 6,
        color: (c) => dark(c, 0.28), roughness: 0.98,
      }),
    },
    /* 残骸堆：扁平多边形柱 */
    debrisStack: {
      id: 'debrisStack', label: '残骸', slots: ['floorDress'],
      when: /city|urban|ruin|wreck|industrial|都市|城市|遗迹|废墟|工业/i,
      make: mesh('prism', {
        w: 3.4, h: 1.1, d: 2.6, sides: 5,
        color: (c) => light(c, 0.22), roughness: 0.9, metalness: 0.15,
      }),
    },
    /* 管道：横放的圆柱，壁挂 */
    pipeRun: {
      id: 'pipeRun', label: '管道', slots: ['wallMount'],
      when: /city|urban|industrial|hall|corridor|pipe|都市|工业|走廊|阈限/i,
      make: mesh('cylinder', {
        w: 0.9, h: 9.0, d: 0.9, rz: 90,
        color: (c) => light(c, 0.15), roughness: 0.6, metalness: 0.35,
      }),
    },
    /* 壁灯：小球 + 自发光（不占光源预算） */
    wallLamp: {
      id: 'wallLamp', label: '壁灯', slots: ['wallMount', 'ceilingHang'],
      fallback: true,   // 通用兜底件：哪里都能挂一盏灯
      when: /city|industrial|hall|corridor|room|temple|museum|都市|工业|走廊|室内|阈限|殿/i,
      make: mesh('sphere', {
        w: 1.5, h: 1.5, d: 1.5,
        color: (c) => c.theme.palette.glow || c.panel.accent,
        emissive: true, emissiveIntensity: 2.2, roughness: 0.4, castShadow: false,
      }),
    },
    /* 尖碑/断柱：楔形，荒野与废墟 */
    brokenPillar: {
      id: 'brokenPillar', label: '断柱', slots: ['floorDress'],
      when: /ruin|temple|hall|meadow|遗迹|阈限|殿|野/i,
      make: mesh('wedge', {
        w: 2.2, h: 5.5, d: 2.2,
        color: (c) => dark(c, 0.18), roughness: 0.9,
      }),
    },
    /* 漂浮薄板：贴水面的残骸 */
    floatPlate: {
      id: 'floatPlate', label: '漂浮残骸', slots: ['waterline'],
      when: /water|flood|swamp|湖|水|沼/i,
      make: mesh('prism', {
        w: 5.0, h: 0.5, d: 3.4, sides: 4,
        color: (c) => light(c, 0.28), roughness: 0.95,
      }),
    },
    /* 远景剪影：高塔 / 尖峰 */
    farTower: {
      id: 'farTower', label: '远景楼群', slots: ['farSilhouette'],
      when: /city|urban|industrial|都市|城市|工业/i,
      make: mesh('block', {
        w: 16, h: 90, d: 16,
        color: (c) => dark(c, 0.5), roughness: 1, castShadow: false,
      }),
    },
    farSpire: {
      id: 'farSpire', label: '远景峰', slots: ['farSilhouette'],
      fallback: true,
      when: /cave|cavern|rock|abyss|meadow|野|岩|洞/i,
      make: mesh('cone', {
        w: 26, h: 78, d: 26, sides: 6,
        color: (c) => dark(c, 0.42), roughness: 1, castShadow: false,
      }),
    },
  };
})();

export const PROP_LIST = Object.values(R);

/** 该槽位可用的配方：先按主题关键词过滤，没命中就用该槽位的「兜底件」 */
export function propsForSlot(slotKind, theme) {
  const hay = biomeOf(theme);
  const all = PROP_LIST.filter((p) => p.slots.includes(slotKind));
  const hit = all.filter((p) => p.when.test(hay));
  if (hit.length) return hit;
  const loose = all.filter((p) => p.fallback);
  return loose.length ? loose : all;
}

/** 粗估三角面（只用于报告与预算） */
export function trisOf(over) {
  const shape = (over && over.shape) || 'block';
  const sides = Math.max(3, Math.round(Number(over.sides) || 6));
  switch (shape) {
    case 'sphere': return 320;
    case 'cylinder': return sides * 6;
    case 'cone': return sides * 4;
    case 'prism': return sides * 4;
    case 'wedge': return 12;
    case 'torus': return 220;
    default: return 200;      // block：bakeAO:false → 4 段细分
  }
}

/* ---------- 小工具 ---------- */
function mix(a, b, t) {
  const A = hex(a), B = hex(b);
  const k = clamp(Number(t) || 0, 0, 1);
  return '#' + [0, 1, 2].map((i) => Math.round(A[i] + (B[i] - A[i]) * k).toString(16).padStart(2, '0')).join('');
}

function hex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
  const v = m ? parseInt(m[1], 16) : 0x808080;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
