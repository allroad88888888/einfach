import { describe, expect, it } from '@jest/globals'
import { createRangeProjectionRequest } from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'

const SHEET_ID = 'sheet-1'

type StaticBackend = ReturnType<typeof createStaticSpreadsheetBackend>

async function search(
  backend: StaticBackend,
  needle: string,
  options: {
    caseSensitive?: boolean
    wholeMatch?: boolean
    regex?: boolean
    searchFormulas?: boolean
  } = {},
) {
  return backend.searchRange!({
    kind: 'search-range',
    sheetId: SHEET_ID,
    range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    query: {
      needle,
      options: {
        scope: 'sheet',
        ...options,
      },
    },
    pageStart: 0,
    pageSize: 100,
    requestId: 1,
  })
}

async function readCell(backend: StaticBackend, row = 0, col = 0) {
  const result = await backend.readRangeProjection(
    createRangeProjectionRequest({
      sheetId: SHEET_ID,
      requestId: 2,
      reason: 'test',
      range: { rowStart: row, rowEnd: row, colStart: col, colEnd: col },
    }),
  )
  return {
    displayValue: result.cells[0]?.displayValue,
    revision: result.revision,
  }
}

async function expectNoUndoEntry(backend: StaticBackend) {
  await expect(
    backend.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: 'find-replace-test',
    }),
  ).rejects.toThrow('nothing to undo')
}

async function expectRejectedSpans(spans: readonly (readonly [number, number])[]) {
  const backend = createStaticSpreadsheetBackend({ revision: 6, matrix: [['foobar']] })

  const result = await backend.replaceMatches!({
    kind: 'replace-matches',
    coords: spans.map(([matchStart, matchEnd]) => ({
      sheetId: SHEET_ID,
      coord: { row: 0, col: 0 },
      matchStart,
      matchEnd,
      target: 'displayValue',
    })),
    replacement: 'X',
    requestId: 43,
    revision: 6,
  })

  expect(result).toMatchObject({
    kind: 'replace-matches-not-applied',
    applied: false,
    requestId: 43,
    error: { code: 'FIND_REPLACE_REPLACEMENT_PLAN_INVALID' },
  })
  expect(await readCell(backend)).toEqual({ displayValue: 'foobar', revision: 6 })
  await expectNoUndoEntry(backend)
}

async function readCellProjection(backend: StaticBackend) {
  const result = await backend.readRangeProjection(
    createRangeProjectionRequest({
      sheetId: SHEET_ID,
      requestId: 3,
      reason: 'test',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    }),
  )
  return { cell: result.cells[0], revision: result.revision }
}

async function replaceSearchMatches(
  backend: StaticBackend,
  result: Awaited<ReturnType<typeof search>>,
  replacement: string,
) {
  return backend.replaceMatches!({
    kind: 'replace-matches',
    coords: result.matches.map((match) => {
      if (!match.target) throw new Error('static search result must identify its target')
      return {
        sheetId: match.sheetId,
        coord: { ...match.coord },
        matchStart: match.matchStart,
        matchEnd: match.matchEnd,
        target: match.target,
      }
    }),
    replacement,
    requestId: 4,
    revision: result.revision,
  })
}

