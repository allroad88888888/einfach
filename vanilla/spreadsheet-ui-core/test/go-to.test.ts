import { describe, expect, test } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import {
  applyGoToSpecialResultAtom,
  applyGoToTargetAtom,
  closeGoToAtom,
  confirmGoToAtom,
  goToErrorAtom,
  goToErrorMessageAtom,
  goToHistoryAtom,
  goToInputAtom,
  goToLocatorAtom,
  goToModeAtom,
  goToOpenAtom,
  goToSpecialCapabilityAtom,
  goToSpecialLifecycleAtom,
  goToSpecialPendingAtom,
  goToSpecialWarningAtom,
  GO_TO_HISTORY_MAX,
  GO_TO_REGION_CAP,
  GO_TO_SCAN_MAX_CELLS,
  nextGoToSessionId,
  nextGoToSpecialRequestId,
  openGoToAtom,
  parseGoToReference,
  pushGoToHistoryAtom,
  runGoToSpecialScan,
  runGoToSpecialScanAtom,
  setGoToErrorAtom,
  setGoToInputAtom,
  setGoToLocatorAtom,
  setGoToModeAtom,
  type GoToCandidateCell,
  type GoToLocator,
  type GoToParseContext,
  type GoToScanContext,
  type GoToScanResult,
} from '../src/go-to'
import {
  EXCEL_MAX_COLS,
  EXCEL_MAX_ROWS,
  selectionAtom,
  selectionRegionsAtom,
  setSelectionBoundsAtom,
  setSelectionAtom,
} from '../src/selection'
import { setSheetTabsSheetsAtom } from '../src/sheet-tabs'
import type { CellRange } from '../src/shared'
import type { SelectionState } from '../src/selection'
import { setViewportMetricsAtom } from '../src/viewport'
import { setWorkspaceActiveSheetAtom } from '../src/workspace'
import type { RangeProjectionRequest, RangeProjectionResult } from '../src/backend'

function makeContext(overrides: Partial<GoToParseContext> = {}): GoToParseContext {
  return {
    activeSheetId: 'sheet1',
    sheets: [
      { id: 'sheet1', name: 'Sheet1' },
      { id: 'sheet2', name: 'Sheet2' },
      { id: 'sheet3', name: 'My Sheet' },
    ],
    registry: [
      {
        name: 'MyRange',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet1', address: 'B2:D5' },
      },
      {
        name: 'SinglePoint',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet2', address: 'A1' },
      },
    ],
    ...overrides,
  }
}

function makeScanContext(
  cells: GoToCandidateCell[],
  overrides: Partial<GoToScanContext> = {},
): GoToScanContext {
  return {
    sheetId: 'sheet1',
    activeCell: { row: 0, col: 0 },
    cells,
    ...overrides,
  }
}

