/* ============================================================
   选关面板上的「地图变体」选择条（MapModifier）
   ------------------------------------------------------------
   选关界面与关卡包节点地图共用同一个 `mountModifierBar(host)`：
   把一个下拉框挂进面板，写入 settings 的 modifier.mode。
   默认「意外惊喜」—— 每局小概率命中，命中后进入若干局冷却（状态从存档里读）。
   ============================================================ */
import { el } from './dom.js';
import { GridSelect } from './grid-picker.js';
import { settings } from '../core/settings.js';
import {
  MODIFIER_MODES, modifierOfMode, modifierLabel, peekCooldown,
  SURPRISE_CHANCE, SURPRISE_COOLDOWN,
} from '../game/modifier.js';

const mounted = new WeakSet();

function currentMode() {
  const m = settings.get('modifier.mode', 'auto');
  return MODIFIER_MODES.some((x) => x.k === m) ? m : 'auto';
}

/**
 * 把一个变体选择条挂到 host（只挂一次）。
 * @returns {{refresh:Function}|null}
 */
export function mountModifierBar(host) {
  if (!host || mounted.has(host)) return null;
  mounted.add(host);

  const sel = new GridSelect({
    value: currentMode(),
    cls: 'inp lv-var-sel',
    options: MODIFIER_MODES.map((m) => ({ v: m.k, l: m.l })),
    onChange: (v) => { settings.set('modifier.mode', v); refresh(); },
  });
  const hint = el('span', { class: 'lv-var-hint' });
  const wrap = el('div', { class: 'lv-variant' },
    el('span', { class: 'lv-var-lab', text: '地图变体' }), sel, hint);
  host.appendChild(wrap);

  const refresh = () => {
    const mode = currentMode();
    sel.setValue(mode);
    if (mode === 'auto') {
      const pct = Math.round(SURPRISE_CHANCE * 100);
      hint.textContent = `每局 ${pct}% 意外发生，命中后冷却 ${SURPRISE_COOLDOWN} 局`;
      peekCooldown().then((st) => {
        if (currentMode() !== 'auto') return;      // 期间改过设置就别覆盖
        hint.textContent = st.cooling
          ? `意外惊喜冷却中：还要 ${SURPRISE_COOLDOWN - st.since} 局`
          : `每局 ${pct}% 意外发生（镜像 / 变速 / 两者叠加）`;
      }).catch(() => { /* 读不到存档就显示基础说明 */ });
    } else if (mode === 'off') {
      hint.textContent = '关闭：每局都按原样开始';
    } else {
      hint.textContent = '每局固定：' + modifierLabel(modifierOfMode(mode));
    }
  };

  refresh();
  return { refresh };
}
