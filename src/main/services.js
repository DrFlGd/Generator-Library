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
import { createStaticServer } from '../lib/server.js';
import { currentPlatform, distributionKey, usableDistributions } from '../lib/manifest.js';
import { listWebMirrorSnapshots, mirrorSite } from '../lib/mirror.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_CATALOG = path.join(here, '..', '..', 'catalog', 'catalog.json');

export function createServices({ library, app, openGeneratorWindow, openExternal, shell }) {
  let github = createGitHub({ token: library.state.settings.githubToken });
  let manifests = [];
  let problems = [];
  let catalogSource = 'bundled';
  const servers = new Map(); // installed record key -> { server, window }
  const listeners = new Set();

  const emit = (channel, payload) => {
    for (const fn of listeners) fn(channel, payload);
  };

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
    catalog.sources.push(...library.state.sources.map((s) => ({ repo: s.repo, manifest: s.manifest ?? '', fallback: s.fallback ?? null, overlay: s.overlay ?? null, overlayOnly: false, enabled: true, note: 'added by you' })));
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
      catalogSource,
      problems,
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
    const record = await installDistribution(manifest, dist, {
      library,
      github,
      onProgress: (p) => emit('progress', { id, distKey, ...p }),
    });
    return record;
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
      const server = await createStaticServer({ root: record.dir, entry: record.entry, spa: dist.spa });
      const win = openGeneratorWindow({ title: manifest.name, url: server.url, partition: `persist:${manifest.id}` });
      win.on('closed', () => stopServer(key));
      servers.set(key, { server, window: win });
      return { url: server.url };
    }

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
    const { pythonPath, webmirrorHome } = library.state.settings;
    const result = await mirrorSite({
      url: dist.url,
      githubPagesFiles: dist.githubPagesFiles,
      browserCapture: dist.browserCapture,
      home: webmirrorHome,
      python: pythonPath,
      onProgress: (message) => emit('progress', { id, distKey, phase: 'mirror', message }),
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
    emit('progress', { id, distKey, phase: 'done', message: 'Mirrored' });
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

  async function addSource({ repo, manifest }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Use the form owner/name');
    await library.addSource({ repo, manifest: manifest || '' });
    return refreshCatalog();
  }

  async function removeSource({ repo }) {
    await library.removeSource(repo);
    return refreshCatalog();
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
    const server = await createStaticServer({ root: snap.dir, entry: String(snap.entry).replace(/^\/+/, ''), spa: true });
    const win = openGeneratorWindow({ title: snap.url, url: server.url, partition: `persist:webmirror-${key}` });
    win.on('closed', () => stopServer(serverKey));
    servers.set(serverKey, { server, window: win });
    return { url: server.url };
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
    subscribe: (fn) => listeners.add(fn),
    shutdown,
    userDataDir: library.dataDir,
  };
}
