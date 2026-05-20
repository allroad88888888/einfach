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
  pasteClipboardAtom,
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
  type DisplayCell,
  type HistoryEntryKind,
  type SpreadsheetBorders,
  type SpreadsheetBorderStyle,
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
import { BordersDropdown, type BordersPreset } from './BordersDropdown'
import { MergeDropdown, type MergePreset } from './MergeDropdown'
import type { SpreadsheetToolbarProps, SpreadsheetToolbarCommand } from './types'
import { NumberFormatDropdown, type NumberFormatId } from './NumberFormatDropdown'
import { FillColorPopover, colorPopoverAtom, type ColorPopoverMode } from './FillColorPopover'

const BORDER_DEFAULT_STYLE: SpreadsheetBorderStyle = 'thin'

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
    command: 'alignment',
    label: 'toolbar.alignLeft',
    title: 'toolbar.alignLeft.title',
    testId: 'toolbar-btn-align-left',
    value: 'left',
    isEnabled: (availability) => availability.alignment,
  },
  {
    command: 'alignment',
    label: 'toolbar.alignCenter',
    title: 'toolbar.alignCenter.title',
    testId: 'toolbar-btn-align-center',
    value: 'center',
    isEnabled: (availability) => availability.alignment,
  },
  {
    command: 'alignment',
    label: 'toolbar.alignRight',
    title: 'toolbar.alignRight.title',
    testId: 'toolbar-btn-align-right',
    value: 'right',
    isEnabled: (availability) => availability.alignment,
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
    // Univer-parity shortcut — one-click percent format. The token routes
    // through `numberFormatForValue('Percent')` → `{ kind: 'percent', digits: 0 }`.
    command: 'number-format',
    label: 'toolbar.percentFormat',
    title: 'toolbar.percentFormat.title',
    testId: 'toolbar-btn-percent-format',
    value: 'Percent',
    isEnabled: (availability) => availability.numberFormat,
  },
  {
    // Univer-parity shortcut — one-click currency format. The token routes
    // through `numberFormatForValue('Currency')` → `{ kind: 'currency', symbol: '$', digits: 2 }`.
    command: 'number-format',
    label: 'toolbar.currencyFormat',
    title: 'toolbar.currencyFormat.title',
    testId: 'toolbar-btn-currency-format',
    value: 'Currency',
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
  if (format?.borders) clone.borders = { ...format.borders }
  return clone
}

/**
 * Per-cell border patch for a borders dropdown preset.
 *
 * - `all` / `outer` for 1x1 collapse to the same four-sided patch.
 * - `outer` for a multi-cell range tags each cell with only the sides that
 *   touch the selection boundary (corner cells get two sides).
 * - `inner` is the dual of `outer`: each cell gets the sides that touch a
 *   neighbouring selected cell. On a 1x1 the result is empty.
 * - `none` removes all four sides; the toolbar treats that as "clear".
 */
