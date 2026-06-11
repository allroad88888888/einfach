/**
 * Ultra-tier single-call bulk_import_cells bench for Phase 5 of the
 * lazy-formula-indexing arc.
 *
 * Goal: prove that with the Phase 2/3 lazy `bulk_load` (commits
 * 40bc473 + 7d0e380), the WASM linear-memory allocator no longer
 * panics on single-call payloads ≥ 1M cells. If that holds, the
 * `MAX_BULK_IMPORT_CELLS_PER_CALL = 750_000` cap installed before
 * Phase 2 is no longer required and can be removed.
 *
 * IMPORTANT: this bench requires the cap to be temporarily raised
 * (or removed) in `rust/wasm/src/lib.rs`. The default cap of 750k
 * would refuse 1M+ payloads at the pre-flight check before any
 * timing happens. The recommended sequence is:
 *
 *   1. Raise `MAX_BULK_IMPORT_CELLS_PER_CALL` to e.g. 10_000_000.
 *   2. Run `npm --prefix solid/excel run build:wasm`.
 *   3. EINFACH_PERF=1 npx jest perf-rust-bulk-import-ultra.bench.ts \
 *        --no-coverage --testTimeout=1800000
 *   4. Inspect `solid/excel/test/perf-rust-bulk-import-ultra-report.md`.
 *
 * Tiers:
 *   - 1M  (500k seeds + 500k formulas) — the headline "does it panic?"
 *   - 2M  (1M    seeds + 1M    formulas) — push past the old ceiling
 *   - 3M  (1.5M  seeds + 1.5M  formulas)
 *   - 5M  (2.5M  seeds + 2.5M  formulas) — find the new memory ceiling
 *
 * Each tier runs ONCE per workbook (fresh `WasmWorkbook`). After
 * import we sanity-check the workbook is still alive: a sample read
 * + a sample mutation + a recalc must not throw the cryptic
 * `"attempted to take ownership of Rust value while it was borrowed"`
 * error from a poisoned `WasmRefCell`.
 *
 * Workload shape mirrors `perf-rust-bulk-import-trace.bench.ts`'s
 * builder so the lazy-bulk-load behavior is exercised under a
 * realistic mix of formulas (point refs, range refs, IF, SUM).
 *
 * Gated on EINFACH_PERF=1 — skipped in the default jest sweep.
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
  bulk_import_cells(cells: ReadonlyArray<ImportCell>): unknown
  get_number(sheet: number, addr: string): number
  get_display(sheet: number, addr: string): string
  set_formula(sheet: number, addr: string, formula: string): boolean
  set_number(sheet: number, addr: string, value: number): void
  free(): void
}

type WasmModule = {
  default: (init?: { module_or_path: ArrayBufferLike }) => Promise<unknown>
  WasmWorkbook: new () => WasmWorkbookLike
}

let WasmModule: WasmModule | undefined
let wasmAvailable = false
let wasmSkipReason = ''

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

function buildWorkload(name: string, seedCount: number, formulaCount: number): ImportCell[] {
  const rng = makeRng(0xc0ffee + seedCount + formulaCount)
  const cells: ImportCell[] = new Array(seedCount + formulaCount)
  let idx = 0
  for (let row = 0; row < seedCount; row += 1) {
    cells[idx++] = {
      sheet: 0,
      row,
      col: 0,
      kind: 'number',
      value: Math.floor(rng() * 100),
    }
  }
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
    cells[idx++] = { sheet: 0, row: i, col, kind: 'formula', value: formula }
  }
  // eslint-disable-next-line no-console
  console.log(`[bench][${name}] workload built: ${cells.length} cells`)
  return cells
}

interface TierResult {
  name: string
  totalCells: number
  seeds: number
  formulas: number
  importMs: number
  peakRssMb: number
  rssGrowthMb: number
  postImportReadOk: boolean
  postImportMutateOk: boolean
  postImportRecalcOk: boolean
  error?: string
}

const results: TierResult[] = []

const TIERS: Array<{ name: string; seeds: number; formulas: number }> = [
  { name: '1M', seeds: 500_000, formulas: 500_000 },
  { name: '2M', seeds: 1_000_000, formulas: 1_000_000 },
  { name: '3M', seeds: 1_500_000, formulas: 1_500_000 },
  { name: '5M', seeds: 2_500_000, formulas: 2_500_000 },
]

function rssMb(): number {
  return process.memoryUsage.rss() / (1024 * 1024)
}

describePerf('Rust bulk_import_cells Ultra single-call bench (EINFACH_PERF=1)', () => {
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
      `${tier.name} tier — ${tier.seeds} seeds + ${tier.formulas} formulas in ONE bulk_import_cells call`,
      async () => {
        if (!wasmAvailable) {
          // eslint-disable-next-line no-console
          console.warn(`[bench] skipping ${tier.name}: ${wasmSkipReason}`)
          return
        }

        const rssBefore = rssMb()
        // Build the workload first so the workload-build cost doesn't
        // show up as "import wall time".
        const cells = buildWorkload(tier.name, tier.seeds, tier.formulas)

        const wb = new WasmModule!.WasmWorkbook()
        let importMs = NaN
        let postImportReadOk = false
        let postImportMutateOk = false
        let postImportRecalcOk = false
        let error: string | undefined
        let peakRss = rssMb()

        try {
          // eslint-disable-next-line no-console
          console.log(
            `[bench][${tier.name}] starting bulk_import_cells with ${cells.length} cells (single call)`,
          )
          const t0 = performance.now()
          wb.bulk_import_cells(cells)
          importMs = performance.now() - t0
          peakRss = Math.max(peakRss, rssMb())
          // eslint-disable-next-line no-console
          console.log(
            `[bench][${tier.name}] import OK in ${importMs.toFixed(0)} ms, RSS ${peakRss.toFixed(0)} MB (Δ +${(peakRss - rssBefore).toFixed(0)} MB)`,
          )

          // Sanity check: a read on a seed (col A) and a formula (col B)
          // should not throw. We don't assert specific values — the goal
          // here is "the WasmRefCell is not poisoned".
          try {
            const _seedVal = wb.get_display(0, 'A1')
            const _formulaVal = wb.get_display(0, 'B1')
            postImportReadOk = true
          } catch (e) {
            error = `post-import read threw: ${e instanceof Error ? e.message : String(e)}`
          }

          // Sanity check: a mutation through the production set_formula
          // path should not throw the borrow error.
          try {
            wb.set_formula(0, 'Z1', '=1+1')
            postImportMutateOk = true
          } catch (e) {
            error = error ?? `post-import mutate threw: ${e instanceof Error ? e.message : String(e)}`
          }

          // Sanity check: read back the new formula's display value,
          // which forces the workbook to evaluate it. If the WasmRefCell
          // was poisoned by the bulk_import_cells call, this throws the
          // "attempted to take ownership of Rust value while it was
          // borrowed" error from wasm-bindgen's FromWasmAbi shim.
          try {
            const got = wb.get_display(0, 'Z1')
            if (got !== '2') {
              error = error ?? `post-import recalc: expected '2' from =1+1, got ${JSON.stringify(got)}`
            } else {
              postImportRecalcOk = true
            }
          } catch (e) {
            error = error ?? `post-import recalc threw: ${e instanceof Error ? e.message : String(e)}`
          }

          peakRss = Math.max(peakRss, rssMb())
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
          // eslint-disable-next-line no-console
          console.error(`[bench][${tier.name}] import FAILED:`, error)
        }

        results.push({
          name: tier.name,
          totalCells: tier.seeds + tier.formulas,
          seeds: tier.seeds,
          formulas: tier.formulas,
          importMs,
          peakRssMb: peakRss,
          rssGrowthMb: peakRss - rssBefore,
          postImportReadOk,
          postImportMutateOk,
          postImportRecalcOk,
          error,
        })
        writeReport()

        try {
          wb.free()
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[bench][${tier.name}] free() failed (ignored):`,
            err instanceof Error ? err.message : String(err),
          )
        }

        // Hint the GC between tiers so we don't carry residual RSS
        // from the workload array into the next measurement.
        // (cells is the only large local; releasing the reference is enough)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        let _release: unknown = cells
        _release = null
        if (typeof globalThis.gc === 'function') {
          globalThis.gc()
        }
      },
      1_800_000,
    )
  }
})

function writeReport() {
  if (!PERF_ENABLED) return
  const reportPath = path.join(__dirname, 'perf-rust-bulk-import-ultra-report.md')
  const lines: string[] = []
  lines.push(`# Rust bulk_import_cells — Ultra single-call bench`)
  lines.push('')
  lines.push(`*Last run: ${new Date().toISOString()}*`)
  lines.push('')
  lines.push(
    'Each tier issues ONE `bulk_import_cells` call against a fresh `WasmWorkbook`. Pre-flight cap must be raised in `rust/wasm/src/lib.rs` for this bench to make it past the 750k default.',
  )
  lines.push('')

  if (results.length === 0) {
    lines.push('(no tiers completed — check WASM availability)')
    writeFileSync(reportPath, lines.join('\n'))
    return
  }

  lines.push('## Summary')
  lines.push('')
  lines.push(
    '| Tier | total cells | seeds | formulas | import ms | peak RSS (MB) | Δ RSS (MB) | post-read | post-mutate | post-recalc | error |',
  )
  lines.push(
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const r of results) {
    lines.push(
      `| ${r.name} | ${r.totalCells} | ${r.seeds} | ${r.formulas} | ${Number.isFinite(r.importMs) ? r.importMs.toFixed(0) : '—'} | ${r.peakRssMb.toFixed(0)} | ${r.rssGrowthMb.toFixed(0)} | ${r.postImportReadOk ? 'ok' : 'FAIL'} | ${r.postImportMutateOk ? 'ok' : 'FAIL'} | ${r.postImportRecalcOk ? 'ok' : 'FAIL'} | ${r.error ?? ''} |`,
    )
  }

  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- `import ms` is the wall-clock around `wb.bulk_import_cells(cells)` on the host (V8) side.')
  lines.push('- `peak RSS` is `process.memoryUsage.rss()` after the import + post-import sanity calls.')
  lines.push('- Δ RSS = peak RSS − RSS measured before workload build. Includes JS-side cell array AND wasm-pkg allocations.')
  lines.push('- A non-empty `error` column indicates the workbook entered a broken state (typically the "attempted to take ownership while borrowed" chain).')
  lines.push('- `post-read` / `post-mutate` / `post-recalc` exercise three downstream paths against the workbook AFTER the import. All three must be `ok` for the cap to be safely removable.')

  writeFileSync(reportPath, lines.join('\n') + '\n')
}
