// Deskland · shared WebGL scene engine (each theme page loads it plus one scene file)
//
// One theme, six scenes: Faction (Empire / Rebellion) x Era (Original / Prequel / Sequel).
// This file owns everything the scenes share:
//   - the page contract that share.js and the hosts rely on (cv, draw, icons, W, H, WALL, paused, frameN, commit ...)
//   - host / preview messaging (ready, settings, reset, icons, pause)
//   - the icon field: per-pixel distance to the desktop icons, morphing smoothly when icons move
//   - an HDR pipeline: scenes draw into a float target, then bloom + ACES tone mapping + vignette + grain + aberration
//   - an instanced sprite batcher (texture atlas drawn once by the scene with Canvas 2D, soft shadows via mip bias)
//   - additive glow primitives (blaster bolts, engine glows, lights)
//   - helpers: Flock (ships that steer around icons), Bolts (blaster fire with impacts), seeded RNG, GLSL noise library
//   - the hyperspace transition when the faction or era changes
//
// Scene API (see Galaxy.register below and the comments on the ctx object).
'use strict';

/* ======================================================================
   Page contract (top-level bindings are shared with share.js and the scene files)
   ====================================================================== */
const CELL_W = 76, CELL_H = 100, GRID_X0 = 4, GRID_Y0 = 6, TASKBAR = 48;
const STEP = 4;                       // Icon field grid step in CSS px
const FIELD_CAP = 640;                // Sharp distance is exact up to this many CSS px from the nearest icon, then clamped
const MORPH_MS = 1700;
const QS = new URLSearchParams(location.search);
const WALL = QS.has('wallpaper');     // Loaded by the desktop host
const PREVIEW = QS.has('preview');    // Loaded as the live preview inside the settings window

// Defaults must match the "galaxy" entry in themes.json
const P = { sigma: 70, traffic: 0.6, skirmish: 0.35, flow: 1, quality: 1, fps: 1, adaptive: 1,
  cursor: 1, fire: 1 };
const DEFAULTS = Object.assign({}, P);
const PARAM_KEYS = Object.keys(DEFAULTS);

let W = innerWidth, H = innerHeight;
let icons = [];                       // [{x, y, w, h}] in CSS px
let paused = false;
let frameN = 0;
let seed = (Math.random() * 1e6) | 0;
let cacheOK = true;                   // share.js clears this before redrawing at a new size; the engine re-validates every draw anyway

const cv = document.getElementById('art');
const gl = cv.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
if (!gl) document.getElementById('nogl').style.display = 'grid';
const HALF_OK = !!(gl && gl.getExtension('EXT_color_buffer_float'));
if (gl) gl.getExtension('OES_texture_float_linear');

/* ======================================================================
   Small utilities
   ====================================================================== */
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function hash2(x, y, k = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul((k + seed) | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v; const x = u32[0];
  const sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7bff;
  return sign | (e << 10) | (m >>> 13);
}

/* ======================================================================
   Image and texture loading (scenes may ship texture files under assets/saltflats/)
   While anything is loading, test captures wait (whenAssetsReady). When the last load finishes,
   the active scene gets resize() + layout() again so it can rebuild caches with the real textures.
   ====================================================================== */
const pending = new Set(), readyQueue = [], imageCache = {}, texCache = {};
function trackLoad(key, img, onDone) {
  pending.add(key);
  const fin = ok => {
    if (!ok) console.warn('[galaxy] failed to load ' + key);
    else if (onDone) onDone();
    pending.delete(key);
    if (!pending.size) assetsSettled();
  };
  img.onload = () => fin(true); img.onerror = () => fin(false);
}
function loadImage(url) {
  if (imageCache[url]) return imageCache[url];
  const img = new Image();
  imageCache[url] = img;
  trackLoad(url, img, () => { atlasDirty = true; });
  img.src = url;
  return img;
}
// Returns a texture immediately (a 1x1 mid-gray placeholder until the image arrives). Mipmapped, anisotropic.
// o: {srgb (default true: color data, decoded to linear on sampling; use false for normals/heights/masks), repeat (default true)}
function loadTexture(url, o = {}) {
  const srgb = o.srgb !== false, repeat = o.repeat !== false, key = url + (srgb ? '#s' : '#l') + (repeat ? 'r' : 'c');
  if (texCache[key]) return texCache[key];
  const tex = gl.createTexture();
  texCache[key] = tex;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
  // Decode with createImageBitmap so alpha stays straight (an <img> is premultiplied by the browser, which destroys
  // color data packed under low alpha) and data maps skip color-space conversion.
  pending.add(key);
  fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
    .then(b => createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: srgb ? 'default' : 'none' }))
    .then(bmp => { upload(bmp); bmp.close && bmp.close(); }, e => console.warn('[galaxy] failed to load ' + url + ': ' + e))
    .finally(() => { pending.delete(key); if (!pending.size) assetsSettled(); });
  function upload(img) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const w = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w);
    const ani = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ani) gl.texParameterf(gl.TEXTURE_2D, ani.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    tex.width = img.width; tex.height = img.height;
  }
  return tex;
}
let atlasDirty = false;
function assetsSettled() {
  if (atlasDirty) { atlasDirty = false; atlas.build(); }
  const sc = activeScene();
  if (sc) { if (sc.resize) safe(() => sc.resize(ctx)); if (sc.layout) safe(() => sc.layout(ctx)); }
  while (readyQueue.length) readyQueue.shift()();
}
function whenAssetsReady(fn) { if (!pending.size) fn(); else readyQueue.push(fn); }

/* ======================================================================
   GLSL: shared header for every scene shader
   Fullscreen passes get vUv (0..1, origin top-left) and these helpers.
   ====================================================================== */
const GLSL_COMMON = `
precision highp float;
precision highp int;
uniform vec2 uRes;        // canvas size in CSS px
uniform vec2 uPx;         // canvas size in device px
uniform float uScale;     // device px per CSS px
uniform float uTime;      // seconds the scene has been animating (stops while paused)
uniform float uFlow;      // time scaled by the Speed setting
uniform float uSeed;      // small float derived from the seed (changes on Refresh)
uniform float uIntro;     // 0 -> 1 over the first seconds after the scene appears (grow-in effects)
uniform float uSigma;     // "Distance from icons" setting, CSS px
uniform sampler2D uFA, uFB; // icon field (R = sharp signed distance, G = blobby distance), old and new layouts
uniform float uMix;       // morph between old (0) and new (1) icon layout
uniform vec2 uGrid;       // field texture size in cells
uniform float uStep;      // field cell size in CSS px
in vec2 vUv;              // GL texture coordinate of the target (origin bottom-left): use for sampling screen-sized targets
out vec4 outColor;

// CSS-pixel position of this fragment, origin top-left (matches icon coordinates)
vec2 cssPos() { return vec2(gl_FragCoord.x, uPx.y - gl_FragCoord.y) / uScale; }
vec2 fieldUV(vec2 p) { return (p / uStep + 0.5) / uGrid; }
// Signed distance in CSS px to the nearest icon (negative inside an icon), clamped far away at ${FIELD_CAP}
float iconDist(vec2 p) { vec2 uv = fieldUV(p); return mix(texture(uFA, uv).r, texture(uFB, uv).r, uMix); }
// Soft, blobby distance: nearby icons merge into one shape. Scales with uSigma. ~0 at the blob edge, negative inside
float iconBlob(vec2 p) { vec2 uv = fieldUV(p); return mix(texture(uFA, uv).g, texture(uFB, uv).g, uMix); }
vec2 iconGrad(vec2 p) { float e = uStep; return vec2(iconDist(p + vec2(e, 0.)) - iconDist(p - vec2(e, 0.)), iconDist(p + vec2(0., e)) - iconDist(p - vec2(0., e))) / (2. * e); }

float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash32(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
float gnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  vec2 ga = hash22(i) * 2. - 1., gb = hash22(i + vec2(1, 0)) * 2. - 1., gc = hash22(i + vec2(0, 1)) * 2. - 1., gd = hash22(i + vec2(1, 1)) * 2. - 1.;
  float va = dot(ga, f), vb = dot(gb, f - vec2(1, 0)), vc = dot(gc, f - vec2(0, 1)), vd = dot(gd, f - vec2(1, 1));
  return va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd); }   // about -0.7 .. 0.7
float fbm(vec2 p, int oct) { float s = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * vnoise(p); p = m * p; a *= .5; } return s; }
float gfbm(vec2 p, int oct) { float s = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * gnoise(p); p = m * p; a *= .5; } return s; }
float ridged(vec2 p, int oct) { float s = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * (1. - abs(gnoise(p) * 1.4)); p = m * p; a *= .5; } return s; }
// Voronoi: x = distance to nearest point, y = distance to second nearest, zw = id of the nearest cell
vec4 voronoi(vec2 p) { vec2 n = floor(p), f = fract(p); float d1 = 8., d2 = 8.; vec2 id = vec2(0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = vec2(i, j); vec2 o = hash22(n + g); vec2 r = g + o - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = n + g; } else if (d < d2) d2 = d; }
  return vec4(sqrt(d1), sqrt(d2), id); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.)) + min(max(d.x, d.y), 0.); }
float sdRoundBox(vec2 p, vec2 b, float r) { return sdBox(p, b - r) - r; }
float sdSegment(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h); }
float smin(float a, float b, float k) { float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }
float luma(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
`;