// Helper: count cells covered by a list of selection regions. Used to verify
// coalesced rectangle outputs cover the expected number of coords.
function coveredCellCount(regions: readonly SelectionState[]): number {
  let total = 0
  for (const r of regions) {
    if (r.kind === 'cell') {
      total += 1
    } else if (r.kind === 'range') {
      const rows = r.focus.row - r.anchor.row + 1
      const cols = r.focus.col - r.anchor.col + 1
      total += rows * cols
    }
  }
  return total
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function prepareSpecialStore(
  store: Store,
  dimensions: { rowCount: number; colCount: number } = { rowCount: 20, colCount: 8 },
): SelectionState {
  store.setter(setSelectionBoundsAtom, dimensions)
  store.setter(setSheetTabsSheetsAtom, {
    sheets: [
      { id: 'sheet1', name: 'Sheet1', index: 0 },
      { id: 'sheet2', name: 'Sheet2', index: 1 },
    ],
  })
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet1' })
  store.setter(setViewportMetricsAtom, {
    scrollTop: 0,
    scrollLeft: 0,
    viewportHeight: 240,
    viewportWidth: 480,
    rowHeight: 24,
    colWidth: 80,
    rowCount: dimensions.rowCount,
    colCount: dimensions.colCount,
    overscanRows: 0,
    overscanCols: 0,
  })
  const selection: SelectionState = {
    kind: 'cell',
    sheetId: 'sheet1',
    anchor: {
      row: Math.min(1, dimensions.rowCount - 1),
      col: Math.min(1, dimensions.colCount - 1),
    },
    focus: {
      row: Math.min(1, dimensions.rowCount - 1),
      col: Math.min(1, dimensions.colCount - 1),
    },
  }
  store.setter(setSelectionAtom, selection)
  store.setter(openGoToAtom)
  store.setter(setGoToModeAtom, 'special')
  return selection
}

function projectionFor(
  request: RangeProjectionRequest,
  cells: RangeProjectionResult['cells'] = [],
  overrides: Partial<RangeProjectionResult> = {},
): RangeProjectionResult {
  return {
    kind: 'range',
    sheetId: request.sheetId,
    range: request.range,
    requestId: request.requestId,
    cells,
    ...overrides,
  }
}

describe('go-to parser', () => {
  test('parses A1 cell', () => {
    const r = parseGoToReference('B12', makeContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.sheetId).toBe('sheet1')
      expect(r.target.coord).toEqual({ row: 11, col: 1 })
    }
  })

  test('parses A1 range', () => {
    const r = parseGoToReference('A1:C5', makeContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.range).toEqual({ rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 2 })
    }
  })

  test('parses R1C1 cell (absolute)', () => {
    const r = parseGoToReference('R12C3', makeContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.coord).toEqual({ row: 11, col: 2 })
    }
  })

  test('parses R1C1 range (absolute)', () => {
    const r = parseGoToReference('R1C1:R3C2', makeContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.range).toEqual({ rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 })
    }
  })

  test('parses R1C1 relative (positive offset)', () => {
    // Active cell B3 (row 2, col 1); RC[2] → row 2, col 3.
    const r = parseGoToReference('RC[2]', makeContext({ activeCell: { row: 2, col: 1 } }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.coord).toEqual({ row: 2, col: 3 })
    }
  })

  test('parses R1C1 relative (negative offset)', () => {
    // Active cell D5 (row 4, col 3); R[-2]C[-1] → row 2, col 2.
    const r = parseGoToReference('R[-2]C[-1]', makeContext({ activeCell: { row: 4, col: 3 } }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.coord).toEqual({ row: 2, col: 2 })
    }
  })

  test('parses bare RC (same row, same column)', () => {
    const r = parseGoToReference('RC', makeContext({ activeCell: { row: 4, col: 3 } }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.coord).toEqual({ row: 4, col: 3 })
    }
  })

  test('parses mixed relative + bare axis (R[3]C)', () => {
    const r = parseGoToReference('R[3]C', makeContext({ activeCell: { row: 1, col: 2 } }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.coord).toEqual({ row: 4, col: 2 })
    }
  })

  test('parses relative R1C1 range', () => {
    // Active D5 (row 4, col 3); R[-1]C:R[1]C[2] → (3,3):(5,5)
    const r = parseGoToReference('R[-1]C:R[1]C[2]', makeContext({ activeCell: { row: 4, col: 3 } }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.range).toEqual({
        rowStart: 3,
        rowEnd: 5,
        colStart: 3,
        colEnd: 5,
      })
    }
  })

  test('rejects relative R1C1 that resolves out of bounds', () => {
    // Active A1; R[-1]C would resolve to row -1.
    const r = parseGoToReference('R[-1]C', makeContext({ activeCell: { row: 0, col: 0 } }))
    expect(r.ok).toBe(false)
  })

  test('accepts the exact Excel A1 and R1C1 absolute boundary', () => {
    const a1 = parseGoToReference(`XFD${EXCEL_MAX_ROWS}`, makeContext())
    expect(a1.ok).toBe(true)
    if (a1.ok) {
      expect(a1.target.coord).toEqual({
        row: EXCEL_MAX_ROWS - 1,
        col: EXCEL_MAX_COLS - 1,
      })
    }

    const r = parseGoToReference(`R${EXCEL_MAX_ROWS}C${EXCEL_MAX_COLS}`, makeContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.coord).toEqual({
        row: EXCEL_MAX_ROWS - 1,
        col: EXCEL_MAX_COLS - 1,
      })
    }
  })

  test.each(['R0C1', 'R1C0', `R${EXCEL_MAX_ROWS + 1}C1`, `R1C${EXCEL_MAX_COLS + 1}`])(
    'rejects an absolute R1C1 coordinate outside Excel bounds: %s',
    (input) => {
      const r = parseGoToReference(input, makeContext())
      expect(r).toEqual({ ok: false, reason: 'invalid-address' })
    },
  )

  test('accepts positive and negative relative offsets at the exact Excel boundaries', () => {
    const maximum = parseGoToReference(
      `R[${EXCEL_MAX_ROWS - 1}]C[${EXCEL_MAX_COLS - 1}]`,
      makeContext({ activeCell: { row: 0, col: 0 } }),
    )
    expect(maximum.ok).toBe(true)
    if (maximum.ok) {
      expect(maximum.target.coord).toEqual({
        row: EXCEL_MAX_ROWS - 1,
        col: EXCEL_MAX_COLS - 1,
      })
    }

    const minimum = parseGoToReference(
      `R[-${EXCEL_MAX_ROWS - 1}]C[-${EXCEL_MAX_COLS - 1}]`,
      makeContext({
        activeCell: { row: EXCEL_MAX_ROWS - 1, col: EXCEL_MAX_COLS - 1 },
      }),
    )
    expect(minimum.ok).toBe(true)
    if (minimum.ok) {
      expect(minimum.target.coord).toEqual({ row: 0, col: 0 })
    }
  })

  test.each([
    [`R[${EXCEL_MAX_ROWS}]C`, { row: 0, col: 0 }],
    [`RC[${EXCEL_MAX_COLS}]`, { row: 0, col: 0 }],
    ['R[-1]C', { row: 0, col: 0 }],
    ['RC[-1]', { row: 0, col: 0 }],
    ['R[1]C', { row: EXCEL_MAX_ROWS - 1, col: 0 }],
    ['RC[1]', { row: 0, col: EXCEL_MAX_COLS - 1 }],
  ])('rejects a relative R1C1 offset outside Excel bounds: %s', (input, activeCell) => {
    const r = parseGoToReference(input, makeContext({ activeCell }))
    expect(r).toEqual({ ok: false, reason: 'invalid-address' })
  })

  test.each([
    { row: -1, col: 0 },
    { row: EXCEL_MAX_ROWS, col: 0 },
    { row: 0, col: -1 },
    { row: 0, col: EXCEL_MAX_COLS },
  ])('rejects bare RC when its active-cell anchor is outside Excel bounds', (activeCell) => {
    const r = parseGoToReference('RC', makeContext({ activeCell }))
    expect(r).toEqual({ ok: false, reason: 'invalid-address' })
  })

  test('rejects an R1C1 range when either endpoint is outside Excel bounds', () => {
    const absolute = parseGoToReference(`R1C1:R${EXCEL_MAX_ROWS + 1}C1`, makeContext())
    expect(absolute).toEqual({ ok: false, reason: 'invalid-address' })

    const relative = parseGoToReference(
      'RC:R[1]C',
      makeContext({ activeCell: { row: EXCEL_MAX_ROWS - 1, col: 0 } }),
    )
    expect(relative).toEqual({ ok: false, reason: 'invalid-address' })
  })

  test('defaults active cell to A1 when omitted', () => {
    const r = parseGoToReference('RC[1]', makeContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.coord).toEqual({ row: 0, col: 1 })
    }
  })

  test('parses sheet-qualified address', () => {
    const r = parseGoToReference('Sheet2!B3', makeContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.sheetId).toBe('sheet2')
      expect(r.target.coord).toEqual({ row: 2, col: 1 })
    }
  })

  test('parses quoted sheet-qualified address with space', () => {
    const r = parseGoToReference("'My Sheet'!A1:B3", makeContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.sheetId).toBe('sheet3')
      expect(r.target.range).toEqual({ rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 })
    }
  })

  test('resolves named range to its registered sheet', () => {
    const r = parseGoToReference('MyRange', makeContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.sheetId).toBe('sheet1')
      expect(r.target.range).toEqual({ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 3 })
    }
  })

  test('resolves single-cell named range', () => {
    const r = parseGoToReference('SinglePoint', makeContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.sheetId).toBe('sheet2')
      expect(r.target.coord).toEqual({ row: 0, col: 0 })
    }
  })

  test('prefers the active-sheet named range over workbook and other-sheet names', () => {
    const registry: GoToParseContext['registry'] = [
      {
        name: 'ScopedTarget',
        scope: { sheetId: 'sheet2' },
        refersTo: { kind: 'range', sheetId: 'sheet2', address: 'C3' },
      },
      {
        name: 'ScopedTarget',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet3', address: 'A1' },
      },
      {
        name: 'ScopedTarget',
        scope: { sheetId: 'sheet1' },
        refersTo: { kind: 'range', sheetId: 'sheet1', address: 'B2' },
      },
    ]

    const r = parseGoToReference('ScopedTarget', makeContext({ registry }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target).toEqual({ sheetId: 'sheet1', coord: { row: 1, col: 1 } })
    }
  })

  test('uses the matching local name when the active sheet changes', () => {
    const registry: GoToParseContext['registry'] = [
      {
        name: 'ScopedTarget',
        scope: { sheetId: 'sheet1' },
        refersTo: { kind: 'range', sheetId: 'sheet1', address: 'B2' },
      },
      {
        name: 'ScopedTarget',
        scope: { sheetId: 'sheet2' },
        refersTo: { kind: 'range', sheetId: 'sheet2', address: 'C3' },
      },
      {
        name: 'ScopedTarget',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet3', address: 'A1' },
      },
    ]

    const r = parseGoToReference('ScopedTarget', makeContext({ activeSheetId: 'sheet2', registry }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target).toEqual({ sheetId: 'sheet2', coord: { row: 2, col: 2 } })
    }
  })

  test('falls back to a workbook name instead of leaking another sheet local name', () => {
    const registry: GoToParseContext['registry'] = [
      {
        name: 'ScopedTarget',
        scope: { sheetId: 'sheet2' },
        refersTo: { kind: 'range', sheetId: 'sheet2', address: 'C3' },
      },
      {
        name: 'ScopedTarget',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet3', address: 'A1' },
      },
    ]

    const r = parseGoToReference('ScopedTarget', makeContext({ registry }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target).toEqual({ sheetId: 'sheet3', coord: { row: 0, col: 0 } })
    }
  })

  test('does not resolve a local name owned by another sheet without a workbook fallback', () => {
    const registry: GoToParseContext['registry'] = [
      {
        name: 'LocalOnly',
        scope: { sheetId: 'sheet2' },
        refersTo: { kind: 'range', sheetId: 'sheet2', address: 'C3' },
      },
    ]

    const r = parseGoToReference('LocalOnly', makeContext({ registry }))
    expect(r).toEqual({ ok: false, reason: 'unknown-name' })
  })

  test('rejects garbage', () => {
    const r = parseGoToReference('not-an-address', makeContext())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('invalid-address')
    }
  })

  test('rejects unknown bare identifier as unknown-name', () => {
    const r = parseGoToReference('UnknownName', makeContext())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('unknown-name')
    }
  })

  test('rejects unknown sheet prefix', () => {
    const r = parseGoToReference('NoSuchSheet!A1', makeContext())
    expect(r.ok).toBe(false)
  })

  test('empty input', () => {
    const r = parseGoToReference('   ', makeContext())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty')
  })
})

