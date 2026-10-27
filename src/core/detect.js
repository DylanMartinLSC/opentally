// Classic (non-ML) object counter: threshold -> clean -> label -> split
// touching objects with a distance-transform peak search.
//
// The optional `exemplar` box (one object the user drew a box around) replaces
// pre-built templates: it calibrates polarity, threshold, colour and size.

import {
  toGray, resize, boxBlur, otsu, borderMean, colorMask, pointInPolygon,
  morphOpen, labelComponents, distanceTransform,
} from './imageops.js';

export const DEFAULTS = {
  mode: 'auto', // 'auto' | 'dark' | 'light' | 'color'
  threshold: null, // 0-255, null = automatic (Otsu)
  sensitivity: 0, // shifts the automatic threshold, -100..100
  color: null, // [r,g,b] for colour mode
  colorTolerance: 50,
  blur: 1,
  minArea: null, // px at original scale; null = automatic
  maxArea: Infinity,
  splitTouching: true,
  objectSize: null, // expected diameter in px at original scale; null = automatic
  roi: null, // [{x,y}, ...] polygon in original coordinates
  exemplar: null, // {x, y, w, h} box around one example object
  maxSize: 1200, // longest side processed; larger photos are downscaled
};

/**
 * @returns {{count:number, objects:{x:number,y:number,r:number}[],
 *            threshold:number|null, polarity:string, scale:number, objectSize:number|null}}
 */
export function detect(img, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const longest = Math.max(img.width, img.height);
  const scale = longest > o.maxSize ? o.maxSize / longest : 1;
  const work = scale < 1 ? resize(img, scale) : img;
  const w = work.width, h = work.height;
  const ex = o.exemplar && scaleBox(o.exemplar, scale, w, h);

  let mask, threshold = null, polarity = o.mode;
  if (o.mode === 'color') {
    const color = o.color ?? (ex ? boxColor(work, ex) : null);
    if (!color) throw new Error('Colour mode needs a colour or an exemplar box');
    mask = colorMask(work, color, o.colorTolerance);
    polarity = 'color';
  } else {
    const gray = boxBlur(toGray(work), w, h, o.blur);
    let min = 255, max = 0;
    for (const v of gray) { if (v < min) min = v; if (v > max) max = v; }
    if (max - min < 16) return empty(scale);

    let objectsDark;
    if (ex) {
      const cal = calibrateFromExemplar(gray, w, h, ex);
      threshold = cal.threshold;
      objectsDark = cal.dark;
    } else {
      threshold = otsu(gray);
      objectsDark = borderMean(gray, w, h) > threshold;
    }
    if (o.mode === 'dark') objectsDark = true;
    if (o.mode === 'light') objectsDark = false;
    if (o.threshold != null) threshold = o.threshold;
    else threshold += (objectsDark ? 1 : -1) * o.sensitivity * 0.5;
    polarity = objectsDark ? 'dark' : 'light';

    mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = objectsDark ? (gray[i] <= threshold ? 1 : 0) : (gray[i] > threshold ? 1 : 0);
    }
  }

  mask = morphOpen(mask, w, h, 1);

  const { labels, blobs } = labelComponents(mask, w, h);
  const s2 = scale * scale;

  let expectedR = null;
  if (o.objectSize) expectedR = (o.objectSize * scale) / 2;
  else if (ex) expectedR = Math.min(ex.w, ex.h) / 2;

  const minArea = o.minArea != null ? o.minArea * s2
    : expectedR ? 0.25 * Math.PI * expectedR * expectedR
    : Math.max(4, 12 * s2);
  const maxArea = o.maxArea * s2;
  const keep = blobs.filter((b) => b.area >= minArea && b.area <= maxArea);
  if (keep.length === 0) return { ...empty(scale), threshold, polarity };

  const objects = [];
  if (!o.splitTouching) {
    for (const b of keep) objects.push(blobObject(b));
  } else {
    const dist = distanceTransform(mask, w, h);
    const maxD = blobMaxDistance(dist, labels, blobs.length);
    const rTyp = expectedR ?? median(keep.map((b) => maxD[b.id]));
    const keepIds = new Set(keep.map((b) => b.id));
    const peaks = findPeaks(dist, labels, w, h, keepIds, rTyp);
    for (const b of keep) {
      const p = peaks.get(b.id) ?? [];
      if (p.length <= 1) objects.push(blobObject(b));
      else for (const q of p) objects.push({ x: q.x, y: q.y, r: q.d });
    }
  }

  const inv = 1 / scale;
  let found = objects.map((ob) => ({ x: (ob.x + 0.5) * inv - 0.5, y: (ob.y + 0.5) * inv - 0.5, r: ob.r * inv }));
  // Detect on the whole photo, then keep items centred in the region, so items
  // cut by the region's edge are neither split nor counted as slivers.
  if (o.roi && o.roi.length >= 3) found = found.filter((ob) => pointInPolygon(ob.x, ob.y, o.roi));
  return {
    count: found.length,
    objects: found,
    threshold,
    polarity,
    scale,
    objectSize: expectedR ? (2 * expectedR) / scale : null,
  };
}

