// OpenTally UI controller: canvas viewer, tools, panel, export.
import { CountSession } from './core/session.js';
import { markersToCSV, summaryToCSV } from './core/export.js';
import { detect } from './core/detect.js';
import { pointInPolygon } from './core/imageops.js';
import { samHealth, samCount, DEFAULT_SAM_URL } from './core/sam-client.js';
import { demoCanvas } from './demo.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const PRESETS = {
  generic: { mode: 'auto', sensitivity: 0, minSize: 0, splitTouching: true },
  pipes: { mode: 'auto', sensitivity: 0, minSize: 0, splitTouching: true },
  logs: { mode: 'light', sensitivity: 0, minSize: 0, splitTouching: true },
  rebar: { mode: 'auto', sensitivity: 4, minSize: 0, splitTouching: true },
  pills: { mode: 'auto', sensitivity: 0, minSize: 0, splitTouching: true },
  cells: { mode: 'auto', sensitivity: 0, minSize: 4, splitTouching: true },
  boards: { mode: 'auto', sensitivity: 0, minSize: 0, splitTouching: false },
};

const PRESET_HINTS = {
  pipes: 'Box one pipe end, rim to rim. For hollow pipes, try Local AI or box the whole end including the bore.',
  logs: 'Box one log end. Works best with light ends and dark gaps.',
  rebar: 'Shoot the bar ends square-on with a dark background behind.',
  pills: 'Spread pills on a contrasting tray. Box one pill.',
  cells: 'Box one typical colony; tiny specks are ignored.',
  boards: 'Board ends are counted one per shape; touching boards need visible gaps.',
};

const DEFAULT_SETTINGS = {
  engine: 'builtin', preset: 'generic', mode: 'auto', color: '#c03030', tolerance: 50, sensitivity: 0,
  minSize: 0, splitTouching: true, markSize: 9, showNumbers: false,
  samUrl: DEFAULT_SAM_URL, samText: '', samThreshold: 0.6,
};

const state = {
  session: new CountSession(),
  activeCat: null,
  tool: 'sample',
  image: null, // canvas holding the full-res photo
  imageData: null,
  fileName: 'photo',
  view: { s: 1, ox: 0, oy: 0 },
  roi: null, // closed polygon
  roiDraft: [],
  exemplar: null, // {x,y,w,h}
  drag: null,
  pointers: new Map(),
  spaceDown: false,
  hover: null,
  counted: false,
  busy: false,
  lastInfo: '',
  settings: loadSettings(),
};
state.activeCat = state.session.categories[0].id;

// ---------------------------------------------------------------- settings

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('opentally.settings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try { localStorage.setItem('opentally.settings', JSON.stringify(state.settings)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- worker

let worker = null;
let jobId = 0;
const pending = new Map();
try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
  };
  worker.onerror = () => { worker = null; };
} catch {
  worker = null;
}

function runDetect(options) {
  if (!worker) return Promise.resolve(detect(state.imageData, options));
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'detect', id, options });
  });
}

// ---------------------------------------------------------------- canvas

const canvas = $('#view');
const ctx = canvas.getContext('2d');
const stage = $('#stage');

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  render();
}
new ResizeObserver(resizeCanvas).observe(stage);

const toImage = (sx, sy) => ({ x: (sx - state.view.ox) / state.view.s, y: (sy - state.view.oy) / state.view.s });
const toScreen = (x, y) => ({ x: x * state.view.s + state.view.ox, y: y * state.view.s + state.view.oy });

function fit() {
  if (!state.image) return;
  const r = stage.getBoundingClientRect();
  const pad = 16;
  const s = Math.min((r.width - pad * 2) / state.image.width, (r.height - pad * 2) / state.image.height);
  state.view = { s, ox: (r.width - state.image.width * s) / 2, oy: (r.height - state.image.height * s) / 2 };
  render();
}

