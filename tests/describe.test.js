import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetGlob, classifyAsset, describeProject, describeRepo, describeUrl, inferBuild, pagesUrl, parseProjectInput, releaseDistributions, slugify, tagGlob } from '../src/lib/describe.js';
import { normalizeManifest } from '../src/lib/manifest.js';
import { Library } from '../src/lib/library.js';
import { stablePorts } from '../src/lib/server.js';

test('parseProjectInput tells repositories from links', () => {
  assert.deepEqual(parseProjectInput('DrFlGd/Generator-Library'), { type: 'repo', repo: 'DrFlGd/Generator-Library' });
  assert.deepEqual(parseProjectInput('https://github.com/andymai/gridfinity-layout-tool/tree/main/src'), { type: 'repo', repo: 'andymai/gridfinity-layout-tool' });
  assert.deepEqual(parseProjectInput('github.com/o/r.git'), { type: 'repo', repo: 'o/r' });
  assert.deepEqual(parseProjectInput('example.com/tool'), { type: 'url', url: 'https://example.com/tool' });
  assert.deepEqual(parseProjectInput('https://example.com/app/#top'), { type: 'url', url: 'https://example.com/app/' });
  assert.ok(parseProjectInput('').error);
  assert.ok(parseProjectInput('ftp://example.com/').error);
  assert.ok(parseProjectInput('https://github.com/just-an-owner').error);
});

test('slugify and pagesUrl', () => {
  assert.equal(slugify('Gridfinity Layout Tool!'), 'gridfinity-layout-tool');
  assert.equal(slugify('***'), 'project');
  assert.equal(pagesUrl('Owner/tool'), 'https://owner.github.io/tool/');
  assert.equal(pagesUrl('Owner/owner.github.io'), 'https://owner.github.io/');
});

test('asset and tag globs keep matching later releases', () => {
  assert.equal(assetGlob('App-1.2.3-win-x64.zip'), 'App-*-win-x64.zip');
  assert.equal(assetGlob('tool_2.0_beta.1.AppImage'), 'tool_*.AppImage');
  assert.equal(tagGlob('desktop-v1.4.0'), 'desktop-*');
  assert.equal(tagGlob('v1.4.0'), 'latest');
  assert.equal(tagGlob('1.4.0'), 'latest');
});

test('classifyAsset sorts release files into ways to run', () => {
  assert.deepEqual(classifyAsset('App Setup 1.0.exe'), { kind: 'exe', platform: 'windows', install: 'installer' });
  assert.deepEqual(classifyAsset('App.exe'), { kind: 'exe', platform: 'windows', install: 'portable' });
  assert.deepEqual(classifyAsset('App.AppImage'), { kind: 'exe', platform: 'linux', install: 'portable' });
  assert.deepEqual(classifyAsset('app-web-1.0.zip'), { kind: 'bundle' });
  assert.deepEqual(classifyAsset('app-linux-x64.tar.gz'), { kind: 'exe', platform: 'linux', install: 'zip' });
  assert.equal(classifyAsset('App.exe.blockmap'), null);
  assert.equal(classifyAsset('latest.yml'), null);
  assert.equal(classifyAsset('notes.zip'), null);
});

test('releaseDistributions uses the newest stable release with something to run', () => {
  const releases = [
    { tag: 'v3.0.0-rc.1', draft: false, prerelease: true, assets: [{ name: 'App-3.0.0.exe' }] },
    { tag: 'v2.1.0', draft: false, prerelease: false, assets: [{ name: 'checksums.txt' }] },
    { tag: 'v2.0.0', draft: false, prerelease: false, assets: [{ name: 'App-2.0.0.exe' }, { name: 'App-2.0.0-x86.exe' }, { name: 'app-web-2.0.0.zip' }, { name: 'App-2.0.0-win.zip' }] },
  ];
  const dists = releaseDistributions(releases);
  assert.deepEqual(dists, [
    { kind: 'exe', platform: 'windows', install: 'portable', from: { type: 'release', tag: 'latest', asset: 'App-*.exe' } },
    { kind: 'bundle', from: { type: 'release', tag: 'latest', asset: 'app-web-*.zip' }, spa: true },
    { kind: 'exe', platform: 'windows', install: 'zip', from: { type: 'release', tag: 'latest', asset: 'App-*-win.zip' }, exec: '*' },
  ]);
  const onlyPre = releaseDistributions(releases.slice(0, 1));
  assert.equal(onlyPre[0].from.prerelease, true);
  assert.deepEqual(releaseDistributions([]), []);
});

function fakeGithub({ files = {}, info, releases = [] }) {
  return {
    readJson: async (repo, file) => files[file] ?? null,
    repoInfo: async () => info,
    releases: async () => releases,
  };
}

test('describeRepo prefers a published manifest', async () => {
  const github = fakeGithub({ files: { 'generator-library.json': { id: 'col', generators: [] } } });
  const found = await describeRepo('o/r', github);
  assert.equal(found.found, 'manifest');
  assert.equal(found.manifestPath, 'generator-library.json');
});

