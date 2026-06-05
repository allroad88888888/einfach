/**
 * Wave E / track E1 — dynamic-array functions.
 *
 * Dynamic-array functions return `{kind:'array'}` values that the
 * formula's anchor cell carries; the worker's spill
 * projection (`getSpillProjectedValue` in `worker-runtime-ts.ts`)
 * surfaces non-anchor cells inside the spilled region at read time.
 *
 * Discipline mirrors Wave C — pure functions, error propagation via
 * `propagateError`, no `console`, no atom imports.
 */
import type { FunctionImpl, Value } from '../../types'
import { EXCEL_MAX_COL, EXCEL_MAX_ROW } from '../../refs'
import { propagateError, toBoolean, toNumber } from '../coerce'

type ErrorValue = Value & { kind: 'error' }
type NumberResult = { readonly ok: true; readonly value: number } | {
  readonly ok: false
  readonly error: ErrorValue
}
type BoolResult = { readonly ok: true; readonly value: boolean } | {
  readonly ok: false
  readonly error: ErrorValue
}
type IndexRangeResult = { readonly ok: true; readonly start: number; readonly end: number } | {
  readonly ok: false
  readonly error: ErrorValue
}
type SortOrientation = 'rows' | 'cols'
type SortKeysResult = {
  readonly ok: true
  readonly orientation: SortOrientation
  readonly keys: Value[]
} | {
  readonly ok: false
  readonly error: ErrorValue
}

const MAX_ARRAY_CELLS = 1_048_576
const MAX_ARRAY_ROWS = EXCEL_MAX_ROW + 1
const MAX_ARRAY_COLS = EXCEL_MAX_COL + 1
const BLANK_VALUE: Value = { kind: 'blank' }

const ERR = (code: Extract<Value, { kind: 'error' }>['code'], message?: string): ErrorValue =>
  message ? { kind: 'error', code, message } : { kind: 'error', code }

/**
 * Normalize a Value to a 2-D Value matrix. Scalars wrap to 1x1; blanks
 * become 1x1 blank. Errors short-circuit (caller checks first).
 */
function asMatrix(v: Value | undefined): Value[][] {
  if (!v) return [[{ kind: 'blank' }]]
  if (v.kind === 'array') return v.value.length > 0 ? v.value : [[{ kind: 'blank' }]]
  return [[v]]
}

function asVector(v: Value): { readonly ok: true; readonly values: Value[] } | {
  readonly ok: false
  readonly error: ErrorValue
} {
  const m = asMatrix(v)
  const rows = m.length
  const cols = matrixCols(m)
  if (rows === 1) {
    const values = m[0]?.slice() ?? []
    return values.length > 0 ? { ok: true, values } : { ok: false, error: ERR('#VALUE!') }
  }
  if (cols === 1) {
    return { ok: true, values: m.map((_, r) => matrixCell(m, r, 0)) }
  }
  return { ok: false, error: ERR('#VALUE!', 'vector must be one-dimensional') }
}

function matrixCols(m: Value[][]): number {
  return m.reduce((max, row) => Math.max(max, row.length), 0)
}

function matrixCell(m: Value[][], row: number, col: number): Value {
  return m[row]?.[col] ?? BLANK_VALUE
}

function tooLarge(rows: number, cols: number): boolean {
  return (
    rows > MAX_ARRAY_ROWS ||
    cols > MAX_ARRAY_COLS ||
    rows * cols > MAX_ARRAY_CELLS
  )
}

function scalarCellError(value: Value): ErrorValue | undefined {
  return value.kind === 'array' ? ERR('#CALC!', 'array result was not expanded') : undefined
}

function matrixScalarCellError(matrix: Value[][]): ErrorValue | undefined {
  for (const row of matrix) {
    for (const cell of row) {
      const error = scalarCellError(cell)
      if (error) return error
    }
  }
  return undefined
}

function arrayResult(matrix: Value[][]): Value {
  const rows = matrix.length
  const cols = matrixCols(matrix)
  if (rows < 1 || cols < 1) return ERR('#VALUE!')
  if (tooLarge(rows, cols)) return ERR('#VALUE!', `array result too large (${rows}x${cols})`)
  return matrixScalarCellError(matrix) ?? { kind: 'array', value: matrix }
}

function toInteger(v: Value): NumberResult {
  const n = toNumber(v)
  if (!n.ok) return n
  if (!Number.isFinite(n.value)) return { ok: false, error: ERR('#NUM!') }
  return { ok: true, value: Math.trunc(n.value) }
}

