/* ============================================================
   回放 / 电影运镜 界面
   ------------------------------------------------------------
   · ReplayPanel —— 回放列表（每局游玩一条，通关的解锁电影运镜）
   · ReplayHud   —— 回放播放条（进度 / 镜头刻度 / 速度 / 模式切换）
   · CinePanel   —— 电影运镜面板（分段表：运镜类型 / 节奏 / 保留与否 / 定位）
   ============================================================ */
import { $, el, clear, toast } from './dom.js';
import { GridSelect } from './grid-picker.js';
import { fmtTime, fmtTimeMs, download, sanitizeName } from '../core/util.js';
import { SHOT_TYPES, CINE_STYLE_LIST } from '../game/cine.js';
import { REPLAY_MODE_LABEL } from '../game/replay-player.js';
import { loadReplay } from '../game/replay.js';
import { BatchBar } from './batch.js';
import { chunkedAppend } from './render-queue.js';

const SHOT_ORDER = ['static', 'pushIn', 'pullOut', 'track', 'follow', 'lead', 'orbit', 'crane', 'lowHero', 'topDown', 'droneTrack', 'topOrbit', 'helicopter', 'descent', 'swing', 'steadicam', 'pov'];

/* ============================================================
   回放列表
   ============================================================ */
export class ReplayPanel {
  /** opts: { onPlay(id, mode), onDelete(id), onClear(), onClose() } */
  constructor(opts = {}) {
    this.opts = opts;
    this.root = $('#replays');
    this.grid = $('#rp-grid');
    this.filter = null;
    const filterHost = $('#rp-filter');
    if (filterHost) {
      this.filter = new GridSelect({
        value: '', cls: 'inp', placeholder: '全部关卡', options: [],
        onChange: () => this.render(),
      });
      filterHost.replaceWith(this.filter.el);
    }
    this.items = [];
    this.root.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-rp]');
      if (!btn || !this.root.contains(btn)) return;
      const act = btn.dataset.rp;
      const id = btn.dataset.id || '';
      if (act === 'view') opts.onPlay && opts.onPlay(id, 'direct');
      else if (act === 'cine') { if (!btn.disabled) opts.onPlay && opts.onPlay(id, 'cinema'); }
      else if (act === 'del') opts.onDelete && opts.onDelete(id);
      else if (act === 'clear') opts.onClear && opts.onClear();
      else if (act === 'close') opts.onClose && opts.onClose();
    });

    // 批量操作：多选回放后一次性导出 / 删除
    this.batch = new BatchBar({
      host: this.grid,
      itemSelector: '.rp-card',
      idOf: (n) => n.dataset.id,
      actions: [
        { label: '⇩ 导出', title: '把所选回放的原始数据导出为 JSON 备份', run: (ids) => this.batchExport(ids) },
        { label: '🗑 删除', cls: 'del', title: '删除所选回放记录', run: (ids) => this.batchDelete(ids) },
      ],
    });
  }

  open(items) {
    this.items = items || [];
    this._fillFilter();
    this.render();
  }

  _fillFilter() {
    if (!this.filter) return;
    const cur = this.filter.value;
    const map = new Map();
    for (const r of this.items) {
      const k = r.levelId || ('name:' + (r.levelName || ''));
      if (!map.has(k)) map.set(k, r.levelName || '未知关卡');
    }
    this.filter.setOptions([{ v: '', l: '全部关卡' }].concat([...map].map(([k, n]) => ({ v: k, l: n }))));
    this.filter.setValue(map.has(cur) ? cur : '');
  }

  render() {
    const box = this.grid;
    if (!box) return;
    clear(box);
    const want = this.filter ? this.filter.value : '';
    const list = this.items.filter((r) => !want || (r.levelId || ('name:' + (r.levelName || ''))) === want);
    box.classList.toggle('empty', list.length === 0);
    if (!list.length) {
      box.appendChild(el('div', { class: 'rp-empty' }, '还没有回放记录。去玩一局吧 —— 每一局都会被自动录下来。'));
      if (this.batch) { this.batch.setAvailable(false); this.batch.sync(); }
      return;
    }
    // 一级分类：关卡（items 已按时间倒序，所以最近玩过的关卡自然排最前）
    const groups = new Map();
    for (const r of list) {
      const k = r.levelId || ('name:' + (r.levelName || ''));
      if (!groups.has(k)) groups.set(k, { name: r.levelName || '未知关卡', items: [] });
      groups.get(k).items.push(r);
    }
    for (const g of groups.values()) {
      const wins = g.items.filter((r) => r.win).length;
      box.appendChild(el('div', { class: 'rp-lv' },
        el('b', { text: g.name }),
        el('span', { class: 'rp-lv-n', text: `${g.items.length} 局` }),
        wins ? el('span', { class: 'rp-lv-win', text: `${wins} 次通关` }) : null,
      ));
      // 二级分类：今天 / 本周内 / 本月内 / 今年 / 往年
      for (const sec of bucketize(g.items)) {
        box.appendChild(el('div', { class: 'rp-sec' },
          el('b', { text: sec.label }),
          el('i', { text: sec.items.length + ' 条' }),
        ));
        const row = el('div', { class: 'rp-row' });
        chunkedAppend(row, sec.items, (r) => this._card(r), { firstBatch: 6, perFrame: 6 });
        box.appendChild(row);
      }
    }
    if (this.batch) { this.batch.setAvailable(true); this.batch.sync(); }
  }

  _card(r) {
    return el('div', { class: 'rp-card' + (r.win ? ' win' : ''), dataset: { id: r.id } },
      el('div', { class: 'rp-card-head' },
        el('b', { class: 'rp-card-name', text: r.win ? '通关' : (r.reason || '失败') }),
        el('span', { class: 'rp-badge ' + (r.win ? 'win' : 'fail'), text: fmtTime(r.duration) }),
      ),
      el('div', { class: 'rp-card-meta' },
        r.win && r.winAt > 0 ? el('span', {
          text: `🏁 通关 ${fmtTimeMs(r.winAt)}`,
          title: '本局实际通关的时刻（回放时间轴，精确到毫秒）',
        }) : null,
        el('span', { text: `${r.deaths} 次死亡` }),
        el('span', { text: new Date(r.at || 0).toLocaleString() }),
        r.test ? el('span', { class: 'rp-tag', text: '试玩' }) : null,
      ),
      el('div', { class: 'rp-card-btns' },
        el('button', { class: 'mbtn sm', dataset: { rp: 'view', id: r.id }, text: '▶ 看回放' }),
        el('button', {
          class: 'mbtn sm ' + (r.win ? 'primary' : ''), dataset: { rp: 'cine', id: r.id },
          disabled: !r.win, title: r.win ? '电影级运镜剪辑' : '通关后才解锁',
          text: r.win ? '🎬 电影剪辑' : '🔒 电影剪辑',
        }),
        el('button', { class: 'xbtn sm', dataset: { rp: 'del', id: r.id }, title: '删除', text: '✕' }),
      ),
    );
  }

  /* ---------- 批量操作 ---------- */
  async batchExport(ids) {
    let n = 0;
    for (const id of ids) {
      try {
        const rec = await loadReplay(id);
        if (!rec) continue;
        const name = (rec.levelName || '回放') + '_' + new Date(rec.at || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
        download(sanitizeName(name, '回放') + '.fdreplay.json', JSON.stringify(rec));
        n++;
      } catch (e) { console.warn('[replay] 导出失败', id, e); }
    }
    toast(n ? `已导出 ${n} 条回放数据` : '没有可导出的回放', n ? 'ok' : 'err');
  }

  async batchDelete(ids) {
    if (!ids.length) return;
    if (this.opts.onDeleteMany) return this.opts.onDeleteMany(ids);
    for (const id of ids) await (this.opts.onDelete && this.opts.onDelete(id));
  }
}

