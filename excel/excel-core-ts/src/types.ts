/**
 * Public type contracts for `@einfach/excel-core-ts`.
 *
 * **This file is the source of truth shared by every Wave B/C/D/E agent.**
 * Anything that crosses a track boundary — parser AST, evaluator value
 * type, function signature, sheet mutation shape — lives here.
 *
 * Adding a field is forwards-compatible (only the producer cares).
 * Renaming / removing a field is **breaking** and must be flagged in
 * `docs/AGENT_COLLABORATION.md` before landing, so in-flight tracks
 * can rebase.
 *
 * Discipline:
 * - No runtime code in this file. Types and `as const` arrays only.
 * - No imports from anywhere except `@einfach/core` (for `Atom` / `Store`
 *   types). Specifically, never from `solid-js`, DOM lib, worker globals,
 *   or other `@einfach/*` packages.
 * - Every discriminated union uses a `kind` tag — keep it lowercase
 *   kebab-case strings so we can `JSON.stringify` for diagnostics.
 *
 * Cross-reference:
 *   docs/PLAN.md          — scope + phasing
 *   docs/ARCHITECTURE.md  — dataflow + design rationale
 *   docs/AGENT_COLLABORATION.md — multi-agent kanban
 */

// =============================================================================
// 1. CellKey + addressing
// =============================================================================

/**
 * `"<row>:<col>"` — same shape `static-backend.ts` uses today, so any
 * future bridge code can swap without re-keying. Both are 0-indexed
 * integers; A1 is `"0:0"`, B2 is `"1:1"`, AA1 is `"0:26"`.
 *
 * Public APIs always accept / return either a `CellKey` or
 * `{ row, col }` — never the raw A1 string (that's user-facing).
 */
export type CellKey = string

export interface CellCoord {
  readonly row: number
  readonly col: number
}

/**
 * Identity of the formula cell currently evaluating a custom-formula
 * call. Threaded from the evaluator's frame context into
 * `callCustom` so async pending entries know which cells to re-derive
 * on settle.
 */
export interface CustomCallOrigin {
  readonly sheetName?: string
  readonly cell?: CellCoord
}

/**
 * Inclusive on both ends. Empty range is invalid — callers must
 * normalize before constructing.
 */
export interface CellRange {
  readonly rowStart: number
  readonly rowEnd: number
  readonly colStart: number
  readonly colEnd: number
}

// =============================================================================
// 2. Error codes
// =============================================================================

/**
 * Excel formula errors. Strings (not numeric) so they survive
 * `JSON.stringify` round-trips through `postMessage` and dev-tools.
 *
 * `#CIRCULAR!` is einfach-specific; Excel surfaces circular refs as
 * `0` with a warning dialog. We diverge for diagnostic clarity.
 */
export const ERROR_CODES = [
  '#DIV/0!',
  '#N/A',
  '#NAME?',
  '#NULL!',
  '#NUM!',
  '#REF!',
  '#VALUE!',
  '#CALC!',
  '#CYCLE!',
  '#TYPE!',
  '#ARGS!',
  '#SPILL!',
  '#CIRCULAR!',
  '#ERROR!',
  '#BUSY!',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

// =============================================================================
// 3. Value — the universal evaluator IO type
// =============================================================================

/**
 * Every cell value, function argument, and function return is a `Value`.
 *
 * - `blank` is *not* the same as `string` with empty `""`. Blank means
 *   "no cell written"; `""` means "user typed an empty string". COUNT,
 *   COUNTA, ISBLANK behavior differ.
 * - `array` is the spill anchor's stored value. Indexable as 2D. Empty
 *   inner arrays are forbidden — at least 1x1.
 * - `error` carries an optional `message` so #VALUE! can explain
 *   *which* coercion failed without inventing a new error code.
 */
export type Value =
  | { kind: 'blank' }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'error'; code: ErrorCode; message?: string }
  | { kind: 'array'; value: Value[][] }

export const BLANK: Value = { kind: 'blank' }

/**
 * Internal reference payload carried by LET / LAMBDA scopes. It is not
 * a public `Value`; ordinary scalar evaluation still materializes the
 * referenced cell or range, while evaluator-aware functions can keep
 * the source sheet/range identity.
 */
export interface LambdaReferenceBinding {
  readonly sheetName?: string
  readonly range: CellRange
  readonly materialized?: Value[][]
}

export interface EvalRuntimeDeps {
  readonly ranges?: ReadonlyArray<{ readonly sheetName?: string; readonly range: CellRange }>
}

// =============================================================================
// 4. Cell — the unit stored inside a sheet's Map
// =============================================================================

