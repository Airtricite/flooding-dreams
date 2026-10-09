/* ============================================================
   云端卧室大厅：悬浮在云层之上的房间，玩家可自由走动
   走到发光传送门（或点击底部“关卡”）即打开关卡选择
   ============================================================ */
import * as THREE from 'three';
import { createEmptyLevel } from '../world/level.js';
import { createObject } from '../world/objectTypes.js';
import { createEvent, createAction, createAnimation, createTrack } from '../world/events.js';
import { LevelSession } from './session.js';

const T = 2.5;

function add(L, type, over) { const o = createObject(type, over); L.objects.push(o); return o; }
function box(L, over) { return add(L, 'mesh', { shape: 'block', ...over }); }
function plat(L, x, topY, z, w, d, over = {}) {
  return box(L, { position: [x, topY - T / 2, z], scale: [w, T, d], color: over.color || '#cfc6ea', ...over });
}
function wall(L, x, y, z, w, h, d, over = {}) {
  return box(L, { position: [x, y, z], scale: [w, h, d], color: over.color || '#a99ed0', ...over });
}
function cloud(L, x, y, z, s = 30, over = {}) {
  return box(L, {
    position: [x, y, z], scale: [s, s * 0.4, s * 0.72], color: '#f3ecff', texture: 'cloud',
    textureSize: 2, transparency: 0.22, castShadow: false, physicsMode: 'none', ...over,
  });
}
function light(L, x, y, z, over = {}) {
  return add(L, 'light', { position: [x, y, z], intensity: 1.4, distance: 180, ...over });
}
function anim(L, name, duration, tracks, over = {}) {
  const a = createAnimation(name);
  a.duration = duration;
  Object.assign(a, over);
  a.tracks = tracks.map((t) => {
    const tr = createTrack(t.objectId);
    tr.property = t.property;
    tr.type = t.type || (['position', 'rotation', 'scale'].includes(t.property) ? 'vec3' : 'number');
    tr.keys = t.keys.map((k) => ({ t: k[0], v: k[1], easing: k[2] || 'easeInOut' }));
    return tr;
  });
  L.animations.push(a);
  return a;
}

/* ============================================================
   大厅关卡数据
   ============================================================ */