/* ------------------------------------------------------------
   时间分栏：今天 / 本周内 / 本月内 / 今年 / 往年
   同一局只会落进最靠前的那一栏（互斥），栏内按时间倒序
   ------------------------------------------------------------ */
function timeBucket(ts, now = new Date()) {
  const d = new Date(ts || 0);
  if (!ts || isNaN(d.getTime())) return { label: '更早', rank: 1e9 };
  const day0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (day0 === today) return { label: '今天', rank: 0 };
  const mon = new Date(today);
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));   // 周一为一周之始
  if (day0 >= mon.getTime()) return { label: '本周内', rank: 1 };
  const month0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (day0 >= month0) return { label: '本月内', rank: 2 };
  if (d.getFullYear() === now.getFullYear()) return { label: '今年', rank: 3 };
  return { label: d.getFullYear() + '年', rank: 4 + (now.getFullYear() - d.getFullYear()) / 1000 };
}

function bucketize(items) {
  const map = new Map();
  for (const r of items) {
    const b = timeBucket(r.at);
    if (!map.has(b.label)) map.set(b.label, { label: b.label, rank: b.rank, items: [] });
    map.get(b.label).items.push(r);
  }
  const secs = [...map.values()].sort((a, b) => a.rank - b.rank);
  for (const s of secs) s.items.sort((a, b) => (b.at || 0) - (a.at || 0));
  return secs;
}

