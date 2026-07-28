# Function Quality Survey — 2026-06-05

After hitting 500/500 name parity with the Rust engine, this audit walks
`src/eval/functions/*.ts` looking for degraded stubs, approximations, and
documented divergences from Excel. Each entry below names the function,
the gap, and a difficulty estimate (S/M/L) for future agents to pick
from.

Difficulty key:
- **S** — additive change inside one function, no helper refactor, no
  signature change. Can ship with a few regression tests.
- **M** — needs new helper, evaluator integration, or rewriting an
  approximation kernel.
- **L** — architectural (depends on engine-aware state we don't expose at
  the function layer, e.g. locale infra or cell-format metadata).

## Already correct, catalog was stale

These were flagged as gaps in the first pass but verification in a
follow-up agent showed they already match Excel. No code change needed —
they are tracked here so future audits do not re-open them.

| Function | File | Original flag | Why it's actually fine |
|----------|------|---------------|------------------------|
| ISFORMULA | info.ts:210 | "Always FALSE — dispatcher pre-resolves refs" (L) | The evaluator intercepts `ISFORMULA` in `evaluate.ts:437` (`evaluateIsFormula`) BEFORE the registry dispatcher, walking the raw `Expr` and inspecting `cell.ast`. The `info.ts` impl is a fallback that only runs if the arg isn't ref-shaped. Pinned by `reference-functions.test.ts:290`. |
| ISREF     | info.ts:220 | "Always FALSE — refs pre-resolved" (L) | Same shape: `evaluate.ts:439` (`evaluateIsRef`) walks the `Expr` directly — single refs, ranges, multi-areas, and `INDEX(...)` all return TRUE; non-ref expressions like `1+2` return FALSE. Pinned by `reference-functions.test.ts:290`. |
| INFO("system") | info.ts:258 | Implicit "good enough" | Already returns `mac`/`pc`/`other` from `process.platform` / `navigator.platform`. |
| CSC / SEC / COT at `Math.sin(n) ≈ 0` | math.ts:602 | "`CSC(PI)` returns ~8.16e15 instead of `#DIV/0!`" (S if confirmed) | **Confirmed: Excel returns ~8.16e15 too.** Microsoft only documents `#NUM!` when `1/sin(n)` overflows; sin(PI) ≈ 1.22e-16, so `1/sin(PI)` is a finite ~8.16e15. Closed without code change. |

## Fixed in this pass (8)

| # | Function | File | Gap | Difficulty |
|---|----------|------|-----|------------|
| 1 | WEEKDAY  | date.ts:251 | Only return_type 1/2/3 supported; missing 11..17 (per-weekday anchored). | S |
| 2 | WEEKNUM  | date.ts:468 | Only return_type 1/2 supported; missing 11..17 (per-weekday) and 21 (ISO 8601). | S |
| 3 | AND / OR | logical.ts:119,144 | Did not descend into array/range args — only the top-left cell mattered. Excel iterates every cell. | S |
| 4 | ARABIC   | text.ts:2865 | Rejected leading minus sign. Excel returns negatives for `=ARABIC("-IV")` etc. | S |
| 5 | ATAN2    | math.ts:567 | Returned `#NUM!` for `ATAN2(0,0)`. Microsoft docs say `#DIV/0!`. | S |
| 6 | ERF / ERFC (+ .PRECISE) | engineering.ts:635 | Swapped A&S 7.1.26 (~1.5e-7 max err) for Cody's split-interval rational Chebyshev — full IEEE 754 double-precision accuracy (~1 ULP). | M |
| 7 | ROMAN(0) | text.ts:2835 | Now returns `""` like Excel; negatives still `#VALUE!`. | S |
| 8 | INFO("directory") / INFO("osversion") | info.ts:258 | Were hardcoded to `""`. Now runtime-aware: Node returns `process.cwd()` / `${platform} ${version}`; browser/worker returns `location.origin` / `navigator.userAgent`; empty only if neither surface exists. | S |

## Catalogued but NOT fixed

### Approximations with bounded-but-loose error

