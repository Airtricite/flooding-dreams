/* ============================================================
   Flooding Dreams — 全局常量与默认配置
   单位约定：1 世界单位 = 1 stud（Roblox 风格），重力 196.2 stud/s²
   ============================================================ */

export const APP = {
  name: 'Flooding Dreams',
  zh: '洪梦',
  version: '0.1.0',
  levelFormat: 'flooding-dreams-level',
  levelVersion: 1,
};

/* ---------- 物理 / 玩家数值（studs） ---------- */
export const PHYS = {
  gravity: 196.2,
  timeStep: 1 / 60,
  maxSubSteps: 4,
  solverIterations: 10,
  defaultMaterial: { friction: 0.42, restitution: 0.0 },
  iceMaterial: { friction: 0.02, restitution: 0.0 },
  bouncyMaterial: { friction: 0.4, restitution: 0.72 },
};

export const PLAYER = {
  bodyW: 2, bodyH: 4, depth: 1, headH: 1,
  totalH: 5,
  walkSpeed: 20,
  walkAccel: 300,      // stud/s² 地面加速（提高后起步几乎无延迟）
  airAccel: 200,       // stud/s² 空中加速（提高后空中惯性更小、更好控）
  groundFriction: 26,  // 松手后的地面减速（越大越“跟手”，惯性越小）
  airFriction: 9,      // 空中松开移动键的急停（越大停得越快）
  turnAccel: 2.1,      // 反向输入时的加速倍率（急转弯/急停更利落）
  jumpPower: 52,
  coyoteTime: 0.11,
  jumpBuffer: 0.13,
  maxFallSpeed: 240,
  slideDuration: 0.62,
  slideHalfH: 0.75,
  diveSpeed: 52,       // 空中速降附加速度
  swimSpeed: 22,       // = walkSpeed：游泳速度与行动速度一致
  swimAccel: 150,      // 游泳加速度（越大越跟手、惯性越小）
  swimVerticalMul: 1.2,// 上浮 / 下潜速度倍率（相对游泳速度）
  swimEnterSink: 20,   // 刚沉入水面时的下沉速度上限(stud/s)：入水惯性立刻刹车，不会一头扎很深
  swimRiseBrake: 2.6,  // 水中「无输入 / 上浮」时，抵消向下惯性所用的加速度倍率（越大停得越快）
  waterLeap: 70,       // 出水跃起：头部接近水面时按住上浮键的上跳速度（跳得比普通跳更高）
  waterLeapTime: 0.7,  // 出水跃起后脱离游泳判定的时长
  waterUpLock: 0.3,    // 入水后「上浮 / 跃出水面」的锁定时长(秒)：防止贴水面反复跳跃躲氧气
  waterDrag:3.1,      // 游泳状态下的水阻（仅游泳时生效）；普通触碰的减速由每个液体对象的「水阻」属性控制
  buoyancy: 0.72,      // 每帧向上加速度系数(相对重力)
  oxygenMax: 100,
  oxygenRegen: 16,     // 出水后每秒回复（关卡可覆盖为 0）
  oxygenRegenDelay: 0.9, // 脱离游泳状态后，等待多久才开始回氧(秒)：防止贴水面反复探头“刷”氧气
  healthMax: 100,
  wallJumpStickTime: 1.2,
  wallJumpPushY: 36,
  wallJumpPushOut: 36,
  wallJumpPushTime: 0.2, // WallJump 弹射持续推力时长(秒)：这段时间内持续维持弹射速度，否则空中急停会把横向弹力立刻吃掉
  wallJumpReach: 1.45,  // WallJump 墙：检测半径(stud)：越大越容易判定到墙
  wallJumpMaxTilt: 0.7, // WallJump 墙：可贴墙面的最大倾斜（接触法线 |Y| 上限，越大越允许倾斜的墙面）
  climbSpeed: 14,       // 攀爬墙：向上/向下速度
  climbSideSpeed: 7,    // 攀爬墙：沿墙面横移速度
  climbHopSpeed: 60,   // 攀爬墙：按住跳跃「快爬」的上跳速度（跳得够不够高改这里；越大每次上跳越高）
  climbHopOut: 15,       // 攀爬墙：快爬跳离的横向速度（极小，几乎贴墙）
  climbHopCool: 0.05,   // 攀爬墙：快爬后允许重新吸附的间隔
  climbHopKeep: 0.4,    // 攀爬墙：快爬后保留上跳速度的时长
  climbReach: 1.5,     // 攀爬墙：检测半径(stud)：越大越容易吸附，速爬时更不容易脱手
  zipGrabRadius: 4,    // 滑索：头部（起点）球形抓取半径(stud)：越大越容易抓住
  climbMaxTilt: 0.75,   // 攀爬墙：可攀爬面的最大倾斜（接触法线 |Y| 上限，越大越允许倾斜的墙面）
  respawnFallY: -500,   // 掉出世界判定
  stepHeight: 1.8,
  eyeOffset: 4.05,      // 眼睛相对脚底高度
};

