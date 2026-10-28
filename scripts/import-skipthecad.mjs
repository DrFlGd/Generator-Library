#!/usr/bin/env node
// Import the generators listed on SkipTheCAD (https://skipthecad.com/), a
// directory of 3D-print generators, into catalog/catalog.json. Run it again at
// any time: it rewrites only the sources whose url is on skipthecad.com, one
// collection per SkipTheCAD category, and leaves every other source alone.
//
//   node scripts/import-skipthecad.mjs [--summary file.md] [--cache facts.json]
//
// How each listing becomes distributions:
// - Always a link to the generator itself (MakerWorld models stay links only).
// - With a GitHub repository: an offline copy from its releases (a web zip or
//   desktop builds), or built from source when it is a plain Vite or Create
//   React App project, or the static files it publishes (from its default
//   branch or its gh-pages branch); a mirror only when none of those works.
// - Without one: a WebMirror copy, but only for free tools that need no account
//   and run in the browser, and not for AI tools, which run on their servers.
// Generators the catalog already lists (same id, address or repository) are
// skipped. GITHUB_TOKEN, when set, is used for the GitHub API (60 requests an
// hour without one).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SITE = 'https://skipthecad.com/';
const UA = 'GeneratorLibraryCatalog/1.0 (+https://github.com/DrFlGd/Generator-Library)';
const NOT_REPO_OWNERS = new Set(['sponsors', 'features', 'orgs', 'topics', 'marketplace', 'apps', 'login', 'about', 'settings', 'site', 'simplysolid3d']);
// Listings of generators the catalog has under another address (a MakerLab
// page for an app the catalog lists by its repository): SkipTheCAD slug → catalog id.
const SAME_AS = { 'makerlab-folding-box-generator': 'foldbox', 'makerlab-clicker-generator': 'clicker-generator' };
// Repositories this library builds itself (scripts/bundles/<id>.sh, published by
// library-bundles.yml) because their own files are not a page that runs offline.
const LIBRARY_BUNDLES = {
  'martynallen/bahtinov-mask-generator': {
    id: 'bahtinov-mask',
    notes: "A page this library made around the repository's mask engine, rebuilt whenever the engine changes. It runs fully offline.",
  },
  'nicremo/generatestl': {
    id: 'generatestl',
    notes: "A page this library made around the repository's engine, which generatestl.com runs on its server. Here it runs inside the page, rebuilt whenever the engine changes, so every part works offline.",
  },
};
export function libraryBundle(repo) {
  const known = LIBRARY_BUNDLES[repo.toLowerCase()];
  if (!known) return null;
  const { id, notes } = known;
  return { kind: 'bundle', label: 'Install offline copy', from: { type: 'release', repo: 'DrFlGd/Generator-Library', tag: `${id}-*`, asset: `${id}-web-*.zip`, prerelease: true }, notes };
}
// Hosts whose pages need their own servers or an account, so a mirror can't run them.
const NO_MIRROR_HOSTS = [/(^|\.)makerworld\.com$/, /(^|\.)huggingface\.co$/, /(^|\.)hf\.space$/, /(^|\.)thingiverse\.com$/, /(^|\.)printables\.com$/, /(^|\.)crealitycloud\.com$/, /(^|\.)useless\.works$/, /(^|\.)thavision\.com$/, /(^|\.)vextrude\.com$/, /(^|\.)perplexinglabs\.com$/, /(^|\.)alpaco\.it$/, /(^|\.)generatestl\.com$/];

// ───────────────────────────── parsing a listing ─────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(text) {
  return String(text ?? '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) => {
      if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const stripTags = (html) => decode(String(html).replace(/<[^>]*>/g, ' '));

// The generator pages listed in a sitemap.
export function sitemapPages(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]).filter((u) => /\/generators\/[^/]+\/?$/.test(u));
}

// The generator's own address, without referral and campaign parameters.
export function withoutTracking(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (/^(?:via|ref|utm_\w+)$/i.test(key)) u.searchParams.delete(key);
    return u.href;
  } catch {
    return '';
  }
}

