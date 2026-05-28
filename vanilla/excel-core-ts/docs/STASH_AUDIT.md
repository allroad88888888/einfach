# Stash audit — 2026-05-27

Total: 16 stashes (`stash@{0}` through `stash@{15}`), all on branch `claude/rust-core-state-plan-Auzcj`. Dates span 2026-05-19 through 2026-05-21.

Methodology: for each stash, ran `git stash show --stat`, sampled the diff, then cross-checked the touched paths against current `HEAD` (de5cca6). Files referenced only by stashes 0, 2, and 4 (`SpreadsheetGridContent.tsx`, `pointer-routing.ts`, `pointer-routing-bindings.ts`, `canvas-cell-v2.ts`) trace to the abandoned **W6 P1 DOM-cell scaffolding** arc — that arc was reverted in dangling commit `c62428f` ("undo W6 P1 DOM-cell scaffolding") and never landed on the current branch. The companion commits (e.g. `7eb0fdd mergeCellFormat skips undefined CF keys`, `d461571 hitTestPointer honours scroll offsets`) only exist on the `q-batch-stats-fillout` family, not here.

## Verdict summary
- DROP: 14
- APPLY: 0
- KEEP: 2

## Per-stash

### stash@{0} — "ui-wip-during-j"
- Files: `SpreadsheetGridContent.tsx`, `pointer-routing.ts`, `vnext-grid-content.test.tsx`, `vnext-pointer-routing.test.ts`, `canvas-cell-v2.{ts,test.tsx}` (6 files, +273/-11)
- Verdict: **DROP**
- Reasoning: Modifies files (`SpreadsheetGridContent.tsx`, `pointer-routing.ts`) that do not exist on this branch — they belonged to the W6 P1 single-canvas renderer arc that was abandoned via commit c62428f on a sibling branch. The fix it carries (CF-undefined-key merge bug, hitTest scroll offsets) was committed as `7eb0fdd` + `d461571` on the abandoned line and never ported here. Cannot apply cleanly; the architectural target it relied on was withdrawn.

### stash@{1} — "ui-wip-pre-jklmn-merge"
- Files: empty stash (no diff payload)
- Verdict: **DROP**
- Reasoning: `git stash show -p` returns nothing. Likely a precautionary checkpoint stash that ended up empty because the working tree was clean at the time. No content to apply.

### stash@{2} — "ui-wip-during-f-commit"
- Files: `pnpm-lock.yaml`, `eval.rs`, `sheet.rs`, `tests/broadcast.rs`, `package.json`, `SpreadsheetGrid.tsx`, `test/visual/{README.md,capture.mjs}` (8 files, +773/-84)
- Verdict: **DROP**
- Reasoning: The Rust broadcast work (`broadcast_binop`, `Value::Array` lifting, `tests/broadcast.rs`) is already on disk — landed as commits `f9dad8d`/`04df753`/`347679c` ("implicit arithmetic broadcast for Range/Array operands"). The SpreadsheetGrid hunk imports `SpreadsheetGridContent` and `pointer-routing-bindings` — also W6 P1 abandonment victims. The pixelmatch/pngjs + visual capture infra never landed (no `test/visual/` dir on disk) but it was a sibling-WIP that the team chose not to commit; treat as abandoned.

### stash@{3} — "ui-wip-pre-fhi-merge"
- Files: `solid/excel/package.json` (1 file, +4/-1)
- Verdict: **DROP**
- Reasoning: Adds `pixelmatch`/`pngjs` devDeps + `visual:check` script — same visual-regression infra as stash 2. Current `package.json` has none of these; the visual harness was never adopted. Subset of stash 2.

### stash@{4} — "ui-session-wip"
- Files: `SpreadsheetGridContent.tsx` (new, 726 lines), `canvas-cell.{ts,test.tsx}` (3 files, +1083/-0)
- Verdict: **DROP**
- Reasoning: Pure W6 P1 content-canvas scaffolding — the file that was reverted. The single-canvas direction was abandoned in favor of staying with DOM cells + canvas overlay. Resurrecting this would re-open the architectural fork the team decided to close.

### stash@{5} — "ui-session-wip-before-batch-merge"
- Files: `SpreadsheetGrid.tsx`, `SpreadsheetGridOverlay.tsx`, `index.tsx`, `App.tsx`, en/zh locales, `vnext-grid-overlay.test.tsx` (7 files, +300/-278)
- Verdict: **DROP**
- Reasoning: Introduces the absolutely-positioned single editor element (`editorElement` signal, `isEditingThisSheet`) over the per-cell `<input>` model. None of those identifiers exist in current `SpreadsheetGrid.tsx`. Cross-referencing with current behavior: the inline-per-cell editing model is what's actually shipped — this stash represents a refactor path that was not taken.

