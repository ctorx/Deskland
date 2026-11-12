// Galaxy scene st-empire: Sequel trilogy, Empire side. "Ice fortress planet".
// Straight down onto a frozen world carved into a superweapon. Every desktop icon sits on a pedestal inside an angular,
// terraced trench cut into the ice; nearby icons share one trench complex. Red energy glows in the trench channels and
// builds over a three-minute charge cycle. At the pulse the trenches flare, a smooth shockwave crosses the snow and the
// glow resets. Patrols of black fighters, an occasional command shuttle, rim searchlights and turrets, and (with
// Skirmishes) attack runs by cross-winged raiders bring the surface to life.
//
// Structure (cheap per frame, expensive work cached):
//   - Noise texture (once): a tiling 1024 px RGBA noise map rendered on the GPU and mipmapped. The live pass reads it
//     instead of evaluating fbm stacks per pixel.
//   - Natural terrain (once per resize / seed / texture load): snowfields with wind-sculpted dunes and sastrugi, rock ridges
//     with strata, snow-laden conifer forests with cast shadows, bounded frozen lakes and crevasse fields. It does not depend
//     on the icons, so moving an icon never re-renders it. Photographic CC0 rock and snow maps add surface detail.
//   - Fortress composite (on layout, during morphs and the grow-in): ploughed snow around the complex, trench walls,
//     floors, aprons and pylons, composited over the natural terrain.
//   - Live pass (every frame): heat shimmer, cloud shadows, red energy, steam, shockwave, blowing snow, sparkle.
//   - Sprites and glows: turrets, catwalks, conduits, searchlights, fighters, shuttle, raiders, bolts, snow bursts.
(function () {
  'use strict';
  const ID = 'st-empire';
  const QS = new URLSearchParams(location.search);
  const ASSET = 'assets/galaxy/st-empire/';
  const PERIOD = 180;          // charge cycle, flow seconds
  const FCAP = 300;            // own field cap, CSS px
  const CW = 76, CH = 100;
  const RING_K = 70;           // smooth-union radius of the shockwave field, CSS px

  let C = null;
  let progN = null, progNat = null, progT = null, progL = null;
  let noiseT = null, natT = null, terr = null, rockTex = null, snowTex = null;
  const fTex = [null, null], farTex = [null, null];
  let fStep = 2, fW = 0, fH = 0, farStep = 16, farW = 0, farH = 0;
  let fNew = null, farNew = null;
  const geo = { F: 3, R: 32, Ap: 18, depth: 24 };
  let dirty = true, natDirty = true, noiseDirty = true, pendingFinal = false;
  let turrets = [], catwalks = [], conduits = [];
  let flock = null;
  let wind = [1, 0];
  let phase0 = 0.4;
  const ch = { c: 0, glow: 0, flare: 0, ring: 0, ringA: 0, flash: 0, cyc: null };
  let bolts = [], impacts = [], debris = [], xws = [], chasers = [], raidT = 20, shuttle = null, shuttleT = 10;
  let rnd = Math.random;
  // time of day, weather, cursor and point-and-fire state
  let strikes = [], craters = [], smokes = [];
  let wph = 0, windA = 0, windA0 = 0, windInit = false, lastLit = 0, trackT = 0, lastPM = null;
  const litP = [0, 0];
  const norm3 = v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  // Designed light: a low, cold late-afternoon sun from the upper left (the reference look, defaultHour 17.1)
  const DES = { L: norm3([-0.72, -0.56, 0.30]), sun: [1.18, 1.1092, 1.0148], sky: [0.1536, 0.2208, 0.4128], az: Math.atan2(-0.56, -0.72) };
  const liteOf = (L, sun, sky) => [0, 1, 2].map(i => sun[i] * Math.max(L[2], 0) * 1.1 + sky[i] * 0.9);
  const DES_LITE = liteOf(DES.L, DES.sun, DES.sky);
  const lumOf = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  // Key (sun) and sky colours by sun elevation in degrees: alpenglow at the horizon, white light at noon, blue twilight
  const SUN_T = [[-3, [0, 0, 0]], [0, [1.3, 0.46, 0.34]], [4, [2.5, 1.25, 0.82]], [9, [2.05, 1.2, 0.86]], [18.2, DES.sun], [52, [1.32, 1.29, 1.24]]];
  const SKY_T = [[-14, [0.022, 0.036, 0.095]], [-6, [0.05, 0.062, 0.17]], [-1, [0.09, 0.11, 0.3]], [4, [0.085, 0.13, 0.34]], [18.2, DES.sky], [52, [0.21, 0.28, 0.46]]];
  const MOON = { L: norm3([0.5, -0.62, 0.6]), col: [0.15, 0.22, 0.4] };
  function table(tab, e) {
    if (e <= tab[0][0]) return tab[0][1].slice();
    for (let i = 1; i < tab.length; i++) if (e <= tab[i][0]) {
      const e0 = tab[i - 1][0], c0 = tab[i - 1][1], c1 = tab[i][1];
      let k = (e - e0) / (tab[i][0] - e0); k = k * k * (3 - 2 * k);
      return c0.map((v, j) => v + (c1[j] - v) * k);
    }
    return tab[tab.length - 1][1].slice();
  }
  // Everything the shaders and sprites need from ctx.env, recomputed each frame
  const E = { L: DES.L, sun: DES.sun, sky: DES.sky, lite: [1, 1, 1], lum: 1, night: 0, dusk: 0, cloud: 0, snowF: 0, sleet: 0, storm: 0, fog: 0,
    ws: 1, litF: 0, aur: 0, emK: 1, spk: 1, ST: [1, 1, 1], shC: 1, shS: 0, shL: 1, shA: 1, slK: 1 };
  let cacheLight = null;
  function envUpdate(ctx) {
    const env = ctx.env || {};
    let L = DES.L, sun = DES.sun, sky = DES.sky, az = DES.az, tanE = DES.L[2] / Math.hypot(DES.L[0], DES.L[1]);
    E.night = 0; E.dusk = 0;
    if (env.timeActive) {
      const e = env.sunElev, h = env.hour;
      if (e > -3.5) {
        const el = Math.max(e, 1.2) * Math.PI / 180;
        az = DES.az + clamp((h - 17.1) * 6, -60, 20) * Math.PI / 180;
        L = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
        sun = table(SUN_T, e); tanE = Math.tan(el);
      } else {
        let k = clamp((-3.5 - e) / 6.5, 0, 1); k = k * k * (3 - 2 * k);
        L = MOON.L; sun = MOON.col.map(v => v * k); az = Math.atan2(L[1], L[0]); tanE = L[2] / Math.hypot(L[0], L[1]);
      }
      sky = table(SKY_T, e);
      E.night = env.night || 0; E.dusk = env.dusk || 0;
    }
    E.L = L; E.sun = sun; E.sky = sky;
    const lt = liteOf(L, sun, sky);
    E.lite = lt.map((v, i) => v / DES_LITE[i]);
    E.lum = lumOf(lt) / lumOf(DES_LITE);
    const w = env.weatherActive ? env : {};
    E.cloud = w.cloud || 0; E.storm = w.storm || 0; E.fog = w.fog || 0;
    E.snowF = clamp((w.snow || 0) + E.storm * 0.9, 0, 1);
    E.sleet = (w.rain || 0) * (1 - E.storm);
    E.ws = (env.wind != null ? env.wind : 0.3) / 0.3;
    E.litF = env.lightning || 0;
    if (E.litF > lastLit + 0.3) { litP[0] = Math.random() * ctx.W; litP[1] = Math.random() * ctx.H; }
    lastLit = E.litF;
    const night = E.night;
    E.aur = night * night * (1 - 0.9 * E.cloud) * (1 - 0.7 * E.fog) * (1 - 0.8 * E.snowF);
    E.emK = 1 + 0.6 * night + 0.25 * E.fog;
    E.spk = (1 - 0.55 * night) * (1 - 0.85 * E.cloud) * (1 - 0.7 * E.fog) * (1 - 0.5 * E.snowF) + 0.7 * E.sleet;
    // sprites share the terrain's light; their shadows follow the key light and soften under cloud, fog and snow
    const dk = 1 - 0.22 * E.cloud - 0.15 * E.snowF;
    E.ST = E.lite.map(v => clamp(v * dk, 0.06, 2.5));
    E.shC = Math.cos(az - DES.az); E.shS = Math.sin(az - DES.az);
    E.shL = clamp((DES.L[2] / Math.hypot(DES.L[0], DES.L[1])) / Math.max(tanE, 1e-3), 0.35, 2.4);
    E.shA = (1 - 0.7 * E.cloud) * (1 - 0.3 * night) * (1 - 0.5 * E.fog) * (1 - 0.4 * E.snowF);
    E.slK = 1 + 2.2 * night + 1.4 * E.fog + 0.8 * E.snowF;
    // the caches bake the key light: rebuild them when it has moved noticeably (minutes apart with the real clock)
    const key = L.concat(sun, sky);
    if (!cacheLight || key.some((v, i) => Math.abs(v - cacheLight[i]) > 0.012)) { cacheLight = key; natDirty = true; dirty = true; }
    // blowing snow follows the live wind direction (the seeded direction when weather is off)
    const tA = env.weatherActive && env.windDir != null ? env.windDir : windA0;
    if (!windInit) { windA = tA; windInit = true; } else windA += angTo(windA, tA) * Math.min(1, ctx.rawDt / 5);
    wph += ctx.dt * E.ws;
  }
  // Sprite wrapper: tint by the scene light, rotate and stretch shadows with the key light
  const ONE = [1, 1, 1];
  function spr(name, x, y, o) {
    const s = o.shadow;
    if (s) o.shadow = { dx: (s.dx * E.shC - s.dy * E.shS) * E.shL, dy: (s.dx * E.shS + s.dy * E.shC) * E.shL, alpha: s.alpha * E.shA, bias: s.bias, scale: s.scale };
    const t = o.tint || ONE;
    o.tint = [t[0] * E.ST[0], t[1] * E.ST[1], t[2] * E.ST[2]];
    C.sprite(name, x, y, o);
  }

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
  // Octagonal (chamfered) distance to the icon cells, with bridges between close neighbours: crisp trench outlines
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
  // Smooth union of euclidean distances to all icons (log-sum-exp): the shockwave front has no cusps where waves meet
  function buildFar(list) {
    const n = farW * farH, acc = new Float64Array(n), d = new Float32Array(n);
    const rects = iconRects(list);
    if (!rects.length) { d.fill(6000); return d; }
    for (const r of rects) {
      for (let gy = 0; gy < farH; gy++) {
        const qy = Math.abs(gy * farStep - r.cy) - r.hh, oy = qy > 0 ? qy : 0, row = gy * farW;
        for (let gx = 0; gx < farW; gx++) {
          const qx = Math.abs(gx * farStep - r.cx) - r.hw, ox = qx > 0 ? qx : 0;
          const sd = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0);
          acc[row + gx] += Math.exp(-sd / RING_K);
        }
      }
    }
    for (let i = 0; i < n; i++) d[i] = Math.min(6000, -RING_K * Math.log(Math.max(acc[i], 1e-300)));
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
      const Lmax = 70 + 130 * C.hash(Math.round(x), Math.round(y), 92);
      let L = 0, prev = fieldD(x, y);
      while (L < Lmax) {
        const nx = x + ux * (L + 4), ny = y + uy * (L + 4), d = fieldD(nx, ny);
        if (d < prev - 0.5 || nx < 0 || ny < 0 || nx > W || ny > H - 48) break;
        prev = d; L += 4;
      }
      if (L < 48) return;
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
  // Tiling noise map: r, g = fbm (two seeds), b = ridged, a = fine fbm. One tile = 1 texture unit.
  const NOISE_FS = `
vec2 pgrad(vec2 i, float P, float s) { return hash22(mod(i, P) + s * 37.13) * 2. - 1.; }
float pgn(vec2 p, float P, float s) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float va = dot(pgrad(i, P, s), f), vb = dot(pgrad(i + vec2(1, 0), P, s), f - vec2(1, 0));
  float vc = dot(pgrad(i + vec2(0, 1), P, s), f - vec2(0, 1)), vd = dot(pgrad(i + vec2(1, 1), P, s), f - vec2(1, 1));
  return va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
}
float pfbm(vec2 uv, float P, float s, int o) { float t = 0., a = .5; for (int i = 0; i < 7; i++) { if (i >= o) break; t += a * pgn(uv * P, P, s + float(i)); P *= 2.; a *= .5; } return t; }
float pridge(vec2 uv, float P, float s, int o) { float t = 0., a = .5; for (int i = 0; i < 7; i++) { if (i >= o) break; t += a * (1. - abs(pgn(uv * P, P, s + float(i)) * 1.6)); P *= 2.; a *= .5; } return t; }
void main() {
  vec2 uv = gl_FragCoord.xy / uPx;
  float r = 0.5 + 0.95 * pfbm(uv, 4., 1., 7);
  float g = 0.5 + 0.95 * pfbm(uv, 4., 11., 7);
  float b = pridge(uv, 4., 21., 6);
  float a = 0.5 + 0.95 * pfbm(uv, 16., 31., 5);
  outColor = clamp(vec4(r, g, b, a), 0., 1.);
}`;

  const FIELD_GLSL = `
uniform sampler2D uDA, uDB, uFarA, uFarB, uNz;
uniform float uM, uFS, uGrow, uFarS;
uniform vec2 uFG, uFarG;
uniform float uF, uR, uAp, uDepth, uQ;
uniform vec2 uWind;
float tD(vec2 p) { vec2 uv = (p / uFS + 0.5) / uFG; return mix(texture(uDA, uv).r, texture(uDB, uv).r, uM) + uGrow; }
float tFar(vec2 p) { vec2 uv = (p / uFarS + 0.5) / uFarG; return mix(texture(uFarA, uv).r, texture(uFarB, uv).r, uM) + uGrow; }
uniform vec3 uL, uSunC, uSkyC;   // key light direction and colour, sky ambient (time of day; designed: low cold sun)
vec3 sunDir() { return uL; }
#define SUNC uSunC
#define SKYC uSkyC
vec2 seedOff() { return vec2(fract(uSeed * 0.0137) * 300. + 17., fract(uSeed * 0.0291) * 300. + 5.); }
`;

  /* Natural terrain: icon independent, rendered once. Output rgb = lit ground, a = fresh-snow mask (sparkle). */
  const NAT_FS = FIELD_GLSL + `
uniform sampler2D uRock, uSnow;
vec2 SO, WD, WP;
// fbm whose small octaves fall off faster than 1/2: snow fills the small hollows, so fine relief is gentle
float fbmG(vec2 p, int o, float g) { float s = 0., a = .5, n = 0.; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 8; i++) { if (i >= o) break; s += a * vnoise(p); n += a; p = m * p; a *= g; } return s / n; }
float ridgedG(vec2 p, int o, float g) { float s = 0., a = .5, n = 0.; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 8; i++) { if (i >= o) break; s += a * (1. - abs(gnoise(p) * 1.4)); n += a; p = m * p; a *= g; } return s / n; }
float macro(vec2 p, int o, out float ridge, out float base) {
  vec2 q = p + SO * 97.;
  vec2 w = vec2(fbm(q * 0.0011, 3), fbm(q * 0.0011 + 7.7, 3)) - 0.5;
  base = fbmG(q * 0.00085 + w * 0.9, o, 0.4);
  ridge = ridgedG(q * 0.0014 + w * 1.5 + 3.1, o, 0.42);
  return base * 140. + pow(max(ridge - 0.55, 0.), 1.5) * 700.;
}
float baseAt(vec2 p) {
  vec2 q = p + SO * 97.;
  vec2 w = vec2(fbm(q * 0.0011, 3), fbm(q * 0.0011 + 7.7, 3)) - 0.5;
  return fbmG(q * 0.00085 + w * 0.9, 5, 0.4);
}
float macroLo(vec2 p) { float r, b; return macro(p, 3, r, b); }
// Wind-sculpted snow: large drift swells, dunes with crests across the wind, sastrugi streaks along it, photographic grain
float duneAmt;
float snowH(vec2 q) {
  vec2 w = vec2(dot(q, WD), dot(q, WP));
  float swell = gfbm(vec2(w.x * 0.0032, w.y * 0.0075) + SO * 0.7, 3);
  float dune = gnoise(vec2(w.x * 0.048, w.y * 0.011) + SO * 1.9) + 0.45 * gnoise(vec2(w.x * 0.1, w.y * 0.028) + SO);
  float sas = 0.5 - abs(gnoise(vec2(w.x * 0.011, w.y * 0.1) + SO * 1.3));
  float tex = texture(uSnow, q / 330.).g;
  return swell * 5. + dune * 0.7 * duneAmt + sas * 0.8 * duneAmt + tex * 2.4;
}
mat2 RR;
float rockH(vec2 q) {
  return texture(uRock, RR * q / 520.).g * 18. + texture(uRock, q / 190. + 0.37).g * 5.;
}
// Frozen lakes: bounded blobs, at most one per 600 px cell, so they never flood the screen
// Frozen lakes fill valley floors (low base height) up to a level that drops away from the cell centre, so each lake
// follows the terrain contours but stays bounded: at most one per 600 px cell. lk < 1 inside, 1 at the shore.
float lakeField(vec2 p, float base) {
  float best = 9.;
  float sn = 0.045 * gfbm(p * 0.005 + SO * 2.1, 4) + 0.012 * gnoise(p * 0.03);
  vec2 g = floor(p / 600.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 id = g + vec2(i, j);
    vec3 h = hash32(id + floor(SO) + 5.3);
    if (h.z > 0.3) continue;
    vec2 c = (id + 0.25 + 0.5 * h.xy) * 600.;
    float R = 150. + 70. * hash12(id + 9.1 + floor(SO));
    vec2 d = rot2(h.x * 6.283) * (p - c); d.x *= 0.8 + 0.35 * h.y;
    float v = length(d) / R;
    float level = baseAt(c) + 0.035 + 0.02 * hash12(id + 2.7) - 0.11 * v * v;
    best = min(best, 1. + (base - level + sn) * 14.);
  }
  return best;
}
// Snow-laden conifers seen from above: star-shaped whorls with snow on every tier, z-sorted, long cone shadows
vec4 forest(vec2 p, float pixMask, float load, vec3 L, out float shd) {
  const float cs = 12.;
  vec2 ld = normalize(L.xy), sd = -ld;
  vec4 acc = vec4(0.); float zb = -1.; shd = 0.;
  vec2 c0 = floor(p / cs), c1 = floor((p + ld * cs * 1.5) / cs);
  for (int k = 0; k < 2; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 id = (k == 0 ? c0 : c1) + vec2(i, j);
    vec3 h = hash32(id + 31.7);
    vec2 tp = (id + 0.14 + 0.72 * h.xy) * cs;
    float dens = smoothstep(0.45, 0.53, fbm(tp * 0.0028 + SO * 1.7, 4) + 0.04 * gnoise(tp * 0.03)) * 0.97 + 0.03;
    if (h.z > dens * pixMask) continue;
    float r = mix(4.8, 8.2, hash12(id + 7.3)) * (0.75 + 0.3 * dens);
    vec2 q = p - tp;
    float len = r * 2.6;
    float t = dot(q, sd);
    float tt = clamp(t / len, 0., 1.);
    float off = length(q - sd * tt * len);
    float sw = r * (1. - tt) * 0.9 + 0.5;
    shd = max(shd, smoothstep(sw, sw * 0.5, off) * step(-r * 0.3, t));
    if (k == 1) continue;
    float L0 = length(q);
    if (L0 > r + 1.) continue;
    float a = atan(q.y, q.x);
    float nb = 7. + floor(h.y * 4.);
    float ph = h.x * 6.283;
    float br = pow(0.5 + 0.5 * cos(nb * a + ph), 1.4);
    float rr = r * (0.8 + 0.2 * br) * (0.92 + 0.16 * vnoise(vec2(a * 2.5 + h.x * 40., h.y * 30.)));
    float cov = smoothstep(rr + 0.5, rr - 0.5, L0);
    float rn = L0 / r;
    float z = r * 3. * (1. - rn);
    if (cov <= 0. || z < zb) continue;
    vec2 rad = q / max(L0, 1e-3), tng = vec2(-rad.y, rad.x);
    float sp = sin(nb * a + ph);
    vec3 cn = normalize(vec3(rad * 1.05 + tng * sp * 0.45, 1.0));
    // snow covers the crown; dark needles show between the branch tips at the rim and on the shaded flank
    float dif = max(dot(cn, L), 0.);
    float gap = rn + 0.35 * (1. - br) - 0.3 * load;
    float sAmt = smoothstep(0.95, 0.6, gap) * smoothstep(0.0, 0.3, dif + 0.35 * load);
    vec3 needles = vec3(0.035, 0.06, 0.055) * (0.8 + 0.4 * h.y);
    vec3 snow = vec3(0.9, 0.93, 0.985);
    vec3 alb = mix(needles, snow, sAmt);
    vec3 cc = alb * (SUNC * dif * 1.2 + SKYC * (0.5 + 0.3 * cn.z));
    cc *= 0.75 + 0.25 * smoothstep(1.05, 0.5, rn);
    acc.rgb = mix(acc.rgb, cc, cov); acc.a = max(acc.a, cov); zb = z;
  }
  return acc;
}
void main() {
  vec2 p = cssPos();
  SO = seedOff(); WD = uWind; WP = vec2(-WD.y, WD.x);
  RR = rot2(SO.x);
  vec3 L = sunDir();
  vec2 ld = normalize(L.xy);
  float tanE = L.z / length(L.xy);
  float ridge, base, r1, b1;
  float H0 = macro(p, 6, ridge, base);
  vec2 gM = vec2(macro(p + vec2(1.5, 0.), 6, r1, b1) - macro(p - vec2(1.5, 0.), 6, r1, b1),
                 macro(p + vec2(0., 1.5), 6, r1, b1) - macro(p - vec2(0., 1.5), 6, r1, b1)) / 3.;
  float baseS; macro(p + ld * 9., 5, r1, baseS);
  float steep = length(gM);
  // lakes
  float lk = lakeField(p, base);
  float lake = smoothstep(1.0, 0.975, lk);
  float shore = smoothstep(1.35, 1.0, lk);
  // rock ridges
  vec4 RT = texture(uRock, RR * p / 520.);
  vec4 RT2 = texture(uRock, p / 230. + 0.37);
  float zone = smoothstep(0.35, 0.65, fbm(p * 0.00045 + SO * 0.11 + 31., 3));
  float rockM = smoothstep(0., 0.03, ridge - 0.83 - 0.14 * (1. - zone) + 0.12 * (RT.g - 0.5) + steep * 0.04) * (1. - shore);
  // detail relief
  duneAmt = smoothstep(0.45, 0.7, fbm(p * 0.0021 + SO * 0.3, 3));
  float e = 1.;
  vec2 gS = vec2(snowH(p + vec2(e, 0.)) - snowH(p - vec2(e, 0.)), snowH(p + vec2(0., e)) - snowH(p - vec2(0., e))) / (2. * e);
  vec2 gR = vec2(rockH(p + vec2(e, 0.)) - rockH(p - vec2(e, 0.)), rockH(p + vec2(0., e)) - rockH(p - vec2(0., e))) / (2. * e);
  vec2 gD = mix(gS, gR, rockM) * (1. - lake);
  vec3 n = normalize(vec3(-(gM * (1. - lake) + gD), 1.));
  // relief shadows toward the low sun
  float hs0 = macroLo(p) + 2.;
  float sh = 1., s = 3.;
  for (int i = 0; i < 22; i++) {
    float hq = macroLo(p + ld * s);
    sh = min(sh, clamp(1. - (hq - (hs0 + s * tanE)) / (3. + s * 0.05), 0., 1.));
    s *= 1.24;
  }
  float dif = max(dot(n, L), 0.) * sh;
  float amb = 0.55 + 0.45 * n.z;
  float ao = 0.82 + 0.18 * smoothstep(0.2, 0.6, base);

  // snow
  vec4 ST = texture(uSnow, p / 330.);
  float aer = texture(uSnow, rot2(0.7) * p / 1100. + 0.21).r;
  vec3 snowAlb = vec3(0.90, 0.93, 0.985) * (0.95 + 0.06 * ST.b);
  float windward = clamp(-dot(normalize(gM + 1e-5), WD) * steep * 30., 0., 1.);
  float scour = smoothstep(0.5, 0.2, aer) * (0.35 + 0.65 * windward);
  snowAlb = mix(snowAlb, vec3(0.68, 0.78, 0.90), scour * 0.45);
  // rock with strata that follow the contour lines
  float rl = RT.r * 0.6 + RT2.r * 0.4;
  float strat = texture(uRock, vec2(H0 / 70., dot(p, vec2(0.0006, 0.0009)))).b;
  vec3 rockAlb = mix(vec3(0.026, 0.028, 0.034), vec3(0.19, 0.185, 0.18), rl) * (0.7 + 0.55 * strat);
  float snowOnRock = smoothstep(0.52, 0.3, RT.g + 0.35 * (strat - 0.5)) * smoothstep(0.82, 0.96, n.z);
  float rk = rockM * (1. - snowOnRock);
  vec3 alb = mix(snowAlb, rockAlb, rk);
  vec3 col = alb * (SUNC * dif + SKYC * amb * ao + vec3(0.10, 0.12, 0.15) * rk);
  float snowA = (1. - rk) * smoothstep(0.1, 0.45, dif);

  // frozen lakes
  if (lake > 0.001 || shore > 0.001) {
    vec2 q = p + SO * 40.;
    float depth = smoothstep(1.0, 0.5, lk);
    vec2 w = vec2(dot(q, WD), dot(q, WP));
    // wind keeps long streaks of black ice clear; the rest carries a thin skin of snow
    float clear = smoothstep(0.46, 0.6, fbm(vec2(w.x * 0.0035, w.y * 0.018) + 3.3, 5) + 0.15 * depth - 0.04);
    float mott = fbm(q * 0.01, 4);
    vec3 black = mix(vec3(0.05, 0.1, 0.15), vec3(0.006, 0.02, 0.04), depth) * (0.7 + 0.6 * mott);
    vec4 vb = voronoi(q * 0.011 + 1.7);
    float c1 = (1. - smoothstep(0., 0.018, vb.y - vb.x)) * smoothstep(0.42, 0.55, vnoise(q * 0.01 + 3.));
    vec4 vm = voronoi(q * 0.03 + 5.3);
    float c4 = (1. - smoothstep(0., 0.025, vm.y - vm.x)) * smoothstep(0.5, 0.65, vnoise(q * 0.02 + 8.));
    vec4 v3 = voronoi(q * 0.08 + 9.); float c3 = 1. - smoothstep(0., 0.04, v3.y - v3.x);
    black = mix(black, vec3(0.42, 0.52, 0.62), max(c1, c4 * 0.7) * 0.6 + c3 * 0.08);
    vec2 bc = floor(q / 3.2); float bh = hash12(bc);
    float bub = step(0.98, bh) * smoothstep(1.1, 0.3, length(q - (bc + 0.5) * 3.2)) * smoothstep(0.45, 0.6, fbm(q * 0.02, 2));
    black += vec3(0.4, 0.5, 0.6) * bub * 0.5;
    black += SKYC * 0.08;
    float grain = fbm(vec2(w.x * 0.02, w.y * 0.08), 3);
    vec3 skin = vec3(0.7, 0.77, 0.86) * (0.8 + 0.3 * grain) * (SUNC * L.z * 1.05 + SKYC * 0.85);
    vec3 ic = mix(skin, black, clear * (1. - smoothstep(0.85, 0.97, lk)));
    float lkS = lakeField(p + ld * 9., baseS);
    float bankSh = smoothstep(0.92, 1.05, lkS);
    ic *= 1. - 0.4 * bankSh;
    vec3 snowLit = snowAlb * (SUNC * max(L.z, 0.) * 1.1 + SKYC * 0.9);
    ic = mix(ic, col, smoothstep(0.93, 1.0, lk));
    col = mix(col, ic, lake);
    snowA *= 1. - lake * clear;
  }

  // crevasse fields: lens-shaped parallel cracks across the ice flow
  float cz = smoothstep(0.6, 0.67, fbm(p * 0.0012 + SO * 2.3, 3)) * (1. - shore) * (1. - rockM);
  // conifer forests in the lowlands, with scattered single trees
  float pixMask = (1. - shore) * (1. - smoothstep(0.2, 0.6, rockM)) * smoothstep(0.85, 0.62, base) * (1. - cz);
  if (cz > 0.01) {
    vec2 fd = rot2(SO.y) * vec2(1., 0.);
    float u = dot(p, fd) + 22. * gnoise(p * 0.005 + SO) + 6. * gnoise(p * 0.02);
    float vc = dot(p, vec2(-fd.y, fd.x));
    float spc = 15.;
    float cell = floor(u / spc), fu = fract(u / spc) - 0.5;
    float hv = hash11(cell * 1.37 + 7.);
    float wv = smoothstep(0.35, 0.8, vnoise(vec2(vc * 0.018 + hv * 50., cell * 3.1))) * cz;
    float wdt = 0.24 * wv;
    float crack = smoothstep(wdt, wdt * 0.45, abs(fu)) * step(0.02, wdt);
    float side = clamp(fu / max(wdt, 1e-3), -1., 1.);
    float lit = clamp(0.5 - side * 0.9 * sign(dot(fd, ld)), 0., 1.);
    vec3 cc = mix(vec3(0.008, 0.035, 0.09), vec3(0.22, 0.48, 0.72), lit * (1. - abs(side) * 0.6));
    float lip = smoothstep(wdt * 1.9, wdt, abs(fu)) * (1. - crack) * step(0.02, wdt);
    col = mix(col, col * 1.08 + 0.03, lip * 0.5);
    col = mix(col, cc, crack);
    snowA *= 1. - crack;
  }
  if (pixMask > 0.01) {
    float shd;
    float load = smoothstep(0.3, 0.7, fbm(p * 0.0025 + SO * 0.4, 3));
    vec4 tr = forest(p, pixMask, load, L, shd);
    vec3 shadeCol = alb * SKYC * amb * 0.9;
    col = mix(col, shadeCol, shd * 0.85 * (1. - tr.a));
    col = mix(col, tr.rgb * (1. - 0.25 * shd), tr.a);
    snowA *= 1. - max(tr.a, shd) * 0.85;
  }
  outColor = vec4(col, snowA);
}`;

  /* Fortress composite: natural terrain + ploughed snow + trenches. Re-rendered on layout changes and morphs. */
  const TRENCH_FS = FIELD_GLSL + `
uniform sampler2D uNat, uRock, uSnow;
vec2 SO;
float surfH(float D) {
  if (D >= uR) return 0.;
  if (D < uF) return -uDepth + (D < -6. ? 2.5 : 0.);
  float t = (D - uF) / (uR - uF);
  return uDepth * (-1. + 0.55 * clamp(t / 0.4, 0., 1.) + 0.45 * clamp((t - 0.55) / 0.45, 0., 1.));
}
vec4 groomed(vec2 p, float u, vec3 L, vec2 gn) {
  // a ploughed berm against the apron, then levelled snow with faint parallel blade marks
  float ex = exp(-pow((u - 8.) / 6., 2.));
  float dbh = -4. * 2. * (u - 8.) / 36. * ex;
  float m = smoothstep(14., 24., u) * (1. - smoothstep(50., 80., u));
  float ph = u * 0.42 + 2.5 * gnoise(p * 0.02);
  float dm = 0.12 * 0.42 * cos(ph) * m;
  vec2 tg = vec2(texture(uSnow, (p + vec2(1., 0.)) / 330.).g - texture(uSnow, (p - vec2(1., 0.)) / 330.).g,
                 texture(uSnow, (p + vec2(0., 1.)) / 330.).g - texture(uSnow, (p - vec2(0., 1.)) / 330.).g);
  vec3 n = normalize(vec3(-gn * (dbh + dm) - tg * 1.6, 1.));
  float dif = max(dot(n, L), 0.);
  float aer = texture(uSnow, p / 700. + 0.4).r;
  vec3 alb = vec3(0.89, 0.92, 0.975) * (0.93 + 0.07 * texture(uSnow, p / 330.).b) * (0.92 + 0.1 * smoothstep(0.2, 0.7, aer));
  vec3 c = alb * (SUNC * dif + SKYC * (0.55 + 0.45 * n.z));
  return vec4(c, smoothstep(0.1, 0.45, dif));
}
vec3 trenchCol(vec2 p, float D, vec3 L, float aa, vec2 gn) {
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
    float rt = texture(uRock, vec2(dot(p, vec2(-gn.y, gn.x)) / 160., D / 40.)).b;
    vec3 alb = vec3(0.045, 0.052, 0.065) * (0.55 + 0.6 * fh) * (0.6 + 0.8 * rt);
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
    float dust = smoothstep(0.5, 0.85, texture(uNz, p / 700.).a + u / uAp * 0.25 - 0.1 + (texture(uSnow, p / 330.).g - 0.5) * 0.4);
    alb = mix(alb, vec3(0.8, 0.84, 0.9), dust * 0.75);
    c = alb * (SUNC * L.z * 1.3 + SKYC * 0.65);
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
  SO = seedOff();
  vec3 L = sunDir();
  float D = tD(p);
  float aa = max(fwidth(D), 0.25) * 0.75;
  vec4 N = texture(uNat, vUv);
  float edge = uR + uAp;
  if (D > edge + 170.) { outColor = N; return; }
  float e = uFS;
  vec2 g = vec2(tD(p + vec2(e, 0.)) - tD(p - vec2(e, 0.)), tD(p + vec2(0., e)) - tD(p - vec2(0., e))) / (2. * e);
  vec2 gn = length(g) > 1e-3 ? normalize(g) : vec2(0., -1.);
  float ragS = 5. * gnoise(p * 0.07 + SO) + 2. * gnoise(p * 0.2);
  float ragB = (texture(uNz, p / 900.).r - 0.5) * 120. + (texture(uNz, p / 240.).a - 0.5) * 40.;
  float gm = 1. - smoothstep(40., 46., D - edge + ragB);
  vec3 col = N.rgb; float sa = N.a;
  if (gm > 0.) { vec4 gr = groomed(p, D - edge, L, gn); col = mix(col, gr.rgb, gm); sa = mix(sa, gr.a, gm); }
  // windrow of ploughed snow along the edge of the cleared ground
  float ou = D - edge + ragB - 43.;
  float bx = (ou - 1.) / 4.;
  float bd = -2. * bx * exp(-bx * bx) * 3.2 / 4.;
  vec3 bn = normalize(vec3(-gn * bd, 1.));
  col *= mix(1., (max(dot(bn, L), 0.) + 0.35) / (L.z + 0.35), exp(-bx * bx * 0.5));
  if (D + ragS < edge + 8.) {
    vec3 tr = trenchCol(p, D, L, aa, gn);
    float sm = smoothstep(edge - 1.5, edge + 1.5, D + ragS);
    col = mix(tr, col, sm);
    col *= 1. - 0.35 * (1. - smoothstep(0., 7., D + ragS - edge)) * sm;
    sa *= sm;
  }
  outColor = vec4(col, sa);
}`;

  const LIVE_FS = FIELD_GLSL + `
uniform sampler2D uTer;
uniform float uGlow, uFlare, uRing, uRingA, uFlash;
// time and weather (all 0 / 1 in the designed look)
uniform vec2 uWDL, uLitP;
uniform vec3 uLite;
uniform float uWPh, uWS, uCloud, uSnowF, uSleet, uStorm, uFog, uNight, uLitF, uAur, uEmK, uSpk;
vec2 toUv(vec2 o) { return vec2(o.x, -o.y) / uRes; }
void main() {
  vec2 p = cssPos();
  vec2 SO = seedOff();
  vec2 WD = uWDL, WP = vec2(-WD.y, WD.x);
  float D = tD(p);
  vec2 uv = vUv;
  float lvl = uGlow + uFlare * 2.6;
  float lv = min(lvl, 1.4);
  float ped = 1. - smoothstep(-9., -5., D);
  float inT = (1. - smoothstep(uR - 2., uR + 3., D)) * (1. - ped);
  if (inT > 0.) {
    vec2 o = texture(uNz, p * 0.0032 + vec2(0.13, -uFlow * 0.045)).ga - 0.5;
    uv += toUv(o * inT * (1.6 + 3. * uGlow + 7. * uFlare));
  }
  float ring = 0., Df = 0., xr = 0.;
  vec2 rg = vec2(0.);
  if (uRingA > 0.001) {
    Df = tFar(p);
    float w = 26. + uRing * 0.03;
    xr = (Df - uRing) / w;
    ring = exp(-xr * xr) * uRingA;
    float e = 12.;
    rg = vec2(tFar(p + vec2(e, 0.)) - tFar(p - vec2(e, 0.)), tFar(p + vec2(0., e)) - tFar(p - vec2(0., e)));
    rg = rg / max(length(rg), 1e-4);
    uv += toUv(-rg * xr * exp(-xr * xr) * 10. * uRingA * (1. - ped));
  }
  vec4 B = texture(uTer, uv);
  vec3 col = B.rgb;
  // calm zone: weather effects ease off over the trench floors so the icons and labels stay readable
  float calm = mix(0.35 - 0.17 * uStorm, 1., smoothstep(uF, uR + 40., D));
  float liteL = max(luma(uLite), 0.08);
  vec3 liteC = min(uLite, vec3(1.2));   // weather haze colours: kept below glare at noon

  // drifting cloud shadows (they merge into an even overcast as the cloud cover grows)
  vec2 cp = p * 0.00017 + SO * 0.013 - WD * uWPh * 0.0011;
  vec2 cw = texture(uNz, cp * 1.6 + 0.31).ga - 0.5;
  float cl = texture(uNz, cp + cw * 0.22).r + (texture(uNz, cp * 4.3 + cw * 0.1).a - 0.5) * 0.25;
  float csh = smoothstep(0.52, 0.74, cl) * (1. - 0.8 * uCloud) * (1. - 0.6 * uNight);
  col *= mix(vec3(1.), vec3(0.52, 0.58, 0.76), csh);
  if (uCloud > 0.001) {
    // overcast: flat grey light. Sunlit snow loses its key light, shaded snow gains sky fill, colours go neutral.
    float w = smoothstep(0.02, 0.2, luma(col) / liteL);
    col *= mix(1., mix(1. + 0.5 * w, 0.62, B.a), uCloud * 0.85);
    col = mix(col, vec3(luma(col)) * vec3(0.95, 0.98, 1.04), uCloud * 0.5);
  }

  vec3 RED = vec3(1.0, 0.07, 0.02), HOT = vec3(1.0, 0.42, 0.2);
  vec3 ec = mix(RED, HOT, clamp(uFlare * 1.2 + uGlow * 0.1, 0., 1.));
  ec = mix(ec, vec3(1., 0.85, 0.75), clamp(uFlare - 0.6, 0., 0.4));
  vec3 em = vec3(0.);
  if (D < uR + 2.) {
    float chm = smoothstep(-7., -5.6, D) * (1. - smoothstep(uF - 0.6, uF + 0.6, D));
    float core = exp(-pow((D + 1.6) / 1.5, 2.));
    float fl = 0.72 + 0.28 * sin(dot(p, vec2(0.071, 0.052)) - uFlow * (2. + 6. * uGlow));
    fl *= 0.7 + 0.6 * texture(uNz, p * 0.004 + vec2(-uFlow * 0.03, 0.)).a;
    em += ec * chm * (0.12 + 1.5 * core) * fl * (0.35 + 1.5 * lv + 1.6 * uFlare);
    float floorM = (1. - smoothstep(uF - 1., uF + 1., D)) * (1. - ped);
    em += RED * floorM * luma(B.rgb) * (0.4 + 1.2 * lv);
    em += RED * ped * (0.0015 + 0.004 * lv);
    float t = clamp((D - uF) / (uR - uF), 0., 1.);
    float wallm = smoothstep(uF - 0.5, uF + 0.5, D) * (1. - smoothstep(uR - 0.5, uR + 0.5, D));
    em += RED * wallm * pow(1. - t, 2.2) * (0.02 + 0.55 * lvl) * (0.6 + 3. * luma(B.rgb));
    float tl = uF + 0.475 * (uR - uF);
    float lampLine = exp(-pow((D - tl) / 0.9, 2.));
    vec2 lc = floor(p / 9.);
    float lamp = step(0.7, hash12(lc + SO)) * (1. - smoothstep(0.6, 1.6, length(p - (lc + 0.5) * 9.)));
    em += RED * lampLine * lamp * (1.5 + 3. * lvl) * (0.7 + 0.3 * sin(uFlow * 3. + lc.x));
  }
  float spill = exp(-max(D - uR, 0.) / 60.) * (1. - inT) * (1. - ped);
  em += RED * spill * luma(B.rgb) * (0.02 + 0.3 * lvl);
  em *= uEmK;
  // at night the trench energy throws a wide red glow across the snow
  if (uNight > 0.001) em += RED * exp(-max(D - uR, 0.) / 110.) * smoothstep(-6., 10., D - uR) * uNight * (0.015 + 0.05 * lv);
  col += em;

  // steam rising from the trench channels, lit red from below, drifting downwind
  float sb = smoothstep(uF - 14., uF + 1., D) * (1. - smoothstep(uR + 6., uR + 80., D)) * (1. - ped);
  if (sb > 0.) {
    vec2 q = p - WD * uWPh * 20.;
    vec2 sp = vec2(dot(q, WD) * 0.0011, dot(q, WP) * 0.0026) + vec2(0., uFlow * 0.003);
    vec2 sw = texture(uNz, sp * 1.7 + vec2(uFlow * 0.004, 0.)).ga - 0.5;
    float s = texture(uNz, sp + sw * 0.35).r + (texture(uNz, sp * 3.1 - sw * 0.2).a - 0.5) * 0.35;
    float dens = smoothstep(0.5, 0.8, s) * sb * (0.22 + 0.18 * min(lvl, 1.5));
    float lowlit = 1. - smoothstep(uF - 4., uR + 30., D);
    vec3 sc = vec3(0.5, 0.55, 0.64) * uLite * mix(1., 0.6, csh) + RED * (0.12 + 1.2 * lv) * lowlit * uEmK;
    col = mix(col, sc, dens);
  }

  // shockwave: a smooth expanding front, red glow band, kicked-up snow behind it
  if (uRingA > 0.001) {
    float vis = smoothstep(uR, uR + 24., D);
    vec3 rc = mix(vec3(1., 0.22, 0.07), vec3(1., 0.72, 0.55), ring * ring);
    float wR = 26. + uRing * 0.03;
    float front = exp(-pow((Df - uRing - 0.75 * wR) / 4.5, 2.)) * uRingA;
    float wake = smoothstep(uRing + 10., uRing - 300., Df) * smoothstep(uRing - 700., uRing - 120., Df) * uRingA;
    col += (rc * ring * 1.0 + luma(col) * rc * ring * 1.8 + vec3(0.8, 0.9, 1.) * front * (1.4 + 2. * luma(col))) * vis;
    col += vec3(1., 0.2, 0.06) * wake * luma(col) * 0.5 * vis;
    float behind = smoothstep(uRing + 5., uRing - 60., Df) * smoothstep(uRing - 480., uRing - 160., Df);
    vec2 dq = p * 0.0022 - rg * uRing * 0.0007 + uFlow * 0.02;
    float dn = texture(uNz, dq).r + (texture(uNz, dq * 3.).a - 0.5) * 0.4;
    float dust = behind * smoothstep(0.45, 0.75, dn) * uRingA * vis;
    col = mix(col, vec3(0.86, 0.9, 0.98) * uLite * (0.9 + 0.4 * ring), dust * 0.3);
  }

  // night: a faint aurora shimmer reflected on the snow
  if (uAur > 0.001) {
    vec2 aq = vec2(p.x * 0.00022 + uFlow * 0.0035, p.y * 0.00055 - uFlow * 0.0012) + SO * 0.07;
    float a1 = texture(uNz, aq).r + (texture(uNz, aq * 2.7 + 0.4).a - 0.5) * 0.25;
    float band = exp(-pow((a1 - 0.56) / 0.07, 2.));
    float rip = 0.55 + 0.45 * sin(p.x * 0.011 + p.y * 0.005 + uFlow * 0.5 + a1 * 26.);
    vec3 ac = mix(vec3(0.08, 1.0, 0.5), vec3(0.35, 0.45, 1.0), smoothstep(0.35, 0.65, texture(uNz, p * 0.00018 + 3.1).g));
    float snowy = smoothstep(0.02, 0.3, luma(B.rgb) / liteL);
    col += ac * band * rip * uAur * (0.004 + 0.05 * snowy) * calm;
  }

  // ice fog hugging the ground; the trenches glow through it
  if (uFog > 0.001) {
    vec2 fq = p * 0.00034 - WD * uWPh * 0.0016 + SO * 0.03;
    float fn = texture(uNz, fq).r * 0.7 + texture(uNz, p * 0.0011 - WD * uWPh * 0.004).a * 0.3;
    float fa = uFog * smoothstep(0.2, 0.7, fn) * calm;
    vec3 fc = vec3(0.70, 0.76, 0.86) * liteC;
    fc += RED * exp(-max(D - uF, 0.) / 60.) * (0.2 + 0.8 * lv) * (0.5 + 0.7 * uNight) * uEmK;
    col = mix(col, fc, fa * 0.82);
    col += em * fa * 0.3;
  }

  // falling snow, and in storms a blizzard: lower contrast and whiteout patches
  vec3 hz = vec3(0.78, 0.82, 0.9) * liteC;
  if (uSnowF > 0.001) {
    col = mix(col, hz, (uSnowF * 0.2 + uStorm * 0.18) * calm);
    if (uStorm > 0.001) {
      float wo = smoothstep(0.48, 0.8, texture(uNz, p * 0.00026 - WD * uWPh * 0.007 + SO * 0.05).g);
      col = mix(col, hz * 1.04, wo * uStorm * 0.5 * calm);
    }
  }

  // blowing snow (strength and direction follow the wind)
  vec2 wp = vec2(dot(p, WD), dot(p, WP));
  float near = (0.35 + 0.65 * smoothstep(0., 40., D)) * (1. - ped);
  float wamp = clamp(0.3 + 0.7 * uWS, 0.2, 2.2);
  float gust = smoothstep(0.42 - 0.12 * uStorm, 0.66, texture(uNz, p * 0.00011 - WD * uWPh * 0.0035 + SO * 0.02).g);
  float st = texture(uNz, vec2(wp.x * 0.00045 - uWPh * 0.085, wp.y * 0.0032 + sin(wp.x * 0.002 + uFlow * 0.2) * 0.02)).r;
  float stream = smoothstep(0.55, 0.8, st) * (0.2 + 0.8 * gust);
  col = mix(col, vec3(0.80, 0.86, 0.97) * uLite * (0.85 - 0.3 * csh), min(stream * 0.16 * near * wamp, 0.6));
  float st2 = texture(uNz, vec2(wp.x * 0.0012 - uWPh * 0.22, wp.y * 0.01)).a;
  col = mix(col, vec3(0.85, 0.9, 1.0) * uLite, min(smoothstep(0.62, 0.85, st2) * 0.1 * gust * near * wamp, 0.5));
  float flk = 0.1 + 0.3 * gust;
  for (int k = 0; k < 2; k++) {
    float sc = k == 0 ? 11. : 19.;
    float spd = k == 0 ? 230. : 360.;
    vec2 q = vec2(wp.x - uWPh * spd, wp.y + sin(wp.x * 0.012 + uFlow * 1.3 + float(k)) * 5.) / sc;
    vec2 id = floor(q); vec2 f = fract(q) - 0.5;
    vec3 h = hash32(id + float(k) * 19.3);
    if (h.z < (0.02 + 0.18 * gust * gust) * min(wamp, 1.6)) {
      vec2 o = (h.xy - 0.5) * 0.5;
      float len = 0.2 + 0.3 * h.z;
      float d = sdSegment(f, o - vec2(len, 0.), o) * sc;
      float pr = smoothstep(0.8 + float(k) * 0.5, 0., d) * (0.35 + 0.5 * h.x);
      col += vec3(0.78, 0.85, 1.0) * uLite * pr * flk * near;
    }
  }
  if (uSnowF > 0.001) {
    // snowflakes in three parallax layers drifting with the wind; nearer flakes are larger, softer and faster.
    // In a blizzard the wind streaks them out.
    vec3 fcol = vec3(0.92, 0.95, 1.0) * liteC * 1.5 + vec3(1., 0.1, 0.04) * exp(-max(D - uR, 0.) / 45.) * (0.1 + 0.3 * lv) * uNight;
    float str = 1. + uStorm * 3.5 * clamp(uWS - 0.5, 0., 2.);
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float sc = 10. + fk * 9.;
      vec2 dr = WD * uWPh * (36. + 34. * fk) * (1. + uStorm * 2.) + WP * sin(uFlow * 0.6 + fk * 2.1 + p.x * 0.002) * 7.;
      vec2 q = (p - dr) / sc;
      vec2 id = floor(q); vec2 f = fract(q) - 0.5;
      vec3 h = hash32(id + fk * 31.7 + 3.3);
      if (h.z < uSnowF * (0.2 + 0.06 * fk)) {
        vec2 d = f - (h.xy - 0.5) * 0.55;
        float r = length(vec2(dot(d, WD) / str, dot(d, WP))) * sc;
        float rad = (0.55 + 0.45 * fk) * (0.7 + 0.6 * h.x);
        col += fcol * smoothstep(rad + 0.7 + 0.4 * fk, rad * 0.2, r) * (0.3 + 0.18 * fk) * min(1., uSnowF * 1.6) * mix(0.55, 1., calm);
      }
    }
  }

  // sleet / freezing rain: a glazed, icy sheen and fast slanted streaks
  if (uSleet > 0.001) {
    float gz = texture(uNz, p * 0.006 + SO).a;
    col *= 1. - 0.12 * uSleet * B.a;
    col += vec3(0.6, 0.7, 0.85) * uLite * pow(gz, 5.) * 0.9 * uSleet * B.a;
    vec2 sd = normalize(WD * 0.5 + vec2(0.3, 0.9));
    vec2 sq = vec2(dot(p, sd), dot(p, vec2(-sd.y, sd.x)));
    for (int k = 0; k < 2; k++) {
      float fk = float(k);
      vec2 q = vec2((sq.x - uFlow * (650. + 300. * fk)) / 64., sq.y / 7.);
      vec2 id = floor(q); vec2 f = fract(q);
      vec3 h = hash32(id + fk * 13.1 + 7.7);
      if (h.z < uSleet * 0.28) {
        float x0 = h.x * 0.55;
        float al = smoothstep(x0, x0 + 0.05, f.x) * smoothstep(x0 + 0.45, x0 + 0.3, f.x);
        float d = abs(f.y - 0.5 - (h.y - 0.5) * 0.6) * 7.;
        col += vec3(0.7, 0.8, 0.95) * uLite * smoothstep(0.75, 0., d) * al * (0.25 + 0.15 * fk) * mix(0.5, 1., calm);
      }
    }
  }

  // lightning lights the snow from one side of the sky
  if (uLitF > 0.001) {
    float fall = exp(-length(p - uLitP) / 1100.);
    float snowy = smoothstep(0.02, 0.35, luma(B.rgb) / liteL);
    col += vec3(0.72, 0.8, 1.0) * uLitF * (0.25 + 0.75 * fall) * (0.03 + 0.35 * snowy) * mix(0.3, 1., calm);
  }

  // sparkle on fresh snow
  float sn = B.a * (1. - csh * 0.8) * smoothstep(uR + uAp, uR + uAp + 30., D);
  if (sn > 0.05) {
    vec2 cell = floor(p * 0.9);
    float h = hash12(cell + floor(SO));
    float tw = 0.5 + 0.5 * sin(uFlow * 2.2 + h * 917. + p.x * 0.01);
    float spk = smoothstep(0.9968, 1.0, h) * pow(tw, 8.);
    col += vec3(0.85, 0.93, 1.0) * spk * sn * 7. * uSpk;
  }

  col *= 1. + uFlash * 0.35 * vec3(1.0, 0.75, 0.7);
  outColor = vec4(col, 1.);
}`;

  /* ---------------- sprites (drawn facing +x, lit from straight above) ---------------- */
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function poly(g, pts) { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.closePath(); }
  function drawTie(g, w, h, kind) {
    const cx = w / 2, cy = h / 2, U = w / 256;
    g.lineJoin = 'round'; g.lineCap = 'round';
    // wing pylons
    for (const sy of [-1, 1]) {
      g.fillStyle = '#23262c'; g.fillRect(cx - 11 * U, cy + sy * 22 * U, 22 * U, sy * 52 * U);
      g.fillStyle = '#5a606a'; g.fillRect(cx - 4 * U, cy + sy * 22 * U, 8 * U, sy * 52 * U);
      g.fillStyle = '#16181c'; for (let k = 0; k < 4; k++) g.fillRect(cx - 11 * U, cy + sy * (30 + k * 11) * U, 22 * U, sy * 2.5 * U);
    }
    for (const sy of [-1, 1]) {
      g.save(); g.translate(cx, cy + sy * 84 * U);
      let pts;
      if (kind === 0) { const L = 112 * U, T = 38 * U; pts = [-L, 0, -L * 0.56, -T, L * 0.56, -T, L, 0, L * 0.56, T, -L * 0.56, T]; }
      else { const L = 116 * U, T = 36 * U, b = -sy * 26 * U; pts = [-L, b, -L * 0.34, -T, L * 0.34, -T, L, b, L * 0.3, T * 0.8, -L * 0.3, T * 0.8]; }
      poly(g, pts);
      const gr = g.createLinearGradient(0, -40 * U, 0, 40 * U);
      gr.addColorStop(0, '#16191e'); gr.addColorStop(0.5, '#0c0d10'); gr.addColorStop(1, '#16191e');
      g.fillStyle = gr; g.fill();
      // solar cell facets between the spokes
      for (let k = 0; k < 6; k++) {
        const a = pts.slice(k * 2, k * 2 + 2), b = pts.slice(((k + 1) % 6) * 2, ((k + 1) % 6) * 2 + 2);
        g.beginPath(); g.moveTo(0, 0); g.lineTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.closePath();
        g.fillStyle = k % 2 ? 'rgba(40,46,56,0.35)' : 'rgba(0,0,0,0.25)'; g.fill();
        g.strokeStyle = 'rgba(70,78,90,0.55)'; g.lineWidth = 1.2 * U;
        for (const f of [0.33, 0.55, 0.77]) { g.beginPath(); g.moveTo(a[0] * f, a[1] * f); g.lineTo(b[0] * f, b[1] * f); g.stroke(); }
      }
      g.strokeStyle = '#596069'; g.lineWidth = 3.2 * U;
      for (let k = 0; k < 6; k++) { g.beginPath(); g.moveTo(0, 0); g.lineTo(pts[k * 2], pts[k * 2 + 1]); g.stroke(); }
      poly(g, pts); g.strokeStyle = '#8d949e'; g.lineWidth = 4.5 * U; g.stroke();
      g.strokeStyle = '#2b2f36'; g.lineWidth = 1.5 * U; g.save(); g.scale(0.92, 0.86); poly(g, pts); g.stroke(); g.restore();
      g.fillStyle = '#41464f'; g.beginPath(); g.arc(0, 0, 10 * U, 0, 7); g.fill();
      g.strokeStyle = '#9aa1ab'; g.lineWidth = 2 * U; g.stroke();
      if (kind === 1) { g.fillStyle = '#8e1a12'; g.fillRect(-26 * U, -sy * 30 * U - 3 * U, 52 * U, 6 * U); }
      g.restore();
    }
    // cockpit ball
    const r = 31 * U;
    const gr = g.createRadialGradient(cx - 4 * U, cy - 4 * U, r * 0.1, cx, cy, r);
    gr.addColorStop(0, '#d9dde3'); gr.addColorStop(0.55, '#8a9099'); gr.addColorStop(0.9, '#3d4148'); gr.addColorStop(1, '#22252a');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
    g.strokeStyle = 'rgba(30,33,38,0.8)'; g.lineWidth = 1.6 * U;
    g.beginPath(); g.arc(cx, cy, r * 0.62, 0, 7); g.stroke();
    g.beginPath(); g.moveTo(cx - r, cy); g.lineTo(cx + r * 0.4, cy); g.stroke();
    g.fillStyle = '#2b2e34'; g.beginPath(); g.arc(cx - 6 * U, cy, 8 * U, 0, 7); g.fill();
    g.strokeStyle = '#a7adb6'; g.lineWidth = 1.5 * U; g.stroke();
    // forward viewport: octagonal glass with radial frame
    g.save(); g.translate(cx + r * 0.72, cy);
    g.fillStyle = '#06070a'; g.beginPath(); g.ellipse(0, 0, 10 * U, 20 * U, 0, 0, 7); g.fill();
    g.strokeStyle = '#6a717b'; g.lineWidth = 1.6 * U;
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * 10 * U, Math.sin(a) * 20 * U); g.stroke(); }
    g.beginPath(); g.ellipse(0, 0, 10 * U, 20 * U, 0, 0, 7); g.lineWidth = 2.4 * U; g.strokeStyle = '#8d949e'; g.stroke();
    g.fillStyle = 'rgba(120,150,190,0.35)'; g.beginPath(); g.ellipse(-2 * U, -6 * U, 3 * U, 5 * U, 0, 0, 7); g.fill();
    g.restore();
  }
  function drawXwing(g, w, h) {
    const cy = h / 2, X = f => w * f, Y = f => cy + h * f;
    g.lineJoin = 'round';
    const wing = (sy, lower) => {
      const o = lower ? 0.028 : 0, tip = lower ? 0.40 : 0.455;
      poly(g, [X(0.19 - o), Y(sy * 0.05), X(0.45 - o), Y(sy * 0.05), X(0.385 - o), Y(sy * tip), X(0.245 - o), Y(sy * tip)]);
      g.fillStyle = lower ? '#8f8b84' : '#e9e5dc'; g.fill();
      g.strokeStyle = lower ? '#5f5c57' : '#7a776f'; g.lineWidth = w * 0.006; g.stroke();
      if (!lower) {
        g.strokeStyle = 'rgba(110,106,98,0.55)'; g.lineWidth = w * 0.003;
        for (const f of [0.14, 0.24, 0.34]) { g.beginPath(); g.moveTo(X(0.21), Y(sy * f)); g.lineTo(X(0.43 - f * 0.12), Y(sy * f)); g.stroke(); }
        g.beginPath(); g.moveTo(X(0.32), Y(sy * 0.05)); g.lineTo(X(0.31), Y(sy * tip)); g.stroke();
        g.fillStyle = '#d0581c';
        poly(g, [X(0.252), Y(sy * 0.37), X(0.392), Y(sy * 0.37), X(0.388), Y(sy * 0.41), X(0.249), Y(sy * 0.41)]); g.fill();
        g.fillStyle = '#3a5f9a'; g.fillRect(X(0.26), Y(sy * 0.29), w * 0.05, h * 0.018 * sy);
        g.fillStyle = 'rgba(60,58,54,0.45)'; g.fillRect(X(0.36), Y(sy * 0.16), w * 0.06, h * 0.03 * sy);
      }
      // wingtip cannon with flash suppressor
      const ty = Y(sy * tip);
      g.fillStyle = lower ? '#6f6d68' : '#b4b2ad'; g.fillRect(X(0.17 - o), ty - h * 0.014, w * 0.42, h * 0.028);
      g.fillStyle = lower ? '#4a4946' : '#7d7b77'; g.fillRect(X(0.59 - o), ty - h * 0.007, w * 0.25, h * 0.014);
      g.fillStyle = '#2c2c2d'; g.fillRect(X(0.80 - o), ty - h * 0.012, w * 0.06, h * 0.024);
      g.fillStyle = '#d0581c'; g.fillRect(X(0.52 - o), ty - h * 0.014, w * 0.015, h * 0.028);
    };
    for (const sy of [-1, 1]) wing(sy, true);
    for (const sy of [-1, 1]) wing(sy, false);
    // engines
    for (const sy of [-1, 1]) {
      const ey = Y(sy * 0.092);
      const gr = g.createLinearGradient(0, ey - h * 0.035, 0, ey + h * 0.035);
      gr.addColorStop(0, '#9c978e'); gr.addColorStop(0.45, '#e2ded4'); gr.addColorStop(1, '#8a857d');
      g.fillStyle = gr; g.beginPath(); g.roundRect(X(0.11), ey - h * 0.035, w * 0.28, h * 0.07, h * 0.03); g.fill();
      g.strokeStyle = '#6e6a63'; g.lineWidth = w * 0.004; g.stroke();
      g.fillStyle = '#2d2a27'; g.fillRect(X(0.36), ey - h * 0.03, w * 0.025, h * 0.06);
      g.fillStyle = '#4b2216'; g.fillRect(X(0.105), ey - h * 0.026, w * 0.02, h * 0.052);
      g.strokeStyle = 'rgba(90,86,80,0.6)'; g.lineWidth = w * 0.003;
      for (const f of [0.18, 0.25, 0.31]) { g.beginPath(); g.moveTo(X(f), ey - h * 0.033); g.lineTo(X(f), ey + h * 0.033); g.stroke(); }
    }
    // fuselage
    poly(g, [X(0.975), cy, X(0.80), Y(-0.03), X(0.62), Y(-0.046), X(0.2), Y(-0.055), X(0.13), Y(-0.045), X(0.13), Y(0.045), X(0.2), Y(0.055), X(0.62), Y(0.046), X(0.80), Y(0.03)]);
    const fg = g.createLinearGradient(0, Y(-0.055), 0, Y(0.055));
    fg.addColorStop(0, '#b8b4ab'); fg.addColorStop(0.5, '#f1ede4'); fg.addColorStop(1, '#a8a49b');
    g.fillStyle = fg; g.fill(); g.strokeStyle = '#77736c'; g.lineWidth = w * 0.005; g.stroke();
    g.strokeStyle = 'rgba(100,96,90,0.5)'; g.lineWidth = w * 0.003;
    for (const f of [0.3, 0.46, 0.7, 0.84]) { g.beginPath(); g.moveTo(X(f), Y(-0.045)); g.lineTo(X(f), Y(0.045)); g.stroke(); }
    g.fillStyle = '#d0581c'; g.fillRect(X(0.74), Y(-0.034), w * 0.03, h * 0.068); g.fillRect(X(0.80), Y(-0.026), w * 0.018, h * 0.052);
    g.fillStyle = '#3a5f9a'; g.fillRect(X(0.86), Y(-0.018), w * 0.02, h * 0.036);
    // canopy
    g.fillStyle = '#0e1116'; g.beginPath(); g.ellipse(X(0.575), cy, w * 0.07, h * 0.03, 0, 0, 7); g.fill();
    g.strokeStyle = '#6c6a65'; g.lineWidth = w * 0.004; g.stroke();
    g.beginPath(); g.moveTo(X(0.55), Y(-0.03)); g.lineTo(X(0.55), Y(0.03)); g.moveTo(X(0.6), Y(-0.027)); g.lineTo(X(0.6), Y(0.027)); g.stroke();
    g.fillStyle = 'rgba(140,170,210,0.35)'; g.beginPath(); g.ellipse(X(0.6), Y(-0.01), w * 0.02, h * 0.008, 0, 0, 7); g.fill();
    // astromech dome
    g.fillStyle = '#e6e8ec'; g.beginPath(); g.arc(X(0.44), cy, h * 0.026, 0, 7); g.fill();
    g.fillStyle = '#d0581c'; g.beginPath(); g.arc(X(0.44), cy, h * 0.012, 0, 7); g.fill();
    g.fillStyle = '#1a1c20'; g.beginPath(); g.arc(X(0.452), cy - h * 0.004, h * 0.005, 0, 7); g.fill();
  }
  function drawShuttle(g, w, h) {
    const cy = h / 2, X = f => w * f, Y = f => cy + h * f;
    g.lineJoin = 'miter';
    for (const sy of [-1, 1]) {
      poly(g, [X(0.355), Y(sy * 0.05), X(0.585), Y(sy * 0.05), X(0.53), Y(sy * 0.475), X(0.445), Y(sy * 0.475)]);
      const gr = g.createLinearGradient(X(0.36), 0, X(0.58), 0);
      gr.addColorStop(0, '#0c0d10'); gr.addColorStop(0.5, '#17191d'); gr.addColorStop(1, '#0c0d10');
      g.fillStyle = gr; g.fill(); g.strokeStyle = '#5a5f68'; g.lineWidth = w * 0.006; g.stroke();
      g.strokeStyle = 'rgba(120,128,140,0.75)'; g.lineWidth = w * 0.004;
      for (let k = 1; k < 14; k++) { const f = k / 14; g.beginPath(); g.moveTo(X(0.355 + 0.09 * f), Y(sy * (0.05 + 0.425 * f))); g.lineTo(X(0.585 - 0.055 * f), Y(sy * (0.05 + 0.425 * f))); g.stroke(); }
      g.strokeStyle = 'rgba(80,86,96,0.6)';
      g.beginPath(); g.moveTo(X(0.47), Y(sy * 0.05)); g.lineTo(X(0.488), Y(sy * 0.475)); g.stroke();
      g.fillStyle = '#3c4048'; g.fillRect(X(0.445), Y(sy * 0.47), w * 0.085, h * 0.008 * sy);
    }
    poly(g, [X(0.88), cy, X(0.76), Y(-0.048), X(0.3), Y(-0.058), X(0.22), Y(-0.04), X(0.22), Y(0.04), X(0.3), Y(0.058), X(0.76), Y(0.048)]);
    const fg = g.createLinearGradient(0, Y(-0.058), 0, Y(0.058));
    fg.addColorStop(0, '#1e2126'); fg.addColorStop(0.5, '#3b4047'); fg.addColorStop(1, '#1e2126');
    g.fillStyle = fg; g.fill(); g.strokeStyle = '#6e737c'; g.lineWidth = w * 0.004; g.stroke();
    g.fillStyle = '#0b0c0e'; g.fillRect(X(0.3), Y(-0.012), w * 0.4, h * 0.024);
    g.fillStyle = '#5d636d'; g.fillRect(X(0.4), Y(-0.04), w * 0.14, h * 0.08);
    g.fillStyle = '#2a2d33'; for (let k = 0; k < 5; k++) g.fillRect(X(0.41 + k * 0.026), Y(-0.034), w * 0.012, h * 0.068);
    g.fillStyle = '#07080a'; poly(g, [X(0.87), cy, X(0.79), Y(-0.03), X(0.79), Y(0.03)]); g.fill();
    g.fillStyle = 'rgba(120,140,170,0.35)'; g.fillRect(X(0.8), Y(-0.012), w * 0.03, h * 0.008);
    g.fillStyle = '#454a52'; g.fillRect(X(0.215), Y(-0.034), w * 0.03, h * 0.068);
  }
  function drawTurret(g, w, h) {
    const cx = w / 2, cy = h / 2, U = w / 128;
    poly(g, Array.from({ length: 16 }, (_, i) => i % 2 ? cy + Math.sin((i >> 1) * Math.PI / 4 + 0.39) * 44 * U : cx + Math.cos((i >> 1) * Math.PI / 4 + 0.39) * 44 * U));
    g.fillStyle = '#1a1c21'; g.fill(); g.strokeStyle = '#646b75'; g.lineWidth = 3 * U; g.stroke();
    g.fillStyle = '#2a2d33'; g.fillRect(cx + 10 * U, cy - 12 * U, 52 * U, 8 * U); g.fillRect(cx + 10 * U, cy + 4 * U, 52 * U, 8 * U);
    g.fillStyle = '#121316'; g.fillRect(cx + 54 * U, cy - 11 * U, 8 * U, 6 * U); g.fillRect(cx + 54 * U, cy + 5 * U, 8 * U, 6 * U);
    const gr = g.createLinearGradient(0, cy - 24 * U, 0, cy + 24 * U);
    gr.addColorStop(0, '#4b5059'); gr.addColorStop(0.5, '#9aa0a9'); gr.addColorStop(1, '#4b5059');
    g.fillStyle = gr; g.beginPath(); g.roundRect(cx - 26 * U, cy - 22 * U, 44 * U, 44 * U, 10 * U); g.fill();
    g.strokeStyle = '#2b2e34'; g.lineWidth = 2 * U; g.stroke();
    g.fillStyle = '#30343a'; g.fillRect(cx - 18 * U, cy - 4 * U, 30 * U, 8 * U);
    g.fillStyle = '#0d0e10'; g.fillRect(cx + 8 * U, cy - 14 * U, 8 * U, 28 * U);
  }
  function drawLight(g, w, h) {
    const cx = w / 2, cy = h / 2, U = w / 96;
    g.fillStyle = '#1b1d22'; g.beginPath(); g.roundRect(cx - 30 * U, cy - 26 * U, 52 * U, 52 * U, 6 * U); g.fill();
    g.strokeStyle = '#6a717b'; g.lineWidth = 3 * U; g.stroke();
    g.fillStyle = '#3c4148'; g.fillRect(cx - 24 * U, cy - 20 * U, 20 * U, 40 * U);
    g.fillStyle = '#c9d2dd'; g.beginPath(); g.ellipse(cx + 18 * U, cy, 8 * U, 20 * U, 0, 0, 7); g.fill();
    g.strokeStyle = '#555c66'; g.lineWidth = 2 * U; g.stroke();
  }
  function drawPuff(g, w, h) {
    const r = mulberry(7);
    for (let i = 0; i < 26; i++) {
      const a = r() * 6.283, d = Math.pow(r(), 0.7) * w * 0.26, x = w / 2 + Math.cos(a) * d, y = h / 2 + Math.sin(a) * d, rr = w * (0.07 + 0.13 * r());
      const gr = g.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, 7); g.fill();
    }
  }
  function drawCatwalk(g, w, h) {
    g.fillStyle = '#15171b'; g.fillRect(0, h * 0.18, w, h * 0.64);
    g.strokeStyle = '#3d424a'; g.lineWidth = h * 0.06;
    for (let x = 0; x < w; x += h * 0.8) { g.beginPath(); g.moveTo(x, h * 0.25); g.lineTo(x + h * 0.8, h * 0.75); g.moveTo(x, h * 0.75); g.lineTo(x + h * 0.8, h * 0.25); g.stroke(); }
    g.fillStyle = '#7a818b'; g.fillRect(0, h * 0.14, w, h * 0.11); g.fillRect(0, h * 0.75, w, h * 0.11);
    g.fillStyle = '#9aa1ab'; g.fillRect(0, h * 0.14, w, h * 0.035); g.fillRect(0, h * 0.75, w, h * 0.035);
    g.fillStyle = '#2a2e35'; for (let x = h * 0.4; x < w; x += h * 1.6) g.fillRect(x, h * 0.12, h * 0.16, h * 0.76);
  }
  function drawConduit(g, w, h) {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, 'rgba(8,10,14,0)'); gr.addColorStop(0.18, 'rgba(8,10,14,0.85)'); gr.addColorStop(0.82, 'rgba(8,10,14,0.85)'); gr.addColorStop(1, 'rgba(8,10,14,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (const yc of [0.33, 0.67]) {
      const pg = g.createLinearGradient(0, h * (yc - 0.11), 0, h * (yc + 0.11));
      pg.addColorStop(0, '#2a2e35'); pg.addColorStop(0.45, '#8a919b'); pg.addColorStop(1, '#22252b');
      g.fillStyle = pg; g.fillRect(0, h * (yc - 0.11), w, h * 0.22);
    }
    g.fillStyle = '#050608'; g.fillRect(0, h * 0.46, w, h * 0.08);
    for (let x = 10; x < w; x += 40) {
      g.fillStyle = '#4a5059'; g.fillRect(x, h * 0.16, 7, h * 0.68);
      g.fillStyle = '#9aa1ab'; g.fillRect(x, h * 0.16, 2, h * 0.68);
    }
  }
  // Scorched blast crater seen from above: dark glassy pit, blackened ring, thrown-out ice and soot rays
  function drawCrater(g, w, h) {
    const cx = w / 2, cy = h / 2, R = w * 0.5, r = mulberry(19);
    g.lineCap = 'round';
    for (let i = 0; i < 46; i++) {
      const a = r() * 6.283, l = R * (0.5 + 0.45 * r()), wd = R * (0.025 + 0.05 * r()), soot = r() < 0.55;
      g.strokeStyle = soot ? `rgba(22,20,22,${0.3 + 0.35 * r()})` : `rgba(235,240,248,${0.25 + 0.35 * r()})`;
      g.lineWidth = wd; g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.28, cy + Math.sin(a) * R * 0.28); g.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l); g.stroke();
    }
    let gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.62);
    gr.addColorStop(0, 'rgba(14,11,11,0.97)'); gr.addColorStop(0.45, 'rgba(26,22,22,0.92)'); gr.addColorStop(0.75, "rgba(44,40,42,0.72)"); gr.addColorStop(1, 'rgba(60,60,66,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * 0.62, 0, 7); g.fill();
    // rim of heaped ice: lit from the upper left, shaded lower right
    for (let i = 0; i < 28; i++) {
      const a = i / 28 * 6.283 + r() * 0.2, rr = R * (0.33 + 0.05 * r()), lit = 0.5 + 0.5 * Math.cos(a + 2.4);
      g.fillStyle = `rgba(${Math.round(150 + 100 * lit)},${Math.round(156 + 98 * lit)},${Math.round(170 + 85 * lit)},${0.35 + 0.35 * r()})`;
      g.beginPath(); g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R * (0.04 + 0.04 * r()), 0, 7); g.fill();
    }
    gr = g.createRadialGradient(cx - R * 0.04, cy - R * 0.04, 0, cx, cy, R * 0.22);
    gr.addColorStop(0, 'rgba(40,36,40,1)'); gr.addColorStop(0.6, 'rgba(8,7,8,1)'); gr.addColorStop(1, 'rgba(8,7,8,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * 0.22, 0, 7); g.fill();
  }
  function drawNode(g, w, h) {
    const U = w / 128;
    g.fillStyle = '#121418'; g.beginPath(); g.roundRect(10 * U, 10 * U, 108 * U, 108 * U, 10 * U); g.fill();
    const gr = g.createLinearGradient(0, 18 * U, 0, 110 * U);
    gr.addColorStop(0, '#5c636d'); gr.addColorStop(1, '#2c3037');
    g.fillStyle = gr; g.beginPath(); g.roundRect(18 * U, 18 * U, 92 * U, 92 * U, 6 * U); g.fill();
    g.strokeStyle = '#9aa1ab'; g.lineWidth = 2.5 * U; g.stroke();
    g.fillStyle = '#1b1e23'; for (let k = 0; k < 4; k++) g.fillRect(26 * U, (28 + k * 8) * U, 30 * U, 4 * U);
    g.fillStyle = '#26292f'; g.beginPath(); g.arc(80 * U, 72 * U, 20 * U, 0, 7); g.fill();
    g.strokeStyle = '#8b929c'; g.lineWidth = 2.5 * U; g.stroke();
    g.fillStyle = '#0b0c0f'; g.beginPath(); g.arc(80 * U, 72 * U, 9 * U, 0, 7); g.fill();
  }

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
    bolts.push({ x, y, vx: dx / L * sp, vy: dy / L * sp, life: L / sp, age: 0, color: o.color, len: o.len || 16, ground: !!o.ground, width: o.width || 2, onHit: o.onHit, strike: !!o.strike });
  }
  // Point and fire: a bolt hits the clicked spot. Effects scale down near icons so nothing spills onto an icon cell.
  function strikeAt(x, y, first) {
    const clr = C.distAt(x, y), sz = clamp((clr - 8) / 45, 0.3, 1);
    strikes.push({ x, y, age: 0, life: 1.1, sz, rot: rnd() * 6.28, big: first });
    if (first) {
      craters.push({ x, y, age: 0, life: 24, sz, rot: rnd() * 6.28 });
      if (craters.length > 10) craters.shift();
      for (let i = 0; i < 3; i++) smokes.push({ x: x + (rnd() - 0.5) * 6 * sz, y: y + (rnd() - 0.5) * 6 * sz, age: -i * 0.18, life: 2.6 + rnd() * 0.8, sz, rot: rnd() * 6.28 });
    }
    const n = first ? 12 : 5, vmax = Math.min(150, clr * 1.6) * (0.5 + 0.5 * sz);
    for (let i = 0; i < n; i++) { const a = rnd() * 6.283, v = vmax * (0.35 + 0.65 * rnd()); debris.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, age: 0, life: 0.35 + rnd() * 0.45 }); }
  }
  function strikeBurst(sx, sy, tx, ty, o) {
    // a short burst of 3 bolts walking onto the spot; the first impact leaves a crater
    for (let i = 0; i < 3; i++) {
      const jx = tx + (rnd() - 0.5) * 7, jy = ty + (rnd() - 0.5) * 7, first = i === 0;
      setTimeoutSim(i * o.gap, () => fire(sx, sy, jx, jy, { color: o.color, speed: o.speed, len: o.len, width: o.width, strike: true, onHit: () => strikeAt(jx, jy, first) }));
    }
  }
  let timers = [];
  function setTimeoutSim(t, f) { if (t <= 0) f(); else timers.push({ t, f }); }
  function impact(x, y, size, kind) { impacts.push({ x, y, age: 0, life: kind === 'boom' ? 2.4 : 1.7, size, kind, rot: rnd() * 6.28 }); }
  function boom(x, y) {
    impact(x, y, 1.6, 'boom');
    for (let i = 0; i < 16; i++) { const a = rnd() * 6.283, s = 40 + rnd() * 160; debris.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, age: 0, life: 0.6 + rnd() * 0.9 }); }
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
      const bx = tx - ux * (L + Math.abs(side) * 50) - uy * side * 46, by = ty - uy * (L + Math.abs(side) * 50) + ux * side * 46;
      xws.push({ x: bx, y: by, ang, spd: 290, hp: 2 + ((rnd() * 2) | 0), alive: true, passed: false, fireT: 0.3 + rnd() * 0.4, tx: tx - uy * side * 26, ty: ty + ux * side * 26, wob: rnd() * 9, hit: 0, bank: 0 });
    }
    const nc = ctx.P.traffic > 0 ? 1 + ((rnd() * 2) | 0) : 1;
    for (let i = 0; i < nc; i++) {
      chasers.push({ x: tx - ux * (L + 260 + i * 60) + uy * (i - 0.5) * 60, y: ty - uy * (L + 260 + i * 60) - ux * (i - 0.5) * 60, ang, spd: 330, tgt: i, fireT: 1, life: 0 });
    }
  }
  function updateCharge(ctx) {
    const t = ctx.flow, v = phase0 + t / PERIOD, c = v - Math.floor(v), tp = c * PERIOD;
    ch.c = c;
    ch.glow = 0.06 + 1.2 * Math.pow(c, 2.4);
    if (c > 0.96) ch.glow += 0.35 * (c - 0.96) / 0.04 * (0.65 + 0.35 * Math.sin(t * 37));
    ch.flare = tp < 16 ? Math.exp(-tp * 0.55) * Math.min(1, tp / 0.12) : 0;
    ch.ring = geo.R - 30 + tp * (80 + 14 * tp);
    ch.ringA = tp < 9 && ctx.icons.length ? Math.min(1, tp / 0.3) * Math.pow(1 - tp / 9, 1.1) : 0;
    ch.flash = tp < 3 ? Math.exp(-tp * 2.2) * Math.min(1, tp / 0.08) : 0;
    const cyc = Math.floor(v);
    if (ch.cyc !== null && cyc !== ch.cyc) for (const tr of turrets) impact(tr.x + (rnd() - 0.5) * 20, tr.y + (rnd() - 0.5) * 20, 1.2, 'snow');
    ch.cyc = cyc;
  }

  /* ---------------- scene ---------------- */
  Galaxy.register(ID, {
    name: 'Ice fortress',
    defaultHour: 17.1,
    post(ctx) {
      const p = { bloom: 1.15, threshold: 1.4, knee: 0.4, exposure: 0.74, vignette: 0.6, grain: 0.02, aberration: 0.0005, tint: [0.96, 1.0, 1.06], lift: [0.0, 0.003, 0.008], saturation: 1.03, bloomRadius: 1.1 };
      const env = ctx.env || {};
      if (!env.timeActive && !env.weatherActive) return p;
      const n = E.night, d = E.dusk;
      // partial exposure compensation: noon reads brighter and whiter, night stays a deep, readable moonlit blue
      p.exposure = 0.74 * clamp(Math.pow(1 / Math.max(E.lum, 0.05), E.lum > 1 ? 0.4 : 0.62 - 0.14 * E.dusk), 0.55, 3.4) * (1 + 0.08 * E.cloud) * (1 - 0.48 * n);
      p.tint = [0.96 + 0.05 * d - 0.05 * n, 1.0 - 0.01 * d - 0.02 * n, 1.06 - 0.03 * d + 0.06 * n];
      p.lift = [0.0, 0.003 + 0.001 * n, 0.008 + 0.004 * n];
      p.saturation = 1.03 - 0.14 * E.cloud - 0.08 * n + 0.06 * d - 0.08 * E.fog;
      p.vignette = 0.6 - 0.12 * E.fog;
      return p;
    },

    init(ctx) {
      C = ctx;
      const gl = ctx.gl;
      progN = ctx.program(NOISE_FS);
      progNat = ctx.program(NAT_FS);
      progT = ctx.program(TRENCH_FS);
      progL = ctx.program(LIVE_FS);
      rockTex = ctx.loadTexture(ASSET + 'rock.jpg', { srgb: false });
      snowTex = ctx.loadTexture(ASSET + 'snow.jpg', { srgb: false });
      for (let i = 0; i < 2; i++) { fTex[i] = makeTex(gl); farTex[i] = makeTex(gl); }
      fNew = null; farNew = null; fW = fH = 0;
      const r = ctx.rng(5); rnd = ctx.rng(6);
      const wa = 0.25 + (r() - 0.5) * 0.7;
      wind = [Math.cos(wa), Math.sin(wa)]; windA0 = wa; windInit = false; wph = 0; cacheLight = null; trackT = 0; lastPM = null;
      phase0 = QS.has('stcharge') ? +QS.get('stcharge') : 0.25 + r() * 0.5;
      ch.cyc = null;
      shuttleT = QS.has('stshuttle') ? 0 : 4 + r() * 40;
      shuttle = null;
      raidT = 3 + r() * 6;
      bolts = []; impacts = []; debris = []; xws = []; chasers = []; strikes = []; craters = []; smokes = []; timers = [];
      ctx.atlas.define('crater', 128, 128, drawCrater);
      ctx.atlas.define('tie0', 256, 256, (g, w, h) => drawTie(g, w, h, 0));
      ctx.atlas.define('tie1', 256, 256, (g, w, h) => drawTie(g, w, h, 1));
      ctx.atlas.define('xwing', 320, 320, drawXwing);
      ctx.atlas.define('shuttle', 512, 512, drawShuttle);
      ctx.atlas.define('turret', 128, 128, drawTurret);
      ctx.atlas.define('slight', 96, 96, drawLight);
      ctx.atlas.define('puff', 192, 192, drawPuff);
      ctx.atlas.define('catwalk', 512, 40, drawCatwalk);
      ctx.atlas.define('cond', 512, 48, drawConduit);
      ctx.atlas.define('node', 128, 128, drawNode);
      flock = new ctx.Flock({ count: 0, speed: 165, turn: 1.3, margin: 40, wander: 0.45, formation: 2, spacing: 40, seedK: 23 });
      if (!noiseT) noiseT = ctx.makeTarget(1024, 1024, { float: false, repeat: true });
      noiseDirty = true; natDirty = true; dirty = true;
    },

    resize(ctx) {
      if (terr) ctx.freeTarget(terr);
      if (natT) ctx.freeTarget(natT);
      terr = ctx.makeTarget(ctx.pxW, ctx.pxH);
      natT = ctx.makeTarget(ctx.pxW, ctx.pxH);
      natDirty = true; dirty = true;
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
      const oldF = (!fNew || resized) ? nf.d : fNew, oldFar = (!farNew || resized || farNew.length !== nfar.length) ? nfar : farNew;
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
      envUpdate(ctx);
      const pm = ctx.pointer || {}, pact = !!pm.active;
      if (pact && pm.lastMove !== lastPM) { lastPM = pm.lastMove; trackT = 3.5; }
      trackT = pact ? Math.max(0, trackT - ctx.rawDt) : 0;
      for (const tm of timers) { tm.t -= dt; if (tm.t <= 0) { tm.done = true; tm.f(); } }
      timers = timers.filter(tm => !tm.done);
      // patrols
      flock.resize(Math.round(P.traffic * 4) * 3);
      flock.update(dt, t);
      // shuttle
      shuttleT -= dt;
      if (!shuttle && shuttleT <= 0 && P.traffic > 0) {
        const a = rnd() * 6.283, ux = Math.cos(a), uy = Math.sin(a), diag = Math.hypot(W, H);
        const off = (rnd() - 0.5) * 0.6;
        const cx = W / 2 - uy * off * H, cy = H / 2 + ux * off * H;
        shuttle = { x: cx - ux * (diag / 2 + 180), y: cy - uy * (diag / 2 + 180), ang: a, spd: 58, life: (diag + 360) / 58, age: 0 };
        if (QS.has('stshuttle') && t < 1) { shuttle.x = cx - ux * 200; shuttle.y = cy - uy * 200; }
        shuttleT = (70 + rnd() * 90) / Math.max(0.3, P.traffic);
      }
      if (shuttle) {
        // the shuttle eases away from the cursor and picks up speed
        const s = shuttle; let spdT = 58;
        if (pact) {
          const dx = s.x - pm.x, dy = s.y - pm.y, d = Math.hypot(dx, dy);
          if (d < 300) { const push = 1 - d / 300; s.ang += clamp(angTo(s.ang, Math.atan2(dy, dx)), -1, 1) * push * dt * 0.8; spdT = 58 * (1 + 1.8 * push); }
        }
        s.spd += (spdT - s.spd) * Math.min(1, dt * 1.5);
        s.x += Math.cos(s.ang) * s.spd * dt; s.y += Math.sin(s.ang) * s.spd * dt; s.life -= dt; s.age += dt;
        const out = s.x < -300 || s.y < -300 || s.x > W + 300 || s.y > H + 300;
        const away = Math.cos(s.ang) * (W / 2 - s.x) + Math.sin(s.ang) * (H / 2 - s.y) < 0;
        if (out && (s.life < 0 || (s.age > 6 && away))) shuttle = null;
      }
      // turret idle sweep and searchlights
      for (const tr of turrets) {
        let target = null, best = 420;
        for (const x of xws) if (x.alive) { const d = Math.hypot(x.x - tr.x, x.y - tr.y); if (d < best) { best = d; target = x; } }
        const idle = tr.out + Math.sin(t * 0.21 + tr.ph) * 1.2;
        let want = target ? Math.atan2(target.y + Math.sin(target.ang) * 40 - tr.y, target.x + Math.cos(target.ang) * 40 - tr.x) : idle, rate = 2.5, look = -1;
        const task = tr.tasks && tr.tasks[0];
        if (task) { want = Math.atan2(task.y - tr.y, task.x - tr.x); rate = 7; look = Math.hypot(task.x - tr.x, task.y - tr.y); }
        else if (tr.spotT > 0) { tr.spotT -= dt; want = Math.atan2(tr.spot[1] - tr.y, tr.spot[0] - tr.x); rate = 5; look = Math.hypot(tr.spot[0] - tr.x, tr.spot[1] - tr.y); }
        else if (!target && trackT > 0) {
          // turrets and searchlights briefly follow the cursor
          const d = Math.hypot(pm.x - tr.x, pm.y - tr.y);
          if (d < 480) { want = Math.atan2(pm.y - tr.y, pm.x - tr.x); rate = 3.4; look = d; }
        }
        tr.aim += clamp(angTo(tr.aim, want), -rate * dt, rate * dt);
        if (tr.kind === 'light') { tr.beam = tr.aim; tr.bdist = look >= 0 ? clamp(look, 40, 320) : target ? Math.min(best, 260) : 120 + 45 * Math.sin(t * 0.17 + tr.ph * 1.7); }
        if (task) {
          if (Math.abs(angTo(tr.aim, want)) < 0.05) {
            const bx = tr.x + Math.cos(tr.aim) * 11, by = tr.y + Math.sin(tr.aim) * 11;
            strikeBurst(bx, by, task.x, task.y, { color: [1.0, 0.1, 0.04], speed: 1400, len: 20, width: 2.3, gap: 0.09 });
            tr.recoil = 1; tr.tasks.shift();
          }
        }
        if (tr.recoil) tr.recoil = Math.max(0, tr.recoil - dt * 3);
        if (target && tr.kind === 'gun' && P.skirmish > 0) {
          tr.fireT -= dt;
          if (tr.fireT <= 0 && Math.abs(angTo(tr.aim, want)) < 0.3) {
            const tx = target.x + Math.cos(target.ang) * target.spd * 0.25 + (rnd() - 0.5) * 50, ty = target.y + Math.sin(target.ang) * target.spd * 0.25 + (rnd() - 0.5) * 50;
            const bx = tr.x + Math.cos(tr.aim) * 10, by = tr.y + Math.sin(tr.aim) * 10;
            fire(bx, by, tx, ty, { color: [0.25, 1.0, 0.35], speed: 900, len: 12, width: 1.6, onHit: () => { if (Math.hypot(tx - target.x, ty - target.y) < 24 && target.alive) hitXw(target); } });
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
        let tr8 = 1.0, spdT = 290;
        if (pact) {
          const px = x.x - pm.x, py = x.y - pm.y, pd = Math.hypot(px, py);
          if (pd < 230) {
            const push = 1 - pd / 230, away = Math.atan2(py, px);
            want = Math.atan2(Math.sin(want) * (1 - push) + Math.sin(away) * push * 2, Math.cos(want) * (1 - push) + Math.cos(away) * push * 2);
            tr8 = 1 + 1.6 * push; spdT = 290 + 150 * push;
          }
        }
        x.spd += (spdT - x.spd) * Math.min(1, dt * 2);
        const turn = clamp(angTo(x.ang, want), -tr8 * dt, tr8 * dt);
        x.ang += turn;
        x.x += Math.cos(x.ang) * x.spd * dt; x.y += Math.sin(x.ang) * x.spd * dt;
        x.hit = Math.max(0, x.hit - dt * 3);
        if (!x.passed && dist < 560 && dist > 70) {
          x.fireT -= dt;
          if (x.fireT <= 0) {
            const [ix, iy] = pushOut(x.tx + (rnd() - 0.5) * 60, x.ty + (rnd() - 0.5) * 60, geo.R + 4);
            for (const s of [-1, 1]) {
              const px = -Math.sin(x.ang) * s * 15, py = Math.cos(x.ang) * s * 15;
              fire(x.x + px + Math.cos(x.ang) * 22, x.y + py + Math.sin(x.ang) * 22, ix + px * 0.6, iy + py * 0.6, { color: [1.0, 0.12, 0.06], speed: 1150, len: 22, width: 2.2, ground: true });
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
        if (pact) {
          const px = c.x - pm.x, py = c.y - pm.y, pd = Math.hypot(px, py);
          if (pd < 190) { const push = 1 - pd / 190, away = Math.atan2(py, px); want = Math.atan2(Math.sin(want) * (1 - push) + Math.sin(away) * push * 2, Math.cos(want) * (1 - push) + Math.cos(away) * push * 2); }
        }
        c.ang += clamp(angTo(c.ang, want), -2.0 * dt, 2.0 * dt);
        c.x += Math.cos(c.ang) * c.spd * dt; c.y += Math.sin(c.ang) * c.spd * dt;
        if (tg) {
          const d = Math.hypot(tg.x - c.x, tg.y - c.y);
          c.spd = d > 140 ? 340 : 285;
          c.fireT -= dt;
          if (c.fireT <= 0 && d < 330 && Math.abs(angTo(c.ang, Math.atan2(tg.y - c.y, tg.x - c.x))) < 0.28) {
            const tx = tg.x + (rnd() - 0.5) * 36, ty = tg.y + (rnd() - 0.5) * 36, target = tg;
            for (const s of [-1, 1]) {
              const px = -Math.sin(c.ang) * s * 4, py = Math.cos(c.ang) * s * 4;
              fire(c.x + px + Math.cos(c.ang) * 12, c.y + py + Math.sin(c.ang) * 12, tx + px, ty + py, { color: [0.3, 1.0, 0.3], speed: 1000, len: 14, width: 1.8, onHit: s > 0 ? () => { if (target.alive && Math.hypot(tx - target.x, ty - target.y) < 28) hitXw(target); } : null });
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
          if (b.strike) { /* the onHit callback makes the strike */ }
          else if (b.ground) impact(b.x, b.y, 0.7 + rnd() * 0.5, 'snow');
          else impacts.push({ x: b.x, y: b.y, age: 0, life: 0.3, size: 0.4, kind: 'air', rot: 0 });
          if (b.onHit) b.onHit();
        }
      }
      bolts = bolts.filter(b => !b.dead);
      for (const m of impacts) m.age += dt;
      impacts = impacts.filter(m => m.age < m.life);
      for (const d of debris) { d.age += dt; d.x += d.vx * dt; d.y += d.vy * dt; d.vx *= 1 - dt * 1.5; d.vy *= 1 - dt * 1.5; }
      debris = debris.filter(d => d.age < d.life);
      for (const m of strikes) m.age += dt;
      strikes = strikes.filter(m => m.age < m.life);
      for (const m of craters) m.age += dt;
      craters = craters.filter(m => m.age < m.life);
      for (const m of smokes) m.age += dt;
      smokes = smokes.filter(m => m.age < m.life);
    },

    // Double-click: the nearest trench turret slews round and fires a red burst at the spot (a nearby patrol fighter may
    // take the shot with green bolts instead). The hit throws up snow, flashes, smokes and leaves a scorched crater
    // that drifting snow slowly fills in.
    fire(ctx, x, y) {
      C = ctx;
      let best = null, bd = 1e9;
      for (const tr of turrets) if (tr.kind === 'gun') {
        const d = Math.hypot(tr.x - x, tr.y - y);
        if (d < 26) continue;
        const score = d + (tr.tasks ? tr.tasks.length * 140 : 0);
        if (score < bd) { bd = score; best = tr; }
      }
      let fa = null, fd = 1e9;
      for (const a of flock.agents) { const d = Math.hypot(a.x - x, a.y - y); if (d < fd && d > 60) { fd = d; fa = a; } }
      if (fa && fd < 340 && (!best || fd < bd * 0.6)) {
        const c = Math.cos(fa.ang), s = Math.sin(fa.ang);
        strikeBurst(fa.x + c * 12, fa.y + s * 12, x, y, { color: [0.3, 1.0, 0.3], speed: 1500, len: 16, width: 2, gap: 0.07 });
        return;
      }
      if (best && bd < 1600) {
        (best.tasks || (best.tasks = [])).push({ x, y });
        // the nearest searchlight swings onto the spot too
        let sl = null, sd = 520;
        for (const tr of turrets) if (tr.kind === 'light') { const d = Math.hypot(tr.x - x, tr.y - y); if (d < sd && d > 30) { sd = d; sl = tr; } }
        if (sl) { sl.spot = [x, y]; sl.spotT = 2.6; }
        return;
      }
      // no turret in reach: a battery beyond the screen edge takes the shot
      const ex = x < ctx.W / 2 ? -60 : ctx.W + 60, ey = y + (y < ctx.H / 2 ? -1 : 1) * 260;
      strikeBurst(ex, ey, x, y, { color: [1.0, 0.1, 0.04], speed: 1700, len: 24, width: 2.4, gap: 0.09 });
    },

    render(ctx) {
      const gl = ctx.gl;
      const settling = !ctx.fieldStable || ctx.intro < 1;
      if (settling) pendingFinal = true;
      let doCache = dirty || settling;
      if (!settling && pendingFinal) { doCache = true; pendingFinal = false; }
      const grow = Math.pow(1 - ctx.intro, 2) * (geo.R + geo.Ap + 90);
      const U = {
        uM: ctx.morph, uFS: fStep, uFG: [fW, fH], uFarS: farStep, uFarG: [farW, farH], uGrow: grow,
        uF: geo.F, uR: geo.R, uAp: geo.Ap, uDepth: geo.depth, uWind: wind, uQ: ctx.P.quality,
        uL: E.L, uSunC: E.sun, uSkyC: E.sky
      };
      if (noiseDirty && noiseT) {
        ctx.fullscreen(progN, {}, {}, noiseT);
        gl.bindTexture(gl.TEXTURE_2D, noiseT.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        const ani = gl.getExtension('EXT_texture_filter_anisotropic');
        if (ani) gl.texParameterf(gl.TEXTURE_2D, ani.TEXTURE_MAX_ANISOTROPY_EXT, 8);
        noiseDirty = false;
      }
      const T = { uDA: fTex[0], uDB: fTex[1], uFarA: farTex[0], uFarB: farTex[1], uNz: noiseT.tex };
      if (natDirty && natT) {
        ctx.fullscreen(progNat, U, Object.assign({ uRock: rockTex, uSnow: snowTex }, T), natT);
        natDirty = false; doCache = true;
      }
      if (doCache && terr) {
        ctx.fullscreen(progT, U, Object.assign({ uNat: natT.tex, uRock: rockTex, uSnow: snowTex }, T), terr);
        dirty = false;
      }
      const wl = [Math.cos(windA), Math.sin(windA)];
      const UL = Object.assign({ uGlow: ch.glow, uFlare: ch.flare, uRing: ch.ring, uRingA: ch.ringA, uFlash: ch.flash,
        uWDL: wl, uLitP: litP, uLite: E.lite, uWPh: wph, uWS: E.ws, uCloud: E.cloud, uSnowF: E.snowF, uSleet: E.sleet, uStorm: E.storm,
        uFog: E.fog, uNight: E.night, uLitF: E.litF, uAur: E.aur, uEmK: E.emK, uSpk: E.spk }, U);
      ctx.fullscreen(progL, UL, Object.assign({ uTer: terr.tex }, T), null);

      const t = ctx.flow, ia = ctx.intro, fa = ia * (ctx.fieldStable ? 1 : ctx.morph);
      const lvl = ch.glow + ch.flare * 2.6, lv = Math.min(lvl, 1.4);
      // blast craters from point-and-fire: drifting snow fills them in over ~20 s; embers glow for the first seconds
      for (const m of craters) {
        const k = m.age / m.life, fill = 1 - Math.pow(Math.min(1, Math.max(0, (k - 0.08) / 0.92)), 0.8);
        const wsz = 46 * m.sz * (0.7 + 0.3 * Math.min(1, m.age * 6));
        spr('crater', m.x, m.y, { w: wsz, rot: m.rot, alpha: fill * Math.min(1, m.age * 10), tint: [1 + 0.5 * (1 - fill), 1 + 0.5 * (1 - fill), 1 + 0.6 * (1 - fill)] });
        const em = Math.exp(-m.age * 1.4);
        if (em > 0.02) ctx.glowDot(m.x, m.y, 5 + 6 * m.sz, [1, 0.32, 0.08], 3.2 * em, { core: 0.6 * em });
      }
      // at night, floodlights pool on the aprons around the gun emplacements
      if (E.night > 0.01) for (const tr of turrets) {
        ctx.glowDot(tr.x + Math.cos(tr.out) * 12, tr.y + Math.sin(tr.out) * 12, 30, [1.0, 0.86, 0.7], 0.07 * E.night * fa, { core: 0, falloff: 2.2 });
      }
      // catwalks
      for (const cw of catwalks) {
        spr('catwalk', cw.x, cw.y, { w: cw.len, h: 7, alpha: fa, shadow: { dx: 6, dy: 5, alpha: 0.65, bias: 1.5 } });
        const n = Math.max(2, Math.round(cw.len / 22));
        for (let i = 0; i <= n; i++) { const x = cw.x - cw.len / 2 + (i / n) * cw.len; ctx.glowDot(x, cw.y, 2.2, [1, 0.15, 0.05], (0.6 + 1.3 * lv) * fa, { core: 0.6 }); }
      }
      // power conduits: armoured double pipes in a cut, a glowing slot, pulses running toward the trench
      for (const c of conduits) {
        const mx = (c.x0 + c.x1) / 2, my = (c.y0 + c.y1) / 2, ux = Math.cos(c.ang), uy = Math.sin(c.ang);
        spr('cond', mx, my, { w: c.L, h: 11, rot: c.ang, alpha: fa, shadow: { dx: 2.5, dy: 2, alpha: 0.35, bias: 1 } });
        ctx.glowLine(c.x0, c.y0, c.x1, c.y1, 2.6, [1, 0.07, 0.02], (0.35 + 1.4 * lv) * fa, { core: 0.5, coreR: 0.25 });
        const spacing = 38, sp = (26 + 70 * ch.c * ch.c + 140 * ch.flare) * c.spd, off = (t * sp + c.ph) % spacing;
        for (let d = c.L - off; d > 0; d -= spacing) {
          const k = Math.min(1, d / 10) * Math.min(1, (c.L - d) / 10);
          ctx.glowLine(c.x0 + ux * (d - 5), c.y0 + uy * (d - 5), c.x0 + ux * (d + 5), c.y0 + uy * (d + 5), 4, [1, 0.16, 0.04], (0.8 + 4 * lv) * k * fa, { core: 0.7 });
        }
        spr('node', c.x1 + ux * 8, c.y1 + uy * 8, { w: 20, rot: c.ang, alpha: fa, shadow: { dx: 4, dy: 3.2, alpha: 0.65, bias: 1.2 } });
        ctx.glowDot(c.x1 + ux * 9.5, c.y1 + uy * 9.5, 3, [1, 0.12, 0.03], (1 + 3 * lv) * fa * (0.6 + 0.4 * Math.sin(t * 3 + c.ph)), { core: 0.8 });
      }
      // ground impacts (snow bursts)
      for (const m of impacts) {
        const k = m.age / m.life;
        if (m.kind === 'snow' || m.kind === 'boom') {
          const s = m.size * (m.kind === 'boom' ? 64 : 36) * (0.35 + 0.9 * Math.pow(k, 0.45));
          spr('puff', m.x + k * 16 * wl[0], m.y + k * 16 * wl[1], { w: s, rot: m.rot + k * 0.6, alpha: 0.85 * (1 - k) * (1 - k), tint: [0.92, 0.95, 1.0] });
        }
      }
      // turrets and searchlights
      for (const tr of turrets) {
        if (tr.kind === 'light') {
          const bx = tr.x + Math.cos(tr.beam) * tr.bdist, by = tr.y + Math.sin(tr.beam) * tr.bdist;
          const ok = clamp((fieldD(bx, by) - geo.R - 20) / 40, 0, 1) * clamp((fieldD((tr.x + bx) / 2, (tr.y + by) / 2) - geo.R) / 30, 0, 1);
          if (ok > 0) {
            ctx.glowLine(tr.x, tr.y, bx, by, 9, [0.65, 0.8, 1.0], 0.10 * fa * ok * E.slK, { core: 0 });
            ctx.glowLine(bx - Math.cos(tr.beam) * 14, by - Math.sin(tr.beam) * 14, bx + Math.cos(tr.beam) * 14, by + Math.sin(tr.beam) * 14, 24, [0.75, 0.86, 1.0], 0.42 * fa * ok * Math.min(E.slK, 1.8), { core: 0, falloff: 3.5 });
          }
          spr('slight', tr.x, tr.y, { w: 14, rot: tr.beam, alpha: fa, shadow: { dx: 3.5, dy: 3, alpha: 0.55, bias: 1 } });
          ctx.glowDot(tr.x + Math.cos(tr.beam) * 4.5, tr.y + Math.sin(tr.beam) * 4.5, 4, [0.8, 0.9, 1.0], 2.5 * fa, { core: 1 });
        } else {
          const rk = (tr.recoil || 0) * 1.5;
          spr('turret', tr.x - Math.cos(tr.aim) * rk, tr.y - Math.sin(tr.aim) * rk, { w: 20, rot: tr.aim, alpha: fa, shadow: { dx: 3.5, dy: 3, alpha: 0.6, bias: 1 } });
          if (tr.recoil > 0.3) ctx.glowDot(tr.x + Math.cos(tr.aim) * 12, tr.y + Math.sin(tr.aim) * 12, 7, [1, 0.25, 0.1], 6 * (tr.recoil - 0.3), { core: 1 });
        }
        const blink = Math.pow(0.5 + 0.5 * Math.sin(t * 2.2 + tr.ph), 12);
        ctx.glowDot(tr.x - Math.cos(tr.aim) * 6, tr.y - Math.sin(tr.aim) * 6, 3, [1, 0.12, 0.04], (0.4 + 5 * blink) * fa, { core: 0.8 });
      }
      // shuttle
      if (shuttle) {
        const s = shuttle;
        spr('shuttle', s.x, s.y, { w: 190, rot: s.ang, shadow: { dx: 84, dy: 66, alpha: 0.5, bias: 3, scale: 1.02 } });
        const bx = s.x - Math.cos(s.ang) * 42, by = s.y - Math.sin(s.ang) * 42;
        for (const sy of [-1, 1]) ctx.glowDot(bx - Math.sin(s.ang) * sy * 4, by + Math.cos(s.ang) * sy * 4, 6, [0.6, 0.75, 1.0], 3, { core: 0.7 });
        const bl = Math.pow(0.5 + 0.5 * Math.sin(t * 3), 16) * 6;
        for (const sy of [-1, 1]) ctx.glowDot(s.x - Math.sin(s.ang) * sy * 88 + Math.cos(s.ang) * 3, s.y + Math.cos(s.ang) * sy * 88 + Math.sin(s.ang) * 3, 3, [1, 0.15, 0.05], bl, { core: 1 });
      }
      // patrol fighters
      const agents = flock.agents;
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i], kind = ((i / 3) | 0) % 2;
        spr(kind ? 'tie1' : 'tie0', a.x, a.y, { w: 46, rot: a.ang, shadow: { dx: 36, dy: 29, alpha: 0.5, bias: 2 } });
        const c = Math.cos(a.ang), s = Math.sin(a.ang);
        for (const sy of [-1, 1]) ctx.glowDot(a.x - c * 6.5 - s * sy * 2.2, a.y - s * 6.5 + c * sy * 2.2, 2.6, [0.7, 0.8, 1.0], 1.4, { core: 0.6 });
      }
      for (const c of chasers) {
        spr('tie1', c.x, c.y, { w: 46, rot: c.ang, shadow: { dx: 36, dy: 29, alpha: 0.5, bias: 2 } });
        const co = Math.cos(c.ang), si = Math.sin(c.ang);
        for (const sy of [-1, 1]) ctx.glowDot(c.x - co * 6.5 - si * sy * 2.2, c.y - si * 6.5 + co * sy * 2.2, 3, [0.7, 0.8, 1.0], 2, { core: 0.6 });
      }
      for (const x of xws) {
        spr('xwing', x.x, x.y, { w: 58, rot: x.ang, tint: x.hit > 0 ? [1 + x.hit * 3, 1 + x.hit * 1.5, 1 + x.hit] : [1, 1, 1], shadow: { dx: 40, dy: 32, alpha: 0.5, bias: 2 } });
        const c = Math.cos(x.ang), s = Math.sin(x.ang);
        for (const sy of [-1, 1]) ctx.glowDot(x.x - c * 23 - s * sy * 5.3, x.y - s * 23 + c * sy * 5.3, 3.2, [1.0, 0.45, 0.25], 3.4, { core: 0.8 });
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
          spr('puff', m.x, m.y, { w: 20 + 50 * k, rot: m.rot, alpha: 0.7 * (1 - k), tint: [0.25, 0.22, 0.22] });
        }
      }
      for (const d of debris) { const f = 1 - d.age / d.life; ctx.glowLine(d.x - d.vx * 0.03, d.y - d.vy * 0.03, d.x, d.y, 1.6, [1, 0.5, 0.2], 6 * f, { core: f }); }
      // point-and-fire strikes: snow burst, flash, then smoke drifting downwind
      for (const m of smokes) {
        if (m.age < 0) continue;
        const k = m.age / m.life;
        spr('puff', m.x + wl[0] * m.age * 16, m.y + wl[1] * m.age * 16, { w: m.sz * (12 + 34 * Math.pow(k, 0.6)), rot: m.rot + k * 0.8, alpha: 0.5 * Math.min(1, m.age * 5) * (1 - k) * (1 - k), tint: [0.2, 0.19, 0.19] });
      }
      for (const m of strikes) {
        const k = m.age / m.life;
        if (m.big) {
          spr('puff', m.x, m.y, { w: m.sz * (16 + 72 * Math.pow(k, 0.4)), rot: m.rot + k * 0.5, alpha: 0.85 * Math.pow(1 - k, 2.4), tint: [0.95, 0.97, 1.0] });
          spr('puff', m.x + wl[0] * k * 12, m.y + wl[1] * k * 12, { w: m.sz * (10 + 46 * Math.pow(k, 0.35)), rot: -m.rot, alpha: 0.6 * Math.pow(1 - k, 3), tint: [1, 1, 1] });
        } else spr('puff', m.x, m.y, { w: m.sz * (10 + 38 * Math.pow(k, 0.4)), rot: m.rot, alpha: 0.6 * Math.pow(1 - k, 2.6), tint: [0.95, 0.97, 1.0] });
        const f = Math.max(0, 1 - k * 5);
        if (f > 0) ctx.glowDot(m.x, m.y, (12 + 30 * k) * m.sz + 4, [1, 0.5, 0.2], (m.big ? 20 : 12) * f * f, { core: f });
      }
    },

    dispose(ctx) {
      const gl = ctx.gl;
      for (const pr of [progN, progNat, progT, progL]) if (pr) gl.deleteProgram(pr.p);
      for (let i = 0; i < 2; i++) { if (fTex[i]) gl.deleteTexture(fTex[i]); if (farTex[i]) gl.deleteTexture(farTex[i]); fTex[i] = farTex[i] = null; }
      if (terr) ctx.freeTarget(terr); if (natT) ctx.freeTarget(natT); if (noiseT) ctx.freeTarget(noiseT);
      terr = natT = noiseT = null; progN = progNat = progT = progL = null; fNew = farNew = null;
    }
  });

  function hitXw(x) {
    x.hit = 1; x.hp--;
    if (x.hp <= 0 && x.alive) { x.alive = false; boom(x.x, x.y); }
  }
})();
