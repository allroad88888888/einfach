# Accessibility baseline

First automated a11y coverage for the vNext spreadsheet surfaces. `README.md`
recorded `E2E / a11y / 性能` as `PENDING_ROOT_VERIFICATION` — before this slice
the repo had **no a11y tooling at all**: no axe, no a11y spec, no lint rule.

Gate: `solid/excel/e2e/a11y-surfaces.spec.ts`
(real Vite dev server + real WASM/TS worker backends, scanned in a real
Chromium page by axe-core).

```bash
# both backends (wasm + ts projects), server started for you
cd solid/excel
NO_PROXY=localhost,127.0.0.1 npx playwright test e2e/a11y-surfaces.spec.ts

# reuse an already-running dev server on your own port (parallel agents)
cd solid/excel
NO_PROXY=localhost,127.0.0.1 EINFACH_E2E_PORT=5219 EINFACH_E2E_REUSE_SERVER=1 \
  npx playwright test e2e/a11y-surfaces.spec.ts --project=wasm
```

## Toolchain

| Piece | Choice |
| --- | --- |
| Scanner | `axe-core` 4.12 |
| Driver | `@axe-core/playwright` 4.12.1, added to `solid/excel` devDependencies |
| Ruleset | `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` |
| Fails the run | `critical` + `serious` |
| Reported, non-blocking | `moderate` + `minor` — attached to the Playwright report as `a11y-advisory-<surface>` |

Installed with `pnpm@10`, not the ambient pnpm 11: pnpm 11 no longer reads the
`pnpm.overrides` field in `package.json`, so an install under it would silently
drop the `solid-js: 1.9.12` pin and reintroduce the two-copies-of-solid-js bug
documented in `CLAUDE.md`. Post-install check: `pnpm-lock.yaml` still carries the
`overrides:` block and still resolves exactly one `solid-js@1.9.12`.

### No rule suppression

The gate never calls `disableRules()` and never calls `exclude()`. Both hide
every *current and future* violation of a rule (or inside a subtree), which is
exactly the failure mode that lets an a11y gate go green while the product
regresses. Defects that could not be fixed cheaply are listed in `KNOWN_ISSUES`
in the spec, matched on **(rule id, exact node target)** so any other element
failing the same rule still fails the run, and each is mirrored by a
`test.fixme` that reproduces it.

## Surfaces covered

| # | Surface | Demo | Notes |
| --- | --- | --- | --- |
| 1 | Grid, default state | vNext Worker | waits for the seeded `C2` formula to resolve so axe scans a settled DOM |
| 2 | Menu bar, Data dropdown open | vNext Worker | |
| 3 | Toolbar, number-format dropdown open | Wave 5 | |
| 4 | Dialog — Name Manager | vNext Worker | |
| 5 | Dialog — Find and Replace | Wave 5 | worker backend gates the port off (`toolbar-btn-find-replace` renders disabled), so this runs on the static host |
| 6 | Dialog — Format Cells | Wave 5 | reached via number-format dropdown → `Custom` |
| 7 | Data menu — Excel Table entries | vNext Worker | this slice's new feature surface: `data.createTable` + `data.toggleTotals` with a seeded header/data block; WASM-only (`structuredTables: false` on the TS worker hides the entries) |

Every surface is scanned on **both** the `wasm` and `ts` Playwright projects
except #7, which skips on `ts` for the capability reason above.

## First-run baseline (before any fix)

Scanned 2026-07-21 on `claude/rust-core-state-plan-Auzcj`. Five distinct
defects, all real — the same three page-level ones repeat on every surface
because they live in the persistent chrome (grid, formula bar, sheet tabs).

| Rule | Impact | Nodes | Where | Status |
| --- | --- | --- | --- | --- |
| `aria-allowed-attr` | critical | 60 | every `td[data-cell-addr]` | **fixed** |
| `aria-required-children` | critical | 3 | `.spreadsheet-menu-bar`, `.spreadsheet-history-timeline`, `.sheet-tabs` | 2 of 3 **fixed**, 1 known issue |
| `label` | critical | 1 | `.formula-bar-input` | **fixed** |
| `color-contrast` | serious | 2 | history timeline current entry | **fixed** |
| `color-contrast` | serious | 1 | Format Cells selected category row | **fixed** |

