// Turn a distribution into files on disk and a record the library can launch and
// later compare against GitHub (or the project's download page) for updates.
//
// A record looks like:
//   { id, distKey, kind, install?, version, source: { type, repo?|url?, tag?|ref?, sha?, asset? },
//     dir, entry?|exec?, installedAt, sizeBytes, pinned? }
//
// `version` is whatever identifies the installed build: the release tag for
// release assets, the commit sha for repository trees, the version in the file
// name for a download page. The updater only has to compare it with the newest.
//
// Each version installs into its own folder. The newest install launches; the
// one it replaced is kept (library.activate) so the user can switch back.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { distributionKey } from './manifest.js';
import { extractTarGz, extractZip } from './archive.js';
import { createWeb, versionFromName } from './web.js';

export async function dirSize(dir) {
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

export async function replaceDir(stagingDir, finalDir) {
  await fs.rm(finalDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(finalDir), { recursive: true });
  await fs.rename(stagingDir, finalDir);
}

// Resolve what the newest available build of a distribution is, without
// downloading it. Used both before an install and by the update check. `tag`
// picks one exact release instead of the newest (the version picker).
export async function resolveLatest(manifest, dist, github, { tag, web = createWeb() } = {}) {
  const from = dist.from;
  if (from.type === 'page') {
    const { url, name } = await web.findPageAsset(from.url, from.asset, { folder: from.folder });
    return { type: 'page', page: from.url, version: versionFromName(name), asset: name, assetUrl: url, htmlUrl: from.url };
  }
  const repo = from.repo || manifest.repo;
  if (from.type === 'release') {
    const wanted = tag ? { tag, asset: from.asset, prerelease: true } : { tag: from.tag, asset: from.asset, prerelease: from.prerelease };
    const { release, asset } = await github.resolveReleaseAsset(repo, wanted);
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

// Every file under `dir`, as forward-slash paths relative to it.
async function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push(rel);
  }
  return out;
}

// `builder(dir, build, { onLine })` builds an unpacked repository for a
// distribution with `build` and returns its output folder (build.js buildProject,
// given the private Node.js by the caller).
export async function installDistribution(manifest, dist, { library, github, web = createWeb(), onProgress = () => {}, tag, keep, builder } = {}) {
  const distKey = distributionKey(dist);
  const where = dist.from.type === 'page' ? new URL(dist.from.url).hostname : 'GitHub';
  onProgress({ phase: 'resolve', message: tag ? `Looking up ${tag} on GitHub` : `Looking up the latest build on ${where}` });
  const latest = await resolveLatest(manifest, dist, github, { tag, web });
  const finalDir = library.versionDir(manifest.id, distKey, latest.version);
  const stagingDir = `${finalDir}.staging`;
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  const downloadName = latest.type === 'repo' ? `${manifest.id}-${latest.sha.slice(0, 12)}.tar.gz` : latest.asset;
  const downloadPath = path.join(library.downloadsDir, `${manifest.id}-${Date.now()}-${downloadName}`);
  onProgress({ phase: 'download', message: `Downloading ${downloadName}`, received: 0, total: latest.size ?? 0 });
  const downloadProgress = (p) => onProgress({ phase: 'download', message: `Downloading ${downloadName}`, ...p });
  if (latest.type === 'page') await web.download(latest.assetUrl, downloadPath, { onProgress: downloadProgress });
  else {
    await github.download(latest.type === 'release' ? latest.assetUrl : github.tarballUrl(latest.repo, latest.sha), downloadPath, {
      isAsset: latest.type === 'release',
      onProgress: downloadProgress,
    });
  }

  const record = {
    id: manifest.id,
    name: manifest.name,
    distKey,
    kind: dist.kind,
    install: dist.install,
    version: latest.version,
    publishedAt: latest.publishedAt ?? '',
    source: latest.type === 'release'
      ? { type: 'release', repo: latest.repo, tag: latest.tag, asset: latest.asset }
      : latest.type === 'page'
        ? { type: 'page', url: latest.page, asset: latest.asset }
        : { type: 'repo', repo: latest.repo, ref: latest.ref, sha: latest.sha, path: latest.path },
    dir: finalDir,
    installedAt: new Date().toISOString(),
  };
  if (tag) record.pinned = true;

  try {
    onProgress({ phase: 'unpack', message: 'Unpacking' });
    const lower = downloadName.toLowerCase();
    if (latest.type === 'repo' && dist.build) {
      if (!builder) throw new Error('Building from source is not available here');
      const sourceDir = `${finalDir}.source`;
      await fs.rm(sourceDir, { recursive: true, force: true });
      try {
        await extractTarGz(downloadPath, sourceDir, { subdir: latest.path });
        onProgress({ phase: 'build', message: 'Building from source' });
        const output = await builder(sourceDir, dist.build, { onLine: (line) => onProgress({ phase: 'build', message: line }) });
        await fs.rm(stagingDir, { recursive: true, force: true });
        await fs.rename(output, stagingDir);
      } finally {
        await fs.rm(sourceDir, { recursive: true, force: true });
      }
      record.entry = entryUnderExtracted(stagingDir, await listFiles(stagingDir), dist.entry);
      record.built = true;
    } else if (latest.type === 'repo') {
      const { written } = await extractTarGz(downloadPath, stagingDir, { subdir: latest.path });
      if (dist.kind === 'bundle') record.entry = entryUnderExtracted(stagingDir, written, dist.entry);
      else record.exec = dist.exec;
    } else if (lower.endsWith('.zip')) {
      const { written } = await extractZip(downloadPath, stagingDir);
      if (dist.kind === 'bundle') record.entry = entryUnderExtracted(stagingDir, written, dist.entry);
      else record.exec = dist.exec && written.includes(dist.exec) ? dist.exec : findExecutable(written, dist.exec);
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      const { written } = await extractTarGz(downloadPath, stagingDir, { strip: 0 });
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
    const dropped = await library.activate(record, { keep });
    for (const old of dropped) if (old.dir !== finalDir) await fs.rm(old.dir, { recursive: true, force: true });
    onProgress({ phase: 'done', message: 'Installed' });
    return record;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(downloadPath, { force: true });
  }
}

function findExecutable(written, preferred) {
  if (preferred && written.includes(preferred)) return preferred;
  // A macOS .app is a folder: the manifest names the bundle, the archive lists its files.
  if (preferred && written.some((f) => f.startsWith(preferred + '/'))) return preferred;
  const byDepth = [...written].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return (
    byDepth.find((f) => /\.exe$/i.test(f) && !/unins|setup/i.test(f)) ??
    byDepth.find((f) => /\.(exe|app|AppImage|sh)$/i.test(f)) ??
    byDepth.find((f) => !path.extname(f)) ??
    preferred
  );
}

// Removes the installed version and every kept one.
export async function uninstallDistribution(record, { library }) {
  for (const r of [record, ...library.keptFor(record.id, record.distKey)]) await fs.rm(r.dir, { recursive: true, force: true });
  await library.removeInstalled(record.id, record.distKey);
}

// Delete one kept version.
export async function removeVersion(id, distKey, version, { library }) {
  const record = await library.removeKept(id, distKey, version);
  if (record) await fs.rm(record.dir, { recursive: true, force: true });
  return Boolean(record);
}

// Compare an installed record with GitHub or its download page. Returns { hasUpdate, latest } where
// latest carries the tag or sha so the UI can say what it would install.
export async function checkForUpdate(manifest, dist, record, github, { web } = {}) {
  const latest = await resolveLatest(manifest, dist, github, web ? { web } : {});
  const hasUpdate = latest.type === 'release' ? latest.tag !== record.source.tag
    : latest.type === 'page' ? latest.asset !== record.source.asset
      : latest.sha !== record.source.sha;
  return { hasUpdate, latest };
}
