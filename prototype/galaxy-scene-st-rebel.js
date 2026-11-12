// Galaxy theme · Sequel trilogy, Rebellion side: "Salt flats".
// Straight down onto a mineral planet: brilliant white salt crust over blood-red soil, low sun from the upper left.
// Around every icon the crust has broken away and the red ground shows through. Moved icons and ski speeders
// leave red scars that heal over about a minute (a ping-pong "scar" target: scar = max(scar * decay, current mask)).
(function () {
  'use strict';
  const ID = 'st-rebel';
  const DBG = new URLSearchParams(location.search).get('ev') || '';
  const TAU = Math.PI * 2;
  const SUN = (() => { const x = -0.78, y = -0.62, l = Math.hypot(x, y); return [x / l, y / l]; })();   // toward the sun, CSS px axes
  const SH = [-SUN[0], -SUN[1]];                                                                       // shadows fall this way
  const WIND = (() => { const x = 0.94, y = 0.34, l = Math.hypot(x, y); return [x / l, y / l]; })();
  const RAGK = 0.42;

  /* ---------------- GLSL ---------------- */
  const SHARED = `
const vec2 SUN = normalize(vec2(-0.78, -0.62));
const vec2 WD = normalize(vec2(0.94, 0.34));
const float RAGK = ${RAGK.toFixed(3)};
float sq(float x) { return x * x; }
// Red mask of the live icon field: 0.5 at the crust break line, 1 deep inside
float liveMask(vec2 p) {
  float m = clamp(0.5 - iconBlob(p) / 60., 0., 1.);
  return max(m, smoothstep(30., 6., iconDist(p)));
}
`;

  // Static salt crust: plates, cracks, ridges, dunes, shading and long shadows. Stored /1.6 in RGBA8; alpha = sun light (sparkle gate).
  const SALT_FS = SHARED + `
uniform float uHi;
const float EL = 0.25;
vec2 warpP(vec2 p) { return p + vec2(gfbm(p * 0.0035 + 3.1 + uSeed, 2), gfbm(p * 0.0035 + 7.7 - uSeed, 2)) * 46.; }
float Hs(vec2 p, bool fine, out vec4 o) {
  vec2 q = warpP(p);
  vec4 v1 = voronoi(q / 210. + uSeed * 1.7);
  float e1 = (v1.y - v1.x) * 105.;
  float ph = hash12(v1.zw + 4.);
  float h = 2.6 * smoothstep(0., 34., e1) + (ph - .5) * 1.6;
  h += 1.5 * exp(-sq((e1 - 5.5) / 3.4));
  h -= 2.2 * (1. - smoothstep(0., 2.4, e1));
  float d2 = smoothstep(.32, .7, vnoise(p * 0.0026 + 11. + uSeed));
  vec4 v2 = voronoi(q / 66. + 5.3);
  float e2 = (v2.y - v2.x) * 33.;
  float c2 = d2 * (1. - smoothstep(0., 1.5, e2));
  h += d2 * (1.0 * smoothstep(0., 10., e2) + .5 * exp(-sq((e2 - 2.5) / 1.6))) - 1.0 * c2;
  float c3 = 0.;
  if (fine) {
    float d3 = smoothstep(.42, .8, vnoise(p * 0.0045 - 3. - uSeed));
    vec4 v3 = voronoi(q / 21. + 9.1);
    float e3 = (v3.y - v3.x) * 10.5;
    c3 = d3 * (1. - smoothstep(0., .9, e3));
    h += d3 * .4 * smoothstep(0., 3.5, e3) - .4 * c3;
    h += .14 * vnoise(p * .75) + .06 * vnoise(p * 2.1);
  }
  vec2 r = rot2(0.42 + uSeed * .01) * p;
  h += 18. * gfbm(vec2(r.x * 0.0009, r.y * 0.0024) + uSeed * .13, 3);
  vec2 rw = r + vec2(gfbm(p * .0012 + 1.3, 3), gfbm(p * .0012 + 8.1, 3)) * 260.;
  float rg = 1. - abs(gnoise(vec2(rw.x * 0.00055, rw.y * 0.0017) + 2. + uSeed * .2) * 2.3);
  h += 7. * pow(clamp(rg, 0., 1.), 5.);
  o = vec4(e1, c2, c3, ph);
  return h;
}
void main() {
  vec2 p = cssPos();
  vec4 o, t4;
  float h = Hs(p, true, o);
  float e = .7;
  float hx = Hs(p + vec2(e, 0.), true, t4), hy = Hs(p + vec2(0., e), true, t4);
  vec3 N = normalize(vec3(-(hx - h) / e, -(hy - h) / e, 1.));
  float h0 = Hs(p, false, t4);
  float sh = 0., t = 1.3, tanE = tan(EL);
  int NS = uHi > .5 ? 11 : 7;
  for (int i = 0; i < 11; i++) {
    if (i >= NS) break;
    float hh = Hs(p + SUN * t, false, t4);
    sh = max(sh, smoothstep(0., .5 + t * .05, hh - h0 - t * tanE));
    t *= 1.55;
  }
  vec3 L = vec3(SUN * cos(EL), sin(EL));
  float dif = clamp(dot(N, L) / sin(EL), 0., 2.2);
  float sunL = dif * (1. - sh * .88);
  float c1 = 1. - smoothstep(0., 2.4, o.x);
  float ao = 1. - .45 * c1 - .3 * o.y - .15 * o.z;
  // Albedo: white crust with plate tones, wind-drift streaks, thin pink patches and red seeping up the big cracks
  vec3 alb = vec3(.955, .95, .935) * (.955 + .06 * o.w);
  vec2 pe = vec2(-WD.y, WD.x);
  alb *= 1. + .045 * gfbm(vec2(dot(p, WD) * .005, dot(p, pe) * .045) + uSeed, 3);
  float thin = smoothstep(.58, .8, fbm(p * .0016 + 21. + uSeed, 4));
  alb = mix(alb, vec3(.93, .74, .72), thin * .3);
  alb = mix(alb, vec3(.9, .7, .68), exp(-o.x / 6.) * .3);
  alb = mix(alb, vec3(.62, .58, .6), o.y * .45);
  alb = mix(alb, vec3(.8, .78, .79), o.z * .3);
  alb = mix(alb, vec3(.40, .05, .04), c1 * .9);
  vec3 sunC = vec3(1., .93, .82), skyC = vec3(.68, .78, 1.);
  vec3 col = alb * (sunC * sunL * .6 + skyC * .52 * ao);
  outColor = vec4(col / 1.6, clamp(sunL / 1.4, 0., 1.));
}`;

  // Static red soil under the crust. Alpha = ragged-edge noise for the crust break line.
  const SOIL_FS = SHARED + `
void main() {
  vec2 p = cssPos();
  float n1 = fbm(p * .006 + uSeed * .3, 5);
  float n2 = fbm(p * .045 + 9.3, 4);
  float n3 = vnoise(p * .9);
  vec3 c = mix(vec3(.36, .018, .03), vec3(.50, .075, .04), smoothstep(.3, .72, n1));
  c *= .78 + .5 * n2;
  float rl = ridged(p * .016 + 4. + uSeed, 3);
  c *= mix(1., .68, smoothstep(.72, .95, rl));
  float hA = fbm((p + SUN * 1.3) * .045 + 9.3, 3), hB = fbm((p - SUN * 1.3) * .045 + 9.3, 3);
  c *= clamp(1. - (hA - hB) * 3.2, .6, 1.4);
  vec4 v = voronoi(p / 4.2 + 2.);
  float peb = smoothstep(.42, .2, v.x) * step(hash12(v.zw), .2);
  vec4 vb = voronoi((p - SUN * .9) / 4.2 + 2.);
  float pebS = smoothstep(.42, .2, vb.x) * step(hash12(vb.zw), .2);
  c *= 1. - .3 * pebS * (1. - peb);
  c = mix(c, c * 1.45 + vec3(.04, .012, .006), peb * .6);
  c *= .86 + .28 * n3;
  float rag = clamp(.5 + 1.3 * gfbm(p * .028 + 5.5 + uSeed, 4) + 1.1 * gfbm(p * .0075 - 2.5 - uSeed, 3), 0., 1.);
  outColor = vec4(c, rag);
}`;

  // Scar accumulation: R = icon holes and drag trails, G = speeder streaks, craters and footprints
  const SCAR_FS = SHARED + `
uniform sampler2D uPrev;
uniform float uKR, uKG;
void main() {
  vec2 p = cssPos();
  vec2 pr = texture(uPrev, vUv).rg;
  float r = max(pr.r * uKR, liveMask(p));
  outColor = vec4(min(r, 1.4), min(pr.g * uKG, 1.4), 0., 1.);
}`;

  const MAIN_FS = SHARED + `
uniform sampler2D uSalt, uSoil, uScar;
uniform float uHi, uSunI;
vec2 uvOf(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
float holeAt(vec2 p) {
  vec2 uv = uvOf(p);
  vec2 sc = texture(uScar, uv).rg;
  float rag = texture(uSoil, uv).a - .5;
  float m = max(sc.r, liveMask(p));
  return max(smoothstep(-.03, .03, m + rag * RAGK - .5), smoothstep(-.06, .06, sc.g + rag * .5 - .5));
}
void main() {
  vec2 p = cssPos();
  vec2 uv = uvOf(p);
  vec4 S = texture(uSalt, uv);
  vec4 G = texture(uSoil, uv);
  vec2 sc = texture(uScar, uv).rg;
  float rag = G.a - .5;
  float d = iconDist(p);
  float m = max(sc.r, liveMask(p));
  float fm = m + rag * RAGK - .5;
  float fg = sc.g + rag * .5 - .5;
  float hole = max(smoothstep(-.03, .03, fm), smoothstep(-.06, .06, fg));
  vec3 salt = S.rgb * 1.6 * uSunI;
  vec3 soil = G.rgb * uSunI;

  // ---- red ground ----
  if (hole > .001) {
    float depth = smoothstep(.04, .6, fm);
    soil *= mix(1., .48, depth);
    soil = mix(soil, soil * vec3(.95, .55, .6), depth * .6);
    float sh = 1. - holeAt(p + SUN * 4.);
    sh = max(sh, (1. - holeAt(p + SUN * 10.)) * .95);
    sh = max(sh, (1. - holeAt(p + SUN * 18.)) * .8);
    sh = max(sh, (1. - holeAt(p + SUN * 28.)) * .55);
    soil *= mix(vec3(1.), vec3(.22, .17, .3), sh * .95);
    float thinZ = (1. - smoothstep(.0, .1, fm)) * smoothstep(.35, .7, vnoise(p * .09 + 7.)) * step(-.03, fm);
    soil = mix(soil, vec3(.62, .26, .24) * uSunI * (1. - .5 * sh), thinZ * .55);
    float eIn = max(fm / .12, fg / .2);
    soil *= .72 + .28 * smoothstep(0., 1., eIn);
    // Loose crust flakes near the broken edge
    float eT = clamp(fm / .2, 0., 1.);
    if (fm > -.03 && eT < 1.) {
      vec4 v = voronoi(p / 7.5 + 3.7);
      float prob = .38 * (1. - eT) * (1. - eT) * smoothstep(.25, .6, vnoise(p * .05 + 3.));
      float ch = step(hash12(v.zw), prob) * smoothstep(.5, .34, v.x);
      vec4 v2 = voronoi((p + SUN * 2.4) / 7.5 + 3.7);
      float ch2 = step(hash12(v2.zw), prob) * smoothstep(.5, .34, v2.x);
      soil *= 1. - .5 * ch2 * (1. - ch);
      vec3 fl = salt * vec3(1., .88, .86) * (.72 + .38 * hash12(v.zw + 7.)) * (1. - .35 * sh);
      soil = mix(soil, fl, ch);
    }
  }

  // ---- salt crust ----
  if (hole < .999 && (abs(fm) < .32 || abs(fg) < .3)) {
    float fl = holeAt(p + SUN * 2.5);
    float fd = holeAt(p - SUN * 2.5);
    salt *= 1. + .28 * fl;
    salt *= mix(vec3(1.), vec3(.46, .44, .6), fd * .9);
  }
  float stain = smoothstep(.1, .5, max(m, sc.g * .9));
  salt = mix(salt, salt * vec3(1., .72, .68), stain * .6);
  float lit = S.a;
  float sheen = fbm(p * .0024 + vec2(uFlow * .02, -uFlow * .012), 3);
  salt *= 1. + .07 * smoothstep(.45, .8, sheen) * lit;
  float away = smoothstep(18., 70., d) * (1. - stain * .85);
  vec2 gq = p / 4.; vec3 hh = hash32(floor(gq) + 17.);
  float spk = 0.;
  if (hh.x < .1) {
    float dd = length(fract(gq) - (.2 + .6 * hh.yz)) * 4.;
    spk = pow(.5 + .5 * sin(uTime * (1.2 + 3. * hh.y) + hh.z * 80.), 30.) * exp(-dd * dd * 1.6);
  }
  if (uHi > .5) {
    gq = p / 34.; hh = hash32(floor(gq) + 91.);
    if (hh.x < .05) {
      vec2 r = (fract(gq) - (.2 + .6 * hh.yz)) * 34.;
      float tw = pow(.5 + .5 * sin(uTime * (.5 + .8 * hh.y) + hh.z * 50.), 16.);
      float star = exp(-dot(r, r) * .5) + .5 * (exp(-abs(r.x) * .32 - r.y * r.y * 3.) + exp(-abs(r.y) * .32 - r.x * r.x * 3.));
      spk += star * tw * 1.6;
    }
  }
  salt += vec3(1., .97, .92) * spk * 6. * lit * away;

  vec3 col = mix(salt, soil, hole);
  vec2 sv = p / uRes - .5;
  col *= 1.04 - .12 * clamp(dot(sv, -SUN) + .3, 0., 1.2);

  // ---- atmosphere: cloud shadows, wind-blown salt dust, grow-in whiteout ----
  float cs = smoothstep(.5, .76, fbm(p * .0008 + WD * uFlow * .01 + uSeed, 4));
  col *= mix(vec3(1.), vec3(.8, .84, .96), cs * .45);
  vec2 pe = vec2(-WD.y, WD.x);
  vec2 q = p - WD * uFlow * 70.;
  float dn = gfbm(vec2(dot(q, WD) * .0025, dot(q, pe) * .011) + uSeed, 4);
  float dust = smoothstep(.04, .4, dn);
  vec2 q2 = p - WD * uFlow * 170.;
  dust += .6 * dust * smoothstep(.1, .45, gfbm(vec2(dot(q2, WD) * .012, dot(q2, pe) * .06), 3));
  dust *= .35 + .65 * smoothstep(0., 60., d);
  col = mix(col, vec3(1.15, 1.1, 1.04) * uSunI, clamp(dust, 0., 1.5) * .11);
  col = mix(col, vec3(1.3, 1.26, 1.2), sq(1. - uIntro) * .85);
  outColor = vec4(col, 1.);
}`;

  /* ---------------- state ---------------- */
  let progSalt, progSoil, progScar, progMain;
  let salt = null, soil = null, scarA = null, scarB = null, cacheDirty = true;
  let scarRaw = 0, scarFlow = 0;
  let R = Math.random;
  let speeders = null;
  let dust = [], glints = [], bolts = [], fighters = [], flashes = [], sparks = [], drags = [], stampsR = [], stampsG = [];
  let foxGroups = [], freighter = null, walker = null;
  const fight = { on: false, t: 0, next: 10 };
  let nextFox = 5, nextShip = 60, nextWalker = 120;

  const rr = (a, b) => a + (b - a) * R();
  let flowNow = 0;
  const stG = (x, y, r, I) => stampsG.push(x, y, r, I, flowNow);
  function stampLine(e, x, y, spacing, r, I, list) {
    // Stamps gaussian dots every `spacing` px from the emitter's last stamp to (x, y); the dots sum to an even line.
    if (e.lx === undefined || Math.hypot(x - e.lx, y - e.ly) > 80) { e.lx = x; e.ly = y; return; }
    let dx = x - e.lx, dy = y - e.ly, L = Math.hypot(dx, dy);
    while (L >= spacing) {
      e.lx += dx / L * spacing; e.ly += dy / L * spacing;
      list.push(e.lx, e.ly, r, I, flowNow);
      dx = x - e.lx; dy = y - e.ly; L = Math.hypot(dx, dy);
    }
  }

  /* ---------------- sprites ---------------- */
  function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function poly(g, pts, fill, stroke, lw) { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); } }
  function grime(g, w, h, n, rnd, col) { g.fillStyle = col; for (let i = 0; i < n; i++) { g.globalAlpha = 0.05 + rnd() * 0.12; g.beginPath(); g.arc(rnd() * w, rnd() * h, 0.5 + rnd() * 2.5, 0, TAU); g.fill(); } g.globalAlpha = 1; }

  function defineSprites(ctx) {
    const rnd = ctx.rng(91);
    // Ski speeder, nose to the right, with its long single ski under the hull
    ctx.atlas.define('speeder', 320, 160, (g, w, h) => {
      g.fillStyle = '#26211f'; rrect(g, w * .02, h * .47, w * .96, h * .06, h * .03); g.fill();
      g.fillStyle = '#7b7570'; g.fillRect(w * .43, h * .22, w * .07, h * .56);
      for (const s of [-1, 1]) {
        const y = h * .5 + s * h * .29;
        const gr = g.createLinearGradient(0, y - h * .08, 0, y + h * .08); gr.addColorStop(0, '#cfc8bd'); gr.addColorStop(1, '#6a635c');
        g.fillStyle = gr; rrect(g, w * .29, y - h * .075, w * .34, h * .15, h * .07); g.fill();
        g.fillStyle = '#9c3a22'; g.fillRect(w * .5, y - h * .075, w * .045, h * .15);
        g.fillStyle = '#34302e'; g.fillRect(w * .26, y - h * .05, w * .04, h * .1);
      }
      const hg = g.createLinearGradient(0, h * .36, 0, h * .64); hg.addColorStop(0, '#ddd6cb'); hg.addColorStop(.55, '#a8a095'); hg.addColorStop(1, '#5a534d');
      poly(g, [w * .92, h * .5, w * .74, h * .355, w * .3, h * .375, w * .21, h * .43, w * .21, h * .57, w * .3, h * .625, w * .74, h * .645], hg, '#2a2623', 4);
      g.fillStyle = '#c4542c'; g.fillRect(w * .39, h * .38, w * .035, h * .24); g.fillRect(w * .8, h * .45, w * .08, h * .1);
      g.strokeStyle = 'rgba(60,50,45,.5)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(w * .3, h * .5); g.lineTo(w * .55, h * .5); g.stroke();
      const cg = g.createRadialGradient(w * .6, h * .47, 1, w * .62, h * .5, w * .08); cg.addColorStop(0, '#7f9bb0'); cg.addColorStop(.4, '#2a3540'); cg.addColorStop(1, '#14191e');
      g.fillStyle = cg; g.beginPath(); g.ellipse(w * .62, h * .5, w * .075, h * .08, 0, 0, TAU); g.fill();
      g.fillStyle = '#3f3a37'; g.fillRect(w * .16, h * .43, w * .06, h * .14);
      grime(g, w, h, 60, rnd, '#4a3020');
    });
    // First Order style fighter seen from above: ball cockpit with two flat wing panels (edge-on bars)
    ctx.atlas.define('fighter', 160, 160, (g, w, h) => {
      g.fillStyle = '#4c5056'; g.fillRect(w * .45, h * .15, w * .1, h * .7);
      for (const s of [-1, 1]) {
        const y = h * .5 + s * h * .38;
        poly(g, [w * .14, y, w * .24, y - h * .065, w * .76, y - h * .065, w * .86, y, w * .76, y + h * .065, w * .24, y + h * .065], '#24272c', '#8d939b', 2.5);
        g.strokeStyle = 'rgba(150,158,168,.55)'; g.lineWidth = 1.5;
        for (let k = 1; k < 6; k++) { const x = w * (.24 + .52 * k / 6); g.beginPath(); g.moveTo(x, y - h * .06); g.lineTo(x, y + h * .06); g.stroke(); }
      }
      const bg = g.createRadialGradient(w * .45, h * .44, 2, w * .5, h * .5, w * .17); bg.addColorStop(0, '#c4cad2'); bg.addColorStop(.7, '#6c727a'); bg.addColorStop(1, '#30343a');
      g.fillStyle = bg; g.beginPath(); g.arc(w * .5, h * .5, w * .165, 0, TAU); g.fill();
      g.fillStyle = '#0d0f12'; g.beginPath(); g.arc(w * .59, h * .5, w * .075, 0, TAU); g.fill();
      g.strokeStyle = '#59606a'; g.lineWidth = 2;
      for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; g.beginPath(); g.moveTo(w * .59, h * .5); g.lineTo(w * .59 + Math.cos(a) * w * .075, h * .5 + Math.sin(a) * w * .075); g.stroke(); }
    });
    // Crystal fox, nose to the right
    ctx.atlas.define('fox', 128, 64, (g, w, h) => {
      for (let i = 0; i < 9; i++) {
        const a = Math.PI + (i - 4) * 0.13, L = w * (.26 + .1 * Math.sin(i * 1.7));
        const x0 = w * .36, y0 = h * .5;
        poly(g, [x0, y0 - h * .07, x0 + Math.cos(a) * L, y0 + Math.sin(a) * L * 1.6, x0, y0 + h * .07], i % 2 ? 'rgba(225,240,255,.95)' : 'rgba(250,252,255,.95)', 'rgba(150,185,220,.8)', 1);
      }
      g.strokeStyle = '#6d6f78'; g.lineWidth = 2.2;
      for (const [x, s] of [[.42, -1], [.42, 1], [.62, -1], [.62, 1]]) { g.beginPath(); g.moveTo(w * x, h * .5); g.lineTo(w * (x + .04), h * (.5 + s * .3)); g.stroke(); }
      const bg = g.createRadialGradient(w * .5, h * .42, 1, w * .52, h * .5, w * .2); bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, '#c9d6e6');
      g.fillStyle = bg; g.beginPath(); g.ellipse(w * .52, h * .5, w * .19, h * .17, 0, 0, TAU); g.fill();
      poly(g, [w * .66, h * .38, w * .93, h * .5, w * .66, h * .62], '#f4f8ff', 'rgba(150,180,215,.9)', 1);
      poly(g, [w * .7, h * .4, w * .74, h * .22, w * .78, h * .43], '#e6f0ff');
      poly(g, [w * .7, h * .6, w * .74, h * .78, w * .78, h * .57], '#e6f0ff');
      for (let i = 0; i < 7; i++) { const x = w * (.38 + i * .04); poly(g, [x, h * .36, x + w * .02, h * (.2 + (i % 2) * .06), x + w * .04, h * .36], 'rgba(235,245,255,.95)', 'rgba(140,175,215,.7)', 1); }
      g.fillStyle = '#20232a'; g.beginPath(); g.arc(w * .92, h * .5, 1.8, 0, TAU); g.fill();
    });
    // Dust puffs (four variants), lighter toward the sun
    for (let v = 0; v < 4; v++) ctx.atlas.define('dust' + v, 96, 96, (g, w, h) => {
      const g0 = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * .48); g0.addColorStop(0, 'rgba(255,255,255,.62)'); g0.addColorStop(.45, 'rgba(255,255,255,.36)'); g0.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = g0; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 7; i++) {
        const a = rnd() * TAU, r = rnd() * w * .18, x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r, s = w * (.14 + rnd() * .14);
        const gr = g.createRadialGradient(x, y, 0, x, y, s); gr.addColorStop(0, 'rgba(255,255,255,.28)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, s, 0, TAU); g.fill();
      }
      g.globalCompositeOperation = 'source-atop';
      const lg = g.createLinearGradient(w * .15, h * .15, w * .85, h * .85); lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(1, 'rgba(70,50,60,.45)');
      g.fillStyle = lg; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
    });
    // Old light freighter: saucer, twin forward mandibles, offset cockpit
    ctx.atlas.define('freighter', 640, 640, (g, w, h) => {
      const cx = w * .45, cy = h * .5, R0 = w * .36;
      for (const s of [-1, 1]) poly(g, [cx + R0 * .6, cy + s * h * .05, w * .96, cy + s * h * .05, w * .96, cy + s * h * .16, cx + R0 * .6, cy + s * h * .22], '#c9c6bf', '#6f6c68', 3);
      g.fillStyle = '#b8b5ae'; rrect(g, w * .6, h * .75, w * .2, h * .07, h * .03); g.fill();
      g.strokeStyle = '#6f6c68'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#9d9a93'; g.fillRect(w * .5, h * .72, w * .12, h * .06);
      const dg = g.createRadialGradient(cx - R0 * .3, cy - R0 * .3, R0 * .1, cx, cy, R0); dg.addColorStop(0, '#e6e3dc'); dg.addColorStop(1, '#a29f98');
      g.fillStyle = dg; g.beginPath(); g.arc(cx, cy, R0, 0, TAU); g.fill();
      g.strokeStyle = '#6d6a66'; g.lineWidth = 3; g.stroke();
      g.strokeStyle = 'rgba(90,88,84,.55)'; g.lineWidth = 2;
      for (const k of [.32, .55, .8]) { g.beginPath(); g.arc(cx, cy, R0 * k, 0, TAU); g.stroke(); }
      for (let k = 0; k < 24; k++) { const a = k / 24 * TAU; g.beginPath(); g.moveTo(cx + Math.cos(a) * R0 * .32, cy + Math.sin(a) * R0 * .32); g.lineTo(cx + Math.cos(a) * R0 * .97, cy + Math.sin(a) * R0 * .97); g.stroke(); }
      for (let k = 0; k < 22; k++) { g.fillStyle = rnd() < .5 ? 'rgba(80,78,74,.35)' : 'rgba(150,120,90,.25)'; const a = rnd() * TAU, r = R0 * (.35 + rnd() * .55); g.fillRect(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 8 + rnd() * 26, 8 + rnd() * 20); }
      g.fillStyle = '#504d49'; g.beginPath(); g.arc(cx, cy, R0 * .2, 0, TAU); g.fill();
      g.fillStyle = '#c2bfb8'; g.beginPath(); g.arc(cx - R0 * .25, cy - R0 * .42, R0 * .14, 0, TAU); g.fill(); g.strokeStyle = '#6d6a66'; g.stroke();
      g.fillStyle = '#2a2f36'; g.beginPath(); g.arc(w * .8, h * .785, h * .03, 0, TAU); g.fill();
      g.strokeStyle = '#3b3e44'; g.lineWidth = 10; g.beginPath(); g.arc(cx, cy, R0 * .93, Math.PI * .72, Math.PI * 1.28); g.stroke();
      grime(g, w, h, 160, rnd, '#3d3a36');
    });
    // Armored walker: body and legs (top view, head to the right)
    ctx.atlas.define('walker', 480, 320, (g, w, h) => {
      const bg = g.createLinearGradient(0, h * .2, 0, h * .8); bg.addColorStop(0, '#7c8088'); bg.addColorStop(1, '#3c3f45');
      poly(g, [w * .18, h * .3, w * .3, h * .18, w * .72, h * .14, w * .8, h * .3, w * .8, h * .7, w * .72, h * .86, w * .3, h * .82, w * .18, h * .7], bg, '#2a2c30', 4);
      g.strokeStyle = 'rgba(30,32,36,.7)'; g.lineWidth = 3;
      for (let k = 1; k < 6; k++) { const x = w * (.22 + k * .09); g.beginPath(); g.moveTo(x, h * .2); g.lineTo(x, h * .8); g.stroke(); }
      g.beginPath(); g.moveTo(w * .2, h * .5); g.lineTo(w * .78, h * .5); g.stroke();
      const hg = g.createLinearGradient(0, h * .38, 0, h * .62); hg.addColorStop(0, '#8a8e96'); hg.addColorStop(1, '#45484e');
      poly(g, [w * .78, h * .36, w * .93, h * .4, w * .97, h * .5, w * .93, h * .6, w * .78, h * .64], hg, '#2a2c30', 4);
      g.fillStyle = '#c23a1c'; g.fillRect(w * .9, h * .46, w * .03, h * .08);
      g.fillStyle = '#2c2e33'; g.fillRect(w * .5, h * .4, w * .16, h * .2);
      for (const s of [-1, 1]) { g.fillStyle = '#55595f'; g.beginPath(); g.arc(w * .66, h * .5 + s * h * .32, h * .1, 0, TAU); g.fill(); g.beginPath(); g.arc(w * .3, h * .5 + s * h * .28, h * .08, 0, TAU); g.fill(); }
      grime(g, w, h, 120, rnd, '#1c1d20');
    });
    ctx.atlas.define('leg', 192, 40, (g, w, h) => {
      const lg = g.createLinearGradient(0, 0, 0, h); lg.addColorStop(0, '#80848c'); lg.addColorStop(1, '#33363b');
      g.fillStyle = lg; rrect(g, w * .04, h * .2, w * .92, h * .6, h * .3); g.fill();
      g.fillStyle = '#25272b'; g.beginPath(); g.arc(w * .5, h * .5, h * .38, 0, TAU); g.fill();
      g.beginPath(); g.arc(w * .92, h * .5, h * .45, 0, TAU); g.fill();
    });
  }

  /* ---------------- dust, bursts, bolts ---------------- */
  function puff(x, y, vx, vy, life, s0, s1, tint, h0, hv) {
    if (dust.length > 2400) return;
    const p = { x, y, vx, vy, age: 0, life, s0, s1, tint, h: h0 || 0, hv: hv || 8, v: (R() * 4) | 0 };
    dust.push(p); return p;
  }
  const RED_DUST = [0.6, 0.06, 0.035];
  function burst(x, y, big) {
    const n = big ? 22 : 12;
    for (let i = 0; i < n; i++) { const a = R() * TAU, s = rr(30, big ? 170 : 110); puff(x, y, Math.cos(a) * s, Math.sin(a) * s, rr(1.4, 3.2), rr(5, 9), rr(22, big ? 60 : 40), RED_DUST, 0, rr(6, 20)); }
    flashes.push({ x, y, age: 0, life: big ? 0.5 : 0.32, r: big ? 34 : 18, col: [1, 0.55, 0.28], I: big ? 9 : 6 });
    for (let i = 0; i < (big ? 10 : 5); i++) { const a = R() * TAU, s = rr(80, 260); sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, age: 0, life: rr(.25, .6) }); }
    stG(x, y, big ? 9 : 6, big ? 1.25 : 1.0);
  }
  function explode(f) {
    flashes.push({ x: f.x, y: f.y, age: 0, life: 0.7, r: 46, col: [1, 0.5, 0.18], I: 12 });
    for (let i = 0; i < 16; i++) { const a = R() * TAU, s = rr(60, 320); sparks.push({ x: f.x, y: f.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, age: 0, life: rr(.4, .9) }); }
    for (let i = 0; i < 14; i++) { const a = R() * TAU, s = rr(10, 60); puff(f.x, f.y, Math.cos(a) * s + Math.cos(f.ang) * 60, Math.sin(a) * s + Math.sin(f.ang) * 60, rr(2, 4), 8, rr(30, 55), [0.28, 0.25, 0.25], f.alt * 0.5, rr(-4, 4)); }
    // The wreck falls ahead and gouges the salt
    const gx = f.x + Math.cos(f.ang) * 90, gy = f.y + Math.sin(f.ang) * 90;
    setTimeout0.push({ t: 0.9, fn: () => { burst(gx, gy, true); stG(gx, gy, 14, 1.2); } });
  }
  const setTimeout0 = [];
  function fire(x, y, ang, color, speed, life, from) {
    bolts.push({ x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, age: 0, life, color, from });
  }

  /* ---------------- movers ---------------- */
  function edgeStart(pad) {
    const side = (R() * 4) | 0, W = Galaxy.ctx.W, H = Galaxy.ctx.H;
    const x = side === 0 ? -pad : side === 1 ? W + pad : rr(.1, .9) * W;
    const y = side === 2 ? -pad : side === 3 ? H + pad : rr(.1, .9) * H;
    const ang = Math.atan2(H * rr(.25, .75) - y, W * rr(.25, .75) - x);
    return { x, y, ang };
  }
  function spawnFoxes() {
    const s = edgeStart(30), n = 3 + ((R() * 4) | 0), list = [];
    for (let i = 0; i < n; i++) list.push({ x: s.x - Math.cos(s.ang) * 14 * i, y: s.y - Math.sin(s.ang) * 14 * i, ang: s.ang, ph: R() * 20, gl: R() * .1, side: i % 2 ? 1 : -1, w: rr(12, 16) });
    foxGroups.push({ list, age: 0 });
  }
  function spawnShip(ctx) {
    const s = edgeStart(160);
    freighter = { x: s.x, y: s.y, ang: s.ang, spd: 210, age: 0 };
  }
  function spawnWalker(ctx) {
    // Pick the horizontal-ish line that stays furthest from the icons
    const W = ctx.W, H = ctx.H; let best = null;
    for (let k = 0; k < 14; k++) {
      const ltr = R() < 0.5, y0 = rr(.15, .85) * H, y1 = y0 + rr(-.2, .2) * H;
      let mn = 1e9;
      for (let i = 0; i <= 24; i++) { const t = i / 24; mn = Math.min(mn, ctx.blobAt(W * t, y0 + (y1 - y0) * t)); }
      if (!best || mn > best.mn) best = { mn, ltr, y0, y1 };
    }
    const x0 = best.ltr ? -120 : W + 120, x1 = best.ltr ? W + 120 : -120;
    const ya = best.ltr ? best.y0 : best.y1, yb = best.ltr ? best.y1 : best.y0;
    const ang = Math.atan2(yb - ya, x1 - x0);
    walker = { x: x0, y: ya, ang, dist: 0, feet: null, bob: 0 };
  }
  const WALK_LEGS = [   // hip local (fwd, side), foot local (fwd, side), phase offset, leg thickness
    { hx: 18, hy: -30, fx: 44, fy: -50, ph: 0.0, th: 10 }, { hx: 18, hy: 30, fx: 44, fy: 50, ph: 0.5, th: 10 },
    { hx: -30, hy: -26, fx: -20, fy: -42, ph: 0.75, th: 8 }, { hx: -30, hy: 26, fx: -20, fy: 42, ph: 0.25, th: 8 }];
  const loc = (o, fx, fy) => [o.x + Math.cos(o.ang) * fx - Math.sin(o.ang) * fy, o.y + Math.sin(o.ang) * fx + Math.cos(o.ang) * fy];

  function updateWalker(ctx, dt) {
    const w = walker, spd = 15, stride = 40;
    w.dist += spd * dt; w.x += Math.cos(w.ang) * spd * dt; w.y += Math.sin(w.ang) * spd * dt;
    if (!w.feet) w.feet = WALK_LEGS.map(L => { const p = loc(w, L.fx, L.fy); return { x: p[0], y: p[1], sx: p[0], sy: p[1], tx: p[0], ty: p[1], sw: false }; });
    WALK_LEGS.forEach((L, i) => {
      const f = w.feet[i], u = (w.dist / stride + L.ph) % 1;
      if (u > 0.72 && !f.sw) { f.sw = true; f.sx = f.x; f.sy = f.y; const p = loc(w, L.fx + stride * 0.45, L.fy); f.tx = p[0]; f.ty = p[1]; }
      if (f.sw) {
        const k = ctx.sstep(0.72, 1, u < 0.5 ? 1 : u);
        f.x = f.sx + (f.tx - f.sx) * k; f.y = f.sy + (f.ty - f.sy) * k; f.lift = Math.sin(k * Math.PI);
        if (u < 0.5) { f.sw = false; f.x = f.tx; f.y = f.ty; f.lift = 0; stG(f.x, f.y, i < 2 ? 8 : 7, 1.2);
          for (let j = 0; j < 6; j++) { const a = R() * TAU, s = rr(10, 40); puff(f.x, f.y, Math.cos(a) * s, Math.sin(a) * s, rr(1.5, 3), 6, rr(18, 30), RED_DUST, 0, 5); } }
      } else f.lift = 0;
    });
    w.bob = Math.sin(w.dist / stride * TAU * 2) * 1.5;
    if (w.x < -260 || w.x > ctx.W + 260 || w.y < -260 || w.y > ctx.H + 260) walker = null;
  }

  function updateFight(ctx, dt) {
    const S = ctx.P.skirmish, ag = speeders.agents;
    if (!fight.on) {
      if (S > 0) fight.next -= dt;
      if (S > 0 && fight.next <= 0) {
        fight.on = true; fight.t = rr(12, 22);
        const n = 2 + Math.floor(R() * (1 + 3 * S)), s = edgeStart(120);
        for (let i = 0; i < n; i++) fighters.push({ x: s.x - Math.cos(s.ang) * 40 * i + rr(-30, 30), y: s.y - Math.sin(s.ang) * 40 * i + rr(-30, 30), ang: s.ang, spd: rr(300, 340), alt: 130, cd: rr(.3, 1), shots: 0, extend: 0, out: false, tgt: null, gx: 0, gy: 0 });
      }
    } else {
      fight.t -= dt;
      if (fight.t <= 0 || S <= 0) { fight.on = false; fight.next = ctx.mix(70, 9, S) * rr(.6, 1.4); for (const f of fighters) f.out = true; }
    }
    for (const f of fighters) {
      let want = f.ang, near = 1e9;
      if (!f.out) {
        if (!f.tgt || f.tgt.dead || !ag.includes(f.tgt)) { f.tgt = ag.length ? ag[(R() * ag.length) | 0] : null; f.gx = rr(.15, .85) * ctx.W; f.gy = rr(.15, .85) * ctx.H; }
        const tx = f.tgt ? f.tgt.x + Math.cos(f.tgt.ang) * f.tgt.spd * 0.45 : f.gx, ty = f.tgt ? f.tgt.y + Math.sin(f.tgt.ang) * f.tgt.spd * 0.45 : f.gy;
        near = Math.hypot(tx - f.x, ty - f.y);
        if (f.extend > 0) f.extend -= dt;
        else {
          want = Math.atan2(ty - f.y, tx - f.x);
          if (near < 70) { f.extend = rr(1.0, 1.8); if (!f.tgt) { f.gx = rr(.15, .85) * ctx.W; f.gy = rr(.15, .85) * ctx.H; } }
        }
        let da = Math.atan2(Math.sin(want - f.ang), Math.cos(want - f.ang));
        f.cd -= dt;
        if (f.extend <= 0 && Math.abs(da) < 0.14 && near < 470 && near > 90 && f.cd <= 0) {
          const px = -Math.sin(f.ang) * 6, py = Math.cos(f.ang) * 6, sp = 980, life = near / sp + rr(-.04, .05);
          const aim = f.ang + rr(-.05, .05);
          fire(f.x + px, f.y + py, aim, [0.25, 1, 0.35], sp, life, 'f');
          fire(f.x - px, f.y - py, aim, [0.25, 1, 0.35], sp, life, 'f');
          f.shots++; f.cd = f.shots % 3 ? 0.16 : rr(1.0, 1.8);
        }
        const turn = 2.1 * dt; f.ang += Math.max(-turn, Math.min(turn, da));
        f.alt += ((near < 520 && f.extend <= 0 ? 45 : 130) - f.alt) * Math.min(1, dt * 1.2);
      } else { f.spd = Math.min(f.spd + 120 * dt, 520); f.alt += (170 - f.alt) * Math.min(1, dt); }
      f.x += Math.cos(f.ang) * f.spd * dt; f.y += Math.sin(f.ang) * f.spd * dt;
      if (!f.out) { // gently pull back toward the screen when far outside
        const W = ctx.W, H = ctx.H;
        if (f.x < -150 || f.x > W + 150 || f.y < -150 || f.y > H + 150) { const c = Math.atan2(H / 2 - f.y, W / 2 - f.x); let d = Math.atan2(Math.sin(c - f.ang), Math.cos(c - f.ang)); f.ang += Math.sign(d) * 2.4 * dt; }
      } else if (f.x < -260 || f.x > ctx.W + 260 || f.y < -260 || f.y > ctx.H + 260) f.dead = true;
    }
    fighters = fighters.filter(f => !f.dead);
    // Speeder rear gunners answer
    if (fighters.length) for (const a of ag) {
      a.gcd = (a.gcd == null ? rr(.3, 1.2) : a.gcd) - dt;
      if (a.gcd > 0) continue;
      let best = null, bd = 400;
      for (const f of fighters) { if (f.out) continue; const d = Math.hypot(f.x - a.x, f.y - a.y); if (d < bd) { bd = d; best = f; } }
      if (best) {
        const sp = 820, tt = bd / sp, lx = best.x + Math.cos(best.ang) * best.spd * tt, ly = best.y + Math.sin(best.ang) * best.spd * tt;
        fire(a.x, a.y, Math.atan2(ly - a.y, lx - a.x) + rr(-.06, .06), [1, 0.13, 0.07], sp, 0.75, 's');
        a.gcd = rr(0.7, 1.5);
      } else a.gcd = 0.4;
    }
  }

  function updateBolts(ctx, dt) {
    for (const b of bolts) {
      b.age += dt; b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.from === 's') {
        for (const f of fighters) if (!f.dead && !f.out && Math.hypot(f.x - b.x, f.y - b.y) < 10) { b.dead = true; if (R() < 0.45) { f.dead = true; explode(f); } else flashes.push({ x: f.x, y: f.y, age: 0, life: .25, r: 12, col: [1, .6, .3], I: 6 }); break; }
        if (b.age > b.life) b.dead = true;
      } else if (b.age > b.life) {
        b.dead = true;
        let big = false;
        for (const a of speeders.agents) if (Math.hypot(a.x - b.x, a.y - b.y) < 10) { big = true; a.shake = 0.6; }
        burst(b.x, b.y, big);
      }
    }
    bolts = bolts.filter(b => !b.dead);
    fighters = fighters.filter(f => !f.dead);
  }


  /* Ski speeders: long low runs across the flats, gently weaving, steering around the red scars at the icons */
  let spId = 1;
  function spawnSpeeder(ctx, a, onScreen) {
    const W = ctx.W, H = ctx.H;
    if (onScreen) {
      for (let k = 0; k < 20; k++) { a.x = rr(.05, .95) * W; a.y = rr(.05, .95) * H; if (ctx.blobAt(a.x, a.y) > 60) break; }
      a.ang = R() * TAU;
    } else { const s = edgeStart(70); a.x = s.x; a.y = s.y; a.ang = s.ang; }
    a.base = a.ang; a.spd = rr(160, 200); a.ph = R() * 100; a.id = spId++; a.turnRate = 0;
    return a;
  }
  function updateSpeeders(ctx, dt, t, n) {
    const ag = speeders.agents;
    while (ag.length < n) ag.push(spawnSpeeder(ctx, {}, true));
    if (ag.length > n) ag.length = n;
    const W = ctx.W, H = ctx.H;
    for (const a of ag) {
      let want = a.base + 0.28 * Math.sin(t * 0.21 + a.ph) + (fight.on ? 0.55 * Math.sin(t * 1.4 + a.ph * 2) : 0);
      const look = 70 + a.spd * 0.35, lx = a.x + Math.cos(a.ang) * look, ly = a.y + Math.sin(a.ang) * look;
      const b = ctx.blobAt(lx, ly), m = 46;
      if (b < m && lx > -60 && ly > -60 && lx < W + 60 && ly < H + 60) {
        const g = ctx.gradAt(lx, ly, ctx.blobAt), ga = Math.atan2(g[1], g[0]), push = ctx.clamp(1 - b / m, 0, 1);
        let da = Math.atan2(Math.sin(ga - a.ang), Math.cos(ga - a.ang));
        const tan = a.ang + Math.sign(da || 1) * Math.PI * 0.5 * push;
        want = Math.atan2(Math.sin(tan) + Math.sin(ga) * push, Math.cos(tan) + Math.cos(ga) * push);
        a.base += Math.atan2(Math.sin(want - a.base), Math.cos(want - a.base)) * Math.min(1, dt * 0.8);
      }
      const d = Math.atan2(Math.sin(want - a.ang), Math.cos(want - a.ang)), turn = 1.3 * dt;
      const st = Math.max(-turn, Math.min(turn, d));
      a.turnRate = st / Math.max(dt, 1e-4); a.ang += st;
      const sp = a.spd * (fight.on ? 1.3 : 1);
      a.x += Math.cos(a.ang) * sp * dt; a.y += Math.sin(a.ang) * sp * dt;
      if (a.x < -110 || a.y < -110 || a.x > W + 110 || a.y > H + 110) spawnSpeeder(ctx, a, false);
    }
  }

  /* ---------------- scene ---------------- */
  function freeAll(ctx) { [salt, soil, scarA, scarB].forEach(t => t && ctx.freeTarget(t)); salt = soil = scarA = scarB = null; }

  Galaxy.register(ID, {
    name: 'Salt flats',
    post: { bloom: 0.5, threshold: 1.35, knee: 0.45, exposure: 0.92, vignette: 0.3, grain: 0.018, aberration: 0.0007, tint: [1.035, 1.0, 0.955], saturation: 1.1, bloomRadius: 1.1 },

    init(ctx) {
      R = ctx.rng(17);
      progSalt = ctx.program(SALT_FS);
      progSoil = ctx.program(SOIL_FS);
      progScar = ctx.program(SCAR_FS);
      progMain = ctx.program(MAIN_FS);
      defineSprites(ctx);
      speeders = { agents: [] };
      dust = []; glints = []; bolts = []; fighters = []; flashes = []; sparks = []; drags = []; stampsR = []; stampsG = []; foxGroups = [];
      freighter = walker = null; setTimeout0.length = 0;
      fight.on = false; fight.next = 1.5 + R() * ctx.mix(30, 4, ctx.P.skirmish);
      nextFox = rr(2, 8); nextShip = rr(30, 110); nextWalker = rr(70, 180);
      if (DBG.includes('ship')) nextShip = 0;
      if (DBG.includes('walker')) nextWalker = 0;
      if (DBG.includes('fight')) fight.next = 0;
      cacheDirty = true;
    },

    resize(ctx) {
      freeAll(ctx);
      salt = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: false });
      soil = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: false });
      const sw = Math.max(2, Math.ceil(ctx.W / 2)), sh = Math.max(2, Math.ceil(ctx.H / 2));
      scarA = ctx.makeTarget(sw, sh, { float: true });
      scarB = ctx.makeTarget(sw, sh, { float: true });
      cacheDirty = true;
    },

    layout(ctx) {
      // Moved icons drag a red furrow from their old cell to the new one
      const prev = ctx.prevIcons, cur = ctx.icons;
      if (!prev.length || !cur.length) return;
      const key = ic => Math.round(ic.x) + ',' + Math.round(ic.y);
      const ps = new Set(prev.map(key)), cs = new Set(cur.map(key));
      const gone = prev.filter(ic => !cs.has(key(ic))), added = cur.filter(ic => !ps.has(key(ic)));
      if (!added.length || gone.length > 16 || added.length > 16) return;
      const used = new Set();
      for (const a of added) {
        let bi = -1, bd = 1500;
        gone.forEach((g, i) => { if (used.has(i)) return; const d = Math.hypot(g.x - a.x, g.y - a.y); if (d < bd) { bd = d; bi = i; } });
        if (bi < 0) continue;
        used.add(bi); const g = gone[bi];
        drags.push({ x0: g.x + g.w / 2, y0: g.y + g.h / 2 - 8, x1: a.x + a.w / 2, y1: a.y + a.h / 2 - 8, t: 0, e: {} });
      }
    },

    update(ctx) {
      const dt = ctx.dt, t = ctx.t, P = ctx.P;
      flowNow = ctx.flow;
      scarRaw += ctx.rawDt; scarFlow += dt;
      for (const s of setTimeout0) { s.t -= dt; if (s.t <= 0 && !s.done) { s.done = true; s.fn(); } }
      for (let i = setTimeout0.length - 1; i >= 0; i--) if (setTimeout0[i].done) setTimeout0.splice(i, 1);

      // Icon drag furrows
      for (const d of drags) {
        d.t += ctx.rawDt;
        const k = ctx.sstep(0, 1.6, d.t);
        stampLine(d.e, d.x0 + (d.x1 - d.x0) * k, d.y0 + (d.y1 - d.y0) * k, 5, 28, 0.17, stampsR);
      }
      drags = drags.filter(d => d.t < 1.7);

      // Ski speeders
      updateSpeeders(ctx, dt, t, Math.round(7 * P.traffic));
      for (const a of speeders.agents) {
        if (a._id !== a.id) { a._id = a.id; a.e = {}; a.em = 0; a.shake = 0; a.pkx = a.pky = undefined; }
        const c = Math.cos(a.ang), s = Math.sin(a.ang);
        const kx = a.x - c * 15, ky = a.y - s * 15;
        stampLine(a.e, kx, ky, 2, 2.6, 0.55, stampsG);
        a.em += dt * 34 * (a.spd / 175);
        const px0 = a.pkx === undefined ? kx : a.pkx, py0 = a.pky === undefined ? ky : a.pky, nE = Math.floor(a.em);
        let iE = 0;
        while (a.em > 1) {
          a.em -= 1; iE++;
          const lat = rr(-1, 1), u = nE > 0 ? iE / nE : 1, ex = px0 + (kx - px0) * u, ey = py0 + (ky - py0) * u;
          const pp = puff(ex - c * rr(0, 8), ey - s * rr(0, 8), -c * rr(10, 50) - s * lat * 26, -s * rr(10, 50) + c * lat * 26, rr(2.4, 4), rr(14, 20), rr(60, 100), RED_DUST, 0, rr(8, 16));
          if (pp) pp.age = (1 - u) * dt;
        }
        a.pkx = kx; a.pky = ky;
        if (a.shake > 0) a.shake -= dt;
      }

      // Dust
      const wx = WIND[0] * 20, wy = WIND[1] * 20;
      for (const p of dust) {
        p.age += dt; const dr = Math.exp(-dt * 1.1);
        p.vx *= dr; p.vy *= dr; p.x += (p.vx + wx) * dt; p.y += (p.vy + wy) * dt; p.h += p.hv * dt;
      }
      dust = dust.filter(p => p.age < p.life);

      // Crystal foxes
      nextFox -= dt;
      if (nextFox <= 0) { spawnFoxes(); nextFox = rr(16, 38); }
      for (const gp of foxGroups) {
        gp.age += dt;
        gp.list.forEach((f, i) => {
          let want, spd;
          if (i === 0) {
            want = f.ang + (Math.sin(t * 1.7 + f.ph) * 0.9 + Math.sin(t * 0.6 + f.ph * 3) * 0.5) * dt * 2.5;
            const lx = f.x + Math.cos(f.ang) * 36, ly = f.y + Math.sin(f.ang) * 36;
            const b = ctx.blobAt(lx, ly);
            if (b < 30 && lx > 0 && ly > 0 && lx < ctx.W && ly < ctx.H) { const g = ctx.gradAt(lx, ly, ctx.blobAt); want = Math.atan2(g[1], g[0]) * 0.6 + f.ang * 0.4; const ga = Math.atan2(g[1], g[0]); let d = Math.atan2(Math.sin(ga - f.ang), Math.cos(ga - f.ang)); want = f.ang + d * 0.8; }
            spd = 80 * (0.45 + 0.9 * Math.abs(Math.sin(t * 2.6 + f.ph)));
          } else {
            const L = gp.list[i - 1];
            const bx = L.x - Math.cos(L.ang) * 13 - Math.sin(L.ang) * f.side * 5, by = L.y - Math.sin(L.ang) * 13 + Math.cos(L.ang) * f.side * 5;
            want = Math.atan2(by - f.y, bx - f.x);
            spd = Math.min(220, Math.hypot(bx - f.x, by - f.y) * 4.5);
          }
          let d = Math.atan2(Math.sin(want - f.ang), Math.cos(want - f.ang));
          f.ang += Math.max(-7 * dt, Math.min(7 * dt, d));
          f.x += Math.cos(f.ang) * spd * dt; f.y += Math.sin(f.ang) * spd * dt;
          f.gl -= dt;
          if (f.gl <= 0 && spd > 20) { f.gl = rr(0.05, 0.16); glints.push({ x: f.x - Math.cos(f.ang) * 6 + rr(-3, 3), y: f.y - Math.sin(f.ang) * 6 + rr(-3, 3), age: 0, life: rr(.6, 1.3), s: rr(1.4, 3) }); }
        });
        const L = gp.list[0];
        if (gp.age > 4 && gp.list.every(f => f.x < -60 || f.y < -60 || f.x > ctx.W + 60 || f.y > ctx.H + 60)) gp.dead = true;
        if (gp.age > 90) gp.dead = true;
      }
      foxGroups = foxGroups.filter(g => !g.dead);
      for (const g of glints) g.age += dt;
      glints = glints.filter(g => g.age < g.life);

      // Rare passes: an old freighter and a heavy walker (scaled by traffic)
      if (P.traffic > 0) {
        nextShip -= dt * (0.4 + P.traffic);
        if (nextShip <= 0 && !freighter) { spawnShip(ctx); nextShip = rr(130, 260); }
        nextWalker -= dt * (0.4 + P.traffic);
        if (nextWalker <= 0 && !walker) { spawnWalker(ctx); nextWalker = rr(260, 420); if (DBG.includes('walker')) { walker.x += Math.cos(walker.ang) * ctx.W * 0.45; walker.y += Math.sin(walker.ang) * ctx.W * 0.45; } }
      }
      if (freighter) {
        const f = freighter; f.age += dt; f.x += Math.cos(f.ang) * f.spd * dt; f.y += Math.sin(f.ang) * f.spd * dt;
        if (f.age > 2 && (f.x < -300 || f.x > ctx.W + 300 || f.y < -300 || f.y > ctx.H + 300)) freighter = null;
      }
      if (walker) updateWalker(ctx, dt);

      updateFight(ctx, dt);
      updateBolts(ctx, dt);
      for (const f of flashes) f.age += dt;
      flashes = flashes.filter(f => f.age < f.life);
      for (const s of sparks) { s.age += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 0.96; s.vy *= 0.96; }
      sparks = sparks.filter(s => s.age < s.life);
      if (stampsG.length > 80000) stampsG.splice(0, stampsG.length - 80000);
      if (stampsR.length > 30000) stampsR.splice(0, stampsR.length - 30000);
    },

    render(ctx) {
      const gl = ctx.gl, hi = ctx.P.quality >= 1 ? 1 : 0;
      if (cacheDirty && salt) {
        cacheDirty = false;
        gl.enable(gl.SCISSOR_TEST);
        const strips = 6, sh = Math.ceil(ctx.pxH / strips);
        for (let i = 0; i < strips; i++) { gl.scissor(0, i * sh, ctx.pxW, sh); ctx.fullscreen(progSalt, { uHi: hi }, {}, salt); }
        gl.disable(gl.SCISSOR_TEST);
        ctx.fullscreen(progSoil, {}, {}, soil);
      }
      // Scar accumulation, about 30 times a second
      if (scarRaw >= 1 / 32 || stampsG.length > 12000) {
        const kR = Math.exp(-scarFlow / 28), kG = Math.exp(-scarFlow / 30);
        scarRaw = 0; scarFlow = 0;
        ctx.fullscreen(progScar, { uKR: kR, uKG: kG }, { uPrev: scarA.tex }, scarB);
        const fl = ctx.flow;
        for (let i = 0; i < stampsR.length; i += 5) ctx.glowDot(stampsR[i], stampsR[i + 1], stampsR[i + 2], [1, 0, 0], stampsR[i + 3] * Math.exp(-(fl - stampsR[i + 4]) / 28), { core: 0 });
        for (let i = 0; i < stampsG.length; i += 5) ctx.glowDot(stampsG[i], stampsG[i + 1], stampsG[i + 2], [0, 1, 0], stampsG[i + 3] * Math.exp(-(fl - stampsG[i + 4]) / 30), { core: 0 });
        ctx.flush();
        stampsR.length = 0; stampsG.length = 0;
        const t = scarA; scarA = scarB; scarB = t;
        ctx.bindTarget(null);
      }
      ctx.fullscreen(progMain, { uHi: hi, uSunI: 1.42 }, { uSalt: salt.tex, uSoil: soil.tex, uScar: scarA.tex }, null);

      const t = ctx.t, sd = (k) => ({ dx: SH[0] * k, dy: SH[1] * k });
      const nearIcon = (x, y) => ctx.clamp((ctx.distAt(x, y) - 6) / 40, 0, 1);

      // Walker (on the ground, very tall: long shadows)
      if (walker) {
        const w = walker, hgt = 46;
        for (let i = 0; i < 4; i++) {   // leg shadows from foot to the hip's shadow
          const L = WALK_LEGS[i], f = w.feet[i], hp = loc(w, L.hx, L.hy), fx = f.x + SH[0] * f.lift * 6, fy = f.y + SH[1] * f.lift * 6;
          const hx = hp[0] + SH[0] * hgt, hy = hp[1] + SH[1] * hgt;
          ctx.sprite('leg', (fx + hx) / 2, (fy + hy) / 2, { w: Math.hypot(hx - fx, hy - fy) + 6, h: L.th, rot: Math.atan2(hy - fy, hx - fx), alpha: 0.45, tint: [0.04, 0.04, 0.12], flat: 1, bias: 1 });
        }
        ctx.sprite('walker', w.x + SH[0] * hgt, w.y + SH[1] * hgt, { w: 136, rot: w.ang, alpha: 0.5, tint: [0.04, 0.04, 0.12], flat: 1, bias: 1.5 });
        for (let i = 0; i < 4; i++) {
          const L = WALK_LEGS[i], f = w.feet[i], hp = loc(w, L.hx, L.hy), fx = f.x - SH[0] * f.lift * 4, fy = f.y - SH[1] * f.lift * 4;
          ctx.sprite('leg', (fx + hp[0]) / 2, (fy + hp[1]) / 2, { w: Math.hypot(hp[0] - fx, hp[1] - fy) + 8, h: L.th * 1.6, rot: Math.atan2(hp[1] - fy, hp[0] - fx), tint: [0.4, 0.4, 0.43] });
        }
        const b = loc(w, w.bob, 0);
        ctx.sprite('walker', b[0], b[1], { w: 136, rot: w.ang, tint: [0.42, 0.42, 0.45] });
        const eye = loc(w, 58 + w.bob, 0);
        ctx.glowDot(eye[0], eye[1], 3, [1, 0.25, 0.1], 3);
      }

      // Crystal foxes
      for (const gp of foxGroups) for (const f of gp.list) {
        ctx.sprite('fox', f.x, f.y, { w: f.w, rot: f.ang, tint: [1.25, 1.28, 1.36], shadow: { ...sd(2.6), alpha: 0.75, bias: 0.6, tint: [0.03, 0.05, 0.14] } });
        const tw = Math.pow(0.5 + 0.5 * Math.sin(t * 9 + f.ph * 7), 30);
        if (tw > 0.05) ctx.glowDot(f.x + Math.cos(f.ang) * 1.5, f.y + Math.sin(f.ang) * 1.5, 3, [0.75, 0.9, 1], 5 * tw, { core: 0.8 });
      }
      for (const g of glints) { const k = 1 - g.age / g.life; ctx.glowDot(g.x, g.y, g.s, [0.7, 0.86, 1], 4.5 * k * k, { core: 0.7 }); }

      // Dust shadows, then speeders, then dust
      for (const p of dust) {
        const k = p.age / p.life, s = p.s0 + (p.s1 - p.s0) * Math.sqrt(k), a = Math.pow(1 - k, 1.25) * Math.min(1, p.age * 4) * 0.9 * (0.3 + 0.7 * nearIcon(p.x, p.y));
        const hh = p.h + 2;
        ctx.sprite('dust' + p.v, p.x + SH[0] * hh * 2.2, p.y + SH[1] * hh * 2.2, { w: s * 1.15, alpha: a * 0.55, tint: [0.12, 0.05, 0.1], flat: 1, bias: 1.2 });
      }
      for (const a of speeders.agents) {
        const wob = a.shake > 0 ? Math.sin(t * 60) * 0.12 * a.shake : 0;
        const bank = ctx.clamp((a.turnRate || 0) * 0.25, -0.3, 0.3);
        ctx.sprite('speeder', a.x, a.y, { w: 44, h: 22 * (1 - Math.abs(bank) * 0.4), rot: a.ang + wob, tint: [0.42, 0.4, 0.38], shadow: { ...sd(10), alpha: 0.75, bias: 0.6, tint: [0.03, 0.04, 0.1] } });
        const c = Math.cos(a.ang), s = Math.sin(a.ang);
        const flick = 0.85 + 0.15 * Math.sin(t * 40 + a.ph);
        ctx.glowDot(a.x - c * 15, a.y - s * 15, 5, [1, 0.42, 0.16], 3.5 * flick);
        for (const sg of [-1, 1]) ctx.glowDot(a.x - c * 10.5 - s * sg * 6.4, a.y - s * 10.5 + c * sg * 6.4, 3.2, [1, 0.5, 0.2], 2.6 * flick);
      }
      for (const p of dust) {
        const k = p.age / p.life, s = p.s0 + (p.s1 - p.s0) * Math.sqrt(k), a = Math.pow(1 - k, 1.35) * Math.min(1, p.age * 4) * 1.05 * (0.3 + 0.7 * nearIcon(p.x, p.y));
        const tn = p.tint, pale = k * 0.22;
        ctx.sprite('dust' + p.v, p.x, p.y, { w: s, alpha: a, tint: [tn[0] + (0.95 - tn[0]) * pale, tn[1] + (0.42 - tn[1]) * pale, tn[2] + (0.38 - tn[2]) * pale] });
      }

      // Bolts, impacts
      for (const b of bolts) {
        const sp = Math.hypot(b.vx, b.vy), ux = b.vx / sp, uy = b.vy / sp;
        ctx.glowLine(b.x - ux * 24, b.y - uy * 24, b.x, b.y, 5, b.color, 7, { core: 1.3, coreR: 0.32 });
      }
      for (const f of flashes) { const k = 1 - f.age / f.life; ctx.glowDot(f.x, f.y, f.r * (0.5 + 0.8 * (1 - k)), f.col, f.I * k * k, { core: k }); }
      for (const s of sparks) { const k = 1 - s.age / s.life; ctx.glowLine(s.x - s.vx * 0.03, s.y - s.vy * 0.03, s.x, s.y, 1.6, [1, 0.6, 0.3], 6 * k); }

      // Fighters (high above: far shadows)
      for (const f of fighters) {
        const sz = 22 * (1 + f.alt * 0.0025);
        ctx.sprite('fighter', f.x + SH[0] * f.alt * 0.55, f.y + SH[1] * f.alt * 0.55, { w: sz, rot: f.ang, alpha: 0.42, tint: [0.03, 0.04, 0.12], flat: 1, bias: 1.5 });
        ctx.sprite('fighter', f.x, f.y, { w: sz, rot: f.ang, tint: [0.55, 0.56, 0.6] });
        ctx.glowDot(f.x - Math.cos(f.ang) * sz * 0.2, f.y - Math.sin(f.ang) * sz * 0.2, 3, [1, 0.3, 0.15], 1.5);
      }
      // Freighter (highest)
      if (freighter) {
        const f = freighter, sz = 136;
        ctx.sprite('freighter', f.x + SH[0] * 85, f.y + SH[1] * 85, { w: sz * 1.04, rot: f.ang, alpha: 0.5, tint: [0.03, 0.04, 0.12], flat: 1, bias: 2 });
        ctx.sprite('freighter', f.x, f.y, { w: sz, rot: f.ang, tint: [0.5, 0.49, 0.47] });
        const cx = f.x + Math.cos(f.ang) * (-0.05 * sz), cy = f.y + Math.sin(f.ang) * (-0.05 * sz), r = sz * 0.36 * 0.93;
        let px = null, py = null;
        for (let k = 0; k <= 6; k++) {
          const a = f.ang + Math.PI * (0.72 + 0.56 * k / 6), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          if (px !== null) ctx.glowLine(px, py, x, y, 4.5, [0.5, 0.72, 1], 5.5, { core: 1.2 });
          px = x; py = y;
        }
      }
    },

    dispose(ctx) {
      [progSalt, progSoil, progScar, progMain].forEach(p => p && ctx.gl.deleteProgram(p.p));
      freeAll(ctx);
    }
  });
})();
