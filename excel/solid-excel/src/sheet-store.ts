import { createSignal } from 'solid-js'
import { addrToCoord, colToLetter, coordToAddr, type CellCoord } from './selection'
import { shiftFormulaRefs } from './formula-shift'
import type {
  CellFormatJSON,
  FormatRangeSnapshot,
  ISheet,
  CellValue,
  SparseCellSnapshot,
  FormulaMutationResult,
  FormulaMutationErrorCode,
} from './types'
import { formatsEqual } from './types'

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
  /**
   * Phase 6 — format-only snapshot. Records the base format before/after a
   * style mutation without touching the cell value. Restored via
   * `sheet.set_format`. Standalone kind (rather than an optional field on
   * every value snapshot) so undo of a value edit doesn't accidentally
   * clobber the cell's format, and vice versa.
   */
  | { addr: string; kind: 'format'; format: CellFormatJSON }

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
const RANGE_CLEAR_UNDO_CELL_LIMIT = 10_000
const CLIPBOARD_CELL_LIMIT = 10_000
const FORMAT_CELL_LIMIT = 10_000

type NormalizedCellRange = {
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

function normalizeCellRange(anchor: CellCoord, focus: CellCoord): NormalizedCellRange {
  return {
    startRow: Math.min(anchor.row, focus.row),
    startCol: Math.min(anchor.col, focus.col),
    endRow: Math.max(anchor.row, focus.row),
    endCol: Math.max(anchor.col, focus.col),
  }
}

function rangeCellCount(range: NormalizedCellRange): number {
  return (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1)
}

function addressGridCellCount(addrs: string[][]): number {
  return addrs.reduce((count, row) => count + row.length, 0)
}

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
    const markerLine = newlineIdx === -1 ? normalized : normalized.slice(0, newlineIdx)
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
    /**
     * Number of outstanding `observeCell(addr)` subscriptions. Bumped on
     * acquire, decremented on dispose. The underlying `sheet.subscribe`
     * is allocated on 0→1 and torn down on 1→0, so the proxy talks to
     * the backend at most once per actively-observed address regardless
     * of how many Cell/FormulaBar consumers are reading.
     */
    refCount: number
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

  /**
   * Acquire a subscription handle for `addr` (refcount++). Allocates the
   * underlying `sheet.subscribe` exactly once per address — subsequent
   * acquires share the same tick signal. Callers must pair each acquire
   * with a `releaseHandle(addr)` once they no longer need reactive
   * updates, otherwise the backend keeps firing for ghost observers.
   *
   * Used by `observeCell`; not exported on its own — the {value, dispose}
   * pair is the user-facing contract.
   */
  function acquireHandle(addr: string): CellHandle {
    let h = handles.get(addr)
    if (h) {
      h.refCount += 1
      return h
    }
    const [tick, bump] = createSignal(0)
    const token = sheet.subscribe(addr, () => {
      fireCounts.set(addr, (fireCounts.get(addr) ?? 0) + 1)
      bump((t) => t + 1)
    })
    h = { tick, bump, token, refCount: 1 }
    handles.set(addr, h)
    return h
  }

  /**
   * Release one subscription handle for `addr`. The underlying
   * `sheet.unsubscribe` only fires when the last observer drops; until
   * then other observers (e.g. a still-mounted FormulaBar) keep getting
   * tick fires.
   *
   * Idempotent against over-release: a release on an addr with no live
   * handle is a no-op (defensive against double-dispose, which can
   * happen when a parent unmount and an explicit `onCleanup(dispose)`
   * race on tab teardown).
   */
  function releaseHandle(addr: string): void {
    const h = handles.get(addr)
    if (!h) return
    h.refCount -= 1
    if (h.refCount > 0) return
    sheet.unsubscribe(h.token)
    handles.delete(addr)
  }

  function readCell(addr: string): CellValue {
    // Prefer the format-aware display path when the backend exposes it
    // (Phase 6). Falls back to `get_display` for backends without format
    // support (older JS mocks in test fixtures, etc).
    const display = sheet.formatted_display
      ? sheet.formatted_display(addr)
      : sheet.get_display(addr)
    return {
      display,
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
  type SparseRangeClearUndoEntry = {
    kind: 'sparseRangeClear'
    range: NormalizedCellRange
    before: SparseCellSnapshot[]
  }
  type RangeFormatUndoEntry = {
    kind: 'rangeFormat'
    before: FormatRangeSnapshot
    after: FormatRangeSnapshot
  }
  type UndoEntry =
    | CellsUndoEntry
    | StructuralUndoEntry
    | SparseRangeClearUndoEntry
    | RangeFormatUndoEntry

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
    if (type === 'boolean')
      return { addr, kind: 'boolean', value: sheet.get_display(addr) === 'TRUE' }
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
      case 'format':
        if (sheet.set_format) sheet.set_format(snap.addr, snap.format)
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

  /**
   * Phase 6 — record a format-only mutation as a `format` snapshot kind.
   * Cell value isn't touched, so we don't snapshot it. Inside beginEdit
   * we still dedup per-address; the snapshot we keep is always the
   * earliest pre-state of that address within the batch.
   */
  function recordFormat(addr: string, mutate: () => void) {
    const beforeFmt: CellFormatJSON = sheet.get_format ? sheet.get_format(addr) : {}
    const before: CellSnapshot = { addr, kind: 'format', format: beforeFmt }
    mutate()
    if (pendingBefore !== null) {
      // Distinguish format snapshots from value snapshots so a mixed batch
      // (value edit + format edit on the same address) still restores both
      // halves. Key on `${addr}::format` to dedup within a batch.
      const key = `${addr}::format`
      if (!pendingAddrs!.has(key)) {
        pendingBefore.push(before)
        pendingAddrs!.add(key)
      }
      return
    }
    const afterFmt: CellFormatJSON = sheet.get_format ? sheet.get_format(addr) : {}
    const after: CellSnapshot = { addr, kind: 'format', format: afterFmt }
    undoStack.push({ kind: 'cells', before: [before], after: [after] })
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

  function commitPendingEdit() {
    if (pendingBefore === null) return
    const before = pendingBefore
    pendingBefore = null
    pendingAddrs = null
    if (before.length === 0) return
    // Format snapshots and value snapshots are restored differently — the
    // "after" needs to match the kind of each "before" entry so undo of a
    // mixed batch (value edit + format edit on the same cell) still
    // restores both halves independently.
    const after = before.map((s) =>
      s.kind === 'format'
        ? ({
            addr: s.addr,
            kind: 'format' as const,
            format: sheet.get_format ? sheet.get_format(s.addr) : {},
          } satisfies CellSnapshot)
        : snapshot(s.addr),
    )
    undoStack.push({ kind: 'cells', before, after })
    redoStack.length = 0
  }

  /** Run a structural edit and push its undo entry. Flushes any pending
   * value-edit batch first so the two entry kinds never interleave (see
   * `docs/STRUCTURAL_UNDO.md#coalescing-with-value-edits`). */
  function structuralEdit(op: StructuralOp, at: number, count: number, apply: () => void) {
    // Flush an open beginEdit so the structural entry is its own frame.
    commitPendingEdit()

    const before = snapshotAllNonEmpty()
    apply()
    const after = before === null ? null : snapshotAllNonEmpty()
    // If the post-edit snapshot crossed the threshold we degrade this
    // entry to op-inverse only — keeping a partial snapshot would be a
    // lie about what undo can restore.
    const snap = before !== null && after !== null ? { before, after } : null
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

  function restoreSparseSnapshot(snap: SparseCellSnapshot) {
    switch (snap.kind) {
      case 'formula':
        sheet.set_formula(snap.addr, snap.value)
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

  function restoreSparseSnapshots(cells: SparseCellSnapshot[]): Promise<void> | void {
    if (sheet.restore_sparse) {
      return Promise.resolve(sheet.restore_sparse(cells)).then(() => {})
    }
    for (const cell of cells) restoreSparseSnapshot(cell)
  }

  function replaySparseRangeClear(range: NormalizedCellRange): Promise<void> | void {
    if (sheet.clear_range) {
      return Promise.resolve(
        sheet.clear_range(range.startRow, range.startCol, range.endRow, range.endCol),
      ).then(() => {})
    }
  }

  function restoreFormatSnapshot(formatSnapshot: FormatRangeSnapshot): Promise<void> | void {
    if (!sheet.restore_format_snapshot) return
    return Promise.resolve(sheet.restore_format_snapshot(formatSnapshot)).then(() => {})
  }

  function currentSelectionRange(): NormalizedCellRange {
    return normalizeCellRange(anchor(), selection())
  }

  function addressGridForRange(range: NormalizedCellRange, limit = Infinity): string[][] | null {
    if (rangeCellCount(range) > limit) return null
    const out: string[][] = []
    for (let r = range.startRow; r <= range.endRow; r++) {
      const row: string[] = []
      for (let c = range.startCol; c <= range.endCol; c++) {
        row.push(coordToAddr({ row: r, col: c }))
      }
      out.push(row)
    }
    return out
  }

  function selectionAddressGrid(limit = CLIPBOARD_CELL_LIMIT): string[][] | null {
    return addressGridForRange(currentSelectionRange(), limit)
  }

  function copyAddressGrid(addrs: string[][]): ClipboardData | null {
    if (addressGridCellCount(addrs) > CLIPBOARD_CELL_LIMIT) return null
    const originAddr = addrs[0]?.[0] ?? 'A1'
    return {
      originAddr,
      cells: addrs.map((row) =>
        row.map((addr) => {
          const f = sheet.get_formula(addr)
          return f !== '' ? f : sheet.get_display(addr)
        }),
      ),
    }
  }

  async function copySelectionText(): Promise<string | null> {
    const selectedRange = currentSelectionRange()
    if (rangeCellCount(selectedRange) <= CLIPBOARD_CELL_LIMIT) {
      const addrs = addressGridForRange(selectedRange, CLIPBOARD_CELL_LIMIT)
      const data = addrs ? copyAddressGrid(addrs) : null
      return data ? serializeClipboardTSV(data) : null
    }
    if (!sheet.export_range_tsv_chunks && !sheet.export_range_tsv) return null

    const body = sheet.export_range_tsv_chunks
      ? (
          await Promise.resolve(
            sheet.export_range_tsv_chunks(
              selectedRange.startRow,
              selectedRange.startCol,
              selectedRange.endRow,
              selectedRange.endCol,
            ),
          )
        ).join('\n')
      : await Promise.resolve(
          sheet.export_range_tsv!(
            selectedRange.startRow,
            selectedRange.startCol,
            selectedRange.endRow,
            selectedRange.endCol,
          ),
        )
    const originAddr = coordToAddr({ row: selectedRange.startRow, col: selectedRange.startCol })
    return `${CLIPBOARD_ORIGIN_MARKER_PREFIX}${originAddr}\n${body}`
  }

  function setFormatInternal(addr: string, fmt: CellFormatJSON) {
    if (!sheet.set_format) return
    const current = sheet.get_format ? sheet.get_format(addr) : ({} as CellFormatJSON)
    if (formatsEqual(current, fmt)) return
    recordFormat(addr, () => sheet.set_format!(addr, fmt))
  }

  function setLargeRangeFormat(
    range: NormalizedCellRange,
    fmt: CellFormatJSON,
  ): Promise<void> | void {
    const result = sheet.set_format_range!(
      range.startRow,
      range.startCol,
      range.endRow,
      range.endCol,
      fmt,
    )
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return Promise.resolve(result).then(() => {})
    }
  }

  async function formatLargeCellRange(
    range: NormalizedCellRange,
    fmt: CellFormatJSON,
  ): Promise<boolean> {
    if (!sheet.set_format_range) return false

    commitPendingEdit()
    if (sheet.snapshot_format_range && sheet.restore_format_snapshot) {
      const before = await Promise.resolve(
        sheet.snapshot_format_range(range.startRow, range.startCol, range.endRow, range.endCol),
      )
      await Promise.resolve(setLargeRangeFormat(range, fmt))
      const after = await Promise.resolve(
        sheet.snapshot_format_range(range.startRow, range.startCol, range.endRow, range.endCol),
      )
      undoStack.push({ kind: 'rangeFormat', before, after })
      redoStack.length = 0
      return true
    }

    await Promise.resolve(setLargeRangeFormat(range, fmt))
    // Backends without format metadata snapshots still cannot safely undo a
    // range format layer. Drop prior entries so Ctrl+Z cannot replay stale
    // assumptions across it.
    undoStack.length = 0
    redoStack.length = 0
    return true
  }

  function formatCellRange(
    anchorCoord: CellCoord,
    focusCoord: CellCoord,
    patch: (current: CellFormatJSON) => CellFormatJSON,
  ): boolean {
    const range = normalizeCellRange(anchorCoord, focusCoord)
    if (rangeCellCount(range) > FORMAT_CELL_LIMIT) {
      if (!sheet.set_format_range) return false
      commitPendingEdit()
      const next = patch({})
      const apply = formatLargeCellRange(range, next)
      if (apply && typeof (apply as Promise<boolean>).catch === 'function') {
        void (apply as Promise<boolean>).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[einfach] large range format failed', err)
        })
      }
      return true
    }

    if (!sheet.set_format) return false
    const ownsBatch = pendingBefore === null
    if (ownsBatch) {
      pendingBefore = []
      pendingAddrs = new Set()
    }
    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const addr = coordToAddr({ row: r, col: c })
        const current = sheet.get_format ? sheet.get_format(addr) : {}
        setFormatInternal(addr, patch(current))
      }
    }
    if (ownsBatch) commitPendingEdit()
    return true
  }

  function clearSmallCellRange(range: NormalizedCellRange) {
    const ownsBatch = pendingBefore === null
    if (ownsBatch) {
      pendingBefore = []
      pendingAddrs = new Set()
    }
    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const addr = coordToAddr({ row: r, col: c })
        recordSingle(addr, () => sheet.clear_cell(addr))
      }
    }
    if (ownsBatch) commitPendingEdit()
    return true
  }

  async function clearLargeCellRange(range: NormalizedCellRange): Promise<boolean> {
    // Large clears are intentionally range-native. Without backend range
    // support, refuse the operation instead of expanding a huge rectangle.
    if (!sheet.clear_range) return false

    commitPendingEdit()
    if (sheet.snapshot_range_sparse && sheet.restore_sparse) {
      const before = await Promise.resolve(
        sheet.snapshot_range_sparse(range.startRow, range.startCol, range.endRow, range.endCol),
      )
      await Promise.resolve(
        sheet.clear_range(range.startRow, range.startCol, range.endRow, range.endCol),
      )
      undoStack.push({ kind: 'sparseRangeClear', range, before })
      redoStack.length = 0
      return true
    }

    await Promise.resolve(
      sheet.clear_range(range.startRow, range.startCol, range.endRow, range.endCol),
    )
    // Backends without sparse restore still cannot safely undo a destructive
    // range command. Drop prior cell entries so Ctrl+Z cannot replay stale
    // snapshots across it.
    undoStack.length = 0
    redoStack.length = 0
    return true
  }

  function clearCellRange(anchorCoord: CellCoord, focusCoord: CellCoord) {
    const range = normalizeCellRange(anchorCoord, focusCoord)
    if (rangeCellCount(range) > RANGE_CLEAR_UNDO_CELL_LIMIT) {
      if (!sheet.clear_range) return false
      if (!sheet.snapshot_range_sparse || !sheet.restore_sparse) {
        commitPendingEdit()
        void sheet.clear_range(range.startRow, range.startCol, range.endRow, range.endCol)
        undoStack.length = 0
        redoStack.length = 0
        return true
      }
      void clearLargeCellRange(range)
      return true
    }
    return clearSmallCellRange(range)
  }

  function clearCellRangeAsync(
    anchorCoord: CellCoord,
    focusCoord: CellCoord,
  ): Promise<boolean> | boolean {
    const range = normalizeCellRange(anchorCoord, focusCoord)
    if (rangeCellCount(range) > RANGE_CLEAR_UNDO_CELL_LIMIT) return clearLargeCellRange(range)
    return clearSmallCellRange(range)
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
     * fired since `acquireHandle(addr)` was first created (i.e. since the
     * first reactive read of this cell)? 0 for addresses that were never
     * touched. Used by `regression.spec.ts` to pin the
     * "subscribe-then-set_formula fires exactly once" contract — without
     * this, the spec couldn't observe fire counts from the browser side.
     *
     * Counter bumps before `bump((t) => t + 1)`, so the count == number
     * of distinct sheet notifications, not Solid render passes. The
     * count persists across handle release (cumulative since first
     * acquire), so a re-acquire after dispose doesn't reset it.
     */
    subscriberFireCount: (addr: string) => fireCounts.get(addr) ?? 0,

    /**
     * Debug-only: how many addresses currently hold at least one live
     * `observeCell` subscription. Used by tests to verify that
     * virtualized Cells release on unmount — if a Large-Grid demo
     * scrolls past 900 rows, we expect this to track the viewport
     * (handful of cells), not the cumulative touched-once count.
     */
    activeSubscriptionCount: () => handles.size,

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
     * of anchor) still produce top-left-first addresses. Oversized
     * selections return null instead of materializing a huge grid on main.
     */
    selectionAddrs: (limit = CLIPBOARD_CELL_LIMIT): string[][] | null => {
      return selectionAddressGrid(limit)
    },

    /**
     * Copy the current selection when it is small enough to represent as a
     * browser clipboard payload. Oversized selections return null instead of
     * constructing a huge address grid on the main thread.
     */
    copySelection(): ClipboardData | null {
      const selectedRange = currentSelectionRange()
      if (rangeCellCount(selectedRange) > CLIPBOARD_CELL_LIMIT) return null
      const addrs = addressGridForRange(selectedRange, CLIPBOARD_CELL_LIMIT)
      return addrs ? copyAddressGrid(addrs) : null
    },

    /**
     * Clipboard-ready TSV for the current selection. Small ranges preserve
     * the existing synchronous copy semantics; large ranges use a backend
     * sparse export when available instead of materializing address grids on
     * the main thread.
     */
    copySelectionTextAsync(): Promise<string | null> {
      return copySelectionText()
    },

    /**
     * One-shot, non-reactive read of a cell's current value. Does NOT
     * subscribe — call sites that need re-renders on backend change
     * must go through `observeCell`. Cheap; safe to call from anywhere
     * (tests, copy/paste, undo recording, etc).
     */
    getCell(addr: string): CellValue {
      return readCell(addr)
    },

    /**
     * Reactive observer for a single cell. Returns:
     *
     *   - `value()`  — Solid accessor; reading it inside a JSX expr or
     *     effect subscribes the caller to per-cell change notifications
     *     from the backend.
     *   - `dispose()` — release the underlying subscription. Required:
     *     long-lived consumers (e.g. `<Cell>`) must call `dispose` on
     *     unmount, otherwise the backend keeps firing callbacks for
     *     scrolled-out cells (row virtualization regression risk).
     *
     * Multiple `observeCell(addr)` calls on the same address share one
     * `sheet.subscribe` under the hood (refcounted in `acquireHandle`),
     * so e.g. a Cell + a FormulaBar observing the same selected cell
     * cost one backend wire.
     *
     * `dispose` is idempotent; calling it twice is a no-op.
     */
    observeCell(addr: string): { value: () => CellValue; dispose: () => void } {
      const handle = acquireHandle(addr)
      let disposed = false
      return {
        value: () => {
          handle.tick() // dep — reactivity hook for Solid
          return readCell(addr)
        },
        dispose: () => {
          if (disposed) return
          disposed = true
          releaseHandle(addr)
        },
      }
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

    async setFormulaDetailedAsync(
      addr: string,
      formula: string,
    ): Promise<FormulaMutationResult> {
      const before = [snapshot(addr)]

      if (sheet.set_formula_detailed_async) {
        const result = await sheet.set_formula_detailed_async(addr, formula)
        if (result.ok) {
          if (pendingBefore !== null) {
            if (!pendingAddrs!.has(addr)) {
              pendingBefore.push(before[0])
              pendingAddrs!.add(addr)
            }
          } else {
            const after = [snapshot(addr)]
            undoStack.push({ kind: 'cells', before, after })
            redoStack.length = 0
          }
        }
        return result
      }

      let ok = false
      if (sheet.set_formula_async) {
        ok = await sheet.set_formula_async(addr, formula)
      } else {
        ok = sheet.set_formula(addr, formula)
      }
      if (!ok) {
        return {
          ok: false,
          code: 'FORMULA_REJECTED',
          message: 'formula was rejected',
        }
      }

      if (pendingBefore !== null) {
        if (!pendingAddrs!.has(addr)) {
          pendingBefore.push(before[0])
          pendingAddrs!.add(addr)
        }
      } else {
        const after = [snapshot(addr)]
        undoStack.push({ kind: 'cells', before, after })
        redoStack.length = 0
      }

      return { ok: true }
    },

    /**
     * Authoritative formula commit path for worker-backed sheets. The
     * legacy synchronous `setFormula` remains for in-process backends and
     * old call sites, but UI commits should prefer this method so worker
     * parse/cycle rejection can be observed instead of treated as a
     * permanent optimistic success.
     */
    async setFormulaAsync(addr: string, formula: string): Promise<boolean> {
      return (await this.setFormulaDetailedAsync(addr, formula)).ok
    },

    /** Clear a cell back to empty. Undoable. */
    clearCell(addr: string) {
      recordSingle(addr, () => sheet.clear_cell(addr))
    },

    /** Clear a rectangular range. Small ranges keep per-cell undo; large
     * backend-capable ranges use `clear_range` without materializing every
     * address on the main thread. */
    clearCellRange,
    clearCellRangeAsync,

    /** Clear the current selection rectangle without forcing callers to
     * first build `selectionAddrs()`. */
    clearSelectionRange() {
      return clearCellRange(anchor(), selection())
    },

    clearSelectionRangeAsync(): Promise<boolean> | boolean {
      return clearCellRangeAsync(anchor(), selection())
    },

    /**
     * Insert `count` empty rows at index `at`. Existing data shifts down;
     * formula references retarget. Undoable — see
     * `docs/STRUCTURAL_UNDO.md` for the snapshot + threshold strategy.
     */
    insertRow(at: number, count = 1) {
      structuralEdit('insertRow', at, count, () => sheet.insert_row?.(at, count))
    },
    deleteRow(at: number, count = 1) {
      structuralEdit('deleteRow', at, count, () => sheet.delete_row?.(at, count))
    },
    insertCol(at: number, count = 1) {
      structuralEdit('insertCol', at, count, () => sheet.insert_col?.(at, count))
    },
    deleteCol(at: number, count = 1) {
      structuralEdit('deleteCol', at, count, () => sheet.delete_col?.(at, count))
    },

    // === Phase 6 — cell formatting (undoable) ===

    /**
     * Apply a format to a cell. Undoable as a `format`-kind snapshot so the
     * cell's value is untouched on undo. No-op when the backend doesn't
     * expose `set_format` (older mocks). Equal formats short-circuit so
     * idle toolbar clicks don't flood the undo stack.
     */
    setFormat(addr: string, fmt: CellFormatJSON) {
      setFormatInternal(addr, fmt)
    },

    /**
     * Apply a format patch to the current selection. Large rectangles are
     * routed through the optional backend range-format API. Without that
     * capability we still reject instead of materializing massive address
     * arrays on the main thread.
     */
    formatSelection(patch: (current: CellFormatJSON) => CellFormatJSON): boolean {
      return formatCellRange(anchor(), selection(), patch)
    },

    /** Read the base format. Returns `{}` (default) if the backend lacks
     * format support so callers don't need null-checks for the JS mock. */
    getFormat(addr: string): CellFormatJSON {
      return sheet.get_format ? sheet.get_format(addr) : {}
    },

    /** Read the effective format (base + first matching conditional rule). */
    getEffectiveFormat(addr: string): CellFormatJSON {
      if (sheet.get_effective_format) return sheet.get_effective_format(addr)
      if (sheet.get_format) return sheet.get_format(addr)
      return {}
    },

    /** Format-aware display string. Same as `getCell(addr).display` but
     * available standalone for callers that already know the cell. */
    formattedDisplay(addr: string): string {
      return sheet.formatted_display ? sheet.formatted_display(addr) : sheet.get_display(addr)
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

    async setCellInputAsync(addr: string, input: string): Promise<boolean> {
      const trimmed = input.trim()
      if (trimmed.startsWith('=')) return this.setFormulaAsync(addr, trimmed)
      this.setCellInput(addr, input)
      return true
    },

    async setCellInputDetailedAsync(addr: string, input: string): Promise<FormulaMutationResult> {
      const trimmed = input.trim()
      if (!trimmed.startsWith('=')) {
        this.setCellInput(addr, input)
        return { ok: true }
      }

      try {
        return await this.setFormulaDetailedAsync(addr, trimmed)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'formula validation failed'
        const code: FormulaMutationErrorCode = 'FORMULA_REJECTED'
        const out: FormulaMutationResult = {
          ok: false,
          code,
          message,
        }
        return out
      }
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
      commitPendingEdit()
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    undo() {
      const entry = undoStack.pop()
      if (!entry) return
      if (entry.kind === 'cells') {
        restoreAll(entry.before)
      } else if (entry.kind === 'structural') {
        // Structural inverse first (puts the grid back in shape), then
        // restore any deleted content from the snapshot. Order matters:
        // restoring rows that don't exist yet would either silently shift
        // out or land on the wrong addresses.
        applyStructural(inverseOp(entry.op), entry.at, entry.count)
        if (entry.snapshot !== null) restoreAll(entry.snapshot.before)
      } else if (entry.kind === 'sparseRangeClear') {
        void restoreSparseSnapshots(entry.before)
      } else {
        void restoreFormatSnapshot(entry.before)
      }
      redoStack.push(entry)
    },

    redo() {
      const entry = redoStack.pop()
      if (!entry) return
      if (entry.kind === 'cells') {
        restoreAll(entry.after)
      } else if (entry.kind === 'structural') {
        applyStructural(entry.op, entry.at, entry.count)
        if (entry.snapshot !== null) restoreAll(entry.snapshot.after)
      } else if (entry.kind === 'sparseRangeClear') {
        void replaySparseRangeClear(entry.range)
      } else {
        void restoreFormatSnapshot(entry.after)
      }
      undoStack.push(entry)
    },

    // === Clipboard ===
    /**
     * Build a clipboard payload from a rectangular range of cell addresses.
     * `addrs[0][0]` is treated as the source origin so paste can compute
     * the (drow, dcol) shift for relative refs.
     * Deprecated for large ranges: callers should prefer `copySelection`,
     * which can reject oversized selections before address materialization.
     */
    copy(addrs: string[][]): ClipboardData | null {
      return copyAddressGrid(addrs)
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
      if (!sheet.set_formula_async) {
        this.beginEdit()
        data.cells.forEach((row, dr) => {
          row.forEach((field, dc) => {
            const addr = colToLetter(start.col + dc) + (start.row + dr + 1)
            // Only shift if the field is a formula. Plain values pass through.
            const out = field.startsWith('=') ? shiftFormulaRefs(field, drow, dcol) : field
            this.setCellInput(addr, out)
          })
        })
        this.endEdit()
        return
      }

      return (async () => {
        this.beginEdit()
        try {
          for (const [dr, row] of data.cells.entries()) {
            for (const [dc, field] of row.entries()) {
              const addr = colToLetter(start.col + dc) + (start.row + dr + 1)
              const out = field.startsWith('=') ? shiftFormulaRefs(field, drow, dcol) : field
              await this.setCellInputAsync(addr, out)
            }
          }
        } finally {
          this.endEdit()
        }
      })()
    },

    /**
     * Tear down the store. Unsubscribes every still-live cell handle and
     * forwards to the backend's optional `dispose` (worker proxy uses
     * this to terminate its Worker; the in-process WASM / JS sheets are
     * a no-op).
     *
     * After `dispose` it is unsafe to call any other method on the
     * returned store — the underlying sheet may no longer respond.
     */
    dispose() {
      for (const h of handles.values()) sheet.unsubscribe(h.token)
      handles.clear()
      sheet.dispose?.()
    },

    /**
     * @deprecated Use the named methods. Direct `raw.*` calls bypass the
     * reactive layer AND the undo bookkeeping.
     */
    raw: sheet,
  }
}

export type SheetStore = ReturnType<typeof createSheetStore>
