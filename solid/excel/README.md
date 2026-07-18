# @einfach/solid-excel

Solid.js spreadsheet surface for the Einfach vnext stack. The package wires `@einfach/spreadsheet-ui-core` atoms into Solid components, ships static and worker-backed adapters, and bundles a WASM build of the Rust formula engine.

The audited implementation plan for online-Excel parity is maintained in [docs/online-excel-parity/README.md](./docs/online-excel-parity/README.md). It covers feature groups 2–6 and 13 plus comments/notes/tasks; data analysis and printing are explicitly deferred.

## vnext architecture

```
+---------------------------------------------------------------+
|  Solid components  (src-vnext/grid, toolbar, formula-bar, ...) |
|       useAtomValue / useSetAtom from @einfach/solid            |
+---------------------------------------------------------------+
|  SpreadsheetUiProvider  (src-vnext/provider/)                  |
|    - createStore + createSpreadsheetUi                         |
|    - exposes SpreadsheetUiContext (backend, store)             |
+---------------------------------------------------------------+
|  spreadsheet-ui-core atoms  (framework-agnostic state)         |
|    selection / viewport / editing / clipboard / find / ...     |
+---------------------------------------------------------------+
|  SpreadsheetBackend port                                       |
|       |                                                        |
|       +-- static-backend.ts        (in-memory)                 |
|       +-- worker-workbook-backend.ts                           |
|                |                                               |
|                +-- worker-protocol.ts  (typed RPC)             |
|                +-- worker-runtime.ts   (runs in Web Worker)    |
|                         |                                      |
|                         +-- rust/wasm  (einfach_wasm.js)       |
|                                  |                             |
|                                  +-- rust/excel-core           |
|                                       (Workbook, eval, undo)   |
+---------------------------------------------------------------+
```

Layering rules: components read atoms via `@einfach/solid`; mutations dispatch atoms whose setters call `backend.<method>`. UI core never reaches the worker or WASM directly. The legacy `src/` package is kept for parity tests; new feature work targets `src-vnext/`.

## Components under `src-vnext/`

| Folder                    | Surface                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `provider/`               | `SpreadsheetUiProvider`, `SpreadsheetUiContext`, `useSpreadsheetBackend`, `useSpreadsheetUiStore`                    |
| `adapter/`                | `static-backend`, `worker-workbook-backend`, `worker-protocol`, `worker-runtime`, `worker-factory`, range-TSV helper |
| `grid/`                   | `SpreadsheetGrid` — virtualized cells, selection rendering, fill handle                                              |
| `formula-bar/`            | `SpreadsheetFormulaBar`                                                                                              |
| `toolbar/`                | `SpreadsheetToolbar` plus toolbar command types                                                                      |
| `status-bar/`             | `SpreadsheetStatusBar`                                                                                               |
| `sheet-tabs/`             | `SpreadsheetSheetTabs`                                                                                               |
| `context-menu/`           | `SpreadsheetContextMenu`                                                                                             |
| `find-replace/`           | `SpreadsheetFindReplaceDialog`（现有实现，属于状态迁移目标）                                                         |
| `conditional-formatting/` | `SpreadsheetConditionalFormatDialog`                                                                                 |
| `data-validation/`        | `SpreadsheetDataValidationDialog`                                                                                    |
| `named-ranges/`           | `SpreadsheetNameManagerDialog`                                                                                       |
| `comments/`               | `SpreadsheetCommentThread`                                                                                           |
| `print/`                  | `SpreadsheetPrintPreviewOverlay`                                                                                     |
| `filter-sort/`            | `SpreadsheetFilterDropdown`                                                                                          |
| `presence/`               | `SpreadsheetPresenceOverlay`                                                                                         |
| `protection/`             | `SpreadsheetProtectionUnlockDialog`                                                                                  |
| `history/`                | `SpreadsheetHistoryTimeline`                                                                                         |
| `demos/`                  | `VNextSmokeDemo` (static), `VNextWorkerDemo` (worker + WASM)                                                         |

Public exports flow through `src-vnext/public.ts`. Import via the `@einfach/solid-excel/vnext` subpath:

```ts
import { SpreadsheetUiProvider, SpreadsheetGrid } from '@einfach/solid-excel/vnext'
```

### Dialog state pattern

Some existing `*Dialog.tsx` components still read an open atom via `useAtomValue` but keep form state in `createSignal`. Treat that as migration debt, not as the pattern for new work. New or migrated dialogs must keep product, form draft, dirty, validation, pending, and error state in Einfach source/derived/command atoms; Solid-local state is limited to DOM references, one-off measurements, and animation handles. The feature plans linked above define the required state ownership and transitions.

### Provider caveat

`solid-js@1.9.12` re-executes consumer component bodies inside `Provider` when atoms mutate. Per-instance state must live in atoms or be re-derivable from atoms, not in `let` locals at the top of a component. See the root `CLAUDE.md` for the pinned contract test and the open version-alignment item.

## Build

```bash
# Refresh wasm-pkg from rust/wasm, then run Vite
npm run build -w @einfach/solid-excel

# Dev server (assumes wasm-pkg is built)
npm run dev -w @einfach/solid-excel

# Rebuild only the WASM bundle
npm run build:wasm -w @einfach/solid-excel
```

`build:wasm` runs `wasm-pack build --target web --out-dir ../../solid/excel/wasm-pkg ../../rust/wasm`. The repo-level `npm run build` invokes the same step before `tsc -build`, so a fresh clone must have `wasm-pack` and a working Rust toolchain on `PATH`.

## Testing

Roughly 419 jest specs live under `test/` (vnext) plus the legacy `src/` parity suites. Solid components use `@solidjs/testing-library`.

```bash
# Whole package
npx jest solid/excel --no-coverage

# Single vnext spec
npx jest solid/excel/test/vnext-grid.test.tsx --runInBand

# Type gate
npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false
```

End-to-end specs use Playwright against the Vite dev preview:

```bash
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts
```

Interaction, clipboard, worker, or viewport changes must also clear an MCP Playwright pass; the kanban in `vanilla/spreadsheet-ui-core/docs/AGENT_COLLABORATION.md` documents the required notes (URL, operation path, visible cell count, console warnings, parity conclusion).