Per-surface violation counts, first run → after fixes:

| Surface | Before (crit / serious) | After (crit / serious) |
| --- | --- | --- |
| Grid | 3 / 0 | 0 / 0 |
| Menu bar (Data open) | 3 / 0 | 0 / 0 |
| Toolbar (number-format open) | 3 / 0 | 0 / 0 |
| Name Manager | 3 / 0 | 0 / 0 |
| Find and Replace | 3 / 0 | 0 / 0 |
| Format Cells | 3 / 1 | 0 / 0 |
| Data menu — Table entries | 3 / 1 | 0 / 0 |

`moderate` / `minor`: **zero** across all seven surfaces, both projects. No
advisory exemptions were needed, so the spec carries **no rule whitelist** —
the `moderate`/`minor` reporting path exists for future findings but is
currently empty.

## What was fixed

All five fixes are semantic corrections, not assertion tuning.

### 1. `aria-allowed-attr` — cells carried `aria-selected` on `role="cell"`

`solid/excel/src-vnext/grid/SpreadsheetGrid.tsx`

A bare `<td>` maps to `role="cell"`, which does not support `aria-selected`;
the attribute was being dropped by assistive tech on every visible cell, so
selection was simply not announced. Added `role="gridcell"` — both the
semantically correct role for a spreadsheet cell and the role that legitimises
`aria-selected`. The parent chain (`<tr>` → row, `<tbody>` → rowgroup,
`<table>` → table) already satisfies `aria-required-parent`.

### 2. `label` — formula bar input had no accessible name

`solid/excel/src-vnext/formula-bar/SpreadsheetFormulaBar.tsx`

The visible address chip beside the input is `display:none` + `aria-hidden`, so
the field had no name from any source. Screen readers announced a bare "edit".
Added `aria-label="Formula bar"`, matching Excel's own announcement.

### 3. `aria-required-children` — menu bar

`solid/excel/src-vnext/menu-bar/SpreadsheetMenuBar.tsx`

`role="menubar"` owned `div.menu-bar-top > button[aria-haspopup]`. A menubar may
own only `menuitem` / `menuitemcheckbox` / `menuitemradio` / `group`. Added
`role="menuitem"` to the top-level menu button and `role="none"` to its wrapper,
giving the APG shape (`li[role=none] > a[role=menuitem]`).

### 4. `aria-required-children` — history timeline

`solid/excel/src-vnext/history/SpreadsheetHistoryTimeline.tsx`

`role="list"` sat on the outer wrapper, which also holds the undo/redo buttons
and the live-region cursor — non-`listitem` children under a list role. The real
list is the inner `<ul>`, which already has native list semantics and only `<li>`
children. Removed the bogus role from the wrapper and moved
`aria-label="History timeline"` onto the `<ul>`.

### 5. `color-contrast` — two sub-AA text colours

Two brand colours were being used as *text* on tinted backgrounds where they
fall under the 4.5:1 AA floor. Fixed by adding text-safe variants rather than
changing the brand colours, which remain correct for borders and fills (held to
the 3:1 non-text rule).

`solid/excel/src/styles.css`

- New token `--excel-green-text: #1b6139`. `--excel-green` (`#217346`) on
  `--select-bg` (`#dae3dc`) is **4.43:1**; the new token is **5.68:1**. Applied
  to `.history-timeline-entry-current .history-timeline-entry-btn`.
- `.history-timeline-entry-time` inherits `--text-muted` (`#6a6a6a`), fine on
  the default chrome but **4.12:1** on `--select-bg`. Scoped override to
  `#595959` (**5.34:1**) in the current-entry context only.
- New token `--office-blue-text: #0067b8`. `--office-blue` (`#0078d4`) is only
  4.53:1 on white and drops below AA over any tint.

`solid/excel/src-vnext/format-cells/format-cells-dialog.css`

- The selected category row rendered `--office-blue` over a 12% blue tint
  (`#e0effa`) at 13px — **3.86:1**. Switched to `--office-blue-text`
  (**4.93:1** on the tint, 5.78:1 on white).

