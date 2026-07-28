import { describe, expect, it } from '@jest/globals'
import {
  findEnclosingFunctionCall,
  findFunctionNameFragmentAtCaret,
} from '../src/formula-functions'

describe('findFunctionNameFragmentAtCaret', () => {
  it('returns the run of identifier chars to the left of the caret', () => {
    expect(findFunctionNameFragmentAtCaret('=SU', 3)).toEqual({
      start: 1,
      end: 3,
      text: 'SU',
    })
  })

  it('returns null when caret is at index 0', () => {
    expect(findFunctionNameFragmentAtCaret('SUM', 0)).toBeNull()
  })

  it('returns null when caret is mid-identifier (next char is name-rest)', () => {
    // caret between 'S' and 'U' should not autocomplete — user is editing
    // a longer identifier.
    expect(findFunctionNameFragmentAtCaret('SUM', 1)).toBeNull()
  })

  it('returns null when the fragment is followed by `(` (signature mode, not suggest)', () => {
    expect(findFunctionNameFragmentAtCaret('=SUM(', 4)).toBeNull()
  })

  it('returns null when no identifier sits to the left', () => {
    expect(findFunctionNameFragmentAtCaret('=+', 2)).toBeNull()
    expect(findFunctionNameFragmentAtCaret('=', 1)).toBeNull()
  })

  it('stops at non-identifier delimiters', () => {
    expect(findFunctionNameFragmentAtCaret('=B2+SU', 6)).toEqual({
      start: 4,
      end: 6,
      text: 'SU',
    })
  })

  it('keeps the lower-case fragment as typed (ranking handles case)', () => {
    expect(findFunctionNameFragmentAtCaret('=su', 3)).toEqual({
      start: 1,
      end: 3,
      text: 'su',
    })
  })
})

describe('findEnclosingFunctionCall', () => {
  it('finds the function call wrapping the caret', () => {
    expect(findEnclosingFunctionCall('=SUM(', 5)).toEqual({
      name: 'SUM',
      openParen: 5,
      activeArgIndex: 0,
    })
  })

  it('counts top-level commas as arg-index bumps', () => {
    expect(findEnclosingFunctionCall('=IF(A1>0, ', 10)).toEqual({
      name: 'IF',
      openParen: 4,
      activeArgIndex: 1,
    })
    expect(findEnclosingFunctionCall('=IF(A1>0, "yes", ', 17)).toEqual({
      name: 'IF',
      openParen: 4,
      activeArgIndex: 2,
    })
  })

  it('ignores commas inside string literals', () => {
    expect(findEnclosingFunctionCall('=IF(A1, "x,y,z", ', 17)).toEqual({
      name: 'IF',
      openParen: 4,
      activeArgIndex: 2,
    })
  })

  it('returns null when the caret is not inside any open paren', () => {
    expect(findEnclosingFunctionCall('=B2+', 4)).toBeNull()
    expect(findEnclosingFunctionCall('=SUM(B2)+', 9)).toBeNull()
  })

  it('handles nested calls — the innermost open paren wins', () => {
    expect(findEnclosingFunctionCall('=IF(SUM(A1:A3)>0, ', 18)).toEqual({
      name: 'IF',
      openParen: 4,
      activeArgIndex: 1,
    })
    expect(findEnclosingFunctionCall('=IF(SUM(', 8)).toEqual({
      name: 'SUM',
      openParen: 8,
      activeArgIndex: 0,
    })
  })

  it('returns null when a `(` has no preceding name token', () => {
    expect(findEnclosingFunctionCall('=(1+2', 5)).toBeNull()
  })

  it('upper-cases the function name', () => {
    expect(findEnclosingFunctionCall('=sum(', 5)).toEqual({
      name: 'SUM',
      openParen: 5,
      activeArgIndex: 0,
    })
  })
})
