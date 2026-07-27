import { describe, expect, test } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import {
  captureTextToColumnsCapabilityAtom,
  closeTextToColumnsAtom,
  confirmTextToColumnsAtom,
  DEFAULT_DELIMITED_CONFIG,
  DEFAULT_FIXED_CONFIG,
  dispatchTextToColumnsIntentAtom,
  makeStepTwoState,
  makeStepThreeState,
  nextTextToColumnsRequestId,
  nextTextToColumnsSessionId,
  openTextToColumnsAtom,
  runTextToColumnsEntrypointAtom,
  runTextToColumnsFinishAtom,
  TEXT_TO_COLUMNS_ENTRYPOINT_RESULT_ERROR,
  TEXT_TO_COLUMNS_ENTRYPOINT_SESSION_ERROR,
  TEXT_TO_COLUMNS_ENTRYPOINT_STALE_ERROR,
  TEXT_TO_COLUMNS_ENTRYPOINT_TARGET_ERROR,
  TEXT_TO_COLUMNS_ENTRYPOINT_TRANSPORT_ERROR_PREFIX,
  TEXT_TO_COLUMNS_PREVIEW_CAP,
  TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP,
  TEXT_TO_COLUMNS_PREVIEW_TRUNCATION_MARK,
  textToColumnsCanCloseAtom,
  textToColumnsCanFinishAtom,
  textToColumnsCanGoNextAtom,
  textToColumnsErrorAtom,
  textToColumnsEntrypointProjectionAtom,
  textToColumnsEntrypointStateAtom,
  textToColumnsHasSourceAtom,
  textToColumnsLifecycleAtom,
  textToColumnsNextBlockReasonAtom,
  textToColumnsOpenAtom,
  textToColumnsPreviewAtom,
  textToColumnsSessionIdAtom,
  textToColumnsSessionAtom,
  textToColumnsSourceAtom,
  textToColumnsWizardAtom,
  type TextToColumnsControllerPort,
  type TextToColumnsEntrypointPort,
  tokenize,
  type TextToColumnsColumnFormat,
  type TextToColumnsDelimitedConfig,
  type TextToColumnsDelimiter,
  type TextToColumnsSourceRow,
} from '../src/text-to-columns'
import type {
  BackendMutationResult,
  ImportCellChunksRequest,
  RangeProjectionRequest,
  RangeProjectionResult,
} from '../src/backend/types'
import { historyStackAtom } from '../src/history'
import { selectionAtom } from '../src/selection'
import { hideRowsAtom, setViewportFilterHiddenRowsAtom } from '../src/viewport'
import { setWorkspaceActiveSheetAtom } from '../src/workspace'

function makeSource(rows: readonly string[], startRow = 0): readonly TextToColumnsSourceRow[] {
  return rows.map((text, i) => ({ sourceRow: startRow + i, text }))
}

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

const OPEN_IS_READ_ONLY: AtomHasPublicWrite<typeof textToColumnsOpenAtom> = false
const WIZARD_IS_READ_ONLY: AtomHasPublicWrite<typeof textToColumnsWizardAtom> = false
const SESSION_ID_IS_READ_ONLY: AtomHasPublicWrite<typeof textToColumnsSessionIdAtom> = false
const SESSION_IS_READ_ONLY: AtomHasPublicWrite<typeof textToColumnsSessionAtom> = false
const LIFECYCLE_IS_READ_ONLY: AtomHasPublicWrite<typeof textToColumnsLifecycleAtom> = false
const ENTRYPOINT_STATE_IS_READ_ONLY: AtomHasPublicWrite<typeof textToColumnsEntrypointStateAtom> =
  false
const ENTRYPOINT_PROJECTION_IS_READ_ONLY: AtomHasPublicWrite<
  typeof textToColumnsEntrypointProjectionAtom
> = false

function configureDelimitedWizard(
  store: Store,
  config: TextToColumnsDelimitedConfig,
  formats?: readonly TextToColumnsColumnFormat[],
): void {
  expect(store.setter(dispatchTextToColumnsIntentAtom, { kind: 'next' })).toBe(true)
  for (const delimiter of ['tab', 'semicolon', 'comma', 'space', 'other'] as const) {
    if (DEFAULT_DELIMITED_CONFIG.delimiters.has(delimiter) !== config.delimiters.has(delimiter)) {
      expect(
        store.setter(dispatchTextToColumnsIntentAtom, {
          kind: 'toggle-delimiter',
          delimiter,
        }),
      ).toBe(true)
    }
  }
  if (config.otherChar !== DEFAULT_DELIMITED_CONFIG.otherChar) {
    expect(
      store.setter(dispatchTextToColumnsIntentAtom, {
        kind: 'set-other-char',
        value: config.otherChar,
      }),
    ).toBe(true)
  }
  if (config.treatConsecutiveAsOne !== DEFAULT_DELIMITED_CONFIG.treatConsecutiveAsOne) {
    expect(
      store.setter(dispatchTextToColumnsIntentAtom, {
        kind: 'set-treat-consecutive',
        value: config.treatConsecutiveAsOne,
      }),
    ).toBe(true)
  }
  if (config.textQualifier !== DEFAULT_DELIMITED_CONFIG.textQualifier) {
    expect(
      store.setter(dispatchTextToColumnsIntentAtom, {
        kind: 'set-text-qualifier',
        value: config.textQualifier,
      }),
    ).toBe(true)
  }
  if (formats === undefined) return
  expect(store.setter(dispatchTextToColumnsIntentAtom, { kind: 'next' })).toBe(true)
  formats.forEach((format, columnIndex) => {
    expect(
      store.setter(dispatchTextToColumnsIntentAtom, {
        kind: 'set-column-format',
        columnIndex,
        format,
      }),
    ).toBe(true)
  })
}

function openFinalSession(store: Store, sheetId = 'sheet-1'): number {
  const sessionId = store.setter(openTextToColumnsAtom, {
    sheetId,
    anchor: { row: 2, col: 4 },
    rows: makeSource(['a,b', 'c,d'], 2),
  })
  if (sessionId === null) throw new Error('expected a Text to Columns session')
  configureDelimitedWizard(
    store,
    {
      delimiters: new Set(['comma']),
      otherChar: '',
      treatConsecutiveAsOne: false,
      textQualifier: 'none',
    },
    ['general', 'general'],
  )
  return sessionId
}

function matchingAcknowledgement(request: ImportCellChunksRequest): BackendMutationResult {
  if (request.requestId === undefined || request.range === undefined) {
    throw new Error('expected request identity and target range')
  }
  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: 7,
    affectedRange: request.range,
  }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function setupEntrypointTarget(
  store: Store,
  sheetId = 'sheet-1',
  range = { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 3 },
): void {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId })
  store.setter(selectionAtom, {
    kind: range.rowStart === range.rowEnd ? 'cell' : 'range',
    sheetId,
    anchor: { row: range.rowStart, col: range.colStart },
    focus: { row: range.rowEnd, col: range.colEnd },
  })
}

