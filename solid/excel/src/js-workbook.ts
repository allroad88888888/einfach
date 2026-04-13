import type { IWorkbook, SheetMetadata, WorkbookSnapshot } from './types'
import {
  cellToDisplay,
  coerceToNumber,
  errorCell,
  normalizeAddr,
  numberCell,
  parseAddr,
  parseFormula,
  serializeFormula,
  textCell,
  nullCell,
  booleanCell,
  expandRange,
  colIndexToLetters,
} from './js-sheet/index'
import type { CellRecord, CellRef, Expr } from './js-sheet/index'

const DEFAULT_ROW_COUNT = 20
const DEFAULT_COL_COUNT = 10
const DEFAULT_ROW_HEIGHT = 28
const DEFAULT_COL_WIDTH = 120
const MIN_ROW_HEIGHT = 24
const MIN_COL_WIDTH = 56
const SHEET_NAME_PATTERN = /^[A-Za-z0-9_]+$/

type SheetState = {
  name: string
  metadata: SheetMetadata
  rowHeights: Map<number, number>
  colWidths: Map<number, number>
  cells: Map<string, CellRecord>
  formulas: Map<string, string>
}

type ComparisonOperator = '=' | '<>' | '<' | '<=' | '>' | '>='

type Criterion = {
  op: ComparisonOperator
  value: CellRecord
}

function createSheetState(name: string, rows = DEFAULT_ROW_COUNT, cols = DEFAULT_COL_COUNT): SheetState {
  return {
    name,
    metadata: {
      rowCount: rows,
      colCount: cols,
      freezeTopRow: false,
      freezeFirstColumn: false,
    },
    rowHeights: new Map(),
    colWidths: new Map(),
    cells: new Map(),
    formulas: new Map(),
  }
}

function cloneCellRecord(record: CellRecord): CellRecord {
  return {
    type: record.type,
    value: record.value,
  }
}

function defaultSheetName(existing: string[]) {
  let index = 1
  while (existing.includes(`Sheet${index}`)) {
    index += 1
  }
  return `Sheet${index}`
}

function isValidSheetName(name: string) {
  return SHEET_NAME_PATTERN.test(name)
}

function moveSizedEntries(entries: Map<number, number>, index: number, count: number, mode: 'insert' | 'delete') {
  const next = new Map<number, number>()
  for (const [key, value] of entries) {
    if (mode === 'insert') {
      next.set(key >= index ? key + count : key, value)
      continue
    }

    if (key >= index && key < index + count) {
      continue
    }
    next.set(key >= index + count ? key - count : key, value)
  }
  return next
}

function moveAddr(addr: string, axis: 'row' | 'col', index: number, count: number, mode: 'insert' | 'delete') {
  const coords = parseAddr(addr)
  const primary = axis === 'row' ? coords.row : coords.col

  if (mode === 'insert') {
    if (primary < index) return addr
    const next = axis === 'row'
      ? { row: coords.row + count, col: coords.col }
      : { row: coords.row, col: coords.col + count }
    return `${colIndexToLetters(next.col)}${next.row + 1}`
  }

  if (primary >= index && primary < index + count) {
    return null
  }

  const next = primary >= index + count
    ? axis === 'row'
      ? { row: coords.row - count, col: coords.col }
      : { row: coords.row, col: coords.col - count }
    : coords

  return `${colIndexToLetters(next.col)}${next.row + 1}`
}

function shiftGrid(sheet: SheetState, axis: 'row' | 'col', index: number, count: number, mode: 'insert' | 'delete') {
  const nextCells = new Map<string, CellRecord>()
  const nextFormulas = new Map<string, string>()

  for (const [addr, value] of sheet.cells) {
    const moved = moveAddr(addr, axis, index, count, mode)
    if (moved) nextCells.set(moved, cloneCellRecord(value))
  }
  for (const [addr, value] of sheet.formulas) {
    const moved = moveAddr(addr, axis, index, count, mode)
    if (moved) nextFormulas.set(moved, value)
  }

  sheet.cells = nextCells
  sheet.formulas = nextFormulas
  if (axis === 'row') {
    sheet.metadata.rowCount = Math.max(1, sheet.metadata.rowCount + (mode === 'insert' ? count : -count))
    sheet.rowHeights = moveSizedEntries(sheet.rowHeights, index, count, mode)
  } else {
    sheet.metadata.colCount = Math.max(1, sheet.metadata.colCount + (mode === 'insert' ? count : -count))
    sheet.colWidths = moveSizedEntries(sheet.colWidths, index, count, mode)
  }
}

function normalizeCellRef(ref: CellRef, currentSheet: string) {
  return {
    ...ref,
    sheetName: ref.sheetName ?? currentSheet,
  }
}

