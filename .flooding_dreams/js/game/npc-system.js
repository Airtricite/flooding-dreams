/* ============================================================
   NPC 系统（游戏运行时）
   对象的「外观」由 builder 负责（程序化 R6 / 导入模型），这里负责「行为」：
     - 待命：原地轻微呼吸晃动
     - 跟随：沿玩家走过的轨迹保持距离地跟上（走玩家走过的路，自然翻越地形）
     - 巡逻：在世界坐标的路径点之间来回移动
   以及交互检测、对话（节点图 + 分支选项）、事件动作接口。
   所有行为只在游玩模式下推进（编辑器里 NPC 是静态展示，见 update 的 editor 早退）。

   「运行时覆盖」统一写在 state 的 n._ov 上（不改关卡对象 o），
   重开关卡 / 回放时数据永远是干净的。
   ============================================================ */
import * as THREE from 'three';
import { clamp, damp, deg2rad, escapeHtml } from '../core/util.js';
import { normalizeDialogue, playMatrix } from '../world/level.js';

const TRAIL_INTERVAL = 0.15;   // 玩家足迹采样间隔(秒)
const TRAIL_MAX = 120;         // 轨迹点上限（约 18 秒的行走距离）
const TRAIL_MIN_STEP = 1.2;    // 玩家位移超过该距离才记一个足迹(stud)
const TALK_COOLDOWN = 0.3;     // 对话开启后的按键冷却(秒)：避免触发键立刻翻页
const FACE_LAMBDA = 8;         // 转身平滑
const ACCEL_LAMBDA = 8;        // 起步 / 刹车的速度平滑
const SAY_DEFAULT = 3;         // 「说一句」气泡的默认显示时长(秒)

/* 复用临时量，避免每帧分配 */
const _me = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fv = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

export class NpcSystem {
  /**
   * @param {LevelBuilder} builder  世界构建器（NPC 记录从 byType.get('npc') 取）
   * @param {object} ctx            会话上下文（player / events / session）
   */
  constructor(builder, ctx) {
    this.b = builder;
    this.ctx = ctx || {};
    this.player = this.ctx.player || null;
    this.input = this.ctx.input || (this.player && this.player.input) || null;

    this.list = [];
    for (const rec of (builder.byType.get('npc') || [])) this.list.push(this._state(rec));

    this.trail = [];             // 玩家足迹（旧 → 新）
    this._trailT = 0;
    this.dialog = null;          // { n, g, nodeId, sel, opts } —— 正在进行的对话
    this.say = null;             // { n, text, t } —— 非阻塞的单句气泡
    this._near = null;           // 当前可交互的 NPC
    this._cool = 0;
    this.prompt = '';            // HUD 交互提示（HTML 片段）

    this._dom = null;
    if (this.list.length) this._buildDom();
    // 对话中按 Esc 先关对话、不弹暂停菜单：捕获阶段截断（见 app.js 的 window keydown）
    this._onKeyDown = (e) => {
      if (!this.dialog) return;
      let used = true;
      if (e.code === 'Escape') this._close();
      else if (e.code === 'ArrowUp') this._moveSel(-1);
      else if (e.code === 'ArrowDown') this._moveSel(1);
      else if (/^(Digit|Numpad)[1-8]$/.test(e.code)) this._pick(Number(e.code.slice(-1)) - 1);
      else if (e.code === 'Space' || e.code === 'Enter') this._advance();
      else used = false;
      if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', this._onKeyDown, true);
  }

  /* ============================================================
     每帧
     ============================================================ */
  update(dt, p) {
    this._cool = Math.max(0, this._cool - dt);
    if (this.say) {
      this.say.t -= dt;
      if (this.say.t <= 0) { this.say = null; this._syncSay(); }
    }
    if (this.b.editor) return;                     // 编辑器里 NPC 只是静态展示
    const player = p || this.player;
    this._syncList();                              // 事件动态生成 / 删除的 NPC 也要纳入本帧

    if (this.dialog) {
      if (!player || !player.alive) this._close();
      else this._updateInput();
    }

    this._sampleTrail(dt, player);
    for (const n of this.list) {
      try { this._tick(dt, n, player); } catch (e) { /* 单个 NPC 出错不拖垮整帧 */ }
    }
    this._updateInteract(player);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown, true);
    this._close();
    if (this._dom && this._dom.root.parentNode) this._dom.root.parentNode.removeChild(this._dom.root);
    if (this._dom && this._dom.sayRoot && this._dom.sayRoot.parentNode) this._dom.sayRoot.parentNode.removeChild(this._dom.sayRoot);
    this._dom = null;
    this.list.length = 0;
    this.trail.length = 0;
    this.say = null;
    this.prompt = '';
  }

