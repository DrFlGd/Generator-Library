import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import { Library } from '../src/lib/library.js';
import { normalizeManifest } from '../src/lib/manifest.js';
import { checkForUpdate, installDistribution, uninstallDistribution } from '../src/lib/installer.js';

async function freshLibrary() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-lib-'));
  const library = new Library(dir);
  await library.load();
  return library;
}

// A GitHub stand-in that serves one release asset (a zip) and one repo tarball.
function fakeGitHub({ tag = 'v1.0.0', sha = 'aaaaaaaaaaaa1111', zipBytes, tarPath }) {
  return {
    async resolveReleaseAsset(repo, { asset }) {
      return { release: { tag, name: tag, publishedAt: '2026-10-27T00:00:00Z', body: 'notes', htmlUrl: 'https://x' }, asset: { name: asset.replace('*', '1.0.0'), url: 'asset://1', size: zipBytes?.length ?? 0 } };
    },
    async latestCommit(repo, ref) {
      return { sha, date: '2026-10-27T00:00:00Z', ref: ref || 'main' };
    },
    tarballUrl: () => 'tarball://x',
    async download(url, destination, { onProgress }) {
      if (url.startsWith('asset://')) await fs.writeFile(destination, zipBytes);
      else await fs.copyFile(tarPath, destination);
      onProgress?.({ received: 1, total: 1 });
    },
  };
}

test('installs a release zip as an exe, records it, finds updates and uninstalls', async () => {
  const library = await freshLibrary();
  const zipBytes = zipSync({ 'WebMirror/WebMirror.exe': strToU8('MZ'), 'WebMirror/readme.txt': strToU8('r') });
  const github = fakeGitHub({ zipBytes });
  const { manifest } = normalizeManifest(
    { id: 'wm', name: 'WebMirror', repo: 'o/r', distributions: [{ kind: 'exe', platform: 'windows', install: 'zip', exec: 'WebMirror/WebMirror.exe', from: { type: 'release', asset: 'WebMirror-Windows*.zip' } }] },
  );
  const dist = manifest.distributions[0];
  const phases = [];
  const record = await installDistribution(manifest, dist, { library, github, onProgress: (p) => phases.push(p.phase) });
  assert.equal(record.version, 'v1.0.0');
  assert.equal(record.exec, 'WebMirror/WebMirror.exe');
  assert.ok(phases.includes('download') && phases.includes('done'));
  assert.equal(await fs.readFile(path.join(record.dir, 'WebMirror', 'WebMirror.exe'), 'utf8'), 'MZ');
  assert.ok(library.getInstalled('wm', dist.key));
  assert.equal((await fs.readdir(library.downloadsDir)).length, 0, 'download cleaned up');

  const same = await checkForUpdate(manifest, dist, record, github);
  assert.equal(same.hasUpdate, false);
  const newer = await checkForUpdate(manifest, dist, record, fakeGitHub({ tag: 'v1.1.0', zipBytes }));
  assert.equal(newer.hasUpdate, true);
  assert.equal(newer.latest.version, 'v1.1.0');

  await uninstallDistribution(record, { library });
  assert.equal(library.getInstalled('wm', dist.key), null);
  await assert.rejects(fs.access(record.dir));
});

test('installs a repository subfolder as an offline bundle keyed by commit', async () => {
  const library = await freshLibrary();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-tar-'));
  await fs.mkdir(path.join(work, 'o-r-abc', 'site', 'lib'), { recursive: true });
  await fs.writeFile(path.join(work, 'o-r-abc', 'site', 'index.html'), 'site');
  await fs.writeFile(path.join(work, 'o-r-abc', 'site', 'lib', 'a.js'), 'js');
  await fs.writeFile(path.join(work, 'o-r-abc', 'README.md'), 'no');
  const tarPath = path.join(work, 'repo.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', work, 'o-r-abc']);
  const github = fakeGitHub({ tarPath });
  const { manifest } = normalizeManifest({ id: 'tp', name: 'TP', repo: 'o/r', distributions: [{ kind: 'bundle', from: { type: 'repo', path: 'site' } }] });
  const dist = manifest.distributions[0];
  const record = await installDistribution(manifest, dist, { library, github });
  assert.equal(record.entry, 'index.html');
  assert.equal(record.source.sha, 'aaaaaaaaaaaa1111');
  assert.equal(await fs.readFile(path.join(record.dir, 'lib', 'a.js'), 'utf8'), 'js');
  await assert.rejects(fs.access(path.join(record.dir, 'README.md')));
  const update = await checkForUpdate(manifest, dist, record, fakeGitHub({ sha: 'bbbbbbbbbbbb2222', tarPath }));
  assert.equal(update.hasUpdate, true);
});

