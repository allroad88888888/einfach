import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  addOutlineGroupAtom,
  applyOutlineStructuralShiftAtom,
  collapseOutlineToLevelAtom,
  computeCollapsedOutlineIndices,
  computeOutlineLevels,
  getOutlineGroupsForSheet,
  getOutlineLeveledGroupsForSheet,
  getOutlineMaxLevelForSheet,
  getHistoryLocalReplayApplier,
  groupSelectionAtom,
  hideRowsAtom,
  historyStackAtom,
  OUTLINE_MAX_DEPTH,
  OUTLINE_MAX_GROUPS_PER_SHEET_AXIS,
  OUTLINE_REPLAY_KEY,
  outlineAtom,
  registerHistoryLocalReplayApplier,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  selectColumnsAtom,
  selectRowsAtom,
  toggleOutlineGroupCollapsedAtom,
  ungroupOutlineRangeAtom,
  ungroupSelectionAtom,
  VIEWPORT_HIDDEN_REPLAY_KEY,
  viewportHiddenAtom,
} from '../src'

const historyInput = () => ({
  source: {},
  refreshProjection: async () => {
    throw new Error('outline local replay must not refresh the backend projection')
  },
})

function rowGroups(store: ReturnType<typeof createStore>, sheetId = 'S') {
  return getOutlineGroupsForSheet(store.getter(outlineAtom), sheetId, 'row')
}

function hiddenRows(store: ReturnType<typeof createStore>, sheetId = 'S') {
  return store.getter(viewportHiddenAtom).rowsBySheet[sheetId] ?? []
}

