import type { DisplayCell } from '../backend/types'
import type {
  RemoveDuplicatesComparison,
  RemoveDuplicatesScanInput,
  RemoveDuplicatesScanResult,
} from './types'

const EMPTY_HIDDEN_ROWS: readonly number[] = Object.freeze([])

function normaliseValue(
  value: string,
  comparison: RemoveDuplicatesComparison,
): string {
  switch (comparison) {
    case 'exact':
      return value
    case 'caseInsensitive':
      return value.toLowerCase()
    case 'trim':
      return value.trim()
    case 'trimAndIgnoreCase':
      return value.trim().toLowerCase()
  }
}

/**
 * Build a collision-free tuple key from per-column normalised values.
 *
 * We use a length-prefix encoding (`${len}:${value}`) joined with `|`
 * rather than a separator-char scheme because any sentinel character
 * — including obscure C0 controls like U+001F — can legitimately appear
 * inside cell strings (paste from CSV, binary data, etc.) and would
 * cause spurious or missed collisions. Length-prefixing makes every
 * encoding uniquely reversible without an escape table:
 *
 *   ['a',     'b\x1Fc'] → "1:a|5:b\x1Fc"
 *   ['a\x1Fb','c']      → "3:a\x1Fb|1:c"
 *
 * Same input arrays always yield identical strings; different arrays
 * yield different strings regardless of any character the values
 * contain. Internal to this module — never persisted or surfaced.
 */
function buildTupleKey(values: readonly string[]): string {
  // Pre-size guess for joins isn't worth it; v8 grows the string fine.
  let key = ''
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]
    if (i > 0) key += '|'
    key += v.length
    key += ':'
    key += v
  }
  return key
}

/**
 * Pure scanner: produces the sheet-absolute row indices that should be
 * removed under the given key-column / comparison policy.
 *
 * Semantics (matches Excel's behaviour where applicable):
 *
 * 1. Walks rows top-to-bottom in `[startRow .. endRow]`, skipping the
 *    header row when `excludeHeader=true`.
 * 2. For each row, builds a tuple by joining the normalised display
 *    values of the cells whose column is in the (filtered) `keyColumns`
 *    set. Columns are visited in ascending sheet-column order so two
 *    callers passing the same set in different insertion orders agree.
 * 3. Missing cells (sparse projection) and cells with `valueKind ===
 *    'blank'` both contribute the empty string — two rows that are
 *    blank in every key column ARE duplicates of each other (parity
 *    with Excel).
 * 4. The first occurrence of any tuple wins; later rows with the same
 *    tuple land in `duplicateRows`.
 * 4b. Rows listed in `input.hiddenRows` are skipped entirely — not
 *    compared, not counted, never a first-seen occupant, never reported.
 *    A row that is not rendered contributes no cells to the sparse
 *    projection, so the dense walk would otherwise read it as an all-blank
 *    tuple and mark it (or its peers) duplicate — deleting rows the user
 *    could not see. See design-filter-hidden-rows.md §8.1.
 * 5. `duplicateRows` carries SOURCE row indices, which is what
 *    {@link RemoveDuplicatesScanResult.duplicateRows} promises and what
 *    `backend.removeRows` expects. Since filtering hides rows instead of
 *    compacting them (#27), the scan index already IS the source row —
 *    the promise is exact rather than translated.
 *
 * When the effective key set is empty (all `keyColumns` fall outside
 * `[startCol..endCol]`), returns a synthetic result with
 * `noKeyColumns: true` instead of throwing — the README guarantees
 * the algorithm never throws on input shape.
 */
