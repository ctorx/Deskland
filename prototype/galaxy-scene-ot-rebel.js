// Galaxy scene ot-rebel (Original trilogy, Rebellion): "Forest moon".
// Straight down onto the canopy of an ancient giant-tree forest in warm afternoon light. Each desktop icon sits in a sunlit
// clearing on the forest floor; the crowns close in around the clearings, trunks and fallen logs cast long shadows,
// dirt trails wind between clearings, speeder bikes race along them, a two-legged walker plods by, birds glide over the trees.
//
// Passes:
//   field  (CSS/2 res, layout-dependent): R = clearing field, G = distance to trails, B = icon distance, A = icon blob
//   cache  (full res, re-rendered only when the layout changes): lit canopy + forest floor (ray-marched shadows), A = canopy height
//   view   (every frame): wind sway, leaf flutter, cloud shadows, dappled sun, fireflies         -> opaque
//   sprites: dust, walker, speeders, bolts, debris
//   view overlay (every frame, blended): canopy over the vehicles, light shafts, pollen motes, mist, haze
//   sprites: birds and explosion smoke above the trees
(function () {
  'use strict';
  const ID = 'ot-rebel';
  const TAU = Math.PI * 2;
  const SHD = [0.7662, 0.6426];          // shadow direction on the ground (sun from the upper left)
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const angLerp = (a, b, t) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; };
  let st = null;

  /* ---------------------------------------------------------------- shaders */
  const FIELD_FS = `
uniform sampler2D uTrail;
void main() {
  vec2 p = cssPos();
  float b = iconBlob(p), d = iconDist(p);
  float n = gfbm(p * 0.0075 + uSeed * 0.31, 4) * (uSigma * 0.8 + 30.) + gnoise(p * 0.035 + uSeed) * 10.;
  float cf = min(b + n + uSigma * 0.12, d - 22.);
  float m = texture(uTrail, vUv).r;
  float td = m > 0.003 ? 40. * sqrt(max(0., -log(min(m, 1.))) / 2.2) : 80.;
  outColor = vec4(cf, td, d, b);
}`;

  const CACHE_FS = `
uniform sampler2D uField;
uniform float uQ;
const vec3 LD = vec3(-0.6155, -0.5162, 0.5956);
const vec2 L2 = vec2(-0.7662, -0.6426);
const float LRISE = 0.7414;
vec4 fld(vec2 p) { return texture(uField, vec2(p.x / uRes.x, 1. - p.y / uRes.y)); }

float gClump = 0.;
// Canopy height in CSS px. info: x = palette key, y = radial position in the crown, z = big crown (1) / understory (0), w = crown height
float canopyH(vec2 p, out vec4 info) {
  vec2 pw = p + vec2(gnoise(p * 0.028 + uSeed), gnoise(p * 0.028 + uSeed + 17.3)) * 16.;
  vec2 pv = p + vec2(gnoise(p * 0.11 + 4.), gnoise(p * 0.11 + 9.)) * 2.5;
  vec4 v = voronoi(pv / 10. + uSeed * 0.77);
  vec4 v2 = voronoi(pv / 4.2 + uSeed * 1.31);
  float sc = (v.x - 0.45) * 0.2 + (v2.x - 0.45) * 0.1;
  float best = 0.; info = vec4(0., 1., 0., 1.);
  for (int L = 0; L < 2; L++) {
    float S = L == 0 ? 108. : 50.;
    float hs = L == 0 ? 80. : 42.;
    vec2 n = floor(pw / S);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = n + vec2(float(i), float(j));
      vec3 hh = hash32(g + vec2(float(L) * 31.7 + uSeed, uSeed * 0.5 + 3.));
      float hw = hash12(g * 1.37 + vec2(uSeed + float(L) * 5.1, 2.3));
      if (L == 1 && hw < 0.18) continue;
      vec2 c = (g + 0.12 + 0.76 * hh.xy) * S;
      vec4 f = fld(c);
      float r = S * (0.52 + 0.3 * hh.z);
      float rE = min(r, f.r + 0.42 * r);
      rE = min(rE, f.b - 14.);
      if (hw > 0.3) rE = min(rE, f.g - 5. + hh.z * 12.);
      else rE = min(rE, f.g + r * 0.35);
      if (rE < S * 0.16) continue;
      float t = length(pw - c) / rE + sc;
      if (t >= 1.) continue;
      float hc = hs * (0.62 + 0.38 * hw);
      float h = hc * pow(1. - t * t, 0.5);
      if (h > best) { best = h; info = vec4(fract(hw * 7.13 + hh.z * 3.1), t, float(1 - L), hc); }
    }
  }
  {
    vec2 n = floor(p / 26.);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = n + vec2(float(i), float(j));
      vec3 hh = hash32(g + vec2(uSeed * 2.7 + 13.1, 5.7));
      if (hh.z < 0.62) continue;
      vec2 c = (g + 0.2 + 0.6 * hh.xy) * 26.;
      vec4 f = fld(c);
      if (f.r > -6. || f.r < -160.) continue;
      float r = 6. + 7. * fract(hh.z * 9.1);
      r = min(r, min(f.b - 16., f.g - 7.));
      if (r < 4.) continue;
      float t = length(pw - c) / r + sc * 1.5;
      if (t >= 1.) continue;
      float h = (9. + 6. * hh.x) * pow(1. - t * t, 0.5);
      if (h > best) { best = h; info = vec4(fract(hh.x * 5.3 + hh.y), t, 0., 15.); }
    }
  }
  if (best > 0.) {
    float cl = sqrt(max(0., 1. - v.x * v.x * 1.3));
    float cl2 = sqrt(max(0., 1. - v2.x * v2.x * 1.5));
    best += (cl * (info.z > .5 ? 5. : 3.5) + cl2 * 3.) * smoothstep(1., .7, info.y);
    gClump = cl * 0.5 + cl2 * 0.5;
  }
  return best;
}

// Forest-floor features near clearings: trunks with buttress roots at the clearing rim, fallen logs.
// fi: x = kind (0 ground, 1 log, 2 trunk), y = radial / cross position, z = angle / along, w = hash
float floorH(vec2 p, out vec4 fi) {
  fi = vec4(0.);
  vec4 f0 = fld(p);
  if (f0.r > 34.) return 0.;
  float h = 0.;
  vec2 n = floor(p / 66.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = n + vec2(float(i), float(j));
    vec3 hh = hash32(g + vec2(uSeed * 1.9 + 7.1, 3.3));
    if (hh.z < 0.3) continue;
    vec2 c = (g + 0.2 + 0.6 * hh.xy) * 66.;
    vec4 f = fld(c);
    if (f.r > -2. || f.r < -50.) continue;
    float r = 9. + 8. * fract(hh.z * 13.7);
    if (f.b < r * 2.3 + 10.) continue;
    vec2 dv = p - c; float d = length(dv);
    if (d > r * 2.7) continue;
    float a = atan(dv.y, dv.x);
    float lob = pow(max(0., cos(a * 4. + hh.x * 20. + sin(a * 3.) * .6)), 2.);
    float hr = 6. * lob * (1. - smoothstep(r * 0.9, r * 2.2, d)) + 3. * (1. - smoothstep(r, r * 1.6, d));
    float ht = d < r ? 62. * sqrt(1. - (d / r) * (d / r)) : 0.;
    float hT = max(ht, hr);
    if (hT > h) { h = hT; fi = vec4(2., d / r, a, hh.x); }
  }
  n = floor(p / 150.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = n + vec2(float(i), float(j));
    vec3 hh = hash32(g + vec2(uSeed * 2.3 + 1.7, 9.1));
    if (hh.z < 0.35) continue;
    vec2 c = (g + 0.25 + 0.5 * hh.xy) * 150.;
    vec4 f = fld(c);
    if (f.r > -14.) continue;
    float ang = hh.x * 18.85; vec2 dir = vec2(cos(ang), sin(ang));
    float len = 22. + 26. * fract(hh.y * 7.7), rad = 4.5 + 3. * fract(hh.z * 5.3);
    vec2 e1 = c - dir * len, e2 = c + dir * len;
    if (min(min(fld(e1).b, fld(e2).b), f.b) < rad + 14.) continue;
    float d = sdSegment(p, e1, e2);
    if (d >= rad) continue;
    float hl = rad + sqrt(rad * rad - d * d);
    if (hl > h) { h = hl; fi = vec4(1., d / rad, dot(p - e1, dir) / (2. * len), hh.x + hh.y); }
  }
  return h;
}
float trunkShadow(vec2 p) {
  float s = 1.;
  vec2 m = p + L2 * 40.;
  vec2 n = floor(m / 66.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = n + vec2(float(i), float(j));
    vec3 hh = hash32(g + vec2(uSeed * 1.9 + 7.1, 3.3));
    if (hh.z < 0.3) continue;
    vec2 c = (g + 0.2 + 0.6 * hh.xy) * 66.;
    vec4 f = fld(c);
    if (f.r > -2. || f.r < -50.) continue;
    float r = 9. + 8. * fract(hh.z * 13.7);
    if (f.b < r * 2.3 + 10.) continue;
    vec2 e = c - L2 * 84.;
    vec2 pa = p - c, ba = e - c; float hq = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
    float d = length(pa - ba * hq);
    float w = r * (1. + hq * .5);
    s = min(s, mix(1., smoothstep(w * .6, w * 1.25, d), smoothstep(1., .7, hq) * .9 + .1 * (1. - hq)));
  }
  return s;
}
float Ht(vec2 p) { vec4 a, b; return max(canopyH(p, a), floorH(p, b)); }

void main() {
  vec2 p = cssPos();
  vec4 f = fld(p);
  vec4 ci, fi;
  float hc = canopyH(p, ci);
  float clump = gClump;
  float hf = floorH(p, fi);
  float h = max(hc, hf);
  bool isC = hc > 0. && hc >= hf;
  float e = 0.8;
  float hx = Ht(p + vec2(e, 0.)), hy = Ht(p + vec2(0., e));
  vec2 gr = vec2(hx - h, hy - h) / e;
  if (isC) gr += vec2(gnoise(p * 2.2 + 2.), gnoise(p * 2.2 + 9.)) * 0.35;
  vec3 N = normalize(vec3(-gr, 1.));

  float sh = 1.;
  float NS = uQ > 0.5 ? 8. : 5.;
  for (int k = 1; k <= 8; k++) {
    if (float(k) > NS) break;
    float s = 125. * pow(float(k) / NS, 1.7) + 2.5;
    vec2 q = p + L2 * s;
    float hq = Ht(q);
    float ray = h + s * LRISE;
    sh = min(sh, clamp(1. - (hq - ray) / (3. + s * 0.3), 0., 1.));
  }

  if (!isC) {
    if (fi.x < 1.5) sh = min(sh, trunkShadow(p));
    sh *= mix(1., .12, smoothstep(-12., 30., f.r));
  }
  vec3 alb; float ao = 1.;
  float calm = smoothstep(6., 28., f.b);
  if (isC) {
    float k = ci.x;
    vec3 pal = k < .42 ? vec3(.022, .058, .022) : k < .70 ? vec3(.034, .078, .025) : k < .85 ? vec3(.058, .070, .024) : k < .96 ? vec3(.072, .098, .026) : vec3(.078, .045, .02);
    float topk = smoothstep(.2, 1., hc / ci.w);
    alb = pal * (0.72 + 0.5 * topk);
    alb = mix(alb, alb * vec3(1.18, 1.22, .78), topk * .5);
    float leaf = vnoise(p * 0.9 + 3.) * 0.5 + vnoise(p * 2.1) * 0.5;
    alb *= 0.6 + 0.7 * leaf;
    alb *= 0.82 + 0.36 * fbm(p * 0.018 + uSeed, 3);
    ao = (0.22 + 0.78 * smoothstep(0., 90., hc)) * mix(1., .6, smoothstep(.65, 1., ci.y)) * (0.3 + 0.7 * clump);
  } else if (fi.x > 1.5) {
    float d = fi.y, a = fi.z;
    vec3 bark = vec3(.17, .07, .04);
    float furrow = 0.7 + 0.3 * sin(a * 22. + fbm(vec2(a * 4., d * 3.), 3) * 6.);
    alb = bark * furrow * (0.75 + 0.5 * vnoise(p * vec2(.7, .7)));
    alb *= 0.75 + 0.25 * smoothstep(1., .3, d);
    alb = mix(alb, vec3(.06, .10, .028), smoothstep(1.4, 2.6, d) * 0.8);
    ao = .85;
  } else if (fi.x > .5) {
    vec3 bark = vec3(.12, .082, .055);
    alb = bark * (0.7 + 0.45 * vnoise(vec2(fi.z * 70. + fi.w * 9., fi.y * 3.)));
    float ends = smoothstep(0.04, 0.0, fi.z) + smoothstep(0.96, 1., fi.z);
    alb = mix(alb, vec3(.2, .14, .08), ends);
    alb = mix(alb, vec3(.06, .13, .028), smoothstep(.55, .1, fi.y) * smoothstep(.35, .65, vnoise(p * .18 + 9.)));
    ao = .85;
  } else {
    float n1 = fbm(p * .025 + uSeed, 5);
    alb = mix(vec3(.034, .062, .018), vec3(.080, .105, .030), smoothstep(.3, .75, n1));
    float dirt = smoothstep(.6, .74, fbm(p * .011 + uSeed + 4.2, 4));
    float trail = 1. - smoothstep(3.5, 8.5, f.g + gnoise(p * .09) * 3.5);
    vec3 dirtC = mix(vec3(.105, .066, .036), vec3(.16, .105, .058), vnoise(p * .2));
    alb = mix(alb, dirtC, max(dirt * .75, trail));
    alb *= .8 + .4 * vnoise(p * .9);
    vec4 mv = voronoi(p / 3.2 + uSeed);
    alb *= .78 + .3 * (1. - mv.x) + .15 * (hash12(mv.zw) - .5);
    alb = mix(alb, alb * vec3(1.25, 1.15, .7), smoothstep(.55, .8, fbm(p * .045 + 8., 3)) * .6);
    alb = mix(alb, vec3(.15, .066, .03), smoothstep(.72, .95, vnoise(p * .33 + 2.)) * .45);
    if (f.r < 16. && trail < .4) {
      vec2 fq = p / 24. + uSeed * 1.3;
      vec4 fv = voronoi(fq);
      vec2 id = fv.zw;
      float hsh = hash12(id + 4.4);
      if (hsh > .32) {
        vec2 fc = (id + hash22(id) - uSeed * 1.3) * 24.;
        float R = 12. + 9. * fract(hsh * 7.3);
        vec2 dv = p - fc; float rr = length(dv);
        float fr = rr / R;
        if (fr < 1.) {
          float NF = 7. + floor(fract(hsh * 3.1) * 5.);
          float a = atan(dv.y, dv.x) + hsh * 20. + fr * (hsh - .5) * 1.6;
          float sect = (fract(a / 6.2832 * NF) - .5) * 6.2832 / NF * rr;
          float w = 4.2 * sin(3.1416 * pow(fr, .8)) * (.65 + .35 * abs(sin(fr * 24.)));
          float m = smoothstep(w + .5, w - .5, abs(sect));
          vec3 fcol = mix(vec3(.035, .10, .02), vec3(.09, .18, .035), fr) * (.8 + .4 * hash12(id + 1.));
          fcol *= mix(.55, 1., smoothstep(0., 1.4, abs(sect)));
          alb = mix(alb * mix(.8, 1., smoothstep(0., 3., abs(sect) - w)), fcol, m * mix(.25, .8, calm));
        }
      }
    }
    ao = mix(0.12, 0.95, smoothstep(20., -45., f.r)) * (.7 + .3 * (1. - mv.x));
  }

  vec3 sunC = vec3(1., .78, .50) * 2.7;
  vec3 skyC = vec3(.30, .40, .52) * .45;
  float diff = max(dot(N, LD), 0.);
  vec3 col = alb * (sunC * diff * sh + skyC * ao);
  if (isC) col += alb * vec3(.55, .75, .2) * sunC * .08 * sh;
  outColor = vec4(col, isC ? hc / 100. : 0.);
}`;

  const VIEW_FS = `
uniform sampler2D uCache, uField;
uniform float uLayer;
uniform vec2 uWind;
const vec2 L2 = vec2(-0.7662, -0.6426);
vec2 toUv(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
void main() {
  vec2 p = cssPos();
  vec2 uv = vUv;
  float t = uFlow;
  vec2 wd = uWind, wp = vec2(-wd.y, wd.x);
  vec4 c0 = texture(uCache, uv);
  float hm = smoothstep(.02, .25, c0.a);
  float gust = vnoise(p * .0035 - wd * t * .09);
  float wave = sin(dot(p, wd) * .022 - t * 1.7 + gust * 5.);
  float wave2 = sin(dot(p, wp) * .05 + t * 2.3 + vnoise(p * .01) * 6.);
  vec2 disp = (wd * (wave * .8 + gust * 1.5) + wp * wave2 * .35) * hm * (.5 + c0.a);
  vec4 c = texture(uCache, uv + vec2(disp.x, -disp.y) / uRes);
  vec3 col = c.rgb;
  float canopy = smoothstep(.02, .12, c.a);
  col *= 1. + canopy * (.08 * wave * gust + .16 * (vnoise(p * .32 + wd * t * 2.2) - .5));
  float cl = fbm(p * .0011 + vec2(t * .010, t * .005) + uSeed, 4);
  float cs = smoothstep(.42, .72, cl);
  col *= mix(1., .52, cs);
  vec4 f = texture(uField, uv);
  float idist = f.b;
  if (uLayer < .5) {
    float floorM = 1. - canopy;
    float lit = smoothstep(.05, .25, luma(col));
    float rim = smoothstep(-90., -10., f.r) * smoothstep(40., -5., f.r);
    float dap = vnoise(p * .06 + wd * t * .35 + vec2(vnoise(p * .02 + t * .1)) * 1.5);
    col *= 1. + floorM * lit * (.3 + rim * .5) * (smoothstep(.3, .7, dap) - .5) * 1.3;
    float dark = 1. - smoothstep(.006, .035, luma(col));
    if (dark > 0.01) {
      vec2 g = floor(p / 28.);
      vec3 hh = hash32(g + uSeed);
      vec2 fp = (g + .5 + .35 * vec2(sin(t * (.4 + hh.x) + hh.y * 6.), cos(t * (.3 + hh.y) + hh.x * 6.))) * 28.;
      vec2 dd = p - fp; float d2 = dot(dd, dd);
      float pulse = pow(max(0., sin(t * (.8 + hh.z) + hh.x * 30.)), 6.);
      col += vec3(.7, 1., .28) * (exp(-d2 * .8) * 8. + exp(-d2 * .05) * .3) * pulse * dark * step(.72, hh.z);
    }
    outColor = vec4(col, 1.);
  } else {
    float A = canopy;
    vec3 C = col * A;
    float open = 0.;
    for (int k = 1; k <= 6; k++) { vec2 q = p + L2 * float(k) * 16.; open += 1. - smoothstep(.02, .2, texture(uCache, toUv(q)).a); }
    open /= 6.;
    float streak = vnoise(vec2(dot(p, vec2(-L2.y, L2.x)) * .05, dot(p, L2) * .008 - t * .04));
    streak = smoothstep(.3, .9, streak) * smoothstep(.3, .8, vnoise(p * .006 + t * .03));
    open = open * (1. - open) * 3.2 + open * .12;
    float calm = mix(.25, 1., smoothstep(0., 50., idist));
    float shaft = open * (1. - canopy * .75) * streak * calm * (1. - cs * .85);
    C += vec3(1., .80, .48) * shaft * .075;
    vec2 g = floor(p / 18.);
    vec3 hh = hash32(g + uSeed * 1.7 + 50.);
    vec2 mp = (g + .5 + .4 * vec2(sin(t * .3 + hh.x * 6.28), sin(t * .23 + hh.y * 6.28))) * 18.;
    vec2 md = p - mp; float d2 = dot(md, md);
    float tw = .5 + .5 * sin(t * (2. + hh.z * 3.) + hh.x * 40.);
    C += vec3(1., .85, .6) * exp(-d2 * 1.1) * 2.6 * tw * open * step(.8, hh.z) * smoothstep(4., 24., idist) * (1. - canopy) * (1. - cs * .7);
    vec2 mq = p * .0013 + vec2(t * .012, t * .005) + uSeed;
    float mn = fbm(mq + .6 * vec2(fbm(mq * 1.7 + t * .008, 3), 0.), 5);
    float mist = smoothstep(.55, .92, mn) * .24;
    mist *= mix(.3, 1., smoothstep(0., 90., idist));
    float rev = smoothstep(0., .5, uIntro * 1.6 - fbm(p * .004 + 3., 4) * .7 - smoothstep(0., 400., idist) * .4);
    mist = mix(.92, mist, rev);
    vec3 mistC = vec3(.66, .62, .50) * (1. - cs * .45);
    C = C * (1. - mist) + mistC * mist;
    A = A * (1. - mist) + mist;
    float hz = .045;
    C = C * (1. - hz) + vec3(.5, .42, .28) * hz; A = A * (1. - hz) + hz;
    outColor = vec4(C, A);
  }
}`;

  /* ---------------------------------------------------------------- sprites */
  function ell(g, x, y, rx, ry, fill) { g.fillStyle = fill; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.fill(); }
  function rrect(g, x, y, w, h, r, fill) { g.fillStyle = fill; g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); g.fill(); }
  function drawBike(g, w, h, imp) {
    const cy = h / 2;
    const hull = imp ? '#d9d9d4' : '#77704c', hullD = imp ? '#8d8d88' : '#4b4631', dark = '#1e1c18';
    g.lineCap = 'round'; g.lineJoin = 'round';
    // steering booms and front vanes
    g.strokeStyle = imp ? '#a4a49f' : '#565036'; g.lineWidth = h * 0.06;
    g.beginPath(); g.moveTo(w * 0.56, cy - h * 0.07); g.lineTo(w * 0.92, cy - h * 0.13); g.moveTo(w * 0.56, cy + h * 0.07); g.lineTo(w * 0.92, cy + h * 0.13); g.stroke();
    rrect(g, w * 0.87, cy - h * 0.44, w * 0.09, h * 0.32, 4, hull); rrect(g, w * 0.87, cy + h * 0.12, w * 0.09, h * 0.32, 4, hull);
    rrect(g, w * 0.885, cy - h * 0.40, w * 0.02, h * 0.24, 2, hullD); rrect(g, w * 0.885, cy + h * 0.16, w * 0.02, h * 0.24, 2, hullD);
    // rear fins
    g.fillStyle = hullD;
    g.beginPath(); g.moveTo(w * 0.06, cy - h * 0.12); g.lineTo(w * 0.1, cy - h * 0.42); g.lineTo(w * 0.2, cy - h * 0.38); g.lineTo(w * 0.22, cy - h * 0.12); g.fill();
    g.beginPath(); g.moveTo(w * 0.06, cy + h * 0.12); g.lineTo(w * 0.1, cy + h * 0.42); g.lineTo(w * 0.2, cy + h * 0.38); g.lineTo(w * 0.22, cy + h * 0.12); g.fill();
    // engine block and hull
    ell(g, w * 0.24, cy, w * 0.17, h * 0.27, hullD);
    ell(g, w * 0.24, cy, w * 0.155, h * 0.22, hull);
    ell(g, w * 0.46, cy, w * 0.22, h * 0.15, hull);
    ell(g, w * 0.64, cy, w * 0.07, h * 0.09, hullD);
    ell(g, w * 0.07, cy - h * 0.1, w * 0.03, h * 0.07, dark); ell(g, w * 0.07, cy + h * 0.1, w * 0.03, h * 0.07, dark);
    // highlight
    const lg = g.createLinearGradient(0, cy - h * 0.25, 0, cy + h * 0.25);
    lg.addColorStop(0, 'rgba(255,255,255,0.35)'); lg.addColorStop(0.5, 'rgba(255,255,255,0.05)'); lg.addColorStop(1, 'rgba(0,0,0,0.3)');
    g.fillStyle = lg; g.beginPath(); g.ellipse(w * 0.36, cy, w * 0.3, h * 0.22, 0, 0, TAU); g.fill();
    // rider: arms, shoulders, helmet
    g.strokeStyle = imp ? '#1d1d1d' : '#3f4a2b'; g.lineWidth = h * 0.09;
    g.beginPath(); g.moveTo(w * 0.37, cy - h * 0.2); g.lineTo(w * 0.53, cy - h * 0.11); g.moveTo(w * 0.37, cy + h * 0.2); g.lineTo(w * 0.53, cy + h * 0.11); g.stroke();
    ell(g, w * 0.35, cy, w * 0.065, h * 0.3, imp ? '#1b1b1b' : '#4b5833');
    if (imp) { ell(g, w * 0.355, cy - h * 0.17, w * 0.04, h * 0.1, '#e9e9e5'); ell(g, w * 0.355, cy + h * 0.17, w * 0.04, h * 0.1, '#e9e9e5'); }
    else { ell(g, w * 0.33, cy - h * 0.1, w * 0.025, h * 0.08, '#36402a'); ell(g, w * 0.37, cy + h * 0.14, w * 0.025, h * 0.07, '#5e6b3e'); }
    ell(g, w * 0.395, cy, w * 0.05, h * 0.15, imp ? '#ededea' : '#56593a');
    ell(g, w * 0.385, cy - h * 0.04, w * 0.02, h * 0.05, 'rgba(255,255,255,0.4)');
  }
  function defineSprites(atlas) {
    atlas.define('bikeR', 192, 64, (g, w, h) => drawBike(g, w, h, false));
    atlas.define('bikeI', 192, 64, (g, w, h) => drawBike(g, w, h, true));
    atlas.define('puff', 64, 64, (g, w, h) => {
      const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.45, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
    });
    atlas.define('chunk', 16, 16, (g, w, h) => {
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(2, 5); g.lineTo(9, 1); g.lineTo(15, 7); g.lineTo(11, 15); g.lineTo(3, 12); g.fill();
    });
    atlas.define('atHead', 128, 128, (g, w, h) => {
      const c = h / 2;
      // cheek guns
      rrect(g, w * 0.3, c - h * 0.42, w * 0.55, h * 0.08, 4, '#4c4c48'); rrect(g, w * 0.3, c + h * 0.34, w * 0.55, h * 0.08, 4, '#4c4c48');
      // chin guns
      rrect(g, w * 0.8, c - h * 0.13, w * 0.19, h * 0.06, 3, '#3a3a37'); rrect(g, w * 0.8, c + h * 0.07, w * 0.19, h * 0.06, 3, '#3a3a37');
      // body
      g.fillStyle = '#8c8c86'; g.beginPath();
      g.moveTo(w * 0.12, c - h * 0.32); g.lineTo(w * 0.7, c - h * 0.34); g.lineTo(w * 0.86, c - h * 0.18); g.lineTo(w * 0.86, c + h * 0.18); g.lineTo(w * 0.7, c + h * 0.34); g.lineTo(w * 0.12, c + h * 0.32); g.closePath(); g.fill();
      const lg = g.createLinearGradient(0, c - h * 0.34, 0, c + h * 0.34);
      lg.addColorStop(0, 'rgba(255,255,255,0.28)'); lg.addColorStop(1, 'rgba(0,0,0,0.35)'); g.fillStyle = lg; g.fill();
      g.strokeStyle = '#55554f'; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(w * 0.3, c - h * 0.32); g.lineTo(w * 0.3, c + h * 0.32); g.moveTo(w * 0.7, c - h * 0.34); g.lineTo(w * 0.7, c + h * 0.34);
      g.moveTo(w * 0.3, c); g.lineTo(w * 0.7, c); g.stroke();
      // front viewport slits
      rrect(g, w * 0.76, c - h * 0.15, w * 0.05, h * 0.1, 2, '#141414'); rrect(g, w * 0.76, c + h * 0.05, w * 0.05, h * 0.1, 2, '#141414');
      // top hatch
      ell(g, w * 0.45, c, w * 0.11, h * 0.11, '#70706b'); ell(g, w * 0.45, c, w * 0.08, h * 0.08, '#9a9a94');
      ell(g, w * 0.43, c - h * 0.02, w * 0.03, h * 0.03, 'rgba(255,255,255,0.4)');
    });
    atlas.define('strut', 64, 16, (g, w, h) => {
      rrect(g, 0, 2, w, h - 4, 6, '#55554f'); rrect(g, 4, 5, w - 8, 3, 2, '#7a7a74');
      ell(g, 7, h / 2, 6, 6, '#3f3f3b'); ell(g, w - 7, h / 2, 6, 6, '#3f3f3b');
    });
    atlas.define('foot', 32, 32, (g, w, h) => {
      g.fillStyle = '#4e4e49'; g.beginPath(); g.moveTo(4, 10); g.lineTo(28, 3); g.lineTo(30, 16); g.lineTo(28, 29); g.lineTo(4, 22); g.closePath(); g.fill();
      g.fillStyle = '#6a6a64'; g.fillRect(8, 13, 14, 6);
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
  function bez(a, c1, c2, b, t) {
    const u = 1 - t;
    return { x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y };
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
    const e = { a, b, pts, cum, len: cum[cum.length - 1] };
    a.edges.push(e); b.edges.push(e); G.edges.push(e);
    if (a.exit || b.exit) G.exitEdges.push(e);
    return e;
  }
  function buildGraph(ctx) {
    const W = ctx.W, H = ctx.H, rng = ctx.rng(4242);
    const sp = 200, G = { nodes: [], edges: [], exitEdges: [] };
    for (let gy = 0; gy * sp < H + sp; gy++) for (let gx = 0; gx * sp < W + sp; gx++) {
      const x = (gx + 0.15 + rng() * 0.7) * sp - sp * 0.2, y = (gy + 0.15 + rng() * 0.7) * sp - sp * 0.2;
      if (rng() < 0.1) continue;
      if (x < 24 || y < 24 || x > W - 24 || y > H - 24) continue;
      if (ctx.distAt(x, y) < 44) continue;
      G.nodes.push({ x, y, edges: [], exit: false });
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
        const pts = makePath(ctx, n, o, rng);
        if (pts) addEdge(G, n, o, pts);
      }
    }
    for (const n of inner) {
      const dl = n.x, dr = W - n.x, dt = n.y, db = H - n.y, m = Math.min(dl, dr, dt, db);
      if (m > sp * 1.05 || rng() < 0.3) continue;
      const j = (rng() - 0.5) * sp * 0.5;
      const ex = m === dl ? { x: -70, y: n.y + j } : m === dr ? { x: W + 70, y: n.y + j } : m === dt ? { x: n.x + j, y: -70 } : { x: n.x + j, y: H + 70 };
      const node = { x: ex.x, y: ex.y, edges: [], exit: true };
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

  /* ---------------------------------------------------------------- vehicles */
  const tmp = { x: 0, y: 0, ang: 0 };
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
      x: 0, y: 0, ang: 0, ph: r() * TAU, puffT: 0, hist: [], fireT: 0, boost: 1 };
    edgePos(e, u, tmp); b.x = tmp.x; b.y = tmp.y; b.ang = b.m.ang = tmp.ang + (dir < 0 ? Math.PI : 0);
    return b;
  }
  function spawnWalker() {
    const G = st.graph, r = st.rng;
    if (!G) return null;
    const inner = G.edges.filter(e => !e.a.exit && !e.b.exit);
    if (!inner.length) return null;
    const e = inner[(r() * inner.length) | 0];
    const w = { m: { e, dir: r() < 0.5 ? 1 : -1, u: e.len * (0.2 + r() * 0.6), age: 0, ang: 0 }, phase: 0, x: 0, y: 0, ang: 0, headAng: 0, fireT: 3 + r() * 3, aim: null, burst: 0, alpha: 0 };
    edgePos(e, w.m.u, tmp); w.x = tmp.x; w.y = tmp.y; w.ang = w.headAng = w.m.ang = tmp.ang + (w.m.dir < 0 ? Math.PI : 0);
    return w;
  }
  function fire(x, y, ang, dist, color, o = {}) {
    const speed = o.speed || 820, r = st.rng;
    st.bolts.fire(x, y, ang, { speed, len: o.len || 16, color, intensity: o.intensity || 4.5, width: o.width || 1.7, life: Math.max(0.12, dist / speed * (0.8 + r() * 0.45)) });
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
      hunters.push({ kind: hk, temp: true, follow: prey, delay: 0.42 + i * 0.32 + r() * 0.1, alpha: 0, x: prey.x, y: prey.y, ang: prey.ang, fireT: 0.6 + r() * 0.6, puffT: 0, ph: r() * TAU, wob: (r() - 0.5) * 6 });
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

  /* ---------------------------------------------------------------- targets */
  function freeTargets(ctx) {
    for (const k of ['tField', 'tTrail', 'tHi', 'tLo']) { if (st[k]) ctx.freeTarget(st[k]); st[k] = null; }
  }
  function allocTargets(ctx) {
    freeTargets(ctx);
    const hw = Math.max(8, Math.ceil(ctx.W / 2)), hh = Math.max(8, Math.ceil(ctx.H / 2));
    st.tField = ctx.makeTarget(hw, hh, { float: true });
    st.tTrail = ctx.makeTarget(hw, hh, { float: true });
    st.tHi = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true });
    st.tLo = ctx.makeTarget(Math.max(8, ctx.pxW >> 1), Math.max(8, ctx.pxH >> 1), { float: true });
    st.trailDirty = true; st.needHi = true; st.haveLo = false; st.size = ctx.pxW + 'x' + ctx.pxH;
  }
  function drawTrails(ctx) {
    const gl = ctx.gl;
    ctx.bindTarget(st.tTrail);
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
  function renderCache(ctx, target) {
    ctx.fullscreen(st.pField, {}, { uTrail: st.tTrail.tex }, st.tField);
    ctx.fullscreen(st.pCache, { uQ: ctx.P.quality >= 1 ? 1 : 0 }, { uField: st.tField.tex }, target);
  }

  /* ---------------------------------------------------------------- scene */
  Galaxy.register(ID, {
    name: 'Forest moon',
    post: { bloom: 0.55, threshold: 1.1, knee: 0.6, exposure: 1.08, vignette: 0.4, grain: 0.02, aberration: 0.0008, tint: [1.05, 1.0, 0.9], lift: [0.004, 0.003, 0.0], saturation: 1.08, bloomRadius: 1.1 },

    init(ctx) {
      st = { rng: ctx.rng(77), bikes: [], dust: [], smoke: [], chunks: [], booms: [], birds: [], walker: null, chase: null,
        chaseT: 3, birdT: 2.5, spawnT: 0, frame: 0, graph: null, trailDirty: true, needHi: true, haveLo: false, useLo: false };
      st.pField = ctx.program(FIELD_FS);
      st.pCache = ctx.program(CACHE_FS);
      st.pView = ctx.program(VIEW_FS);
      defineSprites(ctx.atlas);
      st.bolts = new ctx.Bolts();
    },

    resize(ctx) {
      if (st.size !== ctx.pxW + 'x' + ctx.pxH || !st.tHi) allocTargets(ctx);
    },

    layout(ctx) {
      st.graph = buildGraph(ctx);
      st.trailDirty = true; st.needHi = true;
      st.bikes = []; st.chase = null; st.walker = null;
      const n = Math.round(ctx.P.traffic * 9 * Math.sqrt(ctx.W * ctx.H / (1920 * 1080)));
      for (let i = 0; i < n; i++) { const b = spawnBike(ctx, false); if (b) { b.alpha = 1; b.fadeIn = false; st.bikes.push(b); } }
    },

    update(ctx) {
      const dt = ctx.dt, t = ctx.t, r = st.rng, P = ctx.P, W = ctx.W, H = ctx.H;
      if (!st.graph) return;
      // traffic
      const want = Math.round(P.traffic * 9 * Math.sqrt(W * H / (1920 * 1080)));
      const normal = st.bikes.filter(b => !b.temp && !b.out);
      st.spawnT -= dt;
      if (normal.length < want && st.spawnT <= 0) { const b = spawnBike(ctx, r() < 0.65); if (b) st.bikes.push(b); st.spawnT = 0.5 + r() * 1.2; }
      if (normal.length > want) { const b = normal.find(x => x !== (st.chase && st.chase.prey)); if (b) b.out = true; }
      for (const b of st.bikes) {
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
          b.m.ang = angLerp(b.m.ang, ta, Math.min(1, dt * 14));
          const wob = Math.sin(b.m.age * 2.1 + b.ph) * 2.2;
          b.x = tmp.x - Math.sin(b.m.ang) * wob; b.y = tmp.y + Math.cos(b.m.ang) * wob; b.ang = b.m.ang;
          if (b.fadeIn) { b.alpha = Math.min(1, b.alpha + dt * 1.5); if (b.alpha >= 1) b.fadeIn = false; }
          if (b.out) { b.alpha -= dt * 1.2; if (b.alpha <= 0) b.dead = true; }
          b.hist.push({ t, x: b.x, y: b.y, ang: b.ang });
          while (b.hist.length > 2 && b.hist[0].t < t - 2.5) b.hist.shift();
        }
        // dust wake
        b.puffT -= dt;
        if (b.puffT <= 0 && b.alpha > 0.2 && dt > 0) {
          b.puffT = 0.035;
          const bx = b.x - Math.cos(b.ang) * 10, by = b.y - Math.sin(b.ang) * 10;
          st.dust.push({ x: bx + (r() - 0.5) * 4, y: by + (r() - 0.5) * 4, vx: -Math.cos(b.ang) * 25 + (r() - 0.5) * 18, vy: -Math.sin(b.ang) * 25 + (r() - 0.5) * 18, age: 0, life: 0.7 + r() * 0.5, s0: 3, s1: 12 + r() * 6, a: 0.16 * b.alpha, c: [0.34, 0.27, 0.18] });
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
              fire(h.x + Math.cos(h.ang) * 12, h.y + Math.sin(h.ang) * 12, a, d, h.kind === 'i' ? RED : GREEN);
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
      if (P.traffic > 0.45) { if (!st.walker) st.walker = spawnWalker(); }
      else if (st.walker) st.walker.out = true;
      const w = st.walker;
      if (w) {
        w.alpha = w.out ? w.alpha - dt * 0.8 : Math.min(1, w.alpha + dt * 0.7);
        if (w.alpha <= 0 && w.out) st.walker = null;
        else {
          const moving = !w.aim;
          const dist = moving ? 14 * dt : 0;
          w.m.age += dt;
          stepMover(w.m, dist, r, false);
          w.phase += dist / 30 * TAU;
          if (!moving) w.phase += (Math.round(w.phase / Math.PI) * Math.PI - w.phase) * Math.min(1, dt * 3);
          edgePos(w.m.e, w.m.u, tmp);
          w.m.ang = angLerp(w.m.ang, tmp.ang + (w.m.dir < 0 ? Math.PI : 0), Math.min(1, dt * 1.5));
          w.x = tmp.x; w.y = tmp.y; w.ang = w.m.ang;
          w.fireT -= dt;
          if (!w.aim && w.fireT <= 0 && P.skirmish > 0) {
            let best = null, bd = 420;
            for (const b of st.bikes) { const d = Math.hypot(b.x - w.x, b.y - w.y); if (d < bd && b.alpha > 0.5) { bd = d; best = b; } }
            w.aim = best ? { b: best, x: best.x, y: best.y } : { x: w.x + Math.cos(w.ang + (r() - 0.5) * 2) * 260, y: w.y + Math.sin(w.ang + (r() - 0.5) * 2) * 260 };
            w.burst = 2 + ((r() * 3) | 0); w.shotT = 0.9;
          }
          let want = w.ang;
          if (w.aim) {
            if (w.aim.b && !w.aim.b.dead) { w.aim.x = w.aim.b.x; w.aim.y = w.aim.b.y; }
            want = Math.atan2(w.aim.y - w.y, w.aim.x - w.x);
            w.shotT -= dt;
            let dd = want - w.headAng; dd = Math.atan2(Math.sin(dd), Math.cos(dd));
            if (w.shotT <= 0 && Math.abs(dd) < 0.15) {
              const ca = Math.cos(w.headAng), sa = Math.sin(w.headAng), d = Math.hypot(w.aim.x - w.x, w.aim.y - w.y);
              for (const s of [-1, 1]) fire(w.x + ca * 12 - sa * 2.2 * s, w.y + sa * 12 + ca * 2.2 * s, w.headAng + (r() - 0.5) * 0.08, d, [1, 0.28, 0.08], { speed: 640, len: 20, intensity: 6, width: 2 });
              w.burst--; w.shotT = 0.35;
              if (w.burst <= 0) { w.aim = null; w.fireT = (3 + r() * 5) * (1.6 - P.skirmish); }
            }
          }
          w.headAng = angLerp(w.headAng, want, Math.min(1, dt * 2.2));
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
          const back = i * 16 + r() * 10, side2 = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 13 + (r() - 0.5) * 8;
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
      if (!st.tHi || st.size !== ctx.pxW + 'x' + ctx.pxH) allocTargets(ctx);
      if (st.trailDirty) drawTrails(ctx);
      if (!ctx.fieldStable) {
        if ((st.frame++ % 2) === 0 || !st.haveLo) { renderCache(ctx, st.tLo); st.haveLo = true; }
        st.useLo = true; st.needHi = true;
      } else if (st.needHi) { renderCache(ctx, st.tHi); st.useLo = false; st.needHi = false; }
      const cache = st.useLo ? st.tLo : st.tHi;
      const wa = st.wind || 0.6, wind = [Math.cos(wa), Math.sin(wa)];
      ctx.fullscreen(st.pView, { uLayer: 0, uWind: wind }, { uCache: cache.tex, uField: st.tField.tex }, null);

      // ground-level dust
      for (const p of st.dust) {
        if (p.age < 0) continue;
        const k = p.age / p.life;
        ctx.sprite('puff', p.x, p.y, { w: p.s0 + (p.s1 - p.s0) * Math.sqrt(k), alpha: p.a * (1 - k) * (1 - k), tint: p.c });
      }
      // walker
      const w = st.walker;
      if (w && w.alpha > 0) {
        const a = w.alpha * intro, ca = Math.cos(w.ang), sa = Math.sin(w.ang), sx = SHD[0], sy = SHD[1];
        const bob = Math.abs(Math.sin(w.phase)) * 0.8;
        const legs = [];
        for (let k = 0; k < 2; k++) {
          const s = k ? 1 : -1, ph = w.phase + k * Math.PI;
          const fwd = Math.sin(ph) * 7.5, lift = Math.max(0, Math.cos(ph)) * (w.aim ? 0 : 1);
          const hip = { x: w.x - ca * 1 - sa * 4.5 * s, y: w.y - sa * 1 + ca * 4.5 * s };
          const foot = { x: w.x + ca * fwd - sa * 6.5 * s, y: w.y + sa * fwd + ca * 6.5 * s };
          const knee = { x: (hip.x + foot.x) / 2 - ca * 5 - sa * 2 * s, y: (hip.y + foot.y) / 2 - sa * 5 + ca * 2 * s };
          legs.push({ hip, foot, knee, lift });
        }
        const strut = (p, q, wd, o) => { const dx = q.x - p.x, dy = q.y - p.y; ctx.sprite('strut', (p.x + q.x) / 2, (p.y + q.y) / 2, Object.assign({ w: Math.hypot(dx, dy) + 2, h: wd, rot: Math.atan2(dy, dx) }, o)); };
        const sh = { tint: [0, 0, 0], flat: 1, alpha: 0.42 * a, bias: 2 };
        for (const L of legs) {
          const ho = 13, ko = 8, fo = L.lift * 3;
          strut({ x: L.hip.x + sx * ho, y: L.hip.y + sy * ho }, { x: L.knee.x + sx * ko, y: L.knee.y + sy * ko }, 3.5, sh);
          strut({ x: L.knee.x + sx * ko, y: L.knee.y + sy * ko }, { x: L.foot.x + sx * fo, y: L.foot.y + sy * fo }, 3, sh);
          ctx.sprite('foot', L.foot.x + sx * fo, L.foot.y + sy * fo, { w: 7, rot: w.ang, tint: [0, 0, 0], flat: 1, alpha: 0.4 * a, bias: 2 });
        }
        ctx.sprite('atHead', w.x + sx * (17 + bob), w.y + sy * (17 + bob), { w: 22, rot: w.headAng, tint: [0, 0, 0], flat: 1, alpha: 0.48 * a, bias: 3 });
        for (const L of legs) {
          const fs = 7 * (1 + L.lift * 0.15);
          ctx.sprite('foot', L.foot.x, L.foot.y, { w: fs, rot: w.ang, alpha: a, tint: [0.5, 0.5, 0.48] });
          strut(L.knee, L.foot, 3, { alpha: a, tint: [0.45, 0.45, 0.43] });
          strut(L.hip, L.knee, 3.6, { alpha: a, tint: [0.5, 0.5, 0.48] });
        }
        ctx.sprite('atHead', w.x - ca * bob * 0.5, w.y - sa * bob * 0.5, { w: 22 * (1 + bob * 0.01), rot: w.headAng, alpha: a, tint: [0.4, 0.4, 0.38] });
      }
      // speeders
      for (const b of st.bikes) {
        const a = b.alpha * intro; if (a <= 0.01) continue;
        const imp = b.kind === 'i';
        ctx.sprite(imp ? 'bikeI' : 'bikeR', b.x, b.y, { w: 27, rot: b.ang, alpha: a, tint: imp ? [0.66, 0.66, 0.63] : [0.55, 0.55, 0.5], shadow: { dx: 3.5, dy: 3, alpha: 0.55, bias: 1.5 } });
      }
      for (const b of st.bikes) {
        const a = b.alpha * intro; if (a <= 0.01) continue;
        ctx.glowDot(b.x - Math.cos(b.ang) * 13, b.y - Math.sin(b.ang) * 13, 2.4, [1, 0.42, 0.14], 2.2 * a, { core: 0.6 });
      }
      for (const c of st.chunks) {
        const k = c.age / c.life;
        ctx.sprite('chunk', c.x, c.y, { w: c.size, rot: c.rot, alpha: 1 - k * k, tint: [0.09, 0.06, 0.04] });
      }
      ctx.flush();

      // canopy over the vehicles, light shafts, motes, mist
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      ctx.fullscreen(st.pView, { uLayer: 1, uWind: wind }, { uCache: cache.tex, uField: st.tField.tex }, null);
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
        ctx.sprite('bird', b.x, b.y, { w: 8, h: 12 * span, rot: b.ang, tint: [0.06, 0.045, 0.035], alpha: intro, shadow: { dx: 28, dy: 23, alpha: 0.25, bias: 3, tint: [0, 0, 0] } });
      }
    },

    dispose(ctx) {
      if (!st) return;
      freeTargets(ctx);
      for (const k of ['pField', 'pCache', 'pView']) if (st[k]) ctx.gl.deleteProgram(st[k].p);
      st = null;
    }
  });
})();
