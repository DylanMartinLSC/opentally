import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../src/core/detect.js';
import { makeImage, drawDisk, drawRect, addNoise, diskGrid } from './helpers/synth.js';

test('detect: counts separated dark disks', () => {
  const img = makeImage(300, 240);
  diskGrid(img, 4, 3, 14, 60, 50);
  assert.equal(detect(img).count, 12);
});

test('detect: auto polarity handles light-on-dark', () => {
  const img = makeImage(300, 240, [20, 20, 30]);
  diskGrid(img, 4, 3, 14, 60, 50, [230, 220, 200]);
  const res = detect(img);
  assert.equal(res.polarity, 'light');
  assert.equal(res.count, 12);
});

function touchingPairs() {
  const img = makeImage(400, 300);
  const r = 15;
  for (let i = 0; i < 5; i++) {
    const cx = 40 + (i % 3) * 120;
    const cy = 60 + Math.floor(i / 3) * 140;
    drawDisk(img, cx, cy, r);
    drawDisk(img, cx + 2 * r - 2, cy, r); // slight overlap, like real pipes
  }
  return img;
}

test('detect: splits touching pairs', () => {
  assert.equal(detect(touchingPairs()).count, 10);
});

test('detect: splitting off counts blobs', () => {
  assert.equal(detect(touchingPairs(), { splitTouching: false }).count, 5);
});

test('detect: splits hex-packed bundle', () => {
  const img = makeImage(300, 300);
  const r = 16;
  const d = 2 * r - 1;
  const pts = [[150, 150]];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    pts.push([150 + d * Math.cos(a), 150 + d * Math.sin(a)]);
  }
  for (const [x, y] of pts) drawDisk(img, x, y, r);
  // Some lone pipes nearby so the typical size is known.
  drawDisk(img, 40, 40, r);
  drawDisk(img, 260, 40, r);
  assert.equal(detect(img).count, 9);
});

test('detect: min area filters specks', () => {
  const img = makeImage(300, 240);
  diskGrid(img, 3, 2, 14, 70, 50);
  for (let i = 0; i < 20; i++) drawRect(img, 10 + i * 13, 225, 2, 2);
  assert.equal(detect(img, { minArea: 30 }).count, 6);
});

test('detect: max area excludes giant blobs', () => {
  const img = makeImage(400, 300);
  diskGrid(img, 3, 2, 12, 60, 40);
  drawRect(img, 250, 50, 120, 120);
  assert.equal(detect(img, { maxArea: 2000 }).count, 6);
});

test('detect: ROI restricts count', () => {
  const img = makeImage(300, 240);
  diskGrid(img, 4, 3, 14, 60, 50);
  // Left half only: columns at x=50 and x=110.
  const roi = [{ x: 0, y: 0 }, { x: 140, y: 0 }, { x: 140, y: 240 }, { x: 0, y: 240 }];
  assert.equal(detect(img, { roi }).count, 6);
});

test('detect: color mode picks one colour', () => {
  const img = makeImage(300, 200, [235, 235, 235]);
  for (let i = 0; i < 5; i++) drawDisk(img, 30 + i * 55, 50, 15, [210, 30, 30]);
  for (let i = 0; i < 3; i++) drawDisk(img, 30 + i * 55, 140, 15, [30, 60, 210]);
  assert.equal(detect(img, { mode: 'color', color: [200, 40, 40], colorTolerance: 60 }).count, 5);
  assert.equal(detect(img, { mode: 'color', color: [40, 60, 200], colorTolerance: 60 }).count, 3);
});

test('detect: robust to noise', () => {
  const img = makeImage(300, 240, [200, 200, 200]);
  diskGrid(img, 4, 3, 14, 60, 50, [60, 60, 60]);
  addNoise(img, 70);
  assert.equal(detect(img).count, 12);
});

