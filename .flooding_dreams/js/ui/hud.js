/* ============================================================
   HUD：氧气 / 工具栏 / 计时 / 提示 / 横幅 / 受击暗角
   ============================================================ */
import { $, el, clear } from './dom.js';
import { fmtTime, clamp, escapeHtml } from '../core/util.js';

// 血量圆环周长（r=18，见 index.html），用于按比例换算 stroke-dashoffset
const HP_RING_LEN = 2 * Math.PI * 18;

export class Hud {
  constructor(opts = {}) {
    this.root = $('#hud');
    this.n = {
      crosshair: $('#crosshair'),
      name: $('#hud-level-name'),
      diff: $('#hud-level-diff'),
      timer: $('#hud-timer'),
      deaths: $('#hud-deaths'),
      objective: $('#hud-objective'),
      oxWrap: $('#oxygen-wrap'),
      oxNum: $('#ox-num'),
      oxFill: $('#ox-fill'),
      oxExtra: $('#ox-extra'),
      oxBar: this.oxBar || null,
      hpWrap: $('#hp-wrap'),
      hpRing: $('#hp-ring'),
      hpNum: $('#hp-num'),
      toolbar: $('#toolbar'),
      prompt: $('#prompt'),
      vignette: $('#damage-vignette'),
      banner: $('#banner'),
      bannerTitle: $('#banner-title'),
      bannerSub: $('#banner-sub'),
      notice: $('#hud-notice'),
      hint: $('#hud-hint'),
      lock: $('#hud-lock'),
      countdown: $('#countdown'),
      countdownNum: $('#countdown-num'),
    };
    this.n.oxBar = this.n.oxFill ? this.n.oxFill.parentElement : null;
    this.cache = {};
    this.onToolSelect = opts.onToolSelect || null;
    this.lockHint = false;
    if (this.n.lock) {
      this.n.lock.addEventListener('click', () => this.onLockClick && this.onLockClick());
    }
  }

  get visible() { return this.root && !this.root.classList.contains('hidden'); }

  show(on) {
    this.root && this.root.classList.toggle('hidden', !on);
    if (!on) this.setCountdown(0);   // 隐藏 HUD 时顺带收掉倒数（倒数元素在 #hud 之外）
  }
  /** 大厅模式：只保留提示层，不显示氧气/工具栏/准星 */
  setHallMode(on) { this.root && this.root.classList.toggle('hall-mode', !!on); }
  setLockHint(on) {
    if (!this.n.lock) return;
    this.lockHint = !!on;
    this.n.lock.classList.toggle('hidden', !on);
  }
  setObjective(text) {
    if (!this.n.objective) return;
    if (this.cache.objective === text) return;
    this.cache.objective = text;
    this.n.objective.textContent = text || '';
    this.n.objective.style.opacity = text ? '1' : '0';
  }

