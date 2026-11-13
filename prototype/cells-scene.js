// Deskland · Cells: one calm surface in the style of the original themes (Beach, Salt flats).
// Two materials and the boundary between them:
//   - fluid (most of the screen): a deep blue-teal gradient with fine grain, faint soft light dapples
//   - cell (where the icons are): each icon area, merged through the blob field, is one living cell of glassy cytoplasm
//   - membrane (the boundary, the star): a thin bright double line with a soft glow that breathes and undulates;
//     ripples travel along it when a vesicle fuses, the way waves wash a shore
// Very few movers: a handful of vesicles drift in the fluid and sometimes fuse with a membrane; rarely a small nucleus
// fragment floats past. Double-click forms a vesicle that drifts to the nearest membrane and fuses.
// Everything is one full-screen pass plus a few sprites.
(function () {
  'use strict';
  const ID = 'cells';
  const TAU = Math.PI * 2;
  const NRIP = 8;                       // ripples the shader can show at once
  const NFUS = 8;                       // fusing vesicles the shader can merge at once
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const sst = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const ease = (c, t, rate, dt) => c + (t - c) * (1 - Math.exp(-rate * dt));

  /* ---------------- the surface ---------------- */
  const MAIN_FS = `
uniform vec4 uRip[${NRIP}];   // fusion ripples: x, y, age (s), strength (px)
uniform vec4 uFus[${NFUS}];
uniform vec3 uFusC[${NFUS}];
uniform vec4 uFusT[${NFUS}];   // rotation, lobe phase, drawn by the shader (irregular), squash direction
uniform vec4 uFusS[${NFUS}];   // lobe 2 amount, lobe 3 amount, squash, breath
uniform vec3 uFusM[${NFUS}];   // cytoplasm tint of a shader-drawn vesicle   // the colour each vesicle's contents spread into the cytoplasm   // fusing vesicles: x, y, radius, phase (sign: +1 from the fluid, -1 from inside; |phase| < 1 approach, 1..2 after joining)
// Merge fusing vesicles into the membrane as metaballs: the membrane bulges toward an approaching vesicle, their
// outlines join into one shape (smooth union), the joined bump opens and flattens back flush. puff: contents spreading.
// Two fields. sL (returned) carries the full membrane shape, including the neck to an approaching vesicle; it is used
// only for the thin membrane lines. sSh carries vesicles only once they have joined; every other shading term (fill,
// glow, halo, lighter fluid) reads it, so nothing brightens around a vesicle before it touches. vm masks the approaching
// vesicle's own circle out of the lines, because its sprite draws that rim. The bulge acts only near the membrane.
// A vesicle's outline. Clear bubbles are circles. Irregular ones are small soft cells: two or three low lobes that
// wobble slowly, plus a squash along an axis (after a bump, or pressed against a partner) that relaxes again.
float vesD(vec2 d, float r, vec4 T, vec4 Sh) {
  float ca = cos(T.w), sa = sin(T.w);
  vec2 e = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y);
  float k = 1. - Sh.z; e.x /= k; e.y *= k;
  float a = atan(d.y, d.x + 1e-5) - T.x;
  float rad = r * (1. + Sh.x * cos(2. * a + T.y) + Sh.y * cos(3. * a + T.y * 2.3) + Sh.w);
  return (length(e) - rad) * .92;
}
// Two fields. sL (returned) carries the full membrane shape, including the neck to an approaching vesicle; it is used
// only for the thin membrane lines. sSh carries vesicles only once they have joined; every other shading term (fill,
// glow, halo, lighter fluid) reads it, so nothing brightens around a clear bubble before it touches. vm masks an
// approaching clear bubble's own circle out of the lines, because its sprite draws that rim. Irregular vesicles have no
// sprite: they are drawn here as small cells in both fields all the time (uFusT.z = 1). vt: their cytoplasm tint.
// sG: the shading field without the not-yet-joined small cells (their glow is added separately from dvm, at their scale)
float fuseS(vec2 p, float s, out vec3 puff, out float sSh, out float vm, out vec4 vt, out float sG, out float dvm) {
  puff = vec3(0); vm = 0.; vt = vec4(0); dvm = 1e3;
  float sA = s; sSh = s; sG = s;
  for (int k = 0; k < ${NFUS}; k++) {
    vec4 f = uFus[k];
    if (f.w == 0.) continue;
    float side = sign(f.w), m = abs(f.w), r = f.z, dd = length(p - f.xy);
    if (m < 1. && dd > r * 6. + 24.) continue;   // far from a vesicle that has not joined: no visible effect
    vec4 T = uFusT[k], Sh = uFusS[k];
    float drawn = T.z;
    float re, kb, bul;
    if (m < 1.) { re = r; kb = r * (.35 + .95 * m); bul = m * r * .6; }
    else {
      float u = m - 1.;
      re = r * (1. - smoothstep(.12, 1., u));
      kb = r * (1.3 - .7 * u);
      bul = r * .6 * (1. - smoothstep(.15, 1., u));
      puff += uFusC[k] * exp(-pow(dd / (r * (1.4 + 5. * u)), 2.)) * pow(max(1. - u / .8, 0.), 2.);
    }
    float bump = side * bul * exp(-pow(dd / (r * 2.2), 2.)) * exp(-max(side * s, 0.) / (r * 1.2));
    sA -= bump;
    float own = (m < 1. ? 1. : 1. - smoothstep(0., .12, m - 1.)) * (1. - drawn);
    vm = max(vm, own * (1. - smoothstep(r + .5, r + 3., dd)));
    if (re > .25) {
      float dv = vesD(p - f.xy, re, T, Sh);
      float u2 = side > 0. ? smin(sA, dv, kb) : -smin(-sA, dv, kb);
      float sNoV = sA;
      sA = u2;
      if (m >= 1. || drawn > .5) { sSh -= bump; sSh = side > 0. ? smin(sSh, dv, kb) : -smin(-sSh, dv, kb); }
      else sSh -= bump;
      if (m >= 1.) { sG -= bump; sG = side > 0. ? smin(sG, dv, kb) : -smin(-sG, dv, kb); }
      else { sG -= bump; if (drawn > .5) dvm = min(dvm, dv); }                   // the membrane's own bulge only, no circle
      // the lines skip an approaching clear bubble's own rim (the sprite draws it)
      sA = mix(sA, sNoV, own * (1. - smoothstep(r + .5, r + 3., dd)));
      float wv = drawn * smoothstep(1., -1., dv);
      vt += vec4(uFusM[k] * wv, wv);
    } else { sSh -= bump; sG -= bump; }
  }
  if (vt.w > 1e-3) vt.rgb /= vt.w;
  vt.w = min(vt.w, 1.);
  return sA;
}
float membraneS(vec2 p, float t, out float rip) {
  // signed distance to the membrane (negative inside a cell), breathing and undulating
  float b = iconBlob(p + vec2(gnoise(p * .006 + 3.1), gnoise(p * .006 + 8.7)) * 14.);
  float und = gnoise(p * .011 + vec2(t * .05, -t * .04)) * 4.5 + gnoise(p * .028 - vec2(t * .12, t * .09)) * 1.6;
  float breath = sin(t * .45 + gnoise(p * .004) * 3.) * 1.8;
  rip = 0.;
  for (int k = 0; k < ${NRIP}; k++) {
    vec4 r = uRip[k];
    if (r.w <= 0.) continue;
    float d = length(p - r.xy), front = r.z * 70.;
    rip += r.w * exp(-pow((d - front) / 26., 2.)) * exp(-r.z * .55) * cos((d - front) * .16);
  }
  rip *= exp(-abs(b) / 40.);
  return b + und + breath + rip;
}
void main() {
  vec2 p = cssPos();
  float t = uFlow;
  float rip;
  vec3 puff; float s, vm, sG, dvm; vec4 vt;
  float sL = fuseS(p, membraneS(p, t, rip), puff, s, vm, vt, sG, dvm);
  vec2 uv = p / uRes;
  float px = 1. / uScale;
  float grain = hash12(floor(gl_FragCoord.xy)) - .5;
  float dI = iconDist(p);

  // fluid: deep blue-teal, a little lighter in the upper middle; lighter teal "shallows" near a membrane
  float gr = length((uv - vec2(.45, .35)) * vec2(uRes.x / uRes.y, 1.));
  vec3 fluid = mix(vec3(.020, .070, .095), vec3(.006, .026, .046), smoothstep(.0, 1.15, gr));
  fluid = mix(fluid, vec3(.030, .105, .125), exp(-max(sG, 0.) / 70.) * .7 + exp(-max(dvm, 0.) / 8.) * .25);   // small cells: a small glow
  // soft dappled light, drifting slowly (thresholded warped noise, low contrast)
  vec2 dq = p * .009 + vec2(gnoise(p * .0021 + t * .01), gnoise(p * .0021 - 4.2 + t * .012)) * 1.4 + vec2(t * .006, -t * .004);
  float dap = smoothstep(.5, .9, vnoise(dq) * .7 + vnoise(dq * 2.3 + 1.7) * .3 + grain * .05);
  fluid += vec3(.010, .026, .03) * dap;
  fluid *= 1. + grain * .06;

  // cell: glassy cytoplasm, calm, faintest granular texture, light gathering under the membrane
  float si = max(-s, 0.);
  vec3 cyto = vec3(.050, .135, .155) + vec3(.03, .07, .075) * (1. - exp(-si / 90.));
  float gran = vnoise(p * .09 + t * .02) * .6 + vnoise(p * .23 - t * .015) * .4;
  cyto *= .94 + .1 * gran;
  float gl1 = mix(10., 3.2, vt.w), gl2 = mix(35., 9., vt.w);
  cyto += vec3(.09, .24, .27) * exp(-si / gl1) * .6 + vec3(.03, .08, .09) * exp(-si / gl2);
  cyto *= mix(vec3(1), vt.rgb, vt.w);
  // a faint echo contour inside, like a wet-sand band, breathing with the membrane
  float echo = -26. - 5. * sin(t * .3 + gnoise(p * .005) * 2.);
  cyto += vec3(.05, .13, .14) * exp(-pow((s - echo) / 3.5, 2.)) * .45;
  cyto *= 1. + grain * .05;
  // keep it calm and a touch darker right behind the icons so the labels stay readable
  cyto *= mix(.82, 1., smoothstep(0., 30., dI));

  float inside = smoothstep(px, -px, s);
  vec3 col = mix(fluid, cyto, inside);
  col += min(puff, vec3(.3)) * mix(.5, 1., smoothstep(0., 30., dI));   // the vesicle's contents spreading
  // the membrane: a thin bright double line (the bilayer) with a soft glow, brightest where a ripple passes
  float w = .55 + px * .5;
  float l1 = exp(-pow(sL / w, 2.)), l2 = exp(-pow((sL + mix(3.6, 2.1, vt.w)) / w, 2.)) * (1. - .35 * vt.w);
  float lift = 1. + clamp(abs(rip) * .22, 0., 1.6);
  vec3 memC = vec3(.62, .92, 1.);
  col += memC * (l1 * .95 + l2 * .55) * lift;
  col += vec3(.10, .34, .40) * (exp(-abs(sG + 1.8) / 7.) * .5 + exp(-abs(dvm + 1.) / 2.2) * .3) * lift;     // soft glow both sides
  col += vec3(.04, .14, .17) * (exp(-max(sG, 0.) / 22.) * .35 + exp(-max(dvm, 0.) / 5.) * .15);            // faint halo out into the fluid
  col = mix(fluid, col, uIntro);
  outColor = vec4(col, 1.);
}`;

  /* ---------------- sprites ---------------- */
  function rnd(seedv) { let a = seedv | 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); }
  function defineSprites(ctx) {
    const A = ctx.atlas;
    // vesicle: a small glassy bubble with a bright rim
    A.define('ves', 64, 64, (g, S) => {
      const c = S / 2, R = S * 0.36;
      let gr = g.createRadialGradient(c - R * 0.3, c - R * 0.3, 0, c, c, R);
      gr.addColorStop(0, 'rgba(190,240,250,.22)'); gr.addColorStop(1, 'rgba(120,200,220,.08)');
      g.fillStyle = gr; circle(g, c, c, R); g.fill();
      g.strokeStyle = 'rgba(215,248,255,.95)'; g.lineWidth = S * 0.05; circle(g, c, c, R); g.stroke();
      g.strokeStyle = 'rgba(190,235,250,.35)'; g.lineWidth = S * 0.025; circle(g, c, c, R * 0.8); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.7)'; circle(g, c - R * 0.4, c - R * 0.4, S * 0.05); g.fill();
    });
    // a softly lumpy, slightly oval vesicle (the rarer irregular variant), same glassy rim
    // a faint, small denser core (drawn inside a few vesicles)
    A.define('vcore', 32, 32, (g, S) => { const c = S / 2, gr = g.createRadialGradient(c, c, 0, c, c, c); gr.addColorStop(0, 'rgba(70,52,130,.85)'); gr.addColorStop(0.55, 'rgba(80,60,140,.45)'); gr.addColorStop(1, 'rgba(80,60,140,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); });
    A.define('speck', 24, 24, (g, S) => { const c = S / 2, gr = g.createRadialGradient(c, c, 0, c, c, c); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); });
    A.define('ring', 128, 128, (g, S) => { const c = S / 2; for (let k = 0; k < 5; k++) { g.strokeStyle = `rgba(255,255,255,${0.1 + k * 0.12})`; g.lineWidth = 10 - k * 2; circle(g, c, c, c - 8); g.stroke(); } });
    // a small violet nucleus fragment
    A.define('frag', 96, 96, (g, S) => {
      const r = rnd(911), c = S / 2, R = S * 0.36;
      const gr = g.createRadialGradient(c - R * 0.3, c - R * 0.3, R * 0.1, c, c, R);
      gr.addColorStop(0, 'rgba(160,140,215,.85)'); gr.addColorStop(1, 'rgba(84,64,150,.85)');
      g.fillStyle = gr; circle(g, c, c, R); g.fill();
      g.save(); circle(g, c, c, R); g.clip();
      for (let k = 0; k < 900; k++) { const a = r() * TAU, d = Math.sqrt(r()) * R; g.fillStyle = r() < 0.5 ? 'rgba(215,205,250,.18)' : 'rgba(45,28,95,.22)'; g.fillRect(c + Math.cos(a) * d, c + Math.sin(a) * d, 1, 1); }
      g.restore();
      g.strokeStyle = 'rgba(215,212,250,.55)'; g.lineWidth = 1.4; circle(g, c, c, R); g.stroke();
    });
  }

  /* ---------------- life ---------------- */
  let C = null, R = Math.random, prog = null;
  let testDone = false;
  let ves = [], specks = [], ripples = [], flashes = [], passer = null, nextPasser = 30, nextSeek = 20;
  const ripData = new Float32Array(NRIP * 4), fusData = new Float32Array(NFUS * 4), fusCol = new Float32Array(NFUS * 3), fusT = new Float32Array(NFUS * 4), fusS = new Float32Array(NFUS * 4), fusM = new Float32Array(NFUS * 3);

  function addRipple(x, y, amp) {
    if (ripples.length >= NRIP) ripples.shift();
    ripples.push({ x, y, age: 0, amp });
  }
  // A vesicle: drifts calmly; a seeking one heads for the nearest membrane. Touching a membrane, it fuses.
  // Rarer variants (about one vesicle in five): a subtle tint, a softly irregular outline, sometimes a faint denser core.
  // tint: sprite multiplier; puff: the colour its contents spread into the cytoplasm when it fuses
  const TINTS = [
    { tint: [1, 1, 1], puff: [.07, .19, .21] },              // clear (the common one)
    { tint: [0.99, 0.935, 1.0], puff: [.083, .172, .214] },  // faint lilac
    { tint: [0.92, 1.0, 0.95], puff: [.065, .195, .19] },    // pale aqua-green
    { tint: [0.86, 0.97, 1.0], puff: [.06, .18, .225] }      // slightly deeper cyan
  ];
  function newVesicle(x, y, o) {
    let tint = 0, lumpy = false, core = false;
    if (R() < 0.22) {
      const k = R();
      if (k < 0.45) tint = 1 + ((R() * 3) | 0);
      else if (k < 0.8) lumpy = true;
      else { tint = 1 + ((R() * 3) | 0); lumpy = true; }
      core = R() < 0.35;
    }
    return Object.assign({ x, y, vx: 0, vy: 0, r: 5 + R() * 4, a: 0, grow: 1, ph: R() * 100, seek: false, fuse: -1, dis: -1, A: 0, side: 1, life: 0, form: 0,
      tint, lumpy, core, lv: (R() * 2) | 0, rim: 0.88 + R() * 0.22, rot: R() * TAU, spin: (R() < 0.5 ? -1 : 1) * (0.04 + R() * 0.06), w: 0, sq: 0, sqv: 0, sqA: 0 }, o);
  }
  function spawnAmbient(ctx, v) {
    // a free spot in the fluid, well away from any cell
    for (let k = 0; k < 20; k++) {
      const x = R() * ctx.W, y = R() * ctx.H;
      if (ctx.blobAt(x, y) > 60 && ctx.distAt(x, y) > 120) { Object.assign(v, newVesicle(x, y)); return; }
    }
    Object.assign(v, newVesicle(R() * ctx.W, R() * ctx.H));
  }
  function stepVesicle(ctx, v, dt) {
    v.life += dt; v.ph += dt;
    if (v.form > 0) { v.form = Math.max(0, v.form - dt); v.grow = 1 - v.form / 0.7; }
    if (v.dis >= 0) { v.dis += dt; v.a = Math.max(0, 1 - v.dis / 0.6); return v.dis < 0.6; }   // no cell anywhere: dissolve
    if (v.fuse >= 0) {                      // joined: the bump sinks flush into the membrane while the ripple runs
      v.fuse += dt;
      const u = Math.min(1, v.fuse / v.T);
      v.x = v.jx + v.nx * v.r * 0.9 * sst(0.1, 1, u); v.y = v.jy + v.ny * v.r * 0.9 * sst(0.1, 1, u);
      return v.fuse < v.T;
    }
    const b = ctx.blobAt(v.x, v.y);
    // approach: within a few radii the membrane starts to bulge toward it (A: 0 far .. 1 touching)
    const near = Math.abs(b) - (v.r * 0.6 + 3);
    v.A = v.form > 0 ? 0 : clamp(1 - near / (v.r * 2.4 + 10), 0, 1);
    v.side = b > 0 ? 1 : -1;
    v.rot += (v.spin + v.w) * dt; v.w *= Math.exp(-dt * 0.7);   // spin from bumps decays in the viscous fluid
    // soft body: squash springs back with a little jiggle
    v.sqv += (-v.sq * 38 - v.sqv * 5) * dt; v.sq = clamp(v.sq + v.sqv * dt, -0.22, 0.3);
    let tx = Math.sin(v.ph * 0.13) * 7, ty = Math.cos(v.ph * 0.11 + 1.3) * 7;
    if (v.seek && b < 600) {
      const g = ctx.gradAt(v.x, v.y, ctx.blobAt), n = Math.hypot(g[0], g[1]) || 1, dir = b > 0 ? -1 : 1, sp = 38 * clamp(Math.abs(b) / 40, 0.45, 1);
      tx = g[0] / n * sp * dir; ty = g[1] / n * sp * dir;
    } else if (b < 50 && b > 0) {           // drifting ones that wander close are drawn in gently
      const g = ctx.gradAt(v.x, v.y, ctx.blobAt), n = Math.hypot(g[0], g[1]) || 1;
      tx -= g[0] / n * 6; ty -= g[1] / n * 6;
    }
    v.vx = ease(v.vx, tx, 1.5, dt); v.vy = ease(v.vy, ty, 1.5, dt);
    v.x += v.vx * dt; v.y += v.vy * dt;
    v.a = Math.min(1, v.a + dt * 0.8);
    if (near <= 0 && v.form <= 0) {         // join: from here the shader owns the shape; ripple and flash start now
      const g = ctx.gradAt(v.x, v.y, ctx.blobAt), n = Math.hypot(g[0], g[1]) || 1;
      v.nx = -g[0] / n * v.side; v.ny = -g[1] / n * v.side;      // toward the membrane
      v.jx = v.x; v.jy = v.y; v.fuse = 0; v.T = v.big ? 2.0 : 1.1; v.A = 1;
      addRipple(v.x, v.y, v.big ? 11 : 3 + v.r * 0.55);
      flashes.push({ x: v.x, y: v.y, t: 0, life: v.big ? 1.2 : 0.8, r: v.r * (v.big ? 6 : 4) });
    }
    if (v.seek && !(b < 600) && v.life > 8) { v.dis = 0; }
    return true;
  }

  // Vesicle-to-vesicle physics: soft elastic bumps (mass ~ area), and friction at the contact spins them.
  // Fusing, dissolving and still-forming vesicles take no part. The viscous drift in stepVesicle damps everything.
  function collide(ctx, dt) {
    const act = ves.filter(v => v.fuse < 0 && v.dis < 0 && v.form <= 0 && v.a > 0.3);
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), rr = a.r + b.r;
      if (d >= rr || d < 1e-3) continue;
      const nx = dx / d, ny = dy / d, ma = a.r * a.r, mb = b.r * b.r, im = 1 / ma + 1 / mb;
      // push apart (soft, split by inverse mass)
      const ov = (rr - d) * 0.5;
      a.x -= nx * ov * (1 / ma) / im; a.y -= ny * ov * (1 / ma) / im; b.x += nx * ov * (1 / mb) / im; b.y += ny * ov * (1 / mb) / im;
      const rvx = b.vx - a.vx, rvy = b.vy - a.vy, vn = rvx * nx + rvy * ny;
      const vt = -rvx * ny + rvy * nx + (a.w + a.spin) * a.r + (b.w + b.spin) * b.r;   // sliding speed at the contact
      if (vn < 0) {
        const J = -(1 + 0.6) * vn / im;                         // elastic-ish bump, restitution 0.6
        const na = Math.atan2(ny, nx);
        a.sqv += Math.min(2.5, J / ma * 0.09); a.sqA = na; b.sqv += Math.min(2.5, J / mb * 0.09); b.sqA = na;
        a.vx -= J * nx / ma; a.vy -= J * ny / ma; b.vx += J * nx / mb; b.vy += J * ny / mb;
        // friction at the contact turns both (solid discs, I = m r^2 / 2); lumpy ones get a little extra from their lobes
        const Jt = clamp(vt / (im + 2 / ma + 2 / mb), -Math.abs(J) * 0.5, Math.abs(J) * 0.5);
        a.w -= 2 * Jt / (ma * a.r); b.w -= 2 * Jt / (mb * b.r);
        if (a.lumpy) a.w += (R() - 0.5) * J / ma * 0.25; if (b.lumpy) b.w += (R() - 0.5) * J / mb * 0.25;
      }
    }
  }
  const QSV = new URLSearchParams(location.search).get('vtest') || '';
  const VHOLD = +new URLSearchParams(location.search).get('vhold') || 0;   // test: freeze the simulation at this scene time, for exact captures

  Galaxy.register(ID, {
    name: 'Cells',
    weather: false,
    defaultHour: 14,
    post: { bloom: 0.55, threshold: 0.85, knee: 0.5, exposure: 1.0, vignette: 0.32, grain: 0.018, aberration: 0.0005, saturation: 1.0, bloomRadius: 1.1 },

    init(ctx) {
      C = ctx; R = ctx.rng(5);
      prog = ctx.program(MAIN_FS);
      defineSprites(ctx);
      ves = []; specks = []; ripples = []; flashes = []; passer = null;
      nextPasser = 25 + R() * 40; nextSeek = ctx.mix(60, 10, ctx.P.skirmish) * (0.6 + 0.8 * R());
    },
    resize(ctx) { specks = []; },
    layout(ctx) { },

    // Double-click: a vesicle forms at that spot, drifts to the nearest membrane and fuses with a ripple
    fire(ctx, x, y) {
      const v = newVesicle(x, y, { r: 12, seek: true, form: 0.7, grow: 0, a: 1, big: true, tint: 0, lumpy: false, core: false, rim: 1 });
      ves.push(v);
      flashes.push({ x, y, t: 0, life: 0.7, r: 34 });
    },

    update(ctx) {
      if (VHOLD && ctx.t >= VHOLD) return;
      const dt = ctx.dt, P = ctx.P, area = ctx.W * ctx.H / (1920 * 1080);
      // ambient vesicles, honouring the activity setting
      const want = Math.round(P.traffic * 9 * area);
      let ambient = ves.filter(v => !v.seek && !v.keep).length;
      while (ambient < want) { const v = {}; spawnAmbient(ctx, v); ves.push(v); ambient++; }
      ves = ves.filter(v => {
        const alive = stepVesicle(ctx, v, dt);
        if (!alive && !v.seek && !v.keep && ves.filter(o => !o.seek && !o.keep).length <= want) { spawnAmbient(ctx, v); v.a = 0; return true; }
        return alive && v.x > -60 && v.y > -60 && v.x < ctx.W + 60 && v.y < ctx.H + 60;
      });
      if (ambient > want) { let extra = ambient - want; ves = ves.filter(v => v.seek || v.keep || extra-- <= 0); }
      if (QSV && !testDone && ctx.t > 5) {
        testDone = true;
        if (QSV === 'row') [[0,0,0],[1,0,0],[2,0,0],[3,0,0],[0,1,0],[1,1,0],[2,1,1],[0,0,1]].forEach((q, i) => ves.push(newVesicle(700 + i * 70, 960, { keep: true, tint: q[0], lumpy: !!q[1], core: !!q[2], lv: i & 1, r: 9, a: 1, rim: 1 })));
        if (QSV === 'merge') ves.push(newVesicle(1150, 620, { seek: true, keep: true, lumpy: true, tint: 2, core: true, r: 9, a: 1 }));
        if (QSV === 'bump') { ves.push(newVesicle(880, 880, { keep: true, lumpy: true, tint: 1, r: 9, a: 1, vx: 30, vy: 2 })); ves.push(newVesicle(915, 884, { keep: true, r: 7, a: 1, vx: -30, vy: 0, lumpy: false, tint: 0, core: false })); }
      }
      collide(ctx, dt);
      // occasional purposeful vesicle (rate follows the Infections/events setting)
      if (P.skirmish > 0) {
        nextSeek -= dt;
        if (nextSeek <= 0) {
          nextSeek = ctx.mix(60, 10, P.skirmish) * (0.6 + 0.8 * R());
          const v = {}; spawnAmbient(ctx, v); v.seek = true; v.r = 6 + R() * 3; ves.push(v);
        }
      }
      // tiny specks
      const ws = Math.round((0.3 + P.traffic) * 22 * area);
      while (specks.length < ws) specks.push({ x: R() * ctx.W, y: R() * ctx.H, s: 1.5 + R() * 2.5, a: 0.12 + R() * 0.25, ph: R() * 100 });
      if (specks.length > ws) specks.length = ws;
      for (const s of specks) {
        s.ph += dt; s.x += Math.sin(s.ph * 0.07) * 4 * dt + 2 * dt; s.y += Math.cos(s.ph * 0.05 + 2) * 3 * dt;
        if (s.x > ctx.W + 10) s.x = -10; if (s.y < -10) s.y = ctx.H + 10; if (s.y > ctx.H + 10) s.y = -10;
      }
      // a rare passer: a small violet nucleus fragment floating slowly across
      if (P.traffic > 0) {
        if (!passer) {
          nextPasser -= dt * (0.4 + P.traffic);
          if (nextPasser <= 0) {
            nextPasser = 50 + R() * 70;
            const left = R() < 0.5, y = ctx.H * (0.15 + R() * 0.7);
            passer = { kind: 'frag', x: left ? -80 : ctx.W + 80, y, vx: (left ? 1 : -1) * (12 + R() * 6), rot: R() * TAU, spin: (R() - 0.5) * 0.1, ph: R() * 100 };
          }
        } else {
          passer.x += passer.vx * dt; passer.ph += dt; passer.y += Math.sin(passer.ph * 0.2) * 4 * dt; passer.rot += passer.spin * dt;
          if (passer.x < -120 || passer.x > ctx.W + 120) passer = null;
        }
      }
      for (const r of ripples) r.age += dt;
      ripples = ripples.filter(r => r.age < 7);
      for (const f of flashes) f.t += dt;
      flashes = flashes.filter(f => f.t < f.life);
    },

    render(ctx) {
      ripData.fill(0);
      ripples.forEach((r, k) => { ripData[k * 4] = r.x; ripData[k * 4 + 1] = r.y; ripData[k * 4 + 2] = r.age; ripData[k * 4 + 3] = r.amp; });
      fusData.fill(0); fusCol.fill(0); fusT.fill(0); fusS.fill(0); fusM.fill(1);
      const pri = v => v.fuse >= 0 ? 3 : v.A > 0 ? 2 + v.A * 0.5 : 1;
      const fz = ves.filter(v => (v.fuse >= 0 || v.A > 0 || v.lumpy) && v.dis < 0 && v.a > 0.01).sort((a, b) => pri(b) - pri(a)).slice(0, NFUS);
      fz.forEach((v, k) => {
        const ph = v.fuse >= 0 ? 1 + Math.min(1, v.fuse / v.T) : Math.max(1e-4, Math.min(v.A, 0.999));
        fusData[k * 4] = v.x; fusData[k * 4 + 1] = v.y; fusData[k * 4 + 2] = v.r * v.grow; fusData[k * 4 + 3] = v.side * ph;
        const pc = TINTS[v.tint || 0].puff; fusCol[k * 3] = pc[0]; fusCol[k * 3 + 1] = pc[1]; fusCol[k * 3 + 2] = pc[2];
        if (v.lumpy) {
          const tc = TINTS[v.tint || 0].tint;
          fusT[k * 4] = v.rot; fusT[k * 4 + 1] = 0.4 + v.lv * 1.9; fusT[k * 4 + 2] = 1; fusT[k * 4 + 3] = v.sqA;
          fusS[k * 4] = 0.07 + 0.02 * Math.sin(v.ph * 0.5); fusS[k * 4 + 1] = 0.03 + 0.012 * Math.sin(v.ph * 0.37 + 1); fusS[k * 4 + 2] = v.sq; fusS[k * 4 + 3] = 0.02 * Math.sin(v.ph * 0.6) * v.a;
          fusM[k * 3] = tc[0] * tc[0]; fusM[k * 3 + 1] = tc[1] * tc[1]; fusM[k * 3 + 2] = tc[2] * tc[2];
        }
      });
      ctx.fullscreen(prog, { uRip: ripData, uFus: fusData, uFusC: fusCol, uFusT: fusT, uFusS: fusS, uFusM: fusM }, {}, null);
      const I = ctx.intro;
      for (const s of specks) {
        const b = ctx.blobAt(s.x, s.y), k = sst(0, 30, b);
        if (k > 0.01) ctx.sprite('speck', s.x, s.y, { w: s.s * 2, alpha: s.a * k * I, tint: [0.6, 0.9, 1], add: true });
      }
      if (passer) {
        const b = ctx.blobAt(passer.x, passer.y), k = sst(10, 60, b) * I;
        ctx.sprite('frag', passer.x, passer.y, { w: 26, rot: passer.rot, alpha: 0.75 * k });
      }
      for (const v of ves) {
        // the sprite hands over to the shader's merged shape: gone once the outlines have joined
        const hand = v.fuse >= 0 ? 1 - Math.min(1, v.fuse / (0.12 * v.T)) : 1;
        if (v.a * hand <= 0.01) continue;
        const w = v.r * 2 / 0.72 * v.grow;
        if (w < 0.5) continue;
        const tc = TINTS[v.tint].tint, al = v.a * hand * I, tn = [tc[0] * v.rim, tc[1] * v.rim, tc[2] * v.rim];
        if (!v.lumpy) ctx.sprite('ves', v.x, v.y, { w, alpha: al, tint: tn });
        if (v.core) ctx.sprite('vcore', v.x + Math.sin(v.ph * 0.3) * v.r * 0.15, v.y + Math.cos(v.ph * 0.25) * v.r * 0.15, { w: v.r * 1.15, alpha: al * 0.5 });
        if (v.seek) ctx.glowDot(v.x, v.y, v.r * 1.6, [0.5, 0.9, 1], 0.25 * v.a * hand, { core: 0 });
      }
      for (const f of flashes) {
        const k = f.t / f.life;
        ctx.sprite('ring', f.x, f.y, { w: f.r * (0.5 + k), alpha: (1 - k) * (1 - k) * 0.7, tint: [0.6, 0.95, 1], add: true });
        ctx.glowDot(f.x, f.y, f.r * 0.4, [0.5, 0.9, 1], 0.9 * (1 - k) * (1 - k), { core: 0.4 * (1 - k) });
      }
      ctx.flush();
    },

    dispose(ctx) { if (prog) ctx.gl.deleteProgram(prog.p); prog = null; }
  });
})();
