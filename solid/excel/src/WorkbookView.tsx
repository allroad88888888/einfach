/** @jsxImportSource solid-js */
import { For, createEffect, onCleanup, onMount } from 'solid-js'
import { Table } from './Table'
import { createTableInteractions } from './table-interactions'
import type { CellFormat } from './types'
import type { WorkbookStore } from './workbook-store'

function triggerDownload(filename: string, content: string | Uint8Array, type: string) {
  if (typeof document === 'undefined') return
  const blobPart: BlobPart = typeof content === 'string' ? content : new Uint8Array(content)
  const blob = new Blob([blobPart], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function WorkbookView(props: { store: WorkbookStore; persistenceKey?: string }) {
  const interactions = createTableInteractions(props.store, props.store.rowCount, props.store.colCount)
  let csvInputRef: HTMLInputElement | undefined
  let jsonInputRef: HTMLInputElement | undefined
  let xlsxInputRef: HTMLInputElement | undefined

  const selectedAddresses = () => interactions.selectedAddresses()
  const selectedFormat = () => props.store.getCellFormat(interactions.selectedCell())

  function recordSnapshotMutation(kind: string, handler: () => boolean | void, focusAddr = interactions.selectionTopLeft()) {
    const before = props.store.takeSnapshot()
    const result = handler()
    if (result === false) return false
    const after = props.store.takeSnapshot()
    interactions.recordSnapshotChange(kind, before, after, focusAddr)
    return true
  }

  async function recordAsyncSnapshotMutation(
    kind: string,
    handler: () => Promise<boolean | void>,
    focusAddr = interactions.selectionTopLeft(),
  ) {
    const before = props.store.takeSnapshot()
    const result = await handler()
    if (result === false) return false
    const after = props.store.takeSnapshot()
    interactions.recordSnapshotChange(kind, before, after, focusAddr)
    return true
  }

  function applyFormat(patch: Partial<CellFormat>) {
    recordSnapshotMutation('format', () => props.store.applyCellFormat(selectedAddresses(), patch))
  }

  function updateNumberFormat(patch: Partial<CellFormat['numberFormat']>) {
    applyFormat({
      numberFormat: {
        ...selectedFormat().numberFormat,
        ...patch,
      },
    })
  }

  async function importFile(file: File | undefined, kind: 'csv' | 'json' | 'xlsx') {
    if (!file) return
    if (kind === 'csv') {
      const payload = await file.text()
      recordSnapshotMutation('import_csv', () => props.store.importCSV(payload))
      return
    }
    if (kind === 'json') {
      const payload = await file.text()
      recordSnapshotMutation('import_json', () => props.store.importJSON(payload))
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    await recordAsyncSnapshotMutation('import_xlsx', () => props.store.importXLSX(bytes))
  }

  function renameSheet(index: number) {
    const current = props.store.sheetNames()[index]
    const nextName = window.prompt('Rename sheet', current)
    if (!nextName || nextName === current) return

    const before = props.store.takeSnapshot()
    if (!props.store.renameSheet(index, nextName)) return
    const after = props.store.takeSnapshot()
    interactions.recordSnapshotChange('sheet_rename', before, after, interactions.selectionTopLeft())
  }

  onMount(() => {
    if (!props.persistenceKey || typeof window === 'undefined') return
    const saved = window.localStorage.getItem(props.persistenceKey)
    if (saved) {
      props.store.importJSON(saved)
    }
  })

  createEffect(() => {
    if (!props.persistenceKey || typeof window === 'undefined') return
    props.store.version()
    const handle = window.setTimeout(() => {
      window.localStorage.setItem(props.persistenceKey!, props.store.exportJSON())
    }, 240)
    onCleanup(() => window.clearTimeout(handle))
  })

  return (
    <div class="workbook-shell">
      <section class="workbook-toolbar">
        <div class="toolbar-section toolbar-selection">
          <span class="toolbar-label">Selection</span>
          <strong class="toolbar-pill">{interactions.selectionTopLeft()}</strong>
          <span class="toolbar-meta">{selectedAddresses().length} cell{selectedAddresses().length === 1 ? '' : 's'}</span>
        </div>

        <div class="toolbar-section">
          <button
            class={`toolbar-toggle ${selectedFormat().bold ? 'toolbar-toggle-active' : ''}`}
            onClick={() => applyFormat({ bold: !selectedFormat().bold })}
            type="button"
          >
            Bold
          </button>
          <button
            class={`toolbar-toggle ${selectedFormat().italic ? 'toolbar-toggle-active' : ''}`}
            onClick={() => applyFormat({ italic: !selectedFormat().italic })}
            type="button"
          >
            Italic
          </button>
          <label class="toolbar-field">
            <span>Size</span>
            <select
              aria-label="Font size"
              onChange={(event) => {
                const value = Number(event.currentTarget.value)
                applyFormat({ fontSize: value === 0 ? null : value })
              }}
              value={selectedFormat().fontSize ?? 0}
            >
              <option value={0}>Auto</option>
              <option value={12}>12</option>
              <option value={14}>14</option>
              <option value={16}>16</option>
              <option value={18}>18</option>
              <option value={20}>20</option>
            </select>
          </label>
          <label class="toolbar-color">
            <span>Text</span>
            <input
              aria-label="Text color"
              onInput={(event) => applyFormat({ textColor: event.currentTarget.value })}
              type="color"
              value={selectedFormat().textColor ?? '#1f2733'}
            />
          </label>
          <label class="toolbar-color">
            <span>Fill</span>
            <input
              aria-label="Fill color"
              onInput={(event) => applyFormat({ backgroundColor: event.currentTarget.value })}
              type="color"
              value={selectedFormat().backgroundColor ?? '#ffffff'}
            />
          </label>
        </div>

        <div class="toolbar-section">
          <label class="toolbar-field">
            <span>Align</span>
            <select
              aria-label="Horizontal align"
              onChange={(event) => applyFormat({
                horizontalAlign: event.currentTarget.value ? event.currentTarget.value as CellFormat['horizontalAlign'] : null,
              })}
              value={selectedFormat().horizontalAlign ?? ''}
            >
              <option value="">Auto</option>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label class="toolbar-field">
            <span>Border</span>
            <select
              aria-label="Border style"
              onChange={(event) => applyFormat({
                borderStyle: event.currentTarget.value as CellFormat['borderStyle'],
                borderColor: event.currentTarget.value === 'solid' ? (selectedFormat().borderColor ?? '#aab6c7') : null,
              })}
              value={selectedFormat().borderStyle}
            >
              <option value="none">None</option>
              <option value="solid">Solid</option>
            </select>
          </label>
          <label class="toolbar-color">
            <span>Border</span>
            <input
              aria-label="Border color"
              disabled={selectedFormat().borderStyle !== 'solid'}
              onInput={(event) => applyFormat({ borderColor: event.currentTarget.value })}
              type="color"
              value={selectedFormat().borderColor ?? '#aab6c7'}
            />
          </label>
        </div>

        <div class="toolbar-section">
          <label class="toolbar-field">
            <span>Number</span>
            <select
              aria-label="Number format"
              onChange={(event) => updateNumberFormat({
                kind: event.currentTarget.value as CellFormat['numberFormat']['kind'],
              })}
              value={selectedFormat().numberFormat.kind}
            >
              <option value="general">General</option>
              <option value="fixed">Fixed</option>
              <option value="percent">Percent</option>
              <option value="currency">Currency</option>
            </select>
          </label>
          <label class="toolbar-field">
            <span>Decimals</span>
            <input
              aria-label="Decimal places"
              max={4}
              min={0}
              onInput={(event) => updateNumberFormat({ decimals: Number(event.currentTarget.value) })}
              type="number"
              value={selectedFormat().numberFormat.decimals}
            />
          </label>
          <label class="toolbar-check">
            <input
              aria-label="Use grouping"
              checked={selectedFormat().numberFormat.useGrouping}
              onChange={(event) => updateNumberFormat({ useGrouping: event.currentTarget.checked })}
              type="checkbox"
            />
            <span>Grouping</span>
          </label>
          <label class="toolbar-field">
            <span>Currency</span>
            <input
              aria-label="Currency symbol"
              maxLength={3}
              onInput={(event) => updateNumberFormat({ currencySymbol: event.currentTarget.value || '$' })}
              type="text"
              value={selectedFormat().numberFormat.currencySymbol}
            />
          </label>
        </div>

        <div class="toolbar-section toolbar-export">
          <button
            onClick={() => triggerDownload(`${props.store.sheetNames()[props.store.activeSheetIndex()]}.csv`, props.store.exportCSV(), 'text/csv;charset=utf-8')}
            type="button"
          >
            Export CSV
          </button>
          <button
            onClick={() => triggerDownload('einfach-workbook.json', props.store.exportJSON(), 'application/json;charset=utf-8')}
            type="button"
          >
            Export JSON
          </button>
          <button
            onClick={async () => {
              const activeName = props.store.sheetNames()[props.store.activeSheetIndex()] ?? 'einfach-workbook'
              const content = await props.store.exportXLSX()
              triggerDownload(
                `${activeName}.xlsx`,
                content,
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              )
            }}
            type="button"
          >
            Export Excel
          </button>
          <button onClick={() => csvInputRef?.click()} type="button">Import CSV</button>
          <button onClick={() => jsonInputRef?.click()} type="button">Import JSON</button>
          <button onClick={() => xlsxInputRef?.click()} type="button">Import Excel</button>
          <button onClick={() => recordSnapshotMutation('format_clear', () => props.store.clearCellFormat(selectedAddresses()))} type="button">
            Clear Style
          </button>
          <input
            accept=".csv,text/csv"
            aria-label="Import CSV file"
            class="toolbar-file-input"
            onChange={(event) => {
              void importFile(event.currentTarget.files?.[0], 'csv')
              event.currentTarget.value = ''
            }}
            ref={(element) => {
              csvInputRef = element
            }}
            type="file"
          />
          <input
            accept=".json,application/json"
            aria-label="Import JSON file"
            class="toolbar-file-input"
            onChange={(event) => {
              void importFile(event.currentTarget.files?.[0], 'json')
              event.currentTarget.value = ''
            }}
            ref={(element) => {
              jsonInputRef = element
            }}
            type="file"
          />
          <input
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label="Import Excel file"
            class="toolbar-file-input"
            onChange={(event) => {
              void importFile(event.currentTarget.files?.[0], 'xlsx')
              event.currentTarget.value = ''
            }}
            ref={(element) => {
              xlsxInputRef = element
            }}
            type="file"
          />
        </div>
      </section>

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
