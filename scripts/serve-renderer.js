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
import { applyManifestEdit, currentPlatform, distributionKey, editPatch, normalizeManifest, usableDistributions } from '../src/lib/manifest.js';
import { mimeFor } from '../src/lib/server.js';
import { applyTagEdits, editCollections, normalizeTags } from '../src/lib/library.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = path.join(root, 'src', 'renderer');
const port = Number(process.env.PORT) || 4173;

const raw = JSON.parse(await fs.readFile(path.join(root, 'catalog', 'catalog.json'), 'utf8'));
const { catalog } = normalizeCatalog(raw);
const { manifests, problems } = await resolveCatalog(catalog, { readJson: async () => null });

const mock = {
  installed: {},
  code: {}, // id -> saved repository copy
  kept: {}, // `${id}/${distKey}` -> older records
  favorites: [],
  tagEdits: {},
  edits: {},
  collections: [],
  offlineMarks: {},
  recent: [],
  sources: [],
  jobs: [],
  python: null,
  hidden: [],
  removed: [],
  added: [], // { key, manifest, addedAt }
  thumbnails: {}, // id -> data URL, as if taken from its window
  openWindows: [], // ids opened with launch or openWeb
  webmirrorAt: '',
  settings: { githubToken: '', catalogRepo: 'DrFlGd/Generator-Library', pythonPath: '', webmirrorHome: '', checkUpdatesOnStart: false, keepVersions: 2, resyncDays: 30, theme: process.env.MOCK_THEME || 'system' },
};

// MOCK_OLD_MIRROR=1 starts with a 45-day-old mirror, to show the Resync reminder.
if (process.env.MOCK_OLD_MIRROR) {
  const m = manifests.find((x) => x.distributions.some((d) => d.kind === 'mirror'));
  const distKey = m.distributions.find((d) => d.kind === 'mirror').key;
  mock.installed[`${m.id}/${distKey}`] = { id: m.id, name: m.name, distKey, kind: 'bundle', version: '2026-09-13T10:00:00+00:00', source: { type: 'mirror', url: 'https://example.com/' }, dir: `/mock/mirrors/${m.id}`, entry: 'index.html', installedAt: new Date(Date.now() - 45 * 86400000).toISOString(), sizeBytes: 0 };
}

// MOCK_UPDATES=1 starts with a few older installs, to show the Updates panel.
if (process.env.MOCK_UPDATES) {
  const picks = manifests.filter((x) => x.distributions.some((d) => d.kind === 'bundle' || d.kind === 'exe')).slice(0, 5);
  picks.forEach((m, i) => {
    const d = m.distributions.find((x) => x.kind === 'bundle' || x.kind === 'exe');
    const type = ['release', 'repo', 'page'][i % 3];
    mock.installed[`${m.id}/${d.key}`] = { id: m.id, name: m.name, distKey: d.key, kind: d.kind, version: 'v1.0.0', source: { type }, dir: `/mock/${m.id}`, installedAt: new Date().toISOString(), sizeBytes: 1000 };
  });
}

// A stand-in for a picture of a generator's window.
function mockPicture(name) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="hsl(${hue},30%,88%)"/><g fill="none" stroke="hsl(${hue},45%,35%)" stroke-width="3"><rect x="250" y="120" width="300" height="220"/><path d="M250 120l60-50h300l-60 50M550 340l60-50V70"/></g><text x="30" y="470" font-family="sans-serif" font-size="28" fill="hsl(${hue},45%,30%)">${name.replace(/[<&]/g, '')}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// MOCK_THUMBS=n gives the first n generators a picture.
for (const m of manifests.slice(0, Number(process.env.MOCK_THUMBS) || 0)) mock.thumbnails[m.id] = mockPicture(m.name);

