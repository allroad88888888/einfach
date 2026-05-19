/** @jsxImportSource solid-js */

import { For, Show, createEffect, createMemo, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  closeFormatCellsAtom,
  formatCellsActiveTabAtom,
  formatCellsDraftAtom,
  formatCellsEditorAtom,
  formatCellsSavePayloadAtom,
  patchFormatCellsDraftAtom,
  saveFormatCellsAtom,
  setFormatCellsActiveTabAtom,
  type FormatCellsDraft,
  type FormatCellsNumberCategory,
  type FormatCellsTabId,
  type SpreadsheetAlignment,
  type SpreadsheetBorderStyle,
  type SpreadsheetNumberFormat,
  type SpreadsheetVerticalAlignment,
} from '@einfach/spreadsheet-ui-core'
import { useT } from '../../src/i18n'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'

export interface SpreadsheetFormatCellsDialogProps {
  class?: string
  'data-testid'?: string
}

interface TabDescriptor {
  id: FormatCellsTabId
  labelKey: string
}

const TABS: readonly TabDescriptor[] = [
  { id: 'number', labelKey: 'formatCells.tab.number' },
  { id: 'alignment', labelKey: 'formatCells.tab.alignment' },
  { id: 'font', labelKey: 'formatCells.tab.font' },
  { id: 'border', labelKey: 'formatCells.tab.border' },
  { id: 'fill', labelKey: 'formatCells.tab.fill' },
]

const NUMBER_CATEGORIES: readonly FormatCellsNumberCategory[] = [
  'general',
  'number',
  'currency',
  'accounting',
  'date',
  'time',
  'percentage',
  'fraction',
  'scientific',
  'text',
  'special',
  'custom',
]

/**
 * Categories whose payload routes 1:1 to the engine. The wider Wave 6.3
 * kinds (`accounting`, `time`, `fraction`, `scientific`, `text`, `special`,
 * `custom`) are present in the picker but mapped to `{ kind: 'general' }`
 * until Agent 6.3's widening lands and the engine grows support; until then
 * those rows render an inline "coming soon" hint.
 */
const SUPPORTED_CATEGORIES: ReadonlySet<FormatCellsNumberCategory> = new Set([
  'general',
  'number',
  'currency',
  'date',
  'percentage',
])

const BORDER_STYLES: readonly SpreadsheetBorderStyle[] = [
  'thin',
  'medium',
  'thick',
  'dashed',
  'dotted',
  'double',
]

const FONT_FAMILIES: readonly string[] = [
  'system-ui, sans-serif',
  'Arial, Helvetica, sans-serif',
  'Georgia, "Times New Roman", serif',
  '"Courier New", monospace',
]

const HORIZONTAL_ALIGNS: readonly SpreadsheetAlignment[] = [
  'left',
  'center',
  'right',
  'fill',
  'justify',
  'distributed',
]

const VERTICAL_ALIGNS: readonly SpreadsheetVerticalAlignment[] = ['top', 'center', 'bottom']

/**
 * Map the draft's number-format kind onto a UI category. We accept both the
 * legacy union (Wave 6.2) and the wider 6.3 union; unknown future kinds
 * collapse to `'general'` so the dialog never crashes on round-trip.
 */
function detectCategory(format: FormatCellsDraft | null): FormatCellsNumberCategory {
  const nf = format?.numberFormat
  if (!nf) return 'general'
  // Use the discriminator as a plain string so 6.3 kinds round-trip safely
  // even before the core type union lists them.
  const kind = (nf as { kind: string }).kind
  switch (kind) {
    case 'general':
      return 'general'
    case 'number':
    case 'decimal':
      return 'number'
    case 'currency':
      return 'currency'
    case 'accounting':
      return 'accounting'
    case 'date':
      return 'date'
    case 'time':
      return 'time'
    case 'percent':
    case 'percentage':
      return 'percentage'
    case 'fraction':
      return 'fraction'
    case 'scientific':
      return 'scientific'
    case 'text':
      return 'text'
    case 'special':
      return 'special'
    case 'custom':
      return 'custom'
    default:
      return 'general'
  }
}

