/* ============================================================
   程序化生成 · 编辑器接入（世界优先管线）
   ------------------------------------------------------------
   编辑器里点「生成关卡」→ 选难度 / 世界结构 / 主题 / 种子
   → 并行演化多条世界候选 → 挑榜首 → 排布跑酷 + 填水域 → 铺进当前关卡。
   生成结果记为一步可撤销操作，用户可接着手改或直接试玩。
   ============================================================ */
import { formBox, toast, hideScreens } from '../ui/dom.js';
import { uid } from '../core/util.js';
import { generateAsync, structureOptions, previewParams } from './index.js';
import { yieldFrame, workerState, poolSize } from './asyncjob.js';
import { styleOptions } from './world/theme.js';
import { MECHANICS } from './mechanics.js';
import { themeOptions } from './decor/index.js';

export async function openGeneratorDialog(ed) {
  if (!ed || !ed.level) return null;
  const cur = Number(ed.level.difficulty) || 1;
  const pv = previewParams(cur);

  const f = await formBox('程序化生成关卡（世界优先）', [
    { k: 'difficulty', l: '难度', t: 'num', d: cur, min: 0.5, max: 9.99, st: 0.1,
      h: 'Lucid 1 / Misty 2 / Deep 3 / Drowning 4 / Suffocating 5 / Nightmare 6+；难度越高，缺口越大、落点越窄、涨水越凶' },
    { k: 'structure', l: '世界结构', t: 'select', d: 'composite', o: structureOptions(),
      h: '复合 = 世界沿纵向分成若干结构带，从最幽闭一路逃向最开阔（洞穴 → 室内 → 竖井 → 半封闭 → 露天 → 开阔）；' +
        '难度越高起点越深。也可以固定成某一种结构。' },
    { k: 'themeId', l: '主题', t: 'select', d: 'auto',
      o: [{ v: 'auto', l: '自动（按世界结构 + 难度选）' }, ...themeOptions(), { v: 'none', l: '不装饰' }],
      h: '主题决定世界的**风格文法**（城市塔群 / 楼板柱网 / 岩腔 / 遗迹）、配色与液体皮肤，' +
        '装饰层再按同一主题铺无碰撞的氛围件' },
    { k: 'massingStyle', l: '世界风格（可覆盖主题）', t: 'select', d: 'auto', o: styleOptions(),
      h: '风格 × 结构 → 文法：城市风格在室内长成楼板柱网、在露天长成塔群；岩体风格长成不规则岩腔；旷野风格长成低矮遗迹。' +
        'auto = 由主题决定。' },
    { k: 'seed', l: '种子（留空 = 用当前时间）', t: 'text', d: '',
      h: '同一个种子 + 同一组参数 → 完全相同的世界与关卡' },
    { k: 'lanes', l: '并行候选世界数', t: 'num', d: poolSize(), min: 1, max: 4, st: 1,
      h: '异步多线程：一次并行演化 N 条不同的世界，按「世界质量 + 难度指纹 + 往上逃成色」挑榜首。' +
        '机器越强可以给越多。' },
    { k: 'evolveIters', l: '世界演化迭代次数（0 = 自动）', t: 'num', d: 0, min: 0, max: 400, st: 10,
      h: 'Phase B 的模拟退火迭代步数：越大世界结构越被「磨」过（连通 / 层次 / 开放度梯度 / 多样性），代价是更慢' },
    { k: 'navMode', l: '可通关性证明', t: 'select', d: 'try',
      o: [
        { v: 'try', l: '解析自检 + 尽力跑 NavGraph A*（推荐）' },
        { v: 'strict', l: '严格：NavGraph 必须逐边证明' },
        { v: 'off', l: '关闭：只做解析自检（最快）' },
      ],
      h: 'NavGraph 把世界的真实几何塞进临时场景，逐边跑 A* + 弧线射线净空，' +
        '能查出「数学上够得着、但被墙或天花板挡住」的情况；代价是每次生成慢 0.3~2 秒' },
    { k: 'replace', l: '清空关卡里已有的对象', t: 'bool', d: true },
    { k: 'writeSettings', l: '同时写入关卡设置（雾 / 天空 / 时限）', t: 'bool', d: true },
    { k: 'decorStrength', l: '装饰强度', t: 'num', d: 0.7, min: 0, max: 1, st: 0.05,
      h: '只缩放氛围件数量，不改配色。0 = 一件氛围件都不加（只写调色与雾 / 光色）；1 = 满配' },
    { k: 'props', l: '结构装饰（草 / 石 / 灯 / 残骸…）', t: 'bool', d: true,
      h: '按槽位（地贴 / 壁挂 / 顶挂 / 潮线 / 远景）撒微件，全部无碰撞、不做顶点 AO；受件数与三角面预算硬卡' },
  ], { ok: '生成', cls: 'wide' });
  if (!f) return null;

  const seed = String(f.seed || '').trim() || String(Date.now());
  const noDecor = f.themeId === 'none';

  const app = ed.app || null;
  const setLoad = (pct, msg) => { try { if (app) app._loadingProgress(pct, msg); } catch (e) { /* ignore */ } };
  const openLoad = (msg) => { try { if (app) app._loadingOpen('程序化生成关卡', msg); } catch (e) { /* ignore */ } };
  const closeLoad = () => {
    try { hideScreens(); } catch (e) { /* ignore */ }
    try { if (app) app._loadPrev = null; } catch (e) { /* ignore */ }
  };

  openLoad('正在演化世界…');
  await yieldFrame();

  let res;
  try {
    res = await generateAsync({
      difficulty: f.difficulty,
      structure: f.structure,
      seed,
      lanes: Math.round(f.lanes) || undefined,
      evolveIters: Math.round(f.evolveIters) || undefined,
      massingStyle: f.massingStyle === 'auto' ? undefined : f.massingStyle,
      navMode: f.navMode,
      decor: noDecor ? null : { strength: f.decorStrength, props: f.props },
      themeId: (!noDecor && f.themeId !== 'auto') ? f.themeId : undefined,
    }, (info) => {
      if (!info) return;
      if (info.phase === 'search') { setLoad(16, info.msg || '正在并行演化世界…'); return; }
      if (info.phase === 'nav') { setLoad(64, info.msg || '正在真实几何上证明可通关…'); return; }
      if (info.phase === 'assemble') { setLoad(88, info.msg || '正在写入关卡…'); return; }
      if (info.attempt) {
        const pct = info.attempts ? 12 + (info.attempt / info.attempts) * 46 : 26;
        const lane = info.lane != null ? ` · 线程 ${info.lane + 1}` : '';
        setLoad(pct, `候选世界 ${info.attempt}/${info.attempts}${lane}`
          + (info.boxes ? `（体块 ${info.boxes}${info.pads ? ` / 台面 ${info.pads}` : ''}）` : ''));
        return;
      }
      if (info.main) setLoad(26, 'Worker 池不可用，退回主线程生成…');
    });
  } catch (e) {
    console.error('[gen] 生成失败', e);
    closeLoad();
    toast('生成失败：' + (e && e.message ? e.message : e), 'err');
    return null;
  }

  setLoad(92, '正在回写到编辑器…');
  await yieldFrame();
  await applyToEditor(ed, res, f);
  closeLoad();
  return res;
}

