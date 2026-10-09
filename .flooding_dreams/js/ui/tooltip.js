/* ============================================================
   全局悬浮提示 + 使用手册
   - 所有提示文案统一来自下方 TIPS 大引用表
   - 悬停（约 0.45s）自动弹出；同时接管全app现有 title 属性
     （首次悬停时把原生 title 收编为自定义气泡，不再弹系统提示）
   - openManual() 打开「使用手册」：全部内容来自同一张引用表，
     支持分类浏览与搜索
   ============================================================ */

/* ---------- 分类 ---------- */
export const CATS = [
  { v: 'intro',   l: '总览' },
  { v: 'basics',  l: '基础概念' },
  { v: 'menu',    l: '主菜单 / 大厅' },
  { v: 'game',    l: '游玩 / HUD' },
  { v: 'ed-top',  l: '编辑器 · 顶栏' },
  { v: 'ed-tool', l: '编辑器 · 工具与模式' },
  { v: 'ed-pane', l: '编辑器 · 面板' },
  { v: 'obj',     l: '对象类型' },
  { v: 'prop',    l: '对象属性' },
  { v: 'liquid',  l: '液体 / 洪水' },
  { v: 'sky',     l: '天空工坊 / 天空修饰器' },
  { v: 'tex',     l: '贴图 / 素材' },
  { v: 'event',   l: '事件 / 动画 / NPC' },
];

/* ---------- 大引用表 ----------
   每条：k 唯一键 · cat 分类 · n 名称 · t 悬浮短提示 · d 手册长说明（可省略）
   prop:true 的条目按名称 n 匹配属性面板的属性行                        */
