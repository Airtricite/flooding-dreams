/* ============================================================
   电影级运镜（回放「电影模式」用）
   ------------------------------------------------------------
   与旧版「高光混剪」不同，这里做的是「全程覆盖」：
   · 时间轴与记录 1:1 —— movieT === srcT，不删减、不压缩、不留黑场，
     玩家完整体验被逐秒重演，电影感全部来自「机位与镜头切换」；
   · 整局被切成若干连续分段（每段一个镜头），切点落在
     动作 / 环境 / 状态的拐点上（运动匹配）；关卡有 BGM 时优先落在
     频谱瞬态检出的鼓点 / 重音上（卡点），而不是固定节拍网格；
   · 三段式节奏：开场建立（长）→ 动作递进（渐短）→ 高潮（最短）→ 收尾余韵（长）；
   · 运镜由射线驱动：向上 / 四周 / 向下探净空，净空不足就不上摇臂；
     机位从对焦点朝外打射线，撞墙就收到墙前 —— 摄像机永不穿墙；
   · 水面规避（回放动态运镜）：玩家头没入水里时才允许水下机位；
     只要玩家还在水面上，每一帧都按机位所在 XZ 查液面高度，低了就把镜头抬出水面；
   · 高级技法：斯坦尼康跟拍（水平阻尼 + 前瞻）与沉浸 POV
     （从身体数据重建：头位置 + 身体朝向 + 视线前瞻 —— 不是复现当时的第三人称相机位姿）。
   ★ 智能预分析：回放是录像、未来已知，所以「距离 / 高度 / 锚点 / 轨迹切向 / 急动」这几层
     稳定与避障全部在 **plan 期**一次算完、烘成表（`_buildCurves` 的包络表 + `_bakeMotion`
     的零相位表），运行期只查表。这样做有两个好处：
       · 零相位 —— 因果低通必然滞后，滞后就得靠前馈去补，补不干净就是跳变；整段一次算
         就能前后各看一半，既稳又没有相位滞后；
       · 不逐帧追阶跃目标 —— 旧版运行期那些动态层（`_dynD/_dynH/_laProbe` 逐帧射线）
         每帧都在重新回答「现在够不够远」，这正是「自动避障导致跳变」的根，现已删除。
     运行期保留的只有**硬保证** `_safePlace`（射线收缩 + 地面 / 天花板 / 水面钳制）——
     因为回放中会重演开门 / 触发器等改变世界几何的动作，机位安全必须在用时再验一次。
   ============================================================ */
import * as THREE from 'three';
import * as CANNON from 'cannon';
import { clamp, smoothstep } from '../core/util.js';
import { HIGHLIGHT_RULES, REPLAY_FLAG } from './replay.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _from = new CANNON.Vec3();
const _to = new CANNON.Vec3();

const _hits = [];
const _box = new THREE.Box3();

/* ============================================================
   平滑总控（一个旋钮管住所有「跟得多紧 / 有多稳」）
   ------------------------------------------------------------
   下面那一串 DAMP 都是「一阶低通速率」（1/s，τ = 1/速率），各自独立地稳着
   管线的一段：锚点 / 轨迹切向 / 修正量 / 遮挡收缩 / 视线 / 最终姿态。
   想整体改手感时要一个个改十几处，而且容易改歪 —— 改了低通没改前馈，
   镜头立刻拖在主体背后。所以给一个总控：
     · SMOOTH = 1.0   基准（当前调好的手感；此时下面每个式子都与原值完全相等）
     · SMOOTH > 1     更稳、更慢、更沉：低频漂移几乎看不见，但变向更「拖」
     · SMOOTH < 1     更跟手、更硬：镜头贴着动作走，画面角速度变大，更容易晕
   做法：速率除以 SMOOTH（`sRate`），并把前馈时长 / 前瞻量乘 SMOOTH（`sLead`）——
   低通慢了多少，前瞻就补多少；否则整体调慢之后主体会开始顶出画框。
   刻意**不缩放**的几处（它们不是「稳不稳」，而是安全 / 判定 / 几何）：
     · 硬保证：HARD_FLOOR、FIT_TOL、`_safePlace` 的射线收缩与地面 / 天花板 / 水面钳制；
     · 转场门槛：LINK_CUT_* / FLY_* / DIP_*；
     · 急动检测：JERK_ACCEL / FULL / RISE / FALL（它决定「何时进入稳住档」，
       跟着放大只会让急动档来得更迟，反而更晃）；
     · 几何与预算：SHOT_TYPES 距离、MIN_DIST_*、RAY_BUDGET、SM_SNAP_*、GIMBAL_*、POV_*；
     · POV 俯仰的独立智能平滑（POV_PITCH_*）：它管的是「第一人称的晕」，与跟拍的稳不稳
       是两件事，速率若跟着 SMOOTH 走，调稳跟拍时会把第一人称的抬头 / 低头一起改掉。
   量级参考：1.3 略稳 / 2.0 明显更稳（接近「三脚架 + 滑轨」）/ 3.0 以上偏催眠；
             0.7 明显更跟手，0.5 以下开始读作「手持抖动」。
   运行期直接赋值：`rp.montage.smooth = 2` 或 `setCameraSmooth(2)`。
   逐帧生效且无跳变：改的只是收敛速率与前瞻量，不动任何滤波状态和目标值。
   ============================================================ */
const SMOOTH_MIN = 0.5, SMOOTH_MAX = 3.0;
let SMOOTH = 0.7;
/** 速率总控：低通速率按 SMOOTH 缩放（>1 更慢更稳，<1 更快更跟手） */
const sRate = (base) => base / SMOOTH;
/** 前馈 / 前瞻总控：低通变慢多少，提前量就放多少，抵掉那份滞后 */
const sLead = (base) => base * SMOOTH;
/** 设置平滑总控（自动夹在 [SMOOTH_MIN, SMOOTH_MAX]），返回夹紧后的值 */
export function setCameraSmooth(v) {
  SMOOTH = clamp(Number(v) || 1, SMOOTH_MIN, SMOOTH_MAX);
  return SMOOTH;
}
export function getCameraSmooth() { return SMOOTH; }

/**
 * 镜头库：每种运镜给出（方位角基准、距离、高度、可用范围）。
 * 距离整体取「中远景」：机位贴得越近，玩家转身 / 转身越快时画面里的角速度越大，
 * 也越容易被墙挤成贴脸长焦 —— 两者都是晕 3D 的主因。宁可站远一点用长焦构图。
 * ★ 当前这一版在原有标称值上**统一 +8 studs**（POV 除外，它的 dist 就是录制时的眼睛，恒为 0）；
 *   分析射线的探测半径已同步放宽（见 PROBE_R），否则 open 空间里会被射线长度反压回来。
 */
export const SHOT_TYPES = {
  static: { label: '固定机位', dist: 22.0, h: 2.3, scope: 'any' },
  pushIn: { label: '推轨', dist: 23.5, h: 2.1, scope: 'any' },
  pullOut: { label: '拉轨', dist: 21.5, h: 2.7, scope: 'open' },
  track: { label: '平移跟拍', dist: 24.0, h: 2.0, scope: 'any' },
  follow: { label: '肩后跟随', dist: 15, h: 2.2, scope: 'any' },
  // 迎面引导：它天然最容易读作贴脸 —— 主体是**冲着镜头跑来**的，距离每秒都在被吃掉
  // （再加上下面 `_solve` 里那条锚点滞后补偿，才是完整的账）。
  lead: { label: '迎面引导', dist: 15.0, h: 2.0, scope: 'any' },
  orbit: { label: '环绕', dist: 21.5, h: 3.1, scope: 'open' },
  crane: { label: '升降', dist: 22.0, h: 3.3, scope: 'open' },
  lowHero: { label: '低角度仰拍', dist: 16.0, h: 0.95, scope: 'any' },
  topDown: { label: '俯瞰', dist: 15.6, h: 30.0, scope: 'open' },
  // 高级俯拍：都是「高空 + 向下看」，靠运动方式区分机位语言
  topOrbit: { label: '高空环绕', dist: 16.8, h: 10.4, scope: 'open' },
  // 无人机俯追：水平只吊出去 dist 的 0.55（见 `CAM_FRAC`）—— 标称值要按「水平真实间距」来看
  droneTrack: { label: '无人机俯追', dist: 20.6, h: 6.2, scope: 'open' },
  helicopter: { label: '直升机悬停', dist: 19.0, h: 9.2, scope: 'open' },
  descent: { label: '高空降落', dist: 19.5, h: 14.5, scope: 'open' },
  swing: { label: '弧线摆动', dist: 20.4, h: 2.5, scope: 'any' },
  steadicam: { label: '斯坦尼康跟拍', dist: 16.6, h: 2.0, scope: 'any' },
  pov: { label: '沉浸 POV', dist: 0, h: 0, scope: 'any' },
};

/** 不吃「方位角换轴」的镜头：它们随主体朝向实时跟，天然不会跳轴 */
const FOLLOW_CAM = new Set(['steadicam', 'pov']);
const OPEN_SCOPE = new Set(['open']);
/**
 * 机位沿「运动方向 / 竖直方向」布设的镜头。
 * 它们不吃「横向净空」的挤压：走廊里横向只有两三 studs，但纵向是通的 ——
 * 后方跟拍、迎面引导、俯瞰都能站得开，而横着摆的平移 / 环绕 / 摇臂只能被挤成贴脸长焦。
 */
const AXIAL_CAM = new Set(['follow', 'steadicam', 'lead', 'pov', 'topDown', 'topOrbit', 'droneTrack', 'helicopter', 'descent']);
/**
 * 机位「钉在世界上」的镜头：它们的方向由**世界绝对方位角**决定，不跟随角色当前朝向。
 * 这是治「晕」的关键一条 —— 若按角色朝向算，玩家一甩鼠标转头，机位就绕着对焦点
 * 在半径十几 studs 的圆弧上甩出去（既平移又旋转，画面里最猛的一种运动）。
 * 钉住之后：机位在世界上不动，只有视线跟着主体平移，读作「稳住拍」。
 */
const LOCKED_CAM = new Set(['static', 'pushIn', 'pullOut', 'track', 'swing', 'crane', 'orbit', 'lowHero', 'topDown', 'topOrbit', 'helicopter', 'descent']);
/**
 * 顺「记录轨迹的切向」布机的镜头：它们不用世界方位角，机位跟着走（肩后跟随 / 无人机俯追）。
 * 方位角只用来定「相对轨迹的哪个方位」，由 pickAzimuth 直接返回角色朝向。
 */
const TRAVEL_CAM = new Set(['follow', 'droneTrack']);
/** 俯拍一族：机位在天上、视线朝下。它们不吃「压低机位」这类校正（压下去就不是俯拍了） */
const AERIAL_CAM = new Set(['topDown', 'topOrbit', 'droneTrack', 'helicopter', 'descent']);
/**
 * 「机位在对焦点哪一侧」——射线分析必须朝**机位真正要去的那个方向**打，
 * 否则测出来的净空跟机位无关：后方跟拍却朝前探，走廊里永远探到「前面很空」，
 * 于是静态分析形同虚设，只能等撞上了再靠 `_safePlace` 反应式收缩（就是跳变的来源）。
 */
const BACK_CAM = new Set(['follow', 'steadicam', 'droneTrack']);   // 机位挂在轨迹「后方」
const AHEAD_CAM = new Set(['lead']);                               // 机位摆在轨迹「前方」
const AZDIR_OUT_CAM = new Set(['topOrbit', 'helicopter', 'descent']); // 机位沿「+方位角」方向（其余是 −方位角）
/** 机位沿水平方向实际张开的比例（相对 dist）：无人机俯追只吊出去 0.55，俯瞰只有 0.32 */
const CAM_FRAC = { steadicam: 0.98, droneTrack: 0.55, topDown: 0.32 };
/**
 * 狭窄空间里唯一站得开的几种机位（硬塞横摆机位 = 贴脸 + 长焦 = 最晕）：
 * POV / 后方轨迹跟拍 / 前方轨迹（朝轨迹反方向）迎面跟拍 / 俯瞰。
 * 这几种要么沿纵向、要么沿竖直向，走廊里横向只有两三 studs 也站得开；
 * 低角度仰拍不在此列 —— 它天然偏侧向且贴地，退无可退时只会贴脸。
 */
const NARROW_OK = new Set(['pov', 'steadicam', 'follow', 'lead', 'topDown', 'droneTrack']);
const NARROW_OPEN = 6.5;          // 综合开阔度低于此值算「狭窄空间」
/**
 * 泳区（水下段落）：落水后连续在液体里待满它 —— 一秒都没出过水 —— 才算「进入泳区」。
 * 只是踩过水 / 短促掉进水里就出来的，不算（那些仍按普通段落排镜）。
 * 泳区起点 = 入水时刻 + 它，那一刻必须**立刻**切镜（`_bounds` 把它当强制边界）。
 */
const SWIM_ZONE_T = 1.5
/**
 * 泳区里的镜头语言：只在这三种里轮换 —— POV / 迎面引导 / 肩后跟随。
 * 水里没有能站开的地面，横摆机位（环绕 / 摇臂 / 平移 / 升降）只能被挤成贴脸长焦；
 * 这三种要么架在眼睛上，要么沿轨迹的前 / 后方向布机，水道再窄也站得开，
 * 而且机位跟着主体走，「划水前进」的动势才读得出来。
 */
const SWIM_ZONE_CAMS = ['pov', 'lead', 'follow'];
/** 机位与主体的最小距离：再挤也不许贴脸（POV 除外，它本来就架在眼睛上） */
const MIN_CAM_DIST = 4.5;
/** 视场角上下限：太窄是长焦糊脸，太宽是鱼眼畸变，两头都晕 */
const FOV_MIN = 65, FOV_MAX = 90;
/**
 * 曲线滤波（碰撞修正量的一阶低通，时间常数 ≈ 1/7 s）。
 * 只滤「_safePlace 对机位的修正量」，不滤机位本身 ——
 * 解析式机位（推轨 / 环绕 / 摇臂）本来就是平滑曲线，滤它只会凭空添上滞后；
 * 真正会一帧一跳的是修正量：掠过门框 / 墙角时射线命中距离会突然变、
 * 水面钳制又是硬赋值。把这一段平滑掉，既不滞后也不抖。
 */
const CORR_DAMP = 7.0;
/**
 * 修正量「正在变大」（机位正被躲开障碍）时改用它 —— 非对称：躲要快、回要慢。
 * 对称低通在「墙突然出现在机位方向上」的那几帧会明显落后，落后就得靠后面那道
 * 硬保证去补，于是又跳一下；躲得急一点，硬保证基本不必出手。
 */
const CORR_DAMP_SAFE = 16.0;
/**
 * 视线遮挡的「收缩预算」（`_safePlace` 的距离决策），同样是非对称一阶低通。
 * 动因：`_corr` 滤的是**修正量**，但遮挡判定的修复量本身是一帧之内从 0 跳到十几 studs 的
 * —— 柱子在视线上只差 0.04 studs 进出，射线命中距离就从 ∞ 掉到 6.5，机位一帧横移 15.9 studs。
 * 在此之前 `_safePlace` 的第二次调用（硬保证）又把这笔修正量原样重放一遍，把 `_corr` 的平滑架空。
 * 现在把「要收多少」自己也做成低通：收得快（挡住主体得尽快让开）但不是瞬时，放得慢（回理想距离要含蓄）。
 * 与 `_corr` 是**级联**的：`_shrink` 先把目标限住，`_corr` 再滤一层，于是单帧位移被压在 1~2 studs，
 * 而收敛仍在 0.4s 量级 —— 擦着柱子转过去不再是一帧大跳。
 */
const BLK_SHRINK = 11.0;     // 「收」的速率（1/s）：遮挡进了视线就尽快缩回来
const BLK_EXPAND = 2.6;      // 「放」的速率（1/s）：障碍离开视线后慢慢把机位还回去
/**
 * `_fitPlace`（沿墙面滑移 / 抬机位的换位阶梯）的触发容差。
 * 换位是一次**大幅横挪**（把机位从柱子另一侧搬过来，实测 23 studs），而它原本的条件只是
 * 「墙前 0.42 比不贴脸下限还近」——差 0.3 studs 也照搬，于是一帧 24 studs，
 * 低通之后仍有 5.5 / 4.1 / 3.1 的三帧大位移。缺这么一点点根本不该换位：
 * 就近收近一点点（视场角补偿会接住画框）远比整体换位不显眼。故留一条容差。
 */
const FIT_TOL = 1.5;
/**
 * 安全修正量的**单帧位移上限**（studs）。
 * 低通只能把阶跃摊开，摊开的量仍与阶跃同量级：理想机位在 50 studs 外、视线被抓在
 * 7 studs 处时，`want` 就有 44 —— 一阶低通第一帧照样给出 44×0.17 ≈ 7.4 studs 的位移，
 * 而 `_fitPlace` 的换位更是**一次赋值**（实测 23.8 studs 横挪，`pos.copy(p)`，
 * 低通完全够不着）。这两处就是「段内一帧大跳」剩下的全部来源。
 * 这里给修正量本身带上速度上限：再急也只许一帧挪这么多，于是
 *   · 遮挡收缩变成一段约 0.2~0.4s 的匀速推近（读作「镜头缓缓收进来」，不是一帧瞬移）；
 *   · 换位也走同样的斜坡 —— 反正目标点已经算好，只是分几帧过去。
 * 相机若在这几帧里「路过」障碍物内部并不可见：实体是单面渲染，从内侧看到的是背面。
 * 真正的硬保证（穿不出地面 / 天花板 / 水面）不受影响：它在低通之前就把位置钉死了。
 */
const CORR_MAX_STEP = 2.0;
/** 主体锚点的低通（跟拍类机位的「摄影师手感」）：越大跟得越紧、越小越飘 */
const ANCHOR_DAMP = 6.0;
/**
 * 急动时锚点跟得松一档（把「来回跳」平均掉）。
 * 连续蹬墙 / 快速左右急跳时，主体水平速度会以 ~5Hz 反复反向 ——
 * 那已经超出「跟拍」能跟住的范围：硬跟就是把主体的每一次甩动原样搬进画面。
 * 但**不能靠「把锚点冻住」来稳**：锚点冻住 = 机位和视线点都停在原地，
 * walljump 一冲出去主体就直接顶出画框（那正是「镜头跟不上」）。
 * 现在改成「松一档 + 前瞻补偿」：锚点的低通目标是前瞻点（见 LEAD_K），
 * 低通带来的滞后被前瞻量抵掉大半，于是既稳（~5Hz 的甩动仍被压掉八成以上）
 * 又跟得上（净滞后只剩零点几 studs）。
 */
const ANCHOR_DAMP_JERK = 4.6;
/**
 * 主体前瞻：低通的目标取「主体马上要到的地方」，而不是当前位置。
 * 回放是录像 —— 未来是已知的，不必做物理积分，沿时间轴往前取一点即可（确定性）。
 * 提前量按速度给（秒）并设上限：走得慢几乎没提前量，跑起来 / 蹬墙时才把镜头往前带。
 */
const LEAD_K = 0.006;
const LEAD_MAX = 0.14;
/**
 * 轨迹切向的平滑（跟拍 / 迎面引导 / 俯瞰一族全靠它定向）。
 * 记录只有 15Hz，「连续蹬墙 / 快速左右跳」时切向会一帧反向 180°——
 * 直接读原始切向，机位会在主体两侧之间对甩（画面里最猛、也最晕的一种运动）。
 * 所以这里同时做两件事：
 *   · 一阶低通（TAN_DAMP）抹掉 15Hz 折线的锯齿；
 *   · 角速度硬限速（TAN_TURN）给「反向」这类大跳变封顶 ——
 *     低通对 180° 阶跃的第一帧就能给出 ~100°，光靠低通根本不够。
 * 急动时两者都再压慢一档：跟拍变成「缓缓绕着主体平移」，而不是跟着甩。
 */
const TAN_DAMP = 4.0;             // 正常切向跟随速率（1/s）
const TAN_TURN = 2.0;             // 正常切向角速度上限（rad/s ≈ 115°/s）
const TAN_DAMP_JERK = 1.4;
const TAN_TURN_JERK = 0.6;        // ≈ 34°/s
/* ============================================================
   迎面机位（lead：机位摆在轨迹前方、回头看着主体）专用的「跟紧」参数
   ------------------------------------------------------------
   这一支对滞后最敏感，而且敏感的位置和别的镜头不一样：
     · 肩后跟随 / 无人机俯追 —— 机位在轨迹**后方**，滞后只会让主体更远，画框里几乎看不出来；
     · 迎面 —— 机位在轨迹**前方**，而且它的取景轴就是轨迹切向本身：
         切向慢一拍，主体就横向漂走；主体掉头时切向要跟着转 180°，
         按 TAN_TURN = 2 rad/s 得转 1.6 秒 —— 这 1.6 秒里镜头还站在原地，
         主体直接从它旁边跑过去。这就是「迎面跟拍太 smooth、镜头跟不上」的来源。
   所以只有这一支单独跟紧，默认值按「掉头半秒内跟上」定。
   （沿轨迹方向「越跑越贴脸」那笔账已由 `_solve` 的 lag 补偿原地算平，与这几个倍率无关
     —— 这里管的是**方向**与**横向**的滞后。）
   调参：
     · AHEAD_TAN_MUL   主旋钮，管掉头 / 变向跟不跟得上（3.0 ≈ 限速 6 rad/s，掉头约 0.5s；
                       调小更稳更「甩得慢」，调到 4 以上急转身会读出「镜头在抡」）。
     · AHEAD_TAN_JERK  急动档（连续蹬墙 / 急跳）的退档强度：普通跟拍退到 0.35×，
                       迎面按这个比例退（1 = 完全不退档 —— 急动恰恰是最需要跟上的时刻）。
     · AHEAD_ANCHOR_MUL / AHEAD_LEAD_MUL
                       锚点跟紧率与前馈倍率，管横向残余与加减速那一瞬的偏差；
                       跟不上就调大，画面出现微抖就往回调（锚点迟滞 0.167s ÷ 倍率）。
   ============================================================ */
const AHEAD_TAN_MUL = 3.0;
const AHEAD_TAN_JERK = 1.0;
const AHEAD_ANCHOR_MUL = 1.6;
const AHEAD_LEAD_MUL = 1.4;
/**
 * 急动判定：主体水平速度的变化率（studs/s²）。
 * 正常走路加减速在 20 以内，连续蹬墙 / 左右急跳轻松破 100；
 * 另外「状态 = 蹬墙」本身就记一份，不必等加速度算出来。
 */
const JERK_ACCEL = 42;
const JERK_FULL = 130;
const JERK_RISE = 8.0;            // 进急动要快（立刻稳住镜头）
const JERK_FALL = 3.0;            // 出急动要慢（人稳下来之后仍多稳一会儿，别马上开始跟）
/** 视线角速度上限：兜底防「一帧甩过去」。正常运镜够用，只有病态运动才会碰到 */
const LOOK_TURN_MAX = 3.6;        // rad/s ≈ 206°/s
/** 视线点一阶低通的速率（越小越稳、主体越容易偏离画框中心） */
const LOOK_DAMP = 12;

/* ============================================================
   最终级平滑（真正写进相机的那一帧）
   ------------------------------------------------------------
   上游每一层只稳住「自己那一段」（锚点 / 轨迹切向 / 修正量 / 视线限速），
   叠加起来仍是一串彼此独立的滤波，谁都不为「最终画面」负责。这里补最后一道：
   机位（位移）与对焦点（角度）**一起**过低通。
   回放是录像、未来已知，所以滞后不必忍 —— 低通的目标取「按原始速度外推
   SM_*_LEAD 秒之后的姿态」（速度前馈）。一阶低通 + 同等时间常数的前馈 = 匀速段零滞后；
   这里前馈略大于时间常数（τ = 1/damp），于是镜头是「稍稍抢在角色前面」，而不是跟在背后。
   位置与对焦点必须**一起**外推：只推机位等于把主体往画框外推。
   ============================================================ */
const SM_POS_DAMP = 6.0;      // 机位低通速率（1/s），τ≈0.167s
const SM_POS_LEAD = 0.5;     // 机位前馈时长（s），略大于 τ → 带一点「抢前」
const SM_LOOK_DAMP = 4.2;     // 对焦点低通速率（1/s），τ≈0.238s —— 转头比移动更容易晕，压得更狠
const SM_LOOK_LEAD = 0.26;    // 对焦点前馈时长（s），略大于 τ
const SM_VEL_DAMP = 20;       // 前馈用的速度估计本身的低通（1/s）：抵掉曲率与单帧射线残差
const SM_LEAD_MAX = 3;      // 前馈外推量上限（studs）：极窄处被墙钉住时速度会突然掉头
const SM_SNAP_DIST = 7;       // 单帧原始机位跳超过它 = 瞬移（重生 / 传送）：直接吸附
const SM_SNAP_DT = 0.35;      // 单帧拍摄时间跳超过它 = 拖过进度条：直接吸附

/** 视线逼近正上 / 正下（与参考「上方向」共线）时的万向锁判定线与接合带宽（|cos| 域） */
const GIMBAL_COS = 0.94;
const GIMBAL_BAND = 0.05;
/**
 * POV 前瞻时长（秒）：镜头看向「AHEAD 秒之后头所在的位置」。
 * 跑动时这个方向就是运动方向；前方是上坡就自动抬头、是坠落就自动低头 —— 「提前预知方位」。
 * 太短（<0.15）读不出提前量，太长（>0.6）会在拐弯处提前拐头，像镜头在猜路。
 */
const POV_AHEAD = 0.35;
/** 水平朝向朝前瞻方向偏的比例：0 = 完全用身体朝向，1 = 完全用轨迹方向；中间值两者兼顾 */
const POV_LEAN = 0.5;
/** 俯仰舒适上限（弧度 ≈54°）：再陡的坡 / 再深的坠落也只看到这个角度（垂直视角既没用又晕） */
const POV_PITCH_LIM = 0.95;
/** 前瞻位移超过它（studs）→ 当成一次传送 / 重生：不许提前看向复活点（「看见未来」） */
const POV_HOP_MAX = 30;
/** 对焦点沿视线前伸的距离：只用来构造视线（最终朝向只由方向决定），大一点抖动更小 */
const POV_AIM_DIST = 10;
/* ------------------------------------------------------------
   POV 俯仰的独立智能平滑
   ------------------------------------------------------------
   俯仰是 POV 里唯一会「自己动」的角度（水平朝向跟着身体走，基本稳定），也是晕 3D 的
   主要来源，所以单独给它一套滤波，**不并入**其它稳定层、也不随 SMOOTH 缩放。
   四个部件，各治一种病（速率单位 1/s，τ = 1/速率）：
     · 前瞻多点平均（POV_AHEAD_SPREAD）：单点前瞻的俯仰会被坡面折点与插值噪声直接带进画面。
       改成在 AHEAD 前后各取一点、三点平均 —— 恒定坡度上三点的均值**恰好等于中点值**
       （零滞后，和纯低通最本质的区别），坡顶 / 坡底的折点被摊平，噪声按 1/√3 衰减。
       它是纯函数（只依赖记录），所以 plan 期的标称姿态也一致，转场照样接得上。
     · 可靠性权重（POV_AIM_MIN_D）：前瞻位移趋近于零时，`atan2(dy, hd)` 的分母先退化，
       分子又全是样条插值的量化噪声 —— 站着不动 / 极慢走时俯仰会自己乱抖。位移小于
       这个量就不认前瞻的俯仰（退回平视），插值噪声因此永远进不了画面。
     · 死区（POV_PITCH_DEAD）：落在死区内的偏差**完全不跟**。低通在接近目标时会拖出一条
       无限长的尾巴，而这条尾巴的幅度恰好是「疑似抬手」的量级；直接按死不跟更干净。
     · 变化量自适应速率（POV_PITCH_*_HZ + POV_PITCH_EASE）：偏差小（残余噪声、连续起伏）
       → 用慢速率沉住；偏差大（真起跳 / 真坠落 / 切镜残留）→ 用快速率跟上。不这么做就
       只能二选一：要么真坡度明显拖在后面（晕），要么把残余噪声原样放大（更晕）。
   切镜 / 拖进度条 / 首次进入时直接吸附（`snap`），平滑只该稳「连续运动」。
   调法：想更稳就调小 POV_PITCH_HZ_SLOW，想更跟手就调大 POV_PITCH_HZ_FAST。
   ------------------------------------------------------------ */
