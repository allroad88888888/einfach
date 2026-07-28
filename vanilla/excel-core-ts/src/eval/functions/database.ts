/**
 * Database functions (D*) over pre-evaluated Value arrays.
 *
 * The evaluator materializes range arguments as `{ kind: 'array' }`, so this
 * module implements the database / field / criteria semantics without reading
 * from `EvalContext`.
 */

import type { ErrorCode, FunctionImpl, Value } from '../../types'

type ErrorValue = Extract<Value, { kind: 'error' }>
type Matrix = ReadonlyArray<ReadonlyArray<Value>>

interface DatabaseRange {
  readonly headers: ReadonlyArray<Value>
  readonly dataRows: Matrix
  readonly cols: number
}

type ValueResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Value }

const NUM = (value: number): Value => ({ kind: 'number', value })
const ERR = (code: ErrorCode, message?: string): Value =>
  message ? { kind: 'error', code, message } : { kind: 'error', code }

function asMatrix(value: Value): ValueResult<Matrix> {
  if (value.kind === 'error') return { ok: false, error: value }
  if (value.kind !== 'array') return { ok: false, error: ERR('#VALUE!') }

  const rows = value.value
  if (rows.length === 0) return { ok: false, error: ERR('#VALUE!') }

  const cols = rows[0].length
  if (cols === 0) return { ok: false, error: ERR('#VALUE!') }

  for (const row of rows) {
    if (row.length !== cols) return { ok: false, error: ERR('#VALUE!') }
  }
  return { ok: true, value: rows }
}

function firstError(rows: Matrix): ErrorValue | undefined {
  for (const row of rows) {
    for (const cell of row) {
      if (cell.kind === 'error') return cell
    }
  }
  return undefined
}

function resolveDatabase(value: Value): ValueResult<DatabaseRange> {
  const matrix = asMatrix(value)
  if (!matrix.ok) return matrix

  const rows = matrix.value
  if (rows.length < 2) return { ok: false, error: ERR('#VALUE!') }

  const error = firstError(rows)
  if (error) return { ok: false, error }

  return {
    ok: true,
    value: {
      headers: rows[0],
      dataRows: rows.slice(1),
      cols: rows[0].length,
    },
  }
}

function resolveCriteria(value: Value): ValueResult<Matrix> {
  const matrix = asMatrix(value)
  if (!matrix.ok) return matrix

  const error = firstError(matrix.value)
  if (error) return { ok: false, error }

  return matrix
}

function coerceToText(value: Value): string {
  switch (value.kind) {
    case 'blank':
      return ''
    case 'number':
      return String(value.value)
    case 'string':
      return value.value
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE'
    case 'error':
      return value.code
    case 'array': {
      const row = value.value[0]
      return row && row.length > 0 ? coerceToText(row[0]) : ''
    }
  }
}

function resolveField(database: DatabaseRange, field: Value): ValueResult<number> {
  if (field.kind === 'error') return { ok: false, error: field }

  if (field.kind === 'number') {
    if (
      !Number.isFinite(field.value) ||
      !Number.isInteger(field.value) ||
      field.value < 1 ||
      field.value > database.cols
    ) {
      return { ok: false, error: ERR('#VALUE!') }
    }
    return { ok: true, value: field.value - 1 }
  }

  if (field.kind !== 'string') return { ok: false, error: ERR('#VALUE!') }

  const needle = field.value.toLowerCase()
  for (let col = 0; col < database.cols; col++) {
    if (coerceToText(database.headers[col]).toLowerCase() === needle) {
      return { ok: true, value: col }
    }
  }
  return { ok: false, error: ERR('#VALUE!') }
}

function resolveCriteriaColumns(
  database: DatabaseRange,
  criteria: Matrix,
): ValueResult<ReadonlyArray<number | null>> {
  const headerRow = criteria[0]
  const columns: Array<number | null> = []

  for (const header of headerRow) {
    if (header.kind === 'blank') {
      columns.push(null)
      continue
    }

    const headerText = coerceToText(header).toLowerCase()
    let found: number | null = null
    for (let col = 0; col < database.cols; col++) {
      if (coerceToText(database.headers[col]).toLowerCase() === headerText) {
        found = col
        break
      }
    }
    if (found === null) return { ok: false, error: ERR('#VALUE!') }
    columns.push(found)
  }

  return { ok: true, value: columns }
}

type Comparator = '=' | '<>' | '<' | '<=' | '>' | '>='

interface ParsedCriterion {
  readonly op: Comparator
  readonly target: Value
  readonly wildcard: boolean
  readonly textPrefix: boolean
}

