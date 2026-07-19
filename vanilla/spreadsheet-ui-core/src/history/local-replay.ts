import type { Getter, Setter } from '@einfach/core'
import type { HistoryLocalReplayDirection, HistoryLocalReplayPayload } from './types'

/**
 * Local-replay applier registry.
 *
 * View facts that are UI-core canonical (freeze today; hidden rows/cols,
 * row heights / col widths, filter visibility, protection in later flip
 * slices) undo without a backend transaction: the history entry carries
 * `before` / `after` payloads plus an `applyKey`, and the applier
 * registered under that key re-applies the exact payload in-process.
 *
 * The registry holds code, not state — appliers must be stateless
 * functions that only read and write atoms through the `get` / `set`
 * they receive, so one registration serves every store. A feature
 * module registers its applier at module scope; entries carrying that
 * `applyKey` can only be pushed by the same module's command atoms, so
 * the applier is always loaded before replay can be requested.
 */
export type HistoryLocalReplayApplier = (
  get: Getter,
  set: Setter,
  payload: Readonly<HistoryLocalReplayPayload>,
  direction: HistoryLocalReplayDirection,
  /**
   * The host object passed as `RunHistoryCommandInput.source`. Appliers
   * that mirror their state into an optional persistence hook may probe
   * it (fire-and-forget); they must not require it.
   */
  source?: unknown,
) => boolean

const localReplayAppliers = new Map<string, HistoryLocalReplayApplier>()

export function registerHistoryLocalReplayApplier(
  applyKey: string,
  applier: HistoryLocalReplayApplier,
): void {
  localReplayAppliers.set(applyKey, applier)
}

export function getHistoryLocalReplayApplier(applyKey: string): HistoryLocalReplayApplier | null {
  return localReplayAppliers.get(applyKey) ?? null
}