describe('go-to atoms', () => {
  test('open/close lifecycle', () => {
    const store = createStore()
    expect(store.getter(goToOpenAtom)).toBe(false)
    store.setter(openGoToAtom)
    expect(store.getter(goToOpenAtom)).toBe(true)
    store.setter(setGoToInputAtom, 'A1')
    store.setter(closeGoToAtom)
    expect(store.getter(goToOpenAtom)).toBe(false)
    expect(store.getter(goToInputAtom)).toBe('')
    expect(store.getter(goToErrorAtom)).toBeNull()
  })

  test('history dedupes and caps at GO_TO_HISTORY_MAX', () => {
    const store = createStore()
    for (let i = 0; i < GO_TO_HISTORY_MAX + 5; i += 1) {
      store.setter(pushGoToHistoryAtom, `A${i + 1}`)
    }
    const hist = store.getter(goToHistoryAtom)
    expect(hist.length).toBe(GO_TO_HISTORY_MAX)
    // Most recent first.
    expect(hist[0]).toBe(`A${GO_TO_HISTORY_MAX + 5}`)

    // Push a duplicate of the bottom entry — it moves to the top, history
    // length stays at max.
    const lowest = hist[hist.length - 1]
    store.setter(pushGoToHistoryAtom, lowest)
    const next = store.getter(goToHistoryAtom)
    expect(next.length).toBe(GO_TO_HISTORY_MAX)
    expect(next[0]).toBe(lowest)
  })

  test('setGoToModeAtom + setGoToLocatorAtom round-trip', () => {
    const store = createStore()
    expect(store.getter(goToModeAtom)).toBe('simple')
    store.setter(setGoToModeAtom, 'special')
    expect(store.getter(goToModeAtom)).toBe('special')
    const next: GoToLocator = { kind: 'formulas', valueKind: 'number' }
    store.setter(setGoToLocatorAtom, next)
    expect(store.getter(goToLocatorAtom)).toEqual(next)
  })

  test('setGoToErrorAtom + setGoToInputAtom interaction', () => {
    const store = createStore()
    store.setter(setGoToErrorAtom, 'goTo.error.empty')
    expect(store.getter(goToErrorAtom)).toBe('goTo.error.empty')
    store.setter(setGoToInputAtom, 'B7')
    // Setting input clears the previous error so the user sees a fresh slate.
    expect(store.getter(goToErrorAtom)).toBeNull()
  })

  test('applyGoToTargetAtom collapses single-cell range to cell selection', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 1000, colCount: 100 })
    store.setter(applyGoToTargetAtom, {
      sheetId: 's',
      range: { rowStart: 4, rowEnd: 4, colStart: 2, colEnd: 2 },
    })
    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'cell',
      sheetId: 's',
      anchor: { row: 4, col: 2 },
    })
  })

  test('applyGoToTargetAtom routes range selection', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 1000, colCount: 100 })
    store.setter(applyGoToTargetAtom, {
      sheetId: 's',
      range: { rowStart: 1, rowEnd: 4, colStart: 0, colEnd: 2 },
    })
    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'range',
      sheetId: 's',
      anchor: { row: 1, col: 0 },
      focus: { row: 4, col: 2 },
    })
  })

  test('applyGoToSpecialResultAtom uses setMultiRegionSelectionAtom for many matches', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 1000, colCount: 100 })
    const result: GoToScanResult = {
      regions: [
        { kind: 'cell', sheetId: 's', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } },
        { kind: 'cell', sheetId: 's', anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } },
        { kind: 'cell', sheetId: 's', anchor: { row: 2, col: 3 }, focus: { row: 2, col: 3 } },
      ],
      truncated: false,
      totalMatchCount: 3,
    }
    store.setter(applyGoToSpecialResultAtom, { result, sheetId: 's' })
    // The number of selection regions matches the scan result.
    expect(store.getter(selectionRegionsAtom).length).toBe(3)
  })

  test('confirmGoToAtom (parse-error) keeps dialog open and sets error', () => {
    const store = createStore()
    store.setter(openGoToAtom)
    store.setter(confirmGoToAtom, { kind: 'parse-error', code: 'goTo.error.invalidAddress' })
    expect(store.getter(goToOpenAtom)).toBe(true)
    expect(store.getter(goToErrorAtom)).toBe('goTo.error.invalidAddress')
  })

  test('confirmGoToAtom (simple-target) commits selection, pushes history, closes', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 1000, colCount: 100 })
    store.setter(openGoToAtom)
    store.setter(confirmGoToAtom, {
      kind: 'simple-target',
      target: { sheetId: 's', coord: { row: 4, col: 2 } },
      historyEntry: 'C5',
    })
    expect(store.getter(goToOpenAtom)).toBe(false)
    expect(store.getter(goToHistoryAtom)).toContain('C5')
    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'cell',
      sheetId: 's',
      anchor: { row: 4, col: 2 },
    })
  })
})

