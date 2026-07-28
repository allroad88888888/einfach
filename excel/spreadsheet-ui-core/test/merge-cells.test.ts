import { describe, expect, test } from '@jest/globals'
import type { DisplayCell, MergeRangeRequest, UnmergeRangeRequest, VisibleProjectionResult } from '../src'
import { getMergeAnchorCoord, isMergeAnchor, isMergeCovered } from '../src'

const sheetId = 'sheet-1'

function makeCell(overrides: Partial<DisplayCell> & { row: number; col: number }): DisplayCell {
  return { displayValue: '', ...overrides }
}

describe('isMergeAnchor', () => {
  test('true when mergedSpan is present', () => {
    const cell = makeCell({ row: 0, col: 0, mergedSpan: { rows: 2, cols: 3 } })
    expect(isMergeAnchor(cell)).toBe(true)
  })

  test('false when mergeAnchor is present (covered cell)', () => {
    const cell = makeCell({ row: 1, col: 1, mergeAnchor: { row: 0, col: 0 } })
    expect(isMergeAnchor(cell)).toBe(false)
  })

  test('false on bare cell', () => {
    const cell = makeCell({ row: 2, col: 2 })
    expect(isMergeAnchor(cell)).toBe(false)
  })
})

describe('isMergeCovered', () => {
  test('true when mergeAnchor is present', () => {
    const cell = makeCell({ row: 1, col: 1, mergeAnchor: { row: 0, col: 0 } })
    expect(isMergeCovered(cell)).toBe(true)
  })

  test('false on anchor cell', () => {
    const cell = makeCell({ row: 0, col: 0, mergedSpan: { rows: 2, cols: 3 } })
    expect(isMergeCovered(cell)).toBe(false)
  })

  test('false on bare cell', () => {
    const cell = makeCell({ row: 2, col: 2 })
    expect(isMergeCovered(cell)).toBe(false)
  })
})

describe('getMergeAnchorCoord', () => {
  test('returns mergeAnchor coord for covered cell', () => {
    const cell = makeCell({ row: 2, col: 3, mergeAnchor: { row: 1, col: 1 } })
    expect(getMergeAnchorCoord(cell)).toEqual({ row: 1, col: 1 })
  })

  test('returns own coord for anchor cell', () => {
    const cell = makeCell({ row: 1, col: 1, mergedSpan: { rows: 3, cols: 2 } })
    expect(getMergeAnchorCoord(cell)).toEqual({ row: 1, col: 1 })
  })

  test('returns null for bare cell', () => {
    const cell = makeCell({ row: 5, col: 5 })
    expect(getMergeAnchorCoord(cell)).toBeNull()
  })
})

describe('type compatibility', () => {
  test('DisplayCell with mergedSpan typechecks and appears in projection result', () => {
    const anchorCell: DisplayCell = {
      row: 0,
      col: 0,
      displayValue: 'hello',
      mergedSpan: { rows: 2, cols: 3 },
    }
    const result: VisibleProjectionResult = {
      kind: 'visible-window',
      sheetId,
      requestId: 1,
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 },
      cells: [anchorCell],
    }
    expect(result.cells[0].mergedSpan).toEqual({ rows: 2, cols: 3 })
  })

  test('MergeRangeRequest shape round-trips', () => {
    const req: MergeRangeRequest = {
      kind: 'merge-range',
      sheetId,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 },
      requestId: 42,
    }
    expect(req.kind).toBe('merge-range')
    expect(req.range.rowEnd).toBe(1)
  })

  test('UnmergeRangeRequest shape round-trips', () => {
    const req: UnmergeRangeRequest = {
      kind: 'unmerge-range',
      sheetId,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 },
    }
    expect(req.kind).toBe('unmerge-range')
  })
})

describe('graceful degradation', () => {
  test('helpers return false/null when backend omits merge fields', () => {
    const cell = makeCell({ row: 3, col: 3, displayValue: 'plain' })
    expect(isMergeAnchor(cell)).toBe(false)
    expect(isMergeCovered(cell)).toBe(false)
    expect(getMergeAnchorCoord(cell)).toBeNull()
  })
})
