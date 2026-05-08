import { createSignal } from 'solid-js'
import type { ISheet, CellValue } from './types'

/**
 * Reactive wrapper around ISheet.
 *
 * Each accessed cell gets a SolidJS signal whose value re-reads from the
 * sheet. The signal is mutated (via a no-op tick counter) when the sheet
 * notifies us of a change for that specific address. Cell display data
 * is NOT stored in the signal — it's read fresh from the sheet each time
 * — so we never have a stale duplicate (D.4 fix).
 *
 * Subscriptions to the sheet are precise: we subscribe to exactly the
 * cells with active signals, and the sheet fires per-cell on dependency
 * changes. No more refreshAll across the whole table on every set (D.3).
 */
export function createSheetStore(sheet: ISheet) {
  /**
   * Per-cell tick signal. Reading it tracks the cell; writing a new tick
   * forces every reader to re-read sheet.get_display etc.
   * `token` is the sheet subscription handle so we can clean up on
   * unmount (not yet wired but recorded for D.5 follow-up).
   */
  type CellHandle = {
    tick: () => number
    bump: (n: number) => number
    token: number
  }
  const handles = new Map<string, CellHandle>()

  function getHandle(addr: string): CellHandle {
    let h = handles.get(addr)
    if (h) return h
    const [tick, bump] = createSignal(0)
    const token = sheet.subscribe(addr, () => bump((t) => t + 1))
    h = { tick, bump, token }
    handles.set(addr, h)
    return h
  }

  function readCell(addr: string): CellValue {
    return {
      display: sheet.get_display(addr),
      type: sheet.get_type(addr) as CellValue['type'],
      isError: sheet.is_error(addr),
    }
  }

  return {
    /** Get a reactive cell value. Triggers re-read whenever the cell changes. */
    getCell(addr: string): CellValue {
      // Tracking dependency: reading tick subscribes the caller to bumps.
      // Value itself is read fresh from the sheet — no stored duplicate.
      getHandle(addr).tick()
      return readCell(addr)
    },

    /** Original formula text for a cell (empty for non-formula cells). */
    getFormula(addr: string): string {
      return sheet.get_formula(addr)
    },

    setNumber(addr: string, value: number) {
      sheet.set_number(addr, value)
    },

    setText(addr: string, value: string) {
      sheet.set_text(addr, value)
    },

    setFormula(addr: string, formula: string): boolean {
      return sheet.set_formula(addr, formula)
    },

    /** Set a cell from raw input. Detects formulas (=...), numbers, text. */
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
    },

    /**
     * Tear down all sheet subscriptions. Call from a cleanup hook when the
     * store's lifetime ends. D.5 — without this, long-lived sessions
     * accumulate handles even when no signals are still tracked.
     */
    dispose() {
      for (const h of handles.values()) sheet.unsubscribe(h.token)
      handles.clear()
    },

    /**
     * @deprecated Use the named methods instead. Direct calls to `raw.*`
     * bypass the reactive layer and won't trigger SolidJS updates.
     * Retained for now to keep existing tests passing; remove with D.6.
     */
    raw: sheet,
  }
}

export type SheetStore = ReturnType<typeof createSheetStore>
