import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../src/lib/library.js';
import { applyManifestEdit, editPatch } from '../src/lib/manifest.js';
import { normalizeCatalog, resolveCatalog } from '../src/lib/catalog.js';

const original = applyManifestEdit(
  {
    id: 'cookie',
    name: 'Cookie Cutter',
    summary: 'Cutters',
    homepage: 'https://cookies.example/',
    repo: '',
    tags: ['cookie-cutters'],
    distributions: [
      { kind: 'web', url: 'https://cookies.example/' },
      { kind: 'mirror', url: 'https://cookies.example/' },
    ],
  },
  {},
).manifest;

test('an edit keeps only what differs from the catalog', () => {
  const wanted = {
    name: 'Cookie Cutter',
    summary: 'Cutters',
    homepage: 'https://cookies.example/',
    repo: 'alice/cookies',
    distributions: [
      { kind: 'web', url: 'https://cookies.example/', label: 'Open online' },
      { kind: 'web', url: 'https://makerworld.com/en/models/1', label: 'MakerWorld' },
      { kind: 'bundle', from: { type: 'repo', repo: 'alice/cookies' } },
    ],
  };
  const { patch, errors } = editPatch(original, wanted);
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(patch).sort(), ['distributions', 'repo']);
  assert.ok(patch.distributions.every((d) => !('key' in d)), 'keys are worked out again each time');

  const { manifest } = applyManifestEdit(original, patch);
  assert.equal(manifest.edited, true);
  assert.equal(manifest.repo, 'alice/cookies');
  assert.deepEqual(manifest.distributions.map((d) => d.key), ['web', 'web-2', 'bundle']);
  assert.deepEqual(manifest.tags, ['cookie-cutters'], 'fields the dialog does not edit stay');
  // The catalog's own values again: nothing to keep.
  assert.equal(editPatch(original, { ...wanted, repo: '', distributions: original.distributions }).patch, null);
});

test('an edit that is not a valid manifest is refused, and a stale one is skipped', () => {
  const { patch, errors } = editPatch(original, { distributions: [{ kind: 'mirror', url: 'not a url' }] });
  assert.equal(patch, null);
  assert.match(errors.join(), /mirror "url"/);
  assert.match(editPatch(original, { distributions: [] }).errors.join(), /at least one way/);
  assert.match(editPatch(original, { repo: 'not a repo' }).errors.join(), /owner\/name/);
  const stale = applyManifestEdit(original, { distributions: [{ kind: 'bundle', from: { type: 'repo' } }] });
  assert.equal(stale.manifest, original);
  assert.ok(stale.errors.length);
});

test('re-checking every catalog generator with no edit changes nothing', async () => {
  const raw = JSON.parse(await fs.readFile(new URL('../catalog/catalog.json', import.meta.url), 'utf8'));
  const { manifests } = await resolveCatalog(normalizeCatalog(raw).catalog, { readJson: async () => null });
  for (const m of manifests) {
    const { manifest, errors } = applyManifestEdit(m, {});
    assert.deepEqual(errors, [], m.id);
    const { edited, ...rest } = manifest;
    assert.deepEqual(rest, m, m.id); // deepEqual ignores key order
    assert.equal(editPatch(m, m).patch, null, m.id);
  }
});

test('the library keeps edits per generator', async () => {
  const library = new Library(await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-')));
  await library.load();
  await library.setEdit('cookie', { repo: 'alice/cookies' });
  const reloaded = new Library(library.dataDir);
  await reloaded.load();
  assert.deepEqual(reloaded.state.edits, { cookie: { repo: 'alice/cookies' } });
  await reloaded.setEdit('cookie', null);
  assert.deepEqual(reloaded.state.edits, {});
});