function shiftStructureRef(
  ref: CellRef,
  currentSheet: string,
  targetSheet: string,
  axis: 'row' | 'col',
  index: number,
  count: number,
  mode: 'insert' | 'delete',
): CellRef {
  if (ref.invalid) return { ...ref }

  const effectiveSheet = ref.sheetName ?? currentSheet
  if (effectiveSheet !== targetSheet) return { ...ref }

  const coords = parseAddr(ref.addr)
  const primary = axis === 'row' ? coords.row : coords.col

  if (mode === 'insert') {
    if (primary < index) return { ...ref }
    const next = axis === 'row'
      ? { row: coords.row + count, col: coords.col }
      : { row: coords.row, col: coords.col + count }
    return {
      ...ref,
      addr: `${colIndexToLetters(next.col)}${next.row + 1}`,
    }
  }

  if (primary >= index && primary < index + count) {
    return {
      ...ref,
      invalid: true,
      addr: 'A1',
    }
  }
  if (primary < index + count) return { ...ref }

  const next = axis === 'row'
    ? { row: coords.row - count, col: coords.col }
    : { row: coords.row, col: coords.col - count }
  return {
    ...ref,
    addr: `${colIndexToLetters(next.col)}${next.row + 1}`,
  }
}

function rewriteRangeForStructure(
  start: CellRef,
  end: CellRef,
  currentSheet: string,
  targetSheet: string,
  axis: 'row' | 'col',
  index: number,
  count: number,
  mode: 'insert' | 'delete',
) {
  const effectiveSheet = start.sheetName ?? currentSheet
  const endSheet = end.sheetName ?? currentSheet
  if (effectiveSheet !== endSheet || effectiveSheet !== targetSheet) {
    return {
      start: { ...start },
      end: { ...end },
    }
  }
  if (start.invalid || end.invalid) {
    return {
      start: { ...start },
      end: { ...end },
    }
  }

  const startCoords = parseAddr(start.addr)
  const endCoords = parseAddr(end.addr)
  const startPrimary = axis === 'row' ? startCoords.row : startCoords.col
  const endPrimary = axis === 'row' ? endCoords.row : endCoords.col
  const rangeStart = Math.min(startPrimary, endPrimary)
  const rangeEnd = Math.max(startPrimary, endPrimary)

  if (mode === 'insert') {
    if (rangeEnd < index) {
      return { start: { ...start }, end: { ...end } }
    }
    if (rangeStart >= index) {
      return {
        start: shiftStructureRef(start, currentSheet, targetSheet, axis, index, count, mode),
        end: shiftStructureRef(end, currentSheet, targetSheet, axis, index, count, mode),
      }
    }
    const nextEndCoords = axis === 'row'
      ? { row: endCoords.row + count, col: endCoords.col }
      : { row: endCoords.row, col: endCoords.col + count }
    return {
      start: { ...start },
      end: { ...end, addr: `${colIndexToLetters(nextEndCoords.col)}${nextEndCoords.row + 1}` },
    }
  }

  if (rangeEnd < index) {
    return { start: { ...start }, end: { ...end } }
  }
  if (rangeStart >= index + count) {
    return {
      start: shiftStructureRef(start, currentSheet, targetSheet, axis, index, count, mode),
      end: shiftStructureRef(end, currentSheet, targetSheet, axis, index, count, mode),
    }
  }

  const removedStart = Math.max(rangeStart, index)
  const removedEnd = Math.min(rangeEnd, index + count - 1)
  const removed = removedEnd >= removedStart ? removedEnd - removedStart + 1 : 0
  const remaining = (rangeEnd - rangeStart + 1) - removed
  if (remaining <= 0) {
    return {
      start: { ...start, invalid: true, addr: 'A1' },
      end: { ...end, invalid: true, addr: 'A1' },
    }
  }

  const nextStart = rangeStart < index ? rangeStart : index
  const nextEnd = nextStart + remaining - 1

  const rewrittenStart = { ...start }
  const rewrittenEnd = { ...end }
  const fixedStart = axis === 'row'
    ? { row: nextStart, col: startCoords.col }
    : { row: startCoords.row, col: nextStart }
  const fixedEnd = axis === 'row'
    ? { row: nextEnd, col: endCoords.col }
    : { row: endCoords.row, col: nextEnd }
  rewrittenStart.addr = `${colIndexToLetters(fixedStart.col)}${fixedStart.row + 1}`
  rewrittenEnd.addr = `${colIndexToLetters(fixedEnd.col)}${fixedEnd.row + 1}`
  return {
    start: rewrittenStart,
    end: rewrittenEnd,
  }
}

function rewriteExprForStructure(
  expr: Expr,
  currentSheet: string,
  targetSheet: string,
  axis: 'row' | 'col',
  index: number,
  count: number,
  mode: 'insert' | 'delete',
): Expr {
  switch (expr.kind) {
    case 'number':
    case 'text':
    case 'boolean':
    case 'error':
      return expr
    case 'cell':
      return {
        kind: 'cell',
        ref: shiftStructureRef(expr.ref, currentSheet, targetSheet, axis, index, count, mode),
      }
    case 'range': {
      const rewritten = rewriteRangeForStructure(expr.start, expr.end, currentSheet, targetSheet, axis, index, count, mode)
      return {
        kind: 'range',
        start: rewritten.start,
        end: rewritten.end,
      }
    }
    case 'negate':
      return { kind: 'negate', expr: rewriteExprForStructure(expr.expr, currentSheet, targetSheet, axis, index, count, mode) }
    case 'func':
      return {
        kind: 'func',
        name: expr.name,
        args: expr.args.map((arg) => rewriteExprForStructure(arg, currentSheet, targetSheet, axis, index, count, mode)),
      }
    case 'binop':
      return {
        kind: 'binop',
        op: expr.op,
        left: rewriteExprForStructure(expr.left, currentSheet, targetSheet, axis, index, count, mode),
        right: rewriteExprForStructure(expr.right, currentSheet, targetSheet, axis, index, count, mode),
      }
  }
}

