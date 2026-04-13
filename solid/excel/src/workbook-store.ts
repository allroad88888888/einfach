import { batch, createSignal } from 'solid-js'
import type { CellFormat, CellValue, IWorkbook, WorkbookSnapshot } from './types'

export function createWorkbookStore(workbook: IWorkbook) {
  const cellSignals = new Map<string, ReturnType<typeof createSignal<CellValue>>>()
  const formatSignals = new Map<string, ReturnType<typeof createSignal<CellFormat>>>()
  const [metaVersion, setMetaVersion] = createSignal(0)
  const [sheetVersion, setSheetVersion] = createSignal(0)
  const [revision, setRevision] = createSignal(0)

  function readCell(addr: string): CellValue {
    return {
      display: workbook.get_display(addr),
      type: workbook.get_type(addr) as CellValue['type'],
      isError: workbook.is_error(addr),
    }
  }

  function getSignal(addr: string) {
    if (!cellSignals.has(addr)) {
      cellSignals.set(addr, createSignal(readCell(addr)))
    }
    return cellSignals.get(addr)!
  }

  function readFormat(addr: string): CellFormat {
    return workbook.get_format(addr)
  }

  function getFormatSignal(addr: string) {
    if (!formatSignals.has(addr)) {
      formatSignals.set(addr, createSignal(readFormat(addr)))
    }
    return formatSignals.get(addr)!
  }

  function refreshCells() {
    batch(() => {
      for (const [addr, [, set]] of cellSignals) {
        set(readCell(addr))
      }
    })
  }

  function refreshFormats() {
    batch(() => {
      for (const [addr, [, set]] of formatSignals) {
        set(readFormat(addr))
      }
    })
  }

  function refreshMeta() {
    setMetaVersion((value) => value + 1)
  }

  function refreshSheets() {
    setSheetVersion((value) => value + 1)
    refreshMeta()
    setRevision((value) => value + 1)
  }

  function refreshAll() {
    refreshCells()
    refreshFormats()
    refreshMeta()
    setRevision((value) => value + 1)
  }

  function applyMutation(handler: () => void) {
    handler()
    refreshAll()
  }

  return {
    getCell(addr: string) {
      const [value] = getSignal(addr)
      return value()
    },
    getInput(addr: string) {
      return workbook.get_input(addr)
    },
    getCellFormat(addr: string) {
      const [value] = getFormatSignal(addr)
      return value()
    },
    setNumber(addr: string, value: number) {
      applyMutation(() => workbook.set_number(addr, value))
    },
    setText(addr: string, value: string) {
      applyMutation(() => workbook.set_text(addr, value))
    },
    setFormula(addr: string, formula: string) {
      applyMutation(() => workbook.set_formula(addr, formula))
    },
    clearCell(addr: string) {
      applyMutation(() => workbook.clear_cell(addr))
    },
    batchSetInputs(updates: { addr: string; input: string }[]) {
      const success = workbook.batch_set_inputs(
        updates.map((update) => update.addr),
        updates.map((update) => update.input),
      )
      if (success) refreshAll()
      return success
    },
    getInputSnapshot(addrs: string[]) {
      return addrs.map((addr) => ({
        addr,
        input: workbook.get_input(addr),
      }))
    },
    setCellInput(addr: string, input: string) {
      const trimmed = input.trim()
      if (trimmed === '') {
        applyMutation(() => workbook.clear_cell(addr))
      } else if (trimmed.startsWith('=')) {
        applyMutation(() => workbook.set_formula(addr, trimmed))
      } else {
        const number = Number(trimmed)
        if (!Number.isNaN(number)) {
          applyMutation(() => workbook.set_number(addr, number))
        } else {
          applyMutation(() => workbook.set_text(addr, trimmed))
        }
      }
    },
    rowCount() {
      metaVersion()
      return workbook.row_count()
    },
    colCount() {
      metaVersion()
      return workbook.col_count()
    },
    rowHeight(index: number) {
      metaVersion()
      return workbook.row_height(index)
    },
    colWidth(index: number) {
      metaVersion()
      return workbook.col_width(index)
    },
    setRowHeight(index: number, height: number) {
      applyMutation(() => workbook.set_row_height(index, height))
    },
    setColWidth(index: number, width: number) {
      applyMutation(() => workbook.set_col_width(index, width))
    },
    freezeTopRow() {
      metaVersion()
      return workbook.freeze_top_row()
    },
    freezeFirstColumn() {
      metaVersion()
      return workbook.freeze_first_column()
    },
    setFreezeTopRow(value: boolean) {
      applyMutation(() => workbook.set_freeze_top_row(value))
    },
    setFreezeFirstColumn(value: boolean) {
      applyMutation(() => workbook.set_freeze_first_column(value))
    },
    insertRow(index: number, count = 1) {
      applyMutation(() => workbook.insert_row(index, count))
    },
    deleteRow(index: number, count = 1) {
      applyMutation(() => workbook.delete_row(index, count))
    },
    insertCol(index: number, count = 1) {
      applyMutation(() => workbook.insert_col(index, count))
    },
    deleteCol(index: number, count = 1) {
      applyMutation(() => workbook.delete_col(index, count))
    },
    applyCellFormat(addrs: string[], format: Partial<CellFormat>) {
      if (addrs.length === 0) return
      applyMutation(() => workbook.set_format(addrs, format))
    },
    clearCellFormat(addrs: string[]) {
      if (addrs.length === 0) return
      applyMutation(() => workbook.clear_format(addrs))
    },
    exportJSON() {
      return workbook.export_json()
    },
    importJSON(payload: string) {
      const success = workbook.import_json(payload)
      if (success) refreshAll()
      return success
    },
    exportCSV(sheetIndex?: number) {
      return workbook.export_csv(sheetIndex)
    },
    importCSV(payload: string) {
      const success = workbook.import_csv(payload)
      if (success) refreshAll()
      return success
    },
    version() {
      return revision()
    },
    sheetNames() {
      sheetVersion()
      return Array.from({ length: workbook.sheet_count() }, (_, index) => workbook.sheet_name(index))
    },
    activeSheetIndex() {
      sheetVersion()
      return workbook.active_sheet_index()
    },
    setActiveSheet(index: number) {
      const success = workbook.set_active_sheet(index)
      if (success) {
        refreshCells()
        refreshFormats()
        refreshSheets()
      }
      return success
    },
    addSheet(name?: string) {
      const created = workbook.add_sheet(name)
      refreshCells()
      refreshFormats()
      refreshSheets()
      return created
    },
    removeSheet(index: number) {
      const success = workbook.remove_sheet(index)
      if (success) {
        refreshCells()
        refreshFormats()
        refreshSheets()
      }
      return success
    },
    renameSheet(index: number, nextName: string) {
      const success = workbook.rename_sheet(index, nextName)
      if (success) {
        refreshCells()
        refreshFormats()
        refreshSheets()
      }
      return success
    },
    takeSnapshot(): WorkbookSnapshot {
      return workbook.snapshot()
    },
    restoreSnapshot(snapshot: WorkbookSnapshot) {
      workbook.restore(snapshot)
      refreshCells()
      refreshFormats()
      refreshSheets()
      setRevision((value) => value + 1)
    },
    raw: workbook,
  }
}

export type WorkbookStore = ReturnType<typeof createWorkbookStore>