function parseStringCriterion(
  raw: string,
): { readonly op: Comparator; readonly rest: string; readonly explicit: boolean } {
  if (raw.startsWith('<=')) return { op: '<=', rest: raw.slice(2), explicit: true }
  if (raw.startsWith('>=')) return { op: '>=', rest: raw.slice(2), explicit: true }
  if (raw.startsWith('<>')) return { op: '<>', rest: raw.slice(2), explicit: true }
  if (raw.startsWith('<')) return { op: '<', rest: raw.slice(1), explicit: true }
  if (raw.startsWith('>')) return { op: '>', rest: raw.slice(1), explicit: true }
  if (raw.startsWith('=')) return { op: '=', rest: raw.slice(1), explicit: true }
  return { op: '=', rest: raw, explicit: false }
}

function parseCriterion(criterion: Value): ValueResult<ParsedCriterion> {
  if (criterion.kind === 'error') return { ok: false, error: criterion }

  if (criterion.kind !== 'string') {
    let target: Value = criterion
    if (criterion.kind === 'array') {
      const row = criterion.value[0]
      target = row && row.length > 0 ? row[0] : { kind: 'blank' }
    }
    return { ok: true, value: { op: '=', target, wildcard: false, textPrefix: false } }
  }

  const { op, rest, explicit } = parseStringCriterion(criterion.value)
  const trimmed = rest.trim()
  if (trimmed.length > 0) {
    const number = Number(trimmed)
    if (Number.isFinite(number) && /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) {
      return { ok: true, value: { op, target: NUM(number), wildcard: false, textPrefix: false } }
    }

    const upper = trimmed.toUpperCase()
    if (upper === 'TRUE') {
      return {
        ok: true,
        value: { op, target: { kind: 'boolean', value: true }, wildcard: false, textPrefix: false },
      }
    }
    if (upper === 'FALSE') {
      return {
        ok: true,
        value: { op, target: { kind: 'boolean', value: false }, wildcard: false, textPrefix: false },
      }
    }
  }

  const wildcard = /[*?]/.test(rest)
  return {
    ok: true,
    value: {
      op,
      target: { kind: 'string', value: rest },
      wildcard,
      textPrefix: !explicit && !wildcard && rest.length > 0,
    },
  }
}

function wildcardMatch(text: string, pattern: string): boolean {
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '~' && i + 1 < pattern.length) {
      const next = pattern[i + 1]
      if (next === '*' || next === '?' || next === '~') {
        source += escapeRegex(next)
        i++
        continue
      }
      source += escapeRegex(char)
      continue
    }
    if (char === '*') {
      source += '.*'
    } else if (char === '?') {
      source += '.'
    } else {
      source += escapeRegex(char)
    }
  }
  source += '$'
  return new RegExp(source, 'i').test(text)
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function matchesCriterion(value: Value, parsed: ParsedCriterion): boolean {
  const { op, target, wildcard } = parsed

  if (wildcard && target.kind === 'string' && (op === '=' || op === '<>')) {
    if (value.kind !== 'string') return op === '<>'
    const hit = wildcardMatch(value.value, target.value)
    return op === '=' ? hit : !hit
  }

  if (parsed.textPrefix && target.kind === 'string') {
    return value.kind === 'string' &&
      value.value.toLowerCase().startsWith(target.value.toLowerCase())
  }

  if (op === '=' || op === '<>') {
    const equal = scalarEquals(value, target)
    return op === '=' ? equal : !equal
  }

  const valueNumber = numericComparable(value)
  const targetNumber = numericComparable(target)
  if (valueNumber === undefined || targetNumber === undefined) return false

  switch (op) {
    case '<':
      return valueNumber < targetNumber
    case '<=':
      return valueNumber <= targetNumber
    case '>':
      return valueNumber > targetNumber
    case '>=':
      return valueNumber >= targetNumber
  }
}

function numericComparable(value: Value): number | undefined {
  if (value.kind === 'number') return value.value
  if (value.kind === 'boolean') return value.value ? 1 : 0
  return undefined
}

function scalarEquals(left: Value, right: Value): boolean {
  if (left.kind === 'error' || right.kind === 'error') return false
  if (left.kind === 'blank' && right.kind === 'blank') return true
  if (left.kind === 'blank' && right.kind === 'string' && right.value === '') return true
  if (right.kind === 'blank' && left.kind === 'string' && left.value === '') return true
  if (left.kind === 'blank' || right.kind === 'blank') return false
  if (left.kind !== right.kind) return false
  if (left.kind === 'number' && right.kind === 'number') return left.value === right.value
  if (left.kind === 'boolean' && right.kind === 'boolean') return left.value === right.value
  if (left.kind === 'string' && right.kind === 'string') {
    return left.value.toLowerCase() === right.value.toLowerCase()
  }
  return false
}

