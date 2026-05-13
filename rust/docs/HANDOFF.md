# Einfach — Multi-Phase Handoff

> Date: 2026-05-13 (last update)
>
> Branch: `claude/rust-core-state-plan-Auzcj`
> Last verified committed tip: `6462024` (Wave 3 import/persistence commit), `e73fb9d` (Wave 4 plan commit)
> Current verified worktree: Wave 4 docs gate in progress; Wave 3 implementation committed
>
> **Not pushed to origin. CI workflows not touched. Both forbidden by
> user rule until the overall arc lands.**

## What's done — Phase 1 → Phase 5 partial

The "百万 cell + 不做协作 + 懒求值" product line. Phase 1–4A land their
acceptance contracts. After that, Phase 5 partial work also landed worker-owned
workbook RPC, staged imports, large range clear undo, range-native clipboard
export, horizontal virtual scroll restoration, range-native large format, and
large range format undo. Wave 2 chunked TSV export has been committed. Wave 3
bounded import + sparse persistence v1 implementation is in committed worktree
(Rust/WASM + worker/proxy + tests + MCP verification). Wave 4 plan commit
`e73fb9d` is in docs state.

| Phase | Plan doc | Tip commit | Status |
|---|---|---|---|
| 1 | `rust/docs/PHASE1_PARALLEL.md` | `c048776` | ✅ Range-dep correctness fix (P0) + typed dep split + debug counters + scale tests + benches |
| 2 | `rust/docs/PHASE2_PARALLEL.md` | `8aa18aa` | ✅ Interval index for range deps (O(matches)) + sparse value index (`RowMajorMap`) + whole-row/col parser (`A:A` / `1:1`) + 100k range bench |
| 3 | `rust/docs/PHASE3_PARALLEL.md` | `8700bd0` | ✅ Workbook-level `CrossSheetDeps` (point + range, reverse + forward) + `Workbook::set_cell/set_formula/clear_cell/bulk_load` + cycle detection on shared graph + WASM mutator/subscribe bindings |
| 4 | `rust/docs/PHASE4_PARALLEL.md` | `74ec264` | ✅ Native 2D virtualization in `Table.tsx` + bounded initial render + 1M-cell worker demo + active 2D viewport e2e |
| 4A | `rust/docs/PHASE4A_PARALLEL.md` | `2d291c8` | ✅ Bounded cross-sheet range parser (`Sheet2!A1:A100`) + lazy eval/provider integration + same-address range dep preservation |
| 5 partial | `rust/docs/PHASE5_PARALLEL.md` + `ONLINE_SPREADSHEET_EXECUTION_WAVES.md` | `6462024` + current worktree | ✅ Worker workbook RPC/import staging/sparse snapshot/range clear undo/range copy export/range format/format undo/chunked copy export; current worktree adds bounded import + sparse persistence v1. Remaining gaps are file-stream import/backpressure UI, perf/observability, and release gates |

### Gates (`cd /Volumes/work/self/einfach` first)

```sh
cd rust/excel-core && cargo test --lib          # 231 / 0 / 0
cd rust/excel-core && cargo test --test scale   # 8 / 0 / 0
cd rust/excel-core && cargo test --test cross_sheet  # 3 / 0 / 0
cd rust/excel-core && cargo test --test review_repro # 4 / 0 / 0
cd rust/wasm && cargo build                     # clean
cd rust/excel-core && cargo bench --no-run      # 3 bench targets clean
cd /Volumes/work/self/einfach && npx jest       # 58 suites / 418 tests
# Playwright needs a dev server. Boot:
cd solid/excel && npm run dev -- --port 5174 --strictPort > /tmp/dev.log 2>&1 &
sleep 8
cd solid/excel && npx playwright test           # focus-pin skip removed; current active count is tracked in E2E_TEST_PLAN
pkill -f "vite.*5174"
```

`cargo clippy --lib` on `excel-core` has **6 pre-existing baseline
errors** (eval.rs/format.rs/shift.rs/sheet.rs doc-list + PI literals).
NONE were introduced by Phases 1–4 — confirmed each phase. Don't try
to fix them as part of phase work; they're out of scope.

