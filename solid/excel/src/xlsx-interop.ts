import type { CellFormat, SheetStateSnapshot, WorkbookSnapshot } from './types'
import { parseAddr } from './js-sheet/address'

const DEFAULT_NUMBER_FORMAT: CellFormat['numberFormat'] = {
  kind: 'general',
  decimals: 2,
  useGrouping: false,
  currencySymbol: '$',
}

const DEFAULT_CELL_FORMAT: CellFormat = {
  bold: false,
  italic: false,
  fontSize: null,
  textColor: null,
  backgroundColor: null,
  horizontalAlign: null,
  verticalAlign: null,
  borderStyle: 'none',
  borderColor: null,
  numberFormat: { ...DEFAULT_NUMBER_FORMAT },
}

type ExcelJSModule = typeof import('exceljs')

let excelJSModulePromise: Promise<ExcelJSModule> | null = null
let rustXLSXModulePromise: Promise<{ exportWorkbookSnapshotToXlsx: (payload: string) => Uint8Array }> | null = null
const wasmModulePath = '/wasm/einfach_wasm.js'

function cloneCellFormat(format: CellFormat): CellFormat {
  return {
    ...format,
    numberFormat: { ...format.numberFormat },
  }
}

function defaultCellFormat(): CellFormat {
  return cloneCellFormat(DEFAULT_CELL_FORMAT)
}

function isDefaultCellFormat(format: CellFormat) {
  return JSON.stringify(format) === JSON.stringify(DEFAULT_CELL_FORMAT)
}

async function loadExcelJS() {
  if (!excelJSModulePromise) {
    excelJSModulePromise = import('exceljs')
  }
  const module = await excelJSModulePromise
  return 'Workbook' in module ? module : (module as { default: ExcelJSModule }).default
}

async function loadRustXLSXExporter() {
  if (!rustXLSXModulePromise) {
    rustXLSXModulePromise = import(/* @vite-ignore */ wasmModulePath) as Promise<{
      exportWorkbookSnapshotToXlsx: (payload: string) => Uint8Array
    }>
  }
  return rustXLSXModulePromise
}

function colIndexToLetters(index: number) {
  let current = index + 1
  let result = ''
  while (current > 0) {
    const remainder = (current - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    current = Math.floor((current - 1) / 26)
  }
  return result
}

type ParsedMergedRange = {
  range: string
  start: { row: number; col: number }
  end: { row: number; col: number }
  master: string
}

function parseMergedRange(range: string): ParsedMergedRange | null {
  const [rawStart, rawEnd] = range.split(':')
  if (!rawStart || !rawEnd) return null
  let start: { row: number; col: number }
  let end: { row: number; col: number }
  try {
    start = parseAddr(rawStart)
    end = parseAddr(rawEnd)
  } catch {
    return null
  }
  const top = Math.min(start.row, end.row)
  const bottom = Math.max(start.row, end.row)
  const left = Math.min(start.col, end.col)
  const right = Math.max(start.col, end.col)
  if (top === bottom && left === right) return null
  return {
    range: `${colIndexToLetters(left)}${top + 1}:${colIndexToLetters(right)}${bottom + 1}`,
    start: { row: top, col: left },
    end: { row: bottom, col: right },
    master: `${colIndexToLetters(left)}${top + 1}`,
  }
}

function iterateMergedRangeCells(parsed: ParsedMergedRange, visitor: (addr: string, isMaster: boolean) => void) {
  for (let row = parsed.start.row; row <= parsed.end.row; row += 1) {
    for (let col = parsed.start.col; col <= parsed.end.col; col += 1) {
      const addr = `${colIndexToLetters(col)}${row + 1}`
      visitor(addr, row === parsed.start.row && col === parsed.start.col)
    }
  }
}

function collectMergedRangeState(sheet: SheetStateSnapshot) {
  const ranges: string[] = []
  const occupied = new Set<string>()
  const coveredNonMasters = new Set<string>()

  for (const rawRange of sheet.mergedRanges ?? []) {
    const parsed = parseMergedRange(rawRange)
    if (!parsed) continue

    let overlaps = false
    iterateMergedRangeCells(parsed, (addr) => {
      if (occupied.has(addr)) overlaps = true
    })
    if (overlaps) continue

    ranges.push(parsed.range)
    iterateMergedRangeCells(parsed, (addr, isMaster) => {
      occupied.add(addr)
      if (!isMaster) coveredNonMasters.add(addr)
    })
  }

  return { ranges, coveredNonMasters }
}

function normalizeHexColor(input: string | null | undefined) {
  if (!input) return null
  const normalized = input.startsWith('#') ? input.slice(1) : input
  if (normalized.length === 8) return `#${normalized.slice(2).toLowerCase()}`
  if (normalized.length === 6) return `#${normalized.toLowerCase()}`
  return null
}

function toARGB(input: string | null | undefined) {
  const normalized = normalizeHexColor(input)
  return normalized ? `FF${normalized.slice(1).toUpperCase()}` : undefined
}

function numberFormatToExcel(numberFormat: CellFormat['numberFormat']) {
  const decimals = '0'.repeat(Math.max(0, numberFormat.decimals))
  const fractional = decimals ? `.${decimals}` : ''
  const grouped = numberFormat.useGrouping ? '#,##0' : '0'
  if (numberFormat.kind === 'general') return 'General'
  if (numberFormat.kind === 'percent') return `${grouped}${fractional}%`
  if (numberFormat.kind === 'currency') {
    return `"${numberFormat.currencySymbol}"${grouped}${fractional}`
  }
  return `${grouped}${fractional}`
}

function numberFormatFromExcel(numFmt: string | undefined): CellFormat['numberFormat'] {
  if (!numFmt) return { ...DEFAULT_NUMBER_FORMAT }
  const cleaned = numFmt.replace(/_/g, '').replace(/\\-/g, '-')
  const decimals = (cleaned.match(/0\.([0]+)/)?.[1]?.length) ?? 0
  const useGrouping = cleaned.includes('#,##')
  const currencyMatch = cleaned.match(/"([^"]+)"/) ?? cleaned.match(/\[\$([^\]-]+)/)
  if (cleaned.includes('%')) {
    return {
      kind: 'percent',
      decimals,
      useGrouping,
      currencySymbol: '$',
    }
  }
  if (currencyMatch) {
    return {
      kind: 'currency',
      decimals,
      useGrouping,
      currencySymbol: currencyMatch[1] || '$',
    }
  }
  if (/0/.test(cleaned) && cleaned !== 'General') {
    return {
      kind: 'fixed',
      decimals,
      useGrouping,
      currencySymbol: '$',
    }
  }
  return { ...DEFAULT_NUMBER_FORMAT }
}

