/* ============================================================
   渲染通道协议（主线程 ↔ 渲染 Worker 共享常量）
   ------------------------------------------------------------
   消息分两类：
     · 结构通道（低频）：init / scene（场景快照）/ textures / resize / quality / screen / env
     · 热通道（每帧）：frame（相机 + 动态对象矩阵 + 少量标量）
   所有对象/几何/材质/贴图均以 three 自带的 uuid 作跨线程 id，避免额外的映射表。
   ============================================================ */

export const MSG = {
  // 主线程 → Worker
  INIT: 'init',
  RESIZE: 'resize',
  QUALITY: 'quality',
  SCREEN: 'screen',
  ENV: 'env',
  SCENE: 'scene',
  TEXTURES: 'textures',
  FRAME: 'frame',
  ATTR: 'attr',            // 几何属性热更新（粒子位置 / 颜色 / 尺寸…）
  MUNIFORM: 'muniform',    // 材质 uniform 热更新（数值 / 向量 / 颜色 / 矩阵；不含贴图）
  TEX: 'tex',              // 贴图内容热更新（图集扩容等，uuid 不变）
  ADD: 'add',              // 运行时新增对象（投掷物 / 生成的物体）
  REMOVE: 'remove',        // 运行时移除对象
  RENDER: 'render',        // 渲染子系统描述（雾对象 / 玻璃 / 泡沫 / 遮挡 / 反射捕获）
  VIEWPORT: 'viewport',    // 视口矩形（编辑器 / 大厅分屏）
  CLEAR: 'clear',
  DISPOSE: 'dispose',
  // Worker → 主线程
  READY: 'ready',
  ERROR: 'error',
  STATS: 'stats',
  LOST: 'lost',
};

/** 场景节点种类（worker 侧据此用对应构造函数重建） */
export const KIND = {
  GROUP: 'group',
  MESH: 'mesh',
  INSTANCED: 'instanced',
  POINTS: 'points',
  LINE: 'line',
  LINE_SEGMENTS: 'lineSegments',
  LINE_LOOP: 'lineLoop',
  SPRITE: 'sprite',
  SKINNED: 'skinned',
  BONE: 'bone',
  LIGHT: 'light',
};

/** 每个热对象在 Float32Array 里占 16 个 matrixWorld 分量（uuid 走并行 ids 数组） */
export const HOT_STRIDE = 16;

/** 高帧率下统计回传节流（毫秒） */
export const STATS_INTERVAL = 500;
