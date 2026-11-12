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
  outColor = vec4(col, canopy);
}`;

  const AUX_FS = `
uniform sampler2D uLit;
const vec2 L2 = vec2(-0.7662, -0.6426);
vec2 uvOf(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
void main() {
  vec2 p = cssPos();
  float open = 0., cov = 0.;
  for (int k = 1; k <= 6; k++) open += 1. - texture(uLit, uvOf(p + L2 * float(k) * 17.)).a;
  for (int k = 0; k < 5; k++) { float a = float(k) * 1.2566; cov += texture(uLit, uvOf(p + vec2(cos(a), sin(a)) * 14.)).a; }
  outColor = vec4(open / 6., cov / 5., 0., 1.);
}`;

  const VIEW_FS = `
uniform sampler2D uLit, uField, uAux, uNoise;
uniform float uLayer;
uniform vec2 uWind;
const vec2 L2 = vec2(-0.7662, -0.6426);
void main() {
  vec2 p = cssPos();
  vec2 uv = vUv;
  float t = uFlow;
  vec2 wd = uWind, wp = vec2(-wd.y, wd.x);
  float hm = texture(uLit, uv).a;
  float gust = texture(uNoise, p / 1500. - wd * t * .0055).g;
  float wave = sin(dot(p, wd) * .02 - t * 1.6 + gust * 9.);
  float wave2 = sin(dot(p, wp) * .045 + t * 2.1 + gust * 6.);
  vec2 disp = (wd * (wave * .7 + (gust - .5) * 3.2) + wp * wave2 * .3) * hm;
  vec4 c = texture(uLit, uv + vec2(disp.x, -disp.y) / uRes);
  vec3 col = c.rgb;
  float canopy = c.a;
  col *= 1. + canopy * (.06 * wave * (gust * 2. - .4) + .13 * (vnoise(p * .3 + wd * t * 2.) - .5));
  // sunlit leaves catch the light as the wind turns them
  float g1 = texture(uNoise, p / 80. + wd * t * .035).b, g2 = texture(uNoise, p / 63. - wp * t * .028 + .5).b;
  col *= 1. + canopy * smoothstep(.1, .3, luma(col)) * smoothstep(.56, .7, g1 * g2 * 1.9) * .55;
  vec2 cq = p / 2300. + vec2(t * .0042, t * .0021) + uSeed * .01;
  float cl = texture(uNoise, cq).r * .72 + texture(uNoise, cq * 2.7 + .3).a * .28;
  float cs = smoothstep(.47, .63, cl);
  col *= mix(1., .56, cs);
  vec4 f = texture(uField, uv);
  vec4 ax = texture(uAux, uv);
  if (uLayer < .5) {
    float lit = smoothstep(.04, .2, luma(col));
    float rim = smoothstep(.03, .45, ax.g) * (1. - canopy);
    float dap = texture(uNoise, p / 150. + wd * t * .018 + vec2(0., t * .004)).b;
    col *= 1. + lit * rim * (smoothstep(.36, .64, dap) - .5) * .75 * smoothstep(0., 40., f.b);
    outColor = vec4(col, 1.);
  } else {
    float A = canopy;
    vec3 C = col * A;
    float open = ax.r;
    vec2 g = floor(p / 18.);
    vec3 hh = hash32(g + uSeed * 1.7 + 50.);
    if (hh.z > .8) {
      vec2 mp = (g + .5 + .4 * vec2(sin(t * .3 + hh.x * 6.28), sin(t * .23 + hh.y * 6.28))) * 18.;
      vec2 md = p - mp; float d2 = dot(md, md);
      float tw = .5 + .5 * sin(t * (2. + hh.z * 3.) + hh.x * 40.);
      C += vec3(1., .85, .6) * exp(-d2 * 1.1) * 2.4 * tw * open * smoothstep(4., 24., f.b) * (1. - canopy) * (1. - cs * .7);
    }
    vec2 mq = p / 1500. + vec2(t * .006, t * .0024) + uSeed * .013;
    float mn = texture(uNoise, mq).g * .65 + texture(uNoise, mq * 2.3 - t * .002).r * .35;
    float mist = smoothstep(.54, .74, mn) * .11 * (1. - ax.g * .4);
    mist *= mix(.3, 1., smoothstep(0., 90., f.b));
    float rev = smoothstep(0., .5, uIntro * 1.6 - texture(uNoise, p / 900. + .5).a * 1.4 + .25 - smoothstep(0., 400., f.b) * .4);
    mist = mix(.92, mist, rev);
    vec3 mistC = vec3(.74, .71, .60) * (1. - cs * .45);
    C = C * (1. - mist) + mistC * mist;
    A = A * (1. - mist) + mist;
    float hz = .04;
    C = C * (1. - hz) + vec3(.5, .42, .28) * hz; A = A * (1. - hz) + hz;
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
  function defineSprites(atlas) {
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
  function runAux(ctx, lit) { ctx.fullscreen(st.pAux, {}, { uLit: lit.tex }, st.tAux); }
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
        runField(ctx); runGeo(ctx, st.tGeoLo); mipGeo(ctx, st.tGeoLo); runLit(ctx, st.tGeoLo, st.tLitLo, true); runAux(ctx, st.tLitLo);
        st.loValid = true; st.show = 'lo';
      }
      st.needHi = true; st.hiStep = -1;
      return;
    }
    if (!st.needHi) return;
    if (!st.loValid || st.show !== 'lo') {
      runField(ctx); runGeo(ctx, st.tGeo); mipGeo(ctx, st.tGeo); runLit(ctx, st.tGeo, st.tLit, false); runAux(ctx, st.tLit);
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
      default: runAux(ctx, st.tLit); st.show = 'hi'; st.needHi = false; st.hiStep = -1; st.loValid = false;
    }
  }

  /* ---------------------------------------------------------------- scene */
  Galaxy.register(ID, {
    name: 'Forest moon',
    post: { bloom: 0.5, threshold: 1.15, knee: 0.6, exposure: 1.1, vignette: 0.38, grain: 0.018, aberration: 0.0006, tint: [1.05, 1.0, 0.9], lift: [0.003, 0.003, 0.002], saturation: 1.08, bloomRadius: 1.1 },

    init(ctx) {
      st = { rng: ctx.rng(77), bikes: [], dust: [], smoke: [], chunks: [], booms: [], birds: [], walker: null, chase: null, ferns: [],
        chaseT: 3, birdT: 2.5, spawnT: 0, frame: 0, graph: null, trailDirty: true, fernDirty: true, needHi: true, loValid: false, hiStep: -1, show: null, trailCur: 0 };
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

    update(ctx) {
      const dt = ctx.dt, t = ctx.t, r = st.rng, P = ctx.P, W = ctx.W, H = ctx.H;
      if (!st.graph) return;
      const ok = Math.exp(-dt * 2.2);
      // traffic
      const want = Math.round(P.traffic * 9 * Math.sqrt(W * H / (1920 * 1080)));
      const normal = st.bikes.filter(b => !b.temp && !b.out);
      st.spawnT -= dt;
      if (normal.length < want && st.spawnT <= 0) { const b = spawnBike(ctx, r() < 0.65); if (b) st.bikes.push(b); st.spawnT = 0.5 + r() * 1.2; }
      if (normal.length > want) { const b = normal.find(x => x !== (st.chase && st.chase.prey)); if (b) b.out = true; }
      for (const b of st.bikes) {
        const pa = b.ang;
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
          stepMover(b.m, b.spd * b.boost * dt, r, true);
          if (b.m.exited) { b.dead = true; continue; }
          edgePos(b.m.e, b.m.u, tmp);
          const ta = tmp.ang + (b.m.dir < 0 ? Math.PI : 0);
          b.m.ang = angLerp(b.m.ang, ta, Math.min(1, dt * 12));
          const wob = Math.sin(b.m.age * 2.1 + b.ph) * 2.2;
          b.ox *= ok; b.oy *= ok;
          b.x = tmp.x - Math.sin(b.m.ang) * wob + b.ox; b.y = tmp.y + Math.cos(b.m.ang) * wob + b.oy; b.ang = b.m.ang;
          if (b.fadeIn) { b.alpha = Math.min(1, b.alpha + dt * 1.5); if (b.alpha >= 1) b.fadeIn = false; }
          if (b.out) { b.alpha -= dt * 1.2; if (b.alpha <= 0) b.dead = true; }
          b.hist.push({ t, x: b.x, y: b.y, ang: b.ang });
          while (b.hist.length > 2 && b.hist[0].t < t - 2.5) b.hist.shift();
        }
        // bank into turns (drawn as a slight squash and a sideways shadow shift)
        if (dt > 0) { let da = b.ang - pa; da = Math.atan2(Math.sin(da), Math.cos(da)); b.bank += (clamp(da / dt * 0.25, -0.6, 0.6) - b.bank) * Math.min(1, dt * 6); }
        // dust wake
        b.puffT -= dt;
        if (b.puffT <= 0 && b.alpha > 0.2 && dt > 0) {
          b.puffT = 0.03;
          const bx = b.x - Math.cos(b.ang) * 16, by = b.y - Math.sin(b.ang) * 16;
          st.dust.push({ x: bx + (r() - 0.5) * 5, y: by + (r() - 0.5) * 5, vx: -Math.cos(b.ang) * 28 + (r() - 0.5) * 20, vy: -Math.sin(b.ang) * 28 + (r() - 0.5) * 20, age: 0, life: 0.8 + r() * 0.6, s0: 4, s1: 15 + r() * 8, a: 0.15 * b.alpha, c: [0.36, 0.28, 0.19] });
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
      else if (st.walker) st.walker.out = true;
      const w = st.walker;
      if (w) {
        w.alpha = w.out ? w.alpha - dt * 0.8 : Math.min(1, w.alpha + dt * 0.7);
        if (w.alpha <= 0 && w.out) st.walker = null;
        else {
          const moving = !w.aim;
          const dist = moving ? 16 * dt : 0;
          w.m.age += dt;
          stepMover(w.m, dist, r, false);
          w.phase += dist / 40 * TAU;
          if (!moving) w.phase += (Math.round(w.phase / Math.PI) * Math.PI - w.phase) * Math.min(1, dt * 3);
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
          let wantA = w.ang;
          if (w.aim) {
            if (w.aim.b && !w.aim.b.dead) { w.aim.x = w.aim.b.x; w.aim.y = w.aim.b.y; }
            wantA = Math.atan2(w.aim.y - w.y, w.aim.x - w.x);
            w.shotT -= dt;
            let dd = wantA - w.headAng; dd = Math.atan2(Math.sin(dd), Math.cos(dd));
            if (w.shotT <= 0 && Math.abs(dd) < 0.15) {
              const ca = Math.cos(w.headAng), sa = Math.sin(w.headAng), d = Math.hypot(w.aim.x - w.x, w.aim.y - w.y);
              for (const s of [-1, 1]) fire(w.x + ca * 19 - sa * 2.6 * s, w.y + sa * 19 + ca * 2.6 * s, w.headAng + (r() - 0.5) * 0.08, d, [1, 0.22, 0.06], { speed: 640, len: 22, intensity: 5, width: 1.5 });
              w.burst--; w.shotT = 0.35;
              if (w.burst <= 0) { w.aim = null; w.fireT = (3 + r() * 5) * (1.6 - P.skirmish); }
            }
          }
          w.headAng = angLerp(w.headAng, wantA, Math.min(1, dt * 2.2));
        }
      }
      // bolts and impacts
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
        b.x += Math.cos(b.ang) * b.spd * dt; b.y += Math.sin(b.ang) * b.spd * dt;
      }
      st.birds = st.birds.filter(b => b.x > -200 && b.y > -200 && b.x < W + 200 && b.y < H + 200);
      st.wind = 0.55 + 0.35 * Math.sin(t * 0.021) + 0.15 * Math.sin(t * 0.077);
    },

    render(ctx) {
      const gl = ctx.gl, t = ctx.t, intro = ctx.intro;
      if (!st.tLit || st.size !== ctx.pxW + 'x' + ctx.pxH) allocTargets(ctx);
      ensureNoise(ctx);
      if (st.trailDirty) drawTrails(ctx);
      if (st.fernDirty) drawFerns(ctx);
      updateCache(ctx);
      const lit = st.show === 'lo' ? st.tLitLo : st.tLit;
      const wa = st.wind || 0.6, wind = [Math.cos(wa), Math.sin(wa)];
      const vt = { uLit: lit.tex, uField: st.tField.tex, uAux: st.tAux.tex, uNoise: st.tNoise.tex };
      ctx.fullscreen(st.pView, { uLayer: 0, uWind: wind }, vt, null);

      // ground-level dust
      for (const p of st.dust) {
        if (p.age < 0) continue;
        const k = p.age / p.life;
        ctx.sprite('puff', p.x, p.y, { w: p.s0 + (p.s1 - p.s0) * Math.sqrt(k), alpha: p.a * (1 - k) * (1 - k), tint: p.c });
      }
      // walker: long shadow first (it stands tall in a low sun), then legs and head
      const w = st.walker;
      if (w && w.alpha > 0) {
        const a = w.alpha * intro, ca = Math.cos(w.ang), sa = Math.sin(w.ang), sx = SHD[0], sy = SHD[1];
        const bob = Math.abs(Math.sin(w.phase)) * 1.2;
        const legs = [];
        for (let k = 0; k < 2; k++) {
          const s = k ? 1 : -1, ph = w.phase + k * Math.PI;
          const fwd = Math.sin(ph) * 11, lift = Math.max(0, Math.cos(ph)) * (w.aim ? 0 : 1);
          const hip = { x: w.x - ca * 2 - sa * 7 * s, y: w.y - sa * 2 + ca * 7 * s };
          const foot = { x: w.x + ca * fwd - sa * 10 * s, y: w.y + sa * fwd + ca * 10 * s };
          const knee = { x: (hip.x + foot.x) / 2 - ca * 7 - sa * 3 * s, y: (hip.y + foot.y) / 2 - sa * 7 + ca * 3 * s };
          legs.push({ hip, foot, knee, lift });
        }
        const strut = (p, q, wd, o) => { const dx = q.x - p.x, dy = q.y - p.y; ctx.sprite('strut', (p.x + q.x) / 2, (p.y + q.y) / 2, Object.assign({ w: Math.hypot(dx, dy) + 3, h: wd, rot: Math.atan2(dy, dx) }, o)); };
        const sh = { tint: [0, 0, 0], flat: 1, alpha: 0.5 * a, bias: 1.6 };
        const HIP = 46 / LRISE, KNEE = 26 / LRISE, HEAD = 62 / LRISE;
        for (const L of legs) {
          const fo = L.lift * 4 / LRISE;
          strut({ x: L.hip.x + sx * HIP, y: L.hip.y + sy * HIP }, { x: L.knee.x + sx * KNEE, y: L.knee.y + sy * KNEE }, 4.5, sh);
          strut({ x: L.knee.x + sx * KNEE, y: L.knee.y + sy * KNEE }, { x: L.foot.x + sx * fo, y: L.foot.y + sy * fo }, 4, sh);
          ctx.sprite('foot', L.foot.x + sx * fo, L.foot.y + sy * fo, { w: 10, rot: w.ang, tint: [0, 0, 0], flat: 1, alpha: 0.45 * a, bias: 1.5 });
        }
        ctx.sprite('atHead', w.x + sx * (HEAD + bob), w.y + sy * (HEAD + bob), { w: 36, rot: w.headAng, tint: [0, 0, 0], flat: 1, alpha: 0.52 * a, bias: 2.2 });
        for (const L of legs) {
          const fs = 10 * (1 + L.lift * 0.12);
          ctx.sprite('foot', L.foot.x, L.foot.y, { w: fs, rot: w.ang, alpha: a, shadow: { dx: 1.5, dy: 1.2, alpha: 0.5 * (1 - L.lift), bias: 1 } });
          strut(L.knee, L.foot, 4.5, { alpha: a, tint: [0.8, 0.8, 0.78] });
          strut(L.hip, L.knee, 5.2, { alpha: a });
        }
        ctx.sprite('atHead', w.x - ca * bob * 0.6, w.y - sa * bob * 0.6, { w: 36 * (1 + bob * 0.006), rot: w.headAng, alpha: a, tint: [1.05, 1.03, 1] });
      }
      // speeders: soft shadow, hull, engine glow
      for (const b of st.bikes) {
        const a = b.alpha * intro; if (a <= 0.01) continue;
        const imp = b.kind === 'i', bank = b.bank || 0;
        const sdx = 6.5 + bank * Math.sin(b.ang) * -3, sdy = 5.5 + bank * Math.cos(b.ang) * 3;
        ctx.sprite(imp ? 'bikeI' : 'bikeR', b.x + sdx, b.y + sdy, { w: BIKE_W, h: BIKE_W * 0.375, rot: b.ang, alpha: 0.5 * a, tint: [0, 0, 0], flat: 1, bias: 1.4 });
        ctx.sprite(imp ? 'bikeI' : 'bikeR', b.x, b.y, { w: BIKE_W, h: BIKE_W * 0.375 * (1 - Math.abs(bank) * 0.18), rot: b.ang, alpha: a });
      }
      for (const b of st.bikes) {
        const a = b.alpha * intro; if (a <= 0.01) continue;
        const ca = Math.cos(b.ang), sa = Math.sin(b.ang), boost = b.boost || (b.follow ? 1.3 : 1);
        for (const s of [-1, 1]) ctx.glowDot(b.x - ca * 19.5 - sa * 2.3 * s, b.y - sa * 19.5 + ca * 2.3 * s, 2.2, [1, 0.45, 0.16], (1.8 + boost * 0.6) * a, { core: 0.7 });
      }
      for (const c of st.chunks) {
        const k = c.age / c.life;
        ctx.sprite('chunk', c.x, c.y, { w: c.size, rot: c.rot, alpha: 1 - k * k, tint: [0.09, 0.06, 0.04] });
      }
      ctx.flush();

      // canopy over the vehicles, motes, mist
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      ctx.fullscreen(st.pView, { uLayer: 1, uWind: wind }, vt, null);
      gl.disable(gl.BLEND);

      // blaster light reads through the leaves
      st.bolts.draw();
      for (const b of st.booms) {
        const k = b.age / b.life;
        ctx.glowDot(b.x, b.y, 10 + 40 * k, [1, 0.5, 0.16], 14 * (1 - k) * (1 - k), { core: 1 - k });
        ctx.sprite('puff', b.x, b.y, { w: 18 + 50 * k, alpha: (1 - k), tint: [3, 1.3, 0.4], add: 1 });
      }
      // above the trees: smoke, birds
      for (const p of st.smoke) {
        if (p.age < 0) continue;
        const k = p.age / p.life;
        ctx.sprite('puff', p.x, p.y, { w: p.s0 + (p.s1 - p.s0) * Math.sqrt(k), alpha: p.a * Math.min(1, p.age * 4) * (1 - k), tint: p.c });
      }
      for (const b of st.birds) {
        const flapping = Math.sin(t * 0.9 + b.gl) > -0.2;
        const wv = flapping ? Math.sin(t * 12 + b.ph) : 0.95;
        const span = 0.3 + 0.7 * Math.abs(wv);
        ctx.sprite('bird', b.x, b.y, { w: 9, h: 13 * span, rot: b.ang, tint: [0.06, 0.045, 0.035], alpha: intro, shadow: { dx: 30, dy: 25, alpha: 0.25, bias: 3, tint: [0, 0, 0] } });
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
