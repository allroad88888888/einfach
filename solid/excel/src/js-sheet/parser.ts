import { formatCellRef, isCellAddress, normalizeAddr, parseCellRef, shiftCellRef } from './address'
import type { CellRef, Expr } from './types'

type BinOp = Extract<Expr, { kind: 'binop' }>['op']

function precedence(op: BinOp): number {
  switch (op) {
    case '=':
    case '<>':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return 1
    case '&':
      return 2
    case '+':
    case '-':
      return 3
    case '*':
    case '/':
      return 4
    case '^':
      return 5
  }
  return 0
}

function formatNumber(value: number): string {
  return value === Math.floor(value) && Math.abs(value) < 1e15
    ? String(Math.trunc(value))
    : String(value)
}

function serializeExpr(expr: Expr, parentPrecedence = 0): string {
  switch (expr.kind) {
    case 'number':
      return formatNumber(expr.value)
    case 'text':
      return `"${expr.value}"`
    case 'boolean':
      return expr.value ? 'TRUE' : 'FALSE'
    case 'error':
      return expr.value
    case 'cell':
      return formatCellRef(expr.ref)
    case 'range':
      if (expr.start.sheetName && expr.start.sheetName === expr.end.sheetName) {
        const start = formatCellRef(expr.start)
        const end = formatCellRef({ ...expr.end, sheetName: undefined })
        return `${start}:${end}`
      }
      return `${formatCellRef(expr.start)}:${formatCellRef(expr.end)}`
    case 'negate': {
      const inner = serializeExpr(expr.expr, 6)
      return expr.expr.kind === 'binop' ? `-(${inner})` : `-${inner}`
    }
    case 'func':
      return `${expr.name}(${expr.args.map((arg) => serializeExpr(arg)).join(',')})`
    case 'binop': {
      const current = precedence(expr.op)
      const left = serializeExpr(expr.left, current)
      const right = serializeExpr(expr.right, current + (expr.op === '^' ? 1 : 0))
      const rendered = `${left}${expr.op}${right}`
      return current < parentPrecedence ? `(${rendered})` : rendered
    }
  }
}

function shiftExpr(expr: Expr, rowDelta: number, colDelta: number): Expr {
  switch (expr.kind) {
    case 'number':
      return { kind: 'number', value: expr.value }
    case 'text':
      return { kind: 'text', value: expr.value }
    case 'boolean':
      return { kind: 'boolean', value: expr.value }
    case 'error':
      return { kind: 'error', value: expr.value }
    case 'cell':
      return { kind: 'cell', ref: shiftCellRef(expr.ref, rowDelta, colDelta) }
    case 'range':
      return {
        kind: 'range',
        start: shiftCellRef(expr.start, rowDelta, colDelta),
        end: shiftCellRef(expr.end, rowDelta, colDelta),
      }
    case 'negate':
      return { kind: 'negate', expr: shiftExpr(expr.expr, rowDelta, colDelta) }
    case 'func':
      return {
        kind: 'func',
        name: expr.name,
        args: expr.args.map((arg) => shiftExpr(arg, rowDelta, colDelta)),
      }
    case 'binop':
      return {
        kind: 'binop',
        op: expr.op,
        left: shiftExpr(expr.left, rowDelta, colDelta),
        right: shiftExpr(expr.right, rowDelta, colDelta),
      }
  }
}

export class Parser {
  private readonly chars: string[]
  private pos = 0

  constructor(input: string) {
    this.chars = Array.from(input)
  }

  parse(): Expr | null {
    const expr = this.parseExpr()
    if (!expr) return null
    this.skipWhitespace()
    return this.pos === this.chars.length ? expr : null
  }

  private peek(): string | undefined {
    return this.chars[this.pos]
  }

  private advance(): string | undefined {
    const char = this.chars[this.pos]
    this.pos += 1
    return char
  }

  private skipWhitespace() {
    while (this.peek()?.trim() === '') {
      this.pos += 1
    }
  }

