// Turn a distribution into files on disk and a record the library can launch and
// later compare against GitHub for updates.
//
// A record looks like:
//   { id, distKey, kind, install?, version, source: { type, repo, tag?|ref?, sha?, asset? },
//     dir, entry?|exec?, installedAt, sizeBytes }
//
// `version` is whatever identifies the installed build on GitHub: the release tag
// for release assets, the commit sha for repository trees. The updater only has to
// compare that string with the newest one GitHub reports.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { distributionKey } from './manifest.js';
import { extractTarGz, extractZip } from './archive.js';

async function dirSize(dir) {
  let total = 0;
  const walk = async (d) => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else total += (await fs.stat(p)).size;
    }
  };
  try {
    await walk(dir);
  } catch {
    /* partial sizes are fine */
  }
  return total;
}

async function replaceDir(stagingDir, finalDir) {
  await fs.rm(finalDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(finalDir), { recursive: true });
  await fs.rename(stagingDir, finalDir);
}

// Resolve what the newest available build of a distribution is, without
// downloading it. Used both before an install and by the update check.
export async function resolveLatest(manifest, dist, github) {
  const from = dist.from;
  const repo = from.repo || manifest.repo;
  if (from.type === 'release') {
    const { release, asset } = await github.resolveReleaseAsset(repo, { tag: from.tag, asset: from.asset, prerelease: from.prerelease });
    return {
      type: 'release',
      repo,
      tag: release.tag,
      version: release.tag,
      releaseName: release.name,
      publishedAt: release.publishedAt,
      asset: asset.name,
      assetUrl: asset.url,
      size: asset.size,
      notes: release.body,
      htmlUrl: release.htmlUrl,
    };
  }
  const commit = await github.latestCommit(repo, from.ref);
  return { type: 'repo', repo, ref: commit.ref, sha: commit.sha, version: commit.sha.slice(0, 12), publishedAt: commit.date, path: from.path };
}

function entryUnderExtracted(dir, written, preferred) {
  if (preferred && written.includes(preferred)) return preferred;
  // Single-file bundles (Generator-Standalone's offline html) and zips with one
  // folder at the top are both common; find the first html file.
  const html = written.filter((f) => /\.html?$/i.test(f)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return html.find((f) => path.basename(f).toLowerCase() === 'index.html') ?? html[0];
}

export async function installDistribution(manifest, dist, { library, github, onProgress = () => {} }) {
  const distKey = distributionKey(dist);
  const finalDir = library.installDir(manifest.id, distKey);
  const stagingDir = `${finalDir}.staging`;
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  onProgress({ phase: 'resolve', message: 'Looking up the latest build on GitHub' });
  const latest = await resolveLatest(manifest, dist, github);

  const downloadName = latest.type === 'release' ? latest.asset : `${manifest.id}-${latest.sha.slice(0, 12)}.tar.gz`;
  const downloadPath = path.join(library.downloadsDir, `${manifest.id}-${Date.now()}-${downloadName}`);
  onProgress({ phase: 'download', message: `Downloading ${downloadName}`, received: 0, total: latest.size ?? 0 });
  await github.download(latest.type === 'release' ? latest.assetUrl : github.tarballUrl(latest.repo, latest.sha), downloadPath, {
    isAsset: latest.type === 'release',
    onProgress: (p) => onProgress({ phase: 'download', message: `Downloading ${downloadName}`, ...p }),
  });

  const record = {
    id: manifest.id,
    name: manifest.name,
    distKey,
    kind: dist.kind,
    install: dist.install,
    version: latest.version,
    source: latest.type === 'release'
      ? { type: 'release', repo: latest.repo, tag: latest.tag, asset: latest.asset }
      : { type: 'repo', repo: latest.repo, ref: latest.ref, sha: latest.sha, path: latest.path },
    dir: finalDir,
    installedAt: new Date().toISOString(),
  };

  try {
    onProgress({ phase: 'unpack', message: 'Unpacking' });
    const lower = downloadName.toLowerCase();
    if (latest.type === 'repo') {
      const { written } = await extractTarGz(downloadPath, stagingDir, { subdir: latest.path });
      if (dist.kind === 'bundle') record.entry = entryUnderExtracted(stagingDir, written, dist.entry);
      else record.exec = dist.exec;
    } else if (lower.endsWith('.zip')) {
      const { written } = await extractZip(downloadPath, stagingDir);
      if (dist.kind === 'bundle') record.entry = entryUnderExtracted(stagingDir, written, dist.entry);
      else record.exec = dist.exec && written.includes(dist.exec) ? dist.exec : findExecutable(written, dist.exec);
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      const { written } = await extractTarGz(downloadPath, stagingDir);
      if (dist.kind === 'bundle') record.entry = entryUnderExtracted(stagingDir, written, dist.entry);
      else record.exec = findExecutable(written, dist.exec);
    } else if (dist.kind === 'bundle' && /\.html?$/i.test(lower)) {
      await fs.copyFile(downloadPath, path.join(stagingDir, downloadName));
      record.entry = downloadName;
    } else {
      // A bare executable or installer: keep it under its own name.
      await fs.copyFile(downloadPath, path.join(stagingDir, downloadName));
      record.exec = downloadName;
    }
    if (dist.kind === 'bundle' && !record.entry) throw new Error('The downloaded bundle has no HTML entry page');
    if (dist.kind === 'exe' && !record.exec) throw new Error('Could not find an executable in the download');

    await replaceDir(stagingDir, finalDir);
    record.sizeBytes = await dirSize(finalDir);
    await library.setInstalled(record);
    onProgress({ phase: 'done', message: 'Installed' });
    return record;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(downloadPath, { force: true });
  }
}

function findExecutable(written, preferred) {
  if (preferred && written.includes(preferred)) return preferred;
  const byDepth = [...written].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return (
    byDepth.find((f) => /\.exe$/i.test(f) && !/unins|setup/i.test(f)) ??
    byDepth.find((f) => /\.(exe|app|AppImage|sh)$/i.test(f)) ??
    byDepth.find((f) => !path.extname(f)) ??
    preferred
  );
}

export async function uninstallDistribution(record, { library }) {
  await fs.rm(record.dir, { recursive: true, force: true });
  await library.removeInstalled(record.id, record.distKey);
}

// Compare an installed record with GitHub. Returns { hasUpdate, latest } where
// latest carries the tag or sha so the UI can say what it would install.
export async function checkForUpdate(manifest, dist, record, github) {
  const latest = await resolveLatest(manifest, dist, github);
  const hasUpdate = latest.type === 'release' ? latest.tag !== record.source.tag : latest.sha !== record.source.sha;
  return { hasUpdate, latest };
}
