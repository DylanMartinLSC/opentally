import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samHealth, samCount } from '../src/core/sam-client.js';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('sam: health reports a missing backend', async () => {
  const res = await samHealth('http://x', async () => { throw new TypeError('fetch failed'); });
  assert.equal(res.ok, false);
});

test('sam: health passes backend info through', async () => {
  const res = await samHealth('http://x', async () => json({ model: 'sam3', device: 'cuda', ready: true }));
  assert.deepEqual(res, { ok: true, model: 'sam3', device: 'cuda', ready: true });
});

test('sam: count scales boxes out and results back', async () => {
  let sent;
  const fake = async (url, init) => {
    sent = { url, boxes: JSON.parse(init.body.get('boxes')), text: init.body.get('text') };
    return json({ objects: [{ x: 50, y: 25, r: 10, score: 0.9 }] });
  };
  const blob = new Blob([new Uint8Array(4)]);
  const res = await samCount('http://x', blob, { boxes: [{ x: 100, y: 40, w: 20, h: 20 }], text: 'pipe', scale: 0.5 }, fake);
  assert.equal(sent.url, 'http://x/count');
  assert.deepEqual(sent.boxes, [[50, 20, 60, 30]]);
  assert.equal(sent.text, 'pipe');
  assert.deepEqual(res.objects, [{ x: 100, y: 50, r: 20, score: 0.9 }]);
});

test('sam: count surfaces backend errors', async () => {
  const fake = async () => json({ detail: 'Model weights not found' }, 503);
  await assert.rejects(samCount('http://x', new Blob([]), {}, fake), /weights not found/);
});

test('sam: count explains an unreachable backend', async () => {
  const fake = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(samCount('http://127.0.0.1:8770', new Blob([]), { text: 'pipe' }, fake), /Can't reach the local AI backend.*Built-in/);
});