function toIntegerInRange(v: Value, min: number, max: number): NumberResult {
  const parsed = toInteger(v)
  if (!parsed.ok) return parsed
  if (parsed.value < min || parsed.value > max) {
    return { ok: false, error: ERR('#VALUE!') }
  }
  return parsed
}

function collectArgsRowMajor(args: Value[], start: number): Value[] {
  const out: Value[] = []
  for (let i = start; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.kind === 'array') {
      for (const row of arg.value) {
        for (const cell of row) {
          out.push(cell)
        }
      }
    } else {
      out.push(arg)
    }
  }
  return out
}

function resolveIndex(v: Value, size: number): NumberResult {
  const parsed = toInteger(v)
  if (!parsed.ok) return parsed
  const raw = parsed.value
  if (raw === 0) return { ok: false, error: ERR('#VALUE!') }
  const idx = raw > 0 ? raw - 1 : size + raw
  if (idx < 0 || idx >= size) return { ok: false, error: ERR('#VALUE!') }
  return { ok: true, value: idx }
}

function takeRange(size: number, count: number): IndexRangeResult {
  if (count === 0) return { ok: false, error: ERR('#CALC!') }
  const n = Math.min(Math.abs(count), size)
  if (n === 0) return { ok: false, error: ERR('#CALC!') }
  if (count > 0) return { ok: true, start: 0, end: n }
  return { ok: true, start: size - n, end: size }
}

function dropRange(size: number, count: number): IndexRangeResult {
  if (count === 0) return { ok: false, error: ERR('#CALC!') }
  if (count > 0) {
    const start = Math.min(count, size)
    if (start >= size) return { ok: false, error: ERR('#CALC!') }
    return { ok: true, start, end: size }
  }
  const end = Math.max(0, size + count)
  if (end <= 0) return { ok: false, error: ERR('#CALC!') }
  return { ok: true, start: 0, end }
}

function sliceMatrix(
  m: Value[][],
  rowStart: number,
  rowEnd: number,
  colStart: number,
  colEnd: number,
): Value[][] {
  const out: Value[][] = []
  for (let r = rowStart; r < rowEnd; r += 1) {
    const row: Value[] = []
    for (let c = colStart; c < colEnd; c += 1) {
      row.push(matrixCell(m, r, c))
    }
    out.push(row)
  }
  return out
}

function parseIgnoreMode(v: Value): NumberResult {
  return toIntegerInRange(v, 0, 3)
}

function shouldIgnore(v: Value, ignoreMode: number): boolean {
  const ignoreBlank = ignoreMode === 1 || ignoreMode === 3
  const ignoreError = ignoreMode === 2 || ignoreMode === 3
  return (ignoreBlank && v.kind === 'blank') || (ignoreError && v.kind === 'error')
}

function parseSortOrder(v: Value): BoolResult {
  const order = toInteger(v)
  if (!order.ok) return order
  if (order.value === 1) return { ok: true, value: true }
  if (order.value === -1) return { ok: true, value: false }
  return { ok: false, error: ERR('#VALUE!') }
}

function sortByKeys(v: Value, rows: number, cols: number): SortKeysResult {
  const m = asMatrix(v)
  const keyRows = m.length
  const keyCols = matrixCols(m)

  if (keyRows === rows && keyCols === 1) {
    return { ok: true, orientation: 'rows', keys: m.map((row) => row[0] ?? BLANK_VALUE) }
  }
  if (keyRows === 1 && keyCols === cols) {
    return { ok: true, orientation: 'cols', keys: m[0].map((cell) => cell ?? BLANK_VALUE) }
  }
  if (keyRows === 1 && keyCols === rows) {
    const keys: Value[] = []
    for (let c = 0; c < rows; c += 1) keys.push(matrixCell(m, 0, c))
    return { ok: true, orientation: 'rows', keys }
  }
  if (keyRows === cols && keyCols === 1) {
    return { ok: true, orientation: 'cols', keys: m.map((row) => row[0] ?? BLANK_VALUE) }
  }
  return { ok: false, error: ERR('#VALUE!', 'SORTBY by_array shape mismatch') }
}

function firstError(values: Value[]): ErrorValue | undefined {
  for (const value of values) {
    if (value.kind === 'error') return value
  }
  return undefined
}

/**
 * SEQUENCE(rows, [cols=1], [start=1], [step=1])
 * Row-major fill.
 */