## What's deferred (explicit gaps)

Worker command-contract cleanup is no longer deferred: `setFormulaAsync` is the
authoritative product formula path, worker-backed paste formulas route through
the async command, and proxy/worker/store tests cover parse fail, cycle,
invalid sheet, rollback, and undo batching. Sync `ISheet.set_formula` remains
as legacy compatibility only.

| Item | Where | Effort | Notes |
|---|---|---|---|
| File-stream import / backpressure UI | worker import protocol, demo/import UI, persistence docs/tests | 2–4 d | Bounded session and sparse persistence v1 are implemented in current worktree. Remaining work is product file parser/UI, backpressure, import metrics, and optional automatic save/load integration. |
| Range-native UI ops completion | `solid/excel/src/sheet-store.ts`, `Table.tsx`, worker range APIs | done after current Wave 2 commit | Large clear undo, range format, large format undo, and chunked worker copy export are range-native. Browser clipboard still needs a final string, but worker snapshot/read/postMessage is chunked. |
| Phase 0 CI gates (Rust unit/clippy, wasm browser, e2e blocking) | `.github/workflows/*` | 1–2 d | Originally scheduled for Phase 0; deferred per user "未完成总的永远不要做 CI" rule. Pick up after the overall arc signs off. |
| Pre-existing clippy lints | `eval.rs:373/1309`, `format.rs:193`, `shift.rs:112`, `sheet.rs` doc-list | 1 h | Baseline noise; out of scope for phases. |

## Hard rules (from user)

1. **No `git push`**. Never, until the user explicitly says ship.
2. **No CI workflow edits** (`.github/workflows/*`). Same gate.
3. **Don't `git commit --amend`** — always create new commits.
4. **Don't ignore the codex CLI** for real decision points. When you
   hit a fork in the road, invoke
   `codex exec -C /Volumes/work/self/einfach --skip-git-repo-check "<prompt>"`
   instead of asking the user. Don't ask permission first.
5. **North-star plan is tracked now**:
   `rust/docs/ONLINE_SPREADSHEET_PLAN.md` must exist for worktree-based
   sub-agents; do not treat it as disposable local scratch.
6. **Local agent artifacts**: `.claude/` and `.playwright-mcp/` are ignored
   by git. Do not commit their runtime contents.

## Working pattern (multi-agent + worktree + codex + integration)

The branch's last 40 commits all came from this loop. Recommended for
every new phase.

### 1 — Read first

Always start a phase by reading **three** docs in order:

1. `rust/docs/ONLINE_SPREADSHEET_PLAN.md` — the north-star plan with
   per-phase deliverables, acceptance, agent ownership splits, and
   stop conditions. Sets the "what".
2. The phase-specific plan doc you write next (`PHASE<N>_PARALLEL.md`)
   — your "how", written before launching agents.
3. The relevant existing source (`sheet.rs`, `workbook.rs`,
   `Table.tsx`) — confirm the surfaces the plan touches actually
   look like the plan claims.

### 2 — Write the phase plan doc BEFORE launching agents

Every phase has a `rust/docs/PHASE<N>_PARALLEL.md` companion. Required
sections (see Phase 1–4 docs as templates):

- **What previous phase left** — the gap your phase closes
- **Architectural decision** — the fork, with rationale + codex
  reference if consulted
- **Tracks** — table of Agents (one per parallelizable scope) with
  owner / scope / effort / parallelism
- **File conflict matrix** — N×N grid; explicit "no overlap" or
  "rebase after X"
- **Sequencing** — Day 0 / 1 / N timeline
- **Per-track sections** — concrete deliverables, acceptance,
  files-you-own, DO-NOT-touch, stop conditions
- **Stop conditions** — what would make you pause and re-plan
- **Non-goals** — explicit out-of-scope items, with phase pointer

Commit the doc before launching agents. `git commit -m "docs(rust):
Phase <N> parallel plan — <one-liner>"`.

### 3 — Launch agents in parallel

Use the `Agent` tool with:
- `subagent_type: "general-purpose"` (you need write access; Explore
  is read-only).
