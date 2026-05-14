import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  cancelPointerAtom,
  commitPointerAtom,
  pointerIntentAtom,
  pointerIsActiveAtom,
  pointerSessionAtom,
  startPointerAtom,
  updatePointerAtom,
} from '../src/pointer'

describe('pointer core', () => {
  test('tracks drag selection boundaries and autoscroll without expanding ranges', () => {
    const store = createStore()
    const input = {
      kind: 'drag-selection' as const,
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 3 },
      focus: { row: 5, col: 1 },
      source: 'mouse' as const,
    }

    store.setter(startPointerAtom, input)
    input.anchor.row = 99
    input.focus.col = 77

    expect(store.getter(pointerIsActiveAtom)).toBe(true)
    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'active',
      source: 'mouse',
      interaction: {
        kind: 'drag-selection',
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 3 },
        focus: { row: 5, col: 1 },
        range: { rowStart: 2, rowEnd: 5, colStart: 1, colEnd: 3 },
      },
      autoscroll: null,
    })
    const interaction = store.getter(pointerSessionAtom).interaction
    if (interaction?.kind !== 'drag-selection') {
      throw new Error('Expected drag-selection interaction.')
    }
    expect('cells' in interaction.range).toBe(false)

    store.setter(updatePointerAtom, {
      kind: 'drag-selection',
      focus: { row: 9, col: 0 },
      source: 'touch',
      autoscroll: {
        edge: 'bottom',
        deltaX: 0,
        deltaY: 12,
      },
    })

    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'active',
      source: 'touch',
      interaction: {
        kind: 'drag-selection',
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 3 },
        focus: { row: 9, col: 0 },
        range: { rowStart: 2, rowEnd: 9, colStart: 0, colEnd: 3 },
      },
      autoscroll: {
        active: true,
        edge: 'bottom',
        deltaX: 0,
        deltaY: 12,
      },
    })

    const intent = store.setter(commitPointerAtom)

    expect(intent).toEqual({
      type: 'pointer.drag-selection.commit',
      sheetId: 'sheet-1',
      source: 'touch',
      anchor: { row: 2, col: 3 },
      focus: { row: 9, col: 0 },
      range: { rowStart: 2, rowEnd: 9, colStart: 0, colEnd: 3 },
    })
    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'idle',
      source: null,
      interaction: null,
      autoscroll: null,
    })
  })

  test('tracks fill handle preview and commits only the bounded range intent', () => {
    const store = createStore()
    const input = {
      kind: 'fill-handle' as const,
      sheetId: 'sheet-1',
      sourceRange: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
      previewRange: { rowStart: 1, rowEnd: 4, colStart: 3, colEnd: 4 },
      focus: { row: 4, col: 4 },
      direction: 'down' as const,
      source: 'pointer' as const,
    }

    store.setter(startPointerAtom, input)
    input.sourceRange.rowEnd = 99

    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'active',
      source: 'pointer',
      interaction: {
        kind: 'fill-handle',
        sheetId: 'sheet-1',
        sourceRange: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
        focus: { row: 4, col: 4 },
        previewRange: { rowStart: 1, rowEnd: 4, colStart: 3, colEnd: 4 },
        direction: 'down',
      },
      autoscroll: null,
    })

    store.setter(updatePointerAtom, {
      kind: 'fill-handle',
      previewRange: { rowStart: 1, rowEnd: 5, colStart: 3, colEnd: 4 },
      direction: 'right',
      autoscroll: {
        edge: 'right',
        deltaX: 8,
      },
    })

    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'active',
      source: 'pointer',
      interaction: {
        kind: 'fill-handle',
        sheetId: 'sheet-1',
        sourceRange: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
        focus: { row: 4, col: 4 },
        previewRange: { rowStart: 1, rowEnd: 5, colStart: 3, colEnd: 4 },
        direction: 'right',
      },
      autoscroll: {
        active: true,
        edge: 'right',
        deltaX: 8,
        deltaY: 0,
      },
    })

    const intent = store.setter(commitPointerAtom)

    expect(intent).toEqual({
      type: 'pointer.fill-handle.commit',
      sheetId: 'sheet-1',
      source: 'pointer',
      sourceRange: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
      targetRange: { rowStart: 1, rowEnd: 5, colStart: 3, colEnd: 4 },
      focus: { row: 4, col: 4 },
      direction: 'right',
    })
    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'idle',
      source: null,
      interaction: null,
      autoscroll: null,
    })
  })

  test('commits row and column resize previews, then cancels back to idle', () => {
    const store = createStore()

    store.setter(startPointerAtom, {
      kind: 'row-resize',
      sheetId: 'sheet-1',
      rowIndex: 7,
      startSizePx: 24,
      previewSizePx: 30,
      source: 'programmatic',
    })

    store.setter(updatePointerAtom, {
      kind: 'row-resize',
      previewSizePx: 36,
      autoscroll: {
        edge: 'bottom',
        deltaY: 4,
      },
    })

    const rowIntent = store.setter(commitPointerAtom)
    expect(rowIntent).toEqual({
      type: 'pointer.row-resize.commit',
      sheetId: 'sheet-1',
      source: 'programmatic',
      rowIndex: 7,
      startSizePx: 24,
      previewSizePx: 36,
    })
    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'idle',
      source: null,
      interaction: null,
      autoscroll: null,
    })

    store.setter(startPointerAtom, {
      kind: 'column-resize',
      sheetId: 'sheet-1',
      colIndex: 4,
      startSizePx: 96,
      previewSizePx: 104,
      source: 'test',
    })

    store.setter(updatePointerAtom, {
      kind: 'column-resize',
      previewSizePx: 112,
    })

    store.setter(cancelPointerAtom)

    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'idle',
      source: null,
      interaction: null,
      autoscroll: null,
    })
    expect(store.getter(pointerIntentAtom)).toBeNull()
    expect(store.setter(commitPointerAtom)).toBeNull()
  })
})
