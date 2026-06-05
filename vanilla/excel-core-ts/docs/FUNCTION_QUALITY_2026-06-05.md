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
  the function layer, e.g. ISFORMULA / ISREF).

## Fixed in this pass (7)

| # | Function | File | Gap | Difficulty |
|---|----------|------|-----|------------|
| 1 | WEEKDAY  | date.ts:251 | Only return_type 1/2/3 supported; missing 11..17 (per-weekday anchored). | S |
| 2 | WEEKNUM  | date.ts:468 | Only return_type 1/2 supported; missing 11..17 (per-weekday) and 21 (ISO 8601). | S |
| 3 | AND / OR | logical.ts:119,144 | Did not descend into array/range args — only the top-left cell mattered. Excel iterates every cell. | S |
| 4 | ARABIC   | text.ts:2865 | Rejected leading minus sign. Excel returns negatives for `=ARABIC("-IV")` etc. | S |
| 5 | ATAN2    | math.ts:567 | Returned `#NUM!` for `ATAN2(0,0)`. Microsoft docs say `#DIV/0!`. | S |
| 6 | ERF / ERFC (+ .PRECISE) | engineering.ts:635 | Swapped A&S 7.1.26 (~1.5e-7 max err) for Cody's split-interval rational Chebyshev — full IEEE 754 double-precision accuracy (~1 ULP). | M |
| 7 | ROMAN(0) | text.ts:2835 | Now returns `""` like Excel; negatives still `#VALUE!`. | S |

## Catalogued but NOT fixed

### Approximations with bounded-but-loose error

| Function | File | Gap | Difficulty |
|----------|------|-----|------------|
| BETA.INV / BETAINV | stats.ts:1812 | 100-iter bisection on `[0,1]`. Each step halves; final error ≈ 1e-30 on the unit interval but converges slowly when the regularized beta is shallow near `p`. Newton with continued-fraction derivative would be 5-10× faster and 1-2 ULP. | M |
| GAMMA.INV / GAMMAINV | stats.ts:2035 | Bisection via `inversePositiveCdf` with the upper bound doubled until `cdf(hi) >= p`. Same shape as BETA.INV — switch to Newton on `regularizedGammaP'`. | M |
| LOGNORM.INV / NORM.INV /  T.INV / F.INV | stats.ts:1662 (etc.) | Same bisection. Existing `standardNormalInv` is closed-form (Acklam) — others could route through it. | M |

### XLOOKUP `search_mode = ±2` (binary search)

| Function | File | Gap | Difficulty |
|----------|------|-----|------------|
| XLOOKUP | lookup.ts:566 | `search_mode = 2 / -2` (binary) fall back to linear scan with TODO(C3). Correct on sorted input but `O(n)`. | M (true binary search w/ nearest-side accounting for matchMode -1 / 1) |
| VLOOKUP / HLOOKUP / MATCH approximate | lookup.ts:244 / lookup.ts:677 | Approximate match is `O(n)` linear scan, even on sorted data. Acceptance tests use small fixtures. | M |

### Type / ref limitations rooted in the dispatch layer

| Function | File | Gap | Difficulty |
|----------|------|-----|------------|
| ISFORMULA | info.ts:210 | Always returns FALSE. The dispatcher pre-resolves refs into values before reaching the function, so the formula bit is lost. Needs a dispatcher-level hook. | L |
| ISREF     | info.ts:220 | Same — always FALSE. | L |
| INFO("directory" / "osversion") | info.ts:258 | Returns "" because the function layer has no filesystem / process module beyond what `globalThis` exposes. | L |
| PHONETIC  | text.ts:3059 | Passthrough of source text; Excel extracts furigana from cell metadata that einfach does not model. | L |

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

| Function | File | Gap | Difficulty |
|----------|------|-----|------------|
| STDEV / VAR / STDEVA / VARA | stats.ts:580 | Two-pass mean + sum-of-squared-deviations is fine for normal inputs but accumulates O(n) cancellation error on huge-magnitude small-spread data. Welford's online algorithm is the textbook fix. | M |
| SUMPRODUCT, SERIESSUM | math.ts:447, math.ts:1318 | Naive sum, no Kahan compensation. Modest accuracy gain for very long ranges. | M |
| CSC / SEC / COT at `Math.sin(n) ≈ 0` | math.ts:590 | We only treat exact 0 as the singularity. `CSC(PI)` yields `~8.16e15` instead of `#DIV/0!`. Excel has the same float drift, so this likely is not a divergence — verify before fixing. | S (if confirmed) |

## Survey summary

- ~500 function entries scanned (45+ in engineering, 100+ in stats, 70+
  in math, 80+ in financial, the remainder spread across array / date /
  info / logical / lookup / text / database).
- 5 S-difficulty defects fixed (Top 5 above).
- 7 M-difficulty entries catalogued — most are approximation tightening.
- 7 L-difficulty / out-of-scope entries catalogued — need engine-layer
  changes (ref-aware dispatch, locale infra, cell-format metadata).
- Notable surprise: the IRR / RATE / NPV Newton-Raphson code is already
  thorough (residual + scale + step-size guard), with the only known
  improvement being the closed-form derivative swap.

## How to use this catalog

Pick the topmost unchecked S-difficulty entry that matches your wave,
add regression tests pinning the expected behavior FIRST, then ship the
fix. M / L items deserve their own design sketch before code.
