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
   makes `=SQUARE(5)` resolve to the registry entry.
3. **Host custom formula** — `EvalProvider::call_custom`. The Wave 8
   entry point.
4. **`#NAME?`** — no resolution found.

A host custom formula therefore CANNOT shadow a built-in or a registered
LAMBDA. `Workbook::define_name` already blocks reserved-name collisions
on the LAMBDA side; mirror that guarantee for customs.

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

## Limitations (initial cut)

- **Synchronous only.** JS callbacks must return a value, not a
  `Promise`. Async (callback returns Promise → cell shows pending state
  → resolves to a Value when promise settles) is future work.
- **Scalar args only.** Range arguments like `=MYTAX(A1:A100)` reach the
  callback as a 2-D array if Excel-style array context applies (see
  `Value::Array`); the engine does NOT yet introduce a Range arg type
  that gives the callback access to source addresses.
- **No lambda args.** A custom callback that wants higher-order behavior
  (`MAP`-style) needs to be re-architected.
- **Replace requires full invalidation.** As noted above; consider per-
  name dep tracking if churn matters.

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
