import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  armFormatPainterAtom,
  armFormatPainterStickyAtom,
  canRedoAtom,
  canUndoAtom,
  dispatchSortAtom,
  dispatchToolbarFormatCommandAtom,
  exitFormatPainterAtom,
  findReplaceOpenAtom,
  formatPainterStateAtom,
  nextHistoryTransactionId,
  openCommentSessionAtom,
  openConditionalFormatEditorAtom,
  openFilterDropdownAtom,
  openFormatCellsAtom,
  openNameManagerAtom,
  openValidationRuleEditorAtom,
  printPreviewOpenAtom,
  pushHistoryAtom,
  selectionSnapshotAtom,
  toolbarCommandAvailabilityAtom,
  activeCellLockedAtom,
  selectionLockedAtom,
  type CapturedFormat,
  type CellRange,
  type DisplayCell,
  type HistoryEntryKind,
  type SortDirection,
  type SpreadsheetBorders,
  type SpreadsheetBorderStyle,
  type SpreadsheetCellFormat,
  type SpreadsheetNumberFormat,
  type ToolbarFormatCommandInput,
  type ToolbarFormatCommandIntent,
} from '@einfach/spreadsheet-ui-core'

import {
  isVisibleProjectionResult,
  refreshVisibleProjection,
  spreadsheetProjectionSnapshotAtom,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'
import { dispatchRedo, dispatchUndo } from '../provider/history-dispatch'
import { BordersDropdown, type BordersPreset } from './BordersDropdown'
import { HAlignDropdown, type HAlignValue } from './HAlignDropdown'
import { MergeDropdown, type MergePreset } from './MergeDropdown'
import { VAlignDropdown, type VAlignValue } from './VAlignDropdown'
import type { SpreadsheetToolbarProps, SpreadsheetToolbarCommand } from './types'
import { NumberFormatDropdown, type NumberFormatId } from './NumberFormatDropdown'
import { FillColorPopover, colorPopoverAtom, type ColorPopoverMode } from './FillColorPopover'
import { DEFAULT_FONT_FAMILY, FontFamilyDropdown } from './FontFamilyDropdown'
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FontSizeDropdown,
} from './FontSizeDropdown'
import { RotationDropdown, type RotationPreset } from './RotationDropdown'
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  BordersIcon,
  ChevronDownIcon,
  ClearFormatIcon,
  CommentIcon,
  ConditionalFormatIcon,
  CurrencyIcon,
  DataValidationIcon,
  DecreaseDecimalIcon,
  FillColorIcon,
  FilterIcon,
  FindReplaceIcon,
  FontSizeDownIcon,
  FontSizeUpIcon,
  FormatPainterIcon,
  IncreaseDecimalIcon,
  ItalicIcon,
  MergeCellsIcon,
  NameManagerIcon,
  PercentIcon,
  PrintIcon,
  RedoIcon,
  RotationIcon,
  SortIcon,
  StrikethroughIcon,
  TextColorIcon,
  UnderlineIcon,
  UndoIcon,
  VAlignBottomIcon,
  VAlignMiddleIcon,
  VAlignTopIcon,
  WrapIcon,
} from './ToolbarIcons'

const BORDER_DEFAULT_STYLE: SpreadsheetBorderStyle = 'thin'

/**
 * Bold / Italic / Underline / Strikethrough — the four "toggle on selection"
 * buttons that share identical JSX. Kept as a map-rendered group so each one
 * picks up consistent pressed-state styling. Color buttons + number-format
 * shortcuts + wrap render as their own standalone JSX below.
 */
