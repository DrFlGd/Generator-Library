// Persistent state: what is installed, where, at which version, plus settings and
// the user's own sources. One JSON file in the app's data folder, rewritten whole
// on every change (it is small). The install folders themselves live next to it:
//
//   <dataDir>/library.json
//   <dataDir>/apps/<id>/<distKey>@<version>/...  unpacked bundles and executables,
//                                         one folder per kept version
//   <dataDir>/apps/<id>/source@<commit>/  a copy of the generator's repository,
//                                         kept to work on (source.js)
//   <dataDir>/downloads/                  temporary archives
//   <dataDir>/catalog.json                last catalog fetched from GitHub
//   <dataDir>/runtimes/                   private runtimes such as Python (runtimes.js)

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  githubToken: '',
  catalogRepo: 'DrFlGd/Generator-Library',
  catalogPath: 'catalog/catalog.json',
  pythonPath: '',
  webmirrorHome: '',
  checkUpdatesOnStart: true,
  keepVersions: 2, // older versions kept per app after an update, to switch back to
  resyncDays: 30, // suggest mirroring a site again once its copy is this old; 0 = never
};

export function sourceKey(source) {
  return source.repo || source.url || '';
}

// Records hold absolute paths. When the data folder has moved (Settings, or a
// portable drive that came back under another letter), every path under the old
// folder is rewritten under the new one.
export function rebasePaths(value, from, to) {
  const sameRoot = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const prefix = sameRoot(from.endsWith(path.sep) ? from : from + path.sep);
  const walk = (v) => {
    if (typeof v === 'string') return sameRoot(v).startsWith(prefix) || sameRoot(v) === sameRoot(from) ? path.join(to, v.slice(from.length)) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

// A tag as typed becomes lowercase words joined by dashes: "Pegboard Hooks" → "pegboard-hooks".
export function normalizeTag(tag) {
  return String(tag ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function normalizeTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : []).map(normalizeTag).filter(Boolean))];
}

// The catalog's tags with your additions and removals applied.
export function applyTagEdits(tags, edits) {
  if (!edits) return tags;
  const removed = new Set(edits.removed ?? []);
  const kept = tags.filter((t) => !removed.has(normalizeTag(t)));
  const have = new Set(kept.map(normalizeTag));
  return [...kept, ...(edits.added ?? []).filter((t) => !have.has(t))];
}

// Your own collections: named lists of generator ids, in the order you made
// them. One function serves every change so the app and its browser mock agree.
//   { type: 'create', name, ids? } | { type: 'rename', collection, name }
//   { type: 'delete', collection } | { type: 'set', collection, id, member }
export function editCollections(collections, op, now = Date.now()) {
  const list = Array.isArray(collections) ? collections.map((c) => ({ ...c, ids: [...c.ids] })) : [];
  const name = String(op.name ?? '').trim().slice(0, 60);
  const find = () => {
    const found = list.find((c) => c.id === op.collection);
    if (!found) throw new Error('That collection no longer exists');
    return found;
  };
  if (op.type === 'create') {
    if (!name) throw new Error('Give the collection a name');
    let id = `c${now.toString(36)}`;
    while (list.some((c) => c.id === id)) id += 'x';
    list.push({ id, name, ids: [...new Set(op.ids ?? [])] });
  } else if (op.type === 'rename') {
    if (!name) throw new Error('Give the collection a name');
    find().name = name;
  } else if (op.type === 'delete') {
    find();
    return list.filter((c) => c.id !== op.collection);
  } else if (op.type === 'set') {
    const c = find();
    c.ids = c.ids.filter((x) => x !== op.id);
    if (op.member) c.ids.push(op.id);
  } else {
    throw new Error(`Unknown collection change "${op.type}"`);
  }
  return list;
}

export function emptyState() {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, installed: {}, sources: [], favorites: [], recent: [], runtimes: {}, hidden: [], removedSources: [], kept: {}, tagEdits: {}, collections: [], offlineMarks: {}, edits: {}, code: {} };
}