export const TIPS = [
  /* ═══ 总览 ═══ */
  { k: 'intro.app', cat: 'intro', n: 'Flooding Dreams · 洪梦',
    t: '在梦里，水一直在涨。洪水逃生跑酷游戏 + 关卡编辑器。',
    d: 'Flooding Dreams 是一款纯前端、无需联网的洪水逃生跑酷游戏：水位不断上涨，你要在梦中场景里爬升、下潜、绕行，赶在被淹没之前到达终点。内置关卡编辑器，可以做属于自己的洪水逃生关卡，并用「模拟退火」等程序化工具自动生成路线。' },
  { k: 'intro.play', cat: 'intro', n: '怎么玩',
    t: 'WASD 移动 · 鼠标视角 · 空格跳跃 · 水里注意氧气。',
    d: '基本操作：WASD 移动，鼠标控制视角，空格跳跃 / 上浮，Shift 加速。进入水中后开始消耗氧气，氧气耗尽会开始扣血。水位随时间上涨，淹到头部同样危险。目标是摸到终点（终点门 / 终点光柱）。' },
  { k: 'intro.editor', cat: 'intro', n: '关卡编辑器',
    t: '搭方块、放机关、调水位，做你自己的洪水关卡。',
    d: '编辑器分四块：顶栏（创建对象 / 工具 / 测试保存）、左侧属性面板（选中对象的全部属性）、右侧对象树与素材库、底部事件 / 动画 / 关卡包 / 输出面板。改完点「▶ 试玩」当场验证，满意后「保存」进存档。' },
  { k: 'intro.manual', cat: 'intro', n: '使用手册（本窗口）',
    t: '所有按钮和属性的悬浮提示都出自同一张引用表，这里列出全部内容。',
    d: '使用手册的内容与鼠标悬浮提示完全同源：都来自同一张大引用表。悬停在编辑器里任何按钮 / 属性 / 对象上约半秒即可看到短提示；想系统了解就在这里按分类浏览或直接搜索。' },

  /* ═══ 基础概念（术语解释） ═══ */
  { k: 'b.save', cat: 'basics', n: '存档 / 我的关卡',
    t: '你自建关卡存放的地方，本质是一个文件夹。',
    d: '「存档」是编辑器的基本单位：一个存档 = 一个关卡文件夹，里面除了关卡数据（对象、事件、动画），还包含它用到的全部素材副本。这样整份存档可以单独拷走 / 分享，不依赖外部文件。' },
  { k: 'b.asset', cat: 'basics', n: '素材（Asset）',
    t: '关卡里用到的图片 / 音频 / 模型文件。',
    d: '素材指所有外部资源：贴图图片、全景图、音频、3D 模型。导入素材时会自动拷贝一份到存档文件夹（本地化），之后关卡引用的都是这份本地副本；替换素材时用新文件覆盖旧的。' },
  { k: 'b.localize', cat: 'basics', n: '本地化（素材）',
    t: '导入时把文件拷贝进存档文件夹，此后只引用本地副本。',
    d: '本地化保证存档自包含：换电脑、分享存档、离线运行都不会因为原路径丢失而丢贴图。所有素材导入都必须走统一入口，确保它们自动登记进素材管理器。' },
  { k: 'b.object', cat: 'basics', n: '对象（Object）',
    t: '关卡里的每一个实体：方块、液体、触发器等。',
    d: '编辑器里的一切都是对象：几何体（方块 / 球 / 模型）、逻辑体（触发器 / 伤害区）、机关（门 / 按钮）、特效（粒子 / 体积雾 / 后处理）等。每个对象有类型、名称、唯一 ID 和一整组属性。' },
  { k: 'b.type', cat: 'basics', n: '对象类型',
    t: '决定这个对象是什么、有哪些属性和行为。',
    d: '类型决定对象的默认属性表与运行时行为。切换类型会换成另一套属性定义；共用属性（名称 / 位置 / 旋转 / 颜色…）在所有类型间通用。' },
  { k: 'b.id', cat: 'basics', n: '对象 ID',
    t: '对象的唯一编号，事件 / 动画 / 引用都靠它关联。',
    d: '每个对象有一个唯一 ID（自动生成）。事件里「指定对象」、动画的「目标」、引用类属性都存的是 ID；因此重命名对象不会断开引用，但删除对象会让引用悬空。' },
  { k: 'b.selection', cat: 'basics', n: '选中 / 多选',
    t: '点选对象进行编辑；可框选或按住加选多个。',
    d: '在视口点击选中对象，对象树里也可点选。多选后可批量改同名属性（取值不一致的项显示为「（混合）」），编组、删除也支持多选。' },
  { k: 'b.gizmo', cat: 'basics', n: '操纵器（Gizmo）',
    t: '对象上出现的彩色箭头 / 圆环 / 方块手柄，用来移动旋转缩放。',
    d: '选中对象后出现的三色手柄：红 X、绿 Y、蓝 Z。拖动箭头平移、拖动圆环旋转、拖动方块缩放。配合坐标系（世界 / 局部）与轴向吸附使用。' },
  { k: 'b.space', cat: 'basics', n: '世界坐标 vs 局部坐标',
    t: '世界 = 永远对齐 XYZ 轴；局部 = 跟随对象自身朝向。',
    d: '世界坐标系下手柄永远指向场景的 XYZ 正方向；局部坐标系下，手柄随对象旋转一起转，给已经转过的物体再调整更直观。空格键切换。' },
  { k: 'b.group', cat: 'basics', n: '编组（层级）',
    t: '把多个对象收进一个父节点，整体变换。',
    d: '编组后子对象的位置 / 旋转 / 缩放相对父级计算：移动父级，全体一起动。对象树里可拖动调整父子关系，也可随时「移出编组」。' },
  { k: 'b.parent', cat: 'basics', n: '父级 / 子级',
    t: '子对象跟随父对象变换；对象树里的层级关系。',
    d: '层级（父子）关系让复杂结构易于整体操作：父级移动，子级跟随。编组、挂点、网格引用都依赖层级或引用关系。' },
  { k: 'b.anchor', cat: 'basics', n: '锚定（Anchored）',
    t: '锚定的物体固定不动；未锚定的会掉落或被水冲走。',
    d: '锚定是一道物理门槛：勾选锚定的对象在游戏里固定不动、不参与落体；未锚定的对象会受重力 / 水流推动。做平台请锚定，做可被冲走的杂物则不要。' },
  { k: 'b.aabb', cat: 'basics', n: '碰撞体 / 碰撞盒',
    t: '对象用于物理阻挡的形状；低模体按三角网精确碰撞。',
    d: '碰撞体决定玩家能否站上去、是否被挡住。方块类是盒 / 球 / 柱等解析形状；低模建模体（trimesh）用实际三角网做精确碰撞，改建模数据会重建碰撞体。' },
  { k: 'b.pbr', cat: 'basics', n: 'PBR（物理渲染）',
    t: '基于物理的材质渲染：颜色 / 金属度 / 粗糙度 / 法线 / 粗糙度贴图。',
    d: 'PBR 用一套基于物理的参数描述表面：基础色、金属度（是金属还是绝缘体）、粗糙度（高光锐利或涣散）、法线贴图（凹凸细节）。相比直接贴图更真实、光照更一致。' },
  { k: 'b.albedo', cat: 'basics', n: '基础色 / 漫反射贴图',
    t: '物体表面的颜色贴图，PBR 里的「底贴图」。',
    d: '底贴图（albedo / color）决定表面固有颜色。法线、粗糙度等其它贴图会继承它的 repeat / offset / wrap 与朝向设置，保证多层贴图对齐。' },
  { k: 'b.normalmap', cat: 'basics', n: '法线贴图',
    t: '用像素颜色编码表面朝向，制造凹凸细节而不加面数。',
    d: '法线贴图把「表面往哪个方向倾斜」编码进 RGB，光照时逐像素计算，于是平面看起来有凹凸。按线性色彩空间采样（不是颜色，不要 sRGB 转换）。' },
  { k: 'b.roughmap', cat: 'basics', n: '粗糙度贴图',
    t: '像素亮度决定该处多粗糙：越亮越粗糙。',
    d: '粗糙度贴图逐像素控制高光的涣散程度，比整体一个粗糙度值更细腻（如：地面瓷砖光滑、缝隙粗糙）。同样按线性空间采样。' },
  { k: 'b.colorspace', cat: 'basics', n: '色彩空间（sRGB / 线性）',
    t: '颜色贴图用 sRGB，数据贴图（法线 / 粗糙度）用线性。',
    d: '人眼对暗部更敏感，所以颜色贴图通常存为 sRGB（非线性）以省带宽；而法线、粗糙度这类「数据贴图」必须按线性采样，否则数值会被错误地映射导致效果走样。' },
  { k: 'b.uv', cat: 'basics', n: 'UV / 贴图坐标',
    t: '决定贴图怎么铺到物体表面：重复次数、偏移、朝向。',
    d: 'UV 是贴在表面上的二维坐标。repeat = 横向 / 纵向重复几次；offset = 平移起点；wrapS / wrapT = 超出 0~1 范围时是循环重复还是拉伸最后一列像素。' },
  { k: 'b.repeat', cat: 'basics', n: 'repeat（重复次数）',
    t: '贴图沿 UV 方向重复多少遍；越大格子越密。',
    d: 'repeat 越大，同一张贴图在物体表面重复越多遍、单位图案越小。平铺模式下每格的世界尺寸固定，因此同一贴图在所有物体上格子大小一致，不会被拉扁。' },
  { k: 'b.ninepatch', cat: 'basics', n: '九宫格（NinePatch）',
    t: '把贴图切成 3×3，四角与外圈边框固定不变，中间随尺寸拉伸。',
    d: '九宫格把图片外圈（1/3）当作固定边框、中心与边条可拉伸，于是给按钮 / 面板换尺寸时边框粗细与圆角不会变形。适合 UI 感的面板、门框等。' },
  { k: 'b.skybox', cat: 'basics', n: '天空球 / 天空盒',
    t: '包裹整个场景的背景球；可用程序化生成或导入全景图。',
    d: '天空球是一颗包住场景的大球，内壁贴全景图，形成天空与远方环境。可用「天空工坊」程序化生成，也可以导入 .hdr / 全景图，再用「天空修饰器」叠加变形与调色。' },
  { k: 'b.hdr', cat: 'basics', n: 'HDR 全景图',
    t: '高动态范围全景图，可同时作为天空背景与环境照明。',
    d: 'HDR（.hdr/.exr）比普通图片记录了更宽的亮度范围，除了当背景，还能给场景提供真实的环境光照。导入后需先解码进缓存再使用，避免背景空白。' },
  { k: 'b.cubemap', cat: 'basics', n: '立方体贴图 / 环境反射',
    t: '把周围环境烘进一张六面贴图，用于反射；运行时几乎不耗性能。',
    d: '环境反射用的是一次性捕获的场景立方体贴图（Cubemap）：关卡加载时拍一张「周围长什么样」的六面快照，金属 / 玻璃反射时直接采样这张快照。所以运行时开销极低。' },
  { k: 'b.liquid', cat: 'basics', n: '液体 / 水位',
    t: '洪水本体：有液面高度、风格、对氧气与伤害的规则。',
    d: '液体对象代表洪水：它有一个填充值（水位），随时间可用动画 / 事件上涨；有风格（清水 / 熔岩 / 酸…）决定外观与默认伤害；还有氧气消耗、水阻、接触即死等规则。' },
  { k: 'b.oxygen', cat: 'basics', n: '氧气',
    t: '潜入水下的憋气值；耗尽后开始扣血，露头恢复。',
    d: '氧气条在画面底部。处于水下时持续消耗，耗尽后按伤害速率扣血；离开水面（或头部露出）后自动回复。液体对象的氧气模式可自定义影响方式。' },
  { k: 'b.event', cat: 'basics', n: '事件',
    t: '「当满足条件时做什么」的逻辑单元：触发器 → 条件 → 动作。',
    d: '事件是关卡的逻辑骨架：一个触发源（触碰 / 进入区域 / 按下按钮 / 定时…）＋ 一组条件（可选）＋ 一串动作（开门 / 涨水 / 显示提示 / 播放动画…）。对象通过「触碰触发事件」等属性关联事件。' },
  { k: 'b.trigger', cat: 'basics', n: '触发器（Event Trigger）',
    t: '事件的起点：什么情况下触发这套逻辑。',
    d: '触发器是事件被激活的时机，如玩家触碰某对象、进入区域、按下按钮、接收信号、关卡开始等。触发后按顺序执行动作。' },
  { k: 'b.condition', cat: 'basics', n: '条件（Condition）',
    t: '事件执行前的判断：例如已收集数量、开关状态。',
    d: '条件用于给事件加门槛：只有全部条件成立才执行动作。例如「需要先按下 A 按钮」「已拾取 3 个钥匙」才开门。无条件则触发即执行。' },
  { k: 'b.action', cat: 'basics', n: '动作（Action）',
    t: '事件触发后做的事情：开门、涨水、显示提示、给道具……',
    d: '动作是事件的实际效果，一条事件可挂多个动作，按顺序执行。常见动作：开关对象、移动 / 旋转、改变水位、播放动画、播放音效、显示顶部提示、传送玩家、增减计时等。' },
  { k: 'b.anim', cat: 'basics', n: '动画 / 关键帧',
    t: '给对象做位移旋转缩放显隐的动画；可被事件播放或循环。',
    d: '动画由若干关键帧组成：在某个时间点记录对象的位置 / 旋转 / 缩放 / 显隐，中间自动补间。动画可设循环、可反向、可由事件触发播放，常用于升降平台、开启的门、呼吸的机关。' },
  { k: 'b.easing', cat: 'basics', n: '缓动（Easing）',
    t: '动画的速度曲线：匀速 / 缓入缓出 / 回弹等。',
    d: '缓动决定插值的过程快慢：linear 匀速、ease-in 慢起快收、ease-out 快起慢收、back 有回弹。合适的缓动让机械运动显得有重量与惯性。' },
  { k: 'b.checkpoint', cat: 'basics', n: '检查点 / 重生',
    t: '记录玩家经过的位置；死亡后从最近的检查点复活。',
    d: '踩到检查点会记录当前位置与朝向。玩家死亡（溺水 / 掉落 / 接触即死 / 氧气耗尽）后从最近的检查点重生，避免长关反复从头开始。' },
  { k: 'b.rewind', cat: 'basics', n: '回放 / 录制',
    t: '每一局游玩会自动录成一段回放，最长 8 分钟。',
    d: '游玩过程被自动记录成回放，可在「游玩回放」里回看。通关的局会解锁「电影级运镜剪辑」：自动按电影规则给整局排镜头（开场建立镜头 → 递进 → 高潮 → 留白），也可换一版重排。' },
  { k: 'b.simanneal', cat: 'basics', n: '模拟退火',
    t: '一种「先大胆乱试、再逐步收敛」的优化算法，用来演化关卡结构。',
    d: '模拟退火借鉴金属退火：一开始高温、允许接受较差的方案（跳出局部最优），随温度下降越来越挑剔，最终收敛到较优解。这里用来演化关卡的路线与结构，让程序生成的结果既合理又多样。' },
  { k: 'b.worker', cat: 'basics', n: '异步 Worker / 并行计算',
    t: '把重计算放到后台线程池，界面不卡。',
    d: '列表加载、程序化生成等重活交给 Web Worker 线程池并行处理，主线程只负责渲染，因此加载关卡列表或跑生成算法时界面仍然流畅、可交互。' },
  { k: 'b.procgen', cat: 'basics', n: '程序化生成（Procedural）',
    t: '用算法自动铺出关卡路线与结构，而非手工摆放。',
    d: '程序化生成按难度与世界主题自动铺设跑酷路线（爬升、局部下降、空间多样性），并做可通关性自检：确认从起点到终点确实跳得过去。生成后仍可手工微调。' },
  { k: 'b.difficulty', cat: 'basics', n: '难度',
    t: '影响跳跃间距、平台密度、洪水速度等。',
    d: '难度体现在：跳跃间距、平台大小与密度、机关强度、洪水上涨速度、氧气消耗等。编辑器里按难度分档生成，便于同一主题产出多档关卡。' },
  { k: 'b.postfx', cat: 'basics', n: '后处理（Post Effects）',
    t: '叠加在整幅画面上的全屏特效：暗角 / 色差 / 颗粒 / 泛光等。',
    d: '后处理在场景渲染完成后对整张画面再做一遍处理，营造氛围：暗角压暗四周、色差做镜头感、颗粒做胶片感、泛光让亮部溢出。多个后处理对象只生效优先级最高的那个。' },
  { k: 'b.exposure', cat: 'basics', n: '曝光（Exposure）',
    t: '整幅画面的明暗基准；EV +1 大约亮一倍。',
    d: '曝光控制画面整体亮度基准。EV（曝光值）每 +1 相当于亮度翻倍，-1 减半。曝光控制对象可调曝光补偿与画面染色（饱和度 / 染色），是全局画面基调的开关。' },
  { k: 'b.volume', cat: 'basics', n: '体积效果（雾 / 光）',
    t: '在空间中真实占据体积的雾、光束效果。',
    d: '体积雾 / 体积光是「看得见空气」的效果：光线穿过悬浮微粒形成可见光束（丁达尔效应），雾在区域内逐渐遮蔽远景。它们是氛围道具，不参与碰撞。' },
  { k: 'b.portal', cat: 'basics', n: '传送门',
    t: '能透过它看到并走向另一个场景位置的门。',
    d: '传送门是 see-through 的：透过门框能看到目标处的实时画面，走进去会抵达另一端。多层叠加可以做出「无限回廊」等视错觉效果。' },
  { k: 'b.billboard', cat: 'basics', n: '公告板（Billboard）',
    t: '永远正面朝向玩家的图片 / 文字面板。',
    d: '公告板无论玩家怎么走都转向玩家，因此总是正对着你看。常用于招牌、提示、贴图精灵。' },
  { k: 'b.npc', cat: 'basics', n: 'NPC / 对话',
    t: '场景里的角色，可跟随或巡逻，并能进行多段分支对话。',
    d: 'NPC 可设为「跟随玩家」（沿其轨迹保持距离跟上）或「沿路径巡逻」。进入交互半径会出现提示，按键即可开始对话；对话用节点图编辑，支持分支选项与「开始对话」事件。' },
  { k: 'b.material', cat: 'basics', n: '材质',
    t: '决定表面外观的一整套参数（颜色 / 质感 / 贴图）。',
    d: '材质 = 描述「表面长什么样」的参数集合：基础色、金属度、粗糙度、透明度、贴图与特殊表面（玻璃 / 力场 / 全息…）。编辑器用「高级材质」预设一键套用一整套推荐参数后再微调。' },
  { k: 'b.priority', cat: 'basics', n: '优先级',
    t: '同一类全局效果只能生效一个时，优先级高者胜出。',
    d: '有些效果是「全局唯一」的：整关只允许一套生效，比如后处理、曝光控制。这时各自设一个优先级数值，游戏运行时只采用优先级最高的那一个，其余被忽略。' },
  { k: 'b.vertexao', cat: 'basics', n: '顶点 AO / 细分',
    t: '把环境遮蔽烘进顶点颜色（角落更暗）；关闭可省性能。',
    d: '顶点 AO 在不加贴图的前提下，把「角落、缝隙更暗」的遮蔽信息烘到几何顶点上，看起来更有体积感。为提升精度，几何体会先细分；大块体可以关掉以省性能。' },
  { k: 'b.paint', cat: 'basics', n: '涂鸦 / 图层',
    t: '直接在模型表面画颜色或盖贴图；按图层组织、可分别隐藏。',
    d: '涂鸦是用笔刷 / 橡皮 / 材质章直接在模型表面作画，效果存在独立图层里：图层可新建、删除、隐藏，互不干扰。吸色工具用来拾取已有颜色当笔刷色。' },
  { k: 'b.recipe', cat: 'basics', n: '配方（贴图修改器）',
    t: '贴图修改器的图层与参数设置，保存在存档里可反复调。',
    d: '贴图修改器不是一次性操作，而是一套「配方」：记录你用过的图层、扭曲、风格化、调色参数。配方保存在存档里，随时重新打开微调再「烘焙并保存」覆盖旧结果。' },
  { k: 'b.bake', cat: 'basics', n: '烘焙（Bake）',
    t: '把多层实时效果「烤」成一张静态图片，之后直接当贴图用。',
    d: '烘焙 = 把用算法 / 图层实时算出来的画面，一次性渲染成一张普通 PNG 贴图。好处是运行时零开销（不需要每帧重算），代价是改了参数必须重新烘焙。' },
  { k: 'b.seamless', cat: 'basics', n: '无缝（连续映射）',
    t: '贴图左右 / 上下边缘能自然衔接，重复时看不出接缝。',
    d: '无缝贴图指平铺时不出现明显接缝。天空修饰器里的变形采用「连续映射」（坐标首尾相接），因此扭曲、旋转后仍能无缝；色彩处理在线性空间进行，避免接缝处偏色。' },
  { k: 'b.tier', cat: 'basics', n: '档位（Tier）',
    t: '关卡包 / 关卡的难度分档标记。',
    d: '档位是对难度做的粗分类（如入门 / 进阶 / 挑战），用于关卡包内按档位切换与筛选；节点地图上会用徽标显示每个关卡的档位与难度。' },
  { k: 'b.variant', cat: 'basics', n: '变体（Variant）',
    t: '同一关卡的不同版本 / 分支（如不同难度或布局）。',
    d: '变体让一个关卡挂多份可切换的版本，玩家可在大厅或关卡选择处切换；不同变体可能改难度、改布局或改规则，共用同一关卡名与进度。' },
  { k: 'b.pack', cat: 'basics', n: '关卡包',
    t: '把多个关卡打包，配一张节点地图串成流程。',
    d: '关卡包是一组相关关卡的集合，并以「节点地图」展示它们的连接与推进顺序：节点头能拖拽摆位、可设颜色与档位、可标记完成 / 锁定状态。适合做主题战役。' },
  { k: 'b.bone', cat: 'basics', n: '骨骼 / 挂点（Attachment）',
    t: '模型内部可动的关节；挂点把对象挂到骨骼上跟随运动。',
    d: '带骨架的模型由若干骨骼驱动形变。挂点对象可以绑定到某根骨骼上，于是帽子、武器、特效会随骨骼一起动，实现真正的「穿在身上 / 握在手里」。' },
  { k: 'b.morph', cat: 'basics', n: '形变（Morph）',
    t: '把模型从一个形状平滑变到另一个形状。',
    d: 'Morph（变形目标）记录模型顶点的一到多组目标形状，运行时按权重在它们之间插值，实现表情、口型、膨胀 / 收缩等无需骨骼的形变。' },
  { k: 'b.shader', cat: 'basics', n: 'Shader（着色器）',
    t: '跑在显卡上的小程序，决定每个像素怎么上色。',
    d: '着色器是 GPU 上运行的小程序：天空工坊的 71 种纹理 shader、水纹、玻璃折射等都由它实现。编辑器里多数效果是「选好参数」即可，无需直接写代码。' },

  /* ═══ 主菜单 / 大厅 ═══ */
  { k: 'menu.play', cat: 'menu', n: '开始游戏',
    t: '进入云端卧室大厅，等待并进入关卡。' },
  { k: 'menu.replays', cat: 'menu', n: '游玩回放',
    t: '回看你的历史对局；通关的局可剪电影级运镜。' },
  { k: 'menu.skin', cat: 'menu', n: '角色皮肤',
    t: '给 glb/gltf 角色涂画皮肤、挂挂件。' },
  { k: 'menu.editor', cat: 'menu', n: '关卡编辑器',
    t: '制作属于你的洪水逃生关卡。', d: '进入编辑器前会先让你选择一个存档（我的关卡），也可以复制内置关卡来改。' },
  { k: 'menu.settings', cat: 'menu', n: '设置',
    t: '按键绑定 · 鼠标灵敏度 · 画质 · 声音。' },
  { k: 'menu.help', cat: 'menu', n: '操作说明',
    t: '基础玩法与按键速查。' },
  { k: 'menu.levels', cat: 'menu', n: '关卡选择',
    t: '按关卡 / 关卡包两种方式挑选要玩的关卡。' },
  { k: 'menu.hallbar.menu', cat: 'menu', n: '☰ 菜单（大厅）',
    t: '回到开始界面。' },
  { k: 'menu.hallbar.levels', cat: 'menu', n: '◆ 关卡（大厅）',
    t: '打开关卡选择列表。' },
  { k: 'menu.hallbar.settings', cat: 'menu', n: '⚙ 设置（大厅）',
    t: '打开偏好设置。' },
  { k: 'menu.lvsearch', cat: 'menu', n: '搜索关卡名…',
    t: '按名称关键字过滤关卡 / 关卡包列表。' },
  { k: 'menu.saves.new', cat: 'menu', n: '＋ 新建存档',
    t: '创建一个空白关卡存档，然后进编辑器开工。' },
  { k: 'menu.saves.copy', cat: 'menu', n: '复制内置关卡',
    t: '把官方 / 自定义关卡复制一份到「我的关卡」，然后进编辑器改。' },
  { k: 'menu.saves.import', cat: 'menu', n: '导入文件',
    t: '从本地导入 .json / .fdlevel 关卡文件。' },

  /* ═══ 游玩 / HUD ═══ */
  { k: 'game.flood', cat: 'game', n: '洪水上涨',
    t: '水位随时间（或按事件 / 动画）上升，逼你不断向上逃。',
    d: '本作核心机制：水位持续上涨，玩家必须边跑酷边爬升寻找高点。水位由液体对象的填充值驱动，可由事件 / 动画控制涨速，也可做「涨落」「脉冲」等节奏。' },
  { k: 'game.win', cat: 'game', n: '通关判定',
    t: '碰到终点区域即通关；用时与死亡数计入成绩。',
    d: '摸到「终点」对象即判定通关，弹出结算。成绩记录用时与死亡次数，并自动保存本局回放；通关的局会解锁电影级运镜剪辑。' },
  { k: 'game.death', cat: 'game', n: '死亡与重生',
    t: '溺水 / 掉出边界 / 接触即死 / 氧气耗尽都会死亡，从检查点复活。',
    d: '死亡原因包括：氧气耗尽后持续扣血、掉出场景、碰到「接触即死」的液体或伤害区。死亡后从最近的检查点（或出生点）重生，并累计死亡次数。' },
  { k: 'game.hall', cat: 'game', n: '大厅（云端卧室）',
    t: '进入关卡前的等待场景；可开关卡 / 设置。',
    d: '「开始游戏」后先进入云端卧室大厅，这里是一个 3D 等待场景，底部有菜单 / 关卡 / 设置按钮。选好关卡后载入并正式开局。' },
  { k: 'game.oxygen', cat: 'game', n: '氧气条',
    t: '水下憋气计量：耗尽后开始扣血，露出水面自动恢复。' },
  { k: 'game.timer', cat: 'game', n: '计时器',
    t: '本局用时；通关成绩按此记录。' },
  { k: 'game.deaths', cat: 'game', n: '☠ 死亡计数',
    t: '本局死亡次数。' },
  { k: 'game.toolbar', cat: 'game', n: '工具栏',
    t: '拾取到的工具出现在这里，数字键或点击切换。' },
  { k: 'game.tui', cat: 'game', n: '触屏控件',
    t: '触屏设备专属：摇杆移动 + 跳跃 / 下潜 / 使用 / 视角按钮。' },
  { k: 'game.testpts', cat: 'game', n: '测试位点',
    t: '编辑器试玩专用：E 记录站位，R 传送到选中位点。' },
  { k: 'game.pause', cat: 'game', n: '暂停菜单',
    t: '继续 / 重开本关 / 看回放 / 调设置 / 返回大厅。' },
  { k: 'game.result', cat: 'game', n: '结算界面',
    t: '显示通关与否、用时、死亡数；可再来一次或看回放。' },
  { k: 'game.rpbar', cat: 'game', n: '回放播放条',
    t: '播放 / 暂停、逐镜跳转、切换直录回放 / 第一人称 / 电影运镜。' },

  /* ═══ 编辑器 · 顶栏 ═══ */
  { k: 'ed.undo', cat: 'ed-top', n: '↶ 撤销（Ctrl+Z）',
    t: '撤销上一步编辑操作。' },
  { k: 'ed.redo', cat: 'ed-top', n: '↷ 重做（Ctrl+Y）',
    t: '恢复被撤销的操作。' },
  { k: 'ed.levelinfo', cat: 'ed-top', n: '关卡信息',
    t: '查看关卡统计：对象数、面数、水位设置等。' },
  { k: 'ed.testhere', cat: 'ed-top', n: '⚑ 在此处测试',
    t: '以选中对象所在位置为出生点开始试玩，调试中段方便。' },
  { k: 'ed.test', cat: 'ed-top', n: '▶ 试玩',
    t: '从出生点完整试玩当前关卡。' },
  { k: 'ed.save', cat: 'ed-top', n: '保存',
    t: '把当前关卡写进存档（浏览器本地 / 本地存档接口）。' },
  { k: 'ed.exit', cat: 'ed-top', n: '✕ 退出编辑器',
    t: '退出到存档列表；记得先保存。' },
  { k: 'ed.resetprop', cat: 'ed-top', n: '⟲ 重置属性',
    t: '把当前选中对象的属性恢复为该类型的默认值。' },
  { k: 'ed.layeradd', cat: 'ed-top', n: '＋ 新建涂鸦图层',
    t: '新建一个涂鸦图层，图层间相互独立可分别显示隐藏。' },
  { k: 'ed.layerdel', cat: 'ed-top', n: '🗑 删除图层',
    t: '删除当前选中的涂鸦图层及其内容。' },
  { k: 'ed.group', cat: 'ed-top', n: '⧉ 编组',
    t: '把选中的多个对象编成一组，整体移动 / 旋转。' },
  { k: 'ed.unparent', cat: 'ed-top', n: '↰ 移出编组',
    t: '把选中对象从所属编组里移出。' },
  { k: 'ed.del', cat: 'ed-top', n: '🗑 删除对象',
    t: '删除选中对象（可 Ctrl+Z 撤销）。' },
  { k: 'ed.importtex', cat: 'ed-top', n: '＋图 导入图片素材',
    t: '导入图片（贴图 / 全景图），自动进入素材库并本地化到存档。' },
  { k: 'ed.importaudio', cat: 'ed-top', n: '＋音 导入音频素材',
    t: '导入 mp3 / ogg / wav / m4a 音频素材。' },
  { k: 'ed.importmodel', cat: 'ed-top', n: '＋模 导入模型',
    t: '导入 .glb / .gltf / .obj 模型文件。' },
  { k: 'ed.texmod', cat: 'ed-top', n: '🎛 贴图修改器',
    t: '以贴图素材为源，多层叠加 / 扭曲失真 / 风格化 / 调色，烘成新贴图。' },
  { k: 'ed.assetrefresh', cat: 'ed-top', n: '⟲ 刷新素材库',
    t: '重新扫描并列出存档内的全部素材。' },
  { k: 'ed.manual', cat: 'ed-top', n: '📖 使用手册',
    t: '打开全量帮助：所有按钮 / 属性 / 对象的说明都来自同一张引用表。' },

  /* ═══ 编辑器 · 工具与模式 ═══ */
  { k: 'tool.select', cat: 'ed-tool', n: '选择 / 移动（1）',
    t: '点选对象并拖动移动；配合轴向吸附更精确。' },
  { k: 'tool.rotate', cat: 'ed-tool', n: '旋转（2）',
    t: '拖动旋转环旋转选中对象。' },
  { k: 'tool.scale', cat: 'ed-tool', n: '缩放（3）',
    t: '拖动手柄缩放选中对象。' },
  { k: 'tool.space', cat: 'ed-tool', n: '坐标系切换（空格）',
    t: '世界坐标 = 永远对齐 XYZ 轴；局部坐标 = 跟随对象自身朝向。' },
  { k: 'tool.snap', cat: 'ed-tool', n: '轴向吸附（X）',
    t: '开关轴 / 面吸附，让方块严丝合缝地拼接。' },
  { k: 'tool.jump', cat: 'ed-tool', n: '跳跃（抛物线）验证器（J）',
    t: '摆放起跳点与落点，验证这段跳跃能否跳过去（含洪水修正）。' },
  { k: 'tool.timing', cat: 'ed-tool', n: '跑酷计时测量器（T）',
    t: '测量两点间跑酷所需时间，评估节奏与难度。' },
  { k: 'tool.gen', cat: 'ed-tool', n: '程序化生成关卡',
    t: '按难度与世界结构自动铺设跑酷路线，并做可通关性自检。' },
  { k: 'tool.skylab', cat: 'ed-tool', n: '天空工坊',
    t: '程序化天空球生成 / 烘焙（云 / 星空 / 大气 / 日月 / 71 种纹理 shader），可导出全景图。' },
  { k: 'tool.skymod', cat: 'ed-tool', n: '天空修饰器',
    t: '给天空球叠加几何变形 / 色彩曝光修饰器，实时预览。' },
  { k: 'tool.npc', cat: 'ed-tool', n: 'NPC 编辑器',
    t: '独立悬浮窗：管理角色模型 / 跟随巡逻 / 交互 / 多段对话。' },
  { k: 'tool.sticker', cat: 'ed-tool', n: '贴纸放置（P）',
    t: '把图片贴到模型表面，覆盖该区域的粗糙度 / 法线，保留底层贴图。' },
  { k: 'tool.freefly', cat: 'ed-tool', n: '视口飞行',
    t: '中键拖动旋转视角 · WASD 飞行 · Q/E 升降 · Shift 加速。' },
  { k: 'tool.paint.brush', cat: 'ed-tool', n: '涂鸦笔刷',
    t: '在模型表面直接画颜色。' },
  { k: 'tool.paint.eraser', cat: 'ed-tool', n: '涂鸦橡皮',
    t: '擦除画上去的颜色。' },
  { k: 'tool.paint.stamp', cat: 'ed-tool', n: '材质章',
    t: '把整张贴图「盖」到模型表面。' },
  { k: 'tool.paint.picker', cat: 'ed-tool', n: '吸色',
    t: '从模型表面取色作为当前笔刷颜色。' },

  /* ═══ 编辑器 · 面板 ═══ */
  { k: 'pane.props', cat: 'ed-pane', n: '属性面板',
    t: '显示选中对象（或关卡本身）的全部属性，按分组折叠。' },
  { k: 'pane.layers', cat: 'ed-pane', n: '涂鸦图层',
    t: '管理涂鸦图层：新建 / 删除 / 切换目标图层。' },
  { k: 'pane.outliner', cat: 'ed-pane', n: '对象树',
    t: '按层级列出全部对象，可点选、编组、删除、拖动排序。' },
  { k: 'pane.assets', cat: 'ed-pane', n: '素材库',
    t: '存档内全部图片 / 音频 / 模型素材；导入的素材会拷贝进存档文件夹本地化。' },
  { k: 'pane.events', cat: 'ed-pane', n: '事件编辑器',
    t: '以「触发器 → 条件 → 动作」的方式给对象编写事件逻辑。' },
  { k: 'pane.anim', cat: 'ed-pane', n: '动画编辑器',
    t: '给对象制作关键帧动画（移动 / 旋转 / 缩放 / 显隐）。' },
  { k: 'pane.packs', cat: 'ed-pane', n: '关卡包',
    t: '把多个关卡打包成带节点地图的关卡包。' },
  { k: 'pane.console', cat: 'ed-pane', n: '输出面板',
    t: '编辑器日志 / 程序化生成的自检报告都在这里看。' },

  /* ═══ 对象类型 ═══ */
  { k: 'obj.block', cat: 'obj', n: '立方体',
    t: '最基础的搭块：地形、平台、墙壁都靠它。' },
  { k: 'obj.sphere', cat: 'obj', n: '球',
    t: '球形方块，碰撞为完整球体。' },
  { k: 'obj.prism', cat: 'obj', n: '多边形柱',
    t: '边数可调的正多边形柱体。' },
  { k: 'obj.cylinder', cat: 'obj', n: '圆柱',
    t: '圆柱体方块，适合柱子 / 井筒。' },
  { k: 'obj.wedge', cat: 'obj', n: '楔形',
    t: '三角楔，做斜坡 / 屋顶。' },
  { k: 'obj.cone', cat: 'obj', n: '圆锥',
    t: '圆锥体，做尖顶 / 装饰。' },
  { k: 'obj.torus', cat: 'obj', n: '圆环',
    t: '环形装饰体。' },
  { k: 'obj.model', cat: 'obj', n: '自定义模型',
    t: '引用导入的 glb / gltf / obj 模型素材。' },
  { k: 'obj.mesh', cat: 'obj', n: '低模建模体',
    t: '在建模模式里用点 / 面手搓的低多边形模型；按三角网做精确碰撞。',
    d: '进入「建模模式」用顶点 / 面手工搭建任意低多边形形体，适合做不规则地形、雕塑。碰撞用实际三角网（trimesh），因此贴合精确，但比解析形状略耗性能。' },
  { k: 'obj.poly', cat: 'obj', n: '自定义网格体（poly）',
    t: '以点表 / 面表定义的自定义几何体。',
    d: '与低模建模体同源：几何由「点表」与「面表」定义（每个面是三个顶点下标）。适合用脚本 / 数据生成几何。' },
  { k: 'obj.liquid', cat: 'obj', n: '液体',
    t: '洪水本体：30 种风格（清水 / 熔岩 / 酸…），决定氧气与伤害。',
    d: '液体是洪水玩法的核心对象。它有水位（可用事件 / 动画上涨）、风格（外观 + 默认伤害 / 氧气规则）、水阻、浑浊度与深度吸收、泡沫边等。多个液体对象按各自体积共同构成水体。' },
  { k: 'obj.damage', cat: 'obj', n: '伤害区域',
    t: '进入后按速率扣血的隐形区域，从中心向外有推力。' },
  { k: 'obj.trigger', cat: 'obj', n: '触发器',
    t: '进入 / 离开时触发事件的隐形区域。' },
  { k: 'obj.npc', cat: 'obj', n: 'NPC',
    t: '会跟随或巡逻的角色，可交互对话（多段分支）。' },
  { k: 'obj.emitter', cat: 'obj', n: '粒子发射器',
    t: '烟雾 / 火花 / 气泡等粒子特效；有体积但不参与碰撞。',
    d: '发射器持续产生粒子并施加初速度与加速度，用来做上升的烟、上飘的火花、上浮的气泡或下落的尘。有体积（可被引用 / 触发）但不阻挡玩家。' },
  { k: 'obj.fogvol', cat: 'obj', n: '体积雾',
    t: '区域性的体积雾效，营造氛围。' },
  { k: 'obj.volumelight', cat: 'obj', n: '体积光',
    t: '可见光束（丁达尔效应），边缘柔和度 / 距离衰减可调。' },
  { k: 'obj.soundblock', cat: 'obj', n: '音源方块',
    t: '范围内播放音频：进入范围 / 循环 / 鼠标点击三种模式。' },
  { k: 'obj.postfx', cat: 'obj', n: '后处理',
    t: '全屏画面特效（暗角 / 色差 / 颗粒…），可逐项开关。',
    d: '后处理作用在整幅画面上，营造氛围与镜头感。每个开关（暗角 / 色差 / 颗粒 / 泛光…）可单独启停并调参；整关只生效优先级最高的那个后处理对象。' },
  { k: 'obj.exposure', cat: 'obj', n: '曝光控制',
    t: '整关的画面曝光 / 染色控制对象。',
    d: '统一控制画面明暗基准（EV 曝光补偿）与整体染色（饱和度 / 染色色相）。适合做「进入梦境深处整体变暗变蓝」这类全局基调。' },
  { k: 'obj.click', cat: 'obj', n: '点击物',
    t: '可被玩家点击 / 按键交互的物体，触发事件。' },
  { k: 'obj.climb', cat: 'obj', n: '攀爬面',
    t: '贴着它可以向上攀爬的墙面。' },
  { k: 'obj.walljump', cat: 'obj', n: '蹬墙跳面',
    t: '允许玩家在其表面蹬墙起跳的墙面。' },
  { k: 'obj.button', cat: 'obj', n: '按钮',
    t: '按下后触发事件的按钮（可设一次性 / 冷却）。' },
  { k: 'obj.door', cat: 'obj', n: '门',
    t: '可被事件开关的门体。' },
  { k: 'obj.tool', cat: 'obj', n: '工具',
    t: '可拾取的工具（如抽水泵等），进入工具栏使用。' },
  { k: 'obj.projectile', cat: 'obj', n: '抛射物',
    t: '被工具 / 事件发射出的飞行物。' },
  { k: 'obj.goal', cat: 'obj', n: '终点',
    t: '摸到即通关的终点区域。' },
  { k: 'obj.spawn', cat: 'obj', n: '出生点',
    t: '玩家进入关卡的位置与朝向。' },
  { k: 'obj.checkpoint', cat: 'obj', n: '检查点',
    t: '碰到后记录重生位置，死亡从这里复活。' },
  { k: 'obj.light', cat: 'obj', n: '光源',
    t: '点光 / 聚光灯，照亮场景。' },
  { k: 'obj.zipline', cat: 'obj', n: '滑索',
    t: '两点之间的滑索，抓上去滑行。' },
  { k: 'obj.curve', cat: 'obj', n: '折曲线',
    t: '带贝塞尔手柄的节点曲线，供管道 / 曲线墙 / 路径引用。',
    d: '折曲线由若干节点组成，每个节点带一对贝塞尔手柄，用来拉出平滑弯曲。它本身通常不可见，是管道 / 曲线墙 / 巡逻路径等的「骨架」——改它，引用它的对象自动重建。' },
  { k: 'obj.pipe', cat: 'obj', n: '管道',
    t: '沿折曲线生成的管体，截面细分与法线平滑可调。',
    d: '管道沿一条折曲线（或引用别的折曲线对象）生成管状几何。截面细分数决定是明显多边形管还是接近圆管；法线平滑开关决定圆润还是硬边。' },
  { k: 'obj.curvewall', cat: 'obj', n: '曲线墙',
    t: '沿折曲线生成的墙面。' },
  { k: 'obj.meshref', cat: 'obj', n: '网格引用',
    t: '引用其它几何体对象的外形（改源对象，本对象自动跟随）。',
    d: '网格引用复制另一个几何体对象的外形而不复制数据：改源对象的外形，本对象立即跟着变。适合做大量相同的复杂结构，修改一次全部同步。' },
  { k: 'obj.group', cat: 'obj', n: '编组',
    t: '把多个对象收进一个空组，整体变换。' },
  { k: 'obj.attachment', cat: 'obj', n: '挂点',
    t: '把对象挂到另一对象（或 NPC 骨骼）上的锚点。',
    d: '挂点是一个锚定位置：把一个对象（或一整组）挂到目标对象的某根骨骼上，于是它随骨骼一起运动。给 NPC 戴帽子、握武器、挂特效都靠它。' },
  { k: 'obj.textblock', cat: 'obj', n: '文本牌',
    t: '场景里的 3D 文字牌。' },
  { k: 'obj.billboard', cat: 'obj', n: '公告板',
    t: '永远朝向玩家的图片 / 文字面板。' },
  { k: 'obj.portal', cat: 'obj', n: '传送门',
    t: '真实渲染的 see-through 传送门，多层叠加可做无限回廊。',
    d: '传送门透过门框显示目标位置的实时画面，走进去抵达另一端。支持多层叠加（A 透过 B 看到 C）与混合模式，可做出无限回廊、镜厅等错觉空间。' },

  /* ═══ 对象属性（按属性面板名称匹配） ═══ */
  { k: 'prop.name', cat: 'prop', n: '名称', prop: true,
    t: '对象显示名，留空则自动命名。' },
  { k: 'prop.position', cat: 'prop', n: '位置', prop: true,
    t: '世界坐标 XYZ；Shift+悬停滚轮可微调数值。',
    d: '位置是对象在世界中的坐标（单位 stud）。在视口拖动手柄移动时这里会同步变化；也可以直接键入精确数值。按住 Shift 并把滚轮悬在数字框上可按步进微调。' },
  { k: 'prop.rotation', cat: 'prop', n: '旋转(度)', prop: true,
    t: '欧拉角（度）；配合局部坐标系更直观。',
    d: '旋转用欧拉角描述（绕 X / Y / Z 各转多少度）。给已经旋转过的对象继续调整时，切到「局部坐标」手柄会跟随对象朝向，更符合直觉。' },
  { k: 'prop.scale', cat: 'prop', n: '尺寸/缩放', prop: true,
    t: '三轴缩放；最小 0.02。',
    d: '缩放控制对象三轴的大小（相对基础几何）。对几何体而言这同时决定它的体积与碰撞大小。注意九宫格贴图与平铺贴图对缩放的响应不同。' },
  { k: 'prop.color', cat: 'prop', n: '颜色', prop: true,
    t: '漫反射颜色；开智能调制后含义升级。',
    d: '默认是「乘在贴图上」的漫反射色：白 = 保持贴图原色，其它颜色会给贴图整体染色（贴图偏暗时容易发脏）。想要干净的换色，打开「智能调制」。' },
  { k: 'prop.smartMod', cat: 'prop', n: '智能调制', prop: true,
    t: '颜色从「直接乘在贴图上」升级为「智能重调制」：预统计贴图平均色相 / 饱和度后重新着色，改色不发脏。' },
  { k: 'prop.transparency', cat: 'prop', n: '透明度', prop: true,
    t: '0 不透明 → 1 全透明。' },
  { k: 'prop.metalness', cat: 'prop', n: '金属光泽度', prop: true,
    t: '金属度 0~1：越高反射越像金属。',
    d: '金属度决定这是「金属」还是「绝缘体（塑料 / 石头）」。金属会强烈反射环境色、漫反射几乎消失；非金属则漫反射为主。现实中大多数物体只有 0 或 1，中间值用于做渐变或特殊质感。' },
  { k: 'prop.roughness', cat: 'prop', n: '粗糙度', prop: true,
    t: '粗糙度 0~1：越低高光越锐利。',
    d: '粗糙度控制高光的涣散程度：0 = 镜面般锐利的反射，1 = 完全漫射的哑光。想做出「湿漉漉」用低值，「水泥 / 布料」用高值。' },
  { k: 'prop.advMat', cat: 'prop', n: '高级材质', prop: true,
    t: '内置 41 种特殊表面（玻璃 / 金属 / 力场 / 全息 / 熔岩…），选中自动套用推荐参数。',
    d: '高级材质是「一整套预设」：选中后自动把金属度 / 粗糙度 / 透明度 / 折射 / 发射等参数配好，再提供该材质专属的微调项（如玻璃的折射率与体积吸收、图案类的疏密与对比）。' },
  { k: 'prop.reflectivity', cat: 'prop', n: '反射率', prop: true,
    t: '0 不反射，1 默认，3 镜面级；用加载时捕获的立方体贴图，运行时几乎零开销。' },
  { k: 'prop.anchored', cat: 'prop', n: '锚定', prop: true,
    t: '锚定的物体固定不动；未锚定的会被水冲掉落。',
    d: '勾选「锚定」让对象在游戏里固定不动、不受重力与水冲。做平台、墙、机关通常要锚定；做可被洪水冲走的箱子 / 木板则不要锚定。' },
  { k: 'prop.visible', cat: 'prop', n: '可见', prop: true,
    t: '关闭后游戏内与编辑器中都隐藏；可用事件「显示对象」再打开。' },
  { k: 'prop.textureFill', cat: 'prop', n: '贴图填充模式', prop: true,
    t: '拉伸=一张铺满整面；平铺不拉伸=按世界尺寸重复正方格；九宫格=边框不随缩放变形。',
    d: '三种填充：① 拉伸——一张贴图铺满整个面，简单但缩放会拉扁图案；② 平铺不拉伸——每格贴图的世界尺寸固定，因此同一贴图在所有物体上格子大小一致、图案不变形；③ 九宫格——外圈边框固定、中心拉伸，缩放时边框粗细与圆角不变形。' },
  { k: 'prop.textureScale', cat: 'prop', n: '贴图缩放 / 重复', prop: true,
    t: '拉伸模式下是重复次数；平铺模式下是每格贴图的世界边长(stud)，越大图案越大。' },
  { k: 'prop.aoBake', cat: 'prop', n: '顶点 AO 烘焙', prop: true,
    t: '关掉后不做顶点 AO、几何体不细分，大块体省性能。' },

  /* ═══ 液体 / 洪水 ═══ */
  { k: 'liq.style', cat: 'liquid', n: '水纹风格',
    t: '30 种液体风格（颜色 + 水纹外观）：清水 / 酸 / 熔岩 / 可乐 / 梦核 / 星河…' },
  { k: 'liq.oxygenMode', cat: 'liquid', n: '氧气模式',
    t: '自由决定液体对氧气的影响方式。' },
  { k: 'liq.instantKill', cat: 'liquid', n: '接触即死',
    t: '碰到液体立刻死亡（熔岩默认开启）。' },
  { k: 'liq.headOnly', cat: 'liquid', n: '仅淹没头部判定',
    t: '开启后只有液面高于玩家头部才判定溺水 / 伤害。' },
  { k: 'liq.swim', cat: 'liquid', n: '立体游泳',
    t: '关闭后玩家在水中会下沉。' },
  { k: 'liq.drag', cat: 'liquid', n: '水阻',
    t: '受阻后速度 = 基础速度 × (1 − 水阻 × 淹没比例)。' },
  { k: 'liq.fill', cat: 'liquid', n: '水位 / 填充',
    t: '1 = 满，0 = 空；可用动画 / 事件动态改变（洪水上涨就靠它）。' },
  { k: 'liq.foam', cat: 'liquid', n: '泡沫边',
    t: '水下岛屿与水面相交处的一圈白边 + 水面外沿泡沫。' },
  { k: 'liq.turbidity', cat: 'liquid', n: '浑浊度 / 水下能见度',
    t: '水面往下能看多深(stud)：超过该深度物体完全没入浑浊色（0 = 清澈见底）。' },
  { k: 'liq.absorb', cat: 'liquid', n: '深度吸收',
    t: '水越深越暗；「吸收起点」决定多浅就开始变暗，「最暗保留」决定最深处还剩多少亮度。' },

  /* ═══ 天空工坊 / 天空修饰器 ═══ */
  { k: 'sky.lab', cat: 'sky', n: '天空工坊',
    t: '程序化生成天空球：云 / 星空 / 大气 / 日月 / 图案 / 71 种纹理 shader，可烘焙导出全景图。',
    d: '天空工坊用算法现场生成一整颗天空球：选择基底（云 / 星空 / 大气 / 图案等）与 71 种纹理 shader 之一，叠加日月、色调、噪声等参数，满意后烘焙导出为全景图素材，供关卡直接引用。' },
  { k: 'sky.mod.general', cat: 'sky', n: '天空修饰器（Modifier）',
    t: '给天空球叠加一组修饰器：几何变形 + 色彩曝光，实时预览。',
    d: '修饰器是对已生成 / 已导入的天空球再加工：在修饰器栈里添加多条（几何变形类、色彩曝光类），逐条调参并实时预览，可随时启用 / 停用 / 删除。它不改变原始天空，而是叠加一层可回退的效果。' },
  { k: 'sky.mod.vshift', cat: 'sky', n: '垂直平移（地面升降）',
    t: '把天空整体上 / 下平移，视觉上抬升或压低地平线（无直线弯曲）。',
    d: '按连续映射把天空整体上下平移：正数地平线下降（天空变高远）、负数地平线上升。因为是整体平移而非透视投影，画面里的直线不会弯曲。' },
  { k: 'sky.mod.perspective', cat: 'sky', n: '透视扭曲',
    t: '按透视投影重映射天穹，产生近大远小的错觉。' },
  { k: 'sky.mod.zoom', cat: 'sky', n: '视觉放大 / 缩小',
    t: '放大或缩小整个天空视野。' },
  { k: 'sky.mod.barrel', cat: 'sky', n: '桶形 / 枕形畸变',
    t: '正强度桶形膨胀，负强度枕形收缩；连续映射无缝。',
    d: '桶形畸变把画面向外鼓（像鱼眼），枕形则向内收。适合做梦境 / 眩晕氛围；采用连续映射，因此平铺时接缝处不断裂。' },
  { k: 'sky.mod.twist', cat: 'sky', n: '螺旋扭转',
    t: '以天顶为中心的漩涡扭曲。' },
  { k: 'sky.mod.spin', cat: 'sky', n: '水平旋转（罗盘）',
    t: '整体绕竖直轴旋转天空。' },
  { k: 'sky.mod.dome', cat: 'sky', n: '穹顶压缩 / 展开',
    t: '按指数曲线压缩 / 拉伸天穹高度分布。' },
  { k: 'sky.mod.wave', cat: 'sky', n: '波浪摇曳',
    t: '随时间正弦摆动的动态扭曲，可调幅度 / 频率 / 相位。' },
  { k: 'sky.mod.exposure', cat: 'sky', n: '曝光度（天空）',
    t: 'EV 曝光补偿，负值压暗、正值提亮，线性空间计算。' },
  { k: 'sky.mod.brightness', cat: 'sky', n: '亮度（天空）',
    t: '整体亮度增减。' },
  { k: 'sky.mod.contrast', cat: 'sky', n: '对比度（天空）',
    t: '对比度拉伸，1 = 原图。' },
  { k: 'sky.mod.saturation', cat: 'sky', n: '饱和度（天空）',
    t: '色彩饱和度，0 = 灰度。' },
  { k: 'sky.mod.hue', cat: 'sky', n: '色相旋转（天空）',
    t: '整体色相在色环上旋转。' },
  { k: 'sky.mod.temperature', cat: 'sky', n: '色温 / 色调（天空）',
    t: '正 = 偏暖，负 = 偏冷。' },
  { k: 'sky.mod.gamma', cat: 'sky', n: '伽马曲线（天空）',
    t: '伽马 <1 提亮暗部，>1 压暗暗部。' },
  { k: 'sky.mod.colorize', cat: 'sky', n: '染色（天空）',
    t: '按指定颜色与强度给天空染色。' },
  { k: 'sky.mod.grayscale', cat: 'sky', n: '灰度（天空）',
    t: '按强度把天空转黑白。' },
  { k: 'sky.mod.invert', cat: 'sky', n: '反相（天空）',
    t: '按强度反转天空颜色。' },

  /* ═══ 贴图 / 素材 ═══ */
  { k: 'tex.fill.stretch', cat: 'tex', n: '拉伸',
    t: '一张贴图铺满整个面（uvMax 1 / repeat 4,4）。' },
  { k: 'tex.fill.tile', cat: 'tex', n: '平铺不拉伸',
    t: '每格世界尺寸 = 1/贴图重复，同一贴图在所有物体 / 面上格子大小一致，不会被拉扁。' },
  { k: 'tex.fill.nine', cat: 'tex', n: '九宫格',
    t: '边框贴图外圈固定 1/3，缩放时边框不变形（NinePatch）。' },
  { k: 'tex.normal', cat: 'tex', n: '法线 / 粗糙度贴图',
    t: '应用时自动继承底贴图的 repeat/offset/wrap 属性；线性色彩空间采样，不继承 sRGB。' },
  { k: 'tex.trimesh', cat: 'tex', n: '低模体贴图缩放',
    t: 'trimesh 类对象与 block 对齐：每格贴图的世界边长 = 贴图尺寸(stud)，小=密集，大=稀疏。' },
  { k: 'tex.texmod', cat: 'tex', n: '贴图修改器',
    t: '以贴图为源做多图层叠加 / 扭曲 / 风格化 / 调色，烘焙成 PNG 素材；配方保存在存档里。' },
  { k: 'tex.import', cat: 'tex', n: '素材导入与本地化',
    t: '所有素材导入都会拷贝一份到存档文件夹（本地化），后续引用均指向本地资源；替换素材时新文件覆盖旧的。' },

  /* ═══ 事件 / 动画 / NPC ═══ */
  { k: 'ev.onTouch', cat: 'event', n: '触碰触发事件',
    t: '玩家触碰到该对象时触发所选事件。' },
  { k: 'ev.onEnter', cat: 'event', n: '进入区域事件',
    t: '玩家进入该对象范围时触发。' },
  { k: 'ev.onExit', cat: 'event', n: '离开区域事件',
    t: '玩家离开该对象范围时触发。' },
  { k: 'ev.useEvent', cat: 'event', n: '使用 / 交互事件',
    t: '玩家按键交互（准星对准按 E / 点击）时触发。' },
  { k: 'ev.editor', cat: 'event', n: '事件编辑器',
    t: '触发器 → 条件 → 动作：如开门、给道具、涨水、显示顶部提示等。' },
  { k: 'ev.anim', cat: 'event', n: '动画编辑器',
    t: '关键帧动画：位移 / 旋转 / 缩放 / 显隐，可被事件播放、循环或反向。' },
  { k: 'ev.npc', cat: 'event', n: 'NPC 对话',
    t: '节点图编辑多段对话：台词节点可连「下一句」与「分支选项」；可挂开始对话事件。' },
];