describe('outline grouping metadata (UI-core canonical)', () => {
  test('adds a group and derives level 1', () => {
    const store = createStore()
    expect(
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 }),
    ).toBe('committed')
    expect(rowGroups(store)).toEqual([{ start: 1, end: 3, collapsed: false }])
    expect(getOutlineLeveledGroupsForSheet(store.getter(outlineAtom), 'S', 'row')).toEqual([
      { start: 1, end: 3, collapsed: false, level: 1 },
    ])
    expect(getOutlineMaxLevelForSheet(store.getter(outlineAtom), 'S', 'row')).toBe(1)
  })

  test('derives nesting levels from containment and duplicates', () => {
    const store = createStore()
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 0, end: 9 })
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 2, end: 5 })
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 2, end: 5 })
    expect(
      getOutlineLeveledGroupsForSheet(store.getter(outlineAtom), 'S', 'row').map((g) => g.level),
    ).toEqual([1, 2, 3])
  })

  test('rejects invalid input and partial overlaps', () => {
    const store = createStore()
    expect(
      store.setter(addOutlineGroupAtom, { sheetId: '', axis: 'row', start: 1, end: 3 }),
    ).toBe('invalid')
    expect(
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 3, end: 1 }),
    ).toBe('invalid')
    expect(
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: -1, end: 1 }),
    ).toBe('invalid')
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 1, end: 5 })
    expect(
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 3, end: 8 }),
    ).toBe('invalid')
    expect(rowGroups(store)).toHaveLength(1)
  })

  test('caps nesting depth at 8 including outer wraps', () => {
    const store = createStore()
    for (let level = 0; level < OUTLINE_MAX_DEPTH; level += 1) {
      expect(
        store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 10, end: 20 }),
      ).toBe('committed')
    }
    expect(
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 10, end: 20 }),
    ).toBe('invalid')
    // An outer group would push the innermost duplicate past the cap too.
    expect(
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 5, end: 25 }),
    ).toBe('invalid')
    expect(rowGroups(store)).toHaveLength(OUTLINE_MAX_DEPTH)
  })

  test('caps the group count per sheet per axis', () => {
    const store = createStore()
    for (let index = 0; index < OUTLINE_MAX_GROUPS_PER_SHEET_AXIS; index += 1) {
      expect(
        store.setter(addOutlineGroupAtom, {
          sheetId: 'S',
          axis: 'row',
          start: index * 2,
          end: index * 2 + 1,
        }),
      ).toBe('committed')
    }
    expect(
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 500, end: 501 }),
    ).toBe('invalid')
    expect(rowGroups(store)).toHaveLength(OUTLINE_MAX_GROUPS_PER_SHEET_AXIS)
  })

  test('group and ungroup resolve the selection on the requested axis', () => {
    const store = createStore()
    expect(store.setter(groupSelectionAtom, { axis: 'row' })).toBe('invalid')

    store.setter(selectRowsAtom, { sheetId: 'S', rowAnchor: 1, rowFocus: 3 })
    expect(store.setter(groupSelectionAtom, { axis: 'row' })).toBe('committed')
    expect(rowGroups(store)).toEqual([{ start: 1, end: 3, collapsed: false }])

    store.setter(selectColumnsAtom, { sheetId: 'S', colAnchor: 2, colFocus: 4 })
    expect(store.setter(groupSelectionAtom, { axis: 'column' })).toBe('committed')
    expect(getOutlineGroupsForSheet(store.getter(outlineAtom), 'S', 'column')).toEqual([
      { start: 2, end: 4, collapsed: false },
    ])

    store.setter(selectRowsAtom, { sheetId: 'S', rowAnchor: 0, rowFocus: 5 })
    expect(store.setter(ungroupSelectionAtom, { axis: 'row' })).toBe('committed')
    expect(rowGroups(store)).toEqual([])
  })

  test('ungroup removes only the innermost level per gesture', () => {
    const store = createStore()
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 0, end: 9 })
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 2, end: 5 })
    expect(
      store.setter(ungroupOutlineRangeAtom, { sheetId: 'S', axis: 'row', start: 0, end: 9 }),
    ).toBe('committed')
    expect(rowGroups(store)).toEqual([{ start: 0, end: 9, collapsed: false }])
    expect(
      store.setter(ungroupOutlineRangeAtom, { sheetId: 'S', axis: 'row', start: 0, end: 9 }),
    ).toBe('committed')
    expect(rowGroups(store)).toEqual([])
    expect(
      store.setter(ungroupOutlineRangeAtom, { sheetId: 'S', axis: 'row', start: 0, end: 9 }),
    ).toBe('unchanged')
  })
})

