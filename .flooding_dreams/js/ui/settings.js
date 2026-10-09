/* ============================================================
   设置面板：操作 / 视角 / 画面 / 声音 / 其他
   ============================================================ */
import { $, el, clear, toast, confirmBox } from './dom.js';
import { GridSelect } from './grid-picker.js';
import { bindActs } from './menu.js';
import { settings } from '../core/settings.js';
import { LANGS, setLang, lang } from '../core/i18n.js';
import { BIND_LABELS } from '../config.js';

const GROUPS = ['移动', '动作', '界面', '编辑器'];

/* 每个控件的定义：k=设置路径 l=标签 t=类型 */
const TABS = {
  control: [
    { g: '鼠标' },
    { k: 'mouse.sensitivity', l: '鼠标灵敏度', t: 'range', min: 0.2, max: 3, st: 0.05, f: (v) => Number(v).toFixed(2) },
    { k: 'mouse.smooth', l: '视角平滑', t: 'range', min: 0, max: 0.8, st: 0.02, f: (v) => Number(v).toFixed(2), s: '0 = 完全跟手' },
    { k: 'mouse.invertY', l: '反转纵向', t: 'bool' },
    { g: '按键绑定', s: '点击按钮后按下新按键（右键清除）' },
  ],
  camera: [
    { k: 'camera.fov', l: '视野 FOV', t: 'range', min: 50, max: 120, st: 1, f: (v) => Math.round(v) + '°' },
    { k: 'camera.defaultMode', l: '默认视角', t: 'select', o: [['third', '第三人称'], ['first', '第一人称']] },
    { k: 'camera.thirdDistance', l: '第三人称距离', t: 'range', min: 6, max: 60, st: 1, f: (v) => Math.round(v) },
    { k: 'camera.maxDistance', l: '最大缩放距离', t: 'range', min: 12, max: 200, st: 2, f: (v) => Math.round(v) },
    { k: 'camera.shake', l: '震屏强度', t: 'range', min: 0, max: 2, st: 0.05, f: (v) => Number(v).toFixed(2) },
    { k: 'camera.rollAmount', l: '侧移倾斜', t: 'range', min: 0, max: 1, st: 0.05, f: (v) => Number(v).toFixed(2) },
    { k: 'camera.fovKick', l: '速度感 FOV 变化', t: 'bool' },
  ],
  video: [
    { k: 'video.quality', l: '画质档位', t: 'select', o: [['auto', '自动'], ['low', '低'], ['medium', '中'], ['high', '高']], s: '低端设备请选低，可显著提升流畅度；「高」额外开启高光反射与接缝闭塞阴影' },
    { k: 'video.maxPixelRatio', l: '最大渲染倍率', t: 'range', min: 0.5, max: 2, st: 0.05, f: (v) => Number(v).toFixed(2) },
    { k: 'video.shadows', l: '阴影', t: 'bool' },
    { k: 'video.fog', l: '雾', t: 'bool' },
    { k: 'video.particles', l: '粒子特效', t: 'bool' },
    { k: 'video.waterWaves', l: '水面波动', t: 'bool' },
    { k: 'video.occlusionCulling', l: '遮挡剔除', t: 'bool',
      s: '隐藏被墙完全挡住的物体，提升室外 / 多房间地图的流畅度；关闭可排除画面物件消失的异常' },
    { k: 'video.antialias', l: '抗锯齿', t: 'bool', s: '需要刷新页面后生效' },
    { k: 'video.renderWorker', l: '渲染线程', t: 'select',
      o: [['off', '进程内（默认）'], ['auto', '自动'], ['on', '独立线程']],
      s: '把渲染放到独立线程，主线程只跑物理与输入，减少卡顿；需要刷新页面后生效，异常时自动回退' },
  ],
  audio: [
    { k: 'audio.master', l: '总音量', t: 'range', min: 0, max: 1, st: 0.02, f: (v) => Math.round(v * 100) + '%' },
    { k: 'audio.sfx', l: '音效', t: 'range', min: 0, max: 1, st: 0.02, f: (v) => Math.round(v * 100) + '%' },
    { k: 'audio.ambience', l: '环境音', t: 'range', min: 0, max: 1, st: 0.02, f: (v) => Math.round(v * 100) + '%' },
    { k: 'audio.music', l: '背景音乐', t: 'range', min: 0, max: 1, st: 0.02, f: (v) => Math.round(v * 100) + '%' },
  ],
  misc: [
    { g: '玩家' },
    { k: 'player.showName', l: '显示玩家名牌', t: 'bool', s: '在角色头顶显示名字' },
    { k: 'player.name', l: '玩家名', t: 'text', p: '留空则不显示' },
    { g: '回放', s: '记录仪会把每一局游玩录下来' },
    { k: 'replay.saveRatio', l: '回放保存阈值', t: 'range', min: 0, max: 150, st: 5,
      f: (v) => Math.round(v) + '%',
      s: '本局时长达到「关卡时长」的这个比例才保存；0 = 全都保存。太短的局不占存档位' },
    { g: '界面与编辑器' },
    { k: 'ui.scaleMode', l: '界面缩放', t: 'select', o: [['auto', '自动适配分辨率'], ['manual', '手动']],
      s: '自动：以 1920×1080 为基准，低分辨率下界面自动缩小，高分屏不放大' },
    { k: 'ui.scale', l: '手动缩放倍率', t: 'range', min: 0.4, max: 2, st: 0.05,
      f: (v) => Number(v).toFixed(2) + '×', s: '仅当上方选「手动」时生效' },
    { k: 'ui.fontSize', l: '字体大小', t: 'range', min: -8, max: 24, st: 1,
      f: (v) => (Number(v) > 0 ? '+' : '') + Math.round(v) + 'px',
      s: '相对标准正文基准（16px）的像素增量，精确到 1px；标题 / 倒数等艺术性文字不受影响' },
    { k: 'lang', l: '界面语言', t: 'lang', s: '切换后立即生效，无需刷新页面' },
    { k: 'misc.showFps', l: '显示帧率', t: 'bool' },
    { k: 'misc.showHints', l: '显示游戏提示', t: 'bool' },
    { k: 'misc.autosaveEditor', l: '编辑器自动保存', t: 'bool' },
    { k: 'misc.orbitInvert', l: '反转轨道旋转', t: 'bool' },
    { k: 'misc.editorFlySpeed', l: '编辑器飞行初速', t: 'range', min: 10, max: 300, st: 5, f: (v) => Math.round(v) },
  ],
};

