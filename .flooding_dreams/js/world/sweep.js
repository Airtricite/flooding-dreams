/* ============================================================
   沿曲线扫掠任意截面 → BufferGeometry
   用 Frenet 标架把 2D 截面多边形推到曲线的每一帧上，构造管状几何。
   支持：任意（含凹）截面多边形、两端封口、空心管壁。

   uv：u = 沿路径弧长（stud），v = 沿截面周长（stud），封口 = 截面坐标（stud）
   —— 与方块「平铺不拉伸」同一量纲：材质层 repeat = 1/贴图尺寸(stud)，
      每格贴图的世界边长 = 贴图尺寸(stud)，小=密集，大=稀疏
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** 多边形形心 */
function centroid2D(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

/** 每条边的外法线（背离形心）+ 顶点处的平均外法线 */
function edgeNormals2D(poly) {
  const n = poly.length;
  const c = centroid2D(poly);
  const edge = [];
  for (let j = 0; j < n; j++) {
    const a = poly[j], b = poly[(j + 1) % n];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1e-6;
    dx /= len; dy /= len;
    let nx = dy, ny = -dx;
    const mx = (a[0] + b[0]) / 2 - c[0], my = (a[1] + b[1]) / 2 - c[1];
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
    edge.push([nx, ny]);
  }
  const vert = [];
  for (let j = 0; j < n; j++) {
    const e0 = edge[(j - 1 + n) % n], e1 = edge[j];
    let nx = e0[0] + e1[0], ny = e0[1] + e1[1];
    const len = Math.hypot(nx, ny) || 1e-6;
    vert.push([nx / len, ny / len]);
  }
  return { edge, vert };
}

/** 周长累计（stud，长度 n+1，最后一项 = 总周长，供接缝顶点用） */
function perimeterV(poly) {
  const n = poly.length;
  const cum = [0];
  for (let j = 0; j < n; j++) {
    const a = poly[j], b = poly[(j + 1) % n];
    cum.push(cum[j] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return cum;
}

/** 形心到各边的最近距离（内切半径近似） */
function inradius2D(poly, c) {
  const n = poly.length;
  let r = Infinity;
  for (let j = 0; j < n; j++) {
    const a = poly[j], b = poly[(j + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1e-6;
    let t = ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    r = Math.min(r, Math.hypot(a[0] + dx * t - c[0], a[1] + dy * t - c[1]));
  }
  return r;
}

/**
 * 重力对齐标架（upright）：截面只由「墙厚方向 n（水平、垂直于路径）」和
 * 「墙高方向 u（默认竖直）」决定，**不随路径扭转**。
 * tilt（弧度）让整个截面绕路径切线旋转：0 = 始终竖直。
 * @returns {{tangents:THREE.Vector3[], normals:THREE.Vector3[], binormals:THREE.Vector3[]}}
 */
function uprightFrames(curve, seg, tilt) {
  const tangents = [], normals = [], binormals = [];
  const up = new THREE.Vector3(0, 1, 0);
  const t = new THREE.Vector3(), n = new THREE.Vector3(), u = new THREE.Vector3();
  const prev = new THREE.Vector3(1, 0, 0);
  const c = Math.cos(tilt), s = Math.sin(tilt);
  for (let i = 0; i <= seg; i++) {
    curve.getTangentAt(i / seg, t).normalize();
    // 必须右手系：与 Frenet 一致（B = T × N），否则逆时针截面会被翻成朝内
    n.crossVectors(up, t);
    // 路径竖直（切线与 up 平行）时叉积退化：沿用上一帧的厚度方向，避免截面翻转
    if (n.lengthSq() < 1e-8) n.copy(prev);
    else { n.normalize(); prev.copy(n); }
    u.crossVectors(t, n).normalize();      // 与 n / t 正交的「上」方向
    tangents.push(t.clone());
    normals.push(new THREE.Vector3(n.x * c + u.x * s, n.y * c + u.y * s, n.z * c + u.z * s));
    binormals.push(new THREE.Vector3(u.x * c - n.x * s, u.y * c - n.y * s, u.z * c - n.z * s));
  }
  return { tangents, normals, binormals };
}

/**
 * @param {THREE.Curve} curve      已建好的路径曲线
 * @param {Array<[number,number]>} section2D  截面多边形（已按半径缩放，单位 = stud）
 * @param {number} div             沿路径的细分数
 * @param {{capEnds?:boolean, hollow?:boolean, wallThickness?:number,
 *          upright?:boolean, tilt?:number}} opts
 *        upright = 重力对齐（曲线墙：截面不随路径扭转，tilt 为绕路径切线的倾角，弧度）
 * @returns {THREE.BufferGeometry}
 */
export function sweepGeometry(curve, section2D, div, opts = {}) {
  const capEnds = opts.capEnds !== false;
  const hollow = !!opts.hollow;
  const wall = Math.max(0.001, Number(opts.wallThickness) || 0.001);

  const n = (section2D || []).length;
  const geo = new THREE.BufferGeometry();
  if (n < 3) return geo;

  const outer = section2D.map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);
  const oc = centroid2D(outer);
  const on = edgeNormals2D(outer);
  const ov = perimeterV(outer);

  let inner = null, inn = null, iv = null;
  if (hollow) {
    const r = inradius2D(outer, oc);
    const k = Math.max(0.04, (r - wall) / Math.max(1e-6, r));
    inner = outer.map(([x, y]) => [oc[0] + (x - oc[0]) * k, oc[1] + (y - oc[1]) * k]);
    const ni = edgeNormals2D(inner);
    // 内表面法线朝空腔内 → 取反
    inn = { edge: ni.edge, vert: ni.vert.map(([x, y]) => [-x, -y]) };
    iv = perimeterV(inner);
  }

  const seg = Math.max(2, Math.round(div) || 24);
  const frames = opts.upright
    ? uprightFrames(curve, seg, Number(opts.tilt) || 0)
    : curve.computeFrenetFrames(seg, false);
  const arcLen = curve.getLength() || 0;   // 路径总弧长（stud）：u 直接用 stud 计量

  const pos = [], nor = [], uv = [], idx = [];
  const _P = new THREE.Vector3();

  /** 推一圈顶点（含接缝重复点，索引 0..n），返回起始下标 */
  const pushRing = (poly, normals, vArr, i, P, N, B) => {
    const base = pos.length / 3;
    for (let j = 0; j <= n; j++) {
      const k = j % n;
      const x = poly[k][0], y = poly[k][1];
      pos.push(
        P.x + N.x * x + B.x * y,
        P.y + N.y * x + B.y * y,
        P.z + N.z * x + B.z * y,
      );
      const nx = normals[k][0], ny = normals[k][1];
      nor.push(N.x * nx + B.x * ny, N.y * nx + B.y * ny, N.z * nx + B.z * ny);
      uv.push(arcLen * i / seg, j < n ? vArr[j] : vArr[n]);
    }
    return base;
  };

  /* ---------- 侧面 ---------- */
  const outerRing = [];
  const innerRing = hollow ? [] : null;
  for (let i = 0; i <= seg; i++) {
    curve.getPointAt(i / seg, _P);
    const N = frames.normals[i], B = frames.binormals[i];
    outerRing.push(pushRing(outer, on.vert, ov, i, _P, N, B));
    if (hollow) innerRing.push(pushRing(inner, inn.vert, iv, i, _P, N, B));
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < n; j++) {
      const a = outerRing[i] + j, b = outerRing[i] + j + 1;
      const c = outerRing[i + 1] + j, d = outerRing[i + 1] + j + 1;
      idx.push(a, b, c, b, d, c);
      if (hollow) {
        const ia = innerRing[i] + j, ib = innerRing[i] + j + 1;
        const ic = innerRing[i + 1] + j, id = innerRing[i + 1] + j + 1;
        idx.push(ia, ic, ib, ib, ic, id);   // 反向绕序
      }
    }
  }

  /* ---------- 两端封口 ---------- */
  if (capEnds) {
    /** 一圈封口顶点（按 2D 坐标给 uv，法线统一取 ±切线），返回起始下标 */
    const pushCapRing = (poly, P, N, B, tan, sign) => {
      const base = pos.length / 3;
      for (let j = 0; j <= n; j++) {
        const k = j % n;
        const x = poly[k][0], y = poly[k][1];
        pos.push(
          P.x + N.x * x + B.x * y,
          P.y + N.y * x + B.y * y,
          P.z + N.z * x + B.z * y,
        );
        nor.push(tan.x * sign, tan.y * sign, tan.z * sign);
        uv.push(x, y);
      }
      return base;
    };
    /** 扇形封口的形心顶点 */
    const pushCenter = (P, tan, sign) => {
      const base = pos.length / 3;
      pos.push(P.x, P.y, P.z);
      nor.push(tan.x * sign, tan.y * sign, tan.z * sign);
      uv.push(0, 0);
      return base;
    };

    const t0 = frames.tangents[0], tE = frames.tangents[seg];
    const P0 = curve.getPointAt(0, new THREE.Vector3());
    const PE = curve.getPointAt(1, new THREE.Vector3());
    const N0 = frames.normals[0], B0 = frames.binormals[0];
    const NE = frames.normals[seg], BE = frames.binormals[seg];

    if (!hollow) {
      // 起点：扇形，法线 -tangent
      const cS = pushCenter(P0, t0, -1);
      const rS = pushCapRing(outer, P0, N0, B0, t0, -1);
      for (let j = 0; j < n; j++) idx.push(cS, rS + j + 1, rS + j);
      // 终点：扇形，法线 +tangent
      const cE = pushCenter(PE, tE, 1);
      const rE = pushCapRing(outer, PE, NE, BE, tE, 1);
      for (let j = 0; j < n; j++) idx.push(cE, rE + j, rE + j + 1);
    } else {
      // 起点环带（外圈 → 内圈），法线 -tangent
      const oS = pushCapRing(outer, P0, N0, B0, t0, -1);
      const iS = pushCapRing(inner, P0, N0, B0, t0, -1);
      for (let j = 0; j < n; j++) {
        idx.push(oS + j, iS + j, oS + j + 1, oS + j + 1, iS + j, iS + j + 1);
      }
      // 终点环带，法线 +tangent
      const oE = pushCapRing(outer, PE, NE, BE, tE, 1);
      const iE = pushCapRing(inner, PE, NE, BE, tE, 1);
      for (let j = 0; j < n; j++) {
        idx.push(oE + j, oE + j + 1, iE + j, oE + j + 1, iE + j + 1, iE + j);
      }
    }
  }

  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/**
 * 多条轮廓（非连续截面）沿同一路径扫掠 → 合并成一个几何。
 * 每条子轮廓各扫一条「实心管」（各自两端封口），再合并：两个不相交的圆
 * 就得到两根平行的独立管，互不干扰。
 * @param {THREE.Curve} curve
 * @param {Array<Array<[number,number]>>} profiles
 * @param {number} div
 * @param {object} opts 同 sweepGeometry
 * @returns {THREE.BufferGeometry}
 */
export function sweepProfiles(curve, profiles, div, opts = {}) {
  const list = (profiles || []).filter((p) => Array.isArray(p) && p.length >= 3);
  if (!list.length) return new THREE.BufferGeometry();
  if (list.length === 1) return sweepGeometry(curve, list[0], div, opts);
  const geos = list.map((p) => sweepGeometry(curve, p, div, opts));
  let merged = null;
  try { merged = mergeGeometries(geos, false); } catch (e) { merged = null; }
  if (merged) {
    for (const g of geos) g.dispose();
    return merged;
  }
  // 合并失败（属性不一致）时退回第一条，至少不是空几何
  for (let i = 1; i < geos.length; i++) geos[i].dispose();
  return geos[0];
}