const SEQUENCE: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1 || args.length > 4) return ERR('#VALUE!', 'SEQUENCE needs 1-4 args')

  const rowsRes = toNumber(args[0])
  if (!rowsRes.ok) return rowsRes.error
  const rows = Math.floor(rowsRes.value)
  if (rows < 1) return ERR('#VALUE!', 'SEQUENCE rows must be >= 1')

  let cols = 1
  if (args.length >= 2) {
    const c = toNumber(args[1])
    if (!c.ok) return c.error
    cols = Math.floor(c.value)
    if (cols < 1) return ERR('#VALUE!', 'SEQUENCE cols must be >= 1')
  }

  let start = 1
  if (args.length >= 3) {
    const s = toNumber(args[2])
    if (!s.ok) return s.error
    start = s.value
  }

  let step = 1
  if (args.length >= 4) {
    const st = toNumber(args[3])
    if (!st.ok) return st.error
    step = st.value
  }

  // Guard rail — SEQUENCE(10000, 10000) would allocate 100M cells.
  if (tooLarge(rows, cols)) {
    return ERR('#VALUE!', `SEQUENCE result too large (${rows}x${cols})`)
  }

  const out: Value[][] = []
  let n = 0
  for (let r = 0; r < rows; r += 1) {
    const row: Value[] = []
    for (let c = 0; c < cols; c += 1) {
      row.push({ kind: 'number', value: start + n * step })
      n += 1
    }
    out.push(row)
  }
  return arrayResult(out)
}

/**
 * TRANSPOSE(array) — flip rows ↔ cols.
 */
const TRANSPOSE: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length !== 1) return ERR('#VALUE!', 'TRANSPOSE needs 1 arg')

  const m = asMatrix(args[0])
  const rows = m.length
  const cols = m[0]?.length ?? 0
  if (rows === 0 || cols === 0) return ERR('#VALUE!')
  if (tooLarge(cols, rows)) return ERR('#VALUE!', `TRANSPOSE result too large (${cols}x${rows})`)

  const out: Value[][] = []
  for (let c = 0; c < cols; c += 1) {
    const row: Value[] = []
    for (let r = 0; r < rows; r += 1) {
      row.push(m[r][c] ?? { kind: 'blank' })
    }
    out.push(row)
  }
  return arrayResult(out)
}

function compareValuesForSort(a: Value, b: Value, asc: boolean): number {
  const direction = asc ? 1 : -1
  const ka = a.kind
  const kb = b.kind
  // Blanks sort as 0 (Excel convention).
  const av = ka === 'number' ? a.value : ka === 'blank' ? 0 : null
  const bv = kb === 'number' ? b.value : kb === 'blank' ? 0 : null
  if (av !== null && bv !== null) {
    return (av - bv) * direction
  }
  // Mixed types: numbers before strings (Excel), strings compared lexically.
  if (av !== null) return -1 * direction
  if (bv !== null) return 1 * direction
  const as = ka === 'string' ? a.value : ''
  const bs = kb === 'string' ? b.value : ''
  return as.localeCompare(bs) * direction
}

/**
 * SORT(array, [sort_index=1], [sort_order=1], [by_col=FALSE])
 */
const SORT: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1 || args.length > 4) return ERR('#VALUE!', 'SORT needs 1-4 args')

  const m = asMatrix(args[0])
  let sortIndex = 1
  if (args.length >= 2) {
    const si = toNumber(args[1])
    if (!si.ok) return si.error
    sortIndex = Math.floor(si.value)
  }
  let asc = true
  if (args.length >= 3) {
    const so = toNumber(args[2])
    if (!so.ok) return so.error
    const sortOrder = Math.trunc(so.value)
    if (sortOrder !== 1 && sortOrder !== -1) return ERR('#VALUE!', 'SORT sort_order must be 1 or -1')
    asc = sortOrder === 1
  }
  let byCol = false
  if (args.length >= 4) {
    const bc = toBoolean(args[3])
    if (!bc.ok) return bc.error
    byCol = bc.value
  }

  if (byCol) {
    // Sort columns by row[sortIndex-1].
    const rows = m.length
    const cols = m[0]?.length ?? 0
    if (tooLarge(rows, cols)) return ERR('#VALUE!', `SORT result too large (${rows}x${cols})`)
    const idx = sortIndex - 1
    if (idx < 0 || idx >= rows) return ERR('#VALUE!', 'SORT sort_index out of range')
    const colOrder = Array.from({ length: cols }, (_, c) => c).sort((a, b) =>
      compareValuesForSort(m[idx][a], m[idx][b], asc),
    )
    const out: Value[][] = m.map((row) => colOrder.map((c) => row[c]))
    return arrayResult(out)
  }

  // Default: sort rows by col[sortIndex-1].
  const cols = m[0]?.length ?? 0
  if (tooLarge(m.length, cols)) return ERR('#VALUE!', `SORT result too large (${m.length}x${cols})`)
  const idx = sortIndex - 1
  if (idx < 0 || idx >= cols) return ERR('#VALUE!', 'SORT sort_index out of range')
  const sortedRows = [...m].sort((rowA, rowB) =>
    compareValuesForSort(rowA[idx], rowB[idx], asc),
  )
  return arrayResult(sortedRows)
}

