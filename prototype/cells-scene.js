// Deskland · Cells: one calm surface in the style of the original themes (Beach, Salt flats).
// Two materials and the boundary between them:
//   - fluid (most of the screen): a deep blue-teal gradient with fine grain, faint soft light dapples
//   - cell (where the icons are): each icon area, merged through the blob field, is one living cell of glassy cytoplasm
//   - membrane (the boundary, the star): a thin bright double line with a soft glow that breathes and undulates;
//     ripples travel along it when a vesicle fuses, the way waves wash a shore
// Very few movers: a handful of vesicles drift in the fluid and sometimes fuse with a membrane; rarely a mitochondrion
// or a small nucleus fragment floats past. Double-click forms a vesicle that drifts to the nearest membrane and fuses.
// Everything is one full-screen pass plus a few sprites.
(function () {
  'use strict';
  const ID = 'cells';
  const TAU = Math.PI * 2;
  const NRIP = 8;                       // ripples the shader can show at once
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const sst = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const ease = (c, t, rate, dt) => c + (t - c) * (1 - Math.exp(-rate * dt));

  /* ---------------- the surface ---------------- */
  const MAIN_FS = `
uniform vec4 uRip[${NRIP}];   // fusion ripples: x, y, age (s), strength (px)
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
  float s = membraneS(p, t, rip);
  vec2 uv = p / uRes;
  float px = 1. / uScale;
  float grain = hash12(floor(gl_FragCoord.xy)) - .5;
  float dI = iconDist(p);

  // fluid: deep blue-teal, a little lighter in the upper middle; lighter teal "shallows" near a membrane
  float gr = length((uv - vec2(.45, .35)) * vec2(uRes.x / uRes.y, 1.));
  vec3 fluid = mix(vec3(.020, .070, .095), vec3(.006, .026, .046), smoothstep(.0, 1.15, gr));
  fluid = mix(fluid, vec3(.030, .105, .125), exp(-max(s, 0.) / 70.) * .7);
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
  cyto += vec3(.09, .24, .27) * exp(-si / 10.) * .6 + vec3(.03, .08, .09) * exp(-si / 35.);
  // a faint echo contour inside, like a wet-sand band, breathing with the membrane
  float echo = -26. - 5. * sin(t * .3 + gnoise(p * .005) * 2.);
  cyto += vec3(.05, .13, .14) * exp(-pow((s - echo) / 3.5, 2.)) * .45;
  cyto *= 1. + grain * .05;
  // keep it calm and a touch darker right behind the icons so the labels stay readable
  cyto *= mix(.82, 1., smoothstep(0., 30., dI));

  float inside = smoothstep(px, -px, s);
  vec3 col = mix(fluid, cyto, inside);
  // the membrane: a thin bright double line (the bilayer) with a soft glow, brightest where a ripple passes
  float w = .55 + px * .5;
  float l1 = exp(-pow(s / w, 2.)), l2 = exp(-pow((s + 3.6) / w, 2.));
  float lift = 1. + clamp(abs(rip) * .22, 0., 1.6);
  vec3 memC = vec3(.62, .92, 1.);
  col += memC * (l1 * .95 + l2 * .55) * lift;
  col += vec3(.10, .34, .40) * exp(-abs(s + 1.8) / 7.) * .5 * lift;     // soft glow both sides
  col += vec3(.04, .14, .17) * exp(-max(s, 0.) / 22.) * .35;            // faint halo out into the fluid
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
    A.define('speck', 24, 24, (g, S) => { const c = S / 2, gr = g.createRadialGradient(c, c, 0, c, c, c); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); });
    A.define('ring', 128, 128, (g, S) => { const c = S / 2; for (let k = 0; k < 5; k++) { g.strokeStyle = `rgba(255,255,255,${0.1 + k * 0.12})`; g.lineWidth = 10 - k * 2; circle(g, c, c, c - 8); g.stroke(); } });
    // mitochondrion: muted amber capsule with fine folds
    A.define('mito', 150, 54, (g, W, H) => {
      const r = rnd(331), pad = 5, hh = H / 2 - pad;
      const path = (pd) => { const h2 = H / 2 - pd; g.beginPath(); g.moveTo(pd + h2, H / 2 - h2); g.lineTo(W - pd - h2, H / 2 - h2); g.arc(W - pd - h2, H / 2, h2, -Math.PI / 2, Math.PI / 2); g.lineTo(pd + h2, H / 2 + h2); g.arc(pd + h2, H / 2, h2, Math.PI / 2, Math.PI * 1.5); g.closePath(); };
      path(pad);
      const gr = g.createLinearGradient(0, pad, 0, H - pad);
      gr.addColorStop(0, 'rgba(236,182,112,.9)'); gr.addColorStop(0.5, 'rgba(205,124,62,.88)'); gr.addColorStop(1, 'rgba(150,84,40,.9)');
      g.fillStyle = gr; g.fill();
      g.save(); path(pad + 3); g.clip();
      g.lineCap = 'round';
      for (let k = 0; k < 14; k++) {
        const x = pad + hh * 0.7 + (W - 2 * pad - hh * 1.4) * (k + 0.5) / 14, top = k % 2 === 0, y0 = top ? pad : H - pad, y1 = top ? H / 2 + hh * (0.1 + r() * 0.4) : H / 2 - hh * (0.1 + r() * 0.4);
        g.strokeStyle = 'rgba(250,216,160,.7)'; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(x, y0); g.quadraticCurveTo(x + (r() - 0.5) * 6, (y0 + y1) / 2, x, y1); g.stroke();
      }
      g.restore();
      path(pad); g.strokeStyle = 'rgba(250,212,160,.65)'; g.lineWidth = 1.6; g.stroke();
    });
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
  let ves = [], specks = [], ripples = [], flashes = [], passer = null, nextPasser = 30, nextSeek = 20;
  const ripData = new Float32Array(NRIP * 4);

  function addRipple(x, y, amp) {
    if (ripples.length >= NRIP) ripples.shift();
    ripples.push({ x, y, age: 0, amp });
  }
  // A vesicle: drifts calmly; a seeking one heads for the nearest membrane. Touching a membrane, it fuses.
  function newVesicle(x, y, o) {
    return Object.assign({ x, y, vx: 0, vy: 0, r: 5 + R() * 4, a: 0, grow: 1, ph: R() * 100, seek: false, fuse: -1, life: 0, form: 0 }, o);
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
    if (v.fuse >= 0) {                      // merging into the membrane: shrink and fade
      v.fuse += dt; v.a = Math.max(0, 1 - v.fuse / 0.45);
      return v.fuse < 0.45;
    }
    const b = ctx.blobAt(v.x, v.y);
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
    if (Math.abs(b) < v.r * 0.5 + 2 && v.form <= 0) { v.fuse = 0; addRipple(v.x, v.y, v.big ? 11 : 3 + v.r * 0.55); flashes.push({ x: v.x, y: v.y, t: 0, life: v.big ? 1.2 : 0.8, r: v.r * (v.big ? 6 : 4) }); }
    if (v.seek && !(b < 600) && v.life > 8) { v.fuse = 0; }      // no cell anywhere: it simply dissolves
    return true;
  }

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
      const v = newVesicle(x, y, { r: 12, seek: true, form: 0.7, grow: 0, a: 1, big: true });
      ves.push(v);
      flashes.push({ x, y, t: 0, life: 0.7, r: 34 });
    },

    update(ctx) {
      const dt = ctx.dt, P = ctx.P, area = ctx.W * ctx.H / (1920 * 1080);
      // ambient vesicles, honouring the activity setting
      const want = Math.round(P.traffic * 9 * area);
      let ambient = ves.filter(v => !v.seek).length;
      while (ambient < want) { const v = {}; spawnAmbient(ctx, v); ves.push(v); ambient++; }
      ves = ves.filter(v => {
        const alive = stepVesicle(ctx, v, dt);
        if (!alive && !v.seek && ves.filter(o => !o.seek).length <= want) { spawnAmbient(ctx, v); v.a = 0; return true; }
        return alive && v.x > -60 && v.y > -60 && v.x < ctx.W + 60 && v.y < ctx.H + 60;
      });
      if (ambient > want) { let extra = ambient - want; ves = ves.filter(v => v.seek || extra-- <= 0); }
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
      // a rare passer: a mitochondrion or a small nucleus fragment floating slowly across
      if (P.traffic > 0) {
        if (!passer) {
          nextPasser -= dt * (0.4 + P.traffic);
          if (nextPasser <= 0) {
            nextPasser = 50 + R() * 70;
            const left = R() < 0.5, y = ctx.H * (0.15 + R() * 0.7);
            passer = { kind: R() < 0.6 ? 'mito' : 'frag', x: left ? -80 : ctx.W + 80, y, vx: (left ? 1 : -1) * (12 + R() * 6), rot: R() * TAU, spin: (R() - 0.5) * 0.1, ph: R() * 100 };
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
      ctx.fullscreen(prog, { uRip: ripData }, {}, null);
      const I = ctx.intro;
      for (const s of specks) {
        const b = ctx.blobAt(s.x, s.y), k = sst(0, 30, b);
        if (k > 0.01) ctx.sprite('speck', s.x, s.y, { w: s.s * 2, alpha: s.a * k * I, tint: [0.6, 0.9, 1], add: true });
      }
      if (passer) {
        const b = ctx.blobAt(passer.x, passer.y), k = sst(10, 60, b) * I;
        if (passer.kind === 'mito') ctx.sprite('mito', passer.x, passer.y, { w: 34, rot: passer.rot + Math.sin(passer.ph * 0.9) * 0.12, alpha: 0.8 * k });
        else ctx.sprite('frag', passer.x, passer.y, { w: 26, rot: passer.rot, alpha: 0.75 * k });
      }
      for (const v of ves) {
        if (v.a <= 0.01) continue;
        const w = v.r * 2 / 0.72 * (v.fuse >= 0 ? 1 - 0.5 * v.fuse / 0.45 : v.grow);
        if (w < 0.5) continue;
        ctx.sprite('ves', v.x, v.y, { w, alpha: v.a * I });
        if (v.seek) ctx.glowDot(v.x, v.y, v.r * 1.6, [0.5, 0.9, 1], 0.25 * v.a, { core: 0 });
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
