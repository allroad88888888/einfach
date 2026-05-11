
import { Show, createResource } from 'solid-js'
import { Table } from '../Table'
import { createSheetStore, type SheetStore } from '../sheet-store'
import { createWasmSheet } from '../wasm-sheet'

/**
 * Demo: 1000-row grid with row virtualization (7B).
 *
 * Without `virtualize` the DOM holds 1000 × 26 = 26,000 cells. With it, the
 * grid renders only the rows visible inside the wrapper (~10 + overscan) and
 * uses spacer rows to maintain real scroll height. Scrolling, keyboard
 * navigation and selection still address absolute row indices.
 *
 * WASM-backed so the seeded `=A1+1` chain demonstrates lazy formula eval —
 * formulas in unscrolled rows stay Dirty until their cell scrolls into view.
 */
export function DemoLarge() {
  const [storeRes] = createResource<SheetStore>(async () => {
    const sheet = await createWasmSheet()
    const store = createSheetStore(sheet)
    seed(store)
    return store
  })

  return (
    <Show
      when={storeRes()}
      fallback={<div class="demo-page"><p>Loading WASM backend…</p></div>}
    >
      {(store) => (
        <div class="demo-page">
          <div class="demo-header">
            <h3>Large Grid — Row Virtualization</h3>
            <p class="demo-desc">
              1000 rows × 26 columns. Only the visible window plus a small
              overscan is in the DOM — scroll to see new rows hydrate on
              demand. Arrow-keys past the bottom of the viewport auto-scroll
              the focus cell back into view.
            </p>
          </div>
          <Table store={store()} rows={1000} cols={26} virtualize formulaBar />
        </div>
      )}
    </Show>
  )
}

function seed(store: SheetStore) {
  store.setText('A1', 'Row Virtualization Demo')
  store.setNumber('A2', 1)
  // Build a 50-deep chain in column A; the rest of the grid stays empty.
  // Cells 3..50 are =A(n-1)+1, so reading A50 (after scrolling) forces a
  // lazy walk through 49 formula evaluations on first read.
  for (let r = 3; r <= 50; r++) {
    store.setFormula(`A${r}`, `=A${r - 1}+1`)
  }
  // Sprinkle a few far-down anchors so users see content when they scroll.
  store.setText('A500', 'You scrolled to row 500')
  store.setText('A999', 'You scrolled to row 999')
}
