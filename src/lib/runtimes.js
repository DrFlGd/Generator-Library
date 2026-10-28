// Runtimes a generator needs besides the library itself, installed privately into
// the library's data folder so nothing on the system has to change.
//
// Python (WebMirror, and any manifest that declares a Python requirement) is a
// python-build-standalone "install_only" build: a relocatable CPython with pip,
// one tar.gz per platform, checksummed in the release's SHA256SUMS.
//
// Node.js (building web apps from their source, build.js) is the official
// nodejs.org build for the platform, checksummed in that release's SHASUMS256.txt.
//
// Both versions are pinned so every install of the library gets the same
// runtime; bump PYTHON_BUILD or NODE_BUILD to move them.
//
//   <dataDir>/runtimes/python/          the unpacked interpreter
//   <dataDir>/runtimes/node/            the unpacked Node.js, npm included
//   library.state.runtimes.python       { version, tag, dir, executable, packages: { spec: installedAt } }
//   library.state.runtimes.node         { version, dir, node, npmCli, npxCli, binDir }

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { extractTarGz, extractZip } from './archive.js';
import { mergeRequires } from './manifest.js';

export const PYTHON_BUILD = {
  tag: '20261026',
  minor: '3.12',
  base: 'https://github.com/astral-sh/python-build-standalone/releases/download',
};

export const NODE_BUILD = {
  version: '24.22.1',
  base: 'https://nodejs.org/dist',
};

const NODE_PLATFORMS = { win32: 'win', linux: 'linux', darwin: 'darwin' };

