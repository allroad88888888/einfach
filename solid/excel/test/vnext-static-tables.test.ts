import { describe, expect, it } from '@jest/globals'
import { createRangeProjectionRequest, type DisplayCell } from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'

// Static-backend Excel Table CRUD + structured-reference evaluation
// (design-excel-table.md §4/§5, parity #32). The static backend owns the
// Table registry directly and resolves `Table[...]` references at eval time.
//
// Structured-reference support in static (honest boundary — no faked values):
//   supported (as function args): `Table1[Col]`, `Table1[[A]:[B]]`,
//   `Table1[#All|#Data|#Headers|#Totals]`; unknown table → `#NAME?`, unknown
//   column / missing totals row → `#REF!`. NOT supported (→ `#ERROR!`): bare
//   `Table1`, bare `[Col]`, `[@Col]`, combined specs, cross-sheet Table refs.

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
    // this-row (@) needs current-cell context the static evaluator lacks.
    expect(await evalFormula(backend, '=SUM(Table1[@Q1])')).toBe('#ERROR!')
    // combined `[[#Data],[Col]]` is deferred.
    expect(await evalFormula(backend, '=SUM(Table1[[#Data],[Q1]])')).toBe('#ERROR!')
    // cross-sheet Table refs are out of the single-sheet evaluator's reach.
    expect(await evalFormula(backend, '=SUM(Table1[Q1])', SHEET2)).toBe('#ERROR!')
  })
})
