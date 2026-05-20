/**
 * Tiny formula evaluator for the static Wave 5 demo backend.
 *
 * Supports the subset the audit specs and showcase scenarios actually exercise:
 *   - number literals (decimals, signed)
 *   - cell references: A1, $A$1
 *   - range references inside function args: B2:E8
 *   - operators: + - * / ^ with normal precedence
 *   - unary minus / plus
 *   - parentheses
 *   - functions: SUM, AVERAGE, COUNT, MIN, MAX
 *
 * Anything beyond this returns the string '#ERROR!'. Division by zero returns
 * '#DIV/0!'. Cyclic references return '#CYCLE!'. Cross-sheet refs (Sheet!A1)
 * are not supported by this evaluator — the worker backend covers those.
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
  | { kind: 'cell'; ref: { row: number; col: number } }
  | { kind: 'range'; ref: RangeRef }
  | { kind: 'func'; name: string }
  | { kind: 'op'; op: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' }

const FUNCTION_NAMES = new Set(['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX'])

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

class Parser {
  private pos = 0
  constructor(
    private readonly tokens: Token[],
    private readonly resolve: (row: number, col: number) => number | string,
  ) {}

  parse(): number | string {
    const value = this.parseAdditive()
    if (this.pos < this.tokens.length) return '#ERROR!'
    return value
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private parseAdditive(): number | string {
    let left = this.parseMultiplicative()
    while (this.peek()?.kind === 'op' && '+-'.includes((this.peek() as { op: string }).op)) {
      const op = (this.tokens[this.pos] as { op: string }).op
      this.pos += 1
      const right = this.parseMultiplicative()
      left = this.combine(op, left, right)
    }
    return left
  }

  private parseMultiplicative(): number | string {
    let left = this.parseExponent()
    while (this.peek()?.kind === 'op' && '*/'.includes((this.peek() as { op: string }).op)) {
      const op = (this.tokens[this.pos] as { op: string }).op
      this.pos += 1
      const right = this.parseExponent()
      left = this.combine(op, left, right)
    }
    return left
  }

  private parseExponent(): number | string {
    let left = this.parseUnary()
    while (this.peek()?.kind === 'op' && (this.peek() as { op: string }).op === '^') {
      this.pos += 1
      const right = this.parseUnary()
      left = this.combine('^', left, right)
    }
    return left
  }

  private parseUnary(): number | string {
    const tok = this.peek()
    if (tok?.kind === 'op' && (tok.op === '-' || tok.op === '+')) {
      this.pos += 1
      const inner = this.parseUnary()
      if (typeof inner !== 'number') return inner
      return tok.op === '-' ? -inner : inner
    }
    return this.parsePrimary()
  }

  private parsePrimary(): number | string {
    const tok = this.tokens[this.pos]
    if (!tok) return '#ERROR!'
    if (tok.kind === 'number') {
      this.pos += 1
      return tok.value
    }
    if (tok.kind === 'lparen') {
      this.pos += 1
      const value = this.parseAdditive()
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

  private parseArgList(): Array<number | string | RangeRef> {
    const args: Array<number | string | RangeRef> = []
    if (this.peek()?.kind === 'rparen') return args
    while (true) {
      const tok = this.peek()
      if (tok?.kind === 'range') {
        this.pos += 1
        args.push(tok.ref)
      } else {
        args.push(this.parseAdditive())
      }
      if (this.peek()?.kind !== 'comma') break
      this.pos += 1
    }
    return args
  }

  private combine(op: string, left: number | string, right: number | string): number | string {
    if (typeof left === 'string') return left
    if (typeof right === 'string') return right
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

  private applyFunction(name: string, args: Array<number | string | RangeRef>): number | string {
    const numbers: number[] = []
    for (const arg of args) {
      if (typeof arg === 'string') return arg
      if (typeof arg === 'number') {
        numbers.push(arg)
        continue
      }
      // Range — expand to all cell values.
      for (let row = arg.rowStart; row <= arg.rowEnd; row += 1) {
        for (let col = arg.colStart; col <= arg.colEnd; col += 1) {
          const value = this.resolve(row, col)
          if (typeof value === 'string') {
            if (name === 'COUNT') continue
            return value
          }
          numbers.push(value)
        }
      }
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
): number | string {
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
): number | string {
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
    const n = Number(cell.displayValue)
    return Number.isFinite(n) ? n : 0
  }
  if (cell.displayValue === '') return 0
  const n = Number(cell.displayValue)
  return Number.isFinite(n) ? n : cell.displayValue
}

export function formatEvalResult(result: number | string): { display: string; isError: boolean } {
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
