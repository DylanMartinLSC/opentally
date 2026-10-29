// Real browser capture. npm install --no-save playwright@1.56.1; npx playwright install chromium
// Then: node scripts/record-demo.cjs (ffmpeg and ffprobe must be on PATH).
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const media = path.join(root, 'media');
const recording = path.join(root, '.demo-recording');
fs.mkdirSync(recording, { recursive: true });
const server = spawn(process.execPath, ['scripts/serve.js'], { cwd: root, stdio: 'ignore', windowsHide: true });
const pause = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch('http://127.0.0.1:8080')).ok) break; } catch {}
      await pause(100);
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 },
      recordVideo: { dir: recording, size: { width: 1200, height: 800 } }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', e => failures.push(e.message));
    await page.goto('http://127.0.0.1:8080', { waitUntil: 'networkidle' });
    const started = Date.now();
    await page.waitForTimeout(650);
    await page.getByRole('button', { name: 'Pipe stack', exact: true }).click();
    await page.waitForFunction(() => window.opentally?.state.image);
    await page.waitForTimeout(650);
    // Read the app's actual viewport transform; interact only via mouse events.
    const points = await page.evaluate(() => {
      const { s, ox, oy } = window.opentally.state.view;
      const rect = document.querySelector('#view').getBoundingClientRect();
      // The seed deliberately leaves the first grid position empty. Use the
      // isolated, always-present pipe at (95, 640), rim to rim.
      return [[60, 605], [130, 675]].map(([x, y]) => ({ x: rect.left + ox + x * s, y: rect.top + oy + y * s }));
    });
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 30 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForFunction(() => window.opentally.state.counted && !window.opentally.state.busy);
    const count = await page.locator('#total').innerText();
    if (!Number(count)) throw new Error('No completed count');
    await page.screenshot({ path: path.join(recording, 'final.png') });
    await page.waitForTimeout(Math.max(2500, 8500 - (Date.now() - started)));
    const video = page.video();
    await context.close();
    const videoPath = await video.path();
    if (failures.length) throw new Error(failures.join('\n'));
    const gif = path.join(media, 'demo.gif');
    const result = spawnSync('ffmpeg', ['-y', '-i', videoPath, '-t', '9.5', '-filter_complex',
      '[0:v]fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a',
      '-loop', '0', gif], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error('ffmpeg failed');
    const size = fs.statSync(gif).size;
    if (size >= 8_000_000) throw new Error('GIF exceeds 8 MB');
    fs.writeFileSync(path.join(media, 'DEMO.md'), `# Demo recording\n\nReal Playwright recording of the built-in browser engine: open Pipe stack, draw one sample box, wait for counting, hold the final count (**${count}**). The pipe image is the app's generated example, not a photograph. No results or UI were substituted.\n\n800 px wide, 12 fps; ${size} bytes. Recreate with \`node scripts/record-demo.cjs\` after installing Playwright 1.56.1, Chromium and ffmpeg. The original source video stays in ignored \`.demo-recording/\`.\n`);
    console.log(JSON.stringify({ count, bytes: size, gif }));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