/* ---------- 阴影（太阳光） ---------- */
export const SHADOW = {
  // 阴影虚化大小(stud)：PCF 核宽的世界尺寸预算，决定阴影边缘的柔和程度。
  // 核宽(texel) = clamp(softness / 每个 texel 的世界尺寸, radiusMin, radiusMax)，
  // 由每个 texel 覆盖的世界尺寸自适应换算出实际核宽，保证世界空间里的柔和程度一致。
  // 调大 → 边缘更柔和，但接触阴影容易被从方块接缝处晕开（漏光风险变大）；
  // 调小 → 边缘更硬更清晰，可能出现锯齿台阶。
  softness: 0.65,
  radiusMin: 0.35,   // 核宽下限(texel)：视锥很小时兜底，避免完全无虚化
  radiusMax: 1,      // 核宽上限(texel)：防止地面 texel 过大时晕染过宽
};

/* ---------- 难度分级 ---------- */
export const DIFFICULTY = [
  { key: 'lucid',       label: 'Lucid',       zh: '清醒', min: 1.0, max: 1.999, color: '#b0f8ffff', glow: 'rgba(20, 78, 75, 1)' },
  { key: 'misty',       label: 'Misty',       zh: '薄雾', min: 2.0, max: 2.999, color: '#febeffff', glow: 'rgba(62, 17, 58, 1)' },
  { key: 'deep',        label: 'Deep',        zh: '深潜', min: 3.0, max: 3.999, color: '#364dffff', glow: 'rgba(17, 49, 110, 1)' },
  { key: 'drowning',    label: 'Drowning',    zh: '溺没', min: 4.0, max: 4.999, color: '#d1b8ffff', glow: 'rgba(110, 74, 172, 0.98)' },
  { key: 'suffocating', label: 'Suffocating', zh: '窒息', min: 5.0, max: 5.999, color: '#656565ff', glow: 'rgba(255, 252, 252, 1)' },
  { key: 'nightmare',   label: 'Nightmare',   zh: '梦魇', min: 6.0, max: 6.999, color: '#ffeb3bff', glow: 'rgba(255, 34, 74, 1)' },
  { key: 'nightmarePlus', label: 'Nightmare+', zh: 'Nightmare+', min: 7.0, max: 9.99, color: '#ff5470ff', glow: 'rgba(150, 0, 40, 1)' },
];

export function diffOf(v) {
  const d = Number(v) || 1;
  for (const t of DIFFICULTY) if (d >= t.min && d <= t.max) return t;
  return d < 1 ? DIFFICULTY[0] : DIFFICULTY[DIFFICULTY.length - 1];
}
export function diffLabel(v) {
  const t = diffOf(v);
  const n = Number(v).toFixed(1);
  return `${t.label} ${n}`;
}

/* ---------- 液体预设 ---------- */
export const LIQUID_KINDS = {
  water:     { label: '水',     color: '#2f8fd8', drain: 8,  kill: false, opacity: 0.62, swim: true,  emissive: '#0a2233', resist: 0.15 },
  acid:      { label: '酸',     color: '#8de23a', drain: 30, kill: false, opacity: 0.72, swim: true,  emissive: '#12240a', resist: 0.15 },
  lava:      { label: '熔岩',   color: '#ff5a1e', drain: 100, kill: true, opacity: 0.94, swim: false, emissive: '#3a0d00', resist: 0.35 },
  custom:    { label: '自定义', color: '#7fe3ff', drain: 12, kill: false, opacity: 0.6,  swim: true,  emissive: '#0a2233', resist: 0.15 },
};

/* ---------- 键位默认值（多键支持） ---------- */
export const DEFAULT_BINDINGS = {
  forward:  ['KeyW'],
  backward: ['KeyS'],
  left:     ['KeyA'],
  right:    ['KeyD'],
  jump:     ['Space'],
  dive:     ['KeyF', 'Mouse0'],
  interact: ['Mouse0'],
  useTool:  ['Mouse0'],
  inventory:['Tab'],
  pause:    ['Escape'],
  cameraToggle: ['KeyV'],
  editorPaint:  ['KeyB'],
  editorDelete: ['Delete'],
  editorDuplicate: ['KeyD'],
  editorFocus:  ['KeyF'],
};

export const BIND_LABELS = {
  forward: '前进', backward: '后退', left: '左移', right: '右移',
  jump: '跳跃 / 上浮', dive: '下潜 / 速降 / 滑铲', interact: '交互',
  useTool: '使用工具', inventory: '工具栏',
  pause: '暂停 / 退出锁鼠', cameraToggle: '切换视角',
  editorPaint: '涂鸦模式', editorDelete: '删除对象',
  editorDuplicate: '复制对象', editorFocus: '聚焦对象',
};

