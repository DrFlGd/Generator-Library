#!/usr/bin/env bash
# Build an offline page for MartynAllen/bahtinov-mask-generator. The repository
# is the mask engine only (TypeScript that turns a telescope's sizes into an
# STL); its own page lives on the author's site. bahtinov-mask/ is a small page
# for it: esbuild bundles that page's script with the engine and its two
# packages into one file. Run from the upstream checkout; writes "$OUT".
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
npm ci --ignore-scripts --no-audit --no-fund
cp "$here/bahtinov-mask/app.js" ./library-page.js
mkdir -p "$OUT"
npx --yes esbuild@0.25.12 library-page.js --bundle --format=esm --target=es2020 --minify --legal-comments=eof --outfile="$OUT/app.js"
cp "$here/bahtinov-mask/index.html" "$here/bahtinov-mask/style.css" "$OUT/"
cp LICENSE "$OUT/LICENSE-engine.txt"
