
import { For } from 'solid-js'
import { locale, setLocale, useT, type Locale } from './i18n'

/**
 * EN | 中 toggle. Drops two pill buttons at the top of the app header; the
 * active one is highlighted. Visually minimal — i18n isn't a feature we
 * want to draw attention to, just a switch that works.
 */
export function LocaleSwitcher() {
  const t = useT()
  const options: ReadonlyArray<{ value: Locale; key: string }> = [
    { value: 'en', key: 'locale.en' },
    { value: 'zh', key: 'locale.zh' },
  ]
  return (
    <div class="locale-switcher" role="group" aria-label="Language">
      <For each={options}>
        {(opt) => (
          <button
            type="button"
            class={`locale-btn ${locale() === opt.value ? 'locale-btn-active' : ''}`}
            aria-pressed={locale() === opt.value}
            onClick={() => setLocale(opt.value)}
          >
            {t(opt.key)}
          </button>
        )}
      </For>
    </div>
  )
}
