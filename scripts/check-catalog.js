// Resolve the shipped catalog offline (overlays only) and fail on any manifest
// error, so a broken catalog never reaches a release.
import { readFile } from 'node:fs/promises';
import { normalizeCatalog, resolveCatalog } from '../src/lib/catalog.js';

const raw = JSON.parse(await readFile(new URL('../catalog/catalog.json', import.meta.url), 'utf8'));
const { catalog, errors } = normalizeCatalog(raw);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const { manifests, problems } = await resolveCatalog(catalog, { readJson: async () => null });
for (const p of problems) console.error(`${p.repo}${p.path ? '/' + p.path : ''}: ${p.error}`);
console.log(`${manifests.length} generators from ${catalog.sources.length} sources`);
for (const m of manifests) console.log(`  ${m.id.padEnd(32)} ${m.distributions.map((d) => d.kind + (d.platform ? ':' + d.platform : '')).join(', ')}`);
if (problems.length) process.exit(1);
