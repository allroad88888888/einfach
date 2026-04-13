/** @jsxImportSource solid-js */
import { WorkbookView } from '../WorkbookView'
import { createJSWorkbook } from '../js-workbook'
import { createWorkbookStore } from '../workbook-store'

export function DemoSales() {
  const store = createWorkbookStore(createJSWorkbook({ sheets: [{ name: 'Sheet1', rows: 11, cols: 9 }] }))

  store.setText('A1', 'Q1 Sales Report')
  store.setText('A3', 'Month')
  store.setText('B3', 'Product A')
  store.setText('C3', 'Product B')
  store.setText('D3', 'Product C')
  store.setText('E3', 'Total')
  store.setText('A4', 'January')
  store.setNumber('B4', 12000)
  store.setNumber('C4', 8500)
  store.setNumber('D4', 5200)
  store.setFormula('E4', '=SUM(B4,C4,D4)')
  store.setText('A5', 'February')
  store.setNumber('B5', 15000)
  store.setNumber('C5', 9200)
  store.setNumber('D5', 6800)
  store.setFormula('E5', '=SUM(B5,C5,D5)')
  store.setText('A6', 'March')
  store.setNumber('B6', 18000)
  store.setNumber('C6', 11000)
  store.setNumber('D6', 7500)
  store.setFormula('E6', '=SUM(B6,C6,D6)')
  store.setText('A8', 'Q1 Total')
  store.setFormula('B8', '=SUM(B4,B5,B6)')
  store.setFormula('C8', '=SUM(C4,C5,C6)')
  store.setFormula('D8', '=SUM(D4,D5,D6)')
  store.setFormula('E8', '=SUM(E4,E5,E6)')
  store.setText('A9', 'Q1 Average')
  store.setFormula('B9', '=AVERAGE(B4,B5,B6)')
  store.setFormula('C9', '=AVERAGE(C4,C5,C6)')
  store.setFormula('D9', '=AVERAGE(D4,D5,D6)')
  store.setFormula('E9', '=AVERAGE(E4,E5,E6)')
  store.setText('G3', 'KPI Dashboard')
  store.setText('G4', 'Total Revenue')
  store.setFormula('H4', '=E8')
  store.setText('G5', 'Best Month')
  store.setFormula('H5', '=MAX(E4,E5,E6)')
  store.setText('G6', 'Worst Month')
  store.setFormula('H6', '=MIN(E4,E5,E6)')
  store.setText('G7', 'Top Product Q1')
  store.setFormula('H7', '=MAX(B8,C8,D8)')
  store.setText('G9', 'Growth Feb vs Jan')
  store.setFormula('H9', '=(E5-E4)/E4*100')
  store.setText('G10', 'Growth Mar vs Feb')
  store.setFormula('H10', '=(E6-E5)/E5*100')

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>Sales Dashboard</h3>
        <p class="demo-desc">
          Quarterly totals, KPI cells, and growth formulas stay live while you resize columns or reshape the report from the headers.
        </p>
      </div>
      <WorkbookView persistenceKey="einfach-excel-demo-sales" store={store} />
    </div>
  )
}
