# Phase 4 — Parallel Execution Plan

> Date: 2026-05-12
>
> Companion to `ONLINE_SPREADSHEET_PLAN.md` § Phase 4. Phase 1–3 made
> the engine sparse, bounded, and cross-sheet-correct. Phase 4 takes
> the UI from "row virtualization on a 1k × 26 demo" to "two-
> dimensional virtualization on a 1M-cell sheet with bounded
> subscriptions even under aggressive scroll."

## What Phase 3 Left

`excel/solid-excel/src/Table.tsx` today has a hand-rolled row virtualizer
with a `ResizeObserver`, a single `wrapperEl.clientHeight` probe, and
`onScroll`-driven row index recompute. Column virtualization is NOT
present — when `cols=1000` the DOM holds 1000 × visible_rows cells.
The "render all while measuring" fallback also kicks in until the
ResizeObserver first fires.

Cell-level subscription is bounded thanks to Phase-1's `observeCell`
retain/release, but only the **row** dimension shrinks the
subscription set under scroll. Horizontal scroll past a 1000-col
sheet would let the active subscription set grow with
`cumulative_visited_cols × viewport_rows`.

## Architectural Decision — outcome update (2026-05-12)

**Originally planned**: adopt `@grid-table-solidjs/core` as the outer
virtualization chrome.

**What actually shipped**: native 2D virtualization extension of the
existing hand-rolled row virt in `Table.tsx`. Codex reviewed the M
agent's mid-flight work and flagged that `@grid-table-solidjs/core@0.1.0`
has multiple reactivity bugs (`useAutoSizer` returns plain numbers
not signals; `useVScroll` captures `props.height` in a `const` at
setup; the package's dist files import a non-existent
`solid-js/jsx-runtime` subpath). Working around them required three
patched library files + a Vite resolve-id plugin + a Solid JSX
runtime shim — an indefinite implicit fork of the upstream library.
Codex recommendation: native column virt, salvage M's constants
(`COL_WIDTH=100`, `ROW_HEADER_WIDTH=44`, `OVERSCAN=5`) + horizontal
scroll-into-view idea + the un-skipped P specs as regression guards.
Implemented in commit `eb68f76`. The "original" plan below is kept as
historical context for the original architectural intent.

---

**Original plan (not taken): adopt `@grid-table-solidjs/core` as the
outer virtualization chrome for `excel/solid-excel/src/Table.tsx`.** The
library lives at `/Volumes/work/self/grid-table/solidjs/core/`
(published as `@grid-table-solidjs/core@0.1.0`) and ships
`VGridTable`, a 2D virtualizer with the exact contract Phase 4 needs:

- `rowCount` + `rowCalcSize` / `columnCount` + `columnCalcSize` —
  arbitrary per-index sizing.
- `overscanCount` + auto-doubled overscan after settle (matches the
  pattern Cell.tsx already relies on).
- The library had a selected-index pinning API; the final native
  implementation instead uses selection-driven scroll-into-view and
  does not keep off-viewport focus cells mounted.
- `useAutoSizer` — bundled ResizeObserver-disconnect-safe sizing.
- `renderTheadCell` / `renderTbodyCell` callbacks return JSX — our
  existing `<Cell>` slots in untouched.

Why adopt over rolling our own column virt:

- Battle-tested in another product (the grid-table monorepo).
- Bounded initial render is the library's default behavior — no
  "render all while measuring" fallback to remove.
- Less code in einfach to maintain (Table.tsx's current row virt
  becomes a thin adapter).
- onScroll RAF throttling + signal-based scroll state already in.

Risk: we lose direct control over scroll behavior. Mitigation: the
existing keyboard navigation + selection + FormulaBar code lives
ABOVE the virt layer and only refers to logical cell addresses, so
swapping the virt chrome leaves all that untouched.

## Tracks

| Track | Owner | Scope | Effort | Parallelism |
|---|---|---|---|---|
| **M** | VGridTable adoption | Replace `Table.tsx`'s row virtualizer with `VGridTable`. Add `@grid-table-solidjs/core` dep. Preserve every existing interaction (selection, keyboard nav, editing, FormulaBar, ContextMenu, render-count debug probe). Column virtualization comes for free. Bounded initial render replaces the "render all while measuring" fallback. | 3–4 d | sequential — owns the structural change |
| **O** | 1M-cell worker-backed demo | New `excel/solid-excel/src/demos/DemoMillion.tsx` (1000×1000 or 10000×100, both shapes worth exercising). Worker-backed sheet (existing `createWorkerSheet`). A scattered seed (few thousand cells across the 1M coord space) so the lazy-eval + sparse range stories show. Add to the `App.tsx` nav under `perf` group. | 1–2 d | parallel with M (different files) |
| **P** | Viewport scale e2e | Extend `virtualize.spec.ts`'s viewport-churn test: scroll both axes through hundreds of rows/cols on the new million demo, assert `activeSubscriptionCount()` stays bounded. Add column-virt asserts: scrolling right doesn't put all cols in the DOM. Selection + formula-bar + context-menu specs verified to work with virt cols. | 2 d | parallel with M (writes specs against the post-M API) |

