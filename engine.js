// Pixel pipeline for snaplite. No DOM access, so it runs in the browser and in node.
//
// Geometry (rotate, straighten, crop) is done by the caller with a canvas, using
// frame() below for the maths. Then, per pixel:
// lens blur -> structure/sharpening -> ambience -> tone (white balance, brightness, contrast,
// shadows/highlights, fade, curves) -> saturation -> filter -> vignette -> grain.
(function (root) {
'use strict';

const IDENTITY = () => [[0, 0], [1, 1]];

// Filters are a saturation factor plus per-channel curves; vig/grain are added
// on top of the user's own vignette and grain, scaled by filter strength.
const FILTERS = [
  { id: 'none', name: 'None' },
  { id: 'gold', name: 'Gold', sat: 1.1, vig: 0.15, grain: 0.12,
    r: [[0, 0.02], [0.5, 0.56], [1, 1]], g: [[0, 0.01], [0.5, 0.52], [1, 0.97]], b: [[0, 0.04], [0.5, 0.44], [1, 0.86]] },
  { id: 'instant', name: 'Instant', sat: 0.85, vig: 0.25, grain: 0.08,
    r: [[0, 0.10], [0.25, 0.30], [0.75, 0.82], [1, 0.97]], g: [[0, 0.08], [0.5, 0.53], [1, 0.95]], b: [[0, 0.14], [0.5, 0.50], [1, 0.84]] },
  { id: 'seventies', name: 'Seventies', sat: 0.8, vig: 0.3, grain: 0.2,
    r: [[0, 0.12], [0.5, 0.60], [1, 0.98]], g: [[0, 0.08], [0.5, 0.52], [1, 0.90]], b: [[0, 0.10], [0.5, 0.40], [1, 0.72]] },
  { id: 'faded', name: 'Faded Print', sat: 0.6, vig: 0.1, grain: 0.15,
    r: [[0, 0.16], [0.5, 0.55], [1, 0.92]], g: [[0, 0.15], [0.5, 0.54], [1, 0.91]], b: [[0, 0.18], [0.5, 0.53], [1, 0.88]] },
  { id: 'disposable', name: 'Disposable', sat: 1.15, vig: 0.4, grain: 0.25,
    r: [[0, 0.03], [0.3, 0.27], [0.7, 0.80], [1, 1]], g: [[0, 0.04], [0.3, 0.29], [0.7, 0.78], [1, 0.99]], b: [[0, 0.08], [0.3, 0.30], [0.7, 0.72], [1, 0.93]] },
  { id: 'super8', name: 'Super 8', sat: 0.9, vig: 0.5, grain: 0.35,
    r: [[0, 0.08], [0.5, 0.58], [1, 1]], g: [[0, 0.05], [0.5, 0.50], [1, 0.93]], b: [[0, 0.02], [0.5, 0.38], [1, 0.78]] },
  { id: 'expired', name: 'Expired', sat: 0.75, vig: 0.2, grain: 0.3,
    r: [[0, 0.06], [0.5, 0.46], [1, 0.90]], g: [[0, 0.10], [0.5, 0.53], [1, 0.95]], b: [[0, 0.14], [0.5, 0.55], [1, 0.93]] },
  { id: 'cross', name: 'Cross Process', sat: 1.25, vig: 0.2, grain: 0.1,
    r: [[0, 0], [0.25, 0.18], [0.75, 0.86], [1, 1]], g: [[0, 0], [0.25, 0.22], [0.75, 0.84], [1, 0.98]], b: [[0, 0.12], [0.5, 0.46], [1, 0.80]] },
  { id: 'sepia', name: 'Sepia', sat: 0, vig: 0.3, grain: 0.2,
    r: [[0, 0.08], [0.5, 0.60], [1, 1]], g: [[0, 0.05], [0.5, 0.50], [1, 0.94]], b: [[0, 0.03], [0.5, 0.38], [1, 0.80]] },
  { id: 'noir', name: 'Noir', sat: 0, vig: 0.35, grain: 0.3,
    r: [[0, 0], [0.25, 0.16], [0.75, 0.86], [1, 1]], g: [[0, 0], [0.25, 0.16], [0.75, 0.86], [1, 1]], b: [[0, 0], [0.25, 0.16], [0.75, 0.86], [1, 1]] },
  { id: 'cyano', name: 'Cyanotype', sat: 0, vig: 0.2, grain: 0.15,
    r: [[0, 0.04], [0.5, 0.36], [1, 0.90]], g: [[0, 0.10], [0.5, 0.50], [1, 0.96]], b: [[0, 0.20], [0.5, 0.62], [1, 1]] },
];

function defaults() {
  return {
    // rot: quarter turns clockwise. angle: straighten, in degrees. crop is
    // normalised to the straightened frame (see frame()).
    geom: { rot: 0, flip: false, angle: 0, aspect: 'free', crop: { x: 0, y: 0, w: 1, h: 1 } },
    detail: { structure: 0, sharpening: 0 },
    basic: { brightness: 0, contrast: 0, saturation: 0, ambience: 0, highlights: 0, shadows: 0,
             warmth: 0, tint: 0, fade: 0, vignette: 0 },
    curves: { rgb: IDENTITY(), r: IDENTITY(), g: IDENTITY(), b: IDENTITY() },
    blur: { amount: 0, shape: 'radial', cx: 0.5, cy: 0.5, size: 30, transition: 30, angle: 0 },
    grain: { amount: 0, size: 30 },
    filter: { id: 'none', strength: 100 },
  };
}

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

// Monotone cubic (Fritsch-Carlson) through sorted [x, y] points in 0..1.
// Returns 256 samples in 0..1; flat outside the first and last point.
function curveLUT(pts) {
  const n = pts.length, lut = new Float32Array(256);
  if (n < 2) { lut.fill(n ? pts[0][1] : 0); return lut; }
  const dx = [], m = [], t = new Array(n);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = (pts[i + 1][0] - pts[i][0]) || 1e-6;
    m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let seg = 0;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    if (x <= pts[0][0]) { lut[i] = clamp01(pts[0][1]); continue; }
    if (x >= pts[n - 1][0]) { lut[i] = clamp01(pts[n - 1][1]); continue; }
    while (x > pts[seg + 1][0]) seg++;
    const h = dx[seg], u = (x - pts[seg][0]) / h, u2 = u * u, u3 = u2 * u;
    lut[i] = clamp01((2 * u3 - 3 * u2 + 1) * pts[seg][1] + (u3 - 2 * u2 + u) * h * t[seg] +
                     (-2 * u3 + 3 * u2) * pts[seg + 1][1] + (u3 - u2) * h * t[seg + 1]);
  }
  return lut;
}

// Everything that is a pure per-channel function, folded into one table per
// channel. Output values are 0..255.
function toneLUTs(st) {
  const b = st.basic;
  const warmth = b.warmth / 100, tint = b.tint / 100;
  const gains = [(1 + 0.2 * warmth) * (1 + 0.05 * tint), 1 - 0.15 * tint, (1 - 0.2 * warmth) * (1 + 0.05 * tint)];
  const gamma = Math.pow(2, -b.brightness / 100);
  const contrast = Math.pow(2, b.contrast / 100 * 1.2);
  const sh = b.shadows / 100, hi = b.highlights / 100, fade = b.fade / 100;
  // The asymmetric scales keep the shadow/highlight bumps monotone.
  const shK = sh * (sh > 0 ? 1.5 : 0.9), hiK = hi * (hi > 0 ? 0.9 : 1.5);
  const master = curveLUT(st.curves.rgb);
  const chans = [curveLUT(st.curves.r), curveLUT(st.curves.g), curveLUT(st.curves.b)];
  return chans.map((chan, c) => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      let x = clamp01(i / 255 * gains[c]);
      x = Math.pow(x, gamma);
      x = clamp01((x - 0.5) * contrast + 0.5);
      x += shK * x * (1 - x) * (1 - x);
      x += hiK * x * x * (1 - x);
      x = fade * 0.15 + x * (1 - fade * 0.25);
      x = master[Math.round(clamp01(x) * 255)];
      lut[i] = chan[Math.round(x * 255)] * 255;
    }
    return lut;
  });
}

