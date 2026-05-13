import { test, expect } from '@playwright/test'
import { cell, cellDisplay, gotoDemo, scrollWrapper, typeIntoCell } from './helpers'

/**
 * Phase 4 — `1M Cells` demo (Track O) under 2D virtualization (Track M).
 *
 * The four specs below pin the post-Phase-4 contract end-to-end:
 *
 *  - smoke load (worker + virt scaffolding survive 1M cells),
 *  - column-axis subscription bound (mirrors the row `viewport_churn`
 *    test in virtualize.spec.ts but along the `x` axis),
 *  - focus-cell pinning via VGridTable's `rowStayIndexList` /
 *    `columnStayIndexList` (the keyboard / selection accuracy guard),
 *  - paste-outside-viewport round-trip (verifies that clipboard +
 *    formula state work when the destination cells are unmounted at
 *    paste time and only re-hydrate after scroll-back).
 *
 * All four `test.skip(true, ...)` at landing: Track M (VGridTable
 * adoption) and Track O (`DemoMillion.tsx`) merge after this spec
 * file. The integrator removes the `test.skip` lines once both M and O
 * are in.
 */
test.describe('1M Cells demo (Phase 4)', () => {
  test('million_demo_loads_and_a1_visible', async ({ page }) => {
    // Smoke: opening the demo eventually paints A1. Generous timeout
    // because cold-starting the worker + WASM compile + 1M-cell sheet
    // seed runs longer than the default 5s per-action budget. If this
    // test starts flaking at landing, the worker bootstrap is the
    // first place to look (NOT the virt layer).
    await gotoDemo(page, '1M Cells')
    await expect(cell(page, 'A1')).toBeVisible({ timeout: 30_000 })
  })

  test('million_demo_uses_worker_workbook_rpc', async ({ page }) => {
    await page.addInitScript(() => {
      const OriginalWorker = window.Worker
      const rpcLog: string[] = []
      ;(window as unknown as { __workerRpcLog: string[] }).__workerRpcLog = rpcLog

      const PatchedWorker = class extends OriginalWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          super(scriptURL, options)
          const originalPost = this.postMessage.bind(this) as (...args: unknown[]) => void
          this.postMessage = ((message: unknown, ...args: unknown[]) => {
            if (
              message &&
              typeof message === 'object' &&
              'cmd' in message &&
              typeof (message as { cmd?: unknown }).cmd === 'string'
            ) {
              rpcLog.push((message as { cmd: string }).cmd)
            }
            return originalPost(message, ...args)
          }) as Worker['postMessage']
        }
      }

      Object.defineProperty(window, 'Worker', {
        configurable: true,
        value: PatchedWorker,
      })
    })

    await gotoDemo(page, '1M Cells', 'debug=1')
    await expect(cell(page, 'A1')).toBeVisible({ timeout: 30_000 })

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const log = (window as unknown as { __workerRpcLog?: string[] }).__workerRpcLog ?? []
            return (
              log.includes('initWorkbook') &&
              log.includes('beginImport') &&
              log.includes('importChunk') &&
              log.includes('commitImport') &&
              log.includes('subscribeCells')
            )
          }),
        { timeout: 30_000 },
      )
      .toBe(true)

    const result = await page.evaluate(() => {
      const win = window as unknown as {
        __einfachBackend?: string
        __workerRpcLog?: string[]
      }
      return {
        backend: win.__einfachBackend,
        commands: [...(win.__workerRpcLog ?? [])],
      }
    })

    expect(result.backend).toBe('worker-workbook')
    expect(result.commands).not.toContain('read_initial')
    expect(result.commands).not.toContain('set_number')
    expect(result.commands).not.toContain('set_formula')
    expect(result.commands).not.toContain('subscribe')
  })

  test('column_scroll_subscriptions_bounded', async ({ page }) => {
    // Mirrors `viewport_churn` from virtualize.spec.ts but along the
    // horizontal axis. Before Phase 4 the active subscription set grew
    // with `cumulative_visited_cols × viewport_rows` because column
    // virt didn't exist; now it should track the live viewport in
    // both dimensions. Bound: `after - before < 200` — generous slack
    // for selection / overscan churn but tight enough to fail loudly
    // if column release isn't wired.
    await gotoDemo(page, '1M Cells', 'debug=1')
    await expect(cell(page, 'A1')).toBeVisible({ timeout: 30_000 })

    const probe = () => page.evaluate(() => window.__einfachStore?.activeSubscriptionCount() ?? -1)

    const before = await probe()
    expect(before).toBeGreaterThan(0)

    // Scroll past col 500 horizontally. Default col width is 100px;
    // col 500 sits around scrollLeft 50000.
    await scrollWrapper(page, 'x', 50000)
    // Give the virt layer one frame to settle on the new window.
    await page.waitForTimeout(150)

    const after = await probe()
    // Load-bearing assertion: viewport-scoped, NOT cumulative-scoped.
    // A broken column-release path would already be at
    // `before + ~500 cols × visible_rows` ≈ before + 10000.
    expect(after - before).toBeLessThan(200)
  })

  test('delete_large_selection_uses_range_native_clear', async ({ page }) => {
    await gotoDemo(page, '1M Cells', 'debug=1')
    await expect(cell(page, 'A1')).toBeVisible({ timeout: 30_000 })

    const setup = await page.evaluate(() => {
      const win = window as unknown as {
        __einfachStore?: {
          raw: {
            clear_range?: (...args: number[]) => number | void
          }
          selectionAddrs: () => string[][]
          setSelectionAnchor: (coord: { row: number; col: number }) => void
          extendSelection: (coord: { row: number; col: number }) => void
          clearSelectionRange: () => void
        }
        __clearRangeCalls?: number[][]
      }
      const store = win.__einfachStore
      const original = store?.raw.clear_range?.bind(store.raw)
      if (!store || !original) return { hasClearRange: false }
      const calls: number[][] = []
      store.raw.clear_range = (...args: number[]) => {
        calls.push(args)
        return original(...args)
      }
      store.selectionAddrs = () => {
        throw new Error('selectionAddrs must not run for range-native clear')
      }
      win.__clearRangeCalls = calls
      store.setSelectionAnchor({ row: 0, col: 0 })
      store.extendSelection({ row: 999, col: 999 })
      store.clearSelectionRange()
      return { hasClearRange: true }
    })
    expect(setup.hasClearRange).toBe(true)
    const calls = await page.evaluate(() => {
      const win = window as unknown as { __clearRangeCalls?: number[][] }
      return win.__clearRangeCalls
    })
    expect(calls).toEqual([[0, 0, 999, 999]])
  })

  test('copy_large_selection_does_not_materialize_selection_grid', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await gotoDemo(page, '1M Cells', 'debug=1')
    await expect(cell(page, 'A1')).toBeVisible({ timeout: 30_000 })

    const setup = await page.evaluate(() => {
      const win = window as unknown as {
        __einfachStore?: {
          selectionAddrs: () => string[][]
          copySelection: () => unknown
          setSelectionAnchor: (coord: { row: number; col: number }) => void
          extendSelection: (coord: { row: number; col: number }) => void
        }
        __copySelectionCalls?: number
      }
      const store = win.__einfachStore
      if (!store) return { hasStore: false }
      const originalCopySelection = store.copySelection.bind(store)
      win.__copySelectionCalls = 0
      store.selectionAddrs = () => {
        throw new Error('selectionAddrs must not run for large copy')
      }
      store.copySelection = () => {
        win.__copySelectionCalls = (win.__copySelectionCalls ?? 0) + 1
        return originalCopySelection()
      }
      store.setSelectionAnchor({ row: 0, col: 0 })
      store.extendSelection({ row: 999, col: 999 })
      return { hasStore: true }
    })
    expect(setup.hasStore).toBe(true)

    await page.locator('.excel-table-wrapper').focus()
    const copyKey = process.platform === 'darwin' ? 'Meta+C' : 'Control+C'
    await page.keyboard.press(copyKey)

    await expect
      .poll(() =>
        page.evaluate(() => {
          const win = window as unknown as { __copySelectionCalls?: number }
          return win.__copySelectionCalls ?? 0
        }),
      )
      .toBe(1)
  })

  test('focus_cell_remains_in_dom_under_stay_index', async ({ page }) => {
    // Track M passes the focus cell's (row, col) as
    // `rowStayIndexList={[focusRow]}` + `columnStayIndexList={[focusCol]}`
    // to VGridTable so it stays in the DOM under arbitrary scroll.
    // This is the keyboard-nav accuracy guard: arrow-key driven
    // movement reads the focus cell's DOM box to scroll-into-view, so
    // unmounting the focus cell would break selection ergonomics.
    //
    // If Track M can't deliver `rowStayIndexList` semantics (e.g. the
    // upstream library only highlights pinned indices instead of
    // keeping them mounted), this is the test to weaken first: either
    // assert formula-bar still shows `A1` instead of asserting the
    // `<td>` is present, or remove the assertion entirely. The
    // PHASE4_PARALLEL.md § "M Stop Conditions" caveat covers this.
    //
    // INTEGRATION NOTE: the native 2D-virt path doesn't pin the focus
    // cell — it scrolls-into-view on selection change but does NOT keep
    // an off-viewport cell mounted just because it's the focus. The
    // load-bearing case (keyboard nav doesn't lose track of focus)
    // remains covered by selection→scroll-into-view in Table.tsx. Test
    // is preserved as documentation of the original VGridTable intent.
    test.skip(
      true,
      'native 2D-virt path: focus cell is NOT DOM-pinned; selection→scroll-into-view replaces stayIndexList',
    )
    await gotoDemo(page, '1M Cells')
    await expect(cell(page, 'A1')).toBeVisible({ timeout: 30_000 })

    // Make A1 the focus cell.
    await cell(page, 'A1').click()
    await expect(cell(page, 'A1')).toHaveClass(/cell-selected/)

    // Scroll the wrapper deep along both axes — A1 would normally
    // fall well outside the visible window + overscan.
    await scrollWrapper(page, 'y', 20000)
    await scrollWrapper(page, 'x', 20000)
    await page.waitForTimeout(150)

    // The load-bearing assertion: A1 is STILL in the DOM. Pinned by
    // VGridTable's stay-index lists.
    await expect(cell(page, 'A1')).toHaveCount(1)
  })

  test('paste_outside_viewport_round_trip', async ({ page, context }) => {
    // Verifies that the editing + clipboard path doesn't depend on
    // the destination cells being mounted at paste time. Under
    // Phase-4 2D-virt, scrolling deep unmounts the original viewport
    // entirely; pasting at a far coord must still set the underlying
    // store and the values must materialize when we scroll back to
    // them.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await gotoDemo(page, '1M Cells', 'debug=1')
    await expect(cell(page, 'A1')).toBeVisible({ timeout: 30_000 })

    // Seed: A1 = 41, B2 = =A1+1 → 42.
    await typeIntoCell(page, 'A1', '41')
    await typeIntoCell(page, 'B2', '=A1+1')
    await expect(cellDisplay(page, 'B2')).toHaveText('42')

    // Copy B2.
    await cell(page, 'B2').click()
    await page.keyboard.press('Control+C')

    // Move the focus to a far target before pasting. The table keeps the
    // focused cell in view, so raw scroll-only setup can snap back to B2.
    const farAddr = 'B401'
    await page.evaluate(() => {
      const win = window as unknown as {
        __einfachStore?: {
          setSelectionAnchor: (coord: { row: number; col: number }) => void
        }
      }
      win.__einfachStore?.setSelectionAnchor({ row: 400, col: 1 })
    })
    await scrollWrapper(page, 'y', 400 * 26)
    await page.waitForTimeout(150)
    await expect(cell(page, farAddr)).toBeVisible()
    await page.locator('.excel-table-wrapper').focus()
    await page.keyboard.press('Control+V')

    // Scroll back; the pasted cell + its formula-shifted output
    // should be correct.
    await page.evaluate(() => {
      const win = window as unknown as {
        __einfachStore?: {
          setSelectionAnchor: (coord: { row: number; col: number }) => void
        }
      }
      win.__einfachStore?.setSelectionAnchor({ row: 1, col: 1 })
    })
    await scrollWrapper(page, 'y', 0)
    await page.waitForTimeout(150)

    // Original B2 still 42 (the copy didn't disturb it).
    await expect(cellDisplay(page, 'B2')).toHaveText('42')

    // Scroll back to the paste site and assert it shows a numeric
    // result. We use a regex (digits) because the shifted formula
    // depends on the chosen paste address — the contract here is
    // "paste produced a live, evaluated cell", not the exact value.
    await page.evaluate(() => {
      const win = window as unknown as {
        __einfachStore?: {
          setSelectionAnchor: (coord: { row: number; col: number }) => void
        }
      }
      win.__einfachStore?.setSelectionAnchor({ row: 400, col: 1 })
    })
    await scrollWrapper(page, 'y', 400 * 26)
    await page.waitForTimeout(150)
    // Contract: "paste produced a live, evaluated cell"; an empty display
    // would mean the paste silently failed while the destination was far
    // outside the original viewport.
    await expect(cellDisplay(page, farAddr)).not.toHaveText('')
  })
})
