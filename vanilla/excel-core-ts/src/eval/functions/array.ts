/**
 * Wave E / track E1 — dynamic-array functions.
 *
 * SEQUENCE, TRANSPOSE, SORT, FILTER, UNIQUE all return `{kind:'array'}`
 * values that the formula's anchor cell carries; the worker's spill
 * projection (`getSpillProjectedValue` in `worker-runtime-ts.ts`)
 * surfaces non-anchor cells inside the spilled region at read time.
 *
 * Discipline mirrors Wave C — pure functions, error propagation via
 * `propagateError`, no `console`, no atom imports.
 */
import type { FunctionImpl, Value } from '../../types'
import { propagateError, toBoolean, toNumber } from '../coerce'

const ERR = (code: Extract<Value, { kind: 'error' }>['code'], message?: string): Value =>
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
  if (rows * cols > 100_000) {
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
  return { kind: 'array', value: out }
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

  const out: Value[][] = []
  for (let c = 0; c < cols; c += 1) {
    const row: Value[] = []
    for (let r = 0; r < rows; r += 1) {
      row.push(m[r][c] ?? { kind: 'blank' })
    }
    out.push(row)
  }
  return { kind: 'array', value: out }
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
    asc = so.value >= 0
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
    const idx = sortIndex - 1
    if (idx < 0 || idx >= rows) return ERR('#VALUE!', 'SORT sort_index out of range')
    const colOrder = Array.from({ length: cols }, (_, c) => c).sort((a, b) =>
      compareValuesForSort(m[idx][a], m[idx][b], asc),
    )
    const out: Value[][] = m.map((row) => colOrder.map((c) => row[c]))
    return { kind: 'array', value: out }
  }

  // Default: sort rows by col[sortIndex-1].
  const cols = m[0]?.length ?? 0
  const idx = sortIndex - 1
  if (idx < 0 || idx >= cols) return ERR('#VALUE!', 'SORT sort_index out of range')
  const sortedRows = [...m].sort((rowA, rowB) =>
    compareValuesForSort(rowA[idx], rowB[idx], asc),
  )
  return { kind: 'array', value: sortedRows }
}

/**
 * FILTER(array, include, [if_empty])
 * `include` is a column-vector boolean mask same height as `array` rows
 * (the typical Excel usage). We accept either Nx1 or 1xN and pick the
 * matching axis.
 */
const FILTER: FunctionImpl = (args) => {
  const propagated = propagateError(args)
  if (propagated) return propagated
  if (args.length < 2 || args.length > 3) return ERR('#VALUE!', 'FILTER needs 2-3 args')

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
    return ERR('#VALUE!', 'FILTER returned empty result (no #CALC! in our error set)')
  }
  return { kind: 'array', value: outRows }
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
    if (keepCols.length === 0) return ERR('#VALUE!', 'UNIQUE produced no columns')
    // Rebuild row-major.
    const rows = keepCols[0].length
    const out: Value[][] = []
    for (let r = 0; r < rows; r += 1) {
      out.push(keepCols.map((col) => col[r]))
    }
    return { kind: 'array', value: out }
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
  if (keep.length === 0) return ERR('#VALUE!', 'UNIQUE produced no rows')
  return { kind: 'array', value: keep }
}

export const FUNCTIONS: Record<string, FunctionImpl> = {
  SEQUENCE,
  TRANSPOSE,
  SORT,
  FILTER,
  UNIQUE,
}
