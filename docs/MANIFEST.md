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
| `icon`, `screenshots` | | Paths in the repository or `https://` URLs. Repository paths are loaded from the default branch. |
| `homepage`, `license`, `author`, `version` | | Informational. |
| `repo` | | `owner/name`; defaults to the repository the manifest was read from. |
| `upstream` | | For forks, the original repository (shown as a link). |

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

### `exe`: install a standalone executable

```json
{ "kind": "exe", "platform": "windows", "install": "installer",
  "from": { "type": "release", "tag": "desktop-v*", "asset": "*-setup.exe" } }
```

- `platform`: `windows`, `macos` or `linux` (required; other platforms see the entry greyed out).
- `install`: `portable` runs the downloaded file as is; `installer` runs it once so it can install itself; `zip` unpacks the archive and runs `exec` inside it.
- `exec`: path of the executable inside a zip (required for `zip`).

### `mirror`: capture a live site with WebMirror

```json
{ "kind": "mirror", "url": "https://bruceborrett.github.io/easy-enclosure/", "githubPagesFiles": false, "browserCapture": true }
```

For generators that have no downloadable build yet. The library runs [WebMirror](https://github.com/DrFlGd/WebMirror)'s engine headlessly (Python 3.10+ with the `webmirror` package installed) and registers the snapshot like an installed bundle. `githubPagesFiles` turns on WebMirror's "include all published repository files" mode for GitHub Pages sites with generated asset names.

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

`catalog/catalog.json` in this repository lists the repositories to read. For each one the library fetches `generator.json`, then `generator-library.json`, from the default branch. A catalog entry can also carry an `overlay`: a manifest merged over what the repository publishes, which is how repositories are listed before they adopt the convention and how a fork can point at its upstream's releases. Anyone can add further repositories in the app's Settings.

## Checklist for a repository

1. Add `generator.json` (or `generator-library.json`) at the root.
2. Make sure the web build uses relative asset paths and publish it as a release asset (`<id>-web-<version>.zip`) if you want an offline copy without WebMirror.
3. If there is a desktop build, publish it as a **GitHub release** rather than only a workflow artifact; artifacts expire and need a login to download.
4. Use a stable tag pattern per build type (`v*` for web, `desktop-v*` for desktop) so the manifest can tell them apart.
