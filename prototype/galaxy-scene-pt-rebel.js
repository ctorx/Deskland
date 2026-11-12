// Galaxy theme · Prequel trilogy, Rebellion side: "Lake country".
// Straight down onto a serene lake on a pastoral royal planet at golden hour, sun low in the upper left.
// Every icon group stands on an island (the blob field is the land): beaches or cliffs with waterfalls, grassy terraces with
// white balustrades and stairs, gardens, trees and domed palaces placed beside (never under) the icons. Rolling meadows frame
// the lake at the screen edges. Gondolas leave wakes, silver-and-yellow starfighters patrol in pairs, birds wheel, petals drift.
// Skirmishes: flat droid fighters (red bolts) chased by the fighters (blue bolts), with splashes on the water.
//
// Pipeline: field pass (quarter res, cached) -> terrain pass (full res, cached: lit land / lake bottom colour + signed height)
//           -> cloud pass (quarter res, per frame) -> water pass (per frame) -> ground sprites -> cloud-shadow multiply -> air sprites.
(function () {
  'use strict';
  const ID = 'pt-rebel';
  const TAU = Math.PI * 2;
  const SUN = (() => { const x = -0.82, y = -0.57, l = Math.hypot(x, y); return [x / l, y / l]; })();   // toward the sun (CSS axes)
  const SH = [-SUN[0], -SUN[1]];                                                                       // shadows fall this way
  const NB = 48;
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const mix = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /* ======================================================================
     GLSL
     ====================================================================== */
  const TERR = `
uniform vec2 uSun;
uniform float uW1;
uniform sampler2D uDet;     // detail pack (linear): r = grass, g = sand ripples, b = pebbles (0.5 = neutral)
uniform sampler2D uCliffT;  // pale cliff rock colour (sRGB)
uniform sampler2D uRockT;   // aerial boulders colour (sRGB)
uniform sampler2D uMeadT;   // aerial meadow colour (sRGB)
float cliffM(vec2 p) { return smoothstep(0.55, 0.63, vnoise(p * 0.0042 + vec2(uSeed * 0.71, 3.1))); }
float streamV(vec2 p) { return gnoise(p * 0.0062 + vec2(11.3, uSeed * 1.31)) * 1.6; }
float platD(vec2 p) { float id = iconDist(p); return max(min(id, 15.2 + (iconBlob(p) + 0.75 * uSigma) * 0.8), id - 28.); }
float detailN(vec2 p) { return gnoise(p * 0.05 + uSeed) * 2.4 + gnoise(p * 0.14 + 7.7) * 0.9; }
uniform vec3 SUNC, SKYC;    // key and ambient light (time of day and overcast)
uniform float uSlope, uSnow, uLc, uLs;
const vec3 SNOWC = vec3(0.76, 0.8, 0.88);
float snowM(vec2 p, float k) {
  if (uSnow < 0.002) return 0.;
  float n = texture(uDet, p / 90.).r * 0.6 + texture(uDet, p / 23.).g * 0.4;
  return smoothstep(0.3, 0.7, (uSnow * 1.5 - 0.35 + (n - 0.5) * 1.2) * k + (k - 1.) * 0.5);
}
`;

  // Quarter-res smooth fields: r = island height (px from shore, + inland), g = hills height, b = icon distance, a = forest density
  const FIELD_FS = `
uniform vec4 uHA[4];
uniform vec4 uHB[4];
uniform float uShoreOff, uHillK;
uniform vec4 uBld[${NB}];
uniform int uNB;
float hillsRaw(vec2 p) {
  vec4 e = vec4(p.y, uRes.x - p.x, uRes.y - p.y, p.x);
  vec4 s = vec4(p.x, p.y, p.x, p.y);
  float m = -1e4;
  for (int i = 0; i < 4; i++) {
    vec4 a = uHA[i], b = uHB[i];
    float w = 0.6 * sin(s[i] * b.x + b.z) + 0.4 * sin(s[i] * b.y + b.w) + a.z;
    float R = a.y * max(w, 0.) - 10.;
    m = max(m, R * uHillK - e[i]);
  }
  return m;
}
void main() {
  vec2 p = cssPos();
  float id0 = iconDist(p);
  float id = max(min(id0, 15.2 + (iconBlob(p) + 0.75 * uSigma) * 0.8), id0 - 28.);
  float iH = uShoreOff - iconBlob(p) + (fbm(p * 0.0065 + uSeed * 1.7, 4) - 0.5) * uSigma * 0.9;
  float hH = hillsRaw(p) + gfbm(p * 0.006 + uSeed * 2.3, 3) * 40.;
  hH = min(hH, 0.8 * (id - 1.6 * uSigma - 70.));
  float bd = 9.;
  for (int i = 0; i < ${NB}; i++) { if (i >= uNB) break; vec4 b = uBld[i]; bd = min(bd, length(p - b.xy) / (b.z * max(b.w, 0.01))); }
  float forest = fbm(p * 0.011 + uSeed * 3.3, 4) * smoothstep(1.55, 2.0, bd);
  outColor = vec4(iH, hH, id, forest);
}`;

  // Full-res terrain: rgb = lit land colour (or lit lake bottom), a = signed height (px, > 0 land)
  const TERRAIN_FS = TERR + `
uniform sampler2D uA;
uniform vec4 uBld[${NB}];
uniform int uNB;
vec4 FA(vec2 p) { return texture(uA, vec2(p.x / uRes.x, 1. - p.y / uRes.y)); }

float elevI(vec2 p, float flatK, float stairZ) {
  vec4 a = FA(p);
  float hs = a.r;
  float h = hs + detailN(p);
  float id = platD(p);
  float cl = cliffM(p);
  // Beach shores rise gently. Cliff shores climb ~17 px in four rock ledges, with boulder relief from the photo texture.
  float rk = luma(texture(uRockT, p / 120.).rgb);
  float u = clamp((h + (rk - 0.2) * 7. + gnoise(p * 0.09) * 2.) / 13., 0., 1.);
  float led = (floor(u * 4.) + smoothstep(0.45, 1., fract(u * 4.))) / 4.;
  float eC = 17. * mix(u, led, 0.8) + (rk - 0.25) * 5. * smoothstep(0., 2., h) * (1. - smoothstep(13., 17., h)) + 2. * smoothstep(17., 48., h);
  float eB = 1.5 * smoothstep(0., 9., h) + 9.5 * smoothstep(9., 48., h);
  float e = mix(eB, eC, cl) + max(h - 9., 0.) * 0.03;
  float w1 = mix(smoothstep(uW1 - .7, uW1 + .7, hs), smoothstep(uW1 - 5., uW1 + 5., hs), stairZ);
  e += 6. * w1 * (1. - flatK);
  float pl = mix(smoothstep(16.8, 15.4, id), smoothstep(21., 11., id), stairZ);
  e += 6. * pl * (1. - flatK);
  return e;
}

float treeDens(vec2 c) {
  vec4 a = FA(c);
  float h = max(a.r, a.g);
  float di = smoothstep(14., 22., a.r) * smoothstep(26., 36., a.b) * (0.16 + 0.84 * smoothstep(0.38, 0.54, a.a));
  float dh = smoothstep(8., 16., a.g) * (0.025 + 0.95 * smoothstep(0.5, 0.62, a.a));
  float d = a.r >= a.g ? di : dh;
  d *= 1. - cliffM(c) * smoothstep(0.06, 0.03, abs(streamV(c)));
  return d;
}
// Canopies: x = top height (incl. trunk), yz = offset from centre / radius, w = kind hash. x = 0 outside.
vec4 trees(vec2 p) {
  const float CS = 11.;
  vec2 n = floor(p / CS);
  vec4 best = vec4(0.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 cid = n + vec2(i, j);
    vec3 hh = hash32(cid + uSeed * 0.173);
    vec2 c = (cid + 0.15 + 0.7 * hh.xy) * CS;
    float k = hash12(cid * 1.37 + 4.1);
    float r = CS * mix(0.4, 0.72, hash12(cid * 2.11 + 1.3));
    if (k < 0.16) r *= 0.62;
    vec2 d = (p - c) / r; float dd = dot(d, d);
    if (dd >= 1.) continue;
    if (hh.z > treeDens(c)) continue;
    float z = sqrt(1. - dd) * r * 0.8 + r * (k < 0.16 ? 1.6 : 0.9);
    if (z > best.x) best = vec4(z, d, k);
  }
  return best;
}

vec3 canopyCol(vec2 p, vec4 tr, vec3 L, float shadowed, float hazeK) {
  vec2 g2 = tr.yz; float kk = tr.w;
  float zz = sqrt(max(1. - dot(g2, g2), 0.));
  vec2 leaf = vec2(gnoise(p * 0.7 + kk * 31.), gnoise(p * 0.7 + 17. + kk * 13.));
  vec3 Nc = normalize(vec3(g2 * 1.25 + leaf * 0.8, zz + 0.25));
  vec3 cc;
  if (kk < 0.16) cc = vec3(0.05, 0.13, 0.05);
  else if (kk < 0.24) cc = fract(kk * 53.) < 0.5 ? vec3(0.86, 0.5, 0.6) : vec3(0.9, 0.86, 0.8);
  else cc = mix(vec3(0.06, 0.15, 0.04), vec3(0.22, 0.3, 0.07), fract(kk * 7.31));
  cc = mix(cc, vec3(0.22, 0.3, 0.2), hazeK);
  cc = mix(cc, SNOWC, snowM(p, 1.1) * smoothstep(0.25, 0.8, zz + leaf.x * 0.35) * 0.62);
  float dif = max(dot(Nc, L), 0.);
  vec3 col = cc * (SUNC * dif * (1. - 0.82 * shadowed) + SKYC * (0.45 + 0.4 * zz));
  return col * (0.6 + 0.4 * smoothstep(0., 0.45, zz));
}

vec3 shadeBottom(vec2 p, float depth) {
  float cl = cliffM(p);
  vec4 det = texture(uDet, p / 140.);
  vec4 det2 = texture(uDet, rot2(0.9) * p / 330.);
  // Rippled sand (photo ripples), pebble bands near the beach, boulders under the cliffs, weed and silt in the deep
  vec3 sand = vec3(0.86, 0.76, 0.56) * (0.74 + 0.52 * det.g) * (0.9 + 0.2 * det2.g);
  float peb = smoothstep(7., 1.5, depth) * (1. - cl) * smoothstep(0.42, 0.6, det2.b);
  sand = mix(sand, vec3(0.62, 0.58, 0.5) * (0.5 + 1.0 * det.b), peb * 0.8);
  vec3 rT = texture(uRockT, p / 95.).rgb;
  float rocks = smoothstep(34., 3., depth) * clamp(cl * 1.3 + 0.35 * smoothstep(0.62, 0.78, vnoise(p * 0.018 + 4.)), 0., 1.);
  rocks *= smoothstep(0.18, 0.32, luma(rT) + 0.12 * cl);
  vec3 b = mix(sand, rT * vec3(1.0, 1.02, 0.95) * 1.15, rocks);
  vec3 weed = vec3(0.13, 0.2, 0.12) * (0.6 + 0.8 * det2.b) * (0.8 + 0.4 * det.r);
  b = mix(b, weed, smoothstep(4., 30., depth) * (1. - rocks * 0.5));
  return b * (SUNC * 0.5 + SKYC * 0.8);
}

// Formal parterre: a grid of mown squares (alternating stripe direction) on gravel walks, some cells flower beds
// edged with box hedge, some clipped topiary balls on gravel circles (which also cast a small shadow into sh).
vec3 parterre(vec2 p, vec4 det, vec4 detB, vec3 gravel, inout float sh, float GS, float k) {
  vec2 gq = (p + uSeed * 37.) / GS; vec2 gc = floor(gq); vec2 gf = fract(gq) - 0.5;
  float edgeD = (0.5 - max(abs(gf.x), abs(gf.y))) * GS;
  vec3 gh = hash32(gc + k);
  float st = smoothstep(-0.2, 0.2, sin((gh.z < 0.5 ? gf.x + gf.y : gf.x - gf.y) * 18.85));
  vec3 cellC = vec3(0.08, 0.175, 0.058) * (0.9 + 0.16 * st) * (0.86 + 0.28 * det.r);
  if (gh.x < 0.22) {
    vec3 fc = gh.y < 0.3 ? vec3(0.92, 0.42, 0.56) : gh.y < 0.55 ? vec3(0.98, 0.78, 0.3) : gh.y < 0.8 ? vec3(0.62, 0.5, 0.86) : vec3(0.95, 0.93, 0.88);
    vec4 dF = texture(uDet, p / 45. + gh.yz);
    float bloom = smoothstep(0.45, 0.62, dF.r * 0.7 + det.r * 0.5 + 0.2 * detB.r - 0.12);
    vec3 bedC = mix(vec3(0.1, 0.2, 0.06) * (0.6 + 0.8 * dF.b), fc * (0.7 + 0.6 * dF.b), bloom);
    cellC = mix(cellC, vec3(0.035, 0.09, 0.03) * (0.7 + 0.6 * det.r), smoothstep(2.4, 3.2, edgeD));
    cellC = mix(cellC, bedC, smoothstep(5., 5.8, edgeD));
  } else if (gh.x < 0.36) {
    float rr2 = length(gf * GS);
    vec3 topC = vec3(0.04, 0.12, 0.035) * (0.55 + 0.9 * clamp(0.5 - dot(gf * GS, uSun) / 12., 0., 1.)) * (0.8 + 0.4 * det.r);
    cellC = mix(cellC, gravel * 0.95, smoothstep(9., 8.3, rr2));
    cellC = mix(cellC, topC, smoothstep(6.2, 5.4, rr2));
    sh = max(sh, smoothstep(6.5, 5.5, length(gf * GS - uSun * 5.)) * smoothstep(5., 6.2, rr2) * 0.8);
  }
  return mix(cellC, gravel * 0.85, 1. - smoothstep(1.2, 1.9, edgeD));
}

vec3 shadeIsland(vec2 p, vec4 A, float h, float id, float bd, vec2 bc, vec3 L) {
  float hs = A.r;
  float cl = cliffM(p);
  float flatK = smoothstep(2.0, 1.55, bd);
  vec4 vz = voronoi(p / 46. + uSeed * 0.31);
  float stairZ = step(0.78, hash12(vz.zw + 1.7)) * smoothstep(0.42, 0.3, vz.x);
  float e0 = elevI(p, flatK, stairZ);
  float ex = elevI(p + vec2(1., 0.), flatK, stairZ), ey = elevI(p + vec2(0., 1.), flatK, stairZ);
  vec3 N = normalize(vec3(e0 - ex, e0 - ey, 1.));
  float occ = -1.;
  for (int k = 1; k <= 4; k++) { float s = float(k * k) * 1.7 + 0.8; occ = max(occ, elevI(p + uSun * s, flatK, stairZ) - e0 - s * uSlope); }
  float sh = smoothstep(-0.3, 1.0, occ);

  float rid = iconDist(p);
  vec4 det = texture(uDet, p / 170.);
  vec4 detB = texture(uDet, rot2(0.7) * p / 410.);
  float big = luma(texture(uMeadT, p / 1500. + uSeed * 0.37).rgb);       // broad light variation
  float n2 = det.r;
  // Lower terraces: rough meadow from the aerial photo, greened, with wildflower drifts
  vec3 mead = texture(uMeadT, p / 460. + uSeed * 0.13).rgb;
  vec3 alb = mix(vec3(0.06, 0.14, 0.045), mead * vec3(0.5, 0.95, 0.42), 0.55) * (0.78 + 0.44 * det.r) * (0.8 + 0.5 * big);
  vec4 fv = voronoi(p * 0.42 + 3.3);
  vec3 fh = hash32(fv.zw);
  float fpatch = smoothstep(0.5, 0.66, detB.b * 0.6 + big * 0.8) * smoothstep(22., 30., id);
  if (fh.x < fpatch * 0.7 && fv.x < 0.34) alb = fh.y < 0.33 ? vec3(0.95, 0.5, 0.66) : fh.y < 0.66 ? vec3(1.0, 0.82, 0.3) : vec3(0.95, 0.94, 0.9);
  vec3 gravel = vec3(0.5, 0.45, 0.37) * (0.55 + 0.9 * texture(uDet, p / 60.).b);
  // Winding garden paths
  float pv = gnoise(p * 0.016 + vec2(5.5, uSeed * 0.77));
  float pathM = smoothstep(0.036, 0.022, abs(pv)) * smoothstep(13., 17., hs) * smoothstep(20., 25., id) * (1. - flatK) * (1. - cl);
  alb = mix(alb, gravel * 1.15, pathM * 0.9);
  // Upper terrace: a formal parterre of mown squares on a gravel grid, with flower beds and clipped topiary
  float upper = smoothstep(uW1 + 1.2, uW1 + 2.6, hs) * smoothstep(17.5, 19.5, id) * (1. - flatK) * (1. - cl * 0.7);
  if (upper > 0.01) alb = mix(alb, parterre(p, det, detB, gravel, sh, 30., 3.1), upper);
  // Beach: photo ripples, darker wet sand at the waterline
  float beachW = 9. * (1. - cl);
  float sandM = (1. - smoothstep(beachW - 2.5, beachW + 1.5, h + (n2 - 0.5) * 3.)) * (1. - cl);
  vec3 sand = vec3(0.88, 0.77, 0.56) * (0.8 + 0.4 * det.g);
  sand = mix(sand * vec3(0.62, 0.6, 0.56), sand, smoothstep(0.3, 2.6, h));
  alb = mix(alb, sand, sandM);
  // Cliff rock: pale stone from the cliff photo mixed with boulders, wet and weedy at the foot, grass tufts on the ledges
  float rockM = cl * (1. - smoothstep(14.5, 17.5, h));
  vec3 cT = texture(uCliffT, p / 150.).rgb, rT = texture(uRockT, p / 120.).rgb;
  vec3 rock = mix(cT * vec3(0.95, 0.88, 0.78), rT, 0.4) * 1.05;
  float uL = fract(clamp(h / 13., 0., 1.) * 4.);
  rock = mix(rock, vec3(0.12, 0.22, 0.07) * (0.6 + 0.8 * det.r), smoothstep(0.5, 0.7, det.r + 0.25 * step(uL, 0.45)) * smoothstep(2., 4., h) * 0.75);
  rock *= mix(0.45, 1., smoothstep(0., 2.8, h));
  rock = mix(rock, vec3(0.1, 0.15, 0.09), smoothstep(1.2, 0., h) * 0.6);
  alb = mix(alb, rock, rockM);
  // Plateau around the icons: a mown lawn bed per icon ringed by a box hedge and a gravel walk, calm behind the icons
  float lawn = smoothstep(16., 15., id);
  // Estate lawn: broad diagonal mowing stripes crossed by fainter ones, photo grass grain, soft light variation
  float stripe = smoothstep(-0.35, 0.35, sin(dot(p, vec2(0.7071, 0.7071)) * 0.2244 + uSeed));
  float stripe2 = smoothstep(-0.35, 0.35, sin(dot(p, vec2(0.7071, -0.7071)) * 0.2244));
  vec3 lawnC = vec3(0.07, 0.16, 0.05) * (0.88 + 0.19 * stripe + 0.06 * stripe2) * (1. + (det.r - 0.5) * mix(0.3, 0.55, smoothstep(0., 8., rid))) * (0.88 + 0.24 * big);
  // Inner gardens on big plateaus: a gravel walk follows the icon group ~22 px out, formal parterres beyond it
  float walk = smoothstep(19.8, 20.5, rid) * (1. - smoothstep(22.3, 23., rid)) * smoothstep(13.5, 12.5, id) * 0.8;
  float inner = smoothstep(27., 29., rid) * smoothstep(12.5, 11., id);
  if (inner > 0.01) lawnC = mix(lawnC, parterre(p, det, detB, gravel, sh, 26., 7.7), inner);
  float prom = smoothstep(9.6, 10.4, id) * (1. - smoothstep(13.6, 14.3, id));
  lawnC = mix(lawnC, gravel * 0.8, max(prom, walk) * (1. - flatK));
  alb = mix(alb, lawnC, lawn);
  // Plaza and formal garden around each palace
  vec2 bq = p - bc; float ang = atan(bq.y, bq.x);
  float plaza = smoothstep(1.22, 1.15, bd);
  vec3 pav = vec3(0.86, 0.8, 0.68) * (0.92 + 0.08 * step(0.5, fract(length(bq) / 4.5)));
  pav *= 1. - 0.12 * smoothstep(0.86, 0.98, abs(fract(ang * 24. / 6.2832) - 0.5) * 2.);
  float garden = smoothstep(1.17, 1.24, bd) * smoothstep(1.9, 1.82, bd);
  float sec = fract(ang * 8. / 6.2832);
  float hedge = max(smoothstep(0.06, 0.02, min(sec, 1. - sec)), max(smoothstep(0.05, 0.0, abs(bd - 1.53)), smoothstep(0.05, 0.0, abs(bd - 1.86))));
  vec3 bed = hash12(floor(vec2(ang * 8. / 6.2832, bd * 3.)) + 5.) < 0.5 ? vec3(0.9, 0.45, 0.58) : vec3(0.98, 0.8, 0.35);
  bed = mix(vec3(0.2, 0.36, 0.1), bed, step(0.45, vnoise(p * 0.9)));
  vec3 gardC = mix(bed, vec3(0.08, 0.2, 0.06), hedge);
  alb = mix(alb, gardC, garden * flatK);
  alb = mix(alb, pav, plaza);
  // Balustrades and stairs
  float wl1 = (1. - smoothstep(0.5, 1.3, abs(hs - uW1 - 0.9))) * (1. - stairZ) * (1. - flatK) * (1. - rockM);
  float wl2 = (1. - smoothstep(0.5, 1.3, abs(id - 15.2))) * (1. - stairZ) * (1. - flatK);
  float stB = stairZ * (smoothstep(uW1 - 5.5, uW1 - 4.5, hs) - smoothstep(uW1 + 4.5, uW1 + 5.5, hs)) * (1. - flatK);
  float stB2 = stairZ * (smoothstep(21.5, 20.5, id) - smoothstep(11.5, 10.5, id)) * (1. - flatK);
  vec3 stoneC = vec3(0.9, 0.86, 0.78);
  alb = mix(alb, stoneC * (0.8 + 0.2 * step(0.35, fract(hs * 0.62))), stB);
  alb = mix(alb, stoneC * (0.8 + 0.2 * step(0.35, fract(id * 0.62))), stB2);
  alb = mix(alb, stoneC, max(wl1, wl2));
  // Snow: full on the gardens and slopes, only a thin trodden dusting on the lawns right around the icons
  float sn = snowM(p, 1.) * mix(1., 0.42, lawn) * (1. - 0.4 * plaza);
  alb = mix(alb, SNOWC * (0.9 + 0.12 * det.g) * mix(1., 0.8, rockM), sn);

  // Trees and their long shadows
  vec4 tr = trees(p);
  float t1 = trees(p + uSun * 4.5).x, t2 = trees(p + uSun * 9.).x;
  float tsh = max(step(tr.x + 4.5 * uSlope, t1), 0.8 * step(tr.x + 9. * uSlope, t2));
  if (tr.x > 0.) return canopyCol(p, tr, L, max(tsh, sh), 0.);
  float shadow = max(sh, tsh * 0.9);
  float dif = max(dot(N, L), 0.);
  float ao = 1. - 0.25 * smoothstep(0.5, 4., elevI(p + normalize(vec2(N.x, N.y) + 1e-4) * 2., flatK, stairZ) - e0);
  return alb * (SUNC * dif * (1. - 0.8 * shadow) + SKYC * (0.55 + 0.45 * N.z)) * ao;
}

float hillE(vec2 p) { return FA(p).g * 0.15 + 70. * fbm(p * 0.0042 + uSeed * 0.9, 4); }
vec3 shadeHills(vec2 p, vec4 A, float hh, vec3 L) {
  float e0 = hillE(p), ex = hillE(p + vec2(2., 0.)), ey = hillE(p + vec2(0., 2.));
  vec3 N = normalize(vec3((e0 - ex) * 0.5, (e0 - ey) * 0.5, 1.));
  vec2 wq = p * 0.0075 + uSeed * 0.5 + vec2(gnoise(p * 0.01), gnoise(p * 0.01 + 7.)) * 0.35;
  vec4 fv = voronoi(wq);
  vec3 fh = hash32(fv.zw + 2.);
  vec3 fc = fh.x < 0.38 ? vec3(0.19, 0.36, 0.08) : fh.x < 0.6 ? vec3(0.36, 0.48, 0.12) : fh.x < 0.78 ? vec3(0.68, 0.57, 0.24) : fh.x < 0.93 ? vec3(0.28, 0.36, 0.18) : vec3(0.5, 0.42, 0.6);
  vec2 dir = vec2(cos(fh.y * 3.14), sin(fh.y * 3.14));
  fc *= 0.9 + 0.1 * sin(dot(p, dir) * 0.8) ;
  fc *= (0.72 + 0.56 * texture(uDet, p / 170.).r) * (0.75 + 0.5 * luma(texture(uMeadT, p / 700.).rgb) * 2.2);
  float hedge = smoothstep(0.07, 0.025, fv.y - fv.x) * (0.6 + 0.4 * vnoise(p * 0.5));
  fc = mix(fc, vec3(0.07, 0.16, 0.05), hedge);
  // Shore bank and reeds
  float bank = 1. - smoothstep(2., 5., hh + vnoise(p * 0.3) * 2.);
  fc = mix(fc, vec3(0.6, 0.55, 0.44), bank);
  float reeds = smoothstep(3., 5., hh) * (1. - smoothstep(7., 10., hh)) * smoothstep(0.5, 0.7, vnoise(vec2(p.x * 0.6, p.y * 0.6)) * vnoise(p * 0.03 + 2.) * 2.);
  fc = mix(fc, vec3(0.2, 0.3, 0.08), reeds * 0.8);
  fc = mix(fc, SNOWC * (0.88 + 0.12 * vnoise(p * 0.2)), snowM(p, 1.15) * (1. - 0.75 * hedge) * (1. - 0.6 * reeds));
  float hazeK = smoothstep(20., 280., hh) * 0.42;
  vec4 tr = trees(p);
  float t1 = trees(p + uSun * 5.).x, t2 = trees(p + uSun * 10.).x;
  float tsh = max(step(tr.x + 5. * uSlope, t1), 0.8 * step(tr.x + 10. * uSlope, t2));
  vec3 col;
  if (tr.x > 0.) col = canopyCol(p, tr, L, tsh, hazeK * 0.6);
  else col = fc * (SUNC * max(dot(N, L), 0.) * (1. - 0.75 * tsh) + SKYC * (0.55 + 0.45 * N.z));
  return mix(col, vec3(0.95, 0.8, 0.6) * 0.9, hazeK);
}

void main() {
  vec2 p = cssPos();
  vec4 A = FA(p);
  float dn = detailN(p);
  float iH = A.r + dn, hH = A.g + dn * 1.6;
  float H = max(iH, hH);
  float id = platD(p);
  float bd = 9.; vec2 bc = vec2(-1e4);
  for (int i = 0; i < ${NB}; i++) { if (i >= uNB) break; vec4 b = uBld[i]; float d = length(p - b.xy) / (b.z * max(b.w, 0.01)); if (d < bd) { bd = d; bc = b.xy; } }
  vec3 L = normalize(vec3(uSun * uLc, uLs));
  vec3 col;
  if (H < 0.) col = shadeBottom(p, -H);
  else if (iH >= hH) col = shadeIsland(p, A, iH, id, bd, bc, L);
  else col = shadeHills(p, A, hH, L);
  outColor = vec4(col, H);
}`;

  // Quarter-res clouds: r = shadow cover, g = reflected cloud brightness, b = mist banks lying on the lake
  const CLOUD_FS = `
uniform float uCov, uFog;
uniform vec2 uCOff;
void main() {
  vec2 p = cssPos(); float t = uFlow;
  vec2 wnd = vec2(10., 5.5) * t + uCOff;
  float a = fbm((p - wnd) * 0.0014 + uSeed * 0.21, 4);
  float b = fbm((p - wnd + vec2(240., 170.)) * 0.0014 + uSeed * 0.21, 4);
  float m = 0.;
  if (uFog > 0.003) {
    vec2 q = p - wnd * 0.35;
    m = fbm(q * vec2(0.0021, 0.0034) + vec2(uSeed * 0.5, 3.), 4);
    m = smoothstep(0.3, 0.72, m + 0.12 * sin(q.x * 0.004 + t * 0.05));
  }
  outColor = vec4(smoothstep(0.5 - 0.34 * uCov, 0.7 - 0.12 * uCov, a), smoothstep(0.47 - 0.4 * uCov, 0.76 - 0.2 * uCov, b), m, 1.);
}`;

  const MUL_FS = `
uniform sampler2D uCloud;
uniform float uCS;
void main() { float c = texture(uCloud, vUv).r; outColor = vec4(mix(vec3(1.), vec3(0.58, 0.63, 0.74), c * uCS), 1.); }`;

  // Mist and fog: premultiplied over the ground, thick on the water and low land, islands rise out of it
  const FOG_FS = `
uniform sampler2D uCloud, uCache;
uniform vec3 uFogC;
uniform float uFog;
void main() {
  vec2 p = cssPos();
  float H = texture(uCache, vUv).a;
  float b = texture(uCloud, vUv).b;
  float low = 1. - smoothstep(1., 22., H);
  float d = uFog * (0.07 + 0.8 * low * (0.25 + 0.9 * b));
  d *= mix(0.3, 1., smoothstep(0., 46., iconDist(p)));
  d = clamp(d, 0., 0.9);
  outColor = vec4(uFogC * d, d);
}`;

  // Per-frame water and animated land details
  const MAIN_FS = TERR + `
uniform sampler2D uCache, uCache2, uCloud, uWater, uCaus;
uniform vec3 uCam, uL;
uniform float uQ, uFadeOld;
uniform vec3 uZen, uHorC, uHorW, uCldA, uCldB, uSpecC, uWL, uLT;
uniform float uShLen, uDirK, uRough, uCaps, uRain, uWet, uIce, uFlash, uWindK;
uniform vec2 uWOff;
// Rain ripples: one expanding ring per grid cell, returned as a surface slope
vec2 rainRip(vec2 p, float t, float cs, float sd) {
  vec2 q = p / cs; vec2 ci = floor(q); vec2 f = fract(q) - 0.5;
  vec3 h = hash32(ci + sd);
  if (h.z > uRain * 0.5) return vec2(0.);
  float ph = fract(t * (0.8 + 0.5 * h.x) + h.y);
  vec2 d = f - (h.xy - 0.5) * 0.4;
  float r = length(d) * cs, x = (r - ph * cs * 0.3) * 1.6;
  float w = -x * exp(-x * x * 1.1) * (1. - ph) * (1. - ph);
  return d / max(length(d), 1e-3) * w * 1.5;
}
vec2 wv(vec2 p, vec2 d, float k, float c, float a, float t, float wp, inout float hg) {
  float ph = dot(p, d) * k - t * k * c + wp;
  hg += a * sin(ph);
  return d * (a * k * cos(ph));
}
vec3 skyCol(vec3 R, float cref) {
  vec2 rd = normalize(R.xy + 1e-5);
  float sunward = dot(rd, uSun) * 0.5 + 0.5;
  vec3 hor = mix(uHorC, uHorW, sunward * sunward);
  vec3 s = mix(hor, uZen, smoothstep(0.05, 0.9, R.z));
  return mix(s, mix(uCldA, uCldB, sunward * sunward), cref * 0.5) + vec3(0.9, 0.95, 1.2) * uFlash * (0.6 + cref);
}
vec2 offUV(vec2 d) { return vec2(d.x / uRes.x, -d.y / uRes.y); }
void main() {
  vec2 p = cssPos();
  vec4 C = texture(uCache, vUv);
  if (uFadeOld > 0.) C.rgb = mix(C.rgb, texture(uCache2, vUv).rgb, uFadeOld);
  float H = C.a;
  vec4 cld = texture(uCloud, vUv);
  float t = uFlow;
  float cl = cliffM(p);
  float sv = cl > 0.02 ? streamV(p) : 1.;
  float aw = abs(sv);
  float id = iconDist(p);
  vec3 land = C.rgb, wcol = vec3(0.);

  if (H > -1.5) {
    float gm = clamp((land.g - land.r) * 5., 0., 1.);
    float wind = (texture(uWater, p / 1500. - vec2(t * 0.011, t * 0.006)).b - 0.5) * 1.4;
    land *= 1. + 0.08 * wind * gm * uWindK;
    if (cl > 0.02 && H < uW1) {
      float clk = smoothstep(0.3, 0.6, cl);
      float ch = smoothstep(0.032, 0.022, aw) * smoothstep(6., 9., H) * smoothstep(uW1 - 1., uW1 - 5., H) * clk;
      float fall = smoothstep(0.038, 0.024, aw) * (1. - smoothstep(6., 9., H)) * clk;
      float flowc = vnoise(vec2(sv * 700., H * 0.6 + t * 4.));
      vec3 chC = mix(vec3(0.08, 0.4, 0.44), vec3(0.9, 1.05, 1.05), flowc * flowc * 0.7);
      float streak = vnoise(vec2(sv * 1100., H * 1.4 + t * 9.)) * 0.7 + vnoise(vec2(sv * 2600., H * 3. + t * 14.)) * 0.3;
      vec3 fC = vec3(1.3, 1.36, 1.34) * (0.55 + 0.9 * streak);
      land *= 1. - 0.35 * smoothstep(0.055, 0.03, aw) * (1. - ch) * (1. - fall) * clk * step(H, uW1 - 1.) * step(6., H);
      land = mix(land, chC * uLT, ch);
      land = mix(land, fC * uLT, fall);
    }
    // Rain: wet, darker ground with a sheen on pale stone, and tiny splashes flicking up everywhere
    if (uWet > 0.003) {
      float stone = smoothstep(0.08, 0.3, luma(land) / max(dot(uLT, vec3(0.33)), 0.05)) * (1. - gm);
      land *= mix(vec3(1.), vec3(0.62, 0.66, 0.7), uWet * (1. - 0.5 * stone));
      land += mix(uHorC, uCldA, 0.5) * 0.12 * uWet * stone;
      vec2 q = p / 6.; vec2 ci = floor(q); vec3 h = hash32(ci + 3.3);
      float ph = fract(t * 1.6 + h.y);
      vec2 d = fract(q) - 0.5 - (h.xy - 0.5) * 0.5;
      land += uLT * 0.5 * step(h.z, uRain * 0.7) * smoothstep(0.2, 0., ph) * exp(-dot(d, d) * 60.) * smoothstep(8., 20., id);
    }
  }
  if (H < 1.5) {
    float depth = max(-H, 0.);
    float damp = 0.35 + 0.65 * smoothstep(0., 22., depth);
    float gust = 0.3 + 1.1 * smoothstep(0.25, 0.8, vnoise(p * 0.0045 - vec2(t * 0.05, t * 0.03)));
    // Surface: three layers of a tileable wave normal map at different scales, headings and drifts, plus a long swell
    vec4 w1 = texture(uWater, p / 980. + vec2(t * 0.0085, t * 0.0042));
    vec4 w2 = texture(uWater, rot2(0.35) * p / 560. + vec2(-t * 0.0105, t * 0.0125));
    vec4 w3 = texture(uWater, rot2(-0.25) * p / 250. + vec2(t * 0.024, -t * 0.009));
    vec2 g = (w1.xy - 0.5) * 0.28 + (w2.xy - 0.5) * 0.2;
    float hg = (w1.b + w2.b - 1.) * 3.;
    vec2 sd = vec2(0.94, 0.34);
    float sw = dot(p, sd) * 0.042 - t * 0.38 + w1.b * 9.;
    g += sd * cos(sw) * 0.065; hg += sin(sw) * 0.8;
    vec2 sd2 = vec2(0.6, 0.8);
    float sw2 = dot(p, sd2) * 0.071 - t * 0.5 + w2.b * 7.;
    g += sd2 * cos(sw2) * 0.04; hg += sin(sw2) * 0.4;
    vec4 w3r = w3;
    if (uRough > 1.01) w3r = texture(uWater, rot2(-0.25) * p / 250. + vec2(t * 0.024, -t * 0.009) + uWOff);
    g = g * damp * (0.75 + 0.3 * gust) * mix(1., uRough, 0.6) + (w3r.xy - 0.5) * 0.42 * gust * (0.4 + 0.6 * damp) * uRough;
    vec2 rip = vec2(0.);
    if (uRain > 0.003) { rip = (rainRip(p, t, 17., 1.3) + rainRip(rot2(0.6) * p + 4.1, t * 1.13, 25., 7.1)) * smoothstep(6., 18., id); g += rip * 0.5; }
    vec3 n = normalize(vec3(-g * 0.8, 1.));

    vec3 V = normalize(vec3(uCam.xy - p, uCam.z));
    vec3 R = reflect(-V, normalize(vec3(-g * 0.55, 1.)));
    float rl = max(dot(R, uL), 0.);
    float F = 0.02 + 0.98 * pow(1. - max(dot(n, V), 0.), 5.);
    float cover = cld.r;
    float sunVis = 1. - 0.92 * cover * min(uDirK, 1.);

    // Shadows of cliffs and banks on the water (cast along the sun direction)
    vec2 sl = uSun * uShLen;
    float Ho1 = texture(uCache, vUv + offUV(sl * 4.)).a, Ho2 = texture(uCache, vUv + offUV(sl * 11.)).a, Ho3 = texture(uCache, vUv + offUV(sl * 20.)).a;
    float cshadow = max(max(smoothstep(0., 3., Ho1), 0.85 * smoothstep(4., 8., Ho2)), 0.7 * smoothstep(9., 13., Ho3)) * smoothstep(0.3, 0.6, cliffM(p + sl * 8.)) * min(uDirK, 1.);
    sunVis *= 1. - 0.85 * cshadow;

    // Sun glitter: a tight sun core, a soft path, and sparse twinkling glints (kept below white so it never blows out)
    float specS = pow(rl, 2600.) * 7.;
    float specB = pow(rl, 160.) * 0.1;
    vec2 sc = p / 2.1; vec2 sci = floor(sc); vec3 sh3 = hash32(sci + 0.5);
    float tw = pow(0.5 + 0.5 * sin(t * (2. + 3. * sh3.z) + sh3.x * 40.), 20.);
    vec2 so = fract(sc) - 0.2 - 0.6 * sh3.xy;
    float spark = tw * exp(-dot(so, so) * 34.) * pow(rl, 70.) * 7. * step(0.72, sh3.z) * gust;
    float spec = (specS + specB + spark) * sunVis * smoothstep(10., 34., id) * damp;

    // Refraction: the cached bottom seen through the waves, bent more where the water is deeper
    float trans = exp(-depth / 10.);
    vec3 bottom = C.rgb;
    if (trans > 0.02) {
      bottom = texture(uCache, vUv + offUV(g * min(depth, 14.) * 0.55)).rgb;
      float c1 = texture(uCaus, p / 430. + vec2(t * 0.011, t * 0.007) + g * 0.02).r;
      float c2 = texture(uCaus, rot2(0.7) * p / 330. - vec2(t * 0.009, -t * 0.012)).r;
      float caus = c1 * c2 * 3.2 + (c1 + c2) * 0.22;
      bottom *= 0.78 + caus * 1.25 * sunVis * smoothstep(0., 3., depth + 1.) * min(uDirK, 1.);
    }
    vec3 body = mix(vec3(0.05, 0.4, 0.4), vec3(0.02, 0.22, 0.28), smoothstep(4., 30., depth));
    body = mix(body, vec3(0.008, 0.075, 0.125), smoothstep(26., 120., depth));
    body *= 0.86 + 0.28 * clamp(0.5 + hg * 0.2, 0., 1.);
    body *= 1. - 0.35 * cshadow;
    vec3 under = mix(body, bottom * vec3(0.7, 0.95, 0.9), trans);
    under += vec3(0.05, 0.2, 0.17) * exp(-depth / 14.) * (1. - trans);
    under *= uWL;
    if (uIce > 0.003) under = mix(under, vec3(0.09, 0.14, 0.18) * dot(uWL, vec3(0.4)) * (1. + 0.6 * trans), uIce * 0.55);
    vec3 sky = skyCol(R, cld.g);
    float refl = clamp(F * 1.6 + 0.05, 0., 1.);
    float facet = clamp(dot(-g * 0.8, uSun) * 2.2, -0.35, 0.35);
    under *= 1. + facet * (1. - 0.6 * cover);
    wcol = mix(under, sky, refl) + uSpecC * spec;
    // Rain rings catch the sky light on their near side and darken on the far side
    if (uRain > 0.003) wcol += mix(uHorC, uCldA, 0.5) * (dot(rip, vec2(-0.6, -0.8)) * 0.4 + length(rip) * 0.12);

    // Shore foam: a waterline lace plus gentle surf lines rolling in
    float fn = vnoise(p * 0.09 + vec2(t * 0.15, -t * 0.1));
    float edgeF = smoothstep(2.2, 0.2, depth + (fn - 0.5) * 1.6);
    float band = fract(depth / 6.5 - t * 0.16 + gnoise(p * 0.035) * 0.9);
    float surf = smoothstep(0.8, 0.94, band) * (1. - smoothstep(0.94, 1.0, band)) * exp(-depth / 6.) * smoothstep(0.35, 0.65, fn);
    float foam = clamp(edgeF * 0.75 + surf * 0.55 + cl * exp(-depth / 3.) * smoothstep(0.35, 0.75, fn) * 0.5, 0., 1.);
    // Whitecaps when the wind rises and in storms, streaked along the wave crests
    if (uCaps > 0.003) {
      float fine = texture(uWater, rot2(1.1) * p / 95. + uWOff * 2.3 + vec2(t * 0.03, 0.)).b;
      float crest = w3r.b * 0.55 + fine * 0.45 + (gust - 0.8) * 0.1 + w2.b * 0.15 - 0.075;
      float wc = smoothstep(0.84 - 0.08 * uCaps, 0.93, crest) * damp * smoothstep(10., 30., id);
      foam = max(foam, wc * 0.5);
    }
    // Snow: thin ice creeping out from the shores, cracked and frosted
    if (uIce > 0.003) {
      float icn = vnoise(p * 0.05) * 0.7 + vnoise(p * 0.17) * 0.3;
      float ice = smoothstep(0.6, -0.6, depth - uIce * 7. + (icn - 0.5) * 6.);
      float crack = smoothstep(0.03, 0.0, abs(gnoise(p * 0.06))) * 0.35;
      vec3 iceC = vec3(0.62, 0.7, 0.78) * uLT * (0.85 + 0.25 * icn - crack);
      wcol = mix(wcol, iceC, ice * 0.92);
    }
    wcol = mix(wcol, vec3(1.05, 1.0, 0.92) * 1.12 * uLT, foam * 0.85);
    // Waterfall plunge pools: churning foam and mist
    if (cl > 0.02) {
      float mm = cl * smoothstep(0.09, 0.015, aw) * exp(-depth / 10.);
      float churn = vnoise(vec2(sv * 300., depth * 0.25 - t * 1.6)) * vnoise(p * 0.15 + t * 0.4);
      wcol += vec3(1., 1., 0.95) * uLT * mm * (0.2 + 1.3 * churn);
    }
  }
  vec3 col = mix(wcol, land, smoothstep(-0.6, 0.6, H));
  // Lightning: the scene lights up from the clouds, strongest under the brightest cloud tops
  col += col * uFlash * (0.6 + 1.2 * cld.g) * vec3(0.8, 0.88, 1.15);
  outColor = vec4(col, 1.);
}`;

  /* ======================================================================
     Canvas 2D sprite art (drawn once into the atlas, lit from the upper left)
     ====================================================================== */
  function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function circ(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); }
  const DOMES = {
    copper: ['#e2f5e8', '#8cc9b1', '#3f826f', '#1c463d'],
    gold: ['#fff7d6', '#f2c95c', '#b27a22', '#5b3a0e'],
    white: ['#ffffff', '#ece6da', '#b9b1a1', '#756d60']
  };
  function softShadow(g, x, y, r, a) {
    const gr = g.createRadialGradient(x, y, r * 0.2, x, y, r);
    gr.addColorStop(0, `rgba(40,30,20,${a})`); gr.addColorStop(1, 'rgba(40,30,20,0)');
    g.fillStyle = gr; circ(g, x, y, r); g.fill();
  }
  function dome(g, x, y, r, kind, ribs = 12) {
    softShadow(g, x + r * 0.22, y + r * 0.16, r * 1.18, 0.5);
    const c = DOMES[kind];
    const gr = g.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.04, x, y, r);
    gr.addColorStop(0, c[0]); gr.addColorStop(0.32, c[1]); gr.addColorStop(0.75, c[2]); gr.addColorStop(1, c[3]);
    g.fillStyle = gr; circ(g, x, y, r); g.fill();
    g.strokeStyle = 'rgba(20,20,10,0.16)'; g.lineWidth = Math.max(1, r * 0.035);
    for (let i = 0; i < ribs; i++) { const a = i / ribs * TAU; g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.2, y + Math.sin(a) * r * 0.2); g.lineTo(x + Math.cos(a) * r * 0.97, y + Math.sin(a) * r * 0.97); g.stroke(); }
    g.strokeStyle = 'rgba(255,240,200,0.5)'; g.lineWidth = Math.max(1, r * 0.05); circ(g, x, y, r * 0.98); g.stroke();
    // Lantern
    const lg = g.createRadialGradient(x - r * 0.06, y - r * 0.06, 0, x, y, r * 0.18);
    lg.addColorStop(0, '#fffbe8'); lg.addColorStop(0.5, '#f0c860'); lg.addColorStop(1, '#8a6020');
    g.fillStyle = lg; circ(g, x, y, r * 0.17); g.fill();
  }
  function roof(g, x, y, w, h, r) {
    const gr = g.createLinearGradient(x, y, x + w, y + h);
    gr.addColorStop(0, '#fbf7ec'); gr.addColorStop(1, '#d6cbb5');
    g.fillStyle = gr; rr(g, x, y, w, h, r); g.fill();
    g.strokeStyle = 'rgba(110,95,75,0.5)'; g.lineWidth = 2; rr(g, x + 5, y + 5, w - 10, h - 10, Math.max(1, r - 4)); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x + r, y + 1); g.lineTo(x + w - r, y + 1); g.moveTo(x + 1, y + r); g.lineTo(x + 1, y + h - r); g.stroke();
    g.strokeStyle = 'rgba(80,65,50,0.55)'; g.lineWidth = 3; g.beginPath(); g.moveTo(x + w - 1, y + r); g.lineTo(x + w - 1, y + h - r); g.moveTo(x + r, y + h - 1); g.lineTo(x + w - r, y + h - 1); g.stroke();
  }
  function columns(g, x0, x1, y, n, r) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (x1 - x0) * (i + 0.5) / n;
      softShadow(g, x + r * 0.5, y + r * 0.4, r * 1.6, 0.4);
      const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#bdb4a2');
      g.fillStyle = gr; circ(g, x, y, r); g.fill();
    }
  }
  function drawPalace(g, w, h, kind) {
    const k2 = kind === 'copper' ? 'gold' : 'copper';
    // Wings with courtyards
    for (const sx of [12, 248]) {
      roof(g, sx, 64, 60, 112, 8);
      g.fillStyle = '#4f7a35'; rr(g, sx + 14, 92, 32, 56, 4); g.fill();
      g.fillStyle = 'rgba(240,200,210,0.8)'; for (let i = 0; i < 6; i++) { circ(g, sx + 22 + (i % 2) * 16, 100 + ((i / 2) | 0) * 18, 3.5); g.fill(); }
    }
    roof(g, 44, 52, 232, 136, 10);
    columns(g, 60, 260, 196, 13, 5.5);
    columns(g, 60, 260, 44, 13, 5.5);
    // Rooftop terraces
    g.fillStyle = 'rgba(190,170,140,0.35)'; rr(g, 66, 70, 40, 100, 5); g.fill(); rr(g, 214, 70, 40, 100, 5); g.fill();
    dome(g, 160, 120, 58, kind, 16);
    for (const [x, y] of [[52, 58], [268, 58], [52, 182], [268, 182]]) dome(g, x, y, 17, k2, 8);
    dome(g, 86, 120, 13, k2, 8); dome(g, 234, 120, 13, k2, 8);
  }
  function drawWing(g, w, h, kind) {
    roof(g, 12, 26, 232, 68, 9);
    columns(g, 24, 232, 102, 12, 4.5);
    columns(g, 24, 232, 18, 12, 4.5);
    dome(g, 70, 60, 21, kind, 10); dome(g, 128, 60, 25, kind, 12); dome(g, 186, 60, 21, kind, 10);
    dome(g, 26, 60, 10, 'white', 6); dome(g, 230, 60, 10, 'white', 6);
  }
  function drawPavilion(g, w, h, kind) {
    const cx = w / 2, cy = h / 2;
    softShadow(g, cx + 6, cy + 4, 62, 0.35);
    const gr = g.createRadialGradient(cx - 18, cy - 18, 4, cx, cy, 58);
    gr.addColorStop(0, '#fdfaf2'); gr.addColorStop(1, '#cfc4ae');
    g.fillStyle = gr; circ(g, cx, cy, 58); g.fill();
    g.strokeStyle = 'rgba(120,100,80,0.45)'; g.lineWidth = 2; circ(g, cx, cy, 52); g.stroke();
    for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; const x = cx + Math.cos(a) * 46, y = cy + Math.sin(a) * 46; softShadow(g, x + 3, y + 2, 9, 0.35); g.fillStyle = '#f6f1e6'; circ(g, x, y, 5); g.fill(); }
    dome(g, cx, cy, 36, kind, 12);
  }
  function drawTower(g, w, h, kind) {
    const cx = w / 2, cy = h / 2;
    softShadow(g, cx + 6, cy + 4, 54, 0.4);
    const gr = g.createRadialGradient(cx - 14, cy - 14, 4, cx, cy, 48);
    gr.addColorStop(0, '#fbf6ea'); gr.addColorStop(1, '#bfb49e');
    g.fillStyle = gr; circ(g, cx, cy, 48); g.fill();
    g.fillStyle = 'rgba(120,100,80,0.5)'; for (let i = 0; i < 16; i++) { const a = i / 16 * TAU; circ(g, cx + Math.cos(a) * 43, cy + Math.sin(a) * 43, 2.6); g.fill(); }
    dome(g, cx, cy, 33, kind, 10);
  }
  function drawGondola(g, w, h, canopy) {
    const cy = h / 2;
    const half = u => Math.pow(Math.sin(Math.PI * clamp(u, 0, 1)), 0.75);
    const hull = (s, inset) => {
      g.beginPath();
      const x0 = 14 + inset, x1 = w - 14 - inset;
      for (let i = 0; i <= 40; i++) { const u = i / 40; g.lineTo(mix(x0, x1, u), cy - half(u) * (h * 0.36 - inset) * s); }
      for (let i = 40; i >= 0; i--) { const u = i / 40; g.lineTo(mix(x0, x1, u), cy + half(u) * (h * 0.36 - inset) * s); }
      g.closePath();
    };
    { const hg = g.createLinearGradient(0, cy - h * 0.36, 0, cy + h * 0.36); hg.addColorStop(0, '#fffaf0'); hg.addColorStop(0.5, '#e6dcc6'); hg.addColorStop(1, '#a89878'); g.fillStyle = hg; hull(1, 0); g.fill(); }
    g.strokeStyle = '#c8962e'; g.lineWidth = 3; hull(1, 2.5); g.stroke(); g.fillStyle = '#5a3a24'; hull(0.62, 9); g.fill();
    // Curled prow and stern
    g.strokeStyle = '#d8b25a'; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(w - 16, cy); g.quadraticCurveTo(w - 6, cy, w - 3, cy - 4); g.stroke();
    g.beginPath(); g.moveTo(16, cy); g.quadraticCurveTo(7, cy, 4, cy + 4); g.stroke();
    g.fillStyle = '#e6b84e'; circ(g, w - 3, cy - 4, 3); g.fill(); circ(g, 4, cy + 4, 3); g.fill();
    // Deck
    g.fillStyle = '#7a4a2a'; rr(g, 52, cy - 7, 120, 14, 5); g.fill();
    if (canopy) {
      const gr = g.createLinearGradient(80, cy - 13, 150, cy + 13);
      gr.addColorStop(0, '#f4d27a'); gr.addColorStop(1, '#a2741e');
      g.fillStyle = gr; rr(g, 82, cy - 12, 64, 24, 9); g.fill();
      g.strokeStyle = 'rgba(90,40,20,0.6)'; g.lineWidth = 1.5; for (let i = 1; i < 5; i++) { g.beginPath(); g.moveTo(82 + i * 12.8, cy - 11); g.lineTo(82 + i * 12.8, cy + 11); g.stroke(); }
    } else {
      for (const [x, c] of [[96, '#c9455a'], [118, '#e8dcc0'], [138, '#5a7ec9']]) { g.fillStyle = c; circ(g, x, cy, 6.5); g.fill(); g.fillStyle = '#3a2618'; circ(g, x + 1, cy, 3.2); g.fill(); }
    }
    // Gondolier and pole
    g.strokeStyle = '#c8b090'; g.lineWidth = 2.2; g.beginPath(); g.moveTo(38, cy - 2); g.lineTo(8, cy + 16); g.stroke();
    g.fillStyle = '#efe6d6'; circ(g, 40, cy, 7); g.fill();
    g.fillStyle = '#2b1d14'; circ(g, 41, cy, 4); g.fill();
  }
  function drawWake(g, w, h) {
    const ax = w * 0.95, ay = h / 2;
    g.lineCap = 'round';
    // Soft diverging arms: a wide faint band plus a thinner bright crest, fading toward the tail
    for (const s of [-1, 1]) {
      for (const [blur, lw, al] of [[6, 10, 0.35], [2.5, 3.5, 0.6], [1.2, 1.6, 0.5]]) {
        g.filter = `blur(${blur}px)`;
        const gr = g.createLinearGradient(ax, 0, 0, 0);
        gr.addColorStop(0, `rgba(255,255,255,${al})`); gr.addColorStop(0.55, `rgba(255,255,255,${al * 0.35})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.strokeStyle = gr; g.lineWidth = lw;
        g.beginPath(); g.moveTo(ax, ay); g.quadraticCurveTo(w * 0.55, ay + s * h * 0.2, 4, ay + s * h * 0.42); g.stroke();
      }
      g.filter = 'blur(1.5px)';
      for (let i = 1; i < 8; i++) {
        const u = i / 8, x = ax - u * ax * 0.9, sp = h * 0.4 * u;
        g.strokeStyle = `rgba(255,255,255,${0.22 * (1 - u)})`; g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(x - 2, ay + s * sp * 0.3); g.quadraticCurveTo(x + 5, ay + s * sp * 0.65, x + 1, ay + s * sp * 0.95); g.stroke();
      }
    }
    g.filter = 'blur(5px)';
    const tg = g.createLinearGradient(ax, 0, 0, 0);
    tg.addColorStop(0, 'rgba(255,255,255,0.55)'); tg.addColorStop(0.5, 'rgba(255,255,255,0.15)'); tg.addColorStop(1, 'rgba(255,255,255,0)');
    g.strokeStyle = tg; g.lineWidth = 12; g.beginPath(); g.moveTo(ax - 8, ay); g.lineTo(w * 0.1, ay); g.stroke();
    g.filter = 'none';
  }
  // Sleek royal starfighter, nose toward +x. Drawn in a 320x120 design space and scaled to the sprite size.
  // Shading is symmetric about the long axis (a cylinder lit from above), so it reads correctly at any heading.
  function drawFighter(g, w, h) {
    g.scale(w / 320, h / 120);
    const cy = 60;
    const cyl = (y0, y1, stops) => { const gr = g.createLinearGradient(0, y0, 0, y1); stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr; };
    const CHROME = [[0, '#59606b'], [0.22, '#c9d1da'], [0.45, '#ffffff'], [0.6, '#dfe5ec'], [1, '#4f5660']];
    const GOLD = [[0, '#7a520c'], [0.25, '#e8b42c'], [0.48, '#fff0a6'], [0.62, '#f3c33a'], [1, '#6e4908']];
    // Soft contact darkening under the whole craft
    g.save(); g.filter = 'blur(3px)'; g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.ellipse(170, cy, 140, 46, 0, 0, TAU); g.fill(); g.restore();
    // Wings: swept plates joining the fuselage to the engine pods
    for (const s of [-1, 1]) {
      g.fillStyle = cyl(cy, cy + s * 40, [[0, '#f6cf4a'], [1, '#9c6f10']]);
      g.beginPath(); g.moveTo(98, cy + s * 8); g.lineTo(150, cy + s * 8); g.lineTo(196, cy + s * 30); g.lineTo(186, cy + s * 40); g.lineTo(120, cy + s * 40); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(70,45,5,0.55)'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(126, cy + s * 12); g.lineTo(170, cy + s * 34); g.stroke();
    }
    // Engine pods: chrome body with a long tail spike, gold intake cowl, dark intake ring
    for (const s of [-1, 1]) {
      const py = cy + s * 36, r = 10;
      g.fillStyle = cyl(py - r, py + r, CHROME);
      g.beginPath(); g.moveTo(2, py); g.lineTo(64, py - 3.5); g.lineTo(84, py - r); g.lineTo(198, py - r); g.quadraticCurveTo(210, py, 198, py + r); g.lineTo(84, py + r); g.lineTo(64, py + 3.5); g.closePath(); g.fill();
      g.fillStyle = cyl(py - r - 1, py + r + 1, GOLD);
      g.beginPath(); g.moveTo(140, py - r - 1); g.lineTo(196, py - r - 1); g.quadraticCurveTo(212, py, 196, py + r + 1); g.lineTo(140, py + r + 1); g.closePath(); g.fill();
      g.fillStyle = '#1b1f26'; g.beginPath(); g.ellipse(203, py, 3, r - 2, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(40,30,10,0.6)'; g.lineWidth = 1.2;
      for (const x of [100, 118, 140]) { g.beginPath(); g.moveTo(x, py - r + 1); g.lineTo(x, py + r - 1); g.stroke(); }
      g.fillStyle = '#2a2f37'; g.fillRect(80, py - r + 1, 5, 2 * r - 2);
      // Exhaust nozzle glow ring
      g.fillStyle = 'rgba(150,200,255,0.9)'; g.beginPath(); g.ellipse(82, py, 2, r * 0.6, 0, 0, TAU); g.fill();
    }
    // Fuselage: silver aft section, gold forward body, long chrome needle nose
    g.fillStyle = cyl(cy - 15, cy + 15, CHROME);
    g.beginPath(); g.moveTo(40, cy); g.quadraticCurveTo(42, cy - 13, 70, cy - 14); g.lineTo(118, cy - 14); g.lineTo(118, cy + 14); g.lineTo(70, cy + 14); g.quadraticCurveTo(42, cy + 13, 40, cy); g.closePath(); g.fill();
    g.fillStyle = cyl(cy - 15, cy + 15, GOLD);
    g.beginPath(); g.moveTo(116, cy - 15); g.lineTo(236, cy - 12); g.quadraticCurveTo(262, cy - 7, 270, cy - 3); g.lineTo(270, cy + 3); g.quadraticCurveTo(262, cy + 7, 236, cy + 12); g.lineTo(116, cy + 15); g.closePath(); g.fill();
    g.fillStyle = cyl(cy - 4, cy + 4, CHROME);
    g.beginPath(); g.moveTo(266, cy - 3.5); g.lineTo(318, cy); g.lineTo(266, cy + 3.5); g.closePath(); g.fill();
    // Panel lines and rivets
    g.strokeStyle = 'rgba(60,40,5,0.5)'; g.lineWidth = 1.1;
    for (const x of [136, 176, 232]) { g.beginPath(); g.moveTo(x, cy - 13); g.lineTo(x, cy + 13); g.stroke(); }
    g.strokeStyle = 'rgba(40,45,55,0.55)'; for (const x of [62, 88]) { g.beginPath(); g.moveTo(x, cy - 12); g.lineTo(x, cy + 12); g.stroke(); }
    // Astromech droid dome in its socket
    g.fillStyle = '#2b3038'; g.beginPath(); g.arc(152, cy, 8.5, 0, TAU); g.fill();
    { const gr = g.createRadialGradient(150, cy - 2, 0.5, 152, cy, 7.5); gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.7, '#cfd6e0'); gr.addColorStop(1, '#7d8794'); g.fillStyle = gr; g.beginPath(); g.arc(152, cy, 7.2, 0, TAU); g.fill(); }
    g.fillStyle = '#3b6fd0'; g.fillRect(148, cy - 1.6, 8, 3.2); g.beginPath(); g.arc(152, cy, 2.2, 0, TAU); g.fill();
    // Cockpit canopy with a sky reflection
    { const gr = g.createLinearGradient(0, cy - 9, 0, cy + 9); gr.addColorStop(0, '#0d1a33'); gr.addColorStop(0.4, '#36507c'); gr.addColorStop(1, '#0a1428'); g.fillStyle = gr; }
    g.beginPath(); g.ellipse(206, cy, 21, 8.5, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(230,200,110,0.9)'; g.lineWidth = 1.4; g.stroke();
    g.fillStyle = 'rgba(210,235,255,0.75)'; g.beginPath(); g.ellipse(212, cy - 3, 9, 2.2, -0.05, 0, TAU); g.fill();
    // Specular ridge along the spine
    g.strokeStyle = 'rgba(255,255,240,0.7)'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(122, cy - 1); g.lineTo(184, cy - 1); g.stroke();
    // Wingtip running lights
    g.fillStyle = '#ff5a4a'; g.beginPath(); g.arc(188, cy - 40, 2.2, 0, TAU); g.fill();
    g.fillStyle = '#5aff8a'; g.beginPath(); g.arc(188, cy + 40, 2.2, 0, TAU); g.fill();
  }
  function drawDroid(g, w, h) {
    const cx = w / 2, cy = h / 2;
    const blade = (x0, y0, x1, y1, wd) => {
      const a = Math.atan2(y1 - y0, x1 - x0), nx = -Math.sin(a), ny = Math.cos(a);
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, '#6b5d50'); gr.addColorStop(1, '#3b332d');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(x0 + nx * wd, y0 + ny * wd); g.lineTo(x1 + nx * wd * 0.35, y1 + ny * wd * 0.35); g.lineTo(x1 - nx * wd * 0.2, y1 - ny * wd * 0.2); g.lineTo(x0 - nx * wd, y0 - ny * wd); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(190,120,80,0.55)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x0 + nx * wd * 0.6, y0 + ny * wd * 0.6); g.lineTo(x1, y1); g.stroke();
      g.fillStyle = '#2a2420'; circ(g, x1, y1, 4); g.fill();
    };
    blade(cx + 8, cy - 4, cx + 52, cy - 82, 11);
    blade(cx + 8, cy + 4, cx + 52, cy + 82, 11);
    blade(cx - 14, cy - 4, cx - 62, cy - 74, 10);
    blade(cx - 14, cy + 4, cx - 62, cy + 74, 10);
    const bg = g.createLinearGradient(0, cy - 14, 0, cy + 14);
    bg.addColorStop(0, '#8a7c6c'); bg.addColorStop(1, '#3a322b');
    g.fillStyle = bg;
    g.beginPath(); g.moveTo(cx - 60, cy); g.lineTo(cx - 40, cy - 12); g.lineTo(cx + 50, cy - 10); g.lineTo(cx + 82, cy - 4); g.lineTo(cx + 82, cy + 4); g.lineTo(cx + 50, cy + 10); g.lineTo(cx - 40, cy + 12); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(30,25,20,0.7)'; g.lineWidth = 2;
    for (let i = 0; i < 6; i++) { const x = cx - 30 + i * 14; g.beginPath(); g.moveTo(x, cy - 9); g.lineTo(x, cy + 9); g.stroke(); }
    g.fillStyle = '#5a2a20'; circ(g, cx + 70, cy - 6, 3); g.fill(); circ(g, cx + 70, cy + 6, 3); g.fill();
  }
  function drawBird(g, w, h, up) {
    const cx = w / 2, cy = h / 2, span = up ? 0.47 : 0.3;
    for (const s of [-1, 1]) {
      g.fillStyle = '#d9d6cf';
      g.beginPath(); g.moveTo(cx + 6, cy + s * 3); g.quadraticCurveTo(cx + 10, cy + s * h * span * 0.6, cx - 4, cy + s * h * span); g.lineTo(cx - 10, cy + s * h * span * 0.9); g.quadraticCurveTo(cx - 4, cy + s * h * span * 0.4, cx - 8, cy + s * 3); g.closePath(); g.fill();
      g.fillStyle = '#2c2a28';
      g.beginPath(); g.moveTo(cx - 4, cy + s * h * span); g.lineTo(cx - 10, cy + s * h * span * 0.9); g.lineTo(cx - 6, cy + s * h * span * 0.72); g.closePath(); g.fill();
    }
    g.fillStyle = '#ffffff';
    g.beginPath(); g.ellipse(cx, cy, 16, 4.5, 0, 0, TAU); g.fill();
    g.fillStyle = '#f0b040'; circ(g, cx + 16, cy, 1.8); g.fill();
  }

  /* ======================================================================
     CPU-side geometry (mirrors the shaders closely enough for placement and steering)
     ====================================================================== */
  const iconRects = list => list.map(ic => ({ cx: ic.x + ic.w / 2, cy: ic.y + ic.h / 2 - 2, hw: Math.max(8, ic.w / 2 - 10), hh: Math.max(8, ic.h / 2 - 8) }));
  function blobF(R, x, y, sig) {
    let acc = 0; const is1 = 1 / (sig * sig);
    for (const r of R) {
      const Rb = 5.5 * sig + Math.max(r.hw, r.hh) * 0.5;
      if (Math.abs(x - r.cx) >= Rb || Math.abs(y - r.cy) >= Rb) continue;
      const ex = Math.max(0, Math.abs(x - r.cx) - r.hw * 0.5), ey = Math.max(0, Math.abs(y - r.cy) - r.hh * 0.5);
      acc += Math.exp(-(ex * ex + ey * ey) * is1);
    }
    const c0 = Math.sqrt(-Math.log(0.35)), g = Math.log(Math.max(acc, Math.exp(-30)));
    return Math.min(640, sig * (Math.sqrt(Math.max(-g, 0)) - c0) - sig * 0.6 * Math.max(g, 0));
  }
  function distF(R, x, y) {
    let d = 640;
    for (const r of R) {
      const qx = Math.abs(x - r.cx) - (r.hw - 12), qy = Math.abs(y - r.cy) - (r.hh - 12);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 12;
      if (sd < d) d = sd;
    }
    return d;
  }

  /* ======================================================================
     Time of day and weather: one light model drives the terrain bake, the water, the sprites and the grade.
     The golden-hour key is the designed look; the other keys are the same place at other times.
     ====================================================================== */
  const DESIGN = { sunC: [1.62, 1.2, 0.76], skyC: [0.25, 0.35, 0.52], spec: [1.6, 1.25, 0.85], zen: [0.36, 0.55, 0.86], horC: [0.42, 0.58, 0.86], horW: [1.3, 0.92, 0.52], cldA: [0.82, 0.84, 0.92], cldB: [1.4, 1.18, 0.92], wl: [1, 1, 1] };
  const NOON = { sunC: [1.5, 1.44, 1.3], skyC: [0.27, 0.38, 0.56], spec: [1.6, 1.55, 1.4], zen: [0.3, 0.52, 0.92], horC: [0.46, 0.64, 0.92], horW: [0.9, 0.92, 0.9], cldA: [0.86, 0.89, 0.95], cldB: [1.2, 1.2, 1.15], wl: [1.06, 1.1, 1.1] };
  const SUNSET = { sunC: [1.5, 0.72, 0.32], skyC: [0.2, 0.2, 0.34], spec: [2.6, 1.05, 0.36], zen: [0.18, 0.24, 0.5], horC: [0.4, 0.36, 0.58], horW: [1.8, 0.74, 0.3], cldA: [0.7, 0.55, 0.6], cldB: [1.7, 0.85, 0.45], wl: [0.76, 0.66, 0.64] };
  const BLUE = { sunC: [0.2, 0.17, 0.28], skyC: [0.11, 0.14, 0.28], spec: [0.7, 0.4, 0.4], zen: [0.05, 0.08, 0.22], horC: [0.1, 0.13, 0.3], horW: [0.55, 0.27, 0.22], cldA: [0.22, 0.2, 0.32], cldB: [0.5, 0.3, 0.3], wl: [0.36, 0.4, 0.58] };
  const NIGHT = { sunC: [0.19, 0.25, 0.4], skyC: [0.06, 0.08, 0.14], spec: [0.62, 0.7, 0.9], zen: [0.012, 0.02, 0.045], horC: [0.03, 0.045, 0.085], horW: [0.06, 0.075, 0.11], cldA: [0.05, 0.06, 0.09], cldB: [0.1, 0.11, 0.15], wl: [0.2, 0.24, 0.36] };
  const SUNRISE = { sunC: [1.4, 0.84, 0.76], skyC: [0.27, 0.26, 0.42], spec: [2.1, 1.1, 0.95], zen: [0.3, 0.34, 0.62], horC: [0.56, 0.5, 0.72], horW: [1.6, 0.9, 0.82], cldA: [0.88, 0.74, 0.82], cldB: [1.6, 1.05, 0.98], wl: [0.86, 0.8, 0.88] };
  const BLUE_AM = { sunC: [0.26, 0.2, 0.3], skyC: [0.13, 0.13, 0.27], spec: [0.7, 0.45, 0.5], zen: [0.06, 0.08, 0.22], horC: [0.14, 0.14, 0.3], horW: [0.6, 0.34, 0.4], cldA: [0.26, 0.22, 0.34], cldB: [0.55, 0.34, 0.4], wl: [0.38, 0.4, 0.58] };
  const MORNING = Object.assign({}, DESIGN, { sunC: [1.58, 1.3, 0.96], horW: [1.2, 0.98, 0.74], cldB: [1.36, 1.2, 1.0] });
  const KEYS_PM = [[-13, NIGHT], [-5, BLUE], [3, SUNSET], [20, DESIGN], [50, NOON]];
  const KEYS_AM = [[-13, NIGHT], [-5, BLUE_AM], [3, SUNRISE], [20, MORNING], [50, NOON]];
  const D2R = Math.PI / 180, DESIGN_EL = 34.75 * D2R, DESIGN_ANG = Math.atan2(SUN[1], SUN[0]), MOON_ANG = -0.98;
  const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
  const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const mulv = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
  const ILL0 = [DESIGN.sunC[0] * 0.57 + DESIGN.skyC[0], DESIGN.sunC[1] * 0.57 + DESIGN.skyC[1], DESIGN.sunC[2] * 0.57 + DESIGN.skyC[2]];
  const DIR0 = lum(DESIGN.sunC) * 0.57;
  function keyAt(keys, e) {
    if (e <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (e <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i], t = sstep(a[0], b[0], e), o = {};
      for (const k in a[1]) o[k] = mix3(a[1][k], b[1][k], t);
      return o;
    }
    return keys[keys.length - 1][1];
  }
  function angMix(a, b, t) { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; }
  // Everything the frame needs from ctx.env. With the clock off and neutral weather this returns the designed constants exactly.
  function computeLook(ctx) {
    const E = ctx.env, design = !E.timeActive, e = E.sunElev, am = E.hour < 12;
    const K = design ? DESIGN : keyAt(am ? KEYS_AM : KEYS_PM, e);
    let ang = DESIGN_ANG, el = DESIGN_EL, Lc = 0.82, Ls = 0.57, slope = 0.62, nightK = 0, lampK = 0, mist = 0;
    if (!design) {
      nightK = sstep(-3, -11, e);
      ang = angMix(-Math.PI / 2 - (E.hour - 12) * 11 * D2R, MOON_ANG, nightK);
      const elS = e >= 20 ? 34.75 + (Math.min(e, 52) - 20) / 32 * 25 : 12 + clamp(e, 0, 20) / 20 * 22.75;
      el = mix(elS, 40, nightK) * D2R;
      const n = Math.hypot(0.82, 0.57);   // the design light vector is (sun * 0.82, 0.57), not unit length
      Lc = Math.cos(el) * n; Ls = Math.sin(el) * n;
      slope = Math.tan(el) * 0.62 / Math.tan(DESIGN_EL);
      if (am) mist = 0.14 * sstep(-7, -1, e) * (1 - sstep(4, 13, e));
    }
    const storm = E.storm, rain = E.rain, snow = E.snow, fog = E.fog;
    const ov = clamp(Math.max(E.cloud, rain * 0.95, snow * 0.9, storm, fog * 0.9), 0, 1);
    lampK = design ? 0 : sstep(5, -4, e - 9 * ov);
    let sunC = K.sunC, skyC = K.skyC, zen = K.zen, horC = K.horC, horW = K.horW, cldA = K.cldA, cldB = K.cldB, spec = K.spec, wl = K.wl;
    if (ov > 0) {
      const ill = lum(sunC) * Ls + lum(skyC), dk = 1 - 0.5 * storm;
      const amb = ill * 0.46 * dk, skyG = (lum(zen) * 0.4 + lum(horC) * 0.6 + lum(sunC) * 0.12) * 1.25 * dk;
      sunC = mul3(sunC, 1 - ov * (0.86 + 0.12 * storm));
      skyC = mix3(skyC, [amb * 0.94, amb, amb * 1.1], ov);
      zen = mix3(zen, [skyG * 0.86, skyG * 0.9, skyG * 0.98], ov); horC = mix3(horC, [skyG, skyG * 1.02, skyG * 1.08], ov);
      horW = mix3(horW, [skyG * 1.12, skyG * 1.08, skyG * 1.06], ov);
      cldA = mix3(cldA, [skyG * 1.05, skyG * 1.08, skyG * 1.14], ov); cldB = mix3(cldB, [skyG * 1.3, skyG * 1.28, skyG * 1.3], ov);
      spec = mul3(spec, (1 - ov) * (1 - ov));
      const wg = lum(wl) * (1 - 0.45 * storm) * (1 - 0.15 * rain);
      wl = mix3(wl, [wg * 0.8, wg * 0.86, wg * 0.92], ov);
    }
    if (!design) skyC = [Math.max(skyC[0], 0.05), Math.max(skyC[1], 0.066), Math.max(skyC[2], 0.115)];   // moonlit floor: never pitch black behind the labels
    const ill = [sunC[0] * Ls + skyC[0], sunC[1] * Ls + skyC[1], sunC[2] * Ls + skyC[2]];
    const LT = [ill[0] / ILL0[0], ill[1] / ILL0[1], ill[2] / ILL0[2]];
    const dirK = clamp(lum(sunC) * Ls / DIR0, 0, 1.25);
    const fogE = clamp(Math.max(fog, mist * (1 - rain), rain * 0.1, snow * 0.12), 0, 1);
    const fogC = [(sunC[0] * 0.2 + skyC[0]) * 0.72, (sunC[1] * 0.2 + skyC[1]) * 0.74, (sunC[2] * 0.2 + skyC[2]) * 0.8];
    return {
      design, ang, dir: [Math.cos(ang), Math.sin(ang)], el, Lc, Ls, slope, shLen: clamp(0.62 / slope, 0.35, 3), nightK, lampK, ov,
      sunC, skyC, zen, horC, horW, cldA, cldB, spec, wl, LT, dirK, fogE, fogC,
      specEl: clamp(0.78 + (el - DESIGN_EL) * 0.25, 0.7, 0.95),
      windK: E.wind / 0.3, rough: 1 + Math.max(0, E.wind - 0.3) * 1.4 + storm * 0.9 + rain * 0.25,
      caps: clamp(Math.max(0, E.wind - 0.42) * 2.4 + storm, 0, 1.2), rain, wet: Math.max(rain, storm), snow,
      flash: E.lightning * 0.75, csK: (1 - 0.9 * ov) * (1 - 0.55 * nightK), cov: ov,
      fireflies: nightK * (1 - rain) * (1 - snow) * (1 - sstep(0.5, 0.9, E.wind))
    };
  }
  // The values the terrain bake depends on. A new bake (spread over a few frames, then cross-faded) starts when they drift.
  const bakeKey = L => [L.dir[0], L.dir[1], L.slope * 0.3, L.Lc, L.Ls, ...L.sunC, ...L.skyC, L.snow];
  const keyDiff = (a, b) => { if (!a) return 1; let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

  /* ======================================================================
     State
     ====================================================================== */
  let progF, progT, progM, progC, progMul, progFog;
  let tF = null, tT = null, tT2 = null, tTh = null, tC = null, cacheTex = null;
  let front = null, LK = null, bakedKey = null, bakedL = null, relight = null, fadeOld = 0, oldTex = null;
  const STRIPS = 4;
  const cOff = [0, 0], wOff = [0, 0];
  let lamps = [], lampsOld = [], flies = [], rainP = [], snowP = [], strafes = [], fx = [], marks = [];
  let TX = null;             // photo textures
  let dirty = true, wasAnim = false, frameK = 0;
  const HA = new Float32Array(16), HB = new Float32Array(16);
  let bNew = [], bOld = [];
  const bldU = new Float32Array(NB * 4); let nBU = 0;
  let C = null;              // ctx
  let shoreOff = 0, hillK = 1, sig = 70;
  let boats = [], fighters = null, birdGroups = [], petals = [], rings = [], splashes = [], booms = [], bolts = [], droids = [], hunters = [];
  let skT = 14, ringT = 0;
  const R1 = Math.random;

  function hillsCPU(x, y) {
    const e = [y, C.W - x, C.H - y, x], s = [x, y, x, y];
    let m = -1e4;
    for (let i = 0; i < 4; i++) {
      const w = 0.6 * Math.sin(s[i] * HB[i * 4] + HB[i * 4 + 2]) + 0.4 * Math.sin(s[i] * HB[i * 4 + 1] + HB[i * 4 + 3]) + HA[i * 4 + 2];
      m = Math.max(m, (HA[i * 4 + 1] * Math.max(w, 0) - 10) * hillK - e[i]);
    }
    return Math.min(m, 0.8 * (C.distAt(x, y) - 1.6 * sig - 70));
  }
  // Positive or near zero: land (with a safety margin for the shader's noise). Clearly negative: open water.
  const landVal = (x, y) => Math.max(shoreOff - C.blobAt(x, y) + 0.25 * sig, hillsCPU(x, y) + 30);

  function placeBuildings(ctx) {
    const list = ctx.icons; if (!list.length) return [];
    const R = iconRects(list), s = ctx.P.sigma, so = 0.35 * s, r = ctx.rng(77), out = [];
    const cands = [], step = 12;
    for (let y = 24; y < ctx.H - 24; y += step) for (let x = 24; x < ctx.W - 24; x += step) {
      const jx = x + (r() - 0.5) * step, jy = y + (r() - 0.5) * step;
      const d = distF(R, jx, jy); if (d < 30) continue;
      const h = so - blobF(R, jx, jy, s) - 0.24 * s;
      if (h < 14) continue;
      cands.push({ x: jx, y: jy, d, h, k: r() });
    }
    cands.sort((a, b) => a.k - b.k);
    const types = [{ t: 'palace', r: 34, max: 3, sz: 2.3 }, { t: 'wing', r: 27, max: 3, sz: 2.25 }, { t: 'tower', r: 12, max: 7, sz: 2.4 }, { t: 'pavilion', r: 14, max: 9, sz: 2.3 }];
    for (const T of types) {
      let n = 0;
      for (const c of cands) {
        if (n >= T.max || out.length >= 22) break;
        if (c.d < T.r + 22 || c.h < T.r * 0.85 + 10) continue;
        if (c.x < T.r || c.y < T.r || c.x > ctx.W - T.r || c.y > ctx.H - T.r) continue;
        if (out.some(o => Math.hypot(o.x - c.x, o.y - c.y) < o.r + T.r + 16)) continue;
        out.push({ x: c.x, y: c.y, r: T.r, t: T.t, w: T.r * T.sz, v: r() < 0.55 ? 'copper' : 'gold' });
        n++;
      }
    }
    return out.sort((a, b) => a.y - b.y);
  }

  function steer(a, want, turn, dt) { let d = want - a.ang; d = Math.atan2(Math.sin(d), Math.cos(d)); const m = turn * dt; a.ang += clamp(d, -m, m); a.turnRate = clamp(d, -m, m) / Math.max(dt, 1e-4); }
  function avoidPointer(a, want, R) {
    const Pt = C.pointer; if (!Pt.active) return want;
    const dx = a.x - Pt.x, dy = a.y - Pt.y, d = Math.hypot(dx, dy);
    if (d >= R) return want;
    const push = 1 - d / R;
    a.spd *= 1 + push * C.dt * 1.5;
    return angMix(want, Math.atan2(dy, dx), Math.min(1, push * 1.4));
  }
  function avoidIcons(a, want, margin) {
    const look = a.spd * 0.5, lx = a.x + Math.cos(a.ang) * look, ly = a.y + Math.sin(a.ang) * look;
    if (lx < 0 || ly < 0 || lx > C.W || ly > C.H) return want;
    const dd = C.distAt(lx, ly);
    if (dd >= margin) return want;
    const g = C.gradAt(lx, ly), ga = Math.atan2(g[1], g[0]), push = clamp(1 - dd / margin, 0, 1);
    return Math.atan2(Math.sin(want) * (1 - push) + Math.sin(ga) * push * 1.6, Math.cos(want) * (1 - push) + Math.cos(ga) * push * 1.6);
  }

  /* ---------------- Boats ---------------- */
  function spawnBoat(b) {
    for (let k = 0; k < 60; k++) {
      const x = 40 + R1() * (C.W - 80), y = 40 + R1() * (C.H - 80);
      if (landVal(x, y) < -40 && C.distAt(x, y) > 70) { b.x = x; b.y = y; b.ang = R1() * TAU; b.alpha = 0; b.dead = false; return true; }
    }
    b.x = -999; b.y = -999; b.dead = true; b.alpha = 0; return false;
  }
  function updateBoats(dt, t) {
    const want = Math.round(7 * C.P.traffic);
    while (boats.length < want) { const b = { spd: 9 + R1() * 7, ph: R1() * 50, canopy: R1() < 0.5, lamp: R1() < 0.6 }; spawnBoat(b); boats.push(b); }
    if (boats.length > want) boats.length = want;
    for (const b of boats) {
      if (b.dead) { if (R1() < dt * 0.5) spawnBoat(b); continue; }
      const here = landVal(b.x, b.y);
      b.alpha = Math.min(1, b.alpha + dt * 0.5) * (here > -8 ? Math.max(0, 1 - (here + 8) / 10) : 1);
      if (here > 2) { spawnBoat(b); continue; }
      let wantA = b.ang + Math.sin(t * 0.13 + b.ph) * 0.6;
      const la = 50, lx = b.x + Math.cos(b.ang) * la, ly = b.y + Math.sin(b.ang) * la;
      const lv = landVal(lx, ly);
      const out = lx < 20 || ly < 20 || lx > C.W - 20 || ly > C.H - 20;
      if (lv > -26 || out) {
        const e = 6, gx = landVal(lx + e, ly) - landVal(lx - e, ly), gy = landVal(lx, ly + e) - landVal(lx, ly - e);
        wantA = out ? Math.atan2(C.H / 2 - b.y, C.W / 2 - b.x) : Math.atan2(-gy, -gx);
      }
      // The cursor: gondolas steer gently away and the gondolier picks up the pace
      const Pt = C.pointer;
      if (Pt.active) {
        const dx = b.x - Pt.x, dy = b.y - Pt.y, d = Math.hypot(dx, dy);
        if (d < 160) { const push = 1 - d / 160; wantA = angMix(wantA, Math.atan2(dy, dx), Math.min(1, push * 1.2)); b.boost = Math.max(b.boost || 0, push); }
      }
      b.boost = Math.max(0, (b.boost || 0) - dt * 0.35);
      steer(b, wantA, 0.35 + 0.5 * b.boost, dt);
      const sp = b.spd * (1 + 1.3 * b.boost), E = C.env, wd = Math.max(0, E.wind - 0.2) * 7;
      b.x += Math.cos(b.ang) * sp * dt + Math.cos(E.windDir) * wd * dt; b.y += Math.sin(b.ang) * sp * dt + Math.sin(E.windDir) * wd * dt;
    }
  }

  /* ---------------- Birds and petals ---------------- */
  function initLife(ctx) {
    const r = ctx.rng(5);
    birdGroups = [];
    for (let i = 0; i < 3; i++) {
      const g = { cx: r() * ctx.W, cy: r() * ctx.H, ha: r() * TAU, R: 34 + r() * 40, w: (r() < 0.5 ? -1 : 1) * (0.35 + r() * 0.25), a: r() * TAU, birds: [] };
      const n = 4 + ((r() * 4) | 0);
      for (let k = 0; k < n; k++) g.birds.push({ ao: k / n * TAU + r() * 0.6, ro: (r() - 0.5) * 22, ph: r() * 20, sz: 11 + r() * 4 });
      birdGroups.push(g);
    }
    petals = [];
    const np = ctx.P.quality >= 1 ? 60 : 30;
    for (let i = 0; i < np; i++) petals.push({ x: r() * ctx.W, y: r() * ctx.H, ph: r() * 50, rot: r() * TAU, spin: (r() - 0.5) * 3, sz: 3 + r() * 2.6, type: r() < 0.62 ? 0 : r() < 0.6 ? 1 : 2, fl: 0.5 + r() });
  }
  function updateLife(dt, t) {
    const Pt = C.pointer;
    for (const g of birdGroups) {
      g.ha += Math.sin(t * 0.07 + g.R) * 0.25 * dt;
      // The cursor: the flock bursts apart, flees, and regroups after a few seconds
      if (Pt.active) {
        const dx = g.cx - Pt.x, dy = g.cy - Pt.y, d = Math.hypot(dx, dy);
        if (d < g.R * (1 + (g.sc || 0)) + 110) { g.sc = Math.min(1, (g.sc || 0) + dt * 4); g.fa = Math.atan2(dy, dx); }
      }
      g.sc = Math.max(0, (g.sc || 0) - dt * 0.22);
      const fl = (g.sc || 0) * 95;
      if (fl > 0.1) { g.cx += Math.cos(g.fa) * fl * dt; g.cy += Math.sin(g.fa) * fl * dt; }
      g.cx += Math.cos(g.ha) * 12 * dt; g.cy += Math.sin(g.ha) * 12 * dt;
      if (g.cx < -150) g.cx += C.W + 300; if (g.cx > C.W + 150) g.cx -= C.W + 300;
      if (g.cy < -150) g.cy += C.H + 300; if (g.cy > C.H + 150) g.cy -= C.H + 300;
      g.a += g.w * dt * (1 + 1.5 * (g.sc || 0));
    }
    for (const p of petals) {
      p.x += (13 + 7 * Math.sin(t * 0.21 + p.ph)) * dt;
      p.y += (5 + 10 * Math.sin(t * p.fl * 1.3 + p.ph)) * dt;
      p.rot += p.spin * dt * (1 + Math.sin(t * 2 + p.ph));
      if (p.x > C.W + 20) { p.x = -20; p.y = R1() * C.H; } if (p.y > C.H + 20) { p.y = -20; p.x = R1() * C.W; } if (p.y < -30) p.y = C.H + 10;
    }
    ringT -= dt;
    if (ringT <= 0) {
      ringT = 0.35 + R1() * 0.9;
      const x = R1() * C.W, y = R1() * C.H;
      if (landVal(x, y) < -20 && C.distAt(x, y) > 40) rings.push({ x, y, age: 0, life: 2.6 + R1(), sz: 12 + R1() * 14 });
    }
    for (const r of rings) r.age += dt;
    rings = rings.filter(r => r.age < r.life);
  }

  /* ---------------- Skirmish ---------------- */
  function fire(x, y, ang, color, o = {}) {
    bolts.push({ x, y, vx: Math.cos(ang) * (o.speed || 760), vy: Math.sin(ang) * (o.speed || 760), len: o.len || 16, color, intensity: o.intensity || 7, life: o.life || 0.8, age: 0, target: o.target || null, width: o.width || 1.7 });
  }
  function impact(x, y, color) {
    if (x < 0 || y < 0 || x > C.W || y > C.H || C.distAt(x, y) < 18) return;
    const water = landVal(x, y) < -4;
    splashes.push({ x, y, age: 0, life: water ? 1.5 : 0.6, big: 0.7, water, color });
  }
  function explode(d) {
    d.alive = false;
    const deb = [];
    for (let i = 0; i < 8; i++) { const a = R1() * TAU, s = 40 + R1() * 90; deb.push([Math.cos(a) * s + Math.cos(d.ang) * d.spd * 0.3, Math.sin(a) * s + Math.sin(d.ang) * d.spd * 0.3]); }
    booms.push({ x: d.x, y: d.y, age: 0, life: 1.3, deb, splashed: false, vx: Math.cos(d.ang) * d.spd * 0.35, vy: Math.sin(d.ang) * d.spd * 0.35 });
  }
  function startRaid() {
    const W = C.W, H = C.H;
    let ex, ey, gx, gy, best = -1;
    const ry = () => H * (0.12 + 0.76 * R1()), rx = () => W * (0.12 + 0.76 * R1());
    // Try several crossing lines and keep the one that stays farthest from the icons
    for (let k = 0; k < 14; k++) {
      const side = (R1() * 4) | 0; let a, b, c, d;
      if (side === 0) { a = -70; b = ry(); c = W + 120; d = ry(); }
      else if (side === 1) { a = W + 70; b = ry(); c = -120; d = ry(); }
      else if (side === 2) { a = rx(); b = -70; c = rx(); d = H + 120; }
      else { a = rx(); b = H + 70; c = rx(); d = -120; }
      let sc = 0;
      for (let i = 1; i < 16; i++) { const u = i / 16; sc += Math.min(160, C.distAt(mix(a, c, u), mix(b, d, u))); }
      if (sc > best) { best = sc; ex = a; ey = b; gx = c; gy = d; }
    }
    const ang = Math.atan2(gy - ey, gx - ex), c = Math.cos(ang), s = Math.sin(ang);
    const n = 2 + Math.round(R1() * (1 + 2 * C.P.skirmish));
    for (let i = 0; i < n; i++) {
      const lat = (i - (n - 1) / 2) * 36, back = Math.abs(i - (n - 1) / 2) * 32 + R1() * 12;
      droids.push({ x: ex - c * back - s * lat, y: ey - s * back + c * lat, ang, spd: 165 + R1() * 20, gx: gx - s * lat, gy: gy + c * lat, hp: 2 + ((R1() * 4) | 0), fireT: 0.6 + R1() * 1.2, burst: 0, ph: R1() * 10, alive: true, age: 0 });
    }
    for (let i = 0; i < 2; i++) hunters.push({ x: ex - c * (240 + i * 40) - s * (i ? 26 : -26), y: ey - s * (240 + i * 40) + c * (i ? 26 : -26), ang, spd: 240, fireT: 0.8 + i * 0.3, tgt: null, side: i ? 1 : -1, turnRate: 0 });
  }
  function updateSkirmish(dt, t) {
    const sk = C.P.skirmish;
    if (sk > 0) {
      skT -= dt;
      if (skT <= 0 && !droids.length && !hunters.length) { startRaid(); skT = mix(48, 9, sk) * (0.7 + 0.6 * R1()); }
    }
    const W = C.W, H = C.H, pad = 160;
    for (const d of droids) {
      d.age += dt;
      let want = Math.atan2(d.gy - d.y, d.gx - d.x) + Math.sin(t * 1.3 + d.ph) * 0.35;
      want = avoidIcons(d, avoidPointer(d, want, 170), 40);
      d.spd = mix(d.spd, 175, dt * 0.5);
      steer(d, want, 1.6, dt);
      d.x += Math.cos(d.ang) * d.spd * dt; d.y += Math.sin(d.ang) * d.spd * dt;
      d.fireT -= dt;
      if (d.fireT <= 0 && d.x > 0 && d.y > 0 && d.x < W && d.y < H && C.distAt(d.x, d.y) > 60) {
        const c = Math.cos(d.ang), s = Math.sin(d.ang);
        for (const k of [-1, 1]) fire(d.x + c * 12 - s * k * 6, d.y + s * 12 + c * k * 6, d.ang + (R1() - 0.5) * 0.06, [1, 0.13, 0.06], { life: 0.4 + R1() * 0.35, intensity: 7 });
        d.burst++;
        if (d.burst >= 3) { d.burst = 0; d.fireT = 1.2 + R1() * 1.8; } else d.fireT = 0.16;
      }
      if (d.age > 2 && (d.x < -pad || d.y < -pad || d.x > W + pad || d.y > H + pad)) d.alive = false;
    }
    for (const h of hunters) {
      if (!h.tgt || !h.tgt.alive) { h.tgt = null; let best = 1e9; for (const d of droids) if (d.alive) { const q = Math.hypot(d.x - h.x, d.y - h.y); if (q < best) { best = q; h.tgt = d; } } }
      let want = h.ang;
      if (h.tgt) {
        const d = h.tgt, tx = d.x + Math.cos(d.ang) * d.spd * 0.35 + Math.sin(d.ang) * h.side * 18, ty = d.y + Math.sin(d.ang) * d.spd * 0.35 - Math.cos(d.ang) * h.side * 18;
        want = Math.atan2(ty - h.y, tx - h.x);
        const dist = Math.hypot(d.x - h.x, d.y - h.y);
        h.spd = mix(h.spd, dist < 110 ? d.spd * 0.98 : 250, dt * 1.5);
        h.fireT -= dt;
        let err = Math.atan2(d.y - h.y, d.x - h.x) - h.ang; err = Math.atan2(Math.sin(err), Math.cos(err));
        if (h.fireT <= 0 && Math.abs(err) < 0.2 && dist < 420 && h.x > 0 && h.y > 0 && h.x < W && h.y < H && C.distAt(h.x, h.y) > 50) {
          const c = Math.cos(h.ang), s = Math.sin(h.ang), hit = R1() < 0.42;
          for (const k of [-1, 1]) fire(h.x + c * 10 - s * k * 9, h.y + s * 10 + c * k * 9, h.ang + err * 0.6, [0.25, 0.55, 1.0], { life: 0.75, intensity: 8, target: hit ? d : null });
          h.fireT = 0.3 + R1() * 0.35;
        }
      } else h.spd = mix(h.spd, 260, dt);
      want = avoidIcons(h, avoidPointer(h, want, 170), 36);
      steer(h, want, 2.3, dt);
      h.x += Math.cos(h.ang) * h.spd * dt; h.y += Math.sin(h.ang) * h.spd * dt;
      if (!h.tgt && !droids.some(d => d.alive) && (h.x < -pad || h.y < -pad || h.x > W + pad || h.y > H + pad)) h.gone = true;
    }
    droids = droids.filter(d => d.alive);
    hunters = hunters.filter(h => !h.gone);
    for (const b of bolts) {
      b.age += dt; b.x += b.vx * dt; b.y += b.vy * dt;
      if (C.distAt(b.x, b.y) < 10 && !(b.big && b.age > b.life * 0.6)) { b.dead = true; continue; }
      if (b.target && b.target.alive && Math.hypot(b.target.x - b.x, b.target.y - b.y) < 14) {
        b.dead = true; b.target.hp--;
        splashes.push({ x: b.target.x, y: b.target.y, age: 0, life: 0.25, big: 0.5, water: false, flash: true, color: [1, 0.6, 0.3] });
        if (b.target.hp <= 0) explode(b.target);
      } else if (b.age > b.life) { b.dead = true; if (b.big) bigImpact(b.tx, b.ty); else impact(b.x, b.y, b.color); }
    }
    bolts = bolts.filter(b => !b.dead);
    for (const m of booms) {
      m.age += dt; m.x += m.vx * dt; m.y += m.vy * dt; m.vx *= 1 - dt; m.vy *= 1 - dt;
      if (!m.splashed && m.age > 0.7) { m.splashed = true; if (landVal(m.x, m.y) < -4 && C.distAt(m.x, m.y) > 20) splashes.push({ x: m.x, y: m.y, age: 0, life: 2.2, big: 1.6, water: true, color: [1, 0.6, 0.3] }); }
    }
    booms = booms.filter(m => m.age < m.life);
    for (const s of splashes) s.age += dt;
    splashes = splashes.filter(s => s.age < s.life);
  }

  /* ---------------- Point and fire: a pair of fighters strafes the spot ---------------- */
  function strafe(x, y) {
    // Pick the heading whose run stays over open ground and water
    let best = -1, ang = 0;
    const a0 = R1() * TAU;
    for (let k = 0; k < 16; k++) {
      const a = a0 + k / 16 * TAU, c = Math.cos(a), s = Math.sin(a);
      let sc = 0;
      for (let i = -8; i <= 4; i++) sc += Math.min(110, C.distAt(x + c * i * 45, y + s * i * 45)) * (i < 0 ? 1 : 0.5);
      if (sc > best) { best = sc; ang = a; }
    }
    const c = Math.cos(ang), s = Math.sin(ang);
    let back = 260;
    while (back < 760) { const px = x - c * back, py = y - s * back; if (px < -60 || py < -60 || px > C.W + 60 || py > C.H + 60) break; back += 30; }
    const shots = [];
    const us = [-54, -36, -18, 0, 16, 32];
    us.forEach((u, i) => {
      const lat = (i % 2 ? 7 : -7) + (R1() - 0.5) * 6, tx = x + c * u - s * lat, ty = y + s * u + c * lat;
      if (u !== 0 && C.distAt(tx, ty) < 16) return;
      shots.push({ u, tx, ty, who: i % 2, fired: false });
    });
    strafes.push({ x, y, c, s, ang, back, along: -back, spd: 820, shots, age: 0 });
  }
  // Exact terrain height under a point, read back from the baked cache (one pixel, only when a strafing bolt lands)
  const px1 = new Float32Array(4);
  function heightAt(x, y) {
    const t = cacheTarget(); if (!t) return landVal(x, y);
    const gl = C.gl, sx = t.w / C.W;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.readPixels(clamp(Math.round(x * sx), 0, t.w - 1), clamp(Math.round(t.h - 1 - y * sx), 0, t.h - 1), 1, 1, gl.RGBA, gl.FLOAT, px1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, C.hdr ? C.hdr.fb : null);
      return px1[3];
    } catch (e) { return landVal(x, y); }
  }
  function bigImpact(x, y) {
    if (x < 0 || y < 0 || x > C.W || y > C.H) return;
    const d = C.distAt(x, y);
    if (d < 3) return;
    const k = clamp((d - 6) / 46, 0.28, 1), water = heightAt(x, y) < 0.3, drops = [];
    const n = water ? 12 : 10;
    for (let i = 0; i < n; i++) { const a = R1() * TAU; drops.push([Math.cos(a), Math.sin(a), (0.45 + R1() * 0.55) * 34 * k, R1()]); }
    fx.push({ x, y, age: 0, life: water ? 2.0 : 1.9, k, water, drops });
    marks.push({ x, y, age: 0, life: water ? 4.5 : 7.5, k, water, rot: R1() * TAU });
  }
  function updateStrafes(dt) {
    for (const st of strafes) {
      st.age += dt; st.along += st.spd * dt;
      for (const sh of st.shots) {
        if (sh.fired) continue;
        const along = st.along - (sh.who ? 30 : 0);
        if (along < sh.u - 250) continue;
        sh.fired = true;
        const lat = sh.who ? 15 : -15, fx0 = st.x + st.c * along - st.s * lat, fy0 = st.y + st.s * along + st.c * lat;
        const dx = sh.tx - fx0, dy = sh.ty - fy0, dist = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
        bolts.push({ x: fx0 + Math.cos(a) * 12, y: fy0 + Math.sin(a) * 12, vx: Math.cos(a) * 1150, vy: Math.sin(a) * 1150, len: 20, color: [0.25, 0.55, 1.0], intensity: 9, life: Math.max(0.05, (dist - 12) / 1150), age: 0, width: 1.9, big: true, tx: sh.tx, ty: sh.ty });
      }
    }
    strafes = strafes.filter(st => st.along < st.back + 260);
    for (const f of fx) f.age += dt;
    fx = fx.filter(f => f.age < f.life);
    for (const m of marks) m.age += dt;
    marks = marks.filter(m => m.age < m.life);
  }

  /* ---------------- Night lights: balustrade lamps and fireflies ---------------- */
  // Lamps stand on the white balustrade that rings each icon plateau (the shader draws it where platD = 15.2)
  function placeLamps(ctx) {
    const list = ctx.icons; if (!list.length) return [];
    const R = iconRects(list), s = ctx.P.sigma, so = 0.35 * s, out = [], r = ctx.rng(91);
    const platD = (x, y) => { const d = distF(R, x, y); return Math.max(Math.min(d, 15.2 + (blobF(R, x, y, s) + 0.75 * s) * 0.8), d - 28); };
    for (const ic of R) {
      for (let k = 0; k < 26; k++) {
        const a = k / 26 * TAU + r() * 0.1, c = Math.cos(a), sn = Math.sin(a);
        let rad = Math.min(ic.hw, ic.hh), px = 0, py = 0, hit = false;
        for (; rad < 320; rad += 3) { px = ic.cx + c * rad; py = ic.cy + sn * rad; if (platD(px, py) >= 15.2) { hit = true; break; } }
        if (!hit || px < 8 || py < 8 || px > ctx.W - 8 || py > ctx.H - 8) continue;
        if (so - blobF(R, px, py, s) - 0.25 * s < 8) continue;
        if (out.some(o => Math.hypot(o.x - px, o.y - py) < 34)) continue;
        if (bNew.some(b => Math.hypot(b.x - px, b.y - py) < b.r * 2.0)) continue;
        out.push({ x: px, y: py, th: r() * 0.55, ph: r() * 9 });
        if (out.length >= 140) return out;
      }
    }
    return out;
  }
  function placeFlies(ctx) {
    const r = ctx.rng(57), out = [];
    for (let k = 0; k < 600 && out.length < 44; k++) {
      const x = r() * ctx.W, y = r() * ctx.H;
      if (landVal(x, y) < 22 || ctx.distAt(x, y) < 34) continue;
      out.push({ ax: x, ay: y, x, y, ph: r() * 50, sp: 0.4 + r() * 0.6 });
    }
    return out;
  }

  /* ---------------- Rain streaks and snowflakes ---------------- */
  function updatePrecip(ctx, L, dt) {
    const E = ctx.env, q = ctx.P.quality >= 1 ? 1 : 0.55, wx = Math.cos(E.windDir), wy = Math.sin(E.windDir);
    const nR = Math.round(L.rain * 340 * q);
    while (rainP.length < nR) rainP.push({ x: 0, y: 0, age: 9, life: 0 });
    if (rainP.length > nR) rainP.length = nR;
    const rs = 160 + 520 * E.wind;
    for (const p of rainP) {
      p.age += dt;
      if (p.age >= p.life) { p.x = R1() * ctx.W; p.y = R1() * ctx.H; p.age = 0; p.life = 0.1 + R1() * 0.12; p.l = 0.6 + R1() * 0.8; }
      p.x += wx * rs * dt; p.y += wy * rs * dt;
    }
    const nS = Math.round(L.snow * 380 * q);
    while (snowP.length < nS) snowP.push({ x: R1() * ctx.W, y: R1() * ctx.H, z: R1(), ph: R1() * 40, sz: 0.7 + R1() * 0.6 });
    if (snowP.length > nS) snowP.length = nS;
    const t = ctx.flow, ws = 15 + 120 * E.wind;
    for (const p of snowP) {
      p.z -= dt * 0.16;
      if (p.z <= 0) { p.z = 1; p.x = R1() * ctx.W; p.y = R1() * ctx.H; }
      const k = 0.35 + p.z;
      p.x += (wx * ws * k + Math.sin(t * 0.9 + p.ph) * 9) * dt; p.y += (wy * ws * k + Math.cos(t * 0.7 + p.ph * 1.3) * 7) * dt;
      if (p.x < -10) p.x += ctx.W + 20; if (p.x > ctx.W + 10) p.x -= ctx.W + 20;
      if (p.y < -10) p.y += ctx.H + 20; if (p.y > ctx.H + 10) p.y -= ctx.H + 20;
    }
    for (const f of flies) {
      const t2 = t * f.sp;
      f.x = f.ax + Math.sin(t2 * 0.7 + f.ph) * 26 + Math.sin(t2 * 1.9 + f.ph * 2) * 7;
      f.y = f.ay + Math.cos(t2 * 0.6 + f.ph * 1.7) * 20 + Math.sin(t2 * 2.3 + f.ph) * 6;
    }
  }

  /* ======================================================================
     Rendering helpers
     ====================================================================== */
  function fillBuildingUniform(ctx) {
    const m = ctx.morph, aOld = 1 - sstep(0, 0.35, m), aNew = sstep(0.68, 1, m) * sstep(0.45, 0.9, ctx.intro);
    nBU = 0; bldU.fill(0);
    const put = (b, a) => { if (a <= 0.002 || nBU >= NB) return; const i = nBU * 4; bldU[i] = b.x; bldU[i + 1] = b.y; bldU[i + 2] = b.r; bldU[i + 3] = a; nBU++; };
    for (const b of bOld) put(b, aOld);
    for (const b of bNew) put(b, aNew);
    return { aOld, aNew };
  }
  const cacheTarget = () => [tT, tT2, tTh].find(t => t && t.tex === cacheTex) || null;
  function freeTargets(ctx) { for (const t of [tF, tT, tT2, tTh, tC]) ctx.freeTarget(t); tF = tT = tT2 = tTh = tC = front = null; relight = null; fadeOld = 0; oldTex = null; }
  // Night windows: light spilling from the colonnades and the lanterns atop the domes (sprite pixel coordinates)
  const WIN = {
    palace: { W: 320, H: 240, lan: [[160, 120, 1.6], [52, 58, 0.7], [268, 58, 0.7], [52, 182, 0.7], [268, 182, 0.7]], rows: [[60, 260, 44, 7], [60, 260, 196, 7], [18, 18, 70, 1], [302, 302, 170, 1]] },
    wing: { W: 256, H: 120, lan: [[70, 60, 0.8], [128, 60, 1], [186, 60, 0.8]], rows: [[24, 232, 18, 6], [24, 232, 102, 6]] },
    pavilion: { W: 128, H: 128, lan: [[64, 64, 1]], ring: [46, 6] },
    tower: { W: 112, H: 112, lan: [[56, 56, 1.1]], ring: [43, 8] }
  };
  const WARM = [1, 0.7, 0.36];
  function nightBuilding(ctx, b, a, k) {
    const w = WIN[b.t], sc = b.w / w.W, X = u => b.x + (u - w.W / 2) * sc, Y = v => b.y + (v - w.H / 2) * sc;
    ctx.glowDot(b.x, b.y, b.r * 1.9, [1, 0.62, 0.3], 0.07 * k * a);
    for (const l of w.lan) ctx.glowDot(X(l[0]), Y(l[1]), 3.2 * l[2], WARM, 3.2 * k * a, { core: 0.7 });
    if (w.rows) for (const r of w.rows) for (let i = 0; i < r[3]; i++) {
      const u = r[3] > 1 ? mix(r[0], r[1], (i + 0.5) / r[3]) : r[0];
      ctx.glowDot(X(u), Y(r[2]), 3, WARM, 1.4 * k * a * (0.7 + 0.3 * Math.sin(i * 2.3 + b.x)), { core: 0.4 });
    }
    if (w.ring) for (let i = 0; i < w.ring[1]; i++) { const t = i / w.ring[1] * TAU; ctx.glowDot(X(w.W / 2 + Math.cos(t) * w.ring[0]), Y(w.H / 2 + Math.sin(t) * w.ring[0]), 2.2, WARM, 1.6 * k * a, { core: 0.5 }); }
  }

  Galaxy.register(ID, {
    name: 'Lake country',
    defaultHour: 17,
    post(ctx) {
      const P0 = { bloom: 0.75, threshold: 1.1, knee: 0.6, exposure: 1.02, vignette: 0.42, grain: 0.018, aberration: 0.0007, tint: [1.07, 1.0, 0.88], lift: [0.012, 0.008, 0.0], saturation: 1.06, bloomRadius: 1.1 };
      const L = LK; if (!L) return P0;
      const n = L.nightK, ov = L.ov;
      if (L.design && ov <= 0) return P0;
      const neutral = clamp(n * 0.85 + ov * 0.7, 0, 1);
      P0.tint = mix3(P0.tint, [1, 1, 1], neutral);
      P0.exposure *= 1 + 0.22 * n;
      P0.lift = [0.012 * (1 - n) + 0.006 * n, 0.008 * (1 - n) + 0.009 * n, 0.016 * n];
      P0.saturation *= (1 - 0.16 * n) * (1 - 0.14 * ov);
      P0.bloom *= 1 + 0.25 * n;
      P0.threshold = mix(1.1, 0.95, n);
      P0.vignette = mix(0.42, 0.5, n);
      return P0;
    },

    init(ctx) {
      C = ctx;
      progF = ctx.program(FIELD_FS);
      progT = ctx.program(TERRAIN_FS);
      progM = ctx.program(MAIN_FS);
      progC = ctx.program(CLOUD_FS);
      progMul = ctx.program(MUL_FS);
      progFog = ctx.program(FOG_FS);
      const AS = 'assets/galaxy/' + ID + '/';
      TX = {
        det: ctx.loadTexture(AS + 'detail.webp', { srgb: false }),
        cliff: ctx.loadTexture(AS + 'cliff.jpg'),
        rock: ctx.loadTexture(AS + 'rocks.jpg'),
        mead: ctx.loadTexture(AS + 'meadow.jpg'),
        water: ctx.loadTexture(AS + 'water.png', { srgb: false }),
        caus: ctx.loadTexture(AS + 'caustics.jpg', { srgb: false })
      };
      // Hills along the four screen edges
      const r = ctx.rng(11);
      for (let i = 0; i < 4; i++) {
        HA[i * 4] = 0; HA[i * 4 + 1] = 110 + r() * 130; HA[i * 4 + 2] = -0.2 + r() * 0.5; HA[i * 4 + 3] = 0;
        HB[i * 4] = TAU / (900 + r() * 1100); HB[i * 4 + 1] = TAU / (380 + r() * 420); HB[i * 4 + 2] = r() * TAU; HB[i * 4 + 3] = r() * TAU;
      }
      const A = ctx.atlas;
      A.define('palace0', 320, 240, (g, w, h) => drawPalace(g, w, h, 'copper'));
      A.define('palace1', 320, 240, (g, w, h) => drawPalace(g, w, h, 'gold'));
      A.define('wing0', 256, 120, (g, w, h) => drawWing(g, w, h, 'copper'));
      A.define('wing1', 256, 120, (g, w, h) => drawWing(g, w, h, 'gold'));
      A.define('pavilion0', 128, 128, (g, w, h) => drawPavilion(g, w, h, 'copper'));
      A.define('pavilion1', 128, 128, (g, w, h) => drawPavilion(g, w, h, 'gold'));
      A.define('tower0', 112, 112, (g, w, h) => drawTower(g, w, h, 'copper'));
      A.define('tower1', 112, 112, (g, w, h) => drawTower(g, w, h, 'gold'));
      A.define('gondola0', 336, 84, (g, w, h) => { g.scale(1.5, 1.5); drawGondola(g, 224, 56, true); });
      A.define('gondola1', 336, 84, (g, w, h) => { g.scale(1.5, 1.5); drawGondola(g, 224, 56, false); });
      A.define('wake', 256, 128, drawWake);
      A.define('fighter', 480, 180, drawFighter);
      A.define('droid', 280, 280, (g, w, h) => { g.scale(1.4, 1.4); drawDroid(g, 200, 200); });
      A.define('birdUp', 96, 48, (g, w, h) => drawBird(g, w, h, true));
      A.define('birdDn', 96, 48, (g, w, h) => drawBird(g, w, h, false));
      A.define('petal', 40, 28, (g, w, h) => { const gr = g.createRadialGradient(w * 0.4, h * 0.4, 1, w / 2, h / 2, w / 2); gr.addColorStop(0, '#fff0f4'); gr.addColorStop(1, '#e889a8'); g.fillStyle = gr; g.beginPath(); g.ellipse(w / 2, h / 2, w * 0.46, h * 0.4, 0, 0, TAU); g.fill(); });
      A.define('leaf', 40, 24, (g, w, h) => { g.fillStyle = '#6f9a2c'; g.beginPath(); g.moveTo(2, h / 2); g.quadraticCurveTo(w / 2, -2, w - 2, h / 2); g.quadraticCurveTo(w / 2, h + 2, 2, h / 2); g.fill(); g.strokeStyle = '#3d5c16'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(3, h / 2); g.lineTo(w - 3, h / 2); g.stroke(); });
      A.define('ripple', 128, 128, (g, w, h) => { g.filter = 'blur(1.5px)'; g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 5; circ(g, w / 2, h / 2, 54); g.stroke(); g.strokeStyle = 'rgba(255,255,255,0.4)'; g.lineWidth = 3; circ(g, w / 2, h / 2, 40); g.stroke(); g.filter = 'none'; });
      A.define('puff', 64, 64, (g, w, h) => { const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); });
      // Scorch mark: a dark blast centre with ragged spokes of thrown soil
      A.define('scorch', 128, 128, (g, w, h) => {
        const cx = w / 2, cy = h / 2, rr0 = ctx.rng(313);
        g.fillStyle = 'rgba(52,38,24,0.55)';
        for (let i = 0; i < 26; i++) { const a = i / 26 * TAU + rr0() * 0.2, l = 30 + rr0() * 30, wd = 0.08 + rr0() * 0.1; g.beginPath(); g.moveTo(cx + Math.cos(a - wd) * 12, cy + Math.sin(a - wd) * 12); g.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l); g.lineTo(cx + Math.cos(a + wd) * 12, cy + Math.sin(a + wd) * 12); g.fill(); }
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 34);
        gr.addColorStop(0, 'rgba(14,10,8,0.95)'); gr.addColorStop(0.55, 'rgba(30,22,15,0.8)'); gr.addColorStop(1, 'rgba(45,33,22,0)');
        g.fillStyle = gr; circ(g, cx, cy, 34); g.fill();
      });
      fighters = new ctx.Flock({ count: 0, speed: 150, turn: 1.2, margin: 46, wander: 0.5, formation: 1, spacing: 28, seedK: 21 });
      boats = []; bolts = []; droids = []; hunters = []; booms = []; splashes = []; rings = [];
      strafes = []; fx = []; marks = []; rainP = []; snowP = []; lamps = []; lampsOld = []; flies = [];
      skT = 6 + Math.random() * 6;
      initLife(ctx);
      dirty = true; bakedKey = null; LK = null;
    },

    resize(ctx) {
      freeTargets(ctx);
      tF = ctx.makeTarget(Math.max(4, ctx.pxW >> 2), Math.max(4, ctx.pxH >> 2), { float: true });
      tT = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true });
      tT2 = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true });
      tTh = ctx.makeTarget(Math.max(4, ctx.pxW >> 1), Math.max(4, ctx.pxH >> 1), { float: true });
      front = tT; cacheTex = tT.tex;
      tC = ctx.makeTarget(Math.max(4, ctx.pxW >> 2), Math.max(4, ctx.pxH >> 2), { float: true });
      dirty = true;
    },

    layout(ctx) {
      bOld = bNew;
      bNew = placeBuildings(ctx);
      lampsOld = lamps;
      lamps = placeLamps(ctx);
      flies = placeFlies(ctx);
      dirty = true;
    },

    update(ctx) {
      C = ctx;
      const dt = ctx.dt, t = ctx.flow;
      sig = ctx.P.sigma;
      shoreOff = mix(-1.3 * sig - 40, 0.35 * sig, ctx.intro);
      hillK = ctx.intro;
      LK = computeLook(ctx);
      const E = ctx.env, ex = Math.max(0, E.wind - 0.3);
      cOff[0] += Math.cos(E.windDir) * ex * 45 * dt; cOff[1] += Math.sin(E.windDir) * ex * 45 * dt;
      wOff[0] -= Math.cos(E.windDir) * ex * 0.03 * dt; wOff[1] -= Math.sin(E.windDir) * ex * 0.03 * dt;
      const nf = 2 * Math.round(3 * ctx.P.traffic);
      if (fighters.agents.length !== nf) fighters.resize(nf);
      fighters.update(dt, t);
      updateBoats(dt, t);
      updateLife(dt, t);
      updateSkirmish(dt, t);
      updateStrafes(dt);
      updatePrecip(ctx, LK, dt);
    },

    fire(ctx, x, y) { C = ctx; strafe(x, y); },

    render(ctx) {
      const gl = ctx.gl;
      frameK++;
      const L = LK || (LK = computeLook(ctx));
      const fade = fillBuildingUniform(ctx);
      const anim = !ctx.fieldStable || ctx.intro < 1 || (fade.aOld > 0 && fade.aOld < 1) || (fade.aNew > 0 && fade.aNew < 1);
      if (anim) { if (frameK % 2 === 0) dirty = true; wasAnim = true; }
      else if (wasAnim) { dirty = true; wasAnim = false; }
      const W1 = 0.42 * sig + 6;
      const key = bakeKey(L);
      const bu = Lb => ({ uSun: Lb.dir, uW1: W1, uBld: bldU, uNB: nBU, SUNC: Lb.sunC, SKYC: Lb.skyC, uSlope: Lb.slope, uSnow: Lb.snow, uLc: Lb.Lc, uLs: Lb.Ls });
      const texT = () => ({ uA: tF.tex, uDet: TX.det, uCliffT: TX.cliff, uRockT: TX.rock, uMeadT: TX.mead });
      if (dirty) {
        dirty = false; relight = null; fadeOld = 0;
        ctx.fullscreen(progF, { uHA: HA, uHB: HB, uShoreOff: shoreOff, uHillK: hillK, uBld: bldU, uNB: nBU }, {}, tF);
        // While icons morph (or the scene grows in) the terrain is rebuilt at half resolution; full resolution once it settles
        const tgt = anim ? tTh : front;
        ctx.fullscreen(progT, bu(L), texT(), tgt);
        cacheTex = tgt.tex; bakedKey = key; bakedL = L;
      } else if (relight && !anim) {
        // Relighting for a new time of day or weather: one horizontal strip per frame into the back cache, then a cross-fade
        const back = relight.tgt, i = relight.i, y0 = Math.floor(back.h * i / STRIPS), y1 = Math.floor(back.h * (i + 1) / STRIPS);
        gl.enable(gl.SCISSOR_TEST); gl.scissor(0, y0, back.w, y1 - y0);
        ctx.fullscreen(progT, bu(relight.L), texT(), back);
        gl.disable(gl.SCISSOR_TEST);
        if (++relight.i >= STRIPS) { oldTex = cacheTex; front = back; cacheTex = back.tex; bakedKey = relight.key; bakedL = relight.L; fadeOld = 1; relight = null; }
      } else if (!anim && fadeOld <= 0 && keyDiff(bakedKey, key) > 0.012) {
        relight = { tgt: front === tT ? tT2 : tT, i: 0, key, L };
      }
      if (fadeOld > 0) fadeOld = Math.max(0, fadeOld - Math.max(ctx.rawDt, 1 / 60) / 1.4);
      const BL = bakedL || L;
      ctx.fullscreen(progC, { uCov: L.cov, uFog: L.fogE, uCOff: cOff }, {}, tC);
      // Virtual camera for the glitter: the sun (or moon) path is centred in the upper left of the lake
      const el = L.specEl, Lz = Math.sin(el), Lc = Math.cos(el), camZ = 0.6 * Math.max(ctx.W, ctx.H);
      const gx = ctx.W * 0.42, gy = ctx.H * 0.2, sd = L.dir;
      const cam = [gx - sd[0] * Lc / Lz * camZ, gy - sd[1] * Lc / Lz * camZ, camZ];
      ctx.fullscreen(progM, {
        uSun: BL.dir, uW1: W1, uCam: cam, uL: [sd[0] * Lc, sd[1] * Lc, Lz], uQ: ctx.P.quality, uFadeOld: fadeOld,
        uZen: L.zen, uHorC: L.horC, uHorW: L.horW, uCldA: L.cldA, uCldB: L.cldB, uSpecC: L.spec, uWL: L.wl, uLT: L.LT,
        uShLen: BL.shLen, uDirK: L.dirK, uRough: L.rough, uCaps: L.caps, uRain: L.rain, uWet: L.wet, uIce: L.snow, uFlash: L.flash, uWindK: L.windK, uWOff: wOff
      }, { uCache: cacheTex, uCache2: oldTex || cacheTex, uCloud: tC.tex, uWater: TX.water, uCaus: TX.caus }, null);

      const t = ctx.flow, intro = ctx.intro, LT = L.LT, shA = Math.min(1, L.dirK), sl = L.shLen;
      const SHx = -L.dir[0] * sl, SHy = -L.dir[1] * sl;
      // Fish rings (fish stay down in rain and on ice)
      const ringA = 0.32 * (1 - 0.8 * L.rain) * (1 - L.snow);
      for (const r of rings) { const k = r.age / r.life; ctx.sprite('ripple', r.x, r.y, { w: 2 + r.sz * Math.sqrt(k), alpha: ringA * (1 - k) * intro, tint: LT }); }
      // Strafing marks: scorched earth, or a fading patch of foam
      for (const mk of marks) {
        const k = mk.age / mk.life, a = Math.min(1, mk.age * 6) * (1 - k) * (1 - k);
        if (mk.water) { ctx.sprite('puff', mk.x, mk.y, { w: 34 * mk.k * (1 + k), alpha: 0.35 * a, tint: LT }); }
        else ctx.sprite('scorch', mk.x, mk.y, { w: 58 * mk.k, rot: mk.rot, alpha: 1 - k * k });
      }
      // Boats with wakes
      for (const b of boats) {
        if (b.dead || b.alpha <= 0.01) continue;
        const c = Math.cos(b.ang), s = Math.sin(b.ang), a = b.alpha * intro;
        ctx.sprite('wake', b.x - c * 37, b.y - s * 37, { w: 108, rot: b.ang, alpha: 0.5 * a * (1 + 0.6 * (b.boost || 0)), tint: LT });
      }
      for (const b of boats) {
        if (b.dead || b.alpha <= 0.01) continue;
        const a = b.alpha * intro;
        ctx.sprite(b.canopy ? 'gondola0' : 'gondola1', b.x, b.y, { w: 48, rot: b.ang, alpha: a, tint: LT, shadow: { dx: SHx * 3, dy: SHy * 3, alpha: 0.5 * shA, bias: 1.2 } });
      }
      // Splash rings on water
      for (const s of splashes) {
        if (!s.water) continue;
        const k = s.age / s.life;
        ctx.sprite('ripple', s.x, s.y, { w: (5 + 46 * Math.sqrt(k)) * s.big, alpha: 0.6 * (1 - k), tint: LT });
        if (k > 0.15) { const k2 = (k - 0.15) / 0.85; ctx.sprite('ripple', s.x, s.y, { w: (4 + 30 * Math.sqrt(k2)) * s.big, alpha: 0.45 * (1 - k2), tint: LT }); }
      }
      for (const f of fx) {
        if (!f.water) continue;
        const k = f.age / f.life;
        for (let i = 0; i < 2; i++) { const k2 = (k - i * 0.18) / (1 - i * 0.18); if (k2 > 0) ctx.sprite('ripple', f.x, f.y, { w: (10 + (70 - 25 * i) * Math.sqrt(k2)) * f.k, alpha: 0.42 * (1 - k2) * (1 - k2), tint: LT }); }
      }
      // Palaces
      const aOld = fade.aOld, aNew = fade.aNew;
      const drawB = (b, a) => {
        if (a <= 0.01) return;
        const name = (b.t === 'palace' ? 'palace' : b.t === 'wing' ? 'wing' : b.t === 'tower' ? 'tower' : 'pavilion') + (b.v === 'copper' ? '0' : '1');
        const sl2 = b.t === 'tower' ? 9 : b.t === 'pavilion' ? 4 : 6;
        ctx.sprite(name, b.x, b.y, { w: b.w * (0.92 + 0.08 * a), alpha: a, tint: LT, shadow: { dx: SHx * sl2, dy: SHy * sl2, alpha: 0.55 * shA, bias: 1.6 } });
      };
      for (const b of bOld) drawB(b, aOld);
      for (const b of bNew) drawB(b, aNew);
      ctx.flush();

      // Drifting cloud shadows over everything on the ground
      gl.enable(gl.BLEND); gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      ctx.fullscreen(progMul, { uCS: L.csK }, { uCloud: tC.tex }, null);
      // Mist and fog banks on the lake
      if (L.fogE > 0.004) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        ctx.fullscreen(progFog, { uFogC: L.fogC, uFog: L.fogE }, { uCloud: tC.tex, uCache: cacheTex }, null);
      }
      gl.disable(gl.BLEND);

      // Night: palace windows, balustrade lamps, lanterns and fireflies come on as the light fades
      const lk = L.lampK * intro;
      if (lk > 0.01) {
        for (const b of bOld) if (aOld > 0.01) nightBuilding(ctx, b, aOld, lk);
        for (const b of bNew) if (aNew > 0.01) nightBuilding(ctx, b, aNew, lk);
        const lampDraw = (lm, a) => {
          const k = sstep(lm.th, lm.th + 0.25, lk) * a * (0.94 + 0.06 * Math.sin(t * 3 + lm.ph));
          if (k <= 0.01) return;
          ctx.glowDot(lm.x, lm.y, 12, [1, 0.6, 0.28], 0.09 * k);
          ctx.glowDot(lm.x, lm.y, 2.3, WARM, 3.6 * k, { core: 0.8 });
        };
        for (const lm of lampsOld) lampDraw(lm, aOld);
        for (const lm of lamps) lampDraw(lm, aNew);
      }
      if (L.fireflies > 0.02) for (const f of flies) {
        const bl = Math.pow(Math.max(0, Math.sin(t * 1.3 * f.sp + f.ph)), 6);
        if (bl > 0.02) ctx.glowDot(f.x, f.y, 2.6, [0.7, 1, 0.3], 3 * bl * L.fireflies * intro, { core: 0.6 });
      }
      // Air layer: lamps, splashes, birds, fighters, droids, bolts, explosions, petals
      for (const b of boats) if (!b.dead && (b.lamp || lk > 0.3) && b.alpha > 0.05) {
        const x = b.x + Math.cos(b.ang) * 18, y = b.y + Math.sin(b.ang) * 18;
        ctx.glowDot(x, y, 3.6, [1, 0.7, 0.3], (2.2 + 3 * lk) * b.alpha * intro, { core: 0.6 });
        if (lk > 0.05) ctx.glowDot(x, y, 14, [1, 0.6, 0.3], 0.16 * lk * b.alpha);
      }
      for (const s of splashes) {
        const k = s.age / s.life;
        if (s.flash) { ctx.glowDot(s.x, s.y, 6 + 10 * k, s.color, 9 * (1 - k), { core: 1 - k }); continue; }
        if (s.water) {
          if (k < 0.5) ctx.sprite('puff', s.x, s.y, { w: 10 * s.big * (1 + k * 2), alpha: 0.8 * (1 - k * 2), tint: mulv(LT, [1.3, 1.3, 1.25]) });
          if (s.age < 0.15) ctx.glowDot(s.x, s.y, 5 * s.big, [0.8, 0.9, 1], 4 * (1 - s.age / 0.15));
        } else {
          ctx.glowDot(s.x, s.y, 4 + 10 * k, s.color, 5 * (1 - k) * (1 - k), { core: 1 - k });
          ctx.sprite('puff', s.x, s.y, { w: 8 + 12 * k, alpha: 0.35 * (1 - k), tint: mulv(LT, [0.45, 0.38, 0.3]) });
        }
      }
      // Strafing impacts: tall water columns, or a flash and a burst of soil
      for (const f of fx) {
        const k = f.age / f.life, K = f.k;
        if (f.water) {
          const ca = clamp(f.age / 0.9, 0, 1), hgt = Math.sin(Math.PI * ca) * 26 * K;
          if (ca < 1) {
            ctx.sprite('puff', f.x + SHx * hgt * 0.8, f.y + SHy * hgt * 0.8, { w: (10 + 22 * Math.sqrt(ca)) * K, alpha: 0.35 * shA * (1 - ca), tint: [0.02, 0.05, 0.08] });
            ctx.sprite('puff', f.x, f.y, { w: (8 + 26 * Math.sqrt(ca)) * K, alpha: 0.95 * (1 - ca * ca), tint: mul3(LT, 1.5) });
            ctx.sprite('puff', f.x, f.y, { w: (4 + 12 * Math.sqrt(ca)) * K, alpha: 0.9 * (1 - ca), tint: mul3(LT, 1.9) });
          }
          for (const d of f.drops) {
            const u = clamp(f.age / (0.9 + d[3] * 0.5), 0, 1), r = d[2] * Math.sqrt(u) * 1.2;
            if (u < 1) ctx.sprite('puff', f.x + d[0] * r, f.y + d[1] * r, { w: (2.2 + 1.8 * d[3]) * K + 1, alpha: 0.9 * (1 - u), tint: mul3(LT, 1.4) });
          }
          if (f.age < 0.14) ctx.glowDot(f.x, f.y, 12 * K, [0.6, 0.8, 1], 7 * (1 - f.age / 0.14), { core: 1 });
        } else {
          if (f.age < 0.25) { const q = 1 - f.age / 0.25; ctx.glowDot(f.x, f.y, 18 * K, [0.55, 0.72, 1], 9 * q * q, { core: q }); ctx.glowDot(f.x, f.y, 10 * K, [1, 0.6, 0.25], 6 * q, { core: q }); }
          for (let i = 0; i < 3; i++) {
            const a = i * 2.1 + f.drops[0][3] * 6, dd = 6 * K * Math.sqrt(k);
            ctx.sprite('puff', f.x + Math.cos(a) * dd + SHx * 4 * k, f.y + Math.sin(a) * dd + SHy * 4 * k, { w: (14 + 40 * Math.sqrt(k)) * K, alpha: 0.85 * (1 - k) * (1 - k), tint: mul3([0.36, 0.28, 0.2], Math.max(0.25, lum(LT))) });
          }
          // A column of thrown soil: dark core seen from above, its shadow thrown off along the light
          const ca = clamp(f.age / 0.8, 0, 1);
          if (ca < 1) {
            const hgt = Math.sin(Math.PI * ca) * 22 * K;
            ctx.sprite('puff', f.x + SHx * hgt, f.y + SHy * hgt, { w: (10 + 16 * ca) * K, alpha: 0.4 * shA * (1 - ca), tint: [0.02, 0.02, 0.02] });
            ctx.sprite('puff', f.x, f.y, { w: (8 + 20 * Math.sqrt(ca)) * K, alpha: 0.95 * (1 - ca), tint: mul3([0.22, 0.16, 0.11], Math.max(0.3, lum(LT))) });
          }
          for (const d of f.drops) {
            const u = clamp(f.age / (0.55 + d[3] * 0.4), 0, 1), r = d[2] * (1 - (1 - u) * (1 - u));
            if (u < 1) {
              const x = f.x + d[0] * r, y = f.y + d[1] * r;
              ctx.sprite('puff', x, y, { w: (2 + 2 * d[3]) * K + 0.8, alpha: 0.95 * (1 - u * u), tint: [0.06, 0.045, 0.03] });
              if (d[3] < 0.3) ctx.glowDot(x, y, 1.4, [1, 0.55, 0.2], 3 * (1 - u));
            }
          }
          if (f.age < 1.4) ctx.glowDot(f.x, f.y, 5 * K, [1, 0.42, 0.12], 2.2 * (1 - f.age / 1.4) * (1 - f.age / 1.4));
        }
      }
      // Gulls: tinted by the light, scattering from the cursor
      for (const g of birdGroups) for (const bd of g.birds) {
        const sc = g.sc || 0, a = g.a + bd.ao, R = (g.R + bd.ro) * (1 + 1.6 * sc);
        const x = g.cx + Math.cos(a) * R, y = g.cy + Math.sin(a) * R * 0.8;
        const head = angMix(Math.atan2(Math.cos(a) * 0.8 * g.w, -Math.sin(a) * g.w), Math.atan2(Math.sin(a) * 0.8, Math.cos(a)), sc * 0.7);
        const glide = sc < 0.2 && Math.sin(t * 0.5 + bd.ph) > 0.25;
        const up = glide || Math.sin(t * (11 + 9 * sc) + bd.ph * 3) > 0;
        ctx.sprite(up ? 'birdUp' : 'birdDn', x, y, { w: bd.sz, rot: head, alpha: intro, tint: LT, shadow: { dx: SHx * 22, dy: SHy * 22, alpha: 0.16 * shA, bias: 2 } });
      }
      const fw = 62;
      const fShadow = (h0, a) => ({ dx: SHx * h0, dy: SHy * h0, alpha: 0.5 * shA * a, bias: 2.2, scale: 0.97 });
      for (const a of fighters.agents) {
        const bank = 1 - Math.min(0.35, Math.abs(a.turnRate || 0) * 0.3);
        ctx.sprite('fighter', a.x, a.y, { w: fw, h: fw * 0.375 * bank, rot: a.ang, alpha: intro, tint: LT, shadow: fShadow(46, 1) });
      }
      for (const h of hunters) {
        const bank = 1 - Math.min(0.35, Math.abs(h.turnRate || 0) * 0.3);
        ctx.sprite('fighter', h.x, h.y, { w: fw, h: fw * 0.375 * bank, rot: h.ang, tint: LT, shadow: fShadow(40, 1) });
      }
      for (const d of droids) ctx.sprite('droid', d.x, d.y, { w: 40, rot: d.ang, tint: LT, shadow: fShadow(40, 1) });
      // The strafing pair dives in from altitude (larger, with a far-off shadow), levels out over the target and climbs away
      const runners = [];
      for (const st of strafes) for (const who of [0, 1]) {
        const along = st.along - (who ? 30 : 0), lat = who ? 15 : -15;
        const x = st.x + st.c * along - st.s * lat, y = st.y + st.s * along + st.c * lat;
        const dive = clamp(st.age / 0.45, 0, 1), climb = sstep(st.back - 60, st.back + 220, along);
        const alt = 1 - dive * (1 - climb), sz = fw * (1 + 0.5 * alt), a = clamp(st.age / 0.2, 0, 1) * (1 - sstep(st.back + 120, st.back + 250, along));
        ctx.sprite('fighter', x, y, { w: sz, h: sz * 0.375, rot: st.ang, alpha: a, tint: LT, shadow: fShadow(36 + 90 * alt, a) });
        runners.push([x, y, st.ang, a, sz]);
      }
      const engines = (x, y, ang, k, w) => {
        const c = Math.cos(ang), s = Math.sin(ang);
        for (const sd2 of [-1, 1]) {
          const ox = -w * 0.245, oy = sd2 * w * 0.1125;
          ctx.glowDot(x + c * ox - s * oy, y + s * ox + c * oy, 2.6 * w / fw, [0.4, 0.65, 1.0], 2.6 * k, { core: 0.6 });
        }
      };
      for (const a of fighters.agents) engines(a.x, a.y, a.ang, intro, fw);
      for (const h of hunters) engines(h.x, h.y, h.ang, 1, fw);
      for (const r of runners) engines(r[0], r[1], r[2], r[3] * r[3], fw);
      for (const d of droids) { const c = Math.cos(d.ang), s = Math.sin(d.ang); ctx.glowDot(d.x - c * 15, d.y - s * 15, 5, [1, 0.35, 0.15], 2.5, { core: 0.5 }); ctx.glowDot(d.x + c * 15, d.y + s * 15, 2, [1, 0.1, 0.05], 3); }
      for (const b of bolts) {
        const sp = Math.hypot(b.vx, b.vy), ux = b.vx / sp, uy = b.vy / sp;
        ctx.glowLine(b.x - ux * b.len, b.y - uy * b.len, b.x, b.y, b.width * 2.2, b.color, b.intensity, { core: 1.3, coreR: 0.32 });
      }
      for (const mb of booms) {
        const k = mb.age / mb.life;
        for (let i = 0; i < 3; i++) ctx.sprite('puff', mb.x + (i - 1) * 6 * k, mb.y + (i % 2) * 5 * k, { w: 14 + 40 * k, alpha: 0.55 * (1 - k), tint: [0.16, 0.13, 0.11] });
        ctx.glowDot(mb.x, mb.y, 8 + 34 * k, [1, 0.55, 0.2], 14 * (1 - k) * (1 - k), { core: Math.max(0, 1 - k * 3) });
        for (const v of mb.deb) { const x = mb.x + v[0] * mb.age, y = mb.y + v[1] * mb.age; ctx.glowLine(x - v[0] * 0.04, y - v[1] * 0.04, x, y, 1.6, [1, 0.6, 0.25], 6 * (1 - k)); }
      }
      // Petals and leaves drift on the breeze, but not through rain or snow
      const petA = 0.9 * intro * (1 - L.rain) * (1 - L.snow);
      if (petA > 0.01) for (const p of petals) {
        const name = p.type === 2 ? 'leaf' : 'petal';
        ctx.sprite(name, p.x, p.y, { w: p.sz, rot: p.rot, alpha: petA, tint: p.type === 1 ? mulv(LT, [1.15, 1.1, 1.1]) : LT, shadow: { dx: SHx * 8, dy: SHy * 8, alpha: 0.18 * shA, bias: 1.5 } });
      }
      // Rain streaks and snowflakes, thinned out right around the icons
      if (rainP.length) {
        const E = ctx.env, wx = Math.cos(E.windDir), wy = Math.sin(E.windDir), ln = 3 + 15 * E.wind;
        const rc = mix3([0.55, 0.6, 0.68], [0.9, 0.95, 1.05], L.flash), ri = 0.22 + 0.25 * lum(LT);
        for (const p of rainP) {
          if (C.distAt(p.x, p.y) < 10) continue;
          const k = Math.sin(Math.PI * p.age / p.life);
          ctx.glowLine(p.x - wx * ln * p.l, p.y - wy * ln * p.l, p.x, p.y, 0.9, rc, ri * k, { core: 0.3 });
        }
      }
      if (snowP.length) {
        const st = mul3(LT, 1.25);
        for (const p of snowP) {
          const dI = C.distAt(p.x, p.y); if (dI < 2) continue;
          const a = Math.min(1, (1 - p.z) * 5) * Math.min(1, p.z * 12) * sstep(2, 24, dI);
          ctx.sprite('puff', p.x, p.y, { w: (2.2 + 3.4 * p.z) * p.sz, alpha: 0.9 * a, tint: st });
        }
      }
    },

    dispose(ctx) {
      for (const p of [progF, progT, progM, progC, progMul, progFog]) if (p) ctx.gl.deleteProgram(p.p);
      freeTargets(ctx);
      bNew = []; bOld = [];
    }
  });
})();
