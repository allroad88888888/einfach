import { describe, expect, it } from '@jest/globals'
import { createRangeProjectionRequest, type DisplayCell } from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'

// Static-backend Excel Table CRUD + structured-reference evaluation
// (design-excel-table.md §4/§5, parity #32). The static backend owns the
// Table registry directly and resolves `Table[...]` references at eval time.
//
// Structured-reference support in static (honest boundary — no faked values):
//   supported: `Table1[Col]`, `Table1[[A]:[B]]`,
//   `Table1[#All|#Data|#Headers|#Totals|#This Row]`, `Table1[@Col]`,
//   `Table1[@]`, and the table-less `[Col]` / `[@Col]` / `[@]` forms inside a
//   Table's own cells. A 1×1 reference also resolves in VALUE context, so
//   `=[@Price]*[@Qty]` works. Errors: unknown table → `#NAME?`; unknown column
//   / missing band → `#REF!`; this-row outside the data body or a table-less
//   form outside any Table → `#VALUE!`; a bare `Table1` is an unknown workbook
//   name → `#NAME?`. NOT supported (→ `#ERROR!`): combined `[[#Data],[Col]]`
//   (the engine grammar defers it too) and cross-sheet Table refs.

const SHEET = 'sheet-1'
const SHEET2 = 'sheet-2'

function seededBackend() {
  return createStaticSpreadsheetBackend({
    revision: 1,
    sheets: [
      { id: SHEET, name: 'Sales' },
      { id: SHEET2, name: 'Forecast' },
    ],
    matrix: [
      ['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total'],
      ['North', 120, 180, 240, 300, 840],
      ['South', 80, 160, 240, 320, 800],
      ['East', 200, 100, 50, 150, 500],
    ],
  })
}

type Backend = ReturnType<typeof seededBackend>

const A1_D4 = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 5 }

async function readCell(backend: Backend, sheetId: string, row: number, col: number): Promise<DisplayCell | undefined> {
  const result = await backend.readRangeProjection(
    createRangeProjectionRequest({
      sheetId,
      requestId: 1,
      reason: 'test',
      range: { rowStart: row, rowEnd: row, colStart: col, colEnd: col },
    }),
  )
  return result.cells.find((c) => c.row === row && c.col === col)
}

async function setFormula(backend: Backend, sheetId: string, row: number, col: number, input: string): Promise<void> {
  await backend.setCellInput({ kind: 'set-cell-input', sheetId, row, col, input })
}

/** Set a formula at H1 (outside the seeded table) and read back its display. */
async function evalFormula(backend: Backend, input: string, sheetId: string = SHEET): Promise<string> {
  await setFormula(backend, sheetId, 0, 7, input)
  const cell = await readCell(backend, sheetId, 0, 7)
  return cell?.displayValue ?? ''
}