/* ---------- 默认设置 ---------- */
export const DEFAULT_SETTINGS = {
  version: 1,
  bindings: JSON.parse(JSON.stringify(DEFAULT_BINDINGS)),
  mouse:   { sensitivity: 2, invertY: false, smooth: 0 },
  camera:  { fov: 78, defaultMode: 'third', thirdDistance: 21, maxDistance: 90, minDistance: 0,
             shake: 1.0, rollAmount: 0.35, fovKick: true },
  video:   { quality: 'auto', renderScale: 1.0, shadows: true, shadowSize: 2048, fog: true,
            maxPixelRatio: 2, particles: true, antialias: true, waterWaves: true,
            occlusionCulling: true, renderWorker: 'off' },   // off | auto | on：渲染是否搬进 Worker
  audio:   { master: 0.8, sfx: 0.9, ambience: 0.7, music: 0.75 },
  player:  { showName: true, name: '玩家' },   // 头顶名牌：开关与显示名
  replay:  { saveRatio: 30 },  // 回放保存阈值：本局时长达到关卡时长的百分之多少才存（0 = 全都存）
  // 地图变体（MapModifier）：auto = 交给「意外惊喜」随机（默认），其余见 modifier.js 的 MODIFIER_MODES
  modifier: { mode: 'auto' },
  lang:    'en',      // 界面语言（zh 为原文；其余见 js/i18n/*.js）
  misc:    { showFps: false, showHints: true, autosaveEditor: true, orbitInvert: false,
             editorFlySpeed: 60, theme: 'dream' },
  // 界面缩放：auto = 按分辨率自适应（基准 1920×1080），manual = 用 scale 里的值
  // fontSize = 相对标准正文基准（16px）的像素增量，精确到 1px（+8 即比原版大 8px）
  ui:      { scaleMode: 'auto', scale: 1, fontSize: 0 },
};

/* ---------- 编辑器常量 ---------- */
export const EDITOR = {
  undoLimit: 60,
  snapMove: 2,
  snapRotate: 15,
  snapScale: 0.25,
  gridSize: 4,
  // 六面缩放柄大小：屏幕上的手柄尺寸 ≈ faceHandleScale × 相机距离（越大手柄越大），近处按等效距离 3 保底
  faceHandleScale: 0.04,
  faceHandleMinDist: 3,
  // 组合手柄（六面移动 + 三环旋转 + 八角自由缩放）
  // 圆环半径 = 对象半对角线 × comboRingScale（同时不小于手柄尺寸的 2.2 倍）
  comboRingScale: 1.15,
  // 角点方块尺寸 = 手柄尺寸 × comboCornerScale
  comboCornerScale: 0.9,
  maxUndoBytes: 24 * 1024 * 1024,
  paintSizes: [256, 512, 1024],
  defaultPaintSize: 512,
  // 贴纸层：每张贴纸独立画布的分辨率候选（越高越清晰，显存也越贵）
  stickerSizes: [1024, 2048, 4096],
  defaultStickerSize: 2048,
  stickerMaxPerObject: 32,
};

/* ---------- 调色板（梦核） ---------- */
export const PALETTE = [
  '#ffffff', '#e8e3f5', '#b7b0d0', '#7d769a', '#3b3559', '#161327',
  '#ff7fd0', '#ff4d6d', '#ffa06b', '#ffd98a', '#fff3c4', '#8ef5c8',
  '#7fe3ff', '#4fa8ff', '#a08cff', '#6b4dd8', '#2f8fd8', '#8de23a',
];

/* ---------- 事件系统：触发类型 ---------- */
export const TRIGGER_TYPES = {
  levelStart:  { label: '关卡开始', icon: '▶', ui: [] },
  related:     { label: '由相关触发器触发', icon: '⚡', ui: [],
    h: '由任何引用此事件的触发器触发（对象的触碰/进入/离开事件、工具使用时触发事件等）' },
  playerTouch: { label: '玩家触碰', icon: '☄', ui: ['object'] },
  playerEnter: { label: '玩家进入区域', icon: '⬚', ui: ['object'] },
  playerExit:  { label: '玩家离开区域', icon: '⬛', ui: ['object'] },
  timer:       { label: '计时器', icon: '⏱', ui: ['time', 'repeat'] },
  oxygenBelow: { label: '氧气低于', icon: '○', ui: ['value'] },
  variable:    { label: '变量变化', icon: '𝑥', ui: ['var', 'op', 'value'] },
};

