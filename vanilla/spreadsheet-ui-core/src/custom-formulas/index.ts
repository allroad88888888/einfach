import { atom } from '@einfach/core'
import { FORMULA_FUNCTION_SPECS } from '../formula-functions'
import { ENGINE_BUILTIN_FORMULA_NAMES } from './engine-builtin-names'
import type {
  CustomFormulaNameValidation,
  CustomFormulaNameValidationReason,
  CustomFormulaRegistration,
  CustomFormulaRegistryLifecycle,
  CustomFormulaRegistryStatus,
  ConfigureCustomFormulaRegistryOutcome,
  DisposeCustomFormulaRegistryOutcome,
  RegisterCustomFormulaOutcome,
  ResetCustomFormulaRegistryOutcome,
  UnregisterCustomFormulaOutcome,
} from './types'

export * from './types'
export { ENGINE_BUILTIN_FORMULA_NAMES } from './engine-builtin-names'

const NAME_REGEX = /^[A-Z][A-Z0-9_.]*$/

/** Default workbook-level registry cap. Hosts may lower or raise it explicitly. */
export const DEFAULT_CUSTOM_FORMULA_REGISTRY_MAX_ENTRIES = 256

/**
 * Hard safety ceiling for the configurable cap. This keeps the long-lived
 * registry genuinely bounded even when host configuration comes from user data.
 */
export const MAX_CUSTOM_FORMULA_REGISTRY_ENTRIES = 10_000

/**
 * Set of built-in formula names that user code cannot redefine.
 *
 * Built from the union of:
 *   1. `ENGINE_BUILTIN_FORMULA_NAMES` — the authoritative mirror of the
 *      Rust engine's `is_builtin_function_name` arms (see
 *      `scripts/extract-builtin-names.mjs`). Covers every name the
 *      WASM evaluator would dispatch to a built-in arm, including
 *      `LAMBDA`, `LET`, `IFERROR`, `XLOOKUP`, `MAP`, `REDUCE`, etc.
 *      that the IntelliSense seed registry does not surface.
 *   2. `FORMULA_FUNCTION_SPECS` — the IntelliSense seed registry. The
 *      Rust mirror should already include every name here, but we
 *      union both so a forgotten extraction never reopens a shadowing
 *      hole.
 *
 * Normalizes to upper-case so callers can use either case in lookups.
 */
export const BUILTIN_FORMULA_NAMES: ReadonlySet<string> = new Set([
  ...ENGINE_BUILTIN_FORMULA_NAMES.map((n) => n.toUpperCase()),
  ...FORMULA_FUNCTION_SPECS.map((spec) => spec.name.toUpperCase()),
])

/**
 * Normalize a candidate custom-formula name to the canonical upper-case
 * form used by both the engine and the registry. Trim incidental
 * whitespace so hosts that bind to a text input get the expected match
 * semantics without filtering at every call site.
 */
function normalizeCustomFormulaName(name: string): string {
  return name.trim().toUpperCase()
}

/**
 * Validate a candidate custom-formula name. Returns a structured result
 * so hosts can map the reason to a localized error without parsing
 * free-text. Callers that want to throw on invalid names should compose
 * this helper with the `registerCustomFormulaAtom` write atom — the
 * write atom uses this internally and throws if the result is not ok.
 */
export function validateCustomFormulaName(name: string): CustomFormulaNameValidation {
  if (name === null || name === undefined) {
    return { ok: false, reason: 'name-empty' }
  }
  // Validate the AS-WRITTEN spelling against the format rule so
  // lower-case / mixed-case names surface a `name-format` error
  // (Excel-style upper-case required). The shadow check runs on the
  // normalized form so a lower-case `'sum'` and an upper-case `'SUM'`
  // both reject the same way.
  if (name.length === 0) {
    return { ok: false, reason: 'name-empty' }
  }
  if (!NAME_REGEX.test(name)) {
    return { ok: false, reason: 'name-format' }
  }
  if (BUILTIN_FORMULA_NAMES.has(normalizeCustomFormulaName(name))) {
    return { ok: false, reason: 'name-shadows-builtin' }
  }
  return { ok: true }
}

interface CustomFormulaRegistryState {
  readonly status: CustomFormulaRegistryStatus
  readonly maxEntries: number
  readonly entries: ReadonlyMap<string, CustomFormulaRegistration>
}

