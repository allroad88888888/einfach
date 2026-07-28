/**
 * Tiny formula evaluator for the static Wave 5 demo backend.
 *
 * Supports the subset the audit specs and showcase scenarios actually exercise:
 *   - number literals (decimals, signed)
 *   - string literals: "hello"
 *   - cell references: A1, $A$1
 *   - range references inside function args: B2:E8
 *   - operators: + - * / ^ with normal precedence, plus comparison
 *     operators = <> < <= > >= (lowest precedence) returning 1/0
 *   - unary minus / plus
 *   - parentheses
 *   - functions: SUM, AVERAGE, COUNT, MIN, MAX, IF, SUMIF, COUNTIF,
 *     ABS, ROUND, CONCAT, SUBTOTAL
 *   - error literals: #NULL!, #DIV/0!, #N/A, #REF!, #VALUE!, #NAME?,
 *     #NUM!, #CYCLE!, #TYPE!, #ARGS!, #SPILL!, #CALC!, #BUSY!
 *
 * Anything beyond this returns the string '#ERROR!'. Division by zero
 * returns '#DIV/0!'. Cyclic references return '#CYCLE!'. Cross-sheet
 * refs (Sheet!A1) are not supported — the worker backend covers those.
 *
 * Plain (non-error) string results are valid first-class values: CONCAT
 * builds them, comparisons can take them, IF can branch to them. Only
 * strings that start with '#' are treated as error codes.
 */

import type { DisplayCell } from '@einfach/spreadsheet-ui-core'

export type EvalResult =
  | { kind: 'number'; value: number }
  | { kind: 'error'; code: string }

export interface EvalCellLookup {
  /** Returns the parsed cell (formula + displayValue) for the active sheet, or undefined. */
  get(row: number, col: number): DisplayCell | undefined
  /**
   * Resolve an Excel Table structured reference (`Table1[Col]`, `#special`,
   * `[@Col]`, multi-column) to a concrete range — or a structured error — so
   * the existing range machinery can aggregate over it (#32,
   * design-excel-table §5.3). Optional: when omitted, any `Table[...]` token
   * fails the tokenizer and the formula surfaces `#ERROR!` (an honest "not
   * supported here", never a faked value). See `makeStructuredRefResolver` in
   * static-backend.ts.
   */
  resolveStructuredRef?: StructuredRefResolver
  /**
   * Rows the host currently hides on the evaluated sheet — read-only
   * evaluation input for `SUBTOTAL` 101-111 (design-excel-table §6, engine
   * parity with `Workbook::set_eval_hidden_rows`). Codes 1-11 never consult
   * it. Omitted / empty means "nothing hidden", in which case 101-111 and
   * 1-11 agree.
   */
  hiddenRows?: ReadonlySet<number>
  /**
   * Rows an ACTIVE FILTER hides on the evaluated sheet — the second,
   * independently addressable evaluation input (`design-filter-hidden-rows`
   * §6.2, engine parity with `Workbook::set_eval_filter_hidden_rows`).
   *
   * Consumed by BOTH SUBTOTAL bands, which is the whole point of keeping it
   * apart from `hiddenRows`: Excel's 1-11 excludes filter-hidden rows while
   * still including manually hidden ones. Omitted / empty means "no filter
   * hides anything".
   */
  filterHiddenRows?: ReadonlySet<number>
}

/** The cell whose formula is being evaluated — the `[@Col]` / `[Col]` anchor. */
export interface EvalOrigin {
  readonly row: number
  readonly col: number
}

/**
 * Outcome of resolving one structured reference. `null` means the syntax is
 * not resolvable in the single-sheet static evaluator (combined specs like
 * `[[#Data],[Col]]`, cross-sheet Table refs) — the tokenizer treats it as a
 * hard failure (`#ERROR!`) rather than inventing a value. An `error` result is
 * a resolvable reference that legitimately evaluates to an Excel error
 * (`#NAME?` unknown table, `#REF!` unknown column / missing band, `#VALUE!`
 * for a `[@Col]` outside its Table's data body).
 */
export type StructuredRefResolution =
  | { readonly kind: 'range'; readonly ref: RangeRef }
  | { readonly kind: 'error'; readonly code: string }
  | null

/**
 * `tableName` is `null` for a table-less `[Col]` / `[@Col]` (resolved from
 * `origin`); `origin` is `null` when the evaluation has no anchoring cell
 * (ad-hoc `evaluateFormula` calls), which makes every this-row form `#VALUE!`
 * exactly as the engine's `current_cell() -> None` path does.
 */
export type StructuredRefResolver = (
  tableName: string | null,
  inner: string,
  origin: EvalOrigin | null,
) => StructuredRefResolution

function columnLabelToIndex(label: string): number {
  let result = 0
  for (let i = 0; i < label.length; i += 1) {
    result = result * 26 + (label.charCodeAt(i) - 64)
  }
  return result - 1
}

/**
 * Parse an A1 cell reference. Deliberately NOT grid-bounded: the engine's
 * formula parser also accepts an A1-shaped token past `XFD` and reads it as an
 * (always empty) off-grid cell. That is what makes a bare `Table1` — column
 * `TABLE`, row 1 — evaluate to an empty cell rather than a structured
 * reference or `#NAME?` in BOTH engines. Verified against WASM in
 * vnext-table-totals-static-wasm-parity.test.ts.
 */
