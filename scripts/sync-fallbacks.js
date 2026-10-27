// Refresh the `fallback` snapshots in catalog/catalog.json from what each
// repository publishes on GitHub. Collections are stored with their entries
// inlined so the snapshot resolves without any further reads. A repository that
// cannot be read (private without GITHUB_TOKEN, offline) keeps its old snapshot
// and fails the run; one that publishes no manifest (a third-party project
// described only here) keeps its hand-written fallback.
import { readFile, writeFile } from 'node:fs/promises';
import { createGitHub } from '../src/lib/github.js';
import { DEFAULT_MANIFEST_PATHS } from '../src/lib/catalog.js';

const file = new URL('../catalog/catalog.json', import.meta.url);
const raw = JSON.parse(await readFile(file, 'utf8'));
const github = createGitHub({ token: process.env.GITHUB_TOKEN ?? '' });
let failures = 0;

for (const source of raw.sources ?? []) {
  if (source.overlayOnly) continue;
  const paths = source.manifest ? [source.manifest] : DEFAULT_MANIFEST_PATHS;
  let published = null;
  let publishedPath = '';
  try {
    for (const path of paths) {
      published = await github.readJson(source.repo, path);
      if (published) {
        publishedPath = path;
        break;
      }
    }
  } catch (error) {
    console.error(`${source.repo}: ${error.message}; keeping the existing fallback`);
    failures += 1;
    continue;
  }
  if (!published) {
    console.log(`${source.repo}: publishes no manifest; fallback kept as written`);
    continue;
  }

  if (Array.isArray(published.generators)) {
    const generators = [];
    for (const entry of published.generators) {
      if (entry && typeof entry.path === 'string' && Object.keys(entry).length === 1) {
        const inline = await github.readJson(source.repo, entry.path.replace(/^\/+/, ''));
        if (!inline) {
          console.error(`${source.repo}/${entry.path}: listed in the collection but not found; skipped`);
          continue;
        }
        delete inline.$schema;
        generators.push(inline);
      } else {
        generators.push(entry);
      }
    }
    published.generators = generators;
  }
  delete published.$schema;
  source.fallback = published;
  console.log(`${source.repo}: snapshot of ${publishedPath}${published.generators ? ` (${published.generators.length} entries)` : ''}`);
}

await writeFile(file, JSON.stringify(raw, null, 2) + '\n');
process.exit(failures ? 1 : 0);
