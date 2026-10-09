/* ============================================================
   帮助面板
   —— 内容按条目构建：文案经 textContent / innerHTML 写入，
      自动接入 i18n（切换语言时原地生效）
   ============================================================ */
import { $, el, clear } from './dom.js';
import { bindActs } from './menu.js';
import { settings } from '../core/settings.js';

function kbd(txt) { return el('kbd', { text: txt }); }

/** 把某个动作的按键以小标签追加到容器（未绑定时显示「未绑定」） */
function appendKeys(box, acts) {
  acts.forEach((act, ai) => {
    const codes = settings.get('bindings.' + act, []);
    if (ai) box.appendChild(el('i', { text: ' ' }));
    if (!codes.length) { box.appendChild(kbd('未绑定')); return; }
    codes.forEach((c) => box.appendChild(kbd(settings.constructor.keyName(c))));
  });
}

/**
 * 填充一格内容：cell 是字符串（可含 <b>/<kbd> 等标记）
 * 或 [{ html: '…' }, { keys: ['jump'], after: '…' }] 片段数组
 */
function fill(box, cell) {
  for (const seg of (Array.isArray(cell) ? cell : [cell])) {
    if (typeof seg === 'string') {
      const w = el('span');
      w.innerHTML = seg;
      box.appendChild(w);
    } else if (seg && seg.keys) {
      appendKeys(box, seg.keys);
      if (seg.after) box.appendChild(el('span', { text: seg.after }));
    }
  }
}

/* 帮助内容（h=标题 p=段落 ul=无序列表 tb=表格行[label, 内容]） */
const HELP = [
  { h: '这是什么', p: ['《Flooding Dreams 洪梦》是一个在梦里逃生的第一/第三人称跑酷游戏。 水会一直涨，你只能往上跑。每一个梦都比上一个更深、更暗。'] },
  {
    h: '基本操作',
    tb: [
      ['移动', { keys: ['forward', 'left', 'backward', 'right'] }],
      ['视角', '移动鼠标（点击画面锁定鼠标）'],
      ['缩放 / 第一人称', '滚轮；一直拉近即进入第一人称'],
      ['跳跃 / 水中上浮', { keys: ['jump'] }],
      ['下潜 / 空中速降 / 滑铲', [{ keys: ['dive'] }, '（在地面按下即滑铲，可穿过低矮墙洞）']],
      ['交互 / 使用工具', { keys: ['interact'] }],
      ['切换视角', { keys: ['cameraToggle'] }],
      ['暂停', { keys: ['pause'] }],
    ],
  },
  { p: ['当鼠标准星指向可交互的物件、或手上拿着工具时，左键<b>不会</b>触发下潜，优先执行交互。'] },
  {
    h: '液体与氧气',
    ul: [
      '<b>水</b>：每秒消耗 8 点氧气，游动可加速上浮。',
      '<b>酸</b>：每秒消耗 30 点氧气，非常危险。',
      '<b>熔岩</b>：碰到即死。',
      '判定标准是<b>液面淹过你的头</b>。氧气耗尽后开始掉血。',
      '出水后氧气会自然恢复（部分关卡被设计成不会恢复），<b>氧气球</b>能立刻补充额外的氧气。',
    ],
  },
  {
    h: '机关',
    ul: [
      '<b>WallJump 墙</b>：贴着带箭头的墙按跳跃会斜向飞出，超时不下落。',
      '<b>滑索</b>：靠近后自动抓住，沿着索道滑行。',
      '<b>按钮</b>：身体碰到就会触发。',
      '<b>检查点</b>：碰到后死亡会回到这里。',
    ],
  },
  {
    h: '关卡编辑器',
    tb: [
      ['视角', '中键拖动旋转 · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 飞行（越飞越快，松开恢复）· <kbd>Q</kbd><kbd>E</kbd> 升降 · <kbd>Shift</kbd> 加速'],
      ['选择 / 多选', '左键点击对象 · <kbd>Ctrl</kbd>+点击 多选 · 在空白处拖拽框选'],
      ['编辑组件', '<kbd>1</kbd> 移动 <kbd>2</kbd> 缩放 <kbd>3</kbd> 旋转 <kbd>4</kbd> 自由（世界/局部切换）'],
      ['复制 / 粘贴 / 删除', ['<kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> / ', { keys: ['editorDelete'] }]],
      ['撤销 / 重做', '<kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd>'],
      ['涂鸦模式', [{ keys: ['editorPaint'] }, ' 进入，鼠标射线在任意模型上涂画；滚轮调整笔触大小']],
      ['图层', '右下角「图层」面板：新建/删除图层，高图层覆盖低图层'],
    ],
  },
  {
    h: '小提示',
    ul: [
      '跳跃高度约 7 studs，水平跳跃距离约 10 studs —— 关卡设计时请参考这个数值。',
      '掉出世界会死亡并回到检查点；部分关卡有死亡次数上限。',
      '通关后会记录最佳时间，「我的关卡」可以导出成 .fdlevel 文件分享给别人。',
    ],
  },
];

export class HelpPanel {
  constructor(opts = {}) {
    this.opts = opts;
    this.root = $('#help');
    this.body = $('#help-body');
    bindActs(this.root, (act) => { if (act === 'close') this.opts.onClose && this.opts.onClose(); });
  }

  open() { this.build(); }

  build() {
    const b = this.body;
    if (!b) return;
    clear(b);
    for (const blk of HELP) {
      if (blk.h) b.appendChild(el('h3', { text: blk.h }));
      for (const s of blk.p || []) {
        const p = el('p');
        fill(p, s);
        b.appendChild(p);
      }
      if (blk.ul) {
        const ul = el('ul');
        for (const it of blk.ul) {
          const li = el('li');
          fill(li, it);
          ul.appendChild(li);
        }
        b.appendChild(ul);
      }
      if (blk.tb) {
        const tb = el('table');
        for (const row of blk.tb) {
          const tr = el('tr');
          tr.appendChild(el('td', { text: row[0] }));
          const td = el('td');
          fill(td, row[1]);
          tr.appendChild(td);
          tb.appendChild(tr);
        }
        b.appendChild(tb);
      }
    }
  }
}