#!/usr/bin/env bash
# Build openscad/openscad-playground for the library: the WebAssembly OpenSCAD,
# the bundled OpenSCAD libraries and fonts, and the app itself. Its library step
# clones each library with git and zips it, which is why this runs in CI rather
# than on the user's computer. Run from the upstream checkout; writes "$OUT".
set -euo pipefail
npm install --no-audit --no-fund
npm run build:all
find dist -name '*.map' -delete
cp -r dist "$OUT"