/* ---------- 事件系统：动作类型 ---------- */
export const ACTION_TYPES = {
  showObject:   { label: '显示对象',   icon: '👁', ui: ['object'] },
  hideObject:   { label: '隐藏对象',   icon: '🚫', ui: ['object'] },
  setProperty:  { label: '修改属性',   icon: '✎', ui: ['object', 'property', 'value'] },
  moveObject:   { label: '移动对象',   icon: '➡', ui: ['object', 'vec', 'time', 'easing'] },
  rotateObject: { label: '旋转对象',   icon: '⟳', ui: ['object', 'vec', 'time', 'easing'] },
  scaleObject:  { label: '缩放对象',   icon: '⤢', ui: ['object', 'vec', 'time', 'easing'] },
  playAnim:     { label: '播放动画',   icon: '🎬', ui: ['anim'] },
  stopAnim:     { label: '停止动画',   icon: '⏹', ui: ['anim'] },
  teleportPlayer:{ label: '传送玩家',  icon: '⚡', ui: ['vec'] },
  platformMode: { label: '2D 平台模式', icon: '🎮', ui: ['platform'] },
  setPlayer:    { label: '修改玩家',   icon: '🏃', ui: ['playerField', 'value'] },
  setGravity:   { label: '重力变化',   icon: '🌐', ui: ['gravity'],
    h: '改变重力方向与强度：可只作用于玩家、或作用于整个物理世界；时长 > 0 时平滑补间过渡' },
  giveTool:     { label: '给予工具',   icon: '🔧', ui: ['tool', 'toolref'] },
  removeTool:   { label: '移除工具',   icon: '✂', ui: ['tool'] },
  addOxygen:    { label: '增减氧气',   icon: '○', ui: ['value'] },
  setLiquid:    { label: '设置液体高度', icon: '≈', ui: ['object', 'value', 'time', 'easing'] },
  killPlayer:   { label: '杀死玩家',   icon: '☠', ui: [] },
  morphPlayer:  { label: '玩家 morph', icon: '☻', ui: ['morphSource', 'morphFit'] },
  winLevel:     { label: '通关',       icon: '★', ui: [] },
  setVariable:  { label: '设置变量',   icon: '𝑥', ui: ['var', 'op', 'value'] },
  playSound:    { label: '播放音效',   icon: '🔊', ui: ['sound', 'volume'] },
  playAudio:    { label: '播放音频文件', icon: '🎵', ui: ['audio', 'volume', 'loopAudio'] },
  spawnEffect:  { label: '生成特效',   icon: '✨', ui: ['effect', 'vec', 'time'] },
  openDoor:     { label: '打开门',     icon: '🚪', ui: ['object'] },
  closeDoor:    { label: '关闭门',     icon: '🚪', ui: ['object'] },
  skyCrossfade: { label: '天空球渐变', icon: '🌌', ui: ['skyFrom', 'skyTo', 'time', 'easing'] },
  ifBlock:      { label: '条件判断(if/elseif/else)', icon: '⑂', ui: ['ifConds'] },
  wait:         { label: '等待 / 等待直到', icon: '⏳', ui: ['waitMode', 'time', 'untilCond'] },
  showNotice:   { label: '顶部弹出信息/警告', icon: '🔔', ui: ['noticeText', 'noticeKind', 'time'] },
  readVar:      { label: '读取变量',   icon: '📖', ui: ['varName'] },
  mathExpr:     { label: '高级运算',   icon: '∑', ui: ['formula', 'mathArgs', 'varName'] },
  /* ---- 随机数 ---- */
  randomNumber: { label: '随机数',     icon: '🎲', ui: ['var', 'range', 'op'] },
  randomPick:   { label: '随机取一项', icon: '🎯', ui: ['srcVar', 'var', 'op'] },
  randomChance: { label: '随机概率',   icon: '％', ui: ['var', 'chance', 'op'] },
  /* ---- 数组操作 ---- */
  arrayCreate:  { label: '数组·新建',  icon: '📚', ui: ['var', 'list'] },
  arrayPush:    { label: '数组·添加',  icon: '➕', ui: ['var', 'value'] },
  arrayPop:     { label: '数组·弹出末尾', icon: '📤', ui: ['var', 'destVar'] },
  arrayGet:     { label: '数组·取下标', icon: '🔎', ui: ['var', 'index', 'destVar'] },
  arraySet:     { label: '数组·改下标', icon: '✎', ui: ['var', 'index', 'value'] },
  arrayRemove:  { label: '数组·删除值', icon: '🗑', ui: ['var', 'value'] },
  arrayLength:  { label: '数组·长度',  icon: '🔢', ui: ['var', 'destVar'] },
  arrayContains:{ label: '数组·是否包含', icon: '❓', ui: ['var', 'value', 'destVar'] },
  arrayShuffle: { label: '数组·打乱',  icon: '🔀', ui: ['var'] },
  arrayClear:   { label: '数组·清空',  icon: '🧹', ui: ['var'] },
  /* ---- 循环 ---- */
  loopStart:    { label: '循环开始(次数)', icon: '🔁', ui: ['count', 'var'] },
  forEachStart: { label: '遍历数组开始', icon: '🔂', ui: ['srcVar', 'var', 'destVar'] },
  whileStart:   { label: '当…循环开始', icon: '♾', ui: ['cond', 'op', 'value', 'maxIter'] },
  loopEnd:      { label: '循环结束',   icon: '⤵', ui: [] },
  loopBreak:    { label: '跳出循环',   icon: '⏏', ui: [] },
  /* ---- 对象生成 ---- */
  createObject: { label: '生成对象',   icon: '✚', ui: ['templateId', 'spawnWhere', 'vec', 'spawnOpts', 'destVar'] },
  cloneObject:  { label: '克隆对象',   icon: '⧉', ui: ['object', 'spawnWhere', 'vec', 'spawnOpts', 'destVar'] },
  setParent:    { label: '设为子对象', icon: '⤵', ui: ['object', 'parent', 'keepWorld'] },
  /* ---- 脚本 / 查询 ---- */
  script:       { label: '代码块',     icon: '📜', ui: ['code', 'destVar'] },
  evalExpr:     { label: 'JS 表达式',  icon: '∑', ui: ['code'] },
  raycast:      { label: '射线检测',   icon: '📡', ui: ['rayFromTo', 'rayOut'] },
  getProperty:  { label: '读取属性',   icon: '🔍', ui: ['propTarget', 'propPath', 'destVar'] },

  /* ---- NPC / 角色 ---- */
  npcTalk:      { label: 'NPC 对话(分支)', icon: '💬', ui: ['npc', 'npcNode'],
    h: '与玩家开始一段对话：按该 NPC 的「对话图」从指定节点开始，玩家可选分支；对话结束前本动作一直等待' },
  npcSay:       { label: 'NPC 说一句', icon: '🗨', ui: ['npc', 'npcText', 'sayTime'],
    h: '非阻塞地弹出一句气泡台词（对话进行中会被忽略）' },
  npcBehavior:  { label: '设置 NPC 行为', icon: '🧭', ui: ['npc', 'npcBehavior'],
    h: '切换待命 / 跟随玩家 / 沿路径巡逻' },
  npcFollow:    { label: 'NPC 跟随玩家', icon: '👣', ui: ['npc', 'npcKeep'],
    h: '沿玩家走过的轨迹跟上，并保持设定距离' },
  npcPatrol:    { label: 'NPC 开始巡逻', icon: '🔁', ui: ['npc'],
    h: '按 NPC 自身「巡逻路径点」来回移动' },
  npcStop:      { label: 'NPC 停止移动', icon: '⏹', ui: ['npc'],
    h: '清掉移动目标并停下（行为模式保留，可用「设置 NPC 行为」恢复）' },
  npcSpeed:     { label: '设置 NPC 速度', icon: '🏃', ui: ['npc', 'value'] },
  npcKeepDist:  { label: '设置 NPC 保持距离', icon: '📏', ui: ['npc', 'npcKeep'] },
  npcMoveTo:    { label: 'NPC 走向坐标', icon: '➡', ui: ['npc', 'vec', 'value'],
    h: '走到世界坐标即停；速度留 0 = 用 NPC 自身速度' },
  npcWarp:      { label: 'NPC 传送到坐标', icon: '⚡', ui: ['npc', 'vec'] },
  npcWarpToPlayer:{ label: 'NPC 传送到玩家旁', icon: '🪄', ui: ['npc', 'npcKeep'],
    h: '传送到玩家身边设定距离处（落在当前站位朝外的一侧）' },
  npcLookAt:    { label: 'NPC 面向', icon: '👀', ui: ['npc', 'npcFace', 'vec'],
    h: '面向玩家或指定世界坐标；选「玩家」时坐标忽略' },
  npcFreeze:    { label: 'NPC 冻结', icon: '❄', ui: ['npc', 'npcOn'],
    h: '冻结的 NPC 不再移动（仍可交互 / 对话）' },
  npcVisible:   { label: 'NPC 显示/隐藏', icon: '👁', ui: ['npc', 'npcOn'] },
  npcAnim:      { label: 'NPC 播放动画', icon: '🎬', ui: ['npc', 'npcClip'],
    h: '仅「自定义导入模型」有效：按片段名锁定播放（如 Idle / Walk / Run），留空恢复自动状态机' },
  npcGetPos:    { label: 'NPC 位置(值)', icon: '📍', ui: ['npc'] },
  npcDistToPlayer:{ label: 'NPC 与玩家距离(值)', icon: '📐', ui: ['npc'] },
  npcIsTalking: { label: 'NPC 是否在对话(值)', icon: '❓', ui: ['npc'] },
};