describe('outline collapse ↔ hidden linkage', () => {
  test('collapse hides the interval, expand restores it, one entry per gesture', async () => {
    const store = createStore()
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 })
    expect(
      store.setter(toggleOutlineGroupCollapsedAtom, {
        sheetId: 'S',
        axis: 'row',
        start: 1,
        end: 3,
      }),
    ).toBe('committed')
    expect(hiddenRows(store)).toEqual([1, 2, 3])
    expect(rowGroups(store)).toEqual([{ start: 1, end: 3, collapsed: true }])

    const stack = store.getter(historyStackAtom)
    expect(stack.entries).toHaveLength(2)
    expect(stack.entries[1]).toMatchObject({ kind: 'outline', projectionRevision: 'local' })

    expect(
      store.setter(toggleOutlineGroupCollapsedAtom, {
        sheetId: 'S',
        axis: 'row',
        start: 1,
        end: 3,
      }),
    ).toBe('committed')
    expect(hiddenRows(store)).toEqual([])
    expect(rowGroups(store)).toEqual([{ start: 1, end: 3, collapsed: false }])

    // Undo expand → collapsed again; undo collapse → expanded; redo both.
    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(hiddenRows(store)).toEqual([1, 2, 3])
    expect(rowGroups(store)).toEqual([{ start: 1, end: 3, collapsed: true }])
    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(hiddenRows(store)).toEqual([])
    expect(rowGroups(store)).toEqual([{ start: 1, end: 3, collapsed: false }])
    await expect(store.setter(runRedoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(hiddenRows(store)).toEqual([1, 2, 3])
    await expect(store.setter(runRedoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(hiddenRows(store)).toEqual([])
  })

  test('expanding an outer group keeps nested collapsed groups hidden', () => {
    const store = createStore()
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 1, end: 5 })
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 2, end: 3 })
    store.setter(toggleOutlineGroupCollapsedAtom, { sheetId: 'S', axis: 'row', start: 2, end: 3 })
    expect(hiddenRows(store)).toEqual([2, 3])
    store.setter(toggleOutlineGroupCollapsedAtom, { sheetId: 'S', axis: 'row', start: 1, end: 5 })
    expect(hiddenRows(store)).toEqual([1, 2, 3, 4, 5])
    store.setter(toggleOutlineGroupCollapsedAtom, { sheetId: 'S', axis: 'row', start: 1, end: 5 })
    // Only the rows no collapsed group covers reappear.
    expect(hiddenRows(store)).toEqual([2, 3])
  })

  test('preserves manually hidden rows outside the toggled interval', () => {
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'S', indices: [7] })
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 })
    store.setter(toggleOutlineGroupCollapsedAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 })
    expect(hiddenRows(store)).toEqual([1, 2, 3, 7])
    store.setter(toggleOutlineGroupCollapsedAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 })
    expect(hiddenRows(store)).toEqual([7])
  })

  test('ungrouping a collapsed group leaves its rows hidden (Excel semantics)', () => {
    const store = createStore()
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 })
    store.setter(toggleOutlineGroupCollapsedAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 })
    expect(
      store.setter(ungroupOutlineRangeAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 }),
    ).toBe('committed')
    expect(rowGroups(store)).toEqual([])
    expect(hiddenRows(store)).toEqual([1, 2, 3])
  })

  test('collapseOutlineToLevelAtom applies Excel level-button semantics', () => {
    const store = createStore()
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 0, end: 9 })
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 2, end: 5 })
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 3, end: 4 })

    expect(
      store.setter(collapseOutlineToLevelAtom, { sheetId: 'S', axis: 'row', level: 2 }),
    ).toBe('committed')
    expect(rowGroups(store).map((group) => group.collapsed)).toEqual([false, true, true])
    expect(hiddenRows(store)).toEqual([2, 3, 4, 5])

    expect(
      store.setter(collapseOutlineToLevelAtom, { sheetId: 'S', axis: 'row', level: 1 }),
    ).toBe('committed')
    expect(hiddenRows(store)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    expect(
      store.setter(collapseOutlineToLevelAtom, { sheetId: 'S', axis: 'row', level: 4 }),
    ).toBe('committed')
    expect(rowGroups(store).map((group) => group.collapsed)).toEqual([false, false, false])
    expect(hiddenRows(store)).toEqual([])

    expect(
      store.setter(collapseOutlineToLevelAtom, { sheetId: 'S', axis: 'row', level: 4 }),
    ).toBe('unchanged')
    expect(
      store.setter(collapseOutlineToLevelAtom, { sheetId: 'S', axis: 'row', level: 0 }),
    ).toBe('invalid')
  })

  test('column-axis collapse works against the hidden columns set', () => {
    const store = createStore()
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'column', start: 2, end: 4 })
    store.setter(toggleOutlineGroupCollapsedAtom, {
      sheetId: 'S',
      axis: 'column',
      start: 2,
      end: 4,
    })
    expect(store.getter(viewportHiddenAtom).colsBySheet.S).toEqual([2, 3, 4])
    expect(store.getter(viewportHiddenAtom).rowsBySheet.S ?? []).toEqual([])
  })

  test('undo of a metadata-only group add removes the group', async () => {
    const store = createStore()
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 })
    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(rowGroups(store)).toEqual([])
    await expect(store.setter(runRedoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(rowGroups(store)).toEqual([{ start: 1, end: 3, collapsed: false }])
  })
})