function parseCellRef(token: string): { row: number; col: number } | null {
  const stripped = token.replace(/\$/g, '')
  const match = /^([A-Z]+)(\d+)$/.exec(stripped)
  if (!match) return null
  const col = columnLabelToIndex(match[1])
  const row = Number(match[2]) - 1
  if (!Number.isInteger(row) || row < 0 || col < 0) return null
  return { row, col }
}

export interface RangeRef {
  rowStart: number
  rowEnd: number
  colStart: number
  colEnd: number
}

function parseRangeRef(token: string): RangeRef | null {
  const [a, b] = token.split(':')
  if (!a || !b) return null
  const start = parseCellRef(a)
  const end = parseCellRef(b)
  if (!start || !end) return null
  return {
    rowStart: Math.min(start.row, end.row),
    rowEnd: Math.max(start.row, end.row),
    colStart: Math.min(start.col, end.col),
    colEnd: Math.max(start.col, end.col),
  }
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'cell'; ref: { row: number; col: number } }
  | { kind: 'range'; ref: RangeRef }
  | { kind: 'func'; name: string }
  | { kind: 'op'; op: string }
  | { kind: 'cmp'; op: '=' | '<>' | '<' | '<=' | '>' | '>=' }
  | { kind: 'error'; code: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' }

const FUNCTION_NAMES = new Set([
  'SUM',
  'AVERAGE',
  'COUNT',
  'MIN',
  'MAX',
  'IF',
  'SUMIF',
  'COUNTIF',
  'ABS',
  'ROUND',
  'CONCAT',
  'AND',
  'OR',
  'NOT',
  'LEN',
  'LOWER',
  'UPPER',
  'TRIM',
  'SQRT',
  'MOD',
  'VLOOKUP',
  'SUBTOTAL',
])

/** Bare-name literals (no parens) — Excel parity for TRUE/FALSE. */
const BARE_LITERALS: Record<string, number> = {
  TRUE: 1,
  FALSE: 0,
}

/**
 * Error literal tokens — 13 Excel error codes aligned with
 * `excel/rust/wasm` `error_token_to_value_error`.
 */
const ERROR_LITERAL_RE = /^#(NULL!|DIV\/0!|N\/A|REF!|VALUE!|NAME\?|NUM!|CYCLE!|TYPE!|ARGS!|SPILL!|CALC!|BUSY!)/

/**
 * Scan a balanced `[...]` structured-reference suffix starting at
 * `bracketIndex` (which must point at the opening `[`). Handles one level of
 * nesting (`[[ColA]:[ColB]]`). Returns the table name preceding the bracket,
 * the raw inner text, and the index just past the closing `]`; `null` on an
 * unbalanced suffix.
 */
function scanStructuredRef(
  input: string,
  identStart: number,
  bracketIndex: number,
): { tableName: string; inner: string; endIndex: number } | null {
  let depth = 0
  let j = bracketIndex
  for (; j < input.length; j += 1) {
    const c = input[j]
    if (c === '[') depth += 1
    else if (c === ']') {
      depth -= 1
      if (depth === 0) {
        j += 1
        break
      }
    }
  }
  if (depth !== 0) return null
  return {
    tableName: input.slice(identStart, bracketIndex),
    inner: input.slice(bracketIndex + 1, j - 1),
    endIndex: j,
  }
}

function tokenize(
  input: string,
  resolveStructuredRef?: StructuredRefResolver,
  origin?: EvalOrigin,
): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  /** Push the outcome of one structured reference, or fail the tokenizer. */
  const pushStructured = (tableName: string | null, inner: string): boolean => {
    if (!resolveStructuredRef) return false
    const resolution = resolveStructuredRef(tableName, inner, origin ?? null)
    if (!resolution) return false
    if (resolution.kind === 'range') tokens.push({ kind: 'range', ref: resolution.ref })
    else tokens.push({ kind: 'error', code: resolution.code })
    return true
  }
  while (i < input.length) {
    const ch = input[i]
    if (ch === ' ' || ch === '\t') {
      i += 1
      continue
    }
    // Table-less structured reference written inside a Table's own cells:
    // `[Col]` (whole data column) / `[@Col]` (this row). `[` has no other
    // lexical role here, so a leading `[` is unambiguous — engine parity with
    // the `'[' => parse_table_ref_body(None)` primary arm.
    if (ch === '[') {
      const scanned = scanStructuredRef(input, i, i)
      if (!scanned) return null
      if (!pushStructured(null, scanned.inner)) return null
      i = scanned.endIndex
      continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' })
      i += 1
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' })
      i += 1
      continue
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' })
      i += 1
      continue
    }
    if (ch === '"') {
      // String literal — scan until the next unescaped `"`. Excel uses a
      // doubled `""` inside a string to represent a literal quote, which
      // is rarely needed at this scope — we don't support it. A second
      // `"` always closes.
      const start = i + 1
      i += 1
      while (i < input.length && input[i] !== '"') i += 1
      if (input[i] !== '"') return null
      tokens.push({ kind: 'string', value: input.slice(start, i) })
      i += 1
      continue
    }
    // Comparison operators must be matched BEFORE single-char + - * / ^
    // because `>=`, `<=`, `<>` are two-char.
    if (ch === '<') {
      if (input[i + 1] === '=') {
        tokens.push({ kind: 'cmp', op: '<=' })
        i += 2
        continue
      }
      if (input[i + 1] === '>') {
        tokens.push({ kind: 'cmp', op: '<>' })
        i += 2
        continue
      }
      tokens.push({ kind: 'cmp', op: '<' })
      i += 1
      continue
    }
    if (ch === '>') {
      if (input[i + 1] === '=') {
        tokens.push({ kind: 'cmp', op: '>=' })
        i += 2
        continue
      }
      tokens.push({ kind: 'cmp', op: '>' })
      i += 1
      continue
    }
    if (ch === '=') {
      tokens.push({ kind: 'cmp', op: '=' })
      i += 1
      continue
    }
    if ('+-*/^'.includes(ch)) {
      tokens.push({ kind: 'op', op: ch })
      i += 1
      continue
    }
    if (ch >= '0' && ch <= '9') {
      const start = i
      while (i < input.length && /[0-9.]/.test(input[i])) i += 1
      const value = Number(input.slice(start, i))
      if (!Number.isFinite(value)) return null
      tokens.push({ kind: 'number', value })
      continue
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '$') {
      const start = i
      while (i < input.length && /[A-Za-z0-9$]/.test(input[i])) i += 1
      // Range syntax requires a colon after the first ref segment.
      if (input[i] === ':') {
        i += 1
        while (i < input.length && /[A-Za-z0-9$]/.test(input[i])) i += 1
        const range = parseRangeRef(input.slice(start, i))
        if (!range) return null
        tokens.push({ kind: 'range', ref: range })
        continue
      }
      // Structured reference: IDENT '[' ... ']' (Excel Table, #32). Combined
      // qualifiers (`[[#Data],[Col]]`) and cross-sheet Table refs are not
      // resolvable in the single-sheet static evaluator — they fall through to
      // an honest `#ERROR!` (via `null`) instead of a faked value.
      if (input[i] === '[') {
        const scanned = scanStructuredRef(input, start, i)
        if (!scanned) return null
        if (!pushStructured(scanned.tableName, scanned.inner)) return null
        i = scanned.endIndex
        continue
      }
      const text = input.slice(start, i).toUpperCase()
      // Function name (followed by '(').
      if (FUNCTION_NAMES.has(text) && input[i] === '(') {
        tokens.push({ kind: 'func', name: text })
        continue
      }
      // Bare TRUE/FALSE → numeric literal (Excel parity).
      if (BARE_LITERALS[text] !== undefined) {
        tokens.push({ kind: 'number', value: BARE_LITERALS[text] })
        continue
      }
      const cell = parseCellRef(text)
      if (cell) {
        tokens.push({ kind: 'cell', ref: cell })
        continue
      }
      return null
    }
    // Error literal — 13 Excel error tokens aligned with excel/rust/wasm.
    if (ch === '#') {
      const match = ERROR_LITERAL_RE.exec(input.slice(i))
      if (match) {
        tokens.push({ kind: 'error', code: match[0] })
        i += match[0].length
        continue
      }
      return null
    }
    return null
  }
  return tokens
}

