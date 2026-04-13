/** @jsxImportSource solid-js */
import { WorkbookView } from '../WorkbookView'
import { createJSWorkbook } from '../js-workbook'
import { createWorkbookStore } from '../workbook-store'

export function DemoGrades() {
  const store = createWorkbookStore(createJSWorkbook({ sheets: [{ name: 'Sheet1', rows: 14, cols: 8 }] }))

  store.setText('A1', 'Student')
  store.setText('B1', 'Math')
  store.setText('C1', 'English')
  store.setText('D1', 'Science')
  store.setText('E1', 'Average')
  store.setText('F1', 'Max')
  store.setText('G1', 'Min')

  const students = [
    ['Alice', 92, 88, 95],
    ['Bob', 78, 85, 72],
    ['Charlie', 95, 92, 98],
    ['Diana', 63, 70, 68],
    ['Eve', 88, 91, 85],
    ['Frank', 45, 52, 48],
    ['Grace', 100, 97, 99],
    ['Henry', 72, 68, 75],
  ] as const

  students.forEach(([name, math, eng, sci], index) => {
    const row = index + 2
    store.setText(`A${row}`, name)
    store.setNumber(`B${row}`, math)
    store.setNumber(`C${row}`, eng)
    store.setNumber(`D${row}`, sci)
    store.setFormula(`E${row}`, `=AVERAGE(B${row},C${row},D${row})`)
    store.setFormula(`F${row}`, `=MAX(B${row},C${row},D${row})`)
    store.setFormula(`G${row}`, `=MIN(B${row},C${row},D${row})`)
  })

  store.setText('A10', '--- Summary ---')
  store.setText('A11', 'Class Avg')
  store.setFormula('B11', '=AVERAGE(B2,B3,B4,B5,B6,B7,B8,B9)')
  store.setFormula('C11', '=AVERAGE(C2,C3,C4,C5,C6,C7,C8,C9)')
  store.setFormula('D11', '=AVERAGE(D2,D3,D4,D5,D6,D7,D8,D9)')
  store.setText('A12', 'Highest')
  store.setFormula('B12', '=MAX(B2,B3,B4,B5,B6,B7,B8,B9)')
  store.setFormula('C12', '=MAX(C2,C3,C4,C5,C6,C7,C8,C9)')
  store.setFormula('D12', '=MAX(D2,D3,D4,D5,D6,D7,D8,D9)')
  store.setText('A13', 'Lowest')
  store.setFormula('B13', '=MIN(B2,B3,B4,B5,B6,B7,B8,B9)')
  store.setFormula('C13', '=MIN(C2,C3,C4,C5,C6,C7,C8,C9)')
  store.setFormula('D13', '=MIN(D2,D3,D4,D5,D6,D7,D8,D9)')
  store.setText('A14', 'Count')
  store.setFormula('B14', '=COUNT(B2,B3,B4,B5,B6,B7,B8,B9)')

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>Grade Calculator</h3>
        <p class="demo-desc">
          Student averages and class summaries now sit inside a workbook shell, so you can test row insertion and undo/redo on a denser grid.
        </p>
      </div>
      <WorkbookView store={store} />
    </div>
  )
}
