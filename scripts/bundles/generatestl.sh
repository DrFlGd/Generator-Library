#!/usr/bin/env bash
# Build an offline page for nicremo/generatestl. The repository is the engine
# behind generatestl.com: Python that turns a part's sizes into an STL, which
# the site runs as a web service; the site's own pages are not published.
# generatestl/ is a page for it that runs the engine in the browser with
# Pyodide, so nothing is sent to a server and it works offline. esbuild bundles
# the page's script with three.js for the preview. Run from the upstream
# checkout; writes "$OUT".
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PYODIDE=0.29.5
tools=$(mktemp -d)
npm install --prefix "$tools" --no-audit --no-fund --loglevel=error "pyodide@$PYODIDE" three@0.180.0 esbuild@0.25.12

mkdir -p "$OUT/pyodide"
for f in pyodide.js pyodide.asm.js pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
  cp "$tools/node_modules/pyodide/$f" "$OUT/pyodide/"
done
node "$here/generatestl/wheels.mjs" "$OUT/pyodide" "$PYODIDE" pydantic

# The engine: the repository's app/ package, unpacked into Pyodide's files by worker.js.
zip -qr "$OUT/engine.zip" app -x '*/__pycache__/*' '*.pyc'
cp "$here/generatestl/engine.py" "$here/generatestl/worker.js" "$here/generatestl/index.html" "$here/generatestl/style.css" "$OUT/"
cp "$here/generatestl/app.js" "$here/generatestl/parts.js" "$tools/"
"$tools/node_modules/.bin/esbuild" "$tools/app.js" --bundle --format=esm --target=es2020 --minify --legal-comments=eof --outfile="$OUT/app.js"
cp LICENSE "$OUT/LICENSE-engine.txt"
cp "$tools/node_modules/three/LICENSE" "$OUT/LICENSE-three.txt"
echo "Pyodide $PYODIDE (https://github.com/pyodide/pyodide) is distributed under the Mozilla Public License 2.0: https://mozilla.org/MPL/2.0/" > "$OUT/LICENSE-pyodide.txt"
du -sh "$OUT"