// Oversized triangle. vUv is the GL texture coordinate of the target (origin bottom-left): use it to sample screen-sized targets.
// For geometry in screen space use cssPos() (origin top-left, CSS px, same as icon coordinates).
const VS_FULL = `#version 300 es
out vec2 vUv;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = p; gl_Position = vec4(p * 2. - 1., 0., 1.); }`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n');
    console.error('[galaxy] shader compile failed:\n' + log + '\n' + lines);
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}
function linkProgram(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  const U = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); U[name] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size }; }
  return { p, U };
}
// Fullscreen fragment program. The source is the body after the shared header (write main(); outColor is predeclared).
function fullscreenProgram(body) { return linkProgram(VS_FULL, '#version 300 es\n' + GLSL_COMMON + '\n' + body); }

function setUniform(U, name, v) {
  const u = U[name]; if (!u) return;
  const L = u.loc;
  switch (u.type) {
    case gl.FLOAT: if (u.size > 1) gl.uniform1fv(L, v); else gl.uniform1f(L, v); break;
    case gl.FLOAT_VEC2: gl.uniform2fv(L, v); break;
    case gl.FLOAT_VEC3: gl.uniform3fv(L, v); break;
    case gl.FLOAT_VEC4: gl.uniform4fv(L, v); break;
    case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: case gl.SAMPLER_3D: case gl.SAMPLER_2D_ARRAY: case gl.INT_SAMPLER_2D: case gl.UNSIGNED_INT_SAMPLER_2D:
      gl.uniform1i(L, v); break;
    case gl.INT_VEC2: gl.uniform2iv(L, v); break;
    case gl.FLOAT_MAT2: gl.uniformMatrix2fv(L, false, v); break;
    case gl.FLOAT_MAT3: gl.uniformMatrix3fv(L, false, v); break;
    default: gl.uniform1f(L, v);
  }
}

/* ======================================================================
   Render targets
   ====================================================================== */
function makeTarget(w, h, opts = {}) {
  const float = opts.float !== false && HALF_OK;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
  const filt = opts.nearest ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
  const wrap = opts.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fb, tex, w, h, float };
}
function freeTarget(t) { if (!t) return; gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }

/* ======================================================================
   Icon field: R = sharp signed distance (min over icons), G = blobby gaussian-sum distance (scales with sigma)
   ====================================================================== */
let Gw = 1, Gh = 1;
const ftex = [null, null];
let fromI = 0, toI = 1, morphT0 = -1e9, morphDur = MORPH_MS, curMix = 1;
let FA = null, FB = null;             // CPU copies {d, b} for the old and new layout
let fieldVersion = 0;
const iconRects = list => list.map(ic => ({ cx: ic.x + ic.w / 2, cy: ic.y + ic.h / 2 - 2, hw: Math.max(8, ic.w / 2 - 10), hh: Math.max(8, ic.h / 2 - 8) }));
function computeField(rects) {
  const N = Gw * Gh, d = new Float32Array(N).fill(FIELD_CAP), acc = new Float32Array(N);
  const sig = P.sigma, is1 = 1 / (sig * sig), rr = 12;
  for (const r of rects) {
    const R = Math.max(FIELD_CAP, 5.5 * sig + Math.max(r.hw, r.hh));
    const gx0 = Math.max(0, Math.floor((r.cx - R) / STEP)), gx1 = Math.min(Gw - 1, Math.ceil((r.cx + R) / STEP));
    const gy0 = Math.max(0, Math.floor((r.cy - R) / STEP)), gy1 = Math.min(Gh - 1, Math.ceil((r.cy + R) / STEP));
    const bx = r.hw - rr, by = r.hh - rr, chw = r.hw * 0.5, chh = r.hh * 0.5, Rb = 5.5 * sig + Math.max(r.hw, r.hh) * 0.5;
    for (let gy = gy0; gy <= gy1; gy++) {
      const y = gy * STEP, qy = Math.abs(y - r.cy) - by, ey = Math.max(0, Math.abs(y - r.cy) - chh);
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * Gw + gx, x = gx * STEP, qx = Math.abs(x - r.cx) - bx;
        const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
        const sd = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - rr;
        if (sd < d[i]) d[i] = sd;
        if (Math.abs(x - r.cx) < Rb && Math.abs(y - r.cy) < Rb) {
          const ex = Math.max(0, Math.abs(x - r.cx) - chw);
          acc[i] += Math.exp(-(ex * ex + ey * ey) * is1);
        }
      }
    }
  }
  const c0 = Math.sqrt(-Math.log(0.35)), b = new Float32Array(N), fMin = Math.exp(-30);
  for (let i = 0; i < N; i++) {
    const g = Math.log(Math.max(acc[i], fMin));
    b[i] = Math.min(FIELD_CAP, sig * (Math.sqrt(Math.max(-g, 0)) - c0) - sig * 0.6 * Math.max(g, 0));
  }
  return { d, b };
}
function allocField() {
  for (let i = 0; i < 2; i++) {
    if (ftex[i]) gl.deleteTexture(ftex[i]);
    ftex[i] = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, ftex[i]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, Gw, Gh, 0, gl.RG, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
}
function uploadField(i, F) {
  const n = Gw * Gh, data = new Uint16Array(n * 2);
  for (let k = 0; k < n; k++) { data[2 * k] = toHalf(F.d[k]); data[2 * k + 1] = toHalf(F.b[k]); }
  gl.bindTexture(gl.TEXTURE_2D, ftex[i]);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Gw, Gh, gl.RG, gl.HALF_FLOAT, data);
}
let prevIcons = [];
// New icon layout: morph from the current field to the new one. fromEmpty: the scene grows in around the icons for the first time.
function commit(fromEmpty = false) {
  const list = P.adaptive ? icons : [];
  const nf = computeField(iconRects(list));
  if (fromEmpty || !FB) { FA = computeField([]); uploadField(toI, FA); }
  else FA = FB;
  FB = nf;
  const target = 1 - toI;
  uploadField(target, FB);
  fromI = toI; toI = target;
  morphT0 = performance.now();
  morphDur = fromEmpty ? 2600 : MORPH_MS;
  fieldVersion++;
  const sc = activeScene();
  if (sc && sc.layout) safe(() => sc.layout(ctx));
  prevIcons = list.map(ic => ({ x: ic.x, y: ic.y, w: ic.w, h: ic.h }));
}
// Same layout, new field parameters (sigma changed, resize): no morph
function refresh() {
  FA = FB = computeField(iconRects(P.adaptive ? icons : []));
  uploadField(toI, FB);
  fromI = toI; morphT0 = -1e9; curMix = 1;
  fieldVersion++;
  const sc = activeScene();
  if (sc && sc.layout) safe(() => sc.layout(ctx));
}
function sampleArr(a, x, y) {
  const fx = clamp(x / STEP, 0, Gw - 1.001), fy = clamp(y / STEP, 0, Gh - 1.001);
  const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, i = iy * Gw + ix;
  return (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[i + Gw] * (1 - tx) + a[i + Gw + 1] * tx) * ty;
}
const distAt = (x, y) => FB ? sampleArr(FA.d, x, y) * (1 - curMix) + sampleArr(FB.d, x, y) * curMix : FIELD_CAP;
const blobAt = (x, y) => FB ? sampleArr(FA.b, x, y) * (1 - curMix) + sampleArr(FB.b, x, y) * curMix : FIELD_CAP;
function gradAt(x, y, fn = distAt) { const e = STEP * 1.5; return [(fn(x + e, y) - fn(x - e, y)) / (2 * e), (fn(x, y + e) - fn(x, y - e)) / (2 * e)]; }

/* ======================================================================
   Sprite atlas: scenes draw their sprites once with Canvas 2D at init; the engine packs and uploads them (premultiplied, mipmapped)
   ====================================================================== */
const ATLAS_SIZE = 4096, ATLAS_PAD = 6;
const atlas = {
  defs: [], map: {}, tex: null, canvas: null,
  // name, pixel size of the drawing, draw(g, w, h, img) with a CanvasRenderingContext2D. The sprite's drawn size later is set in CSS px.
  // opts.image: URL of an image to load first; it is passed to drawFn as img (the atlas is rebuilt once it arrives).
  define(name, w, h, drawFn, opts = {}) {
    const d = { name, w: Math.ceil(w), h: Math.ceil(h), drawFn, img: null };
    if (opts.image) d.img = loadImage(opts.image);
    this.defs.push(d);
  },
  has(name) { return !!this.map[name]; },
  build() {
    if (!this.defs.length) return;
    const defs = this.defs.slice().sort((a, b) => b.h - a.h);
    let x = ATLAS_PAD, y = ATLAS_PAD, rowH = 0;
    for (const d of defs) {
      if (x + d.w + ATLAS_PAD > ATLAS_SIZE) { x = ATLAS_PAD; y += rowH + ATLAS_PAD * 2; rowH = 0; }
      d.x = x; d.y = y; x += d.w + ATLAS_PAD * 2; rowH = Math.max(rowH, d.h);
    }
    const usedH = Math.min(ATLAS_SIZE, 1 << Math.ceil(Math.log2(y + rowH + ATLAS_PAD)));
    if (y + rowH > ATLAS_SIZE) console.warn('[galaxy] sprite atlas overflow: shrink sprites');
    const c = document.createElement('canvas'); c.width = ATLAS_SIZE; c.height = usedH;
    const g = c.getContext('2d');
    for (const d of defs) {
      g.save(); g.beginPath(); g.rect(d.x, d.y, d.w, d.h); g.clip(); g.translate(d.x, d.y);
      if (!d.img || d.img.complete && d.img.naturalWidth) {
        try { d.drawFn(g, d.w, d.h, d.img); } catch (e) { console.error('[galaxy] sprite ' + d.name + ' failed', e); }
      }
      g.restore();
      this.map[d.name] = { u0: d.x / ATLAS_SIZE, v0: d.y / usedH, u1: (d.x + d.w) / ATLAS_SIZE, v1: (d.y + d.h) / usedH, aspect: d.h / d.w };
    }
    if (!this.tex) this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ani = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ani) gl.texParameterf(gl.TEXTURE_2D, ani.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    this.canvas = c;
  },
  reset() { this.defs = []; this.map = {}; }
};

