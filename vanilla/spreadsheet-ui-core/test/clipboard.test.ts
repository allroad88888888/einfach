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
})
