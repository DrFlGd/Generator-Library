import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../src/lib/library.js';

test('a thumbnail is a JPEG in the library folder, recorded by file name, and removable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-thumb-'));
  const library = new Library(dir);
  await library.load();
  assert.deepEqual(library.state.thumbnails, {});

  const record = await library.setThumbnail('owner/name:box', Buffer.from('jpeg'));
  assert.equal(record.file, 'owner_name_box.jpg');
  assert.equal(await fs.readFile(path.join(dir, 'thumbnails', record.file), 'utf8'), 'jpeg');

  const reloaded = new Library(dir);
  await reloaded.load();
  assert.equal(reloaded.state.thumbnails['owner/name:box'].file, record.file);

  assert.equal(await reloaded.setThumbnail('owner/name:box', null), null);
  await assert.rejects(fs.access(path.join(dir, 'thumbnails', record.file)));
  assert.deepEqual(reloaded.state.thumbnails, {});
});
