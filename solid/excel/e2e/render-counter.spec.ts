import { test, expect, type Page } from '@playwright/test'
import {
  cellDisplay,
  gotoDemo,
  guardConsoleErrors,
  renderCount,
  typeIntoCell,
} from './helpers'

/**
 * Render-counter spec — proves that the address-level subscription
 * architecture really only re-runs Cells whose display value changed.
 *
 * Two complementary observation channels:
 *
 *  1. The existing `data-render-count` probe (Cell.tsx::RENDER_COUNT_DEBUG,
 *     gated on `?debug=1`). Empirically this counter ticks ONCE per Cell
 *     mount/unmount cycle (entering/leaving edit mode bumps it). It does
 *     NOT tick on Solid's fine-grained text-update path — Solid only
 *     re-runs the `data-render-count` attribute effect when one of its
 *     tracked signals changes, and `renderCountAttr()` reads no signal.
 *     So the probe is a strict-equality witness for "the cell did NOT
 *     remount" — perfect for asserting "writing A1 left B1 alone".
 *
 *  2. A page-side MutationObserver installed via `page.addInitScript`
 *     that counts every textContent change inside `[data-cell-addr]`
 *     elements. This counts the actual user-observable re-renders
 *     (display string changed), which is what we care about when
 *     verifying "B1 recomputed exactly once because A1 changed". Exposed
 *     on `window.__cellMutations` as `Record<addr, number>`. Test infra
 *     only — not part of the app source.
 *
 * Both channels feed strict `expect(...).toBe(N)` assertions. No `>=`.
 *
 * The `?debug=1` gate is required only for channel 1. If you forget it,
 * `renderCount(page, addr)` returns NaN. The mutation-observer channel
 * works regardless of the query string but we still pass `?debug=1` for
 * consistency and so existing helper assertions don't silently degrade.
 */

const MUTATION_OBSERVER_INIT = `
(() => {
  // Hoist a counter map onto window so test code can read it back.
  const counts = Object.create(null)
  window.__cellMutations = counts

  function bumpFor(node) {
    let el = node
    while (el && el.nodeType === 1) {
      const addr = el.getAttribute && el.getAttribute('data-cell-addr')
      if (addr) {
        counts[addr] = (counts[addr] || 0) + 1
        return
      }
      el = el.parentNode
    }
  }

  // Wait until the body exists, then watch all descendants for character
  // data + childList changes. Cell display is a text node child of
  // .cell-display, so characterData fires on text edits and childList
  // fires when <Show> swaps display ↔ input.
  const start = () => {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') {
          bumpFor(m.target.parentNode)
        } else if (m.type === 'childList') {
          // Only count if the touched element is inside a cell. Adding /
          // removing the input wrapper itself isn't a "display rerender"
          // for the value, so we filter to characterData-equivalent
          // events: a textContent set on .cell-display.
          for (const added of m.addedNodes) {
            if (added.nodeType === 3 && added.parentNode &&
                added.parentNode.classList &&
                added.parentNode.classList.contains('cell-display')) {
              bumpFor(added.parentNode)
            }
          }
        }
      }
    })
    obs.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  }
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start)
})()
`

declare global {
  interface Window {
    __cellMutations?: Record<string, number>
  }
}

async function mutationCount(page: Page, addr: string): Promise<number> {
  return await page.evaluate(
    (a) => (window.__cellMutations && window.__cellMutations[a]) || 0,
    addr,
  )
}