test('detect: centres are accurate', () => {
  const img = makeImage(300, 240);
  const truth = diskGrid(img, 4, 3, 14, 60, 50);
  const res = detect(img);
  for (const t of truth) {
    const best = Math.min(...res.objects.map((o) => Math.hypot(o.x - t.x, o.y - t.y)));
    assert.ok(best <= 2, `centre off by ${best}`);
  }
  for (const o of res.objects) assert.ok(o.r > 10 && o.r < 18, `radius ${o.r}`);
});

test('detect: downscales large images', () => {
  const img = makeImage(2400, 1600);
  const truth = diskGrid(img, 5, 3, 60, 400, 300);
  const res = detect(img, { maxSize: 800 });
  assert.equal(res.count, 15);
  assert.ok(res.scale < 1);
  for (const t of truth) {
    const best = Math.min(...res.objects.map((o) => Math.hypot(o.x - t.x, o.y - t.y)));
    assert.ok(best <= 8, `centre off by ${best}`);
  }
});

test('detect: rectangles not over-split', () => {
  const img = makeImage(400, 200);
  for (let i = 0; i < 4; i++) {
    drawRect(img, 20 + i * 95, 30, 70, 28);
    drawRect(img, 20 + i * 95, 120, 70, 28);
  }
  assert.equal(detect(img).count, 8);
});

test('detect: empty image', () => {
  const res = detect(makeImage(100, 100));
  assert.equal(res.count, 0);
  assert.deepEqual(res.objects, []);
});

test('detect: manual threshold', () => {
  const img = makeImage(300, 120);
  drawDisk(img, 50, 60, 15, [40, 40, 40]); // dark
  drawDisk(img, 150, 60, 15, [150, 150, 150]); // mid grey
  drawDisk(img, 250, 60, 15, [40, 40, 40]);
  assert.equal(detect(img, { mode: 'dark', threshold: 100 }).count, 2);
  assert.equal(detect(img, { mode: 'dark', threshold: 200 }).count, 3);
});

// One drawn box replaces a pre-built template.
test('detect: exemplar box sets size (ignores smaller clutter)', () => {
  const img = makeImage(400, 300);
  const big = diskGrid(img, 4, 2, 18, 80, 60);
  for (let i = 0; i < 10; i++) drawDisk(img, 30 + i * 36, 260, 5); // crumbs
  const ex = { x: big[0].x - 19, y: big[0].y - 19, w: 38, h: 38 };
  assert.equal(detect(img).count, 18);
  const res = detect(img, { exemplar: ex });
  assert.equal(res.count, 8);
  assert.ok(Math.abs(res.objectSize - 38) <= 2);
});

test('detect: exemplar box picks polarity', () => {
  const img = makeImage(400, 200, [128, 128, 128]);
  for (let i = 0; i < 5; i++) drawDisk(img, 40 + i * 75, 50, 15, [20, 20, 20]);
  for (let i = 0; i < 3; i++) drawDisk(img, 40 + i * 75, 150, 15, [240, 240, 240]);
  assert.equal(detect(img, { exemplar: { x: 24, y: 134, w: 32, h: 32 } }).count, 3);
  assert.equal(detect(img, { exemplar: { x: 24, y: 34, w: 32, h: 32 } }).count, 5);
});

test('detect: exemplar box picks colour', () => {
  const img = makeImage(300, 200, [235, 235, 235]);
  for (let i = 0; i < 5; i++) drawDisk(img, 30 + i * 55, 50, 15, [210, 30, 30]);
  for (let i = 0; i < 3; i++) drawDisk(img, 30 + i * 55, 140, 15, [30, 60, 210]);
  const res = detect(img, { mode: 'color', exemplar: { x: 15, y: 125, w: 30, h: 30 } });
  assert.equal(res.count, 3);
});

test('detect: ROI counts by centre, not slivers', () => {
  const img = makeImage(300, 240);
  diskGrid(img, 4, 3, 14, 60, 50); // columns at x = 50, 110, 170, 230
  // Edge at x=160 cuts through the x=170 column (centres outside).
  const roi = [{ x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 240 }, { x: 0, y: 240 }];
  assert.equal(detect(img, { roi }).count, 6);
});
