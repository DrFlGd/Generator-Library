import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, GitHubError } from '../src/lib/github.js';
import { matchesGlob } from '../src/lib/glob.js';

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const route = Object.entries(routes).find(([pattern]) => url.includes(pattern));
    if (!route) return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'Not Found' }) };
    const [, value] = route;
    const body = typeof value === 'function' ? value(url, init) : value;
    return { ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body, headers: new Map() };
  };
  return { fetchImpl, calls };
}

test('glob matching is case-insensitive and anchored', () => {
  assert.ok(matchesGlob('Terrain-Press-1.19.1-Portable.exe', 'terrain-press-*-portable.exe'));
  assert.ok(!matchesGlob('Terrain-Press-1.19.1-Portable.exe.sha256', 'Terrain-Press-*-Portable.exe'));
  assert.ok(matchesGlob('desktop-v4.519.3', 'desktop-v*'));
  assert.ok(!matchesGlob('v4.519.3', 'desktop-v*'));
});

test('readFile returns null on 404 and sends the token', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'api.github.com/repos/o/r/contents/generator.json': '{"id":"x"}' });
  const gh = createGitHub({ token: 'tok', fetchImpl });
  assert.deepEqual(await gh.readJson('o/r', 'generator.json'), { id: 'x' });
  assert.equal(await gh.readFile('o/r', 'missing.json'), null);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github.raw+json');
});

test('without a token, files come from raw.githubusercontent.com and never touch the API', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'raw.githubusercontent.com/o/pub/HEAD/generator.json': '{"id":"pub"}' });
  const gh = createGitHub({ fetchImpl });
  assert.deepEqual(await gh.readJson('o/pub', 'generator.json'), { id: 'pub' });
  assert.equal(await gh.readFile('o/priv', 'generator.json'), null);
  assert.ok(calls.every((c) => c.url.startsWith('https://raw.githubusercontent.com/')), 'no API calls');
  assert.equal(calls.length, 2);
});

test('with a token, files are read through the API so private repositories work', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'api.github.com/repos/o/priv/contents/generator.json': '{"id":"priv"}' });
  const gh = createGitHub({ fetchImpl, token: 't' });
  assert.deepEqual(await gh.readJson('o/priv', 'generator.json'), { id: 'priv' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://api.github.com/'));
});

test('rate limiting is reported in plain words', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4.' }) });
  await assert.rejects(createGitHub({ fetchImpl }).releases('o/r'), /Add a GitHub token in Settings/);
  await assert.rejects(createGitHub({ fetchImpl, token: 't' }).releases('o/r'), /try again/);
});

test('invalid JSON in a manifest is a GitHubError, not a crash', async () => {
  const { fetchImpl } = fakeFetch({ '/contents/generator.json': 'not json' });
  const gh = createGitHub({ fetchImpl, token: 't' });
  await assert.rejects(gh.readJson('o/r', 'generator.json'), GitHubError);
});

const releases = [
  { id: 1, tag_name: 'desktop-v1.19.1', name: 'Desktop', draft: false, prerelease: true, published_at: '2026-10-20T00:00:00Z', assets: [{ id: 11, name: 'Terrain-Press-1.19.1-Portable.exe', size: 5, url: 'https://api/assets/11', browser_download_url: 'https://dl/11' }] },
  { id: 2, tag_name: 'desktop-v1.18.0', name: 'Desktop old', draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', assets: [{ id: 12, name: 'Terrain-Press-1.18.0-Portable.exe', size: 5, url: 'https://api/assets/12', browser_download_url: 'https://dl/12' }] },
  { id: 3, tag_name: 'v2.0.0', name: 'Web', draft: false, prerelease: false, published_at: '2026-10-25T00:00:00Z', assets: [{ id: 13, name: 'site.zip', size: 5, url: 'https://api/assets/13', browser_download_url: 'https://dl/13' }] },
  { id: 4, tag_name: 'desktop-v2.0.0', name: 'Draft', draft: true, prerelease: false, published_at: '2026-10-26T00:00:00Z', assets: [{ id: 14, name: 'Terrain-Press-2.0.0-Portable.exe', size: 5, url: 'https://api/assets/14', browser_download_url: 'https://dl/14' }] },
];

test('resolveReleaseAsset picks the newest matching non-draft release that has the asset', async () => {
  const { fetchImpl } = fakeFetch({ '/repos/o/r/releases': releases });
  const gh = createGitHub({ fetchImpl });
  const stable = await gh.resolveReleaseAsset('o/r', { tag: 'desktop-v*', asset: 'Terrain-Press-*-Portable.exe' });
  assert.equal(stable.release.tag, 'desktop-v1.18.0', 'prereleases skipped by default');
  const pre = await gh.resolveReleaseAsset('o/r', { tag: 'desktop-v*', asset: 'Terrain-Press-*-Portable.exe', prerelease: true });
  assert.equal(pre.release.tag, 'desktop-v1.19.1');
  const latest = await gh.resolveReleaseAsset('o/r', { tag: 'latest', asset: '*.zip' });
  assert.equal(latest.release.tag, 'v2.0.0');
  const exact = await gh.resolveReleaseAsset('o/r', { tag: 'desktop-v1.18.0', asset: '*.exe' });
  assert.equal(exact.asset.id, 12);
  await assert.rejects(gh.resolveReleaseAsset('o/r', { tag: 'latest', asset: 'nope-*' }), /No release/);
});

test('matchingReleases lists every installable release, newest first', async () => {
  const { fetchImpl } = fakeFetch({ '/repos/o/r/releases': releases });
  const gh = createGitHub({ fetchImpl });
  const stable = await gh.matchingReleases('o/r', { tag: 'desktop-v*', asset: 'Terrain-Press-*-Portable.exe' });
  assert.deepEqual(stable.map((m) => m.release.tag), ['desktop-v1.18.0']);
  const all = await gh.matchingReleases('o/r', { tag: 'desktop-v*', asset: 'Terrain-Press-*-Portable.exe', prerelease: true });
  assert.deepEqual(all.map((m) => m.release.tag), ['desktop-v1.19.1', 'desktop-v1.18.0']);
  assert.deepEqual(await gh.matchingReleases('o/r', { asset: 'nope-*' }), []);
});

test('latestCommit uses the default branch when no ref is given', async () => {
  const { fetchImpl } = fakeFetch({
    '/repos/o/r/commits/main': { sha: 'abc123', commit: { committer: { date: '2026-10-27T00:00:00Z' } } },
    '/repos/o/r': { full_name: 'o/r', default_branch: 'main' },
  });
  const gh = createGitHub({ fetchImpl });
  const commit = await gh.latestCommit('o/r');
  assert.equal(commit.sha, 'abc123');
  assert.equal(commit.ref, 'main');
});
