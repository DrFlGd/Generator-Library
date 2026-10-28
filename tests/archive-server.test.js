import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import { extractTarGz, extractZip } from '../src/lib/archive.js';
import { createStaticServer, resolveFile } from '../src/lib/server.js';

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'genlib-'));
}

test('extractZip writes files and refuses traversal', async () => {
  const dir = await tmp();
  const zip = zipSync({ 'index.html': strToU8('<h1>hi</h1>'), 'assets/app.js': strToU8('1'), '../evil.txt': strToU8('x') });
  const archive = path.join(dir, 'a.zip');
  await fs.writeFile(archive, zip);
  const out = path.join(dir, 'out');
  const { written, skipped } = await extractZip(archive, out);
  assert.deepEqual(written.sort(), ['assets/app.js', 'index.html']);
  assert.deepEqual(skipped, ['../evil.txt']);
  assert.equal(await fs.readFile(path.join(out, 'index.html'), 'utf8'), '<h1>hi</h1>');
});

test('extractTarGz drops the top folder and can keep only a subdirectory', async () => {
  const dir = await tmp();
  const tree = path.join(dir, 'owner-repo-abc123');
  await fs.mkdir(path.join(tree, 'site', 'data'), { recursive: true });
  await fs.mkdir(path.join(tree, 'source'), { recursive: true });
  await fs.writeFile(path.join(tree, 'site', 'index.html'), 'site');
  await fs.writeFile(path.join(tree, 'site', 'data', 'a-very-long-file-name-that-goes-on-and-on-and-on-to-exceed-one-hundred-characters-in-total-length.bin'), 'long');
  await fs.writeFile(path.join(tree, 'source', 'build.py'), 'py');
  await fs.writeFile(path.join(tree, 'README.md'), 'readme');
  const archive = path.join(dir, 'repo.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', dir, 'owner-repo-abc123']);

  const onlySite = path.join(dir, 'site-only');
  const result = await extractTarGz(archive, onlySite, { subdir: 'site' });
  assert.deepEqual(result.written.sort(), ['data/a-very-long-file-name-that-goes-on-and-on-and-on-to-exceed-one-hundred-characters-in-total-length.bin', 'index.html']);
  assert.equal(await fs.readFile(path.join(onlySite, 'index.html'), 'utf8'), 'site');
  assert.equal(await fs.readFile(path.join(onlySite, 'data', 'a-very-long-file-name-that-goes-on-and-on-and-on-to-exceed-one-hundred-characters-in-total-length.bin'), 'utf8'), 'long');

  const whole = path.join(dir, 'whole');
  const all = await extractTarGz(archive, whole);
  assert.ok(all.written.includes('README.md'));
  assert.ok(all.written.includes('source/build.py'));

  const asIs = path.join(dir, 'as-is');
  const kept = await extractTarGz(archive, asIs, { strip: 0 });
  assert.ok(kept.written.includes('owner-repo-abc123/README.md'), 'release tarballs keep their top folder');
});

test('resolveFile honours routes, directories, SPA fallback and stays inside root', async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, 'app'), { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), 'root');
  await fs.writeFile(path.join(root, 'app', 'index.html'), 'app');
  await fs.writeFile(path.join(root, 'data.json'), '{}');
  await fs.writeFile(path.join(root, 'q-abc.json'), 'queried');
  const routes = { '/api/items?x=1': 'q-abc.json' };
  assert.equal(await resolveFile(root, '/', { routes }), path.join(root, 'index.html'));
  assert.equal(await resolveFile(root, '/app', { routes }), path.join(root, 'app', 'index.html'));
  assert.equal(await resolveFile(root, '/app/', { routes }), path.join(root, 'app', 'index.html'));
  assert.equal(await resolveFile(root, '/api/items?x=1', { routes }), path.join(root, 'q-abc.json'));
  assert.equal(await resolveFile(root, '/missing', { routes, spa: true, wantsHtml: true }), path.join(root, 'index.html'));
  assert.equal(await resolveFile(root, '/missing', { routes, spa: false, wantsHtml: true }), null);
  assert.equal(await resolveFile(root, '/missing.js', { routes, spa: true, wantsHtml: true }), null, 'never serve html for a missing asset');
  assert.equal(await resolveFile(root, '/../../etc/passwd', { routes }), null);
  assert.equal(await resolveFile(root, '/%2e%2e/%2e%2e/etc/passwd', { routes }), null);
});

test('the static server serves files on loopback with the right types', async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, 'index.html'), '<p>ok</p>');
  await fs.writeFile(path.join(root, 'w.wasm'), Buffer.from([0, 97, 115, 109]));
  const server = await createStaticServer({ root, entry: 'index.html', spa: true });
  try {
    assert.ok(server.base.startsWith('http://127.0.0.1:'));
    assert.equal(server.url, `${server.base}/`, 'an index page opens at its folder');
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await page.text(), '<p>ok</p>');
    const wasm = await fetch(`${server.base}/w.wasm`);
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    const spa = await fetch(`${server.base}/some/route`, { headers: { Accept: 'text/html' } });
    assert.equal(spa.status, 200);
    const missing = await fetch(`${server.base}/nope.js`);
    assert.equal(missing.status, 404);
    const post = await fetch(server.url, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await server.close();
  }
});

test('the static server opens a nested index page at its folder and other pages by name', async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, 'app'));
  await fs.writeFile(path.join(root, 'app', 'index.html'), '<p>app</p>');
  await fs.writeFile(path.join(root, 'demo.html'), '<p>demo</p>');
  const nested = await createStaticServer({ root, entry: 'app/index.html' });
  const named = await createStaticServer({ root, entry: 'demo.html' });
  try {
    assert.equal(nested.url, `${nested.base}/app/`);
    assert.equal(await (await fetch(nested.url)).text(), '<p>app</p>');
    assert.equal(named.url, `${named.base}/demo.html`);
  } finally {
    await nested.close();
    await named.close();
  }
});