/**
 * FILTER(array, include, [if_empty])
 * `include` is a column-vector boolean mask same height as `array` rows
 * (the typical Excel usage). We accept either Nx1 or 1xN and pick the
 * matching axis.
 */
const FILTER: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3) return ERR('#VALUE!', 'FILTER needs 2-3 args')
  const propagated = propagateError(args.slice(0, 2))
  if (propagated) return propagated

  const m = asMatrix(args[0])
  const mask = asMatrix(args[1])

  const rows = m.length
  const cols = m[0]?.length ?? 0
  const mRows = mask.length
  const mCols = mask[0]?.length ?? 0

  let outRows: Value[][] = []
  if (mRows === rows && mCols === 1) {
    // Row mask.
    for (let r = 0; r < rows; r += 1) {
      const b = toBoolean(mask[r][0])
      if (!b.ok) return b.error
      if (b.value) outRows.push(m[r])
    }
  } else if (mCols === cols && mRows === 1) {
    // Column mask — keep matching columns from each row.
    const cKeep: number[] = []
    for (let c = 0; c < cols; c += 1) {
      const b = toBoolean(mask[0][c])
      if (!b.ok) return b.error
      if (b.value) cKeep.push(c)
    }
    outRows = m.map((row) => cKeep.map((c) => row[c]))
  } else {
    return ERR('#VALUE!', 'FILTER mask shape mismatch')
  }

  if (outRows.length === 0 || outRows[0].length === 0) {
    if (args.length === 3) return args[2]
    return ERR('#CALC!', 'FILTER returned empty result')
  }
  const outCols = matrixCols(outRows)
  if (tooLarge(outRows.length, outCols)) {
    return ERR('#VALUE!', `FILTER result too large (${outRows.length}x${outCols})`)
  }
  return arrayResult(outRows)
}

function rowKey(row: Value[]): string {
  // Stable string serialization for dedupe. Sufficient for v1 — exotic
  // types (arrays-within-arrays) would need a richer key.
  return row
    .map((v) => {
      switch (v.kind) {
        case 'blank':
          return '\x00'
        case 'number':
          return 'n:' + String(v.value)
        case 'string':
          return 's:' + v.value
        case 'boolean':
          return 'b:' + (v.value ? '1' : '0')
        case 'error':
          return 'e:' + v.code
        case 'array':
          return 'a:' + JSON.stringify(v.value)
      }
    })
    .join('\x01')
}

/**
 * UNIQUE(array, [by_col=FALSE], [exactly_once=FALSE])
 */