## File Conflict Matrix

|  | M | O | P |
|---|---|---|---|
| **M** | — | Table.tsx is M's; DemoMillion.tsx is O's — no overlap | no (specs only) |
| **O** | — | — | no |
| **P** | — | — | — |

M owns `Table.tsx` end-to-end. O writes a new demo file + edits `App.tsx`
to register it. P writes / extends e2e specs. No file collisions.

## Sequencing

```
Day 0:  M starts ─┐
        O starts ─┤  three parallel
        P starts ─┘
Day 1:  P merges (specs that compile and #[ignore]'d for the demo path,
                 OR specs that hit the existing Large demo for the
                 baseline regression)
        O merges (DemoMillion.tsx registered but un-routed if M
                 hasn't merged yet — the file compiles standalone)
Day 3:  M merges (Table.tsx rewrite)
        P un-ignores its post-M specs, O's tab becomes interactive
```

## Track M — VGridTable Adoption

### Goal

`Table.tsx` renders via `VGridTable` from `@grid-table-solidjs/core`.
Existing interactions (selection, keyboard, edit, FormulaBar,
ContextMenu, render-count probe) work without behavior change. New
column virtualization removes the linear DOM cost of wide grids.

### Dependency wiring

`excel/solid-excel/package.json` adds:

```json
"@grid-table-solidjs/core": "^0.1.0"
```

The library is installed via `pnpm add` (the `pnpm-workspace.yaml` at
the einfach root governs the lockfile).

### Replacement contract

What goes:
- The hand-rolled `For each={rowIndices()}` body in `Table.tsx`.
- The `ResizeObserver` + `wrapperEl.clientHeight` probe (Phase 1
  added the `onCleanup(disconnect)` — that disappears with the
  caller).
- The `setScrollTop` + `viewportH` signals.
- The "virt-spacer top/bottom" `<tr>` rows.
- The `virtualize` prop on `<Table>` (always-on now).

What stays:
- `<Cell>` per addr — VGridTable's `renderTbodyCell` callback returns
  one `<Cell>` per visible (row, col).
- Selection / keyboard / paste / undo / formula-bar / context-menu
  handlers — all live on the wrapper, not per-cell.
- The `observeCell` retain/release in Cell.tsx (Phase 1 fix; row
  virt → 2D virt only makes the subscription bound MORE bounded).

### Suggested map between APIs

| Today's Table.tsx | VGridTable equivalent |
|---|---|
| `rows` prop | `rowCount` |
| `cols` prop | `columnCount` |
| Fixed row height (CSS `26px`) | `rowCalcSize={() => 26}` |
| Default col width (CSS `100px`) | `columnCalcSize={() => 100}` |
| Manual `For each={rowIndices()}` | VGridTable's `renderTbodyCell` |
| Manual thead with `<For each={colIndices()}>` | `renderTheadCell` + `theadRowCount={1}` + `theadRowCalcSize={() => 24}` |
| `wrapperEl` + scroll capture | inside VGridTable (uses `useAutoSizer`) |

### Selection Scroll-Into-View

When the user moves selection beyond the current viewport, the native
Table adjusts `scrollTop` / `scrollLeft` and synchronizes the matching
Solid scroll signals so the selected cell enters the virtual window.
The focus cell is not DOM-pinned while off viewport; it is rendered
again when selection or explicit scrolling brings it into range.

### Bounded initial render

VGridTable starts with `width=0, height=0` until `useAutoSizer`
delivers a measurement. Until then the visible range is empty and
the grid renders zero cells (NOT "all cells"). The existing "render
all while measuring" branch in Table.tsx is deleted — no fallback
needed.

### Acceptance for Track M

- All 117 + 5 + 4 = 126 e2e specs pre-existing pass without change.
- `cargo`/`jest` don't regress (UI changes are TS-side only).
- Column virtualization verifiable: `Large Grid` demo with
  `cols=26` doesn't change behavior, but a future `cols=1000`
  demo (Track O) shows column-virt working.
- Keyboard navigation, paste, undo, formula bar all work — the
  existing e2e suite is the regression guard.

### Files M owns

- `excel/solid-excel/src/Table.tsx` (heavy rewrite)
- `excel/solid-excel/package.json` (one dep add)
- `pnpm-lock.yaml` will change (automatic from pnpm add)

### M Stop Conditions

- If VGridTable's `theadRowCount` doesn't support what existing
  demos expect (multi-row header?), keep the manual thead as-is
  and only swap the tbody virt. Tbody-only is still 2D virt because
  VGridTable's body row/col virt are independent of header.
- If selection-driven scroll-to-focus drifts out of sync with the
  virtual window, update both the DOM scroll offset and the Solid
  scroll signals in the same path.
- If `pnpm add` resolves to a different `@grid-table-solidjs/core`
  version, pin to `0.1.0` exactly via `pnpm add @grid-table-solidjs/core@0.1.0`.

## Track O — 1M-Cell Worker-Backed Demo

### Goal