function zoomAt(sx, sy, factor) {
  const v = state.view;
  const s = Math.min(40, Math.max(0.02, v.s * factor));
  const p = toImage(sx, sy);
  v.ox = sx - p.x * s;
  v.oy = sy - p.y * s;
  v.s = s;
  render();
}

let frame = 0;
function render() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; draw(); });
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.image) return;
  const { s, ox, oy } = state.view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = s < 2;
  ctx.drawImage(state.image, ox, oy, state.image.width * s, state.image.height * s);

  // Region of interest: dim everything outside it.
  const poly = state.roi ?? (state.roiDraft.length ? state.roiDraft : null);
  if (state.roi) {
    const r = stage.getBoundingClientRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, r.width, r.height);
    state.roi.forEach((p, i) => { const q = toScreen(p.x, p.y); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fill('evenodd');
    ctx.restore();
  }
  if (poly) {
    ctx.save();
    ctx.beginPath();
    poly.forEach((p, i) => { const q = toScreen(p.x, p.y); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
    if (state.roi) ctx.closePath();
    else if (state.hover) { const q = toScreen(state.hover.x, state.hover.y); ctx.lineTo(q.x, q.y); }
    ctx.strokeStyle = '#ffd43b';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of poly) {
      const q = toScreen(p.x, p.y);
      ctx.fillStyle = '#ffd43b';
      ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // Markers.
  const size = state.settings.markSize;
  const numbers = state.settings.showNumbers;
  const perCat = new Map();
  ctx.font = `600 ${Math.max(9, size * 1.1)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const m of state.session.markers) {
    const cat = state.session.category(m.categoryId);
    if (!cat) continue;
    const n = (perCat.get(cat.id) ?? 0) + 1;
    perCat.set(cat.id, n);
    const q = toScreen(m.x, m.y);
    const dim = cat.id !== state.activeCat;
    ctx.globalAlpha = dim ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(q.x, q.y, size, 0, Math.PI * 2);
    ctx.fillStyle = cat.color;
    ctx.fill();
    ctx.lineWidth = m.source === 'manual' ? 3 : 1.5;
    ctx.strokeStyle = m.source === 'manual' ? '#fff' : 'rgba(255,255,255,.85)';
    ctx.stroke();
    if (numbers && size >= 6) {
      ctx.fillStyle = '#fff';
      ctx.fillText(String(n), q.x, q.y + 0.5);
    }
  }
  ctx.globalAlpha = 1;

  // Sample box (current drag or last used).
  const box = state.drag?.kind === 'box' ? state.drag.box : state.exemplar;
  if (box) {
    const a = toScreen(box.x, box.y);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(a.x, a.y, box.w * s, box.h * s);
    ctx.strokeStyle = '#ffd43b';
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(a.x, a.y, box.w * s, box.h * s);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- image loading

async function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return toast('That file is not an image.');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    setImage(img, file.name.replace(/\.[^.]+$/, '') || 'photo');
  } catch {
    toast('Could not open that image.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function setImage(source, name, keepSession = false) {
  const c = document.createElement('canvas');
  c.width = source.naturalWidth ?? source.width;
  c.height = source.naturalHeight ?? source.height;
  c.getContext('2d').drawImage(source, 0, 0);
  state.image = c;
  state.imageData = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  state.fileName = name;
  if (worker) worker.postMessage({ type: 'image', image: state.imageData });
  if (!keepSession) {
    const cats = state.session.categories.map((x) => ({ ...x }));
    state.session = new CountSession();
    state.session.categories = cats;
    state.roi = null;
    state.roiDraft = [];
    state.exemplar = null;
    state.counted = false;
    state.lastInfo = '';
  }
  $('#empty').hidden = true;
  setTool('sample');
  fit();
  updatePanel();
}

// ---------------------------------------------------------------- counting

async function count() {
  if (!state.image || state.busy) return;
  const st = state.settings;
  setBusy(true, st.engine === 'sam' ? 'Asking the local AI…' : 'Counting…');
  try {
    let result;
    if (st.engine === 'sam') {
      if (!state.exemplar && !st.samText.trim()) throw new Error('Draw a sample box or describe the item first.');
      const { blob, scale } = await imageBlob(1600);
      result = await samCount(st.samUrl, blob, {
        boxes: state.exemplar ? [state.exemplar] : [], text: st.samText.trim(), threshold: st.samThreshold, scale,
      });
      if (state.roi) result.objects = result.objects.filter((o) => pointInPolygon(o.x, o.y, state.roi));
      state.lastInfo = result.model ?? 'Local AI';
    } else {
      result = await runDetect(detectOptions());
      const bits = [];
      if (result.polarity === 'dark') bits.push('dark items');
      if (result.polarity === 'light') bits.push('light items');
      if (result.polarity === 'color') bits.push('colour match');
      if (result.objectSize) bits.push(`~${Math.round(result.objectSize)} px wide`);
      state.lastInfo = bits.join(' · ');
    }
    state.session.setAutoMarkers(result.objects, state.activeCat);
    state.counted = true;
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(false);
    updatePanel();
    render();
  }
}

function detectOptions() {
  const st = state.settings;
  const o = {
    mode: st.mode,
    sensitivity: st.sensitivity,
    splitTouching: st.splitTouching,
    exemplar: state.exemplar,
    roi: state.roi,
    colorTolerance: st.tolerance,
  };
  if (st.minSize > 0) o.minArea = Math.PI * (st.minSize / 2) ** 2;
  if (st.mode === 'color' && !state.exemplar) o.color = hexToRgb(st.color);
  return o;
}

let rerunTimer = 0;
function rerunSoon() {
  if (!state.counted || state.settings.engine !== 'builtin') return;
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(() => { if (state.settings.engine === 'builtin') count(); }, 250);
}

function imageBlob(maxDim) {
  const scale = Math.min(1, maxDim / Math.max(state.image.width, state.image.height));
  const c = document.createElement('canvas');
  c.width = Math.round(state.image.width * scale);
  c.height = Math.round(state.image.height * scale);
  c.getContext('2d').drawImage(state.image, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob((blob) => resolve({ blob, scale }), 'image/jpeg', 0.92));
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------- pointer input

function localPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.image) return;
  canvas.setPointerCapture(e.pointerId);
  const p = localPoint(e);
  state.pointers.set(e.pointerId, p);

  if (state.pointers.size === 2) {
    const [a, b] = [...state.pointers.values()];
    state.drag = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    return;
  }
  if (e.button === 2) {
    removeAt(p);
    return;
  }
  const pan = e.button === 1 || state.tool === 'pan' || state.spaceDown;
  if (pan) {
    state.drag = { kind: 'pan', last: p };
    stage.classList.add('panning');
    return;
  }
  const ip = toImage(p.x, p.y);
  if (state.tool === 'sample') state.drag = { kind: 'box', start: ip, box: { x: ip.x, y: ip.y, w: 0, h: 0 }, down: p };
  else state.drag = { kind: 'click', down: p };
});

canvas.addEventListener('pointermove', (e) => {
  const p = localPoint(e);
  if (state.pointers.has(e.pointerId)) state.pointers.set(e.pointerId, p);
  if (state.tool === 'region' && !state.roi) { state.hover = toImage(p.x, p.y); render(); }
  const d = state.drag;
  if (!d) return;
  if (d.kind === 'pinch' && state.pointers.size === 2) {
    const [a, b] = [...state.pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    state.view.ox += mid.x - d.mid.x;
    state.view.oy += mid.y - d.mid.y;
    zoomAt(mid.x, mid.y, dist / d.dist);
    d.dist = dist;
    d.mid = mid;
  } else if (d.kind === 'pan') {
    state.view.ox += p.x - d.last.x;
    state.view.oy += p.y - d.last.y;
    d.last = p;
    render();
  } else if (d.kind === 'box') {
    const ip = toImage(p.x, p.y);
    d.box = normBox(d.start, ip);
    render();
  }
});

function endPointer(e) {
  const p = localPoint(e);
  state.pointers.delete(e.pointerId);
  const d = state.drag;
  if (!d) return;
  if (d.kind === 'pinch') {
    if (state.pointers.size === 0) state.drag = null;
    return;
  }
  state.drag = null;
  stage.classList.remove('panning');
  if (e.type === 'pointercancel') { render(); return; }
  const moved = d.down && Math.hypot(p.x - d.down.x, p.y - d.down.y) > 5;

  if (d.kind === 'box') {
    const b = clampBox(d.box);
    if (moved && b.w * state.view.s >= 6 && b.h * state.view.s >= 6) {
      state.exemplar = b;
      updatePanel();
      count();
    } else {
      // A tap with the sample tool adds a mark: quick fix without switching tools.
      addAt(p);
    }
  } else if (d.kind === 'click' && !moved) {
    if (state.tool === 'add') addAt(p);
    else if (state.tool === 'remove') removeAt(p);
    else if (state.tool === 'region') regionClick(p);
  }
  render();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('dblclick', () => { if (state.tool === 'region') closeRegion(); });

canvas.addEventListener('wheel', (e) => {
  if (!state.image) return;
  e.preventDefault();
  const p = localPoint(e);
  zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
}, { passive: false });

function normBox(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function clampBox(b) {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  return { x, y, w: Math.min(state.image.width, b.x + b.w) - x, h: Math.min(state.image.height, b.y + b.h) - y };
}

function addAt(p) {
  const ip = toImage(p.x, p.y);
  if (ip.x < 0 || ip.y < 0 || ip.x > state.image.width || ip.y > state.image.height) return;
  state.session.addMarker(ip.x, ip.y, state.activeCat);
  updatePanel();
}

function removeAt(p) {
  const ip = toImage(p.x, p.y);
  const radius = Math.max(state.settings.markSize + 6, 14) / state.view.s;
  if (state.session.removeNearest(ip.x, ip.y, radius)) updatePanel();
  render();
}

function regionClick(p) {
  if (state.roi) { state.roi = null; state.roiDraft = []; }
  const first = state.roiDraft[0];
  if (first && state.roiDraft.length >= 3) {
    const q = toScreen(first.x, first.y);
    if (Math.hypot(q.x - p.x, q.y - p.y) < 12) return closeRegion();
  }
  state.roiDraft.push(toImage(p.x, p.y));
  updateHint();
}

function closeRegion() {
  if (state.roiDraft.length < 3) return;
  state.roi = state.roiDraft;
  state.roiDraft = [];
  state.hover = null;
  updatePanel();
  updateHint();
  rerunSoon();
  render();
}

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'range';
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
  if (typing || mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { state.spaceDown = true; stage.classList.add('panning'); e.preventDefault(); return; }
  const tools = { s: 'sample', a: 'add', r: 'remove', g: 'region' };
  if (tools[k]) setTool(tools[k]);
  else if (k === '0') fit();
  else if (k === 'enter' || k === 'd') count();
  else if (k === '+' || k === '=') zoomCentre(1.25);
  else if (k === '-') zoomCentre(0.8);
  else if (k === 'escape') {
    if (state.roiDraft.length) { state.roiDraft = []; state.hover = null; render(); }
    $('#export-menu').open = false;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { state.spaceDown = false; stage.classList.remove('panning'); }
});

function zoomCentre(f) {
  const r = stage.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, f);
}

function undo() { if (state.session.undo()) { ensureActiveCat(); updatePanel(); render(); } }
function redo() { if (state.session.redo()) { ensureActiveCat(); updatePanel(); render(); } }

function ensureActiveCat() {
  if (!state.session.category(state.activeCat)) state.activeCat = state.session.categories[0].id;
}

// ---------------------------------------------------------------- tools & panel

const TOOL_HINTS = {
  sample: 'Drag a box around one item to count all similar items. Tap to add a missed one.',
  add: 'Click to add a mark.',
  remove: 'Click a mark to remove it. Right-click works with any tool.',
  region: 'Click around the area to count. Click the first point or double-click to finish.',
  pan: 'Drag to move around. Scroll or pinch to zoom.',
};

function setTool(tool) {
  state.tool = tool;
  stage.dataset.tool = tool;
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  if (tool !== 'region' && state.roiDraft.length < 3) { state.roiDraft = []; state.hover = null; }
  updateHint();
  render();
}

function updateHint() {
  const h = $('#hint');
  if (!state.image) { h.hidden = true; return; }
  h.hidden = false;
  h.textContent = state.tool === 'region' && state.roiDraft.length >= 3
    ? 'Click the first point or double-click to close the region.'
    : TOOL_HINTS[state.tool];
}

function setBusy(on, text) {
  state.busy = on;
  $('#busy').hidden = !on;
  if (text) $('#busy-text').textContent = text;
  $('#count-btn').disabled = on || !state.image;
}

function updatePanel() {
  const s = state.session;
  $('#total').textContent = s.total();
  const cat = s.category(state.activeCat);
  $('#status').textContent = !state.image ? 'Open a photo to start.'
    : !state.counted && s.total() === 0 ? 'Draw a box around one item.'
    : [`${s.count(state.activeCat)} in ${cat?.name ?? ''}`, state.lastInfo].filter(Boolean).join(' · ');
  $('#undo-btn').disabled = !s.canUndo();
  $('#redo-btn').disabled = !s.canRedo();
  $('#count-btn').disabled = state.busy || !state.image;
  renderCats();
  renderChips();
}

function renderCats() {
  const ul = $('#cats');
  const focused = document.activeElement?.closest?.('.cat')?.dataset.id;
  ul.replaceChildren(...state.session.categories.map((c) => {
    const li = document.createElement('li');
    li.className = 'cat' + (c.id === state.activeCat ? ' active' : '');
    li.dataset.id = c.id;
    li.innerHTML = `<input type="color" aria-label="Colour"><input class="name" aria-label="Category name">
      <span class="n"></span><button class="del" aria-label="Delete category" title="Delete category">
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    const [color, name] = li.querySelectorAll('input');
    color.value = c.color;
    name.value = c.name;
    li.querySelector('.n').textContent = state.session.count(c.id);
    li.querySelector('.del').hidden = state.session.categories.length <= 1;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.del')) return;
      if (state.activeCat !== c.id) { state.activeCat = c.id; updatePanel(); render(); }
    });
    color.addEventListener('change', () => { state.session.setCategoryColor(c.id, color.value); updatePanel(); render(); });
    name.addEventListener('change', () => { state.session.renameCategory(c.id, name.value.trim() || c.name); updatePanel(); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    li.querySelector('.del').addEventListener('click', () => {
      const n = state.session.count(c.id);
      if (n && !confirm(`Delete “${c.name}” and its ${n} marks?`)) return;
      state.session.deleteCategory(c.id);
      ensureActiveCat();
      updatePanel();
      render();
    });
    return li;
  }));
  if (focused) ul.querySelector(`[data-id="${focused}"] .name`)?.focus();
}