export function findDuplicateRows(
  input: RemoveDuplicatesScanInput,
): RemoveDuplicatesScanResult {
  const { cells, range, keyColumns } = input
  const comparison: RemoveDuplicatesComparison = input.comparison ?? 'exact'
  const excludeHeader = input.excludeHeader ?? true

  const { startRow, endRow, startCol, endCol } = range

  // Partition keyColumns into in-range vs ignored, then materialise an
  // ascending list so tuple construction is order-stable.
  const inRangeKeyCols: number[] = []
  const ignoredColumns: number[] = []
  for (const col of keyColumns) {
    if (col >= startCol && col <= endCol) {
      inRangeKeyCols.push(col)
    } else {
      ignoredColumns.push(col)
    }
  }
  inRangeKeyCols.sort((a, b) => a - b)
  ignoredColumns.sort((a, b) => a - b)

  const headerRow: number | null =
    excludeHeader && startRow <= endRow ? startRow : null

  const hiddenRows: ReadonlySet<number> =
    input.hiddenRows instanceof Set
      ? input.hiddenRows
      : new Set(input.hiddenRows ?? EMPTY_HIDDEN_ROWS)

  if (inRangeKeyCols.length === 0) {
    // Match the derived atom's "noKeyColumns" behaviour — never throw
    // on shape. Dialogs surface this via the flag.
    return {
      duplicateRows: [],
      scannedRows: 0,
      uniqueRows: 0,
      ignoredColumns,
      headerRow,
      noKeyColumns: true,
    }
  }

  // Empty range short-circuits before we touch the projection.
  if (startRow > endRow || startCol > endCol) {
    return {
      duplicateRows: [],
      scannedRows: 0,
      uniqueRows: 0,
      ignoredColumns,
      headerRow,
      noKeyColumns: false,
    }
  }

  // Index relevant cells by row then col. We allocate per-row Maps
  // lazily so a sparse 100k-row projection stays cheap.
  const keyColSet = new Set(inRangeKeyCols)
  const byRow = new Map<number, Map<number, string>>()
  for (const cell of cells) {
    if (cell.row < startRow || cell.row > endRow) continue
    if (headerRow !== null && cell.row === headerRow) continue
    if (!keyColSet.has(cell.col)) continue
    let rowMap = byRow.get(cell.row)
    if (!rowMap) {
      rowMap = new Map<number, string>()
      byRow.set(cell.row, rowMap)
    }
    // Blank-kind cells normalise to '' regardless of displayValue
    // (which can be the empty string already, but defensive).
    const raw = cell.valueKind === 'blank' ? '' : cell.displayValue ?? ''
    rowMap.set(cell.col, normaliseValue(raw, comparison))
  }

  const seen = new Map<string, number>()
  const duplicateRows: number[] = []
  let scannedRows = 0

  const valueBuf: string[] = new Array(inRangeKeyCols.length)
  const firstScanRow = headerRow !== null ? startRow + 1 : startRow
  for (let row = firstScanRow; row <= endRow; row += 1) {
    // Hidden rows drop out before anything else: an unrendered row supplies
    // no cells, so scanning it would compare an all-blank tuple that says
    // nothing about the data actually stored there.
    if (hiddenRows.has(row)) continue
    scannedRows += 1
    const rowMap = byRow.get(row)
    for (let i = 0; i < inRangeKeyCols.length; i += 1) {
      const col = inRangeKeyCols[i]
      valueBuf[i] = rowMap?.get(col) ?? ''
    }
    const tupleKey = buildTupleKey(valueBuf)
    const firstSeen = seen.get(tupleKey)
    if (firstSeen === undefined) {
      seen.set(tupleKey, row)
    } else {
      // Display row IS source row (#27): the scan index is what
      // `backend.removeRows` expects, with nothing to translate.
      duplicateRows.push(row)
    }
  }

  duplicateRows.sort((a, b) => a - b)

  return {
    duplicateRows,
    scannedRows,
    uniqueRows: scannedRows - duplicateRows.length,
    ignoredColumns,
    headerRow,
    noKeyColumns: false,
  }
}

/**
 * Type re-export so tests/host adapters can import everything from
 * `./algorithm` without crossing into `./types`. Mirrors the
 * text-to-columns pattern of keeping the algorithm self-contained.
 */
export type { DisplayCell }
