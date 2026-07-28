import { atom } from '@einfach/core'
import { useAtomValue } from '@einfach/solid'
import {
  editingDraftAtom,
  openConditionalFormatEditorAtom,
  openFindReplaceFromEntrypointAtom,
  openNameManagerAtom,
  openValidationRuleEditorAtom,
  selectCellAtom,
  selectionAtom,
  scrollToCellAtom,
  setSelectionAtom,
  setWorkspaceActiveSheetAtom,
  viewportShowFormulaBarAtom,
  workspaceSessionAtom,
  type DisplayCell,
  type SpreadsheetCellFormat,
} from '@einfach/spreadsheet-ui-core'
import {
  acceptFormulaSuggestion,
  createStaticNamedRangeCapabilityPort,
  createStaticSpreadsheetBackend,
  SpreadsheetContextMenu,
  SpreadsheetFormatPainter,
  SpreadsheetFormulaAutocomplete,
  SpreadsheetFormulaBar,
  SpreadsheetGoToDialog,
  SpreadsheetGrid,
  SpreadsheetMenuBar,
  SpreadsheetPasteSpecialDialog,
  SpreadsheetRemoveDuplicatesDialog,
  SpreadsheetSheetTabs,
  SpreadsheetStatusBar,
  SpreadsheetTextToColumnsDialog,
  SpreadsheetToolbar,
  SpreadsheetUiProvider,
  useSpreadsheetUiStore,
} from '@einfach/solid-excel/vnext'
import {
  SpreadsheetCommentThread,
  SpreadsheetConditionalFormatDialog,
  SpreadsheetDataValidationDialog,
  SpreadsheetFilterDropdown,
  SpreadsheetFindReplaceDialog,
  SpreadsheetFormatCellsDialog,
  SpreadsheetNameManagerDialog,
  SpreadsheetPresenceOverlay,
  SpreadsheetPrintPreviewOverlay,
  SpreadsheetProtectionUnlockDialog,
} from '@einfach/solid-excel/vnext'
import { onCleanup, onMount, Show } from 'solid-js'

const sheets = [
  { id: 'sales', name: '经营总览' },
  { id: 'forecast', name: '滚动预测' },
  { id: 'assumptions', name: '模型参数' },
]

type ShowcaseStep = 'formula' | 'aggregate' | 'edit' | 'forecast'

const showcaseStepAtom = atom<ShowcaseStep>('formula')
showcaseStepAtom.debugLabel = 'excelShowcase.activeStep'

const currencyFormat: SpreadsheetCellFormat = {
  numberFormat: { kind: 'currency', symbol: '¥', digits: 0 },
  align: 'right',
}

const percentFormat: SpreadsheetCellFormat = {
  numberFormat: { kind: 'percent', digits: 1 },
  align: 'right',
}

const headerFormat: SpreadsheetCellFormat = {
  bgColor: '#214f43',
  fgColor: '#ffffff',
  bold: true,
  align: 'center',
  verticalAlign: 'center',
  borders: {
    bottom: { style: 'medium', color: '#173f35' },
  },
}

function formulaCell(
  row: number,
  col: number,
  formula: string,
  format?: SpreadsheetCellFormat,
  conditionalFormat?: SpreadsheetCellFormat,
): DisplayCell {
  return {
    row,
    col,
    displayValue: formula,
    formula,
    valueKind: 'number',
    format,
    conditionalFormat,
  }
}

