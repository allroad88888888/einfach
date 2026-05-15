import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  CONDITIONAL_FORMAT_RULES_MAX,
  closeConditionalFormatEditorAtom,
  conditionalFormatEditorAtom,
  conditionalFormatRulesCacheAtom,
  openConditionalFormatEditorAtom,
  setConditionalFormatRulesAtom,
  type CellValueRule,
  type ConditionalFormatRuleEntry,
  type DisplayCell,
} from '../src'

function makeEntry(id: string, priority = 0): ConditionalFormatRuleEntry {
  const rule: CellValueRule = {
    kind: 'cell-value',
    operator: 'eq',
    value: '1',
    format: { bold: true },
  }
  return {
    id,
    scope: { range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 } },
    priority,
    rule,
  }
}

describe('conditional-formatting', () => {
  test('initial rules cache is empty and editor is closed', () => {
    const store = createStore()
    const cache = store.getter(conditionalFormatRulesCacheAtom)
    expect(cache.rules).toHaveLength(0)
    expect(cache.sheetId).toBeNull()

    const editor = store.getter(conditionalFormatEditorAtom)
    expect(editor.open).toBe(false)
    expect(editor.ruleId).toBeNull()
    expect(editor.draft).toBeNull()
  })

  test('setConditionalFormatRulesAtom replaces cache wholesale', () => {
    const store = createStore()
    const entries = [makeEntry('r1', 0), makeEntry('r2', 1)]
    store.setter(setConditionalFormatRulesAtom, { sheetId: 'sheet-1', rules: entries })

    const cache = store.getter(conditionalFormatRulesCacheAtom)
    expect(cache.sheetId).toBe('sheet-1')
    expect(cache.rules).toHaveLength(2)
    expect(cache.rules[0].id).toBe('r1')
    expect(cache.rules[1].id).toBe('r2')
  })

  test('push beyond cap truncates to last 200 rules', () => {
    const store = createStore()
    const entries = Array.from({ length: 201 }, (_, i) => makeEntry(`r${i}`, i))
    store.setter(setConditionalFormatRulesAtom, { sheetId: 'sheet-1', rules: entries })

    const cache = store.getter(conditionalFormatRulesCacheAtom)
    expect(cache.rules).toHaveLength(CONDITIONAL_FORMAT_RULES_MAX)
    // last 200 kept → first rule in result has id r1
    expect(cache.rules[0].id).toBe('r1')
    expect(cache.rules[CONDITIONAL_FORMAT_RULES_MAX - 1].id).toBe('r200')
  })

  test('openConditionalFormatEditorAtom sets editor state with draft and editing status', () => {
    const store = createStore()
    const entry = makeEntry('r1')
    store.setter(openConditionalFormatEditorAtom, entry)

    const editor = store.getter(conditionalFormatEditorAtom)
    expect(editor.open).toBe(true)
    expect(editor.ruleId).toBe('r1')
    expect(editor.draft).toEqual(entry)
  })

  test('openConditionalFormatEditorAtom with null opens blank editor', () => {
    const store = createStore()
    store.setter(openConditionalFormatEditorAtom, null)

    const editor = store.getter(conditionalFormatEditorAtom)
    expect(editor.open).toBe(true)
    expect(editor.ruleId).toBeNull()
    expect(editor.draft).toBeNull()
  })

  test('closeConditionalFormatEditorAtom resets to closed', () => {
    const store = createStore()
    store.setter(openConditionalFormatEditorAtom, makeEntry('r1'))
    store.setter(closeConditionalFormatEditorAtom)

    const editor = store.getter(conditionalFormatEditorAtom)
    expect(editor.open).toBe(false)
    expect(editor.ruleId).toBeNull()
    expect(editor.draft).toBeNull()
  })

  test('DisplayCell with conditionalFormat typechecks alongside format field', () => {
    // compile-time typecheck only — shape is verified by TS
    const cell: DisplayCell = {
      row: 0,
      col: 0,
      displayValue: '42',
      format: { italic: true },
      conditionalFormat: { bold: true },
    }
    expect(cell.conditionalFormat?.bold).toBe(true)
    expect(cell.format?.italic).toBe(true)
  })
})