const POV_AHEAD_SPREAD = 0.15;   // 前瞻俯仰取样在中点前后各偏这么多秒（三点平均的半宽）
const POV_PITCH_HZ_SLOW = 1.8;   // 小偏差时的收敛速率（越小球越沉、噪声越看不见）
const POV_PITCH_HZ_FAST = 7.5;   // 大偏差时的收敛速率（左右「真坡度跟不跟得上」）
const POV_PITCH_EASE = 0.15;     // 速率从慢档过渡到快档的偏差跨度（弧度 ≈8.6°）
const POV_PITCH_DEAD = 0.004;    // 死区（弧度 ≈0.23°）：比这还小的一律当噪声
const POV_AIM_MIN_D = 0.35;      // 前瞻三维位移达到它才完全信任俯仰（见上：噪声可靠性）

/* ============================================================
   运镜整体提前（时间偏移）
   ------------------------------------------------------------
   相机用「播放时间 + LEAD_SHIFT」去取运镜（哪一镜 / 段内相位 u / 包络表 / 飞渡窗口 / 遮罩），
   角色仍用真实播放时间取位置。于是镜头**先把画框摆好、先切过去**，动作随后走进已经建立好的
   构图 —— 摄影上就是「提前建立 / anticipation」。
   ★ 两者必须分开算：若连角色位置也一起提前，镜头就会对着一个还没到人的空位。
   代价：开场镜头从第 LEAD_SHIFT 秒的相位开始演（前段不播）；
        结尾镜头提前 LEAD_SHIFT 秒走完，并把末姿态保持到本局结束。
   调法：改这里，或运行期直接 `rp.montage.lead = 0.5`（单位秒，0 = 关闭 = 原样）。
   ============================================================ */
const LEAD_SHIFT = 0;

/* ============================================================
   距离 / 高度的智能分析（射线驱动）
   ------------------------------------------------------------
   SHOT_TYPES 里的 dist / h 只是「标称值」：真正用多少由射线分析按附近结构与地形现算 ——
   但**全部在 plan 期一次算完**（「智能预分析」）：沿运动弧 × 多高度层打射线，得到整段的
   可用半径 / 净高，再烘成 1/15s 网格的包络表。运行期只查表 + 硬保证（`_safePlace`），
   **一条射线都不打** —— 旧版「逐帧前瞻校验射线 + 非对称低通去追它」正是跳变的来源。
   ============================================================ */
/**
 * 各镜头方位角的摆动半幅（rad）：必须与 `_solve` 各 case 的公式对齐
 * （orbit 是 wind*u*0.85、topOrbit 是 wind*u*1.5…，wind 本身幅度 ±0.55，故此处写折算后的值）。
 * 分析射线要覆盖整段弧，否则「镜头在段内扫过的那面墙」会漏测。
 */
const AZ_ARC = {
  orbit: 0.5, topOrbit: 0.85, swing: 0.4, crane: 0.15, helicopter: 0.12,
  descent: 0.09, track: 0.45, follow: 0.2, lead: 0.12, droneTrack: 0.12,
};
const ARC_PAD = 0.15;        // 运动弧两端额外留的余量（rad）
/** 静态分析射线的前瞻窗口（秒）：段尾之后这么久也纳入分析，提前发现门口 / 变窄处 */
const LOOKAHEAD = 0.7;
/**
 * 段内包络表的**对称窗半宽**（秒）：plan 期以 1/15s 网格烘表时，
 * 每个网格点取「前后各 ENV_HALF 秒内最窄 / 最低处」（`symMin`），不再是旧版的单边前瞻。
 * 镜头因此在到达门口 / 窄处**之前**就把距离收好、离开之后再匀速还回去，
 * 全程是表里的一条连续曲线 —— 运行期只查表，不再有「逐帧追一个阶跃目标」的跳变。
 */
const ENV_HALF = LOOKAHEAD * 0.5;
/**
 * 包络表的零相位平滑速率（1/s）。求出对称窗最小值之后再走一次前向 + 后向 EMA：
 * 把门口那种「一格深、一格浅」的台阶抹成斜坡，且**不引入相位滞后**（回放未来已知）。
 * 这是「智能预分析」替代「逐帧反应式收缩」的关键一步。
 */
const ENV_DAMP = 4.5;
const SUBJ_R = 1.12;         // 主体水平外接半径（玩家碰撞体半长 (1, 2.5, 0.5)）
const MIN_DIST_MIN = 3.2;    // 「不贴脸」下限的上下夹
const MIN_DIST_MAX = 8;
const HARD_FLOOR = 3;      // 真挤不开时的绝对硬底线：比这更近就是贴脸了
/**
 * 「太近」门槛（studs）：可用半径低于它就必须去换角度 / 换高度层 / 换类型。
 * 只等到跌破 MIN_DIST_MIN 才当回事是错的 —— 那一步本身就是「贴脸」，
 * 而只要还有别的方向站得开就该「能远则远」（开场那一镜最容易读作镜头贴脸）。
 */
const NEAR_ENOUGH = 6.0;
/** 候选阶梯的收益门槛：换过去的可用半径至少要多这么多才值（否则保持原选型，避免来回跳轴） */
const FIT_GAIN = 0.6;
/** 候选阶梯最多试几个方位角候选（固定顺序 = 确定性；限个数只是为了不把射线预算烧光） */
const FIT_AZ_TRIES = 4;
/**
 * plan 期射线预算：超了就降采样（仍保持确定性）。
 * 包络表改按 1/15s 稠密网格烘焙之后射线量涨了数倍，所以预算同步抬高；
 * 超预算时 `_q()` 分级退化（先降层数 / 弧内角，再放宽网格到 1/10s、1/6s）。
 */
const RAY_BUDGET = 8000;
/** 景别档：固定表（任意 3 连不重复且必含一远一近），禁止随机 → 拖进度条重算结果一致 */
const SIZE_SEQ = ['far', 'med', 'near', 'med', 'far', 'near', 'med', 'far'];
const SIZE_MUL = { far: 1.35, med: 1.0, near: 0.78 };     // 景别对「理想距离」的倍率
const SIZE_FILL = { far: 0.98, med: 0.72, near: 0.5 };    // 空间不足时各档吃下可用半径的比例
const H_MUL = { far: 1.15, med: 1.0, near: 0.85 };        // 景别对机位高度的倍率
let _rayCost = 0;            // 本轮分析已打的射线数（预算控制用）
/**
 * 「可用半径」分析射线的探测长度（studs）。
 * 这不是一个随便取的数：分析出来的 `cap` 会被用来夹 `dist`（`_makeShot` 的 ① / ② 层），
 * 探测长度就是**机位距离的硬上限**。标称距离统一 +8 之后，原来那 18 会让 open 空间里
 * 的 cap 反压回 ~17，于是「加远」在空地上完全不生效、甚至因为走 SIZE_FILL 分支而变近。
 * 取 40：覆盖到「中远景 + 疾跑 + 开场」的全部组合；只有最极端（far × 全速 × 开场）才会碰到上限。
 */
const PROBE_R = 40;

/* ============================================================
   ★ 综合调制参数：镜头「远离主体」的努力程度
   ------------------------------------------------------------
   一个旋钮统管「机位离角色多远、多积极地躲开贴脸」——比逐个改上面那串常数省事，
   而且改一处就能同时照顾到「理想距离 / 下限 / 换位门槛 / 空间占用 / 硬底线」这几层。
   影响面（全部乘在原有数值上，1.0 = 完全等于各常数的基准量级）：
     · 理想距离      `_makeShot`：标称距离 × 景别 × 速度 × RETREAT（「能远则远」的第一层）
     · 不贴脸下限    `minDistForFov`：挤到墙角时也不许趴到脸上
     · 换位门槛      `_fitShot`：「站不开」判定线 NEAR_ENOUGH × RETREAT（更积极地换方位角 / 换类型）
     · 吃空间比例    `_makeShot`：空间不足时各景别吃下的比例 × RETREAT（能多占就多占）
     · 硬底线        `_safePlace`：真挤不开时的绝对下限 HARD_FLOOR × RETREAT
   另外「迎面引导」另有一条**精确**的滞后补偿（见 `_solve` 的 lead 分支），不随这个参数走
   —— 那是修正一门特定机位的系统误差，不该被一个整体旋钮放大。
   量级参考：1.15 略远 / 1.35 明显更远 / 1.6 以上偏「纪录片式远观」。
   运行期可直接赋值：`rp.montage.retreat = 1.35`（机位曲线是 plan 期烘出来的，
   改了之后要重新 plan / 点面板「应用」才生效）。
   ============================================================ */
const RETREAT_MIN = 0.6, RETREAT_MAX = 10.0;
let RETREAT = 1.35;
/** 设置综合调制参数（自动夹在 [RETREAT_MIN, RETREAT_MAX]），返回夹紧后的值 */
export function setCameraRetreat(v) {
  RETREAT = clamp(Number(v) || 1, RETREAT_MIN, RETREAT_MAX);
  return RETREAT;
}
export function getCameraRetreat() { return RETREAT; }

/* ============================================================
   跟镜期的智能远近调制（`LIVE_DIST`）
   ------------------------------------------------------------
   与 RETREAT 的分工（两个都是「镜头离主体多远」，但管的时间点不同）：
     · RETREAT    调制的是 **plan 期**的「布置」：标称距离 × 景别、空间不足时各景别吃下的比例、
                  换位门槛 NEAR_ENOUGH、硬底线 HARD_FLOOR —— 它决定镜头**从哪儿开始**、
                  站在多开的地方。曲线烘完就固定了，改它要重新 plan。
     · LIVE_DIST  调制的是 **跟镜期**的那一份「智能远近」，也就是运行期从包络表里查出来的
                  距离（见 `update`）。包络表本身是 plan 期预分析好的（含 0.7s 前瞻 +
                  零相位平滑），LIVE_DIST 只是在查表结果上乘一档，所以**逐帧生效**：
                  值越大越远，值越小越近，不需要重新 plan。
   施加位置：`capD` 的**期望值**上（`min(本段标称, 包络表) × LIVE_DIST`）。
   刻意**不缩放**的是下限 `curve.minDist`（「不贴脸」下限，由视场角与主体外接半径算出，
   随 RETREAT 走）—— 所以调小到 1 以下会在窄处被这条下限挡住，读数是「稍微近一点」，
   而不是「贴脸」。
   量级参考：1.3 ≈ 开阔处整体退远 30%；0.8 ≈ 近 20%；窄处基本不动（表下限在管）。
   运行期直接赋值：`rp.montage.liveDist = 1.3` 或 `setCameraLiveDist(1.3)`；
   与 RETREAT 不同，**不需要重新 plan**，下一帧就能看出来。
   ============================================================ */
const LIVE_DIST_MIN = 0.5, LIVE_DIST_MAX = 3.0;
let LIVE_DIST = 1.41;
/** 设置跟镜期远近调制（自动夹在 [LIVE_DIST_MIN, LIVE_DIST_MAX]），返回夹紧后的值 */
export function setCameraLiveDist(v) {
  LIVE_DIST = clamp(Number(v) || 1, LIVE_DIST_MIN, LIVE_DIST_MAX);
  return LIVE_DIST;
}
export function getCameraLiveDist() { return LIVE_DIST; }

/* ============================================================
   ★ 智能多样剪辑：风格 × 种子
   ------------------------------------------------------------
   排片里带「创作自由度」的只有这几处：候选运镜的优先顺序、景别序列表、
   换轴阶梯与最小换轴角、镜头长度节奏、理想距离倍率、节奏倍率、摇摄步长。
   多样性**只改这些输入**，**一道安全闸门都不动**：
     · 射线候选阶梯 `_fitShot`（站不开就换方位角 / 换高度层 / 换类型）
     · 「不贴脸」下限 `minDistForFov` + FOV 夹紧
     · 飞渡路径迭代避障 `_fitFlyPath` 与转场决策 `_linkClips`
     · 运行期硬保证 `_safePlace`（射线收缩 + 地面 / 天花板 / 水面钳制）
   于是「换一版」换出来的一定还是拍得出来的排片，只是排法与节奏不同。
   确定性：同一 (style, seed) 必须逐字段一致（拖进度条重算 / 面板反复「应用」），
   所以一律走 `mulberry32` 整数种子 PRNG —— 本模块内禁止 Math.random。
   ============================================================ */
/** 换轴阶梯（绝对偏移，rad）：按顺序取第一个 ≥ 最小换轴角的。3.14（正反打）压轴兜底 */
const AZIM_LADDER_CORE = [1.05, -1.05, 1.75, -1.75, 2.45, -2.45];
const AZIM_LADDER = AZIM_LADDER_CORE.concat([3.14]);
/** 摇摄步长候选（都与 7 互质：wind 仍落在 [-0.55, 0.55]，只是图样不同） */
const WIND_STEPS = [37, 23, 41, 53, 61, 79];

/**
 * 风格预设：只描述「偏向」，具体数值由 `makeVariant` 按种子做小幅抖动。
 *   bias     —— 优先运镜（插在候选池中段，顺序即优先级）
 *   avoid    —— 本风格不用的运镜（狭窄安全集仍会兜底，绝不会无镜可用）
 *   distMul 理想距离倍率（>1 更远观）  paceMul 节奏倍率（>1 运动更快）
 *   lenMul  镜头长度倍率（>1 更长）    gapMul 最小换轴角倍率
 *   maxLenMul 单镜长度上限倍率         reverse 景别序列表是否反向
 */
const CINE_STYLE_DEF = {
  standard: { label: '标准节奏', bias: [], avoid: [], distMul: 1.00, paceMul: 1.00, lenMul: 1.00, gapMul: 1.00, maxLenMul: 1.00, reverse: false },
  slow: { label: '舒缓长镜', bias: ['track', 'steadicam', 'crane', 'orbit'], avoid: ['swing'], distMul: 1.14, paceMul: 0.82, lenMul: 1.45, gapMul: 0.90, maxLenMul: 1.25, reverse: false },
  rapid: { label: '凌厉快切', bias: ['droneTrack', 'pushIn', 'swing', 'track'], avoid: ['crane'], distMul: 0.90, paceMul: 1.22, lenMul: 0.70, gapMul: 1.15, maxLenMul: 0.80, reverse: true },
  aerial: { label: '高空俯瞰', bias: ['topOrbit', 'helicopter', 'topDown', 'descent', 'droneTrack'], avoid: ['swing'], distMul: 1.10, paceMul: 0.94, lenMul: 1.12, gapMul: 1.00, maxLenMul: 1.10, reverse: false },
  intimate: { label: '贴身跟拍', bias: ['steadicam', 'follow', 'lead', 'pov', 'track'], avoid: ['crane', 'descent', 'topOrbit'], distMul: 0.82, paceMul: 1.06, lenMul: 0.92, gapMul: 1.25, maxLenMul: 0.95, reverse: true },
  sweep: { label: '大弧运动', bias: ['orbit', 'swing', 'topOrbit', 'crane', 'helicopter'], avoid: ['static'], distMul: 1.05, paceMul: 1.05, lenMul: 1.18, gapMul: 1.35, maxLenMul: 1.15, reverse: false },
  doc: { label: '纪实远观', bias: ['static', 'pushIn', 'pullOut', 'track', 'lead'], avoid: ['swing', 'pov'], distMul: 1.35, paceMul: 0.90, lenMul: 1.20, gapMul: 0.85, maxLenMul: 1.10, reverse: true },
};
/** 「自动」按种子轮着挑这些风格（顺序固定 → 同一 seed 结果一致） */
const CINE_STYLE_IDS = ['standard', 'rapid', 'slow', 'aerial', 'intimate', 'sweep', 'doc'];
/** 剪辑面板的风格下拉（'auto' 在最前） */
export const CINE_STYLE_LIST = [{ id: 'auto', label: '自动' }]
  .concat(CINE_STYLE_IDS.map((id) => ({ id, label: CINE_STYLE_DEF[id].label })));

/** 整数种子 PRNG（mulberry32）：确定性、无外部状态，本模块禁止 Math.random */
function mulberry32(a) {
  a = (a | 0) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由「风格 + 种子」解出一版排片参数（确定性）。
 * @param style 'auto' 或 CINE_STYLE_DEF 的键
 * @param seed  整数种子（缺省 1）
 * @returns 参数对象；`style` 与 `seed` 全空时返回 null = 基准排片（与历史版本逐字段一致）
 */
export function makeVariant(style, seed) {
  let sid = String(style || '');
  const sd = Number(seed);
  const hasSeed = Number.isFinite(sd);
  if (!sid && !hasSeed) return null;
  if (!sid || sid === 'auto') sid = CINE_STYLE_IDS[(((sd | 0) % CINE_STYLE_IDS.length) + CINE_STYLE_IDS.length) % CINE_STYLE_IDS.length];
  const def = CINE_STYLE_DEF[sid] || CINE_STYLE_DEF.standard;
  const s = hasSeed ? (sd | 0) : 1;
  const rnd = mulberry32((Math.imul(s, 2654435761) ^ Math.imul(sid.length, 131)) | 0);
  const jit = (x, amt) => x * (1 + (rnd() * 2 - 1) * amt);
  // 景别序列表：整体轮转（+ 可选反向），仍保持「相邻不同档、有远有近」
  const seqBase = def.reverse ? SIZE_SEQ.slice().reverse() : SIZE_SEQ;
  const rot = Math.floor(rnd() * seqBase.length);
  const sizeSeq = seqBase.map((_, k) => seqBase[(k + rot) % seqBase.length]);
  // 换轴阶梯：核心段轮转 + 可选左右翻转（3.14 仍是压轴兜底）
  const lrot = Math.floor(rnd() * AZIM_LADDER_CORE.length);
  const core = AZIM_LADDER_CORE.map((_, k) => AZIM_LADDER_CORE[(k + lrot) % AZIM_LADDER_CORE.length]);
  const ladder = (rnd() < 0.5 ? core.map((o) => -o) : core).concat([3.14]);
  // 偏好顺序轮转：同一种风格连点「换一版」也不会排出一模一样的序列
  const bias = def.bias.slice();
  if (bias.length > 1) bias.push(...bias.splice(0, Math.floor(rnd() * bias.length)));
  return {
    style: sid, seed: s, label: def.label,
    sizeSeq, bias, avoid: new Set(def.avoid), ladder,
    azimGap: clamp((Math.PI / 5) * jit(def.gapMul, 0.06), Math.PI / 9, Math.PI / 2.4),
    lenMul: clamp(jit(def.lenMul, 0.12), 0.55, 1.8),
    maxLenMul: clamp(jit(def.maxLenMul, 0.08), 0.65, 1.35),
    distMul: clamp(jit(def.distMul, 0.08), 0.7, 1.6),
    paceMul: clamp(jit(def.paceMul, 0.08), 0.65, 1.55),
    windStep: WIND_STEPS[Math.floor(rnd() * WIND_STEPS.length)],
  };
}

/* ---------- 转场（直接硬切 / 黑场白场遮罩 / 超平滑飞渡） ---------- */
const LINK_CUT_DIST = 2.6;      // 机位位移小于它，且视线转角也小 → 直接硬切（本来就看不出）
const LINK_CUT_ANG = 0.42;      // ≈24°：视线转角小于它才算「看不出来」
const FLY_DIST_MAX = 60.0;      // 位移超过它就别飞了（等于横跨大半个关卡）→ 只能硬切
const FLY_T_MIN = 1, FLY_T_MAX = 2;   // 飞渡时长按位移自适应（秒）
const FLY_HALF_SHARE = 0.42;    // 飞渡时长最多占相邻两镜各自长度的这个比例
const DIP_T = 0.30;             // 黑场半宽（秒）：切点前后各这么长
const DIP_FLAT = 0.1;           // 半宽里「全遮住」的比例 → 0.24s 实黑，两侧各 0.18s 收口
const DIP_COLOR_WIN = '#fff', DIP_COLOR_DEF = '#000';
/**
 * 视线判定的余量（studs）：射线命中点比目标近了这么多以上才算「被挡住」。
 * 贴着墙角掠过、擦着台面切过去都不算挡住角色 —— 那些情况下主体仍有大半在画面里。
 */
const SEE_SLACK = 0.5;
/**
 * 主体「头」的高度（脚底上方）。本文件里的身体坐标一律是**脚底**（`s.y` =
 * `body.position.y`，碰撞盒占 y∈[0, totalH]），所以这里必须按人的真实高度取：
 * 头顶在 +4.5（`totalH - 0.5`），眼睛在 +4.05（`PLAYER.eyeOffset`）。
 * 取眼睛高度而不是头顶 —— 遮挡判定问的是「看不看得见这个人」，头顶被门楣蹭到不算看不见。
 */
const HEAD_H = 4.05;
/** 主体「脚」的高度：略高于地面，避免射线终点正好落在脚下的地板上被误判成遮挡 */
const FOOT_H = 0.1;
const LINK_RAY_BUDGET = 900;    // 转场路径验证的射线预算（独立于 RAY_BUDGET）
let _linkCost = 0;
/**
 * 「极短微滑移」（glide）：位移 < LINK_CUT_DIST 且转角 < LINK_CUT_ANG 的切点本来读不出接缝，
 * 硬切也行；既然飞渡这条路已经铺好了，就顺手滑过去 —— 0.2~0.45s 按位移取值，
 * 比硬切更没有「接了一下」的痕迹。路径验证不过才退回硬切（位移这么小，退回也看不出）。
 */
const GLIDE_T_MIN = 0.2, GLIDE_T_MAX = 0.45;
/** 相邻采样点的位移超过它 = 一次传送 / 重生（15Hz 采样，疾跑与自由落体都到不了这个量级） */
const TELEPORT_JUMP = 12;

/**
 * 该镜头的基准视场角 —— 一律夹在 [FOV_MIN, FOV_MAX] 内。
 * 早期这里的非 POV 档位是 36 / 40 / 44：比实际游玩时的 78° 窄了近一倍，
 * 回放里读作「被推上去的长焦」，又闷又晕，正是 `FOV_MIN` 注释里说的「长焦糊脸」。
 * 现在所有非 POV 镜头统一取下限，画框大小的差别全部交给景别（dist × SIZE_MUL）去做。
 */
function fovFor(type) {
  return clamp(type === 'pov' ? 66 : FOV_MIN, FOV_MIN, FOV_MAX);
}

/** 「不贴脸」的机位下限：主体水平外接半径在画框里至少占一定张角（整体受 RETREAT 调制） */
function minDistForFov(type, fov) {
  if (type === 'pov') return 0;                 // POV 本来就架在眼睛上
  const half = THREE.MathUtils.degToRad(fov) * 0.5;
  return clamp(SUBJ_R / (0.75 * Math.tan(half)) * RETREAT, MIN_DIST_MIN * RETREAT, MIN_DIST_MAX * RETREAT);
}

/* ============================================================
   环境探测（射线）
   ============================================================ */
/**
 * 从一个点向上 / 多方向 / 向下探，量化「这个位置的拍摄条件」
 *
 * 开阔度不能只看横向：低天花板会把摇臂、环绕这类「往上站」的机位也一起废掉，
 * 而横向窄、纵向通的走廊恰恰相反 —— 只看横向会得出「前后都堵死」的错误结论。
 * 所以这里按方向加权合并：
 *   · 水平 8 向         权重 1.0   —— 横摆机位（平移 / 环绕）的立足空间
 *   · 斜上 45° 4 向     权重 0.6   —— 摇臂 / 高机位的可用空间
 *   · 正上方 1 向       权重 0.5   —— 天花板
 * 合并用「加权调和平均」：偏向小值（某个方向被堵死会明显拉低结果），
 * 又不像纯取最小那样被单条射线一票打死。
 * @returns { ceiling, openness, lateral, wallDist, wallDir:{x,z}, groundDist, submerged }
 */
export function probeEnvironment(world, builder, data, t, playerBody) {
  const s = data.sampleAt(t);
  const out = { ceiling: 12, openness: 16, lateral: 16, wallDist: 16, wallDir: { x: 0, z: 0 }, groundDist: s.y, submerged: 0 };
  const eye = s.y + 2.4;
  if (world) {
    // 天花板：厚度探测（不计背面，避免站到台面下时把台面底面当成天花板）
    castHit(world, s.x, eye, s.z, s.x, eye + 14, s.z, playerBody, (_d, _n) => { out.ceiling = _d; });
    // 多方向净空：水平 8 向 + 斜上 4 向 + 正上方，按权重做加权调和平均
    let sum = 0, wsum = 0, lat = 16;
    /** 打一条射线，返回「这个方向能站多远」（被堵 = 命中距离，通的 = 满净空 16） */
    const probe = (dx, dy, dz) => {
      let got = false, d8 = 16;
      castHit(world, s.x, eye, s.z, s.x + dx * 16, eye + dy * 16, s.z + dz * 16, playerBody, (d, n) => {
        // 只认「拦得住」的面：斜屋顶 / 斜坡不算堵（法线明显朝上下的一律忽略）
        if (Math.abs(n.y) > 0.6) return;
        got = true; d8 = d;
      });
      return got ? d8 : 16;
    };
    const add = (d8, w) => { wsum += w; sum += w / Math.max(0.5, d8); };
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const dx = Math.sin(a), dz = Math.cos(a);
      const d8 = probe(dx, 0, dz);
      add(d8, 1);
      // 横向单独留一份「最近的竖直墙」：给「狭窄空间」判定与提示用
      if (d8 < 16 && d8 < lat) { lat = d8; out.wallDir.x = -dx; out.wallDir.z = -dz; }
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      add(probe(Math.sin(a) * 0.7071, 0.7071, Math.cos(a) * 0.7071), 0.6);
    }
    add(probe(0, 1, 0), 0.5);
    out.wallDist = lat;
    out.lateral = lat;
    out.openness = wsum > 0 ? clamp(wsum / Math.max(1e-4, sum), 0, 16) : 16;
    // 地面：脚下到地面的高度（用于判断悬空 / 高处）
    castHit(world, s.x, s.y + 0.2, s.z, s.x, s.y - 20, s.z, playerBody, (d) => { out.groundDist = d; });
  }
  // 液面：所在位置的水深（站在水底 / 半淹 / 完全出水）
  out.submerged = liquidDepthAt(builder, s.x, s.y, s.z);
  return out;
}