/**
 * The `Cell` shape held inside `sheetAtom`'s Map. Distinct from the
 * `DisplayCell` produced by the worker's projection step:
 *  - `DisplayCell` is for the UI; carries formatted display text,
 *    merged-span metadata, conditional-format snapshots.
 *  - `Cell` is the engine's source of truth; the formula text + last
 *    computed value + raw cell format.
 *
 * `ast` is filled in lazily on first eval (or eagerly on `setCell` if
 * the parser is fast enough — TBD by Wave B benchmarks).
 */
export interface Cell {
  /** Raw user input, e.g. `"=A1+B2"` or `"100"` or `"North"`. */
  readonly input: string
  /** Parsed AST. Absent for literals. */
  readonly ast?: Expr
  /** Last computed value. Stable until the next recalc touches this cell. */
  readonly value: Value
  /** Optional cell-level format (bg, fg, font, number format). Orthogonal to value. */
  readonly format?: CellFormat
}

/**
 * Minimal format envelope. Mirrors `SpreadsheetCellFormat` in
 * `spreadsheet-ui-core/src/backend/types.ts` — keep field names aligned
 * so projection mapping stays mechanical.
 */
export interface CellFormat {
  readonly bgColor?: string
  readonly fgColor?: string
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strikethrough?: boolean
  readonly fontFamily?: string
  readonly fontSize?: number
  readonly horizontalAlignment?: 'left' | 'center' | 'right'
  readonly verticalAlignment?: 'top' | 'middle' | 'bottom'
  readonly numberFormat?: string
  readonly wrap?: boolean
  readonly rotation?: number
}

// =============================================================================
// 5. AST (Expr) — produced by parser, consumed by evaluator
// =============================================================================

/**
 * Excel formula AST. The discriminated union below is the **contract
 * between parser (Wave B/B1) and evaluator (Wave B/B2)**.
 *
 * Operator precedence is encoded by tree shape, not by `op` priorities —
 * Pratt parser shapes the tree so eval is plain post-order walk.
 *
 * Range and ref nodes carry the raw user string (`a1`, `start`, `end`)
 * for diagnostics + so cross-sheet resolution can re-tokenize without
 * the AST owning sheet identity. Resolving a ref to a cell value is
 * the evaluator's job, not the parser's.
 */
export type Expr =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | ErrorLiteral
  | ReferenceExpr
  | RangeExpr
  | DynamicRangeExpr
  | SpillReferenceExpr
  | CrossSheetExpr
  | MultiAreaExpr
  | NameExpr
  | UnaryExpr
  | BinaryExpr
  | PercentExpr
  | CallExpr
  | LambdaCallExpr
  | ArrayLiteralExpr

export interface NumberLiteral {
  readonly kind: 'number'
  readonly value: number
}

export interface StringLiteral {
  readonly kind: 'string'
  readonly value: string
}

export interface BooleanLiteral {
  readonly kind: 'boolean'
  readonly value: boolean
}

export interface ErrorLiteral {
  readonly kind: 'error'
  readonly code: ErrorCode
}

/** A single-cell reference like `A1`, `$A$1`, `$A1`, `A$1`. */
export interface ReferenceExpr {
  readonly kind: 'ref'
  readonly a1: string
  /** `true` when `$<col>` (absolute column). */
  readonly absCol: boolean
  /** `true` when `<row>$` (absolute row). */
  readonly absRow: boolean
}

/** A range like `A1:B10`, `A:A`, `1:1`. */
export interface RangeExpr {
  readonly kind: 'range'
  readonly start: string
  readonly end: string
}

/** A range whose endpoints can be computed by reference-returning expressions. */
export interface DynamicRangeExpr {
  readonly kind: 'dynamicRange'
  readonly start: Expr
  readonly end: Expr
}

/** A spilled-range reference like `A1#`. */
export interface SpillReferenceExpr {
  readonly kind: 'spillRef'
  readonly anchor: ReferenceExpr | CrossSheetExpr
}

/** A cross-sheet ref like `Sheet2!A1` or `Sheet2!A1:B10`. */
export interface CrossSheetExpr {
  readonly kind: 'crossSheet'
  readonly sheetName: string
  /** Inner expression as parsed *without* the sheet prefix. Always a `ref` or `range`. */
  readonly inner: ReferenceExpr | RangeExpr
}

/** A parenthesized area union like `(A1:B2,C1:D2)`, primarily for `AREAS`. */
export interface MultiAreaExpr {
  readonly kind: 'multiArea'
  readonly areas: ReadonlyArray<ReferenceExpr | RangeExpr | CrossSheetExpr>
}