/* ============================================================
   回放播放条
   ============================================================ */
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3];

export class ReplayHud {
  /** opts: { onBack(), onCine() } */
  constructor(opts = {}) {
    this.opts = opts;
    this.root = $('#rphud');
    this.n = {
      fade: $('#rp-fade'),
      shot: $('#rp-shot'),
      shotLabel: $('#rp-shot-label'),
      shotType: $('#rp-shot-type'),
      bar: $('#rp-bar'),
      play: $('#rp-play'),
      time: $('#rp-time'),
      win: $('#rp-win'),
      track: $('#rp-track'),
      fill: $('#rp-fill'),
      marks: $('#rp-marks'),
      winmark: $('#rp-winmark'),
      mode: $('#rp-mode'),
      speed: $('#rp-speed'),
      cine: $('#rp-cine'),
    };
    this.player = null;
    this._marks = '';
    this._drag = false;
    this._fadeColor = '';

    this.root.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-rp]');
      if (!btn) return;
      const act = btn.dataset.rp;
      if (act === 'back') opts.onBack && opts.onBack();
      else if (act === 'cine') opts.onCine && opts.onCine();
      else if (!this.player) return;
      else if (act === 'play') this.player.toggle();
      else if (act === 'prev') this.player.step(-1);
      else if (act === 'next') this.player.step(1);
      else if (act === 'mode') this.player.cycleMode();
    });
    if (this.n.speed) {
      const sel = new GridSelect({
        value: '1', cls: 'rp-sel', options: SPEEDS.map((s) => ({ v: String(s), l: s + '×' })),
        onChange: (v) => this.player && this.player.setSpeed(Number(v)),
      });
      this.n.speed.replaceWith(sel.el);
      this.n.speed = sel;
    }
    if (this.n.track) {
      const seek = (ev) => {
        if (!this.player) return;
        const r = this.n.track.getBoundingClientRect();
        this.player.seek(((ev.clientX - r.left) / Math.max(1, r.width)) * this.player.duration);
      };
      this.n.track.addEventListener('pointerdown', (ev) => {
        this._drag = true;
        this.n.track.setPointerCapture && this.n.track.setPointerCapture(ev.pointerId);
        seek(ev);
      });
      this.n.track.addEventListener('pointermove', (ev) => { if (this._drag) seek(ev); });
      this.n.track.addEventListener('pointerup', () => { this._drag = false; });
      this.n.track.addEventListener('pointercancel', () => { this._drag = false; });
    }
  }

  setPlayer(p) {
    this.player = p || null;
    this._marks = '';
    this._winTxt = '';
    this._fadeColor = '';
    if (this.n.cine) this.n.cine.classList.toggle('hidden', !(p && p.rec && p.rec.win));
  }

  show(on) {
    this.root && this.root.classList.toggle('hidden', !on);
    if (!on) { this._marks = ''; this.player = null; }
  }

  /** 每帧刷新（clock 变化后调用） */
  refresh() {
    const p = this.player;
    if (!p) return;
    const n = this.n;
    if (n.play) n.play.textContent = p.playing ? '❚❚' : '▶';
    if (n.time) n.time.textContent = fmtTime(p.clock) + ' / ' + fmtTime(p.duration);
    if (n.fill) n.fill.style.width = (p.progress * 100).toFixed(2) + '%';
    if (n.mode) {
      const txt = REPLAY_MODE_LABEL[p.mode] || p.mode;
      if (n.mode.textContent !== txt) n.mode.textContent = txt;
      n.mode.classList.toggle('on', p.mode === 'cinema');
    }
    // 镜头刻度
    const marks = p.marks;
    const sig = p.mode + ':' + marks.length + ':' + (marks.length ? Math.round(marks[marks.length - 1].t * 10) : 0);
    if (n.marks && sig !== this._marks) {
      this._marks = sig;
      clear(n.marks);
      const dur = Math.max(0.001, p.duration);
      for (const m of marks) {
        n.marks.appendChild(el('li', {
          style: { left: (m.t / dur * 100).toFixed(2) + '%' },
          title: m.label,
        }));
      }
    }
    // 当前镜头字幕
    if (n.shot) {
      const label = p.mode === 'cinema' ? (p.shotLabel || '') : '';
      const type = p.shotTypeLabel || '';
      if (n.shotLabel && n.shotLabel.textContent !== label) n.shotLabel.textContent = label;
      if (n.shotType && n.shotType.textContent !== type) n.shotType.textContent = type;
      n.shot.classList.toggle('show', !!label);
    }
    // 通关时刻（记录里带的精确元数据）：时间轴上钉一个刻度，播放条上给出毫秒级读数，
    // 播放头越过它的那一刻点亮，让人一眼看到「这一下就是通关」。
    const wrec = p.rec || {};
    const winAt = Number(wrec.winAt) || 0;
    const showWin = !!(wrec.win && winAt > 0);
    const durW = Math.max(0.001, p.duration);
    if (n.win) {
      const txt = showWin ? `🏁 通关 ${fmtTimeMs(winAt)}` : '';
      if (this._winTxt !== txt) {
        this._winTxt = txt;
        n.win.textContent = txt;
        n.win.title = showWin
          ? `本局实际通关于回放时间轴 ${fmtTimeMs(winAt)}（全长 ${fmtTimeMs(durW)} 的第 ${(winAt / durW * 100).toFixed(1)}% 处）`
          : '';
      }
      n.win.classList.toggle('hidden', !showWin);
      n.win.classList.toggle('on', showWin && p.clock >= winAt);
    }
    if (n.winmark) {
      n.winmark.classList.toggle('hidden', !showWin);
      if (showWin) n.winmark.style.left = (winAt / durW * 100).toFixed(3) + '%';
    }
    if (n.fade) {
      n.fade.style.opacity = p.fade.toFixed(3);
      // 遮罩颜色由转场决定：阵亡 / 远切是黑场，通关那一拍是白场（#rp-fade 默认背景是黑）
      const c = p.fadeColor || '#000';
      if (this._fadeColor !== c) { this._fadeColor = c; n.fade.style.background = c; }
    }
  }
}