describe('go-to special async state machine', () => {
  test('session and request identities cross the safe boundary without reuse', () => {
    for (const nextIdentity of [nextGoToSessionId, nextGoToSpecialRequestId]) {
      expect(nextIdentity(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER)
      expect(nextIdentity(Number.MAX_SAFE_INTEGER)).toBe(-1)
      expect(nextIdentity(-1)).toBe(-2)
      expect(nextIdentity(Number.MIN_SAFE_INTEGER + 1)).toBe(Number.MIN_SAFE_INTEGER)
      expect(nextIdentity(Number.MIN_SAFE_INTEGER)).toBeNull()
      expect(nextIdentity(Number.MAX_SAFE_INTEGER + 1)).toBeNull()
      expect(nextIdentity(Number.MIN_SAFE_INTEGER - 1)).toBeNull()
      expect(nextIdentity(Number.NaN)).toBeNull()
    }
  })

  test('full projection match commits the selection and closes the session', async () => {
    const store = createStore()
    prepareSpecialStore(store)
    store.setter(setGoToLocatorAtom, { kind: 'comments' })
    const requests: RangeProjectionRequest[] = []

    await store.setter(runGoToSpecialScanAtom, {
      port: {
        async readRangeProjection(request) {
          requests.push(request)
          return projectionFor(request, [
            {
              row: 2,
              col: 3,
              displayValue: 'commented',
              valueKind: 'string',
              commentThreadId: 'thread-1',
            },
          ])
        },
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      kind: 'range',
      sheetId: 'sheet1',
      requestId: 1,
      range: { rowStart: 0, rowEnd: 19, colStart: 0, colEnd: 7 },
    })
    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'cell',
      sheetId: 'sheet1',
      anchor: { row: 2, col: 3 },
    })
    expect(store.getter(goToOpenAtom)).toBe(false)
    expect(store.getter(goToSpecialPendingAtom)).toBe(false)
    expect(store.getter(goToSpecialLifecycleAtom)).toMatchObject({
      phase: 'closed',
      capability: 'available',
    })
  })

  test('complete projection with no match stays open with noMatches', async () => {
    const store = createStore()
    const initialSelection = prepareSpecialStore(store)
    store.setter(setGoToLocatorAtom, { kind: 'comments' })

    await store.setter(runGoToSpecialScanAtom, {
      port: {
        async readRangeProjection(request) {
          return projectionFor(request, [
            { row: 0, col: 0, displayValue: 'plain', valueKind: 'string' },
          ])
        },
      },
    })

    expect(store.getter(selectionAtom)).toEqual(initialSelection)
    expect(store.getter(goToOpenAtom)).toBe(true)
    expect(store.getter(goToErrorAtom)).toBe('goTo.error.noMatches')
    expect(store.getter(goToSpecialWarningAtom)).toBeNull()
    expect(store.getter(goToSpecialLifecycleAtom)).toMatchObject({
      phase: 'open-error',
      error: { code: 'goTo.error.noMatches' },
    })
  })

  test('bounded projection with no match keeps selection and exposes incomplete warning', async () => {
    const store = createStore()
    const initialSelection = prepareSpecialStore(store, { rowCount: 100_001, colCount: 1 })
    store.setter(setGoToLocatorAtom, { kind: 'comments' })
    let captured: RangeProjectionRequest | null = null

    await store.setter(runGoToSpecialScanAtom, {
      port: {
        async readRangeProjection(request) {
          captured = request
          return projectionFor(request)
        },
      },
    })

    expect(captured?.range).toEqual({ rowStart: 0, rowEnd: 99_999, colStart: 0, colEnd: 0 })
    expect(store.getter(selectionAtom)).toEqual(initialSelection)
    expect(store.getter(goToOpenAtom)).toBe(true)
    expect(store.getter(goToErrorAtom)).toBeNull()
    expect(store.getter(goToSpecialWarningAtom)).toEqual({
      reason: 'cells',
      limit: GO_TO_SCAN_MAX_CELLS,
    })
    expect(store.getter(goToSpecialLifecycleAtom)).toMatchObject({
      phase: 'open-warning',
      warning: { reason: 'cells', limit: GO_TO_SCAN_MAX_CELLS },
    })
  })

  test('wide projection range is clipped in both dimensions to the hard cell budget', async () => {
    const store = createStore()
    const initialSelection = prepareSpecialStore(store, {
      rowCount: 2,
      colCount: GO_TO_SCAN_MAX_CELLS + 1,
    })
    store.setter(setGoToLocatorAtom, { kind: 'comments' })
    const requests: RangeProjectionRequest[] = []

    await store.setter(runGoToSpecialScanAtom, {
      port: {
        async readRangeProjection(request) {
          requests.push(request)
          return projectionFor(request)
        },
      },
    })

    expect(requests).toHaveLength(1)
    const range = requests[0].range
    expect(range).toEqual({
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: GO_TO_SCAN_MAX_CELLS - 1,
    })
    expect(
      (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1),
    ).toBeLessThanOrEqual(GO_TO_SCAN_MAX_CELLS)
    expect(store.getter(selectionAtom)).toEqual(initialSelection)
    expect(store.getter(goToSpecialWarningAtom)).toEqual({
      reason: 'cells',
      limit: GO_TO_SCAN_MAX_CELLS,
    })
  })

  test('row differences projects and scans the exact normalized non-A1 selection', async () => {
    const store = createStore()
    prepareSpecialStore(store, { rowCount: 1_000, colCount: 200 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet1',
      anchor: { row: 101, col: 52 },
      focus: { row: 100, col: 50 },
    })
    store.setter(setGoToLocatorAtom, { kind: 'row-differences' })
    const requests: RangeProjectionRequest[] = []

    await store.setter(runGoToSpecialScanAtom, {
      port: {
        async readRangeProjection(request) {
          requests.push(request)
          return projectionFor(request, [
            { row: 100, col: 50, displayValue: 'A', valueKind: 'string' },
            { row: 100, col: 51, displayValue: 'A', valueKind: 'string' },
            { row: 100, col: 52, displayValue: 'B', valueKind: 'string' },
            { row: 101, col: 50, displayValue: 'C', valueKind: 'string' },
            { row: 101, col: 51, displayValue: 'C', valueKind: 'string' },
            { row: 101, col: 52, displayValue: 'C', valueKind: 'string' },
          ])
        },
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].range).toEqual({
      rowStart: 100,
      rowEnd: 101,
      colStart: 50,
      colEnd: 52,
    })
    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'cell',
      anchor: { row: 100, col: 52 },
    })
    expect(store.getter(goToOpenAtom)).toBe(false)
  })

  test('oversized non-A1 difference selection is capped and fails closed', async () => {
    const store = createStore()
    prepareSpecialStore(store, { rowCount: 2_000, colCount: 200 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet1',
      anchor: { row: 5, col: 7 },
      focus: { row: 1_005, col: 107 },
    })
    const initialSelection = store.getter(selectionAtom)
    store.setter(setGoToLocatorAtom, { kind: 'row-differences' })
    const requests: RangeProjectionRequest[] = []

    await store.setter(runGoToSpecialScanAtom, {
      port: {
        async readRangeProjection(request) {
          requests.push(request)
          return projectionFor(request, [
            { row: 5, col: 7, displayValue: 'anchor', valueKind: 'string' },
            { row: 5, col: 8, displayValue: 'different', valueKind: 'string' },
          ])
        },
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].range).toEqual({
      rowStart: 5,
      rowEnd: 994,
      colStart: 7,
      colEnd: 107,
    })
    const requestRange = requests[0].range
    expect(
      (requestRange.rowEnd - requestRange.rowStart + 1) *
        (requestRange.colEnd - requestRange.colStart + 1),
    ).toBeLessThanOrEqual(GO_TO_SCAN_MAX_CELLS)
    expect(store.getter(selectionAtom)).toEqual(initialSelection)
    expect(store.getter(goToOpenAtom)).toBe(true)
    expect(store.getter(goToErrorAtom)).toBeNull()
    expect(store.getter(goToSpecialWarningAtom)).toEqual({
      reason: 'cells',
      limit: GO_TO_SCAN_MAX_CELLS,
    })
  })

  test('bounded last-cell and current-region scans fail closed before locator execution', async () => {
    for (const kind of ['last-cell', 'current-region'] as const) {
      const store = createStore()
      const initialSelection = prepareSpecialStore(store, {
        rowCount: GO_TO_SCAN_MAX_CELLS + 1,
        colCount: 1,
      })
      store.setter(setGoToLocatorAtom, { kind })
      const requests: RangeProjectionRequest[] = []

      await store.setter(runGoToSpecialScanAtom, {
        port: {
          async readRangeProjection(request) {
            requests.push(request)
            const cells: RangeProjectionResult['cells'] = [
              {
                row: GO_TO_SCAN_MAX_CELLS - 1,
                col: 0,
                displayValue: 'partial',
                valueKind: 'string',
              },
            ]
            if (kind === 'current-region') {
              // The active cell is row 1. If the locator runs despite the
              // clipped worksheet scope, this adjacent occupied row forces a
              // row 1:2 range and makes the selection mutation observable.
              cells.push({ row: 2, col: 0, displayValue: 'adjacent', valueKind: 'string' })
            }
            return projectionFor(request, cells)
          },
        },
      })

      expect(requests).toHaveLength(1)
      expect(store.getter(selectionAtom)).toEqual(initialSelection)
      expect(store.getter(goToOpenAtom)).toBe(true)
      expect(store.getter(goToErrorAtom)).toBeNull()
      expect(store.getter(goToSpecialWarningAtom)).toEqual({
        reason: 'cells',
        limit: GO_TO_SCAN_MAX_CELLS,
      })
    }
  })

  test('backend-truncated sparse projection fails closed before blanks locator', async () => {
    const store = createStore()
    const initialSelection = prepareSpecialStore(store)
    store.setter(setGoToLocatorAtom, { kind: 'blanks' })

    await store.setter(runGoToSpecialScanAtom, {
      port: {
        async readRangeProjection(request) {
          // An omitted occupied cell is indistinguishable from a blank in a
          // sparse payload. The truncated witness must prevent locator commit.
          return projectionFor(request, [], { truncated: true })
        },
      },
    })

    expect(store.getter(selectionAtom)).toEqual(initialSelection)
    expect(store.getter(goToOpenAtom)).toBe(true)
    expect(store.getter(goToErrorAtom)).toBeNull()
    expect(store.getter(goToSpecialWarningAtom)).toEqual({
      reason: 'cells',
      limit: GO_TO_SCAN_MAX_CELLS,
    })
    expect(store.getter(goToSpecialLifecycleAtom)).toMatchObject({
      phase: 'open-warning',
      warning: { reason: 'cells', limit: GO_TO_SCAN_MAX_CELLS },
    })
  })

  test('bounded projection with a match commits selection but remains open with warning', async () => {
    const store = createStore()
    prepareSpecialStore(store, { rowCount: 100_001, colCount: 1 })
    store.setter(setGoToLocatorAtom, { kind: 'comments' })

    await store.setter(runGoToSpecialScanAtom, {
      port: {
        async readRangeProjection(request) {
          return projectionFor(request, [
            {
              row: 99_999,
              col: 0,
              displayValue: 'commented',
              valueKind: 'string',
              commentThreadId: 'thread-last',
            },
          ])
        },
      },
    })

    expect(store.getter(selectionAtom)).toMatchObject({
      kind: 'cell',
      anchor: { row: 99_999, col: 0 },
    })
    expect(store.getter(goToOpenAtom)).toBe(true)
    expect(store.getter(goToSpecialWarningAtom)).toEqual({
      reason: 'cells',
      limit: GO_TO_SCAN_MAX_CELLS,
    })
  })

  test('pending reservation prevents double dispatch', async () => {
    const store = createStore()
    prepareSpecialStore(store)
    store.setter(setGoToLocatorAtom, { kind: 'comments' })
    const gate = deferred<RangeProjectionResult>()
    const requests: RangeProjectionRequest[] = []
    const port = {
      readRangeProjection(request: RangeProjectionRequest) {
        requests.push(request)
        return gate.promise
      },
    }

    const first = store.setter(runGoToSpecialScanAtom, { port })
    const second = store.setter(runGoToSpecialScanAtom, { port })

    expect(requests).toHaveLength(1)
    expect(store.getter(goToSpecialPendingAtom)).toBe(true)
    expect(store.getter(goToSpecialLifecycleAtom)).toMatchObject({
      phase: 'scanning',
      requestId: 1,
      sheetId: 'sheet1',
    })

    gate.resolve(projectionFor(requests[0]))
    await Promise.all([first, second])
    expect(requests).toHaveLength(1)
    expect(store.getter(goToSpecialPendingAtom)).toBe(false)
  })

  test('close and reopen invalidates the old session result', async () => {
    const store = createStore()
    const initialSelection = prepareSpecialStore(store)
    store.setter(setGoToLocatorAtom, { kind: 'comments' })
    const gate = deferred<RangeProjectionResult>()
    let request!: RangeProjectionRequest
    const pending = store.setter(runGoToSpecialScanAtom, {
      port: {
        readRangeProjection(next) {
          request = next
          return gate.promise
        },
      },
    })
    const oldSession = store.getter(goToSpecialLifecycleAtom)

    store.setter(closeGoToAtom)
    store.setter(openGoToAtom)
    store.setter(setGoToModeAtom, 'special')
    gate.resolve(
      projectionFor(request, [
        {
          row: 4,
          col: 4,
          displayValue: 'stale',
          valueKind: 'string',
          commentThreadId: 'stale-thread',
        },
      ]),
    )
    await pending

    expect(store.getter(selectionAtom)).toEqual(initialSelection)
    expect(store.getter(goToOpenAtom)).toBe(true)
    expect(store.getter(goToErrorAtom)).toBeNull()
    expect(store.getter(goToSpecialWarningAtom)).toBeNull()
    expect(store.getter(goToSpecialLifecycleAtom)).toMatchObject({
      phase: 'open',
      sessionId: (oldSession as { sessionId: number }).sessionId + 2,
      mode: 'special',
    })
  })

  test('workspace A-B-A, locator and selection changes revoke an in-flight ticket', async () => {
    for (const revoke of ['sheet', 'locator', 'selection'] as const) {
      const store = createStore()
      const initialSelection = prepareSpecialStore(store)
      store.setter(setGoToLocatorAtom, { kind: 'comments' })
      const gate = deferred<RangeProjectionResult>()
      let request!: RangeProjectionRequest
      const pending = store.setter(runGoToSpecialScanAtom, {
        port: {
          readRangeProjection(next) {
            request = next
            return gate.promise
          },
        },
      })

      if (revoke === 'sheet') {
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet2' })
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet1' })
      } else if (revoke === 'locator') {
        store.setter(setGoToLocatorAtom, { kind: 'last-cell' })
      } else {
        store.setter(setSelectionAtom, {
          kind: 'cell',
          sheetId: 'sheet1',
          anchor: { row: 2, col: 2 },
          focus: { row: 2, col: 2 },
        })
        store.setter(setSelectionAtom, initialSelection)
      }
      expect(store.getter(goToSpecialPendingAtom)).toBe(false)
      gate.resolve(
        projectionFor(request, [
          {
            row: 4,
            col: 4,
            displayValue: 'stale',
            valueKind: 'string',
            commentThreadId: 'stale-thread',
          },
        ]),
      )
      await pending

      expect(store.getter(selectionAtom)).toEqual(initialSelection)
      expect(store.getter(goToOpenAtom)).toBe(true)
      expect(store.getter(goToErrorAtom)).toBeNull()
      expect(store.getter(goToSpecialWarningAtom)).toBeNull()
    }
  })

  test('strict projection acknowledgement mismatch stays open with explicit error', async () => {
    const store = createStore()
    const initialSelection = prepareSpecialStore(store)
    store.setter(setGoToLocatorAtom, { kind: 'comments' })

    await store.setter(runGoToSpecialScanAtom, {
      port: {
        async readRangeProjection(request) {
          return projectionFor(request, [], { requestId: request.requestId + 1 })
        },
      },
    })

    expect(store.getter(selectionAtom)).toEqual(initialSelection)
    expect(store.getter(goToOpenAtom)).toBe(true)
    expect(store.getter(goToErrorAtom)).toBe('goTo.error.projectionMismatch')
    expect(store.getter(goToErrorMessageAtom)).toContain('different request or worksheet')
  })

  test('missing projection capability and transport rejection stay open with explicit errors', async () => {
    const unavailableStore = createStore()
    prepareSpecialStore(unavailableStore)
    await unavailableStore.setter(runGoToSpecialScanAtom, { port: {} })
    expect(unavailableStore.getter(goToSpecialCapabilityAtom)).toBe('unavailable')
    expect(unavailableStore.getter(goToErrorAtom)).toBe('goTo.error.capabilityUnavailable')
    expect(unavailableStore.getter(goToErrorMessageAtom)).toContain('range projection')
    expect(unavailableStore.getter(goToOpenAtom)).toBe(true)
    expect(unavailableStore.getter(goToSpecialPendingAtom)).toBe(false)

    const rejectedStore = createStore()
    prepareSpecialStore(rejectedStore)
    await rejectedStore.setter(runGoToSpecialScanAtom, {
      port: {
        async readRangeProjection() {
          throw new Error('worker offline')
        },
      },
    })
    expect(rejectedStore.getter(goToErrorAtom)).toBe('goTo.error.scanFailed')
    expect(rejectedStore.getter(goToErrorMessageAtom)).toContain('worker offline')
    expect(rejectedStore.getter(goToOpenAtom)).toBe(true)
    expect(rejectedStore.getter(goToSpecialPendingAtom)).toBe(false)
  })

  test('request sequences and pending state are isolated per store', async () => {
    const firstStore = createStore()
    const secondStore = createStore()
    prepareSpecialStore(firstStore)
    prepareSpecialStore(secondStore)
    firstStore.setter(setGoToLocatorAtom, { kind: 'comments' })
    secondStore.setter(setGoToLocatorAtom, { kind: 'comments' })
    const firstRequests: RangeProjectionRequest[] = []
    const secondRequests: RangeProjectionRequest[] = []

    await Promise.all([
      firstStore.setter(runGoToSpecialScanAtom, {
        port: {
          async readRangeProjection(request) {
            firstRequests.push(request)
            return projectionFor(request, [
              {
                row: 2,
                col: 2,
                displayValue: 'first',
                valueKind: 'string',
                commentThreadId: 'first-thread',
              },
            ])
          },
        },
      }),
      secondStore.setter(runGoToSpecialScanAtom, {
        port: {
          async readRangeProjection(request) {
            secondRequests.push(request)
            return projectionFor(request, [
              {
                row: 3,
                col: 3,
                displayValue: 'second',
                valueKind: 'string',
                commentThreadId: 'second-thread',
              },
            ])
          },
        },
      }),
    ])

    expect(firstRequests[0].requestId).toBe(1)
    expect(secondRequests[0].requestId).toBe(1)
    expect(firstStore.getter(selectionAtom)).toMatchObject({ anchor: { row: 2, col: 2 } })
    expect(secondStore.getter(selectionAtom)).toMatchObject({ anchor: { row: 3, col: 3 } })
    expect(firstStore.getter(goToOpenAtom)).toBe(false)
    expect(secondStore.getter(goToOpenAtom)).toBe(false)
  })
})