// The nodejs.org archive name for a platform: a zip on Windows, a tar.gz elsewhere.
export function nodeArchiveName(platform = process.platform, arch = process.arch, version = NODE_BUILD.version) {
  const os = NODE_PLATFORMS[platform];
  if (!os || !['x64', 'arm64'].includes(arch)) throw new Error(`No Node.js build for ${platform} ${arch}`);
  return `node-v${version}-${os}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

// Where node and npm live inside the unpacked archive.
export function nodePaths(dir, platform = process.platform) {
  if (platform === 'win32') {
    const modules = path.join(dir, 'node_modules', 'npm', 'bin');
    return { node: path.join(dir, 'node.exe'), npmCli: path.join(modules, 'npm-cli.js'), npxCli: path.join(modules, 'npx-cli.js'), binDir: dir };
  }
  const modules = path.join(dir, 'lib', 'node_modules', 'npm', 'bin');
  return { node: path.join(dir, 'bin', 'node'), npmCli: path.join(modules, 'npm-cli.js'), npxCli: path.join(modules, 'npx-cli.js'), binDir: path.join(dir, 'bin') };
}

export function findSum(sums, name) {
  for (const line of sums.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+\*?/);
    if (file === name && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  return null;
}

// WebMirror's engine, with Playwright for capturing what a page loads at run
// time. An archive URL rather than git+https so the user does not need git.
// It follows WebMirror's main branch, so it is reinstalled when it is a day old
// and needed again, picking up fixes without a library release. `refreshAfter`
// is when the newest fix the library relies on landed: a copy installed before
// it is replaced at once, whatever its age.
export const WEBMIRROR_REQUIREMENT = {
  runtime: 'python',
  packages: [{ spec: 'webmirror[dynamic] @ https://github.com/DrFlGd/WebMirror/archive/refs/heads/main.zip', import: 'webmirror', refreshHours: 24, refreshAfter: '2026-10-28T03:40:00Z' }],
};

// Whether an installed package spec is due to be installed again.
export function packageIsStale(pkg, installedAt, now = Date.now()) {
  if (!installedAt) return false;
  const installed = Date.parse(installedAt);
  const after = Date.parse(pkg.refreshAfter ?? '');
  if (installed < after && now >= after) return true;
  return Boolean(pkg.refreshHours) && now - installed > pkg.refreshHours * 3600 * 1000;
}

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

export function createRuntimes({ library, fetchImpl = globalThis.fetch, spawnImpl = spawn, download, platform = process.platform, arch = process.arch }) {
  // Read on every call: the data folder can move (Settings) while the app runs.
  const root = () => path.join(library.dataDir, 'runtimes');
  const pythonDir = () => path.join(root(), 'python');
  const nodeDir = () => path.join(root(), 'node');

  function managed(name = 'python') {
    return library.state.runtimes?.[name] ?? null;
  }

  async function saveManaged(record, name = 'python') {
    library.state.runtimes = { ...(library.state.runtimes ?? {}), [name]: record };
    if (!record) delete library.state.runtimes[name];
    await library.save();
  }

  // Records store absolute paths; after the data folder moves they are rebuilt
  // from the folder the runtime now lives in.
  function relocated(record, name) {
    if (!record) return null;
    const dir = name === 'node' ? nodeDir() : pythonDir();
    if (record.dir === dir) return record;
    return name === 'node' ? { ...record, dir, ...nodePaths(dir, platform) } : { ...record, dir, executable: pythonExecutable(dir, platform) };
  }

  async function installNode({ log = () => {}, progress = () => {} } = {}) {
    const name = nodeArchiveName(platform, arch);
    const base = `${NODE_BUILD.base}/v${NODE_BUILD.version}`;
    log(`Looking up Node.js ${NODE_BUILD.version}`);
    const sumsRes = await fetchImpl(`${base}/SHASUMS256.txt`);
    if (!sumsRes.ok) throw new Error(`Could not read the Node.js checksums (HTTP ${sumsRes.status})`);
    const expected = findSum(await sumsRes.text(), name);
    if (!expected) throw new Error(`No checksum for ${name}`);

    await fs.mkdir(root(), { recursive: true });
    const archive = path.join(library.downloadsDir, name);
    const staging = path.join(root(), 'node.staging');
    try {
      log(`Downloading Node.js ${NODE_BUILD.version}`);
      await download(`${base}/${name}`, archive, { onProgress: (p) => progress({ message: `Downloading Node.js ${NODE_BUILD.version}`, ...p }) });
      if ((await sha256(archive)) !== expected) throw new Error('The Node.js download did not match its published checksum');
      log('Unpacking Node.js');
      progress({ message: 'Unpacking Node.js' });
      await fs.rm(staging, { recursive: true, force: true });
      // Both archives hold one top-level node-v<version>-<os>-<arch>/ folder.
      if (name.endsWith('.zip')) await extractZip(archive, staging, { strip: 1 });
      else await extractTarGz(archive, staging, { strip: 1, modes: true, symlinks: true });
      await fs.rm(nodeDir(), { recursive: true, force: true });
      await fs.rename(staging, nodeDir());
    } finally {
      await fs.rm(archive, { force: true });
      await fs.rm(staging, { recursive: true, force: true });
    }
    const record = { version: NODE_BUILD.version, dir: nodeDir(), ...nodePaths(nodeDir(), platform), installedAt: new Date().toISOString() };
    await run(record.node, ['--version'], { spawnImpl });
    await saveManaged(record, 'node');
    log(`Node.js ${NODE_BUILD.version} ready`);
    return record;
  }

  async function ensureNode(hooks = {}) {
    let record = relocated(managed('node'), 'node');
    if (record && record.version !== NODE_BUILD.version) record = null;
    if (record) {
      try {
        await fs.access(record.node);
        await fs.access(record.npmCli);
      } catch {
        record = null;
      }
    }
    if (!record) {
      hooks.log?.('Node.js is not installed for the library yet; installing a private copy (about 30 MB, once).');
      record = await installNode(hooks);
    }
    return record;
  }

  async function installPython({ log = () => {}, progress = () => {} } = {}) {
    const triple = pythonTriple();
    log(`Looking up Python ${PYTHON_BUILD.minor} for ${triple}`);
    const sumsRes = await fetchImpl(`${PYTHON_BUILD.base}/${PYTHON_BUILD.tag}/SHA256SUMS`);
    if (!sumsRes.ok) throw new Error(`Could not read the Python build list (HTTP ${sumsRes.status})`);
    const asset = findPythonAsset(await sumsRes.text(), { triple });
    if (!asset) throw new Error(`No Python ${PYTHON_BUILD.minor} build for ${triple} in release ${PYTHON_BUILD.tag}`);

    await fs.mkdir(root(), { recursive: true });
    const archive = path.join(library.downloadsDir, asset.name);
    const staging = path.join(root(), 'python.staging');
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
      await fs.rm(pythonDir(), { recursive: true, force: true });
      await fs.rename(staging, pythonDir());
    } finally {
      await fs.rm(archive, { force: true });
      await fs.rm(staging, { recursive: true, force: true });
    }
    const executable = pythonExecutable(pythonDir(), platform);
    await run(executable, ['--version'], { spawnImpl });
    const record = { version: asset.version, tag: PYTHON_BUILD.tag, dir: pythonDir(), executable, packages: {}, installedAt: new Date().toISOString() };
    await saveManaged(record);
    log(`Python ${asset.version} ready`);
    return record;
  }

  async function installPackages(record, packages, { log = () => {}, progress = () => {} } = {}) {
    const missing = packages.filter((p) => !record.packages?.[p.spec]);
    const stale = packages.filter((p) => record.packages?.[p.spec] && packageIsStale(p, record.packages[p.spec]));
    if (!missing.length && !stale.length) return record;
    const name = (p) => p.import || p.spec.split(/[\s@[]/)[0];
    const pip = (args) =>
      run(record.executable, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...args], {
        spawnImpl,
        env: { PIP_NO_WARN_SCRIPT_LOCATION: '1' },
        onLine: (line) => {
          if (/^(Collecting|Downloading|Installing|Successfully|Building|ERROR)/.test(line.trim())) log(line.trim());
        },
      });
    const next = { ...record, packages: { ...(record.packages ?? {}) } };
    if (missing.length) {
      progress({ message: `Installing ${missing.map(name).join(', ')}` });
      await pip(['--upgrade', ...missing.map((p) => p.spec)]);
      for (const p of missing) next.packages[p.spec] = new Date().toISOString();
    }
    if (stale.length) {
      progress({ message: `Updating ${stale.map(name).join(', ')}` });
      try {
        // The same version number can hold new code on a branch, so reinstall the
        // package itself; then let pip add any dependency it now needs.
        await pip(['--force-reinstall', '--no-deps', ...stale.map((p) => p.spec)]);
        await pip(stale.map((p) => p.spec));
        for (const p of stale) next.packages[p.spec] = new Date().toISOString();
      } catch (error) {
        // Offline, or the source is down: the installed copy still works.
        log(`Could not update ${stale.map(name).join(', ')}; using the installed copy (${error.message.slice(0, 160)})`);
      }
    }
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
    let record = relocated(managed(), 'python');
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
      if (req.runtime === 'node') out.node = await ensureNode(hooks);
    }
    return out;
  }

  async function remove(name = 'python') {
    await fs.rm(name === 'node' ? nodeDir() : pythonDir(), { recursive: true, force: true });
    await saveManaged(null, name);
  }

  function status() {
    const record = relocated(managed(), 'python');
    const node = relocated(managed('node'), 'node');
    return {
      node: { managed: node ? { version: node.version, dir: node.dir } : null, build: NODE_BUILD.version },
      python: {
        configured: library.state.settings.pythonPath || '',
        managed: record ? { version: record.version, dir: record.dir, packages: Object.keys(record.packages ?? {}) } : null,
        build: `${PYTHON_BUILD.minor} (${PYTHON_BUILD.tag})`,
      },
    };
  }

  return { ensure, ensurePython, ensureNode, installPython, installNode, installPackages, remove, status };
}
