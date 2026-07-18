import { createStore } from '@einfach/core'
import { Provider as SolidProvider } from '@einfach/solid'
import {
  capturePasteSpecialCapabilityAtom,
  createSpreadsheetUi,
  customFormulaRegistryAtom,
  MAX_CUSTOM_FORMULA_REGISTRY_ENTRIES,
  type CustomFormulaRegistration,
} from '@einfach/spreadsheet-ui-core'
import { onCleanup } from 'solid-js'
import { SpreadsheetUiContext } from './context'
import { spreadsheetBackendAtom } from './atoms'
import { attachNamedRangeFeaturePort } from './named-range-feature-port'
import { attachStatusBarProjectionBridge } from './status-bar-projection-bridge'
import type { SpreadsheetUiProviderProps } from './types'

type CustomFormulaOp =
  | { kind: 'unregister'; name: string }
  | { kind: 'register'; name: string; entry: CustomFormulaRegistration }

function customFormulaRegistrationsEqual(
  before: CustomFormulaRegistration,
  after: CustomFormulaRegistration,
): boolean {
  return (
    before.source === after.source &&
    (before.isAsync === true) === (after.isAsync === true) &&
    before.description === after.description &&
    (before.paramLabels?.join('|') ?? '') === (after.paramLabels?.join('|') ?? '')
  )
}

/**
 * Pick one remote mutation at a time. Stale removals always win over
 * installs. If any removal failed in this desired generation, new
 * installs stay blocked so repeated churn cannot grow the remote set.
 */
function nextCustomFormulaOp(
  installed: ReadonlyMap<string, CustomFormulaRegistration>,
  desired: ReadonlyMap<string, CustomFormulaRegistration>,
  failedNames: ReadonlySet<string>,
  cleanupFailed: boolean,
): CustomFormulaOp | null {
  for (const [name, entry] of installed) {
    const next = desired.get(name)
    if ((!next || !customFormulaRegistrationsEqual(entry, next)) && !failedNames.has(name)) {
      return { kind: 'unregister', name }
    }
  }

  if (!cleanupFailed && installed.size < MAX_CUSTOM_FORMULA_REGISTRY_ENTRIES) {
    for (const [name, entry] of desired) {
      if (!installed.has(name) && !failedNames.has(name)) {
        return { kind: 'register', name, entry }
      }
    }
  }

  return null
}

export function SpreadsheetUiProvider(props: SpreadsheetUiProviderProps) {
  const core = createSpreadsheetUi({
    backend: props.backend,
    store: props.store ?? createStore(),
  })
  core.store.setter(spreadsheetBackendAtom, props.backend)
  core.store.setter(capturePasteSpecialCapabilityAtom, props.backend)
  const detachNamedRangeFeaturePort = attachNamedRangeFeaturePort(
    core.store,
    props.backend,
    props.namedRangeCapabilityPort,
  )
  const detachStatusBarProjectionBridge = attachStatusBarProjectionBridge(core.store)

  // Wave 8 — custom-formula registry bridge. The backend may omit the
  // port entirely (static backend, legacy hosts); in that case the
  // synchronization pump is a no-op so registry writes still succeed against
  // the atom but do not reach the worker. Subscription is on the core
  // store directly (not via a Solid `createEffect`) so the listener
  // runs once per atom change regardless of which consumer is mounted.
  //
  // `installed` is only a per-provider synchronization ledger. The
  // core registry remains the sole desired state. Backend promises are
  // not cancellable, so each ACK first updates this ledger to reflect
  // what actually happened remotely; the next loop then compensates
  // against the latest registry snapshot.
  const installed = new Map<string, CustomFormulaRegistration>()
  let desired: ReadonlyMap<string, CustomFormulaRegistration> = new Map()
  let desiredGeneration = 0
  let failedNames = new Set<string>()
  let cleanupFailed = false
  let reconcileRunning = false
  let reconcileBlockedGeneration: number | null = null
  let unmounted = false

  const registerCustomFormula = props.backend.registerCustomFormula
  const unregisterCustomFormula = props.backend.unregisterCustomFormula
  const customFormulaPortAvailable = Boolean(registerCustomFormula && unregisterCustomFormula)

  async function reconcileCustomFormulas(): Promise<void> {
    if (!registerCustomFormula || !unregisterCustomFormula) return

    while (true) {
      const op = nextCustomFormulaOp(installed, desired, failedNames, cleanupFailed)
      if (!op) return
      try {
        if (op.kind === 'unregister') {
          await unregisterCustomFormula(op.name)
          installed.delete(op.name)
        } else {
          await registerCustomFormula(op.name, op.entry.source, {
            isAsync: op.entry.isAsync === true,
          })
          installed.set(op.name, op.entry)
        }
      } catch (err) {
        if (op.kind === 'unregister') {
          const current = installed.get(op.name)
          const next = desired.get(op.name)
          if (current && (!next || !customFormulaRegistrationsEqual(current, next))) {
            // The failed cleanup is still relevant to the newest
            // generation. Block installs even if this call began in an
            // older generation, otherwise churn could grow the remote set.
            failedNames.add(op.name)
            cleanupFailed = true
          }
        } else if (!installed.has(op.name) && desired.has(op.name)) {
          // The newest generation still needs this missing name. It may
          // retry after the next registry mutation, but not in a loop now.
          failedNames.add(op.name)
        }
        // eslint-disable-next-line no-console
        console.warn(`[customFormulas] ${op.kind} ${op.name} failed`, err)
      }
    }
  }

  function requestCustomFormulaReconcile(): void {
    if (!customFormulaPortAvailable || reconcileRunning) return
    reconcileRunning = true
    void reconcileCustomFormulas()
      .catch((err: unknown) => {
        reconcileBlockedGeneration = desiredGeneration
        // eslint-disable-next-line no-console
        console.warn('[customFormulas] reconcile failed', err)
      })
      .finally(() => {
        reconcileRunning = false
        if (
          reconcileBlockedGeneration !== desiredGeneration &&
          nextCustomFormulaOp(installed, desired, failedNames, cleanupFailed)
        ) {
          requestCustomFormulaReconcile()
        }
      })
  }

  function setCustomFormulaDesired(next: ReadonlyMap<string, CustomFormulaRegistration>): void {
    desired = next
    desiredGeneration += 1
    failedNames = new Set()
    cleanupFailed = false
    reconcileBlockedGeneration = null
    requestCustomFormulaReconcile()
  }

  function scheduleCustomFormulaReconcile(): void {
    if (unmounted) return
    setCustomFormulaDesired(core.store.getter(customFormulaRegistryAtom))
  }

  const unsubscribe = core.store.sub(customFormulaRegistryAtom, scheduleCustomFormulaReconcile)
  // Prime once so registrations written before mount are propagated.
  scheduleCustomFormulaReconcile()
  onCleanup(() => {
    detachNamedRangeFeaturePort()
    detachStatusBarProjectionBridge()
    unmounted = true
    unsubscribe()
    // Empty desired keeps the same serial pump alive. A pending register
    // may ACK after unmount; that ACK is recorded, then compensated by
    // an unregister before the provider-local ledger can settle.
    setCustomFormulaDesired(new Map())
  })

  return (
    <SolidProvider store={core.store}>
      <SpreadsheetUiContext.Provider value={core}>{props.children}</SpreadsheetUiContext.Provider>
    </SolidProvider>
  )
}
