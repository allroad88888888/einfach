
import { Table } from '../Table'
import { createSheetStore } from '../sheet-store'
import { createJSSheet } from '../js-sheet'

/**
 * Demo 3: 月度预算模板
 */
export function DemoBudget() {
  const store = createSheetStore(createJSSheet())

  // 表头
  store.setText('A1', 'Category')
  store.setText('B1', 'Budget')
  store.setText('C1', 'Actual')
  store.setText('D1', 'Diff')

  // 收入
  store.setText('A2', '--- INCOME ---')
  store.setText('A3', 'Salary')
  store.setNumber('B3', 8000)
  store.setNumber('C3', 8000)
  store.setFormula('D3', '=C3-B3')

  store.setText('A4', 'Freelance')
  store.setNumber('B4', 2000)
  store.setNumber('C4', 2500)
  store.setFormula('D4', '=C4-B4')

  store.setText('A5', 'Total Income')
  store.setFormula('B5', '=SUM(B3,B4)')
  store.setFormula('C5', '=SUM(C3,C4)')
  store.setFormula('D5', '=C5-B5')

  // 支出
  store.setText('A7', '--- EXPENSES ---')
  store.setText('A8', 'Rent')
  store.setNumber('B8', 2500)
  store.setNumber('C8', 2500)
  store.setFormula('D8', '=C8-B8')

  store.setText('A9', 'Food')
  store.setNumber('B9', 1200)
  store.setNumber('C9', 1450)
  store.setFormula('D9', '=C9-B9')

  store.setText('A10', 'Transport')
  store.setNumber('B10', 500)
  store.setNumber('C10', 380)
  store.setFormula('D10', '=C10-B10')

  store.setText('A11', 'Utilities')
  store.setNumber('B11', 300)
  store.setNumber('C11', 320)
  store.setFormula('D11', '=C11-B11')

  store.setText('A12', 'Entertainment')
  store.setNumber('B12', 600)
  store.setNumber('C12', 850)
  store.setFormula('D12', '=C12-B12')

  store.setText('A13', 'Savings')
  store.setNumber('B13', 2000)
  store.setNumber('C13', 1500)
  store.setFormula('D13', '=C13-B13')

  store.setText('A14', 'Total Expenses')
  store.setFormula('B14', '=SUM(B8,B9,B10,B11,B12,B13)')
  store.setFormula('C14', '=SUM(C8,C9,C10,C11,C12,C13)')
  store.setFormula('D14', '=C14-B14')

  // 汇总
  store.setText('A16', '=== NET ===')
  store.setFormula('B16', '=B5-B14')
  store.setFormula('C16', '=C5-C14')
  store.setFormula('D16', '=C16-B16')

  // 统计
  store.setText('F1', 'Stats')
  store.setText('F2', 'Max Expense')
  store.setFormula('G2', '=MAX(C8,C9,C10,C11,C12,C13)')
  store.setText('F3', 'Min Expense')
  store.setFormula('G3', '=MIN(C8,C9,C10,C11,C12,C13)')
  store.setText('F4', 'Avg Expense')
  store.setFormula('G4', '=AVERAGE(C8,C9,C10,C11,C12,C13)')
  store.setText('F5', 'Saving Rate')
  store.setFormula('G5', '=C13/C5*100')

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>Monthly Budget</h3>
        <p class="demo-desc">
          Edit the <strong>Budget</strong> (B) and <strong>Actual</strong> (C) columns.
          The <strong>Diff</strong> column and summary rows update automatically.
          Positive diff = under budget, negative = over budget.
        </p>
      </div>
      <Table store={store} rows={17} cols={8} />
    </div>
  )
}
