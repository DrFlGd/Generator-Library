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
import { currentPlatform, distributionKey, usableDistributions } from '../src/lib/manifest.js';
import { mimeFor } from '../src/lib/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = path.join(root, 'src', 'renderer');
const port = Number(process.env.PORT) || 4173;

const raw = JSON.parse(await fs.readFile(path.join(root, 'catalog', 'catalog.json'), 'utf8'));
const { catalog } = normalizeCatalog(raw);
const { manifests, problems } = await resolveCatalog(catalog, { readJson: async () => null });

const mock = {
  installed: {},
  favorites: [],
  recent: [],
  sources: [],
  settings: { githubToken: '', catalogRepo: 'DrFlGd/Generator-Library', pythonPath: '', webmirrorHome: '', checkUpdatesOnStart: false },
};

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
    running: [],
    catalogSource: 'mock',
    problems,
    facets: facets(manifests),
    generators: manifests.map((m) => ({ ...m, usable: usableDistributions(m, platform).map(distributionKey) })),
  };
}

const handlers = {
  getState: () => state(),
  refreshCatalog: () => state(),
  search: ({ query, filters }) => search(manifests, query, { platform: currentPlatform(), ...filters }, new Set(Object.values(mock.installed).map((r) => r.id))).map((m) => m.id),
  install: ({ id, distKey }) => {
    const m = manifests.find((x) => x.id === id);
    const record = { id, name: m.name, distKey, kind: distKey.split(':')[0], version: 'mock-1.0', source: { type: 'release', tag: 'mock-1.0' }, dir: `/mock/${id}`, installedAt: new Date().toISOString(), sizeBytes: 12345678 };
    mock.installed[`${id}/${distKey}`] = record;
    return record;
  },
  uninstall: ({ id, distKey }) => delete mock.installed[`${id}/${distKey}`],
  launch: () => ({ launched: true }),
  openWeb: ({ id }) => {
    mock.recent = [id, ...mock.recent.filter((x) => x !== id)];
    return { url: '' };
  },
  mirror: ({ id, distKey }) => handlers.install({ id, distKey }),
  checkUpdates: () => Object.values(mock.installed).map((r) => ({ id: r.id, distKey: r.distKey, hasUpdate: true, latest: { version: 'mock-1.1', publishedAt: '', notes: '', htmlUrl: '' } })),
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
