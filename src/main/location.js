// Where the library keeps its data: installed apps, runtimes, settings, and the
// browser profile its app windows save into.
//
// The portable builds (the Windows portable exe and the Linux AppImage) keep
// everything in a "Generator Library Data" folder beside the app file, so the
// whole library can live on an external drive. The installed build keeps it in
// the user's app-data folder, because its installer replaces the program folder
// on every update. Either way a pointer file names another folder when the user
// moves the library in Settings; a relative path in it is read against the
// pointer's own folder, so a drive that comes back under another letter works.
//
//   <base>/data-location.json   { "dataDir": "...", "moveProfileFrom"?: "...", "removeAfterMove"?: "..." }
//   <dataDir>/library.json ...  the Library (library.js)
//   <dataDir>/browser/          Chromium's profile (Electron userData)
//
// <base> is the folder holding the portable app file, or app-data for the
// installed build. Installs from before this layout keep app-data/library for the
// Library and app-data for the profile until they are moved.

import fs from 'node:fs';
import path from 'node:path';

export const POINTER = 'data-location.json';
export const PORTABLE_FOLDER = 'Generator Library Data';

// The folder a portable build runs from, or '' for an installed build.
// electron-builder's portable exe unpacks to a temporary folder and names the
// real one in PORTABLE_EXECUTABLE_DIR; an AppImage names its own file in APPIMAGE.
export function portableBase(env = process.env) {
  if (env.PORTABLE_EXECUTABLE_DIR) return env.PORTABLE_EXECUTABLE_DIR;
  if (env.APPIMAGE) return path.dirname(env.APPIMAGE);
  return '';
}

function readPointer(base) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(base, POINTER), 'utf8'));
    return raw && typeof raw.dataDir === 'string' && raw.dataDir ? raw : null;
  } catch {
    return null;
  }
}

export function writePointer(base, pointer) {
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, POINTER);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(pointer, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// Store a folder relative to the pointer when it sits on the same drive, so the
// pair can move together.
export function pointerPath(base, dir) {
  const rel = path.relative(base, dir);
  return rel && !path.isAbsolute(rel) && !/^[a-z]:/i.test(rel) ? rel : dir;
}

const hasLibrary = (dir) => fs.existsSync(path.join(dir, 'library.json'));

// Decide the folders for this launch. `appData` is Electron's default userData
// (app-data/Generator Library), `env` gives the portable markers.
export function resolveLocation({ appData, env = process.env }) {
  const portable = portableBase(env);
  const base = portable || appData;
  const pointer = readPointer(base);
  if (pointer) {
    const dataDir = path.resolve(base, pointer.dataDir);
    return { mode: 'custom', portable: Boolean(portable), base, pointer, dataDir, libraryDir: dataDir, profileDir: path.join(dataDir, 'browser') };
  }
  const legacy = { libraryDir: path.join(appData, 'library'), profileDir: appData };
  if (portable) {
    const dataDir = path.join(portable, PORTABLE_FOLDER);
    // A portable copy that ran before this layout used app-data; keep using it
    // until the user moves it, rather than starting an empty library.
    if (!hasLibrary(dataDir) && hasLibrary(legacy.libraryDir)) return { mode: 'legacy', portable: true, base, pointer: null, dataDir: legacy.libraryDir, ...legacy, suggested: dataDir };
    return { mode: 'portable', portable: true, base, pointer: null, dataDir, libraryDir: dataDir, profileDir: path.join(dataDir, 'browser') };
  }
  return { mode: 'default', portable: false, base, pointer: null, dataDir: legacy.libraryDir, ...legacy };
}

// Chromium's caches are rebuilt on demand, and the old library folder may sit
// inside the old profile; neither is copied with the profile.
const PROFILE_SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'Crashpad', 'library', 'browser', POINTER, PORTABLE_FOLDER]);

// Finish a move started in Settings. The Library itself was copied while the app
// ran; the browser profile can only be copied before Chromium opens it, so that
// happens here at the next launch, before the app is ready.
export function finishMove(location) {
  const { pointer, base } = location;
  if (!pointer?.moveProfileFrom) return null;
  const from = path.resolve(base, pointer.moveProfileFrom);
  const copied = [];
  if (fs.existsSync(from) && path.resolve(from) !== path.resolve(location.profileDir)) {
    fs.mkdirSync(location.profileDir, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (PROFILE_SKIP.has(name) || name.endsWith('.log')) continue;
      fs.cpSync(path.join(from, name), path.join(location.profileDir, name), { recursive: true, force: true, errorOnExist: false });
      copied.push(name);
    }
  }
  if (pointer.removeAfterMove) {
    const old = path.resolve(base, pointer.removeAfterMove);
    if (old !== path.resolve(location.dataDir) && hasLibrary(old)) fs.rmSync(old, { recursive: true, force: true });
  }
  const { moveProfileFrom, removeAfterMove, ...rest } = pointer;
  writePointer(base, rest);
  location.pointer = rest;
  return copied;
}

// Where a library moved to `chosen` goes: the folder itself when it is empty or
// already holds a library, otherwise a "Generator Library Data" folder inside it,
// so picking a drive or a busy folder does not scatter files into it.
export function moveTarget(chosen) {
  const dir = path.resolve(chosen);
  if (!fs.existsSync(dir) || hasLibrary(dir) || fs.readdirSync(dir).length === 0) return dir;
  return path.join(dir, PORTABLE_FOLDER);
}

const COPY_SKIP = new Set(['downloads', 'browser']);

// Copy the Library folder (not the browser profile, which finishMove copies at
// the next launch, nor half-finished installs) and count files as they go.
export async function copyLibrary(from, to, { onProgress = () => {} } = {}) {
  let files = 0;
  const walk = async (rel) => {
    const src = path.join(from, rel);
    for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
      if (!rel && COPY_SKIP.has(entry.name)) continue;
      if (/\.(staging|source)$/.test(entry.name)) continue;
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        await fs.promises.mkdir(path.join(to, child), { recursive: true });
        await walk(child);
      } else if (entry.isFile()) {
        await fs.promises.copyFile(path.join(from, child), path.join(to, child));
        if (++files % 200 === 0) onProgress(files);
      } else if (entry.isSymbolicLink()) {
        const link = await fs.promises.readlink(path.join(from, child));
        await fs.promises.symlink(link, path.join(to, child)).catch(() => {});
      }
    }
  };
  await fs.promises.mkdir(to, { recursive: true });
  await walk('');
  onProgress(files);
  return files;
}

// Check a move before starting it; returns the folder the library will live in.
export function checkMove(current, chosen) {
  if (!chosen) throw new Error('Choose a folder');
  const target = moveTarget(chosen);
  const from = path.resolve(current);
  const rel = path.relative(from, target);
  if (!rel) throw new Error('The library is already in that folder');
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('Choose a folder outside the current library folder');
  return target;
}
