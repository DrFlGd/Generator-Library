import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFor,
  buildSources,
  exportsOf,
  isKnownUrl,
  isPagesSite,
  knownGenerators,
  manifestFor,
  mergeCatalog,
  offlineFromRepo,
  pageRefs,
  parseListing,
  pickRepo,
  pricingOf,
  sitemapPages,
  summarize,
  tscOutFile,
  withoutTracking,
} from '../scripts/import-skipthecad.mjs';
import { normalizeCatalog, resolveSource } from '../src/lib/catalog.js';

// A made-up listing page with the parts the importer reads.
function page({ name = 'Widget Maker', url = 'https://widgets.example/', category = ['storage', 'Storage'], fields = {}, links = [] } = {}) {
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name,
        description: 'Makes widgets &amp; brackets',
        url,
        sameAs: [url],
        featureList: ['Widgets', 'Brackets'],
        offers: { '@type': 'Offer', description: fields.Price ?? 'Free, no account' },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://skipthecad.com/' },
          { '@type': 'ListItem', position: 2, name: category[1], item: `https://skipthecad.com/category/${category[0]}/` },
        ],
      },
    ],
  };
  const spec = Object.entries({ 'Runs on': 'Browser', Exports: 'STL, 3MF', Account: 'Not needed', 'Open source': 'No', Multicolor: 'No', ...fields })
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}<span class="spec__note">a note</span></dd>`)
    .join('');
  const anchors = [`<a href="${url}">Open generator (opens in a new tab)</a>`, '<a href="/category/storage/">Storage</a>', ...links.map(([text, href]) => `<a href="${href}">${text}</a>`)].join('');
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>${name}</h1><dl>${spec}</dl>${anchors}</body></html>`;
}

const LISTING = 'https://skipthecad.com/generators/widget-maker/';

test('sitemapPages keeps only generator pages', () => {
  const xml = '<urlset><url><loc>https://skipthecad.com/generators/a/</loc></url><url><loc>https://skipthecad.com/category/b/</loc></url></urlset>';
  assert.deepEqual(sitemapPages(xml), ['https://skipthecad.com/generators/a/']);
});

test('parseListing reads the structured data, the fields and the links', () => {
  const listing = parseListing(page({ links: [['Source code', 'https://github.com/alice/widgets']] }), LISTING);
  assert.equal(listing.slug, 'widget-maker');
  assert.equal(listing.name, 'Widget Maker');
  assert.equal(listing.summary, 'Makes widgets & brackets');
  assert.equal(listing.url, 'https://widgets.example/');
  assert.deepEqual(listing.category, { slug: 'storage', name: 'Storage' });
  assert.equal(listing.fields['Runs on'], 'Browser', 'notes under a value are dropped');
  assert.ok(listing.links.every((l) => !l.href.startsWith('https://skipthecad.com/')), 'links back into the site are left out');
  assert.equal(pickRepo(listing), 'alice/widgets');
});

test('withoutTracking drops referral parameters only', () => {
  assert.equal(withoutTracking('https://a.example/x?via=SkipTheCAD&size=2&utm_source=y'), 'https://a.example/x?size=2');
  assert.equal(withoutTracking('not a url'), '');
});

test('pickRepo prefers the repository a GitHub Pages generator runs from', () => {
  const listing = parseListing(page({ url: 'https://bob.github.io/boxes/', links: [['Other', 'https://github.com/carol/lib']] }), LISTING);
  assert.equal(pickRepo(listing), 'bob/boxes');
});

test('pricingOf separates free, free with paid extras, and paid', () => {
  assert.equal(pricingOf('Free, no account'), 'free');
  assert.equal(pricingOf('Free, no account; optional Ko-fi tip'), 'free');
  assert.equal(pricingOf('Free. No paid tier and no ads.'), 'free');
  assert.equal(pricingOf('Free for personal use; selling prints needs a commercial license'), 'free');
  assert.equal(pricingOf('Free plan: 10 exports; Pro $49/year'), 'freemium');
  assert.equal(pricingOf('No free tier. Basic $5/month'), 'paid');
  assert.equal(pricingOf('One-time purchase, $34.99'), 'paid');
  assert.equal(pricingOf(''), '');
});