## Known issues (not fixed, not suppressed)

### a11y-1 — `role="tablist"` owns non-tab buttons

- **Rule**: `aria-required-children` (critical)
- **Node**: `.sheet-tabs`
- **Surfaces**: all seven (the sheet-tab strip is persistent chrome)
- **Symptom**: `SpreadsheetSheetTabs.tsx` puts `role="tablist"` on the strip
  container, but the strip also renders a per-tab drag-reorder grip
  (`button[aria-label="Move <sheet>"]`) and a trailing
  `button[aria-label="Add sheet"]`. ARIA lets a `tablist` own nothing but `tab`,
  so both are illegal children. Practical impact: screen readers may not expose
  a coherent tab set, and the extra buttons are announced out of a role context
  that explains them.
- **Why not fixed here**: the two real fixes are (a) fold the reorder grip into
  the tab button itself (pointer-drag on the tab, as Excel does) or (b) hoist the
  grips and the add button out of the tablist subtree. Both are behavioural /
  layout changes that touch `sheet-tab-reorder-*` in three e2e specs plus
  `test/vnext-sheet-tabs.test.tsx`, well outside a "add the a11y gate" slice.
- **Tracked by**: `KNOWN_ISSUES` in `a11y-surfaces.spec.ts` (matched on rule +
  exact target, so any other `.sheet-tabs` element or any other rule still fails
  the gate) and the `test.fixme` `sheet-tab strip: role="tablist" owns non-tab
  buttons`, which scans `.sheet-tabs` in isolation and will go green the moment
  the strip is restructured.

## Exemptions

**None.** No `disableRules`, no `exclude`, no `moderate`/`minor` rule whitelist.
The only carve-out is the single node-scoped `KNOWN_ISSUES` entry above.

## Gate verification

The filter is only trustworthy if it still fails on a real regression. Verified
by removing `aria-label="Formula bar"` and re-running the grid surface:

```
Error: grid — vNext Worker default state: 1 blocking (critical/serious) a11y violation(s)
  [critical] label @ .formula-bar-input
1 failed
```

The label was then restored.

## Numbers at the time of writing

```
npx playwright test e2e/a11y-surfaces.spec.ts      → 13 passed, 3 skipped
  (wasm: 7 passed + 1 fixme; ts: 6 passed + 1 wasm-only skip + 1 fixme)
npx tsc -p solid/excel/tsconfig.json --noEmit      → 5 errors (unchanged
  pre-existing baseline, all in src-vnext/adapter/worker-runtime*.ts)
npx jest solid/excel --no-coverage                 → 94 suites / 1398 passed
regression batch (formula-bar, toolbar-history, undo-redo, vnext-smoke,
  vnext-real-backend-smoke, multisheet-ui, vnext-wave5)  → 84 passed
```

## Follow-ups

1. **a11y-1** — restructure the sheet-tab strip, then delete the `KNOWN_ISSUES`
   entry and un-`fixme` the paired test. This is the only thing standing between
   the current state and a zero-carve-out gate.
2. **Widen surface coverage** — the remaining dialogs (conditional formatting,
   data validation, paste special, text-to-columns, remove duplicates, go-to,
   protection unlock, comment thread) and the context menu, filter dropdown,
   print preview overlay and formula autocomplete are not yet scanned. Each is a
   few lines in `SURFACES`.
3. **Keyboard-only traversal** — axe is a static-DOM scanner and cannot see
   focus order, focus traps, or whether Escape closes a dialog. The vNext dialogs
   have never been audited for this. Needs a separate keyboard-navigation spec.
4. **Screen-reader semantics for the grid** — `role="gridcell"` fixed the
   attribute error, but the table itself is still `role="table"`, not
   `role="grid"`. Promoting it means adopting the roving-`tabindex` focus model,
   which is a design decision, not a lint fix.
5. **Colour tokens** — `--excel-green-text` / `--office-blue-text` currently have
   one consumer each. Any future green or blue *text* should use them; consider a
   stylelint rule or a doc note in the token block if more appear.
6. **Wire into CI** once the parity arc closes (per repo policy, no CI edits
   mid-arc).
