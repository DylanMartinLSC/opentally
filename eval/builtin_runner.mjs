// Runs the built-in engine for eval/run_eval.py without any image decoder:
// Python streams frames over stdin as one JSON header line followed by
// width*height*4 raw RGBA bytes, and gets one JSON result line back per frame.
import { detect } from '../src/core/detect.js';

let buf = Buffer.alloc(0);
let header = null;

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (!header) {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      header = JSON.parse(buf.subarray(0, nl).toString());
      buf = buf.subarray(nl + 1);
    }
    const size = header.width * header.height * 4;
    if (buf.length < size) return;
    const img = { width: header.width, height: header.height, data: new Uint8ClampedArray(buf.subarray(0, size)) };
    buf = buf.subarray(size);
    const t0 = performance.now();
    let line;
    try {
      const res = detect(img, header.options ?? {});
      line = { objects: res.objects.map((o) => [o.x, o.y]), ms: performance.now() - t0 };
    } catch (e) {
      line = { error: e.message, objects: [] };
    }
    process.stdout.write(JSON.stringify(line) + '\n');
    header = null;
  }
});
