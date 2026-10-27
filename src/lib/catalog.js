// The catalog is the list of repositories the library knows about, plus the
// manifests it could read from them. catalog/catalog.json ships with the app and
// is also refreshed from the Generator-Library repo itself; the user can add their
// own sources from Settings.
//
// A source is { repo, manifest?, fallback?, overlay?, enabled? }:
//   repo       owner/name on GitHub
//   manifest   path of generator.json or generator-library.json in the repo
//              (default: try both at the root)
//   fallback   a snapshot of the manifest (or collection, with its entries
//              inlined) used only when the repo cannot be read: offline, a
//              private repo without a token, or a repo that has no manifest yet.
//              What the repo publishes always wins. `npm run sync:fallbacks`
//              refreshes the snapshots in the shipped catalog.
//   overlay    a manifest merged over the result (overlay wins): how a fork can
//              point at its upstream's releases or patch a listing.

import { applyDefaults, normalizeCollection, normalizeManifest, overlayManifest } from './manifest.js';

export const DEFAULT_MANIFEST_PATHS = ['generator.json', 'generator-library.json'];

export function normalizeCatalog(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { catalog: null, errors: ['catalog must be an object'] };
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  const out = [];
  sources.forEach((source, i) => {
    if (!source || typeof source !== 'object' || typeof source.repo !== 'string') {
      errors.push(`sources[${i}]: needs a "repo"`);
      return;
    }
    out.push({
      repo: source.repo,
      manifest: typeof source.manifest === 'string' ? source.manifest.replace(/^\/+/, '') : '',
      fallback: source.fallback && typeof source.fallback === 'object' ? source.fallback : null,
      overlay: source.overlay && typeof source.overlay === 'object' ? source.overlay : null,
      overlayOnly: source.overlayOnly === true,
      enabled: source.enabled !== false,
      note: typeof source.note === 'string' ? source.note : '',
    });
  });
  return { catalog: { version: Number(raw.version) || 1, sources: out }, errors };
}

function looksLikeCollection(raw) {
  return Boolean(raw && typeof raw === 'object' && Array.isArray(raw.generators));
}

// Expand one source into manifests. `readJson(repo, path)` returns parsed JSON or
// null; it is the only I/O and is injected. Nothing thrown here stops the other
// sources: each failure becomes a { repo, error } entry so the UI can show it.
export async function resolveSource(source, { readJson }) {
  const { repo } = source;
  const manifests = [];
  const problems = [];

  let published = null;
  let publishedPath = '';
  if (!source.overlayOnly) {
    const paths = source.manifest ? [source.manifest] : DEFAULT_MANIFEST_PATHS;
    for (const path of paths) {
      try {
        const data = await readJson(repo, path);
        if (data) {
          published = data;
          publishedPath = path;
          break;
        }
      } catch (error) {
        problems.push({ repo, path, error: error.message });
      }
    }
  }

  const raw = overlayManifest(published ?? source.fallback, source.overlay);
  if (!raw) {
    problems.push({ repo, error: `no generator.json or generator-library.json found in ${repo} and no fallback or overlay in the catalog` });
    return { manifests, problems };
  }

  if (looksLikeCollection(raw)) {
    const { collection, errors } = normalizeCollection(raw, { repo });
    if (!collection) {
      problems.push({ repo, path: publishedPath, error: errors.join('; ') });
      return { manifests, problems };
    }
    for (const entry of collection.entries) {
      let entryRaw = entry.inline;
      let entryPath = '';
      if (entry.path) {
        entryPath = entry.path;
        try {
          entryRaw = await readJson(collection.repo, entry.path);
        } catch (error) {
          problems.push({ repo, path: entry.path, error: error.message });
          continue;
        }
        if (!entryRaw) {
          problems.push({ repo, path: entry.path, error: 'listed in the collection but not found' });
          continue;
        }
      }
      const merged = applyDefaults(entryRaw, collection.defaults);
      const { manifest, errors: entryErrors } = normalizeManifest(merged, {
        repo: collection.repo,
        collection: { id: collection.id, name: collection.name },
        path: entryPath || publishedPath,
      });
      if (!manifest) problems.push({ repo, path: entryPath || publishedPath, error: entryErrors.join('; ') });
      else manifests.push(manifest);
    }
    return { manifests, problems };
  }

  const { manifest, errors } = normalizeManifest(raw, { repo, path: publishedPath });
  if (!manifest) problems.push({ repo, path: publishedPath, error: errors.join('; ') });
  else manifests.push(manifest);
  return { manifests, problems };
}

// Resolve every enabled source. Duplicate ids keep the first occurrence so the
// shipped catalog wins over a user-added source that reuses an id.
export async function resolveCatalog(catalog, io) {
  const manifests = [];
  const problems = [];
  const seen = new Set();
  for (const source of catalog.sources.filter((s) => s.enabled)) {
    const result = await resolveSource(source, io);
    problems.push(...result.problems);
    for (const manifest of result.manifests) {
      if (seen.has(manifest.id)) {
        problems.push({ repo: source.repo, error: `duplicate generator id "${manifest.id}" ignored` });
        continue;
      }
      seen.add(manifest.id);
      // Which source a generator came from, so Manage can list and remove it.
      manifests.push({ ...manifest, source: source.repo || source.url, origin: source.origin ?? 'catalog' });
    }
  }
  manifests.sort((a, b) => a.name.localeCompare(b.name));
  return { manifests, problems };
}
