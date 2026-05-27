/**
 * Phase-decomposition bench for `WasmWorkbook.bulk_import_cells`.
 *
 * Surfaces WHY the WASM bulk import is ~108× slower than the TS engine
 * at 1M cells. The companion bench `perf-ts-vs-wasm.bench.ts` reports
 * one wall-clock per tier; this one breaks each WASM wall-clock into:
 *
 *   - `rpc_deserialize_ms`     — JsValue → Vec<...> (post-postMessage)
 *   - `parse_only_ms`          — isolated parser pass (re-runs parse
 *                                 on every formula string, discards
 *                                 the AST — purely a measurement)
 *   - `set_cell_loop_ms`       — engine spent storing primitives
 *   - `set_formula_loop_ms`    — engine spent installing formulas
 *                                 (parse + cycle check + dep wiring
 *                                 + AST storage)
 *   - `flush_ms`               — implicit `WorkbookLoader::flush`
 *                                 (dirty BFS + cross-sheet BFS +
 *                                 subscriber notify dedup)
 *   - `engine_total_ms`        — set_cell + set_formula + flush
 *
 * The `bulkImportCellsInstrumented` RPC mirrors the production
 * `bulk_import_cells` end-state (same cells, same workbook semantics)
 * but writes primitives in one loop and formulas in another so each
 * loop's wall-clock attributes to one kind. The order-of-writes does
 * NOT match production (production interleaves); for the perf workload
 * here (seeds in col A, formulas in cols B/C/D) this is invisible.
 *
 * Workloads:
 *   - 100k cells (validation point — published ratio is 69×)
 *   - 1M cells   (the published 108× headliner)
 *
 * Same 90% literal / 9% binop / 1% SUM mix as `perf-ts-vs-wasm.bench.ts`
 * keeps the numbers directly comparable to that bench's WASM column.
 *
 * Output: writes `perf-rust-bulk-import-trace-report.md` with the
 * per-phase breakdown for each tier + a super-linearity column
 * (ratio of phase_ms between 100k and 1M, with 10× = linear).
 *
 * Invocation:
 *   EINFACH_PERF=1 npx jest perf-rust-bulk-import-trace --no-coverage \
 *     --testTimeout=1800000
 *
 * Gated on EINFACH_PERF=1 — without it the spec is skipped so the
 * default `npx jest` run doesn't pay the cost.
 */
import { describe, it, beforeAll, afterAll } from '@jest/globals'
import { performance } from 'node:perf_hooks'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { TextDecoder, TextEncoder } from 'node:util'
import path from 'node:path'

const g = globalThis as unknown as {
  TextDecoder: typeof TextDecoder
  TextEncoder: typeof TextEncoder
}
if (!g.TextDecoder) g.TextDecoder = TextDecoder
if (!g.TextEncoder) g.TextEncoder = TextEncoder

const PERF_ENABLED = process.env.EINFACH_PERF === '1'
const describePerf = PERF_ENABLED ? describe : describe.skip

const WASM_PKG_JS = path.join(__dirname, '..', 'wasm-pkg', 'einfach_wasm.js')
const WASM_PKG_BIN = path.join(__dirname, '..', 'wasm-pkg', 'einfach_wasm_bg.wasm')

type ImportCell =
  | { sheet: number; row: number; col: number; kind: 'number'; value: number }
  | { sheet: number; row: number; col: number; kind: 'formula'; value: string }

interface WasmWorkbookLike {
  bulkImportCellsInstrumented(cells: ReadonlyArray<ImportCell>): unknown
  debugLastBulkImportPhaseMs(): Float64Array
  free(): void
}

type WasmModule = {
  default: (init?: { module_or_path: ArrayBufferLike }) => Promise<unknown>
  WasmWorkbook: new () => WasmWorkbookLike
}

let WasmModule: WasmModule | undefined
let wasmAvailable = false
let wasmSkipReason = ''

