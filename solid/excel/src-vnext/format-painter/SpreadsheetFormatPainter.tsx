/** @jsxImportSource solid-js */

import { onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  applyFormatPainterAtom,
  captureFormatPainterBackendCapabilitiesAtom,
  exitFormatPainterAtom,
  formatPainterPendingAtom,
  formatPainterStateAtom,
  selectionAuthorityWitnessAtom,
  syncFormatPainterContextAtom,
  workspaceActiveSheetAuthorityWitnessAtom,
  type ApplyFormatPainterInput,
  type CellRange,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import {
  resolveProjectionSourceRanges,
  refreshVisibleProjection,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'

export interface SpreadsheetFormatPainterProps {
  'data-testid'?: string
}

/**
 * Thin Solid host for the Core-owned format-painter state machine.
 *
 * Solid observes authority witnesses and supplies frozen backend/projection
 * ports. Session identity, source/target suppression, tickets, pending/error
 * state, acknowledgement validation, and the attempt ledger all remain in
 * @einfach/spreadsheet-ui-core.
 */
export function SpreadsheetFormatPainter(props: SpreadsheetFormatPainterProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()

  // Capture the provider surface exactly once. All later mutation and refresh
  // calls use these receiver-preserving Core snapshots, never a live re-read.
  const capabilities = store.setter(captureFormatPainterBackendCapabilitiesAtom, backend)
  const projectionBackend = Object.freeze({
    readVisibleProjection: capabilities.readVisibleProjection,
  }) as SpreadsheetBackend
  const applyPorts: ApplyFormatPainterInput = Object.freeze({
    resolveTargetRanges: Object.freeze((sheetId: string, range: CellRange) =>
      resolveProjectionSourceRanges(store, sheetId, range),
    ),
    setFormatRange: capabilities.setFormatRange,
    refreshProjection:
      capabilities.readVisibleProjection === undefined
        ? undefined
        : Object.freeze((sheetId: string) =>
            refreshVisibleProjection(store, projectionBackend, sheetId, 'toolbar'),
          ),
  })

  function tryApply(): void {
    // Core reads the logical target and decides whether this is source,
    // duplicate, pending, blocked, stale, or a new immutable mutation ticket.
    void store.setter(applyFormatPainterAtom, applyPorts)
  }

  const unsubscribeSelection = store.sub(selectionAuthorityWitnessAtom, tryApply)
  const unsubscribePending = store.sub(formatPainterPendingAtom, () => {
    // If selection drifted while a mutation/refresh was pending, the selection
    // callback was correctly blocked. Retry from Core authority once clear.
    if (!store.getter(formatPainterPendingAtom)) tryApply()
  })
  const unsubscribeWorkspace = store.sub(workspaceActiveSheetAuthorityWitnessAtom, () => {
    store.setter(syncFormatPainterContextAtom)
  })

  function findGridRoots(): HTMLElement[] {
    if (typeof document === 'undefined') return []
    return Array.from(document.querySelectorAll<HTMLElement>('.spreadsheet-grid'))
  }

  function syncCursor(): void {
    const state = store.getter(formatPainterStateAtom)
    for (const root of findGridRoots()) {
      if (state === 'idle') root.removeAttribute('data-format-painter-active')
      else root.setAttribute('data-format-painter-active', state)
    }
  }

  const unsubscribeCursor = store.sub(formatPainterStateAtom, syncCursor)
  syncCursor()

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && store.getter(formatPainterStateAtom) !== 'idle') {
      store.setter(exitFormatPainterAtom)
    }
  }

  if (typeof window !== 'undefined') window.addEventListener('keydown', handleKeyDown)

  onCleanup(() => {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', handleKeyDown)
    unsubscribeSelection()
    unsubscribePending()
    unsubscribeWorkspace()
    unsubscribeCursor()
    for (const root of findGridRoots()) root.removeAttribute('data-format-painter-active')
  })

  const painterStateSignal = useAtomValue(formatPainterStateAtom)

  return (
    <span
      aria-hidden="true"
      style={{ display: 'none' }}
      data-testid={props['data-testid'] ?? 'spreadsheet-format-painter'}
      data-format-painter-state={painterStateSignal()}
    />
  )
}
