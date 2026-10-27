import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDefaults, normalizeCollection, normalizeManifest, overlayManifest, usableDistributions } from '../src/lib/manifest.js';

const minimal = () => ({ id: 'thing', name: 'Thing', distributions: [{ kind: 'web', url: 'https://example.com/' }] });

test('a minimal manifest normalizes with defaults', () => {
  const { manifest, errors } = normalizeManifest(minimal(), { repo: 'o/r' });
  assert.deepEqual(errors, []);
  assert.equal(manifest.repo, 'o/r');
  assert.equal(manifest.distributions[0].label, 'Open online');
  assert.equal(manifest.distributions[0].key, 'web');
  assert.deepEqual(manifest.tags, []);
});

test('repo is required for downloads when not read from a repository, not for a website', () => {
  const download = normalizeManifest({ ...minimal(), distributions: [{ kind: 'bundle', from: { type: 'release', asset: 'web.zip' } }] });
  assert.equal(download.manifest, null);
  assert.ok(download.errors.some((e) => e.includes('"repo"')));
  const site = normalizeManifest({ ...minimal(), distributions: [{ kind: 'web', url: 'https://example.com/' }, { kind: 'mirror', url: 'https://example.com/' }] });
  assert.deepEqual(site.errors, []);
  assert.equal(site.manifest.repo, '');
});

test('ids must be lowercase slugs', () => {
  const { errors } = normalizeManifest({ ...minimal(), id: 'Bad Id' }, { repo: 'o/r' });
  assert.ok(errors.some((e) => e.includes('"id"')));
});

test('release and repo sources are validated', () => {
  const raw = {
    ...minimal(),
    distributions: [
      { kind: 'exe', platform: 'windows', from: { type: 'release', asset: 'App-*.exe', tag: 'desktop-v*' } },
      { kind: 'bundle', from: { type: 'repo', path: '/site/' } },
      { kind: 'exe', platform: 'linux', install: 'zip', from: { type: 'release', asset: 'x.zip' } },
    ],
  };
  const { manifest, errors } = normalizeManifest(raw, { repo: 'o/r' });
  assert.equal(manifest, null, 'zip without exec must fail');
  assert.ok(errors.some((e) => e.includes('exec')));
  raw.distributions[2].exec = 'bin/x';
  const ok = normalizeManifest(raw, { repo: 'o/r' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.manifest.distributions[0].from.tag, 'desktop-v*');
  assert.equal(ok.manifest.distributions[0].install, 'portable');
  assert.equal(ok.manifest.distributions[1].from.path, 'site');
  assert.equal(ok.manifest.distributions[1].entry, 'index.html');
  assert.equal(ok.manifest.distributions[2].key, 'exe:linux:zip');
});

test('exe distributions need a platform; paths may not escape', () => {
  const { errors } = normalizeManifest(
    { ...minimal(), distributions: [{ kind: 'exe', from: { type: 'repo', path: '../etc' } }] },
    { repo: 'o/r' },
  );
  assert.ok(errors.some((e) => e.includes('platform')));
  assert.ok(errors.some((e) => e.includes('..')));
});

test('duplicate distribution shapes get distinct keys', () => {
  const { manifest } = normalizeManifest(
    { ...minimal(), distributions: [{ kind: 'web', url: 'https://a/' }, { kind: 'web', url: 'https://b/' }] },
    { repo: 'o/r' },
  );
  assert.deepEqual(manifest.distributions.map((d) => d.key), ['web', 'web-2']);
});

test('usableDistributions filters by platform', () => {
  const { manifest } = normalizeManifest(
    {
      ...minimal(),
      distributions: [
        { kind: 'web', url: 'https://a/' },
        { kind: 'exe', platform: 'windows', from: { type: 'release', asset: 'a.exe' } },
        { kind: 'exe', platform: 'linux', from: { type: 'release', asset: 'a' } },
      ],
    },
    { repo: 'o/r' },
  );
  assert.deepEqual(usableDistributions(manifest, 'windows').map((d) => d.key), ['web', 'exe:windows:portable']);
  assert.deepEqual(usableDistributions(manifest, 'macos').map((d) => d.key), ['web']);
});

test('collections apply defaults and merge tags', () => {
  const { collection, errors } = normalizeCollection(
    { id: 'col', generators: [{ path: 'apps/a/generator.json' }, { id: 'b', name: 'B', tags: ['x'], distributions: [{ kind: 'web', url: 'https://b/' }] }], defaults: { tags: ['shared'], process: '3d-print' } },
    { repo: 'o/r' },
  );
  assert.deepEqual(errors, []);
  assert.equal(collection.entries[0].path, 'apps/a/generator.json');
  const merged = applyDefaults(collection.entries[1].inline, collection.defaults);
  assert.deepEqual(merged.tags, ['shared', 'x']);
  assert.equal(merged.process, '3d-print');
});

test('overlayManifest replaces fields and unions tags', () => {
  const base = { id: 'a', name: 'A', tags: ['one'], distributions: [{ kind: 'web', url: 'https://a/' }] };
  const out = overlayManifest(base, { name: 'A!', tags: ['two'], summary: 's' });
  assert.equal(out.name, 'A!');
  assert.deepEqual(out.tags, ['one', 'two']);
  assert.equal(out.summary, 's');
  assert.equal(out.distributions.length, 1);
  assert.equal(overlayManifest(null, { id: 'x' }).id, 'x');
  assert.equal(overlayManifest(base, null), base);
});