  /* ============================================================
     单个 NPC
     ============================================================ */
  _state(rec) {
    const o = rec.o;
    return {
      rec, o,
      phase: Math.random() * Math.PI * 2,   // 动画相位（错开，避免整齐划一）
      pi: 0,                                 // 巡逻：当前目标路径点下标
      done: false,                           // 巡逻：走到终点且不循环
      talked: false,                         // 是否已经对话过（talkRepeat=false 用）
      inRange: false,                        // 当前是否在交互范围内
      autoArmed: true,                       // 自动对话的边沿触发标记（离开范围后重新武装）
      yaw: deg2rad((o.rotation && o.rotation[1]) || 0),
      speed: 0,                              // 当前移动速度(stud/s)：驱动动画
      _ov: {},                               // 运行时覆盖（事件动作写入，不落库）
      _graph: null,                          // 对话图缓存（运行时数据静态，缓存安全）
    };
  }

  /** 该 NPC 的对话图（缓存） */
  _g(n) {
    if (!n._graph) n._graph = normalizeDialogue(n.o.dialogue);
    return n._graph;
  }

  /**
   * 列表对齐：关卡里可能由事件动态生成 / 删除 NPC（cloneObject / spawn / 销毁），
   * 构建器的记录表会变，这里的列表必须跟着变 —— 否则新生成的 NPC 不参与行为与交互，
   * npcTalk / npcMoveTo 等事件动作也查不到它。已存在的状态对象复用，避免重置行为进度。
   */
  _syncList() {
    const recs = this.b.byType.get('npc') || [];
    if (recs.length === this.list.length) {
      let same = true;
      for (let i = 0; i < recs.length; i++) { if (this.list[i].rec !== recs[i]) { same = false; break; } }
      if (same) return;
    }
    const byRec = new Map(this.list.map((n) => [n.rec, n]));
    this.list = recs.map((rec) => byRec.get(rec) || this._state(rec));
  }

  /* ============================================================
     父级空间换算
     NPC 可能被挂成别的对象（编组 / 子集）的子级：此时 mesh.position / rotation
     是「父级局部」的，而行为逻辑里的目标点 / 玩家位置都是世界坐标。
     直接用 matrixWorld 取世界量会踩两个坑：
       1) mesh.rotation.y 写的是局部角，若把「世界朝向角」直接写进去，
          父级一旦带旋转就会转两次（转过头）；
       2) 世界坐标位移直接加到 mesh.position 上会移两次（移过头）。
     所以：读世界坐标 → 换算到父级局部方向后再写回 mesh。
     ============================================================ */

  /**
   * NPC 的「玩法空间」世界坐标。
   * 镜像地图里整张场景被 x 取反（scene.scale.x = -1），matrixWorld 是镜像空间的，
   * 而关卡数据 / 物理 / 玩家都在原空间，必须换回来才能一起比较（同 builder.updateBillboards）。
   */
  _worldPos(mesh, out) {
    mesh.getWorldPosition(out);
    if (this.b.mirror) out.x = -out.x;   // 渲染空间 → 玩法空间
    return out;
  }

  /**
   * 把「玩法空间的世界方向」换算成「NPC 父级的局部方向」（就地修改 dir 并归一化）。
   * 父级用 playMatrix 取原空间世界矩阵（镜像局里 matrixWorld 带镜像，直接用会把方向左右颠倒）。
   */
  _dirToLocal(mesh, dir) {
    const parent = mesh.parent;
    if (!parent) return dir;
    parent.updateWorldMatrix(true, false);
    _m4.copy(playMatrix(parent, this.b.mirror, _m4)).invert();
    return dir.transformDirection(_m4);
  }

