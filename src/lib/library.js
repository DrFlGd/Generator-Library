// Persistent state: what is installed, where, at which version, plus settings and
// the user's own sources. One JSON file in the app's data folder, rewritten whole
// on every change (it is small). The install folders themselves live next to it:
//
//   <dataDir>/library.json
//   <dataDir>/apps/<id>/<distKey>/...     unpacked bundles and executables
//   <dataDir>/downloads/                  temporary archives
//   <dataDir>/catalog.json                last catalog fetched from GitHub

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  githubToken: '',
  catalogRepo: 'DrFlGd/Generator-Library',
  catalogPath: 'catalog/catalog.json',
  pythonPath: '',
  webmirrorHome: '',
  checkUpdatesOnStart: true,
};

export function emptyState() {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, installed: {}, sources: [], favorites: [], recent: [] };
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
    return this.state;
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
    await fs.rename(tmp, this.file);
  }

  installDir(id, distKey) {
    return path.join(this.appsDir, id, distKey.replace(/[^a-z0-9:_-]/gi, '_'));
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

  async setInstalled(record) {
    this.state.installed[this.recordKey(record.id, record.distKey)] = record;
    await this.save();
  }

  async removeInstalled(id, distKey) {
    delete this.state.installed[this.recordKey(id, distKey)];
    await this.save();
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

  async updateSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch };
    await this.save();
    return this.state.settings;
  }

  async addSource(source) {
    if (this.state.sources.some((s) => s.repo.toLowerCase() === source.repo.toLowerCase())) return false;
    this.state.sources.push(source);
    await this.save();
    return true;
  }

  async removeSource(repo) {
    this.state.sources = this.state.sources.filter((s) => s.repo.toLowerCase() !== repo.toLowerCase());
    await this.save();
  }
}