/** A bare identifier — named range, defined name, or LAMBDA. */
export interface NameExpr {
  readonly kind: 'name'
  readonly name: string
}

/** Prefix unary: `-A1`, `+A1`. */
export interface UnaryExpr {
  readonly kind: 'unary'
  readonly op: '-' | '+'
  readonly operand: Expr
}

/** Binary infix: arithmetic, comparison, concat. */
export interface BinaryExpr {
  readonly kind: 'binary'
  readonly op: BinaryOp
  readonly left: Expr
  readonly right: Expr
}

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '^'
  | '&'   // string concat
  | '='   // comparison eq
  | '<>'  // comparison neq
  | '<'
  | '<='
  | '>'
  | '>='

/** Postfix `%` — `50%` → `0.5`. */
export interface PercentExpr {
  readonly kind: 'percent'
  readonly operand: Expr
}

/** Function call: `SUM(A1, B2)`. Custom formulas use this node too. */
export interface CallExpr {
  readonly kind: 'call'
  readonly name: string
  readonly args: ReadonlyArray<Expr>
}

/** Expression-level LAMBDA invocation: `LAMBDA(x, x + 1)(4)`. */
export interface LambdaCallExpr {
  readonly kind: 'lambdaCall'
  readonly callee: Expr
  readonly args: ReadonlyArray<Expr>
}

/** Inline array literal: `{1, 2; 3, 4}`. Outer = rows, inner = cols. */
export interface ArrayLiteralExpr {
  readonly kind: 'arrayLiteral'
  readonly rows: ReadonlyArray<ReadonlyArray<Expr>>
}

// =============================================================================
// 6. Sheet mutations
// =============================================================================

/**
 * The mutation envelope accepted by the sheet's writable atom. Producers
 * are: worker request decoder (D1), undo/redo replay, named-range setter.
 *
 * `requestId` / `revision` follow the same pattern as
 * `SpreadsheetBackend` requests so stale ops can be discarded.
 */
export type SheetMutation =
  | SetCellMutation
  | ClearCellMutation
  | BulkApplyMutation
  | SetFormatMutation

export interface SetCellMutation {
  readonly kind: 'set-cell'
  readonly row: number
  readonly col: number
  readonly input: string
}

export interface ClearCellMutation {
  readonly kind: 'clear-cell'
  readonly row: number
  readonly col: number
  /** When 'all', also clears format. 'value' keeps the cell format intact. */
  readonly target: 'value' | 'format' | 'all'
}

/**
 * Multi-cell write (paste, fill, import). Implementations must be
 * idempotent on conflicting input — last write wins by index order.
 */
export interface BulkApplyMutation {
  readonly kind: 'bulk-apply'
  readonly cells: ReadonlyArray<{
    readonly row: number
    readonly col: number
    readonly input: string
  }>
}

export interface SetFormatMutation {
  readonly kind: 'set-format'
  readonly range: CellRange
  /** Partial — fields left undefined are not touched on the existing format. */
  readonly format: Partial<CellFormat>
}

// =============================================================================
// 7. EvalContext — what function implementations receive
// =============================================================================

/**
 * The context every function impl receives. Built fresh by `evaluate()`
 * at the top of a derive run; passes through recursive calls.
 *
 * Critical invariants:
 *  - `cells` is the *snapshot* `Map` already pulled from `sheetAtom`.
 *    Function impls must NOT re-call `get(sheetAtom)` — they read from
 *    `cells` directly. This is what keeps the broad-dep model honest.
 *  - `crossSheetCells(sheetId)` returns the *snapshot* `Map` for another
 *    sheet (registers a dep on its atom internally). Reads only.
 *  - `currentlyEvaluating` is shared across the whole top-level derive
 *    call; cycle detection lives here, not in the atom layer.
 */
export interface EvalContext {
  /** Snapshot of the current sheet's cell map. Already read from sheetAtom. */
  readonly cells: ReadonlyMap<CellKey, Cell>

  /**
   * Resolve an A1-style ref to a Value. Handles `$A$1` normalization,
   * out-of-bounds → `BLANK`, and circular ref detection. Function impls
   * use this when they receive a ref argument (most don't — args are
   * pre-resolved by the dispatcher).
   */
  refLookup(a1: string): Value

  /**
   * Materialize a range as a 2-D `Value[][]`. Empty cells stay blank
   * (not omitted). Row-major order: outer = rows, inner = cols.
   */
  rangeLookup(start: string, end: string): Value[][]

