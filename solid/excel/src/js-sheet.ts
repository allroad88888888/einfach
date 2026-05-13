import type { CellFormatJSON, FormatRangeSnapshot, ISheet } from './types'
import { formatsEqual } from './types'
import {
  shiftFormulaForColDelete,
  shiftFormulaForColInsert,
  shiftFormulaForRowDelete,
  shiftFormulaForRowInsert,
} from './formula-shift'
import { addrToCoord, coordToAddr } from './selection'

/**
 * Pure JS implementation of ISheet for development / jest tests.
 *
 * NOTE: this is a mock — the formula evaluator only handles a subset of
 * what the Rust backend supports (see ISSUES.md D.1). It exists so jest
 * tests can run without the WASM toolchain. Production / e2e tests must
 * use createWasmSheet().
 *
 * Subscribe / unsubscribe is implemented by snapshotting cell display
 * values around every mutation and firing listeners for any cell whose
 * snapshot changed. This includes transitively-dependent formula cells
 * because recalcAll runs before the diff.
 */
export function createJSSheet(): ISheet {
  const cells = new Map<string, { type: string; value: unknown; formula?: string }>()
  const formulas = new Map<string, string>()
  const formats = new Map<string, CellFormatJSON>()
  const rangeFormats: Array<{
    startRow: number
    startCol: number
    endRow: number
    endCol: number
    fmt: CellFormatJSON
  }> = []
  const listeners = new Map<string, Map<number, () => void>>()
  const tokenToAddr = new Map<number, string>()
  let nextToken = 0

  function getFormat(addr: string): CellFormatJSON {
    const a = addr.toUpperCase()
    const explicit = formats.get(a)
    if (explicit) return explicit
    const coord = addrToCoord(a)
    if (!coord) return {}
    for (let i = rangeFormats.length - 1; i >= 0; i--) {
      const layer = rangeFormats[i]
      if (
        coord.row >= layer.startRow &&
        coord.row <= layer.endRow &&
        coord.col >= layer.startCol &&
        coord.col <= layer.endCol
      ) {
        return layer.fmt
      }
    }
    return {}
  }

  function normalizeRange(startRow: number, startCol: number, endRow: number, endCol: number) {
    return {
      startRow: Math.min(startRow, endRow),
      startCol: Math.min(startCol, endCol),
      endRow: Math.max(startRow, endRow),
      endCol: Math.max(startCol, endCol),
    }
  }

  function addrInRange(addr: string, range: ReturnType<typeof normalizeRange>): boolean {
    const coord = addrToCoord(addr)
    if (!coord) return false
    return (
      coord.row >= range.startRow &&
      coord.row <= range.endRow &&
      coord.col >= range.startCol &&
      coord.col <= range.endCol
    )
  }

  /** Apply a CellFormat's number format to a numeric value. Mirrors a subset
   *  of `CellFormat::format_number` in Rust — General / Decimal / Percent /
   *  Currency only. Date falls back to the default rendering. */
  function formatNumber(n: number, fmt: CellFormatJSON): string {
    const nf = fmt.numberFormat
    if (!nf || nf.kind === 'general') {
      if (n === Math.floor(n) && Math.abs(n) < 1e15) return String(Math.round(n))
      return String(n)
    }
    if (nf.kind === 'percent') {
      const digits = nf.digits ?? 0
      return (n * 100).toFixed(digits) + '%'
    }
    if (nf.kind === 'decimal') {
      const digits = nf.digits ?? 2
      const body = n.toFixed(digits)
      if (!nf.thousands) return body
      return insertThousands(body)
    }
    if (nf.kind === 'currency') {
      const digits = nf.digits ?? 2
      const symbol = nf.symbol ?? '$'
      return symbol + insertThousands(n.toFixed(digits))
    }
    // Date — no JS-side calendar logic; just render the number.
    if (n === Math.floor(n) && Math.abs(n) < 1e15) return String(Math.round(n))
    return String(n)
  }

  function insertThousands(s: string): string {
    const [intPart, fracPart] = s.split('.')
    const negative = intPart.startsWith('-')
    const digits = negative ? intPart.slice(1) : intPart
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    const head = (negative ? '-' : '') + grouped
    return fracPart === undefined ? head : `${head}.${fracPart}`
  }

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

  /** Snapshot every subscribed address's display value. */
  function snapshotDisplays(): Map<string, string> {
    const snap = new Map<string, string>()
    for (const addr of listeners.keys()) {
      snap.set(addr, getDisplay(addr))
    }
    return snap
  }

  /** Compare against a snapshot and fire listeners for changed cells. */
  function fireChanges(before: Map<string, string>) {
    for (const [addr, prev] of before) {
      const now = getDisplay(addr)
      if (now !== prev) {
        const map = listeners.get(addr)
        if (map) for (const cb of map.values()) cb()
      }
    }
  }

  function getDisplay(addr: string): string {
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
  }

  return {
    set_number(addr: string, value: number) {
      const a = addr.toUpperCase()
      const before = snapshotDisplays()
      formulas.delete(a)
      cells.set(a, { type: 'number', value })
      recalcAll()
      fireChanges(before)
    },

    set_text(addr: string, value: string) {
      const a = addr.toUpperCase()
      const before = snapshotDisplays()
      formulas.delete(a)
      cells.set(a, { type: 'text', value })
      recalcAll()
      fireChanges(before)
    },

    set_boolean(addr: string, value: boolean) {
      const a = addr.toUpperCase()
      const before = snapshotDisplays()
      formulas.delete(a)
      cells.set(a, { type: 'boolean', value })
      recalcAll()
      fireChanges(before)
    },

    set_error(addr: string, value: string) {
      const a = addr.toUpperCase()
      const before = snapshotDisplays()
      formulas.delete(a)
      cells.set(a, { type: 'error', value })
      recalcAll()
      fireChanges(before)
    },

    set_formula(addr: string, formula: string): boolean {
      const a = addr.toUpperCase()
      const before = snapshotDisplays()
      formulas.set(a, formula)
      const result = evalFormula(formula)
      cells.set(a, { ...result, formula })
      fireChanges(before)
      return result.type !== 'error'
    },

    get_display(addr: string): string {
      return getDisplay(addr)
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

    get_formula(addr: string): string {
      return formulas.get(addr.toUpperCase()) ?? ''
    },

    subscribe(addr: string, callback: () => void): number {
      const a = addr.toUpperCase()
      const token = nextToken++
      let map = listeners.get(a)
      if (!map) {
        map = new Map()
        listeners.set(a, map)
      }
      map.set(token, callback)
      tokenToAddr.set(token, a)
      return token
    },

    unsubscribe(token: number): void {
      const addr = tokenToAddr.get(token)
      if (!addr) return
      const map = listeners.get(addr)
      if (map) {
        map.delete(token)
        if (map.size === 0) listeners.delete(addr)
      }
      tokenToAddr.delete(token)
    },

    clear_cell(addr: string): void {
      const a = addr.toUpperCase()
      const before = snapshotDisplays()
      formulas.delete(a)
      cells.delete(a)
      recalcAll()
      fireChanges(before)
    },

    // Structural edits — relocate cells AND retarget formula refs (parity
    // with Rust shift_addr_*). Refs into the deleted band become #REF!.
    insert_row(at: number, count: number) {
      const before = snapshotDisplays()
      relocate(
        (a) => (a.row >= at ? { ...a, row: a.row + count } : a),
        (f) => shiftFormulaForRowInsert(f, at, count),
      )
      recalcAll()
      fireChanges(before)
    },
    delete_row(at: number, count: number) {
      const before = snapshotDisplays()
      relocate(
        (a) => {
          if (a.row >= at && a.row < at + count) return null
          if (a.row >= at + count) return { ...a, row: a.row - count }
          return a
        },
        (f) => shiftFormulaForRowDelete(f, at, count),
      )
      recalcAll()
      fireChanges(before)
    },
    insert_col(at: number, count: number) {
      const before = snapshotDisplays()
      relocate(
        (a) => (a.col >= at ? { ...a, col: a.col + count } : a),
        (f) => shiftFormulaForColInsert(f, at, count),
      )
      recalcAll()
      fireChanges(before)
    },
    delete_col(at: number, count: number) {
      const before = snapshotDisplays()
      relocate(
        (a) => {
          if (a.col >= at && a.col < at + count) return null
          if (a.col >= at + count) return { ...a, col: a.col - count }
          return a
        },
        (f) => shiftFormulaForColDelete(f, at, count),
      )
      recalcAll()
      fireChanges(before)
    },

    /**
     * Every address with a primitive value or a formula. Empty cells are
     * skipped. The Rust backend's `non_empty_addrs()` parity — used by
     * structural-undo (see `docs/STRUCTURAL_UNDO.md`).
     *
     * Formula and value entries can both exist on the same address during
     * a brief upgrade window, but `cells` is cleared in that path before
     * the formula entry is written, so we never see duplicates here.
     */
    non_empty_addrs(): string[] {
      const out = new Set<string>()
      for (const a of cells.keys()) out.add(a)
      for (const a of formulas.keys()) out.add(a)
      return Array.from(out)
    },

    // === Phase 6 — cell formatting ===
    set_format(addr: string, fmt: CellFormatJSON | null | undefined) {
      const a = addr.toUpperCase()
      const before = snapshotDisplays()
      if (!fmt || formatsEqual(fmt, {})) {
        formats.delete(a)
      } else {
        formats.set(a, { ...fmt })
      }
      // Fire the address listener so views can re-style without a value
      // change. We don't snapshot styling, so reuse the display-diff sweep
      // and just force-fire the listener for this address.
      const map = listeners.get(a)
      if (map) for (const cb of map.values()) cb()
      // Other addresses may have changed if conditional rules were active;
      // we don't keep conditional rules in the JS mock, but the diff sweep
      // is cheap and consistent with set_cell semantics.
      fireChanges(before)
    },

    set_format_range(startRow, startCol, endRow, endCol, fmt) {
      const range = normalizeRange(startRow, startCol, endRow, endCol)
      const before = snapshotDisplays()
      for (const addr of [...formats.keys()]) {
        if (addrInRange(addr, range)) formats.delete(addr)
      }
      rangeFormats.push({ ...range, fmt: fmt && !formatsEqual(fmt, {}) ? { ...fmt } : {} })
      for (const [addr, map] of listeners) {
        if (!addrInRange(addr, range)) continue
        for (const cb of map.values()) cb()
      }
      fireChanges(before)
      return 1
    },

    snapshot_format_range(startRow, startCol, endRow, endCol): FormatRangeSnapshot {
      const range = normalizeRange(startRow, startCol, endRow, endCol)
      return {
        ...range,
        cellFormats: [...formats.entries()]
          .filter(([addr]) => addrInRange(addr, range))
          .map(([addr, format]) => ({ addr, format: { ...format } }))
          .sort((a, b) => {
            const ac = addrToCoord(a.addr)!
            const bc = addrToCoord(b.addr)!
            return ac.row - bc.row || ac.col - bc.col
          }),
        rangeFormats: rangeFormats.map((layer) => ({
          startRow: layer.startRow,
          startCol: layer.startCol,
          endRow: layer.endRow,
          endCol: layer.endCol,
          format: { ...layer.fmt },
        })),
      }
    },

    restore_format_snapshot(snapshot) {
      const range = normalizeRange(
        snapshot.startRow,
        snapshot.startCol,
        snapshot.endRow,
        snapshot.endCol,
      )
      const before = snapshotDisplays()
      for (const addr of [...formats.keys()]) {
        if (addrInRange(addr, range)) formats.delete(addr)
      }
      for (const cell of snapshot.cellFormats) {
        if (!formatsEqual(cell.format, {})) formats.set(cell.addr.toUpperCase(), { ...cell.format })
      }
      rangeFormats.length = 0
      for (const layer of snapshot.rangeFormats) {
        rangeFormats.push({
          ...normalizeRange(layer.startRow, layer.startCol, layer.endRow, layer.endCol),
          fmt: { ...layer.format },
        })
      }
      for (const [addr, map] of listeners) {
        if (!addrInRange(addr, range)) continue
        for (const cb of map.values()) cb()
      }
      fireChanges(before)
      return 1
    },

    get_format(addr: string): CellFormatJSON {
      return getFormat(addr)
    },

    get_effective_format(addr: string): CellFormatJSON {
      // JS mock does not track conditional rules; effective == base.
      return getFormat(addr)
    },

    formatted_display(addr: string): string {
      const cell = cells.get(addr.toUpperCase())
      if (!cell) return ''
      if (cell.type !== 'number') {
        // Non-numeric falls back to default display.
        if (cell.type === 'error') return cell.value as string
        if (cell.type === 'boolean') return cell.value ? 'TRUE' : 'FALSE'
        if (cell.type === 'text') return cell.value as string
        return ''
      }
      return formatNumber(cell.value as number, getFormat(addr))
    },
  }

  /**
   * Relocate cells and rewrite formula sources.
   *
   * - `mapAddr` decides where a cell ends up; `null` drops it.
   * - `shiftRefs` rewrites cell references inside any formula that
   *   survives. Refs into the deleted band become `#REF!`.
   *
   * After relocation, surviving formula cell entries (in `cells`) carry
   * the OLD computed value; we re-eval all formulas via `recalcAll` after
   * relocate returns, so `cells` gets refreshed against the shifted refs.
   */
  function relocate(
    mapAddr: (a: { row: number; col: number }) => { row: number; col: number } | null,
    shiftRefs: (formula: string) => string,
  ) {
    const newCells = new Map<string, ReturnType<typeof cells.get>>()
    const newFormulas = new Map<string, string>()
    for (const [addr, val] of cells) {
      const c = addrToCoord(addr)
      if (!c) throw new Error(`Invalid address: ${addr}`)
      const moved = mapAddr(c)
      if (moved === null) continue
      const nextAddr = coordToAddr(moved)
      newCells.set(nextAddr, val)
    }
    for (const [addr, f] of formulas) {
      const c = addrToCoord(addr)
      if (!c) throw new Error(`Invalid address: ${addr}`)
      const moved = mapAddr(c)
      if (moved === null) continue
      const nextAddr = coordToAddr(moved)
      newFormulas.set(nextAddr, shiftRefs(f))
    }
    // Phase 6 — formats shift alongside cells. Entries mapped to `null` are
    // dropped (delete band), otherwise they move with their cell.
    const newFormats = new Map<string, CellFormatJSON>()
    for (const [addr, fmt] of formats) {
      const c = addrToCoord(addr)
      if (!c) throw new Error(`Invalid address: ${addr}`)
      const moved = mapAddr(c)
      if (moved === null) continue
      const nextAddr = coordToAddr(moved)
      newFormats.set(nextAddr, fmt)
    }
    const newRangeFormats: typeof rangeFormats = []
    for (const layer of rangeFormats) {
      const start = mapAddr({ row: layer.startRow, col: layer.startCol })
      const end = mapAddr({ row: layer.endRow, col: layer.endCol })
      if (start === null || end === null) continue
      newRangeFormats.push({
        ...normalizeRange(start.row, start.col, end.row, end.col),
        fmt: layer.fmt,
      })
    }
    cells.clear()
    formulas.clear()
    formats.clear()
    rangeFormats.length = 0
    for (const [a, v] of newCells) {
      if (v) cells.set(a, v)
    }
    for (const [a, f] of newFormulas) formulas.set(a, f)
    for (const [a, fmt] of newFormats) formats.set(a, fmt)
    rangeFormats.push(...newRangeFormats)
  }
}