function filterLUTs(f) {
  if (!f._lut) {
    f._lut = [f.r, f.g, f.b].map(pts => {
      const c = curveLUT(pts);
      for (let i = 0; i < 256; i++) c[i] *= 255;
      return c;
    });
  }
  return f._lut;
}

function boxH(src, dst, w, h, r) {
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = src[row] * (r + 1);
    for (let k = 1; k <= r; k++) sum += src[row + (k < w ? k : w - 1)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / win;
      const add = x + r + 1, sub = x - r;
      sum += src[row + (add < w ? add : w - 1)] - src[row + (sub > 0 ? sub : 0)];
    }
  }
}

function boxV(src, dst, w, h, r) {
  const win = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let sum = src[x] * (r + 1);
    for (let k = 1; k <= r; k++) sum += src[x + (k < h ? k : h - 1) * w];
    for (let y = 0; y < h; y++) {
      dst[x + y * w] = sum / win;
      const add = y + r + 1, sub = y - r;
      sum += src[x + (add < h ? add : h - 1) * w] - src[x + (sub > 0 ? sub : 0) * w];
    }
  }
}

// Repeated box blur approximates a gaussian; result ends up back in `a`.
function boxBlur(a, tmp, w, h, r, passes) {
  for (let i = 0; i < passes; i++) { boxH(a, tmp, w, h, r); boxV(tmp, a, w, h, r); }
}

