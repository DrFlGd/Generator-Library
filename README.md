# Generator Library

One place to browse, search, install, launch and update model generators: web apps and standalone executables, pulled straight from GitHub.

![Browsing the library](docs/screenshot-browse.png)

- **Browse and search** every generator by name, tag, process (3D print, laser…) and how it runs.
- **Open online**, **install an offline copy** served locally, or **install the desktop app**, from the same card.
- **Update from GitHub**: each install remembers its release tag or commit and can be checked and updated in one click.
- **Built from source**: web apps with no download (PrintKit, STLmill, Text to STL…) are built on your computer from their GitHub repository with the library's own private Node.js, so everything they load is there offline.
- **Portable**: the portable builds keep the whole library (apps, saved data, Python, Node.js) in a folder beside the app, so it can live on a USB drive. **Settings → Library folder** moves it anywhere.
- **Keep several versions**: updates keep the previous versions, and **Versions** lets you install any release and choose which one launches.
- **Split up multi-generator apps**: a monorepo lists each generator on its own card.
- **WebMirror built in**: generators with no downloadable build are captured for offline use with [WebMirror](https://github.com/DrFlGd/WebMirror). The library installs its own private Python and WebMirror the first time, so there is nothing to set up.
- **Jobs panel**: every install, mirror and download shows its progress, log and any error.
- **Manage projects**: add any GitHub repository or website link, hide what you do not use, and remove or restore projects, all from the app.
- **Filter by how it runs**: online only, works offline, or already ready offline.
- **Your work stays put**: each app is served on the same local address every launch, so what it saves in the browser (settings, layouts) is there next time.

![A generator's detail view](docs/screenshot-detail.png)

## Install

Download the Windows installer or portable exe from the [releases page](https://github.com/DrFlGd/Generator-Library/releases) (or the latest **Desktop builds** workflow run under Actions). The binaries are unsigned, so Windows SmartScreen may warn on first launch.

For private repositories or heavy use, add a GitHub token under **Settings** (fine-grained, read access to Contents and Metadata).

## Adding a generator

Put a [`generator.json`](docs/MANIFEST.md) in the generator's repository and either add the repository to [`catalog/catalog.json`](catalog/catalog.json) here (reaches everyone on the next refresh) or add it under **Manage → Add a project** in the app (just you). Each catalog entry keeps a `fallback` snapshot of the manifest for offline use (`npm run sync:fallbacks` refreshes them); a repository that has no manifest yet can be described the same way.

**Manage → Add a project** also takes a repository with no `generator.json` or a plain website link. The app describes it from what it can see (its website or Pages site becomes an online entry and a mirror; the files of its newest release become offline bundles and desktop apps), lets you edit the name, summary and tags, and adds it. Nothing in the app needs to change for a new generator.

To have an AI agent do it, point it at [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md).

See [docs/MANIFEST.md](docs/MANIFEST.md) for the convention and [docs/DESIGN.md](docs/DESIGN.md) for how the app is put together and the proposed changes to the existing generator repositories.

## Develop

```sh
npm install
npm test                 # unit tests
npm start                # run the Electron app
npm run serve:renderer   # the UI in a browser with a mock backend, http://127.0.0.1:4173
npm run check            # validate the catalog, then test
```

Requires Node.js 22+. Windows and Linux packages are built by `.github/workflows/desktop.yml`; tagging `v*` publishes a release.

## License

MIT. Each generator keeps its own license.