function matchingEntrypointProjection(
  request: RangeProjectionRequest,
  cells: RangeProjectionResult['cells'] = [
    { row: request.range.rowStart, col: request.range.colStart, displayValue: 'a,b' },
  ],
): RangeProjectionResult {
  return {
    kind: 'range',
    sheetId: request.sheetId,
    range: { ...request.range },
    requestId: request.requestId,
    revision: 7,
    cells,
  }
}

function expectReplacementOpenBlocked(store: Store, sessionId: number): void {
  expect(
    store.setter(openTextToColumnsAtom, {
      sheetId: 'replacement-sheet',
      anchor: { row: 0, col: 0 },
      rows: makeSource(['replacement,value']),
    }),
  ).toBeNull()
  expect(store.getter(textToColumnsSessionAtom)).toMatchObject({
    sessionId,
    sheetId: 'sheet-1',
  })
}

describe('text-to-columns', () => {
  test('initial state: wizard at step-1 delimited, dialog closed', () => {
    const store = createStore()
    expect(store.getter(textToColumnsOpenAtom)).toBe(false)
    expect(store.getter(textToColumnsHasSourceAtom)).toBe(false)
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
    expect(store.getter(textToColumnsHasSourceAtom)).toBe(true)
  })

  test('public state projections are runtime-immutable and typed intents alone notify subscribers', () => {
    const store = createStore()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 4 },
      rows: makeSource(['a,b'], 2),
    })
    let wizardNotifications = 0
    const unsubscribe = store.sub(textToColumnsWizardAtom, () => {
      wizardNotifications += 1
    })

    const stepOne = store.getter(textToColumnsWizardAtom)
    expect(Object.isFrozen(stepOne)).toBe(true)
    expect(() => Object.assign(stepOne, { mode: 'fixed' })).toThrow()
    expect(store.getter(textToColumnsWizardAtom)).toBe(stepOne)
    expect(wizardNotifications).toBe(0)

    expect(store.setter(dispatchTextToColumnsIntentAtom, { kind: 'next' })).toBe(true)
    const stepTwo = store.getter(textToColumnsWizardAtom)
    if (stepTwo.step !== 'step-2-delimited') throw new Error('expected delimited step two')
    expect(wizardNotifications).toBe(1)
    expect(Object.isFrozen(stepTwo.delimited)).toBe(true)
    expect(() => Object.assign(stepTwo.delimited, { otherChar: ';' })).toThrow()
    expect(() =>
      (stepTwo.delimited.delimiters as Set<TextToColumnsDelimiter>).add('comma'),
    ).toThrow()
    expect(stepTwo.delimited.otherChar).toBe('')
    expect(Array.from(stepTwo.delimited.delimiters)).toEqual(['tab'])
    expect(wizardNotifications).toBe(1)

    expect(
      store.setter(dispatchTextToColumnsIntentAtom, { kind: 'set-other-char', value: '|' }),
    ).toBe(true)
    expect(wizardNotifications).toBe(2)
    const updated = store.getter(textToColumnsWizardAtom)
    if (updated.step !== 'step-2-delimited') throw new Error('expected delimited step two')
    expect(updated).not.toBe(stepTwo)
    expect(updated.delimited.otherChar).toBe('|')

    const source = store.getter(textToColumnsSourceAtom)
    const session = store.getter(textToColumnsSessionAtom)
    const preview = store.getter(textToColumnsPreviewAtom)
    expect(Object.isFrozen(source)).toBe(true)
    expect(Object.isFrozen(source[0])).toBe(true)
    expect(Object.isFrozen(session)).toBe(true)
    expect(Object.isFrozen(session?.anchor)).toBe(true)
    expect(Object.isFrozen(session?.sourceRange)).toBe(true)
    expect(Object.isFrozen(preview)).toBe(true)
    expect(Object.isFrozen(preview[0])).toBe(true)
    expect(Object.isFrozen(preview[0]?.tokens)).toBe(true)
    expect(() => (source as TextToColumnsSourceRow[]).push({ sourceRow: 9, text: 'x' })).toThrow()
    expect(() => (preview[0]!.tokens as string[]).push('mutated')).toThrow()
    unsubscribe()
  })

  test('exported defaults and wizard factories snapshot mutable Set and array inputs', () => {
    const externalDelimited = {
      delimiters: new Set<TextToColumnsDelimiter>(['comma']),
      otherChar: '|',
      treatConsecutiveAsOne: false,
      textQualifier: 'none' as const,
    }
    const externalFixed = { breakpoints: [2, 4] }
    const externalFormats: TextToColumnsColumnFormat[] = ['text', 'general']

    const stepTwo = makeStepTwoState('fixed', externalDelimited, externalFixed)
    const stepThree = makeStepThreeState(
      'delimited',
      2,
      externalDelimited,
      externalFixed,
      externalFormats,
    )
    externalDelimited.delimiters.add('tab')
    externalDelimited.otherChar = ';'
    externalFixed.breakpoints.push(8)
    externalFormats.push('skip')

    expect(Object.isFrozen(DEFAULT_DELIMITED_CONFIG)).toBe(true)
    expect(Object.isFrozen(DEFAULT_FIXED_CONFIG)).toBe(true)
    expect(Object.isFrozen(DEFAULT_FIXED_CONFIG.breakpoints)).toBe(true)
    expect(() =>
      (DEFAULT_DELIMITED_CONFIG.delimiters as Set<TextToColumnsDelimiter>).add('comma'),
    ).toThrow()
    expect(() => (DEFAULT_FIXED_CONFIG.breakpoints as number[]).push(1)).toThrow()

    if (stepTwo.step !== 'step-2-fixed') throw new Error('expected fixed step two')
    expect(stepTwo.fixed.breakpoints).toEqual([2, 4])
    expect(Object.isFrozen(stepTwo.fixed.breakpoints)).toBe(true)
    expect(() => (stepTwo.fixed.breakpoints as number[]).push(6)).toThrow()

    if (stepThree.step !== 'step-3') throw new Error('expected step three')
    expect(stepThree.delimited.otherChar).toBe('|')
    expect(Array.from(stepThree.delimited.delimiters)).toEqual(['comma'])
    expect(stepThree.fixed.breakpoints).toEqual([2, 4])
    expect(stepThree.formats).toEqual(['text', 'general'])
    expect(Object.isFrozen(stepThree.formats)).toBe(true)
    expect(() => (stepThree.formats as TextToColumnsColumnFormat[]).push('skip')).toThrow()
  })

  test('an open empty session is not mistaken for a valid source', () => {
    const store = createStore()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: [],
    })
    expect(store.getter(textToColumnsSessionAtom)).not.toBeNull()
    expect(store.getter(textToColumnsHasSourceAtom)).toBe(false)
  })

  test('closeTextToColumnsAtom resets wizard and clears source', () => {
    const store = createStore()
    store.setter(openTextToColumnsAtom, {
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      rows: makeSource(['x']),
    })
    expect(store.setter(dispatchTextToColumnsIntentAtom, { kind: 'next' })).toBe(true)
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
    configureDelimitedWizard(store, {
      delimiters: new Set(['comma']),
      otherChar: '',
      treatConsecutiveAsOne: false,
      textQualifier: 'none',
    })
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
    configureDelimitedWizard(store, delimited, formats)
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
    configureDelimitedWizard(store, delimited, formats)
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
    configureDelimitedWizard(store, delimited, formats)
    const plan = store.setter(confirmTextToColumnsAtom)
    if (!plan) throw new Error('expected plan')
    for (const cell of plan.cells) {
      expect(cell.preserveAsText).toBeUndefined()
    }
  })

  test('confirm returns null when anchor missing', () => {
    const store = createStore()
    expect(store.setter(confirmTextToColumnsAtom)).toBeNull()
  })

  describe('preview token cap', () => {
    test('a single pathological row is truncated to the token cap with a … marker', () => {
      const store = createStore()
      // Build a row that tokenizes to TOKEN_CAP + 1000 tokens.
      const oversized =
        'x'.repeat(0) +
        Array.from({ length: TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP + 1000 })
          .map((_, i) => `t${i}`)
          .join(',')
      store.setter(openTextToColumnsAtom, {
        sheetId: 'sheet-1',
        anchor: { row: 0, col: 0 },
        rows: [{ sourceRow: 0, text: oversized }],
      })
      configureDelimitedWizard(store, {
        delimiters: new Set(['comma']),
        otherChar: '',
        treatConsecutiveAsOne: false,
        textQualifier: 'none',
      })
      const preview = store.getter(textToColumnsPreviewAtom)
      expect(preview).toHaveLength(1)
      // The row's total cell count (including the trailing `…` marker)
      // must equal the cap exactly — the marker counts against the cap
      // so the renderer never emits more than TOKEN_CAP cells per row.
      expect(preview[0]!.tokens.length).toBe(TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP)
      expect(preview[0]!.tokens[TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP - 1]).toBe(
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
      configureDelimitedWizard(store, {
        delimiters: new Set(['comma']),
        otherChar: '',
        treatConsecutiveAsOne: false,
        textQualifier: 'none',
      })
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

  describe('Core-owned default entrypoint', () => {
    test('freezes a real projection request and opens the existing wizard session', async () => {
      const store = createStore()
      setupEntrypointTarget(store)
      const requests: RangeProjectionRequest[] = []
      const source: TextToColumnsEntrypointPort = {
        async readRangeProjection(request) {
          requests.push(request)
          return matchingEntrypointProjection(request, [
            { row: 2, col: 3, displayValue: 'first,second' },
            { row: 3, col: 3, displayValue: 'third,fourth' },
            { row: 4, col: 3, displayValue: 'fifth,sixth' },
          ])
        },
      }

      await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe('opened')

      expect(requests).toHaveLength(1)
      expect(requests[0]).toEqual({
        kind: 'range',
        sheetId: 'sheet-1',
        range: { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 3 },
        requestId: 1,
        reason: 'toolbar',
      })
      expect(requests[0].requestId).not.toBe(0)
      expect(Object.isFrozen(requests[0])).toBe(true)
      expect(Object.isFrozen(requests[0].range)).toBe(true)
      expect(store.getter(textToColumnsOpenAtom)).toBe(true)
      expect(store.getter(textToColumnsSessionAtom)).toMatchObject({
        sessionId: 1,
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 3 },
        sourceRange: { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 3 },
        rows: [
          { sourceRow: 2, text: 'first,second' },
          { sourceRow: 3, text: 'third,fourth' },
          { sourceRow: 4, text: 'fifth,sixth' },
        ],
      })
      expect(store.getter(textToColumnsEntrypointStateAtom)).toMatchObject({
        status: 'idle',
        operationId: 1,
        requestId: 1,
        sessionId: 1,
        attempt: 1,
        error: '',
      })
    })

    test('fills sparse projection rows with frozen blank source rows', async () => {
      const store = createStore()
      setupEntrypointTarget(store)
      const source: TextToColumnsEntrypointPort = {
        async readRangeProjection(request) {
          return matchingEntrypointProjection(request, [
            { row: 2, col: 3, displayValue: 'left,right' },
            { row: 4, col: 3, displayValue: 'tail,value' },
          ])
        },
      }

      await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe('opened')
      const rows = store.getter(textToColumnsSessionAtom)?.rows
      expect(rows).toEqual([
        { sourceRow: 2, text: 'left,right' },
        { sourceRow: 3, text: '' },
        { sourceRow: 4, text: 'tail,value' },
      ])
      expect(Object.isFrozen(rows)).toBe(true)
      expect(rows?.every(Object.isFrozen)).toBe(true)
    })

    test('blocks a multi-column selection before transport launch', async () => {
      const store = createStore()
      setupEntrypointTarget(store, 'sheet-1', {
        rowStart: 2,
        rowEnd: 4,
        colStart: 3,
        colEnd: 4,
      })
      let readCount = 0
      const source: TextToColumnsEntrypointPort = {
        async readRangeProjection(request) {
          readCount += 1
          return matchingEntrypointProjection(request)
        },
      }

      await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe(
        'blocked',
      )
      expect(readCount).toBe(0)
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
      expect(store.getter(textToColumnsEntrypointStateAtom)).toMatchObject({
        status: 'blocked',
        error: TEXT_TO_COLUMNS_ENTRYPOINT_TARGET_ERROR,
      })
    })

    test('does not fall back from an empty selection sheet to the workspace sheet', async () => {
      const store = createStore()
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
      let readCount = 0
      const source: TextToColumnsEntrypointPort = {
        async readRangeProjection(request) {
          readCount += 1
          return matchingEntrypointProjection(request)
        },
      }

      await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe(
        'blocked',
      )
      expect(readCount).toBe(0)
      expect(store.getter(textToColumnsEntrypointStateAtom).error).toBe(
        TEXT_TO_COLUMNS_ENTRYPOINT_TARGET_ERROR,
      )
    })

    test('an existing dialog blocks hydration before transport launch', async () => {
      const store = createStore()
      setupEntrypointTarget(store)
      expect(
        store.setter(openTextToColumnsAtom, {
          sheetId: 'sheet-1',
          anchor: { row: 2, col: 3 },
          rows: makeSource(['already,open'], 2),
        }),
      ).toBe(1)
      let readCount = 0
      const source: TextToColumnsEntrypointPort = {
        async readRangeProjection(request) {
          readCount += 1
          return matchingEntrypointProjection(request)
        },
      }

      await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe(
        'blocked',
      )
      expect(readCount).toBe(0)
      expect(store.getter(textToColumnsEntrypointStateAtom).error).toBe(
        TEXT_TO_COLUMNS_ENTRYPOINT_SESSION_ERROR,
      )
      expect(store.getter(textToColumnsEntrypointProjectionAtom).canRun).toBe(false)
    })

    test('accepts a matching projection when its optional revision is absent', async () => {
      const store = createStore()
      setupEntrypointTarget(store)
      const source: TextToColumnsEntrypointPort = {
        async readRangeProjection(request) {
          const result = matchingEntrypointProjection(request)
          const { revision: _revision, ...withoutRevision } = result
          return withoutRevision
        },
      }

      await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe('opened')
      expect(store.getter(textToColumnsOpenAtom)).toBe(true)
    })

    const entrypointMismatchCases: ReadonlyArray<{
      label: string
      mutate: (result: RangeProjectionResult, request: RangeProjectionRequest) => unknown
    }> = [
      {
        label: 'kind',
        mutate: (result) => ({ ...result, kind: 'visible-window' }),
      },
      {
        label: 'requestId',
        mutate: (result) => ({ ...result, requestId: result.requestId + 1 }),
      },
      {
        label: 'sheetId',
        mutate: (result) => ({ ...result, sheetId: 'sheet-2' }),
      },
      {
        label: 'range',
        mutate: (result) => ({
          ...result,
          range: { ...result.range, rowEnd: result.range.rowEnd + 1 },
        }),
      },
      {
        label: 'truncated result',
        mutate: (result) => ({ ...result, truncated: true }),
      },
      {
        label: 'non-boolean truncated witness',
        mutate: (result) => ({ ...result, truncated: 'false' }),
      },
      {
        label: 'empty revision',
        mutate: (result) => ({ ...result, revision: '' }),
      },
      {
        label: 'non-finite revision',
        mutate: (result) => ({ ...result, revision: Number.NaN }),
      },
      {
        label: 'out-of-bounds row',
        mutate: (result, request) => ({
          ...result,
          cells: [
            {
              row: request.range.rowEnd + 1,
              col: request.range.colStart,
              displayValue: 'outside',
            },
          ],
        }),
      },
      {
        label: 'wrong source column',
        mutate: (result, request) => ({
          ...result,
          cells: [
            {
              row: request.range.rowStart,
              col: request.range.colStart + 1,
              displayValue: 'wrong-column',
            },
          ],
        }),
      },
      {
        label: 'non-string display value',
        mutate: (result, request) => ({
          ...result,
          cells: [
            {
              row: request.range.rowStart,
              col: request.range.colStart,
              displayValue: 42,
            },
          ],
        }),
      },
      {
        label: 'duplicate source row',
        mutate: (result, request) => ({
          ...result,
          cells: [
            {
              row: request.range.rowStart,
              col: request.range.colStart,
              displayValue: 'first',
            },
            {
              row: request.range.rowStart,
              col: request.range.colStart,
              displayValue: 'duplicate',
            },
          ],
        }),
      },
    ]

    test.each(entrypointMismatchCases)(
      'rejects a projection with mismatched $label',
      async ({ mutate }) => {
        const store = createStore()
        setupEntrypointTarget(store)
        const source: TextToColumnsEntrypointPort = {
          async readRangeProjection(request) {
            return mutate(matchingEntrypointProjection(request), request) as RangeProjectionResult
          },
        }

        await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe(
          'error',
        )
        expect(store.getter(textToColumnsOpenAtom)).toBe(false)
        expect(store.getter(textToColumnsEntrypointStateAtom)).toMatchObject({
          status: 'error',
          error: TEXT_TO_COLUMNS_ENTRYPOINT_RESULT_ERROR,
        })
      },
    )

    test('reserves loading synchronously so a duplicate click is inert', async () => {
      const store = createStore()
      setupEntrypointTarget(store)
      const gate = deferred<RangeProjectionResult>()
      let request: RangeProjectionRequest | null = null
      let readCount = 0
      const source: TextToColumnsEntrypointPort = {
        readRangeProjection(nextRequest) {
          readCount += 1
          request = nextRequest
          return gate.promise
        },
      }

      const first = store.setter(runTextToColumnsEntrypointAtom, { source })
      const duplicate = store.setter(runTextToColumnsEntrypointAtom, { source })
      expect(store.getter(textToColumnsEntrypointProjectionAtom)).toMatchObject({
        status: 'loading',
        pending: true,
        disabled: true,
      })
      await expect(duplicate).resolves.toBe('loading')
      await Promise.resolve()
      expect(readCount).toBe(1)
      if (request === null) throw new Error('expected range projection request')
      gate.resolve(matchingEntrypointProjection(request))
      await expect(first).resolves.toBe('opened')
      expect(readCount).toBe(1)
    })

    test('selection drift makes the in-flight result stale without opening', async () => {
      const store = createStore()
      setupEntrypointTarget(store)
      const gate = deferred<RangeProjectionResult>()
      let request: RangeProjectionRequest | null = null
      const source: TextToColumnsEntrypointPort = {
        readRangeProjection(nextRequest) {
          request = nextRequest
          return gate.promise
        },
      }
      const outcome = store.setter(runTextToColumnsEntrypointAtom, { source })
      await Promise.resolve()
      if (request === null) throw new Error('expected range projection request')
      setupEntrypointTarget(store, 'sheet-1', {
        rowStart: 8,
        rowEnd: 10,
        colStart: 3,
        colEnd: 3,
      })
      expect(store.getter(textToColumnsEntrypointProjectionAtom)).toMatchObject({
        status: 'stale',
        target: {
          sheetId: 'sheet-1',
          range: { rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 3 },
        },
      })
      gate.resolve(matchingEntrypointProjection(request))
      await expect(outcome).resolves.toBe('stale')
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
      expect(store.getter(textToColumnsEntrypointStateAtom).error).toBe(
        TEXT_TO_COLUMNS_ENTRYPOINT_STALE_ERROR,
      )
    })

    test('workspace drift makes the in-flight result stale without opening', async () => {
      const store = createStore()
      setupEntrypointTarget(store)
      const gate = deferred<RangeProjectionResult>()
      let request: RangeProjectionRequest | null = null
      const source: TextToColumnsEntrypointPort = {
        readRangeProjection(nextRequest) {
          request = nextRequest
          return gate.promise
        },
      }
      const outcome = store.setter(runTextToColumnsEntrypointAtom, { source })
      await Promise.resolve()
      if (request === null) throw new Error('expected range projection request')
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })
      gate.resolve(matchingEntrypointProjection(request))
      await expect(outcome).resolves.toBe('stale')
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
      expect(store.getter(textToColumnsEntrypointStateAtom).status).toBe('stale')
    })

    test('dialog open/lifecycle A-to-B-to-A drift drops the old result', async () => {
      const store = createStore()
      setupEntrypointTarget(store)
      const gate = deferred<RangeProjectionResult>()
      let request: RangeProjectionRequest | null = null
      const source: TextToColumnsEntrypointPort = {
        readRangeProjection(nextRequest) {
          request = nextRequest
          return gate.promise
        },
      }
      const outcome = store.setter(runTextToColumnsEntrypointAtom, { source })
      await Promise.resolve()
      if (request === null) throw new Error('expected range projection request')
      expect(
        store.setter(openTextToColumnsAtom, {
          sheetId: 'newer-sheet',
          anchor: { row: 0, col: 0 },
          rows: makeSource(['newer,session']),
        }),
      ).toBe(1)
      store.setter(closeTextToColumnsAtom)
      const driftedSessionId = store.getter(textToColumnsSessionIdAtom)
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
      expect(store.getter(textToColumnsSessionAtom)).toBeNull()
      gate.resolve(matchingEntrypointProjection(request))
      await expect(outcome).resolves.toBe('stale')
      expect(store.getter(textToColumnsSessionIdAtom)).toBe(driftedSessionId)
      expect(store.getter(textToColumnsEntrypointStateAtom).status).toBe('stale')
    })

    test('transport error is retryable and the next attempt can recover', async () => {
      const store = createStore()
      setupEntrypointTarget(store)
      const requestIds: number[] = []
      let callCount = 0
      const source: TextToColumnsEntrypointPort = {
        async readRangeProjection(request) {
          callCount += 1
          requestIds.push(request.requestId)
          if (callCount === 1) throw new Error('projection unavailable')
          return matchingEntrypointProjection(request)
        },
      }

      await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe('error')
      expect(store.getter(textToColumnsEntrypointStateAtom)).toMatchObject({
        status: 'error',
        attempt: 1,
        error: `${TEXT_TO_COLUMNS_ENTRYPOINT_TRANSPORT_ERROR_PREFIX}projection unavailable`,
      })
      expect(store.getter(textToColumnsEntrypointProjectionAtom).canRetry).toBe(true)

      await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe('opened')
      expect(requestIds).toEqual([1, 2])
      expect(store.getter(textToColumnsEntrypointStateAtom)).toMatchObject({
        status: 'idle',
        attempt: 2,
      })
    })

    test('public entrypoint state is runtime immutable and exposes no write path', async () => {
      const store = createStore()
      setupEntrypointTarget(store)
      const gate = deferred<RangeProjectionResult>()
      let request: RangeProjectionRequest | null = null
      const source: TextToColumnsEntrypointPort = {
        readRangeProjection(nextRequest) {
          request = nextRequest
          return gate.promise
        },
      }
      const outcome = store.setter(runTextToColumnsEntrypointAtom, { source })
      const state = store.getter(textToColumnsEntrypointStateAtom)
      const projection = store.getter(textToColumnsEntrypointProjectionAtom)
      expect([ENTRYPOINT_STATE_IS_READ_ONLY, ENTRYPOINT_PROJECTION_IS_READ_ONLY]).toEqual([
        false,
        false,
      ])
      expect(Object.isFrozen(state)).toBe(true)
      expect(Object.isFrozen(state.target)).toBe(true)
      expect(Object.isFrozen(state.target?.range)).toBe(true)
      expect(Object.isFrozen(state.target?.anchor)).toBe(true)
      expect(Object.isFrozen(projection)).toBe(true)
      expect(() => {
        (state.target!.range as { rowStart: number }).rowStart = 99
      }).toThrow()
      const writeWithoutTypes = store.setter as unknown as (
        target: unknown,
        value: unknown,
      ) => unknown
      expect(() => writeWithoutTypes(textToColumnsEntrypointStateAtom, state)).toThrow()
      expect(() => writeWithoutTypes(textToColumnsEntrypointProjectionAtom, projection)).toThrow()
      await Promise.resolve()
      if (request === null) throw new Error('expected range projection request')
      gate.resolve(matchingEntrypointProjection(request))
      await expect(outcome).resolves.toBe('opened')
    })

    test('entrypoint operation and request identities are isolated per store', async () => {
      const left = createStore()
      const right = createStore()
      setupEntrypointTarget(left, 'left-sheet')
      setupEntrypointTarget(right, 'right-sheet')
      const leftRequests: RangeProjectionRequest[] = []
      const rightRequests: RangeProjectionRequest[] = []
      const sourceFor = (requests: RangeProjectionRequest[]): TextToColumnsEntrypointPort => ({
        async readRangeProjection(request) {
          requests.push(request)
          return matchingEntrypointProjection(request)
        },
      })

      await expect(
        Promise.all([
          left.setter(runTextToColumnsEntrypointAtom, { source: sourceFor(leftRequests) }),
          right.setter(runTextToColumnsEntrypointAtom, { source: sourceFor(rightRequests) }),
        ]),
      ).resolves.toEqual(['opened', 'opened'])
      expect(leftRequests[0]?.requestId).toBe(1)
      expect(rightRequests[0]?.requestId).toBe(1)
      expect(left.getter(textToColumnsEntrypointStateAtom).operationId).toBe(1)
      expect(right.getter(textToColumnsEntrypointStateAtom).operationId).toBe(1)
      expect(left.getter(textToColumnsSessionAtom)?.sheetId).toBe('left-sheet')
      expect(right.getter(textToColumnsSessionAtom)?.sheetId).toBe('right-sheet')
    })
  })

  describe('Core-owned wizard and mutation lifecycle', () => {
    test('typed intents expose a typed next-block reason and own navigation', () => {
      const store = createStore()
      expect(
        store.setter(openTextToColumnsAtom, {
          sheetId: 'sheet-1',
          anchor: { row: 2, col: 4 },
          rows: makeSource(['a,b', 'c,d'], 2),
        }),
      ).toBe(1)

      expect(store.getter(textToColumnsNextBlockReasonAtom)).toBeNull()
      expect(store.setter(dispatchTextToColumnsIntentAtom, { kind: 'next' })).toBe(true)
      expect(store.getter(textToColumnsWizardAtom).step).toBe('step-2-delimited')
      expect(store.getter(textToColumnsCanGoNextAtom)).toBe(true)

      store.setter(dispatchTextToColumnsIntentAtom, {
        kind: 'toggle-delimiter',
        delimiter: 'tab',
      })
      expect(store.getter(textToColumnsNextBlockReasonAtom)).toBe('delimiter-required')
      expect(store.getter(textToColumnsCanGoNextAtom)).toBe(false)
      expect(store.setter(dispatchTextToColumnsIntentAtom, { kind: 'next' })).toBe(false)
      expect(store.getter(textToColumnsWizardAtom).step).toBe('step-2-delimited')
    })

    test('session and request identities cross the positive exact-integer boundary without reuse', () => {
      for (const nextIdentity of [nextTextToColumnsSessionId, nextTextToColumnsRequestId]) {
        expect(nextIdentity(0)).toBe(1)
        expect(nextIdentity(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER)
        expect(nextIdentity(Number.MAX_SAFE_INTEGER)).toBe(-1)
        expect(nextIdentity(-1)).toBe(-2)
        expect(nextIdentity(Number.MIN_SAFE_INTEGER)).toBeNull()
        expect(nextIdentity(Number.NaN)).toBeNull()
      }
    })

    test('missing import capability blocks Finish without launching a transport', async () => {
      const store = createStore()
      const sessionId = openFinalSession(store)
      const source: TextToColumnsControllerPort = {}
      store.setter(captureTextToColumnsCapabilityAtom, source)

      expect(store.getter(textToColumnsCanFinishAtom)).toBe(false)
      await expect(
        store.setter(runTextToColumnsFinishAtom, {
          source,
          sessionId,
          refreshProjection: async () => undefined,
        }),
      ).resolves.toBe('blocked')
      expect(store.getter(textToColumnsLifecycleAtom).status).toBe('blocked')
      expect(store.getter(textToColumnsOpenAtom)).toBe(true)
      expect(store.getter(textToColumnsErrorAtom)).toMatch(/importCellChunks/)
    })

    test('strict acknowledgement records history, refreshes, and closes the session', async () => {
      const store = createStore()
      const sessionId = openFinalSession(store)
      const requests: ImportCellChunksRequest[] = []
      let refreshCount = 0
      const source: TextToColumnsControllerPort = {
        async importCellChunks(request) {
          requests.push(request)
          return matchingAcknowledgement(request)
        },
      }
      store.setter(captureTextToColumnsCapabilityAtom, source)

      expect(store.getter(textToColumnsCanFinishAtom)).toBe(true)
      await expect(
        store.setter(runTextToColumnsFinishAtom, {
          source,
          sessionId,
          refreshProjection: async (sheetId) => {
            expect(sheetId).toBe('sheet-1')
            refreshCount += 1
          },
        }),
      ).resolves.toBe('completed')

      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        kind: 'import-cell-chunks',
        sheetId: 'sheet-1',
        requestId: 1,
        range: { rowStart: 2, rowEnd: 3, colStart: 4, colEnd: 5 },
      })
      expect(refreshCount).toBe(1)
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
      expect(store.getter(textToColumnsLifecycleAtom).status).toBe('closed')
      expect(store.getter(historyStackAtom).entries).toEqual([
        expect.objectContaining({
          kind: 'cells.import',
          sheetId: 'sheet-1',
          projectionRevision: 7,
          affectedRange: { rowStart: 2, rowEnd: 3, colStart: 4, colEnd: 5 },
        }),
      ])
    })

    test('opaque string revision acknowledges the request without fabricating numeric history', async () => {
      const store = createStore()
      const sessionId = openFinalSession(store)
      let importCount = 0
      let refreshCount = 0
      const source: TextToColumnsControllerPort = {
        async importCellChunks(request) {
          importCount += 1
          return { ...matchingAcknowledgement(request), revision: 'opaque-r7' }
        },
      }
      store.setter(captureTextToColumnsCapabilityAtom, source)

      await expect(
        store.setter(runTextToColumnsFinishAtom, {
          source,
          sessionId,
          refreshProjection: async () => {
            refreshCount += 1
          },
        }),
      ).resolves.toBe('completed')

      expect(importCount).toBe(1)
      expect(refreshCount).toBe(1)
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    })

    test('pending, local acknowledgement, and refresh keep close guarded', async () => {
      const store = createStore()
      const sessionId = openFinalSession(store)
      const acknowledgement = deferred<BackendMutationResult>()
      const refresh = deferred<void>()
      let request: ImportCellChunksRequest | null = null
      const source: TextToColumnsControllerPort = {
        importCellChunks(nextRequest) {
          request = nextRequest
          return acknowledgement.promise
        },
      }
      store.setter(captureTextToColumnsCapabilityAtom, source)

      const outcome = store.setter(runTextToColumnsFinishAtom, {
        source,
        sessionId,
        refreshProjection: async () => refresh.promise,
      })
      expect(store.getter(textToColumnsLifecycleAtom).status).toBe('pending')
      expect(store.getter(textToColumnsCanCloseAtom)).toBe(false)

      expect([
        OPEN_IS_READ_ONLY,
        WIZARD_IS_READ_ONLY,
        SESSION_ID_IS_READ_ONLY,
        SESSION_IS_READ_ONLY,
        LIFECYCLE_IS_READ_ONLY,
      ]).toEqual([false, false, false, false, false])
      const pendingSession = store.getter(textToColumnsSessionAtom)
      const pendingLifecycle = store.getter(textToColumnsLifecycleAtom)
      const writeWithoutTypes = store.setter as unknown as (
        target: unknown,
        value: unknown,
      ) => unknown
      for (const [projection, replacement] of [
        [textToColumnsOpenAtom, false],
        [textToColumnsWizardAtom, { step: 'step-1', mode: 'delimited' }],
        [textToColumnsSessionIdAtom, sessionId + 100],
        [textToColumnsSessionAtom, null],
        [
          textToColumnsLifecycleAtom,
          { status: 'closed', sessionId: sessionId + 100, requestId: null, sheetId: null },
        ],
      ] as const) {
        expect('write' in projection).toBe(false)
        expect(() => writeWithoutTypes(projection, replacement)).toThrow()
      }
      expect(store.getter(textToColumnsSessionAtom)).toBe(pendingSession)
      expect(store.getter(textToColumnsLifecycleAtom)).toBe(pendingLifecycle)

      store.setter(closeTextToColumnsAtom)
      expect(store.getter(textToColumnsOpenAtom)).toBe(true)
      expectReplacementOpenBlocked(store, sessionId)

      await Promise.resolve()
      if (request === null) throw new Error('expected transport launch')
      acknowledgement.resolve(matchingAcknowledgement(request))
      await Promise.resolve()
      expect(store.getter(textToColumnsLifecycleAtom).status).toBe('local-acknowledged')
      expect(store.getter(textToColumnsCanCloseAtom)).toBe(false)
      store.setter(closeTextToColumnsAtom)
      expect(store.getter(textToColumnsOpenAtom)).toBe(true)
      expectReplacementOpenBlocked(store, sessionId)

      await Promise.resolve()
      expect(store.getter(textToColumnsLifecycleAtom).status).toBe('refreshing')
      expect(store.getter(textToColumnsCanCloseAtom)).toBe(false)
      store.setter(closeTextToColumnsAtom)
      expect(store.getter(textToColumnsOpenAtom)).toBe(true)
      expectReplacementOpenBlocked(store, sessionId)

      refresh.resolve()
      await expect(outcome).resolves.toBe('completed')
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
    })

    test('a rejected transport becomes outcome-unknown and cannot be resent', async () => {
      const store = createStore()
      const sessionId = openFinalSession(store)
      let importCount = 0
      const source: TextToColumnsControllerPort = {
        async importCellChunks() {
          importCount += 1
          throw new Error('connection ended after send')
        },
      }
      store.setter(captureTextToColumnsCapabilityAtom, source)
      const input = {
        source,
        sessionId,
        refreshProjection: async () => undefined,
      }

      await expect(store.setter(runTextToColumnsFinishAtom, input)).resolves.toBe('outcome-unknown')
      expect(store.getter(textToColumnsLifecycleAtom).status).toBe('outcome-unknown')
      expect(store.getter(textToColumnsCanFinishAtom)).toBe(false)
      expect(store.getter(textToColumnsErrorAtom)).toMatch(/avoid a duplicate import/)
      expect(store.getter(textToColumnsCanCloseAtom)).toBe(false)
      store.setter(closeTextToColumnsAtom)
      expect(store.getter(textToColumnsOpenAtom)).toBe(true)
      expect(
        store.setter(openTextToColumnsAtom, {
          sheetId: 'sheet-2',
          anchor: { row: 0, col: 0 },
          rows: makeSource(['new,value']),
        }),
      ).toBeNull()
      expect(store.getter(textToColumnsSessionAtom)?.sheetId).toBe('sheet-1')
      await expect(store.setter(runTextToColumnsFinishAtom, input)).resolves.toBe('outcome-unknown')
      expect(importCount).toBe(1)
    })

    test('a mismatched acknowledgement becomes outcome-unknown and cannot be resent', async () => {
      const store = createStore()
      const sessionId = openFinalSession(store)
      let importCount = 0
      const source: TextToColumnsControllerPort = {
        async importCellChunks(request) {
          importCount += 1
          return {
            ...matchingAcknowledgement(request),
            requestId: request.requestId! + 1,
          }
        },
      }
      store.setter(captureTextToColumnsCapabilityAtom, source)
      const input = {
        source,
        sessionId,
        refreshProjection: async () => undefined,
      }

      await expect(store.setter(runTextToColumnsFinishAtom, input)).resolves.toBe('outcome-unknown')
      expect(store.getter(textToColumnsErrorAtom)).toMatch(/did not match/)
      await expect(store.setter(runTextToColumnsFinishAtom, input)).resolves.toBe('outcome-unknown')
      expect(importCount).toBe(1)
      expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    })

    const acknowledgementMismatchCases: ReadonlyArray<{
      label: string
      makeAcknowledgement: (request: ImportCellChunksRequest) => BackendMutationResult
    }> = [
      {
        label: 'a different sheetId',
        makeAcknowledgement: (request) => ({
          ...matchingAcknowledgement(request),
          sheetId: 'sheet-2',
        }),
      },
      {
        label: 'a different affectedRange rowStart',
        makeAcknowledgement: (request) => ({
          ...matchingAcknowledgement(request),
          affectedRange: {
            ...request.range!,
            rowStart: request.range!.rowStart + 1,
          },
        }),
      },
      {
        label: 'a different affectedRange rowEnd',
        makeAcknowledgement: (request) => ({
          ...matchingAcknowledgement(request),
          affectedRange: {
            ...request.range!,
            rowEnd: request.range!.rowEnd + 1,
          },
        }),
      },
      {
        label: 'a different affectedRange colStart',
        makeAcknowledgement: (request) => ({
          ...matchingAcknowledgement(request),
          affectedRange: {
            ...request.range!,
            colStart: request.range!.colStart + 1,
          },
        }),
      },
      {
        label: 'a different affectedRange colEnd',
        makeAcknowledgement: (request) => ({
          ...matchingAcknowledgement(request),
          affectedRange: {
            ...request.range!,
            colEnd: request.range!.colEnd + 1,
          },
        }),
      },
      {
        label: 'no affectedRange',
        makeAcknowledgement: (request) => {
          const acknowledgement = matchingAcknowledgement(request)
          return {
            sheetId: acknowledgement.sheetId,
            requestId: acknowledgement.requestId,
            revision: acknowledgement.revision,
          }
        },
      },
      {
        label: 'no revision witness',
        makeAcknowledgement: (request) => {
          const acknowledgement = matchingAcknowledgement(request)
          return {
            sheetId: acknowledgement.sheetId,
            requestId: acknowledgement.requestId,
            affectedRange: acknowledgement.affectedRange,
          }
        },
      },
      {
        label: 'an empty revision witness',
        makeAcknowledgement: (request) => ({
          ...matchingAcknowledgement(request),
          revision: '',
        }),
      },
      {
        label: 'a NaN revision witness',
        makeAcknowledgement: (request) => ({
          ...matchingAcknowledgement(request),
          revision: Number.NaN,
        }),
      },
      {
        label: 'a positive-infinite revision witness',
        makeAcknowledgement: (request) => ({
          ...matchingAcknowledgement(request),
          revision: Number.POSITIVE_INFINITY,
        }),
      },
      {
        label: 'a negative-infinite revision witness',
        makeAcknowledgement: (request) => ({
          ...matchingAcknowledgement(request),
          revision: Number.NEGATIVE_INFINITY,
        }),
      },
    ]

    test.each(acknowledgementMismatchCases)(
      'matching requestId is not accepted when acknowledgement has $label',
      async ({ makeAcknowledgement }) => {
        const store = createStore()
        const sessionId = openFinalSession(store)
        let importCount = 0
        let refreshCount = 0
        let requestIdMatches = false
        const source: TextToColumnsControllerPort = {
          async importCellChunks(request) {
            importCount += 1
            const acknowledgement = makeAcknowledgement(request)
            requestIdMatches = acknowledgement.requestId === request.requestId
            return acknowledgement
          },
        }
        store.setter(captureTextToColumnsCapabilityAtom, source)
        const input = {
          source,
          sessionId,
          refreshProjection: async () => {
            refreshCount += 1
          },
        }

        await expect(store.setter(runTextToColumnsFinishAtom, input)).resolves.toBe(
          'outcome-unknown',
        )
        expect(requestIdMatches).toBe(true)
        expect(store.getter(textToColumnsLifecycleAtom).status).toBe('outcome-unknown')
        expect(store.getter(textToColumnsErrorAtom)).toMatch(/did not match/)
        expect(store.getter(textToColumnsOpenAtom)).toBe(true)
        expect(store.getter(textToColumnsCanFinishAtom)).toBe(false)
        expect(importCount).toBe(1)
        expect(refreshCount).toBe(0)
        expect(store.getter(historyStackAtom).entries).toHaveLength(0)

        await expect(store.setter(runTextToColumnsFinishAtom, input)).resolves.toBe(
          'outcome-unknown',
        )
        expect(importCount).toBe(1)
        expect(refreshCount).toBe(0)
        expect(store.getter(historyStackAtom).entries).toHaveLength(0)
      },
    )

    test('refresh failure retries refresh only and never duplicates import or history', async () => {
      const store = createStore()
      const sessionId = openFinalSession(store)
      let importCount = 0
      let refreshCount = 0
      const source: TextToColumnsControllerPort = {
        async importCellChunks(request) {
          importCount += 1
          return matchingAcknowledgement(request)
        },
      }
      store.setter(captureTextToColumnsCapabilityAtom, source)
      const input = {
        source,
        sessionId,
        refreshProjection: async () => {
          refreshCount += 1
          if (refreshCount === 1) throw new Error('projection unavailable')
        },
      }

      await expect(store.setter(runTextToColumnsFinishAtom, input)).resolves.toBe('error')
      expect(store.getter(textToColumnsLifecycleAtom).status).toBe('error')
      expect(store.getter(textToColumnsCanFinishAtom)).toBe(true)
      expect(store.getter(textToColumnsCanCloseAtom)).toBe(false)
      expect(store.getter(historyStackAtom).entries).toHaveLength(1)
      store.setter(closeTextToColumnsAtom)
      expect(store.getter(textToColumnsOpenAtom)).toBe(true)
      expect(
        store.setter(openTextToColumnsAtom, {
          sheetId: 'sheet-2',
          anchor: { row: 0, col: 0 },
          rows: makeSource(['new,value']),
        }),
      ).toBeNull()
      expect(store.getter(textToColumnsSessionAtom)?.sheetId).toBe('sheet-1')

      store.setter(captureTextToColumnsCapabilityAtom, {})
      expect(store.getter(textToColumnsCanFinishAtom)).toBe(true)
      await expect(
        store.setter(runTextToColumnsFinishAtom, { ...input, source: {} }),
      ).resolves.toBe('completed')
      expect(importCount).toBe(1)
      expect(refreshCount).toBe(2)
      expect(store.getter(historyStackAtom).entries).toHaveLength(1)
      expect(store.getter(textToColumnsOpenAtom)).toBe(false)
    })

    test('wrong-session and same-tick duplicate finish attempts are stale', async () => {
      const store = createStore()
      const sessionId = openFinalSession(store)
      const acknowledgement = deferred<BackendMutationResult>()
      let request: ImportCellChunksRequest | null = null
      let importCount = 0
      const source: TextToColumnsControllerPort = {
        importCellChunks(nextRequest) {
          importCount += 1
          request = nextRequest
          return acknowledgement.promise
        },
      }
      store.setter(captureTextToColumnsCapabilityAtom, source)
      const input = {
        source,
        sessionId,
        refreshProjection: async () => undefined,
      }

      await expect(
        store.setter(runTextToColumnsFinishAtom, { ...input, sessionId: sessionId + 1 }),
      ).resolves.toBe('stale')
      const first = store.setter(runTextToColumnsFinishAtom, input)
      await expect(store.setter(runTextToColumnsFinishAtom, input)).resolves.toBe('stale')
      await Promise.resolve()
      if (request === null) throw new Error('expected transport launch')
      acknowledgement.resolve(matchingAcknowledgement(request))
      await expect(first).resolves.toBe('completed')
      expect(importCount).toBe(1)
    })

    test('sessions and lifecycle remain isolated across stores', () => {
      const left = createStore()
      const right = createStore()
      const leftSessionId = openFinalSession(left, 'left-sheet')
      const rightSessionId = openFinalSession(right, 'right-sheet')
      const source: TextToColumnsControllerPort = {
        async importCellChunks(request) {
          return matchingAcknowledgement(request)
        },
      }
      left.setter(captureTextToColumnsCapabilityAtom, source)
      right.setter(captureTextToColumnsCapabilityAtom, source)

      expect(leftSessionId).toBe(1)
      expect(rightSessionId).toBe(1)
      expect(left.getter(textToColumnsSessionAtom)?.sheetId).toBe('left-sheet')
      expect(right.getter(textToColumnsSessionAtom)?.sheetId).toBe('right-sheet')
      left.setter(closeTextToColumnsAtom)
      expect(left.getter(textToColumnsOpenAtom)).toBe(false)
      expect(right.getter(textToColumnsOpenAtom)).toBe(true)
      expect(right.getter(textToColumnsLifecycleAtom)).toMatchObject({
        status: 'editing',
        sheetId: 'right-sheet',
      })
    })
  })
})

