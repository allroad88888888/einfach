# Rust bulk_import_cells — Ultra single-call bench

*Last run: 2026-06-11T05:40:18.238Z*

Each tier issues ONE `bulk_import_cells` call against a fresh `WasmWorkbook`. Pre-flight cap must be raised in `rust/wasm/src/lib.rs` for this bench to make it past the 750k default.

## Summary

| Tier | total cells | seeds | formulas | import ms | peak RSS (MB) | Δ RSS (MB) | post-read | post-mutate | post-recalc | error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1M | 1000000 | 500000 | 500000 | 10111 | 946 | 429 | ok | ok | ok |  |
| 2M | 2000000 | 1000000 | 1000000 | 17802 | 1424 | 477 | ok | ok | ok |  |
| 3M | 3000000 | 1500000 | 1500000 | 32259 | 2029 | 605 | ok | ok | ok |  |
| 5M | 5000000 | 2500000 | 2500000 | 54590 | 2894 | 865 | ok | ok | ok |  |

## Notes

- `import ms` is the wall-clock around `wb.bulk_import_cells(cells)` on the host (V8) side.
- `peak RSS` is `process.memoryUsage.rss()` after the import + post-import sanity calls.
- Δ RSS = peak RSS − RSS measured before workload build. Includes JS-side cell array AND wasm-pkg allocations.
- A non-empty `error` column indicates the workbook entered a broken state (typically the "attempted to take ownership while borrowed" chain).
- `post-read` / `post-mutate` / `post-recalc` exercise three downstream paths against the workbook AFTER the import. All three must be `ok` for the cap to be safely removable.
