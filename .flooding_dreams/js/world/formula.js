/* ============================================================
   公式求值（高级运算事件块用）
   自己写词法 + 递归下降解析，编译成闭包；不使用 eval / new Function。
   变量：a b c d x y z w（对应八参数），常量 pi / e / tau
   运算符：+ - * / % ^（^ 与 ** 同义，右结合），一元 ±
   函数：sin cos tan asin acos atan atan2 sqrt abs floor ceil round sign exp
         log(=log10) log10 ln(=自然对数) pow mod min max clamp lerp
   ============================================================ */

const FUNCS = {
  sin:   { n: 1, f: Math.sin },
  cos:   { n: 1, f: Math.cos },
  tan:   { n: 1, f: Math.tan },
  asin:  { n: 1, f: Math.asin },
  acos:  { n: 1, f: Math.acos },
  atan:  { n: 1, f: Math.atan },
  atan2: { n: 2, f: Math.atan2 },
  sqrt:  { n: 1, f: Math.sqrt },
  abs:   { n: 1, f: Math.abs },
  floor: { n: 1, f: Math.floor },
  ceil:  { n: 1, f: Math.ceil },
  round: { n: 1, f: Math.round },
  sign:  { n: 1, f: Math.sign },
  exp:   { n: 1, f: Math.exp },
  log:   { n: 1, f: Math.log10 },   // 习惯写法：log=常用对数
  log10: { n: 1, f: Math.log10 },
  ln:    { n: 1, f: Math.log },     // 自然对数
  pow:   { n: 2, f: Math.pow },
  mod:   { n: 2, f: (a, b) => a % b },
  min:   { n: -1, f: (...v) => Math.min(...v) },   // 变长（至少 1 个）
  max:   { n: -1, f: (...v) => Math.max(...v) },
  clamp: { n: 3, f: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
  lerp:  { n: 3, f: (a, b, t) => a + (b - a) * t },
};

const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

/** 公式里可用的变量名（与 config.MATH_VARS 对应） */
export const FORMULA_VARS = ['a', 'b', 'c', 'd', 'x', 'y', 'z', 'w'];
/** 公式里可用的函数名（供编辑器提示） */
export const FORMULA_FUNCS = Object.keys(FUNCS);

const NUM_RE = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/;

function tokenize(src) {
  const out = [];
  const s = String(src);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const m = NUM_RE.exec(s.slice(i));
      if (!m) throw new Error('无效数字');
      const num = Number(m[0]);
      if (!Number.isFinite(num)) throw new Error('无效数字：' + m[0]);
      out.push({ t: 'num', v: num });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      out.push({ t: 'id', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '*' && s[i + 1] === '*') { out.push({ t: 'op', v: '^' }); i += 2; continue; }
    if ('+-*/%^'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    if (ch === '(' || ch === ')' || ch === ',') { out.push({ t: ch }); i++; continue; }
    throw new Error('无法识别的字符：' + ch);
  }
  return out;
}

/** tokens → 闭包 (env)=>number；语法有误时抛错 */
function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const eat = (t, v) => {
    const k = tokens[p];
    if (k && k.t === t && (v === undefined || k.v === v)) { p++; return k; }
    return null;
  };
  const need = (t, v) => { const k = eat(t, v); if (!k) throw new Error('缺少 ' + (v || t)); return k; };

  function expr() {
    let l = term();
    for (;;) {
      const k = peek();
      if (!k || k.t !== 'op' || (k.v !== '+' && k.v !== '-')) break;
      p++;
      const a = l, b = term();
      l = k.v === '+' ? (env) => a(env) + b(env) : (env) => a(env) - b(env);
    }
    return l;
  }

  function term() {
    let l = unary();
    for (;;) {
      const k = peek();
      if (!k || k.t !== 'op' || (k.v !== '*' && k.v !== '/' && k.v !== '%')) break;
      p++;
      const a = l, b = unary();
      l = k.v === '*' ? (env) => a(env) * b(env)
        : k.v === '/' ? (env) => a(env) / b(env)
          : (env) => a(env) % b(env);
    }
    return l;
  }

  function unary() {
    const k = peek();
    if (k && k.t === 'op' && (k.v === '-' || k.v === '+')) {
      p++;
      const v = unary();
      return k.v === '-' ? (env) => -v(env) : v;
    }
    return power();
  }

  function power() {
    const base = atom();
    const k = peek();
    if (k && k.t === 'op' && k.v === '^') {
      p++;
      const ex = unary();                      // 右结合：2^3^2 = 2^(3^2)
      return (env) => Math.pow(base(env), ex(env));
    }
    return base;
  }

  function atom() {
    const k = peek();
    if (!k) throw new Error('公式意外结束');
    if (k.t === 'num') { p++; const v = k.v; return () => v; }
    if (k.t === '(') { p++; const e = expr(); need(')'); return e; }
    if (k.t === 'id') {
      p++;
      const name = k.v.toLowerCase();
      /* 函数调用 */
      if (peek() && peek().t === '(') {
        p++;
        const args = [];
        if (!eat(')')) {
          for (;;) {
            args.push(expr());
            if (eat(',')) continue;
            need(')');
            break;
          }
        }
        const def = FUNCS[name];
        if (!def) throw new Error('未知函数：' + k.v);
        if (def.n >= 0 && args.length !== def.n) throw new Error(k.v + ' 需要 ' + def.n + ' 个参数');
        if (def.n < 0 && args.length < 1) throw new Error(k.v + ' 至少需要 1 个参数');
        const f = def.f;
        return (env) => {
          const vals = new Array(args.length);
          for (let i = 0; i < args.length; i++) vals[i] = args[i](env);
          return f(...vals);
        };
      }
      /* 常量 */
      if (Object.prototype.hasOwnProperty.call(CONSTS, name)) {
        const c = CONSTS[name];
        return () => c;
      }
      /* 变量 */
      if (FORMULA_VARS.includes(name)) {
        return (env) => {
          const v = Number(env[name]);
          return Number.isFinite(v) ? v : 0;
        };
      }
      throw new Error('未知变量：' + k.v);
    }
    throw new Error('意外的符号：' + (k.v || k.t));
  }

  const root = expr();
  if (p < tokens.length) throw new Error('公式末尾有多余内容');
  return root;
}

const _cache = new Map();

/** 编译公式：空串/语法错误 ⇒ null（失败即失效，绝不做半个求值） */
export function compileFormula(src) {
  const key = String(src == null ? '' : src).trim();
  if (!key) return null;
  if (_cache.has(key)) return _cache.get(key);
  let fn = null;
  try { fn = parse(tokenize(key)); } catch (e) { fn = null; }
  if (_cache.size > 256) _cache.clear();
  _cache.set(key, fn);
  return fn;
}

/** 语法检查：返回错误文案，OK 或公式为空时返回 null */
export function formulaError(src) {
  const key = String(src == null ? '' : src).trim();
  if (!key) return null;
  try { parse(tokenize(key)); return null; } catch (e) { return (e && e.message) || '公式有误'; }
}