/** 附近液体在该点的「淹没过脚底的高度」；无液体为 0 */
function liquidDepthAt(builder, x, y, z) {
  if (!builder) return 0;
  const list = builder.objectsOf('liquid');
  if (!list || !list.length) return 0;
  let top = -Infinity;
  for (const rec of list) {
    if (!rec.mesh) continue;
    if (rec.o && rec.o.visible === false) continue;
    builder.worldBoxOf(rec, _box);
    if (_box.isEmpty()) continue;
    if (x < _box.min.x - 0.01 || x > _box.max.x + 0.01) continue;
    if (z < _box.min.z - 0.01 || z > _box.max.z + 0.01) continue;
    if (y > _box.max.y) continue;                 // 在水面之上
    top = Math.max(top, _box.max.y);
  }
  if (top === -Infinity) return 0;
  return Math.max(0, top - y);
}

/**
 * 该 XZ 上「高于 yRef 的最高液面」；没有返回 -Infinity。
 * 用来回答「这个机位会不会被液面淹掉」——刻意只看高于机位的液面，
 * 机位本来就在水面之上的情况不该被动抬高。
 */
function liquidTopAt(builder, x, z, yRef) {
  if (!builder) return -Infinity;
  const list = builder.objectsOf('liquid');
  if (!list || !list.length) return -Infinity;
  let top = -Infinity;
  for (const rec of list) {
    if (!rec.mesh) continue;
    if (rec.o && rec.o.visible === false) continue;
    builder.worldBoxOf(rec, _box);
    if (_box.isEmpty()) continue;
    if (x < _box.min.x - 0.01 || x > _box.max.x + 0.01) continue;
    if (z < _box.min.z - 0.01 || z > _box.max.z + 0.01) continue;
    if (_box.max.y <= yRef + 0.01) continue;       // 液面不在机位上方：无需处理
    if (_box.max.y > top) top = _box.max.y;
  }
  return top;
}

/** 单条射线：命中非玩家实体则回调 (距离, 世界法线) */
function castHit(world, x0, y0, z0, x1, y1, z1, playerBody, cb) {
  _from.set(x0, y0, z0);
  _to.set(x1, y1, z1);
  _hits.length = 0;
  world.raycastAll(_from, _to, { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: true }, (r) => {
    if (playerBody && r.body === playerBody) return;
    if (r.body && r.body.collisionResponse === false) return;
    _hits.push(r);
  });
  let bestD = Infinity, bestN = null;
  for (const h of _hits) {
    if (h.distance < bestD) { bestD = h.distance; bestN = h.hitNormalWorld; }
  }
  if (bestN) cb(bestD, bestN);
}

/**
 * 单条「自由距离」射线：从 (x,y,z) 沿 (dx,dy,dz) 打 maxD，忽略斜屋顶 / 坡道
 * （法线明显朝上下的一律不算堵，与 probeEnvironment 同一套规则），返回自由距离。
 * world === null 直接返回 maxD —— 无物理世界时全部退化为「到处都通」。
 */
function rayFree(world, x, y, z, dx, dy, dz, playerBody, maxD = 18) {
  if (!world) return maxD;
  const l = Math.hypot(dx, dy, dz) || 1;
  let free = maxD;
  _rayCost++;
  castHit(world, x, y, z, x + dx / l * maxD, y + dy / l * maxD, z + dz / l * maxD, playerBody, (d, n) => {
    if (Math.abs(n.y) > 0.6) return;      // 斜屋顶 / 坡道不算堵
    if (d < free) free = d;
  });
  return free;
}

/** 从 (x,y,z) 往上探到的可用净高（距离，不是绝对高度）；无天花板返回 maxD */
function ceilFreeAt(world, x, y, z, playerBody, maxD = 14) {
  if (!world) return maxD;
  _rayCost++;
  let h = maxD;
  castHit(world, x, y, z, x, y + maxD, z, playerBody, (d) => { if (d < h) h = d; });
  return h;
}

/** 记录在 t 处的水平轨迹切向（静态分析用，不带任何跨帧状态） */
function travelAt(data, t, out) {
  const a = data.sampleAt(clamp(t - 0.24, 0, data.duration), _sA);
  const b = data.sampleAt(clamp(t + 0.24, 0, data.duration), _sB);
  const dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz);
  if (l < 0.08) { out.set(Math.sin(b.fy), 0, Math.cos(b.fy)); return out; }
  out.set(dx / l, 0, dz / l);
  return out;
}

/** 包络表线性插值（超出范围取端点值）；空表返回 Infinity（调用方会退回静态值） */
function curveAt(arr, t0, dt, t) {
  if (!arr || !arr.length) return Infinity;
  const u = (t - t0) / dt;
  if (u <= 0) return arr[0];
  const i = Math.floor(u);
  if (i >= arr.length - 1) return arr[arr.length - 1];
  return arr[i] + (arr[i + 1] - arr[i]) * (u - i);
}

/** 三维表线性插值（语义同 `curveAt`，写入 out） */
function trackVec3(ax, ay, az, t0, dt, t, out) {
  return out.set(curveAt(ax, t0, dt, t), curveAt(ay, t0, dt, t), curveAt(az, t0, dt, t));
}

/**
 * 零相位一阶低通：前向 EMA 与后向 EMA **取平均**。
 * 一阶低通固有的相位滞后（τ = 1/速率）由后向那一遍抵消掉 —— 既稳又不拖。
 * 之所以能用后向，是因为回放是**录像**：整段未来已知，plan 期一次性算完即可。
 * @param src  Float64Array
 * @param rate 常数速率（1/s），或逐点速率的数组
 * @returns  Float64Array（与 src 等长）
 */
function fwdBackEMA(src, rate, dt) {
  const n = src.length;
  const out = new Float64Array(n);
  if (!n) return out;
  const num = typeof rate === 'number';
  const rAt = num ? null : (i) => rate[i];
  const f = new Float64Array(n), b = new Float64Array(n);
  f[0] = src[0];
  for (let i = 1; i < n; i++) f[i] = f[i - 1] + (src[i] - f[i - 1]) * (1 - Math.exp(-(num ? rate : rAt(i)) * dt));
  b[n - 1] = src[n - 1];
  for (let i = n - 2; i >= 0; i--) b[i] = b[i + 1] + (src[i] - b[i + 1]) * (1 - Math.exp(-(num ? rate : rAt(i)) * dt));
  for (let i = 0; i < n; i++) out[i] = (f[i] + b[i]) * 0.5;
  return out;
}

/**
 * 以 i 为中心的**对称** min 窗（半径 half 个采样点；两端自然收窄）。
 * 替代旧版的单边前瞻：单边只能「提前收」，收完还得再靠运行期去追；
 * 对称窗一次把「临近的窄处」烘进当前值，运行期不需要任何补偿。
 */
function symMin(src, half) {
  const n = src.length, out = new Float64Array(n);
  const h = Math.max(0, Math.round(half));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n - 1, i + h);
    let m = Infinity;
    for (let j = a; j <= b; j++) if (src[j] < m) m = src[j];
    out[i] = m;
  }
  return out;
}

/* ---------- 转场：二次贝塞尔 + 视线夹角 ---------- */
/** 二次贝塞尔：a → b，控制点 c，权重 w∈[0,1] */
function bez2(a, c, b, w, out) {
  const k = 1 - w;
  return out.set(
    k * k * a.x + 2 * k * w * c.x + w * w * b.x,
    k * k * a.y + 2 * k * w * c.y + w * w * b.y,
    k * k * a.z + 2 * k * w * c.z + w * w * b.z);
}

/** 取中点（写入 out） */
function _mid(a, b, out) { return out.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5); }

/** 两端视线方向夹角（rad）；任一视线近零长则视为 0（等价于「不用管」） */
function viewAngle(p0, l0, p1, l1) {
  _tmpE.copy(l0).sub(p0);
  _tmpF.copy(l1).sub(p1);
  const a = _tmpE.length(), b = _tmpF.length();
  if (a < 1e-4 || b < 1e-4) return 0;
  _tmpE.multiplyScalar(1 / a); _tmpF.multiplyScalar(1 / b);
  return Math.acos(clamp(_tmpE.dot(_tmpF), -1, 1));
}

/* ============================================================
   选镜规则
   ============================================================ */

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * 依据「动作类型 + 环境探测」挑一种运镜
 * 可用性优先：净空不足就上不了摇臂、升不了机位；涉水就多给俯瞰
 * @param v 多样剪辑的版本参数（null = 基准排片）：只用来调候选顺序与排除项，
 *          下面每一道过滤（续镜去重 / 大景别净空 / 俯拍天花板门槛 / 狭窄安全集）照旧执行
 */
function chooseShotType(info, env, taken, prevType, i, n, v) {
  const deep = env.submerged > 1.1;
  const last = i === n - 1;
  const narrow = env.openness < NARROW_OPEN;      // 狭窄空间：只考虑「沿轴向 / 竖直向」的机位
  // ★ 泳区（见 `_swimZones`）：落水满 SWIM_ZONE_T 秒还没出水，镜头语言**立刻**整体换成
  //   「贴着主体走」的那三种（POV / 迎面引导 / 肩后跟随）。
  //   这里直接返回、不走下面的候选池：那三种全是沿轴向 / 眼睛上的机位，
  //   既不吃横向净空、也不是俯拍，本来就不会被下面任何一道闸门挡掉；
  //   而候选池里的横摆机位（环绕 / 摇臂 / 平移）在水里只能被挤成贴脸长焦。
  //   三种之间按「不重复上一镜 → 避开最近用过的 → 轮转次序」挑，
  //   于是同一个泳区里连续几镜自然轮换，不同泳区之间也不会每次从同一种开始。
  if (info.swimZone) {
    const pool = SWIM_ZONE_CAMS.slice();
    const rot = Math.abs(i | 0) % pool.length;
    for (let j = 0; j < rot; j++) pool.push(pool.shift());
    for (const t of pool) if (t !== prevType && !taken.has(t)) return t;
    for (const t of pool) if (t !== prevType) return t;
    return pool[0];
  }
  const cand = [];
  if (i === 0) cand.push('pullOut', 'descent', 'crane', 'topOrbit', 'orbit', 'steadicam', 'topDown', 'static');   // 开场建立
  const k = info.kind;
  // 注意：低角度仰拍（lowHero）不再进任何自动候选池 ——
  // 贴着地面往上仰视一个不停移动的主体，画面里「地平线」是被甩动的，
  // 那是晕 3D 最典型的一种构图。它仍保留在镜头库里，剪辑面板里可以手动指定。
  // 俯拍一族（俯瞰 / 高空环绕 / 无人机俯追 / 直升机悬停 / 高空降落）刻意铺得广：
  // 它们机位高、视线朝下，画面里没有会「甩」的水平线，是全场最稳的一类机位。
  if (k === 'death') cand.push('pushIn', 'static', 'track');
  else if (k === 'win') cand.push('pullOut', 'helicopter', 'crane', 'topOrbit', 'orbit', 'lead');
  else if (k === 'lowAir' || k === 'hurt') cand.push('pushIn', 'track', 'droneTrack', 'steadicam');
  else if (k === 'dive' || k === 'enterWater' || k === 'swim') cand.push('topDown', 'droneTrack', 'helicopter', 'steadicam', 'track');
  else if (k === 'climb' || k === 'walljump') cand.push('droneTrack', 'topDown', 'steadicam', 'track', 'orbit');
  else if (k === 'zipline') cand.push('droneTrack', 'lead', 'track', 'crane', 'topDown');
  else if (k === 'slide' || k === 'sprint') cand.push('droneTrack', 'steadicam', 'track', 'lead', 'swing');
  else if (k === 'jump') cand.push('droneTrack', 'track', 'orbit', 'swing', 'pushIn');
  else cand.push('droneTrack', 'static', 'topOrbit', 'orbit', 'crane', 'pushIn', 'steadicam');
  if (last) cand.unshift('descent', 'pullOut', 'crane', 'topOrbit', 'orbit');    // 收尾留白
  // 沉浸 POV：只在「人在水里 / 短促危险镜头」偶尔插一镜，做主观冲击
  if (!last && i > 0 && (deep || k === 'swim' || k === 'dive' || k === 'lowAir' || k === 'death')) {
    cand.splice(Math.min(2, cand.length), 0, 'pov');
  }
  if (info.pref) for (const t of info.pref) { if (t !== 'lowHero') cand.push(t); }
  // ★ 风格偏好：把这一版的偏好运镜提到「兜底三项」之前 —— 顺序即优先级。
  //   只改顺序，不动下面任何一道闸门：排不进（净空 / 天花板 / 去重不过）就自然落到下一个。
  if (v && v.bias.length) for (const t of v.bias) cand.push(t);
  cand.push('track', 'static', 'steadicam');

  // 狭窄空间：横摆机位（平移 / 环绕 / 摇臂 / 拉轨 / 弧摆）根本没地方站，
  // 硬塞进去只能贴脸 + 长焦，是眩晕的头号来源。改用沿轴向的几种：
  // POV（人眼视角）、后方轨迹跟拍、前方轨迹（朝轨迹反方向）迎面引导、俯瞰。
  let list = narrow ? cand.filter((t) => NARROW_OK.has(t)) : cand;
  // 风格排除项（如「大弧运动」不用原地不动）：狭窄安全集不参与排除，兜底永远有镜可用
  if (v && v.avoid.size && !narrow) list = list.filter((t) => !v.avoid.has(t));
  // 过滤后往往只剩一两种（比如「原地」段只有斯坦尼康），把同属安全集的其余几种
  // 补在后面做兜底，顺序仍然是「斯坦尼康优先」，走廊里才不会整段整段只有一个机位。
  if (narrow && list.length < 3) {
    for (const t of ['steadicam', 'lead', 'follow', 'topDown', 'droneTrack', 'pov']) {
      if (!list.includes(t)) list.push(t);
    }
  }
  for (const t of (list.length ? list : ['steadicam', 'lead', 'follow', 'topDown', 'droneTrack', 'pov'])) {
    const def = SHOT_TYPES[t];
    if (!def) continue;
    // 连续两镜不要同一种（跟拍类除外：长追逐本来就该是一个机位跟到底）
    if (t === prevType && !FOLLOW_CAM.has(t) && t !== 'track' && !narrow) continue;
    // 拉不开距离就别用大景别（沿轴向的机位不吃这条：它们要的距离在纵向，跟横向净空无关）。
    // 阈值取 dist 的 0.45：镜头库的标称距离整体调远过，这里必须同比放宽，
    // 否则「距离变远」只体现在数字上，室内会被这条一直挡掉。
    if (!AXIAL_CAM.has(t) && OPEN_SCOPE.has(def.scope) && env.openness < def.dist * 0.45) continue;
    // 俯拍一族都要头顶空间：低于门槛就退成普通高度的机位（那不是俯拍，不如换一种）
    if (t === 'topDown' && env.ceiling < 3.6) continue;
    if (t === 'droneTrack' && env.ceiling < 4.6) continue;
    if ((t === 'topOrbit' || t === 'helicopter') && env.ceiling < 6.5) continue;
    if (t === 'descent' && env.ceiling < 8) continue;
    if (t === 'crane' && env.ceiling < def.h + 3) continue;
    if (t === 'pov' && !info.wet && !narrow) continue;                  // 狭窄空间允许用 POV 顶一镜
    if (taken.has(t)) continue;
    return t;
  }
  return narrow ? 'steadicam' : 'track';
}

/**
 * 依据镜头类型决定「机位相对主体的方位角」，并保证与上一镜错开 ≥ minGap（换轴规则）。
 * 返回的是**世界绝对角**（rad）：`baseYaw` 是该镜头关键帧处角色的朝向，
 * 只用来给「第一镜 / 跟拍类」定一个相对好看的初始角，之后的错开都在绝对角上做 ——
 * 这样相邻两镜在世界上是真的错开了 ≥36°，而不是「各自相对朝向错开」那种假错开。
 * @param ladder 换轴阶梯（多样剪辑按版本轮转 / 翻转；null = 默认阶梯）——
 *               无论用哪条阶梯，都仍要过 `Math.abs(o) >= minGap` 这一关
 */
function pickAzimuth(type, prevAzim, minGap, baseYaw, ladder) {
  const y0 = Number(baseYaw) || 0;
  if (FOLLOW_CAM.has(type)) return prevAzim === null ? y0 + 0.9 : prevAzim;   // 跟拍不吃方位角
  if (TRAVEL_CAM.has(type)) return y0;                                        // 沿轨迹布机：相对轨迹的方位恒为「正后」
  const base = type === 'lead' ? y0 + Math.PI : null;                         // 迎面引导：机位在正前
  if (prevAzim === null) return base === null ? y0 + 0.9 : base;
  if (base === null) {
    for (const o of (ladder || AZIM_LADDER)) {
      if (Math.abs(o) >= minGap) return prevAzim + o;
    }
    return prevAzim + minGap;
  }
  const g = angDiff(base, prevAzim);
  if (Math.abs(g) >= minGap) return base;
  return prevAzim + (g >= 0 ? 1 : -1) * minGap;
}

/* ============================================================
   运镜时间轴（全程覆盖）
   ============================================================ */
/**
 * clips: [{ t0, t1, outT0, outDur, kind, label, intensity, env, shot, speed, index }]
 * 时间轴恒等映射：srcT === movieT，outT0 === t0、outDur === t1 - t0（speed 恒为 1）。
 */
export class Montage {
  /**
   * @param data ReplayData
   * @param ctx  { world, builder, playerBody, level, rhythm }
   *   rhythm —— BGM 节奏点表（audio.getRhythm 的产物：逐帧频谱瞬态检出的鼓点 / 重音时刻）；
   *             给了就「卡点」：切点优先吸附到最近的节奏点上。
   */
  constructor(data, ctx = {}) {
    this.data = data;
    this.ctx = ctx;
    this.clips = [];
    this.duration = data.duration || 0;
    this.azimGap = Math.PI / 5;      // 36°：相邻两镜的最小换轴（多样剪辑会按版本覆盖）
    this._spec = null;               // 当前的「风格 + 种子」原始设定（{ style, seed } | null）
    this.variant = null;             // 解出来的版本参数（null = 基准排片）
    this.rhythm = ctx.rhythm || null;  // BGM 节奏点表（null = 无 BGM / 认不出节奏 → 退回拐点吸附）
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._stay = new THREE.Vector3();   // 斯坦尼康机身（跨帧记忆）
    this._anchor = new THREE.Vector3();  // 主体锚点（低通后的位置，抹掉 15Hz 采样的微抖）
    this._anchorOk = false;
    this._corr = new THREE.Vector3();   // 碰撞修正量的低通状态（曲线滤波）
    this._shrink = 0;                   // 视线遮挡的收缩预算（_safePlace 距离决策的低通状态）
    this._ca = 0;                       // 轨迹切向的当前角度（跨帧记忆，限速用）
    this._tanOk = false;
    this._jerk = 0;                     // 主体「急动」程度 0~1（蹬墙 / 快速左右跳时拉满）
    this._mv = { vk: false, x: 0, z: 0, vx: 0, vz: 0 };
    this._lastSrcT = null;
    this._view = new THREE.Vector3();   // 上一帧的视线方向（视线角速度限速用）
    this._viewOk = false;
    this._clipIx = -1;
    this._fov = FOV_MIN;                // 首帧之前的值；随后每帧由 clipFov 覆盖
    this._peakIx = -1;
    // POV 俯仰的智能平滑状态（见 `povSmoothPitch`）。它是 `_solve` 依赖的跨帧记忆，
    // 所以要进 `_takeState` / `_putState` 的借出清单：plan 期做转场分析不能污染它。
    this._povP = { v: null };
    // 转场：每个切点一条 link（cut / dip / fly），以及飞渡起始视场角
    this.links = [];
    this._flyFrom = null;
    this.fade = 0;                 // 当前遮罩强度 0~1（黑场 / 白场由 fadeColor 决定）
    this.fadeColor = DIP_COLOR_DEF;
    // 最终级平滑：真正写进相机的姿态（位移 + 对焦点）与前馈用的速度估计。
    // 只在 `update` 的收尾用到，不参与 `_solve`，所以不必进 `_takeState` 的借出清单。
    this._smP = new THREE.Vector3();       // 平滑后的机位
    this._smL = new THREE.Vector3();       // 平滑后的对焦点（「角度平滑」走这条）
    this._smTP = new THREE.Vector3();      // 上一帧的原始机位（差分求速度）
    this._smTL = new THREE.Vector3();      // 上一帧的原始对焦点
    this._smVel = new THREE.Vector3();
    this._smVelL = new THREE.Vector3();
    this._smOk = false;
    this._smT = -1;                        // 上一帧的拍摄时间（拖进度条 / 瞬移检测）
    // 运镜整体提前量（秒）：相机按「播放时间 + lead」取运镜，角色仍按真实播放时间取位置。
    // 见文件头 LEAD_SHIFT 处的说明；0 = 关闭。运行期可直接赋值（UI 里没有这个旋钮）。
    this.lead = LEAD_SHIFT;
  }

  /**
   * 设定「风格 + 种子」（多样剪辑）。传 null / 空 = 基准排片（与历史版本逐字段一致）。
   * 只解参数、不动任何安全闸门；`azimGap` 也随之按版本覆盖。
   * @param spec { style, seed } | null
   * @returns 解出来的版本参数（null = 基准）
   */
  setVariant(spec) {
    this._spec = (spec && spec.style) ? { style: spec.style, seed: Math.round(Number(spec.seed) || 0) } : null;
    this.variant = this._spec ? makeVariant(this._spec.style, this._spec.seed) : null;
    this.azimGap = this.variant ? this.variant.azimGap : Math.PI / 5;
    return this.variant;
  }

  /** 当前的「风格 + 种子」设定（供 UI 显示 / 会话重启还原） */
  get variantSpec() { return this._spec; }

  /**
   * 装 / 换 BGM 节奏点表（异步检测完成后由回放器补上）。
   * 机位曲线是 plan 期烘出来的，改完要重新 plan 才影响切点。
   */
  setRhythm(rhythm) {
    this.rhythm = rhythm || null;
    return this.rhythm;
  }

  /**
   * 综合调制参数：镜头「远离主体」的努力程度（1.0 = 基准）。
   * `rp.montage.retreat = 1.35` 与 `setCameraRetreat(1.35)` 等价。
   * 注意：机位曲线是 plan 期烘出来的，赋值后要重新 plan / 面板「应用」才影响机位。
   */
  get retreat() { return RETREAT; }
  set retreat(v) { setCameraRetreat(v); }

  /**
   * 跟镜期的智能远近调制（1.0 = 基准；>1 更远，<1 更近）。
   * 与 `retreat` 的区别：retreat 是 plan 期的「布置」（改完要重新 plan），
   * 这个是**跟镜期逐帧**的远近 —— 改完下一帧就能看出来，不用重新 plan。
   * 详见文件上方 LIVE_DIST 处的说明。
   */
  get liveDist() { return LIVE_DIST; }
  set liveDist(v) { setCameraLiveDist(v); }

  /**
   * 综合调制参数：整体平滑程度（1.0 = 基准；>1 更稳更慢，<1 更跟手更抖）。
   * 与 `retreat` 一样落到模块级 `SMOOTH`：`rp.montage.smooth = 2` 与
   * `setCameraSmooth(2)` 等价。区别是这里**逐帧生效** —— 改完只重烘各段的
   * motion 表（锚点 / 切向 / 急动的零相位表），不必重排片、也不必重新打射线。
   */
  get smooth() { return SMOOTH; }
  set smooth(v) {
    setCameraSmooth(v);
    // SMOOTH 进了 motion 表的烘焙（速率 / 前瞻），改完必须重烘一遍，
    // 否则运行期查到的还是旧速率 —— 「逐帧生效」的承诺就落空了。
    this._rebakeMotion();
  }

  /* ============================================================
     转场：借出 / 还回跨帧解算状态
     ------------------------------------------------------------
     求「某镜在 t 时刻的标称姿态」会动用 _solve，而 _solve 依赖一串跨帧记忆
     （锚点低通、斯坦尼康机身、视线限速…）。plan 期做转场分析时不能污染它们，
     所以先把这些字段整体借出、算完再原样放回。
     ============================================================ */
  _takeState(o) {
    o.anchor = this._anchor.clone();
    o.anchorOk = this._anchorOk;
    o.stay = this._stay.clone();
    o.look = this._look.clone();
    o.ca = this._ca;
    o.tanOk = this._tanOk;
    o.jerk = this._jerk;
    o.fov = this._fov;
    o.clipIx = this._clipIx;
    o.view = this._view.clone();
    o.viewOk = this._viewOk;
    o.povV = this._povP.v;
    return o;
  }
  _putState(o) {
    this._anchor.copy(o.anchor); this._anchorOk = o.anchorOk;
    this._stay.copy(o.stay);
    this._look.copy(o.look);
    this._ca = o.ca; this._tanOk = o.tanOk; this._jerk = o.jerk;
    this._fov = o.fov; this._clipIx = o.clipIx;
    this._view.copy(o.view); this._viewOk = o.viewOk;
    this._povP.v = o.povV;
  }

  /**
   * 某镜在 t 时刻的「标称姿态」：只做单帧解算，不带任何跨帧滤波。
   * 用于转场分析（比较 A 镜末端与 B 镜首端隔多远）—— 必须确定性。
   */
  _nominalPose(clip, t, outPos, outLook) {
    const st = this._takeState(_nkState);
    const s = this.data.sampleAt(clamp(t, 0, this.duration), _nkS);
    const mo = clip.motion;
    if (mo) {
      // 与运行期**同源**：锚点 / 急动 / 切向全部查同一张烘焙表 ——
      // 标称姿态与运行期因此逐元素一致，飞渡窗口两端不会各自跳一下。
      trackVec3(mo.ax, mo.ay, mo.az, mo.t0, mo.dt, t, this._anchor);
      this._jerk = clamp(curveAt(mo.jerk, mo.t0, mo.dt, t), 0, 1);
    } else {
      // 旧路径（POV / 段过短）：锚点取「前瞻点」，与运行期原因果路径一致
      const lmulN = AHEAD_CAM.has(clip.shot.type) ? AHEAD_LEAD_MUL : 1;
      const ld = this.data.sampleAt(clamp(t + clamp(s.sp * sLead(LEAD_K * lmulN), 0, sLead(LEAD_MAX * lmulN)), 0, this.duration), _sLead);
      this._anchor.set(ld.x, ld.y, ld.z);
      this._jerk = 0;
    }
    this._anchorOk = true;
    this._stay.set(0, 0, 0);
    this._look.set(0, 0, 0);
    this._tanOk = false;
    const u = clamp((t - clip.t0) / Math.max(0.01, clip.t1 - clip.t0), 0, 1);
    // 距离 / 高度也必须与运行期同源：运行期读的是**包络表**（再乘 LIVE_DIST），
    // 标称若退回 planDist，飞渡窗口两端就会差出「包络收缩量」—— 等于自己又造一次跳变。
    const cu = clip.shot.curve;
    const dist = cu
      ? Math.max(cu.minDist, Math.min(clip.shot.dist, curveAt(cu.d, cu.t0, cu.dt, t))) * LIVE_DIST
      : clip.shot.dist * LIVE_DIST;
    const ht = cu
      ? Math.max(0.9, Math.min(clip.shot.h, curveAt(cu.h, cu.t0, cu.dt, t)))
      : clip.shot.h;
    const shot = {
      ...clip.shot, dist, h: ht,
      t, local: t - clip.t0, u, dur: clip.t1 - clip.t0, wet: !!s.headUnder, m: mo,
    };
    this._solve(shot, s, outPos, outLook, 1 / 60, true);
    this._putState(st);
  }