// Focus region radii, in units of the image's shorter side.
function blurGeometry(b) {
  const inner = b.size / 100 * 0.6;
  return { inner, outer: inner + 0.02 + b.transition / 100 * 0.6 };
}

function lensBlur(src, w, h, b, out) {
  const n = w * h;
  if (!out || out.length !== n * 4) out = new Uint8ClampedArray(n * 4);
  const rad = Math.max(1, Math.round(b.amount / 100 * 0.02 * Math.max(w, h)));
  const { inner, outer } = blurGeometry(b);
  const S = Math.min(w, h), ang = b.angle * Math.PI / 180, sn = Math.sin(ang), cs = Math.cos(ang);
  const radial = b.shape === 'radial';
  const mask = new Uint8Array(n);
  for (let y = 0, p = 0; y < h; y++) {
    const py = (y + 0.5 - b.cy * h) / S;
    for (let x = 0; x < w; x++, p++) {
      const px = (x + 0.5 - b.cx * w) / S;
      const d = radial ? Math.sqrt(px * px + py * py) : Math.abs(py * cs - px * sn);
      const t = clamp01((d - inner) / (outer - inner));
      mask[p] = t * t * (3 - 2 * t) * 255;
    }
  }
  // Blurring squared values (roughly linear light) lets highlights bloom the
  // way they do through a real lens.
  const a = new Uint16Array(n), tmp = new Uint16Array(n);
  for (let c = 0; c < 3; c++) {
    for (let p = 0, i = c; p < n; p++, i += 4) a[p] = src[i] * src[i];
    boxBlur(a, tmp, w, h, rad, 3);
    for (let p = 0, i = c; p < n; p++, i += 4) {
      const m = mask[p], s = src[i];
      out[i] = m === 0 ? s : s + (Math.sqrt(a[p]) - s) * m / 255;
    }
  }
  for (let i = 3; i < n * 4; i += 4) out[i] = src[i];
  return out;
}

// Heavily blurred luminance, used by ambience to tell bright regions from dark.
function blurredLuma(src, w, h) {
  const n = w * h, a = new Uint16Array(n), tmp = new Uint16Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) a[p] = (0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) * 256;
  boxBlur(a, tmp, w, h, Math.max(1, Math.round(0.06 * Math.max(w, h))), 2);
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) out[p] = a[p] >> 8;
  return out;
}

// Luminance minus its blur at radius r, scaled by 64: the detail at that scale.
function detailMap(base, w, h, r) {
  const n = w * h, a = new Uint16Array(n), tmp = new Uint16Array(n), out = new Int16Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) out[p] = a[p] = (0.299 * base[i] + 0.587 * base[i + 1] + 0.114 * base[i + 2]) * 64;
  boxBlur(a, tmp, w, h, r, 2);
  for (let p = 0; p < n; p++) out[p] -= a[p];
  return out;
}