  private expect(expected: string): boolean {
    this.skipWhitespace()
    if (this.peek() !== expected) return false
    this.advance()
    return true
  }

  private parseExpr(): Expr | null {
    return this.parseComparison()
  }

  private parseComparison(): Expr | null {
    this.skipWhitespace()
    let left = this.parseConcat()
    if (!left) return null

    while (true) {
      this.skipWhitespace()
      const op = this.readComparisonOperator()
      if (!op) break
      const right = this.parseConcat()
      if (!right) return null
      left = { kind: 'binop', op, left, right }
    }

    return left
  }

  private parseConcat(): Expr | null {
    this.skipWhitespace()
    let left = this.parseAddSub()
    if (!left) return null

    while (true) {
      this.skipWhitespace()
      if (this.peek() !== '&') break
      this.advance()
      const right = this.parseAddSub()
      if (!right) return null
      left = { kind: 'binop', op: '&', left, right }
    }

    return left
  }

  private parseAddSub(): Expr | null {
    this.skipWhitespace()
    let left = this.parseTerm()
    if (!left) return null

    while (true) {
      this.skipWhitespace()
      const next = this.peek()
      if (next !== '+' && next !== '-') break
      this.advance()
      const right = this.parseTerm()
      if (!right) return null
      left = { kind: 'binop', op: next, left, right }
    }

    return left
  }

  private parseTerm(): Expr | null {
    this.skipWhitespace()
    let left = this.parsePower()
    if (!left) return null

    while (true) {
      this.skipWhitespace()
      const next = this.peek()
      if (next !== '*' && next !== '/') break
      this.advance()
      const right = this.parsePower()
      if (!right) return null
      left = { kind: 'binop', op: next, left, right }
    }

    return left
  }

  private parsePower(): Expr | null {
    this.skipWhitespace()
    const left = this.parseUnary()
    if (!left) return null

    this.skipWhitespace()
    if (this.peek() !== '^') return left
    this.advance()

    const right = this.parsePower()
    if (!right) return null
    return { kind: 'binop', op: '^', left, right }
  }

