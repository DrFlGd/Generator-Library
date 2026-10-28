import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Library } from '../src/lib/library.js';
import { removeCode, saveCode } from '../src/lib/source.js';

async function repoTarball(files) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-src-'));
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(work, 'o-r-abc', name)), { recursive: true });
    await fs.writeFile(path.join(work, 'o-r-abc', name), text);
  }
  await fs.chmod(path.join(work, 'o-r-abc', 'build.sh'), 0o755);
  const tarPath = path.join(work, 'repo.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', work, 'o-r-abc']);
  return tarPath;
}

function fakeGitHub(sha, tarPath) {
  const calls = { downloads: 0 };
  return {
    calls,
    async latestCommit() {
      return { sha, date: '2026-10-20T00:00:00Z', ref: 'main' };
    },
    tarballUrl: (repo, ref) => `tarball://${repo}/${ref}`,
    async download(url, destination) {
      calls.downloads++;
      await fs.copyFile(tarPath, destination);
    },
  };
}

test("saves a generator's repository beside its installs, replaces it with a newer commit and removes it", async () => {
  const library = new Library(await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-lib-')));
  await library.load();
  const manifest = { id: 'colorplate', name: 'ColorPlate', repo: 'kurenn/colorplate' };
  const tarPath = await repoTarball({ 'README.md': '# ColorPlate', 'backend/main.py': 'app = None', 'build.sh': '#!/bin/sh' });

  const first = await saveCode(manifest, { library, github: fakeGitHub('a'.repeat(40), tarPath) });
  assert.equal(path.dirname(first.dir), path.join(library.appsDir, 'colorplate'), 'next to the installed copies');
  assert.equal(await fs.readFile(path.join(first.dir, 'backend', 'main.py'), 'utf8'), 'app = None');
  assert.equal(first.files, 3);
  if (process.platform !== 'win32') assert.ok((await fs.stat(path.join(first.dir, 'build.sh'))).mode & 0o100, 'scripts stay executable');
  assert.deepEqual(library.getCode('colorplate'), first);
  assert.equal((await fs.readdir(library.downloadsDir)).length, 0, 'download cleaned up');

  const same = fakeGitHub('a'.repeat(40), tarPath);
  assert.deepEqual(await saveCode(manifest, { library, github: same }), first);
  assert.equal(same.calls.downloads, 0, 'nothing to fetch at the same commit');

  const newer = await saveCode(manifest, { library, github: fakeGitHub('b'.repeat(40), tarPath) });
  assert.notEqual(newer.dir, first.dir);
  await assert.rejects(fs.stat(first.dir), 'the older copy is replaced');

  const reloaded = new Library(library.dataDir);
  await reloaded.load();
  assert.equal(reloaded.getCode('colorplate').sha, 'b'.repeat(40));
  assert.equal(await removeCode('colorplate', { library: reloaded }), true);
  await assert.rejects(fs.stat(newer.dir));
  assert.equal(reloaded.getCode('colorplate'), null);

  await assert.rejects(saveCode({ id: 'x', name: 'X', repo: '' }, { library, github: same }), /no GitHub repository/);
});