export function parseListing(html, url) {
  const graph = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(m[1]);
      graph.push(...(Array.isArray(data['@graph']) ? data['@graph'] : [data]));
    } catch {
      /* not JSON */
    }
  }
  const app = graph.find((g) => g['@type'] === 'WebApplication' || g['@type'] === 'SoftwareApplication') ?? {};
  const crumbs = graph.find((g) => g['@type'] === 'BreadcrumbList')?.itemListElement ?? [];
  const crumb = crumbs.find((c) => /\/category\/[^/]+\/?$/.test(c.item ?? ''));
  const fields = {};
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    // A note under a value (<span class="spec__note">) is commentary, not the value.
    fields[stripTags(m[1])] = stripTags(m[2].replace(/<span[^>]*spec__note[\s\S]*?<\/span>/g, ''));
  }
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    try {
      const href = new URL(decode(m[1]), url).href;
      if (!href.startsWith(SITE)) links.push({ text: stripTags(m[2]), href });
    } catch {
      /* not a URL */
    }
  }
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const tagline = html.match(/class="[^"]*t-head__tagline[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const open = links.find((l) => /^Open generator\b/i.test(l.text))?.href;
  const generatorUrl = withoutTracking(open || app.url || '');
  return {
    slug: new URL(url).pathname.split('/').filter(Boolean).pop(),
    listing: url,
    name: decode(app.name) || (h1 ? stripTags(h1[1]) : ''),
    summary: decode(app.description) || (tagline ? stripTags(tagline[1]) : ''),
    url: generatorUrl,
    sameAs: Array.isArray(app.sameAs) ? app.sameAs : app.sameAs ? [app.sameAs] : [],
    features: Array.isArray(app.featureList) ? app.featureList.map(decode) : [],
    price: decode(app.offers?.description) || fields.Price || '',
    category: crumb ? { slug: crumb.item.split('/').filter(Boolean).pop(), name: decode(crumb.name) } : null,
    fields,
    links,
  };
}

// The repository a listing is about: the one its links point at most, or whose
// GitHub Pages site the generator runs on.
export function pickRepo(listing) {
  const count = new Map();
  const add = (repo, n) => count.set(repo.toLowerCase(), { repo, n: (count.get(repo.toLowerCase())?.n ?? 0) + n });
  for (const { href } of listing.links) {
    const m = href.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/i);
    if (m && !NOT_REPO_OWNERS.has(m[1].toLowerCase())) add(`${m[1]}/${m[2].replace(/\.git$/, '')}`, 1);
  }
  const pages = listing.url.match(/^https?:\/\/([\w-]+)\.github\.io\/([\w.-]+)?/i);
  if (pages) add(`${pages[1]}/${pages[2] || `${pages[1]}.github.io`}`, 5);
  return [...count.values()].sort((a, b) => b.n - a.n)[0]?.repo ?? '';
}

// ───────────────────────────── from listing to manifest ─────────────────────────────

const PAID = /[$€£₽]|\b(?:usd|eur|rub)\b|\bpaid\b|subscription|credits?\b|\bpro\b|premium|\bplan\b|\btier\b|per month|\/mo\b|\bcosts?\b|one-time|\bunlock|purchase|patreon/i;
// Phrases that mention money without charging for the generator: tips,
// donations, a print service, a licence for selling prints, "no paid plan".
const NOT_A_PRICE = /\b(?:no|not)\b[^;.]*?\b(?:paid|prices?|payment|credits?|card|tier|plan)\b[^;.]*|\boptional\b[^;.]*|\b(?:tips?|tip jar|donations?|ko-fi|buy me a coffee|github sponsors)\b[^;.]*|[^;.]*\bsold separately\b[^;.]*|[^;.]*\b(?:selling|sell) (?:the )?(?:prints|boxes)\b[^;.]*|[^;.]*commercial (?:use|licen[cs]e)[^;.]*/gi;
export function pricingOf(price) {
  const p = String(price ?? '').toLowerCase();
  if (!p) return '';
  const charged = PAID.test(p.replace(NOT_A_PRICE, ''));
  if (/\bfree\b/.test(p.replace(/\bno free\b/g, ''))) return charged ? 'freemium' : 'free';
  return charged || !/no prices? shown/.test(p) ? 'paid' : '';
}

