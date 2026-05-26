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
 * One unit of work to forward to the backend. The worker effect
 * computes a queue of these from the prev/next diff, then awaits them
 * in order — `prev` only advances when the queue settles, so a failed
 * registration replays on the next diff instead of silently sticking
 * the UI and worker out of sync.
 */
type CustomFormulaOp =
  | { kind: 'unregister'; name: string }
  | { kind: 'register'; name: string; entry: CustomFormulaRegistration }
  | { kind: 'replace'; name: string; entry: CustomFormulaRegistration }

function diffCustomFormulas(
  prev: ReadonlyMap<string, CustomFormulaRegistration>,
  next: ReadonlyMap<string, CustomFormulaRegistration>,
): CustomFormulaOp[] {
  const ops: CustomFormulaOp[] = []
  // Removals first so a same-tick re-register (replace) is not
  // shadowed by a still-pending add for a name that just left.
  for (const name of prev.keys()) {
    if (!next.has(name)) ops.push({ kind: 'unregister', name })
  }
  for (const [name, entry] of next) {
    const before = prev.get(name)
    if (!before) {
      ops.push({ kind: 'register', name, entry })
      continue
    }
    const changed =
      before.source !== entry.source ||
      before.description !== entry.description ||
      // Cheap shallow compare; registrations replacing solely the label
      // list still reinstall (intentional — labels feed IntelliSense
      // which may eventually reach the worker).
      (before.paramLabels?.join('|') ?? '') !== (entry.paramLabels?.join('|') ?? '')
    if (changed) ops.push({ kind: 'replace', name, entry })
  }
  return ops
}

/**
 * Apply a queue of custom-formula ops to the backend, tracking which
 * ones actually succeeded. Returns the set of names whose final state
 * now matches `nextSnapshot`; the caller uses this to advance its
 * `installed` baseline. Per-op try/catch so a single failure doesn't
 * poison the rest of the batch.
 *
 * `signal` short-circuits the in-flight queue if the provider unmounts
 * or a newer diff supersedes this batch; the partial result is still
 * returned so we record what DID get installed before the abort.
 */
async function applyCustomFormulaOps(
  backend: {
    registerCustomFormula?: (n: string, s: string) => Promise<void>
    unregisterCustomFormula?: (n: string) => Promise<void>
  },
  ops: readonly CustomFormulaOp[],
  nextSnapshot: ReadonlyMap<string, CustomFormulaRegistration>,
  installed: Map<string, CustomFormulaRegistration>,
  signal: AbortSignal,
): Promise<void> {
  if (!backend.registerCustomFormula) return
  const register = backend.registerCustomFormula
  const unregister = backend.unregisterCustomFormula
  for (const op of ops) {
    if (signal.aborted) return
    try {
      if (op.kind === 'unregister') {
        if (unregister) {
          await unregister(op.name)
        }
        installed.delete(op.name)
      } else if (op.kind === 'register') {
        await register(op.name, op.entry.source)
        installed.set(op.name, nextSnapshot.get(op.name) ?? op.entry)
      } else {
        // replace = unregister-then-register so the worker recompiles
        // the fresh source. If the unregister succeeds but the
        // register throws we mark the slot as gone (not stale source)
        // so the next diff re-installs from scratch.
        if (unregister) {
          await unregister(op.name)
          installed.delete(op.name)
          if (signal.aborted) return
        }
        await register(op.name, op.entry.source)
        installed.set(op.name, nextSnapshot.get(op.name) ?? op.entry)
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[customFormulas] ${op.kind} ${op.name} failed`, err)
      // Leave `installed` unchanged for register failures so the next
      // diff will see the slot as still-needing-install and retry.
    }
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
  //
  // `installed` mirrors what the WORKER currently has (advanced only
  // after each op settles). `inflight` is the AbortController for the
  // batch we're awaiting; a new registry mutation aborts the prior
  // batch and starts a fresh one with the up-to-date snapshot, so
  // stale source can't reinstall after a quick unregister/register
  // toggle.
  const installed = new Map<string, CustomFormulaRegistration>()
  let inflight: AbortController | null = null
  let chain: Promise<void> = Promise.resolve()

  function scheduleDiff(): void {
    inflight?.abort()
    const controller = new AbortController()
    inflight = controller
    const next = core.store.getter(customFormulaRegistryAtom)
    // Snapshot `installed` at scheduling time so the diff sees a
    // stable baseline even if a still-in-flight prior batch is racing.
    const baseline = new Map(installed)
    const ops = diffCustomFormulas(baseline, next)
    if (ops.length === 0) return
    chain = chain.then(async () => {
      if (controller.signal.aborted) return
      await applyCustomFormulaOps(props.backend, ops, next, installed, controller.signal)
    })
    // Surface unexpected rejections (per-op errors are already caught
    // inside applyCustomFormulaOps; this guards the wrapper itself).
    void chain.catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[customFormulas] batch failed', err)
    })
  }

  const unsubscribe = core.store.sub(customFormulaRegistryAtom, scheduleDiff)
  // Prime once so registrations done BEFORE mount (e.g. seeded by a
  // demo's `onMount` racing the subscription) still propagate.
  if (core.store.getter(customFormulaRegistryAtom).size > 0) {
    scheduleDiff()
  }
  onCleanup(() => {
    unsubscribe()
    inflight?.abort()
    inflight = null
    // Tear down everything currently installed so a re-mounted
    // provider does not see stale registrations on the worker. Chain
    // after `chain` so we don't race a still-pending batch into the
    // teardown — any in-flight ops have been aborted above so the
    // chain settles quickly.
    const unregister = props.backend.unregisterCustomFormula
    if (!unregister) return
    const cleanupController = new AbortController()
    const snapshot = Array.from(installed.keys())
    void chain
      .catch(() => undefined)
      .then(async () => {
        for (const name of snapshot) {
          if (cleanupController.signal.aborted) return
          try {
            await unregister(name)
            installed.delete(name)
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[customFormulas] cleanup unregister ${name} failed`, err)
          }
        }
      })
  })

  return (
    <SolidProvider store={core.store}>
      <SpreadsheetUiContext.Provider value={core}>{props.children}</SpreadsheetUiContext.Provider>
    </SolidProvider>
  )
}
