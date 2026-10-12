(function () {
'use strict';

const E = window.Engine;
const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Edits run live on a preview this size; export re-runs them at full resolution.
const PREVIEW_MAX = 1600;
const THUMB = 96;
const MIN_CROP = 0.05;
const LOOKS_KEY = 'snaplite.looks';

const stage = $('stage'), frame = $('frame'), view = $('view'), overlay = $('overlay');
const vctx = view.getContext('2d', { willReadFrequently: true }), octx = overlay.getContext('2d');

let state = E.defaults();
// source/name/w/h describe the opened file; pw/ph/src/cache/out/hist describe
// the preview buffer after geometry, and are replaced by build().
let img = null;
let comparing = false;
let cropping = false;  // crop mode: the view shows the uncropped frame
let pending = false;
let stale = 0;         // preview buffer needs rebuilding: 1 = quick, 2 = with thumbnails and histogram
const binders = [];    // functions that push `state` back into the controls
const history = { stack: [JSON.stringify(state)], i: 0 };

// ---------- geometry and rendering ----------

// Draws source rotated, straightened and cropped into canvas, sized so its
// long edge is at most maxEdge.
function drawGeometry(canvas, source, geom, maxEdge) {
  const f = E.frame(source.width, source.height, geom), c = geom.crop;
  const ow = c.w * f.fw, oh = c.h * f.fh, sc = Math.min(1, maxEdge / Math.max(ow, oh));
  canvas.width = Math.max(1, Math.round(ow * sc));
  canvas.height = Math.max(1, Math.round(oh * sc));
  const x = canvas.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.scale(sc, sc);
  x.translate(f.fw / 2 - c.x * f.fw, f.fh / 2 - c.y * f.fh);
  x.rotate(geom.angle * Math.PI / 180);
  x.scale(geom.flip ? -1 : 1, 1);
  x.rotate(geom.rot * Math.PI / 2);
  x.drawImage(source, -source.width / 2, -source.height / 2);
  x.setTransform(1, 0, 0, 1, 0, 0);
  return x;
}

function build(full) {
  const geom = cropping ? Object.assign({}, state.geom, { crop: { x: 0, y: 0, w: 1, h: 1 } }) : state.geom;
  drawGeometry(view, img.source, geom, PREVIEW_MAX);
  const pw = view.width, ph = view.height;
  overlay.width = pw;
  overlay.height = ph;
  Object.assign(img, { pw, ph, src: vctx.getImageData(0, 0, pw, ph).data, cache: {}, out: vctx.createImageData(pw, ph) });
  if (full || !img.hist) {
    img.hist = E.histogram(img.src);
    if (!cropping) drawThumbs();
    drawCurve();
  }
  fit();
}

function invalidate(full) {
  stale = Math.max(stale, full ? 2 : 1);
  schedule();
}

function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; renderNow(); });
}

function renderNow() {
  if (!img) return;
  if (stale) { build(stale === 2); stale = 0; }
  if (comparing) img.out.data.set(img.src);
  else E.process(img.src, img.pw, img.ph, state, img.cache, img.out.data);
  vctx.putImageData(img.out, 0, 0);
  if (cropping) drawOverlay();
}

function fit() {
  if (!img) return;
  const pad = 24;
  const k = Math.min((stage.clientWidth - pad * 2) / img.pw, (stage.clientHeight - pad * 2) / img.ph);
  frame.style.width = Math.round(img.pw * k) + 'px';
  frame.style.height = Math.round(img.ph * k) + 'px';
}

let statusTimer = 0;
function status(text, ms) {
  clearTimeout(statusTimer);
  $('status').textContent = text;
  $('status').hidden = !text;
  if (ms) statusTimer = setTimeout(() => { $('status').hidden = true; }, ms);
}

// ---------- history ----------

function commit() {
  const s = JSON.stringify(state);
  if (s === history.stack[history.i]) return;
  history.stack.length = history.i + 1;
  history.stack.push(s);
  if (history.stack.length > 200) history.stack.shift();
  history.i = history.stack.length - 1;
  syncButtons();
}