  /* ============================================================
     转场分析（plan 期）：每个切点决定 cut / dip / fly
     ============================================================ */
  /**
   * 一条飞行路径是否全程安全。
   * 逐点验三件事：脚底有地（不悬空钻楼板）、头顶有天（不穿天花板）、四周不贴墙（不擦着墙面飞）；
   * 再验每段之间没有实体横在中间。
   * 注意：测地 / 顶必须用 `castHit`（不滤法线）—— `rayFree` 会把斜屋顶当空气，
   * 用它测地板永远得到「脚下是空的」。
   * @param loose 见下（只给「极短微滑移」用；长途飞渡一律走全量校验）
   */
  _pathClear(pts, loose) {
    const world = this.ctx.world, pb = this.ctx.playerBody;
    if (!world) return true;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // `loose`（极短微滑移专用）只验「两点之间有没有实体」，不做离地 / 离顶 / 离墙余量：
      // 那三条余量是给长途飞渡用的舒适度约束，而微滑移的两端就是运行期镜头此刻所在的位置 ——
      // 它离墙多近都是既成事实，再拿「离墙 0.6」去否掉它，只会把一次 2.4 studs 的滑移
      // 退化成一次硬跳。擦着墙角滑过去，远比硬跳不显眼。
      if (!loose) {
        let g = Infinity;
        castHit(world, p.x, p.y, p.z, p.x, p.y - 3, p.z, pb, (d) => { if (d < g) g = d; });
        _rayCost++;
        if (g < 0.5) return false;                     // 离地太近：会擦着台面 / 穿进地板
        let c = Infinity;
        castHit(world, p.x, p.y, p.z, p.x, p.y + 3, p.z, pb, (d) => { if (d < c) c = d; });
        _rayCost++;
        if (c < 0.5) return false;                     // 顶到天花板
        for (let k = 0; k < 4; k++) {                  // 水平四向：别擦着墙面飞
          const a = k * Math.PI * 0.5;
          if (rayFree(world, p.x, p.y, p.z, Math.sin(a), 0, Math.cos(a), pb, 2) < 0.6) return false;
        }
      }
      if (i + 1 < pts.length) {                        // 段中间不许有实体
        const q = pts[i + 1];
        const seg = p.distanceTo(q);
        if (seg > 0.02) {
          let b = Infinity;
          castHit(world, p.x, p.y, p.z, q.x, q.y, q.z, pb, (d) => { if (d < b) b = d; });
          _rayCost++;
          if (b < seg - 0.06) return false;
        }
      }
    }
    return true;
  }

  /**
   * 迭代避障地找一条从 A 机位到 B 机位的飞渡路径（二次贝塞尔）。
   * 终点必须精确落在两端的标称姿态上（不能为了避障把落点挪走，否则飞渡结束那帧又跳一下），
   * 所以只调「控制点」：固定顺序的候选阶梯（确定性，禁止随机）
   *   ① 直线 → ② 顶点抬高 1.5 / 3.0 / 5.0 / 7.5 → ③ 抬高 2.5 再侧移 ±1.5 / ±3.0。
   * 每档采 7 点验证；预算超了或全失败返回 null（调用方退回黑场或硬切）。
   * 视线控制点固定取两端视点中点（直线插值视线），镜头随之俯仰 —— 读起来像摇臂起落。
   * @param loose 极短微滑移：只走「直线」一档、且只验段间有无实体（见 `_pathClear`）。
   *   位移不到 2.6 studs，抬 7.5 那一档本身就荒谬；直线过不去（真有一堵墙横在两端之间）
   *   才退回硬切。
   * @returns { c, cl } 控制点（新对象，会被 link 长期持有）或 null
   */
  _fitFlyPath(p0, l0, p1, l1, loose) {
    const c = new THREE.Vector3((p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5, (p0.z + p1.z) * 0.5);
    const cl = new THREE.Vector3((l0.x + l1.x) * 0.5, (l0.y + l1.y) * 0.5, (l0.z + l1.z) * 0.5);
    if (!this.ctx.world) return { c, cl };            // 无物理世界：直线即通
    const base = _rayCost;
    let hx = p1.x - p0.x, hz = p1.z - p0.z;
    const hl = Math.hypot(hx, hz);
    if (hl > 1e-4) { hx /= hl; hz /= hl; } else { hx = 0; hz = 1; }
    const px = -hz, pz = hx;                          // 水平垂向（侧移方向）
    // [顶点抬升, 顶点侧移]；二次贝塞尔在中点处的偏移是控制点偏移的一半，故控制点乘 2
    const ladder = loose ? [[0, 0]] : [
      [0, 0], [1.5, 0], [3.0, 0], [5.0, 0], [7.5, 0],
      [2.5, 1.5], [2.5, -1.5], [2.5, 3.0], [2.5, -3.0],
    ];
    for (const [ay, ax] of ladder) {
      if (_rayCost - base > LINK_RAY_BUDGET) return null;
      _nkC.set(c.x + px * ax * 2, c.y + ay * 2, c.z + pz * ax * 2);
      for (let k = 0; k < 7; k++) bez2(p0, _nkC, p1, k / 6, _nkPts[k]);
      if (!this._pathClear(_nkPts, loose)) continue;
      return { c: _nkC.clone(), cl };
    }
    return null;
  }

  /**
   * 切点附近是不是一次「传送 / 重生」。
   * 存档里没有 teleport 事件（`ActionRecorder` 只推导航为类事件），所以从位置列的断点反推：
   * 相邻采样点的位移超过 TELEPORT_JUMP 就当成一次瞬移 —— 顺带把重生也一起覆盖了，
   * 两者对镜头的要求完全一样（画面里都是一个「人凭空换了个地方」）。
   * 只看切点前后各两个采样段（15Hz → 约 ±0.2s）：远处的传送与本切点无关。
   * @returns { t, d } 断点时刻与传送距离；没有则 null
   */
  _teleportAt(tb) {
    const c = this.data.c, n = this.data.n;
    if (!c || !n) return null;
    const i = this.data.indexAt(tb);
    let best = null;
    const hi = Math.min(n - 1, i + 2);
    for (let k = Math.max(0, i - 2); k < hi; k++) {
      const d = Math.hypot(c.x[k + 1] - c.x[k], c.y[k + 1] - c.y[k], c.z[k + 1] - c.z[k]);
      if (d >= TELEPORT_JUMP && (!best || d > best.d)) best = { t: c.t[k + 1], d };
    }
    return best;
  }

  /**
   * 全部「传送 / 重生」时刻（位置列上相邻采样点的位移 ≥ TELEPORT_JUMP）。
   * `_landmarks` 与 `_bounds` 都从这里取，避免同一次扫描写两遍。
   * 断点时刻取 `c.t[k + 1]`：位移是「从 k 走到 k+1」发生的，瞬移落在后一个采样点上。
   */
  _teleportTimes() {
    const c = this.data.c, out = [];
    if (!c || !c.x) return out;
    for (let i = 0; i + 1 < c.x.length; i++) {
      const dx = c.x[i + 1] - c.x[i], dy = c.y[i + 1] - c.y[i], dz = c.z[i + 1] - c.z[i];
      if (dx * dx + dy * dy + dz * dz >= TELEPORT_JUMP * TELEPORT_JUMP) out.push(c.t[i + 1]);
    }
    return out;
  }

  /**
   * 机位是不是「完全看不到角色」—— 黑白场遮罩的**唯一**判据（与位移距离无关）。
   * 从机位分别向主体的**头**（脚底上方 HEAD_H）与**脚**（FOOT_H）各打一条射线，
   * 角色自身不算碰撞：
   *   · 两条都被实体挡住 → 看不见：切完观众彻底跟丢主体，必须黑 / 白一下；
   *   · 只挡一条（挡头露脚 / 挡脚露头）→ 仍看得见：主体还有大半在画面里，硬切读得出来，
   *     不该白白黑一下。
   * 打两条而不是一条（旧版只打胸口一条）：胸口被矮墙挡住但头与脚都露着时，画面里的角色
   * 依然是明确的 —— 单一射线会把这种情况误判成「看不见」。
   */
  _camBlind(cp, s) {
    const world = this.ctx.world;
    if (!world) return false;                 // 空世界：什么都挡不住，一定看得见
    return this._blocked(cp, s.x, s.y + HEAD_H, s.z, world)
      && this._blocked(cp, s.x, s.y + FOOT_H, s.z, world);
  }

  /** 机位到某点之间有没有实体挡着（角色自身不算撞）；判据与余量见 SEE_SLACK */
  _blocked(cp, x, y, z, world) {
    const dx = x - cp.x, dy = y - cp.y, dz = z - cp.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    let hit = Infinity;
    castHit(world, cp.x, cp.y, cp.z, x, y, z, this.ctx.playerBody, (d) => { if (d < hit) hit = d; });
    _rayCost++;
    return hit <= len - SEE_SLACK;
  }

  /**
   * 逐切点决定转场方式，并把结果挂到前后两镜上（a.linkOut / b.linkIn）。
   * 判据是「A 镜末端姿态」与「B 镜首端姿态」的位移与视线夹角，外加一条**遮挡**判定：
   *   · 位移 < 2.6 且视线转角 < 24° → glide（极短微滑移，0.2~0.45s）；
   *                                    路径验证不过才退回 cut（位移这么小，退回也看不出）
   *   · 其余                          → 先试 fly（≤FLY_DIST_MAX 且路径可达）
   *   · 飞不过去（结构挡着 / 太远）    → **看得见角色就硬切，看不见才黑白场**
   * 黑白场的触发**只看遮挡、不看距离**：从 B 镜首帧的机位分别向主体头、脚各打一条射线，
   * 两条都被实体挡住（角色自身不算）才算「切完观众跟丢了主体」，才值得遮一下。
   * 时间轴仍恒等：link 只在切点 ±0.45s 内产生遮罩或路径插值，不删减任何画面。
   */
  _linkClips(clips) {
    this.links = [];
    this._flyFrom = null;
    if (!clips || clips.length < 2) return;
    const saveCost = _rayCost;
    const base = _rayCost;
    const N = clips.length;
    const links = new Array(N).fill(null);
    for (let i = 0; i + 1 < N; i++) {
      const a = clips[i], b = clips[i + 1];
      const tb = b.t0;
      const halfCap = FLY_HALF_SHARE * Math.min(a.t1 - a.t0, b.t1 - b.t0);
      // 两端标称姿态：A 的最后一帧、B 的第一帧（单帧解算，不带跨帧滤波）
      this._nominalPose(a, Math.max(a.t0, a.t1 - 1 / 60), _nkPA, _nkLA);
      this._nominalPose(b, Math.min(b.t1, b.t0 + 1 / 60), _nkPB, _nkLB);
      const jump = _nkPA.distanceTo(_nkPB);
      const ang = viewAngle(_nkPA, _nkLA, _nkPB, _nkLB);
      const L = {
        tb, mode: 'cut', color: DIP_COLOR_DEF, dur: 0,
        p0: null, l0: null, p1: null, l1: null, c: null, cl: null, anchor: null,
        // 飞渡窗口「尾端」该用的视场角：B 镜的基准值。预分析烘进来之后运行期只做插值，
        // 不必逐帧拿射线命中距离反算（那样视场角会在窗口里呼吸，且窗口正中当前镜头
        // 从 A 换到 B 时基准值一帧内就换掉了 —— 正是「角度上的跳变」）。
        fov1: fovFor(b.shot.type),
      };
      const tp = this._teleportAt(tb);
      const kd = a.kind === 'death' || b.kind === 'death';
      const kw = !kd && (a.kind === 'win' || b.kind === 'win');
      // ★ 黑白场的唯一判据：切完之后观众所在的机位（B 镜首帧的标称姿态）是不是
      //   **真的看不到角色**。必须在取飞渡窗口端点之前算 —— 下面 `_nominalPose(b, …)`
      //   会把 `_nkPB` 覆写成窗口尾端的机位。
      const sCut = this.data.sampleAt(clamp(tb, 0, this.duration), _nkS2);
      const blind = this._camBlind(_nkPB, sCut);
      // 传送切点不参与 glide：瞬移靠「微滑移」是滑不过去的
      const glide = !tp && jump < LINK_CUT_DIST && ang < LINK_CUT_ANG;
      // 时长只由位移决定（与路径是否可达无关），先定下来再去两端取终点
      let dur;
      if (glide) {
        dur = clamp(GLIDE_T_MIN + jump / LINK_CUT_DIST * (GLIDE_T_MAX - GLIDE_T_MIN), GLIDE_T_MIN, GLIDE_T_MAX);
      } else {
        dur = clamp(
          FLY_T_MIN + (jump - LINK_CUT_DIST) / Math.max(0.01, FLY_DIST_MAX - LINK_CUT_DIST) * (FLY_T_MAX - FLY_T_MIN),
          FLY_T_MIN, FLY_T_MAX);
      }
      dur = Math.min(dur, halfCap);
      // 「一票否决」：命中任何一条就跳过路径预分析，直接落回 cut / dip
      let veto;
      if (blind) veto = true;                         // 切完看不见人 → 必须遮住，飞渡也不用试了
      else if (tp) veto = dur < GLIDE_T_MIN;          // 传送只剩「窗口短到没意义」一条否决
      else if (glide) veto = dur < 0.14;              // 窗口短到没有意义（相邻镜头太短），不如硬切
      else veto = jump > FLY_DIST_MAX;                // 跨大半个关卡，路线多半不可达
      if (!veto) {
        // 终点取「飞渡窗口两端」的标称姿态：窗口边界处正好接上两镜各自的解析轨迹，
        // 这样飞渡只在切点附近改写画面，进出窗口都不产生新的跳变。
        const half = dur * 0.5;
        this._nominalPose(a, clamp(tb - half, a.t0, a.t1), _nkPA, _nkLA);
        this._nominalPose(b, clamp(tb + half, b.t0, b.t1), _nkPB, _nkLB);
        const path = this._fitFlyPath(_nkPA, _nkLA, _nkPB, _nkLB, glide);
        if (path) {
          L.mode = 'fly'; L.dur = dur;
          L.p0 = _nkPA.clone(); L.l0 = _nkLA.clone();
          L.p1 = _nkPB.clone(); L.l1 = _nkLB.clone();
          L.c = path.c; L.cl = path.cl;
          const sa = this.data.sampleAt(clamp(tb, 0, this.duration), _nkS);
          L.anchor = { x: sa.x, y: sa.y, z: sa.z };
        } else if (!glide) veto = true;
      }
      // 飞不过去 —— 结构挡着（路径迭代避障全失败 / 超预算）或太远 —— 才落回遮罩；
      // 但**只有真的看不到角色才遮**：看得见主体时硬切读得出来，白白黑一下反而更打断。
      // glide 除外：位移本来就小于 LINK_CUT_DIST，硬切看不出接缝，退回 cut 即可。
      if (L.mode !== 'fly' && !glide) {
        L.mode = blind ? 'dip' : 'cut';
        L.color = kw ? DIP_COLOR_WIN : DIP_COLOR_DEF;
      }
      a.linkOut = L; b.linkIn = L;
      links[i] = L;
    }
    this.links = links;
    _linkCost = _rayCost - base;
    _rayCost = saveCost;      // 借出后原样还回：转场分析不占静态分析的预算
  }

  /* ---------- 距离 / 高度的射线分析（静态：plan 期） ---------- */
  /**
   * 景别档：固定表 + 开场 / 收尾 / 高潮覆盖。全自动、无面板控件、无随机
   * —— 同一回放重复 plan（拖进度条、面板「应用」）必须逐字段一致。
   * 多样剪辑只换「表本身」（轮转 / 反向后的同一张表），开场 / 收尾 / 高潮的覆盖不变。
   */
  _sizeFor(i, flags) {
    if (flags.isOpen || flags.isLast) return 'far';       // 开场建立 / 收尾留白
    if (flags.isPeak) return (i % 2) ? 'med' : 'near';    // 高潮收紧
    const seq = this.variant ? this.variant.sizeSeq : SIZE_SEQ;
    return seq[i % seq.length];
  }

  /**
   * 射线预算档位：超预算就降采样，仍是确定性的（同一 (style, seed) 结果逐字段一致）。
   * `step` 是**包络表的网格步长**（不参与静态分析的时刻取样）：
   *   基准 1/15s（记录的原生率）→ 超预算 1/10s → 再超 1/6s。
   * 先降层数与弧内角（它们对「测得多准」影响更小），把网格留到最后才放宽。
   */
  _q() {
    if (_rayCost > RAY_BUDGET * 2) return { layers: 2, angles: 3, step: 1 / 6 };
    if (_rayCost > RAY_BUDGET) return { layers: 2, angles: 3, step: 1 / 10 };
    return { layers: 3, angles: 5, step: 1 / 15 };
  }

  /**
   * 该类型机位的基准高度（脚底以上）。
   * 注意 probeEnvironment 的 `ceiling` 是「从眼睛高度（脚底 +2.4）往上量」的距离，
   * 与脚底高度不是一回事 —— 这里必须换算，否则低天花板会被当成高天花板。
   */
  _planHeight(type, env) {
    const def = SHOT_TYPES[type] || SHOT_TYPES.static;
    const ceilH = 2.4 + (env ? env.ceiling : 14);
    if (AERIAL_CAM.has(type)) return clamp(Math.min(def.h, ceilH - 0.9), 2.4, def.h);
    return Math.max(0.9, Math.min(def.h, ceilH - 0.7));
  }

  /** 该类型的高度层：低 / 基准 / 高（去重；超额度时优先保留靠近基准层的那些） */
  _layers(planH, ceilH, max = 3) {
    const hi = Math.max(planH, Math.min(planH + 1.5, ceilH - 0.7));
    const lo = Math.max(0.9, Math.min(planH * 0.55, planH));
    const all = [];
    for (const v of [lo, planH, hi]) if (!all.some((u) => Math.abs(u - v) < 0.35)) all.push(v);
    if (all.length > max) {
      all.sort((a, b) => Math.abs(a - planH) - Math.abs(b - planH));
      all.length = max;
      all.sort((a, b) => a - b);
    }
    return all;
  }

  /** 该时刻机位实际用的方位角（与 `_solve` 各 case 的公式逐条对齐） */
  _azimNow(type, azim, u, wind) {
    switch (type) {
      case 'orbit': return azim + wind * u * 0.85;
      case 'topOrbit': return azim + wind * u * 1.5;
      case 'swing': return azim + (u - 0.5) * 0.8;
      case 'crane': return azim + (u - 0.5) * 0.3;
      case 'helicopter': return azim + (u - 0.5) * 0.24;
      case 'descent': return azim + (u - 0.5) * 0.18;
      default: return azim;
    }
  }

  /**
   * 机位相对对焦点的水平方向（写进 out，单位向量）+ 它沿这个方向张开的比例。
   * 逐条与 `_solve` 各 case 对齐：分析射线朝这里打，测出来的才是「机位那侧的净空」。
   * 返回 frac 后，可用半径要换算成「允许的 dist」：`cap = rayFree / frac - 0.6`。
   */
  _camRay(type, azim, u, wind, trv, keyYaw, out) {
    const frac = CAM_FRAC[type] || 1;
    if (BACK_CAM.has(type)) out.set(-trv.x, 0, -trv.z);
    else if (AHEAD_CAM.has(type)) out.set(trv.x, 0, trv.z);
    else if (type === 'topDown') out.set(trv.x, 0, trv.z).applyAxisAngle(UP, angDiff(azim, keyYaw));
    else {
      const a = this._azimNow(type, azim, u, wind);
      const s = AZDIR_OUT_CAM.has(type) ? 1 : -1;      // 默认机位在「−方位角」一侧
      out.set(Math.sin(a) * s, 0, Math.cos(a) * s);
    }
    const l = Math.hypot(out.x, out.z) || 1;
    out.x /= l; out.z /= l;
    return frac;
  }

  /**
   * 静态分析（plan 期）：沿「该镜头的运动弧 × 多高度层 × 段尾前瞻」打射线，
   * 量化这一段「能站多远（cap）、头顶还剩多高（hTop）、哪一层最通（hPick）」。
   *
   * 为什么不是「段中点一次 probeEnvironment」：
   *   · 横摆机位在段内会沿方位角扫过一段弧，只测中点会漏掉弧两端的墙；
   *   · 机位有高度，只测一层会漏掉「低层有梁、高层是通的」；
   *   · 段尾常常就是门框 / 变窄处，只看段内会在撞上的那一帧才收距离。
   */
  _analyzeSegment(type, azim, t0, t1, info, env, flags, size, i) {
    const d = this.data, world = this.ctx.world, pb = this.ctx.playerBody;
    const dur = Math.max(0.2, t1 - t0);
    const q = this._q();
    if (type === 'pov') {
      // POV 的机位就是录制时的眼睛位置，距离 / 高度分析没有意义
      return { R: PROBE_R, Rlayer: [0], layers: [0], hPick: 0, hTop: PROBE_R, cap: PROBE_R, size, arc: 0, bestAzim: azim, bestR: PROBE_R, tight: false };
    }
    const planH = this._planHeight(type, env);
    const ceilH = 2.4 + (env ? env.ceiling : 14);
    const layers = this._layers(planH, ceilH, q.layers);
    const arc = (AZ_ARC[type] || 0) + ARC_PAD;
    const wind = (((i * 37) % 7) / 7 - 0.5) * 1.1;      // 与 `_makeShot` / `_buildCurves` 同一公式
    const keyYaw = d.sampleAt(clamp(t0 + dur * 0.3, 0, d.duration)).fy;
    // 沿轨迹布机的镜头（后方跟拍 / 迎面引导）方向由轨迹决定、与方位角无关，
    // 绕方位角扫弧只会白打 5 倍射线，这里直接收敛成 1 条。
    const angles = (BACK_CAM.has(type) || AHEAD_CAM.has(type)) ? 1 : q.angles;
    const aerial = AERIAL_CAM.has(type);
    const def = SHOT_TYPES[type] || SHOT_TYPES.static;
    // 采样时刻：段头 / 段中 / 段尾 + 段尾前瞻（前瞻那一处专门用来「提前收距离」）
    const times = [
      clamp(t0 + dur * 0.15, 0, d.duration),
      clamp(t0 + dur * 0.5, 0, d.duration),
      clamp(t1 - dur * 0.15, 0, d.duration),
    ];
    const ahead = clamp(t1 + LOOKAHEAD, 0, d.duration);
    if (ahead > t1 + 0.05) times.push(ahead);

    let hTop = Infinity, bestAzim = azim, bestR = -1;
    const Rlayer = layers.map(() => PROBE_R);      // 逐层「全弧 × 全时刻」的最小可用半径（已换算成允许的 dist）
    for (const tt of times) {
      const s = d.sampleAt(tt);
      const uu = clamp((tt - t0) / dur, 0, 1);
      travelAt(d, tt, _tmpD);
      // 净高：俯拍族必须在「机位预估 XZ」上探（不是主体上方），否则会钻低屋檐
      const frac0 = this._camRay(type, azim, uu, wind, _tmpD, keyYaw, _camDirT);
      const off = aerial ? def.dist * frac0 : 0;
      const cf = ceilFreeAt(world, s.x + _camDirT.x * off, s.y + planH + 0.5, s.z + _camDirT.z * off, pb);
      hTop = Math.min(hTop, planH + 0.5 + cf);
      for (let li = 0; li < layers.length; li++) {
        const ey = s.y + layers[li];
        for (let ai = 0; ai < angles; ai++) {
          const a = angles === 1 ? azim : azim + ((ai / (angles - 1)) * 2 - 1) * arc;
          const fr = this._camRay(type, a, uu, wind, _tmpD, keyYaw, _camDirT);
          // 换成「允许的 dist」：机位只沿这个方向张开 frac 倍的 dist，故净空要除以 frac
          const rr = rayFree(world, s.x, ey, s.z, _camDirT.x, 0, _camDirT.z, pb, PROBE_R) / fr;
          if (rr < Rlayer[li]) Rlayer[li] = rr;
          if (rr > bestR) { bestR = rr; bestAzim = a; }
        }
      }
    }
    if (!isFinite(hTop)) hTop = planH + 14;
    const need = minDistForFov(type, fovFor(type));
    // 选层：优先「基准层」（俯拍就该在那么高、普通机位就该在胸口上方）；
    // 只有基准层被堵到比「不贴脸下限」还窄，才换到更通的一层 —— 这就是「换高度层」那一档。
    let bi = 0, bd = Infinity;
    for (let li = 0; li < layers.length; li++) {
      const dd = Math.abs(layers[li] - planH);
      if (dd < bd) { bd = dd; bi = li; }
    }
    if (Rlayer[bi] < need) {
      let ti = bi;
      for (let li = 0; li < Rlayer.length; li++) if (Rlayer[li] > Rlayer[ti] + 0.01) ti = li;
      bi = ti;
    }
    const rawR = Rlayer[bi];
    // cap = 真实的可用半径（不减成「不贴脸下限」）。
    // 早先这里写成 `max(MIN_DIST_MIN, rawR - 0.6)`，于是 `cap >= need` 恒成立、
    // 「站不开就换角度 / 换类型」的候选阶梯从来没被触发过 —— 方向被墙堵死时
    // 只会一路退到 3.2 的贴脸位置。这里必须如实报告，调用方才有机会「能远则远」。
    const cap = rawR - 0.6;
    return {
      R: rawR, Rlayer, layers, hPick: layers[bi], hTop, cap, size, arc, bestAzim, bestR,
      tight: cap < need,
    };
  }

  /**
   * 候选阶梯：「站不开」时按固定顺序换高度层 → 换方位角 → 换类型，全程确定性。
   * 「站不开」的判定线是 NEAR_ENOUGH：只比「不贴脸下限」好一点点仍然读作贴脸，
   * 因此只要某个方向还站得开，就一定要换过去 —— 这就是「能远则远」。
   * 收益不足 FIT_GAIN 就不换（否则相邻两镜来回换轴，比稍微近一点更晕）。
   */
  _fitShot(type, azim, t0, t1, info, env, flags, size, i) {
    // 「够远」的判定线：不贴脸下限之上再留一段 —— 只比下限好一点点（4 studs）
    // 在画面里仍然读作镜头贴脸，而只要还有别的方向站得开就该「能远则远」。
    // 整条线随 RETREAT 抬高：调大它 = 更积极地换方位角 / 换类型去找站得开的方向。
    const okFor = (t) => Math.max(minDistForFov(t, fovFor(t)), NEAR_ENOUGH * RETREAT);
    const needFor = (t) => minDistForFov(t, fovFor(t));
    let an = this._analyzeSegment(type, azim, t0, t1, info, env, flags, size, i);
    if (type === 'pov') return { type, azim, an };
    // ① 换方位角：在同一类型里换个「站得开」的方向 —— 剪辑语言不动，只把机位挪到有空间的那侧。
    //    这是「能远则远」的主要手段；沿轨迹布机的镜头方向由轨迹决定、换角没有收益，直接跳过。
    if (an.cap < okFor(type) && !BACK_CAM.has(type) && !AHEAD_CAM.has(type)) {
      let bestAz = null, bestAn = null, tries = 0;
      for (const o of [1.05, -1.05, 1.75, -1.75, 2.45, -2.45, 3.14]) {
        if (_rayCost > RAY_BUDGET || tries >= FIT_AZ_TRIES) break;
        if (LOCKED_CAM.has(type) && Math.abs(o) < this.azimGap) continue;
        tries++;
        const az = azim + o;
        const a2 = this._analyzeSegment(type, az, t0, t1, info, env, flags, size, i);
        if (!bestAn || a2.cap > bestAn.cap + 0.01) { bestAn = a2; bestAz = az; }
        if (bestAn.cap >= okFor(type)) break;
      }
      // 收益门槛：只多出一点点就不值当（相邻两镜来回换轴比稍微近一点更晕）
      if (bestAn && bestAn.cap > an.cap + FIT_GAIN) { an = bestAn; azim = bestAz; }
    }
    // 还站得开（哪怕只是「不贴脸」）：不再动类型 —— 类型是剪辑语言，能不动就不动。
    if (an.cap >= needFor(type)) return { type, azim, an };
    // ② 换类型：只有真的挤到「比不贴脸下限还窄」才换（狭窄空间安全集，固定顺序 = 确定性）。
    //    泳区里换类型的池子收窄成「迎面引导 / 肩后跟随」：这一段本来就只许用
    //    POV / 迎面引导 / 肩后跟随 三种，换到斯坦尼康或俯瞰就等于把泳区的镜头语言丢了。
    //    （`type === 'pov'` 上面已经提前返回，所以泳区里真正会走到这一步的只有这两种。）
    for (const t of (info.swimZone ? ['follow', 'lead'] : ['steadicam', 'follow', 'lead', 'topDown', 'droneTrack'])) {
      if (_rayCost > RAY_BUDGET) break;
      if (t === type) continue;
      const a3 = this._analyzeSegment(t, azim, t0, t1, info, env, flags, size, i);
      if (a3.cap > an.cap + FIT_GAIN) { type = t; an = a3; }
      if (an.cap >= needFor(type)) break;
    }
    an.tight = an.cap < needFor(type);
    return { type, azim, an };
  }

  /**
   * 段内包络表（plan 期，1/15s 稠密网格）：
   *   ① 每个网格点沿机位方向 × 各高度层打「自由距离」射线，得到可用半径与净高；
   *   ② `symMin` 取「前后各 ENV_HALF 秒内最窄 / 最低处」（对称窗，不是旧版的单边前瞻）；
   *   ③ `fwdBackEMA` 零相位平滑，把门口那种台阶抹成斜坡（无滞后）。
   * 于是镜头在到达门口 / 窄处之前就把距离收好、离开之后再匀速还回去 ——
   * 这是「智能预分析」的静态那一半；**运行期只查表，不再打任何前瞻校验射线**。
   * 返回 null 表示不适用（POV / 无物理世界 / 段太短）。
   */
  _buildCurves(shot, t0, t1, i) {
    const d = this.data, world = this.ctx.world, pb = this.ctx.playerBody;
    const an = shot.an;
    if (!world || !an || shot.type === 'pov') return null;
    const step = this._q().step;
    const end = Math.min(t1 + ENV_HALF, d.duration);
    if (end - t0 < step * 0.5) return null;
    const n = Math.min(400, Math.max(2, Math.round((end - t0) / step) + 1));
    const sstep = (end - t0) / (n - 1);
    const wind = (((i * 37) % 7) / 7 - 0.5) * 1.1;
    const aerial = AERIAL_CAM.has(shot.type);
    const def = SHOT_TYPES[shot.type] || SHOT_TYPES.static;
    const minDist = minDistForFov(shot.type, shot.fov);
    const keyYaw = shot.key.yaw;
    const Rs = new Float64Array(n), Cs = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const tt = clamp(t0 + k * sstep, 0, d.duration);
      const s = d.sampleAt(tt);
      const u = clamp((tt - t0) / Math.max(0.01, t1 - t0), 0, 1);
      travelAt(d, tt, _tmpD);
      const fr = this._camRay(shot.type, shot.azim, u, wind, _tmpD, keyYaw, _camDirT);
      let r = PROBE_R;
      for (let li = 0; li < an.layers.length; li++) {
        const rr = rayFree(world, s.x, s.y + an.layers[li], s.z, _camDirT.x, 0, _camDirT.z, pb, PROBE_R) / fr;
        if (rr < r) r = rr;
      }
      Rs[k] = r - 0.6;
      const off = aerial ? def.dist * fr : 0;
      Cs[k] = an.hPick + 0.5 + ceilFreeAt(world, s.x + _camDirT.x * off, s.y + an.hPick + 0.5, s.z + _camDirT.z * off, pb) - 0.7;
    }
    // ② 对称窗 + ③ 零相位平滑：把「临近的窄处」烘进当前值，且不留相位滞后。
    //    包络只表示「几何上能站多远」，所以这里**不乘 LIVE_DIST** —— 那一档留在运行期逐帧乘，
    //    保留「不重新 plan、下一帧生效」的既有语义。
    const half = ENV_HALF / sstep;
    const dS = fwdBackEMA(symMin(Rs, half), ENV_DAMP, sstep);
    const hS = fwdBackEMA(symMin(Cs, half), ENV_DAMP, sstep);
    const hCap = Math.max(0.9, shot.h);
    const dArr = new Float64Array(n), hArr = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      dArr[k] = clamp(dS[k], minDist, shot.dist);
      hArr[k] = clamp(hS[k], 0.9, hCap);
    }
    return { t0, dt: sstep, d: dArr, h: hArr, azim: shot.azim, wind, minDist, planDist: shot.dist, type: shot.type, keyYaw };
  }

  /**
   * 运动预分析（plan 期）：把「主体锚点 / 轨迹切向 / 急动程度」整段烘成 1/30s 网格的表。
   *
   * 这三样原本都在运行期做**因果**滤波（锚点低通、切向限速、急动积分）——
   * 因果滤波必然滞后，滞后就要靠前馈 / 事后抹平去补，补不干净就是跳变。
   * 回放是录像、未来已知，所以这里整段一次算完，并用**零相位**滤波
   * （`fwdBackEMA` + 双向限速）：既稳又没有相位滞后。运行期退化为查表。
   *
   * 网格 1/30s（比记录的 15Hz 细一档，插值后足够平滑）；全部由既有常量驱动、不含随机 ——
   * 同 (style, seed) 与同一次 plan 的结果逐字段一致（拖进度条 / 面板反复「应用」）。
   * @returns { t0, dt, n, ax, ay, az, tan, jerk }；null = 不适用（POV / 段过短）→ 走旧因果路径
   */
  _bakeMotion(clip) {
    const d = this.data;
    const type = clip.shot.type;
    if (type === 'pov') return null;             // POV 的机位就是玩家自己的头，不需要这些层
    const t0 = clip.t0, span = clip.t1 - clip.t0;
    if (!(span >= 0.08)) return null;
    const n = Math.max(2, Math.round(span * 30) + 1);
    const sdt = span / (n - 1);
    const aheadCam = AHEAD_CAM.has(type);
    const amul = aheadCam ? AHEAD_ANCHOR_MUL : 1;
    const lmul = aheadCam ? AHEAD_LEAD_MUL : 1;
    const famp = aheadCam ? AHEAD_TAN_MUL : 1;
    const deJ = aheadCam ? AHEAD_TAN_JERK : 1;
    const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
    const angs = new Float64Array(n), jerk = new Float64Array(n);
    const mv = { vk: false, x: 0, z: 0, vx: 0, vz: 0 };
    let jk = 0, prevAng = 0;
    for (let k = 0; k < n; k++) {
      const t = clamp(t0 + k * sdt, 0, d.duration);
      const s = d.sampleAt(t, _bkS);
      const sx = s.x, sz = s.z, sp = s.sp, fy = s.fy;
      // ① 急动：复刻运行期 `_jerkLevel` 的因果积分（进快出慢）。它表示「何时进入稳住档」，
      //    语义上本就是因果量，所以这里仍是单向前向积分 —— 不做零相位、也不反向。
      if (k === 0) { mv.x = sx; mv.z = sz; }
      let want = 0;
      const vx = (sx - mv.x) / sdt, vz = (sz - mv.z) / sdt;
      if (mv.vk) {
        const inst = Math.hypot(vx - mv.vx, vz - mv.vz) / sdt;
        want = clamp((inst - JERK_ACCEL) / (JERK_FULL - JERK_ACCEL), 0, 1);
      }
      mv.vx = vx; mv.vz = vz; mv.vk = true; mv.x = sx; mv.z = sz;
      if (s.state === 'walljump') want = Math.max(want, 0.7);   // 状态本身就是急动
      jk += (want - jk) * (1 - Math.exp(-(want > jk ? JERK_RISE : JERK_FALL) * sdt));
      jerk[k] = clamp(jk, 0, 1);
      // ② 轨迹切向的原始角：与 `_travelDir` 逐条同源（前后 0.24s 割线 + 与朝向对着干时混合）
      travelAt(d, t, _bkD);
      const fwd = _bkF.set(Math.sin(fy), 0, Math.cos(fy));
      let tx = _bkD.x, tz = _bkD.z;
      if (tx * fwd.x + tz * fwd.z < -0.17) {
        tx = tx * 0.55 + fwd.x * 0.45; tz = tz * 0.55 + fwd.z * 0.45;
        const l2 = Math.hypot(tx, tz) || 1; tx /= l2; tz /= l2;
      }
      let a = Math.atan2(tx, tz);
      if (k > 0) a = prevAng + angDiff(a, prevAng);   // 展开相位（免得 ±π 处被当成大跳变）
      prevAng = a; angs[k] = a;
      // ③ 锚点目标：沿记录轨迹前瞻一点（与运行期 LEAD_K / AHEAD_* 同源），不是新噪声
      const leadT = clamp(sp * sLead(LEAD_K * lmul), 0, sLead(LEAD_MAX * lmul));
      const ld = d.sampleAt(clamp(t + leadT, 0, d.duration), _bkL);
      px[k] = ld.x; py[k] = ld.y; pz[k] = ld.z;
    }
    // 零相位速率表：锚点速率随急动（跟得松一档），切向同理（含迎面机位的跟紧倍率）
    const aRate = new Float64Array(n), tRate = new Float64Array(n), tTurn = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      aRate[k] = sRate((ANCHOR_DAMP + (ANCHOR_DAMP_JERK - ANCHOR_DAMP) * jerk[k]) * amul);
      tRate[k] = sRate(famp * (TAN_DAMP + (TAN_DAMP_JERK - TAN_DAMP) * jerk[k] * deJ));
      tTurn[k] = sRate(famp * (TAN_TURN + (TAN_TURN_JERK - TAN_TURN) * jerk[k] * deJ));
    }
    const ax = fwdBackEMA(px, aRate, sdt), ay = fwdBackEMA(py, aRate, sdt), az = fwdBackEMA(pz, aRate, sdt);
    // 切向：先零相位低通抹掉 15Hz 折线的锯齿，再**双向**限速给「反向掉头」封顶。
    // 双向（前向 + 后向取平均）是关键：单向限速会留下因果滞后，双向才是零相位。
    const sm = fwdBackEMA(angs, tRate, sdt);
    const fl = new Float64Array(n), bl = new Float64Array(n);
    fl[0] = sm[0];
    for (let k = 1; k < n; k++) {
      const lim = tTurn[k] * sdt;
      fl[k] = fl[k - 1] + clamp(sm[k] - fl[k - 1], -lim, lim);
    }
    bl[n - 1] = sm[n - 1];
    for (let k = n - 2; k >= 0; k--) {
      const lim = tTurn[k] * sdt;
      bl[k] = bl[k + 1] + clamp(sm[k] - bl[k + 1], -lim, lim);
    }
    const tan = new Float64Array(n);
    for (let k = 0; k < n; k++) tan[k] = (fl[k] + bl[k]) * 0.5;
    return {
      t0, dt: sdt, n,
      ax: Float32Array.from(ax), ay: Float32Array.from(ay), az: Float32Array.from(az),
      tan: Float32Array.from(tan), jerk: Float32Array.from(jerk),
    };
  }

  /**
   * SMOOTH 变了以后重烘全部段的 motion 表。
   * `_bakeMotion` 里的速率 / 前瞻都乘了 `sRate` / `sLead`（即 SMOOTH），
   * 所以「运行期逐帧改 smooth」这套语义要靠重烘才生效 —— 好在段数有限、只算一次。
   */
  _rebakeMotion() {
    for (const c of this.clips) c.motion = this._bakeMotion(c);
  }

  /* ---------- 排片：把整局切成连续分段 ---------- */
  plan(opts = {}) {
    const d = this.data;
    const dur = Math.round((Number(d.duration) || 0) * 100) / 100;
    this.duration = dur;
    if (dur < 0.4) { this.clips = []; this._clipIx = -1; return this; }
    // ★ 多样剪辑层：只在这一步定「这一版用哪些创作参数」，之后全部照旧走安全闸门。
    //   opts 里没给风格就沿用当前设定（会话重播 / 面板反复「应用」拿到的是同一版）。
    this.setVariant(opts.style ? { style: opts.style, seed: opts.seed } : this._spec);
    const v = this.variant;
    _rayCost = 0;                       // 射线预算从本轮开始重新计
    // ★ 泳区（水下段落）：落水满 SWIM_ZONE_T 秒还没出水 → 那一刻起整体换成
    //   POV / 迎面引导 / 肩后跟随（见 `_swimZones` 与 `chooseShotType`）。
    //   算一次的传给 `_bounds`：泳区起点要当强制边界，扫描只做一遍。
    const zones = this._swimZones();
    const bounds = this._bounds(dur, opts, zones);
    const n = Math.max(1, bounds.length - 1);
    const infos = [], envs = [];
    for (let i = 0; i < n; i++) {
      const t0 = bounds[i], t1 = bounds[i + 1];
      const mid = clamp((t0 + t1) / 2, 0, dur);
      const env = probeEnvironment(this.ctx.world, this.ctx.builder, d, mid, this.ctx.playerBody);
      envs.push(env);
      const info = this._segInfo(d, t0, t1, env);
      // 段起点落在泳区里 = 这一镜是泳区的一镜（起点那一刻 `_bounds` 已经强制切镜，
      // 所以「进入泳区」的第一镜一定是从泳区起点开始的，不存在晚半秒才换机位）。
      for (const z of zones) {
        if (t0 >= z.t0 - 0.02 && t0 < z.t1) { info.swimZone = true; break; }
      }
      infos.push(info);
    }
    // 高潮段：强度最高者，给它最短的镜头与最低的角度
    let peak = 0;
    for (let i = 1; i < n; i++) if (infos[i].intensity > infos[peak].intensity) peak = i;
    this._peakIx = n > 2 ? peak : -1;

    const clips = [];
    const taken = new Set();
    let prevAzim = null, prevType = '';
    for (let i = 0; i < n; i++) {
      const t0 = bounds[i], t1 = bounds[i + 1];
      const env = envs[i], info = infos[i];
      const flags = { isOpen: i === 0, isPeak: i === this._peakIx, isLast: i === n - 1 };
      const size = this._sizeFor(i, flags);
      // 该镜头关键帧处角色的朝向：只作为「定初始角」的参考，之后一律走世界绝对角
      const ky = d.sampleAt(clamp(t0 + (t1 - t0) * 0.3, 0, dur)).fy;
      const t0type = chooseShotType(info, env, taken, prevType, i, n, v);
      const azim0 = pickAzimuth(t0type, prevAzim, this.azimGap, ky, v ? v.ladder : null);
      // 射线分析 + 候选阶梯（站不开就换方位角 / 换类型，绝不一味贴脸）
      const fit = this._fitShot(t0type, azim0, t0, t1, info, env, flags, size, i);
      const type = fit.type, azim = fit.azim, an = fit.an;
      const shot = this._makeShot(type, azim, t0, t1, info, env, flags, i, an);
      shot.curve = this._buildCurves(shot, t0, t1, i);
      if (LOCKED_CAM.has(type)) prevAzim = azim;
      prevType = type;
      taken.add(type);
      if (taken.size > 3) taken.delete(taken.values().next().value);
      const clip = {
        t0, t1, outT0: t0, outDur: t1 - t0,
        kind: info.kind, label: info.label, intensity: info.intensity,
        env, shot, speed: 1, index: i,
        size, dist: shot.dist, h: shot.h,
        onBeat: this._onRhythm(t0),    // 这一刀是否卡在 BGM 重音上（剪辑面板标记用）
      };
      clip.motion = this._bakeMotion(clip);   // 锚点 / 切向 / 急动：预分析成表（见 `_bakeMotion`）
      clips.push(clip);
    }
    this.clips = clips;
    this._linkClips(clips);      // 切点转场决策（cut / 黑场白场 / 超平滑飞渡）
    this._clipIx = -1;
    return this;
  }

  /**
   * 泳区：连续泡在液体里、且**满 SWIM_ZONE_T 秒都没出过水**的那些时段，
   * 从「入水时刻 + SWIM_ZONE_T」起算的那一段。
   *
   * 判定只看「有没有出水」这一位（`inLiquid`）：落水后 SWIM_ZONE_T 秒内出过水的，
   * 一律不算（踩水 / 短促落水仍按普通段落排镜）。所以泳区起点 = 入水时刻 + SWIM_ZONE_T ——
   * 那一刻必须立刻切镜（`_bounds` 把它当强制边界），而不是等节奏曲线自己走到下一个切点。
   *
   * @returns [{ t0, t1, ix }]，按时间升序；t1 = 出水时刻（录像结束时还在水里则取 duration）
   */
  _swimZones() {
    const c = this.data.c, F = REPLAY_FLAG;
    const out = [];
    if (!c || !c.n) return out;
    const n = c.n;
    let i = 0;
    while (i < n) {
      if (!(c.fl[i] & F.inLiquid)) { i++; continue; }
      let j = i;
      while (j < n && (c.fl[j] & F.inLiquid)) j++;
      // 录像第一帧就在水里时「入水时刻」不可知，按 i = 0 起算 —— 近似即「这一段水里已经待了 3 秒」
      const t0 = c.t[i];
      const t1 = j < n ? c.t[j] : this.data.duration;
      if (t1 - t0 >= SWIM_ZONE_T) out.push({ t0: t0 + SWIM_ZONE_T, t1, ix: out.length });
      i = j;
    }
    return out;
  }

  /**
   * 分段边界：先把候选拐点（事件 / 状态跃迁）找出来，再按节奏曲线吸附着切
   * @param zones `_swimZones()` 的结果（复用，免得一轮排片扫两遍时间轴）；不传则自己算
   */
  _bounds(dur, opts = {}, zones = null) {
    const v = this.variant;
    const minLen = Math.max(0.8, Number(opts.minLen) || 1.7);
    let maxLen = Math.max(minLen, Number(opts.maxLen) || 7.6);
    // 多样剪辑的「节奏」：只改单镜长度上限（下限不动 —— 它同时是转场与切点吸附的安全量程）
    if (v) maxLen = Math.max(minLen, Math.min(maxLen * v.maxLenMul, maxLen * 1.4));
    const marks = this._landmarks();
    // 传送 / 重生与泳区起点都是**强制**边界。只把它们当拐点交给 `_snap`（±1.7s 吸附窗）是不够的：
    // 落不到窗里时就照旧按节奏切，于是一个镜头横跨一次瞬移去追主体 ——
    // 既看不出「人换了地方」，`_linkClips` 的遮挡判定（切完机位看不见角色 → 黑白场，
    // 否则飞渡 / 硬切）也永远轮不到执行；泳区更甚，晚 1.7s 就已经不是「立刻切换」了。
    // 这里把时间轴按这些强制点分段，段内再照旧按节奏切，
    // 强制点因而一定落在边界上，节奏也仍是连续递进的。
    // 两类强制点合起来排序（可能互相交错），排完再按「贴首尾 / 挨太近」筛。
    const forced = [];
    for (const t of this._teleportTimes()) forced.push(t);
    for (const z of (zones || this._swimZones())) forced.push(z.t0);
    forced.sort((a, b) => a - b);
    const cuts = [];
    for (const t of forced) {
      if (t <= minLen * 0.6 || t >= dur - minLen * 0.6) continue;       // 贴着首尾：并入首 / 尾镜
      if (cuts.length && t - cuts[cuts.length - 1] < minLen * 0.9) continue;   // 挨太近：只认前一个
      cuts.push(t);
    }
    const bounds = [0];
    let i = 0;                       // 全局第几镜（节奏曲线里的「开场」只认整场的第一镜）
    for (const cut of cuts.concat(dur)) {
      let t = bounds[bounds.length - 1];
      while (cut - t > minLen * 1.3) {
        const floor = t + minLen * 0.75, cap = cut - minLen * 0.5;
        let nxt = t + this._wantLen(t / dur, i, maxLen, t);
        if (nxt > cut - minLen * 0.6) nxt = cut;
        else {
          // 有 BGM 节奏点表就优先「卡点」：把切点吸附到最近的重音上（吸附窗 = 半个平均间隔，
          // 窗口内取强度最高的那个点）；窗口里没有可用节奏点再退回原来的「拐点吸附」。
          const bt = this._snapRhythm(nxt, floor, cap);
          nxt = bt !== null ? bt : this._snap(nxt, marks, floor, cap);
        }
        if (nxt - t < minLen * 0.85) nxt = Math.min(cut, t + minLen);
        if (nxt <= t + 1e-6) nxt = cut;                                  // 兜底：绝不让 t 停滞
        bounds.push(nxt);
        t = nxt; i++;
        if (bounds.length > 600) break;
      }
      const last = bounds[bounds.length - 1];
      if (cut - last > 0.3) bounds.push(cut);
      else if (cut > last) bounds[bounds.length - 1] = cut;
    }
    return bounds;
  }

  /** 该处「该给多长的镜头」：开场长、递进渐短、收尾留白，并随局部强度收紧 */
  _wantLen(p, i, maxLen, t) {
    const v = this.variant;
    let w;
    if (i === 0) w = 5.4;                     // 开场建立镜头
    else if (p > 0.88) w = 4.4;               // 收尾余韵
    else if (p > 0.66) w = 2.8;
    else w = 3.7 - p * 1.1;
    if (v) w *= v.lenMul;                     // ★ 多样剪辑的节奏倍率（长镜 / 快切）
    const s = this.data.sampleAt(clamp(t, 0, this.data.duration));
    const hot = clamp(s.sp / 34, 0, 1) * 0.8 + (s.alive ? 0 : 0.5) + clamp((32 - s.ox) / 32, 0, 1) * 0.3;
    return clamp(w * (1.22 - clamp(hot, 0, 1) * 0.55), 1.6, maxLen);
  }

  /** 可切镜的拐点：事件（强）+ 状态 / 环境跃迁（弱） */
  _landmarks() {
    const d = this.data, c = d.c;
    const F = REPLAY_FLAG;
    const out = [];
    for (const e of d.rec.ev || []) out.push({ t: e.t, w: 2 });
    // 传送 / 重生：位置列上的断点是最强的「拐点」—— 切镜不落在它上面的话，就得用同一个镜头
    // 去追一个瞬移的主体，画面比硬切更难读；而切镜落在它上面，`_linkClips` 的遮挡判定
    // （切完机位看不见角色 → 黑白场，否则飞渡 / 硬切）才有机会生效。故权重高于事件。
    // 这一趟用逐点扫描（`_teleportTimes` 里只做减法 + 开方），不必跟上面的抽稀步长。
    for (const t of this._teleportTimes()) out.push({ t, w: 2.6 });
    const step = Math.max(1, Math.floor(Math.max(1, d.n) / 320));
    let pr = null;
    for (let i = 0; i < d.n; i += step) {
      const cur = {
        st: c.st[i], alive: !!(c.fl[i] & F.alive), grounded: !!(c.fl[i] & F.grounded),
        wet: !!(c.fl[i] & F.inLiquid), sprint: c.sp[i] > 26,
      };
      if (pr) {
        let w = 0;
        if (cur.st !== pr.st) w = 1.6;
        else if (cur.alive !== pr.alive) w = 2;
        else if (cur.wet !== pr.wet) w = 1.4;
        else if (cur.grounded !== pr.grounded) w = 1.1;
        else if (cur.sprint !== pr.sprint) w = 0.8;
        if (w) out.push({ t: c.t[i], w });
      }
      pr = cur;
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /** 把打算切的时间点吸附到最近的拐点上（事件权重更高 = 运动匹配） */
  _snap(t, marks, floor, cap) {
    let best = null, bestScore = Infinity;
    for (const m of marks) {
      if (m.t < floor) continue;
      if (m.t > cap) break;
      const dist = Math.abs(m.t - t);
      if (dist > 1.7) continue;
      const score = dist - m.w * 0.45;
      if (score < bestScore) { bestScore = score; best = m.t; }
    }
    return best === null ? t : best;
  }

  /**
   * 把切点吸附到**最近的 BGM 节奏点**上（卡点）。这里的「节奏点」不是等间隔的拍子网格，
   * 而是逐帧频谱里检出的瞬态时刻（鼓点 / 重音），所以每个点的位置都是真实发声处。
   * 判定原则：窗口内**强度更高**的点优先，同强度下取更近的；窗内没有可用点 / 没有节奏表返回 null。
   * BGM 是循环播放的，所以节奏点也沿时间轴平铺（按素材时长取模），回放比一首 BGM 长也没关系。
   */
  _snapRhythm(t, floor, cap) {
    const r = this.rhythm;
    if (!r || !r.times || !r.times.length) return null;
    const dur = r.duration > 0.01 ? r.duration : 0;
    const win = r.window > 0 ? r.window : 0.12;
    const offs = dur ? [0, -dur, dur] : [0];
    const base = dur ? t - Math.floor(t / dur) * dur : t;
    const times = r.times, str = r.strengths;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < times.length; i++) {
      for (let k = 0; k < offs.length; k++) {
        const cm = times[i] + offs[k];
        const d = Math.abs(cm - base);
        if (d > win) continue;
        const cand = t + (cm - base);          // 平移回全局时间轴
        if (cand < floor || cand > cap) continue;
        const s = (str ? str[i] : 1) * (1 - 0.7 * d / win);
        if (s > bestScore) { bestScore = s; best = cand; }
      }
    }
    return best;
  }

  /** t 是否落在节奏点上（容差内）—— 标记「这一刀卡在重音上」给剪辑面板看 */
  _onRhythm(t, tol = 0.08) {
    const r = this.rhythm;
    if (!r || !r.times || !r.times.length) return false;
    const dur = r.duration > 0.01 ? r.duration : 0;
    const offs = dur ? [0, -dur, dur] : [0];
    const base = dur ? t - Math.floor(t / dur) * dur : t;
    for (let i = 0; i < r.times.length; i++) {
      for (let k = 0; k < offs.length; k++) {
        if (Math.abs(r.times[i] + offs[k] - base) <= tol) return true;
      }
    }
    return false;
  }

  /** 一段的「这是什么样的动作」：状态占比 + 事件 + 强度 */
  _segInfo(d, t0, t1, env) {
    const span = Math.max(0.2, t1 - t0);
    const ts = 0.25;
    const counts = {};
    let air = 0, spr = 0, spSum = 0, samples = 0;
    for (let t = t0; t < t1 - 0.001; t += ts) {
      const s = d.sampleAt(clamp(t, 0, d.duration));
      counts[s.state] = (counts[s.state] || 0) + 1;
      if (!s.grounded && s.alive) air++;
      if (s.sp > 26 && s.grounded) spr++;
      spSum += s.sp; samples++;
    }
    // 事件优先：死亡 / 通关 / 入水 / 受伤这类「事情发生」的瞬间最该被拍
    let kind = '';
    for (const e of d.rec.ev || []) {
      if (e.t < t0 - 0.05 || e.t > t1 + 0.05) continue;
      if (e.k === 'death') { kind = 'death'; break; }
      if (e.k === 'win' && !kind) kind = 'win';
      else if (!kind && (e.k === 'dive' || e.k === 'enterWater')) kind = e.k;
      else if (!kind && e.k === 'hurt') kind = 'hurt';
    }
    if (!kind) {
      let best = 'normal', bestN = 0;
      for (const k in counts) if (k !== 'normal' && counts[k] > bestN) { bestN = counts[k]; best = k; }
      const share = samples ? bestN / samples : 0;
      if (share >= 0.22) kind = best;
      else if (samples && air / samples >= 0.5) kind = 'jump';
      else if (samples && spr / samples >= 0.4) kind = 'sprint';
      else kind = env.submerged > 1.1 ? 'swim' : 'idle';
    }
    const rule = HIGHLIGHT_RULES[kind] || HIGHLIGHT_RULES.idle;
    const avgSp = samples ? spSum / samples : 0;
    const intensity = clamp((rule.score / 100) * 0.55 + avgSp / 34 * 0.3 + clamp(span / 3, 0, 1) * 0.15, 0, 1);
    return {
      kind, label: rule.label, pref: rule.pref, intensity,
      air: samples ? air / samples : 0, sprint: samples ? spr / samples : 0,
      wet: env.submerged > 0.4,
    };
  }

  /**
   * 实例化一个可解算的镜头。
   * dist / h 不再来自「标称值 + 段中点一次探测」，而是由 `an`（段内射线分析）给出：
   *   · dist —— 景别档位在「可用半径 cap」内按比例落位：空间够就用理想距离，
   *     空间不够时远 / 中 / 近各吃一份比例，不再全塌到同一个值（画面里始终有远有近）；
   *   · h —— 该类型最通的那一层 × 景别倍率，再被射线实测净高压住（留 0.7 的头顶余量）。
   */
  _makeShot(type, azim, t0, t1, info, env, flags, i, an) {
    const d = this.data;
    const def = SHOT_TYPES[type] || SHOT_TYPES.static;
    const dur = Math.max(0.2, t1 - t0);
    const key = d.sampleAt(clamp(t0 + dur * 0.3, 0, d.duration));
    const v = this.variant;
    const size = (an && an.size) || this._sizeFor(i, flags);
    const fov = fovFor(type);
    const minDist = minDistForFov(type, fov);
    // ① 理想距离：标称距离 × 景别倍率 × 速度 / 开场 / 高潮因子 × 综合调制参数（保留既有因子与量级）
    //    × 版本距离倍率（★ 多样剪辑的「远观 / 贴身」）。下面 ② 的夹紧一层不少：
    //    空间不够照样按 SIZE_FILL 吃下可用半径，绝不会因为「想远」就穿到墙外去。
    const distScale = clamp(1 + key.sp / 70, 1, 1.5);
    let dist = def.dist * SIZE_MUL[size] * distScale * RETREAT * (v ? v.distMul : 1);
    if (flags.isOpen) dist *= 1.32;
    if (flags.isPeak) dist *= 0.92;
    if (type === 'pov') {
      dist = 0;                                   // POV 的机位就是录制时的眼睛
    } else {
      const cap = Math.max(minDist, an ? an.cap : 16);
      // ② 空间不够：不再一路贴脸，按景别比例吃下可用空间（远 / 中 / 近依旧分层）。
      //    吃下的比例同样受 RETREAT 调制 —— 调大它 = 「能多占就多占」，不再主动缩在空间中间。
      if (dist > cap) dist = minDist + (cap - minDist) * clamp(SIZE_FILL[size] * RETREAT, 0, 1);
      dist = Math.max(dist, minDist);
    }
    // ③ 高度：最通的那一层 × 景别倍率，再被实测净高压住
    const hBase = an ? an.hPick : def.h;
    const hMax = Math.max(1.0, (an ? an.hTop : 2.4 + env.ceiling) - 0.7);
    const floor = AERIAL_CAM.has(type) ? 2.4 : 0.9;
    let ht = clamp(hBase * H_MUL[size], floor, Math.max(floor, hMax));
    // 高潮段略微压低机位，但绝不再压到胸口以下（低机位仰视快速移动的主体最晕）
    if (flags.isPeak && !AERIAL_CAM.has(type)) ht = Math.max(0.9, Math.min(ht, 1.55));
    return {
      type, azim, dist, planDist: dist, h: ht, size, an,
      // 确定性：拖动进度条重算也一致。步长按版本换（仍与 7 互质，取值区间不变）
      wind: (((i * (v ? v.windStep : 37)) % 7) / 7 - 0.5) * 1.1,
      travel: dist * 0.9,
      focusH: 1.75,
      lead: clamp(key.sp * 0.055, 0, 1.5),
      dur,
      pace: clamp((0.85 + info.intensity * 0.55) * (v ? v.paceMul : 1), 0.5, 2),
      // 该镜头关键帧处角色的朝向（fy 是记录里的朝向列；写成不存在的字段名会得到
      // undefined，angDiff 一算就是 NaN，整个机位会变成 NaN —— 画面直接黑掉）
      key: { x: key.x, y: key.y, z: key.z, yaw: key.fy },
      fov,
      title: info.label,
      isOpen: flags.isOpen, isPeak: flags.isPeak, isLast: flags.isLast,
      env,
    };
  }

  /* ---------- 电影剪辑模式：把时间轴交出去编辑，再收回来重算镜头 ---------- */
  /** 导出可编辑的分段表（电影剪辑面板用） */
  serialize() {
    return this.clips.map((c) => ({
      on: true, kind: c.kind, label: c.label, t0: r2(c.t0), t1: r2(c.t1),
      intensity: r2(c.intensity), type: c.shot.type, pace: r2(c.shot.pace),
      env: c.env, size: c.shot.size, dist: r2(c.shot.dist), h: r2(c.shot.h),
      onBeat: !!c.onBeat,
    }));
  }

  /**
   * 用编辑后的分段表重算（时间轴仍是全程覆盖）：关掉的段并入相邻段，
   * 头尾自动补满 [0, duration]，不会给时间轴留洞。
   */
  applyEdits(list) {
    const d = this.data;
    const dur = this.duration = Math.round((Number(d.duration) || 0) * 100) / 100;
    const rows = (list || [])
      .filter((e) => e && e.t1 != null && Number(e.t1) > Number(e.t0))
      .map((e) => ({
        on: e.on !== false, kind: e.kind || 'idle', label: e.label || '',
        t0: clamp(Number(e.t0) || 0, 0, dur), t1: clamp(Number(e.t1) || 0, 0, dur),
        type: e.type, pace: Number(e.pace) || 1,
        intensity: Number(e.intensity) || 0.4, env: e.env || null,
      }))
      .sort((a, b) => a.t0 - b.t0);
    if (!rows.length) return this.plan();
    const merged = [];
    for (const r of rows) {
      const last = merged[merged.length - 1];
      if (!r.on) { if (last) last.t1 = Math.max(last.t1, r.t1); continue; }   // 关掉 = 并入上一镜
      // 只有「真正重叠」才并段。分段表本来就是一节挨一节（前段的 t1 正好等于后段的 t0），
      // 用 <= 判定会把整条时间轴一路并成最后一个镜头 ——「应用并播放」只剩一镜的元凶。
      if (last && r.t0 < last.t1 - 0.001) last.t1 = Math.max(last.t1, r.t1);
      else merged.push({ ...r });
    }
    if (!merged.length) return this.plan();     // 全关：退回自动剪
    merged[0].t0 = 0;
    merged[merged.length - 1].t1 = dur;

    const clips = [];
    const taken = new Set();
    let prevAzim = null, prevType = '';
    let peak = 0;
    for (let i = 1; i < merged.length; i++) if (merged[i].intensity > merged[peak].intensity) peak = i;
    // 不再信任回传的 e.env：用户一旦改了运镜类型，旧的 env / 分析结果全部作废。
    // 每行按「类型 | 景别 | 方位角 | 区间」重跑射线分析，用 memo 缓存，
    // 这样面板反复「应用」不会重复打射线，结果也仍是确定性的。
    _rayCost = 0;
    const memo = new Map();
    for (let i = 0; i < merged.length; i++) {
      const e = merged[i];
      const mid = clamp((e.t0 + e.t1) / 2, 0, dur);
      const rule = HIGHLIGHT_RULES[e.kind] || HIGHLIGHT_RULES.idle;
      const flags = { isOpen: i === 0, isPeak: i === peak && merged.length > 2, isLast: i === merged.length - 1 };
      const size = this._sizeFor(i, flags);
      const type = SHOT_TYPES[e.type] ? e.type : (prevType || 'track');
      const ky = d.sampleAt(mid).fy;
      const azim = pickAzimuth(type, prevAzim, this.azimGap, ky, this.variant ? this.variant.ladder : null);
      const mk = i + '|' + type + '|' + size + '|' + r2(azim) + '|' + r2(e.t0) + '|' + r2(e.t1) + '|' + e.kind;
      let hit = memo.get(mk);
      if (!hit) {
        const env = probeEnvironment(this.ctx.world, this.ctx.builder, d, mid, this.ctx.playerBody);
        const info = {
          kind: e.kind, label: e.label || rule.label, pref: rule.pref,
          intensity: e.intensity, wet: env.submerged > 0.4,
        };
        hit = { env, info, fit: this._fitShot(type, azim, e.t0, e.t1, info, env, flags, size, i) };
        memo.set(mk, hit);
      }
      const env = hit.env, info = hit.info, fit = hit.fit;
      const shot = this._makeShot(fit.type, fit.azim, e.t0, e.t1, info, env, flags, i, fit.an);
      shot.pace = clamp(e.pace || shot.pace, 0.5, 2);
      shot.curve = this._buildCurves(shot, e.t0, e.t1, i);
      if (LOCKED_CAM.has(fit.type)) prevAzim = fit.azim;
      prevType = fit.type;
      taken.add(fit.type);
      const clip = {
        t0: e.t0, t1: e.t1, outT0: e.t0, outDur: e.t1 - e.t0,
        kind: e.kind, label: info.label, intensity: e.intensity,
        env, shot, speed: 1, index: i,
        size: shot.size, dist: shot.dist, h: shot.h,
        onBeat: this._onRhythm(e.t0),
      };
      clip.motion = this._bakeMotion(clip);   // 同 plan()：锚点 / 切向 / 急动预分析成表
      clips.push(clip);
    }
    this.clips = clips;
    this._linkClips(clips);      // 切点转场决策（cut / 黑场白场 / 超平滑飞渡）
    this._peakIx = peak;
    this._clipIx = -1;
    return this;
  }

  /* ---------- 时间轴查询（恒等映射：srcT === movieT） ---------- */
  /**
   * 相机时间 = 播放时间 + 运镜提前量（夹在 [0, duration]）。
   * 「运镜整体提前」只在这一个地方生效：凡是**取运镜**（哪一镜 / 相位 / 包络 / 飞渡 / 遮罩）
   * 都要先过它；凡是**取角色**（位置 / 朝向 / 是否在水里）都用真实播放时间，绝不能过它。
   */
  _camT(movieT) {
    return clamp((Number(movieT) || 0) + (Number(this.lead) || 0), 0, this.duration);
  }
  clipAt(movieT) {
    const cs = this.clips;
    if (!cs.length) return null;
    const m = clamp(Number(movieT) || 0, 0, this.duration);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (m < c.t1 || i === cs.length - 1) {
        const len = Math.max(0.0001, c.t1 - c.t0);
        return { clip: c, local: m - c.t0, srcT: m, u: clamp((m - c.t0) / len, 0, 1), inClip: true };
      }
    }
    return null;
  }

  /** 屏幕上此刻正在放的是第几镜（已折进运镜提前量） */
  shotIndexAt(movieT) {
    const it = this.clipAt(this._camT(movieT));
    return it ? Math.max(0, this.clips.indexOf(it.clip)) : 0;
  }

  /** 第 i 镜在**播放时间轴**上「上屏」的时刻（已把运镜提前量折进去，供 UI 跳转 / 刻度用） */
  shotStartT(i) {
    const cs = this.clips;
    if (!cs.length) return 0;
    const c = cs[clamp(i | 0, 0, cs.length - 1)];
    return Math.max(0, c.outT0 - (Number(this.lead) || 0));
  }

  /** 当前时刻用的镜头类型（POV 时要藏角色）：必须跟着相机时间走，否则模型藏早 / 藏晚 */
  shotTypeAt(movieT) {
    const it = this.clipAt(this._camT(movieT));
    return it ? it.clip.shot.type : '';
  }

  /** 当前分段的标题（镜头刚开始 / 快结束时淡出，避免贴边字幕）：与相机时间同步 */
  titleAt(movieT) {
    const it = this.clipAt(this._camT(movieT));
    if (!it) return null;
    if (it.u < 0.12 || it.u > 0.94) return null;
    return { label: it.clip.label, kind: it.clip.kind };
  }

  /* ---------- 每帧：算出机位并写进相机 ---------- */

  /**
   * 飞渡窗口查表（运行期）：当前帧是否落在某个 fly 转场的窗口里。
   * 只认窗口与段内相位 x，**不解算任何姿态** —— 于是它可以被放在锚点更新之前，
   * 用来决定那一帧要不要按切镜硬吸附（见 `update`）。
   * @returns { L, x } 或 null（不在任何飞渡窗口里）
   */
  _flyWin(c, it) {
    _flyTwo[0] = c.linkIn;
    _flyTwo[1] = c.linkOut;
    for (let i = 0; i < 2; i++) {
      const L = _flyTwo[i];
      if (!L || L.mode !== 'fly') continue;
      const half = L.dur * 0.5;
      const x = (it.srcT - (L.tb - half)) / Math.max(0.001, half * 2);
      if (x < 0 || x > 1) continue;
      _flyHit.L = L; _flyHit.x = x;
      return _flyHit;
    }
    return null;
  }

  /**
   * 飞渡姿态（运行期）：把 `_flyWin` 命中的窗口解成位置 / 视点。
   * 窗口已经算好时由调用方传进来（`update` 需要先知道「在不在窗口里」再决定锚点吸附）。
   */
  _flyAt(c, it, w) {
    w = w || this._flyWin(c, it);
    if (!w) { this._flyFrom = null; return null; }
    {
      const L = w.L, x = w.x;
      bez2(L.p0, L.c, L.p1, x, _flyP);
      bez2(L.l0, L.cl, L.l1, x, _flyL);
      if (L.anchor) {
        _flyP.x += this._anchor.x - L.anchor.x;
        _flyP.y += this._anchor.y - L.anchor.y;
        _flyP.z += this._anchor.z - L.anchor.z;
      }
      if (this._flyFrom == null) this._flyFrom = this._fov;   // 首帧记下起点视场角
      // k = sin²(πx) = (1 − cos 2πx) / 2：窗口两端 0（完全交给当前镜头自己的解析姿态，
      // 位置连续）、正中间 1（完全走贝塞尔路径），且**三处一阶导都为 0**
      //（d/dx = π·sin 2πx 在 x = 0 / 0.5 / 1 上全为零）。
      // 早先用的是 sin(πx)：两端虽然取到 0，但那里的导数等于 π ≠ 0 ——
      // 「接管 / 交还」那一帧速度对不上，画面里就是一次极短的顿挫。sin² 才是真的接得住。
      // 注意 k 必须回到 0：窗口两端各属于 A / B 两镜，k 归零 = 交还给该镜自己的解析姿态。
      // 视场角则相反 —— 它是一个「从 A 的值换到 B 的值」的单调过渡量（`fw`），
      // 若也用 k 就会在窗口末尾退回 A 的值，出了窗口再被 B 的切镜帧拽回去，又是一次变焦跳变。
      return {
        pos: _flyP, look: _flyL, fov1: L.fov1,
        k: 0.5 - 0.5 * Math.cos(Math.PI * 2 * x),
        fw: smoothstep(x),
      };
    }
  }

  /**
   * 遮罩（运行期）：切点 ±DIP_T 内的黑场 / 白场包络。
   * 0.24s 全遮（DIP_FLAT 以内）、两侧各 0.18s 收口 —— 足够藏住一次硬切，
   * 又短到不会被读成「黑了一下」。时间轴仍是恒等的：画面一秒都没少，只是被挡了一瞬。
   */
  _fadeUpdate(c, movieT) {
    let v = 0, color = DIP_COLOR_DEF;
    _flyTwo[0] = c.linkIn;
    _flyTwo[1] = c.linkOut;
    for (let i = 0; i < 2; i++) {
      const L = _flyTwo[i];
      if (!L || L.mode !== 'dip') continue;
      const x = Math.abs(movieT - L.tb) / DIP_T;
      if (x >= 1) continue;
      const w = x <= DIP_FLAT ? 1 : 1 - smoothstep((x - DIP_FLAT) / (1 - DIP_FLAT));
      if (w > v) { v = w; color = L.color || DIP_COLOR_DEF; }
    }
    this.fade = v;
    this.fadeColor = color;
  }

  update(movieT, camera, dt = 1 / 60) {
    this.fade = 0; this.fadeColor = DIP_COLOR_DEF;
    // ★ 运镜整体提前：「运镜时间」与「角色时间」在这里分家（见 `_camT`）。
    //   下面凡是取运镜的都走 `it`（= tCam）：哪一镜、段内相位 u、包络表、飞渡窗口、遮罩、
    //   轨迹切向（跟拍机位的方位基准）—— 于是镜头先摆好、先切过去。
    //   凡是取角色的都走 `tAct`：位置、朝向、轨迹取样、是否在水里、急动程度。
    const tAct = clamp(movieT, 0, this.duration);
    const it = this.clipAt(this._camT(movieT));
    if (!it || !camera) return;
    const c = it.clip;
    const s = this.data.sampleAt(tAct, _sample);
    const ix = this.clips.indexOf(c);
    // ixChanged = 「本帧跨过了切点」，与旧 cut 语义完全一致（只是不再等同于硬切）
    const ixChanged = ix !== this._clipIx;
    this._fadeUpdate(c, it.srcT);
    // 玩家「在水里」的判定看头是否没入液面：只要头还在水面上，
    // 镜头就一律不许入水（水下的世界只该在真的潜下去时才看到）
    const wetPlayer = !!s.headUnder;
    // m = 本段预分析出来的 motion 表（锚点 / 切向 / 急动）；交给 `_solve` 直接查表用
    const shot = { ...c.shot, t: it.srcT, local: it.local, u: it.u, dur: c.outDur, wet: wetPlayer, m: c.motion };
    // ★ 沉浸 POV 是「玩家自己的眼睛」：机位 / 视线必须逐帧等于 `povAim` 的解（头位置 +
    //   身体朝向 + 视线前瞻），不能叠任何稳定层。下面那一整串稳定层（锚点前瞻、修正量低通、
    //   视线阻尼、视线限速、最终级平滑的速度前馈）都是为「跟在主体后面的自由机位」设计的 ——
    //   它们按机位 / 视点的**速度**外推，套到 POV 上就是在 `POV_AHEAD` 之外再加一层提前量，
    //   把视线从「路将要往哪拐」拽向「镜头自己往哪飞」，又在机身位置上加阻尼滞后。
    //   这里给 POV 单独开一条旁路：只保留切镜与飞渡窗口的 k 加权（转场仍要接得上），其余一律旁路。
    const isPov = shot.type === 'pov';
    // 离开 POV 就把俯仰平滑状态清掉：下一镜若再进 POV（哪怕是飞渡滑进去的），
    // 首帧从吸附开始 —— 否则会去插值一段早已过期的旧俯仰，读作「刚进 POV 镜头在慢慢抬头」。
    if (!isPov) this._povP.v = null;

    // ★ 距离 / 高度：**纯查表**。包络表在 plan 期已按 1/15s 网格烘成
    //   「前后各 ENV_HALF 秒内最窄 / 最低处 + 零相位平滑」，未来最近的窄处早已折进表里。
    //   运行期因此不再打任何前瞻校验射线（旧版的 `_dynD/_dynH/_laProbe` 那一套已删除），
    //   也就没有「逐帧去追一个阶跃目标」这件事 —— 这正是「自动避障导致跳变」的根。
    // ★ 跟镜期智能远近（LIVE_DIST）：在表的取值上乘一档（保留「不重新 plan、下一帧生效」的语义）。
    //   包络下限 curve.minDist（不贴脸）不缩放：它是安全下限，不是风格。
    const curve = c.shot.curve;
    if (curve) {
      shot.dist = Math.max(curve.minDist, Math.min(c.shot.dist, curveAt(curve.d, curve.t0, curve.dt, it.srcT))) * LIVE_DIST;
      shot.h = Math.max(0.9, Math.min(c.shot.h, curveAt(curve.h, curve.t0, curve.dt, it.srcT)));
    } else {
      shot.dist = c.shot.dist * LIVE_DIST;
      shot.h = c.shot.h;
    }
    const minDist = shot.type === 'pov' ? 0 : minDistForFov(shot.type, shot.fov);

    // ★ 主体「急动」程度 / 主体锚点：同样**查烘焙表**（见 `_bakeMotion`）。
    //   表是 plan 期按整段录像零相位烘出来的，首帧即确定、跨帧无滞后 —— 运行期不再有
    //   「因果滤波 → 滞后 → 事后抹平」这条链，也就没有由它带来的跳变。
    //   表不存在时（POV / 段过短）退回原有因果路径，行为与改造前一致。
    const mo = c.motion;
    const win = this._flyWin(c, it);
    if (mo) {
      this._jerk = clamp(curveAt(mo.jerk, mo.t0, mo.dt, tAct), 0, 1);
      trackVec3(mo.ax, mo.ay, mo.az, mo.t0, mo.dt, tAct, this._anchor);
      this._anchorOk = true;
    } else {
      // 急动：差分按源时间算（倍速回放时帧间隔不变、位置走得更多，用帧间隔会误判成急动）
      const dSrc = this._lastSrcT == null ? 0 : tAct - this._lastSrcT;
      this._lastSrcT = tAct;
      this._jerkLevel(s, dSrc, ixChanged, dt);
      // 锚点低通：记录只有 15Hz，幽灵走的是一条「折线」（每 1/15 秒换一次斜率），跟拍类机位
      // 直接读它就会把这条折线的拐点当成画面里的微抖。低通的目标不是「当前脚底」，而是沿记录
      // 轨迹**前瞻过的**那一点（LEAD_K）—— 低通带来的滞后被这份前瞻抵掉，高速动作下机位不会
      // 落在主体后面，主体也就不会顶出画框。迎面机位（lead）另按 AHEAD_* 跟紧一档。
      const aheadCam = AHEAD_CAM.has(shot.type);
      const amul = aheadCam ? AHEAD_ANCHOR_MUL : 1, lmul = aheadCam ? AHEAD_LEAD_MUL : 1;
      const leadT = clamp(s.sp * sLead(LEAD_K * lmul), 0, sLead(LEAD_MAX * lmul));
      // 锚点必须锚在**角色当前**（稍作前瞻）的位置上，不能用运镜时间 ——
      // 否则机位会整体平移到角色的未来位置，人反而被甩出画框。
      const lead = this.data.sampleAt(clamp(tAct + leadT, 0, this.duration), _sLead);
      const feet = _tmpA.set(lead.x, lead.y, lead.z);
      // 飞渡窗口中锚点照常低通过去（不硬吸附）：窗口里的机位 = 贝塞尔路径 + （实时锚点 − plan 期锚点），
      // 吸附那一帧会把跳变原样搬进画面。硬切（含 glide）仍照旧吸附。
      if ((ixChanged && !win) || !this._anchorOk) { this._anchor.copy(feet); this._anchorOk = true; }
      else {
        const ad = sRate((ANCHOR_DAMP + (ANCHOR_DAMP_JERK - ANCHOR_DAMP) * this._jerk) * amul);
        this._anchor.lerp(feet, 1 - Math.exp(-ad * dt));
      }
    }
    // 转场：本帧是否落在某个 fly 窗口里（查 plan 期算好的路径，不解算第二镜）
    const fly = win ? this._flyAt(c, it, win) : (this._flyFrom = null, null);
    const cut = ixChanged && !fly;
    // 先照常解算当前镜头 —— 即使正处在飞渡窗口里也要解（“自然姿态”是混合的底）。
    // 不解的话，窗口两端就只剩 plan 期的标称姿态：那份姿态跑的是同一套表、
    // 但没有跨帧的低通 / 限速记忆（`_stay/_look/_ca`、修正量滤波），与运行期姿态
    // 仍能差出可观的量 —— 等于自己又造了一次跳变。
    this._solve(shot, s, _v1, _v2, dt, cut);
    if (fly) {
      // 飞渡：以 k = sin²(πx) 把「自然姿态」与「贝塞尔路径」加权混合。
      // k 在窗口两端为 0、正中间为 1，且三处一阶导都为 0：接管那一帧拿到的仍是当前镜头
      // 自己的姿态，交还那一帧拿到的已经是下一镜的姿态 —— 位置、速度都连续，
      // 中间段则完全走在 plan 期迭代避障验过的弧线上。
      _v1.lerp(fly.pos, fly.k);
      _v2.lerp(fly.look, fly.k);
    }
    const idealD = _v1.distanceTo(_v2);           // 理想机位到主体的距离
    // 安全摆放（射线 + 水面规避）：对焦点 → 理想机位，被挡住就收到墙前；
    // 空间挤到比「不贴脸下限」还窄时走候选阶梯（沿墙滑移 / 抬机位），不再一路贴到大特写。
    // 飞渡窗口里**用完全相同的参数**：安全摆放本身是逐帧的硬保证，若只对窗口内放宽，
    // 那么进出窗口的那一帧就会因为「有没有这一步」而差出好几 studs —— 又是一次硬跳。
    // 输入姿态在窗口两端已被 k 加权接上，输出自然也就接上了。
    // ★ POV 整段跳过：机位就在玩家头里，射线从头顶往外打只会打到「自己的身体 / 贴着的墙」，
    //   地面 / 天花板 / 水面钳制更会把镜头从头上推开 —— 而修正量低通又让这份偏移逐帧漂移。
    _rawPos.copy(_v1);
    if (!isPov) {
      this._safePlace(_v1, _v2, wetPlayer, false, true, minDist, dt, ixChanged);

      // 曲线滤波：把「安全摆放带来的修正量」做一阶低通（机位本身走解析式，不动它）。
      // 掠过门框 / 墙角时射线命中距离会一帧一跳，水面钳制又是硬赋值 ——
      // 这两处才是画面里真正看得见的抖；把它们抹平，机位轨迹仍是解析曲线，不添滞后。
      _corr.copy(_v1).sub(_rawPos);
      // 切镜帧把修正量直接取到目标值：硬切本来就是瞬时的，慢慢收敛会读成「切过去又推近一截」。
      // 但**飞渡窗口里不吸附** —— 窗口正中就是切点，此刻机位正走在贝塞尔路径上，
      // 而路径的修正量（安全摆放 vs 理想姿态之差）可能因为运行时射线与 plan 期的差异突然变大：
      // 吸附那一帧就是「把几个帧才该走完的收缩一次走完」，正是飞渡窗口里的硬跳。
      // 交给同一套低通（`CORR_MAX_STEP` 已给单帧位移封顶）慢慢推过去。
      if (ixChanged && !fly) this._corr.copy(_corr);
      else {
        // 非对称：修正量在变大（正在被躲开障碍）时躲得急一点，回到理想曲线时慢慢来。
        // 对称低通在「墙突然出现在机位方向上」的那几帧会明显落后，落后就得靠后面那道
        // 硬保证去补 —— 补出来的就是一个跳变，所以躲避方向必须快。
        const rate = sRate(_corr.lengthSq() > this._corr.lengthSq() ? CORR_DAMP_SAFE : CORR_DAMP);
        _corr2.copy(_corr).sub(this._corr).multiplyScalar(1 - Math.exp(-rate * dt));
        // 单帧位移上限：低通摊开的量与阶跃同量级（44 studs 的 `want` 第一帧就给出 7.4），
        // `_fitPlace` 的换位更是一次赋值（23.8 studs）—— 这两处是「段内一帧大跳」的全部来源。
        // 夹住增量之后，遮挡收缩与换位都变成 0.2~0.4s 的匀速滑移。
        if (_corr2.lengthSq() > CORR_MAX_STEP * CORR_MAX_STEP) _corr2.setLength(CORR_MAX_STEP);
        this._corr.add(_corr2);
      }
      _v1.copy(_rawPos).add(this._corr);
      // 平滑过的修正量此刻「还不够」把机位救出墙外，所以再兜一次：只做地面 / 天花板 / 水面钳制
      // （minPush = false，且**不再自行做视线收缩** —— 收缩已经由上面那次调用按 `_shrink` 低通推进，
      //  在这里再硬收一遍会把低通架空，正是「贴着柱子转 → 一帧大跳」的成因）
      this._safePlace(_v1, _v2, wetPlayer, false, false, minDist, dt);
    }

    // 变焦补偿（治「变焦太差」）：被墙 / 天花板挤近时，按「主体在画面里的大小不变」反解视场角，
    // 宁可用硬广角把主体装回画框，也不在贴脸的位置上继续用长焦 —— 后者才是又晕又看不清。
    // 只在切镜那一刻算一次：逐帧跟着射线命中距离重算会让视场角持续呼吸（变焦抽动比贴脸更晕）。
    // 结果同样夹在 [FOV_MIN, FOV_MAX] 内（有了不贴脸下限之后，1.9 倍的 k 基本不会被拉满）。
    let clipFov;
    if (fly) {
      // 飞渡期间视场角走**预分析好的两端**之间插值，不做挤近补偿：
      //   · 逐帧补偿要用 realD，而窗口里的 realD 是混合后的位置量出来的，会随贝塞尔起伏
      //     → 视场角在窗口里持续呼吸（变焦抽动比贴脸更晕）；
      //   · 窗口正中当前镜头从 A 换成 B，`shot.fov` 一帧内就换掉，又是一个瞬间变焦。
      // 起点取窗口首帧实测的 `this._fov`（于是与窗口外 A 镜的视场角严丝合缝），
      // 终点取 plan 期烘进 link 的 `fly.fov1`（B 镜基准值，窗口结束后由它锁存）。
      // 代价：B 镜这一段的挤近补偿不生效（它的切镜帧落在窗口内），画面会比理想值略「近」一点。
      if (this._flyFrom == null) this._flyFrom = this._fov;
      clipFov = this._flyFrom + (fly.fov1 - this._flyFrom) * fly.fw;
    } else {
      clipFov = shot.fov;
      const realD = _v1.distanceTo(_v2);
      if (shot.type !== 'pov' && realD < idealD - 0.01) {
        const k = clamp(idealD / Math.max(0.01, realD), 1, 1.9);
        const half = THREE.MathUtils.degToRad(shot.fov) * 0.5;
        clipFov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) * k)), FOV_MIN, FOV_MAX);
      }
    }
    if (cut || fly || isPov || this._look.lengthSq() === 0) {
      // 切镜：硬切（相机直接跳过去，这才是剪辑）；
      // 飞渡窗口：姿态已由上面的 k 加权混合给出（窗口两端 k=0，等价于不插值的自然姿态，
      // 所以从这一支进出窗口不会跳），这里同样直接写，不走视线阻尼。
      // POV：每帧都吸附 —— 机位 / 视线就是 `povAim` 的解，不许有任何阻尼或前馈。
      // （顺带把 `_viewOk` 清掉，下面的视线限速就不会再来拖 POV 的头。）
      this._pos.copy(_v1);
      this._look.copy(_v2);
      this._clipIx = ix;
      this._fov = clipFov;
      this._viewOk = false;
    } else {
      // 镜头内部：位置解析式已经平滑（且做过修正量低通），对焦点也只做一点点阻尼
      this._pos.copy(_v1);
      this._look.lerp(_v2, 1 - Math.exp(-sRate(LOOK_DAMP) * dt));
      // 视场角在一镜之内保持恒定：变焦只在切镜时变，绝不逐帧抽动
    }
    // ★ 视线角速度硬限速（治「甩」的最后一道兜底）：
    //   机位本身已经被锚点低通 + 切向限速 + 修正量低通稳住了，视线点也只做了阻尼，
    //   但「视线点在世界里平移」到「相机转头」要除以距离 —— 距离被墙挤到四五 studs 时，
    //   一点点平移就能换来几十度的转头。这一条直接对**转头角速度**封顶，
    //   与机位怎么算无关，所以它是唯一能给出「绝不甩」硬保证的地方。
    //   与其他稳镜措施一样：急动时上限再往下压，宁可让主体偏离画框中心，也不甩。
    //   飞渡不做限速：路径本身就是平滑的，限速只会让镜头追不上路径而落后于贝塞尔。
    if (!cut && !fly && this._viewOk) {
      _viewNow.copy(this._look).sub(this._pos);
      const len = _viewNow.length();
      if (len > 1e-4) {
        _viewNow.divideScalar(len);
        const maxA = sRate(LOOK_TURN_MAX) * (1 - 0.35 * this._jerk);
        const cur = Math.min(Math.PI, Math.acos(clamp(_viewNow.dot(this._view), -1, 1)));
        const lim = maxA * dt;
        if (cur > lim && cur > 1e-4) {
          // 沿「旧视线 → 新视线」的最短弧只走 lim 那么长：轴取两视线的叉积，角度取 lim。
          // 不用 setFromUnitVectors —— 两视线接近反向（一帧内 ≈180° 掉头）时它是奇异点，
          // 兜底轴按 x/z 大小硬选，会带来一次 roll 突跳；叉积退化时改用世界正上，
          // 那恰好就是「水平掉头」这个唯一合理的解释。
          _viewAxis.crossVectors(this._view, _viewNow);
          if (_viewAxis.lengthSq() < 1e-10) _viewAxis.copy(UP); else _viewAxis.normalize();
          _viewQ.setFromAxisAngle(_viewAxis, lim);
          _viewTo.copy(this._view).applyQuaternion(_viewQ).normalize();
          this._look.copy(this._pos).addScaledVector(_viewTo, len);
        }
      }
    }
    _viewNow.copy(this._look).sub(this._pos);
    if (_viewNow.lengthSq() > 1e-8) {
      this._view.copy(_viewNow).normalize();
      this._viewOk = true;
    }

    _v1.copy(this._pos);
    _v2.copy(this._look);
    // 刻意不加手持噪声：用户要的是「稳」，而高频位移人眼解释不成「摄影师在呼吸」，
    // 只会被读成画面失控 —— 那是晕 3D 的头号来源。镜头感交给机位与剪辑。

    /* ------------------------------------------------------------
       最终级平滑：机位（位移）与对焦点（角度）一起过低通
       ------------------------------------------------------------
       这一层是「真正写进相机的那一帧」的最后一手，见文件头 SM_* 常量处的说明。
       要诀是：位置与对焦点**一起**外推、一起低通 —— 只推机位会把主体往画框外推，
       两个都推才是纯平移的等效，主体在画面里的相对位置才不变。
       ------------------------------------------------------------ */
    const jump = (this._smT >= 0 && Math.abs(it.srcT - this._smT) > Math.max(SM_SNAP_DT, dt * 3.5))
      || (this._smOk && !cut && _v1.distanceTo(this._smTP) > SM_SNAP_DIST);
    if (cut || !this._smOk || jump || isPov) {
      // 硬切 / 首帧 / 拖进度条 / 瞬移：直接吸附。
      // 平滑只该稳「连续运动」，不该去抹真实跳变 —— 抹了就是画面拖着人追。
      // POV：每帧都吸附。这一层是「提前零点几秒」的最大来源 ——
      //   `_smVel × SM_POS_LEAD` / `_smVelL × SM_LOOK_LEAD` 按速度把机位与视点整体外推，
      //   再加上 SM_*_DAMP 的低通滞后，POV 就被拖成一条「追着自己影子跑」的曲线。
      //   外推量为零后，`_smP / _smL` 就等于 `povAim` 的当前姿态，POV 重新绑回玩家的头。
      //   状态照常在下面写回（`_smTP / _smTL / _smT`），所以离开 POV 时不会误判成瞬移。
      this._smP.copy(_v1);
      this._smL.copy(_v2);
      this._smVel.set(0, 0, 0);
      this._smVelL.set(0, 0, 0);
      this._smOk = true;
    } else {
      const idt = 1 / Math.max(1e-4, dt);
      const kv = 1 - Math.exp(-sRate(SM_VEL_DAMP) * dt);
      _smTmp.copy(_v1).sub(this._smTP).multiplyScalar(idt);
      this._smVel.lerp(_smTmp, kv);
      _smTmp.copy(_v2).sub(this._smTL).multiplyScalar(idt);
      this._smVelL.lerp(_smTmp, kv);
      // 目标 = 当前姿态 + 速度 × 前馈时长（外推量设上限：极窄处被墙钉住时速度会突然掉头）
      _smTmp.copy(this._smVel).multiplyScalar(sLead(SM_POS_LEAD));
      if (_smTmp.length() > sLead(SM_LEAD_MAX)) _smTmp.setLength(sLead(SM_LEAD_MAX));
      _smTmp.add(_v1);
      this._smP.lerp(_smTmp, 1 - Math.exp(-sRate(SM_POS_DAMP) * dt));
      _smTmp.copy(this._smVelL).multiplyScalar(sLead(SM_LOOK_LEAD));
      if (_smTmp.length() > sLead(SM_LEAD_MAX)) _smTmp.setLength(sLead(SM_LEAD_MAX));
      _smTmp.add(_v2);
      this._smL.lerp(_smTmp, 1 - Math.exp(-sRate(SM_LOOK_DAMP) * dt));
      // ★ 径向夹紧：平滑后的机位绝不允许比「已过硬保证」的原始机位更远离对焦点。
      //   避障收缩永远是沿视线把机位往主体拉，所以只要不比原始机位更靠外，
      //   就绝不可能钻进那面挡住视线的墙 —— 而这条夹紧只改径向长度，是连续的。
      //   基准取「平滑后的对焦点」而不是原始对焦点：位置与对焦点是一起外推的
      //   （整体平移），拿原始对焦点量距离会把这份平移误判成「变远了」而把前馈抵掉。
      const dRaw = _v2.distanceTo(_v1);
      _smTmp.copy(this._smP).sub(this._smL);
      const dSm = _smTmp.length();
      if (dRaw > 0.001 && dSm > dRaw) this._smP.copy(this._smL).addScaledVector(_smTmp, dRaw / dSm);
      // 地面 / 天花板 / 水面：只做钳制、不打视线射线（视线方向的穿透由上面那条径向夹紧负责）
      this._safePlace(this._smP, this._smL, wetPlayer, true, false, minDist, dt);
    }
    this._smTP.copy(_v1);
    this._smTL.copy(_v2);
    this._smT = it.srcT;

    /* ------------------------------------------------------------
       朝向：不再用 camera.lookAt
       ------------------------------------------------------------
       lookAt 隐含 up = (0,1,0)：视线一旦逼近正上 / 正下，up 与视线共线、叉积退化，
       three.js 的兜底是给 z 加 0.0001 再重算 —— 换来的就是 roll 在两帧之间翻转 180°，
       也就是万向锁在相机上的表现（俯拍 / 俯冲瞬间「画面立起来」）。
       这里自己构造旋转，并在近垂直段把参考「上方向」平滑地接到上一帧相机的上方向：
       视线垂直时 roll 本来就未定义，唯一连续的定义就是沿用上一帧，于是不再翻转。
       ------------------------------------------------------------ */
    _fwdV.copy(this._smL).sub(this._smP);
    if (_fwdV.lengthSq() < 1e-8) _fwdV.copy(_v2).sub(_v1);
    if (_fwdV.lengthSq() < 1e-8) _fwdV.set(0, 0, -1);
    _fwdV.normalize();
    const vert = Math.abs(_fwdV.y);
    _upV.copy(UP);
    // POV：视线由 `povAim` 的「机位 + 视点」给出，且俯仰已夹在 ±54°，远离 ±90° 的奇异带，
    // 所以这里直接用 UP 构造即可，roll 恒为 0（第一人称就该没有 roll）。
    // 若还走下面的万向锁接续，会去沿用上一帧的 up，等于给 POV 补一段它不该有的 roll。
    if (!isPov && vert > GIMBAL_COS) {
      // 上一帧相机实际的上方向（roll 连续）；硬切那一帧不沿用，直接用世界正上重置
      _upV.set(0, 1, 0).applyQuaternion(camera.quaternion);
      if (cut || !this._smOk) _upV.copy(UP);
      _upV.addScaledVector(_fwdV, -_upV.dot(_fwdV));     // 剔除与视线共线的分量
      if (_upV.lengthSq() < 1e-6) {
        _upV.set(1, 0, 0).cross(_fwdV);
        if (_upV.lengthSq() < 1e-6) _upV.set(0, 0, 1);
      }
      _upV.normalize();
      // 越垂直越依赖上一帧的 roll；进入 / 退出这一段都是连续的（带宽外仍是世界正上）
      _upV.lerp(UP, 1 - smoothstep(clamp((vert - GIMBAL_COS) / GIMBAL_BAND, 0, 1)));
      if (_upV.lengthSq() < 1e-8) _upV.copy(UP);
    }
    _lookM.lookAt(this._smP, this._smL, _upV);
    camera.position.copy(this._smP);
    camera.quaternion.setFromRotationMatrix(_lookM);
    camera.up.set(0, 1, 0);      // 只影响后续 lookAt 的约定；本帧朝向由 quaternion 决定
    // 最后一道保险：无论上游怎么算，真正写进相机的视场角一定落在 [FOV_MIN, FOV_MAX] 内
    const outFov = clamp(this._fov, FOV_MIN, FOV_MAX);
    if (Math.abs(camera.fov - outFov) > 0.05) {
      camera.fov = outFov;
      camera.updateProjectionMatrix();
    }
  }

  /* ---------- 解算：返回 { 机位, 对焦点 } ---------- */
  _solve(shot, s, outPos, outLook, dt, cut) {
    const feet = _tmpA.set(s.x, s.y, s.z);
    // 注意：主体锚点（this._anchor）的低通**不在这里**做 —— 它已提到 `update()` 里。
    // 转场分析（_nominalPose）需要把 `_solve` 依赖的跨帧状态整体借出 / 还回，
    // 借出清单越小越安全；而且锚点是「调度层」的概念，不属于单个镜头的解算。
    const yaw = s.fy;
    const fwd = _tmpB.set(Math.sin(yaw), 0, Math.cos(yaw));
    const right = _tmpC.set(-fwd.z, 0, fwd.x);           // cross(forward, up)
    // 视线高度：永远略低于机位。低天花板会把机位压到胸口以下，若还盯着固定的 1.75 就会
    // 变成「镜头在下、视线朝上」的仰拍 —— 画面里地平线被甩动，是最容易晕的一种构图。
    // 反过来也不能盯着脚底看（那是俯视贴地），所以下限留 0.6。
    const focusH = clamp(shot.focusH, 0.6, Math.max(0.6, shot.h - 0.35));
    const u = smoothstep(clamp(shot.u * shot.pace, 0, 1));
    const raw = clamp(shot.u * shot.pace, 0, 1);

    // 轨迹切向：跟拍 / 迎面引导沿「记录里实际走过的轨迹」前后偏移，
    // 而不是沿角色当前朝向 —— 朝向在转身、后退、原地打转、侧滑时会和运动方向脱节，
    // 按朝向摆机位就会在玩家一转身时把镜头整个甩到另一边。走得慢就用朝向兜底。
    // ★ 智能预分析：切向在 plan 期已烘成 `clip.motion.tan`（零相位低通 + 双向限速，
    //   没有因果滞后），运行期直接查表；只有 POV / 过短段（m == null）才回退旧的因果路径。
    const trv = _tmpG;
    const mo = shot.m;
    if (mo) {
      const a = curveAt(mo.tan, mo.t0, mo.dt, shot.t);
      trv.set(Math.sin(a), 0, Math.cos(a));
    } else {
      this._travelDir(shot.t, fwd, trv, dt, cut, AHEAD_CAM.has(shot.type));
    }

    // 对焦点：主体胸口 + 轨迹前瞻（避免角色贴出画框）。
    // 两处「急动折扣」：
    // · 前瞻量沿切向，切向一反向就会把视线点整个甩到主体另一侧，急动时几乎关掉；
    // · 对焦点本身改按急动程度混入阻尼后的锚点 —— 机位稳住了、视线点却还在逐帧跟主体
    //   的横向甩动，等于把同一份甩动从「平移」改成「转头」，而转头才是最晕的那一半。
    //   混入后读作「机器端住了，主体自己在画面里荡」。
    //   注意：锚点的低通目标是**前瞻点**（见 `update` 里的 LEAD_K），所以「混入锚点」
    //   不再等于「把视线点拖到主体身后」—— 这正是过去 walljump 时主体顶出画框的根因。
    const jw = 0.7 * this._jerk;
    outLook.set(
      feet.x + (this._anchor.x - feet.x) * jw,
      feet.y + (this._anchor.y - feet.y) * jw + focusH,
      feet.z + (this._anchor.z - feet.z) * jw);
    outLook.addScaledVector(trv, shot.lead * 0.45 * (1 - 0.85 * this._jerk));

    const dir = _tmpE;      // 机位方位（各镜头类型自己 set）
    // 锁定机位：方位角是世界绝对角，机位在世界上钉住「角度」，但跟着主体平移 ——
    // 角度钉住 = 玩家一甩鼠标转头，镜头不会绕着对焦点甩出去一大段弧；
    // 位置跟进 = 距离恒定，跑起来的角色不会在画面里越缩越小（也不会跑出画框）。
    const azDir = (a) => dir.set(Math.sin(a), 0, Math.cos(a));
    const azRight = () => right.set(-dir.z, 0, dir.x);   // 与该方位角垂直的横向轴（同样冻结）
    switch (shot.type) {
      case 'static':
        azDir(shot.azim);
        azRight();
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist).y += shot.h;
        outPos.addScaledVector(right, (raw - 0.5) * 0.7);      // 极缓的呼吸式位移
        outPos.y += (raw - 0.5) * 0.25;
        break;
      case 'pushIn':
        azDir(shot.azim);
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist * (1.3 - 0.42 * u)).y += shot.h * (1 - 0.18 * u);
        break;
      case 'pullOut':
        azDir(shot.azim);
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist * (0.72 + 0.7 * u)).y += shot.h + 1.1 * u;
        break;
      case 'track':
        azDir(shot.azim);
        azRight();
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist).y += shot.h;
        outPos.addScaledVector(right, (u - 0.5) * shot.travel);   // 横向平移
        break;
      case 'swing':
        azDir(shot.azim + (u - 0.5) * 0.8);
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist * (1.06 - 0.16 * u)).y += shot.h + Math.sin(u * Math.PI) * 0.5;
        break;
      case 'crane':
        azDir(shot.azim + (u - 0.5) * 0.3);
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist).y += shot.h + shot.wind * u * 2.4;
        break;
      case 'orbit':
        azDir(shot.azim + shot.wind * u * 0.85);
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist).y += shot.h;
        break;
      case 'follow': {
        // 后方轨迹跟拍：机位沿「实际走过的轨迹」往后退 dist，略偏右肩。
        // 用轨迹切向而不是朝向 —— 玩家一转身，镜头不会跟着甩到另一边。
        const rt = _tmpH.set(-trv.z, 0, trv.x);
        dir.set(trv.x, 0, trv.z).applyAxisAngle(UP, -0.42);
        outPos.copy(this._anchor).addScaledVector(dir, -shot.dist).y += shot.h;
        outPos.addScaledVector(rt, shot.dist * 0.18);
        break;
      }
      case 'lead': {
        // 前方轨迹跟拍（朝轨迹反方向）：机位摆在主体「将要去」的前方，回头看着他。
        // 同样用轨迹切向，主体掉头时镜头跟着掉头，而不是莫名其妙地穿到身后。
        const rt = _tmpH.set(-trv.z, 0, trv.x);
        // ★ 锚点滞后补偿（治「迎面引导越跑越贴脸」）：
        //   机位 = 锚点 + 前方 dist，而锚点是主体位置的低通（滞后 lag ≈ v·(τ − 前瞻量)），
        //   且主体的运动方向就是 +trv —— 于是实际间距只剩 dist − lag：主体越迎面冲过来、跑得越快，
        //   这段亏损越大。这就是「由于平滑，摄像头拉晚了」的账。
        //   把滞后里沿轨迹的分量原样加回距离，迎面间距回到 dist、与速度解耦。
        //   （肩后跟随 / 无人机俯追在另一侧：滞后只会让它们更远，所以只有迎面这一支需要补。）
        const lag = Math.max(0, (s.x - this._anchor.x) * trv.x + (s.z - this._anchor.z) * trv.z);
        outPos.copy(this._anchor).addScaledVector(trv, shot.dist + lag).y += shot.h;
        outPos.addScaledVector(rt, shot.dist * 0.12 * (1 - 2 * u));
        break;
      }
      case 'lowHero':
        azDir(shot.azim);
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist * (1 - 0.12 * u)).y += 0.62 + 0.22 * u;
        break;
      case 'topDown':
        // 俯瞰：机位高度已按天花板压过（见 _makeShot），这里只按高度决定「俯角」——
        // 水平偏移取 dist 的 0.32：高时接近真·正俯拍，被天花板压住时也有 50° 以上俯角，
        // 两者都比贴脸平视强。方位角取「绝对角相对关键帧朝向的偏移」，所以仍是沿轨迹侧后方。
        dir.set(trv.x, 0, trv.z).applyAxisAngle(UP, angDiff(shot.azim, shot.key.yaw));
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist * 0.32).y += shot.h - 1.2 * u;
        break;
      case 'topOrbit': {
        // 高空环绕：机位在主体上方绕出一段弧（约 1.5 rad ≈ 86°），一边转一边缓缓下降 ——
        // 无人机最经典的「绕主体一圈」语言。方位角钉在世界绝对角上、只有锚点跟着主体平移，
        // 所以画面里是一次匀速、单方向的横向划过，不掺任何「随角色转头甩出去」的分量。
        azDir(shot.azim + shot.wind * u * 1.5);
        const r = shot.dist * (0.92 + 0.14 * Math.sin(u * Math.PI));   // 中段略微外扩，别蹭到主体
        outPos.copy(this._anchor).addScaledVector(dir, r).y += shot.h - 1.8 * u;
        break;
      }
      case 'droneTrack': {
        // 无人机俯追：吊在轨迹的后上方、顺着轨迹走 —— 既有「跟」的速度感，又有「俯」的全景感，
        // 高度取在俯瞰与跟拍之间。方位角按「绝对角相对关键帧朝向的偏移」旋转轨迹切向，
        // 所以它相对轨迹的方位是固定的（不会因为角色转头而绕着主体甩）；侧向再缓慢漂一点，
        // 读作无人机在微调站位，而不是镜头在抖。
        dir.set(trv.x, 0, trv.z).applyAxisAngle(UP, angDiff(shot.azim, shot.key.yaw));
        const rt = _tmpH.set(-trv.z, 0, trv.x);
        outPos.copy(this._anchor).addScaledVector(dir, -shot.dist * 0.55).y += shot.h - 0.5 * u;
        outPos.addScaledVector(rt, shot.dist * 0.12 * (1 - 2 * u));
        break;
      }
      case 'helicopter':
        // 直升机悬停：机位基本钉住，只做很慢的「漂浮」（竖直一个周期的小起伏 + 方位角小幅漂移）——
        // 读作「有一台直升机停在那儿看着我」。没有持续位移，是俯拍里最不容易晕的一种。
        azDir(shot.azim + (u - 0.5) * 0.24);
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist * (1 - 0.1 * u)).y += shot.h + Math.sin(u * Math.PI * 2) * 0.32;
        break;
      case 'descent':
        // 高空降落：从很高处一路降下来，同时向主体收拢；方位角几乎不动，只留一点点漂移，
        // 所以画面里是一条干净的竖向运动 —— 开场建立镜头与收尾余韵都很吃这一镜。
        azDir(shot.azim + (u - 0.5) * 0.18);
        outPos.copy(this._anchor).addScaledVector(dir, shot.dist * (1.06 - 0.4 * u)).y += shot.h * (1 - u) + 2.8;
        break;
      case 'steadicam': {
        // 斯坦尼康：机身吊在主体「后方偏上」，跟随的是轨迹而不是朝向。
        // 水平用阻尼（稳定感 + 走位滞后），竖直阻尼更快但不隔振 ——
        // 真实的斯坦尼康正是「隔掉竖直颠簸、保留水平跟随」。
        // 急动时水平阻尼再放宽一档（人挂在身上的机器，遇到连续蹬墙也是先稳住再补位），
        // 前瞻同步收掉：前瞻是沿切向的，切向一反向就会把视线点甩到主体另一侧。
        const je = this._jerk;
        const rt = _tmpH.set(-trv.z, 0, trv.x);
        // 机身阻尼按「标称距离」算（目标稳定），动态收距离则**前馈**直接叠加：
        // 3.2/s 的机身阻尼跟不上包络表的预收，不前馈就会在预收窗口里撞墙。
        const dDyn = shot.dist - shot.planDist;
        const back = shot.planDist * 0.98, side = shot.dist * 0.16 * (1 - 0.7 * je);
        let ax = this._anchor.x - trv.x * back + rt.x * side - trv.x * dDyn * 0.98;
        const ay = this._anchor.y + shot.h;
        let az = this._anchor.z - trv.z * back + rt.z * side - trv.z * dDyn * 0.98;
        if (cut || this._look.lengthSq() === 0) {
          this._stay.set(ax, ay, az);
        } else {
          // ★ 这里只更新机身阻尼状态，**不把安全摆放的修正量写回 `_stay`**：
          //   `_rawPos` 就是 `_stay`，而 `_v1 = _rawPos + _corr` —— 写回等于每帧 `_stay += _corr`，
          //   而 `_corr` 是低通后仍在收敛的量（被柱子遮挡时可达 −36 studs），
          //   于是机身目标每帧被拖走 36 studs，形成正反馈发散（实测冲到离原点 130+ studs 的虚空）。
          //   修正量本就该统一由 `_corr` 那一层承担，与 static / track / orbit 等机型一致。
          const kh = 1 - Math.exp(-sRate(3.2 - 1.7 * je) * dt);
          const kv = 1 - Math.exp(-sRate(8 - 4 * je) * dt);
          this._stay.x += (ax - this._stay.x) * kh;
          this._stay.z += (az - this._stay.z) * kh;
          this._stay.y += (ay - this._stay.y) * kv;
        }
        outPos.copy(this._stay);
        // 前瞻：画框看向「主体将要去的地方」（轨迹切向 × 速度 × 0.3s），跟拍才有方向感。
        // 对焦点同样按急动程度混入阻尼锚点：机身已经端稳了，视线也不能还在逐帧扫。
        const la = clamp(s.sp * sLead(0.05), 0, sLead(0.42)) * (1 - 0.85 * je);
        outLook.set(
          s.x + (this._anchor.x - s.x) * je,
          s.y + (this._anchor.y - s.y) * je + focusH,
          s.z + (this._anchor.z - s.z) * je);
        outLook.x += trv.x * s.sp * la;
        outLook.z += trv.z * s.sp * la;
        break;
      }
      case 'pov': {
        // 沉浸 POV：从身体数据重建（头位置 + 身体朝向 + 前瞻），与 PovPlayer 逐帧同一函数，
        // 所以 plan 期算出来的标称姿态与运行期实际上的姿态逐元素一致，转场接得上。
        // ★ 这里是「运镜整体提前」的唯一例外：POV 的机位就是玩家自己的头，
        //   必须与记录里的玩家严格同步（`s.t` 是真实播放时间），提前了就成了「看见未来」。
        //   提前量在这条只体现为「切进 POV 的时刻早了 n 秒」，画面内容仍是当下的记录。
        //   `POV_AHEAD` 是**视线**的前瞻（看向将要到的地方），不是机位的时间偏移。
        // 俯仰在这里单独过一条智能平滑（`shot` 是逐帧解算，过滤才有意义）；`cut` 那一帧
        // 直接吸附。plan 期的 `_nominalPose` 也走这条（cut=true），但状态会被借出 / 还回。
        povAim(this.data, s.t, outPos, outLook, this._povP, dt, cut);
        break;
      }
      default:
        azDir(shot.azim);
        outPos.copy(this._anchor).addScaledVector(dir, -shot.dist).y += shot.h;
        break;
    }
  }

  /**
   * 轨迹切向（水平单位向量）：用记录里「前后各取一个采样点」算主体实际走过的方向。
   * 这是跟拍 / 迎面引导 / 俯瞰的水平方位基准 —— 用轨迹而不是角色朝向，
   * 镜头才不会在玩家一转身时被甩到另一边。
   *
   * 拿到原始切向之后必须再稳一道（这才是「连续蹬墙 / 快速左右跳」的根治处）：
   * 原始切向是 15Hz 折线的割线，主体一反向它就整体掉头 —— 机位在主体两侧之间对甩，
   * 画面里就是又震又晕。这里用「角速度限速」给它封顶（低通对 180° 阶跃第一帧就能给 ~100°，
   * 单靠低通不够），急动时把限速再压到 ~1/3。
   * 切镜 / 拖进度条时直接吸附到原始值：那一帧镜头本来就要硬切，没有「甩」的问题。
   *
   * @param t 源时间（秒）
   * @param fwd 兜底方向（几乎没在走的时候用朝向）
   * @param out 写入的向量
   * @param dt 帧间隔
   * @param cut 本帧是不是切镜（是则不做平滑）
   * @param ahead 迎面机位（lead）：切向就是它的取景轴，按 AHEAD_* 跟紧一档
   */
  _travelDir(t, fwd, out, dt = 1 / 60, cut = false, ahead = false) {
    const d = this.data;
    const span = 0.24;
    const a = d.sampleAt(clamp(t - span, 0, d.duration), _sA);
    const b = d.sampleAt(clamp(t + span, 0, d.duration), _sB);
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    let tx, tz;
    if (len < 0.08) { tx = fwd.x; tz = fwd.z; }      // 原地不动 / 原地打转：退回朝向
    else { tx = dx / len; tz = dz / len; }
    // 兜最后一道：轨迹方向与朝向「对着干」时（比如沿墙横移、被推着走），
    // 用两者混合，避免镜头横甩；夹角大于 ~100° 才混合，正常走路不受影响。
    const dot = tx * fwd.x + tz * fwd.z;
    if (dot < -0.17) {
      tx = tx * 0.55 + fwd.x * 0.45;
      tz = tz * 0.55 + fwd.z * 0.45;
      const l2 = Math.hypot(tx, tz);
      if (l2 > 1e-4) { tx /= l2; tz /= l2; }
    }
    const ta = Math.atan2(tx, tz);
    if (cut || !this._tanOk) { this._ca = ta; this._tanOk = true; }
    else {
      const je = clamp(this._jerk, 0, 1);
      // 迎面机位（lead）：切向就是它的取景轴，跟紧优先于稳住 —— 基准速率与转向限速同乘
      // AHEAD_TAN_MUL，急动档也只按 AHEAD_TAN_JERK 的比例退（1 = 完全不退档）。
      // 普通跟拍 / 俯拍族没有这个问题：机位在轨迹后方或上方，切向慢一拍只是「更远」。
      const famp = ahead ? AHEAD_TAN_MUL : 1;
      const deJ = ahead ? AHEAD_TAN_JERK : 1;
      const rate = sRate(famp * (TAN_DAMP + (TAN_DAMP_JERK - TAN_DAMP) * je * deJ));
      const turn = sRate(famp * (TAN_TURN + (TAN_TURN_JERK - TAN_TURN) * je * deJ));
      const step = angDiff(ta, this._ca) * (1 - Math.exp(-rate * dt));
      const lim = turn * Math.max(0, dt);
      this._ca += clamp(step, -lim, lim);
    }
    out.set(Math.sin(this._ca), 0, Math.cos(this._ca));
    return out;
  }

  /**
   * 主体「急动」程度 0~1：由记录位置逐帧差分的水平加速度得出。
   * 走路加减速在 20 studs/s² 以内，连续蹬墙 / 快速左右跳轻松破 100 ——
   * 这个量一旦上去，锚点低通、轨迹切向、视线限速会一起退到「稳住机器」的档位。
   * 进得快、出得慢：蹬墙一开始就要稳住，人稳下来之后仍多稳一会儿再恢复跟拍。
   * 差分按**源时间**（而不是帧间隔）做：倍速回放时帧间隔不变、位置走得更多，
   * 用帧间隔会把 3 倍速下的正常走路也算成急动。
   * @param dSrc 与上一帧之间的源时间差（秒）
   * @param cut  切镜 / 拖进度条：差分链断掉，本帧只重置不做判定
   * @param dt   真实帧间隔（只用于急动值的进出速率）
   */
  _jerkLevel(s, dSrc, cut, dt) {
    const mv = this._mv;
    let want = 0;
    const bad = cut || !(dSrc > 1 / 240) || dSrc > 0.2;
    if (!bad) {
      const vx = (s.x - mv.x) / dSrc, vz = (s.z - mv.z) / dSrc;
      // 上一帧的速度可用时才算加速度；刚起链的那一帧只记录不算（否则「从 0 跳到 8」会被读成急动）
      if (mv.vk) {
        const inst = Math.hypot(vx - mv.vx, vz - mv.vz) / dSrc;
        want = clamp((inst - JERK_ACCEL) / (JERK_FULL - JERK_ACCEL), 0, 1);
      }
      mv.vx = vx; mv.vz = vz; mv.vk = true;
    } else {
      mv.vk = false;                    // 链断：下一帧重新起链
    }
    mv.x = s.x; mv.z = s.z;
    if (s.state === 'walljump') want = Math.max(want, 0.7);   // 状态本身就是急动，不必等加速度算出来
    const rate = want > this._jerk ? JERK_RISE : JERK_FALL;
    this._jerk += (want - this._jerk) * (1 - Math.exp(-rate * Math.max(0, dt)));
    this._jerk = clamp(this._jerk, 0, 1);
    return this._jerk;
  }

  /**
   * 射线安全摆放：焦点 → 机位之间的实体与「最小距离」先定距离，再做地面 / 天花板 / 水面钳制。
   * 这是「摄像机不会跑到墙外」的硬保证；再加水面规避与地面 / 天花板钳制。
   * @param wetPlayer 玩家（头）是否在水里：不在水里时镜头绝不允许落到液面以下
   * @param skipRay   POV 不做射线收缩（记录机位本来就是合法的，收缩反而会把镜头拽进墙里）
   * @param minPush   是否执行「至少离主体 minDist」的外推。
   *                  第一次摆放要（保证不贴脸）；平滑滤波之后的第二次兜底不要 ——
   *                  那时机位已经在合法区间里，再外推一次反而会把刚抹平的抖动又推回来。
   * @param minDist   「不贴脸」的机位下限（由镜头视场角与主体外接半径算出）
   * @param dt        帧时长（视线遮挡的收缩预算靠它推进；默认 1/60）
   * @param snap      切镜帧：低通状态直接取目标值。硬切本来就是瞬时的，
   *                  这里若还慢慢收敛，读起来就成了「切过去之后又缓缓推近一截」。
   */
  _safePlace(pos, look, wetPlayer, skipRay, minPush = true, minDist = MIN_CAM_DIST * RETREAT, dt = 1 / 60, snap = false) {
    const world = this.ctx.world;
    if (!world) return;
    const d = look.distanceTo(pos);
    if (d < 0.001) return;
    _dir.copy(pos).sub(look).divideScalar(d);
    // ① 距离决策（刻意放在钳制之前，免得被后面的硬保证推翻）：
    //    · 没实体挡着 → 至少退到 minDist（贴脸是眩晕的主要来源之一）
    //    · 有实体挡着 → 收到墙前；若这样会挤到比 minDist 还近，
    //      走候选阶梯（沿墙滑移 / 抬机位）找一个「够远且看得见主体」的机位，
    //      绝不再像以前那样一路贴到 1.2 变成广角大特写。
    //    · 「收多少」自己不直接赋值，而是先写进 `_shrink`（非对称一阶低通，见 BLK_SHRINK 的注释）：
    //      擦着柱子转过去时，射线命中距离是一帧之内从 ∞ 掉到几 studs 的阶跃，
    //      直接把机位按到墙前就是一帧横移十几 studs（段内大跳）；低通之后这个阶跃被摊成 0.4s。
    //      注意 `_shrink` 只在第一次调用（minPush=true）推进：一次决策推一帧，不重复计入。
    let use = d;
    if (!skipRay) {
      _from.set(look.x, look.y, look.z);
      _to.set(pos.x, pos.y, pos.z);
      let block = Infinity, bn = null;
      _hits.length = 0;
      world.raycastAll(_from, _to, { collisionFilterGroup: 2, collisionFilterMask: 1, skipBackfaces: true }, (r) => {
        if (this.ctx.playerBody && r.body === this.ctx.playerBody) return;
        if (r.body && r.body.collisionResponse === false) return;
        _hits.push(r);
      });
      for (const h of _hits) if (h.distance < block) { block = h.distance; bn = h.hitNormalWorld; }
      if (block < d) {
        const floor = minPush ? HARD_FLOOR * RETREAT : 1.2;
        let fitted = false;
        if (minPush && block - 0.42 < minDist - FIT_TOL) {
          const p = this._fitPlace(look, _dir, bn, minDist);
          if (p) { pos.copy(p); use = NaN; fitted = true; }   // NaN = 已经放好，跳过下面的统一摆放
        }
        if (!fitted && minPush) {
          // 需要从 d 收到「墙前 0.42」的量；下限是 floor
          const want = Math.max(0, d - Math.max(floor, block - 0.42));
          if (snap) this._shrink = want;
          else {
            const rate = sRate(want > this._shrink ? BLK_SHRINK : BLK_EXPAND);
            this._shrink += (want - this._shrink) * (1 - Math.exp(-rate * dt));
          }
          use = Math.max(floor, d - this._shrink);
        }
        // 第二次调用（minPush=false）不再自行收缩：`_shrink` 已由第一次调用按低通推进、
        // `_corr` 又把那份修正量滤了一遍。若在这里再按 `block - 0.42` 硬收一次，
        // 既会把低通架空（正是段内大跳的来源），又会在同一帧按已经缩小的 d 二次相减。
        // 它只负责下面 ② 的地面 / 天花板 / 水面钳制。
      } else if (minPush) {
        // 视线通畅：把收缩预算慢慢还回去（放得慢），机位回到解析距离；全程不贴脸
        if (snap) this._shrink = 0;
        else this._shrink += (0 - this._shrink) * (1 - Math.exp(-sRate(BLK_EXPAND) * dt));
        use = Math.max(minDist, d - this._shrink);
      }
    }
    if (!isNaN(use) && Math.abs(use - d) > 0.001) pos.copy(look).addScaledVector(_dir, use);
    // ② 地面钳制：别钻进地板
    let groundD = Infinity;
    castHit(world, pos.x, pos.y, pos.z, pos.x, pos.y - 30, pos.z, this.ctx.playerBody, (dd) => { groundD = dd; });
    if (groundD < 0.45) pos.y += (0.45 - groundD);
    // 天花板钳制：别顶进天花板
    let ceilD = Infinity;
    castHit(world, pos.x, pos.y, pos.z, pos.x, pos.y + 8, pos.z, this.ctx.playerBody, (dd) => { ceilD = dd; });
    if (ceilD < 0.4) pos.y -= (0.4 - ceilD);
    // ★ 水面规避（回放动态运镜）：玩家头还在水面上时，镜头一律抬出液面。
    //   放在钳制之后执行 —— 穿刺天花板也好过让镜头泡进水里糊成一片。
    const top = liquidTopAt(this.ctx.builder, pos.x, pos.z, pos.y);
    if (top > -Infinity) {
      if (!wetPlayer) pos.y = top + 0.6;                  // 出水 0.6：贴着水面但绝不在水下
      else if (top - pos.y > 2.6) pos.y = top - 2.6;      // 在水里也别沉太深，否则什么都看不见
    }
  }

  /**
   * 空间挤不开时的候选机位阶梯（固定顺序 = 确定性）：
   *   ① 沿命中面法线的水平分量把机位推到 minDist 处；
   *   ② 不通则沿切向 ±0.6 / ±1.2 沿墙滑移（贴墙横挪，画框照样看得见主体）；
   *   ③ 仍不通则抬到「天花板下 0.7」再验证。
   * 每个候选都要通过「焦点 → 候选」的视线射线验证（主体必须看得见）。
   * 全部失败返回 null，调用方退回「墙前 0.42、硬底线 HARD_FLOOR」并由 FOV 补偿救画框。
   */
  _fitPlace(look, dir, bn, minDist) {
    const world = this.ctx.world, pb = this.ctx.playerBody;
    if (!world || !bn) return null;
    const clear = (p) => {
      const dx = p.x - look.x, dy = p.y - look.y, dz = p.z - look.z;
      const L = Math.hypot(dx, dy, dz);
      return L > 0.1 && rayFree(world, look.x, look.y, look.z, dx, dy, dz, pb, L + 0.5) >= L - 0.35;
    };
    let nx = bn.x, nz = bn.z;
    const nl = Math.hypot(nx, nz);
    if (nl < 0.2) { nx = dir.x; nz = dir.z; }
    const l2 = Math.hypot(nx, nz) || 1;
    nx /= l2; nz /= l2;
    _fitP.set(look.x + nx * minDist, look.y, look.z + nz * minDist);
    if (clear(_fitP)) return _fitP;
    const tx = -nz, tz = nx;
    for (const o of [0.6, -0.6, 1.2, -1.2]) {
      _fitP.set(look.x + nx * minDist + tx * o, look.y, look.z + nz * minDist + tz * o);
      if (clear(_fitP)) return _fitP;
    }
    const cf = ceilFreeAt(world, look.x, look.y + 0.5, look.z, pb);
    _fitP.set(look.x + nx * minDist, look.y + Math.max(1.0, cf - 0.7), look.z + nz * minDist);
    if (clear(_fitP)) return _fitP;
    return null;
  }
}

