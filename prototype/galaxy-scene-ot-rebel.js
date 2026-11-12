// Galaxy scene ot-rebel (Original trilogy, Rebellion): "Forest moon".
// Straight down onto an ancient giant-tree forest in warm afternoon light. Each desktop icon sits in a sunlit clearing on the
// forest floor. Tall star-shaped conifer crowns tower over a broadleaf canopy and a low understory; long shadows fall across
// mossy, fern-covered clearings. Dirt trails wind between clearings, speeder bikes race along them, a two-legged walker
// plods by, birds glide over the trees, mist and cloud shadows drift across.
//
// Passes (the expensive ones run only when the layout changes, at half resolution while icons move):
//   noise  (512x512, once): tileable fbm channels used instead of per-pixel fbm (clouds, mist, gusts, dapple)
//   field  (CSS/2): R = clearing field, G = distance to trails, B = icon distance, A = icon blob
//   ferns  (device px, sprites): fern rosettes painted from a photographed conifer spray
//   geo    (device px): R = height in CSS px, G = material, B = species / param, A = top-ness / param
//   lit    (device px): sun with marched shadows over the height map, sky and bounce light, photo textures. A = canopy cover
//   aux    (CSS/2): R = openness toward the sun (sunlit motes), G = soft canopy cover
//   view   (every frame): wind sway, leaf flutter, cloud shadows, dapple                         -> opaque
//   sprites: dust, walker, speeders, debris
//   view overlay (every frame, blended): canopy over vehicles, motes, mist, haze
//   sprites: bolts, smoke and birds above the trees
(function () {
  'use strict';
  const ID = 'ot-rebel';
  const TAU = Math.PI * 2;
  const SHD = [0.7662, 0.6426];          // shadow direction on the ground (sun from the upper left)
  const LRISE = 1.0;                     // tan of the sun elevation (45 degrees)
  const ASSET = 'assets/galaxy/ot-rebel/';
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const angLerp = (a, b, t) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; };
  let st = null;

  /* ---------------------------------------------------------------- shaders */
  const NOISE_FS = `
float pn(vec2 p, float P, float o) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  float a = hash12(mod(i, P) + o), b = hash12(mod(i + vec2(1, 0), P) + o), c = hash12(mod(i + vec2(0, 1), P) + o), d = hash12(mod(i + 1., P) + o);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y); }
float pf(vec2 uv, float P, int oct, float o) { float s = 0., a = .5, n = 0.;
  for (int i = 0; i < 7; i++) { if (i >= oct) break; s += a * pn(uv * P, P, o + float(i) * 17.1); n += a; P *= 2.; a *= .5; } return s / n; }
void main() {
  vec2 uv = gl_FragCoord.xy / 512.;
  outColor = vec4(pf(uv, 4., 6, 0.), pf(uv, 5., 6, 40.), pf(uv, 16., 4, 80.), pf(uv, 8., 5, 120.));
}`;

  const FIELD_FS = `
uniform sampler2D uTrailA, uTrailB;
void main() {
  vec2 p = cssPos();
  float b = iconBlob(p), d = iconDist(p);
  float n = gfbm(p * 0.0075 + uSeed * 0.31, 4) * (uSigma * 0.8 + 30.) + gnoise(p * 0.035 + uSeed) * 10.;
  float cf = min(b + n + uSigma * 0.12, d - 22.);
  float m = mix(texture(uTrailA, vUv).r, texture(uTrailB, vUv).r, uMix);
  float td = m > 0.003 ? 40. * sqrt(max(0., -log(min(m, 1.))) / 2.2) : 80.;
  outColor = vec4(cf, td, d, b);
}`;

  // Shared by the geometry and lighting passes: floor material masks and floor height
  const COMMON = `
const vec2 L2 = vec2(-0.7662, -0.6426);
const vec3 LD = vec3(-0.5417, -0.4547, 0.7071);
const float LRISE = 1.0;
uniform sampler2D uField, uHt, uNoise;
vec2 uvOf(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
vec4 fld(vec2 p) { return texture(uField, uvOf(p)); }
// x = second litter tiling weight, y = moss, z = trail. hgt = floor height (CSS px)
vec3 floorMasks(vec2 p, vec4 f, float bias, out float hgt) {
  vec4 nz = texture(uNoise, p / 1100. + uSeed * .071);
  vec4 nz2 = texture(uNoise, p / 300. + .37);
  vec3 h1 = texture(uHt, p / 290. + uSeed * .13, bias).rgb;
  vec3 h2 = texture(uHt, mat2(.8, -.6, .6, .8) * p / 207. + .5, bias).rgb;
  float lb = smoothstep(.40, .60, nz.b);
  float interior = smoothstep(-50., 25., f.r);
  float mossM = smoothstep(.34, .56, nz.a * .8 + nz2.r * .5 + interior * .2 - .12);
  float tr = 1. - smoothstep(2.5, 6.5, f.g + (h1.b - .5) * 7. + (nz2.g - .5) * 5.);
  float lh = mix(h1.g, h2.g, lb);
  float mh = texture(uHt, p / 150. + .21, bias).r;
  hgt = lh * 2.4 + mossM * mh * 2. - tr * (1.6 - h1.b);
  return vec3(lb, mossM, tr);
}`;

  const GEO_FS = COMMON + `
// Tree crowns. ci = (layer, species key, radial t, crown height), cj = layer 0: (wedge, branch id, along, across), else local offset
float gCl = 0., gCl2 = 0.;
float crowns(vec2 p, out vec4 ci, out vec4 cj) {
  vec2 pw = p + (texture(uNoise, p / 760. + .3).ba - .5) * 44.;
  // leafy clumps: domed voronoi cells at two scales scallop the crown outlines and build the surface
  vec2 pv = p + vec2(gnoise(p * .11 + 4.), gnoise(p * .11 + 9.)) * 2.5;
  vec4 v = voronoi(pv / 10. + uSeed * .77), v2 = voronoi(pv / 4.2 + uSeed * 1.31);
  gCl = sqrt(max(0., 1. - v.x * v.x * 1.3)); gCl2 = sqrt(max(0., 1. - v2.x * v2.x * 1.5));
  float cb = texture(uHt, p / 600. + .11).r;
  float rag = (v.x - .45) * .2 + (v2.x - .45) * .1 + (.5 - cb) * .12;
  float best = 0.; ci = vec4(-1.); cj = vec4(0.);
  for (int L = 0; L < 3; L++) {
    float S = L == 0 ? 150. : L == 1 ? 96. : 52.;
    vec2 n = floor(pw / S);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = n + vec2(float(i), float(j));
      vec3 hh = hash32(g + vec2(float(L) * 31.7 + uSeed, uSeed * .5 + 3.));
      float hw = hash12(g * 1.37 + vec2(uSeed + float(L) * 5.1, 2.3));
      vec2 c = (g + .15 + .7 * hh.xy) * S;
      // forest stands: neighbouring trees share species and height, conifers cluster
      vec4 sn = texture(uNoise, c / 1900. + vec2(.7, .2));
      float stand = smoothstep(.3, .7, sn.g), cstand = smoothstep(.35, .65, sn.r);
      if (L == 0 && hw < mix(.8, .2, cstand)) continue;
      if (L == 2 && hw < .4) continue;
      if (L == 1 && hw < .05) continue;
      vec4 f = fld(c);
      float r = L == 0 ? 30. + 17. * hh.z : L == 1 ? S * (.48 + .3 * hh.z) : 19. + 12. * hh.z;
      float rE = min(r, f.r - 4. + .3 * r);
      rE = min(rE, f.b - 14.);
      rE = min(rE, f.g + (fract(hw * 13.7) < .55 ? r * .5 : -4.));
      if (rE < r * .38 || rE < 8.) continue;
      vec2 d = pw - c; float rr = length(d);
      if (rr > rE * 1.45) continue;
      float a = atan(d.y, d.x), t0 = rr / rE, h, t;
      float hc = (L == 0 ? 112. + 40. * hw : L == 1 ? 62. + 26. * hw : 40. + 18. * hw) * (.82 + .3 * stand);
      vec4 aux = vec4(d, 0., 0.);
      if (L == 0) {
        float lob = 1. + .08 * sin(a * 5. + hh.x * 31.) + .06 * sin(a * 9. + hh.y * 17.);
        t = t0 / lob + rag * 1.3;
        if (t >= 1.) continue;
        h = hc * (1. - .5 * t * t0) * pow(1. - t * t, .3);
      } else {
        float lob = 1. + .17 * sin(a * 3. + hh.x * 31.) + .1 * sin(a * 5. + hh.y * 17.);
        t = t0 / lob + rag;
        if (t >= 1.) continue;
        h = hc * pow(1. - t * t, .5);
      }
      if (h > best) { best = h; ci = vec4(float(L), fract(fract(hw * 7.13 + hh.z * 3.1) * .4 + stand * 1.35 + cstand * .3), t, hc); cj = aux; }
    }
  }
  // understory shrubs around the clearing rims
  vec2 n = floor(p / 26.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = n + vec2(float(i), float(j));
    vec3 hh = hash32(g + vec2(uSeed * 2.7 + 13.1, 5.7));
    if (hh.z < .6) continue;
    vec2 c = (g + .2 + .6 * hh.xy) * 26.;
    vec4 f = fld(c);
    if (f.r > -4. || f.r < -150.) continue;
    float r = 6. + 7. * fract(hh.z * 9.1);
    r = min(r, min(f.b - 16., f.g - 7.));
    if (r < 4.) continue;
    vec2 d = p - c;
    float t = length(d) / r + rag * 1.1 + (texture(uHt, p / 150. + hh.xy).r - .5) * .5;
    if (t >= 1.) continue;
    float hc = 10. + 7. * hh.x, h = hc * pow(1. - t * t, .5);
    if (h > best) { best = h; ci = vec4(3., fract(hh.x * 5.3 + hh.y), t, hc); cj = vec4(d, 0., 0.); }
  }
  return best;
}
// Floor features: stumps, fallen logs, mossy rocks. fi = (material, p1, p2, hash)
float floorFeat(vec2 p, vec4 f0, out vec4 fi) {
  fi = vec4(0.);
  if (f0.r > 40.) return 0.;
  float h = 0.;
  vec2 n = floor(p / 70.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = n + vec2(float(i), float(j));
    vec3 hh = hash32(g + vec2(uSeed * 1.9 + 7.1, 3.3));
    if (hh.z < .55) continue;
    vec2 c = (g + .2 + .6 * hh.xy) * 70.;
    vec4 f = fld(c);
    if (f.r > -2. || f.r < -70. || f.g < 18.) continue;
    float r = 8. + 6. * fract(hh.z * 13.7);
    if (f.b < r * 2.2 + 12.) continue;
    vec2 dv = p - c; float d = length(dv);
    if (d > r * 2.4) continue;
    float a = atan(dv.y, dv.x);
    float lob = pow(max(0., cos(a * 3. + hh.x * 20. + sin(a * 2.) * .7)), 2.);
    float hr = 4.5 * lob * (1. - smoothstep(r * .9, r * 2.2, d));
    float ht = d < r ? 13. + 4. * hh.y - d * .15 : 0.;
    float hT = max(ht, hr);
    if (hT > h) { h = hT; fi = vec4(5., d / r, a, hh.x); }
  }
  n = floor(p / 150.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = n + vec2(float(i), float(j));
    vec3 hh = hash32(g + vec2(uSeed * 2.3 + 1.7, 9.1));
    if (hh.z < .35) continue;
    vec2 c = (g + .25 + .5 * hh.xy) * 150.;
    vec4 f = fld(c);
    if (f.r > -14.) continue;
    float ang = hh.x * 18.85; vec2 dir = vec2(cos(ang), sin(ang));
    float len = 22. + 26. * fract(hh.y * 7.7), rad = 4.5 + 3. * fract(hh.z * 5.3);
    vec2 e1 = c - dir * len, e2 = c + dir * len;
    vec4 fa = fld(e1), fb = fld(e2);
    if (min(min(fa.b, fb.b), f.b) < rad + 16. || min(min(fa.g, fb.g), f.g) < rad + 6.) continue;
    float d = sdSegment(p, e1, e2);
    if (d >= rad) continue;
    float hl = rad + sqrt(rad * rad - d * d);
    if (hl > h) { h = hl; fi = vec4(6., d / rad, dot(p - e1, dir) / (2. * len), hh.x + hh.y); }
  }
  n = floor(p / 48.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = n + vec2(float(i), float(j));
    vec3 hh = hash32(g + vec2(uSeed * 3.1 + 4.4, 1.9));
    if (hh.z < .7) continue;
    vec2 c = (g + .2 + .6 * hh.xy) * 48.;
    vec4 f = fld(c);
    float r = 3. + 6. * fract(hh.z * 7.3);
    if (f.r > 10. || f.b < r + 20. || f.g < r + 5.) continue;
    vec2 dv = p - c;
    dv = mat2(1.15, .3, -.3, .9) * dv;
    float d = length(dv) / r + (texture(uHt, p / 60. + hh.xy).r - .5) * .35;
    if (d >= 1.) continue;
    float hr = r * .75 * pow(1. - d * d, .6);
    if (hr > h) { h = hr; fi = vec4(7., d, hh.y, hh.x); }
  }
  return h;
}
void main() {
  vec2 p = cssPos();
  vec4 f = fld(p);
  float hfl; floorMasks(p, f, 0., hfl);
  vec4 ci, cj, fi;
  float hc = crowns(p, ci, cj), cav = .5;
  if (ci.x > -.5) {
    float L = ci.x;
    vec2 q = rot2(ci.y * 6.2832) * cj.xy;
    float c1 = texture(uHt, q / 420. + ci.y * 3.).r;            // a few soft sub-crowns
    float c4 = texture(uHt, p / 23. + ci.y * 9.).r;             // leaf-level detail
    float big = L < 1.5 ? 1. : L < 2.5 ? .8 : .5;
    float edge = smoothstep(1., .7, ci.z);
    hc += (gCl * 5. * big + gCl2 * 3. + (c4 - .5) * 1.6 + gnoise(p * 2.2) * .9) * edge + (c1 - .5) * 3. * big;
    cav = clamp(gCl * .55 + gCl2 * .3 + c4 * .15, 0., 1.);
  }
  float hf = floorFeat(p, f, fi) + hfl;
  float h; vec4 o;
  if (hc > hf && ci.x > -.5) { h = hc; o = vec4(h, 1. + ci.x, floor(ci.y * 16.) / 16. + clamp(cav, 0., 1.) * .06, clamp(hc / ci.w, 0., 1.4)); }
  else if (fi.x > .5) { h = hf; o = vec4(h, fi.x, fi.y, fi.z); }
  else { h = hfl; o = vec4(h, 0., 0., 0.); }
  outColor = o;
}`;

  const LIT_FS = COMMON + `
uniform sampler2D uGeo, uFern, uFloor, uMoss, uDirt;
uniform float uNS;
vec4 G(vec2 p) { return textureLod(uGeo, uvOf(p), 0.); }
// species palettes (linear albedo): base, sunlit tips
const vec3 PB[6] = vec3[6](vec3(.014, .036, .020), vec3(.022, .058, .022), vec3(.050, .062, .022), vec3(.064, .088, .024), vec3(.078, .045, .020), vec3(.034, .078, .025));
const vec3 PT[6] = vec3[6](vec3(.030, .062, .028), vec3(.036, .085, .026), vec3(.075, .088, .026), vec3(.090, .122, .030), vec3(.105, .060, .024), vec3(.050, .105, .030));
void main() {
  vec2 p = cssPos();
  vec4 g = G(p);
  vec4 f = fld(p);
  float h = g.r, mat = floor(g.g + .5);
  float e = 1. / uScale;
  vec2 gr = vec2(G(p + vec2(e, 0.)).r - G(p - vec2(e, 0.)).r, G(p + vec2(0., e)).r - G(p - vec2(0., e)).r) / (2. * e);
  gr = clamp(gr, -7., 7.);
  vec3 N = normalize(vec3(-gr, 1.));
  // shadows: cone-traced over the height mip chain (soft, no streaks)
  float sh = 1., jit = hash12(p * 3.17 + uSeed), ls = log2(uScale);
  for (int k = 1; k <= 12; k++) {
    if (float(k) > uNS) break;
    float s = 170. * pow((float(k) - jit * .8) / uNS, 1.5) + 1.;
    float hq = textureLod(uGeo, uvOf(p + L2 * s), clamp(log2(s * .3) + ls, 0., 6.)).r;
    sh = min(sh, clamp(1. - (hq - h - s * LRISE) / (2. + s * .16), 0., 1.));
  }
  float a2 = textureLod(uGeo, vUv, 1.5 + ls).r, a4 = textureLod(uGeo, vUv, 3.5 + ls).r, a6 = textureLod(uGeo, vUv, 5.5 + ls).r;
  float occ = clamp((a2 - h) / 5., 0., 1.) * .3 + clamp((a4 - h) / 16., 0., 1.) * .35 + clamp((a6 - h) / 40., 0., 1.) * .35;
  float ao = 1. - occ * .92;
  vec3 alb; float wrap = 0., top = 0., canopy = 0.;
  float calm = smoothstep(2., 28., f.b);
  if (mat > .5 && mat < 4.5) {
    float L = mat - 1.;
    float k = floor(g.b * 16. + .001) / 16., cav = clamp(fract(g.b * 16. + .001) / .96, 0., 1.); top = clamp(g.a, 0., 1.2);
    int si = L < .5 ? 0 : L < 2.5 ? (k < .45 ? 1 : k < .68 ? 5 : k < .8 ? 2 : k < .86 ? 3 : k < .93 ? 0 : 4) : (k < .5 ? 3 : 2);
    float topk = smoothstep(.2, 1., top);
    alb = mix(PB[si], PT[si], topk * .6 + cav * .25) * (.62 + .45 * topk);
    alb = mix(alb, alb * vec3(1.05, 1.12, .85), topk * .4);
    alb *= (.85 + .3 * fract(k * 37.1)) * (.55 + .7 * texture(uHt, p / 9. + k).r);
    if (L > 2.5) alb *= 1.1;
    wrap = .08;
    canopy = L < 2.5 ? smoothstep(22., 34., h) : 0.;
    ao *= mix(.3, 1., smoothstep(.2, .9, top)) * (.35 + .65 * cav);
  } else if (mat > 6.5) {
    vec3 rk = vec3(.11, .105, .095) * (.75 + .5 * texture(uHt, p / 30. + g.a).g);
    vec3 ms = texture(uMoss, p / 90.).rgb * vec3(.8, 1., .7);
    alb = mix(rk, ms, smoothstep(.55, .9, N.z + (texture(uHt, p / 25.).r - .5) * .6) * .85);
  } else if (mat > 5.5) {
    float across = g.b, along = g.a;
    float rings = .5 + .5 * sin(length(vec2(across * 6., 0.)) * 9.);
    vec3 bark = vec3(.10, .062, .040) * (.65 + .55 * texture(uHt, vec2(along * 6., across * .4) + g.a).g);
    float ends = smoothstep(.03, 0., along) + smoothstep(.97, 1., along);
    alb = mix(bark, vec3(.20, .14, .085) * (.8 + .3 * rings), ends);
    alb = mix(alb, texture(uMoss, p / 70.).rgb * vec3(.7, .9, .6), smoothstep(.65, .2, across) * smoothstep(.4, .7, texture(uNoise, p / 90.).b) * .9);
  } else if (mat > 4.5) {
    float d = g.b;
    float rings = .5 + .5 * sin(d * 34. + texture(uHt, p / 20.).g * 4.);
    vec3 wood = mix(vec3(.16, .11, .07), vec3(.22, .16, .10), rings) * (.8 + .3 * texture(uHt, p / 18.).b);
    vec3 bark = vec3(.10, .06, .04) * (.6 + .6 * texture(uHt, p / 40.).g);
    alb = d < .92 ? wood : bark;
    alb = mix(alb, texture(uMoss, p / 80.).rgb * .7, smoothstep(.75, 1.1, d) * smoothstep(1.6, 1.1, d) * .6);
    if (d > 1.) alb = bark * .8;
  } else {
    float bias = (1. - calm) * .6;
    float hd; vec3 m = floorMasks(p, f, bias, hd);
    vec3 l1 = texture(uFloor, p / 290. + uSeed * .13, bias).rgb, l2 = texture(uFloor, mat2(.8, -.6, .6, .8) * p / 207. + .5, bias).rgb;
    vec3 litter = mix(l1, l2, m.x); litter = mix(vec3(luma(litter)), litter, .7) * vec3(.9, .78, .7);
    vec3 moss = texture(uMoss, p / 170. + .2, bias).rgb * vec3(.5, .78, .42);
    alb = mix(litter, moss, m.y);
    vec3 dirt = texture(uDirt, p / 150., bias).rgb * vec3(.34, .29, .24);
    alb = mix(alb, mix(alb, dirt, .7), m.z);
    float la = luma(alb); alb = mix(vec3(la) * vec3(1.08, 1., .85), alb, .8 + .2 * calm); alb = mix(vec3(.6 * la + .4 * .06) * vec3(1.1, 1., .8), alb, .72 + .28 * calm);
    alb *= .42;
    vec4 fe = texture(uFern, uvOf(p));
    float fs = texture(uFern, uvOf(p + L2 * 3.2)).a;
    alb = alb * (1. - fe.a) + fe.rgb;
    sh *= 1. - .5 * fs * (1. - fe.a);
    ao *= (1. - .35 * fs * (1. - fe.a)) * (.8 + .2 * fe.a);
    N = normalize(mix(N, vec3(0., 0., 1.), fe.a * .5));
    wrap = .2 * fe.a;
    // the forest floor under the canopy is in deep shade
    ao *= mix(1., .15, smoothstep(-10., 40., f.r)); sh *= mix(1., .12, smoothstep(-5., 35., f.r));
  }
  vec3 sunC = vec3(1., .79, .52) * 2.8;
  vec3 skyC = vec3(.30, .40, .52) * .45;
  float diff = max((dot(N, LD) + wrap) / (1. + wrap), 0.);
  vec3 col = alb * (sunC * diff * sh + skyC * ao * (.5 + .5 * N.z));
  col += alb * vec3(.10, .14, .05) * ao * (1. - sh) * .5;
  if (mat > .5 && mat < 4.5) col += alb * vec3(.45, .65, .12) * sunC * .06 * sh * (1.2 - top);
  float depth = 1. - clamp(h / 150., 0., 1.);
  col = mix(col, vec3(.045, .06, .06), depth * depth * .16);
  // A = sun visibility (diffuse x shadow): the view pass relights the cache for time of day and weather with it
  outColor = vec4(col, diff * sh);
}`;

  // Canopy cover (tall crowns) from the geometry cache
  const CANOPY = `float canopyOf(vec4 g) { float m = floor(g.g + .5); return (m > .5 && m < 3.5) ? smoothstep(22., 34., g.r) : 0.; }
`;
  const AUX_FS = CANOPY + `
uniform sampler2D uGeo;
const vec2 L2 = vec2(-0.7662, -0.6426);
vec2 uvOf(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
void main() {
  vec2 p = cssPos();
  float open = 0., cov = 0.;
  for (int k = 1; k <= 6; k++) open += 1. - canopyOf(texture(uGeo, uvOf(p + L2 * float(k) * 17.)));
  for (int k = 0; k < 5; k++) { float a = float(k) * 1.2566; cov += canopyOf(texture(uGeo, uvOf(p + vec2(cos(a), sin(a)) * 14.))); }
  outColor = vec4(open / 6., cov / 5., 0., 1.);
}`;

  // View pass. Relights the cached afternoon look for the time of day and weather: lit.a is the sun visibility, so
  // col * (sun' * sv + sky') / (sun * sv + sky) keeps shadows and textures while the light color and balance change.
  // At the designed time with neutral weather every new term is exactly neutral.
  const VIEW_FS = CANOPY + `
uniform sampler2D uLit, uField, uAux, uNoise, uGeo;
uniform float uLayer, uSwayT;
uniform vec2 uWind, uCloudOff, uMistOff;
uniform vec3 uSunC, uSkyC, uMistC, uHazeC, uFogC;
uniform vec4 uWx;    // x wet, y snow cover, z fog, w lightning
uniform vec4 uWx2;   // x sway strength, y extra cloud cover, z sun strength (1 = designed), w hollow mist (sunrise)
const vec3 SUN0 = vec3(2.8, 2.212, 1.456), SKY0 = vec3(.135, .18, .234);
const vec3 HV = vec3(-.2932, -.2461, .9238);
void main() {
  vec2 p = cssPos();
  vec2 uv = vUv;
  float t = uFlow, ts = uSwayT;
  vec2 wd = uWind, wp = vec2(-wd.y, wd.x);
  vec4 g0 = texture(uGeo, uv);
  float hm = canopyOf(g0);
  vec4 f = texture(uField, uv);
  float gust = texture(uNoise, p / 1500. - wd * ts * .0055).g;
  float wave = sin(dot(p, wd) * .02 - ts * 1.6 + gust * 9.);
  float wave2 = sin(dot(p, wp) * .045 + ts * 2.1 + gust * 6.);
  float sway = uWx2.x, sunK = uWx2.z;
  vec2 disp = (wd * (wave * .7 + (gust - .5) * 3.2) + wp * wave2 * .3) * hm * sway;
  vec3 col = vec3(0.); float canopy = 0.;
  if (uLayer < .5 || hm > .001) {
    vec2 uvd = uv + vec2(disp.x, -disp.y) / uRes;
    vec4 g = hm > .001 ? texture(uGeo, uvd) : g0;
    canopy = canopyOf(g);
    // fully covered by tall canopy: the overlay pass paints this pixel opaquely, so the ground pass can skip it
    if (uLayer < .5 && canopy > .999) { outColor = vec4(0., 0., 0., 1.); return; }
    vec4 c = texture(uLit, uvd);
    float sv = c.a;
    vec3 dayL = SUN0 * sv + SKY0 * .5, newL = uSunC * sv + uSkyC * .5;
    float eA = luma(c.rgb) / luma(dayL);
    col = c.rgb * newL / dayL;
    float mat = floor(g.g + .5), flo = 1. - step(.5, mat);
    col *= 1. + canopy * (.06 * wave * (gust * 2. - .4) + .13 * (vnoise(p * .3 + wd * ts * 2.) - .5) * (.6 + .4 * sway));
    // sunlit leaves catch the light as the wind turns them
    float g1 = texture(uNoise, p / 80. + wd * ts * .035).b, g2 = texture(uNoise, p / 63. - wp * ts * .028 + .5).b;
    col *= 1. + canopy * smoothstep(.1, .3, luma(col)) * smoothstep(.56, .7, g1 * g2 * 1.9) * .55 * sunK;
    if (uWx.x > .001) {
      // rain: darker wet surfaces, a glossy sheen on the leaves, puddles with ripples on trails and clearings
      float wet = uWx.x;
      col *= mix(1., mix(.78, .58, flo), wet);
      vec2 e = 1.5 / uPx;
      float hx = texture(uGeo, uvd + vec2(e.x, 0.)).r - g.r, hy = g.r - texture(uGeo, uvd + vec2(0., e.y)).r;
      vec3 N = normalize(vec3(-hx, -hy, 1.5 / uScale));
      float gl = vnoise(p * .55 + 7.);
      float spec = pow(max(dot(N, HV), 0.), 24.) * (.2 + 1.1 * gl * gl);
      col += wet * spec * (uSunC * .16 + uSkyC * 1.5 + vec3(.8, .9, 1.2) * uWx.w * 2.) * mix(.8, .08, flo);
      if (flo > .5) {
        float pn = texture(uNoise, p / 240. + 3.7).b, rut = 1. - smoothstep(2., 6.5, f.g);
        float pm = smoothstep(.57, .63, pn + rut * .2 - .04) * smoothstep(.2, .7, wet) * smoothstep(12., -12., f.r);
        if (pm > .001) {
          vec3 refl = uSkyC * .7 + uSunC * .015;
          vec2 cc = floor(p / 8.), hp = hash22(cc + uSeed);
          float ph = fract(t * (.8 + .6 * hp.x) + hp.y);
          float rr = length(p - (cc + .25 + .5 * hp) * 8.);
          float ring = exp(-pow((rr - ph * 4.5) * 1.5, 2.)) * (1. - ph) * step(hp.x, wet);
          col = mix(col, refl * (.4 + 3. * eA), pm * .7) + ring * refl * 1.6 * pm;
        }
      }
    }
    if (uWx.y > .001) {
      // snow: white crowns with dark gaps between the leaf clumps, snow-covered clearings, trampled near the icons
      float s = uWx.y;
      float n = texture(uNoise, p / 70. + 1.3).b, n2 = texture(uNoise, p / 23. + .7).a;
      float cov;
      if (mat > .5 && mat < 4.5) {
        float top = clamp(g.a, 0., 1.2), cav = clamp(fract(g.b * 16. + .001) / .96, 0., 1.);
        cov = smoothstep(.1, .4, s * .95 + top * .4 + cav * .65 - 1. + (n - .5) * .45);
      } else cov = smoothstep(0., .35, s * 1.3 - .3 + (n - .5) * .6 + (n2 - .5) * .35 - (mat > 4.5 ? .12 : 0.));
      float near = smoothstep(8., 80., f.b);
      cov *= mix(.55, 1., near);
      vec3 snowL = mix(uSunC, vec3(luma(uSunC)), .6) * sv + uSkyC * .5;
      vec3 snowC = vec3(.6, .63, .68) * snowL * clamp(eA / .06, .25, 1.1) * (.85 + .3 * n2) * mix(.72, 1., near);
      col = mix(col, snowC, cov);
    }
    // lightning lights the scene from above (less right around the icons)
    col += col / max(luma(newL), .03) * vec3(.75, .85, 1.1) * uWx.w * 1.6 * mix(.25, 1., smoothstep(20., 120., f.b));
  }
  vec2 cq = p / 2300. + uCloudOff + uSeed * .01;
  float cl = texture(uNoise, cq).r * .72 + texture(uNoise, cq * 2.7 + .3).a * .28;
  float cs = smoothstep(.47 - .13 * uWx2.y, .63 - .08 * uWx2.y, cl);
  col *= mix(1., .56, cs * pow(sunK, .7));
  vec4 ax = texture(uAux, uv);
  if (uLayer < .5) {
    float lit = smoothstep(.04, .2, luma(col));
    float rim = smoothstep(.03, .45, ax.g) * (1. - canopy);
    float dap = texture(uNoise, p / 150. + wd * ts * .018 + vec2(0., t * .004)).b;
    col *= 1. + lit * rim * (smoothstep(.36, .64, dap) - .5) * .75 * smoothstep(0., 40., f.b) * sunK;
    outColor = vec4(col, 1.);
  } else {
    float A = canopy;
    vec3 C = col * A;
    float open = ax.r;
    vec2 gq = floor(p / 18.);
    vec3 hh = hash32(gq + uSeed * 1.7 + 50.);
    if (hh.z > .8 && sunK > .02) {
      vec2 mp = (gq + .5 + .4 * vec2(sin(t * .3 + hh.x * 6.28), sin(t * .23 + hh.y * 6.28))) * 18.;
      vec2 md = p - mp; float d2 = dot(md, md);
      float tw = .5 + .5 * sin(t * (2. + hh.z * 3.) + hh.x * 40.);
      C += vec3(1., .85, .6) * exp(-d2 * 1.1) * 2.4 * tw * open * smoothstep(4., 24., f.b) * (1. - canopy) * (1. - cs * .7) * sunK * (1. - uWx.x);
    }
    vec2 mq = p / 1500. + uMistOff + uSeed * .013;
    float mn = texture(uNoise, mq).g * .65 + texture(uNoise, mq * 2.3 - t * .002).r * .35;
    float mist = smoothstep(.54, .74, mn) * .11 * (1. - ax.g * .4);
    mist *= mix(.3, 1., smoothstep(0., 90., f.b));
    float rev = smoothstep(0., .5, uIntro * 1.6 - texture(uNoise, p / 900. + .5).a * 1.4 + .25 - smoothstep(0., 400., f.b) * .4);
    mist = mix(.92, mist, rev);
    vec3 mistC = uMistC * (1. - cs * .45 * sunK);
    C = C * (1. - mist) + mistC * mist;
    A = A * (1. - mist) + mist;
    if (uWx.z + uWx2.w > .001) {
      // ground fog in the clearings and hollows, crowns poking through; a thin haze over everything
      float low = 1. - smoothstep(6., 125., g0.r);
      float fn = smoothstep(.3, .75, mn);
      float fa = uWx.z * (low * (.28 + .42 * fn) + .1) + uWx2.w * (1. - smoothstep(2., 50., g0.r)) * smoothstep(.3, .85, fn) * smoothstep(30., 160., f.b);
      fa = min(fa, .68) * mix(.7, 1., smoothstep(0., 60., f.b));
      C = C * (1. - fa) + uFogC * fa; A = A * (1. - fa) + fa;
    }
    float hz = .04;
    C = C * (1. - hz) + uHazeC * hz; A = A * (1. - hz) + hz;
    outColor = vec4(C, A);
  }
}`;

  /* ---------------------------------------------------------------- sprites */
  function ell(g, x, y, rx, ry, fill) { g.fillStyle = fill; g.beginPath(); g.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, TAU); g.fill(); }
  function rrect(g, x, y, w, h, r, fill) { g.fillStyle = fill; g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); g.fill(); }
  function poly(g, pts, fill, stroke, lw) {
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
  }
  // Draw fn into an offscreen canvas, then paint a dark outline (dilated silhouette) under it so small sprites stay readable
  function outlined(g, w, h, px, color, fn) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const o = c.getContext('2d'); fn(o, w, h);
    const s = document.createElement('canvas'); s.width = w; s.height = h;
    const so = s.getContext('2d'); so.drawImage(c, 0, 0); so.globalCompositeOperation = 'source-in'; so.fillStyle = color; so.fillRect(0, 0, w, h);
    for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; g.drawImage(s, Math.cos(a) * px, Math.sin(a) * px); }
    g.drawImage(c, 0, 0);
  }
  // Speeder bike, top view, nose toward +x
  function drawBike(g, w, h, imp) {
    const cy = h / 2, X = v => v * w, Y = v => cy + v * h;
    const hl = imp ? '#f2f1ec' : '#9a9468', hm = imp ? '#cfcec7' : '#76704f', hd = imp ? '#8a8984' : '#4d4a35', metal = '#5b5b55', dark = '#19191b';
    g.lineCap = 'round'; g.lineJoin = 'round';
    // steering booms
    g.strokeStyle = hd; g.lineWidth = h * 0.075;
    g.beginPath(); g.moveTo(X(0.58), Y(-0.07)); g.lineTo(X(0.88), Y(-0.1)); g.moveTo(X(0.58), Y(0.07)); g.lineTo(X(0.88), Y(0.1)); g.stroke();
    g.strokeStyle = hl; g.lineWidth = h * 0.025;
    g.beginPath(); g.moveTo(X(0.6), Y(-0.08)); g.lineTo(X(0.87), Y(-0.11)); g.moveTo(X(0.6), Y(0.06)); g.lineTo(X(0.87), Y(0.09)); g.stroke();
    // front steering vanes
    for (const s of [-1, 1]) {
      const y0 = s < 0 ? Y(-0.47) : Y(0.06), y1 = s < 0 ? Y(-0.06) : Y(0.47);
      rrect(g, X(0.82), y0, X(0.16), y1 - y0, h * 0.05, hd);
      rrect(g, X(0.835), y0 + h * 0.025, X(0.13), y1 - y0 - h * 0.05, h * 0.04, hm);
      rrect(g, X(0.85), y0 + h * 0.05, X(0.04), y1 - y0 - h * 0.1, h * 0.02, hl);
      g.fillStyle = dark; for (let k = 0; k < 3; k++) g.fillRect(X(0.92), y0 + h * (0.07 + k * 0.11), X(0.035), h * 0.035);
    }
    // rear stabilizer fins
    for (const s of [-1, 1]) {
      poly(g, [[X(0.06), Y(0.14 * s)], [X(0.1), Y(0.47 * s)], [X(0.24), Y(0.45 * s)], [X(0.3), Y(0.16 * s)]], hd);
      poly(g, [[X(0.09), Y(0.17 * s)], [X(0.12), Y(0.41 * s)], [X(0.22), Y(0.4 * s)], [X(0.27), Y(0.18 * s)]], hm);
    }
    // engine block with vents and twin exhausts
    rrect(g, X(0.02), Y(-0.29), X(0.36), h * 0.58, h * 0.14, hd);
    rrect(g, X(0.04), Y(-0.25), X(0.32), h * 0.5, h * 0.12, hm);
    rrect(g, X(0.07), Y(-0.17), X(0.22), h * 0.2, h * 0.06, hl);
    g.strokeStyle = hd; g.lineWidth = h * 0.022;
    for (let k = 0; k < 5; k++) { g.beginPath(); g.moveTo(X(0.09 + k * 0.04), Y(0.02)); g.lineTo(X(0.09 + k * 0.04), Y(0.2)); g.stroke(); }
    ell(g, X(0.03), Y(-0.13), X(0.025), h * 0.085, dark); ell(g, X(0.03), Y(0.13), X(0.025), h * 0.085, dark);
    // main hull
    g.fillStyle = hd; g.beginPath(); g.moveTo(X(0.28), Y(-0.22)); g.quadraticCurveTo(X(0.55), Y(-0.22), X(0.74), Y(0)); g.quadraticCurveTo(X(0.55), Y(0.22), X(0.28), Y(0.22)); g.closePath(); g.fill();
    g.fillStyle = hm; g.beginPath(); g.moveTo(X(0.3), Y(-0.18)); g.quadraticCurveTo(X(0.55), Y(-0.18), X(0.71), Y(0)); g.quadraticCurveTo(X(0.55), Y(0.18), X(0.3), Y(0.18)); g.closePath(); g.fill();
    g.fillStyle = hl; g.beginPath(); g.moveTo(X(0.45), Y(-0.12)); g.quadraticCurveTo(X(0.6), Y(-0.12), X(0.69), Y(-0.01)); g.quadraticCurveTo(X(0.6), Y(0.04), X(0.45), Y(0.04)); g.closePath(); g.fill();
    ell(g, X(0.64), Y(0), X(0.025), h * 0.05, dark);
    // rider: legs, torso, arms, helmet
    const suit = imp ? '#1d1d20' : '#4f5d34', suit2 = imp ? '#0c0c0d' : '#37432a', camo = imp ? '#2b2b2e' : '#77753f';
    ell(g, X(0.4), Y(-0.23), X(0.08), h * 0.07, suit2); ell(g, X(0.4), Y(0.23), X(0.08), h * 0.07, suit2);
    g.strokeStyle = suit; g.lineWidth = h * 0.1;
    g.beginPath(); g.moveTo(X(0.42), Y(-0.2)); g.lineTo(X(0.57), Y(-0.11)); g.moveTo(X(0.42), Y(0.2)); g.lineTo(X(0.57), Y(0.11)); g.stroke();
    ell(g, X(0.58), Y(-0.1), X(0.02), h * 0.05, dark); ell(g, X(0.58), Y(0.1), X(0.02), h * 0.05, dark);
    ell(g, X(0.39), Y(0), X(0.08), h * 0.29, suit);
    if (imp) { ell(g, X(0.4), Y(-0.18), X(0.05), h * 0.1, '#ebebe6'); ell(g, X(0.4), Y(0.18), X(0.05), h * 0.1, '#ebebe6'); rrect(g, X(0.34), Y(-0.06), X(0.06), h * 0.12, 3, '#dcdcd6'); }
    else { ell(g, X(0.37), Y(-0.11), X(0.035), h * 0.09, suit2); ell(g, X(0.41), Y(0.13), X(0.03), h * 0.08, camo); ell(g, X(0.35), Y(0.07), X(0.025), h * 0.07, camo); }
    ell(g, X(0.45), Y(0), X(0.055), h * 0.155, imp ? '#f4f4f0' : '#646840');
    ell(g, X(0.47), Y(0), X(0.024), h * 0.11, imp ? '#222' : '#3e432a');
    ell(g, X(0.435), Y(-0.05), X(0.024), h * 0.055, 'rgba(255,255,255,0.6)');
    // soft top light
    const rg = g.createRadialGradient(X(0.4), Y(-0.1), 0, X(0.4), Y(-0.1), X(0.45));
    rg.addColorStop(0, 'rgba(255,250,235,0.16)'); rg.addColorStop(1, 'rgba(0,0,0,0.14)');
    g.globalCompositeOperation = 'source-atop'; g.fillStyle = rg; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'source-over';
  }
  // Two-legged walker head, top view, facing +x
  function drawWalker(g, w, h) {
    const c = h / 2, X = v => v * w, Y = v => c + v * h;
    const base = '#8f8e88', lite = '#b4b3ac', dk = '#5a5955', vdk = '#2c2c2a';
    g.lineJoin = 'round'; g.lineCap = 'round';
    // side guns
    rrect(g, X(0.42), Y(-0.47), X(0.5), h * 0.045, 3, vdk); rrect(g, X(0.42), Y(-0.40), X(0.46), h * 0.045, 3, vdk);
    rrect(g, X(0.36), Y(-0.48), X(0.2), h * 0.15, 4, dk);
    rrect(g, X(0.36), Y(0.33), X(0.36), h * 0.15, 5, dk); rrect(g, X(0.38), Y(0.355), X(0.32), h * 0.1, 4, '#6f6e69');
    for (let k = 0; k < 3; k++) ell(g, X(0.7), Y(0.37 + k * 0.035), X(0.012), h * 0.012, vdk);
    // chin guns
    rrect(g, X(0.84), Y(-0.09), X(0.16), h * 0.04, 2, vdk); rrect(g, X(0.84), Y(0.05), X(0.16), h * 0.04, 2, vdk);
    // body
    poly(g, [[X(0.12), Y(-0.33)], [X(0.68), Y(-0.33)], [X(0.88), Y(-0.16)], [X(0.88), Y(0.16)], [X(0.68), Y(0.33)], [X(0.12), Y(0.33)], [X(0.08), Y(0.2)], [X(0.08), Y(-0.2)]], dk);
    poly(g, [[X(0.15), Y(-0.29)], [X(0.66), Y(-0.29)], [X(0.84), Y(-0.14)], [X(0.84), Y(0.14)], [X(0.66), Y(0.29)], [X(0.15), Y(0.29)], [X(0.12), Y(0.18)], [X(0.12), Y(-0.18)]], base);
    poly(g, [[X(0.2), Y(-0.22)], [X(0.62), Y(-0.22)], [X(0.72), Y(-0.1)], [X(0.72), Y(0.1)], [X(0.62), Y(0.22)], [X(0.2), Y(0.22)]], lite);
    poly(g, [[X(0.66), Y(-0.29)], [X(0.84), Y(-0.14)], [X(0.84), Y(0.14)], [X(0.66), Y(0.29)], [X(0.72), Y(0.1)], [X(0.72), Y(-0.1)], [X(0.62), Y(-0.22)]], '#7b7a74');
    // viewports
    rrect(g, X(0.8), Y(-0.13), X(0.04), h * 0.08, 2, '#121212'); rrect(g, X(0.8), Y(0.05), X(0.04), h * 0.08, 2, '#121212');
    // panel lines and hatch
    g.strokeStyle = dk; g.lineWidth = w * 0.01;
    g.beginPath(); g.moveTo(X(0.3), Y(-0.29)); g.lineTo(X(0.3), Y(0.29)); g.moveTo(X(0.2), Y(0)); g.lineTo(X(0.3), Y(0)); g.moveTo(X(0.58), Y(-0.22)); g.lineTo(X(0.58), Y(0.22)); g.stroke();
    ell(g, X(0.44), Y(0), X(0.1), h * 0.1, dk); ell(g, X(0.44), Y(0), X(0.08), h * 0.08, '#a3a29b'); ell(g, X(0.425), Y(-0.02), X(0.03), h * 0.03, 'rgba(255,255,255,0.5)');
    g.fillStyle = vdk; for (let k = 0; k < 4; k++) g.fillRect(X(0.16), Y(-0.15 + k * 0.08), X(0.08), h * 0.025);
    const rg = g.createLinearGradient(X(0.1), Y(-0.33), X(0.6), Y(0.4));
    rg.addColorStop(0, 'rgba(255,248,230,0.22)'); rg.addColorStop(1, 'rgba(0,0,0,0.25)');
    g.globalCompositeOperation = 'source-atop'; g.fillStyle = rg; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'source-over';
  }
  // Fern rosette painted from photographed sprays (img: two sprays stacked, 512x192 bands, base at x = 0)
  function drawFern(g, w, h, img, v) {
    if (!img || !img.naturalWidth) return;
    let s = 1234 + v * 7777;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const cx = w / 2, cy = h / 2, n = [10, 12, 8][v];
    const fr = [];
    for (let i = 0; i < n; i++) fr.push({ a: i / n * TAU + (rnd() - 0.5) * 0.55, len: w * (0.34 + rnd() * 0.14), band: rnd() < 0.5 ? 0 : 1, wid: 0.75 + rnd() * 0.35, layer: rnd() });
    fr.sort((a, b) => a.layer - b.layer);
    for (const f of fr) {
      g.save(); g.translate(cx, cy); g.rotate(f.a);
      const bh = f.len * 0.36 * f.wid;
      g.filter = 'brightness(' + (0.5 + 0.55 * f.layer).toFixed(2) + ')' + (v === 2 ? ' hue-rotate(-12deg) saturate(0.8)' : '');
      g.drawImage(img, 0, f.band * 192, 512, 192, w * 0.015, -bh / 2, f.len, bh);
      g.restore();
    }
    g.filter = 'none';
    g.globalCompositeOperation = 'source-atop';
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, w * 0.5);
    rg.addColorStop(0, 'rgba(10,14,4,0.7)'); rg.addColorStop(0.3, 'rgba(10,14,4,0.2)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
  }
  // Rebel snub fighter, top view, nose toward +x (original design: long nose, four engine pods, wingtip cannons)
  function drawFighter(g, w, h) {
    const cy = h / 2, X = v => v * w, Y = v => cy + v * h;
    const lt = '#d9d8d2', md = '#aeada6', dk = '#6e6d67', vdk = '#2a2a2a', red = '#a54a3c';
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const s of [-1, 1]) {
      // wing, swept slightly back, with a colored stripe and a long cannon at the tip
      poly(g, [[X(0.16), Y(0.05 * s)], [X(0.42), Y(0.05 * s)], [X(0.36), Y(0.47 * s)], [X(0.2), Y(0.47 * s)]], dk);
      poly(g, [[X(0.18), Y(0.07 * s)], [X(0.4), Y(0.07 * s)], [X(0.345), Y(0.44 * s)], [X(0.215), Y(0.44 * s)]], md);
      poly(g, [[X(0.235), Y(0.3 * s)], [X(0.37), Y(0.3 * s)], [X(0.36), Y(0.36 * s)], [X(0.225), Y(0.36 * s)]], red);
      rrect(g, X(0.2), Y(0.455 * s) - h * 0.025, X(0.6), h * 0.05, h * 0.02, vdk);
      rrect(g, X(0.2), Y(0.455 * s) - h * 0.012, X(0.56), h * 0.024, h * 0.01, '#77766f');
      // engine pods
      rrect(g, X(0.03), Y(0.15 * s) - h * 0.065, X(0.3), h * 0.13, h * 0.06, dk);
      rrect(g, X(0.05), Y(0.15 * s) - h * 0.045, X(0.26), h * 0.09, h * 0.04, lt);
      ell(g, X(0.04), Y(0.15 * s), X(0.022), h * 0.045, vdk);
    }
    // fuselage and nose
    poly(g, [[X(0.06), Y(-0.08)], [X(0.5), Y(-0.08)], [X(0.97), Y(-0.025)], [X(0.99), Y(0)], [X(0.97), Y(0.025)], [X(0.5), Y(0.08)], [X(0.06), Y(0.08)]], dk);
    poly(g, [[X(0.08), Y(-0.06)], [X(0.5), Y(-0.06)], [X(0.95), Y(-0.017)], [X(0.95), Y(0.017)], [X(0.5), Y(0.06)], [X(0.08), Y(0.06)]], lt);
    rrect(g, X(0.7), Y(-0.012), X(0.2), h * 0.024, 2, red);
    // cockpit canopy and astromech dome
    ell(g, X(0.5), Y(0), X(0.07), h * 0.05, vdk); ell(g, X(0.49), Y(-0.015), X(0.03), h * 0.018, 'rgba(255,255,255,0.45)');
    ell(g, X(0.32), Y(0), X(0.035), h * 0.04, '#e8e7e2'); ell(g, X(0.32), Y(0), X(0.015), h * 0.018, '#4d6fa8');
    const rg = g.createLinearGradient(X(0.1), Y(-0.4), X(0.6), Y(0.5));
    rg.addColorStop(0, 'rgba(255,250,235,0.18)'); rg.addColorStop(1, 'rgba(0,0,0,0.22)');
    g.globalCompositeOperation = 'source-atop'; g.fillStyle = rg; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'source-over';
  }
  function defineSprites(atlas) {
    atlas.define('fighter', 256, 224, (g, w, h) => outlined(g, w, h, 2.5, 'rgba(14,13,10,0.75)', drawFighter));
    atlas.define('ring', 64, 64, (g, w, h) => {
      g.strokeStyle = '#fff'; g.lineWidth = 5; g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 6, 0, TAU); g.stroke();
    });
    atlas.define('scorch', 128, 128, (g, w, h) => {
      let s = 99; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.35, 'rgba(255,255,255,0.85)'); rg.addColorStop(0.7, 'rgba(255,255,255,0.3)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.5)';
      for (let i = 0; i < 26; i++) {
        const a = rnd() * TAU, r0 = w * 0.12, r1 = w * (0.3 + rnd() * 0.18), wd = 0.06 + rnd() * 0.08;
        g.beginPath(); g.moveTo(w / 2 + Math.cos(a - wd) * r0, h / 2 + Math.sin(a - wd) * r0); g.lineTo(w / 2 + Math.cos(a) * r1, h / 2 + Math.sin(a) * r1);
        g.lineTo(w / 2 + Math.cos(a + wd) * r0, h / 2 + Math.sin(a + wd) * r0); g.fill();
      }
    });
    atlas.define('leaf', 24, 16, (g, w, h) => {
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(1, h / 2); g.quadraticCurveTo(w * 0.5, -1, w - 1, h / 2); g.quadraticCurveTo(w * 0.5, h + 1, 1, h / 2); g.fill();
    });
    atlas.define('bikeR', 256, 96, (g, w, h) => outlined(g, w, h, 3.2, 'rgba(14,13,10,0.85)', (o, W, H) => drawBike(o, W, H, false)));
    atlas.define('bikeI', 256, 96, (g, w, h) => outlined(g, w, h, 3.2, 'rgba(14,13,10,0.85)', (o, W, H) => drawBike(o, W, H, true)));
    atlas.define('atHead', 192, 192, (g, w, h) => outlined(g, w, h, 3, 'rgba(14,13,10,0.8)', drawWalker));
    for (let v = 0; v < 3; v++) atlas.define('fern' + v, 160, 160, (g, w, h, img) => drawFern(g, w, h, img, v), { image: ASSET + 'spray.png' });
    atlas.define('puff', 64, 64, (g, w, h) => {
      const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.45, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
    });
    atlas.define('chunk', 16, 16, (g) => {
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(2, 5); g.lineTo(9, 1); g.lineTo(15, 7); g.lineTo(11, 15); g.lineTo(3, 12); g.fill();
    });
    atlas.define('strut', 96, 24, (g, w, h) => {
      rrect(g, 0, 3, w, h - 6, 7, '#5d5d58'); rrect(g, 6, 6, w - 12, 4, 2, '#8c8c86'); rrect(g, 6, h - 9, w - 12, 3, 2, '#404040');
      ell(g, 10, h / 2, 8, 8, '#3c3c39'); ell(g, w - 10, h / 2, 8, 8, '#3c3c39'); ell(g, 10, h / 2, 3.5, 3.5, '#77776f'); ell(g, w - 10, h / 2, 3.5, 3.5, '#77776f');
    });
    atlas.define('foot', 48, 48, (g, w, h) => {
      poly(g, [[6, 14], [40, 4], [45, 24], [40, 44], [6, 34]], '#4a4a46');
      poly(g, [[10, 18], [36, 10], [40, 24], [36, 38], [10, 30]], '#6c6c66');
      rrect(g, 14, 20, 18, 8, 3, '#85857e');
    });
    atlas.define('bird', 64, 96, (g, w, h) => {
      g.fillStyle = '#fff';
      g.beginPath(); g.ellipse(w * 0.5, h * 0.5, w * 0.32, h * 0.055, 0, 0, TAU); g.fill();
      g.beginPath(); g.moveTo(w * 0.1, h * 0.5); g.lineTo(0, h * 0.42); g.lineTo(0, h * 0.58); g.fill();
      g.beginPath(); g.moveTo(w * 0.62, h * 0.47); g.quadraticCurveTo(w * 0.5, h * 0.2, w * 0.22, h * 0.02); g.quadraticCurveTo(w * 0.32, h * 0.25, w * 0.36, h * 0.47); g.fill();
      g.beginPath(); g.moveTo(w * 0.62, h * 0.53); g.quadraticCurveTo(w * 0.5, h * 0.8, w * 0.22, h * 0.98); g.quadraticCurveTo(w * 0.32, h * 0.75, w * 0.36, h * 0.53); g.fill();
    });
  }

  /* ---------------------------------------------------------------- trail graph */
  // Nodes sit on a jittered grid keyed by cell; every edge path is seeded by its node keys, so a layout change only
  // rebuilds the trails near the icons that moved, and vehicles on unchanged trails keep going without a jump.
  function bez(a, c1, c2, b, t) {
    const u = 1 - t;
    return { x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y };
  }
  function seedRng(str, base) {
    let h = 2166136261 ^ base;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    let a = h >>> 0;
    return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function makePath(ctx, a, b, rng) {
    const W = ctx.W, H = ctx.H, dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    const px = -dy / L, py = dx / L;
    for (let tries = 0; tries < 6; tries++) {
      const k = tries === 5 ? 0 : 1 - tries * 0.2;
      const o1 = (rng() - 0.5) * 0.6 * L * k, o2 = (rng() - 0.5) * 0.6 * L * k;
      const c1 = { x: a.x + dx / 3 + px * o1, y: a.y + dy / 3 + py * o1 }, c2 = { x: a.x + 2 * dx / 3 + px * o2, y: a.y + 2 * dy / 3 + py * o2 };
      const n = Math.max(8, Math.ceil(L / 12)), ph = rng() * TAU, wf = 2 + rng() * 3;
      const pts = []; let ok = true;
      for (let i = 0; i <= n; i++) {
        const t = i / n, q = bez(a, c1, c2, b, t);
        const wob = Math.sin(t * Math.PI * wf + ph) * 5 * Math.sin(t * Math.PI);
        q.x += px * wob; q.y += py * wob;
        if (q.x > -10 && q.y > -10 && q.x < W + 10 && q.y < H + 10 && ctx.distAt(q.x, q.y) < 30) { ok = false; break; }
        pts.push(q);
      }
      if (ok) return pts;
    }
    return null;
  }
  function addEdge(G, a, b, pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const e = { a, b, pts, cum, len: cum[cum.length - 1], key: a.key + '|' + b.key };
    a.edges.push(e); b.edges.push(e); G.edges.push(e); G.map.set(e.key, e);
    if (a.exit || b.exit) G.exitEdges.push(e);
    return e;
  }
  function buildGraph(ctx) {
    const W = ctx.W, H = ctx.H, sp = 200, G = { nodes: [], edges: [], exitEdges: [], map: new Map() };
    for (let gy = 0; gy * sp < H + sp; gy++) for (let gx = 0; gx * sp < W + sp; gx++) {
      const x = (gx + 0.15 + ctx.hash(gx, gy, 11) * 0.7) * sp - sp * 0.2, y = (gy + 0.15 + ctx.hash(gx, gy, 12) * 0.7) * sp - sp * 0.2;
      if (ctx.hash(gx, gy, 13) < 0.1) continue;
      if (x < 24 || y < 24 || x > W - 24 || y > H - 24) continue;
      if (ctx.distAt(x, y) < 44) continue;
      G.nodes.push({ x, y, edges: [], exit: false, key: gx + ',' + gy });
    }
    const inner = G.nodes.slice();
    const angOK = (n, ang) => n.edges.every(e => {
      const o = e.a === n ? e.b : e.a; let d = Math.atan2(o.y - n.y, o.x - n.x) - ang; d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d) > 0.55;
    });
    for (const n of inner) {
      const cand = inner.filter(o => o !== n).map(o => ({ o, d: Math.hypot(o.x - n.x, o.y - n.y) })).filter(c => c.d < sp * 1.8).sort((p, q) => p.d - q.d);
      for (const c of cand.slice(0, 4)) {
        const o = c.o;
        if (n.edges.length >= 3 || o.edges.length >= 4) continue;
        if (n.edges.some(e => e.a === o || e.b === o)) continue;
        const ang = Math.atan2(o.y - n.y, o.x - n.x);
        if (!angOK(n, ang) || !angOK(o, ang + Math.PI)) continue;
        const pts = makePath(ctx, n, o, seedRng(n.key + '|' + o.key, ctx.seed));
        if (pts) addEdge(G, n, o, pts);
      }
    }
    for (const n of inner) {
      const rng = seedRng('x' + n.key, ctx.seed);
      const dl = n.x, dr = W - n.x, dt = n.y, db = H - n.y, m = Math.min(dl, dr, dt, db);
      if (m > sp * 1.05 || rng() < 0.3) continue;
      const j = (rng() - 0.5) * sp * 0.5;
      const ex = m === dl ? { x: -70, y: n.y + j } : m === dr ? { x: W + 70, y: n.y + j } : m === dt ? { x: n.x + j, y: -70 } : { x: n.x + j, y: H + 70 };
      const node = { x: ex.x, y: ex.y, edges: [], exit: true, key: 'x' + n.key };
      if (!angOK(n, Math.atan2(node.y - n.y, node.x - n.x))) continue;
      const pts = makePath(ctx, n, node, rng);
      if (pts) { G.nodes.push(node); addEdge(G, n, node, pts); }
    }
    return G;
  }
  function edgePos(e, u, out) {
    const c = e.cum; let lo = 0, hi = c.length - 1;
    u = clamp(u, 0, e.len);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= u) lo = m; else hi = m; }
    const t = (u - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
    const a = e.pts[lo], b = e.pts[hi];
    out.x = a.x + (b.x - a.x) * t; out.y = a.y + (b.y - a.y) * t; out.ang = Math.atan2(b.y - a.y, b.x - a.x);
    return out;
  }
  function outAngle(e, node) {
    const P = e.pts, n = P.length;
    if (e.a === node) return Math.atan2(P[Math.min(2, n - 1)].y - P[0].y, P[Math.min(2, n - 1)].x - P[0].x);
    return Math.atan2(P[Math.max(0, n - 3)].y - P[n - 1].y, P[Math.max(0, n - 3)].x - P[n - 1].x);
  }
  // Advance a mover {e, dir, u, age, ang} by dist along the graph. Sets m.exited when it leaves through an exit node.
  function stepMover(m, dist, rng, allowExit = true) {
    m.u += m.dir * dist;
    let guard = 0;
    while ((m.u > m.e.len || m.u < 0) && guard++ < 4) {
      const fwd = m.u > m.e.len, over = fwd ? m.u - m.e.len : -m.u, node = fwd ? m.e.b : m.e.a;
      if (node.exit && allowExit && m.age > 0.5) { m.exited = true; m.u = fwd ? m.e.len : 0; return; }
      const opts = node.edges.filter(x => x !== m.e && !(x.a.exit && !allowExit) && !(x.b.exit && !allowExit));
      let ne = m.e;
      if (opts.length) {
        const ws = opts.map(x => { const d = outAngle(x, node) - m.ang; return 0.12 + Math.pow(Math.max(0, Math.cos(d)), 2); });
        let s = ws.reduce((a, b) => a + b, 0) * rng();
        for (let i = 0; i < opts.length; i++) { s -= ws[i]; if (s <= 0) { ne = opts[i]; break; } }
      }
      m.e = ne;
      if (ne.a === node) { m.dir = 1; m.u = over; } else { m.dir = -1; m.u = ne.len - over; }
    }
  }
  // Move a mover onto the new graph: the same edge if it survived, else the nearest trail point heading the same way.
  // Returns false when the nearest trail is too far away (the caller fades the vehicle out instead).
  function remapMover(m, x, y, G) {
    const e2 = G.map.get(m.e.key);
    if (e2) { m.u = clamp(m.u / Math.max(1e-6, m.e.len) * e2.len, 0, e2.len); m.e = e2; return true; }
    let best = null, bi = 0, bd = 1e18;
    for (const e of G.edges) {
      if (e.a.exit || e.b.exit) continue;
      for (let i = 0; i < e.pts.length; i++) { const q = e.pts[i], d = (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y); if (d < bd) { bd = d; best = e; bi = i; } }
    }
    if (!best || bd > 160 * 160) return false;
    const i0 = Math.min(bi, best.pts.length - 2), tang = Math.atan2(best.pts[i0 + 1].y - best.pts[i0].y, best.pts[i0 + 1].x - best.pts[i0].x);
    m.e = best; m.u = best.cum[bi]; m.dir = Math.cos(tang - m.ang) >= 0 ? 1 : -1;
    return true;
  }

  /* ---------------------------------------------------------------- vehicles */
  const tmp = { x: 0, y: 0, ang: 0 };
  const BIKE_W = 44;
  function spawnBike(ctx, atExit, kind) {
    const G = st.graph, r = st.rng;
    if (!G || !G.edges.length) return null;
    let e, dir, u;
    if (atExit && G.exitEdges.length) {
      e = G.exitEdges[(r() * G.exitEdges.length) | 0];
      if (e.a.exit) { dir = 1; u = 0; } else { dir = -1; u = e.len; }
    } else {
      e = G.edges[(r() * G.edges.length) | 0]; dir = r() < 0.5 ? 1 : -1; u = r() * e.len;
    }
    const b = { m: { e, dir, u, age: 0, ang: 0 }, kind: kind || (r() < 0.55 ? 'i' : 'r'), spd: 175 + r() * 85, alpha: atExit ? 1 : 0, fadeIn: !atExit,
      x: 0, y: 0, ang: 0, ph: r() * TAU, puffT: 0, hist: [], fireT: 0, boost: 1, ox: 0, oy: 0, bank: 0 };
    edgePos(e, u, tmp); b.x = tmp.x; b.y = tmp.y; b.ang = b.m.ang = tmp.ang + (dir < 0 ? Math.PI : 0);
    return b;
  }
  function spawnWalker(ctx_) {
    const G = st.graph, r = st.rng;
    if (!G) return null;
    const inner = G.edges.filter(e => !e.a.exit && !e.b.exit && e.len > 120);
    if (!inner.length) return null;
    // prefer trails through the open clearings around the icons, where the walker is not hidden by the canopy
    const score = e => { let s = 0; for (let i = 0; i < e.pts.length; i += 2) s += ctx_.blobAt(e.pts[i].x, e.pts[i].y) < 30 ? 1 : 0; return s / Math.ceil(e.pts.length / 2) + r() * 0.25; };
    inner.sort((a, b) => score(b) - score(a));
    const e = inner[(r() * Math.min(3, inner.length)) | 0];
    const w = { m: { e, dir: r() < 0.5 ? 1 : -1, u: e.len * (0.2 + r() * 0.6), age: 0, ang: 0 }, phase: 0, x: 0, y: 0, ang: 0, headAng: 0, fireT: 3 + r() * 3, aim: null, burst: 0, alpha: 0, ox: 0, oy: 0 };
    edgePos(e, w.m.u, tmp); w.x = tmp.x; w.y = tmp.y; w.ang = w.headAng = w.m.ang = tmp.ang + (w.m.dir < 0 ? Math.PI : 0);
    return w;
  }
  function fire(x, y, ang, dist, color, o = {}) {
    const speed = o.speed || 820, r = st.rng;
    st.bolts.fire(x, y, ang, { speed, len: o.len || 17, color, intensity: o.intensity || 4.2, width: o.width || 1.15, life: Math.max(0.12, dist / speed * (0.8 + r() * 0.45)) });
  }
  const RED = [1, 0.13, 0.07], GREEN = [0.25, 1, 0.3];
  function debris(x, y, big) {
    const r = st.rng, n = big ? 22 : 6;
    for (let i = 0; i < n; i++) {
      const a = r() * TAU, s = (big ? 60 : 30) + r() * (big ? 160 : 70);
      st.chunks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, age: 0, life: 0.4 + r() * (big ? 0.9 : 0.4), rot: r() * TAU, vr: (r() - 0.5) * 14, size: (big ? 2.5 : 1.6) + r() * 2 });
    }
    for (let i = 0; i < (big ? 6 : 3); i++) {
      st.dust.push({ x: x + (r() - 0.5) * 6, y: y + (r() - 0.5) * 6, vx: (r() - 0.5) * 30, vy: (r() - 0.5) * 30, age: 0, life: 0.9 + r() * 0.6, s0: 4, s1: big ? 30 : 16 + r() * 8, a: 0.4, c: [0.2, 0.16, 0.12] });
    }
    if (big) {
      st.booms.push({ x, y, age: 0, life: 0.8 });
      for (let i = 0; i < 8; i++) st.smoke.push({ x: x + (r() - 0.5) * 14, y: y + (r() - 0.5) * 14, vx: 10 + (r() - 0.5) * 20, vy: 6 + (r() - 0.5) * 20, age: -i * 0.12, life: 3 + r() * 2, s0: 10, s1: 46 + r() * 30, a: 0.38, c: [0.16, 0.15, 0.14] });
    }
  }
  function startChase(ctx) {
    const r = st.rng;
    const cand = st.bikes.filter(b => !b.temp && !b.out && b.alpha > 0.9 && b.x > 60 && b.y > 60 && b.x < ctx.W - 60 && b.y < ctx.H - 60);
    if (!cand.length) return;
    const prey = cand[(r() * cand.length) | 0];
    const hk = prey.kind === 'i' ? 'r' : 'i';
    const n = 1 + (r() < 0.45 + 0.4 * ctx.P.skirmish ? 1 : 0);
    const hunters = [];
    for (let i = 0; i < n; i++) {
      hunters.push({ kind: hk, temp: true, follow: prey, delay: 0.45 + i * 0.34 + r() * 0.1, alpha: 0, x: prey.x, y: prey.y, ang: prey.ang, fireT: 0.6 + r() * 0.6, puffT: 0, ph: r() * TAU, wob: (r() - 0.5) * 8, bank: 0 });
    }
    prey.boost = 1.3; prey.fireT = 1 + r() * 2;
    st.bikes.push(...hunters);
    st.chase = { prey, hunters, t: 0, dur: 7 + r() * 7 };
  }
  function endChase() {
    const c = st.chase; if (!c) return;
    const r = st.rng;
    for (const h of c.hunters) h.out = true;
    c.prey.boost = 1;
    if (r() < 0.35 && c.hunters.length) { const h = c.hunters[c.hunters.length - 1]; if (h.alpha > 0.5) { debris(h.x, h.y, true); h.dead = true; } }
    st.chase = null;
  }
  function histAt(b, tt, out) {
    const H = b.hist;
    if (!H.length) { out.x = b.x; out.y = b.y; out.ang = b.ang; return out; }
    if (tt <= H[0].t) {
      const back = (H[0].t - tt) * b.spd;
      out.x = H[0].x - Math.cos(H[0].ang) * back; out.y = H[0].y - Math.sin(H[0].ang) * back; out.ang = H[0].ang; return out;
    }
    for (let i = H.length - 1; i > 0; i--) {
      if (H[i - 1].t <= tt) {
        const a = H[i - 1], c = H[i], k = (tt - a.t) / Math.max(1e-5, c.t - a.t);
        out.x = a.x + (c.x - a.x) * k; out.y = a.y + (c.y - a.y) * k; out.ang = angLerp(a.ang, c.ang, k); return out;
      }
    }
    const L = H[H.length - 1]; out.x = L.x; out.y = L.y; out.ang = L.ang; return out;
  }

  /* ---------------------------------------------------------------- ferns */
  function trailGrid(ctx, G) {
    const cs = 8, gw = Math.ceil(ctx.W / cs) + 2, gh = Math.ceil(ctx.H / cs) + 2, a = new Uint8Array(gw * gh);
    for (const e of G.edges) for (let i = 1; i < e.pts.length; i++) {
      const p0 = e.pts[i - 1], p1 = e.pts[i];
      for (let s = 0; s < 3; s++) {
        const x = p0.x + (p1.x - p0.x) * s / 3, y = p0.y + (p1.y - p0.y) * s / 3, cx = Math.floor(x / cs), cy = Math.floor(y / cs);
        for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) { const X = cx + k, Y = cy + j; if (X >= 0 && Y >= 0 && X < gw && Y < gh) a[Y * gw + X] = 1; }
      }
    }
    return (x, y) => { const X = Math.floor(x / cs), Y = Math.floor(y / cs); return X >= 0 && Y >= 0 && X < gw && Y < gh && a[Y * gw + X] === 1; };
  }
  function placeFerns(ctx) {
    const onTrail = trailGrid(ctx, st.graph), cs = 17, list = [];
    for (let gy = -1; gy * cs < ctx.H + cs; gy++) for (let gx = -1; gx * cs < ctx.W + cs; gx++) {
      const h1 = ctx.hash(gx, gy, 71);
      const x = (gx + ctx.hash(gx, gy, 72)) * cs, y = (gy + ctx.hash(gx, gy, 73)) * cs;
      const d = ctx.distAt(x, y);
      if (d < 16) continue;
      const pr = (ctx.blobAt(x, y) < 140 ? 0.62 : 0.3) * clamp((d - 16) / 40, 0, 1);
      if (h1 > pr || onTrail(x, y)) continue;
      const h2 = ctx.hash(gx, gy, 74);
      list.push({ x, y, v: (h2 * 3) | 0, w: 20 + 16 * ctx.hash(gx, gy, 75) * clamp((d - 10) / 50, 0.4, 1), rot: h2 * 40, k: ctx.hash(gx, gy, 76) });
    }
    st.ferns = list; st.fernDirty = true;
  }
  function drawFerns(ctx) {
    const gl = ctx.gl;
    ctx.bindTarget(st.tFern);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    for (const f of st.ferns) {
      const tint = f.v === 2 ? [0.55, 0.52, 0.32] : f.v === 1 ? [0.40, 0.46, 0.28] : [0.46, 0.52, 0.30];
      const k = 0.8 + 0.4 * f.k;
      ctx.sprite('fern' + f.v, f.x, f.y, { w: f.w, rot: f.rot, tint: [tint[0] * k, tint[1] * k, tint[2] * k] });
    }
    ctx.flush();
    st.fernDirty = false;
  }

  /* ---------------------------------------------------------------- targets and cache pipeline */
  const TARGETS = ['tField', 'tTrail0', 'tTrail1', 'tGeo', 'tLit', 'tGeoLo', 'tLitLo', 'tFern', 'tAux'];
  function freeTargets(ctx) { for (const k of TARGETS) { if (st[k]) ctx.freeTarget(st[k]); st[k] = null; } }
  function clearT(ctx, t) { const gl = ctx.gl; ctx.bindTarget(t); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  function allocTargets(ctx) {
    freeTargets(ctx);
    const hw = Math.max(8, Math.ceil(ctx.W / 2)), hh = Math.max(8, Math.ceil(ctx.H / 2));
    const lw = Math.max(8, ctx.pxW >> 1), lh = Math.max(8, ctx.pxH >> 1);
    st.tField = ctx.makeTarget(hw, hh, { float: true });
    st.tTrail0 = ctx.makeTarget(hw, hh, { float: true }); st.tTrail1 = ctx.makeTarget(hw, hh, { float: true });
    st.tAux = ctx.makeTarget(hw, hh, { float: true });
    st.tGeo = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true });
    st.tLit = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true });
    st.tGeoLo = ctx.makeTarget(lw, lh, { float: true });
    st.tLitLo = ctx.makeTarget(lw, lh, { float: true });
    st.tFern = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: false });
    for (const k of ['tTrail0', 'tTrail1', 'tFern']) clearT(ctx, st[k]);
    // the height maps get a mip chain (cone-traced shadows and ambient occlusion read the coarser levels)
    const gl = ctx.gl;
    for (const t of [st.tGeo, st.tGeoLo]) { gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    st.trailDirty = true; st.fernDirty = true; st.needHi = true; st.loValid = false; st.hiStep = -1; st.show = null;
    st.size = ctx.pxW + 'x' + ctx.pxH;
  }
  function ensureNoise(ctx) {
    if (st.tNoise) return;
    const gl = ctx.gl;
    st.tNoise = ctx.makeTarget(512, 512, { float: false, repeat: true });
    ctx.fullscreen(st.pNoise, {}, {}, st.tNoise);
    gl.bindTexture(gl.TEXTURE_2D, st.tNoise.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const ani = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ani) gl.texParameterf(gl.TEXTURE_2D, ani.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  }
  function drawTrails(ctx) {
    const gl = ctx.gl;
    st.trailCur = st.trailCur ? 0 : 1;
    ctx.bindTarget(st['tTrail' + st.trailCur]);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (st.graph) {
      for (const e of st.graph.edges) {
        const P = e.pts;
        for (let i = 1; i < P.length; i++) ctx.glowLine(P[i - 1].x, P[i - 1].y, P[i].x, P[i].y, 40, [1, 1, 1], 1, { core: 0, falloff: 2 });
      }
    }
    gl.blendEquation(gl.MAX);
    ctx.flush();
    gl.blendEquation(gl.FUNC_ADD);
    st.trailDirty = false;
  }
  const texBase = () => ({ uField: st.tField.tex, uHt: st.texHt, uNoise: st.tNoise.tex });
  function runField(ctx) {
    ctx.fullscreen(st.pField, {}, { uTrailA: st['tTrail' + (st.trailCur ? 0 : 1)].tex, uTrailB: st['tTrail' + st.trailCur].tex }, st.tField);
  }
  function runGeo(ctx, tgt) { ctx.fullscreen(st.pGeo, {}, texBase(), tgt); }
  function mipGeo(ctx, t) { const gl = ctx.gl; gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.generateMipmap(gl.TEXTURE_2D); }
  function runLit(ctx, geo, tgt, lo) {
    ctx.fullscreen(st.pLit, { uNS: lo ? 6 : ctx.P.quality >= 1 ? 11 : 8 },
      Object.assign(texBase(), { uGeo: geo.tex, uFern: st.tFern.tex, uFloor: st.texFloor, uMoss: st.texMoss, uDirt: st.texDirt }), tgt);
  }
  function runAux(ctx, geo) { ctx.fullscreen(st.pAux, {}, { uGeo: geo.tex }, st.tAux); }
  // Run fn with only the lower (half 0) or upper (half 1) band of target t writable
  function band(ctx, t, half, fn) {
    const gl = ctx.gl, hh = Math.ceil(t.h / 2);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, half ? hh : 0, t.w, half ? t.h - hh : hh);
    fn();
    gl.disable(gl.SCISSOR_TEST);
  }
  function updateCache(ctx) {
    if (!ctx.fieldStable) {
      // icons are moving: rebuild everything at half resolution every second frame
      if ((st.frame++ % 2) === 0 || !st.loValid) {
        runField(ctx); runGeo(ctx, st.tGeoLo); mipGeo(ctx, st.tGeoLo); runLit(ctx, st.tGeoLo, st.tLitLo, true); runAux(ctx, st.tGeoLo);
        st.loValid = true; st.show = 'lo';
      }
      st.needHi = true; st.hiStep = -1;
      return;
    }
    if (!st.needHi) return;
    if (!st.loValid || st.show !== 'lo') {
      runField(ctx); runGeo(ctx, st.tGeo); mipGeo(ctx, st.tGeo); runLit(ctx, st.tGeo, st.tLit, false); runAux(ctx, st.tGeo);
      st.needHi = false; st.show = 'hi'; st.hiStep = -1;
      return;
    }
    // after a morph: build the full-resolution cache over five frames while the half-resolution one stays on screen
    st.hiStep++;
    switch (st.hiStep) {
      case 0: runField(ctx); band(ctx, st.tGeo, 0, () => runGeo(ctx, st.tGeo)); break;
      case 1: band(ctx, st.tGeo, 1, () => runGeo(ctx, st.tGeo)); mipGeo(ctx, st.tGeo); break;
      case 2: band(ctx, st.tLit, 0, () => runLit(ctx, st.tGeo, st.tLit, false)); break;
      case 3: band(ctx, st.tLit, 1, () => runLit(ctx, st.tGeo, st.tLit, false)); break;
      default: runAux(ctx, st.tGeo); st.show = 'hi'; st.needHi = false; st.hiStep = -1; st.loValid = false;
    }
  }

  /* ---------------------------------------------------------------- night lights, fireflies */
  // Campfires in a few clearings, tree-village lights up in the canopy, firefly homes along the clearing edges.
  function placeLights(ctx) {
    const W = ctx.W, H = ctx.H, areaK = W * H / (1920 * 1080), cs = 40, cand = [];
    for (let gy = 0; gy * cs < H; gy++) for (let gx = 0; gx * cs < W; gx++) {
      const x = (gx + 0.2 + 0.6 * ctx.hash(gx, gy, 91)) * cs, y = (gy + 0.2 + 0.6 * ctx.hash(gx, gy, 92)) * cs;
      if (x < 40 || y < 40 || x > W - 40 || y > H - 40) continue;
      cand.push({ x, y, d: ctx.distAt(x, y), b: ctx.blobAt(x, y), k: ctx.hash(gx, gy, 93) });
    }
    const pick = (list, n, sep) => { const out = []; for (const c of list.sort((a, b) => a.k - b.k)) { if (out.length >= n) break; if (out.every(o => Math.hypot(o.x - c.x, o.y - c.y) > sep)) out.push(c); } return out; };
    let campC = cand.filter(c => c.d > 85 && c.b < -30);
    if (campC.length < 2) campC = cand.filter(c => c.d > 85 && c.b < 40);
    st.camps = pick(campC, Math.max(1, Math.round(3 * areaK)), 320).map(c => ({ x: c.x, y: c.y, ph: c.k * 50 }));
    const rv = seedRng('villages', ctx.seed);
    st.villages = pick(cand.filter(c => c.d > 190 && c.b > 140), Math.max(1, Math.round(3 * areaK)), 420).map(c => {
      const lights = [], n = 4 + ((rv() * 4) | 0);
      for (let i = 0; i < n; i++) { const a = rv() * TAU, r = 8 + rv() * 38; lights.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r, s: 0.7 + rv() * 0.6, ph: rv() * 40 }); }
      return { x: c.x, y: c.y, lights };
    });
    const homes = cand.filter(c => c.d > 34 && c.b < 70);
    const nf = Math.round(48 * areaK), rf = seedRng('flies', ctx.seed);
    st.flies = [];
    if (homes.length) for (let i = 0; i < nf; i++) {
      const h = homes[(rf() * homes.length) | 0];
      st.flies.push({ hx: h.x + (rf() - 0.5) * 36, hy: h.y + (rf() - 0.5) * 36, ph: rf() * 60, w: 0.5 + rf() * 0.9, fr: 0.25 + rf() * 0.5, ox: 0, oy: 0 });
    }
  }

  /* ---------------------------------------------------------------- point and fire */
  // A double-click calls strike(): the walker turns its head and fires, a nearby speeder swings toward the spot and
  // fires, or a starfighter strafes it from overhead. Every bolt is timed to land exactly at its scheduled impact.
  function strikeBolt(x0, y0, x1, y1, color, o) {
    const d = Math.max(1, Math.hypot(x1 - x0, y1 - y0)), sp = o.speed || 900;
    st.bolts.fire(x0, y0, Math.atan2(y1 - y0, x1 - x0), { speed: sp, len: o.len || 20, color, intensity: o.intensity || 5, width: o.width || 1.4, life: d / sp, hit: false });
    return d / sp;
  }
  function scheduleImpact(x, y, delay, size) { st.impacts.push({ x, y, t: delay, size }); }
  function impact(ctx, x, y, size) {
    const r = st.rng, k = clamp((ctx.distAt(x, y) - 6) / 60, 0.3, 1) * size, E = st.E || {};
    st.booms.push({ x, y, age: 0, life: 0.55 + 0.35 * k, s: k });
    const n = Math.round(4 + 14 * k);
    for (let i = 0; i < n; i++) {
      const a = r() * TAU, sp = (40 + r() * 170) * k;
      st.chunks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: 0.4 + r() * 0.8, rot: r() * TAU, vr: (r() - 0.5) * 16, size: 1.4 + r() * 2.4 * k });
    }
    const wsp = 8 + 40 * (E.wind == null ? 0.3 : E.wind), wx = Math.cos(st.windA || 0.6) * wsp, wy = Math.sin(st.windA || 0.6) * wsp;
    for (let i = 0; i < 4; i++) st.dust.push({ x: x + (r() - 0.5) * 8, y: y + (r() - 0.5) * 8, vx: (r() - 0.5) * 50 * k, vy: (r() - 0.5) * 50 * k, age: 0, life: 0.9 + r() * 0.7, s0: 5, s1: (18 + 16 * r()) * k + 6, a: 0.42, c: E.snow > 0.3 ? [0.75, 0.77, 0.8] : [0.22, 0.17, 0.12] });
    for (let i = 0; i < Math.round(3 + 5 * k); i++) st.smoke.push({ x: x + (r() - 0.5) * 24 * k, y: y + (r() - 0.5) * 24 * k, vx: wx + (r() - 0.5) * 16, vy: wy + (r() - 0.5) * 16, age: -i * 0.1, life: 2.4 + r() * 1.8, s0: 8 * k, s1: (38 + 30 * r()) * k + 8, a: 0.5, c: [0.24, 0.23, 0.21] });
    st.scorch.push({ x, y, age: 0, life: 9 + r() * 3, s: (16 + 10 * r()) * k + 6, rot: r() * TAU });
    if (st.scorch.length > 24) st.scorch.shift();
    // the blast startles birds and nearby speeders
    for (const b of st.birds) { const d = Math.hypot(b.x - x, b.y - y); if (d < 320) { b.scare = Math.max(b.scare || 0, 1 - d / 320); b.fx = x; b.fy = y; } }
    for (const b of st.bikes) { const d = Math.hypot(b.x - x, b.y - y); if (d < 170) b.startle = Math.max(b.startle || 0, 1 - d / 170); }
  }
  function strike(ctx, x, y) {
    const r = st.rng, w = st.walker;
    if (st.impacts.length > 18) return;
    const opts = [];
    if (w && w.alpha > 0.8 && !(w.aim && w.aim.strike) && Math.hypot(w.x - x, w.y - y) < 760) opts.push('w', 'w');
    let bike = null, bd = 480;
    for (const b of st.bikes) {
      if (b.strike || b.out || b.alpha < 0.8 || b.temp) continue;
      const dx = x - b.x, dy = y - b.y, d = Math.hypot(dx, dy);
      if (d < 50 || d > bd || (dx * Math.cos(b.ang) + dy * Math.sin(b.ang)) / d < 0.15) continue;
      bd = d; bike = b;
    }
    if (bike) opts.push('b', 'b');
    opts.push('f');
    const kind = opts[(r() * opts.length) | 0];
    if (kind === 'w') { w.aim = { x, y, strike: true }; w.burst = 3; w.shotT = 0.1; w.look = false; return; }
    if (kind === 'b') { bike.strike = { x, y, n: 3, t: 0.18, k: 0 }; return; }
    // starfighter strafing run along a random heading, impacts walking across the spot
    const ang = r() * TAU, cx = Math.cos(ang), cy = Math.sin(ang), W = ctx.W, H = ctx.H;
    let D = 200;
    while (D < 4000) { const px = x - cx * D, py = y - cy * D; if (px < -90 || py < -90 || px > W + 90 || py > H + 90) break; D += 40; }
    const pts = [];
    for (const o of [-34, 0, 34]) { const px = x + cx * o, py = y + cy * o; if (o === 0 || ctx.distAt(px, py) > 26) pts.push({ x: px, y: py, big: o === 0 }); }
    st.fighters.push({ x: x - cx * D, y: y - cy * D, ang, spd: 680, tx: x, ty: y, pts, shot: 0, shotT: 0, age: 0 });
  }
  function updateStrikes(ctx, dt) {
    for (const im of st.impacts) { im.t -= dt; if (im.t <= 0) { im.done = true; impact(ctx, im.x, im.y, im.size); } }
    st.impacts = st.impacts.filter(im => !im.done);
    const W = ctx.W, H = ctx.H;
    for (const f of st.fighters) {
      f.age += dt;
      const cx = Math.cos(f.ang), cy = Math.sin(f.ang);
      f.x += cx * f.spd * dt; f.y += cy * f.spd * dt;
      const along = (f.tx - f.x) * cx + (f.ty - f.y) * cy;
      f.shotT -= dt;
      if (along < 420 && along > 120 && f.shot < f.pts.length * 2 && f.shotT <= 0) {
        const pt = f.pts[Math.min(f.pts.length - 1, f.shot >> 1)], s = f.shot % 2 ? 1 : -1;
        const gx = f.x + cx * 26 - cy * 11 * s, gy = f.y + cy * 26 + cx * 11 * s;
        const tt = strikeBolt(gx, gy, pt.x + (Math.random() - 0.5) * 4, pt.y + (Math.random() - 0.5) * 4, GREEN, { speed: 1250, len: 26, intensity: 5.5, width: 1.5 });
        if (f.shot % 2) scheduleImpact(pt.x, pt.y, tt, pt.big ? 1 : 0.55);
        f.shot++; f.shotT = 0.075;
      }
      if (f.age > 1 && (f.x < -260 || f.y < -260 || f.x > W + 260 || f.y > H + 260)) f.dead = true;
    }
    st.fighters = st.fighters.filter(f => !f.dead);
    for (const b of st.bikes) {
      const s = b.strike; if (!s) continue;
      s.t -= dt; s.k = Math.min(1, s.k + dt * 5);
      if (s.n > 0 && s.t <= 0) {
        const ca = Math.cos(b.ang), sa = Math.sin(b.ang);
        const tt = strikeBolt(b.x + ca * 20, b.y + sa * 20, s.x + (Math.random() - 0.5) * 8, s.y + (Math.random() - 0.5) * 8, b.kind === 'i' ? RED : GREEN, { speed: 950, len: 18, intensity: 4.8, width: 1.3 });
        scheduleImpact(s.x, s.y, tt, s.n === 3 ? 1 : 0.5);
        s.n--; s.t = 0.15;
      }
      if (s.n <= 0 && s.t < -0.35) { s.k -= dt * 6; if (s.k <= 0) b.strike = null; }
    }
  }

  /* ---------------------------------------------------------------- weather particles */
  function updateWeather(ctx, dt, E) {
    const r = Math.random, W = ctx.W, H = ctx.H, areaK = Math.pow(W * H / (1920 * 1080), 0.75), q = ctx.P.quality >= 1 ? 1 : 0.6, t = ctx.t;
    const wa = st.windA, wcx = Math.cos(wa), wcy = Math.sin(wa), ws = 30 + E.wind * 240;
    // rain streaks: drops falling toward the viewer, drifting with the wind and spreading out from the center
    const nRain = E.rain * 520 * areaK * q * (1 + 0.5 * E.storm);
    st.rainAcc += nRain / 0.32 * dt;
    while (st.rainAcc >= 1) {
      st.rainAcc--;
      const x = r() * (W + 120) - 60, y = r() * (H + 120) - 60;
      st.rain.push({ x, y, vx: wcx * ws + (x - W / 2) * 0.5, vy: wcy * ws + (y - H / 2) * 0.5, age: 0, life: 0.22 + r() * 0.18, len: 10 + r() * 16, z: r() });
    }
    for (const d of st.rain) { d.age += dt; d.x += d.vx * dt; d.y += d.vy * dt; }
    st.rain = st.rain.filter(d => d.age < d.life);
    // splashes on the ground and leaves
    st.splAcc += E.rain * 120 * areaK * q * dt / 0.3;
    while (st.splAcc >= 1) {
      st.splAcc--;
      const x = r() * W, y = r() * H;
      if (ctx.distAt(x, y) > 10) st.splash.push({ x, y, age: 0, life: 0.22 + r() * 0.15, s: 4 + r() * 6 });
    }
    for (const s of st.splash) s.age += dt;
    st.splash = st.splash.filter(s => s.age < s.life);
    // snowflakes: drift with the wind, sway, fade in and out
    const nSnow = E.snow * 560 * areaK * q;
    st.snowAcc += nSnow / 3.4 * dt;
    while (st.snowAcc >= 1) {
      st.snowAcc--;
      const z = r();
      st.flakes.push({ x: r() * (W + 200) - 100, y: r() * (H + 200) - 100, z, age: 0, life: 2.4 + r() * 2, ph: r() * TAU, s: 1.6 + z * z * 4.2 });
    }
    const sw = 14 + E.wind * 150;
    for (const f of st.flakes) {
      f.age += dt;
      const k = 0.5 + f.z;
      f.x += (wcx * sw + Math.sin(t * 1.3 + f.ph) * 9) * k * dt; f.y += (wcy * sw + Math.cos(t * 1.1 + f.ph) * 7) * k * dt;
    }
    st.flakes = st.flakes.filter(f => f.age < f.life);
    // wind-blown leaves
    const nLeaf = (Math.max(0, E.wind - 0.42) * 70 + E.storm * 18) * areaK * q * (1 - 0.8 * E.snow);
    st.leafAcc += nLeaf / 3 * dt;
    while (st.leafAcc >= 1) {
      st.leafAcc--;
      st.leaves.push({ x: r() * W, y: r() * H, age: 0, life: 2.5 + r() * 2, rot: r() * TAU, vr: (r() - 0.5) * 9, sp: (0.6 + r() * 0.8) * (60 + E.wind * 300), ph: r() * TAU, c: r() < 0.6 ? [0.2, 0.3, 0.07] : [0.45, 0.28, 0.08] });
    }
    for (const l of st.leaves) {
      l.age += dt; l.rot += l.vr * dt;
      const wob = Math.sin(t * 2.3 + l.ph) * 30;
      l.x += (wcx * l.sp - wcy * wob) * dt; l.y += (wcy * l.sp + wcx * wob) * dt;
    }
    st.leaves = st.leaves.filter(l => l.age < l.life && l.x > -80 && l.y > -80 && l.x < W + 80 && l.y < H + 80);
    // fireflies drift around their homes and scatter from the cursor
    const ptr = ctx.pointer;
    for (const f of st.flies) {
      if (ptr.active) { const dx = f.hx + f.ox - ptr.x, dy = f.hy + f.oy - ptr.y, d = Math.hypot(dx, dy); if (d < 110 && d > 0.1) { const k = (1 - d / 110) * 160 * dt; f.ox += dx / d * k; f.oy += dy / d * k; } }
      f.ox *= Math.exp(-dt * 0.35); f.oy *= Math.exp(-dt * 0.35);
    }
  }

  /* ---------------------------------------------------------------- time of day and weather */
  // Light keys by sun elevation (degrees): [elevation, sun rgb, sky rgb]. 36.8 degrees is the designed afternoon (15:30).
  const SUN0 = [2.8, 2.212, 1.456], SKY0 = [0.135, 0.18, 0.234];
  const MIST0 = [0.74, 0.71, 0.60], HAZE0 = [0.5, 0.42, 0.28], FOG0 = [0.36, 0.38, 0.39];
  const sc3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const KEYS_PM = [
    [-90, sc3([0.34, 0.44, 0.7], 1.05), sc3([0.03, 0.045, 0.085], 0.5)],
    [-13, sc3([0.34, 0.44, 0.7], 1.05), sc3([0.03, 0.045, 0.085], 0.5)],
    [-7, sc3([0.3, 0.36, 0.55], 0.45), sc3([0.07, 0.09, 0.19], 0.45)],
    [-2, sc3([0.9, 0.45, 0.3], 0.4), sc3([0.14, 0.18, 0.34], 0.45)],
    [4, sc3([1, 0.58, 0.3], 2.6), sc3([0.26, 0.33, 0.48], 0.4)],
    [15, sc3([1, 0.72, 0.44], 2.9), sc3([0.28, 0.36, 0.48], 0.42)],
    [36.8, SUN0, SKY0],
    [52, sc3([1, 0.86, 0.66], 3.0), sc3([0.31, 0.41, 0.54], 0.5)],
    [90, sc3([1, 0.86, 0.66], 3.0), sc3([0.31, 0.41, 0.54], 0.5)]];
  const KEYS_AM = KEYS_PM.map((k, i) => i === 3 ? [-2, sc3([0.85, 0.5, 0.55], 0.4), sc3([0.17, 0.2, 0.36], 0.45)]
    : i === 4 ? [4, sc3([1, 0.66, 0.44], 2.6), sc3([0.27, 0.37, 0.56], 0.42)]
    : i === 5 ? [15, sc3([1, 0.76, 0.52], 2.9), sc3([0.29, 0.38, 0.52], 0.42)] : k);
  const luma3 = c => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  const mix3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  function keyLight(keys, el) {
    for (let i = 1; i < keys.length; i++) if (el <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i], k = sstep(0, 1, (el - a[0]) / (b[0] - a[0]));
      return [mix3(a[1], b[1], k), mix3(a[2], b[2], k)];
    }
    return [keys[keys.length - 1][1], keys[keys.length - 1][2]];
  }
  // Everything the shaders, sprites and post need from ctx.env, computed once per frame
  function computeEnv(ctx) {
    const e = ctx.env, ta = !!e.timeActive;
    let sun = SUN0, sky = SKY0;
    if (ta) {
      // blend the morning and evening palettes around noon and midnight so nothing pops
      const am = sstep(0.5, 1, Math.cos((e.hour - 6) / 24 * TAU) * 0.5 + 0.5);
      const A = keyLight(KEYS_AM, e.sunElev), B = keyLight(KEYS_PM, e.sunElev);
      sun = mix3(B[0], A[0], am); sky = mix3(B[1], A[1], am);
    }
    const cloud = e.cloud || 0, rain = e.rain || 0, storm = e.storm || 0, fog = e.fog || 0, snow = e.snow || 0;
    const oc = clamp(Math.max(cloud * 0.85, rain, storm, fog * 0.8, snow * 0.9), 0, 1);
    const day = ta ? e.daylight : 1, night = ta ? e.night : 0, dusk = ta ? e.dusk : 0;
    sun = sc3(sun, (1 - oc * (0.8 * day + 0.5 * (1 - day))) * (1 - 0.35 * storm));
    const gy = luma3(sky);
    sky = sc3(mix3(sky, [gy * 0.95, gy, gy * 1.07], 0.7 * oc), (1 + 1.4 * oc * day + 0.8 * oc * (1 - day)) * (1 - 0.4 * storm));
    const sunK = Math.min(1, luma3(sun) / luma3(SUN0));
    const amb = i => (sun[i] * 0.6 + sky[i] * 0.5) / (SUN0[i] * 0.6 + SKY0[i] * 0.5);
    const ambF = i => (sun[i] * 0.25 + sky[i]) / (SUN0[i] * 0.25 + SKY0[i]);
    const morning = ta && e.hour < 12 ? 1 : 0;
    const E = st.E || (st.E = {});
    E.sun = sun; E.sky = sky; E.sunK = sunK; E.oc = oc; E.day = day; E.night = night; E.dusk = dusk;
    E.rain = rain; E.snow = snow; E.fog = fog; E.storm = storm; E.cloud = cloud; E.lightning = e.lightning || 0;
    E.wind = e.wind == null ? 0.3 : e.wind;
    // airborne mist, haze and fog take the light's brightness but only a little of its hue, so a low sun leaves them pale
    const lit = (base, f, k) => { const r = [f(0), f(1), f(2)], L = luma3(r) || 1e-4; return [0, 1, 2].map(i => base[i] * L * (1 + (r[i] / L - 1) * k)); };
    E.mistC = lit(MIST0, amb, 0.35);
    E.hazeC = lit(HAZE0, amb, 0.35);
    E.fogC = lit(FOG0, ambF, 0.25);
    E.hollow = 0.16 * dusk * morning * (1 - rain);
    E.fogC = mix3(E.fogC, lit([1.15, 1.08, 1.0], amb, 0.3), E.hollow / (E.hollow + fog + 1e-3));
    // artificial lights come on at dusk, and a little under a dark storm sky
    E.lights = clamp(sstep(0.8, 0.2, day) + storm * 0.35 * day, 0, 1);
    // relative brightness of ambient-lit things (rain streaks, flakes, smoke)
    E.ambK = luma3([sun[0] * 0.3 + sky[0], sun[1] * 0.3 + sky[1], sun[2] * 0.3 + sky[2]]) / luma3([SUN0[0] * 0.3 + SKY0[0], SUN0[1] * 0.3 + SKY0[1], SUN0[2] * 0.3 + SKY0[2]]);
    E.wet = clamp(Math.max(rain, storm) * 1.15, 0, 1);
    return E;
  }
  const POST0 = { bloom: 0.5, threshold: 1.15, knee: 0.6, exposure: 1.1, vignette: 0.38, grain: 0.018, aberration: 0.0006, tint: [1.05, 1.0, 0.9], lift: [0.003, 0.003, 0.002], saturation: 1.08, bloomRadius: 1.1 };
  function postFor() {
    const p = Object.assign({}, POST0, { tint: POST0.tint.slice(), lift: POST0.lift.slice() });
    const E = st && st.E; if (!E) return p;
    const n = E.night, d = E.dusk;
    const warm = d * (1 - n);
    p.exposure = POST0.exposure * (1 + 0.12 * warm + 0.3 * n + 0.3 * E.oc * E.day - 0.14 * E.snow * E.day);
    p.tint = mix3(mix3(POST0.tint, [1.02, 1.0, 0.98], warm), [0.9, 0.97, 1.12], n);
    p.saturation = POST0.saturation * (1 + 0.08 * warm) * (1 - 0.28 * n) * (1 - 0.18 * E.oc) * (1 - 0.1 * E.fog) * (1 - 0.2 * E.snow);
    p.lift = [POST0.lift[0] + 0.004 * n + 0.006 * E.fog, POST0.lift[1] + 0.006 * n + 0.0065 * E.fog, POST0.lift[2] + 0.012 * n + 0.0075 * E.fog];
    p.bloom = POST0.bloom + 0.2 * E.lights;
    p.threshold = POST0.threshold - 0.25 * E.lights;
    return p;
  }

  /* ---------------------------------------------------------------- scene */
  Galaxy.register(ID, {
    name: 'Forest moon',
    defaultHour: 15.5,
    post: () => postFor(),

    init(ctx) {
      st = { rng: ctx.rng(77), bikes: [], dust: [], smoke: [], chunks: [], booms: [], birds: [], walker: null, chase: null, ferns: [],
        chaseT: 3, birdT: 2.5, spawnT: 0, frame: 0, graph: null, trailDirty: true, fernDirty: true, needHi: true, loValid: false, hiStep: -1, show: null, trailCur: 0,
        rain: [], splash: [], flakes: [], leaves: [], scorch: [], impacts: [], fighters: [], flies: [], camps: [], villages: [],
        rainAcc: 0, splAcc: 0, snowAcc: 0, leafAcc: 0, swayT: 0, cloudOff: [0, 0], mistOff: [0, 0], windA: null, E: null };
      st.pNoise = ctx.program(NOISE_FS);
      st.pField = ctx.program(FIELD_FS);
      st.pGeo = ctx.program(GEO_FS);
      st.pLit = ctx.program(LIT_FS);
      st.pAux = ctx.program(AUX_FS);
      st.pView = ctx.program(VIEW_FS);
      st.texHt = ctx.loadTexture(ASSET + 'heights.jpg', { srgb: false });
      st.texFloor = ctx.loadTexture(ASSET + 'floor_col.jpg');
      st.texMoss = ctx.loadTexture(ASSET + 'moss_col.jpg');
      st.texDirt = ctx.loadTexture(ASSET + 'dirt_col.jpg');
      defineSprites(ctx.atlas);
      st.bolts = new ctx.Bolts();
      computeEnv(ctx);
    },

    resize(ctx) {
      if (st.size !== ctx.pxW + 'x' + ctx.pxH || !st.tLit) allocTargets(ctx);
      st.needHi = true; st.loValid = false; st.fernDirty = true;
    },

    layout(ctx) {
      const old = st.graph, G = buildGraph(ctx);
      st.graph = G;
      st.trailDirty = true; st.needHi = true; st.loValid = false; st.hiStep = -1;
      placeFerns(ctx);
      placeLights(ctx);
      if (!old) {
        st.bikes = []; st.chase = null; st.walker = null;
        const n = Math.round(ctx.P.traffic * 9 * Math.sqrt(ctx.W * ctx.H / (1920 * 1080)));
        for (let i = 0; i < n; i++) { const b = spawnBike(ctx, false); if (b) { b.alpha = 1; b.fadeIn = false; st.bikes.push(b); } }
        return;
      }
      // keep the vehicles: move them onto the new trails and blend the position difference away
      for (const b of st.bikes) {
        if (b.follow) continue;
        if (!remapMover(b.m, b.x, b.y, G)) { b.out = true; b.m.e = G.edges[0] || b.m.e; continue; }
        edgePos(b.m.e, b.m.u, tmp);
        b.ox = b.x - tmp.x; b.oy = b.y - tmp.y;
      }
      const w = st.walker;
      if (w) {
        if (remapMover(w.m, w.x, w.y, G) && !w.m.e.a.exit && !w.m.e.b.exit) { edgePos(w.m.e, w.m.u, tmp); w.ox = w.x - tmp.x; w.oy = w.y - tmp.y; }
        else st.walker = null;
      }
      if (!G.edges.length) { st.bikes = []; st.walker = null; st.chase = null; }
    },

    fire(ctx, x, y) { if (st && st.graph) strike(ctx, x, y); },

    update(ctx) {
      const dt = ctx.dt, t = ctx.t, r = st.rng, P = ctx.P, W = ctx.W, H = ctx.H, env = ctx.env, ptr = ctx.pointer;
      const E = computeEnv(ctx); E.hour = env.hour;
      // wind: the designed slow wander, or the live wind direction when weather is on
      const designedA = 0.55 + 0.35 * Math.sin(t * 0.021) + 0.15 * Math.sin(t * 0.077);
      if (env.weatherActive) st.windA = st.windA == null ? env.windDir : angLerp(st.windA, env.windDir, Math.min(1, dt * 0.25));
      else st.windA = designedA;
      st.wind = st.windA;
      const wk = E.wind - 0.3;
      E.sway = Math.max(0.35, 1 + wk * 2.1) * (1 + E.storm * 0.35 * Math.max(0, Math.sin(t * 0.9) + Math.sin(t * 2.3) * 0.5));
      st.swayT += dt * (1 + Math.max(0, wk) * 1.3);
      if (env.weatherActive) {
        const cs = 0.0047 * (0.5 + E.wind * 1.7), ms = 0.0065 * (0.4 + E.wind * 2);
        st.cloudOff[0] += Math.cos(st.windA) * cs * dt; st.cloudOff[1] += Math.sin(st.windA) * cs * dt;
        st.mistOff[0] += Math.cos(st.windA) * ms * dt; st.mistOff[1] += Math.sin(st.windA) * ms * dt;
      } else {
        st.cloudOff[0] += 0.0042 * dt; st.cloudOff[1] += 0.0021 * dt;
        st.mistOff[0] += 0.006 * dt; st.mistOff[1] += 0.0024 * dt;
      }
      updateWeather(ctx, dt, E);
      if (!st.graph) return;
      const ok = Math.exp(-dt * 2.2);
      // traffic
      const want = Math.round(P.traffic * 9 * Math.sqrt(W * H / (1920 * 1080)));
      const normal = st.bikes.filter(b => !b.temp && !b.out);
      st.spawnT -= dt;
      if (normal.length < want && st.spawnT <= 0) { const b = spawnBike(ctx, r() < 0.65); if (b) st.bikes.push(b); st.spawnT = 0.5 + r() * 1.2; }
      if (normal.length > want) { const b = normal.find(x => x !== (st.chase && st.chase.prey) && !x.strike); if (b) b.out = true; }
      for (const b of st.bikes) {
        const pa = b.ang;
        // cursor: speeders swerve away from the pointer and open the throttle
        let push = 0;
        if (ptr.active) {
          const dx = b.x - ptr.x, dy = b.y - ptr.y, d = Math.hypot(dx, dy);
          if (d < 190) { push = 1 - d / 190; const side = Math.sign(-Math.sin(b.ang) * dx + Math.cos(b.ang) * dy) || 1; b.latT = side * 22 * Math.sqrt(push); }
        }
        b.startle = Math.max((b.startle || 0) * Math.exp(-dt * 0.9), push);
        b.latT = (b.latT || 0) * Math.exp(-dt * 1.2);
        b.lat = (b.lat || 0) + (b.latT - (b.lat || 0)) * Math.min(1, dt * 6);
        const thr = 1 + 0.9 * b.startle;
        if (b.follow) {
          if (b.follow.dead) b.out = true;
          histAt(b.follow, t - b.delay, tmp);
          const nx = tmp.x - Math.sin(tmp.ang) * b.wob * Math.sin(t * 1.3 + b.ph), ny = tmp.y + Math.cos(tmp.ang) * b.wob * Math.sin(t * 1.3 + b.ph);
          if (dt > 0) b.ang = angLerp(b.ang, Math.atan2(ny - b.y, nx - b.x), Math.min(1, dt * 10));
          b.x = nx; b.y = ny; b.spd = b.follow.spd * b.follow.boost;
          b.alpha = b.out ? Math.max(0, b.alpha - dt * 1.5) : Math.min(1, b.alpha + dt * 2);
          if (b.out && b.alpha <= 0) b.dead = true;
        } else {
          b.m.age += dt;
          stepMover(b.m, b.spd * b.boost * thr * dt, r, true);
          if (b.m.exited) { b.dead = true; continue; }
          edgePos(b.m.e, b.m.u, tmp);
          const ta = tmp.ang + (b.m.dir < 0 ? Math.PI : 0);
          b.m.ang = angLerp(b.m.ang, ta, Math.min(1, dt * 12));
          const wob = Math.sin(b.m.age * 2.1 + b.ph) * 2.2 + b.lat;
          b.ox *= ok; b.oy *= ok;
          b.x = tmp.x - Math.sin(b.m.ang) * wob + b.ox; b.y = tmp.y + Math.cos(b.m.ang) * wob + b.oy; b.ang = b.m.ang;
          if (b.fadeIn) { b.alpha = Math.min(1, b.alpha + dt * 1.5); if (b.alpha >= 1) b.fadeIn = false; }
          if (b.out) { b.alpha -= dt * 1.2; if (b.alpha <= 0) b.dead = true; }
          b.hist.push({ t, x: b.x, y: b.y, ang: b.ang });
          while (b.hist.length > 2 && b.hist[0].t < t - 2.5) b.hist.shift();
        }
        // bank into turns (drawn as a slight squash and a sideways shadow shift)
        if (dt > 0) { let da = b.ang - pa; da = Math.atan2(Math.sin(da), Math.cos(da)); b.bank += (clamp(da / dt * 0.25, -0.6, 0.6) - b.bank) * Math.min(1, dt * 6); }
        // dust wake (snow spray on snow, little on wet ground)
        b.puffT -= dt;
        if (b.puffT <= 0 && b.alpha > 0.2 && dt > 0) {
          b.puffT = 0.03;
          const bx = b.x - Math.cos(b.ang) * 16, by = b.y - Math.sin(b.ang) * 16;
          const dc = mix3([0.36, 0.28, 0.19], [0.8, 0.83, 0.88], clamp(E.snow * 1.5, 0, 1));
          st.dust.push({ x: bx + (r() - 0.5) * 5, y: by + (r() - 0.5) * 5, vx: -Math.cos(b.ang) * 28 + (r() - 0.5) * 20, vy: -Math.sin(b.ang) * 28 + (r() - 0.5) * 20, age: 0, life: 0.8 + r() * 0.6, s0: 4, s1: 15 + r() * 8, a: 0.15 * b.alpha * (1 - 0.75 * E.wet) * thr, c: dc });
        }
      }
      // skirmish: speeder chases
      if (st.chase) {
        const c = st.chase; c.t += dt;
        if (c.prey.dead || c.prey.out || c.t > c.dur || P.skirmish <= 0) endChase();
        else {
          for (const h of c.hunters) {
            if (h.dead || h.out || h.alpha < 0.6) continue;
            h.fireT -= dt;
            if (h.fireT <= 0) {
              const dx = c.prey.x - h.x, dy = c.prey.y - h.y, d = Math.hypot(dx, dy);
              const a = Math.atan2(dy, dx) + (r() - 0.5) * 0.16;
              fire(h.x + Math.cos(h.ang) * 18, h.y + Math.sin(h.ang) * 18, a, d, h.kind === 'i' ? RED : GREEN);
              h.fireT = 0.16 + r() * (0.25 + 0.6 * (1 - P.skirmish));
              if (r() < 0.3) h.fireT = 0.07;
            }
          }
          c.prey.fireT -= dt;
          if (c.prey.fireT <= 0) {
            const h = c.hunters.find(x => !x.dead && x.alpha > 0.6);
            if (h) {
              const dx = h.x - c.prey.x, dy = h.y - c.prey.y, d = Math.hypot(dx, dy);
              fire(c.prey.x, c.prey.y, Math.atan2(dy, dx) + (r() - 0.5) * 0.2, d, c.prey.kind === 'i' ? RED : GREEN);
            }
            c.prey.fireT = 0.7 + r() * 1.6;
          }
        }
      } else if (P.skirmish > 0 && P.traffic > 0) {
        st.chaseT -= dt;
        if (st.chaseT <= 0) { startChase(ctx); st.chaseT = (4 + 22 * (1 - P.skirmish)) * (0.6 + r() * 0.8); }
      }
      st.bikes = st.bikes.filter(b => !b.dead);
      // walker
      if (P.traffic > 0.3) { if (!st.walker) st.walker = spawnWalker(ctx); }
      else if (st.walker && !(st.walker.aim && st.walker.aim.strike)) st.walker.out = true;
      const w = st.walker;
      if (w) {
        w.alpha = w.out ? w.alpha - dt * 0.8 : Math.min(1, w.alpha + dt * 0.7);
        if (w.alpha <= 0 && w.out) st.walker = null;
        else {
          // cursor: the walker stops and turns its head to watch the pointer
          const pd = ptr.active ? Math.hypot(ptr.x - w.x, ptr.y - w.y) : 1e9;
          w.look = !w.aim && pd < 420;
          const moving = !w.aim && !w.look;
          w.spdK = (w.spdK == null ? 1 : w.spdK) + ((moving ? 1 : 0) - (w.spdK == null ? 1 : w.spdK)) * Math.min(1, dt * 2.5);
          const dist = 16 * dt * w.spdK;
          w.m.age += dt;
          stepMover(w.m, dist, r, false);
          w.phase += dist / 40 * TAU;
          if (w.spdK < 0.5) w.phase += (Math.round(w.phase / Math.PI) * Math.PI - w.phase) * Math.min(1, dt * 3);
          edgePos(w.m.e, w.m.u, tmp);
          w.m.ang = angLerp(w.m.ang, tmp.ang + (w.m.dir < 0 ? Math.PI : 0), Math.min(1, dt * 1.5));
          w.ox *= ok; w.oy *= ok;
          w.x = tmp.x + w.ox; w.y = tmp.y + w.oy; w.ang = w.m.ang;
          w.fireT -= dt;
          if (!w.aim && w.fireT <= 0 && P.skirmish > 0) {
            let best = null, bd = 440;
            for (const b of st.bikes) { const d = Math.hypot(b.x - w.x, b.y - w.y); if (d < bd && b.alpha > 0.5) { bd = d; best = b; } }
            w.aim = best ? { b: best, x: best.x, y: best.y } : { x: w.x + Math.cos(w.ang + (r() - 0.5) * 2) * 260, y: w.y + Math.sin(w.ang + (r() - 0.5) * 2) * 260 };
            w.burst = 2 + ((r() * 3) | 0); w.shotT = 0.9;
          }
          let wantA = w.ang, turn = 2.2;
          if (w.look) { wantA = Math.atan2(ptr.y - w.y, ptr.x - w.x); turn = 1.6; }
          if (w.aim) {
            if (w.aim.b && !w.aim.b.dead) { w.aim.x = w.aim.b.x; w.aim.y = w.aim.b.y; }
            wantA = Math.atan2(w.aim.y - w.y, w.aim.x - w.x);
            if (w.aim.strike) turn = 3.2;
            w.shotT -= dt;
            let dd = wantA - w.headAng; dd = Math.atan2(Math.sin(dd), Math.cos(dd));
            if (w.shotT <= 0 && Math.abs(dd) < (w.aim.strike ? 0.06 : 0.15)) {
              const ca = Math.cos(w.headAng), sa = Math.sin(w.headAng), d = Math.hypot(w.aim.x - w.x, w.aim.y - w.y);
              if (w.aim.strike) {
                const ox = (r() - 0.5) * 10, oy = (r() - 0.5) * 10, k = w.burst === 3 ? 0 : 1;
                let tt = 0;
                for (const s of [-1, 1]) tt = strikeBolt(w.x + ca * 19 - sa * 2.6 * s, w.y + sa * 19 + ca * 2.6 * s, w.aim.x + ox * k, w.aim.y + oy * k, [1, 0.22, 0.06], { speed: 700, len: 22, intensity: 5.5, width: 1.6 });
                scheduleImpact(w.aim.x + ox * k, w.aim.y + oy * k, tt, w.burst === 3 ? 1 : 0.6);
              } else {
                for (const s of [-1, 1]) fire(w.x + ca * 19 - sa * 2.6 * s, w.y + sa * 19 + ca * 2.6 * s, w.headAng + (r() - 0.5) * 0.08, d, [1, 0.22, 0.06], { speed: 640, len: 22, intensity: 5, width: 1.5 });
              }
              w.burst--; w.shotT = w.aim.strike ? 0.28 : 0.35;
              if (w.burst <= 0) { w.fireT = (3 + r() * 5) * (1.6 - P.skirmish); w.aim = null; }
            }
          }
          w.headAng = angLerp(w.headAng, wantA, Math.min(1, dt * turn));
        }
      }
      // point-and-fire events, bolts and impacts
      updateStrikes(ctx, dt);
      st.bolts.update(dt);
      for (const s of st.bolts.sparks) if (!s.seen) { s.seen = true; debris(s.x, s.y, false); }
      // particles
      const stepP = arr => { for (const p of arr) { p.age += dt; if (p.age > 0) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - Math.min(1, dt * 2); p.vy *= 1 - Math.min(1, dt * 2); } } return arr.filter(p => p.age < p.life); };
      st.dust = stepP(st.dust); if (st.dust.length > 900) st.dust.splice(0, st.dust.length - 900);
      st.smoke = stepP(st.smoke);
      for (const c of st.chunks) { c.age += dt; c.x += c.vx * dt; c.y += c.vy * dt; c.vx *= 1 - Math.min(1, dt * 3); c.vy *= 1 - Math.min(1, dt * 3); c.rot += c.vr * dt; }
      st.chunks = st.chunks.filter(c => c.age < c.life);
      for (const b of st.booms) b.age += dt;
      st.booms = st.booms.filter(b => b.age < b.life);
      for (const s of st.scorch) s.age += dt;
      st.scorch = st.scorch.filter(s => s.age < s.life);
      // birds
      st.birdT -= dt;
      if (st.birdT <= 0 && !st.birds.length) {
        const side = (r() * 4) | 0, pad = 60;
        const sx = side === 0 ? -pad : side === 1 ? W + pad : r() * W, sy = side === 2 ? -pad : side === 3 ? H + pad : r() * H;
        const ang = Math.atan2(H * (0.25 + r() * 0.5) - sy, W * (0.25 + r() * 0.5) - sx);
        const n = 3 + ((r() * 5) | 0);
        for (let i = 0; i < n; i++) {
          const back = i * 18 + r() * 10, side2 = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 15 + (r() - 0.5) * 8;
          st.birds.push({ x: sx - Math.cos(ang) * back - Math.sin(ang) * side2, y: sy - Math.sin(ang) * back + Math.cos(ang) * side2, ang, spd: 78 + r() * 8, ph: r() * TAU, gl: r() * TAU });
        }
        st.birdT = 12 + r() * 22;
      }
      for (const b of st.birds) {
        b.ang += Math.sin(t * 0.4 + b.gl) * 0.08 * dt;
        // cursor and blasts: the flock scatters, each bird turning away and beating its wings hard
        let fx = null, fy = null, push = 0;
        if (ptr.active) { const d = Math.hypot(b.x - ptr.x, b.y - ptr.y); if (d < 220) { push = 1 - d / 220; fx = ptr.x; fy = ptr.y; } }
        if ((b.scare || 0) > push && b.fx != null) { push = b.scare; fx = b.fx; fy = b.fy; }
        if (push > 0.02 && fx != null) {
          const away = Math.atan2(b.y - fy, b.x - fx) + Math.sin(b.ph * 7.3) * 0.5;
          b.ang = angLerp(b.ang, away, Math.min(1, dt * 5 * push));
          b.flee = Math.max(b.flee || 0, push);
        }
        b.scare = Math.max(0, (b.scare || 0) - dt * 0.6);
        b.flee = Math.max(0, (b.flee || 0) - dt * 0.4);
        const sp = b.spd * (1 + 1.4 * b.flee);
        b.x += Math.cos(b.ang) * sp * dt; b.y += Math.sin(b.ang) * sp * dt;
      }
      st.birds = st.birds.filter(b => b.x > -200 && b.y > -200 && b.x < W + 200 && b.y < H + 200);
    },

    render(ctx) {
      const gl = ctx.gl, t = ctx.t, intro = ctx.intro;
      if (!st.tLit || st.size !== ctx.pxW + 'x' + ctx.pxH) allocTargets(ctx);
      ensureNoise(ctx);
      if (st.trailDirty) drawTrails(ctx);
      if (st.fernDirty) drawFerns(ctx);
      updateCache(ctx);
      const E = st.E || computeEnv(ctx);
      if (E.sway == null) E.sway = 1;
      const lo = st.show === 'lo', lit = lo ? st.tLitLo : st.tLit, geo = lo ? st.tGeoLo : st.tGeo;
      const wa = st.wind || 0.6, wind = [Math.cos(wa), Math.sin(wa)];
      const vt = { uLit: lit.tex, uField: st.tField.tex, uAux: st.tAux.tex, uNoise: st.tNoise.tex, uGeo: geo.tex };
      const vu = { uWind: wind, uSwayT: st.swayT, uCloudOff: st.cloudOff, uMistOff: st.mistOff, uSunC: E.sun, uSkyC: E.sky, uMistC: E.mistC, uHazeC: E.hazeC, uFogC: E.fogC,
        uWx: [E.wet, E.snow, E.fog, E.lightning], uWx2: [E.sway, E.cloud, E.sunK, E.hollow] };
      ctx.fullscreen(st.pView, Object.assign({ uLayer: 0 }, vu), vt, null);
      // sprites are painted in afternoon light: tint them for the current light, soften their shadows under cloud and at night
      const SL = [0.8, 0.8, 0.8];
      const sl = [0, 1, 2].map(i => Math.min(1.25, (E.sun[i] * SL[i] + E.sky[i] * 0.5) / (SUN0[i] * SL[i] + SKY0[i] * 0.5) + E.lightning * 0.8));
      const tint = (c) => [c[0] * sl[0], c[1] * sl[1], c[2] * sl[2]];
      const shK = 0.3 + 0.7 * Math.min(1, E.sunK * 1.4);
      const L = E.lights;

      // scorch marks from point-and-fire impacts, fading over several seconds
      for (const s of st.scorch) {
        const k = s.age / s.life, a = Math.min(1, s.age * 6) * (1 - k * k);
        ctx.sprite('scorch', s.x, s.y, { w: s.s * (1 + 0.1 * Math.min(1, s.age * 3)), rot: s.rot, alpha: 0.7 * a, tint: [0.03, 0.025, 0.02] });
      }
      // ground-level dust
      for (const p of st.dust) {
        if (p.age < 0) continue;
        const k = p.age / p.life;
        ctx.sprite('puff', p.x, p.y, { w: p.s0 + (p.s1 - p.s0) * Math.sqrt(k), alpha: p.a * (1 - k) * (1 - k), tint: tint(p.c) });
      }
      // walker: long shadow first (it stands tall in a low sun), then legs and head
      const w = st.walker;
      if (w && w.alpha > 0) {
        const a = w.alpha * intro, ca = Math.cos(w.ang), sa = Math.sin(w.ang), sx = SHD[0], sy = SHD[1];
        const bob = Math.abs(Math.sin(w.phase)) * 1.2;
        const legs = [];
        for (let k = 0; k < 2; k++) {
          const s = k ? 1 : -1, ph = w.phase + k * Math.PI;
          const fwd = Math.sin(ph) * 11, lift = Math.max(0, Math.cos(ph)) * (w.spdK == null ? 1 : w.spdK);
          const hip = { x: w.x - ca * 2 - sa * 7 * s, y: w.y - sa * 2 + ca * 7 * s };
          const foot = { x: w.x + ca * fwd - sa * 10 * s, y: w.y + sa * fwd + ca * 10 * s };
          const knee = { x: (hip.x + foot.x) / 2 - ca * 7 - sa * 3 * s, y: (hip.y + foot.y) / 2 - sa * 7 + ca * 3 * s };
          legs.push({ hip, foot, knee, lift });
        }
        const strut = (p, q, wd, o) => { const dx = q.x - p.x, dy = q.y - p.y; ctx.sprite('strut', (p.x + q.x) / 2, (p.y + q.y) / 2, Object.assign({ w: Math.hypot(dx, dy) + 3, h: wd, rot: Math.atan2(dy, dx) }, o)); };
        const sh = { tint: [0, 0, 0], flat: 1, alpha: 0.5 * a * shK, bias: 1.6 };
        const HIP = 46 / LRISE, KNEE = 26 / LRISE, HEAD = 62 / LRISE;
        for (const Lg of legs) {
          const fo = Lg.lift * 4 / LRISE;
          strut({ x: Lg.hip.x + sx * HIP, y: Lg.hip.y + sy * HIP }, { x: Lg.knee.x + sx * KNEE, y: Lg.knee.y + sy * KNEE }, 4.5, sh);
          strut({ x: Lg.knee.x + sx * KNEE, y: Lg.knee.y + sy * KNEE }, { x: Lg.foot.x + sx * fo, y: Lg.foot.y + sy * fo }, 4, sh);
          ctx.sprite('foot', Lg.foot.x + sx * fo, Lg.foot.y + sy * fo, { w: 10, rot: w.ang, tint: [0, 0, 0], flat: 1, alpha: 0.45 * a * shK, bias: 1.5 });
        }
        ctx.sprite('atHead', w.x + sx * (HEAD + bob), w.y + sy * (HEAD + bob), { w: 36, rot: w.headAng, tint: [0, 0, 0], flat: 1, alpha: 0.52 * a * shK, bias: 2.2 });
        for (const Lg of legs) {
          const fs = 10 * (1 + Lg.lift * 0.12);
          ctx.sprite('foot', Lg.foot.x, Lg.foot.y, { w: fs, rot: w.ang, alpha: a, tint: sl, shadow: { dx: 1.5, dy: 1.2, alpha: 0.5 * (1 - Lg.lift), bias: 1 } });
          strut(Lg.knee, Lg.foot, 4.5, { alpha: a, tint: tint([0.8, 0.8, 0.78]) });
          strut(Lg.hip, Lg.knee, 5.2, { alpha: a, tint: sl });
        }
        ctx.sprite('atHead', w.x - ca * bob * 0.6, w.y - sa * bob * 0.6, { w: 36 * (1 + bob * 0.006), rot: w.headAng, alpha: a, tint: tint([1.05, 1.03, 1]) });
        if (L > 0.01) {
          // searchlights from the chin
          const ch = Math.cos(w.headAng), shh = Math.sin(w.headAng);
          ctx.glowLine(w.x + ch * 32, w.y + shh * 32, w.x + ch * 80, w.y + shh * 80, 16, [1, 0.95, 0.82], 0.1 * L * a, { core: 0, falloff: 1.4 });
          for (const s of [-1, 1]) ctx.glowDot(w.x + ch * 19 - shh * 3 * s, w.y + shh * 19 + ch * 3 * s, 1.6, [1, 0.95, 0.85], 4 * L * a, { core: 0.8 });
        }
      }
      // speeders: soft shadow, hull, engine glow, headlights after dark
      for (const b of st.bikes) {
        const a = b.alpha * intro; if (a <= 0.01) continue;
        const imp = b.kind === 'i', bank = b.bank || 0;
        const ang = b.strike ? angLerp(b.ang, Math.atan2(b.strike.y - b.y, b.strike.x - b.x), 0.45 * b.strike.k) : b.ang;
        const sdx = 6.5 + bank * Math.sin(ang) * -3, sdy = 5.5 + bank * Math.cos(ang) * 3;
        ctx.sprite(imp ? 'bikeI' : 'bikeR', b.x + sdx, b.y + sdy, { w: BIKE_W, h: BIKE_W * 0.375, rot: ang, alpha: 0.5 * a * shK, tint: [0, 0, 0], flat: 1, bias: 1.4 });
        ctx.sprite(imp ? 'bikeI' : 'bikeR', b.x, b.y, { w: BIKE_W, h: BIKE_W * 0.375 * (1 - Math.abs(bank) * 0.18), rot: ang, alpha: a, tint: sl });
        if (L > 0.01) {
          const ca = Math.cos(ang), sa = Math.sin(ang);
          ctx.glowLine(b.x + ca * 30, b.y + sa * 30, b.x + ca * 62, b.y + sa * 62, 13, [1, 0.93, 0.78], 0.1 * L * a, { core: 0, falloff: 1.4 });
          ctx.glowDot(b.x + ca * 21, b.y + sa * 21, 1.5, [1, 0.96, 0.88], 5 * L * a, { core: 0.8 });
        }
      }
      for (const b of st.bikes) {
        const a = b.alpha * intro; if (a <= 0.01) continue;
        const ca = Math.cos(b.ang), sa = Math.sin(b.ang), boost = (b.boost || (b.follow ? 1.3 : 1)) * (1 + 0.5 * (b.startle || 0));
        for (const s of [-1, 1]) ctx.glowDot(b.x - ca * 19.5 - sa * 2.3 * s, b.y - sa * 19.5 + ca * 2.3 * s, 2.2, [1, 0.45, 0.16], (1.8 + boost * 0.6) * a, { core: 0.7 });
      }
      for (const c of st.chunks) {
        const k = c.age / c.life;
        ctx.sprite('chunk', c.x, c.y, { w: c.size, rot: c.rot, alpha: 1 - k * k, tint: tint([0.09, 0.06, 0.04]) });
      }
      ctx.flush();

      // canopy over the vehicles, motes, mist, fog
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      ctx.fullscreen(st.pView, Object.assign({ uLayer: 1 }, vu), vt, null);
      gl.disable(gl.BLEND);

      // night: campfires in the clearings, tree-village lights in the canopy, fireflies
      if (L > 0.01) {
        const fogDim = 1 - 0.5 * E.fog;
        for (const c of st.camps) {
          const fl = 0.8 + 0.2 * Math.sin(t * 9.1 + c.ph) * Math.sin(t * 5.3 + c.ph * 2) + 0.08 * Math.sin(t * 23 + c.ph);
          ctx.glowDot(c.x, c.y, 34, [1, 0.42, 0.13], 0.24 * L * fl * fogDim, { core: 0, falloff: 1.1 });
          ctx.glowDot(c.x, c.y, 3.2, [1, 0.55, 0.2], 7 * L * fl * (1 - 0.6 * E.rain), { core: 0.9 });
        }
        for (const v of st.villages) {
          ctx.glowDot(v.x, v.y, 48, [1, 0.5, 0.2], 0.08 * L * fogDim, { core: 0, falloff: 1.1 });
          for (const l of v.lights) {
            const fl = 0.85 + 0.15 * Math.sin(t * 3.7 + l.ph);
            ctx.glowDot(l.x, l.y, 8 * l.s, [1, 0.55, 0.22], 0.35 * L * fl, { core: 0, falloff: 1.3 });
            ctx.glowDot(l.x, l.y, 1.6 * l.s, [1, 0.68, 0.34], 6 * L * fl, { core: 0.9 });
          }
        }
        const fk = L * (1 - E.rain) * (1 - E.snow) * (1 - 0.7 * E.fog);
        if (fk > 0.01) for (const f of st.flies) {
          const pu = Math.pow(Math.max(0, Math.sin(t * f.fr * 2.1 + f.ph)), 6);
          if (pu < 0.02) continue;
          const x = f.hx + f.ox + Math.sin(t * 0.37 * f.w + f.ph) * 14, y = f.hy + f.oy + Math.cos(t * 0.29 * f.w + f.ph * 1.7) * 11;
          ctx.glowDot(x, y, 2.4, [0.62, 1, 0.18], 2.2 * pu * fk, { core: 0.4 });
        }
      }
      // blaster light reads through the leaves
      st.bolts.draw();
      for (const b of st.booms) {
        const k = b.age / b.life, s = b.s == null ? 1 : b.s;
        ctx.glowDot(b.x, b.y, (10 + 40 * k) * (0.5 + 0.5 * s), [1, 0.5, 0.16], 14 * (1 - k) * (1 - k) * (0.6 + 0.4 * s), { core: 1 - k });
        ctx.sprite('puff', b.x, b.y, { w: (18 + 50 * k) * (0.45 + 0.55 * s), alpha: (1 - k), tint: [3, 1.3, 0.4], add: 1 });
      }
      for (const s of st.scorch) if (s.age < 2.2) {
        const k = s.age / 2.2;
        ctx.glowDot(s.x, s.y, s.s * 0.35, [1, 0.35, 0.08], 2.2 * (1 - k) * (1 - k), { core: 0.5 });
      }
      // above the trees: smoke, starfighters, birds, leaves, rain, snow
      for (const p of st.smoke) {
        if (p.age < 0) continue;
        const k = p.age / p.life;
        ctx.sprite('puff', p.x, p.y, { w: p.s0 + (p.s1 - p.s0) * Math.sqrt(k), alpha: p.a * Math.min(1, p.age * 4) * (1 - k), tint: tint(p.c) });
      }
      for (const f of st.fighters) {
        const ca = Math.cos(f.ang), sa = Math.sin(f.ang);
        ctx.sprite('fighter', f.x, f.y, { w: 62, rot: f.ang, tint: sl, shadow: { dx: SHD[0] * 95, dy: SHD[1] * 95, alpha: 0.32 * shK, bias: 3.5, scale: 1.05 } });
        for (const s of [-1, 1]) for (const o of [0.9, 1.9]) ctx.glowDot(f.x - ca * 30 - sa * 4.6 * o * s, f.y - sa * 30 + ca * 4.6 * o * s, 2.4, [1, 0.5, 0.42], 4.5, { core: 0.8 });
      }
      for (const b of st.birds) {
        const flapping = (b.flee || 0) > 0.1 || Math.sin(t * 0.9 + b.gl) > -0.2;
        const wv = flapping ? Math.sin(t * (12 + 8 * (b.flee || 0)) + b.ph) : 0.95;
        const span = 0.3 + 0.7 * Math.abs(wv);
        ctx.sprite('bird', b.x, b.y, { w: 9, h: 13 * span, rot: b.ang, tint: [0.06, 0.045, 0.035], alpha: intro, shadow: { dx: 30, dy: 25, alpha: 0.25 * shK, bias: 3, tint: [0, 0, 0] } });
      }
      for (const l of st.leaves) {
        const k = l.age / l.life, a = Math.min(1, l.age * 3) * (1 - k * k);
        ctx.sprite('leaf', l.x, l.y, { w: 6, rot: l.rot, h: 4 * (0.4 + 0.6 * Math.abs(Math.sin(l.rot * 0.7))), alpha: a, tint: tint(l.c), shadow: { dx: 14, dy: 12, alpha: 0.2 * shK, bias: 2 } });
      }
      const ambK = Math.max(0.16, Math.min(1.2, E.ambK)) * (1 + 3 * E.lightning);
      for (const s of st.splash) {
        const k = s.age / s.life;
        ctx.sprite('ring', s.x, s.y, { w: 1.5 + s.s * k, alpha: 0.3 * (1 - k), tint: [0.75 * ambK, 0.8 * ambK, 0.88 * ambK], add: 1 });
      }
      for (const d of st.rain) {
        const k = d.age / d.life, sp = Math.hypot(d.vx, d.vy) || 1, ux = d.vx / sp, uy = d.vy / sp, ln = d.len * (0.7 + 0.6 * d.z);
        ctx.glowLine(d.x - ux * ln, d.y - uy * ln, d.x, d.y, 0.8 + 0.6 * d.z, [0.72, 0.78, 0.88], 0.32 * ambK * Math.sin(Math.PI * k) * (0.5 + 0.7 * d.z), { core: 0 });
      }
      const fl = [Math.min(1.1, 0.25 + 0.9 * ambK), Math.min(1.1, 0.27 + 0.9 * ambK), Math.min(1.15, 0.32 + 0.9 * ambK)];
      for (const f of st.flakes) {
        const k = f.age / f.life, a = Math.min(1, f.age * 2) * Math.min(1, (f.life - f.age) * 2);
        ctx.sprite('puff', f.x, f.y, { w: f.s, alpha: a * (0.55 + 0.35 * f.z), tint: fl });
      }
    },

    dispose(ctx) {
      if (!st) return;
      freeTargets(ctx);
      if (st.tNoise) ctx.freeTarget(st.tNoise);
      for (const k of ['pNoise', 'pField', 'pGeo', 'pLit', 'pAux', 'pView']) if (st[k]) ctx.gl.deleteProgram(st[k].p);
      st = null;
    }
  });
})();
