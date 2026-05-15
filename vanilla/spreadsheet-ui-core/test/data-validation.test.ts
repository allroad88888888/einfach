import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  closeValidationRuleEditorAtom,
  evaluateValidationLocal,
  openValidationRuleEditorAtom,
  validationRuleEditorAtom,
  validationStatusAtom,
  type DisplayCell,
  type ValidationListRule,
  type ValidationOutcome,
  type ValidationRangeRule,
  type ValidationRegexRule,
  type ValidationFormulaRule,
} from '../src'
import { startEditingAtom } from '../src/editing'

describe('data-validation', () => {
  test('initial editor state is closed', () => {
    const store = createStore()
    expect(store.getter(validationRuleEditorAtom)).toEqual({ status: 'closed' })
  })

  test('openValidationRuleEditorAtom sets editor with range, draft, and mode', () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 2 }
    const draft: ValidationListRule = { kind: 'list', values: ['a', 'b', 'c'], dropdown: true }
    store.setter(openValidationRuleEditorAtom, { range, draft, mode: 'reject' })
    expect(store.getter(validationRuleEditorAtom)).toEqual({
      status: 'editing',
      range,
      draft,
      mode: 'reject',
    })
  })

  test('closeValidationRuleEditorAtom resets to closed', () => {
    const store = createStore()
    const range = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 2 }
    const draft: ValidationListRule = { kind: 'list', values: ['x'], dropdown: false }
    store.setter(openValidationRuleEditorAtom, { range, draft, mode: 'warn' })
    store.setter(closeValidationRuleEditorAtom)
    expect(store.getter(validationRuleEditorAtom)).toEqual({ status: 'closed' })
  })

  describe('evaluateValidationLocal — list rule', () => {
    const listRule: ValidationListRule = { kind: 'list', values: ['foo', 'bar', 'baz'], dropdown: false }

    test('returns null when input is in values', () => {
      expect(evaluateValidationLocal(listRule, 'foo')).toBeNull()
    })

    test('returns outcome with list_mismatch when input is not in values', () => {
      const outcome = evaluateValidationLocal(listRule, 'qux')
      expect(outcome).not.toBeNull()
      expect(outcome?.code).toBe('validation.list_mismatch')
      expect(outcome?.severity).toBe('error')
    })
  })

  describe('evaluateValidationLocal — range rule', () => {
    test('returns null when value is within min/max', () => {
      const rule: ValidationRangeRule = { kind: 'range', min: 10, max: 20 }
      expect(evaluateValidationLocal(rule, '15')).toBeNull()
    })

    test('returns range_out_of_bounds when value is below min', () => {
      const rule: ValidationRangeRule = { kind: 'range', min: 10, max: 20 }
      const outcome = evaluateValidationLocal(rule, '5')
      expect(outcome?.code).toBe('validation.range_out_of_bounds')
    })

    test('returns range_out_of_bounds when value is above max', () => {
      const rule: ValidationRangeRule = { kind: 'range', min: 10, max: 20 }
      const outcome = evaluateValidationLocal(rule, '25')
      expect(outcome?.code).toBe('validation.range_out_of_bounds')
    })

    test('returns range_not_integer when integerOnly and value is a float', () => {
      const rule: ValidationRangeRule = { kind: 'range', integerOnly: true }
      const outcome = evaluateValidationLocal(rule, '1.5')
      expect(outcome?.code).toBe('validation.range_not_integer')
    })

    test('returns null when integerOnly and value is an integer', () => {
      const rule: ValidationRangeRule = { kind: 'range', integerOnly: true }
      expect(evaluateValidationLocal(rule, '3')).toBeNull()
    })
  })

  describe('evaluateValidationLocal — regex rule', () => {
    test('returns regex_mismatch when pattern does not match', () => {
      const rule: ValidationRegexRule = { kind: 'regex', pattern: '^\\d+$' }
      const outcome = evaluateValidationLocal(rule, 'abc')
      expect(outcome?.code).toBe('validation.regex_mismatch')
    })

    test('returns null when pattern matches', () => {
      const rule: ValidationRegexRule = { kind: 'regex', pattern: '^\\d+$' }
      expect(evaluateValidationLocal(rule, '123')).toBeNull()
    })
  })

  describe('evaluateValidationLocal — formula rule', () => {
    test('returns null (deferred to backend)', () => {
      const rule: ValidationFormulaRule = { kind: 'formula', formula: '=ISNUMBER(A1)' }
      expect(evaluateValidationLocal(rule, 'anything')).toBeNull()
    })
  })

  describe('validationStatusAtom', () => {
    test('returns null when no editing session is active', () => {
      const store = createStore()
      expect(store.getter(validationStatusAtom)).toBeNull()
    })

    test('returns null when editor is closed during edit', () => {
      const store = createStore()
      store.setter(startEditingAtom, { sheetId: 's1', cell: { row: 0, col: 0 }, draft: 'hello', source: 'cell' })
      expect(store.getter(validationStatusAtom)).toBeNull()
    })

    test('returns outcome when editor has rule and draft mismatches', () => {
      const store = createStore()
      store.setter(startEditingAtom, { sheetId: 's1', cell: { row: 0, col: 0 }, draft: 'invalid', source: 'cell' })
      const draft: ValidationListRule = { kind: 'list', values: ['valid'], dropdown: false }
      store.setter(openValidationRuleEditorAtom, {
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        draft,
        mode: 'reject',
      })
      const outcome = store.getter(validationStatusAtom)
      expect(outcome).not.toBeNull()
      expect(outcome?.code).toBe('validation.list_mismatch')
    })

    test('returns null when draft matches list rule', () => {
      const store = createStore()
      store.setter(startEditingAtom, { sheetId: 's1', cell: { row: 0, col: 0 }, draft: 'valid', source: 'cell' })
      const draft: ValidationListRule = { kind: 'list', values: ['valid'], dropdown: false }
      store.setter(openValidationRuleEditorAtom, {
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        draft,
        mode: 'warn',
      })
      expect(store.getter(validationStatusAtom)).toBeNull()
    })
  })

  test('DisplayCell with validation field typechecks', () => {
    const outcome: ValidationOutcome = { code: 'validation.list_mismatch', severity: 'error', message: 'bad value' }
    const cell: DisplayCell = {
      row: 0,
      col: 0,
      displayValue: 'x',
      validation: outcome,
    }
    expect(cell.validation?.code).toBe('validation.list_mismatch')
    expect(cell.validation?.severity).toBe('error')
    expect(cell.validation?.message).toBe('bad value')
  })
})
