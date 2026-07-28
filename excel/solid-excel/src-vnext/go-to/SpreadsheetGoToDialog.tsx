import { For, Show, createEffect, createMemo, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeGoToAtom,
  confirmGoToAtom,
  goToErrorAtom,
  goToErrorMessageAtom,
  goToErrorParamsAtom,
  goToHistoryAtom,
  goToInputAtom,
  goToLocatorAtom,
  goToModeAtom,
  goToOpenAtom,
  goToSpecialCapabilityAtom,
  goToSpecialPendingAtom,
  goToSpecialWarningAtom,
  nameRegistryCacheAtom,
  parseGoToReference,
  runGoToSpecialScanAtom,
  selectionSnapshotAtom,
  setGoToErrorDetailsAtom,
  setGoToInputAtom,
  setGoToLocatorAtom,
  setGoToModeAtom,
  setGoToSpecialCapabilityAtom,
  setWorkspaceActiveSheetAtom,
  sheetTabsSheetsAtom,
  workspaceSessionAtom,
  type GoToLocator,
  type GoToLocatorKind,
  type GoToValueKindFilter,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'
import './go-to-dialog.css'

export interface SpreadsheetGoToDialogProps {
  class?: string
  'data-testid'?: string
}

const LOCATOR_KIND_ORDER: readonly GoToLocatorKind[] = [
  'formulas',
  'constants',
  'blanks',
  'comments',
  'conditional-format',
  'data-validation',
  'last-cell',
  'current-region',
  'visible-cells-only',
  'row-differences',
  'column-differences',
  'precedents',
  'dependents',
]

const VALUE_KIND_FILTERS: readonly { value: GoToValueKindFilter; label: string }[] = [
  { value: null, label: 'goTo.subtype.any' },
  { value: 'number', label: 'goTo.subtype.number' },
  { value: 'text', label: 'goTo.subtype.text' },
  { value: 'logical', label: 'goTo.subtype.logical' },
  { value: 'error', label: 'goTo.subtype.error' },
]

function locatorKindOf(locator: GoToLocator): GoToLocatorKind {
  return locator.kind
}

function locatorValueKind(locator: GoToLocator): GoToValueKindFilter {
  if (locator.kind === 'formulas' || locator.kind === 'constants') {
    return locator.valueKind
  }
  return null
}

function makeLocator(kind: GoToLocatorKind, valueKind: GoToValueKindFilter): GoToLocator {
  if (kind === 'formulas' || kind === 'constants') {
    return { kind, valueKind }
  }
  return { kind } as GoToLocator
}

export function SpreadsheetGoToDialog(props: SpreadsheetGoToDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()

  const isOpen = useAtomValue(goToOpenAtom)
  const mode = useAtomValue(goToModeAtom)
  const inputValue = useAtomValue(goToInputAtom)
  const locator = useAtomValue(goToLocatorAtom)
  const history = useAtomValue(goToHistoryAtom)
  const errorCode = useAtomValue(goToErrorAtom)
  const errorParams = useAtomValue(goToErrorParamsAtom)
  const errorMessage = useAtomValue(goToErrorMessageAtom)
  const specialCapability = useAtomValue(goToSpecialCapabilityAtom)
  const specialPending = useAtomValue(goToSpecialPendingAtom)
  const specialWarning = useAtomValue(goToSpecialWarningAtom)

  let inputRef: HTMLInputElement | undefined

  // Core owns open-session reset; the adapter only projects the DOM focus edge.
  createEffect<boolean>((wasOpen) => {
    const open = isOpen()
    if (open && !wasOpen) {
      queueMicrotask(() => inputRef?.focus())
    }
    return open
  }, false)

  // Capture only the host capability; execution and lifecycle remain in Core.
  createEffect(() => {
    store.setter(
      setGoToSpecialCapabilityAtom,
      typeof backend.readRangeProjection === 'function' ? 'available' : 'unavailable',
    )
  })

  // Esc closes.
  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeGoToAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  const errorText = createMemo(() => {
    const message = errorMessage()
    if (message) return message
    const code = errorCode()
    if (!code) return ''
    const params = errorParams() ?? {}
    return t(code, params)
  })

  function setMode(next: 'simple' | 'special') {
    store.setter(setGoToModeAtom, next)
  }

  function setLocatorKind(kind: GoToLocatorKind) {
    store.setter(setGoToLocatorAtom, makeLocator(kind, locatorValueKind(locator())))
  }

  function setLocatorSubKind(valueKind: GoToValueKindFilter) {
    store.setter(setGoToLocatorAtom, makeLocator(locatorKindOf(locator()), valueKind))
  }

  function reportParseError(reason: 'invalid-address' | 'unknown-name' | 'empty', raw: string) {
    const code =
      reason === 'empty'
        ? 'goTo.error.empty'
        : reason === 'unknown-name'
          ? 'goTo.error.unknownName'
          : 'goTo.error.invalidAddress'
    store.setter(setGoToErrorDetailsAtom, {
      code,
      params: { input: raw },
      message: null,
    })
  }

  function runSimpleConfirm() {
    if (specialPending()) return
    const raw = inputValue().trim()
    if (raw.length === 0) {
      reportParseError('empty', raw)
      return
    }
    const sheets = store.getter(sheetTabsSheetsAtom)
    const snap = store.getter(selectionSnapshotAtom)
    const activeSheetId =
      snap.selection.sheetId ||
      store.getter(workspaceSessionAtom).activeSheetId ||
      sheets[0]?.id ||
      ''
    const registry = store.getter(nameRegistryCacheAtom)
    const parsed = parseGoToReference(raw, {
      activeSheetId,
      sheets,
      registry,
      activeCell: snap.activeCell,
    })
    if (!parsed.ok) {
      reportParseError(parsed.reason, raw)
      return
    }
    // If the resolved sheet differs from the current active, switch first
    // so the selection commit lands on the right sheet.
    if (parsed.target.sheetId && parsed.target.sheetId !== activeSheetId) {
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: parsed.target.sheetId })
    }
    store.setter(confirmGoToAtom, {
      kind: 'simple-target',
      target: parsed.target,
      historyEntry: raw,
    })
  }

  function runSpecialConfirm() {
    if (specialPending() || specialCapability() === 'unavailable') return
    void store.setter(runGoToSpecialScanAtom, { port: backend })
  }

  function onConfirm() {
    if (mode() === 'simple') {
      runSimpleConfirm()
    } else {
      runSpecialConfirm()
    }
  }

  function onHistoryClick(entry: string) {
    store.setter(setGoToInputAtom, entry)
    queueMicrotask(() => inputRef?.focus())
  }

  function isLocatorDisabled(kind: GoToLocatorKind): boolean {
    return kind === 'precedents' || kind === 'dependents'
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`go-to-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'go-to-dialog'}
        data-active-tab={mode()}
        data-special-capability={specialCapability()}
        data-special-pending={String(specialPending())}
        data-special-warning={specialWarning()?.reason ?? 'none'}
        role="dialog"
        aria-label={t('goTo.title')}
      >
        <div class="gt-header">
          <span class="gt-title">{t('goTo.title')}</span>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="dialog-close-x"
            aria-label={t('dialog.close.label')}
            onClick={() => store.setter(closeGoToAtom)}
          >
            ×
          </button>
        </div>

        <div class="gt-tabs" role="tablist">
          <button
            type="button"
            class="gt-tab"
            role="tab"
            aria-selected={mode() === 'simple'}
            data-testid="go-to-tab-simple"
            disabled={specialPending()}
            onClick={() => setMode('simple')}
          >
            {t('goTo.simple')}
          </button>
          <button
            type="button"
            class="gt-tab"
            role="tab"
            aria-selected={mode() === 'special'}
            data-testid="go-to-tab-special"
            disabled={specialPending()}
            onClick={() => setMode('special')}
          >
            {t('goTo.special')}
          </button>
        </div>

        <Show when={mode() === 'simple'}>
          <div class="gt-body gt-body-simple" data-testid="go-to-simple-pane">
            <label class="gt-field">
              <span class="gt-field-label">{t('goTo.input.label')}</span>
              <input
                ref={inputRef}
                type="text"
                class="gt-input"
                data-testid="go-to-input"
                value={inputValue()}
                placeholder={t('goTo.input.placeholder')}
                onInput={(e) => store.setter(setGoToInputAtom, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    onConfirm()
                  }
                }}
              />
            </label>
            <div class="gt-history">
              <div class="gt-history-label">{t('goTo.history.label')}</div>
              <Show
                when={history().length > 0}
                fallback={
                  <div class="gt-history-empty" data-testid="go-to-history-empty">
                    {t('goTo.history.empty')}
                  </div>
                }
              >
                <ul class="gt-history-list" data-testid="go-to-history-list">
                  <For each={history()}>
                    {(entry) => (
                      <li>
                        <button
                          type="button"
                          class="gt-history-item"
                          data-testid="go-to-history-item"
                          onClick={() => onHistoryClick(entry)}
                        >
                          {entry}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={mode() === 'special'}>
          <div class="gt-body gt-body-special" data-testid="go-to-special-pane">
            <fieldset class="gt-locator-group" disabled={specialPending()}>
              <legend class="gt-field-label">{t('goTo.special')}</legend>
              <For each={LOCATOR_KIND_ORDER}>
                {(kind) => {
                  const disabled = isLocatorDisabled(kind)
                  const id = `go-to-locator-${kind}`
                  return (
                    <label
                      class={`gt-radio${disabled ? ' gt-radio-disabled' : ''}`}
                      title={disabled ? t('goTo.locator.disabled.dependencyGraph') : undefined}
                    >
                      <input
                        type="radio"
                        name="go-to-locator"
                        value={kind}
                        data-testid={id}
                        disabled={disabled}
                        checked={locatorKindOf(locator()) === kind}
                        onChange={() => setLocatorKind(kind)}
                      />
                      {t(`goTo.locator.${kind}`)}
                    </label>
                  )
                }}
              </For>
            </fieldset>

            <Show
              when={
                locatorKindOf(locator()) === 'formulas' || locatorKindOf(locator()) === 'constants'
              }
            >
              <label class="gt-subtype">
                <span class="gt-field-label">{t('goTo.subtype.label')}</span>
                <select
                  class="gt-select"
                  data-testid="go-to-subtype-select"
                  disabled={specialPending()}
                  value={String(locatorValueKind(locator()) ?? '')}
                  onChange={(e) => {
                    const value = e.currentTarget.value
                    setLocatorSubKind(value === '' ? null : (value as GoToValueKindFilter))
                  }}
                >
                  <For each={VALUE_KIND_FILTERS}>
                    {(opt) => <option value={String(opt.value ?? '')}>{t(opt.label)}</option>}
                  </For>
                </select>
              </label>
            </Show>

            <Show when={specialWarning()} keyed>
              {(warning) => (
                <div class="gt-truncated" data-testid="go-to-truncated">
                  <Show
                    when={warning.reason === 'regions'}
                    fallback={t('goTo.truncated.cells', { limit: warning.limit })}
                  >
                    {t('goTo.truncated.regions', { limit: warning.limit })}
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </Show>

        <Show when={errorText()}>
          <div class="gt-error" data-testid="go-to-error-text" role="alert">
            {errorText()}
          </div>
        </Show>

        <div class="gt-footer">
          <button
            type="button"
            class="gt-btn"
            data-testid="go-to-cancel-button"
            onClick={() => store.setter(closeGoToAtom)}
          >
            {t('goTo.cancel')}
          </button>
          <button
            type="button"
            class="gt-btn gt-btn-primary"
            data-testid="go-to-confirm-button"
            disabled={
              specialPending() || (mode() === 'special' && specialCapability() === 'unavailable')
            }
            onClick={onConfirm}
          >
            {t('goTo.confirm')}
          </button>
        </div>
      </div>
    </Show>
  )
}
