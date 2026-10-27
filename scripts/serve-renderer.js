// Serve the renderer in an ordinary browser with a mock `window.library` so the
// page can be worked on (and screenshot-tested) without Electron. The mock
// resolves the shipped catalog offline and fakes installs in memory.
//
//   node scripts/serve-renderer.js            # http://127.0.0.1:4173
//   PORT=5000 node scripts/serve-renderer.js

import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeCatalog, resolveCatalog } from '../src/lib/catalog.js';
import { facets, search } from '../src/lib/search.js';
import { currentPlatform, distributionKey, normalizeManifest, usableDistributions } from '../src/lib/manifest.js';
import { mimeFor } from '../src/lib/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = path.join(root, 'src', 'renderer');
const port = Number(process.env.PORT) || 4173;

const raw = JSON.parse(await fs.readFile(path.join(root, 'catalog', 'catalog.json'), 'utf8'));
const { catalog } = normalizeCatalog(raw);
const { manifests, problems } = await resolveCatalog(catalog, { readJson: async () => null });

const mock = {
  installed: {},
  kept: {}, // `${id}/${distKey}` -> older records
  favorites: [],
  recent: [],
  sources: [],
  jobs: [],
  python: null,
  hidden: [],
  removed: [],
  added: [], // { key, manifest }
  settings: { githubToken: '', catalogRepo: 'DrFlGd/Generator-Library', pythonPath: '', webmirrorHome: '', checkUpdatesOnStart: false, keepVersions: 2 },
};

const MOCK_RELEASES = ['v1.2.0', 'v1.1.0', 'v1.0.0'].map((tag, i) => ({ tag, name: tag, publishedAt: `2026-10-${20 - i * 5}T00:00:00Z`, prerelease: false, size: 9_000_000 + i, htmlUrl: '' }));

function all() {
  return [...manifests, ...mock.added.map((a) => a.manifest)];
}

function state() {
  const platform = currentPlatform();
  return {
    platform,
    settings: mock.settings,
    hasToken: false,
    sources: mock.sources,
    favorites: mock.favorites,
    recent: mock.recent,
    installed: mock.installed,
    kept: mock.kept,
    running: [],
    jobs: mock.jobs,
    hidden: mock.hidden,
    projects: [
      ...mock.added.map(({ key, manifest }) => ({ key, kind: key.includes('/') && !key.startsWith('http') ? 'repo' : 'link', origin: 'yours', removed: false, name: manifest.name, generators: [{ id: manifest.id, name: manifest.name, hidden: mock.hidden.includes(manifest.id), installed: false }] })),
      ...catalog.sources.map((source) => {
        const gens = all().filter((m) => m.repo === source.repo && !mock.added.some((a) => a.manifest.id === m.id));
        return { key: source.repo, kind: 'repo', origin: 'catalog', removed: mock.removed.includes(source.repo), name: gens.length === 1 ? gens[0].name : source.fallback?.name ?? source.repo, generators: gens.map((g) => ({ id: g.id, name: g.name, hidden: mock.hidden.includes(g.id), installed: Object.values(mock.installed).some((r) => r.id === g.id) })) };
      }),
    ],
    runtimes: { python: { configured: mock.settings.pythonPath, managed: mock.python, build: '3.12 (mock)' }, node: { managed: null, build: '24 (mock)' } },
    dataLocation: { dir: 'E:\\Generator Library\\Generator Library Data', mode: 'legacy', portable: true, suggested: 'E:\\Generator Library\\Generator Library Data' },
    catalogSource: 'mock',
    problems,
    facets: facets(manifests),
    generators: all().filter((m) => !mock.removed.includes(m.repo)).map((m) => ({ ...m, usable: usableDistributions(m, platform).map(distributionKey) })),
  };
}

function mockJob(title, target, { failed = '' } = {}) {
  const now = Date.now();
  const job = { id: `job-${mock.jobs.length + 1}`, title, kind: 'install', target, status: failed ? 'failed' : 'done', message: 'Done', received: 0, total: 0, log: ['Looking up the latest build on GitHub', 'Downloading', failed ? `Failed: ${failed}` : 'Installed'], error: failed, startedAt: now, finishedAt: now };
  mock.jobs.unshift(job);
  if (failed) throw new Error(failed);
}