const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
const _tmpE = new THREE.Vector3();
const _tmpF = new THREE.Vector3();
const _tmpG = new THREE.Vector3();                  // 轨迹切向
const _tmpH = new THREE.Vector3();                  // 轨迹右向
const _tmpD = new THREE.Vector3();                  // 静态分析用的轨迹切向（travelAt 输出）
const _camDirT = new THREE.Vector3();               // 机位方向（`_camRay` 输出，水平单位向量）
const _fitP = new THREE.Vector3();                  // 候选机位（「不贴脸」阶梯用）
const _rawPos = new THREE.Vector3();                // 安全摆放前的理想机位（曲线滤波用）
const _corr = new THREE.Vector3();                  // 本帧的碰撞修正量
const _corr2 = new THREE.Vector3();                 // 修正量的「本帧增量」（夹了单帧上限之后再加回去）
const _viewNow = new THREE.Vector3();               // 目标视线方向（视线限速用）
const _viewTo = new THREE.Vector3();                // 限速后落在的视线方向
const _viewAxis = new THREE.Vector3();               // 视线限速的旋转轴（新旧视线的叉积）
const _viewQ = new THREE.Quaternion();
const _smTmp = new THREE.Vector3();                  // 最终级平滑的临时向量
const _fwdV = new THREE.Vector3();                   // 相机视线方向（垂直度判定用）
const _upV = new THREE.Vector3();                    // 参考「上方向」（近垂直段沿用上一帧的 roll）
const _lookM = new THREE.Matrix4();                  // 构造相机朝向的旋转矩阵（万向锁安全）
const _sample = {};                 // 逐帧取样的复用对象（避免每帧新建）
const _sLead = {};                  // 「主体前瞻点」的取样复用对象（低通的目标）
const _sA = {}, _sB = {};           // 轨迹前后取样点（_travelDir / travelAt 用）
/* ---------- 运动预分析（_bakeMotion）的复用对象 ---------- */
const _bkS = {}, _bkL = {};         // 当前点 / 前瞻点的取样对象
const _bkD = new THREE.Vector3();   // travelAt 输出的原始切向
const _bkF = new THREE.Vector3();   // 角色朝向（切向兜底用）
/* ---------- 转场（_linkClips / _nominalPose / _flyWin / _flyAt） ---------- */
const _nkPA = new THREE.Vector3(), _nkLA = new THREE.Vector3();   // A 镜末端标称机位 / 视点
const _nkPB = new THREE.Vector3(), _nkLB = new THREE.Vector3();   // B 镜首端标称机位 / 视点
const _nkC = new THREE.Vector3(), _nkCL = new THREE.Vector3();    // 飞渡路径控制点（机位 / 视点）
const _flyP = new THREE.Vector3(), _flyL = new THREE.Vector3();   // 飞渡当前机位 / 视点
const _nkPts = [];                  // 飞渡路径的 7 个采样点（_pathClear 用）
for (let i = 0; i < 7; i++) _nkPts.push(new THREE.Vector3());
const _nkState = {};                // _takeState 的复用对象
const _nkS = {};                    // _nominalPose 的取样复用对象
const _nkS2 = {};                   // 切点处主体位置的取样复用对象（黑白场遮挡判定用）
const _flyTwo = [null, null];       // _fadeUpdate 的复用数组（避免每帧新建）
const _flyHit = { L: null, x: 0 };  // _flyWin 的命中结果（同上：热路径不新建对象）