type Value = number | string

function isErr(v: Value): boolean {
  return typeof v === 'string' && v.startsWith('#')
}

function isTruthy(v: Value): boolean {
  if (isErr(v)) return false
  if (typeof v === 'number') return v !== 0
  // After number narrowing, v is string. Non-error strings are truthy if
  // non-empty and not literally "false" (case-insensitive).
  const str = v as string
  return str.length > 0 && str.toLowerCase() !== 'false'
}

class Parser {
  private pos = 0

  constructor(
    private readonly tokens: Token[],
    private readonly resolve: (row: number, col: number) => Value,
    /**
     * Is the cell truly empty? `resolve` folds a blank to `0`, which is right
     * for SUM but wrong for the SUBTOTAL family (the engine sees `Value::Null`
     * and skips it, so a blank must not sink MIN or inflate COUNT).
     */
    private readonly isBlank: (row: number, col: number) => boolean = () => false,
    /** MANUALLY hidden rows — consumed by SUBTOTAL 101-111 only. */
    private readonly hiddenRows: ReadonlySet<number> | undefined = undefined,
    /** FILTER-hidden rows — consumed by SUBTOTAL 1-11 AND 101-111. */
    private readonly filterHiddenRows: ReadonlySet<number> | undefined = undefined,
  ) {}

