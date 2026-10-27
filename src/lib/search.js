// Search and filter over the resolved catalog. Scoring is deliberately simple:
// a name hit outranks a tag hit outranks a description hit, and every query word
// must match somewhere. Good enough for a few hundred generators, and it needs no
// index to rebuild.

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function searchable(manifest) {
  return {
    id: manifest.id,
    name: manifest.name.toLowerCase(),
    nameTokens: tokens(manifest.name),
    tags: manifest.tags.map((t) => t.toLowerCase()),
    text: tokens([manifest.summary, manifest.description, manifest.process, manifest.category, manifest.repo, manifest.collection?.name].join(' ')),
  };
}

function scoreOne(entry, word) {
  if (entry.name.includes(word)) return entry.name === word ? 12 : 8;
  if (entry.nameTokens.some((t) => t.startsWith(word))) return 6;
  if (entry.tags.some((t) => t === word)) return 5;
  if (entry.tags.some((t) => t.includes(word))) return 3;
  if (entry.id.includes(word)) return 3;
  if (entry.text.some((t) => t.startsWith(word))) return 1;
  return 0;
}

// filters: { tags: string[], kinds: string[], process: string, installed: boolean|null,
//            platform: string }  — `installedIds` is the set of ids with a local install.
export function search(manifests, query, filters = {}, installedIds = new Set()) {
  const words = tokens(query);
  const results = [];
  for (const manifest of manifests) {
    if (filters.tags?.length && !filters.tags.every((t) => manifest.tags.includes(t))) continue;
    if (filters.process && manifest.process !== filters.process) continue;
    if (filters.kinds?.length && !manifest.distributions.some((d) => filters.kinds.includes(d.kind))) continue;
    if (filters.installed === true && !installedIds.has(manifest.id)) continue;
    if (filters.installed === false && installedIds.has(manifest.id)) continue;
    if (filters.platform && !manifest.distributions.some((d) => !d.platform || d.platform === filters.platform)) continue;

    let score = 0;
    if (words.length) {
      const entry = searchable(manifest);
      let miss = false;
      for (const word of words) {
        const s = scoreOne(entry, word);
        if (!s) {
          miss = true;
          break;
        }
        score += s;
      }
      if (miss) continue;
    }
    results.push({ manifest, score });
  }
  results.sort((a, b) => b.score - a.score || a.manifest.name.localeCompare(b.manifest.name));
  return results.map((r) => r.manifest);
}

export function facets(manifests) {
  const tags = new Map();
  const processes = new Map();
  const kinds = new Map();
  for (const m of manifests) {
    for (const t of m.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    if (m.process) processes.set(m.process, (processes.get(m.process) ?? 0) + 1);
    for (const k of new Set(m.distributions.map((d) => d.kind))) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
  return { tags: sorted(tags), processes: sorted(processes), kinds: sorted(kinds) };
}
