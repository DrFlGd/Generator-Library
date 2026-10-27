// generator.json: the one file a generator repo carries so the library can list,
// install, launch and update it. See docs/MANIFEST.md for the human version.
//
// Everything here is pure: no network, no filesystem. The Electron main process and
// the tests both go through these functions, so a manifest that passes here is one
// the app can act on.

export const DISTRIBUTION_KINDS = ['web', 'bundle', 'exe', 'mirror'];
export const PLATFORMS = ['windows', 'macos', 'linux'];
export const INSTALL_KINDS = ['portable', 'installer', 'zip'];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function isValidRepo(repo) {
  return typeof repo === 'string' && REPO_RE.test(repo);
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function strList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(str).filter(Boolean))];
}

// `from` says where the bytes of a distribution come from. Two shapes:
//   { type: 'release', repo?, tag?, asset }   a GitHub release asset (tag defaults to latest)
//   { type: 'repo', repo?, ref?, path? }       files committed in the repository tree
function normalizeFrom(raw, errors, where) {
  if (!raw || typeof raw !== 'object') {
    errors.push(`${where}: missing "from"`);
    return null;
  }
  const type = str(raw.type);
  if (type === 'release') {
    const asset = str(raw.asset);
    if (!asset) errors.push(`${where}: release "from" needs an "asset" name or glob`);
    const out = { type, asset };
    if (raw.repo !== undefined) {
      if (!isValidRepo(raw.repo)) errors.push(`${where}: "from.repo" must be owner/name`);
      else out.repo = raw.repo;
    }
    const tag = str(raw.tag);
    out.tag = tag || 'latest';
    if (raw.prerelease === true) out.prerelease = true;
    return out;
  }
  if (type === 'repo') {
    const out = { type };
    if (raw.repo !== undefined) {
      if (!isValidRepo(raw.repo)) errors.push(`${where}: "from.repo" must be owner/name`);
      else out.repo = raw.repo;
    }
    const ref = str(raw.ref);
    if (ref) out.ref = ref;
    const path = str(raw.path).replace(/^\/+|\/+$/g, '');
    if (path.includes('..')) errors.push(`${where}: "from.path" may not contain ".."`);
    out.path = path;
    return out;
  }
  errors.push(`${where}: "from.type" must be "release" or "repo"`);
  return null;
}