/* 高级运算块的八个操作数：公式里的变量名 ↔ 数据字段名 */
export const MATH_VARS = [
  { v: 'a', k: 'argA' }, { v: 'b', k: 'argB' }, { v: 'c', k: 'argC' }, { v: 'd', k: 'argD' },
  { v: 'x', k: 'argX' }, { v: 'y', k: 'argY' }, { v: 'z', k: 'argZ' }, { v: 'w', k: 'argW' },
];
export const MATH_VAR_KEYS = MATH_VARS.map((m) => m.k);

/* ============================================================
   事件块端口 / 可暴露参数 声明表
   ------------------------------------------------------------
   outs      : 该块的执行输出槽（不写 = 单一 'out'）
   ins       : 固定输入口（除 outs 之外的额外输入，当前预留）
   valueOuts : 该块可对外输出的「值」通道
   expose    : 允许被作者暴露成接口端口、由外部接线的参数字段
   onlyValue : 纯值块（不参与执行流，没有 exec 入/出口）
   ============================================================ */
export const ACTION_PORTS = {
  /* 流程控制 */
  ifBlock:   { outs: (a) => ifOutsOf(a), expose: ['cond', 'value'] },
  /* 等待直到：自带一个布尔输入口，被激活后该口收到 true 才继续 */
  wait:      { ins: (a) => (a && a.waitMode === 'until'
    ? [{ k: 'until', l: '继续条件(true)', t: 'value' }] : []), expose: ['time'] },
  loopStart: { expose: ['count'] },
  whileStart:{ expose: ['cond', 'value', 'maxIter'] },
  forEachStart: { expose: ['srcVar'] },
  /* 数值写入类 */
  setVariable:  { expose: ['varName', 'value'] },
  setProperty:  { expose: ['objectId', 'value'] },
  addOxygen:    { expose: ['value'] },
  setPlayer:    { expose: ['value'] },
  setGravity:   { expose: ['gravityDir', 'gravityPower', 'time'] },
  setLiquid:    { expose: ['objectId', 'value', 'time'] },
  moveObject:   { expose: ['objectId', 'vec', 'time'] },
  rotateObject: { expose: ['objectId', 'vec', 'time'] },
  scaleObject:  { expose: ['objectId', 'vec', 'time'] },
  teleportPlayer: { expose: ['vec'] },
  spawnEffect:  { expose: ['effect', 'vec', 'time'] },
  showNotice:   { expose: ['noticeText', 'time'] },
  showObject:   { expose: ['objectId'] },
  hideObject:   { expose: ['objectId'] },
  openDoor:     { expose: ['objectId'] },
  closeDoor:    { expose: ['objectId'] },
  skyCrossfade: { expose: ['fromSky', 'toSky', 'time'] },
  playSound:    { expose: ['sound', 'volume'] },
  playAudio:    { expose: ['audio', 'volume'] },
  randomNumber: { expose: ['varName', 'rmin', 'rmax'], valueOuts: ['v'] },
  randomPick:   { expose: ['srcVar', 'varName'], valueOuts: ['v'] },
  randomChance: { expose: ['varName', 'chance'], valueOuts: ['v'] },
  arrayGet:     { expose: ['varName', 'index', 'destVar'], valueOuts: ['v'] },
  arraySet:     { expose: ['varName', 'index', 'value'] },
  arrayPush:    { expose: ['varName', 'value'] },
  arrayLength:  { expose: ['varName', 'destVar'], valueOuts: ['v'] },
  arrayContains:{ expose: ['varName', 'value', 'destVar'], valueOuts: ['v'] },
  /* 取值类（纯值块） */
  readVar:      { onlyValue: true, valueOuts: ['v'], expose: ['varName'] },
  mathExpr:     {
    onlyValue: true, valueOuts: ['v'], expose: MATH_VAR_KEYS,
  },
  /* 对象生成 */
  createObject: { expose: ['templateId', 'vec', 'destVar'] },
  cloneObject:  { expose: ['objectId', 'vec', 'destVar'] },
  setParent:    { expose: ['objectId', 'parent'] },
  /* 脚本 / 查询 */
  script:       { expose: [] },
  evalExpr:     { onlyValue: true, valueOuts: ['v'] },
  raycast:      { expose: ['range'] },
  getProperty:  { expose: ['objectId', 'propPath'] },
  /* NPC / 角色 */
  npcTalk:      { expose: ['npcId', 'node'] },
  npcSay:       { expose: ['npcId', 'sayText', 'sayTime'] },
  npcBehavior:  { expose: ['npcId', 'npcBehavior'] },
  npcFollow:    { expose: ['npcId', 'npcKeep'] },
  npcPatrol:    { expose: ['npcId'] },
  npcStop:      { expose: ['npcId'] },
  npcSpeed:     { expose: ['npcId', 'value'] },
  npcKeepDist:  { expose: ['npcId', 'npcKeep'] },
  npcMoveTo:    { expose: ['npcId', 'vec', 'value'] },
  npcWarp:      { expose: ['npcId', 'vec'] },
  npcWarpToPlayer: { expose: ['npcId', 'npcKeep'] },
  npcLookAt:    { expose: ['npcId', 'vec'] },
  npcFreeze:    { expose: ['npcId', 'npcOn'] },
  npcVisible:   { expose: ['npcId', 'npcOn'] },
  npcAnim:      { expose: ['npcId', 'npcClip'] },
  /* NPC 取值块（纯值，不参与执行流） */
  npcGetPos:     { onlyValue: true, valueOuts: ['v'], expose: ['npcId'] },
  npcDistToPlayer:{ onlyValue: true, valueOuts: ['v'], expose: ['npcId'] },
  npcIsTalking:  { onlyValue: true, valueOuts: ['v'], expose: ['npcId'] },
};