describe('static backend — Excel Table CRUD', () => {
  it('creates a table with an auto name; list/get project geometry and derived columns', async () => {
    const backend = seededBackend()
    const created = await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })
    expect(created.applied).toBe(true)
    expect(created.applied && created.name).toBe('Table1')

    const list = await backend.listTables!({ kind: 'list-tables' })
    expect(list.tables).toHaveLength(1)
    const descriptor = list.tables[0]
    expect(descriptor).toMatchObject({
      name: 'Table1',
      sheetId: SHEET,
      sheetName: 'Sales',
      sheetIndex: 0,
      range: 'A1:F4',
      hasHeaders: true,
      hasTotals: false,
      columns: ['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total'],
    })

    const got = await backend.getTable!({ kind: 'get-table', name: 'table1' })
    expect(got.table).toEqual(descriptor)
    const missing = await backend.getTable!({ kind: 'get-table', name: 'Nope' })
    expect(missing.table).toBeNull()
  })

  it('honours an explicit name and disambiguates blank / duplicate headers to ColumnN', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [
        ['Amount', '', 'Amount', 'x'],
        [1, 2, 3, 4],
      ],
    })
    const created = await backend.createTable!({
      kind: 'create-table',
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 3 },
      name: 'Ledger',
    })
    expect(created.applied && created.name).toBe('Ledger')
    const got = await backend.getTable!({ kind: 'get-table', name: 'Ledger' })
    // Blank header → Column1; duplicate "Amount" → Column2.
    expect(got.table?.columns).toEqual(['Amount', 'Column1', 'Column2', 'x'])
  })

  it('rejects invalid / reserved / cell-ref-like / conflicting names before writing', async () => {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4, name: 'Sales1' })
    const spare = { rowStart: 10, rowEnd: 11, colStart: 0, colEnd: 1 }

    const invalid = await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: spare, name: '1bad' })
    expect(invalid).toMatchObject({ applied: false, code: 'invalid-name' })

    const reserved = await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: spare, name: 'SUM' })
    expect(reserved).toMatchObject({ applied: false, code: 'reserved-name' })

    const cellRef = await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: spare, name: 'AB12' })
    expect(cellRef).toMatchObject({ applied: false, code: 'name-like-cell-ref' })

    const conflict = await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: spare, name: 'sales1' })
    expect(conflict).toMatchObject({ applied: false, code: 'name-conflict' })

    // Only the first table exists — every reject was pre-write.
    const list = await backend.listTables!({ kind: 'list-tables' })
    expect(list.tables.map((t) => t.name)).toEqual(['Sales1'])
  })

  it('rejects range overlap and unknown sheet', async () => {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })

    const overlap = await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: { rowStart: 2, rowEnd: 4, colStart: 0, colEnd: 1 } })
    expect(overlap).toMatchObject({ applied: false, code: 'range-overlap' })

    // Same coordinates but a DIFFERENT sheet do not overlap.
    const otherSheet = await backend.createTable!({ kind: 'create-table', sheetId: SHEET2, range: A1_D4 })
    expect(otherSheet.applied).toBe(true)

    const noSheet = await backend.createTable!({ kind: 'create-table', sheetId: 'sheet-404', range: A1_D4 })
    expect(noSheet).toMatchObject({ applied: false, code: 'sheet-not-found' })
  })

  it('enforces the 256-table cap', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1 })
    for (let i = 0; i < 256; i += 1) {
      const created = await backend.createTable!({
        kind: 'create-table',
        sheetId: 'sheet-1',
        range: { rowStart: i * 3, rowEnd: i * 3 + 1, colStart: 0, colEnd: 1 },
      })
      expect(created.applied).toBe(true)
    }
    const overflow = await backend.createTable!({
      kind: 'create-table',
      sheetId: 'sheet-1',
      range: { rowStart: 1000, rowEnd: 1001, colStart: 0, colEnd: 1 },
    })
    expect(overflow).toMatchObject({ applied: false, code: 'too-many-tables' })
    const list = await backend.listTables!({ kind: 'list-tables' })
    expect(list.tables).toHaveLength(256)
  })

  it('renames a table, rewrites referencing formulas, and reflects the new name', async () => {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })
    await setFormula(backend, SHEET, 6, 0, '=SUM(Table1[Q1])')

    const renamed = await backend.renameTable!({ kind: 'rename-table', name: 'Table1', newName: 'Sales' })
    expect(renamed).toMatchObject({ applied: true, name: 'Sales' })

    const list = await backend.listTables!({ kind: 'list-tables' })
    expect(list.tables.map((t) => t.name)).toEqual(['Sales'])

    const cell = await readCell(backend, SHEET, 6, 0)
    expect(cell?.formula).toBe('=SUM(Sales[Q1])')
    expect(cell?.displayValue).toBe('400') // 120 + 80 + 200

    const missing = await backend.renameTable!({ kind: 'rename-table', name: 'Table1', newName: 'X' })
    expect(missing).toMatchObject({ applied: false, code: 'not-found' })
  })

  it('renames a column, rewrites referencing formulas, and rejects conflicts', async () => {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })
    await setFormula(backend, SHEET, 6, 0, '=SUM(Table1[Q1])')

    const renamed = await backend.renameTableColumn!({ kind: 'rename-table-column', name: 'Table1', oldColumn: 'Q1', newColumn: 'Quarter1' })
    expect(renamed.applied).toBe(true)

    const got = await backend.getTable!({ kind: 'get-table', name: 'Table1' })
    expect(got.table?.columns).toEqual(['Region', 'Quarter1', 'Q2', 'Q3', 'Q4', 'Total'])

    const cell = await readCell(backend, SHEET, 6, 0)
    expect(cell?.formula).toBe('=SUM(Table1[Quarter1])')
    expect(cell?.displayValue).toBe('400')

    const notFound = await backend.renameTableColumn!({ kind: 'rename-table-column', name: 'Table1', oldColumn: 'Nope', newColumn: 'Z' })
    expect(notFound).toMatchObject({ applied: false, code: 'column-not-found' })

    const dupe = await backend.renameTableColumn!({ kind: 'rename-table-column', name: 'Table1', oldColumn: 'Q2', newColumn: 'quarter1' })
    expect(dupe).toMatchObject({ applied: false, code: 'duplicate-column' })

    const empty = await backend.renameTableColumn!({ kind: 'rename-table-column', name: 'Table1', oldColumn: 'Q2', newColumn: '  ' })
    expect(empty).toMatchObject({ applied: false, code: 'invalid-column-name' })
  })

  it('deletes a table (convert to range): registry entry gone, values kept', async () => {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })

    const deleted = await backend.deleteTable!({ kind: 'delete-table', name: 'Table1' })
    expect(deleted).toMatchObject({ applied: true, name: 'Table1' })

    const list = await backend.listTables!({ kind: 'list-tables' })
    expect(list.tables).toHaveLength(0)

    // Values survive the "convert to range".
    const b2 = await readCell(backend, SHEET, 1, 1)
    expect(b2?.displayValue).toBe('120')

    const again = await backend.deleteTable!({ kind: 'delete-table', name: 'Table1' })
    expect(again).toMatchObject({ applied: false, code: 'not-found' })
  })
})