const INITIAL_CUSTOM_FORMULA_REGISTRY_STATE: CustomFormulaRegistryState = Object.freeze({
  status: 'active',
  maxEntries: DEFAULT_CUSTOM_FORMULA_REGISTRY_MAX_ENTRIES,
  entries: new Map<string, CustomFormulaRegistration>(),
})

/** Private aggregate prevents callers from bypassing capacity or lifecycle commands. */
const customFormulaRegistryStateAtom = atom<CustomFormulaRegistryState>(
  INITIAL_CUSTOM_FORMULA_REGISTRY_STATE,
)
customFormulaRegistryStateAtom.debugLabel = 'spreadsheet.customFormulas.internal.registryState'

/**
 * Read-only projection of registered custom formulas keyed by uppercase name.
 * Each write publishes a fresh map, so subscribers can diff snapshots safely.
 */
export const customFormulaRegistryAtom = atom((get) => get(customFormulaRegistryStateAtom).entries)
customFormulaRegistryAtom.debugLabel = 'spreadsheet.customFormulas.registry'

/** Public lifecycle/capacity projection for host UI and diagnostics. */
export const customFormulaRegistryLifecycleAtom = atom((get): CustomFormulaRegistryLifecycle => {
  const state = get(customFormulaRegistryStateAtom)
  return Object.freeze({
    status: state.status,
    maxEntries: state.maxEntries,
    size: state.entries.size,
  })
})
customFormulaRegistryLifecycleAtom.debugLabel = 'spreadsheet.customFormulas.lifecycle'

/**
 * Configure the per-workbook cap before teardown. Invalid limits and limits
 * below the current size reject explicitly; existing entries are never evicted.
 */
export const configureCustomFormulaRegistryAtom = atom(
  null,
  (get, set, maxEntries: number): ConfigureCustomFormulaRegistryOutcome => {
    const current = get(customFormulaRegistryStateAtom)
    if (current.status !== 'active') {
      return {
        outcome: 'rejected',
        reason: 'registry-disposed',
        maxEntries,
        currentSize: current.entries.size,
      }
    }
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 0 ||
      maxEntries > MAX_CUSTOM_FORMULA_REGISTRY_ENTRIES
    ) {
      return {
        outcome: 'rejected',
        reason: 'invalid-limit',
        maxEntries,
        currentSize: current.entries.size,
      }
    }
    if (maxEntries < current.entries.size) {
      return {
        outcome: 'rejected',
        reason: 'limit-below-current-size',
        maxEntries,
        currentSize: current.entries.size,
      }
    }
    if (maxEntries !== current.maxEntries) {
      set(customFormulaRegistryStateAtom, { ...current, maxEntries })
    }
    return { outcome: 'configured', maxEntries }
  },
)
configureCustomFormulaRegistryAtom.debugLabel = 'spreadsheet.customFormulas.configure'

function describeNameError(reason: CustomFormulaNameValidationReason, name: string): string {
  switch (reason) {
    case 'name-empty':
      return 'custom formula name cannot be empty'
    case 'name-format':
      return `custom formula name "${name}" must match /^[A-Z][A-Z0-9_.]*$/`
    case 'name-shadows-builtin':
      return `custom formula name "${name}" shadows a built-in`
  }
}

/**
 * Command atom: register or replace a custom formula by name.
 *
 * Excel semantics — last registration wins; re-registering an existing
 * name silently replaces the previous source / metadata. Throws if the
 * name fails `validateCustomFormulaName` so hosts surface bad inputs at
 * the call site rather than letting them leak into the worker.
 */