/* ======================================================================
   Draw queue: sprites and glows, drawn in submission order (premultiplied blending; additive = alpha 0)
   ====================================================================== */
const SPRITE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iPosSize;   // x, y (center, CSS px), w, h (CSS px)
layout(location=2) in vec4 iUV;        // u0, v0, u1, v1
layout(location=3) in vec4 iColor;     // tint rgb (may exceed 1 for HDR), alpha
layout(location=4) in vec4 iMisc;      // rotation (rad, clockwise), additive 0/1, mip bias, flat (0 = use texture color, 1 = solid tint)
uniform vec2 uRes;
out vec2 vUv; out vec4 vColor; out vec3 vMisc;
void main() {
  float c = cos(iMisc.x), s = sin(iMisc.x);
  vec2 q = aCorner * iPosSize.zw;
  vec2 p = iPosSize.xy + vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  vUv = mix(iUV.xy, iUV.zw, aCorner + .5);
  vColor = iColor; vMisc = iMisc.yzw;
  gl_Position = vec4(p.x / uRes.x * 2. - 1., 1. - p.y / uRes.y * 2., 0., 1.);
}`;
const SPRITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
in vec2 vUv; in vec4 vColor; in vec3 vMisc;
out vec4 o;
void main() {
  vec4 t = texture(uAtlas, vUv, vMisc.y);
  // The atlas holds sRGB colors (Canvas 2D); decode to linear so sprites match the HDR scene (premultiplied: decode the straight color)
  vec3 lin = t.a > 1e-4 ? pow(t.rgb / t.a, vec3(2.2)) * t.a : vec3(0);
  vec3 rgb = mix(lin, vec3(t.a), vMisc.z) * vColor.rgb;
  o = vec4(rgb * vColor.a, t.a * vColor.a * (1. - vMisc.x));
}`;
const GLOW_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iAB;       // segment endpoints a.xy, b.xy (CSS px)
layout(location=2) in vec4 iColor;    // rgb, intensity
layout(location=3) in vec4 iShape;    // radius (CSS px), core strength, core radius fraction, falloff exponent
uniform vec2 uRes;
out vec2 vP; out vec4 vColor; out vec4 vShape; flat out vec4 vAB;
void main() {
  vec2 a = iAB.xy, b = iAB.zw, d = b - a; float L = length(d);
  vec2 ax = L > 1e-4 ? d / L : vec2(1, 0), ay = vec2(-ax.y, ax.x);
  float ext = iShape.x * 3.2;
  vec2 mid = (a + b) * .5;
  vec2 p = mid + ax * aCorner.x * (L + 2. * ext) + ay * aCorner.y * (2. * ext);
  vP = p; vColor = iColor; vShape = iShape; vAB = iAB;
  gl_Position = vec4(p.x / uRes.x * 2. - 1., 1. - p.y / uRes.y * 2., 0., 1.);
}`;
const GLOW_FS = `#version 300 es
precision highp float;
in vec2 vP; in vec4 vColor; in vec4 vShape; flat in vec4 vAB;
out vec4 o;
void main() {
  vec2 pa = vP - vAB.xy, ba = vAB.zw - vAB.xy; float bb = dot(ba, ba);
  float h = bb > 1e-6 ? clamp(dot(pa, ba) / bb, 0., 1.) : 0.;
  float d = length(pa - ba * h);
  float r = max(vShape.x, 1e-3);
  float halo = exp(-pow(d / r, vShape.w) * 2.2);
  float core = exp(-pow(d / (r * vShape.z), 2.) * 2.) * vShape.y;
  vec3 c = vColor.rgb * vColor.a * halo + vec3(1.) * vColor.a * core * (0.35 + 0.65 * max(max(vColor.r, vColor.g), vColor.b));
  o = vec4(c, 0.);
}`;
let spritePR = null, glowPR = null, quadVBO = null, spriteVAO = null, glowVAO = null, spriteBuf = null, glowBuf = null;
const SPR_STRIDE = 16, GLOW_STRIDE = 12;
let sprData = new Float32Array(SPR_STRIDE * 4096), glowData = new Float32Array(GLOW_STRIDE * 4096);
const queue = [];   // runs: {kind:'s'|'g', n}
let sprN = 0, glowN = 0;
function initBatchers() {
  spritePR = linkProgram(SPRITE_VS, SPRITE_FS);
  glowPR = linkProgram(GLOW_VS, GLOW_FS);
  quadVBO = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.5, -.5, .5, -.5, -.5, .5, .5, .5]), gl.STATIC_DRAW);
  spriteBuf = gl.createBuffer(); glowBuf = gl.createBuffer();
  spriteVAO = gl.createVertexArray(); gl.bindVertexArray(spriteVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuf);
  for (let k = 0; k < 4; k++) { gl.enableVertexAttribArray(1 + k); gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, SPR_STRIDE * 4, k * 16); gl.vertexAttribDivisor(1 + k, 1); }
  glowVAO = gl.createVertexArray(); gl.bindVertexArray(glowVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, glowBuf);
  for (let k = 0; k < 3; k++) { gl.enableVertexAttribArray(1 + k); gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, GLOW_STRIDE * 4, k * 16); gl.vertexAttribDivisor(1 + k, 1); }
  gl.bindVertexArray(null);
}
function pushRun(kind) { const last = queue[queue.length - 1]; if (last && last.kind === kind) last.n++; else queue.push({ kind, n: 1 }); }
// Queue one sprite. o: {w (CSS px width, required), h (default from aspect), rot, alpha, tint [r,g,b], add, bias, flat, shadow:{dx,dy,alpha,bias,scale}}
function sprite(name, x, y, o) {
  const m = atlas.map[name]; if (!m) return;
  const w = o.w, h = o.h || o.w * m.aspect;
  if (o.shadow) {
    const s = o.shadow;
    sprite(name, x + (s.dx || 0), y + (s.dy || 0), { w: w * (s.scale || 1), h: h * (s.scale || 1), rot: o.rot, alpha: (s.alpha == null ? 0.45 : s.alpha) * (o.alpha == null ? 1 : o.alpha), tint: s.tint || [0, 0, 0], bias: s.bias == null ? 2.5 : s.bias, flat: 1 });
  }
  if ((sprN + 1) * SPR_STRIDE > sprData.length) { const nd = new Float32Array(sprData.length * 2); nd.set(sprData); sprData = nd; }
  const t = o.tint || [1, 1, 1], i = sprN * SPR_STRIDE;
  sprData[i] = x; sprData[i + 1] = y; sprData[i + 2] = w; sprData[i + 3] = h;
  sprData[i + 4] = m.u0; sprData[i + 5] = m.v0; sprData[i + 6] = m.u1; sprData[i + 7] = m.v1;
  sprData[i + 8] = t[0]; sprData[i + 9] = t[1]; sprData[i + 10] = t[2]; sprData[i + 11] = o.alpha == null ? 1 : o.alpha;
  sprData[i + 12] = o.rot || 0; sprData[i + 13] = o.add ? 1 : 0; sprData[i + 14] = o.bias || 0; sprData[i + 15] = o.flat || 0;
  sprN++; pushRun('s');
}
// Additive glowing capsule from (x1,y1) to (x2,y2). color [r,g,b], intensity (HDR, >1 blooms), r = halo radius CSS px.
// o: {core (white-hot center strength, default 1), coreR (fraction of r, default 0.28), falloff (exponent, default 2)}
function glowLine(x1, y1, x2, y2, r, color, intensity, o = {}) {
  if ((glowN + 1) * GLOW_STRIDE > glowData.length) { const nd = new Float32Array(glowData.length * 2); nd.set(glowData); glowData = nd; }
  const i = glowN * GLOW_STRIDE;
  glowData[i] = x1; glowData[i + 1] = y1; glowData[i + 2] = x2; glowData[i + 3] = y2;
  glowData[i + 4] = color[0]; glowData[i + 5] = color[1]; glowData[i + 6] = color[2]; glowData[i + 7] = intensity;
  glowData[i + 8] = r; glowData[i + 9] = o.core == null ? 1 : o.core; glowData[i + 10] = o.coreR || 0.28; glowData[i + 11] = o.falloff || 2;
  glowN++; pushRun('g');
}
const glowDot = (x, y, r, color, intensity, o) => glowLine(x, y, x + 0.001, y, r, color, intensity, o);
let sprOff = 0, glowOff = 0;
function flushQueue() {
  if (!queue.length) return;
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  if (sprN) { gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuf); gl.bufferData(gl.ARRAY_BUFFER, sprData.subarray(0, sprN * SPR_STRIDE), gl.STREAM_DRAW); }
  if (glowN) { gl.bindBuffer(gl.ARRAY_BUFFER, glowBuf); gl.bufferData(gl.ARRAY_BUFFER, glowData.subarray(0, glowN * GLOW_STRIDE), gl.STREAM_DRAW); }
  let so = 0, go = 0;
  for (const run of queue) {
    if (run.kind === 's') {
      gl.useProgram(spritePR.p); gl.bindVertexArray(spriteVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuf);
      for (let k = 0; k < 4; k++) gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, SPR_STRIDE * 4, so * SPR_STRIDE * 4 + k * 16);
      setUniform(spritePR.U, 'uRes', [W_css(), H_css()]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlas.tex); setUniform(spritePR.U, 'uAtlas', 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.n); so += run.n;
    } else {
      gl.useProgram(glowPR.p); gl.bindVertexArray(glowVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, glowBuf);
      for (let k = 0; k < 3; k++) gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, GLOW_STRIDE * 4, go * GLOW_STRIDE * 4 + k * 16);
      setUniform(glowPR.U, 'uRes', [W_css(), H_css()]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.n); go += run.n;
    }
  }
  gl.bindVertexArray(null);
  gl.disable(gl.BLEND);
  queue.length = 0; sprN = 0; glowN = 0;
}
const W_css = () => cv.width / cv._scale, H_css = () => cv.height / cv._scale;

/* ======================================================================
   Post-processing: bloom (13-tap downsample / tent upsample chain), ACES, vignette, grain, aberration, hyperspace
   ====================================================================== */
const POST_COMMON = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uTexel;
`;
const PREFILTER_FS = POST_COMMON + `
uniform float uThreshold, uKnee;
void main() {
  vec3 c = vec3(0); vec2 t = uTexel;
  c += texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb; c += texture(uSrc, vUv + vec2(t.x, -t.y)).rgb;
  c += texture(uSrc, vUv + vec2(-t.x, t.y)).rgb; c += texture(uSrc, vUv + vec2(t.x, t.y)).rgb; c *= .25;
  c = min(c, vec3(60.));
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0., 2. * uKnee); rq = rq * rq / (4. * uKnee + 1e-5);
  float w = max(rq, br - uThreshold) / max(br, 1e-5);
  o = vec4(c * w, 1.);
}`;
const DOWN_FS = POST_COMMON + `
void main() {
  vec2 t = uTexel;
  vec3 a = texture(uSrc, vUv + t * vec2(-2, -2)).rgb, b = texture(uSrc, vUv + t * vec2(0, -2)).rgb, c = texture(uSrc, vUv + t * vec2(2, -2)).rgb;
  vec3 d = texture(uSrc, vUv + t * vec2(-2, 0)).rgb, e = texture(uSrc, vUv).rgb, f = texture(uSrc, vUv + t * vec2(2, 0)).rgb;
  vec3 g = texture(uSrc, vUv + t * vec2(-2, 2)).rgb, h = texture(uSrc, vUv + t * vec2(0, 2)).rgb, i = texture(uSrc, vUv + t * vec2(2, 2)).rgb;
  vec3 j = texture(uSrc, vUv + t * vec2(-1, -1)).rgb, k = texture(uSrc, vUv + t * vec2(1, -1)).rgb, l = texture(uSrc, vUv + t * vec2(-1, 1)).rgb, m = texture(uSrc, vUv + t * vec2(1, 1)).rgb;
  vec3 r = e * .125 + (a + c + g + i) * .03125 + (b + d + f + h) * .0625 + (j + k + l + m) * .125;
  o = vec4(r, 1.);
}`;
const UP_FS = POST_COMMON + `
uniform float uRadius;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 r = texture(uSrc, vUv).rgb * 4.;
  r += (texture(uSrc, vUv + vec2(-t.x, 0)).rgb + texture(uSrc, vUv + vec2(t.x, 0)).rgb + texture(uSrc, vUv + vec2(0, -t.y)).rgb + texture(uSrc, vUv + vec2(0, t.y)).rgb) * 2.;
  r += texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(-t.x, t.y)).rgb + texture(uSrc, vUv + vec2(t.x, t.y)).rgb;
  o = vec4(r / 16., 1.);
}`;
const COMPOSITE_FS = POST_COMMON + `
uniform sampler2D uBloom;
uniform float uBloomStr, uExposure, uVignette, uGrain, uAberr, uTime, uHyper, uHyperPhase, uSeedF, uSat;
uniform vec3 uTint, uLift;
uniform vec2 uAspect;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 aces(vec3 x) { const float a = 2.51, b = .03, c = 2.43, d = .59, e = .14; return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0., 1.); }
vec3 sceneAt(vec2 uv) {
  vec2 d = (uv - .5);
  float ab = uAberr * (1. + uHyper * 6.);
  vec3 c;
  c.r = texture(uSrc, uv + d * ab).r; c.g = texture(uSrc, uv).g; c.b = texture(uSrc, uv - d * ab).b;
  return c + texture(uBloom, uv).rgb * uBloomStr;
}
void main() {
  vec2 uv = vUv;
  vec3 c;
  if (uHyper > 0.001) {
    // Hyperspace: radial blur toward the center, star streaks, white-blue flash at the peak
    vec2 d = uv - .5; c = vec3(0);
    float k = uHyper * .28;
    for (int i = 0; i < 12; i++) { float f = float(i) / 11.; c += sceneAt(.5 + d * (1. - k * f)); }
    c /= 12.;
    vec2 q = d * uAspect; float r = length(q), a = atan(q.y, q.x);
    float lanes = 260.; float id = floor(a / 6.28318 * lanes);
    float jit = h12(vec2(id, uSeedF)), len = mix(.05, .6, jit) * uHyper;
    float head = fract(jit * 7.3 + uHyperPhase * (1.2 + jit * 2.)) * 1.4;
    float streak = smoothstep(len, 0., abs(r - head * .9) ) * step(r, head * .9 + .02);
    float lane = 1. - smoothstep(0., .5, abs(fract(a / 6.28318 * lanes) - .5) * 2. - .1);
    vec3 sc = mix(vec3(.55, .75, 1.), vec3(1.), jit);
    c += sc * streak * lane * smoothstep(.03, .2, r) * (2.5 + 4. * uHyper) * uHyper;
    c = mix(c, vec3(.85, .92, 1.) * 3., smoothstep(.75, 1., uHyper));
  } else c = sceneAt(uv);
  c *= uExposure * uTint;
  c += uLift;
  c = aces(c);
  float l = dot(c, vec3(.2126, .7152, .0722)); c = mix(vec3(l), c, uSat);
  vec2 v = (uv - .5) * uAspect; c *= 1. - uVignette * smoothstep(.25, 1.05, length(v) * 1.15);
  float g = h12(gl_FragCoord.xy + fract(uTime * 13.7) * 371.) - .5;
  c += g * uGrain;
  c = pow(max(c, 0.), vec3(1. / 2.2));
  o = vec4(c, 1.);
}`;
let prefPR, downPR, upPR, compPR, hdr = null, bloomChain = [];
function initPost() {
  prefPR = linkProgram(VS_FULL, PREFILTER_FS);
  downPR = linkProgram(VS_FULL, DOWN_FS);
  upPR = linkProgram(VS_FULL, UP_FS);
  compPR = linkProgram(VS_FULL, COMPOSITE_FS);
}
function ensureTargets() {
  if (hdr && hdr.w === cv.width && hdr.h === cv.height) return false;
  freeTarget(hdr); bloomChain.forEach(freeTarget); bloomChain = [];
  hdr = makeTarget(cv.width, cv.height);
  let w = Math.max(1, cv.width >> 1), h = Math.max(1, cv.height >> 1);
  for (let i = 0; i < 7 && Math.min(w, h) >= 8; i++) { bloomChain.push(makeTarget(w, h)); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
  return true;
}
function passTo(t, pr) { gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null); gl.viewport(0, 0, t ? t.w : cv.width, t ? t.h : cv.height); gl.useProgram(pr.p); }
function postProcess() {
  const sc = activeScene() || {};
  const scenePost = typeof sc.post === 'function' ? sc.post(ctx) : sc.post;   // post may depend on time and weather
  const post = Object.assign({ bloom: 0.8, threshold: 1.0, knee: 0.5, exposure: 1.0, vignette: 0.35, grain: 0.025, aberration: 0.0012, tint: [1, 1, 1], lift: [0, 0, 0], saturation: 1, bloomRadius: 1 }, scenePost || {});
  if (Env.state.lightning > 0 && sc.weather !== false) {   // Lightning: a brief cool flash over the whole frame (scenes may opt out of weather)
    const f = Env.state.lightning;
    post.lift = [post.lift[0] + 0.05 * f, post.lift[1] + 0.06 * f, post.lift[2] + 0.09 * f];
    post.exposure *= 1 + 0.6 * f;
  }
  const levels = P.quality >= 1 ? bloomChain.length : Math.min(5, bloomChain.length);
  gl.disable(gl.BLEND);
  gl.activeTexture(gl.TEXTURE0);
  if (levels && post.bloom > 0) {
    passTo(bloomChain[0], prefPR);
    gl.bindTexture(gl.TEXTURE_2D, hdr.tex); setUniform(prefPR.U, 'uSrc', 0);
    setUniform(prefPR.U, 'uTexel', [1 / hdr.w, 1 / hdr.h]); setUniform(prefPR.U, 'uThreshold', post.threshold); setUniform(prefPR.U, 'uKnee', post.knee);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    for (let i = 1; i < levels; i++) {
      passTo(bloomChain[i], downPR);
      gl.bindTexture(gl.TEXTURE_2D, bloomChain[i - 1].tex); setUniform(downPR.U, 'uSrc', 0);
      setUniform(downPR.U, 'uTexel', [1 / bloomChain[i - 1].w, 1 / bloomChain[i - 1].h]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = levels - 1; i > 0; i--) {
      passTo(bloomChain[i - 1], upPR);
      gl.bindTexture(gl.TEXTURE_2D, bloomChain[i].tex); setUniform(upPR.U, 'uSrc', 0);
      setUniform(upPR.U, 'uTexel', [1 / bloomChain[i].w, 1 / bloomChain[i].h]); setUniform(upPR.U, 'uRadius', post.bloomRadius);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
  }
  passTo(null, compPR);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hdr.tex); setUniform(compPR.U, 'uSrc', 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bloomChain[0] ? bloomChain[0].tex : hdr.tex); setUniform(compPR.U, 'uBloom', 1);
  const U = compPR.U;
  setUniform(U, 'uTexel', [1 / cv.width, 1 / cv.height]);
  setUniform(U, 'uBloomStr', levels ? post.bloom / Math.max(1, levels * 0.5) : 0);
  setUniform(U, 'uExposure', post.exposure); setUniform(U, 'uVignette', post.vignette); setUniform(U, 'uGrain', post.grain);
  setUniform(U, 'uAberr', post.aberration); setUniform(U, 'uTint', post.tint); setUniform(U, 'uLift', post.lift); setUniform(U, 'uSat', post.saturation);
  setUniform(U, 'uTime', simT); setUniform(U, 'uHyper', hyper.amount); setUniform(U, 'uHyperPhase', hyper.phase); setUniform(U, 'uSeedF', (seed % 997) * 0.013);
  const a = cv.width / cv.height; setUniform(U, 'uAspect', a > 1 ? [a, 1] : [1, 1 / a]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* ======================================================================
   Helpers handed to scenes
   ====================================================================== */
// Ships that wander, keep a margin from icons (sharp distance field), and wrap around the screen edges.
// opts: {count, speed (CSS px/s), turn (rad/s), margin (CSS px from icon edge), wander (0..1), leaders / formation, avoidBlob (use blob field), bounds pad}
class Flock {
  constructor(opts = {}) {
    this.o = Object.assign({ count: 8, speed: 120, turn: 1.6, margin: 40, wander: 0.6, pad: 120, formation: 0, spacing: 34, avoidBlob: false, seedK: 1 }, opts);
    this.agents = []; this.rng = mulberry32(seed * 31 + this.o.seedK * 977);
    this.resize(this.o.count);
  }
  spawn(a, edge) {
    const r = this.rng, Wc = W, Hc = H, pad = this.o.pad;
    if (edge) {
      const side = (r() * 4) | 0;
      a.x = side === 0 ? -pad * 0.8 : side === 1 ? Wc + pad * 0.8 : r() * Wc;
      a.y = side === 2 ? -pad * 0.8 : side === 3 ? Hc + pad * 0.8 : r() * Hc;
      a.ang = Math.atan2(Hc / 2 - a.y + (r() - .5) * Hc * .6, Wc / 2 - a.x + (r() - .5) * Wc * .6);
    } else { a.x = r() * Wc; a.y = r() * Hc; a.ang = r() * Math.PI * 2; }
    a.base = a.ang;
    a.spd = this.o.speed * (0.8 + r() * 0.4); a.ph = r() * 100; a.age = 0; a.id = (r() * 1e9) | 0;
  }
  resize(n) {
    while (this.agents.length < n) { const a = {}; this.spawn(a, false); this.agents.push(a); }
    this.agents.length = n;
    const f = this.o.formation;
    this.agents.forEach((a, i) => { a.leader = f > 0 && i % (f + 1) !== 0 ? this.agents[i - (i % (f + 1))] : null; a.slot = i % (f + 1); });
  }
  update(dt, t) {
    const o = this.o, field = o.avoidBlob ? blobAt : distAt, pad = o.pad;
    for (const a of this.agents) {
      a.age += dt;
      let want;
      if (a.leader) {
        const L = a.leader, side = (a.slot % 2 ? 1 : -1) * Math.ceil(a.slot / 2);
        const bx = L.x - Math.cos(L.ang) * o.spacing * Math.abs(side) * 0.9 - Math.sin(L.ang) * o.spacing * side;
        const by = L.y - Math.sin(L.ang) * o.spacing * Math.abs(side) * 0.9 + Math.cos(L.ang) * o.spacing * side;
        want = Math.atan2(by - a.y, bx - a.x);
        const dist = Math.hypot(bx - a.x, by - a.y);
        a.spd = mix(a.spd, L.spd * clamp(0.7 + dist / (o.spacing * 2), 0.6, 1.6), dt * 3);
        if (dist > o.spacing * 8) { a.x = bx; a.y = by; a.ang = L.ang; }
      } else {
        // Wander: a slowly drifting base heading plus a gentle weave. The base follows the actual heading a little,
        // so avoidance turns stick instead of being undone, and agents do not circle in place.
        if (a.base === undefined) a.base = a.ang;
        let back = a.ang - a.base; back = Math.atan2(Math.sin(back), Math.cos(back));
        a.base += (Math.sin(t * 0.11 + a.ph) * 0.3 + Math.sin(t * 0.047 + a.ph * 3.1) * 0.2) * o.wander * dt + back * Math.min(1, dt * 0.6);
        want = a.base + Math.sin(t * 0.37 + a.ph) * o.wander * 0.35;
        a.spd = mix(a.spd, o.speed * (0.85 + 0.3 * Math.sin(t * 0.2 + a.ph)), dt);
      }
      // Cursor: ships veer away from the pointer and speed up (the "Ships react to cursor" setting)
      if (Pointer.active && o.cursor !== false) {
        const px = a.x - Pointer.x, py = a.y - Pointer.y, pd = Math.hypot(px, py), R = o.cursorRadius || 170;
        if (pd < R) {
          const push = 1 - pd / R, away = Math.atan2(py, px);
          want = Math.atan2(Math.sin(want) * (1 - push) + Math.sin(away) * push * 2, Math.cos(want) * (1 - push) + Math.cos(away) * push * 2);
          a.spd = Math.min(a.spd * (1 + push * dt * 3), o.speed * 2.2);
          a.startled = Math.max(a.startled || 0, push);
        }
      }
      if (a.startled) a.startled = Math.max(0, a.startled - dt * 0.8);
      // Icon avoidance: look ahead, turn away along the field gradient
      const look = a.spd * 0.55, lx = a.x + Math.cos(a.ang) * look, ly = a.y + Math.sin(a.ang) * look;
      const dd = field(lx, ly);
      if (dd < o.margin && lx > -pad && ly > -pad && lx < W + pad && ly < H + pad) {
        const g = gradAt(lx, ly, field), ga = Math.atan2(g[1], g[0]);
        const push = clamp(1 - dd / o.margin, 0, 1);
        let da = ga - a.ang; da = Math.atan2(Math.sin(da), Math.cos(da));
        const tangent = a.ang + Math.sign(da || 1) * Math.PI * 0.5 * push;
        want = Math.atan2(Math.sin(tangent) + Math.sin(ga) * push, Math.cos(tangent) + Math.cos(ga) * push);
      }
      let d = want - a.ang; d = Math.atan2(Math.sin(d), Math.cos(d));
      const turn = o.turn * (a.leader ? 1.8 : 1) * dt;
      a.turnRate = clamp(d, -turn, turn) / Math.max(dt, 1e-4);
      a.ang += clamp(d, -turn, turn);
      a.x += Math.cos(a.ang) * a.spd * dt; a.y += Math.sin(a.ang) * a.spd * dt;
      if (!a.leader && (a.x < -pad || a.y < -pad || a.x > W + pad || a.y > H + pad)) this.spawn(a, true);
    }
  }
}
// Blaster bolts: travel in straight lines, die on icons? No: they stop where they hit open ground and leave a flash.
// spawn(x, y, ang, {speed, len, color, intensity, life, width})
class Bolts {
  constructor() { this.list = []; this.sparks = []; }
  fire(x, y, ang, o = {}) {
    this.list.push({ x, y, vx: Math.cos(ang) * (o.speed || 900), vy: Math.sin(ang) * (o.speed || 900), len: o.len || 26, color: o.color || [1, 0.15, 0.1],
      intensity: o.intensity || 6, life: o.life || 0.9, age: 0, width: o.width || 2.6, hit: o.hit !== false });
  }
  update(dt) {
    for (const b of this.list) {
      b.age += dt; b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.age > b.life) { b.dead = true; if (b.hit) this.sparks.push({ x: b.x, y: b.y, age: 0, life: 0.35, color: b.color }); }
    }
    this.list = this.list.filter(b => !b.dead && b.x > -200 && b.y > -200 && b.x < W + 200 && b.y < H + 200);
    for (const s of this.sparks) s.age += dt;
    this.sparks = this.sparks.filter(s => s.age < s.life);
  }
  draw() {
    for (const b of this.list) {
      const sp = Math.hypot(b.vx, b.vy), ux = b.vx / sp, uy = b.vy / sp;
      glowLine(b.x - ux * b.len, b.y - uy * b.len, b.x, b.y, b.width * 2.2, b.color, b.intensity, { core: 1.3, coreR: 0.32 });
    }
    for (const s of this.sparks) {
      const k = 1 - s.age / s.life;
      glowDot(s.x, s.y, 4 + 16 * (1 - k), s.color, 5 * k * k, { core: k });
    }
  }
}

/* ======================================================================
   Environment: local time of day and live weather (ctx.env)
   Scenes read ctx.env every frame and work it into the scene itself (lighting, sky, rain on water, snow on trees...).
   Nothing is drawn as text or UI. All weather values ease toward their targets over ~15 s.
   Values (all 0..1 unless noted):
     timeActive   true when the scene follows the clock; false means the scene shows its designed time (scene.defaultHour)
     hour         local hour 0..24 (fractional)
     sunElev      sun elevation in degrees (-30 at deep night .. ~52 at noon)
     daylight     0 at night .. 1 in full day (smooth through twilight)
     dusk         peaks around sunrise/sunset (golden and blue hour)
     night        1 - daylight
     weatherActive true when live weather data is in use
     cloud        overcast amount beyond the scene's designed look
     rain, snow, fog, storm   precipitation and visibility (storm also means lightning)
     wind         0 calm .. 1 gale;  windDir  screen-space direction the wind blows toward, in radians (0 = +x, y down)
     lightning    0..1 flash envelope (also applied to the post-process automatically)
     temp         degrees C (if known)
   Test overrides: ?hour=21.5  ?wx=clear|cloudy|fog|rain|snow|storm  ?wind=0.8
   ====================================================================== */
const Env = (() => {
  // Time of day and live weather were removed: the scene always shows its designed look (defaultHour, clear sky).
  const state = { timeActive: false, hour: 14, sunElev: 45, daylight: 1, dusk: 0, night: 0, weatherActive: false,
    cloud: 0, rain: 0, snow: 0, fog: 0, storm: 0, wind: 0.3, windDir: -0.5, lightning: 0, temp: null, kind: 'clear', place: '' };
  function sunElevation(h) { return h >= 6.5 && h <= 18.5 ? 52 * Math.sin(Math.PI * (h - 6.5) / 12) : -30 * Math.sin(Math.PI * clamp(((h - 18.5 + 24) % 24) / 12, 0, 1)); }
  function update() {
    const sc = activeScene();
    state.hour = sc && sc.defaultHour != null ? sc.defaultHour : 14;
    state.sunElev = sunElevation(state.hour);
    state.daylight = sstep(-7, 6, state.sunElev);
    state.night = 1 - state.daylight;
    state.dusk = sstep(-12, -1, state.sunElev) * (1 - sstep(3, 16, state.sunElev));
  }
  return { state, update, refetch() { }, fetchNow() { } };
})();

/* ======================================================================
   Pointer: cursor position and double-click "fire" (ctx.pointer, scene.fire)
   In the wallpaper the host forwards them (it installs its mouse hook only after the page asks with "pointer|on").
   In the dev page they come from the mouse. Coordinates are CSS px.
   ctx.pointer: {x, y, over (cursor is on the desktop), active (setting on, over the desktop and moved in the last 6 s), vx, vy (CSS px/s)}
   A double-click on empty desktop calls scene.fire(ctx, x, y) when the "Double-click to fire" setting is on.
   ====================================================================== */
const Pointer = { x: -1e4, y: -1e4, over: false, lastMove: -1e9, vx: 0, vy: 0, _t: 0,
  get active() { return !!P.cursor && this.over && simT - this.lastMove < 6; } };
function pointerMoved(x, y, over) {
  const t = performance.now() / 1000, dt = Math.max(0.016, t - Pointer._t);
  if (over && Pointer.over) { Pointer.vx = mix(Pointer.vx, (x - Pointer.x) / dt, 0.5); Pointer.vy = mix(Pointer.vy, (y - Pointer.y) / dt, 0.5); }
  else { Pointer.vx = Pointer.vy = 0; }
  Pointer.x = x; Pointer.y = y; Pointer.over = over; Pointer._t = t;
  if (over) Pointer.lastMove = simT;
}
function fireAt(x, y) {
  if (!P.fire || distAt(x, y) < 4) return;            // Never on or right at an icon
  const sc = activeScene();
  if (sc && sc.fire) safe(() => sc.fire(ctx, x, y));
}
let pointerReq = null;
function syncPointerRequest() {
  if (!WALL) return;
  const want = !!(P.cursor || P.fire);
  if (want === pointerReq) return;
  pointerReq = want;
  const host = window.chrome && window.chrome.webview;
  if (host) host.postMessage(want ? 'pointer|on' : 'pointer|off');
}

/* ======================================================================
   Scene registry, activation and the hyperspace transition
   ====================================================================== */
const scenes = {};
let activeId = null, sceneT = 0, simT = 0, flowT = 0, introT0 = 0, intro = 0, sceneFailed = false;
const hyper = { amount: 0, phase: 0, t: -1, target: null };
const HYPER_IN = 0.75, HYPER_OUT = 1.1;
function safe(f) { try { return f(); } catch (e) { console.error('[galaxy] scene error', e); sceneFailed = true; } }
const activeScene = () => (activeId && !sceneFailed ? scenes[activeId] : null);
const wantedId = () => Object.keys(scenes)[0];

const ctx = {
  // Read-only state
  get gl() { return gl; }, get W() { return W; }, get H() { return H; },
  get pxW() { return cv.width; }, get pxH() { return cv.height; }, get scale() { return cv._scale; },
  get P() { return P; }, get icons() { return P.adaptive ? icons : []; }, get prevIcons() { return prevIcons; },
  get t() { return sceneT; }, get flow() { return flowT; }, get dt() { return ctx._dt; }, get rawDt() { return ctx._rawDt; },
  get intro() { return intro; }, get seed() { return seed; }, get morph() { return curMix; }, get fieldVersion() { return fieldVersion; },
  get fieldStable() { return curMix >= 1; }, get preview() { return PREVIEW; }, get wallpaper() { return WALL; },
  get quality() { return P.quality; }, get hdr() { return hdr; }, get atlas() { return atlas; }, get HALF_OK() { return HALF_OK; },
  get env() { return Env.state; }, get pointer() { return Pointer; },
  _dt: 0, _rawDt: 0,
  // Field samplers (CPU, CSS px)
  distAt, blobAt, gradAt,
  // Randomness
  rng: k => mulberry32(seed * 7919 + (k | 0) * 104729),
  hash: hash2,
  // GL helpers
  program: fullscreenProgram,
  linkProgram, makeTarget, freeTarget, setUniform,
  // Draw a fullscreen pass with program pr into the currently bound target. uniforms: {name: value}, textures: {name: texture}
  fullscreen(pr, uniforms = {}, textures = {}, target) {
    gl.useProgram(pr.p);
    if (target !== undefined) { gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : hdr.fb); gl.viewport(0, 0, target ? target.w : hdr.w, target ? target.h : hdr.h); }
    const U = pr.U, tw = target ? target.w : cv.width, th = target ? target.h : cv.height, sc = target ? target.w / W_css() : cv._scale;
    setUniform(U, 'uRes', [tw / sc, th / sc]); setUniform(U, 'uPx', [tw, th]); setUniform(U, 'uScale', sc);
    setUniform(U, 'uTime', sceneT); setUniform(U, 'uFlow', flowT); setUniform(U, 'uSeed', (seed % 997) * 0.37); setUniform(U, 'uIntro', intro);
    setUniform(U, 'uSigma', P.sigma); setUniform(U, 'uMix', curMix); setUniform(U, 'uGrid', [Gw, Gh]); setUniform(U, 'uStep', STEP);
    let unit = 0;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, ftex[fromI]); setUniform(U, 'uFA', unit++);
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, ftex[toI]); setUniform(U, 'uFB', unit++);
    for (const k in textures) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, textures[k]); setUniform(U, k, unit++); }
    for (const k in uniforms) setUniform(U, k, uniforms[k]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  },
  // Bind a scene-owned target (or null for the main HDR target) for subsequent fullscreen() / flush() draws
  bindTarget(t) { gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : hdr.fb); gl.viewport(0, 0, t ? t.w : hdr.w, t ? t.h : hdr.h); },
  sprite, glowLine, glowDot,
  flush: flushQueue,
  // Assets: textures for shaders (pass in the textures map of fullscreen()), images for atlas sprites (atlas.define opts.image)
  loadTexture, loadImage,
  get assetsReady() { return !pending.size; },
  Flock, Bolts,
  clamp, mix, sstep
};

