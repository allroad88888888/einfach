# Custom formulas (Wave 8)

Host-pluggable formula functions, used by the WASM bridge to expose
JS-defined callbacks as cell-level functions: `=MYTAX(B1)` calls the
JS function the host registered under `"MYTAX"`.

## Architecture

```
=MYTAX(B1)
      │
      ▼  formula parser → Expr::FuncCall { name: "MYTAX", args: [...] }
      │
      ▼  eval.rs : eval_func match — no built-in arm matches
      │
      ▼  eval_named_call:
      │    1. provider.lookup_named("MYTAX")        → None  (not a defined LAMBDA)
      │    2. eagerly evaluate args to Vec<Value>   (errors short-circuit)
      │    3. provider.call_custom("MYTAX", &args)  → Option<Value>
      │
      ▼  WorkbookEvalProvider::call_custom (workbook.rs)
      │    → wb.custom_functions.lookup(name, args)
      │
      ▼  WasmCustomFormulaRegistry::lookup (wasm/lib.rs)
      │    → marshal args: Value → JsValue
      │    → js_sys::Function::call1(undefined, &js_args)
      │    → marshal return: JsValue → Value
      │
      ▼  JS callback (host-supplied)
           (args) => args[0] * 0.2
```

## Precedence (engine side)

Within `eval_func`, name resolution is tried in this order:

1. **Built-in dispatch** — the giant `match` in `eval_func`. Names like
   `SUM`, `IF`, `LAMBDA`, `XLOOKUP` win here.
2. **Defined-name LAMBDA** — `Workbook::define_name("SQUARE", "=LAMBDA(x, x*x)")`
   makes `=SQUARE(5)` resolve to the registry entry. **Only LAMBDA-typed
   defined names participate in this step.**
3. **Host custom formula** — `EvalProvider::call_custom`. The Wave 8
   entry point.
4. **`#NAME?`** — no resolution found.

A host custom formula therefore CANNOT shadow a built-in or a LAMBDA
defined name. `Workbook::define_name` already blocks reserved-name
collisions on the LAMBDA side; the LAMBDA-only filter in `eval_named_call`
preserves the LAMBDA-over-custom precedence.

**Non-LAMBDA defined names do NOT shadow customs.** Earlier shape:
any defined name (range refs, scalar literals like `answer = 42`) would
consume the call site and either error or fall through to `#VALUE!`. Post-
review fix: non-LAMBDA defined names are only consulted by bare
`Expr::Name` (`=MYRANGE` returns the range, `=answer` returns 42); a
call-shaped expression `=MYFUNC(...)` only matches LAMBDA defined names
at this site, otherwise it falls through to the custom registry. This is
what lets a host register `MYFUNC` as a custom callback even if the
workbook happens to also carry `MYFUNC = $A$1:$B$10` as a range alias.

## Trait surface (engine side)

```rust
// eval.rs
pub trait CustomFunctionRegistry: Send + Sync + std::fmt::Debug {
    fn lookup(&self, name: &str, args: &[Value]) -> Option<Value>;
}

pub trait EvalProvider {
    // ... existing methods ...
    fn call_custom(&self, _name: &str, _args: &[Value]) -> Option<Value> {
        None
    }
}

// workbook.rs
impl Workbook {
    pub fn set_custom_function_registry(
        &mut self,
        registry: Option<Arc<dyn CustomFunctionRegistry>>,
    );
    pub fn custom_function_registry(&self) -> Option<Arc<dyn CustomFunctionRegistry>>;
    pub fn invalidate_all_formulas_for_custom_function_change(&self);
}
```

Args are always pre-evaluated. The engine errors-short-circuit on any
`Value::Error` arg BEFORE invoking `call_custom`, so registry
implementations never see `Value::Error` in `args`.

## WASM bridge

```rust
// wasm/src/lib.rs
impl WasmWorkbook {
    #[wasm_bindgen(js_name = "registerCustomFormula")]
    pub fn register_custom_formula(&mut self, name: String, callback: js_sys::Function);

    #[wasm_bindgen(js_name = "unregisterCustomFormula")]
    pub fn unregister_custom_formula(&mut self, name: &str) -> bool;

    #[wasm_bindgen(js_name = "customFormulaCount")]
    pub fn custom_formula_count(&self) -> u32;

    #[wasm_bindgen(js_name = "customFormulaNames")]
    pub fn custom_formula_names(&self) -> JsValue;
}
```

