import type { ISheet } from './types'

/**
 * Pure JS implementation of ISheet for development/testing
 * without needing the WASM build. Uses a simple map of cell values.
 */
export function createJSSheet(): ISheet {
  const cells = new Map<string, { type: string; value: unknown; formula?: string }>()
  const formulas = new Map<string, string>()

  function parseAddr(addr: string): { col: string; row: number } {
    const match = addr.match(/^([A-Za-z]+)(\d+)$/)
    if (!match) throw new Error(`Invalid address: ${addr}`)
    return { col: match[1].toUpperCase(), row: parseInt(match[2]) }
  }

  function getNumeric(addr: string): number {
    const cell = cells.get(addr.toUpperCase())
    if (!cell) return 0
    if (cell.type === 'number') return cell.value as number
    if (cell.type === 'null') return 0
    return NaN
  }

  function evalFormula(formula: string): { type: string; value: unknown } {
    const expr = formula.slice(1).trim() // remove '='

    // Simple parser: handle cell refs, numbers, +, -, *, /
    // Also handle SUM(range)
    const sumMatch = expr.match(/^SUM\(([A-Z]+\d+):([A-Z]+\d+)\)$/i)
    if (sumMatch) {
      const start = sumMatch[1].toUpperCase()
      const end = sumMatch[2].toUpperCase()
      const startP = parseAddr(start)
      const endP = parseAddr(end)
      let total = 0
      const startCol = startP.col.charCodeAt(0)
      const endCol = endP.col.charCodeAt(0)
      for (let c = startCol; c <= endCol; c++) {
        for (let r = startP.row; r <= endP.row; r++) {
          const a = String.fromCharCode(c) + r
          total += getNumeric(a)
        }
      }
      return { type: 'number', value: total }
    }

    // Try to evaluate as simple arithmetic with cell refs
    try {
      const evaluated = expr.replace(/[A-Za-z]+\d+/g, (ref) => {
        const n = getNumeric(ref.toUpperCase())
        return String(n)
      })
      const result = Function(`"use strict"; return (${evaluated})`)()
      if (typeof result === 'number') {
        if (!isFinite(result)) {
          return { type: 'error', value: '#DIV/0!' }
        }
        return { type: 'number', value: result }
      }
      return { type: 'error', value: '#VALUE!' }
    } catch {
      return { type: 'error', value: '#ERROR!' }
    }
  }

  function recalcAll() {
    for (const [addr, formula] of formulas) {
      const result = evalFormula(formula)
      cells.set(addr, { ...result, formula })
    }
  }

  return {
    set_number(addr: string, value: number) {
      const a = addr.toUpperCase()
      formulas.delete(a)
      cells.set(a, { type: 'number', value })
      recalcAll()
    },

    set_text(addr: string, value: string) {
      const a = addr.toUpperCase()
      formulas.delete(a)
      cells.set(a, { type: 'text', value })
      recalcAll()
    },

    set_formula(addr: string, formula: string) {
      const a = addr.toUpperCase()
      formulas.set(a, formula)
      const result = evalFormula(formula)
      cells.set(a, { ...result, formula })
    },

    get_display(addr: string): string {
      const cell = cells.get(addr.toUpperCase())
      if (!cell) return ''
      if (cell.type === 'number') {
        const n = cell.value as number
        return n === Math.floor(n) && Math.abs(n) < 1e15 ? String(Math.round(n)) : String(n)
      }
      if (cell.type === 'error') return cell.value as string
      if (cell.type === 'boolean') return cell.value ? 'TRUE' : 'FALSE'
      if (cell.type === 'text') return cell.value as string
      return ''
    },

    get_number(addr: string): number {
      const cell = cells.get(addr.toUpperCase())
      if (!cell || cell.type !== 'number') return NaN
      return cell.value as number
    },

    get_type(addr: string): string {
      const cell = cells.get(addr.toUpperCase())
      return cell?.type ?? 'null'
    },

    is_error(addr: string): boolean {
      const cell = cells.get(addr.toUpperCase())
      return cell?.type === 'error'
    },
  }
}