(All entries from the first pass — BETA.INV, GAMMA.INV, LOGNORM.INV,
NORM.INV, T.INV, F.INV — landed in `dfafe73`. See "Closed since first
pass" below.)

### XLOOKUP `search_mode = ±2` (binary search)

(All entries from the first pass — XLOOKUP, VLOOKUP, HLOOKUP, MATCH
approximate match — landed in `f5bc362`. See "Closed since first pass"
below.)

### Type / ref limitations rooted in the dispatch layer

| Function | File | Gap | Difficulty |
|----------|------|-----|------------|
| PHONETIC  | text.ts:3059 | Passthrough of source text; Excel extracts furigana from cell metadata that einfach does not model. | L |

(ISFORMULA / ISREF / INFO("directory") / INFO("osversion") moved out of
this table — see the "Already correct, catalog was stale" and "Closed
since first pass" sections above and below.)

### Localization / format

| Function | File | Gap | Difficulty |
|----------|------|-----|------------|
| TEXT     | text.ts:1855 | Implements US English locale only — no `[$-409]` locale tags, no Buddhist / Hijri calendars, no per-locale separator overrides. | L |
| DOLLAR   | text.ts:2761 | Hard-coded `$` prefix. Excel uses the system currency for the active locale. | M |
| FIXED    | text.ts:2779 | Comma thousands separator only; locale-aware separator would need new infra. | M |

### Excel-specific quirks NOT replicated

| Function | File | Gap | Difficulty |
|----------|------|-----|------------|
| DATEDIF "MD" | date.ts:569 | Microsoft documents that DATEDIF "MD" can return negative values (their words: "incorrect results") on certain inputs. We compute the algebraically correct version. Pinning this to match Excel's bug would be a behavior regression for most users — keep as documented divergence. | S, but DO NOT FIX |
| TIME(h, m, s) max range | date.ts:317 | Excel caps each component at 32767; we match. Excel additionally allows fractional hours and uses them; we truncate. Spreadsheet UIs always pass integers, so low impact. | M |
| RATE convergence | financial.ts:321 | TODO(F1) flagged inline: switch to analytical derivative for ~2× perf on Newton-Raphson. Correctness already matches Excel within `RATE_RESIDUAL_REL_TOLERANCE`. | M |

### Numerical stability (not buggy, just suboptimal)

(STDEV / VAR family + SUMPRODUCT / SERIESSUM landed in `dfafe73` /
`f677e6d`. CSC / SEC / COT confirmed to match Excel — see "Already
correct, catalog was stale" above.)

## Closed since first pass

Rollup of the M-tier wins landed after the initial 5 S-fixes. Each entry
references the commit that closed it.

| Function(s) | Commit | What changed |
|-------------|--------|--------------|
| ERF / ERFC / ERF.PRECISE / ERFC.PRECISE | `d7830d9` | Abramowitz polynomial (~1.5e-7) → Cody split-interval rational Chebyshev (~1 ULP). Aliases intact. |
| VLOOKUP / HLOOKUP / MATCH approximate + XLOOKUP search_mode=±2 | `f5bc362` | Shared `binarySearchSorted` with exact / lte / gte modes; linear fallback on unsortable input. |
| ROMAN(0), DOLLAR / FIXED regression coverage | `4efc3f1` | `ROMAN(0)` → `""`. Locale-aware DOLLAR/FIXED remains L-difficulty. |
| BETA.INV / BETAINV / GAMMA.INV / GAMMAINV / T.INV / F.INV | `dfafe73` | Newton-Raphson seeded at the mean with bisection fallback. T.INV df=1 closed form (Cauchy); T.INV df>1 and F.INV use Wilson-Hilferty seeds. |
| STDEV / VAR family (12 variants) | `dfafe73` | Routed through Welford's online algorithm — cancellation-resistant variance for huge-magnitude small-spread data. |
| SUMPRODUCT, SERIESSUM | `f677e6d` | SUMPRODUCT: Kahan-Babuška-Neumaier compensated sum (recovers `1e20 + 1 − 1e20 = 1`). SERIESSUM: plain Kahan. |
| INFO("directory") / INFO("osversion") | _this session_ | Runtime-aware host queries (Node `process.cwd()` / `${platform} ${version}`; browser `location.origin` / `navigator.userAgent`). |

## Survey summary

- ~500 function entries scanned (45+ in engineering, 100+ in stats, 70+
  in math, 80+ in financial, the remainder spread across array / date /
  info / logical / lookup / text / database).
- **Fixed:** 8 entries — 5 initial S-tier defects + 3 follow-up M/S wins
  (ERF rewrite, lookup binary search, BETA/GAMMA/T/F Newton inverses,
  Welford variance, Kahan summation, INFO runtime metadata).
  Eight more were already-correct catalog noise that the first pass
  flagged in error (ISFORMULA, ISREF, INFO("system"), CSC/SEC/COT
  matching Excel float drift).
- **Remaining real work** (4 entries):
  - TEXT locale infra (L) — `[$-409]` tags, Buddhist / Hijri calendars,
    per-locale separators.
  - PHONETIC (L) — needs furigana cell metadata einfach does not model.
  - DOLLAR / FIXED full locale (M, deferred) — currency symbol +
    separator come from system locale; needs the same infra as TEXT.
  - RATE convergence (M, perf not correctness) — analytical derivative
    swap for ~2× Newton-Raphson speedup.
- DATEDIF "MD" / TIME fractional hours are documented divergences kept
  on purpose; not counted in remaining work.
- Notable surprise: the IRR / RATE / NPV Newton-Raphson code is already
  thorough (residual + scale + step-size guard), with the only known
  improvement being the closed-form derivative swap.

## How to use this catalog

Pick the topmost unchecked S-difficulty entry that matches your wave,
add regression tests pinning the expected behavior FIRST, then ship the
fix. M / L items deserve their own design sketch before code.