/** if 块的输出槽：满足 / 否则如果 N / 否则 */
export function ifOutsOf(a) {
  const outs = [{ k: 'then', l: '满足', t: 'exec' }];
  const n = (a && Array.isArray(a.elifs)) ? a.elifs.length : 0;
  for (let i = 0; i < n; i++) outs.push({ k: 'elif' + i, l: '否则如果' + (i + 1), t: 'exec' });
  outs.push({ k: 'else', l: '否则', t: 'exec' });
  return outs;
}

/** 默认单输出槽 */
export const DEFAULT_OUTS = [{ k: 'out', l: '', t: 'exec' }];

/** 该动作的 exec 输出槽列表 */
export function outsOf(a) {
  const p = ACTION_PORTS[a && a.type] || {};
  const o = typeof p.outs === 'function' ? p.outs(a) : p.outs;
  return o && o.length ? o : DEFAULT_OUTS;
}

/** 该动作的输入接口：类型自带的固定输入口 + 已暴露的参数（值输入口） */
export function insOf(a) {
  const p = ACTION_PORTS[a && a.type] || {};
  const fixed = typeof p.ins === 'function' ? p.ins(a) : (p.ins || []);
  const list = (a && Array.isArray(a.expose)) ? a.expose : [];
  return fixed.concat(list.map((k) => ({ k, l: FIELD_LABELS[k] || k, t: 'value' })));
}

