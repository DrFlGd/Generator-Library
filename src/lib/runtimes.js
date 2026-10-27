// Runtimes a generator needs besides the library itself, installed privately into
// the library's data folder so nothing on the system has to change.
//
// Today that is Python (WebMirror, and any manifest that declares a Python
// requirement). The interpreter is a python-build-standalone "install_only"
// build: a relocatable CPython with pip, one tar.gz per platform, checksummed in
// the release's SHA256SUMS. The release tag is pinned so every install of the
// library gets the same interpreter; bump PYTHON_BUILD to move it.
//
//   <dataDir>/runtimes/python/          the unpacked interpreter
//   library.state.runtimes.python       { version, tag, dir, executable, packages: { spec: installedAt } }

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { extractTarGz } from './archive.js';
import { mergeRequires } from './manifest.js';

export const PYTHON_BUILD = {
  tag: '20261026',
  minor: '3.12',
  base: 'https://github.com/astral-sh/python-build-standalone/releases/download',
};

// WebMirror's engine, with Playwright for capturing what a page loads at run
// time. An archive URL rather than git+https so the user does not need git.
export const WEBMIRROR_REQUIREMENT = {
  runtime: 'python',
  packages: [{ spec: 'webmirror[dynamic] @ https://github.com/DrFlGd/WebMirror/archive/refs/heads/main.zip', import: 'webmirror' }],
};

const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

export function pythonTriple(platform = process.platform, arch = process.arch) {
  const triple = TRIPLES[`${platform}-${arch}`];
  if (!triple) throw new Error(`No private Python build for ${platform} ${arch}; set a Python path in Settings instead.`);
  return triple;
}

export function pythonExecutable(dir, platform = process.platform) {
  return platform === 'win32' ? path.join(dir, 'python.exe') : path.join(dir, 'bin', 'python3');
}

// Pick this platform's archive out of a SHA256SUMS listing.
export function findPythonAsset(sums, { minor = PYTHON_BUILD.minor, triple = pythonTriple() } = {}) {
  const pattern = new RegExp(`^([0-9a-f]{64})\\s+\\*?(cpython-${minor.replace('.', '\\.')}\\.(\\d+)\\+\\d+-${triple}-install_only\\.tar\\.gz)$`);
  for (const line of sums.split(/\r?\n/)) {
    const match = line.trim().match(pattern);
    if (match) return { sha256: match[1], name: match[2], version: `${minor}.${match[3]}` };
  }
  return null;
}