/** 把生成结果并进当前关卡（一步可撤销），并整体重建场景（分帧，别一口气卡住） */
async function applyToEditor(ed, res, f) {
  const lv = res.level;
  const objs = lv.objects;
  if (!f.replace) {
    for (const o of objs) { o.id = uid(o.type.slice(0, 2)); o.parent = null; }
  }

  ed.edit('程序化生成关卡', () => {
    if (f.replace) ed.level.objects.length = 0;
    for (const o of objs) ed.level.objects.push(o);
    if (f.writeSettings) Object.assign(ed.level.settings, lv.settings);
    ed.level.difficulty = lv.difficulty;
  }, { tree: true, props: true });

  // 几何整体变了 → 走与「撤销 / 重做恢复」同一条重建路径（分帧让出，进度条才画得出来）
  await yieldFrame();
  try { ed.paint && ed.paint.rebuildAll(); } catch (e) { /* ignore */ }
  await yieldFrame();
  try {
    ed.builder.refreshAll();
    ed.builder.computeBounds();
    ed.builder.updateSunShadow();
  } catch (e) { /* ignore */ }
  if (ed.parkour) ed.parkour.invalidateNav();
  if (ed.eventsEd) ed.eventsEd.refresh();
  if (ed.animEd) ed.animEd.refresh();
  ed.refreshPanels();
  try { ed.viewport.frame(ed.builder.bounds, 1.25); } catch (e) { /* ignore */ }

  const r = res.report;
  const seed = lv.meta && lv.meta.generated ? lv.meta.generated.seed : '—';
  const g = r.graph || { nodes: 0, edges: 0, main: 0, ring: 0, detour: 0 };
  const wi = r.worldInfo || {};
  toast(`世界生成完成：${objs.length} 个对象 · 风格「${wi.styleLabel || '—'}」`
    + ` · 结构「${wi.structureLabel || '复合（逐带递进）'}」${(r.world && r.world.boxes) || 0} 体块`
    + ` · 观测 ${((r.observe && r.observe.pads) || 0)} 台面 → ${g.nodes} 落点 / ${g.edges} 边`
    + `（含 ${g.ring + g.detour} 条可选路线）`
    + ` · 塔外区域 ${(wi.regions || []).length} 处（结构件 ${wi.regionPieces || 0} 件）`
    + ` · 净爬升 ${Math.round(r.netRise)} stud · 跑图 ${Math.round(r.estTime)}s / 全长 ${r.timeLimit}s`
    + (r.water && r.water.flood ? ` · 涨水 ${r.water.riseTotal} stud` : '')
    + (r.mechanisms && r.mechanisms.total ? ` · 机制 ${r.mechanisms.total} 处` : '')
    + ` · ${proofLabel(r)} · ${r.lanes > 1 ? `${r.lanes} 条候选并行` : `尝试 ${r.attempts} 次`}`
    + (r.decor ? ` · 装饰「${r.decor.themeLabel}」${r.decor.objects} 件${decorMark(r.decor)}` : ''),
  r.ok && (!r.nav || r.nav.blocked === 0) && !(r.decor && r.decor.rejected) ? 'ok' : 'err', 5600);

  if (ed.log) {
    ed.log(`世界优先程序化生成（种子 ${seed}）· 难度 ${lv.difficulty.toFixed(1)}`
      + ` · 主题「${r.themeLabel}」· 全长 ${r.timeLimit}s（跑图 ${Math.round(r.estTime)}s，占 ${Math.round((r.traversalRatio || 0) * 100)}%）`
      + ` · 一命通（死亡上限 ${r.deathLimit}）`, r.ok ? 'ok' : 'w');
    ed.log(`生成方式：${String(r.worker).startsWith('pool') ? `Web Worker 池 ×${r.poolSize}（异步多线程，搜索在工作线程）`
      : '主线程同步（Worker 不可用，已自动兜底）'}`, 'i');

    if (r.world) {
      const e = r.evolve || {};
      ed.log(`Phase A 白模：世界风格「${wi.styleLabel}」（${wi.styleId || wi.style}）`
        + ` · 世界结构「${wi.structureLabel || '复合（逐带递进）'}」（${wi.structureId || 'composite'}）`
        + ` · 纵向 ${wi.bandCount} 带（${wi.grammarChain}）`
        + ` · 骨架 ${r.world.strandCount || 1} 条股道 × ${(r.world.strandSteps || []).join('/')} 级`
        + ` / 交汇环台 ${r.world.junctions || 0} 圈`
        + ` · 体素 ${r.world.cell} stud → ${r.world.cells} 格（实心占比 ${Math.round((r.world.massRatio || 0) * 100)}%）`
        + ` / ${r.world.boxes} 个体块 · 尺寸 ${Math.round(wi.height)}×${Math.round(wi.span)} stud`,
      r.world.boxes > 1200 ? 'w' : 'ok');
      // ★ 多体结构 + 塔外区域 + 结构件：世界「是几个体量」的读数
      ed.log(`Phase A2 多体结构：${wi.massCount || 0} 个体量，顶面高度 [${[...new Set((wi.masses || []).map((m) => m.top))].sort((a, b) => a - b).join(' / ')}]`
        + ` · 天台结构件 ${(wi.topPieces || []).length} 件`
        + ((wi.regions || []).length ? ` · 塔外区域 ${wi.regions.length} 个（${wi.regionPieces} 件）` : '')
        + ` · 结构件库 ${(wi.pieceCatalog || []).length} 种，本关用到 ${(wi.piecesUsed || []).join(' / ') || '—'}`
        + ` · 连桥接回交汇环台`, 'i');
      ed.log(`Phase B 迭代演化：模拟退火 ${e.iters || 0} 步，接受 ${e.accepted || 0} 次`
        + ` · 世界质量分 ${(e.score || 0).toFixed(3)}（体量 ${fmt(e.parts && e.parts.mass)} / 连通 ${fmt(e.parts && e.parts.conn)}`
        + ` / 落脚面 ${fmt(e.parts && e.parts.ledge)} / 层次 ${fmt(e.parts && e.parts.levels)}`
        + ` / 开放度梯度 ${fmt(e.parts && e.parts.gradient)} / 多样性 ${fmt(e.parts && e.parts.diversity)}）`, 'i');
    }
    if (r.observe) {
      const o = r.observe;
      ed.log(`Phase C1 观测：${o.pads} 块可用台面 · 可站占比 ${Math.round((o.standRatio || 0) * 1000) / 10}%`
        + ` · 空腔连通块 ${o.freeComponents}（主体占 ${Math.round((o.mainComponentRatio || 0) * 100)}%）`
        + ` · 逐带台面 [${(o.bandPads || []).join(', ')}]`, 'i');
    }
    if (r.route) {
      const rt = r.route;
      ed.log(`Phase C2 排布跑酷：${rt.steps} 步 · 骨架 ${rt.lanes || 1} 条股道`
        + `（交汇环台换股道 ${rt.laneSwitches || 0} 次 / 分叉段 ${rt.branchSegs || 0} 段）`
        + ` / 真实台面 ${rt.worldPads} 处 / 补板 ${rt.synth} 处`
        + ` · 下沉折返 ${rt.descents || 0} 段 · 岔路 ${rt.detours} 条`
        + ` · 主轴 ${g.main} + 岔路 ${g.detour}（共 ${g.nodes} 落点 / ${g.edges} 连接）`,
      (rt.synth || 0) > (rt.chain || 1) * 2.2 ? 'w' : 'ok');
      ed.log(`往上逃：净爬升 ${Math.round(r.netRise)} stud（升 ${Math.round(r.fingerprint.riseSum)} /`
        + ` 沉 ${Math.round(r.fingerprint.dropSum)}，向上占比 ${Math.round(r.fingerprint.climbRatio * 100)}%）`
        + ` · 主轴累计转向 ${r.fingerprint.turnSumDeg}°`, 'i');
      /* ★ 主轴上的「必经机制段」：滑索 / 攀爬 / WallJump / 游泳 —— 这一关不只有跳跳跳 */
      const ms = rt.mechStats || {};
      const mecTxt = Object.keys(ms).map((k) => `${MECH_LABEL[k] || k}×${ms[k]}`).join(' + ');
      if (rt.mechSegs) {
        ed.log(`Phase C2 必经机制段：${rt.mechSegs} 处（${mecTxt}）`
          + ` · 逐边证明里计 ${r.fingerprint.mechEdges || 0} 条机制边`
          + (rt.skippedFeat ? ` · ⚠ 有 ${rt.skippedFeat} 段特技段没能接上` : ''),
        rt.skippedFeat ? 'w' : 'ok');
      } else {
        ed.log('⚠ 本关主轴没有任何必经机制段（全是跳 / 落 / 走）', 'w');
      }
      ed.log(`难度指纹：maxGap ${r.fingerprint.maxGapRatio} / meanGap ${r.fingerprint.meanGapRatio}`
        + ` / 窄段占比 ${r.fingerprint.narrowRatio} · 最快 ${r.estTime}s`, 'i');
    }
    if (r.water && r.water.flood) {
      // ★ 开局即涨 + 按「时间窗口(per break stage)」分阶的节奏
      ed.log(`Phase C3 填水域：**开局即涨**（t=0 液面 ${r.water.surface0} stud，贴在最底落脚面之下 ${0.8} stud）`
        + ` → 时限内上涨 ${r.water.riseTotal} stud（液面 ${Math.round(r.water.fill0 * 100)}% → ${Math.round(r.water.fill1 * 100)}%）`
        + ` · 分 ${r.water.stages} 段（每段 ${r.water.stageSec}s，段末短暂停顿 = break stage 节奏）`
        + (r.water.lava ? ` · 深坑熔岩 ${r.water.lava} 处` : ''), 'i');
      if (r.events && r.events.length) {
        ed.log(`Phase C3b 开局事件：${r.events.map((e) => `${e.name}（${e.trigger.type} → ${(e.actions || []).map((a) => a.type).join(' / ')}）`).join(' · ')}`, 'i');
      }
    }

    if (r.navProven) {
      ed.log(`✓ NavGraph 已在真实几何上逐边证明：${g.edges} 条边 / ${r.nav.legs} 条通过`
        + (r.nav.mechLegs ? `（含必经机制段 ${r.nav.mechLegs} 条，按机制口径单独证明）` : '')
        + ` · ${r.nav.meshes} 个碰撞体 / ${r.nav.nodes} 个落点`
        + ` · 扫描 ${r.nav.scanMs}ms / 证明 ${r.nav.ms}ms`, 'ok');
    } else if (r.nav) {
      ed.log(`⚠ NavGraph 未完全证明：${r.nav.reason}（模式 ${r.navMode}）`, 'w');
    }

    if (r.candidates && r.candidates.length > 1) {
      ed.log(`并行候选（${r.candidates.length}）：` + r.candidates
        .map((c, i) => `#${i + 1} 质量 ${c.score == null ? '—' : c.score.toFixed(3)}${c.viable ? '' : '✗'}`)
        .join(' · '), 'i');
    }

    if (r.mechanisms && r.mechanisms.total) {
      const me = r.mechanisms;
      const by = Object.entries(me.stats || {})
        .map(([k, v]) => `${(MECHANICS[k] && MECHANICS[k].label) || k}×${v}`).join(' · ');
      ed.log(`高级机制 ${me.total} 处 · ${me.objects} 个对象`
        + (me.animations ? ` · ${me.animations} 条动画` : '') + `：${by}`
        + (me.rejected ? `（${me.rejected} 个实心件因挡路被丢）` : ''), 'i');
      ed.log('机制只做旁路 / 加速 / 惩罚：主轴那条「普通跳跃」的保底路线原样保留，'
        + '而且每个有碰撞的机制都过了一道「主轴通行净空」几何筛（撞上就丢）', 'i');
    }

    if (r.decor) {
      const d = r.decor;
      const fp = d.fingerprint || {};
      const base = d.baseline;
      const baseNote = base && (base.blocked || base.unproven)
        ? `（基线自身：走不通 ${base.blocked} 段 / 未证明 ${base.unproven} 段）`
        : '';
      ed.log(`装饰「${d.themeLabel}」(${d.themeId} · 强度 ${d.strength} · 结构 ${d.structure})：`
        + `${d.objects} 件氛围（光 ${d.stats.light} / 粒子 ${d.stats.dust} / 雾 ${d.stats.mist} / 光柱 ${d.stats.beam}）`
        + ` · ${decorVerdict(d)}`, d.rejected ? 'err' : (d.ok ? 'ok' : 'w'));
      if (d.struct) {
        const by = d.struct.byKind || {};
        const rj = d.structRejects || {};
        const top = Object.entries(d.struct.byRecipe || {})
          .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`).join(' ');
        ed.log(`结构装饰：${d.struct.placed} 件（地贴 ${by.floorDress || 0} / 壁挂 ${by.wallMount || 0}`
          + ` / 顶挂 ${by.ceilingHang || 0} / 潮线 ${by.waterline || 0} / 远景 ${by.farSilhouette || 0}）`
          + ` · 估算 ${d.struct.tris} 三角面${top ? ` · 母题 ${top}` : ''}`, 'i');
        ed.log(`硬约束否决：走廊净空 ${rj.pass || 0} / 贴不到面 ${rj.surface || 0} / 太密 ${rj.spread || 0}`
          + ` / 安全区 ${rj.safe || 0} / 液体 ${rj.water || 0} / 预算 ${rj.budget || 0}`, 'i');
      }
      ed.log(`装饰验证：口径 ${d.verifyMode === 'perLeg' ? '逐段（与关卡层同口径）' : '单次 spawn→goal'}`
        + ` · 新增碰撞体 ${d.collidableAdded} · 逐段结论变化 ${d.verification && d.verification.legsChanged !== null ? d.verification.legsChanged : '—'}`
        + (d.baselineReused ? ' · 基线复用关卡层证明（省一次 NavGraph）' : '')
        + baseNote, baseNote ? 'w' : 'i');
    }

    for (const x of (r.failures || []).slice(0, 4)) ed.log('⚠ ' + x.reason, 'w');
    for (const l of ((r.nav && r.nav.failedLegs) || []).slice(0, 5)) {
      ed.log(`⚠ 第 ${l.i + 1} 段（${l.move}）${l.ok ? '' : '：'}${l.reason}`, 'w');
    }
  }
}

const fmt = (v) => (v == null ? '—' : Number(v).toFixed(2));

/** 机制边 → 人话（日志用） */
const MECH_LABEL = { zip: '滑索', climb: '攀爬墙', wall: 'WallJump 竖井', swim: '泳池' };

/** 装饰结论（一句话） */
function decorVerdict(d) {
  if (d.rejected) return `✗ 装饰被证伪，已整份放弃：${d.reason}`;
  if (d.unproven) return `⚠ 可达性未证明（不算通过）：${d.reason}`;
  if (d.verification && d.verification.skipped) return '未跑可达性验证';
  return '✓ 装饰前后可达性一致';
}

/** toast 里的一句短标记 */
function decorMark(d) {
  if (d.rejected) return '（已放弃）';
  if (d.unproven) return '（未证明）';
  return '（可达性一致）';
}

/** 一句话概括这次生成的可通关性证明到了什么程度 */
function proofLabel(r) {
  if (!r.ok) return '⚠ 解析自检未通过';
  if (r.navMode === 'off') return '解析自检通过（未跑 NavGraph）';
  if (r.navProven) return '✓ 已在真实几何上证明可通关';
  if (!r.nav) return '解析自检通过';
  if (r.nav.blocked > 0) return `⚠ NavGraph 判定 ${r.nav.blocked} 段走不通`;
  if (r.nav.truncated) return '解析自检通过（NavGraph 超预算未跑完）';
  return `解析自检通过（NavGraph ${r.nav.unproven} 段因采样分辨率未证明）`;
}