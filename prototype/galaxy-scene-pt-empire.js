// Galaxy scene "pt-empire": the city-planet at night, seen straight down.
// Layers:
//   1. City cache (MRT, re-rendered only on layout / resize / morph / grow-in): a perspective height-field march through
//      procedural districts, blocks and stepped towers. Output A = lit surface color + visible height, B = emission + light id.
//      The desktop icons sit on the roofs of the tallest tower complex (blob field), with a stepped podium around them.
//   2. Per-frame composite: window twinkle, beacon blink, sign flicker, drifting haze lit from below, lane glow, plaza rings.
//   3. Glows and sprites: thousands of speeders following blob contours and straight skyways, searchlights,
//      transports and cruisers with shadows on the city, and gunship / droid-fighter skirmishes.
(function () {
  'use strict';
  const ID = 'pt-empire';
  const LANES = [30, 52, 80, 112, 150];
  const K_LEAN = 0.085;        // perspective lean: roof offset = (p - center) * K * height
  const MAX_SPEEDERS = 3400;

  // Fragment header with two outputs for the city cache
  const HDR_MRT = () => GLSL_COMMON.replace('out vec4 outColor;', 'layout(location=0) out vec4 outColor;\nlayout(location=1) out vec4 outB;');

  /* ====================================================================
     City cache shader
     ==================================================================== */
  const CITY = `
uniform float uK;
uniform vec2 uC;
uniform float uGrow;
const float HTOP = 1.06;
const float DS = 560.;
const float FLOORS = 15.;

struct Bd { float h; float id; vec2 lc; vec2 bx; float kind; float tier; float tiers; float top; };
// kind: 0 street, 1 alley, 2 building, 3 plaza top, 4 plaza podium, 5 megaroad

vec2 C1, C2, S1, S2, MID, NRM;
vec2 sitePos(vec2 c) { return c + .15 + .7 * hash22(c + 17.17); }
void setupDistrict(vec2 p) {
  vec2 off = vec2(uSeed * 1.37, uSeed * .71);
  vec2 q = p / DS + off;
  vec2 n = floor(q), f = fract(q); float d1 = 1e9, d2 = 1e9; vec2 s1 = n, s2 = n;
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
  bs = mix(110., 185., hash12(cid + 9.1));
  org = hash22(cid + 1.3) * 500.;
  dens = hash12(cid + 5.5);
}
vec2 proj(vec2 p, float h) { return uC + (p - uC) / (1. + uK * h); }

Bd bld(vec2 b) {
  Bd o; o.h = 0.; o.id = 0.; o.lc = vec2(0); o.bx = vec2(1); o.kind = 0.; o.tier = 0.; o.tiers = 1.; o.top = 0.;
  float sd = dot(b - MID, NRM);
  vec2 cid = sd > 0. ? C2 : C1;
  float mw = 6. + 6. * hash12(C1 + C2 * 1.7);
  if (abs(sd) < mw) {
    o.kind = 5.; o.lc = vec2(sd, dot(b, vec2(-NRM.y, NRM.x))); o.bx = vec2(mw);
  } else {
    float ang, bs, dens; vec2 org; distParams(cid, ang, bs, org, dens);
    vec2 q = rot2(ang) * (b - org);
    vec2 cell = floor(q / bs); vec2 f = q - cell * bs;
    float sw = 3. + 3.5 * hash12(cell + cid * 7.);
    vec2 sdist = min(f, bs - f);
    if (min(sdist.x, sdist.y) < sw) {
      o.kind = 0.; o.lc = vec2(min(sdist.x, sdist.y), sdist.x < sdist.y ? q.y : q.x); o.bx = vec2(sw);
    } else {
      vec2 lo = vec2(sw), hi = vec2(bs - sw); float id = hash12(cell * 1.31 + cid * 13.1);
      for (int i = 0; i < 4; i++) {
        vec2 sz = hi - lo; if (max(sz.x, sz.y) < 34.) break;
        float r1 = hash12(vec2(id * 71.3, float(i) + .5));
        bool sx = sz.x > sz.y * 1.25 ? true : (sz.y > sz.x * 1.25 ? false : r1 < .5);
        float t = mix(.3, .7, hash12(vec2(id * 37.1, float(i) + 7.)));
        if (sx) { float m = mix(lo.x, hi.x, t); if (f.x < m) { hi.x = m; id = hash12(vec2(id * 91.7, 1.3)); } else { lo.x = m; id = hash12(vec2(id * 91.7, 2.9)); } }
        else { float m = mix(lo.y, hi.y, t); if (f.y < m) { hi.y = m; id = hash12(vec2(id * 91.7, 3.7)); } else { lo.y = m; id = hash12(vec2(id * 91.7, 4.1)); } }
      }
      float ag = .9 + 1.5 * hash12(vec2(id, 8.3));
      vec2 ctr = (lo + hi) * .5, hs = (hi - lo) * .5 - ag, lc = f - ctr;
      o.id = id;
      if (any(greaterThan(abs(lc), hs))) { o.kind = 1.; o.lc = lc; o.bx = hs; }
      else {
        vec2 cs = org + rot2(-ang) * (cell * bs + ctr);
        float r = hash12(vec2(id, 4.1));
        float h = .05 + .40 * pow(r, 1.7);
        float dn = vnoise(cs * .0017 + uSeed * 3.);
        h *= .42 + 1.15 * dn * dn + .3 * dens;
        float bb = iconBlob(uC + (cs - uC) * (1. + uK * .85));
        float boost = smoothstep(300., 0., bb);
        h = mix(h, max(h, .5 + .3 * r), boost * boost);
        if (bb < 0.) h = max(h, .66 + .2 * r);
        h = min(h, .9);
        float dl = hash12(vec2(id, 6.6)) * .35 + clamp(bb / 1100., 0., .4);
        h *= max(smoothstep(dl, dl + .3, uGrow), .012);
        float r3 = hash12(vec2(id, 2.2)), r4 = hash12(vec2(id, 3.3));
        float tiers = (h > .45 && r3 > .22) ? 3. : (h > .2 && r3 > .38) ? 2. : 1.;
        vec2 off = (hash22(vec2(id, 5.)) - .5) * hs * .3;
        vec2 bx = hs, l = lc; float H = h, tier = 0.;
        if (tiers > 1.) {
          H = h * (tiers > 2. ? .6 : .72);
          vec2 hs2 = hs * mix(.55, .8, r4);
          if (all(lessThan(abs(lc - off), hs2))) {
            tier = 1.; bx = hs2; l = lc - off; H = tiers > 2. ? h * .82 : h;
            if (tiers > 2.) { vec2 hs3 = hs2 * mix(.42, .66, r3); if (all(lessThan(abs(l), hs3))) { tier = 2.; bx = hs3; H = h; } }
          }
        }
        o.kind = 2.; o.h = H; o.lc = l; o.bx = bx; o.tier = tier; o.tiers = tiers; o.top = h;
      }
    }
  }
  // Icon tower complex: the top deck hugs the icon cells and lands exactly under them,
  // while the ordinary buildings inside the merged blob rise into a cluster of tall towers around it
  float hp = smoothstep(0., .5, uGrow);
  if (hp > o.h) {
    vec2 rp = uC + (b - uC) * (1. + uK * hp);
    float bl = iconBlob(rp);
    float dk = max(bl, iconDist(rp) - 20.);
    if (dk < 0.) { o.h = hp; o.kind = 3.; o.lc = rp; o.bx = vec2(dk, bl); o.top = hp; o.id = .5; }
  }
  return o;
}

const vec3 SODIUM = vec3(1., .52, .17);
const vec3 COOLW = vec3(.78, .88, 1.);
const vec3 TEAL = vec3(.15, 1., .85);
const vec3 MAGENTA = vec3(1., .18, .75);
const vec3 GOLD = vec3(1., .74, .38);

vec3 neon(float r) { return r < .4 ? TEAL : r < .75 ? MAGENTA : r < .9 ? vec3(.35, .55, 1.) : vec3(1., .3, .2); }

// Facade with windows. along = coordinate along the wall (px), hw = height on the facade, top = box roof height
void facade(float along, float la, float bxa, float hw, float top, float id, float face, vec2 p, bool plaza, out vec3 col, out vec3 em, out float eid) {
  float rowPx = length(p - uC) * uK / FLOORS;
  float fl = hw * FLOORS; float row = floor(fl), rf = fract(fl);
  float cw = plaza ? 3. : 3.6;
  float cx = floor(along / cw), cf = fract(along / cw);
  float lit01 = hw / max(top, .01);
  col = vec3(.012, .016, .026) * (face > .5 ? 1.25 : .8) * (.55 + .7 * hw);
  // floor slabs read as thin lighter lines when floors are big enough
  col *= 1. + .35 * smoothstep(.9, .97, rf) * smoothstep(1., 2., rowPx);
  float win = smoothstep(.12, .24, cf) * smoothstep(.88, .76, cf) * smoothstep(.16, .32, rf) * smoothstep(.84, .68, rf);
  float aa = smoothstep(1., 2.2, rowPx);
  win = mix(.42, win, aa);
  float wh = hash12(vec2(cx, row) + id * 113.7);
  float occ = plaza ? .78 : mix(.18, .72, hash12(vec2(id, 2.)));
  float dark = step(hash12(vec2(row, id * 17.)), plaza ? .05 : .16);
  float lit = step(wh, occ) * (1. - dark);
  float pr = hash12(vec2(id, 7.));
  vec3 wc = plaza ? mix(COOLW, GOLD, step(.7, hash12(vec2(cx * .37, row)))) : (pr < .55 ? SODIUM : pr < .84 ? COOLW : pr < .92 ? mix(SODIUM, COOLW, .5) : vec3(.6, 1., .9));
  float inten = (plaza ? 2.2 : 1.35) * (.55 + .9 * hash12(vec2(cx, row * 3.1) + id));
  em = wc * win * lit * inten * (.75 + .25 * lit01);
  eid = .01 + .44 * wh;
  // vertical light piers on some towers
  float pier = step(.82, hash12(vec2(id, 21.)));
  if (pier > .5) { float ps = abs(fract(along / 9.) - .5); em += GOLD * smoothstep(.06, .0, ps) * 1.6 * lit01; }
  // neon signs: corner strips and holo panels
  float sg = hash12(vec2(id, 12.));
  if (!plaza && sg < .16) {
    vec3 nc = neon(hash12(vec2(id, 13.)));
    if (abs(la) > bxa - 1.1 && lit01 > .25) { em = nc * 5.; eid = .47; }
    float y0 = top * mix(.45, .7, hash12(vec2(id, 14.))), y1 = y0 + top * .12;
    float x0 = -bxa * .6, x1 = bxa * mix(-.1, .5, hash12(vec2(id, 15.)));
    if (hw > y0 && hw < y1 && la > x0 && la < x1) {
      float scan = .7 + .3 * sin(hw * 240.);
      em = nc * 2.6 * scan; eid = .46; col += nc * .02;
    }
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
  Bd R = bld(proj(p, I.h));
  if (R.h >= I.h - .002) {
    // ------------------------------------------------ roof or ground
    hs = R.h;
    vec2 l = R.lc, bx = R.bx;
    if (R.kind == 2.) {
      float h = R.h, id = R.id;
      float e = min(bx.x - abs(l.x), bx.y - abs(l.y));
      float r = hash12(vec2(id, 11. + R.tier));
      vec3 base = mix(vec3(.014, .019, .03), vec3(.03, .032, .038), r);
      base *= .45 + 1.1 * h;
      float rim = smoothstep(1.3, .3, e);
      col = base * (1. + rim * 1.6) * (.72 + .28 * smoothstep(.6, 3.2, e)) + vec3(.004, .009, .018) * rim * h;
      // tier ledge AO: lower tiers darken toward the tower above
      if (R.tier < R.tiers - 1.) col *= .8;
      // greebles: vents, AC blocks, small domes
      vec2 g = l + bx; vec2 gc = floor(g / 4.5), gf = fract(g / 4.5);
      float gh = hash12(gc + id * 31.);
      if (e > 2.2 && gh > .7) {
        vec2 bsz = vec2(.18, .18) + .2 * hash22(gc + id);
        float sb = sdBox(gf - .5, bsz);
        col = mix(col, col * 1.8 + .006, smoothstep(.04, -.02, sb));
        col *= 1. - .4 * smoothstep(.12, 0., sdBox(gf - .5 - vec2(.08, .1), bsz)) * step(0., sb);
        if (gh > .985) { em = vec3(1., .1, .05) * 2.5 * smoothstep(.12, .02, length(gf - .5)); eid = .5 + .5 * hash12(gc); }
      }
      float mn = min(bx.x, bx.y);
      bool topTier = R.tier == R.tiers - 1.;
      if (mn > 10. && r > .87 && topTier) {
        // landing pad
        float d = length(l), rr = mn * .74;
        col = mix(col, vec3(.03, .034, .04) * (.7 + h), smoothstep(rr + .5, rr - .5, d));
        float ring = smoothstep(.7, .1, abs(d - rr * .86));
        float a = atan(l.y, l.x);
        float dash = step(.5, fract(a / 6.2832 * 16.));
        em += mix(GOLD, COOLW, step(.5, hash12(vec2(id, 1.)))) * ring * dash * 2.2;
        col += vec3(.05) * smoothstep(.5, .1, abs(d - rr * .45)) * (.5 + .5 * step(.4, fract(a / 6.2832 * 4.)));
        eid = em.r > 0. ? .003 : eid;
      } else if (r < .1 && R.tier == 0. && mn > 6.) {
        // rooftop garden
        float n = fbm(g * .45 + id * 9., 4);
        col = mix(col, vec3(.012, .03, .016) * (1.2 + n), smoothstep(1.8, 2.6, e));
        float lamp = step(.93, hash12(floor(g / 2.3) + id)) * smoothstep(1.8, 2.6, e);
        em += GOLD * lamp * 1.4; eid = lamp > 0. ? .2 : eid;
      } else if (r > .58 && r < .66 && e > 1.4) {
        // glass skylight roof glowing from inside
        vec2 gg = fract(g / 2.2);
        float pane = smoothstep(.0, .15, min(min(gg.x, 1. - gg.x), min(gg.y, 1. - gg.y)));
        em += mix(SODIUM, COOLW, hash12(vec2(id, 3.))) * pane * .22 * smoothstep(1.4, 3., e);
        eid = .003;
      }
      // parapet running lights on tall towers
      if (R.top > .55 && e < .8 && topTier) {
        float per = abs(l.x) / bx.x > abs(l.y) / bx.y ? l.y : l.x;
        float dot_ = step(fract(per / 4.), .3) * step(.6, hash12(vec2(id, 31.)));
        em += mix(GOLD, COOLW, hash12(vec2(id, 32.))) * dot_ * 1.6; eid = dot_ > 0. ? .003 : eid;
      }
      // aircraft warning beacons on the tallest roofs
      if (R.top > .48 && topTier) {
        float cd = length(bx - abs(l) - 1.);
        if (cd < 1.4) { em = vec3(1., .06, .03) * 12. * smoothstep(1.4, .4, cd); eid = .5 + .5 * hash12(vec2(id, 9.)); }
      }
    } else if (R.kind == 3.) {
      // icon tower roof: calm dark deck, faint panels, bright bevel at the edge
      vec2 rp = l; float dk = bx.x;
      vec3 c = vec3(.04, .046, .06);
      // recessed landing field under the icons, faint plating
      float inner = smoothstep(-9., -11., dk);
      vec2 gg = fract(rp / 12.); float seam = min(min(gg.x, 1. - gg.x), min(gg.y, 1. - gg.y));
      c *= mix(1.25, .8 + .1 * smoothstep(0., .06, seam), inner);
      c *= 1. - .12 * smoothstep(-11., -40., dk);
      // raised crown with bright bevel and a row of deck lights
      float crown = smoothstep(-11., -9., dk) * smoothstep(-1., -2.5, dk);
      c += vec3(.03, .04, .05) * crown;
      c += vec3(.08, .1, .12) * smoothstep(-2.5, -.8, dk);
      c *= 1. - .5 * smoothstep(1.5, 0., abs(dk + 10.));
      vec2 lg = fract(rp / 5.) - .5;
      float dl = smoothstep(.22, .08, length(lg)) * smoothstep(1.2, .3, abs(dk + 6.));
      em = COOLW * dl * 2.; eid = dl > 0. ? .2 : 0.;
      col = c;
    } else if (R.kind == 6.) {
      // terrace of the tower complex: dense rooftop machinery between the deck and the blob edge
      vec2 rp = l; float bl = bx.x;
      vec3 c = vec3(.04, .042, .05);
      vec2 gc = floor(rp / 7.), gf = fract(rp / 7.);
      float gh = hash12(gc + 3.3);
      float m = smoothstep(.05, -.02, sdBox(gf - .5, vec2(.18 + .2 * hash12(gc + 1.))));
      c = mix(c, c * (gh > .5 ? 1.9 : .55), m * step(.35, gh));
      vec2 g2 = fract(rp / 3.); c *= .9 + .1 * step(.5, g2.x);
      c += vec3(.03, .04, .05) * smoothstep(-5., -.5, bl);
      float lamp = step(.988, hash12(floor(rp / 2.5) + 9.));
      em = mix(GOLD, COOLW, hash12(floor(rp / 2.5))) * lamp * 1.6; eid = lamp > 0. ? .3 : 0.;
      if (gh > .97) { em += vec3(1., .07, .03) * 7. * smoothstep(.2, .05, length(gf - .5)); eid = .5 + .5 * hash12(gc); }
      col = c;
    } else if (R.kind == 4.) {
      // podium terrace around the icon tower
      vec2 rp = l; float bl = bx.x;
      vec3 c = vec3(.03, .033, .04) * 1.2;
      vec2 gc = floor(rp / 5.), gf = fract(rp / 5.);
      float gh = hash12(gc + 7.7);
      if (gh > .62 && bl > 4. && bl < 17.) c = mix(c, c * 1.9, smoothstep(.05, -.02, sdBox(gf - .5, vec2(.2 + .15 * hash12(gc)))));
      c += vec3(.03, .04, .05) * smoothstep(16., 21., bl);
      col = c;
      float row = smoothstep(1., .2, abs(bl - 18.5));
      float dash = step(.55, fract((rp.x - rp.y) * .11));
      em = GOLD * row * dash * 2.6; eid = .003;
      float inner = smoothstep(1., .2, abs(bl - 2.)) * step(.5, fract((rp.x + rp.y) * .08));
      em += COOLW * inner * 1.2;
      // icon-cell corner lights are added on the CPU
    } else {
      // ground level: streets, alleys, megaroads, deep in the canyons
      if (R.kind == 0.) {
        float across = l.x, along = l.y;
        col = vec3(.011, .010, .011);
        float lamp = smoothstep(.75, .15, length(vec2(across - (bx.x - .9), (fract(along / 9.) - .5) * 9.))) * step(.25, hash12(vec2(floor(along / 9.), floor(across)) ));
        em = SODIUM * lamp * 1.3; eid = lamp > 0. ? .003 : 0.;
        float lane = smoothstep(.9, .2, across) * step(.4, fract(along / 3.1 + hash12(floor(vec2(along / 40.)))));
        em += mix(vec3(1., .12, .06), COOLW, step(.5, hash12(floor(vec2(along / 23., across))))) * lane * .45;
      } else if (R.kind == 5.) {
        float sd = l.x, along = l.y, mw = bx.x;
        col = vec3(.008, .008, .011);
        float band = smoothstep(.3, .0, abs(fract(abs(sd) / 2.6) - .5) * 2.6 - .9);
        float dash = step(.35, fract(along / 4. + hash12(vec2(floor(abs(sd) / 2.2), sign(sd))) * 9.));
        vec3 lc = sd > 0. ? COOLW * .8 : SODIUM;
        em = lc * band * dash * smoothstep(mw, mw - 2., abs(sd)) * .16; eid = .003;
        em += SODIUM * smoothstep(1., .2, abs(abs(sd) - mw + .8)) * step(.8, fract(along / 9.)) * .22;
      } else {
        col = vec3(.006, .006, .007);
        float lamp = step(.985, hash12(floor(p / 3.))) ;
        em = SODIUM * lamp * .9; eid = .003;
      }
    }
  } else {
    // ------------------------------------------------ wall
    float lo = hh, hi = hPrev; Bd Wb = I;
    for (int k = 0; k < 6; k++) { float m = (lo + hi) * .5; Bd t = bld(proj(p, m)); if (t.h >= m) { lo = m; Wb = t; } else hi = m; }
    float hw = lo; hs = hw;
    if (Wb.kind == 3. || Wb.kind == 4. || Wb.kind == 6.) {
      vec2 u = normalize(p - uC + 1e-3);
      float along = dot(p, vec2(-u.y, u.x));
      facade(along, along, 1e3, hw, Wb.h, Wb.kind * 3.1, .7, p, true, col, em, eid);
      // bright trim lines at the top of each step
      float trim = smoothstep(.006, .0, abs(hw - Wb.h + .006));
      em += COOLW * trim * 2.5;
    } else {
      vec2 l = Wb.lc, bx = Wb.bx; vec2 ed = bx - abs(l);
      bool fx = ed.x < ed.y;
      float la = fx ? l.y : l.x, bxa = fx ? bx.y : bx.x;
      float face = fx ? (l.x > 0. ? 1. : 0.) : (l.y > 0. ? .6 : .2);
      facade(la + Wb.id * 977. + (fx ? 300. : 0.), la, bxa, hw, Wb.h, Wb.id + Wb.tier * .17, face, p, false, col, em, eid);
      // corner edge highlight
      col *= 1. + .9 * smoothstep(1., .2, bxa - abs(la));
    }
    // reflected glow of the streets on the lower facade
    col += vec3(.05, .025, .012) * pow(1. - clamp(hw / .5, 0., 1.), 3.) * .35;
  }
  // ambient occlusion from the neighbouring towers (sampled in base space)
  vec2 b0 = proj(p, hs);
  float ao = 0.;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * .7854 + .39;
    vec2 dv = vec2(cos(a), sin(a));
    Bd t1 = bld(b0 + dv * 5.); Bd t2 = bld(b0 + dv * 14.);
    ao += clamp((t1.h - hs) * 6., 0., 1.) * .6 + clamp((t2.h - hs) * 3., 0., 1.) * .4;
  }
  ao /= 8.;
  col *= 1. - .82 * ao;
  // depth: deeper surfaces are darker
  col *= .22 + .78 * smoothstep(0., .6, hs);
  outColor = vec4(col, hs);
  outB = vec4(em, eid);
}`;

  /* ====================================================================
     Per-frame composite
     ==================================================================== */
  const MAIN = `
uniform sampler2D uA, uB;
uniform float uTraffic, uLanes;
uniform vec4 uSky[4];
uniform float uSkyN;
const float LANES[5] = float[5](${LANES.map(v => v.toFixed(1)).join(',')});
void main() {
  vec2 p = cssPos();
  vec4 A = texture(uA, vUv), B = texture(uB, vUv);
  float h = A.a;
  vec3 col = A.rgb;
  float eid = B.a, tw = 1.;
  if (eid >= .5) {
    float ph = (eid - .5) * 2.;
    float s = fract(uTime * .5 + ph * 7.);
    tw = smoothstep(0., .03, s) * smoothstep(.2, .08, s) * 1.25 + .05;
  } else if (eid > .455) {
    float fl = step(.06, hash12(vec2(floor(uTime * 9.), eid * 997.)));
    tw = (.82 + .18 * sin(uTime * 11. + eid * 400.)) * mix(.25, 1., fl);
  } else if (eid > .005) {
    float r = fract(eid * 173.3);
    if (r < .08) tw = step(.4, fract(uFlow * .02 * (1. + r * 12.) + r * 31.));
  }
  float dI = iconDist(p);
  float wave = smoothstep(0., .2, uIntro * 1.5 - .2 - max(dI, 0.) / 2600. - fract(eid * 91.7) * .2);
  float lvl = mix(.45, 1.35, smoothstep(.3, .7, fbm(p * .0011 + uSeed * 5. + 2., 3)));
  lvl *= 1. + .9 * exp(-max(iconBlob(p), 0.) / 110.);
  col += B.rgb * tw * wave * (eid >= .5 ? 1. : lvl);

  // haze lit from below
  vec2 drift = vec2(uFlow * 5.5, uFlow * 1.7);
  float n1 = fbm((p + drift) * .0021 + uSeed, 5);
  float n2 = fbm(p * .0045 - drift * .007 + 7.3, 3);
  float zone = fbm(p * .0008 + uSeed * 2., 3);
  vec3 warm = vec3(1., .45, .14), mag = vec3(.7, .22, .6), cool = vec3(.12, .3, .6);
  vec3 fogC = mix(warm, mag, smoothstep(.45, .75, zone) * .7);
  float low = pow(1. - clamp(h, 0., 1.), 2.4);
  float dens = low * (.15 + 1.3 * smoothstep(.3, .8, n1));
  col = col * (1. - .4 * dens) + fogC * dens * .016;
  float cl = smoothstep(.45, .85, n2 * .55 + n1 * .65);
  float under = smoothstep(.8, .35, h);
  col = mix(col, fogC * .02 + cool * .012, cl * under * .45);
  col += fogC * cl * low * .02;
  // light dome over the icon tower clusters
  col += mix(fogC, vec3(.3, .6, 1.), .4) * exp(-max(iconBlob(p), 0.) / 140.) * .018;
  float hv = smoothstep(.56, .9, fbm((p + drift * 2.6) * .0011 + 3., 4));
  col = col * (1. - hv * .25) + mix(cool, fogC, .25) * hv * .012;

  // traffic lane glow along the blob contours and skyways
  float bl = iconBlob(p);
  float lane = 0.;
  for (int i = 0; i < 5; i++) { float d = bl - LANES[i]; lane += exp(-d * d / 7.) * (1. - float(i) * .15); }
  float sky = 0.;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uSkyN) break;
    vec4 s = uSky[i]; float d = dot(p - s.xy, vec2(-s.w, s.z));
    sky += exp(-d * d / 30.);
  }
  sky *= smoothstep(14., 50., dI);
  col += vec3(1., .7, .45) * (lane * .03 + sky * .03) * uLanes;

  // icon tower: lit edge of the top deck, chasing lights along the terrace edge
  float plz = smoothstep(.15, .5, uIntro);
  float dk = max(bl, dI - 20.);
  float ring = exp(-pow((dk + 2.2) / 1.1, 2.));
  float chase = .5 + .5 * sin((p.x - p.y) * .13 - uFlow * 2.4);
  col += vec3(.3, .8, 1.) * ring * (.9 + .9 * chase) * plz;
  col += vec3(.1, .4, .6) * exp(-max(dk, 0.) / 16.) * step(0., dk) * .05 * plz;

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
        for (let i = 0; i < 520; i++) {
          const x = rng() * w * .95, y = sgn > 0 ? -rng() * h * .4 : rng() * h * .4, pw = 6 + rng() * 40, ph = 3 + rng() * 9;
          if (Math.abs(y) > x * .5) continue;
          g.fillStyle = rng() < .5 ? `rgba(255,255,255,${.04 + rng() * .1})` : `rgba(0,0,0,${.06 + rng() * .16})`;
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
  let progCity = null, progMain = null, cacheA = null, cacheB = null, mrtFB = null, mrtT = null;
  let dirty = true, frame = 0, lastStable = true, lastIntro = 0;
  let skyways = [], skyU = new Float32Array(16), searchlights = [], beacons = [];
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

  function makeCache(ctx) {
    const gl = ctx.gl;
    freeCache(ctx);
    cacheA = ctx.makeTarget(ctx.pxW, ctx.pxH, { nearest: true });
    cacheB = ctx.makeTarget(ctx.pxW, ctx.pxH, { nearest: true });
    mrtFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, mrtFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cacheA.tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, cacheB.tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) console.warn('[pt-empire] MRT framebuffer incomplete', st);
    mrtT = { fb: mrtFB, w: ctx.pxW, h: ctx.pxH };
    dirty = true;
  }
  function freeCache(ctx) {
    if (cacheA) ctx.freeTarget(cacheA); if (cacheB) ctx.freeTarget(cacheB);
    if (mrtFB) ctx.gl.deleteFramebuffer(mrtFB);
    cacheA = cacheB = mrtFB = mrtT = null;
  }

  function planFeatures(ctx) {
    const rng = ctx.rng(77), W = ctx.W, H = ctx.H;
    // skyways: long straight lanes across the screen
    skyways = [];
    const nS = ctx.icons.length ? 2 : 4;
    for (let i = 0; i < nS; i++) {
      const a = (rng() - .5) * 1.2 + (i === 1 ? Math.PI / 2 : 0) + (rng() < .5 ? 0 : 0.35);
      skyways.push({ x: W * (.2 + .6 * rng()), y: H * (.2 + .6 * rng()), dx: Math.cos(a), dy: Math.sin(a) });
    }
    skyU.fill(0);
    skyways.forEach((s, i) => { skyU[i * 4] = s.x; skyU[i * 4 + 1] = s.y; skyU[i * 4 + 2] = s.dx; skyU[i * 4 + 3] = s.dy; });
    // searchlights on open ground away from icons
    searchlights = [];
    for (let i = 0, tries = 0; i < 5 && tries < 200; tries++) {
      const x = rng() * W, y = rng() * H;
      if (iconDistCPU(ctx, x, y) < 160) continue;
      if (searchlights.some(s => Math.hypot(s.x - x, s.y - y) < 260)) continue;
      searchlights.push({ x, y, a0: rng() * 6.28, amp: .6 + rng() * .9, w: .12 + rng() * .18, ph: rng() * 6.28, len: 200 + rng() * 160 }); i++;
    }
    // corner beacons on the outer corners of the icon cells
    beacons = [];
    const ics = ctx.icons, seen = new Set();
    const inside = (x, y) => ics.some(ic => x > ic.x - 2 && x < ic.x + ic.w + 2 && y > ic.y - 2 && y < ic.y + ic.h + 2);
    for (const ic of ics) {
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const cx = sx < 0 ? ic.x : ic.x + ic.w, cy = sy < 0 ? ic.y : ic.y + ic.h;
        if (inside(cx + sx * 14, cy + sy * 14) || inside(cx + sx * 14, cy - sy * 14) || inside(cx - sx * 14, cy + sy * 14)) continue;
        const key = Math.round(cx / 8) + ',' + Math.round(cy / 8); if (seen.has(key)) continue; seen.add(key);
        beacons.push({ x: cx + sx * 3, y: cy + sy * 3, ph: ((cx * 0.013 + cy * 0.007) % 1) });
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
      // score: how little of the path runs over or right beside the icons
      let bad = 0, mn = 1e9;
      for (let t = -R; t <= R; t += R / 30) {
        const x = px + Math.cos(a) * t, y = py + Math.sin(a) * t;
        if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
        const d = iconDistCPU(ctx, x, y); mn = Math.min(mn, d);
        if (d < 110) bad += 1 + (110 - d) / 40;
      }
      const sc = -bad + Math.min(mn, 300) * .01;
      if (sc > bestS) { bestS = sc; best = { a, px, py }; }
    }
    c.len = 200 + Math.random() * 140;
    c.spd = 7 + Math.random() * 7;
    c.a = best.a; c.px = best.px; c.py = best.py; c.R = R + c.len;
    c.t = initial ? (Math.random() - .5) * R * 1.3 : -c.R;
    c.alt = .6 + Math.random() * .4;
    c.ph = Math.random() * 10;
  }

  // Speeders
  function spawnSpeeder(ctx, i) {
    const W = ctx.W, H = ctx.H;
    sp.live[i] = 0;
    const useSky = skyways.length && (Math.random() < .2 || !ctx.icons.length);
    if (useSky) {
      const k = (Math.random() * skyways.length) | 0, s = skyways[k], R = Math.hypot(W, H) * .6;
      const lane = (Math.random() * 4) | 0, off = [-7, -2.6, 2.6, 7][lane];
      sp.kind[i] = 1 + k; sp.off[i] = off; sp.dir[i] = off > 0 ? 1 : -1;
      sp.u[i] = (Math.random() * 2 - 1) * R; sp.spd[i] = 70 + Math.random() * 60;
      sp.live[i] = 1; return;
    }
    for (let tries = 0; tries < 6; tries++) {
      let x = Math.random() * W, y = Math.random() * H;
      const dir = Math.random() < .5 ? 1 : -1;
      let b0 = ctx.blobAt(x, y);
      if (b0 > 200) continue;
      let L = LANES[0]; for (const l of LANES) if (Math.abs(l - b0) < Math.abs(L - b0)) L = l;
      const tgt = L + dir * 2.4;
      let ok = true;
      for (let k = 0; k < 4; k++) {
        const b = ctx.blobAt(x, y), g = ctx.gradAt(x, y, ctx.blobAt), gl = Math.hypot(g[0], g[1]);
        if (gl < .3) { ok = false; break; }
        x -= g[0] / gl * (b - tgt) / gl; y -= g[1] / gl * (b - tgt) / gl;
      }
      if (!ok || Math.abs(ctx.blobAt(x, y) - tgt) > 3 || x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
      sp.kind[i] = 0; sp.x[i] = x; sp.y[i] = y; sp.tgt[i] = tgt; sp.dir[i] = dir; sp.spd[i] = 45 + Math.random() * 55; sp.live[i] = 1; sp.vx[i] = 0; sp.vy[i] = 0;
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
      if (!sp.live[i]) { sp.cool[i] -= ctx.rawDt; if (sp.cool[i] <= 0 && spawns < 200) { spawns++; spawnSpeeder(ctx, i); } continue; }
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
      sp.vx[i] = tx; sp.vy[i] = ty;
      if (sp.x[i] < -20 || sp.y[i] < -20 || sp.x[i] > W + 20 || sp.y[i] > H + 20) { sp.live[i] = 0; sp.cool[i] = .1; }
    }
  }
  function drawSpeeders(ctx) {
    const fade = ctx.sstep(.35, 1, ctx.intro); if (fade <= 0) return;
    const t = ctx.t;
    for (let i = 0; i < sp.n; i++) {
      if (!sp.live[i]) continue;
      const x = sp.x[i], y = sp.y[i];
      let a = fade;
      if (sp.kind[i] > 0) { const d = ctx.distAt(x, y); if (d < 50) a *= ctx.sstep(14, 50, d); if (a < .02) continue; }
      const len = 1.5 + sp.spd[i] * .025;
      const white = sp.dir[i] > 0;
      let col = white ? [.85, .92, 1] : [1, .13, .06];
      let inten = (white ? 3.4 : 2.9) * a;
      if (i % 53 === 0) { const on = Math.sin(t * 14 + i) > 0; col = on ? [.3, .5, 1] : [1, .15, .2]; inten = 6 * a; }
      ctx.glowLine(x - sp.vx[i] * len, y - sp.vy[i] * len, x, y, 1., col, inten, { core: 1.2, coreR: .45 });
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
    post: { bloom: .8, threshold: 1.25, knee: .7, exposure: 1.05, vignette: .5, grain: .022, aberration: .0004, tint: [.94, .98, 1.07], lift: [0, .0006, .0025], saturation: 1.1, bloomRadius: 1.15 },

    init(ctx) {
      progCity = ctx.linkProgram(VS_FULL, '#version 300 es\n' + HDR_MRT() + CITY);
      progMain = ctx.program(MAIN);
      defineSprites(ctx);
      transports = new ctx.Flock({ count: 6, speed: 36, turn: .45, margin: 60, wander: .35, seedK: 41 });
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
      // cruisers
      const nc = Math.round(3 * ctx.P.traffic);
      while (cruisers.length < nc) { const c = {}; newCruiser(ctx, c, true); cruisers.push(c); }
      cruisers.length = nc;
      for (const c of cruisers) { c.t += c.spd * ctx.dt; if (c.t > c.R) newCruiser(ctx, c, false); }
      cruisers.sort((a, b) => a.alt - b.alt);
      transports.resize(Math.round(10 * ctx.P.traffic));
      transports.update(ctx.dt, ctx.flow);
      updateFights(ctx);
    },

    render(ctx) {
      const stable = ctx.fieldStable, intro = ctx.intro;
      const need = dirty || (!stable && frame % 3 === 0) || (intro < 1 && frame % 2 === 0) || (stable && !lastStable) || (intro >= 1 && lastIntro < 1);
      if (need && mrtT) {
        ctx.gl.disable(ctx.gl.BLEND);
        ctx.fullscreen(progCity, { uK: K_LEAN, uC: [ctx.W / 2, ctx.H / 2], uGrow: intro }, {}, mrtT);
        dirty = false;
      }
      lastStable = stable; lastIntro = intro;
      ctx.fullscreen(progMain, { uTraffic: ctx.P.traffic, uLanes: (.25 + ctx.P.traffic) * ctx.sstep(.3, 1, intro), uSky: skyU, uSkyN: skyways.length }, { uA: cacheA.tex, uB: cacheB.tex }, null);

      const t = ctx.t, show = ctx.sstep(.3, 1, intro);
      drawSpeeders(ctx);
      // searchlights sweeping the haze
      for (const s of searchlights) {
        const a = s.a0 + Math.sin(t * s.w + s.ph) * s.amp + t * .05;
        const c = Math.cos(a), sn = Math.sin(a);
        for (let k = 1; k <= 10; k++) {
          const f = k / 10, r = 6 + f * 30;
          ctx.glowDot(s.x + c * s.len * f, s.y + sn * s.len * f, r, [.55, .7, 1], (.16 - f * .1) * show, { core: 0, falloff: 1.6 });
        }
        ctx.glowDot(s.x, s.y, 4, [.8, .9, 1], 3 * show, { core: 1 });
      }
      // icon corner beacons
      for (const b of beacons) {
        const ph = (t * .6 + b.ph) % 1, on = ctx.sstep(0, .04, ph) * (1 - ctx.sstep(.18, .3, ph));
        ctx.glowDot(b.x, b.y, 2.4, [1, .08, .04], (.4 + 7 * on) * show, { core: .8 });
      }
      // transports
      for (const a of transports.agents) {
        const wedge = a.id % 3 === 0, kind = wedge ? 'cruiser' : 'shuttle', len = wedge ? 56 + (a.id % 5) * 6 : 34 + (a.id % 7) * 3;
        ctx.sprite(kind, a.x, a.y, { w: len, rot: a.ang, alpha: show, tint: wedge ? [.34, .35, .4] : [.32, .31, .3], shadow: { dx: 22, dy: 30, alpha: .5, bias: 3.2 } });
        drawShipLights(ctx, a.x, a.y, a.ang, len, 'small', t, show);
      }
      // cruisers high above
      const W = ctx.W, H = ctx.H;
      for (const c of cruisers) {
        const x = c.px + Math.cos(c.a) * c.t, y = c.py + Math.sin(c.a) * c.t;
        if (x < -c.len || y < -c.len || x > W + c.len || y > H + c.len) continue;
        const L = c.len * (.85 + .3 * c.alt);
        ctx.sprite('cruiser', x, y, { w: L, rot: c.a, alpha: show, tint: [.3, .32, .37], shadow: { dx: 60 + 50 * c.alt, dy: 80 + 60 * c.alt, alpha: .55, bias: 5.5, scale: 1.04 } });
        drawShipLights(ctx, x, y, c.a, L, 'cruiser', t + c.ph, show);
      }
      // skirmish
      for (const f of fights) for (const s of f) {
        if (!s.alive) continue;
        if (s.team === 0) {
          ctx.sprite('gunship', s.x, s.y, { w: 34, rot: s.ang, tint: [.6, .6, .62], shadow: { dx: 16, dy: 22, alpha: .45, bias: 2.8 } });
          ctx.glowDot(s.x - Math.cos(s.ang) * 16, s.y - Math.sin(s.ang) * 16, 4, [.5, .75, 1], 2.5);
        } else {
          ctx.sprite('droid', s.x, s.y, { w: 26, rot: s.ang, tint: [.6, .58, .56], shadow: { dx: 16, dy: 22, alpha: .45, bias: 2.8 } });
          ctx.glowDot(s.x + Math.cos(s.ang) * 8, s.y + Math.sin(s.ang) * 8, 1.6, [1, .3, .1], 4);
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
      if (progCity) ctx.gl.deleteProgram(progCity.p);
      if (progMain) ctx.gl.deleteProgram(progMain.p);
      progCity = progMain = null;
      freeCache(ctx);
    }
  });
})();