function buildOverviewCells(): DisplayCell[] {
  const rows = [
    ['华东', '林然', 540_000, 620_000, 690_000, 760_000, 2_450_000, '领先'],
    ['华南', '周遥', 430_000, 510_000, 580_000, 650_000, 2_180_000, '稳定'],
    ['华北', '沈知', 380_000, 450_000, 520_000, 590_000, 2_060_000, '稳定'],
    ['西南', '顾川', 290_000, 350_000, 410_000, 480_000, 1_760_000, '关注'],
    ['新零售', '季宁', 620_000, 710_000, 820_000, 940_000, 2_900_000, '领先'],
    ['企业业务', '程越', 510_000, 570_000, 640_000, 720_000, 2_380_000, '稳定'],
  ] as const

  const cells: DisplayCell[] = [
    {
      row: 0,
      col: 0,
      displayValue: '2026 增长经营模型',
      valueKind: 'string',
      mergedSpan: { rows: 1, cols: 9 },
      format: {
        bgColor: '#e4f1eb',
        fgColor: '#173f35',
        bold: true,
        fontSize: 18,
        verticalAlign: 'center',
      },
    },
    {
      row: 1,
      col: 0,
      displayValue: '收入、目标与区域表现 · 更新于 7 月 27 日',
      valueKind: 'string',
      mergedSpan: { rows: 1, cols: 9 },
      format: {
        fgColor: '#63736d',
        italic: true,
      },
    },
    {
      row: 3,
      col: 0,
      displayValue: '年度营收',
      valueKind: 'string',
      format: { fgColor: '#61716b', bold: true },
    },
    formulaCell(3, 1, '=SUM(G8:G13)', {
      ...currencyFormat,
      bold: true,
      fontSize: 15,
      fgColor: '#173f35',
    }),
    {
      row: 3,
      col: 3,
      displayValue: '平均达成率',
      valueKind: 'string',
      format: { fgColor: '#61716b', bold: true },
    },
    formulaCell(3, 4, '=AVERAGE(H8:H13)', {
      ...percentFormat,
      bold: true,
      fontSize: 15,
      fgColor: '#173f35',
    }),
    {
      row: 3,
      col: 6,
      displayValue: '领先业务',
      valueKind: 'string',
      format: { fgColor: '#61716b', bold: true },
    },
    {
      row: 3,
      col: 7,
      displayValue: '2 个',
      valueKind: 'string',
      format: { bold: true, fontSize: 15, fgColor: '#173f35' },
    },
  ]

  ;['区域', '负责人', 'Q1', 'Q2', 'Q3', 'Q4', '全年收入', '目标达成', '状态'].forEach(
    (label, col) => {
      cells.push({
        row: 6,
        col,
        displayValue: label,
        valueKind: 'string',
        format: headerFormat,
      })
    },
  )

  rows.forEach((row, index) => {
    const sheetRow = index + 7
    const excelRow = sheetRow + 1
    const [region, owner, q1, q2, q3, q4, target, status] = row

    cells.push(
      {
        row: sheetRow,
        col: 0,
        displayValue: region,
        valueKind: 'string',
        format: { bold: true, fgColor: '#273c35' },
      },
      {
        row: sheetRow,
        col: 1,
        displayValue: owner,
        valueKind: 'string',
      },
      ...[q1, q2, q3, q4].map<DisplayCell>((value, offset) => ({
        row: sheetRow,
        col: offset + 2,
        displayValue: String(value),
        numericValue: value,
        valueKind: 'number',
        format: currencyFormat,
      })),
      formulaCell(sheetRow, 6, `=SUM(C${excelRow}:F${excelRow})`, {
        ...currencyFormat,
        bold: true,
      }),
      formulaCell(
        sheetRow,
        7,
        `=G${excelRow}/${target}`,
        percentFormat,
        status === '领先'
          ? { bgColor: '#dff2e7', fgColor: '#17613d', bold: true }
          : status === '关注'
            ? { bgColor: '#fff0db', fgColor: '#9a4b12', bold: true }
            : { bgColor: '#eff5f2', fgColor: '#38584b' },
      ),
      {
        row: sheetRow,
        col: 8,
        displayValue: status,
        valueKind: 'string',
        conditionalFormat:
          status === '领先'
            ? { bgColor: '#dff2e7', fgColor: '#17613d', bold: true, align: 'center' }
            : status === '关注'
              ? { bgColor: '#fff0db', fgColor: '#9a4b12', bold: true, align: 'center' }
              : { bgColor: '#eff5f2', fgColor: '#38584b', align: 'center' },
      },
    )
  })

  cells.push({
    row: 14,
    col: 0,
    displayValue: '合计',
    valueKind: 'string',
    format: {
      bgColor: '#e4f1eb',
      fgColor: '#173f35',
      bold: true,
      borders: { top: { style: 'medium', color: '#2f6d5a' } },
    },
  })

  for (let col = 2; col <= 6; col += 1) {
    const column = String.fromCharCode(65 + col)
    cells.push(
      formulaCell(14, col, `=SUM(${column}8:${column}13)`, {
        ...currencyFormat,
        bgColor: '#e4f1eb',
        bold: true,
        fgColor: '#173f35',
        borders: { top: { style: 'medium', color: '#2f6d5a' } },
      }),
    )
  }

  cells.push(
    formulaCell(14, 7, '=AVERAGE(H8:H13)', {
      ...percentFormat,
      bgColor: '#e4f1eb',
      bold: true,
      fgColor: '#173f35',
      borders: { top: { style: 'medium', color: '#2f6d5a' } },
    }),
    {
      row: 17,
      col: 0,
      displayValue: '提示：双击任意数值可编辑，公式栏会同步显示原始公式。',
      valueKind: 'string',
      mergedSpan: { rows: 1, cols: 7 },
      format: {
        bgColor: '#f7faf8',
        fgColor: '#708079',
        italic: true,
      },
    },
  )

  return cells
}

