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
  const SP_W = 80, FI_W = 34, FR_W = 220, WALK_W = 170, G_LIFE = 12;   // sprite sizes (CSS px), streak life (s)

  /* ---------------- GLSL ---------------- */
  // Static caches (built once per size, never during icon morphs):
  //   salt  RGBA8   lit salt crust colour / 1.6, alpha = direct sun (sparkle gate)
  //   soil  RGBA8   lit red ground, alpha = fine grain
  //   plate RGBA16F vectors (CSS px) from each pixel to the nearest and second-nearest plate seed of the crust's crack network
  //   info  RGBA8   hash of plate 1, hash of plate 2, hash of the small chip, distance to the chip's edge / 8 px
  // Per frame the main pass decides per plate (by sampling the scar mask at the plate seed) whether the plate has broken away,
  // so the red holes are bounded by the same angular cracks that are drawn in the crust.
  const SHARED = `
const vec2 SUN = normalize(vec2(-0.78, -0.62));
const vec2 WD = normalize(vec2(0.94, 0.34));
const float PS = 42.;    // crust plate size, CSS px
const float CS = 12.;     // chip size
float sq(float x) { return x * x; }
// Red mask of the live icon field: 0.5 at the crust break line, 1 deep inside
float liveMask(vec2 p) {
  float m = clamp(0.5 - iconBlob(p) / 60., 0., 1.);
  return max(m, smoothstep(30., 6., iconDist(p)));
}
vec2 plateCell(vec2 p) { return p / PS + vec2(17.3, 9.1) + fract(uSeed * .0137) * 97.; }
// Jittered voronoi: vectors (cell units) to the nearest and second-nearest seeds, and their cell ids
void vor2(vec2 g, out vec2 r1, out vec2 r2, out vec2 i1, out vec2 i2) {
  vec2 n = floor(g), f = fract(g); float d1 = 9., d2 = 9.;
  r1 = r2 = i1 = i2 = vec2(0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = vec2(i, j), o = .12 + .76 * hash22(n + c), r = c + o - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; r2 = r1; i2 = i1; d1 = d; r1 = r; i1 = n + c; }
    else if (d < d2) { d2 = d; r2 = r; i2 = n + c; }
  }
}
float edgeDist(vec2 r1, vec2 r2) { vec2 n = normalize(r2 - r1 + 1e-5); return dot((r1 + r2) * .5, n); }
`;

  const PLATE_FS = SHARED + `
uniform float uMode;
void main() {
  vec2 p = cssPos(), r1, r2, i1, i2;
  vor2(plateCell(p), r1, r2, i1, i2);
  if (uMode < .5) { outColor = vec4(r1 * PS, r2 * PS); return; }
  vec2 c1, c2, j1, j2;
  vor2(p / CS + 3.7 + fract(uSeed * .021) * 50., c1, c2, j1, j2);
  outColor = vec4(hash12(i1 * 1.37 + .5), hash12(i2 * 1.37 + .5), hash12(j1 + 11.3), clamp(edgeDist(c1, c2) * CS / 8., 0., 1.));
}`;

  // Salt crust: big polygons with raised pressure ridges, hairline plate cracks, photographic crystal relief, low sun with ray-marched shadows
  const SALT_FS = SHARED + `
uniform sampler2D uTex;
uniform float uHi;
const float EL = 0.23;
float tx(vec2 p, float s, float a) { return texture(uTex, rot2(a) * p / s).r; }
float Hs(vec2 p, bool fine, out vec4 o) {
  vec2 q = p + vec2(gfbm(p * .004 + 3.1 + uSeed, 2), gfbm(p * .004 + 7.7 - uSeed, 2)) * 30.;
  vec4 v0 = voronoi(q / 175. + uSeed * 1.7);
  float e0 = (v0.y - v0.x) * 87.;
  float ph = hash12(v0.zw + 4.);
  float rv = .45 + .9 * vnoise(p * .016 + 5.);
  float h = rv * (2.2 * exp(-sq(e0 / 4.2)) + .9 * exp(-sq(e0 / 12.)));
  h -= 1.1 * rv * exp(-sq(e0 / .8));
  h += (ph - .5) * .9 * smoothstep(10., 70., e0);
  float c1 = 0.;
  if (fine) {
    vec2 r1, r2, i1, i2; vor2(plateCell(p), r1, r2, i1, i2);
    float e1 = edgeDist(r1, r2) * PS;
    c1 = 1. - smoothstep(0., .8, e1);
    h -= .22 * c1;
    h += 1.1 * (tx(p, 560., .3) - .5) + .5 * (tx(p, 190., 1.9) - .5) + .2 * (tx(p, 61., 4.1) - .5);
  }
  vec2 r = rot2(.42) * p;
  h += 10. * gfbm(vec2(r.x * .0011, r.y * .0026) + uSeed * .13, 3);
  o = vec4(e0, c1, ph, rv);
  return h;
}
void main() {
  vec2 p = cssPos();
  vec4 o, t4;
  float h = Hs(p, true, o);
  float e = .75;
  float hx = Hs(p + vec2(e, 0.), true, t4), hy = Hs(p + vec2(0., e), true, t4);
  vec3 N = normalize(vec3(-(hx - h) / e, -(hy - h) / e, 1.));
  float h0 = Hs(p, false, t4);
  float sh = 0., t = 1.2, tanE = tan(EL);
  int NS = uHi > .5 ? 11 : 7;
  for (int i = 0; i < 11; i++) {
    if (i >= NS) break;
    float hh = Hs(p + SUN * t, false, t4);
    sh = max(sh, smoothstep(0., .5 + t * .05, hh - h0 - t * tanE));
    t *= 1.5;
  }
  vec3 L = vec3(SUN * cos(EL), sin(EL));
  float dif = clamp(dot(N, L) / sin(EL), 0., 2.4);
  float sunL = dif * (1. - sh * .85);
  // Albedo: bright fresh crystals on the ridges, slightly greyer polygon centres, photographic mottling, faint pink thin crust
  vec3 alb = vec3(.95, .945, .93);
  float mot = texture(uTex, p / 1500. + .3).b, mot2 = texture(uTex, rot2(2.2) * p / 430.).b;
  alb *= .93 + .07 * mot + .05 * mot2;
  alb *= 1. - .055 * smoothstep(12., 80., o.x) * (.6 + .8 * o.z);
  alb = mix(alb, vec3(.995, .99, .98), exp(-sq(o.x / 6.)) * .8);
  vec2 pe = vec2(-WD.y, WD.x);
  alb *= 1. + .03 * gfbm(vec2(dot(p, WD) * .004, dot(p, pe) * .03) + uSeed, 3);
  float thin = smoothstep(.62, .82, fbm(p * .0012 + 21. + uSeed, 4));
  alb = mix(alb, vec3(.95, .83, .80), thin * .22);
  float damp = smoothstep(.35, .75, fbm(p * .0007 - 13. + uSeed * .7, 3));   // large, faintly grey damp patches
  alb *= mix(vec3(1.), vec3(.9, .9, .92), damp * .55);
  alb = mix(alb, vec3(.72, .68, .67), o.y * .22);
  alb = mix(alb, vec3(.62, .44, .42), exp(-sq(o.x / .8)) * .55 * o.w);
  float ao = 1. - .22 * o.y - .18 * exp(-sq((o.x - 7.) / 4.)) * o.w;
  vec3 sunC = vec3(1., .94, .84), skyC = vec3(.70, .79, 1.);
  vec3 col = alb * (sunC * sunL * .6 + skyC * .5 * ao);
  outColor = vec4(col / 1.6, clamp(sunL / 1.4, 0., 1.));
}`;

  // Red mineral ground under the crust: photographic mottling and grain, small pebbles
  const SOIL_FS = SHARED + `
uniform sampler2D uTex;
void main() {
  vec2 p = cssPos();
  float mo = texture(uTex, p / 820. + .1).b, mo2 = texture(uTex, rot2(1.1) * p / 2300.).b;
  float gr = texture(uTex, p / 240.).g, gr2 = texture(uTex, rot2(.7) * p / 77.).g;
  vec3 c = mix(vec3(.085, .004, .007), vec3(.19, .02, .013), smoothstep(.15, .85, mo * .6 + mo2 * .4));
  c *= .88 + .2 * gr;
  c *= .95 + .1 * gr2;
  float hA = texture(uTex, (p + SUN * 1.6) / 240.).g, hB = texture(uTex, (p - SUN * 1.6) / 240.).g;
  c *= clamp(1. - (hA - hB) * 1.4, .7, 1.3);
  vec4 v = voronoi(p / 4.6 + 2.);
  float peb = smoothstep(.42, .2, v.x) * step(hash12(v.zw), .14);
  vec4 vb = voronoi((p - SUN * 1.) / 4.6 + 2.);
  float pebS = smoothstep(.42, .2, vb.x) * step(hash12(vb.zw), .14);
  c *= 1. - .35 * pebS * (1. - peb);
  c = mix(c, c * 1.5 + vec3(.05, .015, .008), peb * .6);
  outColor = vec4(c, gr2);
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
uniform sampler2D uSalt, uSoil, uPlate, uInfo, uScar, uTex;
uniform float uHi, uSunI;
vec2 uvOf(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
float mAt(vec2 p) { return texture(uScar, uvOf(p)).r; }
const vec2 VW = vec2(.25, 1.) * 5.;     // fake view tilt: crust tops shift by this, exposing broken faces on one side
void main() {
  vec2 p = cssPos(), uv = vUv;
  vec4 S = texture(uSalt, uv), G = texture(uSoil, uv), PL = texture(uPlate, uv), IN = texture(uInfo, uv);
  vec2 sc = texture(uScar, uv).rg;
  float d = iconDist(p);
  vec2 r1 = PL.xy, r2 = PL.zw;
  float m1 = mAt(p + r1), m2 = mAt(p + r2);
  float t1 = .5 + (IN.x - .5) * .26, t2 = .5 + (IN.y - .5) * .26;
  float b1 = smoothstep(t1, t1 + .004, m1), b2 = smoothstep(t2, t2 + .004, m2);
  vec2 n = normalize(r2 - r1 + 1e-5);
  float bd = max(dot((r1 + r2) * .5, n), 0.);
  float ch = IN.z, ce = IN.w * 8.;
  float near = 1. - smoothstep(1., 7., bd);
  float iconHole = smoothstep(.84, .9, sc.r);
  // Chipped crust edges and loose fragments along every broken border
  float chipMiss = (1. - b1) * b2 * step(ch, .5 * near) * smoothstep(0., .7, ce);
  float fragP = b1 * (1. - b2) * step(ch, .38 * near) * (1. - iconHole);
  float frag = fragP * smoothstep(.6, 1.2, ce);
  // A few plates that just broke lie tilted in their holes
  float h3 = fract(IN.x * 91.7);
  float tiltP = b1 * step(h3, .1) * (1. - smoothstep(.04, .16, m1 - t1)) * (1. - fragP) * (1. - iconHole);
  float tilt = tiltP * smoothstep(1.8, 2.8, bd);
  float b1a = mix(.5 * (b1 + b2), b1, smoothstep(0., .9, bd));   // antialiased plate border
  float plateHole = max(clamp(b1a + chipMiss, 0., 1.) - frag - tilt, iconHole);
  // Speeder streaks: thin crisp cuts
  float jit = texture(uTex, p / 83.).g - .5;
  float gH = smoothstep(.47, .53, sc.g + jit * .3);
  float hole = max(plateHole, gH);

  // ---- salt crust ----
  vec3 salt = S.rgb * 1.6 * uSunI;
  float mx = max(m1, m2);
  float crk = (1. - smoothstep(.25, 1.1, bd)) * smoothstep(.2, .42, mx);
  float crk2 = (1. - smoothstep(.15, .75, ce)) * smoothstep(.36, .47, mx) * near;
  float ck = max(crk, crk2 * .75);
  salt *= 1. - .5 * ck;
  salt = mix(salt, salt * vec3(.9, .62, .6), ck * .4);
  float stain = smoothstep(.12, .5, max(sc.r, sc.g * .9));
  salt = mix(salt, salt * vec3(1., .8, .76), stain * .4);
  float lit = dot(n, SUN);
  float crustEdge = (1. - b1) * b2 * (1. - chipMiss);
  float fw = max(0., -dot(VW, n));
  float face = crustEdge * (1. - smoothstep(fw - .5, fw + .15, bd)) * smoothstep(.3, .6, fw);
  float rim = crustEdge * (1. - smoothstep(fw + .2, fw + 1.7, bd));
  salt *= 1. + rim * (lit > 0. ? .3 * lit : .5 * lit);
  float k = clamp(bd / max(fw, .01), 0., 1.);
  vec3 fc = mix(vec3(.16, .03, .03), vec3(.70, .44, .40), smoothstep(.0, .35, k));
  fc = mix(fc, vec3(.86, .70, .66), smoothstep(.4, .55, k));
  fc = mix(fc, vec3(.98, .96, .93), smoothstep(.62, .8, k));
  fc *= uSunI * (.35 + 1.05 * max(lit, 0.)) * (.9 + .2 * G.a);
  salt = mix(salt, fc, face);
  // glitter
  float away = smoothstep(18., 70., d) * (1. - stain * .85);
  vec2 gq = p / 4.; vec3 hh = hash32(floor(gq) + 17.);
  float spk = 0.;
  if (hh.x < .08) {
    float dd = length(fract(gq) - (.2 + .6 * hh.yz)) * 4.;
    spk = pow(.5 + .5 * sin(uTime * (1.2 + 3. * hh.y) + hh.z * 80.), 30.) * exp(-dd * dd * 1.6);
  }
  if (uHi > .5) {
    gq = p / 40.; hh = hash32(floor(gq) + 91.);
    if (hh.x < .04) {
      vec2 r = (fract(gq) - (.2 + .6 * hh.yz)) * 40.;
      float tw = pow(.5 + .5 * sin(uTime * (.5 + .8 * hh.y) + hh.z * 50.), 16.);
      float star = exp(-dot(r, r) * .5) + .45 * (exp(-abs(r.x) * .35 - r.y * r.y * 3.) + exp(-abs(r.y) * .35 - r.x * r.x * 3.));
      spk += star * tw * 1.4;
    }
  }
  salt += vec3(1., .97, .92) * spk * 5. * S.a * away;

  // ---- red ground ----
  vec3 soil = G.rgb * uSunI;
  float inB = b1 * (1. - b2);
  float sd = bd / max(lit, .04);
  float sh = inB * step(.03, lit) * (1. - smoothstep(8., 15., sd));
  sh = max(sh, chipMiss * (.5 + .45 * (1. - smoothstep(0., 3., ce))));
  sh = max(sh, fragP * (1. - frag) * .65);
  sh = max(sh, tiltP * (1. - tilt) * .9);
  sh = max(sh, gH * (1. - smoothstep(.55, .8, sc.g + jit * .3)) * .7);
  float edgeZ = inB * exp(-bd / 7.);
  soil *= 1. - .22 * edgeZ - .4 * inB * exp(-bd / 2.);
  float crumb = step(1. - .06 * edgeZ, hash12(floor(p * .5) + 3.));
  soil = mix(soil, vec3(.92, .84, .8) * uSunI * (1. - .5 * sh), crumb * .75);
  soil *= mix(vec3(1.), vec3(.24, .18, .34), sh * .9);

  vec3 col = mix(salt, soil, hole);
  // loose fragments (some overturned, showing the stained underside) and tilted plates
  float fa = ch * 61.;
  vec3 fragC = S.rgb * 1.6 * uSunI * (.8 + .5 * dot(vec2(cos(fa), sin(fa)), SUN));
  if (fract(ch * 13.7) < .35) fragC = vec3(.55, .32, .28) * uSunI * (.75 + .5 * dot(vec2(cos(fa), sin(fa)), SUN));
  col = mix(col, fragC, frag);
  float ta = h3 * 300.;
  vec3 tc = S.rgb * 1.6 * uSunI * (.9 + .35 * dot(vec2(cos(ta), sin(ta)), SUN)) * (1. - .2 * (1. - smoothstep(2.8, 4.5, bd)));
  col = mix(col, tc, tilt);

  vec2 sv = p / uRes - .5;
  col *= 1.04 - .12 * clamp(dot(sv, -SUN) + .3, 0., 1.2);
  // ---- atmosphere: drifting cloud shadows and wind-blown salt dust (texture lookups) ----
  float cl = texture(uTex, p / 3400. + WD * uFlow * .0022 + .37).b;
  float cs = smoothstep(.55, .85, cl);
  col *= mix(vec3(1.), vec3(.78, .83, .97), cs * .38 * (1. - .5 * hole));
  vec2 pe = vec2(-WD.y, WD.x);
  vec2 q = p - WD * uFlow * 70., q2 = p - WD * uFlow * 160.;
  float d1 = texture(uTex, vec2(dot(q, WD) / 2400., dot(q, pe) / 520.)).b;
  float dust = smoothstep(.5, .85, d1) * (.6 + .5 * sin(dot(q2, WD) * .011 + d1 * 9.));
  dust *= (.35 + .65 * smoothstep(0., 60., d)) * (1. - .92 * hole);
  col = mix(col, vec3(1.12, 1.08, 1.03) * uSunI, dust * .1);
  outColor = vec4(col, 1.);
}`;

  // Grow-in whiteout, drawn over everything (sprites included)
  const HAZE_FS = `
void main() { float a = (1. - uIntro) * (1. - uIntro) * .85; outColor = vec4(vec3(1.3, 1.26, 1.2) * a, a); }`;

  /* ---------------- state ---------------- */
  let progSalt, progSoil, progScar, progMain, progPlate, progHaze, texPack = null;
  let salt = null, soil = null, plate = null, info = null, scarA = null, scarB = null, cacheDirty = true;
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
  // All vehicles point to +x. Shading is axis-symmetric (light centre line, darker flanks) so it stays plausible at any rotation.
  function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function path(g, pts) { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.closePath(); }
  function poly(g, pts, fill, stroke, lw) { path(g, pts); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); } }
  function cyl(g, y0, y1, stops) { const gr = g.createLinearGradient(0, y0, 0, y1); stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c)); return gr; }
  function line(g, x0, y0, x1, y1, col, lw) { g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
  // Weathering painted only onto pixels that are already opaque
  function weather(g, w, h, n, rnd, cols, rmax) {
    g.save(); g.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < n; i++) { g.fillStyle = cols[(rnd() * cols.length) | 0]; g.globalAlpha = 0.05 + rnd() * 0.16; g.beginPath(); g.ellipse(rnd() * w, rnd() * h, 0.6 + rnd() * rmax, 0.6 + rnd() * rmax * 0.6, rnd() * 3, 0, TAU); g.fill(); }
    g.restore();
  }
  function rim(g, w, h, cy, a) {   // darkens the flanks, lightens the spine: a rounded top-down read
    g.save(); g.globalCompositeOperation = 'source-atop';
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(cy / h * 0.7, 'rgba(0,0,0,0)'); gr.addColorStop(cy / h, `rgba(255,250,240,${a * 0.35})`);
    gr.addColorStop(1 - (1 - cy / h) * 0.3, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${a * 1.2})`);
    g.fillStyle = gr; g.fillRect(0, 0, w, h); g.restore();
  }

  function defineSprites(ctx) {
    const rnd = ctx.rng(91);
    // Ski speeder: long hull on a single ground ski, twin outboard engine pods, bubble canopy, rear gunner
    ctx.atlas.define('speeder', 384, 192, (g, w, h) => {
      const cy = h / 2;
      g.fillStyle = '#1c1918'; rrect(g, 4, cy - 5, 376, 10, 5); g.fill();
      g.fillStyle = '#5a5450'; g.fillRect(14, cy - 1.5, 356, 2);
      for (const s of [-1, 1]) poly(g, [166, cy + s * 8, 210, cy + s * 8, 220, cy + s * 42, 178, cy + s * 42], '#58514b', '#161413', 2.5);
      for (const s of [-1, 1]) {
        const y = cy + s * 46;
        g.save(); rrect(g, 108, y - 17, 156, 34, 17); g.clip();
        g.fillStyle = cyl(g, y - 17, y + 17, ['#1f1c1a', '#5f5852', '#8c8379', '#5c554e', '#1d1a18']); g.fillRect(100, y - 20, 170, 40);
        g.fillStyle = '#b4532a'; g.fillRect(208, y - 18, 13, 36);
        g.fillStyle = 'rgba(255,240,220,.25)'; g.fillRect(224, y - 18, 4, 36);
        for (const x of [140, 168, 236]) line(g, x, y - 17, x, y + 17, 'rgba(20,18,16,.6)', 1.6);
        g.fillStyle = '#3d3734'; g.fillRect(150, y - 3, 50, 6);
        g.restore();
        g.strokeStyle = '#141211'; g.lineWidth = 2.4; rrect(g, 108, y - 17, 156, 34, 17); g.stroke();
        g.fillStyle = '#0f0d0c'; g.beginPath(); g.ellipse(262, y, 6, 13.5, 0, 0, TAU); g.fill();
        g.strokeStyle = '#9d948a'; g.lineWidth = 2; g.beginPath(); g.ellipse(262, y, 6, 13.5, 0, -1.2, 1.2); g.stroke();
        g.fillStyle = '#231510'; g.beginPath(); g.ellipse(110, y, 5, 12, 0, 0, TAU); g.fill();
        g.fillStyle = '#7a3418'; g.beginPath(); g.ellipse(109, y, 3, 8, 0, 0, TAU); g.fill();
      }
      const hull = [352, cy, 318, cy - 13, 268, cy - 21, 200, cy - 25, 130, cy - 22, 84, cy - 14, 70, cy, 84, cy + 14, 130, cy + 22, 200, cy + 25, 268, cy + 21, 318, cy + 13];
      g.save(); path(g, hull); g.clip();
      g.fillStyle = cyl(g, cy - 25, cy + 25, ['#1e1a17', '#5e564e', '#9c9288', '#aba196', '#776d64', '#433c36', '#1c1815']); g.fillRect(60, cy - 30, 300, 60);
      g.fillStyle = '#b8552a'; g.fillRect(300, cy - 30, 9, 60); g.fillRect(336, cy - 30, 30, 60); g.fillRect(150, cy - 30, 6, 60);
      g.fillStyle = 'rgba(30,24,20,.55)'; g.fillRect(84, cy - 30, 26, 60);
      for (const x of [118, 176, 232, 290]) line(g, x, cy - 26, x, cy + 26, 'rgba(25,20,18,.5)', 1.4);
      line(g, 90, cy - 9, 250, cy - 9, 'rgba(25,20,18,.35)', 1.2); line(g, 90, cy + 9, 250, cy + 9, 'rgba(25,20,18,.35)', 1.2);
      for (let i = 0; i < 7; i++) { g.fillStyle = 'rgba(40,34,30,.55)'; g.fillRect(186 + i * 5, cy - 18, 2.5, 7); g.fillRect(186 + i * 5, cy + 11, 2.5, 7); }
      g.restore();
      g.strokeStyle = '#121010'; g.lineWidth = 3; path(g, hull); g.stroke();
      const cg = g.createRadialGradient(270, cy - 4, 1, 262, cy, 32);
      cg.addColorStop(0, '#c7dbe6'); cg.addColorStop(0.25, '#59748a'); cg.addColorStop(0.7, '#1c2833'); cg.addColorStop(1, '#0b1016');
      g.fillStyle = cg; g.beginPath(); g.ellipse(262, cy, 31, 12.5, 0, 0, TAU); g.fill();
      g.strokeStyle = '#2b2522'; g.lineWidth = 2.2; g.stroke();
      line(g, 262, cy - 12, 262, cy + 12, 'rgba(60,55,50,.9)', 1.5);
      g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.6; g.beginPath(); g.ellipse(266, cy - 2, 20, 6.5, 0, -2.6, -1.4); g.stroke();
      g.fillStyle = '#3a3431'; g.beginPath(); g.arc(122, cy, 12, 0, TAU); g.fill();
      g.strokeStyle = '#151312'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#6d655e'; g.beginPath(); g.arc(119, cy - 3, 5, 0, TAU); g.fill();
      line(g, 112, cy - 3, 76, cy - 3, '#141211', 3.2); line(g, 112, cy + 3, 76, cy + 3, '#141211', 3.2);
      weather(g, w, h, 140, rnd, ['#3a2a20', '#5a3a28', '#1b1715', '#8a4a2a'], 4);
    });
    // First Order style fighter seen from above: ball cockpit with two wing panels seen edge-on
    ctx.atlas.define('fighter', 256, 256, (g, w, h) => {
      const c = w / 2;
      g.fillStyle = '#3b3e44'; g.fillRect(c - 11, 44, 22, 168);
      line(g, c, 46, c, 210, 'rgba(160,168,178,.5)', 2);
      for (const s of [-1, 1]) {
        const y = c + s * 96;
        const pts = [34, y, 56, y - 13, 200, y - 13, 222, y, 200, y + 13, 56, y + 13];
        g.save(); path(g, pts); g.clip();
        g.fillStyle = cyl(g, y - 13, y + 13, ['#0d0e10', '#2a2d33', '#16181b']); g.fillRect(30, y - 15, 200, 30);
        for (let k = 0; k <= 12; k++) line(g, 56 + k * 12, y - 13, 56 + k * 12, y + 13, 'rgba(110,118,128,.55)', 1.5);
        g.restore();
        g.strokeStyle = '#9aa1ab'; g.lineWidth = 3.4; path(g, pts); g.stroke();
        g.fillStyle = '#50555d'; g.fillRect(c - 16, y - 6, 32, 12);
      }
      const bg = g.createRadialGradient(c - 8, c - 10, 3, c, c, 38);
      bg.addColorStop(0, '#e2e6ea'); bg.addColorStop(0.55, '#8a9098'); bg.addColorStop(1, '#2e3238');
      g.fillStyle = bg; g.beginPath(); g.arc(c, c, 36, 0, TAU); g.fill();
      g.strokeStyle = '#1b1d21'; g.lineWidth = 2.5; g.stroke();
      g.fillStyle = '#0a0b0d'; g.beginPath(); g.arc(c + 20, c, 17, 0, TAU); g.fill();
      g.strokeStyle = '#6e7580'; g.lineWidth = 2.2;
      for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; line(g, c + 20, c, c + 20 + Math.cos(a) * 17, c + Math.sin(a) * 17, '#6e7580', 2); }
      g.beginPath(); g.arc(c + 20, c, 17, 0, TAU); g.stroke();
      g.fillStyle = '#c03020'; g.fillRect(c - 34, c - 3, 8, 6);
    });
    // Crystal fox: white crystalline fur, a fan of crystal strands as a tail, dark legs; outlined so it reads on white salt
    ctx.atlas.define('fox', 192, 96, (g, w, h) => {
      const cy = h / 2;
      for (let i = 0; i < 14; i++) {
        const a = Math.PI + (i - 6.5) * 0.075, L = 54 + 16 * Math.sin(i * 1.7) + (i % 3) * 5, x0 = 74, y0 = cy;
        const ex = x0 + Math.cos(a) * L, ey = y0 + Math.sin(a) * L * 1.5, nx = -Math.sin(a) * 3.2, ny = Math.cos(a) * 3.2;
        poly(g, [x0 + nx, y0 + ny, ex, ey, x0 - nx, y0 - ny], i % 2 ? '#dbe8fb' : '#f6faff', 'rgba(70,98,150,.9)', 1.3);
      }
      for (const [x, s, l] of [[86, -1, 24], [86, 1, 24], [118, -1, 22], [118, 1, 22]]) { line(g, x, cy + s * 8, x + 9, cy + s * l, '#3f4658', 4.2); g.fillStyle = '#2a2f3c'; g.beginPath(); g.arc(x + 9, cy + s * l, 3.2, 0, TAU); g.fill(); }
      const bg = g.createRadialGradient(100, cy - 4, 2, 100, cy, 36);
      bg.addColorStop(0, '#ffffff'); bg.addColorStop(0.6, '#e2ebf8'); bg.addColorStop(1, '#a9bedc');
      g.fillStyle = bg; g.beginPath(); g.ellipse(100, cy, 33, 16, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(60,85,135,.9)'; g.lineWidth = 1.8; g.stroke();
      for (let i = 0; i < 8; i++) { const x = 76 + i * 6.5; for (const s of [-1, 1]) poly(g, [x, cy + s * 9, x + 4, cy + s * (19 + (i % 2) * 5), x + 7, cy + s * 10], '#eef4ff', 'rgba(70,98,150,.85)', 1.1); }
      line(g, 74, cy, 126, cy, 'rgba(120,150,200,.6)', 1.4);
      poly(g, [126, cy - 11, 140, cy - 9, 166, cy, 140, cy + 9, 126, cy + 11], '#f8fbff', 'rgba(60,85,135,.95)', 1.6);
      for (const s of [-1, 1]) poly(g, [132, cy + s * 7, 140, cy + s * 23, 146, cy + s * 8], '#e6eefc', 'rgba(60,85,135,.95)', 1.4);
      g.fillStyle = '#20242e'; g.beginPath(); g.arc(165, cy, 2.6, 0, TAU); g.fill();
      g.beginPath(); g.arc(150, cy - 4.5, 1.8, 0, TAU); g.arc(150, cy + 4.5, 1.8, 0, TAU); g.fill();
    });
    // Dust puffs (four variants), compact and soft
    for (let v = 0; v < 4; v++) ctx.atlas.define('dust' + v, 96, 96, (g, w, h) => {
      const g0 = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * .48); g0.addColorStop(0, 'rgba(255,255,255,.6)'); g0.addColorStop(.5, 'rgba(255,255,255,.3)'); g0.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = g0; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 6; i++) {
        const a = rnd() * TAU, r = rnd() * w * .16, x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r, s = w * (.13 + rnd() * .13);
        const gr = g.createRadialGradient(x, y, 0, x, y, s); gr.addColorStop(0, 'rgba(255,255,255,.25)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, s, 0, TAU); g.fill();
      }
      g.globalCompositeOperation = 'source-atop';
      const lg = g.createLinearGradient(w * .15, h * .15, w * .85, h * .85); lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(1, 'rgba(70,50,60,.4)');
      g.fillStyle = lg; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
    });
    // Old light freighter: plated saucer, forward mandibles, side cockpit tube, dish, turret, rear engine grille
    ctx.atlas.define('freighter', 768, 768, (g, w, h) => {
      const cx = w * .44, cy = h * .5, R0 = w * .355;
      for (const s of [-1, 1]) {
        const pts = [cx + R0 * .55, cy + s * 34, w * .965, cy + s * 34, w * .975, cy + s * 50, w * .965, cy + s * 112, cx + R0 * .7, cy + s * 168];
        g.save(); path(g, pts); g.clip();
        g.fillStyle = cyl(g, cy + s * 30, cy + s * 170, s < 0 ? ['#8e8a83', '#d2cec6', '#a29e96'] : ['#a29e96', '#d2cec6', '#8e8a83']); g.fillRect(cx, cy - 180, w, 360);
        for (let k = 0; k < 6; k++) line(g, cx + R0 * .7 + k * 34, cy + s * 34, cx + R0 * .7 + k * 34, cy + s * 150, 'rgba(70,68,64,.5)', 2);
        g.fillStyle = 'rgba(60,58,54,.55)'; g.fillRect(w * .82, cy + s * 60 - 10, 60, 20);
        g.restore();
        g.strokeStyle = '#4e4b47'; g.lineWidth = 3; path(g, pts); g.stroke();
      }
      g.fillStyle = '#2b2d31'; g.fillRect(cx + R0 * .5, cy - 34, w * .45, 68);
      for (let k = 0; k < 7; k++) { g.fillStyle = k % 2 ? '#3d4045' : '#25272b'; g.fillRect(cx + R0 * .62 + k * 26, cy - 30, 14, 60); }
      // cockpit tube on the starboard side
      const ty = cy + R0 * .86;
      g.save(); rrect(g, cx + R0 * .2, ty - 30, R0 * 1.0, 60, 30); g.clip();
      g.fillStyle = cyl(g, ty - 30, ty + 30, ['#7a766f', '#d8d4cc', '#e6e2da', '#8c8880']); g.fillRect(cx, ty - 40, w, 80);
      for (let k = 0; k < 5; k++) line(g, cx + R0 * .35 + k * 40, ty - 30, cx + R0 * .35 + k * 40, ty + 30, 'rgba(70,68,64,.5)', 2);
      g.restore();
      g.strokeStyle = '#4e4b47'; g.lineWidth = 3; rrect(g, cx + R0 * .2, ty - 30, R0 * 1.0, 60, 30); g.stroke();
      const kx = cx + R0 * 1.17;
      g.fillStyle = '#d6d2ca'; g.beginPath(); g.arc(kx, ty, 30, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = '#121820'; g.beginPath(); g.arc(kx + 6, ty, 19, 0, TAU); g.fill();
      for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; line(g, kx + 6, ty, kx + 6 + Math.cos(a) * 19, ty + Math.sin(a) * 19, '#8c8880', 2.5); }
      g.strokeStyle = 'rgba(190,220,240,.6)'; g.lineWidth = 2; g.beginPath(); g.arc(kx + 6, ty, 13, -2.2, -1.2); g.stroke();
      // saucer
      const dg = g.createRadialGradient(cx - R0 * .2, cy - R0 * .2, R0 * .1, cx, cy, R0);
      dg.addColorStop(0, '#e4e0d8'); dg.addColorStop(0.7, '#c4c0b8'); dg.addColorStop(1, '#8e8a83');
      g.fillStyle = dg; g.beginPath(); g.arc(cx, cy, R0, 0, TAU); g.fill();
      // plating: sectors on rings
      const rings = [.22, .36, .52, .68, .84, .97];
      for (let ri = 0; ri < rings.length - 1; ri++) {
        const n = 10 + ri * 6;
        for (let k = 0; k < n; k++) {
          if (rnd() < 0.45) continue;
          const a0 = k / n * TAU, a1 = (k + 0.5 + rnd() * 0.5) / n * TAU;
          g.fillStyle = ['rgba(170,166,158,.7)', 'rgba(205,201,193,.7)', 'rgba(140,136,128,.6)', 'rgba(120,96,80,.35)', 'rgba(225,222,215,.6)'][(rnd() * 5) | 0];
          g.beginPath(); g.arc(cx, cy, R0 * rings[ri + 1], a0, a1); g.arc(cx, cy, R0 * rings[ri], a1, a0, true); g.closePath(); g.fill();
        }
      }
      g.strokeStyle = 'rgba(80,78,74,.6)'; g.lineWidth = 2;
      for (const k of rings) { g.beginPath(); g.arc(cx, cy, R0 * k, 0, TAU); g.stroke(); }
      for (let k = 0; k < 36; k++) { const a = k / 36 * TAU; line(g, cx + Math.cos(a) * R0 * .36, cy + Math.sin(a) * R0 * .36, cx + Math.cos(a) * R0 * .97, cy + Math.sin(a) * R0 * .97, 'rgba(80,78,74,.4)', 1.5); }
      for (let k = 0; k < 70; k++) {   // greebles: vents, pipes, hatches
        const a = rnd() * TAU, r = R0 * (.25 + rnd() * .68), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, s = 6 + rnd() * 18;
        g.save(); g.translate(x, y); g.rotate(a);
        g.fillStyle = rnd() < .5 ? '#5d5a55' : '#9a968e'; g.fillRect(-s / 2, -s * .3, s, s * .6);
        if (rnd() < .5) for (let j = 0; j < 4; j++) line(g, -s / 2 + j * s / 4 + 2, -s * .3, -s / 2 + j * s / 4 + 2, s * .3, '#3a3835', 1);
        g.restore();
      }
      g.strokeStyle = '#4e4b47'; g.lineWidth = 4; g.beginPath(); g.arc(cx, cy, R0, 0, TAU); g.stroke();
      // rear engine grille
      g.strokeStyle = '#2c2f35'; g.lineWidth = 22; g.beginPath(); g.arc(cx, cy, R0 * .92, Math.PI * .72, Math.PI * 1.28); g.stroke();
      g.strokeStyle = '#4b4f57'; g.lineWidth = 2;
      for (let k = 0; k <= 30; k++) { const a = Math.PI * (.72 + .56 * k / 30); line(g, cx + Math.cos(a) * R0 * .885, cy + Math.sin(a) * R0 * .885, cx + Math.cos(a) * R0 * .955, cy + Math.sin(a) * R0 * .955, '#4b4f57', 2); }
      // central hold, turret, dish
      g.fillStyle = '#9d9991'; g.beginPath(); g.arc(cx, cy, R0 * .22, 0, TAU); g.fill(); g.strokeStyle = '#4e4b47'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#3b3d42'; g.beginPath(); g.arc(cx, cy, R0 * .12, 0, TAU); g.fill();
      line(g, cx, cy - 8, cx + R0 * .3, cy - 8, '#1e2024', 6); line(g, cx, cy + 8, cx + R0 * .3, cy + 8, '#1e2024', 6);
      g.fillStyle = '#6a6d74'; g.beginPath(); g.arc(cx - 4, cy - 4, R0 * .05, 0, TAU); g.fill();
      const dx = cx - R0 * .22, dy = cy - R0 * .5;
      const dsh = g.createRadialGradient(dx - 8, dy - 8, 2, dx, dy, R0 * .15);
      dsh.addColorStop(0, '#f0ede6'); dsh.addColorStop(1, '#9c9890');
      g.fillStyle = dsh; g.beginPath(); g.arc(dx, dy, R0 * .14, 0, TAU); g.fill(); g.strokeStyle = '#4e4b47'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#5a5751'; g.beginPath(); g.arc(dx, dy, R0 * .04, 0, TAU); g.fill();
      weather(g, w, h, 260, rnd, ['#3d3a36', '#5a4636', '#2a2826', '#7a5a40'], 10);
      g.save(); g.globalCompositeOperation = 'source-atop';
      for (let k = 0; k < 14; k++) { const a = rnd() * TAU; g.strokeStyle = 'rgba(40,36,32,.18)'; g.lineWidth = 6 + rnd() * 14; line(g, cx + Math.cos(a) * R0 * .4, cy + Math.sin(a) * R0 * .4, cx + Math.cos(a) * R0, cy + Math.sin(a) * R0, 'rgba(40,36,32,.16)', 6 + rnd() * 12); }
      g.restore();
    });
    // Heavy walker: armoured hull with a forward head and chin guns (top view)
    ctx.atlas.define('walker', 640, 400, (g, w, h) => {
      const cy = h / 2;
      for (const s of [-1, 1]) {   // side cannons
        g.fillStyle = '#2b2d31'; rrect(g, 330, cy + s * 120 - 14, 200, 28, 10); g.fill();
        line(g, 520, cy + s * 120, 600, cy + s * 120, '#1a1b1e', 9);
        g.fillStyle = '#4e5258'; rrect(g, 340, cy + s * 120 - 10, 120, 20, 8); g.fill();
      }
      const hull = [70, cy - 46, 120, cy - 96, 300, cy - 150, 430, cy - 132, 482, cy - 70, 482, cy + 70, 430, cy + 132, 300, cy + 150, 120, cy + 96, 70, cy + 46];
      g.save(); path(g, hull); g.clip();
      g.fillStyle = cyl(g, cy - 150, cy + 150, ['#24262a', '#5a5e65', '#7c8088', '#868a92', '#6a6e75', '#3e4146', '#1e2023']); g.fillRect(60, cy - 160, 430, 320);
      for (const s of [-1, 1]) { line(g, 120, cy + s * 96, 300, cy + s * 40, 'rgba(20,21,24,.6)', 2.5); line(g, 300, cy + s * 150, 300, cy + s * 40, 'rgba(20,21,24,.6)', 2.5); line(g, 430, cy + s * 132, 400, cy + s * 40, 'rgba(20,21,24,.6)', 2.5); }
      for (let k = 0; k < 6; k++) line(g, 150 + k * 52, cy - 150, 150 + k * 52, cy + 150, 'rgba(25,26,30,.3)', 1.5);
      line(g, 110, cy, 470, cy, 'rgba(25,26,30,.6)', 2.5);
      line(g, 120, cy - 64, 460, cy - 64, 'rgba(25,26,30,.45)', 2); line(g, 120, cy + 64, 460, cy + 64, 'rgba(25,26,30,.45)', 2);
      g.fillStyle = 'rgba(20,21,24,.6)'; for (let k = 0; k < 9; k++) g.fillRect(200 + k * 14, cy - 30, 7, 60);
      g.fillStyle = '#7d2a1a'; g.fillRect(430, cy - 140, 10, 280);
      g.restore();
      g.strokeStyle = '#17181b'; g.lineWidth = 4; path(g, hull); g.stroke();
      // back hump
      const hump = [150, cy - 44, 250, cy - 84, 390, cy - 76, 420, cy, 390, cy + 76, 250, cy + 84, 150, cy + 44, 130, cy];
      g.save(); path(g, hump); g.clip();
      g.fillStyle = cyl(g, cy - 84, cy + 84, ['#2c2f34', '#7d818a', '#a6aab2', '#62666e', '#26282c']); g.fillRect(120, cy - 90, 310, 180);
      for (let k = 0; k < 4; k++) line(g, 200 + k * 50, cy - 84, 200 + k * 50, cy + 84, 'rgba(25,26,30,.5)', 2);
      g.fillStyle = 'rgba(15,16,18,.7)'; for (let k = 0; k < 6; k++) g.fillRect(170 + k * 12, cy - 22, 6, 44);
      g.restore();
      g.strokeStyle = '#1b1c1f'; g.lineWidth = 3; path(g, hump); g.stroke();
      // neck and head
      g.fillStyle = '#3a3d42'; g.fillRect(460, cy - 34, 40, 68);
      const head = [490, cy - 50, 580, cy - 42, 618, cy - 16, 618, cy + 16, 580, cy + 42, 490, cy + 50];
      g.save(); path(g, head); g.clip();
      g.fillStyle = cyl(g, cy - 50, cy + 50, ['#2c2e33', '#9ca0a7', '#bfc3ca', '#7a7e86', '#2a2c30']); g.fillRect(480, cy - 60, 150, 120);
      line(g, 540, cy - 50, 540, cy + 50, 'rgba(25,26,30,.6)', 2);
      g.restore();
      g.strokeStyle = '#17181b'; g.lineWidth = 3.5; path(g, head); g.stroke();
      g.fillStyle = '#b8301a'; g.fillRect(600, cy - 10, 8, 20);
      for (const s of [-1, 1]) line(g, 560, cy + s * 30, 636, cy + s * 30, '#191a1d', 7);
      weather(g, w, h, 200, rnd, ['#1c1d20', '#3a3028', '#55493c', '#101113'], 7);
    });
    ctx.atlas.define('leg', 256, 48, (g, w, h) => {
      const cy = h / 2;
      g.save(); rrect(g, 10, cy - 13, 236, 26, 13); g.clip();
      g.fillStyle = cyl(g, cy - 13, cy + 13, ['#2a2c30', '#8e9299', '#b0b4bb', '#62666d', '#222428']); g.fillRect(0, 0, w, h);
      for (const x of [70, 90, 170, 190]) line(g, x, 0, x, h, 'rgba(20,21,24,.6)', 2);
      g.restore();
      g.strokeStyle = '#15161a'; g.lineWidth = 2.5; rrect(g, 10, cy - 13, 236, 26, 13); g.stroke();
      g.fillStyle = '#2c2e33'; g.beginPath(); g.arc(w * .5, cy, 15, 0, TAU); g.fill(); g.strokeStyle = '#6a6e75'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#1e2023'; g.beginPath(); g.arc(w - 18, cy, 17, 0, TAU); g.fill();
      g.fillStyle = '#4a4d53'; g.beginPath(); g.arc(18, cy, 13, 0, TAU); g.fill();
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
    for (let i = 0; i < n; i++) list.push({ x: s.x - Math.cos(s.ang) * 22 * i, y: s.y - Math.sin(s.ang) * 22 * i, ang: s.ang, ph: R() * 20, gl: R() * .1, side: i % 2 ? 1 : -1, w: rr(22, 27) });
    foxGroups.push({ list, age: 0 });
  }
  function spawnShip(ctx) {
    const s = edgeStart(160);
    freighter = { x: s.x, y: s.y, ang: s.ang, spd: 190, age: 0 };
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
    { hx: 26, hy: -34, fx: 62, fy: -78, ph: 0.0, th: 12 }, { hx: 26, hy: 34, fx: 62, fy: 78, ph: 0.5, th: 12 },
    { hx: -38, hy: -30, fx: -34, fy: -74, ph: 0.75, th: 11 }, { hx: -38, hy: 30, fx: -34, fy: 74, ph: 0.25, th: 11 }];
  const loc = (o, fx, fy) => [o.x + Math.cos(o.ang) * fx - Math.sin(o.ang) * fy, o.y + Math.sin(o.ang) * fx + Math.cos(o.ang) * fy];

  function updateWalker(ctx, dt) {
    const w = walker, spd = 17, stride = 50;
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
        for (const f of fighters) if (!f.dead && !f.out && Math.hypot(f.x - b.x, f.y - b.y) < 16) { b.dead = true; if (R() < 0.45) { f.dead = true; explode(f); } else flashes.push({ x: f.x, y: f.y, age: 0, life: .25, r: 12, col: [1, .6, .3], I: 6 }); break; }
        if (b.age > b.life) b.dead = true;
      } else if (b.age > b.life) {
        b.dead = true;
        let big = false;
        for (const a of speeders.agents) if (Math.hypot(a.x - b.x, a.y - b.y) < 16) { big = true; a.shake = 0.6; }
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
  function freeAll(ctx) { [salt, soil, plate, info, scarA, scarB].forEach(t => t && ctx.freeTarget(t)); salt = soil = plate = info = scarA = scarB = null; }

  Galaxy.register(ID, {
    name: 'Salt flats',
    post: { bloom: 0.5, threshold: 1.35, knee: 0.45, exposure: 0.92, vignette: 0.3, grain: 0.018, aberration: 0.0007, tint: [1.035, 1.0, 0.955], saturation: 1.1, bloomRadius: 1.1 },

    init(ctx) {
      R = ctx.rng(17);
      progSalt = ctx.program(SALT_FS);
      progSoil = ctx.program(SOIL_FS);
      progScar = ctx.program(SCAR_FS);
      progMain = ctx.program(MAIN_FS);
      progPlate = ctx.program(PLATE_FS);
      progHaze = ctx.program(HAZE_FS);
      texPack = ctx.loadTexture('assets/galaxy/st-rebel/pack.jpg', { srgb: false });
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
      // Keep the targets (and with them the scar history) when the size did not actually change; caches are always rebuilt
      const sw = Math.max(2, Math.ceil(ctx.W / 2)), sh = Math.max(2, Math.ceil(ctx.H / 2));
      if (!salt || salt.w !== ctx.pxW || salt.h !== ctx.pxH) {
        [salt, soil, plate, info].forEach(t => t && ctx.freeTarget(t));
        salt = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: false });
        soil = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: false });
        plate = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true, nearest: true });
        info = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: false, nearest: true });
      }
      if (!scarA || scarA.w !== sw || scarA.h !== sh) {
        const oldA = scarA, oldB = scarB;
        scarA = ctx.makeTarget(sw, sh, { float: true });
        scarB = ctx.makeTarget(sw, sh, { float: true });
        if (oldA) { ctx.fullscreen(progScar, { uKR: 1, uKG: 1 }, { uPrev: oldA.tex }, scarA); ctx.freeTarget(oldA); ctx.freeTarget(oldB); }   // carry the scars over
      }
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
      updateSpeeders(ctx, dt, t, Math.round(5 * P.traffic));
      for (const a of speeders.agents) {
        if (a._id !== a.id) { a._id = a.id; a.e = {}; a.em = 0; a.shake = 0; a.pkx = a.pky = undefined; }
        const c = Math.cos(a.ang), s = Math.sin(a.ang);
        const kx = a.x - c * SP_W * 0.42, ky = a.y - s * SP_W * 0.42;
        stampLine(a.e, kx, ky, 2, 2.3, 0.9, stampsG);
        a.em += dt * 15 * (a.spd / 175);
        const px0 = a.pkx === undefined ? kx : a.pkx, py0 = a.pky === undefined ? ky : a.pky, nE = Math.floor(a.em);
        let iE = 0;
        while (a.em > 1) {
          a.em -= 1; iE++;
          const lat = rr(-1, 1), u = nE > 0 ? iE / nE : 1, ex = px0 + (kx - px0) * u, ey = py0 + (ky - py0) * u;
          const pp = puff(ex - c * rr(0, 8), ey - s * rr(0, 8), -c * rr(10, 40) - s * lat * 18, -s * rr(10, 40) + c * lat * 18, rr(1.6, 2.6), rr(10, 14), rr(34, 54), RED_DUST, 0, rr(6, 12));
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
            const bx = L.x - Math.cos(L.ang) * 20 - Math.sin(L.ang) * f.side * 7, by = L.y - Math.sin(L.ang) * 20 + Math.cos(L.ang) * f.side * 7;
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
        for (let i = 0; i < strips; i++) { gl.scissor(0, i * sh, ctx.pxW, sh); ctx.fullscreen(progSalt, { uHi: hi }, { uTex: texPack }, salt); }
        gl.disable(gl.SCISSOR_TEST);
        ctx.fullscreen(progSoil, {}, { uTex: texPack }, soil);
        ctx.fullscreen(progPlate, { uMode: 0 }, {}, plate);
        ctx.fullscreen(progPlate, { uMode: 1 }, {}, info);
      }
      // Scar accumulation, about 30 times a second
      if (scarRaw >= 1 / 32 || stampsG.length > 12000) {
        const kR = Math.exp(-scarFlow / 28), kG = Math.exp(-scarFlow / G_LIFE);
        scarRaw = 0; scarFlow = 0;
        ctx.fullscreen(progScar, { uKR: kR, uKG: kG }, { uPrev: scarA.tex }, scarB);
        const fl = ctx.flow;
        for (let i = 0; i < stampsR.length; i += 5) ctx.glowDot(stampsR[i], stampsR[i + 1], stampsR[i + 2], [1, 0, 0], stampsR[i + 3] * Math.exp(-(fl - stampsR[i + 4]) / 28), { core: 0 });
        for (let i = 0; i < stampsG.length; i += 5) ctx.glowDot(stampsG[i], stampsG[i + 1], stampsG[i + 2], [0, 1, 0], stampsG[i + 3] * Math.exp(-(fl - stampsG[i + 4]) / G_LIFE), { core: 0 });
        ctx.flush();
        stampsR.length = 0; stampsG.length = 0;
        const t = scarA; scarA = scarB; scarB = t;
        ctx.bindTarget(null);
      }
      ctx.fullscreen(progMain, { uHi: hi, uSunI: 1.42 }, { uSalt: salt.tex, uSoil: soil.tex, uPlate: plate.tex, uInfo: info.tex, uScar: scarA.tex, uTex: texPack }, null);

      const t = ctx.t, sd = (k) => ({ dx: SH[0] * k, dy: SH[1] * k });
      const nearIcon = (x, y) => ctx.clamp((ctx.distAt(x, y) - 6) / 40, 0, 1);
      const SHT = [0.05, 0.045, 0.12];   // cool shadow tint (sky fill)

      // Walker (on the ground, very tall: long shadows)
      if (walker) {
        const w = walker, hgt = 60;
        for (let i = 0; i < 4; i++) {   // leg shadows from foot to the hip's shadow
          const L = WALK_LEGS[i], f = w.feet[i], hp = loc(w, L.hx, L.hy), fx = f.x + SH[0] * f.lift * 8, fy = f.y + SH[1] * f.lift * 8;
          const hx = hp[0] + SH[0] * hgt, hy = hp[1] + SH[1] * hgt;
          ctx.sprite('leg', (fx + hx) / 2, (fy + hy) / 2, { w: Math.hypot(hx - fx, hy - fy) + 8, h: L.th * 2, rot: Math.atan2(hy - fy, hx - fx), alpha: 0.65, tint: SHT, flat: 1, bias: 0.8 });
        }
        ctx.sprite('walker', w.x + SH[0] * hgt, w.y + SH[1] * hgt, { w: WALK_W, rot: w.ang, alpha: 0.7, tint: SHT, flat: 1, bias: 0.8 });
        const seg = (ax, ay, bx, by, th, o) => ctx.sprite('leg', (ax + bx) / 2, (ay + by) / 2, Object.assign({ w: Math.hypot(bx - ax, by - ay) + th * 0.8, h: th, rot: Math.atan2(by - ay, bx - ax) }, o));
        for (let i = 0; i < 4; i++) {   // two-part legs with the knee bent outward and raised (toward the viewer, so shifted against the shadow)
          const L = WALK_LEGS[i], f = w.feet[i], hp = loc(w, L.hx, L.hy), fx = f.x - SH[0] * f.lift * 5, fy = f.y - SH[1] * f.lift * 5;
          const sg = Math.sign(L.hy), kx = hp[0] + (fx - hp[0]) * 0.5 - Math.sin(w.ang) * sg * 24 - SH[0] * 12, ky = hp[1] + (fy - hp[1]) * 0.5 + Math.cos(w.ang) * sg * 24 - SH[1] * 12;
          seg(kx, ky, fx, fy, L.th * 1.9, {});
          seg(hp[0], hp[1], kx, ky, L.th * 2.5, {});
        }
        const b = loc(w, w.bob, 0);
        ctx.sprite('walker', b[0], b[1], { w: WALK_W, rot: w.ang });
        const eye = loc(w, WALK_W * 0.47 + w.bob, 0);
        ctx.glowDot(eye[0], eye[1], 3.5, [1, 0.25, 0.1], 3);
      }

      // Crystal foxes
      for (const gp of foxGroups) for (const f of gp.list) {
        ctx.sprite('fox', f.x, f.y, { w: f.w, rot: f.ang, tint: [1.05, 1.07, 1.12], shadow: { ...sd(3.2), alpha: 0.8, bias: 0.5, tint: SHT } });
        const tw = Math.pow(0.5 + 0.5 * Math.sin(t * 9 + f.ph * 7), 30);
        if (tw > 0.05) ctx.glowDot(f.x + Math.cos(f.ang) * 2, f.y + Math.sin(f.ang) * 2, 3, [0.75, 0.9, 1], 4 * tw, { core: 0.8 });
      }
      for (const g of glints) { const k = 1 - g.age / g.life; ctx.glowDot(g.x, g.y, g.s, [0.7, 0.86, 1], 4 * k * k, { core: 0.7 }); }

      // Dust shadows, then speeders, then dust
      const dA = (p, e) => { const k = p.age / p.life; return [p.s0 + (p.s1 - p.s0) * Math.sqrt(k), Math.pow(1 - k, e) * Math.min(1, p.age * 5) * (0.3 + 0.7 * nearIcon(p.x, p.y)), k]; };
      for (const p of dust) {
        const [s, a] = dA(p, 1.4), hh = p.h + 2;
        ctx.sprite('dust' + p.v, p.x + SH[0] * hh * 2.2, p.y + SH[1] * hh * 2.2, { w: s * 1.1, alpha: a * 0.4, tint: [0.12, 0.05, 0.1], flat: 1, bias: 1.2 });
      }
      for (const a of speeders.agents) {
        const wob = a.shake > 0 ? Math.sin(t * 60) * 0.12 * a.shake : 0;
        const bank = ctx.clamp((a.turnRate || 0) * 0.25, -0.3, 0.3);
        ctx.sprite('speeder', a.x, a.y, { w: SP_W, h: SP_W * 0.5 * (1 - Math.abs(bank) * 0.35), rot: a.ang + wob, shadow: { ...sd(9), alpha: 0.8, bias: 0.4, tint: SHT } });
        const c = Math.cos(a.ang), s = Math.sin(a.ang), flick = 0.85 + 0.15 * Math.sin(t * 40 + a.ph);
        for (const sg of [-1, 1]) {
          const ex = a.x - c * SP_W * 0.21 - s * sg * SP_W * 0.12, ey = a.y - s * SP_W * 0.21 + c * sg * SP_W * 0.12;
          ctx.glowLine(ex, ey, ex - c * 5, ey - s * 5, 2.6, [1, 0.45, 0.18], 3.2 * flick, { core: 0.9 });
        }
      }
      for (const p of dust) {
        const [s, a, k] = dA(p, 1.5), tn = p.tint, pale = k * 0.25;
        ctx.sprite('dust' + p.v, p.x, p.y, { w: s, alpha: a * 0.95, tint: [tn[0] + (0.95 - tn[0]) * pale, tn[1] + (0.42 - tn[1]) * pale, tn[2] + (0.38 - tn[2]) * pale] });
      }

      // Bolts, impacts
      for (const b of bolts) {
        const sp = Math.hypot(b.vx, b.vy), ux = b.vx / sp, uy = b.vy / sp;
        ctx.glowLine(b.x - ux * 26, b.y - uy * 26, b.x, b.y, 5, b.color, 7, { core: 1.3, coreR: 0.32 });
      }
      for (const f of flashes) { const k = 1 - f.age / f.life; ctx.glowDot(f.x, f.y, f.r * (0.5 + 0.8 * (1 - k)), f.col, f.I * k * k, { core: k }); }
      for (const s of sparks) { const k = 1 - s.age / s.life; ctx.glowLine(s.x - s.vx * 0.03, s.y - s.vy * 0.03, s.x, s.y, 1.6, [1, 0.6, 0.3], 6 * k); }

      // Fighters (high above: far shadows)
      for (const f of fighters) {
        const sz = FI_W * (1 + f.alt * 0.002);
        ctx.sprite('fighter', f.x + SH[0] * f.alt * 0.55, f.y + SH[1] * f.alt * 0.55, { w: FI_W, rot: f.ang, alpha: 0.45, tint: SHT, flat: 1, bias: 1.2 });
        ctx.sprite('fighter', f.x, f.y, { w: sz, rot: f.ang });
        ctx.glowDot(f.x - Math.cos(f.ang) * sz * 0.16, f.y - Math.sin(f.ang) * sz * 0.16, 3, [1, 0.3, 0.15], 1.5);
      }
      // Freighter (highest)
      if (freighter) {
        const f = freighter, sz = FR_W;
        ctx.sprite('freighter', f.x + SH[0] * 120, f.y + SH[1] * 120, { w: sz * 0.97, rot: f.ang, alpha: 0.5, tint: SHT, flat: 1, bias: 2 });
        ctx.sprite('freighter', f.x, f.y, { w: sz, rot: f.ang, tint: [0.86, 0.85, 0.83] });
        const cx = f.x + Math.cos(f.ang) * (-0.06 * sz), cy = f.y + Math.sin(f.ang) * (-0.06 * sz), r = sz * 0.355 * 0.92;
        let px = null, py = null;
        for (let k = 0; k <= 8; k++) {
          const a = f.ang + Math.PI * (0.72 + 0.56 * k / 8), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          if (px !== null) ctx.glowLine(px, py, x, y, 5, [0.5, 0.72, 1], 5, { core: 1.2 });
          px = x; py = y;
        }
      }
      // Grow-in whiteout over everything, sprites included
      if (ctx.intro < 1) {
        ctx.flush();
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        ctx.fullscreen(progHaze, {}, {}, null);
        gl.disable(gl.BLEND);
      }
    },

    dispose(ctx) {
      [progSalt, progSoil, progScar, progMain, progPlate, progHaze].forEach(p => p && ctx.gl.deleteProgram(p.p));
      freeAll(ctx);
    }
  });
})();