  /**
   * 由「NPC → 目标点」的世界方向算出朝向角（已换算到父级局部空间，父级带旋转也不会转过头）。
   * 取不到方向（重合）时返回 null。
   */
  _faceYawAt(mesh, tx, tz, from) {
    _fv.set(tx - from.x, 0, tz - from.z);
    if (_fv.lengthSq() < 1e-8) return null;
    this._dirToLocal(mesh, _fv);
    return Math.atan2(_fv.x, _fv.z);
  }

  _tick(dt, n, player) {
    const rec = n.rec;
    const o = n.o;
    const mesh = rec.mesh;
    if (!mesh) return;
    const ov = n._ov;
    // 可见性 / 冻结：事件动作可临时覆盖
    mesh.visible = ov.visible !== undefined ? ov.visible : (o.visible !== false);

    const talking = !!(this.dialog && this.dialog.n === n);
    const frozen = ov.frozen !== undefined ? !!ov.frozen : !!o.frozen;
    // 冻结 / 对话中 / 玩家死了 / 已被事件停住：原地待命（仍播放呼吸动画）
    const idle = frozen || talking || !player || !player.alive;
    const beh = ov.behavior || o.behavior || 'idle';
    const base = Math.max(0.5, ov.speed != null ? ov.speed : (Number(o.speed) || 6));

    let move = 0;              // 目标速度
    let walkDir = null;        // 世界空间（玩法空间）移动方向
    let faceYaw = null;        // 目标朝向（父级局部角）
    let hasBp = false;

    if (!idle) {
      this._worldPos(mesh, _me);
      const bp = player.body && player.body.position;
      let dist = Infinity;
      if (bp) { hasBp = true; _pp.set(bp.x, bp.y, bp.z); dist = _me.distanceTo(_pp); }

      if (ov.target) {
        /* 事件指定的移动目标（优先于行为模式，走到就自动清除） */
        const t = ov.target;
        _tgt.set(Number(t[0]) || 0, Number(t[1]) || 0, Number(t[2]) || 0);
        const dd = _me.distanceTo(_tgt);
        if (dd <= 0.9) ov.target = null;
        else {
          _dir.subVectors(_tgt, _me).multiplyScalar(1 / dd);
          move = (ov.moveSpeed != null ? Math.max(0.5, ov.moveSpeed) : base) * clamp(dd / 2.5, 0.2, 1);
          walkDir = _dir;
        }
      } else if (hasBp && !ov.halt && beh === 'follow') {
        const keep = Math.max(0.5, ov.followDist != null ? ov.followDist : (Number(o.followDist) || 7));
        const runAt = Math.max(keep, Number(o.followRun) || 18);
        if (dist > keep) {
          // 目标 = 玩家轨迹上「距玩家 keep 距离」的那一点 → 走玩家走过的路并保持距离
          const tgt = this._trailPoint(keep + 1.5, _pp, _tgt);
          const dirV = _dir.copy(tgt || _pp).sub(_me);
          const dd = dirV.length();
          if (dd > 0.05) {
            dirV.multiplyScalar(1 / dd);
            move = (dist > runAt ? base * 1.75 : base) * clamp(dd / 2.5, 0.2, 1);
            walkDir = dirV;
          }
        } else if (o.facePlayer !== false) {
          faceYaw = this._faceYawAt(mesh, _pp.x, _pp.z, _me);
        }
      } else if (!ov.halt && beh === 'patrol') {
        const wps = Array.isArray(o.waypoints) ? o.waypoints : [];
        if (!n.done && wps.length >= 2) {
          const tp = wps[clamp(Math.round(n.pi) || 0, 0, wps.length - 1)] || [0, 0, 0];
          _tgt.set(Number(tp[0]) || 0, Number(tp[1]) || 0, Number(tp[2]) || 0);
          const dirV = _dir.copy(_tgt).sub(_me);
          const dd = dirV.length();
          if (dd <= 0.8) {
            // 到达路径点 → 下一个（终点且不循环则停下）
            if (n.pi >= wps.length - 1 && o.patrolLoop === false) n.done = true;
            else { n.pi = n.pi >= wps.length - 1 ? 0 : n.pi + 1; }
          } else {
            dirV.multiplyScalar(1 / dd);
            move = base * clamp(dd / 2.5, 0.2, 1);
            walkDir = dirV;
          }
        }
      }

      // 朝向覆盖（事件动作的「面向玩家 / 面向坐标」）
      if (ov.facePlayer && hasBp) faceYaw = this._faceYawAt(mesh, _pp.x, _pp.z, _me);
      else if (ov.facePoint) faceYaw = this._faceYawAt(mesh, ov.facePoint[0], ov.facePoint[2], _me);
    }

    // 移动（NPC 没有物理体，直接摆位置；方向必须先换算到父级局部空间，否则会「移过头」）
    if (walkDir && move > 0.01) {
      n.speed = damp(n.speed, move, ACCEL_LAMBDA, dt);
      _fv.copy(walkDir);
      this._dirToLocal(mesh, _fv);
      mesh.position.addScaledVector(_fv, n.speed * dt);
      faceYaw = Math.atan2(_fv.x, _fv.z);          // 局部方向 → 局部朝向
    } else {
      n.speed = damp(n.speed, 0, ACCEL_LAMBDA * 1.4, dt);
    }

    // 朝向
    if (faceYaw !== null && isFinite(faceYaw)) {
      let d = faceYaw - n.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      n.yaw += d * Math.min(1, dt * FACE_LAMBDA);
    }
    mesh.rotation.y = n.yaw;

    this._animate(dt, n, rec);
  }

