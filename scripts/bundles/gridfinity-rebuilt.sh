#!/usr/bin/env bash
# Build kennetek/gridfinity-rebuilt-openscad for the library: openscad/openscad-playground
# with this library added to its bundled OpenSCAD libraries, plus a start page that opens
# one of the library's generators with the Customizer showing. Run from the
# gridfinity-rebuilt-openscad checkout; writes "$OUT".
set -euo pipefail
LIB=$PWD
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d)
git clone --quiet --depth 1 https://github.com/openscad/openscad-playground "$WORK/playground"
cd "$WORK/playground"

# The playground zips each library from libs/<name>, cloning it only when missing, so
# the checkout being built is the one that ships.
mkdir -p libs
cp -r "$LIB" libs/gridfinity-rebuilt
node "$HERE/gridfinity-rebuilt/add-library.mjs"

npm install --no-audit --no-fund
npm run build:all
find dist -name '*.map' -delete
cp -r dist "$OUT"

# The generators open from the site root, where "src/..." includes reach the library
# through the symlink add-library.mjs declares.
cp "$LIB"/*.scad "$OUT/"
cp "$LIB/LICENSE" "$OUT/gridfinity-rebuilt-LICENSE.txt"
cp "$HERE/gridfinity-rebuilt/start.html" "$OUT/gridfinity.html"

# Render each generator offline in Chromium before it ships.
export PLAYWRIGHT_DIR=$WORK/check
mkdir -p "$PLAYWRIGHT_DIR"
(cd "$PLAYWRIGHT_DIR" && npm install --no-audit --no-fund --silent playwright@1.56.1 \
  && npx playwright install --with-deps chromium > /dev/null)
node "$HERE/gridfinity-rebuilt/check.mjs" "$OUT"
