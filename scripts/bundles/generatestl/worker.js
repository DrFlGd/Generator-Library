// Runs GenerateSTL's Python engine with Pyodide (Python built for WebAssembly),
// away from the page so the form stays responsive while a part is made.
// Everything it loads sits beside it: Pyodide, pydantic and the engine.
/* global loadPyodide */
importScripts('pyodide/pyodide.js');

async function load(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}

const ready = (async () => {
  const pyodide = await loadPyodide({ indexURL: new URL('pyodide/', self.location.href).href });
  await pyodide.loadPackage('pydantic', { messageCallback: () => {} });
  const [engine, glue] = await Promise.all([load('engine.zip'), load('engine.py')]);
  pyodide.unpackArchive(await engine.arrayBuffer(), 'zip', { extractDir: '/engine' });
  pyodide.FS.writeFile('/engine/library_page.py', await glue.text());
  pyodide.runPython("import sys; sys.path.insert(0, '/engine')");
  return pyodide.pyimport('library_page');
})();

ready.then(
  () => postMessage({ ready: true }),
  (error) => postMessage({ failed: String(error?.message ?? error) }),
);

// Python bytes arrive as a Uint8Array, or as a proxy to copy out of. A single
// STL is both the file and its one part, so the same value can come twice.
function copier() {
  const copied = new Map();
  return (value) => {
    if (value instanceof Uint8Array) return value;
    if (copied.has(value)) return copied.get(value);
    const view = value.getBuffer('u8');
    try {
      copied.set(value, view.data.slice());
    } finally {
      view.release();
    }
    return copied.get(value);
  };
}

self.onmessage = async ({ data: { id, payload } }) => {
  try {
    const engine = await ready;
    const proxy = engine.generate(JSON.stringify(payload));
    const result = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy();
    if (result.errors) {
      postMessage({ id, errors: result.errors });
      return;
    }
    const bytes = copier();
    const data = bytes(result.data);
    const parts = result.parts.map(([name, stl]) => ({ name, data: bytes(stl) }));
    const buffers = new Set([data.buffer, ...parts.map((p) => p.data.buffer)]);
    postMessage({ id, name: result.name, data, parts }, [...buffers]);
  } catch (error) {
    postMessage({ id, errors: [{ fields: [], message: String(error?.message ?? error) }] });
  }
};
