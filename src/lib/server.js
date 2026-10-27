// Loopback static server for installed web bundles and WebMirror snapshots.
// Serves one root per instance on 127.0.0.1 only. Honours WebMirror's
// .webmirror-routes.json (original URL -> saved file) and, for SPA bundles,
// reloads the entry page for extension-less navigations the way GitHub Pages or
// Vercel would.

import http from 'node:http';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.stl': 'model/stl',
  '.3mf': 'model/3mf',
  '.obj': 'text/plain',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

async function readRoutes(root) {
  try {
    const text = await fs.readFile(path.join(root, '.webmirror-routes.json'), 'utf8');
    const routes = JSON.parse(text);
    return routes && typeof routes === 'object' ? routes : {};
  } catch {
    return {};
  }
}

// Resolve a request URL to a file under root, or null. Exported for tests.
export async function resolveFile(root, requestUrl, { routes = {}, entry = 'index.html', spa = false, wantsHtml = false } = {}) {
  const url = new URL(requestUrl, 'http://localhost');
  const lookup = url.pathname + (url.search || '');
  const resolvedRoot = path.resolve(root);
  const within = (p) => {
    const abs = path.resolve(resolvedRoot, p);
    return abs === resolvedRoot || abs.startsWith(resolvedRoot + path.sep) ? abs : null;
  };
  const isFile = async (p) => {
    try {
      return (await fs.stat(p)).isFile();
    } catch {
      return false;
    }
  };

  const routed = routes[lookup] ?? routes[url.pathname];
  if (routed) {
    const abs = within(routed.replace(/^\/+/, ''));
    if (abs && (await isFile(abs))) return abs;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const abs = within(pathname.replace(/^\/+/, ''));
  if (abs) {
    if (await isFile(abs)) return abs;
    const asDir = path.join(abs, 'index.html');
    if (await isFile(asDir)) return asDir;
  }
  if (spa && wantsHtml && !path.extname(pathname)) {
    const fallback = within(entry);
    if (fallback && (await isFile(fallback))) return fallback;
  }
  return null;
}

export async function createStaticServer({ root, entry = 'index.html', spa = false, port = 0 }) {
  const routes = await readRoutes(root);
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    const file = await resolveFile(root, req.url ?? '/', { routes, entry, spa, wantsHtml });
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const stat = await fs.stat(file);
    res.writeHead(200, {
      'Content-Type': mimeFor(file),
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      // Several generators run WASM/threads that need a cross-origin isolated page.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    url: `${base}/${entry.replace(/^\/+/, '')}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