### JS callback signature

```ts
type CustomFormulaArg = number | string | boolean | null | CustomFormulaArg[][]
type CustomFormulaReturn =
  | number
  | string                  // text cell, OR an Excel error token like "#DIV/0!"
  | boolean
  | null                    // → Value::Null
  | undefined               // → Value::Null
  | { error: string }       // structured Excel error, e.g. { error: "#DIV/0!" }
type CustomFormulaFn = (args: CustomFormulaArg[]) => CustomFormulaReturn
```

### Marshaling

`Value` → `JsValue` (args passed to JS):
- `Number(f64)`        → `number`
- `Text(String)`       → `string`
- `Boolean(bool)`      → `boolean`
- `Null`               → `null`
- `Error(e)`           → `string` like `"#DIV/0!"` (in practice never reaches
                          a custom callback — engine short-circuits errored args)
- `Array(arr)`         → 2-D `Array<Array<...>>` (row-major)
- `Lambda(_)`          → `null` (lambdas don't flow into custom calls)

`JsValue` → `Value` (return from JS):
- `number` (finite)    → `Number`
- `number` (NaN/Inf)   → `Error(Overflow)`  i.e. `#NUM!`
- `string`             → `Text`, EXCEPT the Excel error tokens which
                          round-trip back as `Error(_)` (see below).
- `boolean`            → `Boolean`
- `null` / `undefined` → `Null`
- `{ error: "TOKEN" }` → `Error(_)` parsed from `TOKEN`. Unknown tokens
                          → `Error(InvalidValue)` (`#VALUE!`).
- anything else        → `Error(WrongType)` (`#TYPE!`)
- throwing             → `Error(InvalidValue)` (`#VALUE!`). Cell shows
                          `#VALUE!`; wasm instance survives.

### Error tokens that round-trip

`#DIV/0!`, `#REF!`, `#VALUE!`, `#NAME?`, `#NUM!`, `#CYCLE!`, `#TYPE!`,
`#ARGS!`, `#SPILL!`.

### Registry invalidation

`register_custom_formula` (even when replacing an existing name) and
`unregister_custom_formula` both call
`Workbook::invalidate_all_formulas_for_custom_function_change`. This
dirties every formula in the workbook so cached results re-evaluate
against the new registry on next read. This is a sledgehammer (O(F)
total formulas) but works correctly without a reverse-dep index keyed on
function name. If host workflows show frequent registration churn,
adding a `HashMap<String, HashSet<(sheet, addr)>>` index keyed on
upper-cased name is the obvious optimization.

**TODO: batch invalidation API.** Registering N customs at startup
currently costs O(N × F) work because each call invalidates every
formula. The realistic dev workload (3–10 customs registered once at
load) doesn't hit this — at F ≈ 10 000 cells × 10 customs = 100 000
mark-dirty ops, all in-memory, that's still sub-millisecond. If a host
later needs to install hundreds of customs at startup, the lightweight
fix is a `registerCustomFormulas(names: string[], callbacks: Function[])`
batch API at the WASM layer that calls
`Workbook::invalidate_all_formulas_for_custom_function_change` once at
the end. Defer until a benchmark shows this matters. Benchmark probe:
add `bench/custom_register_churn.rs` that times N×F mark-dirty cycles
and reports per-op cost.

## Limitations (initial cut)

- **Synchronous only.** JS callbacks must return a value, not a
  `Promise`. Async (callback returns Promise → cell shows pending state
  → resolves to a Value when promise settles) is future work.
- **Range args materialise eagerly.** `=MYTAX(A1:A100)` evaluates the
  range to a 2-D `Value::Array` (row-major) BEFORE crossing the JS
  boundary, and the callback receives a `number[][]` / `(number | string
  | boolean | null)[][]` JS array. The engine does NOT yet introduce a
  Range arg type that gives the callback access to source addresses or
  lazy iteration — large ranges are fully copied into JS.
- **No lambda args.** A custom callback that wants higher-order behavior
  (`MAP`-style) needs to be re-architected.
- **Replace requires full invalidation.** As noted above; consider per-
  name dep tracking if churn matters.
- **No mutation during callback execution.** See § "No mutations during
  callback" below.
- **String return capped at 1 MB.** A callback returning a larger string
  surfaces `#VALUE!` and logs to `console.warn`.
- **Single-threaded only.** `WasmCustomFormulaRegistry` is `Send + Sync`
  via an `unsafe impl` gated on `cfg(not(target_feature = "atomics"))`.
  Enabling wasm threads (wasm-bindgen-rayon) flips off the impl and the
  registry will fail to satisfy the `CustomFunctionRegistry` bound at
  compile time — the unsoundness surfaces as a build error rather than
  silent UB. Re-enabling threads requires re-architecting around a
  worker-bound channel or `SendWrapper`.

## No mutations during callback

A host custom-formula JS callback **MUST NOT** mutate the workbook while
it runs. The engine enforces this via the `Workbook::is_inside_custom_call`
re-entrancy guard:

1. `WorkbookEvalProvider::call_custom` enters a `CustomCallScope` that
   bumps a counter on `Workbook::custom_call_depth` for the duration of
   the JS callback. The scope's `Drop` impl decrements on exit (so a
   thrown JS exception still cleans up the counter).