function run(command, args, { onLine = () => {}, spawnImpl = spawn, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: env ? { ...process.env, ...env } : undefined });
    } catch (error) {
      reject(error);
      return;
    }
    const tail = [];
    const feed = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 20) tail.shift();
        onLine(line);
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(command)} ${args[0] ?? ''} failed (exit ${code}): ${tail.slice(-3).join(' ')}`))));
  });
}

export async function canImport(python, modules, { spawnImpl = spawn } = {}) {
  if (!modules.length) return true;
  try {
    await run(python, ['-c', modules.map((m) => `import ${m}`).join('; ')], { spawnImpl });
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function createRuntimes({ library, fetchImpl = globalThis.fetch, spawnImpl = spawn, download }) {
  const root = path.join(library.dataDir, 'runtimes');
  const pythonDir = path.join(root, 'python');

  function managed() {
    return library.state.runtimes?.python ?? null;
  }

  async function saveManaged(record) {
    library.state.runtimes = { ...(library.state.runtimes ?? {}), python: record };
    if (!record) delete library.state.runtimes.python;
    await library.save();
  }

  async function installPython({ log = () => {}, progress = () => {} } = {}) {
    const triple = pythonTriple();
    log(`Looking up Python ${PYTHON_BUILD.minor} for ${triple}`);
    const sumsRes = await fetchImpl(`${PYTHON_BUILD.base}/${PYTHON_BUILD.tag}/SHA256SUMS`);
    if (!sumsRes.ok) throw new Error(`Could not read the Python build list (HTTP ${sumsRes.status})`);
    const asset = findPythonAsset(await sumsRes.text(), { triple });
    if (!asset) throw new Error(`No Python ${PYTHON_BUILD.minor} build for ${triple} in release ${PYTHON_BUILD.tag}`);

    await fs.mkdir(root, { recursive: true });
    const archive = path.join(library.downloadsDir, asset.name);
    const staging = path.join(root, 'python.staging');
    try {
      log(`Downloading Python ${asset.version}`);
      await download(`${PYTHON_BUILD.base}/${PYTHON_BUILD.tag}/${encodeURIComponent(asset.name)}`, archive, {
        onProgress: (p) => progress({ message: `Downloading Python ${asset.version}`, ...p }),
      });
      if ((await sha256(archive)) !== asset.sha256) throw new Error('The Python download did not match its published checksum');
      log('Unpacking Python');
      progress({ message: 'Unpacking Python' });
      await fs.rm(staging, { recursive: true, force: true });
      // The archive holds one top-level "python/" folder, dropped by strip: 1.
      await extractTarGz(archive, staging, { strip: 1, modes: true, symlinks: true });
      await fs.rm(pythonDir, { recursive: true, force: true });
      await fs.rename(staging, pythonDir);
    } finally {
      await fs.rm(archive, { force: true });
      await fs.rm(staging, { recursive: true, force: true });
    }
    const executable = pythonExecutable(pythonDir);
    await run(executable, ['--version'], { spawnImpl });
    const record = { version: asset.version, tag: PYTHON_BUILD.tag, dir: pythonDir, executable, packages: {}, installedAt: new Date().toISOString() };
    await saveManaged(record);
    log(`Python ${asset.version} ready`);
    return record;
  }

  async function installPackages(record, packages, { log = () => {}, progress = () => {} } = {}) {
    const missing = packages.filter((p) => !record.packages?.[p.spec]);
    if (!missing.length) return record;
    progress({ message: `Installing ${missing.map((p) => p.import || p.spec.split(/[\s@[]/)[0]).join(', ')}` });
    await run(record.executable, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--upgrade', ...missing.map((p) => p.spec)], {
      spawnImpl,
      env: { PIP_NO_WARN_SCRIPT_LOCATION: '1' },
      onLine: (line) => {
        if (/^(Collecting|Downloading|Installing|Successfully|Building|ERROR)/.test(line.trim())) log(line.trim());
      },
    });
    const next = { ...record, packages: { ...(record.packages ?? {}) } };
    for (const p of missing) next.packages[p.spec] = new Date().toISOString();
    await saveManaged(next);
    return next;
  }

  // The interpreter to use for a set of Python requirements, installing what is
  // missing. A Python path set in Settings is used as is, never modified.
  async function ensurePython(packages = [], hooks = {}) {
    const imports = packages.map((p) => p.import).filter(Boolean);
    const configured = library.state.settings.pythonPath;
    if (configured) {
      if (await canImport(configured, imports, { spawnImpl })) return configured;
      throw new Error(`The Python set in Settings (${configured}) cannot import ${imports.join(', ')}. Clear the setting to let the library manage its own Python.`);
    }
    let record = managed();
    if (record) {
      try {
        await fs.access(record.executable);
      } catch {
        record = null;
      }
    }
    if (!record) {
      hooks.log?.('Python is not installed for the library yet; installing a private copy (about 30 MB, once).');
      record = await installPython(hooks);
    }
    record = await installPackages(record, packages, hooks);
    return record.executable;
  }

  async function ensure(requires, hooks = {}) {
    const out = {};
    for (const req of mergeRequires(requires)) {
      if (req.runtime === 'python') out.python = await ensurePython(req.packages, hooks);
    }
    return out;
  }

  async function remove() {
    await fs.rm(pythonDir, { recursive: true, force: true });
    await saveManaged(null);
  }

  function status() {
    const record = managed();
    return {
      python: {
        configured: library.state.settings.pythonPath || '',
        managed: record ? { version: record.version, dir: record.dir, packages: Object.keys(record.packages ?? {}) } : null,
        build: `${PYTHON_BUILD.minor} (${PYTHON_BUILD.tag})`,
      },
    };
  }

  return { ensure, ensurePython, installPython, installPackages, remove, status };
}
