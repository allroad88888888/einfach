# @einfach/excel-core-ts

TypeScript port of `einfach-excel-core` (Rust). Formula parser + evaluator + workbook state for the einfach spreadsheet stack. The reactive layer is delegated to [`@einfach/core`](../core) — this package owns only formula logic and the Workbook data model.

> **Status**: Phase 0 (Wave A) — package skeleton + frozen public contracts. No parser / evaluator yet.

## Why a TS core

See [docs/PLAN.md §2](./docs/PLAN.md). Short version: removes the
parallel atom-like dep graph that lives inside `rust/excel-core/src/sheet.rs`, lets the reactive layer be unified across worker + UI, and turns `cargo build` + `wasm-pack` into a hot-reload TS edit.

## Docs

- [PLAN.md](./docs/PLAN.md) — scope, phasing, decisions
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — dataflow, sheetAtom model, eval flow
- [AGENT_COLLABORATION.md](./docs/AGENT_COLLABORATION.md) — multi-agent kanban + per-wave file boundaries

## Package boundary

This package may import only `@einfach/core`. It must not import:

- `solid-js`, React, or any DOM type
- `worker` global, `postMessage`, `navigator`, `window`
- WASM-pack-emitted bindings
- Any other `@einfach/*` package (no `spreadsheet-ui-core`, no `solid`, no `react-*`)

The package must run cleanly under plain node (`jest --no-coverage` from repo root). Adapters that need a worker / DOM live downstream in `solid/excel/src-vnext/adapter/`.
