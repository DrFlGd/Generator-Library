// Turn what someone types into "Add project" into a manifest the catalog can use,
// so a repository or website joins the library without anyone editing the app.
//
// A repository that publishes generator.json (or generator-library.json) is used
// as is. One that does not is described from what GitHub already knows: its
// homepage or Pages site becomes an online link, the assets of its newest
// release become offline bundles and desktop apps, and a web app with an npm
// build script is built from its source. Only when there is no offline bundle
// and no source to build is the site captured with a mirror, since a mirror
// misses what a page loads on demand. A plain link becomes an online entry plus
// a mirror.

import { isValidRepo } from './manifest.js';

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '') || 'project';
}

function titleCase(name) {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// "owner/name", any github.com URL inside a repo, or any other http(s) link.
export function parseProjectInput(text) {
  const value = String(text ?? '').trim();
  if (!value) return { error: 'Enter a GitHub repository (owner/name) or a link' };
  // GitHub owners cannot contain dots, so "example.com/tool" is a link.
  if (isValidRepo(value) && !value.split('/')[0].includes('.')) return { type: 'repo', repo: value };
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return { error: `"${value}" is neither owner/name nor a link` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'Links must start with http:// or https://' };
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const [owner, name] = url.pathname.split('/').filter(Boolean);
    const repo = `${owner}/${(name ?? '').replace(/\.git$/, '')}`;
    if (owner && name && isValidRepo(repo)) return { type: 'repo', repo };
    return { error: 'That GitHub link does not point at a repository' };
  }
  url.hash = '';
  return { type: 'url', url: url.href };
}