  /** 姿态：导入模型交给动画状态机，内置 R6 走程序化摆臂摆腿 */
  _animate(dt, n, rec) {
    const av = rec.npcAvatar;
    if (av && av.active) {
      // 事件动作指定的动画名：直接锁定播放，直到再次设置为空
      const forced = n._ov.forceClip;
      if (forced) {
        if (av.mixer) av.mixer.update(dt);
        if (typeof av._play === 'function') av._play(forced, 0.18);
        return;
      }
      av.update(dt, { speed: n.speed, vy: 0, grounded: true, alive: true });
      return;
    }
    const rig = rec.npcR6;
    if (!rig) return;
    if (n.speed > 0.4) {
      n.phase += dt * (1.2 + n.speed * 0.42);
      const amp = clamp(n.speed / 22, 0, 1) * 0.95;
      const sw = Math.sin(n.phase * 2) * amp;
      rig.armL.rotation.x = sw; rig.armR.rotation.x = -sw;
      rig.legL.rotation.x = sw; rig.legR.rotation.x = -sw;
    } else {
      n.phase += dt * 1.4;
      const b = Math.sin(n.phase) * 0.05;         // 待机呼吸
      rig.armL.rotation.x = damp(rig.armL.rotation.x, b, 6, dt);
      rig.armR.rotation.x = damp(rig.armR.rotation.x, -b, 6, dt);
      rig.legL.rotation.x = damp(rig.legL.rotation.x, 0, 8, dt);
      rig.legR.rotation.x = damp(rig.legR.rotation.x, 0, 8, dt);
    }
    rig.head.rotation.y = 0;
  }

  /* ============================================================
     玩家足迹（跟随用）
     ============================================================ */
  _needTrail() {
    for (const n of this.list) {
      if (n._ov.frozen === true || n.o.frozen) continue;
      if (n._ov.target) return true;
      if ((n._ov.behavior || n.o.behavior || 'idle') === 'follow') return true;
    }
    return false;
  }

  _sampleTrail(dt, p) {
    if (!this._needTrail()) { if (this.trail.length) this.trail.length = 0; return; }
    const f = p && p.feetPos;
    if (!f) return;
    this._trailT += dt;
    if (this._trailT < TRAIL_INTERVAL) return;
    this._trailT = 0;
    const last = this.trail[this.trail.length - 1];
    if (last && last.distanceToSquared(f) < TRAIL_MIN_STEP * TRAIL_MIN_STEP) return;
    this.trail.push(f.clone());
    while (this.trail.length > TRAIL_MAX) this.trail.shift();
  }

