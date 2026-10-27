import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CountSession } from '../src/core/session.js';

test('session: categories and counts', () => {
  const s = new CountSession();
  const def = s.categories[0].id;
  const red = s.addCategory('Red pills', '#e33');
  s.addMarker(1, 1, def);
  s.addMarker(2, 2, red);
  s.addMarker(3, 3, red);
  assert.equal(s.count(def), 1);
  assert.equal(s.count(red), 2);
  assert.equal(s.total(), 3);
  assert.equal(s.categories.length, 2);
});

test('session: add and remove', () => {
  const s = new CountSession();
  const c = s.categories[0].id;
  s.addMarker(10, 10, c);
  s.addMarker(50, 50, c);
  assert.equal(s.removeNearest(100, 100, 20), null);
  const removed = s.removeNearest(48, 52, 20);
  assert.equal(removed.x, 50);
  assert.equal(s.total(), 1);
});

test('session: auto markers keep manual', () => {
  const s = new CountSession();
  const c = s.categories[0].id;
  s.setAutoMarkers([{ x: 1, y: 1 }, { x: 2, y: 2 }], c);
  s.addMarker(5, 5, c);
  s.setAutoMarkers([{ x: 9, y: 9 }], c);
  assert.equal(s.total(), 2);
  assert.deepEqual(s.markers.map((m) => m.source).sort(), ['auto', 'manual']);
});

test('session: undo redo', () => {
  const s = new CountSession();
  const c = s.categories[0].id;
  s.addMarker(1, 1, c);
  s.addMarker(2, 2, c);
  s.setAutoMarkers([{ x: 3, y: 3 }, { x: 4, y: 4 }], c);
  assert.equal(s.total(), 4);
  assert.ok(s.undo());
  assert.equal(s.total(), 2);
  assert.ok(s.undo());
  assert.equal(s.total(), 1);
  assert.ok(s.redo());
  assert.equal(s.total(), 2);
  s.addMarker(7, 7, c); // new edit clears redo
  assert.equal(s.redo(), false);
  assert.ok(s.undo() && s.undo() && s.undo());
  assert.equal(s.total(), 0);
  assert.equal(s.undo(), false);
});

test('session: json roundtrip', () => {
  const s = new CountSession();
  const b = s.addCategory('Logs', '#a63');
  s.addMarker(3, 4, b);
  s.setAutoMarkers([{ x: 1, y: 2, r: 5 }], s.categories[0].id);
  const copy = CountSession.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.deepEqual(copy.toJSON(), s.toJSON());
  // ids keep incrementing after load
  const m = copy.addMarker(0, 0, b);
  assert.ok(!s.markers.some((x) => x.id === m.id));
});

test('session: delete category', () => {
  const s = new CountSession();
  const a = s.categories[0].id;
  const b = s.addCategory('Other');
  s.addMarker(1, 1, a);
  s.addMarker(1, 1, b);
  assert.equal(s.deleteCategory(b), true);
  assert.equal(s.total(), 1);
  assert.equal(s.deleteCategory(a), false);
  assert.equal(s.categories.length, 1);
});