/* ============================================================
   电影运镜面板（分段表）
   ------------------------------------------------------------
   整局是 1:1 连续重演，时间轴不能被拉长 / 缩短，所以这里编辑的是
   「每一段用哪种运镜、节奏多快、要不要保留」：
   关掉某段 = 把它并进上一段（不会在时间轴上留洞）；
   点「定位」把播放头跳到该段起点，边看边改。
   ============================================================ */
export class CinePanel {
  /** opts: { onClose(), onApplied() } */
  constructor(opts = {}) {
    this.opts = opts;
    this.root = $('#cine');
    this.list = $('#cine-list');
    this.styleSel = null;
    const styleHost = $('#cine-style');
    if (styleHost) {
      this.styleSel = new GridSelect({
        value: 'auto', cls: 'inp cine-style', placeholder: '剪辑风格',
        options: CINE_STYLE_LIST.map((s) => ({ v: s.id, l: s.label })),
        onChange: () => this._diversify(true),
      });
      styleHost.replaceWith(this.styleSel.el);
    }
    this.verEl = $('#cine-ver');
    this.player = null;
    this.rows = [];
    this._seed = 0;
    this.root.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-cine]');
      if (!btn) return;
      const act = btn.dataset.cine;
      const i = Number(btn.dataset.i);
      if (act === 'close') opts.onClose && opts.onClose();
      // 重新自动剪 = 回到「基准排片」（无风格、无种子）：同一回放每次结果逐字段一致
      else if (act === 'auto') { if (this.player) { this.player.buildMontage(null, null); this.open(this.player); } }
      else if (act === 'diversify') this._diversify();
      else if (act === 'apply') this._apply();
      else if (act === 'export') this._export();
      else if (act === 'at') { if (this.player && this.rows[i]) this.player.seek(this.rows[i].t0 + 0.01); }
    });
  }

  /**
   * 🎲 换一版：同一风格 + 新种子重排一次。
   * 多样性只作用在「创作自由度」（候选顺序 / 景别表 / 换轴阶梯 / 节奏 / 距离 / 摇摄步长），
   * 合理性由原有闸门兜住：射线候选阶梯、不贴脸下限、FOV 夹紧、飞渡避障、运行期硬保证。
   * @param keepSeed true = 沿用当前种子（只换风格）
   */
  _diversify(keepSeed) {
    const p = this.player;
    if (!p) return;
    const style = (this.styleSel && this.styleSel.value) || 'auto';
    if (!keepSeed || !this._seed) {
      // 新种子：初值取时刻（每次开机不至于都从第 1 版开始），之后逐次递增
      if (!this._seed) this._seed = (Date.now() >>> 4) % 100000;
      this._seed += 1;
    }
    p.buildMontage(null, { style, seed: this._seed });
    this.open(p);
  }

  /** 打开：以当前排片的镜头表填充 */
  open(player) {
    this.player = player;
    this._fill(player ? player.shotList() : []);
    this._refreshVer();
  }

  /** 版本标签（当前是哪一版；无风格 = 基准排片） */
  _refreshVer() {
    if (!this.verEl) return;
    const info = this.player && this.player.variantInfo ? this.player.variantInfo() : null;
    const bi = this.player && this.player.rhythmInfo ? this.player.rhythmInfo() : null;
    const base = info ? `🎞 ${info.text}` : '🎞 基准排片';
    this.verEl.textContent = base + (bi ? ` · 🎵 ${bi.count} 个节奏点卡点` : '');
    const t0 = info
      ? '当前这一版：风格 + 种子。同一「风格 + 种子」排出来的一定是同一版（拖进度条 / 重播都不会变）。'
      : '按固定规则裁剪的基准排片。点「换一版」可以生成运镜合理但排法不同的新版本。';
    this.verEl.title = t0 + (bi
      ? ` 关卡有 BGM：频谱里检出 ${bi.count} 个瞬态节奏点，切点自动吸附到最近的鼓点 / 重音上。`
      : ' 关卡没有 BGM（或没检出明显节奏点）：切点按动作拐点走。');
  }

  _fill(list) {
    this.rows = (list || []).map((s) => ({
      on: s.on !== false, kind: s.kind, label: s.label,
      t0: Number(s.t0) || 0, t1: Number(s.t1) || 0,
      intensity: s.intensity, env: s.env,
      type: s.type || 'track', pace: Number(s.pace) || 1,
      onBeat: !!s.onBeat,
    }));
    this._render();
  }

  _render() {
    const box = this.list;
    clear(box);
    const dur = Math.max(0.001, (this.player && this.player.data.duration) || 1);
    if (!this.rows.length) {
      box.appendChild(el('div', { class: 'cine-empty' }, '没有镜头。点「重新自动剪」按规则生成一次，或点「🎲 换一版」直接生成一个新排法。'));
      return;
    }
    this.rows.forEach((r, i) => {
      const sel = new GridSelect({
        value: r.type,
        cls: 'inp cine-type',
        options: SHOT_ORDER.map((t) => ({ v: t, l: SHOT_TYPES[t].label })),
        onChange: (v) => { r.type = v; },
      });

      const paceIn = el('input', { class: 'inp cine-num', type: 'number', step: '0.05', min: '0.5', max: '2', value: String(r.pace) });
      paceIn.addEventListener('change', () => {
        r.pace = Math.min(2, Math.max(0.5, Number(paceIn.value) || 1));
        paceIn.value = String(r.pace);
      });

      const sw = el('button', { class: 'switch' + (r.on ? ' on' : ''), type: 'button', title: '保留 / 并入上一镜' });
      sw.addEventListener('click', () => { r.on = !r.on; sw.classList.toggle('on', r.on); });

      const envTxt = r.env
        ? `净空 ${Math.round(r.env.openness || 0)} · 顶 ${Math.round(r.env.ceiling || 0)} · 水深 ${(r.env.submerged || 0).toFixed(1)}`
        : '';
      const len = Math.max(0, r.t1 - r.t0);

      box.appendChild(el('div', { class: 'cine-row' + (r.on ? '' : ' off') },
        el('div', { class: 'cine-ix', text: String(i + 1) }),
        sw,
        el('div', { class: 'cine-main' },
          el('b', { class: 'cine-label', text: r.label || r.kind }),
          el('div', { class: 'cine-sub', text: `第 ${(r.t0 / dur * 100).toFixed(0)}% ~ ${(r.t1 / dur * 100).toFixed(0)}%（${len.toFixed(1)}s）${r.onBeat ? ' · ♪ 卡点' : ''}` }),
          envTxt ? el('div', { class: 'cine-env', text: envTxt }) : null,
        ),
        el('div', { class: 'cine-ctl' },
          el('span', { class: 'cine-k', text: '运镜' }), sel,
          el('span', { class: 'cine-k', text: '节奏' }), paceIn,
        ),
        el('div', { class: 'cine-btns' },
          el('button', { class: 'xbtn sm', dataset: { cine: 'at', i: String(i) }, title: '跳到这一镜', text: '◎' }),
        ),
      ));
    });
  }

  _apply() {
    if (!this.player) return;
    this.player.applyEdits(this.rows);
    this.opts.onApplied && this.opts.onApplied();
  }

  _export() {
    const list = this.rows.map((r) => ({
      on: r.on, kind: r.kind, label: r.label, t0: r.t0, t1: r.t1,
      intensity: r.intensity, type: r.type, pace: r.pace,
      env: r.env ? {
        openness: Math.round(r.env.openness || 0), ceiling: Math.round(r.env.ceiling || 0),
        submerged: Number((r.env.submerged || 0).toFixed(2)),
      } : null,
    }));
    const name = (this.player && this.player.rec && this.player.rec.levelName) || 'replay';
    const vi = this.player && this.player.variantInfo ? this.player.variantInfo() : null;
    const variant = vi ? { style: vi.style, seed: vi.seed } : null;   // 带上就能原样复现这一版
    download(`洪梦运镜_${name}.json`, JSON.stringify({ v: 1, kind: 'fd.montage', variant, shots: list }, null, 2));
  }
}