export class SettingsPanel {
  /** opts { onClose(), onChange(path,value) } */
  constructor(opts = {}) {
    this.opts = opts;
    this.root = $('#settings');
    this.panes = $('#st-panes');
    this.tabs = $('#st-tabs');
    this.tab = 'control';
    this.rows = [];
    bindActs(this.root, (act) => {
      if (act === 'close') return this.close();
      if (act === 'reset') return this.resetAll();
    });
    if (this.tabs) {
      this.tabs.addEventListener('click', (ev) => {
        const b = ev.target.closest('.tab');
        if (!b) return;
        this.tab = b.dataset.tab;
        this.build();
      });
    }
    if (this.panes) {
      // 键盘绑定需要在捕获时忽略全局输入
      this.panes.addEventListener('contextmenu', (ev) => {
        const kb = ev.target.closest('.keybind');
        if (!kb) return;
        ev.preventDefault();
        this.clearBind(kb.dataset.act);
      });
    }
  }

  open() { this.build(); }
  close() { this.opts.onClose && this.opts.onClose(); }

  build() {
    if (!this.panes) return;
    if (this.tabs) {
      for (const b of this.tabs.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === this.tab);
    }
    clear(this.panes);
    this.rows = [];
    for (const item of TABS[this.tab] || []) {
      if (item.g) {
        this.panes.appendChild(el('div', { class: 'set-group', html: item.g + (item.s ? ` <span style="text-transform:none;letter-spacing:0;font-size:calc(11px * var(--ui-s) * var(--ui-fs))">— ${item.s}</span>` : '') }));
        if (this.tab === 'control' && item.g === '按键绑定') this.buildBindings();
        continue;
      }
      this.panes.appendChild(this.rowFor(item));
    }
  }

  rowFor(item) {
    const val = settings.get(item.k);
    const ctl = el('div', { class: 'ctl' });
    const row = el('div', { class: 'set-row' },
      el('label', {}, el('span', { text: item.l }), item.s ? el('span', { class: 'sub', text: item.s }) : null),
      ctl,
    );
    if (item.t === 'bool') {
      const sw = el('button', { class: 'switch' + (val ? ' on' : ''), type: 'button' });
      sw.addEventListener('click', () => {
        const nv = !settings.get(item.k);
        sw.classList.toggle('on', nv);
        this.set(item.k, nv);
      });
      ctl.appendChild(sw);
    } else if (item.t === 'select') {
      const sel = new GridSelect({
        value: val,
        cls: 'inp',
        options: item.o.map(([v, l]) => ({ v, l })),
        onChange: (v) => this.set(item.k, v),
      });
      ctl.appendChild(sel.el);
    } else if (item.t === 'text') {
      // 文本设置：输入时即时生效（先静默、失焦/回车再广播一次）
      const inp = el('input', { class: 'inp', type: 'text', value: val == null ? '' : String(val), placeholder: item.p || '' });
      inp.addEventListener('input', () => this.set(item.k, inp.value, true));
      inp.addEventListener('change', () => this.set(item.k, inp.value));
      ctl.appendChild(inp);
    } else if (item.t === 'lang') {
      // 界面语言：切换后原地生效（语言名一律用母语写法，不参与翻译）
      const sel = new GridSelect({
        value: lang(),
        cls: 'inp',
        options: LANGS.map((L) => ({ v: L.v, l: L.native })),
        onChange: async (v) => {
          await setLang(v);
          this.tab = 'misc';
          this.build();
        },
      });
      ctl.appendChild(sel.el);
    } else {
      const num = el('span', { class: 'val', text: item.f ? item.f(val) : String(val) });
      const r = el('input', { type: 'range', min: item.min, max: item.max, step: item.st || 1, value: val });
      r.addEventListener('input', () => {
        const v = Number(r.value);
        num.textContent = item.f ? item.f(v) : String(v);
        this.set(item.k, v, true);
      });
      r.addEventListener('change', () => this.set(item.k, Number(r.value)));
      ctl.appendChild(r);
      ctl.appendChild(num);
    }
    this.rows.push({ item, row });
    return row;
  }