function empty(scale) {
  return { count: 0, objects: [], threshold: null, polarity: 'none', scale, objectSize: null };
}

function blobObject(b) {
  return { x: b.cx, y: b.cy, r: Math.sqrt(b.area / Math.PI) };
}

function scaleBox(b, s, w, h) {
  const x = Math.max(0, Math.round(Math.min(b.x, b.x + b.w) * s));
  const y = Math.max(0, Math.round(Math.min(b.y, b.y + b.h) * s));
  const bw = Math.min(w - x, Math.max(2, Math.round(Math.abs(b.w) * s)));
  const bh = Math.min(h - y, Math.max(2, Math.round(Math.abs(b.h) * s)));
  return { x, y, w: bw, h: bh };
}

/** Median colour of the centre half of the box. */
function boxColor(img, b) {
  const ch = [[], [], []];
  for (let y = b.y + b.h / 4; y < b.y + (3 * b.h) / 4; y++) {
    for (let x = b.x + b.w / 4; x < b.x + (3 * b.w) / 4; x++) {
      const i = ((y | 0) * img.width + (x | 0)) * 4;
      for (let c = 0; c < 3; c++) ch[c].push(img.data[i + c]);
    }
  }
  return ch.map(median);
}

/**
 * The object fills the box; the background surrounds it. Otsu on a region a
 * bit larger than the box separates the two, and the box centre tells us which
 * side of the threshold the object is on.
 */
function calibrateFromExemplar(gray, w, h, b) {
  const padX = Math.round(b.w * 0.35), padY = Math.round(b.h * 0.35);
  const x0 = Math.max(0, b.x - padX), x1 = Math.min(w, b.x + b.w + padX);
  const y0 = Math.max(0, b.y - padY), y1 = Math.min(h, b.y + b.h + padY);
  const region = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) region.push(gray[y * w + x]);
  const t = otsu(Uint8Array.from(region));
  const centre = [];
  for (let y = b.y + b.h / 3; y < b.y + (2 * b.h) / 3; y++) {
    for (let x = b.x + b.w / 3; x < b.x + (2 * b.w) / 3; x++) centre.push(gray[(y | 0) * w + (x | 0)]);
  }
  return { threshold: t, dark: median(centre) <= t };
}

function blobMaxDistance(dist, labels, n) {
  const m = new Float32Array(n + 1);
  for (let i = 0; i < dist.length; i++) {
    const l = labels[i];
    if (l && dist[i] > m[l]) m[l] = dist[i];
  }
  return m;
}

/**
 * Peaks of the distance map, one per object. A candidate is rejected when it
 * is closer than the typical radius to an accepted peak, or when the straight
 * path to an accepted peak never dips (a ridge in one elongated object, not a
 * neck between two touching ones).
 */
function findPeaks(dist, labels, w, h, keepIds, rTyp) {
  const minD = 0.4 * rTyp;
  const cands = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = dist[i];
      if (d < minD || !keepIds.has(labels[i])) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && dist[yy * w + xx] > d) { isMax = false; break; }
        }
      }
      if (isMax) cands.push({ x, y, d, l: labels[i] });
    }
  }
  cands.sort((a, b) => b.d - a.d);

  const byBlob = new Map();
  for (const c of cands) {
    const acc = byBlob.get(c.l) ?? [];
    let ok = true;
    for (const p of acc) {
      if (Math.hypot(p.x - c.x, p.y - c.y) < rTyp) { ok = false; break; }
      if (pathMin(dist, w, p, c) >= 0.8 * c.d) { ok = false; break; }
    }
    if (ok) {
      acc.push(c);
      byBlob.set(c.l, acc);
    }
  }
  return byBlob;
}

function pathMin(dist, w, a, b) {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
  let m = Infinity;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    const d = dist[y * w + x];
    if (d < m) m = d;
  }
  return m;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = Array.from(arr).sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