  /** 每帧更新（info = session.hudInfo()） */
  update(info) {
    if (!info) return;
    const c = this.cache;
    const n = this.n;

    /* 关卡名 / 难度 */
    if (c.name !== info.name) {
      c.name = info.name;
      if (n.name) n.name.textContent = info.name || '关卡';
    }
    if (c.diffText !== info.diffText) {
      c.diffText = info.diffText;
      if (n.diff) {
        n.diff.textContent = info.diffText;
        n.diff.style.color = info.diff.color;
        n.diff.style.background = info.diff.glow;
      }
    }

    /* 计时 / 死亡 */
    const tt = info.timeLimit > 0
      ? `${fmtTime(info.time)} / ${fmtTime(info.timeLimit)}`
      : fmtTime(info.time);
    if (c.timer !== tt) { c.timer = tt; if (n.timer) n.timer.textContent = tt; }
    const dd = '☠ ' + info.deaths;
    if (c.deaths !== dd) { c.deaths = dd; if (n.deaths) n.deaths.textContent = dd; }

    /* 氧气 */
    const max = Math.max(1, info.oxygenMax);
    const under = info.under;
    const extra = Math.max(0, info.extraOxygen);
    // 有额外氧气（氧气球拓展）时显示「上限+额外」，如 100+35
    const oxText = extra > 0.5 ? `${Math.round(max)}+${Math.round(extra)}` : String(Math.round(info.oxygen));
    if (c.oxNum !== oxText) { c.oxNum = oxText; if (n.oxNum) n.oxNum.textContent = oxText; }
    const total = max + extra;
    const mainW = clamp((Math.min(info.oxygen, max) / total) * 100, 0, 100);
    const exW = clamp((extra / total) * 100, 0, 100);
    if (c.mainW !== mainW) { c.mainW = mainW; if (n.oxFill) n.oxFill.style.width = mainW.toFixed(1) + '%'; }
    if (c.exW !== exW) {
      c.exW = exW;
      if (n.oxExtra) { n.oxExtra.style.left = mainW.toFixed(1) + '%'; n.oxExtra.style.width = exW.toFixed(1) + '%'; }
    }
    const ratio = info.oxygen / max;
    const state = ratio <= 0.001 ? 'crit' : ratio <= 0.3 ? 'low' : '';
    if (c.oxState !== state + under) {
      c.oxState = state + under;
      if (n.oxBar) { n.oxBar.classList.toggle('low', state === 'low' || state === 'crit'); n.oxBar.classList.toggle('crit', state === 'crit'); }
      if (n.oxWrap) n.oxWrap.style.opacity = under || ratio < 0.999 ? '1' : '0.55';
    }

    /* 工具栏 */
    const sig = info.tools.map((t) => t.key + ':' + (t.count || 1) + (t.active ? '*' : '')).join('|');
    if (c.tools !== sig) { c.tools = sig; this.buildTools(info.tools); }

    /* 准星 */
    const pick = !!info.crosshairPick;
    if (c.pick !== pick) { c.pick = pick; if (n.crosshair) n.crosshair.classList.toggle('pick', pick); }

    /* 交互提示 */
    const prompt = info.prompt || '';
    if (c.prompt !== prompt) {
      c.prompt = prompt;
      if (n.prompt) {
        if (prompt) { n.prompt.innerHTML = prompt; n.prompt.classList.remove('hidden'); }
        else n.prompt.classList.add('hidden');
      }
    }

    /* 横幅（大字标题 + 可选小字副标题；副标题可拆成多段分别着色） */
    const b = info.banner;
    const bText = b ? b.text : '';
    const bSub = b && b.sub ? (Array.isArray(b.sub) ? b.sub : [{ text: b.sub }]) : [];
    const bSig = bText + '\u0000' + bSub.map((s) => (s.text || '') + ':' + (s.color || '')).join('|')
      + '\u0000' + ((b && b.stroke) || '');
    if (c.banner !== bSig) {
      c.banner = bSig;
      if (n.bannerTitle) {
        n.bannerTitle.textContent = bText || '';
        n.bannerTitle.style.webkitTextStroke = (b && b.stroke) ? '2px ' + b.stroke : '';
      }
      if (n.bannerSub) {
        clear(n.bannerSub);
        bSub.forEach((s) => {
          n.bannerSub.appendChild(el('i', { text: s.text || '', style: s.color ? { color: s.color } : null }));
        });
        n.bannerSub.classList.toggle('hidden', bSub.length === 0);
      }
      if (n.banner) {
        n.banner.style.color = (b && b.color) || '#fff';
        n.banner.classList.toggle('show', !!bText);
      }
    }

    /* 字幕提示 */
    const hint = info.hint || '';
    if (c.hint !== hint) {
      c.hint = hint;
      if (n.hint) {
        n.hint.textContent = hint;
        n.hint.classList.toggle('hidden', !hint);
      }
    }

    /* 开局倒数 */
    this.setCountdown(info.countdown || 0);

    /* 血量圆环（左下角，带百分比） */
    const hpMax = info.healthMax > 0 ? info.healthMax : 1;
    const hpR = clamp(info.health / hpMax, 0, 1);
    const hpPct = Math.round(hpR * 100);
    if (c.hpPct !== hpPct) { c.hpPct = hpPct; if (n.hpNum) n.hpNum.textContent = hpPct + '%'; }
    const hpOff = (HP_RING_LEN * (1 - hpR)).toFixed(2);
    if (c.hpOff !== hpOff) { c.hpOff = hpOff; if (n.hpRing) n.hpRing.style.strokeDashoffset = hpOff; }
    const hpSt = hpR <= 0.25 ? 'crit' : hpR <= 0.55 ? 'low' : '';
    if (c.hpSt !== hpSt) {
      c.hpSt = hpSt;
      if (n.hpWrap) {
        n.hpWrap.classList.toggle('low', hpSt === 'low');
        n.hpWrap.classList.toggle('crit', hpSt === 'crit');
      }
    }

    /* 受击暗角 */
    const hp = info.healthMax > 0 ? info.health / info.healthMax : 1;
    const op = hp >= 0.999 ? 0 : clamp((1 - hp) * 1.15, 0, 0.92);
    const opR = Math.round(op * 100) / 100;
    if (c.vig !== opR) {
      c.vig = opR;
      if (n.vignette) n.vignette.style.opacity = String(opR);
    }
  }

