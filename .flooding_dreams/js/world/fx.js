/* ============================================================
   粒子特效：水花 / 气泡 / 撞击 / 破坏碎屑 / 拾取光点
   ------------------------------------------------------------
   单批 Points + 自定义着色器，零 GC 压力。

   升级后支持：
     · 多张粒子图像 —— 运行时把所有用到的图像打进一张「纹理图集」，
       每颗粒子用 aTex 记录槽位下标，一次绘制搞定（见 registerImage）
     · 每颗粒子独立的扭曲 / 蒙版动画（aAnim，20 种，见 core/particle-presets.js）
     · 每颗粒子独立的随机种子（aSeed），让同种动画也有差异
     · 寿命 / 淡入淡出全部在着色器里按「年龄」算（aStart + aLife + uTime），
       CPU 只做位置积分 —— 更省、也无每帧 alpha 上传
   ============================================================ */
import * as THREE from 'three';
import { getBubbleSprite, getTexture, ensureTexture, isParticleBuiltin, getParticleSprite } from '../core/textures.js';
import { LIQUID_KINDS } from '../config.js';

/* ---------- 图集参数 ---------- */
const CELL = 128;          // 每个槽位在 atlas 里的边长（像素）
const PAD = 7;             // 槽位内边距：避免相邻槽位在线性采样下互相串色
const MAX_SLOTS = 64;      // 槽位上限（64 → 8×8 图集，1024×1024）
// 图集行列固定为 MAX_SLOTS 的方阵：WebGL2 下 three.js 对 CanvasTexture 走
// texStorage2D（不可增长的显存），一旦画布尺寸变化，后续上传会越界失败 → 贴图错乱 / 白块。
// 因此尺寸恒定，只做一次性分配 + 局部重绘（下标 → 固定格子）。
const ATLAS_COLS = 8;
const ATLAS_ROWS = MAX_SLOTS / ATLAS_COLS;