describe('static backend — structural remap of Table ranges', () => {
  it('shifts the range when rows are inserted above the header', async () => {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })
    await setFormula(backend, SHEET, 20, 0, '=SUM(Table1[Q1])')

    await backend.insertRows!({ kind: 'insert-rows', sheetId: SHEET, rowIndex: 0, count: 1 })
    const got = await backend.getTable!({ kind: 'get-table', name: 'Table1' })
    expect(got.table?.range).toBe('A2:F5')

    // The data shifted down with the table; the reference re-resolves correctly.
    const cell = await readCell(backend, SHEET, 21, 0)
    expect(cell?.displayValue).toBe('400')
  })

  it('grows the range when a row is inserted inside the data region', async () => {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })
    await backend.insertRows!({ kind: 'insert-rows', sheetId: SHEET, rowIndex: 2, count: 1 })
    const got = await backend.getTable!({ kind: 'get-table', name: 'Table1' })
    expect(got.table?.range).toBe('A1:F5')
  })

  it('shrinks the range when data rows are deleted, and drops the table when the header goes', async () => {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })

    await backend.deleteRows!({ kind: 'delete-rows', sheetId: SHEET, rowIndex: 3, count: 1 })
    const shrunk = await backend.getTable!({ kind: 'get-table', name: 'Table1' })
    expect(shrunk.table?.range).toBe('A1:F3')

    // Deleting the header row destroys the table.
    await backend.deleteRows!({ kind: 'delete-rows', sheetId: SHEET, rowIndex: 0, count: 1 })
    const gone = await backend.getTable!({ kind: 'get-table', name: 'Table1' })
    expect(gone.table).toBeNull()
  })

  it('widens the range and auto-names inserted columns; drops names on column delete', async () => {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })

    await backend.insertColumns!({ kind: 'insert-columns', sheetId: SHEET, colIndex: 2, count: 1 })
    const widened = await backend.getTable!({ kind: 'get-table', name: 'Table1' })
    expect(widened.table?.range).toBe('A1:G4')
    expect(widened.table?.columns).toEqual(['Region', 'Q1', 'Column1', 'Q2', 'Q3', 'Q4', 'Total'])

    await backend.deleteColumns!({ kind: 'delete-columns', sheetId: SHEET, colIndex: 2, count: 1 })
    const narrowed = await backend.getTable!({ kind: 'get-table', name: 'Table1' })
    expect(narrowed.table?.columns).toEqual(['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total'])
    expect(narrowed.table?.range).toBe('A1:F4')
  })

  it('drops tables anchored to a deleted sheet', async () => {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET2, range: A1_D4 })
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })

    await backend.deleteSheet!({ kind: 'delete-sheet', sheetId: SHEET2 })
    const list = await backend.listTables!({ kind: 'list-tables' })
    expect(list.tables.map((t) => t.sheetId)).toEqual([SHEET])
  })
})

