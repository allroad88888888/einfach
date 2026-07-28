import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import type { Result } from 'axe-core'

import { cellDisplay, gotoRoot, typeIntoCell, withEnglishLocale } from './helpers'

/**
 * Accessibility gate for the vNext spreadsheet surfaces.
 *
 * Scans every interactive surface with axe-core against WCAG 2.0/2.1 A + AA
 * and fails on any `critical` or `serious` violation. `moderate` / `minor`
 * findings are reported in the failure message but do not fail the run — see
 * `docs/online-excel-parity/A11Y_BASELINE.md` for the baseline numbers and the
 * rationale behind every entry in `KNOWN_ISSUES` below.
 *
 * Deliberate non-goals:
 *   - No `disableRules()` anywhere. Suppressing a rule hides every current AND
 *     future instance of it across the whole page. When a real defect cannot be
 *     fixed cheaply it goes in `KNOWN_ISSUES` (rule + exact node target, so any
 *     *other* node failing the same rule still fails the gate) and is mirrored
 *     by a `test.fixme` that documents the defect.
 *   - No `exclude()` of regions. Excluding a subtree would also hide unrelated
 *     violations inside it.
 *
 * Run:
 *   NO_PROXY=localhost,127.0.0.1 EINFACH_E2E_PORT=5174 \
 *     npx playwright test e2e/a11y-surfaces.spec.ts --project=wasm
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

/** Impacts that fail the gate. */
const BLOCKING = new Set(['critical', 'serious'])

/**
 * Known, un-suppressed accessibility defects. Each entry is matched on
 * (rule id, exact node target) so it can never mask a different element or a
 * different rule. Every entry must name the tracking follow-up.
 */
const KNOWN_ISSUES: Array<{ rule: string; target: string; why: string }> = [
  {
    rule: 'aria-required-children',
    target: '.sheet-tabs',
    // TODO(a11y-1): the sheet-tab strip carries `role="tablist"`, but it also
    // renders a per-tab drag-reorder grip (`button[aria-label="Move <sheet>"]`)
    // and a trailing `button[aria-label="Add sheet"]`. ARIA allows a tablist to
    // own nothing but `tab`, so both are illegal children. Fixing it properly
    // means either folding the reorder grip into the tab button (pointer-drag
    // on the tab itself, as Excel does) or hoisting the grips and the add
    // button out of the tablist subtree. Both are behavioural changes that
    // touch `sheet-tab-reorder-*` in 3 e2e specs plus a unit test, so it is out
    // of scope for the slice that introduced this gate.
    // Reproduced by the `test.fixme` at the bottom of this file.
    why: 'sheet-tab reorder grip + add-sheet button live inside role="tablist"',
  },
]

type Surface = { name: string; open: (page: Page) => Promise<void>; wasmOnly?: boolean }

/**
 * The TS worker declares `structuredTables: false` (fail-closed), so UI core
 * hides the Data-menu Table entries on the `ts` project. Surfaces that exist
 * only behind the WASM engine skip there rather than fail.
 */
function activeProjectIsWasm(): boolean {
  try {
    return test.info().project.name !== 'ts'
  } catch {
    return true
  }
}

function isKnown(v: Result, nodeTarget: string): boolean {
  return KNOWN_ISSUES.some((k) => k.rule === v.id && k.target === nodeTarget)
}

/** Format one violation node for a human reading the failure output. */
function describe(v: Result): string[] {
  return v.nodes.map((n) => {
    const target = n.target.join(' ')
    const why = (n.failureSummary ?? '').replace(/\s*\n\s*/g, ' ')
    return `  [${v.impact}] ${v.id} @ ${target}\n      ${why}`
  })
}

/**
 * Run axe over the whole page and assert no blocking violation survives the
 * `KNOWN_ISSUES` filter. Non-blocking findings are attached to the test so
 * they show up in the report without turning the suite red.
 */
async function expectAccessible(page: Page, surface: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()

  const blocking: string[] = []
  const advisory: string[] = []

  for (const v of results.violations) {
    const unknownNodes = v.nodes.filter((n) => !isKnown(v, n.target.join(' ')))
    if (unknownNodes.length === 0) continue
    const lines = describe({ ...v, nodes: unknownNodes })
    if (BLOCKING.has(v.impact ?? '')) blocking.push(...lines)
    else advisory.push(...lines)
  }

  if (advisory.length > 0) {
    await test.info().attach(`a11y-advisory-${surface}`, {
      body: advisory.join('\n'),
      contentType: 'text/plain',
    })
  }

  expect(
    blocking,
    `${surface}: ${blocking.length} blocking (critical/serious) a11y violation(s)\n${blocking.join(
      '\n',
    )}`,
  ).toEqual([])
}

