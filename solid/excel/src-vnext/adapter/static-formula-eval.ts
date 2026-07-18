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
 *     ABS, ROUND, CONCAT
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
}

function columnLabelToIndex(label: string): number {
  let result = 0
  for (let i = 0; i < label.length; i += 1) {
    result = result * 26 + (label.charCodeAt(i) - 64)
  }
  return result - 1
}

function parseCellRef(token: string): { row: number; col: number } | null {
  const stripped = token.replace(/\$/g, '')
  const match = /^([A-Z]+)(\d+)$/.exec(stripped)
  if (!match) return null
  const col = columnLabelToIndex(match[1])
  const row = Number(match[2]) - 1
  if (!Number.isInteger(row) || row < 0 || col < 0) return null
  return { row, col }
}

interface RangeRef {
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
])

/** Bare-name literals (no parens) — Excel parity for TRUE/FALSE. */
const BARE_LITERALS: Record<string, number> = {
  TRUE: 1,
  FALSE: 0,
}

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === ' ' || ch === '\t') {
      i += 1
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
  let result = isAnd
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
 */
export function evaluateFormula(
  formula: string,
  lookup: EvalCellLookup,
  stack: Set<string> = new Set(),
): Value {
  const body = formula.startsWith('=') ? formula.slice(1) : formula
  const tokens = tokenize(body)
  if (!tokens) return '#ERROR!'
  const parser = new Parser(tokens, (row, col) => resolveCellValue(lookup, row, col, stack))
  return parser.parse()
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
    const result = evaluateFormula(cell.formula, lookup, stack)
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