// Size of the image after quarter turns (W, H) and of the frame left after
// straightening (fw, fh): the largest upright rectangle of the same shape that
// fits inside the tilted image.
function frame(sw, sh, geom) {
  const W = geom.rot % 2 ? sh : sw, H = geom.rot % 2 ? sw : sh;
  const a = Math.abs(geom.angle) * Math.PI / 180;
  let k = 1;
  if (a > 0) {
    const c = Math.cos(a), s = Math.sin(a);
    // The last factor trims a pixel so no antialiased edge shows in the corners.
    k = Math.min(W / (W * c + H * s), H / (W * s + H * c)) * (1 - 2 / Math.min(W, H));
  }
  return { W, H, fw: W * k, fh: H * k };
}

// Grain cell size in pixels, proportional to the image so preview and export match.
function grainCell(size, w, h) {
  return Math.max(1, (0.4 + size / 100 * 2.6) * Math.max(w, h) / 1600);
}

function makeGrain(w, h, cell) {
  const out = new Int8Array(w * h);
  let s = 0x9e3779b9;
  const rnd = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const g = () => (rnd() + rnd() + rnd() - 1.5) * 84.6;
  if (cell <= 1.05) {
    for (let p = 0; p < out.length; p++) out[p] = g();
    return out;
  }
  const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2, grid = new Float32Array(gw * gh);
  // Interpolation averages the noise down, so overdrive the grid a little.
  for (let i = 0; i < grid.length; i++) grid[i] = g() * 1.4;
  for (let y = 0, p = 0; y < h; y++) {
    const fy = y / cell, y0 = fy | 0, ty = fy - y0;
    for (let x = 0; x < w; x++, p++) {
      const fx = x / cell, x0 = fx | 0, tx = fx - x0, q = y0 * gw + x0;
      const top = grid[q] + (grid[q + 1] - grid[q]) * tx;
      const bot = grid[q + gw] + (grid[q + gw + 1] - grid[q + gw]) * tx;
      const v = top + (bot - top) * ty;
      out[p] = v < -127 ? -127 : v > 127 ? 127 : v;
    }
  }
  return out;
}

const filterById = id => FILTERS.find(f => f.id === id) || FILTERS[0];

