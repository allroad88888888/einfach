/**
 * Internal shared helpers for bounded async operations that cross the
 * host-adapter boundary (editing, history, paste-special, remove-duplicates,
 * data-validation, conditional-formatting, filter-sort, comments).
 *
 * Every caller that needs acknowledgement hardening currently carries its
 * own copy of `snapshotAcknowledgement`.  This module provides the
 * canonical implementation so the eight copies can be deduplicated.
 *
 * ## Non-export contract
 *
 * This module lives under `src/internal/` and is NOT reachable from the
 * public `index.ts` barrel.  It is an implementation detail — the
 * `snapshotAcknowledgement` shape is caller-parameterised and would be a
 * leaky abstraction if exposed as a public API.
 */

// ---------------------------------------------------------------------------
// 1.  Acknowledgement snapshot (7 × dedup target)
// ---------------------------------------------------------------------------

/**
 * An opaque, frozen, read-once dispatch-safety layer.  Callers use this to
 * prove that a back-channel acknowledgement (read from `getter` after the
 * async boundary) still matches the request that was dispatched.
 *
 * The generic `TTicket` owns the session / operation identity and the
 * expected request shape.  `TSpec` defines the concrete snapshot members.
 */
export interface AcknowledgementSnapshot<TSpec extends Record<string, unknown>> {
  readonly kind: 'applied' | 'not-applied' | 'malformed'
  readonly spec: Readonly<TSpec> | null
}

/**
 * Read the entire caller-owned acknowledgement boundary exactly once
 * before making any decision.
 *
 * - `applied: true`  → `{ kind: 'applied', spec }`
 * - `applied: false` → `{ kind: 'not-applied', spec }` (only when the
 *   backend positively confirmed it did NOT mutate)
 * - everything else  → `{ kind: 'malformed', spec: null }`
 */
export function snapshotAcknowledgement<
  TTicket extends { readonly requestId: number; readonly timeoutMs: number },
  TSpec extends Record<string, unknown>,
>(
  acknowledgement: unknown,
  ticket: TTicket,
  extractSpec: (ack: Record<string, unknown>) => TSpec | null,
): AcknowledgementSnapshot<TSpec> {
  if (typeof acknowledgement !== 'object' || acknowledgement === null) {
    return Object.freeze({ kind: 'malformed', spec: null }) as AcknowledgementSnapshot<TSpec>
  }

  const ack = acknowledgement as Record<string, unknown>

  // Positive proof the backend DID apply this exact request.
  if (isAppliedAck(ack, ticket)) {
    const spec = extractSpec(ack)
    if (spec === null) {
      return Object.freeze({ kind: 'malformed', spec: null }) as AcknowledgementSnapshot<TSpec>
    }
    return Object.freeze({ kind: 'applied', spec })
  }

  // Positive proof the backend did NOT apply — correlated to the exact
  // request, so it is a structured failure rather than a ghost response.
  if (isNotAppliedAck(ack, ticket)) {
    return Object.freeze({ kind: 'not-applied', spec: null }) as AcknowledgementSnapshot<TSpec>
  }

  // Anything else: timed-out promise, unparseable reply, or a reply from a
  // different request — all collapse to 'malformed'.
  return Object.freeze({ kind: 'malformed', spec: null }) as AcknowledgementSnapshot<TSpec>
}

function isAppliedAck(
  ack: Record<string, unknown>,
  ticket: { readonly requestId: number },
): boolean {
  return (
    ack.applied === true &&
    (typeof ack.requestId === 'number' || typeof ack.requestId === 'string') &&
    Number(ack.requestId) === ticket.requestId
  )
}

function isNotAppliedAck(
  ack: Record<string, unknown>,
  ticket: { readonly requestId: number },
): boolean {
  return (
    ack.applied === false &&
    (typeof ack.requestId === 'number' || typeof ack.requestId === 'string') &&
    Number(ack.requestId) === ticket.requestId
  )
}

// ---------------------------------------------------------------------------
// 2.  Bounded async operation runner
// ---------------------------------------------------------------------------

/**
 * Outcome of a time-boxed async operation.
 */
export type BoundedOperationResult<T> =
  | { readonly kind: 'fulfilled'; readonly value: T }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timeout' }

/**
 * Run `operation` with a deadline.  If the returned promise settles before
 * `timeoutMs` the outcome is `fulfilled` / `rejected`; otherwise the outcome
 * is `timeout`.
 *
 * The caller is responsible for providing a meaningful `debugLabel` so
 * timeout messages are traceable (`"editing-commit"`, `"history-undo"`, …).
 */
export async function runBoundedOperation<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  debugLabel: string,
): Promise<BoundedOperationResult<T>> {
  const timeoutPromise = new Promise<BoundedOperationResult<T>>((resolve) => {
    setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })

  try {
    const result = await Promise.race([operation(), timeoutPromise])
    if (
      result !== null &&
      typeof result === 'object' &&
      'kind' in result &&
      (result as BoundedOperationResult<T>).kind === 'timeout'
    ) {
      return result as BoundedOperationResult<T>
    }
    return { kind: 'fulfilled', value: result as T }
  } catch (error: unknown) {
    return { kind: 'rejected', error }
  }
}

// ---------------------------------------------------------------------------
// 3.  Canonical timeout value
// ---------------------------------------------------------------------------

/**
 * Default timeout for mutation transport operations (editing commit, history
 * undo/redo, paste-special, filter-sort apply, remove-duplicates).
 *
 * 15 seconds matches the original editing module constant.  If a transport
 * takes longer the host is almost certainly stuck or the Worker is GC-paused;
 * a 'timeout' outcome lets the caller surface a user-visible toast and
 * release the transport lane rather than locking the sheet forever.
 */
export const MUTATION_TRANSPORT_TIMEOUT_MS = 15_000
