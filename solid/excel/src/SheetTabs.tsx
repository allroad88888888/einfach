import { createSignal, For, Show } from 'solid-js'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import type { WorkbookStore } from './workbook-store'

type AsyncOrSync<T> = T | Promise<T>
type MutatingSheetWorkbook = Omit<WorkbookStore, 'addSheet' | 'renameSheet' | 'removeSheet'> & {
  addSheet: (name?: string) => AsyncOrSync<number>
  renameSheet: (idx: number, name: string) => AsyncOrSync<boolean>
  removeSheet: (idx: number) => AsyncOrSync<boolean>
}

export interface SheetTabsProps {
  workbook: MutatingSheetWorkbook
}

/**
 * Bottom-of-grid tab bar. Each tab switches the active sheet; the right-
 * side `+` button appends a new sheet with an auto-picked name.
 *
 * Right-clicking a tab opens a ContextMenu with Rename / Delete entries.
 * Rename still falls back to a single `window.prompt()` for the new name
 * (popup-input UI is out of scope). Delete uses `window.confirm()`.
 */
export function SheetTabs(props: SheetTabsProps) {
  const [menu, setMenu] = createSignal<{
    x: number
    y: number
    items: ContextMenuItem[]
  } | null>(null)

  async function onAddClick() {
    const idx = await Promise.resolve(props.workbook.addSheet())
    if (idx >= 0) props.workbook.setActiveIdx(idx)
  }

  async function doRename(idx: number, currentName: string) {
    const next = window.prompt(`Rename "${currentName}" to:`, currentName)
    if (next === null) return
    const trimmed = next.trim()
    if (trimmed === '' || trimmed === currentName) return
    const ok = await Promise.resolve(props.workbook.renameSheet(idx, trimmed))
    if (!ok) {
      window.alert(`Cannot rename — name "${trimmed}" is already taken.`)
    }
  }

  async function doDelete(idx: number, currentName: string) {
    if (!window.confirm(`Delete sheet "${currentName}"?`)) return
    const ok = await Promise.resolve(props.workbook.removeSheet(idx))
    if (!ok) {
      window.alert('Cannot delete the last remaining sheet.')
    }
  }

  function onContextMenu(e: MouseEvent, idx: number, currentName: string) {
    e.preventDefault()
    e.stopPropagation()
    const items: ContextMenuItem[] = [
      { label: 'Rename', onSelect: () => doRename(idx, currentName) },
      { label: 'Delete', onSelect: () => doDelete(idx, currentName) },
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
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
      <Show when={menu()}>
        {(m) => <ContextMenu items={m().items} x={m().x} y={m().y} onClose={() => setMenu(null)} />}
      </Show>
    </div>
  )
}