/* ============================================================
   POV（第一人称）：从「身体数据」重建玩家自己的视角
   ------------------------------------------------------------
   记录里虽然存了当时的相机位姿（cx/cy/cz + ky/kp），但那是**第三人称**相机的
   位姿 —— 拿来当 POV 得到的是越肩镜头，不是玩家眼睛看到的东西。所以 POV 不复现相机，
   而是用身体数据重建：
     · 机位 = 玩家**头部**位置（游戏内每帧维护的 `headPos`，录制时逐帧存成 hx/hy/hz）；
     · 朝向 = 身体朝向（`fy`，即 `player.yaw`），**不**用当时的相机朝向
       —— 视角转过之后相机朝向会和身体差出几十度，那才是「POV 是错的」的主因；
     · 前瞻：看向「AHEAD 秒之后头所在的位置」而不是当下 —— 前方是上坡就自动抬头、
       是下落就自动低头。这就是「提前预知方位」，视线因此总是先一步铺在要走的路线上。

   水平朝向与俯仰都由 `povAim` 解出，其中**俯仰单独过一条智能平滑**（见 `povSmoothPitch`）：
   俯仰是 POV 里唯一会自己动的角度，也是晕 3D 的主要来源，所以它有自己的滤波器，
   不并入下面那串通用稳定层。

   机位 / 水平朝向是纯函数（只依赖 data 与 t），所以 plan 期的 `_nominalPose` 与运行期
   逐帧调用得到的姿态一致，转场接得上；俯仰平滑是唯一的有状态部分，plan 期传 `null`
   状态对象走旁路（并借出 / 还回状态，不污染运行期），因此也不破坏这份一致性。
   ============================================================ */
