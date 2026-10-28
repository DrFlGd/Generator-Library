// A copy of a generator's GitHub repository, saved beside its installed copies
// to work on later. It is the files at the newest commit of the default branch
// (GitHub's tarball, so no git history), kept whether or not they run as they
// are. One copy per generator; saving again replaces it when there is a newer
// commit.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extractTarGz } from './archive.js';
import { dirSize, replaceDir } from './installer.js';

export async function saveCode(manifest, { library, github, onProgress = () => {} }) {
  if (!manifest.repo) throw new Error(`${manifest.name} has no GitHub repository`);
  onProgress({ message: `Looking up the newest commit of ${manifest.repo}` });
  const latest = await github.latestCommit(manifest.repo);
  const existing = library.getCode(manifest.id);
  if (existing?.sha === latest.sha && existing.repo === manifest.repo && (await fs.stat(existing.dir).catch(() => null))) {
    onProgress({ message: 'The saved copy is already the newest commit' });
    return existing;
  }

  const finalDir = library.codeDir(manifest.id, latest.sha);
  const stagingDir = `${finalDir}.staging`;
  const downloadPath = path.join(library.downloadsDir, `${manifest.id}-${Date.now()}-source.tar.gz`);
  try {
    const name = `${manifest.repo} at ${latest.sha.slice(0, 7)}`;
    onProgress({ message: `Downloading ${name}`, received: 0, total: 0 });
    await github.download(github.tarballUrl(manifest.repo, latest.sha), downloadPath, { onProgress: (p) => onProgress({ message: `Downloading ${name}`, ...p }) });
    onProgress({ message: 'Unpacking' });
    await fs.rm(stagingDir, { recursive: true, force: true });
    // Executable bits matter in a working copy (build scripts); links are left out.
    const { written } = await extractTarGz(downloadPath, stagingDir, { modes: true });
    await replaceDir(stagingDir, finalDir);
    const record = {
      id: manifest.id,
      repo: manifest.repo,
      ref: latest.ref,
      sha: latest.sha,
      committedAt: latest.date,
      dir: finalDir,
      files: written.length,
      sizeBytes: await dirSize(finalDir),
      savedAt: new Date().toISOString(),
    };
    await library.setCode(manifest.id, record);
    if (existing && existing.dir !== finalDir) await fs.rm(existing.dir, { recursive: true, force: true });
    onProgress({ message: `Saved ${written.length} files` });
    return record;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(downloadPath, { force: true });
  }
}

export async function removeCode(id, { library }) {
  const record = library.getCode(id);
  if (!record) return false;
  await fs.rm(record.dir, { recursive: true, force: true });
  await library.setCode(id, null);
  return true;
}