const backend = createStaticSpreadsheetBackend({
  revision: 1,
  sheets,
  cells: buildOverviewCells(),
})

const namedRangeCapabilityPort = createStaticNamedRangeCapabilityPort()

const secondarySeed = {
  forecast: [
    ['季度滚动预测', '', '', '', ''],
    ['', '', '', '', ''],
    ['情景', 'Q3', 'Q4', '全年预测', '置信度'],
    ['稳健', '2750000', '3100000', '=SUM(B4:C4)', '0.92'],
    ['基准', '3180000', '3560000', '=SUM(B5:C5)', '0.78'],
    ['进取', '3620000', '4180000', '=SUM(B6:C6)', '0.61'],
  ],
  assumptions: [
    ['模型参数', '', '', ''],
    ['', '', '', ''],
    ['参数', '当前值', '单位', '说明'],
    ['平均客单价', '8600', '元', '最近 90 天加权均值'],
    ['续约率', '0.84', '%', '基于已签约客户'],
    ['销售周期', '42', '天', '从线索到签约'],
    ['年度增长目标', '0.28', '%', '管理层目标'],
  ],
} as const

Object.entries(secondarySeed).forEach(([sheetId, rows]) => {
  rows.forEach((row, rowIndex) => {
    row.forEach((input, colIndex) => {
      if (input === '') return
      void backend.setCellInput?.({
        kind: 'set-cell-input',
        sheetId,
        row: rowIndex,
        col: colIndex,
        input,
      })
    })
  })

  void backend.setFormatRange?.({
    kind: 'set-format-range',
    sheetId,
    range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: rows[0].length - 1 },
    format: {
      bgColor: '#e4f1eb',
      fgColor: '#173f35',
      bold: true,
      fontSize: 17,
    },
  })
  void backend.setFormatRange?.({
    kind: 'set-format-range',
    sheetId,
    range: { rowStart: 2, rowEnd: 2, colStart: 0, colEnd: rows[0].length - 1 },
    format: headerFormat,
  })
})

void backend.setFormatRange?.({
  kind: 'set-format-range',
  sheetId: 'forecast',
  range: { rowStart: 3, rowEnd: 5, colStart: 1, colEnd: 3 },
  format: currencyFormat,
})
void backend.setFormatRange?.({
  kind: 'set-format-range',
  sheetId: 'forecast',
  range: { rowStart: 3, rowEnd: 5, colStart: 4, colEnd: 4 },
  format: percentFormat,
})
void backend.setFormatRange?.({
  kind: 'set-format-range',
  sheetId: 'assumptions',
  range: { rowStart: 4, rowEnd: 4, colStart: 1, colEnd: 1 },
  format: percentFormat,
})
void backend.setFormatRange?.({
  kind: 'set-format-range',
  sheetId: 'assumptions',
  range: { rowStart: 6, rowEnd: 6, colStart: 1, colEnd: 1 },
  format: percentFormat,
})

const viewport = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 520,
  viewportWidth: 1280,
  rowHeight: 28,
  colWidth: 118,
  rowCount: 2_000,
  colCount: 100,
  overscanRows: 2,
  overscanCols: 2,
}

function SheetsGlyph() {
  return (
    <svg viewBox="0 0 36 36" aria-hidden="true">
      <path d="M8 3h14l7 7v23H8z" fill="#fff" opacity=".98" />
      <path d="M22 3v8h7" fill="none" stroke="#b7decf" stroke-width="2" />
      <path d="M12 16h13M12 21h13M12 26h13M17 14v15" stroke="#217346" stroke-width="1.7" />
    </svg>
  )
}

function normalizeNumericEditDraft(draft: string) {
  const normalized = draft.replace(/[¥￥,\s]/g, '')
  return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized) ? normalized : draft
}