  parse(): Value {
    const value = this.parseComparison()
    if (this.pos < this.tokens.length) return '#ERROR!'
    return value
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private parseComparison(): Value {
    let left = this.parseAdditive()
    while (this.peek()?.kind === 'cmp') {
      const op = (this.tokens[this.pos] as { op: string }).op
      this.pos += 1
      const right = this.parseAdditive()
      left = this.combineCompare(op, left, right)
    }
    return left
  }

  private parseAdditive(): Value {
    let left = this.parseMultiplicative()
    while (this.peek()?.kind === 'op' && '+-'.includes((this.peek() as { op: string }).op)) {
      const op = (this.tokens[this.pos] as { op: string }).op
      this.pos += 1
      const right = this.parseMultiplicative()
      left = this.combine(op, left, right)
    }
    return left
  }

  private parseMultiplicative(): Value {
    let left = this.parseExponent()
    while (this.peek()?.kind === 'op' && '*/'.includes((this.peek() as { op: string }).op)) {
      const op = (this.tokens[this.pos] as { op: string }).op
      this.pos += 1
      const right = this.parseExponent()
      left = this.combine(op, left, right)
    }
    return left
  }

  private parseExponent(): Value {
    let left = this.parseUnary()
    while (this.peek()?.kind === 'op' && (this.peek() as { op: string }).op === '^') {
      this.pos += 1
      const right = this.parseUnary()
      left = this.combine('^', left, right)
    }
    return left
  }

  private parseUnary(): Value {
    const tok = this.peek()
    if (tok?.kind === 'op' && (tok.op === '-' || tok.op === '+')) {
      this.pos += 1
      const inner = this.parseUnary()
      if (typeof inner !== 'number') return inner
      return tok.op === '-' ? -inner : inner
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Value {
    const tok = this.tokens[this.pos]
    if (!tok) return '#ERROR!'
    if (tok.kind === 'number') {
      this.pos += 1
      return tok.value
    }
    if (tok.kind === 'string') {
      this.pos += 1
      return tok.value
    }
    if (tok.kind === 'error') {
      // A resolvable structured reference that evaluates to an Excel error
      // (`#NAME?` unknown table, `#REF!` unknown column / missing totals row)
      // — or an error literal (#REF!, #N/A, etc.).
      this.pos += 1
      return tok.code
    }
    if (tok.kind === 'lparen') {
      this.pos += 1
      const value = this.parseComparison()
      if (this.tokens[this.pos]?.kind !== 'rparen') return '#ERROR!'
      this.pos += 1
      return value
    }
    if (tok.kind === 'cell') {
      this.pos += 1
      return this.resolve(tok.ref.row, tok.ref.col)
    }
    if (tok.kind === 'range') {
      // Value context. A 1×1 range collapses to its single cell — that is the
      // whole point of `=[@Price]*[@Qty]` inside a Table row. A WIDER range
      // would need spill (or Excel's implicit intersection), neither of which
      // the static evaluator models, so it stays an honest `#ERROR!` rather
      // than silently picking a corner value.
      const { rowStart, rowEnd, colStart, colEnd } = tok.ref
      if (rowStart !== rowEnd || colStart !== colEnd) return '#ERROR!'
      this.pos += 1
      return this.resolve(rowStart, colStart)
    }
    if (tok.kind === 'func') {
      this.pos += 1
      if (this.tokens[this.pos]?.kind !== 'lparen') return '#ERROR!'
      this.pos += 1
      const args = this.parseArgList()
      if (this.tokens[this.pos]?.kind !== 'rparen') return '#ERROR!'
      this.pos += 1
      return this.applyFunction(tok.name, args)
    }
    return '#ERROR!'
  }

  private parseArgList(): Array<Value | RangeRef> {
    const args: Array<Value | RangeRef> = []
    if (this.peek()?.kind === 'rparen') return args
    while (true) {
      const tok = this.peek()
      if (tok?.kind === 'range') {
        this.pos += 1
        args.push(tok.ref)
      } else {
        args.push(this.parseComparison())
      }
      if (this.peek()?.kind !== 'comma') break
      this.pos += 1
    }
    return args
  }

  private combine(op: string, left: Value, right: Value): Value {
    if (isErr(left)) return left
    if (isErr(right)) return right
    if (typeof left === 'string' || typeof right === 'string') {
      // Arithmetic on strings (other than via CONCAT) is invalid.
      return '#VALUE!'
    }
    switch (op) {
      case '+':
        return left + right
      case '-':
        return left - right
      case '*':
        return left * right
      case '/':
        if (right === 0) return '#DIV/0!'
        return left / right
      case '^':
        return Math.pow(left, right)
      default:
        return '#ERROR!'
    }
  }

  private combineCompare(op: string, left: Value, right: Value): Value {
    if (isErr(left)) return left
    if (isErr(right)) return right
    // Excel compares mixed string + number with strings always greater than
    // numbers; we keep it simple: same-kind comparison only.
    if (typeof left !== typeof right) return 0
    let result = false
    switch (op) {
      case '=':
        result = left === right
        break
      case '<>':
        result = left !== right
        break
      case '<':
        result = left < right
        break
      case '<=':
        result = left <= right
        break
      case '>':
        result = left > right
        break
      case '>=':
        result = left >= right
        break
      default:
        return '#ERROR!'
    }
    return result ? 1 : 0
  }

  private applyFunction(name: string, args: Array<Value | RangeRef>): Value {
    switch (name) {
      case 'IF':
        return applyIf(args)
      case 'SUMIF':
        return applySumIf(args, this.resolve)
      case 'COUNTIF':
        return applyCountIf(args, this.resolve)
      case 'ABS': {
        const n = takeScalar(args, 0)
        if (typeof n !== 'number') return isErr(n) ? n : '#VALUE!'
        return Math.abs(n)
      }
      case 'ROUND': {
        const n = takeScalar(args, 0)
        const digits = takeScalar(args, 1)
        if (typeof n !== 'number' || typeof digits !== 'number') return '#VALUE!'
        const factor = Math.pow(10, Math.trunc(digits))
        return Math.round(n * factor) / factor
      }
      case 'CONCAT': {
        let out = ''
        for (const arg of args) {
          if (typeof arg === 'object') {
            // Range — concat row-major.
            for (let row = arg.rowStart; row <= arg.rowEnd; row += 1) {
              for (let col = arg.colStart; col <= arg.colEnd; col += 1) {
                const v = this.resolve(row, col)
                if (isErr(v)) return v
                out += String(v)
              }
            }
            continue
          }
          if (isErr(arg)) return arg
          out += String(arg)
        }
        return out
      }
      case 'AND':
        return applyBooleanReduce(args, this.resolve, true)
      case 'OR':
        return applyBooleanReduce(args, this.resolve, false)
      case 'NOT': {
        const v = takeScalar(args, 0)
        if (isErr(v)) return v
        return isTruthy(v) ? 0 : 1
      }
      case 'LEN': {
        const v = takeScalar(args, 0)
        if (isErr(v)) return v
        return String(v).length
      }
      case 'LOWER': {
        const v = takeScalar(args, 0)
        if (isErr(v)) return v
        return String(v).toLowerCase()
      }
      case 'UPPER': {
        const v = takeScalar(args, 0)
        if (isErr(v)) return v
        return String(v).toUpperCase()
      }
      case 'TRIM': {
        const v = takeScalar(args, 0)
        if (isErr(v)) return v
        // Excel TRIM strips leading/trailing and collapses internal runs of
        // spaces to single spaces.
        return String(v).replace(/\s+/g, ' ').trim()
      }
      case 'SQRT': {
        const n = takeScalar(args, 0)
        if (typeof n !== 'number') return isErr(n) ? n : '#VALUE!'
        if (n < 0) return '#NUM!'
        return Math.sqrt(n)
      }
      case 'MOD': {
        const n = takeScalar(args, 0)
        const divisor = takeScalar(args, 1)
        if (typeof n !== 'number' || typeof divisor !== 'number') return '#VALUE!'
        if (divisor === 0) return '#DIV/0!'
        return n - Math.floor(n / divisor) * divisor
      }
      case 'VLOOKUP':
        return applyVlookup(args, this.resolve)
      case 'SUBTOTAL':
        return applySubtotal(
          args,
          this.resolve,
          this.isBlank,
          this.hiddenRows,
          this.filterHiddenRows,
        )
      // SUM-like aggregations fall through.
      default:
        return aggregateNumeric(name, args, this.resolve)
    }
  }
}

function applyBooleanReduce(
  args: Array<Value | RangeRef>,
  resolve: (row: number, col: number) => Value,
  isAnd: boolean,
): Value {
  const result = isAnd
  let sawAny = false
  for (const arg of args) {
    if (typeof arg === 'object') {
      for (let row = arg.rowStart; row <= arg.rowEnd; row += 1) {
        for (let col = arg.colStart; col <= arg.colEnd; col += 1) {
          const v = resolve(row, col)
          if (isErrLocal(v)) return v
          sawAny = true
          const truthy = isTruthy(v)
          if (isAnd) {
            if (!truthy) return 0
          } else {
            if (truthy) return 1
          }
        }
      }
      continue
    }
    if (isErrLocal(arg)) return arg
    sawAny = true
    const truthy = isTruthy(arg)
    if (isAnd) {
      if (!truthy) return 0
    } else {
      if (truthy) return 1
    }
  }
  if (!sawAny) return '#VALUE!'
  return isAnd ? (result ? 1 : 0) : 0
}

function takeScalar(args: Array<Value | RangeRef>, index: number): Value {
  const arg = args[index]
  if (arg === undefined) return '#VALUE!'
  if (typeof arg === 'object') return '#VALUE!'
  return arg
}

function isErrLocal(v: Value): boolean {
  return typeof v === 'string' && v.startsWith('#')
}

function applyIf(args: Array<Value | RangeRef>): Value {
  const cond = args[0]
  const ifTrue = args[1]
  const ifFalse = args.length > 2 ? args[2] : 0
  if (cond === undefined || ifTrue === undefined) return '#VALUE!'
  if (typeof cond === 'object') return '#VALUE!'
  if (isErrLocal(cond)) return cond
  const branch = isTruthy(cond) ? ifTrue : ifFalse
  if (typeof branch === 'object') return '#VALUE!'
  return branch
}

interface Criteria {
  match: (v: Value) => boolean
}

function parseCriteria(raw: Value | RangeRef): Criteria | string {
  if (typeof raw === 'object') return '#VALUE!'
  if (typeof raw === 'string' && raw.startsWith('#')) return raw
  if (typeof raw === 'number') {
    const target = raw
    return { match: (v: Value) => typeof v === 'number' && v === target }
  }
  const text: string = raw
  const match = /^(>=|<=|<>|>|<|=)(.+)$/.exec(text.trim())
  if (!match) {
    return { match: (v: Value) => String(v).toLowerCase() === text.toLowerCase() }
  }
  const op = match[1]
  const rhsRaw = match[2].trim()
  const rhsNum = Number(rhsRaw)
  const rhsIsNumber = Number.isFinite(rhsNum) && rhsRaw !== ''
  return {
    match: (v: Value) => {
      if (rhsIsNumber) {
        if (typeof v !== 'number') return false
        switch (op) {
          case '>':
            return v > rhsNum
          case '<':
            return v < rhsNum
          case '>=':
            return v >= rhsNum
          case '<=':
            return v <= rhsNum
          case '=':
            return v === rhsNum
          case '<>':
            return v !== rhsNum
        }
      }
      const lhs = String(v).toLowerCase()
      const rhs = rhsRaw.toLowerCase()
      switch (op) {
        case '=':
          return lhs === rhs
        case '<>':
          return lhs !== rhs
      }
      return false
    },
  }
}

function applySumIf(
  args: Array<Value | RangeRef>,
  resolve: (row: number, col: number) => Value,
): Value {
  const range = args[0]
  const criteriaArg = args[1]
  if (typeof range !== 'object') return '#VALUE!'
  const criteria = parseCriteria(criteriaArg)
  if (typeof criteria === 'string') return criteria
  const sumRange = args.length > 2 && typeof args[2] === 'object' ? (args[2] as RangeRef) : range
  let total = 0
  const rows = range.rowEnd - range.rowStart
  const cols = range.colEnd - range.colStart
  for (let dr = 0; dr <= rows; dr += 1) {
    for (let dc = 0; dc <= cols; dc += 1) {
      const v = resolve(range.rowStart + dr, range.colStart + dc)
      if (!criteria.match(v)) continue
      const target = resolve(sumRange.rowStart + dr, sumRange.colStart + dc)
      if (isErrLocal(target)) return target
      if (typeof target === 'number') total += target
    }
  }
  return total
}

function applyCountIf(
  args: Array<Value | RangeRef>,
  resolve: (row: number, col: number) => Value,
): Value {
  const range = args[0]
  const criteriaArg = args[1]
  if (typeof range !== 'object') return '#VALUE!'
  const criteria = parseCriteria(criteriaArg)
  if (typeof criteria === 'string') return criteria
  let count = 0
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const v = resolve(row, col)
      if (criteria.match(v)) count += 1
    }
  }
  return count
}

function applyVlookup(
  args: Array<Value | RangeRef>,
  resolve: (row: number, col: number) => Value,
): Value {
  const target = args[0]
  const table = args[1]
  const colIndexArg = args[2]
  if (target === undefined || colIndexArg === undefined) return '#VALUE!'
  if (typeof target === 'object') return '#VALUE!'
  if (isErrLocal(target)) return target
  if (typeof table !== 'object') return '#VALUE!'
  if (typeof colIndexArg !== 'number') {
    if (typeof colIndexArg === 'string' && colIndexArg.startsWith('#')) return colIndexArg
    return '#VALUE!'
  }
  // Excel VLOOKUP col_index is 1-based.
  const colOffset = Math.trunc(colIndexArg) - 1
  if (colOffset < 0) return '#VALUE!'
  const tableWidth = table.colEnd - table.colStart + 1
  if (colOffset >= tableWidth) return '#REF!'
  // range_lookup defaults to TRUE in Excel; we only support FALSE (exact)
  // semantics for now — TRUE-mode approximate match needs sorted data and
  // isn't worth the complexity for the demo. Treat any 4th arg as exact.
  for (let row = table.rowStart; row <= table.rowEnd; row += 1) {
    const candidate = resolve(row, table.colStart)
    if (isErrLocal(candidate)) return candidate
    if (typeof candidate === typeof target && candidate === target) {
      const found = resolve(row, table.colStart + colOffset)
      if (isErrLocal(found)) return found
      return found
    }
    // Excel-style case-insensitive string match.
    if (
      typeof candidate === 'string' &&
      typeof target === 'string' &&
      candidate.toLowerCase() === target.toLowerCase()
    ) {
      const found = resolve(row, table.colStart + colOffset)
      if (isErrLocal(found)) return found
      return found
    }
  }
  return '#N/A'
}

/**
 * SUBTOTAL(function_num, ref1, [ref2…]) — the TS mirror of the engine
 * `fn_subtotal` / `run_subtotal` (excel/rust/excel-core/src/eval.rs). This is what
 * makes an Excel Table totals row work on the static backend, because every
 * generated totals formula is `=SUBTOTAL(1xx, Table[Col])`.
 *
 * Function numbers: 1-11 aggregate every referenced cell; **101-111 share the
 * same accumulators but drop the host's hidden rows** (design-excel-table §6).
 * Anything else is `#VALUE!`, matching the engine's `InvalidValue`.
 *
 *   1/101 AVERAGE   2/102 COUNT (numbers)   3/103 COUNTA (non-empty)
 *   4/104 MAX       5/105 MIN               6/106 PRODUCT
 *   7/107 STDEV     8/108 STDEVP           9/109 SUM
 *  10/110 VAR      11/111 VARP
 *
 * Error propagation deliberately mirrors the engine arm-for-arm: the numeric
 * reducers (1/4/5/6/9) surface the first error they meet, while the counters
 * (2/3) and the deviation family (7/8/10/11) only pattern-match the value
 * kinds they care about and therefore ignore errors.
 *
 * TWO hidden-row inputs, never merged, mirroring the engine's
 * `eval_hidden_rows` / `eval_filter_hidden_rows` split
 * (`design-filter-hidden-rows` §6.2-§6.3):
 *
 *  - `hiddenRows` — MANUALLY hidden rows. Excluded by 101-111 only; 1-11
 *    deliberately INCLUDE them, which is Excel's rule and the reason a single
 *    merged set cannot express this function.
 *  - `filterHiddenRows` — rows removed by an ACTIVE FILTER. Excluded by BOTH
 *    bands. Until this input existed, `SUBTOTAL(1-11)` summed filtered-out
 *    rows and diverged from Excel; that was a bug, not a deferral.
 *
 * A row in both sets is skipped once (membership tests, not a union
 * allocation — same streaming shape as the engine's `for_each_subtotal_value`).
 * Both hosts are pinned to this matrix by the `filterHidden` phase of
 * vnext-table-totals-static-wasm-parity.
 */
function applySubtotal(
  args: Array<Value | RangeRef>,
  resolve: (row: number, col: number) => Value,
  isBlank: (row: number, col: number) => boolean,
  hiddenRows: ReadonlySet<number> | undefined,
  filterHiddenRows: ReadonlySet<number> | undefined,
): Value {
  if (args.length < 2) return '#ARGS!'
  const rawFn = args[0]
  if (typeof rawFn === 'object') return '#TYPE!'
  if (isErrLocal(rawFn)) return rawFn
  const asNumber = typeof rawFn === 'number' ? rawFn : Number(rawFn)
  if (!Number.isFinite(asNumber)) return '#TYPE!'
  const code = Math.trunc(asNumber)
  let mode: number
  // Both bands exclude FILTER-hidden rows; only 101-111 additionally exclude
  // MANUALLY hidden ones. Named for what it now decides, since the filter set
  // is no longer conditional on the band.
  let alsoIgnoreManualHidden: boolean
  if (code >= 1 && code <= 11) {
    mode = code
    alsoIgnoreManualHidden = false
  } else if (code >= 101 && code <= 111) {
    mode = code - 100
    alsoIgnoreManualHidden = true
  } else {
    return '#VALUE!'
  }

  // Stream every data argument once, skipping blanks (the engine's
  // `Value::Null`), filter-hidden rows, and — for 101-111 — manually hidden
  // rows as well.
  const walk = (visit: (v: Value) => void): void => {
    for (const arg of args.slice(1)) {
      if (typeof arg !== 'object') {
        visit(arg)
        continue
      }
      for (let row = arg.rowStart; row <= arg.rowEnd; row += 1) {
        if (filterHiddenRows?.has(row)) continue
        if (alsoIgnoreManualHidden && hiddenRows?.has(row)) continue
        for (let col = arg.colStart; col <= arg.colEnd; col += 1) {
          if (isBlank(row, col)) continue
          visit(resolve(row, col))
        }
      }
    }
  }

  // COUNTA counts every non-blank value (errors and text included).
  if (mode === 3) {
    let count = 0
    walk(() => {
      count += 1
    })
    return count
  }
  // COUNT counts numbers only and never propagates an error.
  if (mode === 2) {
    let count = 0
    walk((v) => {
      if (typeof v === 'number') count += 1
    })
    return count
  }
  // STDEV / STDEVP / VAR / VARP collect numbers and ignore everything else.
  if (mode === 7 || mode === 8 || mode === 10 || mode === 11) {
    const numbers: number[] = []
    walk((v) => {
      if (typeof v === 'number') numbers.push(v)
    })
    const isSample = mode === 7 || mode === 10
    if (numbers.length < (isSample ? 2 : 1)) return '#DIV/0!'
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length
    const denom = isSample ? numbers.length - 1 : numbers.length
    const variance = numbers.reduce((acc, x) => acc + (x - mean) ** 2, 0) / denom
    return mode === 7 || mode === 8 ? Math.sqrt(variance) : variance
  }

  // AVERAGE / MAX / MIN / PRODUCT / SUM — first error wins.
  let error: string | null = null
  const numbers: number[] = []
  walk((v) => {
    if (error !== null) return
    if (isErrLocal(v)) {
      error = v as string
      return
    }
    if (typeof v === 'number') numbers.push(v)
  })
  if (error !== null) return error
  switch (mode) {
    case 1:
      if (numbers.length === 0) return '#DIV/0!'
      return numbers.reduce((a, b) => a + b, 0) / numbers.length
    case 4:
      return numbers.length === 0 ? 0 : Math.max(...numbers)
    case 5:
      return numbers.length === 0 ? 0 : Math.min(...numbers)
    case 6:
      return numbers.length === 0 ? 0 : numbers.reduce((a, b) => a * b, 1)
    default:
      return numbers.reduce((a, b) => a + b, 0)
  }
}

function aggregateNumeric(
  name: string,
  args: Array<Value | RangeRef>,
  resolve: (row: number, col: number) => Value,
): Value {
  const numbers: number[] = []
  for (const arg of args) {
    if (typeof arg === 'object') {
      for (let row = arg.rowStart; row <= arg.rowEnd; row += 1) {
        for (let col = arg.colStart; col <= arg.colEnd; col += 1) {
          const v = resolve(row, col)
          if (typeof v === 'string') {
            if (name === 'COUNT') continue
            if (isErrLocal(v)) return v
            continue
          }
          numbers.push(v)
        }
      }
      continue
    }
    if (isErrLocal(arg)) return arg
    if (typeof arg === 'number') numbers.push(arg)
  }
  switch (name) {
    case 'SUM':
      return numbers.reduce((a, b) => a + b, 0)
    case 'AVERAGE':
      if (numbers.length === 0) return '#DIV/0!'
      return numbers.reduce((a, b) => a + b, 0) / numbers.length
    case 'COUNT':
      return numbers.length
    case 'MIN':
      return numbers.length === 0 ? 0 : Math.min(...numbers)
    case 'MAX':
      return numbers.length === 0 ? 0 : Math.max(...numbers)
    default:
      return '#ERROR!'
  }
}

/**
 * Evaluate a formula string (with leading '=') against a cell lookup. Returns
 * the numeric result, or an error code string starting with '#'. Tracks the
 * call stack to break cycles.
 *
 * `origin` is the cell the formula lives in — the anchor a table-less `[Col]`
 * resolves its Table from and the row `[@Col]` intersects. Callers that
 * evaluate a real sheet cell should always pass it; omitting it makes every
 * this-row form `#VALUE!` (engine parity with `current_cell() -> None`).
 */
export function evaluateFormula(
  formula: string,
  lookup: EvalCellLookup,
  stack: Set<string> = new Set(),
  origin?: EvalOrigin,
): Value {
  const body = formula.startsWith('=') ? formula.slice(1) : formula
  const tokens = tokenize(body, lookup.resolveStructuredRef, origin)
  if (!tokens) return '#ERROR!'
  const parser = new Parser(
    tokens,
    (row, col) => resolveCellValue(lookup, row, col, stack),
    (row, col) => isBlankCell(lookup, row, col),
    lookup.hiddenRows,
    lookup.filterHiddenRows,
  )
  return parser.parse()
}

/** True when the cell holds neither a formula nor any primitive text/number. */
function isBlankCell(lookup: EvalCellLookup, row: number, col: number): boolean {
  const cell = lookup.get(row, col)
  if (!cell) return true
  if (cell.formula) return false
  return cell.displayValue === ''
}

function resolveCellValue(
  lookup: EvalCellLookup,
  row: number,
  col: number,
  stack: Set<string>,
): Value {
  const key = `${row}:${col}`
  if (stack.has(key)) return '#CYCLE!'
  const cell = lookup.get(row, col)
  if (!cell) return 0
  if (cell.formula) {
    stack.add(key)
    // A referenced cell's own formula re-anchors on THAT cell, so its
    // `[@Col]` intersects its own row, not the referrer's.
    const result = evaluateFormula(cell.formula, lookup, stack, { row, col })
    stack.delete(key)
    return result
  }
  if (cell.valueKind === 'number') {
    if (Number.isFinite(cell.numericValue)) return cell.numericValue!
    const n = Number(cell.displayValue)
    return Number.isFinite(n) ? n : 0
  }
  if (cell.displayValue === '') return 0
  const n = Number(cell.displayValue)
  return Number.isFinite(n) ? n : cell.displayValue
}

export function formatEvalResult(result: Value): { display: string; isError: boolean } {
  if (typeof result === 'string' && result.startsWith('#')) {
    return { display: result, isError: true }
  }
  if (typeof result === 'number') {
    if (Number.isInteger(result)) return { display: String(result), isError: false }
    // Trim to 6 significant decimals to avoid float noise.
    const rounded = Math.round(result * 1e6) / 1e6
    return { display: String(rounded), isError: false }
  }
  return { display: String(result), isError: false }
}

/**
 * Structured-reference formula-text rewrite spec for a Table rename or a
 * Table-column rename (#32, design-excel-table §4.3). `fromUpper` /
 * `tableUpper` are uppercased match keys; `to` keeps its display casing.
 */
export type StructuredRefRewriteSpec =
  | { readonly kind: 'rename-table'; readonly fromUpper: string; readonly to: string }
  | {
      readonly kind: 'rename-column'
      readonly tableUpper: string
      readonly fromUpper: string
      readonly to: string
    }

function isRewriteIdentStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
}

