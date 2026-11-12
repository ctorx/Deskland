// Galaxy scene st-empire: Sequel trilogy, Empire side. "Ice fortress planet".
// Straight down onto a frozen world carved into a superweapon. Every desktop icon sits on a pedestal inside an angular,
// terraced trench cut into the ice; nearby icons share one trench complex. Red energy glows in the trench channels and
// builds over a three-minute charge cycle. At the pulse the trenches flare, a ring shockwave crosses the snow and the
// glow resets. Patrols of black fighters, an occasional command shuttle, rim searchlights and turrets, and (with
// Skirmishes) attack runs by cross-winged raiders bring the surface to life.
//
// Structure:
//   - CPU: own octagonal distance field to the icon cells (crisp chamfered trench shapes) + a coarse euclidean far field
//     for the shockwave ring. Both morph with the engine's ctx.morph.
//   - Cache pass (re-rendered on layout, resize, morph and intro): snow terrain, rock, forests, frozen lakes, crevasses,
//     trench walls, floors, aprons and pylons, lit by a low cold sun.
//   - Live pass (every frame): heat shimmer, cloud shadows, red energy, conduits, steam, shockwave, blowing snow, sparkle.
//   - Sprites and glows: turrets, catwalks, searchlights, fighters, shuttle, raiders, bolts, snow bursts.
(function () {
  'use strict';
  const ID = 'st-empire';
  const QS = new URLSearchParams(location.search);
  const PERIOD = 180;          // charge cycle, flow seconds
  const FCAP = 300;            // own field cap, CSS px
  const CW = 76, CH = 100;

  let C = null;
  let progT = null, progL = null, terr = null;
  const fTex = [null, null], farTex = [null, null];
  let fStep = 2, fW = 0, fH = 0, farStep = 16, farW = 0, farH = 0;
  let fNew = null, farNew = null;
  const geo = { F: 3, R: 32, Ap: 18, depth: 24 };
  let dirty = true, pendingFinal = false, frameNo = 0, lastCache = -9;
  let turrets = [], catwalks = [], conduits = [];
  let flock = null, R0 = Math.random;
  let wind = [1, 0];
  let phase0 = 0.4;
  const ch = { c: 0, glow: 0, flare: 0, ring: 0, ringA: 0, flash: 0, rate: 0.5, cyc: null };
  let bolts = [], impacts = [], debris = [], xws = [], chasers = [], raidT = 20, shuttle = null, shuttleT = 10;
  let rnd = Math.random;

  /* ---------------- small helpers ---------------- */
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  function half(v) {
    f32[0] = v; const x = u32[0];
    const s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
    if (e <= 0) return s; if (e >= 31) return s | 0x7bff; return s | (e << 10) | (m >>> 13);
  }
  function makeTex(gl) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function upload(gl, tex, w, h, arr) {
    const n = w * h, u = new Uint16Array(n);
    for (let i = 0; i < n; i++) u[i] = half(arr[i]);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, u);
  }
  function sampleF(a, x, y) {
    if (!a) return FCAP;
    const fx = clamp(x / fStep, 0, fW - 1.001), fy = clamp(y / fStep, 0, fH - 1.001);
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, i = iy * fW + ix;
    return (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[i + fW] * (1 - tx) + a[i + fW + 1] * tx) * ty;
  }
  const fieldD = (x, y) => sampleF(fNew, x, y);
  function fieldGrad(x, y) { const e = 3; return [(fieldD(x + e, y) - fieldD(x - e, y)) / (2 * e), (fieldD(x, y + e) - fieldD(x, y - e)) / (2 * e)]; }
  const angTo = (a, b) => { let d = b - a; return Math.atan2(Math.sin(d), Math.cos(d)); };

  /* ---------------- icon fields ---------------- */
  function iconRects(list) {
    return list.map(ic => ({ cx: ic.x + ic.w / 2, cy: ic.y + ic.h / 2, hw: ic.w / 2 - 2, hh: ic.h / 2 - 2,
      k: 0.6 + 0.16 * C.hash(Math.round(ic.x), Math.round(ic.y), 3) }));
  }
  function buildField(list) {
    const N = fW * fH, d = new Float32Array(N).fill(FCAP);
    const base = iconRects(list), rects = base.slice();
    for (let i = 0; i < base.length; i++) for (let j = i + 1; j < base.length; j++) {
      const a = base[i], b = base[j], dx = b.cx - a.cx, dy = b.cy - a.cy, ax = Math.abs(dx), ay = Math.abs(dy);
      if (ay < 8 && ax > a.hw + b.hw + 6 && ax < 2.6 * CW) rects.push({ cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2, hw: ax / 2, hh: 9, k: 0.7 });
      else if (ax < 8 && ay > a.hh + b.hh + 6 && ay < 2.3 * CH) rects.push({ cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2, hw: 9, hh: ay / 2, k: 0.7 });
    }
    for (const r of rects) {
      const R = FCAP + 4;
      const gx0 = Math.max(0, Math.floor((r.cx - r.hw - R) / fStep)), gx1 = Math.min(fW - 1, Math.ceil((r.cx + r.hw + R) / fStep));
      const gy0 = Math.max(0, Math.floor((r.cy - r.hh - R) / fStep)), gy1 = Math.min(fH - 1, Math.ceil((r.cy + r.hh + R) / fStep));
      for (let gy = gy0; gy <= gy1; gy++) {
        const qy = Math.abs(gy * fStep - r.cy) - r.hh, oy = qy > 0 ? qy : 0, row = gy * fW;
        for (let gx = gx0; gx <= gx1; gx++) {
          const qx = Math.abs(gx * fStep - r.cx) - r.hw;
          let sd;
          if (qx > 0 || qy > 0) { const ox = qx > 0 ? qx : 0; sd = Math.max(ox, oy, (ox + oy) * r.k); }
          else sd = qx > qy ? qx : qy;
          if (sd < d[row + gx]) d[row + gx] = sd;
        }
      }
    }
    return { d, base };
  }
  function buildFar(list) {
    const d = new Float32Array(farW * farH).fill(6000);
    for (const r of iconRects(list)) {
      for (let gy = 0; gy < farH; gy++) {
        const qy = Math.abs(gy * farStep - r.cy) - r.hh, oy = qy > 0 ? qy : 0;
        for (let gx = 0; gx < farW; gx++) {
          const qx = Math.abs(gx * farStep - r.cx) - r.hw, ox = qx > 0 ? qx : 0;
          const sd = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0);
          const i = gy * farW + gx; if (sd < d[i]) d[i] = sd;
        }
      }
    }
    return d;
  }
  function computeGeo() {
    const s = C.P.sigma;
    geo.F = 3; const wall = 16 + s * 0.3;
    geo.R = geo.F + wall; geo.Ap = 9 + s * 0.13; geo.depth = wall * 0.8;
  }
  function placeFurniture(base) {
    turrets = []; catwalks = []; conduits = [];
    const tgt = geo.R + geo.Ap * 0.45, W = C.W, H = C.H;
    const tryAdd = (x, y, k) => {
      if (x < 8 || y < 8 || x > W - 8 || y > H - 56) return;
      if (Math.abs(fieldD(x, y) - tgt) > 3) return;
      for (const t of turrets) if (Math.hypot(t.x - x, t.y - y) < 84) return;
      for (const c of conduits) if (Math.hypot(c.x0 - x, c.y0 - y) < 30) return;
      const g = fieldGrad(x, y), out = Math.atan2(g[1], g[0]);
      const h = C.hash(Math.round(x), Math.round(y), 41);
      turrets.push({ x, y, out, aim: out, ph: h * 50, kind: turrets.length % 3 === 1 ? 'light' : 'gun', fireT: 1 + h * 2, beam: out + (h - 0.5), bdist: 110, k });
    };
    // Power conduits running out from exposed trench edges across the snow
    const tryConduit = (x, y, ux, uy) => {
      if (x < 10 || y < 10 || x > W - 10 || y > H - 60 || conduits.length > 48) return;
      if (Math.abs(fieldD(x, y) - (geo.R + 2)) > 3) return;
      for (const t of turrets) if (Math.hypot(t.x - x, t.y - y) < 34) return;
      for (const c of conduits) if (Math.hypot(c.x0 - x, c.y0 - y) < 60) return;
      const h = C.hash(Math.round(x), Math.round(y), 91);
      if (h < 0.25) return;
      const Lmax = 55 + 120 * C.hash(Math.round(x), Math.round(y), 92);
      let L = 0, prev = fieldD(x, y);
      while (L < Lmax) {
        const nx = x + ux * (L + 4), ny = y + uy * (L + 4), d = fieldD(nx, ny);
        if (d < prev - 0.5 || nx < 0 || ny < 0 || nx > W || ny > H - 48) break;
        prev = d; L += 4;
      }
      if (L < 40) return;
      conduits.push({ x0: x, y0: y, x1: x + ux * L, y1: y + uy * L, L, ang: Math.atan2(uy, ux), ph: h * 40, spd: 0.8 + 0.4 * h });
    };
    for (const r of base) {
      const o = geo.R + 2;
      tryConduit(r.cx + r.hw + o, r.cy + (C.hash(r.cx | 0, r.cy | 0, 93) - 0.5) * r.hh, 1, 0);
      tryConduit(r.cx - r.hw - o, r.cy + (C.hash(r.cx | 0, r.cy | 0, 94) - 0.5) * r.hh, -1, 0);
      tryConduit(r.cx + (C.hash(r.cx | 0, r.cy | 0, 95) - 0.5) * r.hw, r.cy + r.hh + o, 0, 1);
      tryConduit(r.cx + (C.hash(r.cx | 0, r.cy | 0, 96) - 0.5) * r.hw, r.cy - r.hh - o, 0, -1);
    }
    for (const r of base) {
      const a = tgt / (2 * r.k);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) tryAdd(r.cx + sx * (r.hw + a), r.cy + sy * (r.hh + a), r.k);
    }
    // Catwalks across the trench between vertically stacked icons, spanning the whole row run
    const segs = [];
    for (let i = 0; i < base.length; i++) for (let j = 0; j < base.length; j++) {
      const a = base[i], b = base[j];
      if (Math.abs(a.cx - b.cx) < 4 && Math.abs(b.cy - a.cy - CH) < 8) segs.push({ y: (a.cy + b.cy) / 2, x0: a.cx - a.hw - 2, x1: a.cx + a.hw + 2 });
    }
    segs.sort((p, q) => (Math.round(p.y) - Math.round(q.y)) || (p.x0 - q.x0));
    const merged = [];
    for (const s of segs) {
      const m = merged[merged.length - 1];
      if (m && Math.abs(m.y - s.y) < 3 && s.x0 <= m.x1 + 4) m.x1 = Math.max(m.x1, s.x1); else merged.push(Object.assign({}, s));
    }
    const ext = geo.F + 0.47 * (geo.R - geo.F);
    for (const m of merged) if (C.hash(Math.round(m.x0), Math.round(m.y), 77) > 0.42) catwalks.push({ x: (m.x0 + m.x1) / 2, y: m.y, len: m.x1 - m.x0 + 2 * ext });
  }

  /* ---------------- GLSL ---------------- */
  const FIELD_GLSL = `
uniform sampler2D uDA, uDB, uFarA, uFarB;
uniform float uM, uFS, uGrow, uFarS;
uniform vec2 uFG, uFarG;
uniform float uF, uR, uAp, uDepth, uQ;
uniform vec2 uWind;
float tD(vec2 p) { vec2 uv = (p / uFS + 0.5) / uFG; return mix(texture(uDA, uv).r, texture(uDB, uv).r, uM) + uGrow; }
float tFar(vec2 p) { vec2 uv = (p / uFarS + 0.5) / uFarG; return mix(texture(uFarA, uv).r, texture(uFarB, uv).r, uM) + uGrow; }
vec3 sunDir() { return normalize(vec3(-0.72, -0.56, 0.30)); }
const vec3 SUNC = vec3(1.0, 0.95, 0.9) * 1.12;
const vec3 SKYC = vec3(0.22, 0.36, 0.78) * 0.42;
`;

  const TERRAIN_FS = FIELD_GLSL + `
vec2 SO;
float clearM;
// Snow terrain height in CSS px. Masks for the center sample come back through out parameters.
float hLow(vec2 p, int o, out float big) {
  big = fbm(p * 0.0011 + SO, o);
  float rdg = ridged(p * 0.0019 + SO * 1.31, o);
  return big * 150. + pow(max(rdg - 0.5, 0.), 1.5) * 300. * clearM;
}
float terrH(vec2 p, out float rock, out float lake, out float big) {
  vec2 w = vec2(dot(p, uWind), dot(p, vec2(-uWind.y, uWind.x)));
  float h = hLow(p, 6, big);
  float rdg = ridged(p * 0.0019 + SO * 1.31, 3);
  float dr = gfbm(vec2(w.x * 0.003, w.y * 0.012) + SO * 0.7, 4);
  float sa = (0.5 - abs(gnoise(vec2(w.x * 0.012, w.y * 0.085) + SO))) * 0.9 + (0.5 - abs(gnoise(vec2(w.x * 0.03, w.y * 0.2) + SO * 1.7))) * 0.45;
  float rd = gfbm(p * 0.03 + SO, 4);
  rock = smoothstep(0.0, 0.012, rdg - 0.74 + 0.06 * rd) * clearM;
  lake = smoothstep(0.37, 0.355, big + 0.02 * gnoise(p * 0.012)) * smoothstep(0.5, 1.0, clearM);
  rock *= 1. - lake;
  h += (dr * 10. + sa * 2.2 * (1. - rock)) * clearM;
  h += rock * (rd * 10. + gnoise(p * 0.15) * 1.5);
  h = mix(h, 0.355 * 150. + 1.0, lake);
  return h;
}
vec4 trees(vec2 p, float dens, vec3 L, out float shade) {
  const float cs = 9.;
  vec2 c = floor(p / cs);
  vec4 acc = vec4(0); shade = 0.;
  vec2 sd = -normalize(L.xy);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 id = c + vec2(i, j);
    vec3 h = hash32(id + 31.7);
    if (h.z > dens) continue;
    vec2 tp = (id + 0.15 + 0.7 * h.xy) * cs;
    float r = 4.2 + 3.2 * hash12(id + 7.3);
    vec2 q = p - tp;
    vec2 sq = q - sd * r * 1.9;
    vec2 sl = vec2(dot(sq, sd), dot(sq, vec2(-sd.y, sd.x)));
    float sdist = length(sl / vec2(r * 2.4, r * 0.8));
    shade = max(shade, smoothstep(1.0, 0.5, sdist) * 0.9);
    float a = atan(q.y, q.x);
    float L0 = length(q);
    float rr = r * (0.86 + 0.14 * cos(7. * a + h.x * 6.283));
    float cov = smoothstep(rr + 0.45, rr - 0.45, L0);
    if (cov > 0.) {
      vec3 cn = normalize(vec3(q / r * 1.2, 0.5));
      float dif = max(dot(cn, L), 0.);
      float tier = smoothstep(0.3, 0.62, fract(L0 / r * 2.3 + h.y + 0.12 * cos(7. * a + h.x * 6.283)));
      float snowy = mix(tier, 1., 0.45) * (1. - smoothstep(0.55, 1.0, L0 / rr) * 0.7);
      vec3 green = vec3(0.018, 0.055, 0.04);
      vec3 sn = vec3(0.82, 0.88, 0.97);
      vec3 cc = mix(green, sn, snowy * 0.85) * (SUNC * dif * 1.25 + SKYC * 0.75);
      cc *= 0.75 + 0.25 * smoothstep(0., r, L0 + r * 0.3);
      acc.rgb = mix(acc.rgb, cc, cov); acc.a = max(acc.a, cov);
    }
  }
  return acc;
}

vec3 terrain(vec2 p, float D, vec3 L, out float snowA) {
  clearM = smoothstep(uR + uAp + 10., uR + uAp + 170., D);
  float rock, lake, big, r2, l2, b2;
  float h0 = terrH(p, rock, lake, big);
  float hx = terrH(p + vec2(1., 0.), r2, l2, b2);
  float hy = terrH(p + vec2(0., 1.), r2, l2, b2);
  vec3 n = normalize(vec3(-(hx - h0), -(hy - h0), 1.0));
  // cast shadows from the large relief toward the low sun
  float tanE = L.z / length(L.xy);
  vec2 ld = normalize(L.xy);
  float bb;
  float hs0 = hLow(p, 3, bb) + 1.5;
  float csh = 1.;
  float s = 5.;
  for (int i = 0; i < 12; i++) {
    float hq = hLow(p + ld * s, 3, bb);
    csh = min(csh, clamp(1. - (hq - (hs0 + s * tanE)) / (4. + s * 0.04), 0., 1.));
    s *= 1.32;
    if (i > 6 && uQ < 0.5) break;
  }
  float dif = max(dot(n, L), 0.) * csh;
  float amb = 0.62 + 0.38 * n.z;
  vec2 w = vec2(dot(p, uWind), dot(p, vec2(-uWind.y, uWind.x)));
  float snowOnRock = smoothstep(0.86, 0.96, n.z) * smoothstep(-0.05, 0.25, gfbm(p * 0.04 + SO, 4));
  float rk = rock * (1. - snowOnRock);
  vec3 rockA = mix(vec3(0.035, 0.04, 0.05), vec3(0.13, 0.125, 0.13), clamp(0.5 + 1.2 * gfbm(mat2(0.8, 0.6, -0.6, 0.8) * p * vec2(0.02, 0.12), 4), 0., 1.));
  vec3 snowAl = vec3(0.93, 0.96, 1.0);
  vec3 alb = mix(snowAl, rockA, rk);
  vec3 col = alb * (SUNC * dif + SKYC * amb) + vec3(0.0, 0.025, 0.08) * (1. - dif) * (1. - rk);
  vec3 colSh = alb * SKYC * amb * 0.95 + vec3(0.0, 0.025, 0.08) * (1. - rk);
  snowA = (1. - rk) * smoothstep(0.1, 0.4, dif);

  // frozen lakes
  if (lake > 0.001) {
    vec2 q = p + SO * 40.;
    float deep = fbm(q * 0.005, 4);
    vec3 ice = mix(vec3(0.01, 0.035, 0.08), vec3(0.12, 0.25, 0.36), smoothstep(0.3, 0.75, deep));
    vec4 v1 = voronoi(q * 0.018); float cr1 = 1. - smoothstep(0.0, 0.03, v1.y - v1.x);
    vec4 v2 = voronoi(q * 0.06 + 3.); float cr2 = 1. - smoothstep(0.0, 0.045, v2.y - v2.x);
    vec4 v3 = voronoi(q * 0.16 + 9.); float cr3 = 1. - smoothstep(0.0, 0.06, v3.y - v3.x);
    float dust = smoothstep(0.42, 0.78, fbm(vec2(w.x * 0.008, w.y * 0.05) + SO, 5));
    vec3 ic = ice * (0.6 + 0.7 * L.z) + vec3(0.03, 0.05, 0.09);
    ic = mix(ic, vec3(0.5, 0.64, 0.78), cr1 * 0.75 + cr2 * 0.4 * (1. - cr1) + cr3 * 0.15 * smoothstep(0.5, 0.7, deep));
    float frost = smoothstep(0.5, 1.0, vnoise(q * 0.4)) * 0.15;
    ic += frost * vec3(0.5, 0.6, 0.7);
    ic = mix(ic, col, dust * 0.85);
    float sh = smoothstep(0.0, 0.3, lake);
    col = mix(col, ic, sh); colSh = mix(colSh, ic * 0.6, sh);
    snowA *= 1. - sh * (1. - dust) * 0.7;
  }

  // crevasse fields
  float gz = smoothstep(0.56, 0.66, fbm(p * 0.0011 + SO * 2.3, 3)) * (1. - lake) * (1. - rk) * clearM;
  if (gz > 0.01) {
    vec2 q = vec2(w.x * 0.026, w.y * 0.0075) + 0.35 * vec2(gnoise(p * 0.008 + SO), gnoise(p * 0.008 + SO + 5.));
    vec4 v = voronoi(q);
    float e = v.y - v.x;
    float cw = 0.1 * gz * (0.4 + hash12(v.zw));
    float crack = 1. - smoothstep(cw * 0.55, cw, e);
    vec3 cc = mix(vec3(0.005, 0.03, 0.09), vec3(0.12, 0.33, 0.58), smoothstep(0., cw * 0.9, e));
    col = mix(col, cc, crack); colSh = mix(colSh, cc * 0.7, crack);
    snowA *= 1. - crack;
  }

  // conifer forests
  float fm = smoothstep(0.53, 0.57, fbm(p * 0.0036 + SO * 1.7, 4) + 0.03 * gnoise(p * 0.03)) * (1. - lake) * (1. - rock) * smoothstep(0.35, 0.9, clearM) * (1. - gz);
  if (fm > 0.02) {
    float shade;
    vec4 tr = trees(p, fm * 0.92, L, shade);
    col = mix(col, colSh, shade * (1. - tr.a));
    col = mix(col, tr.rgb, tr.a);
    snowA *= 1. - max(tr.a, shade) * 0.8;
  }
  return col;
}

float surfH(float D) {
  if (D >= uR) return 0.;
  if (D < uF) return -uDepth + (D < -6. ? 2.5 : 0.);
  float t = (D - uF) / (uR - uF);
  return uDepth * (-1. + 0.55 * clamp(t / 0.4, 0., 1.) + 0.45 * clamp((t - 0.55) / 0.45, 0., 1.));
}

vec3 trenchCol(vec2 p, float D, vec3 L, float aa) {
  float e = uFS;
  vec2 g = vec2(tD(p + vec2(e, 0.)) - tD(p - vec2(e, 0.)), tD(p + vec2(0., e)) - tD(p - vec2(0., e))) / (2. * e);
  vec2 gn = length(g) > 1e-3 ? normalize(g) : vec2(0., -1.);
  vec2 ldir = normalize(L.xy);
  float tanE = L.z / length(L.xy);
  float hp = surfH(D);
  float sh = 1.;
  if (D < uR) {
    for (int i = 1; i <= 12; i++) {
      float s = float(i) * uDepth * 0.22;
      float hq = surfH(tD(p + ldir * s));
      sh = min(sh, clamp(1. - (hq - (hp + s * tanE)) / 2.5, 0., 1.));
    }
  }
  vec3 c;
  if (D < uF) {
    // floor: raised pedestal plates under each icon, recessed energy channels around them
    float ped = 1. - smoothstep(-6. - aa, -6. + aa, D);
    vec2 pg = p / 9.5;
    vec2 f = abs(fract(pg) - 0.5);
    float seam = smoothstep(0.44, 0.5, max(f.x, f.y));
    float pv = hash12(floor(pg) + SO);
    vec3 alb = vec3(0.05, 0.053, 0.06) * (0.8 + 0.4 * pv) * (1. - seam * 0.45);
    vec3 pc = alb * (SUNC * L.z * sh * 1.4 + SKYC * 0.45);
    float bev = (1. - smoothstep(1.2, 2.0, -6. - D)) * ped;
    pc += vec3(0.16, 0.18, 0.21) * bev * max(dot(gn, ldir), 0.) * sh;
    vec3 cc = vec3(0.008, 0.008, 0.01);
    c = mix(cc, pc, ped);
  } else if (D < uR) {
    float t = (D - uF) / (uR - uF);
    float ledge = step(0.4, t) * step(t, 0.55);
    vec4 v = voronoi(p * 0.12 + SO);
    float fh = hash12(v.zw);
    vec2 nh = rot2((fh - 0.5) * 1.1) * (-gn);
    vec3 n = ledge > 0.5 ? vec3(0., 0., 1.) : normalize(vec3(nh * (0.7 + 0.6 * fh), 0.42));
    float dif = max(dot(n, L), 0.) * sh;
    vec3 alb = vec3(0.045, 0.052, 0.065) * (0.6 + 0.8 * fh);
    if (ledge > 0.5) {
      vec2 pg = p / 6.;
      float s2 = smoothstep(0.42, 0.5, max(abs(fract(pg.x) - 0.5), abs(fract(pg.y) - 0.5)));
      alb = vec3(0.07, 0.075, 0.085) * (1. - 0.5 * s2);
    }
    c = alb * (SUNC * dif * 2.4 + SKYC * 0.55);
    float edgeF = 1. - smoothstep(0.0, 0.07, v.y - v.x);
    c += vec3(0.22, 0.30, 0.40) * edgeF * (dif * 0.5 + 0.03) * (1. - ledge);
    c += vec3(0.5, 0.6, 0.75) * pow(max(dot(reflect(-L, n), vec3(0., 0., 1.)), 0.), 24.) * 0.25 * sh;
    c *= mix(0.45, 1., t);
    // crisp lit lips at the ledge and the rim
    float facing = clamp(dot(-gn, ldir) * 1.6, 0., 1.);
    float lip = (1. - smoothstep(0., 1.1 + aa, abs(D - (uF + 0.55 * (uR - uF))))) + (1. - smoothstep(0., 1.1 + aa, abs(D - uR + 0.6)));
    c += vec3(0.38, 0.44, 0.52) * lip * (0.25 + 0.75 * facing);
  } else {
    // apron: dark steel decking with plates, pylons and a dusting of snow
    float u = D - uR;
    vec2 pg = p / 12.;
    vec2 f = abs(fract(pg) - 0.5);
    float seam = smoothstep(0.45, 0.5, max(f.x, f.y));
    float pv = hash12(floor(pg) + SO * 2.);
    vec3 alb = vec3(0.10, 0.108, 0.122) * (0.8 + 0.35 * pv) * (1. - seam * 0.5);
    float stripe = step(0.5, fract((p.x + p.y) / 7.)) * (1. - smoothstep(2.0, 2.6, u)) * step(1.0, u);
    alb = mix(alb, vec3(0.16, 0.16, 0.17), stripe * 0.6);
    float dust = smoothstep(0.5, 0.85, fbm(p * 0.045 + SO, 3) + u / uAp * 0.25);
    alb = mix(alb, vec3(0.8, 0.84, 0.9), dust * 0.75);
    c = alb * (SUNC * L.z * 1.3 + SKYC * 0.65);
    // pylons
    vec2 cid = floor(p / 21.);
    vec2 cc = (cid + 0.5) * 21.;
    float dc = tD(cc);
    if (dc > uR + 3. && dc < uR + uAp - 3. && hash12(cid + SO) > 0.5) {
      float s = 2.6 + 1.6 * hash12(cid + 3.);
      float bs = sdBox(p - cc - (-ldir) * s * 1.4, vec2(s));
      c *= 1. - 0.55 * smoothstep(1.2, -0.5, bs);
      float b = sdBox(p - cc, vec2(s));
      vec3 top = vec3(0.12, 0.13, 0.15) * (SUNC * L.z * 1.5 + SKYC * 0.6);
      float hl = smoothstep(0.6, -0.4, abs(b + 0.6)) * clamp(dot(normalize(p - cc + 1e-3), ldir) + 0.3, 0., 1.);
      c = mix(c, top + hl * 0.25, smoothstep(0.6, -0.4, b));
    }
  }
  return c;
}

void main() {
  vec2 p = cssPos();
  SO = vec2(fract(uSeed * 0.0137) * 300. + 17., fract(uSeed * 0.0291) * 300. + 5.);
  vec3 L = sunDir();
  float D = tD(p);
  float aa = max(fwidth(D), 0.25) * 0.75;
  float snowA = 0.;
  vec3 snow = vec3(0), tr = vec3(0);
  float edge = uR + uAp;
  float rag = 5. * gnoise(p * 0.07 + SO) + 2. * gnoise(p * 0.2);
  if (D + rag > edge - 8.) snow = terrain(p, D, L, snowA);
  if (D + rag < edge + 8.) tr = trenchCol(p, D, L, aa);
  float sm = smoothstep(edge - 1.5, edge + 1.5, D + rag);
  // snow bank against the apron: shadowed on the far side
  vec3 col = mix(tr, snow, sm);
  col *= 1. - 0.35 * (1. - smoothstep(0., 7., D + rag - edge)) * sm;
  outColor = vec4(col, snowA * sm);
}`;

  const LIVE_FS = FIELD_GLSL + `
uniform sampler2D uTer;
uniform float uGlow, uFlare, uRing, uRingA, uRate, uFlash;
vec2 SO;
vec2 toUv(vec2 o) { return vec2(o.x, -o.y) / uRes; }
void main() {
  vec2 p = cssPos();
  SO = vec2(fract(uSeed * 0.0137) * 300. + 17., fract(uSeed * 0.0291) * 300. + 5.);
  float D = tD(p);
  vec2 uv = vUv;
  float lvl = uGlow + uFlare * 2.6;
  float inT = 1. - smoothstep(uR - 2., uR + 3., D);
  if (inT > 0.) {
    vec2 o = vec2(gnoise(p * 0.07 + vec2(0., uFlow * 1.9)), gnoise(p * 0.07 + vec2(5.2, uFlow * 1.5)));
    uv += toUv(o * inT * (0.6 + 1.2 * uGlow + 3. * uFlare));
  }
  float ring = 0., Df = 0., xr = 0.;
  vec2 rg = vec2(0.);
  if (uRingA > 0.001) {
    Df = tFar(p);
    float w = 22. + uRing * 0.035;
    xr = (Df - uRing) / w;
    ring = exp(-xr * xr) * uRingA;
    float e = 10.;
    rg = vec2(tFar(p + vec2(e, 0.)) - tFar(p - vec2(e, 0.)), tFar(p + vec2(0., e)) - tFar(p - vec2(0., e)));
    rg = rg / max(length(rg), 1e-4);
    uv += toUv(-rg * xr * exp(-xr * xr) * 9. * uRingA);
  }
  vec4 B = texture(uTer, uv);
  vec3 col = B.rgb;

  // drifting cloud shadows
  vec2 cp = p * 0.0008 - uWind * uFlow * 0.010 + SO * 0.01;
  float cl = fbm(cp + vec2(fbm(cp * 2.0 + 3.1, 3)) * 0.5, 4);
  float csh = smoothstep(0.42, 0.68, cl);
  col *= mix(vec3(1.), vec3(0.52, 0.58, 0.74), csh);

  vec3 RED = vec3(1.0, 0.075, 0.02), HOT = vec3(1.0, 0.45, 0.22);
  vec3 ec = mix(RED, HOT, clamp(uFlare * 1.2 + uGlow * 0.15, 0., 1.));
  ec = mix(ec, vec3(1., 0.85, 0.75), clamp(uFlare - 0.6, 0., 0.4));
  vec3 em = vec3(0.);

  // trench energy
  if (D < uR + 2.) {
    float chm = smoothstep(-7., -5.6, D) * (1. - smoothstep(uF - 0.6, uF + 0.6, D));
    float core = exp(-pow((D + 1.6) / 1.7, 2.));
    float fl = 0.72 + 0.28 * sin(dot(p, vec2(0.071, 0.052)) - uFlow * (2. + 7. * uGlow));
    fl *= 0.75 + 0.5 * vnoise(p * 0.06 + vec2(uFlow * 0.9, 0.));
    em += ec * chm * (0.15 + 2.2 * core) * fl * (0.3 + 2.6 * lvl);
    float floorM = 1. - smoothstep(uF - 1., uF + 1., D);
    float nearCh = exp(-max(-6. - D, 0.) / 5.);
    em += RED * floorM * (luma(B.rgb) * (0.3 + 1.3 * min(lvl, 1.2)) * nearCh + 0.004 + 0.015 * lvl);
    float t = clamp((D - uF) / (uR - uF), 0., 1.);
    float wallm = smoothstep(uF - 0.5, uF + 0.5, D) * (1. - smoothstep(uR - 0.5, uR + 0.5, D));
    em += RED * wallm * pow(1. - t, 2.5) * (0.015 + 0.5 * lvl) * (0.6 + 0.4 * luma(B.rgb) * 8.);
    // ledge lights: tiny red lamps along the terrace
    float tl = uF + 0.475 * (uR - uF);
    float lampLine = exp(-pow((D - tl) / 0.9, 2.));
    vec2 lc = floor(p / 9.);
    float lamp = step(0.7, hash12(lc + SO)) * (1. - smoothstep(0.6, 1.6, length(p - (lc + 0.5) * 9.)));
    em += RED * lampLine * lamp * (1.5 + 3. * lvl) * (0.7 + 0.3 * sin(uFlow * 3. + lc.x));
  }
  // red light spilling onto the snow around the trenches
  float spill = exp(-max(D - uR, 0.) / 55.) * (1. - inT);
  em += RED * spill * luma(B.rgb) * (0.02 + 0.32 * lvl);

  col += em;

  // steam rising from the trench channels, lit red from below, drifting downwind
  float sb = smoothstep(uF - 14., uF + 1., D) * (1. - smoothstep(uR + 6., uR + 70., D));
  if (sb > 0.) {
    vec2 q = p - uWind * uFlow * 22.;
    vec2 sp = vec2(dot(q, uWind) * 0.022, dot(q, vec2(-uWind.y, uWind.x)) * 0.05) + vec2(0., uFlow * 0.06);
    float s = fbm(sp + vec2(fbm(sp * 1.9 + uFlow * 0.1, 3), fbm(sp * 1.7 - uFlow * 0.07 + 4.1, 3)) * 1.2, 5);
    float dens = smoothstep(0.52, 0.9, s) * sb * (0.22 + 0.2 * min(lvl, 1.5));
    float lowlit = 1. - smoothstep(uF - 4., uR + 30., D);
    vec3 sc = vec3(0.48, 0.53, 0.62) * mix(1., 0.6, csh) + RED * (0.15 + 1.6 * lvl) * lowlit;
    col = mix(col, sc, dens);
  }

  // shockwave ring and kicked-up snow
  if (uRingA > 0.001) {
    vec3 rc = mix(vec3(1., 0.22, 0.07), vec3(1., 0.7, 0.55), ring * ring);
    float front = exp(-pow((Df - uRing - 0.6 * (22. + uRing * 0.035)) / 5., 2.)) * uRingA;
    float wake = smoothstep(uRing + 10., uRing - 260., Df) * smoothstep(uRing - 600., uRing - 100., Df) * uRingA;
    col += rc * ring * 1.5 + luma(col) * rc * ring * 1.6 + vec3(0.7, 0.85, 1.0) * front * 1.8;
    col += vec3(1., 0.2, 0.06) * wake * luma(col) * 0.6;
    float behind = smoothstep(uRing + 5., uRing - 50., Df) * smoothstep(uRing - 420., uRing - 140., Df);
    float dn = fbm(p * 0.011 - rg * uRing * 0.004 + uFlow * 0.25, 4);
    float dust = behind * smoothstep(0.38, 0.78, dn) * uRingA * smoothstep(uR, uR + 30., D);
    col = mix(col, vec3(0.86, 0.9, 0.98) * (0.9 + 0.4 * ring), dust * 0.45);
  }

  // blowing snow
  vec2 wd = uWind;
  vec2 wp = vec2(dot(p, wd), dot(p, vec2(-wd.y, wd.x)));
  float near = 0.35 + 0.65 * smoothstep(0., 40., D);
  float gust = smoothstep(0.3, 0.75, fbm(p * 0.0014 - wd * uFlow * 0.07 + SO * 0.3, 3));
  float st = fbm(vec2(wp.x * 0.007 - uFlow * 1.3, wp.y * 0.045 + sin(wp.x * 0.002 + uFlow * 0.2) * 2.), 4);
  float stream = smoothstep(0.52, 0.85, st) * (0.2 + 0.8 * gust);
  col = mix(col, vec3(0.80, 0.86, 0.97) * (0.85 - 0.3 * csh), stream * 0.16 * near);
  float st2 = fbm(vec2(wp.x * 0.02 - uFlow * 3.2, wp.y * 0.16), 3);
  col = mix(col, vec3(0.85, 0.9, 1.0), smoothstep(0.6, 0.9, st2) * 0.1 * gust * near);
  for (int k = 0; k < 2; k++) {
    float sc = k == 0 ? 11. : 19.;
    float spd = k == 0 ? 230. : 360.;
    vec2 q = vec2(wp.x - uFlow * spd, wp.y + sin(wp.x * 0.012 + uFlow * 1.3 + float(k)) * 5.) / sc;
    vec2 id = floor(q); vec2 f = fract(q) - 0.5;
    vec3 h = hash32(id + float(k) * 19.3);
    if (h.z < 0.08 + 0.4 * gust * gust) {
      vec2 o = (h.xy - 0.5) * 0.5;
      float len = 0.2 + 0.3 * h.z;
      float d = sdSegment(f, o - vec2(len, 0.), o) * sc;
      float pr = smoothstep(0.8 + float(k) * 0.5, 0., d) * (0.35 + 0.5 * h.x);
      col += vec3(0.78, 0.85, 1.0) * pr * (0.35 + 0.5 * gust) * near;
    }
  }

  // sparkle on fresh snow
  float sn = B.a * (1. - csh * 0.8) * smoothstep(uR + uAp, uR + uAp + 30., D);
  if (sn > 0.05) {
    vec2 cell = floor(p * 0.9);
    float h = hash12(cell + floor(SO));
    float tw = 0.5 + 0.5 * sin(uFlow * 2.2 + h * 917. + p.x * 0.01);
    float sp = smoothstep(0.9968, 1.0, h) * pow(tw, 8.);
    col += vec3(0.85, 0.93, 1.0) * sp * sn * 7.;
  }

  col *= 1. + uFlash * 0.35 * vec3(1.0, 0.75, 0.7);
  outColor = vec4(col, 1.);
}`;

  /* ---------------- sprites ---------------- */
  function hexPath(g, L, T) {
    g.beginPath(); g.moveTo(-L, 0); g.lineTo(-L * 0.62, -T); g.lineTo(L * 0.62, -T); g.lineTo(L, 0); g.lineTo(L * 0.62, T); g.lineTo(-L * 0.62, T); g.closePath();
  }
  function drawTie(g, w, h, kind) {
    const cx = w / 2, cy = h / 2;
    g.lineJoin = 'round';
    // struts
    g.fillStyle = '#30343b'; g.fillRect(cx - w * 0.05, h * 0.17, w * 0.1, h * 0.66);
    g.fillStyle = '#5d636d'; g.fillRect(cx - w * 0.018, h * 0.17, w * 0.036, h * 0.66);
    for (const sy of [-1, 1]) {
      g.save(); g.translate(cx, cy + sy * h * 0.34);
      if (kind === 0) {
        const L = w * 0.42, T = h * 0.13;
        hexPath(g, L, T); g.fillStyle = '#0d0e11'; g.fill();
        g.lineWidth = w * 0.014; g.strokeStyle = '#5d636c'; g.stroke();
        g.strokeStyle = 'rgba(70,76,86,0.8)'; g.lineWidth = w * 0.007;
        for (let k = -5; k <= 5; k++) { const x = k * L * 0.14; g.beginPath(); g.moveTo(x, -T * 0.85); g.lineTo(x, T * 0.85); g.stroke(); }
        g.beginPath(); g.moveTo(-L * 0.92, 0); g.lineTo(L * 0.92, 0); g.stroke();
      } else {
        // interceptor: dagger wings with forward and aft points bent inward
        const L = w * 0.44, T = h * 0.1, b = -sy * h * 0.07;
        g.beginPath(); g.moveTo(-L, b); g.lineTo(-L * 0.45, -T); g.lineTo(L * 0.45, -T); g.lineTo(L, b); g.lineTo(L * 0.4, T); g.lineTo(-L * 0.4, T); g.closePath();
        g.fillStyle = '#0d0e11'; g.fill(); g.lineWidth = w * 0.014; g.strokeStyle = '#5d636c'; g.stroke();
        g.strokeStyle = 'rgba(70,76,86,0.8)'; g.lineWidth = w * 0.008;
        for (let k = -4; k <= 4; k++) { const x = k * L * 0.16; g.beginPath(); g.moveTo(x, -T * 0.8); g.lineTo(x, T * 0.8); g.stroke(); }
        g.fillStyle = '#9a1c14'; g.fillRect(-L * 0.1, -T * 0.9, L * 0.2, T * 0.5);
      }
      g.restore();
    }
    const r = w * 0.125;
    const gr = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    gr.addColorStop(0, '#c9ced6'); gr.addColorStop(0.65, '#80868f'); gr.addColorStop(1, '#2d3036');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
    g.strokeStyle = '#1e2025'; g.lineWidth = w * 0.01; g.beginPath(); g.arc(cx, cy, r * 0.6, 0, 7); g.stroke();
    g.fillStyle = '#08090b'; g.beginPath(); g.ellipse(cx + r * 0.68, cy, r * 0.3, r * 0.62, 0, 0, 7); g.fill();
    g.strokeStyle = '#555b64'; g.lineWidth = w * 0.006;
    for (let k = -1; k <= 1; k++) { g.beginPath(); g.moveTo(cx + r * 0.68, cy); g.lineTo(cx + r * 0.68 + r * 0.25, cy + k * r * 0.5); g.stroke(); }
  }
  function drawXwing(g, w, h) {
    const cx = w * 0.5, cy = h * 0.5;
    g.lineJoin = 'round';
    const wing = (sy, lower) => {
      const tipY = cy + sy * h * (lower ? 0.36 : 0.44), dx = lower ? w * 0.025 : 0;
      g.beginPath(); g.moveTo(w * 0.30 + dx, cy + sy * h * 0.05); g.lineTo(w * 0.50 + dx, cy + sy * h * 0.05); g.lineTo(w * 0.455 + dx, tipY); g.lineTo(w * 0.35 + dx, tipY); g.closePath();
      g.fillStyle = lower ? '#9d998f' : '#e0dbd1'; g.fill();
      g.strokeStyle = '#6f6c66'; g.lineWidth = w * 0.008; g.stroke();
      if (!lower) {
        g.fillStyle = '#d4601c';
        const y1 = cy + sy * h * 0.30, y2 = cy + sy * h * 0.355;
        g.beginPath(); g.moveTo(w * 0.338, y1); g.lineTo(w * 0.468, y1); g.lineTo(w * 0.463, y2); g.lineTo(w * 0.343, y2); g.closePath(); g.fill();
        g.fillStyle = 'rgba(80,78,74,0.5)'; g.fillRect(w * 0.36, cy + sy * h * 0.12, w * 0.1, h * 0.012 * sy);
      }
      g.fillStyle = lower ? '#77756f' : '#a7a6a2';
      g.fillRect(w * 0.29 + dx, tipY - h * 0.013, w * 0.48, h * 0.026);
      g.fillStyle = '#3a3a3a'; g.fillRect(w * 0.74 + dx, tipY - h * 0.009, w * 0.07, h * 0.018);
    };
    for (const sy of [-1, 1]) wing(sy, true);
    for (const sy of [-1, 1]) {
      g.fillStyle = '#b9b5ac';
      g.beginPath(); g.roundRect(w * 0.16, cy + sy * h * 0.1 - h * 0.036, w * 0.25, h * 0.072, h * 0.03); g.fill();
      g.fillStyle = '#3b2a22'; g.fillRect(w * 0.16, cy + sy * h * 0.1 - h * 0.028, w * 0.025, h * 0.056);
    }
    for (const sy of [-1, 1]) wing(sy, false);
    g.beginPath(); g.moveTo(w * 0.97, cy); g.lineTo(w * 0.64, cy - h * 0.034); g.lineTo(w * 0.2, cy - h * 0.052); g.lineTo(w * 0.14, cy - h * 0.045);
    g.lineTo(w * 0.14, cy + h * 0.045); g.lineTo(w * 0.2, cy + h * 0.052); g.lineTo(w * 0.64, cy + h * 0.034); g.closePath();
    g.fillStyle = '#ebe7de'; g.fill(); g.strokeStyle = '#77746d'; g.lineWidth = w * 0.008; g.stroke();
    g.fillStyle = '#d4601c'; g.fillRect(w * 0.7, cy - h * 0.026, w * 0.03, h * 0.052); g.fillRect(w * 0.76, cy - h * 0.022, w * 0.02, h * 0.044);
    g.fillStyle = '#16181d'; g.beginPath(); g.ellipse(w * 0.56, cy, w * 0.065, h * 0.026, 0, 0, 7); g.fill();
    g.fillStyle = '#d7dbe3'; g.beginPath(); g.arc(w * 0.43, cy, h * 0.024, 0, 7); g.fill();
    g.fillStyle = '#d4601c'; g.beginPath(); g.arc(w * 0.43, cy, h * 0.011, 0, 7); g.fill();
  }
  function drawShuttle(g, w, h) {
    const cx = w * 0.5, cy = h * 0.5;
    g.lineJoin = 'miter';
    for (const sy of [-1, 1]) {
      g.beginPath();
      g.moveTo(w * 0.36, cy + sy * h * 0.05); g.lineTo(w * 0.58, cy + sy * h * 0.05); g.lineTo(w * 0.52, cy + sy * h * 0.47); g.lineTo(w * 0.44, cy + sy * h * 0.47); g.closePath();
      g.fillStyle = '#101114'; g.fill(); g.strokeStyle = '#4a4e56'; g.lineWidth = w * 0.007; g.stroke();
      g.strokeStyle = 'rgba(90,96,106,0.45)'; g.lineWidth = w * 0.004;
      for (let k = 1; k < 9; k++) { const f = k / 9; g.beginPath(); g.moveTo(w * (0.36 + 0.08 * f), cy + sy * h * (0.05 + 0.42 * f)); g.lineTo(w * (0.58 - 0.06 * f), cy + sy * h * (0.05 + 0.42 * f)); g.stroke(); }
    }
    g.beginPath(); g.moveTo(w * 0.86, cy); g.lineTo(w * 0.74, cy - h * 0.045); g.lineTo(w * 0.3, cy - h * 0.055); g.lineTo(w * 0.24, cy - h * 0.035);
    g.lineTo(w * 0.24, cy + h * 0.035); g.lineTo(w * 0.3, cy + h * 0.055); g.lineTo(w * 0.74, cy + h * 0.045); g.closePath();
    g.fillStyle = '#2a2d33'; g.fill(); g.strokeStyle = '#6a6f78'; g.lineWidth = w * 0.006; g.stroke();
    g.fillStyle = '#0d0e10'; g.fillRect(w * 0.3, cy - h * 0.012, w * 0.38, h * 0.024);
    g.fillStyle = '#5b616b'; g.fillRect(w * 0.42, cy - h * 0.035, w * 0.1, h * 0.07);
    g.fillStyle = '#07080a'; g.beginPath(); g.moveTo(w * 0.85, cy); g.lineTo(w * 0.78, cy - h * 0.028); g.lineTo(w * 0.78, cy + h * 0.028); g.closePath(); g.fill();
  }
  function drawTurret(g, w, h) {
    const cx = w / 2, cy = h / 2;
    g.fillStyle = '#1b1d22'; g.beginPath(); g.arc(cx, cy, w * 0.34, 0, 7); g.fill();
    g.strokeStyle = '#5f6670'; g.lineWidth = w * 0.04; g.stroke();
    g.fillStyle = '#4b5059'; g.fillRect(cx - w * 0.17, cy - h * 0.15, w * 0.3, h * 0.3);
    g.fillStyle = '#8a9099'; g.fillRect(cx - w * 0.13, cy - h * 0.11, w * 0.18, h * 0.22);
    g.fillStyle = '#2a2d33'; g.fillRect(cx + w * 0.1, cy - h * 0.1, w * 0.38, h * 0.06); g.fillRect(cx + w * 0.1, cy + h * 0.04, w * 0.38, h * 0.06);
  }
  function drawLight(g, w, h) {
    const cx = w / 2, cy = h / 2;
    g.fillStyle = '#1b1d22'; g.fillRect(cx - w * 0.3, cy - h * 0.3, w * 0.6, h * 0.6);
    g.strokeStyle = '#6a717b'; g.lineWidth = w * 0.05; g.strokeRect(cx - w * 0.3, cy - h * 0.3, w * 0.6, h * 0.6);
    g.fillStyle = '#9aa1ab'; g.beginPath(); g.arc(cx, cy, w * 0.17, 0, 7); g.fill();
  }
  function drawPuff(g, w, h) {
    const r = mulberry(7);
    for (let i = 0; i < 22; i++) {
      const a = r() * 6.283, d = Math.pow(r(), 0.7) * w * 0.26, x = w / 2 + Math.cos(a) * d, y = h / 2 + Math.sin(a) * d, rr = w * (0.08 + 0.13 * r());
      const gr = g.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, 7); g.fill();
    }
  }
  function drawCatwalk(g, w, h) {
    g.fillStyle = '#1d2026'; g.fillRect(0, h * 0.2, w, h * 0.6);
    g.fillStyle = '#6b727c'; g.fillRect(0, h * 0.18, w, h * 0.1); g.fillRect(0, h * 0.72, w, h * 0.1);
    g.fillStyle = '#3a3f47';
    for (let x = 0; x < w; x += h * 0.9) g.fillRect(x, h * 0.28, h * 0.2, h * 0.44);
  }
  function drawConduit(g, w, h) {
    g.fillStyle = 'rgba(10,12,16,0.9)'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#4c535d'; g.fillRect(0, h * 0.12, w, h * 0.14); g.fillRect(0, h * 0.74, w, h * 0.14);
    g.fillStyle = '#23272e'; g.fillRect(0, h * 0.3, w, h * 0.4);
    g.fillStyle = '#5a616b';
    for (let x = 6; x < w; x += 28) g.fillRect(x, h * 0.05, 5, h * 0.9);
  }
  function drawNode(g, w, h) {
    g.fillStyle = '#16181d'; g.fillRect(w * 0.1, h * 0.1, w * 0.8, h * 0.8);
    g.strokeStyle = '#69707a'; g.lineWidth = w * 0.05; g.strokeRect(w * 0.12, h * 0.12, w * 0.76, h * 0.76);
    g.fillStyle = '#3c424b'; g.beginPath(); g.arc(w / 2, h / 2, w * 0.25, 0, 7); g.fill();
    g.strokeStyle = '#8b929c'; g.lineWidth = w * 0.03; g.stroke();
    g.fillStyle = '#0b0c0f'; g.beginPath(); g.arc(w / 2, h / 2, w * 0.1, 0, 7); g.fill();
  }
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  /* ---------------- simulation ---------------- */
  function pushOut(x, y, minD) {
    for (let i = 0; i < 4; i++) {
      const d = fieldD(x, y); if (d >= minD) break;
      const g = fieldGrad(x, y), l = Math.hypot(g[0], g[1]) || 1;
      x += g[0] / l * (minD - d + 2); y += g[1] / l * (minD - d + 2);
    }
    return [x, y];
  }
  function fire(x, y, tx, ty, o) {
    const dx = tx - x, dy = ty - y, L = Math.hypot(dx, dy) || 1, sp = o.speed || 1100;
    bolts.push({ x, y, vx: dx / L * sp, vy: dy / L * sp, life: L / sp, age: 0, color: o.color, len: o.len || 16, ground: !!o.ground, width: o.width || 2, onHit: o.onHit });
  }
  function impact(x, y, size, kind) { impacts.push({ x, y, age: 0, life: kind === 'boom' ? 2.4 : 1.7, size, kind, rot: rnd() * 6.28 }); }
  function boom(x, y) {
    impact(x, y, 1.6, 'boom');
    for (let i = 0; i < 14; i++) { const a = rnd() * 6.283, s = 40 + rnd() * 140; debris.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, age: 0, life: 0.6 + rnd() * 0.9 }); }
  }
  function spawnRaid(ctx) {
    const W = ctx.W, H = ctx.H;
    let tx, ty;
    if (turrets.length) { const t = turrets[(rnd() * turrets.length) | 0]; tx = t.x; ty = t.y; } else { tx = W * (0.3 + rnd() * 0.4); ty = H * (0.3 + rnd() * 0.4); }
    const ang = rnd() * 6.283, ux = Math.cos(ang), uy = Math.sin(ang);
    let L = 200; while (L < 6000) { const sx = tx - ux * L, sy = ty - uy * L; if (sx < -120 || sy < -120 || sx > W + 120 || sy > H + 120) break; L += 40; }
    const n = 2 + ((rnd() * 2.2) | 0);
    for (let i = 0; i < n; i++) {
      const side = (i % 2 ? 1 : -1) * Math.ceil(i / 2);
      const bx = tx - ux * (L + Math.abs(side) * 40) - uy * side * 34, by = ty - uy * (L + Math.abs(side) * 40) + ux * side * 34;
      xws.push({ x: bx, y: by, ang, spd: 290, hp: 2 + ((rnd() * 2) | 0), alive: true, passed: false, fireT: 0.3 + rnd() * 0.4, tx: tx - uy * side * 22, ty: ty + ux * side * 22, wob: rnd() * 9, hit: 0 });
    }
    const nc = ctx.P.traffic > 0 ? 1 + ((rnd() * 2) | 0) : 1;
    for (let i = 0; i < nc; i++) {
      chasers.push({ x: tx - ux * (L + 260 + i * 50) + uy * (i - 0.5) * 50, y: ty - uy * (L + 260 + i * 50) - ux * (i - 0.5) * 50, ang, spd: 330, tgt: i, fireT: 1, life: 0 });
    }
  }
  function updateCharge(ctx) {
    const t = ctx.flow, v = phase0 + t / PERIOD, c = v - Math.floor(v), tp = c * PERIOD;
    ch.c = c;
    ch.glow = 0.06 + 1.2 * Math.pow(c, 2.4);
    if (c > 0.96) ch.glow += 0.35 * (c - 0.96) / 0.04 * (0.65 + 0.35 * Math.sin(t * 37));
    ch.flare = tp < 16 ? Math.exp(-tp * 0.55) * Math.min(1, tp / 0.12) : 0;
    ch.ring = geo.R + tp * (110 + 18 * tp);
    ch.ringA = tp < 8 && ctx.icons.length ? Math.min(1, tp / 0.2) * Math.pow(1 - tp / 8, 1.2) : 0;
    ch.flash = tp < 3 ? Math.exp(-tp * 2.2) * Math.min(1, tp / 0.08) : 0;
    ch.rate = 0.25 + 1.5 * c * c;
    const cyc = Math.floor(v);
    if (ch.cyc !== null && cyc !== ch.cyc) for (const tr of turrets) impact(tr.x + (rnd() - 0.5) * 20, tr.y + (rnd() - 0.5) * 20, 1.2, 'snow');
    ch.cyc = cyc;
  }

  /* ---------------- scene ---------------- */
  Galaxy.register(ID, {
    name: 'Ice fortress',
    post: { bloom: 1.2, threshold: 1.4, knee: 0.4, exposure: 0.72, vignette: 0.66, grain: 0.022, aberration: 0.0011, tint: [0.96, 1.0, 1.06], lift: [0.0, 0.003, 0.008], saturation: 1.04, bloomRadius: 1.1 },

    init(ctx) {
      C = ctx;
      const gl = ctx.gl;
      progT = ctx.program(TERRAIN_FS);
      progL = ctx.program(LIVE_FS);
      for (let i = 0; i < 2; i++) { fTex[i] = makeTex(gl); farTex[i] = makeTex(gl); }
      fNew = null; farNew = null; fW = fH = 0;
      const r = ctx.rng(5); rnd = ctx.rng(6);
      const wa = 0.25 + (r() - 0.5) * 0.7;
      wind = [Math.cos(wa), Math.sin(wa)];
      phase0 = QS.has('stcharge') ? +QS.get('stcharge') : 0.25 + r() * 0.5;
      ch.cyc = null;
      shuttleT = QS.has('stshuttle') ? 0 : 4 + r() * 40;
      shuttle = null;
      raidT = 3 + r() * 6;
      bolts = []; impacts = []; debris = []; xws = []; chasers = [];
      ctx.atlas.define('tie0', 192, 192, (g, w, h) => drawTie(g, w, h, 0));
      ctx.atlas.define('tie1', 192, 192, (g, w, h) => drawTie(g, w, h, 1));
      ctx.atlas.define('xwing', 224, 224, drawXwing);
      ctx.atlas.define('shuttle', 512, 512, drawShuttle);
      ctx.atlas.define('turret', 96, 96, drawTurret);
      ctx.atlas.define('slight', 64, 64, drawLight);
      ctx.atlas.define('puff', 192, 192, drawPuff);
      ctx.atlas.define('catwalk', 512, 32, drawCatwalk);
      ctx.atlas.define('cond', 512, 24, drawConduit);
      ctx.atlas.define('node', 96, 96, drawNode);
      flock = new ctx.Flock({ count: 0, speed: 165, turn: 1.3, margin: 34, wander: 0.45, formation: 2, spacing: 28, seedK: 23 });
      dirty = true;
    },

    resize(ctx) {
      if (terr) ctx.freeTarget(terr);
      terr = ctx.makeTarget(ctx.pxW, ctx.pxH);
      dirty = true;
    },

    layout(ctx) {
      C = ctx;
      const gl = ctx.gl;
      const s = ctx.W > 2600 ? 3 : 2;
      const nw = Math.ceil(ctx.W / s) + 2, nh = Math.ceil(ctx.H / s) + 2;
      const resized = nw !== fW || nh !== fH || s !== fStep;
      fStep = s; fW = nw; fH = nh;
      farW = Math.ceil(ctx.W / farStep) + 2; farH = Math.ceil(ctx.H / farStep) + 2;
      computeGeo();
      const list = ctx.icons;
      const nf = buildField(list), nfar = buildFar(list);
      const oldF = (!fNew || resized) ? nf.d : fNew, oldFar = (!farNew || resized) ? nfar : farNew;
      fNew = nf.d; farNew = nfar;
      upload(gl, fTex[0], fW, fH, oldF); upload(gl, fTex[1], fW, fH, fNew);
      upload(gl, farTex[0], farW, farH, oldFar); upload(gl, farTex[1], farW, farH, farNew);
      placeFurniture(nf.base);
      dirty = true;
    },

    update(ctx) {
      C = ctx;
      const dt = ctx.dt, t = ctx.flow, P = ctx.P, W = ctx.W, H = ctx.H;
      updateCharge(ctx);
      // patrols
      flock.resize(Math.round(P.traffic * 4) * 3);
      flock.update(dt, t);
      // shuttle
      shuttleT -= dt;
      if (!shuttle && shuttleT <= 0 && P.traffic > 0) {
        const a = rnd() * 6.283, ux = Math.cos(a), uy = Math.sin(a), diag = Math.hypot(W, H);
        const off = (rnd() - 0.5) * 0.6;
        const cx = W / 2 - uy * off * H, cy = H / 2 + ux * off * H;
        shuttle = { x: cx - ux * (diag / 2 + 160), y: cy - uy * (diag / 2 + 160), ang: a, spd: 58, life: (diag + 320) / 58 };
        if (QS.has('stshuttle') && t < 1) { shuttle.x = cx - ux * 200; shuttle.y = cy - uy * 200; }
        shuttleT = (70 + rnd() * 90) / Math.max(0.3, P.traffic);
      }
      if (shuttle) { shuttle.x += Math.cos(shuttle.ang) * shuttle.spd * dt; shuttle.y += Math.sin(shuttle.ang) * shuttle.spd * dt; shuttle.life -= dt; if (shuttle.life < 0) shuttle = null; }
      // turret idle sweep and searchlights
      for (const tr of turrets) {
        let target = null, best = 420;
        for (const x of xws) if (x.alive) { const d = Math.hypot(x.x - tr.x, x.y - tr.y); if (d < best) { best = d; target = x; } }
        const idle = tr.out + Math.sin(t * 0.21 + tr.ph) * 1.2;
        const want = target ? Math.atan2(target.y + Math.sin(target.ang) * 40 - tr.y, target.x + Math.cos(target.ang) * 40 - tr.x) : idle;
        tr.aim += clamp(angTo(tr.aim, want), -2.5 * dt, 2.5 * dt);
        if (tr.kind === 'light') { tr.beam = tr.aim; tr.bdist = target ? Math.min(best, 260) : 120 + 45 * Math.sin(t * 0.17 + tr.ph * 1.7); }
        if (target && tr.kind === 'gun' && P.skirmish > 0) {
          tr.fireT -= dt;
          if (tr.fireT <= 0 && Math.abs(angTo(tr.aim, want)) < 0.3) {
            const tx = target.x + Math.cos(target.ang) * target.spd * 0.25 + (rnd() - 0.5) * 50, ty = target.y + Math.sin(target.ang) * target.spd * 0.25 + (rnd() - 0.5) * 50;
            const bx = tr.x + Math.cos(tr.aim) * 7, by = tr.y + Math.sin(tr.aim) * 7;
            fire(bx, by, tx, ty, { color: [0.25, 1.0, 0.35], speed: 900, len: 12, width: 1.6, onHit: () => { if (Math.hypot(tx - target.x, ty - target.y) < 22 && target.alive) hitXw(target); } });
            tr.fireT = 0.12 + rnd() * 0.12 + (rnd() < 0.2 ? 0.8 : 0);
          }
        }
      }
      // raids
      if (P.skirmish > 0) {
        raidT -= dt;
        if (raidT <= 0 && xws.length === 0) { spawnRaid(ctx); raidT = (90 - 72 * P.skirmish) * (0.6 + 0.8 * rnd()); }
      }
      for (const x of xws) {
        if (!x.alive) continue;
        const dx = x.tx - x.x, dy = x.ty - x.y, dist = Math.hypot(dx, dy);
        if (!x.passed && (dx * Math.cos(x.ang) + dy * Math.sin(x.ang) < 40)) x.passed = true;
        let want = x.passed ? x.ang : Math.atan2(dy, dx);
        want += Math.sin(t * 1.7 + x.wob) * 0.12;
        x.ang += clamp(angTo(x.ang, want), -1.0 * dt, 1.0 * dt);
        x.x += Math.cos(x.ang) * x.spd * dt; x.y += Math.sin(x.ang) * x.spd * dt;
        x.hit = Math.max(0, x.hit - dt * 3);
        if (!x.passed && dist < 560 && dist > 70) {
          x.fireT -= dt;
          if (x.fireT <= 0) {
            const [ix, iy] = pushOut(x.tx + (rnd() - 0.5) * 60, x.ty + (rnd() - 0.5) * 60, geo.R + 4);
            for (const s of [-1, 1]) {
              const px = -Math.sin(x.ang) * s * 11, py = Math.cos(x.ang) * s * 11;
              fire(x.x + px + Math.cos(x.ang) * 14, x.y + py + Math.sin(x.ang) * 14, ix + px * 0.6, iy + py * 0.6, { color: [1.0, 0.12, 0.06], speed: 1150, len: 20, width: 2.2, ground: true });
            }
            x.fireT = 0.2 + rnd() * 0.25 + (rnd() < 0.25 ? 0.5 : 0);
          }
        }
        if (x.passed && (x.x < -220 || x.y < -220 || x.x > W + 220 || x.y > H + 220)) x.alive = false;
      }
      for (const c of chasers) {
        c.life += dt;
        const alive = xws.filter(x => x.alive);
        let tg = alive.length ? alive[c.tgt % alive.length] : null;
        let want = c.ang;
        if (tg) want = Math.atan2(tg.y + Math.sin(tg.ang) * 60 - c.y, tg.x + Math.cos(tg.ang) * 60 - c.x);
        c.ang += clamp(angTo(c.ang, want), -2.0 * dt, 2.0 * dt);
        c.x += Math.cos(c.ang) * c.spd * dt; c.y += Math.sin(c.ang) * c.spd * dt;
        if (tg) {
          const d = Math.hypot(tg.x - c.x, tg.y - c.y);
          c.spd = d > 140 ? 340 : 285;
          c.fireT -= dt;
          if (c.fireT <= 0 && d < 330 && Math.abs(angTo(c.ang, Math.atan2(tg.y - c.y, tg.x - c.x))) < 0.28) {
            const tx = tg.x + (rnd() - 0.5) * 36, ty = tg.y + (rnd() - 0.5) * 36, target = tg;
            for (const s of [-1, 1]) {
              const px = -Math.sin(c.ang) * s * 3, py = Math.cos(c.ang) * s * 3;
              fire(c.x + px + Math.cos(c.ang) * 8, c.y + py + Math.sin(c.ang) * 8, tx + px, ty + py, { color: [0.3, 1.0, 0.3], speed: 1000, len: 14, width: 1.8, onHit: s > 0 ? () => { if (target.alive && Math.hypot(tx - target.x, ty - target.y) < 26) hitXw(target); } : null });
            }
            c.fireT = 0.25 + rnd() * 0.3;
          }
        }
      }
      chasers = chasers.filter(c => c.life < 3 || (c.x > -300 && c.y > -300 && c.x < W + 300 && c.y < H + 300));
      xws = xws.filter(x => x.alive);
      if (!xws.length && chasers.length) for (const c of chasers) c.life = Math.max(c.life, 3);
      // bolts, impacts, debris
      for (const b of bolts) {
        b.age += dt; b.x += b.vx * dt; b.y += b.vy * dt;
        if (b.age >= b.life) {
          b.dead = true;
          if (b.ground) impact(b.x, b.y, 0.7 + rnd() * 0.5, 'snow');
          else impacts.push({ x: b.x, y: b.y, age: 0, life: 0.3, size: 0.4, kind: 'air', rot: 0 });
          if (b.onHit) b.onHit();
        }
      }
      bolts = bolts.filter(b => !b.dead);
      for (const m of impacts) m.age += dt;
      impacts = impacts.filter(m => m.age < m.life);
      for (const d of debris) { d.age += dt; d.x += d.vx * dt; d.y += d.vy * dt; d.vx *= 1 - dt * 1.5; d.vy *= 1 - dt * 1.5; }
      debris = debris.filter(d => d.age < d.life);
    },

    render(ctx) {
      frameNo++;
      const settling = !ctx.fieldStable || ctx.intro < 1;
      if (settling) pendingFinal = true;
      let doCache = dirty || (settling && frameNo - lastCache >= 2);
      if (!settling && pendingFinal) { doCache = true; pendingFinal = false; }
      const grow = Math.pow(1 - ctx.intro, 2) * (geo.R + geo.Ap + 90);
      const U = {
        uM: ctx.morph, uFS: fStep, uFG: [fW, fH], uFarS: farStep, uFarG: [farW, farH], uGrow: grow,
        uF: geo.F, uR: geo.R, uAp: geo.Ap, uDepth: geo.depth, uWind: wind, uQ: ctx.P.quality
      };
      const T = { uDA: fTex[0], uDB: fTex[1], uFarA: farTex[0], uFarB: farTex[1] };
      if (doCache && terr) {
        ctx.fullscreen(progT, U, T, terr);
        dirty = false; lastCache = frameNo;
      }
      const UL = Object.assign({ uGlow: ch.glow, uFlare: ch.flare, uRing: ch.ring, uRingA: ch.ringA, uRate: ch.rate, uFlash: ch.flash }, U);
      ctx.fullscreen(progL, UL, Object.assign({ uTer: terr.tex }, T), null);

      const t = ctx.flow, ia = ctx.intro, fa = ia * (ctx.fieldStable ? 1 : ctx.morph);
      const lvl = ch.glow + ch.flare * 2.6;
      // catwalks
      for (const cw of catwalks) {
        ctx.sprite('catwalk', cw.x, cw.y, { w: cw.len, h: 5, alpha: fa, tint: [0.9, 0.92, 1.0], shadow: { dx: 5, dy: 4, alpha: 0.6, bias: 1.5 } });
        const n = Math.max(2, Math.round(cw.len / 22));
        for (let i = 0; i <= n; i++) { const x = cw.x - cw.len / 2 + (i / n) * cw.len; ctx.glowDot(x, cw.y, 2.2, [1, 0.15, 0.05], (0.6 + 1.5 * lvl) * fa, { core: 0.6 }); }
      }
      // power conduits with energy pulses running toward the trench
      for (const c of conduits) {
        const mx = (c.x0 + c.x1) / 2, my = (c.y0 + c.y1) / 2, ux = Math.cos(c.ang), uy = Math.sin(c.ang);
        ctx.sprite('cond', mx, my, { w: c.L, h: 4.5, rot: c.ang, alpha: fa });
        ctx.glowLine(c.x0, c.y0, c.x1, c.y1, 1.6, [1, 0.08, 0.02], (0.25 + 1.2 * lvl) * fa, { core: 0.3 });
        const spacing = 34, sp = (26 + 70 * ch.c * ch.c + 140 * ch.flare) * c.spd, off = (t * sp + c.ph) % spacing;
        for (let d = c.L - off; d > 0; d -= spacing) {
          const k = Math.min(1, d / 10) * Math.min(1, (c.L - d) / 10);
          ctx.glowDot(c.x0 + ux * d, c.y0 + uy * d, 3.2, [1, 0.16, 0.04], (0.6 + 4.5 * lvl) * k * fa, { core: 0.6 });
        }
        ctx.sprite('node', c.x1 + ux * 5, c.y1 + uy * 5, { w: 12, rot: c.ang, alpha: fa, shadow: { dx: 2.5, dy: 2, alpha: 0.6, bias: 1 } });
        ctx.glowDot(c.x1 + ux * 5, c.y1 + uy * 5, 2.6, [1, 0.12, 0.03], (0.8 + 3 * lvl) * fa * (0.6 + 0.4 * Math.sin(t * 3 + c.ph)), { core: 0.7 });
      }
      // ground impacts (snow bursts)
      for (const m of impacts) {
        const k = m.age / m.life;
        if (m.kind === 'snow' || m.kind === 'boom') {
          const s = m.size * (m.kind === 'boom' ? 60 : 34) * (0.35 + 0.9 * Math.pow(k, 0.45));
          ctx.sprite('puff', m.x + k * 16 * wind[0], m.y + k * 16 * wind[1], { w: s, rot: m.rot + k * 0.6, alpha: 0.85 * (1 - k) * (1 - k), tint: [0.92, 0.95, 1.0] });
        }
      }
      // turrets and searchlights
      for (const tr of turrets) {
        if (tr.kind === 'light') {
          const bx = tr.x + Math.cos(tr.beam) * tr.bdist, by = tr.y + Math.sin(tr.beam) * tr.bdist;
          const ok = clamp((fieldD(bx, by) - geo.R - 20) / 40, 0, 1) * clamp((fieldD((tr.x + bx) / 2, (tr.y + by) / 2) - geo.R) / 30, 0, 1);
          if (ok > 0) {
            ctx.glowLine(tr.x, tr.y, bx, by, 9, [0.65, 0.8, 1.0], 0.10 * fa * ok, { core: 0 });
            ctx.glowLine(bx - Math.cos(tr.beam) * 14, by - Math.sin(tr.beam) * 14, bx + Math.cos(tr.beam) * 14, by + Math.sin(tr.beam) * 14, 24, [0.75, 0.86, 1.0], 0.42 * fa * ok, { core: 0, falloff: 3.5 });
          }
          ctx.sprite('slight', tr.x, tr.y, { w: 10, rot: tr.beam, alpha: fa, shadow: { dx: 3, dy: 3, alpha: 0.5, bias: 1 } });
          ctx.glowDot(tr.x + Math.cos(tr.beam) * 3, tr.y + Math.sin(tr.beam) * 3, 4, [0.8, 0.9, 1.0], 2.5 * fa, { core: 1 });
        } else {
          ctx.sprite('turret', tr.x, tr.y, { w: 14, rot: tr.aim, alpha: fa, shadow: { dx: 3, dy: 3, alpha: 0.55, bias: 1 } });
        }
        const blink = Math.pow(0.5 + 0.5 * Math.sin(t * 2.2 + tr.ph), 12);
        ctx.glowDot(tr.x - Math.cos(tr.aim) * 5, tr.y - Math.sin(tr.aim) * 5, 3, [1, 0.12, 0.04], (0.4 + 5 * blink) * fa, { core: 0.8 });
      }
      // shuttle
      if (shuttle) {
        const s = shuttle;
        ctx.sprite('shuttle', s.x, s.y, { w: 150, rot: s.ang, shadow: { dx: 80, dy: 64, alpha: 0.55, bias: 3, scale: 1.02 } });
        const bx = s.x - Math.cos(s.ang) * 34, by = s.y - Math.sin(s.ang) * 34;
        ctx.glowDot(bx, by, 7, [0.6, 0.75, 1.0], 3, { core: 0.7 });
        const bl = Math.pow(0.5 + 0.5 * Math.sin(t * 3), 16) * 6;
        for (const sy of [-1, 1]) ctx.glowDot(s.x - Math.sin(s.ang) * sy * 68, s.y + Math.cos(s.ang) * sy * 68, 3, [1, 0.15, 0.05], bl, { core: 1 });
      }
      // patrol fighters
      const agents = flock.agents;
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i], kind = ((i / 3) | 0) % 2;
        ctx.sprite(kind ? 'tie1' : 'tie0', a.x, a.y, { w: 30, rot: a.ang, shadow: { dx: 34, dy: 27, alpha: 0.5, bias: 2 } });
        ctx.glowDot(a.x - Math.cos(a.ang) * 4, a.y - Math.sin(a.ang) * 4, 3, [0.7, 0.8, 1.0], 1.2, { core: 0.6 });
      }
      for (const c of chasers) {
        ctx.sprite('tie1', c.x, c.y, { w: 30, rot: c.ang, shadow: { dx: 34, dy: 27, alpha: 0.5, bias: 2 } });
        ctx.glowDot(c.x - Math.cos(c.ang) * 4, c.y - Math.sin(c.ang) * 4, 3.5, [0.7, 0.8, 1.0], 1.8, { core: 0.6 });
      }
      for (const x of xws) {
        ctx.sprite('xwing', x.x, x.y, { w: 40, rot: x.ang, tint: x.hit > 0 ? [1 + x.hit * 3, 1 + x.hit * 1.5, 1 + x.hit] : [1, 1, 1], shadow: { dx: 38, dy: 30, alpha: 0.5, bias: 2 } });
        const c = Math.cos(x.ang), s = Math.sin(x.ang);
        for (const sy of [-1, 1]) ctx.glowDot(x.x - c * 12 - s * sy * 3.2, x.y - s * 12 + c * sy * 3.2, 3, [1.0, 0.45, 0.25], 3.2, { core: 0.8 });
      }
      // bolts
      for (const b of bolts) {
        const sp = Math.hypot(b.vx, b.vy), ux = b.vx / sp, uy = b.vy / sp;
        ctx.glowLine(b.x - ux * b.len, b.y - uy * b.len, b.x, b.y, b.width * 2.2, b.color, 7, { core: 1.3, coreR: 0.32 });
      }
      // flashes, fireballs, debris
      for (const m of impacts) {
        const k = m.age / m.life;
        if (m.kind === 'snow') { const f = Math.max(0, 1 - k * 4); ctx.glowDot(m.x, m.y, 8 + 14 * k, [1, 0.45, 0.15], 9 * f * f, { core: f }); }
        else if (m.kind === 'air') { const f = 1 - k; ctx.glowDot(m.x, m.y, 5 + 6 * k, [0.4, 1, 0.4], 3 * f * f, { core: f }); }
        else if (m.kind === 'boom') {
          const f = Math.max(0, 1 - k * 2.2);
          ctx.glowDot(m.x, m.y, 18 + 40 * k, [1, 0.5, 0.15], 14 * f * f, { core: f });
          ctx.sprite('puff', m.x, m.y, { w: 20 + 50 * k, rot: m.rot, alpha: 0.7 * (1 - k), tint: [0.25, 0.22, 0.22] });
        }
      }
      for (const d of debris) { const f = 1 - d.age / d.life; ctx.glowLine(d.x - d.vx * 0.03, d.y - d.vy * 0.03, d.x, d.y, 1.6, [1, 0.5, 0.2], 6 * f, { core: f }); }
    },

    dispose(ctx) {
      const gl = ctx.gl;
      if (progT) gl.deleteProgram(progT.p); if (progL) gl.deleteProgram(progL.p);
      for (let i = 0; i < 2; i++) { if (fTex[i]) gl.deleteTexture(fTex[i]); if (farTex[i]) gl.deleteTexture(farTex[i]); fTex[i] = farTex[i] = null; }
      if (terr) ctx.freeTarget(terr); terr = null; progT = progL = null; fNew = farNew = null;
    }
  });

  function hitXw(x) {
    x.hit = 1; x.hp--;
    if (x.hp <= 0 && x.alive) { x.alive = false; boom(x.x, x.y); }
  }
})();
