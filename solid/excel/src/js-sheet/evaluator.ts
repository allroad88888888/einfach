import { expandRange, normalizeAddr } from './address'
import {
  booleanCell,
  cellToDisplay,
  coerceToNumber,
  errorCell,
  nullCell,
  numberCell,
  textCell,
} from './cell-value'
import { parseFormula } from './parser'
import type { CellRecord, Expr } from './types'

type EvaluatorState = {
  cells: Map<string, CellRecord>
  formulas: Map<string, string>
}

type ComparisonOperator = '=' | '<>' | '<' | '<=' | '>' | '>='

type Criterion = {
  op: ComparisonOperator
  value: CellRecord
}

export function createEvaluator({ cells, formulas }: EvaluatorState) {
  function getPrimitiveCell(addr: string): CellRecord {
    return cells.get(addr) ?? nullCell()
  }

  function computeCell(addr: string, visiting: Set<string>): CellRecord {
    const normalized = normalizeAddr(addr)
    const formula = formulas.get(normalized)
    if (!formula) {
      return getPrimitiveCell(normalized)
    }

    if (visiting.has(normalized)) {
      return errorCell('#CYCLE!')
    }

    visiting.add(normalized)
    const expr = parseFormula(formula)
    const result = expr ? evalExpr(expr, visiting) : errorCell('#VALUE!')
    visiting.delete(normalized)
    return result
  }

  function collectArgValues(arg: Expr, visiting: Set<string>): CellRecord[] {
    if (arg.kind === 'range') {
      if (arg.start.invalid || arg.end.invalid) {
        return [errorCell('#REF!')]
      }
      return expandRange(arg.start.addr, arg.end.addr).map((addr) => computeCell(addr, visiting))
    }
    return [evalExpr(arg, visiting)]
  }

  function evalExpr(expr: Expr, visiting: Set<string>): CellRecord {
    switch (expr.kind) {
      case 'number':
        return numberCell(expr.value)
      case 'text':
        return textCell(expr.value)
      case 'boolean':
        return booleanCell(expr.value)
      case 'error':
        return errorCell(expr.value)
      case 'cell':
        if (expr.ref.invalid) {
          return errorCell('#REF!')
        }
        return computeCell(expr.ref.addr, visiting)
      case 'range':
        return errorCell('#VALUE!')
      case 'negate': {
        const value = evalExpr(expr.expr, visiting)
        if (value.type === 'error') return value
        const number = coerceToNumber(value)
        return number === null ? errorCell('#VALUE!') : numberCell(-number)
      }
      case 'binop': {
        const left = evalExpr(expr.left, visiting)
        if (left.type === 'error') return left
        const right = evalExpr(expr.right, visiting)
        if (right.type === 'error') return right
        return evalBinOp(expr.op, left, right)
      }
      case 'func':
        return evalFunc(expr.name, expr.args, visiting)
    }
  }

  function evalFunc(name: string, args: Expr[], visiting: Set<string>): CellRecord {
    switch (name) {
      case 'SUM':
        return sumFunc(args, visiting)
      case 'AVERAGE':
        return averageFunc(args, visiting)
      case 'COUNT':
        return countFunc(args, visiting)
      case 'IF':
        return ifFunc(args, visiting)
      case 'MIN':
        return minMaxFunc(args, visiting, 'min')
      case 'MAX':
        return minMaxFunc(args, visiting, 'max')
      case 'AND':
        return logicalFunc(args, visiting, 'and')
      case 'OR':
        return logicalFunc(args, visiting, 'or')
      case 'NOT':
        return notFunc(args, visiting)
      case 'ABS':
        return unaryNumberFunc(args, visiting, (value) => numberCell(Math.abs(value)))
      case 'ROUND':
        return roundFunc(args, visiting)
      case 'CEILING':
        return ceilingFloorFunc(args, visiting, 'ceil')
      case 'FLOOR':
        return ceilingFloorFunc(args, visiting, 'floor')
      case 'SQRT':
        return unaryNumberFunc(args, visiting, (value) => value < 0 ? errorCell('#VALUE!') : numberCell(Math.sqrt(value)))
      case 'POWER':
        return binaryNumberFunc(args, visiting, (left, right) => numberCell(left ** right))
      case 'MOD':
        return binaryNumberFunc(args, visiting, (left, right) => {
          if (right === 0) return errorCell('#DIV/0!')
          return numberCell(left - right * Math.floor(left / right))
        })
      case 'CONCATENATE':
        return concatenateFunc(args, visiting)
      case 'LEN':
        return unaryTextFunc(args, visiting, (value) => numberCell(Array.from(value).length))
      case 'LEFT':
        return leftRightFunc(args, visiting, 'left')
      case 'RIGHT':
        return leftRightFunc(args, visiting, 'right')
      case 'MID':
        return midFunc(args, visiting)
      case 'UPPER':
        return unaryTextFunc(args, visiting, (value) => textCell(value.toUpperCase()))
      case 'LOWER':
        return unaryTextFunc(args, visiting, (value) => textCell(value.toLowerCase()))
      case 'TRIM':
        return unaryTextFunc(args, visiting, (value) => textCell(value.trim().split(/\s+/).filter(Boolean).join(' ')))
      case 'TEXT':
        return textFormatFunc(args, visiting)
      case 'COUNTIF':
        return countifFunc(args, visiting)
      case 'SUMIF':
        return sumifFunc(args, visiting)
      default:
        return errorCell('#NAME?')
    }
  }

  function sumFunc(args: Expr[], visiting: Set<string>): CellRecord {
    let total = 0
    for (const arg of args) {
      for (const value of collectArgValues(arg, visiting)) {
        if (value.type === 'error') return value
        if (value.type === 'number') total += value.value as number
        if (value.type === 'boolean' && value.value) total += 1
      }
    }
    return numberCell(total)
  }

  function averageFunc(args: Expr[], visiting: Set<string>): CellRecord {
    let total = 0
    let count = 0
    for (const arg of args) {
      for (const value of collectArgValues(arg, visiting)) {
        if (value.type === 'error') return value
        if (value.type === 'number') {
          total += value.value as number
          count += 1
        }
      }
    }
    return count === 0 ? errorCell('#DIV/0!') : numberCell(total / count)
  }

  function countFunc(args: Expr[], visiting: Set<string>): CellRecord {
    let count = 0
    for (const arg of args) {
      for (const value of collectArgValues(arg, visiting)) {
        if (value.type === 'number') count += 1
      }
    }
    return numberCell(count)
  }

  function ifFunc(args: Expr[], visiting: Set<string>): CellRecord {
    if (args.length < 2 || args.length > 3) return errorCell('#VALUE!')
    const condition = evalExpr(args[0], visiting)
    if (condition.type === 'error') return condition

    const truthy = coerceToBoolean(condition)
    if (truthy === null) return errorCell('#VALUE!')
    if (truthy) return evalExpr(args[1], visiting)
    return args[2] ? evalExpr(args[2], visiting) : booleanCell(false)
  }

  function minMaxFunc(args: Expr[], visiting: Set<string>, mode: 'min' | 'max'): CellRecord {
    let current: number | null = null
    for (const arg of args) {
      for (const value of collectArgValues(arg, visiting)) {
        if (value.type === 'error') return value
        if (value.type === 'number') {
          const number = value.value as number
          current = current === null
            ? number
            : mode === 'min'
              ? Math.min(current, number)
              : Math.max(current, number)
        }
      }
    }
    return numberCell(current ?? 0)
  }

  function logicalFunc(args: Expr[], visiting: Set<string>, mode: 'and' | 'or'): CellRecord {
    if (args.length === 0) return errorCell('#VALUE!')
    for (const arg of args) {
      const value = evalExpr(arg, visiting)
      if (value.type === 'error') return value
      const truthy = coerceToBoolean(value)
      if (truthy === null) return errorCell('#VALUE!')
      if (mode === 'and' && !truthy) return booleanCell(false)
      if (mode === 'or' && truthy) return booleanCell(true)
    }
    return booleanCell(mode === 'and')
  }

  function notFunc(args: Expr[], visiting: Set<string>): CellRecord {
    if (args.length !== 1) return errorCell('#VALUE!')
    const value = evalExpr(args[0], visiting)
    if (value.type === 'error') return value
    const truthy = coerceToBoolean(value)
    return truthy === null ? errorCell('#VALUE!') : booleanCell(!truthy)
  }

  function unaryNumberFunc(
    args: Expr[],
    visiting: Set<string>,
    handler: (value: number) => CellRecord,
  ): CellRecord {
    if (args.length !== 1) return errorCell('#VALUE!')
    const value = evalExpr(args[0], visiting)
    if (value.type === 'error') return value
    const number = coerceToNumber(value)
    return number === null ? errorCell('#VALUE!') : handler(number)
  }

  function binaryNumberFunc(
    args: Expr[],
    visiting: Set<string>,
    handler: (left: number, right: number) => CellRecord,
  ): CellRecord {
    if (args.length !== 2) return errorCell('#VALUE!')
    const left = evalExpr(args[0], visiting)
    if (left.type === 'error') return left
    const right = evalExpr(args[1], visiting)
    if (right.type === 'error') return right
    const leftNum = coerceToNumber(left)
    const rightNum = coerceToNumber(right)
    return leftNum === null || rightNum === null ? errorCell('#VALUE!') : handler(leftNum, rightNum)
  }

  function roundFunc(args: Expr[], visiting: Set<string>): CellRecord {
    return binaryNumberFunc(args, visiting, (value, digits) => numberCell(roundWithDigits(value, Math.trunc(digits))))
  }

  function ceilingFloorFunc(args: Expr[], visiting: Set<string>, mode: 'ceil' | 'floor'): CellRecord {
    if (args.length === 0 || args.length > 2) return errorCell('#VALUE!')

    const value = evalExpr(args[0], visiting)
    if (value.type === 'error') return value
    const number = coerceToNumber(value)
    if (number === null) return errorCell('#VALUE!')

    let significance = 1
    if (args[1]) {
      const stepValue = evalExpr(args[1], visiting)
      if (stepValue.type === 'error') return stepValue
      const parsed = coerceToNumber(stepValue)
      if (parsed === null) return errorCell('#VALUE!')
      significance = Math.abs(parsed)
    }

    if (significance === 0) return numberCell(0)
    return numberCell((mode === 'ceil' ? Math.ceil(number / significance) : Math.floor(number / significance)) * significance)
  }

  function concatenateFunc(args: Expr[], visiting: Set<string>): CellRecord {
    let output = ''
    for (const arg of args) {
      for (const value of collectArgValues(arg, visiting)) {
        if (value.type === 'error') return value
        output += cellRecordToText(value)
      }
    }
    return textCell(output)
  }

  function unaryTextFunc(
    args: Expr[],
    visiting: Set<string>,
    handler: (value: string) => CellRecord,
  ): CellRecord {
    if (args.length !== 1) return errorCell('#VALUE!')
    const value = evalExpr(args[0], visiting)
    if (value.type === 'error') return value
    return handler(cellRecordToText(value))
  }

  function leftRightFunc(args: Expr[], visiting: Set<string>, mode: 'left' | 'right'): CellRecord {
    if (args.length === 0 || args.length > 2) return errorCell('#VALUE!')
    const source = evalExpr(args[0], visiting)
    if (source.type === 'error') return source
    const text = cellRecordToText(source)

    let count = 1
    if (args[1]) {
      const value = evalExpr(args[1], visiting)
      if (value.type === 'error') return value
      const parsed = coerceToNumber(value)
      if (parsed === null || parsed < 0) return errorCell('#VALUE!')
      count = Math.trunc(parsed)
    }

    const chars = Array.from(text)
    return textCell(
      mode === 'left'
        ? chars.slice(0, count).join('')
        : chars.slice(Math.max(chars.length - count, 0)).join(''),
    )
  }

  function midFunc(args: Expr[], visiting: Set<string>): CellRecord {
    if (args.length !== 3) return errorCell('#VALUE!')

    const source = evalExpr(args[0], visiting)
    if (source.type === 'error') return source
    const start = evalExpr(args[1], visiting)
    if (start.type === 'error') return start
    const length = evalExpr(args[2], visiting)
    if (length.type === 'error') return length

    const startValue = coerceToNumber(start)
    const lengthValue = coerceToNumber(length)
    if (startValue === null || lengthValue === null || startValue < 1 || lengthValue < 0) {
      return errorCell('#VALUE!')
    }

    const chars = Array.from(cellRecordToText(source))
    const begin = Math.trunc(startValue) - 1
    return textCell(chars.slice(begin, begin + Math.trunc(lengthValue)).join(''))
  }

  function textFormatFunc(args: Expr[], visiting: Set<string>): CellRecord {
    if (args.length !== 2) return errorCell('#VALUE!')

    const rawValue = evalExpr(args[0], visiting)
    if (rawValue.type === 'error') return rawValue
    const number = coerceToNumber(rawValue)
    if (number === null) return errorCell('#VALUE!')

    const rawFormat = evalExpr(args[1], visiting)
    if (rawFormat.type === 'error') return rawFormat
    const formatted = applyTextFormat(number, cellRecordToText(rawFormat))
    return formatted === null ? errorCell('#VALUE!') : textCell(formatted)
  }

  function countifFunc(args: Expr[], visiting: Set<string>): CellRecord {
    if (args.length !== 2) return errorCell('#VALUE!')
    const range = collectArgValues(args[0], visiting)
    const criterion = buildCriterion(args[1], visiting)
    if ('type' in criterion) return criterion

    let count = 0
    for (const value of range) {
      if (value.type === 'error') return value
      if (matchesCriterion(value, criterion)) count += 1
    }
    return numberCell(count)
  }

  function sumifFunc(args: Expr[], visiting: Set<string>): CellRecord {
    if (args.length < 2 || args.length > 3) return errorCell('#VALUE!')
    const criteriaRange = collectArgValues(args[0], visiting)
    const sumRange = args[2] ? collectArgValues(args[2], visiting) : criteriaRange
    const criterion = buildCriterion(args[1], visiting)
    if ('type' in criterion) return criterion

    let total = 0
    for (let index = 0; index < Math.min(criteriaRange.length, sumRange.length); index += 1) {
      const criteriaValue = criteriaRange[index]
      const sumValue = sumRange[index]
      if (criteriaValue.type === 'error') return criteriaValue
      if (sumValue.type === 'error') return sumValue
      if (!matchesCriterion(criteriaValue, criterion)) continue

      const number = coerceToNumber(sumValue)
      if (number === null) return errorCell('#VALUE!')
      total += number
    }
    return numberCell(total)
  }

  function buildCriterion(expr: Expr, visiting: Set<string>): Criterion | CellRecord {
    const raw = evalExpr(expr, visiting)
    if (raw.type === 'error') return raw
    if (raw.type !== 'text') {
      return { op: '=', value: raw }
    }

    const text = (raw.value as string).trim()
    const parsed =
      text.startsWith('<=') ? { op: '<=' as const, rest: text.slice(2) }
      : text.startsWith('>=') ? { op: '>=' as const, rest: text.slice(2) }
      : text.startsWith('<>') ? { op: '<>' as const, rest: text.slice(2) }
      : text.startsWith('<') ? { op: '<' as const, rest: text.slice(1) }
      : text.startsWith('>') ? { op: '>' as const, rest: text.slice(1) }
      : text.startsWith('=') ? { op: '=' as const, rest: text.slice(1) }
      : { op: '=' as const, rest: text }

    return {
      op: parsed.op,
      value: criterionOperand(parsed.rest.trim()),
    }
  }

  function recalcAll() {
    for (const addr of formulas.keys()) {
      cells.set(addr, computeCell(addr, new Set<string>()))
    }
  }

  function getCell(addr: string): CellRecord {
    const normalized = normalizeAddr(addr)
    if (formulas.has(normalized)) {
      const value = computeCell(normalized, new Set<string>())
      cells.set(normalized, value)
      return value
    }
    return getPrimitiveCell(normalized)
  }

  return {
    getCell,
    recalcAll,
  }
}