  /**
   * 沿「玩家当前位置 → 足迹（新→旧）」回溯 dist 距离的点。
   * 足迹本身就是玩家走过的落脚点，所以这个点一定在可行走的位置上，
   * NPC 朝它走 = 沿着玩家的路线跟上，且与玩家保持 dist 左右的距离。
   * 还取不到（刚开场 / 玩家没怎么移动）时返回 null，调用方退化为「直接走向玩家」。
   */
  _trailPoint(dist, head, out) {
    let prev = head;
    let acc = 0;
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const pt = this.trail[i];
      const seg = prev.distanceTo(pt);
      if (seg < 1e-3) continue;
      if (acc + seg >= dist) return out.copy(prev).lerp(pt, (dist - acc) / seg);
      acc += seg;
      prev = pt;
    }
    return null;
  }

  /* ============================================================
     交互 + 对话
     ============================================================ */
  _canTalk(n) {
    if (n.o.talkRepeat === false && n.talked) return false;
    return !!(n.o.onTalk || this._g(n).nodes.length);
  }

  _updateInteract(p) {
    if (this.dialog || !p || !p.alive || !(p.body && p.body.position)) {
      this.prompt = '';
      this._near = null;
      // 离开交互状态 → 自动对话重新武装，下次靠近还能触发
      for (const n of this.list) { n.inRange = false; n.autoArmed = true; }
      return;
    }
    const bp = p.body.position;
    _pp.set(bp.x, bp.y, bp.z);

    let best = null;
    let bestD = Infinity;
    for (const n of this.list) {
      const mesh = n.rec.mesh;
      if (!mesh || !mesh.visible || !this._canTalk(n)) continue;
      this._worldPos(mesh, _me);
      const d = _me.distanceTo(_pp);
      const r = Math.max(1, Number(n.o.interactRange) || 8);
      if (d <= r && d < bestD) { best = n; bestD = d; }
    }

    for (const n of this.list) {
      n.inRange = (n === best);
      if (n !== best) n.autoArmed = true;      // 离开范围 → 重新武装自动对话
    }

    this._near = best;
    if (!best) { this.prompt = ''; return; }
    const label = best.o.promptText || '交谈';
    const name = best.o.name || best.o.speakerName || 'NPC';
    this.prompt = `<b>${escapeHtml(label)}</b> · ${escapeHtml(name)}`;

    // 自动对话：进入范围的瞬间触发一次
    if (best.o.autoTalk === true) {
      if (best.autoArmed) { best.autoArmed = false; this._talk(best); }
      return;
    }
    if (this._cool > 0 || !this.input) return;
    const key = best.o.interactKey || 'Mouse0';
    const pressed = key.startsWith('Mouse')
      ? this.input.mousePressed(Number(key.slice(5)) || 0)
      : this.input.keyPressed(key);
    if (pressed) this._talk(best);
  }

  /** 开始对话；nodeId 为空 = 从对话图入口节点开始 */
  _talk(n, nodeId) {
    const o = n.o;
    if (o.talkRepeat === false && n.talked) return false;
    n.talked = true;
    this._cool = TALK_COOLDOWN;

    // 触发关卡事件（可用于开门 / 给道具 / 播音效…）
    const ev = this.ctx.events || (this.ctx.session && this.ctx.session.events);
    if (o.onTalk && ev) {
      try { ev.emit(o.onTalk, { objectId: n.rec.id, object: o }); } catch (e) { /* ignore */ }
    }

    const g = this._g(n);
    const start = (nodeId && g.nodes.some((x) => x.id === nodeId)) ? nodeId : g.entry;
    if (!g.nodes.length || !start) return false;
    if (!this._dom) this._buildDom();       // 运行时生成的 NPC 也保证有对话框
    this.dialog = { n, g, nodeId: start, sel: 0, opts: [] };
    this.say = null;
    this._syncSay();
    this.prompt = '';
    if (this.player) this.player.setInputFrozen(true);
    this._showNode();
    return true;
  }

  _node(id) {
    const d = this.dialog;
    return d ? (d.g.nodes.find((x) => x.id === id) || null) : null;
  }

  /** 变量真假（分支选项 cond 用；空 = 总是显示） */
  _truthy(name) {
    if (!name) return true;
    const ev = this.ctx.events || (this.ctx.session && this.ctx.session.events);
    const v = ev ? ev.getVar(name, 0) : 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v !== '' && v !== '0' && v !== 'false';
    return !!Number(v);
  }

  _showNode() {
    const d = this.dialog;
    if (!d || !this._dom) return;
    const node = this._node(d.nodeId);
    if (!node) { this._close(); return; }
    const o = d.n.o;
    const who = node.speaker || o.speakerName || o.name || '';
    this._dom.name.textContent = who;
    this._dom.name.style.display = who ? '' : 'none';
    this._dom.text.textContent = node.text || '';

    /* 分支选项：按变量条件过滤后列出 */
    d.opts = node.choices.filter((c) => !c.cond || this._truthy(c.cond));
    if (d.sel >= d.opts.length) d.sel = 0;
    const box = this._dom.opts;
    while (box.firstChild) box.removeChild(box.firstChild);
    d.opts.forEach((c, i) => {
      box.appendChild(this._optEl(c, i));
    });
    box.style.display = d.opts.length ? '' : 'none';
    this._dom.hint.textContent = d.opts.length
      ? '\u2191\u2193 / 1-8 选择 · 左键点击 · Esc 结束'
      : '左键 / 空格 继续 · Esc 结束';
    this._dom.idx.textContent = '';
    this._syncOptSel();
    this._dom.root.classList.remove('hidden');
  }

  _optEl(c, i) {
    const b = document.createElement('div');
    b.className = 'npcd-opt';
    b.dataset.i = String(i);
    const num = document.createElement('span');
    num.className = 'npcd-optn';
    num.textContent = String(i + 1);
    const t = document.createElement('span');
    t.className = 'npcd-optt';
    t.textContent = c.text || '';
    b.appendChild(num); b.appendChild(t);
    b.addEventListener('click', (e) => { e.stopPropagation(); if (this._cool <= 0) this._pick(i); });
    return b;
  }

  _syncOptSel() {
    const d = this.dialog;
    if (!d || !this._dom) return;
    const kids = this._dom.opts.children;
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('on', i === d.sel);
  }

  _moveSel(dir) {
    const d = this.dialog;
    if (!d || !d.opts.length) return;
    d.sel = (d.sel + dir + d.opts.length) % d.opts.length;
    this._syncOptSel();
  }

  _pick(i) {
    const d = this.dialog;
    if (!d || i < 0 || i >= d.opts.length) return;
    d.sel = i;
    this._goto(d.opts[i].to);
  }

  _advance() {
    const d = this.dialog;
    if (!d) return;
    if (d.opts.length) { const c = d.opts[d.sel]; this._goto(c ? c.to : ''); return; }
    const node = this._node(d.nodeId);
    this._goto(node ? node.next : '');
  }

  _goto(nodeId) {
    const d = this.dialog;
    if (!d) return;
    if (!nodeId || !d.g.nodes.some((x) => x.id === nodeId)) { this._close(); return; }
    d.nodeId = nodeId;
    d.sel = 0;
    this._showNode();
  }

  _close() {
    const had = !!this.dialog;
    this.dialog = null;
    if (this._dom) {
      this._dom.root.classList.add('hidden');
      while (this._dom.opts.firstChild) this._dom.opts.removeChild(this._dom.opts.firstChild);
    }
    if (!had) return;
    if (this.player) this.player.setInputFrozen(false);
    this._cool = TALK_COOLDOWN;
  }

  /** 对话期间：指针未锁定时鼠标左键也可翻页（键盘已在捕获阶段处理） */
  _updateInput() {
    if (!this.input || this._cool > 0) return;
    if (this.input.mousePressed(0)) this._advance();
  }

  /* ============================================================
     事件动作接口（由 EventRuntime 调用）
     ============================================================ */
  byId(id) {
    const s = String(id ?? '').trim();
    if (!s) return null;
    return this.list.find((n) => n.rec.id === s || n.o.id === s) || null;
  }

  setBehavior(id, beh) {
    const n = this.byId(id);
    if (!n) return false;
    n._ov.behavior = (beh === 'follow' || beh === 'patrol') ? beh : 'idle';
    n._ov.halt = false;
    n._ov.target = null;
    n.done = false;
    n.pi = 0;
    return true;
  }

  setSpeed(id, v) { const n = this.byId(id); if (!n) return false; n._ov.speed = Math.max(0.5, Number(v) || 6); return true; }
  setKeepDist(id, v) { const n = this.byId(id); if (!n) return false; n._ov.followDist = Math.max(0.5, Number(v) || 7); return true; }
  setFrozen(id, on) { const n = this.byId(id); if (!n) return false; n._ov.frozen = !!on; return true; }
  setVisible(id, on) { const n = this.byId(id); if (!n) return false; n._ov.visible = !!on; return true; }

  /** 停止移动（保持当前行为模式，但不再主动走动） */
  stop(id) {
    const n = this.byId(id);
    if (!n) return false;
    n._ov.halt = true;
    n._ov.target = null;
    n.done = true;
    return true;
  }

  /** 走向世界坐标（speed 为 null 用 NPC 自身速度） */
  moveTo(id, vec, speed) {
    const n = this.byId(id);
    if (!n || !Array.isArray(vec)) return false;
    n._ov.halt = false;
    n._ov.target = [Number(vec[0]) || 0, Number(vec[1]) || 0, Number(vec[2]) || 0];
    n._ov.moveSpeed = speed != null ? Math.max(0.5, Number(speed) || 6) : null;
    return true;
  }

  /** 传送（立即到位；自动换算到父级空间） */
  warp(id, vec) {
    const n = this.byId(id);
    if (!n || !Array.isArray(vec)) return false;
    const mesh = n.rec.mesh;
    if (!mesh) return false;
    const p = new THREE.Vector3(Number(vec[0]) || 0, Number(vec[1]) || 0, Number(vec[2]) || 0);
    const parent = mesh.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      _m4.copy(playMatrix(parent, this.b.mirror, _m4)).invert();
      p.applyMatrix4(_m4);
    }
    mesh.position.copy(p);
    n._ov.target = null;
    return true;
  }

  /** 传送到玩家附近（默认落在「玩家 → 该 NPC」的延长线上，距离 dist） */
  warpNearPlayer(id, dist) {
    const n = this.byId(id);
    if (!n) return false;
    const p = this.player;
    const bp = p && p.body && p.body.position;
    if (!bp) return false;
    const d = Math.max(1, Number(dist) || 6);
    const mesh = n.rec.mesh;
    const from = new THREE.Vector3(bp.x, bp.y, bp.z);
    let dir = new THREE.Vector3();
    if (mesh) { this._worldPos(mesh, _me); dir.set(_me.x - bp.x, 0, _me.z - bp.z); }
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    return this.warp(id, [from.x + dir.x * d, from.y, from.z + dir.z * d]);
  }

  lookAtPlayer(id) {
    const n = this.byId(id);
    if (!n) return false;
    n._ov.facePlayer = true;
    n._ov.facePoint = null;
    return true;
  }

  lookAtPoint(id, vec) {
    const n = this.byId(id);
    if (!n || !Array.isArray(vec)) return false;
    n._ov.facePoint = [Number(vec[0]) || 0, Number(vec[1]) || 0, Number(vec[2]) || 0];
    n._ov.facePlayer = false;
    return true;
  }

  /** 播放导入模型的动画片段（空字符串 = 恢复自动状态机；内置 R6 无片段，忽略） */
  playClip(id, name) {
    const n = this.byId(id);
    if (!n) return false;
    n._ov.forceClip = String(name || '').slice(0, 60);
    return true;
  }

  /** 开始一次对话（nodeId 空 = 入口节点）；已在对话中则不打断 */
  startDialogue(id, nodeId) {
    const n = this.byId(id);
    if (!n || this.dialog) return false;
    return this._talk(n, nodeId || '');
  }

  /** 某个 NPC（不传 id = 任意 NPC）是否正在对话 */
  isTalking(id) {
    if (!this.dialog) return false;
    if (!id) return true;
    const n = this.byId(id);
    return !!n && this.dialog.n === n;
  }

  /** NPC 说一句（非阻塞气泡；阻塞对话进行中会被忽略） */
  say(id, text, speaker, sec) {
    const n = this.byId(id);
    if (!n) return false;
    if (this.dialog) return false;
    const body = String(text ?? '');
    if (!body) return false;
    if (!this._dom) this._buildDom();
    this.say = {
      n,
      speaker: String(speaker || '').slice(0, 40),
      text: body.slice(0, 300),
      t: Math.max(0.4, Number(sec) || SAY_DEFAULT),
    };
    this._syncSay();
    return true;
  }

  /** NPC 的世界坐标 [x, y, z]（玩法空间，与物理 / 关卡数据一致） */
  posOf(id) {
    const n = this.byId(id);
    const mesh = n && n.rec.mesh;
    if (!mesh) return [0, 0, 0];
    this._worldPos(mesh, _me);
    return [_me.x, _me.y, _me.z];
  }

  /** NPC 与玩家的距离（stud） */
  distToPlayer(id) {
    const n = this.byId(id);
    const mesh = n && n.rec.mesh;
    const bp = this.player && this.player.body && this.player.body.position;
    if (!mesh || !bp) return -1;
    this._worldPos(mesh, _me);
    return _me.distanceTo(_pp.set(bp.x, bp.y, bp.z));
  }

  /* ---------- 对话 UI（自建覆盖层，不侵入 HUD） ---------- */
  _buildDom() {
    const root = document.createElement('div');
    root.id = 'npc-dialog';
    root.className = 'hidden';
    const box = document.createElement('div');
    box.className = 'npcd-box';
    const name = document.createElement('div');
    name.className = 'npcd-name';
    const text = document.createElement('div');
    text.className = 'npcd-text';
    const opts = document.createElement('div');
    opts.className = 'npcd-opts';
    const foot = document.createElement('div');
    foot.className = 'npcd-foot';
    const hint = document.createElement('span');
    hint.className = 'npcd-hint';
    hint.textContent = '左键 / 空格 继续 · Esc 结束';
    const idx = document.createElement('span');
    idx.className = 'npcd-idx';
    foot.appendChild(hint); foot.appendChild(idx);
    box.appendChild(name); box.appendChild(text); box.appendChild(opts); box.appendChild(foot);
    root.appendChild(box);
    // 点击对话框空白处也能翻页（指针锁定时鼠标不可用，这里只是兜底）
    root.addEventListener('click', () => {
      if (this._cool > 0 || !this.dialog) return;
      if (this.dialog.opts.length) return;      // 有选项时必须点选项
      this._advance();
    });
    document.body.appendChild(root);

    /* 单句气泡（事件动作「NPC 说一句」） */
    const sayRoot = document.createElement('div');
    sayRoot.id = 'npc-say';
    sayRoot.className = 'hidden';
    const sbox = document.createElement('div');
    sbox.className = 'npcs-box';
    const sname = document.createElement('div');
    sname.className = 'npcs-name';
    const stext = document.createElement('div');
    stext.className = 'npcs-text';
    sbox.appendChild(sname); sbox.appendChild(stext);
    sayRoot.appendChild(sbox);
    document.body.appendChild(sayRoot);

    this._dom = { root, name, text, opts, hint, idx, sayRoot, sayName: sname, sayText: stext };
  }

  _syncSay() {
    if (!this._dom) return;
    const s = this.say;
    if (!s) { this._dom.sayRoot.classList.add('hidden'); return; }
    const who = s.speaker || s.n.o.speakerName || s.n.o.name || '';
    this._dom.sayName.textContent = who;
    this._dom.sayName.style.display = who ? '' : 'none';
    this._dom.sayText.textContent = s.text;
    this._dom.sayRoot.classList.remove('hidden');
  }
}
