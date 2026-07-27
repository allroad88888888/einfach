import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { DisplayCell, VisibleProjectionResult } from '../src/backend'
import { diagnosticsAtom } from '../src/diagnostics'
import {
  clearContentMutationBlockAtom,
  contentMutationLastBlockAtom,
  editingCommitLifecycleAtom,
  resolveContentMutationAtom,
  runEditingCommitAtom,
  startEditingAtom,
  type EditingCommitRequest,
} from '../src/editing'
import { beginProjectionAtom, resolveProjectionAtom } from '../src/projection'
import { setSheetProtectionAtom } from '../src/protection'
import type { CellRange } from '../src/shared'

const SHEET = 'sheet-1'
const WINDOW = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 3 }

function publishVisibleProjection(
  store: ReturnType<typeof createStore>,
  cells: DisplayCell[],
  window = WINDOW,
): void {
  const outcome = store.setter(beginProjectionAtom, {
    kind: 'visible-window',
    sheetId: SHEET,
    window,
  })
  if (outcome.status !== 'started') {
    throw new Error(`projection begin failed: ${outcome.status}`)
  }
  const result: VisibleProjectionResult = {
    kind: 'visible-window',
    sheetId: SHEET,
    requestId: outcome.request.requestId,
    window: { ...window },
    cells,
  }
  const resolved = store.setter(resolveProjectionAtom, { request: outcome.request, result })
  if (resolved.status !== 'accepted') {
    throw new Error(`projection resolve failed: ${resolved.status}`)
  }
}

/**
 * A projection with a filter active. Rows 1 and 3 were filtered away, so they
 * contribute no cell at all; every surviving row sits at its own source index
 * (#27 — hidden, not compacted). Nothing here can move a mutation target.
 */
function filteredCells(): DisplayCell[] {
  return [
    { row: 0, col: 0, displayValue: 'header' },
    { row: 2, col: 0, displayValue: 'beta' },
    { row: 2, col: 1, displayValue: 'beta-b' },
  ]
}

function plainCells(): DisplayCell[] {
  return [
    { row: 0, col: 0, displayValue: 'a' },
    { row: 1, col: 0, displayValue: 'b' },
  ]
}

function protectSheet(store: ReturnType<typeof createStore>, unlockedRanges: CellRange[] = []) {
  store.setter(setSheetProtectionAtom, {
    sheetId: SHEET,
    state: { mode: 'protected', unlockedRanges },
  })
}

describe('mutation gateway — target passthrough', () => {
  test('passes a target through when no projection has been published', () => {
    const store = createStore()

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: SHEET,
      cell: { row: 2, col: 1 },
    })

    expect(resolution).toMatchObject({ status: 'allowed', cell: { row: 2, col: 1 } })
  })

  test('passes a target through for a published projection', () => {
    const store = createStore()
    publishVisibleProjection(store, plainCells())

    const cellResolution = store.setter(resolveContentMutationAtom, {
      kind: 'clear-range',
      sheetId: SHEET,
      cell: { row: 1, col: 0 },
    })
    const rangeResolution = store.setter(resolveContentMutationAtom, {
      kind: 'clear-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
    })

    expect(cellResolution).toMatchObject({ status: 'allowed', cell: { row: 1, col: 0 } })
    expect(rangeResolution).toMatchObject({
      status: 'allowed',
      ranges: [{ rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 }],
    })
  })

  test('remove-rows is a first-class range mutation and preserves its exact target', () => {
    const store = createStore()
    const range = { rowStart: 1, rowEnd: 8, colStart: 2, colEnd: 5 }

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'remove-rows',
      sheetId: SHEET,
      range,
    })

    expect(resolution).toEqual({
      status: 'allowed',
      kind: 'remove-rows',
      sheetId: SHEET,
      ranges: [range],
    })
  })

  /**
   * Regression nail (#27 S6). Filtering hides rows instead of compacting them,
   * so a mutation target is a source coordinate no matter what the projection
   * shows. If anyone reintroduces a projection-driven remap, this goes red:
   * under the retired compaction the same call resolved to source row 5, and a
   * row the projection did not cover was blocked outright.
   */
  test('an active filter never moves or splits a mutation target', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())

    const cellResolution = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: SHEET,
      cell: { row: 1, col: 1 },
    })
    // Rows 1 and 3 are filtered away — the range still resolves to itself, in
    // one piece. Excel writes through a filtered view; it does not skip rows.
    const rangeResolution = store.setter(resolveContentMutationAtom, {
      kind: 'clear-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 3, colStart: 0, colEnd: 1 },
    })

    expect(cellResolution).toMatchObject({ status: 'allowed', cell: { row: 1, col: 1 } })
    expect(rangeResolution).toMatchObject({
      status: 'allowed',
      ranges: [{ rowStart: 1, rowEnd: 3, colStart: 0, colEnd: 1 }],
    })
  })

  test('a target outside the projected window passes through', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'paste-range',
      sheetId: SHEET,
      cell: { row: 10, col: 0 },
    })

    // The projected window bounded the retired remap lookup, so it used to
    // block here. Coordinates are canonical now: the window is a read-side
    // fact and says nothing about where a mutation may land.
    expect(resolution).toMatchObject({ status: 'allowed', cell: { row: 10, col: 0 } })
  })

  test('rejects invalid coordinates and records a clearable block', () => {
    const store = createStore()

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: SHEET,
      cell: { row: -1, col: 0 },
    })

    expect(resolution).toMatchObject({ status: 'blocked', reason: 'invalid-target' })
    expect(store.getter(contentMutationLastBlockAtom)).toMatchObject({
      reason: 'invalid-target',
      kind: 'set-cell-input',
    })
    expect(
      store
        .getter(diagnosticsAtom)
        .items.some((item) => item.code === 'MUTATION_INVALID_TARGET' && item.sheetId === SHEET),
    ).toBe(true)

    store.setter(clearContentMutationBlockAtom)
    expect(store.getter(contentMutationLastBlockAtom)).toBeNull()
  })

  test('rejects an inverted range', () => {
    const store = createStore()

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'clear-range',
      sheetId: SHEET,
      range: { rowStart: 3, rowEnd: 1, colStart: 0, colEnd: 0 },
    })

    expect(resolution).toMatchObject({ status: 'blocked', reason: 'invalid-target' })
  })
})

