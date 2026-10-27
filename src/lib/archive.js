// Unpack the two archive shapes GitHub hands us: zip release assets (via fflate)
// and gzipped tarballs of a repository tree (a minimal ustar/pax reader, because
// pulling in a tar dependency for one call is more code than reading the format).
//
// Both guard against path traversal: an entry that would land outside `dest` is
// skipped and reported, never written.

import { createReadStream, promises as fs } from 'node:fs';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import { unzipSync } from 'fflate';

function safeJoin(dest, relativePath) {
  const target = path.resolve(dest, relativePath);
  const root = path.resolve(dest);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

export async function extractZip(archivePath, dest, { strip = 0 } = {}) {
  const data = await fs.readFile(archivePath);
  const entries = unzipSync(new Uint8Array(data));
  const written = [];
  const skipped = [];
  for (const [name, bytes] of Object.entries(entries)) {
    const parts = name.split('/').filter(Boolean);
    if (parts.length <= strip) continue;
    const rel = parts.slice(strip).join('/');
    if (name.endsWith('/')) continue;
    const target = safeJoin(dest, rel);
    if (!target) {
      skipped.push(name);
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    written.push(rel);
  }
  return { written, skipped };
}

function parseOctal(buf) {
  const text = buf.toString('ascii').replace(/\0.*$/s, '').trim();
  return text ? parseInt(text, 8) : 0;
}

// Extract a .tar.gz. `strip` drops that many leading path components (1 for a
// GitHub repository tarball, whose single top folder is named owner-repo-sha; 0
// for a release asset). `subdir` then keeps only entries under that path and
// re-roots them, so `site/index.html` lands at `dest/index.html`.
// `modes` keeps the executable bit and `symlinks` recreates symbolic links whose
// target stays inside `dest`: both are needed for a runtime such as Python, and
// neither is wanted for a repository tree served as a website.
export async function extractTarGz(archivePath, dest, { subdir = '', strip = 1, modes = false, symlinks = false } = {}) {
  const written = [];
  const skipped = [];
  const wanted = subdir.replace(/^\/+|\/+$/g, '');
  const stream = createReadStream(archivePath).pipe(createGunzip());

  let pending = Buffer.alloc(0);
  let longName = null;
  let paxPath = null;
  let paxLink = null;
  let current = null; // { name, size, remaining, fd, target }

  const finishCurrent = async () => {
    if (current?.handle) await current.handle.close();
    current = null;
  };

  const startEntry = async (header) => {
    const typeflag = String.fromCharCode(header[156]);
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    if (prefix) name = `${prefix}/${name}`;
    if (longName !== null) {
      name = longName;
      longName = null;
    }
    if (paxPath !== null) {
      name = paxPath;
      paxPath = null;
    }
    let linkName = header.subarray(157, 257).toString('utf8').replace(/\0.*$/s, '');
    if (paxLink !== null) {
      linkName = paxLink;
      paxLink = null;
    }
    const size = parseOctal(header.subarray(124, 136));
    const mode = parseOctal(header.subarray(100, 108));
    const entry = { name, size, remaining: size, typeflag, target: null, collect: null };
    const relative = () => {
      const parts = name.split('/').filter(Boolean).slice(strip);
      let rel = parts.join('/');
      if (wanted) {
        if (rel !== wanted && !rel.startsWith(wanted + '/')) return null; // not under subdir
        rel = rel.slice(wanted.length + 1);
      }
      return rel || null;
    };
    if (typeflag === 'L') entry.collect = 'longName';
    else if (typeflag === 'x') entry.collect = 'pax';
    else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const rel = relative();
      if (!rel) return entry;
      const target = safeJoin(dest, rel);
      if (!target) {
        skipped.push(name);
        return entry;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      entry.handle = await fs.open(target, 'w', modes && mode & 0o111 ? 0o755 : 0o644);
      entry.target = rel;
    } else if (typeflag === '2' && symlinks) {
      const rel = relative();
      const target = rel && safeJoin(dest, rel);
      const pointsTo = target && safeJoin(dest, path.join(path.dirname(rel), linkName));
      if (!target || !pointsTo || path.isAbsolute(linkName)) {
        skipped.push(name);
        return entry;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rm(target, { force: true });
      await fs.symlink(linkName, target);
      written.push(rel);
    }
    return entry;
  };

  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;
    while (true) {
      if (current) {
        const take = Math.min(current.remaining, pending.length - offset);
        if (take > 0) {
          const slice = pending.subarray(offset, offset + take);
          if (current.handle) await current.handle.write(slice);
          else if (current.collect) current.buffer = current.buffer ? Buffer.concat([current.buffer, slice]) : Buffer.from(slice);
          current.remaining -= take;
          offset += take;
        }
        if (current.remaining > 0) break;
        // Entry data done: skip padding to the next 512 boundary.
        const padding = (512 - (current.size % 512)) % 512;
        if (pending.length - offset < padding) {
          // Wait for more bytes to consume the padding.
          current.padding = padding;
          break;
        }
        offset += padding;
        if (current.collect === 'longName') longName = current.buffer?.toString('utf8').replace(/\0.*$/s, '') ?? '';
        if (current.collect === 'pax') {
          const text = current.buffer?.toString('utf8') ?? '';
          const match = text.match(/^\d+ path=(.*)$/m);
          if (match) paxPath = match[1];
          const link = text.match(/^\d+ linkpath=(.*)$/m);
          if (link) paxLink = link[1];
        }
        if (current.target) written.push(current.target);
        await finishCurrent();
        continue;
      }
      if (pending.length - offset < 512) break;
      const header = pending.subarray(offset, offset + 512);
      offset += 512;
      if (header.every((b) => b === 0)) continue; // end-of-archive blocks
      current = await startEntry(header);
      if (current.size === 0) {
        if (current.target) written.push(current.target);
        await finishCurrent();
      }
    }
    pending = pending.subarray(offset);
  }
  await finishCurrent();
  return { written, skipped };
}