export function pagesUrl(repo) {
  const [owner, name] = repo.split('/');
  const host = `${owner.toLowerCase()}.github.io`;
  return name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${name}/`;
}

// A release asset name with its version numbers turned into a glob, so the
// distribution keeps matching after the next release.
export function assetGlob(name) {
  return name.replace(/\d+(?:[._]\d+)+(?:[-._]?(?:alpha|beta|rc)\.?\d*)?/gi, '*');
}

// Tags that share a prefix before the version ("desktop-v1.2" → "desktop-v*")
// keep a repo's desktop and web releases apart; plain "v1.2" needs no filter.
export function tagGlob(tag) {
  const at = tag.search(/v?\d/i);
  return at > 0 ? `${tag.slice(0, at)}*` : 'latest';
}

export function classifyAsset(name) {
  const lower = name.toLowerCase();
  if (/\.(sha256|sig|asc|blockmap|yml|yaml|txt|json)$/.test(lower) || /source code/.test(lower)) return null;
  if (lower.endsWith('.msi')) return { kind: 'exe', platform: 'windows', install: 'installer' };
  if (lower.endsWith('.exe')) return { kind: 'exe', platform: 'windows', install: /setup|install/.test(lower) ? 'installer' : 'portable' };
  if (lower.endsWith('.appimage')) return { kind: 'exe', platform: 'linux', install: 'portable' };
  if (lower.endsWith('.dmg')) return { kind: 'exe', platform: 'macos', install: 'installer' };
  if (/\.(zip|tar\.gz|tgz)$/.test(lower)) {
    if (/web|site|dist|static|html|pages/.test(lower)) return { kind: 'bundle' };
    if (/win/.test(lower)) return { kind: 'exe', platform: 'windows', install: 'zip' };
    if (/linux/.test(lower)) return { kind: 'exe', platform: 'linux', install: 'zip' };
    if (/mac|darwin|osx/.test(lower)) return { kind: 'exe', platform: 'macos', install: 'zip' };
  }
  if (/\.html?$/.test(lower)) return { kind: 'bundle' };
  return null;
}

// Distributions for the newest release that has anything runnable.
export function releaseDistributions(releases) {
  const release = releases.find((r) => !r.draft && !r.prerelease && r.assets.some((a) => classifyAsset(a.name))) ?? releases.find((r) => !r.draft && r.assets.some((a) => classifyAsset(a.name)));
  if (!release) return [];
  const tag = tagGlob(release.tag);
  const out = [];
  const seen = new Set();
  for (const asset of release.assets) {
    const kind = classifyAsset(asset.name);
    if (!kind) continue;
    const key = [kind.kind, kind.platform, kind.install].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    const from = { type: 'release', tag, asset: assetGlob(asset.name) };
    if (release.prerelease) from.prerelease = true;
    const dist = { ...kind, from };
    if (kind.kind === 'bundle') dist.spa = true;
    // Which file in the zip to run is unknown here; "*" lets the installer pick
    // the executable it finds (installer.js findExecutable).
    if (kind.install === 'zip') dist.exec = '*';
    out.push(dist);
  }
  return out;
}

// A build recipe for a repository's package.json, or null when it has no build
// script. Vite builds get a relative base so they work from the library's local
// server whatever base their Pages deploy uses; Create React App builds to build/.
export function inferBuild(pkg) {
  if (!pkg || typeof pkg !== 'object' || typeof pkg.scripts?.build !== 'string') return null;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const output = deps['react-scripts'] ? 'build' : 'dist';
  const steps = deps.vite ? [['npm', 'run', 'build', '--', '--base', './']] : [['npm', 'run', 'build']];
  return { output, steps };
}

// Describe a GitHub repository. `github` is the client from github.js.
export async function describeRepo(repo, github) {
  for (const path of ['generator.json', 'generator-library.json']) {
    const published = await github.readJson(repo, path);
    if (published) return { found: 'manifest', repo, manifestPath: path, raw: published };
  }
  const info = await github.repoInfo(repo);
  let releases = [];
  try {
    releases = await github.releases(repo);
  } catch {
    /* a repo without releases is fine */
  }
  const distributions = [];
  const site = /^https?:\/\//.test(info.homepage) ? info.homepage : info.hasPages ? pagesUrl(repo) : '';
  if (site) distributions.push({ kind: 'web', url: site });
  distributions.push(...releaseDistributions(releases));
  if (!distributions.some((d) => d.kind === 'bundle')) {
    let build = null;
    try {
      build = inferBuild(await github.readJson(repo, 'package.json'));
    } catch {
      /* no package.json to read */
    }
    if (build) distributions.push({ kind: 'bundle', from: { type: 'repo' }, build, spa: true });
    else if (site) distributions.push({ kind: 'mirror', url: site });
  }
  if (!distributions.length) {
    throw new Error(`${repo} has no website, Pages site or release downloads to run. Add a generator.json to it to say how it runs.`);
  }
  const name = info.fullName.split('/')[1];
  return {
    found: 'inferred',
    repo: info.fullName,
    raw: {
      id: slugify(name),
      name: titleCase(name),
      summary: info.description,
      tags: info.topics,
      license: info.license && info.license !== 'NOASSERTION' ? info.license : '',
      homepage: site,
      upstream: info.parent,
      distributions,
    },
  };
}

function metaContent(html, pattern) {
  const tag = html.match(pattern);
  if (!tag) return '';
  const content = tag[0].match(/content\s*=\s*["']([^"']*)["']/i);
  return content ? decodeEntities(content[1]).trim() : '';
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Describe a website. The page is read only for its title, description and icon.
export async function describeUrl(url, { fetchImpl = globalThis.fetch } = {}) {
  const target = new URL(url);
  let html = '';
  try {
    const res = await fetchImpl(target.href, { headers: { 'User-Agent': 'generator-library' } });
    if (res.ok && /html/i.test(res.headers.get('content-type') ?? 'text/html')) html = (await res.text()).slice(0, 200_000);
  } catch {
    /* unreachable now; it can still be listed and opened later */
  }
  const title = decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim();
  const description = metaContent(html, /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i) || metaContent(html, /<meta[^>]+property\s*=\s*["']og:description["'][^>]*>/i);
  const image = metaContent(html, /<meta[^>]+property\s*=\s*["']og:image["'][^>]*>/i);
  const pathName = target.pathname.replace(/\/+$/, '').split('/').pop();
  const name = title || titleCase(pathName || target.hostname.replace(/^www\./, '').split('.')[0]);
  let icon = '';
  if (image) {
    try {
      icon = new URL(image, target).href;
    } catch {
      /* ignore a broken og:image */
    }
  }
  return {
    found: 'link',
    url: target.href,
    raw: {
      id: slugify(`${target.hostname.replace(/^www\./, '')}${target.pathname}`),
      name: name.slice(0, 80),
      summary: description,
      homepage: target.href,
      icon: /^https:\/\//.test(icon) ? icon : '',
      distributions: [
        { kind: 'web', url: target.href },
        { kind: 'mirror', url: target.href },
      ],
    },
  };
}

export async function describeProject(text, { github, fetchImpl } = {}) {
  const parsed = parseProjectInput(text);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.type === 'repo' ? describeRepo(parsed.repo, github) : describeUrl(parsed.url, { fetchImpl });
}
