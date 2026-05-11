
import { onCleanup } from 'solid-js'
import { Table } from '../Table'
import { createSheetStore, type SheetStore } from '../sheet-store'
import { createJSSheet } from '../js-sheet'

/**
 * Debug-only: when the page URL has `?debug=1`, stash the active
 * SheetStore on `window.__einfachStore` so e2e specs (regression.spec.ts)
 * can introspect via `page.evaluate(() => window.__einfachStore.subscriberFireCount('A1'))`.
 * Cleared on unmount so navigating between demos doesn't leak. Off in
 * normal use (the property never exists).
 */
declare global {
  interface Window {
    __einfachStore?: SheetStore
  }
}

function exposeStoreForDebug(store: SheetStore) {
  if (typeof window === 'undefined') return
  const debug = new URLSearchParams(window.location.search).get('debug')
  if (debug !== '1' && debug !== 'render') return
  window.__einfachStore = store
  onCleanup(() => {
    if (window.__einfachStore === store) {
      delete window.__einfachStore
    }
  })
}

/**
 * Demo 1: 空白表格
 */
export function DemoBlank() {
  const store = createSheetStore(createJSSheet())
  exposeStoreForDebug(store)

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>Blank Spreadsheet</h3>
        <p class="demo-desc">
          Double-click any cell to edit. Type a number, text, or formula (start with <code>=</code>).
          Press <kbd>Enter</kbd> to confirm, <kbd>Esc</kbd> to cancel.
        </p>
      </div>
      <Table store={store} rows={20} cols={10} formulaBar toolbar />
    </div>
  )
}