// Counter-example suite. Outline used to reach into the history registry for
// `VIEWPORT_HIDDEN_REPLAY_KEY` and apply collapse visibility through the hidden
// module's applier. That lookup is nullable and outline ignored the result, so
// removing the hidden applier (which the pending hidden-state-to-Rust sink-down
// will do) would have made collapse undo a SILENT no-op — invisible to every
// hide/unhide and filter test, because none of them exercise outline.
//
// These tests fail against the coupled implementation. Keep them: they are the
// only thing that distinguishes "outline owns its replay" from "outline is
// still borrowing the hidden one".
describe('outline collapse visibility is outline-owned (sink-down rehearsal)', () => {
  function withHiddenApplierRemoved<T>(run: (calls: () => number) => T): T {
    const original = getHistoryLocalReplayApplier(VIEWPORT_HIDDEN_REPLAY_KEY)
    if (original === null) throw new Error('hidden applier must be registered before removal')
    let calls = 0
    // Stand-in for the sink-down: the key is still known but the applier no
    // longer writes anything, exactly like a registration that was deleted.
    registerHistoryLocalReplayApplier(VIEWPORT_HIDDEN_REPLAY_KEY, () => {
      calls += 1
      return false
    })
    try {
      return run(() => calls)
    } finally {
      registerHistoryLocalReplayApplier(VIEWPORT_HIDDEN_REPLAY_KEY, original)
    }
  }

  test('collapse, expand, undo and redo all work with the hidden applier gone', async () => {
    await withHiddenApplierRemoved(async (calls) => {
      const store = createStore()
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 })

      // Forward path: previously routed through the hidden applier.
      store.setter(toggleOutlineGroupCollapsedAtom, { sheetId: 'S', axis: 'row', start: 1, end: 3 })
      expect(hiddenRows(store)).toEqual([1, 2, 3])

      // Replay path: previously delegated the hidden slice to the hidden applier.
      await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
      expect(hiddenRows(store)).toEqual([])
      expect(rowGroups(store)).toEqual([{ start: 1, end: 3, collapsed: false }])

      await expect(store.setter(runRedoHistoryAtom, historyInput())).resolves.toBe('completed')
      expect(hiddenRows(store)).toEqual([1, 2, 3])
      expect(rowGroups(store)).toEqual([{ start: 1, end: 3, collapsed: true }])

      // The decisive assertion: not merely "it still works" but "it never asked
      // the hidden module to do it".
      expect(calls()).toBe(0)
    })
  })

  test('level-button collapse and its undo work with the hidden applier gone', async () => {
    await withHiddenApplierRemoved(async (calls) => {
      const store = createStore()
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 0, end: 9 })
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 2, end: 5 })

      store.setter(collapseOutlineToLevelAtom, { sheetId: 'S', axis: 'row', level: 2 })
      expect(hiddenRows(store)).toEqual([2, 3, 4, 5])

      await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
      expect(hiddenRows(store)).toEqual([])
      expect(calls()).toBe(0)
    })
  })

  test('column-axis collapse and its undo work with the hidden applier gone', async () => {
    await withHiddenApplierRemoved(async (calls) => {
      const store = createStore()
      store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'column', start: 2, end: 4 })
      store.setter(toggleOutlineGroupCollapsedAtom, {
        sheetId: 'S',
        axis: 'column',
        start: 2,
        end: 4,
      })
      expect(store.getter(viewportHiddenAtom).colsBySheet.S).toEqual([2, 3, 4])

      await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
      expect(store.getter(viewportHiddenAtom).colsBySheet.S).toEqual([])
      expect(calls()).toBe(0)
    })
  })

  test('outline replay still refuses a malformed hidden slice instead of writing it', async () => {
    // Parity guard for the validation the hidden applier used to perform on
    // outline's behalf: a non-index hidden payload must leave the hidden set
    // untouched while the outline metadata still replays.
    const applier = getHistoryLocalReplayApplier(OUTLINE_REPLAY_KEY)
    expect(applier).not.toBeNull()
    const store = createStore()
    store.setter(hideRowsAtom, { sheetId: 'S', indices: [4] })
    const applied = applier?.(
      store.getter,
      store.setter,
      {
        applyKey: OUTLINE_REPLAY_KEY,
        sheetId: 'S',
        before: { rows: [], hidden: { rows: ['nope'] } },
        after: { rows: [{ start: 1, end: 3, collapsed: true }], hidden: { rows: ['nope'] } },
      },
      'redo',
    )
    expect(applied).toBe(true)
    expect(rowGroups(store)).toEqual([{ start: 1, end: 3, collapsed: true }])
    expect(hiddenRows(store)).toEqual([4])
  })
})

