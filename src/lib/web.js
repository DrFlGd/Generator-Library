// Downloads published on a project's own website rather than on GitHub: a page
// that links to the newest build, such as "https://example.com/download". The
// library reads that page, finds the link whose file name matches the
// distribution's `asset` glob, and treats the file name as the version.
//
// Nothing here sends the GitHub token: these are other people's servers.

import { globToRegExp } from './glob.js';

// Download buttons are often built by the site's JavaScript, which Vite and
// webpack split into many small files; read up to this many to find the name.
const MAX_SCRIPTS = 120;

// Quoted or attribute URLs in HTML or JavaScript: "…/file.ext", '…', `…` and href=….
const URLISH = /["'`=]\s*((?:https?:)?\/?[^"'`\s<>()]*\/[^"'`\s<>()/]+\.[A-Za-z0-9]{1,10})(?=["'`\s>])/g;
// A file name on its own, as a script keeps it before joining it to a folder.
const BARE_NAME = /["'`]([^"'`\s<>()/\\]+\.[A-Za-z0-9]{1,10})["'`]/g;
const SCRIPT_TAG = /<(?:script\b[^>]*\bsrc|link\b[^>]*\brel\s*=\s*["']?modulepreload["']?[^>]*\bhref)\s*=\s*["']([^"']+)["']/gi;
const SCRIPT_REF = /["'`]((?:\.{1,2}\/|\/)?[\w./-]+\.m?js)["'`]/g;

function fileName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
}

// "App-1.10.2-x64.AppImage" sorts above "App-1.9.0-x64.AppImage".
export function compareNames(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// The version a file name carries ("1.511" in "App-Desktop-1.511-x86_64.AppImage"),
// or the whole name when it has none.
export function versionFromName(name) {
  return name.match(/\d+(?:\.\d+)+/)?.[0] ?? name;
}

// Links in `text` whose file name matches `glob`. A bare file name counts too,
// joined to `folder` (the page's own folder unless the source names one).
export function findLinks(text, base, glob, folder = base) {
  const pattern = globToRegExp(glob);
  const found = new Map();
  const add = (raw, against) => {
    let url;
    try {
      url = new URL(raw.replace(/&amp;/g, '&'), against);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    const name = fileName(url.href);
    if (name && pattern.test(name)) found.set(url.href, name);
  };
  for (const match of text.matchAll(URLISH)) add(match[1], base);
  for (const match of text.matchAll(BARE_NAME)) if (pattern.test(match[1])) add(match[1], folder);
  return [...found].map(([url, name]) => ({ url, name }));
}

// Same-site scripts a page or script loads, as absolute URLs.
function scriptRefs(text, base, origin, isHtml) {
  const refs = [];
  for (const match of text.matchAll(isHtml ? SCRIPT_TAG : SCRIPT_REF)) {
    const ref = match[1];
    try {
      // Bundlers list chunks as "assets/x.js" from the site root, imports as "./x.js".
      const url = new URL(ref, /^(\.|\/)/.test(ref) || isHtml ? base : `${origin}/`);
      if (url.origin === origin) refs.push(url.href);
    } catch {
      /* not a URL */
    }
  }
  return refs;
}

export function createWeb({ fetchImpl = globalThis.fetch, userAgent = 'generator-library' } = {}) {
  async function get(url, accept = '*/*') {
    const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: accept }, redirect: 'follow' });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res;
  }

  // The newest file `page` links to whose name matches `glob`. Pages that build
  // their download buttons in JavaScript are covered by also reading the page's
  // own scripts and the scripts they import. `folder` is where bare file names
  // found in those scripts are downloaded from.
  async function findPageAsset(page, glob, { folder } = {}) {
    const res = await get(page, 'text/html');
    const html = await res.text();
    const base = res.url || page;
    const origin = new URL(base).origin;
    const where = folder || base;
    let links = findLinks(html, base, glob, where);
    const queue = scriptRefs(html, base, origin, true);
    const seen = new Set(queue);
    for (let i = 0; !links.length && i < queue.length && i < MAX_SCRIPTS; i += 1) {
      let text;
      try {
        text = await (await get(queue[i])).text();
      } catch {
        continue; // a script that will not load does not hide the others
      }
      links = findLinks(text, base, glob, where);
      for (const ref of scriptRefs(text, queue[i], origin, false)) {
        if (!seen.has(ref)) {
          seen.add(ref);
          queue.push(ref);
        }
      }
    }
    if (!links.length) throw new Error(`No download matching ${glob} on ${page}`);
    links.sort((a, b) => compareNames(b.name, a.name));
    return links[0];
  }

  async function download(url, destination, { onProgress } = {}) {
    const fs = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    const res = await get(url, 'application/octet-stream');
    if (!res.body) throw new Error(`Download failed for ${url}`);
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

  return { findPageAsset, download };
}