function activate(id) {
  const old = activeScene();
  if (old && old.dispose) safe(() => old.dispose(ctx));
  activeId = id; sceneFailed = false;
  const sc = scenes[id];
  atlas.reset();
  if (!sc) { console.warn('[galaxy] scene not loaded: ' + id); return; }
  sceneT = 0; flowT = 0; introT0 = simT; intro = 0;
  safe(() => sc.init && sc.init(ctx));
  atlas.build();
  if (sc.resize) safe(() => sc.resize(ctx));
  if (sc.layout) safe(() => sc.layout(ctx));
  if (statsEl) statsEl.dataset.scene = id;
}
function requestScene() {
  const id = wantedId();
  if (id === activeId && hyper.t < 0) return;
  if (hyper.t >= 0) { hyper.target = id; return; }
  if (!activeId || !iconsSeen) { activate(id); return; }   // Before the first icons arrive (startup settings), switch without the jump
  hyper.t = 0; hyper.target = id;
}
function stepHyper(dt) {
  if (hyper.t < 0) return;
  hyper.t += dt;
  hyper.phase = hyper.t;
  if (hyper.t < HYPER_IN) hyper.amount = sstep(0, HYPER_IN, hyper.t);
  else {
    if (hyper.target && hyper.target !== activeId) activate(hyper.target);
    hyper.target = null;
    hyper.amount = 1 - sstep(HYPER_IN, HYPER_IN + HYPER_OUT, hyper.t);
    if (hyper.t > HYPER_IN + HYPER_OUT) { hyper.t = -1; hyper.amount = 0; }
  }
}