describe('static backend — structured-reference evaluation', () => {
  async function withTable(): Promise<Backend> {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })
    return backend
  }

  it('resolves single-column, multi-column, and #area references inside aggregations', async () => {
    const backend = await withTable()
    expect(await evalFormula(backend, '=SUM(Table1[Q1])')).toBe('400') // 120+80+200
    expect(await evalFormula(backend, '=SUM(Table1[[Q1]:[Q2]])')).toBe('840') // 400 + 440
    expect(await evalFormula(backend, '=COUNT(Table1[Q1])')).toBe('3')
    // #Data spans all six columns of the three data rows; SUM skips the text
    // Region column → 1680 + 1600 + 1000.
    expect(await evalFormula(backend, '=SUM(Table1[#Data])')).toBe('4280')
    // #All adds the (text) header row — same numeric sum.
    expect(await evalFormula(backend, '=SUM(Table1[#All])')).toBe('4280')
    // #Headers is the all-text header row.
    expect(await evalFormula(backend, '=SUM(Table1[#Headers])')).toBe('0')
    // Bracketed single column with the same result as the bare colref form.
    expect(await evalFormula(backend, '=SUM(Table1[[Q1]])')).toBe('400')
  })

  it('surfaces honest errors for unknown table / column / missing totals row', async () => {
    const backend = await withTable()
    expect(await evalFormula(backend, '=SUM(Table1[Bogus])')).toBe('#REF!')
    expect(await evalFormula(backend, '=SUM(Table1[#Totals])')).toBe('#REF!')
    expect(await evalFormula(backend, '=SUM(Nope[Q1])')).toBe('#NAME?')
  })

  it('does not fake unsupported forms — they surface #ERROR!, never a value', async () => {
    const backend = await withTable()
    // Combined qualifiers are deferred by the engine grammar as well.
    expect(await evalFormula(backend, '=SUM(Table1[[#Data],[Q1]])')).toBe('#ERROR!')
    // Cross-sheet Table refs are out of the single-sheet evaluator's reach.
    expect(await evalFormula(backend, '=SUM(Table1[Q1])', SHEET2)).toBe('#ERROR!')
    // A multi-cell reference in VALUE context needs spill, which static lacks.
    expect(await evalFormula(backend, '=Table1[Q1]')).toBe('#ERROR!')
  })

  it('a bare Table name is an off-grid CELL reference, not a structured ref', async () => {
    const backend = await withTable()
    // `Table1` is column `TABLE` row 1 — past `XFD`. Both formula parsers read
    // an A1-shaped token as a cell reference regardless of grid bounds, so it
    // evaluates as an empty cell. Pinned against WASM in
    // vnext-table-totals-static-wasm-parity.test.ts, which is what corrected
    // an earlier guess that this should be `#NAME?`.
    expect(await evalFormula(backend, '=SUM(Table1)')).toBe('0')
  })

  it('resolves this-row references from the anchoring cell', async () => {
    const backend = await withTable()
    // G2 sits on the North row (row 1): Q1=120, Q2=180.
    await setFormula(backend, SHEET, 1, 6, '=Table1[@Q1]+Table1[@Q2]')
    expect((await readCell(backend, SHEET, 1, 6))?.displayValue).toBe('300')
    // G3 is the South row (row 2): 80 + 160.
    await setFormula(backend, SHEET, 2, 6, '=Table1[@Q1]+Table1[@Q2]')
    expect((await readCell(backend, SHEET, 2, 6))?.displayValue).toBe('240')
    // `[#This Row]` spans every column of that row; SUM skips the text Region.
    await setFormula(backend, SHEET, 1, 6, '=SUM(Table1[#This Row])')
    expect((await readCell(backend, SHEET, 1, 6))?.displayValue).toBe('1680')
    // `[@]` is the same band written the short way.
    await setFormula(backend, SHEET, 1, 6, '=SUM(Table1[@])')
    expect((await readCell(backend, SHEET, 1, 6))?.displayValue).toBe('1680')
  })

  it('this-row outside the data body is #VALUE!, matching the engine', async () => {
    const backend = await withTable()
    // H1 is on the header row — outside the data band (and outside the Table).
    expect(await evalFormula(backend, '=SUM(Table1[@Q1])')).toBe('#VALUE!')
  })

  it('resolves table-less [Col] / [@Col] from the containing cell', async () => {
    const backend = await withTable()
    // F2 is INSIDE the Table (Total column, North row), so the bare forms
    // resolve their Table from the anchoring cell.
    await setFormula(backend, SHEET, 1, 5, '=[@Q1]+[@Q2]')
    expect((await readCell(backend, SHEET, 1, 5))?.displayValue).toBe('300')
    // A bare (unqualified) column is the whole DATA column, not this row —
    // engine parity with `parse_bare_colref` yielding `TableArea::Data`.
    await setFormula(backend, SHEET, 1, 5, '=SUM([Q1])')
    expect((await readCell(backend, SHEET, 1, 5))?.displayValue).toBe('400')
  })

  it('a table-less reference outside every Table is #VALUE!', async () => {
    const backend = await withTable()
    // H1 belongs to no Table, so there is nothing to resolve `[Q1]` against.
    expect(await evalFormula(backend, '=SUM([Q1])')).toBe('#VALUE!')
    expect(await evalFormula(backend, '=[@Q1]')).toBe('#VALUE!')
  })
})