function evalBinOp(
  op: '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=',
  left: CellRecord,
  right: CellRecord,
): CellRecord {
  if (op === '&') {
    return textCell(cellRecordToText(left) + cellRecordToText(right))
  }

  if (op === '=' || op === '<>' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    const comparison = compareCells(left, right)
    if (comparison === null) return errorCell('#VALUE!')

    return booleanCell(
      op === '=' ? comparison === 0
      : op === '<>' ? comparison !== 0
      : op === '<' ? comparison < 0
      : op === '<=' ? comparison <= 0
      : op === '>' ? comparison > 0
      : comparison >= 0,
    )
  }

  const leftNum = coerceToNumber(left)
  const rightNum = coerceToNumber(right)
  if (leftNum === null || rightNum === null) return errorCell('#VALUE!')

  if (op === '+') return numberCell(leftNum + rightNum)
  if (op === '-') return numberCell(leftNum - rightNum)
  if (op === '*') return numberCell(leftNum * rightNum)
  if (op === '^') return numberCell(leftNum ** rightNum)
  return rightNum === 0 ? errorCell('#DIV/0!') : numberCell(leftNum / rightNum)
}

function matchesCriterion(value: CellRecord, criterion: Criterion): boolean {
  const comparison = compareCells(value, criterion.value)
  if (comparison === null) return false
  return criterion.op === '=' ? comparison === 0
    : criterion.op === '<>' ? comparison !== 0
    : criterion.op === '<' ? comparison < 0
    : criterion.op === '<=' ? comparison <= 0
    : criterion.op === '>' ? comparison > 0
    : comparison >= 0
}

