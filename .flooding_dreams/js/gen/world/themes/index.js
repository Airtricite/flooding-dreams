/* ============================================================
   主题白模 · 注册表
   ------------------------------------------------------------
   一个主题一份**专属的**程序化生成器（不再共用「风格 × 结构」的通用文法），
   并且由主题自己声明「我这套世界该切成哪几种结构、按什么次序搭配」——
   于是「主题决定世界结构的智能搭配」这句话在这里落地：

     themes/<主题>.js
        style       几何口吻（也决定角色/材质）
        structures  该主题适用的世界结构阶梯（按开阔度升序）
        depth       难度 1 时从阶梯的哪一档起（越难越往幽闭端探）
        build(c)    直接往体素格里画这一带的主题白模

   白模（whitebox.js）只负责：按带调 build → 封壳 → 通风井 → 攀登链 → 壁架。
   ============================================================ */
import * as lucidMeadow from './lucidMeadow.js';
import * as drownedCity from './drownedCity.js';
import * as bioAbyss from './bioAbyss.js';
import * as liminalHall from './liminalHall.js';
/* ---- 主题扩充包（20 个「一主题一世界结构」的专属白模） ---- */
import * as crystalCavern from './crystalCavern.js';
import * as volcanicRidge from './volcanicRidge.js';
import * as skyIslands from './skyIslands.js';
import * as sunkenForest from './sunkenForest.js';
import * as glacierFjord from './glacierFjord.js';
import * as desertMesa from './desertMesa.js';
import * as swampMangrove from './swampMangrove.js';
import * as coralReef from './coralReef.js';
import * as rustedFoundry from './rustedFoundry.js';
import * as subwayTerminus from './subwayTerminus.js';
import * as neonArcade from './neonArcade.js';
import * as serverVault from './serverVault.js';
import * as skyport from './skyport.js';
import * as hydroDam from './hydroDam.js';
import * as clockworkAtrium from './clockworkAtrium.js';
import * as mirrorGallery from './mirrorGallery.js';
import * as hospitalWing from './hospitalWing.js';
import * as casinoFloor from './casinoFloor.js';
import * as drownedLibrary from './drownedLibrary.js';
import * as cathedralNave from './cathedralNave.js';
/* ---- 命名结构预设（20 条「主题 id → 结构性格」，供结构下拉 / 报告读） ---- */
import { WORLD_STRUCTURES } from '../structures.js';

/** 风格 → 主题白模模块。
    ★ 键既包含 4 个基础「风格家族」，也包含 20 个主题 id ——
      于是「世界风格」本身就是 24 种，pcgFor(只给风格) 也能命中正确模块。 */
export const STYLE_PCG = {
  meadow: lucidMeadow,
  city: drownedCity,
  rock: bioAbyss,
  building: liminalHall,
  /* ---- 扩充：每个主题 id 也是它自己的风格（世界风格扩到 24 种） ---- */
  crystalCavern,
  volcanicRidge,
  skyIslands,
  sunkenForest,
  glacierFjord,
  desertMesa,
  swampMangrove,
  coralReef,
  rustedFoundry,
  subwayTerminus,
  neonArcade,
  serverVault,
  skyport,
  hydroDam,
  clockworkAtrium,
  mirrorGallery,
  hospitalWing,
  casinoFloor,
  drownedLibrary,
  cathedralNave,
};

/** 主题 id → 模块（主题注册表的 id 直接对应，省掉一层映射） */
export const THEME_PCG = {
  lucidMeadow,
  drownedCity,
  bioAbyss,
  liminalHall,
  /* ---- 扩充主题（各自声明自己的结构阶梯，不由 style 交叉出来） ---- */
  crystalCavern,
  volcanicRidge,
  skyIslands,
  sunkenForest,
  glacierFjord,
  desertMesa,
  swampMangrove,
  coralReef,
  rustedFoundry,
  subwayTerminus,
  neonArcade,
  serverVault,
  skyport,
  hydroDam,
  clockworkAtrium,
  mirrorGallery,
  hospitalWing,
  casinoFloor,
  drownedLibrary,
  cathedralNave,
};

/** 未知时回退：建筑内部（最通用的一张底图） */
export function pcgFor(style, themeId) {
  return (themeId && THEME_PCG[themeId]) || STYLE_PCG[style] || liminalHall;
}

/** (风格, 主题 id) → 命名结构 id —— 用来查 WORLD_STRUCTURES。
    ★ 主题 id 优先（主题专属），否则风格键本身也可能就是命名结构。 */
export function structureIdFor(style, themeId) {
  if (themeId && WORLD_STRUCTURES[themeId]) return themeId;
  if (style && WORLD_STRUCTURES[style]) return style;
  return null;
}

/** 主题声明的结构阶梯（智能搭配的数据来源）
    ★ 优先命名结构 preset 的 ladder（与主题模块逐项一致），否则回退模块自己的 structures。 */
export function structuresFor(style, themeId) {
  const preset = WORLD_STRUCTURES[structureIdFor(style, themeId)];
  if (preset && Array.isArray(preset.ladder) && preset.ladder.length) return preset.ladder.slice();
  const m = pcgFor(style, themeId);
  return Array.isArray(m.structures) && m.structures.length ? m.structures.slice() : ['indoor'];
}

/** 主题的世界结构「节奏」：rise = 一路向上；duplex = 两带一循环（室内↔露天）
    ★ 优先命名结构 preset 的 rhythm，再回退模块的 rhythm，再回退 'rise'。 */
export function rhythmFor(style, themeId) {
  const preset = WORLD_STRUCTURES[structureIdFor(style, themeId)];
  if (preset && preset.rhythm) return preset.rhythm === 'duplex' ? 'duplex' : 'rise';
  const m = pcgFor(style, themeId);
  return m.rhythm === 'duplex' ? 'duplex' : 'rise';
}

/** 难度 1 时从阶梯的哪一档起
    ★ 有命名结构 preset 时叠加它的 dive（结构性格偏移），没有就维持模块原值。 */
export function depthFor(style, themeId) {
  const m = pcgFor(style, themeId);
  const d = Number(m.depth);
  const base = Number.isFinite(d) ? Math.min(0.95, Math.max(0, d)) : 0.6;
  const preset = WORLD_STRUCTURES[structureIdFor(style, themeId)];
  const dive = preset ? Number(preset.dive) : NaN;
  if (!Number.isFinite(dive)) return base;
  return Math.min(0.95, Math.max(0, base + dive));
}

/** 报告 / UI 用：主题白模清单（style 即世界风格键，共 24 种） */
export function pcgList() {
  return Object.keys(STYLE_PCG).map((k) => {
    const preset = WORLD_STRUCTURES[k] || null;
    return {
      style: k,
      label: STYLE_PCG[k].label,
      structures: STYLE_PCG[k].structures.slice(),
      structure: preset ? preset.label : null,
    };
  });
}