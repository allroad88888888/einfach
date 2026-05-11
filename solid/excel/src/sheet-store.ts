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

/** Marker prepended to the system-clipboard TSV so we can recover the
 * source origin when the user re-pastes inside the same app. Format:
 *
 *   `# einfach-clipboard-origin: A1\n<TSV body>`
 *
 * When the marker is absent (e.g. the user pasted from a real spreadsheet
 * or a plain text editor), the parser falls back to `originAddr === paste
 * target`, i.e. no relative-ref shift, which matches "literal paste"
 * semantics for foreign clipboard data.
 */
const CLIPBOARD_ORIGIN_MARKER_PREFIX = '# einfach-clipboard-origin: '

/**
 * Serialize a `ClipboardData` to the TSV-with-origin-marker string we
 * write to the system clipboard. Cells are joined by `\t` per row and rows
 * by `\n`. The first line is the origin marker so a subsequent paste from
 * the same app can recover the source top-left and shift relative refs.
 */
export function serializeClipboardTSV(data: ClipboardData): string {
  const body = data.cells.map((row) => row.join('\t')).join('\n')
  return `${CLIPBOARD_ORIGIN_MARKER_PREFIX}${data.originAddr}\n${body}`
}

/**
 * Parse a TSV-with-optional-origin-marker string back into a
 * `ClipboardData`. If the marker line is missing, `fallbackOrigin` is
 * used as the origin (typical: the paste target itself, so no shift).
 */
export function parseClipboardTSV(text: string, fallbackOrigin: string): ClipboardData {
  // Normalize line endings — Windows clipboards love \r\n, and `\r`
  // showing up at row boundaries silently turns numbers into text.
  const normalized = text.replace(/\r\n?/g, '\n')
  let origin = fallbackOrigin
  let body = normalized
  if (normalized.startsWith(CLIPBOARD_ORIGIN_MARKER_PREFIX)) {
    const newlineIdx = normalized.indexOf('\n')
    const markerLine =
      newlineIdx === -1 ? normalized : normalized.slice(0, newlineIdx)
    origin = markerLine.slice(CLIPBOARD_ORIGIN_MARKER_PREFIX.length).trim() || fallbackOrigin
    body = newlineIdx === -1 ? '' : normalized.slice(newlineIdx + 1)
  }
  // Drop a single trailing newline if present — most editors / spreadsheets
  // append one, and we don't want a phantom empty row pasted at the bottom.
  if (body.endsWith('\n')) body = body.slice(0, -1)
  const cells = body === '' ? [['']] : body.split('\n').map((row) => row.split('\t'))
  return { cells, originAddr: origin }
}

