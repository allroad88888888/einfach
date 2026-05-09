import { createSignal } from 'solid-js'
import { addrToCoord, colToLetter, coordToAddr, type CellCoord } from './selection'
import { shiftFormulaRefs } from './formula-shift'
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

/**
 * What a cell holds before / after an undoable operation.
 *
 * Encoded as a tagged union so restore can dispatch on the actual cell
 * kind without round-tripping through the display string. The display
 * round-trip used to lose precision on numbers ("0.1+0.2" cases) and
 * coerce error/boolean values into text on undo.
 */
type CellSnapshot =
  | { addr: string; kind: 'formula'; formula: string }
  | { addr: string; kind: 'null' }
  | { addr: string; kind: 'number'; value: number }
  | { addr: string; kind: 'boolean'; value: boolean }
  | { addr: string; kind: 'error'; value: string }
  | { addr: string; kind: 'text'; value: string }

/** A clipboard "cells" payload. Top-left of the source range is at (0,0). */
export interface ClipboardData {
  /** Row-major grid. Each entry is the raw input string (formula or value). */
  cells: string[][]
  /**
   * Top-left address of the source range (e.g. "B2"). Required to compute
   * the (drow, dcol) shift applied to relative refs in pasted formulas
   * — without this, `=A1+B1` copied from B2 stays `=A1+B1` when pasted
   * to D5 instead of becoming `=C4+D4`.
   */
  originAddr: string
}

export function createSheetStore(sheet: ISheet) {
  // === Selection ===
  // Owned by the store so FormulaBar / Table / future right-click menus
  // / keyboard handlers can all read & write a single source of truth.
  const [selection, setSelectionRaw] = createSignal<CellCoord>({ row: 0, col: 0 })

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
    const formula = sheet.get_formula(addr)
    if (formula !== '') return { addr, kind: 'formula', formula }
    const type = sheet.get_type(addr)
    if (type === 'null') return { addr, kind: 'null' }
    if (type === 'number') return { addr, kind: 'number', value: sheet.get_number(addr) }
    if (type === 'boolean') return { addr, kind: 'boolean', value: sheet.get_display(addr) === 'TRUE' }
    if (type === 'error') return { addr, kind: 'error', value: sheet.get_display(addr) }
    return { addr, kind: 'text', value: sheet.get_display(addr) }
  }

  /** Restore a cell to a snapshot's state. */
  function restore(snap: CellSnapshot) {
    switch (snap.kind) {
      case 'formula':
        sheet.set_formula(snap.addr, snap.formula)
        return
      case 'null':
        sheet.clear_cell(snap.addr)
        return
      case 'number':
        sheet.set_number(snap.addr, snap.value)
        return
      case 'boolean':
        if (sheet.set_boolean) sheet.set_boolean(snap.addr, snap.value)
        else sheet.set_text(snap.addr, snap.value ? 'TRUE' : 'FALSE')
        return
      case 'error':
        if (sheet.set_error) sheet.set_error(snap.addr, snap.value)
        else sheet.set_text(snap.addr, snap.value)
        return
      case 'text':
        sheet.set_text(snap.addr, snap.value)
        return
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
    /** Currently selected cell. Reactive — driven by Table & FormulaBar. */
    selection,

    /** Selection setter. Use `setSelection({ row, col })` from any component. */
    setSelection: setSelectionRaw,

    /** Convenience accessor — selection's address form. */
    selectionAddr: () => coordToAddr(selection()),

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

    /**
     * Insert `count` empty rows at index `at`. Existing data shifts down;
     * formula references retarget. Currently NOT undoable — structural
     * edits don't capture per-cell snapshots (would explode for large
     * sheets); see TODO A.6 for the full sheet-snapshot approach.
     */
    insertRow(at: number, count = 1) {
      sheet.insert_row?.(at, count)
    },
    deleteRow(at: number, count = 1) {
      sheet.delete_row?.(at, count)
    },
    insertCol(at: number, count = 1) {
      sheet.insert_col?.(at, count)
    },
    deleteCol(at: number, count = 1) {
      sheet.delete_col?.(at, count)
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
     * `addrs[0][0]` is treated as the source origin so paste can compute
     * the (drow, dcol) shift for relative refs.
     */
    copy(addrs: string[][]): ClipboardData {
      const originAddr = addrs[0]?.[0] ?? 'A1'
      return {
        originAddr,
        cells: addrs.map((row) =>
          row.map((addr) => {
            const f = sheet.get_formula(addr)
            return f !== '' ? f : sheet.get_display(addr)
          })
        ),
      }
    },

    /**
     * Paste a clipboard payload starting at `pasteAddr` (top-left of the
     * destination). Formulas in the payload have their cell references
     * shifted by (paste - copy origin), matching Excel's relative-ref
     * paste semantics.
     */
    paste(pasteAddr: string, data: ClipboardData) {
      const start = addrToCoord(pasteAddr)
      if (!start) return
      const origin = addrToCoord(data.originAddr) ?? { row: 0, col: 0 }
      const drow = start.row - origin.row
      const dcol = start.col - origin.col
      this.beginEdit()
      data.cells.forEach((row, dr) => {
        row.forEach((field, dc) => {
          const addr = colToLetter(start.col + dc) + (start.row + dr + 1)
          // Only shift if the field is a formula. Plain values pass through.
          const out = field.startsWith('=')
            ? shiftFormulaRefs(field, drow, dcol)
            : field
          this.setCellInput(addr, out)
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

export type SheetStore = ReturnType<typeof createSheetStore>
