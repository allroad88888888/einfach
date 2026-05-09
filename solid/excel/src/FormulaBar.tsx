
import { createSignal, createEffect } from 'solid-js'
import type { SheetStore } from './sheet-store'

export interface FormulaBarProps {
  store: SheetStore
  /** Currently selected cell address, or null when nothing is selected. */
  activeAddr: () => string | null
  /** Called after the user commits a value (Enter / blur). */
  onCommit?: () => void
}

/**
 * Excel-style formula bar. Shows the source formula for formula cells and
 * the display value for primitive cells. Editing here goes through
 * setCellInput so it's identical to typing into the cell.
 *
 * Reads cell display reactively via `store.getCell` so the displayed value
 * stays in sync with the sheet between commits.
 */
export function FormulaBar(props: FormulaBarProps) {
  const [draft, setDraft] = createSignal<string>('')
  const [focused, setFocused] = createSignal(false)

  // Sync draft from the active cell whenever the selection changes or the
  // cell value changes externally — but only when the input isn't focused
  // (otherwise we'd clobber the user's typing).
  createEffect(() => {
    const addr = props.activeAddr()
    if (focused()) return
    if (addr === null) {
      setDraft('')
      return
    }
    const formula = props.store.getFormula(addr)
    if (formula !== '') {
      setDraft(formula)
    } else {
      setDraft(props.store.getCell(addr).display)
    }
  })

  function commit() {
    const addr = props.activeAddr()
    if (addr === null) return
    props.store.setCellInput(addr, draft())
    props.onCommit?.()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
      ;(e.currentTarget as HTMLInputElement).blur()
    } else if (e.key === 'Escape') {
      // Reset draft from the active cell.
      const addr = props.activeAddr()
      if (addr !== null) {
        const formula = props.store.getFormula(addr)
        setDraft(formula !== '' ? formula : props.store.getCell(addr).display)
      }
      ;(e.currentTarget as HTMLInputElement).blur()
    }
  }

  return (
    <div class="formula-bar">
      <span class="formula-bar-addr">{props.activeAddr() ?? ''}</span>
      <input
        class="formula-bar-input"
        type="text"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={onKeyDown}
        disabled={props.activeAddr() === null}
      />
    </div>
  )
}
