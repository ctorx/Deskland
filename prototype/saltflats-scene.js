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
  const SH = [-SUN[0], -SUN[1]];             // shadows fall this way, scaled by the shadow length (updated every frame from the light)
  const WIND = [0, 0];                         // wind direction (updated every frame; designed: blowing right and slightly down)
  const WIND0 = (() => { const x = 0.94, y = 0.34, l = Math.hypot(x, y); return [x / l, y / l]; })();
  const SP_W = 80, FI_W = 34, FR_W = 220, G_LIFE = 12;   // sprite sizes (CSS px), streak life (s)
  const DEF_HOUR = 17, DEF_EL = 0.23;                     // designed look: late-afternoon sun 13 degrees up, from the upper left
  const sst = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const lum3 = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  /* ---------------- light and weather ----------------
     The salt and soil caches are baked with the designed sun colour. Every frame the main pass relights them with
     the current direct light (sun or moon) and sky light, so colour, intensity and weather never touch the caches.
     The light's direction and elevation are baked into the caches (relief shadows), so they are re-rendered when the
     direction moves noticeably (every few minutes on the real clock; at the moonrise switch both lights are ~0). */
  const L = { sunD: SUN.slice(), el: DEF_EL, shK: 1, key: '', sunC: [1, .94, .84], skyC: [.70, .79, 1], spr: [1, 1, 1], dirF: 1, glit: 1,
    soilLift: [0, 0, 0], refl: [0, 0, 0], reflC: [0, 0, 0], fogC: [1, 1, 1], wet: 0, rain: 0, snow: 0, fog: 0, cloud: 0, storm: 0, wind: 1, flash: 0, lamp: 0, night: 0, dusk: 0,
    wdx: WIND0[0], wdy: WIND0[1], woff: [0, 0], expo: 1, tint: [1.035, 1.0, 0.955], sat: 1.1 };
  const DSUN = [1, .94, .84], DSKY = [.70, .79, 1], MOON_A = -2.2;
  function computeLight(ctx) {
    // The owner chose time of day only for the salt flats: weather is ignored here (see weather: false on the scene)
    const E = Object.assign({}, ctx.env, { weatherActive: false, cloud: 0, rain: 0, snow: 0, fog: 0, storm: 0, lightning: 0 }), T = E.timeActive;
    const elev = T ? E.sunElev : 19.9;
    // Direction: the sun swings from the right (morning) through the bottom (noon) to the upper left (designed, 17:00).
    let ang, elR;
    if (!T) { ang = Math.atan2(SUN[1], SUN[0]); elR = DEF_EL; }
    else if (elev > -2) { ang = Math.atan2(SUN[1], SUN[0]) + (Math.max(4.5, Math.min(20.5, E.hour)) - DEF_HOUR) * 0.459; elR = Math.min(22, 3 + 0.513 * Math.max(elev, 1.5)) * Math.PI / 180; }
    else { ang = MOON_A; elR = 30 * Math.PI / 180; }
    // Quantize what the caches bake (about 1.7 degrees of azimuth, 1 degree of elevation)
    const qa = Math.round(ang / 0.03) * 0.03, qe = Math.round(elR / 0.0175) * 0.0175;
    const key = T ? qa.toFixed(3) + '/' + qe.toFixed(4) : 'def';
    if (key !== L.key) { L.key = key; L.sunD = T ? [Math.cos(qa), Math.sin(qa)] : SUN.slice(); L.el = T ? qe : DEF_EL; cacheDirty = true; }
    L.shK = Math.max(0.35, Math.min(2.6, Math.tan(DEF_EL) / Math.tan(elR)));
    // Colours
    const low = 1 - sst(5, 19.5, elev), up = sst(-3, 8, elev), high = sst(26, 46, elev);
    let sun = lerp3(lerp3(DSUN, [1, .985, .95], high), [1, .5, .3], low);
    sun = mul3(sun, up * (0.62 + 0.38 * sst(0, 19, elev)));
    const moonK = 0.2 * sst(-1, -9, elev), moon = mul3([.6, .74, 1], moonK);
    let sunC = [sun[0] + moon[0], sun[1] + moon[1], sun[2] + moon[2]];
    const day = sst(-9, 10, elev);
    let skyC = lerp3(lerp3(DSKY, [.66, .5, .88], low * up + (1 - up) * 0.4), [.13, .18, .38], 1 - day);
    skyC = mul3(skyC, (0.16 + 0.84 * day) * (1 - 0.3 * low * up));
    // Weather
    const cloud = Math.min(1, E.cloud + 0.25 * E.fog), storm = E.storm, rain = Math.max(E.rain, storm), snow = E.snow, fog = E.fog;
    // Overcast is kept gentle: the flats stay sunlit and graphic, the light just softens a little
    const dirW = 1 - 0.4 * cloud;
    sunC = mul3(sunC, dirW);
    const sl = lum3(skyC);
    skyC = lerp3(skyC, mul3([.97, 1, 1.05], sl), cloud * 0.35);
    skyC = mul3(skyC, (1 + 0.35 * cloud * (0.4 + 0.6 * day)) * (1 - 0.5 * storm));
    const fl = E.lightning || 0;
    skyC = [skyC[0] + 1.5 * fl, skyC[1] + 1.65 * fl, skyC[2] + 2.1 * fl];
    L.sunC = sunC; L.skyC = skyC;
    L.dirF = Math.min(1, lum3(sunC) / lum3(DSUN));
    L.glit = Math.min(1.3, L.dirF * (moonK > 0.01 ? 1 + 2.5 * sst(-1, -9, elev) : 1)) * (1 - 0.8 * fog) * (1 - 0.6 * snow);
    L.spr = [(sunC[0] * .48 + skyC[0] * .45) / (DSUN[0] * .48 + DSKY[0] * .45), (sunC[1] * .48 + skyC[1] * .45) / (DSUN[1] * .48 + DSKY[1] * .45), (sunC[2] * .48 + skyC[2] * .45) / (DSUN[2] * .48 + DSKY[2] * .45)].map(v => Math.min(1, v));   // never brighter than designed: no wash
    // The sky the water film reflects: blue by day, flushed at dusk, deep blue at night, grey under cloud, slate in storms
    // gaps between the clouds: deep sky blue by day, rose and violet at dusk, night blue, slate in storms
    let refl = lerp3([.2, .36, .78], [.75, .36, .55], low * up);
    refl = lerp3(refl, [.03, .05, .13], 1 - day);
    refl = lerp3(refl, mul3([.3, .36, .5], 0.25 + 0.75 * day), cloud * 0.45);
    refl = lerp3(refl, mul3([.13, .15, .21], 0.3 + 0.7 * day), storm);
    // the clouds themselves: white by day, gold-pink at dusk, faint grey-blue at night, dark grey in storms
    let reflC = lerp3([1.25, 1.25, 1.28], [1.35, .9, .8], low * up);
    reflC = lerp3(reflC, [.12, .15, .25], 1 - day);
    reflC = lerp3(reflC, mul3([.8, .84, .92], 0.25 + 0.75 * day), cloud * 0.5);
    reflC = lerp3(reflC, mul3([.26, .29, .36], 0.3 + 0.7 * day), storm);
    L.refl = [refl[0] + 2 * fl, refl[1] + 2.2 * fl, refl[2] + 2.8 * fl];
    L.reflC = [reflC[0] + 2.4 * fl, reflC[1] + 2.6 * fl, reflC[2] + 3.2 * fl];
    L.fogC = mul3([(sunC[0] * .5 + skyC[0] * .6), (sunC[1] * .5 + skyC[1] * .6), (sunC[2] * .5 + skyC[2] * .6)], 1.55);
    L.wet = rain; L.rain = rain; L.snow = snow; L.fog = fog; L.cloud = cloud; L.storm = storm; L.flash = fl;
    L.night = 1 - day; L.dusk = E.dusk;
    L.soilLift = [0.15 * L.night * (1 - 0.4 * storm), 0.06 * L.night, 0.09 * L.night];
    L.lamp = Math.min(1, sst(6, -4, elev) + 0.6 * storm + 0.3 * fog);
    // Wind: speed and direction drive the dust, plumes and drifting texture
    const wa = E.weatherActive ? E.windDir : Math.atan2(WIND0[1], WIND0[0]);
    const tx = Math.cos(wa), ty = Math.sin(wa), kk = Math.min(1, ctx.rawDt * 0.5);
    L.wdx += (tx - L.wdx) * kk; L.wdy += (ty - L.wdy) * kk; const wl = Math.hypot(L.wdx, L.wdy) || 1; L.wdx /= wl; L.wdy /= wl;
    L.wind = E.weatherActive ? Math.max(0.25, Math.min(3, E.wind / 0.3)) : 1;
    L.woff[0] += L.wdx * L.wind * ctx.dt; L.woff[1] += L.wdy * L.wind * ctx.dt;
    WIND[0] = L.wdx * L.wind; WIND[1] = L.wdy * L.wind;
    SH[0] = -L.sunD[0] * L.shK; SH[1] = -L.sunD[1] * L.shK;
    // Grading
    L.expo = (1 + 1.25 * L.night) * (1 + 0.08 * low * up) * (1 + 0.04 * cloud * day) * (1 - 0.12 * storm);
    L.tint = lerp3(lerp3([1.035, 1.0, 0.955], [1.08, .97, .95], low * up), [.93, .99, 1.1], L.night);
    L.sat = 1.1 + 0.12 * low * up - 0.05 * cloud * day - 0.12 * L.night;
  }

  /* ---------------- GLSL ---------------- */
  // Static caches (built once per size, never during icon morphs):
  //   salt  RGBA8   lit salt crust colour / 1.6, alpha = direct sun (sparkle gate)
  //   soil  RGBA8   lit red ground, alpha = fine grain
  //   plate RGBA16F vectors (CSS px) from each pixel to the nearest and second-nearest plate seed of the crust's crack network
  //   info  RGBA8   hash of plate 1, hash of plate 2, hash of the small chip, distance to the chip's edge / 8 px
  // Per frame the main pass decides per plate (by sampling the scar mask at the plate seed) whether the plate has broken away,
  // so the red holes are bounded by the same angular cracks that are drawn in the crust.
  const SHARED = `
uniform vec2 uSunD;      // toward the light (sun or moon), CSS px axes; baked into the salt and soil caches
#define SUN uSunD
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
uniform float uHi, uEL;
#define EL uEL
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
uniform sampler2D uSalt, uSoil, uPlate, uInfo, uScar, uTex, uWS;
uniform float uHi, uSunI;
// Light and weather (designed look: uSunC = (1,.94,.84), uSkyC = (.70,.79,1), the factors 1 and the weather amounts 0)
uniform vec3 uSunC, uSkyC, uRefl, uReflC, uFogC, uSoilLift;
uniform vec2 uWOff, uWD;
uniform float uWet, uRain, uSnow, uFog, uCloud, uWsOn, uWind, uGlit, uDirF;
vec2 uvOf(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
float mAt(vec2 p) { return texture(uScar, uvOf(p)).r; }
const vec2 VW = vec2(.25, 1.) * 5.;     // fake view tilt: crust tops shift by this, exposing broken faces on one side
const vec3 DSUN = vec3(1., .94, .84) * .6, DSKY = vec3(.70, .79, 1.) * .45;
// Rain ripple rings: one ring per grid cell, re-seeded every cycle
float ripple(vec2 p, float sc, float sp, float k) {
  vec2 g = p / sc, c = floor(g), f = fract(g);
  vec3 h = hash32(c + k);
  if (h.z > uRain) return 0.;
  float u = uTime * sp + h.x, n = floor(u), t = u - n;
  vec2 o = .3 + .4 * hash22(c + n * 7.13 + k);
  float r = length(f - o) * sc, R = t * sc * .3;
  return exp(-sq((r - R) / (.9 + t))) * sq(1. - t) * smoothstep(0., .08, t);
}
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

  // ---- light: the caches hold the designed sun and sky; relight them with the current light ----
  float ws = uWsOn > .5 ? texture(uWS, uv).r * min(1., uDirF * 1.6) : 0.;      // the walker's cast shadow
  float sL0 = S.a * 1.4, sL = sL0 * (1. - ws * .96), skS = 1. - ws * .5;   // inside the shadow: no direct light, half the sky (the hull blocks it)
  vec3 rl = (uSunC * .6 * sL + uSkyC * .45 * skS) / (DSUN * sL0 + DSKY);
  vec3 gl = (uSunC * .6 * (1. - ws * .96) + uSkyC * .45 * skS) / (DSUN + DSKY);

  // ---- salt crust ----
  vec3 salt = S.rgb * 1.6 * uSunI * rl;
  float mx = max(m1, m2);
  float crk = (1. - smoothstep(.25, 1.1, bd)) * smoothstep(.2, .42, mx);
  float crk2 = (1. - smoothstep(.15, .75, ce)) * smoothstep(.36, .47, mx) * near;
  float ck = max(crk, crk2 * .75) * (1. - .7 * uSnow);
  salt *= 1. - .5 * ck;
  salt = mix(salt, salt * vec3(.9, .62, .6), ck * .4);
  float stain = smoothstep(.12, .5, max(sc.r, sc.g * .9));
  salt = mix(salt, salt * vec3(1., .8, .76), stain * .4 * (1. - .6 * uSnow));
  float lit = dot(n, SUN);
  float crustEdge = (1. - b1) * b2 * (1. - chipMiss);
  float fw = max(0., -dot(VW, n));
  float face = crustEdge * (1. - smoothstep(fw - .5, fw + .15, bd)) * smoothstep(.3, .6, fw);
  float rim = crustEdge * (1. - smoothstep(fw + .2, fw + 1.7, bd));
  salt *= 1. + rim * (lit > 0. ? .3 * lit : .5 * lit) * uDirF;
  float k = clamp(bd / max(fw, .01), 0., 1.);
  vec3 fc = mix(vec3(.16, .03, .03), vec3(.70, .44, .40), smoothstep(.0, .35, k));
  fc = mix(fc, vec3(.86, .70, .66), smoothstep(.4, .55, k));
  fc = mix(fc, vec3(.98, .96, .93), smoothstep(.62, .8, k));
  fc *= uSunI * (.35 + 1.05 * max(lit, 0.)) * (.9 + .2 * G.a) * gl;
  salt = mix(salt, fc, face);
  // glitter (sun or moon, not under cloud or water)
  float away = smoothstep(18., 70., d) * (1. - stain * .85);
  vec2 gq = p / 4.; vec3 hh = hash32(floor(gq) + 17.);
  float spk = 0.;
  if (uGlit > .02) {
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
  }
  salt += uSunC * vec3(1., 1.032, 1.095) * spk * 5. * S.a * away * uGlit * (1. - ws);

  // ---- red ground ----
  vec3 soil = G.rgb * uSunI * (gl + uSoilLift);
  float inB = b1 * (1. - b2);
  float sd = bd / max(lit, .04);
  float sh = inB * step(.03, lit) * (1. - smoothstep(8., 15., sd));
  sh = max(sh, chipMiss * (.5 + .45 * (1. - smoothstep(0., 3., ce))));
  sh = max(sh, fragP * (1. - frag) * .65);
  sh = max(sh, tiltP * (1. - tilt) * .9);
  sh = max(sh, gH * (1. - smoothstep(.55, .8, sc.g + jit * .3)) * .7);
  sh *= .35 + .65 * uDirF;
  float edgeZ = inB * exp(-bd / 7.);
  soil *= 1. - .22 * edgeZ - .4 * inB * exp(-bd / 2.);
  float crumb = step(1. - .06 * edgeZ, hash12(floor(p * .5) + 3.));
  soil = mix(soil, vec3(.92, .84, .8) * uSunI * gl * (1. - .5 * sh), crumb * .75);
  soil *= mix(vec3(1.), vec3(.24, .18, .34), sh * .9);
  // snow: a light dusting settles into the red holes too (but stays off the icons)
  if (uSnow > .001) {
    vec3 snowC = (uSunC * .6 + uSkyC * .45) * uSunI * vec3(.97, .98, 1.02);
    float sg = texture(uTex, p / 260. + .2, 1.5).g;
    float snowL = (1. - smoothstep(.36, .62, sg + .3 - uSnow * .35)) * uSnow * smoothstep(10., 40., d);
    soil = mix(soil, snowC * (.8 + .25 * sg), snowL * .72);
    salt = mix(salt, snowC * (.97 + .06 * sg), uSnow * .35);
  }

  vec3 col = mix(salt, soil, hole);
  // loose fragments (some overturned, showing the stained underside) and tilted plates
  float fa = ch * 61.;
  vec3 fragC = S.rgb * 1.6 * uSunI * gl * (.8 + .5 * dot(vec2(cos(fa), sin(fa)), SUN) * uDirF);
  if (fract(ch * 13.7) < .35) fragC = vec3(.55, .32, .28) * uSunI * gl * (.75 + .5 * dot(vec2(cos(fa), sin(fa)), SUN) * uDirF);
  col = mix(col, fragC, frag);
  float ta = h3 * 300.;
  vec3 tc = S.rgb * 1.6 * uSunI * gl * (.9 + .35 * dot(vec2(cos(ta), sin(ta)), SUN) * uDirF) * (1. - .2 * (1. - smoothstep(2.8, 4.5, bd)));
  col = mix(col, tc, tilt);

  vec2 sv = p / uRes - .5;
  col *= 1.04 - .12 * clamp(dot(sv, -SUN) + .3, 0., 1.2) * (.3 + .7 * uDirF);
  // ---- atmosphere: drifting cloud shadows and wind-blown salt dust (texture lookups) ----
  float cl = texture(uTex, p / 3400. + uWOff * .0022 + .37).b;
  float cs = smoothstep(.66 - .08 * uCloud, .92 - .06 * uCloud, cl);   // sparse, soft cloud shadows; overcast adds only a few more
  col *= mix(vec3(1.), vec3(.88, .91, .99), cs * (.2 + .05 * uCloud) * uDirF * (1. - .6 * hole));
  // ---- rain: a thin water film turns the flats into a mirror of the sky ----
  if (uWet > .001) {
    float pd = texture(uTex, p / 1500. + .61, 3.).b;
    float film = smoothstep(-.1, .55, pd + uWet * 1.3 - .62) * smoothstep(0., .5, uWet);
    float rp = ripple(p, 30., .55, 0.);
    if (uHi > .5) rp += ripple(p + 13.7, 19., .85, 5.) * .8;
    vec2 rq = p + vec2(rp * 7.);
    float cl2 = texture(uTex, rq / 3600. + uWOff * .0012 + .11, 2.5).b;
    float cld = smoothstep(.3 - .14 * uCloud, .9 - .1 * uCloud, cl2);
    vec3 refl = mix(uRefl, uReflC, cld);   // reflected cloud banks and the sky between them
    refl *= 1. + .3 * clamp(dot(sv, SUN) * 1.4, -1., 1.);   // the sky is brighter toward the sun
    refl *= 1. + rp * .55;
    float fil = film * (1. - hole * .96);
    float gls = pow(max(0., 1. - abs(dot(sv, vec2(-SUN.y, SUN.x)) + .05 * sin(dot(sv, SUN) * 9.)) * 3.), 6.) * .25;   // soft sheen band
    vec3 under = col * mix(vec3(1.), mix(vec3(.6, .62, .7), vec3(.62, .42, .4), hole), film);   // wet salt and soaked red ground under the film
    col = mix(under, refl * (1. + gls) + col * .1, fil * .86);
    col += uReflC * rp * .3 * film * (.4 + .6 * hole);                    // rings catch the sky on the red ground too
    col *= 1. - hole * uWet * .3;                                        // soaked red ground is darker
  }
  // ---- fog: low mist banks drifting with the wind ----
  if (uFog > .001) {
    float f1 = texture(uTex, (p - uWOff * 22.) / 1300. + .13).b;
    float fa2 = uFog * clamp(.15 + 1.1 * f1 - .25, 0., 1.);
    fa2 *= mix(.12, 1., smoothstep(16., 130., d)) * (1. - .45 * hole);
    col = mix(col, uFogC, fa2 * .72);
  }
  if (uWet < .97) {
    vec2 pe = vec2(-uWD.y, uWD.x);
    vec2 q = p - uWOff * 70., q2 = p - uWOff * 160.;
    float d1 = texture(uTex, vec2(dot(q, uWD) / 2400., dot(q, pe) / 520.)).b;
    float dust = smoothstep(.5, .85, d1) * (.6 + .5 * sin(dot(q2, uWD) * .011 + d1 * 9.));
    dust *= (.35 + .65 * smoothstep(0., 60., d)) * (1. - .92 * hole) * uWind * (1. - uWet);
    col = mix(col, vec3(1.12, 1.08, 1.03) * uSunI * gl, dust * .1);
  }
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
    const plateFill = (g, pts, cols) => { g.save(); path(g, pts); g.clip(); let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); } g.fillStyle = cyl(g, y0, y1, cols); g.fillRect(x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4); g.restore(); };
    // Ski speeder, top view (+x forward), drawn at 6.4x: a slender armoured fuselage with a pointed nose, a framed bubble canopy,
    // two big outboard engine pods on swept pylons, a rear gun turret, and the long ski strut trailing below and behind the hull
    // (the red streak is cut where the ski drags). Shading is top-lit and symmetric; 'speederRim' adds the sun-side light.
    const SPD = (() => {
      const cy = 128;
      const hull = [478, cy, 446, cy - 10, 390, cy - 21, 320, cy - 27, 250, cy - 28, 170, cy - 24, 112, cy - 19, 92, cy - 11, 92, cy + 11, 112, cy + 19, 170, cy + 24, 250, cy + 28, 320, cy + 27, 390, cy + 21, 446, cy + 10];
      const pylon = s => [228, cy + s * 18, 262, cy + s * 18, 236, cy + s * 46, 196, cy + s * 46];
      const pod = s => ({ x0: 78, x1: 268, y: cy + s * 60, r: 23 });
      return { cy, hull, pylon, pod };
    })();
    const drawSpeederShapes = (g, fillHull, fillPod, fillPylon) => {
      const { cy, hull, pylon, pod } = SPD;
      for (const s of [-1, 1]) { path(g, pylon(s)); fillPylon(g, s); }
      for (const s of [-1, 1]) { const P = pod(s); rrect(g, P.x0, P.y - P.r, P.x1 - P.x0, P.r * 2, P.r); fillPod(g, s, P); }
      path(g, hull); fillHull(g);
    };
    ctx.atlas.define('speeder', 512, 256, (g, w, h) => {
      const { cy, hull, pylon, pod } = SPD;
      // ski strut and ski: a long dark boom under the hull, its worn ski blade trailing out behind
      g.fillStyle = '#16191b'; rrect(g, 8, cy - 5, 300, 10, 5); g.fill();
      g.fillStyle = '#4c4a47'; g.fillRect(14, cy - 2, 280, 2.5);
      g.fillStyle = '#26282a'; rrect(g, 6, cy - 8, 70, 16, 6); g.fill();
      g.fillStyle = '#8a8580'; g.fillRect(10, cy - 6, 60, 2);
      // swept pylons
      for (const s of [-1, 1]) {
        const pts = pylon(s);
        plateFill(g, pts, s < 0 ? ['#2c2a28', '#6a645d', '#4d4843'] : ['#4d4843', '#6a645d', '#2c2a28']);
        g.strokeStyle = '#0e0d0c'; g.lineWidth = 2.5; path(g, pts); g.stroke();
      }
      // engine pods: cylinders with intake fans at the front, hot nozzles at the back, orange bands, panel seams
      for (const s of [-1, 1]) {
        const P = pod(s), y = P.y, r = P.r;
        g.save(); rrect(g, P.x0, y - r, P.x1 - P.x0, r * 2, r); g.clip();
        g.fillStyle = cyl(g, y - r, y + r, ['#141210', '#433e39', '#7b736a', '#978e84', '#6b645c', '#36322e', '#12100e']); g.fillRect(P.x0 - 4, y - r - 4, P.x1 - P.x0 + 8, r * 2 + 8);
        g.fillStyle = '#b5521f'; g.fillRect(196, y - r, 16, r * 2); g.fillStyle = 'rgba(255,235,210,.3)'; g.fillRect(214, y - r, 3, r * 2);
        g.fillStyle = '#8f4318'; g.fillRect(120, y - r, 7, r * 2);
        for (const x of [104, 140, 170, 232]) line(g, x, y - r, x, y + r, 'rgba(18,16,14,.6)', 1.6);
        line(g, P.x0 + 10, y - r * .35, P.x1 - 12, y - r * .35, 'rgba(255,250,240,.28)', 1.4);
        g.fillStyle = 'rgba(30,26,22,.5)'; g.fillRect(146, y - 4, 40, 8);
        g.restore();
        g.strokeStyle = '#0e0d0c'; g.lineWidth = 2.6; rrect(g, P.x0, y - r, P.x1 - P.x0, r * 2, r); g.stroke();
        // intake: dark mouth with fan blades
        g.fillStyle = '#0b0a09'; g.beginPath(); g.ellipse(266, y, 6.5, r - 4, 0, 0, TAU); g.fill();
        g.strokeStyle = '#a49b90'; g.lineWidth = 1.8; g.beginPath(); g.ellipse(266, y, 6.5, r - 4, 0, -1.3, 1.3); g.stroke();
        for (let k = 0; k < 7; k++) { const a = -1.2 + k * 0.4; line(g, 266, y, 266 + Math.cos(a) * 5, y + Math.sin(a) * (r - 6), 'rgba(140,132,122,.7)', 1.1); }
        // nozzle
        g.fillStyle = '#1c120c'; g.beginPath(); g.ellipse(80, y, 6, r - 5, 0, 0, TAU); g.fill();
        g.fillStyle = '#7a3a16'; g.beginPath(); g.ellipse(79, y, 3.5, r - 10, 0, 0, TAU); g.fill();
      }
      // fuselage
      g.save(); path(g, hull); g.clip();
      g.fillStyle = cyl(g, cy - 28, cy + 28, ['#100d0a', '#3a332c', '#6f665b', '#9c9286', '#a59b8f', '#7a7166', '#3f3832', '#110e0c']); g.fillRect(80, cy - 32, 410, 64);
      g.fillStyle = '#b8562a'; g.fillRect(420, cy - 30, 10, 60); g.fillRect(440, cy - 30, 40, 60);   // nose markings
      g.fillStyle = '#9a4a22'; g.fillRect(205, cy - 30, 6, 60);
      g.fillStyle = 'rgba(28,24,20,.55)'; g.fillRect(96, cy - 32, 34, 64);                       // sooted tail
      for (const x of [140, 190, 240, 290, 400]) line(g, x, cy - 30, x, cy + 30, 'rgba(22,18,15,.55)', 1.4);
      line(g, 110, cy - 12, 300, cy - 12, 'rgba(22,18,15,.4)', 1.2); line(g, 110, cy + 12, 300, cy + 12, 'rgba(22,18,15,.4)', 1.2);
      line(g, 120, cy - 3, 440, cy - 3, 'rgba(255,250,240,.35)', 1.6);                            // spine highlight
      for (let i = 0; i < 8; i++) { g.fillStyle = 'rgba(30,26,22,.6)'; g.fillRect(222 + i * 7, cy - 22, 3, 8); g.fillRect(222 + i * 7, cy + 14, 3, 8); }   // vents
      g.fillStyle = '#6d665e'; g.fillRect(150, cy - 20, 22, 9); g.fillRect(150, cy + 11, 22, 9);
      g.restore();
      g.strokeStyle = '#0d0b0a'; g.lineWidth = 2.8; path(g, hull); g.stroke();
      // canopy: framed bubble with a sky reflection and a glint
      const cg = g.createRadialGradient(352, cy - 6, 1, 344, cy, 40);
      cg.addColorStop(0, '#d7e6ee'); cg.addColorStop(0.22, '#6f8ba0'); cg.addColorStop(0.65, '#1d2a35'); cg.addColorStop(1, '#0a1016');
      g.fillStyle = cg; g.beginPath(); g.ellipse(344, cy, 38, 15, 0, 0, TAU); g.fill();
      g.strokeStyle = '#2a2420'; g.lineWidth = 3; g.stroke();
      for (const x of [326, 360]) line(g, x, cy - 14, x, cy + 14, 'rgba(58,52,46,.95)', 2);
      line(g, 308, cy, 380, cy, 'rgba(58,52,46,.8)', 1.6);
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1.8; g.beginPath(); g.ellipse(350, cy - 3, 24, 8, 0, -2.7, -1.5); g.stroke();
      // rear gun turret with twin barrels pointing aft
      g.fillStyle = '#3a3430'; g.beginPath(); g.arc(160, cy, 13, 0, TAU); g.fill(); g.strokeStyle = '#0d0b0a'; g.lineWidth = 2.2; g.stroke();
      g.fillStyle = '#7b736b'; g.beginPath(); g.arc(157, cy - 3, 5, 0, TAU); g.fill();
      line(g, 150, cy - 4, 108, cy - 4, '#0f0d0c', 3.4); line(g, 150, cy + 4, 108, cy + 4, '#0f0d0c', 3.4);
      // nose gun
      line(g, 478, cy, 500, cy, '#14110f', 3);
      // weathering: dust, scratches, chipped paint (only on painted pixels)
      weather(g, w, h, 220, rnd, ['#3a2a20', '#5a3a28', '#1b1715', '#8a4a2a', '#cfc4b6'], 3.2);
      g.save(); g.globalCompositeOperation = 'source-atop';
      for (let k = 0; k < 40; k++) { const x = 90 + rnd() * 390, y = cy + (rnd() - .5) * 150, a = (rnd() - .5) * 0.6, L = 4 + rnd() * 16; line(g, x, y, x - Math.cos(a) * L, y - Math.sin(a) * L, rnd() < .5 ? 'rgba(235,228,218,.35)' : 'rgba(20,16,14,.4)', 1); }
      const dg = g.createLinearGradient(0, 0, 512, 0); dg.addColorStop(0, 'rgba(120,40,24,.28)'); dg.addColorStop(.5, 'rgba(120,40,24,0)'); g.fillStyle = dg; g.fillRect(0, 0, 512, 256);
      g.restore();
    });
    // Sun-side light for the speeder: brightens the flank of each part that faces +y (the renderer flips it toward the sun)
    ctx.atlas.define('speederRim', 512, 256, (g) => {
      const grad = (y0, y1) => { const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.7, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,.9)'); return gr; };
      drawSpeederShapes(g,
        g2 => { g2.fillStyle = grad(SPD.cy + 4, SPD.cy + 28); g2.fill(); },
        (g2, s, P) => { g2.fillStyle = grad(P.y + 2, P.y + P.r); g2.fill(); },
        (g2, s) => { if (s > 0) { g2.fillStyle = grad(SPD.cy + 20, SPD.cy + 46); g2.fill(); } });
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
    // Old light freighter, battered and much repaired: mismatched replacement plates, soot, carbon scoring, dirt streaks
    // running aft, open service panels with exposed machinery, an asymmetric silhouette (bent mandible, add-on boxes).
    ctx.atlas.define('freighter', 768, 768, (g, w, h) => {
      const cx = w * .44, cy = h * .5, R0 = w * .355;
      const GREYS = ['#c9c3b6', '#9c978d', '#d8d3c8', '#858077', '#b3b5b8', '#8d939b', '#c2b39a', '#76736d', '#a59a88', '#bfc2c6'];
      // mandibles: the port one is shorter, with a newer, bluer replacement tip
      for (const s of [-1, 1]) {
        const tip = s < 0 ? w * .935 : w * .968;
        const pts = [cx + R0 * .55, cy + s * 34, tip, cy + s * 34, tip + 8, cy + s * 52, tip - 4, cy + s * 110, cx + R0 * .7, cy + s * 168];
        g.save(); path(g, pts); g.clip();
        g.fillStyle = cyl(g, cy + s * 30, cy + s * 170, s < 0 ? ['#7e7a73', '#c2beb6', '#97938b'] : ['#9a968e', '#c8c4bb', '#86827b']); g.fillRect(cx, cy - 180, w, 360);
        for (let k = 0; k < 6; k++) line(g, cx + R0 * .7 + k * 34, cy + s * 34, cx + R0 * .7 + k * 34, cy + s * 150, 'rgba(60,58,54,.55)', 2);
        if (s < 0) { g.fillStyle = '#9fa6ae'; g.fillRect(tip - 70, cy - 120, 90, 90); line(g, tip - 70, cy - 120, tip - 70, cy - 30, 'rgba(40,40,44,.7)', 2.5); }
        else { g.fillStyle = '#8b857b'; g.fillRect(w * .78, cy + 70, 70, 40); }
        g.fillStyle = 'rgba(45,42,38,.6)'; g.fillRect(w * .80, cy + s * 60 - 10, 60, 20);
        for (let k = 0; k < 9; k++) { g.fillStyle = 'rgba(30,28,26,.55)'; g.beginPath(); g.arc(cx + R0 * .75 + k * 22, cy + s * 38, 1.8, 0, TAU); g.fill(); }
        g.restore();
        g.strokeStyle = '#3e3b37'; g.lineWidth = 3; path(g, pts); g.stroke();
      }
      g.fillStyle = '#26282c'; g.fillRect(cx + R0 * .5, cy - 34, w * .45, 68);
      for (let k = 0; k < 7; k++) { g.fillStyle = k % 2 ? '#3a3d42' : '#202226'; g.fillRect(cx + R0 * .62 + k * 26, cy - 30, 14, 60); }
      for (let k = 0; k < 5; k++) line(g, cx + R0 * .6 + k * 40, cy - 22 + k * 7, cx + R0 * .6 + k * 40 + 26, cy - 18 + k * 7, '#5c5146', 3);   // loose cabling in the gap
      // cockpit tube on the starboard side
      const ty = cy + R0 * .86;
      g.save(); rrect(g, cx + R0 * .2, ty - 30, R0 * 1.0, 60, 30); g.clip();
      g.fillStyle = cyl(g, ty - 30, ty + 30, ['#6e6a63', '#c9c5bc', '#d6d2c8', '#7e7a72']); g.fillRect(cx, ty - 40, w, 80);
      for (let k = 0; k < 5; k++) line(g, cx + R0 * .35 + k * 40, ty - 30, cx + R0 * .35 + k * 40, ty + 30, 'rgba(60,58,54,.55)', 2);
      g.fillStyle = '#a3a8ad'; g.fillRect(cx + R0 * .55, ty - 30, 38, 60);   // replacement section
      g.restore();
      g.strokeStyle = '#3e3b37'; g.lineWidth = 3; rrect(g, cx + R0 * .2, ty - 30, R0 * 1.0, 60, 30); g.stroke();
      const kx = cx + R0 * 1.17;
      g.fillStyle = '#c9c5bc'; g.beginPath(); g.arc(kx, ty, 30, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = '#121820'; g.beginPath(); g.arc(kx + 6, ty, 19, 0, TAU); g.fill();
      for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; line(g, kx + 6, ty, kx + 6 + Math.cos(a) * 19, ty + Math.sin(a) * 19, '#7c7870', 2.5); }
      g.strokeStyle = 'rgba(190,220,240,.55)'; g.lineWidth = 2; g.beginPath(); g.arc(kx + 6, ty, 13, -2.2, -1.2); g.stroke();
      // saucer
      const dg = g.createRadialGradient(cx - R0 * .2, cy - R0 * .2, R0 * .1, cx, cy, R0);
      dg.addColorStop(0, '#d6d2c9'); dg.addColorStop(0.7, '#b8b4ab'); dg.addColorStop(1, '#85817a');
      g.fillStyle = dg; g.beginPath(); g.arc(cx, cy, R0, 0, TAU); g.fill();
      g.save(); g.beginPath(); g.arc(cx, cy, R0 - 2, 0, TAU); g.clip();
      // plating: ring sectors in mismatched greys (replacements from other hulls), each with its own edge shading
      const rings = [.22, .36, .52, .68, .84, .97];
      for (let ri = 0; ri < rings.length - 1; ri++) {
        const n = 10 + ri * 6;
        for (let k = 0; k < n; k++) {
          if (rnd() < 0.3) continue;
          const a0 = (k + rnd() * 0.15) / n * TAU, a1 = (k + 0.55 + rnd() * 0.45) / n * TAU;
          g.fillStyle = GREYS[(rnd() * GREYS.length) | 0]; g.globalAlpha = 0.55 + rnd() * 0.45;
          g.beginPath(); g.arc(cx, cy, R0 * rings[ri + 1], a0, a1); g.arc(cx, cy, R0 * rings[ri], a1, a0, true); g.closePath(); g.fill();
          g.globalAlpha = 1; g.strokeStyle = 'rgba(50,48,44,.55)'; g.lineWidth = 1.4; g.stroke();
        }
      }
      // rectangular patch plates riveted on top, a few slightly rotated
      for (let k = 0; k < 26; k++) {
        const a = rnd() * TAU, r = R0 * (.3 + rnd() * .62), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, pw = 14 + rnd() * 34, ph = 10 + rnd() * 22;
        g.save(); g.translate(x, y); g.rotate(a + (rnd() - .5) * 0.5);
        g.fillStyle = GREYS[(rnd() * GREYS.length) | 0]; g.fillRect(-pw / 2, -ph / 2, pw, ph);
        g.strokeStyle = 'rgba(40,38,35,.75)'; g.lineWidth = 1.6; g.strokeRect(-pw / 2, -ph / 2, pw, ph);
        g.fillStyle = 'rgba(255,252,245,.25)'; g.fillRect(-pw / 2, -ph / 2, pw, 1.6);
        g.fillStyle = 'rgba(30,28,26,.7)';
        for (let j = 0; j < 4; j++) { g.beginPath(); g.arc(-pw / 2 + 3 + j * (pw - 6) / 3, -ph / 2 + 2.6, 1.1, 0, TAU); g.arc(-pw / 2 + 3 + j * (pw - 6) / 3, ph / 2 - 2.6, 1.1, 0, TAU); g.fill(); }
        g.restore();
      }
      g.strokeStyle = 'rgba(60,58,54,.6)'; g.lineWidth = 2;
      for (const k of rings) { g.beginPath(); g.arc(cx, cy, R0 * k, 0, TAU); g.stroke(); }
      for (let k = 0; k < 36; k++) { const a = k / 36 * TAU; line(g, cx + Math.cos(a) * R0 * .36, cy + Math.sin(a) * R0 * .36, cx + Math.cos(a) * R0 * .97, cy + Math.sin(a) * R0 * .97, 'rgba(60,58,54,.42)', 1.5); }
      // open service bays: dark recesses full of pipes and boxes
      for (let k = 0; k < 7; k++) {
        const a = rnd() * TAU, r = R0 * (.4 + rnd() * .45), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, bw = 26 + rnd() * 30, bh = 14 + rnd() * 14;
        g.save(); g.translate(x, y); g.rotate(a);
        g.fillStyle = '#25262a'; g.fillRect(-bw / 2, -bh / 2, bw, bh);
        for (let j = 0; j < 4; j++) line(g, -bw / 2 + 2, -bh / 2 + 3 + j * (bh - 6) / 3, bw / 2 - 2, -bh / 2 + 3 + j * (bh - 6) / 3, ['#6a645c', '#4a4f57', '#7a5a3c'][j % 3], 2.2);
        g.fillStyle = '#55575c'; g.fillRect(-bw / 4, -bh / 3, bw / 5, bh * .66);
        g.strokeStyle = '#141414'; g.lineWidth = 1.8; g.strokeRect(-bw / 2, -bh / 2, bw, bh);
        g.restore();
      }
      for (let k = 0; k < 90; k++) {   // greebles: vents, pipes, hatches, boxes
        const a = rnd() * TAU, r = R0 * (.25 + rnd() * .68), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, s = 5 + rnd() * 16;
        g.save(); g.translate(x, y); g.rotate(a + (rnd() < .3 ? Math.PI / 2 : 0));
        g.fillStyle = ['#5a5751', '#8e8a82', '#6c6f75', '#a29c90'][(rnd() * 4) | 0]; g.fillRect(-s / 2, -s * .3, s, s * .6);
        g.fillStyle = 'rgba(255,250,240,.18)'; g.fillRect(-s / 2, -s * .3, s, 1.2);
        if (rnd() < .5) for (let j = 0; j < 4; j++) line(g, -s / 2 + j * s / 4 + 2, -s * .3, -s / 2 + j * s / 4 + 2, s * .3, '#34322f', 1);
        g.restore();
      }
      for (let k = 0; k < 6; k++) {   // pipe runs
        const a0 = rnd() * TAU, a1 = a0 + (rnd() - .5) * 0.6, r = R0 * (.45 + rnd() * .4);
        g.strokeStyle = '#4c4a46'; g.lineWidth = 4; g.beginPath(); g.arc(cx, cy, r, Math.min(a0, a1), Math.max(a0, a1)); g.stroke();
        g.strokeStyle = 'rgba(220,214,200,.35)'; g.lineWidth = 1.2; g.stroke();
      }
      // grime: aft-running dirt streaks (the ship flies toward +x), soot fans behind vents, carbon scoring
      g.globalCompositeOperation = 'source-atop';
      for (let k = 0; k < 70; k++) {
        const y = cy + (rnd() - .5) * R0 * 1.9, x = cx + (rnd() - .2) * R0 * 1.2, L = 30 + rnd() * 120;
        const gr = g.createLinearGradient(x, 0, x - L, 0); gr.addColorStop(0, 'rgba(42,36,30,.45)'); gr.addColorStop(1, 'rgba(42,36,30,0)');
        g.fillStyle = gr; g.fillRect(x - L, y - 1 - rnd() * 2.5, L, 2 + rnd() * 4);
      }
      for (let k = 0; k < 16; k++) {
        const a = rnd() * TAU, r = R0 * (.2 + rnd() * .75), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, s = 14 + rnd() * 40;
        const gr = g.createRadialGradient(x, y, 0, x, y, s); gr.addColorStop(0, 'rgba(18,16,14,.7)'); gr.addColorStop(.5, 'rgba(22,20,18,.35)'); gr.addColorStop(1, 'rgba(25,22,20,0)');
        g.fillStyle = gr; g.beginPath(); g.ellipse(x - s * .3, y, s * 1.4, s * .7, 0, 0, TAU); g.fill();
      }
      for (let k = 0; k < 11; k++) {   // blaster scoring: dark ragged burns with a molten-bright pit
        const x = cx + (rnd() - .5) * R0 * 1.5, y = cy + (rnd() - .5) * R0 * 1.5, s = 7 + rnd() * 12;
        for (let j = 0; j < 9; j++) { const a = rnd() * TAU, l = s * (0.6 + rnd()); line(g, x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 'rgba(15,13,12,.5)', 1.5 + rnd() * 2.5); }
        const gr = g.createRadialGradient(x, y, 0, x, y, s); gr.addColorStop(0, 'rgba(10,9,8,.85)'); gr.addColorStop(.6, 'rgba(25,20,18,.4)'); gr.addColorStop(1, 'rgba(25,20,18,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, s, 0, TAU); g.fill();
        g.fillStyle = 'rgba(120,110,100,.6)'; g.beginPath(); g.arc(x, y, 1.6, 0, TAU); g.fill();
      }
      weather(g, w, h, 420, rnd, ['#3d3a36', '#5a4636', '#2a2826', '#7a5a40', '#6b5a48', '#1c1a18'], 11);
      g.globalCompositeOperation = 'source-over';
      g.restore();
      g.strokeStyle = '#3e3b37'; g.lineWidth = 4; g.beginPath(); g.arc(cx, cy, R0, 0, TAU); g.stroke();
      // a dented rim section and an add-on cargo box bolted to the port edge
      g.fillStyle = '#9d9a93'; g.save(); g.translate(cx + Math.cos(-2.2) * R0 * .98, cy + Math.sin(-2.2) * R0 * .98); g.rotate(-2.2 + Math.PI / 2);
      g.fillRect(-26, -10, 52, 22); g.strokeStyle = '#3a3734'; g.lineWidth = 2.4; g.strokeRect(-26, -10, 52, 22); line(g, -8, -10, -8, 12, '#3a3734', 1.6); line(g, 10, -10, 10, 12, '#3a3734', 1.6); g.restore();
      // rear engine grille, soot-blackened around it
      const sg = g.createRadialGradient(cx - R0 * .9, cy, 0, cx - R0 * .9, cy, R0 * .5); sg.addColorStop(0, 'rgba(12,11,10,.8)'); sg.addColorStop(1, 'rgba(12,11,10,0)');
      g.save(); g.beginPath(); g.arc(cx, cy, R0, 0, TAU); g.clip(); g.fillStyle = sg; g.fillRect(0, 0, w, h); g.restore();
      g.strokeStyle = '#26292e'; g.lineWidth = 22; g.beginPath(); g.arc(cx, cy, R0 * .92, Math.PI * .72, Math.PI * 1.28); g.stroke();
      for (let k = 0; k <= 30; k++) { const a = Math.PI * (.72 + .56 * k / 30); line(g, cx + Math.cos(a) * R0 * .885, cy + Math.sin(a) * R0 * .885, cx + Math.cos(a) * R0 * .955, cy + Math.sin(a) * R0 * .955, k % 7 === 3 ? '#2a2b2e' : '#474b52', 2); }
      // central hold, turret, dish (the dish is a mismatched newer unit)
      g.fillStyle = '#8f8b83'; g.beginPath(); g.arc(cx, cy, R0 * .22, 0, TAU); g.fill(); g.strokeStyle = '#3e3b37'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#34363b'; g.beginPath(); g.arc(cx, cy, R0 * .12, 0, TAU); g.fill();
      line(g, cx, cy - 8, cx + R0 * .3, cy - 8, '#1b1d21', 6); line(g, cx, cy + 8, cx + R0 * .3, cy + 8, '#1b1d21', 6);
      g.fillStyle = '#62656c'; g.beginPath(); g.arc(cx - 4, cy - 4, R0 * .05, 0, TAU); g.fill();
      const dx = cx - R0 * .22, dy = cy - R0 * .5;
      const dsh = g.createRadialGradient(dx - 8, dy - 8, 2, dx, dy, R0 * .15);
      dsh.addColorStop(0, '#e2e6ea'); dsh.addColorStop(1, '#8e959c');
      g.fillStyle = dsh; g.beginPath(); g.arc(dx, dy, R0 * .14, 0, TAU); g.fill(); g.strokeStyle = '#3e3b37'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#4e4b46'; g.beginPath(); g.arc(dx, dy, R0 * .04, 0, TAU); g.fill();
      line(g, dx + R0 * .1, dy - R0 * .02, dx + R0 * .2, dy - R0 * .1, '#2e2c29', 2.5);
    });

    // ---- Heavy assault walker parts (top view, +x forward) ----
    const WLK = ['#3c3f44', '#55595f', '#6b6f75', '#7c8086', '#4a4d52'];
    // Faceted armour: each plate is split along a ridge into a lit facet and a shaded facet, so it reads as sloping steel
    const facet = (g, pts, col, edge) => { path(g, pts); g.fillStyle = col; g.fill(); g.strokeStyle = edge || '#0b0c0d'; g.lineWidth = 3; g.stroke(); };
    const rivets = (g, x0, y0, x1, y1, n, r) => { g.fillStyle = 'rgba(8,9,10,.8)'; for (let k = 0; k <= n; k++) { const t = k / n; g.beginPath(); g.arc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, 0, TAU); g.fill(); } };
    const grime = (g, w, h, n, smax) => {
      g.save(); g.globalCompositeOperation = 'source-atop';
      for (let k = 0; k < n; k++) { const x = rnd() * w, y = rnd() * h, s = 8 + rnd() * smax; const gr = g.createRadialGradient(x, y, 0, x, y, s); gr.addColorStop(0, 'rgba(8,8,9,.55)'); gr.addColorStop(1, 'rgba(8,8,9,0)'); g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, s * 1.4, s * .8, rnd() * 3, 0, TAU); g.fill(); }
      for (let k = 0; k < n * 2; k++) { const x = 60 + rnd() * (w - 60), y = rnd() * h, L = 30 + rnd() * 110; const gr = g.createLinearGradient(x, 0, x - L, 0); gr.addColorStop(0, 'rgba(95,52,32,.32)'); gr.addColorStop(1, 'rgba(95,52,32,0)'); g.fillStyle = gr; g.fillRect(x - L, y, L, 2 + rnd() * 3); }
      g.restore();
    };
    // Hull, top view (+x forward): a broad, hunched armoured body. Massive shoulder armour over the forelegs, a raised spine,
    // the back sloping down to a rear power plant. The low gun module (whead) sits forward between the shoulders.
    ctx.atlas.define('wbody', 1024, 736, (g, w, h) => {
      const c = h / 2, M = (pts, s) => pts.map((v, i) => i % 2 ? c + (v - c) * s : v);   // mirror helper (s = -1 flips)
      const outline = [1000, c - 210, 960, c - 330, 800, c - 362, 620, c - 318, 400, c - 270, 170, c - 236, 46, c - 168, 18, c - 70, 18, c + 70, 46, c + 168, 170, c + 236, 400, c + 270, 620, c + 318, 800, c + 362, 960, c + 330, 1000, c + 210];
      facet(g, outline, '#2c2e32');
      for (const s of [-1, 1]) {
        // flank armour: lower side skirts (darker, sloping away), stepped plates
        facet(g, M([170, c - 236, 400, c - 270, 620, c - 318, 620, c - 200, 400, c - 176, 190, c - 160], s), '#3a3d42');
        facet(g, M([46, c - 168, 170, c - 236, 190, c - 160, 80, c - 112], s), '#33363a');
        for (let k = 0; k < 5; k++) line(g, 230 + k * 80, c + s * (172 + k * 6), 222 + k * 80, c + s * (246 + k * 12), 'rgba(8,9,10,.7)', 3);
        // shoulder armour over each foreleg: two layered plates, outer facet shaded, inner facet lit
        facet(g, M([1000, c - 210, 960, c - 330, 800, c - 362, 640, c - 330, 600, c - 250, 700, c - 170, 940, c - 150], s), '#4b4f55');
        facet(g, M([960, c - 330, 800, c - 362, 640, c - 330, 700, c - 280, 900, c - 286], s), '#383b40');
        facet(g, M([940, c - 228, 900, c - 286, 700, c - 280, 660, c - 236, 720, c - 196, 920, c - 186], s), '#7d8187');
        line(g, 905, c + s * 195, 725, c + s * 205, 'rgba(255,255,255,.18)', 3);
        rivets(g, 680, c + s * 318, 930, c + s * 300, 8, 4.5);
        // hip guard over each hind leg
        facet(g, M([300, c - 250, 120, c - 220, 60, c - 160, 150, c - 150, 290, c - 176], s), '#5e6268');
        facet(g, M([300, c - 250, 120, c - 220, 140, c - 196, 296, c - 212], s), '#3c3f44');
        rivets(g, 130, c + s * 186, 280, c + s * 196, 4, 4);
      }
      // the hunched back: a raised spine that peaks just behind the shoulders, faceted so the ridge catches light
      facet(g, [880, c - 150, 640, c - 176, 360, c - 150, 150, c - 118, 70, c - 70, 70, c + 70, 150, c + 118, 360, c + 150, 640, c + 176, 880, c + 150, 930, c], '#5d6167');
      facet(g, [880, c - 150, 640, c - 176, 360, c - 150, 150, c - 118, 70, c - 70, 90, c, 930, c], '#8a8e94');
      facet(g, [800, c - 92, 600, c - 110, 380, c - 94, 220, c - 64, 230, c, 820, c], '#a2a6ac');
      facet(g, [800, c + 92, 600, c + 110, 380, c + 94, 220, c + 64, 230, c, 820, c], '#6e7278');
      line(g, 230, c, 900, c, 'rgba(255,255,255,.22)', 3);
      for (const x of [330, 470, 610, 750]) { line(g, x, c - 104 - (x - 330) * 0.05, x, c + 104 + (x - 330) * 0.05, 'rgba(8,9,10,.55)', 3); }
      // vents and a command hatch on the spine
      for (let k = 0; k < 8; k++) { g.fillStyle = 'rgba(6,7,8,.85)'; g.fillRect(400 + k * 18, c - 60, 9, 40); g.fillRect(400 + k * 18, c + 20, 9, 40); }
      g.fillStyle = '#4a4d52'; path(g, [660, c - 46, 740, c - 46, 760, c, 740, c + 46, 660, c + 46, 640, c]); g.fill(); g.strokeStyle = '#0b0c0d'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#26282b'; g.beginPath(); g.arc(700, c, 20, 0, TAU); g.fill();
      g.fillStyle = '#8a2a1a'; g.fillRect(560, c - 108, 14, 216);   // faded unit band
      // rear power plant: sloping deck with exhaust grilles, sooted
      facet(g, [150, c - 118, 70, c - 70, 70, c + 70, 150, c + 118, 120, c], '#45484d');
      for (const s of [-1, 1]) { g.fillStyle = '#121315'; rrect(g, 30, c + s * 90 - 30, 84, 60, 8); g.fill(); for (let k = 0; k < 7; k++) line(g, 36 + k * 11, c + s * 90 - 24, 36 + k * 11, c + s * 90 + 24, '#4a4d52', 2.4); }
      // antenna mast
      line(g, 300, c + 120, 250, c + 200, '#121315', 5); g.fillStyle = '#6d7178'; g.fillRect(290, c + 96, 34, 28);
      g.save(); g.globalCompositeOperation = 'source-atop';
      const sg = g.createLinearGradient(18, 0, 260, 0); sg.addColorStop(0, 'rgba(8,8,8,.65)'); sg.addColorStop(1, 'rgba(8,8,8,0)'); g.fillStyle = sg; g.fillRect(0, 0, 300, h);
      for (const s of [-1, 1]) { const gr = g.createLinearGradient(0, c + s * 200, 0, c + s * 370); gr.addColorStop(0, 'rgba(125,42,24,0)'); gr.addColorStop(1, 'rgba(125,42,24,.28)'); g.fillStyle = gr; g.fillRect(0, s < 0 ? 0 : c + 200, w, c - 200); }
      g.restore();
      g.save(); g.globalCompositeOperation = 'source-atop';
      for (let k = 0; k < 140; k++) {   // plate variation, panel seams and scratches
        const x = rnd() * w, y = rnd() * h, pw = 20 + rnd() * 90, ph = 14 + rnd() * 50;
        g.fillStyle = rnd() < .5 ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.1)'; g.fillRect(x, y, pw, ph);
        g.strokeStyle = 'rgba(6,7,8,.35)'; g.lineWidth = 1.5; g.strokeRect(x, y, pw, ph);
      }
      for (let k = 0; k < 60; k++) { const x = rnd() * w, y = rnd() * h, a = rnd() * TAU, L = 6 + rnd() * 30; line(g, x, y, x + Math.cos(a) * L, y + Math.sin(a) * L, 'rgba(210,214,220,.25)', 1.2); }
      g.restore();
      grime(g, w, h, 22, 26);
      weather(g, w, h, 300, rnd, ['#151618', '#3a3028', '#6a3a28', '#0c0c0d', '#8a8e94'], 8);
      g.strokeStyle = '#08090a'; g.lineWidth = 6; path(g, outline); g.stroke();
    });
    // Gun module: low, wide and wedge-shaped, with a heavy twin cannon and a chin gun, slung forward between the shoulders
    ctx.atlas.define('whead', 512, 400, (g, w, h) => {
      const c = h / 2;
      for (const s of [-1, 1]) {
        const y = c + s * 78;
        g.fillStyle = cyl(g, y - 22, y + 22, ['#111214', '#4d5157', '#6d7177', '#232528']); rrect(g, 230, y - 22, 190, 44, 8); g.fill();
        g.strokeStyle = '#0a0b0c'; g.lineWidth = 3; rrect(g, 230, y - 22, 190, 44, 8); g.stroke();
        g.fillStyle = cyl(g, y - 12, y + 12, ['#0e0f10', '#55595f', '#17181a']); g.fillRect(410, y - 12, 96, 24);
        g.fillStyle = '#060607'; g.beginPath(); g.arc(502, y, 9, 0, TAU); g.fill();
        for (let k = 0; k < 4; k++) line(g, 262 + k * 36, y - 22, 262 + k * 36, y + 22, 'rgba(8,8,10,.65)', 2.5);
      }
      const hd = [30, c - 150, 250, c - 150, 360, c - 92, 390, c - 30, 390, c + 30, 360, c + 92, 250, c + 150, 30, c + 150, 6, c];
      facet(g, hd, '#3d4045');
      facet(g, [30, c - 150, 250, c - 150, 360, c - 92, 300, c - 70, 70, c - 92], '#62666c');
      facet(g, [70, c - 92, 300, c - 70, 330, c, 70, c], '#a0a4aa');
      facet(g, [70, c + 92, 300, c + 70, 330, c, 70, c], '#6a6e74');
      facet(g, [30, c + 150, 250, c + 150, 360, c + 92, 300, c + 70, 70, c + 92], '#45484d');
      g.fillStyle = '#0d0f12'; path(g, [330, c - 50, 380, c - 26, 380, c + 26, 330, c + 50]); g.fill();   // viewport band
      g.fillStyle = 'rgba(170,60,40,.6)'; g.fillRect(352, c - 34, 8, 68);
      for (let k = 0; k < 6; k++) { g.fillStyle = 'rgba(6,7,8,.8)'; g.fillRect(110 + k * 16, c - 34, 8, 26); }
      rivets(g, 60, c - 128, 240, c - 128, 6, 4); rivets(g, 60, c + 128, 240, c + 128, 6, 4);
      g.fillStyle = '#202225'; rrect(g, 300, c - 14, 70, 28, 6); g.fill(); line(g, 360, c, 470, c, '#111214', 9);
      grime(g, w, h, 8, 18);
      weather(g, w, h, 90, rnd, ['#151618', '#3a3028', '#6a3a28', '#0c0c0d'], 6);
    });
    // Upper leg seen from above: a thick, tapered armour slab (wide at the hip end on the left), plated and riveted
    ctx.atlas.define('wthigh', 320, 128, (g, w, h) => {
      const c = h / 2;
      const sl = [6, c - 58, 220, c - 46, 312, c - 30, 312, c + 30, 220, c + 46, 6, c + 58];
      facet(g, sl, '#3b3e43');
      facet(g, [6, c - 58, 220, c - 46, 312, c - 30, 312, c, 6, c], '#6f7379');
      facet(g, [40, c - 34, 230, c - 26, 290, c - 14, 290, c, 40, c], '#8d9197');
      line(g, 10, c, 310, c, 'rgba(255,255,255,.15)', 2);
      for (const x of [110, 200]) line(g, x, c - 52, x, c + 50, 'rgba(8,9,10,.7)', 3);
      rivets(g, 30, c + 44, 280, c + 26, 8, 3);
      g.save(); g.globalCompositeOperation = 'source-atop'; const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, 'rgba(120,40,24,0)'); gr.addColorStop(1, 'rgba(120,40,24,.22)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); g.restore();
      weather(g, w, h, 50, rnd, ['#151618', '#3a3028', '#6a3a28'], 6);
    });
    // Lower leg: a dark, heavy ram (mostly hidden under the knee armour)
    ctx.atlas.define('wleg', 256, 96, (g, w, h) => {
      const c = h / 2, sl = [6, c - 34, 250, c - 40, 250, c + 40, 6, c + 34];
      facet(g, sl, '#2e3135'); facet(g, [6, c - 34, 250, c - 40, 250, c, 6, c], '#4c5055');
      for (const x of [70, 150]) line(g, x, c - 36, x, c + 36, 'rgba(8,9,10,.7)', 3);
      g.save(); g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(120,40,24,.3)'; g.fillRect(w * .5, 0, w * .5, h); g.restore();
    });
    // Knee armour: a heavy angular cap, pointing forward
    ctx.atlas.define('wjoint', 160, 144, (g, w, h) => {
      const c = h / 2, kg = [8, c - 52, 96, c - 64, 152, c - 18, 152, c + 18, 96, c + 64, 8, c + 52, 30, c];
      facet(g, kg, '#41444a');
      facet(g, [8, c - 52, 96, c - 64, 152, c - 18, 152, c, 30, c], '#868a90');
      facet(g, [40, c - 30, 100, c - 38, 130, c - 10, 130, c, 50, c], '#a3a7ad');
      rivets(g, 30, c + 40, 110, c + 46, 3, 3.5);
      weather(g, w, h, 20, rnd, ['#151618', '#3a3028', '#6a3a28'], 5);
    });
    // Foot: a broad flat pad with blunt knuckle toes forward, caked in red dust
    ctx.atlas.define('wfoot', 256, 208, (g, w, h) => {
      const c = h / 2;
      for (const k of [-1, 0, 1]) {
        const y = c + k * 58, toe = [150, y - 26, 222, y - 22, 248, y, 222, y + 22, 150, y + 26];
        facet(g, toe, '#3c3f44'); facet(g, [150, y - 26, 222, y - 22, 248, y, 150, y], '#686c72');
      }
      const pad = [20, c - 86, 160, c - 98, 196, c - 46, 196, c + 46, 160, c + 98, 20, c + 86, 4, c];
      facet(g, pad, '#33363a');
      facet(g, [40, c - 66, 150, c - 76, 176, c - 34, 176, c, 30, c], '#6f7379');
      facet(g, [40, c + 66, 150, c + 76, 176, c + 34, 176, c, 30, c], '#4b4f54');
      g.fillStyle = '#1c1d20'; g.beginPath(); g.arc(96, c, 26, 0, TAU); g.fill(); g.strokeStyle = '#5d6167'; g.lineWidth = 3; g.stroke();
      g.save(); g.globalCompositeOperation = 'source-atop'; const fg = g.createRadialGradient(w * .5, c, 20, w * .5, c, w * .55); fg.addColorStop(0, 'rgba(130,40,22,0)'); fg.addColorStop(1, 'rgba(130,40,22,.22)'); g.fillStyle = fg; g.fillRect(0, 0, w, h); g.restore();
    });
    // Resistance fighter (top view): long nose, split wings open in attack position, four engines, orange markings
    ctx.atlas.define('xw', 256, 256, (g, w, h) => {
      const cy = h / 2;
      for (const s of [-1, 1]) for (const o of [0, 1]) {
        const off = o ? 7 : -7, y0 = cy + s * 12 + off * 0.3;
        const wing = [70, y0, 112, y0, 104, cy + s * 112 + off, 72, cy + s * 112 + off];
        plateFill(g, wing, o ? ['#8d8a84', '#c9c5bc', '#9b978f'] : ['#6c6964', '#a8a49c', '#7a7771']);
        g.strokeStyle = '#2a2826'; g.lineWidth = 2; path(g, wing); g.stroke();
        g.fillStyle = '#c4581e'; g.fillRect(76, cy + s * 70 + off - 5, 26, 10);
        line(g, 66, cy + s * 112 + off, 150, cy + s * 112 + off, '#3a3836', 4);     // wingtip cannon
        g.fillStyle = cyl(g, cy + s * 34 + off - 11, cy + s * 34 + off + 11, ['#3a3836', '#a7a39b', '#55524e']); rrect(g, 60, cy + s * 34 + off - 11, 66, 22, 9); g.fill();
        g.fillStyle = '#2a1a14'; g.beginPath(); g.ellipse(61, cy + s * 34 + off, 4, 9, 0, 0, TAU); g.fill();
      }
      const fus = [40, cy - 14, 150, cy - 13, 236, cy - 5, 244, cy, 236, cy + 5, 150, cy + 13, 40, cy + 14];
      plateFill(g, fus, ['#55524e', '#d3cfc6', '#e2ded6', '#9b978f']);
      g.strokeStyle = '#2a2826'; g.lineWidth = 2; path(g, fus); g.stroke();
      g.fillStyle = '#c4581e'; g.fillRect(170, cy - 10, 10, 20); g.fillRect(196, cy - 7, 6, 14);
      const cg = g.createRadialGradient(132, cy - 3, 1, 128, cy, 18); cg.addColorStop(0, '#9fc0d6'); cg.addColorStop(.5, '#2a3a48'); cg.addColorStop(1, '#0c1218');
      g.fillStyle = cg; g.beginPath(); g.ellipse(126, cy, 20, 8, 0, 0, TAU); g.fill();
      g.fillStyle = '#7a3a20'; g.beginPath(); g.arc(92, cy, 6, 0, TAU); g.fill();    // astromech dome
      weather(g, w, h, 80, rnd, ['#3d3a36', '#5a4636', '#2a2826'], 4);
    });
    ctx.atlas.define('flake', 32, 32, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.45, 'rgba(255,255,255,.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    ctx.atlas.define('drop', 128, 12, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(.8, 'rgba(255,255,255,.8)'); gr.addColorStop(1, 'rgba(255,255,255,.2)');
      g.fillStyle = gr; rrect(g, 0, h / 2 - 2, w, 4, 2); g.fill();
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
    const b = { x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, age: 0, life, color, from };
    bolts.push(b); return b;
  }
  // Double-click strike: impact at (x, y), scaled down near icons (k) so the flash and debris never spill onto them
  function strikeImpact(x, y, k, last) {
    const n = Math.round((last ? 16 : 8) * (0.5 + 0.5 * k));
    for (let i = 0; i < n; i++) { const a = R() * TAU, s = rr(30, last ? 150 : 90) * k; puff(x, y, Math.cos(a) * s, Math.sin(a) * s, rr(1.4, 3.4), rr(5, 9) * k, rr(20, last ? 58 : 36) * k, RED_DUST, 0, rr(6, 22)); }
    flashes.push({ x, y, age: 0, life: last ? 0.55 : 0.3, r: (last ? 36 : 18) * k, col: [1, 0.55, 0.28], I: last ? 10 : 6 });
    for (let i = 0; i < (last ? 12 : 5); i++) { const a = R() * TAU, s = rr(80, 260) * k; sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, age: 0, life: rr(.25, .6) }); }
    stG(x, y, (last ? 15 : 8) * k, last ? 1.4 : 1.15);
    if (last) {   // a ring of red dust thrown out low and fast, and a slow dark smoke column
      for (let i = 0; i < 18; i++) { const a = i / 18 * TAU + R() * 0.3, s = rr(110, 190) * k; puff(x + Math.cos(a) * 6, y + Math.sin(a) * 6, Math.cos(a) * s, Math.sin(a) * s, rr(1.2, 2.2), 8 * k, rr(30, 50) * k, RED_DUST, 0, 3); }
      for (let i = 0; i < 5; i++) puff(x + rr(-6, 6) * k, y + rr(-6, 6) * k, rr(-8, 8), rr(-8, 8), rr(2.8, 4), 14 * k, rr(50, 80) * k, [0.16, 0.1, 0.1], 4, rr(10, 22));
    }
    if (last) { for (let i = 0; i < 6; i++) { const a = R() * TAU; stG(x + Math.cos(a) * 9 * k, y + Math.sin(a) * 9 * k, 5 * k, 0.9); } for (const a of speeders.agents) if (Math.hypot(a.x - x, a.y - y) < 40) a.shake = 0.6; }
    for (const gp of foxGroups) for (const f of gp.list) if (Math.hypot(f.x - x, f.y - y) < 160) { f.flee = 1.6; f.fang = Math.atan2(f.y - y, f.x - x) + rr(-.5, .5); }
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
  // Clearance of the walker's whole footprint (hull, gun module and feet) from the icon cells, CSS px
  function walkerClear(ctx, x, y, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    let mn = 1e9;
    for (const [f, q] of [[0, 0], [185, 0], [-135, 0], [90, -134], [90, 134], [-90, -110], [-90, 110]]) mn = Math.min(mn, ctx.distAt(x + c * f - s * q, y + s * f + c * q));
    return mn;
  }
  function spawnWalker(ctx, force) {
    // Pick the horizontal-ish line whose on-screen part keeps the whole walker furthest from the icons
    const W = ctx.W, H = ctx.H; let best = null;
    for (let k = 0; k < 24; k++) {
      const ltr = R() < 0.5, y0 = rr(.12, .88) * H, y1 = y0 + rr(-.25, .25) * H, ang = Math.atan2(y1 - y0, W);
      let mn = 1e9;
      for (let i = 1; i < 24; i++) { const t = i / 24; mn = Math.min(mn, walkerClear(ctx, W * t, y0 + (y1 - y0) * t, ang)); }
      if (!best || mn > best.mn) best = { mn, ltr, y0, y1 };
    }
    if (best.mn < WK.clear && !force) return false;      // no clear lane on this desktop right now: try again later
    const x0 = best.ltr ? -300 : W + 300, x1 = best.ltr ? W + 300 : -300;
    const ya = best.ltr ? best.y0 : best.y1, yb = best.ltr ? best.y1 : best.y0;
    const ang = Math.atan2(yb - ya, x1 - x0);
    walker = { x: x0, y: ya, ang, dist: 0, feet: null, thump: 0, sway: 0, head: 0, spd: WK.spd, gun: 0 };
    return true;
  }
  // Heavy assault walker, local frame: f forward, s to the right, z up (CSS px). From above you see the broad armoured top;
  // the legs are mostly under the hull: only the thick upper-leg armour, the knee caps and the planted feet show outside it.
  const WK = { spd: 11, stride: 112, BL: 250, HW: 0.84, HL: 128, VT: [0.02, 0.06], KZ: 1.7, clear: 120 };
  const WALK_LEGS = [   // hip (f, s, z), knee (f, s, z), neutral foot (f, s), gait phase, thicknesses
    { hf: 60, hs: -64, hz: 150, kf: 74, ks: -114, kz: 84, ff: 92, fs: -128, ph: 0.0, front: 1, th: 56, sh: 38, kn: 50, ft: 76 },
    { hf: 60, hs: 64, hz: 150, kf: 74, ks: 114, kz: 84, ff: 92, fs: 128, ph: 0.5, front: 1, th: 56, sh: 38, kn: 50, ft: 76 },
    { hf: -84, hs: -52, hz: 118, kf: -76, ks: -88, kz: 62, ff: -90, fs: -102, ph: 0.75, front: 0, th: 36, sh: 26, kn: 34, ft: 52 },
    { hf: -84, hs: 52, hz: 118, kf: -76, ks: 88, kz: 62, ff: -90, fs: 102, ph: 0.25, front: 0, th: 36, sh: 26, kn: 34, ft: 52 }];
  const loc = (o, fx, fy) => [o.x + Math.cos(o.ang) * fx - Math.sin(o.ang) * fy, o.y + Math.sin(o.ang) * fx + Math.cos(o.ang) * fy];
  function updateWalker(ctx, dt) {
    const w = walker, stride = WK.stride, pt = ctx.pointer;
    // Keep the whole machine well clear of the icons: look ahead and lean slowly away along the field gradient
    {
      const c = Math.cos(w.ang), s = Math.sin(w.ang);
      let turn = 0;
      for (const ahead of [150, 300]) {
        const lx = w.x + c * ahead, ly = w.y + s * ahead, d = walkerClear(ctx, lx, ly, w.ang), lim = WK.clear + 110;
        if (d < lim && lx > -200 && ly > -200 && lx < ctx.W + 200 && ly < ctx.H + 200) {
          const g = ctx.gradAt(lx, ly), side = Math.sign(c * g[1] - s * g[0]) || 1;
          turn += side * 0.2 * (1 - d / lim) * (ahead === 150 ? 1.6 : 1);
        }
      }
      w.ang += Math.max(-0.22, Math.min(0.22, turn)) * dt;
    }
    // The cursor: the walker slows down and its gun module slowly swings round to track it
    let wantHead = 0, wantSpd = WK.spd;
    if (pt.active) {
      const dx = pt.x - w.x, dy = pt.y - w.y, dd = Math.hypot(dx, dy);
      if (dd < 520) {
        let a = Math.atan2(dy, dx) - w.ang; a = Math.atan2(Math.sin(a), Math.cos(a));
        wantHead = Math.max(-0.5, Math.min(0.5, a)); wantSpd = WK.spd * (0.35 + 0.65 * Math.min(1, dd / 520));
      }
    }
    w.head += Math.max(-0.18 * dt, Math.min(0.18 * dt, wantHead - w.head));
    w.spd += (wantSpd - w.spd) * Math.min(1, dt * 0.5);
    const spd = w.spd;
    w.dist += spd * dt; w.x += Math.cos(w.ang) * spd * dt; w.y += Math.sin(w.ang) * spd * dt;
    if (!w.feet) w.feet = WALK_LEGS.map(Lg => { const u = (w.dist / stride + Lg.ph) % 1, off = (0.375 - Math.min(u, 0.75) / 0.75 * 0.75) * stride, p = loc(w, Lg.ff + off, Lg.fs); return { x: p[0], y: p[1], sx: p[0], sy: p[1], tx: p[0], ty: p[1], sw: false, lift: 0 }; });
    WALK_LEGS.forEach((Lg, i) => {
      const f = w.feet[i], u = (w.dist / stride + Lg.ph) % 1;
      if (u >= 0.75 && !f.sw) { f.sw = true; f.sx = f.x; f.sy = f.y; const p = loc(w, Lg.ff + stride * 0.625, Lg.fs); f.tx = p[0]; f.ty = p[1]; }
      if (f.sw) {
        const k = u < 0.5 ? 1 : ctx.sstep(0.75, 1, u);
        f.x = f.sx + (f.tx - f.sx) * k; f.y = f.sy + (f.ty - f.sy) * k; f.lift = Math.sin(Math.min(1, k * 1.15) * Math.PI);
        if (u < 0.5) {   // footfall: a deep print, a ring of red dust, the hull dips
          f.sw = false; f.x = f.tx; f.y = f.ty; f.lift = 0; w.thump = 1;
          stG(f.x, f.y, Lg.front ? 14 : 10, 1.3);
          if (ctx.distAt(f.x, f.y) > 20) for (let j = 0; j < 12; j++) { const a = j / 12 * TAU + R() * 0.5, s = rr(28, 70); puff(f.x + Math.cos(a) * 12, f.y + Math.sin(a) * 12, Math.cos(a) * s, Math.sin(a) * s, rr(1.8, 3.4), 10, rr(28, 48), RED_DUST, 0, rr(4, 9)); }
        }
      } else f.lift = 0;
    });
    w.thump *= Math.exp(-dt * 2.4);
    w.sway = Math.sin(w.dist / stride * TAU) * 1.6;
    if (w.dist > 600 && (w.x < -420 || w.x > ctx.W + 420 || w.y < -420 || w.y > ctx.H + 420)) walker = null;
  }
  // Joint positions of one leg in the local frame (f, s, z); the knee follows the foot through the stride
  function legJoints(w, Lg, f) {
    const c = Math.cos(w.ang), s = Math.sin(w.ang), dx = f.x - w.x, dy = f.y - w.y;
    const ff = dx * c + dy * s, fs = -dx * s + dy * c, fz = f.lift * (Lg.front ? 24 : 18);
    const hz = Lg.hz - w.thump * 3;
    const hip = [Lg.hf, Lg.hs + w.sway * 0.3, hz];
    const knee = [Lg.kf + (ff - Lg.ff) * 0.4, Lg.ks + (fs - Lg.fs) * 0.5, Lg.kz + fz * 0.6];
    return [hip, knee, [ff, fs, fz]];
  }
  // Screen position of a local point as seen (with a slight fake view tilt so tall parts lean away) and as its shadow on the ground
  function wSee(w, q) { const c = Math.cos(w.ang), s = Math.sin(w.ang); return [w.x + c * q[0] - s * q[1] + WK.VT[0] * q[2], w.y + s * q[0] + c * q[1] + WK.VT[1] * q[2]]; }
  function wShadow(w, q) { const c = Math.cos(w.ang), s = Math.sin(w.ang), k = WK.KZ * q[2]; return [w.x + c * q[0] - s * q[1] + SH[0] * k, w.y + s * q[0] + c * q[1] + SH[1] * k]; }
  const segSprite = (ctx, name, a, b, th, o) => ctx.sprite(name, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Object.assign({ w: Math.hypot(b[0] - a[0], b[1] - a[1]) + th * 0.5, h: th, rot: Math.atan2(b[1] - a[1], b[0] - a[0]) }, o));
  // The walker's cast shadow, drawn as white into the half-resolution shadow mask (MAX blending, so overlaps never double up)
  function drawWalkerShadow(ctx) {
    const w = walker, o = { tint: [1, 1, 1], flat: 1, bias: 1.2 + 2.5 * Math.max(0, 1 - L.dirF) }, bob = -w.thump * 3;
    for (let z = 112; z <= 182; z += 10) { const p = wShadow(w, [-8, 0, z + bob - Math.max(0, z - 160) * 0.5]); ctx.sprite('wbody', p[0], p[1], Object.assign({ w: WK.BL * (z > 165 ? 0.8 : 1), h: WK.BL * WK.HW * (z > 165 ? 0.55 : 1), rot: w.ang }, o)); }
    for (let z = 118; z <= 146; z += 9) { const p = wShadow(w, [122, 0, z + bob]); ctx.sprite('whead', p[0], p[1], Object.assign({ w: WK.HL, rot: w.ang + w.head }, o)); }
    WALK_LEGS.forEach((Lg, i) => {
      const [hip, knee, foot] = legJoints(w, Lg, w.feet[i]);
      const H = wShadow(w, hip), K = wShadow(w, knee), F = wShadow(w, foot);
      segSprite(ctx, 'wthigh', H, K, Lg.th, o); segSprite(ctx, 'wleg', K, F, Lg.sh, o);
      ctx.sprite('wfoot', F[0], F[1], Object.assign({ w: Lg.ft, rot: w.ang }, o));
    });
  }
  function drawWalker(ctx, tint, lamp) {
    const w = walker, bob = -w.thump * 3;
    // feet planted outside the hull, then the lower legs, the thick upper-leg armour and the knee caps; the hull covers the hips
    for (const i of [0, 2, 1, 3]) {
      const Lg = WALK_LEGS[i], [hip, knee, foot] = legJoints(w, Lg, w.feet[i]);
      const H = wSee(w, hip), K = wSee(w, knee), F = wSee(w, foot), lift = foot[2] * WK.KZ;
      ctx.sprite('wfoot', F[0], F[1], { w: Lg.ft * (1 + foot[2] * 0.004), rot: w.ang, tint: mul3(tint, 0.95), shadow: { dx: SH[0] * (4 + lift), dy: SH[1] * (4 + lift), alpha: 0.65, bias: 1, tint: [0.05, 0.045, 0.12] } });
      segSprite(ctx, 'wleg', F, K, Lg.sh, { tint: mul3(tint, 0.7) });
      segSprite(ctx, 'wthigh', H, K, Lg.th, { tint: mul3(tint, 0.9) });
      ctx.sprite('wjoint', K[0], K[1], { w: Lg.kn, rot: w.ang, tint });
    }
    const Hh = wSee(w, [122, 0, 132 + bob]);
    ctx.sprite('whead', Hh[0], Hh[1], { w: WK.HL, rot: w.ang + w.head, tint });
    const B = wSee(w, [-8, 0, 160 + bob]);
    ctx.sprite('wbody', B[0], B[1], { w: WK.BL, h: WK.BL * WK.HW, rot: w.ang, tint });
    // viewport slits and, after dusk, two search lights sweeping the salt ahead
    const ha = w.ang + w.head, hc = Math.cos(ha), hs = Math.sin(ha);
    const ex = Hh[0] + hc * WK.HL * 0.2, ey = Hh[1] + hs * WK.HL * 0.2;
    for (const sg of [-1, 1]) ctx.glowDot(ex - hs * sg * 7, ey + hc * sg * 7, 2.4, [1, 0.3, 0.12], 2.5 + 4 * lamp, { core: 0.6 });
    if (lamp > 0.02) {
      for (const sg of [-1, 1]) {
        const sw = Math.sin(ctx.t * 0.3 + sg) * 0.25, a = ha + sg * 0.18 + sw, x0 = Hh[0] + hc * 40, y0 = Hh[1] + hs * 40;
        const gx = w.x + Math.cos(a) * 270, gy = w.y + Math.sin(a) * 270;
        const ni = ctx.clamp((ctx.distAt(gx, gy) - 30) / 90, 0, 1);
        ctx.glowLine(x0, y0, (x0 + gx) / 2, (y0 + gy) / 2, 22, [1, 0.9, 0.75], 0.1 * lamp, { core: 0 });
        ctx.glowDot(gx, gy, 46, [1, 0.92, 0.78], 0.3 * lamp * ni, { core: 0 });
      }
      for (const sg of [-1, 1]) { const bx = B[0] - Math.cos(w.ang) * WK.BL * 0.45 - Math.sin(w.ang) * sg * 22, by = B[1] - Math.sin(w.ang) * WK.BL * 0.45 + Math.cos(w.ang) * sg * 22; ctx.glowDot(bx, by, 2.2, [1, 0.15, 0.1], 5 * lamp * (0.5 + 0.5 * Math.sin(ctx.t * 3 + sg))); }
    }
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
        const pt = ctx.pointer;
        if (pt.active) { const px = f.x - pt.x, py = f.y - pt.y, pd = Math.hypot(px, py); if (pd < 200) { const push = 1 - pd / 200, aw = Math.atan2(py, px); want = Math.atan2(Math.sin(want) * (1 - push) + Math.sin(aw) * push * 2, Math.cos(want) * (1 - push) + Math.cos(aw) * push * 2); f.spd = Math.min(f.spd + 300 * push * dt, 480); } }
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
      if (b.from === 'p') { if (b.age > b.life) { b.dead = true; strikeImpact(b.tx, b.ty, b.k, b.last); } continue; }
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
      const pt = ctx.pointer;
      if (pt.active) {   // the cursor: swerve away hard and open the throttle
        const px = a.x - pt.x, py = a.y - pt.y, pd = Math.hypot(px, py);
        if (pd < 210) { const push = 1 - pd / 210, aw = Math.atan2(py, px); want = Math.atan2(Math.sin(want) * (1 - push) + Math.sin(aw) * push * 2, Math.cos(want) * (1 - push) + Math.cos(aw) * push * 2); a.boost = Math.max(a.boost || 0, push); }
      }
      if (a.boost) a.boost = Math.max(0, a.boost - dt * 0.6);
      const d = Math.atan2(Math.sin(want - a.ang), Math.cos(want - a.ang)), turn = (1.3 + 1.6 * (a.boost || 0)) * dt;
      const st = Math.max(-turn, Math.min(turn, d));
      a.turnRate = st / Math.max(dt, 1e-4); a.ang += st;
      const sp = a.spd * (fight.on ? 1.3 : 1) * (1 + 0.8 * (a.boost || 0));
      a.x += Math.cos(a.ang) * sp * dt; a.y += Math.sin(a.ang) * sp * dt;
      if (a.x < -110 || a.y < -110 || a.x > W + 110 || a.y > H + 110) spawnSpeeder(ctx, a, false);
    }
  }

  /* ---------------- double-click strike: a Resistance fighter dives out of the sun, or a nearby speeder's gunner fires ---------------- */
  let raiders = [], flakes = [], drops = [], bolt = null, lastFlash = 0;
  function strike(ctx, x, y) {
    const k = ctx.clamp((ctx.distAt(x, y) - 4) / 70, 0.3, 1);
    // A speeder close by turns its rear gun on the spot
    let best = null, bd = 380;
    for (const a of speeders.agents) { const d = Math.hypot(a.x - x, a.y - y); if (d > 90 && d < bd) { bd = d; best = a; } }
    if (best && raiders.length >= 1 || best && R() < 0.4) {
      for (let i = 0; i < 4; i++) setTimeout0.push({ t: i * 0.13, fn: () => {
        if (!speeders.agents.includes(best)) return;
        const tx = x + rr(-8, 8) * k, ty = y + rr(-8, 8) * k, sp = 1100, d = Math.hypot(tx - best.x, ty - best.y);
        const b = fire(best.x, best.y, Math.atan2(ty - best.y, tx - best.x), [1, 0.13, 0.07], sp, d / sp, 'p');
        b.tx = tx; b.ty = ty; b.k = k; b.last = i === 3;
      } });
      return;
    }
    if (raiders.length >= 4) return;
    const a0 = Math.atan2(-L.sunD[1], -L.sunD[0]) + rr(-0.5, 0.5);   // comes in from the sun's side
    const lead = 820;
    raiders.push({ x: x - Math.cos(a0) * lead, y: y - Math.sin(a0) * lead, ang: a0, spd: 900, alt: 210, age: 0, tx: x, ty: y, k, shots: 0, cd: 0 });
  }
  function updateRaiders(ctx, dt) {
    for (const r of raiders) {
      r.age += dt; r.x += Math.cos(r.ang) * r.spd * dt; r.y += Math.sin(r.ang) * r.spd * dt;
      const dx = r.tx - r.x, dy = r.ty - r.y, along = dx * Math.cos(r.ang) + dy * Math.sin(r.ang);
      r.alt += ((along > -60 ? 70 : 260) - r.alt) * Math.min(1, dt * (along > -60 ? 2.2 : 0.9));
      r.cd -= dt;
      if (r.shots < 4 && along < 470 && along > 150 && r.cd <= 0) {
        r.cd = 0.085; r.shots++;
        const c = Math.cos(r.ang), s = Math.sin(r.ang);
        for (const sg of [-1, 1]) {
          const ox = r.x - s * sg * 11, oy = r.y + c * sg * 11, tx = r.tx + rr(-9, 9) * r.k + c * (r.shots - 2.5) * 6 * r.k, ty = r.ty + rr(-9, 9) * r.k + s * (r.shots - 2.5) * 6 * r.k;
          const sp = 1500, d = Math.hypot(tx - ox, ty - oy);
          const b = fire(ox, oy, Math.atan2(ty - oy, tx - ox), [1, 0.16, 0.08], sp, d / sp, 'p');
          b.tx = tx; b.ty = ty; b.k = r.k; b.last = r.shots === 4 && sg > 0;
        }
      }
      if (r.age > 4) r.dead = true;
    }
    raiders = raiders.filter(r => !r.dead);
  }

  /* ---------------- weather particles ---------------- */
  function updateWeather(ctx, dt) {
    const W = ctx.W, H = ctx.H, hi = ctx.P.quality >= 1 ? 1 : 0.6;
    const nF = Math.round(L.snow * 320 * hi), nD = Math.round(L.rain * 260 * hi);
    while (flakes.length < nF) flakes.push({ x: R() * W, y: R() * H, z: R(), s: rr(1.6, 4.2), ph: R() * 50, age: R() * 3, life: rr(4, 8) });
    if (flakes.length > nF) flakes.length = nF;
    for (const f of flakes) {
      f.age += dt; f.z -= dt * 0.18;
      f.x += (WIND[0] * 38 + Math.sin(ctx.t * 1.3 + f.ph) * 9) * dt; f.y += (WIND[1] * 38 + Math.cos(ctx.t * 1.1 + f.ph) * 7) * dt;
      if (f.z <= 0 || f.age > f.life || f.x < -20 || f.y < -20 || f.x > W + 20 || f.y > H + 20) { f.x = R() * W; f.y = R() * H; f.z = 1; f.age = 0; }
    }
    while (drops.length < nD) drops.push({ x: R() * W, y: R() * H, age: R() * 0.3, life: rr(0.18, 0.32) });
    if (drops.length > nD) drops.length = nD;
    for (const d of drops) { d.age += dt; if (d.age > d.life) { d.x = R() * W; d.y = R() * H; d.age = 0; d.life = rr(0.18, 0.32); } }
    // Lightning: each new flash gets a forked bolt, reflected in the water film far from the icons
    if (L.flash > 0.5 && lastFlash <= 0.5 && L.wet > 0.2) {
      let bx = 0, by = 0, bb = -1e9;
      for (let i = 0; i < 10; i++) { const x = rr(.1, .9) * W, y = rr(.1, .9) * H, b = ctx.blobAt(x, y); if (b > bb) { bb = b; bx = x; by = y; } }
      const segs = [], a0 = rr(0, TAU), Lb = rr(260, 460);
      const walk = (x, y, a, len, w, depth) => {
        let px = x, py = y;
        const n = Math.max(3, Math.round(len / 26));
        for (let i = 0; i < n; i++) {
          a += rr(-0.6, 0.6); const nx = px + Math.cos(a) * len / n, ny = py + Math.sin(a) * len / n;
          if (ctx.distAt(nx, ny) < 50) break;
          segs.push(px, py, nx, ny, w); px = nx; py = ny;
          if (depth < 2 && R() < 0.22) walk(px, py, a + rr(-1, 1), len * 0.4, w * 0.6, depth + 1);
        }
      };
      walk(bx - Math.cos(a0) * Lb / 2, by - Math.sin(a0) * Lb / 2, a0, Lb, 1, 0);
      bolt = { segs, x: bx, y: by };
    }
    lastFlash = L.flash;
  }

  /* ---------------- Star Destroyer flyover ----------------
     A huge wedge seen from far above, drawn from its own 3072x1888 canvas texture (too big for the shared atlas) with a small
     quad shader. Its shadow goes into the same shadow mask as the walker's, so the main pass darkens the salt to sky light only.
     Over icon areas (the scar mask's red channel) the ship fades so icons stay readable. */
  const SD_TW = 3072, SD_TH = 1888, SD_ASPECT = SD_TH / SD_TW;
  let sdTex = null, sdProg = null, destroyer = null, nextSD = 120;
  const SD_VS = `#version 300 es