// MOCK_ADDED=1 starts with two sources you added.
if (process.env.MOCK_ADDED) {
  for (const [i, [key, name]] of [['https://example.com/box-maker', 'Example Box Maker'], ['someone/lithophane-tool', 'Lithophane Tool']].entries()) {
    const { manifest } = normalizeManifest({ id: `added-${i}`, name, summary: 'Added by link for the mock.', tags: ['mock'], distributions: [{ kind: 'web', url: 'https://example.com/' }] }, { repo: '' });
    mock.added.push({ key, addedAt: new Date(Date.now() - i * 86400000).toISOString(), manifest: { ...manifest, source: key, origin: 'yours' } });
  }
}

const MOCK_RELEASES = ['v1.2.0', 'v1.1.0', 'v1.0.0'].map((tag, i) => ({ tag, name: tag, publishedAt: `2026-10-${20 - i * 5}T00:00:00Z`, prerelease: false, size: 9_000_000 + i, htmlUrl: '' }));

function all() {
  return [...manifests, ...mock.added.map((a) => a.manifest)]
    .map((m) => (mock.edits[m.id] ? applyManifestEdit(m, mock.edits[m.id]).manifest : m))
    .map((m) => (mock.tagEdits[m.id] ? { ...m, tags: applyTagEdits(m.tags, mock.tagEdits[m.id]), catalogTags: m.tags } : m));
}

