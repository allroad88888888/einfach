import type { CellRef } from './types'

export function normalizeAddr(addr: string): string {
  return addr.replace(/\$/g, '').toUpperCase()
}

export function colLettersToIndex(input: string): number {
  let index = 0
  for (const char of input.toUpperCase()) {
    index = (index * 26) + (char.charCodeAt(0) - 64)
  }
  return index - 1
}

export function colIndexToLetters(col: number): string {
  let result = ''
  let current = col
  do {
    result = String.fromCharCode(65 + (current % 26)) + result
    current = Math.floor(current / 26) - 1
  } while (current >= 0)
  return result
}

export function parseAddr(addr: string): { row: number; col: number } {
  const match = normalizeAddr(addr).match(/^([A-Z]+)(\d+)$/)
  if (!match) throw new Error(`Invalid address: ${addr}`)

  const row = Number.parseInt(match[2], 10)
  if (row <= 0) throw new Error(`Invalid address: ${addr}`)

  return { col: colLettersToIndex(match[1]), row: row - 1 }
}

export function isCellAddress(addr: string): boolean {
  try {
    parseAddr(addr)
    return true
  } catch {
    return false
  }
}

export function expandRange(startAddr: string, endAddr: string): string[] {
  const start = parseAddr(startAddr)
  const end = parseAddr(endAddr)
  const minRow = Math.min(start.row, end.row)
  const maxRow = Math.max(start.row, end.row)
  const minCol = Math.min(start.col, end.col)
  const maxCol = Math.max(start.col, end.col)
  const result: string[] = []

  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      result.push(`${colIndexToLetters(col)}${row + 1}`)
    }
  }

  return result
}

export function parseCellRef(input: string): CellRef {
  const trimmed = input.trim()
  const sheetMatch = trimmed.match(/^([A-Za-z0-9_]+)!(.+)$/)
  const sheetName = sheetMatch?.[1]
  const refPart = sheetMatch?.[2] ?? trimmed
  const match = refPart.toUpperCase().match(/^(\$?)([A-Z]+)(\$?)(\d+)$/)
  if (!match) throw new Error(`Invalid reference: ${input}`)

  const row = Number.parseInt(match[4], 10)
  if (row <= 0) throw new Error(`Invalid reference: ${input}`)

  return {
    addr: `${match[2]}${row}`,
    absCol: match[1] === '$',
    absRow: match[3] === '$',
    sheetName,
  }
}

export function formatCellRef(ref: CellRef): string {
  if (ref.invalid) {
    return '#REF!'
  }
  const { col, row } = parseAddr(ref.addr)
  const core = `${ref.absCol ? '$' : ''}${colIndexToLetters(col)}${ref.absRow ? '$' : ''}${row + 1}`
  return ref.sheetName ? `${ref.sheetName}!${core}` : core
}

export function shiftCellRef(ref: CellRef, rowDelta: number, colDelta: number): CellRef {
  if (ref.invalid) {
    return { ...ref }
  }

  const { row, col } = parseAddr(ref.addr)
  const shiftedRow = ref.absRow ? row : row + rowDelta
  const shiftedCol = ref.absCol ? col : col + colDelta

  if (shiftedRow < 0 || shiftedCol < 0) {
    return {
      addr: 'A1',
      absCol: ref.absCol,
      absRow: ref.absRow,
      invalid: true,
      sheetName: ref.sheetName,
    }
  }

  return {
    addr: `${colIndexToLetters(shiftedCol)}${shiftedRow + 1}`,
    absCol: ref.absCol,
    absRow: ref.absRow,
    sheetName: ref.sheetName,
  }
}