const textStyleCommands: SpreadsheetToolbarCommand[] = [
  {
    command: 'bold',
    label: 'toolbar.bold',
    title: 'toolbar.bold.title',
    testId: 'toolbar-btn-bold',
    isEnabled: (availability) => availability.bold,
    icon: BoldIcon,
  },
  {
    command: 'italic',
    label: 'toolbar.italic',
    title: 'toolbar.italic.title',
    testId: 'toolbar-btn-italic',
    isEnabled: (availability) => availability.italic,
    icon: ItalicIcon,
  },
  {
    command: 'underline',
    label: 'toolbar.underline',
    title: 'toolbar.underline.title',
    testId: 'toolbar-btn-underline',
    isEnabled: (availability) => availability.underline,
    icon: UnderlineIcon,
  },
  {
    command: 'strikethrough',
    label: 'toolbar.strikethrough',
    title: 'toolbar.strikethrough.title',
    testId: 'toolbar-btn-strikethrough',
    isEnabled: (availability) => availability.strikethrough,
    icon: StrikethroughIcon,
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

/**
 * Minimal asc/desc dropdown that pairs with the Sort toolbar button. Inlined
 * here (rather than living in `filter-sort/`) because it only carries two
 * static options and mirrors the MergeDropdown layout — pulling it into its
 * own module would just add an import for ~30 lines of JSX.
 */
interface SortDropdownProps {
  isOpen: boolean
  anchorRef?: HTMLElement | null
  onSelect: (direction: SortDirection) => void
  onRequestClose: () => void
  /** Translator from the parent toolbar; avoids a second `useT()` call. */
  t: (key: string) => string
}

function SortDropdown(props: SortDropdownProps) {
  let rootRef: HTMLDivElement | undefined

  function onDocPointerDown(event: MouseEvent) {
    if (!rootRef) return
    const target = event.target as Node | null
    if (!target) return
    if (rootRef.contains(target)) return
    if (props.anchorRef && props.anchorRef.contains(target)) return
    props.onRequestClose()
  }

  function onDocKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      props.onRequestClose()
    }
  }

  onMount(() => {
    document.addEventListener('mousedown', onDocPointerDown, true)
    document.addEventListener('keydown', onDocKeyDown)
  })

  onCleanup(() => {
    document.removeEventListener('mousedown', onDocPointerDown, true)
    document.removeEventListener('keydown', onDocKeyDown)
  })

  const options: Array<{ direction: SortDirection; labelKey: string; testId: string }> = [
    { direction: 'asc', labelKey: 'toolbar.sort.asc', testId: 'toolbar-sort-asc' },
    { direction: 'desc', labelKey: 'toolbar.sort.desc', testId: 'toolbar-sort-desc' },
  ]

  return (
    <Show when={props.isOpen}>
      <div
        ref={rootRef}
        class="spreadsheet-toolbar-sort-dropdown"
        role="menu"
        data-testid="toolbar-sort-dropdown"
        style={{
          position: 'absolute',
          top: '100%',
          left: '0',
          'z-index': 30,
          'min-width': '140px',
          background: '#fff',
          border: '1px solid #d0d0d0',
          'box-shadow': '0 4px 12px rgba(0,0,0,0.12)',
          display: 'flex',
          'flex-direction': 'column',
          padding: '4px 0',
        }}
      >
        <For each={options}>
          {(option) => (
            <button
              type="button"
              class="spreadsheet-toolbar-sort-option"
              role="menuitem"
              data-testid={option.testId}
              style={{
                padding: '4px 12px',
                'text-align': 'left',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                font: 'inherit',
              }}
              onClick={() => props.onSelect(option.direction)}
            >
              {props.t(option.labelKey)}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
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

  // Horizontal / vertical alignment dropdowns mirror the borders surface —
  // a single toolbar anchor button reveals 3 options.
  const [hAlignDropdownOpen, setHAlignDropdownOpen] = createSignal(false)
  let hAlignAnchorRef: HTMLButtonElement | undefined
  const [vAlignDropdownOpen, setVAlignDropdownOpen] = createSignal(false)
  let vAlignAnchorRef: HTMLButtonElement | undefined

  // Font-family / font-size dropdown open-state + anchors.
  const [fontFamilyOpen, setFontFamilyOpen] = createSignal(false)
  const [fontFamilyAnchor, setFontFamilyAnchor] = createSignal<DOMRect | null>(null)
  let fontFamilyAnchorEl: HTMLButtonElement | null = null
  const [fontSizeOpen, setFontSizeOpen] = createSignal(false)
  const [fontSizeAnchor, setFontSizeAnchor] = createSignal<DOMRect | null>(null)
  let fontSizeAnchorEl: HTMLButtonElement | null = null

  function currentHAlign(): HAlignValue {
    const align = activeCellFormat().align
    return align === 'center' || align === 'right' ? align : 'left'
  }

  function currentVAlign(): VAlignValue {
    // Default vertical alignment (when unset) is 'bottom', per the backend
    // cell-format contract.
    const value = activeCellFormat().verticalAlign ?? 'bottom'
    return value === 'top' || value === 'center' ? value : 'bottom'
  }

  function handleHAlignSelect(value: HAlignValue) {
    setHAlignDropdownOpen(false)
    dispatchCommand({ command: 'alignment', value })
  }

  function handleVAlignSelect(value: VAlignValue) {
    setVAlignDropdownOpen(false)
    dispatchCommand({ command: 'vertical-alignment', value })
  }

  // Rotation dropdown mirrors the borders pattern — local signal, anchored to
  // its own toolbar button.
  const [rotationDropdownOpen, setRotationDropdownOpen] = createSignal(false)
  let rotationAnchorRef: HTMLButtonElement | undefined

  // Sort dropdown — minimal asc/desc menu, inlined rather than living in its
  // own file since it only carries two static options.
  const [sortDropdownOpen, setSortDropdownOpen] = createSignal(false)
  let sortAnchorRef: HTMLButtonElement | undefined

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

  function openFontFamilyDropdown(buttonEl: HTMLButtonElement) {
    fontFamilyAnchorEl = buttonEl
    setFontFamilyAnchor(buttonEl.getBoundingClientRect())
    setFontFamilyOpen(true)
  }

  function closeFontFamilyDropdown() {
    setFontFamilyOpen(false)
    setFontFamilyAnchor(null)
  }

  function onFontFamilyPick(family: string) {
    closeFontFamilyDropdown()
    dispatchCommand({ command: 'font-family', value: family })
  }

  function openFontSizeDropdown(buttonEl: HTMLButtonElement) {
    fontSizeAnchorEl = buttonEl
    setFontSizeAnchor(buttonEl.getBoundingClientRect())
    setFontSizeOpen(true)
  }

  function closeFontSizeDropdown() {
    setFontSizeOpen(false)
    setFontSizeAnchor(null)
  }

  function onFontSizePick(size: number) {
    closeFontSizeDropdown()
    dispatchCommand({ command: 'font-size', value: String(size) })
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

  /**
   * Drives the Clear-Format button's disabled state: when the active cell
   * carries no format overrides, clicking would be a no-op so the button
   * stays greyed out. Matches Univer behavior (the slim toolbar greys out
   * the eraser when the focused cell has nothing to clear).
   *
   * Tracks the active cell only — not every cell in the selection range —
   * because that's both the Univer convention and the natural "what does
   * the toolbar reflect about the focused cell?" model.
   */
  function activeCellHasFormat(): boolean {
    const f = activeCellFormat()
    for (const key in f) {
      const value = (f as Record<string, unknown>)[key]
      if (value === undefined || value === null || value === false) continue
      if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) continue
      return true
    }
    return false
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
      case 'strikethrough':
        return { ...current, strikethrough: !current.strikethrough }
      case 'wrap':
        return { ...current, wrap: !current.wrap }
      case 'rotation': {
        // Empty-string / null sentinel clears the rotation. A numeric token
        // ('0' included) commits the degrees; 'vertical' switches to stacked
        // text via CSS writing-mode.
        if (intent.value === '' || intent.value === null) {
          const { rotation: _rotation, ...rest } = current
          return rest
        }
        if (intent.value === 'vertical') {
          return { ...current, rotation: 'vertical' }
        }
        const parsed = Number(intent.value)
        if (!Number.isFinite(parsed)) return current
        return { ...current, rotation: Math.max(-90, Math.min(90, Math.round(parsed))) }
      }
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
      case 'font-family': {
        if (!intent.value) {
          const { fontFamily: _ff, ...rest } = current
          return rest
        }
        return { ...current, fontFamily: intent.value }
      }
      case 'font-size': {
        const parsed = intent.value ? Number(intent.value) : NaN
        if (!Number.isFinite(parsed)) return current
        const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(parsed)))
        return { ...current, fontSize: clamped }
      }
      case 'font-size-up': {
        const base = current.fontSize ?? DEFAULT_FONT_SIZE
        const next = Math.min(FONT_SIZE_MAX, base + 1)
        return { ...current, fontSize: next }
      }
      case 'font-size-down': {
        const base = current.fontSize ?? DEFAULT_FONT_SIZE
        const next = Math.max(FONT_SIZE_MIN, base - 1)
        return { ...current, fontSize: next }
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
    await refreshVisibleProjection(store, backend, intent.sheetId)
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

    await refreshVisibleProjection(store, backend, sheetId)
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

  function handleRotationSelect(preset: RotationPreset) {
    setRotationDropdownOpen(false)
    // Serialize the SpreadsheetRotation through the existing string-valued
    // command channel. The receiving `commandFormat` arm parses 'vertical'
    // and numeric tokens back into the union value.
    const value: string = preset === 'vertical' ? 'vertical' : String(preset as number)
    dispatchCommand({ command: 'rotation', value })
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
      await refreshVisibleProjection(store, backend, sheetId)
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
      await refreshVisibleProjection(store, backend, sheetId)
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
      await refreshVisibleProjection(store, backend, sheetId)
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
      await refreshVisibleProjection(store, backend, sheetId)
      return
    }
  }

  function handleMergeSelect(preset: MergePreset) {
    setMergeDropdownOpen(false)
    void executeMergePreset(preset).catch(reportCommandError)
  }

  // === New group: Find/Replace, Conditional format, Data validation,
  // Filter, Sort, Name manager. All six dispatch into existing spreadsheet-
  // ui-core atoms — the dialog/dropdown components subscribe to those atoms
  // and render themselves; the toolbar just opens them.

  function handleOpenFindReplace() {
    store.setter(findReplaceOpenAtom, true)
  }

  function handleOpenConditionalFormat() {
    // openConditionalFormatEditorAtom takes an optional existing rule entry.
    // Passing null opens the editor in "new rule" mode; the dialog itself
    // reads selectionSnapshot when committing the rule, so we don't need to
    // pre-bind a range here.
    store.setter(openConditionalFormatEditorAtom, null)
  }

  function handleOpenDataValidation() {
    const sheetId = getMutationSheetId()
    if (!sheetId) return
    const range = selectionSnapshot().range
    store.setter(openValidationRuleEditorAtom, { range })
  }

  function handleOpenFilterDropdown() {
    const sheetId = getMutationSheetId()
    if (!sheetId) return
    const colIndex = selectionSnapshot().activeCell.col
    store.setter(openFilterDropdownAtom, { sheetId, colIndex })
  }

  function handleSortSelect(direction: SortDirection) {
    setSortDropdownOpen(false)
    const sheetId = getMutationSheetId()
    if (!sheetId) return
    const colIndex = selectionSnapshot().activeCell.col
    const next = store.setter(dispatchSortAtom, { sheetId, colIndex, direction })
    if (!backend.setFilterSort) return
    void (async () => {
      try {
        await backend.setFilterSort!({
          kind: 'set-filter-sort',
          sheetId,
          rules: next.rules,
          directives: next.directives,
        })
        await refreshVisibleProjection(store, backend, sheetId)
      } catch (error) {
        reportCommandError(error)
      }
    })()
  }

  function handleOpenNameManager() {
    store.setter(openNameManagerAtom, { status: 'editing-new' })
  }

  /**
   * Univer-parity undo / redo handlers. The same atoms drive the history
   * timeline panel; the toolbar buttons piggyback on that flow so undo state
   * stays consistent across surfaces.
   */
  async function handleUndo() {
    await dispatchUndo(store, backend)
  }

  async function handleRedo() {
    await dispatchRedo(store, backend)
  }

  /**
   * Clear-formatting handler. Issues a direct `setFormatRange` with an empty
   * format object, bypassing `dispatchToolbarFormatCommandAtom` because the
   * spreadsheet-ui-core contract has no `clear-format` kind today and the
   * toolbar already owns the projection refresh path. History entry kind
   * stays `'format.set'` so undo treats it like any other range format
   * mutation.
   */
  async function handleClearFormat() {
    if (!backend.setFormatRange) return
    const sheetId = getMutationSheetId()
    if (!sheetId) return
    const range = selectionSnapshot().range
    try {
      const result = await backend.setFormatRange({
        kind: 'set-format-range',
        sheetId,
        range,
        format: {},
      })
      recordHistoryEntry({
        sheetId,
        kind: 'format.set',
        revision: result?.revision,
        affectedRange: result?.affectedRange ?? range,
      })
      await refreshVisibleProjection(store, backend, sheetId)
    } catch (error) {
      reportCommandError(error)
    }
  }

  /**
   * Open the print preview overlay. Mirrors the menu-bar handler in
   * `SpreadsheetMenuBar.tsx` but writes the open flag directly (rather than
   * toggling) so the toolbar button always lands on "open" — re-clicking the
   * button while the overlay is up is rare enough that the toggle path was
   * not worth the surprise of "click does nothing while overlay is visible".
   */
  function handlePrintPreview() {
    store.setter(printPreviewOpenAtom, true)
  }

  /**
   * Open a comment session for the active cell. Same wiring as the menu bar
   * 'open-comment-session' branch — pulls a fresh `selectionSnapshot` so the
   * session anchors on the live active cell.
   */
  function handleOpenComment() {
    const snap = store.getter(selectionSnapshotAtom)
    const sheetId = snap.selection.sheetId || availability().sheetId
    if (!sheetId) return
    store.setter(openCommentSessionAtom, {
      sheetId,
      cell: snap.activeCell,
    })
  }

  /**
   * Kinds whose `digits` field the increase/decrease decimal buttons can bump.
   * `'decimal'` is the deprecated alias for `'number'` (per
   * `vanilla/spreadsheet-ui-core/src/backend/types.ts`); both share the same
   * digits semantics so they're treated as one.
   */
  type DecimalCapableKind =
    | 'number'
    | 'decimal'
    | 'percent'
    | 'currency'
    | 'accounting'
    | 'scientific'

  function isDecimalCapableFormat(
    nf: SpreadsheetNumberFormat | undefined,
  ): nf is SpreadsheetNumberFormat & { kind: DecimalCapableKind; digits?: number } {
    if (!nf) return false
    return (
      nf.kind === 'number' ||
      nf.kind === 'decimal' ||
      nf.kind === 'percent' ||
      nf.kind === 'currency' ||
      nf.kind === 'accounting' ||
      nf.kind === 'scientific'
    )
  }

  /**
   * Returns the current `digits` on the active cell's number format. Defaults
   * to `0` when the cell is on a non-decimal-capable kind (e.g. `'general'`,
   * `'text'`, or no format at all) — the increase button's first click will
   * then promote that cell into `{ kind: 'decimal', digits: 1 }`.
   */
  function currentDecimalDigits(): number {
    const nf = activeCellFormat().numberFormat
    if (!isDecimalCapableFormat(nf)) return 0
    return Math.max(0, nf.digits ?? 0)
  }

  /**
   * Increase / decrease the digit count by 1. For non-decimal-capable kinds
   * the increase path swaps in `{ kind: 'decimal', digits: 1, thousands: false }`
   * so the cell starts displaying a single fractional digit; the decrease
   * path is a no-op there because there is no `digits` to remove.
   */
  function adjustDigits(direction: 'increase' | 'decrease') {
    if (!backend.setFormatRange) return
    const sheetId = getMutationSheetId()
    if (!sheetId) return
    const range = selectionSnapshot().range
    const currentFormat = activeCellFormat()
    const nf = currentFormat.numberFormat
    const nextFormat: SpreadsheetCellFormat = { ...currentFormat }
    if (isDecimalCapableFormat(nf)) {
      const current = nf.digits ?? 0
      const nextDigits =
        direction === 'increase' ? current + 1 : Math.max(0, current - 1)
      if (nextDigits === current) return
      nextFormat.numberFormat = { ...nf, digits: nextDigits } as SpreadsheetNumberFormat
    } else {
      if (direction === 'decrease') return
      nextFormat.numberFormat = { kind: 'decimal', digits: 1, thousands: false }
    }
    void backend
      .setFormatRange({
        kind: 'set-format-range',
        sheetId,
        range,
        format: nextFormat,
      })
      .then((result) => {
        recordHistoryEntry({
          sheetId,
          kind: 'format.set',
          revision: result?.revision,
          affectedRange: result?.affectedRange ?? range,
        })
        return refreshVisibleProjection(store, backend, sheetId)
      })
      .catch(reportCommandError)
  }

  const canUndo = useAtomValue(canUndoAtom)
  const canRedo = useAtomValue(canRedoAtom)

  /**
   * Render helper for the text-style row (bold/italic/underline/strikethrough)
   * and the two color buttons. Pulled out so both groups reuse the same
   * pressed-state + disabled-state JSX without re-deriving per call site.
   */
  function renderTextStyleButton(command: SpreadsheetToolbarCommand) {
    const commandValue = { command: command.command, value: command.value }
    const isPressed = () => {
      if (command.command === 'bold') return !!activeCellFormat().bold
      if (command.command === 'italic') return !!activeCellFormat().italic
      if (command.command === 'underline') return !!activeCellFormat().underline
      if (command.command === 'strikethrough') return !!activeCellFormat().strikethrough
      return undefined
    }

    return (
      <button
        type="button"
        class={`fmt-btn spreadsheet-toolbar-button ${
          isPressed() ? 'fmt-btn-active' : ''
        }`.trim()}
        data-testid={command.testId}
        data-tooltip={t(command.title)}
        aria-label={t(command.title)}
        aria-pressed={isPressed()}
        disabled={!command.isEnabled(availability()) || isProtectionGated()}
        onClick={() => dispatchCommand(commandValue)}
      >
        {command.icon ? command.icon() : t(command.label)}
      </button>
    )
  }

  function renderColorButton(mode: ColorPopoverMode) {
    const isText = mode === 'text'
    const testId = isText ? 'toolbar-btn-text-color' : 'toolbar-btn-fill-color'
    const titleKey = isText ? 'toolbar.textColor.title' : 'toolbar.fillColor.title'
    const isEnabled = () => (isText ? availability().textColor : availability().fillColor)
    const isPressed = () => colorPopover().mode === mode
    const Icon = isText ? TextColorIcon : FillColorIcon

    return (
      <button
        type="button"
        ref={(el) => {
          colorAnchors[mode] = el
        }}
        class={`fmt-btn spreadsheet-toolbar-button ${
          isPressed() ? 'fmt-btn-active' : ''
        }`.trim()}
        data-testid={testId}
        data-tooltip={t(titleKey)}
        aria-label={t(titleKey)}
        aria-haspopup="dialog"
        aria-expanded={isPressed()}
        disabled={!isEnabled() || isProtectionGated()}
        onClick={() => toggleColorPopover(mode)}
      >
        <Icon />
      </button>
    )
  }

  return (
    <div
      class={`format-toolbar spreadsheet-toolbar ${props.class ?? ''}`.trim()}
      role="toolbar"
      data-testid={props['data-testid'] ?? 'spreadsheet-toolbar'}
    >
      {/* Group 1 — History + format painter + clear */}
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-undo"
        data-tooltip={t('toolbar.undo.title')}
        aria-label={t('toolbar.undo.title')}
        disabled={!canUndo()}
        onClick={() => void handleUndo()}
      >
        <UndoIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-redo"
        data-tooltip={t('toolbar.redo.title')}
        aria-label={t('toolbar.redo.title')}
        disabled={!canRedo()}
        onClick={() => void handleRedo()}
      >
        <RedoIcon />
      </button>
      <button
        type="button"
        class={`fmt-btn spreadsheet-toolbar-button ${
          formatPainterState() !== 'idle' ? 'fmt-btn-active' : ''
        }`.trim()}
        data-testid="toolbar-btn-format-painter"
        data-format-painter-state={formatPainterState()}
        data-tooltip={
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
        <FormatPainterIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-clear-format"
        data-tooltip={t('toolbar.clearFormat.title')}
        aria-label={t('toolbar.clearFormat.title')}
        disabled={
          !backend.setFormatRange || isProtectionGated() || !activeCellHasFormat()
        }
        onClick={() => void handleClearFormat()}
      >
        <ClearFormatIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-print-preview"
        data-tooltip={t('toolbar.printPreview.title')}
        aria-label={t('toolbar.printPreview.title')}
        disabled={!availability().sheetId}
        onClick={handlePrintPreview}
      >
        <PrintIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-comment"
        data-tooltip={t('toolbar.comment.title')}
        aria-label={t('toolbar.comment.title')}
        disabled={
          !availability().sheetId || availability().editingMode === 'drafting'
        }
        onClick={handleOpenComment}
      >
        <CommentIcon />
      </button>

      <span class="spreadsheet-toolbar-separator" aria-hidden="true" />

      {/* Group 2 — Font family + size */}
      <button
        type="button"
        ref={(el) => (fontFamilyAnchorEl = el)}
        class={`fmt-btn spreadsheet-toolbar-button ${
          fontFamilyOpen() ? 'fmt-btn-active' : ''
        }`.trim()}
        data-testid="toolbar-btn-font-family"
        data-tooltip={t('toolbar.fontFamily.title')}
        aria-label={t('toolbar.fontFamily.title')}
        aria-haspopup="menu"
        aria-expanded={fontFamilyOpen()}
        disabled={!availability().fontFamily || isProtectionGated()}
        onClick={(event) => {
          if (fontFamilyOpen()) {
            closeFontFamilyDropdown()
          } else {
            openFontFamilyDropdown(event.currentTarget)
          }
        }}
      >
        {activeCellFormat().fontFamily ?? DEFAULT_FONT_FAMILY}
      </button>
      <button
        type="button"
        ref={(el) => (fontSizeAnchorEl = el)}
        class={`fmt-btn spreadsheet-toolbar-button ${
          fontSizeOpen() ? 'fmt-btn-active' : ''
        }`.trim()}
        data-testid="toolbar-btn-font-size"
        data-tooltip={t('toolbar.fontSize.title')}
        aria-label={t('toolbar.fontSize.title')}
        aria-haspopup="menu"
        aria-expanded={fontSizeOpen()}
        disabled={!availability().fontSize || isProtectionGated()}
        onClick={(event) => {
          if (fontSizeOpen()) {
            closeFontSizeDropdown()
          } else {
            openFontSizeDropdown(event.currentTarget)
          }
        }}
      >
        {activeCellFormat().fontSize ?? DEFAULT_FONT_SIZE}
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-font-size-up"
        data-tooltip={t('toolbar.fontSizeUp.title')}
        aria-label={t('toolbar.fontSizeUp.title')}
        disabled={!availability().fontSize || isProtectionGated()}
        onClick={() => {
          dispatchCommand({ command: 'font-size-up' })
        }}
      >
        <FontSizeUpIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-font-size-down"
        data-tooltip={t('toolbar.fontSizeDown.title')}
        aria-label={t('toolbar.fontSizeDown.title')}
        disabled={!availability().fontSize || isProtectionGated()}
        onClick={() => {
          dispatchCommand({ command: 'font-size-down' })
        }}
      >
        <FontSizeDownIcon />
      </button>

      <span class="spreadsheet-toolbar-separator" aria-hidden="true" />

      {/* Group 3 — Text styles (B / I / U / S) */}
      {textStyleCommands.map(renderTextStyleButton)}

      <span class="spreadsheet-toolbar-separator" aria-hidden="true" />

      {/* Group 4 — Colors + borders */}
      {renderColorButton('text')}
      {renderColorButton('fill')}
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
          data-tooltip={t('toolbar.borders.title')}
          aria-label={t('toolbar.borders.title')}
          aria-haspopup="menu"
          aria-expanded={bordersDropdownOpen()}
          disabled={!availability().border || isProtectionGated()}
          onClick={() => {
            setBordersDropdownOpen((open) => !open)
          }}
        >
          <BordersIcon />
        </button>
        <BordersDropdown
          isOpen={bordersDropdownOpen()}
          isMultiCell={rangeCellCount(selectionSnapshot().range) > 1}
          anchorRef={bordersAnchorRef ?? null}
          onSelect={handleBordersSelect}
          onRequestClose={() => setBordersDropdownOpen(false)}
        />
      </div>

      <span class="spreadsheet-toolbar-separator" aria-hidden="true" />

      {/* Group 5 — Alignment + wrap + rotation */}
      <div
        class="spreadsheet-toolbar-h-align-wrapper"
        style={{ position: 'relative', display: 'inline-flex' }}
      >
        <button
          ref={(el) => (hAlignAnchorRef = el)}
          type="button"
          class={`fmt-btn spreadsheet-toolbar-button ${
            hAlignDropdownOpen() ? 'fmt-btn-active' : ''
          }`.trim()}
          data-testid="toolbar-btn-h-align"
          data-active-align={currentHAlign()}
          data-tooltip={t('toolbar.hAlign.title')}
          aria-label={t('toolbar.hAlign.title')}
          aria-haspopup="menu"
          aria-expanded={hAlignDropdownOpen()}
          disabled={!availability().alignment || isProtectionGated()}
          onClick={() => {
            setHAlignDropdownOpen((open) => !open)
          }}
        >
          {currentHAlign() === 'center' ? (
            <AlignCenterIcon />
          ) : currentHAlign() === 'right' ? (
            <AlignRightIcon />
          ) : (
            <AlignLeftIcon />
          )}
        </button>
        <HAlignDropdown
          isOpen={hAlignDropdownOpen()}
          current={currentHAlign()}
          anchorRef={hAlignAnchorRef ?? null}
          onSelect={handleHAlignSelect}
          onRequestClose={() => setHAlignDropdownOpen(false)}
        />
      </div>
      <div
        class="spreadsheet-toolbar-v-align-wrapper"
        style={{ position: 'relative', display: 'inline-flex' }}
      >
        <button
          ref={(el) => (vAlignAnchorRef = el)}
          type="button"
          class={`fmt-btn spreadsheet-toolbar-button ${
            vAlignDropdownOpen() ? 'fmt-btn-active' : ''
          }`.trim()}
          data-testid="toolbar-btn-v-align"
          data-active-vertical-align={currentVAlign()}
          data-tooltip={t('toolbar.vAlign.title')}
          aria-label={t('toolbar.vAlign.title')}
          aria-haspopup="menu"
          aria-expanded={vAlignDropdownOpen()}
          disabled={!availability().verticalAlignment || isProtectionGated()}
          onClick={() => {
            setVAlignDropdownOpen((open) => !open)
          }}
        >
          {currentVAlign() === 'top' ? (
            <VAlignTopIcon />
          ) : currentVAlign() === 'center' ? (
            <VAlignMiddleIcon />
          ) : (
            <VAlignBottomIcon />
          )}
        </button>
        <VAlignDropdown
          isOpen={vAlignDropdownOpen()}
          current={currentVAlign()}
          anchorRef={vAlignAnchorRef ?? null}
          onSelect={handleVAlignSelect}
          onRequestClose={() => setVAlignDropdownOpen(false)}
        />
      </div>
      <button
        type="button"
        class={`fmt-btn spreadsheet-toolbar-button ${
          activeCellFormat().wrap ? 'fmt-btn-active' : ''
        }`.trim()}
        data-testid="toolbar-btn-wrap"
        data-tooltip={t('toolbar.wrap.title')}
        aria-label={t('toolbar.wrap.title')}
        aria-pressed={!!activeCellFormat().wrap}
        disabled={!availability().wrap || isProtectionGated()}
        onClick={() => dispatchCommand({ command: 'wrap' })}
      >
        <WrapIcon />
      </button>
      <div
        class="spreadsheet-toolbar-rotation-wrapper"
        style={{ position: 'relative', display: 'inline-flex' }}
      >
        <button
          ref={(el) => (rotationAnchorRef = el)}
          type="button"
          class={`fmt-btn spreadsheet-toolbar-button ${
            rotationDropdownOpen() ? 'fmt-btn-active' : ''
          }`.trim()}
          data-testid="toolbar-btn-rotation"
          data-tooltip={t('toolbar.rotation.title')}
          aria-label={t('toolbar.rotation.title')}
          aria-haspopup="menu"
          aria-expanded={rotationDropdownOpen()}
          disabled={!availability().rotation || isProtectionGated()}
          onClick={() => {
            setRotationDropdownOpen((open) => !open)
          }}
        >
          <RotationIcon />
        </button>
        <RotationDropdown
          isOpen={rotationDropdownOpen()}
          anchorRef={rotationAnchorRef ?? null}
          onSelect={handleRotationSelect}
          onRequestClose={() => setRotationDropdownOpen(false)}
        />
      </div>

      <span class="spreadsheet-toolbar-separator" aria-hidden="true" />

      {/* Group 6 — Merge */}
      <div
        class="spreadsheet-toolbar-merge-wrapper"
        style={{ position: 'relative', display: 'inline-flex' }}
      >
        <button
          ref={(el) => (mergeAnchorRef = el)}
          type="button"
          class={`fmt-btn spreadsheet-toolbar-button ${
            mergeDropdownOpen() || activeCellMergeRange() !== null
              ? 'fmt-btn-active'
              : ''
          }`.trim()}
          data-testid="toolbar-btn-merge"
          data-tooltip={t('toolbar.merge.title')}
          aria-label={t('toolbar.merge.title')}
          aria-haspopup="menu"
          aria-expanded={mergeDropdownOpen()}
          aria-pressed={activeCellMergeRange() !== null}
          disabled={
            !backend.mergeRange ||
            availability().editingMode === 'drafting' ||
            isProtectionGated() ||
            // 1x1 selection that isn't inside an existing merge → every
            // option in the merge dropdown (merge-center, across-rows,
            // across-cols, unmerge) would be a no-op, so disable. Matches
            // Univer slim toolbar behavior.
            (rangeCellCount(selectionSnapshot().range) <= 1 &&
              activeCellMergeRange() === null)
          }
          onClick={() => {
            setMergeDropdownOpen((open) => !open)
          }}
        >
          <MergeCellsIcon />
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

      <span class="spreadsheet-toolbar-separator" aria-hidden="true" />

      {/* Group 6b — Find/Replace, conditional formatting, data validation,
          filter, sort, name manager. Each button is a thin opener that
          flips an existing spreadsheet-ui-core atom; the dialogs/dropdowns
          subscribe to those atoms and render themselves. */}
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-find-replace"
        data-tooltip={t('toolbar.findReplace.title')}
        aria-label={t('toolbar.findReplace.title')}
        disabled={!availability().sheetId}
        onClick={handleOpenFindReplace}
      >
        <FindReplaceIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-conditional-format"
        data-tooltip={t('toolbar.condFmt.title')}
        aria-label={t('toolbar.condFmt.title')}
        disabled={!availability().sheetId}
        onClick={handleOpenConditionalFormat}
      >
        <ConditionalFormatIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-data-validation"
        data-tooltip={t('toolbar.dataValidation.title')}
        aria-label={t('toolbar.dataValidation.title')}
        disabled={
          !availability().sheetId || availability().editingMode === 'drafting'
        }
        onClick={handleOpenDataValidation}
      >
        <DataValidationIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-filter"
        data-tooltip={t('toolbar.filter.title')}
        aria-label={t('toolbar.filter.title')}
        disabled={!availability().sheetId || !backend.setFilterSort}
        onClick={handleOpenFilterDropdown}
      >
        <FilterIcon />
      </button>
      <div
        class="spreadsheet-toolbar-sort-wrapper"
        style={{ position: 'relative', display: 'inline-flex' }}
      >
        <button
          ref={(el) => (sortAnchorRef = el)}
          type="button"
          class={`fmt-btn spreadsheet-toolbar-button ${
            sortDropdownOpen() ? 'fmt-btn-active' : ''
          }`.trim()}
          data-testid="toolbar-btn-sort"
          data-tooltip={t('toolbar.sort.title')}
          aria-label={t('toolbar.sort.title')}
          aria-haspopup="menu"
          aria-expanded={sortDropdownOpen()}
          disabled={!availability().sheetId}
          onClick={() => {
            setSortDropdownOpen((open) => !open)
          }}
        >
          <SortIcon />
        </button>
        <SortDropdown
          isOpen={sortDropdownOpen()}
          anchorRef={sortAnchorRef ?? null}
          onSelect={handleSortSelect}
          onRequestClose={() => setSortDropdownOpen(false)}
          t={t}
        />
      </div>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-name-manager"
        data-tooltip={t('toolbar.nameManager.title')}
        aria-label={t('toolbar.nameManager.title')}
        disabled={!availability().sheetId}
        onClick={handleOpenNameManager}
      >
        <NameManagerIcon />
      </button>

      <span class="spreadsheet-toolbar-separator" aria-hidden="true" />

      {/* Group 7 — Number format dropdown + percent / currency shortcuts */}
      <button
        type="button"
        ref={(el) => (numberFormatAnchorEl = el)}
        class={`fmt-btn spreadsheet-toolbar-button spreadsheet-toolbar-currency-opener ${
          numberFormatOpen() ? 'fmt-btn-active' : ''
        }`.trim()}
        data-testid="toolbar-btn-number-format"
        data-tooltip={t('toolbar.currencyDropdown.title')}
        aria-label={t('toolbar.currencyDropdown.title')}
        aria-haspopup="menu"
        aria-expanded={numberFormatOpen()}
        disabled={!availability().numberFormat || isProtectionGated()}
        onClick={(event) => {
          if (numberFormatOpen()) {
            closeNumberFormatDropdown()
          } else {
            openNumberFormatDropdown(event.currentTarget)
          }
        }}
      >
        <span>{t('toolbar.currencyDropdown')}</span>
        <span class="toolbar-chevron">
          <ChevronDownIcon />
        </span>
      </button>
      <button
        type="button"
        class={`fmt-btn spreadsheet-toolbar-button ${
          activeCellFormat().numberFormat?.kind === 'percent' ? 'fmt-btn-active' : ''
        }`.trim()}
        data-testid="toolbar-btn-percent-format"
        data-tooltip={t('toolbar.percentFormat.title')}
        aria-label={t('toolbar.percentFormat.title')}
        aria-pressed={activeCellFormat().numberFormat?.kind === 'percent'}
        disabled={!availability().numberFormat || isProtectionGated()}
        onClick={() => dispatchCommand({ command: 'number-format', value: 'Percent' })}
      >
        <PercentIcon />
      </button>
      <button
        type="button"
        class={`fmt-btn spreadsheet-toolbar-button ${
          activeCellFormat().numberFormat?.kind === 'currency' ||
          activeCellFormat().numberFormat?.kind === 'accounting'
            ? 'fmt-btn-active'
            : ''
        }`.trim()}
        data-testid="toolbar-btn-currency-format"
        data-tooltip={t('toolbar.currencyFormat.title')}
        aria-label={t('toolbar.currencyFormat.title')}
        aria-pressed={
          activeCellFormat().numberFormat?.kind === 'currency' ||
          activeCellFormat().numberFormat?.kind === 'accounting'
        }
        disabled={!availability().numberFormat || isProtectionGated()}
        onClick={() => dispatchCommand({ command: 'number-format', value: 'Currency' })}
      >
        <CurrencyIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-inc-decimal"
        data-tooltip={t('toolbar.incDecimal.title')}
        aria-label={t('toolbar.incDecimal.title')}
        disabled={!availability().numberFormat || isProtectionGated()}
        onClick={() => adjustDigits('increase')}
      >
        <IncreaseDecimalIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-dec-decimal"
        data-tooltip={t('toolbar.decDecimal.title')}
        aria-label={t('toolbar.decDecimal.title')}
        disabled={
          !availability().numberFormat ||
          isProtectionGated() ||
          currentDecimalDigits() <= 0
        }
        onClick={() => adjustDigits('decrease')}
      >
        <DecreaseDecimalIcon />
      </button>

      <NumberFormatDropdown
        open={numberFormatOpen()}
        anchorRect={numberFormatAnchor()}
        anchorEl={numberFormatAnchorEl}
        onSelect={onNumberFormatPick}
        onClose={closeNumberFormatDropdown}
      />
      <FontFamilyDropdown
        open={fontFamilyOpen()}
        anchorRect={fontFamilyAnchor()}
        anchorEl={fontFamilyAnchorEl}
        current={activeCellFormat().fontFamily ?? DEFAULT_FONT_FAMILY}
        onSelect={onFontFamilyPick}
        onClose={closeFontFamilyDropdown}
      />
      <FontSizeDropdown
        open={fontSizeOpen()}
        anchorRect={fontSizeAnchor()}
        anchorEl={fontSizeAnchorEl}
        current={activeCellFormat().fontSize ?? DEFAULT_FONT_SIZE}
        onSelect={onFontSizePick}
        onClose={closeFontSizeDropdown}
      />
      <FillColorPopover anchorRect={anchorRect} onPick={handleColorPick} />
    </div>
  )
}
