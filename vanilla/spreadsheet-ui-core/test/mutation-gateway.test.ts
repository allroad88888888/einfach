import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { DisplayCell, VisibleProjectionResult } from '../src/backend'
import { diagnosticsAtom } from '../src/diagnostics'
import {
  clearContentMutationBlockAtom,
  contentMutationLastBlockAtom,
  editingCommitLifecycleAtom,
  mapDisplayRangeToSourceRanges,
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

/** Display rows 0..2 backed by source rows 0, 5, 3; display row 3 has no fact. */
function filteredCells(): DisplayCell[] {
  return [
    { row: 0, col: 0, displayValue: 'header', originalRow: 0 },
    { row: 1, col: 0, displayValue: 'beta', originalRow: 5 },
    { row: 1, col: 1, displayValue: 'beta-b', originalRow: 5 },
    { row: 2, col: 0, displayValue: 'gamma', originalRow: 3 },
    { row: 2, col: 1, displayValue: 'gamma-b', originalRow: 3 },
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

describe('mutation gateway — display→source remap', () => {
  test('identity passthrough when no projection has been published', () => {
    const store = createStore()

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: SHEET,
      cell: { row: 2, col: 1 },
    })

    expect(resolution).toMatchObject({
      status: 'allowed',
      cell: { row: 2, col: 1 },
      remapped: false,
    })
  })

  test('identity passthrough when the projection has no originalRow facts', () => {
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

    expect(cellResolution).toMatchObject({
      status: 'allowed',
      cell: { row: 1, col: 0 },
      remapped: false,
    })
    expect(rangeResolution).toMatchObject({
      status: 'allowed',
      ranges: [{ rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 }],
      remapped: false,
    })
  })

  test('maps a display cell onto its source row while filter/sort is active', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: SHEET,
      cell: { row: 1, col: 1 },
    })

    expect(resolution).toMatchObject({
      status: 'allowed',
      cell: { row: 5, col: 1 },
      remapped: true,
    })
  })

  test('splits a permuted display range into one source range per row run', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'clear-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 2, colStart: 0, colEnd: 1 },
    })

    expect(resolution).toMatchObject({
      status: 'allowed',
      remapped: true,
      ranges: [
        { rowStart: 5, rowEnd: 5, colStart: 0, colEnd: 1 },
        { rowStart: 3, rowEnd: 3, colStart: 0, colEnd: 1 },
      ],
    })
  })

  test('merges contiguous source rows back into a single range', () => {
    const cells: DisplayCell[] = [
      { row: 0, col: 0, displayValue: 'a', originalRow: 3 },
      { row: 1, col: 0, displayValue: 'b', originalRow: 4 },
    ]
    const result = mapDisplayRangeToSourceRanges(
      {
        kind: 'visible-window',
        sheetId: SHEET,
        requestId: 1,
        window: WINDOW,
        cells,
      },
      SHEET,
      { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
    )

    expect(result).toEqual({
      ok: true,
      ranges: [{ rowStart: 3, rowEnd: 4, colStart: 0, colEnd: 0 }],
      remapped: true,
    })
  })

  test('fails closed for a display row without an originalRow fact', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'clear-range',
      sheetId: SHEET,
      range: { rowStart: 2, rowEnd: 3, colStart: 0, colEnd: 0 },
    })

    expect(resolution).toMatchObject({ status: 'blocked', reason: 'unmapped-row' })
    expect(store.getter(contentMutationLastBlockAtom)).toMatchObject({
      reason: 'unmapped-row',
      kind: 'clear-range',
    })
    expect(
      store
        .getter(diagnosticsAtom)
        .items.some((item) => item.code === 'MUTATION_UNMAPPED_ROW' && item.sheetId === SHEET),
    ).toBe(true)

    store.setter(clearContentMutationBlockAtom)
    expect(store.getter(contentMutationLastBlockAtom)).toBeNull()
  })

  test('fails closed for a display row outside the projected window', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'paste-range',
      sheetId: SHEET,
      cell: { row: 10, col: 0 },
    })

    expect(resolution).toMatchObject({ status: 'blocked', reason: 'unmapped-row' })
  })

  test('rejects invalid coordinates', () => {
    const store = createStore()

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: SHEET,
      cell: { row: -1, col: 0 },
    })

    expect(resolution).toMatchObject({ status: 'blocked', reason: 'invalid-target' })
  })
})

describe('mutation gateway — protection gate', () => {
  test('gates with source coordinates after the remap', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())
    // Unlock the SOURCE row 5; the display row 1 stays locked in display terms.
    protectSheet(store, [{ rowStart: 5, rowEnd: 5, colStart: 0, colEnd: 3 }])

    const allowed = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: SHEET,
      cell: { row: 1, col: 0 },
    })
    // Display row 2 maps to source row 3 which is NOT unlocked.
    const blocked = store.setter(resolveContentMutationAtom, {
      kind: 'set-cell-input',
      sheetId: SHEET,
      cell: { row: 2, col: 0 },
    })

    expect(allowed).toMatchObject({ status: 'allowed', cell: { row: 5, col: 0 } })
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
    ] as const) {
      const resolution = store.setter(resolveContentMutationAtom, {
        kind,
        sheetId: SHEET,
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      })
      expect(resolution).toMatchObject({ status: 'blocked', reason: 'locked', kind })
    }
  })

  test('protectionGate: false still remaps but skips the lock gate', () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())
    protectSheet(store)

    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'fill-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      protectionGate: false,
    })

    expect(resolution).toMatchObject({
      status: 'allowed',
      remapped: true,
      ranges: [{ rowStart: 5, rowEnd: 5, colStart: 0, colEnd: 0 }],
    })
  })
})

describe('mutation gateway — editing commit integration', () => {
  test('editing commit writes to the mapped source row under an active filter', async () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())
    const requests: EditingCommitRequest[] = []

    store.setter(startEditingAtom, {
      sheetId: SHEET,
      cell: { row: 1, col: 0 },
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
    expect(requests[0]).toMatchObject({ row: 5, col: 0, input: '42' })
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

  test('editing commit fails closed when the drafted display row is unmappable', async () => {
    const store = createStore()
    publishVisibleProjection(store, filteredCells())
    const requests: EditingCommitRequest[] = []

    store.setter(startEditingAtom, {
      sheetId: SHEET,
      cell: { row: 3, col: 0 },
      draft: 'lost',
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
    expect(store.getter(contentMutationLastBlockAtom)).toMatchObject({ reason: 'unmapped-row' })
  })
})