function state() {
  const platform = currentPlatform();
  return {
    platform,
    settings: mock.settings,
    hasToken: false,
    sources: mock.sources,
    favorites: mock.favorites,
    collections: mock.collections,
    offlineMarks: mock.offlineMarks,
    recent: mock.recent,
    installed: mock.installed,
    kept: mock.kept,
    code: mock.code,
    thumbnails: mock.thumbnails,
    openWindows: mock.openWindows,
    running: [],
    jobs: mock.jobs,
    hidden: mock.hidden,
    projects: [
      ...mock.added.map(({ key, manifest, addedAt }) => ({ key, addedAt: addedAt ?? '', kind: key.includes('/') && !key.startsWith('http') ? 'repo' : 'link', origin: 'yours', removed: false, name: manifest.name, generators: [{ id: manifest.id, name: manifest.name, hidden: mock.hidden.includes(manifest.id), installed: false }] })),
      ...catalog.sources.map((source) => {
        const gens = all().filter((m) => m.repo === source.repo && !mock.added.some((a) => a.manifest.id === m.id));
        return { key: source.repo, kind: 'repo', origin: 'catalog', removed: mock.removed.includes(source.repo), name: gens.length === 1 ? gens[0].name : source.fallback?.name ?? source.repo, generators: gens.map((g) => ({ id: g.id, name: g.name, hidden: mock.hidden.includes(g.id), installed: Object.values(mock.installed).some((r) => r.id === g.id) })) };
      }),
    ],
    runtimes: { python: { configured: mock.settings.pythonPath, managed: mock.python, webmirror: mock.python ? mock.webmirrorAt : '', build: '3.12 (mock)' }, node: { managed: null, build: '24 (mock)' } },
    dataLocation: { dir: 'E:\\Generator Library\\Generator Library Data', mode: 'legacy', portable: true, suggested: 'E:\\Generator Library\\Generator Library Data' },
    catalogSource: 'mock',
    problems,
    facets: facets(all()),
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
  // Both open a window, which a thumbnail can then be taken of.
  launch: ({ id }) => {
    mock.recent = [id, ...mock.recent.filter((x) => x !== id)];
    if (!mock.openWindows.includes(id)) mock.openWindows.push(id);
    return { launched: true };
  },
  openWeb: ({ id }) => {
    mock.recent = [id, ...mock.recent.filter((x) => x !== id)];
    if (!mock.openWindows.includes(id)) mock.openWindows.push(id);
    return { url: '' };
  },
  // MOCK_MIRROR_FAIL=1 shows how a failed job looks on its distribution row.
  mirror: ({ id, distKey }) =>
    process.env.MOCK_MIRROR_FAIL ? mockJob(`Mirroring ${manifests.find((x) => x.id === id).name}`, { id, distKey }, { failed: 'Browser capture needs Chrome or Edge.' }) : handlers.install({ id, distKey }),
  checkUpdates: () => Object.values(mock.installed).filter((r) => r.source.type !== 'mirror').map((r) => {
    const newer = r.version !== MOCK_RELEASES[0].tag;
    return { id: r.id, distKey: r.distKey, hasUpdate: newer && !r.pinned, pinned: Boolean(r.pinned), newer, latest: { version: MOCK_RELEASES[0].tag, publishedAt: '', notes: '', htmlUrl: '' } };
  }),
  toggleFavorite: ({ id }) => {
    mock.favorites = mock.favorites.includes(id) ? mock.favorites.filter((x) => x !== id) : [...mock.favorites, id];
    return mock.favorites.includes(id);
  },
  setFavorite: ({ id, favorite }) => {
    mock.favorites = favorite ? [...mock.favorites.filter((x) => x !== id), id] : mock.favorites.filter((x) => x !== id);
    return state();
  },
  setOfflineMark: ({ id, mark }) => {
    if (mark) mock.offlineMarks[id] = mark;
    else delete mock.offlineMarks[id];
    return state();
  },
  editCollection: (op) => {
    mock.collections = editCollections(mock.collections, op);
    return state();
  },
  setEdit: ({ id, edit }) => {
    const original = [...manifests, ...mock.added.map((a) => a.manifest)].find((m) => m.id === id);
    if (!edit) {
      delete mock.edits[id];
      return state();
    }
    const { patch, errors } = editPatch(original, edit);
    if (errors.length) throw new Error(errors.join('; '));
    if (patch) mock.edits[id] = patch;
    else delete mock.edits[id];
    return state();
  },
  setTags: ({ id, tags }) => {
    const base = normalizeTags([...manifests, ...mock.added.map((a) => a.manifest)].find((m) => m.id === id).tags);
    const wanted = normalizeTags(tags ?? base);
    const edit = { added: wanted.filter((t) => !base.includes(t)), removed: base.filter((t) => !wanted.includes(t)) };
    if (edit.added.length || edit.removed.length) mock.tagEdits[id] = edit;
    else delete mock.tagEdits[id];
    return state();
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
  saveCode: ({ id }) => {
    const m = all().find((x) => x.id === id);
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    mock.code[id] = { id, repo: m.repo, ref: 'main', sha, committedAt: new Date(Date.now() - 9 * 86400000).toISOString(), dir: `/mock/${id}/source@${sha.slice(0, 12)}`, files: 214, sizeBytes: 3456789, savedAt: new Date().toISOString() };
    mockJob(`Saving the source of ${m.name}`, { id, distKey: 'code' });
    return mock.code[id];
  },
  removeCode: ({ id }) => {
    delete mock.code[id];
    return state();
  },
  openCode: () => '',
  webmirrorSnapshots: () => [],
  openSnapshot: () => ({ url: '' }),
  chooseDataFolder: () => '',
  moveData: ({ dir }) => ({ relaunching: true, dir }),
  installRuntime: () => {
    mock.webmirrorAt = new Date().toISOString();
    mock.python = { version: '3.12.16', dir: '/mock/runtimes/python', packages: ['webmirror[dynamic] @ https://github.com/DrFlGd/WebMirror/archive/refs/heads/main.zip'] };
    mockJob('Installing Python and WebMirror', null);
    return state();
  },
  updateWebMirror: () => {
    mock.webmirrorAt = new Date().toISOString();
    mockJob('Updating WebMirror', null);
    return state();
  },
  captureThumbnail: ({ id }) => {
    if (!mock.openWindows.includes(id)) throw new Error('Open the generator first, then take its thumbnail');
    mock.thumbnails[id] = mockPicture(all().find((m) => m.id === id)?.name ?? id);
    return state();
  },
  chooseThumbnail: ({ id }) => {
    mock.thumbnails[id] = mockPicture(`${all().find((m) => m.id === id)?.name ?? id} (file)`);
    return state();
  },
  removeThumbnail: ({ id }) => {
    delete mock.thumbnails[id];
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
    mock.added.push({ key: found.key, addedAt: new Date().toISOString(), manifest: { ...manifest, source: found.key, origin: 'yours' } });
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
