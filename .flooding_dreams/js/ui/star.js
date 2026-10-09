/* ============================================================
   100% 通关星星：用原生 WebGL 片元着色器画的一颗动态五角星
   —— 关卡包全部通关后作为奖励徽章展示（列表卡片 / 地图详情两处）
   刻意不依赖 Three.js：每张卡片都建一个 WebGLRenderer 太重了。
   为了不拖垮游戏主画布（浏览器 WebGL 上下文数量有限）：
     · 所有实例共用同一个 requestAnimationFrame 循环
     · 所有实例共用同一个 IntersectionObserver，离屏即停步
     · 同时动画的实例设上限，超出的只画一帧静态相位
     · dispose() 用 WEBGL_lose_context 真正释放上下文
   ============================================================ */

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;
uniform vec2  uRes;    // 画布像素尺寸
uniform float uTime;
uniform float uAmp;    // 0→1 出场动画
uniform vec3  uTint;   // 主色
varying vec2  vUv;

const float PI = 3.14159265359;

// 五角星 SDF（Inigo Quilez）：r = 外半径，rf ≈ 0.40 内凹比
float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

// 虹彩调色板（cosine palette）
vec3 palette(float t) {
  return 0.55 + 0.45 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.67)));
}

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= uRes.x / max(uRes.y, 1.0);              // 保证正圆

  float r = (0.70 + 0.025 * sin(uTime * 1.7)) * (0.6 + 0.4 * uAmp);
  float d = sdStar5(p, r, 0.40);

  float body = smoothstep(0.020, -0.020, d);                                  // 星体
  float rim  = smoothstep(-0.10, 0.0, d) - smoothstep(0.0, 0.055, d);         // 描边
  float glow = exp(-6.0 * max(d, 0.0)) * 0.9 + exp(-26.0 * max(d, 0.0)) * 0.55; // 双层光晕

  float ang = atan(p.y, p.x);
  float tw = 0.62 + 0.38 * sin(ang * 5.0 - uTime * 2.3) * sin(uTime * 1.3);   // 旋转闪烁
  vec3  irid = palette(ang / (2.0 * PI) + uTime * 0.07 + length(p) * 0.35);
  vec3  core = mix(uTint, irid, 0.75);

  float flare = exp(-70.0 * abs(p.y)) * exp(-2.0 * abs(p.x))                  // 十字星芒
              + exp(-70.0 * abs(p.x)) * exp(-2.0 * abs(p.y));

  vec3 col = core * body * (0.85 + 0.5 * tw)
           + irid * rim  * 1.45
           + irid * glow * tw * 0.85
           + vec3(1.0, 0.98, 0.90) * flare * 0.18 * (0.7 + 0.3 * sin(uTime * 2.0));

  float a = clamp(body + rim * 0.9 + glow * 0.5 + flare * 0.3, 0.0, 1.0) * uAmp;
  gl_FragColor = vec4(col, a);
}
`;

const MAX_LIVE = 6;           // 同时动画的星星上限
const RAMP = 0.6;             // 出场动画时长（秒）
const DEFAULT_TINT = [1.0, 0.85, 0.45];

const live = new Set();
const EL2INST = new WeakMap();
let rafId = 0;
let lastTs = 0;
let io = null;

function getIO() {
  if (io) return io;
  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const inst = EL2INST.get(en.target);
      if (inst) inst.visible = en.isIntersecting;
    }
    updateLoop();
  }, { rootMargin: '80px' });
  return io;
}

function animatingCount() {
  let n = 0;
  for (const i of live) if (i.animated) n++;
  return n;
}

function updateLoop() {
  if (rafId) return;
  for (const i of live) {
    if (i.visible && i.animated) { rafId = requestAnimationFrame(tick); return; }
  }
}

function tick(ts) {
  rafId = 0;
  const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
  lastTs = ts;
  let any = false;
  for (const inst of live) {
    if (!inst.visible || !inst.animated) continue;
    any = true;
    inst._t += dt;
    if (inst._amp < 1) inst._amp = Math.min(1, inst._amp + dt / RAMP);
    inst._draw();
  }
  if (any) rafId = requestAnimationFrame(tick);
  else lastTs = 0;
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('[star] shader 编译失败', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

class StarInstance {
  constructor(host, size, opts) {
    this.host = host;
    this.size = Math.max(16, size);
    this.opts = opts;
    this._t = opts.phase != null ? opts.phase : 0;
    this._amp = 0;
    this.visible = false;
    this.animated = opts.animated !== false;
    // 超出并发上限：只画一帧静态相位
    if (this.animated && animatingCount() >= MAX_LIVE) {
      this.animated = false;
      this._t = 1.7;
      this._amp = 1;
    }

    this.el = document.createElement('div');
    this.el.className = 'star-wrap' + (opts.className ? ' ' + opts.className : '');
    this.el.style.width = this.size + 'px';
    this.el.style.height = this.size + 'px';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'star-canvas';
    this.el.appendChild(this.canvas);
    host.appendChild(this.el);

    const tint = Array.isArray(opts.tint) && opts.tint.length === 3 ? opts.tint : DEFAULT_TINT;
    this.tint = tint;

    this._initGL();
    this._resize();
    EL2INST.set(this.el, this);
    getIO().observe(this.el);
    if (this.animated) this.visible = true;   // 首帧先画，IO 回调随后校正
    live.add(this);
    this._draw();
    updateLoop();
  }

  _initGL() {
    const glOpts = {
      alpha: true, premultipliedAlpha: false, antialias: false,
      depth: false, stencil: false, powerPreference: 'low-power',
    };
    let gl = null;
    try { gl = this.canvas.getContext('webgl2', glOpts); } catch (e) { /* 退回 webgl1 */ }
    if (!gl) { try { gl = this.canvas.getContext('webgl', glOpts); } catch (e) { /* 无 GL */ } }
    this.gl = gl;
    if (!gl) { this.failed = true; this._fallback(); return; }

    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this._lost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => { this._lost = false; this._initGL(); this._draw(); });

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { this.failed = true; this._fallback(); return; }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[star] program 链接失败', gl.getProgramInfoLog(prog));
      this.failed = true; this._fallback(); return;
    }
    this.prog = prog;
    this.aPos = gl.getAttribLocation(prog, 'aPos');
    this.uRes = gl.getUniformLocation(prog, 'uRes');
    this.uTime = gl.getUniformLocation(prog, 'uTime');
    this.uAmp = gl.getUniformLocation(prog, 'uAmp');
    this.uTint = gl.getUniformLocation(prog, 'uTint');

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.buf = buf;

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);   // 加法辉光
    gl.clearColor(0, 0, 0, 0);
  }

  _fallback() {
    // 没有 WebGL：退化成静态星形字符，至少不空白
    if (this.el.querySelector('.star-glyph')) return;
    const s = document.createElement('span');
    s.className = 'star-glyph';
    s.textContent = '★';
    this.el.appendChild(s);
  }

  _resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(this.size * dpr);
    this._w = px;
    this._h = px;
    this.canvas.width = px;
    this.canvas.height = px;
    this.canvas.style.width = this.size + 'px';
    this.canvas.style.height = this.size + 'px';
  }

  _draw() {
    const gl = this.gl;
    if (!gl || this.failed || this._lost) return;
    gl.viewport(0, 0, this._w, this._h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.uRes, this._w, this._h);
    gl.uniform1f(this.uTime, this._t * (this.opts.speed || 1));
    gl.uniform1f(this.uAmp, this._amp);
    gl.uniform3f(this.uTint, this.tint[0], this.tint[1], this.tint[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** 重新按当前像素比缩放并重绘 */
  resize() { this._resize(); this._draw(); }

  setAnimated(on) {
    this.animated = !!on;
    if (this.animated) { getIO().observe(this.el); updateLoop(); }
  }

  dispose() {
    live.delete(this);
    if (io) { try { io.unobserve(this.el); } catch (e) { /* ignore */ } }
    const gl = this.gl;
    if (gl) {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) { try { ext.loseContext(); } catch (e) { /* ignore */ } }
    }
    this.gl = null;
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

/**
 * 把一颗 shader 星星挂进 host。
 * @param host 容器元素（星星会被 append 进去，不会清空 host 其他内容）
 * @param opts { size=64, tint=[r,g,b], speed=1, animated=true, phase, className }
 * @returns { el, canvas, dispose(), resize(), setAnimated(bool) } 或 null
 */
export function mountStar(host, opts = {}) {
  if (!host) return null;
  return new StarInstance(host, opts.size || 64, opts);
}