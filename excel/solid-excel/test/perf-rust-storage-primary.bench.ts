/**
 * STORAGE_PRIMARY Phase 6 bench — legacy `bulk_import_cells` vs the
 * storage-primary `bulk_install_workbook` (Phase 6.1/6.2) at the 500k
 * and 1M (Mega) tiers.
 *
 * Same workload shape as `perf-rust-bulk-import-trace.bench.ts` /
 * `perf-ts-vs-wasm.bench.ts` (half primitive seeds in col A, half
 * formulas: 50% point-ref `=Ax+By`, 30% `IF`, 20% `SUM` range capped
 * at 1024) so the numbers compare directly against the published
 * trace reports.
 *
 * Per tier and per path we report:
 *   - payload build ms (JS-side wire construction — differs by path)
 *   - call wall-clock ms (the RPC into WASM: deserialize + engine)
 *
 * Sanity: after each import a few probe cells are read back through
 * `getCellDisplay` and cross-checked between the two paths, so a
 * "fast but wrong" regression cannot slip through the bench.
 *
 * Output: `perf-rust-storage-primary-report.md` next to this file.
 *
 * Invocation:
 *   EINFACH_PERF=1 npx jest perf-rust-storage-primary --no-coverage \
 *     --testTimeout=1800000
 *
 * Gated on EINFACH_PERF=1 — without it the spec is skipped.
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

type SheetBulkPayload = {
  sheet: number
  primitives: Array<[string, number | string | boolean]>
  formulas: Array<[string, string]>
}

interface InstallStats {
  sheet: number
  primitivesInstalled: number
  formulasInstalled: number
  crossSheetParsed: number
}

interface WasmWorkbookLike {
  bulk_import_cells(cells: ReadonlyArray<ImportCell>): unknown
  bulk_install_workbook(payload: ReadonlyArray<SheetBulkPayload>): InstallStats[]
  getCellDisplay(sheetIdx: number, addr: string): string
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
// Workload — mirrors perf-rust-bulk-import-trace.bench.ts.
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

interface Workload {
  cells: ImportCell[]
}

function buildWorkload(seedCount: number, formulaCount: number): Workload {
  const rng = makeRng(0xc0ffee + seedCount + formulaCount)
  const cells: ImportCell[] = []
  for (let row = 0; row < seedCount; row += 1) {
    cells.push({ sheet: 0, row, col: 0, kind: 'number', value: Math.floor(rng() * 100) })
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
    cells.push({ sheet: 0, row: i, col, kind: 'formula', value: formula })
  }
  return { cells }
}

/** Wire build for the storage-primary path: `[ "R:C", value ]` pairs. */
function buildInstallPayload(cells: ReadonlyArray<ImportCell>): SheetBulkPayload[] {
  const primitives: Array<[string, number]> = []
  const formulas: Array<[string, string]> = []
  for (const cell of cells) {
    if (cell.kind === 'number') {
      primitives.push([`${cell.row}:${cell.col}`, cell.value])
    } else {
      formulas.push([`${cell.row}:${cell.col}`, cell.value])
    }
  }
  return [{ sheet: 0, primitives, formulas }]
}

// Probe addresses read back after each import — one seed, one point-ref
// formula row, one IF row, one SUM row. Values must agree across paths.
const PROBES: ReadonlyArray<string> = ['A1', 'B1', 'C1', 'D1', 'A100', 'B100', 'C100', 'D100']

interface PathResult {
  buildMs: number
  callMs: number
  probes: Record<string, string>
  stats?: InstallStats[]
}

interface TierResult {
  name: string
  totalCells: number
  legacy?: PathResult
  storagePrimary?: PathResult
}

const results: TierResult[] = []

const TIERS: Array<{ name: string; seeds: number; formulas: number }> = [
  { name: '500k', seeds: 250_000, formulas: 250_000 },
  { name: 'Mega (1M)', seeds: 500_000, formulas: 500_000 },
]

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1) return ms.toFixed(2)
  if (ms < 100) return ms.toFixed(1)
  return ms.toFixed(0)
}

function readProbes(wb: WasmWorkbookLike): Record<string, string> {
  const out: Record<string, string> = {}
  for (const addr of PROBES) {
    out[addr] = wb.getCellDisplay(0, addr)
  }
  return out
}

function maybeGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc === 'function') gc()
}