const _povS = {}, _povS2 = {};                          // 当下 / 前瞻的取样复用对象
const _povV = new THREE.Vector3(), _povL = new THREE.Vector3();   // povAim 的输出（供 PovPlayer 用）

/**
 * POV 俯仰的智能平滑（有状态；状态就是 `{ v }`，`v === null` 表示还没有值 → 吸附）。
 * 三个部件与调法见文件上方 `POV_PITCH_*` 常量处的说明。
 * @param st     状态对象（就地更新）；传 null = 不做平滑（plan 期的确定性标称姿态）
 * @param target 本帧解出来的原始俯仰（弧度）
 * @param dt     帧间隔（秒，真实时间：两种回放模式下都是它，视觉抖动本来就按真实时间读）
 * @param snap   切镜 / 拖进度条 / 首帧：直接吸附，不走低通
 */
function povSmoothPitch(st, target, dt, snap) {
  if (!st) return target;
  if (snap || st.v === null || !(dt > 0)) { st.v = target; return target; }
  const d = target - st.v;
  if (Math.abs(d) < POV_PITCH_DEAD) return st.v;      // 死区内完全不跟，插值噪声到此为止
  // 变化量自适应速率：小偏差 → 慢（沉住噪声），大偏差 → 快（真坡度不拖后腿）
  const k = smoothstep(clamp((Math.abs(d) - POV_PITCH_DEAD) / POV_PITCH_EASE, 0, 1));
  st.v += d * (1 - Math.exp(-(POV_PITCH_HZ_SLOW + (POV_PITCH_HZ_FAST - POV_PITCH_HZ_SLOW) * k) * dt));
  return st.v;
}

