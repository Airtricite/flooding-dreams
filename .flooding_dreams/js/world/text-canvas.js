/* ============================================================
   文字贴图：把一段文字画进 canvas，生成可贴在物体上的 CanvasTexture
   —— 文字方块（立方体表面）与公告板 Billboard（悬浮文字）共用
   按内容 key 缓存并做有界淘汰，避免每帧重建 / 显存无限增长
   ============================================================ */
import * as THREE from 'three';
import { clamp } from '../core/util.js';

const CELL = 256;               // 立方体面图集每格的高度（画布 = 3×3 格）
const PLANE_H = 384;            // 公告板画布高度
const MAX_CACHE = 12;           // 缓存上限（有界 LRU）
const FONT_STACK = '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';

const _cache = new Map();       // key -> THREE.CanvasTexture

/** 折行：CJK 逐字断行，西文按词断行；显式 \n 强制换行 */
function wrapLines(x, text, maxW) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw) { out.push(''); continue; }
    const units = raw.match(/[A-Za-z0-9@#%&'’\-_.]+|\s+|[^\s]/g) || [];
    let line = '';
    for (const u of units) {
      const next = line + u;
      if (line && x.measureText(next).width > maxW) {
        out.push(line.replace(/\s+$/, ''));
        line = /^\s+$/.test(u) ? '' : u;
      } else line = next;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

/**
 * 规范化富文本段落：过滤空段、夹取样式；无有效内容返回 null
 * 每段 = { t 文本（可含 \n）, b 加粗, i 斜体, u 下划线, c 颜色, s 字号倍率 }
 */
function normRuns(runs) {
  if (!Array.isArray(runs)) return null;
  const out = [];
  for (const r of runs) {
    if (!r) continue;
    const t = String(r.t ?? '');
    if (!t) continue;
    out.push({
      t,
      b: !!r.b,
      i: !!r.i,
      u: !!r.u,
      c: (typeof r.c === 'string' && /^#[0-9a-f]{6}$/i.test(r.c)) ? r.c : null,
      s: clamp(Number(r.s) || 1, 0.3, 4),
    });
  }
  return out.length ? out : null;
}

/** 富文本 → 排版原子（词 / 单个 CJK 字符 / 空格 / 换行标记），每个原子携带样式 */
function richAtoms(runs) {
  const atoms = [];
  for (const r of runs) {
    const segs = r.t.split('\n');
    for (let si = 0; si < segs.length; si++) {
      if (si > 0) atoms.push({ nl: true, r });
      const seg = segs[si];
      if (!seg) continue;
      const units = seg.match(/[A-Za-z0-9@#%&'’\-_.]+|\s+|[^\s]/g) || [];
      for (const u of units) atoms.push({ u, r });
    }
  }
  return atoms;
}

/** canvas 字体串：斜体在字重前、字号前 */
function fontStr(r, size) { return `${r.i ? 'italic ' : ''}${r.b ? 700 : 400} ${size}px ${FONT_STACK}`; }

/** 富文本折行（逐原子按各自字号量宽），行数太多时整体缩字号直到铺满 */
function layoutRich(x, atoms, size0, availW, availH) {
  let size = size0;
  let lines = [];
  for (let it = 0; it < 5; it++) {
    lines = [];
    let cur = { w: 0, items: [], maxS: size };
    for (const a of atoms) {
      if (a.nl) { lines.push(cur); cur = { w: 0, items: [], maxS: size }; continue; }
      const fs = size * a.r.s;
      x.font = fontStr(a.r, fs);
      const w = x.measureText(a.u).width;
      if (cur.items.length && cur.w + w > availW) {
        lines.push(cur);
        cur = { w: 0, items: [], maxS: size };
        if (/^\s+$/.test(a.u)) continue;
      }
      cur.items.push({ u: a.u, r: a.r, w, fs });
      cur.w += w;
      if (fs > cur.maxS) cur.maxS = fs;
    }
    lines.push(cur);
    let total = 0;
    for (const ln of lines) total += ln.maxS * 1.22;
    if (total <= availH || size <= 8) break;
    size = Math.max(8, size * Math.sqrt(availH / total));
  }
  return { lines, size };
}

/**
 * 生成文字贴图（同参数复用同一张纹理）
 * @param o.text      文本内容（支持 \n 换行与自动折行）
 * @param o.color     文字颜色
 * @param o.bg        底色
 * @param o.bgOpacity 底色不透明度（0 = 透明背景）
 * @param o.fontSize  字号（画布像素）
 * @param o.bold      是否加粗
 * @param o.align     水平对齐 left | center | right
 * @param o.valign    垂直对齐 top | center | bottom
 * @param o.padding   四周留白比例（0~0.4）
 * @param o.aspect    画布宽高比（宽 = 高 × aspect）
 * @param o.atlas     立方体面图集：画成 3×3，文字只落在 +Z 面那一格
 */
export function textTexture(o = {}) {
  const text = String(o.text ?? '');
  const color = o.color || '#ffffff';
  const bg = o.bg || '#000000';
  const bgOpacity = clamp(Number(o.bgOpacity ?? 0), 0, 1);
  const bold = !!o.bold;
  const align = o.align === 'left' || o.align === 'right' ? o.align : 'center';
  const valign = o.valign === 'top' || o.valign === 'bottom' ? o.valign : 'center';
  const pad = clamp(Number(o.padding ?? 0.07), 0, 0.4);
  const aspect = clamp(Number(o.aspect) || 1, 0.2, 5);
  const size0 = clamp(Number(o.fontSize) || 72, 8, 240);
  const atlas = !!o.atlas;
  const runs = normRuns(o.runs);

  const cellH = atlas ? CELL : PLANE_H;
  const cellW = Math.max(8, Math.round(cellH * aspect));
  const cw = atlas ? cellW * 3 : cellW;
  const ch = atlas ? cellH * 3 : cellH;
  const ox = atlas ? cellW : 0;          // 文字绘制区左上角（图集时 = +Z 面那一格）
  const oy = atlas ? cellH : 0;

  const key = [text, runs ? JSON.stringify(runs) : '', color, bg, bgOpacity.toFixed(2), bold ? 1 : 0, align, valign,
    pad.toFixed(2), aspect.toFixed(2), size0, atlas ? 'a' : ''].join('|');
  const hit = _cache.get(key);
  if (hit) { _cache.delete(key); _cache.set(key, hit); return hit; }   // 命中刷新 LRU 次序

  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const x = c.getContext('2d');
  const availW = cellW * (1 - pad * 2);
  const availH = cellH * (1 - pad * 2);

  // 底色：图集模式铺满整张（另外 5 个面显示底色），文字只画在前脸
  if (bgOpacity > 0.001) {
    x.globalAlpha = bgOpacity;
    x.fillStyle = bg;
    x.fillRect(0, 0, cw, ch);
    x.globalAlpha = 1;
  }

  if (runs) {
    /* ---------- 富文本：逐段样式 + 逐原子折行 ---------- */
    const { lines, size } = layoutRich(x, richAtoms(runs), size0, availW, availH);
    let totalH = 0;
    for (const ln of lines) totalH += ln.maxS * 1.22;
    const blockTop = oy + (valign === 'top' ? pad * cellH
      : valign === 'bottom' ? cellH - pad * cellH - totalH
        : (cellH - totalH) / 2);
    x.textAlign = 'left';
    x.textBaseline = 'middle';
    x.shadowColor = 'rgba(0,0,0,0.55)';
    x.shadowBlur = Math.max(2, size * 0.16);
    x.shadowOffsetY = Math.max(1, size * 0.03);
    let yy = blockTop;
    for (const ln of lines) {
      const lh = ln.maxS * 1.22;
      const cy = yy + lh / 2;
      let cx = ox + (align === 'left' ? pad * cellW
        : align === 'right' ? cellW - pad * cellW - ln.w
          : (cellW - ln.w) / 2);
      for (const it of ln.items) {
        x.font = fontStr(it.r, it.fs);
        x.fillStyle = it.r.c || color;
        x.fillText(it.u, cx, cy);
        if (it.r.u) {                     // 下划线：去掉投影避免糊成一片
          x.shadowColor = 'rgba(0,0,0,0)';
          x.fillRect(cx, cy + it.fs * 0.42, it.w, Math.max(1, it.fs * 0.07));
          x.shadowColor = 'rgba(0,0,0,0.55)';
        }
        cx += it.w;
      }
      yy += lh;
    }
  } else {
    /* ---------- 纯文本 ---------- */
    // 自动缩字号：行数太多时按面积比例缩小，尽量铺满
    let size = size0;
    let lines = [];
    for (let i = 0; i < 4; i++) {
      x.font = `${bold ? 700 : 400} ${size}px ${FONT_STACK}`;
      lines = wrapLines(x, text, availW);
      const total = Math.max(1, lines.length) * size * 1.22;
      if (total <= availH || size <= 8) break;
      size = Math.max(8, size * Math.sqrt(availH / total));
    }
    x.font = `${bold ? 700 : 400} ${size}px ${FONT_STACK}`;
    x.textAlign = align;
    x.textBaseline = 'middle';

    const lineH = size * 1.22;
    const blockH = lines.length * lineH;
    let y = oy + (valign === 'top' ? pad * cellH + lineH / 2
      : valign === 'bottom' ? cellH - pad * cellH - blockH + lineH / 2
        : (cellH - blockH) / 2 + lineH / 2);
    const tx = ox + (align === 'left' ? pad * cellW : align === 'right' ? cellW - pad * cellW : cellW / 2);

    // 轻微投影：保证浅色文字在亮背景 / 亮场景里也能看清
    x.fillStyle = color;
    x.shadowColor = 'rgba(0,0,0,0.55)';
    x.shadowBlur = Math.max(2, size * 0.16);
    x.shadowOffsetY = Math.max(1, size * 0.03);
    for (const ln of lines) { x.fillText(ln, tx, y); y += lineH; }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;

  _cache.set(key, t);
  // 有界淘汰：超出上限时释放最旧的贴图（仍被材质引用的会在下次渲染时自动重传）
  while (_cache.size > MAX_CACHE) {
    const k = _cache.keys().next().value;
    const old = _cache.get(k);
    _cache.delete(k);
    if (old) old.dispose();
  }
  return t;
}

/** 释放全部文字贴图（只在整体销毁时调用；编辑器试玩退出时不要调用） */
export function disposeTextTextures() {
  for (const t of _cache.values()) t.dispose();
  _cache.clear();
}