// Excel Table totals row on the static backend (design-excel-table.md §7,
// parity #32 T6). Semantics mirror `Workbook::set_table_totals_row` /
// `set_table_total_function`: the cell formula IS the fact, so there is no
// second per-column source of truth to drift.
describe('static backend — Table totals row', () => {
  /** The seeded table is A1:F4 — Region/Q1/Q2/Q3/Q4/Total over three data rows. */
  async function withTable(): Promise<Backend> {
    const backend = seededBackend()
    await backend.createTable!({ kind: 'create-table', sheetId: SHEET, range: A1_D4 })
    return backend
  }

  async function tableDescriptor(backend: Backend) {
    const listed = await backend.listTables!({ kind: 'list-tables' })
    return listed.tables[0]
  }

  it('exposes the totals ports (capability witness for UI-core degradation)', () => {
    const backend = seededBackend()
    expect(typeof backend.setTableTotalsRow).toBe('function')
    expect(typeof backend.setTableTotalFunction).toBe('function')
  })

  it('toggling on grows the range, flips hasTotals, and seeds SUM in the last column', async () => {
    const backend = await withTable()
    const toggled = await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
      requestId: 42,
    })
    expect(toggled.applied).toBe(true)
    if (!toggled.applied) throw new Error('expected an applied totals toggle')
    expect(toggled.kind).toBe('table-mutation')
    expect(toggled.name).toBe('Table1')

    const descriptor = await tableDescriptor(backend)
    expect(descriptor.hasTotals).toBe(true)
    expect(descriptor.range).toBe('A1:F5')

    // The default lands in the LAST column (Total) as SUBTOTAL 109 — and the
    // stored formula text is the engine's canonical rendering.
    const totalsCell = await readCell(backend, SHEET, 4, 5)
    expect(totalsCell?.formula).toBe('=SUBTOTAL(109,Table1[Total])')
    expect(totalsCell?.displayValue).toBe('2140') // 840 + 800 + 500
    // Every other totals cell stays blank until a host sets its aggregate.
    expect(await readCell(backend, SHEET, 4, 1)).toBeUndefined()
  })

  it('the totals row is excluded from [#Data] but is exactly [#Totals]', async () => {
    const backend = await withTable()
    await backend.setTableTotalsRow!({ kind: 'set-table-totals-row', name: 'Table1', enabled: true })
    // Q1 still sums the three DATA rows — the grown range did not swallow the
    // totals row into the data band.
    expect(await evalFormula(backend, '=SUM(Table1[Q1])')).toBe('400')
    // #Data covers data rows only: unchanged from the pre-totals value.
    expect(await evalFormula(backend, '=SUM(Table1[#Data])')).toBe('4280')
    // #Totals now resolves (it was #REF! before the toggle) to the totals row.
    expect(await evalFormula(backend, '=SUM(Table1[#Totals])')).toBe('2140')
    // #All spans header + data + totals.
    expect(await evalFormula(backend, '=SUM(Table1[#All])')).toBe('6420')
  })

  it('setTableTotalFunction writes each aggregate as a 101-111 SUBTOTAL', async () => {
    const backend = await withTable()
    await backend.setTableTotalsRow!({ kind: 'set-table-totals-row', name: 'Table1', enabled: true })

    const cases: Array<[string, number, string]> = [
      ['sum', 109, '400'],
      ['average', 101, '133.333333'],
      ['count', 103, '3'],
      ['countNums', 102, '3'],
      ['max', 104, '200'],
      ['min', 105, '80'],
      ['var', 110, '3733.333333'],
    ]
    for (const [func, code, expected] of cases) {
      const result = await backend.setTableTotalFunction!({
        kind: 'set-table-total-function',
        name: 'Table1',
        column: 'Q1',
        func: func as never,
      })
      expect(result.applied).toBe(true)
      const cell = await readCell(backend, SHEET, 4, 1)
      expect(cell?.formula).toBe(`=SUBTOTAL(${code},Table1[Q1])`)
      expect(cell?.displayValue).toBe(expected)
    }

    // stdDev is the square root of the sample variance above.
    await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Q1',
      func: 'stdDev',
    })
    const stdDev = await readCell(backend, SHEET, 4, 1)
    expect(stdDev?.formula).toBe('=SUBTOTAL(107,Table1[Q1])')
    expect(Number(stdDev?.displayValue)).toBeCloseTo(Math.sqrt(3733.333333), 4)

    // 'none' clears the totals cell entirely.
    await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Q1',
      func: 'none',
    })
    expect(await readCell(backend, SHEET, 4, 1)).toBeUndefined()
  })

  it('a totals aggregate recomputes when its data changes', async () => {
    const backend = await withTable()
    await backend.setTableTotalsRow!({ kind: 'set-table-totals-row', name: 'Table1', enabled: true })
    await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Q1',
      func: 'sum',
    })
    expect((await readCell(backend, SHEET, 4, 1))?.displayValue).toBe('400')

    // North's Q1 120 → 500.
    await setFormula(backend, SHEET, 1, 1, '500')
    expect((await readCell(backend, SHEET, 4, 1))?.displayValue).toBe('780')
  })

  it('toggling off clears every totals cell and shrinks the range back', async () => {
    const backend = await withTable()
    await backend.setTableTotalsRow!({ kind: 'set-table-totals-row', name: 'Table1', enabled: true })
    await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Q1',
      func: 'sum',
    })

    const off = await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: false,
    })
    expect(off.applied).toBe(true)

    const descriptor = await tableDescriptor(backend)
    expect(descriptor.hasTotals).toBe(false)
    expect(descriptor.range).toBe('A1:F4')
    // Both the seeded default AND the host-set aggregate are gone.
    expect(await readCell(backend, SHEET, 4, 1)).toBeUndefined()
    expect(await readCell(backend, SHEET, 4, 5)).toBeUndefined()
    // `[#Totals]` is unresolvable again.
    expect(await evalFormula(backend, '=SUM(Table1[#Totals])')).toBe('#REF!')
  })

  it('rejects totals-row-blocked when the row below is occupied, changing nothing', async () => {
    const backend = await withTable()
    await setFormula(backend, SHEET, 4, 0, 'blocker')

    const rejected = await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
      requestId: 7,
    })
    expect(rejected.applied).toBe(false)
    if (rejected.applied) throw new Error('expected a rejected totals toggle')
    expect(rejected.kind).toBe('table-mutation-not-applied')
    expect(rejected.code).toBe('totals-row-blocked')

    const descriptor = await tableDescriptor(backend)
    expect(descriptor.hasTotals).toBe(false)
    expect(descriptor.range).toBe('A1:F4')
    // The blocker was never overwritten or pushed down.
    expect((await readCell(backend, SHEET, 4, 0))?.displayValue).toBe('blocker')
  })

  it('gates setTableTotalFunction: unknown id, no totals row, unknown column, unknown table', async () => {
    const backend = await withTable()

    const noRow = await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Q1',
      func: 'sum',
    })
    expect(noRow.applied).toBe(false)
    if (noRow.applied) throw new Error('expected a rejected totals function')
    expect(noRow.code).toBe('no-totals-row')

    // The aggregate id is validated first, so it outranks `no-totals-row` —
    // same gate order as the WASM binding.
    const badId = await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Q1',
      func: 'bogus' as never,
    })
    expect(badId.applied).toBe(false)
    if (badId.applied) throw new Error('expected a rejected totals function')
    expect(badId.code).toBe('invalid-totals-function')

    await backend.setTableTotalsRow!({ kind: 'set-table-totals-row', name: 'Table1', enabled: true })
    const badColumn = await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Nope',
      func: 'sum',
    })
    expect(badColumn.applied).toBe(false)
    if (badColumn.applied) throw new Error('expected a rejected totals function')
    expect(badColumn.code).toBe('column-not-found')

    const badTable = await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Nope',
      column: 'Q1',
      func: 'sum',
    })
    expect(badTable.applied).toBe(false)
    if (badTable.applied) throw new Error('expected a rejected totals function')
    expect(badTable.code).toBe('not-found')
  })

  it('is idempotent per state, and unknown tables reject not-found', async () => {
    const backend = await withTable()
    const first = await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
    })
    expect(first.applied).toBe(true)
    // Enabling again is a successful no-op — the range does not grow twice.
    const again = await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Table1',
      enabled: true,
    })
    expect(again.applied).toBe(true)
    expect((await tableDescriptor(backend)).range).toBe('A1:F5')

    const missing = await backend.setTableTotalsRow!({
      kind: 'set-table-totals-row',
      name: 'Nope',
      enabled: true,
    })
    expect(missing.applied).toBe(false)
    if (missing.applied) throw new Error('expected a rejected totals toggle')
    expect(missing.code).toBe('not-found')
  })

  it('a totals formula follows a Table rename and a column rename', async () => {
    const backend = await withTable()
    await backend.setTableTotalsRow!({ kind: 'set-table-totals-row', name: 'Table1', enabled: true })
    await backend.setTableTotalFunction!({
      kind: 'set-table-total-function',
      name: 'Table1',
      column: 'Q1',
      func: 'sum',
    })

    await backend.renameTableColumn!({
      kind: 'rename-table-column',
      name: 'Table1',
      oldColumn: 'Q1',
      newColumn: 'Quarter1',
    })
    await backend.renameTable!({ kind: 'rename-table', name: 'Table1', newName: 'Sales' })

    const cell = await readCell(backend, SHEET, 4, 1)
    expect(cell?.formula).toBe('=SUBTOTAL(109,Sales[Quarter1])')
    expect(cell?.displayValue).toBe('400')
  })
})

