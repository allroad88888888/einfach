/** @jsxImportSource solid-js */
import { For } from 'solid-js'
import { Table } from './Table'
import { createTableInteractions } from './table-interactions'
import type { WorkbookStore } from './workbook-store'

export function WorkbookView(props: { store: WorkbookStore }) {
  const interactions = createTableInteractions(props.store, props.store.rowCount, props.store.colCount)

  function renameSheet(index: number) {
    const current = props.store.sheetNames()[index]
    const nextName = window.prompt('Rename sheet', current)
    if (!nextName || nextName === current) return

    const before = props.store.takeSnapshot()
    if (!props.store.renameSheet(index, nextName)) return
    const after = props.store.takeSnapshot()
    interactions.recordSnapshotChange('sheet_rename', before, after, interactions.selectionTopLeft())
  }

  return (
    <div class="workbook-shell">
      <Table interactions={interactions} store={props.store} />

      <div class="sheet-tab-bar">
        <div class="sheet-tabs">
          <For each={props.store.sheetNames()}>
            {(name, index) => (
              <div class={`sheet-tab ${props.store.activeSheetIndex() === index() ? 'sheet-tab-active' : ''}`}>
                <button
                  class="sheet-tab-button"
                  onClick={() => props.store.setActiveSheet(index())}
                  onDblClick={() => renameSheet(index())}
                  type="button"
                >
                  {name}
                </button>
                <button
                  aria-label={`Delete ${name}`}
                  class="sheet-tab-delete"
                  disabled={props.store.sheetNames().length <= 1}
                  onClick={() => {
                    const before = props.store.takeSnapshot()
                    if (!props.store.removeSheet(index())) return
                    const after = props.store.takeSnapshot()
                    interactions.recordSnapshotChange('sheet_delete', before, after, interactions.selectionTopLeft())
                  }}
                  type="button"
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>

        <button
          class="sheet-add-button"
          onClick={() => {
            const before = props.store.takeSnapshot()
            props.store.addSheet()
            const after = props.store.takeSnapshot()
            interactions.recordSnapshotChange('sheet_add', before, after, interactions.selectionTopLeft())
          }}
          type="button"
        >
          + Sheet
        </button>
      </div>
    </div>
  )
}
