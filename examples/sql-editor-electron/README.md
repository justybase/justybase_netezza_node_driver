# Netezza SQL Editor — example 1 (Electron)

A small, polished SQL editor demonstrating `@justybase/netezza-driver`
outside the NPM package. All database communication happens in the `main`
(Electron/Node) process; the `renderer` (React) UI talks to it only through
a safe IPC bridge (`window.nz.*`).

## Stack

* **Electron + electron-vite** (main / preload / renderer)
* **Monaco Editor** (`monaco-editor` npm package, bundled locally — no CDN, works offline) — query editor
* **TanStack Table v8** — results (sorting, pagination, global/per-column filtering, column types)
* **Tailwind CSS** — dark DataGrip / VS Code style UI
* **Driver** — `@justybase/netezza-driver` (`NzConnection`, `query()`, `executeReader()`, `cancel()`)

## Quick start

```bash
cd examples/sql-editor-electron
npm install
cp .env.example .env   # optional: NZ_HOST, NZ_PORT, NZ_DATABASE, NZ_USER, NZ_PASSWORD
npm run dev            # Electron window + HMR
```

Production build:

```bash
npm run build
npm run dist:linux   # AppImage + tar.gz
npm run dist:win     # NSIS installer + ZIP
npm run dist:mac     # DMG + ZIP (run on macOS)
npm run test:import  # generated CSV/XLSX/XLSB import tests
# NZ_RUN_IMPORT_E2E=1 npm run test:import  # additionally run against Netezza
```

The repository CI builds unsigned Linux x64, Windows x64, and macOS x64 and
arm64 packages. For each platform and architecture, the installer and
portable archive are uploaded as separate GitHub Actions artifacts with
`-installer` and `-portable` suffixes. Pushing a tag such as
`sql-editor-v1.0.0` also publishes the packages as a GitHub Release.

Requires Node **>= 22** (like the driver) and a live Netezza/PureData
server for real queries. Without a server the UI starts in offline mode
(the connection dialog reports an error — that's expected).

## MVP features

* Connection dialog (host/port/database/user/password or `netezza://…` URI),
  profiles stored in `localStorage` (demo — not a vault).
* Schema browser on the left: schemas → tables/views → columns,
  search, “SELECT * LIMIT 100” and “Columns” actions.
* Monaco editor: `Ctrl/Cmd+Enter` runs the selection or everything,
  row limit, command timeout, **Cancel** button. `Ctrl/Cmd+O` opens a SQL file,
  `Ctrl/Cmd+S` saves it, and `Ctrl/Cmd+Shift+S` uses Save As.
* TanStack results: headers with types (`fields[]` from the driver), sorting,
  fast global/per-column filtering, 100/page pagination, `NULL` badges,
  click-to-copy cells, time + `rowCount`.
* Tabs: Results / Messages (notices) / History (last 50).
* CSV export (`;` separator, save dialog in main) and full-query streaming
  Excel export to **XLSX** or **XLSB** via
  [`@justybase/spreadsheet-tasks`](https://www.npmjs.com/package/@justybase/spreadsheet-tasks).
  Excel export deliberately uses the source SQL, so the grid preview limit and
  local grid filters do not change the exported data; explicit SQL `LIMIT` is
  respected.
* Lightweight SQL completion for database/schema/table paths (`DB.SCHEMA.TABLE`,
  `DB..TABLE`, `SCHEMA.TABLE`, `TABLE`), aliases, columns, CTEs and temp tables.
* Best-effort cancellation for queries, import preview/import, and CSV/XLSX/XLSB
  exports. Partial local export files are removed; an interrupted database
  import should be verified in Netezza because the demo does not add a rollback
  transaction around external-table loads.

The import test suite generates its CSV, XLSX and XLSB fixtures at runtime with
`@justybase/spreadsheet-tasks`. The live Netezza part is opt-in and requires
`NZ_RUN_IMPORT_E2E=1` together with `NZ_DEV_HOST`, `NZ_DEV_PASSWORD` and the
optional `NZ_DEV_PORT`, `NZ_DEV_DATABASE`, `NZ_DEV_USER` and `NZ_DEV_SCHEMA`.

## Schema catalog queries

The browser follows the same proven pattern as the JustyBase VS Code
extension for Netezza: system views are qualified per-database as
`DB.._V_xxx` and filtered with `DBNAME = '<db>'`:

* schemas: `SELECT SCHEMA FROM <DB>.._V_SCHEMA`
* objects: `SELECT OBJNAME, OBJTYPE FROM <DB>.._V_OBJECT_DATA WHERE DBNAME = '<db>' AND SCHEMA = '…'`; the UI groups tables, views, procedures, functions, sequences and other object types separately
* procedure signatures: `<DB>.._V_PROCEDURE` (`PROCEDURESIGNATURE`, `RESULT`); the `{}` action opens `PROCEDURESOURCE` in a new SQL tab
* view source: `<DB>.._V_VIEW.DEFINITION`; the `{}` action opens the definition in a new SQL tab
* columns: `_V_RELATION_COLUMN JOIN _V_OBJECT_DATA ON OBJID` (`ATTNAME`, `FORMAT_TYPE`)

## Where is the driver?

Only in `src/main/db.ts`:

```ts
import { NzConnection } from '@justybase/netezza-driver';
await conn.connect();
await conn.query(sql);                 // buffered results + fields
await conn.createCommand(sql).executeReader(); // streaming (columns fallback)
await conn.cancel();                   // Cancel button / timeout
```

The renderer **never imports** the driver — see `src/preload/index.ts`.

## Example safety notes

* The password lives only in main-process memory; `localStorage` stores the
  profile **without the password**.
* Auto-`LIMIT` (default 1000) is appended only to simple `SELECT`s without
  their own `LIMIT` — everything else passes through unchanged.
* This is an **example**, not a production client: no SSL pinning, no vault.

## Structure

```
src/main/       index.ts (window)  db.ts (driver)  ipc.ts (handlers)
src/preload/    index.ts + api.d.ts (window.nz)
src/renderer/   index.html  src/main.tsx  src/App.tsx
                src/components/*.tsx  src/lib/*.ts  src/styles.css
```

> Note: this folder is deliberately excluded from the NPM package
> (`examples/.npmignore` + root `files` whitelist).
