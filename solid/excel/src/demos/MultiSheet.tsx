
import { Show } from 'solid-js'
import { Table } from '../Table'
import { SheetTabs } from '../SheetTabs'
import { createWorkbookStore } from '../workbook-store'

/**
 * Demo 6: Multi-sheet workbook with a tab bar.
 *
 * Backed by `createWorkbookStore()` — a JS-side mock of the Rust
 * `Workbook` API. The Rust `WasmWorkbook` binding is NOT wired yet;
 * this demo deliberately uses the JS mock so the multi-sheet UI shape
 * can land independent of WASM scope.
 *
 * KNOWN GAP: cross-sheet formulas (e.g. `=Sheet2!A1`) do NOT evaluate.
 * The mock evaluator (`createJSSheet`) is single-sheet — each sheet
 * has no view into the workbook's other sheets. This is fixed when
 * the WASM workbook binding lands. See `rust/docs/TODO.md` 1.5.
 */
export function MultiSheet() {
  const wb = createWorkbookStore()

  // Seed the default sheet with sample data.
  const sheet1 = wb.activeStore()
  sheet1.setText('A1', 'Quarter')
  sheet1.setText('B1', 'Revenue')
  sheet1.setText('C1', 'Profit')
  sheet1.setText('A2', 'Q1')
  sheet1.setNumber('B2', 12000)
  sheet1.setNumber('C2', 3200)
  sheet1.setText('A3', 'Q2')
  sheet1.setNumber('B3', 14500)
  sheet1.setNumber('C3', 4100)
  sheet1.setText('A4', 'Q3')
  sheet1.setNumber('B4', 11800)
  sheet1.setNumber('C4', 2900)
  sheet1.setText('A5', 'Total')
  sheet1.setFormula('B5', '=B2+B3+B4')
  sheet1.setFormula('C5', '=C2+C3+C4')

  // Sheet 2 — Expenses.
  const idx2 = wb.addSheet('Expenses')
  const sheet2 = wb.sheetAt(idx2)!
  sheet2.setText('A1', 'Category')
  sheet2.setText('B1', 'Amount')
  sheet2.setText('A2', 'Rent')
  sheet2.setNumber('B2', 2500)
  sheet2.setText('A3', 'Salaries')
  sheet2.setNumber('B3', 8000)
  sheet2.setText('A4', 'Marketing')
  sheet2.setNumber('B4', 1200)
  sheet2.setText('A5', 'Total')
  sheet2.setFormula('B5', '=B2+B3+B4')

  // Sheet 3 — Notes / scratch.
  const idx3 = wb.addSheet('Notes')
  const sheet3 = wb.sheetAt(idx3)!
  sheet3.setText('A1', 'Try editing each sheet — switching tabs preserves state.')
  sheet3.setText('A2', 'Right-click a tab to rename or delete it.')
  sheet3.setText('A3', 'Click + to add a new sheet.')
  sheet3.setText('A5', 'Note: cross-sheet formulas (e.g. =Expenses!B5) do NOT')
  sheet3.setText('A6', 'work yet — the JS mock is single-sheet. WASM workbook')
  sheet3.setText('A7', 'binding is the next step. See rust/docs/TODO.md 1.5.')

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>Multi-Sheet Workbook</h3>
        <p class="demo-desc">
          Click a tab to switch sheets. Click <code>+</code> to add a new
          sheet. Right-click a tab for rename / delete. Each sheet has
          independent state, undo, and selection.
        </p>
      </div>
      {/*
        Re-mount Table when the active sheet changes. Two reasons we
        prefer keyed re-mount over a live prop swap here:
          1. Cell components hold local edit state (editing / editValue
             signals). Swapping the store under them would leak edit
             state across sheets — the user would see "currently typing
             into A1 of Sheet1" when they hit the Expenses tab.
          2. Each SheetStore has its own per-cell signal handles; a
             clean re-mount lets old Cell computations dispose and new
             ones subscribe to the active sheet's signals fresh, which
             is the simplest correctness story.
        The previous SheetStore stays alive (the workbook holds it), so
        switching back is cheap — just a fresh Table component tree.
      */}
      {/*
        keyed on the +1-shifted active idx so idx 0 is still truthy AND
        the key changes by value equality on every active-sheet swap.
        Solid's `<Show keyed>` re-mounts children whenever the `when`
        value changes — for primitives that's value equality.
      */}
      <Show when={wb.activeIdx() + 1} keyed>
        {(_key) => <Table store={wb.activeStore()} rows={20} cols={10} formulaBar />}
      </Show>
      <SheetTabs workbook={wb} />
    </div>
  )
}