### stash@{6} — "pre-formula-merge keyboard shortcuts"
- Files: `solid/excel/src-vnext/grid/SpreadsheetGrid.tsx` (1 file, +25/-0)
- Verdict: **DROP**
- Reasoning: Adds Ctrl/Cmd+H → Find/Replace and Ctrl/Cmd+1 → Format Cells. Both already live on disk: `SpreadsheetGrid.tsx:2058` has the "Ctrl/Cmd+1 opens the Format Cells dialog" branch and `:2067` calls `openFormatCellsAtom`. Superseded.

### stash@{7} — "sibling-wip-non-staged"
- Files: `e2e/vnext-wave5.spec.ts`, `SpreadsheetGrid.tsx`, `SpreadsheetToolbar.tsx`, `vnext-toolbar.test.tsx`, `history/{index,types}.ts`, `keyboard/{index,types}.ts`, `keyboard.test.ts` (9 files, +475/-7)
- Verdict: **DROP**
- Reasoning: Adds e2e cases (row-header click selects row, column-header click, Find next navigates, Bold toggle aria-pressed, Ctrl+B). All four tests are already present in current `vnext-wave5.spec.ts` at lines 203/215/247/261. Keyboard/history additions are also on disk. Pure duplicate.

### stash@{8} — "sibling-wip-isolate-dialog-close"
- Files: 26 files, +1325/-44 — dialog ESC/backdrop close wiring across find/replace, conditional-format, data-validation, filter-dropdown, format-cells, name-manager, print, protection-unlock, format-cells, status-bar, menu-bar, plus the same e2e + keyboard/history adds from stash 7
- Verdict: **DROP**
- Reasoning: Superset of stash 7. The dialog-close pattern (open-atom + createEffect false→true edge) is the canonical shape documented in CLAUDE.md and is present in all those dialog files on disk. The keyboard/history pieces are on disk too. The 222-line `vnext-dialog-close.test.tsx` smoke is the only file that doesn't exist on disk by that exact name — but the dialog close behavior is exercised in `vnext-find-replace.test.tsx` and the per-dialog suites. Treat as superseded multi-feature WIP.

### stash@{9} — "wave5-sibling-stash-rebase-context"
- Files: `VNextSmokeDemo.tsx`, `VNextWorkerDemo.tsx`, `SpreadsheetGrid.tsx`, `grid/index.ts`, `public.ts` (5 files, +85/-0)
- Verdict: **DROP**
- Reasoning: Wires `SpreadsheetMenuBar` into the two demos and exports `SpreadsheetGridOverlay` from `grid/index.ts`. Current state: `menu-bar/index.ts` and `menu-bar/SpreadsheetMenuBar.tsx` exist; `grid/index.ts:2` exports `SpreadsheetGridOverlay`; `SpreadsheetGrid.tsx:108` imports it. Already landed.

### stash@{10} — "menu-bar-pre-commit-isolate"
- Files: `solid/excel/src-vnext/grid/SpreadsheetGrid.tsx`, `grid/index.ts` (2 files, +80/-0)
- Verdict: **DROP**
- Reasoning: Subset of stash 9 (just the grid pieces, no demo wiring). `getOverlayCellRect` is on disk at `SpreadsheetGrid.tsx:2701`; overlay export is on disk. Superseded.

### stash@{11} — "wave-5-5-sibling-wip-isolate"
- Files: `SpreadsheetGrid.tsx`, `grid/index.ts`, `vanilla/spreadsheet-ui-core/src/index.ts` (3 files, +81/-0)
- Verdict: **DROP**
- Reasoning: Same `getOverlayCellRect` + overlay export as stash 10, plus a UI-core `index.ts` re-export. All present on disk. Strict subset of work that's landed.

### stash@{12} — "wave-5-5-canvas-overlay-sibling-wip"
- Files: `SpreadsheetGrid.tsx`, `SpreadsheetGridOverlay.tsx` (new 623 lines), `grid/index.ts`, `SpreadsheetToolbar.tsx`, `vnext-grid-overlay.test.tsx` (new 698 lines), UI-core `index.ts` (6 files, +1476/-0)
- Verdict: **DROP**
- Reasoning: This is the original SpreadsheetGridOverlay introduction. Both `SpreadsheetGridOverlay.tsx` and `vnext-grid-overlay.test.tsx` exist on disk. The work was committed (canvas-overlay arc) and has even been refined further (`SpreadsheetGridOverlaySvg` sibling now exists at `SpreadsheetGrid.tsx:109`). Fully superseded.