function Workbook() {
  const store = useSpreadsheetUiStore()
  const workspace = useAtomValue(workspaceSessionAtom)
  const showFormulaBar = useAtomValue(viewportShowFormulaBarAtom)
  const showcaseStep = useAtomValue(showcaseStepAtom)
  const activeSheetId = () => workspace().activeSheetId ?? sheets[0].id
  const stepNumber = () => ({ formula: 1, aggregate: 2, edit: 3, forecast: 4 })[showcaseStep()]
  let firstRevealFrame: number | undefined
  let settledRevealFrame: number | undefined
  let editStepFrame: number | undefined
  let revealTimer: number | undefined

  onCleanup(() => {
    if (firstRevealFrame !== undefined) cancelAnimationFrame(firstRevealFrame)
    if (settledRevealFrame !== undefined) cancelAnimationFrame(settledRevealFrame)
    if (editStepFrame !== undefined) cancelAnimationFrame(editStepFrame)
    if (revealTimer !== undefined) window.clearTimeout(revealTimer)
  })

  function focusGrid(afterFocus?: (grid: HTMLElement) => void) {
    queueMicrotask(() => {
      const grid = document.querySelector<HTMLElement>('.spreadsheet-grid')
      grid?.focus()
      if (grid) afterFocus?.(grid)
    })
  }

  function goToCell(sheetId: string, row: number, col: number) {
    store.setter(setWorkspaceActiveSheetAtom, { sheetId })
    store.setter(selectCellAtom, {
      sheetId,
      coord: { row, col },
    })
    store.setter(scrollToCellAtom, { coord: { row, col } })
    focusGrid()
  }

  function selectRange(
    sheetId: string,
    range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
  ) {
    store.setter(setWorkspaceActiveSheetAtom, { sheetId })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId,
      anchor: { row: range.rowStart, col: range.colStart },
      focus: { row: range.rowEnd, col: range.colEnd },
    })
    store.setter(scrollToCellAtom, {
      coord: { row: range.rowStart, col: range.colStart },
    })
    focusGrid()
  }

  function runFormulaStep() {
    store.setter(showcaseStepAtom, 'formula')
    goToCell('sales', 7, 6)
  }

  function runAggregateStep() {
    store.setter(showcaseStepAtom, 'aggregate')
    selectRange('sales', { rowStart: 7, rowEnd: 12, colStart: 2, colEnd: 5 })
  }

  function runEditStep() {
    store.setter(showcaseStepAtom, 'edit')
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sales' })
    store.setter(selectCellAtom, {
      sheetId: 'sales',
      coord: { row: 7, col: 2 },
    })
    store.setter(scrollToCellAtom, { coord: { row: 7, col: 2 } })
    if (editStepFrame !== undefined) cancelAnimationFrame(editStepFrame)
    editStepFrame = requestAnimationFrame(() => {
      editStepFrame = undefined
      focusGrid((grid) => {
        grid.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'F2',
            code: 'F2',
            bubbles: true,
            cancelable: true,
          }),
        )
        const draft = store.getter(editingDraftAtom)
        const normalizedDraft = normalizeNumericEditDraft(draft)
        if (normalizedDraft !== draft) {
          store.setter(editingDraftAtom, { draft: normalizedDraft })
        }
      })
    })
  }

  function runForecastStep() {
    store.setter(showcaseStepAtom, 'forecast')
    goToCell('forecast', 3, 3)
  }

  function openFindReplace() {
    store.setter(openFindReplaceFromEntrypointAtom)
  }

  function openConditionalFormatting() {
    selectRange('sales', { rowStart: 7, rowEnd: 12, colStart: 7, colEnd: 7 })
    store.setter(openConditionalFormatEditorAtom, null)
  }

  function openDataValidation() {
    const range = { rowStart: 3, rowEnd: 6, colStart: 1, colEnd: 1 }
    selectRange('assumptions', range)
    store.setter(openValidationRuleEditorAtom, { range })
  }

  function openNameManager() {
    store.setter(openNameManagerAtom, { status: 'editing-new' })
  }

  onMount(() => {
    const revealInitialFormula = () => {
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: sheets[0].id })
      store.setter(selectCellAtom, {
        sheetId: sheets[0].id,
        coord: { row: 7, col: 6 },
      })
      store.setter(scrollToCellAtom, { coord: { row: 7, col: 6 } })
    }

    const annotateWorkbookInputs = () => {
      const fields = [
        {
          element: document.querySelector<HTMLInputElement>('.spreadsheet-name-box-input'),
          id: 'showcase-name-box',
          name: 'cell-reference',
        },
        {
          element: document.querySelector<HTMLInputElement>('.formula-bar-input'),
          id: 'showcase-formula-input',
          name: 'formula-input',
        },
      ]
      fields.forEach(({ element, id, name }) => {
        if (!element) return
        if (!element.id) element.id = id
        if (!element.name) element.name = name
      })
    }

    // The grid starts from the generous desktop viewport seed, then replaces
    // it with measured dimensions. Re-run the reveal after layout so G8 is
    // scrolled into view on narrow screens and after a retained dev-session
    // viewport was left far down the sheet.
    revealInitialFormula()
    firstRevealFrame = requestAnimationFrame(() => {
      revealInitialFormula()
      annotateWorkbookInputs()
      settledRevealFrame = requestAnimationFrame(revealInitialFormula)
    })
    revealTimer = window.setTimeout(() => {
      revealInitialFormula()
      annotateWorkbookInputs()
    }, 120)
  })

  return (
    <main class="workbook-layout">
      <section class="workbook-surface" aria-label="在线 Excel 工作簿">
        <div class="workbook-menu-row">
          <SpreadsheetMenuBar data-testid="showcase-menu-bar" />
          <div class="workbook-menu-spacer" />
          <span class="engine-pill">
            <span class="engine-dot" />
            公式即时反馈
          </span>
        </div>
        <SpreadsheetToolbar data-testid="showcase-toolbar" />
        <Show when={showFormulaBar()}>
          <SpreadsheetFormulaBar data-testid="showcase-formula-bar" />
        </Show>

        <div class="sheet-canvas">
          <Show keyed when={activeSheetId()}>
            {(sheetId) => (
              <SpreadsheetGrid sheetId={sheetId} viewport={viewport} data-testid="showcase-grid" />
            )}
          </Show>
        </div>

        <div class="workbook-bottom">
          <SpreadsheetSheetTabs sheets={sheets} data-testid="showcase-sheet-tabs" />
          <SpreadsheetStatusBar
            sections={['aggregates', 'view-modes', 'zoom', 'mode-badge']}
            data-testid="showcase-status-bar"
          />
        </div>
      </section>

      <aside class="guide-panel" aria-label="30 秒产品体验">
        <div class="guide-heading">
          <div class="guide-kicker">
            <span class="eyebrow">30 秒真实体验</span>
            <span class="step-counter">{stepNumber()} / 4</span>
          </div>
          <h2>亲手跑通一张经营表</h2>
          <p>每一步都直接作用于左侧工作簿，可继续输入、撤销或切换工作表。</p>
          <div class="step-progress" aria-hidden="true">
            <span classList={{ active: stepNumber() >= 1 }} />
            <span classList={{ active: stepNumber() >= 2 }} />
            <span classList={{ active: stepNumber() >= 3 }} />
            <span classList={{ active: stepNumber() >= 4 }} />
          </div>
        </div>

        <div class="guide-actions">
          <button
            type="button"
            classList={{ active: showcaseStep() === 'formula' }}
            aria-pressed={showcaseStep() === 'formula'}
            onClick={runFormulaStep}
          >
            <span class="guide-index">01</span>
            <span>
              <strong>读懂一条真实公式</strong>
              <small>定位 G8，公式栏显示 SUM(C8:F8)</small>
            </span>
            <span class="guide-arrow">↗</span>
          </button>
          <button
            type="button"
            classList={{ active: showcaseStep() === 'aggregate' }}
            aria-pressed={showcaseStep() === 'aggregate'}
            onClick={runAggregateStep}
          >
            <span class="guide-index">02</span>
            <span>
              <strong>框选并即时汇总</strong>
              <small>选择 C8:F13，底栏计算求和与平均值</small>
            </span>
            <span class="guide-arrow">↗</span>
          </button>
          <button
            type="button"
            classList={{ active: showcaseStep() === 'edit' }}
            aria-pressed={showcaseStep() === 'edit'}
            onClick={runEditStep}
          >
            <span class="guide-index">03</span>
            <span>
              <strong>直接修改源数据</strong>
              <small>进入 C8 编辑，确认后公式与汇总联动</small>
            </span>
            <span class="guide-arrow">↗</span>
          </button>
          <button
            type="button"
            classList={{ active: showcaseStep() === 'forecast' }}
            aria-pressed={showcaseStep() === 'forecast'}
            onClick={runForecastStep}
          >
            <span class="guide-index">04</span>
            <span>
              <strong>切换滚动预测</strong>
              <small>打开另一工作表，查看 D4 的跨季度计算</small>
            </span>
            <span class="guide-arrow">↗</span>
          </button>
        </div>

        <div class="tool-launcher">
          <div class="tool-launcher-heading">
            <span class="eyebrow">更多真实能力</span>
            <small>直接打开</small>
          </div>
          <div class="tool-grid">
            <button type="button" onClick={openFindReplace}>
              <span class="tool-icon">⌕</span>
              <span>查找替换</span>
              <kbd>⌘ F</kbd>
            </button>
            <button type="button" onClick={openConditionalFormatting}>
              <span class="tool-icon tool-icon-format" />
              <span>条件格式</span>
            </button>
            <button type="button" onClick={openDataValidation}>
              <span class="tool-icon">✓</span>
              <span>数据验证</span>
            </button>
            <button type="button" onClick={openNameManager}>
              <span class="tool-icon">fx</span>
              <span>名称管理</span>
            </button>
          </div>
        </div>

        <p class="keyboard-tip">
          也可以直接使用 <kbd>F2</kbd> 编辑 · <kbd>⌘ C</kbd> 复制 · <kbd>⌘ Z</kbd> 撤销
        </p>
      </aside>

      <SpreadsheetContextMenu data-testid="showcase-context-menu" />
      <SpreadsheetFormatPainter data-testid="showcase-format-painter" />
      <SpreadsheetFormatCellsDialog data-testid="showcase-format-cells" />
      <SpreadsheetFindReplaceDialog data-testid="showcase-find-replace" />
      <SpreadsheetGoToDialog data-testid="showcase-go-to" />
      <SpreadsheetFilterDropdown data-testid="showcase-filter-dropdown" />
      <SpreadsheetConditionalFormatDialog data-testid="showcase-conditional-format" />
      <SpreadsheetDataValidationDialog data-testid="showcase-data-validation" />
      <SpreadsheetNameManagerDialog data-testid="showcase-name-manager" />
      <SpreadsheetPasteSpecialDialog data-testid="showcase-paste-special" />
      <SpreadsheetTextToColumnsDialog data-testid="showcase-text-to-columns" />
      <SpreadsheetRemoveDuplicatesDialog data-testid="showcase-remove-duplicates" />
      <SpreadsheetCommentThread data-testid="showcase-comment-thread" />
      <SpreadsheetPrintPreviewOverlay data-testid="showcase-print-preview" />
      <SpreadsheetProtectionUnlockDialog data-testid="showcase-protection-unlock" />
      <SpreadsheetPresenceOverlay data-testid="showcase-presence" />
      <SpreadsheetFormulaAutocomplete
        data-testid="showcase-formula-autocomplete"
        onAccept={(suggestion) => {
          const { caret } = acceptFormulaSuggestion(store, suggestion)
          queueMicrotask(() => {
            const element = document.activeElement
            if (
              element instanceof HTMLInputElement &&
              (element.classList.contains('cell-input') ||
                element.classList.contains('formula-bar-input'))
            ) {
              element.focus()
              element.setSelectionRange(caret, caret)
            }
          })
        }}
      />
    </main>
  )
}

