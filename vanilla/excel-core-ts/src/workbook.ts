/**
 * Wave B/B2: workbook root.
 *
 * `createWorkbook` builds a `Workbook` handle that owns:
 *  - a vanilla/core `Store` (created internally — host code can opt-in to a
 *    pre-existing store via `options.store`).
 *  - one `WorkbookSheet` per `initialSheets` entry. Each sheet owns a
 *    single `sheetAtom`, per PLAN §4.1.
 *  - a `parseFormula` injectable (defaults to the real parser at
 *    `./parser`). Tests can inject a mock so they don't depend on B1.
 *
 * Mutations always route through the writable `sheetAtom`. We never expose
 * the raw setter to the outside world — the public API is `setCell`,
 * `clearCell`, `bulkApply`, `setFormat`. Each one parses input (if needed)
 * and produces a new `Map` reference. Wave C/E will extend this surface
 * with named-range / custom-formula registration.
 *
 * Recalc / F9 (PLAN §4.4): `recalc()` bumps every sheet's atom to a fresh
 * `Map` clone. Same contents, new identity → vanilla/core marks every
 * formula derive dirty → volatile values come out fresh on next read.
 */

import type { Store } from '@einfach/core'
import { createStore } from '@einfach/core'

import { parseFormula as defaultParseFormula } from './parser'
import { applyCell, createSheet, keyFor, type SheetResolvers, type SheetState, type WorkbookSheet } from './sheet'
import type {
  Cell,
  CellFormat,
  CellRange,
  Expr,
  NameBinding,
  Value,
} from './types'

export interface CreateWorkbookOptions {
  /**
   * Inject a parser. Defaults to `parseFormula` from `./parser` (Wave B/B1).
   * Tests use this to seed pre-parsed ASTs without spinning up the real
   * tokenizer; production code should leave it unset.
   */
  parser?: (input: string) => Expr
  /**
   * Inject a vanilla/core `Store`. Defaults to a fresh `createStore()`.
   * Pass-in is the seam adapters use to share a store with surrounding
   * UI code.
   */
  store?: Store
}

export interface BulkCellInput {
  readonly row: number
  readonly col: number
  readonly input: string
}

export interface Workbook {
  readonly store: Store
  readonly sheets: ReadonlyArray<WorkbookSheet>
  sheet(id: string): WorkbookSheet | undefined
  sheetByName(name: string): WorkbookSheet | undefined
  /** Mutate a single cell. Parses formula input on the fly. */
  setCell(sheetId: string, row: number, col: number, input: string): void
  /**
   * Clear a single cell. `target` controls whether format also clears
   * (mirrors the `ClearCellMutation` envelope in `types.ts`).
   */
  clearCell(
    sheetId: string,
    row: number,
    col: number,
    target?: 'value' | 'format' | 'all',
  ): void
  /** Apply many cells in one atom write (paste / fill / import). */
  bulkApply(sheetId: string, cells: ReadonlyArray<BulkCellInput>): void
  /** Apply a format patch to a rectangular range. */
  setFormat(sheetId: string, range: CellRange, format: Partial<CellFormat>): void
  /** Manual F9 — bump every sheetAtom to a fresh Map reference. */
  recalc(): void
  /**
   * Register a named range / value / LAMBDA. Wave E expands this; B2
   * exposes the seam so the evaluator's `resolveName` path is exercised.
   */
  defineName(name: string, binding: NameBinding): void
  /** Remove a previously defined name. */
  undefineName(name: string): boolean
  /** Register a host custom formula. Synchronous callback only for B2. */
  registerCustomFormula(name: string, fn: (args: Value[]) => Value): void
  unregisterCustomFormula(name: string): boolean
}

export interface SheetSeed {
  readonly id: string
  readonly name: string
}