export function exportsOf(text) {
  return [...new Set(String(text ?? '').split(/,|\/|\band\b|\bor\b|\+/i).map((s) => s.trim().toLowerCase().replace(/\s*\(.*$/, '')).filter((s) => /^[a-z0-9.]{2,8}$/.test(s)))];
}

// "MiniSkyline-1.2.3-setup.exe" → "MiniSkyline-*-setup.exe", so newer releases match.
export function assetGlob(name) {
  return name.replace(/v?\d+(?:\.\d+)+(?:-(?:alpha|beta|rc|pre)[0-9.]*)?(?=[-_.])/i, '*');
}

function desktopFrom(asset, repo) {
  const from = { type: 'release', repo, asset: assetGlob(asset) };
  if (/\.exe$/i.test(asset)) return { kind: 'exe', platform: 'windows', install: /setup|install/i.test(asset) ? 'installer' : 'portable', from };
  if (/\.dmg$/i.test(asset)) return { kind: 'exe', platform: 'macos', install: 'installer', from };
  if (/\.AppImage$/i.test(asset)) return { kind: 'exe', platform: 'linux', install: 'portable', from };
  return null;
}

function safePath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

// Whether `url` is the site a repository's gh-pages branch publishes, rather than
// its documentation or a project page for a tool hosted elsewhere.
export function isPagesSite(url, repo, cname = '') {
  try {
    const u = new URL(url);
    const [owner, name] = repo.toLowerCase().split('/');
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (cname) return host === cname.replace(/^www\./, '');
    return host === `${owner}.github.io` && u.pathname.toLowerCase().split('/')[1] === name;
  } catch {
    return false;
  }
}

// Offline distributions a repository supports, best first. `url` is where the
// generator runs online.
export function offlineFromRepo(facts, url = '') {
  const repo = facts.full;
  const out = [];
  const assets = (facts.releases?.find((r) => !r.pre && r.assets.length) ?? facts.releases?.[0])?.assets ?? [];
  const webZip = assets.find((a) => /(^|[-_.])(web|site|dist|www|pages|static)([-_.]|$).*\.zip$/i.test(a));
  if (webZip) {
    out.push({ kind: 'bundle', label: 'Install offline copy', from: { type: 'release', repo, asset: assetGlob(webZip) } });
  }
  // One build per platform; a Mac can have one for Apple silicon and one for Intel.
  const seen = new Set();
  for (const asset of assets) {
    const dist = desktopFrom(asset, repo);
    if (!dist) continue;
    const arm = /arm64|aarch64|apple[-_ ]?silicon/i.test(asset);
    const intel = /x64|x86[-_]64|amd64|intel/i.test(asset);
    if (arm && dist.platform !== 'macos') continue;
    const slot = dist.platform === 'macos' ? `macos-${arm ? 'arm' : intel ? 'intel' : 'any'}` : dist.platform;
    if (seen.has(slot) || (dist.platform === 'macos' && seen.has('macos-any')) || (slot === 'macos-any' && [...seen].some((x) => x.startsWith('macos')))) continue;
    seen.add(slot);
    const label = slot === 'macos-arm' ? 'Install desktop app (Apple silicon)' : slot === 'macos-intel' ? 'Install desktop app (Intel Mac)' : 'Install desktop app';
    out.push({ ...dist, label });
  }
  if (!webZip) {
    const build = buildFor(facts);
    if (build) {
      out.push({ kind: 'bundle', label: 'Build offline copy', from: { type: 'repo', repo }, build, notes: "Built on your computer from the repository's source with the library's own Node.js." });
    } else {
      const site = facts.staticSite;
      const hosted = site !== undefined && site !== null;
      const noBuild = !Object.values(facts.pkg ?? {}).some((p) => p.scripts?.build);
      const pages = facts.pagesBranch;
      if (hosted && facts.tscOutFile && !Object.keys(facts.pkg ?? {}).length) {
        // Plain TypeScript compiled to one script that the page loads but the repository does not commit.
        out.push({ kind: 'bundle', label: 'Build offline copy', from: { type: 'repo', repo }, build: { output: site || '.', steps: [TSC] }, notes: "Compiled on your computer from the repository's TypeScript with the library's own Node.js." });
      } else if (hosted && noBuild && !facts.staticRefs?.missing.length) {
        const bundle = { kind: 'bundle', label: 'Install offline copy', from: site ? { type: 'repo', repo, path: site } : { type: 'repo', repo }, notes: staticNotes(facts.staticRefs?.hosts) };
        // The generator is another page of the site (index_3d.html).
        const page = /\/([\w.-]+\.html?)$/i.exec(safePath(url))?.[1];
        if (page && page !== 'index.html' && facts.staticPages?.includes(page)) bundle.entry = page;
        out.push(bundle);
      } else if (pages && !pages.missing.length && isPagesSite(url, repo, pages.cname)) {
        // The site as GitHub Pages publishes it, built or not.
        out.push({ kind: 'bundle', label: 'Install offline copy', from: { type: 'repo', repo, ref: pages.ref }, notes: staticNotes(pages.hosts) });
      }
    }
  }
  return out;
}

const TSC = ['npx', '-p', 'typescript@5', 'tsc'];

function staticNotes(hosts = []) {
  const base = 'The web page files from the repository, served on your computer.';
  return hosts.length ? `${base} It loads code or fonts from ${hosts.join(', ')}, so it still needs the internet.` : `${base} Anything the page loads from other sites still needs the internet.`;
}

// Ads and analytics: the page works without them.
const TRACKERS = /(^|\.)(googlesyndication\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|plausible\.io|cloudflareinsights\.com|umami\.is|clarity\.ms|goatcounter\.com|vercel-insights\.com|statcounter\.com)$/i;

// The scripts and stylesheets a page loads: files it needs that the repository
// does not have (an uncommitted build, a base path, its own site's address) and
// the other sites it loads from. `dir` is the folder the page is served from.
export function pageRefs(html, files, dir = '') {
  const have = new Set(files);
  const inDir = (p) => (dir ? `${dir}/${p}` : p);
  const missing = [];
  const hosts = new Set();
  const refs = [];
  for (const [, tag, attrs] of String(html).matchAll(/<(script|link)\b([^>]*)>/gi)) {
    if (tag.toLowerCase() === 'link' && !/\brel\s*=\s*["']?(stylesheet|modulepreload|preload)\b/i.test(attrs)) continue;
    const ref = attrs.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (ref) refs.push(ref);
  }
  const inline = [...String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  // Modules an inline script imports by path.
  for (const body of inline) for (const m of body.matchAll(/\b(?:from|import)\s*\(?\s*["'](\.{0,2}\/[^"']+)["']/g)) refs.push(m[1]);
  for (const ref of refs) {
    if (/^(data|blob):/i.test(ref)) continue;
    const clean = ref.replace(/[?#].*$/, '');
    if (/^(https?:)?\/\//i.test(clean)) {
      const url = new URL(clean, 'https://x/');
      // A page that loads its own files from its own site's address.
      if (have.has(inDir(url.pathname.replace(/^\/+/, '')))) missing.push(ref);
      else hosts.add(url.host);
      continue;
    }
    const file = clean.startsWith('/') ? inDir(clean.replace(/^\/+/, '')) : path.posix.normalize(path.posix.join(dir || '.', clean));
    if (!have.has(file)) missing.push(ref);
  }
  for (const body of inline) {
    for (const [url] of body.matchAll(/https:\/\/[\w.-]+\/[^\s"'`)]*\.(?:m?js|css|wasm)\b|https:\/\/[\w.-]+\/npm\/[^\s"'`)]+/g)) hosts.add(new URL(url).host);
  }
  return { missing, hosts: [...hosts].filter((h) => !TRACKERS.test(h)).sort() };
}

// The single output file a root tsconfig.json names, when the repository does not commit it.
// tsconfig allows comments and trailing commas.
export function tscOutFile(text, files) {
  try {
    const json = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    const out = String(json?.compilerOptions?.outFile ?? '').replace(/^\.\//, '');
    return out && !out.includes('..') && !files.includes(out) ? out : '';
  } catch {
    return '';
  }
}

// A build the library can run with Node.js alone: a Vite or Create React App
// project at the root or in one app folder, not a desktop wrapper or monorepo.
export function buildFor(facts) {
  for (const [file, pkg] of Object.entries(facts.pkg ?? {})) {
    const dir = path.posix.dirname(file);
    if (pkg.workspaces || !pkg.scripts?.build) continue;
    if (pkg.tools.some((t) => ['electron', '@tauri-apps/cli', '@tauri-apps/api', 'next', '@sveltejs/kit', 'nuxt', 'astro', '@angular/cli'].includes(t))) continue;
    const prefix = dir === '.' ? [] : ['--prefix', dir];
    const install = dir === '.' ? [] : [['npm', 'ci', ...prefix, '--ignore-scripts', '--no-audit', '--no-fund']];
    const where = (p) => (dir === '.' ? p : `${dir}/${p}`);
    if (pkg.tools.includes('vite')) {
      const vite = dir === '.' ? [['npx', 'vite', 'build', '--base=./']] : [['npm', ...prefix, 'exec', '--', 'vite', 'build', '--base=./']];
      return { output: where('dist'), steps: [...install, ...vite] };
    }
    if (pkg.tools.includes('react-scripts')) {
      return { output: where('build'), steps: [...install, ['npm', ...prefix, 'run', 'build']], env: { PUBLIC_URL: '.' } };
    }
  }
  return null;
}

const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export function slugId(slug) {
  return slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export function manifestFor(listing, facts) {
  const f = listing.fields;
  const runsOn = (f['Runs on'] ?? '').toLowerCase();
  const onMakerWorld = /makerworld\.com/.test(listing.url);
  const pricing = pricingOf(listing.price);
  const account = /^required/i.test(f.Account ?? '');
  const multicolor = /^yes/i.test(f.Multicolor ?? '');
  const repo = facts && !facts.missing ? facts.full : '';
  const distributions = [];
  if (listing.url) {
    const label = onMakerWorld ? 'Open on MakerWorld' : /browser/.test(runsOn) || !runsOn ? 'Open online' : 'Open website';
    distributions.push({ kind: 'web', url: listing.url, label });
  }
  for (const other of listing.sameAs) {
    if (/makerworld\.com\/.+\/models\//.test(other) && !onMakerWorld && !distributions.some((d) => d.url === other)) {
      distributions.push({ kind: 'web', url: other, label: 'Open on MakerWorld' });
    }
  }
  if (repo) {
    const own = libraryBundle(repo);
    distributions.push(...(own ? [own] : offlineFromRepo(facts, listing.url)));
  }
  const offline = distributions.some((d) => d.kind !== 'web');
  const mirrorable = /browser/.test(runsOn) && pricing === 'free' && !account && listing.category?.slug !== 'ai-3d' && !NO_MIRROR_HOSTS.some((re) => re.test(host(listing.url)));
  if (!offline && mirrorable && listing.url) distributions.push({ kind: 'mirror', url: listing.url, githubPagesFiles: /\.github\.io$/.test(host(listing.url)) });

  const tags = new Set();
  if (onMakerWorld || listing.sameAs.some((u) => /makerworld\.com/.test(u))) tags.add('makerworld');
  if (/huggingface\.co|hf\.space/.test(listing.url)) tags.add('hugging-face');
  if (listing.category?.slug === 'ai-3d') tags.add('ai');
  if (multicolor) tags.add('multicolor');
  if (/windows|macos|linux/.test(runsOn)) tags.add('desktop');
  for (const t of facts?.topics ?? []) if (tags.size < 8 && /^[a-z0-9-]{2,24}$/.test(t)) tags.add(t);

  const description = [
    listing.features.length ? `Makes: ${listing.features.join('; ')}.` : '',
    f['Best for'] ? `Best for: ${f['Best for']}.` : '',
    listing.price ? `Price: ${listing.price.replace(/\.$/, '')}.` : '',
    f['Runs on'] ? `Runs on: ${f['Runs on']}.` : '',
  ].filter(Boolean).join('\n');

  const manifest = {
    id: slugId(listing.slug),
    name: listing.name,
    summary: listing.summary,
    description,
    tags: [...tags],
    process: '3d-print',
    category: listing.category?.slug ?? '',
    homepage: listing.url,
    listing: listing.listing,
    pricing,
    account,
    exports: exportsOf(f.Exports),
    openSource: /^yes/i.test(f['Open source'] ?? '') || Boolean(repo && facts.license && facts.license !== 'NOASSERTION'),
    distributions,
  };
  if (repo) manifest.repo = repo;
  if (facts?.license && facts.license !== 'NOASSERTION') manifest.license = facts.license;
  return manifest;
}

// ───────────────────────────── the catalog ─────────────────────────────

// A comparable form of an address: no scheme, www, query or trailing slash, and
// a MakerWorld model by its number alone, since its slug and language vary.
export const urlKey = (url) => {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const model = host === 'makerworld.com' && u.pathname.match(/\/models\/(\d+)/);
    if (model) return `makerworld.com/models/${model[1]}`;
    return `${host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return '';
  }
};

// Sites that host many people's generators, where one listed page says nothing
// about the rest of the site.
const SHARED_HOSTS = /^(?:makerworld\.com|github\.com|huggingface\.co|printables\.com|thingiverse\.com|cults3d\.com|crealitycloud\.com)$/;

// Listed already: the same address, or a page inside a site the catalog
// already lists as a whole (vostoklabs.github.io covers vostoklabs.github.io/magnet).
export function isKnownUrl(known, url) {
  const key = urlKey(url);
  if (!key) return false;
  if (known.urls.has(key)) return true;
  const parts = key.split('/');
  if (SHARED_HOSTS.test(parts[0])) return false;
  for (let n = parts.length - 1; n >= 1; n -= 1) if (known.urls.has(parts.slice(0, n).join('/'))) return true;
  return false;
}

// What the rest of the catalog already lists, so SkipTheCAD copies are skipped.
export function knownGenerators(catalog) {
  const ids = new Set();
  const urls = new Set();
  const repos = new Set();
  const visit = (m, sourceRepo) => {
    if (!m || typeof m !== 'object') return;
    if (Array.isArray(m.generators)) {
      for (const g of m.generators) visit(g, m.repo ?? sourceRepo);
      return;
    }
    if (m.id) ids.add(m.id);
    const repo = m.repo ?? sourceRepo;
    if (repo && !Array.isArray(m.generators)) repos.add(repo.toLowerCase());
    for (const d of m.distributions ?? []) if (d.url) urls.add(urlKey(d.url));
    if (m.homepage) urls.add(urlKey(m.homepage));
  };
  for (const s of catalog.sources) {
    if (isOurs(s)) continue;
    visit(s.fallback, s.repo);
    if (s.repo && !Array.isArray(s.fallback?.generators)) repos.add(s.repo.toLowerCase());
  }
  urls.delete('');
  return { ids, urls, repos };
}

const isOurs = (source) => typeof source.url === 'string' && source.url.startsWith(SITE);

export function buildSources(manifests) {
  const byCategory = new Map();
  for (const { manifest, category } of manifests) {
    const key = category?.slug ?? 'other';
    if (!byCategory.has(key)) byCategory.set(key, { category, list: [] });
    byCategory.get(key).list.push(manifest);
  }
  return [...byCategory.values()]
    .sort((a, b) => (a.category?.name ?? 'Other').localeCompare(b.category?.name ?? 'Other'))
    .map(({ category, list }) => ({
      url: category ? `${SITE}category/${category.slug}/` : SITE,
      fallback: {
        id: `skipthecad-${category?.slug ?? 'other'}`,
        name: `SkipTheCAD: ${category?.name ?? 'Other'}`,
        generators: list.sort((a, b) => a.name.localeCompare(b.name)),
      },
    }));
}

export function mergeCatalog(catalog, sources) {
  return { ...catalog, sources: [...catalog.sources.filter((s) => !isOurs(s)), ...sources] };
}

// What changed between two catalogs' SkipTheCAD generators, for a pull request.
export function summarize(before, after) {
  const list = (catalog) => new Map(catalog.sources.filter(isOurs).flatMap((s) => s.fallback.generators).map((g) => [g.id, g]));
  const a = list(before);
  const b = list(after);
  const added = [...b.values()].filter((g) => !a.has(g.id));
  const removed = [...a.values()].filter((g) => !b.has(g.id));
  const changed = [...b.values()].filter((g) => a.has(g.id) && JSON.stringify(a.get(g.id)) !== JSON.stringify(g));
  const line = (g) => `- ${g.name} (${g.distributions.map((d) => d.kind).join(', ')})`;
  return {
    added,
    removed,
    changed,
    markdown: [
      `SkipTheCAD import: ${b.size} generators, ${added.length} new, ${changed.length} changed, ${removed.length} gone.`,
      added.length ? `\n### New\n${added.map(line).join('\n')}` : '',
      changed.length ? `\n### Changed\n${changed.map(line).join('\n')}` : '',
      removed.length ? `\n### No longer listed\n${removed.map(line).join('\n')}` : '',
    ].filter(Boolean).join('\n'),
  };
}

// ───────────────────────────── network ─────────────────────────────

async function fetchText(url, tries = 3) {
  for (let i = 1; ; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return await res.text();
    } catch (error) {
      if (i >= tries) throw error;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

async function github(pathname, token) {
  const res = await fetch(`https://api.github.com/${pathname}`, {
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${pathname} answered ${res.status}`);
  return res.json();
}

const STATIC_DIRS = ['', 'docs', 'site', 'public', 'web', 'www'];
const BUILD_TOOLS = ['vite', 'react-scripts', 'next', '@sveltejs/kit', 'nuxt', 'astro', '@angular/cli', 'electron', '@tauri-apps/cli', '@tauri-apps/api', 'parcel', 'webpack'];

// What the importer needs to know about a repository.
export async function repoFacts(name, token) {
  const meta = await github(`repos/${name}`, token);
  if (!meta) return { name, missing: true };
  const full = meta.full_name;
  const releases = ((await github(`repos/${full}/releases?per_page=5`, token)) ?? []).map((r) => ({ tag: r.tag_name, pre: r.prerelease, assets: r.assets.map((a) => a.name) }));
  const tree = await github(`repos/${full}/git/trees/${meta.default_branch}?recursive=1`, token);
  const files = (tree?.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path);
  const pkg = {};
  for (const file of files.filter((p) => /(^|\/)package\.json$/.test(p) && p.split('/').length <= 2 && !p.includes('node_modules')).slice(0, 3)) {
    try {
      // raw.githubusercontent.com does not count against the API's hourly limit.
      const json = JSON.parse(await fetchText(`https://raw.githubusercontent.com/${full}/${meta.default_branch}/${file}`));
      const deps = { ...json.dependencies, ...json.devDependencies };
      pkg[file] = { scripts: { build: json.scripts?.build ?? '' }, tools: BUILD_TOOLS.filter((t) => t in deps), workspaces: Boolean(json.workspaces) };
    } catch {
      /* unreadable package.json */
    }
  }
  let tsc = '';
  if (!files.includes('package.json') && files.includes('tsconfig.json')) {
    try {
      tsc = tscOutFile(await fetchText(`https://raw.githubusercontent.com/${full}/${meta.default_branch}/tsconfig.json`), files);
    } catch {
      /* unreadable tsconfig.json */
    }
  }
  const staticSite = STATIC_DIRS.find((dir) => files.includes(dir ? `${dir}/index.html` : 'index.html'));
  const raw = async (ref, file) => {
    try {
      return await fetchText(`https://raw.githubusercontent.com/${full}/${ref}/${file}`);
    } catch {
      return '';
    }
  };
  const staticPages = staticSite === undefined ? [] : files.filter((f) => f.startsWith(staticSite ? `${staticSite}/` : '') && /\.html?$/i.test(f)).map((f) => f.slice(staticSite ? staticSite.length + 1 : 0)).filter((f) => !f.includes('/'));
  const staticRefs = staticSite === undefined ? null : pageRefs(await raw(meta.default_branch, staticSite ? `${staticSite}/index.html` : 'index.html'), files, staticSite);
  let pagesBranch = null;
  if (meta.default_branch !== 'gh-pages') {
    const pagesTree = await github(`repos/${full}/git/trees/gh-pages?recursive=1`, token).catch(() => null);
    const pagesFiles = (pagesTree?.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path);
    if (pagesFiles.includes('index.html')) {
      const cname = pagesFiles.includes('CNAME') ? (await raw('gh-pages', 'CNAME')).trim().toLowerCase() : '';
      pagesBranch = { ref: 'gh-pages', cname, ...pageRefs(await raw('gh-pages', 'index.html'), pagesFiles) };
    }
  }
  return {
    name,
    full,
    archived: meta.archived,
    license: meta.license?.spdx_id ?? '',
    topics: meta.topics ?? [],
    releases,
    pkg,
    staticSite: staticSite === undefined ? null : staticSite,
    tscOutFile: tsc,
    staticRefs,
    staticPages,
    pagesBranch,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const catalogFile = path.join(root, 'catalog', 'catalog.json');
  const before = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const cacheFile = opt('--cache');
  const cache = cacheFile ? JSON.parse(await fs.readFile(cacheFile, 'utf8').catch(() => '{}')) : {};

  const index = await fetchText(`${SITE}sitemap-index.xml`);
  const maps = [...index.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  const pages = [...new Set((await Promise.all(maps.map(fetchText))).flatMap(sitemapPages))].sort();
  console.log(`${pages.length} generator pages`);

  const listings = [];
  for (let i = 0; i < pages.length; i += 6) {
    const batch = await Promise.all(pages.slice(i, i + 6).map(async (url) => {
      try {
        return parseListing(await fetchText(url), url);
      } catch (error) {
        console.warn(`skipped ${url}: ${error.message}`);
        return null;
      }
    }));
    listings.push(...batch.filter((l) => l && l.name && l.url));
  }

  const known = knownGenerators(before);
  const manifests = [];
  const ids = new Set();
  for (const listing of listings) {
    const repoName = pickRepo(listing);
    let facts = null;
    if (repoName) {
      facts = cache[repoName.toLowerCase()];
      if (!facts) {
        try {
          facts = await repoFacts(repoName, token);
          cache[repoName.toLowerCase()] = facts;
        } catch (error) {
          console.warn(`${repoName}: ${error.message}`);
        }
      }
    }
    const manifest = manifestFor(listing, facts);
    if (known.ids.has(manifest.id) || known.ids.has(SAME_AS[listing.slug]) || isKnownUrl(known, listing.url) || (manifest.repo && known.repos.has(manifest.repo.toLowerCase()))) {
      console.log(`already listed: ${listing.name}`);
      continue;
    }
    if (ids.has(manifest.id)) continue;
    ids.add(manifest.id);
    manifests.push({ manifest, category: listing.category });
  }

  const after = mergeCatalog(before, buildSources(manifests));
  await fs.writeFile(catalogFile, `${JSON.stringify(after, null, 2)}\n`);
  if (cacheFile) await fs.writeFile(cacheFile, JSON.stringify(cache));
  const summary = summarize(before, after);
  console.log(summary.markdown.split('\n')[0]);
  const summaryFile = opt('--summary');
  if (summaryFile) await fs.writeFile(summaryFile, `${summary.markdown}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