/**
 * 解算某时刻玩家自己的第一人称姿态。
 * @param data ReplayData
 * @param t    播放时间（秒，与记录同轴）
 * @param outPos  输出：机位（头部）
 * @param outLook 输出：视点（机位沿视线前伸 POV_AIM_DIST）
 * @param st      俯仰平滑状态（见 `povSmoothPitch`）；null = 不平滑
 * @param dt      帧间隔（秒，配合 `st`）
 * @param snap    是否吸附（配合 `st`）
 */
function povAim(data, t, outPos, outLook, st, dt, snap) {
  const tc = clamp(t, 0, data.duration);
  const s = data.sampleAt(tc, _povS);
  outPos.set(s.hx, s.hy, s.hz);

  // 水平朝向：身体朝向与前瞻方向（AHEAD 处）按 POV_LEAN 折中。
  // `fy` 的 forward 约定是 (sin, 0, cos)（见 replay-player 的速度还原），atan2(dx, dz) 同约定。
  // 前瞻点跑到几十 studs 外 = 中间发生了一次传送 / 重生：不许提前看向复活点
  //（否则镜头会在传送前几帧就开始「看见未来」），此时退回身体朝向。
  let f = data.sampleAt(clamp(tc + POV_AHEAD, 0, data.duration), _povS2);
  const mdx = f.hx - s.hx, mdz = f.hz - s.hz;
  const mhd = Math.hypot(mdx, mdz);
  let yaw = s.fy;
  if (mhd > 0.05 && mhd <= POV_HOP_MAX) yaw = s.fy - angDiff(s.fy, Math.atan2(mdx, mdz)) * POV_LEAN;

  // 俯仰：前瞻三点平均（见 POV_AHEAD_SPREAD 处的说明 —— 恒定坡度上零滞后）。
  // 每个点各自乘可靠性权重：前瞻位移极小（站着不动 / 极慢走）时方向全是插值噪声，
  // 一律压回平视，噪声因此永远进不了画面。
  let sum = 0, cnt = 0;
  for (let k = -1; k <= 1; k++) {
    f = data.sampleAt(clamp(tc + POV_AHEAD + k * POV_AHEAD_SPREAD, 0, data.duration), _povS2);
    const dx = f.hx - s.hx, dy = f.hy - s.hy, dz = f.hz - s.hz;
    const dh = Math.hypot(dx, dz);
    if (dh > POV_HOP_MAX) continue;                 // 这个点跨了一次传送：整点丢掉
    sum += clamp(Math.atan2(dy, Math.max(dh, 1e-4)), -POV_PITCH_LIM, POV_PITCH_LIM)
      * smoothstep(clamp(Math.hypot(dh, dy) / POV_AIM_MIN_D, 0, 1));
    cnt++;
  }
  const pitch = povSmoothPitch(st, cnt ? sum / cnt : 0, dt, snap);
  // 朝向约定与 `_travelDir` 一致：(sin yaw·cos pitch, sin pitch, cos yaw·cos pitch)
  const cp = Math.cos(pitch);
  outLook.set(
    outPos.x + Math.sin(yaw) * cp * POV_AIM_DIST,
    outPos.y + Math.sin(pitch) * POV_AIM_DIST,
    outPos.z + Math.cos(yaw) * cp * POV_AIM_DIST);
}

/* ============================================================
   POV 播放器（回放的「第一人称」模式）：整局都用玩家自己的眼睛看
   ------------------------------------------------------------
   与「直录回放」的分工：直录模式直接复现记录里的相机位姿（cx/cy/cz + ky/kp），
   那是玩家当时真正在操作的那台相机（通常是第三人称）；本类不碰那几列，
   一律用上面 `povAim` 从身体数据重建视角。
   ============================================================ */
export class PovPlayer {
  /** @param fov 复现时该用的视场角（= 当前设置里的相机 fov，录制时就是这个值） */
  constructor(data, fov = 78) {
    this.data = data;
    this.duration = data.duration;
    this.fov = clamp(Number(fov) || 78, FOV_MIN, FOV_MAX);
    this._pitch = { v: null };     // 俯仰智能平滑的状态（与电影模式的那份互相独立）
    this._srcT = -Infinity;        // 上一帧的播放时间（判断是否拖过进度条 / 刚进来）
  }
  update(srcT, camera, dt = 1 / 60) {
    // 首帧 / 拖进度条 / 切模式回来：时间轴上跳了，直接吸附（平滑只该稳连续运动）
    const snap = !(Math.abs(srcT - this._srcT) <= 0.2);
    this._srcT = srcT;
    povAim(this.data, srcT, _povV, _povL, this._pitch, dt, snap);
    camera.up.set(0, 1, 0);
    camera.position.copy(_povV);
    // 用 lookAt 而非欧拉角：朝向是「机位 + 视点」算出来的，且俯仰已被夹在 ±54°，
    // 远离 ±90° 的万向锁奇异点（原来的 YXZ 欧拉角是记录值直接回放，才需要额外夹紧兜底）。
    _lookM.lookAt(_povV, _povL, UP);
    camera.quaternion.setFromRotationMatrix(_lookM);
    if (Math.abs(camera.fov - this.fov) > 0.05) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }
}

export { angDiff as cameraAngleDiff };