# Plan — Always-on large-N test suites (2026-06-12)

**Status: LANDED** (see § Outcome at the bottom for measured budgets,
the one deviation, and the P1 the suite caught before it was even
committed).

## Why

Every major bug in the pattern-family audit arc was invisible at small N
and catastrophic at 100k+: eager hydration (2.09 s insert_row), map
clones (107 ms/keystroke), dense coordinate loops (1M calls per column
Delete), stale caches only reachable through big dirty fans. Yet the
regular test suites run at N ≤ ~100, and everything large-N lives behind
`#[ignore]` / `EINFACH_PERF` gates that pre-commit and CI never execute.

Gap: nothing CONTINUOUSLY proves correctness and complexity at scale.

## Design principles

1. **Always-on** — runs in `cargo test` / plain `npx jest`, hence in the
   pre-commit hook. Budget: ≤ 8 s added across the whole monorepo sweep
   (size N per test so each lands < 1 s; Rust debug-profile is the
   binding constraint — lazy paths make 50k–200k cheap, EVAL-heavy tests
   size down to 20–50k).
2. **Counters, not clocks** — wall-clock assertions are flaky in CI.
   Assert algorithmic complexity via the debug counters we built this
   arc: `debug_dep_graph_stats`, `debug_materialized_cell_atom_count`,
   eval/recompute counters, map-size probes. Wall-clock variants go to
   the existing `#[ignore]` / `EINFACH_PERF` benches.
3. **Closed-form values** — workloads whose correct answers are
   arithmetic identities (SUM(1..N) = N(N+1)/2, chain tail = N + edit
   delta), so correctness at scale is exact, not sampled-and-hoped.
   Sampling allowed only as a secondary check.
4. **Symmetric across engines** — every shape exists in both the Rust
   suite and the TS suite; one parity suite drives both worker runtimes
   with the same seeded workload.
5. **Deterministic** — seeded LCG when randomness is needed; no
   Date.now/Math.random.

## Test matrix

| # | Shape | Asserts (both engines unless noted) |
|---|---|---|
| S1 | Chain 50k (`A_i = A_{i-1}+1`) | tail == N (closed form); edit head → tail == N+Δ; **re-eval count == chain length, not 2×** |
| S2 | Fanout 50k (`B_i = A1*2`) | sampled values; edit A1 → dirty/bump count == N; second unrelated edit → 0 re-evals |
| S3 | Fan-in whole-col `SUM(A:A)` over 100k sparse | closed form; single cell edit → exactly 1 formula re-evals; sparse iteration touches O(existing) |
| S4 | Criteria aggregates 100k (`SUMIF`/`COUNTIF` whole-col) | closed forms (count of multiples, sum of band) |
| S5 | Spill 10k (`SEQUENCE`) | sampled targets; insert_row above → targets shifted + correct; clear anchor → target/bookkeeping maps return to baseline size |
| S6 | Cross-sheet chain 10 sheets × 10k | tail closed form; edit source sheet → tail updates; remove unrelated sheet → subscribers still fire (A-6 at scale) |
| S7 | Structural at scale: 100k LAZY formulas + insert/delete row/col | dep-graph keys stay 0 after the edit (lazy preserved); sampled reads match shifted closed form; `#REF!` band correct on delete |
| S8 | Churn/leak: 50k × (create → overwrite → clear) | all parallel tables (formula_source, needs_parse, dep maps, atoms/epochs) return to baseline; TS: evicted-atom count bounded (C-6 at scale) |
| S9 | Install/restore roundtrip 200k | restore leaves dep stats 0 (lazy); sampled + closed-form equality; full-replace teardown leaves no residue from the PREVIOUS content |
| S10 | Boundary: refs at `XFD1048576`, whole-row ops at max width, 16384-col guards, structural edits at sheet edges | no panic; correct `#REF!`/`#NUM!`; bounded work counters |
| S11 | Mutation storm: 10k single-cell edits on a 200k sheet | TS: total bump count == Σ dependents (not 10k × cached); Rust: dirty BFS visits bounded; final state closed-form |
| S12 | Registry at scale (TS-lean): 1k names + 1k custom formulas inside `withBatch`, 100k formulas referencing them | one recalc; lookups correct; throw-rollback at scale |

Parity suite (adapter level): one seeded 100k mixed workload through BOTH
worker runtimes → identical sampled values + identical error cells.

## Where they live

- `excel/rust/excel-core/tests/scale_suite.rs` — S1–S11 Rust side, always-on,
  N sized for debug profile; heavy 500k/1M twins behind `#[ignore]`.
- `excel/excel-core-ts/test/scale-suite.test.ts` — S1–S12 TS side.
- `excel/solid-excel/test/scale-parity.test.ts` — the parity run (node-side
  wasm-pkg, like the perf benches, no browser).

## Ownership of failures

A scale-suite failure is a P1 by definition (it means an O(N) regression
or a stale-cache bug re-entered). The suite IS the regression fence for
this entire audit arc.

## Outcome (2026-06-12)

| Suite | Tests | Wall | Budget verdict |
|---|---|---|---|
| `excel/rust/excel-core/tests/scale_suite.rs` | 12 always-on + 2 `#[ignore]` heavy twins | 2.9 s (debug) | ✅ within ≤5 s |
| `excel/excel-core-ts/test/scale-suite.test.ts` | 18 (S1–S12) | 4.25 s | ✅ at the ≤4 s line |
| `excel/solid-excel/test/scale-parity.test.ts` | 6 (P1–P5) | **~4.5 min** | ❌ 40× over — **gated** |

**Deviation from principle 1:** the parity suite cannot be always-on.
Measured cost is ~4.5 min (TS trampoline evaluation of ~25k formulas ×
two engines × five phases — irreducible without shrinking N below the
point where it proves anything). It is gated behind `EINFACH_SCALE=1`;
run it manually before engine-equivalence-sensitive merges:

```bash
EINFACH_SCALE=1 npx jest excel/solid-excel/test/scale-parity.test.ts --no-coverage
```

Without the env var the file skips in <1 s, so it stays in the default
`testMatch` as a visible reminder rather than a hidden bench.

**The suite already paid for itself pre-commit:** writing S3/S4 exposed
a real O(N² log N) in the TS sparse whole-column aggregate path —
every uncached cell's `refLookup` threw `NeedsDep` under the trampoline
shim, restarting the whole scan per cell (`SUM(A:A)` 458 ms @ 1k,
1.83 s @ 2k, ~hours @ 100k; `SUMIF` re-ran once per matching cell,
1.86 s @ 50k). Fix in `excel/excel-core-ts/src/eval/evaluate.ts`:
literal cells resolve directly from storage (semantics-preserving), and
formula-cell `NeedsDep` faults are accumulated and rethrown as ONE
batch, mirroring the shim's `rangeLookup` batching. S3 pins the
invalidation contract (single edit → exactly 1 re-eval) so the direct
read can't silently break dep tracking.
