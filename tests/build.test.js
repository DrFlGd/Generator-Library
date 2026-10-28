import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildProject, installSteps, stepCommand } from '../src/lib/build.js';
import { normalizeManifest } from '../src/lib/manifest.js';
import { findSum, nodeArchiveName, nodePaths } from '../src/lib/runtimes.js';
import { Library } from '../src/lib/library.js';
import { installDistribution } from '../src/lib/installer.js';

const node = { node: '/rt/node/bin/node', npmCli: '/rt/npm-cli.js', npxCli: '/rt/npx-cli.js', binDir: '/rt/node/bin' };

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'genlib-build-'));
}

// A spawn stand-in that records each command and can fail some of them.
function fakeSpawn({ fail = () => false, onRun = async () => {} } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push({ command, args, options });
    setImmediate(async () => {
      await onRun(args, options);
      child.stdout.emit('data', Buffer.from(`\u001b[32mran ${args.slice(1).join(' ')}\u001b[39m\n`));
      child.emit('exit', fail(args) ? 1 : 0);
    });
    return child;
  };
  return { calls, spawnImpl };
}

test('build steps run through the private Node.js without a shell', () => {
  assert.deepEqual(stepCommand(['npm', 'run', 'build'], node), { command: node.node, args: [node.npmCli, 'run', 'build'] });
  assert.deepEqual(stepCommand(['npx', 'vite', 'build'], node), { command: node.node, args: [node.npxCli, '--yes', 'vite', 'build'] });
  assert.deepEqual(stepCommand(['node', 'x.js'], node), { command: node.node, args: ['x.js'] });
  assert.throws(() => stepCommand(['sh', '-c', 'rm'], node), /npm, npx or node/);
});

test('installSteps uses npm ci with a lock file and never runs install scripts by default', async () => {
  const dir = await tmp();
  assert.deepEqual(await installSteps(dir, {}), []);
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  const [plain] = await installSteps(dir, {});
  assert.deepEqual(plain.step.slice(0, 3), ['npm', 'install', '--ignore-scripts']);
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
  const [locked] = await installSteps(dir, {});
  assert.deepEqual(locked.step.slice(0, 3), ['npm', 'ci', '--ignore-scripts']);
  assert.equal(locked.fallback[1], 'install');
  const [scripts] = await installSteps(dir, { installScripts: true });
  assert.ok(!scripts.step.includes('--ignore-scripts'));
});

test('installSteps installs a pnpm workspace or catalog project with its own pnpm', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { vite: 'catalog:' }, packageManager: 'pnpm@10.33.0+sha512.abc' }));
  await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
  const [pnpm] = await installSteps(dir, {});
  assert.deepEqual(pnpm.step, ['npx', '-p', 'pnpm@10.33.0', 'pnpm', 'install', '--ignore-scripts', '--frozen-lockfile']);
  assert.equal(pnpm.fallback.at(-1), '--no-frozen-lockfile');
  // A plain pnpm project that npm can read stays with npm.
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { vite: '^6' } }));
  assert.equal((await installSteps(dir, {}))[0].step[0], 'npm');
  await fs.writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []');
  assert.deepEqual((await installSteps(dir, {}))[0].step.slice(0, 3), ['npx', '-p', 'pnpm@10']);
});

test('buildProject installs, falls back from a stale lock file, builds and returns the output', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
  const { calls, spawnImpl } = fakeSpawn({
    fail: (args) => args[1] === 'ci',
    onRun: async (args) => {
      if (args.includes('build')) await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    },
  });
  const lines = [];
  const out = await buildProject(dir, { output: 'dist', steps: [['npx', 'vite', 'build']], env: { VITE_X: '1' } }, { node, spawnImpl, onLine: (l) => lines.push(l), env: { PATH: '/usr/bin' } });
  assert.equal(out, path.join(dir, 'dist'));
  assert.deepEqual(calls.map((c) => c.args[1]), ['ci', 'install', '--yes']);
  assert.ok(calls.every((c) => c.options.cwd === dir));
  assert.ok(calls[2].options.env.PATH.startsWith(node.binDir));
  assert.equal(calls[2].options.env.VITE_X, '1');
  assert.ok(lines.some((l) => l.includes('lock file does not match')));
  assert.ok(lines.every((l) => !l.includes('\u001b')), 'colour codes are stripped');
});