const UNIQUE: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1 || args.length > 3) return ERR('#VALUE!', 'UNIQUE needs 1-3 args')

  const m = asMatrix(args[0])

  let byCol = false
  if (args.length >= 2) {
    const bc = toBoolean(args[1])
    if (!bc.ok) return bc.error
    byCol = bc.value
  }
  let exactlyOnce = false
  if (args.length >= 3) {
    const eo = toBoolean(args[2])
    if (!eo.ok) return eo.error
    exactlyOnce = eo.value
  }

  if (byCol) {
    // Dedupe by column.
    const cols = m[0]?.length ?? 0
    const colData: Value[][] = []
    for (let c = 0; c < cols; c += 1) {
      colData.push(m.map((r) => r[c]))
    }
    const counts = new Map<string, number>()
    for (const col of colData) {
      const k = rowKey(col)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const seen = new Set<string>()
    const keepCols: Value[][] = []
    for (const col of colData) {
      const k = rowKey(col)
      if (seen.has(k)) continue
      if (exactlyOnce && counts.get(k) !== 1) continue
      seen.add(k)
      keepCols.push(col)
    }
    if (keepCols.length === 0) return ERR('#CALC!', 'UNIQUE produced no columns')
    // Rebuild row-major.
    const rows = keepCols[0].length
    if (tooLarge(rows, keepCols.length)) {
      return ERR('#VALUE!', `UNIQUE result too large (${rows}x${keepCols.length})`)
    }
    const out: Value[][] = []
    for (let r = 0; r < rows; r += 1) {
      out.push(keepCols.map((col) => col[r]))
    }
    return arrayResult(out)
  }

  // Default: dedupe by row.
  const counts = new Map<string, number>()
  for (const row of m) {
    const k = rowKey(row)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const seen = new Set<string>()
  const keep: Value[][] = []
  for (const row of m) {
    const k = rowKey(row)
    if (seen.has(k)) continue
    if (exactlyOnce && counts.get(k) !== 1) continue
    seen.add(k)
    keep.push(row)
  }
  if (keep.length === 0) return ERR('#CALC!', 'UNIQUE produced no rows')
  const keepCols = matrixCols(keep)
  if (tooLarge(keep.length, keepCols)) {
    return ERR('#VALUE!', `UNIQUE result too large (${keep.length}x${keepCols})`)
  }
  return arrayResult(keep)
}

/**
 * WRAPROWS(vector, wrap_count, [pad_with])
 */
const WRAPROWS: FunctionImpl = (args) => {
  const propagated = propagateError(args.slice(0, 2))
  if (propagated) return propagated
  if (args.length < 2 || args.length > 3) return ERR('#VALUE!', 'WRAPROWS needs 2-3 args')

  const vector = asVector(args[0])
  if (!vector.ok) return vector.error
  const wrapCount = toInteger(args[1])
  if (!wrapCount.ok) return wrapCount.error
  if (wrapCount.value < 1) return ERR('#NUM!')

  const values = vector.values
  const cols = Math.min(wrapCount.value, values.length)
  const rows = Math.ceil(values.length / wrapCount.value)
  if (tooLarge(rows, cols)) return ERR('#VALUE!', `WRAPROWS result too large (${rows}x${cols})`)

  const pad = args.length === 3 ? args[2] : ERR('#N/A')
  const out: Value[][] = []
  for (let r = 0; r < rows; r += 1) {
    const row: Value[] = []
    for (let c = 0; c < cols; c += 1) {
      row.push(values[r * wrapCount.value + c] ?? pad)
    }
    out.push(row)
  }
  return arrayResult(out)
}

/**
 * WRAPCOLS(vector, wrap_count, [pad_with])
 */
const WRAPCOLS: FunctionImpl = (args) => {
  const propagated = propagateError(args.slice(0, 2))
  if (propagated) return propagated
  if (args.length < 2 || args.length > 3) return ERR('#VALUE!', 'WRAPCOLS needs 2-3 args')

  const vector = asVector(args[0])
  if (!vector.ok) return vector.error
  const wrapCount = toInteger(args[1])
  if (!wrapCount.ok) return wrapCount.error
  if (wrapCount.value < 1) return ERR('#NUM!')

  const values = vector.values
  const rows = Math.min(wrapCount.value, values.length)
  const cols = Math.ceil(values.length / wrapCount.value)
  if (tooLarge(rows, cols)) return ERR('#VALUE!', `WRAPCOLS result too large (${rows}x${cols})`)

  const pad = args.length === 3 ? args[2] : ERR('#N/A')
  const out: Value[][] = []
  for (let r = 0; r < rows; r += 1) {
    const row: Value[] = []
    for (let c = 0; c < cols; c += 1) {
      row.push(values[c * wrapCount.value + r] ?? pad)
    }
    out.push(row)
  }
  return arrayResult(out)
}

/**
 * CHOOSECOLS(array, col_num1, [col_num2], ...)
 */
const CHOOSECOLS: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 2) return ERR('#VALUE!', 'CHOOSECOLS needs at least 2 args')

  const m = asMatrix(args[0])
  const rows = m.length
  const cols = matrixCols(m)
  const selectors = collectArgsRowMajor(args, 1)
  if (selectors.length === 0 || cols === 0) return ERR('#VALUE!')
  if (tooLarge(rows, selectors.length)) {
    return ERR('#VALUE!', `CHOOSECOLS result too large (${rows}x${selectors.length})`)
  }

  const indexes: number[] = []
  for (const selector of selectors) {
    const idx = resolveIndex(selector, cols)
    if (!idx.ok) return idx.error
    indexes.push(idx.value)
  }

  const out = m.map((_, r) => indexes.map((c) => matrixCell(m, r, c)))
  return arrayResult(out)
}

/**
 * CHOOSEROWS(array, row_num1, [row_num2], ...)
 */
const CHOOSEROWS: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 2) return ERR('#VALUE!', 'CHOOSEROWS needs at least 2 args')

  const m = asMatrix(args[0])
  const rows = m.length
  const cols = matrixCols(m)
  const selectors = collectArgsRowMajor(args, 1)
  if (selectors.length === 0 || rows === 0 || cols === 0) return ERR('#VALUE!')
  if (tooLarge(selectors.length, cols)) {
    return ERR('#VALUE!', `CHOOSEROWS result too large (${selectors.length}x${cols})`)
  }

  const indexes: number[] = []
  for (const selector of selectors) {
    const idx = resolveIndex(selector, rows)
    if (!idx.ok) return idx.error
    indexes.push(idx.value)
  }

  const out = indexes.map((r) => {
    const row: Value[] = []
    for (let c = 0; c < cols; c += 1) row.push(matrixCell(m, r, c))
    return row
  })
  return arrayResult(out)
}

