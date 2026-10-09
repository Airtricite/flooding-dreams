/* ============================================================
   主菜单 / 大厅底栏 / 通用 data-act 绑定
   ============================================================ */
import { $, $$ } from './dom.js';

/** 绑定 root 内所有 [data-act] 按钮 → handler(act, ev, btn) */
export function bindActs(root, handler) {
  if (!root) return;
  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !root.contains(btn)) return;
    handler(btn.dataset.act, ev, btn);
  });
  // 点击卡片本身（无按钮命中时）也视为 play
  root.addEventListener('click', (ev) => {
    const card = ev.target.closest('.lv-card');
    if (!card || ev.target.closest('.mini') || ev.target.closest('.badge')) return;
    handler('card', ev, card);
  });
}

/* ---------- 开始界面 ---------- */
export class MainMenu {
  constructor(opts = {}) {
    this.root = $('#menu');
    this.opts = opts;
    bindActs(this.root, (act) => {
      switch (act) {
        case 'play': opts.onPlay && opts.onPlay(); break;
        case 'replays': opts.onReplays && opts.onReplays(); break;
        case 'skin': opts.onSkin && opts.onSkin(); break;
        case 'editor': opts.onEditor && opts.onEditor(); break;
        case 'settings': opts.onSettings && opts.onSettings(); break;
        case 'help': opts.onHelp && opts.onHelp(); break;
        default: break;
      }
    });
  }
}

/* ---------- 大厅底栏 ---------- */
export class HallBar {
  constructor(opts = {}) {
    this.root = $('#hallbar');
    this.opts = opts;
    bindActs(this.root, (act) => {
      switch (act) {
        case 'menu': opts.onMenu && opts.onMenu(); break;
        case 'levels': opts.onLevels && opts.onLevels(); break;
        case 'settings': opts.onSettings && opts.onSettings(); break;
        default: break;
      }
    });
  }
  show(on) { this.root && this.root.classList.toggle('hidden', !on); }
}

/* ---------- 暂停菜单 ---------- */
export class PauseMenu {
  constructor(opts = {}) {
    this.root = $('#pause');
    this.opts = opts;
    bindActs(this.root, (act) => {
      switch (act) {
        case 'resume': opts.onResume && opts.onResume(); break;
        case 'restart': opts.onRestart && opts.onRestart(); break;
        case 'levels': opts.onLevels && opts.onLevels(); break;
        case 'settings': opts.onSettings && opts.onSettings(); break;
        case 'quit': opts.onQuit && opts.onQuit(); break;
        case 'replay': opts.onReplay && opts.onReplay(); break;
        default: break;
      }
    });
  }
  /** 本局已有回放（通关 / 失败后）时，界面上才放出「回放 / 剪辑本局」 */
  setReplayAvailable(on) {
    const b = this.root && this.root.querySelector('[data-act="replay"]');
    if (b) b.classList.toggle('hidden', !on);
  }
}

/* ---------- 结算界面 ---------- */
export class ResultPanel {
  constructor(opts = {}) {
    this.root = $('#result');
    this.opts = opts;
    this.n = { icon: $('#res-icon'), title: $('#res-title'), sub: $('#res-sub'), stats: $('#res-stats') };
    bindActs(this.root, (act) => {
      switch (act) {
        case 'again': opts.onAgain && opts.onAgain(); break;
        case 'next': opts.onNext && opts.onNext(); break;
        case 'hall': opts.onHall && opts.onHall(); break;
        case 'replay': opts.onReplay && opts.onReplay('direct'); break;
        case 'cine': opts.onReplay && opts.onReplay('cinema'); break;
        default: break;
      }
    });
  }
  /** info: { win, title, sub, stats:[{l,v}], hasNext, cine } */
  fill(info) {
    const n = this.n;
    if (n.icon) n.icon.textContent = info.win ? '✦' : '💀';
    if (n.title) { n.title.textContent = info.title || (info.win ? '通关！' : '失败'); n.title.style.color = info.win ? '#8ef5c8' : '#ff9fb2'; }
    if (n.sub) n.sub.textContent = info.sub || '';
    if (n.stats) {
      n.stats.innerHTML = '';
      for (const s of info.stats || []) {
        const d = document.createElement('div');
        d.innerHTML = `<span>${s.l}</span><b>${s.v}</b>`;
        n.stats.appendChild(d);
      }
    }
    const nextBtn = this.root && this.root.querySelector('[data-act="next"]');
    if (nextBtn) nextBtn.style.display = info.hasNext ? '' : 'none';
    // 有回放才显示「看回放」；通关局才解锁电影剪辑
    const rpBtn = this.root && this.root.querySelector('[data-act="replay"]');
    if (rpBtn) rpBtn.style.display = info.replay ? '' : 'none';
    const cineBtn = this.root && this.root.querySelector('[data-act="cine"]');
    if (cineBtn) cineBtn.style.display = info.cine ? '' : 'none';
  }
}

export { $, $$ };