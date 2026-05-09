
import { For } from 'solid-js'
import type { WorkbookStore } from './workbook-store'

export interface SheetTabsProps {
  workbook: WorkbookStore
}

/**
 * Bottom-of-grid tab bar. Each tab switches the active sheet; the right-
 * side `+` button appends a new sheet with an auto-picked name.
 *
 * Right-clicking a tab opens a (very) bare-bones context flow:
 *   - native `confirm("Delete sheet ...?")` for delete
 *   - native `prompt("New name:", ...)` for rename
 *
 * TODO: replace these with a proper popover menu component once one
 * exists in the codebase. The native prompt/confirm is intentional —
 * keeps this PR focused on the multi-sheet *plumbing*, not menu UI.
 */
export function SheetTabs(props: SheetTabsProps) {
  function onAddClick() {
    const idx = props.workbook.addSheet()
    if (idx >= 0) props.workbook.setActiveIdx(idx)
  }

  function onContextMenu(e: MouseEvent, idx: number, currentName: string) {
    e.preventDefault()
    // Two-step prompt: choose action, then perform it.
    // We use prompt/confirm directly to avoid pulling in a menu library.
    const action = window.prompt(
      `Sheet "${currentName}":\n\n` +
        `Type "rename" to rename, "delete" to delete, or leave empty to cancel.`,
      '',
    )
    if (!action) return
    const verb = action.trim().toLowerCase()
    if (verb === 'rename') {
      const next = window.prompt(`Rename "${currentName}" to:`, currentName)
      if (next === null) return
      const trimmed = next.trim()
      if (trimmed === '' || trimmed === currentName) return
      const ok = props.workbook.renameSheet(idx, trimmed)
      if (!ok) {
        window.alert(`Cannot rename — name "${trimmed}" is already taken.`)
      }
    } else if (verb === 'delete') {
      if (!window.confirm(`Delete sheet "${currentName}"?`)) return
      const ok = props.workbook.removeSheet(idx)
      if (!ok) {
        window.alert('Cannot delete the last remaining sheet.')
      }
    }
  }

  return (
    <div class="sheet-tabs" role="tablist">
      <For each={props.workbook.sheets()}>
        {(meta) => {
          const isActive = () => props.workbook.activeIdx() === meta.idx
          return (
            <button
              type="button"
              role="tab"
              class={`sheet-tab ${isActive() ? 'sheet-tab-active' : ''}`}
              onClick={() => props.workbook.setActiveIdx(meta.idx)}
              onContextMenu={(e) => onContextMenu(e, meta.idx, meta.name)}
              aria-selected={isActive()}
            >
              {meta.name}
            </button>
          )
        }}
      </For>
      <button
        type="button"
        class="sheet-tab-add"
        onClick={onAddClick}
        title="Add sheet"
        aria-label="Add sheet"
      >
        +
      </button>
    </div>
  )
}