// ---------------------------------------------------------------------
// Workload helpers — mirrors the shape of perf-ts-vs-wasm.bench.ts so
// the numbers compare directly. SUM ranges are capped at 1024 cells to
// match that bench's `SUM_RANGE_CAP` (production sheets rarely have
// running totals across more than a few thousand rows).
// ---------------------------------------------------------------------
const SUM_RANGE_CAP = 1024

function colLetters(col: number): string {
  let out = ''
  let n = col
  while (true) {
    out = String.fromCharCode(65 + (n % 26)) + out
    if (n < 26) return out
    n = Math.floor(n / 26) - 1
  }
}
function a1(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`
}

function makeRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

// Build a workload: N literal seeds in column A, then M formulas
// staggered across cols B/C/D. Returns ONE pre-built array suitable
// to feed `bulkImportCellsInstrumented` in a single call.
interface Workload {
  name: string
  cells: ImportCell[]
  seedCount: number
  formulaCount: number
}

function buildWorkload(name: string, seedCount: number, formulaCount: number): Workload {
  const rng = makeRng(0xc0ffee + seedCount + formulaCount)
  const cells: ImportCell[] = []
  // Seeds.
  for (let row = 0; row < seedCount; row += 1) {
    cells.push({
      sheet: 0,
      row,
      col: 0,
      kind: 'number',
      value: Math.floor(rng() * 100),
    })
  }
  // Formulas — 50% =Ax+By, 30% =IF(Ax>10, Ax*2, 0), 20% =SUM(A1:An).
  for (let i = 0; i < formulaCount; i += 1) {
    const kind = rng()
    const sourceRow = 1 + Math.floor(rng() * Math.max(1, seedCount - 1))
    let formula: string
    let col: number
    if (kind < 0.5) {
      const a = 1 + Math.floor(rng() * Math.max(1, seedCount - 1))
      const b = 1 + Math.floor(rng() * Math.max(1, seedCount - 1))
      formula = `=${a1(a, 0)}+${a1(b, 0)}`
      col = 1
    } else if (kind < 0.8) {
      formula = `=IF(${a1(sourceRow, 0)}>10,${a1(sourceRow, 0)}*2,0)`
      col = 2
    } else {
      const limit = Math.max(1, Math.min(SUM_RANGE_CAP - 1, sourceRow))
      formula = `=SUM(${a1(0, 0)}:${a1(limit, 0)})`
      col = 3
    }
    cells.push({ sheet: 0, row: i, col, kind: 'formula', value: formula })
  }
  return { name, cells, seedCount, formulaCount }
}

// ---------------------------------------------------------------------
// Phase reading helpers. The Rust side packs phase ms into a flat
// Float64Array in a fixed order — see `debug_last_bulk_import_phase_ms`
// in `rust/wasm/src/lib.rs`. We keep the indices in one place so a
// reorder on the Rust side becomes a one-line diff here.
// ---------------------------------------------------------------------
const PHASE_INDEX = {
  cellCount: 0,
  formulaCount: 1,
  rpcDeserializeMs: 2,
  parseOnlyMs: 3,
  setCellLoopMs: 4,
  setFormulaLoopMs: 5,
  flushMs: 6,
  engineTotalMs: 7,
} as const

interface PhaseSnapshot {
  cellCount: number
  formulaCount: number
  rpcDeserializeMs: number
  parseOnlyMs: number
  setCellLoopMs: number
  setFormulaLoopMs: number
  flushMs: number
  engineTotalMs: number
  // Computed:
  jsWallMs: number // wall-clock around the RPC (includes deserialize + engine)
  unaccountedMs: number // jsWall − (deserialize + engineTotal); ≈ wasm-bindgen boundary
}

function readPhases(wb: WasmWorkbookLike, jsWallMs: number): PhaseSnapshot {
  const a = wb.debugLastBulkImportPhaseMs()
  if (a.length === 0) {
    throw new Error('phase array empty — instrumented call did not record timings')
  }
  const engineTotalMs = a[PHASE_INDEX.engineTotalMs]
  const rpcDeserializeMs = a[PHASE_INDEX.rpcDeserializeMs]
  return {
    cellCount: a[PHASE_INDEX.cellCount],
    formulaCount: a[PHASE_INDEX.formulaCount],
    rpcDeserializeMs,
    parseOnlyMs: a[PHASE_INDEX.parseOnlyMs],
    setCellLoopMs: a[PHASE_INDEX.setCellLoopMs],
    setFormulaLoopMs: a[PHASE_INDEX.setFormulaLoopMs],
    flushMs: a[PHASE_INDEX.flushMs],
    engineTotalMs,
    jsWallMs,
    unaccountedMs: Math.max(0, jsWallMs - rpcDeserializeMs - engineTotalMs),
  }
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1) return ms.toFixed(2)
  if (ms < 100) return ms.toFixed(1)
  return ms.toFixed(0)
}

function pct(part: number, whole: number): string {
  if (!Number.isFinite(whole) || whole <= 0) return '—'
  return `${((part / whole) * 100).toFixed(1)}%`
}

// ---------------------------------------------------------------------
// Bench runner. `runs` repetitions per tier; reports median across
// runs to take the edge off Node's first-call warmup. Each run uses
// a fresh `WasmWorkbook` so engine state from a previous tier doesn't
// linger (and so we don't trip over the wasm-bindgen 1M-cell allocator
// limit by reusing one workbook for both tiers).
// ---------------------------------------------------------------------
interface TierResult {
  name: string
  totalCells: number
  formulas: number
  phases: PhaseSnapshot
  jsWallRuns: number[]
}

const results: TierResult[] = []

// Tier sizing notes:
//
// - 100k:   matches the published `Large` tier in `perf-ts-vs-wasm.bench.ts`
//           (where the WASM column came in at 4682 ms — 69× the TS engine).
// - 250k:   midpoint — lets us draw a super-linearity line with three data
//           points instead of two.
// - 500k:   matches `XLarge` in the other bench. wasm32 linear memory holds
//           up here; 1M does not. The instrumented variant's two-pass
//           write loop + per-formula string clone roughly doubles peak
//           wasm allocation versus the production `bulk_import_cells`,
//           so we cap at 500k to keep this debug surface usable. The
//           1M crossover is documented in PERF_BULK_IMPORT.md; the
//           shape from 100k → 500k is enough to confirm super-linearity.
const TIERS: Array<{ name: string; seeds: number; formulas: number; runs: number }> = [
  { name: '100k', seeds: 50_000, formulas: 50_000, runs: 1 },
  { name: '250k', seeds: 125_000, formulas: 125_000, runs: 1 },
  { name: '500k', seeds: 250_000, formulas: 250_000, runs: 1 },
]

function median(values: number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function medianPhases(snaps: PhaseSnapshot[]): PhaseSnapshot {
  return {
    cellCount: snaps[0].cellCount, // constant across runs
    formulaCount: snaps[0].formulaCount,
    rpcDeserializeMs: median(snaps.map((s) => s.rpcDeserializeMs)),
    parseOnlyMs: median(snaps.map((s) => s.parseOnlyMs)),
    setCellLoopMs: median(snaps.map((s) => s.setCellLoopMs)),
    setFormulaLoopMs: median(snaps.map((s) => s.setFormulaLoopMs)),
    flushMs: median(snaps.map((s) => s.flushMs)),
    engineTotalMs: median(snaps.map((s) => s.engineTotalMs)),
    jsWallMs: median(snaps.map((s) => s.jsWallMs)),
    unaccountedMs: median(snaps.map((s) => s.unaccountedMs)),
  }
}

describePerf('Rust bulk-import phase-decomp bench (EINFACH_PERF=1)', () => {
  beforeAll(async () => {
    if (!existsSync(WASM_PKG_JS) || !existsSync(WASM_PKG_BIN)) {
      wasmSkipReason = `wasm-pkg missing — run \`npm --prefix solid/excel run build:wasm\``
      return
    }
    try {
      const mod = (await import(WASM_PKG_JS)) as WasmModule
      const bytes = readFileSync(WASM_PKG_BIN)
      await mod.default({
        module_or_path: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      })
      WasmModule = mod
      wasmAvailable = true
    } catch (err) {
      wasmSkipReason = `wasm load failed: ${err instanceof Error ? err.message : String(err)}`
    }
  })

  afterAll(() => {
    writeReport()
  })

  for (const tier of TIERS) {
    it(
      `${tier.name} tier — ${tier.seeds} seeds + ${tier.formulas} formulas`,
      async () => {
        if (!wasmAvailable) {
          // eslint-disable-next-line no-console
          console.warn(`[bench] skipping ${tier.name}: ${wasmSkipReason}`)
          return
        }

        const workload = buildWorkload(tier.name, tier.seeds, tier.formulas)
        // eslint-disable-next-line no-console
        console.log(
          `[bench] ${tier.name}: ${workload.cells.length} total cells (${tier.seeds} seeds + ${tier.formulas} formulas)`,
        )

        const snaps: PhaseSnapshot[] = []
        const wallRuns: number[] = []
        for (let i = 0; i < tier.runs; i += 1) {
          const wb = new WasmModule!.WasmWorkbook()
          let importSucceeded = false
          try {
            const t0 = performance.now()
            wb.bulkImportCellsInstrumented(workload.cells)
            const wall = performance.now() - t0
            wallRuns.push(wall)
            snaps.push(readPhases(wb, wall))
            importSucceeded = true
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(
              `[bench] ${tier.name} run ${i} import failed:`,
              err instanceof Error ? err.message : String(err),
            )
          }
          // Persist this run's data BEFORE attempting `free()`. At very
          // large workloads (1M cells) the wasm-bindgen &mut self borrow
          // can deadlock/throw on free even after a clean import return —
          // wasm-bindgen's borrow tracker is not always coherent with a
          // 7+ minute mutating call. By pushing partial results here,
          // a free()-side failure doesn't lose the engine breakdown we
          // already captured.
          if (importSucceeded && snaps.length > 0) {
            results.push({
              name: tier.name,
              totalCells: workload.cells.length,
              formulas: workload.formulaCount,
              phases: medianPhases(snaps),
              jsWallRuns: [...wallRuns],
            })
            writeReport()
          }

          try {
            wb.free()
          } catch (err) {
            // Swallow — see comment above. Process exits soon (jest
            // spawns one worker per file), so the leak is bounded.
            // eslint-disable-next-line no-console
            console.warn(
              `[bench] ${tier.name} run ${i} free() failed (ignored):`,
              err instanceof Error ? err.message : String(err),
            )
          }
        }
      },
      1_800_000,
    )
  }
})