const VERT = `
attribute float aSize;
attribute float aAlpha;
attribute float aTex;
attribute float aAnim;
attribute float aSeed;
attribute float aStart;
attribute float aLife;
attribute vec3 aColor;
uniform float uTime;
uniform float uCols;
uniform float uRows;
varying float vAlpha;
varying vec3 vColor;
varying float vAnim;
varying float vSeed;
varying float vAge;
varying vec2 vCell;
void main() {
  float age = aLife > 0.001 ? clamp((uTime - aStart) / aLife, 0.0, 1.0) : 1.0;
  float fadeIn = smoothstep(0.0, 0.10, age);
  float fadeOut = 1.0 - smoothstep(0.70, 1.0, age);
  vAlpha = aAlpha * fadeIn * fadeOut;
  vAnim = aAnim;
  vSeed = aSeed;
  vAge = age;
  vColor = aColor;
  vCell = vec2(mod(aTex, uCols), floor(aTex / uCols));
  float sizeK = 1.0;
  if (aAnim > 2.5 && aAnim < 3.5) {          // 心跳：短促起伏
    float b = pow(max(0.0, sin(age * 12.0 + aSeed * 6.2831)), 6.0);
    sizeK = 0.85 + 0.6 * b;
  } else if (aAnim > 1.5 && aAnim < 2.5) {   // 脉动
    sizeK = 0.55 + 0.75 * sin(age * 9.0 + aSeed * 6.2831);
  }
  sizeK = max(0.02, sizeK) * (1.0 - smoothstep(0.92, 1.0, age));
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * sizeK * (300.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform sampler2D uAtlas;
uniform float uCols;
uniform float uRows;
uniform float uPad;
uniform float uSoft;
varying float vAlpha;
varying vec3 vColor;
varying float vAnim;
varying float vSeed;
varying float vAge;
varying vec2 vCell;

float hash(vec2 p) { p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
mat2 rot2(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

void main() {
  vec2 uv = gl_PointCoord;
  vec2 q = uv;
  vec2 cc = uv - 0.5;
  float t = vAge;
  float mask = 1.0;
  float extra = 1.0;
  int A = int(vAnim + 0.5);

  if (A == 1) {                 // 旋转
    q = rot2(t * 6.2831 * (vSeed > 0.5 ? 1.0 : -1.0)) * cc + 0.5;
  } else if (A == 2) {          // 脉动（尺寸在顶点，这里补透明脉动）
    extra = 0.78 + 0.22 * sin(t * 9.0 + vSeed * 6.2831);
  } else if (A == 3) {          // 心跳（尺寸在顶点）
  } else if (A == 4) {          // 波动
    q.x += sin(uv.y * 12.0 + t * 12.0 + vSeed * 6.2831) * 0.06;
  } else if (A == 5) {          // 漩涡
    float ang = (0.5 - length(cc)) * 7.0 * (1.0 - t);
    q = rot2(ang) * cc + 0.5;
  } else if (A == 6) {          // 涟漪
    float r = length(cc);
    float w = sin(r * 28.0 - t * 22.0) * 0.05 * (1.0 - t);
    q = cc * (1.0 + w) + 0.5;
  } else if (A == 7) {          // 噪声溶解
    float n = vnoise(uv * 5.0 + vSeed * 30.0);
    float th = t * 1.15 - 0.05;
    mask = smoothstep(th, th + 0.14, n);
  } else if (A == 8) {          // 边缘腐蚀
    float r = length(cc);
    float e = mix(0.5, 0.02, t);
    mask = 1.0 - smoothstep(e - 0.10, e, r);
  } else if (A == 9) {          // 湍流
    q += (vec2(vnoise(uv * 4.0 + t * 2.0), vnoise(uv * 4.0 - t * 2.0 + 7.0)) - 0.5) * 0.18 * t;
  } else if (A == 10) {         // 像素化
    float px = mix(96.0, 7.0, t);
    q = (floor(uv * px) + 0.5) / px;
  } else if (A == 11) {         // 扫描线
    mask = 0.55 + 0.45 * sin(uv.y * 60.0 + t * 24.0);
  } else if (A == 12) {         // 棋盘遮罩
    float ck = mod(floor(uv.x * 8.0) + floor(uv.y * 8.0), 2.0);
    mask = mix(1.0, ck, t);
  } else if (A == 13) {         // 条纹遮罩
    float st = step(0.5, fract(uv.y * 10.0 + t * 1.5));
    mask = mix(1.0, st, 0.85);
  } else if (A == 14) {         // 径向擦除
    float sec = fract(atan(cc.y, cc.x) / 6.2831 + 0.5);
    mask = smoothstep(1.0 - t, 1.0 - t + 0.06, sec);
  } else if (A == 15) {         // 上下溶解
    float th = t * 1.2;
    mask = smoothstep(th - 0.10, th + 0.10, uv.y);
  } else if (A == 16) {         // 网点
    vec2 g = uv * 11.0;
    float d = length(fract(g) - 0.5);
    float rad = mix(0.55, 0.0, t);
    mask = smoothstep(rad, rad - 0.06, d);
  } else if (A == 17) {         // 线性擦除
    float th = t * 1.2 - 0.1;
    mask = smoothstep(th, th + 0.08, 1.0 - uv.x);
  } else if (A == 18) {         // 故障抖动
    float band = floor(uv.y * 22.0);
    q.x += (hash(vec2(band, floor(t * 24.0))) - 0.5) * 0.22;
    extra *= step(0.2, fract(t * 14.0 + vSeed));
  } else if (A == 19) {         // 闪频
    extra *= 0.35 + 0.65 * step(0.35, fract(t * 7.0 + vSeed));
  }

  q = clamp(q, 0.0, 1.0);
  vec2 local = uPad + q * (1.0 - 2.0 * uPad);
  float row = uRows - 1.0 - vCell.y;
  vec2 auv = (vec2(vCell.x, row) + local) / vec2(uCols, uRows);
  vec4 tex = texture2D(uAtlas, auv);
  float a = tex.a * vAlpha * mask * extra;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * (uSoft > 0.5 ? tex.rgb : vec3(1.0)), a);
}`;