function renderChips() {
  const chips = [];
  if (state.exemplar) chips.push(['Sample box', () => { state.exemplar = null; updatePanel(); render(); rerunSoon(); }]);
  if (state.roi) chips.push(['Region', () => { state.roi = null; updatePanel(); render(); rerunSoon(); }]);
  $('#chips').replaceChildren(...chips.map(([label, clear]) => {
    const el = document.createElement('span');
    el.className = 'chip';
    el.textContent = label;
    const b = document.createElement('button');
    b.textContent = '×';
    b.title = `Clear ${label.toLowerCase()}`;
    b.addEventListener('click', clear);
    el.append(b);
    return el;
  }));
}

function syncSettingsUI() {
  const st = state.settings;
  $$('[data-engine]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.engine === st.engine)));
  $$('.sam-only').forEach((el) => (el.hidden = st.engine !== 'sam'));
  $$('.builtin-only').forEach((el) => (el.hidden = st.engine === 'sam'));
  $('#preset').value = st.preset;
  $('#mode').value = st.mode;
  $('#color').value = st.color;
  $('#color').hidden = st.mode !== 'color';
  $('#tol-field').hidden = st.mode !== 'color';
  $('#tolerance').value = st.tolerance;
  $('#tol-out').textContent = st.tolerance;
  $('#sensitivity').value = st.sensitivity;
  $('#sens-out').textContent = st.sensitivity === 0 ? 'normal' : st.sensitivity > 0 ? `+${st.sensitivity}` : st.sensitivity;
  $('#min-size').value = st.minSize;
  $('#min-out').textContent = st.minSize ? `${st.minSize} px` : 'auto';
  $('#split').checked = st.splitTouching;
  $('#mark-size').value = st.markSize;
  $('#show-numbers').checked = st.showNumbers;
  $('#sam-text').value = st.samText;
  $('#sam-url').value = st.samUrl;
  $('#sam-threshold').value = st.samThreshold;
  $('#sam-threshold-out').textContent = Number(st.samThreshold).toFixed(2);
  const hint = st.engine === 'sam' ? null : PRESET_HINTS[st.preset];
  if (st.engine === 'builtin') $('#engine-help').textContent = hint ?? 'Fast and works anywhere. Best for round or blocky items on a contrasting background.';
}

function setSetting(key, value, { rerun = true } = {}) {
  state.settings[key] = value;
  if (['mode', 'sensitivity', 'minSize', 'splitTouching'].includes(key)) state.settings.preset = matchPreset();
  saveSettings();
  syncSettingsUI();
  render();
  if (rerun) rerunSoon();
}

function matchPreset() {
  const st = state.settings;
  const cur = PRESETS[st.preset];
  if (cur && Object.entries(cur).every(([k, v]) => st[k] === v)) return st.preset;
  const hit = Object.entries(PRESETS).find(([, p]) => Object.entries(p).every(([k, v]) => st[k] === v));
  return hit ? hit[0] : 'custom';
}

async function checkSam() {
  const help = $('#engine-help');
  help.textContent = 'Checking for the local AI backend…';
  const h = await samHealth(state.settings.samUrl);
  if (state.settings.engine !== 'sam') return;
  if (h.ok && h.ready) help.textContent = `Connected: ${h.model} on ${h.device}. Box one item, or type what to count. If similar but different items get counted, raise Confidence.`;
  else if (h.ok) help.textContent = `Backend running, but the model isn't ready: ${h.error}`;
  else help.textContent = 'Local AI backend not found. Start it with: python backend/sam3_server.py (see README).';
}

// ---------------------------------------------------------------- export

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportPNG() {
  const img = state.image;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const r = Math.max(5, Math.min(img.width, img.height) / 120);
  g.font = `700 ${r * 1.1}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const perCat = new Map();
  for (const m of state.session.markers) {
    const cat = state.session.category(m.categoryId);
    if (!cat) continue;
    const n = (perCat.get(cat.id) ?? 0) + 1;
    perCat.set(cat.id, n);
    g.beginPath();
    g.arc(m.x, m.y, r, 0, Math.PI * 2);
    g.fillStyle = cat.color;
    g.fill();
    g.lineWidth = Math.max(1.5, r / 5);
    g.strokeStyle = '#fff';
    g.stroke();
    g.fillStyle = '#fff';
    g.fillText(String(n), m.x, m.y + r * 0.05);
  }
  // Tally card in the corner.
  const lines = state.session.categories.filter((cat) => state.session.count(cat.id) > 0 || state.session.categories.length === 1);
  const fs = Math.max(14, img.width / 50);
  g.font = `700 ${fs}px system-ui, sans-serif`;
  g.textAlign = 'left';
  const rows = [...lines.map((cat) => [cat, `${cat.name}: ${state.session.count(cat.id)}`])];
  if (rows.length > 1) rows.push([null, `Total: ${state.session.total()}`]);
  const pad = fs * 0.6;
  const wMax = Math.max(...rows.map(([, t]) => g.measureText(t).width)) + fs * 1.6 + pad * 2;
  const hBox = rows.length * fs * 1.4 + pad * 1.2;
  g.fillStyle = 'rgba(0,0,0,.72)';
  g.fillRect(pad, pad, wMax, hBox);
  rows.forEach(([cat, text], i) => {
    const y = pad * 1.6 + fs * 0.7 + i * fs * 1.4;
    if (cat) {
      g.fillStyle = cat.color;
      g.beginPath(); g.arc(pad * 2 + fs * 0.4, y, fs * 0.4, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#fff';
    g.fillText(text, pad * 2 + fs * 1.2, y);
  });
  c.toBlob((b) => download(b, `${state.fileName}-count.png`), 'image/png');
}

function exportProject() {
  const project = {
    app: 'opentally', version: 1, fileName: state.fileName,
    session: state.session.toJSON(), roi: state.roi, exemplar: state.exemplar,
    image: state.image.toDataURL('image/jpeg', 0.92),
  };
  download(new Blob([JSON.stringify(project)], { type: 'application/json' }), `${state.fileName}.opentally.json`);
}

async function openProject(file) {
  try {
    const p = JSON.parse(await file.text());
    if (p.app !== 'opentally') throw new Error();
    const img = await loadImg(p.image);
    state.session = CountSession.fromJSON(p.session);
    state.activeCat = state.session.categories[0].id;
    state.roi = p.roi;
    state.roiDraft = [];
    state.exemplar = p.exemplar;
    state.counted = state.session.total() > 0;
    state.lastInfo = '';
    setImage(img, p.fileName || 'photo', true);
  } catch {
    toast('That is not an OpenTally project file.');
  }
}

$('#export-menu').addEventListener('click', (e) => {
  const kind = e.target.closest('[data-export]')?.dataset.export;
  if (!kind) return;
  $('#export-menu').open = false;
  if (!state.image) return toast('Open a photo first.');
  if (kind === 'png') exportPNG();
  if (kind === 'summary') download(new Blob([summaryToCSV(state.session)], { type: 'text/csv' }), `${state.fileName}-summary.csv`);
  if (kind === 'markers') download(new Blob([markersToCSV(state.session)], { type: 'text/csv' }), `${state.fileName}-marks.csv`);
  if (kind === 'project') exportProject();
});
document.addEventListener('click', (e) => {
  const m = $('#export-menu');
  if (m.open && !m.contains(e.target)) m.open = false;
});

// ---------------------------------------------------------------- toasts

let toastTimer = 0;
function toast(msg, ms = 4000) {
  const h = $('#hint');
  h.hidden = false;
  h.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(updateHint, ms);
}

// ---------------------------------------------------------------- wiring

for (const id of ['#file-input', '#file-input-2', '#camera-input']) {
  $(id).addEventListener('change', (e) => { loadImageFile(e.target.files[0]); e.target.value = ''; });
}
$('#project-input').addEventListener('change', (e) => {
  $('#export-menu').open = false;
  if (e.target.files[0]) openProject(e.target.files[0]);
  e.target.value = '';
});
$('#demo-btn').addEventListener('click', () => {
  const c = demoCanvas();
  setImage(c, 'sample-pipes');
  toast(`Generated example: ${c.truth.length} pipes. Draw a box around one.`, 8000);
});

// Credited example photos (examples/ATTRIBUTION.md), with their known answers.
fetch(new URL('../examples/examples.json', import.meta.url))
  .then((r) => (r.ok ? r.json() : []))
  .then((list) => {
    $('#example-list').replaceChildren(...list.map((ex) => {
      const b = document.createElement('button');
      b.className = 'chip-btn';
      b.textContent = ex.title;
      b.addEventListener('click', async () => {
        try {
          const img = await loadImg(new URL(`../examples/${ex.file}`, import.meta.url).href);
          setImage(img, ex.file.replace(/\.\w+$/, ''));
          const answers = Object.entries(ex.answers).map(([k, n]) => `${n} × ${k}`).join(', ');
          toast(`Answers: ${answers}. Image: MixCount (CC BY 4.0).`, 12000);
        } catch {
          toast('Could not load that example.');
        }
      });
      return b;
    }));
  })
  .catch(() => { /* examples are optional */ });

let dragDepth = 0;
stage.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; });
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const f = e.dataTransfer.files[0];
  if (f?.name.endsWith('.json')) openProject(f);
  else if (f) loadImageFile(f);
});
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (item) loadImageFile(item.getAsFile());
});

$$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#fit-btn').addEventListener('click', fit);
$('#undo-btn').addEventListener('click', undo);
$('#redo-btn').addEventListener('click', redo);
$('#count-btn').addEventListener('click', count);
$('#clear-auto').addEventListener('click', () => {
  state.session.setAutoMarkers([], state.activeCat);
  state.counted = false;
  updatePanel();
  render();
});
$('#add-cat').addEventListener('click', () => {
  state.activeCat = state.session.addCategory(`Category ${state.session.categories.length + 1}`);
  updatePanel();
  render();
  $(`.cat[data-id="${state.activeCat}"] .name`)?.select();
});

$$('[data-engine]').forEach((b) => b.addEventListener('click', () => {
  setSetting('engine', b.dataset.engine, { rerun: false });
  if (b.dataset.engine === 'sam') checkSam();
}));
$('#preset').addEventListener('change', (e) => {
  state.settings.preset = e.target.value;
  Object.assign(state.settings, PRESETS[e.target.value]);
  saveSettings();
  syncSettingsUI();
  rerunSoon();
});
$('#mode').addEventListener('change', (e) => setSetting('mode', e.target.value));
$('#color').addEventListener('input', (e) => setSetting('color', e.target.value));
$('#tolerance').addEventListener('input', (e) => setSetting('tolerance', Number(e.target.value)));
$('#sensitivity').addEventListener('input', (e) => setSetting('sensitivity', Number(e.target.value)));
$('#min-size').addEventListener('input', (e) => setSetting('minSize', Number(e.target.value)));
$('#split').addEventListener('change', (e) => setSetting('splitTouching', e.target.checked));
$('#mark-size').addEventListener('input', (e) => setSetting('markSize', Number(e.target.value), { rerun: false }));
$('#show-numbers').addEventListener('change', (e) => setSetting('showNumbers', e.target.checked, { rerun: false }));
$('#sam-text').addEventListener('change', (e) => setSetting('samText', e.target.value, { rerun: false }));
$('#sam-url').addEventListener('change', (e) => { setSetting('samUrl', e.target.value.trim() || DEFAULT_SAM_URL, { rerun: false }); checkSam(); });
$('#sam-threshold').addEventListener('input', (e) => setSetting('samThreshold', Number(e.target.value), { rerun: false }));

window.addEventListener('beforeunload', (e) => {
  if (state.session.total() > 0) e.preventDefault();
});

syncSettingsUI();
updatePanel();
setTool('sample');
if (state.settings.engine === 'sam') checkSam();

// Exposed for debugging and browser tests.
window.opentally = { state, count, setImage, demoCanvas };
