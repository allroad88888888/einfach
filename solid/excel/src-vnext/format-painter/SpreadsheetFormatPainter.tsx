/** @jsxImportSource solid-js */

import { createEffect, onCleanup } from 'solid-js'
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
  advanceSpreadsheetProjectionRequestIdAtom,
  isVisibleProjectionResult,
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

  function getCurrentWindow() {
    const snapshot = store.getter(spreadsheetProjectionSnapshotAtom)
    if (isVisibleProjectionResult(snapshot.result)) {
      return snapshot.result.window
    }
    if (snapshot.request?.kind === 'visible-window') {
      return snapshot.request.window
    }
    return null
  }

  async function refreshProjection(sheetId: string) {
    const window = getCurrentWindow()
    if (!window) return

    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    const request = {
      kind: 'visible-window' as const,
      sheetId,
      requestId,
      reason: 'toolbar' as const,
      window,
    }

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'loading',
      request,
      result: undefined,
      error: undefined,
    })

    const result = await backend.readVisibleProjection(request)
    const current = store.getter(spreadsheetProjectionSnapshotAtom)
    if (current.request?.requestId !== requestId) return
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request,
      result,
      error: undefined,
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
    await refreshProjection(sheetId)
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
  })

  return (
    <span
      aria-hidden="true"
      style={{ display: 'none' }}
      data-testid={props['data-testid'] ?? 'spreadsheet-format-painter'}
      data-format-painter-state={store.getter(formatPainterStateAtom)}
    />
  )
}