  /**
   * Resolve a sheet name to its cells snapshot. Registers a dep on
   * that sheet's atom. Returns undefined if sheet doesn't exist —
   * caller should surface `#REF!`.
   */
  crossSheetCells(sheetName: string): ReadonlyMap<CellKey, Cell> | undefined

  /**
   * Invoke a host-registered custom formula. Returns `undefined` if no
   * formula by that name; caller should fall through to `#NAME?`.
   * Synchronous dispatch; names registered `isAsync` return the
   * memoized settled value or `#BUSY!` while the call is in flight.
   * `origin` identifies the evaluating formula cell so a pending async
   * call can re-derive exactly its observers when it settles; callers
   * without cell identity (direct evaluator tests) may omit it and the
   * settle falls back to a full recalc.
   */
  callCustom(name: string, args: Value[], origin?: CustomCallOrigin): Value | undefined

  /**
   * Cycle-detection set. Mutated by `refLookup` / `crossSheetCells`
   * around recursive evaluation. Function impls almost never touch
   * this directly.
   */
  readonly currentlyEvaluating: Set<CellKey>

  /**
   * Resolve a named range / defined name / LAMBDA binding to its value
   * or AST. Used by `NameExpr` evaluation.
   */
  resolveName(name: string): NameBinding | undefined

  /**
   * Optional workbook/cell metadata for evaluator-aware reference
   * functions (SHEET, SHEETS, CELL, FORMULATEXT, INDIRECT, OFFSET).
   * Direct unit tests may omit these; workbook-backed evaluation fills
   * them from the owning sheet and formula cell.
   */
  readonly currentCell?: CellCoord
  readonly currentSheetName?: string
  readonly currentSheetIndex?: number
  readonly sheetCount?: number
  sheetIndexOf?(sheetName: string): number | undefined

  /**
   * Active workbook locale as a BCP-47 tag (e.g. `'en-US'`, `'de-DE'`).
   * Functions that produce locale-sensitive output — TEXT, DOLLAR, FIXED —
   * read this to pick number separators / currency symbol. Absent in
   * direct-unit-test contexts; the workbook always threads it through.
   * Implementations should fall back to `'en-US'` when undefined.
   */
  readonly locale?: string

  /**
   * Optional per-call lambda scope. Maps a LAMBDA parameter name to the
   * already-evaluated argument `Value`. The evaluator checks this map
   * BEFORE consulting `resolveName` when it hits a `NameExpr`, so a
   * LAMBDA body that references one of its own parameters resolves to
   * the call-site argument instead of a workbook-level name.
   *
   * Scopes nest naturally via spread: `{ ...parent, lambdaScope: childMap }`
   * — nested LAMBDA calls (`LAMBDA(x, LAMBDA(y, x+y)(1))(2)`) build on the
   * outer scope rather than replacing it.
   *
   * Wave E (E3) — see `docs/ARCHITECTURE.md §9`.
   */
  readonly lambdaScope?: ReadonlyMap<string, Value>

  /**
   * Optional per-call reference-valued lambda scope. This is the
   * reference twin of `lambdaScope`: a parameter / LET binding like
   * `r = Data!C3` can evaluate as the cell value in ordinary arithmetic,
   * while `CELL("address", r)` / `FORMULATEXT(r)` / `INDEX(r, ...)`
   * still see the original reference identity.
   */
  readonly lambdaRefScope?: ReadonlyMap<string, LambdaReferenceBinding>

  /**
   * Optional per-call function-valued lambda scope. `lambdaScope` above
   * stores parameter / LET scalar values; this map stores LET-bound
   * LAMBDA values so evaluator-aware functions can pass them to MAP /
   * REDUCE / SCAN / BYROW / BYCOL / MAKEARRAY without widening `Value`
   * to a public first-class function type yet.
   */
  readonly lambdaFunctionScope?: ReadonlyMap<string, LambdaBinding>

  /**
   * Names of LAMBDA parameters omitted at the current call site. Used by
   * the evaluator-aware `ISOMITTED(name)` special form. Missing args still
   * bind to `BLANK` in `lambdaScope` for backward compatibility; this set
   * keeps the extra omission bit available when the body asks for it.
   */
  readonly lambdaOmittedParams?: ReadonlySet<string>