/* ---------- 名称 → 条目 索引（属性面板按名称匹配用） ---------- */
const BY_KEY = new Map(TIPS.map((e) => [e.k, e]));
const BY_NAME = new Map();
for (const e of TIPS) if (e.prop && e.n && !BY_NAME.has(e.n)) BY_NAME.set(e.n, e);

/* ---------- 气泡 DOM ---------- */
let tipEl = null;
let showTimer = 0;
let hideTimer = 0;
let curAnchor = null;

function ensureTipEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.id = 'gtip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  return tipEl;
}

function tipHTML(entry) {
  let html = '<b>' + esc(entry.n || '') + '</b>';
  const t = entry.t || '';
  if (t) html += '<span>' + esc(t) + '</span>';
  return html;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function place(anchor) {
  if (!tipEl) return;
  const r = anchor.getBoundingClientRect();
  tipEl.style.left = '0px'; tipEl.style.top = '0px';
  const w = tipEl.offsetWidth || 240, h = tipEl.offsetHeight || 60;
  let x = r.left + r.width / 2 - w / 2;
  let y = r.bottom + 8;
  if (y + h > window.innerHeight - 8) y = r.top - h - 8;      // 底部放不下翻到上方
  x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  y = Math.max(8, y);
  tipEl.style.left = x + 'px';
  tipEl.style.top = y + 'px';
}

function showFor(anchor, entry) {
  if (!entry) return;
  const el = ensureTipEl();
  el.innerHTML = tipHTML(entry);
  el.classList.add('show');
  curAnchor = anchor;
  place(anchor);
}

function hide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  showTimer = hideTimer = 0;
  curAnchor = null;
  if (tipEl) tipEl.classList.remove('show');
}