/* ======================================================================
   Frame loop
   ====================================================================== */
let lastT = 0, fpsEMA = 0, frameMs = 0;
function resize() {
  W = innerWidth; H = innerHeight;
  const dpr = devicePixelRatio || 1;
  const scale = PREVIEW ? Math.min(dpr, 0.6) : P.quality >= 1 ? Math.min(dpr, 2) : Math.min(dpr, 1);
  const box = cv.getBoundingClientRect();
  cv.width = Math.max(2, Math.round((box.width || W) * scale)); cv.height = Math.max(2, Math.round((box.height || H) * scale)); cv._scale = scale;
  Gw = Math.ceil(W / STEP) + 2; Gh = Math.ceil(H / STEP) + 2;
  allocField();
  refresh();
}
function update(rawDt) {
  ctx._rawDt = rawDt;
  ctx._dt = rawDt * P.flow;
  simT += rawDt; sceneT += rawDt; flowT += rawDt * P.flow;
  const e = Math.min((performance.now() - morphT0) / morphDur, 1);
  curMix = e < 0.5 ? 2 * e * e : 1 - Math.pow(-2 * e + 2, 2) / 2;
  if (iconsSeen) intro = sstep(0, 2.6, simT - introT0);
  Env.update(rawDt);
  stepHyper(rawDt);
  const sc = activeScene();
  if (sc && sc.update) safe(() => sc.update(ctx));
}
function draw(now) {
  if (!gl) return;
  const t0 = performance.now();
  if (ensureTargets()) { const sc = activeScene(); if (sc && sc.resize) safe(() => sc.resize(ctx)); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fb);
  gl.viewport(0, 0, hdr.w, hdr.h);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const sc = activeScene();
  if (sc && sc.render) { safe(() => sc.render(ctx)); }
  ctx.bindTarget(null);
  flushQueue();
  postProcess();
  cacheOK = true;
  frameMs = frameMs * 0.9 + (performance.now() - t0) * 0.1;
}
function frame(now) {
  requestAnimationFrame(frame);
  if (paused) { lastT = 0; return; }
  // Follow viewport changes right away (the debounced resize handler also re-lays out the dev sample icons)
  if (innerWidth !== W || innerHeight !== H) resize();
  const minGap = P.fps >= 1 ? 0 : 32;
  if (minGap && lastT && now - lastT < minGap) return;
  const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 1 / 60;
  if (lastT) fpsEMA = fpsEMA ? fpsEMA * 0.92 + (1 / dt) * 0.08 : 1 / dt;
  lastT = now;
  update(dt);
  draw(now);
  if (++frameN % 15 === 0) updateStats();
}

