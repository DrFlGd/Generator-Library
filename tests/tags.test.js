import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, applyTagEdits, normalizeTag } from '../src/lib/library.js';

test('normalizeTag makes lowercase dashed words', () => {
  assert.equal(normalizeTag('  Pegboard Hooks '), 'pegboard-hooks');
  assert.equal(normalizeTag('3D/Print!'), '3d-print');
  assert.equal(normalizeTag('   '), '');
});

test('your tags are kept as edits, so catalog changes still come through', async () => {
  const library = new Library(await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-')));
  await library.load();
  const catalogTags = ['boxes', 'organizer'];
  assert.deepEqual(await library.setTags('box', ['boxes', 'My Shelf'], catalogTags), ['boxes', 'my-shelf']);
  assert.deepEqual(library.state.tagEdits.box, { added: ['my-shelf'], removed: ['organizer'] });
  // The catalog later adds a tag: it shows up beside yours.
  assert.deepEqual(applyTagEdits(['boxes', 'organizer', 'gridfinity'], library.state.tagEdits.box), ['boxes', 'gridfinity', 'my-shelf']);
  // Setting the catalog's own tags again drops the edit.
  await library.setTags('box', catalogTags, catalogTags);
  assert.equal(library.state.tagEdits.box, undefined);
  const reloaded = new Library(library.dataDir);
  await reloaded.load();
  assert.deepEqual(reloaded.state.tagEdits, {});
});

test('setFavorite adds and removes once', async () => {
  const library = new Library(await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-')));
  await library.load();
  await library.setFavorite('a', true);
  await library.setFavorite('a', true);
  assert.deepEqual(library.state.favorites, ['a']);
  await library.setFavorite('a', false);
  assert.deepEqual(library.state.favorites, []);
});

test('editCollections creates, fills, renames and deletes your collections', async () => {
  const { editCollections } = await import('../src/lib/library.js');
  let list = editCollections([], { type: 'create', name: '  Workshop ', ids: ['a', 'a'] }, 1000);
  assert.deepEqual(list, [{ id: 'crs', name: 'Workshop', ids: ['a'] }]);
  list = editCollections(list, { type: 'create', name: 'Gifts' }, 1000);
  assert.equal(list[1].id, 'crsx', 'ids stay unique');
  list = editCollections(list, { type: 'set', collection: 'crs', id: 'b', member: true });
  list = editCollections(list, { type: 'set', collection: 'crs', id: 'a', member: false });
  assert.deepEqual(list[0].ids, ['b']);
  list = editCollections(list, { type: 'rename', collection: 'crsx', name: 'Presents' });
  assert.equal(list[1].name, 'Presents');
  list = editCollections(list, { type: 'delete', collection: 'crs' });
  assert.deepEqual(list.map((c) => c.name), ['Presents']);
  assert.throws(() => editCollections(list, { type: 'create', name: ' ' }), /name/);
  assert.throws(() => editCollections(list, { type: 'set', collection: 'gone', id: 'a', member: true }), /no longer exists/);
});

test('setOfflineMark records whether a mirror works offline', async () => {
  const library = new Library(await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-')));
  await library.load();
  await library.setOfflineMark('site', 'broken');
  assert.deepEqual(library.state.offlineMarks, { site: 'broken' });
  await library.setOfflineMark('site', '');
  assert.deepEqual(library.state.offlineMarks, {});
  await assert.rejects(library.setOfflineMark('site', 'maybe'), /Unknown offline mark/);
});