describe('static backend supported find baselines', () => {
  it('reports the first literal span in a cell and rejects a partial whole-cell match', async () => {
    const backend = createStaticSpreadsheetBackend([['prefix foo foo suffix']])

    const partial = await search(backend, 'foo', { caseSensitive: true })
    expect(partial.matches.map((match) => [match.matchStart, match.matchEnd])).toEqual([[7, 10]])

    const whole = await search(backend, 'foo', {
      caseSensitive: true,
      wholeMatch: true,
    })
    expect(whole.matches).toEqual([])
  })

  it('fails an invalid regex closed at the search boundary without changing the cell', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 13,
      matrix: [['unchanged']],
    })

    const result = await search(backend, '[', { regex: true })

    expect(result).toMatchObject({ matches: [], totalCount: 0, revision: 13 })
    expect(await readCell(backend)).toEqual({ displayValue: 'unchanged', revision: 13 })
  })

  it('reports every consuming regex match with its real span and replaces from right to left', async () => {
    const backend = createStaticSpreadsheetBackend([['prefix fooo and foo suffix']])

    const result = await search(backend, 'fo+', { regex: true, caseSensitive: true })

    expect(
      result.matches.map((match) => [match.matchStart, match.matchEnd, match.target]),
    ).toEqual([
      [7, 11, 'displayValue'],
      [16, 19, 'displayValue'],
    ])
    expect(result.totalCount).toBe(2)

    const mutation = await replaceSearchMatches(backend, result, 'X')
    if ('kind' in mutation) {
      throw new Error(`static replacement was rejected: ${mutation.error.code}`)
    }
    expect(mutation.replacedCount).toBe(2)
    expect(await readCell(backend)).toEqual({
      displayValue: 'prefix X and X suffix',
      revision: 1,
    })
  })

  it('advances past unrepresentable zero-width regex matches and continues searching', async () => {
    const backend = createStaticSpreadsheetBackend([['foo then foo']])

    const result = await search(backend, '^|foo', { regex: true, caseSensitive: true })

    expect(result.matches.map((match) => [match.matchStart, match.matchEnd])).toEqual([[9, 12]])
    expect(result.totalCount).toBe(1)
  })

  it.each(['^', '$', '(?=foo)'])(
    'omits pure zero-width regex %s, terminates, and reports no matches',
    async (needle) => {
      const backend = createStaticSpreadsheetBackend({ revision: 12, matrix: [['foo']] })

      const result = await search(backend, needle, { regex: true, caseSensitive: true })

      expect(result).toMatchObject({ matches: [], totalCount: 0, revision: 12 })
      expect(await readCell(backend)).toEqual({ displayValue: 'foo', revision: 12 })
    },
  )

  it('replaces the display target of a formula cell without splicing its formula text', async () => {
    const backend = createStaticSpreadsheetBackend({
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: 'visible foo',
          valueKind: 'string',
          formula: '=CONCAT("visible ","foo")',
        },
      ],
    })

    const result = await search(backend, 'foo', { caseSensitive: true })
    expect(result.matches).toMatchObject([{ matchStart: 8, matchEnd: 11, target: 'displayValue' }])

    await replaceSearchMatches(backend, result, 'bar')
    expect(await readCellProjection(backend)).toEqual({
      cell: {
        row: 0,
        col: 0,
        displayValue: 'visible bar',
        valueKind: 'string',
      },
      revision: 1,
    })
  })

  it('replaces the formula target and preserves the cell as a formula', async () => {
    const backend = createStaticSpreadsheetBackend({
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: 'visible foo',
          valueKind: 'string',
          formula: '=CONCAT("visible ","foo")',
        },
      ],
    })

    const result = await search(backend, 'foo', {
      caseSensitive: true,
      searchFormulas: true,
    })
    expect(result.matches).toMatchObject([{ matchStart: 20, matchEnd: 23, target: 'formula' }])

    await replaceSearchMatches(backend, result, 'bar')
    expect(await readCellProjection(backend)).toEqual({
      cell: {
        row: 0,
        col: 0,
        displayValue: 'visible bar',
        valueKind: 'string',
        formula: '=CONCAT("visible ","bar")',
      },
      revision: 1,
    })
  })

  it('rejects a stale revision with exact not-applied evidence and no undo entry', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 9, matrix: [['foo']] })

    const result = await backend.replaceMatches!({
      kind: 'replace-matches',
      coords: [
        {
          sheetId: SHEET_ID,
          coord: { row: 0, col: 0 },
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
      ],
      replacement: 'bar',
      requestId: 41,
      revision: 8,
    })

    expect(result).toEqual({
      kind: 'replace-matches-not-applied',
      applied: false,
      requestId: 41,
      error: {
        code: 'FIND_REPLACE_REVISION_CONFLICT',
        message: 'Replace revision conflict: expected 8, current 9',
        source: 'validation',
      },
    })
    expect(await readCell(backend)).toEqual({ displayValue: 'foo', revision: 9 })
    await expectNoUndoEntry(backend)
  })

  it('preflights every cell and applies none when one replacement span is invalid', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 4,
      matrix: [['foo', 'bar']],
    })

    const result = await backend.replaceMatches!({
      kind: 'replace-matches',
      coords: [
        {
          sheetId: SHEET_ID,
          coord: { row: 0, col: 0 },
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
        {
          sheetId: SHEET_ID,
          coord: { row: 0, col: 1 },
          matchStart: 0,
          matchEnd: 99,
          target: 'displayValue',
        },
      ],
      replacement: 'X',
      requestId: 42,
      revision: 4,
    })

    expect(result).toMatchObject({
      kind: 'replace-matches-not-applied',
      applied: false,
      requestId: 42,
      error: { code: 'FIND_REPLACE_REPLACEMENT_PLAN_INVALID' },
    })
    expect(await readCell(backend, 0, 0)).toEqual({ displayValue: 'foo', revision: 4 })
    expect(await readCell(backend, 0, 1)).toEqual({ displayValue: 'bar', revision: 4 })
    await expectNoUndoEntry(backend)
  })

  it('rejects overlapping spans before mutating the cell', async () => {
    await expectRejectedSpans([[0, 4], [3, 6]])
  })

  it('rejects duplicate spans before mutating the cell', async () => {
    await expectRejectedSpans([[0, 3], [0, 3]])
  })

  it('rejects a direct zero-width span without a write, undo entry, or revision bump', async () => {
    await expectRejectedSpans([[2, 2]])
  })

  it('treats empty and already-equal replacements as no-ops without revision or undo', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 7, matrix: [['foo']] })

    await expect(
      backend.replaceMatches!({
        kind: 'replace-matches',
        coords: [],
        replacement: 'unused',
        requestId: 44,
        revision: 7,
      }),
    ).resolves.toEqual({ replacedCount: 0, requestId: 44, revision: 7 })
    await expect(
      backend.replaceMatches!({
        kind: 'replace-matches',
        coords: [
          {
            sheetId: SHEET_ID,
            coord: { row: 0, col: 0 },
            matchStart: 0,
            matchEnd: 3,
            target: 'displayValue',
          },
        ],
        replacement: 'foo',
        requestId: 45,
        revision: 7,
      }),
    ).resolves.toEqual({ replacedCount: 0, requestId: 45, revision: 7 })

    expect(await readCell(backend)).toEqual({ displayValue: 'foo', revision: 7 })
    await expectNoUndoEntry(backend)
  })

  it('acknowledges the actual new revision and creates exactly one undo delta', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 5, matrix: [['foo foo']] })
    const searchResult = await search(backend, 'fo+', { regex: true, caseSensitive: true })

    await expect(replaceSearchMatches(backend, searchResult, 'X')).resolves.toEqual({
      replacedCount: 2,
      requestId: 4,
      revision: 6,
    })
    expect(await readCell(backend)).toEqual({ displayValue: 'X X', revision: 6 })

    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'find-replace-success',
      }),
    ).resolves.toMatchObject({ revision: 7 })
    expect(await readCell(backend)).toEqual({ displayValue: 'foo foo', revision: 7 })
    await expectNoUndoEntry(backend)
  })

  it('rejects an effective replacement when the static revision cannot advance', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 'opaque-v1',
      matrix: [['foo']],
    })

    const result = await backend.replaceMatches!({
      kind: 'replace-matches',
      coords: [
        {
          sheetId: SHEET_ID,
          coord: { row: 0, col: 0 },
          matchStart: 0,
          matchEnd: 3,
          target: 'displayValue',
        },
      ],
      replacement: 'bar',
      requestId: 47,
      revision: 'opaque-v1',
    })

    expect(result).toMatchObject({
      kind: 'replace-matches-not-applied',
      applied: false,
      requestId: 47,
      error: { code: 'FIND_REPLACE_REVISION_UNADVANCEABLE' },
    })
    expect(await readCell(backend)).toEqual({
      displayValue: 'foo',
      revision: 'opaque-v1',
    })
    await expect(
      backend.replaceMatches!({
        kind: 'replace-matches',
        coords: [
          {
            sheetId: SHEET_ID,
            coord: { row: 0, col: 0 },
            matchStart: 0,
            matchEnd: 3,
            target: 'displayValue',
          },
        ],
        replacement: 'foo',
        requestId: 48,
        revision: 'opaque-v1',
      }),
    ).resolves.toEqual({ replacedCount: 0, requestId: 48, revision: 'opaque-v1' })
    await expectNoUndoEntry(backend)
  })

  it('fails legacy requests closed when exact CAS identity is unavailable', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 3, matrix: [['foo']] })
    const coords = [
      {
        sheetId: SHEET_ID,
        coord: { row: 0, col: 0 },
        matchStart: 0,
        matchEnd: 3,
        target: 'displayValue' as const,
      },
    ]

    await expect(
      backend.replaceMatches!({
        kind: 'replace-matches',
        coords,
        replacement: 'bar',
        requestId: 46,
      }),
    ).resolves.toMatchObject({
      kind: 'replace-matches-not-applied',
      applied: false,
      requestId: 46,
      error: { code: 'FIND_REPLACE_REVISION_REQUIRED' },
    })
    await expect(
      backend.replaceMatches!({
        kind: 'replace-matches',
        coords,
        replacement: 'bar',
        revision: 3,
      }),
    ).rejects.toMatchObject({ code: 'FIND_REPLACE_REQUEST_ID_REQUIRED' })

    expect(await readCell(backend)).toEqual({ displayValue: 'foo', revision: 3 })
    await expectNoUndoEntry(backend)
  })
})
