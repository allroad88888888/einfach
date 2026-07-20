import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  armFormatPainterAtom,
  armFormatPainterStickyAtom,
  canRedoAtom,
  canUndoAtom,
  captureFilterSortCapabilityAtom,
  captureFindReplaceCapabilityAtom,
  captureSortRangeCapabilityAtom,
  closeToolbarSurfaceAtom,
  dispatchToolbarFormatCommandAtom,
  exitFormatPainterAtom,
  filterSortEntrypointProjectionAtom,
  findReplaceCapabilityProjectionAtom,
  formatPainterStateAtom,
  openCommentSessionAtom,
  openConditionalFormatEditorAtom,
  openFilterDropdownFromEntrypointAtom,
  openFindReplaceFromEntrypointAtom,
  openFormatCellsAtom,
  openNameManagerAtom,
  openToolbarDropdownAtom,
  openToolbarPaletteAtom,
  openValidationRuleEditorAtom,
  physicalSortDiagnosticAtom,
  resolveContentMutationAtom,
  retryFilterSortRefreshAtom,
  retryToolbarMutationRefreshAtom,
  runPhysicalSortAtom,
  runToolbarMutationAtom,
  selectionSnapshotAtom,
  sortRangeSupportedAtom,
  toolbarActiveSurfaceAtom,
  toolbarCommandAvailabilityAtom,
  toolbarMutationLifecycleAtom,
  activeCellLockedAtom,
  selectionLockedAtom,
  type CapturedFormat,
  type CellRange,
  type DisplayCell,
  type RunToolbarMutationInput,
  type SortDirection,
  type SpreadsheetBorders,
  type SpreadsheetBorderStyle,
  type SpreadsheetCellFormat,
  type SpreadsheetNumberFormat,
  type ToolbarFormatCommandInput,
  type ToolbarFormatCommandIntent,
  type ToolbarDropdownKind,
  type ToolbarMutationStep,
} from '@einfach/spreadsheet-ui-core'

