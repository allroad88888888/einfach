import type { Store } from '@einfach/core'
import { sheetHiddenRowsAtom, type SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import { refreshVisibleProjection } from './projection-refresh'

/**
 * Manual-hidden-row projection refresh (design-engine-hidden-rows §4.2/§4.3).
 *
 * Since the hidden-row sink-down the engine OWNS the manually hidden set: UI
 * core's `hideRows` / `unhideRows` commands mutate it through the `hideRows` /
 * `unhideRows` ports and reconcile the local `sheetHiddenRowsAtom` projection
 * from the ACK. What the ports do NOT do is refetch cell values, so the
 * `SUBTOTAL(101-111)` cells that exclude hidden rows would keep their stale
 * displayed value until some other interaction refetched the window.
 *
 * This bridge closes that: whenever the manual hidden-ROW projection changes —
 * the optimistic write, its reconcile, a structural shift, an outline collapse,
 * an undo/redo replay — it refetches the visible projection once so the engine's
 * paired epoch bump surfaces. It replaces the retired `eval-hidden-rows-bridge`:
 * that bridge also PUSHED the set into the engine through `setEvalHiddenRows`,
 * which is now redundant (the engine owns the set through the mutation ports),
 * so only the refresh half survives — no push, no per-sheet ledger, no second
 * writer of an engine-owned fact.
 *
 * Columns are intentionally NOT watched: the engine models no hidden columns
 * (§8), so a column hide changes no evaluated value and needs no refetch.
 *
 * The latest Provider for a store owns the bridge (single-instance invariant),
 * so a replaced Provider cannot keep refreshing after a newer lifecycle starts.
 */
interface HiddenRowsRefreshOwner {
  active: boolean
  unsubscribe: (() => void) | null
}

const ownerByStore = new WeakMap<Store, HiddenRowsRefreshOwner>()

export function attachHiddenRowsRefreshBridge(
  store: Store,
  backend: SpreadsheetBackend,
): () => void {
  const previousOwner = ownerByStore.get(store)
  if (previousOwner) {
    previousOwner.active = false
    previousOwner.unsubscribe?.()
  }

  const owner: HiddenRowsRefreshOwner = { active: true, unsubscribe: null }
  ownerByStore.set(store, owner)

  owner.unsubscribe = store.sub(sheetHiddenRowsAtom, () => {
    if (!owner.active || ownerByStore.get(store) !== owner) return
    void refreshVisibleProjection(store, backend, undefined, 'selection').catch(() => {})
  })

  return () => {
    if (!owner.active) return
    owner.active = false
    owner.unsubscribe?.()
    owner.unsubscribe = null
    if (ownerByStore.get(store) !== owner) return
    ownerByStore.delete(store)
  }
}
