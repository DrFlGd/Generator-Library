import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRuntimes, findPythonAsset, packageIsStale, pythonExecutable, pythonTriple, PYTHON_BUILD, WEBMIRROR_REQUIREMENT } from '../src/lib/runtimes.js';
import { mergeRequires, normalizeManifest, normalizeRequires } from '../src/lib/manifest.js';
import { createJobs } from '../src/lib/jobs.js';
import { extractTarGz } from '../src/lib/archive.js';
import { Library } from '../src/lib/library.js';

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'genlib-rt-'));
}

function fakeChild({ code = 0, out = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (out) child.stdout.emit('data', Buffer.from(out));
    child.emit('exit', code);
  });
  return child;
}

const SUMS = [
  `${'a'.repeat(64)}  cpython-3.12.16+20261026-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
  `${'b'.repeat(64)}  cpython-3.12.16+20261026-x86_64-pc-windows-msvc-install_only.tar.gz`,
  `${'c'.repeat(64)}  cpython-3.13.9+20261026-x86_64-pc-windows-msvc-install_only.tar.gz`,
  `${'d'.repeat(64)}  cpython-3.12.16+20261026-x86_64-unknown-linux-gnu-install_only.tar.gz`,
].join('\n');

test('findPythonAsset picks the install_only build for the minor version and platform', () => {
  assert.deepEqual(findPythonAsset(SUMS, { minor: '3.12', triple: 'x86_64-pc-windows-msvc' }), {
    sha256: 'b'.repeat(64),
    name: 'cpython-3.12.16+20261026-x86_64-pc-windows-msvc-install_only.tar.gz',
    version: '3.12.16',
  });
  assert.equal(findPythonAsset(SUMS, { minor: '3.12', triple: 'aarch64-apple-darwin' }), null);
  assert.equal(pythonTriple('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.throws(() => pythonTriple('freebsd', 'x64'), /Python path/);
  assert.equal(pythonExecutable('/r', 'win32'), path.join('/r', 'python.exe'));
  assert.equal(pythonExecutable('/r', 'linux'), path.join('/r', 'bin', 'python3'));
});

test('requires is validated on manifests and distributions and merged per runtime', () => {
  const errors = [];
  assert.deepEqual(normalizeRequires([{ runtime: 'python', packages: ['numpy', { spec: 'x @ https://e/x.zip', import: 'x' }] }], errors), [
    { runtime: 'python', packages: [{ spec: 'numpy' }, { spec: 'x @ https://e/x.zip', import: 'x' }] },
  ]);
  assert.deepEqual(errors, []);
  normalizeRequires([{ runtime: 'ruby' }], errors);
  assert.match(errors[0], /"runtime" must be "python"/);

  const { manifest } = normalizeManifest({
    id: 'needs-py',
    name: 'Needs Python',
    repo: 'o/r',
    requires: [{ runtime: 'python', packages: ['numpy'] }],
    distributions: [{ kind: 'mirror', url: 'https://example.com/', requires: [{ runtime: 'python', packages: ['numpy', 'scipy'] }] }],
  });
  const merged = mergeRequires(manifest.requires, manifest.distributions[0].requires, [WEBMIRROR_REQUIREMENT]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].packages.map((p) => p.spec.split(' ')[0]), ['numpy', 'scipy', 'webmirror[dynamic]']);
  assert.equal(normalizeManifest({ id: 'x', name: 'X', repo: 'o/r', requires: 'python', distributions: [{ kind: 'web', url: 'https://e/' }] }).manifest, null);
});

test('a Python set in Settings is used when it can import, and never modified', async () => {
  const dir = await tmp();
  const library = new Library(dir);
  await library.load();
  await library.updateSettings({ pythonPath: '/usr/bin/my-python' });
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push([cmd, ...args]);
    return fakeChild({ code: 0 });
  };
  const runtimes = createRuntimes({ library, spawnImpl, fetchImpl: () => assert.fail('no download'), download: () => assert.fail('no download') });
  const { python } = await runtimes.ensure([WEBMIRROR_REQUIREMENT]);
  assert.equal(python, '/usr/bin/my-python');
  assert.deepEqual(calls, [['/usr/bin/my-python', '-c', 'import webmirror']]);

  const failing = createRuntimes({ library, spawnImpl: () => fakeChild({ code: 1 }), download: () => assert.fail('no download') });
  await assert.rejects(failing.ensure([WEBMIRROR_REQUIREMENT]), /cannot import webmirror/);
});

test('a package that follows a branch is due again after its refresh time', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(packageIsStale({ spec: 'x', refreshHours: 24 }, '2026-10-27T11:00:00Z', now), true);
  assert.equal(packageIsStale({ spec: 'x', refreshHours: 24 }, '2026-10-28T01:00:00Z', now), false);
  assert.equal(packageIsStale({ spec: 'x' }, '2020-01-01T00:00:00Z', now), false);
  // A copy from before a fix the library needs is replaced even when it is new.
  assert.equal(packageIsStale({ spec: 'x', refreshHours: 24, refreshAfter: '2026-10-28T11:00:00Z' }, '2026-10-28T10:00:00Z', now), true);
  assert.equal(packageIsStale({ spec: 'x', refreshHours: 24, refreshAfter: '2026-10-28T11:00:00Z' }, '2026-10-28T11:30:00Z', now), false);
});

test('the managed Python is downloaded, checksummed, unpacked and given its packages once', async () => {
  const dir = await tmp();
  const library = new Library(path.join(dir, 'data'));
  await library.load();

  // A stand-in interpreter archive shaped like python-build-standalone's.
  const src = path.join(dir, 'src', 'python');
  const exe = process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3');
  await fs.mkdir(path.dirname(path.join(src, exe)), { recursive: true });
  await fs.writeFile(path.join(src, exe), '#!/bin/sh\n');
  await fs.chmod(path.join(src, exe), 0o755);
  const archive = path.join(dir, 'py.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', path.join(dir, 'src'), 'python']);
  const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  const name = `cpython-${PYTHON_BUILD.minor}.7+${PYTHON_BUILD.tag}-${pythonTriple()}-install_only.tar.gz`;

  const fetchImpl = async (url) => {
    assert.equal(url, `${PYTHON_BUILD.base}/${PYTHON_BUILD.tag}/SHA256SUMS`);
    return new Response(`${digest}  ${name}\n`);
  };
  const downloads = [];
  const download = async (url, dest) => {
    downloads.push(url);
    await fs.copyFile(archive, dest);
  };
  const spawned = [];
  const spawnImpl = (cmd, args) => {
    spawned.push([path.basename(cmd), ...args.slice(0, 3)]);
    return fakeChild({ code: 0 });
  };
  const runtimes = createRuntimes({ library, fetchImpl, download, spawnImpl });
  const log = [];
  const { python } = await runtimes.ensure([WEBMIRROR_REQUIREMENT], { log: (l) => log.push(l), progress: () => {} });
  assert.equal(python, pythonExecutable(path.join(library.dataDir, 'runtimes', 'python')));
  await fs.access(python);
  if (process.platform !== 'win32') assert.ok(((await fs.stat(python)).mode & 0o111) !== 0, 'kept the executable bit');
  assert.equal(downloads.length, 1);
  assert.ok(spawned.some((c) => c[1] === '-m' && c[2] === 'pip'), 'pip installed WebMirror');
  assert.equal(library.state.runtimes.python.version, `${PYTHON_BUILD.minor}.7`);
  assert.ok(log.some((l) => /installing a private copy/.test(l)));

  spawned.length = 0;
  await runtimes.ensure([WEBMIRROR_REQUIREMENT]);
  assert.equal(downloads.length, 1, 'not downloaded again');
  assert.equal(spawned.length, 0, 'packages not reinstalled');
  assert.deepEqual(runtimes.status().python.managed.packages, [WEBMIRROR_REQUIREMENT.packages[0].spec]);

  // A day later WebMirror, which follows its main branch, is reinstalled when needed.
  const spec = WEBMIRROR_REQUIREMENT.packages[0].spec;
  library.state.runtimes.python.packages[spec] = new Date(Date.now() - 2 * 86400000).toISOString();
  const full = [];
  const refreshing = createRuntimes({ library, fetchImpl, download, spawnImpl: (cmd, args) => (full.push(args), fakeChild({ code: 0 })) });
  await refreshing.ensure([WEBMIRROR_REQUIREMENT]);
  assert.ok(full.some((args) => args.includes('--force-reinstall') && args.includes('--no-deps') && args.includes(spec)));
  assert.ok(Date.now() - Date.parse(library.state.runtimes.python.packages[spec]) < 60000, 'refresh time recorded');

  // Offline: the update fails, the installed copy is kept and used.
  library.state.runtimes.python.packages[spec] = new Date(Date.now() - 2 * 86400000).toISOString();
  const offlineLog = [];
  const offline = createRuntimes({ library, fetchImpl, download, spawnImpl: () => fakeChild({ code: 1 }) });
  const kept = await offline.ensure([WEBMIRROR_REQUIREMENT], { log: (l) => offlineLog.push(l), progress: () => {} });
  assert.equal(kept.python, python);
  assert.ok(offlineLog.some((l) => /Could not update webmirror; using the installed copy/.test(l)));

  await runtimes.remove();
  assert.equal(runtimes.status().python.managed, null);
  await assert.rejects(fs.access(python));
});

test('a download that does not match its checksum is refused', async () => {
  const dir = await tmp();
  const library = new Library(dir);
  await library.load();
  const name = `cpython-${PYTHON_BUILD.minor}.7+${PYTHON_BUILD.tag}-${pythonTriple()}-install_only.tar.gz`;
  const runtimes = createRuntimes({
    library,
    fetchImpl: async () => new Response(`${'0'.repeat(64)}  ${name}\n`),
    download: async (_url, dest) => fs.writeFile(dest, 'not python'),
    spawnImpl: () => fakeChild(),
  });
  await assert.rejects(runtimes.installPython(), /checksum/);
  assert.equal(library.state.runtimes.python, undefined);
});

test('extractTarGz recreates symlinks that stay inside the destination only when asked', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmp();
  const src = path.join(dir, 'top');
  await fs.mkdir(path.join(src, 'bin'), { recursive: true });
  await fs.writeFile(path.join(src, 'bin', 'python3.12'), 'py');
  await fs.symlink('python3.12', path.join(src, 'bin', 'python3'));
  await fs.symlink('../../../etc/passwd', path.join(src, 'bin', 'escape'));
  const archive = path.join(dir, 'a.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', dir, 'top']);

  const out = path.join(dir, 'out');
  const { written, skipped } = await extractTarGz(archive, out, { symlinks: true });
  assert.ok(written.includes('bin/python3'));
  assert.equal(await fs.readlink(path.join(out, 'bin', 'python3')), 'python3.12');
  assert.ok(skipped.some((s) => s.endsWith('bin/escape')));

  const plain = path.join(dir, 'plain');
  const result = await extractTarGz(archive, plain);
  assert.ok(!result.written.includes('bin/python3'), 'symlinks are ignored by default');
});

test('jobs record progress, logs and failures, and keep the error for the UI', async () => {
  const events = [];
  const jobs = createJobs({ emit: (channel, list) => events.push([channel, list]) });
  const value = await jobs.run({ title: 'Installing X', target: { id: 'x', distKey: 'bundle' } }, async (job) => {
    job.log('step one');
    job.progress({ message: 'Downloading', received: 5, total: 10 });
    return 42;
  });
  assert.equal(value, 42);
  await assert.rejects(jobs.run({ title: 'Mirroring Y' }, async () => {
    throw new Error('Python missing');
  }), /Python missing/);
  const [failed, done] = jobs.list();
  assert.equal(done.status, 'done');
  assert.deepEqual(done.log, ['step one']);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'Python missing');
  assert.ok(events.every(([channel]) => channel === 'jobs:changed'));
  assert.equal(jobs.clearFinished().length, 0);
});