const handlers = {
  getState: () => state(),
  refreshCatalog: () => state(),
  search: ({ query, filters }) => search(all().filter((m) => !mock.removed.includes(m.repo)), query, { platform: currentPlatform(), ...filters }, new Set(Object.values(mock.installed).map((r) => r.id))).map((m) => m.id),
  install: ({ id, distKey, tag }) => {
    const m = all().find((x) => x.id === id);
    const version = tag || MOCK_RELEASES[0].tag;
    const key = `${id}/${distKey}`;
    const record = { id, name: m.name, distKey, kind: distKey.split(':')[0], version, pinned: Boolean(tag), source: { type: 'release', tag: version }, dir: `/mock/${id}@${version}`, installedAt: new Date().toISOString(), sizeBytes: 12345678 };
    const previous = mock.installed[key];
    const kept = (mock.kept[key] ?? []).filter((r) => r.version !== version);
    if (previous && previous.version !== version) kept.unshift(previous);
    mock.kept[key] = kept.slice(0, mock.settings.keepVersions);
    mock.installed[key] = record;
    mockJob(`Installing ${m.name}`, { id, distKey });
    return record;
  },
  uninstall: ({ id, distKey }) => {
    delete mock.kept[`${id}/${distKey}`];
    return delete mock.installed[`${id}/${distKey}`];
  },
  versions: ({ id, distKey }) => {
    const key = `${id}/${distKey}`;
    return MOCK_RELEASES.map((r, i) => ({ ...r, newest: i === 0, active: mock.installed[key]?.version === r.tag, kept: (mock.kept[key] ?? []).some((k) => k.version === r.tag) }));
  },
  useVersion: ({ id, distKey, version, pin }) => {
    const key = `${id}/${distKey}`;
    const record = mock.kept[key].find((r) => r.version === version);
    mock.kept[key] = [mock.installed[key], ...mock.kept[key].filter((r) => r !== record)];
    mock.installed[key] = { ...record, pinned: pin };
    return state();
  },
  removeVersion: ({ id, distKey, version }) => {
    const key = `${id}/${distKey}`;
    mock.kept[key] = (mock.kept[key] ?? []).filter((r) => r.version !== version);
    return state();
  },
  launch: () => ({ launched: true }),
  openWeb: ({ id }) => {
    mock.recent = [id, ...mock.recent.filter((x) => x !== id)];
    return { url: '' };
  },
  // MOCK_MIRROR_FAIL=1 shows how a failed job looks on its distribution row.
  mirror: ({ id, distKey }) =>
    process.env.MOCK_MIRROR_FAIL ? mockJob(`Mirroring ${manifests.find((x) => x.id === id).name}`, { id, distKey }, { failed: 'Browser capture needs Chrome or Edge.' }) : handlers.install({ id, distKey }),
  checkUpdates: () => Object.values(mock.installed).map((r) => {
    const newer = r.version !== MOCK_RELEASES[0].tag;
    return { id: r.id, distKey: r.distKey, hasUpdate: newer && !r.pinned, pinned: Boolean(r.pinned), newer, latest: { version: MOCK_RELEASES[0].tag, publishedAt: '', notes: '', htmlUrl: '' } };
  }),
  toggleFavorite: ({ id }) => {
    mock.favorites = mock.favorites.includes(id) ? mock.favorites.filter((x) => x !== id) : [...mock.favorites, id];
    return mock.favorites.includes(id);
  },
  updateSettings: (patch) => {
    Object.assign(mock.settings, patch);
    return state();
  },
  addSource: ({ repo, manifest }) => {
    mock.sources.push({ repo, manifest });
    return state();
  },
  removeSource: ({ repo }) => {
    mock.sources = mock.sources.filter((s) => s.repo !== repo);
    return state();
  },
  openExternal: () => undefined,
  openFolder: () => '',
  webmirrorSnapshots: () => [],
  openSnapshot: () => ({ url: '' }),
  chooseDataFolder: () => '',
  moveData: ({ dir }) => ({ relaunching: true, dir }),
  installRuntime: () => {
    mock.python = { version: '3.12.16', dir: '/mock/runtimes/python', packages: ['webmirror[dynamic] @ https://github.com/DrFlGd/WebMirror/archive/refs/heads/main.zip'] };
    mockJob('Installing Python and WebMirror', null);
    return state();
  },
  removeRuntime: () => {
    mock.python = null;
    return state();
  },
  describeProject: ({ input }) => ({
    found: 'inferred',
    repo: input,
    key: input,
    collection: false,
    raw: { id: 'mock-project', name: 'Mock Project', summary: 'Described from the repository homepage and releases.', tags: ['mock'], distributions: [{ kind: 'web', url: 'https://example.com/' }, { kind: 'mirror', url: 'https://example.com/' }] },
    preview: [{ name: 'Mock Project', summary: '' }],
    kinds: ['web', 'mirror'],
  }),
  addProject: ({ found, edits }) => {
    const raw = { ...found.raw, ...Object.fromEntries(Object.entries(edits).filter(([, v]) => typeof v === 'string' && v)) };
    const { manifest } = normalizeManifest(raw, { repo: '' });
    mock.added.push({ key: found.key, manifest: { ...manifest, source: found.key, origin: 'yours' } });
    return state();
  },
  removeProject: ({ key }) => {
    if (mock.added.some((a) => a.key === key)) mock.added = mock.added.filter((a) => a.key !== key);
    else mock.removed.push(key);
    return state();
  },
  restoreProject: ({ key }) => {
    mock.removed = mock.removed.filter((k) => k !== key);
    return state();
  },
  setHidden: ({ id, hidden }) => {
    mock.hidden = hidden ? [...mock.hidden, id] : mock.hidden.filter((x) => x !== id);
    return state();
  },
  jobs: () => mock.jobs,
  clearJobs: () => (mock.jobs = mock.jobs.filter((j) => j.status === 'running')),
};

const bridge = `
window.library = {
  platform: ${JSON.stringify(process.platform)},
  on(channel, handler) { (window.__listeners ||= {})[channel] = handler; return () => {}; },
};
for (const name of ${JSON.stringify(Object.keys(handlers))}) {
  window.library[name] = async (payload) => {
    const res = await fetch('/__api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) });
    return res.json();
  };
}
`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/__api/')) {
    const name = url.pathname.slice('/__api/'.length);
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const value = await handlers[name](body ? JSON.parse(body) : {});
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, value: value ?? null }));
    } catch (error) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (url.pathname === '/__bridge.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bridge);
    return;
  }
  const file = path.join(rendererDir, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    let data = await fs.readFile(file);
    if (file.endsWith('index.html')) {
      data = data
        .toString()
        .replace('<script src="app.js" type="module"></script>', '<script src="/__bridge.js"></script>\n  <script src="app.js" type="module"></script>')
        .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
    }
    res.writeHead(200, { 'Content-Type': mimeFor(file) }).end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Renderer with mock bridge at http://127.0.0.1:${port}/`));
