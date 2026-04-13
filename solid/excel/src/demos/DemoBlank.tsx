/** @jsxImportSource solid-js */
import { WorkbookView } from '../WorkbookView'
import { createJSWorkbook } from '../js-workbook'
import { createWorkbookStore } from '../workbook-store'

export function DemoBlank() {
  const store = createWorkbookStore(createJSWorkbook({ sheets: [{ name: 'Sheet1', rows: 20, cols: 10 }] }))

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>Blank Spreadsheet</h3>
        <p class="demo-desc">
          Double-click any cell to edit. Type a number, text, or formula (start with <code>=</code>).
          Use the bottom sheet tabs, right-click headers for structure edits, and drag header edges to resize.
        </p>
      </div>
      <WorkbookView store={store} />
    </div>
  )
}
