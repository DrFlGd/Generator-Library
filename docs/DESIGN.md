# Generator Library: design and migration plan

## What it is

A desktop app (Electron) that puts every model generator in one searchable place. Each generator can be opened online, installed as an offline copy, or installed as a native executable, and everything installed can be checked against GitHub and updated. The app knows about generators through a small manifest convention ([MANIFEST.md](MANIFEST.md)) plus a catalog in this repository.

```
┌───────────────────────┐   reads catalog + generator.json    ┌──────────────┐
│  Generator Library     │ ──────────────────────────────────▶ │   GitHub     │
│  (Electron)            │ ◀────────────────────────────────── │  releases,   │
│                        │   release assets, repo tarballs     │  repo trees  │
│  browse · search       │                                     └──────────────┘
│  install · launch      │
│  update                │   spawns engine                     ┌──────────────┐
│                        │ ──────────────────────────────────▶ │  WebMirror   │
│  loopback static server│ ◀── snapshot folder ─────────────── │  (Python)    │
└───────────────────────┘                                     └──────────────┘
```

## Pieces

| Folder | Role |
| --- | --- |
| `src/lib/manifest.js` | Validates and normalizes `generator.json` and collections. Pure. |
| `src/lib/catalog.js` | Reads the catalog, fetches manifests, applies overlays, expands collections. One failure never hides the other sources. |
| `src/lib/github.js` | Tiny GitHub client: read files, list releases, match an asset by glob, download. Anonymous reads go through `raw.githubusercontent.com` to stay clear of the 60/hour API limit. |
| `src/lib/installer.js` | Downloads a distribution (release asset or repo tarball), unpacks it safely, records what was installed, compares against the newest tag/commit for updates. |
| `src/lib/server.js` | Loopback static server for installed bundles and WebMirror snapshots. Honours WebMirror's route map and SPA fallback. Each app gets a port derived from its id, so its origin, and with it the localStorage and IndexedDB it saved, is the same every launch. |
| `src/lib/mirror.js` | Drives WebMirror's `MirrorEngine` headlessly and lists its existing snapshots. |
| `src/lib/runtimes.js` | Installs runtimes a manifest `requires` (a private python-build-standalone Python and pip packages such as WebMirror) into the data folder. |
| `src/lib/jobs.js` | Tracks installs, mirrors and runtime downloads as jobs with progress, a log and an error, for the Jobs panel. |
| `src/lib/describe.js` | Turns a repository or link typed into **Add a project** into a manifest: the published one, or one inferred from the homepage, Pages site and release assets. |
| `src/lib/library.js` | On-disk state: installs, favorites, recents, settings, user-added sources, hidden projects, removed catalog sources. |
| `src/main/` | Electron main process, IPC surface, generator windows (sandboxed, no Node). |
| `src/renderer/` | The UI: search, facets, cards, detail view, settings. Plain DOM, no framework. |
| `catalog/catalog.json` | The repositories the library ships knowing about, each with a `fallback` snapshot of its manifest for offline use (`npm run sync:fallbacks` refreshes them). |
| `schema/` | JSON Schemas for editor validation. |

### Why Electron

Three of the five example repos already ship an Electron or Tauri desktop wrapper, the user base is Windows-first, and the library must launch native executables and run a local server for offline bundles, which a browser cannot do. Electron keeps the whole project in one language (JavaScript, Node 22) with no Rust toolchain, matching terrain-press and Marble Run Maker.

### Security posture

- Generator windows are sandboxed BrowserWindows with no preload and no Node access; each generator gets its own persistent storage partition.
- The renderer talks to the main process only through the explicit IPC list in `preload.cjs`.
- Archive extraction refuses paths that escape the install folder.
- The static server binds to `127.0.0.1` only and never serves outside its root.
- The GitHub token is stored in the library's data folder on the user's machine and never shown back in the UI.

### Update model

Every install records *where it came from*: release tag + asset, or branch + commit. "Check updates" asks GitHub for the newest matching release (or the branch head) and compares strings. There is no version arithmetic to get wrong, and it works for repos with no semantic versions at all.

Each version installs into its own folder (`apps/<id>/<distKey>@<version>`). An update makes the new one launch and keeps the one it replaced, up to **Settings → Older versions to keep** (default 2; past that the oldest builds are deleted). **Versions** on a release download lists every matching release: install and launch any of them, switch back to a kept one without downloading, or delete it. A version picked this way is pinned, so update checks report what is newer without flagging it as an update. All versions of an app share one local address, so what the app saved in the browser carries across versions.

## What was learned from the example repositories