2. Every public mutation entry point on `Workbook` (`set_cell`,
   `clear_cell`, `set_formula`, `try_set_*`, `define_name`,
   `undefine_name`, `set_custom_function_registry`, `add_sheet`,
   `rename_sheet`, `remove_sheet`, `move_sheet`, `bulk_load`'s loader
   `set_cell` / `set_formula` / `clear_cell` methods) checks the
   guard and rejects (via `Err(SheetError::MutationDuringCustomCall)` /
   `Err(WorkbookError::MutationDuringCustomCall)` on the fallible
   variants, silent no-op on the infallible ones).

**Why**: a mutation inside the callback dirties the cell whose formula
triggered the callback. The surrounding `eval_formula_at_with_provider`
then unconditionally writes `FormulaCache::Clean(value)` on return —
silently losing the dirty mark. The next read of that cell would return
a stale value until something else dirtied it. Disallowing mutations
keeps the cache state machine sound.

**Workarounds**: callbacks that need to "write back" should return a
value and let the host write it after the read completes. The host has
full access to the workbook through `&mut WasmWorkbook` outside callback
frames.

## Security model

The WASM bridge compiles host-supplied JS source via `new Function('args',
source)` (see `solid/excel/src-vnext/adapter/worker-runtime.ts`). This
boundary is **NOT a privilege sandbox**:

- `new Function` sandboxes only the *lexical closure*. The compiled
  function cannot reach `worker-runtime.ts`'s local variables, but it
  has full access to the worker's global scope: `self`, `postMessage`,
  `fetch`, `importScripts`, `indexedDB`, the WASM workbook handle, etc.
- Source registered through this path is therefore **host-trusted
  code**, not untrusted user input. Acceptable inputs: developer code
  shipped with the app, formulas loaded from a trusted backend, a
  curated registry of pre-vetted formulas. **Unacceptable** inputs:
  arbitrary strings typed by an end user into a UI "JavaScript formula
  editor" field.

**A future user-input formula editor MUST**:

- Run user code in an iframe sandbox with `sandbox="allow-scripts"` (no
  `allow-same-origin`) so the iframe's globals are a separate origin.
- Communicate via `postMessage` with structured-clone-only payloads —
  never share objects, never `eval`/`new Function` the result.
- Forward calls back to the worker through that channel rather than
  letting the user code touch the WASM handle directly.

The current Wave 8 registry deliberately omits this iframe layer because
the only callers are app-internal. Adding it is a separate arc and
requires reworking the callback marshaling to be async.

## Tests

Engine-side:
- `rust/excel-core/src/eval.rs` — `eval::tests::custom_function_*` (5 unit
  tests covering dispatch, eager arg eval, case insensitivity, error
  propagation, precedence vs defined-name LAMBDA).

WASM-side:
- `rust/wasm/tests/web.rs` — `wasm_workbook_custom_formula_*` (6
  `#[wasm_bindgen_test]` tests covering tax round-trip, case insensitivity,
  unregister, throw → `#VALUE!`, string/error-token returns, replacement
  via re-register, count probe).