- `isolation: "worktree"` (per-agent worktree under `.claude/worktrees/`).
- `run_in_background: true` (don't block your own loop).

**Critical agent-prompt elements**:

- Point at `PHASE<N>_PARALLEL.md § Track <X>` as the canonical scope.
- List **files owned** AND **DO NOT touch** lists explicitly.
- Tell the agent to **reset its worktree to the current tip** of
  `claude/rust-core-state-plan-Auzcj` immediately. The
  `isolation: "worktree"` feature initializes worktrees from `main`,
  which has no `rust/` tree — every Phase 1–4 agent hit this and had
  to `git reset --hard claude/rust-core-state-plan-Auzcj` first.
- Specify verification commands the agent should run before declaring
  done (cargo test / clippy / typecheck / playwright).
- Repeat the hard rules (no push, no CI, no amend).
- Ask for a final report: worktree path, branch name, `git log
  --oneline`, per-commit summary, any stop-condition fallbacks taken.

### 4 — Codex for real decision points

When you hit a real architectural fork — "should I use X or Y data
structure", "is the bug claim in the doc actually current", "is the
agent's mid-flight work salvageable" — invoke codex. **Don't ask the
user first**; the user has explicitly delegated this.

```sh
codex exec --skip-git-repo-check --cd /Volumes/work/self/einfach \
  "Read these files: ... Question: ... Be tight, under 500 words."
```

Wait for it via Bash run_in_background; or use Monitor to poll for
process exit. The `codex exec` command will write to its own session
log under `~/.codex/sessions/<date>/`. Don't try to read the JSONL —
the final answer goes to stdout (and the persisted-output tail-able
file).

Examples of decisions worth codex'ing (drawn from this branch):
- Phase 1: trace the P0 bug to confirm it's current (vs historical)
- Phase 3: pick between A/B/C cross-sheet write integration strategies
- Phase 3: cycle-detection on shared graph — review correctness
- Phase 4: M agent's mid-flight VGridTable adoption stuck on library
  bugs — should we continue, pivot to native, or defer

### 5 — Integration (cherry-pick → verify → un-skip → commit)

Once agents return:

1. `git status --short` to find leaks (agents sometimes write to the
   main checkout's working tree, not just their worktree).
2. Reset leaked files in the main checkout (`git restore <path>` /
   `rm <untracked>`). Don't lose tracked work — verify the worktree
   branch has the relevant commits before resetting.
3. Cherry-pick the agent branches in dependency order. The lightest
   (independent) branches first; the heaviest (overlapping source)
   last. Manual conflict resolution where two agents touched the same
   file region.
4. Once all merge, un-skip any `#[ignore]`'d / `test.skip(true, ...)`
   tests the merged work makes runnable. Delete the corresponding
   compile shims (extension-trait stubs, `B1Counters`-style traits).
   Add an "integration commit" with this cleanup.
5. Run full gates (test commands above). All green before declaring
   the phase done.
6. `git worktree remove -f -f .claude/worktrees/<agent-id>` and
   `git branch -D worktree-<agent-id>` for every Phase agent.
   `git worktree list` to verify nothing's left orphaned.
7. Update `rust/docs/ONLINE_SPREADSHEET_PLAN.md` § "Current State" if
   the phase added a major capability (optional — that doc evolves
   loosely).

## Gotchas (learned the hard way)

- **Worktrees init from `main`**, not the current branch. Every agent
  must `git reset --hard claude/rust-core-state-plan-Auzcj` at the
  start. Bake this into the agent prompt.
- **File leaks**: agents occasionally write to the main checkout's
  working tree (esp. when their worktree's empty-base detection trips
  late). Always check `git status` post-agent before cherry-picking.
- **Long agents leave orphan dev servers**: M agent's playwright
  smoke step left a Vite server bound to port 5174 because its parent
  shell exited but `npm run dev &` was inherited by PID 1. Reap with
  `pkill -f "vite.*5174"` after every UI-touching agent.
- **Bench compile is mandatory after every Rust change**:
  `cargo bench --no-run` from `rust/excel-core/`. It catches signature
  drift between `Sheet` and the bench harness that `cargo test` alone
  misses.
- **`@grid-table-solidjs/core@0.1.0` is unusable as-is** for Solid
  hosts. Has 3 reactivity bugs + a JSX-runtime import bug. Avoid
  unless someone has shipped a fix upstream. Native 2D virt is ~150
  LOC and was the right call.
- **`Workbook::sheet_mut(idx).set_cell(...)` is intentionally NOT
  cross-sheet-aware** post-Phase-3. The `Workbook::set_cell(idx, addr,
  val)` workbook-level mutator is the one that walks `CrossSheetDeps`.
  Existing tests that use `sheet_mut(...).set_cell` still pass
  because they don't care about cross-sheet propagation.

## Next steps (pick one)

| Option | What | Effort | Why |
|---|---|---|---|
| **A** | Commit current Wave 3 bounded import + persistence worktree | <1 d | Locks the Rust/worker/proxy/e2e/MCP verified API contract |
| **B** | Wave 4 — perf/observability/MCP gates | 2–4 d（进行中） | `e73fb9d` 已提交计划；文档同步与门禁执行持续推进 |
| **C** | Product file import/backpressure UI | 2–4 d | Builds on bounded import sessions without changing core lazy semantics |
| **D** | Push branch + open PR(s) | 1–2 d | Only do if user explicitly says "ship" — the no-push rule is still in force as of handoff |
| **E** | Stop and review with user | — | Branch is 130+ commits ahead of `main` and accumulating; consider a checkpoint conversation |

Recommended pick if the new window has full autonomy after the current commit:
**B first** (Wave 4 perf/observability), using
`rust/docs/ONLINE_SPREADSHEET_EXECUTION_WAVES.md` as the tracker and
`rust/docs/WAVE3_IMPORT_PERSISTENCE_PLAN.md` as the just-finished contract.
Hold **D** until user green-lights it.
Push/CI remains explicitly forbidden until the overall arc lands.

## File reading order for the next agent

1. This doc (`rust/docs/HANDOFF.md`).
2. `rust/docs/ONLINE_SPREADSHEET_PLAN.md` — north-star plan.
3. `rust/docs/WAVE3_IMPORT_PERSISTENCE_PLAN.md` — current Wave 3 plan.
4. `rust/docs/ONLINE_SPREADSHEET_EXECUTION_WAVES.md` — overall wave tracker.
5. `rust/docs/PHASE5_PARALLEL.md` — historical worker/range plan.
6. `rust/docs/PHASE4A_PARALLEL.md` — most recent completed parser plan.
7. `rust/docs/PHASE1_PARALLEL.md` — has the most thorough trace
   pattern for a P0 bug (good reference if Phase 5 uncovers one).
6. `rust/excel-core/src/workbook.rs` — touched heavily in Phase 3, is
   the next target if Phase 5 deepens worker-RPC.
7. `rust/wasm/src/lib.rs` — `WasmWorkbook` canonical vs legacy mutator
   split and missing bulk/import bindings.
8. `solid/excel/src/wasm-sheet-worker.ts` and
   `solid/excel/src/wasm-sheet-proxy.ts` — current single-sheet worker
   adapter to replace for product path.
9. `solid/excel/src/sheet-store.ts` — undo/range/product state boundary.
10. `solid/excel/src/Table.tsx` — Phase 4's native 2D-virt
   implementation, ~480 LOC, the UI surface for any Phase 5+ frontend
   change.
11. `~/.claude/projects/-Volumes-work-self-einfach/memory/MEMORY.md`
   — user preferences (codex pattern, no-CI-push rule).

## What to absolutely NOT do without user permission

- `git push`
- `gh pr create`
- Touch `.github/workflows/*`
- `git reset --hard` ANY branch the user has work on
- `git rebase` the branch (110+ commits ahead of main; rebase would
  rewrite history)
- Delete `rust/docs/ONLINE_SPREADSHEET_PLAN.md` even though it's
  untracked — it's the north star

Good luck. The pattern works; the gates are tight; the hard rules are
in `~/.claude/projects/-Volumes-work-self-einfach/memory/`.