import {
  isVisibleProjectionResult,
  refreshVisibleProjection,
  resolveSortRange,
  spreadsheetProjectionSnapshotAtom,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'
import { SpreadsheetNumberFormatDialogs, openNumberFormatDialogAtom } from '../format-cells'
import { dispatchRedo, dispatchUndo } from '../provider/history-dispatch'
import { BordersDropdown, type BordersPreset } from './BordersDropdown'
import { HAlignDropdown, type HAlignValue } from './HAlignDropdown'
import { MergeDropdown, type MergePreset } from './MergeDropdown'
import { VAlignDropdown, type VAlignValue } from './VAlignDropdown'
import type { SpreadsheetToolbarProps, SpreadsheetToolbarCommand } from './types'
import {
  NumberFormatDropdown,
  type NumberFormatCustomMenuId,
  type NumberFormatId,
} from './NumberFormatDropdown'
import { FillColorPopover, type ColorPopoverMode } from './FillColorPopover'
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
      return { kind: 'date', pattern: 'yyyy-MM-dd' }
    case 'DateLong':
      return { kind: 'date', pattern: 'yyyy"年"m"月"d"日"' }
    case 'Time12':
      return { kind: 'time', pattern: 'h:mm AM/PM' }
    case 'Time24':
      return { kind: 'time', pattern: 'HH:mm' }
    case 'DateTime12':
      return { kind: 'custom', pattern: 'yyyy-MM-dd h:mm AM/PM' }
    case 'DateTime24':
      return { kind: 'custom', pattern: 'yyyy-MM-dd HH:mm' }
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
  disabled: boolean
  disabledReason: string | null
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

  // Attach the document-level dismiss listeners only while the dropdown is
  // open (canonical toolbar popup pattern, see NumberFormatDropdown /
  // BordersDropdown). This exact component was the T14 defect: the listener
  // used to live for the toolbar's lifetime, so after one sort the stale
  // detached `rootRef` made every outside mousedown call `onRequestClose()`
  // — clearing the shared toolbar surface and unmounting whichever sibling
  // popup (e.g. the number-format dropdown) the user was mid-click inside.
  createEffect(() => {
    if (!props.isOpen) return
    document.addEventListener('mousedown', onDocPointerDown, true)
    document.addEventListener('keydown', onDocKeyDown)
    onCleanup(() => {
      document.removeEventListener('mousedown', onDocPointerDown, true)
      document.removeEventListener('keydown', onDocKeyDown)
    })
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
              disabled={props.disabled}
              title={props.disabledReason ?? ''}
              style={{
                padding: '4px 12px',
                'text-align': 'left',
                background: 'transparent',
                border: 'none',
                cursor: props.disabled ? 'not-allowed' : 'pointer',
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
  const filterSortEntrypoint = useAtomValue(filterSortEntrypointProjectionAtom)
  const physicalSortDiagnostic = useAtomValue(physicalSortDiagnosticAtom)
  const findReplaceCapability = useAtomValue(findReplaceCapabilityProjectionAtom)
  const activeToolbarSurface = useAtomValue(toolbarActiveSurfaceAtom)
  const toolbarMutationLifecycle = useAtomValue(toolbarMutationLifecycleAtom)

  const sortSupported = useAtomValue(sortRangeSupportedAtom)

  createEffect(() => {
    store.setter(captureFilterSortCapabilityAtom, backend)
    store.setter(captureFindReplaceCapabilityAtom, backend)
    store.setter(captureSortRangeCapabilityAtom, backend)
  })

  // Worker backends resolve their fail-closed capability witness asynchronously
  // (describeCapabilities lands after initWorkbook), so `sortRange` sampled at
  // mount can be pre-witness. Recapture once the backend reports ready so the
  // Sort entrypoint reflects post-witness truth (#24: no port → no sort).
  onMount(() => {
    const readyable = backend as typeof backend & { ready?: () => Promise<unknown> }
    void readyable.ready
      ?.call(backend)
      .then(() => {
        store.setter(captureSortRangeCapabilityAtom, backend)
      })
      .catch(() => {})
  })
  const projectionSnapshot = useAtomValue(spreadsheetProjectionSnapshotAtom)
  const selectionSnapshot = useAtomValue(selectionSnapshotAtom)
  const activeCellLocked = useAtomValue(activeCellLockedAtom)
  const selectionLocked = useAtomValue(selectionLockedAtom)
  const formatPainterState = useAtomValue(formatPainterStateAtom)
  const [numberFormatAnchor, setNumberFormatAnchor] = createSignal<DOMRect | null>(null)
  let numberFormatAnchorEl: HTMLButtonElement | null = null

  const numberFormatOpen = () => isDropdownOpen('number-format')
  const bordersDropdownOpen = () => isDropdownOpen('border')
  let bordersAnchorRef: HTMLButtonElement | undefined

  const mergeDropdownOpen = () => isDropdownOpen('merge')
  let mergeAnchorRef: HTMLButtonElement | undefined

  const hAlignDropdownOpen = () => isDropdownOpen('alignment')
  let hAlignAnchorRef: HTMLButtonElement | undefined
  const vAlignDropdownOpen = () => isDropdownOpen('vertical-alignment')
  let vAlignAnchorRef: HTMLButtonElement | undefined

  const fontFamilyOpen = () => isDropdownOpen('font-family')
  const [fontFamilyAnchor, setFontFamilyAnchor] = createSignal<DOMRect | null>(null)
  let fontFamilyAnchorEl: HTMLButtonElement | null = null
  const fontSizeOpen = () => isDropdownOpen('font-size')
  const [fontSizeAnchor, setFontSizeAnchor] = createSignal<DOMRect | null>(null)
  let fontSizeAnchorEl: HTMLButtonElement | null = null

  function isDropdownOpen(dropdown: ToolbarDropdownKind) {
    const surface = activeToolbarSurface()
    return surface?.kind === 'dropdown' && surface.id === dropdown
  }

  function closeToolbarSurface() {
    store.setter(closeToolbarSurfaceAtom)
  }

  function toggleToolbarDropdown(dropdown: ToolbarDropdownKind) {
    if (isDropdownOpen(dropdown)) {
      closeToolbarSurface()
    } else {
      store.setter(openToolbarDropdownAtom, { dropdown })
    }
  }

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
    closeToolbarSurface()
    dispatchCommand({ command: 'alignment', value })
  }

  function handleVAlignSelect(value: VAlignValue) {
    closeToolbarSurface()
    dispatchCommand({ command: 'vertical-alignment', value })
  }

  const rotationDropdownOpen = () => isDropdownOpen('rotation')
  let rotationAnchorRef: HTMLButtonElement | undefined

  const sortDropdownOpen = () => isDropdownOpen('sort')
  let sortAnchorRef: HTMLButtonElement | undefined

  const [anchorRect, setAnchorRect] = createSignal<DOMRect | null>(null)
  const colorAnchors: Partial<Record<ColorPopoverMode, HTMLButtonElement>> = {}

  function activeColorMode(): ColorPopoverMode | null {
    const surface = activeToolbarSurface()
    if (surface?.kind !== 'palette') return null
    return surface.id === 'fill-color' ? 'fill' : 'text'
  }

  function toggleColorPopover(mode: ColorPopoverMode) {
    const palette = mode === 'fill' ? 'fill-color' : 'text-color'
    const current = activeToolbarSurface()
    if (current?.kind === 'palette' && current.id === palette) {
      closeToolbarSurface()
      setAnchorRect(null)
      return
    }
    const anchor = colorAnchors[mode]
    setAnchorRect(anchor ? anchor.getBoundingClientRect() : null)
    store.setter(openToolbarPaletteAtom, { palette })
  }

  createEffect(() => {
    if (activeColorMode() === null) setAnchorRect(null)
  })

  function handleColorPick(hex: string) {
    const mode = activeColorMode()
    if (mode === null) return
    closeToolbarSurface()
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
    store.setter(openToolbarDropdownAtom, { dropdown: 'number-format' })
  }

  function closeNumberFormatDropdown() {
    closeToolbarSurface()
    setNumberFormatAnchor(null)
  }

  function openFontFamilyDropdown(buttonEl: HTMLButtonElement) {
    fontFamilyAnchorEl = buttonEl
    setFontFamilyAnchor(buttonEl.getBoundingClientRect())
    store.setter(openToolbarDropdownAtom, { dropdown: 'font-family' })
  }

  function closeFontFamilyDropdown() {
    closeToolbarSurface()
    setFontFamilyAnchor(null)
  }

  function onFontFamilyPick(family: string) {
    closeFontFamilyDropdown()
    dispatchCommand({ command: 'font-family', value: family })
  }

  function openFontSizeDropdown(buttonEl: HTMLButtonElement) {
    fontSizeAnchorEl = buttonEl
    setFontSizeAnchor(buttonEl.getBoundingClientRect())
    store.setter(openToolbarDropdownAtom, { dropdown: 'font-size' })
  }

  function closeFontSizeDropdown() {
    closeToolbarSurface()
    setFontSizeAnchor(null)
  }

  function onFontSizePick(size: number) {
    closeFontSizeDropdown()
    dispatchCommand({ command: 'font-size', value: String(size) })
  }

  function onNumberFormatPick(id: NumberFormatId) {
    closeNumberFormatDropdown()
    if (id === 'Custom') {
      // The 自定义格式 (custom format) row opens the full Format Cells dialog
      // on the Number tab. The dialog reads selection + initial format from
      // its open atom; the host (here) provides them.
      const selection = selectionSnapshot()
      const sheetId = selection.selection.sheetId || availability().sheetId
      if (!sheetId) return
      store.setter(openFormatCellsAtom, {
        sheetId,
        range: selection.range,
        initialFormat: activeCellFormat(),
        initialTab: 'number',
      })
      return
    }
    // 'WanYuan' is disabled in the dropdown UI and never reaches here, but
    // guard so a future re-enable does not silently fall through to General.
    if (id === 'WanYuan') return
    dispatchCommand({ command: 'number-format', value: id })
  }

  function openCustomNumberFormatDialog(kind: NumberFormatCustomMenuId) {
    const selection = selectionSnapshot()
    const sheetId = selection.selection.sheetId || availability().sheetId
    if (!sheetId) return
    store.setter(openNumberFormatDialogAtom, {
      kind,
      sheetId,
      range: selection.range,
      initialFormat: activeCellFormat(),
    })
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
        candidate.row === selection.activeCell.row && candidate.col === selection.activeCell.col,
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
        candidate.row === selection.activeCell.row && candidate.col === selection.activeCell.col,
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

  function dispatchToolbarMutation(
    input: Omit<RunToolbarMutationInput, 'source' | 'refreshProjection'>,
  ) {
    void store.setter(runToolbarMutationAtom, {
      ...input,
      source: backend,
      refreshProjection: (sheetId) => refreshVisibleProjection(store, backend, sheetId),
    })
  }

  /**
   * Mutation-gateway resolution for a format write over a display range:
   * remaps display rows to source rows (filter/sort) and enforces the
   * protection gate (locked cells on a protected sheet cannot be
   * reformatted). Returns the source ranges to write, or null when the
   * mutation is blocked — callers must then launch zero transport; the
   * gateway has already recorded the structured diagnostic + lastBlock.
   */
  function resolveFormatSourceRanges(sheetId: string, range: CellRange): CellRange[] | null {
    const resolution = store.setter(resolveContentMutationAtom, {
      kind: 'set-format-range',
      sheetId,
      range,
    })
    if (resolution.status === 'blocked') return null
    return (resolution.ranges ?? [range]).map((sourceRange) => ({ ...sourceRange }))
  }

  function executeCommand(intent: ToolbarFormatCommandIntent, range: CellRange) {
    const current = activeCellFormat()
    const format = commandFormat(intent, current)
    const sourceRanges = resolveFormatSourceRanges(intent.sheetId, range)
    if (sourceRanges === null) return
    dispatchToolbarMutation({
      sheetId: intent.sheetId,
      operation: 'format',
      affectedRange: sourceRanges.length === 1 ? sourceRanges[0] : range,
      steps: sourceRanges.map((sourceRange) => ({
        kind: 'set-format-range',
        range: sourceRange,
        format,
      })),
    })
  }

  function dispatchCommand(input: ToolbarFormatCommandInput) {
    const intent = store.setter(dispatchToolbarFormatCommandAtom, input)
    if (!intent) {
      return
    }

    const range = selectionSnapshot().range
    executeCommand(intent, range)
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
  function executeBordersPreset(preset: BordersPreset, sheetId: string, range: CellRange) {
    const cells = projectionCellMap()
    const steps: ToolbarMutationStep[] = []

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
        // One gateway resolution per cell; any blocked cell aborts the whole
        // preset before the single dispatch below (fail-closed, zero transport).
        const sourceRanges = resolveFormatSourceRanges(sheetId, {
          rowStart: row,
          rowEnd: row,
          colStart: col,
          colEnd: col,
        })
        if (sourceRanges === null) return
        steps.push({
          kind: 'set-format-range',
          range: sourceRanges[0],
          format: nextFormat,
        })
      }
    }
    dispatchToolbarMutation({
      sheetId,
      operation: 'border-batch',
      affectedRange: range,
      steps,
    })
  }

  function handleBordersSelect(preset: BordersPreset) {
    closeToolbarSurface()
    const range = selectionSnapshot().range
    const isMulti = rangeCellCount(range) > 1
    if (preset === 'inner' && !isMulti) {
      // 1x1 inner is a no-op by definition.
      return
    }
    const sheetId = getMutationSheetId()
    if (!sheetId) return
    executeBordersPreset(preset, sheetId, range)
  }

  function handleRotationSelect(preset: RotationPreset) {
    closeToolbarSurface()
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

  /** Capture a complete merge/unmerge plan; Core owns settlement, history and refresh. */
  function executeMergePreset(preset: MergePreset) {
    const sheetId = getMutationSheetId()
    if (!sheetId) return

    const selectionRange = selectionSnapshot().range

    if (preset === 'unmerge') {
      // Prefer the active-cell merge range so a 1x1 selection inside a merge
      // still unmerges the full region; fall back to the raw selection.
      const targetRange = activeCellMergeRange() ?? selectionRange
      dispatchToolbarMutation({
        sheetId,
        operation: 'unmerge',
        affectedRange: targetRange,
        steps: [{ kind: 'unmerge-range', range: targetRange }],
      })
      return
    }

    if (preset === 'merge-center') {
      // The dropdown promises "合并居中" (merge + center) but the backend
      // exposes no compound transaction port — issuing a separate
      // `setFormatRange` after the merge would put the centering on its own
      // undo step, breaking the timeline contract that one user action equals
      // one undo. Until a compound-transaction port lands we ship just the
      // merge here so undo reverses the user's click in one move.
      dispatchToolbarMutation({
        sheetId,
        operation: 'merge',
        affectedRange: selectionRange,
        steps: [{ kind: 'merge-range', range: selectionRange }],
      })
      return
    }

    if (preset === 'across-rows') {
      // Merge each row of the selection independently. Univer labels this
      // 跨列合并 — within each row the cells across columns collapse.
      const steps: ToolbarMutationStep[] = []
      for (let row = selectionRange.rowStart; row <= selectionRange.rowEnd; row += 1) {
        if (selectionRange.colEnd <= selectionRange.colStart) break
        const rowRange: CellRange = {
          rowStart: row,
          rowEnd: row,
          colStart: selectionRange.colStart,
          colEnd: selectionRange.colEnd,
        }
        steps.push({ kind: 'merge-range', range: rowRange })
      }
      if (steps.length === 0) return
      dispatchToolbarMutation({
        sheetId,
        operation: 'merge',
        affectedRange: selectionRange,
        steps,
      })
      return
    }

    if (preset === 'across-cols') {
      // Merge each column of the selection independently. Univer labels this
      // 跨行合并 — within each column the cells across rows collapse.
      const steps: ToolbarMutationStep[] = []
      for (let col = selectionRange.colStart; col <= selectionRange.colEnd; col += 1) {
        if (selectionRange.rowEnd <= selectionRange.rowStart) break
        const colRange: CellRange = {
          rowStart: selectionRange.rowStart,
          rowEnd: selectionRange.rowEnd,
          colStart: col,
          colEnd: col,
        }
        steps.push({ kind: 'merge-range', range: colRange })
      }
      if (steps.length === 0) return
      dispatchToolbarMutation({
        sheetId,
        operation: 'merge',
        affectedRange: selectionRange,
        steps,
      })
    }
  }

  function handleMergeSelect(preset: MergePreset) {
    closeToolbarSurface()
    executeMergePreset(preset)
  }

  // === New group: Find/Replace, Conditional format, Data validation,
  // Filter, Sort, Name manager. All six dispatch into existing spreadsheet-
  // ui-core atoms — the dialog/dropdown components subscribe to those atoms
  // and render themselves; the toolbar just opens them.

  function handleOpenFindReplace() {
    store.setter(openFindReplaceFromEntrypointAtom)
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
    store.setter(openFilterDropdownFromEntrypointAtom, {
      source: backend,
      entrypoint: 'toolbar',
    })
  }

  // Sort dispatches ONE physical-sort command: the backend `sortRange` port
  // reorders engine DATA. There is no display-permutation fallback (#24) —
  // the button only renders when the host exposes the port.
  async function handleSortSelect(direction: SortDirection) {
    closeToolbarSurface()
    const snap = store.getter(selectionSnapshotAtom)
    const sheetId = snap.activeCell.sheetId || availability().sheetId
    if (!sheetId) return
    if (typeof backend.sortRange !== 'function') return
    const range = await resolveSortRange(store, backend, sheetId, snap.activeCell)
    void store.setter(runPhysicalSortAtom, {
      source: backend,
      entrypoint: 'toolbar',
      direction,
      range,
      refreshProjection: (target) => refreshVisibleProjection(store, backend, target),
    })
  }

  function handleFilterSortRefreshRetry() {
    void store.setter(retryFilterSortRefreshAtom, {
      refreshProjection: (sheetId) => refreshVisibleProjection(store, backend, sheetId),
    })
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

  /** Clear formatting is planned in Solid and settled by the Core mutation lifecycle. */
  function handleClearFormat() {
    const sheetId = getMutationSheetId()
    if (!sheetId) return
    const range = selectionSnapshot().range
    const sourceRanges = resolveFormatSourceRanges(sheetId, range)
    if (sourceRanges === null) return
    dispatchToolbarMutation({
      sheetId,
      operation: 'format',
      affectedRange: sourceRanges.length === 1 ? sourceRanges[0] : range,
      steps: sourceRanges.map((sourceRange) => ({
        kind: 'set-format-range',
        range: sourceRange,
        format: {},
      })),
    })
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
    const sheetId = getMutationSheetId()
    if (!sheetId) return
    const range = selectionSnapshot().range
    const sourceRanges = resolveFormatSourceRanges(sheetId, range)
    if (sourceRanges === null) return
    const currentFormat = activeCellFormat()
    const nf = currentFormat.numberFormat
    const nextFormat: SpreadsheetCellFormat = { ...currentFormat }
    if (isDecimalCapableFormat(nf)) {
      const current = nf.digits ?? 0
      const nextDigits = direction === 'increase' ? current + 1 : Math.max(0, current - 1)
      if (nextDigits === current) return
      nextFormat.numberFormat = { ...nf, digits: nextDigits } as SpreadsheetNumberFormat
    } else {
      if (direction === 'decrease') return
      nextFormat.numberFormat = { kind: 'decimal', digits: 1, thousands: false }
    }
    dispatchToolbarMutation({
      sheetId,
      operation: 'format',
      affectedRange: sourceRanges.length === 1 ? sourceRanges[0] : range,
      steps: sourceRanges.map((sourceRange) => ({
        kind: 'set-format-range',
        range: sourceRange,
        format: nextFormat,
      })),
    })
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
        class={`fmt-btn spreadsheet-toolbar-button ${isPressed() ? 'fmt-btn-active' : ''}`.trim()}
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
    const palette = isText ? 'text-color' : 'fill-color'
    const testId = isText ? 'toolbar-btn-text-color' : 'toolbar-btn-fill-color'
    const titleKey = isText ? 'toolbar.textColor.title' : 'toolbar.fillColor.title'
    const isEnabled = () => (isText ? availability().textColor : availability().fillColor)
    const isPressed = () => {
      const surface = activeToolbarSurface()
      return surface?.kind === 'palette' && surface.id === palette
    }
    const Icon = isText ? TextColorIcon : FillColorIcon

    return (
      <button
        type="button"
        ref={(el) => {
          colorAnchors[mode] = el
        }}
        class={`fmt-btn spreadsheet-toolbar-button ${isPressed() ? 'fmt-btn-active' : ''}`.trim()}
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
      data-filter-sort-status={filterSortEntrypoint().status}
      data-filter-sort-error={filterSortEntrypoint().error || undefined}
      data-toolbar-mutation-status={toolbarMutationLifecycle().status}
      data-toolbar-mutation-error={toolbarMutationLifecycle().error || undefined}
      // `preventDefault` on mousedown keeps the grid (or active editor) as the
      // focused element so post-click keyboard shortcuts (Ctrl+Z, Ctrl+Y,
      // arrows, etc.) reach the grid's keydown handler instead of stranding on
      // the toolbar button. Without this, a `toolbar-btn-bold` click moves
      // browser focus to the button, and the very next `keyboard.press('Control+z')`
      // is swallowed by the button (no handler) instead of dispatching the
      // grid's `history.undo` intent. Pinned by `toolbar-buttons.spec.ts`
      // 'Ctrl+Z drives the undo button after a format change'.
      onMouseDown={(event) => {
        // Don't preventDefault for inputs/textareas (e.g. font-size editable
        // input) where the click needs to focus the input for typing.
        const target = event.target as HTMLElement | null
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target && target.isContentEditable)
        ) {
          return
        }
        event.preventDefault()
      }}
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
        disabled={!backend.setFormatRange || isProtectionGated() || !activeCellHasFormat()}
        onClick={() => void handleClearFormat()}
      >
        <ClearFormatIcon />
      </button>
      {/*
        Placeholder that preserves the toolbar's flow-layout width where the
        Print Preview button used to sit. Removing the button entirely would
        shift Group 4 (colors + borders) to the left and reflow the borders
        dropdown into the formula-bar click-target zone — flaking the
        click-outside-closes-dropdown test. The dimensions match
        `.spreadsheet-toolbar-button` so the toolbar lays out exactly as
        before; `aria-hidden` keeps screen readers from announcing it.
      */}
      <span
        class="spreadsheet-toolbar-spacer"
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: '40px',
          height: '28px',
          'pointer-events': 'none',
        }}
      />
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-comment"
        data-tooltip={t('toolbar.comment.title')}
        aria-label={t('toolbar.comment.title')}
        disabled={!availability().sheetId || availability().editingMode === 'drafting'}
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
          onClick={() => toggleToolbarDropdown('border')}
        >
          <BordersIcon />
        </button>
        <BordersDropdown
          isOpen={bordersDropdownOpen()}
          isMultiCell={rangeCellCount(selectionSnapshot().range) > 1}
          anchorRef={bordersAnchorRef ?? null}
          onSelect={handleBordersSelect}
          onRequestClose={closeToolbarSurface}
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
          onClick={() => toggleToolbarDropdown('alignment')}
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
          onRequestClose={closeToolbarSurface}
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
          onClick={() => toggleToolbarDropdown('vertical-alignment')}
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
          onRequestClose={closeToolbarSurface}
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
          onClick={() => toggleToolbarDropdown('rotation')}
        >
          <RotationIcon />
        </button>
        <RotationDropdown
          isOpen={rotationDropdownOpen()}
          anchorRef={rotationAnchorRef ?? null}
          onSelect={handleRotationSelect}
          onRequestClose={closeToolbarSurface}
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
            mergeDropdownOpen() || activeCellMergeRange() !== null ? 'fmt-btn-active' : ''
          }`.trim()}
          data-testid="toolbar-btn-merge"
          data-tooltip={t('toolbar.merge.title')}
          aria-label={t('toolbar.merge.title')}
          aria-haspopup="menu"
          aria-expanded={mergeDropdownOpen()}
          aria-pressed={activeCellMergeRange() !== null}
          disabled={
            !backend.mergeRange || availability().editingMode === 'drafting' || isProtectionGated()
            // 1x1 selection is allowed — the dropdown opens so users see
            // why every preset is greyed out. Each preset (merge-center,
            // across-rows, across-cols) declares its own
            // `enabledWhen === 'multi'` and `unmerge` declares
            // `enabledWhen === 'merged'`, so the dropdown items disable
            // themselves when the selection is a single non-merged cell.
          }
          onClick={() => toggleToolbarDropdown('merge')}
        >
          <MergeCellsIcon />
        </button>
        <MergeDropdown
          isOpen={mergeDropdownOpen()}
          isMultiCell={rangeCellCount(selectionSnapshot().range) > 1}
          canUnmerge={activeCellMergeRange() !== null}
          anchorRef={mergeAnchorRef ?? null}
          onSelect={handleMergeSelect}
          onRequestClose={closeToolbarSurface}
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
        data-capability={findReplaceCapability().capability}
        data-tooltip={t('toolbar.findReplace.title')}
        aria-label={t('toolbar.findReplace.title')}
        disabled={!availability().sheetId || !findReplaceCapability().findEnabled}
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
        disabled={!availability().sheetId || availability().editingMode === 'drafting'}
        onClick={handleOpenDataValidation}
      >
        <DataValidationIcon />
      </button>
      <button
        type="button"
        class="fmt-btn spreadsheet-toolbar-button"
        data-testid="toolbar-btn-filter"
        data-tooltip={filterSortEntrypoint().disabledReason ?? t('toolbar.filter.title')}
        aria-label={t('toolbar.filter.title')}
        title={filterSortEntrypoint().disabledReason ?? ''}
        disabled={filterSortEntrypoint().disabled}
        onClick={handleOpenFilterDropdown}
      >
        <FilterIcon />
      </button>
      {/* Sort is capability-gated on the engine `sortRange` port (#24). A host
          that cannot physically reorder data (the fail-closed TS worker) has no
          sort at all, so the entrypoint disappears instead of pretending. */}
      <Show when={sortSupported()}>
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
            data-tooltip={
              physicalSortDiagnostic()?.message ??
              filterSortEntrypoint().disabledReason ??
              t('toolbar.sort.title')
            }
            aria-label={t('toolbar.sort.title')}
            title={physicalSortDiagnostic()?.message ?? filterSortEntrypoint().disabledReason ?? ''}
            aria-haspopup="menu"
            aria-expanded={sortDropdownOpen()}
            disabled={filterSortEntrypoint().disabled}
            onClick={() => toggleToolbarDropdown('sort')}
          >
            <SortIcon />
          </button>
          <SortDropdown
            isOpen={sortDropdownOpen()}
            anchorRef={sortAnchorRef ?? null}
            disabled={filterSortEntrypoint().disabled}
            disabledReason={filterSortEntrypoint().disabledReason}
            onSelect={handleSortSelect}
            onRequestClose={closeToolbarSurface}
            t={t}
          />
        </div>
      </Show>
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
          !availability().numberFormat || isProtectionGated() || currentDecimalDigits() <= 0
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
        onCustomSelect={openCustomNumberFormatDialog}
        onClose={closeNumberFormatDropdown}
      />
      <SpreadsheetNumberFormatDialogs />
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
      <FillColorPopover
        open={activeColorMode() !== null}
        mode={activeColorMode()}
        anchorRect={anchorRect}
        onPick={handleColorPick}
        onRequestClose={closeToolbarSurface}
      />
      <Show when={toolbarMutationLifecycle().error}>
        {(error) => (
          <span role="status" data-testid="toolbar-mutation-status">
            {error()}
          </span>
        )}
      </Show>
      <Show
        when={
          toolbarMutationLifecycle().canRetryRefresh &&
          (toolbarMutationLifecycle().status === 'refresh-failed' ||
            toolbarMutationLifecycle().status === 'outcome-unknown')
        }
      >
        <button
          type="button"
          class="fmt-btn spreadsheet-toolbar-button"
          data-testid="toolbar-mutation-refresh-retry"
          aria-label="Reconcile toolbar mutation"
          onClick={() => void store.setter(retryToolbarMutationRefreshAtom)}
        >
          ↻
        </button>
      </Show>
      <Show when={filterSortEntrypoint().error}>
        {(error) => (
          <span role="status" data-testid="toolbar-filter-sort-status">
            {error()}
          </span>
        )}
      </Show>
      <Show when={filterSortEntrypoint().status === 'refresh-failed'}>
        <button
          type="button"
          class="fmt-btn spreadsheet-toolbar-button"
          data-testid="toolbar-filter-sort-refresh-retry"
          aria-label="Retry filter and sort refresh"
          onClick={handleFilterSortRefreshRetry}
        >
          ↻
        </button>
      </Show>
    </div>
  )
}