/* ---------- 解析：从目标元素向上找可提示的条目 ----------
   优先级：data-tip（引用表键或原文）> 属性面板属性行（按名称查表）> title 属性（收编） */
function resolve(node) {
  let n = node;
  let depth = 0;
  while (n && n.nodeType === 1 && depth < 8) {
    /* 1. 显式 data-tip：值可以是引用表的 k，也可以是直接文案 */
    const dt = n.getAttribute && n.getAttribute('data-tip');
    if (dt) {
      const entry = BY_KEY.get(dt);
      return entry || { n: '', t: dt };
    }
    /* 2. 属性面板行：按标签文字查引用表；查不到回落到原生 title */
    if (n.classList && n.classList.contains('prow')) {
      const lb = n.querySelector(':scope > label');
      const txt = lb ? (lb.textContent || '').trim() : '';
      const hit = txt && BY_NAME.get(txt);
      if (hit) return hit;
    }
    /* 3. 原生 title：收编为自定义气泡（永久移除属性避免双弹） */
    const ti = n.getAttribute && n.getAttribute('title');
    if (ti) {
      n.removeAttribute('title');
      n.setAttribute('data-gtip-raw', ti);
      /* title 若正好等于引用表里的名称，用表里的完整条目 */
      const hit = BY_NAME.get(ti.trim());
      if (hit) return hit;
      return { n: firstLine(ti), t: restLines(ti) };
    }
    /* 4. 曾被收编过的 */
    const raw = n.getAttribute && n.getAttribute('data-gtip-raw');
    if (raw) {
      const hit = BY_NAME.get(raw.trim());
      if (hit) return hit;
      return { n: firstLine(raw), t: restLines(raw) };
    }
    n = n.parentNode;
    depth++;
  }
  return null;
}
function firstLine(s) { const i = String(s).indexOf('\n'); return i < 0 ? String(s).trim() : String(s).slice(0, i).trim(); }
function restLines(s) { const i = String(s).indexOf('\n'); return i < 0 ? '' : String(s).slice(i + 1).trim(); }