/**
 * TAKE(array, rows, [columns])
 */
const TAKE: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 2 || args.length > 3) return ERR('#VALUE!', 'TAKE needs 2-3 args')

  const m = asMatrix(args[0])
  const rows = m.length
  const cols = matrixCols(m)
  const rowCount = toInteger(args[1])
  if (!rowCount.ok) return rowCount.error
  const rowRange = takeRange(rows, rowCount.value)
  if (!rowRange.ok) return rowRange.error

  let colStart = 0
  let colEnd = cols
  if (args.length === 3) {
    const colCount = toInteger(args[2])
    if (!colCount.ok) return colCount.error
    const colRange = takeRange(cols, colCount.value)
    if (!colRange.ok) return colRange.error
    colStart = colRange.start
    colEnd = colRange.end
  }

  const out = sliceMatrix(m, rowRange.start, rowRange.end, colStart, colEnd)
  const outCols = matrixCols(out)
  if (tooLarge(out.length, outCols)) {
    return ERR('#VALUE!', `TAKE result too large (${out.length}x${outCols})`)
  }
  return arrayResult(out)
}

/**
 * DROP(array, rows, [columns])
 */
const DROP: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 2 || args.length > 3) return ERR('#VALUE!', 'DROP needs 2-3 args')

  const m = asMatrix(args[0])
  const rows = m.length
  const cols = matrixCols(m)
  const rowCount = toInteger(args[1])
  if (!rowCount.ok) return rowCount.error
  const rowRange = dropRange(rows, rowCount.value)
  if (!rowRange.ok) return rowRange.error

  let colStart = 0
  let colEnd = cols
  if (args.length === 3) {
    const colCount = toInteger(args[2])
    if (!colCount.ok) return colCount.error
    const colRange = dropRange(cols, colCount.value)
    if (!colRange.ok) return colRange.error
    colStart = colRange.start
    colEnd = colRange.end
  }

  const out = sliceMatrix(m, rowRange.start, rowRange.end, colStart, colEnd)
  const outCols = matrixCols(out)
  if (tooLarge(out.length, outCols)) {
    return ERR('#VALUE!', `DROP result too large (${out.length}x${outCols})`)
  }
  return arrayResult(out)
}

/**
 * EXPAND(array, rows, [columns], [pad_with])
 */
const EXPAND: FunctionImpl = (args) => {
  const propagated = propagateError(args.slice(0, 3))
  if (propagated) return propagated
  if (args.length < 2 || args.length > 4) return ERR('#VALUE!', 'EXPAND needs 2-4 args')

  const m = asMatrix(args[0])
  const rows = m.length
  const cols = matrixCols(m)
  const targetRows = toInteger(args[1])
  if (!targetRows.ok) return targetRows.error
  if (targetRows.value < rows || targetRows.value < 1) {
    return ERR('#VALUE!', 'EXPAND rows must be >= source rows')
  }

  let targetCols = cols
  if (args.length >= 3) {
    const parsedCols = toInteger(args[2])
    if (!parsedCols.ok) return parsedCols.error
    targetCols = parsedCols.value
    if (targetCols < cols || targetCols < 1) {
      return ERR('#VALUE!', 'EXPAND columns must be >= source columns')
    }
  }
  if (tooLarge(targetRows.value, targetCols)) {
    return ERR('#VALUE!', `EXPAND result too large (${targetRows.value}x${targetCols})`)
  }

  const pad = args.length === 4 ? args[3] : ERR('#N/A')
  const out: Value[][] = []
  for (let r = 0; r < targetRows.value; r += 1) {
    const row: Value[] = []
    for (let c = 0; c < targetCols; c += 1) {
      row.push(r < rows && c < cols ? matrixCell(m, r, c) : pad)
    }
    out.push(row)
  }
  return arrayResult(out)
}

/**
 * HSTACK(array1, [array2], ...)
 */
const HSTACK: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1) return ERR('#VALUE!', 'HSTACK needs at least 1 arg')

  const matrices = args.map(asMatrix)
  const rows = Math.max(...matrices.map((m) => m.length))
  const widths = matrices.map(matrixCols)
  const cols = widths.reduce((sum, width) => sum + width, 0)
  if (rows < 1 || cols < 1) return ERR('#VALUE!')
  if (tooLarge(rows, cols)) return ERR('#VALUE!', `HSTACK result too large (${rows}x${cols})`)

  const pad = ERR('#N/A')
  const out: Value[][] = []
  for (let r = 0; r < rows; r += 1) {
    const row: Value[] = []
    for (let i = 0; i < matrices.length; i += 1) {
      const m = matrices[i]
      for (let c = 0; c < widths[i]; c += 1) {
        row.push(r < m.length ? matrixCell(m, r, c) : pad)
      }
    }
    out.push(row)
  }
  return arrayResult(out)
}

