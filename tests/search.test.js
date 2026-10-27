import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facets, search } from '../src/lib/search.js';
import { normalizeManifest } from '../src/lib/manifest.js';

const make = (raw) => normalizeManifest({ repo: 'o/r', ...raw }).manifest;
const set = [
  make({ id: 'terrain-press', name: 'Terrain Press', summary: 'NASA elevation ornaments', tags: ['terrain', 'ornament'], process: '3d-print', distributions: [{ kind: 'web', url: 'https://t/' }, { kind: 'exe', platform: 'windows', from: { type: 'release', asset: 'a.exe' } }] }),
  make({ id: 'laser-box', name: 'Laser Box', summary: 'Boxes for laser cutting', tags: ['boxes'], process: 'laser', distributions: [{ kind: 'web', url: 'https://l/' }] }),
  make({ id: 'keycap', name: 'Custom Keycap Generator', summary: 'Keycaps with icons', tags: ['desk-home'], process: '3d-print', distributions: [{ kind: 'web', url: 'https://k/' }, { kind: 'mirror', url: 'https://k/' }] }),
];

test('empty query returns everything alphabetically', () => {
  assert.deepEqual(search(set, '').map((m) => m.id), ['keycap', 'laser-box', 'terrain-press']);
});

test('name hits rank above description hits and every word must match', () => {
  assert.deepEqual(search(set, 'laser').map((m) => m.id), ['laser-box']);
  assert.deepEqual(search(set, 'terrain nasa').map((m) => m.id), ['terrain-press']);
  assert.deepEqual(search(set, 'terrain laser').map((m) => m.id), []);
  assert.deepEqual(search(set, 'key').map((m) => m.id), ['keycap']);
});

test('filters narrow by tag, process, kind, platform and installed state', () => {
  assert.deepEqual(search(set, '', { tags: ['boxes'] }).map((m) => m.id), ['laser-box']);
  assert.deepEqual(search(set, '', { process: '3d-print' }).map((m) => m.id), ['keycap', 'terrain-press']);
  assert.deepEqual(search(set, '', { kinds: ['exe'] }).map((m) => m.id), ['terrain-press']);
  assert.deepEqual(search(set, '', { kinds: ['exe'], platform: 'macos' }).map((m) => m.id), ['terrain-press'], 'web still usable on macOS');
  assert.deepEqual(search(set, '', { installed: true }, new Set(['keycap'])).map((m) => m.id), ['keycap']);
  assert.deepEqual(search(set, '', { installed: false }, new Set(['keycap'])).map((m) => m.id), ['laser-box', 'terrain-press']);
});

test('facets count tags, processes and kinds', () => {
  const f = facets(set);
  assert.deepEqual(f.processes, [{ value: '3d-print', count: 2 }, { value: 'laser', count: 1 }]);
  assert.equal(f.kinds.find((k) => k.value === 'web').count, 3);
  assert.ok(f.tags.some((t) => t.value === 'terrain' && t.count === 1));
});
