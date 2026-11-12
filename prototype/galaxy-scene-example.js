// Reference scene for the Galaxy engine: shows every engine feature in a small amount of code.
// Not loaded by galaxy.html. Copy the patterns from here into a real scene file.
(function () {
  const ID = window.GALAXY_EXAMPLE_ID || 'example';
  let ground = null, flock = null, bolts = null, fireT = 0;

  Galaxy.register(ID, {
    name: 'Example',
    post: { bloom: 0.9, threshold: 1.0, exposure: 1.0, vignette: 0.4, grain: 0.02 },

    init(ctx) {
      // Fullscreen shader: the ground. The shared header gives cssPos(), iconDist(), iconBlob(), noise, voronoi ...
      ground = ctx.program(`
        void main() {
          vec2 p = cssPos();
          float d = iconBlob(p);                                     // blobby distance: ~0 at blob edge, negative inside
          float n = fbm(p * 0.004 + uSeed, 6);
          vec3 base = mix(vec3(0.75, 0.72, 0.70), vec3(0.95, 0.94, 0.92), n);
          vec3 red = vec3(0.55, 0.06, 0.04) * (0.7 + 0.6 * fbm(p * 0.02, 4));
          float scar = smoothstep(10.0, -10.0, d - (1.0 - uIntro) * 300.0);   // grows in with uIntro
          vec3 col = mix(base, red, scar);
          col *= 0.85 + 0.3 * smoothstep(-40.0, 40.0, iconDist(p));  // slight darkening right next to icons
          outColor = vec4(col, 1.0);
        }`);
      // Sprites are drawn once into the atlas with Canvas 2D. Draw at high resolution; the engine mipmaps them.
      ctx.atlas.define('ship', 256, 128, (g, w, h) => {
        g.fillStyle = '#d8d8dc';
        g.beginPath(); g.moveTo(w * 0.95, h * 0.5); g.lineTo(w * 0.1, h * 0.15); g.lineTo(w * 0.2, h * 0.5); g.lineTo(w * 0.1, h * 0.85); g.closePath(); g.fill();
        g.fillStyle = '#7a7f88'; g.fillRect(w * 0.3, h * 0.44, w * 0.4, h * 0.12);
      });
      flock = new ctx.Flock({ count: 10, speed: 140, margin: 50, formation: 2, seedK: 3 });
      bolts = new ctx.Bolts();
    },

    update(ctx) {
      flock.resize(Math.round(4 + 14 * ctx.P.traffic));
      flock.update(ctx.dt, ctx.t);
      fireT -= ctx.dt;
      if (ctx.P.skirmish > 0 && fireT <= 0) {
        const a = flock.agents[(Math.random() * flock.agents.length) | 0];
        if (a) bolts.fire(a.x, a.y, a.ang, { color: [1, 0.12, 0.08], intensity: 8 });
        fireT = 0.15 + (1 - ctx.P.skirmish) * 2;
      }
      bolts.update(ctx.dt);
    },

    render(ctx) {
      ctx.fullscreen(ground);
      for (const a of flock.agents) {
        ctx.sprite('ship', a.x, a.y, { w: 40, rot: a.ang, shadow: { dx: 14, dy: 20, alpha: 0.35, bias: 3 } });
        ctx.glowDot(a.x - Math.cos(a.ang) * 18, a.y - Math.sin(a.ang) * 18, 6, [0.4, 0.7, 1.0], 4);
      }
      bolts.draw();
      // The engine flushes the queue after render(); call ctx.flush() yourself only to layer a fullscreen pass on top of sprites.
    },

    dispose(ctx) { if (ground) ctx.gl.deleteProgram(ground.p); }
  });
})();
