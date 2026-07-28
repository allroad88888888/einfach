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

  it('localizes every toolbar key used by the vNext toolbar', () => {
    const toolbarKeys = [
      'toolbar.findReplace.title',
      'toolbar.condFmt.title',
      'toolbar.dataValidation.title',
      'toolbar.filter.title',
      'toolbar.sort.title',
      'toolbar.sort.asc',
      'toolbar.sort.desc',
      'toolbar.nameManager.title',
      'toolbar.currencyDropdown',
      'toolbar.currencyDropdown.title',
      'findReplace.title',
      'findReplace.findTab',
      'findReplace.replaceTab',
      'findReplace.findWhat',
      'findReplace.prev',
      'findReplace.next',
      'findReplace.replaceWith',
      'findReplace.caseSensitive',
      'findReplace.wholeMatch',
      'findReplace.searchFormulas',
      'findReplace.regex',
      'findReplace.scope',
      'findReplace.scope.sheet',
      'findReplace.scope.workbook',
      'findReplace.scope.selection',
      'findReplace.status.searching',
      'findReplace.status.failed',
      'findReplace.status.noMatches',
      'findReplace.status.count',
      'findReplace.replaceAll',
      'findReplace.replace',
      'findReplace.close',
      'filterSort.title',
      'filterSort.sortAsc',
      'filterSort.sortDesc',
      'filterSort.clear',
      'filterSort.equals',
      'filterSort.addEquals',
      'filterSort.close',
      'conditionalFormat.title',
      'conditionalFormat.existingRules',
      'conditionalFormat.priority',
      'conditionalFormat.ruleType',
      'conditionalFormat.kind.cell-value',
      'conditionalFormat.kind.formula',
      'conditionalFormat.kind.data-bar',
      'conditionalFormat.kind.color-scale',
      'conditionalFormat.kind.top-bottom',
      'conditionalFormat.preview',
      'conditionalFormat.remove',
      'conditionalFormat.cancel',
      'conditionalFormat.save',
      'dataValidation.title',
      'dataValidation.range',
      'dataValidation.noRange',
      'dataValidation.ruleType',
      'dataValidation.rule.list',
      'dataValidation.rule.range',
      'dataValidation.rule.regex',
      'dataValidation.rule.formula',
      'dataValidation.values',
      'dataValidation.minMax',
      'dataValidation.min',
      'dataValidation.max',
      'dataValidation.pattern',
      'dataValidation.formula',
      'dataValidation.mode',
      'dataValidation.mode.warn',
      'dataValidation.mode.reject',
      'dataValidation.clear',
      'dataValidation.cancel',
      'dataValidation.save',
      'nameManager.title',
      'nameManager.name',
      'nameManager.scope',
      'nameManager.scope.workbook',
      'nameManager.refersTo',
      'nameManager.save',
      'nameManager.delete',
      'nameManager.close',
      'nameManager.error.nameRequired',
      'nameManager.error.refersToRequired',
    ]

    const t = useT()
    for (const key of toolbarKeys) {
      expect(t(key)).not.toBe(key)
    }

    setLocale('zh')
    for (const key of toolbarKeys) {
      expect(t(key)).not.toBe(key)
    }
    expect(t('toolbar.currencyDropdown')).toBe('数字')
  })
})