function parseCellValue(value: unknown): { input: string; cell: SheetStateSnapshot['cells'][number][1] } | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    return { input: String(value), cell: { type: 'number', value } }
  }
  if (typeof value === 'boolean') {
    return { input: value ? 'TRUE' : 'FALSE', cell: { type: 'boolean', value } }
  }
  if (typeof value === 'string') {
    return { input: value, cell: { type: 'text', value } }
  }
  if (typeof value === 'object') {
    const formulaValue = value as { formula?: string; result?: unknown; error?: string; text?: string; richText?: Array<{ text: string }> }
    if (typeof formulaValue.formula === 'string') {
      const result = formulaValue.result
      if (typeof result === 'number') {
        return { input: `=${formulaValue.formula}`, cell: { type: 'number', value: result } }
      }
      if (typeof result === 'boolean') {
        return { input: `=${formulaValue.formula}`, cell: { type: 'boolean', value: result } }
      }
      if (typeof result === 'string') {
        return { input: `=${formulaValue.formula}`, cell: { type: 'text', value: result } }
      }
      return { input: `=${formulaValue.formula}`, cell: { type: 'null', value: null } }
    }
    if (typeof formulaValue.error === 'string') {
      return { input: formulaValue.error, cell: { type: 'error', value: formulaValue.error } }
    }
    if (typeof formulaValue.text === 'string') {
      return { input: formulaValue.text, cell: { type: 'text', value: formulaValue.text } }
    }
    if (Array.isArray(formulaValue.richText)) {
      const text = formulaValue.richText.map((part) => part.text).join('')
      return { input: text, cell: { type: 'text', value: text } }
    }
  }
  return null
}

function readCellFormat(cell: {
  font?: { bold?: boolean; italic?: boolean; size?: number; color?: { argb?: string } }
  fill?: { type?: string; pattern?: string; fgColor?: { argb?: string } }
  alignment?: { horizontal?: string; vertical?: string }
  border?: Record<string, { style?: string; color?: { argb?: string } }>
  numFmt?: string
}): CellFormat | null {
  const format = defaultCellFormat()
  if (cell.font?.bold) format.bold = true
  if (cell.font?.italic) format.italic = true
  if (typeof cell.font?.size === 'number') format.fontSize = cell.font.size
  format.textColor = normalizeHexColor(cell.font?.color?.argb)
  if (cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid') {
    format.backgroundColor = normalizeHexColor(cell.fill.fgColor?.argb)
  }
  if (cell.alignment?.horizontal && ['left', 'center', 'right'].includes(cell.alignment.horizontal)) {
    format.horizontalAlign = cell.alignment.horizontal as CellFormat['horizontalAlign']
  }
  if (cell.alignment?.vertical) {
    if (cell.alignment.vertical === 'middle' || cell.alignment.vertical === 'center') {
      format.verticalAlign = 'middle'
    } else if (cell.alignment.vertical === 'top' || cell.alignment.vertical === 'bottom') {
      format.verticalAlign = cell.alignment.vertical as CellFormat['verticalAlign']
    }
  }
  const borderEntry = Object.values(cell.border ?? {}).find((entry) => entry?.style)
  if (borderEntry) {
    format.borderStyle = 'solid'
    format.borderColor = normalizeHexColor(borderEntry.color?.argb)
  }
  format.numberFormat = numberFormatFromExcel(cell.numFmt)
  return isDefaultCellFormat(format) ? null : format
}

