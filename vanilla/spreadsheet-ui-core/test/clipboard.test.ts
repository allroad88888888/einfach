import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  clipboardIntentAtom,
  clipboardStateAtom,
  clearClipboardAtom,
  collectFormulaReferenceRanges,
  copyClipboardAtom,
  createClipboardPayloadDescriptor,
  createClipboardTsvPastePlan,
  createClipboardTransferRequest,
  cutClipboardAtom,
  markClipboardReadyAtom,
  pasteClipboardAtom,
  parseClipboardTsv,
  serializeClipboardTsv,
  setClipboardErrorAtom,
  shiftFormulaRefs,
  type ClipboardState,
} from '../src/clipboard'

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

const CLIPBOARD_PUBLIC_STATE_IS_READ_ONLY: readonly [
  AtomHasPublicWrite<typeof clipboardStateAtom>,
  AtomHasPublicWrite<typeof clipboardIntentAtom>,
] = [false, false]

const CLIPBOARD_COMMANDS_ARE_WRITABLE: readonly [
  AtomHasPublicWrite<typeof copyClipboardAtom>,
  AtomHasPublicWrite<typeof cutClipboardAtom>,
  AtomHasPublicWrite<typeof pasteClipboardAtom>,
  AtomHasPublicWrite<typeof clearClipboardAtom>,
  AtomHasPublicWrite<typeof markClipboardReadyAtom>,
  AtomHasPublicWrite<typeof setClipboardErrorAtom>,
] = [true, true, true, true, true, true]