test('installs a release tar.gz holding a bare executable, and a zipped macOS .app', async () => {
  const library = await freshLibrary();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-rel-'));
  await fs.writeFile(path.join(work, 'WebMirror'), '#!/bin/sh\n');
  const tarPath = path.join(work, 'WebMirror-Linux.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', work, 'WebMirror']);
  const github = {
    ...fakeGitHub({ tarPath }),
    async resolveReleaseAsset() {
      return { release: { tag: 'build-7', name: 'b', publishedAt: '', body: '', htmlUrl: '' }, asset: { name: 'WebMirror-Linux.tar.gz', url: 'tarball://x', size: 1 } };
    },
  };
  const { manifest } = normalizeManifest({ id: 'wm', name: 'WM', repo: 'o/r', distributions: [{ kind: 'exe', platform: 'linux', install: 'zip', exec: 'WebMirror', from: { type: 'release', asset: 'WebMirror-Linux.tar.gz' } }] });
  const record = await installDistribution(manifest, manifest.distributions[0], { library, github });
  assert.equal(record.exec, 'WebMirror');
  assert.equal(await fs.readFile(path.join(record.dir, 'WebMirror'), 'utf8'), '#!/bin/sh\n');

  const zipBytes = zipSync({ 'WebMirror.app/Contents/MacOS/WebMirror': strToU8('bin'), 'WebMirror.app/Contents/Info.plist': strToU8('<plist/>') });
  const mac = normalizeManifest({ id: 'wmm', name: 'WM', repo: 'o/r', distributions: [{ kind: 'exe', platform: 'macos', install: 'zip', exec: 'WebMirror.app', from: { type: 'release', asset: 'WebMirror-macOS.zip' } }] }).manifest;
  const macRecord = await installDistribution(mac, mac.distributions[0], { library, github: fakeGitHub({ zipBytes }) });
  assert.equal(macRecord.exec, 'WebMirror.app');
});

test('a bundle with no html entry is rejected and leaves nothing behind', async () => {
  const library = await freshLibrary();
  const zipBytes = zipSync({ 'data.bin': strToU8('x') });
  const { manifest } = normalizeManifest({ id: 'bad', name: 'Bad', repo: 'o/r', distributions: [{ kind: 'bundle', from: { type: 'release', asset: 'site-*.zip' } }] });
  await assert.rejects(installDistribution(manifest, manifest.distributions[0], { library, github: fakeGitHub({ zipBytes }) }), /no HTML entry/);
  assert.equal(library.getInstalled('bad', 'bundle'), null);
  await assert.rejects(fs.access(library.installDir('bad', 'bundle')));
});

test('library state round-trips favorites, recents, sources and settings', async () => {
  const library = await freshLibrary();
  assert.equal(await library.toggleFavorite('a'), true);
  await library.touchRecent('a');
  await library.touchRecent('b');
  assert.equal(await library.addSource({ repo: 'o/x' }), true);
  assert.equal(await library.addSource({ repo: 'O/X' }), false, 'case-insensitive duplicate');
  await library.updateSettings({ githubToken: 't' });
  const again = new Library(library.dataDir);
  await again.load();
  assert.deepEqual(again.state.favorites, ['a']);
  assert.deepEqual(again.state.recent, ['b', 'a']);
  assert.equal(again.state.sources.length, 1);
  assert.equal(again.state.settings.githubToken, 't');
  assert.equal(again.state.settings.catalogRepo, 'DrFlGd/Generator-Library');
});
