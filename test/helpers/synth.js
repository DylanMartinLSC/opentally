// Synthetic test images: RGBA buffers shaped like browser ImageData.

export function makeImage(width, height, bg = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function setPx(img, x, y, color) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = color[0];
  img.data[i + 1] = color[1];
  img.data[i + 2] = color[2];
}

export function drawDisk(img, cx, cy, r, color = [0, 0, 0]) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPx(img, x, y, color);
    }
  }
}

export function drawRect(img, x0, y0, w, h, color = [0, 0, 0]) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(img, x, y, color);
}

// Deterministic PRNG so noisy tests are reproducible.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function addNoise(img, amplitude, seed = 7) {
  const rand = rng(seed);
  for (let i = 0; i < img.width * img.height; i++) {
    const n = (rand() + rand() + rand() - 1.5) * amplitude;
    for (let c = 0; c < 3; c++) img.data[i * 4 + c] = img.data[i * 4 + c] + n;
  }
}

/** Grid of separated disks; returns their true centres. */
export function diskGrid(img, cols, rows, r, spacing, offset = spacing, color = [0, 0, 0]) {
  const centres = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = offset + i * spacing;
      const cy = offset + j * spacing;
      drawDisk(img, cx, cy, r, color);
      centres.push({ x: cx, y: cy });
    }
  }
  return centres;
}