function matchingRows(
  database: DatabaseRange,
  criteria: Matrix,
): ValueResult<ReadonlyArray<number>> {
  if (criteria.length < 2) return { ok: true, value: [] }

  const columns = resolveCriteriaColumns(database, criteria)
  if (!columns.ok) return columns

  const matches: number[] = []
  for (let rowIndex = 0; rowIndex < database.dataRows.length; rowIndex++) {
    const row = database.dataRows[rowIndex]
    let rowMatches = false

    for (let criteriaRowIndex = 1; criteriaRowIndex < criteria.length; criteriaRowIndex++) {
      const criteriaRow = criteria[criteriaRowIndex]
      let criteriaRowMatches = true

      for (let col = 0; col < criteriaRow.length; col++) {
        const criterion = criteriaRow[col]
        if (criterion.kind === 'blank') continue

        const dbCol = columns.value[col]
        if (dbCol === null) {
          criteriaRowMatches = false
          break
        }

        const parsed = parseCriterion(criterion)
        if (!parsed.ok) return parsed

        if (!matchesCriterion(row[dbCol], parsed.value)) {
          criteriaRowMatches = false
          break
        }
      }

      if (criteriaRowMatches) {
        rowMatches = true
        break
      }
    }

    if (rowMatches) matches.push(rowIndex)
  }

  return { ok: true, value: matches }
}

function collectMatchedFieldValues(args: Value[]): ValueResult<ReadonlyArray<Value>> {
  if (args.length !== 3) return { ok: false, error: ERR('#VALUE!') }

  const database = resolveDatabase(args[0])
  if (!database.ok) return database

  const field = resolveField(database.value, args[1])
  if (!field.ok) return field

  const criteria = resolveCriteria(args[2])
  if (!criteria.ok) return criteria

  const rows = matchingRows(database.value, criteria.value)
  if (!rows.ok) return rows

  return {
    ok: true,
    value: rows.value.map((rowIndex) => database.value.dataRows[rowIndex][field.value]),
  }
}

function numericValues(values: ReadonlyArray<Value>): number[] {
  const out: number[] = []
  for (const value of values) {
    if (value.kind === 'number') out.push(value.value)
  }
  return out
}

function numericAggregate(
  args: Value[],
  finalize: (numbers: ReadonlyArray<number>) => Value,
): Value {
  const values = collectMatchedFieldValues(args)
  if (!values.ok) return values.error
  return finalize(numericValues(values.value))
}

const DSUM: FunctionImpl = (args, _ctx) =>
  numericAggregate(args, (numbers) => NUM(numbers.reduce((sum, value) => sum + value, 0)))

const DCOUNT: FunctionImpl = (args, _ctx) =>
  numericAggregate(args, (numbers) => NUM(numbers.length))

const DCOUNTA: FunctionImpl = (args, _ctx) => {
  const values = collectMatchedFieldValues(args)
  if (!values.ok) return values.error

  let count = 0
  for (const value of values.value) {
    if (value.kind !== 'blank') count++
  }
  return NUM(count)
}

const DMAX: FunctionImpl = (args, _ctx) =>
  numericAggregate(args, (numbers) => NUM(numbers.length ? Math.max(...numbers) : 0))

const DMIN: FunctionImpl = (args, _ctx) =>
  numericAggregate(args, (numbers) => NUM(numbers.length ? Math.min(...numbers) : 0))

const DPRODUCT: FunctionImpl = (args, _ctx) =>
  numericAggregate(args, (numbers) =>
    NUM(numbers.length ? numbers.reduce((product, value) => product * value, 1) : 0),
  )

const DAVERAGE: FunctionImpl = (args, _ctx) =>
  numericAggregate(args, (numbers) => {
    if (numbers.length === 0) return ERR('#DIV/0!')
    return NUM(numbers.reduce((sum, value) => sum + value, 0) / numbers.length)
  })

const DGET: FunctionImpl = (args, _ctx) => {
  const values = collectMatchedFieldValues(args)
  if (!values.ok) return values.error
  if (values.value.length === 0) return ERR('#VALUE!')
  if (values.value.length > 1) return ERR('#NUM!')
  return values.value[0]
}

function varianceOrStddev(
  args: Value[],
  sample: boolean,
  stddev: boolean,
): Value {
  return numericAggregate(args, (numbers) => {
    const minCount = sample ? 2 : 1
    if (numbers.length < minCount) return ERR('#DIV/0!')

    const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length
    const denominator = sample ? numbers.length - 1 : numbers.length
    const variance =
      numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / denominator
    return NUM(stddev ? Math.sqrt(variance) : variance)
  })
}

const DSTDEV: FunctionImpl = (args, _ctx) => varianceOrStddev(args, true, true)
const DSTDEVP: FunctionImpl = (args, _ctx) => varianceOrStddev(args, false, true)
const DVAR: FunctionImpl = (args, _ctx) => varianceOrStddev(args, true, false)
const DVARP: FunctionImpl = (args, _ctx) => varianceOrStddev(args, false, false)

export const FUNCTIONS: Record<string, FunctionImpl> = {
  DSUM,
  DCOUNT,
  DCOUNTA,
  DMAX,
  DMIN,
  DPRODUCT,
  DAVERAGE,
  DGET,
  DSTDEV,
  DSTDEVP,
  DVAR,
  DVARP,
}
