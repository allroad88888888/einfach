import { describe, expect, test } from '@jest/globals'
import { gradeSpreadsheetError } from '../src/shared'
import type { SpreadsheetError } from '../src/shared'

describe('SpreadsheetError type compatibility', () => {
  test('legacy { code, message } satisfies SpreadsheetError', () => {
    const err: SpreadsheetError = { code: 'BACKEND_ERROR', message: 'x' }
    expect(err.code).toBe('BACKEND_ERROR')
    expect(err.severity).toBeUndefined()
    expect(err.source).toBeUndefined()
  })

  test('open-string codes are accepted', () => {
    const a: SpreadsheetError = { code: 'parse.unexpected_token', message: 'bad token' }
    const b: SpreadsheetError = { code: 'runtime.divide_by_zero', message: 'div/0' }
    expect(a.code).toBe('parse.unexpected_token')
    expect(b.code).toBe('runtime.divide_by_zero')
  })
})

describe('gradeSpreadsheetError', () => {
  test.each([
    ['BACKEND_ERROR', 'transport', 'error'],
    ['CANCELLED', 'transport', 'warning'],
    ['INVALID_FORMULA', 'parse', 'error'],
    ['FORMULA_CYCLE', 'runtime', 'error'],
    ['OUT_OF_BOUNDS', 'validation', 'warning'],
  ])('%s → source: %s, severity: %s', (code, expectedSource, expectedSeverity) => {
    const result = gradeSpreadsheetError({ code, message: 'msg' })
    expect(result.source).toBe(expectedSource)
    expect(result.severity).toBe(expectedSeverity)
    expect(result.code).toBe(code)
    expect(result.message).toBe('msg')
  })

  test('unknown code defaults to source: unknown, severity: error', () => {
    const result = gradeSpreadsheetError({ code: 'parse.unexpected_token', message: 'oops' })
    expect(result.source).toBe('unknown')
    expect(result.severity).toBe('error')
  })

  test('caller-supplied severity is preserved', () => {
    const result = gradeSpreadsheetError({
      code: 'BACKEND_ERROR',
      message: 'soft fail',
      severity: 'warning',
    })
    expect(result.severity).toBe('warning')
    expect(result.source).toBe('transport')
  })

  test('caller-supplied source is preserved', () => {
    const result = gradeSpreadsheetError({
      code: 'BACKEND_ERROR',
      message: 'msg',
      source: 'parse',
    })
    expect(result.source).toBe('parse')
    expect(result.severity).toBe('error')
  })

  test('hint is passed through', () => {
    const result = gradeSpreadsheetError({ code: 'INVALID_FORMULA', message: 'bad', hint: 'fix it' })
    expect(result.hint).toBe('fix it')
  })

  test('hint is undefined when not supplied', () => {
    const result = gradeSpreadsheetError({ code: 'INVALID_FORMULA', message: 'bad' })
    expect(result.hint).toBeUndefined()
  })
})
