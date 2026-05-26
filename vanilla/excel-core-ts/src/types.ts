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
  '#CIRCULAR!',
  '#ERROR!',
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
  | CrossSheetExpr
  | NameExpr
  | UnaryExpr
  | BinaryExpr
  | PercentExpr
  | CallExpr
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

/** A cross-sheet ref like `Sheet2!A1` or `Sheet2!A1:B10`. */
export interface CrossSheetExpr {
  readonly kind: 'crossSheet'
  readonly sheetName: string
  /** Inner expression as parsed *without* the sheet prefix. Always a `ref` or `range`. */
  readonly inner: ReferenceExpr | RangeExpr
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
   * Synchronous; async custom formulas are wrapped on the host side.
   */
  callCustom(name: string, args: Value[]): Value | undefined

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
}

/**
 * What `EvalContext.resolveName` returns. LAMBDA bodies are AST so
 * `CallExpr` against a LAMBDA-bound name can re-evaluate with args.
 */
export type NameBinding =
  | { kind: 'range'; start: string; end: string; sheetName?: string }
  | { kind: 'value'; value: Value }
  | { kind: 'lambda'; params: ReadonlyArray<string>; body: Expr }

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

/**
 * The Workbook handle exposed to the worker layer. Shape is finalized
 * in Wave B (`workbook.ts`); declared here only as `unknown` so D-track
 * agents have a name to target without forcing B-track to ship first.
 *
 * When B publishes `Workbook`, replace this with the real interface.
 */
export type Workbook = unknown

/**
 * A single sheet's reactive handle. Shape finalized in Wave B
 * (`sheet.ts`). Same staging convention as `Workbook` above.
 */
export type WorkbookSheet = unknown