test('buildProject reports a failed step and a missing output', async () => {
  const dir = await tmp();
  const failing = fakeSpawn({ fail: (args) => args.includes('build') });
  await assert.rejects(buildProject(dir, { output: 'dist', steps: [['npm', 'run', 'build']], env: {} }, { node, spawnImpl: failing.spawnImpl, env: {} }), /Build failed \(npm run build\)/);
  const quiet = fakeSpawn();
  await assert.rejects(buildProject(dir, { output: 'dist', steps: [['npm', 'run', 'build']], env: {} }, { node, spawnImpl: quiet.spawnImpl, env: {} }), /no "dist" folder/);
});

test('build recipes are validated and pull in Node.js', () => {
  const base = { id: 'a', name: 'A', repo: 'o/r' };
  const ok = normalizeManifest({ ...base, distributions: [{ kind: 'bundle', from: { type: 'repo' }, build: { steps: [['npx', 'vite', 'build']] } }] });
  assert.deepEqual(ok.errors, []);
  const dist = ok.manifest.distributions[0];
  assert.deepEqual(dist.build, { output: 'dist', steps: [['npx', 'vite', 'build']], env: {}, installScripts: false });
  assert.deepEqual(dist.requires, [{ runtime: 'node' }]);
  assert.equal(dist.label, 'Build offline copy');
  const bad = normalizeManifest({ ...base, distributions: [{ kind: 'bundle', from: { type: 'release', asset: 'x.zip' }, build: { output: '../x', steps: [['bash', 'build.sh']] } }] });
  assert.ok(bad.errors.some((e) => e.includes('repo "from"')));
  assert.ok(bad.errors.some((e) => e.includes('build.output')));
  assert.ok(bad.errors.some((e) => e.includes('npm, npx, node')));
});

test('Node.js archives and paths per platform', () => {
  assert.equal(nodeArchiveName('win32', 'x64', '24.0.0'), 'node-v24.0.0-win-x64.zip');
  assert.equal(nodeArchiveName('linux', 'arm64', '24.0.0'), 'node-v24.0.0-linux-arm64.tar.gz');
  assert.throws(() => nodeArchiveName('sunos', 'x64'), /No Node.js build/);
  assert.equal(nodePaths('/n', 'linux').node, path.join('/n', 'bin', 'node'));
  assert.equal(nodePaths('C:/n', 'win32').npmCli, path.join('C:/n', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const sums = `${'a'.repeat(64)}  node-v24.0.0-win-x64.zip\n${'b'.repeat(64)}  node-v24.0.0-linux-x64.tar.gz\n`;
  assert.equal(findSum(sums, 'node-v24.0.0-linux-x64.tar.gz'), 'b'.repeat(64));
  assert.equal(findSum(sums, 'nope'), null);
});

test('installing a build distribution builds the repository and hosts its output', async () => {
  const dir = await tmp();
  const library = new Library(path.join(dir, 'data'));
  await library.load();
  const tree = path.join(dir, 'o-app-abc');
  await fs.mkdir(path.join(tree, 'src'), { recursive: true });
  await fs.writeFile(path.join(tree, 'package.json'), '{}');
  await fs.writeFile(path.join(tree, 'src', 'main.js'), 'source');
  const tarPath = path.join(dir, 'repo.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', dir, 'o-app-abc']);
  const github = {
    latestCommit: async () => ({ sha: 'abcdef1234567890', date: '', ref: 'main' }),
    tarballUrl: () => 'tarball://x',
    download: async (url, dest) => fs.copyFile(tarPath, dest),
  };
  const { manifest } = normalizeManifest({ id: 'app', name: 'App', repo: 'o/app', distributions: [{ kind: 'bundle', from: { type: 'repo' }, build: {} }] });
  let sourceSeen = '';
  const builder = async (sourceDir, build, { onLine }) => {
    sourceSeen = await fs.readFile(path.join(sourceDir, 'src', 'main.js'), 'utf8');
    onLine('building');
    await fs.mkdir(path.join(sourceDir, build.output, 'assets'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, build.output, 'index.html'), '<h1>built</h1>');
    return path.join(sourceDir, build.output);
  };
  const messages = [];
  const record = await installDistribution(manifest, manifest.distributions[0], { library, github, builder, onProgress: (p) => messages.push(p.message) });
  assert.equal(sourceSeen, 'source');
  assert.equal(record.entry, 'index.html');
  assert.equal(record.built, true);
  assert.equal(await fs.readFile(path.join(record.dir, 'index.html'), 'utf8'), '<h1>built</h1>');
  assert.deepEqual((await fs.readdir(path.dirname(record.dir))).sort(), [path.basename(record.dir)], 'source folder removed');
  assert.ok(messages.includes('building'));
  await assert.rejects(installDistribution(manifest, manifest.distributions[0], { library, github }), /Building from source is not available/);
});
