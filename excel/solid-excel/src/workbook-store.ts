import { createSignal } from 'solid-js'
import { createSheetStore, type SheetStore } from './sheet-store'
import { createJSSheet } from './js-sheet'

/**
 * Reactive workbook wrapper.
 *
 * Mirrors the shape of `excel/rust/excel-core/src/workbook.rs::Workbook`
 * (sheets / names / by_name + add/rename/remove/sheet-lookup) but lives
 * entirely in JS — each sheet is a fresh `createJSSheet()` wrapped in a
 * `createSheetStore()`. There is NO Rust `WasmWorkbook` binding yet
 * (deliberate — see `excel/rust/docs/TODO.md` 1.5).
 *
 * IMPORTANT GAP: cross-sheet formula evaluation does NOT work.
 * `createJSSheet()` is a single-sheet evaluator with no workbook
 * context; `=Sheet2!A1` will fail to parse / evaluate the same way it
 * does in any single-sheet scenario. The Rust `Workbook::get_cell`
 * cross-sheet resolver has no JS counterpart. Real cross-sheet eval
 * lands when (a) `WasmWorkbook` is exposed from `excel/rust/wasm/src/lib.rs`
 * AND (b) a `createWasmWorkbookSheet(idx)` factory replaces the
 * single-sheet `createJSSheet()` here.
 */

interface SheetEntry {
  /** Stable id used as the key in the internal map. Never reused. */
  id: number
  name: string
  store: SheetStore
}

export interface WorkbookSheetMeta {
  /** Position in the tab bar (0-indexed). Shifts on remove. */
  idx: number
  /** Display name. Unique within the workbook. */
  name: string
}

export interface WorkbookStore {
  /** Reactive list of `{ idx, name }` in tab order. */
  sheets: () => WorkbookSheetMeta[]
  /** Currently active sheet index. */
  activeIdx: () => number
  /** Switch the active sheet. No-op if `idx` is out of range. */
  setActiveIdx: (idx: number) => void
  /** SheetStore for the active sheet (derived). */
  activeStore: () => SheetStore
  /**
   * Append a new sheet. If `name` is omitted, picks "Sheet{N}" where N is
   * the smallest integer that doesn't collide. Returns the new index.
   * Returns -1 if `name` is provided but already taken.
   */
  addSheet: (name?: string) => number
  /**
   * Remove the sheet at `idx`. If the active sheet is removed, the active
   * index is moved to the nearest neighbor (prev if possible, else next).
   * Returns true on success. Refuses to remove the last remaining sheet.
   */
  removeSheet: (idx: number) => boolean
  /**
   * Rename sheet at `idx`. Returns false if `idx` is out of range or
   * `name` is already taken (case-sensitive match — like Rust
   * `Workbook::rename_sheet`).
   */
  renameSheet: (idx: number, name: string) => boolean
  /** Lookup helper. Returns -1 if no match. */
  indexOf: (name: string) => number
  /** Get the SheetStore at `idx`, or undefined if out of range. */
  sheetAt: (idx: number) => SheetStore | undefined
}

export function createWorkbookStore(): WorkbookStore {
  // The Map keys are stable internal ids; the array order defines tab
  // position. Using a Map makes activeStore() lookups by id stable across
  // remove/insert (a removed sheet's store is dropped only when it leaves
  // the entries array — the Map is just an iteration helper).
  const entries: SheetEntry[] = []
  const byId = new Map<number, SheetEntry>()
  let nextId = 0

  const [version, setVersion] = createSignal(0)
  const [activeIdx, setActiveIdxRaw] = createSignal(0)

  function bump() {
    setVersion((v) => v + 1)
  }

  function nameTaken(name: string): boolean {
    return entries.some((e) => e.name === name)
  }

  function pickDefaultName(): string {
    let n = entries.length + 1
    while (nameTaken(`Sheet${n}`)) n++
    return `Sheet${n}`
  }

  function addSheet(name?: string): number {
    const finalName = name ?? pickDefaultName()
    if (nameTaken(finalName)) return -1
    const entry: SheetEntry = {
      id: nextId++,
      name: finalName,
      store: createSheetStore(createJSSheet()),
    }
    entries.push(entry)
    byId.set(entry.id, entry)
    bump()
    return entries.length - 1
  }

  function removeSheet(idx: number): boolean {
    if (idx < 0 || idx >= entries.length) return false
    if (entries.length <= 1) return false
    const [removed] = entries.splice(idx, 1)
    byId.delete(removed.id)
    // Drop subscriptions held by the removed store.
    removed.store.dispose()
    // Re-point active. If the removed idx was active or before active,
    // shift active to the nearest valid neighbor.
    const cur = activeIdx()
    if (cur === idx) {
      // Prefer prev sheet when removing the active tab — matches Excel UX.
      setActiveIdxRaw(Math.max(0, idx - 1))
    } else if (cur > idx) {
      setActiveIdxRaw(cur - 1)
    }
    bump()
    return true
  }

  function renameSheet(idx: number, name: string): boolean {
    if (idx < 0 || idx >= entries.length) return false
    if (entries[idx].name === name) return true
    if (nameTaken(name)) return false
    entries[idx] = { ...entries[idx], name }
    bump()
    return true
  }

  function indexOf(name: string): number {
    return entries.findIndex((e) => e.name === name)
  }

  function setActiveIdx(idx: number) {
    if (idx < 0 || idx >= entries.length) return
    setActiveIdxRaw(idx)
  }

  function activeStore(): SheetStore {
    const idx = activeIdx()
    // version() is read here to make activeStore reactive to add/remove
    // (the active idx may not change but the underlying entry might).
    version()
    return entries[idx].store
  }

  function sheets(): WorkbookSheetMeta[] {
    version()
    return entries.map((e, idx) => ({ idx, name: e.name }))
  }

  function sheetAt(idx: number): SheetStore | undefined {
    version()
    return entries[idx]?.store
  }

  // Seed with one sheet — same UX as `Workbook::new()` on the Rust side.
  addSheet('Sheet1')
  setActiveIdxRaw(0)

  return {
    sheets,
    activeIdx,
    setActiveIdx,
    activeStore,
    addSheet,
    removeSheet,
    renameSheet,
    indexOf,
    sheetAt,
  }
}
