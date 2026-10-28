import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareNames, createWeb, findLinks, versionFromName } from '../src/lib/web.js';

test('download links are found by file name, newest version first', async () => {
  const html = `<a href="/downloads/App-1.9.0-setup.exe">old</a>
    <a href='https://cdn.example.com/files/App-1.10.2-setup.exe'>new</a>
    <a href="/downloads/App-1.10.2-x86_64.AppImage">linux</a>`;
  const links = findLinks(html, 'https://example.com/desktop', 'App-*-setup.exe');
  assert.deepEqual(links.map((l) => l.url), ['https://example.com/downloads/App-1.9.0-setup.exe', 'https://cdn.example.com/files/App-1.10.2-setup.exe']);
  assert.ok(compareNames('App-1.10.2-setup.exe', 'App-1.9.0-setup.exe') > 0);
  assert.equal(versionFromName('MiniSkylines-Desktop-1.511-x86_64.AppImage'), '1.511');
  assert.equal(versionFromName('tool.exe'), 'tool.exe');

  const pages = {
    'https://example.com/desktop': `<html><script type="module" src="/assets/index-1.js"></script></html>`,
    'https://example.com/assets/index-1.js': 'const a="/downloads/App-1.9.0-setup.exe",b="/downloads/App-1.10.2-setup.exe";',
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, undefined, 'no GitHub token is sent to other sites');
    if (!(url in pages)) return { ok: false, status: 404 };
    return { ok: true, status: 200, url, text: async () => pages[url] };
  };
  const web = createWeb({ fetchImpl });
  const found = await web.findPageAsset('https://example.com/desktop', 'App-*-setup.exe');
  assert.deepEqual(found, { url: 'https://example.com/downloads/App-1.10.2-setup.exe', name: 'App-1.10.2-setup.exe' });
  await assert.rejects(web.findPageAsset('https://example.com/desktop', 'Other-*.dmg'), /No download matching/);

  // A Vite site: the name sits bare in a chunk the entry script imports.
  const vite = {
    'https://shop.example/desktop': '<link rel="modulepreload" href="/assets/index-A.js"><script type="module" src="/assets/index-A.js"></script>',
    'https://shop.example/assets/index-A.js': 'import{a}from"./vendor-B.js";const m=()=>import("./downloads-C.js");',
    'https://shop.example/assets/vendor-B.js': 'export const a=1;',
    'https://shop.example/assets/downloads-C.js': 'var g=`Tool-Desktop-1.511-setup.exe`,y=`Tool-Desktop-1.511-mac-arm64.dmg`;',
  };
  const viteWeb = createWeb({ fetchImpl: async (url) => (url in vite ? { ok: true, status: 200, url, text: async () => vite[url] } : { ok: false, status: 404 }) });
  assert.deepEqual(
    await viteWeb.findPageAsset('https://shop.example/desktop', 'Tool-Desktop-*-mac-arm64.dmg', { folder: 'https://shop.example/downloads/desktop/' }),
    { url: 'https://shop.example/downloads/desktop/Tool-Desktop-1.511-mac-arm64.dmg', name: 'Tool-Desktop-1.511-mac-arm64.dmg' },
  );
});