export const registerCustomFormulaAtom = atom(
  null,
  (get, set, reg: CustomFormulaRegistration): RegisterCustomFormulaOutcome => {
    const current = get(customFormulaRegistryStateAtom)
    const requestedName = typeof reg.name === 'string' ? normalizeCustomFormulaName(reg.name) : ''
    if (current.status !== 'active') {
      return {
        outcome: 'rejected',
        reason: 'registry-disposed',
        name: requestedName,
        size: current.entries.size,
        maxEntries: current.maxEntries,
      }
    }
    const validation = validateCustomFormulaName(reg.name)
    if (!validation.ok) {
      throw new Error(describeNameError(validation.reason, reg.name))
    }
    // Normalize on the way in so lookups, replaces, and unregisters
    // hit the same key the WASM engine uses (case-insensitive,
    // canonical upper-case). Without this a lower-case unregister
    // would silently leak the upper-case entry on the worker.
    const key = requestedName
    const replacing = current.entries.has(key)
    if (!replacing && current.entries.size >= current.maxEntries) {
      return {
        outcome: 'rejected',
        reason: 'capacity-reached',
        name: key,
        size: current.entries.size,
        maxEntries: current.maxEntries,
      }
    }
    const next = new Map(current.entries)
    next.set(key, {
      name: key,
      source: reg.source,
      ...(reg.isAsync !== undefined ? { isAsync: reg.isAsync } : {}),
      ...(reg.description !== undefined ? { description: reg.description } : {}),
      ...(reg.paramLabels !== undefined ? { paramLabels: [...reg.paramLabels] } : {}),
    })
    set(customFormulaRegistryStateAtom, { ...current, entries: next })
    return {
      outcome: replacing ? 'replaced' : 'registered',
      name: key,
      size: next.size,
    }
  },
)
registerCustomFormulaAtom.debugLabel = 'spreadsheet.customFormulas.register'

/**
 * Command atom: unregister a custom formula by name. No-op if the name
 * is not currently registered (mirrors `Map.delete` semantics) so hosts
 * can call this defensively on cleanup without checking existence first.
 */
export const unregisterCustomFormulaAtom = atom(
  null,
  (get, set, name: string): UnregisterCustomFormulaOutcome => {
    // Mirror the register-side normalization. Hosts that bind to a
    // user-typed input may pass `'mytax'` here even though the engine
    // (and the registry map) keys on `'MYTAX'`; without normalization
    // the unregister would silently no-op and leak the entry on the
    // worker.
    const current = get(customFormulaRegistryStateAtom)
    const requestedName =
      name === null || name === undefined ? '' : normalizeCustomFormulaName(name)
    if (current.status !== 'active') {
      return {
        outcome: 'rejected',
        reason: 'registry-disposed',
        name: requestedName,
        size: current.entries.size,
      }
    }
    if (name === null || name === undefined) {
      return { outcome: 'not-found', name: requestedName, size: current.entries.size }
    }
    const key = normalizeCustomFormulaName(name)
    if (!current.entries.has(key)) {
      return { outcome: 'not-found', name: key, size: current.entries.size }
    }
    const next = new Map(current.entries)
    next.delete(key)
    set(customFormulaRegistryStateAtom, { ...current, entries: next })
    return { outcome: 'removed', name: key, size: next.size }
  },
)
unregisterCustomFormulaAtom.debugLabel = 'spreadsheet.customFormulas.unregister'

/**
 * Clear the active workbook registry while preserving its configured cap.
 * Reset stays active so the same workbook store can accept a fresh registry.
 */
export const resetCustomFormulaRegistryAtom = atom(
  null,
  (get, set): ResetCustomFormulaRegistryOutcome => {
    const current = get(customFormulaRegistryStateAtom)
    if (current.status === 'disposed') {
      return { outcome: 'rejected', reason: 'registry-disposed', clearedEntries: 0 }
    }
    const clearedEntries = current.entries.size
    set(customFormulaRegistryStateAtom, {
      ...current,
      entries: new Map<string, CustomFormulaRegistration>(),
    })
    return { outcome: 'reset', clearedEntries }
  },
)
resetCustomFormulaRegistryAtom.debugLabel = 'spreadsheet.customFormulas.reset'

/** Terminal teardown: clears entries and rejects all later mutation commands. */
export const disposeCustomFormulaRegistryAtom = atom(
  null,
  (get, set): DisposeCustomFormulaRegistryOutcome => {
    const current = get(customFormulaRegistryStateAtom)
    if (current.status === 'disposed') {
      return { outcome: 'already-disposed', clearedEntries: 0 }
    }
    const clearedEntries = current.entries.size
    set(customFormulaRegistryStateAtom, {
      ...current,
      status: 'disposed',
      entries: new Map<string, CustomFormulaRegistration>(),
    })
    return { outcome: 'disposed', clearedEntries }
  },
)
disposeCustomFormulaRegistryAtom.debugLabel = 'spreadsheet.customFormulas.dispose'
