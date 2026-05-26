import { createStore } from '@einfach/core'
import { Provider as SolidProvider } from '@einfach/solid'
import {
  createSpreadsheetUi,
  customFormulaRegistryAtom,
  type CustomFormulaRegistration,
} from '@einfach/spreadsheet-ui-core'
import { onCleanup } from 'solid-js'
import { SpreadsheetUiContext } from './context'
import { spreadsheetBackendAtom } from './atoms'
import type { SpreadsheetUiProviderProps } from './types'

/**
 * Diff the previously-installed custom formulas against the next
 * registry snapshot and forward the add/replace/remove edges to the
 * backend port. Replace = unregister then register so the worker
 * compiles the fresh source. Errors thrown by the backend are caught
 * and surfaced via console so a single bad registration cannot wedge
 * the host effect or starve the next diff.
 */
function diffAndApplyCustomFormulas(
  backend: { registerCustomFormula?: (n: string, s: string) => Promise<void> },
  prev: ReadonlyMap<string, CustomFormulaRegistration>,
  next: ReadonlyMap<string, CustomFormulaRegistration>,
): void {
  if (!backend.registerCustomFormula) return
  const unregister = (backend as {
    unregisterCustomFormula?: (n: string) => Promise<void>
  }).unregisterCustomFormula
  // Removals.
  for (const name of prev.keys()) {
    if (!next.has(name)) {
      void unregister?.(name)?.catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[customFormulas] unregister ${name} failed`, err)
      })
    }
  }
  // Adds + replaces.
  for (const [name, entry] of next) {
    const before = prev.get(name)
    const changed =
      !before ||
      before.source !== entry.source ||
      before.description !== entry.description ||
      // Cheap shallow compare; registrations replacing solely the label
      // list still reinstall (intentional — labels feed IntelliSense
      // which may eventually reach the worker).
      (before.paramLabels?.join('|') ?? '') !== (entry.paramLabels?.join('|') ?? '')
    if (!changed) continue
    if (before && unregister) {
      void unregister(name)
        .then(() => backend.registerCustomFormula!(name, entry.source))
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(`[customFormulas] re-register ${name} failed`, err)
        })
      continue
    }
    void backend.registerCustomFormula(name, entry.source).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(`[customFormulas] register ${name} failed`, err)
    })
  }
}

export function SpreadsheetUiProvider(props: SpreadsheetUiProviderProps) {
  const core = createSpreadsheetUi({
    backend: props.backend,
    store: props.store ?? createStore(),
  })
  core.store.setter(spreadsheetBackendAtom, props.backend)

  // Wave 8 — custom-formula registry bridge. The backend may omit the
  // port entirely (static backend, legacy hosts); in that case the
  // diff helper is a no-op so registry writes still succeed against
  // the atom but do not reach the worker. Subscription is on the core
  // store directly (not via a Solid `createEffect`) so the listener
  // runs once per atom change regardless of which consumer is mounted.
  let prev: ReadonlyMap<string, CustomFormulaRegistration> = new Map()
  const unsubscribe = core.store.sub(customFormulaRegistryAtom, () => {
    const next = core.store.getter(customFormulaRegistryAtom)
    diffAndApplyCustomFormulas(props.backend, prev, next)
    prev = next
  })
  // Prime once so registrations done BEFORE mount (e.g. seeded by a
  // demo's `onMount` racing the subscription) still propagate.
  const initial = core.store.getter(customFormulaRegistryAtom)
  if (initial.size > 0) {
    diffAndApplyCustomFormulas(props.backend, prev, initial)
    prev = initial
  }
  onCleanup(() => {
    unsubscribe()
    // Tear down everything currently installed so a re-mounted
    // provider does not see stale registrations on the worker.
    if (props.backend.unregisterCustomFormula) {
      for (const name of prev.keys()) {
        void props.backend.unregisterCustomFormula(name).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(`[customFormulas] cleanup unregister ${name} failed`, err)
        })
      }
    }
  })

  return (
    <SolidProvider store={core.store}>
      <SpreadsheetUiContext.Provider value={core}>{props.children}</SpreadsheetUiContext.Provider>
    </SolidProvider>
  )
}
