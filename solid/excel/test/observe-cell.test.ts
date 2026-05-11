/** @jsxImportSource solid-js */

import { describe, it, expect } from '@jest/globals'
import { createMemo, createRoot } from 'solid-js'
import { createSheetStore } from '../src/sheet-store'
import { createJSSheet } from '../src/js-sheet'

/**
 * Retain/release contract for `observeCell`.
 *
 * The pre-existing model created exactly one `sheet.subscribe(addr,_)`
 * per address on first reactive read and never released it — fine for
 * the typical demo but a leak for `Large Grid` (1000 rows × 26 cols),
 * where every cell the user ever scrolled past held a backend
 * subscription forever. These tests pin the new behavior:
 *
 *   - observeCell acquires; dispose releases.
 *   - Multiple observers on the same addr share one underlying handle
 *     (refcount); the underlying subscribe survives until the last
 *     dispose.
 *   - `getCell` is non-reactive — it never creates a handle, so
 *     one-shot reads (clipboard, undo recording, tests, the formula
 *     bar's Escape revert) don't leak.
 *   - The activeSubscriptionCount() probe tracks the live set, which
 *     is what the virtualization regression needed to assert.
 */

describe('createSheetStore — observeCell retain/release', () => {
  it('observeCell acquires; dispose releases', () => {
    createRoot((rootDispose) => {
      const store = createSheetStore(createJSSheet())
      expect(store.activeSubscriptionCount()).toBe(0)

      const obs = store.observeCell('A1')
      expect(store.activeSubscriptionCount()).toBe(1)

      obs.dispose()
      expect(store.activeSubscriptionCount()).toBe(0)
      rootDispose()
    })
  })

  it('refcounts: two observers on the same addr share one handle', () => {
    createRoot((rootDispose) => {
      const store = createSheetStore(createJSSheet())
      const a = store.observeCell('A1')
      const b = store.observeCell('A1')
      // One entry in the handle map (not two), proving the refcount path.
      expect(store.activeSubscriptionCount()).toBe(1)

      a.dispose()
      // Still one — `b` is keeping it alive.
      expect(store.activeSubscriptionCount()).toBe(1)

      b.dispose()
      expect(store.activeSubscriptionCount()).toBe(0)
      rootDispose()
    })
  })

  it('dispose is idempotent', () => {
    createRoot((rootDispose) => {
      const store = createSheetStore(createJSSheet())
      const obs = store.observeCell('A1')
      obs.dispose()
      obs.dispose() // must not under-flow the refcount
      expect(store.activeSubscriptionCount()).toBe(0)

      // Subsequent observers on the same addr work normally.
      const next = store.observeCell('A1')
      expect(store.activeSubscriptionCount()).toBe(1)
      next.dispose()
      rootDispose()
    })
  })

  it('value() is reactive — memo recomputes on cell change', () => {
    createRoot((rootDispose) => {
      const store = createSheetStore(createJSSheet())
      const obs = store.observeCell('A1')
      const display = createMemo(() => obs.value().display)
      expect(display()).toBe('')

      store.setNumber('A1', 42)
      expect(display()).toBe('42')

      obs.dispose()
      rootDispose()
    })
  })

  it('getCell does NOT create a handle (one-shot reads never leak)', () => {
    createRoot((rootDispose) => {
      const store = createSheetStore(createJSSheet())
      // 100 one-shot reads across distinct addresses.
      for (let i = 0; i < 100; i++) {
        store.getCell(`A${i + 1}`)
      }
      expect(store.activeSubscriptionCount()).toBe(0)
      rootDispose()
    })
  })

  it('viewport churn: 100 acquires → 99 releases leaves exactly one handle', () => {
    // Reproduces the row-virtualization regression: a Cell mounts,
    // scrolls into view, scrolls out, gets unmounted, and the handle
    // is released. Only the currently-viewed cell stays subscribed.
    createRoot((rootDispose) => {
      const store = createSheetStore(createJSSheet())
      const observers = Array.from({ length: 100 }, (_, i) =>
        store.observeCell(`A${i + 1}`)
      )
      expect(store.activeSubscriptionCount()).toBe(100)
      for (let i = 0; i < 99; i++) observers[i].dispose()
      expect(store.activeSubscriptionCount()).toBe(1)
      observers[99].dispose()
      expect(store.activeSubscriptionCount()).toBe(0)
      rootDispose()
    })
  })

  it('store.dispose tears down every still-live handle', () => {
    createRoot((rootDispose) => {
      const store = createSheetStore(createJSSheet())
      store.observeCell('A1')
      store.observeCell('B2')
      expect(store.activeSubscriptionCount()).toBe(2)
      store.dispose()
      expect(store.activeSubscriptionCount()).toBe(0)
      rootDispose()
    })
  })

  it('subscriberFireCount persists across release+reacquire', () => {
    // The fire-count counter is keyed by addr (not handle identity), so
    // releasing then re-acquiring the same address should resume the
    // count rather than reset it — the probe is "how often did the
    // backend fire for this address", not "fires per observer
    // instance".
    createRoot((rootDispose) => {
      const store = createSheetStore(createJSSheet())
      const a = store.observeCell('A1')
      // Backend may fire on subscribe-time push depending on the JS
      // sheet's behavior; capture the baseline rather than asserting 0.
      const base = store.subscriberFireCount('A1')

      store.setNumber('A1', 1)
      const afterFirst = store.subscriberFireCount('A1')
      expect(afterFirst).toBeGreaterThan(base)

      a.dispose()
      store.observeCell('A1')
      const afterRecycle = store.subscriberFireCount('A1')
      // Counter persists.
      expect(afterRecycle).toBeGreaterThanOrEqual(afterFirst)
      rootDispose()
    })
  })
})
