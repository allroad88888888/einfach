import { describe, expect, it } from '@jest/globals'
import {
  remapIndexAfterStructuralShift,
  remapIndexSetAfterStructuralShift,
  remapRangeAfterStructuralShift,
  type BackendStructuralShift,
  type CellRange,
} from '../src'

function shift(
  kind: 'insert' | 'delete',
  index: number,
  count: number,
  axis: 'row' | 'column' = 'row',
): BackendStructuralShift {
  return { axis, kind, index, count }
}

describe('remapIndexAfterStructuralShift', () => {
  it('shifts indices at or after an insertion point up by count', () => {
    expect(remapIndexAfterStructuralShift(5, shift('insert', 2, 3))).toBe(8)
    expect(remapIndexAfterStructuralShift(2, shift('insert', 2, 3))).toBe(5)
  })

  it('keeps indices before an insertion point', () => {
    expect(remapIndexAfterStructuralShift(1, shift('insert', 2, 3))).toBe(1)
    expect(remapIndexAfterStructuralShift(0, shift('insert', 1, 1))).toBe(0)
  })

  it('shifts indices after a deleted band down by count', () => {
    expect(remapIndexAfterStructuralShift(5, shift('delete', 2, 3))).toBe(2)
    expect(remapIndexAfterStructuralShift(9, shift('delete', 0, 4))).toBe(5)
  })

  it('keeps indices before a deleted band', () => {
    expect(remapIndexAfterStructuralShift(1, shift('delete', 2, 3))).toBe(1)
  })

  it('returns null for every index inside the deleted band', () => {
    expect(remapIndexAfterStructuralShift(2, shift('delete', 2, 3))).toBeNull()
    expect(remapIndexAfterStructuralShift(3, shift('delete', 2, 3))).toBeNull()
    expect(remapIndexAfterStructuralShift(4, shift('delete', 2, 3))).toBeNull()
  })

  it('treats the first index past the deleted band as survived', () => {
    expect(remapIndexAfterStructuralShift(5, shift('delete', 2, 3))).toBe(2)
  })

  it('is axis-agnostic — the caller picks the axis to apply', () => {
    expect(remapIndexAfterStructuralShift(5, shift('delete', 2, 3, 'column'))).toBe(2)
    expect(remapIndexAfterStructuralShift(5, shift('insert', 2, 3, 'column'))).toBe(8)
  })

  it('treats non-positive or non-integer shifts as no displacement', () => {
    expect(remapIndexAfterStructuralShift(5, shift('insert', 2, 0))).toBe(5)
    expect(remapIndexAfterStructuralShift(5, shift('delete', 2, -1))).toBe(5)
    expect(remapIndexAfterStructuralShift(5, shift('delete', -2, 3))).toBe(5)
    expect(remapIndexAfterStructuralShift(5, shift('insert', 1.5, 2))).toBe(5)
  })
})

describe('remapIndexSetAfterStructuralShift', () => {
  it('shifts members at or after the insertion point and keeps the rest', () => {
    const source = new Set([0, 2, 5])
    expect(remapIndexSetAfterStructuralShift(source, shift('insert', 2, 2))).toEqual(
      new Set([0, 4, 7]),
    )
  })

  it('drops members inside a deleted band and shifts higher members', () => {
    const source = new Set([0, 2, 3, 4, 7])
    expect(remapIndexSetAfterStructuralShift(source, shift('delete', 2, 3))).toEqual(
      new Set([0, 4]),
    )
  })

  it('returns an empty set when the delete covers all members', () => {
    expect(remapIndexSetAfterStructuralShift(new Set([1, 2]), shift('delete', 0, 5))).toEqual(
      new Set(),
    )
  })

  it('never mutates the input set and always returns a new set', () => {
    const source = new Set([3])
    const result = remapIndexSetAfterStructuralShift(source, shift('insert', 0, 1))
    expect(result).not.toBe(source)
    expect(source).toEqual(new Set([3]))
    const noop = remapIndexSetAfterStructuralShift(source, shift('insert', 9, 1))
    expect(noop).not.toBe(source)
    expect(noop).toEqual(new Set([3]))
  })
})

