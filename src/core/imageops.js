// Low-level image operations. Everything works on plain typed arrays so the
// same code runs in the browser and under Node's test runner.
//
// Image: { width, height, data: Uint8ClampedArray RGBA } (same shape as ImageData)
// Gray / mask: Uint8Array of width*height

/** Rec. 601 luma. */
export function toGray(img) {
  const n = img.width * img.height;
  const d = img.data;
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114 + 500) / 1000;
  }
  return g;
}

/** Area-averaging resize of an RGBA image by `scale` (< 1 shrinks). */
export function resize(img, scale) {
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let j = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, j += 4) {
          r += img.data[j]; g += img.data[j + 1]; b += img.data[j + 2]; a += img.data[j + 3]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

/** Separable box blur, applied twice (close to a Gaussian). */
export function boxBlur(gray, w, h, r) {
  if (r <= 0) return Uint8Array.from(gray);
  let src = Float32Array.from(gray);
  let tmp = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    blur1d(src, tmp, w, h, r, true);
    blur1d(tmp, src, w, h, r, false);
  }
  return Uint8Array.from(src, (v) => Math.round(v));
}

function blur1d(src, dst, w, h, r, horizontal) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const stride = horizontal ? 1 : w;
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l;
    let sum = 0;
    // Clamp-to-edge window.
    for (let k = -r; k <= r; k++) sum += src[base + clamp(k, 0, len - 1) * stride];
    for (let i = 0; i < len; i++) {
      dst[base + i * stride] = sum / (2 * r + 1);
      sum += src[base + clamp(i + r + 1, 0, len - 1) * stride] - src[base + clamp(i - r, 0, len - 1) * stride];
    }
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Otsu's method; returns the threshold t such that class A is <= t. */
export function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = -1, bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return bestT;
}

/** Mean value of the outermost ring of pixels. */
export function borderMean(gray, w, h) {
  let s = 0, n = 0;
  for (let x = 0; x < w; x++) { s += gray[x] + gray[(h - 1) * w + x]; n += 2; }
  for (let y = 1; y < h - 1; y++) { s += gray[y * w] + gray[y * w + w - 1]; n += 2; }
  return s / n;
}

/** Mask of pixels within `tol` (Euclidean RGB distance) of `rgb`. */
export function colorMask(img, rgb, tol) {
  const n = img.width * img.height;
  const m = new Uint8Array(n);
  const t2 = tol * tol;
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const dr = d[j] - rgb[0], dg = d[j + 1] - rgb[1], db = d[j + 2] - rgb[2];
    m[i] = dr * dr + dg * dg + db * db <= t2 ? 1 : 0;
  }
  return m;
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 3x3 binary erosion followed by dilation, `iterations` times each. */
export function morphOpen(mask, w, h, iterations = 1) {
  let m = mask;
  for (let i = 0; i < iterations; i++) m = morph(m, w, h, true);
  for (let i = 0; i < iterations; i++) m = morph(m, w, h, false);
  return m;
}

function morph(m, w, h, erode) {
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let dy = -1; dy <= 1 && v === (erode ? 1 : 0); dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) { if (erode) v = 0; continue; }
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) { if (erode) { v = 0; break; } continue; }
          const p = m[yy * w + xx];
          if (erode && !p) { v = 0; break; }
          if (!erode && p) { v = 1; break; }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * 8-connected component labelling (two-pass with union-find).
 * Returns labels (0 = background, 1..n) and blob stats indexed by label-1.
 */
export function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  const parent = [0];
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };
  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let l = 0;
      const nb = [];
      if (x > 0 && labels[i - 1]) nb.push(labels[i - 1]);
      if (y > 0) {
        if (x > 0 && labels[i - w - 1]) nb.push(labels[i - w - 1]);
        if (labels[i - w]) nb.push(labels[i - w]);
        if (x < w - 1 && labels[i - w + 1]) nb.push(labels[i - w + 1]);
      }
      if (nb.length === 0) {
        l = next++;
        parent.push(l);
      } else {
        l = nb[0];
        for (let k = 1; k < nb.length; k++) {
          if (nb[k] < l) l = nb[k];
        }
        for (const k of nb) union(l, k);
      }
      labels[i] = l;
    }
  }
  // Compact labels and gather stats.
  const remap = new Int32Array(next);
  const blobs = [];
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const root = find(labels[i]);
    let id = remap[root];
    if (!id) {
      id = remap[root] = blobs.length + 1;
      blobs.push({ id, area: 0, minX: Infinity, minY: Infinity, maxX: -1, maxY: -1, sx: 0, sy: 0 });
    }
    labels[i] = id;
    const b = blobs[id - 1];
    const x = i % w, y = (i / w) | 0;
    b.area++; b.sx += x; b.sy += y;
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }
  for (const b of blobs) {
    b.cx = b.sx / b.area;
    b.cy = b.sy / b.area;
    delete b.sx; delete b.sy;
  }
  return { labels, blobs };
}

/**
 * Exact Euclidean distance from each foreground pixel to the nearest
 * background pixel (Felzenszwalb & Huttenlocher). Outside the image counts
 * as background.
 */
export function distanceTransform(mask, w, h) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask[i] ? INF : 0;

  const edt1d = (n) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      do {
        const p = v[k];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      } while (s <= z[k] && --k >= 0);
      k++;
      v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + f[v[k]];
    }
  };

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(w);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const edge = Math.min(x + 1, y + 1, w - x, h - y);
      out[i] = Math.min(Math.sqrt(grid[i]), edge);
    }
  }
  return out;
}