/**
 * VSTACK(array1, [array2], ...)
 */
const VSTACK: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 1) return ERR('#VALUE!', 'VSTACK needs at least 1 arg')

  const matrices = args.map(asMatrix)
  const rows = matrices.reduce((sum, m) => sum + m.length, 0)
  const cols = Math.max(...matrices.map(matrixCols))
  if (rows < 1 || cols < 1) return ERR('#VALUE!')
  if (tooLarge(rows, cols)) return ERR('#VALUE!', `VSTACK result too large (${rows}x${cols})`)

  const pad = ERR('#N/A')
  const out: Value[][] = []
  for (const m of matrices) {
    const mCols = matrixCols(m)
    for (let r = 0; r < m.length; r += 1) {
      const row: Value[] = []
      for (let c = 0; c < cols; c += 1) {
        row.push(c < mCols ? matrixCell(m, r, c) : pad)
      }
      out.push(row)
    }
  }
  return arrayResult(out)
}

/**
 * TOCOL(array, [ignore=0], [scan_by_column=FALSE])
 */
const TOCOL: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 3) return ERR('#VALUE!', 'TOCOL needs 1-3 args')

  let ignoreMode = 0
  if (args.length >= 2) {
    const parsedIgnore = parseIgnoreMode(args[1])
    if (!parsedIgnore.ok) return parsedIgnore.error
    ignoreMode = parsedIgnore.value
  }
  let scanByColumn = false
  if (args.length === 3) {
    const parsedScan = toBoolean(args[2])
    if (!parsedScan.ok) return parsedScan.error
    scanByColumn = parsedScan.value
  }

  if (args[0].kind === 'error' && !shouldIgnore(args[0], ignoreMode)) return args[0]
  const m = asMatrix(args[0])
  const rows = m.length
  const cols = matrixCols(m)
  const values: Value[] = []
  if (scanByColumn) {
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) {
        const cell = matrixCell(m, r, c)
        if (!shouldIgnore(cell, ignoreMode)) values.push(cell)
      }
    }
  } else {
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const cell = matrixCell(m, r, c)
        if (!shouldIgnore(cell, ignoreMode)) values.push(cell)
      }
    }
  }
  if (values.length === 0) return ERR('#CALC!')
  if (tooLarge(values.length, 1)) return ERR('#VALUE!', `TOCOL result too large (${values.length}x1)`)
  return arrayResult(values.map((value) => [value]))
}

/**
 * TOROW(array, [ignore=0], [scan_by_column=FALSE])
 */
const TOROW: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 3) return ERR('#VALUE!', 'TOROW needs 1-3 args')

  let ignoreMode = 0
  if (args.length >= 2) {
    const parsedIgnore = parseIgnoreMode(args[1])
    if (!parsedIgnore.ok) return parsedIgnore.error
    ignoreMode = parsedIgnore.value
  }
  let scanByColumn = false
  if (args.length === 3) {
    const parsedScan = toBoolean(args[2])
    if (!parsedScan.ok) return parsedScan.error
    scanByColumn = parsedScan.value
  }

  if (args[0].kind === 'error' && !shouldIgnore(args[0], ignoreMode)) return args[0]
  const m = asMatrix(args[0])
  const rows = m.length
  const cols = matrixCols(m)
  const values: Value[] = []
  if (scanByColumn) {
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) {
        const cell = matrixCell(m, r, c)
        if (!shouldIgnore(cell, ignoreMode)) values.push(cell)
      }
    }
  } else {
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const cell = matrixCell(m, r, c)
        if (!shouldIgnore(cell, ignoreMode)) values.push(cell)
      }
    }
  }
  if (values.length === 0) return ERR('#CALC!')
  if (tooLarge(1, values.length)) return ERR('#VALUE!', `TOROW result too large (1x${values.length})`)
  return arrayResult([values])
}

/**
 * RANDARRAY([rows=1], [columns=1], [min=0], [max=1], [whole_number=FALSE])
 */