// SUBTOTAL is what makes the totals row work, so its own semantics are pinned
// here against the engine `run_subtotal` arms (rust/excel-core/src/eval.rs).
describe('static backend — SUBTOTAL semantics', () => {
  function subtotalBackend() {
    return createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [{ id: SHEET, name: 'Sales' }],
      // A1:A6 — numbers, a blank, and a text value.
      matrix: [[10], [20], ['text'], [30], [], [40]],
    })
  }

  async function evalAt(backend: Backend, input: string): Promise<string> {
    await backend.setCellInput({ kind: 'set-cell-input', sheetId: SHEET, row: 0, col: 3, input })
    return (await readCell(backend, SHEET, 0, 3))?.displayValue ?? ''
  }

  it('implements every function number, skipping blanks and text like the engine', async () => {
    const backend = subtotalBackend()
    expect(await evalAt(backend, '=SUBTOTAL(9,A1:A6)')).toBe('100') // SUM
    expect(await evalAt(backend, '=SUBTOTAL(1,A1:A6)')).toBe('25') // AVERAGE
    expect(await evalAt(backend, '=SUBTOTAL(2,A1:A6)')).toBe('4') // COUNT (numbers)
    expect(await evalAt(backend, '=SUBTOTAL(3,A1:A6)')).toBe('5') // COUNTA (+ text)
    expect(await evalAt(backend, '=SUBTOTAL(4,A1:A6)')).toBe('40') // MAX
    expect(await evalAt(backend, '=SUBTOTAL(5,A1:A6)')).toBe('10') // MIN — a blank must not sink it
    expect(await evalAt(backend, '=SUBTOTAL(6,A1:A6)')).toBe('240000') // PRODUCT
  })

  it('101-111 mirror 1-11 when nothing is hidden', async () => {
    const backend = subtotalBackend()
    for (const [visible, hiddenBand] of [
      [1, 101],
      [2, 102],
      [3, 103],
      [4, 104],
      [5, 105],
      [9, 109],
    ]) {
      expect(await evalAt(backend, `=SUBTOTAL(${hiddenBand},A1:A6)`)).toBe(
        await evalAt(backend, `=SUBTOTAL(${visible},A1:A6)`),
      )
    }
  })

  it('101-111 exclude host-hidden rows; 1-11 are undisturbed by them', async () => {
    const backend = subtotalBackend()
    // Hide row 1 (A2 = 20) and row 5 (A6 = 40).
    await backend.hideRows!({ kind: 'hide-rows', sheetId: SHEET, rowIndices: [1, 5] })
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('40') // 10 + 30
    expect(await evalAt(backend, '=SUBTOTAL(9,A1:A6)')).toBe('100') // unchanged
    expect(await evalAt(backend, '=SUBTOTAL(102,A1:A6)')).toBe('2')
    expect(await evalAt(backend, '=SUBTOTAL(104,A1:A6)')).toBe('30')
  })

  // `setEvalHiddenRows` is the hidden lane the ENGINE offers (the WASM backend
  // exposes no `hideRows` at all), so the static host must honour it too or a
  // host driving only that lane silently loses the exclusion.
  it('101-111 exclude rows pushed through setEvalHiddenRows alone', async () => {
    const backend = subtotalBackend()
    backend.setEvalHiddenRows!({ kind: 'set-eval-hidden-rows', sheetId: SHEET, rows: [1, 5] })
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('40') // 10 + 30
    expect(await evalAt(backend, '=SUBTOTAL(9,A1:A6)')).toBe('100') // unchanged
    expect(await evalAt(backend, '=SUBTOTAL(102,A1:A6)')).toBe('2')
  })

  it('unions the pushed eval set with the manually hidden rows', async () => {
    const backend = subtotalBackend()
    await backend.hideRows!({ kind: 'hide-rows', sheetId: SHEET, rowIndices: [1] }) // A2 = 20
    // A6 = 40
    backend.setEvalHiddenRows!({ kind: 'set-eval-hidden-rows', sheetId: SHEET, rows: [5] })
    // Neither lane alone would drop both rows.
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('40') // 10 + 30
  })

  it('setEvalHiddenRows is a whole-set REPLACE and an empty push clears it', async () => {
    const backend = subtotalBackend()
    backend.setEvalHiddenRows!({ kind: 'set-eval-hidden-rows', sheetId: SHEET, rows: [1, 5] })
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('40')
    // REPLACE, not merge: row 1 comes back, row 3 goes away.
    backend.setEvalHiddenRows!({ kind: 'set-eval-hidden-rows', sheetId: SHEET, rows: [3] })
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('70') // 10 + 20 + 40
    backend.setEvalHiddenRows!({ kind: 'set-eval-hidden-rows', sheetId: SHEET, rows: [] })
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('100')
  })

  it('scopes the pushed set per sheet and ignores rows outside the reference', async () => {
    const backend = subtotalBackend()
    backend.setEvalHiddenRows!({ kind: 'set-eval-hidden-rows', sheetId: 'other-sheet', rows: [1] })
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('100')
    // Row 99 is not in A1:A6 — membership-only, so it is simply never met.
    backend.setEvalHiddenRows!({ kind: 'set-eval-hidden-rows', sheetId: SHEET, rows: [99] })
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('100')
  })

  // MIGRATED from `does not treat filter-hidden rows as an evaluation truth
  // source` (#27 S4). That test pinned the OLD, non-Excel behaviour: it
  // asserted 100 for both bands under an active filter, i.e. the evaluator
  // summing rows the filter had removed. Excel excludes filter-hidden rows
  // from BOTH bands (`design-filter-hidden-rows` §2), so the old assertion
  // was pinning a bug — the deferral it cited ("filter visibility joins the
  // manual set after the #29 flip") was itself the wrong shape, since the two
  // sources must stay separate to express the 1-11 rule at all.
  it('excludes filter-hidden rows from BOTH SUBTOTAL bands', async () => {
    const backend = subtotalBackend()
    // Control: no filter, nothing excluded — the counter-value that made the
    // assertion below meaningful rather than trivially true.
    expect(await evalAt(backend, '=SUBTOTAL(9,A1:A6)')).toBe('100')

    // `>= 30` keeps source rows 3 (30) and 5 (40); rows 1 (20), 2 ('text') and
    // 4 (blank) are filtered out. Row 0 is the header and is never filtered.
    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'range', colIndex: 0, min: 30 }],
    })
    expect(await evalAt(backend, '=SUBTOTAL(9,A1:A6)')).toBe('80') // 10 + 30 + 40
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('80')
    expect(await evalAt(backend, '=SUBTOTAL(2,A1:A6)')).toBe('3')
    expect(await evalAt(backend, '=SUBTOTAL(5,A1:A6)')).toBe('10')

    // Clearing the rules restores the full aggregate — the derived set is
    // dropped, not left stale.
    await backend.setFilterSort!({ kind: 'set-filter-sort', sheetId: SHEET, rules: [] })
    expect(await evalAt(backend, '=SUBTOTAL(9,A1:A6)')).toBe('100')
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('100')
  })

  // The two-layer rule, which is the entire reason the sets are not merged:
  // a manually hidden row stays IN 1-11 while a filter-hidden row leaves both.
  it('keeps manual and filter exclusion independent (Excel two-layer rule)', async () => {
    const backend = subtotalBackend()
    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'range', colIndex: 0, min: 30 }],
    })
    // Additionally hide source row 5 (A6 = 40) BY HAND.
    await backend.hideRows!({ kind: 'hide-rows', sheetId: SHEET, rowIndices: [5] })

    // 1-11: filter rows gone, the manual row still counted.
    expect(await evalAt(backend, '=SUBTOTAL(9,A1:A6)')).toBe('80') // 10 + 30 + 40
    // 101-111: both sources gone.
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('40') // 10 + 30

    // A row in BOTH sets is skipped once, not twice (membership, not counting).
    await backend.hideRows!({ kind: 'hide-rows', sheetId: SHEET, rowIndices: [1] })
    expect(await evalAt(backend, '=SUBTOTAL(9,A1:A6)')).toBe('80')
    expect(await evalAt(backend, '=SUBTOTAL(109,A1:A6)')).toBe('40')
  })

  it('rejects out-of-band function numbers and short arg lists', async () => {
    const backend = subtotalBackend()
    expect(await evalAt(backend, '=SUBTOTAL(12,A1:A6)')).toBe('#VALUE!')
    expect(await evalAt(backend, '=SUBTOTAL(0,A1:A6)')).toBe('#VALUE!')
    expect(await evalAt(backend, '=SUBTOTAL(112,A1:A6)')).toBe('#VALUE!')
    expect(await evalAt(backend, '=SUBTOTAL(9)')).toBe('#ARGS!')
  })
})