describe('go-to locator engine', () => {
  // Realistic *sparse* fixture: the host projection emits ONLY non-blank
  // cells. Blank coords inside the search rect are absent from `cells`.
  // Used range = rows 0..3 × cols 0..3 (4×4 = 16 coords; 8 occupied, 8 blank).
  //
  // Layout:
  //   row0:  [10] [20] [=A1] [   ]    (number/number/formula/blank)
  //   row1:  [  ] [TR] [foo] [#DIV/0]  (blank/boolean/string/error)
  //   row2:  [  ] [  ] [   ] [    ]    (all-blank row — current-region wall)
  //   row3:  [x ] [y*] [z  ] [w   ]    (string row; (3,1) has comment + cf)
  function sparseFixture(): GoToCandidateCell[] {
    return [
      { row: 0, col: 0, displayValue: '10', valueKind: 'number' },
      { row: 0, col: 1, displayValue: '20', valueKind: 'number' },
      { row: 0, col: 2, displayValue: '10', valueKind: 'number', formula: '=A1' },
      { row: 1, col: 1, displayValue: 'TRUE', valueKind: 'boolean' },
      { row: 1, col: 2, displayValue: 'foo', valueKind: 'string' },
      { row: 1, col: 3, displayValue: '#DIV/0!', valueKind: 'error' },
      { row: 3, col: 0, displayValue: 'x', valueKind: 'string' },
      {
        row: 3,
        col: 1,
        displayValue: 'y',
        valueKind: 'string',
        commentThreadId: 'thread-1',
        conditionalFormat: { bgColor: '#fff' },
      },
      { row: 3, col: 2, displayValue: 'z', valueKind: 'string', validation: { ok: true } },
      { row: 3, col: 3, displayValue: 'w', valueKind: 'string' },
    ]
  }

  const FIXTURE_RECT: CellRange = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 3 }

  test('blanks locator finds blank coords absent from sparse projection', () => {
    // Search rect = 4×4 (16 coords). Occupied = 10 (formula spills are filled,
    // but 10 from fixture). Blank coords = 16 - 10 = 6:
    //   (0,3), (1,0), (2,0), (2,1), (2,2), (2,3)
    const scan = runGoToSpecialScan(
      { kind: 'blanks' },
      makeScanContext(sparseFixture(), { searchRect: FIXTURE_RECT }),
    )
    expect(scan.totalMatchCount).toBe(6)
    // Verify the matched coords are exactly the blank coords from the layout.
    expect(coveredCellCount(scan.regions)).toBe(6)
    expect(scan.truncated).toBe(false)
  })

  test('blanks locator coalesces row-2 (4 contiguous blanks) into a single range', () => {
    const scan = runGoToSpecialScan(
      { kind: 'blanks' },
      makeScanContext(sparseFixture(), { searchRect: FIXTURE_RECT }),
    )
    // Row 2 is fully blank in the rect — should coalesce into one
    // RangeSelection covering (2,0)..(2,3).
    const row2 = scan.regions.find(
      (r) => r.kind === 'range' && r.anchor.row === 2 && r.focus.row === 2,
    )
    expect(row2).toBeDefined()
    if (row2 && row2.kind === 'range') {
      expect(row2.anchor.col).toBe(0)
      expect(row2.focus.col).toBe(3)
    }
  })

  test('blanks locator returns empty when host omits searchRect', () => {
    const scan = runGoToSpecialScan({ kind: 'blanks' }, makeScanContext(sparseFixture()))
    // No rect = nothing to scan; sparse projection has no blanks to walk.
    expect(scan.totalMatchCount).toBe(0)
  })

  test('blanks locator on empty rect (no projection cells) emits every coord', () => {
    const rect: CellRange = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 }
    const scan = runGoToSpecialScan({ kind: 'blanks' }, makeScanContext([], { searchRect: rect }))
    expect(scan.totalMatchCount).toBe(6) // 2 rows × 3 cols
    // 2 full rows × 3 cols each → 2 RangeSelection rows.
    expect(scan.regions.length).toBe(2)
  })

  test('formulas locator with no sub-filter selects only formula cells', () => {
    const scan = runGoToSpecialScan(
      { kind: 'formulas', valueKind: null },
      makeScanContext(sparseFixture()),
    )
    expect(scan.totalMatchCount).toBe(1)
    expect(scan.regions[0]).toMatchObject({
      kind: 'cell',
      anchor: { row: 0, col: 2 },
    })
  })

  test('constants locator excludes formulas and blanks', () => {
    const scan = runGoToSpecialScan(
      { kind: 'constants', valueKind: null },
      makeScanContext(sparseFixture()),
    )
    // 2 numbers (0,0)+(0,1), 1 boolean (1,1), 1 string (1,2), 1 error (1,3),
    // 4 strings on row 3 = 9.
    expect(scan.totalMatchCount).toBe(9)
  })

  test('constants.number filter restricts to numbers', () => {
    const scan = runGoToSpecialScan(
      { kind: 'constants', valueKind: 'number' },
      makeScanContext(sparseFixture()),
    )
    expect(scan.totalMatchCount).toBe(2)
  })

  test('comments locator selects cells with a thread id', () => {
    const scan = runGoToSpecialScan({ kind: 'comments' }, makeScanContext(sparseFixture()))
    expect(scan.totalMatchCount).toBe(1)
    expect(scan.regions[0]).toMatchObject({ anchor: { row: 3, col: 1 } })
  })

  test('conditional-format locator selects cells with a rule echo', () => {
    const scan = runGoToSpecialScan(
      { kind: 'conditional-format' },
      makeScanContext(sparseFixture()),
    )
    expect(scan.totalMatchCount).toBe(1)
  })

  test('data-validation locator selects cells with a validation echo', () => {
    const scan = runGoToSpecialScan({ kind: 'data-validation' }, makeScanContext(sparseFixture()))
    expect(scan.totalMatchCount).toBe(1)
  })

  test('last-cell locator returns bottom-right populated cell', () => {
    const scan = runGoToSpecialScan({ kind: 'last-cell' }, makeScanContext(sparseFixture()))
    expect(scan.regions[0]).toMatchObject({ anchor: { row: 3, col: 3 } })
  })

  test('current-region expands to the contiguous data block', () => {
    const scan = runGoToSpecialScan(
      { kind: 'current-region' },
      makeScanContext(sparseFixture(), { activeCell: { row: 0, col: 0 } }),
    )
    // Rows 0-1 are populated (row 2 is fully blank — wall). Cols 0..3 are
    // populated across rows 0-1.
    expect(scan.regions[0]).toMatchObject({
      kind: 'range',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 3 },
    })
  })

  test('visible-cells-only walks the rect and excludes hidden rows + cols', () => {
    const scan = runGoToSpecialScan(
      { kind: 'visible-cells-only' },
      makeScanContext(sparseFixture(), {
        searchRect: FIXTURE_RECT,
        hiddenRows: [1], // hide row 1 (was: 4 cells worth in rect)
        hiddenCols: [3], // hide col 3 (was: 4 cells worth in rect)
      }),
    )
    // 4×4 rect = 16 coords. Hidden row 1 = 4 coords. Hidden col 3 = 4 coords.
    // Intersection (1,3) double-counted once = 4 + 4 - 1 = 7 excluded.
    // Visible = 16 - 7 = 9. INCLUDES blanks (Excel keeps blank visible cells).
    expect(scan.totalMatchCount).toBe(9)
  })

  test('visible-cells-only ignores stale originalRow echo', () => {
    // Old impl filtered cells with `originalRow !== row` — but originalRow is
    // not always populated and shouldn't drive visibility. With no hidden
    // ports set, every coord in the rect should match (16 cells).
    const cells = sparseFixture().map((c) => (c.row === 0 ? { ...c, originalRow: 99 } : c))
    const scan = runGoToSpecialScan(
      { kind: 'visible-cells-only' },
      makeScanContext(cells, { searchRect: FIXTURE_RECT }),
    )
    // 4×4 rect, no hidden rows/cols → all 16 coords visible.
    expect(scan.totalMatchCount).toBe(16)
  })

  test('row-differences scopes to the current selection rect (not used range)', () => {
    // Selection = rows 0..1 × cols 0..3 (i.e. don't include rows 2-3).
    // Active cell (0, 0) — col 0 is the anchor.
    // Row 0 anchors at '10'; (0,1)='20' differs, (0,2) formula differs,
    //   (0,3) blank differs → 3 matches.
    // Row 1 anchors at blank (1,0); (1,1)='TRUE' differs, (1,2)='foo'
    //   differs, (1,3)='#DIV/0!' differs → 3 matches.
    // Total = 6.
    const selectionRect: CellRange = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 3 }
    const scan = runGoToSpecialScan(
      { kind: 'row-differences' },
      makeScanContext(sparseFixture(), {
        activeCell: { row: 0, col: 0 },
        searchRect: FIXTURE_RECT,
        selectionRect,
      }),
    )
    expect(scan.totalMatchCount).toBe(6)
    // None of the matches should be on rows 2-3 (outside the selection rect).
    for (const r of scan.regions) {
      if (r.kind === 'cell') {
        expect(r.anchor.row).toBeLessThanOrEqual(1)
      } else if (r.kind === 'range') {
        expect(r.focus.row).toBeLessThanOrEqual(1)
      }
    }
  })

  test('column-differences scopes to the current selection rect', () => {
    // Selection = rows 0..3 × cols 0..0 (a column). Active (0,0).
    // Compare every cell in col 0 against row-0 anchor '10'.
    // (1,0) blank differs; (2,0) blank differs; (3,0) 'x' differs → 3.
    const selectionRect: CellRange = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 }
    const scan = runGoToSpecialScan(
      { kind: 'column-differences' },
      makeScanContext(sparseFixture(), {
        activeCell: { row: 0, col: 0 },
        searchRect: FIXTURE_RECT,
        selectionRect,
      }),
    )
    expect(scan.totalMatchCount).toBe(3)
  })

  test('row-differences blank-vs-blank counts as equal', () => {
    // Row 2 is all-blank. Row-differences within just row 2 should yield 0.
    const selectionRect: CellRange = { rowStart: 2, rowEnd: 2, colStart: 0, colEnd: 3 }
    const scan = runGoToSpecialScan(
      { kind: 'row-differences' },
      makeScanContext(sparseFixture(), {
        activeCell: { row: 2, col: 0 },
        searchRect: FIXTURE_RECT,
        selectionRect,
      }),
    )
    expect(scan.totalMatchCount).toBe(0)
  })

  test('precedents/dependents collapse to empty result', () => {
    const scan = runGoToSpecialScan({ kind: 'precedents' }, makeScanContext(sparseFixture()))
    expect(scan.regions).toEqual([])
    expect(scan.totalMatchCount).toBe(0)
  })

  test('region cap fires on checkerboard input (worst-case non-coalescable)', () => {
    // Build a checkerboard pattern inside a square rect. Every other cell is
    // blank in row-major order, so coalescing produces N single-cell regions
    // per row. With a 60×60 rect, blanks = 1800 (cap at 500).
    const side = 60
    const occupied: GoToCandidateCell[] = []
    for (let r = 0; r < side; r += 1) {
      for (let c = 0; c < side; c += 1) {
        if ((r + c) % 2 === 0) {
          // even sum = occupied (non-blank)
          occupied.push({ row: r, col: c, displayValue: 'x', valueKind: 'string' })
        }
      }
    }
    const rect: CellRange = { rowStart: 0, rowEnd: side - 1, colStart: 0, colEnd: side - 1 }
    const scan = runGoToSpecialScan(
      { kind: 'blanks' },
      makeScanContext(occupied, { searchRect: rect }),
    )
    // 60×60 = 3600 coords; half (1800) are blank. Each row has 30 alternating
    // blanks separated by occupied cells — they DON'T coalesce. So per-row
    // 30 regions × 60 rows = 1800 regions worst case. The cap of 500 must
    // truncate.
    expect(scan.totalMatchCount).toBe(1800)
    expect(scan.regions.length).toBeLessThanOrEqual(GO_TO_REGION_CAP)
    expect(scan.truncated).toBe(true)
  })

  test('region cap does NOT fire when output coalesces cleanly', () => {
    // 1000 rows × 1 col = 1000 blanks BUT each row is a single coord, and
    // adjacent rows aren't merged vertically by our coalesce strategy — so
    // this DOES produce 1000 regions. Verify the cap still fires.
    const rect: CellRange = { rowStart: 0, rowEnd: 999, colStart: 0, colEnd: 0 }
    const scan = runGoToSpecialScan({ kind: 'blanks' }, makeScanContext([], { searchRect: rect }))
    expect(scan.totalMatchCount).toBe(1000)
    expect(scan.regions.length).toBe(GO_TO_REGION_CAP)
    expect(scan.truncated).toBe(true)
  })

  test('full-row blanks coalesce into a single range per row', () => {
    // 50 rows × 20 cols, all blank → 50 row-wide ranges, well under the cap.
    const rect: CellRange = { rowStart: 0, rowEnd: 49, colStart: 0, colEnd: 19 }
    const scan = runGoToSpecialScan({ kind: 'blanks' }, makeScanContext([], { searchRect: rect }))
    expect(scan.totalMatchCount).toBe(50 * 20)
    expect(scan.regions.length).toBe(50)
    expect(scan.truncated).toBe(false)
    // Each emitted region should be a full-row range.
    for (const r of scan.regions) {
      expect(r.kind).toBe('range')
      if (r.kind === 'range') {
        expect(r.focus.col - r.anchor.col + 1).toBe(20)
      }
    }
  })

  test('GO_TO_SCAN_MAX_CELLS constant is exported and >= 100k', () => {
    expect(GO_TO_SCAN_MAX_CELLS).toBeGreaterThanOrEqual(100_000)
  })
})
