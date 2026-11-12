// Scene ot-empire: Original trilogy, Empire side. "Battle station surface".
// Straight down onto the hull of a moon-sized battle station. Every icon sits on a pad in a recessed, lit hangar bay;
// deep trenches cross the hull and connect the bays. Calm plated sectors, dense machinery districts and a few large
// superstructures give the hull a hierarchy. Fighter patrols, hull turrets, searchlights and trench-run skirmishes.
//
// Pipeline:
//   1. tInfo  (cached): height, bay distance, albedo tone, material code. Procedural + photographic plate textures.
//   2. tLit   (cached): lit hull color (key light from the upper left, ray-marched shadows, AO, bay interior light).
//      Both caches rebuild fully only on resize / intro / sigma change. When icons move, only the changed region
//      (old and new bays, opening or closing trenches, plus shadow reach) is re-rendered, using a scissor box.
//   3. per frame: tLit + animated emissives (windows, beacons, rim lights, conduit pulses, searchlights), then sprites and glows.
(function () {
  const ID = 'ot-empire';
  const MAX_IC = 128, MAX_TR = 32, MAX_SS = 6;
  const ASSET = 'assets/galaxy/ot-empire/';
  const DEMO = new URLSearchParams(location.search).has('otfight');

  // ---------------------------------------------------------------- GLSL shared by the cache passes and the per-frame pass
  const SH = `
uniform vec4 uIc[${MAX_IC}];
uniform float uIcN;
uniform vec4 uTr[${MAX_TR}];
uniform float uTrD[${MAX_TR}];
uniform float uTrN;
uniform vec4 uSS[${MAX_SS}];
uniform float uSSN;
uniform float uM1, uM2, uBayD, uTerD, uCh;
uniform sampler2D uHull, uDeck;

vec2 seedP(vec2 p) { return p + floor(vec2(mod(uSeed * 113.7, 2048.), mod(uSeed * 71.3, 2048.))); }

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
// Detail density: 0 = calm plated sector, 1 = dense machinery district
float zoneDensity(vec2 sp) { return smoothstep(0.50, 0.68, vnoise(sp / 820.) * 0.7 + vnoise(sp / 300. + 5.3) * 0.3); }
`;

  // Geometry + material for the info pass
  const GEO = SH + `
// Rectilinear (chamfered Chebyshev) distance to the union of icon rectangles; nr = nearest rectangle
float bayE(vec2 p, out vec4 nr) {
  float e = 1e4; nr = vec4(-1e4, -1e4, 1., 1.);
  for (int i = 0; i < ${MAX_IC}; i++) {
    if (float(i) >= uIcN) break;
    vec4 r = uIc[i];
    vec2 q = abs(p - r.xy) - r.zw;
    float d = max(max(q.x, q.y), (q.x + q.y - uCh) * 0.70710678);
    if (d < e) { e = d; nr = r; }
  }
  return e;
}

// Trench cross-section. f: 0 at the rim, 1 on the center line. Two terraced walls so the walls show from straight above.
float trenchProfile(float f, float D) {
  float h = -0.05 * D * smoothstep(0.0, 0.04, f);
  h = mix(h, -0.40 * D, smoothstep(0.06, 0.25, f));
  h = mix(h, -D, smoothstep(0.33, 0.54, f));
  return h;
}
float trenchH(vec2 p, out float td, out float ori, out float hwN, out float Dn) {
  float h = 1e4; td = 1e4; ori = 0.; hwN = 1.; Dn = 1.;
  for (int i = 0; i < ${MAX_TR}; i++) {
    if (float(i) >= uTrN) break;
    vec4 r = uTr[i];
    float hw = max(min(r.z, r.w), 0.5);
    float d = sdBox(p - r.xy, r.zw);
    if (d < td) { td = d; ori = r.z > r.w ? 0. : 1.; hwN = hw; Dn = uTrD[i]; }
    if (d < 0.) h = min(h, trenchProfile(clamp(-d / hw, 0., 1.), uTrD[i]));
  }
  return h;
}

float chamf(vec2 q, float s, float c) { return max(sdBox(q, vec2(s)), (abs(q.x) + abs(q.y) - s * 2. + c) * 0.70710678); }

// Superstructures placed by the CPU (seeded, away from icons). type 0 command tower, 1 great dish, 2/3 radiator bank (h / v)
float superH(vec2 p, vec2 sp, inout float mat, inout float tone, inout float ori, out float dmin) {
  float h = 0.; dmin = 1e4;
  for (int i = 0; i < ${MAX_SS}; i++) {
    if (float(i) >= uSSN) break;
    vec4 s = uSS[i]; vec2 q = p - s.xy; float S = s.z, ty = s.w;
    float d0 = ty == 1. ? length(q) - S - 12. : ty >= 2. ? sdBox(q, ty == 2. ? vec2(S, S * 0.2) + 8. : vec2(S * 0.2, S) + 8.) : sdBox(q, vec2(S * 1.75, S) + 8.);
    dmin = min(dmin, d0);
    if (d0 > 0.) continue;
    float hh = 0., m = 1., tn = 1., oo = 0.;
    if (ty == 0.) {
      float ap = sdBox(q, vec2(S * 1.75, S) + 6.); hh = 2.5 * clamp(-ap, 0., 1.);
      float wing = sdBox(vec2(abs(q.x) - S * 1.22, q.y), vec2(S * 0.42, S * 0.3));
      float hw = 11. * clamp(-wing / 1.2, 0., 1.);
      if (hw > hh) { hh = hw; tn = 0.95; }
      if (wing < 0. && abs(wing + 2.5) < 0.8) { m = 2.; oo = 0.; }
      // wing roof machinery
      vec2 wc = floor(q / 7.); float wr = hash12(wc + S);
      if (wing < -4. && wr > 0.55) hh = max(hh, (12.5 + wr * 2.5) * clamp(-sdBox(mod(q, 7.) - 3.5, vec2(2.2)), 0., 1.));
      float d1 = chamf(q, S, S * 0.45); float h1 = 16. * clamp(-d1 / 1.3, 0., 1.);
      if (h1 > hh) { hh = h1; tn = 1.08; m = 1.; }
      if (d1 < 0. && abs(d1 + 2.8) < 0.9) m = 2.;
      if (d1 < 0. && abs(d1 + 2.8) < 0.9 && abs(q.x) < abs(q.y)) oo = 0.;
      vec2 rc = floor(q / 6.); float rh = hash12(rc + S * 1.7);
      float d2 = chamf(q, S * 0.62, S * 0.3);
      if (d1 < -5. && d2 > 2. && rh > 0.5) hh = max(hh, (17.5 + rh * 2.) * clamp(-sdBox(mod(q, 6.) - 3., vec2(1.7)), 0., 1.));
      float h2 = 32. * clamp(-d2 / 1.3, 0., 1.);
      if (h2 > hh) { hh = h2; tn = 1.12; m = 1.; }
      if (d2 < 0. && abs(d2 + 2.4) < 0.8) m = 2.;
      float d3 = chamf(q, S * 0.3, S * 0.16); float h3 = 46. * clamp(-d3 / 1.3, 0., 1.);
      if (h3 > hh) { hh = h3; tn = 1.18; m = 1.; }
      if (d3 < 0. && abs(d3 + 2.) < 0.7) m = 2.;
      float r = length(q); float h4 = 66. * (1. - smoothstep(2.2, 3.2, r));
      if (h4 > hh) { hh = h4; m = 8.; }
    } else if (ty == 1.) {
      float r = length(q);
      float ap = sdBox(q, vec2(S + 12.)); hh = 2.5 * clamp(-ap, 0., 1.);
      float rim = 11. * (1. - smoothstep(1.5, 3.5, abs(r - S)));
      float bowl = r < S ? 1.2 + 8.5 * pow(r / S, 2.2) : 0.;
      if (r < S) { bowl -= 0.6 * (1. - smoothstep(0.2, 0.7, abs(fract(r / 9.) - 0.5) * 9.)); float an = atan(q.y, q.x) / 6.2832 * 32.; bowl -= 0.4 * (1. - smoothstep(0.1, 0.25, abs(fract(an) - 0.5))) * step(12., r); }
      hh = max(hh, max(rim, bowl));
      vec2 fc = vec2(S * 0.18, S * 0.12);
      float st = sdSegment(q, vec2(-S * 0.72, S * 0.72), fc);
      hh = max(hh, (9. + 4. * clamp(1. - length(q - fc) / S, 0., 1.)) * (1. - smoothstep(1.2, 2.4, st)));
      float ring = abs(r - S * 0.55);
      if (r < S) hh = max(hh, bowl + 1.2 * (1. - smoothstep(0.8, 1.6, ring)));
      float fr = length(q - fc);
      hh = max(hh, 14. * (1. - smoothstep(4., 5.5, fr)));
      // service blocks at the apron corners
      vec2 cq = abs(q) - vec2(S + 4.);
      float cb = sdBox(cq, vec2(6.));
      hh = max(hh, 9. * clamp(-cb, 0., 1.));
      if (r < S + 3.) tn = 1.16;
      if (length(q - vec2(S * 0.18, S * 0.12)) < 4.5) m = 8.;
    } else {
      vec2 qq = ty == 2. ? q : q.yx;
      vec2 B = vec2(S, S * 0.2);
      float d = sdBox(qq, B);
      hh = 2.5 * clamp(-(d - 6.), 0., 1.);
      if (d < 0.) { hh = max(hh, 2. + 6. * step(0.45, fract(qq.x / 4.)) * clamp(-d, 0., 1.)); m = 11.; oo = ty == 2. ? 0. : 1.; }
      float sp2 = abs(qq.y); if (d < 0. && sp2 < 3.2) { hh = 9. * sqrt(1. - sp2 * sp2 / 10.24); m = 3.; oo = ty == 2. ? 0. : 1.; }
      float ends = sdBox(vec2(abs(qq.x) - S - 6., qq.y), vec2(9., S * 0.26));
      float he = 20. * clamp(-ends / 1.3, 0., 1.);
      if (he > hh) { hh = he; m = 1.; tn = 1.1; }
      if (ends < 0. && abs(ends + 2.5) < 0.8) { m = 2.; oo = ty == 2. ? 1. : 0.; }
    }
    if (hh > h) { h = hh; mat = m; tone *= tn; ori = oo; }
  }
  return h;
}

float bigH(vec2 q, float type, vec2 sz, inout float mat, inout float tone, inout float ori) {
  float h = 0.;
  if (type == 1.) {
    float d0 = sdBox(q, sz + 5.); h = 3.5 * clamp(-d0, 0., 1.);
    float d1 = sdBox(q, sz); h = max(h, 13. * clamp(-d1 / 1.4, 0., 1.));
    vec2 s2 = floor(sz * 0.55); float d2 = sdBox(q, s2); h = max(h, 24. * clamp(-d2 / 1.4, 0., 1.));
    float d3 = sdBox(q, vec2(2.5)); h = max(h, 31. * clamp(-d3, 0., 1.));
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

// Full surface: height (px, up), bay distance, albedo tone and material code
float scene(vec2 p, out float e, out float mat, out float tone, out float ori) {
  vec4 nr; e = bayE(p, nr);
  vec2 sp = seedP(p);
  mat = 0.; ori = 0.;
  // --- superstructures (also raise the detail density around them)
  float stone = 1., smat = 0., sori = 0., ssd;
  float ssh = superH(p, sp, smat, stone, sori, ssd);
  float dens = max(zoneDensity(sp), 0.85 * (1. - smoothstep(20., 150., ssd)));

  // --- hull plating: photographic plate patchwork (offset and rotated per 256 px sector), sector grooves, tonal patches
  vec2 sid = floor(sp / 256.), sf = sp - sid * 256.;
  vec3 hs = hash32(sid + 3.1);
  vec2 uv = sp / 512. + floor(hs.xy * 4.) * 0.25;
  if (hs.z > 0.5) uv = vec2(uv.y, -uv.x);
  vec3 tx = texture(uHull, uv).rgb;
  float wear = texture(uHull, sp / 371. + vec2(0.31, 0.67)).b;
  float base = (hs.x - 0.5) * 1.6 + (tx.g - 0.55) * 2.0;
  tone = (0.8 + 0.34 * hs.y) * (0.55 + 0.85 * tx.r) * (0.72 + 0.5 * wear);
  vec2 se = min(sf, 256. - sf); float sd = min(se.x, se.y);
  base -= 2.8 * (1. - smoothstep(1.0, 2.8, sd));
  tone *= mix(1.06, 0.86, dens);
  float hq = hash12(floor(sp / vec2(512., 256.)) + 0.7);
  tone *= hq > 0.78 ? 0.80 : hq < 0.15 ? 1.13 : 1.;
  // calm sectors get a few large inset service panels with a raised border
  vec2 pc = floor(sp / 96.), pf = sp - pc * 96. - 48.;
  vec3 hp = hash32(pc + 17.);
  float detailK = 1.;
  if (hp.x > 0.55 + 0.4 * dens) {
    vec2 b = floor(mix(vec2(18.), vec2(38.), hp.yz));
    float d = sdBox(pf, b);
    base += 0.9 * (1. - smoothstep(0.4, 1.4, abs(d + 1.2))) - 0.7 * step(d, -2.4);
    if (d < -2.4) tone *= hp.y > 0.6 ? 0.82 : 1.07;
  }

  // --- medium greebles, 32 px cells (frequency follows the density zones)
  vec2 gc = floor(sp / 32.), gf = sp - gc * 32. - 16.;
  vec4 hg = vec4(hash32(gc + 41.7), hash12(gc + 9.1));
  float gh = 0., gmat = 0., gori = 0.;
  float gt = hg.x * mix(8., 0.8, dens);
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
  } else if (gt < 0.68) {
    bool hv = hg.y > 0.5;
    vec2 b = hv ? vec2(13., 4.) : vec2(4., 13.);
    float d = sdBox(gf, b);
    gh = 3.5 * clamp(-d / 1.2, 0., 1.);
    if (d < 0.) gmat = 1.;
    if (d < -1.2 && d > -2.6) { gmat = 2.; gori = hv ? 0. : 1.; }
  }
  // small greebles, 8 px cells, mostly in dense districts
  vec2 kc = floor(sp / 8.), kf = sp - kc * 8. - 4.;
  vec3 hk = hash32(kc + 3.3);
  if (hk.x > mix(0.99, 0.72, dens)) {
    vec2 b = floor(mix(vec2(1.), vec2(3.), hk.yz));
    float d = sdBox(kf, b);
    float kh = 1. + hk.y * 1.6;
    if (kh * clamp(-d / 0.8, 0., 1.) > gh) { gh = kh * clamp(-d / 0.8, 0., 1.); if (d < 0.) gmat = 1.; }
  }

  // --- conduits: long pipes along some 32 px rows / columns
  float ch = 0., cmat = 0., cori = 0.;
  float rowH = hash11(floor(sp.y / 32.) * 1.71 + 3.);
  if (rowH > 0.955) { float a = abs(mod(sp.y, 32.) - 16.) / 3.6; if (a < 1.) { ch = 4.6 * sqrt(1. - a * a); cmat = 3.; cori = 0.; } }
  float colH = hash11(floor(sp.x / 32.) * 2.37 + 9.);
  if (colH > 0.965) { float a = abs(mod(sp.x, 32.) - 16.) / 3.6; if (a < 1.) { float c2 = 4.6 * sqrt(1. - a * a) + 0.3; if (c2 > ch) { ch = c2; cmat = 3.; cori = 1.; } } }

  // --- large structures (mostly in dense districts)
  vec2 bc = floor(sp / 128.), bfq = sp - bc * 128. - 64.;
  float bt; vec2 bo, bsz; bigCell(bc, bt, bo, bsz);
  if (hash12(bc + 61.3) > 0.12 + 0.95 * dens) bt = 0.;
  float bmat = 0., btone = 1., bori = 0.;
  float bh = bt > 0. ? bigH(bfq - bo, bt, bsz, bmat, btone, bori) : 0.;

  // --- compose hull, flatten details near bays and trenches
  float tdd, tori, thw, tD;
  float hT = trenchH(p, tdd, tori, thw, tD);
  float clean = smoothstep(uM2 + 4., uM2 + 22., e) * smoothstep(3., 20., tdd);
  float detail = 0.; float dmat = 0.;
  if (gh > detail) { detail = gh; dmat = gmat; ori = gori; }
  if (ch > detail - 0.2 && ch > 0.) { detail = max(detail, ch); dmat = cmat; ori = cori; }
  if (bh > detail - 0.1 && bh > 0.4) { detail = max(detail, bh); dmat = bmat; tone *= btone; ori = bori; }
  else if (gh < 0. && ch <= 0.) { detail = gh; dmat = gmat; }
  if (ssd < 0.) {   // superstructures replace the small detail on their footprint
    if (ssh > 0.3) { detail = ssh; dmat = smat; tone *= stone; ori = sori; }
    else detail = min(detail, 0.);
  }
  float hull = base + detail * clean;
  mat = clean > 0.5 ? dmat : 0.;
  if (mat == 3.5) mat = 1.;

  // --- bay terraces
  float h = hull;
  if (e < uM2 + 3.) {
    vec2 tg = abs(fract(sp / 12.) - 0.5) * 12.;
    float terr = -uTerD - 0.5 * step(min(tg.x, tg.y), 0.6);
    float bayCap = e < uM1 ? -uBayD : e < uM1 + 2. ? mix(-uBayD, terr, (e - uM1) / 2.) : e < uM2 ? terr : mix(terr, 0., (e - uM2) / 3.);
    if (bayCap < h) { h = bayCap; mat = 4.; tone = 0.9 + 0.2 * tx.r; }
  }
  // --- trenches
  float f = clamp(-tdd / thw, 0., 1.);
  if (hT < h - 0.01) {
    float sAl = tori < 0.5 ? sp.x : sp.y;
    // wall buttresses: blocks standing out of the walls at irregular intervals
    float wc = floor(sAl / 13.); float wr = hash11(wc * 1.3 + floor(f * 5.));
    float wallJit = (wr - 0.5) * 2. * step(0.4, wr) * step(2.5, 13. - abs(mod(sAl, 13.) - 6.5) * 2.);
    float big = hash11(floor(sAl / 52.) * 2.7 + 1.);
    h = hT;
    tone = 0.85 + 0.3 * tx.r;
    if (f < 0.04) { mat = 6.; tone *= 1.25; }
    else if (f < 0.08) mat = 10.;
    else if (f < 0.27) { mat = 6.; h += wallJit * 3.5 + (big > 0.6 ? 4. * step(abs(mod(sAl, 52.) - 26.), 9.) : 0.); if (abs(f - 0.17) < 0.018 && hash11(floor(sAl / 40.) + 3.) > 0.35) mat = 2.; }
    else if (f < 0.34) { mat = hash11(floor(sAl / 30.) + 7.) > 0.5 ? 2. : 6.; h += wallJit; tone *= 1.15; }
    else if (f < 0.56) { mat = 6.; h += wallJit * 4. + (big < 0.35 ? 5. * step(abs(mod(sAl, 52.) - 26.), 7.) : 0.); }
    else { mat = 7.; if (f > 0.97) mat = 12.;
      float fb = hash11(floor(sAl / 22.) * 1.9 + 3.);
      if (fb > 0.55 && f > 0.62 && f < 0.84) h += 3. * clamp((7. - abs(mod(sAl, 22.) - 11.)), 0., 1.);
      float rl = abs(f - 0.9) / 0.03; if (rl < 1.) h += 2.2 * sqrt(1. - rl * rl);
      if (abs(mod(sAl, 28.) - 14.) > 13.4) h -= 0.8;
      tone *= 0.9 + 0.2 * wear;
    }
    ori = tori;
  }
  // --- bay floor: deck plating, a raised pad under each icon, seams, wall-side equipment and fixture lights
  if (e < uM1 + 0.5) {
    vec3 dk = texture(uDeck, sp / 160.).rgb;
    h = -uBayD + (dk.g - 0.5) * 0.7;
    mat = 5.; ori = 0.;
    tone = (0.55 + 0.8 * dk.r) * (0.8 + 0.4 * wear) * (0.9 + 0.2 * hash12(floor(nr.xy)));
    vec2 lq = p - nr.xy;
    if (e < 0.) {
      h += 0.8 * smoothstep(-0.2, -1.6, e);
      tone *= 1.12;
      // painted pad border: a dashed, dull amber line, left off the bottom where the label sits
      float dash = step(0.35, fract((lq.x + lq.y) / 7.));
      if (e > -3.7 && e < -2.7 && lq.y < nr.w * 0.35) { mat = 15.; tone = 0.8 + 0.3 * dk.r; if (dash < 0.5) mat = 5.; }
      // fixture lights at the pad's top corners (kept clear of the glyph and the label)
      vec2 cq = vec2(abs(lq.x) - (nr.z - 4.5), lq.y + (nr.w - 4.5));
      if (max(abs(cq.x), abs(cq.y)) < 1.4) { mat = 13.; ori = 0.; }
    } else if (e < 2.4) { h -= 1.3; tone *= 0.55; }
    float band = uM1 - e;
    if (e > 5. && band > 2.5) {
      vec2 q = abs(lq) - nr.zw;
      float along = q.x > q.y ? p.y : p.x;
      float sn = floor(nr.x * 0.37 + nr.y * 0.11) * 0.61;
      float grp = hash11(floor(along / 52.) * 5.31 + sn);
      float cell = floor(along / 11.); float hr = hash11(cell * 7.13 + sn);
      float a = abs(along - cell * 11. - 5.5);
      float wdt = 3.0 + 2.2 * hash11(cell * 1.7 + sn);
      float across = e - 5.;
      float dep = (band - 2.5) * (0.5 + 0.5 * hash11(cell * 2.9 + sn));
      if (grp > 0.35 && hr > 0.22 && a < wdt && across < dep) {
        float kind = hash11(cell * 3.7 + 1.9 + sn);
        float edge = clamp(min(wdt - a, dep - across) / 0.9, 0., 1.);
        float ch2; float tn;
        if (kind < 0.55) { ch2 = (2.5 + 3.5 * hr) * edge - 0.4 * step(abs(across - dep * 0.5), 0.4); tn = kind < 0.15 ? 1.4 : kind < 0.35 ? 0.55 : 1.0; }
        else if (kind < 0.85) { ch2 = (3. + 2.5 * hr) * sqrt(max(0., 1. - pow(a / wdt, 2.))); tn = 1.3; }
        else { ch2 = 1.2 * edge; tn = 0.45; }
        h = -uBayD + ch2; mat = 14.; tone = tn * (0.85 + 0.3 * dk.r);
      }
      if (abs(band - 1.3) < 0.9 && abs(fract(along / 18.) - 0.5) * 18. < 1.4) { mat = 13.; ori = 1.; }
    }
  }
  return h;
}
`;

  // ---------------------------------------------------------------- Pass 1: geometry info
  const FS_INFO = GEO + `
void main() {
  vec2 p = cssPos();
  float e, mat, tone, ori;
  float h = scene(p, e, mat, tone, ori);
  outColor = vec4(h, min(e, 2000.), tone, mat + ori * 16.);
}`;

  // ---------------------------------------------------------------- Pass 2: lighting
  const FS_LIT = SH + `
uniform sampler2D uInfo;
uniform float uSteps, uStepK;
vec2 uvOf(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
float Hs(vec2 p) { return texture(uInfo, uvOf(p)).r; }
vec3 matCol(float m) {
  if (m == 2. || m == 9.) return vec3(0.05, 0.055, 0.062);
  if (m == 3.) return vec3(0.30, 0.33, 0.37);
  if (m == 4.) return vec3(0.17, 0.18, 0.20);
  if (m == 5.) return vec3(0.075, 0.077, 0.083);
  if (m == 6.) return vec3(0.25, 0.265, 0.29);
  if (m == 7.) return vec3(0.085, 0.092, 0.105);
  if (m == 10. || m == 12. || m == 13.) return vec3(0.06);
  if (m == 11.) return vec3(0.2, 0.215, 0.24);
  if (m == 14.) return vec3(0.22, 0.22, 0.225);
  if (m == 1.) return vec3(0.18, 0.192, 0.214);
  if (m == 15.) return vec3(0.34, 0.25, 0.09);
  return vec3(0.165, 0.176, 0.197);
}
void main() {
  vec2 p = cssPos();
  vec4 inf = texture(uInfo, vUv);
  float h = inf.r, e = inf.g, tone = inf.b;
  float code = inf.a + 0.01, ori = step(15.5, code), mat = floor(code - ori * 16.);
  vec3 alb = matCol(mat) * tone;
  float ex = 0.7;
  float hx = (Hs(p + vec2(ex, 0.)) - Hs(p - vec2(ex, 0.))) / (2. * ex);
  float hy = (Hs(p + vec2(0., ex)) - Hs(p - vec2(0., ex))) / (2. * ex);
  vec3 n = normalize(vec3(-hx, -hy, 1.));
  vec3 L = normalize(vec3(-1., -0.85, 1.0));
  vec2 ld = normalize(L.xy);
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
  float rough = mat == 5. || mat == 13. || mat == 15. ? 90. : 36.;
  float spec = pow(max(dot(n, Hh), 0.), rough) * (1. - n.z * 0.55);
  vec3 key = vec3(1.0, 0.94, 0.86) * 2.1;
  vec3 amb = vec3(0.055, 0.075, 0.13) * (0.55 + 0.45 * n.z) * ao;
  float bounce = max(dot(n, normalize(vec3(1., 1., 0.4))), 0.) * 0.07;
  vec3 col = alb * (key * dif * sh * mix(0.7, 1., ao) + amb + vec3(0.45, 0.58, 0.85) * bounce * ao);
  float specM = (mat == 2. || mat == 9.) ? 0.15 : mat == 5. ? 0.6 : 1.;
  col += key * spec * sh * 0.4 * specM * (0.6 + 0.5 * tone);
  // depth: trenches fall off into cool blue-black, with a cool fill so the floor detail still reads
  float depth = clamp(-h / 75., 0., 1.);
  if (mat < 13. && mat != 5.) {
    float haze = mat == 7. || mat == 12. ? 0.55 : 0.3;
    col = mix(col, vec3(0.010, 0.014, 0.024), pow(depth, 1.6) * haze);
    col += alb * vec3(0.16, 0.2, 0.3) * smoothstep(0.3, 0.9, depth) * (0.35 + 0.65 * ao) * 0.8;
  }
  // bay interior: dark deck lit by warm wall washes, a soft cool overhead pool on each pad
  if (mat == 5. || mat == 14. || mat == 13. || mat == 15.) {
    float dw = max(uM1 - e, 0.);
    vec2 ge = vec2(dFdx(e), dFdy(e));
    float al = abs(ge.x) > abs(ge.y) ? p.y : p.x;
    float pool = 0.5 + 0.5 * cos(al * 6.2832 / 36.);
    float wall = exp(-dw / 7.) * (0.35 + 0.65 * pool) + 0.25 * exp(-dw / 22.);
    vec3 warm = vec3(1.0, 0.6, 0.3);
    float padL = smoothstep(4., -10., e) * 0.35;
    col = col * 0.5 + alb * (warm * (0.08 + 2.4 * wall) + vec3(0.6, 0.72, 0.95) * padL) * mix(0.55, 1., ao);
  } else if (e < uM2 + 10.) {
    float spill = exp(-max(e - uM1, 0.) / 7.) * smoothstep(uM2 + 10., uM2, e);
    col += alb * vec3(1.0, 0.58, 0.28) * spill * 0.7;
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
  float h = inf.r, e = inf.g;
  float code = inf.a + 0.01;
  float ori = step(15.5, code);
  float mat = floor(code - ori * 16.);
  float t = uFlow;
  vec2 sp = seedP(p);
  float on = uLights * smoothstep(0., 1., uIntro * 2.2 - 1.0 - 0.8 * hash12(floor(sp / 96.)));
  vec3 em = vec3(0.);
  if (mat == 2.) {          // windows
    vec2 c = floor(sp / 3.); float r = hash12(c);
    vec2 f = abs(fract(sp / 3.) - 0.5);
    float sq = 1. - smoothstep(0.24, 0.36, max(f.x, f.y));
    float lit = step(r, 0.42 + 0.12 * sin(t * 0.05 + r * 40.));
    vec3 wc = mix(vec3(1.0, 0.82, 0.55), vec3(0.65, 0.82, 1.0), step(0.72, hash12(c + 3.)));
    em += wc * sq * lit * (2.2 + 2.5 * hash12(c + 9.));
  } else if (mat == 10.) {  // trench rim lights: amber markers with a red chaser running along the trench
    float s = ori < 0.5 ? sp.x : sp.y;
    float k = floor(s / 14.);
    float dt_ = 1. - smoothstep(0.08, 0.16, abs(fract(s / 14.) - 0.5));
    float ph = fract(k * 0.045 - t * 0.35 + hash11(floor(s / 600.)));
    float chase = smoothstep(0.86, 1.0, ph);
    em += dt_ * (vec3(1.0, 0.55, 0.2) * 0.9 + vec3(1.0, 0.08, 0.04) * 9. * chase);
  } else if (mat == 12.) {  // trench floor guide lights
    float s = ori < 0.5 ? sp.x : sp.y;
    float dt_ = 1. - smoothstep(0.03, 0.06, abs(fract(s / 40.) - 0.5));
    float ph = fract(floor(s / 40.) * 0.05 + t * 0.4);
    em += dt_ * vec3(0.5, 0.75, 1.0) * (0.5 + 3.5 * smoothstep(0.85, 1., ph));
  } else if (mat == 3.) {   // conduit energy pulses
    float s = ori < 0.5 ? sp.x : sp.y;
    float lane = ori < 0.5 ? floor(sp.y / 32.) : floor(sp.x / 32.);
    float ph = fract(s / 520. - t * 0.22 + hash11(lane * 3.7));
    float pl = smoothstep(0.975, 0.997, ph) * (1. - smoothstep(0.997, 1.0, ph));
    em += vec3(0.35, 0.7, 1.0) * (pl * 3. + 0.05);
  } else if (mat == 9. || mat == 11.) {   // vents and heat sinks: slow, dim heat glow
    float r = hash12(floor(sp / 32.));
    em += vec3(1.0, 0.32, 0.08) * (mat == 9. ? 0.45 : 0.025) * (0.35 + 0.65 * (0.5 + 0.5 * sin(t * (0.4 + r) + r * 30.)));
  } else if (mat == 13.) {  // bay fixtures: cool pad corner lights, amber wall-foot lights
    float r = hash12(floor(sp / 6.));
    em += ori < 0.5 ? vec3(0.7, 0.85, 1.0) * (1.6 + 0.4 * sin(t * 0.7 + r * 20.)) : vec3(1.0, 0.62, 0.28) * 2.4;
  }
  // bay rim landing lights (outer terrace edge) and inner lip lights
  if (e < uM2 + 4. && e > uM1 - 2.) {
    vec2 g = vec2(dFdx(e), dFdy(e));
    float s = abs(g.x) > abs(g.y) ? p.y : p.x;
    float band = 1. - smoothstep(0.5, 1.2, abs(e - (uM2 - 3.)));
    float dotA = 1. - smoothstep(0.1, 0.17, abs(fract(s / 11.) - 0.5));
    float ph = fract(floor(s / 11.) * 0.06 - t * 0.6);
    em += band * dotA * vec3(1.0, 0.6, 0.22) * (1.2 + 3.2 * smoothstep(0.75, 1.0, ph));
    float band2 = 1. - smoothstep(0.4, 1.0, abs(e - (uM1 + 1.)));
    float dotB = 1. - smoothstep(0.08, 0.16, abs(fract(s / 8. + 0.5) - 0.5));
    em += band2 * dotB * vec3(0.75, 0.88, 1.0) * 1.4;
  }
  // beacons on towers and masts (one structure per 128 px cell)
  {
    vec2 bc = floor(sp / 128.);
    float bt; vec2 bo, bsz; bigCell(bc, bt, bo, bsz);
    vec2 bpos = bc * 128. + 64. + bo;
    vec2 bps = bpos - (sp - p);
    float d = length(sp - bpos);
    if ((bt == 1. || bt == 2.) && d < 14.) {
      float alive = step(abs(texture(uInfo, uvOf(bps)).a - 8.), 0.5);
      float r = hash12(bc + 4.4);
      float per = bt == 2. ? 2.2 : 3.1;
      float ph = fract(t / per + r);
      float blink = bt == 2. ? smoothstep(0.0, 0.03, ph) * (1. - smoothstep(0.25, 0.32, ph))
                             : smoothstep(0.0, 0.01, ph) * (1. - smoothstep(0.05, 0.08, ph)) + smoothstep(0.12, 0.13, ph) * (1. - smoothstep(0.16, 0.19, ph));
      vec3 bcol = bt == 2. ? vec3(1.0, 0.07, 0.04) : vec3(0.9, 0.95, 1.0);
      em += alive * bcol * blink * (14. * exp(-d * d / 2.2) + 0.9 * exp(-d / 5.));
    } else if (bt == 4. && d < max(bsz.x, bsz.y) + 4.) {
      bool hor = bsz.x > bsz.y;
      vec2 ax = hor ? vec2(bsz.x - 3., 0.) : vec2(0., bsz.y - 3.);
      float am = texture(uInfo, uvOf(bps)).a;
      float alive = step(abs(am - 1.), 0.5) + step(abs(am - 17.), 0.5);
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
    if (dist > 470. || dist < 6.) continue;
    float a = atan(d.y, d.x) - L.z; a = atan(sin(a), cos(a));
    float cone = (1. - smoothstep(0.06, 0.15, abs(a))) * smoothstep(460., 80., dist) * smoothstep(6., 30., dist);
    float spot = exp(-pow((dist - 280.) / 80., 2.)) * 0.8 + 0.35;
    cone *= spot * smoothstep(uM2, uM2 + 30., e);
    col += (col * 2.2 + vec3(0.012, 0.016, 0.025)) * cone * vec3(0.8, 0.9, 1.0) * L.w;
  }
  // curvature of the station: light falls off toward the lower right, slow drifting vapour over the hull
  vec2 uvn = p / uRes;
  float g = clamp(uvn.x * 0.55 + uvn.y * 0.45, 0., 1.);
  col *= mix(1.1, 0.8, g);
  col = mix(col, vec3(0.05, 0.07, 0.115) * 0.8, g * g * 0.14);
  float haze = texture(uHull, p * 0.00045 + vec2(t * 0.0021, -t * 0.0013) + uSeed * 0.01, 5.).b;
  col = mix(col, vec3(0.045, 0.06, 0.095), smoothstep(0.55, 0.85, haze) * 0.16);
  outColor = vec4(col, 1.);
}`;

  // ---------------------------------------------------------------- state
  let progInfo = null, progLit = null, progComp = null, tInfo = null, tLit = null, texHull = null, texDeck = null;
  let full = true, pendingFinal = false, frameK = 0, region = null, lastSigma = -1, ssKey = '';
  const icU = new Float32Array(MAX_IC * 4), trU = new Float32Array(MAX_TR * 4), trD = new Float32Array(MAX_TR), ssU = new Float32Array(MAX_SS * 4);
  let icN = 0, trN = 0, ssN = 0;
  let oldRects = [], newRects = [], dispRects = [], pairs = [];
  let trenches = [];          // {key, horiz, c, a, b, hw, hwT, depth, kind}
  let supers = [];            // {x, y, S, type}
  let turrets = [], searchlights = [];
  let flock = null, ships = [], bolts = [], flashes = [], sparks = [];
  let runT = 2, fightT = 3, uParams = { m1: 13, m2: 31, bayD: 26, terD: 11, ch: 3 };
  let rnd = Math.random, CTX = null;

  function margins(ctx) {
    const s = ctx.P.sigma, ib = ctx.intro;
    const e = ib * ib * (3 - 2 * ib);
    const m1 = (12 + s * 0.16) * e, m2 = m1 + (10 + s * 0.16) * e;
    return { m1, m2, bayD: 44 * e, terD: 16 * e, ch: Math.max(0, 0.586 * m1 - 5) };
  }
  const iconRect = ic => ({ cx: ic.x + ic.w / 2, cy: ic.y + ic.h / 2, hw: Math.max(6, ic.w / 2 - 4), hh: Math.max(6, ic.h / 2 - 4) });
  function addRegion(x0, y0, x1, y1) {
    if (!region) region = { x0, y0, x1, y1 };
    else { region.x0 = Math.min(region.x0, x0); region.y0 = Math.min(region.y0, y0); region.x1 = Math.max(region.x1, x1); region.y1 = Math.max(region.y1, y1); }
  }
  function trenchBox(t, pad) {
    const hw = Math.max(t.hw, t.hwT) + pad;
    return t.horiz ? [t.a - pad, t.c - hw, t.b + pad, t.c + hw] : [t.c - hw, t.a - pad, t.c + hw, t.b + pad];
  }

  // ---------------------------------------------------------------- trench network
  function chebGap(a, b) { return Math.max(Math.abs(a.cx - b.cx) - a.hw - b.hw, Math.abs(a.cy - b.cy) - a.hh - b.hh); }
  function longTrenches(ctx) {
    const W = ctx.W, H = ctx.H, r = ctx.rng(11);
    const list = [];
    const hy = Math.round(H * (0.28 + 0.44 * r()));
    list.push({ key: 'LH', kind: 'long', horiz: true, c: hy, a: -300, b: W + 300, hw: 62, depth: 72 });
    const vx = Math.round(W * (0.38 + 0.46 * r()));
    list.push({ key: 'LV', kind: 'long', horiz: false, c: vx, a: -300, b: H + 300, hw: 54, depth: 66 });
    if (r() < 0.65) {
      let y2 = hy < H / 2 ? hy + H * (0.3 + 0.15 * r()) : hy - H * (0.3 + 0.15 * r());
      y2 = Math.round(Math.min(H - 70, Math.max(70, y2)));
      const fromLeft = r() < 0.5;
      list.push({ key: 'LH2', kind: 'long2', horiz: true, c: y2, a: fromLeft ? -300 : vx, b: fromLeft ? vx : W + 300, hw: 40, depth: 54 });
    }
    return { list, r };
  }
  function buildTrenches(ctx) {
    const W = ctx.W, H = ctx.H, m = margins({ P: ctx.P, intro: 1 });
    const { list, r } = longTrenches(ctx);
    const rects = newRects;
    const iconHit = (x0, y0, x1, y1, pad) => rects.some(q => q.cx + q.hw + pad > x0 && q.cx - q.hw - pad < x1 && q.cy + q.hh + pad > y0 && q.cy - q.hh - pad < y1);
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
      const cands = [];
      for (const t of list) {
        if (t.kind === 'spur') continue;
        if (t.horiz) {
          const x = Math.round((x0 + x1) / 2 / 8) * 8;
          if (x < t.a || x > t.b) continue;
          const up = t.c < y0, from = up ? y0 + 12 : y1 - 12, len = Math.abs(t.c - from);
          cands.push({ len, s: { kind: 'spur', horiz: false, c: x, a: Math.min(from, t.c), b: Math.max(from, t.c), hw: 30, depth: 46 } });
        } else {
          const y = Math.round((y0 + y1) / 2 / 8) * 8;
          if (y < t.a || y > t.b) continue;
          const left = t.c < x0, from = left ? x0 + 12 : x1 - 12, len = Math.abs(t.c - from);
          cands.push({ len, s: { kind: 'spur', horiz: true, c: y, a: Math.min(from, t.c), b: Math.max(from, t.c), hw: 30, depth: 46 } });
        }
      }
      cands.sort((a, b) => a.len - b.len);
      if (cands.length && cands[0].len < Math.max(W, H) * 0.55) {
        const s = cands[0].s; s.key = 'S' + s.horiz + s.c + ':' + Math.round(s.a) + ':' + Math.round(s.b); list.push(s);
      }
    }
    // A few dead-end side trenches off the long ones (never under icons)
    for (let k = 0; k < 4; k++) {
      const t = list[r() < 0.5 ? 0 : 1];
      const len = 140 + r() * 260, side = r() < 0.5 ? -1 : 1;
      const pos = Math.round((t.horiz ? W : H) * (0.1 + 0.8 * r()) / 8) * 8;
      const a = side < 0 ? t.c - len : t.c, b = side < 0 ? t.c : t.c + len;
      const s = { kind: 'side', horiz: !t.horiz, c: pos, a, b, hw: 22, depth: 36, key: 'D' + k };
      const box = s.horiz ? [a, pos - 22, b, pos + 22] : [pos - 22, a, pos + 22, b];
      if (!iconHit(box[0], box[1], box[2], box[3], m.m2 + 24) && !supers.some(q => Math.max(Math.abs(q.x - (box[0] + box[2]) / 2) - (box[2] - box[0]) / 2, Math.abs(q.y - (box[1] + box[3]) / 2) - (box[3] - box[1]) / 2) < q.ext + 10)) list.push(s);
    }
    // Merge into the animated list: new trenches open up, removed ones close
    const first = trenches.length === 0;
    const byKey = {};
    for (const t of trenches) byKey[t.key] = t;
    for (const t of trenches) t.hwT = 0;
    for (const s of list) {
      const o = byKey[s.key];
      if (o) { Object.assign(o, s, { hw: o.hw, hwT: s.hw }); }
      else trenches.push(Object.assign(s, { hwT: s.hw, hw: first || s.kind === 'long' || s.kind === 'long2' ? s.hw : 0 }));
    }
    for (const t of trenches) if (Math.abs(t.hw - t.hwT) > 0.05) { const b = trenchBox(t, 4); addRegion(b[0], b[1], b[2], b[3]); }
  }

  // ---------------------------------------------------------------- superstructures (seeded, kept off icons and long trenches)
  function placeSupers(ctx) {
    const W = ctx.W, H = ctx.H, r = ctx.rng(31);
    const { list } = longTrenches(ctx);
    const want = Math.min(MAX_SS, Math.round(2 + 1.6 * (W * H) / (1920 * 1080)));
    const order = [0, 1, 2, 0, 1, 2];
    const out = [];
    for (let k = 0; k < 500 && out.length < want; k++) {
      const type = order[out.length];
      const S = type === 0 ? 46 + r() * 22 : type === 1 ? 42 + r() * 20 : 95 + r() * 60;
      const vert = type === 2 && r() < 0.5;
      const ex = type === 0 ? S * 1.75 + 8 : type === 1 ? S + 14 : vert ? S * 0.2 + 8 : S + 14;
      const ey = type === 0 ? S + 8 : type === 1 ? S + 14 : vert ? S + 14 : S * 0.2 + 8;
      const x = ex + 20 + r() * (W - 2 * ex - 40), y = ey + 20 + r() * (H - 2 * ey - 40);
      if (W - 2 * ex - 40 < 0 || H - 2 * ey - 40 < 0) continue;
      const m = margins({ P: ctx.P, intro: 1 });
      if (newRects.some(q => Math.abs(q.cx - x) < q.hw + ex + m.m2 + 30 && Math.abs(q.cy - y) < q.hh + ey + m.m2 + 30)) continue;
      if (list.some(t => t.horiz ? Math.abs(t.c - y) < t.hw + ey + 24 && x + ex > t.a && x - ex < t.b : Math.abs(t.c - x) < t.hw + ex + 24 && y + ey > t.a && y - ey < t.b)) continue;
      if (out.some(o => Math.abs(o.x - x) < o.ex + ex + 90 && Math.abs(o.y - y) < o.ey + ey + 90)) continue;
      out.push({ x: Math.round(x), y: Math.round(y), S: Math.round(S), type: type === 2 ? (vert ? 3 : 2) : type, ex, ey, ext: Math.max(ex, ey) });
    }
    supers = out;
    ssN = out.length;
    out.forEach((s, i) => { ssU[i * 4] = s.x; ssU[i * 4 + 1] = s.y; ssU[i * 4 + 2] = s.S; ssU[i * 4 + 3] = s.type; });
    const key = out.map(s => s.x + ',' + s.y + ',' + s.type).join(';');
    if (key !== ssKey) { ssKey = key; full = true; }
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
  const inSuper = (x, y, pad) => supers.some(s => Math.abs(x - s.x) < s.ex + pad && Math.abs(y - s.y) < s.ey + pad);
  function placeTurrets(ctx) {
    const r = ctx.rng(23), W = ctx.W, H = ctx.H;
    const want = Math.round(7 + 7 * (W * H) / (1920 * 1080));
    const out = [];
    const ok = (x, y) => iconDistRect(x, y) > 80 && !inTrench(x, y, 16) && !inSuper(x, y, 10) && out.every(t => Math.hypot(t.x - x, t.y - y) > 170);
    // Candidates come from a fixed seeded sequence, so most turrets stay put when icons move
    for (const t of trenches) {
      if (t.kind !== 'long') continue;
      for (let k = 0; k < 6; k++) {
        const along = (t.horiz ? W : H) * (0.08 + 0.84 * r()), side = r() < 0.5 ? -1 : 1, across = t.c + side * (t.hwT + 17);
        const x = t.horiz ? along : across, y = t.horiz ? across : along;
        if (x > 20 && y > 20 && x < W - 20 && y < H - 20 && ok(x, y) && out.length < want * 0.45) out.push({ x, y, ang: r() * 6.28, fireT: r(), idle: r() * 6.28 });
      }
    }
    for (let k = 0; k < 400; k++) {
      const x = 30 + r() * (W - 60), y = 30 + r() * (H - 60), a = r() * 6.28, f = r(), id = r() * 6.28;
      if (out.length < want && ok(x, y)) out.push({ x, y, ang: a, fireT: f, idle: id });
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
  function common() {
    const m = uParams;
    return { uIc: icU, uIcN: icN, uTr: trU, uTrD: trD, uTrN: trN, uSS: ssU, uSSN: ssN, uM1: m.m1, uM2: m.m2, uBayD: m.bayD, uTerD: m.terD, uCh: m.ch };
  }
  function scissor(ctx, x0, y0, x1, y1) {
    const gl = ctx.gl, s = tInfo.w / ctx.W;
    const X0 = Math.max(0, Math.floor(x0 * s)), X1 = Math.min(tInfo.w, Math.ceil(x1 * s));
    const Y0 = Math.max(0, Math.floor((ctx.H - y1) * s)), Y1 = Math.min(tInfo.h, Math.ceil((ctx.H - y0) * s));
    gl.scissor(X0, Y0, Math.max(0, X1 - X0), Math.max(0, Y1 - Y0));
  }
  // reg: CSS-px box of changed geometry (null = whole screen). Lighting is redone over the box plus shadow and AO reach.
  function renderCache(ctx, fast, reg) {
    uParams = margins(ctx);
    uploadIcons(ctx); uploadTrenches(ctx);
    const u = common(), gl = ctx.gl;
    if (reg) { gl.enable(gl.SCISSOR_TEST); scissor(ctx, reg.x0, reg.y0, reg.x1, reg.y1); }
    ctx.fullscreen(progInfo, u, { uHull: texHull, uDeck: texDeck }, tInfo);
    if (reg) scissor(ctx, reg.x0 - 32, reg.y0 - 32, reg.x1 + 150, reg.y1 + 150);
    const hi = ctx.P.quality >= 1 && !fast;
    ctx.fullscreen(progLit, Object.assign({ uSteps: hi ? 84 : 40, uStepK: hi ? 0.028 : 0.07 }, u), { uInfo: tInfo.tex }, tLit);
    if (reg) gl.disable(gl.SCISSOR_TEST);
    ctx.bindTarget(null);
  }

  // ---------------------------------------------------------------- ships
  // Path ships follow a straight lane with a gentle weave; `avo` is a sideways offset that steers them around icon cells.
  function pathBase(P, k) { return [P.x0 + P.dx * k, P.y0 + P.dy * k]; }
  function pathPos(s, d) {
    const P = s.path;
    const sw = P.sway * Math.sin(d * P.swf + s.swph) + P.sway * 0.4 * Math.sin(d * P.swf * 2.3 + s.swph * 1.7);
    const o = sw + s.off + (s.avo || 0);
    return [P.x0 + P.dx * d + P.nx * o, P.y0 + P.dy * d + P.ny * o];
  }
  const CLEAR = 30;
  function clearAt(x, y) { return CTX.distAt(x, y) > CLEAR; }
  function avoidTarget(s) {
    const P = s.path;
    const test = o => {
      for (const la of [0, 45, 95, 150]) {
        const b = pathBase(P, s.d + la);
        if (!clearAt(b[0] + P.nx * (o + s.off), b[1] + P.ny * (o + s.off))) return false;
      }
      return true;
    };
    const cur = s.avoT || 0;
    if (test(cur) && (cur === 0 || !test(0))) return cur;
    if (test(0)) return 0;
    const pref = cur >= 0 ? 1 : -1;
    for (let k = 1; k <= 22; k++) for (const sg of [pref, -pref]) { const o = sg * k * 14; if (test(o)) return o; }
    return cur;
  }
  function trenchPath(ctx, t, dir) {
    const W = ctx.W, H = ctx.H;
    const len = (t.horiz ? W : H) + 300;
    if (t.horiz) return { x0: dir > 0 ? -150 : W + 150, y0: t.c, dx: dir, dy: 0, nx: 0, ny: 1, len, sway: t.hwT * 0.2, swf: 0.006, trench: true };
    return { x0: t.c, y0: dir > 0 ? -150 : H + 150, dx: 0, dy: dir, nx: -1, ny: 0, len, sway: t.hwT * 0.2, swf: 0.006, trench: true };
  }
  function hullPath(ctx) {
    const W = ctx.W, H = ctx.H;
    for (let k = 0; k < 18; k++) {
      const a = rnd() * Math.PI * 2;
      const cx = W * (0.25 + 0.5 * rnd()), cy = H * (0.25 + 0.5 * rnd());
      const dx = Math.cos(a), dy = Math.sin(a), R = Math.hypot(W, H) * 0.6;
      const x0 = cx - dx * R, y0 = cy - dy * R;
      let bad = false;
      for (let s = 0; s < 2 * R; s += 30) { const x = x0 + dx * s, y = y0 + dy * s; if (x > 0 && y > 0 && x < W && y < H && iconDistRect(x, y) < 60) { bad = true; break; } }
      if (!bad) return { x0, y0, dx, dy, nx: -dy, ny: dx, len: 2 * R, sway: 18, swf: 0.005, trench: false };
    }
    return null;
  }
  // Fraction of a long trench's on-screen length that is clear of icon cells (lanes under big icon blocks are avoided)
  function laneScore(ctx, t) {
    let ok = 0, n = 0;
    const L = t.horiz ? ctx.W : ctx.H;
    for (let s = 0; s <= L; s += 24) { n++; if (clearAt(t.horiz ? s : t.c, t.horiz ? t.c : s)) ok++; }
    return ok / Math.max(1, n);
  }
  function pickLane(ctx) {
    const longs = trenches.filter(t => t.kind === 'long' && t.hwT > 0).map(t => ({ t, w: Math.pow(laneScore(ctx, t), 4) + 0.01 }));
    if (!longs.length) return null;
    let r = rnd() * longs.reduce((a, b) => a + b.w, 0);
    for (const l of longs) { r -= l.w; if (r <= 0) return l.t; }
    return longs[0].t;
  }
  // Fly in from the end whose entry stretch is clear, so ships do not emerge from under an icon block
  function laneDir(ctx, t) {
    const L = t.horiz ? ctx.W : ctx.H, at = s => clearAt(t.horiz ? s : t.c, t.horiz ? t.c : s);
    let a = 0, b = 0;
    for (let s = 0; s < L * 0.3; s += 20) { if (at(s)) a++; if (at(L - s)) b++; }
    return a === b ? (rnd() < 0.5 ? 1 : -1) : a > b ? 1 : -1;
  }
  function spawnTrenchPatrol(ctx) {
    const t = pickLane(ctx);
    if (!t) return;
    const dir = laneDir(ctx, t);
    const path = trenchPath(ctx, t, dir), n = 2 + ((rnd() * 2) | 0);
    for (let i = 0; i < n; i++) ships.push({ kind: 'tie', team: 0, role: 'patrol', path, d: -i * 34, spd: 230, swph: rnd() * 6, off: (i % 2 ? 1 : -1) * Math.min(i, 1) * 6, hp: 2, alt: 22, x: -999, y: -999, ang: 0, avo: 0, avoT: 0 });
  }
  function spawnFight(ctx) {
    let path = null;
    const lane = pickLane(ctx);
    if (rnd() < 0.72 && lane && laneScore(ctx, lane) > 0.6) path = trenchPath(ctx, lane, laneDir(ctx, lane));
    else path = hullPath(ctx) || (lane ? trenchPath(ctx, lane, laneDir(ctx, lane)) : null);
    if (!path) return;
    const na = 1 + ((rnd() * 3) | 0), nc = 2 + ((rnd() * 2) | 0);
    const atk = [];
    for (let i = 0; i < na; i++) {
      const kind = i === 0 || rnd() < 0.6 ? 'xw' : 'yw';
      const s = { kind, team: 1, role: 'attacker', path, d: -i * 58 - rnd() * 20, spd: kind === 'yw' ? 240 : 255, swph: rnd() * 6, off: (i % 2 ? 1 : -1) * (i ? 11 : 0), hp: 3, alt: path.trench ? 24 : 36, fireT: 0.6 + rnd(), x: -999, y: -999, ang: 0, avo: 0, avoT: 0 };
      ships.push(s); atk.push(s);
    }
    for (let i = 0; i < nc; i++) {
      ships.push({ kind: i === 0 ? 'tiea' : 'tie', team: 0, role: 'chaser', path, d: -na * 58 - 120 - i * 46, spd: 262, swph: rnd() * 6, off: (i % 2 ? 1 : -1) * 9, hp: 2, alt: path.trench ? 26 : 40, fireT: 0.8 + rnd(), target: atk[i % atk.length], gap: 95 + i * 32, x: -999, y: -999, ang: 0, avo: 0, avoT: 0 });
    }
  }
  // A shot is only taken when its whole flight stays clear of the icon cells
  function lineClear(x, y, ang, dist) {
    const c = Math.cos(ang), s = Math.sin(ang);
    for (let k = 0; k <= 6; k++) { const d = dist * k / 6; if (CTX.distAt(x + c * d, y + s * d) < 8) return false; }
    return true;
  }
  function fireBolt(x, y, ang, team, o = {}) {
    const sp = o.speed || 950;
    bolts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, team, life: o.life || 0.8, age: 0, len: o.len || 20, impact: !!o.impact,
      color: team === 1 ? [1, 0.1, 0.06] : [0.25, 1, 0.22], intensity: o.intensity || 7 });
  }
  function boom(x, y, size) {
    if (CTX.distAt(x, y) < 14) size = Math.min(size, 8);
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
    const groups = Math.round(ctx.P.traffic * 3.4);
    if (flock.agents.length !== groups * 3) flock.resize(groups * 3);
    flock.update(dt, ctx.flow);
    if (ctx.P.traffic > 0.01) {
      runT -= dt;
      if (runT <= 0) { spawnTrenchPatrol(ctx); runT = ctx.mix(18, 6.5, ctx.P.traffic) * (0.6 + 0.8 * rnd()); }
    }
    if (ctx.P.skirmish > 0.01) {
      fightT -= dt;
      const fighting = ships.some(s => s.role === 'attacker');
      if (fightT <= 0 && (!fighting || rnd() < ctx.P.skirmish * 0.5)) { spawnFight(ctx); fightT = ctx.mix(30, 6, ctx.P.skirmish) * (0.6 + 0.8 * rnd()); }
    }
    for (const s of ships) {
      if (s.role === 'chaser' && s.target) {
        if (s.target.dead) s.target = ships.find(o => o.role === 'attacker' && !o.dead && o.path === s.path) || null;
        if (s.target) { const want = s.target.d - s.gap; s.spd = ctx.clamp(s.target.spd + (want - s.d) * 0.9, 150, 360); }
        else s.spd = Math.min(s.spd + dt * 40, 300);
      }
      const px = s.x, py = s.y;
      s.d += s.spd * dt;
      s.avoT = avoidTarget(s);
      s.avo += (s.avoT - s.avo) * Math.min(1, dt * 2.4);
      const p = pathPos(s, s.d), q = pathPos(s, s.d + 8);
      s.x = p[0]; s.y = p[1]; s.ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
      s.vx = px > -900 ? (s.x - px) / Math.max(dt, 1e-4) : 0; s.vy = py > -900 ? (s.y - py) / Math.max(dt, 1e-4) : 0;
      s.bank = ctx.clamp((s.avoT - s.avo) * 0.01, -0.5, 0.5);
      if (s.d > s.path.len) s.dead = true;
      const onScreen = s.x > -40 && s.y > -40 && s.x < W + 40 && s.y < H + 40;
      if (s.fireT !== undefined && onScreen && ctx.P.skirmish > 0 && (s.vis == null || s.vis > 0.9)) {
        s.fireT -= dt;
        if (s.fireT <= 0) {
          if (s.role === 'chaser' && s.target && !s.target.dead) {
            const T = s.target, dist = Math.hypot(T.x - s.x, T.y - s.y);
            if (dist < 420) {
              const a = lead(s.x, s.y, T.x, T.y, T.vx || 0, T.vy || 0, 950) + (rnd() - 0.5) * 0.09;
              if (lineClear(s.x, s.y, a, 570)) {
                const nx = -Math.sin(a), ny = Math.cos(a);
                fireBolt(s.x + nx * 3.5, s.y + ny * 3.5, a, 0, { life: 0.6 }); fireBolt(s.x - nx * 3.5, s.y - ny * 3.5, a, 0, { life: 0.6 });
              }
            }
            s.fireT = 0.22 + rnd() * 0.55;
          } else if (s.role === 'attacker') {
            let a = s.ang, life = 0.45, impact = true;
            const tg = turrets.find(t => { const dx = t.x - s.x, dy = t.y - s.y, dd = Math.hypot(dx, dy); return dd < 300 && dd > 60 && Math.cos(Math.atan2(dy, dx) - s.ang) > 0.85; });
            if (tg) { a = Math.atan2(tg.y - s.y, tg.x - s.x); life = Math.hypot(tg.x - s.x, tg.y - s.y) / 950; }
            else if (rnd() < 0.4) { a = s.ang + Math.PI + (rnd() - 0.5) * 0.4; impact = false; life = 0.5; }
            if (lineClear(s.x, s.y, a, life * 950)) {
              const wx = s.kind === 'yw' ? 3 : 10, nx = -Math.sin(s.ang), ny = Math.cos(s.ang);
              fireBolt(s.x + nx * wx, s.y + ny * wx, a, 1, { life, impact }); fireBolt(s.x - nx * wx, s.y - ny * wx, a, 1, { life, impact });
            }
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
      t.recoil = Math.max(0, (t.recoil || 0) - dt * 6);
      if (best && best.role === 'attacker' && ctx.P.skirmish > 0 && Math.abs(da) < 0.25 && bd < 170 && t.fireT <= 0) {
        const a = lead(t.x, t.y, best.x, best.y, best.vx || 0, best.vy || 0, 800) + (rnd() - 0.5) * 0.12;
        if (lineClear(t.x, t.y, a, 360)) {
          const nx = -Math.sin(a), ny = Math.cos(a), sd = (t.side = -(t.side || 1)) * 2.2;
          fireBolt(t.x + Math.cos(a) * 13 + nx * sd, t.y + Math.sin(a) * 13 + ny * sd, a, 0, { speed: 800, life: 0.45, len: 14, intensity: 8 });
          t.recoil = 1;
        }
        t.fireT = 0.3 + rnd() * 0.6;
      }
    }
    // bolts and hits; bolts that reach an icon cell fizzle out quietly
    for (const b of bolts) {
      b.age += dt; b.x += b.vx * dt; b.y += b.vy * dt;
      if (ctx.distAt(b.x, b.y) < 4) { b.dead = true; continue; }
      for (const s of ships) {
        if (s.dead || s.team === b.team) continue;
        if (Math.abs(s.x - b.x) < 11 && Math.abs(s.y - b.y) < 11 && Math.hypot(s.x - b.x, s.y - b.y) < 10) {
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

  // ---------------------------------------------------------------- sprites (all point toward +x; drawn at ~6x their on-screen size)
  function lin(g, x0, y0, x1, y1, stops) { const gr = g.createLinearGradient(x0, y0, x1, y1); stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr; }
  function poly(g, pts) { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); }
  function defineSprites(ctx) {
    // Interceptor-style fighter: two hexagonal solar wings seen at an angle, ball cockpit between them
    const tieDraw = advanced => (g, w, h) => {
      const cx = w / 2, cy = h / 2;
      // pylons
      g.fillStyle = lin(g, 0, cy - 20, 0, cy + 20, [[0, '#9aa1aa'], [0.5, '#6a717a'], [1, '#3c4148']]);
      g.fillRect(cx - 9, cy - h * 0.36, 18, h * 0.72);
      g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(cx - 9, cy - h * 0.36, 3, h * 0.72);
      g.fillStyle = '#2e3238'; for (const s of [-1, 1]) g.fillRect(cx - 12, cy + s * h * 0.2 - 4, 24, 8);
      for (const s of [-1, 1]) {
        const y0 = cy + s * h * 0.39, L = w * 0.45, t = h * 0.085;
        const pts = advanced
          ? [[cx - L * 0.75, y0 - s * t * 1.6], [cx - L * 0.2, y0 - t], [cx + L * 0.55, y0 - t], [cx + L * 0.95, y0 + s * t * 1.2], [cx + L * 0.5, y0 + t], [cx - L * 0.35, y0 + t]]
          : [[cx - L, y0], [cx - L * 0.55, y0 - t], [cx + L * 0.55, y0 - t], [cx + L, y0], [cx + L * 0.55, y0 + t], [cx - L * 0.55, y0 + t]];
        poly(g, pts); g.fillStyle = lin(g, 0, y0 - t, 0, y0 + t, [[0, '#2c333e'], [0.45, '#181c23'], [1, '#0f1217']]); g.fill();
        g.save(); poly(g, pts); g.clip();
        // solar cell grid and radial spars
        g.strokeStyle = 'rgba(70,82,98,0.9)'; g.lineWidth = 1.5;
        for (let k = -14; k <= 14; k++) { g.beginPath(); g.moveTo(cx + k * L / 14, y0 - t); g.lineTo(cx + k * L / 14, y0 + t); g.stroke(); }
        g.beginPath(); g.moveTo(cx - L, y0); g.lineTo(cx + L, y0); g.stroke();
        g.strokeStyle = '#7d8590'; g.lineWidth = 4;
        for (const [px, py] of pts) { g.beginPath(); g.moveTo(cx, y0); g.lineTo(px, py); g.stroke(); }
        g.fillStyle = 'rgba(170,190,215,0.16)'; g.fillRect(cx - L, y0 - t, 2 * L, t * 0.55);
        g.restore();
        poly(g, pts); g.strokeStyle = '#b9c0c9'; g.lineWidth = 6; g.stroke();
        g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 2; g.stroke();
        g.fillStyle = lin(g, 0, y0 - t, 0, y0 + t, [[0, '#c3c9d1'], [1, '#6b727b']]);
        g.beginPath(); g.arc(cx, y0, 11, 0, 7); g.fill();
        g.fillStyle = '#3a3f46'; g.beginPath(); g.arc(cx, y0, 5, 0, 7); g.fill();
      }
      // ball cockpit
      const R = h * 0.15;
      const gr = g.createRadialGradient(cx - R * 0.45, cy - R * 0.5, R * 0.1, cx, cy, R);
      gr.addColorStop(0, '#eef1f4'); gr.addColorStop(0.55, '#9aa1aa'); gr.addColorStop(1, '#40454d');
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
      g.strokeStyle = 'rgba(40,44,50,0.6)'; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, R * 0.72, 0, 7); g.stroke();
      // forward window: octagon with radial frames
      const wx = cx + R * 0.48, wr = R * 0.5;
      g.fillStyle = '#0e1116'; g.beginPath(); for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4 + Math.PI / 8; g.lineTo(wx + Math.cos(a) * wr, cy + Math.sin(a) * wr); } g.closePath(); g.fill();
      g.fillStyle = 'rgba(120,160,210,0.35)'; g.beginPath(); g.arc(wx - wr * 0.25, cy - wr * 0.3, wr * 0.35, 0, 7); g.fill();
      g.strokeStyle = '#6a717b'; g.lineWidth = 2.5;
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g.beginPath(); g.moveTo(wx + Math.cos(a) * wr * 0.25, cy + Math.sin(a) * wr * 0.25); g.lineTo(wx + Math.cos(a) * wr, cy + Math.sin(a) * wr); g.stroke(); }
      g.beginPath(); g.arc(wx, cy, wr * 0.25, 0, 7); g.stroke();
      g.fillStyle = '#30353c'; g.beginPath(); g.arc(cx - R * 0.55, cy, R * 0.26, 0, 7); g.fill();
      g.strokeStyle = '#8b929b'; g.lineWidth = 1.5; g.stroke();
    };
    ctx.atlas.define('tie', 224, 224, tieDraw(false));
    ctx.atlas.define('tiea', 224, 224, tieDraw(true));

    // Attack fighter with split wings (X arrangement seen from above), four engines, a droid socket behind the canopy
    ctx.atlas.define('xw', 288, 288, (g, w, h) => {
      const cx = w * 0.5, cy = h * 0.5;
      const hull = '#e6e2d8', hullD = '#a9a59c', red = '#b3271d';
      // lower wings, slightly offset and darker (seen through the gap)
      for (const s of [-1, 1]) {
        poly(g, [[w * 0.22, cy + s * h * 0.06], [w * 0.42, cy + s * h * 0.06], [w * 0.36, cy + s * h * 0.42], [w * 0.25, cy + s * h * 0.42]]);
        g.fillStyle = '#8d8a83'; g.fill();
      }
      for (const s of [-1, 1]) {
        const tip = cy + s * h * 0.44;
        // upper wing
        poly(g, [[w * 0.19, cy + s * h * 0.05], [w * 0.43, cy + s * h * 0.05], [w * 0.36, tip], [w * 0.22, tip]]);
        g.fillStyle = lin(g, 0, cy, 0, tip, s < 0 ? [[0, '#f2eee5'], [1, '#d5d1c7']] : [[0, '#d9d5cb'], [1, '#bbb7ad']]); g.fill();
        g.strokeStyle = 'rgba(60,58,54,0.55)'; g.lineWidth = 1.5; g.stroke();
        // panel lines and the red identification stripes
        g.strokeStyle = 'rgba(80,76,70,0.45)'; g.lineWidth = 1.2;
        for (const f of [0.35, 0.6, 0.82]) { g.beginPath(); g.moveTo(w * 0.2, cy + s * h * 0.44 * f); g.lineTo(w * 0.42 - (w * 0.07) * f, cy + s * h * 0.44 * f); g.stroke(); }
        g.fillStyle = red; g.fillRect(w * 0.215, cy + s * h * 0.3 - h * 0.014, w * 0.16, h * 0.028);
        g.fillRect(w * 0.22, cy + s * h * 0.36 - h * 0.008, w * 0.15, h * 0.016);
        g.fillStyle = 'rgba(60,40,20,0.18)'; g.fillRect(w * 0.2, cy + s * h * 0.12, w * 0.06, h * 0.25 * 1);
        // wingtip cannon with flash suppressor
        g.fillStyle = lin(g, 0, tip - 5, 0, tip + 5, [[0, '#e9e6de'], [1, '#77746d']]);
        g.fillRect(w * 0.17, tip - 4.5, w * 0.46, 9);
        g.fillStyle = '#5c5a55'; g.fillRect(w * 0.6, tip - 3, w * 0.24, 6);
        g.fillStyle = '#2d2c2a'; g.fillRect(w * 0.84, tip - 4.5, w * 0.05, 9);
        g.fillStyle = '#9a978f'; g.fillRect(w * 0.45, tip - 5.5, w * 0.03, 11);
        // engine nacelle
        const ey = cy + s * h * 0.115;
        g.fillStyle = lin(g, 0, ey - 12, 0, ey + 12, [[0, '#f0ece3'], [0.5, '#c9c5bb'], [1, '#77736c']]);
        g.fillRect(w * 0.07, ey - 12, w * 0.33, 24);
        g.fillStyle = '#45433f'; g.fillRect(w * 0.38, ey - 13, w * 0.035, 26);
        g.fillStyle = '#24231f'; g.fillRect(w * 0.06, ey - 10, w * 0.03, 20);
        g.strokeStyle = 'rgba(70,66,60,0.6)'; g.lineWidth = 1.2;
        for (const f of [0.14, 0.22, 0.3]) { g.beginPath(); g.moveTo(w * f, ey - 12); g.lineTo(w * f, ey + 12); g.stroke(); }
      }
      // fuselage: long tapering nose
      poly(g, [[w * 0.12, cy - h * 0.07], [w * 0.6, cy - h * 0.055], [w * 0.97, cy - h * 0.016], [w * 0.97, cy + h * 0.016], [w * 0.6, cy + h * 0.055], [w * 0.12, cy + h * 0.07]]);
      g.fillStyle = lin(g, 0, cy - h * 0.07, 0, cy + h * 0.07, [[0, '#fbf8f0'], [0.55, hull], [1, hullD]]); g.fill();
      g.strokeStyle = 'rgba(60,58,54,0.6)'; g.lineWidth = 1.5; g.stroke();
      g.strokeStyle = 'rgba(80,76,70,0.5)'; g.lineWidth = 1.2;
      for (const f of [0.68, 0.78, 0.88]) { g.beginPath(); g.moveTo(w * f, cy - h * 0.05 * (1.05 - f * 0.8)); g.lineTo(w * f, cy + h * 0.05 * (1.05 - f * 0.8)); g.stroke(); }
      g.fillStyle = red; g.fillRect(w * 0.7, cy - h * 0.035, w * 0.035, h * 0.07);
      g.fillStyle = red; g.fillRect(w * 0.62, cy - h * 0.012, w * 0.3, h * 0.008);
      // canopy
      g.fillStyle = '#1a1f26'; g.beginPath(); g.ellipse(w * 0.555, cy, w * 0.075, h * 0.034, 0, 0, 7); g.fill();
      g.fillStyle = 'rgba(150,185,225,0.4)'; g.beginPath(); g.ellipse(w * 0.575, cy - h * 0.012, w * 0.035, h * 0.01, 0, 0, 7); g.fill();
      g.strokeStyle = '#d9d5cb'; g.lineWidth = 2; g.beginPath(); g.moveTo(w * 0.53, cy - h * 0.033); g.lineTo(w * 0.53, cy + h * 0.033); g.stroke();
      // droid dome
      const dg = g.createRadialGradient(w * 0.43 - 3, cy - 4, 1, w * 0.43, cy, h * 0.03);
      dg.addColorStop(0, '#ffffff'); dg.addColorStop(1, '#8e9aa8');
      g.fillStyle = dg; g.beginPath(); g.arc(w * 0.43, cy, h * 0.03, 0, 7); g.fill();
      g.fillStyle = '#2a5aa8'; g.fillRect(w * 0.425, cy - h * 0.03, w * 0.012, h * 0.02);
      g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(w * 0.12, cy + h * 0.025, w * 0.48, h * 0.045);
    });

    // Heavy attacker: forward cockpit pod, open frame, two long engine nacelles
    ctx.atlas.define('yw', 320, 320, (g, w, h) => {
      const cy = h * 0.5;
      for (const s of [-1, 1]) {
        const ny = cy + s * h * 0.25;
        g.fillStyle = '#6d6a64'; g.fillRect(w * 0.42, cy + Math.min(0, s) * h * 0.25, w * 0.05, h * 0.25);
        g.fillStyle = lin(g, 0, ny - 15, 0, ny + 15, [[0, '#f0ede6'], [0.5, '#bdb9b0'], [1, '#6e6b65']]);
        g.fillRect(w * 0.06, ny - 15, w * 0.5, 30);
        g.beginPath(); g.arc(w * 0.56, ny, 15, -Math.PI / 2, Math.PI / 2); g.fill();
        g.fillStyle = '#3b3935'; g.fillRect(w * 0.05, ny - 13, w * 0.04, 26);
        g.fillStyle = '#8a8780'; g.fillRect(w * 0.14, ny - 15, w * 0.1, 30);
        g.strokeStyle = 'rgba(70,66,60,0.6)'; g.lineWidth = 1.3;
        for (let k = 0; k < 7; k++) { const x = w * (0.16 + k * 0.05); g.beginPath(); g.moveTo(x, ny - 15); g.lineTo(x, ny + 15); g.stroke(); }
        g.fillStyle = '#c99a2e'; g.fillRect(w * 0.5, ny - 15, w * 0.02, 30);
      }
      // frame and exposed machinery
      g.fillStyle = '#7a776f'; g.fillRect(w * 0.18, cy - 9, w * 0.42, 18);
      g.fillStyle = '#4c4a45'; for (let k = 0; k < 6; k++) g.fillRect(w * (0.2 + k * 0.065), cy - 6, w * 0.04, 12);
      g.fillStyle = '#a7a39a'; g.fillRect(w * 0.18, cy - 2, w * 0.42, 4);
      // cockpit pod
      poly(g, [[w * 0.58, cy - h * 0.075], [w * 0.86, cy - h * 0.06], [w * 0.97, cy - h * 0.03], [w * 0.97, cy + h * 0.03], [w * 0.86, cy + h * 0.06], [w * 0.58, cy + h * 0.075]]);
      g.fillStyle = lin(g, 0, cy - h * 0.075, 0, cy + h * 0.075, [[0, '#f7f4ec'], [0.6, '#d8d4ca'], [1, '#8c8880']]); g.fill();
      g.strokeStyle = 'rgba(60,58,54,0.6)'; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = '#c99a2e'; g.fillRect(w * 0.64, cy - h * 0.072, w * 0.05, h * 0.144);
      g.fillStyle = '#1a1f26'; g.beginPath(); g.ellipse(w * 0.8, cy, w * 0.05, h * 0.035, 0, 0, 7); g.fill();
      g.fillStyle = 'rgba(150,185,225,0.4)'; g.beginPath(); g.ellipse(w * 0.815, cy - h * 0.012, w * 0.022, h * 0.01, 0, 0, 7); g.fill();
      g.fillStyle = '#5a5853'; g.fillRect(w * 0.93, cy - 3, w * 0.06, 6);
      const dg = g.createRadialGradient(w * 0.6 - 3, cy - 4, 1, w * 0.6, cy, h * 0.028);
      dg.addColorStop(0, '#ffffff'); dg.addColorStop(1, '#8e9aa8');
      g.fillStyle = dg; g.beginPath(); g.arc(w * 0.6, cy, h * 0.028, 0, 7); g.fill();
    });

    ctx.atlas.define('tbase', 128, 128, (g, w, h) => {
      const cx = w / 2, cy = h / 2, R = w * 0.46;
      g.fillStyle = lin(g, 0, 0, w, h, [[0, '#59606a'], [1, '#2a2e34']]);
      g.beginPath(); for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4 + Math.PI / 8; g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); } g.closePath(); g.fill();
      g.strokeStyle = '#8d949e'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#1e2126'; g.beginPath(); g.arc(cx, cy, R * 0.74, 0, 7); g.fill();
      g.strokeStyle = '#4b5159'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R * 0.62, 0, 7); g.stroke();
      g.fillStyle = '#6a717b'; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g.fillRect(cx + Math.cos(a) * R * 0.86 - 3, cy + Math.sin(a) * R * 0.86 - 3, 6, 6); }
    });
    ctx.atlas.define('ttop', 192, 192, (g, w, h) => {
      const cx = w * 0.4, cy = h / 2, R = w * 0.17;
      for (const s of [-1, 1]) {
        const by = cy + s * h * 0.07;
        g.fillStyle = lin(g, 0, by - 5, 0, by + 5, [[0, '#a9b0ba'], [1, '#3f444b']]);
        g.fillRect(cx, by - 5, w * 0.52, 10);
        g.fillStyle = '#23262b'; g.fillRect(w * 0.86, by - 6, w * 0.08, 12);
        g.fillStyle = '#6c737c'; g.fillRect(cx + w * 0.2, by - 7, w * 0.05, 14);
      }
      const gr = g.createRadialGradient(cx - R * 0.45, cy - R * 0.45, 1, cx, cy, R * 1.3);
      gr.addColorStop(0, '#d8dde3'); gr.addColorStop(0.6, '#7c838d'); gr.addColorStop(1, '#3d4249');
      g.fillStyle = gr;
      poly(g, [[cx - R * 1.2, cy - R * 0.8], [cx - R * 0.6, cy - R * 1.15], [cx + R * 0.9, cy - R * 1.0], [cx + R * 1.2, cy - R * 0.5], [cx + R * 1.2, cy + R * 0.5], [cx + R * 0.9, cy + R * 1.0], [cx - R * 0.6, cy + R * 1.15], [cx - R * 1.2, cy + R * 0.8]]);
      g.fill(); g.strokeStyle = '#9ba2ac'; g.lineWidth = 2.5; g.stroke();
      g.fillStyle = '#14171b'; g.fillRect(cx + R * 0.35, cy - R * 0.38, R * 0.55, R * 0.76);
      g.fillStyle = 'rgba(120,200,140,0.5)'; g.fillRect(cx + R * 0.42, cy - R * 0.3, R * 0.2, R * 0.2);
      g.fillStyle = '#4a5058'; g.fillRect(cx - R * 0.95, cy - R * 0.25, R * 0.5, R * 0.5);
    });
  }

  function shipShadow(s, alt) {
    const t = s.path && s.path.trench;
    const k = t ? 0.75 : 0.85;
    return { dx: alt * k, dy: alt * k * 0.85, alpha: t ? 0.45 : 0.5, bias: 2.4, scale: 1.0 };
  }
  function engines(ctx, s) {
    const c = Math.cos(s.ang), sn = Math.sin(s.ang);
    const v = s.vis == null ? 1 : s.vis;
    const glow = (bx, by, r, col, I) => ctx.glowDot(s.x + c * bx - sn * by, s.y + sn * bx + c * by, r, col, I * v, { core: 0.6 });
    if (s.kind === 'tie' || s.kind === 'tiea') { glow(-6, -2.2, 2.2, [1, 0.42, 0.25], 1.8); glow(-6, 2.2, 2.2, [1, 0.42, 0.25], 1.8); }
    else if (s.kind === 'xw') for (const o of [-4.2, 4.2]) ctx.glowLine(s.x - c * 19 - sn * o, s.y - sn * 19 + c * o, s.x - c * 23 - sn * o, s.y - sn * 23 + c * o, 3.2, [1, 0.38, 0.3], 3.4 * v, { core: 0.9 });
    else for (const o of [-12.5, 12.5]) ctx.glowLine(s.x - c * 22 - sn * o, s.y - sn * 22 + c * o, s.x - c * 27 - sn * o, s.y - sn * 27 + c * o, 4, [0.6, 0.75, 1], 3 * v, { core: 0.9 });
  }
  const SIZE = { tie: 30, tiea: 32, xw: 46, yw: 54 };

  // ---------------------------------------------------------------- register
  Galaxy.register(ID, {
    name: 'Battle station',
    post: { bloom: 1.0, threshold: 1.0, knee: 0.6, exposure: 0.58, vignette: 0.45, grain: 0.006, aberration: 0.0008, tint: [0.94, 0.99, 1.07], lift: [0.002, 0.003, 0.005], saturation: 0.9, bloomRadius: 1.0 },

    init(ctx) {
      CTX = ctx;
      rnd = ctx.rng(77);
      progInfo = ctx.program(FS_INFO);
      progLit = ctx.program(FS_LIT);
      progComp = ctx.program(FS_COMP);
      texHull = ctx.loadTexture(ASSET + 'hull_pack.jpg', { srgb: false });
      texDeck = ctx.loadTexture(ASSET + 'deck_pack.jpg', { srgb: false });
      defineSprites(ctx);
      flock = new ctx.Flock({ count: 0, speed: 115, turn: 2.0, margin: 64, wander: 0.5, formation: 2, spacing: 30, seedK: 5 });
      ships = []; bolts = []; flashes = []; sparks = []; trenches = []; oldRects = []; newRects = []; dispRects = []; supers = [];
      runT = 0.5 + rnd() * 2; fightT = 1.5 + rnd() * 2.5;
      full = true; region = null; ssKey = ''; lastSigma = -1; this._demo = false;
    },

    resize(ctx) {
      ctx.freeTarget(tInfo); ctx.freeTarget(tLit);
      tInfo = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true, nearest: false });
      tLit = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true });
      full = true;
    },

    layout(ctx) {
      CTX = ctx;
      oldRects = dispRects.length ? dispRects.filter(q => q.hw > 0).map(q => Object.assign({}, q)) : [];
      newRects = ctx.icons.slice(0, MAX_IC).map(iconRect);
      // Pair new and old bays, closest pairs first, so icons that stay put keep their bay and only movers slide
      const cand = [];
      newRects.forEach((b, i) => oldRects.forEach((a, j) => { const d = Math.hypot(a.cx - b.cx, a.cy - b.cy); if (d < 360) cand.push([d, i, j]); }));
      cand.sort((x, y) => x[0] - y[0]);
      const usedN = new Set(), usedO = new Set(), match = new Array(newRects.length).fill(-1);
      for (const [, i, j] of cand) { if (usedN.has(i) || usedO.has(j)) continue; usedN.add(i); usedO.add(j); match[i] = j; }
      pairs = newRects.map((b, i) => ({ a: match[i] >= 0 ? oldRects[match[i]] : null, b }));
      oldRects.forEach((a, j) => { if (!usedO.has(j)) pairs.push({ a, b: null }); });
      // Region whose geometry changes: every bay that moves, appears or disappears
      const m = margins({ P: ctx.P, intro: 1 }), pad = m.m2 + 8;
      for (const pr of pairs) {
        const a = pr.a, b = pr.b;
        if (a && b && Math.abs(a.cx - b.cx) < 0.5 && Math.abs(a.cy - b.cy) < 0.5 && Math.abs(a.hw - b.hw) < 0.5 && Math.abs(a.hh - b.hh) < 0.5) continue;
        for (const q of [a, b]) if (q) addRegion(q.cx - q.hw - pad, q.cy - q.hh - pad, q.cx + q.hw + pad, q.cy + q.hh + pad);
      }
      if (ctx.P.sigma !== lastSigma) { lastSigma = ctx.P.sigma; full = true; }
      placeSupers(ctx);
      buildTrenches(ctx);
      placeTurrets(ctx);
    },

    update(ctx) {
      let anim = false;
      const k = Math.min(1, ctx.rawDt * 2.2);
      for (const t of trenches) {
        const d = t.hwT - t.hw;
        if (Math.abs(d) > 0.05) { const b = trenchBox(t, 4); addRegion(b[0], b[1], b[2], b[3]); t.hw += d * k; anim = true; }
        else if (t.hw !== t.hwT) { const b = trenchBox(t, 4); addRegion(b[0], b[1], b[2], b[3]); t.hw = t.hwT; anim = true; }
      }
      trenches = trenches.filter(t => t.hwT > 0 || t.hw > 0.3);
      this._anim = anim;
      // Dev hook (?otfight): start with a skirmish already mid-screen, for screenshots of the ships
      if (DEMO && !this._demo && trenches.length) { this._demo = true; spawnFight(ctx); for (const s of ships) s.d += (s.path.trench ? (s.path.dx ? ctx.W : ctx.H) : s.path.len * 0.5) * 0.5; }
      updateShips(ctx);
      for (const s of searchlights) {
        s.ang = s.base + Math.sin(ctx.flow * s.sp + s.ph) * 1.3 + ctx.flow * 0.05;
        s.int = Math.max(0, Math.sin(ctx.flow * 0.05 + s.on)) ** 0.5 * 0.9;
      }
    },

    render(ctx) {
      if (!tInfo) return;
      const changing = !ctx.fieldStable || this._anim;
      if (full) { renderCache(ctx, false, null); full = false; pendingFinal = ctx.intro < 1; region = null; }
      else if (ctx.intro < 1) { if (frameK++ % 2 === 0) { renderCache(ctx, true, null); pendingFinal = true; region = null; } }
      else if (changing && region) { renderCache(ctx, true, region); pendingFinal = true; }
      else if (pendingFinal) { renderCache(ctx, false, region); pendingFinal = false; region = null; }
      else region = null;

      const sl = new Float32Array(16);
      searchlights.forEach((s, i) => { if (i < 4) { sl[i * 4] = s.t.x; sl[i * 4 + 1] = s.t.y; sl[i * 4 + 2] = s.ang || 0; sl[i * 4 + 3] = (s.int || 0) * ctx.intro; } });
      ctx.fullscreen(progComp, Object.assign({ uSL: sl, uLights: 1 }, common()), { uLit: tLit.tex, uInfo: tInfo.tex, uHull: texHull }, null);

      const fade = ctx.intro;
      for (const t of turrets) {
        const c = Math.cos(t.ang), s = Math.sin(t.ang), rb = -(t.recoil || 0) * 1.5;
        ctx.sprite('tbase', t.x, t.y, { w: 22, alpha: fade, shadow: { dx: 2.5, dy: 2.2, alpha: 0.6, bias: 1.5 } });
        ctx.sprite('ttop', t.x + c * rb, t.y + s * rb, { w: 30, rot: t.ang, alpha: fade, shadow: { dx: 4.5, dy: 4, alpha: 0.5, bias: 1.8 } });
      }
      // superstructure beacons: red spire light on command towers and dishes, white corner strobes on the towers
      supers.forEach((q, i) => {
        const ph = ((ctx.flow * 0.42 + i * 0.37) % 1 + 1) % 1, on = ctx.sstep(0, 0.04, ph) * (1 - ctx.sstep(0.3, 0.4, ph)) * fade;
        const bx = q.type === 1 ? q.x + q.S * 0.18 : q.x, by = q.type === 1 ? q.y + q.S * 0.12 : q.y;
        if (q.type <= 1 && on > 0.01) { ctx.glowDot(bx, by, 2.2, [1, 0.07, 0.04], 9 * on, { core: 1 }); ctx.glowDot(bx, by, 9, [1, 0.1, 0.05], 0.8 * on, { core: 0 }); }
        if (q.type === 0) {
          const st = ((ctx.flow * 0.6 + i * 0.21) % 1 + 1) % 1, k = (st < 0.04 || Math.abs(st - 0.12) < 0.02 ? 1 : 0) * fade;
          if (k) for (const sx of [-1, 1]) for (const sy of [-1, 1]) ctx.glowDot(q.x + sx * (q.S * 1.64 - 2), q.y + sy * (q.S * 0.3 - 2), 1.8, [0.85, 0.92, 1], 8, { core: 1 });
        }
      });
      for (const s of searchlights) if (s.int > 0.02) ctx.glowDot(s.t.x + Math.cos(s.ang) * 6, s.t.y + Math.sin(s.ang) * 6, 3, [0.8, 0.9, 1], 3 * s.int * fade);
      // Ships never draw over icon cells: where a lane cannot steer clear they fade, as if dropping into or rising from a bay
      const vis = (x, y) => ctx.sstep(6, 34, ctx.distAt(x, y));
      for (const a of flock.agents) { a.vis = vis(a.x, a.y); if (a.vis > 0.01) ctx.sprite('tie', a.x, a.y, { w: SIZE.tie, rot: a.ang, alpha: a.vis, shadow: { dx: 30, dy: 26, alpha: 0.45, bias: 2.6 } }); }
      for (const s of ships) { s.vis = vis(s.x, s.y); if (s.vis > 0.01) ctx.sprite(s.kind, s.x, s.y, { w: SIZE[s.kind], rot: s.ang + (s.bank || 0) * 0.2, alpha: s.vis, shadow: shipShadow(s, s.alt) }); }
      for (const a of flock.agents) if (a.vis > 0.01) engines(ctx, { x: a.x, y: a.y, ang: a.ang, kind: 'tie', vis: a.vis });
      for (const s of ships) if (s.vis > 0.01) engines(ctx, s);
      for (const b of bolts) {
        const sp = Math.hypot(b.vx, b.vy), ux = b.vx / sp, uy = b.vy / sp;
        ctx.glowLine(b.x - ux * b.len, b.y - uy * b.len, b.x, b.y, 2.6, b.color, b.intensity, { core: 1.5, coreR: 0.34 });
      }
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
