# Generator Library

One place to browse, search, install, launch and update model generators: web apps and standalone executables, pulled straight from GitHub.

![Browsing the library](docs/screenshot-browse.png)

- **Browse and search** every generator by name, tag, process (3D print, laser…) and how it runs.
- **Open online**, **install an offline copy** served locally, or **install the desktop app**, from the same card.
- **Update from GitHub**: each install remembers its release tag or commit and can be checked and updated in one click.
- **Split up multi-generator apps**: a monorepo lists each generator on its own card.
- **WebMirror built in**: generators with no downloadable build are captured for offline use with [WebMirror](https://github.com/DrFlGd/WebMirror).

![A generator's detail view](docs/screenshot-detail.png)

## Install

Download the Windows installer or portable exe from the [releases page](https://github.com/DrFlGd/Generator-Library/releases) (or the latest **Desktop builds** workflow run under Actions). The binaries are unsigned, so Windows SmartScreen may warn on first launch.

For private repositories or heavy use, add a GitHub token under **Settings** (fine-grained, read access to Contents and Metadata).

## Adding a generator

Put a [`generator.json`](docs/MANIFEST.md) in the generator's repository and either add the repository to [`catalog/catalog.json`](catalog/catalog.json) here (reaches everyone on the next refresh) or add it under **Settings → Your repositories** in the app (just you). Repositories that do not have a manifest yet can be described directly in the catalog with an `overlay`.

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
