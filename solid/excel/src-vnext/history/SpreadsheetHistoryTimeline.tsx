/** @jsxImportSource solid-js */

import { For, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  canRedoAtom,
  canUndoAtom,
  historyStackAtom,
  redoHistoryAtom,
  resolveHistoryAtom,
  undoHistoryAtom,
  type HistoryEntry,
} from '@einfach/spreadsheet-ui-core'
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
  const canUndo = useAtomValue(canUndoAtom)
  const canRedo = useAtomValue(canRedoAtom)

  function format(entry: HistoryEntry): string {
    return (props.formatTimestamp ?? defaultFormatTimestamp)(entry)
  }

  async function dispatchUndoOnce(): Promise<boolean> {
    const entry = store.setter(undoHistoryAtom)
    if (!entry) return false
    if (!backend.undoTransaction) {
      store.setter(resolveHistoryAtom, { transactionId: entry.transactionId, ok: true })
      return true
    }
    try {
      const result = await backend.undoTransaction({
        kind: 'undo-transaction',
        transactionId: entry.transactionId,
      })
      store.setter(resolveHistoryAtom, {
        transactionId: entry.transactionId,
        ok: true,
        revision: result.revision,
      })
      return true
    } catch {
      store.setter(resolveHistoryAtom, { transactionId: entry.transactionId, ok: false })
      return false
    }
  }

  async function dispatchRedoOnce(): Promise<boolean> {
    const entry = store.setter(redoHistoryAtom)
    if (!entry) return false
    if (!backend.redoTransaction) {
      store.setter(resolveHistoryAtom, { transactionId: entry.transactionId, ok: true })
      return true
    }
    try {
      const result = await backend.redoTransaction({
        kind: 'redo-transaction',
        transactionId: entry.transactionId,
      })
      store.setter(resolveHistoryAtom, {
        transactionId: entry.transactionId,
        ok: true,
        revision: result.revision,
      })
      return true
    } catch {
      store.setter(resolveHistoryAtom, { transactionId: entry.transactionId, ok: false })
      return false
    }
  }

  async function jumpTo(targetIndex: number) {
    // targetIndex 0 means "before any entry"; cursor==N means "after entry N-1".
    // Translate to desired cursor: clicking an entry jumps to the state where
    // that entry has just been applied — cursor = targetIndex + 1.
    const desiredCursor = targetIndex + 1
    let safety = 0
    while (safety++ < 200) {
      const current = store.getter(historyStackAtom)
      if (current.cursor === desiredCursor) return
      if (current.inFlight) return
      if (current.cursor < desiredCursor) {
        const ok = await dispatchRedoOnce()
        if (!ok) return
      } else {
        const ok = await dispatchUndoOnce()
        if (!ok) return
      }
    }
  }

  return (
    <div
      class={`spreadsheet-history-timeline ${props.class ?? ''}`.trim()}
      data-testid={props['data-testid'] ?? 'history-timeline'}
      role="list"
      aria-label="History timeline"
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

      <ul class="history-timeline-list" data-testid="history-timeline-list">
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
                  disabled={stack().inFlight}
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
        <div
          class="history-timeline-empty"
          data-testid="history-timeline-empty"
        >
          No history yet
        </div>
      </Show>
    </div>
  )
}