test('describeRepo infers a manifest from the Pages site and releases', async () => {
  const info = { fullName: 'Owner/cool-tool', description: 'Makes boxes', topics: ['boxes'], license: 'MIT', homepage: '', hasPages: true, parent: '' };
  const github = fakeGithub({ info, releases: [{ tag: 'v1.0.0', draft: false, prerelease: false, assets: [{ name: 'cool-tool-1.0.0.AppImage' }] }] });
  const found = await describeRepo('owner/cool-tool', github);
  assert.equal(found.found, 'inferred');
  assert.equal(found.raw.id, 'cool-tool');
  assert.equal(found.raw.name, 'Cool Tool');
  assert.deepEqual(found.raw.distributions.map((d) => d.kind), ['web', 'exe', 'mirror']);
  assert.equal(found.raw.distributions[0].url, 'https://owner.github.io/cool-tool/');
  const { errors } = normalizeManifest(found.raw, { repo: found.repo });
  assert.deepEqual(errors, []);
});

test('describeRepo explains a repository with nothing to run', async () => {
  const info = { fullName: 'o/r', description: '', topics: [], license: '', homepage: '', hasPages: false, parent: '' };
  await assert.rejects(describeRepo('o/r', fakeGithub({ info })), /generator\.json/);
});

test('describeUrl reads the title, description and icon of a page', async () => {
  const html = '<html><head><title>Box &amp; Lid</title><meta name="description" content="Boxes with lids"><meta property="og:image" content="/icon.png"></head></html>';
  const fetchImpl = async () => new Response(html, { headers: { 'content-type': 'text/html' } });
  const found = await describeUrl('https://example.com/box/', { fetchImpl });
  assert.equal(found.raw.name, 'Box & Lid');
  assert.equal(found.raw.summary, 'Boxes with lids');
  assert.equal(found.raw.icon, 'https://example.com/icon.png');
  assert.equal(found.raw.id, 'example-com-box');
  assert.deepEqual(found.raw.distributions.map((d) => d.kind), ['web', 'mirror']);
  assert.deepEqual(normalizeManifest(found.raw).errors, []);
});

test('describeUrl still lists a page it cannot reach', async () => {
  const found = await describeProject('example.org/cutting-tool', { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(found.found, 'link');
  assert.equal(found.raw.name, 'Cutting Tool');
});

test('stablePorts are the same for a key and differ between keys', () => {
  const a = stablePorts('gridfinity/bundle');
  assert.deepEqual(a, stablePorts('gridfinity/bundle'));
  assert.equal(new Set(a).size, a.length);
  assert.ok(a.every((p) => p >= 41000 && p < 49000));
  assert.notDeepEqual(a, stablePorts('printkit/mirror'));
});

test('library remembers hidden projects and removed sources', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'genlib-'));
  const library = new Library(dir);
  await library.load();
  await library.setHidden('printkit', true);
  await library.setHidden('printkit', true);
  assert.deepEqual(library.state.hidden, ['printkit']);
  await library.setSourceRemoved('DrFlGd/Thing', true);
  assert.equal(await library.addSource({ url: 'https://example.com/' }), true);
  assert.equal(await library.addSource({ url: 'https://EXAMPLE.com/' }), false);
  assert.equal(await library.addSource({ repo: 'drflgd/thing' }), true);
  assert.deepEqual(library.state.removedSources, [], 'adding a source again restores it');
  const reloaded = new Library(dir);
  await reloaded.load();
  assert.deepEqual(reloaded.state.hidden, ['printkit']);
  assert.equal(reloaded.state.sources.length, 2);
  await reloaded.removeSource('https://example.com/');
  await reloaded.setHidden('printkit', false);
  assert.deepEqual(reloaded.state.sources, [{ repo: 'drflgd/thing' }]);
  assert.deepEqual(reloaded.state.hidden, []);
});

test('describeRepo builds a web app from source rather than mirroring it', async () => {
  const info = { fullName: 'o/tool', description: '', topics: [], license: '', homepage: 'https://tool.example/', hasPages: false, parent: '' };
  const files = { 'package.json': { scripts: { build: 'tsc && vite build' }, devDependencies: { vite: '^8' } } };
  const found = await describeRepo('o/tool', fakeGithub({ info, files }));
  assert.deepEqual(found.raw.distributions.map((d) => d.kind), ['web', 'bundle']);
  assert.deepEqual(found.raw.distributions[1].build, { output: 'dist', steps: [['npm', 'run', 'build', '--', '--base', './']] });
  assert.deepEqual(normalizeManifest(found.raw, { repo: 'o/tool' }).errors, []);
  const plain = await describeRepo('o/tool', fakeGithub({ info, files: { 'package.json': { scripts: { test: 'x' } } } }));
  assert.deepEqual(plain.raw.distributions.map((d) => d.kind), ['web', 'mirror'], 'no build script: mirror');
});

test('inferBuild reads the build output from the tooling', () => {
  assert.equal(inferBuild(null), null);
  assert.deepEqual(inferBuild({ scripts: { build: 'react-scripts build' }, dependencies: { 'react-scripts': '5' } }), { output: 'build', steps: [['npm', 'run', 'build']] });
});
