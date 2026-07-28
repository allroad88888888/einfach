import { useAtomValue } from '@einfach/solid'
import { onCleanup, onMount, Show } from 'solid-js'
import {
  openRemoveDuplicatesFromSelectionAtom,
  registerCustomFormulaAtom,
  runTextToColumnsEntrypointAtom,
  selectCellAtom,
  selectionAtom,
  selectionSnapshotAtom,
  setWorkspaceActiveSheetAtom,
  unregisterCustomFormulaAtom,
  viewportShowFormulaBarAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import {
  createStaticNamedRangeCapabilityPort,
  createStaticSpreadsheetBackend,
} from '../adapter'
import { SpreadsheetCommentThread } from '../comments'
import { SpreadsheetConditionalFormatDialog } from '../conditional-formatting'
import { SpreadsheetContextMenu } from '../context-menu'
import { SpreadsheetDataValidationDialog } from '../data-validation'
import { SpreadsheetFilterDropdown } from '../filter-sort'
import { SpreadsheetFindReplaceDialog } from '../find-replace'
import { SpreadsheetGoToDialog } from '../go-to'
import { SpreadsheetFormatCellsDialog } from '../format-cells'
import { SpreadsheetFormatPainter } from '../format-painter'
import { SpreadsheetFormulaBar } from '../formula-bar'
import { SpreadsheetGrid } from '../grid'
import { SpreadsheetHistoryTimeline } from '../history'
import { SpreadsheetMenuBar } from '../menu-bar'
import { SpreadsheetNameManagerDialog } from '../named-ranges'
import { SpreadsheetPasteSpecialDialog } from '../paste-special'
import { SpreadsheetRemoveDuplicatesDialog } from '../remove-duplicates'
import { SpreadsheetFormulaAutocomplete } from '../formula-autocomplete'
import { SpreadsheetPresenceOverlay } from '../presence'
import { SpreadsheetPrintPreviewOverlay } from '../print'
import { SpreadsheetProtectionUnlockDialog } from '../protection'
import { SpreadsheetSheetTabs } from '../sheet-tabs'
import { SpreadsheetStatusBar } from '../status-bar'
import { SpreadsheetTextToColumnsDialog } from '../text-to-columns'
import { SpreadsheetToolbar } from '../toolbar'
import { acceptFormulaSuggestion, SpreadsheetUiProvider, useSpreadsheetUiStore } from '../provider'

const sheets = [
  { id: 'sheet-1', name: 'Sales' },
  { id: 'sheet-2', name: 'Forecast' },
]

const namedRangeCapabilityPort = createStaticNamedRangeCapabilityPort()

const backend = createStaticSpreadsheetBackend({
  revision: 1,
  sheets,
  matrix: [
    ['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total'],
    ['North', 120, 180, 240, 300, 840],
    ['South', 80, 160, 240, 320, 800],
    ['East', 200, 100, 50, 150, 500],
    ['West', 140, 110, 250, 175, 675],
    ['Central', 90, 130, 200, 280, 700],
    ['Mountain', 65, 95, 130, 210, 500],
    ['Pacific', 175, 220, 280, 360, 1035],
    ['Total', 870, 995, 1390, 1795, 5050],
  ],
  cells: [
    {
      row: 0,
      col: 0,
      displayValue: 'Region',
      valueKind: 'string',
      // Header styling is static, not from a conditional-format rule — use
      // `format` so toolbar features (Clear Format, Bold-pressed indicator)
      // see it as user formatting.
      format: { bgColor: '#1e3a8a', fgColor: '#ffffff', bold: true },
    },
    {
      row: 0,
      col: 5,
      displayValue: 'Total',
      valueKind: 'string',
      format: { bgColor: '#1e3a8a', fgColor: '#ffffff', bold: true },
    },
    {
      row: 8,
      col: 0,
      displayValue: 'Total',
      valueKind: 'string',
      format: { bgColor: '#94a3b8', fgColor: '#0f172a', bold: true },
    },
    {
      row: 3,
      col: 4,
      displayValue: '150',
      valueKind: 'number',
      conditionalFormat: { bgColor: '#fef3c7' },
    },
    {
      row: 6,
      col: 4,
      displayValue: '210',
      valueKind: 'number',
      conditionalFormat: { bgColor: '#fef3c7' },
    },
    {
      row: 7,
      col: 5,
      displayValue: '1035',
      valueKind: 'number',
      conditionalFormat: { bgColor: '#dcfce7', bold: true },
    },
  ],
})

const viewport = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 240,
  viewportWidth: 720,
  rowHeight: 24,
  colWidth: 96,
  rowCount: 50,
  colCount: 16,
  overscanRows: 1,
  overscanCols: 1,
}

