import type { Store } from '@einfach/core'
import { syncStatusBarProjectionAtom } from '@einfach/spreadsheet-ui-core'
import { spreadsheetProjectionSnapshotAtom } from './atoms'

interface ProjectionBridgeOwner {
  active: boolean
  unsubscribe: (() => void) | null
}

/** Provider lifecycle ownership only; product state remains in UI-core atoms. */
const projectionBridgeOwnerByStore = new WeakMap<Store, ProjectionBridgeOwner>()

function syncProjection(store: Store, owner: ProjectionBridgeOwner): void {
  if (!owner.active || projectionBridgeOwnerByStore.get(store) !== owner) return

  const snapshot = store.getter(spreadsheetProjectionSnapshotAtom)
  const result = snapshot.result?.kind === 'visible-window' ? snapshot.result : undefined
  store.setter(syncStatusBarProjectionAtom, {
    sheetId: result?.sheetId ?? null,
    window: result?.window ?? null,
    cells: result?.cells ?? [],
    truncated: result?.truncated === true,
  })
}

/**
 * Mirror canonical visible projection results into UI-core's aggregate input.
 * The latest Provider for a store owns the bridge, so an older Provider cannot
 * clear or resume synchronization after a replacement lifecycle has started.
 */
export function attachStatusBarProjectionBridge(store: Store): () => void {
  const previousOwner = projectionBridgeOwnerByStore.get(store)
  if (previousOwner) {
    previousOwner.active = false
    previousOwner.unsubscribe?.()
  }

  const owner: ProjectionBridgeOwner = {
    active: true,
    unsubscribe: null,
  }
  projectionBridgeOwnerByStore.set(store, owner)

  owner.unsubscribe = store.sub(spreadsheetProjectionSnapshotAtom, () => {
    syncProjection(store, owner)
  })
  syncProjection(store, owner)

  return () => {
    if (!owner.active) return
    owner.active = false
    owner.unsubscribe?.()
    owner.unsubscribe = null

    if (projectionBridgeOwnerByStore.get(store) !== owner) return
    projectionBridgeOwnerByStore.delete(store)
    store.setter(syncStatusBarProjectionAtom, {
      sheetId: null,
      window: null,
      cells: [],
      truncated: false,
    })
  }
}