describe('outline structural remap', () => {
  test('shifts, extends, shrinks, and drops intervals across structural shifts', () => {
    const store = createStore()
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 4, end: 6 })

    // Insert above → whole interval shifts down.
    expect(
      store.setter(applyOutlineStructuralShiftAtom, {
        sheetId: 'S',
        shift: { axis: 'row', kind: 'insert', index: 0, count: 2 },
      }),
    ).toBe(true)
    expect(rowGroups(store)).toEqual([{ start: 6, end: 8, collapsed: false }])

    // Insert inside → interval extends.
    store.setter(applyOutlineStructuralShiftAtom, {
      sheetId: 'S',
      shift: { axis: 'row', kind: 'insert', index: 7, count: 1 },
    })
    expect(rowGroups(store)).toEqual([{ start: 6, end: 9, collapsed: false }])

    // Overlapping delete → interval shrinks.
    store.setter(applyOutlineStructuralShiftAtom, {
      sheetId: 'S',
      shift: { axis: 'row', kind: 'delete', index: 8, count: 4 },
    })
    expect(rowGroups(store)).toEqual([{ start: 6, end: 7, collapsed: false }])

    // Delete covering the whole interval → group drops out.
    store.setter(applyOutlineStructuralShiftAtom, {
      sheetId: 'S',
      shift: { axis: 'row', kind: 'delete', index: 5, count: 4 },
    })
    expect(rowGroups(store)).toEqual([])

    // Column shifts leave row groups untouched and vice versa.
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 1, end: 2 })
    expect(
      store.setter(applyOutlineStructuralShiftAtom, {
        sheetId: 'S',
        shift: { axis: 'column', kind: 'insert', index: 0, count: 3 },
      }),
    ).toBe(false)
    expect(rowGroups(store)).toEqual([{ start: 1, end: 2, collapsed: false }])
  })

  test('rejects malformed shift input', () => {
    const store = createStore()
    store.setter(addOutlineGroupAtom, { sheetId: 'S', axis: 'row', start: 1, end: 2 })
    expect(
      store.setter(applyOutlineStructuralShiftAtom, {
        sheetId: '',
        shift: { axis: 'row', kind: 'insert', index: 0, count: 1 },
      }),
    ).toBe(false)
    expect(
      store.setter(applyOutlineStructuralShiftAtom, {
        sheetId: 'S',
        shift: { axis: 'diagonal', kind: 'insert', index: 0, count: 1 } as never,
      }),
    ).toBe(false)
  })
})

describe('outline pure helpers', () => {
  test('computeOutlineLevels and computeCollapsedOutlineIndices', () => {
    const groups = [
      { start: 0, end: 9, collapsed: false },
      { start: 2, end: 5, collapsed: true },
      { start: 7, end: 8, collapsed: true },
    ]
    expect(computeOutlineLevels(groups).map((group) => group.level)).toEqual([1, 2, 2])
    expect(computeCollapsedOutlineIndices(groups)).toEqual([2, 3, 4, 5, 7, 8])
  })
})