// ---------------------------------------------------------------------
// Report writer.
// ---------------------------------------------------------------------
function writeReport() {
  if (!PERF_ENABLED) return
  const reportPath = path.join(__dirname, 'perf-rust-bulk-import-trace-report.md')
  const lines: string[] = []
  lines.push(`# Rust bulk-import phase-decomposition`)
  lines.push('')
  lines.push(`*Last run: ${new Date().toISOString()}*`)
  lines.push('')

  if (results.length === 0) {
    lines.push('(no tiers completed — check WASM availability)')
    writeFileSync(reportPath, lines.join('\n'))
    return
  }

  lines.push('## Per-tier phase breakdown')
  lines.push('')
  lines.push(
    '| Tier | total cells | JS wall (ms) | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |',
  )
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const p = r.phases
    lines.push(
      `| ${r.name} | ${r.totalCells} | ${fmtMs(p.jsWallMs)} | ${fmtMs(p.rpcDeserializeMs)} | ${fmtMs(p.parseOnlyMs)} | ${fmtMs(p.setCellLoopMs)} | ${fmtMs(p.setFormulaLoopMs)} | ${fmtMs(p.flushMs)} | ${fmtMs(p.engineTotalMs)} | ${fmtMs(p.unaccountedMs)} |`,
    )
  }

  lines.push('')
  lines.push('## Phase share (% of JS wall)')
  lines.push('')
  lines.push(
    '| Tier | deserialize | parse-only | set_cell loop | set_formula loop | flush | engine total | unaccounted |',
  )
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const p = r.phases
    lines.push(
      `| ${r.name} | ${pct(p.rpcDeserializeMs, p.jsWallMs)} | ${pct(p.parseOnlyMs, p.jsWallMs)} | ${pct(p.setCellLoopMs, p.jsWallMs)} | ${pct(p.setFormulaLoopMs, p.jsWallMs)} | ${pct(p.flushMs, p.jsWallMs)} | ${pct(p.engineTotalMs, p.jsWallMs)} | ${pct(p.unaccountedMs, p.jsWallMs)} |`,
    )
  }

  // Super-linearity analysis — first vs last available tier. With ≥2
  // tiers we compute the ratio of phase ms; expected linear ratio =
  // total_cells_ratio. Anything materially above that is super-linear.
  if (results.length >= 2) {
    const smaller = results[0]
    const larger = results[results.length - 1]
    const cellRatio = larger.totalCells / smaller.totalCells
    lines.push('')
    lines.push(
      `## Super-linearity (ratio of \`${larger.name}\` to \`${smaller.name}\` phase ms)`,
    )
    lines.push('')
    lines.push(
      `Cell-count ratio = ${cellRatio.toFixed(2)}×. A linear phase grows at the same ratio; >cellRatio = super-linear.`,
    )
    lines.push('')
    const ratio = (a: number, b: number) => (b > 0 ? a / b : NaN)
    const sp = smaller.phases
    const lp = larger.phases
    lines.push(`| Phase | ${smaller.name} (ms) | ${larger.name} (ms) | Ratio | Verdict |`)
    lines.push('| --- | --- | --- | --- | --- |')
    const rows: Array<[string, number, number]> = [
      ['deserialize', lp.rpcDeserializeMs, sp.rpcDeserializeMs],
      ['parse-only', lp.parseOnlyMs, sp.parseOnlyMs],
      ['set_cell loop', lp.setCellLoopMs, sp.setCellLoopMs],
      ['set_formula loop', lp.setFormulaLoopMs, sp.setFormulaLoopMs],
      ['flush', lp.flushMs, sp.flushMs],
      ['engine total', lp.engineTotalMs, sp.engineTotalMs],
      ['JS wall', lp.jsWallMs, sp.jsWallMs],
    ]
    const upper = cellRatio * 1.5
    const lower = cellRatio * 0.9
    for (const [name, big, small] of rows) {
      const r = ratio(big, small)
      const verdict = !Number.isFinite(r)
        ? '—'
        : r > upper
          ? 'super-linear'
          : r >= lower
            ? 'linear-ish'
            : 'sub-linear'
      lines.push(`| ${name} | ${fmtMs(small)} | ${fmtMs(big)} | ${r.toFixed(2)}× | ${verdict} |`)
    }
  }

  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- `deserialize` is `serde_wasm_bindgen::from_value` (JS → Rust).')
  lines.push('- `parse-only` is an ISOLATED parse pass run before the engine — same parser, AST discarded.')
  lines.push('- `set_cell loop` writes primitives only (no parsing).')
  lines.push('- `set_formula loop` writes formulas only — INCLUDES the engine re-running the parser, cycle check, and dep wiring.')
  lines.push('- `flush` = `engineTotal − (set_cell + set_formula)`. This is `WorkbookLoader::flush` + per-sheet `BulkLoader::flush`.')
  lines.push('- `unaccounted` = `jsWall − (deserialize + engineTotal)`. Approximates wasm-bindgen boundary + JS-side V8 work building the input array.')
  lines.push('- Write order in the instrumented variant differs from production (primitives first, then formulas). For the disjoint-column workload here it does not affect engine cost.')

  writeFileSync(reportPath, lines.join('\n') + '\n')
}
