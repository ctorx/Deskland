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
void facade(float along, float la, float bxa, float hw, float top, float id, float face, float warm, bool mon, vec2 p, out vec3 col, out vec3 em, out float eid) {
  float rowPx = length(p - uC) * uK / FLOORS;
  float fl = hw * FLOORS; float row = floor(fl), rf = fract(fl);
  col = SKY * (.25 + .35 * face) * (.5 + .9 * hw);
  col *= 1. + .3 * smoothstep(.9, .97, rf) * smoothstep(1., 2., rowPx);
  float cw = 3.4;
  float cx = floor(along / cw), cf = fract(along / cw);
  float win = smoothstep(.14, .26, cf) * smoothstep(.86, .74, cf) * smoothstep(.18, .34, rf) * smoothstep(.82, .66, rf);
  win = mix(.4, win, smoothstep(1.6, 3.2, rowPx));
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
    } else {
      // ground: streets, avenues and arterials deep in the canyons
      col = vec3(.004, .005, .007);
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
    } else {
      vec2 l = Wb.lc, bx = Wb.bx; vec2 ed = bx - abs(l);
      bool fx = ed.x < ed.y;
      float la = fx ? l.y : l.x, bxa = fx ? bx.y : bx.x;
      float face = fx ? (l.x > 0. ? .3 : 1.) : (l.y > 0. ? .2 : .8);
      bool mon = Wb.top > .56 && hash12(vec2(Wb.id, 23.)) < .2;
      facade(la + Wb.id * 977. + (fx ? 300. : 0.), la, bxa, hw, Wb.top, Wb.id + Wb.tier * .17, face, Wb.warm, mon, p, col, em, eid);
      col *= 1. + .7 * smoothstep(1., .2, bxa - abs(la));
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
    Bd t1 = bld(b0 + dv * 6.); Bd t2 = bld(b0 + dv * 16.);
    ao += clamp((t1.h - hs) * 6., 0., 1.) * .6 + clamp((t2.h - hs) * 3., 0., 1.) * .4;
  }
  col *= 1. - .75 * ao * .25;
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
uniform sampler2D uA, uB, uCc, uLA, uLB, uLC, uG1, uG2, uNoise;
uniform float uSplit, uTraffic, uLanes, uSkyN;
uniform vec4 uSky[4];
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
  float wave = smoothstep(0., .25, uIntro * 1.5 - .2 - max(dI, 0.) / 2600. - fract(eid * 91.7) * .2);
  vec3 em = B.rgb * tw * wave;
  vec4 nz = texture(uNoise, p * .00042 + uSeed * .07 + .5);
  float lvl = mix(.35, 1.45, smoothstep(.3, .72, nz.r));
  if (eid > .005 && eid < .5) em *= lvl;

  // traffic rivers along the arterials (class 3) and avenues (class 2)
  if (C.a > 1.5 && uTraffic > 0.) {
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
    em += cc * on * car * inLane * (1.1 + 1.6 * art) * (.7 + .5 * head) * wave;
  }

  // height fog lit from below by the blurred city light, drifting haze
  vec2 drift = vec2(uFlow * 4.5, uFlow * 1.4);
  vec3 n1 = texture(uNoise, (p + drift) * .00085 + uSeed * .11).rgb;
  vec3 n2 = texture(uNoise, (p - drift * .7) * .0019 + .37).rgb;
  float hz = n1.r * .62 + n2.g * .38;
  vec3 glow = texture(uG1, vUv).rgb * .45 + texture(uG2, vUv).rgb * .9;
  float low = pow(1. - clamp(h, 0., 1.), 3.2);
  float fogA = clamp(low * (.42 + .62 * hz), 0., .88);
  vec3 fogC = vec3(.004, .009, .016) * (.8 + .5 * hz) + glow * .8;
  col = mix(col, fogC, fogA) + em * (1. - fogA * .72);
  // drifting cloud wisps at mid altitude, lit from below by the city, thinned near the icons
  vec3 n3 = texture(uNoise, (p + drift * 2.2) * .0006 + vec2(.21, .63)).rgb;
  float cloud = smoothstep(.5, .78, n3.b * .7 + n2.r * .4) * smoothstep(20., 90., dI);
  col = mix(col, vec3(.010, .016, .026) + glow * .9, cloud * .5);
  col += glow * .02;

  // air-lane glow along the blob contours and skyways
  float bl = iconBlob(p);
  float lane = 0.;
  for (int i = 0; i < 2; i++) { float d = bl - LANES[i]; lane += exp(-d * d / 9.) * (1. - float(i) * .3); }
  float sky = 0.;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uSkyN) break;
    vec4 s = uSky[i]; float d = dot(p - s.xy, vec2(-s.w, s.z));
    sky += exp(-d * d / 40.);
  }
  col += AMBER * (lane * .012 + sky * .014) * uLanes * smoothstep(14., 60., dI);

  // icon tower: a soft cool light dome over the crown and a slow breathing rim
  float plz = smoothstep(.15, .5, uIntro);
  float dk = max(bl, dI - 20.);
  col += COOLW * exp(-max(dk, 0.) / 70.) * step(0., dk) * .012 * plz;
  col += COOLW * exp(-pow((dk + .7) / 1.2, 2.)) * (.15 + .15 * sin(uTime * .7 + p.x * .004)) * plz;
  outColor = vec4(col, 1.);
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
  }

  /* ====================================================================
     State
     ==================================================================== */
  let progCity = null, progMain = null, progNoise = null, progDown1 = null, progDown2 = null;
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
    if (!noiseT) {
      noiseT = ctx.makeTarget(512, 512, { repeat: true });
      ctx.gl.disable(ctx.gl.BLEND);
      ctx.fullscreen(progNoise, {}, {}, noiseT);
    }
    dirty = true; lowValid = false; fullRows = 0;
  }
  function freeCache(ctx) {
    freeSet(ctx, full); freeSet(ctx, lowc);
    [g0, g1, g2].forEach(t => t && ctx.freeTarget(t));
    full = lowc = g0 = g1 = g2 = null;
  }
  function renderCity(ctx, set, y0, rows) {
    const gl = ctx.gl;
    gl.disable(gl.BLEND);
    if (rows != null) { gl.enable(gl.SCISSOR_TEST); gl.scissor(0, y0, set.t.w, rows); }
    ctx.fullscreen(progCity, { uK: K_LEAN, uC: [ctx.W / 2, ctx.H / 2], uGrow: ctx.intro }, { uTex: roofTex }, set.t);
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
    const fade = ctx.sstep(.35, 1, ctx.intro); if (fade <= 0) return;
    for (let i = 0; i < sp.n; i++) {
      if (!sp.live[i]) continue;
      const x = sp.x[i], y = sp.y[i];
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
        // keep clear of the icons
        const look = s.spd * .5, lx = s.x + Math.cos(s.ang) * look, ly = s.y + Math.sin(s.ang) * look, dd = ctx.distAt(lx, ly);
        if (dd < 50 && lx > 0 && ly > 0 && lx < W && ly < H) {
          const g = ctx.gradAt(lx, ly), ga = Math.atan2(g[1], g[0]), push = ctx.clamp(1 - dd / 50, 0, 1);
          const tang = s.ang + Math.sign(angDiff(s.ang, ga) || 1) * Math.PI * .5 * push;
          want = Math.atan2(Math.sin(tang) + Math.sin(ga) * push, Math.cos(tang) + Math.cos(ga) * push); turn = 2.6;
        }
        const d = angDiff(s.ang, want);
        s.ang += ctx.clamp(d, -turn * dt, turn * dt);
        s.x += Math.cos(s.ang) * s.spd * dt; s.y += Math.sin(s.ang) * s.spd * dt;
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
     Registration
     ==================================================================== */
  Galaxy.register(ID, {
    name: 'City-planet',
    post: { bloom: .75, threshold: 1.15, knee: .7, exposure: 1.0, vignette: .5, grain: .014, aberration: .0003, tint: [.95, .99, 1.06], lift: [0, .0005, .0016], saturation: 1.05, bloomRadius: 1.2 },

    init(ctx) {
      progCity = ctx.linkProgram(VS_FULL, '#version 300 es\n' + HDR_MRT() + CITY);
      progMain = ctx.program(MAIN);
      progNoise = ctx.program(NOISE);
      progDown1 = ctx.program(DOWN1);
      progDown2 = ctx.program(DOWN2);
      roofTex = ctx.loadTexture(TEX_ROOF, { srgb: false });
      noiseT = null;
      defineSprites(ctx);
      transports = new ctx.Flock({ count: 6, speed: 32, turn: .4, margin: 70, wander: .3, seedK: 41 });
      bolts = new ctx.Bolts();
      cruisers = []; fights = []; booms = []; hits = [];
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
      updateSpeeders(ctx);
      const nc = Math.round(3 * ctx.P.traffic);
      while (cruisers.length < nc) { const c = {}; newCruiser(ctx, c, true); cruisers.push(c); }
      cruisers.length = nc;
      for (const c of cruisers) { c.t += c.spd * ctx.dt; if (c.t > c.R) newCruiser(ctx, c, false); }
      cruisers.sort((a, b) => a.alt - b.alt);
      transports.resize(Math.round(9 * ctx.P.traffic));
      transports.update(ctx.dt, ctx.flow);
      updateFights(ctx);
    },

    render(ctx) {
      if (!full) return;
      const stable = ctx.fieldStable, intro = ctx.intro;
      const changing = !stable || intro < 1;
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
      ctx.fullscreen(progMain, {
        uSplit: fullRows, uTraffic: ctx.P.traffic, uLanes: (.3 + ctx.P.traffic) * ctx.sstep(.3, 1, intro), uSky: skyU, uSkyN: skyways.length
      }, { uA: full.A.tex, uB: full.B.tex, uCc: full.C.tex, uLA: lowc.A.tex, uLB: lowc.B.tex, uLC: lowc.C.tex, uG1: g1.tex, uG2: g2.tex, uNoise: noiseT.tex }, null);

      const t = ctx.t, show = ctx.sstep(.3, 1, intro);
      drawSpeeders(ctx);
      // searchlights sweeping up through the haze
      for (const s of searchlights) {
        const a = s.a0 + Math.sin(t * s.w + s.ph) * s.amp + t * .03;
        const c = Math.cos(a), sn = Math.sin(a);
        for (let k = 1; k <= 8; k++) {
          const f = k / 8, r = 5 + f * 34;
          ctx.glowDot(s.x + c * s.len * f, s.y + sn * s.len * f, r, [.6, .75, 1], (.075 - f * .05) * show, { core: 0, falloff: 1.6 });
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
        ctx.sprite(kind, a.x, a.y, { w: len, rot: a.ang, alpha: show, tint: wedge ? [.2, .22, .27] : [.22, .22, .24], shadow: { dx: 10, dy: 14, alpha: .55, bias: 3.6, scale: 1.05 } });
        drawShipLights(ctx, a.x, a.y, a.ang, len, 'small', t, show);
      }
      // cruisers high above
      const W = ctx.W, H = ctx.H;
      for (const c of cruisers) {
        const x = c.px + Math.cos(c.a) * c.t, y = c.py + Math.sin(c.a) * c.t;
        if (x < -c.len || y < -c.len || x > W + c.len || y > H + c.len) continue;
        const L = c.len * (.85 + .3 * c.alt);
        ctx.sprite('cruiser', x, y, { w: L, rot: c.a, alpha: show, tint: [.26, .28, .34], shadow: { dx: 26 + 20 * c.alt, dy: 34 + 26 * c.alt, alpha: .5, bias: 5.5, scale: 1.06 } });
        drawShipLights(ctx, x, y, c.a, L, 'cruiser', t + c.ph, show);
      }
      // skirmish
      for (const f of fights) for (const s of f) {
        if (!s.alive) continue;
        if (s.team === 0) {
          ctx.sprite('gunship', s.x, s.y, { w: 44, rot: s.ang, tint: [.5, .52, .55], shadow: { dx: 12, dy: 16, alpha: .5, bias: 3 } });
          ctx.glowDot(s.x - Math.cos(s.ang) * 20, s.y - Math.sin(s.ang) * 20, 4, [.5, .75, 1], 2.5);
        } else {
          ctx.sprite('droid', s.x, s.y, { w: 32, rot: s.ang, tint: [.52, .5, .48], shadow: { dx: 12, dy: 16, alpha: .5, bias: 3 } });
          ctx.glowDot(s.x + Math.cos(s.ang) * 10, s.y + Math.sin(s.ang) * 10, 1.6, [1, .3, .1], 4);
        }
        if (s.flash > 0) ctx.glowDot(s.x, s.y, 8, [1, .7, .4], 5 * s.flash);
      }
      bolts.draw();
      for (const b of booms) {
        const k = b.age / b.life, inv = 1 - k;
        ctx.glowDot(b.x, b.y, 90 * b.size, [1, .45, .15], .5 * inv * inv);
        ctx.glowDot(b.x, b.y, (6 + 26 * Math.sqrt(k)) * b.size, [1, .6, .25], 14 * inv * inv, { core: inv * 1.5 });
        for (const d of b.deb) ctx.glowDot(d.x, d.y, 1.6, [1, .55, .2], 6 * inv);
      }
    },

    dispose(ctx) {
      for (const p of [progCity, progMain, progNoise, progDown1, progDown2]) if (p) ctx.gl.deleteProgram(p.p);
      progCity = progMain = progNoise = progDown1 = progDown2 = null;
      freeCache(ctx);
      if (noiseT) ctx.freeTarget(noiseT); noiseT = null;
    }
  });
})();