// ============================================================================
// Surface openers
// ============================================================================

async function gotoWorkerDemo(page: Page) {
  await gotoRoot(page)
  await page.getByRole('button', { name: 'vNext Worker', exact: true }).click()
  await expect(page.getByTestId('vnext-worker-grid')).toBeVisible({ timeout: 30_000 })
  // The seeded C2 formula resolving proves the worker + engine finished booting,
  // so axe scans a settled DOM rather than a loading skeleton.
  await expect(cellDisplay(page, 'C2')).toHaveText('13', { timeout: 30_000 })
}

async function gotoWave5Demo(page: Page) {
  await page.goto(withEnglishLocale())
  await page.getByTestId('nav-tab-vnext-wave5').click()
  await expect(page.getByTestId('wave5-grid')).toBeVisible({ timeout: 30_000 })
}

const SURFACES: Surface[] = [
  {
    name: 'grid — vNext Worker default state',
    open: gotoWorkerDemo,
  },
  {
    name: 'menu bar — Data dropdown open',
    open: async (page) => {
      await gotoWorkerDemo(page)
      await page.getByTestId('menu-bar-button-data').click()
      await expect(page.getByTestId('menu-bar-dropdown-data')).toBeVisible()
    },
  },
  {
    name: 'toolbar — number-format dropdown open',
    open: async (page) => {
      await gotoWave5Demo(page)
      await page.getByTestId('toolbar-btn-number-format').click()
      await expect(page.getByTestId('number-format-dropdown')).toBeVisible()
    },
  },
  {
    name: 'dialog — Name Manager',
    open: async (page) => {
      await gotoWorkerDemo(page)
      await page.getByTestId('toolbar-btn-name-manager').click()
      await expect(page.getByTestId('vnext-worker-name-manager')).toBeVisible()
    },
  },
  {
    name: 'dialog — Find and Replace',
    open: async (page) => {
      // Find/Replace is capability-gated off on the worker backend
      // (`toolbar-btn-find-replace` renders disabled), so this surface is
      // exercised on the Wave 5 static host where the port exists.
      await gotoWave5Demo(page)
      await page.getByTestId('toolbar-btn-find-replace').click()
      await expect(page.getByTestId('wave5-find-replace')).toBeVisible()
    },
  },
  {
    name: 'dialog — Format Cells',
    open: async (page) => {
      await gotoWave5Demo(page)
      await page.getByTestId('toolbar-btn-number-format').click()
      await page.getByTestId('number-format-item-Custom').click()
      await expect(page.getByTestId('wave5-format-cells')).toBeVisible()
    },
  },
  {
    name: 'Data menu — Excel Table entries (create table / toggle totals)',
    wasmOnly: true,
    open: async (page) => {
      // This slice's new feature surface: with a header + data block seeded and
      // selected, the Data menu exposes `data.createTable` and
      // `data.toggleTotals`. Scanning it open covers both entries plus the
      // status/live-region nodes the Table commands render into the menu bar.
      await gotoWorkerDemo(page)
      await typeIntoCell(page, 'E1', 'Item')
      await typeIntoCell(page, 'F1', 'Qty')
      await typeIntoCell(page, 'E2', 'a')
      await typeIntoCell(page, 'F2', '10')
      await page.getByTestId('menu-bar-button-data').click()
      await expect(page.getByTestId('menu-bar-dropdown-data')).toBeVisible()
      await expect(page.getByTestId('menu-bar-item-data.createTable')).toBeVisible()
    },
  },
]

test.describe('a11y — vNext surfaces (WCAG 2.1 AA)', () => {
  for (const surface of SURFACES) {
    test(surface.name, async ({ page }) => {
      test.skip(
        surface.wasmOnly === true && !activeProjectIsWasm(),
        'surface is gated behind a WASM-only backend capability',
      )
      await surface.open(page)
      await expectAccessible(page, surface.name)
    })
  }
})

test.describe('a11y — known defects', () => {
  // TODO(a11y-1): un-fixme once the sheet-tab strip stops nesting non-tab
  // controls inside `role="tablist"`. See KNOWN_ISSUES above for the two
  // candidate fixes and why neither landed with this slice.
  test.fixme('sheet-tab strip: role="tablist" owns non-tab buttons', async ({ page }) => {
    await gotoWorkerDemo(page)
    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include('.sheet-tabs')
      .analyze()
    expect(
      results.violations,
      describe(results.violations[0] ?? ({} as Result)).join('\n'),
    ).toEqual([])
  })
})