function VNextWave5Workbook() {
  const store = useSpreadsheetUiStore()
  const workspace = useAtomValue(workspaceSessionAtom)
  const showFormulaBar = useAtomValue(viewportShowFormulaBarAtom)
  const activeSheetId = () => workspace().activeSheetId ?? sheets[0].id

  /**
   * Wave 7.1 compatibility test trigger for `open-text-to-columns`. The
   * visible menu is the production entrypoint; this direct helper remains
   * available only for focused flow and compatibility tests.
   */
  async function triggerTextToColumnsForSelection() {
    await store.setter(runTextToColumnsEntrypointAtom, { source: backend })
  }

  /**
   * Wave 7.5 compatibility test trigger for `open-remove-duplicates`. The
   * visible menu is the production entrypoint; e2e may still fire the
   * `spreadsheet:open-remove-duplicates` event as a direct-flow /
   * compatibility hook after selecting the source range.
   */
  async function triggerRemoveDuplicatesForSelection() {
    const snap = store.getter(selectionSnapshotAtom)
    const sheetId =
      snap.selection.sheetId || store.getter(workspaceSessionAtom).activeSheetId || ''
    if (!sheetId) return
    const range = snap.range
    if (range.rowStart > range.rowEnd || range.colStart > range.colEnd) return
    await store.setter(openRemoveDuplicatesFromSelectionAtom, { source: backend })
  }

  onMount(() => {
    const mountSheetId =
      store.getter(workspaceSessionAtom).activeSheetId ?? sheets[0].id
    if (!store.getter(workspaceSessionAtom).activeSheetId) {
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: sheets[0].id })
    }
    // Default-cursor A1 so the toolbar/header reflect a focused cell from
    // first paint (Excel + Univer convention). The initial selection state
    // is `{ kind: 'cell', sheetId: '', ... }` — empty sheetId is the
    // "untouched" signal we wire the cell selection against.
    if (!store.getter(selectionAtom).sheetId) {
      store.setter(selectCellAtom, {
        sheetId: mountSheetId,
        coord: { row: 0, col: 0 },
      })
    }
  })

  /**
   * Wave 8 — seed three custom formulas so the demo shows the
   * `=MYTAX(B2)` flow without anyone needing the menubar. The provider
   * effect diffs the registry and forwards to the worker; the static
   * backend has no port so the registry stays a no-op there. Tear
   * down on unmount so a hot-reload does not double-register.
   */
  onMount(() => {
    const seeded = [
      {
        name: 'MYTAX',
        source: 'return Number(args[0]) * 0.2',
        description: '20% tax on the input amount',
        paramLabels: ['amount'],
      },
      {
        name: 'GREET',
        source: "return 'Hello, ' + String(args[0] ?? '')",
        description: 'Friendly greeting',
        paramLabels: ['name'],
      },
      {
        name: 'CELSIUS',
        source: 'return (Number(args[0]) - 32) * 5 / 9',
        description: 'Convert Fahrenheit to Celsius',
        paramLabels: ['fahrenheit'],
      },
    ]
    for (const reg of seeded) store.setter(registerCustomFormulaAtom, reg)
    onCleanup(() => {
      for (const reg of seeded) store.setter(unregisterCustomFormulaAtom, reg.name)
    })
  })

  /**
   * Wave 7.1 test hook — listen for a `spreadsheet:open-text-to-columns`
   * custom event. The visible menu is the production entrypoint; this
   * listener remains only as a direct-flow / compatibility test hook and
   * is inert unless a host explicitly dispatches the event.
   */
  onMount(() => {
    function onOpenRequest() {
      void triggerTextToColumnsForSelection()
    }
    window.addEventListener('spreadsheet:open-text-to-columns', onOpenRequest)
    onCleanup(() => {
      window.removeEventListener('spreadsheet:open-text-to-columns', onOpenRequest)
    })
  })

  // Wave 7.5 test hook — symmetric with the text-to-columns listener.
  onMount(() => {
    function onOpenRequest() {
      void triggerRemoveDuplicatesForSelection()
    }
    window.addEventListener('spreadsheet:open-remove-duplicates', onOpenRequest)
    onCleanup(() => {
      window.removeEventListener(
        'spreadsheet:open-remove-duplicates',
        onOpenRequest,
      )
    })
  })

  return (
    <>
      <SpreadsheetMenuBar
        data-testid="wave5-menu-bar"
        hiddenItemIds={['file.printPreview']}
      />
      <SpreadsheetToolbar data-testid="wave5-toolbar" />
      <Show when={showFormulaBar()}>
        <SpreadsheetFormulaBar data-testid="wave5-formula-bar" />
      </Show>
      <div class="vnext-demo-body">
        <div class="vnext-demo-main">
          <Show keyed when={activeSheetId()}>
            {(sheetId) => (
              <SpreadsheetGrid sheetId={sheetId} viewport={viewport} data-testid="wave5-grid" />
            )}
          </Show>
          <div class="vnext-demo-bottom-row">
            <SpreadsheetSheetTabs sheets={sheets} data-testid="wave5-sheet-tabs" />
            <SpreadsheetStatusBar
              sections={['zoom']}
              data-testid="wave5-status-bar-zoom"
              class="vnext-demo-zoom-bar"
            />
          </div>
        </div>
        <aside class="vnext-demo-sidebar" data-testid="wave5-sidebar">
          <SpreadsheetStatusBar
            sections={[
              'cell-address',
              'selection',
              'projection',
              'visible-cells',
              'loaded-values',
              'last-command',
              'aggregates',
              'view-modes',
              'mode-badge',
            ]}
            orientation="vertical"
            data-testid="wave5-status-bar"
          />
          <SpreadsheetHistoryTimeline data-testid="wave5-history-timeline" />
        </aside>
      </div>
      <SpreadsheetContextMenu data-testid="wave5-context-menu" />
      <SpreadsheetFormatPainter data-testid="wave5-format-painter" />
      <SpreadsheetFormatCellsDialog data-testid="wave5-format-cells" />
      <SpreadsheetFindReplaceDialog data-testid="wave5-find-replace" />
      <SpreadsheetGoToDialog data-testid="wave5-go-to" />
      <SpreadsheetFilterDropdown data-testid="wave5-filter-dropdown" />
      <SpreadsheetConditionalFormatDialog data-testid="wave5-conditional-format" />
      <SpreadsheetDataValidationDialog data-testid="wave5-data-validation" />
      <SpreadsheetNameManagerDialog data-testid="wave5-name-manager" />
      <SpreadsheetPasteSpecialDialog data-testid="wave5-paste-special" />
      <SpreadsheetTextToColumnsDialog data-testid="wave5-text-to-columns" />
      <SpreadsheetRemoveDuplicatesDialog data-testid="wave5-remove-duplicates" />
      <SpreadsheetCommentThread data-testid="wave5-comment-thread" />
      <SpreadsheetPrintPreviewOverlay data-testid="wave5-print-preview" />
      <SpreadsheetProtectionUnlockDialog data-testid="wave5-protection-unlock" />
      <SpreadsheetPresenceOverlay data-testid="wave5-presence" />
      <SpreadsheetFormulaAutocomplete
        data-testid="wave5-formula-autocomplete"
        onAccept={(suggestion) => {
          const { caret } = acceptFormulaSuggestion(store, suggestion)
          // Restore focus + caret on whichever input was active.
          queueMicrotask(() => {
            const el = document.activeElement
            if (
              el instanceof HTMLInputElement &&
              (el.classList.contains('cell-input') || el.classList.contains('formula-bar-input'))
            ) {
              el.focus()
              el.setSelectionRange(caret, caret)
            }
          })
        }}
      />
    </>
  )
}

export function VNextWave5Demo() {
  return (
    <div class="demo-page vnext-demo" data-testid="wave5-demo">
      <div class="demo-header">
        <h3>Wave 5 — 完整 Excel 壳 + Canvas 装饰层</h3>
        <p class="demo-desc">
          演示菜单条、名称框、状态栏聚合（选区的求和/平均/计数）、缩放滑块、格式刷以及画布
          装饰层。预置一张季度销售表，选中 B2:E8 即可看到非平凡的聚合结果。
        </p>
        <p class="demo-desc" data-testid="wave5-custom-formulas-banner">
          Custom formulas registered: <code>MYTAX</code>, <code>GREET</code>,{' '}
          <code>CELSIUS</code>. Try <code>=MYTAX(B2)</code> in any cell.
        </p>
      </div>

      <SpreadsheetUiProvider
        backend={backend}
        namedRangeCapabilityPort={namedRangeCapabilityPort}
      >
        <VNextWave5Workbook />
      </SpreadsheetUiProvider>
    </div>
  )
}