export function makeHallLevel() {
  const L = createEmptyLevel({
    id: 'hall', name: '云端卧室', difficulty: 1,
    description: '梦开始的地方。',
  });
  L.author = '洪梦';
  L.settings.objective = '';
  L.settings.oxygenRegen = 30;
  L.settings.deathLimit = 0;
  L.settings.timeLimit = 0;      // 大厅是休息区：不受关卡时长限制
  L.settings.fog.color = '#a99ee0';
  L.settings.fog.near = 220;
  L.settings.fog.far = 1600;
  L.settings.ambient.color = '#cfc0f0';
  L.settings.ambient.intensity = 0.85;
  L.settings.sun.intensity = 1.25;
  L.settings.voidY = -400;

  /* ---------- 房间结构 ---------- */
  plat(L, 0, 0, 0, 46, 46, { color: '#d6ccec', texture: 'carpet', textureSize: 9 });
  // 后墙与侧墙（正面敞开，望向云海）
  wall(L, 0, 13, -23, 48, 30, 2, { color: '#b3a8d8', texture: 'bricks', textureSize: 4 });
  wall(L, -23, 13, 0, 2, 30, 48, { color: '#b3a8d8', texture: 'bricks', textureSize: 4 });
  wall(L, 23, 13, 0, 2, 30, 48, { color: '#b3a8d8', texture: 'bricks', textureSize: 4 });
  // 前侧窗框
  wall(L, 0, 2, 23, 48, 3, 2, { color: '#8f83b8' });
  wall(L, 0, 24, 23, 48, 3, 2, { color: '#8f83b8' });
  wall(L, -16, 13, 23, 3, 26, 2, { color: '#8f83b8' });
  wall(L, 16, 13, 23, 3, 26, 2, { color: '#8f83b8' });

  // 地毯
  box(L, {
    position: [0, 0.1, 2], scale: [26, 0.14, 20], color: '#a08cff', texture: 'checker',
    textureSize: 5, castShadow: false, physicsMode: 'none', name: '地毯',
  });

  // 床
  box(L, { position: [-14, 1.6, -12], scale: [14, 3.2, 18], color: '#b9a9ea', name: '床架' });
  box(L, { position: [-14, 3.6, -12], scale: [12.4, 1.6, 16.4], color: '#fff3c4', name: '床垫' });
  box(L, { position: [-14, 5.2, -12], scale: [12.4, 1.6, 1.2], color: '#c9b7a0', name: '床头' });
  box(L, { position: [-14, 4.8, -17], scale: [8, 1.8, 3.4], color: '#ffd98a', name: '枕头' });
  box(L, {
    position: [-14, 4.7, -7], scale: [13, 1.5, 9], color: '#ff7fd0',
    transparency: 0.12, name: '被子',
  });

  // 书桌 + 椅子 + 台灯
  box(L, { position: [14, 2.4, -18], scale: [16, 4.8, 6], color: '#cbbfe6', name: '书桌' });
  box(L, { position: [14, 5.6, -18], scale: [10, 4.6, 0.6], color: '#7fe3ff', metalness: 0.5, name: '显示器' });
  box(L, { position: [14, 5.4, -14], scale: [3, 1.2, 3], color: '#ffd98a', name: '键盘' });
  box(L, { position: [8, 6.4, -19], scale: [3, 6, 3], color: '#ffa06b', name: '台灯' });
  box(L, { position: [14, 2.6, -10], scale: [5, 5.2, 5], color: '#ffa06b', name: '椅子', anchored: true });

  // 书架
  box(L, { position: [-20, 11, -20], scale: [7, 22, 5], color: '#8a6ea8', name: '书架' });
  for (let i = 0; i < 3; i++) {
    box(L, {
      position: [-20, 4 + i * 7, -17.2], scale: [6.4, 5.4, 1.2],
      color: ['#ff7fd0', '#7fe3ff', '#8ef5c8'][i], name: '书 ' + (i + 1),
    });
  }
  plat(L, 0, 20, -23, 40, 6, { color: '#bfb3e0', name: '墙架' });
  box(L, { position: [-6, 22, -23], scale: [8, 4, 3], color: '#ff9fb2', shape: 'torus', name: '挂饰' });
  box(L, { position: [6, 22.5, -23], scale: [6, 6, 3], color: '#7fe3ff', shape: 'sphere', name: '星球挂件' });

  // 天花板吊环灯
  for (let i = 0; i < 3; i++) {
    const ring = box(L, {
      position: [-12 + i * 12, 27, 0], scale: [7, 7, 7], color: '#fff3c4', shape: 'torus',
      emissive: '#fff3c4', emissiveIntensity: 1.6, castShadow: false, physicsMode: 'none',
      name: '吊环灯 ' + (i + 1),
    });
    void ring;
    light(L, -12 + i * 12, 26, 0, { color: '#fff3c4', intensity: 1.5, distance: 120 });
  }

  // 悬浮的传送门（终点物件 → 触发关卡选择）
  const portal = add(L, 'goal', {
    position: [0, 6, 10], scale: [10, 14, 10], color: '#ffd98a', transparency: 0.7,
    emissive: '#ffd98a', emissiveIntensity: 2.6, name: '梦境传送门',
  });
  add(L, 'spawn', { position: [0, 2, -14], name: '起点' });
  // 传送门底座
  box(L, { position: [0, 0.5, 10], scale: [12, 1, 12], color: '#ffd98a', metalness: 0.4, name: '传送门底座' });

  /* ---------- 窗外云海 ---------- */
  cloud(L, 0, -14, 60, 70);
  cloud(L, -60, -6, 46, 46);
  cloud(L, 62, 2, 40, 40);
  cloud(L, -30, 22, 96, 36);
  cloud(L, 40, 18, 110, 44);
  cloud(L, 0, 30, 150, 60, { transparency: 0.16 });
  // 远处漂浮的梦之物
  box(L, { position: [-46, 26, 66], scale: [14, 14, 14], color: '#ff7fd0', shape: 'sphere', physicsMode: 'none', castShadow: false, transparency: 0.25 });
  box(L, { position: [52, 34, 84], scale: [20, 20, 20], color: '#7fe3ff', shape: 'torus', physicsMode: 'none', castShadow: false, transparency: 0.3 });
  box(L, { position: [22, -2, 120], scale: [26, 26, 26], color: '#8ef5c8', shape: 'prism', sides: 3, physicsMode: 'none', castShadow: false, transparency: 0.28 });
  light(L, 0, 40, 90, { color: '#cfc0ff', intensity: 1.2, distance: 400 });

  /* ---------- 动画：传送门旋转 + 吊环浮动 ---------- */
  const spin = anim(L, '传送门旋转', 12, [
    { objectId: portal.id, property: 'rotation', keys: [[0, [0, 0, 0]], [12, [0, 360, 0]]] },
  ], { loop: true, autoplay: true });
  void spin;

  /* ---------- 事件 ---------- */
  const evPortal = createEvent('进入传送门');
  evPortal.trigger = {
    type: 'playerTouch', objectId: portal.id, time: 1, repeat: false,
    value: 0, varName: '', op: '==', once: true,
  };
  evPortal.actions = [
    Object.assign(createAction('playSound'), { sound: 'door' }),
    Object.assign(createAction('spawnEffect'), { effect: 'sparkle', vec: [0, 8, 10], time: 1.2 }),
    Object.assign(createAction('wait'), { time: 0.35 }),
  ];
  L.events.push(evPortal);
  portal.onTouch = evPortal.id;
  return L;
}

