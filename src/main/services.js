// Everything the IPC handlers call. Kept free of ipcMain so it can be exercised
// without Electron's event plumbing. `app`, `openGeneratorWindow` and `shell` are
// injected for the same reason.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGitHub } from '../lib/github.js';
import { normalizeCatalog, resolveCatalog } from '../lib/catalog.js';
import { search, facets } from '../lib/search.js';
import { checkForUpdate, installDistribution, uninstallDistribution } from '../lib/installer.js';
import { createStableServer } from '../lib/server.js';
import { currentPlatform, distributionKey, usableDistributions } from '../lib/manifest.js';
import { listWebMirrorSnapshots, mirrorSite } from '../lib/mirror.js';
import { createJobs } from '../lib/jobs.js';
import { createRuntimes, WEBMIRROR_REQUIREMENT } from '../lib/runtimes.js';
import { mergeRequires, normalizeManifest } from '../lib/manifest.js';
import { describeProject as describeInput } from '../lib/describe.js';
import { sourceKey } from '../lib/library.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_CATALOG = path.join(here, '..', '..', 'catalog', 'catalog.json');

export function createServices({ library, app, openGeneratorWindow, openExternal, shell }) {
  let github = createGitHub({ token: library.state.settings.githubToken });
  let manifests = [];
  let problems = [];
  let catalogSource = 'bundled';
  let catalogSources = []; // every source last loaded, removed ones included
  const servers = new Map(); // installed record key -> { server, window }
  const listeners = new Set();

  const emit = (channel, payload) => {
    for (const fn of listeners) fn(channel, payload);
  };
  const jobs = createJobs({ emit });
  // Runtime downloads are public files, so they go through a token-less client.
  const runtimes = createRuntimes({ library, download: createGitHub().download });

  // What a distribution needs installed first: the manifest's own requirements,
  // the distribution's, and WebMirror for a mirror.
  function requirementsOf(manifest, dist) {
    return mergeRequires(manifest.requires, dist.requires, dist.kind === 'mirror' ? [WEBMIRROR_REQUIREMENT] : []);
  }

  function manifestById(id) {
    const m = manifests.find((x) => x.id === id);
    if (!m) throw new Error(`Unknown generator "${id}"`);
    return m;
  }

  function distributionOf(manifest, distKey) {
    const d = manifest.distributions.find((x) => distributionKey(x) === distKey);
    if (!d) throw new Error(`${manifest.name} has no distribution "${distKey}"`);
    return d;
  }

  async function readBundledCatalog() {
    return JSON.parse(await fs.readFile(BUNDLED_CATALOG, 'utf8'));
  }

  // The catalog is read from GitHub when possible so adding a repo to
  // catalog/catalog.json in the Generator-Library repo reaches every install;
  // the bundled copy is the fallback when offline.
  async function loadCatalog({ online = true } = {}) {
    const { catalogRepo, catalogPath } = library.state.settings;
    let raw = null;
    catalogSource = 'bundled';
    const cached = path.join(library.dataDir, 'catalog.json');
    if (online && catalogRepo) {
      try {
        raw = await github.readJson(catalogRepo, catalogPath);
        if (raw) {
          await fs.writeFile(cached, JSON.stringify(raw, null, 2));
          catalogSource = `github:${catalogRepo}`;
        }
      } catch (error) {
        problems.push({ repo: catalogRepo, error: `catalog fetch failed: ${error.message}` });
      }
    }
    if (!raw) {
      try {
        raw = JSON.parse(await fs.readFile(cached, 'utf8'));
        catalogSource = 'cache';
      } catch {
        raw = await readBundledCatalog();
      }
    }
    const { catalog, errors } = normalizeCatalog(raw);
    problems.push(...errors.map((e) => ({ repo: catalogRepo, error: e })));
    catalog.sources.push(
      ...library.state.sources.map((s) => ({
        repo: s.repo ?? '',
        url: s.url ?? '',
        manifest: s.manifest ?? '',
        fallback: s.fallback ?? null,
        overlay: s.overlay ?? null,
        overlayOnly: !s.repo, // a website has nothing to read from GitHub
        enabled: true,
        origin: 'yours',
      })),
    );
    const removed = new Set(library.state.removedSources.map((k) => k.toLowerCase()));
    for (const source of catalog.sources) {
      if (source.origin !== 'yours' && removed.has(sourceKey(source).toLowerCase())) source.enabled = false;
    }
    catalogSources = catalog.sources;
    return catalog;
  }

  async function refreshCatalog({ online = true } = {}) {
    problems = [];
    const catalog = await loadCatalog({ online });
    const readJson = online
      ? (repo, file) => github.readJson(repo, file)
      : async () => null; // offline: catalog fallbacks only
    const resolved = await resolveCatalog(catalog, { readJson });
    manifests = resolved.manifests;
    problems.push(...resolved.problems);
    emit('catalog:changed', { count: manifests.length });
    return state();
  }

  function state() {
    const platform = currentPlatform();
    return {
      platform,
      settings: { ...library.state.settings, githubToken: library.state.settings.githubToken ? '••••' : '' },
      hasToken: Boolean(library.state.settings.githubToken),
      sources: library.state.sources,
      favorites: library.state.favorites,
      recent: library.state.recent,
      installed: library.state.installed,
      running: [...servers.keys()],
      jobs: jobs.list(),
      runtimes: runtimes.status(),
      catalogSource,
      problems,
      hidden: library.state.hidden,
      projects: projects(),
      facets: facets(manifests),
      generators: manifests.map((m) => ({ ...m, usable: usableDistributions(m, platform).map(distributionKey) })),
    };
  }

  async function doSearch({ query = '', filters = {} } = {}) {
    return search(manifests, query, { platform: currentPlatform(), ...filters }, library.installedIds()).map((m) => m.id);
  }

  async function install({ id, distKey }) {
    const manifest = manifestById(id);
    const dist = distributionOf(manifest, distKey);
    const verb = library.getInstalled(id, distKey) ? 'Updating' : 'Installing';
    return jobs.run({ title: `${verb} ${manifest.name}`, kind: 'install', target: { id, distKey } }, async (job) => {
      await runtimes.ensure(requirementsOf(manifest, dist), job);
      return installDistribution(manifest, dist, {
        library,
        github,
        onProgress: (p) => (p.received !== undefined ? job.progress(p) : job.log(p.message)),
      });
    });
  }

  async function uninstall({ id, distKey }) {
    const record = library.getInstalled(id, distKey);
    if (!record) return false;
    await stopServer(library.recordKey(id, distKey));
    await uninstallDistribution(record, { library });
    return true;
  }

  async function stopServer(key) {
    const running = servers.get(key);
    if (!running) return;
    servers.delete(key);
    if (running.window && !running.window.isDestroyed()) running.window.close();
    await running.server.close();
  }

  async function launch({ id, distKey }) {
    const manifest = manifestById(id);
    const record = library.getInstalled(id, distKey);
    if (!record) throw new Error(`${manifest.name} is not installed`);
    await library.touchRecent(id);
    const key = library.recordKey(id, distKey);

    if (record.kind === 'bundle') {
      const existing = servers.get(key);
      if (existing && existing.window && !existing.window.isDestroyed()) {
        existing.window.focus();
        return { url: existing.server.url };
      }
      const dist = distributionOf(manifest, distKey);
      const server = await createStableServer(key, { root: record.dir, entry: record.entry, spa: dist.spa });
      const win = openGeneratorWindow({ title: manifest.name, url: server.url, partition: `persist:${manifest.id}` });
      win.on('closed', () => stopServer(key));
      servers.set(key, { server, window: win });
      return { url: server.url };
    }

    const needs = requirementsOf(manifest, distributionOf(manifest, distKey));
    if (needs.length) await jobs.run({ title: `Preparing ${manifest.name}`, kind: 'runtime', target: { id, distKey } }, (job) => runtimes.ensure(needs, job));
    const target = path.join(record.dir, record.exec);
    if (record.install === 'installer') {
      // Installers run once; after that the installed program owns its own
      // shortcuts. Opening with the shell shows the UAC prompt properly.
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return { launched: target, installer: true };
    }
    if (process.platform === 'win32' || /\.(exe|AppImage|app)$/i.test(target)) {
      if (process.platform === 'darwin' && target.endsWith('.app')) {
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
      } else {
        await fs.chmod(target, 0o755).catch(() => {});
        const child = spawn(target, [], { cwd: record.dir, detached: true, stdio: 'ignore' });
        child.unref();
      }
      return { launched: target };
    }
    await fs.chmod(target, 0o755).catch(() => {});
    const child = spawn(target, [], { cwd: record.dir, detached: true, stdio: 'ignore' });
    child.unref();
    return { launched: target };
  }

  async function openWeb({ id, distKey }) {
    const manifest = manifestById(id);
    const dist = distributionOf(manifest, distKey);
    if (!dist.url) throw new Error('No URL for this distribution');
    await library.touchRecent(id);
    openGeneratorWindow({ title: manifest.name, url: dist.url, partition: `persist:${manifest.id}` });
    return { url: dist.url };
  }

  // A mirror distribution runs WebMirror and then registers the snapshot as an
  // installed bundle, so launching and uninstalling work like any other install.
  async function mirror({ id, distKey }) {
    const manifest = manifestById(id);
    const dist = distributionOf(manifest, distKey);
    return jobs.run({ title: `Mirroring ${manifest.name}`, kind: 'mirror', target: { id, distKey } }, (job) => mirrorJob(manifest, dist, job));
  }

  async function mirrorJob(manifest, dist, job) {
    const { id } = manifest;
    const distKey = distributionKey(dist);
    const { python } = await runtimes.ensure(requirementsOf(manifest, dist), job);
    job.log(`Capturing ${dist.url}`);
    const result = await mirrorSite({
      url: dist.url,
      githubPagesFiles: dist.githubPagesFiles,
      browserCapture: dist.browserCapture,
      home: library.state.settings.webmirrorHome,
      interpreter: python,
      onProgress: (message) => job.log(message),
    });
    const record = {
      id,
      name: manifest.name,
      distKey,
      kind: 'bundle',
      version: result.record.saved_at,
      source: { type: 'mirror', url: result.record.url, key: result.record.key },
      dir: result.dir,
      entry: String(result.record.entry ?? 'index.html').replace(/^\/+/, ''),
      installedAt: new Date().toISOString(),
      sizeBytes: 0,
    };
    await library.setInstalled(record);
    job.log(`Saved ${result.record.files ?? '?'} files from ${result.record.pages ?? '?'} pages`);
    return record;
  }

  async function checkUpdates({ ids } = {}) {
    const results = [];
    const records = Object.values(library.state.installed).filter((r) => !ids || ids.includes(r.id));
    for (const record of records) {
      if (record.source.type === 'mirror') continue;
      try {
        const manifest = manifestById(record.id);
        const dist = distributionOf(manifest, record.distKey);
        const { hasUpdate, latest } = await checkForUpdate(manifest, dist, record, github);
        results.push({ id: record.id, distKey: record.distKey, hasUpdate, latest: { version: latest.version, publishedAt: latest.publishedAt, notes: latest.notes ?? '', htmlUrl: latest.htmlUrl ?? '' } });
      } catch (error) {
        results.push({ id: record.id, distKey: record.distKey, error: error.message });
      }
    }
    return results;
  }

  async function updateSettings(patch) {
    const clean = { ...patch };
    if (clean.githubToken === '••••') delete clean.githubToken;
    const settings = await library.updateSettings(clean);
    github = createGitHub({ token: settings.githubToken });
    return state();
  }

  // Every source as a project for the Manage view: where it comes from, whether
  // it was removed, and its generators with their hidden and installed state.
  function projects() {
    const installed = library.installedIds();
    const hidden = new Set(library.state.hidden);
    return catalogSources.map((source) => {
      const key = sourceKey(source);
      const generators = manifests
        .filter((m) => m.source === key)
        .map((m) => ({ id: m.id, name: m.name, hidden: hidden.has(m.id), installed: installed.has(m.id) }));
      const fallbackName = source.overlay?.name ?? source.fallback?.name ?? '';
      return { key, kind: source.repo ? 'repo' : 'link', origin: source.origin ?? 'catalog', removed: !source.enabled, name: generators.length === 1 ? generators[0].name : fallbackName || key, generators };
    });
  }

  // Look up what the user typed in Add project, without adding it yet.
  async function describeProject({ input }) {
    const found = await describeInput(input, { github });
    const key = found.repo || found.url;
    if (catalogSources.some((s) => sourceKey(s).toLowerCase() === key.toLowerCase() && s.enabled)) {
      throw new Error(`${key} is already in your library`);
    }
    const collection = Array.isArray(found.raw.generators);
    const preview = collection
      ? found.raw.generators.map((g) => ({ name: g.name ?? g.path ?? '?', summary: g.summary ?? '' }))
      : [{ name: found.raw.name, summary: found.raw.summary ?? '' }];
    if (!collection) {
      const { errors } = normalizeManifest(found.raw, { repo: found.repo || '' });
      if (errors.length) throw new Error(errors.join('; '));
    }
    return { ...found, key, collection, preview, kinds: collection ? [] : found.raw.distributions.map((d) => d.kind) };
  }

  // Add what describeProject found. `edits` (name, summary, tags, process) apply
  // to a project the library described itself; a repo's own manifest is used as is.
  async function addProject({ found, edits = {} }) {
    if (!found || (found.found !== 'manifest' && found.found !== 'inferred' && found.found !== 'link')) throw new Error('Look the project up first');
    let raw = found.raw;
    if (found.found !== 'manifest') {
      raw = { ...raw };
      for (const field of ['name', 'summary', 'process']) if (typeof edits[field] === 'string' && edits[field].trim()) raw[field] = edits[field].trim();
      if (Array.isArray(edits.tags)) raw.tags = edits.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
      const { errors } = normalizeManifest(raw, { repo: found.repo || '' });
      if (errors.length) throw new Error(errors.join('; '));
    }
    const addedAt = new Date().toISOString();
    if (found.found === 'manifest') await library.addSource({ repo: found.repo, manifest: found.manifestPath, addedAt });
    else if (found.found === 'inferred') await library.addSource({ repo: found.repo, fallback: raw, addedAt });
    else await library.addSource({ url: found.url, overlay: raw, addedAt });
    return refreshCatalog();
  }

  // Remove a project: one you added is deleted, a catalog one is set aside so it
  // can be restored. Its installed copies are uninstalled either way.
  async function removeProject({ key }) {
    for (const m of manifests.filter((x) => x.source === key)) {
      for (const record of library.installedFor(m.id)) await uninstall({ id: m.id, distKey: record.distKey });
    }
    if (library.state.sources.some((s) => sourceKey(s) === key)) await library.removeSource(key);
    else await library.setSourceRemoved(key, true);
    return refreshCatalog();
  }

  async function restoreProject({ key }) {
    await library.setSourceRemoved(key, false);
    return refreshCatalog();
  }

  async function setHidden({ id, hidden }) {
    await library.setHidden(id, Boolean(hidden));
    return state();
  }

  // Kept for the old Settings form: add a repository by name.
  async function addSource({ repo }) {
    return addProject({ found: await describeProject({ input: repo }) });
  }

  async function removeSource({ repo }) {
    return removeProject({ key: repo });
  }

  async function openSnapshot({ key }) {
    const snapshots = await listWebMirrorSnapshots(library.state.settings.webmirrorHome);
    const snap = snapshots.find((s) => s.key === key);
    if (!snap) throw new Error('Snapshot not found');
    const serverKey = `webmirror/${key}`;
    const existing = servers.get(serverKey);
    if (existing?.window && !existing.window.isDestroyed()) {
      existing.window.focus();
      return { url: existing.server.url };
    }
    const server = await createStableServer(serverKey, { root: snap.dir, entry: String(snap.entry).replace(/^\/+/, ''), spa: true });
    const win = openGeneratorWindow({ title: snap.url, url: server.url, partition: `persist:webmirror-${key}` });
    win.on('closed', () => stopServer(serverKey));
    servers.set(serverKey, { server, window: win });
    return { url: server.url };
  }

  async function installRuntime() {
    await jobs.run({ title: 'Installing Python and WebMirror', kind: 'runtime' }, (job) => runtimes.ensure([WEBMIRROR_REQUIREMENT], job));
    return state();
  }

  async function removeRuntime() {
    await runtimes.remove();
    return state();
  }

  async function shutdown() {
    for (const key of [...servers.keys()]) await stopServer(key);
  }

  return {
    state,
    refreshCatalog,
    search: doSearch,
    install,
    uninstall,
    launch,
    openWeb,
    mirror,
    checkUpdates,
    toggleFavorite: ({ id }) => library.toggleFavorite(id),
    updateSettings,
    addSource,
    removeSource,
    openExternal: ({ url }) => openExternal(url),
    openFolder: ({ id, distKey }) => {
      const record = library.getInstalled(id, distKey);
      return record ? shell.openPath(record.dir) : Promise.resolve('not installed');
    },
    webmirrorSnapshots: () => listWebMirrorSnapshots(library.state.settings.webmirrorHome),
    openSnapshot,
    installRuntime,
    removeRuntime,
    describeProject,
    addProject,
    removeProject,
    restoreProject,
    setHidden,
    jobs: () => jobs.list(),
    clearJobs: () => jobs.clearFinished(),
    subscribe: (fn) => listeners.add(fn),
    shutdown,
    userDataDir: library.dataDir,
  };
}