  /* ---------- 按键绑定 ---------- */
  buildBindings() {
    const seen = new Set();
    for (const act in BIND_LABELS) {
      const grp = groupOf(act);
      if (!seen.has(grp)) {
        seen.add(grp);
        this.panes.appendChild(el('div', { class: 'set-group', text: grp }));
      }
      const btn = el('button', { class: 'keybind', dataset: { act }, type: 'button' });
      this.paintBind(btn, act);
      btn.addEventListener('click', () => this.captureBind(act));
      this.panes.appendChild(el('div', { class: 'set-row' },
        el('label', {}, el('span', { text: BIND_LABELS[act] })),
        el('div', { class: 'ctl' }, btn),
      ));
    }
  }
  paintBind(btn, act) {
    const codes = settings.get('bindings.' + act, []);
    btn.textContent = codes.length
      ? codes.map((c) => settings.constructor.keyName(c)).join(' / ')
      : '未绑定';
    btn.classList.toggle('listening', false);
    btn.dataset.codes = codes.join(',');
  }
  async captureBind(act) {
    const btn = this.panes.querySelector(`.keybind[data-act="${act}"]`);
    if (!btn) return;
    btn.classList.add('listening');
    btn.textContent = '按下按键…';
    const code = await captureKey();
    btn.classList.remove('listening');
    if (!code) { this.paintBind(btn, act); return; }
    const other = Object.keys(BIND_LABELS).find((a) => a !== act && settings.isBound(a, code));
    if (other) {
      this.paintBind(btn, act);
      toast(`「${settings.constructor.keyName(code)}」已绑定给「${BIND_LABELS[other]}」`, 'err');
      return;
    }
    const cur = settings.get('bindings.' + act, []).filter((c) => c !== code);
    settings.setBinding(act, [code, ...cur].slice(0, 3));
    this.paintBind(btn, act);
    this.opts.onChange && this.opts.onChange('bindings.' + act, code);
  }
  clearBind(act) {
    settings.setBinding(act, []);
    const btn = this.panes.querySelector(`.keybind[data-act="${act}"]`);
    if (btn) this.paintBind(btn, act);
    toast('已清除绑定', 'ok', 1200);
  }

  set(k, v, silent) {
    settings.set(k, v, silent);
    if (!silent) this.opts.onChange && this.opts.onChange(k, v);
  }

  async resetAll() {
    if (!await confirmBox('恢复所有设置为默认值？（按键绑定也会重置）', { title: '恢复默认', ok: '恢复' })) return;
    settings.reset();
    // 语言在设置里也有存储，恢复默认后要跟着切回去
    if (settings.get('lang', 'zh') !== lang()) await setLang(settings.get('lang', 'zh'));
    toast('已恢复默认设置', 'ok');
    this.build();
    this.opts.onChange && this.opts.onChange('*', null);
  }
}

function groupOf(act) {
  if (['forward', 'backward', 'left', 'right'].includes(act)) return GROUPS[0];
  if (['jump', 'dive', 'interact', 'useTool', 'inventory', 'cameraToggle'].includes(act)) return GROUPS[1];
  if (['pause'].includes(act)) return GROUPS[2];
  return GROUPS[3];
}

/** 捕获一次按键/鼠标（阻止默认行为） */
function captureKey() {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', kd, true);
      window.removeEventListener('mousedown', md, true);
      resolve(v);
    };
    const kd = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') fin(null);
      else fin(e.code);
    };
    const md = (e) => {
      e.preventDefault(); e.stopPropagation();
      fin('Mouse' + e.button);
    };
    window.addEventListener('keydown', kd, true);
    window.addEventListener('mousedown', md, true);
  });
}