/* ============================================================
   大厅会话
   ============================================================ */
export class Hall {
  constructor(opts = {}) {
    this.engine = opts.engine;
    this.input = opts.input;
    this.onOpenLevels = opts.onOpenLevels || null;
    this.onHint = opts.onHint || null;
    this.level = makeHallLevel();
    this.session = new LevelSession({
      engine: this.engine,
      level: this.level,
      input: this.input,
      hall: true,
      hooks: {
        onWin: () => this._enterPortal(),
        onHint: (t, d) => this.onHint && this.onHint(t, d),
      },
    });
    this.session.player.cameraCtl.yaw = Math.PI;
    this.session.cameraCtl.yaw = Math.PI;
  }

  get player() { return this.session.player; }
  get view() { return this.session.view; }
  get camera() { return this.session.camera; }

  _enterPortal() {
    this.session.status = 'playing';    // 大厅不允许“通关”，只当作交互
    if (this.onOpenLevels) this.onOpenLevels();
  }

  /** 退出选关界面：把玩家送回大厅初始点，避免仍站在传送门里立刻又触发选关 */
  returnToSpawn() {
    const s = this.session;
    s.player.respawn(s.spawn, true);
    s.player.setRespawn(s.spawn, true);
  }

  /** 从关卡返回后重置大厅状态 */
  reset() {
    const s = this.session;
    s.status = 'playing';
    s.time = 0;
    s.deaths = 0;
    s.banner = null;
    s.hint = null;
    s.player.deaths = 0;
    s.player.respawn(s.spawn, true);
    s.player.setRespawn(s.spawn, true);
    s.events.buildIndex();
    s.started = false;      // 下一帧 _begin() 重新触发事件（大厅不倒计时，countdown 恒为 0）
  }

  update(dt) { this.session.update(dt); }
  dispose() { this.session.dispose(); }
}

export { THREE };