// Normalize a manifest's `requires` list. Each entry names a runtime and what to
// install into it; package strings are pip requirement specs, objects may add the
// module to import as the "is it there" check.
export function normalizeRequires(raw, errors = [], where = 'requires') {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${where}: must be a list`);
    return [];
  }
  const out = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object' || item.runtime !== 'python') {
      errors.push(`${where}[${i}]: "runtime" must be "python"`);
      return;
    }
    const packages = (Array.isArray(item.packages) ? item.packages : []).map((p) => (typeof p === 'string' ? { spec: p.trim() } : { spec: String(p?.spec ?? '').trim(), import: typeof p?.import === 'string' ? p.import.trim() : undefined })).filter((p) => p.spec);
    out.push({ runtime: 'python', packages });
  });
  return out;
}

// Fold several requirement lists into one per runtime, packages de-duplicated.
export function mergeRequires(...lists) {
  const packages = new Map();
  let python = false;
  for (const list of lists) {
    for (const req of list ?? []) {
      if (req.runtime !== 'python') continue;
      python = true;
      for (const p of req.packages) if (!packages.has(p.spec)) packages.set(p.spec, p);
    }
  }
  return python ? [{ runtime: 'python', packages: [...packages.values()] }] : [];
}

function normalizeDistribution(raw, index, errors) {
  const where = `distributions[${index}]`;
  if (!raw || typeof raw !== 'object') {
    errors.push(`${where}: must be an object`);
    return null;
  }
  const kind = str(raw.kind);
  if (!DISTRIBUTION_KINDS.includes(kind)) {
    errors.push(`${where}: "kind" must be one of ${DISTRIBUTION_KINDS.join(', ')}`);
    return null;
  }
  const dist = { kind, label: str(raw.label) };
  if (raw.platform !== undefined) {
    const platform = str(raw.platform);
    if (!PLATFORMS.includes(platform)) errors.push(`${where}: "platform" must be one of ${PLATFORMS.join(', ')}`);
    else dist.platform = platform;
  }
  if (raw.notes !== undefined) dist.notes = str(raw.notes);
  const requires = normalizeRequires(raw.requires, errors, `${where}.requires`);
  if (requires.length) dist.requires = requires;

  if (kind === 'web') {
    const url = str(raw.url);
    if (!/^https?:\/\//.test(url)) errors.push(`${where}: web "url" must start with http(s)://`);
    dist.url = url;
    dist.label ||= 'Open online';
  } else if (kind === 'mirror') {
    // A live site captured with WebMirror for offline use. The url is the page to
    // mirror; githubPagesFiles asks WebMirror to also pull the published repo files.
    const url = str(raw.url);
    if (!/^https?:\/\//.test(url)) errors.push(`${where}: mirror "url" must start with http(s)://`);
    dist.url = url;
    dist.githubPagesFiles = raw.githubPagesFiles === true;
    dist.browserCapture = raw.browserCapture !== false;
    dist.label ||= 'Mirror for offline use';
  } else if (kind === 'bundle') {
    // A static web build (what GitHub Pages would serve) that the library hosts
    // itself on 127.0.0.1. `entry` is the page to open; `spa` reloads it for
    // unknown routes the way a Pages/Vercel deploy would.
    dist.from = normalizeFrom(raw.from, errors, where);
    dist.entry = str(raw.entry).replace(/^\/+/, '') || 'index.html';
    dist.spa = raw.spa === true;
    dist.label ||= 'Install offline copy';
  } else if (kind === 'exe') {
    // A standalone executable. `install` says what the downloaded asset is:
    //   portable   run the file directly
    //   installer  run it once so it installs itself, then it is launched by `exec`
    //   zip        unpack, then run `exec` inside it
    dist.from = normalizeFrom(raw.from, errors, where);
    const install = str(raw.install) || 'portable';
    if (!INSTALL_KINDS.includes(install)) errors.push(`${where}: "install" must be one of ${INSTALL_KINDS.join(', ')}`);
    dist.install = install;
    if (!dist.platform) errors.push(`${where}: exe distributions need a "platform"`);
    const exec = str(raw.exec);
    if (install === 'zip' && !exec) errors.push(`${where}: zip distributions need "exec" (path inside the archive)`);
    if (exec) dist.exec = exec;
    dist.label ||= install === 'installer' ? 'Install app' : 'Install';
  }
  return dist;
}