function bordersPatchForCell(
  preset: BordersPreset,
  row: number,
  col: number,
  range: CellRange,
  current: SpreadsheetBorders | undefined,
): SpreadsheetBorders | undefined {
  const isLeftEdge = col === range.colStart
  const isRightEdge = col === range.colEnd
  const isTopEdge = row === range.rowStart
  const isBottomEdge = row === range.rowEnd
  const spec = { style: BORDER_DEFAULT_STYLE }

  switch (preset) {
    case 'none':
      return undefined
    case 'all':
      return { top: spec, right: spec, bottom: spec, left: spec }
    case 'outer': {
      const next: SpreadsheetBorders = { ...(current ?? {}) }
      if (isTopEdge) next.top = spec
      if (isRightEdge) next.right = spec
      if (isBottomEdge) next.bottom = spec
      if (isLeftEdge) next.left = spec
      return next
    }
    case 'inner': {
      const next: SpreadsheetBorders = { ...(current ?? {}) }
      if (!isTopEdge) next.top = spec
      if (!isRightEdge) next.right = spec
      if (!isBottomEdge) next.bottom = spec
      if (!isLeftEdge) next.left = spec
      return next
    }
    case 'top':
      return isTopEdge ? { ...(current ?? {}), top: spec } : current
    case 'right':
      return isRightEdge ? { ...(current ?? {}), right: spec } : current
    case 'bottom':
      return isBottomEdge ? { ...(current ?? {}), bottom: spec } : current
    case 'left':
      return isLeftEdge ? { ...(current ?? {}), left: spec } : current
    default:
      return current
  }
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
      // Toolbar `¥`-shortcut and the dropdown `Currency` row both flow through
      // here. The Format Cells dialog (and the seed currency test fixtures)
      // standardise on `$` so we mirror that to keep the engine output
      // consistent across surfaces.
      return { kind: 'currency', symbol: '$', digits: 2 }
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

  // Borders dropdown lives entirely inside the toolbar component since the
  // backend exposes no toolbar-surface atom for it. We hold the open flag in
  // a local signal — under solid-js 1.9.12 the toolbar body re-executes on
  // atom mutations but `createSignal` survives the re-run.
  const [bordersDropdownOpen, setBordersDropdownOpen] = createSignal(false)
  let bordersAnchorRef: HTMLButtonElement | undefined

  // Merge dropdown mirrors the borders dropdown pattern — local signal, click-
  // outside / Esc handled by the dropdown itself.
  const [mergeDropdownOpen, setMergeDropdownOpen] = createSignal(false)
  let mergeAnchorRef: HTMLButtonElement | undefined

  const colorPopover = useAtomValue(colorPopoverAtom)
  const [anchorRect, setAnchorRect] = createSignal<DOMRect | null>(null)
  const colorAnchors: Partial<Record<ColorPopoverMode, HTMLButtonElement>> = {}

  function toggleColorPopover(mode: ColorPopoverMode) {
    const current = colorPopover().mode
    if (current === mode) {
      store.setter(colorPopoverAtom, { mode: null })
      setAnchorRect(null)
      return
    }
    const anchor = colorAnchors[mode]
    setAnchorRect(anchor ? anchor.getBoundingClientRect() : null)
    store.setter(colorPopoverAtom, { mode })
  }

  function handleColorPick(hex: string) {
    const mode = colorPopover().mode
    if (mode === null) return
    dispatchCommand({
      command: mode === 'fill' ? 'fill-color' : 'text-color',
      value: hex,
    })
  }

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
      case 'fill-color': {
        // Empty-string sentinel from the color popover means "No Fill" — strip
        // bgColor entirely so the cell falls back to the sheet default.
        if (intent.value === '') {
          const { bgColor: _bgColor, ...rest } = current
          return rest
        }
        return { ...current, bgColor: intent.value ?? '#ffd966' }
      }
      case 'text-color': {
        // Empty-string sentinel from the color popover means "Automatic" —
        // strip fgColor so the cell inherits the default text color.
        if (intent.value === '') {
          const { fgColor: _fgColor, ...rest } = current
          return rest
        }
        return { ...current, fgColor: intent.value ?? '#000000' }
      }
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
      case 'border': {
        // Toolbar borders dropdown drives this command. The actual per-cell
        // patch is applied via `executeBordersPreset` (which fans out
        // setFormatRange calls so corner/edge cells get distinct sides). The
        // single-format path here only fires when callers dispatch the
        // 'border' command directly with a value of 'all' or 'none', which
        // happens in unit tests and from older intents.
        const spec = { style: BORDER_DEFAULT_STYLE }
        if (intent.value === 'none') {
          const next = { ...current }
          delete next.borders
          return next
        }
        return {
          ...current,
          borders: { top: spec, right: spec, bottom: spec, left: spec },
        }
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

  function projectionCellMap(): Map<string, DisplayCell> {
    const snapshot = projectionSnapshot()
    const result = snapshot.result
    const map = new Map<string, DisplayCell>()
    if (!isVisibleProjectionResult(result)) return map
    const selection = selectionSnapshot()
    if (result.sheetId !== selection.selection.sheetId) return map
    for (const cell of result.cells) {
      map.set(`${cell.row}:${cell.col}`, cell)
    }
    return map
  }

  /**
   * Fan out per-cell `setFormatRange` calls for a borders dropdown preset.
   *
   * Each cell in the selection gets a 1x1 range write that merges the new
   * border sides over that cell's current format (read from the projection
   * snapshot). Issuing one call per cell preserves per-cell distinct formats
   * (`setFormatRange` clobbers cell formats within the range, so a single
   * range-wide call would lose any pre-existing variation).
   */
  async function executeBordersPreset(
    preset: BordersPreset,
    sheetId: string,
    range: CellRange,
  ) {
    if (!backend.setFormatRange) {
      throw new Error('Range formatting is not supported by this spreadsheet backend.')
    }

    const cells = projectionCellMap()

    for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
      for (let col = range.colStart; col <= range.colEnd; col += 1) {
        const existing = cells.get(`${row}:${col}`)
        const currentFormat = cloneFormat(existing?.format)
        const nextBorders = bordersPatchForCell(preset, row, col, range, currentFormat.borders)
        const nextFormat: SpreadsheetCellFormat = { ...currentFormat }
        if (nextBorders === undefined || Object.keys(nextBorders).length === 0) {
          delete nextFormat.borders
        } else {
          nextFormat.borders = nextBorders
        }
        await backend.setFormatRange({
          kind: 'set-format-range',
          sheetId,
          range: { rowStart: row, rowEnd: row, colStart: col, colEnd: col },
          format: nextFormat,
        })
      }
    }

    recordHistoryEntry({
      sheetId,
      kind: 'format.set',
      revision: undefined,
      affectedRange: range,
    })

    await refreshProjection(sheetId)
  }

  function handleBordersSelect(preset: BordersPreset) {
    setBordersDropdownOpen(false)
    const range = selectionSnapshot().range
    const isMulti = rangeCellCount(range) > 1
    if (preset === 'inner' && !isMulti) {
      // 1x1 inner is a no-op by definition.
      return
    }
    const sheetId = getMutationSheetId()
    if (!sheetId) return
    void executeBordersPreset(preset, sheetId, range).catch(reportCommandError)
  }

  function getMutationSheetId() {
    const snapshot = selectionSnapshot()
    return snapshot.selection.sheetId || availability().sheetId
  }

  /**
   * Merged range that contains the active cell, if any. Returns null when the
   * active cell sits in a plain (non-merged) cell. This is what drives the
   * "取消合并" item — the user may have a 1x1 selection inside a merged
   * region and still expect unmerge to work.
   *
   * The projection emits one anchor row per merged region (with `mergedSpan`).
   * Covered cells may or may not appear — when they do they carry
   * `mergeAnchor` pointing back at the anchor's coords. The lookup below
   * handles both shapes by scanning all anchors and testing range containment.
   */
  function activeCellMergeRange(): CellRange | null {
    const snapshot = projectionSnapshot()
    const result = snapshot.result
    if (!isVisibleProjectionResult(result)) return null
    const selection = selectionSnapshot()
    if (result.sheetId !== selection.selection.sheetId) return null
    const active = selection.activeCell

    for (const anchor of result.cells) {
      if (!anchor.mergedSpan) continue
      const rows = Math.max(1, Math.trunc(anchor.mergedSpan.rows))
      const cols = Math.max(1, Math.trunc(anchor.mergedSpan.cols))
      const range: CellRange = {
        rowStart: anchor.row,
        rowEnd: anchor.row + rows - 1,
        colStart: anchor.col,
        colEnd: anchor.col + cols - 1,
      }
      if (
        active.row >= range.rowStart &&
        active.row <= range.rowEnd &&
        active.col >= range.colStart &&
        active.col <= range.colEnd
      ) {
        return range
      }
    }

    return null
  }

  /**
   * Dispatch handler for the merge dropdown. Each preset issues one or more
   * `mergeRange` / `unmergeRange` calls and then a single history entry.
   */
  async function executeMergePreset(preset: MergePreset) {
    const sheetId = getMutationSheetId()
    if (!sheetId) return

    const selectionRange = selectionSnapshot().range

    if (preset === 'unmerge') {
      if (!backend.unmergeRange) return
      // Prefer the active-cell merge range so a 1x1 selection inside a merge
      // still unmerges the full region; fall back to the raw selection.
      const targetRange = activeCellMergeRange() ?? selectionRange
      const result = await backend.unmergeRange({
        kind: 'unmerge-range',
        sheetId,
        range: targetRange,
      })
      recordHistoryEntry({
        sheetId,
        kind: 'range.unmerge',
        revision: result?.revision,
        affectedRange: result?.affectedRange ?? targetRange,
      })
      await refreshProjection(sheetId)
      return
    }

    if (!backend.mergeRange) return

    if (preset === 'merge-center') {
      // The dropdown promises "合并居中" (merge + center) but the backend
      // exposes no compound transaction port — issuing a separate
      // `setFormatRange` after the merge would put the centering on its own
      // undo step, breaking the timeline contract that one user action equals
      // one undo. Until a compound-transaction port lands we ship just the
      // merge here so undo reverses the user's click in one move.
      const result = await backend.mergeRange({
        kind: 'merge-range',
        sheetId,
        range: selectionRange,
      })
      recordHistoryEntry({
        sheetId,
        kind: 'range.merge',
        revision: result?.revision,
        affectedRange: result?.affectedRange ?? selectionRange,
      })
      await refreshProjection(sheetId)
      return
    }

    if (preset === 'across-rows') {
      // Merge each row of the selection independently. Univer labels this
      // 跨列合并 — within each row the cells across columns collapse.
      let lastAffected: CellRange | undefined
      for (let row = selectionRange.rowStart; row <= selectionRange.rowEnd; row += 1) {
        if (selectionRange.colEnd <= selectionRange.colStart) break
        const rowRange: CellRange = {
          rowStart: row,
          rowEnd: row,
          colStart: selectionRange.colStart,
          colEnd: selectionRange.colEnd,
        }
        const result = await backend.mergeRange({
          kind: 'merge-range',
          sheetId,
          range: rowRange,
        })
        lastAffected = result?.affectedRange ?? rowRange
      }
      recordHistoryEntry({
        sheetId,
        kind: 'range.merge',
        revision: undefined,
        affectedRange: lastAffected ?? selectionRange,
      })
      await refreshProjection(sheetId)
      return
    }

    if (preset === 'across-cols') {
      // Merge each column of the selection independently. Univer labels this
      // 跨行合并 — within each column the cells across rows collapse.
      let lastAffected: CellRange | undefined
      for (let col = selectionRange.colStart; col <= selectionRange.colEnd; col += 1) {
        if (selectionRange.rowEnd <= selectionRange.rowStart) break
        const colRange: CellRange = {
          rowStart: selectionRange.rowStart,
          rowEnd: selectionRange.rowEnd,
          colStart: col,
          colEnd: col,
        }
        const result = await backend.mergeRange({
          kind: 'merge-range',
          sheetId,
          range: colRange,
        })
        lastAffected = result?.affectedRange ?? colRange
      }
      recordHistoryEntry({
        sheetId,
        kind: 'range.merge',
        revision: undefined,
        affectedRange: lastAffected ?? selectionRange,
      })
      await refreshProjection(sheetId)
      return
    }
  }

  function handleMergeSelect(preset: MergePreset) {
    setMergeDropdownOpen(false)
    void executeMergePreset(preset).catch(reportCommandError)
  }

  /**
   * Univer-parity "Paste" toolbar shortcut.
   *
   * Mirrors the menu-bar Edit > Paste route: stamps the clipboard intent for
   * the active selection. The real paste work (text-from-OS-clipboard,
   * intra-app TSV chunks, etc.) is owned by `SpreadsheetGrid` and
   * `SpreadsheetContextMenu`; this button only fires the intent so those
   * handlers can react. When no sheet is active (initial blank state) it is
   * a no-op.
   */
  function dispatchPasteIntent() {
    const snapshot = selectionSnapshot()
    const sheetId = snapshot.selection.sheetId || getMutationSheetId() || ''
    if (!sheetId) return
    store.setter(pasteClipboardAtom, {
      source: { sheetId, range: snapshot.range },
    })
  }

  return (
    <div
      class={`format-toolbar spreadsheet-toolbar ${props.class ?? ''}`.trim()}
      role="toolbar"
      data-testid={props['data-testid'] ?? 'spreadsheet-toolbar'}
    >
      {toolbarCommands.map((command) => {
        const commandValue = { command: command.command, value: command.value }
        const colorMode: ColorPopoverMode | null =
          command.command === 'fill-color'
            ? 'fill'
            : command.command === 'text-color'
              ? 'text'
              : null
        // The Univer-parity %/¥ shortcuts re-use `command: 'number-format'`
        // but dispatch a fixed value directly — only the canonical
        // `toolbar-btn-number-format` entry opens the catalog dropdown.
        const isNumberFormatDropdownOpener =
          command.command === 'number-format' && command.testId === 'toolbar-btn-number-format'
        const isPressed = () => {
          if (command.command === 'bold') return !!activeCellFormat().bold
          if (command.command === 'italic') return !!activeCellFormat().italic
          if (command.command === 'underline') return !!activeCellFormat().underline
          if (isNumberFormatDropdownOpener) return numberFormatOpen()
          if (command.command === 'alignment') {
            return activeCellFormat().align === command.value
          }
          if (command.command === 'vertical-alignment') {
            // Default vertical alignment (when unset) is 'bottom', per the
            // backend cell-format contract.
            const current = activeCellFormat().verticalAlign ?? 'bottom'
            return current === command.value
          }
          if (colorMode !== null) return colorPopover().mode === colorMode
          return undefined
        }

        return (
          <button
            type="button"
            ref={(el) => {
              if (colorMode) colorAnchors[colorMode] = el
            }}
            class={`fmt-btn spreadsheet-toolbar-button ${
              isPressed() ? 'fmt-btn-active' : ''
            }`.trim()}
            data-testid={command.testId}
            title={t(command.title)}
            aria-label={t(command.title)}
            aria-pressed={isPressed()}
            aria-haspopup={
              isNumberFormatDropdownOpener
                ? 'menu'
                : colorMode
                  ? 'dialog'
                  : undefined
            }
            aria-expanded={
              isNumberFormatDropdownOpener
                ? numberFormatOpen()
                : colorMode
                  ? colorPopover().mode === colorMode
                  : undefined
            }
            disabled={!command.isEnabled(availability()) || isProtectionGated()}
            onClick={(event) => {
              if (isNumberFormatDropdownOpener) {
                if (numberFormatOpen()) {
                  closeNumberFormatDropdown()
                } else {
                  openNumberFormatDropdown(event.currentTarget)
                }
                return
              }
              if (colorMode) {
                toggleColorPopover(colorMode)
                return
              }
              dispatchCommand(commandValue)
            }}
          >
            {t(command.label)}
          </button>
        )
      })}
      <div
        class="spreadsheet-toolbar-borders-wrapper"
        style={{ position: 'relative', display: 'inline-flex' }}
      >
        <button
          ref={(el) => (bordersAnchorRef = el)}
          type="button"
          class={`fmt-btn spreadsheet-toolbar-button ${
            bordersDropdownOpen() ? 'fmt-btn-active' : ''
          }`.trim()}
          data-testid="toolbar-btn-borders"
          title={t('toolbar.borders.title')}
          aria-label={t('toolbar.borders.title')}
          aria-haspopup="menu"
          aria-expanded={bordersDropdownOpen()}
          disabled={!availability().border || isProtectionGated()}
          onClick={() => {
            setBordersDropdownOpen((open) => !open)
          }}
        >
          {t('toolbar.borders')}
        </button>
        <BordersDropdown
          isOpen={bordersDropdownOpen()}
          isMultiCell={rangeCellCount(selectionSnapshot().range) > 1}
          anchorRef={bordersAnchorRef ?? null}
          onSelect={handleBordersSelect}
          onRequestClose={() => setBordersDropdownOpen(false)}
        />
      </div>
      <div
        class="spreadsheet-toolbar-merge-wrapper"
        style={{ position: 'relative', display: 'inline-flex' }}
      >
        <button
          ref={(el) => (mergeAnchorRef = el)}
          type="button"
          class={`fmt-btn spreadsheet-toolbar-button ${
            mergeDropdownOpen() ? 'fmt-btn-active' : ''
          }`.trim()}
          data-testid="toolbar-btn-merge"
          title={t('toolbar.merge.title')}
          aria-label={t('toolbar.merge.title')}
          aria-haspopup="menu"
          aria-expanded={mergeDropdownOpen()}
          disabled={!backend.mergeRange || availability().editingMode === 'drafting' || isProtectionGated()}
          onClick={() => {
            setMergeDropdownOpen((open) => !open)
          }}
        >
          {t('toolbar.merge')}
        </button>
        <MergeDropdown
          isOpen={mergeDropdownOpen()}
          isMultiCell={rangeCellCount(selectionSnapshot().range) > 1}
          canUnmerge={activeCellMergeRange() !== null}
          anchorRef={mergeAnchorRef ?? null}
          onSelect={handleMergeSelect}
          onRequestClose={() => setMergeDropdownOpen(false)}
        />
      </div>
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
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-paste"
        title={t('toolbar.paste.title')}
        aria-label={t('toolbar.paste.title')}
        disabled={isProtectionGated()}
        onClick={dispatchPasteIntent}
      >
        {t('toolbar.paste')}
      </button>
      <NumberFormatDropdown
        open={numberFormatOpen()}
        anchorRect={numberFormatAnchor()}
        anchorEl={numberFormatAnchorEl}
        onSelect={onNumberFormatPick}
        onClose={closeNumberFormatDropdown}
      />
      <FillColorPopover anchorRect={anchorRect} onPick={handleColorPick} />
    </div>
  )
}
