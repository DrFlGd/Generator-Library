#!/usr/bin/env bash
# Build vostoklabs/vostoklabs.github.io the way its own Pages deploy does: run
# the `run` steps of its deploy workflow's build job in order (install, each
# app's build, each copy into the hub), so apps it adds later come along. Run
# from the upstream checkout; writes the hub folder to "$OUT".
set -euo pipefail
corepack enable
export VITE_BUILD_ID="$(git rev-parse HEAD)"
workflow=.github/workflows/deploy.yml
count=$(yq '[.jobs.build.steps[] | select(has("run"))] | length' "$workflow")
for i in $(seq 0 $((count - 1))); do
  step=$(mktemp)
  yq "[.jobs.build.steps[] | select(has(\"run\"))] | .[$i].run" "$workflow" > "$step"
  echo "::group::$(head -1 "$step")"
  bash -euo pipefail "$step"
  echo "::endgroup::"
done
find apps/hub/dist -name '*.map' -delete
cp -r apps/hub/dist "$OUT"