  /**
   * Optional per-derive mutable counter tracking the depth of nested
   * named-LAMBDA invocations. The evaluator increments it before
   * evaluating a LAMBDA body and decrements on return; if it would
   * exceed `MAX_LAMBDA_CALL_DEPTH`, the call surfaces `#NUM!` rather
   * than blowing the JS stack.
   *
   * Mirrors the Rust engine's `NAMED_CALL_DEPTH` thread-local (see
   * `excel/rust/excel-core/src/eval.rs` § "Maximum nesting depth"). Stored on
   * `ctx` instead of module-level so concurrent derives in the same
   * worker (cross-sheet recursive resolution) don't interfere with each
   * other.
   *
   * Shape is a single-field object so nested contexts created via
   * `{ ...ctx, lambdaScope }` share the same counter by reference.
   */
  readonly lambdaCallDepth?: { count: number }

  /**
   * Optional host hook fired once per FORMULA cell the evaluator visits
   * (the anchor itself plus every formula resolved transitively through
   * the trampoline / `resolveCell`, including foreign-sheet cells —
   * `cells` is the map the formula lives in, which the workbook resolves
   * back to a sheet by identity). The workbook uses it to lazily install
   * the cell's reverse-dependency edges (`src/deps.ts`), mirroring the
   * Rust engine's hydrate-on-read dep install. Pure observation — must
   * not mutate `cells` or evaluation state.
   */
  onFormulaEvaluated?(
    cells: ReadonlyMap<CellKey, Cell>,
    key: CellKey,
    ast: Expr,
    runtimeDeps?: EvalRuntimeDeps,
  ): void
}

/**
 * Maximum nesting depth for recursive LAMBDA invocations. Exceeded
 * depth returns `#NUM!` (Excel parity for stack-busting recursion).
 *
 * Picked to mirror the Rust engine's `MAX_NAMED_CALL_DEPTH` (32) so a
 * recursive helper that runs in Rust also runs here. JS frames are
 * cheaper than Rust ones, so we could go higher, but matching Rust
 * keeps cross-engine behaviour predictable.
 */
export const MAX_LAMBDA_CALL_DEPTH = 256

/**
 * Internal lambda payload used by evaluator-aware special forms. The
 * public cell `Value` union intentionally remains scalar/array/error
 * only; LAMBDA values move through `lambdaFunctionScope` instead.
 */
export interface LambdaBinding {
  readonly params: ReadonlyArray<string>
  readonly body: Expr
  readonly closureScope?: ReadonlyMap<string, Value>
  readonly closureRefScope?: ReadonlyMap<string, LambdaReferenceBinding>
  readonly closureFunctionScope?: ReadonlyMap<string, LambdaBinding>
  readonly closureOmittedParams?: ReadonlySet<string>
}

/**
 * What `EvalContext.resolveName` returns. LAMBDA bodies are AST so
 * `CallExpr` against a LAMBDA-bound name can re-evaluate with args.
 */
export type NameBinding =
  | { kind: 'range'; start: string; end: string; sheetName?: string }
  | { kind: 'value'; value: Value }
  | ({ kind: 'lambda' } & LambdaBinding)

// =============================================================================
// 8. FunctionImpl — the contract every Wave C function file satisfies
// =============================================================================

/**
 * Signature every built-in (and custom) function must satisfy. Function
 * impls live in `src/eval/functions/<category>.ts` and register into a
 * shared `Map<string, FunctionImpl>` in `src/eval/functions/index.ts`.
 *
 * Discipline (Wave C agents):
 *  - **Pure**: do not mutate `args`, `ctx`, or any captured state.
 *  - **Total**: return a Value for every input. Never throw — encode
 *    failure as `{ kind: 'error', ... }`.
 *  - **Coerce explicitly**: import helpers from `src/eval/coerce.ts`;
 *    don't re-derive `Value → number` casts inline.
 *  - **Error short-circuit**: if any positional arg is `kind:'error'`,
 *    return the *first* error verbatim (Excel propagation rule).
 *    Dispatcher does this for you by default — opt out only for IFERROR
 *    / IFNA / ISERROR family.
 */
export type FunctionImpl = (args: Value[], ctx: EvalContext) => Value

// =============================================================================
// 9. Public types re-exported for downstream packages
// =============================================================================
//
// Real `Workbook` / `WorkbookSheet` interfaces live alongside their
// implementations in `./workbook.ts` and `./sheet.ts`. We re-export them
// here so existing imports from `'./types'` keep working. The signatures
// were staged as `unknown` during Wave A; B2 finalizes them. Field names
// elsewhere in this file (Value, Cell, Expr, SheetMutation, EvalContext,
// FunctionImpl, NameBinding, BinaryOp, ErrorCode) are unchanged.

export type { Workbook, CreateWorkbookOptions, SheetSeed, BulkCellInput } from './workbook'
export type { WorkbookSheet, SheetState, SheetResolvers } from './sheet'
