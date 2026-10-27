// WebMirror integration. WebMirror (DrFlGd/WebMirror) is a Python app whose
// engine captures a live site into a folder with a manifest.json and a routes
// file. The library drives that engine headlessly for `mirror` distributions and
// can list snapshots WebMirror already made, so both tools share one collection.
//
// Nothing here requires WebMirror to change: we import its package and call
// MirrorEngine the same way its GUI does.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultWebMirrorHome() {
  return process.env.WEBMIRROR_HOME || path.join(os.homedir(), '.webmirror');
}

export const MIRROR_SCRIPT = `
import json, sys
from webmirror.core import MirrorEngine, MirrorLibrary
args = json.loads(sys.argv[1])
library = MirrorLibrary(args.get("home") or None)
def progress(message):
    print(json.dumps({"progress": message}), flush=True)
engine = MirrorEngine(library, progress=progress,
                      include_pages_files=bool(args.get("githubPagesFiles")),
                      browser_capture=bool(args.get("browserCapture")))
record = engine.mirror(args["url"])
print(json.dumps({"record": record.__dict__, "dir": str(library.path(record))}), flush=True)
`;

export function pythonCandidates(configured = '') {
  const list = [];
  if (configured) list.push(configured);
  if (process.platform === 'win32') list.push('py', 'python', 'python3');
  else list.push('python3', 'python');
  return list;
}

// Run `python -c "import webmirror"` to find an interpreter that has the package.
export async function findPython(configured = '', { spawnImpl = spawn } = {}) {
  for (const candidate of pythonCandidates(configured)) {
    const ok = await new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(candidate, ['-c', 'import webmirror'], { stdio: 'ignore', windowsHide: true });
      } catch {
        resolve(false);
        return;
      }
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    if (ok) return candidate;
  }
  return null;
}

export function parseMirrorOutput(lines) {
  const messages = [];
  let result = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const data = JSON.parse(trimmed);
      if (data.progress) messages.push(data.progress);
      if (data.record) result = data;
    } catch {
      /* not one of ours */
    }
  }
  return { messages, result };
}

// `interpreter` is a Python the caller already knows can import webmirror (the
// library's runtime manager provides one); without it, PATH is searched.
export async function mirrorSite({ url, githubPagesFiles = false, browserCapture = true, home = '', python = '', interpreter: given = '', onProgress = () => {}, spawnImpl = spawn }) {
  const interpreter = given || (await findPython(python, { spawnImpl }));
  if (!interpreter) {
    throw new Error('WebMirror is not available: install Python 3.10+ and `pip install git+https://github.com/DrFlGd/WebMirror`, or set the Python path in Settings.');
  }
  const args = JSON.stringify({ url, githubPagesFiles, browserCapture, home: home || defaultWebMirrorHome() });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(interpreter, ['-c', MIRROR_SCRIPT, args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    let result = null;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      const parsed = parseMirrorOutput(lines);
      for (const message of parsed.messages) onProgress(message);
      if (parsed.result) result = parsed.result;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      const tail = parseMirrorOutput([buffer]);
      if (tail.result) result = tail.result;
      if (code === 0 && result) resolve(result);
      else reject(new Error(stderr.trim().split('\n').pop() || `WebMirror exited with code ${code}`));
    });
  });
}

// Snapshots WebMirror has saved, newest first, mirroring MirrorLibrary.list().
export async function listWebMirrorSnapshots(home = '') {
  const dir = path.join(home || defaultWebMirrorHome(), 'mirrors');
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, entry.name, 'manifest.json'), 'utf8'));
      if (record.key !== entry.name) continue;
      const entryFile = path.join(dir, entry.name, String(record.entry ?? 'index.html').replace(/^\/+/, ''));
      await fs.access(entryFile);
      out.push({ ...record, dir: path.join(dir, entry.name) });
    } catch {
      /* not a snapshot */
    }
  }
  out.sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1));
  return out;
}
