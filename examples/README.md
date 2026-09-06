# `@justybase/netezza-driver` examples

This folder contains **standalone example projects**. They are not part of
the published NPM package or the driver build.

* Every subfolder in `examples/*` has its own `package.json` (`private: true`),
  its own `node_modules` and its own toolchain.
* The root `package.json` uses a `files: ["dist", ...]` whitelist, so `examples/`
  never lands in the NPM tarball. `examples/.npmignore` is an extra safety net.
* The root `tsconfig`, `biome`, `prettier` and `jest` deliberately **exclude**
  `examples/` — examples are not type-checked or tested by the driver CI.

## Index

| Example | Description |
| --- | --- |
| [`sql-editor-electron/`](sql-editor-electron/) | Small SQL editor (Electron + Monaco + TanStack Table + schema browser). Example 1. |

## Running

```bash
cd examples/sql-editor-electron
npm install
npm run dev
```

Create local packages with:

```bash
npm run dist:linux   # AppImage + tar.gz
npm run dist:win     # NSIS installer + ZIP
npm run dist:mac     # DMG + ZIP (run on macOS)
```

The `Build SQL Editor Electron` GitHub Actions workflow creates unsigned
packages for Linux x64, Windows x64, and macOS x64/arm64 on pull requests,
pushes to `main`, and manual runs. The files are available from the workflow
run as artifacts.
