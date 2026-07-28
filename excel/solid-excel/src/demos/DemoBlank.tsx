
import { onCleanup } from 'solid-js'
import { Table } from '../Table'
import { createSheetStore, type SheetStore } from '../sheet-store'
import { createJSSheet } from '../js-sheet'
import { useT } from '../i18n'

/**
 * Debug-only: when the page URL has `?debug=1`, stash the active
 * SheetStore on `window.__einfachStore` so e2e specs (regression.spec.ts)
 * can introspect via `page.evaluate(() => window.__einfachStore.subscriberFireCount('A1'))`.
 * Cleared on unmount so navigating between demos doesn't leak. Off in
 * normal use (the property never exists).
 */
declare global {
  interface Window {
    __einfachStore?: SheetStore
  }
}

function exposeStoreForDebug(store: SheetStore) {
  if (typeof window === 'undefined') return
  const debug = new URLSearchParams(window.location.search).get('debug')
  if (debug !== '1' && debug !== 'render') return
  window.__einfachStore = store
  onCleanup(() => {
    if (window.__einfachStore === store) {
      delete window.__einfachStore
    }
  })
}

/**
 * Demo 1: 空白表格
 */
export function DemoBlank() {
  const t = useT()
  const store = createSheetStore(createJSSheet())
  exposeStoreForDebug(store)

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>{t('demo.blank.title')}</h3>
        <p class="demo-desc">
          {t('demo.blank.desc.beforeCode')} <code>=</code>
          {t('demo.blank.desc.beforeEnter')} <kbd>Enter</kbd>{' '}
          {t('demo.blank.desc.beforeEsc')} <kbd>Esc</kbd>{' '}
          {t('demo.blank.desc.afterEsc')}
        </p>
      </div>
      <Table store={store} rows={20} cols={10} formulaBar toolbar />
    </div>
  )
}