/** 该动作允许出现的全部值输入口键名（固定口 + 可暴露参数），用于清洗接线数据 */
export function inputKeysOf(a) {
  const p = ACTION_PORTS[a && a.type] || {};
  const fixed = (typeof p.ins === 'function' ? p.ins(a) : (p.ins || [])).map((x) => x.k);
  return fixed.concat(p.expose || []);
}

/** 该动作可对外输出的值通道 */
export function valueOutsOf(a) {
  const p = ACTION_PORTS[a && a.type] || {};
  return (p.valueOuts || []).map((k) => ({ k, l: '', t: 'value' }));
}

/** 纯值块（不参与执行流） */
export function isValueOnly(a) {
  return !!(ACTION_PORTS[a && a.type] || {}).onlyValue;
}

/** 该动作允许被暴露成接口的参数字段 */
export function exposableOf(a) {
  return (ACTION_PORTS[a && a.type] || {}).expose || [];
}

/* 接口端口 / 属性面板用的字段显示名 */
export const FIELD_LABELS = {
  time: '时长', value: '数值', cond: '条件变量', varName: '变量名', destVar: '结果变量',
  objectId: '对象', parent: '父对象', templateId: '模板对象', vec: '位移', count: '次数',
  maxIter: '最大次数', srcVar: '数组名', index: '下标', rmin: '下限', rmax: '上限',
  chance: '概率', effect: '特效', sound: '音效', volume: '音量', audio: '音频',
  noticeText: '提示内容', object: '对象', argA: 'a', argB: 'b', argC: 'c', argD: 'd',
  argX: 'x', argY: 'y', argZ: 'z', argW: 'w',
  code: '代码', destObj: '命中对象变量', destPos: '命中位置变量',
  destNormal: '命中法线变量', destDist: '命中距离变量',
  propPath: '属性路径', range: '射线长度', rayFrom: '起点', rayTo: '终点',
  fromSky: '起始天空', toSky: '目标天空',
  /* NPC 动作 */
  npcId: 'NPC', node: '起始节点', npcBehavior: '行为模式', npcKeep: '保持距离',
  npcOn: '开关', sayText: '台词', sayTime: '显示时长(秒)', npcFace: '面向', npcClip: '动画名',
  /* 重力变化 */
  gravityDir: '重力方向', gravityPower: '重力强度',
};

/* 对象生成块的定位方式 */
export const OBJECT_POS_MODES = [
  { v: 'abs',     l: '绝对坐标' },
  { v: 'rel',     l: '相对某对象偏移' },
  { v: 'trigger', l: '触发对象处' },
];

/* 射线检测块：起点 / 终点定位方式 */
export const RAY_FROM_MODES = [
  { v: 'player', l: '玩家处(眼位)' },
  { v: 'object', l: '某对象处' },
  { v: 'abs',    l: '绝对坐标' },
];
export const RAY_TO_MODES = [
  { v: 'object', l: '到某对象处' },
  { v: 'abs',    l: '到绝对坐标' },
  { v: 'dir',    l: '按方向 + 长度' },
];

/* 循环类动作（运行时按配对做跳转） */
export const LOOP_START_TYPES = ['loopStart', 'forEachStart', 'whileStart'];

/* 取值字段支持「#变量名」写法（运行时从变量表读取） */
export const VAR_REF_HINT = '数字可填 #变量名 取变量值';

/* 玩家 morph 的来源模式 */
export const MORPH_SOURCES = [
  { v: 'preset',  l: '预设形象' },
  { v: 'model',   l: '导入模型(.glb)' },
  { v: 'default', l: '还原默认形象' },
];