function writeCellFormat(cell: {
  font?: unknown
  fill?: unknown
  alignment?: unknown
  border?: unknown
  numFmt?: string
}, format: CellFormat) {
  const font: Record<string, unknown> = {}
  if (format.bold) font.bold = true
  if (format.italic) font.italic = true
  if (format.fontSize) font.size = format.fontSize
  const fontArgb = toARGB(format.textColor)
  if (fontArgb) font.color = { argb: fontArgb }
  if (Object.keys(font).length > 0) cell.font = font

  const fillArgb = toARGB(format.backgroundColor)
  if (fillArgb) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: fillArgb },
    }
  }

  if (format.horizontalAlign || format.verticalAlign) {
    cell.alignment = {
      ...(format.horizontalAlign ? { horizontal: format.horizontalAlign } : {}),
      ...(format.verticalAlign ? { vertical: format.verticalAlign === 'middle' ? 'center' : format.verticalAlign } : {}),
    }
  }

  if (format.borderStyle === 'solid') {
    const borderArgb = toARGB(format.borderColor) ?? 'FFAAB6C7'
    const border = {
      style: 'thin',
      color: { argb: borderArgb },
    }
    cell.border = {
      top: border,
      right: border,
      bottom: border,
      left: border,
    }
  }

  cell.numFmt = numberFormatToExcel(format.numberFormat)
}

function sheetBounds(sheet: SheetStateSnapshot) {
  const bounds = { rows: sheet.metadata.rowCount, cols: sheet.metadata.colCount }
  for (const [addr] of [...sheet.cells, ...sheet.formulas, ...sheet.formats]) {
    const match = addr.match(/^([A-Z]+)(\d+)$/)
    if (!match) continue
    const col = match[1].split('').reduce((sum, char) => sum * 26 + (char.charCodeAt(0) - 64), 0)
    const row = Number(match[2])
    bounds.rows = Math.max(bounds.rows, row)
    bounds.cols = Math.max(bounds.cols, col)
  }
  for (const rawRange of sheet.mergedRanges ?? []) {
    const parsed = parseMergedRange(rawRange)
    if (!parsed) continue
    bounds.rows = Math.max(bounds.rows, parsed.end.row + 1)
    bounds.cols = Math.max(bounds.cols, parsed.end.col + 1)
  }
  for (const [index] of sheet.rowHeights) bounds.rows = Math.max(bounds.rows, index + 1)
  for (const [index] of sheet.colWidths) bounds.cols = Math.max(bounds.cols, index + 1)
  if (sheet.metadata.freezeTopRow) bounds.rows = Math.max(bounds.rows, 1)
  if (sheet.metadata.freezeFirstColumn) bounds.cols = Math.max(bounds.cols, 1)
  return bounds
}

