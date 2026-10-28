// generator.json: the one file a generator repo carries so the library can list,
// install, launch and update it. See docs/MANIFEST.md for the human version.
//
// Everything here is pure: no network, no filesystem. The Electron main process and
// the tests both go through these functions, so a manifest that passes here is one
// the app can act on.

export const DISTRIBUTION_KINDS = ['web', 'bundle', 'exe', 'mirror'];
export const PLATFORMS = ['windows', 'macos', 'linux'];
export const INSTALL_KINDS = ['portable', 'installer', 'zip'];
// What using a generator costs: free, free with paid extras, or paid.
export const PRICINGS = ['free', 'freemium', 'paid'];

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

// `from` says where the bytes of a distribution come from. Three shapes:
//   { type: 'release', repo?, tag?, asset }   a GitHub release asset (tag defaults to latest)
//   { type: 'repo', repo?, ref?, path? }       files committed in the repository tree
//   { type: 'page', url, asset, folder? }      the newest file a website's download page
//                                              links to whose name matches `asset`; `folder`
//                                              is where a name its scripts hold is served (web.js)
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
  if (type === 'page') {
    const url = str(raw.url);
    if (!/^https?:\/\//.test(url)) errors.push(`${where}: page "from.url" must start with http(s)://`);
    const asset = str(raw.asset);
    if (!asset) errors.push(`${where}: page "from" needs an "asset" name or glob`);
    const out = { type, url, asset };
    const folder = str(raw.folder);
    if (folder) {
      if (!/^https?:\/\//.test(folder)) errors.push(`${where}: page "from.folder" must start with http(s)://`);
      out.folder = folder.endsWith('/') ? folder : `${folder}/`;
    }
    return out;
  }
  errors.push(`${where}: "from.type" must be "release", "repo" or "page"`);
  return null;
}

// Normalize a manifest's `requires` list. Each entry names a runtime and what to
// install into it. For python, package strings are pip requirement specs, objects
// may add the module to import as the "is it there" check. node needs nothing
// more; it is what builds from source run in (normalizeBuild).
export function normalizeRequires(raw, errors = [], where = 'requires') {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${where}: must be a list`);
    return [];
  }
  const out = [];
  raw.forEach((item, i) => {
    if (item && typeof item === 'object' && item.runtime === 'node') {
      out.push({ runtime: 'node' });
      return;
    }
    if (!item || typeof item !== 'object' || item.runtime !== 'python') {
      errors.push(`${where}[${i}]: "runtime" must be "python" or "node"`);
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
  let node = false;
  for (const list of lists) {
    for (const req of list ?? []) {
      if (req.runtime === 'node') node = true;
      if (req.runtime !== 'python') continue;
      python = true;
      for (const p of req.packages) if (!packages.has(p.spec)) packages.set(p.spec, p);
    }
  }
  const out = python ? [{ runtime: 'python', packages: [...packages.values()] }] : [];
  if (node) out.push({ runtime: 'node' });
  return out;
}

// What builds a web app from its repository: install its npm dependencies, run
// `steps` with the library's private Node.js, and host the `output` folder.
// Steps are argument lists starting with npm, npx or node, so they run the same
// on every platform without a shell. Dependency install scripts stay off unless
// `installScripts` is true.
export const BUILD_TOOLS = ['npm', 'npx', 'node'];

function normalizeBuild(raw, errors, where) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${where}: "build" must be an object`);
    return null;
  }
  const output = str(raw.output).replace(/^\/+|\/+$/g, '') || 'dist';
  if (output.split('/').includes('..')) errors.push(`${where}: "build.output" may not contain ".."`);
  let steps = [['npm', 'run', 'build']];
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps) || !raw.steps.length || !raw.steps.every((step) => Array.isArray(step) && step.length && step.every((a) => typeof a === 'string'))) {
      errors.push(`${where}: "build.steps" must be a list of argument lists`);
    } else if (!raw.steps.every((step) => BUILD_TOOLS.includes(step[0]))) {
      errors.push(`${where}: each build step must start with ${BUILD_TOOLS.join(', ')}`);
    } else {
      steps = raw.steps.map((step) => [...step]);
    }
  }
  const env = {};
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env)) errors.push(`${where}: "build.env" must be an object`);
    else for (const [k, v] of Object.entries(raw.env)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
  }
  return { output, steps, env, installScripts: raw.installScripts === true };
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
    if (raw.build !== undefined) {
      const build = normalizeBuild(raw.build, errors, where);
      if (dist.from && dist.from.type !== 'repo') errors.push(`${where}: "build" needs a repo "from"`);
      if (build) {
        dist.build = build;
        dist.requires = mergeRequires(dist.requires, [{ runtime: 'node' }]);
      }
    }
    dist.label ||= dist.build ? 'Build offline copy' : 'Install offline copy';
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
  const distributions = Array.isArray(raw.distributions)
    ? raw.distributions.map((d, i) => normalizeDistribution(d, i, errors)).filter(Boolean)
    : [];
  // A website added by link has no repository; only downloads need one to come from.
  if (!repo && distributions.some((d) => d.from && d.from.type !== 'page' && !d.from.repo)) {
    errors.push('"repo" is required when the manifest is not read from a repository');
  }
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
    category: str(raw.category).toLowerCase(),
    icon: str(raw.icon),
    screenshots: strList(raw.screenshots),
    homepage: str(raw.homepage),
    license: str(raw.license),
    author: str(raw.author),
    repo: repo ?? '',
    upstream: isValidRepo(raw.upstream) ? raw.upstream : '',
    requires: normalizeRequires(raw.requires, errors),
    distributions,
    // For filtering a large catalog: what it costs, whether downloading needs a
    // sign-up, the file types it makes, and whether its source is published.
    pricing: PRICINGS.includes(str(raw.pricing)) ? str(raw.pricing) : '',
    account: raw.account === true,
    exports: strList(raw.exports).map((e) => e.toLowerCase()),
    openSource: typeof raw.openSource === 'boolean' ? raw.openSource : Boolean(repo),
    listing: /^https:\/\//.test(str(raw.listing)) ? str(raw.listing) : '',
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
  const repo = isValidRepo(raw.repo) ? raw.repo : context.repo ?? '';
  if (!Array.isArray(raw.generators) || raw.generators.length === 0) {
    errors.push('collection "generators" must be a non-empty array');
  } else if (!repo && raw.generators.some((entry) => typeof entry?.path === 'string')) {
    // A website's list of other people's generators has no repository of its
    // own; each inline entry names its own `repo` when it has one.
    errors.push('collection "repo" is required when entries are paths in a repository');
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
