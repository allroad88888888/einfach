/**
 * Wave F / F1 — Information functions.
 *
 * Inspects a Value's *kind* to report what it is. These functions are
 * the **only family in the entire built-in set** that does NOT propagate
 * errors — an error arg is just another shape to classify, exactly like
 * Excel:
 *
 *   ISERROR(1/0)   → TRUE     (it's an error, that's the answer)
 *   ISNUMBER(#N/A) → FALSE    (it's not a number — kind says so)
 *
 * That asymmetry means we deliberately do **not** call `propagateError`
 * anywhere in this file. Every helper accepts `kind: 'error'` as one of
 * the possible inputs and classifies it.
 *
 * Functions: ISNUMBER, ISTEXT, ISBLANK, ISLOGICAL, ISERROR, ISERR, ISNA,
 *            TYPE.
 *
 * Reference: Microsoft Office spec for IS* family + TYPE.
 *   https://support.microsoft.com/en-us/office/is-functions-0f2d7971-6019-40a0-a171-f2d869135665
 *   https://support.microsoft.com/en-us/office/type-function-45b4e688-4bc3-48b3-a105-ffa892995899
 */

import type { FunctionImpl, Value } from '../../types'

const BOOL = (b: boolean): Value => ({ kind: 'boolean', value: b })
const NUM = (n: number): Value => ({ kind: 'number', value: n })
const ERR_VALUE = (): Value => ({ kind: 'error', code: '#VALUE!' })

/**
 * Excel's IS* family treats the canonical 1-arg shape strictly. Excess
 * args yield `#VALUE!`. Zero args also yields `#VALUE!` (Excel's formula
 * bar refuses parse, but a built-AST path lands here).
 */
function arity1Check(args: ReadonlyArray<Value>): Value | undefined {
  if (args.length !== 1) return ERR_VALUE()
  return undefined
}

export const ISNUMBER: FunctionImpl = (args) => {
  const e = arity1Check(args)
  if (e) return e
  return BOOL(args[0].kind === 'number')
}

export const ISTEXT: FunctionImpl = (args) => {
  const e = arity1Check(args)
  if (e) return e
  return BOOL(args[0].kind === 'string')
}

export const ISBLANK: FunctionImpl = (args) => {
  const e = arity1Check(args)
  if (e) return e
  return BOOL(args[0].kind === 'blank')
}

export const ISLOGICAL: FunctionImpl = (args) => {
  const e = arity1Check(args)
  if (e) return e
  return BOOL(args[0].kind === 'boolean')
}

/**
 * ISERROR — TRUE for any error code (including `#N/A`). Catch-all
 * counterpart of ISERR.
 */
export const ISERROR: FunctionImpl = (args) => {
  const e = arity1Check(args)
  if (e) return e
  return BOOL(args[0].kind === 'error')
}

/**
 * ISERR — TRUE for any error EXCEPT `#N/A`. Used in legacy formulas
 * that want to special-case "not found" lookups vs other failures.
 */
export const ISERR: FunctionImpl = (args) => {
  const e = arity1Check(args)
  if (e) return e
  const v = args[0]
  return BOOL(v.kind === 'error' && v.code !== '#N/A')
}

/**
 * ISNA — TRUE only for `#N/A`. Mirror of ISERR.
 */
export const ISNA: FunctionImpl = (args) => {
  const e = arity1Check(args)
  if (e) return e
  const v = args[0]
  return BOOL(v.kind === 'error' && v.code === '#N/A')
}

/**
 * TYPE — Excel's numeric kind tag.
 *   1  = number
 *   2  = text
 *   4  = logical (boolean)
 *  16  = error
 *  64  = array
 *   0  = blank  (this is einfach-ts addition; Excel returns 1 for
 *               blank because it coerces blank → 0 → number. We diverge
 *               for diagnostic clarity. TODO(F1): consider matching
 *               Excel verbatim if any user-visible test demands it.)
 */
export const TYPE: FunctionImpl = (args) => {
  const e = arity1Check(args)
  if (e) return e
  const v = args[0]
  switch (v.kind) {
    case 'number':
      return NUM(1)
    case 'string':
      return NUM(2)
    case 'boolean':
      return NUM(4)
    case 'error':
      return NUM(16)
    case 'array':
      return NUM(64)
    case 'blank':
      return NUM(0)
  }
}

// =============================================================================
// Registry
// =============================================================================

export const FUNCTIONS: Record<string, FunctionImpl> = {
  ISNUMBER,
  ISTEXT,
  ISBLANK,
  ISLOGICAL,
  ISERROR,
  ISERR,
  ISNA,
  TYPE,
}