export function createSheetStore(sheet: ISheet) {
  // === Selection ===
  // Owned by the store so FormulaBar / Table / future right-click menus
  // / keyboard handlers can all read & write a single source of truth.
  //
  // Two layers:
  //   - `selection()` is the focus cell — what FormulaBar shows, what
  //     arrow-keys move. Always a single coord.
  //   - `selectionRange()` is the rectangle anchored at `anchor` and
  //     extending to `focus`. When the user clicks a cell we collapse
  //     the range to that cell (anchor === focus); Shift+arrow keeps
  //     anchor, moves focus, growing/shrinking the rectangle.
  const [selection, setSelectionInner] = createSignal<CellCoord>({ row: 0, col: 0 })
  const [anchor, setAnchor] = createSignal<CellCoord>({ row: 0, col: 0 })

  /** Collapse the range to a single cell (existing public semantics). */
  const setSelectionRaw = (next: CellCoord) => {
    setSelectionInner(next)
    setAnchor(next)
    return next
  }

  type CellHandle = {
    tick: () => number
    bump: (n: number) => number
    token: number
  }
  const handles = new Map<string, CellHandle>()

  /**
   * Per-address subscriber fire counter. Exposed via `subscriberFireCount`
   * for tests asserting precise subscription contract (e.g. "subscribe to
   * empty cell, then set_formula on it, fires exactly once"). The
   * counter is bumped inside the same callback that fires the per-cell
   * tick signal, so it reflects the address-level subscription
   * fan-out exactly. Lives at the SheetStore layer because that's where
   * each address materializes its single sheet.subscribe(addr, …) call.
   *
   * Cheap (one integer per touched address); always on.
   */
  const fireCounts = new Map<string, number>()

  function getHandle(addr: string): CellHandle {
    let h = handles.get(addr)
    if (h) return h
    const [tick, bump] = createSignal(0)
    const token = sheet.subscribe(addr, () => {
      fireCounts.set(addr, (fireCounts.get(addr) ?? 0) + 1)
      bump((t) => t + 1)
    })
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
  // cell mutations OR the parameters of a structural edit. Undo restores
  // the `before` state; redo replays `after`. See
  // `docs/STRUCTURAL_UNDO.md` for the structural-entry contract and the
  // op-inverse fallback used when the sheet is too dense to snapshot.
  type CellsUndoEntry = {
    kind: 'cells'
    before: CellSnapshot[]
    after: CellSnapshot[]
  }
  type StructuralOp = 'insertRow' | 'deleteRow' | 'insertCol' | 'deleteCol'
  type StructuralUndoEntry = {
    kind: 'structural'
    op: StructuralOp
    at: number
    count: number
    /** Null when the sheet was too dense to snapshot — falls back to op
     * inverse (which loses content for delete-row/-col but at least keeps
     * the grid shape). */
    snapshot: { before: CellSnapshot[]; after: CellSnapshot[] } | null
  }
  type UndoEntry = CellsUndoEntry | StructuralUndoEntry

  /** Above this non-empty count, structural snapshots are skipped and we
   * fall back to op inverse. See `docs/STRUCTURAL_UNDO.md#threshold`. */
  const STRUCTURAL_SNAPSHOT_MAX = 2000

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
    undoStack.push({ kind: 'cells', before, after })
    redoStack.length = 0
  }

  /** Snapshot every non-empty cell, or `null` when over the threshold. */
  function snapshotAllNonEmpty(): CellSnapshot[] | null {
    const list = sheet.non_empty_addrs?.()
    if (!list) {
      // Backend doesn't expose the iterator — fall back to op inverse.
      return null
    }
    if (list.length > STRUCTURAL_SNAPSHOT_MAX) return null
    return list.map(snapshot)
  }

  /** Run a structural edit and push its undo entry. Flushes any pending
   * value-edit batch first so the two entry kinds never interleave (see
   * `docs/STRUCTURAL_UNDO.md#coalescing-with-value-edits`). */
  function structuralEdit(
    op: StructuralOp,
    at: number,
    count: number,
    apply: () => void,
  ) {
    // Flush an open beginEdit so the structural entry is its own frame.
    if (pendingBefore !== null) {
      const before = pendingBefore
      const after = before.map((s) => snapshot(s.addr))
      pendingBefore = null
      pendingAddrs = null
      if (before.length > 0) {
        undoStack.push({ kind: 'cells', before, after })
        redoStack.length = 0
      }
    }

    const before = snapshotAllNonEmpty()
    apply()
    const after = before === null ? null : snapshotAllNonEmpty()
    // If the post-edit snapshot crossed the threshold we degrade this
    // entry to op-inverse only — keeping a partial snapshot would be a
    // lie about what undo can restore.
    const snap =
      before !== null && after !== null ? { before, after } : null
    if (snap === null && before !== null) {
      // We had a before snapshot but went over budget after. Warn so the
      // dev knows undo is degraded.
      // eslint-disable-next-line no-console
      console.warn(
        `[einfach] structural ${op} crossed snapshot threshold ${STRUCTURAL_SNAPSHOT_MAX}; undo will use op-inverse only`,
      )
    }
    undoStack.push({ kind: 'structural', op, at, count, snapshot: snap })
    redoStack.length = 0
  }

  /** Inverse op used when a structural entry has no snapshot. */
  function applyStructural(op: StructuralOp, at: number, count: number) {
    if (op === 'insertRow') sheet.insert_row?.(at, count)
    else if (op === 'deleteRow') sheet.delete_row?.(at, count)
    else if (op === 'insertCol') sheet.insert_col?.(at, count)
    else if (op === 'deleteCol') sheet.delete_col?.(at, count)
  }

  function inverseOp(op: StructuralOp): StructuralOp {
    if (op === 'insertRow') return 'deleteRow'
    if (op === 'deleteRow') return 'insertRow'
    if (op === 'insertCol') return 'deleteCol'
    return 'insertCol'
  }

  /** Restore a list of snapshots verbatim. Used by structural undo /
   * redo. We don't reset cleared cells back to null first because every
   * non-empty address is in `snaps`, and addresses outside it are
   * expected to already be empty (the structural inverse already shifted
   * them out of the affected band). */
  function restoreAll(snaps: CellSnapshot[]) {
    for (const s of snaps) restore(s)
  }

  return {
    /** Currently focused cell. Reactive — driven by Table & FormulaBar.
     * For ranges this is the "focus" end (the cell arrow-keys move). */
    selection,

    /**
     * Selection setter. Collapses any active range to this single cell
     * (anchor === focus). Use `setSelection({ row, col })` from any
     * component to mimic a click.
     */
    setSelection: setSelectionRaw,

    /** Convenience accessor — focus cell's address form. */
    selectionAddr: () => coordToAddr(selection()),

    /**
     * Debug-only: how many times has this address's subscriber callback
     * fired since `getHandle(addr)` was first created (i.e. since the
     * first reactive read of this cell)? 0 for addresses that were never
     * touched. Used by `regression.spec.ts` to pin the
     * "subscribe-then-set_formula fires exactly once" contract — without
     * this, the spec couldn't observe fire counts from the browser side.
     *
     * Counter bumps before `bump((t) => t + 1)`, so the count == number
     * of distinct sheet notifications, not Solid render passes.
     */
    subscriberFireCount: (addr: string) => fireCounts.get(addr) ?? 0,

    /**
     * The current rectangular selection: `anchor` is where the range
     * started (last click / setSelectionAnchor), `focus` is where it
     * currently ends (last arrow-move / extendSelection). For a single-
     * cell selection the two are equal.
     */
    selectionRange: (): { anchor: CellCoord; focus: CellCoord } => ({
      anchor: anchor(),
      focus: selection(),
    }),

    /**
     * Set both anchor and focus to `coord` — equivalent to a click on
     * that cell (collapses any existing range). Same effect as
     * `setSelection`; named for clarity at call sites that "start" a
     * new range vs. just navigating.
     */
    setSelectionAnchor: (coord: CellCoord) => {
      setSelectionInner(coord)
      setAnchor(coord)
    },

    /**
     * Move the focus end of the range to `coord` while keeping the
     * existing anchor. Use this for Shift+Arrow / Shift+Click.
     */
    extendSelection: (coord: CellCoord) => {
      setSelectionInner(coord)
    },

    /**
     * Row-major grid of addresses covered by the current selection
     * rectangle. For a single-cell selection returns `[['A1']]`. The
     * rectangle is normalized so reverse selections (focus above/left
     * of anchor) still produce top-left-first addresses.
     */
    selectionAddrs: (): string[][] => {
      const a = anchor()
      const f = selection()
      const r0 = Math.min(a.row, f.row)
      const r1 = Math.max(a.row, f.row)
      const c0 = Math.min(a.col, f.col)
      const c1 = Math.max(a.col, f.col)
      const out: string[][] = []
      for (let r = r0; r <= r1; r++) {
        const row: string[] = []
        for (let c = c0; c <= c1; c++) row.push(coordToAddr({ row: r, col: c }))
        out.push(row)
      }
      return out
    },

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
     * formula references retarget. Undoable — see
     * `docs/STRUCTURAL_UNDO.md` for the snapshot + threshold strategy.
     */
    insertRow(at: number, count = 1) {
      structuralEdit('insertRow', at, count, () =>
        sheet.insert_row?.(at, count),
      )
    },
    deleteRow(at: number, count = 1) {
      structuralEdit('deleteRow', at, count, () =>
        sheet.delete_row?.(at, count),
      )
    },
    insertCol(at: number, count = 1) {
      structuralEdit('insertCol', at, count, () =>
        sheet.insert_col?.(at, count),
      )
    },
    deleteCol(at: number, count = 1) {
      structuralEdit('deleteCol', at, count, () =>
        sheet.delete_col?.(at, count),
      )
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
      undoStack.push({ kind: 'cells', before, after })
      redoStack.length = 0
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    undo() {
      const entry = undoStack.pop()
      if (!entry) return
      if (entry.kind === 'cells') {
        restoreAll(entry.before)
      } else {
        // Structural inverse first (puts the grid back in shape), then
        // restore any deleted content from the snapshot. Order matters:
        // restoring rows that don't exist yet would either silently shift
        // out or land on the wrong addresses.
        applyStructural(inverseOp(entry.op), entry.at, entry.count)
        if (entry.snapshot !== null) restoreAll(entry.snapshot.before)
      }
      redoStack.push(entry)
    },

    redo() {
      const entry = redoStack.pop()
      if (!entry) return
      if (entry.kind === 'cells') {
        restoreAll(entry.after)
      } else {
        applyStructural(entry.op, entry.at, entry.count)
        if (entry.snapshot !== null) restoreAll(entry.snapshot.after)
      }
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
