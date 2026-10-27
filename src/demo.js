// Procedural "photo" of a stack of steel pipe ends, so people can try the app
// without hunting for an image.

export function demoCanvas(w = 1200, h = 800, seed = 3) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');

  // Concrete-ish backdrop.
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#d9d4cb');
  bg.addColorStop(1, '#bdb6aa');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  // Hex-packed bundle with a few gaps and size variation.
  const truth = [];
  const r = 34;
  const dx = 2 * r + 1, dy = Math.sqrt(3) * r + 1;
  for (let row = 0; row < 7; row++) {
    const cols = row % 2 ? 9 : 10;
    for (let col = 0; col < cols; col++) {
      if (rand() < 0.06) continue;
      const cx = 230 + col * dx + (row % 2 ? dx / 2 : 0) + (rand() - 0.5) * 4;
      const cy = 160 + row * dy + (rand() - 0.5) * 4;
      const rr = r * (0.93 + rand() * 0.1);
      pipe(g, cx, cy, rr, rand);
      truth.push({ x: cx, y: cy });
    }
  }
  // A few loose pipes.
  pipe(g, 95, 640, 33, rand);
  truth.push({ x: 95, y: 640 });
  pipe(g, 1110, 120, 35, rand);
  truth.push({ x: 1110, y: 120 });

  // Sensor noise.
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  c.truth = truth;
  return c;
}

function pipe(g, x, y, r, rand) {
  const tone = 40 + rand() * 30;
  const body = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
  body.addColorStop(0, `rgb(${tone + 50},${tone + 48},${tone + 45})`);
  body.addColorStop(1, `rgb(${tone},${tone - 2},${tone - 4})`);
  g.fillStyle = body;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  // Dark bore.
  g.fillStyle = `rgb(${tone * 0.35},${tone * 0.33},${tone * 0.3})`;
  g.beginPath(); g.arc(x + 1, y + 1, r * 0.62, 0, Math.PI * 2); g.fill();
  // Rim highlight.
  g.strokeStyle = 'rgba(255,255,255,.18)';
  g.lineWidth = 2;
  g.beginPath(); g.arc(x, y, r * 0.8, Math.PI * 1.1, Math.PI * 1.7); g.stroke();
}
