import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  clipboardStateAtom,
  copyClipboardAtom,
  cutClipboardAtom,
  createClipboardPayloadDescriptor,
  createClipboardTransferRequest,
  pasteClipboardAtom,
  clearClipboardAtom,
  parseClipboardTsv,
  serializeClipboardTsv,
  setClipboardErrorAtom,
  shiftFormulaRefs,
  type ClipboardState,
} from '../src/clipboard'

describe('clipboard core', () => {
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
