import { createSignal, batch } from 'solid-js'
import type { ISheet, CellValue } from './types'

/**
 * Reactive wrapper around ISheet.
 * Tracks cell reads via SolidJS signals so components re-render on changes.
 */
export function createSheetStore(sheet: ISheet) {
  const signals = new Map<string, ReturnType<typeof createSignal<CellValue>>>()

  function getSignal(addr: string) {
    if (!signals.has(addr)) {
      const value = readCell(addr)
      signals.set(addr, createSignal<CellValue>(value))
    }
    return signals.get(addr)!
  }

  function readCell(addr: string): CellValue {
    return {
      display: sheet.get_display(addr),
      type: sheet.get_type(addr) as CellValue['type'],
      isError: sheet.is_error(addr),
    }
  }

  /** Refresh signals for all tracked cells */
  function refreshAll() {
    batch(() => {
      for (const [addr, [, set]] of signals) {
        set(readCell(addr))
      }
    })
  }

  /** Refresh a specific cell and its dependents (simple: refresh all) */
  function refresh() {
    refreshAll()
  }

  return {
    /** Get a reactive cell value. Components calling this will re-render on change. */
    getCell(addr: string): CellValue {
      const [value] = getSignal(addr)
      return value()
    },

    /** Set a cell to a number and refresh reactive state. */
    setNumber(addr: string, value: number) {
      sheet.set_number(addr, value)
      refresh()
    },

    /** Set a cell to text and refresh reactive state. */
    setText(addr: string, value: string) {
      sheet.set_text(addr, value)
      refresh()
    },

    /** Set a cell's formula and refresh reactive state. */
    setFormula(addr: string, formula: string) {
      sheet.set_formula(addr, formula)
      refresh()
    },

    /** Set a cell from raw input. Detects formulas (=...), numbers, and text. */
    setCellInput(addr: string, input: string) {
      const trimmed = input.trim()
      if (trimmed.startsWith('=')) {
        sheet.set_formula(addr, trimmed)
      } else {
        const num = Number(trimmed)
        if (trimmed !== '' && !isNaN(num)) {
          sheet.set_number(addr, num)
        } else {
          sheet.set_text(addr, trimmed)
        }
      }
      refresh()
    },

    /** Access the underlying sheet */
    raw: sheet,
  }
}

export type SheetStore = ReturnType<typeof createSheetStore>
