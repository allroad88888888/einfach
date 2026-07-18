import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import type { WorkspaceSessionState } from '../src/workspace'
import {
  DEFAULT_WORKSPACE_SESSION_STATE,
  advanceWorkspaceViewportRevision,
  advanceWorkspaceViewportAtom,
  commitWorkspaceProjectionRevision,
  commitWorkspaceProjectionAtom,
  createWorkspaceSessionState,
  isWorkspaceProjectionStale,
  requestWorkspaceProjectionRevision,
  requestWorkspaceProjectionAtom,
  resetWorkspaceSessionAtom,
  setWorkspaceActiveSheetId,
  setWorkbookLocaleAtom,
  setWorkspaceActiveSheetAtom,
  workspaceActiveSheetAuthorityWitnessAtom,
  workspaceSessionAtom,
  workbookLocaleAtom,
} from '../src/workspace'

describe('workspace core', () => {
  test('stores only session metadata and tracks revisions', () => {
    const store = createStore()

    expect(store.getter(workspaceSessionAtom)).toEqual({
      activeSheetId: null,
      viewportRevision: 0,
      projectionRequestRevision: 0,
      committedProjectionRequestRevision: 0,
    })

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(advanceWorkspaceViewportAtom, 2)

    const requestRevision = store.setter(requestWorkspaceProjectionAtom)

    expect(requestRevision).toBe(1)
    expect(store.getter(workspaceSessionAtom)).toEqual({
      activeSheetId: 'sheet-1',
      viewportRevision: 2,
      projectionRequestRevision: 1,
      committedProjectionRequestRevision: 0,
    })
    expect(isWorkspaceProjectionStale(store.getter(workspaceSessionAtom), 0)).toBe(true)
  })

  test('ignores stale projection commits and accepts matching revisions', () => {
    const store = createStore()

    store.setter(requestWorkspaceProjectionAtom)
    store.setter(requestWorkspaceProjectionAtom)

    const before = store.getter(workspaceSessionAtom)
    const stale = store.setter(commitWorkspaceProjectionAtom, { requestRevision: 1 })

    expect(stale).toBe(before)

    const committed = store.setter(commitWorkspaceProjectionAtom, { requestRevision: 2 })

    expect(committed).toEqual({
      activeSheetId: null,
      viewportRevision: 0,
      projectionRequestRevision: 2,
      committedProjectionRequestRevision: 2,
    })
  })

  test('rotates active-sheet authority across A to B to A without token reuse', () => {
    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    const witnessA = store.getter(workspaceActiveSheetAuthorityWitnessAtom)

    store.setter(workspaceSessionAtom, (previous) => ({
      ...previous,
      activeSheetId: 'sheet-b',
    }))
    const witnessB = store.getter(workspaceActiveSheetAuthorityWitnessAtom)

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    const witnessReturnedA = store.getter(workspaceActiveSheetAuthorityWitnessAtom)

    expect(witnessB).not.toBe(witnessA)
    expect(witnessReturnedA).not.toBe(witnessA)
    expect(witnessReturnedA).not.toBe(witnessB)
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-a')
  })

  test('viewport and projection writes preserve active-sheet authority', () => {
    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    const witness = store.getter(workspaceActiveSheetAuthorityWitnessAtom)

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-a' })
    store.setter(advanceWorkspaceViewportAtom, 1)
    const requestRevision = store.setter(requestWorkspaceProjectionAtom)
    if (requestRevision === null) throw new Error('Expected projection revision allocation')
    store.setter(commitWorkspaceProjectionAtom, { requestRevision })
    store.setter(workspaceSessionAtom, (previous) => ({
      ...previous,
      viewportRevision: previous.viewportRevision + 1,
    }))

    expect(store.getter(workspaceActiveSheetAuthorityWitnessAtom)).toBe(witness)
  })

  test('public session facade snapshots direct values and gives updaters a defensive copy', () => {
    const store = createStore()
    const directState = {
      activeSheetId: 'sheet-a',
      viewportRevision: 0,
      projectionRequestRevision: 0,
      committedProjectionRequestRevision: 0,
    }

    store.setter(workspaceSessionAtom, directState)
    const witnessA = store.getter(workspaceActiveSheetAuthorityWitnessAtom)
    directState.activeSheetId = 'forged-sheet'
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-a')
    expect(store.getter(workspaceActiveSheetAuthorityWitnessAtom)).toBe(witnessA)

    const publicState = store.getter(workspaceSessionAtom)
    expect(Object.isFrozen(DEFAULT_WORKSPACE_SESSION_STATE)).toBe(true)
    expect(Object.isFrozen(publicState)).toBe(true)
    expect(() => {
      publicState.activeSheetId = 'forged-sheet'
    }).toThrow(TypeError)

    store.setter(workspaceSessionAtom, (previous) => {
      expect(Object.isFrozen(previous)).toBe(true)
      previous.activeSheetId = 'sheet-b'
      return previous
    })
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-a')
    expect(store.getter(workspaceActiveSheetAuthorityWitnessAtom)).toBe(witnessA)
  })

  test('locale writers accept bounded locale strings', () => {
    const store = createStore()
    store.setter(workbookLocaleAtom, 'zh-CN')
    expect(store.getter(workbookLocaleAtom)).toBe('zh-CN')

    store.setter(setWorkbookLocaleAtom, 'ja-JP')
    expect(store.getter(workbookLocaleAtom)).toBe('ja-JP')

    store.setter(setWorkbookLocaleAtom, 'x'.repeat(129))
    expect(store.getter(workbookLocaleAtom)).toBe('ja-JP')
  })

  test('revision overflow and unsafe numeric inputs are rejected', () => {
    const store = createStore()
    store.setter(workspaceSessionAtom, {
      activeSheetId: 'sheet-a',
      viewportRevision: Number.MAX_SAFE_INTEGER,
      projectionRequestRevision: Number.MAX_SAFE_INTEGER,
      committedProjectionRequestRevision: 0,
    })
    const before = store.getter(workspaceSessionAtom)

    expect(store.setter(requestWorkspaceProjectionAtom)).toBeNull()
    store.setter(advanceWorkspaceViewportAtom, 1)
    store.setter(advanceWorkspaceViewportAtom, 0.5)
    store.setter(commitWorkspaceProjectionAtom, { requestRevision: 1e100 })
    expect(store.getter(workspaceSessionAtom)).toBe(before)

    store.setter(resetWorkspaceSessionAtom)
    expect(store.getter(workspaceSessionAtom)).toEqual(DEFAULT_WORKSPACE_SESSION_STATE)
  })

  test('constructor clamps committed projection revision to its normalized request revision', () => {
    expect(
      createWorkspaceSessionState({
        activeSheetId: 'sheet-a',
        viewportRevision: 3,
        projectionRequestRevision: 2,
        committedProjectionRequestRevision: 9,
      }),
    ).toEqual({
      activeSheetId: 'sheet-a',
      viewportRevision: 3,
      projectionRequestRevision: 2,
      committedProjectionRequestRevision: 2,
    })
  })

  test('exported workspace helpers share one session validation invariant', () => {
    const invalid = {
      activeSheetId: 'sheet-a',
      viewportRevision: 0,
      projectionRequestRevision: 1,
      committedProjectionRequestRevision: 2,
    }

    expect(setWorkspaceActiveSheetId(invalid, 'sheet-b')).toBe(invalid)
    expect(advanceWorkspaceViewportRevision(invalid)).toBe(invalid)
    expect(requestWorkspaceProjectionRevision(invalid)).toEqual({
      state: invalid,
      requestRevision: null,
    })
    expect(commitWorkspaceProjectionRevision(invalid, 1)).toBe(invalid)
    expect(isWorkspaceProjectionStale(invalid, 0)).toBe(true)

    const overlongSheet = {
      ...DEFAULT_WORKSPACE_SESSION_STATE,
      activeSheetId: 'x'.repeat(513),
    }
    expect(advanceWorkspaceViewportRevision(overlongSheet)).toBe(overlongSheet)
    expect(requestWorkspaceProjectionRevision(overlongSheet).requestRevision).toBeNull()
    expect(isWorkspaceProjectionStale(overlongSheet, 0)).toBe(true)
    expect(setWorkspaceActiveSheetId(DEFAULT_WORKSPACE_SESSION_STATE, 'x'.repeat(513))).toBe(
      DEFAULT_WORKSPACE_SESSION_STATE,
    )
  })

  test('projection staleness treats invalid request revisions as stale', () => {
    const current = {
      activeSheetId: 'sheet-a',
      viewportRevision: 0,
      projectionRequestRevision: 2,
      committedProjectionRequestRevision: 1,
    }

    for (const invalidRevision of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(isWorkspaceProjectionStale(current, invalidRevision)).toBe(true)
    }
    expect(isWorkspaceProjectionStale(current, 1)).toBe(true)
    expect(isWorkspaceProjectionStale(current, 2)).toBe(false)
    expect(isWorkspaceProjectionStale(current, 3)).toBe(false)
  })
})