| Repository | Today | Fits as |
| --- | --- | --- |
| **terrain-press** (fork of ianbauters) | Static site committed in `site/`; Electron portable exe published as `desktop-v*` pre-releases. | `web` (upstream Pages) + `bundle` from `site/` + `exe` Windows portable. Works now. |
| **Generator-Standalone** (Vostok Labs monorepo) | Ten Vite apps under `apps/*`, registry in `generators.json`, hub builds them all to GitHub Pages; private Tauri Windows build published as `v0.7.0` release. | A **collection**: one card per app (`web` + `mirror` each), six MakerWorld-only listings as `web`, and the Windows standalone as `exe` installer. |
| **Marble-Run-Maker** (private) | Mirrored site in `Marbles/` + Electron wrapper; Windows build is only an Actions artifact; LFS for big 3MF files. | `bundle` from `Marbles/` (needs token) + `exe` once a release exists. |
| **gridfinity-layout-tool** (fork of andymai) | React/Vite web app at gridfinitylayouttool.com; Tauri NSIS installer published as `desktop-v*` releases from the fork's workflow. | `web` + `exe` installer. Bin Designer (`/designer`) and Baseplate Generator (`/baseplate`) listed as their own cards. |
| **easy-enclosure** (fork of bruceborrett) | Angular + JSCAD app on upstream GitHub Pages; no desktop build; built output not committed. | `web` + `mirror`. A release zip of `dist/` would add an offline `bundle`. |
| **WebMirror** | Python/Tk app; executables are Actions artifacts. | Used as the mirroring engine; also listed so it can be installed once it has a release. |

Common threads that shaped the convention:

- Everything web-based is a static build. A loopback server plus relative asset paths is all an offline copy needs; the Electron wrappers in three repos do exactly this by hand.
- Desktop builds are all unsigned Windows exes produced by Actions. The ones published as **releases** can be installed and updated automatically; the ones left as **artifacts** cannot (artifacts expire after 14 to 90 days and need a GitHub login).
- `generators.json` in Generator-Standalone is already a registry with ids, names, blurbs, topics and process. `generator-library.json` is the same idea made repo-independent.

## Changes to the existing repositories

Each was a small, self-contained pull request, all merged on 2026-10-27:
[terrain-press#14](https://github.com/DrFlGd/terrain-press/pull/14),
[Generator-Standalone#11](https://github.com/DrFlGd/Generator-Standalone/pull/11),
[Marble-Run-Maker#1](https://github.com/DrFlGd/Marble-Run-Maker/pull/1),
[gridfinity-layout-tool#5](https://github.com/DrFlGd/gridfinity-layout-tool/pull/5),
[easy-enclosure#1](https://github.com/DrFlGd/easy-enclosure/pull/1),
[WebMirror#6](https://github.com/DrFlGd/WebMirror/pull/6).

1. **Generator-Standalone**
   - Add `generator-library.json` at the root (the overlay in `catalog/catalog.json` is a ready-made starting point) and a `generator.json` per app under `apps/<app>/`.
   - Add a workflow step that zips each app's `dist/` as `<app>-web-<version>.zip` and attaches them to a `web-v*` release. Then every app gets a true offline `bundle` and no longer needs WebMirror.
   - Optionally generate `generator-library.json` from `generators.json` in `scripts/catalogue.mjs` so there is one source of truth.
2. **terrain-press**: add `generator.json` (contents as in MANIFEST.md). No build changes needed.
3. **Marble-Run-Maker**: add `generator.json`; add a `softprops/action-gh-release` step to `windows.yml` so the portable exe lands in a release.
4. **gridfinity-layout-tool**: add `generator.json`. Its desktop workflow already publishes releases.
5. **easy-enclosure**: add `generator.json`; optionally add a workflow that builds and attaches `easy-enclosure-web-<version>.zip` to a release.
6. **WebMirror**:
   - Publish releases from `build.yml` so the library can install it.
   - Nice to have: a `python -m webmirror --mirror <url> --json` CLI mode. The library currently calls `MirrorEngine` directly through `python -c`, which works today but is coupled to the module's internals.

Every repository now publishes its own manifest, which is what the library reads online. `catalog/catalog.json` keeps a `fallback` snapshot of each one (collections inlined) so the catalog still resolves offline, for the private Marble-Run-Maker without a token, and in `npm run check`. `npm run sync:fallbacks` refreshes the snapshots from GitHub; run it when a repository's manifest changes.

## Running and building

```sh
npm install
npm test                 # unit tests (node --test)
npm start                # run the app
npm run serve:renderer   # the UI in a normal browser with a mock backend
npm run dist:win         # Windows installer + portable exe (on Windows or via Actions)
```

`.github/workflows/desktop.yml` builds Windows and Linux packages on every push to `main` and publishes a GitHub release for `v*` tags. The library updates itself the same way it updates everything else: by watching those releases.

## Not done yet

- macOS packaging is wired in `package.json` but untested.
- Launching installed executables and the WebMirror hand-off were tested with fakes, not on a Windows machine.
- Per-app offline bundles for Generator-Standalone depend on the release step proposed above; until then those apps offer `mirror`.
- A "Mirror" distribution needs Python and WebMirror; the library downloads a private Python (about 30 MB) and installs WebMirror into it on first use. Browser capture uses the installed Chrome or Edge.