function rewriteFormulaForStructure(
  input: string,
  currentSheet: string,
  targetSheet: string,
  axis: 'row' | 'col',
  index: number,
  count: number,
  mode: 'insert' | 'delete',
) {
  const expr = parseFormula(input)
  if (!expr) return input
  return serializeFormula(rewriteExprForStructure(expr, currentSheet, targetSheet, axis, index, count, mode))
}

function rewriteExprForSheetRename(expr: Expr, oldName: string, nextName: string): Expr {
  switch (expr.kind) {
    case 'number':
    case 'text':
    case 'boolean':
    case 'error':
      return expr
    case 'cell':
      return {
        kind: 'cell',
        ref: expr.ref.sheetName === oldName ? { ...expr.ref, sheetName: nextName } : expr.ref,
      }
    case 'range':
      return {
        kind: 'range',
        start: expr.start.sheetName === oldName ? { ...expr.start, sheetName: nextName } : expr.start,
        end: expr.end.sheetName === oldName ? { ...expr.end, sheetName: nextName } : expr.end,
      }
    case 'negate':
      return { kind: 'negate', expr: rewriteExprForSheetRename(expr.expr, oldName, nextName) }
    case 'func':
      return { kind: 'func', name: expr.name, args: expr.args.map((arg) => rewriteExprForSheetRename(arg, oldName, nextName)) }
    case 'binop':
      return {
        kind: 'binop',
        op: expr.op,
        left: rewriteExprForSheetRename(expr.left, oldName, nextName),
        right: rewriteExprForSheetRename(expr.right, oldName, nextName),
      }
  }
}

function rewriteExprForSheetDelete(expr: Expr, deletedName: string): Expr {
  switch (expr.kind) {
    case 'number':
    case 'text':
    case 'boolean':
    case 'error':
      return expr
    case 'cell':
      return {
        kind: 'cell',
        ref: expr.ref.sheetName === deletedName ? { ...expr.ref, invalid: true, addr: 'A1' } : expr.ref,
      }
    case 'range':
      return {
        kind: 'range',
        start: expr.start.sheetName === deletedName ? { ...expr.start, invalid: true, addr: 'A1' } : expr.start,
        end: expr.end.sheetName === deletedName ? { ...expr.end, invalid: true, addr: 'A1' } : expr.end,
      }
    case 'negate':
      return { kind: 'negate', expr: rewriteExprForSheetDelete(expr.expr, deletedName) }
    case 'func':
      return { kind: 'func', name: expr.name, args: expr.args.map((arg) => rewriteExprForSheetDelete(arg, deletedName)) }
    case 'binop':
      return {
        kind: 'binop',
        op: expr.op,
        left: rewriteExprForSheetDelete(expr.left, deletedName),
        right: rewriteExprForSheetDelete(expr.right, deletedName),
      }
  }
}

function rewriteFormula(input: string, transform: (expr: Expr) => Expr) {
  const expr = parseFormula(input)
  if (!expr) return input
  return serializeFormula(transform(expr))
}

