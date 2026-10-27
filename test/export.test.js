import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CountSession } from '../src/core/session.js';
import { markersToCSV, summaryToCSV, csvField } from '../src/core/export.js';

function sample() {
  const s = new CountSession();
  s.renameCategory(s.categories[0].id, 'Pipes');
  const b = s.addCategory('Rebar');
  s.addMarker(10.4, 20.6, s.categories[0].id);
  s.setAutoMarkers([{ x: 1, y: 2 }, { x: 3, y: 4 }], b);
  return s;
}

test('export: markers csv', () => {
  const lines = markersToCSV(sample()).trim().split('\n');
  assert.equal(lines[0], 'index,category,x,y,source');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], '1,Pipes,10.4,20.6,manual');
  assert.ok(lines[2].startsWith('2,Rebar,1,2,auto'));
});

test('export: summary csv', () => {
  const lines = summaryToCSV(sample()).trim().split('\n');
  assert.deepEqual(lines, ['category,count', 'Pipes,1', 'Rebar,2', 'Total,3']);
});

test('export: csv escaping', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField('=SUM(A1)'), "'=SUM(A1)"); // spreadsheet formula injection guard
  assert.equal(csvField(42), '42');
});