  private parseUnary(): Expr | null {
    this.skipWhitespace()
    if (this.peek() === '-') {
      this.advance()
      const expr = this.parseUnary()
      return expr ? { kind: 'negate', expr } : null
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Expr | null {
    this.skipWhitespace()
    const next = this.peek()
    if (!next) return null

    if (next === '(') {
      this.advance()
      const expr = this.parseExpr()
      if (!expr || !this.expect(')')) return null
      return expr
    }

    if (next === '"') {
      return this.parseString()
    }

    if (next === '#') {
      return this.parseErrorLiteral()
    }

    if ((next >= '0' && next <= '9') || next === '.') {
      return this.parseNumber()
    }

    if ((next >= 'A' && next <= 'Z') || (next >= 'a' && next <= 'z') || next === '$') {
      return this.parseIdentifierOrReference()
    }

    return null
  }

  private parseNumber(): Expr | null {
    const start = this.pos
    while (true) {
      const next = this.peek()
      if (!next || (!((next >= '0' && next <= '9') || next === '.'))) break
      this.advance()
    }

    const raw = this.chars.slice(start, this.pos).join('')
    const value = Number.parseFloat(raw)
    return Number.isNaN(value) ? null : { kind: 'number', value }
  }

  private parseString(): Expr | null {
    this.advance()
    const start = this.pos
    while (this.peek() !== undefined && this.peek() !== '"') {
      this.advance()
    }
    if (this.peek() !== '"') return null

    const value = this.chars.slice(start, this.pos).join('')
    this.advance()
    return { kind: 'text', value }
  }

  private parseErrorLiteral(): Expr | null {
    const candidates = ['#DIV/0!', '#REF!', '#VALUE!', '#NAME?', '#CYCLE!'] as const
    for (const candidate of candidates) {
      const chars = Array.from(candidate)
      const matches = chars.every((char, index) => this.chars[this.pos + index] === char)
      if (matches) {
        this.pos += chars.length
        return { kind: 'error', value: candidate }
      }
    }
    return null
  }

  private parseIdentifierOrReference(): Expr | null {
    const start = this.pos
    while (true) {
      const next = this.peek()
      if (!next) break
      const isAlphaNum =
        ((next >= 'A' && next <= 'Z')
          || (next >= 'a' && next <= 'z')
          || (next >= '0' && next <= '9')
          || next === '$'
          || next === '_')
      if (!isAlphaNum) break
      this.advance()
    }

    const ident = this.chars.slice(start, this.pos).join('')
    this.skipWhitespace()

    if (this.peek() === '(') {
      this.advance()
      const args = this.parseFuncArgs()
      if (!args || !this.expect(')')) return null
      return { kind: 'func', name: ident.toUpperCase(), args }
    }

    const upper = ident.toUpperCase()
    if (upper === 'TRUE' || upper === 'FALSE') {
      return { kind: 'boolean', value: upper === 'TRUE' }
    }

    let referenceToken = ident
    let sheetName: string | undefined
    if (this.peek() === '!') {
      sheetName = ident
      this.advance()
      const refStart = this.pos
      while (true) {
        const next = this.peek()
        if (!next) break
        const isAlphaNum =
          ((next >= 'A' && next <= 'Z')
            || (next >= 'a' && next <= 'z')
            || (next >= '0' && next <= '9')
            || next === '$')
        if (!isAlphaNum) break
        this.advance()
      }
      referenceToken = `${sheetName}!${this.chars.slice(refStart, this.pos).join('')}`
    }

    let reference: CellRef
    try {
      reference = parseCellRef(referenceToken)
    } catch {
      return null
    }

    this.skipWhitespace()
    if (this.peek() === ':') {
      this.advance()
      this.skipWhitespace()
      const rangeStart = this.pos
      while (true) {
        const next = this.peek()
        if (!next) break
        const isAlphaNum =
          ((next >= 'A' && next <= 'Z')
            || (next >= 'a' && next <= 'z')
            || (next >= '0' && next <= '9')
            || next === '$'
            || next === '_'
            || next === '!')
        if (!isAlphaNum) break
        this.advance()
      }

      const endRaw = this.chars.slice(rangeStart, this.pos).join('')
      let end: CellRef
      try {
        end = parseCellRef(endRaw)
      } catch {
        if (!sheetName) return null
        try {
          end = parseCellRef(`${sheetName}!${endRaw}`)
        } catch {
          return null
        }
      }
      return { kind: 'range', start: reference, end }
    }

    return { kind: 'cell', ref: reference }
  }

  private readComparisonOperator(): '=' | '<>' | '<' | '<=' | '>' | '>=' | null {
    const current = this.peek()
    const next = this.chars[this.pos + 1]

    if (current === '<' && next === '=') {
      this.pos += 2
      return '<='
    }
    if (current === '>' && next === '=') {
      this.pos += 2
      return '>='
    }
    if (current === '<' && next === '>') {
      this.pos += 2
      return '<>'
    }
    if (current === '<' || current === '>' || current === '=') {
      this.pos += 1
      return current
    }
    return null
  }

  private parseFuncArgs(): Expr[] | null {
    this.skipWhitespace()
    if (this.peek() === ')') return []

    const args: Expr[] = []
    while (true) {
      const arg = this.parseExpr()
      if (!arg) return null
      args.push(arg)

      this.skipWhitespace()
      if (this.peek() !== ',') break
      this.advance()
    }

    return args
  }
}

export function parseFormula(input: string): Expr | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('=')) return null
  return new Parser(trimmed.slice(1)).parse()
}

export function serializeFormula(expr: Expr): string {
  return `=${serializeExpr(expr)}`
}

export function shiftFormulaInput(input: string, rowDelta: number, colDelta: number): string | null {
  const parsed = parseFormula(input)
  return parsed ? serializeFormula(shiftExpr(parsed, rowDelta, colDelta)) : null
}

export function isFormulaReference(input: string): boolean {
  return isCellAddress(normalizeAddr(input))
}