uniform vec2 uRes, uC, uAx, uAy;
out vec2 vUv, vScr;
void main() {
  vec2 k = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2. - 1.;
  vec2 p = uC + uAx * k.x + uAy * k.y;
  vUv = vec2(k.x * .5 + .5, k.y * .5 + .5);
  vScr = p / uRes;
  gl_Position = vec4(p.x / uRes.x * 2. - 1., 1. - p.y / uRes.y * 2., 0., 1.);
}`;
  const SD_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex, uScar;
uniform float uMode, uAlpha, uFade;
uniform vec3 uTint;
in vec2 vUv, vScr;
out vec4 o;
void main() {
  vec4 t = texture(uTex, vUv);
  if (uMode > .5) { o = vec4(vec3(t.a), t.a); return; }          // shadow mask: white silhouette
  float ic = texture(uScar, vec2(vScr.x, 1. - vScr.y)).r;
  float a = uAlpha * (1. - uFade * smoothstep(.3, .85, ic));       // thin out over icons
  vec3 lin = t.a > 1e-4 ? pow(t.rgb / t.a, vec3(2.2)) * t.a : vec3(0);
  o = vec4(lin * uTint * a, t.a * a);
}`;
  function buildDestroyerTexture(gl) {
    const c = document.createElement('canvas'); c.width = SD_TW; c.height = SD_TH;
    const g = c.getContext('2d'), R2 = mulberry(4711), cy = SD_TH / 2, X0 = 40, X1 = SD_TW - 30, HW = SD_TH / 2 - 16;
    const halfAt = x => HW * (X1 - x) / (X1 - X0);   // wedge half-width at x
    const wedge = [X1, cy, X0, cy - HW, X0 + 30, cy - HW * 0.6, X0 + 30, cy + HW * 0.6, X0, cy + HW];
    // hull: two long facets either side of the keel ridge
    path(g, [X1, cy, X0, cy - HW, X0, cy + HW]); g.fillStyle = '#8f9396'; g.fill();
    path(g, [X1, cy, X0, cy - HW, X0 + 200, cy]); g.fillStyle = '#a9adb0'; g.fill();
    path(g, [X1, cy, X0, cy + HW, X0 + 200, cy]); g.fillStyle = '#7f8386'; g.fill();
    g.save(); path(g, [X1, cy, X0, cy - HW, X0, cy + HW]); g.clip();
    // plating: thousands of axis-aligned panels in varied greys, denser toward the stern
    for (let k = 0; k < 4200; k++) {
      const x = X0 + R2() * (X1 - X0), hw = halfAt(x), y = cy + (R2() * 2 - 1) * hw, pw = 12 + R2() * 70, ph = 6 + R2() * 26;
      const v = R2(); g.fillStyle = v < .45 ? 'rgba(255,255,255,.07)' : v < .85 ? 'rgba(0,0,0,.08)' : 'rgba(30,32,36,.22)';
      g.fillRect(x, y, pw, ph);
    }
    for (let k = 0; k < 900; k++) {   // small greebles with a lit and a shaded edge
      const x = X0 + R2() * (X1 - X0) * 0.9, hw = halfAt(x), y = cy + (R2() * 2 - 1) * hw * 0.92, s = 4 + R2() * 14;
      g.fillStyle = '#b8bcbf'; g.fillRect(x, y, s, s * .6); g.fillStyle = 'rgba(20,22,25,.55)'; g.fillRect(x, y + s * .6, s, 2); g.fillRect(x + s, y, 2, s * .6);
    }
    // panel seams across the hull and the keel line
    for (let x = X0 + 60; x < X1 - 80; x += 46 + R2() * 30) { const hw = halfAt(x); line(g, x, cy - hw, x, cy + hw, 'rgba(25,27,30,.18)', 1.5); }
    line(g, X0 + 200, cy, X1, cy, 'rgba(240,244,248,.5)', 3);
    // edge trenches: dark grooves just inside each outer edge, with lit lips
    for (const s of [-1, 1]) {
      const a0 = [X1 - 140, cy + s * halfAt(X1 - 140) * 0.0], inset = 70;
      const p0x = X0 + 60, p0y = cy + s * (halfAt(X0 + 60) - inset), p1x = X1 - 260, p1y = cy + s * (halfAt(X1 - 260) - inset * 0.5);
      line(g, p0x, p0y, p1x, p1y, '#2a2d31', 14); line(g, p0x, p0y - s * 9, p1x, p1y - s * 7, 'rgba(230,234,238,.45)', 2.5);
      for (let k = 0; k < 60; k++) { const t = k / 60, x = p0x + (p1x - p0x) * t, y = p0y + (p1y - p0y) * t; g.fillStyle = '#5c6064'; g.fillRect(x, y - 4, 8, 8); }
      void a0;
    }
    // stepped superstructure toward the stern, each terrace casting a shadow on the one below
    const terr = [[200, 1500, 360], [240, 1180, 270], [270, 900, 200], [300, 700, 140]];
    for (const [x0, x1, hw] of terr) {
      const pts = [x1, cy - hw * 0.35, x1, cy + hw * 0.35, x0, cy + hw, x0, cy - hw];
      path(g, pts.map((v, i) => v + (i % 2 ? 18 : 22))); g.fillStyle = 'rgba(15,16,18,.45)'; g.fill();
      path(g, pts); g.fillStyle = '#a3a7aa'; g.fill(); g.strokeStyle = '#3a3d41'; g.lineWidth = 3; g.stroke();
      path(g, [x1, cy - hw * 0.35, x1, cy, x0, cy, x0, cy - hw]); g.fillStyle = 'rgba(255,255,255,.12)'; g.fill();
      for (let k = 0; k < 40; k++) { const x = x0 + 20 + R2() * (x1 - x0 - 40), y = cy + (R2() * 2 - 1) * hw * 0.5; g.fillStyle = 'rgba(30,32,36,.35)'; g.fillRect(x, y, 10 + R2() * 30, 4); }
      for (let x = x0 + 30; x < x1 - 20; x += 22) { line(g, x, cy - hw * 0.95 + (x - x0) * (hw * 0.65 / (x1 - x0)), x + 10, cy - hw * 0.95 + (x - x0) * (hw * 0.65 / (x1 - x0)), 'rgba(20,22,25,.6)', 2); }
    }
    // command tower: the bridge T and two shield domes
    g.fillStyle = 'rgba(12,13,15,.5)'; g.fillRect(180, cy - 200, 150, 400);
    g.fillStyle = '#b1b5b8'; g.fillRect(150, cy - 70, 170, 140); g.strokeStyle = '#2f3236'; g.lineWidth = 3; g.strokeRect(150, cy - 70, 170, 140);
    g.fillStyle = '#c3c7ca'; g.fillRect(110, cy - 230, 90, 460); g.strokeRect(110, cy - 230, 90, 460);
    for (let y = cy - 220; y < cy + 220; y += 14) line(g, 118, y, 192, y, 'rgba(20,22,25,.55)', 2);
    for (const s of [-1, 1]) {
      const dx = 250, dy = cy + s * 140, gr = g.createRadialGradient(dx - 14, dy - 14, 4, dx, dy, 46);
      gr.addColorStop(0, '#e7eaec'); gr.addColorStop(1, '#7c8084'); g.fillStyle = gr; g.beginPath(); g.arc(dx, dy, 44, 0, TAU); g.fill(); g.strokeStyle = '#2f3236'; g.stroke();
      line(g, dx, dy, dx - 60, dy, '#4a4e52', 8);
    }
    // stern: engine housings along the back edge
    for (const [y, r] of [[0, 120], [-260, 80], [260, 80], [-420, 46], [420, 46]]) { g.fillStyle = '#3a3d41'; g.fillRect(X0 - 10, cy + y - r, 70, r * 2); g.fillStyle = '#1b1d20'; g.fillRect(X0 - 10, cy + y - r * .7, 22, r * 1.4); }
    // ventral bay hint and weathering streaks running aft
    g.fillStyle = 'rgba(20,22,25,.35)'; g.fillRect(1700, cy - 60, 700, 120);
    for (let k = 0; k < 500; k++) { const x = X0 + R2() * (X1 - X0), hw = halfAt(x), y = cy + (R2() * 2 - 1) * hw, Lx = 40 + R2() * 200; const gr = g.createLinearGradient(x, 0, x - Lx, 0); gr.addColorStop(0, 'rgba(40,42,46,.18)'); gr.addColorStop(1, 'rgba(40,42,46,0)'); g.fillStyle = gr; g.fillRect(x - Lx, y, Lx, 2 + R2() * 4); }
    g.restore();
    g.strokeStyle = '#2b2e32'; g.lineWidth = 6; path(g, [X1, cy, X0, cy - HW, X0, cy + HW]); g.stroke();
    void wedge;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ani = gl.getExtension('EXT_texture_filter_anisotropic'); if (ani) gl.texParameterf(gl.TEXTURE_2D, ani.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return tex;
  }
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const sdLen = ctx => Math.min(ctx.W * 0.78, ctx.H * 1.55);
  function spawnDestroyer(ctx, mid) {
    // Choose the lane that leaves the fewest icons under the hull
    const W = ctx.W, H = ctx.H, Ls = sdLen(ctx), hw = Ls * SD_ASPECT * 0.5;
    let best = null;
    for (let k = 0; k < 16; k++) {
      const ltr = R() < 0.5, ang = (ltr ? 0 : Math.PI) + rr(-0.35, 0.35), cx = W / 2 + rr(-0.15, 0.15) * W, cy = rr(0.2, 0.8) * H;
      const nx = -Math.sin(ang), ny = Math.cos(ang);
      let cost = 0;
      for (const ic of ctx.icons) { const d = Math.abs((ic.x + ic.w / 2 - cx) * nx + (ic.y + ic.h / 2 - cy) * ny); if (d < hw * 0.75) cost += 1 - d / (hw * 0.75); }
      if (!best || cost < best.cost) best = { cost, ang, cx, cy };
    }
    const back = mid ? 0 : W * 0.5 + Ls * 0.7;
    destroyer = { x: best.cx - Math.cos(best.ang) * back, y: best.cy - Math.sin(best.ang) * back, ang: best.ang, spd: 40, alt: 430, age: 0 };
  }
  function updateDestroyer(ctx, dt) {
    const d = destroyer, pt = ctx.pointer, Ls = sdLen(ctx);
    d.age += dt;
    if (pt.active) {   // a capital ship only nudges its heading away from the cursor
      const dx = d.x - pt.x, dy = d.y - pt.y, dd = Math.hypot(dx, dy);
      if (dd < Ls * 0.6) { const aw = Math.atan2(dy, dx), da = Math.atan2(Math.sin(aw - d.ang), Math.cos(aw - d.ang)); d.ang += Math.sign(da) * 0.02 * dt * (1 - dd / (Ls * 0.6)); }
    }
    d.x += Math.cos(d.ang) * d.spd * dt; d.y += Math.sin(d.ang) * d.spd * dt;
    const m = Ls * 0.75;
    if (d.age > 5 && (d.x < -m || d.x > ctx.W + m || d.y < -m || d.y > ctx.H + m)) destroyer = null;
  }
  function drawDestroyerQuad(ctx, x, y, mode, alpha, tint) {
    const gl = ctx.gl, Ls = sdLen(ctx), c = Math.cos(destroyer.ang), s = Math.sin(destroyer.ang), hl = Ls / 2, hw = Ls * SD_ASPECT / 2;
    gl.useProgram(sdProg.p);
    ctx.setUniform(sdProg.U, 'uRes', [ctx.W, ctx.H]); ctx.setUniform(sdProg.U, 'uC', [x, y]);
    ctx.setUniform(sdProg.U, 'uAx', [c * hl, s * hl]); ctx.setUniform(sdProg.U, 'uAy', [-s * hw, c * hw]);
    ctx.setUniform(sdProg.U, 'uMode', mode); ctx.setUniform(sdProg.U, 'uAlpha', alpha); ctx.setUniform(sdProg.U, 'uFade', 0.62); ctx.setUniform(sdProg.U, 'uTint', tint);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sdTex); ctx.setUniform(sdProg.U, 'uTex', 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, scarA.tex); ctx.setUniform(sdProg.U, 'uScar', 1);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (mode > 0.5) gl.blendEquation(gl.MAX);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND);
  }
  // Ship-space point (fraction of length from the centre toward the bow, fraction of half-width to the right) to screen
  function sdAt(ctx, fx, fy) { const d = destroyer, Ls = sdLen(ctx), c = Math.cos(d.ang), s = Math.sin(d.ang), a = fx * Ls / 2, b = fy * Ls * SD_ASPECT / 2; return [d.x + c * a - s * b, d.y + s * a + c * b]; }
  function drawDestroyer(ctx, lamp, T) {
    ctx.flush();
    ctx.bindTarget(null);
    drawDestroyerQuad(ctx, destroyer.x, destroyer.y, 0, 0.98, [T[0] * 0.95, T[1] * 0.97, T[2]]);
    // engine glows along the stern, running lights on the edges and the bow
    const eng = 0.45 + 1.8 * lamp, t = ctx.t;
    for (const [fy, r] of [[0, 1], [-0.28, 0.7], [0.28, 0.7], [-0.45, 0.42], [0.45, 0.42]]) { const p = sdAt(ctx, -0.985, fy); ctx.glowDot(p[0], p[1], 22 * r, [0.45, 0.65, 1], 3.2 * eng, { core: 0.5 }); }
    if (lamp > 0.02) {
      for (let k = 0; k < 9; k++) for (const sg of [-1, 1]) { const f = -0.9 + k * 0.22, p = sdAt(ctx, f, sg * (0.98 - (f + 1) / 2 * 0.96) * 0.97); ctx.glowDot(p[0], p[1], 2.4, sg < 0 ? [1, 0.25, 0.15] : [0.3, 1, 0.45], 4 * lamp * (Math.sin(t * 1.7 + k * 0.6) > 0.2 ? 1 : 0.25)); }
      const bow = sdAt(ctx, 0.97, 0); ctx.glowDot(bow[0], bow[1], 3, [1, 1, 1], 6 * lamp * (Math.sin(t * 3) > 0.8 ? 1 : 0.1));
      const tw = sdAt(ctx, -0.86, 0); ctx.glowDot(tw[0], tw[1], 30, [1, 0.9, 0.75], 0.6 * lamp, { core: 0 });
    }
  }

  /* ---------------- scene ---------------- */
  let wsT = null, wsClear = false;
  function freeAll(ctx) { [salt, soil, plate, info, scarA, scarB, wsT].forEach(t => t && ctx.freeTarget(t)); salt = soil = plate = info = scarA = scarB = wsT = null; }
  const POST0 = { bloom: 0.5, threshold: 1.35, knee: 0.45, exposure: 0.92, vignette: 0.3, grain: 0.018, aberration: 0.0007, tint: [1.035, 1.0, 0.955], saturation: 1.1, bloomRadius: 1.1 };

  Galaxy.register(ID, {
    weather: false,   // time of day only: no live weather in this scene
    name: 'Salt flats',
    defaultHour: DEF_HOUR,
    post(ctx) {
      return Object.assign({}, POST0, { exposure: POST0.exposure * L.expo, tint: L.tint, saturation: L.sat, vignette: 0.3 + 0.08 * L.night });
    },

    init(ctx) {
      R = ctx.rng(17);
      progSalt = ctx.program(SALT_FS);
      progSoil = ctx.program(SOIL_FS);
      progScar = ctx.program(SCAR_FS);
      progMain = ctx.program(MAIN_FS);
      progPlate = ctx.program(PLATE_FS);
      progHaze = ctx.program(HAZE_FS);
      texPack = ctx.loadTexture('assets/saltflats/pack.jpg', { srgb: false });
      defineSprites(ctx);
      if (!sdProg) sdProg = ctx.linkProgram(SD_VS, SD_FS);
      if (!sdTex) sdTex = buildDestroyerTexture(ctx.gl);
      destroyer = null; nextSD = DBG.includes('sd') ? 0 : rr(60, 200);
      speeders = { agents: [] };
      dust = []; glints = []; bolts = []; fighters = []; flashes = []; sparks = []; drags = []; stampsR = []; stampsG = []; foxGroups = [];
      raiders = []; flakes = []; drops = []; bolt = null; lastFlash = 0;
      freighter = walker = null; setTimeout0.length = 0;
      fight.on = false; fight.next = 1.5 + R() * ctx.mix(30, 4, ctx.P.skirmish);
      nextFox = rr(2, 8); nextShip = rr(30, 110); nextWalker = rr(70, 180);
      if (DBG.includes('ship')) nextShip = 0;
      if (DBG.includes('walker')) nextWalker = 0;
      if (DBG.includes('fight')) fight.next = 0;
      if (DBG.includes('fox')) nextFox = 0;
      L.key = ''; L.woff = [0, 0];
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
      if (!wsT || wsT.w !== sw || wsT.h !== sh) { if (wsT) ctx.freeTarget(wsT); wsT = ctx.makeTarget(sw, sh, { float: false }); wsClear = false; }
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

    fire(ctx, x, y) { strike(ctx, x, y); },

    update(ctx) {
      const dt = ctx.dt, t = ctx.t, P = ctx.P;
      computeLight(ctx);
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
        a.em += dt * 15 * (a.spd / 175) * (1 - 0.6 * L.wet) * (1 - 0.4 * L.snow);   // wet or snowy salt throws less dust
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

      // Dust drifts with the wind
      const wx = WIND[0] * 20, wy = WIND[1] * 20;
      for (const p of dust) {
        p.age += dt; const dr = Math.exp(-dt * 1.1);
        p.vx *= dr; p.vy *= dr; p.x += (p.vx + wx) * dt; p.y += (p.vy + wy) * dt; p.h += p.hv * dt;
      }
      dust = dust.filter(p => p.age < p.life);

      // Crystal foxes (scatter from the cursor and from strikes)
      nextFox -= dt;
      if (nextFox <= 0) { spawnFoxes(); nextFox = rr(16, 38); if (DBG.includes('foxc')) { const g = foxGroups[foxGroups.length - 1]; g.list.forEach((f, i) => { f.x = ctx.pointer.x - 90 - i * 22; f.y = ctx.pointer.y + 40; f.ang = 0; }); } }
      const pt = ctx.pointer;
      for (const gp of foxGroups) {
        gp.age += dt;
        gp.list.forEach((f, i) => {
          let want, spd;
          if (pt.active && !(f.flee > 0)) { const dx = f.x - pt.x, dy = f.y - pt.y; if (Math.hypot(dx, dy) < 150) { f.flee = 1.5; f.fang = Math.atan2(dy, dx) + (i - (gp.list.length - 1) / 2) * 0.45 + rr(-.2, .2); } }
          if (f.flee > 0) {
            f.flee -= dt; want = f.fang; spd = 250 * Math.min(1, 0.4 + f.flee);
            const b = ctx.blobAt(f.x + Math.cos(f.ang) * 30, f.y + Math.sin(f.ang) * 30);
            if (b < 20) { const g = ctx.gradAt(f.x, f.y, ctx.blobAt); f.fang = Math.atan2(g[1], g[0]); }
          } else if (i === 0) {
            want = f.ang + (Math.sin(t * 1.7 + f.ph) * 0.9 + Math.sin(t * 0.6 + f.ph * 3) * 0.5) * dt * 2.5;
            const lx = f.x + Math.cos(f.ang) * 36, ly = f.y + Math.sin(f.ang) * 36;
            const b = ctx.blobAt(lx, ly);
            if (b < 30 && lx > 0 && ly > 0 && lx < ctx.W && ly < ctx.H) { const g = ctx.gradAt(lx, ly, ctx.blobAt); const ga = Math.atan2(g[1], g[0]); let d = Math.atan2(Math.sin(ga - f.ang), Math.cos(ga - f.ang)); want = f.ang + d * 0.8; }
            spd = 80 * (0.45 + 0.9 * Math.abs(Math.sin(t * 2.6 + f.ph)));
          } else {
            const Ld = gp.list[i - 1];
            const bx = Ld.x - Math.cos(Ld.ang) * 20 - Math.sin(Ld.ang) * f.side * 7, by = Ld.y - Math.sin(Ld.ang) * 20 + Math.cos(Ld.ang) * f.side * 7;
            want = Math.atan2(by - f.y, bx - f.x);
            spd = Math.min(220, Math.hypot(bx - f.x, by - f.y) * 4.5);
          }
          let d = Math.atan2(Math.sin(want - f.ang), Math.cos(want - f.ang));
          f.ang += Math.max(-7 * dt, Math.min(7 * dt, d));
          f.x += Math.cos(f.ang) * spd * dt; f.y += Math.sin(f.ang) * spd * dt;
          f.gl -= dt;
          if (f.gl <= 0 && spd > 20) { f.gl = rr(0.05, 0.16); glints.push({ x: f.x - Math.cos(f.ang) * 6 + rr(-3, 3), y: f.y - Math.sin(f.ang) * 6 + rr(-3, 3), age: 0, life: rr(.6, 1.3), s: rr(1.4, 3) }); }
        });
        if (gp.age > 4 && gp.list.every(f => f.x < -60 || f.y < -60 || f.x > ctx.W + 60 || f.y > ctx.H + 60)) gp.dead = true;
        if (gp.age > 90) gp.dead = true;
      }
      foxGroups = foxGroups.filter(g => !g.dead);
      for (const g of glints) g.age += dt;
      glints = glints.filter(g => g.age < g.life);

      // Rare passes: an old freighter and a heavy walker (scaled by traffic)
      if (P.traffic > 0) {
        nextShip -= dt * (0.4 + P.traffic);
        if (nextShip <= 0 && !freighter) { spawnShip(ctx); nextShip = rr(130, 260); if (DBG.includes('shipc')) { freighter.x = ctx.W * 0.55 - Math.cos(freighter.ang) * 190 * 3; freighter.y = ctx.H * 0.55 - Math.sin(freighter.ang) * 190 * 3; } }
        nextWalker -= dt * (0.4 + P.traffic);
        if (nextWalker <= 0 && !walker) { if (spawnWalker(ctx, DBG.includes('walker'))) { nextWalker = rr(260, 420); if (DBG.includes('walker')) {   // test hook: start at the clearest point of its lane
            let bd = -1, bx = walker.x, by = walker.y;
            for (let d = 300; d < ctx.W + 300; d += 20) { const x = walker.x + Math.cos(walker.ang) * d, y = walker.y + Math.sin(walker.ang) * d, c = Math.min(walkerClear(ctx, x, y, walker.ang), 400); if (x > 300 && x < ctx.W - 300 && y > 220 && y < ctx.H - 220 && c > bd) { bd = c; bx = x; by = y; } }
            walker.x = bx - Math.cos(walker.ang) * 60; walker.y = by - Math.sin(walker.ang) * 60; walker.dist = 700; } } else nextWalker = 30; }
      }
      if (freighter) {
        const f = freighter; f.age += dt;
        let sp = f.spd;
        if (pt.active) {   // the cursor: the old ship banks away and pushes the throttle
          const dx = f.x - pt.x, dy = f.y - pt.y, dd = Math.hypot(dx, dy);
          if (dd < 300) { const aw = Math.atan2(dy, dx); let da = Math.atan2(Math.sin(aw - f.ang), Math.cos(aw - f.ang)); f.ang += Math.sign(da) * Math.min(Math.abs(da), 0.45 * dt) * (1 - dd / 300); f.boost = Math.max(f.boost || 0, 1 - dd / 300); }
        }
        if (f.boost) { f.boost = Math.max(0, f.boost - dt * 0.4); sp *= 1 + 0.7 * f.boost; }
        f.x += Math.cos(f.ang) * sp * dt; f.y += Math.sin(f.ang) * sp * dt;
        if (f.age > 2 && (f.x < -300 || f.x > ctx.W + 300 || f.y < -300 || f.y > ctx.H + 300)) freighter = null;
      }
      if (walker) updateWalker(ctx, dt);
      if (P.traffic > 0) {
        nextSD -= dt * (0.4 + P.traffic);
        if (nextSD <= 0 && !destroyer) { spawnDestroyer(ctx, DBG.includes('sd')); nextSD = rr(150, 300); }
      } else destroyer = null;
      if (destroyer) updateDestroyer(ctx, dt);

      updateFight(ctx, dt);
      updateRaiders(ctx, dt);
      updateBolts(ctx, dt);
      updateWeather(ctx, ctx.rawDt);
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
        for (let i = 0; i < strips; i++) { gl.scissor(0, i * sh, ctx.pxW, sh); ctx.fullscreen(progSalt, { uHi: hi, uSunD: L.sunD, uEL: L.el }, { uTex: texPack }, salt); }
        gl.disable(gl.SCISSOR_TEST);
        ctx.fullscreen(progSoil, { uSunD: L.sunD }, { uTex: texPack }, soil);
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
      // The walker's cast shadow goes into a half-resolution mask that the main pass reads (sky light only inside it)
      const wsOn = (!!walker || !!destroyer) && L.dirF > 0.02;
      if (wsOn || !wsClear) {
        ctx.bindTarget(wsT); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        if (wsOn) {
          if (walker) { drawWalkerShadow(ctx); gl.blendEquation(gl.MAX); ctx.flush(); gl.blendEquation(gl.FUNC_ADD); }
          if (destroyer) { const k = destroyer.alt * 0.9; drawDestroyerQuad(ctx, destroyer.x + SH[0] * k, destroyer.y + SH[1] * k, 1, 1, [1, 1, 1]); }
        }
        wsClear = !wsOn;
        ctx.bindTarget(null);
      }
      ctx.fullscreen(progMain, { uHi: hi, uSunI: 1.42, uSunD: L.sunD, uSunC: L.sunC, uSkyC: L.skyC, uSoilLift: L.soilLift, uRefl: L.refl, uReflC: L.reflC, uFogC: L.fogC, uWOff: L.woff, uWD: [L.wdx, L.wdy],
        uWet: L.wet, uRain: L.rain, uSnow: L.snow, uFog: L.fog, uCloud: L.cloud, uWsOn: wsOn ? 1 : 0, uWind: Math.min(2, 0.4 + 0.6 * L.wind), uGlit: L.glit, uDirF: L.dirF },
        { uSalt: salt.tex, uSoil: soil.tex, uPlate: plate.tex, uInfo: info.tex, uScar: scarA.tex, uTex: texPack, uWS: wsT.tex }, null);

      const t = ctx.t, sa = 0.2 + 0.8 * L.dirF, sb = 1 + 2.5 * (1 - L.dirF), sd = (k) => ({ dx: SH[0] * k, dy: SH[1] * k });
      const nearIcon = (x, y) => ctx.clamp((ctx.distAt(x, y) - 6) / 40, 0, 1);
      const SHT = [0.05, 0.045, 0.12];   // cool shadow tint (sky fill)
      const T = L.spr, tn = (c) => [c[0] * T[0], c[1] * T[1], c[2] * T[2]], lamp = L.lamp;

      // Lightning reflected in the water film (under everything that stands on it)
      if (bolt && L.flash > 0.03) {
        const I = L.flash * L.wet;
        for (let i = 0; i < bolt.segs.length; i += 5) { const s = bolt.segs; ctx.glowLine(s[i], s[i + 1], s[i + 2], s[i + 3], 4 * s[i + 4], [0.75, 0.82, 1], 7 * I * s[i + 4], { core: 1.2, coreR: 0.25 }); }
        ctx.glowDot(bolt.x, bolt.y, 260, [0.6, 0.7, 1], 0.35 * I, { core: 0 });
      }

      // Walker: towering, its long cast shadow is already in the ground
      if (walker) drawWalker(ctx, tn([1, 1, 1]), lamp);

      // Crystal foxes (they glow faintly at night)
      for (const gp of foxGroups) for (const f of gp.list) {
        if (lamp > 0.02) ctx.glowDot(f.x, f.y, 16, [0.45, 0.7, 1], 0.9 * lamp, { core: 0.1 });
        ctx.sprite('fox', f.x, f.y, { w: f.w, rot: f.ang, tint: tn([1.05 + 0.6 * lamp, 1.07 + 0.7 * lamp, 1.12 + 0.9 * lamp]), shadow: { ...sd(2.5), alpha: 0.85 * sa, bias: 0.3, tint: SHT } });
        const tw = Math.pow(0.5 + 0.5 * Math.sin(t * 9 + f.ph * 7), 30);
        if (tw > 0.05) ctx.glowDot(f.x + Math.cos(f.ang) * 2, f.y + Math.sin(f.ang) * 2, 3, [0.75, 0.9, 1], 4 * tw * (1 + lamp), { core: 0.8 });
      }
      for (const g of glints) { const k = 1 - g.age / g.life; ctx.glowDot(g.x, g.y, g.s, [0.7, 0.86, 1], 4 * k * k * (1 + lamp), { core: 0.7 }); }

      // Dust shadows, then speeders, then dust
      const dA = (p, e) => { const k = p.age / p.life; return [p.s0 + (p.s1 - p.s0) * Math.sqrt(k), Math.pow(1 - k, e) * Math.min(1, p.age * 5) * (0.3 + 0.7 * nearIcon(p.x, p.y)), k]; };
      for (const p of dust) {
        const [s, a] = dA(p, 1.4), hh = p.h + 2;
        ctx.sprite('dust' + p.v, p.x + SH[0] * hh * 2.2, p.y + SH[1] * hh * 2.2, { w: s * 1.1, alpha: a * 0.4 * sa, tint: [0.12, 0.05, 0.1], flat: 1, bias: 1.2 });
      }
      for (const a of speeders.agents) {
        const wob = a.shake > 0 ? Math.sin(t * 60) * 0.12 * a.shake : 0;
        const bank = ctx.clamp((a.turnRate || 0) * 0.25, -0.3, 0.3);
        ctx.sprite('speeder', a.x, a.y, { w: SP_W, h: SP_W * 0.5 * (1 - Math.abs(bank) * 0.35), rot: a.ang + wob, tint: T, shadow: { ...sd(6), alpha: 0.9 * sa, bias: 0.25, tint: SHT } });
        const c = Math.cos(a.ang + wob), s = Math.sin(a.ang + wob), flick = 0.85 + 0.15 * Math.sin(t * 40 + a.ph), boost = 1 + (a.boost || 0) * 1.2;
        const face = -s * L.sunD[0] + c * L.sunD[1], spH = SP_W * 0.5 * (1 - Math.abs(bank) * 0.35);   // + : the right flank faces the sun
        if (L.dirF > 0.05) ctx.sprite('speederRim', a.x, a.y, { w: SP_W, h: spH * (face >= 0 ? 1 : -1), rot: a.ang + wob, alpha: (0.1 + 0.3 * Math.abs(face)) * Math.min(1, L.dirF), tint: [L.sunC[0] * 0.45, L.sunC[1] * 0.45, L.sunC[2] * 0.45], add: 1 });
        for (const sg of [-1, 1]) {
          const ex = a.x - c * SP_W * 0.34 - s * sg * SP_W * 0.117, ey = a.y - s * SP_W * 0.34 + c * sg * SP_W * 0.117;
          ctx.glowLine(ex, ey, ex - c * 5 * boost, ey - s * 5 * boost, 2.6, [1, 0.45, 0.18], 3.2 * flick * boost * (1 + lamp * 0.6), { core: 0.9 });
        }
        if (lamp > 0.02) {   // headlight pool on the salt ahead
          const hx = a.x + c * SP_W * 0.85, hy = a.y + s * SP_W * 0.85;
          ctx.glowLine(a.x + c * SP_W * 0.45, a.y + s * SP_W * 0.45, hx, hy, 12, [1, 0.93, 0.8], 0.45 * lamp, { core: 0 });
          ctx.glowDot(a.x + c * SP_W * 0.46, a.y + s * SP_W * 0.46, 2, [1, 0.95, 0.85], 3 * lamp);
        }
      }
      for (const p of dust) {
        const [s, a, k] = dA(p, 1.5), tc = p.tint, pale = k * 0.25;
        ctx.sprite('dust' + p.v, p.x, p.y, { w: s, alpha: a * 0.95, tint: tn([tc[0] + (0.95 - tc[0]) * pale, tc[1] + (0.42 - tc[1]) * pale, tc[2] + (0.38 - tc[2]) * pale]) });
      }
      // Low fog banks drift over everything on the ground
      if (L.fog > 0.01) {
        const W = ctx.W, H = ctx.H, n = 12, fc = mul3(L.fogC, 0.62);
        for (let i = 0; i < n; i++) {
          const h1 = (i * 0.618 + 0.13) % 1, h2 = (i * 0.383 + 0.57) % 1, s = 380 + 260 * ((i * 0.71) % 1);
          let x = (h1 * (W + 800) + L.woff[0] * 22) % (W + 800), y = (h2 * (H + 800) + L.woff[1] * 22) % (H + 800);
          if (x < 0) x += W + 800; if (y < 0) y += H + 800;
          ctx.sprite('dust' + (i % 4), x - 400, y - 400, { w: s * 2, alpha: 0.32 * L.fog * (0.5 + 0.5 * nearIcon(x - 400, y - 400)), tint: fc });
        }
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
        ctx.sprite('fighter', f.x + SH[0] * f.alt * 0.55, f.y + SH[1] * f.alt * 0.55, { w: FI_W, rot: f.ang, alpha: 0.72 * sa, tint: SHT, flat: 1, bias: 0.4 });
        ctx.sprite('fighter', f.x, f.y, { w: sz, rot: f.ang, tint: T });
        ctx.glowDot(f.x - Math.cos(f.ang) * sz * 0.16, f.y - Math.sin(f.ang) * sz * 0.16, 3, [1, 0.3, 0.15], 1.5 * (1 + lamp));
      }
      // Resistance strike fighters
      for (const r of raiders) {
        const sz = 46 * (1 + r.alt * 0.0015), fade = Math.min(1, r.age / 0.25) * (1 - ctx.sstep(3, 4, r.age));
        ctx.sprite('xw', r.x + SH[0] * r.alt * 0.55, r.y + SH[1] * r.alt * 0.55, { w: 46, rot: r.ang, alpha: 0.72 * sa * fade, tint: SHT, flat: 1, bias: 0.4 });
        ctx.sprite('xw', r.x, r.y, { w: sz, rot: r.ang, alpha: fade, tint: T });
        const c = Math.cos(r.ang), s = Math.sin(r.ang);
        for (const sg of [-1, 1]) for (const o of [-1, 1]) { const ex = r.x - c * sz * 0.27 - s * sg * sz * (0.13 + 0.03 * o), ey = r.y - s * sz * 0.27 + c * sg * sz * (0.13 + 0.03 * o); ctx.glowDot(ex, ey, 2.4, [1, 0.42, 0.3], 3.5 * fade); }
      }
      // Freighter (highest)
      if (freighter) {
        const f = freighter, sz = FR_W;
        ctx.sprite('freighter', f.x + SH[0] * 120, f.y + SH[1] * 120, { w: sz * 0.97, rot: f.ang, alpha: 0.62 * sa, tint: SHT, flat: 1, bias: 0.6 });
        ctx.sprite('freighter', f.x, f.y, { w: sz, rot: f.ang, tint: tn([0.82, 0.81, 0.79]) });
        const cx = f.x + Math.cos(f.ang) * (-0.06 * sz), cy = f.y + Math.sin(f.ang) * (-0.06 * sz), r = sz * 0.355 * 0.92, eng = (1 + 0.6 * (f.boost || 0)) * (1 + 0.5 * lamp);
        let px = null, py = null;
        for (let k = 0; k <= 8; k++) {
          const a = f.ang + Math.PI * (0.72 + 0.56 * k / 8), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          if (px !== null) ctx.glowLine(px, py, x, y, 5, [0.5, 0.72, 1], 5 * eng * (k === 3 ? 0.55 : 1), { core: 1.2 });   // one sputtering segment
          px = x; py = y;
        }
        if (lamp > 0.02) {   // running lights and a lit cockpit
          const c = Math.cos(f.ang), s = Math.sin(f.ang), at = (fx, fy) => [f.x + c * fx * sz - s * fy * sz, f.y + s * fx * sz + c * fy * sz];
          const blink = Math.sin(t * 2.4) > 0.6 ? 1 : 0.15;
          let q = at(0.5, -0.24); ctx.glowDot(q[0], q[1], 2.4, [1, 0.15, 0.1], 6 * lamp * blink);
          q = at(0.53, 0.24); ctx.glowDot(q[0], q[1], 2.4, [0.2, 1, 0.35], 6 * lamp * blink);
          q = at(0.27, 0.31); ctx.glowDot(q[0], q[1], 5, [1, 0.85, 0.6], 2.5 * lamp);
          q = at(-0.06, 0); ctx.glowDot(q[0], q[1], 3, [1, 1, 1], 5 * lamp * (Math.sin(t * 5.1) > 0.85 ? 1 : 0));
        }
      }
      if (destroyer) drawDestroyer(ctx, lamp, T);
      // Falling snow and rain streaks, seen from above
      if (flakes.length) {
        const fc = tn([1, 1, 1.03]);
        for (const f of flakes) {
          const a = Math.min(1, f.age * 2, (f.life - f.age) * 2, f.z * 4) * 0.9, s = f.s * (0.7 + 0.8 * f.z);
          ctx.sprite('flake', f.x + SH[0] * f.z * 30, f.y + SH[1] * f.z * 30, { w: s * 1.1, alpha: a * 0.25, tint: [0.15, 0.15, 0.25], flat: 1 });
          ctx.sprite('flake', f.x, f.y, { w: s, alpha: a, tint: fc });
        }
      }
      if (drops.length) {
        const dc = mul3(L.reflC, 0.8 + 0.6 * L.flash), ang = Math.atan2(WIND[1] + 0.15, WIND[0] + 0.0001) * 0.25 + 1.2;
        for (const d of drops) { const k = d.age / d.life; ctx.sprite('drop', d.x + Math.cos(ang) * k * 30, d.y + Math.sin(ang) * k * 30, { w: 22, h: 2, rot: ang, alpha: 0.35 * Math.sin(k * Math.PI), tint: dc }); }
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
      if (sdTex) ctx.gl.deleteTexture(sdTex); if (sdProg) ctx.gl.deleteProgram(sdProg.p); sdTex = null; sdProg = null;
    }
  });
})();
