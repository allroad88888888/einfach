
import { Table } from '../Table'
import { createSheetStore } from '../sheet-store'
import { createJSSheet } from '../js-sheet'

/**
 * Demo 1: 空白表格
 */
export function DemoBlank() {
  const store = createSheetStore(createJSSheet())

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>Blank Spreadsheet</h3>
        <p class="demo-desc">
          Double-click any cell to edit. Type a number, text, or formula (start with <code>=</code>).
          Press <kbd>Enter</kbd> to confirm, <kbd>Esc</kbd> to cancel.
        </p>
      </div>
      <Table store={store} rows={20} cols={10} />
    </div>
  )
}
