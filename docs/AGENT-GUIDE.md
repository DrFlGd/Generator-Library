# Adding a repository to Generator Library: instructions for agents

You are working in a repository that holds one or more model generators (web apps or desktop apps that make files for 3D printing, laser cutting and the like). Your job is to add the manifest that lets [Generator Library](https://github.com/DrFlGd/Generator-Library) list, install, launch and update them. Follow these steps in order. The full reference is [MANIFEST.md](MANIFEST.md); the schema is <https://raw.githubusercontent.com/DrFlGd/Generator-Library/main/schema/generator.schema.json>.

## 1. Decide which file to write

- **One generator in the repository** → `generator.json` at the repository root.
- **Several generators** (a monorepo, `apps/*`, one app with several separate tools) → `generator-library.json` at the root, listing each one. Give each its own `apps/<name>/generator.json` and point at it with `{ "path": "apps/<name>/generator.json" }`, or write the entry inline. Shared values (`process`, `license`, tags) go in `defaults`.
- If the repository already keeps a registry of its tools (for example a `generators.json`), **generate the manifests from it with a script** and add a CI check that fails when they are out of date, rather than writing them by hand. Then adding a tool to the registry is enough.

The file must be on the default branch: the library reads it from there on every catalog refresh.

## 2. Fill in what the generator is

```json
{
  "$schema": "https://raw.githubusercontent.com/DrFlGd/Generator-Library/main/schema/generator.schema.json",
  "id": "my-generator",
  "name": "My Generator",
  "summary": "One sentence: what it makes.",
  "description": "Optional longer text.",
  "tags": ["boxes", "organizer"],
  "process": "3d-print",
  "license": "MIT",
  "icon": "public/icon.png",
  "screenshots": ["docs/screenshot.png"],
  "homepage": "https://example.github.io/my-generator/",
  "distributions": []
}
```

- `id`: lowercase letters, digits and dashes, at most 64 characters. It names install folders and saved favourites, so **never rename an existing id**.
- `process`: one of `3d-print`, `laser`, `cnc`, `tool`.
- `tags`: a few lowercase words people would filter by. Reuse common ones (`boxes`, `organizer`, `keychains`, `signs`, `gridfinity`, `lithophane`, `fidgets`…).
- `icon` and `screenshots`: paths in the repository or `https://` URLs.
- `license`: an SPDX id taken from the repository's LICENSE file. Do not guess one.
- For a fork, add `"upstream": "owner/original-repo"`.

## 3. List every way to run it, best offline option first

Choose distributions in this order of preference. Include every option that applies.

1. **`web`** whenever the generator is hosted: `{ "kind": "web", "url": "https://…" }`. Add a second `web` entry with its own `label` for a MakerWorld or similar listing.
2. **An offline copy from a release** (fastest to install). If the repository publishes a static web build as a release asset, or you can add a workflow that does:
   ```json
   { "kind": "bundle", "from": { "type": "release", "tag": "v*", "asset": "my-generator-web-*.zip" }, "spa": true }
   ```
3. **An offline copy built from source** when there is no release build but the repository has a `package.json` with a build script:
   ```json
   { "kind": "bundle", "from": { "type": "repo" }, "build": { "output": "dist", "steps": [["npx", "vite", "build"]] }, "spa": true }
   ```
   - `steps` are argument lists starting with `npm`, `npx` or `node`; no shell. Call the bundler directly (`["npx", "vite", "build"]`, `["npx", "webpack", "--mode=production"]`) instead of `npm run build` when that script uses `&&`, type checks, or `VAR=value` prefixes. Put environment variables in `"env"`.
   - `output` is the folder the build writes (`dist` for Vite, `build` for Create React App).
   - For a subfolder of a monorepo, set `"from": { "type": "repo", "path": "apps/my-generator" }`.
   - Leave `installScripts` off unless the build fails without dependency install scripts.
   - If the build needs anything besides Node.js (git, `zip`, a shell script, pnpm or yarn, Python), it cannot run on the user's computer. Add a workflow that builds it and publishes a release zip (option 2). For a repository you do not control, add a `scripts/bundles/<id>.sh` to Generator Library instead; its `library-bundles.yml` builds it daily and publishes `<id>-<commit>` pre-releases, which the entry installs with `{ "type": "release", "repo": "DrFlGd/Generator-Library", "tag": "<id>-*", "asset": "<id>-web-*.zip", "prerelease": true }`. A static site that loads its libraries from jsDelivr goes the same way: `scripts/bundles/vendor-cdn.mjs` downloads them into the bundle and points the site at the copies (see `bumpmesh.sh`).
4. **A static site committed in the repository** (plain HTML, no build): `{ "kind": "bundle", "from": { "type": "repo", "path": "site" } }`.
5. **Desktop apps** from releases, one entry per platform:
   ```json
   { "kind": "exe", "platform": "windows", "install": "installer", "from": { "type": "release", "tag": "desktop-v*", "asset": "*-setup.exe" } }
   ```
   `install` is `portable` (run the file), `installer` (run once to install), or `zip` (unpack and run `exec`, the path inside the archive).
6. **`mirror` only as a last resort**, for a hosted site with no source to build: `{ "kind": "mirror", "url": "https://…" }`. A mirror misses whatever the page loads on demand (WebAssembly engines, models, fonts), and some sites block it.

Rules for every offline copy:

- The web build must use **relative asset paths** (`base: './'` in Vite) or work from `/`. The library serves it from `http://127.0.0.1:<port>/`, not from a `/<repo>/` subpath.
- Use `"spa": true` when the app uses client-side routing.
- If the app needs a Python package at run time, add `"requires": [{ "runtime": "python", "packages": ["…"] }]`.
- Use one stable tag pattern per kind of release (`v*` for web, `desktop-v*` for desktop) so the globs keep matching.

## 4. Check it

1. The JSON must be valid against the schema. Most editors check it through `$schema`.
2. If you described a build from source, run it from a clean clone exactly as the library will: `npm ci --ignore-scripts` (or `npm install --ignore-scripts`), then each step. Confirm that `output` contains `index.html`.
3. Serve the output from its root (`npx serve dist`) and open it. Check that it loads with no 404s for scripts, styles, `.wasm` files or fonts.
4. Commit the manifest to the default branch.

## 5. Get it listed

- The repository owner can add it to the shared catalog by adding `{ "repo": "owner/name" }` to [`catalog/catalog.json`](../catalog/catalog.json) in Generator Library and running `npm run sync:fallbacks` there.
- Anyone can add it to their own library under **Manage → Add a project** with `owner/name`.

## Do not

- Do not invent download URLs, release tags or asset names. Look at the repository's actual releases and workflows.
- Do not mirror a site that can be built from source.
- Do not link a web edition that shows sign-in, licence or pricing prompts when an offline or standalone build exists. Prefer the build the library can run offline.
