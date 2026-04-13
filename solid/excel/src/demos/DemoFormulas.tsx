/** @jsxImportSource solid-js */
import { WorkbookView } from '../WorkbookView'
import { createJSWorkbook } from '../js-workbook'
import { createWorkbookStore } from '../workbook-store'

export function DemoFormulas() {
  const store = createWorkbookStore(createJSWorkbook({
    sheets: [
      { name: 'Sheet1', rows: 18, cols: 11 },
      { name: 'Sheet2', rows: 8, cols: 4 },
    ],
  }))

  store.setText('A1', 'Arithmetic')
  store.setText('A2', 'a')
  store.setText('B2', 'b')
  store.setText('C2', 'a + b')
  store.setText('D2', 'a * b')
  store.setText('E2', 'a / b')
  store.setText('F2', '(a+b)*2')

  store.setNumber('A3', 10)
  store.setNumber('B3', 3)
  store.setFormula('C3', '=A3+B3')
  store.setFormula('D3', '=A3*B3')
  store.setFormula('E3', '=A3/B3')
  store.setFormula('F3', '=(A3+B3)*2')

  store.setNumber('A4', 100)
  store.setNumber('B4', 0)
  store.setFormula('C4', '=A4+B4')
  store.setFormula('D4', '=A4*B4')
  store.setFormula('E4', '=A4/B4')
  store.setFormula('F4', '=(A4+B4)*2')

  store.setText('A6', 'Functions')
  store.setText('A7', 'Data')
  store.setNumber('A8', 85)
  store.setNumber('A9', 92)
  store.setNumber('A10', 78)
  store.setNumber('A11', 95)
  store.setNumber('A12', 60)

  store.setText('C7', 'Function')
  store.setText('D7', 'Result')
  store.setText('C8', 'SUM')
  store.setFormula('D8', '=SUM(A8,A9,A10,A11,A12)')
  store.setText('C9', 'AVERAGE')
  store.setFormula('D9', '=AVERAGE(A8,A9,A10,A11,A12)')
  store.setText('C10', 'COUNT')
  store.setFormula('D10', '=COUNT(A8,A9,A10,A11,A12)')
  store.setText('C11', 'MIN')
  store.setFormula('D11', '=MIN(A8,A9,A10,A11,A12)')
  store.setText('C12', 'MAX')
  store.setFormula('D12', '=MAX(A8,A9,A10,A11,A12)')

  store.setText('A14', 'IF Condition')
  store.setText('A15', 'Score')
  store.setText('B15', 'Pass?')
  store.setNumber('A16', 85)
  store.setFormula('B16', '=IF(A16,1,0)')
  store.setNumber('A17', 0)
  store.setFormula('B17', '=IF(A17,1,0)')

  store.setText('F6', 'Chain')
  store.setText('F7', 'Base')
  store.setText('G7', 'x2')
  store.setText('H7', 'x2+10')
  store.setText('I7', 'Final*3')
  store.setNumber('F8', 5)
  store.setFormula('G8', '=F8*2')
  store.setFormula('H8', '=G8+10')
  store.setFormula('I8', '=H8*3')

  store.setText('J2', 'Cross Sheet')
  store.setText('J3', 'Sheet2!A1')

  store.setActiveSheet(1)
  store.setText('A1', 'Remote Seed')
  store.setNumber('A2', 144)
  store.setActiveSheet(0)
  store.setFormula('K3', '=Sheet2!A2')

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>Formula Showcase</h3>
        <p class="demo-desc">
          Arithmetic, functions, chains, and a visible <code>=Sheet2!A2</code> cross-sheet reference all live here.
          Try header right-click actions, freezing, and sheet tabs while formulas stay reactive.
        </p>
      </div>
      <WorkbookView store={store} />
    </div>
  )
}
