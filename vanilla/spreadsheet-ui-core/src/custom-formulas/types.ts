/**
 * Custom user-defined formula contracts (Wave 8).
 *
 * Plain-value boundary types — these MUST stay framework-agnostic and free
 * of any DOM / worker / WASM glue. The Solid (or other) host translates
 * registry mutations into worker RPCs (`register-custom-formula` /
 * `unregister-custom-formula`); the worker `new Function('args', source)`s
 * the body inside its own thread so JS callbacks never need to cross
 * `postMessage`.
 */

/**
 * Scalar leaf of a custom-formula argument. Cells project as
 * `number | string | boolean`; blank cells as `null`.
 */
export type CustomFormulaScalar = number | string | boolean | null

/**
 * Plain-value argument the worker-side body receives.
 *
 * Scalar args (`=MYFN(B2)`) arrive as a `CustomFormulaScalar`. Range
 * args (`=MYFN(A1:B10)`) arrive as a 2-D `ReadonlyArray<ReadonlyArray<scalar>>`
 * (row-major) because the WASM bridge marshals `Value::Array` directly
 * to a nested JS array — see `rust/excel-core/src/CUSTOM_FORMULAS.md`
 * "Marshaling".
 *
 * The `Readonly*` wrappers are TypeScript-only — the underlying arrays
 * are real `Array` instances at runtime, so `.flat()`, `.map()`,
 * `.reduce()` etc. work normally; the wrappers just discourage
 * accidental in-place mutation of WASM-owned data.
 */
export type CustomFormulaArg =
  | CustomFormulaScalar
  | ReadonlyArray<ReadonlyArray<CustomFormulaScalar>>

/**
 * Plain-value return shape. `undefined` is treated as a blank result by
 * the engine (same as a `null` return); both forms are accepted because
 * `return` with no value is a common pattern.
 */
export type CustomFormulaReturn = number | string | boolean | null | undefined

/**
 * Compiled local function form. Used by jest tests (no worker) and for
 * the optional `paramLabels` future wave. The Solid host does NOT send
 * this across `postMessage`; it sends `source` and lets the worker
 * `new Function('args', source)` it on register.
 */
export type CustomFormulaFn = (args: CustomFormulaArg[]) => CustomFormulaReturn

/**
 * Registry entry. `source` is the function body — arguments are bound to
 * `args` (Array) inside the worker. The closure-capture hazard is avoided
 * entirely by handing the host a body string rather than a live
 * function, so callers cannot accidentally close over a main-thread
 * variable.
 */
export interface CustomFormulaRegistration {
  /**
   * Excel-style uppercase name. Must match `/^[A-Z][A-Z0-9_.]*$/` and
   * must not shadow a built-in. The registry throws on registration if
   * either rule is violated.
   */
  name: string
  /**
   * Function body source. Bound parameter name is `args` (Array). The
   * worker constructs the live function via `new Function('args',
   * source)`. The body MUST be synchronous — async / Promise returns are
   * not supported in MVP.
   */
  source: string
  /** Optional metadata for IntelliSense (Wave 9 surface). */
  description?: string
  /** Optional parameter labels for the function-help popover. */
  paramLabels?: string[]
}

/**
 * Outcome of `validateCustomFormulaName`. Reasons are stable strings so
 * hosts can map them to localized error messages without parsing
 * free-text.
 */
export type CustomFormulaNameValidationReason =
  | 'name-empty'
  | 'name-format'
  | 'name-shadows-builtin'

export type CustomFormulaNameValidation =
  | { ok: true }
  | { ok: false; reason: CustomFormulaNameValidationReason }