function compareCells(left: CellRecord, right: CellRecord): number | null {
  if (left.type === 'text' && right.type === 'text') {
    return String(left.value).localeCompare(String(right.value))
  }
  if (left.type === 'boolean' && right.type === 'boolean') {
    return Number(Boolean(left.value)) - Number(Boolean(right.value))
  }

  const leftNum = coerceToNumber(left)
  const rightNum = coerceToNumber(right)
  if (leftNum === null || rightNum === null) return null
  return leftNum === rightNum ? 0 : leftNum < rightNum ? -1 : 1
}

function coerceToBoolean(value: CellRecord): boolean | null {
  if (value.type === 'boolean') return Boolean(value.value)
  if (value.type === 'number') return (value.value as number) !== 0
  if (value.type === 'null') return false
  return null
}

function cellRecordToText(value: CellRecord): string {
  if (value.type === 'text') return value.value as string
  return cellToDisplay(value)
}

function criterionOperand(text: string): CellRecord {
  if (text.toUpperCase() === 'TRUE') return booleanCell(true)
  if (text.toUpperCase() === 'FALSE') return booleanCell(false)
  if (text !== '' && !Number.isNaN(Number(text))) return numberCell(Number(text))
  return textCell(text)
}

function roundWithDigits(value: number, digits: number): number {
  if (digits >= 0) {
    const factor = 10 ** digits
    return Math.round(value * factor) / factor
  }
  const factor = 10 ** Math.abs(digits)
  return Math.round(value / factor) * factor
}

function applyTextFormat(value: number, formatText: string): string | null {
  if (!formatText) return ''

  const numericPattern = Array.from(formatText)
    .filter((char) => ['0', '#', '.', ','].includes(char))
    .join('')
  if (!numericPattern) return null

  const percent = formatText.includes('%')
  const decimals = numericPattern.includes('.')
    ? numericPattern.split('.')[1].replace(/[^0#]/g, '').length
    : 0
  const grouped = numericPattern.includes(',')
  const prefix = formatText.match(/^[^0#.,]*/)?.[0] ?? ''
  const suffix = formatText.match(/[^0#.,]*$/)?.[0] ?? ''

  const scaled = percent ? value * 100 : value
  const rounded = roundWithDigits(scaled, decimals)
  const sign = rounded < 0 ? '-' : ''
  const body = grouped ? formatGrouped(Math.abs(rounded), decimals) : Math.abs(rounded).toFixed(decimals)
  return `${sign}${prefix}${body}${suffix}`
}

function formatGrouped(value: number, decimals: number): string {
  const [integer, fraction] = value.toFixed(decimals).split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}