export function createJSWorkbook(options?: {
  sheets?: Array<{ name: string; rows?: number; cols?: number }>
}): IWorkbook {
  let sheets = (options?.sheets?.length
    ? options.sheets.map((sheet) => createSheetState(sheet.name, sheet.rows, sheet.cols))
    : [createSheetState('Sheet1')])
  let activeSheetIndex = 0

  function currentSheet() {
    return sheets[activeSheetIndex] ?? sheets[0]
  }

  function findSheet(name: string) {
    return sheets.find((sheet) => sheet.name === name)
  }

  function refreshFormulaCache() {
    for (const sheet of sheets) {
      for (const addr of sheet.formulas.keys()) {
        sheet.cells.set(addr, computeCell(sheet.name, addr, new Set<string>()))
      }
    }
  }

  function getPrimitiveCell(sheetName: string, addr: string) {
    const sheet = findSheet(sheetName)
    return sheet?.cells.get(addr) ?? nullCell()
  }

  function evalBinOp(
    op: '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=',
    left: CellRecord,
    right: CellRecord,
  ): CellRecord {
    if (op === '&') return textCell(cellRecordToText(left) + cellRecordToText(right))
    if (op === '=' || op === '<>' || op === '<' || op === '<=' || op === '>' || op === '>=') {
      const comparison = compareCells(left, right)
      if (comparison === null) return errorCell('#VALUE!')
      if (op === '=') return booleanCell(comparison === 0)
      if (op === '<>') return booleanCell(comparison !== 0)
      if (op === '<') return booleanCell(comparison < 0)
      if (op === '<=') return booleanCell(comparison <= 0)
      if (op === '>') return booleanCell(comparison > 0)
      return booleanCell(comparison >= 0)
    }

    const leftNum = coerceToNumber(left)
    const rightNum = coerceToNumber(right)
    if (leftNum === null || rightNum === null) return errorCell('#VALUE!')
    if (op === '+') return numberCell(leftNum + rightNum)
    if (op === '-') return numberCell(leftNum - rightNum)
    if (op === '*') return numberCell(leftNum * rightNum)
    if (op === '/') return rightNum === 0 ? errorCell('#DIV/0!') : numberCell(leftNum / rightNum)
    return numberCell(leftNum ** rightNum)
  }

  function collectArgValues(arg: Expr, sheetName: string, visiting: Set<string>): CellRecord[] {
    if (arg.kind !== 'range') return [evalExpr(arg, sheetName, visiting)]
    if (arg.start.invalid || arg.end.invalid) return [errorCell('#REF!')]
    const startSheet = arg.start.sheetName ?? sheetName
    const endSheet = arg.end.sheetName ?? sheetName
    if (startSheet !== endSheet || !findSheet(startSheet)) return [errorCell('#REF!')]
    return expandRange(arg.start.addr, arg.end.addr).map((addr) => computeCell(startSheet, addr, visiting))
  }

  function computeCell(sheetName: string, addr: string, visiting: Set<string>): CellRecord {
    const sheet = findSheet(sheetName)
    if (!sheet) return errorCell('#REF!')
    const normalized = normalizeAddr(addr)
    const visitKey = `${sheetName}!${normalized}`
    const formula = sheet.formulas.get(normalized)
    if (!formula) return getPrimitiveCell(sheetName, normalized)
    if (visiting.has(visitKey)) return errorCell('#CYCLE!')

    visiting.add(visitKey)
    const expr = parseFormula(formula)
    const result = expr ? evalExpr(expr, sheetName, visiting) : errorCell('#VALUE!')
    visiting.delete(visitKey)
    return result
  }

  function evalExpr(expr: Expr, sheetName: string, visiting: Set<string>): CellRecord {
    switch (expr.kind) {
      case 'number':
        return numberCell(expr.value)
      case 'text':
        return textCell(expr.value)
      case 'boolean':
        return booleanCell(expr.value)
      case 'error':
        return errorCell(expr.value)
      case 'cell': {
        const ref = normalizeCellRef(expr.ref, sheetName)
        if (ref.invalid) return errorCell('#REF!')
        if (!findSheet(ref.sheetName)) return errorCell('#REF!')
        return computeCell(ref.sheetName!, ref.addr, visiting)
      }
      case 'range':
        return errorCell('#VALUE!')
      case 'negate': {
        const value = evalExpr(expr.expr, sheetName, visiting)
        if (value.type === 'error') return value
        const number = coerceToNumber(value)
        return number === null ? errorCell('#VALUE!') : numberCell(-number)
      }
      case 'binop': {
        const left = evalExpr(expr.left, sheetName, visiting)
        if (left.type === 'error') return left
        const right = evalExpr(expr.right, sheetName, visiting)
        if (right.type === 'error') return right
        return evalBinOp(expr.op, left, right)
      }
      case 'func':
        return evalFunc(expr.name, expr.args, sheetName, visiting)
    }
  }

  function evalFunc(name: string, args: Expr[], sheetName: string, visiting: Set<string>): CellRecord {
    switch (name) {
      case 'SUM': {
        let total = 0
        for (const arg of args) {
          for (const value of collectArgValues(arg, sheetName, visiting)) {
            if (value.type === 'error') return value
            if (value.type === 'number') total += value.value as number
            if (value.type === 'boolean' && value.value) total += 1
          }
        }
        return numberCell(total)
      }
      case 'AVERAGE': {
        let total = 0
        let count = 0
        for (const arg of args) {
          for (const value of collectArgValues(arg, sheetName, visiting)) {
            if (value.type === 'error') return value
            if (value.type === 'number') {
              total += value.value as number
              count += 1
            }
          }
        }
        return count === 0 ? errorCell('#DIV/0!') : numberCell(total / count)
      }
      case 'COUNT': {
        let count = 0
        for (const arg of args) {
          for (const value of collectArgValues(arg, sheetName, visiting)) {
            if (value.type === 'number') count += 1
          }
        }
        return numberCell(count)
      }
      case 'IF': {
        if (args.length < 2 || args.length > 3) return errorCell('#VALUE!')
        const condition = evalExpr(args[0], sheetName, visiting)
        if (condition.type === 'error') return condition
        const truthy = coerceToBoolean(condition)
        if (truthy === null) return errorCell('#VALUE!')
        return truthy ? evalExpr(args[1], sheetName, visiting) : args[2] ? evalExpr(args[2], sheetName, visiting) : booleanCell(false)
      }
      case 'MIN':
      case 'MAX': {
        let current: number | null = null
        for (const arg of args) {
          for (const value of collectArgValues(arg, sheetName, visiting)) {
            if (value.type === 'error') return value
            if (value.type === 'number') {
              const next = value.value as number
              current = current === null ? next : name === 'MIN' ? Math.min(current, next) : Math.max(current, next)
            }
          }
        }
        return numberCell(current ?? 0)
      }
      case 'AND':
      case 'OR': {
        if (args.length === 0) return errorCell('#VALUE!')
        for (const arg of args) {
          const value = evalExpr(arg, sheetName, visiting)
          if (value.type === 'error') return value
          const truthy = coerceToBoolean(value)
          if (truthy === null) return errorCell('#VALUE!')
          if (name === 'AND' && !truthy) return booleanCell(false)
          if (name === 'OR' && truthy) return booleanCell(true)
        }
        return booleanCell(name === 'AND')
      }
      case 'NOT': {
        if (args.length !== 1) return errorCell('#VALUE!')
        const value = evalExpr(args[0], sheetName, visiting)
        if (value.type === 'error') return value
        const truthy = coerceToBoolean(value)
        return truthy === null ? errorCell('#VALUE!') : booleanCell(!truthy)
      }
      case 'ABS': {
        if (args.length !== 1) return errorCell('#VALUE!')
        const value = evalExpr(args[0], sheetName, visiting)
        const number = coerceToNumber(value)
        return number === null ? errorCell('#VALUE!') : numberCell(Math.abs(number))
      }
      case 'ROUND': {
        if (args.length !== 2) return errorCell('#VALUE!')
        const value = coerceToNumber(evalExpr(args[0], sheetName, visiting))
        const digits = coerceToNumber(evalExpr(args[1], sheetName, visiting))
        return value === null || digits === null ? errorCell('#VALUE!') : numberCell(roundWithDigits(value, Math.trunc(digits)))
      }
      case 'CEILING':
      case 'FLOOR': {
        if (args.length === 0 || args.length > 2) return errorCell('#VALUE!')
        const value = coerceToNumber(evalExpr(args[0], sheetName, visiting))
        if (value === null) return errorCell('#VALUE!')
        const step = args[1] ? coerceToNumber(evalExpr(args[1], sheetName, visiting)) : 1
        if (step === null) return errorCell('#VALUE!')
        if (step === 0) return numberCell(0)
        const significance = Math.abs(step)
        return numberCell((name === 'CEILING' ? Math.ceil(value / significance) : Math.floor(value / significance)) * significance)
      }
      case 'SQRT': {
        if (args.length !== 1) return errorCell('#VALUE!')
        const value = coerceToNumber(evalExpr(args[0], sheetName, visiting))
        return value === null || value < 0 ? errorCell('#VALUE!') : numberCell(Math.sqrt(value))
      }
      case 'POWER': {
        if (args.length !== 2) return errorCell('#VALUE!')
        const left = coerceToNumber(evalExpr(args[0], sheetName, visiting))
        const right = coerceToNumber(evalExpr(args[1], sheetName, visiting))
        return left === null || right === null ? errorCell('#VALUE!') : numberCell(left ** right)
      }
      case 'MOD': {
        if (args.length !== 2) return errorCell('#VALUE!')
        const left = coerceToNumber(evalExpr(args[0], sheetName, visiting))
        const right = coerceToNumber(evalExpr(args[1], sheetName, visiting))
        if (left === null || right === null) return errorCell('#VALUE!')
        if (right === 0) return errorCell('#DIV/0!')
        return numberCell(left - right * Math.floor(left / right))
      }
      case 'CONCATENATE': {
        let output = ''
        for (const arg of args) {
          for (const value of collectArgValues(arg, sheetName, visiting)) {
            if (value.type === 'error') return value
            output += cellRecordToText(value)
          }
        }
        return textCell(output)
      }
      case 'LEN': {
        if (args.length !== 1) return errorCell('#VALUE!')
        return numberCell(Array.from(cellRecordToText(evalExpr(args[0], sheetName, visiting))).length)
      }
      case 'LEFT':
      case 'RIGHT': {
        if (args.length === 0 || args.length > 2) return errorCell('#VALUE!')
        const text = cellRecordToText(evalExpr(args[0], sheetName, visiting))
        const count = args[1] ? coerceToNumber(evalExpr(args[1], sheetName, visiting)) : 1
        if (count === null || count < 0) return errorCell('#VALUE!')
        const chars = Array.from(text)
        const size = Math.trunc(count)
        return textCell(name === 'LEFT' ? chars.slice(0, size).join('') : chars.slice(Math.max(chars.length - size, 0)).join(''))
      }
      case 'MID': {
        if (args.length !== 3) return errorCell('#VALUE!')
        const text = cellRecordToText(evalExpr(args[0], sheetName, visiting))
        const start = coerceToNumber(evalExpr(args[1], sheetName, visiting))
        const length = coerceToNumber(evalExpr(args[2], sheetName, visiting))
        if (start === null || length === null || start < 1 || length < 0) return errorCell('#VALUE!')
        return textCell(Array.from(text).slice(Math.trunc(start) - 1, Math.trunc(start) - 1 + Math.trunc(length)).join(''))
      }
      case 'UPPER':
        return textCell(cellRecordToText(evalExpr(args[0], sheetName, visiting)).toUpperCase())
      case 'LOWER':
        return textCell(cellRecordToText(evalExpr(args[0], sheetName, visiting)).toLowerCase())
      case 'TRIM':
        return textCell(cellRecordToText(evalExpr(args[0], sheetName, visiting)).trim().split(/\s+/).filter(Boolean).join(' '))
      case 'TEXT': {
        if (args.length !== 2) return errorCell('#VALUE!')
        const value = coerceToNumber(evalExpr(args[0], sheetName, visiting))
        if (value === null) return errorCell('#VALUE!')
        const format = cellRecordToText(evalExpr(args[1], sheetName, visiting))
        const formatted = applyTextFormat(value, format)
        return formatted === null ? errorCell('#VALUE!') : textCell(formatted)
      }
      case 'COUNTIF':
      case 'SUMIF': {
        if (args.length < 2 || args.length > 3) return errorCell('#VALUE!')
        const criteriaRange = collectArgValues(args[0], sheetName, visiting)
        const sumRange = name === 'SUMIF' && args[2]
          ? collectArgValues(args[2], sheetName, visiting)
          : criteriaRange
        const criterion = buildCriterion(args[1], sheetName, visiting)
        if ('type' in criterion && criterion.type === 'error') return criterion
        const resolvedCriterion = criterion as Criterion
        let total = 0
        let count = 0
        for (let index = 0; index < criteriaRange.length; index += 1) {
          const criteriaValue = criteriaRange[index]
          const sumValue = sumRange[index]
          if (criteriaValue?.type === 'error') return criteriaValue
          if (sumValue?.type === 'error') return sumValue
          if (!criteriaValue || !sumValue || !matchesCriterion(criteriaValue, resolvedCriterion)) continue
          if (name === 'COUNTIF') {
            count += 1
            continue
          }
          const number = coerceToNumber(sumValue)
          if (number === null) return errorCell('#VALUE!')
          total += number
        }
        return name === 'COUNTIF' ? numberCell(count) : numberCell(total)
      }
      default:
        return errorCell('#NAME?')
    }
  }

  function buildCriterion(expr: Expr, sheetName: string, visiting: Set<string>): Criterion | CellRecord {
    const raw = evalExpr(expr, sheetName, visiting)
    if (raw.type === 'error') return raw
    if (raw.type !== 'text') return { op: '=', value: raw }
    const text = String(raw.value).trim()
    const parsed =
      text.startsWith('<=') ? { op: '<=' as const, rest: text.slice(2) }
      : text.startsWith('>=') ? { op: '>=' as const, rest: text.slice(2) }
      : text.startsWith('<>') ? { op: '<>' as const, rest: text.slice(2) }
      : text.startsWith('<') ? { op: '<' as const, rest: text.slice(1) }
      : text.startsWith('>') ? { op: '>' as const, rest: text.slice(1) }
      : text.startsWith('=') ? { op: '=' as const, rest: text.slice(1) }
      : { op: '=' as const, rest: text }
    return {
      op: parsed.op,
      value: criterionOperand(parsed.rest.trim()),
    }
  }

  function rewriteFormulasAcrossWorkbook(handler: (formula: string, ownerSheet: string) => string) {
    for (const sheet of sheets) {
      sheet.formulas = new Map(Array.from(sheet.formulas.entries()).map(([addr, formula]) => [addr, handler(formula, sheet.name)]))
    }
    refreshFormulaCache()
  }

  function applyInput(sheet: SheetState, addr: string, input: string) {
    const normalized = normalizeAddr(addr)
    const trimmed = input.trim()
    if (trimmed === '') {
      sheet.formulas.delete(normalized)
      sheet.cells.delete(normalized)
      return
    }
    if (trimmed.startsWith('=')) {
      sheet.formulas.set(normalized, trimmed)
      return
    }
    sheet.formulas.delete(normalized)
    const number = Number(trimmed)
    sheet.cells.set(normalized, Number.isNaN(number) ? textCell(trimmed) : numberCell(number))
  }

  function getCellRecord(addr: string) {
    const sheet = currentSheet()
    const normalized = normalizeAddr(addr)
    if (sheet.formulas.has(normalized)) {
      const value = computeCell(sheet.name, normalized, new Set<string>())
      sheet.cells.set(normalized, value)
      return value
    }
    return sheet.cells.get(normalized) ?? nullCell()
  }

  function getInput(addr: string) {
    const sheet = currentSheet()
    const normalized = normalizeAddr(addr)
    if (sheet.formulas.has(normalized)) {
      return sheet.formulas.get(normalized) ?? ''
    }
    return cellToDisplay(getCellRecord(normalized))
  }

  function snapshot(): WorkbookSnapshot {
    return {
      activeSheetIndex,
      sheets: sheets.map((sheet) => ({
        name: sheet.name,
        metadata: { ...sheet.metadata },
        rowHeights: Array.from(sheet.rowHeights.entries()),
        colWidths: Array.from(sheet.colWidths.entries()),
        cells: Array.from(sheet.cells.entries()).map(([addr, value]) => [addr, cloneCellRecord(value)]),
        formulas: Array.from(sheet.formulas.entries()),
      })),
    }
  }

  function restore(next: WorkbookSnapshot) {
    activeSheetIndex = next.activeSheetIndex
    sheets = next.sheets.map((sheet) => ({
      name: sheet.name,
      metadata: { ...sheet.metadata },
      rowHeights: new Map(sheet.rowHeights),
      colWidths: new Map(sheet.colWidths),
      cells: new Map(sheet.cells.map(([addr, value]) => [addr, cloneCellRecord(value as CellRecord)])),
      formulas: new Map(sheet.formulas),
    }))
    refreshFormulaCache()
  }

  function applyActiveMutation(handler: (sheet: SheetState) => void) {
    handler(currentSheet())
    refreshFormulaCache()
  }

  refreshFormulaCache()

  return {
    set_number(addr, value) {
      applyActiveMutation((sheet) => {
        const normalized = normalizeAddr(addr)
        sheet.formulas.delete(normalized)
        sheet.cells.set(normalized, numberCell(value))
      })
    },
    set_text(addr, value) {
      applyActiveMutation((sheet) => {
        const normalized = normalizeAddr(addr)
        sheet.formulas.delete(normalized)
        sheet.cells.set(normalized, textCell(value))
      })
    },
    set_formula(addr, formula) {
      applyActiveMutation((sheet) => {
        sheet.formulas.set(normalizeAddr(addr), formula)
      })
    },
    clear_cell(addr) {
      applyActiveMutation((sheet) => {
        const normalized = normalizeAddr(addr)
        sheet.formulas.delete(normalized)
        sheet.cells.delete(normalized)
      })
    },
    batch_set_inputs(addrs, inputs) {
      if (addrs.length !== inputs.length) return false
      applyActiveMutation((sheet) => {
        for (let index = 0; index < addrs.length; index += 1) {
          applyInput(sheet, addrs[index], inputs[index])
        }
      })
      return true
    },
    get_display(addr) {
      return cellToDisplay(getCellRecord(addr))
    },
    get_input(addr) {
      return getInput(addr)
    },
    get_number(addr) {
      const cell = getCellRecord(addr)
      return cell.type === 'number' ? (cell.value as number) : Number.NaN
    },
    get_type(addr) {
      return getCellRecord(addr).type
    },
    is_error(addr) {
      return getCellRecord(addr).type === 'error'
    },
    sheet_count() {
      return sheets.length
    },
    sheet_name(index) {
      return sheets[index]?.name ?? ''
    },
    active_sheet_index() {
      return activeSheetIndex
    },
    set_active_sheet(index) {
      if (!sheets[index]) return false
      activeSheetIndex = index
      return true
    },
    add_sheet(name) {
      const nextName = name && isValidSheetName(name) && !findSheet(name) ? name : defaultSheetName(sheets.map((sheet) => sheet.name))
      sheets.push(createSheetState(nextName))
      activeSheetIndex = sheets.length - 1
      return nextName
    },
    remove_sheet(index) {
      if (sheets.length <= 1 || !sheets[index]) return false
      const [removed] = sheets.splice(index, 1)
      activeSheetIndex = Math.max(0, Math.min(activeSheetIndex, sheets.length - 1))
      rewriteFormulasAcrossWorkbook((formula) => rewriteFormula(formula, (expr) => rewriteExprForSheetDelete(expr, removed.name)))
      return true
    },
    rename_sheet(index, nextName) {
      if (!sheets[index] || !isValidSheetName(nextName) || sheets.some((sheet, sheetIndex) => sheetIndex !== index && sheet.name === nextName)) {
        return false
      }
      const previous = sheets[index].name
      sheets[index].name = nextName
      rewriteFormulasAcrossWorkbook((formula) => rewriteFormula(formula, (expr) => rewriteExprForSheetRename(expr, previous, nextName)))
      return true
    },
    row_count() {
      return currentSheet().metadata.rowCount
    },
    col_count() {
      return currentSheet().metadata.colCount
    },
    row_height(index) {
      return currentSheet().rowHeights.get(index) ?? DEFAULT_ROW_HEIGHT
    },
    col_width(index) {
      return currentSheet().colWidths.get(index) ?? DEFAULT_COL_WIDTH
    },
    set_row_height(index, height) {
      currentSheet().rowHeights.set(index, Math.max(MIN_ROW_HEIGHT, Math.round(height)))
    },
    set_col_width(index, width) {
      currentSheet().colWidths.set(index, Math.max(MIN_COL_WIDTH, Math.round(width)))
    },
    freeze_top_row() {
      return currentSheet().metadata.freezeTopRow
    },
    freeze_first_column() {
      return currentSheet().metadata.freezeFirstColumn
    },
    set_freeze_top_row(value) {
      currentSheet().metadata.freezeTopRow = value
    },
    set_freeze_first_column(value) {
      currentSheet().metadata.freezeFirstColumn = value
    },
    insert_row(index, count = 1) {
      const target = currentSheet()
      shiftGrid(target, 'row', index, count, 'insert')
      rewriteFormulasAcrossWorkbook((formula, ownerSheet) =>
        rewriteFormulaForStructure(formula, ownerSheet, target.name, 'row', index, count, 'insert'),
      )
    },
    delete_row(index, count = 1) {
      const target = currentSheet()
      shiftGrid(target, 'row', index, count, 'delete')
      rewriteFormulasAcrossWorkbook((formula, ownerSheet) =>
        rewriteFormulaForStructure(formula, ownerSheet, target.name, 'row', index, count, 'delete'),
      )
    },
    insert_col(index, count = 1) {
      const target = currentSheet()
      shiftGrid(target, 'col', index, count, 'insert')
      rewriteFormulasAcrossWorkbook((formula, ownerSheet) =>
        rewriteFormulaForStructure(formula, ownerSheet, target.name, 'col', index, count, 'insert'),
      )
    },
    delete_col(index, count = 1) {
      const target = currentSheet()
      shiftGrid(target, 'col', index, count, 'delete')
      rewriteFormulasAcrossWorkbook((formula, ownerSheet) =>
        rewriteFormulaForStructure(formula, ownerSheet, target.name, 'col', index, count, 'delete'),
      )
    },
    snapshot,
    restore,
  }
}