/**
 * Map a UI category onto a `SpreadsheetNumberFormat` payload.
 *
 * Only the five legacy variants (`general`, `decimal`, `percent`, `currency`,
 * `date`) are guaranteed routable: those are the kinds the core type knew
 * about at the time 6.1 lands. The wider 6.3 categories (`accounting`,
 * `time`, `fraction`, …) currently route as `{ kind: 'general' }` and surface
 * the inline "coming soon" hint. When 6.3's widening lands the dialog will
 * switch the unsupported branches to the wider payloads in a follow-up.
 */
function categoryToNumberFormat(category: FormatCellsNumberCategory): SpreadsheetNumberFormat {
  switch (category) {
    case 'general':
      return { kind: 'general' }
    case 'number':
      return { kind: 'decimal', digits: 2 }
    case 'currency':
      return { kind: 'currency', symbol: '$', digits: 2 }
    case 'percentage':
      return { kind: 'percent', digits: 2 }
    case 'date':
      return { kind: 'date', pattern: 'yyyy-mm-dd' }
    default:
      return { kind: 'general' }
  }
}

export function SpreadsheetFormatCellsDialog(props: SpreadsheetFormatCellsDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const editor = useAtomValue(formatCellsEditorAtom)
  const activeTab = useAtomValue(formatCellsActiveTabAtom)
  const draft = useAtomValue(formatCellsDraftAtom)

  const isOpen = () => editor().status === 'open'

  const currentCategory = createMemo(() => detectCategory(draft()))

  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeFormatCellsAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  function patch(next: Partial<FormatCellsDraft>) {
    store.setter(patchFormatCellsDraftAtom, next)
  }

  function setTab(id: FormatCellsTabId) {
    store.setter(setFormatCellsActiveTabAtom, id)
  }

  function handleCancel() {
    store.setter(closeFormatCellsAtom)
  }

  async function handleSave() {
    const payload = store.getter(formatCellsSavePayloadAtom)
    if (!payload) return
    if (backend.setFormatRange) {
      try {
        await backend.setFormatRange({
          kind: 'set-format-range',
          sheetId: payload.sheetId,
          range: payload.range,
          format: payload.format,
        })
      } catch {
        // Surface failure by leaving the editor open. A production build
        // would dispatch a diagnostic atom; we omit the console log to comply
        // with the repo's no-console lint rule.
        return
      }
    }
    store.setter(saveFormatCellsAtom)
  }

  function onCategoryChange(category: FormatCellsNumberCategory) {
    patch({ numberFormat: categoryToNumberFormat(category) })
  }

  function onRotationInput(event: Event) {
    const raw = (event.target as HTMLInputElement).value
    const n = Number(raw)
    if (Number.isFinite(n)) {
      patch({ rotation: Math.max(-90, Math.min(90, Math.round(n))) })
    }
  }

  function onIndentInput(event: Event) {
    const raw = (event.target as HTMLInputElement).value
    const n = Math.max(0, Math.round(Number(raw) || 0))
    patch({ indent: n })
  }

  function onFontSizeInput(event: Event) {
    const raw = (event.target as HTMLInputElement).value
    const n = Math.max(1, Math.round(Number(raw) || 0))
    patch({ fontSize: n })
  }

  function previewText(): string {
    const sample = 1234.5
    const category = currentCategory()
    switch (category) {
      case 'general':
        return String(sample)
      case 'number':
        return sample.toFixed(2)
      case 'currency':
        return `$${sample.toFixed(2)}`
      case 'accounting':
        return `$    ${sample.toFixed(2)}`
      case 'percentage':
        return `${(sample / 100).toFixed(2)}%`
      case 'date':
        return '2026-05-19'
      case 'time':
        return '12:34:56'
      case 'fraction':
        return '1234 1/2'
      case 'scientific':
        return '1.23E+03'
      case 'text':
        return String(sample)
      case 'special':
        return '12345-6789'
      case 'custom':
        return String(sample)
    }
  }

  function applyBorderPreset(preset: 'none' | 'outline') {
    if (preset === 'none') {
      patch({ borders: undefined })
      return
    }
    const style: SpreadsheetBorderStyle = 'thin'
    patch({
      borders: {
        top: { style },
        right: { style },
        bottom: { style },
        left: { style },
      },
    })
  }

  function toggleSide(side: 'top' | 'right' | 'bottom' | 'left') {
    const current = draft()?.borders ?? {}
    const has = !!current[side]
    const next = { ...current }
    if (has) {
      delete next[side]
    } else {
      next[side] = { style: 'thin' }
    }
    patch({ borders: next })
  }

  function selectFamily(event: Event) {
    const value = (event.target as HTMLSelectElement).value
    patch({ fontFamily: value || undefined })
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`format-cells-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'format-cells-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label="Format Cells"
      >
        <button
          type="button"
          class="dialog-close-x"
          data-testid="dialog-close-x"
          aria-label={t('dialog.close.label')}
          onClick={handleCancel}
        >
          ×
        </button>
        <div class="format-cells-tabs" role="tablist" data-testid="format-cells-tabs">
          <For each={TABS}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                class={`format-cells-tab ${activeTab() === tab.id ? 'format-cells-tab-active' : ''}`.trim()}
                data-testid={`format-cells-tab-${tab.id}`}
                aria-selected={activeTab() === tab.id}
                onClick={() => setTab(tab.id)}
              >
                {t(tab.labelKey)}
              </button>
            )}
          </For>
        </div>

        <div class="format-cells-panel" data-testid={`format-cells-panel-${activeTab()}`}>
          <Show when={activeTab() === 'number'}>
            <div class="format-cells-section" data-testid="format-cells-number">
              <ul class="format-cells-category-list" data-testid="format-cells-category-list">
                <For each={NUMBER_CATEGORIES}>
                  {(category) => (
                    <li>
                      <label class="format-cells-category-row">
                        <input
                          type="radio"
                          name="format-cells-category"
                          data-testid={`format-cells-category-${category}`}
                          checked={currentCategory() === category}
                          onChange={() => onCategoryChange(category)}
                        />
                        <span>{t(`formatCells.number.category.${category}`)}</span>
                        <Show when={!SUPPORTED_CATEGORIES.has(category)}>
                          <span
                            class="format-cells-coming-soon"
                            data-testid={`format-cells-category-${category}-coming-soon`}
                          >
                            {t('formatCells.number.comingSoon')}
                          </span>
                        </Show>
                      </label>
                    </li>
                  )}
                </For>
              </ul>
              <div class="format-cells-preview" data-testid="format-cells-number-preview">
                {previewText()}
              </div>
              <Show when={currentCategory() === 'number'}>
                <label class="format-cells-row">
                  <span>{t('formatCells.number.decimals')}</span>
                  <input
                    type="number"
                    min="0"
                    max="20"
                    data-testid="format-cells-number-decimals"
                    value={(() => {
                      const nf = draft()?.numberFormat
                      if (nf && ((nf as { kind: string }).kind === 'decimal' || (nf as { kind: string }).kind === 'number')) {
                        return (nf as { digits?: number }).digits ?? 2
                      }
                      return 2
                    })()}
                    onInput={(event) => {
                      const digits = Math.max(0, Math.round(Number(event.currentTarget.value) || 0))
                      patch({ numberFormat: { kind: 'decimal', digits } })
                    }}
                  />
                </label>
              </Show>
              <Show when={currentCategory() === 'currency'}>
                <label class="format-cells-row">
                  <span>{t('formatCells.number.symbol')}</span>
                  <input
                    type="text"
                    data-testid="format-cells-currency-symbol"
                    value={(() => {
                      const nf = draft()?.numberFormat
                      return nf && nf.kind === 'currency' ? (nf.symbol ?? '$') : '$'
                    })()}
                    onInput={(event) => {
                      const symbol = event.currentTarget.value
                      patch({ numberFormat: { kind: 'currency', symbol, digits: 2 } })
                    }}
                  />
                </label>
              </Show>
              <Show when={currentCategory() === 'date'}>
                <label class="format-cells-row">
                  <span>{t('formatCells.number.pattern')}</span>
                  <input
                    type="text"
                    data-testid="format-cells-date-pattern"
                    value={(() => {
                      const nf = draft()?.numberFormat
                      return nf && nf.kind === 'date' ? (nf.pattern ?? 'yyyy-mm-dd') : 'yyyy-mm-dd'
                    })()}
                    onInput={(event) => {
                      const pattern = event.currentTarget.value
                      patch({ numberFormat: { kind: 'date', pattern } })
                    }}
                  />
                </label>
              </Show>
            </div>
          </Show>

          <Show when={activeTab() === 'alignment'}>
            <div class="format-cells-section" data-testid="format-cells-alignment">
              <label class="format-cells-row">
                <span>{t('formatCells.alignment.horizontal')}</span>
                <select
                  data-testid="format-cells-align-horizontal"
                  value={draft()?.align ?? 'default'}
                  onChange={(event) => {
                    const value = event.currentTarget.value as SpreadsheetAlignment
                    patch({ align: value })
                  }}
                >
                  <option value="default">{t('formatCells.alignment.default')}</option>
                  <For each={HORIZONTAL_ALIGNS}>
                    {(value) => (
                      <option value={value}>{t(`formatCells.alignment.h.${value}`)}</option>
                    )}
                  </For>
                </select>
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.alignment.vertical')}</span>
                <select
                  data-testid="format-cells-align-vertical"
                  value={draft()?.verticalAlign ?? 'bottom'}
                  onChange={(event) => {
                    const value = event.currentTarget.value as SpreadsheetVerticalAlignment
                    patch({ verticalAlign: value })
                  }}
                >
                  <For each={VERTICAL_ALIGNS}>
                    {(value) => (
                      <option value={value}>{t(`formatCells.alignment.v.${value}`)}</option>
                    )}
                  </For>
                </select>
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.alignment.rotation')}</span>
                <input
                  type="number"
                  min="-90"
                  max="90"
                  data-testid="format-cells-rotation"
                  value={typeof draft()?.rotation === 'number' ? (draft()?.rotation as number) : 0}
                  onInput={onRotationInput}
                />
              </label>
              <label class="format-cells-row">
                <input
                  type="checkbox"
                  data-testid="format-cells-wrap"
                  checked={!!draft()?.wrap}
                  onChange={(event) => patch({ wrap: event.currentTarget.checked })}
                />
                <span>{t('formatCells.alignment.wrap')}</span>
              </label>
              <label class="format-cells-row">
                <input
                  type="checkbox"
                  data-testid="format-cells-shrink"
                  checked={!!draft()?.shrinkToFit}
                  onChange={(event) =>
                    patch({ shrinkToFit: event.currentTarget.checked })
                  }
                />
                <span>{t('formatCells.alignment.shrink')}</span>
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.alignment.indent')}</span>
                <input
                  type="number"
                  min="0"
                  max="20"
                  data-testid="format-cells-indent"
                  value={draft()?.indent ?? 0}
                  onInput={onIndentInput}
                />
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.alignment.direction')}</span>
                <select
                  data-testid="format-cells-text-direction"
                  value={draft()?.textDirection ?? 'context'}
                  onChange={(event) => {
                    const value = event.currentTarget.value as FormatCellsDraft['textDirection']
                    patch({ textDirection: value })
                  }}
                >
                  <option value="context">{t('formatCells.alignment.direction.context')}</option>
                  <option value="ltr">{t('formatCells.alignment.direction.ltr')}</option>
                  <option value="rtl">{t('formatCells.alignment.direction.rtl')}</option>
                </select>
              </label>
            </div>
          </Show>

          <Show when={activeTab() === 'font'}>
            <div class="format-cells-section" data-testid="format-cells-font">
              <label class="format-cells-row">
                <span>{t('formatCells.font.family')}</span>
                <select
                  data-testid="format-cells-font-family"
                  value={draft()?.fontFamily ?? ''}
                  onChange={selectFamily}
                >
                  <option value="">{t('formatCells.font.familyDefault')}</option>
                  <For each={FONT_FAMILIES}>{(family) => <option value={family}>{family}</option>}</For>
                </select>
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.font.size')}</span>
                <input
                  type="number"
                  min="1"
                  max="409"
                  data-testid="format-cells-font-size"
                  value={draft()?.fontSize ?? 12}
                  onInput={onFontSizeInput}
                />
              </label>
              <label class="format-cells-row">
                <input
                  type="checkbox"
                  data-testid="format-cells-bold"
                  checked={!!draft()?.bold}
                  onChange={(event) => patch({ bold: event.currentTarget.checked })}
                />
                <span>{t('formatCells.font.bold')}</span>
              </label>
              <label class="format-cells-row">
                <input
                  type="checkbox"
                  data-testid="format-cells-italic"
                  checked={!!draft()?.italic}
                  onChange={(event) => patch({ italic: event.currentTarget.checked })}
                />
                <span>{t('formatCells.font.italic')}</span>
              </label>
              <label class="format-cells-row">
                <input
                  type="checkbox"
                  data-testid="format-cells-underline"
                  checked={!!draft()?.underline}
                  onChange={(event) => patch({ underline: event.currentTarget.checked })}
                />
                <span>{t('formatCells.font.underline')}</span>
              </label>
              <label class="format-cells-row">
                <input
                  type="checkbox"
                  data-testid="format-cells-strikethrough"
                  checked={!!draft()?.strikethrough}
                  onChange={(event) =>
                    patch({ strikethrough: event.currentTarget.checked })
                  }
                />
                <span>{t('formatCells.font.strikethrough')}</span>
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.font.color')}</span>
                <input
                  type="color"
                  data-testid="format-cells-fg-color"
                  value={draft()?.fgColor ?? '#000000'}
                  onInput={(event) => patch({ fgColor: event.currentTarget.value })}
                />
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.font.script')}</span>
                <select
                  data-testid="format-cells-script"
                  value={draft()?.verticalScript ?? 'none'}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    if (value === 'none') {
                      patch({ verticalScript: undefined })
                    } else {
                      patch({ verticalScript: value as 'superscript' | 'subscript' })
                    }
                  }}
                >
                  <option value="none">{t('formatCells.font.scriptNone')}</option>
                  <option value="superscript">{t('formatCells.font.scriptSuper')}</option>
                  <option value="subscript">{t('formatCells.font.scriptSub')}</option>
                </select>
              </label>
            </div>
          </Show>

          <Show when={activeTab() === 'border'}>
            <div class="format-cells-section" data-testid="format-cells-border">
              <div class="format-cells-row">
                <button
                  type="button"
                  data-testid="format-cells-border-preset-none"
                  onClick={() => applyBorderPreset('none')}
                >
                  {t('formatCells.border.none')}
                </button>
                <button
                  type="button"
                  data-testid="format-cells-border-preset-outline"
                  onClick={() => applyBorderPreset('outline')}
                >
                  {t('formatCells.border.outline')}
                </button>
              </div>
              <div class="format-cells-row">
                <For each={['top', 'right', 'bottom', 'left'] as const}>
                  {(side) => (
                    <button
                      type="button"
                      data-testid={`format-cells-border-side-${side}`}
                      class={
                        draft()?.borders?.[side]
                          ? 'format-cells-side-active'
                          : 'format-cells-side'
                      }
                      onClick={() => toggleSide(side)}
                    >
                      {t(`formatCells.border.side.${side}`)}
                    </button>
                  )}
                </For>
              </div>
              <label class="format-cells-row">
                <span>{t('formatCells.border.style')}</span>
                <select
                  data-testid="format-cells-border-style"
                  value={(() => {
                    const b = draft()?.borders
                    return b?.top?.style ?? b?.left?.style ?? 'thin'
                  })()}
                  onChange={(event) => {
                    const style = event.currentTarget.value as SpreadsheetBorderStyle
                    const current = draft()?.borders ?? {}
                    const next = { ...current }
                    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
                      if (next[side]) {
                        next[side] = { ...next[side], style }
                      }
                    }
                    patch({ borders: next })
                  }}
                >
                  <For each={BORDER_STYLES}>
                    {(value) => <option value={value}>{value}</option>}
                  </For>
                </select>
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.border.color')}</span>
                <input
                  type="color"
                  data-testid="format-cells-border-color"
                  value={(() => {
                    const b = draft()?.borders
                    return b?.top?.color ?? b?.left?.color ?? '#000000'
                  })()}
                  onInput={(event) => {
                    const color = event.currentTarget.value
                    const current = draft()?.borders ?? {}
                    const next = { ...current }
                    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
                      if (next[side]) {
                        next[side] = { ...next[side], color }
                      }
                    }
                    patch({ borders: next })
                  }}
                />
              </label>
              <div
                class="format-cells-border-preview"
                data-testid="format-cells-border-preview"
                style={{
                  'border-top': draft()?.borders?.top ? '1px solid #333' : '1px dashed #ccc',
                  'border-right': draft()?.borders?.right
                    ? '1px solid #333'
                    : '1px dashed #ccc',
                  'border-bottom': draft()?.borders?.bottom
                    ? '1px solid #333'
                    : '1px dashed #ccc',
                  'border-left': draft()?.borders?.left ? '1px solid #333' : '1px dashed #ccc',
                  padding: '12px 20px',
                  display: 'inline-block',
                }}
              >
                {t('formatCells.border.previewText')}
              </div>
            </div>
          </Show>

          <Show when={activeTab() === 'fill'}>
            <div class="format-cells-section" data-testid="format-cells-fill">
              <label class="format-cells-row">
                <span>{t('formatCells.fill.color')}</span>
                <input
                  type="color"
                  data-testid="format-cells-bg-color"
                  value={draft()?.bgColor ?? '#ffffff'}
                  onInput={(event) => patch({ bgColor: event.currentTarget.value })}
                />
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.fill.pattern')}</span>
                <select
                  data-testid="format-cells-pattern"
                  value={draft()?.fillPattern ?? 'solid'}
                  onChange={(event) => {
                    const value = event.currentTarget.value as FormatCellsDraft['fillPattern']
                    patch({ fillPattern: value })
                  }}
                >
                  <option value="solid">{t('formatCells.fill.patternSolid')}</option>
                  <option value="lined">{t('formatCells.fill.patternLined')}</option>
                  <option value="dotted">{t('formatCells.fill.patternDotted')}</option>
                  <option value="crosshatch">{t('formatCells.fill.patternCross')}</option>
                </select>
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.fill.gradientFrom')}</span>
                <input
                  type="color"
                  data-testid="format-cells-gradient-from"
                  value={draft()?.fillGradient?.from ?? '#ffffff'}
                  onInput={(event) => {
                    const from = event.currentTarget.value
                    const existing = draft()?.fillGradient ?? { from, to: '#000000', angle: 0 }
                    patch({ fillGradient: { ...existing, from } })
                  }}
                />
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.fill.gradientTo')}</span>
                <input
                  type="color"
                  data-testid="format-cells-gradient-to"
                  value={draft()?.fillGradient?.to ?? '#000000'}
                  onInput={(event) => {
                    const to = event.currentTarget.value
                    const existing = draft()?.fillGradient ?? { from: '#ffffff', to, angle: 0 }
                    patch({ fillGradient: { ...existing, to } })
                  }}
                />
              </label>
              <label class="format-cells-row">
                <span>{t('formatCells.fill.gradientAngle')}</span>
                <select
                  data-testid="format-cells-gradient-angle"
                  value={String(draft()?.fillGradient?.angle ?? 0)}
                  onChange={(event) => {
                    const angle = Number(event.currentTarget.value) as 0 | 45 | 90 | 180
                    const existing = draft()?.fillGradient ?? {
                      from: '#ffffff',
                      to: '#000000',
                      angle,
                    }
                    patch({ fillGradient: { ...existing, angle } })
                  }}
                >
                  <option value="0">0</option>
                  <option value="45">45</option>
                  <option value="90">90</option>
                  <option value="180">180</option>
                </select>
              </label>
            </div>
          </Show>
        </div>

        <div class="format-cells-actions">
          <button
            type="button"
            data-testid="format-cells-cancel"
            onClick={handleCancel}
          >
            {t('formatCells.cancel')}
          </button>
          <button
            type="button"
            data-testid="format-cells-save"
            onClick={() => {
              void handleSave()
            }}
          >
            {t('formatCells.save')}
          </button>
        </div>
      </div>
    </Show>
  )
}