describe('mutation gateway — protection gate', () => {
  test('gates per row against the unlocked ranges, filter or no filter', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())
    // Row 1 is unlocked. It is also one of the rows the filter hid — the
    // protection answer is about coordinates, not about what is on screen.
    protectSheet(store, [{ rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 3 }])

    const allowed = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: SHEET,
      cell: { row: 1, col: 0 },
    })
    // Row 2 is visible but locked.
    const blocked = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: SHEET,
      cell: { row: 2, col: 0 },
    })

    expect(allowed).toMatchObject({ status: 'allowed', cell: { row: 1, col: 0 } })
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'locked' })
    expect(
      store.getter(diagnosticsAtom).items.some((item) => item.code === 'MUTATION_BLOCKED_LOCKED'),
    ).toBe(true)
  })

  test('blocks every content-mutation kind on a fully locked sheet', () => {
    const store = createStore()
    protectSheet(store)

    for (const kind of [
      'set-cell-input',
      'clear-range',
      'fill-range',
      'fill-series',
      'paste-range',
      'import-cell-chunks',
      'remove-rows',
      'set-format-range',
    ] as const) {
      const resolution = store.setter(resolveContentMutationAtom, {
        kind,
        sheetId: SHEET,
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      })
      expect(resolution).toMatchObject({ status: 'blocked', reason: 'locked', kind })
    }
  })

  test('protectionGate: false skips the lock gate but still validates', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())
    protectSheet(store)

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'fill-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      protectionGate: false,
    })
    const invalid = store.setter(resolveContentMutationAtom, {
      kind: 'fill-range',
      sheetId: SHEET,
      cell: { row: 0, col: -2 },
      protectionGate: false,
    })

    expect(resolution).toMatchObject({
      status: 'allowed',
      ranges: [{ rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 }],
    })
    expect(invalid).toMatchObject({ status: 'blocked', reason: 'invalid-target' })
  })
})

describe('mutation gateway — set-format-range', () => {
  test('identity passthrough with the protection gate open', () => {
    const store = createStore()
    publishVisibleProjection(store, plainCells())

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'set-format-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    expect(resolution).toMatchObject({
      status: 'allowed',
      ranges: [{ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }],
    })
  })

  test('blocks format writes onto locked cells with a structured diagnostic', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())
    // Unlock row 1 only; row 2 stays locked.
    protectSheet(store, [{ rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 3 }])

    const allowed = store.setter(resolveContentMutationAtom, {
      kind: 'set-format-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    const blocked = store.setter(resolveContentMutationAtom, {
      kind: 'set-format-range',
      sheetId: SHEET,
      range: { rowStart: 2, rowEnd: 2, colStart: 0, colEnd: 1 },
    })

    expect(allowed).toMatchObject({
      status: 'allowed',
      ranges: [{ rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 1 }],
    })
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'locked', kind: 'set-format-range' })
    expect(store.getter(contentMutationLastBlockAtom)).toMatchObject({
      kind: 'set-format-range',
      reason: 'locked',
    })
    expect(
      store
        .getter(diagnosticsAtom)
        .items.some((item) => item.code === 'MUTATION_BLOCKED_LOCKED' && item.sheetId === SHEET),
    ).toBe(true)
  })
})

describe('mutation gateway — editing commit integration', () => {
  test('editing commit writes to the row the user sees under an active filter', async () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())
    const requests: EditingCommitRequest[] = []

    store.setter(startEditingAtom, {
      sheetId: SHEET,
      cell: { row: 2, col: 0 },
      draft: '42',
      source: 'cell',
    })
    const outcome = await store.setter(runEditingCommitAtom, {
      source: {
        async setCellInput(request) {
          requests.push(request)
          return { sheetId: request.sheetId, requestId: request.requestId, revision: 7 }
        },
      },
      commitSource: 'cell',
      refreshProjection: async () => undefined,
    })

    expect(outcome).toBe('completed')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ row: 2, col: 0, input: '42' })
  })

  test('editing commit is blocked with zero transport on a locked cell', async () => {
    const store = createStore()
    protectSheet(store)
    const requests: EditingCommitRequest[] = []

    store.setter(startEditingAtom, {
      sheetId: SHEET,
      cell: { row: 0, col: 0 },
      draft: 'nope',
      source: 'cell',
    })
    const outcome = await store.setter(runEditingCommitAtom, {
      source: {
        async setCellInput(request) {
          requests.push(request)
          return { sheetId: request.sheetId, requestId: request.requestId, revision: 1 }
        },
      },
      commitSource: 'cell',
      refreshProjection: async () => undefined,
    })

    expect(outcome).toBe('blocked')
    expect(requests).toHaveLength(0)
    expect(store.getter(editingCommitLifecycleAtom)).toMatchObject({
      status: 'blocked',
      error: 'The target cells are locked on a protected sheet.',
    })
  })
})