/* ---------- 事件接线（全 app 一份委托监听） ---------- */
function bindHover() {
  document.addEventListener('pointerover', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('#gtip') || t.closest('#manual')) return;
    /* 已经悬在同一个锚上就不重启计时 */
    const hit = resolve(t);
    if (!hit) { hide(); return; }
    const anchor = deepestTipAnchor(t) || t;
    if (anchor === curAnchor) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => showFor(anchor, hit), 450);
  }, true);
  document.addEventListener('pointerout', (e) => {
    if (!(e.target instanceof Element)) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(() => {
      if (!curAnchor) return;
      const hov = document.elementFromPoint(e.clientX || -1, e.clientY || -1);
      if (!hov || !hov.closest || (!hov.closest('#gtip') && hov !== curAnchor && !curAnchor.contains(hov))) hide();
    }, 60);
  }, true);
  window.addEventListener('blur', hide);
  window.addEventListener('scroll', hide, true);
}
/* 找到触发提示的最外层有效锚（比如 prow 整行作为锚，而不是里面的 input） */
function deepestTipAnchor(from) {
  const prow = from.closest && from.closest('.prow');
  if (prow) return prow;
  const withTip = from.closest && from.closest('[title],[data-tip],[data-gtip-raw]');
  return withTip || from;
}