// Renders `state` applied to src (RGBA bytes) into out. `cache` is any object
// that lives as long as src does; it holds the expensive intermediate buffers.
// out may be the same array as src.
function process(src, w, h, st, cache, out) {
  const b = st.basic;
  const fl = filterById(st.filter.id), fk = fl.id === 'none' ? 0 : st.filter.strength / 100;

  const amb = b.ambience / 100;
  if (amb !== 0 && !cache.luma) cache.luma = blurredLuma(src, w, h);
  const luma = cache.luma, ambK = amb * 0.9 * 2 / 255;

  let base = src;
  if (st.blur.amount > 0) {
    const key = JSON.stringify(st.blur);
    if (cache.blurKey !== key) { cache.blurBuf = lensBlur(src, w, h, st.blur, cache.blurBuf); cache.blurKey = key; }
    base = cache.blurBuf;
  }

  const baseKey = base === src ? 'src' : cache.blurKey;
  const long = Math.max(w, h);
  let sharp = null, struct = null;
  if (st.detail.sharpening > 0) {
    if (cache.sharpKey !== baseKey) { cache.sharp = detailMap(base, w, h, Math.max(1, Math.round(long / 1600))); cache.sharpKey = baseKey; }
    sharp = cache.sharp;
  }
  if (st.detail.structure !== 0) {
    if (cache.structKey !== baseKey) { cache.struct = detailMap(base, w, h, Math.max(2, Math.round(long * 0.012))); cache.structKey = baseKey; }
    struct = cache.struct;
  }
  const sharpK = st.detail.sharpening / 100 * 1.5 / 64, structK = st.detail.structure / 100 / 64;

  const grainAmt = st.grain.amount / 100 + (fl.grain || 0) * fk;
  let noise = null;
  if (grainAmt > 0) {
    const cell = grainCell(st.grain.size, w, h), key = cell.toFixed(2);
    if (cache.grainKey !== key) { cache.grain = makeGrain(w, h, cell); cache.grainKey = key; }
    noise = cache.grain;
  }
  const grainK = grainAmt * 0.6;

  const [lr, lg, lb] = toneLUTs(st);
  const s = b.saturation / 100;
  const sat = Math.max(0, (1 + s) * (1 + 0.3 * amb));
  const filt = fk > 0;
  const [fr, fg, fb] = filt ? filterLUTs(fl) : [];
  const fsat = filt ? fl.sat : 1;

  const vig = b.vignette / 100 * 0.75 + (fl.vig || 0) * fk;
  const vx2 = new Float32Array(w);
  for (let x = 0; x < w; x++) { const v = (x + 0.5) / w * 2 - 1; vx2[x] = v * v; }

  for (let y = 0, p = 0, i = 0; y < h; y++) {
    const vy = (y + 0.5) / h * 2 - 1, vy2 = vy * vy;
    for (let x = 0; x < w; x++, p++, i += 4) {
      let r = base[i], g = base[i + 1], bl = base[i + 2];
      const alpha = base[i + 3];

      if (sharp || struct) {
        const d = (sharp ? sharp[p] * sharpK : 0) + (struct ? struct[p] * structK : 0);
        r += d; g += d; bl += d;
        r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; bl = bl < 0 ? 0 : bl > 255 ? 255 : bl;
      }

      if (amb !== 0) {
        // Lift where the neighbourhood is dark, pull down where it is bright.
        const d = (127.5 - luma[p]) / 255 * ambK;
        r += d * r * (255 - r); g += d * g * (255 - g); bl += d * bl * (255 - bl);
      }

      r = lr[(r + 0.5) | 0]; g = lg[(g + 0.5) | 0]; bl = lb[(bl + 0.5) | 0];

      if (sat !== 1) {
        const l = 0.299 * r + 0.587 * g + 0.114 * bl;
        r = l + (r - l) * sat; g = l + (g - l) * sat; bl = l + (bl - l) * sat;
      }

      if (filt) {
        let r2 = r, g2 = g, b2 = bl;
        if (fsat !== 1) {
          const l = 0.299 * r + 0.587 * g + 0.114 * bl;
          r2 = l + (r - l) * fsat; g2 = l + (g - l) * fsat; b2 = l + (bl - l) * fsat;
        }
        r2 = fr[r2 < 0 ? 0 : r2 > 255 ? 255 : (r2 + 0.5) | 0];
        g2 = fg[g2 < 0 ? 0 : g2 > 255 ? 255 : (g2 + 0.5) | 0];
        b2 = fb[b2 < 0 ? 0 : b2 > 255 ? 255 : (b2 + 0.5) | 0];
        r += (r2 - r) * fk; g += (g2 - g) * fk; bl += (b2 - bl) * fk;
      }

      if (vig !== 0) {
        const t = clamp01((vx2[x] + vy2 - 0.3) / 1.5);
        const m = 1 - vig * t * t * (3 - 2 * t);
        r *= m; g *= m; bl *= m;
      }

      if (noise) {
        // Strongest in the midtones, like film.
        const l = clamp01((0.299 * r + 0.587 * g + 0.114 * bl) / 255);
        const a = noise[p] * grainK * (0.35 + 2.6 * l * (1 - l));
        r += a; g += a; bl += a;
      }

      out[i] = r; out[i + 1] = g; out[i + 2] = bl; out[i + 3] = alpha;
    }
  }
  return out;
}

function histogram(src) {
  const hist = { rgb: new Uint32Array(256), r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256) };
  for (let i = 0; i < src.length; i += 4) {
    hist.r[src[i]]++; hist.g[src[i + 1]]++; hist.b[src[i + 2]]++;
    hist.rgb[(0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2] + 0.5) | 0]++;
  }
  return hist;
}

const Engine = { FILTERS, defaults, curveLUT, blurGeometry, frame, process, histogram };
if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
else root.Engine = Engine;
})(typeof self !== 'undefined' ? self : this);
