import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGray, otsu, labelComponents, distanceTransform, boxBlur, pointInPolygon } from '../src/core/imageops.js';
import { makeImage, drawDisk, drawRect } from './helpers/synth.js';

test('imageops: toGray uses luma weights', () => {
  const img = makeImage(3, 1);
  img.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  const g = toGray(img);
  assert.ok(Math.abs(g[0] - 76) <= 1);
  assert.ok(Math.abs(g[1] - 150) <= 1);
  assert.ok(Math.abs(g[2] - 29) <= 1);
});

test('imageops: otsu splits a bimodal histogram', () => {
  const g = new Uint8Array(1000);
  for (let i = 0; i < 1000; i++) g[i] = i < 600 ? 40 + (i % 10) : 200 + (i % 10);
  const t = otsu(g);
  assert.ok(t >= 49 && t < 200, `threshold ${t}`);
});

test('imageops: labelComponents finds blobs with areas and bounds', () => {
  const w = 20, h = 10;
  const mask = new Uint8Array(w * h);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) mask[y * w + x] = 1; // 9 px
  for (let y = 5; y < 9; y++) for (let x = 10; x < 15; x++) mask[y * w + x] = 1; // 20 px
  const { blobs } = labelComponents(mask, w, h);
  assert.equal(blobs.length, 2);
  const areas = blobs.map((b) => b.area).sort((a, b) => a - b);
  assert.deepEqual(areas, [9, 20]);
  const big = blobs.find((b) => b.area === 20);
  assert.deepEqual([big.minX, big.minY, big.maxX, big.maxY], [10, 5, 14, 8]);
  assert.equal(big.cx, 12);
  assert.equal(big.cy, 6.5);
});

test('imageops: distanceTransform peaks at disk radius', () => {
  const img = makeImage(60, 60);
  drawDisk(img, 30, 30, 15);
  const g = toGray(img);
  const mask = Uint8Array.from(g, (v) => (v < 128 ? 1 : 0));
  const d = distanceTransform(mask, 60, 60);
  const centre = d[30 * 60 + 30];
  assert.ok(Math.abs(centre - 16) <= 1.5, `centre distance ${centre}`);
  assert.equal(d[0], 0);
});

test('imageops: boxBlur preserves flat regions and smooths edges', () => {
  const img = makeImage(20, 20);
  drawRect(img, 0, 0, 10, 20);
  const g = toGray(img);
  const b = boxBlur(g, 20, 20, 2);
  assert.equal(b[10 * 20 + 2], 0);
  assert.equal(b[10 * 20 + 17], 255);
  assert.ok(b[10 * 20 + 10] > 0 && b[10 * 20 + 10] < 255);
});

test('imageops: pointInPolygon', () => {
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(pointInPolygon(5, 5, sq), true);
  assert.equal(pointInPolygon(15, 5, sq), false);
});