/* ============================================================
   使用手册：全量内容来自 TIPS 大引用表
   ============================================================ */
let manualEl = null;

export function openManual(cat) {
  if (!manualEl) {
    manualEl = document.createElement('div');
    manualEl.id = 'manual';
    manualEl.innerHTML =
      '<div class="mn-box">' +
      '  <div class="mn-head"><h2>📖 使用手册</h2>' +
      '    <input class="inp mn-search" type="search" placeholder="搜索名称 / 说明…">' +
      '    <button class="xbtn mn-close" title="关闭手册">✕</button></div>' +
      '  <div class="mn-body"><div class="mn-cats"></div><div class="mn-list"></div></div>' +
      '</div>';
    document.body.appendChild(manualEl);
    manualEl.querySelector('.mn-close').addEventListener('click', closeManual);
    manualEl.addEventListener('pointerdown', (e) => { if (e.target === manualEl) closeManual(); });
    manualEl.querySelector('.mn-search').addEventListener('input', () => renderManualList());
    const cats = manualEl.querySelector('.mn-cats');
    for (const c of CATS) {
      const b = document.createElement('button');
      b.className = 'mn-cat' + (c.v === (cat || 'intro') ? ' on' : '');
      b.textContent = c.l;
      b.dataset.v = c.v;
      b.addEventListener('click', () => {
        cats.querySelectorAll('.mn-cat').forEach((x) => x.classList.toggle('on', x === b));
        renderManualList();
      });
      cats.appendChild(b);
    }
  }
  if (cat) {
    manualEl.querySelectorAll('.mn-cat').forEach((x) => x.classList.toggle('on', x.dataset.v === cat));
  }
  manualEl.classList.add('show');
  renderManualList();
}

