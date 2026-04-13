import type { CellRecord } from './types'

export function numberCell(value: number): CellRecord {
  return { type: 'number', value }
}

export function textCell(value: string): CellRecord {
  return { type: 'text', value }
}

export function booleanCell(value: boolean): CellRecord {
  return { type: 'boolean', value }
}

export function nullCell(): CellRecord {
  return { type: 'null', value: null }
}

export function errorCell(value: string): CellRecord {
  return { type: 'error', value }
}

export function coerceToNumber(cell: CellRecord): number | null {
  switch (cell.type) {
    case 'number':
      return cell.value as number
    case 'null':
      return 0
    case 'boolean':
      return cell.value ? 1 : 0
    default:
      return null
  }
}

export function cellToDisplay(cell: CellRecord): string {
  switch (cell.type) {
    case 'number': {
      const value = cell.value as number
      return value === Math.floor(value) && Math.abs(value) < 1e15
        ? String(Math.round(value))
        : String(value)
    }
    case 'text':
      return cell.value as string
    case 'boolean':
      return cell.value ? 'TRUE' : 'FALSE'
    case 'error':
      return cell.value as string
    case 'null':
      return ''
  }
}
