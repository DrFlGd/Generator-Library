#!/usr/bin/env node
// Make a static site that loads npm packages from jsDelivr work offline: every
// "https://cdn.jsdelivr.net/npm/<name>@<version>[/path | /+esm]" in its HTML and
// JavaScript is downloaded from the npm registry into vendor/ and replaced with a
// path relative to the file that names it, so import maps, static imports,
// dynamic import() and module workers all load the local copy.
//
//   node vendor-cdn.mjs <site folder>

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CDN = /https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[\w.-]+\/)?[\w.-]+)@([\w.+-]+)(\/\+esm|\/[^\s"'`)]*)?/g;
const TEXT = /\.(html?|m?js)$/i;
const BARE_IMPORT = /\b(?:from|import)\s*\(?\s*["']([^./"'][^"']*)["']/g;

async function files(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') found.push(...(await files(full)));
    } else if (TEXT.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

// The file an ES module import of the package itself loads.
function esmEntry(pkg) {
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      for (const key of ['browser', 'import', 'module', 'default']) {
        const hit = pick(value[key]);
        if (hit) return hit;
      }
    }
    return null;
  };
  const exported = pkg.exports && (typeof pkg.exports === 'string' ? pkg.exports : pick(pkg.exports['.'] ?? pkg.exports));
  const entry = exported || pkg.module || pkg.main || 'index.js';
  return entry.replace(/^\.\//, '');
}

async function fetchPackage(name, version, vendor, tmp) {
  const folder = path.join(vendor, `${name}@${version}`);
  try {
    await fs.access(folder);
    return folder;
  } catch {
    /* not downloaded yet */
  }
  const tarball = execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', tmp, '--silent'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop();
  await fs.mkdir(folder, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(tmp, tarball), '-C', folder, '--strip-components=1']);
  console.log(`vendored ${name}@${version}`);
  return folder;
}

async function main() {
  const site = path.resolve(process.argv[2] ?? '.');
  const vendor = path.join(site, 'vendor');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vendor-cdn-'));
  const local = new Map();
  for (const file of await files(site)) {
    const text = await fs.readFile(file, 'utf8');
    const urls = [...text.matchAll(CDN)];
    if (!urls.length) continue;
    for (const [url, name, version, rest = ''] of urls) {
      if (!local.has(url)) {
        const folder = await fetchPackage(name, version, vendor, tmp);
        let target;
        if (rest === '' || rest === '/+esm') {
          const pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
          target = path.join(folder, esmEntry(pkg));
          const code = await fs.readFile(target, 'utf8');
          const bare = [...code.matchAll(BARE_IMPORT)].map((m) => m[1]);
          if (bare.length) throw new Error(`${url} imports other packages (${bare.join(', ')}); vendor it by path instead`);
        } else {
          target = path.join(folder, rest.slice(1));
          if (!rest.endsWith('/')) await fs.access(target);
        }
        local.set(url, { target, folderLike: rest.endsWith('/') });
      }
    }
    const out = text.replace(CDN, (url) => {
      const { target, folderLike } = local.get(url);
      let relative = path.relative(path.dirname(file), target).split(path.sep).join('/');
      if (!relative.startsWith('.')) relative = `./${relative}`;
      if (folderLike && !relative.endsWith('/')) relative += '/';
      return relative;
    });
    await fs.writeFile(file, out);
    console.log(`rewrote ${path.relative(site, file)}`);
  }
  await fs.rm(tmp, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
