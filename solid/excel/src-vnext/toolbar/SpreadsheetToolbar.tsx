import { createSignal } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  armFormatPainterAtom,
  armFormatPainterStickyAtom,
  createVisibleProjectionRequest,
  dispatchToolbarFormatCommandAtom,
  exitFormatPainterAtom,
  formatPainterStateAtom,
  nextHistoryTransactionId,
  openFormatCellsAtom,
  pushHistoryAtom,
  selectionSnapshotAtom,
  toolbarCommandAvailabilityAtom,
  activeCellLockedAtom,
  selectionLockedAtom,
  findReplaceOpenAtom,
  printPreviewOpenAtom,
  togglePrintPreviewAtom,
  type CapturedFormat,
  type CellRange,
  type HistoryEntryKind,
  type SpreadsheetCellFormat,
  type SpreadsheetNumberFormat,
  type ToolbarFormatCommandInput,
  type ToolbarFormatCommandIntent,
} from '@einfach/spreadsheet-ui-core'

import {
  advanceSpreadsheetProjectionRequestIdAtom,
  isVisibleProjectionResult,
  spreadsheetProjectionSnapshotAtom,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'
import type { SpreadsheetToolbarProps, SpreadsheetToolbarCommand } from './types'
import { NumberFormatDropdown, type NumberFormatId } from './NumberFormatDropdown'

const toolbarCommands: SpreadsheetToolbarCommand[] = [
  {
    command: 'bold',
    label: 'toolbar.bold',
    title: 'toolbar.bold.title',
    testId: 'toolbar-btn-bold',
    isEnabled: (availability) => availability.bold,
  },
  {
    command: 'italic',
    label: 'toolbar.italic',
    title: 'toolbar.italic.title',
    testId: 'toolbar-btn-italic',
    isEnabled: (availability) => availability.italic,
  },
  {
    command: 'underline',
    label: 'toolbar.underline',
    title: 'toolbar.underline.title',
    testId: 'toolbar-btn-underline',
    isEnabled: (availability) => availability.underline,
  },
  {
    command: 'fill-color',
    label: 'toolbar.fillColor',
    title: 'toolbar.fillColor.title',
    testId: 'toolbar-btn-fill-color',
    value: '#ffd966',
    isEnabled: (availability) => availability.fillColor,
  },
  {
    command: 'text-color',
    label: 'toolbar.textColor',
    title: 'toolbar.textColor.title',
    testId: 'toolbar-btn-text-color',
    value: '#000000',
    isEnabled: (availability) => availability.textColor,
  },
  {
    command: 'number-format',
    label: 'toolbar.numberFormat',
    title: 'toolbar.numberFormat.title',
    testId: 'toolbar-btn-number-format',
    // The button opens the NumberFormatDropdown; the chosen row supplies the
    // value when dispatchCommand is invoked. The hard-coded value here is a
    // safety net for callers that bypass the dropdown (none today).
    value: 'Number',
    isEnabled: (availability) => availability.numberFormat,
  },
  {
    command: 'vertical-alignment',
    label: 'toolbar.verticalAlignTop',
    title: 'toolbar.verticalAlignTop.title',
    testId: 'toolbar-btn-vertical-align-top',
    value: 'top',
    isEnabled: (availability) => availability.verticalAlignment,
  },
  {
    command: 'vertical-alignment',
    label: 'toolbar.verticalAlignMiddle',
    title: 'toolbar.verticalAlignMiddle.title',
    testId: 'toolbar-btn-vertical-align-middle',
    value: 'center',
    isEnabled: (availability) => availability.verticalAlignment,
  },
  {
    command: 'vertical-alignment',
    label: 'toolbar.verticalAlignBottom',
    title: 'toolbar.verticalAlignBottom.title',
    testId: 'toolbar-btn-vertical-align-bottom',
    value: 'bottom',
    isEnabled: (availability) => availability.verticalAlignment,
  },
]

function cloneFormat(format: SpreadsheetCellFormat | undefined): SpreadsheetCellFormat {
  const clone: SpreadsheetCellFormat = { ...(format ?? {}) }
  if (format?.numberFormat) clone.numberFormat = { ...format.numberFormat }
  return clone
}

/**
 * Map a toolbar `value` token to a `SpreadsheetNumberFormat`. Token names are
 * the `NumberFormatId` values from the dropdown plus the legacy aliases
 * `'Number' | 'Percent' | 'Currency' | 'Date' | 'General'` used by callers
 * before the dropdown existed.
 *
 * `'Custom'` and `'WanYuan'` are handled out-of-band by the toolbar (the
 * former opens the Format Cells dialog; the latter is disabled in the
 * dropdown) and never reach this function.
 */
function numberFormatForValue(value: string | null): SpreadsheetNumberFormat {
  switch (value) {
    // 16-row dropdown identifiers
    case 'Auto':
    case 'General':
      return { kind: 'general' }
    case 'Text':
      return { kind: 'text' }
    case 'Number':
      return { kind: 'decimal', digits: 2, thousands: false }
    case 'Percent':
      return { kind: 'percent', digits: 0 }
    case 'Scientific':
      return { kind: 'scientific', digits: 2 }
    case 'NumberThousands':
      return { kind: 'decimal', digits: 2, thousands: true }
    case 'Accounting':
      return { kind: 'accounting', symbol: '¥', digits: 2 }
    case 'Currency':
      return { kind: 'currency', symbol: '¥', digits: 2 }
    case 'DateShort':
    case 'Date':
      return { kind: 'date', pattern: 'yyyy-mm-dd' }
    case 'DateLong':
      return { kind: 'date', pattern: 'yyyy"年"m"月"d"日"' }
    case 'Time12':
      return { kind: 'time', pattern: 'h:mm AM/PM' }
    case 'Time24':
      return { kind: 'time', pattern: 'HH:mm' }
    case 'DateTime12':
      return { kind: 'custom', pattern: 'yyyy-mm-dd h:mm AM/PM' }
    case 'DateTime24':
      return { kind: 'custom', pattern: 'yyyy-mm-dd HH:mm' }
    default:
      return { kind: 'general' }
  }
}

function rangeCellCount(range: CellRange): number {
  if (range.rowEnd < range.rowStart || range.colEnd < range.colStart) return 0
  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
}

export function SpreadsheetToolbar(props: SpreadsheetToolbarProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const t = useT()
  const availability = useAtomValue(toolbarCommandAvailabilityAtom)
  const projectionSnapshot = useAtomValue(spreadsheetProjectionSnapshotAtom)
  const selectionSnapshot = useAtomValue(selectionSnapshotAtom)
  const activeCellLocked = useAtomValue(activeCellLockedAtom)
  const selectionLocked = useAtomValue(selectionLockedAtom)
  const findReplaceOpen = useAtomValue(findReplaceOpenAtom)
  const printPreviewOpen = useAtomValue(printPreviewOpenAtom)
  const formatPainterState = useAtomValue(formatPainterStateAtom)
  const [numberFormatOpen, setNumberFormatOpen] = createSignal(false)
  const [numberFormatAnchor, setNumberFormatAnchor] = createSignal<DOMRect | null>(null)
  let numberFormatAnchorEl: HTMLButtonElement | null = null

  function isProtectionGated(): boolean {
    return activeCellLocked() || selectionLocked() !== 'open'
  }

  function openNumberFormatDropdown(buttonEl: HTMLButtonElement) {
    numberFormatAnchorEl = buttonEl
    setNumberFormatAnchor(buttonEl.getBoundingClientRect())
    setNumberFormatOpen(true)
  }

  function closeNumberFormatDropdown() {
    setNumberFormatOpen(false)
    setNumberFormatAnchor(null)
  }

  function onNumberFormatPick(id: NumberFormatId) {
    closeNumberFormatDropdown()
    if (id === 'Custom') {
      const selection = selectionSnapshot()
      const sheetId = selection.selection.sheetId || availability().sheetId
      if (!sheetId) return
      store.setter(openFormatCellsAtom, {
        sheetId,
        range: selection.range,
        initialTab: 'number',
        initialFormat: activeCellFormat(),
      })
      return
    }
    // 'WanYuan' is disabled in the dropdown UI and never reaches here, but
    // guard so a future re-enable does not silently fall through to General.
    if (id === 'WanYuan') return
    dispatchCommand({ command: 'number-format', value: id })
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

  function activeCellFormat(): SpreadsheetCellFormat {
    const selection = selectionSnapshot()
    const snapshot = projectionSnapshot()
    const result = snapshot.result
    if (!isVisibleProjectionResult(result) || result.sheetId !== selection.selection.sheetId) {
      return {}
    }

    const cell = result.cells.find(
      (candidate) =>
        candidate.row === selection.activeCell.row &&
        candidate.col === selection.activeCell.col,
    )
    return cloneFormat(cell?.format)
  }

  function captureFormatPainterPayload(): CapturedFormat {
    const selection = selectionSnapshot()
    const snapshot = projectionSnapshot()
    const result = snapshot.result
    if (!isVisibleProjectionResult(result) || result.sheetId !== selection.selection.sheetId) {
      return { format: {} }
    }

    const cell = result.cells.find(
      (candidate) =>
        candidate.row === selection.activeCell.row &&
        candidate.col === selection.activeCell.col,
    )
    return {
      format: cloneFormat(cell?.format),
      conditionalFormat: cell?.conditionalFormat ? { ...cell.conditionalFormat } : undefined,
    }
  }

  let painterClickTimer: ReturnType<typeof setTimeout> | null = null

  function handleFormatPainterClick() {
    if (formatPainterState() !== 'idle') {
      if (painterClickTimer) {
        clearTimeout(painterClickTimer)
        painterClickTimer = null
      }
      store.setter(exitFormatPainterAtom)
      return
    }
    if (painterClickTimer) return
    painterClickTimer = setTimeout(() => {
      painterClickTimer = null
      if (formatPainterState() !== 'idle') return
      store.setter(armFormatPainterAtom, captureFormatPainterPayload())
    }, 220)
  }

  function handleFormatPainterDoubleClick() {
    if (painterClickTimer) {
      clearTimeout(painterClickTimer)
      painterClickTimer = null
    }
    store.setter(armFormatPainterStickyAtom, captureFormatPainterPayload())
  }

  function commandFormat(
    intent: ToolbarFormatCommandIntent,
    current: SpreadsheetCellFormat,
  ): SpreadsheetCellFormat {
    switch (intent.command) {
      case 'bold':
        return { ...current, bold: !current.bold }
      case 'italic':
        return { ...current, italic: !current.italic }
      case 'underline':
        return { ...current, underline: !current.underline }
      case 'fill-color':
        return { ...current, bgColor: intent.value ?? '#ffd966' }
      case 'text-color':
        return { ...current, fgColor: intent.value ?? '#000000' }
      case 'number-format':
        return { ...current, numberFormat: numberFormatForValue(intent.value) }
      case 'alignment':
        return {
          ...current,
          align: intent.value === 'center' || intent.value === 'right' ? intent.value : 'left',
        }
      case 'vertical-alignment':
        return {
          ...current,
          verticalAlign:
            intent.value === 'top' || intent.value === 'center' ? intent.value : 'bottom',
        }
      default:
        return current
    }
  }

  async function refreshProjection(sheetId: string) {
    const window = getCurrentWindow()
    if (!window) {
      return
    }

    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    const request = createVisibleProjectionRequest({
      sheetId,
      window,
      requestId,
      reason: 'toolbar',
    })

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'loading',
      request,
      result: undefined,
      error: undefined,
    })

    const result = await backend.readVisibleProjection(request)
    const current = store.getter(spreadsheetProjectionSnapshotAtom)
    if (current.request?.requestId !== requestId) {
      return
    }
    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'ready',
      request,
      result,
      error: undefined,
    })
  }

  function reportCommandError(error: unknown) {
    const current = store.getter(spreadsheetProjectionSnapshotAtom)
    store.setter(spreadsheetProjectionSnapshotAtom, {
      ...current,
      status: 'error',
      error:
        error instanceof Error
          ? { code: 'BACKEND_ERROR', message: error.message }
          : { code: 'BACKEND_ERROR', message: 'Spreadsheet toolbar command failed.' },
    })
  }

  function recordHistoryEntry(input: {
    sheetId: string | null
    kind: HistoryEntryKind
    revision: number | string | undefined
    affectedRange?: CellRange
  }) {
    const projectionRevision =
      typeof input.revision === 'number' ? input.revision : Number(input.revision ?? 0) || 0
    store.setter(pushHistoryAtom, {
      transactionId: nextHistoryTransactionId(),
      kind: input.kind,
      sheetId: input.sheetId,
      projectionRevision,
      affectedRange: input.affectedRange ? { ...input.affectedRange } : undefined,
    })
  }

  async function executeCommand(intent: ToolbarFormatCommandIntent, range: CellRange) {
    if (!backend.setFormatRange) {
      throw new Error('Range formatting is not supported by this spreadsheet backend.')
    }

    const current = activeCellFormat()
    const result = await backend.setFormatRange({
      kind: 'set-format-range',
      sheetId: intent.sheetId,
      range,
      format: commandFormat(intent, current),
    })
    recordHistoryEntry({
      sheetId: intent.sheetId,
      kind: 'format.set',
      revision: result?.revision,
      affectedRange: result?.affectedRange ?? range,
    })
    await refreshProjection(intent.sheetId)
  }

  function dispatchCommand(input: ToolbarFormatCommandInput) {
    const intent = store.setter(dispatchToolbarFormatCommandAtom, input)
    if (!intent) {
      return
    }

    const range = selectionSnapshot().range
    void executeCommand(intent, range).catch(reportCommandError)
  }

  function getMutationSheetId() {
    const snapshot = selectionSnapshot()
    return snapshot.selection.sheetId || availability().sheetId
  }

  function selectionContainsMergeAnchor(): boolean {
    const snapshot = projectionSnapshot()
    const result = snapshot.result
    if (!isVisibleProjectionResult(result)) return false
    const selection = selectionSnapshot()
    if (result.sheetId !== selection.selection.sheetId) return false
    const range = selection.range
    for (const cell of result.cells) {
      if (!cell.mergedSpan) continue
      if (
        cell.row >= range.rowStart &&
        cell.row <= range.rowEnd &&
        cell.col >= range.colStart &&
        cell.col <= range.colEnd
      ) {
        return true
      }
    }
    return false
  }

  function canMergeSelection() {
    return (
      !!backend.mergeRange &&
      availability().editingMode !== 'drafting' &&
      getMutationSheetId() !== null &&
      rangeCellCount(selectionSnapshot().range) > 1 &&
      !selectionContainsMergeAnchor()
    )
  }

  function canUnmergeSelection() {
    return (
      !!backend.unmergeRange &&
      availability().editingMode !== 'drafting' &&
      getMutationSheetId() !== null &&
      selectionContainsMergeAnchor()
    )
  }

  async function mergeSelection() {
    const sheetId = getMutationSheetId()
    if (!sheetId || !backend.mergeRange) {
      return
    }

    const range = selectionSnapshot().range
    const result = await backend.mergeRange({
      kind: 'merge-range',
      sheetId,
      range,
    })
    recordHistoryEntry({
      sheetId,
      kind: 'range.merge',
      revision: result?.revision,
      affectedRange: result?.affectedRange ?? range,
    })
    await refreshProjection(sheetId)
  }

  async function unmergeSelection() {
    const sheetId = getMutationSheetId()
    if (!sheetId || !backend.unmergeRange) {
      return
    }

    const range = selectionSnapshot().range
    const result = await backend.unmergeRange({
      kind: 'unmerge-range',
      sheetId,
      range,
    })
    recordHistoryEntry({
      sheetId,
      kind: 'range.unmerge',
      revision: result?.revision,
      affectedRange: result?.affectedRange ?? range,
    })
    await refreshProjection(sheetId)
  }

  return (
    <div
      class={`format-toolbar spreadsheet-toolbar ${props.class ?? ''}`.trim()}
      role="toolbar"
      data-testid={props['data-testid'] ?? 'spreadsheet-toolbar'}
    >
      {toolbarCommands.map((command) => {
        const commandValue = { command: command.command, value: command.value }
        const isPressed = () => {
          if (command.command === 'bold') return !!activeCellFormat().bold
          if (command.command === 'italic') return !!activeCellFormat().italic
          if (command.command === 'underline') return !!activeCellFormat().underline
          if (command.command === 'number-format') return numberFormatOpen()
          if (command.command === 'vertical-alignment') {
            // Default vertical alignment (when unset) is 'bottom', per the
            // backend cell-format contract.
            const current = activeCellFormat().verticalAlign ?? 'bottom'
            return current === command.value
          }
          return undefined
        }

        return (
          <button
            type="button"
            class={`fmt-btn spreadsheet-toolbar-button ${
              isPressed() ? 'fmt-btn-active' : ''
            }`.trim()}
            data-testid={command.testId}
            title={t(command.title)}
            aria-label={t(command.title)}
            aria-pressed={isPressed()}
            aria-haspopup={command.command === 'number-format' ? 'menu' : undefined}
            aria-expanded={
              command.command === 'number-format' ? numberFormatOpen() : undefined
            }
            disabled={!command.isEnabled(availability()) || isProtectionGated()}
            onClick={(event) => {
              if (command.command === 'number-format') {
                if (numberFormatOpen()) {
                  closeNumberFormatDropdown()
                } else {
                  openNumberFormatDropdown(event.currentTarget)
                }
                return
              }
              dispatchCommand(commandValue)
            }}
          >
            {t(command.label)}
          </button>
        )
      })}
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-merge-cells"
        title={t('toolbar.merge.title')}
        aria-label={t('toolbar.merge.title')}
        disabled={!canMergeSelection() || isProtectionGated()}
        onClick={() => {
          void mergeSelection().catch(reportCommandError)
        }}
      >
        {t('toolbar.merge')}
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-unmerge-cells"
        title={t('toolbar.unmerge.title')}
        aria-label={t('toolbar.unmerge.title')}
        disabled={!canUnmergeSelection() || isProtectionGated()}
        onClick={() => {
          void unmergeSelection().catch(reportCommandError)
        }}
      >
        {t('toolbar.unmerge')}
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-find"
        title={t('toolbar.find.title')}
        aria-label={t('toolbar.find.title')}
        aria-pressed={findReplaceOpen()}
        onClick={() => {
          store.setter(findReplaceOpenAtom, true)
        }}
      >
        {t('toolbar.find')}
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-print-preview"
        title={t('toolbar.printPreview.title')}
        aria-label={t('toolbar.printPreview.title')}
        aria-pressed={printPreviewOpen()}
        onClick={() => {
          store.setter(togglePrintPreviewAtom)
        }}
      >
        {t('toolbar.printPreview')}
      </button>
      <button
        type="button"
        class={`fmt-btn spreadsheet-toolbar-button ${
          formatPainterState() !== 'idle' ? 'fmt-btn-active' : ''
        }`.trim()}
        data-testid="toolbar-btn-format-painter"
        data-format-painter-state={formatPainterState()}
        title={
          formatPainterState() === 'sticky'
            ? t('toolbar.painter.title.sticky')
            : t('toolbar.painter.title')
        }
        aria-label={t('toolbar.painter')}
        aria-pressed={formatPainterState() !== 'idle'}
        disabled={isProtectionGated()}
        onClick={handleFormatPainterClick}
        onDblClick={handleFormatPainterDoubleClick}
      >
        {t('toolbar.painter')}
      </button>
      <NumberFormatDropdown
        open={numberFormatOpen()}
        anchorRect={numberFormatAnchor()}
        anchorEl={numberFormatAnchorEl}
        onSelect={onNumberFormatPick}
        onClose={closeNumberFormatDropdown}
      />
    </div>
  )
}
