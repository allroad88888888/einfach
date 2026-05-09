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

/** What a cell holds before / after an undoable operation. */
interface CellSnapshot {
  addr: string
  /** Original formula source if any; empty string when the cell holds a value. */
  formula: string
  /** Display value (used as the input for setCellInput on restore). */
  display: string
  type: CellValue['type']
}

/** A clipboard "cells" payload. Top-left of the source range is at (0,0). */
export interface ClipboardData {
  /** Row-major grid. Each entry is the raw input string (formula or value). */
  cells: string[][]
}

export function createSheetStore(sheet: ISheet) {
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

  // === Undo / redo ===
  // Each entry records before+after snapshots for a contiguous batch of
  // cell mutations. Undo restores the `before` set; redo replays `after`.
  // `before` snapshot is captured before any mutation in the entry runs;
  // `after` is captured at commit time (endEdit / single-mutation).
  type UndoEntry = { before: CellSnapshot[]; after: CellSnapshot[] }
  const undoStack: UndoEntry[] = []
  const redoStack: UndoEntry[] = []

  /** When non-null we're inside a beginEdit/endEdit block — accumulate. */
  let pendingBefore: CellSnapshot[] | null = null
  let pendingAddrs: Set<string> | null = null

  function snapshot(addr: string): CellSnapshot {
    const cv = readCell(addr)
    return {
      addr,
      formula: sheet.get_formula(addr),
      display: cv.display,
      type: cv.type,
    }
  }

  /** Restore a cell to a snapshot's state. */
  function restore(snap: CellSnapshot) {
    if (snap.formula !== '') {
      sheet.set_formula(snap.addr, snap.formula)
    } else if (snap.type === 'null' && snap.display === '') {
      sheet.clear_cell(snap.addr)
    } else if (snap.type === 'number') {
      const n = Number(snap.display)
      if (!isNaN(n)) {
        sheet.set_number(snap.addr, n)
      } else {
        sheet.set_text(snap.addr, snap.display)
      }
    } else {
      sheet.set_text(snap.addr, snap.display)
    }
  }

  /** Take before-snapshots for a single addr and forward to mutation. */
  function recordSingle(addr: string, mutate: () => void) {
    const before = [snapshot(addr)]
    mutate()
    if (pendingBefore !== null) {
      // Inside beginEdit — collect addresses; defer push until endEdit.
      if (!pendingAddrs!.has(addr)) {
        pendingBefore.push(before[0])
        pendingAddrs!.add(addr)
      }
      return
    }
    const after = [snapshot(addr)]
    undoStack.push({ before, after })
    redoStack.length = 0
  }

  return {
    getCell(addr: string): CellValue {
      getHandle(addr).tick()
      return readCell(addr)
    },

    getFormula(addr: string): string {
      return sheet.get_formula(addr)
    },

    setNumber(addr: string, value: number) {
      recordSingle(addr, () => sheet.set_number(addr, value))
    },

    setText(addr: string, value: string) {
      recordSingle(addr, () => sheet.set_text(addr, value))
    },

    setFormula(addr: string, formula: string): boolean {
      let ok = true
      recordSingle(addr, () => {
        ok = sheet.set_formula(addr, formula)
      })
      return ok
    },

    /** Clear a cell back to empty. Undoable. */
    clearCell(addr: string) {
      recordSingle(addr, () => sheet.clear_cell(addr))
    },

    setCellInput(addr: string, input: string) {
      const trimmed = input.trim()
      recordSingle(addr, () => {
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
      })
    },

    /**
     * Group multiple mutations into one undo entry. Call beginEdit before
     * the batch and endEdit after. Nested begins are flattened into the
     * outermost entry (no separate stack frame).
     */
    beginEdit() {
      if (pendingBefore !== null) return
      pendingBefore = []
      pendingAddrs = new Set()
    },

    endEdit() {
      if (pendingBefore === null) return
      const before = pendingBefore
      pendingBefore = null
      pendingAddrs = null
      if (before.length === 0) return
      const after = before.map((s) => snapshot(s.addr))
      undoStack.push({ before, after })
      redoStack.length = 0
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    undo() {
      const entry = undoStack.pop()
      if (!entry) return
      for (const s of entry.before) restore(s)
      redoStack.push(entry)
    },

    redo() {
      const entry = redoStack.pop()
      if (!entry) return
      for (const s of entry.after) restore(s)
      undoStack.push(entry)
    },

    // === Clipboard ===
    /**
     * Build a clipboard payload from a rectangular range of cell addresses.
     * Each cell's source (formula or display) is captured as a string so
     * paste can re-create the same cell type.
     *
     * Caller passes the addresses; computing the rectangle from a
     * Selection is left to the UI layer.
     */
    copy(addrs: string[][]): ClipboardData {
      return {
        cells: addrs.map((row) =>
          row.map((addr) => {
            const f = sheet.get_formula(addr)
            return f !== '' ? f : sheet.get_display(addr)
          })
        ),
      }
    },

    /** Paste a clipboard payload starting at `originAddr` (top-left). */
    paste(originAddr: string, data: ClipboardData) {
      const m = originAddr.match(/^([A-Za-z]+)(\d+)$/)
      if (!m) return
      const startCol = lettersToCol(m[1])
      const startRow = parseInt(m[2], 10) - 1
      this.beginEdit()
      data.cells.forEach((row, dr) => {
        row.forEach((field, dc) => {
          const addr = colToLetters(startCol + dc) + (startRow + dr + 1)
          this.setCellInput(addr, field)
        })
      })
      this.endEdit()
    },

    dispose() {
      for (const h of handles.values()) sheet.unsubscribe(h.token)
      handles.clear()
    },

    /**
     * @deprecated Use the named methods. Direct `raw.*` calls bypass the
     * reactive layer AND the undo bookkeeping.
     */
    raw: sheet,
  }
}

function colToLetters(col: number): string {
  let result = ''
  let c = col
  do {
    result = String.fromCharCode(65 + (c % 26)) + result
    c = Math.floor(c / 26) - 1
  } while (c >= 0)
  return result
}

function lettersToCol(letters: string): number {
  let col = 0
  for (const ch of letters.toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64)
  }
  return col - 1
}

export type SheetStore = ReturnType<typeof createSheetStore>