describe('clipboard core', () => {
  test('rejects reflected writes to public state without changing references', () => {
    expect(
      [clipboardStateAtom, clipboardIntentAtom].map((stateAtom) => 'write' in stateAtom),
    ).toEqual(CLIPBOARD_PUBLIC_STATE_IS_READ_ONLY)
    expect(
      [
        copyClipboardAtom,
        cutClipboardAtom,
        pasteClipboardAtom,
        clearClipboardAtom,
        markClipboardReadyAtom,
        setClipboardErrorAtom,
      ].map((commandAtom) => 'write' in commandAtom),
    ).toEqual(CLIPBOARD_COMMANDS_ARE_WRITABLE)

    const store = createStore()
    store.setter(copyClipboardAtom, {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
    })
    const stateBefore = store.getter(clipboardStateAtom)
    const intentBefore = store.getter(clipboardIntentAtom)
    if (intentBefore === null) throw new Error('expected copy intent')

    expect(store.getter(clipboardStateAtom)).toBe(stateBefore)
    expect(store.getter(clipboardIntentAtom)).toBe(intentBefore)
    expect(stateBefore.intent).toBe(intentBefore)

    expect(() =>
      Reflect.apply(store.setter, store, [
        clipboardStateAtom,
        { ...stateBefore, status: 'cutting' },
      ]),
    ).toThrow()
    expect(() =>
      Reflect.apply(store.setter, store, [
        clipboardIntentAtom,
        { ...intentBefore, type: 'clipboard.cut' },
      ]),
    ).toThrow()

    expect(store.getter(clipboardStateAtom)).toBe(stateBefore)
    expect(store.getter(clipboardIntentAtom)).toBe(intentBefore)
    expect(store.getter(clipboardStateAtom).intent).toBe(intentBefore)
    expect(clipboardStateAtom.debugLabel).toBe('spreadsheet.clipboard.state')
    expect(clipboardIntentAtom.debugLabel).toBe('spreadsheet.clipboard.intent')
  })

  test('routes copy, cut, and paste through ready, error, and clear', () => {
    const store = createStore()
    const input = {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
      },
      target: {
        sheetId: 'sheet-2',
        range: { rowStart: 5, rowEnd: 6, colStart: 7, colEnd: 8 },
      },
      revision: 'rev-1',
    }
    const idleState: ClipboardState = {
      status: 'idle',
      intent: null,
      source: null,
      target: null,
      payload: null,
      error: null,
    }
    const runFlow = (
      start: () => void,
      activeStatus: 'copying' | 'cutting' | 'pasting',
      intentType: 'clipboard.copy' | 'clipboard.cut' | 'clipboard.paste',
    ) => {
      expect(store.getter(clipboardStateAtom)).toEqual(idleState)
      expect(store.getter(clipboardIntentAtom)).toBeNull()

      start()
      const activeState = store.getter(clipboardStateAtom)
      const activeIntent = store.getter(clipboardIntentAtom)
      expect(activeState.status).toBe(activeStatus)
      expect(activeIntent?.type).toBe(intentType)
      expect(activeState.intent).toBe(activeIntent)

      store.setter(markClipboardReadyAtom)
      const readyState = store.getter(clipboardStateAtom)
      expect(readyState.status).toBe('ready')
      expect(readyState.intent).toBe(activeIntent)
      expect(store.getter(clipboardIntentAtom)).toBe(activeIntent)

      store.setter(setClipboardErrorAtom, {
        code: 'BACKEND_ERROR',
        message: `${intentType} failed`,
      })
      const errorState = store.getter(clipboardStateAtom)
      expect(errorState.status).toBe('error')
      expect(errorState.error).toEqual({
        code: 'BACKEND_ERROR',
        message: `${intentType} failed`,
      })
      expect(errorState.intent).toBe(activeIntent)
      expect(store.getter(clipboardIntentAtom)).toBe(activeIntent)

      store.setter(clearClipboardAtom)
      expect(store.getter(clipboardStateAtom)).toEqual(idleState)
      expect(store.getter(clipboardIntentAtom)).toBeNull()
    }

    runFlow(() => store.setter(copyClipboardAtom, input), 'copying', 'clipboard.copy')
    runFlow(() => store.setter(cutClipboardAtom, input), 'cutting', 'clipboard.cut')
    runFlow(() => store.setter(pasteClipboardAtom, input), 'pasting', 'clipboard.paste')
  })

  test('describes a bounded range payload and clones caller ranges', () => {
    const source = {
      sheetId: 'sheet-1',
      range: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
    }

    const descriptor = createClipboardPayloadDescriptor({
      source,
      serialization: 'tab-separated',
      includesFormulas: true,
    })

    source.range.rowStart = 99

    expect(descriptor).toEqual({
      kind: 'range',
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
      },
      serialization: 'tab-separated',
      cellCount: 4,
      estimatedBytes: 32,
      truncated: false,
      includesFormulas: true,
      includesErrors: false,
    })
  })

  test('builds copy, cut, and paste transfer requests with target metadata', () => {
    const request = createClipboardTransferRequest('paste', {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      },
      target: {
        sheetId: 'sheet-2',
        range: { rowStart: 10, rowEnd: 10, colStart: 4, colEnd: 5 },
      },
      revision: 'rev-3',
    })

    expect(request).toEqual({
      operation: 'paste',
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      },
      payload: {
        kind: 'range',
        source: {
          sheetId: 'sheet-1',
          range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
        },
        serialization: 'tab-separated',
        cellCount: 2,
        estimatedBytes: 16,
        truncated: false,
        includesFormulas: false,
        includesErrors: false,
      },
      target: {
        sheetId: 'sheet-2',
        range: { rowStart: 10, rowEnd: 10, colStart: 4, colEnd: 5 },
      },
      revision: 'rev-3',
    })
  })

  test('tracks intent state while keeping only the descriptor, not payload data', () => {
    const store = createStore()

    store.setter(copyClipboardAtom, {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
      },
      serialization: 'json',
      includesErrors: true,
    })

    expect(store.getter(clipboardStateAtom)).toMatchObject({
      status: 'copying',
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
      },
      payload: {
        kind: 'range',
        serialization: 'json',
        includesErrors: true,
      },
    })

    store.setter(cutClipboardAtom, {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
      },
    })
    expect((store.getter(clipboardStateAtom) as ClipboardState).status).toBe('cutting')

    store.setter(pasteClipboardAtom, {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
      },
      target: {
        sheetId: 'sheet-2',
        range: { rowStart: 5, rowEnd: 5, colStart: 2, colEnd: 2 },
      },
    })
    expect((store.getter(clipboardStateAtom) as ClipboardState).status).toBe('pasting')

    store.setter(clearClipboardAtom)
    expect(store.getter(clipboardStateAtom)).toEqual({
      status: 'idle',
      intent: null,
      source: null,
      target: null,
      payload: null,
      error: null,
    })
  })

  test('serializes and parses TSV text with an optional origin marker', () => {
    const serialized = serializeClipboardTsv({
      originAddr: 'B2',
      cells: [
        ['1', '=A1+1'],
        ['x', ''],
      ],
    })

    expect(serialized).toBe('# einfach-clipboard-origin: B2\n1\t=A1+1\nx\t')
    expect(parseClipboardTsv(serialized.replace(/\n/g, '\r\n'), 'A1')).toEqual({
      originAddr: 'B2',
      cells: [
        ['1', '=A1+1'],
        ['x', ''],
      ],
    })
    expect(parseClipboardTsv('plain\ttext\n', 'C3')).toEqual({
      originAddr: 'C3',
      cells: [['plain', 'text']],
    })
  })

  test('shifts formula refs while preserving sheet names and string literals', () => {
    expect(shiftFormulaRefs('=A1*2', 4, 2)).toBe('=C5*2')
    expect(shiftFormulaRefs('=Data!A1+SUM(B2:C3)', 1, 1)).toBe(
      '=Data!B2+SUM(C3:D4)',
    )
    expect(shiftFormulaRefs('="A1"&A1&"B2"', 1, 1)).toBe('="A1"&B2&"B2"')
  })

  test('shifts only relative A1 axes while preserving row and column anchors', () => {
    expect(shiftFormulaRefs('=A1+$B2+C$3+$D$4', 2, 1)).toBe(
      '=B3+$B4+D$3+$D$4',
    )
    expect(shiftFormulaRefs('=Data!$A1+Data!B$2+"$C3"', 3, 2)).toBe(
      '=Data!$A4+Data!D$2+"$C3"',
    )
    expect(shiftFormulaRefs('=$A$1+A2', -2, -1)).toBe('=$A$1+#REF!')
  })

  test('leaves bare name tokens unchanged when shifting formula refs', () => {
    expect(shiftFormulaRefs('=MyName+1', 1, 1)).toBe('=MyName+1')
    expect(shiftFormulaRefs('=A1+SUM(MyList)', 1, 0)).toBe('=A2+SUM(MyList)')
    expect(shiftFormulaRefs('=Sheet1!A1+Revenue', 0, 1)).toBe('=Sheet1!B1+Revenue')
  })

  test('shifts only standalone in-grid A1 refs, not functions, exponents, or identifiers', () => {
    expect(shiftFormulaRefs('=LOG10(A1)+1E10+SUM(A1:B2)+Sheet1!A1+$A$1', 1, 1)).toBe(
      '=LOG10(B2)+1E10+SUM(B2:C3)+Sheet1!B2+$A$1',
    )
    expect(shiftFormulaRefs('=LOG10 \t (A1)', 1, 1)).toBe('=LOG10 \t (B2)')
    expect(shiftFormulaRefs('=_A1+A1_+1A1+A1.name+A1', 1, 1)).toBe('=_A1+A1_+1A1+A1.name+B2')
    expect(shiftFormulaRefs('=XFE1+A1048577+XFD1048576', 0, 0)).toBe('=XFE1+A1048577+XFD1048576')
    expect(shiftFormulaRefs('=XFD1048576', 1, 0)).toBe('=#REF!')
    expect(shiftFormulaRefs('=XFD1048576', 0, 1)).toBe('=#REF!')
  })

  test('keeps quoted and escaped sheet qualifiers atomic while shifting their refs', () => {
    expect(shiftFormulaRefs("='A1 Data'!B2+C3", 1, 0)).toBe(
      "='A1 Data'!B3+C4",
    )
    expect(shiftFormulaRefs("='A1'' Q4'!$B2+A1", 1, 0)).toBe(
      "='A1'' Q4'!$B3+A2",
    )
    expect(shiftFormulaRefs("='成本A1'!B2+A1", 1, 0)).toBe(
      "='成本A1'!B3+A2",
    )
    expect(shiftFormulaRefs('=A1!B2+C3', 1, 0)).toBe('=A1!B3+C4')
  })

  test('does not reinterpret A1-shaped suffixes inside Unicode formula names', () => {
    expect(shiftFormulaRefs('=成本A1+A1', 1, 0)).toBe('=成本A1+A2')
    expect(shiftFormulaRefs('=A1成本+A1', 1, 0)).toBe('=A1成本+A2')
    expect(shiftFormulaRefs('=𝒳A1+A1', 1, 0)).toBe('=𝒳A1+A2')
    expect(shiftFormulaRefs('=CaféA1+A1', 1, 0)).toBe('=CaféA1+A2')
  })

  test('collects lexically safe ordinary A1 ranges with decoded sheet qualifiers', () => {
    expect(
      collectFormulaReferenceRanges(
        '=SUM(A1:B2)+C3+"D4"+\'A1 Data\'!E5+成本F6+G7+Sheet1!H8+\'O\'\'Brien\'!I9',
      ),
    ).toEqual([
      { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      { rowStart: 2, rowEnd: 2, colStart: 2, colEnd: 2 },
      {
        qualifier: 'A1 Data',
        rowStart: 4,
        rowEnd: 4,
        colStart: 4,
        colEnd: 4,
      },
      { rowStart: 6, rowEnd: 6, colStart: 6, colEnd: 6 },
      {
        qualifier: 'Sheet1',
        rowStart: 7,
        rowEnd: 7,
        colStart: 7,
        colEnd: 7,
      },
      {
        qualifier: "O'Brien",
        rowStart: 8,
        rowEnd: 8,
        colStart: 8,
        colEnd: 8,
      },
    ])
    expect(collectFormulaReferenceRanges('=Sheet1!A1:B2')).toEqual([
      {
        qualifier: 'Sheet1',
        rowStart: 0,
        rowEnd: 1,
        colStart: 0,
        colEnd: 1,
      },
    ])
    expect(collectFormulaReferenceRanges('=A1+[Book.xlsx]Data!B2')).toBeNull()
    expect(collectFormulaReferenceRanges('=A1+"unterminated B2')).toBeNull()
  })

  test('fails closed for unknown bracket syntax and malformed quoted segments', () => {
    const unknownBracketFormula = '=A1+[Book.xlsx]Data!B2'
    const unterminatedStringFormula = '=A1+"unterminated B2'
    const unterminatedSheetFormula = "=A1+'unterminated B2"

    expect(shiftFormulaRefs(unknownBracketFormula, 1, 0)).toBe(
      unknownBracketFormula,
    )
    expect(shiftFormulaRefs(unterminatedStringFormula, 1, 0)).toBe(
      unterminatedStringFormula,
    )
    expect(shiftFormulaRefs(unterminatedSheetFormula, 1, 0)).toBe(
      unterminatedSheetFormula,
    )
  })

  test('plans TSV paste chunks from marker origin to target origin', () => {
    const text = '# einfach-clipboard-origin: B2\r\n=A1\tplain\n=SUM(B2:C3)\t'
    const plan = createClipboardTsvPastePlan({
      text,
      fallbackOriginAddr: 'A1',
      targetOrigin: { row: 4, col: 3 },
      rowsPerChunk: 1,
    })

    expect(plan).toMatchObject({
      originAddr: 'B2',
      sourceOrigin: { row: 1, col: 1 },
      targetOrigin: { row: 4, col: 3 },
      rowCount: 2,
      colCount: 2,
      cellCount: 4,
      includesFormulas: true,
      estimatedBytes: text.length,
      estimatedRange: { rowStart: 4, rowEnd: 5, colStart: 3, colEnd: 4 },
      rowsPerChunk: 1,
    })

    expect([...plan.chunks()]).toEqual([
      {
        rowStart: 4,
        rowEnd: 4,
        rowCount: 1,
        cells: [
          { row: 4, col: 3, input: '=C4' },
          { row: 4, col: 4, input: 'plain' },
        ],
      },
      {
        rowStart: 5,
        rowEnd: 5,
        rowCount: 1,
        cells: [
          { row: 5, col: 3, input: '=SUM(D5:E6)' },
          { row: 5, col: 4, input: '' },
        ],
      },
    ])
  })

  test('applies safe formula shifting through the clipboard paste plan', () => {
    const text =
      "# einfach-clipboard-origin: A1\n='A1'' Data'!B2+成本A1+A1\t" +
      '=A1+[Book.xlsx]Data!B2'
    const plan = createClipboardTsvPastePlan({
      text,
      fallbackOriginAddr: 'A1',
      targetOrigin: { row: 1, col: 1 },
    })

    expect([...plan.chunks()][0].cells).toEqual([
      { row: 1, col: 1, input: "='A1'' Data'!C3+成本A1+B2" },
      { row: 1, col: 2, input: '=A1+[Book.xlsx]Data!B2' },
    ])
  })

  test('groups TSV paste output by row chunk size', () => {
    const plan = createClipboardTsvPastePlan({
      text: 'a\nb\nc',
      fallbackOriginAddr: 'A1',
      targetOrigin: { row: 10, col: 2 },
      rowsPerChunk: 2,
      shiftFormulas: false,
    })

    const chunks = [...plan.chunks()]

    expect(chunks.map((chunk) => chunk.rowCount)).toEqual([2, 1])
    expect(chunks.map((chunk) => chunk.cells)).toEqual([
      [
        { row: 10, col: 2, input: 'a' },
        { row: 11, col: 2, input: 'b' },
      ],
      [{ row: 12, col: 2, input: 'c' }],
    ])
  })

  test('keeps large TSV paste as chunk iterable instead of a complete cell matrix', () => {
    const rowCount = 10002
    const text = Array.from({ length: rowCount }, (_, row) => `=${row + 1}`)
      .join('\n')
    const plan = createClipboardTsvPastePlan({
      text,
      fallbackOriginAddr: 'A1',
      targetOrigin: { row: 0, col: 0 },
      rowsPerChunk: 1000,
    })

    let chunkCount = 0
    let maxRowsPerChunk = 0
    let emittedCellCount = 0

    for (const chunk of plan.chunks()) {
      chunkCount += 1
      maxRowsPerChunk = Math.max(maxRowsPerChunk, chunk.rowCount)
      emittedCellCount += chunk.cells.length
    }

    expect('cells' in plan).toBe(false)
    expect(plan.rowCount).toBe(rowCount)
    expect(plan.cellCount).toBe(rowCount)
    expect(plan.includesFormulas).toBe(true)
    expect(plan.estimatedRange).toEqual({
      rowStart: 0,
      rowEnd: 10001,
      colStart: 0,
      colEnd: 0,
    })
    expect(chunkCount).toBe(11)
    expect(maxRowsPerChunk).toBe(1000)
    expect(emittedCellCount).toBe(rowCount)
  })

  test('stores clipboard errors without payload data', () => {
    const store = createStore()

    store.setter(copyClipboardAtom, {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
    })
    store.setter(setClipboardErrorAtom, {
      code: 'BACKEND_ERROR',
      message: 'copy failed',
    })

    expect(store.getter(clipboardStateAtom)).toMatchObject({
      status: 'error',
      error: {
        code: 'BACKEND_ERROR',
        message: 'copy failed',
      },
      payload: {
        cellCount: 1,
      },
    })
  })
})
