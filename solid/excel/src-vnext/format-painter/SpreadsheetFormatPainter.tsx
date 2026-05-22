/** @jsxImportSource solid-js */

import { createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  applyFormatPainterAtom,
  exitFormatPainterAtom,
  formatPainterClipboardAtom,
  formatPainterStateAtom,
  selectionAtom,
  selectionRangeAtom,
  workspaceSessionAtom,
  type CellRange,
  type SpreadsheetCellFormat,
} from '@einfach/spreadsheet-ui-core'
import {
  refreshVisibleProjection,
  spreadsheetProjectionSnapshotAtom,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'

export interface SpreadsheetFormatPainterProps {
  'data-testid'?: string
}

/**
 * Invisible logic component that drives the format painter:
 *  - listens for selection changes while the painter is armed or sticky,
 *  - dispatches applyFormatPainterAtom and forwards the captured format to
 *    backend.setFormatRange for the new selection range,
 *  - exits the painter on Esc.
 *
 * The toolbar button is responsible for arming the painter (single click =
 * single-shot 'armed', double click = 'sticky'). This component contains no
 * trigger UI of its own.
 */
export function SpreadsheetFormatPainter(props: SpreadsheetFormatPainterProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()

  function reportError(error: unknown) {
    const current = store.getter(spreadsheetProjectionSnapshotAtom)
    store.setter(spreadsheetProjectionSnapshotAtom, {
      ...current,
      status: 'error',
      error:
        error instanceof Error
          ? { code: 'BACKEND_ERROR', message: error.message }
          : { code: 'BACKEND_ERROR', message: 'Format painter apply failed.' },
    })
  }

  async function applyToRange(
    sheetId: string,
    range: CellRange,
    format: SpreadsheetCellFormat,
  ) {
    if (!backend.setFormatRange) {
      throw new Error('Range formatting is not supported by this spreadsheet backend.')
    }
    await backend.setFormatRange({
      kind: 'set-format-range',
      sheetId,
      range,
      format,
    })
    await refreshVisibleProjection(store, backend, sheetId)
  }

  let lastSelectionKey: string | null = null
  let armedSelectionKey: string | null = null

  function rangeKey(sheetId: string, range: CellRange): string {
    return sheetId + ':' + range.rowStart + ',' + range.colStart + '-' + range.rowEnd + ',' + range.colEnd
  }

  function resolveSheetId(): string {
    const selection = store.getter(selectionAtom)
    const workspace = store.getter(workspaceSessionAtom)
    return selection.sheetId || workspace.activeSheetId || ''
  }

  function tryApply() {
    const state = store.getter(formatPainterStateAtom)
    if (state === 'idle') return
    const clipboard = store.getter(formatPainterClipboardAtom)
    if (!clipboard) return

    const sheetId = resolveSheetId()
    if (!sheetId) return

    const range = store.getter(selectionRangeAtom)
    const currentKey = rangeKey(sheetId, range)
    if (currentKey === armedSelectionKey) {
      // selection didn't change since arming - don't paint over the source
      return
    }

    const ok = store.setter(applyFormatPainterAtom)
    if (!ok) return

    void applyToRange(sheetId, range, clipboard.format).catch(reportError)
  }

  createEffect(() => {
    const state = store.getter(formatPainterStateAtom)
    if (state === 'idle') {
      lastSelectionKey = null
      armedSelectionKey = null
      return
    }

    const sheetId = resolveSheetId()
    const range = store.getter(selectionRangeAtom)
    const key = rangeKey(sheetId, range)

    if (armedSelectionKey === null) {
      armedSelectionKey = key
      lastSelectionKey = key
      return
    }

    if (key === lastSelectionKey) return
    lastSelectionKey = key
    tryApply()
  })

  const unsubscribeSelection = store.sub(selectionAtom, () => {
    const state = store.getter(formatPainterStateAtom)
    if (state === 'idle') return
    const sheetId = resolveSheetId()
    const range = store.getter(selectionRangeAtom)
    const key = rangeKey(sheetId, range)
    if (armedSelectionKey === null) {
      armedSelectionKey = key
      lastSelectionKey = key
      return
    }
    if (key === lastSelectionKey) return
    lastSelectionKey = key
    tryApply()
  })

  const unsubscribeState = store.sub(formatPainterStateAtom, () => {
    const state = store.getter(formatPainterStateAtom)
    if (state === 'idle') {
      armedSelectionKey = null
      lastSelectionKey = null
      return
    }
    const sheetId = resolveSheetId()
    const range = store.getter(selectionRangeAtom)
    const key = rangeKey(sheetId, range)
    armedSelectionKey = key
    lastSelectionKey = key
  })

  // When the active sheet changes while the painter is armed/sticky, the
  // captured source format no longer corresponds to anything the user can see
  // (they switched tabs). Clear the painter so the next cell click on the new
  // sheet doesn't silently overwrite formatting with stale data.
  //
  // Seed `lastWorkspaceSheetId` with the current id so the *first* mutation
  // after subscribe (e.g. user clicks a different tab) is recognised as a
  // real change — a null seed would silently swallow the first switch.
  let lastWorkspaceSheetId: string | null =
    store.getter(workspaceSessionAtom).activeSheetId ?? null
  const unsubscribeWorkspace = store.sub(workspaceSessionAtom, () => {
    const workspace = store.getter(workspaceSessionAtom)
    const nextSheetId = workspace.activeSheetId ?? null
    if (nextSheetId === lastWorkspaceSheetId) return
    lastWorkspaceSheetId = nextSheetId
    if (store.getter(formatPainterStateAtom) !== 'idle') {
      store.setter(exitFormatPainterAtom)
    }
  })

  // Mirror the painter state onto the grid root (if mounted) so the cell
  // cursor can change while the painter is armed/sticky. This is the only
  // visible signal the user gets that their next click will paint — without
  // it the toolbar button is the only feedback, easily missed mid-drag.
  function findGridRoots(): HTMLElement[] {
    if (typeof document === 'undefined') return []
    return Array.from(
      document.querySelectorAll<HTMLElement>('.spreadsheet-grid'),
    )
  }
  const unsubscribeStateForCursor = store.sub(formatPainterStateAtom, () => {
    const state = store.getter(formatPainterStateAtom)
    for (const root of findGridRoots()) {
      if (state === 'idle') {
        root.removeAttribute('data-format-painter-active')
      } else {
        root.setAttribute('data-format-painter-active', state)
      }
    }
  })

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    const state = store.getter(formatPainterStateAtom)
    if (state === 'idle') return
    store.setter(exitFormatPainterAtom)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeyDown)
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown)
    })
  }

  onCleanup(() => {
    unsubscribeSelection()
    unsubscribeState()
    unsubscribeWorkspace()
    unsubscribeStateForCursor()
    // Defensive: leave the grid in a clean state if the painter unmounts
    // while armed (HMR, demo unmount, etc.).
    for (const root of findGridRoots()) {
      root.removeAttribute('data-format-painter-active')
    }
  })

  // Reactive read so the hidden marker reflects the current state even if the
  // surrounding component body does not re-execute on atom mutations.
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