export function closeManual() {
  if (manualEl) manualEl.classList.remove('show');
}

function renderManualList() {
  if (!manualEl) return;
  const catBtn = manualEl.querySelector('.mn-cat.on');
  const cat = catBtn ? catBtn.dataset.v : 'intro';
  const q = (manualEl.querySelector('.mn-search').value || '').trim().toLowerCase();
  const list = manualEl.querySelector('.mn-list');
  list.innerHTML = '';
  const catLabel = (CATS.find((c) => c.v === cat) || {}).l || '';
  const entries = TIPS.filter((e) =>
    e.cat === cat &&
    (!q || (e.n + ' ' + (e.t || '') + ' ' + (e.d || '')).toLowerCase().includes(q)));
  if (!entries.length) {
    list.innerHTML = '<div class="mn-empty">该分类下没有匹配「' + esc(q) + '」的条目。</div>';
    return;
  }
  for (const e of entries) {
    const card = document.createElement('div');
    card.className = 'mn-item';
    card.innerHTML =
      '<b>' + esc(e.n || '(未命名)') + '</b>' +
      (e.t ? '<span class="mn-t">' + esc(e.t) + '</span>' : '') +
      (e.d ? '<span class="mn-d">' + esc(e.d) + '</span>' : '') +
      '<span class="mn-cat-tag">' + esc(catLabel) + '</span>';
    list.appendChild(card);
  }
}

