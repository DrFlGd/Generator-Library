// Build a web app from its repository with the library's private Node.js, for
// apps that publish no download and that a web mirror cannot capture whole
// (a WebAssembly engine loaded on demand, a site that blocks crawlers).
//
// The steps come from the manifest's `build` (manifest.js normalizeBuild): npm's
// dependency install first, then each step, then the `output` folder is what the
// library hosts. Dependency install scripts are skipped unless the manifest asks
// for them, so installing packages runs no code of theirs; the build steps do run
// the project's own build tooling.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const INSTALL_FLAGS = ['--no-audit', '--no-fund', '--loglevel=error'];
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// The program and arguments for one step, run through the private Node.js:
// "npm" and "npx" are npm's own scripts, so no npm.cmd or shell is needed.
export function stepCommand(step, node) {
  const [tool, ...args] = step;
  if (tool === 'npm') return { command: node.node, args: [node.npmCli, ...args] };
  if (tool === 'npx') return { command: node.node, args: [node.npxCli, '--yes', ...args] };
  if (tool === 'node') return { command: node.node, args };
  throw new Error(`Build steps run npm, npx or node, not "${tool}"`);
}

// npm ci needs a lock file that matches package.json; some projects let theirs
// drift, so a failed ci falls back to npm install. A pnpm workspace, or a project
// whose package.json uses pnpm's own "catalog:" or "workspace:" versions, which
// npm cannot read, is installed with the pnpm version it names, fetched by npx.
export async function installSteps(dir, build) {
  const has = (file) => fs.access(path.join(dir, file)).then(() => true, () => false);
  if (!(await has('package.json'))) return [];
  const scripts = build.installScripts ? [] : ['--ignore-scripts'];
  if ((await has('pnpm-lock.yaml')) && !(await has('package-lock.json'))) {
    let pkg = {};
    try {
      pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      /* npm reports a broken package.json itself */
    }
    const versions = Object.values({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
    if ((await has('pnpm-workspace.yaml')) || versions.some((v) => /^(catalog|workspace):/.test(String(v)))) {
      const version = /^pnpm@(\d[\w.-]*)/.exec(pkg.packageManager ?? '')?.[1] ?? '10';
      const pnpm = ['npx', '-p', `pnpm@${version}`, 'pnpm', 'install', ...scripts];
      return [{ step: [...pnpm, '--frozen-lockfile'], fallback: [...pnpm, '--no-frozen-lockfile'] }];
    }
  }
  const install = ['npm', 'install', ...scripts, ...INSTALL_FLAGS];
  if (await has('package-lock.json')) return [{ step: ['npm', 'ci', ...scripts, ...INSTALL_FLAGS], fallback: install }];
  return [{ step: install }];
}

function runStep({ command, args }, { cwd, env, onLine, spawnImpl }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const tail = [];
    const feed = (chunk) => {
      // Build tools colour their output; the Jobs log is plain text.
      for (const line of chunk.toString().replace(ANSI, '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 30) tail.shift();
        onLine(line);
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(`exit ${code}: ${tail.slice(-4).join(' ')}`), { tail }))));
  });
}

// Build `dir` (an unpacked repository) and return the absolute output folder.
export async function buildProject(dir, build, { node, onLine = () => {}, spawnImpl = spawn, env: baseEnv = process.env } = {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(baseEnv).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const env = {
    ...baseEnv,
    // Scripts that call `node` or `npm` find the private copies first.
    [pathKey]: `${node.binDir}${sep}${baseEnv[pathKey] ?? ''}`,
    npm_config_update_notifier: 'false',
    CI: 'true',
    NO_COLOR: '1',
    ...build.env,
  };
  const run = async (step, label) => {
    onLine(`> ${step.join(' ')}`);
    try {
      await runStep(stepCommand(step, node), { cwd: dir, env, onLine, spawnImpl });
    } catch (error) {
      throw new Error(`${label} failed (${step.join(' ')}): ${error.message}`);
    }
  };
  for (const { step, fallback } of await installSteps(dir, build)) {
    try {
      await run(step, 'Installing dependencies');
    } catch (error) {
      if (!fallback) throw error;
      onLine('The lock file does not match package.json; installing without it');
      await run(fallback, 'Installing dependencies');
    }
  }
  for (const step of build.steps) await run(step, 'Build');
  const output = path.join(dir, build.output);
  try {
    if (!(await fs.stat(output)).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new Error(`The build finished but made no "${build.output}" folder`);
  }
  return output;
}
