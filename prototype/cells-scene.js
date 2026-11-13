// Deskland · Cells: one calm surface in the style of the original themes (Beach, Salt flats).
// Two materials and the boundary between them:
//   - fluid (most of the screen): a deep blue-teal gradient with fine grain, faint soft light dapples
//   - cell (where the icons are): each icon area, merged through the blob field, is one living cell of glassy cytoplasm
//   - membrane (the boundary, the star): a thin bright double line with a soft glow that breathes and undulates;
//     ripples travel along it when a vesicle fuses, the way waves wash a shore
// Very few movers: a handful of vesicles drift in the fluid and sometimes fuse with a membrane. Double-click forms a vesicle that drifts to the nearest membrane and fuses.
// Everything is one full-screen pass plus a few sprites.
(function () {
  'use strict';
  const ID = 'cells';
  const TAU = Math.PI * 2;
  const NRIP = 8;                       // ripples the shader can show at once
  const NFUS = 16;                      // vesicles the shader draws or merges at once (soft cells, approaching, fusing)
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
  fluid = mix(fluid, vec3(.030, .105, .125), exp(-max(sG, 0.) / 70.) * .7 + exp(-max(dvm, 0.) / 8.) * .16);   // small cells: a small glow
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
  cyto += vec3(.09, .24, .27) * exp(-si / gl1) * mix(.6, .4, vt.w) + vec3(.03, .08, .09) * exp(-si / gl2);
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
  // near a soft-cell vesicle the lines are thinner and dimmer, so it sits close to a clear bubble in weight (icon cells unchanged)
  float sc = 1. - smoothstep(3., 8., abs(dvm));
  float w = (.55 + px * .5) * mix(1., .65, sc);
  float l1 = exp(-pow(sL / w, 2.)), l2 = exp(-pow((sL + mix(3.6, 2.1, vt.w)) / w, 2.)) * (1. - .35 * vt.w);
  l1 *= mix(1., .63, sc); l2 *= mix(1., .63, sc);
  float lift = 1. + clamp(abs(rip) * .22, 0., 1.6);
  vec3 memC = vec3(.62, .92, 1.);
  col += memC * (l1 * .95 + l2 * .55) * lift;
  col += vec3(.10, .34, .40) * (exp(-abs(sG + 1.8) / 7.) * .5 + exp(-abs(dvm + 1.) / 2.2) * .19) * lift;     // soft glow both sides
  col += vec3(.04, .14, .17) * (exp(-max(sG, 0.) / 22.) * .35 + exp(-max(dvm, 0.) / 5.) * .095);            // faint halo out into the fluid
  col = mix(fluid, col, uIntro);
  outColor = vec4(col, 1.);
}`;

  /* ---------------- sprites ---------------- */
  function rnd(seedv) { let a = seedv | 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); }
  function defineSprites(ctx) {
    const A = ctx.atlas;
    // vesicle: a small glassy bubble with a bright rim
    for (const big of [false, true]) A.define(big ? 'vesB' : 'ves', 64, 64, (g, S) => {
      const c = S / 2, R = S * 0.36;
      let gr = g.createRadialGradient(c - R * 0.3, c - R * 0.3, 0, c, c, R);
      gr.addColorStop(0, 'rgba(190,240,250,.22)'); gr.addColorStop(1, 'rgba(120,200,220,.08)');
      g.fillStyle = gr; circle(g, c, c, R); g.fill();
      g.strokeStyle = 'rgba(215,248,255,.95)'; g.lineWidth = S * 0.05; circle(g, c, c, R); g.stroke();
      g.strokeStyle = big ? 'rgba(190,235,250,.21)' : 'rgba(190,235,250,.35)';   // the double-click vesicle's inner ring is muted
      g.lineWidth = S * 0.025; circle(g, c, c, R * 0.8); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.7)'; circle(g, c - R * 0.4, c - R * 0.4, S * 0.05); g.fill();
    });
    A.define('speck', 24, 24, (g, S) => { const c = S / 2, gr = g.createRadialGradient(c, c, 0, c, c, c); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); });
    A.define('ring', 128, 128, (g, S) => { const c = S / 2; for (let k = 0; k < 5; k++) { g.strokeStyle = `rgba(255,255,255,${0.1 + k * 0.12})`; g.lineWidth = 10 - k * 2; circle(g, c, c, c - 8); g.stroke(); } });
  }

  /* ---------------- life ---------------- */
  let C = null, R = Math.random, prog = null;
  let testDone = false;
  let ves = [], specks = [], ripples = [], flashes = [], nextSeek = 20, seeded = false;
  const ripData = new Float32Array(NRIP * 4), fusData = new Float32Array(NFUS * 4), fusCol = new Float32Array(NFUS * 3), fusT = new Float32Array(NFUS * 4), fusS = new Float32Array(NFUS * 4), fusM = new Float32Array(NFUS * 3);

  function addRipple(x, y, amp) {
    if (ripples.length >= NRIP) ripples.shift();
    ripples.push({ x, y, age: 0, amp });
  }
  // A vesicle: drifts calmly; a seeking one heads for the nearest membrane. Touching a membrane, it fuses.
  // Every vesicle is the base glassy cyan. Variety comes from shape and size only, scaled by the Vesicle variety setting:
  // at 0 all are round clear bubbles of similar size; at 0.5 about 40% are soft cells and sizes spread; at 1 about 73%
  // are soft cells, sizes range from tiny to about twice the old largest, and their lobes are more pronounced.
  const TINTS = [{ tint: [1, 1, 1], puff: [.07, .19, .21] }];
  function newVesicle(x, y, o) {
    const pv = C.P.variety, plumpy = pv < 0.5 ? 0.8 * pv : 0.4 + 0.66 * (pv - 0.5);
    const lumpy = R() < plumpy, spread = 0.1 + 0.78 * pv;
    const r = clamp(6.8 * Math.exp((R() * 2 - 1) * spread), 3, 18);
    const irr = (0.6 + 1.3 * pv) * (0.8 + 0.4 * R());
    return Object.assign({ x, y, vx: 0, vy: 0, r, irr, a: 0, grow: 1, ph: R() * 100, seek: false, fuse: -1, dis: -1, A: 0, side: 1, life: 0, form: 0,
      tint: 0, lumpy, core: false, lv: (R() * 2) | 0, rim: 0.88 + R() * 0.22, rot: R() * TAU, spin: (R() < 0.5 ? -1 : 1) * (0.04 + R() * 0.06), w: 0, dh: R() * TAU, sq: 0, sqv: 0, sqA: 0 }, o);
  }
  function nearestOther(v, x, y) { let nd = 1e9; for (const o of ves) if (o !== v && o.fuse < 0) nd = Math.min(nd, Math.hypot(o.x - x, o.y - y)); return nd; }
  function spawnAmbient(ctx, v, inView) {
    const nv = newVesicle(0, 0);
    let best = null, bd = -1;
    for (let k = 0; k < 24; k++) {
      let x, y, ang;
      if (inView) { x = R() * ctx.W; y = R() * ctx.H; ang = R() * TAU; if (!(ctx.blobAt(x, y) > 60 && ctx.distAt(x, y) > 120)) continue; }
      else {
        // just outside a random edge (1.5 to 2 radii beyond the border), heading inward toward a random point
        const m = nv.r * (1.5 + 0.5 * R()) + 2, side = (R() * 4) | 0;
        x = side === 0 ? -m : side === 1 ? ctx.W + m : R() * ctx.W;
        y = side === 2 ? -m : side === 3 ? ctx.H + m : R() * ctx.H;
        if (ctx.blobAt(clamp(x, 0, ctx.W), clamp(y, 0, ctx.H)) < 30) continue;   // not straight into a cell at the edge
        ang = Math.atan2(ctx.H * (0.2 + 0.6 * R()) - y, ctx.W * (0.2 + 0.6 * R()) - x);
      }
      const nd = nearestOther(v, x, y);
      if (nd > bd) { bd = nd; best = [x, y, ang]; }
      if (nd > 260) break;
    }
    if (!best) { const a = R() * TAU; best = [ctx.W / 2 - Math.cos(a) * (ctx.W / 2 + 30), ctx.H / 2 - Math.sin(a) * (ctx.H / 2 + 30), a]; }
    nv.x = best[0]; nv.y = best[1]; nv.dh = best[2]; nv.a = 1;
    if (!inView) { nv.vx = Math.cos(best[2]) * 10; nv.vy = Math.sin(best[2]) * 10; }
    Object.assign(v, nv);
  }
  const fr = x => x - Math.floor(x);
  function hash22(x, y) {
    let a = fr(x * .1031), b = fr(y * .1030), c = fr(x * .0973);
    const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33); a += d; b += d; c += d;
    return [fr((a + b) * c), fr((a + c) * b)];
  }
  function gnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const g = (i, j, dx, dy) => { const h = hash22(ix + i, iy + j); return (h[0] * 2 - 1) * dx + (h[1] * 2 - 1) * dy; };
    const va = g(0, 0, fx, fy), vb = g(1, 0, fx - 1, fy), vc = g(0, 1, fx, fy - 1), vd = g(1, 1, fx - 1, fy - 1);
    return va + ux * (vb - va) + uy * (vc - va) + ux * uy * (va - vb - vc + vd);
  }
  // signed distance to the membrane as the main shader draws it (warp, undulation, breathing; ripples left out)
  function membraneAt(ctx, x, y) {
    const t = ctx.flow;
    const b = ctx.blobAt(x + gnoise(x * .006 + 3.1, y * .006 + 3.1) * 14, y + gnoise(x * .006 + 8.7, y * .006 + 8.7) * 14);
    return b + gnoise(x * .011 + t * .05, y * .011 - t * .04) * 4.5 + gnoise(x * .028 - t * .12, y * .028 - t * .09) * 1.6
      + Math.sin(t * .45 + gnoise(x * .004, y * .004) * 3) * 1.8;
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
    const b = membraneAt(ctx, v.x, v.y);
    // Contact: the vesicle's edge reaches the drawn membrane (the approach bulge reaches out to meet it), from either side
    const CONTACT = v.r + 1.5;
    // A vesicle the field moved deep inside a cell (an icon move grew a cell over it) fades out instead of living there
    if (!v.seek && b < -(CONTACT + 6) && v.form <= 0) { v.dis = 0; return true; }
    // approach: within a few radii the membrane starts to bulge toward it (A: 0 far .. 1 at contact)
    const near = Math.abs(b) - CONTACT;
    v.A = v.form > 0 ? 0 : clamp(1 - near / (v.r * 2.4 + 10), 0, 1);
    const side0 = v.pb === undefined ? (b > 0 ? 1 : -1) : (v.pb > 0 ? 1 : -1);   // the side it came from
    v.side = b > 0 ? 1 : -1;
    v.rot += (v.spin + v.w) * dt; v.w *= Math.exp(-dt * 0.7);   // spin from bumps decays in the viscous fluid
    // soft body: squash springs back with a little jiggle
    v.sqv += (-v.sq * 38 - v.sqv * 5) * dt; v.sq = clamp(v.sq + v.sqv * dt, -0.22, 0.3);
    v.dh += Math.sin(v.ph * 0.05) * 0.04 * dt;
    const out = v.x < 0 || v.y < 0 || v.x > ctx.W || v.y > ctx.H, ds = out ? 9 : 4;   // outside the screen it keeps heading in
    let tx = Math.sin(v.ph * 0.13) * 6 + Math.cos(v.dh) * ds, ty = Math.cos(v.ph * 0.11 + 1.3) * 6 + Math.sin(v.dh) * ds;
    if (v.seek && b < 600) {
      const g = ctx.gradAt(v.x, v.y, ctx.blobAt), n = Math.hypot(g[0], g[1]) || 1, dir = b > 0 ? -1 : 1, sp = 38 * clamp(Math.abs(b) / 40, 0.45, 1);
      tx = g[0] / n * sp * dir; ty = g[1] / n * sp * dir;
    } else if (b < 50 + CONTACT && b > 0) {   // (b is the drawn-membrane distance) // drifting ones that wander close are drawn in, more firmly the closer they get,
      const g = ctx.gradAt(v.x, v.y, ctx.blobAt), n = Math.hypot(g[0], g[1]) || 1;   // so random drift cannot hold them off
      const k = 6 + 10 * sst(50 + CONTACT, CONTACT, b);
      tx = tx * (1 - 0.7 * sst(50 + CONTACT, CONTACT, b)) - g[0] / n * k; ty = ty * (1 - 0.7 * sst(50 + CONTACT, CONTACT, b)) - g[1] / n * k;
    }
    v.vx = ease(v.vx, tx, 1.5, dt); v.vy = ease(v.vy, ty, 1.5, dt);
    v.x += v.vx * dt; v.y += v.vy * dt;
    v.a = Math.min(1, v.a + dt * 0.8);
    // join on any contact, whatever the speed: overlapping the boundary now, or crossed it since the last frame
    // (by its own drift, a collision push, or the field moving under it)
    const b1 = membraneAt(ctx, v.x, v.y), crossed = (b1 > 0) !== (side0 > 0);
    v.pb = b1;
    if ((Math.abs(b1) <= CONTACT || crossed) && v.form <= 0 && b1 < 600) {   // join: from here the shader owns the shape; ripple and flash start now
      v.side = side0;
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
      if (d >= rr || d < 1e-3) {
        // light anti-clustering: neighbours within a short range drift gently apart
        const R0 = 90;
        if (d < R0 && d > 1e-3) { const f = (1 - d / R0) * 4 * dt, ux = dx / d, uy = dy / d; a.vx -= ux * f; a.vy -= uy * f; b.vx += ux * f; b.vy += uy * f; }
        continue;
      }
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
  let tTimers = [];
  function setTimeout0(t, fn) { tTimers.push({ t, fn }); }
  // test report: for the slow-approach vesicles, time near the membrane before fusing; and any vesicle left inside a cell
  function testReport(ctx) {
    for (const v of ves) {
      if (v.tid === undefined || v.rep) continue;
      const b = membraneAt(ctx, v.x, v.y);
      if (v.fuse < 0 && v.dis < 0 && Math.abs(b) < v.r + 3.5) v.dwell = (v.dwell || 0) + ctx.dt;
      if (v.fuse >= 0 || v.dis >= 0) { v.rep = true; console.warn('[galaxy] test v' + v.tid + (v.dis >= 0 ? ' faded' : ' fused') + ' at t=' + ctx.t.toFixed(2) + ' near-membrane dwell=' + (v.dwell || 0).toFixed(2) + 's at ' + Math.round(v.x) + ',' + Math.round(v.y)); }
    }
  }
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
      ves = []; specks = []; ripples = []; flashes = []; seeded = false;
      nextSeek = ctx.mix(60, 10, ctx.P.skirmish) * (0.6 + 0.8 * R());
    },
    resize(ctx) { for (const s of specks) { s.x = ((s.x % ctx.W) + ctx.W) % ctx.W; s.y = ((s.y % ctx.H) + ctx.H) % ctx.H; } },
    layout(ctx) { },

    // Double-click: a vesicle forms at that spot, drifts to the nearest membrane and fuses with a ripple
    fire(ctx, x, y) {
      const v = newVesicle(x, y, { r: 12, seek: true, form: 0.7, grow: 0, a: 1, big: true, lumpy: false, rim: 1 });
      ves.push(v);
      flashes.push({ x, y, t: 0, life: 0.7, r: 34 });
    },

    update(ctx) {
      if (VHOLD && ctx.t >= VHOLD) return;
      const dt = ctx.dt, P = ctx.P, area = ctx.W * ctx.H / (1920 * 1080);
      // ambient vesicles, honouring the activity setting
      const want = Math.round(P.traffic * 9 * area);
      let ambient = ves.filter(v => !v.seek && !v.keep).length;
      while (ambient < want) { const v = {}; spawnAmbient(ctx, v, !seeded); ves.push(v); ambient++; }
      seeded = true;
      ves = ves.filter(v => {
        const alive = stepVesicle(ctx, v, dt);
        if (!alive && !v.seek && !v.keep && ves.filter(o => !o.seek && !o.keep).length <= want) { spawnAmbient(ctx, v); return true; }
        const M = 50 + v.r * 2;
        return alive && v.x > -M && v.y > -M && v.x < ctx.W + M && v.y < ctx.H + M;
      });
      if (ambient > want) { let extra = ambient - want; ves = ves.filter(v => v.seek || v.keep || extra-- <= 0); }
      if (QSV && !testDone && ctx.t > 5) {
        testDone = true;
        if (QSV === 'sample') for (let i = 0; i < 14; i++) ves.push(newVesicle(560 + i * 62, 900, { keep: true, a: 1 }));   // a row drawn from the current variety setting
        if (QSV === 'edge') { const v = {}; for (let t = 0; t < 40; t++) { spawnAmbient(ctx, v, false); if (v.x < 0) break; } v.keep = true; ves.push(v); console.warn('[galaxy] edge spawn ' + Math.round(v.x) + ',' + Math.round(v.y) + ' r=' + v.r.toFixed(1) + ' W=' + ctx.W + ' H=' + ctx.H + ' cv=' + ctx.pxW + ' inner=' + innerWidth); }   // one vesicle entering from an edge
        if (QSV === 'slow' || QSV === 'move') {
          // vesicles released slowly toward the single-icon cell from several angles; each records how long it lingered
          const ic = ctx.icons[ctx.icons.length - 1], cx = ic.x + ic.w / 2, cy = ic.y + ic.h / 2;
          for (let i = 0; i < 6; i++) {
            const a = i / 6 * TAU + 0.3, d = 175 + i * 6, sp = 2 + i * 1.2;
            ves.push(newVesicle(cx + Math.cos(a) * d, cy + Math.sin(a) * d, { keep: true, a: 1, tid: i, vx: -Math.cos(a) * sp, vy: -Math.sin(a) * sp, dh: a + Math.PI, lumpy: i % 2 === 1 }));
          }
          if (QSV === 'move') setTimeout0(1.5, () => { const k = ctx.icons.length - 1; icons[k].x += CELL_W * 2; icons[k].y -= CELL_H; drawGhosts(); commit(); });
        }
        if (QSV === 'slowL') ves.push(newVesicle(400, 420, { keep: true, a: 1, tid: 9, vx: -3, vy: 0, dh: Math.PI, lumpy: false, r: 8 }));   // one slow vesicle toward the left icon column
        if (QSV === 'merge') ves.push(newVesicle(1150, 620, { seek: true, keep: true, lumpy: true, r: 9, a: 1 }));
        if (QSV === 'bump') { ves.push(newVesicle(880, 880, { keep: true, lumpy: true, r: 9, a: 1, vx: 30, vy: 2 })); ves.push(newVesicle(915, 884, { keep: true, r: 7, a: 1, vx: -30, vy: 0, lumpy: false })); }
      }
      collide(ctx, dt);
      if (QSV) {
        for (const tm of tTimers) { tm.t -= dt; if (tm.t <= 0 && !tm.done) { tm.done = true; tm.fn(); } }
        testReport(ctx);
        if (QSV === 'move' && ctx.t > 12 && !window._mv) { window._mv = 1; const inside = ves.filter(v => v.fuse < 0 && v.dis < 0 && ctx.blobAt(v.x, v.y) < 0 && !v.seek); console.warn('[galaxy] after icon move: ' + ves.length + ' vesicles, ' + inside.length + ' inside a cell'); }
      }
      // occasional purposeful vesicle (rate follows the Infections/events setting)
      if (P.skirmish > 0) {
        nextSeek -= dt;
        if (nextSeek <= 0) {
          nextSeek = ctx.mix(60, 10, P.skirmish) * (0.6 + 0.8 * R());
          const v = {}; spawnAmbient(ctx, v); v.seek = true; v.r = 6 + R() * 3; ves.push(v);
        }
      }
      // tiny specks
      // the Background particles setting: none at 0, about 85 at 1080p at the default, about 200 at 1. Three depth layers:
      // deep (half of them: small, soft, dim, slow), middle, and near (larger, crisper). The layer follows the index so
      // the mix stays the same when the count changes. Specks never collide.
      const pp = P.particles, ws = Math.round((140 * pp + 60 * pp * pp) * area);
      while (specks.length < ws) {
        const i = specks.length % 10, L = i < 5 ? 0 : i < 8 ? 1 : 2;
        specks.push({ L, x: R() * ctx.W, y: R() * ctx.H, s: [1.0, 1.6, 2.4][L] + R() * [0.8, 1.2, 1.8][L], a: [0.07, 0.13, 0.2][L] + R() * [0.07, 0.12, 0.2][L],
          bias: [1.8, 0.9, 0][L], sp: [0.35, 0.65, 1][L], ph: R() * 100 });
      }
      if (specks.length > ws) specks.length = ws;
      for (const s of specks) {
        const k = s.sp;
        s.ph += dt; s.x += (Math.sin(s.ph * 0.07) * 4 + 2) * k * dt; s.y += Math.cos(s.ph * 0.05 + 2) * 3 * k * dt;
        if (s.x > ctx.W + 10) s.x = -10; if (s.y < -10) s.y = ctx.H + 10; if (s.y > ctx.H + 10) s.y = -10;
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
      for (const v of ves) v.inShader = false;
      fz.forEach((v, k) => {
        v.inShader = true;
        const ph = v.fuse >= 0 ? 1 + Math.min(1, v.fuse / v.T) : Math.max(1e-4, Math.min(v.A, 0.999));
        fusData[k * 4] = v.x; fusData[k * 4 + 1] = v.y; fusData[k * 4 + 2] = v.r * v.grow; fusData[k * 4 + 3] = v.side * ph;
        const pc = TINTS[v.tint || 0].puff; fusCol[k * 3] = pc[0]; fusCol[k * 3 + 1] = pc[1]; fusCol[k * 3 + 2] = pc[2];
        if (v.lumpy) {
          const tc = TINTS[v.tint || 0].tint;
          fusT[k * 4] = v.rot; fusT[k * 4 + 1] = 0.4 + v.lv * 1.9; fusT[k * 4 + 2] = 1; fusT[k * 4 + 3] = v.sqA;
          fusS[k * 4] = Math.min(0.14, (0.07 + 0.02 * Math.sin(v.ph * 0.5)) * v.irr); fusS[k * 4 + 1] = Math.min(0.06, (0.03 + 0.012 * Math.sin(v.ph * 0.37 + 1)) * v.irr); fusS[k * 4 + 2] = v.sq; fusS[k * 4 + 3] = 0.02 * Math.sin(v.ph * 0.6) * v.a;
          fusM[k * 3] = tc[0] * tc[0]; fusM[k * 3 + 1] = tc[1] * tc[1]; fusM[k * 3 + 2] = tc[2] * tc[2];
        }
      });
      ctx.fullscreen(prog, { uRip: ripData, uFus: fusData, uFusC: fusCol, uFusT: fusT, uFusS: fusS, uFusM: fusM }, {}, null);
      const I = ctx.intro;
      for (const s of specks) {
        const b = ctx.blobAt(s.x, s.y), k = sst(0, 30, b);
        // analytic glow dots stay visible at 1-3 px (a tiny sprite samples a blurred mip and vanishes); deep ones are soft and dim, near ones crisp
        if (k > 0.01) ctx.glowDot(s.x, s.y, s.s * 0.85, s.L ? [0.6, 0.9, 1] : [0.5, 0.78, 0.9], s.a * 3.4 * k * I, { core: s.L === 2 ? 0.7 : s.L ? 0.35 : 0, falloff: s.L ? 2 : 1.6 });
      }
      for (const v of ves) {
        // the sprite hands over to the shader's merged shape: gone once the outlines have joined
        const hand = v.fuse >= 0 ? 1 - Math.min(1, v.fuse / (0.12 * v.T)) : 1;
        if (v.a * hand <= 0.01) continue;
        const w = v.r * 2 / 0.72 * v.grow;
        if (w < 0.5) continue;
        const tc = TINTS[v.tint].tint, al = v.a * hand * I, tn = [tc[0] * v.rim, tc[1] * v.rim, tc[2] * v.rim];
        if (!v.lumpy || !v.inShader) ctx.sprite(v.big ? 'vesB' : 'ves', v.x, v.y, { w, alpha: al, tint: tn });   // a soft cell with no shader slot falls back to a bubble
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
