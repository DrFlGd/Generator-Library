# The `generator.json` convention

One small file at the root of a repository tells Generator Library everything it needs to list a generator, open or install it, and keep it updated from GitHub. Repositories that hold several generators use `generator-library.json` instead (see [Collections](#collections)).

A JSON Schema for editors lives at [`schema/generator.schema.json`](../schema/generator.schema.json).

## Minimal example

```json
{
  "$schema": "https://raw.githubusercontent.com/DrFlGd/Generator-Library/main/schema/generator.schema.json",
  "id": "terrain-press",
  "name": "Terrain Press",
  "summary": "Turn real NASA elevation data into 3D-printable ornaments and jigsaw puzzles.",
  "tags": ["terrain", "ornament", "puzzle"],
  "process": "3d-print",
  "license": "AGPL-3.0-or-later",
  "icon": "site/favicon.png",
  "distributions": [
    { "kind": "web", "url": "https://ianbauters.github.io/terrain-press/" },
    { "kind": "bundle", "from": { "type": "repo", "path": "site" } },
    { "kind": "exe", "platform": "windows", "install": "portable",
      "from": { "type": "release", "tag": "desktop-v*", "asset": "Terrain-Press-*-Portable.exe" } }
  ]
}
```

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable slug: lowercase letters, digits, dashes. Install folders and favorites are keyed by it, so do not rename it casually. |
| `name` | yes | Display name. |
| `distributions` | yes | At least one way to run the generator (below). |
| `summary` | | One sentence for the card. |
| `description` | | Longer text for the detail view; newlines are kept. |
| `tags` | | Free-form, used for filters and search (`fidgets`, `boxes`, `keychains`…). |
| `process` | | What the output is for: `3d-print`, `laser`, `cnc`, `tool`. Shown as its own filter. |
| `category` | | One lowercase slug for the Category filter: `storage`, `mechanical`, `signs-text`, `ai-3d`, `cad`… |
| `pricing` | | `free`, `freemium` (free with paid extras) or `paid`. Shown as the Price filter. |
| `account` | | `true` when downloading needs a sign-up. |
| `exports` | | File types it makes, lowercase: `["stl", "3mf"]`. Shown as the Exports filter. |
| `openSource` | | Whether its source is published. Defaults to `true` when it has a `repo`. |
| `listing` | | The directory page it was imported from (set by the SkipTheCAD importer). |
| `icon`, `screenshots` | | Paths in the repository or `https://` URLs. Repository paths are loaded from the default branch. |
| `homepage`, `license`, `author`, `version` | | Informational. |
| `repo` | | `owner/name`; defaults to the repository the manifest was read from. |
| `upstream` | | For forks, the original repository (shown as a link). |
| `requires` | | Runtimes to install before the generator is installed or launched (below). Also allowed on a single distribution. |

## Distributions

Each entry has a `kind`; the rest depends on it.

### `web`: open a hosted page

```json
{ "kind": "web", "url": "https://vostoklabs.github.io/foldbox/", "label": "Open online" }
```

Opens in a sandboxed window inside the library with its own persistent storage. Use a second `web` entry for a MakerWorld listing or any other place the generator lives.

### `bundle`: install a static web build for offline use

```json
{ "kind": "bundle", "from": { "type": "release", "asset": "foldbox-web-*.zip" }, "entry": "index.html", "spa": false }
```

The library downloads the files, keeps them under its own folder and serves them on `127.0.0.1` when launched. `from` is either

- `{ "type": "release", "asset": "<glob>", "tag": "latest" | "<tag>" | "<glob>", "prerelease": false }` — a GitHub release asset (zip, tar.gz or a single `.html` file), or
- `{ "type": "repo", "path": "site", "ref": "main" }` — a folder committed in the repository (downloaded as a tarball; `path` and `ref` are optional).

`entry` is the page to open (default `index.html`). Set `spa: true` when the app uses client-side routing so unknown routes reload the entry page. Builds must use **relative asset paths** (`base: './'` in Vite) to work from a local server.

Updates: release bundles update when a newer release carries a matching asset; repository bundles update when the branch moves.

#### Building from source

A web app that publishes no build can be built on the user's computer from its repository:

```json
{ "kind": "bundle", "from": { "type": "repo" },
  "build": { "output": "dist", "steps": [["npx", "vite", "build"]], "env": {}, "installScripts": false },
  "spa": true }
```

The library downloads the repository, installs its npm dependencies with its own private Node.js (`npm ci`, or `npm install` when the lock file is out of date), runs each step, and hosts the `output` folder. Steps are argument lists that start with `npm`, `npx` or `node`, so they run the same on Windows, macOS and Linux without a shell; the default is `[["npm", "run", "build"]]`. Calling the bundler directly (`npx vite build`) skips type checks and shell syntax such as `NODE_ENV=production` in package scripts, which Windows does not understand; put variables in `env` instead. Dependency install scripts are skipped unless `installScripts` is `true`. The Node.js runtime is added to `requires` automatically. A repository without a `package.json` skips the install; a page written in plain TypeScript that loads its compiled script can be built with `"steps": [["npx", "-p", "typescript@5", "tsc"]], "output": "."`.

Prefer a build from source over a `mirror`: a mirror only has what the page loaded while it was captured, so engines and assets loaded on demand are missing, and some sites refuse to be crawled.

### `exe`: install a standalone executable

```json
{ "kind": "exe", "platform": "windows", "install": "installer",
  "from": { "type": "release", "tag": "desktop-v*", "asset": "*-setup.exe" } }
```

- `platform`: `windows`, `macos` or `linux` (required; other platforms see the entry greyed out).
- `install`: `portable` runs the downloaded file as is; `installer` runs it once so it can install itself; `zip` unpacks the archive and runs `exec` inside it.
- `exec`: path of the executable inside a zip (required for `zip`).

An app that publishes its builds on its own website rather than on GitHub uses a download page as `from`:

```json
{ "kind": "exe", "platform": "linux",
  "from": { "type": "page", "url": "https://miniskyline.com/desktop", "asset": "MiniSkylines-Desktop-*-x86_64.AppImage",
            "folder": "https://miniskyline.com/downloads/desktop/" } }
```

The library reads the page, and the scripts it loads when the download buttons are drawn by JavaScript, for file names matching `asset`, and installs the newest. The version is the number in the file name; a new file name on the page is an update. `folder` is where a file name found on its own in a script is downloaded from (default: the page's folder). Such a project can be listed in the catalog without a repository: `{ "url": "https://miniskyline.com/", "fallback": { ...manifest... } }`.

### `mirror`: capture a live site with WebMirror

```json
{ "kind": "mirror", "url": "https://bruceborrett.github.io/easy-enclosure/", "githubPagesFiles": false, "browserCapture": true }
```

For generators that have no downloadable build yet. The library runs [WebMirror](https://github.com/DrFlGd/WebMirror)'s engine headlessly and registers the snapshot like an installed bundle. `githubPagesFiles` turns on WebMirror's "include all published repository files" mode for GitHub Pages sites with generated asset names. A mirror needs Python and WebMirror; the library installs both itself the first time (see `requires`), so the manifest does not have to say so.

## `requires`: runtimes the library installs

```json
"requires": [
  { "runtime": "python", "packages": ["numpy", { "spec": "mytool @ https://github.com/me/mytool/archive/refs/heads/main.zip", "import": "mytool" }] }
]
```

Before installing or launching, the library makes sure each runtime is there, privately in its own data folder, never system-wide. `node` is the official Node.js build (24 LTS) with npm, also checksum-verified, and is what builds from source run in; it needs no `packages`. `python` is a [python-build-standalone](https://github.com/astral-sh/python-build-standalone) CPython 3.12 checked against its published SHA-256, and `packages` are pip requirement specs installed into it once. Prefer archive URLs to `git+https://` so the user does not need git. Give `import` when the module name differs from the package, so the library can check a Python the user set in Settings. Progress and errors show in the Jobs panel.

## Collections

A repository with several generators (a monorepo with `apps/*`) publishes `generator-library.json`:

```json
{
  "id": "vostok-labs",
  "name": "Vostok Labs",
  "defaults": { "process": "3d-print", "license": "CC-BY-NC-ND-4.0", "tags": ["vostok-labs"] },
  "generators": [
    { "path": "apps/foldbox/generator.json" },
    { "path": "apps/laser-box/generator.json" },
    { "id": "large-box", "name": "Large Customizable Box", "distributions": [{ "kind": "web", "url": "https://makerworld.com/en/models/2300059" }] }
  ]
}
```

Entries are either `{ "path": … }` pointing at a `generator.json` inside the repository or an inline manifest. `defaults` apply to every entry; tags are merged. Each generator then appears on its own card, which is how one app with several built-in generators gets split up for browsing.

## How the library finds manifests

`catalog/catalog.json` in this repository lists the repositories to read. For each one the library fetches `generator.json`, then `generator-library.json`, from the default branch. Each catalog entry also carries a `fallback`: a snapshot of that manifest (collections with their entries inlined) that is used only when the repository cannot be read, so the library still shows everything offline, for a private repository without a token, or for a repository that has no manifest yet. What the repository publishes always wins; `npm run sync:fallbacks` refreshes the snapshots. An entry can additionally carry an `overlay`, a manifest merged over the result, which is how a fork can point at its upstream's releases. Anyone can add further repositories, or plain website links, under **Manage → Add a project** in the app. A repository with no manifest is described from its homepage or Pages site (online), its newest release's assets (bundles for `*web*`/`*site*`/`*dist*` zips, executables by extension and platform name), and, when no release has a bundle, a build from source if its `package.json` has a build script; only failing all of those is the site mirrored. Publishing a `generator.json` gives full control.

For agents adding a manifest to a repository, [AGENT-GUIDE.md](AGENT-GUIDE.md) is a step-by-step version of this page.

## Checklist for a repository

1. Add `generator.json` (or `generator-library.json`) at the root.
2. Make sure the web build uses relative asset paths and publish it as a release asset (`<id>-web-<version>.zip`) for the fastest offline install, or describe a `build` so the library builds it from source. Use `mirror` only for sites with no source to build.
3. If there is a desktop build, publish it as a **GitHub release** rather than only a workflow artifact; artifacts expire and need a login to download.
4. Use a stable tag pattern per build type (`v*` for web, `desktop-v*` for desktop) so the manifest can tell them apart.
