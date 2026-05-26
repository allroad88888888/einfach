import { atom } from '@einfach/core'
import { FORMULA_FUNCTION_SPECS } from '../formula-functions'
import type {
  CustomFormulaNameValidation,
  CustomFormulaNameValidationReason,
  CustomFormulaRegistration,
} from './types'

export * from './types'

const NAME_REGEX = /^[A-Z][A-Z0-9_.]*$/

/**
 * Set of built-in formula names that user code cannot redefine. Built
 * from the seed registry so it stays in sync as the static spec list
 * grows. NOT an exhaustive list of every WASM-side function (the Rust
 * engine ships hundreds), but it covers the names IntelliSense surfaces.
 * Shadowing a Rust-only function not in this list will succeed at
 * register time and silently be overridden on the WASM side; that is
 * Excel-compatible behaviour (last registration wins).
 */
export const BUILTIN_FORMULA_NAMES: ReadonlySet<string> = new Set(
  FORMULA_FUNCTION_SPECS.map((spec) => spec.name),
)

/**
 * Validate a candidate custom-formula name. Returns a structured result
 * so hosts can map the reason to a localized error without parsing
 * free-text. Callers that want to throw on invalid names should compose
 * this helper with the `registerCustomFormulaAtom` write atom — the
 * write atom uses this internally and throws if the result is not ok.
 */
export function validateCustomFormulaName(name: string): CustomFormulaNameValidation {
  if (!name || name.length === 0) {
    return { ok: false, reason: 'name-empty' }
  }
  if (!NAME_REGEX.test(name)) {
    return { ok: false, reason: 'name-format' }
  }
  if (BUILTIN_FORMULA_NAMES.has(name)) {
    return { ok: false, reason: 'name-shadows-builtin' }
  }
  return { ok: true }
}

/**
 * Source atom: map of registered custom formulas keyed by uppercase
 * name. ReadonlyMap value type prevents accidental in-place mutation by
 * consumers; the registry is rebuilt fresh on every write. Bounded by
 * the host (no per-cell families) — practical caps are in the hundreds
 * for typical workbooks.
 *
 * Solid hosts subscribe to this atom (or its derivations) and diff it
 * against the previously-installed set to drive
 * `backend.registerCustomFormula` / `unregisterCustomFormula` calls.
 */
export const customFormulaRegistryAtom = atom<ReadonlyMap<string, CustomFormulaRegistration>>(
  new Map(),
)
customFormulaRegistryAtom.debugLabel = 'spreadsheet.customFormulas.registry'

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
  (get, set, reg: CustomFormulaRegistration) => {
    const validation = validateCustomFormulaName(reg.name)
    if (!validation.ok) {
      throw new Error(describeNameError(validation.reason, reg.name))
    }
    const current = get(customFormulaRegistryAtom)
    const next = new Map(current)
    next.set(reg.name, {
      name: reg.name,
      source: reg.source,
      ...(reg.description !== undefined ? { description: reg.description } : {}),
      ...(reg.paramLabels !== undefined ? { paramLabels: [...reg.paramLabels] } : {}),
    })
    set(customFormulaRegistryAtom, next)
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
  (get, set, name: string) => {
    const current = get(customFormulaRegistryAtom)
    if (!current.has(name)) return
    const next = new Map(current)
    next.delete(name)
    set(customFormulaRegistryAtom, next)
  },
)
unregisterCustomFormulaAtom.debugLabel = 'spreadsheet.customFormulas.unregister'