describe('remapRangeAfterStructuralShift', () => {
  const range = (rowStart: number, rowEnd: number, colStart = 0, colEnd = 4): CellRange => ({
    rowStart,
    rowEnd,
    colStart,
    colEnd,
  })

  it('shifts the whole range when the insert is at or before its start', () => {
    expect(remapRangeAfterStructuralShift(range(3, 5), shift('insert', 1, 2))).toEqual(range(5, 7))
    expect(remapRangeAfterStructuralShift(range(3, 5), shift('insert', 3, 2))).toEqual(range(5, 7))
  })

  it('extends the range when the insert lands strictly inside it', () => {
    expect(remapRangeAfterStructuralShift(range(3, 5), shift('insert', 4, 2))).toEqual(range(3, 7))
    expect(remapRangeAfterStructuralShift(range(3, 5), shift('insert', 5, 1))).toEqual(range(3, 6))
  })

  it('keeps the range when the insert is after its end', () => {
    expect(remapRangeAfterStructuralShift(range(3, 5), shift('insert', 6, 9))).toEqual(range(3, 5))
  })

  it('keeps the range when the delete is entirely after it', () => {
    expect(remapRangeAfterStructuralShift(range(3, 5), shift('delete', 6, 2))).toEqual(range(3, 5))
  })

  it('shifts the range when the delete is entirely before it', () => {
    expect(remapRangeAfterStructuralShift(range(3, 5), shift('delete', 0, 2))).toEqual(range(1, 3))
  })

  it('shrinks the range head when the delete overlaps its start', () => {
    expect(remapRangeAfterStructuralShift(range(3, 6), shift('delete', 2, 3))).toEqual(range(2, 3))
  })

  it('shrinks the range tail when the delete overlaps its end', () => {
    expect(remapRangeAfterStructuralShift(range(3, 6), shift('delete', 5, 4))).toEqual(range(3, 4))
  })

  it('shrinks the range by count when the delete is strictly inside it', () => {
    expect(remapRangeAfterStructuralShift(range(2, 8), shift('delete', 4, 2))).toEqual(range(2, 6))
  })

  it('returns null when the delete covers the whole range extent on the axis', () => {
    expect(remapRangeAfterStructuralShift(range(3, 5), shift('delete', 3, 3))).toBeNull()
    expect(remapRangeAfterStructuralShift(range(3, 5), shift('delete', 1, 9))).toBeNull()
  })

  it('still returns single-index ranges — 1x1 collapse policy belongs to backends', () => {
    expect(remapRangeAfterStructuralShift(range(3, 4, 2, 2), shift('delete', 4, 1))).toEqual(
      range(3, 3, 2, 2),
    )
  })

  it('remaps the column axis and leaves rows untouched', () => {
    expect(
      remapRangeAfterStructuralShift(range(1, 2, 3, 6), shift('delete', 4, 2, 'column')),
    ).toEqual(range(1, 2, 3, 4))
    expect(
      remapRangeAfterStructuralShift(range(1, 2, 3, 6), shift('insert', 0, 2, 'column')),
    ).toEqual(range(1, 2, 5, 8))
  })

  it('never mutates the input range and returns a new object on no-op shifts', () => {
    const source = range(3, 5)
    const result = remapRangeAfterStructuralShift(source, shift('insert', 9, 1))
    expect(result).toEqual(range(3, 5))
    expect(result).not.toBe(source)
    expect(source).toEqual(range(3, 5))
  })
})

describe('structural remap property — random operation sequences', () => {
  // Deterministic 32-bit PRNG (mulberry32) so failures are reproducible.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('stepwise index-set remap equals positions computed on the final coordinate system', () => {
    const TRACKED = 12
    const random = mulberry32(0xe1f5)

    for (let run = 0; run < 200; run += 1) {
      // Model: array slots hold the original index they started at, or
      // null for freshly inserted slots. splice mirrors the structural op.
      const slots: Array<number | null> = Array.from({ length: TRACKED }, (_, i) => i)
      const ops: BackendStructuralShift[] = []
      const opCount = 1 + Math.floor(random() * 8)

      for (let op = 0; op < opCount; op += 1) {
        const kind = random() < 0.5 ? 'insert' : 'delete'
        // Allow indices at/past the end to exercise out-of-band ops too.
        const index = Math.floor(random() * (slots.length + 2))
        const count = 1 + Math.floor(random() * 3)
        ops.push(shift(kind, index, count))
        if (kind === 'insert') {
          slots.splice(index, 0, ...Array.from({ length: count }, () => null))
        } else {
          slots.splice(index, count)
        }
      }

      // Per-index fold must land exactly where the model says.
      for (let original = 0; original < TRACKED; original += 1) {
        let position: number | null = original
        for (const op of ops) {
          if (position === null) break
          position = remapIndexAfterStructuralShift(position, op)
        }
        const expected = slots.indexOf(original)
        expect(position).toBe(expected === -1 ? null : expected)
      }

      // Set fold must equal the set of surviving model positions.
      let indexSet = new Set<number>(Array.from({ length: TRACKED }, (_, i) => i))
      for (const op of ops) {
        indexSet = remapIndexSetAfterStructuralShift(indexSet, op)
      }
      const expectedSet = new Set<number>()
      for (let position = 0; position < slots.length; position += 1) {
        if (slots[position] !== null) expectedSet.add(position)
      }
      expect(indexSet).toEqual(expectedSet)
    }
  })
})