Concrete demo proving Phase 4's million-cell contract end-to-end on
the worker backend. Users can scroll across both axes through 1000 ×
1000 (or 10 000 × 100) without freezing the main thread or growing
the active subscription set unboundedly.

### Implementation

New file `excel/solid-excel/src/demos/DemoMillion.tsx`:
- Use `createWorkerSheet` + `defaultWorkerFactory` (Phase 1 plumbing).
- Seed scattered: ~2000 cells across the 1M coord space (every 500th
  flat address, plus a few formula chains down the first column).
- `<Table rows={1000} cols={1000} formulaBar />` — flat 1M.
- Header cells show 1-based row + alphabetic col labels (`A` … `ALL`
  for 1000 cols — i18n catalog entry not needed since A1-style
  addresses are language-neutral).

Register in `App.tsx`'s `perf` group:
```ts
{ id: 'million', labelKey: 'nav.million', component: DemoMillion },
```

i18n keys (en/zh):
- `nav.million` — "1M Cells" / "百万格"
- `demo.million.title`
- `demo.million.desc`

### Acceptance for Track O

- The demo loads under 2 seconds on a baseline laptop.
- Scrolling right past col 500 doesn't put 1000 cols in the DOM (the
  e2e in Track P verifies).
- Active subscription count after scrolling through 100 rows × 100
  cols stays under ~2000 (already the bound Phase 1 e2e uses for
  Large; Phase 4 generalizes to 2D).

### Files O owns

- `excel/solid-excel/src/demos/DemoMillion.tsx` (new)
- `excel/solid-excel/src/App.tsx` (one new tab entry)
- `excel/solid-excel/src/i18n/locales/en.ts` (3 new keys)
- `excel/solid-excel/src/i18n/locales/zh.ts` (3 new keys)

### O Stop Conditions

- If worker seeding 2000 cells takes > 2s (cold WASM compile time),
  drop to 500 seeded cells. The lazy-eval contract doesn't care how
  many cells exist — only that the viewport stays bounded.
- If `cols=1000` reveals a UX issue we hadn't planned for (e.g. the
  column-letter labels overflow at col 700+), cap the demo at
  100 cols × 10 000 rows and note in the demo desc that 1M total
  cells is the target shape and the engine doesn't care about
  dimension distribution.

## Track P — Viewport Scale e2e

### Goal

New e2e specs prove the Phase 4 contract holds for both row AND
column virtualization, against both the existing Large Grid demo
(post-M rewrite) and the new Million demo.

### Specs to add / extend

1. `column_virtualization_dom_bound` — open Million demo, count
   `td.cell` DOM elements visible. Assert under 200 (viewport ×
   overscan, not 1000 cols × visible rows).

2. `column_scroll_releases_subscriptions` — scroll right past col
   500, assert `activeSubscriptionCount()` stays bounded similar to
   the existing row test in `virtualize.spec.ts`.

3. `selection_restores_selected_cell_into_virtualized_dom` — set
   selection to an off-window row/col and assert the selected cell is
   scrolled into the DOM while total rendered cell count stays bounded.

4. `keyboard_nav_across_virtualized_window` — start at A1, press
   Arrow Down 100 times. Assert the focus tracks correctly and the
   formula-bar shows the right address. (This regresses if the
   Track M selection-pinning is wrong.)

5. `selection_paste_under_2d_virt` — copy a 3 × 3 rectangle, paste
   at a coord outside the current viewport. Verify after scrolling
   the pasted cells are correct.

### Files P owns

- `excel/solid-excel/e2e/virtualize.spec.ts` (extend existing)
- `excel/solid-excel/e2e/million-demo.spec.ts` (new — Million-demo-specific)

### P Stop Conditions

- If selection scroll-into-view cannot keep the focus cell renderable,
  document the gap and weaken the test only to the user-visible focus
  address contract.
- If column-virt makes existing specs flaky (e.g. by changing the
  DOM order of `cellDisplay` reads), pin the affected specs to
  `column virt enabled` test cases with explicit setup.

## Phase 4 Acceptance Roll-Up

- ✅ Two-dimensional virtualization (Track M).
- ✅ No "render all while measuring" fallback (Track M deletes it).
- ✅ Stable cell measurement and scroll anchoring (native viewport
  measurement + selection-driven scroll-into-view).
- ✅ Bounded `activeSubscriptionCount` under 2D scroll (Track P
  e2e).
- ✅ 1M-cell demo runs on worker backend (Track O).
- ✅ FormulaBar / selection / paste / format / context-menu work
  with virt cols (Track M acceptance + Track P specs).
- ✅ No e2e regressions on the existing 9 demos (Track M baseline).
- ✅ No Rust regressions — Phase 4 is UI-only.

## Non-Goals for Phase 4

- Worker authoritative RPC for fallible operations — Phase 5.
- Persistence / chunked CSV import — Phase 5.
- Cross-sheet range parser (deferred from Phase 3) — pre-Phase 5
  or absorbed into Phase 3.5.
- Excel-compatible function semantics gaps — Phase 6.
- A11y deep dive on the virtualized grid — Phase 6.
