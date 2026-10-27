import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPython, listWebMirrorSnapshots, mirrorSite, parseMirrorOutput } from '../src/lib/mirror.js';

function fakeChild({ stdout = [], stderr = '', code = 0 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    for (const line of stdout) child.stdout.emit('data', Buffer.from(line));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('exit', code);
  });
  return child;
}

test('parseMirrorOutput separates progress from the final record', () => {
  const { messages, result } = parseMirrorOutput(['{"progress":"Saved 1"}', 'noise', '{"record":{"key":"k"},"dir":"/d"}']);
  assert.deepEqual(messages, ['Saved 1']);
  assert.equal(result.dir, '/d');
});

test('findPython returns the first interpreter that can import webmirror', async () => {
  const tried = [];
  const spawnImpl = (cmd) => {
    tried.push(cmd);
    return fakeChild({ code: cmd === 'python' ? 0 : 1 });
  };
  assert.equal(await findPython('', { spawnImpl }), 'python');
  assert.ok(tried.includes('python3') || tried.includes('py'));
  assert.equal(await findPython('', { spawnImpl: () => fakeChild({ code: 1 }) }), null);
});

test('mirrorSite streams progress and resolves with the record', async () => {
  const progress = [];
  const spawnImpl = (cmd, args) => {
    if (args[1] === 'import webmirror') return fakeChild({ code: 0 });
    return fakeChild({ stdout: ['{"progress":"one"}\n{"progress":"two"}\n', '{"record":{"key":"site-abc","url":"https://x","entry":"index.html","saved_at":"2026"},"dir":"/m/site-abc"}\n'] });
  };
  const result = await mirrorSite({ url: 'https://x', onProgress: (m) => progress.push(m), spawnImpl });
  assert.deepEqual(progress, ['one', 'two']);
  assert.equal(result.record.key, 'site-abc');
});

test('mirrorSite reports the last stderr line when WebMirror fails', async () => {
  const spawnImpl = (cmd, args) => (args[1] === 'import webmirror' ? fakeChild({ code: 0 }) : fakeChild({ stderr: 'Traceback\nValueError: bad url', code: 1 }));
  await assert.rejects(mirrorSite({ url: 'https://x', spawnImpl }), /ValueError: bad url/);
  await assert.rejects(mirrorSite({ url: 'https://x', spawnImpl: () => fakeChild({ code: 1 }) }), /WebMirror is not available/);
});

test('listWebMirrorSnapshots reads manifests the way WebMirror writes them', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-'));
  const good = path.join(home, 'mirrors', 'example-com-0123456789ab');
  await fs.mkdir(good, { recursive: true });
  await fs.writeFile(path.join(good, 'manifest.json'), JSON.stringify({ key: 'example-com-0123456789ab', url: 'https://example.com/', entry: '/index.html', saved_at: '2026-10-27', files: 1, pages: 1, failures: 0 }));
  await fs.writeFile(path.join(good, 'index.html'), 'x');
  const broken = path.join(home, 'mirrors', 'broken-000000000000');
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(path.join(broken, 'manifest.json'), JSON.stringify({ key: 'broken-000000000000', url: 'https://b/', entry: '/index.html', saved_at: '2026' }));
  const snaps = await listWebMirrorSnapshots(home);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].dir, good);
  assert.deepEqual(await listWebMirrorSnapshots(path.join(home, 'nope')), []);
});
