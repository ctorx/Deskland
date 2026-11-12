// Scene ot-empire: Original trilogy, Empire side. "Battle station surface".
// Straight down onto the hull of a moon-sized battle station. Every icon sits in a recessed, lit hangar bay;
// deep trenches cross the hull and connect the bays. Fighter patrols, hull turrets, searchlights and skirmishes.
//
// Pipeline:
//   1. tInfo  (cached): height, bay distance, trench distance, material code. Procedural, full resolution.
//   2. tLit   (cached): lit hull color (key light from the upper left, ray-marched shadows, AO, bay interior light).
//   3. per frame: tLit + animated emissives (windows, beacons, rim lights, conduit pulses, searchlights), then sprites and glows.
(function () {
  const ID = 'ot-empire';
  const MAX_IC = 128, MAX_TR = 32;

  // ---------------------------------------------------------------- GLSL shared by the cache passes and the per-frame pass
  const SH = `
uniform vec4 uIc[${MAX_IC}];
uniform float uIcN;
uniform vec4 uTr[${MAX_TR}];
uniform float uTrD[${MAX_TR}];
uniform float uTrN;
uniform float uM1, uM2, uBayD, uTerD, uCh;

vec2 seedP(vec2 p) { return p + floor(vec2(mod(uSeed * 113.7, 2048.), mod(uSeed * 71.3, 2048.))); }

// Rectilinear (chamfered Chebyshev) distance to the union of icon rectangles: merged, architectural bays
float bayE(vec2 p) {
  float e = 1e4;
  for (int i = 0; i < ${MAX_IC}; i++) {
    if (float(i) >= uIcN) break;
    vec4 r = uIc[i];
    vec2 q = abs(p - r.xy) - r.zw;
    e = min(e, max(max(q.x, q.y), (q.x + q.y - uCh) * 0.70710678));
  }
  return e;
}

// Trench cross-section. f: 0 at the rim, 1 on the center line. Stepped walls so the walls show from straight above.
float trenchProfile(float f, float D) {
  float h = -0.05 * D * smoothstep(0.0, 0.03, f);
  h = mix(h, -0.45 * D, clamp((f - 0.10) / 0.18, 0., 1.));
  h = mix(h, -D, clamp((f - 0.36) / 0.20, 0., 1.));
  return h;
}
float trenchH(vec2 p, out float td, out float ori, out float hwN) {
  float h = 1e4; td = 1e4; ori = 0.; hwN = 1.;
  for (int i = 0; i < ${MAX_TR}; i++) {
    if (float(i) >= uTrN) break;
    vec4 r = uTr[i];
    float hw = max(min(r.z, r.w), 0.5);
    float d = sdBox(p - r.xy, r.zw);
    if (d < td) { td = d; ori = r.z > r.w ? 0. : 1.; hwN = hw; }
    if (d < 0.) h = min(h, trenchProfile(clamp(-d / hw, 0., 1.), uTrD[i]));
  }
  return h;
}

// Large structures, one per 128 px cell. type: 0 none, 1 tower, 2 antenna mast, 3 sensor dish, 4 long block, 5 heat sink array
void bigCell(vec2 bc, out float type, out vec2 o, out vec2 sz) {
  vec3 a = hash32(bc * 1.37 + 71.3); float b = hash12(bc + 23.9);
  float t = a.x;
  type = t < 0.30 ? 0. : t < 0.46 ? 1. : t < 0.56 ? 2. : t < 0.66 ? 3. : t < 0.85 ? 4. : 5.;
  if (type == 1.) sz = floor(mix(vec2(14.), vec2(28.), a.yz));
  else if (type == 2.) sz = vec2(9.);
  else if (type == 3.) sz = vec2(floor(mix(15., 25., a.y)));
  else if (type == 4.) sz = b < 0.5 ? vec2(floor(mix(30., 48., a.y)), floor(mix(8., 13., a.z))) : vec2(floor(mix(8., 13., a.z)), floor(mix(30., 48., a.y)));
  else sz = floor(mix(vec2(16., 12.), vec2(28., 22.), a.yz));
  vec2 room = max(vec2(50.) - sz, 0.);
  o = floor((vec2(hash12(bc + 5.5), hash12(bc + 8.8)) - 0.5) * 2. * room);
}
`;

  // Geometry + material for the cache passes
  const GEO = SH + `
float bigH(vec2 q, float type, vec2 sz, inout float mat, inout float tone, inout float ori) {
  float h = 0.;
  if (type == 1.) {
    float d0 = sdBox(q, sz + 5.); h = 3.5 * clamp(-d0, 0., 1.);
    float d1 = sdBox(q, sz); h = max(h, 13. * clamp(-d1 / 1.4, 0., 1.));
    vec2 s2 = floor(sz * 0.55); float d2 = sdBox(q, s2); h = max(h, 24. * clamp(-d2 / 1.4, 0., 1.));
    float d3 = sdBox(q, vec2(2.5)); h = max(h, 31. * clamp(-d3, 0., 1.));
    // roof boxes on tier 1
    vec2 rc = floor(q / 6.); float rh = hash12(rc + sz);
    float rb = sdBox(mod(q, 6.) - 3., vec2(1.6));
    if (d1 < -4. && d2 > 1.5 && rh > 0.6) h = max(h, (13. + 1.5) * clamp(-rb, 0., 1.));
    if (d1 < 0.) { mat = 1.; tone *= 1.08; }
    if (d1 < 0. && abs(d1 + 2.6) < 0.85 && d2 > 1.5) mat = 2.;
    if (d2 < 0. && abs(d2 + 2.2) < 0.75) mat = 2.;
    if (d3 < 0.) mat = 8.;
  } else if (type == 2.) {
    float d0 = sdBox(q, vec2(7.)); h = 3. * clamp(-d0, 0., 1.);
    float arm = min(sdBox(q, vec2(10., 0.9)), sdBox(q, vec2(0.9, 10.)));
    h = max(h, 3.5 * clamp(-arm * 2., 0., 1.));
    float r = length(q);
    h = max(h, 7. * (1. - smoothstep(3.6, 4.6, r)));
    h = max(h, 48. * (1. - smoothstep(1.5, 2.3, r)));
    if (d0 < 0. || arm < 0.) mat = 1.;
    if (r < 2.3) mat = 8.;
  } else if (type == 3.) {
    float R = sz.x, r = length(q);
    float ped = sdBox(q, vec2(R + 5.));
    h = 2.5 * clamp(-ped, 0., 1.);
    float rim = 8. * (1. - smoothstep(0.8, 2.4, abs(r - R)));
    float bowl = r < R ? 1.5 + 6. * (r / R) * (r / R) : 0.;
    h = max(h, max(rim, bowl));
    float feed = min(sdSegment(q, vec2(0.), vec2(R * 0.7, -R * 0.7) * 0.7), sdSegment(q, vec2(0.), vec2(-R * 0.7, -R * 0.7) * 0.7));
    h = max(h, 10. * (1. - smoothstep(1.6, 2.6, r)));
    h = max(h, 8. * (1. - smoothstep(0.5, 1.2, feed)) * step(r, R));
    if (r < R + 2.5) { mat = 1.; tone *= 1.18; }
  } else if (type == 4.) {
    float d = sdBox(q, sz); h = 11. * clamp(-d / 1.4, 0., 1.);
    bool hor = sz.x > sz.y; vec2 qq = hor ? q : q.yx; vec2 ss = hor ? sz : sz.yx;
    float cell = floor(qq.x / 7.); float rb = hash11(cell * 3.1 + ss.x * 0.7 + ss.y);
    float rbox = sdBox(vec2(mod(qq.x, 7.) - 3.5, qq.y - (rb - 0.5) * 3.), vec2(2.2, ss.y - 4.5 - rb * 2.));
    if (rb > 0.45 && abs(qq.x) < ss.x - 4.) h = max(h, (12.5 + rb * 3.) * clamp(-rbox, 0., 1.));
    if (d < 0.) { mat = 1.; tone *= 0.92; }
    if (d < 0. && abs(d + 2.3) < 0.8) { mat = 2.; ori = hor ? 0. : 1.; }
  } else if (type == 5.) {
    float d = sdBox(q, sz);
    h = 2. * clamp(-(d - 2.5), 0., 1.);
    if (d < 0.) { h = max(h, 1.5 + 5. * step(0.42, fract(q.x / 3.5)) * clamp(-d, 0., 1.)); mat = 11.; }
  }
  return h;
}

// Full surface: height (px, up), material code and albedo
float scene(vec2 p, float e, out float mat, out vec3 alb, out float ori, out float td) {
  vec2 sp = seedP(p);
  mat = 0.; ori = 0.;
  // --- hull sectors and plate patchwork
  vec2 sid = floor(sp / 256.), sf = sp - sid * 256.;
  float hs = hash12(sid + 3.1);
  float base = (hs - 0.5) * 2.5;
  float big = fbm(sp * 0.0022 + 7.3, 3);
  float dens = smoothstep(0.3, 0.7, fbm(sp * 0.0035 + 2.1, 3));
  float tone = (0.78 + 0.34 * hs) * (0.85 + 0.3 * big);
  vec2 se = min(sf, 256. - sf); float sd = min(se.x, se.y);
  base -= 2.6 * (1. - smoothstep(1.0, 2.6, sd));
  vec2 pc = floor(sp / 64.), pf = sp - pc * 64.;
  vec3 hp = hash32(pc + 17.);
  float sx = floor(mix(16., 48., hp.x) / 4.) * 4.;
  float sL = step(pf.x, sx);
  float sy = floor(mix(12., 52., sL > 0.5 ? hp.y : hp.z) / 4.) * 4.;
  vec2 lo = vec2(sL > 0.5 ? 0. : sx, pf.y < sy ? 0. : sy);
  vec2 hi = vec2(sL > 0.5 ? sx : 64., pf.y < sy ? sy : 64.);
  vec2 pid = pc * 4. + vec2(sL, step(sy, pf.y));
  float hpan = hash12(pid + 5.3);
  vec2 dl = min(pf - lo, hi - pf); float ps = min(dl.x, dl.y);
  base += (hpan - 0.5) * 1.4 * smoothstep(0.6, 2.0, ps);
  base -= 0.9 * (1. - smoothstep(0.35, 1.1, ps));
  tone *= 0.62 + 0.76 * hpan * hpan + 0.1 * hpan;
  if (hpan > 0.92) tone *= 0.62;
  // larger quilted patches (the classic patchwork of plate tones)
  vec2 qc = floor(sp / vec2(128., 64.));
  float hq = hash12(qc + 0.7);
  tone *= hq > 0.8 ? 0.72 : hq < 0.12 ? 1.18 : 1.;
  if (hpan < 0.05) tone *= 1.25;
  // fine plate lines inside some panels
  float lines = hash12(pid + 1.7) > 0.7 ? (1. - smoothstep(0.2, 0.7, abs(fract((hp.x > 0.5 ? sp.x : sp.y) / 4.) - 0.5) * 4.)) : 0.;
  base -= 0.35 * lines * step(2., ps);

  // --- medium greebles, 32 px cells
  vec2 gc = floor(sp / 32.), gf = sp - gc * 32. - 16.;
  vec4 hg = vec4(hash32(gc + 41.7), hash12(gc + 9.1));
  float gh = 0., gmat = 0.;
  float gt = hg.x * mix(1.45, 0.9, dens);
  if (gt < 0.26) {
    vec2 b = floor(mix(vec2(3.), vec2(11.), hg.yz));
    vec2 o = floor((hg.wy - 0.5) * 2. * max(vec2(13.) - b, 0.));
    float d = sdBox(gf - o, b);
    float hh = 2. + hg.w * 5.;
    gh = hh * clamp(-d / 1.1, 0., 1.);
    gh -= 0.6 * step(d, -2.) * step(-2.8, d);
    if (d < 0.) gmat = 1.;
    if (d < 0. && hg.z > 0.75) { float d2 = sdBox(gf - o, b * 0.5); gh = max(gh, (hh + 2.) * clamp(-d2, 0., 1.)); }
  } else if (gt < 0.36) {
    bool hv = hg.y > 0.5;
    vec2 b = hv ? vec2(11., 6.) : vec2(6., 11.);
    float d = sdBox(gf, b);
    if (d < 0.) { float sl = hv ? gf.x : gf.y; gh = -2.2 + 1.6 * step(0.5, fract(sl / 2.5)) * step(d, -1.); gmat = 9.; }
    gh = max(gh, 1.2 * clamp(-(d - 1.5), 0., 1.) * step(0., d));
  } else if (gt < 0.43) {
    float r = length(gf);
    gh = -1.3 * (1. - smoothstep(0., 0.9, abs(r - 7.5) - 0.5)) + 0.9 * (1. - smoothstep(5.3, 6.3, r));
    if (r < 6.3) gmat = 1.;
  } else if (gt < 0.49) {
    float r = length(gf - (hg.yz - 0.5) * 12.) / (3. + hg.w * 3.);
    gh = r < 1. ? 4.5 * sqrt(1. - r * r) : 0.; if (r < 1.) gmat = 1.;
  } else if (gt < 0.58) {
    float ax = hg.y > 0.5 ? gf.y : gf.x;
    float a1 = abs(ax - 3.2) / 2.4, a2 = abs(ax + 3.2) / 2.4, a = min(a1, a2);
    gh = a < 1. ? 2.6 * sqrt(1. - a * a) : 0.;
    if (a < 1.) gmat = 3.5;
  } else if (gt < 0.66) {
    bool hv = hg.y > 0.5;
    vec2 b = hv ? vec2(13., 4.) : vec2(4., 13.);
    float d = sdBox(gf, b);
    gh = 3.5 * clamp(-d / 1.2, 0., 1.);
    if (d < 0.) gmat = 1.;
    if (d < -1.2 && d > -2.6) { gmat = 2.; ori = hv ? 0. : 1.; }
  }
  // small greebles, 8 px cells
  vec2 kc = floor(sp / 8.), kf = sp - kc * 8. - 4.;
  vec3 hk = hash32(kc + 3.3);
  if (hk.x > 0.82) {
    vec2 b = floor(mix(vec2(1.), vec2(3.), hk.yz));
    float d = sdBox(kf, b);
    float kh = 1. + hk.y * 1.6;
    if (kh * clamp(-d / 0.8, 0., 1.) > gh) { gh = kh * clamp(-d / 0.8, 0., 1.); if (d < 0.) gmat = 1.; }
  }

  // --- conduits: long pipes along some 32 px rows / columns
  float ch = 0., cmat = 0., cori = 0.;
  float rowH = hash11(floor(sp.y / 32.) * 1.71 + 3.);
  if (rowH > 0.95) { float a = abs(mod(sp.y, 32.) - 16.) / 3.6; if (a < 1.) { ch = 4.6 * sqrt(1. - a * a); cmat = 3.; cori = 0.; } }
  float colH = hash11(floor(sp.x / 32.) * 2.37 + 9.);
  if (colH > 0.96) { float a = abs(mod(sp.x, 32.) - 16.) / 3.6; if (a < 1.) { float c2 = 4.6 * sqrt(1. - a * a) + 0.3; if (c2 > ch) { ch = c2; cmat = 3.; cori = 1.; } } }

  // --- large structures
  vec2 bc = floor(sp / 128.), bfq = sp - bc * 128. - 64.;
  float bt; vec2 bo, bsz; bigCell(bc, bt, bo, bsz);
  float bmat = 0., btone = 1., bori = 0.;
  float bh = bt > 0. ? bigH(bfq - bo, bt, bsz, bmat, btone, bori) : 0.;

  // --- compose hull, flatten details near bays and trenches
  float tdd, tori, thw;
  float hT = trenchH(p, tdd, tori, thw);
  td = tdd;
  float clean = smoothstep(uM2 + 4., uM2 + 22., e) * smoothstep(2., 18., tdd);
  float detail = 0.; float dmat = 0.;
  if (gh > detail) { detail = gh; dmat = gmat; }
  if (ch > detail - 0.2 && ch > 0.) { detail = max(detail, ch); dmat = cmat; ori = cori; }
  if (bh > detail - 0.1 && bh > 0.4) { detail = max(detail, bh); dmat = bmat; tone *= btone; ori = bori; }
  else if (gh < 0. && ch <= 0.) { detail = gh; dmat = gmat; }
  float hull = base + detail * clean;
  mat = clean > 0.5 ? dmat : 0.;
  if (mat == 3.5) mat = 1.;

  // --- bay terraces
  float h = hull;
  float bayCap = 1e4;
  if (e < uM2 + 3.) {
    float terr = -uTerD + 0.6 * (hash12(floor(sp / 16.)) - 0.5) * step(0.8, min(abs(fract(sp.x / 16.) - 0.5), abs(fract(sp.y / 16.) - 0.5)) * 16.);
    bayCap = e < uM1 ? -uBayD : e < uM1 + 3. ? mix(-uBayD, terr, (e - uM1) / 3.) : e < uM2 ? terr : mix(terr, 0., (e - uM2) / 3.);
    if (bayCap < h) { h = bayCap; mat = 4.; }
  }
  // --- trenches
  float f = clamp(-tdd / thw, 0., 1.);
  if (hT < h - 0.01) {
    float D = -trenchProfile(1., 1.);
    float sAl = tori < 0.5 ? sp.x : sp.y;
    // wall greebles: little blocks along the walls
    float wc = floor(sAl / 12.); float wr = hash11(wc * 1.3 + floor(f * 6.));
    float wallJit = (wr - 0.5) * 2. * step(0.45, wr) * step(2., 12. - abs(mod(sAl, 12.) - 6.) * 2.);
    h = hT;
    if (f < 0.03) mat = 6.;
    else if (f < 0.10) mat = 10.;
    else if (f < 0.28) { mat = 6.; h += wallJit * 3.; if (abs(f - 0.19) < 0.02 && hash11(floor(sAl / 40.) + 3.) > 0.4) mat = 2.; }
    else if (f < 0.36) { mat = hash11(floor(sAl / 30.) + 7.) > 0.55 ? 2. : 6.; h += wallJit * 1.; }
    else if (f < 0.56) { mat = 6.; h += wallJit * 3.5; }
    else { mat = 7.; if (f > 0.97) mat = 12.;
      float fb = hash11(floor(sAl / 22.) * 1.9 + 3.);
      if (fb > 0.55 && f > 0.62 && f < 0.84) h += 3. * clamp((7. - abs(mod(sAl, 22.) - 11.)), 0., 1.);
      // twin rails along the center line, floor plate seams across
      float rl = abs(f - 0.9) / 0.03; if (rl < 1.) h += 2.2 * sqrt(1. - rl * rl);
      if (abs(mod(sAl, 28.) - 14.) > 13.4) h -= 0.8;
    }
    ori = tori;
  }
  // --- bay floor wins inside the bay
  if (e < uM1 + 0.5) { h = -uBayD; mat = 5.; }

  // --- albedo
  float grime = 0.82 + 0.3 * fbm(sp * 0.018, 4) + 0.12 * (vnoise(sp * 0.35) - 0.5);
  vec3 steel = vec3(0.22, 0.24, 0.28);
  vec3 c = steel * tone * grime;
  if (mat == 1.) c *= hash12(gc + 2.) > 0.5 ? 1.12 : 0.86;
  else if (mat == 2.) c = vec3(0.06, 0.065, 0.075);
  else if (mat == 3.) c = vec3(0.30, 0.33, 0.38) * grime;
  else if (mat == 8.) c = vec3(0.22, 0.23, 0.25);
  else if (mat == 9.) c = vec3(0.06, 0.06, 0.065);
  else if (mat == 11.) c = vec3(0.30, 0.32, 0.36) * grime;
  else if (mat == 4.) {
    vec2 g = abs(fract(sp / 16.) - 0.5) * 16.;
    c = vec3(0.25, 0.265, 0.30) * (0.88 + 0.24 * hash12(floor(sp / 16.))) * grime * (min(g.x, g.y) < 0.6 ? 0.6 : 1.);
  } else if (mat == 5.) {
    vec2 g = abs(fract((sp + 12.) / 24.) - 0.5) * 24.;
    c = vec3(0.12, 0.115, 0.11) * (0.85 + 0.3 * hash12(floor(sp / 24.))) * (min(g.x, g.y) < 0.6 ? 0.55 : 1.);
    float paint = (1. - smoothstep(0.5, 1.1, abs(e - uM1 * 0.45))) * step(0.5, fract((p.x + p.y) / 14.));
    c = mix(c, vec3(0.42, 0.3, 0.1), paint * 0.6);
  } else if (mat == 6. || mat == 10.) c = steel * 0.78 * grime * (0.85 + 0.3 * hash12(floor(sp / 9.)));
  else if (mat == 7. || mat == 12.) c = steel * 0.5 * grime;
  alb = c;
  return h;
}
`;

  // ---------------------------------------------------------------- Pass 1: geometry info
  const FS_INFO = GEO + `
void main() {
  vec2 p = cssPos();
  float e = bayE(p);
  float mat, ori, td; vec3 alb;
  float h = scene(p, e, mat, alb, ori, td);
  outColor = vec4(h, min(e, 2000.), min(td, 2000.), mat + ori * 16.);
}`;

  // ---------------------------------------------------------------- Pass 2: lighting
  const FS_LIT = GEO + `
uniform sampler2D uInfo;
uniform float uSteps, uStepK;
vec2 uvOf(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
float Hs(vec2 p) { return texture(uInfo, uvOf(p)).r; }
void main() {
  vec2 p = cssPos();
  vec4 inf = texture(uInfo, vUv);
  float e = inf.g;
  float mat, ori, td; vec3 alb;
  float h = scene(p, e, mat, alb, ori, td);
  h = inf.r;
  float ex = 0.7;
  float hx = (Hs(p + vec2(ex, 0.)) - Hs(p - vec2(ex, 0.))) / (2. * ex);
  float hy = (Hs(p + vec2(0., ex)) - Hs(p - vec2(0., ex))) / (2. * ex);
  vec3 n = normalize(vec3(-hx, -hy, 1.));
  vec3 L = normalize(vec3(-1., -1., 0.75));
  vec2 ld = normalize(vec2(-1., -1.));
  float tanE = L.z / length(L.xy);
  // shadow ray march toward the light
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float sh = 1., s = 0.35 + 0.7 * ign;
  for (int i = 0; i < 96; i++) {
    if (float(i) >= uSteps) break;
    float dz = Hs(p + ld * s) - (h + s * tanE);
    sh = min(sh, clamp(1. - dz / (0.4 + s * 0.05), 0., 1.));
    if (sh <= 0.) break;
    s += (0.7 + s * uStepK) * (0.75 + 0.5 * ign);
  }
  // ambient occlusion from the height field
  float occ = 0.;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398 + 0.3;
    vec2 d = vec2(cos(a), sin(a));
    occ += max(Hs(p + d * 3.) - h, 0.) * 0.10 + max(Hs(p + d * 10.) - h, 0.) * 0.035 + max(Hs(p + d * 26.) - h, 0.) * 0.012;
  }
  float ao = exp(-occ * 0.3);
  float dif = max(dot(n, L), 0.);
  vec3 Hh = normalize(L + vec3(0., 0., 1.));
  float spec = pow(max(dot(n, Hh), 0.), 36.) * (1. - n.z * 0.6);
  vec3 key = vec3(1.0, 0.95, 0.88) * 2.0;
  vec3 amb = vec3(0.06, 0.085, 0.15) * (0.55 + 0.45 * n.z) * ao;
  // faint cool bounce from below-right fills the shadow side
  float bounce = max(dot(n, normalize(vec3(1., 1., 0.4))), 0.) * 0.06;
  vec3 col = alb * (key * dif * sh * mix(0.75, 1., ao) + amb + vec3(0.5, 0.6, 0.8) * bounce * ao);
  float specM = (mat == 2. || mat == 9. || mat == 5.) ? 0.15 : 1.;
  col += key * spec * sh * 0.45 * specM;
  // depth haze: deep areas fade into blue-black
  float depth = clamp(-h / 95., 0., 1.);
  if (mat != 5.) col = mix(col, vec3(0.02, 0.03, 0.055), pow(depth, 1.6) * 0.7);
  // cool bounce light inside the trenches so the floor detail still reads in the shadow
  col += alb * vec3(0.22, 0.32, 0.6) * smoothstep(0.25, 0.9, depth) * (0.35 + 0.65 * ao) * 0.9;
  // bay interior: warm light, brighter near the walls, spilling out onto the terrace
  if (mat == 5.) {
    float dw = max(uM1 - e, 0.);
    vec2 ge = vec2(dFdx(e), dFdy(e));
    float al = abs(ge.x) > abs(ge.y) ? p.y : p.x;
    float pool = 0.55 + 0.45 * cos(al * 6.2832 / 38.);
    float wall = exp(-dw / 8.) * pool + 0.35 * exp(-dw / 30.);
    vec3 warm = vec3(1.0, 0.56, 0.26);
    float pad = hash12(floor((p + 12.) / 48.));
    col = col * 0.55 * (0.8 + 0.4 * pad) + alb * warm * (0.1 + 2.2 * wall) * mix(0.6, 1., ao);
  } else if (e < uM2 + 10.) {
    float spill = exp(-max(e - uM1, 0.) / 7.) * smoothstep(uM2 + 10., uM2, e);
    col += alb * vec3(1.0, 0.55, 0.25) * spill * 0.8;
  }
  outColor = vec4(col, 1.);
}`;

  // ---------------------------------------------------------------- Pass 3: per-frame composite with animated lights
  const FS_COMP = SH + `
uniform sampler2D uLit, uInfo;
uniform vec4 uSL[4];
uniform float uLights;
vec2 uvOf(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
void main() {
  vec2 p = cssPos();
  vec3 col = texture(uLit, vUv).rgb;
  vec4 inf = texture(uInfo, vUv);
  float h = inf.r, e = inf.g, td = inf.b;
  float code = inf.a + 0.01;
  float ori = step(15.5, code);
  float mat = floor(code - ori * 16.);
  float t = uFlow;
  vec2 sp = seedP(p);
  float on = uLights * smoothstep(0., 1., uIntro * 2.2 - 1.0 - 0.8 * hash12(floor(sp / 96.)));
  vec3 em = vec3(0.);
  // windows
  if (mat == 2.) {
    vec2 c = floor(sp / 3.); float r = hash12(c);
    vec2 f = abs(fract(sp / 3.) - 0.5);
    float sq = 1. - smoothstep(0.24, 0.36, max(f.x, f.y));
    float lit = step(r, 0.42 + 0.12 * sin(t * 0.05 + r * 40.));
    vec3 wc = mix(vec3(1.0, 0.82, 0.55), vec3(0.65, 0.82, 1.0), step(0.72, hash12(c + 3.)));
    em += wc * sq * lit * (2.2 + 2.5 * hash12(c + 9.));
  }
  // trench rim lights: amber markers with a red chaser running along the trench
  if (mat == 10.) {
    float s = ori < 0.5 ? sp.x : sp.y;
    float k = floor(s / 14.);
    float dt_ = 1. - smoothstep(0.08, 0.16, abs(fract(s / 14.) - 0.5));
    float ph = fract(k * 0.045 - t * 0.35 + hash11(floor(s / 600.)));
    float chase = smoothstep(0.86, 1.0, ph);
    em += dt_ * (vec3(1.0, 0.55, 0.2) * 0.9 + vec3(1.0, 0.08, 0.04) * 9. * chase);
  }
  // trench floor guide lights
  if (mat == 12.) {
    float s = ori < 0.5 ? sp.x : sp.y;
    float dt_ = 1. - smoothstep(0.03, 0.06, abs(fract(s / 40.) - 0.5));
    float ph = fract(floor(s / 40.) * 0.05 + t * 0.4);
    em += dt_ * vec3(0.5, 0.75, 1.0) * (0.5 + 3.5 * smoothstep(0.85, 1., ph));
  }
  // conduit energy pulses
  if (mat == 3.) {
    float s = ori < 0.5 ? sp.x : sp.y;
    float lane = ori < 0.5 ? floor(sp.y / 32.) : floor(sp.x / 32.);
    float ph = fract(s / 520. - t * 0.22 + hash11(lane * 3.7));
    float pl = smoothstep(0.975, 0.997, ph) * (1. - smoothstep(0.997, 1.0, ph));
    em += vec3(0.35, 0.7, 1.0) * (pl * 3. + 0.05);
  }
  // vents and heat sinks: slow, dim heat glow
  if (mat == 9. || mat == 11.) {
    float r = hash12(floor(sp / 32.));
    em += vec3(1.0, 0.32, 0.08) * (mat == 9. ? 0.55 : 0.18) * (0.35 + 0.65 * (0.5 + 0.5 * sin(t * (0.4 + r) + r * 30.)));
  }
  // bay rim landing lights (outer terrace edge) and inner lip lights
  if (e < uM2 + 4. && e > uM1 - 2.) {
    vec2 g = vec2(dFdx(e), dFdy(e));
    float s = abs(g.x) > abs(g.y) ? p.y : p.x;
    float band = 1. - smoothstep(0.5, 1.2, abs(e - (uM2 - 3.)));
    float dotA = 1. - smoothstep(0.1, 0.17, abs(fract(s / 11.) - 0.5));
    float ph = fract(floor(s / 11.) * 0.06 - t * 0.6);
    em += band * dotA * vec3(1.0, 0.6, 0.22) * (1.4 + 3.5 * smoothstep(0.75, 1.0, ph));
    float band2 = 1. - smoothstep(0.4, 1.0, abs(e - (uM1 + 1.5)));
    float dotB = 1. - smoothstep(0.08, 0.16, abs(fract(s / 8. + 0.5) - 0.5));
    em += band2 * dotB * vec3(0.75, 0.88, 1.0) * 1.6;
  }
  // beacons on towers and masts (one structure per 128 px cell)
  {
    vec2 bc = floor(sp / 128.);
    float bt; vec2 bo, bsz; bigCell(bc, bt, bo, bsz);
    vec2 bpos = bc * 128. + 64. + bo;
    vec2 bps = bpos - (sp - p);
    if (bt == 1. || bt == 2.) {
      float alive = step(abs(texture(uInfo, uvOf(bps)).a - 8.), 0.5);
      float d = length(sp - bpos);
      float r = hash12(bc + 4.4);
      float per = bt == 2. ? 2.2 : 3.1;
      float ph = fract(t / per + r);
      float blink = bt == 2. ? smoothstep(0.0, 0.03, ph) * (1. - smoothstep(0.25, 0.32, ph))
                             : smoothstep(0.0, 0.01, ph) * (1. - smoothstep(0.05, 0.08, ph)) + smoothstep(0.12, 0.13, ph) * (1. - smoothstep(0.16, 0.19, ph));
      vec3 bcol = bt == 2. ? vec3(1.0, 0.07, 0.04) : vec3(0.9, 0.95, 1.0);
      em += alive * bcol * blink * (14. * exp(-d * d / 2.2) + 0.9 * exp(-d / 5.));
    } else if (bt == 4.) {
      bool hor = bsz.x > bsz.y;
      vec2 ax = hor ? vec2(bsz.x - 3., 0.) : vec2(0., bsz.y - 3.);
      float alive = step(abs(texture(uInfo, uvOf(bps)).a - 1.), 0.5) + step(abs(texture(uInfo, uvOf(bps)).a - 17.), 0.5);
      float r = hash12(bc + 6.1);
      float ph = fract(t * 0.45 + r);
      float d1 = length(sp - bpos - ax), d2 = length(sp - bpos + ax);
      float b1 = smoothstep(0., 0.04, ph) * (1. - smoothstep(0.18, 0.24, ph));
      float b2 = smoothstep(0.5, 0.54, ph) * (1. - smoothstep(0.68, 0.74, ph));
      em += clamp(alive, 0., 1.) * vec3(1.0, 0.1, 0.05) * (b1 * exp(-d1 * d1 / 1.6) + b2 * exp(-d2 * d2 / 1.6)) * 10.;
    }
  }
  col += em * on;
  // searchlights sweeping the hull
  for (int i = 0; i < 4; i++) {
    vec4 L = uSL[i];
    if (L.w <= 0.001) continue;
    vec2 d = p - L.xy; float dist = length(d);
    float a = atan(d.y, d.x) - L.z; a = atan(sin(a), cos(a));
    float cone = (1. - smoothstep(0.06, 0.15, abs(a))) * smoothstep(460., 80., dist) * smoothstep(6., 30., dist);
    float spot = exp(-pow((dist - 280.) / 80., 2.)) * 0.8 + 0.35;
    cone *= spot * smoothstep(uM2, uM2 + 30., e);
    col += (col * 2.2 + vec3(0.012, 0.016, 0.025)) * cone * vec3(0.8, 0.9, 1.0) * L.w;
  }
  // curvature of the station: light falls off toward the lower right, distance haze
  vec2 uvn = p / uRes;
  float g = clamp(uvn.x * 0.55 + uvn.y * 0.45, 0., 1.);
  col *= mix(1.12, 0.78, g);
  col = mix(col, vec3(0.06, 0.08, 0.13) * 0.8, g * g * 0.14);
  // very slow drifting atmosphere glints (exhaust venting) over the hull
  float haze = fbm(p * 0.0025 + vec2(t * 0.012, -t * 0.007) + uSeed, 3);
  col = mix(col, vec3(0.05, 0.065, 0.1), smoothstep(0.5, 0.85, haze) * 0.18);
  outColor = vec4(col, 1.);
}`;

  // ---------------------------------------------------------------- state
  let progInfo = null, progLit = null, progComp = null, tInfo = null, tLit = null;
  let dirty = true, pendingFinal = false, frameK = 0;
  const icU = new Float32Array(MAX_IC * 4), trU = new Float32Array(MAX_TR * 4), trD = new Float32Array(MAX_TR);
  let icN = 0, trN = 0;
  let oldRects = [], newRects = [], dispRects = [], pairs = [];
  let trenches = [];          // {key, horiz, c, a, b, hw, hwT, depth, kind}
  let turrets = [], searchlights = [];
  let flock = null, ships = [], bolts = [], flashes = [], sparks = [];
  let runT = 2, fightT = 3, uParams = { m1: 13, m2: 31, bayD: 26, terD: 11, ch: 3 };
  let rnd = Math.random;

  const P_ = ctx => ctx.P;
  function margins(ctx) {
    const s = ctx.P.sigma, ib = ctx.intro;
    const e = ib * ib * (3 - 2 * ib);
    const m1 = (10 + s * 0.14) * e, m2 = m1 + (10 + s * 0.18) * e;
    return { m1, m2, bayD: 42 * e, terD: 15 * e, ch: Math.max(0, 0.586 * m1 - 5) };
  }
  const iconRect = ic => ({ cx: ic.x + ic.w / 2, cy: ic.y + ic.h / 2, hw: Math.max(6, ic.w / 2 - 4), hh: Math.max(6, ic.h / 2 - 4) });

  // ---------------------------------------------------------------- trench network
  function chebGap(a, b) { return Math.max(Math.abs(a.cx - b.cx) - a.hw - b.hw, Math.abs(a.cy - b.cy) - a.hh - b.hh); }
  function buildTrenches(ctx) {
    const W = ctx.W, H = ctx.H, r = ctx.rng(11), m = margins({ P: ctx.P, intro: 1 });
    const list = [];
    const rects = newRects;
    const iconHit = (x0, y0, x1, y1, pad) => rects.some(q => q.cx + q.hw + pad > x0 && q.cx - q.hw - pad < x1 && q.cy + q.hh + pad > y0 && q.cy - q.hh - pad < y1);
    // Long trenches depend only on the seed, so they never jump when icons move
    const hy = Math.round(H * (0.28 + 0.44 * r()));
    list.push({ key: 'LH', kind: 'long', horiz: true, c: hy, a: -300, b: W + 300, hw: 54, depth: 90 });
    const vx = Math.round(W * (0.38 + 0.46 * r()));
    list.push({ key: 'LV', kind: 'long', horiz: false, c: vx, a: -300, b: H + 300, hw: 46, depth: 84 });
    if (r() < 0.65) {
      let y2 = hy < H / 2 ? hy + H * (0.3 + 0.15 * r()) : hy - H * (0.3 + 0.15 * r());
      y2 = Math.round(Math.min(H - 70, Math.max(70, y2)));
      const fromLeft = r() < 0.5;
      list.push({ key: 'LH2', kind: 'long2', horiz: true, c: y2, a: fromLeft ? -300 : vx, b: fromLeft ? vx : W + 300, hw: 34, depth: 64 });
    }
    // Clusters of icons whose bays merge
    const n = rects.length, parent = rects.map((_, i) => i);
    const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (chebGap(rects[i], rects[j]) < 2 * m.m2) parent[find(i)] = find(j);
    const groups = {};
    rects.forEach((q, i) => { const k = find(i); (groups[k] = groups[k] || []).push(q); });
    for (const k in groups) {
      const g = groups[k];
      const x0 = Math.min(...g.map(q => q.cx - q.hw)) - m.m2, x1 = Math.max(...g.map(q => q.cx + q.hw)) + m.m2;
      const y0 = Math.min(...g.map(q => q.cy - q.hh)) - m.m2, y1 = Math.max(...g.map(q => q.cy + q.hh)) + m.m2;
      const crossed = list.some(t => t.kind !== 'spur' && (t.horiz ? (t.c + t.hw > y0 && t.c - t.hw < y1 && t.b > x0 && t.a < x1) : (t.c + t.hw > x0 && t.c - t.hw < x1 && t.b > y0 && t.a < y1)));
      if (crossed) continue;
      // Spur to the nearest long trench, perpendicular to it
      const cands = [];
      for (const t of list) {
        if (t.kind === 'spur') continue;
        if (t.horiz) {
          const x = Math.round((x0 + x1) / 2 / 8) * 8;
          if (x < t.a || x > t.b) continue;
          const up = t.c < y0, from = up ? y0 + 12 : y1 - 12, len = Math.abs(t.c - from);
          cands.push({ len, s: { kind: 'spur', horiz: false, c: x, a: Math.min(from, t.c), b: Math.max(from, t.c), hw: 26, depth: 54 } });
        } else {
          const y = Math.round((y0 + y1) / 2 / 8) * 8;
          if (y < t.a || y > t.b) continue;
          const left = t.c < x0, from = left ? x0 + 12 : x1 - 12, len = Math.abs(t.c - from);
          cands.push({ len, s: { kind: 'spur', horiz: true, c: y, a: Math.min(from, t.c), b: Math.max(from, t.c), hw: 26, depth: 54 } });
        }
      }
      cands.sort((a, b) => a.len - b.len);
      if (cands.length && cands[0].len < Math.max(W, H) * 0.55) {
        const s = cands[0].s; s.key = 'S' + s.horiz + s.c + ':' + Math.round(s.a) + ':' + Math.round(s.b); list.push(s);
      }
    }
    // A few dead-end side trenches off the long ones for texture (never under icons)
    for (let k = 0; k < 4; k++) {
      const t = list[r() < 0.5 ? 0 : 1];
      const len = 140 + r() * 260, side = r() < 0.5 ? -1 : 1;
      const pos = Math.round((t.horiz ? W : H) * (0.1 + 0.8 * r()) / 8) * 8;
      const a = side < 0 ? t.c - len : t.c, b = side < 0 ? t.c : t.c + len;
      const s = { kind: 'side', horiz: !t.horiz, c: pos, a, b, hw: 20, depth: 44, key: 'D' + k };
      const box = s.horiz ? [a, pos - 20, b, pos + 20] : [pos - 20, a, pos + 20, b];
      if (!iconHit(box[0], box[1], box[2], box[3], m.m2 + 24)) list.push(s);
    }
    // Merge into the animated list: new trenches open up, removed ones close
    const byKey = {};
    for (const t of trenches) byKey[t.key] = t;
    for (const t of trenches) t.hwT = 0;
    for (const s of list) {
      const o = byKey[s.key];
      if (o) { Object.assign(o, s, { hw: o.hw, hwT: s.hw }); }
      else trenches.push(Object.assign(s, { hwT: s.hw, hw: trenches.length === 0 || s.kind === 'long' || s.kind === 'long2' ? s.hw : 0 }));
    }
  }

  // ---------------------------------------------------------------- turrets and searchlights
  function inTrench(x, y, pad) {
    for (const t of trenches) {
      if (t.hwT <= 0) continue;
      const along = t.horiz ? x : y, across = t.horiz ? y : x;
      if (along > t.a - pad && along < t.b + pad && Math.abs(across - t.c) < t.hwT + pad) return t;
    }
    return null;
  }
  function iconDistRect(x, y) {
    let d = 1e9;
    for (const q of newRects) d = Math.min(d, Math.max(Math.abs(x - q.cx) - q.hw, Math.abs(y - q.cy) - q.hh));
    return d;
  }
  function placeTurrets(ctx) {
    const r = ctx.rng(23), W = ctx.W, H = ctx.H;
    const want = Math.round(7 + 7 * (W * H) / (1920 * 1080));
    const out = [];
    const ok = (x, y) => iconDistRect(x, y) > 70 && !inTrench(x, y, 16) && out.every(t => Math.hypot(t.x - x, t.y - y) > 170);
    // Some along the long trench rims (they matter for trench runs)
    for (const t of trenches) {
      if (t.kind !== 'long') continue;
      for (let k = 0; k < 6; k++) {
        const along = (t.horiz ? W : H) * (0.08 + 0.84 * r()), side = r() < 0.5 ? -1 : 1, across = t.c + side * (t.hwT + 16);
        const x = t.horiz ? along : across, y = t.horiz ? across : along;
        if (x > 20 && y > 20 && x < W - 20 && y < H - 20 && ok(x, y)) out.push({ x, y, ang: r() * 6.28, fireT: r(), idle: r() * 6.28 });
        if (out.length > want * 0.45) break;
      }
    }
    for (let k = 0; k < 400 && out.length < want; k++) {
      const x = 30 + r() * (W - 60), y = 30 + r() * (H - 60);
      if (ok(x, y)) out.push({ x, y, ang: r() * 6.28, fireT: r(), idle: r() * 6.28 });
    }
    turrets = out;
    searchlights = turrets.slice(0, 4).map((t, i) => ({ t, ph: r() * 100, sp: 0.18 + r() * 0.15, base: r() * 6.28, on: r() * 100 }));
  }

  // ---------------------------------------------------------------- uniforms
  function uploadIcons(ctx) {
    const ease = ctx.morph;
    const n = Math.min(MAX_IC, pairs.length);
    dispRects = [];
    for (let i = 0; i < n; i++) {
      const a = pairs[i].a, b = pairs[i].b;
      let q;
      if (a && b) q = { cx: ctx.mix(a.cx, b.cx, ease), cy: ctx.mix(a.cy, b.cy, ease), hw: ctx.mix(a.hw, b.hw, ease), hh: ctx.mix(a.hh, b.hh, ease) };
      else if (b) q = { cx: b.cx, cy: b.cy, hw: b.hw * ease, hh: b.hh * ease };
      else q = { cx: a.cx, cy: a.cy, hw: a.hw * (1 - ease), hh: a.hh * (1 - ease) };
      if (q.hw < 1 && q.hh < 1) { q.hw = q.hh = -60; }
      dispRects.push(q);
    }
    icN = dispRects.length;
    dispRects.forEach((q, i) => { icU[i * 4] = q.cx; icU[i * 4 + 1] = q.cy; icU[i * 4 + 2] = q.hw; icU[i * 4 + 3] = q.hh; });
  }
  function uploadTrenches(ctx) {
    const ib = ctx.intro, e = ib * ib * (3 - 2 * ib);
    trN = 0;
    for (const t of trenches) {
      if (trN >= MAX_TR) break;
      const hw = t.hw * (0.15 + 0.85 * e);
      if (hw < 0.6) continue;
      const half = (t.b - t.a) / 2, mid = (t.a + t.b) / 2, i = trN * 4;
      if (t.horiz) { trU[i] = mid; trU[i + 1] = t.c; trU[i + 2] = half; trU[i + 3] = hw; }
      else { trU[i] = t.c; trU[i + 1] = mid; trU[i + 2] = hw; trU[i + 3] = half; }
      trD[trN] = t.depth * e * Math.min(1, t.hw / Math.max(1, t.hwT || t.hw));
      trN++;
    }
  }
  function common(ctx) {
    const m = uParams;
    return { uIc: icU, uIcN: icN, uTr: trU, uTrD: trD, uTrN: trN, uM1: m.m1, uM2: m.m2, uBayD: m.bayD, uTerD: m.terD, uCh: m.ch };
  }
  function renderCache(ctx, fast) {
    uParams = margins(ctx);
    uploadIcons(ctx); uploadTrenches(ctx);
    const u = common(ctx);
    ctx.fullscreen(progInfo, u, {}, tInfo);
    const hi = ctx.P.quality >= 1 && !fast;
    ctx.fullscreen(progLit, Object.assign({ uSteps: hi ? 84 : 36, uStepK: hi ? 0.028 : 0.075 }, u), { uInfo: tInfo.tex }, tLit);
    ctx.bindTarget(null);
  }

  // ---------------------------------------------------------------- ships
  function pathPos(s, d) {
    const P = s.path, k = d;
    const sw = P.sway * Math.sin(k * P.swf + s.swph) + P.sway * 0.4 * Math.sin(k * P.swf * 2.3 + s.swph * 1.7);
    return [P.x0 + P.dx * k + P.nx * (sw + s.off), P.y0 + P.dy * k + P.ny * (sw + s.off)];
  }
  function trenchPath(ctx, t, dir) {
    const W = ctx.W, H = ctx.H;
    const len = (t.horiz ? W : H) + 300;
    if (t.horiz) return { x0: dir > 0 ? -150 : W + 150, y0: t.c, dx: dir, dy: 0, nx: 0, ny: 1, len, sway: t.hwT * 0.22, swf: 0.006, trench: true };
    return { x0: t.c, y0: dir > 0 ? -150 : H + 150, dx: 0, dy: dir, nx: -1, ny: 0, len, sway: t.hwT * 0.22, swf: 0.006, trench: true };
  }
  function hullPath(ctx) {
    const W = ctx.W, H = ctx.H;
    for (let k = 0; k < 14; k++) {
      const a = rnd() * Math.PI * 2;
      const cx = W * (0.25 + 0.5 * rnd()), cy = H * (0.25 + 0.5 * rnd());
      const dx = Math.cos(a), dy = Math.sin(a), R = Math.hypot(W, H) * 0.6;
      const x0 = cx - dx * R, y0 = cy - dy * R;
      let bad = false;
      for (let s = 0; s < 2 * R; s += 30) { const x = x0 + dx * s, y = y0 + dy * s; if (x > 0 && y > 0 && x < W && y < H && iconDistRect(x, y) < 50) { bad = true; break; } }
      if (!bad) return { x0, y0, dx, dy, nx: -dy, ny: dx, len: 2 * R, sway: 18, swf: 0.005, trench: false };
    }
    return null;
  }
  function spawnTrenchPatrol(ctx) {
    const longs = trenches.filter(t => (t.kind === 'long') && t.hwT > 0);
    if (!longs.length) return;
    const t = longs[(rnd() * longs.length) | 0], dir = rnd() < 0.5 ? 1 : -1;
    const path = trenchPath(ctx, t, dir), n = 2 + ((rnd() * 3) | 0);
    for (let i = 0; i < n; i++) ships.push({ kind: 'tie', team: 0, role: 'patrol', path, d: -i * 30, spd: 230, swph: rnd() * 6, off: (i % 2 ? 1 : -1) * Math.min(i, 1) * 4, hp: 2, alt: 20, x: -999, y: -999, ang: 0 });
  }
  function spawnFight(ctx) {
    let path = null;
    const longs = trenches.filter(t => t.kind === 'long' && t.hwT > 0);
    if (rnd() < 0.72 && longs.length) path = trenchPath(ctx, longs[(rnd() * longs.length) | 0], rnd() < 0.5 ? 1 : -1);
    else path = hullPath(ctx) || (longs.length ? trenchPath(ctx, longs[0], 1) : null);
    if (!path) return;
    const na = 1 + ((rnd() * 3) | 0), nc = 2 + ((rnd() * 2) | 0);
    const atk = [];
    for (let i = 0; i < na; i++) {
      const s = { kind: 'xw', team: 1, role: 'attacker', path, d: -i * 46 - rnd() * 20, spd: 255, swph: rnd() * 6, off: (i % 2 ? 1 : -1) * (i ? 9 : 0), hp: 3, alt: path.trench ? 22 : 34, fireT: 0.6 + rnd(), x: -999, y: -999, ang: 0 };
      ships.push(s); atk.push(s);
    }
    for (let i = 0; i < nc; i++) {
      ships.push({ kind: 'tie', team: 0, role: 'chaser', path, d: -na * 46 - 110 - i * 42, spd: 262, swph: rnd() * 6, off: (i % 2 ? 1 : -1) * 7, hp: 2, alt: path.trench ? 24 : 38, fireT: 0.8 + rnd(), target: atk[i % atk.length], gap: 90 + i * 30, x: -999, y: -999, ang: 0 });
    }
  }
  function fireBolt(x, y, ang, team, o = {}) {
    const sp = o.speed || 950;
    bolts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, team, life: o.life || 0.8, age: 0, len: o.len || 16, impact: !!o.impact,
      color: team === 1 ? [1, 0.1, 0.06] : [0.25, 1, 0.22], intensity: o.intensity || 7 });
  }
  function boom(x, y, size) {
    flashes.push({ x, y, age: 0, life: size > 20 ? 0.75 : 0.32, size });
    const n = size > 20 ? 22 : 7;
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, v = (size > 20 ? 60 : 30) + rnd() * (size > 20 ? 220 : 120);
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, age: 0, life: 0.25 + rnd() * (size > 20 ? 0.7 : 0.35) });
    }
  }
  function lead(sx, sy, tx, ty, tvx, tvy, sp) {
    const dx = tx - sx, dy = ty - sy, tt = Math.hypot(dx, dy) / sp;
    return Math.atan2(ty + tvy * tt - sy, tx + tvx * tt - sx);
  }

  function updateShips(ctx) {
    const dt = ctx.dt, W = ctx.W, H = ctx.H;
    // hull patrol flock
    const groups = Math.round(ctx.P.traffic * 4.4);
    if (flock.agents.length !== groups * 3) flock.resize(groups * 3);
    flock.update(dt, ctx.flow);
    // spawners
    if (ctx.P.traffic > 0.01) {
      runT -= dt;
      if (runT <= 0) { spawnTrenchPatrol(ctx); runT = ctx.mix(16, 4.5, ctx.P.traffic) * (0.6 + 0.8 * rnd()); }
    }
    if (ctx.P.skirmish > 0.01) {
      fightT -= dt;
      const fighting = ships.some(s => s.role === 'attacker');
      if (fightT <= 0 && (!fighting || rnd() < ctx.P.skirmish * 0.5)) { spawnFight(ctx); fightT = ctx.mix(30, 6, ctx.P.skirmish) * (0.6 + 0.8 * rnd()); }
    }
    // path ships
    for (const s of ships) {
      if (s.role === 'chaser' && s.target) {
        if (s.target.dead) s.target = ships.find(o => o.role === 'attacker' && !o.dead && o.path === s.path) || null;
        if (s.target) { const want = s.target.d - s.gap; s.spd = ctx.clamp(s.target.spd + (want - s.d) * 0.9, 150, 360); }
        else s.spd = Math.min(s.spd + dt * 40, 300);
      }
      const px = s.x, py = s.y;
      s.d += s.spd * dt;
      const p = pathPos(s, s.d), q = pathPos(s, s.d + 6);
      s.x = p[0]; s.y = p[1]; s.ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
      s.vx = px > -900 ? (s.x - px) / Math.max(dt, 1e-4) : 0; s.vy = py > -900 ? (s.y - py) / Math.max(dt, 1e-4) : 0;
      if (s.d > s.path.len) s.dead = true;
      const onScreen = s.x > -40 && s.y > -40 && s.x < W + 40 && s.y < H + 40;
      // weapons
      if (s.fireT !== undefined && onScreen && ctx.P.skirmish > 0) {
        s.fireT -= dt;
        if (s.fireT <= 0) {
          if (s.role === 'chaser' && s.target && !s.target.dead) {
            const T = s.target, dist = Math.hypot(T.x - s.x, T.y - s.y);
            if (dist < 420) {
              const a = lead(s.x, s.y, T.x, T.y, T.vx || 0, T.vy || 0, 950) + (rnd() - 0.5) * 0.09;
              const nx = -Math.sin(a), ny = Math.cos(a);
              fireBolt(s.x + nx * 3, s.y + ny * 3, a, 0, { life: 0.6 }); fireBolt(s.x - nx * 3, s.y - ny * 3, a, 0, { life: 0.6 });
            }
            s.fireT = 0.22 + rnd() * 0.55;
          } else if (s.role === 'attacker') {
            // fire forward along the run, sometimes at a turret ahead (hull impact)
            let a = s.ang, life = 0.45, impact = true;
            const tg = turrets.find(t => { const dx = t.x - s.x, dy = t.y - s.y, dd = Math.hypot(dx, dy); return dd < 300 && dd > 60 && Math.cos(Math.atan2(dy, dx) - s.ang) > 0.85; });
            if (tg) { a = Math.atan2(tg.y - s.y, tg.x - s.x); life = Math.hypot(tg.x - s.x, tg.y - s.y) / 950; }
            else if (rnd() < 0.4) { a = s.ang + Math.PI + (rnd() - 0.5) * 0.4; impact = false; life = 0.5; }   // rear shot at the pursuers
            const nx = -Math.sin(s.ang), ny = Math.cos(s.ang);
            fireBolt(s.x + nx * 8, s.y + ny * 8, a, 1, { life, impact }); fireBolt(s.x - nx * 8, s.y - ny * 8, a, 1, { life, impact });
            s.fireT = 0.5 + rnd() * 0.9;
          }
        }
      }
    }
    // turrets track the nearest ship, fire at attackers
    const all = ships.concat(flock.agents);
    for (const t of turrets) {
      let best = null, bd = 420;
      for (const s of all) {
        if (s.dead) continue;
        const d = Math.hypot(s.x - t.x, s.y - t.y) * (s.role === 'attacker' ? 0.5 : 1);
        if (d < bd) { bd = d; best = s; }
      }
      const want = best ? Math.atan2(best.y - t.y, best.x - t.x) : t.idle + Math.sin(ctx.flow * 0.15 + t.idle) * 1.4;
      let da = want - t.ang; da = Math.atan2(Math.sin(da), Math.cos(da));
      const rate = (best && best.role === 'attacker' ? 2.2 : 0.7) * dt;
      t.ang += ctx.clamp(da, -rate, rate);
      t.fireT -= dt;
      if (best && best.role === 'attacker' && ctx.P.skirmish > 0 && Math.abs(da) < 0.25 && bd < 170 && t.fireT <= 0) {
        const a = lead(t.x, t.y, best.x, best.y, best.vx || 0, best.vy || 0, 800) + (rnd() - 0.5) * 0.12;
        fireBolt(t.x + Math.cos(a) * 9, t.y + Math.sin(a) * 9, a, 0, { speed: 800, life: 0.45, len: 12, intensity: 8 });
        t.fireT = 0.35 + rnd() * 0.7;
      }
    }
    // bolts and hits
    for (const b of bolts) {
      b.age += dt; b.x += b.vx * dt; b.y += b.vy * dt;
      for (const s of ships) {
        if (s.dead || s.team === b.team) continue;
        if (Math.abs(s.x - b.x) < 9 && Math.abs(s.y - b.y) < 9 && Math.hypot(s.x - b.x, s.y - b.y) < 8) {
          b.dead = true; s.hp--;
          if (s.hp <= 0) { s.dead = true; boom(s.x, s.y, 30); } else boom(b.x, b.y, 10);
          break;
        }
      }
      if (!b.dead && b.age > b.life) { b.dead = true; if (b.impact) boom(b.x, b.y, 9); }
    }
    bolts = bolts.filter(b => !b.dead && b.x > -100 && b.y > -100 && b.x < W + 100 && b.y < H + 100);
    ships = ships.filter(s => !s.dead);
    for (const f of flashes) f.age += dt;
    flashes = flashes.filter(f => f.age < f.life);
    for (const s of sparks) { s.age += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 1 - dt * 2.5; s.vy *= 1 - dt * 2.5; }
    sparks = sparks.filter(s => s.age < s.life);
  }

  // ---------------------------------------------------------------- sprites
  function defineSprites(ctx) {
    ctx.atlas.define('tie', 200, 200, (g, w, h) => {
      const cx = w / 2, cy = h / 2;
      // pylons
      g.fillStyle = '#4d535b'; g.fillRect(cx - 7, cy - h * 0.37, 14, h * 0.74);
      g.fillStyle = '#7b828c'; g.fillRect(cx - 7, cy - h * 0.37, 5, h * 0.74);
      for (const s of [-1, 1]) {
        const y0 = cy + s * h * 0.39, L = w * 0.44, t = h * 0.075;
        const hex = () => { g.beginPath(); g.moveTo(cx - L, y0); g.lineTo(cx - L * 0.55, y0 - t); g.lineTo(cx + L * 0.55, y0 - t); g.lineTo(cx + L, y0); g.lineTo(cx + L * 0.55, y0 + t); g.lineTo(cx - L * 0.55, y0 + t); g.closePath(); };
        hex(); g.fillStyle = '#1d2128'; g.fill();
        g.save(); hex(); g.clip();
        g.strokeStyle = '#3c434d'; g.lineWidth = 2;
        for (let k = -6; k <= 6; k++) { g.beginPath(); g.moveTo(cx + k * L / 6.5, y0 - t); g.lineTo(cx + k * L / 6.5, y0 + t); g.stroke(); }
        g.fillStyle = 'rgba(160,175,195,0.18)'; g.fillRect(cx - L, y0 - t, 2 * L, t * 0.7);
        g.restore();
        hex(); g.strokeStyle = '#9aa1ab'; g.lineWidth = 4; g.stroke();
        g.fillStyle = '#8c939d'; g.fillRect(cx - 10, y0 - t - 1, 20, 2 * t + 2);
      }
      // ball cockpit
      const R = h * 0.15;
      const gr = g.createRadialGradient(cx - R * 0.4, cy - R * 0.45, R * 0.1, cx, cy, R);
      gr.addColorStop(0, '#d9dde3'); gr.addColorStop(0.6, '#8f969f'); gr.addColorStop(1, '#4a4f57');
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
      g.fillStyle = '#15181d'; g.beginPath(); g.arc(cx + R * 0.45, cy, R * 0.5, 0, 7); g.fill();
      g.strokeStyle = '#5d646d'; g.lineWidth = 2;
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g.beginPath(); g.moveTo(cx + R * 0.45, cy); g.lineTo(cx + R * 0.45 + Math.cos(a) * R * 0.5, cy + Math.sin(a) * R * 0.5); g.stroke(); }
      g.fillStyle = '#2b2f36'; g.beginPath(); g.arc(cx - R * 0.75, cy, R * 0.28, 0, 7); g.fill();
    });
    ctx.atlas.define('xw', 240, 240, (g, w, h) => {
      const cx = w * 0.5, cy = h * 0.5;
      const wing = (y1, x0, dx, shade) => {
        g.fillStyle = shade; g.beginPath();
        g.moveTo(x0, cy); g.lineTo(x0 + dx, cy); g.lineTo(x0 + dx * 0.78, y1); g.lineTo(x0 + dx * 0.05, y1); g.closePath(); g.fill();
      };
      // lower S-foils (peeking), then upper
      for (const s of [-1, 1]) wing(cy + s * h * 0.47, w * 0.2, w * 0.2, '#9c9890');
      for (const s of [-1, 1]) {
        const y1 = cy + s * h * 0.44;
        wing(y1, w * 0.17, w * 0.21, '#e4e0d6');
        g.fillStyle = '#b8261e'; g.fillRect(w * 0.18, y1 - s * h * 0.07 - (s < 0 ? 0 : h * 0.035), w * 0.17, h * 0.035);
        g.fillStyle = '#b8261e'; g.fillRect(w * 0.18, y1 - s * h * 0.12 - (s < 0 ? 0 : h * 0.02), w * 0.17, h * 0.02);
        // laser cannon along the wingtip
        g.fillStyle = '#c9c5bb'; g.fillRect(w * 0.16, y1 - h * 0.012, w * 0.62, h * 0.024);
        g.fillStyle = '#6d6a64'; g.fillRect(w * 0.7, y1 - h * 0.008, w * 0.1, h * 0.016);
        // engines
        g.fillStyle = '#cfcbc1'; g.fillRect(w * 0.08, cy + s * h * 0.1 - h * 0.035, w * 0.3, h * 0.07);
        g.fillStyle = '#6f6b64'; g.fillRect(w * 0.08, cy + s * h * 0.1 - h * 0.035, w * 0.04, h * 0.07);
      }
      // fuselage
      g.fillStyle = '#ebe7dd'; g.beginPath();
      g.moveTo(w * 0.12, cy - h * 0.06); g.lineTo(w * 0.62, cy - h * 0.05); g.lineTo(w * 0.96, cy - h * 0.018); g.lineTo(w * 0.96, cy + h * 0.018); g.lineTo(w * 0.62, cy + h * 0.05); g.lineTo(w * 0.12, cy + h * 0.06); g.closePath(); g.fill();
      g.fillStyle = '#b8261e'; g.fillRect(w * 0.66, cy - h * 0.04, w * 0.05, h * 0.08);
      g.fillStyle = '#20252c'; g.beginPath(); g.ellipse(w * 0.54, cy, w * 0.07, h * 0.03, 0, 0, 7); g.fill();
      g.fillStyle = '#8a8c90'; g.beginPath(); g.arc(w * 0.42, cy, h * 0.025, 0, 7); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(w * 0.12, cy + h * 0.02, w * 0.5, h * 0.04);
    });
    ctx.atlas.define('tbase', 96, 96, (g, w, h) => {
      const cx = w / 2, cy = h / 2, R = w * 0.46;
      g.fillStyle = '#3a3f47'; g.beginPath();
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4 + Math.PI / 8; g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); }
      g.closePath(); g.fill();
      g.strokeStyle = '#7b828c'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#23272d'; g.beginPath(); g.arc(cx, cy, R * 0.72, 0, 7); g.fill();
      g.fillStyle = '#596069'; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g.fillRect(cx + Math.cos(a) * R * 0.84 - 2, cy + Math.sin(a) * R * 0.84 - 2, 4, 4); }
    });
    ctx.atlas.define('ttop', 128, 128, (g, w, h) => {
      const cx = w * 0.42, cy = h / 2, R = w * 0.2;
      g.fillStyle = '#5c636c'; g.fillRect(cx, cy - h * 0.1, w * 0.52, h * 0.05); g.fillRect(cx, cy + h * 0.05, w * 0.52, h * 0.05);
      g.fillStyle = '#2a2e34'; g.fillRect(w * 0.88, cy - h * 0.1, w * 0.06, h * 0.05); g.fillRect(w * 0.88, cy + h * 0.05, w * 0.06, h * 0.05);
      const gr = g.createRadialGradient(cx - R * 0.4, cy - R * 0.4, 1, cx, cy, R * 1.1);
      gr.addColorStop(0, '#c9ced6'); gr.addColorStop(1, '#4d535b');
      g.fillStyle = gr; g.fillRect(cx - R * 1.1, cy - R, R * 2.1, R * 2);
      g.fillStyle = '#1a1d22'; g.fillRect(cx + R * 0.3, cy - R * 0.35, R * 0.55, R * 0.7);
      g.strokeStyle = '#8d949e'; g.lineWidth = 2; g.strokeRect(cx - R * 1.1, cy - R, R * 2.1, R * 2);
    });
  }

  function shipShadow(s, alt) {
    const t = s.path && s.path.trench;
    const k = t ? 0.55 : 0.85;
    return { dx: alt * k, dy: alt * k, alpha: t ? 0.38 : 0.5, bias: 2.2, scale: 1.0 };
  }

  // ---------------------------------------------------------------- register
  Galaxy.register(ID, {
    name: 'Battle station',
    post: { bloom: 1.05, threshold: 1.0, knee: 0.6, exposure: 0.85, vignette: 0.42, grain: 0.016, aberration: 0.0009, tint: [0.93, 0.99, 1.08], saturation: 0.92, bloomRadius: 1.0 },

    init(ctx) {
      rnd = ctx.rng(77);
      progInfo = ctx.program(FS_INFO);
      progLit = ctx.program(FS_LIT);
      progComp = ctx.program(FS_COMP);
      defineSprites(ctx);
      flock = new ctx.Flock({ count: 0, speed: 115, turn: 1.3, margin: 46, wander: 0.5, formation: 2, spacing: 26, seedK: 5 });
      ships = []; bolts = []; flashes = []; sparks = []; trenches = []; oldRects = []; newRects = []; dispRects = [];
      runT = 0.5 + rnd() * 2; fightT = 1.5 + rnd() * 2.5;
      dirty = true;
    },

    resize(ctx) {
      ctx.freeTarget(tInfo); ctx.freeTarget(tLit);
      tInfo = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true, nearest: false });
      tLit = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true });
      dirty = true;
    },

    layout(ctx) {
      // Keep what is on screen now as the morph start, so a layout change mid-morph stays smooth
      oldRects = dispRects.length ? dispRects.filter(q => q.hw > 0).map(q => Object.assign({}, q)) : [];
      newRects = ctx.icons.slice(0, MAX_IC).map(iconRect);
      // Pair each new icon with the nearest unused old one; unpaired icons grow in or shrink away
      const used = new Set();
      pairs = newRects.map(b => {
        let best = -1, bd = 360;
        oldRects.forEach((a, j) => { if (used.has(j)) return; const d = Math.hypot(a.cx - b.cx, a.cy - b.cy); if (d < bd) { bd = d; best = j; } });
        if (best >= 0) used.add(best);
        return { a: best >= 0 ? oldRects[best] : null, b };
      });
      oldRects.forEach((a, j) => { if (!used.has(j)) pairs.push({ a, b: null }); });
      buildTrenches(ctx);
      placeTurrets(ctx);
      dirty = true;
    },

    update(ctx) {
      // animate trench opening and closing
      let anim = false;
      const k = Math.min(1, ctx.rawDt * 2.2);
      for (const t of trenches) { const d = t.hwT - t.hw; if (Math.abs(d) > 0.05) { t.hw += d * k; anim = true; } else t.hw = t.hwT; }
      const before = trenches.length;
      trenches = trenches.filter(t => t.hwT > 0 || t.hw > 0.3);
      if (trenches.length !== before) anim = true;
      this._anim = anim;
      updateShips(ctx);
      // searchlight motion
      for (const s of searchlights) {
        s.ang = s.base + Math.sin(ctx.flow * s.sp + s.ph) * 1.3 + ctx.flow * 0.05;
        s.int = Math.max(0, Math.sin(ctx.flow * 0.05 + s.on)) ** 0.5 * 0.9;
      }
    },

    render(ctx) {
      if (!tInfo) return;
      const needAnim = !ctx.fieldStable || ctx.intro < 1 || this._anim;
      if (dirty || (needAnim && (frameK++ % 2 === 0))) { renderCache(ctx, needAnim && !dirty); dirty = false; pendingFinal = needAnim; }
      else if (!needAnim && pendingFinal) { renderCache(ctx); pendingFinal = false; }

      const sl = new Float32Array(16);
      searchlights.forEach((s, i) => { if (i < 4) { sl[i * 4] = s.t.x; sl[i * 4 + 1] = s.t.y; sl[i * 4 + 2] = s.ang || 0; sl[i * 4 + 3] = (s.int || 0) * ctx.intro; } });
      ctx.fullscreen(progComp, Object.assign({ uSL: sl, uLights: 1 }, common(ctx)), { uLit: tLit.tex, uInfo: tInfo.tex }, null);

      const fade = ctx.intro;
      // turrets
      for (const t of turrets) {
        ctx.sprite('tbase', t.x, t.y, { w: 20, alpha: fade, shadow: { dx: 2.5, dy: 2.5, alpha: 0.6, bias: 1.5 } });
        ctx.sprite('ttop', t.x, t.y, { w: 24, rot: t.ang, alpha: fade, shadow: { dx: 4, dy: 4, alpha: 0.5, bias: 1.8 } });
      }
      for (const s of searchlights) if (s.int > 0.02) ctx.glowDot(s.t.x + Math.cos(s.ang) * 6, s.t.y + Math.sin(s.ang) * 6, 3, [0.8, 0.9, 1], 3 * s.int * fade);
      // ships: hull patrol flock
      for (const a of flock.agents) {
        ctx.sprite('tie', a.x, a.y, { w: 28, rot: a.ang, shadow: { dx: 28, dy: 28, alpha: 0.5, bias: 2.6 } });
      }
      for (const s of ships) {
        if (s.kind === 'tie') ctx.sprite('tie', s.x, s.y, { w: 28, rot: s.ang, shadow: shipShadow(s, s.alt) });
        else ctx.sprite('xw', s.x, s.y, { w: 38, rot: s.ang, shadow: shipShadow(s, s.alt) });
      }
      // engine glows
      for (const a of flock.agents) ctx.glowDot(a.x - Math.cos(a.ang) * 7, a.y - Math.sin(a.ang) * 7, 3, [1, 0.42, 0.25], 1.4, { core: 0.4 });
      for (const s of ships) {
        const c = Math.cos(s.ang), sn = Math.sin(s.ang);
        if (s.kind === 'tie') ctx.glowDot(s.x - c * 7, s.y - sn * 7, 3, [1, 0.42, 0.25], 1.6, { core: 0.4 });
        else for (const o of [-3.4, 3.4]) ctx.glowLine(s.x - c * 14 - sn * o, s.y - sn * 14 + c * o, s.x - c * 18 - sn * o, s.y - sn * 18 + c * o, 3, [1, 0.35, 0.3], 3.2, { core: 0.8 });
      }
      // bolts
      for (const b of bolts) {
        const sp = Math.hypot(b.vx, b.vy), ux = b.vx / sp, uy = b.vy / sp;
        ctx.glowLine(b.x - ux * b.len, b.y - uy * b.len, b.x, b.y, 2.4, b.color, b.intensity, { core: 1.4, coreR: 0.3 });
      }
      // explosions
      for (const f of flashes) {
        const k = f.age / f.life, inv = 1 - k;
        ctx.glowDot(f.x, f.y, f.size * (0.3 + 0.7 * k), [1, 0.45, 0.12], 6 * inv * inv, { core: inv * 1.2, coreR: 0.3 });
        if (f.size > 20) ctx.glowDot(f.x, f.y, f.size * (0.7 + 1.2 * k), [1, 0.3, 0.08], 1.4 * inv, { core: 0 });
      }
      for (const s of sparks) {
        const k = 1 - s.age / s.life;
        ctx.glowLine(s.x - s.vx * 0.03, s.y - s.vy * 0.03, s.x, s.y, 1.4, [1, 0.62, 0.25], 6 * k, { core: k });
      }
    },

    dispose(ctx) {
      for (const p of [progInfo, progLit, progComp]) if (p) ctx.gl.deleteProgram(p.p);
      ctx.freeTarget(tInfo); ctx.freeTarget(tLit); tInfo = tLit = null;
      progInfo = progLit = progComp = null;
    }
  });
})();