export const PLAYER_FIELDS = {
  speed:       { label: '移动速度', type: 'number', def: PLAYER.walkSpeed },
  jumpPower:   { label: '跳跃力',   type: 'number', def: PLAYER.jumpPower },
  gravityScale:{ label: '重力倍率', type: 'number', def: 1, step: 0.05 },
  oxygen:      { label: '氧气值',   type: 'number', def: 100 },
  maxOxygen:   { label: '氧气上限', type: 'number', def: 100 },
  health:      { label: '生命值',   type: 'number', def: 100 },
  canSwim:     { label: '可游泳',   type: 'bool',   def: true },
  invisible:   { label: '隐身',     type: 'bool',   def: false },
  frozen:      { label: '冻结(定身)', type: 'bool', def: false },
};

export const OBJECT_PROPS_FOR_EVENTS = {
  position:    { label: '位置', type: 'vec3' },
  rotation:    { label: '旋转', type: 'vec3' },
  scale:       { label: '缩放', type: 'vec3' },
  color:       { label: '颜色', type: 'color' },
  transparency:{ label: '透明度', type: 'number' },
  metalness:   { label: '金属光泽度', type: 'number' },
  emissive:    { label: '自发光强度', type: 'number' },
  visible:     { label: '可见', type: 'bool' },
  anchored:    { label: '锚定(无物理)', type: 'bool' },
  castShadow:  { label: '投射阴影', type: 'bool' },
  fillLevel:   { label: '液面高度', type: 'number' },
  intensity:   { label: '灯光强度', type: 'number' },
  damage:      { label: '伤害值', type: 'number' },
  speed:       { label: '速度(运动体)', type: 'number' },
  opacity:     { label: '不透明度', type: 'number' },
};

export const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'step'];

/** 缓动预设显示名 */
export const EASING_LABELS = {
  linear: '线性', easeIn: '缓入', easeOut: '缓出', easeInOut: '缓入缓出', step: '阶跃', custom: '自定义曲线',
};

/** 自定义缓动曲线（三次贝塞尔）预设：[x1,y1,x2,y2] */
export const EASING_BEZIERS = [
  { id: 'linear',    label: '线性',     v: [0, 0, 1, 1] },
  { id: 'easeIn',    label: '缓入',     v: [0.42, 0, 1, 1] },
  { id: 'easeOut',   label: '缓出',     v: [0, 0, 0.58, 1] },
  { id: 'easeInOut', label: '缓入缓出', v: [0.42, 0, 0.58, 1] },
  { id: 'backIn',    label: '回拉入',   v: [0.6, -0.28, 0.74, 0.05] },
  { id: 'backOut',   label: '回弹出',   v: [0.18, 0.89, 0.32, 1.28] },
  { id: 'backInOut', label: '回弹进出', v: [0.68, -0.35, 0.32, 1.35] },
  { id: 'snap',      label: '急停',     v: [0.9, 0.03, 1, 0.3] },
  { id: 'rush',      label: '蓄力',     v: [0.9, 0, 0.1, 1] },
  { id: 'soft',      label: '柔和',     v: [0.25, 0.1, 0.25, 1] },
];

/** 取关键帧/动作实际使用的缓动：自定义曲线时返回控制点数组，否则返回预设名 */
export function easeSpecOf(rec) {
  const e = rec && rec.easing;
  if (e === 'custom' && Array.isArray(rec.ease)) return rec.ease;
  return e || 'linear';
}

export const TOOL_DEFS = {
  breaker: { label: '破坏工具', icon: '⛏', desc: '破坏指定的障碍物' },
  key:     { label: '钥匙',     icon: '🔑', desc: '打开指定的门' },
  oxygen:  { label: '氧气球',   icon: '🫧', desc: '立刻补充额外氧气' },
  throw:   { label: '投掷物',   icon: '🎯', desc: '投掷以触发机关' },
  custom:  { label: '自定义',   icon: '🔧', desc: '自定义工具' },
};

export const BUILTIN_TEXTURES = [
  { id: 'none',        label: '无' },
  { id: 'grid',        label: '网格' },
  { id: 'bricks',      label: '砖墙' },
  { id: 'cloud',       label: '云' },
  { id: 'noise',       label: '噪点' },
  { id: 'tiles',       label: '瓷砖' },
  { id: 'arrowsUp',    label: '向上箭头(WallJump)' },
  { id: 'stripes',     label: '斜条纹' },
  { id: 'checker',     label: '棋盘' },
  { id: 'carpet',      label: '地毯' },
];

/* 内置天空盒（程序化等距柱状全景，可替换，也可用导入的全景图） */
export const BUILTIN_SKIES = [
  { id: 'dream', label: '梦幻黄昏(默认)' },
  { id: 'night', label: '星夜' },
  { id: 'dawn',  label: '晨曦' },
  { id: 'deep',  label: '深海' },
  { id: 'void',  label: '虚空紫' },
  { id: 'storm', label: '风暴灰' },
];

export const SOUNDS = {
  jump: 'jump', land: 'land', splash: 'splash', die: 'die', win: 'win',
  click: 'click', pickup: 'pickup', door: 'door', break: 'break', zipline: 'zipline',
  alarm: 'alarm', oxygen: 'oxygen', bubble: 'bubble',
};

