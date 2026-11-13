// Deskland · Neurons: one calm surface in the style of Beach, Salt flats and Cells.
// Two materials and the boundary between them:
//   - neural fluid (most of the screen): deep indigo to violet-black with fine grain and the faintest drifting haze
//   - soma (where the icons are): each icon group, merged through the blob field, is one softly glowing cell body
//   - the membrane (the boundary, the star): a soft magenta line from which dendrites branch out into the dark.
//     Dendrites of neighbouring somas reach toward each other and meet at synapses (a bulb, a gap, a small head).
// Dendrite trees are grown on the CPU from the membrane and drawn once into a cached glow target. They are redrawn
// only while growing or retracting (after an icon move); the main pass sways them with a gentle warp.
// Very few movers: now and then an action potential travels out along a dendrite, releases a burst of specks across a
// synapse, and the receiving soma's membrane brightens. Double-click fires the nearest neuron (a short chain reaction).
(function () {
  'use strict';
  const ID = 'neurons';
  const TAU = Math.PI * 2;
  const NFL = 8;                        // soma flashes the shader can show at once
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const sst = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const ease = (c, t, rate, dt) => c + (t - c) * (1 - Math.exp(-rate * dt));
  const DEND = [0.78, 0.36, 0.95];      // dendrite colour (warm violet)
  const PULSE = [0.55, 0.95, 1.0];      // action potential colour (cyan-white)
  const GOLD = [1.0, 0.85, 0.5];        // neurotransmitter specks

  // Gentle sway shared by the shader and the CPU (pulses must ride the swaying dendrites). amp grows away from the soma.
  const SWAY_GLSL = `
vec2 sway(vec2 p, float t) {
  return vec2(sin(p.y * .013 + t * .4) + .6 * sin(p.x * .009 + p.y * .004 - t * .31),
              cos(p.x * .012 - t * .37) + .6 * sin(p.y * .008 - p.x * .005 + t * .29)) * 2.6;
}`;
  function sway(x, y, t) {
    return [(Math.sin(y * .013 + t * .4) + .6 * Math.sin(x * .009 + y * .004 - t * .31)) * 2.6,
            (Math.cos(x * .012 - t * .37) + .6 * Math.sin(y * .008 - x * .005 + t * .29)) * 2.6];
  }
  const swayAmp = b => sst(0, 140, b);

  const MAIN_FS = `
uniform sampler2D uDend;
uniform vec4 uFl[${NFL}];   // soma flashes: x, y, radius, strength
${SWAY_GLSL}
void main() {
  vec2 p = cssPos();
  float t = uFlow;
  vec2 uv = p / uRes;
  float px = 1. / uScale;
  float grain = hash12(floor(gl_FragCoord.xy)) - .5;
  float dI = iconDist(p);
  // membrane distance: breathing, slowly undulating
  float b0 = iconBlob(p + vec2(gnoise(p * .006 + 3.1), gnoise(p * .006 + 8.7)) * 12.);
  float s = b0 + gnoise(p * .012 + vec2(t * .04, -t * .035)) * 3.5 + sin(t * .4 + gnoise(p * .004) * 3.) * 1.5;
  // flashes from arriving signals or a fired neuron
  float fl = 0.;
  for (int k = 0; k < ${NFL}; k++) { vec4 f = uFl[k]; if (f.w <= 0.) continue; fl += f.w * smoothstep(f.z + 120., f.z * .3, length(p - f.xy)); }
  fl = min(fl, 2.);

  // neural fluid: deep indigo to violet-black, the faintest drifting haze, fine grain
  float gr = length((uv - vec2(.5, .38)) * vec2(uRes.x / uRes.y, 1.));
  vec3 fluid = mix(vec3(.014, .009, .040), vec3(.004, .003, .015), smoothstep(0., 1.15, gr));
  float haze = vnoise(p * .0022 + vec2(t * .006, -t * .004)) * .6 + vnoise(p * .006 - t * .008) * .4;
  fluid += vec3(.010, .006, .022) * smoothstep(.45, .9, haze);
  fluid += vec3(.03, .012, .05) * exp(-max(s, 0.) / 60.) * .5;          // a little glow around each soma
  fluid *= 1. + grain * .07;

  // soma: a softly glowing body, calm and darker right behind the icons so labels stay readable
  float si = max(-s, 0.);
  vec3 soma = vec3(.055, .02, .075) + vec3(.025, .01, .035) * (1. - exp(-si / 80.));
  soma *= .95 + .08 * vnoise(p * .05 + t * .02);
  soma += vec3(.30, .09, .36) * exp(-si / 10.) * .45 + vec3(.05, .018, .065) * exp(-si / 40.);
  soma += vec3(.06, .02, .08) * exp(-pow((s + 24. + 4. * sin(t * .3)) / 4., 2.)) * .5;   // faint inner echo
  soma *= mix(.7, 1., smoothstep(0., 30., dI));
  soma *= 1. + grain * .05;

  float inside = smoothstep(px, -px, s);
  vec3 col = mix(fluid, soma, inside);
  // the membrane: a soft magenta line with a glow, brightening when a signal arrives
  float w = .7 + px * .5;
  col += vec3(.95, .45, 1.0) * exp(-pow(s / w, 2.)) * (.75 + .9 * fl);
  col += vec3(.30, .10, .38) * exp(-abs(s) / 8.) * (.45 + .8 * fl);
  col += vec3(.20, .45, .55) * exp(-abs(s) / 14.) * .45 * fl;
  col += vec3(.06, .10, .16) * inside * fl * .5;            // a cool tint during a flash

  // dendrites from the cached target, swaying gently away from the soma
  vec2 sw = sway(p, t) * smoothstep(0., 140., b0);
  vec2 du = vec2((p.x - sw.x) / uRes.x, 1. - (p.y - sw.y) / uRes.y);
  col += texture(uDend, du).rgb * (1. - inside * .7);
  col = mix(fluid, col, uIntro);
  outColor = vec4(col, 1.);
}`;

  /* ---------------- dendrite trees ---------------- */
  // A tree: nodes {x, y, p (parent index), d (arc length from the root), w (width)}, leaves, synapse ends.
  let C = null, R = Math.random, prog = null, dend = null;
  let somas = [], trees = [], synapses = [], pulses = [], specks = [], flashes = [], sparks = [], sprouts = [];
  let dendDirty = true, pendingBuild = true, nextFire = 10;
  const flData = new Float32Array(NFL * 4);

  // Group icons into somas: two icons share a soma when the blob field stays inside between them
  function findSomas(ctx) {
    const ic = ctx.icons.map(i => ({ x: i.x + i.w / 2, y: i.y + i.h / 2 - 4 }));
    const par = ic.map((_, i) => i), f = i => par[i] === i ? i : (par[i] = f(par[i]));
    for (let i = 0; i < ic.length; i++) for (let j = i + 1; j < ic.length; j++) {
      const a = ic[i], b = ic[j], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 420) continue;
      let ok = true;
      for (let k = 1; k < 8 && ok; k++) { const u = k / 8; if (ctx.blobAt(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u) > -2) ok = false; }
      if (ok) par[f(i)] = f(j);
    }
    const groups = {};
    ic.forEach((p, i) => { const r = f(i); (groups[r] = groups[r] || []).push(p); });
    return Object.values(groups).map((g, id) => {
      const cx = g.reduce((s, p) => s + p.x, 0) / g.length, cy = g.reduce((s, p) => s + p.y, 0) / g.length;
      return { id, cx, cy, pts: g, rad: Math.sqrt(g.length) * 60 + 50, flash: 0 };
    });
  }
  // From a point inside a soma, march along a direction to the membrane; returns the root point and outward normal
  function membranePoint(ctx, sx, sy, ang) {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let lo = 0, hi = 0;
    for (let d = 8; d < 900; d += 8) { if (ctx.blobAt(sx + dx * d, sy + dy * d) > 0) { hi = d; break; } lo = d; }
    if (!hi) return null;
    for (let it = 0; it < 8; it++) { const m = (lo + hi) / 2; if (ctx.blobAt(sx + dx * m, sy + dy * m) > 0) hi = m; else lo = m; }
    const x = sx + dx * hi, y = sy + dy * hi, g = ctx.gradAt(x, y, ctx.blobAt), n = Math.hypot(g[0], g[1]) || 1;
    return { x, y, nx: g[0] / n, ny: g[1] / n };
  }
  // Grow one branch from (x, y) heading ang. Stops at other somas, icons, or the screen edge. Returns node indices.
  function growBranch(ctx, tree, from, ang, len, w, depth, ownSoma) {
    let x = tree.nodes[from].x, y = tree.nodes[from].y, d = tree.nodes[from].d, prev = from, a = ang;
    const step = 9, n = Math.max(2, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      a += (R() - 0.5) * 0.35;
      const nx = x + Math.cos(a) * step, ny = y + Math.sin(a) * step;
      if (nx < -40 || ny < -40 || nx > ctx.W + 40 || ny > ctx.H + 40) break;
      if (ctx.blobAt(nx, ny) < 14 && i > 2) break;                    // reached a soma (its own or another)
      if (ctx.distAt(nx, ny) < 34) break;                              // never behind an icon
      const ww = w * (1 - i / n * 0.75);
      tree.nodes.push({ x: nx, y: ny, p: prev, d: d + step, w: ww });
      prev = tree.nodes.length - 1; x = nx; y = ny; d += step;
      // spines on finer stretches
      if (ww < 1.4 && R() < 0.35) { const sa = a + (R() < 0.5 ? 1 : -1) * (0.9 + R() * 0.5), sl = 3 + R() * 3; tree.spines.push([x, y, x + Math.cos(sa) * sl, y + Math.sin(sa) * sl, d]); }
      // side branches
      if (depth < 2 && i > 4 && i < n - 3 && R() < 0.07) growBranch(ctx, tree, prev, a + (R() < 0.5 ? 1 : -1) * (0.45 + R() * 0.45), len * (0.35 + R() * 0.3), ww * 0.75, depth + 1, ownSoma);
    }
    if (prev !== from) tree.leaves.push(prev);
    return prev;
  }
  // A connector: from soma A's membrane toward the midpoint with B, ending in a bouton just short of the gap
  function growConnector(ctx, tree, from, tx, ty, w) {
    let x = tree.nodes[from].x, y = tree.nodes[from].y, d = tree.nodes[from].d, prev = from;
    const total = Math.hypot(tx - x, ty - y), n = Math.max(3, Math.round(total / 9)), ph = R() * TAU, amp = 6 + R() * 10;
    const ux = (tx - x) / total, uy = (ty - y) / total, x0 = x, y0 = y;
    for (let i = 1; i <= n; i++) {
      const u = i / n, wob = Math.sin(u * Math.PI * 2 + ph) * amp * Math.sin(u * Math.PI);
      const nx = x0 + (tx - x0) * u - uy * wob, ny = y0 + (ty - y0) * u + ux * wob;
      if (ctx.distAt(nx, ny) < 30) return -1;
      d += Math.hypot(nx - x, ny - y); x = nx; y = ny;
      tree.nodes.push({ x, y, p: prev, d, w: w * (1 - u * 0.5) });
      prev = tree.nodes.length - 1;
      if (R() < 0.2 && i > 2 && i < n - 2) { const sa = Math.atan2(uy, ux) + (R() < 0.5 ? 1 : -1) * 1.2, sl = 3 + R() * 3; tree.spines.push([x, y, x + Math.cos(sa) * sl, y + Math.sin(sa) * sl, d]); }
    }
    return prev;
  }
  function buildTrees(ctx) {
    somas = findSomas(ctx);
    const fresh = [];
    synapses = [];
    for (const s of somas) {
      const tree = { soma: s, nodes: [], leaves: [], spines: [], grow: 0, state: 'grow', max: 1 };
      // primary dendrites around the membrane, more on bigger somas
      const k = clamp(Math.round(3 + s.pts.length * 0.8), 4, 10), a0 = R() * TAU;
      for (let i = 0; i < k; i++) {
        const src = s.pts[(R() * s.pts.length) | 0], mp = membranePoint(ctx, src.x, src.y, a0 + (i + (R() - 0.5) * 0.6) * TAU / k);
        if (!mp) continue;
        tree.nodes.push({ x: mp.x, y: mp.y, p: -1, d: 0, w: 2.4 });
        growBranch(ctx, tree, tree.nodes.length - 1, Math.atan2(mp.ny, mp.nx), 120 + R() * 170, 2.2, 0, s);
      }
      s.tree = tree;
      fresh.push(tree);
    }
    // synapses between neighbouring somas
    for (let i = 0; i < somas.length; i++) for (let j = i + 1; j < somas.length; j++) {
      const A = somas[i], B = somas[j], d = Math.hypot(A.cx - B.cx, A.cy - B.cy);
      if (d > 760) continue;
      const aa = Math.atan2(B.cy - A.cy, B.cx - A.cx), ma = membranePoint(ctx, A.cx, A.cy, aa), mb = membranePoint(ctx, B.cx, B.cy, aa + Math.PI);
      if (!ma || !mb) continue;
      const gap = Math.hypot(mb.x - ma.x, mb.y - ma.y);
      if (gap < 40) continue;
      const mx = (ma.x + mb.x) / 2 + (R() - 0.5) * gap * 0.15, my = (ma.y + mb.y) / 2 + (R() - 0.5) * gap * 0.15;
      const ux = (mb.x - ma.x) / gap, uy = (mb.y - ma.y) / gap, half = 5;
      if (C.distAt(mx, my) < 40) continue;
      const ta = A.tree, tb = B.tree;
      ta.nodes.push({ x: ma.x, y: ma.y, p: -1, d: 0, w: 2.4 });
      const ea = growConnector(ctx, ta, ta.nodes.length - 1, mx - ux * half, my - uy * half, 2.2);
      tb.nodes.push({ x: mb.x, y: mb.y, p: -1, d: 0, w: 2.4 });
      const eb = growConnector(ctx, tb, tb.nodes.length - 1, mx + ux * half, my + uy * half, 1.8);
      if (ea < 0 || eb < 0) continue;
      synapses.push({ a: A, b: B, ta, ea, tb, eb, x: mx, y: my, ux, uy });
    }
    for (const t of fresh) t.max = t.nodes.reduce((m, n) => Math.max(m, n.d), 1) + 20;
    for (const t of trees) t.state = 'retract';
    trees = trees.concat(fresh);
    dendDirty = true;
  }
  function pathTo(tree, node) { const p = []; for (let i = node; i >= 0; i = tree.nodes[i].p) p.push(tree.nodes[i]); return p.reverse(); }

  // Draw every tree into the cached glow target (only while something grows or retracts)
  function drawDend(ctx) {
    const gl = ctx.gl;
    ctx.bindTarget(dend); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    for (const t of trees) {
      const reach = t.grow * t.max;
      for (let i = 0; i < t.nodes.length; i++) {
        const n = t.nodes[i]; if (n.p < 0 || n.d > reach) continue;
        const q = t.nodes[n.p], tip = sst(reach, reach - 40, n.d), far = 1 - 0.55 * sst(80, 300, n.d);
        ctx.glowLine(q.x, q.y, n.x, n.y, Math.max(0.7, n.w), DEND, 0.6 * tip * far, { core: 0.28, coreR: 0.4, falloff: 2 });
      }
      for (const s of t.spines) if (s[4] < reach) { ctx.glowLine(s[0], s[1], s[2], s[3], 0.6, DEND, 0.35, { core: 0.5 }); ctx.glowDot(s[2], s[3], 1.3, DEND, 0.5, { core: 0.6 }); }
    }
    for (const sy of synapses) {
      const ga = sy.ta.grow * sy.ta.max, na = sy.ta.nodes[sy.ea], nb = sy.tb.nodes[sy.eb];
      if (na.d < ga) ctx.glowDot(na.x, na.y, 4.2, DEND, 0.9, { core: 0.7, coreR: 0.5 });       // presynaptic bouton
      if (nb.d < sy.tb.grow * sy.tb.max) ctx.glowDot(nb.x, nb.y, 2.6, DEND, 0.6, { core: 0.6 }); // postsynaptic head
    }
    ctx.flush();
    ctx.bindTarget(null);
  }

  /* ---------------- signals ---------------- */
  function flashSoma(s, k) { s.flash = Math.min(1.6, s.flash + k); }
  // Send a pulse from soma s along path (an array of nodes); onEnd runs on arrival
  function sendPulse(path, onEnd, speed = 230) {
    if (path.length < 2) return;
    const L = path[path.length - 1].d - path[0].d;
    pulses.push({ path, L, pos: 0, speed, onEnd, i: 0 });
  }
  function fireSoma(ctx, s, chain, seen) {
    if (!s || !s.tree) return;
    if (seen) { if (seen.has(s)) return; seen.add(s); }
    flashSoma(s, chain ? 1.2 : 0.8);
    const t = s.tree;
    if (chain) {
      for (const leaf of t.leaves) if (R() < 0.7) sendPulse(pathTo(t, leaf), null, 260);
      for (const sy of synapses) {
        if (sy.a === s) sendPulse(pathTo(sy.ta, sy.ea), () => crossSynapse(ctx, sy, false, chain, seen), 280);
        else if (sy.b === s) sendPulse(pathTo(sy.tb, sy.eb), () => crossSynapse(ctx, sy, true, chain, seen), 280);
      }
    } else {
      const mine = synapses.filter(sy => sy.a === s || sy.b === s);
      if (mine.length && R() < 0.65) {
        const sy = mine[(R() * mine.length) | 0], rev = sy.b === s;
        sendPulse(rev ? pathTo(sy.tb, sy.eb) : pathTo(sy.ta, sy.ea), () => crossSynapse(ctx, sy, rev, 0, null));
      } else if (t.leaves.length) sendPulse(pathTo(t, t.leaves[(R() * t.leaves.length) | 0]), null);
    }
  }
  // A signal reached a synapse: specks cross the gap, the receiving soma's membrane brightens (and fires in a chain)
  function crossSynapse(ctx, sy, reverse, chain, seen) {
    const dir = reverse ? -1 : 1, to = reverse ? sy.a : sy.b;
    for (let k = 0; k < 9; k++) {
      const a = Math.atan2(sy.uy * dir, sy.ux * dir) + (R() - 0.5) * 1.2, sp = 14 + R() * 22;
      specks.push({ x: sy.x - sy.ux * dir * 4, y: sy.y - sy.uy * dir * 4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: 0.9 + R() * 0.6 });
    }
    flashes.push({ x: sy.x, y: sy.y, t: 0, life: 0.6, r: 14, c: GOLD });
    setTimeout0(0.45, () => {
      flashSoma(to, chain ? 1 : 0.6);
      if (chain && chain < 4) fireSoma(ctx, to, chain + 1, seen);
    });
  }
  let timers = [];
  function setTimeout0(t, fn) { timers.push({ t, fn }); }

  Galaxy.register(ID, {
    name: 'Neurons',
    weather: false,
    defaultHour: 14,
    post: { bloom: 0.7, threshold: 0.75, knee: 0.5, exposure: 1.05, vignette: 0.35, grain: 0.018, aberration: 0.0005, saturation: 1.0, bloomRadius: 1.15 },

    init(ctx) {
      C = ctx; R = ctx.rng(9);
      prog = ctx.program(MAIN_FS);
      ctx.atlas.define('speck', 24, 24, (g, S) => { const c = S / 2, gr = g.createRadialGradient(c, c, 0, c, c, c); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); });
      ctx.atlas.define('ring', 128, 128, (g, S) => { const c = S / 2; for (let k = 0; k < 5; k++) { g.strokeStyle = `rgba(255,255,255,${0.1 + k * 0.12})`; g.lineWidth = 10 - k * 2; g.beginPath(); g.arc(c, c, c - 8, 0, TAU); g.stroke(); } });
      somas = []; trees = []; synapses = []; pulses = []; specks = []; flashes = []; sparks = []; sprouts = []; timers = [];
      pendingBuild = true; dendDirty = true;
      nextFire = ctx.mix(25, 4, ctx.P.skirmish) * (0.5 + R());
    },
    resize(ctx) {
      if (!dend || dend.w !== ctx.pxW || dend.h !== ctx.pxH) { if (dend) ctx.freeTarget(dend); dend = ctx.makeTarget(ctx.pxW, ctx.pxH, { float: true }); }
      pendingBuild = true; dendDirty = true;
    },
    layout(ctx) { pendingBuild = true; for (const t of trees) t.state = 'retract'; dendDirty = true; },

    // Double-click: fire the nearest neuron (a short chain reaction), or a spark with a few filaments in open dark
    fire(ctx, x, y) {
      let best = null, bd = 1e9;
      for (const s of somas) { const d = Math.hypot(s.cx - x, s.cy - y) - s.rad; if (d < bd) { bd = d; best = s; } }
      if (best && (bd < 260 || ctx.blobAt(x, y) < 40)) { fireSoma(ctx, best, 1, new Set()); return; }
      flashes.push({ x, y, t: 0, life: 0.9, r: 30, c: PULSE });
      for (let k = 0; k < 6; k++) {
        const pts = [[x, y]]; let a = k / 6 * TAU + R() * 0.5, px = x, py = y;
        for (let i = 0; i < 9; i++) { a += (R() - 0.5) * 0.5; px += Math.cos(a) * 8; py += Math.sin(a) * 8; pts.push([px, py]); }
        sprouts.push({ pts, t: 0, life: 2.6 });
      }
    },

    update(ctx) {
      const dt = ctx.dt, rdt = ctx.rawDt, P = ctx.P;
      if (pendingBuild && ctx.fieldStable && C.icons) { pendingBuild = false; buildTrees(ctx); }
      // growth and retraction (the cached target is redrawn only while this changes)
      for (const t of trees) {
        const g0 = t.grow;
        if (t.state === 'grow') t.grow = Math.min(1, t.grow + rdt / 2.2);
        else t.grow = Math.max(0, t.grow - rdt / 0.9);
        if (t.grow !== g0) dendDirty = true;
      }
      const before = trees.length;
      trees = trees.filter(t => t.state === 'grow' || t.grow > 0);
      if (trees.length !== before) dendDirty = true;
      // spontaneous firing (Infections/events setting), limited by the activity setting
      const maxP = 1 + Math.round(P.traffic * 5);
      if (P.skirmish > 0 && somas.length) {
        nextFire -= dt;
        if (nextFire <= 0) {
          nextFire = ctx.mix(25, 4, P.skirmish) * (0.5 + R());
          if (pulses.length < maxP && P.traffic > 0) fireSoma(ctx, somas[(R() * somas.length) | 0], 0, null);
        }
      }
      for (const tm of timers) { tm.t -= dt; if (tm.t <= 0 && !tm.done) { tm.done = true; tm.fn(); } }
      timers = timers.filter(tm => !tm.done);
      for (const p of pulses) {
        p.pos += p.speed * dt;
        if (p.pos >= p.L && !p.done) { p.done = true; if (p.onEnd) p.onEnd(); }
      }
      pulses = pulses.filter(p => p.pos < p.L + 30);
      for (const s of somas) s.flash = Math.max(0, s.flash - dt * 1.4);
      for (const s of specks) { s.t += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= Math.exp(-dt * 2.5); s.vy *= Math.exp(-dt * 2.5); }
      specks = specks.filter(s => s.t < s.life);
      for (const f of flashes) f.t += dt; flashes = flashes.filter(f => f.t < f.life);
      for (const s of sprouts) s.t += dt; sprouts = sprouts.filter(s => s.t < s.life);
    },

    render(ctx) {
      if (!dend) return;
      if (dendDirty) { dendDirty = false; drawDend(ctx); }
      flData.fill(0);
      let k = 0;
      for (const s of somas) if (s.flash > 0.01 && k < NFL) { flData[k * 4] = s.cx; flData[k * 4 + 1] = s.cy; flData[k * 4 + 2] = s.rad; flData[k * 4 + 3] = s.flash; k++; }
      ctx.fullscreen(prog, { uFl: flData }, { uDend: dend.tex }, null);
      const t = ctx.flow, I = ctx.intro;
      // pulses ride the swaying dendrites: find the point at arc length pos and apply the same sway as the shader
      for (const p of pulses) {
        const path = p.path, d0 = path[0].d;
        for (let tr = 0; tr < 4; tr++) {
          const target = p.pos - tr * 9; if (target < 0 || target > p.L) continue;
          while (p.i < path.length - 2 && path[p.i + 1].d - d0 < p.pos) p.i++;
          let i = 0; while (i < path.length - 2 && path[i + 1].d - d0 < target) i++;
          const a = path[i], b = path[i + 1], u = clamp((target - (a.d - d0)) / Math.max(1e-3, b.d - a.d), 0, 1);
          let x = a.x + (b.x - a.x) * u, y = a.y + (b.y - a.y) * u;
          const k2 = swayAmp(ctx.blobAt(x, y)), s2 = sway(x, y, t); x += s2[0] * k2; y += s2[1] * k2;
          const fade = 1 - sst(p.L - 30, p.L + 30, target);
          ctx.glowDot(x, y, tr ? 5 : 9, PULSE, (tr ? 1.1 - tr * 0.25 : 3.2) * fade * I, { core: tr ? 0.3 : 1 });
        }
      }
      for (const s of specks) { const k3 = 1 - s.t / s.life; ctx.glowDot(s.x, s.y, 2.2, GOLD, 1.4 * k3 * I, { core: 0.6 }); }
      for (const f of flashes) { const k4 = f.t / f.life; ctx.sprite('ring', f.x, f.y, { w: f.r * (1 + 2 * k4), alpha: (1 - k4) * (1 - k4) * 0.6, tint: f.c, add: true }); ctx.glowDot(f.x, f.y, f.r * 0.5, f.c, 1.2 * (1 - k4) * (1 - k4), { core: 0.4 }); }
      for (const s of sprouts) {
        const g = sst(0, 0.9, s.t), fade = 1 - sst(s.life - 1, s.life, s.t), n = Math.max(1, Math.floor(g * (s.pts.length - 1)));
        for (let i = 0; i < n; i++) ctx.glowLine(s.pts[i][0], s.pts[i][1], s.pts[i + 1][0], s.pts[i + 1][1], 1.2 - i * 0.08, DEND, 0.7 * fade, { core: 0.6 });
      }
      ctx.flush();
    },

    dispose(ctx) { if (prog) ctx.gl.deleteProgram(prog.p); prog = null; if (dend) ctx.freeTarget(dend); dend = null; }
  });
})();
