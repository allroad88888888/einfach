import { describe, expect, it } from '@jest/globals'
import { parseFormulaReferences } from '../src/formula-reference/parser'

describe('parseFormulaReferences', () => {
  it('returns empty for non-formula text', () => {
    expect(parseFormulaReferences('hello', 'sheet-1')).toEqual([])
    expect(parseFormulaReferences('', 'sheet-1')).toEqual([])
  })

  it('parses a single cell reference', () => {
    const tokens = parseFormulaReferences('=A1', 'sheet-1')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({
      start: 1,
      end: 3,
      text: 'A1',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      colorIndex: 0,
    })
  })

  it('parses a range reference', () => {
    const tokens = parseFormulaReferences('=SUM(B2:E8)', 'sheet-1')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].text).toBe('B2:E8')
    expect(tokens[0].range).toEqual({ rowStart: 1, rowEnd: 7, colStart: 1, colEnd: 4 })
  })

  it('parses multiple references in order with distinct color indices', () => {
    const tokens = parseFormulaReferences('=A1+B2+C3', 'sheet-1')
    expect(tokens.map((t) => t.text)).toEqual(['A1', 'B2', 'C3'])
    expect(tokens.map((t) => t.colorIndex)).toEqual([0, 1, 2])
  })

  it('reuses the same color for repeated references', () => {
    const tokens = parseFormulaReferences('=A1+A1', 'sheet-1')
    expect(tokens.map((t) => t.text)).toEqual(['A1', 'A1'])
    expect(tokens[0].colorIndex).toBe(0)
    expect(tokens[1].colorIndex).toBe(0)
  })

  it('handles cross-sheet references with unquoted sheet name', () => {
    const tokens = parseFormulaReferences('=Sheet2!A1', 'sheet-1')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].sheetId).toBe('Sheet2')
    expect(tokens[0].text).toBe('Sheet2!A1')
  })

  it('handles cross-sheet references with quoted sheet name', () => {
    const tokens = parseFormulaReferences("='My Sheet'!B2:C3", 'sheet-1')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].sheetId).toBe('My Sheet')
    expect(tokens[0].range).toEqual({ rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 })
  })

  it('strips $ anchors from row/col indices', () => {
    const tokens = parseFormulaReferences('=$A$1:$B$2', 'sheet-1')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].range).toEqual({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 })
  })

  it('reports positions in the full draft (including the leading =)', () => {
    const tokens = parseFormulaReferences('=SUM(A1:B2)+C3', 'sheet-1')
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).toMatchObject({ start: 5, end: 10, text: 'A1:B2' })
    expect(tokens[1]).toMatchObject({ start: 12, end: 14, text: 'C3' })
  })

  it('normalizes range corners so rowStart<=rowEnd', () => {
    const tokens = parseFormulaReferences('=B5:A2', 'sheet-1')
    expect(tokens[0].range).toEqual({ rowStart: 1, rowEnd: 4, colStart: 0, colEnd: 1 })
  })

  it('falls back to currentSheetId when no prefix is present', () => {
    const tokens = parseFormulaReferences('=A1+Sheet2!B2', 'sheet-1')
    expect(tokens[0].sheetId).toBe('sheet-1')
    expect(tokens[1].sheetId).toBe('Sheet2')
  })
})