export function createWorkbook(
  initialSheets: ReadonlyArray<SheetSeed>,
  options: CreateWorkbookOptions = {},
): Workbook {
  const store = options.store ?? createStore()
  const parser = options.parser ?? defaultParseFormula

  // Names + custom formula tables live on the workbook root. They are
  // looked up from every sheet's resolver hook. Wave E will replace the
  // plain Map with an atom-backed registry so name mutations broadcast
  // dirtiness — for B2 a manual recalc covers the contract.
  const names = new Map<string, NameBinding>()
  const customFormulas = new Map<string, (args: Value[]) => Value>()

  // Build the sheet handles eagerly. The `sheets` array order matches
  // `initialSheets` for deterministic iteration.
  const sheetsList: WorkbookSheet[] = []
  const sheetsById = new Map<string, WorkbookSheet>()
  const sheetsByName = new Map<string, WorkbookSheet>()

  const resolvers: SheetResolvers = {
    crossSheetCells(sheetName, get) {
      const target = sheetsByName.get(sheetName)
      if (!target) return undefined
      // Registers a dep on the foreign sheet's atom via the captured getter.
      return get(target.sheetAtom)
    },
    callCustom(name, args) {
      const fn = customFormulas.get(name.toUpperCase())
      if (!fn) return undefined
      return fn(args)
    },
    resolveName(name) {
      return names.get(name)
    },
  }

  for (const seed of initialSheets) {
    const sheet = createSheet(seed.id, seed.name, resolvers)
    sheetsList.push(sheet)
    sheetsById.set(seed.id, sheet)
    sheetsByName.set(seed.name, sheet)
  }

  function requireSheet(sheetId: string): WorkbookSheet {
    const sheet = sheetsById.get(sheetId)
    if (!sheet) {
      throw new Error(`Workbook: unknown sheet id '${sheetId}'`)
    }
    return sheet
  }

  function writeSheetState(sheet: WorkbookSheet, next: SheetState): void {
    store.setter(sheet.sheetAtom, next)
  }

  function buildCell(input: string, existing: Cell | undefined): Cell {
    if (input.length === 0) {
      // Treat empty input as "clear value but keep format" path.
      return {
        input: '',
        value: { kind: 'blank' },
        format: existing?.format,
      }
    }
    if (input[0] === '=') {
      const ast = parser(input)
      return {
        input,
        ast,
        // Initial value before first eval is BLANK; the formula derive
        // computes the real one. We do NOT eagerly evaluate here — the
        // formula-cell atom will run on first sub/read.
        value: { kind: 'blank' },
        format: existing?.format,
      }
    }
    return {
      input,
      value: parseLiteral(input),
      format: existing?.format,
    }
  }

  function setCellInternal(
    sheet: WorkbookSheet,
    row: number,
    col: number,
    input: string,
  ): void {
    const key = keyFor(row, col)
    const prev = store.getter(sheet.sheetAtom) as SheetState
    const next = applyCell(prev, key, (existing) => buildCell(input, existing))
    writeSheetState(sheet, next)
  }

  return {
    store,
    get sheets() {
      return sheetsList
    },
    sheet(id) {
      return sheetsById.get(id)
    },
    sheetByName(name) {
      return sheetsByName.get(name)
    },
    setCell(sheetId, row, col, input) {
      const sheet = requireSheet(sheetId)
      setCellInternal(sheet, row, col, input)
    },
    clearCell(sheetId, row, col, target = 'value') {
      const sheet = requireSheet(sheetId)
      const key = keyFor(row, col)
      const prev = store.getter(sheet.sheetAtom) as SheetState
      const next = applyCell(prev, key, (existing) => {
        if (!existing) return undefined
        if (target === 'all') return undefined
        if (target === 'format') {
          // Drop format only; keep value/formula/ast intact.
          if (!existing.format) return existing
          const { format: _format, ...rest } = existing
          void _format
          return { ...rest }
        }
        // target === 'value' — clear value+formula, keep format.
        if (existing.format) {
          return { input: '', value: { kind: 'blank' }, format: existing.format }
        }
        return undefined
      })
      writeSheetState(sheet, next)
    },
    bulkApply(sheetId, cells) {
      const sheet = requireSheet(sheetId)
      if (cells.length === 0) return
      const prev = store.getter(sheet.sheetAtom) as SheetState
      // Build a single new Map so dependents see one atom write.
      const next = new Map(prev)
      for (const entry of cells) {
        const key = keyFor(entry.row, entry.col)
        next.set(key, buildCell(entry.input, prev.get(key)))
      }
      writeSheetState(sheet, next)
    },
    setFormat(sheetId, range, format) {
      const sheet = requireSheet(sheetId)
      const prev = store.getter(sheet.sheetAtom) as SheetState
      const next = new Map(prev)
      for (let r = range.rowStart; r <= range.rowEnd; r += 1) {
        for (let c = range.colStart; c <= range.colEnd; c += 1) {
          const key = keyFor(r, c)
          const existing = prev.get(key)
          if (existing) {
            next.set(key, {
              ...existing,
              format: { ...existing.format, ...format },
            })
          } else {
            // No cell yet — stamp a blank cell with format only.
            next.set(key, {
              input: '',
              value: { kind: 'blank' },
              format: { ...format },
            })
          }
        }
      }
      writeSheetState(sheet, next)
    },
    recalc() {
      for (const sheet of sheetsList) {
        const prev = store.getter(sheet.sheetAtom) as SheetState
        // Clone to a fresh Map identity — every derive sees a new dep value
        // and marks dirty.
        writeSheetState(sheet, new Map(prev))
      }
    },
    defineName(name, binding) {
      names.set(name, binding)
      // No atom-level invalidation yet — Wave E. Callers can chase with
      // `recalc()` if they need formulas already referencing this name to
      // re-evaluate.
    },
    undefineName(name) {
      return names.delete(name)
    },
    registerCustomFormula(name, fn) {
      customFormulas.set(name.toUpperCase(), fn)
    },
    unregisterCustomFormula(name) {
      return customFormulas.delete(name.toUpperCase())
    },
  }
}

/**
 * Parse a literal cell input into a `Value`. Excel rules:
 *  - `""` → blank (the empty-string case is handled in `buildCell`).
 *  - `TRUE` / `FALSE` (case-insensitive) → boolean.
 *  - finite number → number.
 *  - error literal (`#REF!`, `#VALUE!`, ...) → error.
 *  - otherwise → string.
 */
function parseLiteral(input: string): Value {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { kind: 'string', value: input }
  const upper = trimmed.toUpperCase()
  if (upper === 'TRUE') return { kind: 'boolean', value: true }
  if (upper === 'FALSE') return { kind: 'boolean', value: false }
  // Common Excel error tokens — accept the canonical uppercase form only;
  // the tokenizer's `readError` does case-insensitive matching for in-
  // formula error literals.
  switch (upper) {
    case '#DIV/0!':
      return { kind: 'error', code: '#DIV/0!' }
    case '#N/A':
      return { kind: 'error', code: '#N/A' }
    case '#NAME?':
      return { kind: 'error', code: '#NAME?' }
    case '#NULL!':
      return { kind: 'error', code: '#NULL!' }
    case '#NUM!':
      return { kind: 'error', code: '#NUM!' }
    case '#REF!':
      return { kind: 'error', code: '#REF!' }
    case '#VALUE!':
      return { kind: 'error', code: '#VALUE!' }
  }
  const num = Number(trimmed)
  if (Number.isFinite(num) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    return { kind: 'number', value: num }
  }
  return { kind: 'string', value: input }
}