const RANDARRAY: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length > 5) return ERR('#VALUE!', 'RANDARRAY needs 0-5 args')

  let rows = 1
  if (args.length >= 1) {
    const parsedRows = toInteger(args[0])
    if (!parsedRows.ok) return parsedRows.error
    rows = parsedRows.value
  }
  let cols = 1
  if (args.length >= 2) {
    const parsedCols = toInteger(args[1])
    if (!parsedCols.ok) return parsedCols.error
    cols = parsedCols.value
  }
  if (rows < 1 || cols < 1) return ERR('#VALUE!', 'RANDARRAY dimensions must be >= 1')
  if (tooLarge(rows, cols)) return ERR('#VALUE!', `RANDARRAY result too large (${rows}x${cols})`)

  let min = 0
  if (args.length >= 3) {
    const parsedMin = toNumber(args[2])
    if (!parsedMin.ok) return parsedMin.error
    min = parsedMin.value
  }
  let max = 1
  if (args.length >= 4) {
    const parsedMax = toNumber(args[3])
    if (!parsedMax.ok) return parsedMax.error
    max = parsedMax.value
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return ERR('#NUM!')

  let wholeNumber = false
  if (args.length === 5) {
    const parsedWhole = toBoolean(args[4])
    if (!parsedWhole.ok) return parsedWhole.error
    wholeNumber = parsedWhole.value
  }

  const out: Value[][] = []
  if (wholeNumber) {
    const low = Math.ceil(min)
    const high = Math.floor(max)
    if (low > high) return ERR('#NUM!')
    for (let r = 0; r < rows; r += 1) {
      const row: Value[] = []
      for (let c = 0; c < cols; c += 1) {
        row.push({ kind: 'number', value: Math.floor(Math.random() * (high - low + 1)) + low })
      }
      out.push(row)
    }
  } else {
    for (let r = 0; r < rows; r += 1) {
      const row: Value[] = []
      for (let c = 0; c < cols; c += 1) {
        row.push({ kind: 'number', value: min + Math.random() * (max - min) })
      }
      out.push(row)
    }
  }
  return arrayResult(out)
}

/**
 * SORTBY(array, by_array1, [sort_order1], [by_array2], [sort_order2], ...)
 */
const SORTBY: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 2) return ERR('#VALUE!', 'SORTBY needs at least 2 args')

  const m = asMatrix(args[0])
  const rows = m.length
  const cols = matrixCols(m)
  const specs: Array<{ readonly keys: Value[]; readonly asc: boolean }> = []
  let orientation: SortOrientation | undefined
  let i = 1
  while (i < args.length) {
    const keySpec = sortByKeys(args[i], rows, cols)
    if (!keySpec.ok) return keySpec.error
    const keyError = firstError(keySpec.keys)
    if (keyError) return keyError
    if (orientation && keySpec.orientation !== orientation) {
      return ERR('#VALUE!', 'SORTBY by_array orientations must match')
    }
    orientation = keySpec.orientation
    i += 1

    let asc = true
    if (i < args.length && args[i].kind !== 'array') {
      const order = parseSortOrder(args[i])
      if (!order.ok) return order.error
      asc = order.value
      i += 1
    }
    specs.push({ keys: keySpec.keys, asc })
  }

  if (!orientation || specs.length === 0) return ERR('#VALUE!')
  if (tooLarge(rows, cols)) return ERR('#VALUE!', `SORTBY result too large (${rows}x${cols})`)
  if (orientation === 'cols') {
    const indexes = Array.from({ length: cols }, (_, c) => c)
    indexes.sort((a, b) => {
      for (const spec of specs) {
        const cmp = compareValuesForSort(spec.keys[a], spec.keys[b], spec.asc)
        if (cmp !== 0) return cmp
      }
      return a - b
    })
    const out = m.map((_, r) => indexes.map((c) => matrixCell(m, r, c)))
    return arrayResult(out)
  }

  const indexes = Array.from({ length: rows }, (_, r) => r)
  indexes.sort((a, b) => {
    for (const spec of specs) {
      const cmp = compareValuesForSort(spec.keys[a], spec.keys[b], spec.asc)
      if (cmp !== 0) return cmp
    }
    return a - b
  })
  const out = indexes.map((r) => {
    const row: Value[] = []
    for (let c = 0; c < cols; c += 1) row.push(matrixCell(m, r, c))
    return row
  })
  return arrayResult(out)
}

export const FUNCTIONS: Record<string, FunctionImpl> = {
  SEQUENCE,
  TRANSPOSE,
  SORT,
  FILTER,
  UNIQUE,
  WRAPROWS,
  WRAPCOLS,
  CHOOSECOLS,
  CHOOSEROWS,
  TAKE,
  DROP,
  EXPAND,
  HSTACK,
  VSTACK,
  TOCOL,
  TOROW,
  RANDARRAY,
  SORTBY,
}
