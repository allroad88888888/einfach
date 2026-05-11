# einfach-wasm

WASM bindings for the einfach Excel engine. Re-exports `Sheet` /
`Workbook` from `einfach-excel-core` as `WasmSheet` / `WasmWorkbook` with
JS-friendly `set_number` / `set_formula` / `subscribe` surface.

Built by `wasm-pack` and consumed by `solid/excel/` via a relative
package reference at `rust/wasm/wasm-pkg`.

## Testing

### Native (no browser required)

```bash
cargo test --manifest-path rust/wasm/Cargo.toml
```

Runs the 12 `#[cfg(test)] mod tests` unit tests inside `src/lib.rs` on
the host target. Skips `tests/web.rs` (gated on `target_arch = "wasm32"`).

### wasm32 — browser (preferred for the microtask defer)

```bash
wasm-pack test --headless --chrome rust/wasm
```

Runs the 5 `#[wasm_bindgen_test]` tests inside `tests/web.rs`. This is
the **only** way to exercise `JsCallbackListener::on_change`'s
`queueMicrotask` defer path and the `__debugPanicNextCallback` knob in
realistic browser semantics (`console.error` surfacing + wasm-instance
survival, C.10).

If `wasm-pack test --headless --chrome` SIGKILLs `chromedriver`, the
cached chromedriver and your local Chrome may be on mismatched major
versions. Wipe `~/Library/Caches/.wasm-pack/chromedriver-*` and rerun so
`wasm-pack` re-downloads a matching driver; or pass `CHROMEDRIVER=/path`
to point at a manually-installed one.

### wasm32 — Node (fallback when no chromedriver is available)

```bash
wasm-pack test --node rust/wasm
```

Runs the same 5 tests under Node. The panic-inject test
(`wasm_sheet_panic_inject_surfaces_and_survives`) detects Node at
runtime and early-returns — Node's unhandled-microtask behavior kills
the process before the survival half can be observed, so that test is
only fully exercised under `--chrome`.

## TODO

- See `rust/docs/TODO.md` 2.3 for the wasm-bindgen-test bring-up history
  and 2.6 for the matching panic-hook console verification.
