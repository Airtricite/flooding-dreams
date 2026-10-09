/* ============================================================
   动画系统：属性补间时间线（编辑器动画编辑器的运行时）
   轨道 track = { objectId, property, type, keys:[{t,v,easing}] }
   ============================================================ */
import { clamp, lerp, ease, interpValue } from '../core/util.js';
import { easeSpecOf } from '../config.js';
import { getAnim } from './level.js';

export const ANIM_PROPS = [
  'position', 'rotation', 'scale', 'color', 'transparency', 'metalness', 'roughness',
  'emissiveIntensity', 'fillLevel', 'intensity', 'visible', 'opacity',
];

export function propType(prop) {
  if (prop === 'position' || prop === 'rotation' || prop === 'scale') return 'vec3';
  if (prop === 'color') return 'color';
  if (prop === 'visible') return 'bool';
  return 'number';
}
export function defaultValue(prop) {
  if (prop === 'position' || prop === 'rotation') return [0, 0, 0];
  if (prop === 'scale') return [4, 1, 4];
  if (prop === 'color') return '#ffffff';
  if (prop === 'visible') return true;
  if (prop === 'opacity') return 1;
  if (prop === 'intensity') return 1.6;
  if (prop === 'fillLevel') return 1;
  return 0;
}

export class AnimationSystem {
  constructor(builder, ctx = {}) {
    this.b = builder;
    this.level = builder.level;
    this.ctx = ctx;
    this.active = new Map();     // animId -> { t, dir, done }
    this.enabled = true;
    this.frameCache = new Map(); // objectId -> Set(property) 本帧已写入的属性（避免互相覆盖）
  }

  play(id) {
    const an = getAnim(this.level, id);
    if (!an) return false;
    this.active.set(id, { t: 0, dir: 1, done: false, an });
    return true;
  }
  stop(id) {
    if (id) this.active.delete(id);
    else this.active.clear();
  }
  isPlaying(id) { return this.active.has(id); }

  update(dt) {
    if (!this.enabled || !this.active.size) return;
    this.frameCache.clear();
    for (const [id, st] of this.active) {
      const an = st.an;
      st.t += dt * st.dir;
      const dur = an.duration || 1;
      if (st.t >= dur) {
        if (an.pingpong) { st.dir = -1; st.t = dur; }
        else if (an.loop) { st.t -= dur; }
        else { st.t = dur; st.done = true; }
      } else if (st.t <= 0 && st.dir < 0) {
        if (an.loop) st.t += dur;
        else { st.t = 0; st.done = true; st.dir = 1; }
      }
      this.apply(an, st.t);
      if (st.done && !an.loop && !an.pingpong) this.active.delete(id);
    }
  }

  /** 采样并写入对象 */
  apply(an, t) {
    for (const tr of an.tracks) {
      const rec = this.b.objects.get(tr.objectId);
      if (!rec || !tr.keys.length) continue;
      const v = sampleTrack(tr, t);
      this.write(rec, tr.property, v, tr.type);
    }
  }

  write(rec, prop, v, type) {
    const o = rec.o;
    switch (prop) {
      case 'position': case 'rotation': case 'scale':
        if (Array.isArray(v)) { o[prop] = [v[0], v[1], v[2]]; this.b.syncTransform(rec); }
        break;
      case 'color': case 'texture': case 'emissive':
        o[prop] = v; this.b.syncMaterial(rec);
        break;
      case 'transparency': case 'metalness': case 'roughness': case 'emissiveIntensity': case 'damage':
        o[prop] = Number(v) || 0; this.b.syncMaterial(rec);
        break;
      case 'opacity':
        o.transparency = 1 - clamp(Number(v) || 0, 0, 1);
        this.b.syncMaterial(rec);
        break;
      case 'visible':
        o.visible = !!v; this.b.syncVisibility(rec);
        break;
      case 'fillLevel':
        if (rec.liquid && this.ctx.liquids) this.ctx.liquids.setFill(rec, clamp(Number(v) || 0, 0, 1));
        break;
      case 'intensity':
        if (rec.light) { o.intensity = Number(v) || 0; rec.light.intensity = o.intensity; }
        break;
      default:
        if (type === 'number') o[prop] = Number(v) || 0;
        else o[prop] = v;
        break;
    }
  }

  stopAll() { this.active.clear(); }
}

/** 在关键帧之间采样 */
export function sampleTrack(tr, t) {
  const keys = tr.keys;
  if (!keys.length) return null;
  if (keys.length === 1) return keys[0].v;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t < t) i++;
  const a = keys[i], b = keys[i + 1];
  const span = b.t - a.t;
  const raw = span <= 0 ? 1 : (t - a.t) / span;
  const k = ease(easeSpecOf(a), raw);
  return interpValue(tr.type || 'number', a.v, b.v, k);
}

/** 排序 + 去重相邻帧 */
export function sortKeys(tr) {
  tr.keys.sort((a, b) => a.t - b.t);
  for (let i = tr.keys.length - 1; i > 0; i--) {
    if (Math.abs(tr.keys[i].t - tr.keys[i - 1].t) < 1e-4) tr.keys.splice(i, 1);
  }
}

export { interpValue, ease };