// Check the built GenerateSTL page in a browser before it is published: it
// starts with no network, makes every part type from its default inputs, and
// points at the field when an input is out of range. Run by
// library-bundle.yml with $SITE set to the build and playwright on NODE_PATH.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const site = process.env.SITE;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.zip': 'application/zip', '.py': 'text/plain', '.whl': 'application/zip' };
const server = http.createServer((req, res) => {
  const file = path.join(site, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!file.startsWith(site) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => message.type() === 'error' && problems.push(`console: ${message.text()}`));
  await page.route('**/*', (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    problems.push(`reached outside the page: ${route.request().url()}`);
    return route.abort();
  });

  const settled = (timeout = 180000) => page.waitForFunction(() => ['done', 'problem'].includes(document.body.dataset.state) && document.querySelector('#status').textContent === '', null, { timeout });
  const started = Date.now();
  await page.goto(`${origin}/index.html`);
  await settled();
  console.log(`Started in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const parts = await page.$$eval('#part option', (options) => options.map((o) => [o.value, o.textContent]));
  let failed = 0;
  for (const [id, name] of parts) {
    const t = Date.now();
    if ((await page.inputValue('#part')) === id) await page.click('#reset');
    else await page.selectOption('#part', id);
    await page.waitForFunction(() => document.body.dataset.state === 'working');
    await settled();
    const out = await page.evaluate(() => ({
      state: document.body.dataset.state,
      problem: document.querySelector('#problem').textContent,
      notes: [...document.querySelectorAll('small.error')].map((n) => n.textContent),
      stats: [...document.querySelectorAll('#stats dd')].map((n) => n.textContent),
    }));
    const ok = out.state === 'done';
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${((Date.now() - t) / 1000).toFixed(1)}s): ${ok ? out.stats.join(' | ') : `${out.problem} ${out.notes.join(' ')}`}`);
  }

  // An impossible gear: the problem shows under the field it belongs to.
  await page.selectOption('#part', 'Spur');
  await page.fill('#f-z', '3');
  await page.waitForFunction(() => document.body.dataset.state === 'working');
  await settled();
  const note = await page.$eval('#f-z', (input) => input.closest('.field').querySelector('small').textContent);
  console.log(`Teeth 3: ${note}`);
  if (!note || !(await page.$eval('#f-z', (input) => input.getAttribute('aria-invalid') === 'true'))) failed++;

  await browser.close();
  server.close();
  for (const p of problems) console.log(p);
  if (failed || problems.length) {
    console.log(`${failed} check(s) failed, ${problems.length} problem(s)`);
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
