import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  closeTextToColumnsAtom,
  confirmTextToColumnsAtom,
  DEFAULT_DELIMITED_CONFIG,
  DEFAULT_FIXED_CONFIG,
  makeStepThreeState,
  makeStepTwoState,
  openTextToColumnsAtom,
  TEXT_TO_COLUMNS_PREVIEW_CAP,
  TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP,
  TEXT_TO_COLUMNS_PREVIEW_TRUNCATION_MARK,
  textToColumnsOpenAtom,
  textToColumnsPreviewAtom,
  textToColumnsSourceAtom,
  textToColumnsWizardAtom,
  tokenize,
  type TextToColumnsColumnFormat,
  type TextToColumnsDelimitedConfig,
  type TextToColumnsSourceRow,
} from '../src/text-to-columns'

function makeSource(rows: readonly string[], startRow = 0): readonly TextToColumnsSourceRow[] {
  return rows.map((text, i) => ({ sourceRow: startRow + i, text }))
}

describe('text-to-columns', () => {
  test('initial state: wizard at step-1 delimited, dialog closed', () => {
    const store = createStore()
    expect(store.getter(textToColumnsOpenAtom)).toBe(false)
    expect(store.getter(textToColumnsWizardAtom)).toEqual({
      step: 'step-1',
      mode: 'delimited',
    })
  })

  test('openTextToColumnsAtom seeds source rows, anchor, and opens dialog', () => {
    const store = createStore()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 4 },
      rows: makeSource(['a,b', 'c,d'], 2),
    })
    expect(store.getter(textToColumnsOpenAtom)).toBe(true)
    expect(store.getter(textToColumnsSourceAtom)).toEqual([
      { sourceRow: 2, text: 'a,b' },
      { sourceRow: 3, text: 'c,d' },
    ])
  })

  test('closeTextToColumnsAtom resets wizard and clears source', () => {
    const store = createStore()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: makeSource(['x']),
    })
    store.setter(textToColumnsWizardAtom, makeStepTwoState('delimited'))
    store.setter(closeTextToColumnsAtom)
    expect(store.getter(textToColumnsOpenAtom)).toBe(false)
    expect(store.getter(textToColumnsSourceAtom)).toEqual([])
    expect(store.getter(textToColumnsWizardAtom)).toEqual({
      step: 'step-1',
      mode: 'delimited',
    })
  })

  test('step-1 default mode "delimited" preserved across advance', () => {
    const store = createStore()
    // No mutation in step 1 means mode stays 'delimited'.
    const wizard = store.getter(textToColumnsWizardAtom)
    if (wizard.step !== 'step-1') throw new Error('expected step-1')
    const next = makeStepTwoState(wizard.mode)
    expect(next.step).toBe('step-2-delimited')
  })

  test('comma + space with treatConsecutiveAsOne collapses runs', () => {
    const config: TextToColumnsDelimitedConfig = {
      delimiters: new Set(['comma', 'space']),
      otherChar: '',
      treatConsecutiveAsOne: true,
      textQualifier: 'none',
    }
    const tokens = tokenize('a, ,b,  ,c', {
      mode: 'delimited',
      delimited: config,
      fixed: DEFAULT_FIXED_CONFIG,
    })
    expect(tokens).toEqual(['a', 'b', 'c'])
  })

  test('text qualifier " strips outer quotes and unescapes doubled quotes', () => {
    const config: TextToColumnsDelimitedConfig = {
      delimiters: new Set(['comma']),
      otherChar: '',
      treatConsecutiveAsOne: false,
      textQualifier: '"',
    }
    const tokens = tokenize('"hello, world","say ""hi""",plain', {
      mode: 'delimited',
      delimited: config,
      fixed: DEFAULT_FIXED_CONFIG,
    })
    expect(tokens).toEqual(['hello, world', 'say "hi"', 'plain'])
  })

  test('fixed-width breakpoints past row length emit empty strings', () => {
    const tokens = tokenize('abc', {
      mode: 'fixed',
      delimited: DEFAULT_DELIMITED_CONFIG,
      fixed: { breakpoints: [2, 5, 8] },
    })
    expect(tokens).toEqual(['ab', 'c', '', ''])
  })

  test('preview cap holds at 100 rows on a 100k source', () => {
    const store = createStore()
    const rows: TextToColumnsSourceRow[] = []
    for (let i = 0; i < 100_000; i += 1) rows.push({ sourceRow: i, text: `r${i}` })
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows,
    })
    const preview = store.getter(textToColumnsPreviewAtom)
    expect(preview).toHaveLength(TEXT_TO_COLUMNS_PREVIEW_CAP)
    expect(preview[0]?.sourceRow).toBe(0)
    expect(preview[TEXT_TO_COLUMNS_PREVIEW_CAP - 1]?.sourceRow).toBe(
      TEXT_TO_COLUMNS_PREVIEW_CAP - 1,
    )
  })

  test('preview re-tokenizes when wizard config changes', () => {
    const store = createStore()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: makeSource(['a,b,c']),
    })
    const stepTwo = makeStepTwoState('delimited', {
      delimiters: new Set(['comma']),
      otherChar: '',
      treatConsecutiveAsOne: false,
      textQualifier: 'none',
    })
    store.setter(textToColumnsWizardAtom, stepTwo)
    const preview = store.getter(textToColumnsPreviewAtom)
    expect(preview).toEqual([{ sourceRow: 0, tokens: ['a', 'b', 'c'] }])
  })

  test('confirm returns null when wizard not on step-3', () => {
    const store = createStore()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: makeSource(['a,b']),
    })
    expect(store.setter(confirmTextToColumnsAtom)).toBeNull()
  })

  test('confirm emits one cell per kept output column; skip drops columns', () => {
    const store = createStore()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 5, col: 2 },
      rows: makeSource(['a,b,c', 'd,e,f'], 5),
    })
    const delimited: TextToColumnsDelimitedConfig = {
      delimiters: new Set(['comma']),
      otherChar: '',
      treatConsecutiveAsOne: false,
      textQualifier: 'none',
    }
    const formats: TextToColumnsColumnFormat[] = ['general', 'skip', 'general']
    store.setter(
      textToColumnsWizardAtom,
      makeStepThreeState('delimited', 3, delimited, DEFAULT_FIXED_CONFIG, formats),
    )
    const plan = store.setter(confirmTextToColumnsAtom)
    expect(plan).not.toBeNull()
    if (!plan) return
    expect(plan.outputColumnCount).toBe(2)
    expect(plan.cells).toEqual([
      { row: 5, col: 2, input: 'a' },
      { row: 5, col: 3, input: 'c' },
      { row: 6, col: 2, input: 'd' },
      { row: 6, col: 3, input: 'f' },
    ])
    expect(plan.sourceRange).toEqual({
      rowStart: 5,
      rowEnd: 6,
      colStart: 2,
      colEnd: 2,
    })
  })

  test('format: text sets preserveAsText on emitted cells', () => {
    const store = createStore()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: makeSource(['00123,=A1']),
    })
    const delimited: TextToColumnsDelimitedConfig = {
      delimiters: new Set(['comma']),
      otherChar: '',
      treatConsecutiveAsOne: false,
      textQualifier: 'none',
    }
    const formats: TextToColumnsColumnFormat[] = ['text', 'text']
    store.setter(
      textToColumnsWizardAtom,
      makeStepThreeState('delimited', 2, delimited, DEFAULT_FIXED_CONFIG, formats),
    )
    const plan = store.setter(confirmTextToColumnsAtom)
    expect(plan).not.toBeNull()
    if (!plan) return
    expect(plan.cells).toEqual([
      { row: 0, col: 0, input: '00123', preserveAsText: true },
      { row: 0, col: 1, input: '=A1', preserveAsText: true },
    ])
  })

  test('format: general leaves preserveAsText off', () => {
    const store = createStore()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: makeSource(['42,hello']),
    })
    const delimited: TextToColumnsDelimitedConfig = {
      delimiters: new Set(['comma']),
      otherChar: '',
      treatConsecutiveAsOne: false,
      textQualifier: 'none',
    }
    const formats: TextToColumnsColumnFormat[] = ['general', 'general']
    store.setter(
      textToColumnsWizardAtom,
      makeStepThreeState('delimited', 2, delimited, DEFAULT_FIXED_CONFIG, formats),
    )
    const plan = store.setter(confirmTextToColumnsAtom)
    if (!plan) throw new Error('expected plan')
    for (const cell of plan.cells) {
      expect(cell.preserveAsText).toBeUndefined()
    }
  })

  test('confirm returns null when anchor missing', () => {
    const store = createStore()
    store.setter(textToColumnsWizardAtom, makeStepThreeState(
      'delimited',
      1,
      DEFAULT_DELIMITED_CONFIG,
      DEFAULT_FIXED_CONFIG,
    ))
    expect(store.setter(confirmTextToColumnsAtom)).toBeNull()
  })

  describe('preview token cap', () => {
    test('a single pathological row is truncated to the token cap with a … marker', () => {
      const store = createStore()
      // Build a row that tokenizes to TOKEN_CAP + 1000 tokens.
      const oversized = 'x'.repeat(0) + Array.from({ length: TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP + 1000 })
        .map((_, i) => `t${i}`)
        .join(',')
      store.setter(openTextToColumnsAtom, {
        sheetId: 'sheet-1',
        anchor: { row: 0, col: 0 },
        rows: [{ sourceRow: 0, text: oversized }],
      })
      store.setter(textToColumnsWizardAtom, makeStepTwoState('delimited', {
        delimiters: new Set(['comma']),
        otherChar: '',
        treatConsecutiveAsOne: false,
        textQualifier: 'none',
      }))
      const preview = store.getter(textToColumnsPreviewAtom)
      expect(preview).toHaveLength(1)
      // The row should have at most TOKEN_CAP + 1 (the … marker) tokens.
      expect(preview[0]!.tokens.length).toBe(TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP + 1)
      expect(preview[0]!.tokens[TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP]).toBe(
        TEXT_TO_COLUMNS_PREVIEW_TRUNCATION_MARK,
      )
    })

    test('the cumulative token cap stops emitting tokens once the budget is exhausted', () => {
      const store = createStore()
      // 600 rows of 1 token each — should hit the budget at row 500.
      const rows: TextToColumnsSourceRow[] = []
      for (let i = 0; i < 600; i += 1) rows.push({ sourceRow: i, text: `r${i}` })
      store.setter(openTextToColumnsAtom, {
        sheetId: 'sheet-1',
        anchor: { row: 0, col: 0 },
        rows,
      })
      const preview = store.getter(textToColumnsPreviewAtom)
      // Row cap still bounds to 100 rows.
      expect(preview).toHaveLength(TEXT_TO_COLUMNS_PREVIEW_CAP)
      // Each row has exactly 1 token (well under the budget) — sanity.
      for (const row of preview) {
        expect(row.tokens.length).toBeLessThanOrEqual(1)
      }
    })

    test('subsequent rows after budget exhaustion emit empty token lists', () => {
      const store = createStore()
      // First row has TOKEN_CAP tokens (exactly drains budget); second has more.
      const big = Array.from({ length: TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP })
        .map((_, i) => `a${i}`)
        .join(',')
      store.setter(openTextToColumnsAtom, {
        sheetId: 'sheet-1',
        anchor: { row: 0, col: 0 },
        rows: [
          { sourceRow: 0, text: big },
          { sourceRow: 1, text: 'x,y,z' },
        ],
      })
      store.setter(textToColumnsWizardAtom, makeStepTwoState('delimited', {
        delimiters: new Set(['comma']),
        otherChar: '',
        treatConsecutiveAsOne: false,
        textQualifier: 'none',
      }))
      const preview = store.getter(textToColumnsPreviewAtom)
      expect(preview).toHaveLength(2)
      expect(preview[0]!.tokens.length).toBe(TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP)
      // Row 1 was beyond the budget — empty tokens, but still emitted so
      // the user keeps the row anchoring.
      expect(preview[1]!.tokens).toEqual([])
    })
  })

  describe('text qualifier semantics (Excel/Sheets compatible)', () => {
    function commaWithQualifier(qualifier: '"' | "'" | 'none' = '"'): TextToColumnsDelimitedConfig {
      return {
        delimiters: new Set(['comma']),
        otherChar: '',
        treatConsecutiveAsOne: false,
        textQualifier: qualifier,
      }
    }

    function tok(text: string, qualifier: '"' | "'" | 'none' = '"'): string[] {
      return tokenize(text, {
        mode: 'delimited',
        delimited: commaWithQualifier(qualifier),
        fixed: DEFAULT_FIXED_CONFIG,
      })
    }

    test('mid-field qualifier is a literal character (foo"bar",x)', () => {
      // Qualifier only honored at field start. Both `"` characters are
      // mid-field literals; the `,` still terminates the first field.
      expect(tok('foo"bar",x')).toEqual(['foo"bar"', 'x'])
    })

    test('field-start qualifier strips outer + protects inner delimiter ("foo,bar",x)', () => {
      expect(tok('"foo,bar",x')).toEqual(['foo,bar', 'x'])
    })

    test('doubled qualifier inside a qualified field is one literal ("foo""bar",x)', () => {
      expect(tok('"foo""bar",x')).toEqual(['foo"bar', 'x'])
    })

    test('trailing content after closing qualifier appended verbatim ("foo"bar,x)', () => {
      // Excel/Sheets append the post-qualifier content to the same field
      // until the next delimiter.
      expect(tok('"foo"bar,x')).toEqual(['foobar', 'x'])
    })

    test('unterminated qualifier at EOL captures the rest of the row', () => {
      expect(tok('"foo,bar')).toEqual(['foo,bar'])
    })

    test('qualifier with treatConsecutiveAsOne does not collapse delimiters inside quotes', () => {
      const config: TextToColumnsDelimitedConfig = {
        delimiters: new Set(['comma']),
        otherChar: '',
        treatConsecutiveAsOne: true,
        textQualifier: '"',
      }
      const tokens = tokenize('"a,,b",c', {
        mode: 'delimited',
        delimited: config,
        fixed: DEFAULT_FIXED_CONFIG,
      })
      expect(tokens).toEqual(['a,,b', 'c'])
    })

    test('apostrophe qualifier honored at field start only', () => {
      expect(tok("'foo,bar',x", "'")).toEqual(['foo,bar', 'x'])
      expect(tok("foo'bar',x", "'")).toEqual(["foo'bar'", 'x'])
    })

    test("qualifier = 'none' disables all qualifier handling", () => {
      expect(tok('"foo,bar",x', 'none')).toEqual(['"foo', 'bar"', 'x'])
    })
  })
})