  buildTools(tools) {
    const box = this.n.toolbar;
    if (!box) return;
    clear(box);
    (tools || []).forEach((t) => {
      const slot = el('div', {
        class: 'tool-slot' + (t.active ? ' sel' : ''),
        title: (t.def && t.def.label) || t.name || '',
        onclick: () => this.onToolSelect && this.onToolSelect(t.index),
      },
        el('span', { text: (t.def && t.def.icon) || '🔧' }),
        (t.count > 1) ? el('i', { class: 'cnt', text: 'x' + t.count, style: { fontStyle: 'normal' } }) : null,
        el('div', { class: 'nm', text: (t.def && t.def.label) || t.name || '' }),
      );
      box.appendChild(slot);
    });
  }

  /* 开局倒数：n > 0 显示数字，否则隐藏 */
  setCountdown(n) {
    const box = this.n.countdown;
    const num = this.n.countdownNum;
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (this.cache.cd === v) return;
    this.cache.cd = v;
    if (!box) return;
    if (v <= 0) { box.classList.add('hidden'); return; }
    if (num) {
      num.textContent = String(v);
      // 重启弹入动画，数字每次变化都“跳”一下
      num.style.animation = 'none';
      void num.offsetWidth;
      num.style.animation = '';
    }
    box.classList.remove('hidden');
  }

  /**
   * 顶部弹出信息 / 警告（事件动作「显示顶部提示」）
   * kind: info | warn | error | success
   */
  notice(text, kind = 'info', dur = 3) {
    const box = this.n.notice;
    if (!box || !text) return;
    const t = Math.max(0.6, Number(dur) || 3);
    const item = el('div', { class: 'nt nt-' + kind, text: String(text) });
    item.style.setProperty('--nt-hold', t + 's');   // 保持不透明的时间，之后自动淡出
    box.appendChild(item);
    while (box.children.length > 4) box.removeChild(box.firstChild);   // 最多同时 4 条
    setTimeout(() => { if (item.parentNode) item.parentNode.removeChild(item); }, t * 1000 + 480);
  }

  /** 受击时闪一下 */
  flashDamage(amount) {
    const n = this.n.vignette;
    if (!n) return;
    void amount;
    n.style.transition = 'none';
    n.style.opacity = '0.85';
    setTimeout(() => { n.style.transition = 'opacity .45s'; }, 16);
  }

  reset() {
    this.cache = {};
    if (this.n.toolbar) clear(this.n.toolbar);
    if (this.n.prompt) this.n.prompt.classList.add('hidden');
    if (this.n.hint) this.n.hint.classList.add('hidden');
    if (this.n.bannerTitle) { this.n.bannerTitle.textContent = ''; this.n.bannerTitle.style.webkitTextStroke = ''; }
    if (this.n.bannerSub) { this.n.bannerSub.textContent = ''; this.n.bannerSub.classList.add('hidden'); }
    if (this.n.banner) this.n.banner.classList.remove('show');
    if (this.n.notice) clear(this.n.notice);
    if (this.n.vignette) this.n.vignette.style.opacity = '0';
    if (this.n.oxFill) this.n.oxFill.style.width = '100%';
    if (this.n.oxExtra) { this.n.oxExtra.style.left = '100%'; this.n.oxExtra.style.width = '0%'; }
    if (this.n.hpNum) this.n.hpNum.textContent = '100%';
    if (this.n.hpRing) this.n.hpRing.style.strokeDashoffset = '0';
    if (this.n.hpWrap) this.n.hpWrap.classList.remove('low', 'crit');
    this.setCountdown(0);
    this.setObjective('');
  }
}

export { escapeHtml };