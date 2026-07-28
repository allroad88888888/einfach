/**
 * Wave B/B2 evaluator entry point.
 *
 * Re-exports the public surface of the evaluator subdir so callers can
 * `import { evaluate, toNumber, propagateError } from '../eval'` rather
 * than reaching into individual files.
 */

export { evaluate, parseRefToKey, parseRefToCoord, refLookupGeneric, rangeLookupGeneric } from './evaluate'
export { toNumber, toString, toBoolean, propagateError } from './coerce'
// Also re-export `toString` under a non-shadowing alias so package root can
// expose it without colliding with `Object.toString`.
export { toString as valueToString } from './coerce'
export type { CoerceResult, CoerceOk, CoerceErr } from './coerce'
