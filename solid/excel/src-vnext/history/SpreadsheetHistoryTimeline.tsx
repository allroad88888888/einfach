/** @jsxImportSource solid-js */

import { For, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  canRedoAtom,
  canUndoAtom,
  historyCanRetryRefreshAtom,
  historyLifecycleAtom,
  historyStackAtom,
  type HistoryEntry,
} from '@einfach/spreadsheet-ui-core'
import { dispatchRedo, dispatchUndo, retryHistoryRefresh } from '../provider/history-dispatch'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'

export interface SpreadsheetHistoryTimelineProps {
  class?: string
  'data-testid'?: string
  /** Optional formatter for the per-entry timestamp label. Defaults to ISO-time. */
  formatTimestamp?: (entry: HistoryEntry) => string
}

function defaultFormatTimestamp(entry: HistoryEntry): string {
  // History entries do not carry a wall-clock timestamp — fall back to the
  // projection revision number which monotonically increases per mutation.
  return `rev ${entry.projectionRevision}`
}

export function SpreadsheetHistoryTimeline(props: SpreadsheetHistoryTimelineProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const stack = useAtomValue(historyStackAtom)
  const lifecycle = useAtomValue(historyLifecycleAtom)
  const canUndo = useAtomValue(canUndoAtom)
  const canRedo = useAtomValue(canRedoAtom)
  const canRetryRefresh = useAtomValue(historyCanRetryRefreshAtom)

  function format(entry: HistoryEntry): string {
    return (props.formatTimestamp ?? defaultFormatTimestamp)(entry)
  }

  const dispatchUndoOnce = () => dispatchUndo(store, backend)
  const dispatchRedoOnce = () => dispatchRedo(store, backend)
  const retryRefreshOnce = () => retryHistoryRefresh(store, backend)

  const timelineLocked = () =>
    stack().inFlight ||
    lifecycle().status === 'refresh-failed' ||
    lifecycle().status === 'outcome-unknown'

  async function jumpTo(targetIndex: number) {
    // targetIndex 0 means "before any entry"; cursor==N means "after entry N-1".
    // Translate to desired cursor: clicking an entry jumps to the state where
    // that entry has just been applied — cursor = targetIndex + 1.
    const desiredCursor = targetIndex + 1
    let safety = 0
    while (safety++ < 200) {
      const current = store.getter(historyStackAtom)
      if (current.cursor === desiredCursor) return
      if (current.cursor < desiredCursor) {
        if (!store.getter(canRedoAtom)) return
        const ok = await dispatchRedoOnce()
        if (!ok) return
      } else {
        if (!store.getter(canUndoAtom)) return
        const ok = await dispatchUndoOnce()
        if (!ok) return
      }
    }
  }

  return (
    <div
      class={`spreadsheet-history-timeline ${props.class ?? ''}`.trim()}
      data-testid={props['data-testid'] ?? 'history-timeline'}
      data-lifecycle-status={lifecycle().status}
    >
      <div class="history-timeline-controls">
        <button
          type="button"
          class="history-timeline-btn history-timeline-btn-undo"
          data-testid="history-timeline-undo"
          disabled={!canUndo()}
          onClick={() => void dispatchUndoOnce()}
        >
          Undo
        </button>
        <button
          type="button"
          class="history-timeline-btn history-timeline-btn-redo"
          data-testid="history-timeline-redo"
          disabled={!canRedo()}
          onClick={() => void dispatchRedoOnce()}
        >
          Redo
        </button>
        <span
          class="history-timeline-cursor"
          data-testid="history-timeline-cursor"
          aria-live="polite"
        >
          {stack().cursor} / {stack().entries.length}
        </span>
      </div>

      {/*
        a11y: `role="list"` used to sit on the outer wrapper, which also holds
        the undo/redo controls and the live-region cursor — non-listitem
        children under a list role (axe `aria-required-children`, critical).
        The real list is this <ul>, which already has native list semantics and
        only <li> children, so the label belongs here.
      */}
      <ul
        class="history-timeline-list"
        data-testid="history-timeline-list"
        aria-label="History timeline"
      >
        <For each={stack().entries}>
          {(entry, index) => {
            const isApplied = () => index() < stack().cursor
            const isCurrent = () => index() === stack().cursor - 1
            return (
              <li
                class={`history-timeline-entry ${isCurrent() ? 'history-timeline-entry-current' : ''}`.trim()}
                data-testid={`history-timeline-entry-${index()}`}
                data-transaction-id={entry.transactionId}
                data-kind={entry.kind}
                data-applied={isApplied() ? 'true' : 'false'}
                data-current={isCurrent() ? 'true' : 'false'}
                role="listitem"
              >
                <button
                  type="button"
                  class="history-timeline-entry-btn"
                  data-testid={`history-timeline-jump-${index()}`}
                  disabled={timelineLocked()}
                  onClick={() => void jumpTo(index())}
                >
                  <span class="history-timeline-entry-kind">{entry.kind}</span>
                  <span class="history-timeline-entry-time">{format(entry)}</span>
                </button>
              </li>
            )
          }}
        </For>
      </ul>

      <Show when={stack().entries.length === 0}>
        <div class="history-timeline-empty" data-testid="history-timeline-empty">
          No history yet
        </div>
      </Show>

      <Show when={lifecycle().status !== 'ready' && lifecycle().error.length > 0}>
        <div
          class="history-timeline-status"
          data-testid="history-timeline-status"
          data-status={lifecycle().status}
          role={lifecycle().status === 'outcome-unknown' ? 'alert' : 'status'}
        >
          {lifecycle().error}
        </div>
      </Show>

      <Show when={canRetryRefresh()}>
        <button
          type="button"
          class="history-timeline-btn history-timeline-btn-retry"
          data-testid="history-timeline-retry-refresh"
          onClick={() => void retryRefreshOnce()}
        >
          Retry refresh
        </button>
      </Show>
    </div>
  )
}