test('exportsOf lists file types', () => {
  assert.deepEqual(exportsOf('STL, 3MF and STEP (zipped)'), ['stl', '3mf', 'step']);
});

test('a MakerWorld model is an online link only', () => {
  const listing = parseListing(page({ url: 'https://makerworld.com/en/models/1-thing', fields: { 'Runs on': 'MakerWorld', Account: 'Required to download', Price: 'Free; MakerWorld login needed' } }), LISTING);
  const manifest = manifestFor(listing, null);
  assert.deepEqual(manifest.distributions, [{ kind: 'web', url: 'https://makerworld.com/en/models/1-thing', label: 'Open on MakerWorld' }]);
  assert.equal(manifest.account, true);
  assert.ok(manifest.tags.includes('makerworld'));
});

test('a free browser tool without a repository gets a mirror', () => {
  const manifest = manifestFor(parseListing(page(), LISTING), null);
  assert.deepEqual(manifest.distributions.map((d) => d.kind), ['web', 'mirror']);
  assert.equal(manifest.pricing, 'free');
  assert.equal(manifest.category, 'storage');
  assert.deepEqual(manifest.exports, ['stl', '3mf']);
  assert.match(manifest.description, /^Makes: Widgets; Brackets\.\nPrice: Free, no account\.\nRuns on: Browser\.$/);
  assert.equal(manifest.listing, LISTING);
});

test('paid, sign-up and AI tools are not mirrored', () => {
  const paid = manifestFor(parseListing(page({ fields: { Price: 'Free plan; Pro $5/month' } }), LISTING), null);
  const account = manifestFor(parseListing(page({ fields: { Account: 'Required to download' } }), LISTING), null);
  const ai = manifestFor(parseListing(page({ category: ['ai-3d', 'AI to 3D'] }), LISTING), null);
  for (const m of [paid, account, ai]) assert.deepEqual(m.distributions.map((d) => d.kind), ['web']);
  assert.ok(ai.tags.includes('ai'));
});

const facts = (extra) => ({ name: 'alice/widgets', full: 'alice/widgets', license: 'MIT', topics: ['gridfinity', 'Not A Tag'], releases: [], pkg: {}, staticSite: null, ...extra });

test('a repository with a web zip release installs that instead of a mirror', () => {
  const manifest = manifestFor(parseListing(page(), LISTING), facts({ releases: [{ tag: 'v1.2.0', pre: false, assets: ['widgets-web-1.2.0.zip', 'Widgets-1.2.0-setup.exe', 'Widgets-1.2.0-arm64.dmg', 'Widgets-1.2.0.dmg'] }] }));
  assert.deepEqual(manifest.distributions.slice(1), [
    { kind: 'bundle', label: 'Install offline copy', from: { type: 'release', repo: 'alice/widgets', asset: 'widgets-web-*.zip' } },
    { kind: 'exe', platform: 'windows', install: 'installer', from: { type: 'release', repo: 'alice/widgets', asset: 'Widgets-*-setup.exe' }, label: 'Install desktop app' },
    { kind: 'exe', platform: 'macos', install: 'installer', from: { type: 'release', repo: 'alice/widgets', asset: 'Widgets-*-arm64.dmg' }, label: 'Install desktop app (Apple silicon)' },
  ]);
  assert.equal(manifest.repo, 'alice/widgets');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.openSource, true);
  assert.deepEqual(manifest.tags, ['gridfinity']);
});