export class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'library.json');
    this.appsDir = path.join(dataDir, 'apps');
    this.downloadsDir = path.join(dataDir, 'downloads');
    this.state = emptyState();
  }

  async load() {
    await fs.mkdir(this.appsDir, { recursive: true });
    await fs.mkdir(this.downloadsDir, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.state = { ...emptyState(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) } };
    } catch {
      this.state = emptyState();
    }
    if (this.state.root && this.state.root !== this.dataDir) {
      for (const key of ['installed', 'kept', 'runtimes', 'code']) this.state[key] = rebasePaths(this.state[key], this.state.root, this.dataDir);
      this.state.root = this.dataDir;
      await this.save();
    }
    this.state.root = this.dataDir;
    return this.state;
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
    await fs.rename(tmp, this.file);
  }

  // Distribution keys carry colons (exe:windows:zip), which Windows does not
  // allow in paths, so the folder name is the key with anything unsafe replaced.
  installDir(id, distKey) {
    return path.join(this.appsDir, id, distKey.replace(/[^a-z0-9_-]/gi, '_'));
  }

  // Each installed version gets its own folder, so an update leaves the previous
  // one in place to switch back to. Installs from before versions were kept live
  // in installDir itself; their records still point there.
  versionDir(id, distKey, version) {
    return `${this.installDir(id, distKey)}@${String(version).replace(/[^a-z0-9._-]/gi, '_')}`;
  }

  // Installed records are keyed by `${id}/${distKey}` so a generator can have both
  // an offline bundle and a Windows executable installed side by side.
  recordKey(id, distKey) {
    return `${id}/${distKey}`;
  }

  getInstalled(id, distKey) {
    return this.state.installed[this.recordKey(id, distKey)] ?? null;
  }

  installedFor(id) {
    return Object.values(this.state.installed).filter((r) => r.id === id);
  }

  installedIds() {
    return new Set(Object.values(this.state.installed).map((r) => r.id));
  }

  // The saved copy of a generator's repository, one per generator.
  codeDir(id, sha) {
    return path.join(this.appsDir, id, `source@${String(sha).slice(0, 12).replace(/[^a-z0-9]/gi, '_')}`);
  }

  getCode(id) {
    return this.state.code[id] ?? null;
  }

  async setCode(id, record) {
    if (record) this.state.code[id] = record;
    else delete this.state.code[id];
    await this.save();
  }

  async setInstalled(record) {
    this.state.installed[this.recordKey(record.id, record.distKey)] = record;
    await this.save();
  }

  async removeInstalled(id, distKey) {
    delete this.state.installed[this.recordKey(id, distKey)];
    delete this.state.kept[this.recordKey(id, distKey)];
    await this.save();
  }

  // Versions installed earlier and kept beside the one that launches, newest build first.
  keptFor(id, distKey) {
    return this.state.kept[this.recordKey(id, distKey)] ?? [];
  }

  // Make `record` the version that launches. The one it replaces is kept unless
  // it is the same version; kept versions beyond `keep` are dropped. Returns the
  // records no longer referenced, whose folders the caller deletes.
  async activate(record, { keep = this.state.settings.keepVersions } = {}) {
    const key = this.recordKey(record.id, record.distKey);
    const previous = this.state.installed[key];
    let kept = (this.state.kept[key] ?? []).filter((r) => r.version !== record.version);
    const dropped = (this.state.kept[key] ?? []).filter((r) => r.version === record.version && r.dir !== record.dir);
    if (previous && previous.version !== record.version) kept.push(previous);
    else if (previous && previous.dir !== record.dir) dropped.push(previous);
    // Past the limit the oldest builds go, so trying an old version never
    // deletes a newer one.
    const age = (r) => r.publishedAt || r.installedAt || '';
    kept.sort((x, y) => (age(x) < age(y) ? 1 : age(x) > age(y) ? -1 : 0));
    const limit = Number(keep) >= 0 ? Number(keep) : DEFAULT_SETTINGS.keepVersions;
    dropped.push(...kept.slice(limit));
    kept = kept.slice(0, limit);
    this.state.installed[key] = record;
    if (kept.length) this.state.kept[key] = kept;
    else delete this.state.kept[key];
    await this.save();
    return dropped;
  }

  // Switch to a kept version without downloading anything.
  async useKept(id, distKey, version, { pinned = true } = {}) {
    const record = this.keptFor(id, distKey).find((r) => r.version === version);
    if (!record) throw new Error(`Version ${version} is not kept`);
    return this.activate({ ...record, pinned }, { keep: Infinity });
  }

  async removeKept(id, distKey, version) {
    const key = this.recordKey(id, distKey);
    const record = this.keptFor(id, distKey).find((r) => r.version === version);
    if (!record) return null;
    const rest = this.keptFor(id, distKey).filter((r) => r !== record);
    if (rest.length) this.state.kept[key] = rest;
    else delete this.state.kept[key];
    await this.save();
    return record;
  }

  async touchRecent(id) {
    this.state.recent = [id, ...this.state.recent.filter((x) => x !== id)].slice(0, 20);
    await this.save();
  }

  async toggleFavorite(id) {
    const set = new Set(this.state.favorites);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.state.favorites = [...set];
    await this.save();
    return set.has(id);
  }

  async setFavorite(id, favorite) {
    const rest = this.state.favorites.filter((x) => x !== id);
    this.state.favorites = favorite ? [...rest, id] : rest;
    await this.save();
    return favorite;
  }

  // Your own tags for a generator are kept as what you added to and removed from
  // the catalog's tags, so tags the catalog adds later still show up.
  async setTags(id, tags, catalogTags = []) {
    const wanted = normalizeTags(tags);
    const base = normalizeTags(catalogTags);
    const added = wanted.filter((t) => !base.includes(t));
    const removed = base.filter((t) => !wanted.includes(t));
    if (added.length || removed.length) this.state.tagEdits[id] = { added, removed };
    else delete this.state.tagEdits[id];
    await this.save();
    return applyTagEdits(catalogTags, this.state.tagEdits[id]);
  }

  // Your own version of a generator's links, repository and distributions (the
  // fields of the Edit dialog that differ from the catalog); null removes it.
  async setEdit(id, patch) {
    if (patch && Object.keys(patch).length) this.state.edits[id] = patch;
    else delete this.state.edits[id];
    await this.save();
    return this.state.edits[id] ?? null;
  }

  // Whether a generator's mirror turned out to work without the internet:
  // 'works', 'broken', or '' to clear. Many sites still need their server.
  async setOfflineMark(id, mark) {
    if (!['works', 'broken', ''].includes(mark)) throw new Error(`Unknown offline mark "${mark}"`);
    if (mark) this.state.offlineMarks[id] = mark;
    else delete this.state.offlineMarks[id];
    await this.save();
    return mark;
  }

  async editCollection(op) {
    this.state.collections = editCollections(this.state.collections, op);
    await this.save();
    return this.state.collections;
  }

  async updateSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch };
    await this.save();
    return this.state.settings;
  }

  // A source you added is a repository ({ repo, manifest?, fallback? }) or a
  // website ({ url, overlay }); `sourceKey` names either.
  async addSource(source) {
    const key = sourceKey(source).toLowerCase();
    if (this.state.sources.some((s) => sourceKey(s).toLowerCase() === key)) return false;
    this.state.sources.push(source);
    this.state.removedSources = this.state.removedSources.filter((k) => k.toLowerCase() !== key);
    await this.save();
    return true;
  }

  async removeSource(key) {
    const lower = key.toLowerCase();
    this.state.sources = this.state.sources.filter((s) => sourceKey(s).toLowerCase() !== lower);
    await this.save();
  }

  // Catalog sources cannot be deleted from the shipped catalog; removing one
  // hides it here until it is restored.
  async setSourceRemoved(key, removed) {
    const lower = key.toLowerCase();
    const rest = this.state.removedSources.filter((k) => k.toLowerCase() !== lower);
    this.state.removedSources = removed ? [...rest, key] : rest;
    await this.save();
  }

  async setHidden(id, hidden) {
    const rest = this.state.hidden.filter((x) => x !== id);
    this.state.hidden = hidden ? [...rest, id] : rest;
    await this.save();
  }
}
