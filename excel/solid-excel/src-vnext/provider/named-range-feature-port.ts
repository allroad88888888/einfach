import type { Store } from '@einfach/core'
import {
  loadNamedRangeCapabilitiesAtom,
  namedRangeCapabilitiesAtom,
  refreshNamedRangeRegistryAtom,
  type NamedRangeControllerPort,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import type { NamedRangeCapabilityPort } from './types'

/**
 * Compose the explicitly injected capability port with the named-range
 * methods that are already part of SpreadsheetBackend.
 */
function createNamedRangeControllerPort(
  source: SpreadsheetBackend,
  capabilityPort: NamedRangeCapabilityPort | undefined,
): NamedRangeControllerPort {
  return {
    readNamedRangeCapabilities: capabilityPort?.readNamedRangeCapabilities.bind(capabilityPort),
    listNamedRanges: source.listNamedRanges?.bind(source),
    setNamedRange: source.setNamedRange?.bind(source),
    deleteNamedRange: source.deleteNamedRange?.bind(source),
  }
}

/**
 * Start capability discovery and refresh the registry exactly once after the
 * matching capability request becomes ready. Request-id matching prevents a
 * stale provider instance from refreshing after a newer load wins the store.
 */
export function attachNamedRangeFeaturePort(
  store: Store,
  backend: SpreadsheetBackend,
  capabilityPort?: NamedRangeCapabilityPort,
): () => void {
  const source = createNamedRangeControllerPort(backend, capabilityPort)
  let active = true
  let capabilityRequestId: number | null = null
  let refreshed = false

  const refreshAfterMatchingReady = (): void => {
    if (!active || capabilityRequestId === null || refreshed) return
    const capability = store.getter(namedRangeCapabilitiesAtom)
    if (capability.status !== 'ready' || capability.requestId !== capabilityRequestId) return
    refreshed = true
    store.setter(refreshNamedRangeRegistryAtom, { source })
  }

  const unsubscribe = store.sub(namedRangeCapabilitiesAtom, refreshAfterMatchingReady)
  store.setter(loadNamedRangeCapabilitiesAtom, { source })
  const loading = store.getter(namedRangeCapabilitiesAtom)
  capabilityRequestId = loading.status === 'loading' ? loading.requestId : null
  refreshAfterMatchingReady()

  return () => {
    active = false
    unsubscribe()
  }
}