/* ---------- 注入「使用手册」入口按钮 ---------- */
function injectButtons() {
  // 主菜单
  const menuBtns = document.querySelector('#menu .menu-btns');
  if (menuBtns && !menuBtns.querySelector('[data-act="manual"]')) {
    const b = document.createElement('button');
    b.className = 'mbtn';
    b.setAttribute('data-act', 'manual');
    b.innerHTML = '<b>📖 使用手册</b><i>全部功能说明 · 与悬浮提示同源</i>';
    b.addEventListener('click', () => openManual());
    menuBtns.appendChild(b);
  }
  // 编辑器顶栏
  const edActions = document.getElementById('ed-actions');
  if (edActions && !edActions.querySelector('[data-act="manual"]')) {
    const b = document.createElement('button');
    b.className = 'mbtn sm';
    b.setAttribute('data-act', 'manual');
    b.setAttribute('title', '打开使用手册：全部按钮 / 属性 / 对象说明');
    b.textContent = '📖 手册';
    b.addEventListener('click', () => openManual('ed-top'));
    edActions.insertBefore(b, edActions.firstChild);
  }
}

/* ---------- 样式（模块自带，避免改全局 css） ---------- */
function injectStyle() {
  if (document.getElementById('gtip-style')) return;
  const st = document.createElement('style');
  st.id = 'gtip-style';
  st.textContent = `
#gtip{position:fixed;z-index:120;max-width:calc(300px * var(--ui-s));pointer-events:none;opacity:0;
  transform:translateY(calc(4px * var(--ui-s)));transition:opacity .14s ease,transform .14s ease;
  background:rgba(14,12,28,.96);border:1px solid rgba(127,227,255,.35);border-radius:calc(10px * var(--ui-s));
  padding:calc(8px * var(--ui-s)) calc(12px * var(--ui-s));box-shadow:0 calc(10px * var(--ui-s)) calc(32px * var(--ui-s)) rgba(0,0,0,.5);backdrop-filter:blur(calc(8px * var(--ui-s)))}
#gtip.show{opacity:1;transform:none}
#gtip b{display:block;font-size:calc(12.5px * var(--ui-s) * var(--ui-fs));color:#9fe4ff;letter-spacing:.03em;margin-bottom:calc(2px * var(--ui-s))}
#gtip span{display:block;font-size:calc(11.5px * var(--ui-s) * var(--ui-fs));line-height:1.55;color:rgba(225,232,255,.86);white-space:pre-line}

#manual{position:fixed;inset:0;z-index:115;display:none;place-items:center;
  background:radial-gradient(120% 90% at 50% 40%,rgba(4,4,10,.55) 40%,rgba(4,4,10,.8) 100%);
  backdrop-filter:blur(calc(7px * var(--ui-s)))}
#manual.show{display:grid}
.mn-box{width:min(calc(960px * var(--ui-s)),94vw);height:min(calc(680px * var(--ui-s)),88vh);display:flex;flex-direction:column;
  background:rgba(18,16,34,.97);border:1px solid rgba(255,255,255,.14);border-radius:calc(16px * var(--ui-s));
  box-shadow:0 calc(24px * var(--ui-s)) calc(80px * var(--ui-s)) rgba(0,0,0,.6);overflow:hidden}
.mn-head{display:flex;align-items:center;gap:calc(12px * var(--ui-s));padding:calc(14px * var(--ui-s)) calc(18px * var(--ui-s));border-bottom:1px solid rgba(255,255,255,.09)}
.mn-head h2{margin:0;font-size:calc(17px * var(--ui-s) * var(--ui-fs));color:#9fe4ff;letter-spacing:.05em;white-space:nowrap}
.mn-search{flex:1}
.mn-body{flex:1;display:flex;min-height:0}
.mn-cats{width:calc(158px * var(--ui-s));flex:none;overflow-y:auto;border-right:1px solid rgba(255,255,255,.09);
  padding:calc(10px * var(--ui-s)) calc(8px * var(--ui-s));display:flex;flex-direction:column;gap:calc(3px * var(--ui-s))}
.mn-cat{text-align:left;padding:calc(8px * var(--ui-s)) calc(11px * var(--ui-s));border-radius:calc(8px * var(--ui-s));border:1px solid transparent;
  background:transparent;color:rgba(220,228,255,.7);font-size:calc(12.5px * var(--ui-s) * var(--ui-fs));cursor:pointer;transition:.13s}
.mn-cat:hover{background:rgba(127,227,255,.09);color:#fff}
.mn-cat.on{background:rgba(127,227,255,.14);border-color:rgba(127,227,255,.4);color:#9fe4ff}
.mn-list{flex:1;overflow-y:auto;padding:calc(14px * var(--ui-s)) calc(18px * var(--ui-s));display:flex;flex-direction:column;gap:calc(10px * var(--ui-s))}
.mn-item{position:relative;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.09);
  border-radius:calc(10px * var(--ui-s));padding:calc(12px * var(--ui-s)) calc(14px * var(--ui-s))}
.mn-item b{display:block;font-size:calc(13.5px * var(--ui-s) * var(--ui-fs));color:#cfe9ff;margin-bottom:calc(4px * var(--ui-s));padding-right:calc(90px * var(--ui-s))}
.mn-t{display:block;font-size:calc(12px * var(--ui-s) * var(--ui-fs));line-height:1.6;color:rgba(220,228,255,.85)}
.mn-d{display:block;margin-top:calc(6px * var(--ui-s));font-size:calc(11.5px * var(--ui-s) * var(--ui-fs));line-height:1.75;color:rgba(200,210,240,.62)}
.mn-cat-tag{position:absolute;right:calc(12px * var(--ui-s));top:calc(10px * var(--ui-s));font-size:calc(10px * var(--ui-s) * var(--ui-fs));letter-spacing:.06em;
  color:rgba(159,228,255,.6);border:1px solid rgba(127,227,255,.25);border-radius:calc(99px * var(--ui-s));padding:calc(2px * var(--ui-s)) calc(8px * var(--ui-s))}
.mn-empty{color:rgba(200,210,240,.5);font-size:calc(13px * var(--ui-s) * var(--ui-fs));padding:calc(24px * var(--ui-s)) calc(4px * var(--ui-s))}
@media (max-width:760px){
  .mn-cats{width:calc(110px * var(--ui-s))}
  .mn-item b{padding-right:0}
  .mn-cat-tag{display:none}
}`;
  document.head.appendChild(st);
}

/* ---------- 初始化 ---------- */
let inited = false;
export function initTooltips() {
  if (inited) return;
  inited = true;
  injectStyle();
  bindHover();
  injectButtons();
}