export function createJSSheet() {
  const workbook = createJSWorkbook({ sheets: [{ name: 'Sheet1' }] })
  return {
    set_number: workbook.set_number,
    set_text: workbook.set_text,
    set_formula: workbook.set_formula,
    clear_cell: workbook.clear_cell,
    batch_set_inputs: workbook.batch_set_inputs,
    get_display: workbook.get_display,
    get_input: workbook.get_input,
    get_number: workbook.get_number,
    get_type: workbook.get_type,
    is_error: workbook.is_error,
  }
}

function compareCells(left: CellRecord, right: CellRecord): number | null {
  if (left.type === 'text' && right.type === 'text') return String(left.value).localeCompare(String(right.value))
  if (left.type === 'boolean' && right.type === 'boolean') return Number(Boolean(left.value)) - Number(Boolean(right.value))
  const leftNumber = coerceToNumber(left)
  const rightNumber = coerceToNumber(right)
  if (leftNumber === null || rightNumber === null) return null
  return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1
}

function coerceToBoolean(value: CellRecord): boolean | null {
  if (value.type === 'boolean') return Boolean(value.value)
  if (value.type === 'number') return (value.value as number) !== 0
  if (value.type === 'null') return false
  return null
}

function cellRecordToText(value: CellRecord) {
  if (value.type === 'text') return value.value as string
  return cellToDisplay(value)
}