test('Vite and Create React App projects are built from source; desktop wrappers are not', () => {
  assert.deepEqual(buildFor(facts({ pkg: { 'package.json': { scripts: { build: 'vite build' }, tools: ['vite'], workspaces: false } } })), {
    output: 'dist',
    steps: [['npx', 'vite', 'build', '--base=./']],
  });
  assert.deepEqual(buildFor(facts({ pkg: { 'web/package.json': { scripts: { build: 'react-scripts build' }, tools: ['react-scripts'], workspaces: false } } })), {
    output: 'web/build',
    steps: [['npm', 'ci', '--prefix', 'web', '--ignore-scripts', '--no-audit', '--no-fund'], ['npm', '--prefix', 'web', 'run', 'build']],
    env: { PUBLIC_URL: '.' },
  });
  assert.equal(buildFor(facts({ pkg: { 'package.json': { scripts: { build: 'vite build' }, tools: ['vite', 'electron'], workspaces: false } } })), null);
});

test('a plain static repository is served from its files', () => {
  assert.deepEqual(offlineFromRepo(facts({ staticSite: 'docs' }))[0].from, { type: 'repo', repo: 'alice/widgets', path: 'docs' });
  assert.deepEqual(offlineFromRepo(facts({ staticSite: null })), []);
});

test('pageRefs finds files a page needs that the repository lacks, and the sites it loads from', () => {
  const html = `<link rel="icon" href="/fav.ico"><link rel="stylesheet" href="style.css">
    <script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"></script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=1"></script>
    <script type="importmap">{"imports":{"manifold":"https://cdn.jsdelivr.net/npm/manifold-3d@3/+esm"}}</script>
    <script type="module">import { a } from './js/a.js'; import('/js/b.js');</script>`;
  assert.deepEqual(pageRefs(html, ['web/index.html', 'web/style.css', 'web/js/a.js', 'web/js/b.js'], 'web'), { missing: [], hosts: ['cdn.jsdelivr.net'] });
  assert.deepEqual(pageRefs(html, ['index.html', 'style.css', 'js/a.js']).missing, ['/js/b.js']);
  assert.deepEqual(pageRefs('<script src="/resorte/_next/app.js"></script>', ['_next/app.js']).missing, ['/resorte/_next/app.js'], 'a base path the server will not have');
  assert.deepEqual(pageRefs('<script src="https://tool.example/index.1.js"></script>', ['index.1.js']).missing, ['https://tool.example/index.1.js'], 'its own files from its own address');
});

test('a static site is served from the repository even with a package.json that builds nothing', () => {
  const [bundle] = offlineFromRepo(facts({ pkg: { 'package.json': { scripts: { build: '' }, tools: [], workspaces: false } }, staticSite: '', staticRefs: { missing: [], hosts: ['unpkg.com'] } }));
  assert.deepEqual(bundle.from, { type: 'repo', repo: 'alice/widgets' });
  assert.match(bundle.notes, /unpkg\.com, so it still needs the internet/);
  assert.deepEqual(offlineFromRepo(facts({ staticSite: '', staticRefs: { missing: ['app.js'], hosts: [] } })), [], 'a page whose script is not committed');
  const [page] = offlineFromRepo(facts({ staticSite: '', staticRefs: { missing: [], hosts: [] }, staticPages: ['index.html', 'index_3d.html'] }), 'https://maps.example/index_3d.html?z=13');
  assert.equal(page.entry, 'index_3d.html');
});

test("the gh-pages branch is used only when it is the generator's own site", () => {
  assert.ok(isPagesSite('https://alice.github.io/widgets/', 'alice/widgets'));
  assert.ok(isPagesSite('https://www.widgets.example/', 'alice/widgets', 'widgets.example'));
  assert.ok(!isPagesSite('https://alice.github.io/other/', 'alice/widgets'));
  assert.ok(!isPagesSite('https://widgets.example/', 'alice/widgets'), 'a project page for a tool hosted elsewhere');
  const pagesBranch = { ref: 'gh-pages', cname: '', missing: [], hosts: [] };
  assert.deepEqual(offlineFromRepo(facts({ pagesBranch }), 'https://alice.github.io/widgets/')[0].from, { type: 'repo', repo: 'alice/widgets', ref: 'gh-pages' });
  assert.deepEqual(offlineFromRepo(facts({ pagesBranch }), 'https://widgets.example/'), []);
  assert.deepEqual(offlineFromRepo(facts({ pagesBranch: { ...pagesBranch, missing: ['/widgets/_next/a.js'] } }), 'https://alice.github.io/widgets/'), []);
});

