# @einfach/spreadsheet-ui-core

Framework-agnostic spreadsheet UI core.

This package owns viewport, visible projection contracts, selection, editing,
keyboard, menus, toolbar, clipboard, sheet tabs, and operation UI state for a
spreadsheet shell.

It must not import Solid, React, DOM APIs, worker glue, or WASM glue. Workbook
facts remain owned by the backend implementation behind `backend/` ports.

## State Rules

- Use `@einfach/core` atoms and per-workbook/view stores.
- Store only visible-window UI projection and interaction state.
- Do not store workbook facts, formula cache, dependency graph, or sparse
  snapshots.
- Do not create unbounded per-cell, per-row, or per-column atoms.
- Feature folders must document their source/derived/command decisions in
  their own `README.md`.

## First Wave

Implemented framework-agnostic contracts:

- `backend` / `projection`: visible-window and explicit-range display projection contracts.
- `viewport`: scroll metrics, visible window derivation, and scroll-to-cell command.
- `selection` / `keyboard`: compact selection state and normalized keyboard intents.
- `editing` / `formula-bar`: draft, focus, commit/cancel, and diagnostics state.
- `pointer` / `menu` / `toolbar`: compact interaction sessions and command intents.
- `clipboard` / `sheet-tabs` / `operations`: user command intents without workbook facts.
- `workspace` / `diagnostics`: session revision metadata and bounded UI diagnostics.

Guard tests keep the package root exporting these modules and prevent imports from
Solid, React, DOM runtime APIs, worker glue, or WASM glue.