export class FX {
  /** opts.soft = true 时使用普通混合（烟尘 / 雾团），否则叠加发光（火花 / 光点） */
  constructor(scene, max = 900, opts = {}) {
    this.max = max;
    this.soft = !!opts.soft;
    this.count = 0;
    this.head = 0;
    this.time = 0;
    this.scene = scene;

    /* ---------- 纹理图集 ---------- */
    this._slots = [];                // key 顺序（下标即 aTex）
    this._slotIndex = new Map();
    this._atlasCanvas = null;
    this._atlasTex = null;
    this._cols = ATLAS_COLS;         // 固定 8 列
    this._rows = ATLAS_ROWS;         // 固定 8 行
    this._pad = PAD / CELL;
    this._pending = new Set();       // 正在异步加载的导入素材 key（避免重复请求）
    this._atlasDirty = false;        // 渲染 Worker 模式：图集内容变过要推一次贴图更新

    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.siz = new Float32Array(max);
    this.alp = new Float32Array(max);
    this.tex = new Float32Array(max);
    this.anim = new Float32Array(max);
    this.seed = new Float32Array(max);
    this.start = new Float32Array(max);
    this.plife = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.rise = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.siz, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alp, 1));
    g.setAttribute('aTex', new THREE.BufferAttribute(this.tex, 1));
    g.setAttribute('aAnim', new THREE.BufferAttribute(this.anim, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    g.setAttribute('aStart', new THREE.BufferAttribute(this.start, 1));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.plife, 1));
    g.setDrawRange(0, max);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: null },
        uCols: { value: ATLAS_COLS },
        uRows: { value: ATLAS_ROWS },
        uPad: { value: this._pad },
        uTime: { value: 0 },
        uSoft: { value: 1 },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      blending: this.soft ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = this.soft ? 9 : 10;
    scene && scene.add(this.points);
    this._c = new THREE.Color();
    for (let i = 0; i < max; i++) this.alp[i] = 0;
    // 默认槽位 0 = 光晕，保证老逻辑（不指定图像）仍可用
    this.registerImage('pb/glow');
  }

  /* ============================================================
     纹理图集：注册图像 → 返回槽位下标（aTex）
     · 内置粒子贴图同步绘制；导入素材（asset:…）异步加载后补齐
     · 新增槽位会重建图集并重绘全部槽位（下标保持稳定）
     ============================================================ */
  registerImage(key) {
    const k = String(key || '');
    if (!k) return 0;
    const has = this._slotIndex.get(k);
    if (has !== undefined) return has;
    if (this._slots.length >= MAX_SLOTS) return 0;
    const idx = this._slots.length;
    this._slots.push(k);
    this._slotIndex.set(k, idx);
    this._growAtlas();
    this._paintSlot(k, idx);
    return idx;
  }

  /** 取图像槽位（未注册则注册） */
  texIndex(key) { return key ? this.registerImage(key) : 0; }

  /**
   * 一次性分配固定尺寸图集（8×8）。
   * 关键：画布尺寸永不改变——three.js 在 WebGL2 下为 CanvasTexture 使用 texStorage2D
   * 分配「不可增长」的显存，之后只走 texSubImage2D。若中途把画布改大，texSubImage2D
   * 会因超出已分配尺寸而失败（GL INVALID_OPERATION），表现为粒子贴图错乱 / 白色方块。
   * 固定尺寸后，每次只是往已有格子里重绘（尺寸一致 → 上传始终合法）。
   */
  _growAtlas() {
    if (this._atlasCanvas) return;
    const cols = ATLAS_COLS, rows = ATLAS_ROWS;
    const w = cols * CELL, h = rows * CELL;
    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : (() => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; })();
    this._atlasCanvas = canvas;
    this._cols = cols;
    this._rows = rows;
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    this._atlasTex = t;
    this.mat.uniforms.uAtlas.value = t;
    this.mat.uniforms.uCols.value = cols;
    this.mat.uniforms.uRows.value = rows;
  }

  _paintSlot(key, idx) {
    const img = this._resolveImage(key);
    if (img) { this._drawSlot(img, idx); return; }
    if (isParticleBuiltin(key)) return;                 // 内置却解析失败（异常）→ 留空
    // 导入素材：异步加载后补画
    if (this._pending.has(key)) return;
    this._pending.add(key);
    ensureTexture(key).then(() => {
      this._pending.delete(key);
      const t = getTexture(key);
      if (t && t.image) this._drawSlot(t.image, idx);
    }).catch(() => { this._pending.delete(key); });
  }

  _resolveImage(key) {
    if (isParticleBuiltin(key)) {
      const t = getParticleSprite(key);
      return t ? t.image : null;
    }
    const t = getTexture(key);
    return t && t.image ? t.image : null;
  }

  _drawSlot(img, idx) {
    const canvas = this._atlasCanvas;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    const cx = (idx % this._cols) * CELL;
    const cy = Math.floor(idx / this._cols) * CELL;
    ctx.clearRect(cx, cy, CELL, CELL);
    try { ctx.drawImage(img, cx + PAD, cy + PAD, CELL - PAD * 2, CELL - PAD * 2); } catch (e) { /* ignore */ }
    if (this._atlasTex) this._atlasTex.needsUpdate = true;
    this._atlasDirty = true;   // 渲染 Worker 模式：内容变了要推一次贴图更新
  }

  /* ============================================================
     发射
     opt: { tex, anim, seed, speed, dir, up, life, gravity, drag, rise, size, alpha, color }
     ============================================================ */
  emit(x, y, z, opt = {}) {
    if (this.count >= this.max * 2 && this.head % 2) return;   // 降载
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    const sp = opt.speed ?? 8;
    const dir = opt.dir || null;
    let vx, vy, vz;
    if (dir) {
      vx = dir[0]; vy = dir[1]; vz = dir[2];
    } else {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * sp;
      vx = Math.cos(a) * r; vz = Math.sin(a) * r;
      vy = (opt.up ?? 0.6) * sp * Math.random();
    }
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    const life = Math.max(0.02, opt.life ?? 0.7);
    this.life[i] = this.maxLife[i] = life;
    this.plife[i] = life;
    this.start[i] = this.time;
    this.grav[i] = opt.gravity ?? 40;
    this.drag[i] = opt.drag ?? 1.6;
    this.rise[i] = opt.rise ?? 0;
    this.siz[i] = opt.size ?? 3;
    this.alp[i] = opt.alpha ?? 0.9;
    this.tex[i] = opt.tex ?? 0;
    this.anim[i] = opt.anim ?? 0;
    this.seed[i] = opt.seed ?? Math.random();
    const c = opt.color ?? '#ffffff';
    this._c.set(c);
    this.col[i3] = this._c.r; this.col[i3 + 1] = this._c.g; this.col[i3 + 2] = this._c.b;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aTex.needsUpdate = true;
    this.geo.attributes.aAnim.needsUpdate = true;
    this.geo.attributes.aSeed.needsUpdate = true;
    this.geo.attributes.aStart.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
    this.dirtyPos = true;
    return i;
  }

  splash(pos, kind = 'water', n = 24) {
    const L = LIQUID_KINDS[kind] || LIQUID_KINDS.water;
    for (let i = 0; i < n; i++) {
      this.emit(pos.x + (Math.random() - 0.5) * 5, pos.y, pos.z + (Math.random() - 0.5) * 5, {
        color: L.color, size: 2.4 + Math.random() * 3.4, speed: 16, life: 0.55 + Math.random() * 0.4,
        gravity: 62, alpha: 0.85, rise: 0,
      });
    }
  }
  splashOut(pos) {
    for (let i = 0; i < 16; i++) {
      this.emit(pos.x + (Math.random() - 0.5) * 4, pos.y - 1, pos.z + (Math.random() - 0.5) * 4, {
        color: '#cfe9ff', size: 2 + Math.random() * 3, speed: 12, life: 0.5, gravity: 70, alpha: 0.7,
      });
    }
  }
  bubble(pos, s = 1) {
    this.emit(pos.x + (Math.random() - 0.5) * 3, pos.y + 1 + Math.random() * 2, pos.z + (Math.random() - 0.5) * 3, {
      color: '#dff4ff', size: 1.6 * s + Math.random() * 2, speed: 2.4, life: 1.4,
      gravity: -6, drag: 2.4, alpha: 0.6, rise: 6,
      tex: this.texIndex('pb/bubble'),
    });
  }
  hit(pos, color = '#ffe6a8', n = 12) {
    for (let i = 0; i < n; i++) {
      this.emit(pos.x, pos.y, pos.z, { color, size: 1.6 + Math.random() * 2.6, speed: 14, life: 0.4, gravity: 30, alpha: 1 });
    }
  }
  sparkle(pos, color = '#fff3c4', n = 18, r = 3) {
    const spark = this.texIndex('pb/spark');
    for (let i = 0; i < n; i++) {
      this.emit(pos.x + (Math.random() - 0.5) * r, pos.y + (Math.random() - 0.5) * r, pos.z + (Math.random() - 0.5) * r, {
        color, size: 2 + Math.random() * 3, speed: 5, life: 0.9, gravity: -4, alpha: 1, rise: 4, tex: spark,
      });
    }
  }
  burst(pos, color = '#ffd98a', n = 30) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI - Math.PI / 2;
      const sp = 12 + Math.random() * 18;
      this.emit(pos.x, pos.y, pos.z, {
        color, size: 2 + Math.random() * 4, life: 0.9 + Math.random() * 0.6, gravity: 55, alpha: 1,
        dir: [Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp * 0.8 + 6, Math.sin(a) * Math.cos(e) * sp],
      });
    }
  }

  update(dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    const { pos, vel, life, grav, drag, rise } = this;
    let active = 0;
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      const i3 = i * 3;
      vel[i3 + 1] -= grav[i] * dt;
      const d = Math.max(0, 1 - drag[i] * dt);
      vel[i3] *= d; vel[i3 + 1] *= d; vel[i3 + 2] *= d;
      vel[i3 + 1] += rise[i] * dt;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      active++;
    }
    this.count = active;
    this.geo.attributes.position.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.max; i++) { this.life[i] = 0; this.alp[i] = 0; }
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  dispose() {
    if (this.points.parent) this.points.parent.remove(this.points);
    this.geo.dispose();
    this.mat.dispose();
    if (this._atlasTex) this._atlasTex.dispose();
    this._atlasTex = null;
    this._atlasCanvas = null;
    this.scene = null;
  }
}

export { getBubbleSprite };