describePerf('Rust storage-primary vs legacy bulk import (EINFACH_PERF=1)', () => {
  beforeAll(async () => {
    if (!existsSync(WASM_PKG_JS) || !existsSync(WASM_PKG_BIN)) {
      wasmSkipReason = 'wasm-pkg missing — run `npm --prefix excel/solid-excel run build:wasm`'
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
      `${tier.name} tier — ${tier.seeds} seeds + ${tier.formulas} formulas, both paths`,
      async () => {
        if (!wasmAvailable) {
          // eslint-disable-next-line no-console
          console.warn(`[bench] skipping ${tier.name}: ${wasmSkipReason}`)
          return
        }

        const workload = buildWorkload(tier.seeds, tier.formulas)
        const tierResult: TierResult = { name: tier.name, totalCells: workload.cells.length }
        // eslint-disable-next-line no-console
        console.log(`[bench] ${tier.name}: ${workload.cells.length} cells`)

        // --- Legacy path: bulk_import_cells ---------------------------
        {
          maybeGc()
          const wb = new WasmModule!.WasmWorkbook()
          try {
            // The legacy wire IS the workload array — build cost ~0,
            // but time the (identity) step anyway for symmetry.
            const tBuild0 = performance.now()
            const wire = workload.cells
            const buildMs = performance.now() - tBuild0
            const tCall0 = performance.now()
            wb.bulk_import_cells(wire)
            const callMs = performance.now() - tCall0
            tierResult.legacy = { buildMs, callMs, probes: readProbes(wb) }
            // eslint-disable-next-line no-console
            console.log(`[bench] ${tier.name} legacy bulk_import_cells: ${fmtMs(callMs)} ms`)
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(
              `[bench] ${tier.name} legacy path failed:`,
              err instanceof Error ? err.message : String(err),
            )
          }
          try {
            wb.free()
          } catch {
            // bounded leak — jest spawns one worker per file
          }
        }

        // --- Storage-primary path: bulk_install_workbook --------------
        {
          maybeGc()
          const wb = new WasmModule!.WasmWorkbook()
          try {
            const tBuild0 = performance.now()
            const payload = buildInstallPayload(workload.cells)
            const buildMs = performance.now() - tBuild0
            const tCall0 = performance.now()
            const stats = wb.bulk_install_workbook(payload)
            const callMs = performance.now() - tCall0
            tierResult.storagePrimary = { buildMs, callMs, probes: readProbes(wb), stats }
            // eslint-disable-next-line no-console
            console.log(
              `[bench] ${tier.name} storage-primary bulk_install_workbook: ${fmtMs(callMs)} ms ` +
                `(crossSheetParsed=${stats[0]?.crossSheetParsed ?? '—'})`,
            )
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(
              `[bench] ${tier.name} storage-primary path failed:`,
              err instanceof Error ? err.message : String(err),
            )
          }
          try {
            wb.free()
          } catch {
            // bounded leak — see above
          }
        }

        // --- Cross-path sanity ----------------------------------------
        if (tierResult.legacy && tierResult.storagePrimary) {
          for (const addr of PROBES) {
            const a = tierResult.legacy.probes[addr]
            const b = tierResult.storagePrimary.probes[addr]
            if (a !== b) {
              throw new Error(
                `[bench] ${tier.name} probe mismatch at ${addr}: legacy="${a}" storage-primary="${b}"`,
              )
            }
          }
        }

        results.push(tierResult)
        writeReport()
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
  const reportPath = path.join(__dirname, 'perf-rust-storage-primary-report.md')
  const lines: string[] = []
  lines.push('# Storage-primary vs legacy bulk import (Phase 6.1/6.2)')
  lines.push('')
  lines.push(`*Last run: ${new Date().toISOString()}*`)
  lines.push('')
  lines.push(
    'Legacy = `bulk_import_cells` (WorkbookLoader per-cell API). ' +
      'Storage-primary = `bulk_install_workbook` (map swap; formulas park lazily). ' +
      'Build = JS-side wire construction; call = RPC wall-clock (deserialize + engine).',
  )
  lines.push('')

  if (results.length === 0) {
    lines.push('(no tiers completed — check WASM availability)')
    writeFileSync(reportPath, lines.join('\n'))
    return
  }

  lines.push(
    '| Tier | total cells | legacy build (ms) | legacy call (ms) | sp build (ms) | sp call (ms) | call speedup | crossSheetParsed |',
  )
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const lg = r.legacy
    const sp = r.storagePrimary
    const speedup =
      lg && sp && sp.callMs > 0 ? `${(lg.callMs / sp.callMs).toFixed(1)}×` : '—'
    lines.push(
      `| ${r.name} | ${r.totalCells} | ${lg ? fmtMs(lg.buildMs) : '—'} | ${
        lg ? fmtMs(lg.callMs) : '—'
      } | ${sp ? fmtMs(sp.buildMs) : '—'} | ${sp ? fmtMs(sp.callMs) : '—'} | ${speedup} | ${
        sp?.stats?.[0]?.crossSheetParsed ?? '—'
      } |`,
    )
  }
  lines.push('')
  lines.push('Probe cells (must match across paths — bench throws on mismatch):')
  lines.push('')
  for (const r of results) {
    const sp = r.storagePrimary
    if (!sp) continue
    lines.push(
      `- ${r.name}: ${PROBES.map((p) => `${p}=${JSON.stringify(sp.probes[p])}`).join(' ')}`,
    )
  }
  lines.push('')
  writeFileSync(reportPath, lines.join('\n'))
}
