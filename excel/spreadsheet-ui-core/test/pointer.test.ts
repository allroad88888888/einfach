import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  cancelPointerAtom,
  commitPointerAtom,
  createFillHandlePreview,
  getFillHandleSourceCoord,
  getFillHandleWriteRange,
  pointerIntentAtom,
  pointerIsActiveAtom,
  pointerSessionAtom,
  startPointerAtom,
  updatePointerAtom,
} from '../src/pointer'

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

const POINTER_PUBLIC_STATE_IS_READ_ONLY: readonly [
  AtomHasPublicWrite<typeof pointerSessionAtom>,
  AtomHasPublicWrite<typeof pointerIntentAtom>,
] = [false, false]

const POINTER_COMMANDS_ARE_WRITABLE: readonly [
  AtomHasPublicWrite<typeof startPointerAtom>,
  AtomHasPublicWrite<typeof updatePointerAtom>,
  AtomHasPublicWrite<typeof commitPointerAtom>,
  AtomHasPublicWrite<typeof cancelPointerAtom>,
] = [true, true, true, true]

describe('pointer core', () => {
  test('keeps public state read-only and rejects reflected writes without changing references', () => {
    const store = createStore()

    store.setter(startPointerAtom, {
      kind: 'drag-selection',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 2 },
      focus: { row: 3, col: 4 },
      source: 'mouse',
    })

    const activeBefore = store.getter(pointerSessionAtom)
    const emptyIntentBefore = store.getter(pointerIntentAtom)

    expect(POINTER_PUBLIC_STATE_IS_READ_ONLY).toEqual([false, false])
    expect(['write' in pointerSessionAtom, 'write' in pointerIntentAtom]).toEqual(
      POINTER_PUBLIC_STATE_IS_READ_ONLY,
    )
    expect(() =>
      Reflect.apply(store.setter, store, [
        pointerSessionAtom,
        {
          status: 'idle',
          source: null,
          interaction: null,
          autoscroll: null,
        },
      ]),
    ).toThrow(TypeError)
    expect(store.getter(pointerSessionAtom)).toBe(activeBefore)
    expect(store.getter(pointerIntentAtom)).toBe(emptyIntentBefore)

    const committed = store.setter(commitPointerAtom)
    const idleBefore = store.getter(pointerSessionAtom)
    const committedIntentBefore = store.getter(pointerIntentAtom)

    expect(committedIntentBefore).toBe(committed)
    expect(() => Reflect.apply(store.setter, store, [pointerIntentAtom, null])).toThrow(TypeError)
    expect(store.getter(pointerSessionAtom)).toBe(idleBefore)
    expect(store.getter(pointerIntentAtom)).toBe(committedIntentBefore)
  })

  test('flows idle through start and update to commit or cancel through command atoms', () => {
    const store = createStore()
    const commandAtoms = [startPointerAtom, updatePointerAtom, commitPointerAtom, cancelPointerAtom]

    expect(commandAtoms.map((commandAtom) => 'write' in commandAtom)).toEqual(
      POINTER_COMMANDS_ARE_WRITABLE,
    )
    expect(commandAtoms.map((commandAtom) => commandAtom.debugLabel)).toEqual([
      'spreadsheet.pointer.start',
      'spreadsheet.pointer.update',
      'spreadsheet.pointer.commit',
      'spreadsheet.pointer.cancel',
    ])
    expect([pointerSessionAtom.debugLabel, pointerIntentAtom.debugLabel]).toEqual([
      'spreadsheet.pointer.session',
      'spreadsheet.pointer.intent',
    ])
    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'idle',
      source: null,
      interaction: null,
      autoscroll: null,
    })

    store.setter(startPointerAtom, {
      kind: 'drag-selection',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 3 },
      source: 'mouse',
    })
    const started = store.getter(pointerSessionAtom)
    expect(started).toMatchObject({
      status: 'active',
      source: 'mouse',
      interaction: {
        kind: 'drag-selection',
        anchor: { row: 2, col: 3 },
        focus: { row: 2, col: 3 },
      },
    })
    expect(store.getter(pointerIntentAtom)).toBeNull()

    store.setter(updatePointerAtom, {
      kind: 'drag-selection',
      focus: { row: 7, col: 8 },
      source: 'touch',
    })
    const updated = store.getter(pointerSessionAtom)
    expect(updated).not.toBe(started)
    expect(updated).toMatchObject({
      status: 'active',
      source: 'touch',
      interaction: {
        kind: 'drag-selection',
        anchor: { row: 2, col: 3 },
        focus: { row: 7, col: 8 },
        range: { rowStart: 2, rowEnd: 7, colStart: 3, colEnd: 8 },
      },
    })

    const orderedWrites: unknown[] = []
    const orderedIntent = Reflect.apply(commitPointerAtom.write, undefined, [
      () => updated,
      (_target: unknown, nextValue: unknown) => orderedWrites.push(nextValue),
    ])
    expect(orderedWrites[0]).toBe(orderedIntent)
    expect(orderedWrites[1]).toEqual({
      status: 'idle',
      source: null,
      interaction: null,
      autoscroll: null,
    })

    const committed = store.setter(commitPointerAtom)
    expect(committed).toEqual({
      type: 'pointer.drag-selection.commit',
      sheetId: 'sheet-1',
      source: 'touch',
      anchor: { row: 2, col: 3 },
      focus: { row: 7, col: 8 },
      range: { rowStart: 2, rowEnd: 7, colStart: 3, colEnd: 8 },
    })
    expect(store.getter(pointerIntentAtom)).toBe(committed)
    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'idle',
      source: null,
      interaction: null,
      autoscroll: null,
    })

    store.setter(startPointerAtom, {
      kind: 'column-resize',
      sheetId: 'sheet-1',
      colIndex: 5,
      previewSizePx: 120,
    })
    store.setter(updatePointerAtom, {
      kind: 'column-resize',
      previewSizePx: 144,
    })
    expect(store.getter(pointerSessionAtom)).toMatchObject({
      status: 'active',
      interaction: {
        kind: 'column-resize',
        colIndex: 5,
        previewSizePx: 144,
      },
    })

    store.setter(cancelPointerAtom)
    expect(store.getter(pointerSessionAtom)).toEqual({
      status: 'idle',
      source: null,
      interaction: null,
      autoscroll: null,
    })
    expect(store.getter(pointerIntentAtom)).toBeNull()
  })

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

  test('carries copy-only modifier changes into the fill commit intent', () => {
    const store = createStore()

    store.setter(startPointerAtom, {
      kind: 'fill-handle',
      sheetId: 'sheet-1',
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      previewRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
      direction: 'down',
      copyOnly: false,
    })
    store.setter(updatePointerAtom, {
      kind: 'fill-handle',
      copyOnly: true,
    })

    expect(store.setter(commitPointerAtom)).toMatchObject({
      type: 'pointer.fill-handle.commit',
      copyOnly: true,
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

  test('carries append mode through drag selection commit intents', () => {
    const store = createStore()

    store.setter(startPointerAtom, {
      kind: 'drag-selection',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 2, col: 2 },
      append: true,
      source: 'mouse',
    })

    expect(store.getter(pointerSessionAtom).interaction).toEqual({
      kind: 'drag-selection',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 2, col: 2 },
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
      append: true,
    })

    expect(store.setter(commitPointerAtom)).toEqual({
      type: 'pointer.drag-selection.commit',
      sheetId: 'sheet-1',
      source: 'mouse',
      anchor: { row: 1, col: 1 },
      focus: { row: 2, col: 2 },
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
      append: true,
    })
  })

  test('computes fill handle preview and write ranges without expanding cells', () => {
    const sourceRange = { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 }

    expect(createFillHandlePreview(sourceRange, { row: 5, col: 4 })).toEqual({
      previewRange: { rowStart: 1, rowEnd: 5, colStart: 3, colEnd: 4 },
      direction: 'down',
    })
    expect(getFillHandleWriteRange(sourceRange, {
      rowStart: 1,
      rowEnd: 5,
      colStart: 3,
      colEnd: 4,
    }, 'down')).toEqual({
      rowStart: 3,
      rowEnd: 5,
      colStart: 3,
      colEnd: 4,
    })
    expect(createFillHandlePreview(sourceRange, { row: 0, col: 4 })).toEqual({
      previewRange: { rowStart: 0, rowEnd: 2, colStart: 3, colEnd: 4 },
      direction: 'up',
    })
    expect(createFillHandlePreview(sourceRange, { row: 2, col: 7 })).toEqual({
      previewRange: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 7 },
      direction: 'right',
    })
    expect(createFillHandlePreview(sourceRange, { row: 2, col: 1 })).toEqual({
      previewRange: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 4 },
      direction: 'left',
    })
    expect(getFillHandleWriteRange(sourceRange, sourceRange, null)).toBeNull()
    expect(getFillHandleSourceCoord(sourceRange, { row: 5, col: 4 })).toEqual({
      row: 1,
      col: 4,
    })
  })
})