function applyState(next) {
  const before = JSON.stringify(state.geom);
  state = next;
  if (JSON.stringify(state.geom) !== before) invalidate(true);
  syncUI();
  schedule();
}

function travel(d) {
  const i = history.i + d;
  if (i < 0 || i >= history.stack.length) return;
  history.i = i;
  applyState(JSON.parse(history.stack[i]));
}

function syncButtons() {
  $('undo').disabled = history.i === 0;
  $('redo').disabled = history.i === history.stack.length - 1;
  for (const id of ['compare', 'reset', 'export', 'rot-l', 'rot-r', 'flip', 'aspect', 'crop-toggle', 'crop-reset', 'look-save']) {
    $(id).disabled = !img;
  }
}

function syncUI() {
  for (const sync of binders) sync();
  syncButtons();
}

// ---------- controls ----------

function slider(parent, label, group, key, min, max, step = 1) {
  const def = E.defaults()[group][key];
  const row = document.createElement('div');
  row.className = 'row';
  row.title = 'Double-click to reset';
  row.innerHTML = `<span class="name">${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
  const input = row.querySelector('input'), out = row.querySelector('output');
  const sync = () => {
    const v = state[group][key];
    input.value = v;
    out.textContent = v;
    row.classList.toggle('changed', v !== def);
  };
  const set = (v, done) => {
    state[group][key] = v;
    sync();
    if (group === 'blur') {
      frame.classList.toggle('focusable', state.blur.amount > 0);
      flashOverlay();
    }
    if (group === 'geom') invalidate(done);
    else schedule();
  };
  input.addEventListener('input', () => set(+input.value, false));
  input.addEventListener('change', () => { if (group === 'geom') invalidate(true); commit(); });
  row.addEventListener('dblclick', () => { set(def, true); commit(); });
  parent.appendChild(row);
  binders.push(sync);
  return row;
}

function buildControls() {
  slider($('geom'), 'Straighten', 'geom', 'angle', -20, 20, 0.1);

  const basics = $('basics');
  slider(basics, 'Brightness', 'basic', 'brightness', -100, 100);
  slider(basics, 'Contrast', 'basic', 'contrast', -100, 100);
  slider(basics, 'Saturation', 'basic', 'saturation', -100, 100);
  slider(basics, 'Ambience', 'basic', 'ambience', -100, 100);
  slider(basics, 'Highlights', 'basic', 'highlights', -100, 100);
  slider(basics, 'Shadows', 'basic', 'shadows', -100, 100);
  slider(basics, 'Warmth', 'basic', 'warmth', -100, 100);
  slider(basics, 'Tint', 'basic', 'tint', -100, 100);
  slider(basics, 'Fade', 'basic', 'fade', 0, 100);
  slider(basics, 'Vignette', 'basic', 'vignette', -100, 100);

  slider($('detail'), 'Structure', 'detail', 'structure', -100, 100);
  slider($('detail'), 'Sharpening', 'detail', 'sharpening', 0, 100);

  const blur = $('blur');
  slider(blur, 'Blur', 'blur', 'amount', 0, 100);
  slider(blur, 'Focus size', 'blur', 'size', 0, 100);
  slider(blur, 'Transition', 'blur', 'transition', 0, 100);
  const angle = slider(blur, 'Angle', 'blur', 'angle', -90, 90);

  const shapes = [...$('shapes').querySelectorAll('button')];
  for (const btn of shapes) {
    btn.addEventListener('click', () => {
      state.blur.shape = btn.dataset.shape;
      syncUI();
      flashOverlay();
      schedule();
      commit();
    });
  }
  binders.push(() => {
    for (const btn of shapes) btn.classList.toggle('on', btn.dataset.shape === state.blur.shape);
    angle.classList.toggle('off', state.blur.shape !== 'linear');
    frame.classList.toggle('focusable', state.blur.amount > 0);
  });
  $('sec-blur').addEventListener('toggle', e => { if (e.target.open) flashOverlay(); });

  slider($('grain'), 'Amount', 'grain', 'amount', 0, 100);
  slider($('grain'), 'Size', 'grain', 'size', 0, 100);

  slider($('filter-strength'), 'Strength', 'filter', 'strength', 0, 100);
  for (const f of E.FILTERS) {
    const btn = document.createElement('button');
    btn.innerHTML = `<canvas width="${THUMB}" height="${THUMB}"></canvas><span>${f.name}</span>`;
    btn.addEventListener('click', () => {
      state.filter.id = f.id;
      syncUI();
      schedule();
      commit();
    });
    binders.push(() => btn.classList.toggle('on', state.filter.id === f.id));
    f.thumb = btn.querySelector('canvas');
    $('filters').appendChild(btn);
  }
}

// Reads the freshly drawn (still unedited) preview off the view canvas.
function drawThumbs() {
  const c = document.createElement('canvas');
  c.width = c.height = THUMB;
  const x = c.getContext('2d');
  const side = Math.min(img.pw, img.ph);
  x.drawImage(view, (img.pw - side) / 2, (img.ph - side) / 2, side, side, 0, 0, THUMB, THUMB);
  const src = x.getImageData(0, 0, THUMB, THUMB);
  const out = x.createImageData(THUMB, THUMB);
  const cache = {};
  for (const f of E.FILTERS) {
    const st = E.defaults();
    st.filter.id = f.id;
    E.process(src.data, THUMB, THUMB, st, cache, out.data);
    f.thumb.getContext('2d').putImageData(out, 0, 0);
  }
}

// ---------- crop and rotate ----------

let cropDrag = null;   // { handle, start: crop at pointerdown, nx, ny }

const tidy = v => Math.round(clamp(v, 0, 1) * 1e6) / 1e6;
const tidyCrop = c => ({ x: tidy(c.x), y: tidy(c.y), w: tidy(c.w), h: tidy(c.h) });

// The locked crop ratio in normalised frame units (0 when free).
function lockedRatio() {
  const a = state.geom.aspect;
  if (a === 'free') return 0;
  if (a === 'orig') return 1;
  const [p, q] = a.split(':').map(Number), f = E.frame(img.w, img.h, state.geom);
  return p / q * f.fh / f.fw;
}

// Keeps the lens blur focus on the same part of the picture when the crop changes.
function remapFocus(from, to) {
  const b = state.blur;
  b.cx = clamp((from.x + b.cx * from.w - to.x) / to.w, 0, 1);
  b.cy = clamp((from.y + b.cy * from.h - to.y) / to.h, 0, 1);
}

function setCrop(next) {
  const prev = state.geom.crop;
  state.geom.crop = tidyCrop(next);
  remapFocus(prev, state.geom.crop);
}

function geomChanged() {
  invalidate(true);
  syncUI();
  commit();
}

function rotate(dir) {  // +1 = clockwise as seen on screen
  const g = state.geom, c = g.crop, b = state.blur;
  g.rot = (g.rot + (g.flip ? -dir : dir) + 4) % 4;
  g.crop = tidyCrop(dir > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w });
  [b.cx, b.cy] = dir > 0 ? [1 - b.cy, b.cx] : [b.cy, 1 - b.cx];
  b.angle = b.angle > 0 ? b.angle - 90 : b.angle + 90;
  geomChanged();
}

function flip() {
  const g = state.geom, b = state.blur;
  g.flip = !g.flip;
  g.angle = -g.angle;
  g.crop = tidyCrop(Object.assign({}, g.crop, { x: 1 - g.crop.x - g.crop.w }));
  b.cx = 1 - b.cx;
  b.angle = -b.angle;
  geomChanged();
}

function setCropping(on) {
  if (!img || cropping === on) return;
  cropping = on;
  overlay.classList.toggle('on', on);
  clearTimeout(overlayTimer);
  invalidate(true);
  syncUI();
}

// Shrinks the current crop to the chosen ratio around its centre.
function applyAspect() {
  const ratio = lockedRatio(), c = state.geom.crop;
  if (ratio) {
    const w = Math.min(c.w, c.h * ratio), h = w / ratio;
    setCrop({ x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h });
  }
}

function cropHandle(nx, ny, r) {
  const c = state.geom.crop, tx = 14 / r.width, ty = 14 / r.height;
  const x1 = c.x + c.w, y1 = c.y + c.h;
  if (nx < c.x - tx || nx > x1 + tx || ny < c.y - ty || ny > y1 + ty) return null;
  const h = { l: Math.abs(nx - c.x) < tx, r: Math.abs(nx - x1) < tx, t: Math.abs(ny - c.y) < ty, b: Math.abs(ny - y1) < ty };
  // On a very small box both sides are in reach; take the nearer one.
  if (h.l && h.r) { h.l = nx < c.x + c.w / 2; h.r = !h.l; }
  if (h.t && h.b) { h.t = ny < c.y + c.h / 2; h.b = !h.t; }
  h.move = !(h.l || h.r || h.t || h.b);
  return h;
}

function dragCrop(nx, ny) {
  const { handle: h, start: s } = cropDrag;
  let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
  if (h.move) {
    const dx = clamp(nx - cropDrag.nx, -s.x, 1 - x1), dy = clamp(ny - cropDrag.ny, -s.y, 1 - y1);
    x0 += dx; x1 += dx; y0 += dy; y1 += dy;
  } else {
    if (h.l) x0 = clamp(nx, 0, x1 - MIN_CROP);
    if (h.r) x1 = clamp(nx, x0 + MIN_CROP, 1);
    if (h.t) y0 = clamp(ny, 0, y1 - MIN_CROP);
    if (h.b) y1 = clamp(ny, y0 + MIN_CROP, 1);
    const ratio = lockedRatio();
    if (ratio) {
      let w = x1 - x0, hh = y1 - y0;
      if ((h.l || h.r) && (h.t || h.b)) {
        if (w / hh > ratio) w = hh * ratio; else hh = w / ratio;
        if (h.l) x0 = x1 - w; else x1 = x0 + w;
        if (h.t) y0 = y1 - hh; else y1 = y0 + hh;
      } else if (h.l || h.r) {
        // Dragging a side: the other dimension follows, centred, as far as it fits.
        const cy = s.y + s.h / 2, room = 2 * Math.min(cy, 1 - cy);
        hh = w / ratio;
        if (hh > room) { hh = room; w = hh * ratio; if (h.l) x0 = x1 - w; else x1 = x0 + w; }
        y0 = cy - hh / 2; y1 = cy + hh / 2;
      } else {
        const cx = s.x + s.w / 2, room = 2 * Math.min(cx, 1 - cx);
        w = hh * ratio;
        if (w > room) { w = room; hh = w / ratio; if (h.t) y0 = y1 - hh; else y1 = y0 + hh; }
        x0 = cx - w / 2; x1 = cx + w / 2;
      }
    }
  }
  state.geom.crop = tidyCrop({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  drawOverlay();
}

function drawCropOverlay() {
  const { pw: w, ph: h } = img, c = state.geom.crop;
  const x0 = c.x * w, y0 = c.y * h, cw = c.w * w, ch = c.h * h;
  const lw = Math.max(1.5, Math.max(w, h) / 500);
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, w, h);
  octx.fillStyle = '#000a';
  octx.fillRect(0, 0, w, y0);
  octx.fillRect(0, y0 + ch, w, h - y0 - ch);
  octx.fillRect(0, y0, x0, ch);
  octx.fillRect(x0 + cw, y0, w - x0 - cw, ch);
  octx.setLineDash([]);
  octx.strokeStyle = '#fff';
  octx.lineWidth = lw;
  octx.strokeRect(x0, y0, cw, ch);
  octx.globalAlpha = 0.4;
  octx.beginPath();
  for (const t of [1 / 3, 2 / 3]) {
    octx.moveTo(x0 + cw * t, y0); octx.lineTo(x0 + cw * t, y0 + ch);
    octx.moveTo(x0, y0 + ch * t); octx.lineTo(x0 + cw, y0 + ch * t);
  }
  octx.stroke();
  octx.globalAlpha = 1;
  // Corner brackets.
  const L = Math.min(cw, ch, Math.max(w, h) / 12) / 2;
  octx.lineWidth = lw * 3.5;
  octx.beginPath();
  for (const [px, sx] of [[x0, 1], [x0 + cw, -1]]) {
    for (const [py, sy] of [[y0, 1], [y0 + ch, -1]]) {
      octx.moveTo(px + sx * L, py); octx.lineTo(px, py); octx.lineTo(px, py + sy * L);
    }
  }
  octx.stroke();
}

function initCrop() {
  $('rot-l').addEventListener('click', () => rotate(-1));
  $('rot-r').addEventListener('click', () => rotate(1));
  $('flip').addEventListener('click', flip);
  $('crop-toggle').addEventListener('click', () => setCropping(!cropping));
  $('crop-reset').addEventListener('click', () => {
    state.geom.aspect = 'free';
    setCrop({ x: 0, y: 0, w: 1, h: 1 });
    geomChanged();
  });
  $('aspect').addEventListener('change', () => {
    state.geom.aspect = $('aspect').value;
    applyAspect();
    setCropping(true);
    geomChanged();
  });
  binders.push(() => {
    $('aspect').value = state.geom.aspect;
    $('crop-toggle').textContent = cropping ? 'Done' : 'Crop';
    $('crop-toggle').classList.toggle('on', cropping);
    frame.classList.toggle('cropping', cropping);
  });
}

// ---------- curves editor ----------

const curve = $('curve'), cctx = curve.getContext('2d');
const CHAN_COLOR = { rgb: '#e6e6e6', r: '#ff6b6b', g: '#62d27a', b: '#6aa0ff' };
let chan = 'rgb';
let dragPoint = -1;

function drawCurve() {
  const N = curve.width, c = cctx;
  c.clearRect(0, 0, N, N);

  c.strokeStyle = '#2a2d32';
  c.lineWidth = 1;
  c.beginPath();
  for (let i = 1; i < 4; i++) {
    const p = Math.round(N * i / 4) + 0.5;
    c.moveTo(p, 0); c.lineTo(p, N);
    c.moveTo(0, p); c.lineTo(N, p);
  }
  c.stroke();

  if (img && img.hist) {
    const h = img.hist[chan];
    let peak = 1;
    for (let i = 2; i < 254; i++) if (h[i] > peak) peak = h[i];
    c.fillStyle = chan === 'rgb' ? '#ffffff1c' : CHAN_COLOR[chan] + '30';
    c.beginPath();
    c.moveTo(0, N);
    for (let i = 0; i < 256; i++) c.lineTo(i / 255 * N, N - Math.min(1, h[i] / peak) * N * 0.9);
    c.lineTo(N, N);
    c.fill();
  }

  c.strokeStyle = '#3a3e45';
  c.beginPath(); c.moveTo(0, N); c.lineTo(N, 0); c.stroke();

  const stroke = (name, width, alpha) => {
    const lut = E.curveLUT(state.curves[name]);
    c.strokeStyle = CHAN_COLOR[name];
    c.globalAlpha = alpha;
    c.lineWidth = width;
    c.beginPath();
    for (let i = 0; i < 256; i++) c.lineTo(i / 255 * N, (1 - lut[i]) * N);
    c.stroke();
    c.globalAlpha = 1;
  };
  for (const name of ['rgb', 'r', 'g', 'b']) {
    const pts = state.curves[name];
    const edited = pts.length !== 2 || pts[0][0] !== 0 || pts[0][1] !== 0 || pts[1][0] !== 1 || pts[1][1] !== 1;
    if (name !== chan && edited) stroke(name, 2, 0.35);
  }
  stroke(chan, 3, 1);

  for (const [x, y] of state.curves[chan]) {
    c.beginPath();
    c.arc(x * N, (1 - y) * N, 9, 0, Math.PI * 2);
    c.fillStyle = '#141518';
    c.fill();
    c.strokeStyle = CHAN_COLOR[chan];
    c.lineWidth = 3;
    c.stroke();
  }
}

function curvePos(e) {
  const r = curve.getBoundingClientRect();
  return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)];
}

function nearestPoint(x, y) {
  let best = -1, bestD = 0.06;
  state.curves[chan].forEach((p, i) => {
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < bestD) { best = i; bestD = d; }
  });
  return best;
}

function removePoint(e) {
  e.preventDefault();
  const pts = state.curves[chan], i = nearestPoint(...curvePos(e));
  if (i < 0 || pts.length <= 2) return;
  pts.splice(i, 1);
  drawCurve();
  schedule();
  commit();
}

function initCurves() {
  const tabs = [...$('channels').querySelectorAll('[data-chan]')];
  for (const btn of tabs) btn.addEventListener('click', () => { chan = btn.dataset.chan; syncUI(); });
  binders.push(() => {
    for (const btn of tabs) btn.classList.toggle('on', btn.dataset.chan === chan);
    drawCurve();
  });
  $('curve-reset').addEventListener('click', () => {
    state.curves[chan] = E.defaults().curves[chan];
    drawCurve();
    schedule();
    commit();
  });

  curve.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const [x, y] = curvePos(e), pts = state.curves[chan];
    let i = nearestPoint(x, y);
    if (i < 0) {
      i = pts.findIndex(p => p[0] > x);
      if (i < 0) i = pts.length;
      pts.splice(i, 0, [x, y]);
    }
    dragPoint = i;
    curve.setPointerCapture(e.pointerId);
    drawCurve();
    schedule();
  });
  curve.addEventListener('pointermove', e => {
    if (dragPoint < 0) return;
    const [x, y] = curvePos(e), pts = state.curves[chan];
    const lo = dragPoint > 0 ? pts[dragPoint - 1][0] + 0.01 : 0;
    const hi = dragPoint < pts.length - 1 ? pts[dragPoint + 1][0] - 0.01 : 1;
    pts[dragPoint] = [clamp(x, lo, Math.max(lo, hi)), y];
    drawCurve();
    schedule();
  });
  const end = () => { if (dragPoint >= 0) { dragPoint = -1; commit(); } };
  curve.addEventListener('pointerup', end);
  curve.addEventListener('pointercancel', end);
  curve.addEventListener('dblclick', removePoint);
  curve.addEventListener('contextmenu', removePoint);
}

// ---------- overlay and dragging on the image ----------

let overlayTimer = 0;
let dragFocus = false;

function drawOverlay() {
  if (!img || !img.src) return;
  if (cropping) return drawCropOverlay();
  const { pw: w, ph: h } = img, b = state.blur, S = Math.min(w, h);
  const { inner, outer } = E.blurGeometry(b);
  const lw = Math.max(1.5, Math.max(w, h) / 500);
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, w, h);
  octx.translate(b.cx * w, b.cy * h);
  const shape = (rad, dash) => {
    octx.setLineDash(dash ? [lw * 4, lw * 4] : []);
    octx.beginPath();
    if (b.shape === 'radial') octx.arc(0, 0, rad * S, 0, Math.PI * 2);
    else for (const s of [-1, 1]) { octx.moveTo(-w - h, s * rad * S); octx.lineTo(w + h, s * rad * S); }
    octx.stroke();
  };
  if (b.shape === 'linear') octx.rotate(b.angle * Math.PI / 180);
  for (const [color, width] of [['#0008', lw * 2.5], ['#fff', lw]]) {
    octx.strokeStyle = octx.fillStyle = color;
    octx.lineWidth = width;
    shape(inner, false);
    shape(outer, true);
    octx.beginPath();
    octx.arc(0, 0, width * 2, 0, Math.PI * 2);
    octx.fill();
  }
}

function flashOverlay() {
  if (!img || cropping) return;
  drawOverlay();
  overlay.classList.add('on');
  clearTimeout(overlayTimer);
  if (!dragFocus) overlayTimer = setTimeout(() => overlay.classList.remove('on'), 1200);
}

function initImageDrag() {
  const pos = e => {
    const r = view.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1), r];
  };
  const focus = e => {
    [state.blur.cx, state.blur.cy] = pos(e);
    flashOverlay();
    schedule();
  };
  view.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (cropping) {
      const [nx, ny, r] = pos(e), handle = cropHandle(nx, ny, r);
      if (!handle) return;
      cropDrag = { handle, start: state.geom.crop, nx, ny };
      view.setPointerCapture(e.pointerId);
    } else if (state.blur.amount > 0) {
      dragFocus = true;
      view.setPointerCapture(e.pointerId);
      focus(e);
    }
  });
  view.addEventListener('pointermove', e => {
    if (cropDrag) dragCrop(...pos(e));
    else if (dragFocus) focus(e);
  });
  const end = () => {
    if (cropDrag) {
      remapFocus(cropDrag.start, state.geom.crop);
      cropDrag = null;
      commit();
    } else if (dragFocus) {
      dragFocus = false;
      flashOverlay();
      commit();
    }
  };
  view.addEventListener('pointerup', end);
  view.addEventListener('pointercancel', end);
}

// ---------- looks ----------

function loadLooks() {
  try { return JSON.parse(localStorage.getItem(LOOKS_KEY)) || []; } catch (err) { return []; }
}

function storeLooks(looks) {
  try {
    localStorage.setItem(LOOKS_KEY, JSON.stringify(looks));
  } catch (err) {
    status('This browser would not store the look', 4000);
  }
  drawLooks();
}

function applyLook(look) {
  if (!img) return;
  const next = E.defaults();
  for (const group in next) if (group !== 'geom' && look.state[group]) Object.assign(next[group], look.state[group]);
  next.geom = state.geom;
  applyState(next);
  commit();
}

function drawLooks() {
  const list = $('looks'), looks = loadLooks();
  list.textContent = '';
  looks.forEach((look, i) => {
    const row = document.createElement('div');
    const apply = document.createElement('button'), del = document.createElement('button');
    apply.className = 'apply';
    apply.textContent = look.name;
    apply.addEventListener('click', () => applyLook(look));
    del.textContent = '×';
    del.title = 'Delete this look';
    del.addEventListener('click', () => { looks.splice(i, 1); storeLooks(looks); });
    row.append(apply, del);
    list.appendChild(row);
  });
}

function saveLook() {
  if (!img) return;
  const looks = loadLooks(), input = $('look-name');
  const name = input.value.trim() || 'Look ' + (looks.length + 1);
  const saved = JSON.parse(JSON.stringify(state));
  delete saved.geom;
  const at = looks.findIndex(l => l.name === name);
  if (at >= 0) looks[at].state = saved; else looks.push({ name, state: saved });
  input.value = '';
  storeLooks(looks);
}

// ---------- open / export ----------

// source: anything drawImage accepts that has width/height (ImageBitmap, canvas).
function setSource(source, name) {
  if (img && img.source.close) img.source.close();
  img = { source, name, w: source.width, h: source.height };
  state = E.defaults();
  history.stack = [JSON.stringify(state)];
  history.i = 0;
  cropping = false;
  overlay.classList.remove('on');
  $('empty').hidden = true;
  frame.hidden = false;
  document.title = name + ' - snaplite';
  stale = 2;
  syncUI();
  renderNow();
  status(`${name}  ${img.w} x ${img.h}`, 2500);
}

async function openFile(file) {
  if (!file) return;
  try {
    setSource(await createImageBitmap(file), file.name || 'pasted.png');
  } catch (err) {
    status(`Could not open ${file.name || 'that file'} as an image`, 4000);
  }
}

async function exportImage() {
  if (!img) return;
  status('Exporting...');
  await new Promise(r => setTimeout(r, 30));  // let the status paint first
  try {
    const c = document.createElement('canvas');
    const x = drawGeometry(c, img.source, state.geom, Infinity);
    const d = x.getImageData(0, 0, c.width, c.height);
    E.process(d.data, c.width, c.height, state, {}, d.data);
    x.putImageData(d, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, 'image/' + $('format').value, $('quality').value / 100));
    if (!blob) throw new Error('the browser could not encode the image');
    // The browser falls back to PNG for formats it cannot encode.
    const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type] || 'png';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = img.name.replace(/\.[^.]+$/, '') + '-edit.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    status(`Exported ${a.download}  (${c.width} x ${c.height}, ${(blob.size / 1e6).toFixed(1)} MB)`, 4000);
  } catch (err) {
    status('Export failed: ' + err.message, 6000);
  }
}

// A synthetic test image, loaded by opening index.html?demo
function demoImage() {
  const c = document.createElement('canvas');
  c.width = 1500; c.height = 1000;
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, 1000);
  sky.addColorStop(0, '#27508c'); sky.addColorStop(0.55, '#f0b27a'); sky.addColorStop(0.56, '#2f5d50'); sky.addColorStop(1, '#0c1a16');
  x.fillStyle = sky;
  x.fillRect(0, 0, 1500, 1000);
  x.fillStyle = '#fff3c4';
  x.beginPath(); x.arc(1080, 380, 90, 0, 7); x.fill();
  for (let i = 0; i < 12; i++) {
    x.fillStyle = `hsl(${i * 30} 80% 55%)`;
    x.fillRect(90 + i * 112, 700, 88, 180);
  }
  for (let i = 0; i < 60; i++) {
    x.fillStyle = '#fff';
    x.fillRect((i * 397) % 1500, (i * 151) % 480, 4, 4);
  }
  return c;
}

// ---------- wiring ----------

function init() {
  buildControls();
  initCrop();
  initCurves();
  initImageDrag();
  drawLooks();
  syncUI();

  const file = $('file');
  const pick = () => file.click();
  $('open').addEventListener('click', pick);
  $('empty').addEventListener('click', pick);
  file.addEventListener('change', () => { openFile(file.files[0]); file.value = ''; });

  $('undo').addEventListener('click', () => travel(-1));
  $('redo').addEventListener('click', () => travel(1));
  $('reset').addEventListener('click', () => { applyState(E.defaults()); commit(); });
  $('export').addEventListener('click', exportImage);
  $('look-save').addEventListener('click', saveLook);
  $('look-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveLook(); });

  const format = $('format'), quality = $('quality');
  const syncQuality = () => {
    quality.disabled = format.value === 'png';
    $('quality-out').textContent = quality.disabled ? '' : quality.value;
  };
  format.addEventListener('change', syncQuality);
  quality.addEventListener('input', syncQuality);
  syncQuality();

  const compare = on => {
    if (comparing === on) return;
    comparing = on;
    schedule();
  };
  $('compare').addEventListener('pointerdown', () => compare(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('compare').addEventListener(ev, () => compare(false));

  window.addEventListener('keydown', e => {
    if (e.target.matches('input[type=text]')) return;
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (mod && key === 'o') { e.preventDefault(); pick(); }
    else if (mod && key === 's') { e.preventDefault(); exportImage(); }
    else if (mod && key === 'z') { e.preventDefault(); travel(e.shiftKey ? 1 : -1); }
    else if (mod && key === 'y') { e.preventDefault(); travel(1); }
    else if (e.key === '\\') compare(true);
  });
  window.addEventListener('keyup', e => { if (e.key === '\\') compare(false); });
  window.addEventListener('blur', () => compare(false));

  window.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('drag'); });
  window.addEventListener('dragleave', () => stage.classList.remove('drag'));
  window.addEventListener('drop', e => {
    e.preventDefault();
    stage.classList.remove('drag');
    openFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('paste', e => { if (!e.target.matches('input[type=text]')) openFile(e.clipboardData.files[0]); });

  new ResizeObserver(fit).observe(stage);

  if (new URLSearchParams(location.search).has('demo')) setSource(demoImage(), 'demo.png');
}

init();
})();
