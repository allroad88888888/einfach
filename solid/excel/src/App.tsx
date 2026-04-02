import { Table } from './Table'
import { createSheetStore } from './sheet-store'
import { createJSSheet } from './js-sheet'
import './styles.css'

/**
 * Demo app: renders a spreadsheet table with some initial data.
 * Uses the pure JS sheet backend for development.
 * In production, replace createJSSheet() with the WasmSheet instance.
 */
export function App() {
  const sheet = createJSSheet()
  const store = createSheetStore(sheet)

  // Set some demo data
  store.setNumber('A1', 100)
  store.setNumber('A2', 200)
  store.setNumber('A3', 300)
  store.setText('B1', 'Revenue')
  store.setText('B2', 'Cost')
  store.setText('B3', 'Profit')
  store.setFormula('A4', '=A1-A2')
  store.setText('B4', 'Net')
  store.setFormula('C1', '=SUM(A1:A3)')
  store.setText('D1', 'Total')

  return (
    <div style={{ padding: '20px' }}>
      <h2 style={{ 'font-family': 'sans-serif', 'margin-bottom': '10px' }}>
        Einfach Excel
      </h2>
      <Table store={store} rows={20} cols={10} />
    </div>
  )
}
