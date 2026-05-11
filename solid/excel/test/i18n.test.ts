import { describe, it, expect, beforeEach } from '@jest/globals'
import { createMemo, createRoot } from 'solid-js'
import { locale, setLocale, useT } from '../src/i18n'

/**
 * Step 2 — verify the i18n core contract:
 *   - useT(id) returns the EN string by default.
 *   - setLocale('zh') swaps the active catalog AND fires Solid reactive
 *     subscribers (createEffect re-runs).
 *   - Missing keys fall back to the msgId (no silent empty string).
 *
 * After each test we reset to 'en' so the module-level singleton doesn't
 * leak state across cases.
 */

beforeEach(() => {
  setLocale('en')
})

describe('i18n', () => {
  it('defaults to English', () => {
    const t = useT()
    expect(locale()).toBe('en')
    expect(t('app.title')).toBe('Einfach Excel')
  })

  it('setLocale("zh") switches the active catalog', () => {
    const t = useT()
    setLocale('zh')
    expect(locale()).toBe('zh')
    expect(t('app.title')).toBe('Einfach 表格')
  })

  it('useT result is reactive — a memo re-computes on locale change', () => {
    // `createEffect` is deferred in Solid 1.9 (next-microtask scheduler),
    // so a sync test can't observe its run count. `createMemo` is eager
    // and recomputes synchronously on dep change — better fit for
    // verifying the reactivity contract in a unit test.
    createRoot((dispose) => {
      const t = useT()
      const title = createMemo(() => t('app.title'))
      expect(title()).toBe('Einfach Excel')
      setLocale('zh')
      expect(title()).toBe('Einfach 表格')
      dispose()
    })
  })

  it('unknown msgId falls back to the id itself (no empty string)', () => {
    const t = useT()
    expect(t('does.not.exist')).toBe('does.not.exist')
  })

  it('setLocale to the active locale is a no-op (no spurious recompute)', () => {
    createRoot((dispose) => {
      const t = useT()
      let runs = 0
      const title = createMemo(() => {
        runs += 1
        return t('app.title')
      })
      title() // trigger initial compute
      expect(runs).toBe(1)
      setLocale('en') // already 'en' — must not re-fire
      title()
      expect(runs).toBe(1)
      dispose()
    })
  })
})
