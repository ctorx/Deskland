// Galaxy scene "pt-empire": the city-planet at night, a calm aerial view straight down through the haze.
// Layers:
//   1. City cache (three render targets, re-rendered only on layout / resize / morph / grow-in): a perspective height-field
//      march through procedural districts. A = lit surface + visible height, B = emission + light id, C = road coordinates.
//      While icons move or the scene grows in, the cache renders at half resolution every 2nd frame. Once the field settles,
//      the full-resolution cache is rebuilt in horizontal strips over a few frames, so no single frame spikes.
//      The desktop icons sit on the crown deck of one monumental tower complex per icon group (blob field).
//   2. Glow pyramid (on cache rebuild): the emission blurred to 1/16 and 1/32 resolution. It lights the canyon haze from below.
//   3. Per-frame composite: traffic rivers flowing along the arterials and avenues, height fog lit by the glow pyramid,
//      drifting haze from a baked tiling noise texture, beacon blinks, lane glow around the icon towers.
//   4. Glows and sprites: streams of air traffic around the icon towers and along skyways, searchlights,
//      transports and cruisers with soft shadows, gunship / droid-fighter skirmishes.
(function () {
  'use strict';
  const ID = 'pt-empire';
  const LANES = [40, 52];
  const K_LEAN = 0.085;        // perspective lean: screen = center + (base - center) * (1 + K * height)
  const MAX_SPEEDERS = 2600;
  const STRIPS = 4;            // full-resolution cache rebuild is spread over this many frames
  const TEX_ROOF = 'assets/galaxy/pt-empire/roof_detail.jpg';

  // Fragment header with three outputs for the city cache
  const HDR_MRT = () => GLSL_COMMON.replace('out vec4 outColor;', 'layout(location=0) out vec4 outColor;\nlayout(location=1) out vec4 outB;\nlayout(location=2) out vec4 outC;');

  /* ====================================================================
     City cache shader
     ==================================================================== */
  const CITY = `
uniform float uK;
uniform vec2 uC;
uniform float uGrow;
uniform float uLow;
uniform sampler2D uTex;
const float HTOP = 1.06;
const float DS = 640.;
const float FLOORS = 16.;
const vec3 SKY = vec3(.016, .026, .042);
const vec3 SODIUM = vec3(1., .5, .17);
const vec3 AMBER = vec3(1., .64, .3);
const vec3 COOLW = vec3(.74, .86, 1.);

struct Bd { float h; float id; vec2 lc; vec2 bx; float kind; float tier; float tiers; float top; float warm; float road; };
// kind: 0 street, 1 gap between buildings, 2 building, 3 icon tower deck, 5 arterial

vec2 C1, C2, S1, S2, MID, NRM;
vec2 sitePos(vec2 c) { return c + .15 + .7 * hash22(c + 17.17); }
void setupDistrict(vec2 p) {
  vec2 off = vec2(uSeed * 1.37, uSeed * .71);
  vec2 q = p / DS + off;
  vec2 n = floor(q); float d1 = 1e9, d2 = 1e9; vec2 s1 = n, s2 = n;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = n + vec2(i, j); vec2 r = sitePos(g) - q; float d = dot(r, r);
    if (d < d1) { d2 = d1; s2 = s1; d1 = d; s1 = g; } else if (d < d2) { d2 = d; s2 = g; }
  }
  C1 = s1; C2 = s2;
  S1 = (sitePos(s1) - off) * DS; S2 = (sitePos(s2) - off) * DS;
  MID = (S1 + S2) * .5; NRM = normalize(S2 - S1 + 1e-4);
}
void distParams(vec2 cid, out float ang, out float bs, out vec2 org, out float dens) {
  float a = hash12(cid + 3.7);
  ang = a < .42 ? 0. : a < .55 ? .7854 : (a - .55) * 1.3 - .3;
  bs = mix(120., 175., hash12(cid + 9.1));
  org = hash22(cid + 1.3) * 500.;
  dens = hash12(cid + 5.5);
}
// 1 where grid line ln is an avenue (every third line)
vec2 isAv(vec2 ln, vec2 cid) { vec2 o = floor(hash22(cid + 4.4) * 3.); return 1. - step(.5, mod(ln + o, 3.)); }
vec2 proj(vec2 p, float h) { return uC + (p - uC) / (1. + uK * h); }

Bd bld(vec2 b) {
  Bd o; o.h = 0.; o.id = 0.; o.lc = vec2(0); o.bx = vec2(1); o.kind = 1.; o.tier = 0.; o.tiers = 1.; o.top = 0.; o.warm = 0.; o.road = 0.;
  float sd = dot(b - MID, NRM);
  vec2 cid = sd > 0. ? C2 : C1;
  o.warm = smoothstep(.5, .85, hash12(cid + 2.2));
  float major = step(hash12(C1 + C2 + 7.7), .42);
  float mw = major > .5 ? 7. + 5. * hash12(C1 + C2 * 1.7) : 4.;
  if (abs(sd) < mw) {
    o.kind = 5.; o.road = major > .5 ? 3. : 2.; o.lc = vec2(sd, dot(b, vec2(-NRM.y, NRM.x))); o.bx = vec2(mw);
  } else {
    float ang, bs, dens; vec2 org; distParams(cid, ang, bs, org, dens);
    vec2 q = rot2(ang) * (b - org);
    vec2 ln = floor(q / bs + .5), dq = q - ln * bs;
    vec2 av = isAv(ln, cid);
    vec2 sw = mix(vec2(2.2), vec2(5.5), av);
    vec2 rq = abs(dq) / sw;
    if (min(rq.x, rq.y) < 1.) {
      bool xs = rq.x < rq.y;
      o.kind = 0.; o.road = (xs ? av.x : av.y) > .5 ? 2. : 1.;
      o.lc = xs ? vec2(dq.x, q.y) : vec2(dq.y, q.x); o.bx = vec2(xs ? sw.x : sw.y);
      o.id = hash12((xs ? vec2(ln.x, .5) : vec2(.5, ln.y)) + cid * 3.1);
    } else {
      vec2 cell = floor(q / bs), f = q - cell * bs;
      vec2 lo = mix(vec2(2.2), vec2(5.5), isAv(cell, cid)), hi = bs - mix(vec2(2.2), vec2(5.5), isAv(cell + 1., cid));
      float id = hash12(cell * 1.31 + cid * 13.1);
      for (int i = 0; i < 4; i++) {
        vec2 sz = hi - lo; if (max(sz.x, sz.y) < 36.) break;
        float r1 = hash12(vec2(id * 71.3, float(i) + .5));
        bool sx = sz.x > sz.y * 1.25 ? true : (sz.y > sz.x * 1.25 ? false : r1 < .5);
        float t = mix(.3, .7, hash12(vec2(id * 37.1, float(i) + 7.)));
        if (sx) { float m = mix(lo.x, hi.x, t); if (f.x < m) { hi.x = m; id = hash12(vec2(id * 91.7, 1.3)); } else { lo.x = m; id = hash12(vec2(id * 91.7, 2.9)); } }
        else { float m = mix(lo.y, hi.y, t); if (f.y < m) { hi.y = m; id = hash12(vec2(id * 91.7, 3.7)); } else { lo.y = m; id = hash12(vec2(id * 91.7, 4.1)); } }
      }
      float ag = .8 + 1.4 * hash12(vec2(id, 8.3));
      vec2 ctr = (lo + hi) * .5, hs = (hi - lo) * .5 - ag, lc = f - ctr;
      o.id = id;
      if (any(greaterThan(abs(lc), hs))) { o.kind = 1.; o.lc = lc; o.bx = hs; }
      else {
        vec2 cs = org + rot2(-ang) * (cell * bs + ctr);
        float r = hash12(vec2(id, 4.1));
        float h = .05 + .30 * pow(r, 1.8);
        float dn = vnoise(cs * .0016 + uSeed * 3.);
        h *= .6 + 1.1 * dn * dn + .25 * dens;
        // a few monumental towers in the dense districts
        float mon = step(.972, hash12(vec2(id, 19.))) * step(.35, dens);
        h = mix(h, .6 + .22 * r, mon);
        // the icon tower complex: the ordinary buildings inside the merged blob rise into tall towers
        float bb = iconBlob(uC + (cs - uC) * (1. + uK * .85));
        float boost = smoothstep(260., 0., bb);
        h = mix(h, max(h, .46 + .3 * r), boost * boost);
        if (bb < 0.) h = max(h, .6 + .22 * r);
        h = min(h, .92);
        float dl = hash12(vec2(id, 6.6)) * .35 + clamp(bb / 1100., 0., .4);
        h *= max(smoothstep(dl, dl + .3, uGrow), .012);
        float r3 = hash12(vec2(id, 2.2)), r4 = hash12(vec2(id, 3.3));
        float tiers = (h > .42 && r3 > .2) ? 3. : (h > .18 && r3 > .4) ? 2. : 1.;
        vec2 off = (hash22(vec2(id, 5.)) - .5) * hs * .3;
        vec2 bx = hs, l = lc; float H = h, tier = 0.;
        if (tiers > 1.) {
          H = h * (tiers > 2. ? .62 : .74);
          vec2 hs2 = hs * mix(.55, .8, r4);
          if (all(lessThan(abs(lc - off), hs2))) {
            tier = 1.; bx = hs2; l = lc - off; H = tiers > 2. ? h * .84 : h;
            if (tiers > 2.) { vec2 hs3 = hs2 * mix(.45, .68, r3); if (all(lessThan(abs(l), hs3))) { tier = 2.; bx = hs3; H = h; } }
          }
        }
        o.kind = 2.; o.h = H; o.lc = l; o.bx = bx; o.tier = tier; o.tiers = tiers; o.top = h;
      }
    }
  }
  // Icon tower deck: hugs the icon cells and lands exactly under them at the top height
  float hp = smoothstep(0., .5, uGrow);
  if (hp > o.h) {
    vec2 rp = uC + (b - uC) * (1. + uK * hp);
    float bl = iconBlob(rp);
    float dk = max(bl, iconDist(rp) - 20.);
    if (dk < 0.) { o.h = hp; o.kind = 3.; o.lc = rp; o.bx = vec2(dk, bl); o.top = hp; o.id = .5; }
  }
  return o;
}

// Facade: dark walls, windows lit in groups (a few windows on one floor), cool crown bands on the monumental towers
void facade(float along, float la, float bxa, float hw, float top, float id, float face, float warm, bool mon, vec2 p, out vec3 col, out vec3 em, out float eid, out float wm) {
  float rowPx = length(p - uC) * uK / FLOORS;
  float fl = hw * FLOORS; float row = floor(fl), rf = fract(fl);
  col = SKY * (.25 + .35 * face) * (.5 + .9 * hw);
  col *= 1. + .3 * smoothstep(.9, .97, rf) * smoothstep(1., 2., rowPx);
  float cw = 3.4;
  float cx = floor(along / cw), cf = fract(along / cw);
  float win = smoothstep(.14, .26, cf) * smoothstep(.86, .74, cf) * smoothstep(.18, .34, rf) * smoothstep(.82, .66, rf);
  win = mix(.4, win, smoothstep(1.6, 3.2, rowPx));
  wm = win;
  float seg = floor(along / (cw * 5.));
  // whole buildings are either busy or mostly dark, and lit windows come in groups on a floor
  float busy = step(hash12(vec2(id, 2.)), .12 + .45 * warm);
  float occ = busy > .5 ? .55 + .3 * warm : .05;
  float gh = hash12(vec2(seg, row) + id * 113.7);
  float lit = step(gh, occ);
  float pr = hash12(vec2(id, 7.));
  vec3 wc = pr < .62 ? AMBER : pr < .9 ? COOLW * .85 : mix(AMBER, COOLW, .5);
  float inten = (.25 + .45 * warm) * (.55 + .8 * hash12(vec2(seg, row * 3.1) + id));
  em = wc * win * lit * inten * (.6 + .4 * hw / max(top, .01));
  eid = .01 + .44 * gh;
  if (mon) {
    // monumental tower: vertical light piers rising to a bright crown band
    float pm = abs(fract(along / 8.) - .5) * 8.;
    float pier = smoothstep(.75, .2, pm) * smoothstep(top * .35, top, hw);
    em += COOLW * pier * .7;
    float band = smoothstep(.045, .03, top - hw) * smoothstep(top - .004, top - .012, hw);
    em = mix(em, COOLW * (1.2 + .6 * win), band);
    eid = .003;
  }
}

void main() {
  vec2 p = cssPos();
  setupDistrict(p);
  float hPrev = HTOP, hh = 0.; Bd I;
  const int N = 44;
  for (int i = 1; i <= N; i++) {
    hh = HTOP * (1. - float(i) / float(N));
    I = bld(proj(p, hh));
    if (I.h >= hh) break;
    hPrev = hh;
  }
  vec3 col = vec3(0), em = vec3(0); float eid = 0., hs = 0.;
  vec4 cOut = vec4(0);
  Bd R = bld(proj(p, I.h));
  if (R.h >= I.h - .002) {
    // ------------------------------------------------ roof or ground
    hs = R.h;
    vec2 l = R.lc, bx = R.bx;
    if (R.kind == 2.) {
      float h = R.h, id = R.id;
      float e = min(bx.x - abs(l.x), bx.y - abs(l.y));
      float r = hash12(vec2(id, 11. + R.tier));
      vec2 g = l + bx;
      vec3 tx = texture(uTex, (g + hash22(vec2(id, R.tier)) * 300.) / 150.).rgb;
      float metal = step(.55, hash12(vec2(id, 12.)));
      float det = mix(tx.r, tx.g, metal) - .5, seam = (tx.b - .5) * metal;
      float alb = mix(.6, 1., r) * (1. + det * .8 + seam * .7);
      col = SKY * alb * (.95 + 1.1 * h);
      col *= 1. + .8 * smoothstep(1.2, .2, e);
      col *= .78 + .22 * smoothstep(.6, 3., e);
      if (R.tier < R.tiers - 1.) col *= .8;
      // rooftop machinery: low boxes with soft shadows
      vec2 gc = floor(g / 5.), gf = fract(g / 5.);
      float gh = hash12(gc + id * 31.);
      if (e > 2.4 && gh > .74) {
        vec2 bsz = vec2(.16) + .2 * hash22(gc + id);
        float sb = sdBox(gf - .5, bsz);
        col = mix(col, col * 1.6, smoothstep(.04, -.02, sb));
        col *= 1. - .35 * smoothstep(.12, 0., sdBox(gf - .5 - vec2(.08, .1), bsz)) * step(0., sb);
      }
      // day data: albedo (light-independent), surface 0 = roof, metal flag and hue in z
      cOut = vec4(col.b / SKY.b / (.95 + 1.1 * h) / max(alb, .05) * mix(.6, 1., r) * (1. + det * .3 + seam * .45) * .4, 0., metal * .5 + r * .49, -1.);
      float mn = min(bx.x, bx.y);
      bool topTier = R.tier == R.tiers - 1.;
      bool mon = R.top > .56 && topTier && hash12(vec2(id, 23.)) < .2;
      if (mon) {
        // monumental crown: a cool white light line along the parapet, the roof washed by it
        float par = smoothstep(.9, .25, e);
        em += COOLW * par * 2.4;
        col += COOLW * .01 * smoothstep(5., 0., e);
        eid = .003;
        if (R.top > .63) {
          float cd = length(bx - abs(l) - 1.3);
          if (cd < 1.3) { em = vec3(1., .07, .03) * 10. * smoothstep(1.3, .4, cd); eid = .5 + .5 * hash12(vec2(id, 9.)); }
        }
      } else if (mn > 14. && r > .965 && topTier) {
        // landing pad
        float d = length(l), rr = mn * .74;
        col = mix(col, SKY * 1.4 * (.7 + h), smoothstep(rr + .5, rr - .5, d));
        float ring = smoothstep(.6, .1, abs(d - rr * .86));
        cOut.r = mix(cOut.r, .13, smoothstep(rr + .5, rr - .5, d)) + ring * .25;
        em += AMBER * ring * .12;
        eid = .003;
      }
    } else if (R.kind == 3.) {
      // icon tower crown deck: calm dark plating under the icons, a raised crown band with a cool rim light
      vec2 rp = l; float dk = bx.x;
      vec3 tx = texture(uTex, rp / 240.).rgb;
      vec3 c = SKY * (.9 + (tx.g - .5) * .3);
      vec2 gg = abs(fract(rp / 24.) - .5) * 24.;
      c *= 1. - .22 * smoothstep(.7, .1, min(gg.x, gg.y)) * smoothstep(-12., -16., dk);
      float crown = smoothstep(-9.6, -8.6, dk);
      c = mix(c, SKY * 1.9 * (1. + (tx.r - .5) * .8), crown);
      c *= 1. - .5 * smoothstep(1.6, 0., abs(dk + 9.2));
      em = COOLW * 1.5 * smoothstep(1.3, .2, abs(dk + .7));
      em += COOLW * .35 * smoothstep(.7, .1, abs(dk + 9.9));
      vec2 lg = (fract(rp / 11.) - .5) * 11.;
      em += AMBER * smoothstep(.9, .35, length(lg)) * smoothstep(1.4, .5, abs(dk + 4.6)) * 1.1;
      eid = .003;
      col = c;
      cOut = vec4(c.b / SKY.b * .085, 0., 0., -1.);
    } else {
      // ground: streets, avenues and arterials deep in the canyons
      col = vec3(.004, .005, .007);
      cOut = vec4(.09, 2., 0., -1.);
      if (R.kind == 5.) {
        float s = l.x, mw = bx.x, along = l.y;
        float edge = smoothstep(1.2, .3, abs(abs(s) - mw + .9));
        float mj = R.road > 2.5 ? 1. : .4;
        em = SODIUM * edge * .8 * mj * (.65 + .35 * step(.45, fract(along / 7.)));
        em += AMBER * .06 * mj * smoothstep(mw, mw - 2., abs(s));
        em += COOLW * .25 * mj * smoothstep(.5, .1, abs(s)) * step(.5, fract(along / 5.));
        eid = .003;
        cOut = vec4(mod(along, 1024.), s, mw, R.road);
      } else if (R.kind == 0.) {
        float s = l.x, w = bx.x, along = l.y;
        if (R.road > 1.5) {
          float lamp = smoothstep(.9, .2, length(vec2(abs(s) - w + .8, (fract(along / 9.) - .5) * 9.)));
          em = SODIUM * lamp * .8 + AMBER * .05 * smoothstep(w, w - 1.5, abs(s));
          cOut = vec4(mod(along, 1024.), s, w, 2.);
        } else {
          float lamp = smoothstep(.7, .15, length(vec2(abs(s) - w + .6, (fract(along / 11.) - .5) * 11.))) * step(.4, hash12(vec2(floor(along / 11.), sign(s)) + R.id * 7.));
          em = SODIUM * lamp * .5 * (.12 + .88 * R.warm);
        }
        eid = .003;
      }
    }
  } else {
    // ------------------------------------------------ wall
    float lo = hh, hi = hPrev; Bd Wb = I;
    for (int k = 0; k < 6; k++) { float m = (lo + hi) * .5; Bd t = bld(proj(p, m)); if (t.h >= m) { lo = m; Wb = t; } else hi = m; }
    float hw = lo; hs = hw;
    if (Wb.kind == 3.) {
      // monumental facade of the icon tower: dark stone, cool light piers, a bright trim at the crown
      vec2 u = normalize(p - uC + 1e-3);
      float along = dot(p, vec2(-u.y, u.x));
      col = SKY * .35 * (.5 + .7 * hw);
      float pm = abs(fract(along / 7.) - .5) * 7.;
      float rel = hw / max(Wb.h, .01);
      em = COOLW * smoothstep(.7, .2, pm) * .35 * smoothstep(.25, 1., rel);
      float fl = fract(hw * FLOORS * 1.5);
      em += AMBER * .1 * smoothstep(.3, .5, fl) * smoothstep(.9, .7, fl) * smoothstep(.7, 1.6, pm);
      em += COOLW * 2. * smoothstep(.009, .0, abs(hw - Wb.h + .008));
      eid = .003;
      cOut = vec4(.42, 1., .3 * smoothstep(.7, .2, pm), -1.);
    } else {
      vec2 l = Wb.lc, bx = Wb.bx; vec2 ed = bx - abs(l);
      bool fx = ed.x < ed.y;
      float la = fx ? l.y : l.x, bxa = fx ? bx.y : bx.x;
      float face = fx ? (l.x > 0. ? .3 : 1.) : (l.y > 0. ? .2 : .8);
      bool mon = Wb.top > .56 && hash12(vec2(Wb.id, 23.)) < .2;
      float wm;
      facade(la + Wb.id * 977. + (fx ? 300. : 0.), la, bxa, hw, Wb.top, Wb.id + Wb.tier * .17, face, Wb.warm, mon, p, col, em, eid, wm);
      col *= 1. + .7 * smoothstep(1., .2, bxa - abs(la));
      cOut = vec4((.2 + .16 * hash12(vec2(Wb.id, 31.))) * (1. + .5 * smoothstep(1., .2, bxa - abs(la))), 1., wm * (mon ? .5 : 1.), -1.);
    }
    // street light reflected on the lower facades
    col += AMBER * .01 * pow(1. - clamp(hw / .35, 0., 1.), 2.);
  }
  // ambient occlusion from the neighbouring towers
  vec2 b0 = proj(p, hs);
  float ao = 0.;
  for (int k = 0; k < 4; k++) {
    float a = float(k) * 1.5708 + .785;
    vec2 dv = vec2(cos(a), sin(a));
    Bd t1 = bld(b0 + dv * 6.);
    ao += clamp((t1.h - hs) * 6., 0., 1.) * .6;
    if (uLow < .5) { Bd t2 = bld(b0 + dv * 16.); ao += clamp((t2.h - hs) * 3., 0., 1.) * .4; } else ao += clamp((t1.h - hs) * 3., 0., 1.) * .3;
  }
  col *= 1. - .75 * ao * .25;
  if (cOut.a < 0.) cOut.r *= 1. - .3 * ao;
  col *= .45 + .55 * smoothstep(0., .5, hs);
  outColor = vec4(col, hs);
  outB = vec4(em, eid);
  outC = cOut;
}`;

  /* ====================================================================
     Small passes: tiling haze noise, glow pyramid
     ==================================================================== */
  const NOISE = `
float pn(vec2 p, float P, float k) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  float a = hash12(mod(i, P) + k), b = hash12(mod(i + vec2(1, 0), P) + k), c = hash12(mod(i + vec2(0, 1), P) + k), d = hash12(mod(i + vec2(1, 1), P) + k);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y); }
float pfbm(vec2 uv, float k) { float s = 0., a = .5, P = 5.; for (int i = 0; i < 6; i++) { s += a * pn(uv * P, P, k + float(i) * 13.); P *= 2.; a *= .5; } return s / .984; }
void main() { vec2 uv = gl_FragCoord.xy / uPx; outColor = vec4(pfbm(uv, 1.), pfbm(uv, 71.), pfbm(uv, 143.), 1.); }`;
  const DOWN1 = `
uniform sampler2D uSrc;
void main() { vec2 ts = 1. / vec2(textureSize(uSrc, 0)); vec3 s = vec3(0);
  for (int j = -2; j < 2; j++) for (int i = -2; i < 2; i++) { vec4 t = texture(uSrc, vUv + (vec2(i, j) + .5) * ts); s += t.a >= .5 ? vec3(0) : t.rgb; }
  outColor = vec4(min(s / 16., vec3(3.)), 1.); }`;
  const DOWN2 = `
uniform sampler2D uSrc;
void main() { vec2 t = 1. / vec2(textureSize(uSrc, 0));
  vec3 r = texture(uSrc, vUv).rgb * .125;
  r += (texture(uSrc, vUv + t * vec2(-2, -2)).rgb + texture(uSrc, vUv + t * vec2(2, -2)).rgb + texture(uSrc, vUv + t * vec2(-2, 2)).rgb + texture(uSrc, vUv + t * vec2(2, 2)).rgb) * .03125;
  r += (texture(uSrc, vUv + t * vec2(0, -2)).rgb + texture(uSrc, vUv + t * vec2(-2, 0)).rgb + texture(uSrc, vUv + t * vec2(2, 0)).rgb + texture(uSrc, vUv + t * vec2(0, 2)).rgb) * .0625;
  r += (texture(uSrc, vUv + t * vec2(-1, -1)).rgb + texture(uSrc, vUv + t * vec2(1, -1)).rgb + texture(uSrc, vUv + t * vec2(-1, 1)).rgb + texture(uSrc, vUv + t * vec2(1, 1)).rgb) * .125;
  outColor = vec4(r, 1.); }`;

  /* ====================================================================
     Per-frame composite
     ==================================================================== */
  const MAIN = `
uniform sampler2D uA, uB, uCc, uLA, uLB, uLC, uG0, uG1, uG2, uNoise, uShadow;
uniform float uSplit, uTraffic, uLanes, uSkyN;
uniform vec4 uSky[4];
// time of day and weather (all neutral = the designed night look)
uniform vec2 uC, uDrift, uSunDir;
uniform float uDay, uSunZ, uLights, uRoad, uCloud, uWet, uSnow, uFog, uHazeK;
uniform vec3 uSunCol, uSkyCol, uHaze, uCloudCol;
uniform vec4 uFlash, uPtr;
uniform float uGold, uGlowK;
const float LANES[2] = float[2](${LANES.map(v => v.toFixed(1)).join(',')});
const vec3 AMBER = vec3(1., .64, .3);
const vec3 COOLW = vec3(.74, .86, 1.);
void main() {
  vec2 p = cssPos();
  vec4 A, B, C;
  if (gl_FragCoord.y < uSplit) { A = texture(uA, vUv); B = texture(uB, vUv); C = texture(uCc, vUv); }
  else { A = texture(uLA, vUv); B = texture(uLB, vUv); C = texture(uLC, vUv); }
  float h = A.a;
  vec3 col = A.rgb;
  float eid = B.a, tw = 1.;
  if (eid >= .5) {
    float ph = (eid - .5) * 2.;
    float s = fract(uTime * .45 + ph * 7.);
    tw = smoothstep(0., .04, s) * smoothstep(.22, .1, s) * 1.2 + .04;
  } else if (eid > .005) {
    float r = fract(eid * 173.3);
    if (r < .04) tw = smoothstep(.3, .5, fract(uFlow * .015 * (1. + r * 12.) + r * 31.));
  }
  float dI = iconDist(p);
  float bl = iconBlob(p);
  float dk = max(bl, dI - 20.);
  float wave = smoothstep(0., .25, uIntro * 1.5 - .2 - max(dI, 0.) / 2600. - fract(eid * 91.7) * .2);
  vec3 em = B.rgb * tw * wave;
  vec4 nz = texture(uNoise, p * .00042 + uSeed * .07 + .5);
  float lvl = mix(.35, 1.45, smoothstep(.3, .72, nz.r));
  bool road = C.a > 1.5;
  float surf = road ? 2. : C.g, aux = road ? 0. : C.b;
  float wall = step(.5, surf) * step(surf, 1.5), gnd = step(1.5, surf);
  if (eid > .005 && eid < .5) {
    em *= lvl;
    // windows switch on district by district through dusk and off at dawn
    if (uLights < 1.) em *= smoothstep(0., .1, uLights * 1.12 - fract(eid * 53.17) * .5 - nz.g * .5);
  } else if (eid > .001 && eid < .005 && uRoad < 1.) {
    em *= gnd > .5 ? smoothstep(0., .12, uRoad * 1.15 - nz.b * .8 - .1) : mix(.4, 1., uRoad);
  }

  // traffic rivers along the arterials (class 3) and avenues (class 2)
  if (road && uTraffic > 0.) {
    float s = C.g, w = C.b, art = step(2.5, C.a);
    float laneW = 1.7;
    float side = s < 0. ? -1. : 1.;
    float lane = floor(abs(s) / laneW);
    float inLane = smoothstep(.5, .15, abs(fract(abs(s) / laneW) - .5)) * step(abs(s), w - 1.4) * step(.6, abs(s));
    float spd = (34. + 26. * hash12(vec2(lane, side + C.a))) * (1. + .35 * art);
    float m = C.r - side * spd * uFlow;
    float cell = floor(m / 8.), f = fract(m / 8.);
    float dens = mix(.25, .62, art) * uTraffic;
    float on = step(1. - dens, hash12(vec2(mod(cell, 128.), lane * 7.3 + side * 3.1 + C.a)));
    float car = smoothstep(0., .12, f) * smoothstep(.5, .3, f);
    float head = smoothstep(.25, .45, f) * (side > 0. ? 1. : 0.) + smoothstep(.2, 0., f) * (side > 0. ? 0. : 1.);
    vec3 cc = side > 0. ? mix(vec3(1., .78, .5), vec3(1., .92, .8), head) : mix(vec3(1., .22, .06), vec3(1., .3, .1), head);
    em += cc * on * car * inLane * (1.1 + 1.6 * art) * (.7 + .5 * head) * wave * (1. - .65 * uDay);
  }

  vec2 drift = uDrift;
  vec3 n1 = texture(uNoise, (p + drift) * .00085 + uSeed * .11).rgb;
  vec3 n2 = texture(uNoise, (p - drift * .7) * .0019 + .37).rgb;
  float hz = n1.r * .62 + n2.g * .38;
  vec3 glow = (texture(uG1, vUv).rgb * .45 + texture(uG2, vUv).rgb * .9) * uGlowK;   // city light only as strong as the lights that are on
  float deck = step(dk, 2.);
  float rise = smoothstep(-3., 20., dk + (n2.b - .5) * 26. + (n1.g - .5) * 14.);   // 0 on the deck, 1 a little outside it
  float lit = uDay + uFlash.w;
  float snowCov = uSnow * (1. - wall) * (1. - deck) * mix(1., .5, gnd) * smoothstep(.0, .06, h + gnd);

  if (lit > 0.) {
    // daylight: albedo from the cache, sun with cast shadows, sky ambient reduced deep in the canyons
    float alb = (road ? .085 : C.r) * .62 * mix(1., 2.3 + 1.6 * uCloud + 1.4 * uFog, deck);
    float metal = step(.5, aux) * step(surf, .5), hue = fract(aux * 2.);
    vec3 ac = alb * (metal > .5 ? vec3(.8, .88, 1.) : vec3(1., .975, .95) * (.9 + .2 * hue));
    ac = mix(ac, vec3(.028, .036, .05), wall * aux * .85);      // dark window glass
    ac = mix(ac, vec3(.74, .77, .82) * (.9 + .2 * n2.b), snowCov * .92);
    ac *= 1. - .35 * uWet * (1. - snowCov);
    float sh = texture(uShadow, vUv).r;
    // cloud shadows travel with the cloud deck
    vec3 n3s = texture(uNoise, (p + drift * 2.2 - uSunDir * 90.) * .0006 + vec2(.21, .63)).rgb;
    sh *= 1. - .75 * smoothstep(.5 - .13 * uCloud, .78 - .1 * uCloud, n3s.b * .7 + n2.r * .4) * (.4 + .6 * uCloud);
    // low sun: only the tall tops catch the light, everything below sits in cool shade
    sh *= mix(1., smoothstep(.17, .4, h) * (1. - deck), uGold);
    vec2 rd = normalize(p - uC + 1e-3);
    float ndl = wall > .5 ? sqrt(1. - uSunZ * uSunZ) * max(dot(rd, uSunDir), 0.) * 1.15 + .15 * uSunZ : .38 + .62 * uSunZ;
    float canyon = .3 + .7 * smoothstep(0., .32, h);
    vec3 dayC = ac * (uSkyCol * (wall > .5 ? .6 : 1.) * canyon + uSunCol * ndl * sh);
    dayC += uSkyCol * (wall * aux * .22 + uWet * .14 * (1. - wall) * (.5 + n2.r)) * canyon;
    col = mix(col, dayC, uDay);
    if (uFlash.w > 0.) {
      vec2 fd = p - uFlash.xy;
      float fl = uFlash.w * exp(-dot(fd, fd) / (uFlash.z * uFlash.z)) * (.3 + .7 * smoothstep(20., 160., dI));
      col += (ac + .015) * vec3(.75, .82, 1.) * fl * (.35 + .65 * canyon);
    }
  }
  float night = 1. - uDay;
  if (uSnow > 0.) col += (glow * 1.3 + vec3(.03, .036, .05)) * snowCov * night * (.8 + .4 * n2.b);   // snow glows with the city light
  if (uWet > 0.) {
    // wet roofs and streets mirror the lights, rippled
    vec2 wob = (n2.rg - .5) * vec2(.006, .012);
    vec3 refl = texture(uG0, vUv + wob).rgb * uGlowK;
    col += (refl * .7 + glow * .35) * uWet * (1. - wall) * (1. - deck * .7) * (1. - .75 * uDay) * .55;
  }

  // height fog lit from below by the blurred city light, drifting haze (pale blue aerial haze by day)
  float low = pow(1. - clamp(h, 0., 1.), 3.2);
  float fogA = clamp(low * (.42 + .62 * hz) * uHazeK, 0., .88);
  vec3 fogC = vec3(.004, .009, .016) * (.8 + .5 * hz) + glow * .8;
  fogC = mix(fogC, uHaze * (.82 + .36 * hz) + glow * .08, uDay);
  if (uFog > 0.) {
    // a thick glowing fog bank: the towers and the icon decks rise above it
    float top = .3 + .12 * hz + .06 * n2.b;
    float fl = smoothstep(top + .04, top - .2, h) * (1. - deck);
    fl = mix(fl, max(fl, rise), uDay);   // by day the bank laps right up against the tower crown
    fogA = mix(fogA, .9 + .08 * hz, uFog * fl);
    fogC += (glow * 1.4 + vec3(.01, .012, .016)) * uFog * night + uHaze * .25 * uFog * uDay;
  }
  col = mix(col, fogC, fogA) + em * (1. - fogA * .72);
  // drifting low cloud decks between the camera and the city, lit from below by the city at night, sunlit by day
  vec3 n3 = texture(uNoise, (p + drift * 2.2) * .0006 + vec2(.21, .63)).rgb;
  float cloud = smoothstep(.5 - .13 * uCloud, .78 - .1 * uCloud, n3.b * .7 + n2.r * .4) * mix(smoothstep(20., 90., dI), rise, uDay);
  vec3 ccl = vec3(.010, .016, .026) + glow * .9 * (1. + uCloud * .6);
  ccl = mix(ccl, uCloudCol * (.8 + .35 * n3.g + .2 * n2.b), uDay);
  ccl += vec3(.5, .56, .75) * uFlash.w * exp(-dot(p - uFlash.xy, p - uFlash.xy) / (uFlash.z * uFlash.z * 2.)) * .35;
  col = mix(col, ccl, cloud * (.5 + .3 * uCloud) * (1. - uDay * (.8 - .25 * uCloud)) * (1. - .5 * uGold));
  col += glow * .02 * night;

  // air-lane glow along the blob contours and skyways (it parts around the cursor)
  float blL = bl;
  if (uPtr.z > 0.) {
    vec2 dp = p - uPtr.xy; float r = length(dp) + 1e-3;
    vec2 pl = p - dp / r * 64. * uPtr.z * exp(-r * r / 22500.);
    blL = iconBlob(pl);
  }
  float lane = 0.;
  for (int i = 0; i < 2; i++) { float d = blL - LANES[i]; lane += exp(-d * d / 9.) * (1. - float(i) * .3); }
  float sky = 0.;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uSkyN) break;
    vec4 s = uSky[i]; float d = dot(p - s.xy, vec2(-s.w, s.z));
    sky += exp(-d * d / 40.);
  }
  col += AMBER * (lane * .012 + sky * .014) * uLanes * smoothstep(14., 60., dI);

  // icon tower: a soft cool light dome over the crown and a slow breathing rim
  float plz = smoothstep(.15, .5, uIntro);
  col += COOLW * exp(-max(dk, 0.) / 70.) * step(0., dk) * .012 * plz;
  col += COOLW * exp(-pow((dk + .7) / 1.2, 2.)) * (.15 + .15 * sin(uTime * .7 + p.x * .004)) * plz;
  outColor = vec4(col, 1.);
}`;

  // Sun shadows: march the cached height toward the sun (half resolution, refreshed only when the sun or the cache changes)
  const SHADOW = `
uniform sampler2D uA, uLA;
uniform float uSplit, uFullH, uTanE, uRatio;
uniform vec2 uSunDir;
float hAt(vec2 uv) { return uv.y * uFullH < uSplit ? texture(uA, uv).a : texture(uLA, uv).a; }
void main() {
  vec2 uv = vUv;
  float h0 = hAt(uv);
  vec2 du = vec2(uSunDir.x, -uSunDir.y) / uRes;
  float j = hash12(gl_FragCoord.xy) * .5 + .75;
  float occ = 0., d = 2.5 * j;
  for (int i = 0; i < 14; i++) {
    float hq = hAt(uv + du * d);
    occ = max(occ, smoothstep(.0, .035, hq - h0 - d * uTanE / 1100.) * (1. - float(i) / 20.));
    d *= uRatio;
  }
  outColor = vec4(1. - occ, 0., 0., 1.);
}`;

  /* ====================================================================
     Sprites
     ==================================================================== */
  function hullRandom(g, rng, n, x0, x1, y0, y1, a0, a1) {
    for (let i = 0; i < n; i++) {
      const x = x0 + rng() * (x1 - x0), y = y0 + rng() * (y1 - y0), w = 4 + rng() * 28, hh = 2 + rng() * 10;
      g.fillStyle = rng() < 0.5 ? `rgba(255,255,255,${a0 + rng() * a1})` : `rgba(0,0,0,${a0 + rng() * a1})`;
      g.fillRect(x, y, w, hh);
    }
  }
  function defineSprites(ctx) {
    // Long wedge cruiser, pointing right
    ctx.atlas.define('cruiser', 1200, 440, (g, w, h) => {
      const rng = ctx.rng(901);
      const cy = h / 2;
      const hull = () => { g.beginPath(); g.moveTo(w * .975, cy); g.lineTo(w * .13, cy - h * .45); g.lineTo(w * .07, cy - h * .41); g.lineTo(w * .05, cy - h * .2); g.lineTo(w * .05, cy + h * .2); g.lineTo(w * .07, cy + h * .41); g.lineTo(w * .13, cy + h * .45); g.closePath(); };
      hull(); g.fillStyle = '#8a8e96'; g.fill();
      g.save(); hull(); g.clip();
      // two sloped dorsal halves: lit upper half, shaded lower half
      let gr = g.createLinearGradient(0, cy, 0, cy - h * .45); gr.addColorStop(0, '#d2d5da'); gr.addColorStop(1, '#8c9098');
      g.fillStyle = gr; g.fillRect(0, 0, w, cy);
      gr = g.createLinearGradient(0, cy, 0, cy + h * .45); gr.addColorStop(0, '#80848c'); gr.addColorStop(1, '#4a4e55');
      g.fillStyle = gr; g.fillRect(0, cy, w, cy);
      const grd = g.createLinearGradient(0, 0, w, 0); grd.addColorStop(0, 'rgba(0,0,0,.3)'); grd.addColorStop(.6, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(255,255,255,.06)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
      // panel plating aligned with the hull edges
      for (const sgn of [-1, 1]) {
        g.save(); g.translate(w * .975, cy); g.rotate(sgn * Math.atan2(h * .45, w * .845) + Math.PI);
        for (let i = 0; i < 300; i++) {
          const x = rng() * w * .95, y = sgn > 0 ? -rng() * h * .4 : rng() * h * .4, pw = 6 + rng() * 40, ph = 3 + rng() * 9;
          if (Math.abs(y) > x * .5) continue;
          g.fillStyle = rng() < .5 ? `rgba(255,255,255,${.03 + rng() * .05})` : `rgba(0,0,0,${.04 + rng() * .08})`;
          g.fillRect(x, y, pw, ph);
        }
        g.restore();
      }
      // trench lines parallel to the edges
      g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 2;
      for (const sg of [-1, 1]) for (let k = 1; k <= 4; k++) { const f = k * .18; g.beginPath(); g.moveTo(w * (.975 - f * .25), cy); g.lineTo(w * (.13 + f * .1), cy + sg * h * .45 * (1 - f)); g.stroke(); }
      // red markings toward the bow
      g.fillStyle = '#a3291f';
      for (const sg of [-1, 1]) { g.beginPath(); g.moveTo(w * .955, cy + sg * h * .006); g.lineTo(w * .5, cy + sg * h * .19); g.lineTo(w * .5, cy + sg * h * .225); g.lineTo(w * .955, cy + sg * h * .022); g.fill(); }
      // flight deck doors down the spine
      g.fillStyle = '#2d3036'; g.beginPath(); g.moveTo(w * .9, cy); g.lineTo(w * .42, cy - h * .035); g.lineTo(w * .42, cy + h * .035); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 1.5;
      for (let k = 0; k < 14; k++) { const x = w * (.44 + k * .033); g.beginPath(); g.moveTo(x, cy - h * .03 * (1 - k / 15)); g.lineTo(x, cy + h * .03 * (1 - k / 15)); g.stroke(); }
      g.restore();
      // superstructure, stepped, with shadows to the lower right
      const box = (x, y, bw, bh, c) => { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(x + 7, y + 9, bw, bh); g.fillStyle = c; g.fillRect(x, y, bw, bh); g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x, y, bw, 3); };
      box(w * .1, cy - h * .09, w * .26, h * .18, '#777b83');
      box(w * .13, cy - h * .06, w * .2, h * .12, '#9a9ea5');
      for (const sg of [-1, 1]) {
        box(w * .19, cy + sg * h * .1 - h * .045, w * .07, h * .09, '#b9bdc4');
        g.fillStyle = '#20252c'; g.fillRect(w * .25, cy + sg * h * .1 - h * .03, w * .008, h * .06);
      }
      // engines
      g.fillStyle = '#4a4e55'; g.fillRect(w * .015, cy - h * .3, w * .05, h * .6);
      for (const yy of [-.22, 0, .22]) {
        g.fillStyle = '#1e2126'; g.beginPath(); g.arc(w * .035, cy + yy * h, h * .075, 0, 7); g.fill();
        g.strokeStyle = 'rgba(150,200,255,.85)'; g.lineWidth = 4; g.beginPath(); g.arc(w * .035, cy + yy * h, h * .05, 0, 7); g.stroke();
      }
      hull(); g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 2.5; g.stroke();
    });
    // Republic gunship (top view), pointing right
    ctx.atlas.define('gunship', 400, 240, (g, w, h) => {
      const cy = h / 2, rng = ctx.rng(902);
      g.fillStyle = 'rgba(0,0,0,0)';
      // wings
      for (const s of [-1, 1]) {
        g.fillStyle = '#6e7864';
        g.beginPath(); g.moveTo(w * .58, cy + s * h * .12); g.lineTo(w * .64, cy + s * h * .44); g.lineTo(w * .54, cy + s * h * .46); g.lineTo(w * .43, cy + s * h * .12); g.fill();
        g.fillStyle = '#8b9580'; g.fillRect(w * .5, cy + s * h * .44 - h * .04, w * .17, h * .08);
        g.fillStyle = '#a03a2c'; g.fillRect(w * .62, cy + s * h * .44 - h * .03, w * .05, h * .06);
        // tail fins
        g.fillStyle = '#6e7864';
        g.beginPath(); g.moveTo(w * .22, cy + s * h * .1); g.lineTo(w * .08, cy + s * h * .32); g.lineTo(w * .16, cy + s * h * .32); g.lineTo(w * .3, cy + s * h * .1); g.fill();
      }
      // fuselage
      g.fillStyle = '#8f9a84'; g.beginPath(); g.moveTo(w * .1, cy - h * .1); g.lineTo(w * .82, cy - h * .13); g.quadraticCurveTo(w * .97, cy, w * .82, cy + h * .13); g.lineTo(w * .1, cy + h * .1); g.closePath(); g.fill();
      g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(w * .1, cy, w * .8, h * .13);
      hullRandom(g, rng, 60, w * .15, w * .8, cy - h * .1, cy + h * .08, .05, .1);
      g.fillStyle = '#a03a2c'; g.beginPath(); g.ellipse(w * .86, cy, w * .07, h * .1, 0, 0, 7); g.fill();
      g.fillStyle = '#1d2a33'; g.fillRect(w * .78, cy - h * .05, w * .05, h * .1);
      for (const s of [-1, 1]) { g.fillStyle = '#22313c'; g.beginPath(); g.arc(w * .62, cy + s * h * .15, h * .05, 0, 7); g.fill(); g.fillStyle = 'rgba(180,220,255,.5)'; g.beginPath(); g.arc(w * .615, cy + s * h * .14, h * .018, 0, 7); g.fill(); }
      g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 2; g.strokeRect(w * .35, cy - h * .08, w * .3, h * .16);
    });
    // Boxy cargo shuttle, pointing right
    ctx.atlas.define('shuttle', 320, 200, (g, w, h) => {
      const cy = h / 2, rng = ctx.rng(903);
      for (const s of [-1, 1]) { g.fillStyle = '#5c5a57'; g.fillRect(w * .06, cy + s * h * .3 - h * .1, w * .3, h * .2); g.fillStyle = '#9fc6ff'; g.fillRect(w * .04, cy + s * h * .3 - h * .07, w * .03, h * .14); }
      g.fillStyle = '#a49c8f'; g.beginPath(); g.roundRect(w * .12, cy - h * .3, w * .72, h * .6, 18); g.fill();
      g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(w * .12, cy, w * .72, h * .3);
      g.fillStyle = '#c18a3a'; g.fillRect(w * .2, cy - h * .3, w * .06, h * .6);
      for (let i = 0; i < 4; i++) { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(w * (.32 + i * .12), cy - h * .22, w * .09, h * .44); g.fillStyle = 'rgba(255,255,255,.1)'; g.fillRect(w * (.32 + i * .12), cy - h * .22, w * .09, h * .04); }
      hullRandom(g, rng, 40, w * .14, w * .8, cy - h * .28, cy + h * .25, .04, .08);
      g.fillStyle = '#8c857a'; g.beginPath(); g.ellipse(w * .86, cy, w * .1, h * .2, 0, 0, 7); g.fill();
      g.fillStyle = '#1a2630'; g.beginPath(); g.ellipse(w * .9, cy, w * .045, h * .12, 0, 0, 7); g.fill();
    });
    // Droid fighter: four split blade wings, pointing right
    ctx.atlas.define('droid', 260, 260, (g, w, h) => {
      const cx = w * .48, cy = h / 2;
      const blade = (tx, ty, wd) => {
        const a = Math.atan2(ty - cy, tx - cx), nx = -Math.sin(a), ny = Math.cos(a);
        g.beginPath(); g.moveTo(cx + nx * wd, cy + ny * wd); g.lineTo(tx + nx * 3, ty + ny * 3); g.lineTo(tx - nx * 3, ty - ny * 3); g.lineTo(cx - nx * wd, cy - ny * wd); g.closePath();
      };
      for (const s of [-1, 1]) {
        g.fillStyle = '#6f5a43'; blade(w * .86, cy + s * h * .42, 15); g.fill();
        g.fillStyle = '#5b4835'; blade(w * .18, cy + s * h * .44, 14); g.fill();
        g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 2; blade(w * .86, cy + s * h * .42, 15); g.stroke(); blade(w * .18, cy + s * h * .44, 14); g.stroke();
        g.fillStyle = '#3d2f22'; g.beginPath(); g.arc(w * .84, cy + s * h * .4, 6, 0, 7); g.fill();
      }
      g.fillStyle = '#8b7356'; g.beginPath(); g.moveTo(w * .78, cy); g.lineTo(w * .64, cy - h * .07); g.lineTo(w * .3, cy - h * .08); g.lineTo(w * .24, cy); g.lineTo(w * .3, cy + h * .08); g.lineTo(w * .64, cy + h * .07); g.closePath(); g.fill();
      g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(w * .3, cy, w * .4, h * .07);
      g.fillStyle = '#2b2219'; g.fillRect(w * .66, cy - h * .03, w * .07, h * .06);
    });
    // Smoke puff: a soft lumpy cloud (white, tinted when drawn)
    ctx.atlas.define('puff', 160, 160, (g, w, h) => {
      const rng = ctx.rng(904);
      for (let i = 0; i < 26; i++) {
        const a = rng() * 6.28, r = rng() * w * .2, x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r, rr = w * (.12 + rng() * .16);
        const gr = g.createRadialGradient(x, y, 0, x, y, rr);
        gr.addColorStop(0, `rgba(255,255,255,${.18 + rng() * .12})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }
    });
    // Scorch mark: dark blotch with a ragged edge
    ctx.atlas.define('scorch', 128, 128, (g, w, h) => {
      const rng = ctx.rng(905);
      for (let i = 0; i < 30; i++) {
        const a = rng() * 6.28, r = rng() * w * .22, x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r, rr = w * (.06 + rng() * .14);
        const gr = g.createRadialGradient(x, y, 0, x, y, rr);
        gr.addColorStop(0, 'rgba(20,16,14,.35)'); gr.addColorStop(1, 'rgba(20,16,14,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }
      const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * .2);
      gr.addColorStop(0, 'rgba(8,6,5,.8)'); gr.addColorStop(1, 'rgba(8,6,5,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    // Snow flake seen from above: a soft dot
    ctx.atlas.define('flake', 32, 32, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.45, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    // Rooftop defense battery: round armored base with twin barrels, pointing right
    ctx.atlas.define('battery', 160, 120, (g, w, h) => {
      const cx = w * .4, cy = h / 2;
      g.fillStyle = '#3c4048'; g.beginPath(); g.arc(cx, cy, h * .42, 0, 7); g.fill();
      g.fillStyle = '#6c717a'; g.beginPath(); g.arc(cx, cy, h * .34, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.arc(cx - 4, cy - 5, h * .26, 0, 7); g.fill();
      for (const s of [-1, 1]) { g.fillStyle = '#2a2d33'; g.fillRect(cx, cy + s * h * .12 - 5, w * .58, 10); g.fillStyle = '#8a9099'; g.fillRect(cx, cy + s * h * .12 - 5, w * .58, 3); }
      g.fillStyle = '#1b1e23'; g.beginPath(); g.arc(cx, cy, h * .12, 0, 7); g.fill();
      g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, h * .42, 0, 7); g.stroke();
    });
  }

  /* ====================================================================
     State
     ==================================================================== */
  let progCity = null, progMain = null, progNoise = null, progDown1 = null, progDown2 = null, progShadow = null;
  let shadowT = null, shadowKey = '', shadowStale = true, touched = false;
  let full = null, lowc = null, noiseT = null, g0 = null, g1 = null, g2 = null, roofTex = null;
  let dirty = true, frame = 0, needFinal = false, fullRows = 0, lowValid = false;
  let skyways = [], skyU = new Float32Array(16), searchlights = [], beacons = [], beams = [];
  let cruisers = [], transports = null, fights = [], fightT = 0, bolts = null, booms = [], hits = [];
  const sp = { x: new Float32Array(MAX_SPEEDERS), y: new Float32Array(MAX_SPEEDERS), vx: new Float32Array(MAX_SPEEDERS), vy: new Float32Array(MAX_SPEEDERS),
    tgt: new Float32Array(MAX_SPEEDERS), dir: new Float32Array(MAX_SPEEDERS), spd: new Float32Array(MAX_SPEEDERS), kind: new Int8Array(MAX_SPEEDERS),
    u: new Float32Array(MAX_SPEEDERS), off: new Float32Array(MAX_SPEEDERS), live: new Uint8Array(MAX_SPEEDERS), cool: new Float32Array(MAX_SPEEDERS), n: 0 };

  // Exact distance to the nearest icon rectangle on the CPU (independent of the morph state)
  function iconDistCPU(ctx, x, y) {
    let d = 1e9;
    for (const ic of ctx.icons) {
      const dx = Math.max(ic.x - x, 0, x - ic.x - ic.w), dy = Math.max(ic.y - y, 0, y - ic.y - ic.h);
      const v = Math.hypot(dx, dy); if (v < d) d = v;
    }
    return d;
  }

  // One city cache: three float targets bound to one framebuffer
  function makeSet(ctx, w, h, linear) {
    const gl = ctx.gl;
    const o = { nearest: !linear };
    const A = ctx.makeTarget(w, h, o), B = ctx.makeTarget(w, h, o), C = ctx.makeTarget(w, h, o);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, A.tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, B.tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, C.tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) console.warn('[pt-empire] MRT framebuffer incomplete', st);
    return { A, B, C, t: { fb, w, h } };
  }
  function freeSet(ctx, s) { if (!s) return; ctx.freeTarget(s.A); ctx.freeTarget(s.B); ctx.freeTarget(s.C); ctx.gl.deleteFramebuffer(s.t.fb); }
  function makeCache(ctx) {
    freeCache(ctx);
    const W = ctx.pxW, H = ctx.pxH;
    full = makeSet(ctx, W, H, false);
    lowc = makeSet(ctx, Math.max(2, W >> 1), Math.max(2, H >> 1), true);
    g0 = ctx.makeTarget(Math.max(2, W >> 3), Math.max(2, H >> 3));
    g1 = ctx.makeTarget(Math.max(2, W >> 4), Math.max(2, H >> 4));
    g2 = ctx.makeTarget(Math.max(2, W >> 5), Math.max(2, H >> 5));
    shadowT = ctx.makeTarget(Math.max(2, W >> 1), Math.max(2, H >> 1), { float: false });
    shadowStale = true;
    if (!noiseT) {
      noiseT = ctx.makeTarget(512, 512, { repeat: true });
      ctx.gl.disable(ctx.gl.BLEND);
      ctx.fullscreen(progNoise, {}, {}, noiseT);
    }
    dirty = true; lowValid = false; fullRows = 0;
  }
  function freeCache(ctx) {
    freeSet(ctx, full); freeSet(ctx, lowc);
    [g0, g1, g2, shadowT].forEach(t => t && ctx.freeTarget(t));
    full = lowc = g0 = g1 = g2 = shadowT = null;
  }
  function renderCity(ctx, set, y0, rows) {
    const gl = ctx.gl;
    touched = true;
    gl.disable(gl.BLEND);
    if (rows != null) { gl.enable(gl.SCISSOR_TEST); gl.scissor(0, y0, set.t.w, rows); }
    ctx.fullscreen(progCity, { uK: K_LEAN, uC: [ctx.W / 2, ctx.H / 2], uGrow: ctx.intro, uLow: set === lowc ? 1 : 0 }, { uTex: roofTex }, set.t);
    if (rows != null) gl.disable(gl.SCISSOR_TEST);
  }
  function renderGlow(ctx) {
    ctx.gl.disable(ctx.gl.BLEND);
    ctx.fullscreen(progDown1, {}, { uSrc: lowc.B.tex }, g0);
    ctx.fullscreen(progDown2, {}, { uSrc: g0.tex }, g1);
    ctx.fullscreen(progDown2, {}, { uSrc: g1.tex }, g2);
  }

  function planFeatures(ctx) {
    const rng = ctx.rng(77), W = ctx.W, H = ctx.H;
    // skyways: long straight elevated lanes, chosen to stay clear of the icons
    skyways = [];
    const nS = 2;
    for (let i = 0; i < nS; i++) {
      let best = null, bs = -1e9;
      for (let k = 0; k < 30; k++) {
        const a = (rng() - .5) * 1.1 + (i === 1 ? Math.PI / 2 : 0);
        const s = { x: W * (.25 + .5 * rng()), y: H * (.2 + .6 * rng()), dx: Math.cos(a), dy: Math.sin(a) };
        let bad = 0;
        for (let t = -1500; t <= 1500; t += 50) { const x = s.x + s.dx * t, y = s.y + s.dy * t; if (x < 0 || y < 0 || x > W || y > H) continue; const d = iconDistCPU(ctx, x, y); if (d < 70) bad += 1 + (70 - d) / 20; }
        if (-bad > bs) { bs = -bad; best = s; }
      }
      skyways.push(best);
    }
    skyU.fill(0);
    skyways.forEach((s, i) => { skyU[i * 4] = s.x; skyU[i * 4 + 1] = s.y; skyU[i * 4 + 2] = s.dx; skyU[i * 4 + 3] = s.dy; });
    // searchlights on open ground away from icons
    searchlights = [];
    for (let i = 0, tries = 0; i < 3 && tries < 200; tries++) {
      const x = rng() * W, y = rng() * H;
      if (iconDistCPU(ctx, x, y) < 200) continue;
      if (searchlights.some(s => Math.hypot(s.x - x, s.y - y) < 400)) continue;
      searchlights.push({ x, y, a0: rng() * 6.28, amp: .5 + rng() * .8, w: .08 + rng() * .1, ph: rng() * 6.28, len: 240 + rng() * 160 }); i++;
    }
    // red beacons on the outer corners of the icon decks, and soft light beams rising from a few of them
    beacons = []; beams = [];
    const ics = ctx.icons, seen = new Set();
    const inside = (x, y) => ics.some(ic => x > ic.x - 2 && x < ic.x + ic.w + 2 && y > ic.y - 2 && y < ic.y + ic.h + 2);
    for (const ic of ics) {
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const cx = sx < 0 ? ic.x : ic.x + ic.w, cy = sy < 0 ? ic.y : ic.y + ic.h;
        if (inside(cx + sx * 14, cy + sy * 14) || inside(cx + sx * 14, cy - sy * 14) || inside(cx - sx * 14, cy + sy * 14)) continue;
        const key = Math.round(cx / 8) + ',' + Math.round(cy / 8); if (seen.has(key)) continue; seen.add(key);
        beacons.push({ x: cx + sx * 4, y: cy + sy * 4, ph: ((cx * 0.013 + cy * 0.007) % 1) });
      }
    }
  }

  // Cruiser path: pick the straight line that stays farthest from the icons
  function newCruiser(ctx, c, initial) {
    const W = ctx.W, H = ctx.H, R = Math.hypot(W, H) / 2;
    let best = null, bestS = -1e9;
    for (let k = 0; k < 40; k++) {
      const a = (Math.random() - .5) * 1.2 + (Math.random() < .5 ? 0 : Math.PI);
      const nx = -Math.sin(a), ny = Math.cos(a), off = (Math.random() - .5) * H * 1.05;
      const px = W / 2 + nx * off, py = H / 2 + ny * off;
      let bad = 0, mn = 1e9;
      for (let t = -R; t <= R; t += R / 30) {
        const x = px + Math.cos(a) * t, y = py + Math.sin(a) * t;
        if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
        const d = iconDistCPU(ctx, x, y); mn = Math.min(mn, d);
        if (d < 120) bad += 1 + (120 - d) / 40;
      }
      const sc = -bad + Math.min(mn, 300) * .01;
      if (sc > bestS) { bestS = sc; best = { a, px, py }; }
    }
    c.len = 220 + Math.random() * 120;
    c.spd = 6 + Math.random() * 5;
    c.a = best.a; c.px = best.px; c.py = best.py; c.R = R + c.len;
    c.t = initial ? (Math.random() - .5) * R * 1.3 : -c.R;
    c.alt = .6 + Math.random() * .4;
    c.ph = Math.random() * 10;
  }

  // Air traffic: streams of speeders following the blob contours around the icon towers, and the skyways
  function spawnSpeeder(ctx, i) {
    const W = ctx.W, H = ctx.H;
    sp.live[i] = 0;
    const useSky = skyways.length && (Math.random() < .3 || !ctx.icons.length);
    if (useSky) {
      const k = (Math.random() * skyways.length) | 0, s = skyways[k], R = Math.hypot(W, H) * .6;
      const lane = (Math.random() * 4) | 0, off = [-5.5, -2.2, 2.2, 5.5][lane];
      sp.kind[i] = 1 + k; sp.off[i] = off; sp.dir[i] = off > 0 ? 1 : -1;
      sp.u[i] = (Math.random() * 2 - 1) * R; sp.spd[i] = (lane === 0 || lane === 3 ? 95 : 70) * (.92 + Math.random() * .16);
      sp.live[i] = 1; return;
    }
    for (let tries = 0; tries < 6; tries++) {
      let x = Math.random() * W, y = Math.random() * H;
      const dir = Math.random() < .5 ? 1 : -1;
      const b0 = ctx.blobAt(x, y);
      if (b0 > 160) continue;
      let L = LANES[0]; for (const l of LANES) if (Math.abs(l - b0) < Math.abs(L - b0)) L = l;
      const tgt = L + dir * 2.2;
      let ok = true;
      for (let k = 0; k < 4; k++) {
        const b = ctx.blobAt(x, y), g = ctx.gradAt(x, y, ctx.blobAt), gl = Math.hypot(g[0], g[1]);
        if (gl < .3) { ok = false; break; }
        x -= g[0] / gl * (b - tgt) / gl; y -= g[1] / gl * (b - tgt) / gl;
      }
      if (!ok || Math.abs(ctx.blobAt(x, y) - tgt) > 3 || x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
      sp.kind[i] = 0; sp.x[i] = x; sp.y[i] = y; sp.tgt[i] = tgt; sp.dir[i] = dir; sp.spd[i] = (L === LANES[0] ? 55 : 72) * (.92 + Math.random() * .16); sp.live[i] = 1; sp.vx[i] = 0; sp.vy[i] = 0;
      return;
    }
    sp.cool[i] = .3 + Math.random() * .5;
  }
  function updateSpeeders(ctx) {
    const n = Math.round(MAX_SPEEDERS * ctx.P.traffic), dt = ctx.dt, W = ctx.W, H = ctx.H;
    for (let i = sp.n; i < n; i++) sp.live[i] = 0, sp.cool[i] = Math.random() * .2;
    sp.n = n;
    let spawns = 0;
    for (let i = 0; i < n; i++) {
      if (!sp.live[i]) { sp.cool[i] -= ctx.rawDt; if (sp.cool[i] <= 0 && spawns < 160) { spawns++; spawnSpeeder(ctx, i); } continue; }
      if (sp.kind[i] > 0) {
        const s = skyways[sp.kind[i] - 1]; if (!s) { sp.live[i] = 0; continue; }
        sp.u[i] += sp.dir[i] * sp.spd[i] * dt;
        const R = Math.hypot(W, H) * .6;
        if (Math.abs(sp.u[i]) > R) sp.u[i] = -sp.dir[i] * R;
        sp.x[i] = s.x + s.dx * sp.u[i] - s.dy * sp.off[i]; sp.y[i] = s.y + s.dy * sp.u[i] + s.dx * sp.off[i];
        sp.vx[i] = s.dx * sp.dir[i]; sp.vy[i] = s.dy * sp.dir[i];
        continue;
      }
      const x = sp.x[i], y = sp.y[i], e = 4;
      const b = ctx.blobAt(x, y);
      const gx = (ctx.blobAt(x + e, y) - ctx.blobAt(x - e, y)) / (2 * e), gy = (ctx.blobAt(x, y + e) - ctx.blobAt(x, y - e)) / (2 * e);
      const gl = Math.hypot(gx, gy);
      if (gl < .2 || Math.abs(b - sp.tgt[i]) > 14) { sp.live[i] = 0; sp.cool[i] = .2; continue; }
      const nx = gx / gl, ny = gy / gl, tx = -ny * sp.dir[i], ty = nx * sp.dir[i];
      const corr = (b - sp.tgt[i]) / gl * Math.min(1, dt * 6);
      sp.x[i] = x + tx * sp.spd[i] * dt - nx * corr; sp.y[i] = y + ty * sp.spd[i] * dt - ny * corr;
      sp.vx[i] = sp.vx[i] * .8 + tx * .2; sp.vy[i] = sp.vy[i] * .8 + ty * .2;
      if (sp.x[i] < -20 || sp.y[i] < -20 || sp.x[i] > W + 20 || sp.y[i] > H + 20) { sp.live[i] = 0; sp.cool[i] = .1; }
    }
  }
  function drawSpeeders(ctx) {
    const fade = ctx.sstep(.35, 1, ctx.intro) * (1 - .6 * E.day); if (fade <= 0) return;
    const pk = E.ptr, px = ctx.pointer.x, py = ctx.pointer.y;
    for (let i = 0; i < sp.n; i++) {
      if (!sp.live[i]) continue;
      let x = sp.x[i], y = sp.y[i];
      if (pk > 0) {
        // the lane lights part around the cursor
        const dx = x - px, dy = y - py, r2 = dx * dx + dy * dy;
        if (r2 < 160000) { const r = Math.sqrt(r2) + 1e-3, push = pk * 64 * Math.exp(-r2 / 22500); x += dx / r * push; y += dy / r * push; }
      }
      const d = ctx.distAt(x, y);
      const a = fade * ctx.sstep(8, 48, d); if (a < .02) continue;
      const vl = Math.hypot(sp.vx[i], sp.vy[i]) || 1, ux = sp.vx[i] / vl, uy = sp.vy[i] / vl;
      const len = 1.2 + sp.spd[i] * .02;
      const white = sp.dir[i] > 0;
      const col = white ? [1, .8, .58] : [1, .3, .1];
      const k = .6 + .4 * ((i * 0.618) % 1);
      ctx.glowLine(x - ux * len, y - uy * len, x, y, 1.1, col, (white ? 1.6 : 1.4) * a * k, { core: 1.1, coreR: .4 });
    }
  }

  // Skirmishes
  function startFight(ctx) {
    const W = ctx.W, H = ctx.H;
    const a = Math.random() * Math.PI * 2;
    const R = Math.min(W / 2 / Math.max(Math.abs(Math.cos(a)), 1e-3), H / 2 / Math.max(Math.abs(Math.sin(a)), 1e-3)) + 50;
    const ex = W / 2 - Math.cos(a) * R + (Math.random() - .5) * H * .4 * Math.sin(a), ey = H / 2 - Math.sin(a) * R + (Math.random() - .5) * H * .4 * Math.cos(a);
    const f = [];
    const ng = 2 + (Math.random() < .5 ? 1 : 0), nd = 3 + ((Math.random() * 3) | 0);
    for (let i = 0; i < ng; i++) {
      f.push({ team: 0, x: ex + (Math.random() - .5) * 90, y: ey + (Math.random() - .5) * 90, ang: a + (Math.random() - .5) * .2, head: a, spd: 105 + Math.random() * 15, hp: 6, cd: Math.random(), ph: Math.random() * 9, age: 0, alive: true, flash: 0 });
    }
    for (let i = 0; i < nd; i++) {
      f.push({ team: 1, x: ex - Math.cos(a) * (160 + Math.random() * 140) + (Math.random() - .5) * 120, y: ey - Math.sin(a) * (160 + Math.random() * 140) + (Math.random() - .5) * 120,
        ang: a + (Math.random() - .5) * .4, head: a, spd: 150 + Math.random() * 30, hp: 2 + ((Math.random() * 3) | 0), cd: Math.random() * 1.5, ph: Math.random() * 9, age: 0, alive: true, flash: 0 });
    }
    fights.push(f);
  }
  function angDiff(a, b) { let d = b - a; return Math.atan2(Math.sin(d), Math.cos(d)); }
  function updateFights(ctx) {
    const dt = ctx.dt, W = ctx.W, H = ctx.H;
    if (ctx.P.skirmish > 0 && ctx.intro > .5) {
      fightT -= dt;
      if (fightT <= 0) { if (fights.length < 2) startFight(ctx); fightT = (4 + Math.random() * 8) + (1 - ctx.P.skirmish) * (25 + Math.random() * 35); }
    }
    for (const f of fights) {
      for (const s of f) {
        if (!s.alive) continue;
        s.age += dt; s.cd -= dt; s.flash = Math.max(0, s.flash - dt * 4);
        let want, turn;
        if (s.team === 1) {
          let tgt = null, bd = 1e9;
          for (const o of f) if (o.alive && o.team === 0) { const d = Math.hypot(o.x - s.x, o.y - s.y); if (d < bd) { bd = d; tgt = o; } }
          s.tgt = tgt;
          if (tgt) {
            const lead = bd / 900;
            const tx = tgt.x + Math.cos(tgt.ang) * tgt.spd * lead, ty = tgt.y + Math.sin(tgt.ang) * tgt.spd * lead;
            want = bd < 55 ? s.ang : Math.atan2(ty - s.y, tx - s.x) + Math.sin(s.age * 1.3 + s.ph) * .25;
            if (s.cd <= 0 && bd < 420 && Math.abs(angDiff(s.ang, Math.atan2(ty - s.y, tx - s.x))) < .2) {
              const hit = Math.random() < .12, ang = s.ang + (hit ? 0 : (Math.random() - .5) * .2), life = Math.min(bd / 950, .6);
              const nx = Math.cos(s.ang), ny = Math.sin(s.ang);
              for (const sd of [-1, 1]) bolts.fire(s.x + nx * 8 - ny * sd * 5, s.y + ny * 8 + nx * sd * 5, ang, { color: [1, .14, .07], intensity: 6, speed: 950, life: hit ? life : .6, len: 20, width: 1.1 });
              if (hit) hits.push({ t: life, s: tgt, kill: false });
              s.cd = Math.random() < .35 ? .12 : .5 + Math.random() * .7;
            }
          } else want = s.ang;
          turn = 1.9;
        } else {
          want = s.head + Math.sin(s.age * .6 + s.ph) * .35;
          turn = .9;
          // turret fire at the nearest droid, any direction
          let tgt = null, bd = 1e9;
          for (const o of f) if (o.alive && o.team === 1) { const d = Math.hypot(o.x - s.x, o.y - s.y); if (d < bd) { bd = d; tgt = o; } }
          if (tgt && s.cd <= 0 && bd < 340) {
            const lead = bd / 1000;
            const tx = tgt.x + Math.cos(tgt.ang) * tgt.spd * lead, ty = tgt.y + Math.sin(tgt.ang) * tgt.spd * lead;
            const hit = Math.random() < .14, ang = Math.atan2(ty - s.y, tx - s.x) + (hit ? 0 : (Math.random() - .5) * .3), life = Math.min(bd / 1000, .5);
            bolts.fire(s.x, s.y, ang, { color: [.25, .55, 1], intensity: 7, speed: 1000, life: hit ? life : .55, len: 22, width: 1.3 });
            if (hit) hits.push({ t: life, s: tgt, kill: true });
            s.cd = .18 + Math.random() * .5;
          }
        }
        // dodge the cursor: veer away and punch the throttle
        const ptr = ctx.pointer;
        if (ptr.active) {
          const qx = s.x - ptr.x, qy = s.y - ptr.y, pd = Math.hypot(qx, qy);
          if (pd < 210) {
            const push = 1 - pd / 210, away = Math.atan2(qy, qx);
            want = Math.atan2(Math.sin(want) * (1 - push) + Math.sin(away) * push * 2, Math.cos(want) * (1 - push) + Math.cos(away) * push * 2);
            turn = Math.max(turn, 2.8); s.boost = Math.max(s.boost || 0, push);
          }
        }
        if (s.boost) s.boost = Math.max(0, s.boost - dt * .7);
        // keep clear of the icons
        const look = s.spd * .5, lx = s.x + Math.cos(s.ang) * look, ly = s.y + Math.sin(s.ang) * look, dd = ctx.distAt(lx, ly);
        if (dd < 50 && lx > 0 && ly > 0 && lx < W && ly < H) {
          const g = ctx.gradAt(lx, ly), ga = Math.atan2(g[1], g[0]), push = ctx.clamp(1 - dd / 50, 0, 1);
          const tang = s.ang + Math.sign(angDiff(s.ang, ga) || 1) * Math.PI * .5 * push;
          want = Math.atan2(Math.sin(tang) + Math.sin(ga) * push, Math.cos(tang) + Math.cos(ga) * push); turn = 2.6;
        }
        const d = angDiff(s.ang, want);
        s.ang += ctx.clamp(d, -turn * dt, turn * dt);
        const v = s.spd * (1 + .9 * (s.boost || 0));
        s.x += Math.cos(s.ang) * v * dt; s.y += Math.sin(s.ang) * v * dt;
        if (s.age > 4 && (s.x < -250 || s.y < -250 || s.x > W + 250 || s.y > H + 250)) s.alive = false;
      }
    }
    for (const h of hits) {
      h.t -= dt;
      if (h.t <= 0 && h.s.alive) {
        h.s.flash = 1;
        if (h.kill && --h.s.hp <= 0) { h.s.alive = false; boom(h.s.x, h.s.y, 1); }
        else booms.push({ x: h.s.x, y: h.s.y, age: 0, life: .25, size: .35, deb: [] });
      }
    }
    hits = hits.filter(h => h.t > 0);
    fights = fights.filter(f => f.some(s => s.alive));
    for (const b of booms) { b.age += dt; for (const d of b.deb) { d.x += d.vx * dt; d.y += d.vy * dt; d.vx *= 1 - dt * 1.5; d.vy *= 1 - dt * 1.5; } }
    booms = booms.filter(b => b.age < b.life);
    bolts.update(dt);
  }
  function boom(x, y, size) {
    const deb = [];
    for (let i = 0; i < 12; i++) { const a = Math.random() * 6.28, v = 40 + Math.random() * 160; deb.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v }); }
    booms.push({ x, y, age: 0, life: 1.1, size, deb });
  }

  function drawShipLights(ctx, x, y, ang, len, kind, t, a) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const P = (fx, fy) => [x + c * fx * len - s * fy * len, y + s * fx * len + c * fy * len];
    const blink = (Math.sin(t * 5 + x * .01) > .82) ? 1 : 0;
    if (kind === 'cruiser') {
      for (const yy of [-.22, 0, .22]) { const q = P(-.47, yy * .37); ctx.glowDot(q[0], q[1], len * .022, [.45, .7, 1], 3 * a, { core: .7 }); ctx.glowDot(q[0] - c * len * .03, q[1] - s * len * .03, len * .05, [.3, .5, 1], .35 * a); }
      const tl = P(-.37, -.4 * .37), tr = P(-.37, .4 * .37);
      ctx.glowDot(tl[0], tl[1], 2.2, [1, .1, .05], 5 * a); ctx.glowDot(tr[0], tr[1], 2.2, [.1, 1, .3], 4 * a);
      const nose = P(.47, 0); ctx.glowDot(nose[0], nose[1], 2.5, [1, 1, 1], 9 * blink * a);
      for (const yy of [-.1, .1]) { const q = P(-.25, yy * .37); ctx.glowDot(q[0], q[1], 1.6, [1, .85, .6], 3 * a); }
      // a row of hangar and port lights along the hull edges
      for (let k = 0; k < 9; k++) { const f = k / 8, q = P(.4 - f * .75, (.04 + f * .36) * .37 * (k % 2 ? 1 : -1)); ctx.glowDot(q[0], q[1], 1.1, [1, .8, .55], 2.2 * a); }
    } else {
      const e = P(-.48, 0); ctx.glowDot(e[0], e[1], len * .06, [.5, .75, 1], 2.2 * a, { core: .6 });
      const l = P(.08, -.28), r = P(.08, .28);
      ctx.glowDot(l[0], l[1], 1.6, [1, .1, .05], 4 * a); ctx.glowDot(r[0], r[1], 1.6, [.15, 1, .3], 3.5 * a);
      const b = P(0, 0); ctx.glowDot(b[0], b[1], 2, [1, 1, 1], 7 * blink * a);
    }
  }

  /* ====================================================================
     Time of day and weather (ctx.env), worked into the city itself
     ==================================================================== */
  const E = { day: 0, sunZ: 0, sunDir: [0, 1], tanE: 1, sunCol: [0, 0, 0], skyCol: [0, 0, 0], haze: [0, 0, 0], cloudCol: [0, 0, 0],
    lights: 1, road: 1, cloud: 0, wet: 0, rain: 0, snow: 0, fog: 0, storm: 0, hazeK: 1, wind: [0, 0], drift: [0, 0], ptr: 0,
    flash: [0, 0, 1, 0], sprTint: [1, 1, 1] };
  const mixv = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const mulv = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  let lastL = 0, strikeT = -9, bolt = [];
  function computeEnv(ctx) {
    const e = ctx.env, el = e.sunElev, S = ctx.sstep, dt = ctx.dt;
    const over = Math.min(1, e.cloud * .7 + e.rain * .25 + e.storm * .4 + e.fog * .35);
    E.day = S(-6, 8, el);
    const sunUp = S(-1.5, 7, el), warm = 1 - S(3, 24, el), bright = .3 + .7 * S(-5, 10, el);
    E.sunCol = mulv(mixv([1, .95, .87], [1, .56, .24], warm), sunUp * (1 - .85 * over) * (1.5 + 3.4 * warm));
    const cool = (1 - S(2, 22, el)) * (1 - .6 * over);
    const sky = mixv(mixv([.29, .33, .41], [.34, .36, .40], over), [.14, .18, .40], cool);
    E.skyCol = mulv(sky, bright * (1 - .5 * e.storm) * (1 - .12 * e.rain) * (1 + .25 * e.snow));
    const hz = mixv(mixv([.19, .22, .275], [.2, .215, .235], over), [.07, .085, .18], cool);
    E.haze = mulv(hz, bright * bright * (1 - .5 * e.storm) * (1 + .2 * e.snow));
    E.cloudCol = mulv(mixv(mixv([.36, .38, .42], [.5, .42, .46], warm * (1 - over)), [.17, .18, .21], e.storm), (.25 + .75 * sunUp) * bright).map((v, i) => v + E.sunCol[i] * .12);
    E.gold = warm * sunUp * (1 - over);
    E.lowSun = warm * (1 - over) * S(-6, 0, el);
    // the sun crosses the sky: east (right) in the morning, south (down) at noon, west in the evening
    const ph = ctx.clamp((e.hour - 6.5) / 12, -.1, 1.1), th = .25 + ph * (Math.PI - .5);
    E.sunDir = [Math.cos(th), Math.sin(th)];
    E.sunZ = Math.sin(Math.max(el, 0) * Math.PI / 180);
    E.tanE = Math.tan(Math.max(el, 2.5) * Math.PI / 180);
    E.lights = ctx.clamp(1 - S(-5, 14, el) + over * .35 + e.storm * .3, 0, 1);
    E.road = ctx.clamp(1 - S(-3, 9, el) + over * .4, 0, 1);
    E.cloud = ctx.clamp(e.cloud + e.storm * .15, 0, 1);
    E.rain = ctx.clamp(e.rain, 0, 1); E.storm = e.storm;
    E.wet = ctx.clamp(e.rain * 1.05 + e.storm * .2, 0, 1);
    E.snow = ctx.clamp(e.snow, 0, 1); E.fog = ctx.clamp(e.fog, 0, 1);
    E.hazeK = 1 - .5 * E.day - .25 * warm * sunUp * (1 - over) + .35 * e.rain + .3 * e.snow + .15 * e.storm;
    // wind steers the haze, the cloud decks, rain and snow (neutral wind = the designed drift)
    E.wind = [Math.cos(e.windDir) * e.wind, Math.sin(e.windDir) * e.wind];
    const n0 = [Math.cos(-.5) * .3, Math.sin(-.5) * .3];
    E.drift[0] += (4.5 + (E.wind[0] - n0[0]) * 55) * dt; E.drift[1] += (1.4 + (E.wind[1] - n0[1]) * 55) * dt;
    // sprites: dark silhouettes at night, sunlit hulls by day
    E.sprTint = [0, 1, 2].map(i => (E.skyCol[i] * .8 + E.sunCol[i] * (.35 + .5 * E.sunZ)) * .8);
    // the cursor
    const pa = ctx.pointer.active ? 1 : 0;
    E.ptr += (pa - E.ptr) * Math.min(1, ctx.rawDt * (pa > E.ptr ? 10 : 1.5));
    // lightning: each strike lights one district and shows a short bolt
    const L = e.lightning;
    if (L > lastL + .2) {
      if (ctx.t - strikeT > .7) newStrike(ctx);
      strikeT = ctx.t;
    }
    lastL = L;
    E.flash[3] = L * 1.5;
  }
  function newStrike(ctx) {
    const W = ctx.W, H = ctx.H;
    let x = W / 2, y = H / 2, best = -1;
    for (let k = 0; k < 24; k++) { const cx = Math.random() * W, cy = Math.random() * H, d = Math.min(ctx.distAt(cx, cy), 400) + Math.random() * 120; if (d > best) { best = d; x = cx; y = cy; } }
    E.flash[0] = x; E.flash[1] = y; E.flash[2] = 380 + Math.random() * 320;
    // a jagged bolt from the cloud deck down into the canyons, never reaching the icons
    bolt = [];
    const walk = (x0, y0, a, n, w) => {
      let px = x0, py = y0;
      for (let i = 0; i < n; i++) {
        a += (Math.random() - .5) * 1.1;
        const nx = px + Math.cos(a) * (14 + Math.random() * 18), ny = py + Math.sin(a) * (14 + Math.random() * 18);
        if (ctx.distAt(nx, ny) < 50) break;
        bolt.push([px, py, nx, ny, w]); px = nx; py = ny;
        if (w > .7 && Math.random() < .18) walk(px, py, a + (Math.random() < .5 ? -.8 : .8), 3 + (Math.random() * 4 | 0), w * .55);
      }
    };
    if (ctx.distAt(x, y) > 70) walk(x, y, Math.random() * 6.28, 7 + (Math.random() * 6 | 0), 1);
  }
  function lit(night, k = 1) { const d = E.day; return [0, 1, 2].map(i => night[i] + (E.sprTint[i] * k - night[i]) * d); }
  function shadowOf(dx, dy, len, a, b) {
    const d = E.day, L = len * (.6 + .9 / Math.max(E.tanE, .45));
    return { dx: dx + (-E.sunDir[0] * L - dx) * d, dy: dy + (-E.sunDir[1] * L - dy) * d, alpha: a * (1 - .25 * E.day * (E.cloud + E.fog) ), bias: b, scale: 1.05 };
  }

  /* Weather particles: rain streaks falling away from the camera toward the nadir, splashes, snow flakes */
  const PMAX = 3200;
  const pr = { x: new Float32Array(PMAX), y: new Float32Array(PMAX), a: new Float32Array(PMAX), L: new Float32Array(PMAX), s: new Float32Array(PMAX), n: 0 };
  const pf = { x: new Float32Array(PMAX), y: new Float32Array(PMAX), a: new Float32Array(PMAX), L: new Float32Array(PMAX), s: new Float32Array(PMAX), n: 0 };
  function updateWeather(ctx) {
    const W = ctx.W, H = ctx.H, dt = ctx.dt, area = W * H / (1920 * 1080);
    const nr = Math.min(2000, Math.round(E.rain * 1000 * area * (1 + .4 * E.storm)));
    const ns = Math.min(2400, Math.round(E.snow * 1300 * area));
    for (let i = pr.n; i < nr; i++) { pr.a[i] = Math.random(); pr.L[i] = .18 + Math.random() * .14; pr.x[i] = Math.random() * W; pr.y[i] = Math.random() * H; pr.s[i] = Math.random(); }
    pr.n = nr;
    const wx = E.wind[0] * 160, wy = E.wind[1] * 160;
    for (let i = 0; i < nr; i++) {
      pr.a[i] += dt / pr.L[i];
      if (pr.a[i] >= 1) { pr.a[i] -= 1; pr.x[i] = Math.random() * W; pr.y[i] = Math.random() * H; pr.s[i] = Math.random(); }
      pr.x[i] += wx * dt; pr.y[i] += wy * dt;
    }
    for (let i = pf.n; i < ns; i++) { pf.a[i] = Math.random(); pf.L[i] = 3 + Math.random() * 4; pf.x[i] = Math.random() * W; pf.y[i] = Math.random() * H; pf.s[i] = Math.random(); }
    pf.n = ns;
    const sx = E.wind[0] * 70, sy = E.wind[1] * 70, t = ctx.flow;
    for (let i = 0; i < ns; i++) {
      pf.a[i] += dt / pf.L[i];
      if (pf.a[i] >= 1) { pf.a[i] -= 1; pf.x[i] = Math.random() * W; pf.y[i] = Math.random() * H; }
      const z = .5 + pf.s[i];
      pf.x[i] += (sx * z + Math.sin(t * .9 + i) * 9) * dt; pf.y[i] += (sy * z + 6 * z + Math.cos(t * .7 + i * 1.7) * 7) * dt;
      if (pf.x[i] < -10) pf.x[i] += W + 20; else if (pf.x[i] > W + 10) pf.x[i] -= W + 20;
      if (pf.y[i] < -10) pf.y[i] += H + 20; else if (pf.y[i] > H + 10) pf.y[i] -= H + 20;
    }
  }
  function drawWeather(ctx) {
    const cx = ctx.W / 2, cy = ctx.H / 2, d = E.day;
    if (pr.n) {
      const wx = E.wind[0] * 20, wy = E.wind[1] * 20;
      const ci = [.62 + .2 * d, .7 + .15 * d, .85], I0 = .22 + .25 * d;
      for (let i = 0; i < pr.n; i++) {
        const x = pr.x[i], y = pr.y[i], dd = ctx.distAt(x, y);
        const fade = ctx.sstep(6, 40, dd); if (fade < .02) continue;
        const a = Math.sin(Math.PI * pr.a[i]) * fade;
        if (pr.s[i] < .12) {
          // splash on a roof: a tiny ring that flicks out
          ctx.glowDot(x, y, 1.2 + 2.5 * pr.a[i], ci, .5 * (1 - pr.a[i]) * fade * (1.4 - d), { core: 0, falloff: 1.4 });
          continue;
        }
        const k = .04 + .03 * pr.s[i], vx = (cx - x) * k + wx, vy = (cy - y) * k + wy;
        ctx.glowLine(x, y, x + vx, y + vy, .5 + .3 * pr.s[i], ci, I0 * a, { core: 0 });
      }
    }
    if (pf.n) {
      const tint = lit([.5, .52, .6], 1.1), g = .7 + .3 * d;
      for (let i = 0; i < pf.n; i++) {
        const x = pf.x[i], y = pf.y[i], dd = ctx.distAt(x, y);
        const fade = ctx.sstep(6, 34, dd); if (fade < .02) continue;
        const a = Math.min(1, Math.sin(Math.PI * pf.a[i]) * 3) * fade * g;
        ctx.sprite('flake', x, y, { w: 2.2 + 3.6 * pf.s[i], alpha: a * (.55 + .45 * pf.s[i]), tint });
      }
    }
    // lightning bolt
    if (bolt.length && E.flash[3] > .05) {
      const I = E.flash[3];
      for (const s of bolt) {
        ctx.glowLine(s[0], s[1], s[2], s[3], 10 * s[4], [.5, .58, 1], .25 * I * s[4], { core: 0 });
        ctx.glowLine(s[0], s[1], s[2], s[3], 1.3 * s[4], [.8, .85, 1], 4 * I * s[4], { core: 1, coreR: .4 });
      }
    }
  }

  /* Double-click fire: a gunship swoops in and fires blue bolts, or a rooftop defense battery opens up */
  let strikes = [], impacts = [], puffs = [], scorches = [], fireN = 0;
  function pathScore(ctx, x0, y0, a, len) {
    let mn = 1e9;
    for (let t = 0; t <= len; t += 25) { const d = ctx.distAt(x0 + Math.cos(a) * t, y0 + Math.sin(a) * t); mn = Math.min(mn, d); }
    return mn;
  }
  function doFire(ctx, x, y) {
    fireN++;
    if (fireN % 3 === 0) {
      // defense battery on a nearby rooftop
      let best = null, bs = -1;
      for (let k = 0; k < 40; k++) {
        const a = Math.random() * 6.28, r = 170 + Math.random() * 170, bx = x + Math.cos(a) * r, by = y + Math.sin(a) * r;
        if (bx < 20 || by < 20 || bx > ctx.W - 20 || by > ctx.H - 20) continue;
        const sc = Math.min(ctx.distAt(bx, by), 120) + Math.min(pathScore(ctx, bx, by, a + Math.PI, r), 60) * .5;
        if (sc > bs) { bs = sc; best = { x: bx, y: by }; }
      }
      if (best && bs > 40) {
        strikes.push({ mode: 1, x: best.x, y: best.y, ang: Math.atan2(y - best.y, x - best.x), tx: x, ty: y, age: 0, next: .02, shots: 7, life: 2.6 });
        return;
      }
    }
    let ba = 0, bs = -1;
    for (let k = 0; k < 20; k++) {
      const a = k / 20 * 6.28 + Math.random() * .2, sc = Math.min(pathScore(ctx, x - Math.cos(a) * 420, y - Math.sin(a) * 420, a, 300), 120) + Math.random() * 15;
      if (sc > bs) { bs = sc; ba = a; }
    }
    strikes.push({ mode: 0, x: x - Math.cos(ba) * 430, y: y - Math.sin(ba) * 430, ang: ba, spd: 520, tx: x, ty: y, age: 0, next: .04, shots: 4,
      side: Math.random() < .5 ? -1 : 1, life: 4 });
  }
  function updateStrikes(ctx) {
    const dt = ctx.dt;
    for (const s of strikes) {
      s.age += dt;
      if (s.mode === 0) {
        const dx = s.tx - s.x, dy = s.ty - s.y, dist = Math.hypot(dx, dy);
        if (s.shots > 0 && s.age >= s.next) {
          const c = Math.cos(s.ang), sn = Math.sin(s.ang);
          for (const sd of [-1, 1]) {
            const ox = s.x + c * 12 - sn * sd * 9, oy = s.y + sn * 12 + c * sd * 9;
            const jx = (Math.random() - .5) * 12, jy = (Math.random() - .5) * 12, ex = s.tx + jx, ey = s.ty + jy;
            const L = Math.hypot(ex - ox, ey - oy), life = L / 1500;
            bolts.fire(ox, oy, Math.atan2(ey - oy, ex - ox), { color: [.3, .58, 1], intensity: 8, speed: 1500, life, len: 26, width: 1.5, hit: false });
            impacts.push({ x: ex, y: ey, delay: life, age: 0, size: sd > 0 ? 1 : .7, big: s.shots === 1 && sd > 0 });
          }
          s.shots--; s.next = s.age + .13;
        }
        // swoop: dive at the target, then pull up and bank away
        let want = Math.atan2(dy, dx);
        if (s.shots <= 0 || dist < 190) { want = s.ang + s.side * 1.4; s.spd = Math.min(s.spd + 500 * dt, 760); }
        let da = want - s.ang; da = Math.atan2(Math.sin(da), Math.cos(da));
        s.ang += ctx.clamp(da, -2.4 * dt, 2.4 * dt);
        s.x += Math.cos(s.ang) * s.spd * dt; s.y += Math.sin(s.ang) * s.spd * dt;
      } else if (s.shots > 0 && s.age >= s.next) {
        const c = Math.cos(s.ang), sn = Math.sin(s.ang), sd = s.shots % 2 ? 1 : -1;
        const ox = s.x + c * 10 - sn * sd * 3, oy = s.y + sn * 10 + c * sd * 3;
        const jx = (Math.random() - .5) * 14, jy = (Math.random() - .5) * 14, ex = s.tx + jx, ey = s.ty + jy;
        const life = Math.hypot(ex - ox, ey - oy) / 1300;
        bolts.fire(ox, oy, Math.atan2(ey - oy, ex - ox), { color: [.35, .62, 1], intensity: 9, speed: 1300, life, len: 22, width: 1.7, hit: false });
        impacts.push({ x: ex, y: ey, delay: life, age: 0, size: .8, big: s.shots === 1 });
        s.shots--; s.next = s.age + .085; s.recoil = 1;
      }
      if (s.recoil) s.recoil = Math.max(0, s.recoil - dt * 8);
    }
    strikes = strikes.filter(s => s.age < s.life);
    for (const m of impacts) {
      if (m.delay > 0) {
        m.delay -= dt;
        if (m.delay <= 0) {
          m.dI = ctx.distAt(m.x, m.y);
          m.deb = [];
          for (let i = 0; i < 7; i++) { const a = Math.random() * 6.28, v = 50 + Math.random() * 130; m.deb.push({ x: m.x, y: m.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v }); }
          const nP = m.big ? 4 : 1;
          for (let i = 0; i < nP; i++) puffs.push({ x: m.x + (Math.random() - .5) * 8, y: m.y + (Math.random() - .5) * 8, vx: (Math.random() - .5) * 16, vy: (Math.random() - .5) * 16,
            age: -i * .12, life: 2.6 + Math.random() * 1.2, s0: 8 + 4 * m.size, rot: Math.random() * 6.28, vr: (Math.random() - .5) * .5 });
          let sc = scorches.find(o => Math.hypot(o.x - m.x, o.y - m.y) < 22);
          if (sc) sc.age = Math.min(sc.age, .5); else scorches.push({ x: m.x, y: m.y, age: 0, life: 6, rot: Math.random() * 6.28 });
        }
        continue;
      }
      m.age += dt;
      for (const d of m.deb) { d.x += d.vx * dt; d.y += d.vy * dt; d.vx *= 1 - dt * 2.5; d.vy *= 1 - dt * 2.5; }
    }
    impacts = impacts.filter(m => m.delay > 0 || m.age < 2.2);
    const wx = E.wind[0] * 40, wy = E.wind[1] * 40;
    for (const p of puffs) { p.age += dt; if (p.age > 0) { p.x += (p.vx + wx) * dt; p.y += (p.vy + wy) * dt; p.rot += p.vr * dt; } }
    puffs = puffs.filter(p => p.age < p.life);
    for (const s of scorches) s.age += dt;
    scorches = scorches.filter(s => s.age < s.life);
    if (strikes.length > 12) strikes.splice(0, strikes.length - 12);
    if (puffs.length > 80) puffs.splice(0, puffs.length - 80);
  }
  function drawScorches(ctx) {
    for (const s of scorches) {
      const k = s.age / s.life, a = (1 - k) * (1 - k) * ctx.sstep(0, .2, s.age);
      const lim = Math.max(4, ctx.distAt(s.x, s.y) - 4);
      ctx.sprite('scorch', s.x, s.y, { w: Math.min(30, lim * 1.6), rot: s.rot, alpha: .75 * a, tint: lit([.6, .55, .5], .9) });
      const em = Math.exp(-s.age * .9);
      if (em > .03) for (let i = 0; i < 4; i++) {
        const f = .5 + .5 * Math.sin(ctx.t * (7 + i * 3) + i * 2.1 + s.rot);
        ctx.glowDot(s.x + Math.cos(s.rot + i * 1.7) * 5, s.y + Math.sin(s.rot + i * 1.7) * 5, 1.4, [1, .42, .12], 3 * em * f, { core: .4 });
      }
    }
  }
  function drawStrikes(ctx) {
    const day = E.day;
    for (const p of puffs) {
      if (p.age <= 0) continue;
      const k = p.age / p.life, d = ctx.distAt(p.x, p.y);
      const w = Math.min(p.s0 + 46 * Math.sqrt(k), Math.max(6, (d - 4) * 1.5));
      const fire = Math.exp(-p.age * 2.2);
      const tint = [0, 1, 2].map(i => mixv([.11, .11, .125], [.36, .35, .34], day)[i] + [1, .4, .12][i] * fire * .9);
      ctx.sprite('puff', p.x, p.y, { w, rot: p.rot, alpha: .62 * Math.sin(Math.PI * Math.min(1, k * 1.15 + .02)) ** .7 * ctx.sstep(2, 18, d), tint });
    }
    for (const m of impacts) {
      if (m.delay > 0) continue;
      const k = m.age, R = ctx.clamp((m.dI - 6) / 1.5, 5, 42) * (.7 + .3 * m.size);
      const flash = Math.exp(-k * 13), fb = ctx.sstep(0, .06, k) * Math.exp(-k * 1.7);
      ctx.glowDot(m.x, m.y, Math.min(10 + 26 * k, R * .9), [.62, .78, 1], 7 * flash * m.size, { core: flash });
      ctx.glowDot(m.x, m.y, R, [1, .42, .13], (.9 + .5 * Math.sin(k * 31)) * fb * m.size, { core: 0, falloff: 1.6 });
      ctx.glowDot(m.x, m.y, R * .28, [1, .62, .26], 2.8 * fb * m.size, { core: .5 * fb });
      for (const d of m.deb) { const kk = Math.max(0, 1 - k * 1.6); if (kk > 0) ctx.glowDot(d.x, d.y, 1.2, [1, .6, .25], 6 * kk * kk, { core: .6 }); }
    }
    for (const s of strikes) {
      if (s.mode === 0) {
        const a = ctx.sstep(0, .15, s.age) * (1 - ctx.sstep(s.life - .4, s.life, s.age));
        ctx.sprite('gunship', s.x, s.y, { w: 54, rot: s.ang, alpha: a, tint: lit([.5, .52, .55], 1), shadow: shadowOf(16, 22, 40, .5 * a, 3.4) });
        const c = Math.cos(s.ang), sn = Math.sin(s.ang);
        ctx.glowDot(s.x - c * 25, s.y - sn * 25, 5, [.5, .75, 1], 3 * a);
        if (s.shots > 0 || s.age - s.next > -.06) for (const sd of [-1, 1]) {
          const f = Math.max(0, 1 - (s.age - (s.next - .13)) * 14);
          if (f > 0) ctx.glowDot(s.x + c * 14 - sn * sd * 9, s.y + sn * 14 + c * sd * 9, 4, [.5, .7, 1], 6 * f, { core: f });
        }
      } else {
        const a = ctx.sstep(0, .2, s.age) * (1 - ctx.sstep(s.life - .5, s.life, s.age));
        const c = Math.cos(s.ang), sn = Math.sin(s.ang), rc = (s.recoil || 0) * 2.5;
        ctx.sprite('battery', s.x - c * rc, s.y - sn * rc, { w: 26, rot: s.ang, alpha: a, tint: lit([.42, .44, .48], 1), shadow: shadowOf(3, 4, 6, .5 * a, 2) });
        if (s.recoil > 0) ctx.glowDot(s.x + c * 14, s.y + sn * 14, 5, [.45, .68, 1], 9 * s.recoil, { core: s.recoil });
        ctx.glowDot(s.x, s.y, 1.6, [1, .1, .05], 3 * a * (Math.sin(ctx.t * 9) > 0 ? 1 : .2));
      }
    }
  }

  /* ====================================================================
     Registration
     ==================================================================== */
  Galaxy.register(ID, {
    name: 'City-planet',
    defaultHour: 22,
    // Night is the designed look. Daylight calms the grade; rain, fog and snow widen the halos around the lights.
    post(ctx) {
      const d = E.day, wf = Math.min(1, E.wet * .6 + E.fog * .8 + E.snow * .3);
      return { bloom: .75 - .25 * d + .3 * wf, threshold: 1.15 + .3 * d - .25 * wf, knee: .7, exposure: 1.0 - .12 * d, vignette: .5 - .18 * d, grain: .014, aberration: .0003,
        tint: [.95 + .05 * d, .99 + .01 * d, 1.06 - .05 * d + .03 * (E.gold || 0) * d], lift: [0, .0005 * (1 - d), .0016 * (1 - d)], saturation: 1.05 - .15 * d + .35 * (E.gold || 0) * d, bloomRadius: 1.2 + .6 * wf };
    },

    init(ctx) {
      progCity = ctx.linkProgram(VS_FULL, '#version 300 es\n' + HDR_MRT() + CITY);
      progMain = ctx.program(MAIN);
      progNoise = ctx.program(NOISE);
      progDown1 = ctx.program(DOWN1);
      progDown2 = ctx.program(DOWN2);
      progShadow = ctx.program(SHADOW);
      roofTex = ctx.loadTexture(TEX_ROOF, { srgb: false });
      noiseT = null;
      defineSprites(ctx);
      transports = new ctx.Flock({ count: 6, speed: 32, turn: .4, margin: 70, wander: .3, seedK: 41 });
      bolts = new ctx.Bolts();
      cruisers = []; fights = []; booms = []; hits = [];
      strikes = []; impacts = []; puffs = []; scorches = []; bolt = []; pr.n = 0; pf.n = 0;
      E.drift = [0, 0]; E.ptr = 0; lastL = 0;
      sp.n = 0; sp.live.fill(0);
      fightT = 2 + Math.random() * 2 + (1 - ctx.P.skirmish) * 20;
      dirty = true;
    },
    resize(ctx) { makeCache(ctx); planFeatures(ctx); },
    layout(ctx) {
      dirty = true; planFeatures(ctx);
      if (ctx.t < 1) cruisers.forEach(c => newCruiser(ctx, c, true));
    },

    update(ctx) {
      frame++;
      computeEnv(ctx);
      updateSpeeders(ctx);
      const nc = Math.round(3 * ctx.P.traffic);
      while (cruisers.length < nc) { const c = {}; newCruiser(ctx, c, true); cruisers.push(c); }
      cruisers.length = nc;
      for (const c of cruisers) { c.t += c.spd * ctx.dt; if (c.t > c.R) newCruiser(ctx, c, false); }
      cruisers.sort((a, b) => a.alt - b.alt);
      transports.resize(Math.round(9 * ctx.P.traffic));
      transports.update(ctx.dt, ctx.flow);
      updateFights(ctx);
      updateStrikes(ctx);
      updateWeather(ctx);
    },

    fire(ctx, x, y) { doFire(ctx, x, y); },

    render(ctx) {
      if (!full) return;
      const stable = ctx.fieldStable, intro = ctx.intro;
      const changing = !stable || intro < 1;
      touched = false;
      if (changing) {
        // icons moving or growing in: cheap half-resolution cache every 2nd frame
        if (frame % 2 === 0 || !lowValid || dirty) { renderCity(ctx, lowc); renderGlow(ctx); lowValid = true; }
        fullRows = 0; needFinal = true; dirty = false;
      } else if (dirty) {
        // settled layout change (startup, resize, textures arrived): everything at once
        renderCity(ctx, lowc); renderGlow(ctx); renderCity(ctx, full); lowValid = true;
        fullRows = ctx.pxH; dirty = false; needFinal = false;
      } else if (needFinal) {
        renderCity(ctx, lowc); renderGlow(ctx); needFinal = false; fullRows = 0;
      } else if (fullRows < ctx.pxH) {
        const strip = Math.ceil(ctx.pxH / STRIPS);
        renderCity(ctx, full, fullRows, strip); fullRows += strip;
      }
      // sun shadows: only by day, and only when the cache or the sun direction changed
      if (E.day > .001) {
        const key = Math.round(Math.atan2(E.sunDir[1], E.sunDir[0]) * 200) + ':' + Math.round(E.tanE * 100);
        if ((touched && (stable && intro >= 1 || frame % 4 === 0)) || key !== shadowKey || shadowStale) {
          ctx.gl.disable(ctx.gl.BLEND);
          ctx.fullscreen(progShadow, { uSplit: Math.min(fullRows, ctx.pxH), uFullH: ctx.pxH, uTanE: E.tanE, uSunDir: E.sunDir, uRatio: 1.42 + .14 * (1 - ctx.sstep(8, 30, ctx.env.sunElev)) }, { uA: full.A.tex, uLA: lowc.A.tex }, shadowT);
          shadowKey = key; shadowStale = false;
        }
      } else shadowStale = true;
      const ptr = ctx.pointer;
      ctx.fullscreen(progMain, {
        uSplit: fullRows, uTraffic: ctx.P.traffic, uLanes: (.3 + ctx.P.traffic) * ctx.sstep(.3, 1, intro) * (1 - .7 * E.day), uSky: skyU, uSkyN: skyways.length,
        uC: [ctx.W / 2, ctx.H / 2], uDrift: E.drift, uSunDir: E.sunDir, uDay: E.day, uSunZ: E.sunZ, uLights: E.lights, uRoad: E.road,
        uCloud: E.cloud, uWet: E.wet, uSnow: E.snow, uFog: E.fog, uHazeK: E.hazeK,
        uSunCol: E.sunCol, uSkyCol: E.skyCol, uHaze: E.haze, uCloudCol: E.cloudCol, uFlash: E.flash, uGold: E.lowSun || 0, uGlowK: .12 + .88 * Math.max(E.lights, E.road) * (1 - .7 * E.day), uPtr: [ptr.x, ptr.y, E.ptr, 0]
      }, { uA: full.A.tex, uB: full.B.tex, uCc: full.C.tex, uLA: lowc.A.tex, uLB: lowc.B.tex, uLC: lowc.C.tex, uG0: g0.tex, uG1: g1.tex, uG2: g2.tex, uNoise: noiseT.tex, uShadow: shadowT.tex }, null);

      const t = ctx.t, show = ctx.sstep(.3, 1, intro), day = E.day;
      drawScorches(ctx);
      drawSpeeders(ctx);
      // searchlights sweeping up through the haze (switched off by day)
      const sl = show * (1 - .85 * day) * (1 + .8 * E.fog + .5 * E.wet);
      if (sl > .01) for (const s of searchlights) {
        const a = s.a0 + Math.sin(t * s.w + s.ph) * s.amp + t * .03;
        const c = Math.cos(a), sn = Math.sin(a);
        for (let k = 1; k <= 8; k++) {
          const f = k / 8, r = 5 + f * 34;
          ctx.glowDot(s.x + c * s.len * f, s.y + sn * s.len * f, r, [.6, .75, 1], (.075 - f * .05) * sl, { core: 0, falloff: 1.6 });
        }
        ctx.glowDot(s.x, s.y, 3, [.8, .9, 1], 2.2 * show, { core: 1 });
      }
      // icon deck corner beacons
      for (const b of beacons) {
        const ph = (t * .5 + b.ph) % 1, on = ctx.sstep(0, .05, ph) * (1 - ctx.sstep(.16, .3, ph));
        ctx.glowDot(b.x, b.y, 2.2, [1, .08, .04], (.25 + 5 * on) * show, { core: .8 });
      }
      // transports
      for (const a of transports.agents) {
        const wedge = a.id % 3 === 0, kind = wedge ? 'cruiser' : 'shuttle', len = wedge ? 60 + (a.id % 5) * 6 : 38 + (a.id % 7) * 3;
        ctx.sprite(kind, a.x, a.y, { w: len, rot: a.ang, alpha: show, tint: lit(wedge ? [.2, .22, .27] : [.22, .22, .24], wedge ? .9 : .85), shadow: shadowOf(10, 14, 22, .55, 3.6) });
        drawShipLights(ctx, a.x, a.y, a.ang, len, 'small', t, show);
      }
      // cruisers high above
      const W = ctx.W, H = ctx.H;
      for (const c of cruisers) {
        const x = c.px + Math.cos(c.a) * c.t, y = c.py + Math.sin(c.a) * c.t;
        if (x < -c.len || y < -c.len || x > W + c.len || y > H + c.len) continue;
        const L = c.len * (.85 + .3 * c.alt);
        ctx.sprite('cruiser', x, y, { w: L, rot: c.a, alpha: show, tint: lit([.26, .28, .34], .95), shadow: shadowOf(26 + 20 * c.alt, 34 + 26 * c.alt, 60 + 40 * c.alt, .5, 5.5) });
        drawShipLights(ctx, x, y, c.a, L, 'cruiser', t + c.ph, show);
      }
      // skirmish
      for (const f of fights) for (const s of f) {
        if (!s.alive) continue;
        if (s.team === 0) {
          ctx.sprite('gunship', s.x, s.y, { w: 44, rot: s.ang, tint: lit([.5, .52, .55], 1), shadow: shadowOf(12, 16, 30, .5, 3) });
          ctx.glowDot(s.x - Math.cos(s.ang) * 20, s.y - Math.sin(s.ang) * 20, 4, [.5, .75, 1], 2.5);
        } else {
          ctx.sprite('droid', s.x, s.y, { w: 32, rot: s.ang, tint: lit([.52, .5, .48], 1), shadow: shadowOf(12, 16, 30, .5, 3) });
          ctx.glowDot(s.x + Math.cos(s.ang) * 10, s.y + Math.sin(s.ang) * 10, 1.6, [1, .3, .1], 4);
        }
        if (s.flash > 0) ctx.glowDot(s.x, s.y, 8, [1, .7, .4], 5 * s.flash);
      }
      drawStrikes(ctx);
      bolts.draw();
      for (const b of booms) {
        const k = b.age / b.life, inv = 1 - k;
        ctx.glowDot(b.x, b.y, 90 * b.size, [1, .45, .15], .5 * inv * inv);
        ctx.glowDot(b.x, b.y, (6 + 26 * Math.sqrt(k)) * b.size, [1, .6, .25], 14 * inv * inv, { core: inv * 1.5 });
        for (const d of b.deb) ctx.glowDot(d.x, d.y, 1.6, [1, .55, .2], 6 * inv);
      }
      drawWeather(ctx);
    },

    dispose(ctx) {
      for (const p of [progCity, progMain, progNoise, progDown1, progDown2, progShadow]) if (p) ctx.gl.deleteProgram(p.p);
      progCity = progMain = progNoise = progDown1 = progDown2 = progShadow = null;
      freeCache(ctx);
      if (noiseT) ctx.freeTarget(noiseT); noiseT = null;
    }
  });
})();
