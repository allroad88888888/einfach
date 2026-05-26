/**
 * Value ↔ scalar coercion helpers.
 *
 * Excel coercion rules (the subset we need for Wave B/B2 arithmetic +
 * comparison + concat):
 *
 *  - `blank`   → `0` in arithmetic, `""` in concat, `false` in boolean.
 *  - `number`  → itself.
 *  - `string`  → parsed as number when it looks numeric; otherwise
 *                `#VALUE!`. Special-case `"TRUE"` / `"FALSE"` for boolean.
 *  - `boolean` → `1` / `0` in arithmetic, `"TRUE"` / `"FALSE"` in concat.
 *  - `error`   → propagates; callers should use `propagateError` before
 *                attempting coercion.
 *  - `array`   → not coerced here; binary ops on arrays will be handled in
 *                Wave E (spill / range broadcast). Returning a `#VALUE!`
 *                envelope is correct for v1.
 *
 * Every helper is total — returns either the desired primitive (wrapped
 * in `{ ok: true, value }`) or a `Value` error envelope. Callers thread
 * the error verbatim, preserving the Excel "first-error-wins" rule.
 */

import type { Value } from '../types'

export interface CoerceOk<T> {
  readonly ok: true
  readonly value: T
}

export interface CoerceErr {
  readonly ok: false
  readonly error: Value & { kind: 'error' }
}

export type CoerceResult<T> = CoerceOk<T> | CoerceErr

const ok = <T>(value: T): CoerceOk<T> => ({ ok: true, value })
const err = (error: Value & { kind: 'error' }): CoerceErr => ({ ok: false, error })

/**
 * Returns the first `kind: 'error'` value in `args`, or `undefined` if
 * none. Used by the evaluator's binary/unary ops and by function impls
 * that opt into the default error-short-circuit behavior.
 */
export function propagateError(args: ReadonlyArray<Value>): (Value & { kind: 'error' }) | undefined {
  for (const a of args) {
    if (a.kind === 'error') return a
  }
  return undefined
}

/**
 * Coerce a `Value` to a JS `number` using Excel arithmetic rules.
 *
 * - `blank` → 0
 * - `number` → itself
 * - `boolean` → 1 / 0
 * - `string` → `Number(trimmed)` if finite; else `#VALUE!`
 * - `error` → propagated (caller should have short-circuited already)
 * - `array` → top-left scalar coerced recursively; empty array → `#VALUE!`
 */
export function toNumber(v: Value): CoerceResult<number> {
  switch (v.kind) {
    case 'blank':
      return ok(0)
    case 'number':
      return ok(v.value)
    case 'boolean':
      return ok(v.value ? 1 : 0)
    case 'string': {
      const trimmed = v.value.trim()
      if (trimmed.length === 0) return err({ kind: 'error', code: '#VALUE!' })
      const n = Number(trimmed)
      if (!Number.isFinite(n)) return err({ kind: 'error', code: '#VALUE!' })
      return ok(n)
    }
    case 'error':
      return err(v)
    case 'array': {
      const row = v.value[0]
      if (!row || row.length === 0) return err({ kind: 'error', code: '#VALUE!' })
      return toNumber(row[0])
    }
  }
}

/**
 * Coerce a `Value` to a JS `string` for concat / TEXT-like contexts.
 *
 * - `blank` → ""
 * - `string` → itself
 * - `number` → JS `String(n)` (Wave C TEXT() handles number-format).
 * - `boolean` → "TRUE" / "FALSE"
 * - `error` → propagates
 * - `array` → top-left scalar
 */
export function toString(v: Value): CoerceResult<string> {
  switch (v.kind) {
    case 'blank':
      return ok('')
    case 'string':
      return ok(v.value)
    case 'number':
      return ok(String(v.value))
    case 'boolean':
      return ok(v.value ? 'TRUE' : 'FALSE')
    case 'error':
      return err(v)
    case 'array': {
      const row = v.value[0]
      if (!row || row.length === 0) return err({ kind: 'error', code: '#VALUE!' })
      return toString(row[0])
    }
  }
}

/**
 * Coerce a `Value` to a JS `boolean` for IF / AND / OR contexts.
 *
 * - `blank` → false
 * - `boolean` → itself
 * - `number` → `n !== 0`
 * - `string` → "TRUE" / "FALSE" case-insensitive; else `#VALUE!`
 * - `error` → propagates
 * - `array` → top-left scalar
 */
export function toBoolean(v: Value): CoerceResult<boolean> {
  switch (v.kind) {
    case 'blank':
      return ok(false)
    case 'boolean':
      return ok(v.value)
    case 'number':
      return ok(v.value !== 0)
    case 'string': {
      const u = v.value.trim().toUpperCase()
      if (u === 'TRUE') return ok(true)
      if (u === 'FALSE') return ok(false)
      return err({ kind: 'error', code: '#VALUE!' })
    }
    case 'error':
      return err(v)
    case 'array': {
      const row = v.value[0]
      if (!row || row.length === 0) return err({ kind: 'error', code: '#VALUE!' })
      return toBoolean(row[0])
    }
  }
}
