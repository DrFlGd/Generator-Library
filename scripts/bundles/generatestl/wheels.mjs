// Copy the Pyodide packages a page needs next to Pyodide, so it never reaches
// for the CDN. Usage: node wheels.mjs <pyodide dir> <version> <package>...
// Each package's dependencies come along, and every file is checked against
// the sha256 in pyodide-lock.json.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [dir, version, ...wanted] = process.argv.slice(2);
const lock = JSON.parse(await fs.readFile(path.join(dir, 'pyodide-lock.json'), 'utf8'));
const key = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
const packages = new Map(Object.values(lock.packages).map((p) => [key(p.name), p]));

const needed = new Map();
(function add(names) {
  for (const name of names) {
    const p = packages.get(key(name));
    if (!p) throw new Error(`${name} is not in Pyodide ${version}`);
    if (needed.has(key(p.name))) continue;
    needed.set(key(p.name), p);
    add(p.depends);
  }
})(wanted);

for (const p of needed.values()) {
  const url = `https://cdn.jsdelivr.net/pyodide/v${version}/full/${p.file_name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const sum = createHash('sha256').update(data).digest('hex');
  if (sum !== p.sha256) throw new Error(`${p.file_name}: checksum ${sum} is not ${p.sha256}`);
  await fs.writeFile(path.join(dir, p.file_name), data);
  console.log(`${p.file_name} (${(data.length / 1024).toFixed(0)} KB)`);
}
