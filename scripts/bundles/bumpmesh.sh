#!/usr/bin/env bash
# Build CNCKitchen/stlTexturizer (BumpMesh) for offline use. The site is plain
# files with no build; it loads three.js, fflate and meshStep from jsDelivr.
# Copy the files its own Dockerfile serves, so files it adds later come along,
# then download those packages into the site with vendor-cdn.mjs. Run from the
# upstream checkout; writes the site to "$OUT".
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$OUT"
grep -E '^COPY +[^ ]+ +/usr/share/nginx/html/' Dockerfile | while read -r _ src dest; do
  target="$OUT/${dest#/usr/share/nginx/html/}"
  mkdir -p "$(dirname "$target")"
  cp -r "$src" "$target"
done
node "$here/vendor-cdn.mjs" "$OUT"
if grep -rIl 'cdn\.jsdelivr\.net/npm/' "$OUT" --include='*.html' --include='*.js' --exclude-dir=vendor; then
  echo "Some jsDelivr addresses were left"
  exit 1
fi