// Validate a raw generator.json object and return the normalized manifest.
// `context.repo` is the repository the manifest was read from and becomes the
// default source for updates. Returns { manifest, errors }; manifest is null when
// errors is non-empty.
export function normalizeManifest(raw, context = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: null, errors: ['manifest must be a JSON object'] };
  }
  const id = str(raw.id);
  if (!isValidId(id)) errors.push('"id" must be lowercase letters, digits and dashes (max 64)');
  const name = str(raw.name);
  if (!name) errors.push('"name" is required');

  const repo = isValidRepo(raw.repo) ? raw.repo : context.repo;
  if (raw.repo !== undefined && !isValidRepo(raw.repo)) errors.push('"repo" must be owner/name');
  if (!repo) errors.push('"repo" is required when the manifest is not read from a repository');

  const distributions = Array.isArray(raw.distributions)
    ? raw.distributions.map((d, i) => normalizeDistribution(d, i, errors)).filter(Boolean)
    : [];
  if (!Array.isArray(raw.distributions) || raw.distributions.length === 0) {
    errors.push('"distributions" must list at least one way to run the generator');
  }

  if (errors.length) return { manifest: null, errors };

  // Every distribution gets a key that is unique within the manifest, so two
  // web links (own site and MakerWorld, say) can be told apart by the UI and in
  // install records: "web", "web-2", "exe:windows:installer", ...
  const seenKeys = new Map();
  for (const dist of distributions) {
    const base = [dist.kind, dist.platform ?? '', dist.install ?? ''].filter(Boolean).join(':');
    const n = (seenKeys.get(base) ?? 0) + 1;
    seenKeys.set(base, n);
    dist.key = n === 1 ? base : `${base}-${n}`;
  }

  const manifest = {
    id,
    name,
    version: str(raw.version),
    summary: str(raw.summary),
    description: str(raw.description),
    tags: strList(raw.tags),
    process: str(raw.process),
    category: str(raw.category),
    icon: str(raw.icon),
    screenshots: strList(raw.screenshots),
    homepage: str(raw.homepage),
    license: str(raw.license),
    author: str(raw.author),
    repo,
    upstream: isValidRepo(raw.upstream) ? raw.upstream : '',
    requires: normalizeRequires(raw.requires, errors),
    distributions,
  };
  if (errors.length) return { manifest: null, errors };
  if (context.collection) manifest.collection = context.collection;
  if (context.path) manifest.manifestPath = context.path;
  return { manifest, errors: [] };
}

// A collection (generator-library.json) describes a repo that holds several
// generators, such as a monorepo with apps/*. Each entry is either an inline
// manifest or { path } pointing at a generator.json inside the repo. Shared
// fields (tags, process, license, repo) apply to every entry unless it overrides.
export function normalizeCollection(raw, context = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { collection: null, errors: ['collection must be a JSON object'] };
  }
  const id = str(raw.id);
  if (!isValidId(id)) errors.push('collection "id" must be lowercase letters, digits and dashes');
  const repo = isValidRepo(raw.repo) ? raw.repo : context.repo;
  if (!repo) errors.push('collection "repo" is required when not read from a repository');
  if (!Array.isArray(raw.generators) || raw.generators.length === 0) {
    errors.push('collection "generators" must be a non-empty array');
  }
  if (errors.length) return { collection: null, errors };

  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  const entries = raw.generators.map((entry, i) => {
    if (entry && typeof entry === 'object' && typeof entry.path === 'string' && Object.keys(entry).length === 1) {
      return { path: entry.path.replace(/^\/+/, '') };
    }
    return { inline: entry, index: i };
  });
  return {
    collection: {
      id,
      name: str(raw.name) || id,
      repo,
      defaults,
      entries,
    },
    errors: [],
  };
}

// Merge a collection's defaults under an entry's own fields. Arrays (tags) are
// unioned, scalars are taken from the entry when present.
export function applyDefaults(entry, defaults) {
  const out = { ...defaults, ...entry };
  if (Array.isArray(defaults.tags) || Array.isArray(entry.tags)) {
    out.tags = [...new Set([...(defaults.tags ?? []), ...(entry.tags ?? [])])];
  }
  return out;
}

// Overlay one manifest on another: used by the catalog to patch or complete a
// manifest a repo publishes. Distributions in the overlay replace the base set
// only when given; everything else is a field-level override.
export function overlayManifest(base, overlay) {
  if (!overlay) return base;
  if (!base) return overlay;
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    if (key === 'tags') out.tags = [...new Set([...(base.tags ?? []), ...value])];
    else out[key] = value;
  }
  return out;
}

export function distributionKey(dist) {
  return dist.key ?? [dist.kind, dist.platform ?? '', dist.install ?? ''].filter(Boolean).join(':');
}

export function currentPlatform(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

// Distributions the running machine can use, in the order the UI offers them.
export function usableDistributions(manifest, platform = currentPlatform()) {
  return manifest.distributions.filter((d) => !d.platform || d.platform === platform);
}