function isRewriteIdentChar(ch: string): boolean {
  return /[A-Za-z0-9$]/.test(ch)
}

/** Rewrite a column token inside a structured-ref's inner text. */
function rewriteColumnInInner(inner: string, fromUpper: string, to: string): string {
  if (inner.includes('[')) {
    // Bracketed column segments (`[Col]`, `[[A]:[B]]`). `#special` and `@`
    // segments never match a column key, so they pass through untouched.
    return inner.replace(/\[([^[\]]*)\]/g, (match, seg: string) =>
      seg.trim().toUpperCase() === fromUpper ? `[${to}]` : match,
    )
  }
  const trimmed = inner.trim()
  if (trimmed.startsWith('#') || trimmed.startsWith('@')) return inner
  return trimmed.toUpperCase() === fromUpper ? to : inner
}

/**
 * Rewrite `Table[...]` structured references in one formula string per `spec`
 * (design-excel-table §4.3) — the static mirror of the engine's cross-sheet
 * formula-text rewrite. String literals are copied verbatim so a Table name
 * inside `"..."` is never touched. Only the bracket-form `Table[...]` is
 * rewritten (the bare `Table` name is a cell-ref-shaped token the static
 * tokenizer never treats as a Table).
 */
export function rewriteStructuredRefsInFormula(
  formula: string,
  spec: StructuredRefRewriteSpec,
): string {
  let out = ''
  let i = 0
  while (i < formula.length) {
    const ch = formula[i]
    if (ch === '"') {
      const start = i
      i += 1
      while (i < formula.length && formula[i] !== '"') i += 1
      if (i < formula.length) i += 1 // include the closing quote
      out += formula.slice(start, i)
      continue
    }
    if (isRewriteIdentStart(ch)) {
      const start = i
      i += 1
      while (i < formula.length && isRewriteIdentChar(formula[i])) i += 1
      const ident = formula.slice(start, i)
      if (formula[i] === '[') {
        const scanned = scanStructuredRef(formula, start, i)
        if (scanned) {
          if (spec.kind === 'rename-table' && ident.toUpperCase() === spec.fromUpper) {
            out += `${spec.to}[${scanned.inner}]`
          } else if (spec.kind === 'rename-column' && ident.toUpperCase() === spec.tableUpper) {
            out += `${ident}[${rewriteColumnInInner(scanned.inner, spec.fromUpper, spec.to)}]`
          } else {
            out += formula.slice(start, scanned.endIndex)
          }
          i = scanned.endIndex
          continue
        }
      }
      out += ident
      continue
    }
    out += ch
    i += 1
  }
  return out
}
