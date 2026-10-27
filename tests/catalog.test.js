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

test('a repo without a manifest falls back to the overlay, and reports when there is none', async () => {
  const io = { readJson: files({}) };
  const withOverlay = await resolveSource({ repo: 'o/r', overlay: { id: 'g', name: 'G', distributions: [{ kind: 'web', url: 'https://g/' }] }, enabled: true }, io);
  assert.equal(withOverlay.manifests.length, 1);
  assert.equal(withOverlay.manifests[0].manifestPath, undefined);
  const without = await resolveSource({ repo: 'o/r', overlay: null, enabled: true }, io);
  assert.equal(without.manifests.length, 0);
  assert.match(without.problems[0].error, /no generator.json/);
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
