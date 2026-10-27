// A small GitHub client around fetch. Everything the library needs from GitHub is
// here: read a file from a repo, list releases, find an asset, download, and
// resolve "what is the newest thing" for an update check.
//
// `fetchImpl` is injectable so tests never touch the network.

import { matchesGlob } from './glob.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.url = url;
  }
}

export function createGitHub({ token = '', fetchImpl = globalThis.fetch, userAgent = 'generator-library' } = {}) {
  const headers = (extra = {}) => {
    const h = { 'User-Agent': userAgent, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  };

  async function api(path, { method = 'GET', accept } = {}) {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    const res = await fetchImpl(url, { method, headers: headers(accept ? { Accept: accept } : {}) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = `GitHub ${res.status} for ${url}`;
      let detail = '';
      try {
        detail = JSON.parse(text).message ?? '';
      } catch {
        /* not JSON */
      }
      if (res.status === 403 && /rate limit/i.test(detail)) {
        message = token
          ? 'GitHub API rate limit reached; try again in a while.'
          : 'GitHub API rate limit reached. Add a GitHub token in Settings for a much higher limit.';
      } else if (detail) {
        message += `: ${detail}`;
      }
      throw new GitHubError(message, { status: res.status, url });
    }
    return res;
  }

  // Raw file contents at a ref (default branch when ref is empty). Returns null
  // when the file does not exist so callers can fall back without try/catch noise.
  //
  // Without a token, raw.githubusercontent.com is tried first: it serves public
  // repositories without counting against the 60-requests-an-hour anonymous API
  // limit, which a catalog of a dozen repositories would otherwise burn through
  // in two refreshes. A private repository 404s there, and without a token the
  // API would say the same, so that is the answer. The API path is used when a
  // token is set or raw.githubusercontent.com could not be reached.
  async function readFile(repo, path, ref = '') {
    if (!token) {
      const rawUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref || 'HEAD')}/${path}`;
      try {
        const res = await fetchImpl(rawUrl, { headers: { 'User-Agent': userAgent } });
        if (res.ok) return await res.text();
        if (res.status === 404) return null;
      } catch {
        /* network trouble: let the API call report it */
      }
    }
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      const res = await api(`/repos/${repo}/contents/${path}${query}`, { accept: 'application/vnd.github.raw+json' });
      return await res.text();
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  async function readJson(repo, path, ref = '') {
    const text = await readFile(repo, path, ref);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new GitHubError(`${repo}/${path} is not valid JSON: ${error.message}`);
    }
  }

  async function repoInfo(repo) {
    const res = await api(`/repos/${repo}`);
    const data = await res.json();
    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      description: data.description ?? '',
      homepage: data.homepage ?? '',
      isPrivate: Boolean(data.private),
      isFork: Boolean(data.fork),
      hasPages: Boolean(data.has_pages),
      parent: data.parent?.full_name ?? '',
      pushedAt: data.pushed_at ?? '',
      license: data.license?.spdx_id ?? '',
      topics: data.topics ?? [],
    };
  }

  async function latestCommit(repo, ref = '') {
    const info = ref ? null : await repoInfo(repo);
    const branch = ref || info.defaultBranch;
    const res = await api(`/repos/${repo}/commits/${encodeURIComponent(branch)}`);
    const data = await res.json();
    return { sha: data.sha, date: data.commit?.committer?.date ?? '', ref: branch };
  }

  async function releases(repo, { perPage = 30 } = {}) {
    const res = await api(`/repos/${repo}/releases?per_page=${perPage}`);
    const data = await res.json();
    return data.map((r) => ({
      id: r.id,
      tag: r.tag_name,
      name: r.name ?? r.tag_name,
      draft: Boolean(r.draft),
      prerelease: Boolean(r.prerelease),
      publishedAt: r.published_at ?? r.created_at ?? '',
      body: r.body ?? '',
      htmlUrl: r.html_url ?? '',
      assets: (r.assets ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size,
        url: a.url,
        browserDownloadUrl: a.browser_download_url,
        contentType: a.content_type ?? '',
      })),
    }));
  }

  // Pick the release a distribution points at. `tag` is "latest", an exact tag, or
  // a glob such as "desktop-v*" (newest matching non-draft release wins). The asset
  // glob must match one of its files; a release without the asset is skipped so a
  // repo that publishes both web and desktop releases under different tags works.
  async function resolveReleaseAsset(repo, { tag = 'latest', asset, prerelease = false }) {
    const all = (await releases(repo)).filter((r) => !r.draft && (prerelease || !r.prerelease));
    const candidates = tag === 'latest' ? all : all.filter((r) => r.tag === tag || matchesGlob(r.tag, tag));
    candidates.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
    for (const release of candidates) {
      const match = release.assets.find((a) => matchesGlob(a.name, asset));
      if (match) return { release, asset: match };
    }
    throw new GitHubError(`No release of ${repo} (tag ${tag}) has an asset matching "${asset}"`, { status: 404 });
  }

  // Stream a URL into a file. Release asset downloads need the octet-stream accept
  // header and follow a redirect to a CDN that must not see the token, which fetch
  // handles for us because the redirect drops the Authorization header.
  async function download(url, destination, { onProgress, isAsset = false } = {}) {
    const fs = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    const res = await fetchImpl(url, { headers: headers(isAsset ? { Accept: 'application/octet-stream' } : {}) });
    if (!res.ok || !res.body) throw new GitHubError(`Download failed (${res.status}) for ${url}`, { status: res.status, url });
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      onProgress?.({ received, total });
    });
    await pipeline(source, fs.createWriteStream(destination));
    return { received, total };
  }

  function tarballUrl(repo, ref) {
    return `${API}/repos/${repo}/tarball/${encodeURIComponent(ref)}`;
  }

  return { readFile, readJson, repoInfo, latestCommit, releases, resolveReleaseAsset, download, tarballUrl, hasToken: Boolean(token) };
}