test('a static page that loads an uncommitted TypeScript output is compiled first', () => {
  const tsconfig = '{\n  // one script\n  "compilerOptions": { "outFile": "app.js", "target": "esnext", },\n}';
  assert.equal(tscOutFile(tsconfig, ['index.html', 'app.ts', 'tsconfig.json']), 'app.js');
  assert.equal(tscOutFile(tsconfig, ['index.html', 'app.ts', 'app.js']), '', 'already committed');
  assert.equal(tscOutFile('{"compilerOptions": {"outDir": "out"}}', []), '');
  assert.equal(tscOutFile('not json', []), '');
  const [bundle] = offlineFromRepo(facts({ staticSite: '', tscOutFile: 'app.js' }));
  assert.deepEqual(bundle.from, { type: 'repo', repo: 'alice/widgets' });
  assert.deepEqual(bundle.build, { output: '.', steps: [['npx', '-p', 'typescript@5', 'tsc']] });
});

test('the importer replaces only its own sources, and the catalog loads them', async () => {
  const existing = { repo: 'dave/known', fallback: { id: 'known-one', name: 'Known', homepage: 'https://known.example/', distributions: [{ kind: 'web', url: 'https://known.example/' }] } };
  const catalog = { version: 1, sources: [existing, { url: 'https://skipthecad.com/category/old/', fallback: { id: 'skipthecad-old', name: 'Old', generators: [{ id: 'gone', name: 'Gone', distributions: [{ kind: 'web', url: 'https://gone.example/' }] }] } }] };
  const known = knownGenerators(catalog);
  assert.ok(known.ids.has('known-one') && known.repos.has('dave/known') && known.urls.has('known.example'));
  assert.ok(!known.ids.has('gone'), 'its own earlier entries do not count as already listed');
  assert.ok(isKnownUrl(known, 'https://known.example/tools/box/'), 'a page inside a listed site');
  assert.ok(!isKnownUrl(known, 'https://other.example/'));
  const mw = knownGenerators({ sources: [{ repo: 'dave/mw', fallback: { id: 'mw', name: 'MW', distributions: [{ kind: 'web', url: 'https://makerworld.com/en/models/123' }] } }] });
  assert.ok(isKnownUrl(mw, 'https://makerworld.com/de/models/123-some-slug#profileId-9'), 'a MakerWorld model by its number');
  assert.ok(!isKnownUrl(mw, 'https://makerworld.com/en/models/1234-other'));

  const listing = parseListing(page(), LISTING);
  const withRepo = manifestFor(parseListing(page({ name: 'Boxer' }), 'https://skipthecad.com/generators/boxer/'), facts({ staticSite: '' }));
  const after = mergeCatalog(catalog, buildSources([{ manifest: manifestFor(listing, null), category: listing.category }, { manifest: withRepo, category: listing.category }]));
  assert.equal(after.sources.length, 2);
  assert.equal(after.sources[0], existing);
  assert.equal(after.sources[1].fallback.id, 'skipthecad-storage');
  assert.deepEqual(after.sources[1].fallback.generators.map((g) => g.id), ['boxer', 'widget-maker']);

  const summary = summarize(catalog, after);
  assert.deepEqual([summary.added.length, summary.removed.length], [2, 1]);
  assert.match(summary.markdown, /2 new, 0 changed, 1 gone/);

  const { catalog: normalized, errors } = normalizeCatalog(after);
  assert.deepEqual(errors, []);
  const { manifests, problems } = await resolveSource(normalized.sources[1], { readJson: async () => null });
  assert.deepEqual(problems, []);
  assert.deepEqual(manifests.map((m) => [m.id, m.repo, m.collection.id]), [['boxer', 'alice/widgets', 'skipthecad-storage'], ['widget-maker', '', 'skipthecad-storage']]);
});
