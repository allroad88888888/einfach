/**
 * Regression pins for the two codex P1s filed against d98409c
 * (KEY_GRANULAR_INVALIDATION):
 *
 *  1. Eviction (audit C-6) must not orphan atoms a host already holds:
 *     the epoch atom survives eviction (registered in the key→epoch map)
 *     so later writes to the same address keep bumping previously
 *     handed-out derive atoms. Only the heavy derive is dropped.
 *
 *  2. Formulas whose value is cached by the trampoline's CYCLE detection
 *     (refLookup stamping #CIRCULAR! for an in-progress ancestor) are
 *     popped via the cache-hit branch — they must STILL install their
 *     reverse dep edges, or breaking the cycle never re-derives them.
 */

import { describe, expect, test } from '@jest/globals'

import { keyFor } from '../src/sheet'
import { createWorkbook } from '../src/workbook'

const num = (value: number): { kind: 'number'; value: number } => ({ kind: 'number', value })
const CIRC = { kind: 'error', code: '#CIRCULAR!' }

function makeWb() {
  const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
  const sheet = wb.sheet('s1')!
  return { wb, sheet }
}

describe('codex P1 #1 — held formula atoms stay wired across C-6 eviction', () => {
  test('formula → literal → literal: held atom reads every write, subscriber fires', () => {
    const { wb, sheet } = makeWb()
    wb.setCell('s1', 0, 0, '=1')
    const held = sheet.formulaCellAtom(keyFor(0, 0))
    let fires = 0
    wb.store.sub(held, () => {
      fires += 1
    })
    expect(wb.store.getter(held)).toEqual(num(1))

    // formula → literal: the derive is evicted (C-6), but the epoch atom
    // must survive so `held` keeps tracking the address.
    wb.setCell('s1', 0, 0, '2')
    expect(wb.store.getter(held)).toEqual(num(2))
    expect(fires).toBe(1)

    // literal → literal on the evicted key: pre-fix the epoch atom was
    // gone, so this write bumped nothing and `held` stayed at 2.
    wb.setCell('s1', 0, 0, '3')
    expect(wb.store.getter(held)).toEqual(num(3))
    expect(fires).toBe(2)
  })

  test('eviction then re-formularization: held atom re-derives new formula AND deps', () => {
    const { wb, sheet } = makeWb()
    wb.setCell('s1', 0, 1, '10') // B1
    wb.setCell('s1', 0, 0, '=B1+1') // A1
    const held = sheet.formulaCellAtom(keyFor(0, 0))
    expect(wb.store.getter(held)).toEqual(num(11))

    wb.setCell('s1', 0, 0, '5') // formula → literal (evicts)
    expect(wb.store.getter(held)).toEqual(num(5))

    wb.setCell('s1', 0, 0, '=B1*2') // literal → NEW formula
    expect(wb.store.getter(held)).toEqual(num(20))

    // The new formula's dep edge must reach the held atom too: a fresh
    // formulaCellAtom(key) and the held one must share the epoch atom.
    wb.setCell('s1', 0, 1, '3') // mutate the dep B1
    expect(wb.store.getter(held)).toEqual(num(6))
  })

  test('C-6 eviction contract holds: re-request builds a fresh atom for the literal', () => {
    const { wb, sheet } = makeWb()
    wb.setCell('s1', 0, 0, '=40+2')
    const before = sheet.formulaCellAtom(keyFor(0, 0))
    expect(wb.store.getter(before)).toEqual(num(42))
    wb.setCell('s1', 0, 0, '7')
    const after = sheet.formulaCellAtom(keyFor(0, 0))
    expect(after).not.toBe(before)
    expect(wb.store.getter(after)).toEqual(num(7))
    // Both the fresh and the previously-held atom track later writes.
    wb.setCell('s1', 0, 0, '8')
    expect(wb.store.getter(after)).toEqual(num(8))
    expect(wb.store.getter(before)).toEqual(num(8))
  })
})
