// Open each generator of the built site in Chromium, offline, and fail unless
// OpenSCAD renders it. Usage: node check.mjs <site folder>; PLAYWRIGHT_DIR names a
// folder with playwright installed.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const site = path.resolve(process.argv[2]);
const { chromium } = createRequire(path.join(process.env.PLAYWRIGHT_DIR, '/'))('playwright');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const file = path.join(site, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(site) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let failed = false;
for (const label of ['Bins', 'Baseplates', 'Lite bins', 'Spiral vase bins']) {
  const page = await browser.newPage();
  const problems = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/ERROR|Can't open|EXCEPTION/i.test(text)) problems.push(text.slice(0, 300));
  });
  page.on('pageerror', (error) => problems.push(String(error).slice(0, 300)));
  // Offline: nothing may load from anywhere but the site itself.
  await page.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const started = Date.now();
  try {
    await page.goto(`${origin}/gridfinity.html`);
    await page.getByRole('button', { name: label }).click();
    await page.waitForFunction(
      () => document.querySelector('model-viewer.main-viewer')?.getAttribute('src'),
      null, { timeout: 300_000 },
    );
    const fields = await page.locator('input').count();
    console.log(`${label}: rendered in ${Math.round((Date.now() - started) / 1000)}s, ${fields} inputs`);
    if (problems.length) {
      failed = true;
      console.log(`${label} problems:\n  ${problems.join('\n  ')}`);
    }
  } catch (error) {
    failed = true;
    console.log(`${label}: did not render (${String(error).split('\n')[0]})\n  ${problems.join('\n  ')}`);
  }
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
