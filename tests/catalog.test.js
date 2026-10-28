import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCatalog, resolveCatalog, resolveSource } from '../src/lib/catalog.js';

const files = (map) => async (repo, path) => map[`${repo}/${path}`] ?? null;

test('a repo that publishes generator.json needs no overlay', async () => {
  const io = { readJson: files({ 'o/r/generator.json': { id: 'g', name: 'G', distributions: [{ kind: 'web', url: 'https://g/' }] } }) };
  const { manifests, problems } = await resolveSource({ repo: 'o/r', overlay: null, enabled: true }, io);
  assert.deepEqual(problems, []);
  assert.equal(manifests[0].id, 'g');
  assert.equal(manifests[0].repo, 'o/r');
  assert.equal(manifests[0].manifestPath, 'generator.json');
});

test('an overlay patches what the repo publishes', async () => {
  const io = { readJson: files({ 'o/r/generator.json': { id: 'g', name: 'G', tags: ['a'], distributions: [{ kind: 'web', url: 'https://g/' }] } }) };
  const { manifests } = await resolveSource({ repo: 'o/r', overlay: { summary: 'patched', tags: ['b'] }, enabled: true }, io);
  assert.equal(manifests[0].summary, 'patched');
  assert.deepEqual(manifests[0].tags, ['a', 'b']);
});

test('a repo without a manifest can be described by an overlay alone, and reports when there is none', async () => {
  const io = { readJson: files({}) };
  const withOverlay = await resolveSource({ repo: 'o/r', overlay: { id: 'g', name: 'G', distributions: [{ kind: 'web', url: 'https://g/' }] }, enabled: true }, io);
  assert.equal(withOverlay.manifests.length, 1);
  assert.equal(withOverlay.manifests[0].manifestPath, undefined);
  const without = await resolveSource({ repo: 'o/r', overlay: null, enabled: true }, io);
  assert.equal(without.manifests.length, 0);
  assert.match(without.problems[0].error, /no generator.json/);
});

test('a fallback is used only when the repo cannot be read, and an overlay still patches it', async () => {
  const fallback = { id: 'g', name: 'Snapshot', distributions: [{ kind: 'web', url: 'https://old/' }] };
  const offline = await resolveSource({ repo: 'o/r', fallback, overlay: null, enabled: true }, { readJson: async () => null });
  assert.equal(offline.manifests[0].name, 'Snapshot');
  assert.equal(offline.manifests[0].manifestPath, undefined);

  const live = { id: 'g', name: 'Live', distributions: [{ kind: 'web', url: 'https://new/' }] };
  const online = await resolveSource({ repo: 'o/r', fallback, overlay: null, enabled: true }, { readJson: files({ 'o/r/generator.json': live }) });
  assert.equal(online.manifests[0].name, 'Live');
  assert.equal(online.manifests[0].distributions[0].url, 'https://new/');

  const patched = await resolveSource({ repo: 'o/r', fallback, overlay: { summary: 'patched' }, enabled: true }, { readJson: async () => null });
  assert.equal(patched.manifests[0].name, 'Snapshot');
  assert.equal(patched.manifests[0].summary, 'patched');

  const { catalog } = normalizeCatalog({ version: 1, sources: [{ repo: 'o/r', fallback }] });
  assert.deepEqual(catalog.sources[0].fallback, fallback);
});

test('collections expand path entries from the repo', async () => {
  const io = {
    readJson: files({
      'o/mono/generator-library.json': { id: 'mono', generators: [{ path: 'apps/a/generator.json' }, { path: 'apps/missing/generator.json' }], defaults: { tags: ['mono'] } },
      'o/mono/apps/a/generator.json': { id: 'a', name: 'A', distributions: [{ kind: 'web', url: 'https://a/' }] },
    }),
  };
  const { manifests, problems } = await resolveSource({ repo: 'o/mono', overlay: null, enabled: true }, io);
  assert.equal(manifests.length, 1);
  assert.deepEqual(manifests[0].tags, ['mono']);
  assert.deepEqual(manifests[0].collection, { id: 'mono', name: 'mono' });
  assert.equal(problems.length, 1);
  assert.match(problems[0].error, /not found/);
});