test.describe('Solid Excel render counter (precise subscriptions)', () => {
  test.beforeEach(async ({ page }) => {
    guardConsoleErrors(page)
    await page.addInitScript(MUTATION_OBSERVER_INIT)
  })

  test('debug probe is on: renderCount returns a real number', async ({ page }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    const initial = await renderCount(page, 'A1')
    // Strict: must be a number, not NaN. NaN means the URL didn't carry
    // ?debug=1 through to the page (the most common cause of every other
    // assertion in this file silently passing or failing weirdly).
    expect(Number.isNaN(initial)).toBe(false)
    expect(typeof initial).toBe('number')
  })

  test('writing A1 does NOT re-render an unrelated B1', async ({ page }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    // Force B1 to mount once so it has a baseline counter to compare against.
    await expect(cellDisplay(page, 'B1')).toBeVisible()
    const beforeB1Probe = await renderCount(page, 'B1')
    const beforeB1Mut = await mutationCount(page, 'B1')

    await typeIntoCell(page, 'A1', '1')
    await typeIntoCell(page, 'A1', '2')
    await expect(cellDisplay(page, 'A1')).toHaveText('2')

    const afterB1Probe = await renderCount(page, 'B1')
    const afterB1Mut = await mutationCount(page, 'B1')

    // Strict equality on BOTH channels — independence is the architectural
    // guarantee. `<=` would silently mask a regression where writing A1
    // forces a global re-render.
    expect(afterB1Probe).toBe(beforeB1Probe)
    expect(afterB1Mut).toBe(beforeB1Mut)
  })

  test('a single dependency triggers exactly one downstream display update', async ({
    page,
  }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    await typeIntoCell(page, 'A1', '5')
    await typeIntoCell(page, 'B1', '=A1*2')
    await expect(cellDisplay(page, 'B1')).toHaveText('10')

    const beforeB1Mut = await mutationCount(page, 'B1')
    await typeIntoCell(page, 'A1', '3')
    await expect(cellDisplay(page, 'B1')).toHaveText('6')

    const afterB1Mut = await mutationCount(page, 'B1')
    // Exactly one display mutation. Two would mean B1's effect ran twice
    // (e.g. duplicate subscriber fire); zero would mean the subscription
    // was lost.
    expect(afterB1Mut - beforeB1Mut).toBe(1)
  })

  test('three independent writes trigger exactly three downstream display updates', async ({
    page,
  }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    await typeIntoCell(page, 'B1', '=A1+A2+A3')
    // Initial display computes to 0+0+0 = 0.
    await expect(cellDisplay(page, 'B1')).toHaveText('0')

    const beforeB1Mut = await mutationCount(page, 'B1')
    await typeIntoCell(page, 'A1', '1')
    await typeIntoCell(page, 'A2', '2')
    await typeIntoCell(page, 'A3', '3')
    await expect(cellDisplay(page, 'B1')).toHaveText('6')

    const afterB1Mut = await mutationCount(page, 'B1')
    // Three sequential writes → three distinct display values for B1
    // (1, 3, 6). No batching collapses (each commit is its own undo entry,
    // so each is its own subscriber fire), and no duplicate fires either.
    expect(afterB1Mut - beforeB1Mut).toBe(3)
  })

  test('writing the same value twice does NOT fire a downstream update', async ({
    page,
  }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    await typeIntoCell(page, 'A1', '5')
    await typeIntoCell(page, 'B1', '=A1*2')
    await expect(cellDisplay(page, 'B1')).toHaveText('10')

    // Snapshot AFTER the formula has settled and any propagation is done.
    const beforeB1Mut = await mutationCount(page, 'B1')

    // Same value again — js-sheet fires only on display diff, so B1's
    // display "10" is unchanged → no notification → no Solid re-run.
    await typeIntoCell(page, 'A1', '5')
    const afterB1Mut = await mutationCount(page, 'B1')

    // Strict equality: the value-equality fast path should be exact.
    expect(afterB1Mut).toBe(beforeB1Mut)
  })

  test('writing A2 only updates cells that read A2', async ({ page }) => {
    await gotoDemo(page, 'Blank', 'debug=1')
    await typeIntoCell(page, 'A1', '0')
    await typeIntoCell(page, 'A2', '0')
    await typeIntoCell(page, 'B1', '=A1*2') // depends on A1, NOT A2
    await typeIntoCell(page, 'C1', '=A2*2') // depends on A2, NOT A1
    await expect(cellDisplay(page, 'B1')).toHaveText('0')
    await expect(cellDisplay(page, 'C1')).toHaveText('0')

    const beforeB1Mut = await mutationCount(page, 'B1')
    const beforeC1Mut = await mutationCount(page, 'C1')

    await typeIntoCell(page, 'A2', '10')
    await expect(cellDisplay(page, 'C1')).toHaveText('20')

    const afterB1Mut = await mutationCount(page, 'B1')
    const afterC1Mut = await mutationCount(page, 'C1')

    // C1 picked up exactly one display update (its only dep, A2, changed).
    expect(afterC1Mut - beforeC1Mut).toBe(1)
    // B1 must not move at all — it doesn't depend on A2.
    expect(afterB1Mut).toBe(beforeB1Mut)
  })
})