export async function importSnapshotFromXLSX(bytes: Uint8Array): Promise<WorkbookSnapshot> {
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes.slice().buffer)

  const sheets: WorkbookSnapshot['sheets'] = workbook.worksheets.map((worksheet) => {
    const cells = new Map<SheetStateSnapshot['cells'][number][0], SheetStateSnapshot['cells'][number][1]>()
    const formulas = new Map<SheetStateSnapshot['formulas'][number][0], SheetStateSnapshot['formulas'][number][1]>()
    const formats = new Map<SheetStateSnapshot['formats'][number][0], SheetStateSnapshot['formats'][number][1]>()

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const addr = `${colIndexToLetters(colNumber - 1)}${rowNumber}`
        const parsed = parseCellValue(cell.value)
        if (parsed) {
          if (parsed.input.startsWith('=')) formulas.set(addr, parsed.input)
          else cells.set(addr, parsed.cell)
        }
        const format = readCellFormat(cell)
        if (format) formats.set(addr, format)
      })
    })

    const rowHeights: Array<[number, number]> = []
    for (let rowIndex = 1; rowIndex <= worksheet.rowCount; rowIndex += 1) {
      const height = worksheet.getRow(rowIndex).height
      if (typeof height === 'number') rowHeights.push([rowIndex - 1, Math.round(height)])
    }

    const colWidths: Array<[number, number]> = []
    const columnCount = worksheet.columnCount || worksheet.actualColumnCount || 0
    for (let colIndex = 1; colIndex <= columnCount; colIndex += 1) {
      const width = worksheet.getColumn(colIndex).width
      if (typeof width === 'number') colWidths.push([colIndex - 1, Math.round(width)])
    }

    const frozenView = worksheet.views?.find((view) => view.state === 'frozen') as
      | { xSplit?: number; ySplit?: number }
      | undefined
    const freezeTopRow = Number(frozenView?.ySplit ?? 0) > 0
    const freezeFirstColumn = Number(frozenView?.xSplit ?? 0) > 0

    const metadataRows = Math.max(
      worksheet.rowCount,
      rowHeights.reduce((max, [index]) => Math.max(max, index + 1), 0),
      20,
      1,
    )
    const metadataCols = Math.max(
      columnCount,
      colWidths.reduce((max, [index]) => Math.max(max, index + 1), 0),
      10,
      1,
    )

    return {
      name: worksheet.name,
      metadata: {
        rowCount: metadataRows,
        colCount: metadataCols,
        freezeTopRow,
        freezeFirstColumn,
      },
      rowHeights,
      colWidths,
      cells: Array.from(cells.entries()),
      formulas: Array.from(formulas.entries()),
      formats: Array.from(formats.entries()),
      mergedRanges: [],
    }
  })

  const activeSheetIndex = Math.min(
    Number((workbook.views?.[0] as { activeTab?: number } | undefined)?.activeTab ?? 0),
    Math.max(sheets.length - 1, 0),
  )

  return {
    activeSheetIndex,
    sheets: sheets.length > 0 ? sheets : [{
      name: 'Sheet1',
      metadata: { rowCount: 20, colCount: 10, freezeTopRow: false, freezeFirstColumn: false },
      rowHeights: [],
      colWidths: [],
      cells: [],
      formulas: [],
      formats: [],
      mergedRanges: [],
    }],
  }
}

export async function exportSnapshotToXLSXInJS(snapshot: WorkbookSnapshot): Promise<Uint8Array> {
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  workbook.removeWorksheet(1)

  snapshot.sheets.forEach((sheetSnapshot, index) => {
    const worksheet = workbook.addWorksheet(sheetSnapshot.name)
    const { rows, cols } = sheetBounds(sheetSnapshot)
    worksheet.properties.defaultRowHeight = 28
    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      const height = sheetSnapshot.rowHeights.find(([key]) => key === rowIndex)?.[1]
      if (height) worksheet.getRow(rowIndex + 1).height = height
    }
    for (let colIndex = 0; colIndex < cols; colIndex += 1) {
      const width = sheetSnapshot.colWidths.find(([key]) => key === colIndex)?.[1]
      if (width) worksheet.getColumn(colIndex + 1).width = width
    }
    if (sheetSnapshot.metadata.freezeTopRow || sheetSnapshot.metadata.freezeFirstColumn) {
      worksheet.views = [{
        state: 'frozen',
        ySplit: sheetSnapshot.metadata.freezeTopRow ? 1 : 0,
        xSplit: sheetSnapshot.metadata.freezeFirstColumn ? 1 : 0,
      }]
    }

    const cellFormats = new Map(sheetSnapshot.formats)
    const primitives = new Map(sheetSnapshot.cells)
    const formulas = new Map(sheetSnapshot.formulas)
    const mergedState = collectMergedRangeState(sheetSnapshot)
    const addresses = new Set<string>([
      ...primitives.keys(),
      ...formulas.keys(),
      ...cellFormats.keys(),
    ])

    for (const addr of addresses) {
      if (mergedState.coveredNonMasters.has(addr)) continue
      const cell = worksheet.getCell(addr)
      if (formulas.has(addr)) {
        cell.value = { formula: formulas.get(addr)!.slice(1) }
      } else {
        const value = primitives.get(addr)
        if (value?.type === 'number') cell.value = value.value as number
        else if (value?.type === 'boolean') cell.value = value.value as boolean
        else if (value?.type === 'text') cell.value = value.value as string
      }
      const format = cellFormats.get(addr)
      if (format) writeCellFormat(cell, format)
    }

    for (const range of mergedState.ranges) {
      worksheet.mergeCells(range)
    }

    if (index === snapshot.activeSheetIndex) {
      ;(workbook as unknown as { views: Array<Record<string, unknown>> }).views = [{ activeTab: index }]
    }
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
}

export async function exportSnapshotToXLSX(snapshot: WorkbookSnapshot): Promise<Uint8Array> {
  try {
    const rustModule = await loadRustXLSXExporter()
    const exported = rustModule.exportWorkbookSnapshotToXlsx(JSON.stringify(snapshot))
    return exported instanceof Uint8Array ? exported : new Uint8Array(exported)
  } catch {
    return exportSnapshotToXLSXInJS(snapshot)
  }
}