// Slice S3 hardening (design-filter-hidden-rows.md §8.1 / §11).
//
// `textToColumnsSourceRowsFromResult` builds one entry per row across the
// requested range while the projection is sparse. Once filter-hidden rows
// stop being projected (S5), each one would materialise as `text: ''` and
// be written back as an empty split, clobbering invisible data.
describe('text-to-columns × hidden rows (§8.1 dense-build hardening)', () => {
  test('counter-example: an unprojected row is materialised as a blank source row', async () => {
    // The hazard, pinned: with no guard the missing row 3 becomes '' and
    // would later be split into nothing and written back over real data.
    const store = createStore()
    setupEntrypointTarget(store)
    const source: TextToColumnsEntrypointPort = {
      async readRangeProjection(request) {
        return matchingEntrypointProjection(request, [
          { row: 2, col: 3, displayValue: 'a,b' },
          { row: 4, col: 3, displayValue: 'c,d' },
        ])
      },
    }
    await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe('opened')
    expect(store.getter(textToColumnsSessionAtom)?.rows).toEqual([
      { sourceRow: 2, text: 'a,b' },
      { sourceRow: 3, text: '' },
      { sourceRow: 4, text: 'c,d' },
    ])
  })

  test('filter-hidden rows are dropped from the source instead of becoming blanks', async () => {
    const store = createStore()
    setupEntrypointTarget(store)
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'sheet-1', rows: [3] })
    const source: TextToColumnsEntrypointPort = {
      async readRangeProjection(request) {
        return matchingEntrypointProjection(request, [
          { row: 2, col: 3, displayValue: 'a,b' },
          { row: 4, col: 3, displayValue: 'c,d' },
        ])
      },
    }
    await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe('opened')
    const session = store.getter(textToColumnsSessionAtom)
    expect(session?.rows).toEqual([
      { sourceRow: 2, text: 'a,b' },
      { sourceRow: 4, text: 'c,d' },
    ])
    // The source range still spans the selection; only the row entry is gone.
    expect(session?.sourceRange).toEqual({ rowStart: 2, rowEnd: 4, colStart: 3, colEnd: 3 })
  })

  test("another sheet's filter-hidden rows do not leak into this sheet", async () => {
    const store = createStore()
    setupEntrypointTarget(store)
    store.setter(setViewportFilterHiddenRowsAtom, { sheetId: 'other-sheet', rows: [3] })
    const source: TextToColumnsEntrypointPort = {
      async readRangeProjection(request) {
        return matchingEntrypointProjection(request, [{ row: 2, col: 3, displayValue: 'a,b' }])
      },
    }
    await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe('opened')
    expect(store.getter(textToColumnsSessionAtom)?.rows).toHaveLength(3)
  })

  test('manually hidden rows are still split — parity with Excel and with today', async () => {
    const store = createStore()
    setupEntrypointTarget(store)
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [3] })
    const source: TextToColumnsEntrypointPort = {
      async readRangeProjection(request) {
        return matchingEntrypointProjection(request, [
          { row: 2, col: 3, displayValue: 'a,b' },
          { row: 3, col: 3, displayValue: 'hidden,but,real' },
          { row: 4, col: 3, displayValue: 'c,d' },
        ])
      },
    }
    await expect(store.setter(runTextToColumnsEntrypointAtom, { source })).resolves.toBe('opened')
    expect(store.getter(textToColumnsSessionAtom)?.rows).toEqual([
      { sourceRow: 2, text: 'a,b' },
      { sourceRow: 3, text: 'hidden,but,real' },
      { sourceRow: 4, text: 'c,d' },
    ])
  })
})