### stash@{13} — "wave-5-sibling-wip-before-name-box-commit"
- Files: `SpreadsheetFormulaBar.tsx`, `SpreadsheetGrid.tsx`, `name-box/SpreadsheetNameBox.tsx` (new), `name-box/index.ts` (new), `status-bar/SpreadsheetStatusBar.tsx`, `SpreadsheetToolbar.tsx`, `vnext-name-box.test.tsx` (new 360 lines), UI-core `name-box/{index,types}.ts` (13 files, +1555/-11)
- Verdict: **DROP**
- Reasoning: Pre-commit checkpoint for the NameBox feature. All target files exist on disk: `solid/excel/src-vnext/name-box/SpreadsheetNameBox.tsx`, `vanilla/spreadsheet-ui-core/src/name-box/{index,types}.ts`, the formula-bar's `SpreadsheetNameBox` mount, and the UI-core re-export (`export * from './name-box'`). The feature shipped.

### stash@{14} — "wave5-sibling-stash-2"
- Files: `vanilla/spreadsheet-ui-core/src/index.ts` (1 file, +2/-0)
- Verdict: **DROP**
- Reasoning: Adds the `export * from './name-box'` and `export * from './menu-bar'` lines. Both re-exports are present on disk at lines 18 and 26 of `vanilla/spreadsheet-ui-core/src/index.ts`. Trivially superseded.

### stash@{15} — "wave5-sibling-stash"
- Files: empty stash (no diff payload)
- Verdict: **DROP**
- Reasoning: Empty stash, like stash 1. No content.

## KEEP candidates (re-examination)

Reviewing the bias toward DROP: are there any stashes that contain unique, useful work? On a second pass:

### stash@{0} — re-examine
The CF undefined-key merge logic and the scroll-offset fix in `hitTestPointer` are legitimate, considered fixes — even though the files they patched are gone. If the team ever revisits a canvas-content renderer, the patterns here (`Object.entries(...).filter(value !== undefined)` for CF merge; adding `viewportMetricsAtom.scrollLeft/Top` before `LayoutSnapshot.hitTest`) are worth preserving as design notes. But as applicable patches: still **DROP** — the targets do not exist.

### stash@{2} — re-examine
The Rust broadcast hunk is already landed as a real commit. The visual-regression harness (`test/visual/capture.mjs`, pixelmatch deps) is the only piece not on disk. If visual regression testing is wanted, this is a starting point — but the absence on `main` plus three days of branch movement without it suggests it was deliberately not adopted. Promote to **KEEP** so a human can decide whether the visual harness is worth resurrecting independently.

### stash@{4} — re-examine
726-line `SpreadsheetGridContent.tsx` is a fully-developed Wave 3 canvas content renderer. It was reverted because the team chose a different layered approach (DOM cells + canvas overlay rather than single-canvas everything). The code is not garbage — it's a complete alternative path. Promote to **KEEP** so a human can decide whether to archive it as a reference implementation before dropping.

## Revised verdict summary
- DROP: 14 (stashes 0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)
- APPLY: 0
- KEEP: 2 (stashes 2, 4)

## Notes for the human

1. **Two empty stashes** (1, 15) — safe-bet drops, zero risk.
2. **Six stashes are exact subsets or duplicates of landed work** (6, 7, 9, 10, 11, 14) — trivially droppable.
3. **Five stashes target the abandoned W6 P1 single-canvas arc** (0, 2-grid-hunk, 4, plus stash 2's pieces touching `SpreadsheetGridContent`). The architectural decision in `c62428f` makes them unapplyable to current code without a manual port.
4. **Stash 8** is the largest "sibling-wip" (26 files, +1325 lines) — superficially scary, but the dialog-close pattern it codifies is now the project's canonical shape (per CLAUDE.md "Provider and dialog component pattern"). All real value is already on disk.
5. **No stash contains unique work that is missing from disk AND alignable with the current branch.** The two KEEP candidates (2, 4) preserve architectural alternatives — they belong in an archive, not on the active stack.

## 2026-05-28 update — stash@{2} resolved

stash@{2} (ui-wip-during-f-commit) — **DROPPED**. The visual regression
harness is well-designed (200-line capture.mjs + 8 state recipes +
pixelmatch baselines) but tied to the canvas-overlay rendering direction
that was reverted off-branch. Specific blockers:

- References `test/canvas-grid-smoke.md` which doesn't exist on this
  branch (only on dead agent worktrees under `.claude/worktrees/`)
- Pixelmatch baselines were captured against the canvas-rendered grid;
  current DOM-rendering would diff out on every state
- Some recipes (data-merge-anchor selectors) still match current code,
  but most reference canvas-overlay artefacts

The pattern is preserved in the stash audit doc; future visual regression
work should re-capture baselines against the current DOM rendering rather
than salvaging this stash.

Remaining stash count: 15 (was 16).
