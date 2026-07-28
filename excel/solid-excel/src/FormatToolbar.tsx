import { For } from 'solid-js'
import type { SheetStore } from './sheet-store'
import type { CellFormatJSON, NumberFormatJSON } from './types'

/**
 * Excel ribbon-lite format toolbar (Phase 6).
 *
 * Renders above the table when `<Table toolbar>` is set. Buttons / dropdowns
 * mutate the format of every cell in the current selection rectangle, wrapped
 * in a single beginEdit/endEdit so the whole click collapses to one undo
 * entry. Toolbar state (e.g. Bold pressed) reflects the focus-cell format.
 *
 * TODO: conditional rule editor UI — apply-path only is wired this round.
 */
export interface FormatToolbarProps {
  store: SheetStore
}

type NumberFormatPreset = {
  id: string
  label: string
  numberFormat: NumberFormatJSON | undefined
}

const NUMBER_FORMAT_PRESETS: NumberFormatPreset[] = [
  { id: 'general', label: 'General', numberFormat: { kind: 'general' } },
  {
    id: 'decimal-2',
    label: 'Number 0.00',
    numberFormat: { kind: 'decimal', digits: 2, thousands: false },
  },
  {
    id: 'percent-0',
    label: 'Percent 0%',
    numberFormat: { kind: 'percent', digits: 0 },
  },
  {
    id: 'currency-2',
    label: 'Currency $#,##0.00',
    numberFormat: { kind: 'currency', symbol: '$', digits: 2 },
  },
  {
    id: 'date-iso',
    label: 'Date yyyy-mm-dd',
    numberFormat: { kind: 'date', pattern: 'yyyy-mm-dd' },
  },
]

/** Stringify a NumberFormat to a stable id so the <select> value compares. */
function numberFormatId(nf: NumberFormatJSON | undefined): string {
  if (!nf || nf.kind === 'general') return 'general'
  if (nf.kind === 'decimal' || nf.kind === 'number') return `decimal-${nf.digits ?? 2}`
  if (nf.kind === 'percent' || nf.kind === 'percentage') return `percent-${nf.digits ?? 0}`
  if (nf.kind === 'currency') return `currency-${nf.digits ?? 2}`
  if (nf.kind === 'date') return 'date-iso'
  return 'general'
}

export function FormatToolbar(props: FormatToolbarProps) {
  const focusFormat = (): CellFormatJSON => {
    return props.store.getEffectiveFormat(props.store.selectionAddr())
  }

  function applyToSelection(patch: (current: CellFormatJSON) => CellFormatJSON) {
    props.store.formatSelection(patch)
  }

  function toggleBold() {
    const want = !focusFormat().bold
    applyToSelection((cur) => ({ ...cur, bold: want }))
  }
  function toggleItalic() {
    const want = !focusFormat().italic
    applyToSelection((cur) => ({ ...cur, italic: want }))
  }
  function setAlign(align: 'left' | 'center' | 'right') {
    applyToSelection((cur) => ({ ...cur, align }))
  }
  function setBackground(color: string) {
    applyToSelection((cur) => ({ ...cur, bgColor: color }))
  }
  function setForeground(color: string) {
    applyToSelection((cur) => ({ ...cur, fgColor: color }))
  }
  function setNumberFormatById(id: string) {
    const preset = NUMBER_FORMAT_PRESETS.find((p) => p.id === id)
    if (!preset) return
    applyToSelection((cur) => ({ ...cur, numberFormat: preset.numberFormat }))
  }

  return (
    <div class="format-toolbar" role="toolbar" aria-label="Format toolbar">
      <button
        type="button"
        class="fmt-btn"
        classList={{ 'fmt-btn-active': !!focusFormat().bold }}
        title="Bold"
        aria-label="Bold"
        aria-pressed={!!focusFormat().bold}
        onClick={toggleBold}
      >
        <span style={{ 'font-weight': 700 }}>B</span>
      </button>
      <button
        type="button"
        class="fmt-btn"
        classList={{ 'fmt-btn-active': !!focusFormat().italic }}
        title="Italic"
        aria-label="Italic"
        aria-pressed={!!focusFormat().italic}
        onClick={toggleItalic}
      >
        <span style={{ 'font-style': 'italic' }}>I</span>
      </button>

      <span class="fmt-sep" />

      <button
        type="button"
        class="fmt-btn"
        classList={{ 'fmt-btn-active': focusFormat().align === 'left' }}
        title="Align Left"
        aria-label="Align Left"
        onClick={() => setAlign('left')}
      >
        L
      </button>
      <button
        type="button"
        class="fmt-btn"
        classList={{ 'fmt-btn-active': focusFormat().align === 'center' }}
        title="Align Center"
        aria-label="Align Center"
        onClick={() => setAlign('center')}
      >
        C
      </button>
      <button
        type="button"
        class="fmt-btn"
        classList={{ 'fmt-btn-active': focusFormat().align === 'right' }}
        title="Align Right"
        aria-label="Align Right"
        onClick={() => setAlign('right')}
      >
        R
      </button>

      <span class="fmt-sep" />

      <label class="fmt-label">
        <span class="fmt-label-text">Format</span>
        <select
          class="fmt-select"
          aria-label="Number format"
          value={numberFormatId(focusFormat().numberFormat)}
          onChange={(e) => setNumberFormatById(e.currentTarget.value)}
        >
          <For each={NUMBER_FORMAT_PRESETS}>{(p) => <option value={p.id}>{p.label}</option>}</For>
        </select>
      </label>

      <span class="fmt-sep" />

      <label class="fmt-label" title="Background color">
        <span class="fmt-label-text">BG</span>
        <input
          type="color"
          class="fmt-color"
          aria-label="Background color"
          value={focusFormat().bgColor ?? '#ffffff'}
          onChange={(e) => setBackground(e.currentTarget.value)}
        />
      </label>
      <label class="fmt-label" title="Text color">
        <span class="fmt-label-text">FG</span>
        <input
          type="color"
          class="fmt-color"
          aria-label="Text color"
          value={focusFormat().fgColor ?? '#000000'}
          onChange={(e) => setForeground(e.currentTarget.value)}
        />
      </label>

      {/* TODO: conditional rule editor UI */}
    </div>
  )
}