export function App() {
  async function shareWorkbook() {
    const shareData = {
      title: '2026 增长经营模型',
      text: '查看 Einfach Sheets 在线工作簿',
      url: window.location.href,
    }
    if (navigator.share) {
      await navigator.share(shareData).catch(() => undefined)
      return
    }
    await navigator.clipboard?.writeText(window.location.href).catch(() => undefined)
  }

  return (
    <div class="excel-showcase">
      <header class="document-header">
        <div class="document-identity">
          <div class="product-mark">
            <SheetsGlyph />
          </div>
          <div class="document-meta">
            <div class="document-title-row">
              <h1>2026 增长经营模型</h1>
            </div>
            <nav aria-label="工作簿位置">
              <span>Einfach Sheets</span>
              <span class="crumb">/</span>
              <span>经营分析</span>
            </nav>
          </div>
        </div>

        <div class="document-actions">
          <button class="share-button" type="button" onClick={shareWorkbook}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M7.5 9.5 12.8 6M7.5 10.5l5.3 3.5M6 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm8-5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm0 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
            </svg>
            分享页面
          </button>
        </div>
      </header>

      <div class="workspace-caption">
        <div>
          <span class="caption-dot" />
          <span>可交互工作簿</span>
          <span class="caption-divider" />
          <span>单元格公式与依赖联动 · 编辑撤销 · 筛选排序 · 数据规则 · 虚拟化表格浏览</span>
        </div>
        <span class="caption-hint">操作发生在浏览器演示环境</span>
      </div>

      <SpreadsheetUiProvider backend={backend} namedRangeCapabilityPort={namedRangeCapabilityPort}>
        <Workbook />
      </SpreadsheetUiProvider>
    </div>
  )
}
