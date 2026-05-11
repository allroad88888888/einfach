
import { createSignal, createEffect } from 'solid-js'
import type { SheetStore } from './sheet-store'

export interface FormulaBarProps {
  store: SheetStore
  /**
   * Optional override for the active cell address. If omitted, FormulaBar
   * reads the selection from `store.selectionAddr()` (the default and
   * recommended path).
   */
  activeAddr?: () => string | null
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

  /** The address to edit — prop override wins, else the store's selection. */
  const addr = (): string | null =>
    props.activeAddr ? props.activeAddr() : props.store.selectionAddr()

  // Sync draft from the active cell whenever the selection changes or the
  // cell value changes externally — but only when the input isn't focused
  // (otherwise we'd clobber the user's typing).
  createEffect(() => {
    const a = addr()
    if (focused()) return
    if (a === null) {
      setDraft('')
      return
    }
    const formula = props.store.getFormula(a)
    if (formula !== '') {
      setDraft(formula)
    } else {
      setDraft(props.store.getCell(a).display)
    }
  })

  // Guards against the Enter→commit→blur→commit double-fire (same shape as
  // Cell.commitEdit, see TODO 1.2.1). Set true right after a programmatic
  // commit; the immediately-following onBlur skips its own commit and
  // resets the flag.
  let justCommitted = false

  function commit() {
    const a = addr()
    if (a === null) return
    if (justCommitted) {
      justCommitted = false
      return
    }
    justCommitted = true
    props.store.setCellInput(a, draft())
    props.onCommit?.()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
      ;(e.currentTarget as HTMLInputElement).blur()
    } else if (e.key === 'Escape') {
      const a = addr()
      if (a !== null) {
        const formula = props.store.getFormula(a)
        setDraft(formula !== '' ? formula : props.store.getCell(a).display)
      }
      // Same as Enter — the upcoming blur() must not commit the (now
      // reverted) draft. Set the flag before blur fires.
      justCommitted = true
      ;(e.currentTarget as HTMLInputElement).blur()
    }
  }

  return (
    <div class="formula-bar" data-testid="formula-bar">
      <span class="formula-bar-addr" data-testid="formula-bar-addr">{addr() ?? ''}</span>
      <input
        class="formula-bar-input"
        data-testid="formula-bar-input"
        type="text"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={onKeyDown}
        disabled={addr() === null}
      />
    </div>
  )
}
