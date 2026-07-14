import { atom } from '@einfach/core'
import { FORMULA_FUNCTION_SPECS } from '../formula-functions'
import { ENGINE_BUILTIN_FORMULA_NAMES } from './engine-builtin-names'
import type {
  CustomFormulaNameValidation,
  CustomFormulaNameValidationReason,
  CustomFormulaRegistration,
} from './types'

export * from './types'
export { ENGINE_BUILTIN_FORMULA_NAMES } from './engine-builtin-names'

const NAME_REGEX = /^[A-Z][A-Z0-9_.]*$/

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
    // Normalize on the way in so lookups, replaces, and unregisters
    // hit the same key the WASM engine uses (case-insensitive,
    // canonical upper-case). Without this a lower-case unregister
    // would silently leak the upper-case entry on the worker.
    const key = normalizeCustomFormulaName(reg.name)
    const current = get(customFormulaRegistryAtom)
    const next = new Map(current)
    next.set(key, {
      name: key,
      source: reg.source,
      ...(reg.isAsync !== undefined ? { isAsync: reg.isAsync } : {}),
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
    // Mirror the register-side normalization. Hosts that bind to a
    // user-typed input may pass `'mytax'` here even though the engine
    // (and the registry map) keys on `'MYTAX'`; without normalization
    // the unregister would silently no-op and leak the entry on the
    // worker.
    if (name === null || name === undefined) return
    const key = normalizeCustomFormulaName(name)
    const current = get(customFormulaRegistryAtom)
    if (!current.has(key)) return
    const next = new Map(current)
    next.delete(key)
    set(customFormulaRegistryAtom, next)
  },
)
unregisterCustomFormulaAtom.debugLabel = 'spreadsheet.customFormulas.unregister'
