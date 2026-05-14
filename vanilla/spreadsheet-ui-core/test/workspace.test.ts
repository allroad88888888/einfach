import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  advanceWorkspaceViewportAtom,
  commitWorkspaceProjectionAtom,
  isWorkspaceProjectionStale,
  requestWorkspaceProjectionAtom,
  setWorkspaceActiveSheetAtom,
  workspaceSessionAtom,
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
})