/* ======================================================================
   Settings
   ====================================================================== */
function applySettings(v) {
  if (typeof v.seed === 'number' && v.seed !== seed) { seed = v.seed; const id = activeId; if (id) { activeId = null; activate(id); } }
  let field = false, scene = false, res = false;
  for (const k of PARAM_KEYS) {
    if (!(k in v) || typeof v[k] !== typeof DEFAULTS[k] || P[k] === v[k]) continue;
    P[k] = v[k];
    if (k === 'sigma' || k === 'adaptive') field = true;
    if (k === 'quality') res = true;
    if (k === 'cursor' || k === 'fire') syncPointerRequest();
  }
  if (res) resize();
  else if (field) { if (P.adaptive !== undefined && v.adaptive !== undefined) commit(); else refresh(); }
  if (scene) requestScene();
  syncPanel();
}

/* ======================================================================
   Standalone dev mode: sample desktop with draggable icons and a control panel
   ====================================================================== */
const statsEl = document.getElementById('stats');
const ghostsEl = document.getElementById('ghosts');
function sampleLayout(kind) {
  const list = [], dh = H - TASKBAR, rows = Math.max(1, Math.floor((dh - GRID_Y0) / CELL_H));
  const cell = (c, r) => list.push({ x: GRID_X0 + c * CELL_W, y: GRID_Y0 + r * CELL_H, w: CELL_W, h: CELL_H });
  if (kind === 'none') return list;
  if (kind === 'sparse') { for (let r = 0; r < Math.min(4, rows); r++) cell(0, r); cell(9, 2); cell(14, 5); return list; }
  for (let c = 0; c < 3; c++) for (let r = 0; r < rows - 1; r++) cell(c, r);
  const cols = Math.floor((W - GRID_X0) / CELL_W);
  const extra = [[6, 0], [6, 1], [7, 3], [8, 3], [8, 4], [12, 1], [13, 1], [14, 1], [13, 2], [14, 2], [cols - 3, 0], [cols - 2, 0], [cols - 4, 5], [cols - 3, 5], [cols - 8, 7]];
  for (const [c, r] of extra) if (c >= 0 && c < cols && r < rows) cell(c, r);
  return list;
}
function drawGhosts() {
  if (!ghostsEl) return;
  ghostsEl.innerHTML = icons.map((ic, i) => `<div class="ghost" data-i="${i}" style="left:${ic.x}px;top:${ic.y}px;width:${ic.w}px;height:${ic.h}px"><i></i><b></b></div>`).join('');
}
function bindDevDrag() {
  let drag = null;
  ghostsEl.addEventListener('pointerdown', e => {
    const g = e.target.closest('.ghost'); if (!g) return;
    const ic = icons[+g.dataset.i]; drag = { ic, g, dx: e.clientX - ic.x, dy: e.clientY - ic.y };
    g.setPointerCapture(e.pointerId); g.classList.add('drag');
  });
  ghostsEl.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.ic.x = e.clientX - drag.dx; drag.ic.y = e.clientY - drag.dy;
    drag.g.style.left = drag.ic.x + 'px'; drag.g.style.top = drag.ic.y + 'px';
  });
  ghostsEl.addEventListener('pointerup', () => {
    if (!drag) return;
    const ic = drag.ic;
    ic.x = GRID_X0 + Math.round((ic.x - GRID_X0) / CELL_W) * CELL_W; ic.y = GRID_Y0 + Math.round((ic.y - GRID_Y0) / CELL_H) * CELL_H;
    drag.g.classList.remove('drag'); drag = null; drawGhosts(); commit();
  });
}
const SLIDER_DEFS = [
  { key: 'sigma', label: 'Distance from icons', min: 30, max: 180, step: 1, fmt: v => Math.round(v) + ' px' },
  { key: 'traffic', label: 'Ship traffic', min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' },
  { key: 'skirmish', label: 'Skirmishes', min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' },
  { key: 'flow', label: 'Speed', min: 0, max: 3, step: 0.05, fmt: v => '×' + v.toFixed(2) }
];
function buildPanel() {
  const panel = document.getElementById('panel'); if (!panel) return;
  const sl = document.getElementById('sliders');
  sl.innerHTML = SLIDER_DEFS.map(s => `<div class="slider"><div class="row"><span>${s.label}</span><span id="v-${s.key}"></span></div><input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}"></div>`).join('');
  sl.addEventListener('input', e => { const k = e.target.dataset.key; if (k) applySettings({ [k]: +e.target.value }); });
  document.getElementById('quality').addEventListener('change', e => applySettings({ quality: e.target.checked ? 1 : 0 }));
  document.getElementById('fps60').addEventListener('change', e => applySettings({ fps: e.target.checked ? 1 : 0 }));
  document.getElementById('btnSeed').addEventListener('click', () => applySettings({ seed: (Math.random() * 1e6) | 0 }));
  document.getElementById('btnLayout').addEventListener('click', () => { layoutIdx = (layoutIdx + 1) % 3; icons = sampleLayout(['mine', 'sparse', 'none'][layoutIdx]); drawGhosts(); commit(); });
  addEventListener('keydown', e => { if (e.key === 'h' || e.key === 'H') panel.classList.toggle('hidden'); });
  syncPanel();
}
let layoutIdx = 0;
function syncPanel() {
  if (!document.getElementById('sliders')) return;
  for (const s of SLIDER_DEFS) {
    const inp = document.querySelector(`#sliders input[data-key="${s.key}"]`); if (!inp) continue;
    inp.value = P[s.key]; document.getElementById('v-' + s.key).textContent = s.fmt(P[s.key]);
  }
  const q = document.getElementById('quality'); if (q) q.checked = P.quality >= 1;
  const f = document.getElementById('fps60'); if (f) f.checked = P.fps >= 1;
}
function updateStats() {
  if (!statsEl || WALL || PREVIEW) return;
  statsEl.innerHTML = `scene <span class="live">${activeId || '-'}</span>${sceneFailed ? ' <b style="color:#f66">error (see console)</b>' : ''}<br>` +
    `fps <span class="live">${fpsEMA.toFixed(0)}</span> · cpu ${frameMs.toFixed(1)} ms<br>` +
    `canvas ${cv.width}×${cv.height} @${cv._scale.toFixed(2)} · icons ${icons.length}`;
}

/* ======================================================================
   Hosted mode (wallpaper host or settings preview), same protocol as the other themes
   ====================================================================== */
let iconsSeen = !(WALL || PREVIEW);
function startHostedMode() {
  document.body.classList.add('wall');
  if (PREVIEW) document.body.classList.add('preview');
  icons = [];
  let first = true;
  const handle = m => {
    if (m.t === 'pause') { paused = PREVIEW ? false : !!m.v; if (paused && !first) draw(performance.now()); return; }
    if (m.t === 'settings') { applySettings(m.v || {}); syncPointerRequest(); return; }
    if (m.t === 'reset') { applySettings(Object.assign({}, DEFAULTS, m.v || {})); syncPointerRequest(); return; }
    if (m.t === 'pointer') { const k = window.devicePixelRatio || 1; pointerMoved(m.x / k, m.y / k, !!m.over); return; }
    if (m.t === 'fire') { const k = window.devicePixelRatio || 1; pointerMoved(m.x / k, m.y / k, true); fireAt(m.x / k, m.y / k); return; }
    if (m.t !== 'icons') return;
    const k = window.devicePixelRatio || 1;
    icons = m.vis ? m.r.map(([l, t, r, b]) => ({ x: l / k, y: t / k, w: (r - l) / k, h: (b - t) / k })) : [];
    if (PREVIEW) drawGhosts();
    if (!iconsSeen) { iconsSeen = true; introT0 = simT; }
    commit(first);
    first = false;
    if (paused) { update(0); draw(performance.now()); }
  };
  if (PREVIEW) {
    addEventListener('message', ev => { if (ev.source === parent) handle(typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data); });
    parent.postMessage(JSON.stringify({ t: 'ready' }), '*');
    return;
  }
  const host = window.chrome && window.chrome.webview;
  if (!host) return;
  host.addEventListener('message', ev => handle(JSON.parse(ev.data)));
  host.postMessage('ready');
}

/* ======================================================================
   Public API and boot
   ====================================================================== */
const Galaxy = {
  // Register a scene (a page loads exactly one). scene: {
  //   name,                        display name
  //   weather: false               optional: the scene ignores live weather (time of day still applies)
  //   post: {bloom, threshold, knee, exposure, vignette, grain, aberration, tint:[r,g,b], lift:[r,g,b], saturation, bloomRadius},
  //   init(ctx)      once per activation: compile programs (ctx.program), define sprites (ctx.atlas.define), create Flocks
  //   resize(ctx)    canvas size changed (reallocate scene targets sized from ctx.pxW / ctx.pxH)
  //   layout(ctx)    icon layout changed (a new field was committed; ctx.fieldStable turns true when the morph ends)
  //   update(ctx)    simulation step: ctx.dt (scaled by Speed), ctx.rawDt, ctx.t, ctx.flow
  //   render(ctx)    draw into the HDR target (already bound and cleared): ctx.fullscreen(...), ctx.sprite(...), ctx.glowLine(...), ctx.flush()
  //   dispose(ctx)   free GL objects
  // }
  register(id, scene) { scenes[id] = scene; },
  scenes, ctx, P,
  // Dev and test hooks
  activate, simulate(seconds, step = 1 / 30) { for (let s = 0; s < seconds; s += step) update(step); draw(performance.now()); }
};
window.Galaxy = Galaxy;

function boot() {
  if (!gl) return;
  initBatchers();
  initPost();
  // URL overrides for testing: ?scene=st-rebel&sigma=90&traffic=1&layout=sparse&advance=8&quality=1
  const sid = QS.get('scene');
  for (const k of PARAM_KEYS) if (QS.has(k) && k !== 'scene') P[k] = typeof DEFAULTS[k] === 'string' ? QS.get(k) : +QS.get(k);
  if (QS.has('seed')) seed = +QS.get('seed');
  resize();
  activate(wantedId());
  addEventListener('resize', () => { clearTimeout(boot._rt); boot._rt = setTimeout(() => { resize(); if (!WALL && !PREVIEW) { icons = sampleLayout(['mine', 'sparse', 'none'][layoutIdx]); drawGhosts(); refresh(); } }, 150); });
  if (WALL || PREVIEW) startHostedMode();
  else {
    document.body.classList.add('dev');
    layoutIdx = Math.max(0, ['mine', 'sparse', 'none'].indexOf(QS.get('layout') || 'mine'));
    icons = sampleLayout(['mine', 'sparse', 'none'][layoutIdx]);
    drawGhosts(); bindDevDrag(); buildPanel();
    // Dev page: the real mouse drives the pointer; double-click on empty space fires
    const inPanel = e => e.target.closest && e.target.closest('#panel');
    addEventListener('mousemove', e => { if (!inPanel(e)) pointerMoved(e.clientX, e.clientY, e.clientY < H - TASKBAR); });
    document.addEventListener('mouseleave', () => pointerMoved(Pointer.x, Pointer.y, false));
    addEventListener('dblclick', e => { if (!inPanel(e) && !(e.target.closest && e.target.closest('.ghost'))) fireAt(e.clientX, e.clientY); });
    commit(true);
    if (QS.has('nopanel')) document.getElementById('panel').classList.add('hidden');
    if (QS.has('noghosts')) ghostsEl.style.display = 'none';
    whenAssetsReady(() => {
      // Test hooks: ?pointer=x,y puts the cursor there (CSS px); ?fireat=x,y&firet=0.5 double-clicks there after the advance
      const xy = s => (s || '').split(',').map(Number);
      if (QS.has('pointer')) { const [px, py] = xy(QS.get('pointer')); pointerMoved(px, py, true); }
      const adv = +QS.get('advance') || 0;
      if (adv > 0) { morphT0 = -1e9; Galaxy.simulate(adv); }
      if (QS.has('pointer')) { const [px, py] = xy(QS.get('pointer')); pointerMoved(px, py, true); }
      if (QS.has('fireat')) { const [fx, fy] = xy(QS.get('fireat')); fireAt(fx, fy); Galaxy.simulate(+QS.get('firet') || 0.5); }
      if (QS.has('perf')) perfRun(+QS.get('perf') || 120);
    });
  }
  requestAnimationFrame(frame);
}

/* ======================================================================
   Frame timing harness (?perf=N). Runs synchronously during boot (headless Edge closes the page soon after load):
   each sample is update + draw + a 1-pixel readPixels that waits for the GPU to finish, timed in real time.
   That is GPU time plus a small fixed overhead, which is fine for comparing scenes and versions.
   Prints "[perf] steady ..." over N frames, then moves one icon and prints "[perf] morph ..." for the ~1.7 s morph.
   Run at 3840x2160 for budget comparisons. Results go to console.warn.
   ====================================================================== */
function perfRun(N) {
  const px = new Uint8Array(4);
  const one = () => { update(1 / 60); const t0 = performance.now(); draw(t0); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return performance.now() - t0; };
  for (let i = 0; i < 20; i++) one();                      // warm up: shader compiles, caches, driver
  const steady = [];
  for (let i = 0; i < N; i++) steady.push(one());
  report('steady', steady);
  if (icons.length) { const ic = icons[Math.min(icons.length - 1, 4)]; ic.x += CELL_W * 3; ic.y += CELL_H; drawGhosts(); commit(); }
  const morph = [], t0 = performance.now();
  while (performance.now() - t0 < morphDur + 150 && morph.length < 2000) morph.push(one());
  report('morph', morph);
  function report(name, a) {
    if (!a.length) { console.warn('[perf] ' + name + ' no samples'); return; }
    const s = a.slice().sort((x, y) => x - y), avg = a.reduce((x, y) => x + y, 0) / a.length;
    console.warn(`[perf] ${name} scene=${activeId} canvas=${cv.width}x${cv.height} n=${a.length} avg=${avg.toFixed(2)}ms p50=${s[s.length >> 1].toFixed(2)} p95=${s[Math.floor(s.length * 0.95)].toFixed(2)} max=${s[s.length - 1].toFixed(2)}`);
  }
}