test('read failures are reported per source and do not stop the others', async () => {
  const io = {
    readJson: async (repo) => {
      if (repo === 'o/bad') throw new Error('boom');
      return { id: 'ok', name: 'OK', distributions: [{ kind: 'web', url: 'https://ok/' }] };
    },
  };
  const { catalog } = normalizeCatalog({ version: 1, sources: [{ repo: 'o/bad' }, { repo: 'o/good' }] });
  const { manifests, problems } = await resolveCatalog(catalog, io);
  assert.equal(manifests.length, 1);
  assert.ok(problems.some((p) => p.repo === 'o/bad' && p.error.includes('boom')));
});

test('duplicate ids keep the first source', async () => {
  const io = { readJson: async () => ({ id: 'same', name: 'Same', distributions: [{ kind: 'web', url: 'https://s/' }] }) };
  const { catalog } = normalizeCatalog({ version: 1, sources: [{ repo: 'o/one' }, { repo: 'o/two' }] });
  const { manifests, problems } = await resolveCatalog(catalog, io);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].repo, 'o/one');
  assert.ok(problems.some((p) => p.error.includes('duplicate')));
});

test('the shipped catalog resolves offline without problems', async () => {
  const raw = JSON.parse(await readFile(new URL('../catalog/catalog.json', import.meta.url), 'utf8'));
  const { catalog, errors } = normalizeCatalog(raw);
  assert.deepEqual(errors, []);
  const { manifests, problems } = await resolveCatalog(catalog, { readJson: async () => null });
  assert.deepEqual(problems, []);
  assert.ok(manifests.length >= 20);
  const ids = manifests.map((m) => m.id);
  assert.ok(ids.includes('terrain-press'));
  assert.ok(ids.includes('clicker-generator'));
  assert.ok(ids.includes('gridfinity-bin-designer'));
});

test('a website source resolves from its overlay without reading GitHub, and disabled sources are skipped', async () => {
  const reads = [];
  const readJson = async (repo, file) => {
    reads.push(`${repo}/${file}`);
    return null;
  };
  const overlay = { id: 'box', name: 'Box', distributions: [{ kind: 'web', url: 'https://example.com/box/' }, { kind: 'mirror', url: 'https://example.com/box/' }] };
  const catalog = {
    sources: [
      { repo: '', url: 'https://example.com/box/', overlay, overlayOnly: true, enabled: true, origin: 'yours' },
      { repo: 'o/gone', fallback: { id: 'gone', name: 'Gone', distributions: [{ kind: 'web', url: 'https://g/' }] }, enabled: false },
    ],
  };
  const { manifests, problems } = await resolveCatalog(catalog, { readJson });
  assert.deepEqual(problems, []);
  assert.deepEqual(reads, []);
  assert.deepEqual(manifests.map((m) => [m.id, m.source, m.origin]), [['box', 'https://example.com/box/', 'yours']]);
});

test('the shipped catalog can list a project with no repository by its website', async () => {
  const fallback = {
    id: 'site-app', name: 'Site App',
    distributions: [
      { kind: 'web', url: 'https://example.com/app' },
      { kind: 'exe', platform: 'windows', install: 'installer', from: { type: 'page', url: 'https://example.com/download', asset: 'App-*-setup.exe' } },
    ],
  };
  const { catalog, errors } = normalizeCatalog({ sources: [{ url: 'https://example.com/', fallback }, { url: 'https://example.com/' }, { url: 'ftp://x' }] });
  assert.equal(errors.length, 2, 'a website needs a fallback and an http(s) address');
  assert.equal(catalog.sources[0].overlayOnly, true);
  let reads = 0;
  const { manifests, problems } = await resolveCatalog(catalog, { readJson: async () => { reads += 1; return null; } });
  assert.deepEqual(problems, []);
  assert.equal(reads, 0, 'nothing is read from GitHub');
  assert.equal(manifests[0].source, 'https://example.com/');
  assert.equal(manifests[0].distributions[1].from.type, 'page');
});
