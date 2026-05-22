import { i18n } from '@lingui/core'
import { createSignal, type Accessor } from 'solid-js'
import { messages as enMessages } from './locales/en'
import { messages as zhMessages } from './locales/zh'

/**
 * Locale switcher built on `@lingui/core`. The Lingui `i18n` instance owns
 * catalog loading + lookup; we wrap it in a Solid signal so React-style
 * reactive re-translation flows on locale change.
 *
 *   const t = useT()
 *   <h3>{t('demo.blank.title')}</h3>
 *
 *   setLocale('zh') // every JSX site reading `t(...)` re-renders
 */

export type Locale = 'en' | 'zh'

const DEFAULT_LOCALE: Locale = 'zh'

/**
 * URL `?locale=en|zh` overrides the bundled default. Used by the e2e suite
 * to force EN so legacy specs that match against English nav button labels
 * keep working without each helper toggling the LocaleSwitcher. Returns
 * `null` when the param is missing or invalid so production callers fall
 * back to DEFAULT_LOCALE.
 */
function readLocaleFromUrl(): Locale | null {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('locale')
  return value === 'en' || value === 'zh' ? value : null
}

const INITIAL_LOCALE: Locale = readLocaleFromUrl() ?? DEFAULT_LOCALE

// Lingui catalog setup happens once at module load. Side effect, but the
// alternative (caller calls a `setupI18n()` initializer) just moves the same
// import-order requirement onto the demo entry point.
i18n.load({ en: enMessages, zh: zhMessages })
i18n.activate(INITIAL_LOCALE)

const [localeSignal, setLocaleSignal] = createSignal<Locale>(INITIAL_LOCALE)

/** Current active locale as a Solid accessor. */
export const locale: Accessor<Locale> = localeSignal

/**
 * Switch the active locale. Updates both the Lingui catalog selection AND
 * the Solid signal, so JSX sites reading `t(id)` re-translate on the same
 * tick. No-op if `next` is already active.
 */
export function setLocale(next: Locale): void {
  if (localeSignal() === next) return
  i18n.activate(next)
  setLocaleSignal(next)
}

/**
 * Reactive translator factory. The returned function reads the `locale`
 * signal on every call, so Solid's reactive tracking picks it up — JSX
 * sites like `<h3>{t('demo.blank.title')}</h3>` re-evaluate on
 * `setLocale(...)`.
 *
 * Missing keys fall back to the msgId itself (Lingui default), so a typo
 * is visible at runtime rather than silently rendering empty.
 */
export function useT(): (id: string, values?: Record<string, unknown>) => string {
  return (id: string, values?: Record<string, unknown>) => {
    localeSignal() // dep — reactivity hook for Solid
    // Lingui interprets `{name}` as ICU placeholders and strips them when no
    // values are supplied (so `_( 'a {x} b' )` returns `'a  b'`, breaking any
    // downstream `.replace()`). Pass `values` here to let Lingui interpolate.
    return i18n._(id, values)
  }
}