function criterionOperand(text: string): CellRecord {
  if (text.toUpperCase() === 'TRUE') return booleanCell(true)
  if (text.toUpperCase() === 'FALSE') return booleanCell(false)
  if (text !== '' && !Number.isNaN(Number(text))) return numberCell(Number(text))
  return textCell(text)
}

function matchesCriterion(value: CellRecord, criterion: Criterion) {
  const comparison = compareCells(value, criterion.value)
  if (comparison === null) return false
  return criterion.op === '=' ? comparison === 0
    : criterion.op === '<>' ? comparison !== 0
    : criterion.op === '<' ? comparison < 0
    : criterion.op === '<=' ? comparison <= 0
    : criterion.op === '>' ? comparison > 0
    : comparison >= 0
}

function roundWithDigits(value: number, digits: number) {
  if (digits >= 0) {
    const factor = 10 ** digits
    return Math.round(value * factor) / factor
  }
  const factor = 10 ** Math.abs(digits)
  return Math.round(value / factor) * factor
}

function applyTextFormat(value: number, formatText: string): string | null {
  if (!formatText) return ''
  const numericPattern = Array.from(formatText).filter((char) => ['0', '#', '.', ','].includes(char)).join('')
  if (!numericPattern) return null
  const percent = formatText.includes('%')
  const decimals = numericPattern.includes('.') ? numericPattern.split('.')[1].replace(/[^0#]/g, '').length : 0
  const grouped = numericPattern.includes(',')
  const prefix = formatText.match(/^[^0#.,]*/)?.[0] ?? ''
  const suffix = formatText.match(/[^0#.,]*$/)?.[0] ?? ''
  const scaled = percent ? value * 100 : value
  const rounded = roundWithDigits(scaled, decimals)
  const sign = rounded < 0 ? '-' : ''
  const body = grouped ? formatGrouped(Math.abs(rounded), decimals) : Math.abs(rounded).toFixed(decimals)
  return `${sign}${prefix}${body}${suffix}`
}

function formatGrouped(value: number, decimals: number) {
  const [integer, fraction] = value.toFixed(decimals).split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}
