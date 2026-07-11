/**
 * TS-core vs WASM-core perf bench.
 *
 * Compares `@einfach/excel-core-ts` (the new TS engine) against
 * `rust/excel-core` (via the wasm-pack output in `solid/excel/wasm-pkg/`)
 * on identical workloads. Reports:
 *
 *   - cold setup (initWorkbook + seed N literal cells)
 *   - bulk-write (set M formulas after the seed)
 *   - read-back (read every formula cell)
 *   - targeted recalc (mutate A1, then re-read every formula cell)
 *
 * Across three workload sizes (Tiny / Medium / Large).
 *
 * Discipline:
 *   - Both backends are driven IN-PROCESS — no real Worker, no
 *     postMessage. Eliminates serialization overhead from the
 *     comparison. TS goes through `createWorkerRuntimeTs().handle()`
 *     (RPC indirection still present, but synchronous). WASM goes
 *     directly through `WasmWorkbook` instance methods (the RPC
 *     handler in `worker-runtime.ts` auto-installs onto `self` and
 *     can't be invoked twice cleanly under jest, so we skip the
 *     dispatcher and call the same wasm-bindgen methods the
 *     dispatcher would call).
 *   - Gated on `EINFACH_PERF=1` — without it, every spec is skipped
 *     so the default `npx jest` run isn't slowed down.
 *   - Skips WASM gracefully if `wasm-pkg/` is missing or the .wasm
 *     fails to instantiate.
 *
 * Output: this bench writes `perf-ts-vs-wasm-report.md` with the
 * numbers, ratios, and a verdict per row. Set
 * `EINFACH_PERF_WRITE_REPORT=0` for an observation-only run that prints
 * results without modifying the historical report.
 *
 * Invocation:
 *   EINFACH_PERF=1 npx jest --testRegex 'perf-ts-vs-wasm\.bench\.ts$' --no-coverage
 *
 * (The `.bench.ts` suffix keeps the file out of the default jest
 * `testMatch` glob, so `npx jest` without flags ignores it. The
 * `--testRegex` override is the discovery trick.)
 */
import { describe, it, beforeAll, afterAll } from '@jest/globals'
import { performance } from 'node:perf_hooks'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { TextDecoder, TextEncoder } from 'node:util'
import path from 'node:path'

import { createWorkerRuntimeTs, type ExcelCoreTsWorkerRuntime } from '../src-vnext/adapter/worker-runtime-ts'

// jsdom under jest doesn't expose TextDecoder/TextEncoder; the
// wasm-bindgen glue grabs them at module-load time, so patch globals
// BEFORE we attempt to import the wasm module.
const g = globalThis as unknown as {
  TextDecoder: typeof TextDecoder
  TextEncoder: typeof TextEncoder
}
if (!g.TextDecoder) g.TextDecoder = TextDecoder
if (!g.TextEncoder) g.TextEncoder = TextEncoder

// ---------------------------------------------------------------------------
// Gate the whole bench on EINFACH_PERF=1 — without it the default `npx jest`
// run skips every spec immediately. We still build all the helpers/types so
// the file compiles cleanly under `tsc -b`.
// ---------------------------------------------------------------------------
const PERF_ENABLED = process.env.EINFACH_PERF === '1'
const PERF_WRITE_REPORT = process.env.EINFACH_PERF_WRITE_REPORT !== '0'
const describePerf = PERF_ENABLED ? describe : describe.skip

function logPerfOutcome(name: string, backend: 'TS' | 'WASM', outcome: unknown): void {
  // eslint-disable-next-line no-console -- opt-in benchmark result
  console.log(`[bench][result] ${name} ${backend} ${JSON.stringify(outcome)}`)
}

const WASM_PKG_JS = path.join(
  __dirname,
  '..',
  'wasm-pkg',
  'einfach_wasm.js',
)
const WASM_PKG_BIN = path.join(
  __dirname,
  '..',
  'wasm-pkg',
  'einfach_wasm_bg.wasm',
)

// Detection happens lazily — `beforeAll` records whether the WASM
// runtime is reachable, and individual specs branch accordingly.
let wasmAvailable = false
let wasmSkipReason = ''
type WasmWorkbookCtor = new () => WasmWorkbookLike
type WasmModule = {
  default: (init?: { module_or_path: ArrayBufferLike }) => Promise<unknown>
  WasmWorkbook: WasmWorkbookCtor
}
let WasmModule: WasmModule | undefined

interface WasmWorkbookLike {
  set_cell_number(sheet: number, addr: string, value: number): void
  setFormulaAt(sheet: number, addr: string, src: string): boolean
  snapshotCell(sheet: number, addr: string): { display: string; type: string }
  bulk_import_cells(
    cells: ReadonlyArray<
      | { sheet: number; row: number; col: number; kind: 'number'; value: number }
      | { sheet: number; row: number; col: number; kind: 'formula'; value: string }
    >,
  ): unknown
  debug_formula_eval_count(sheetIdx: number): number
  free(): void
}

// ---------------------------------------------------------------------------
// A1 helpers (avoid pulling parseA1 just so we don't dilute the bench setup
// time numbers with helper-import cost).
// ---------------------------------------------------------------------------
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
  // Excel is 1-indexed for rows.
  return `${colLetters(col)}${row + 1}`
}

// ---------------------------------------------------------------------------
// Workload definition. A workload is a deterministic sequence of literal
// seed cells (numbers) and formula cells. Built once for a given size; both
// backends consume the SAME object.
// ---------------------------------------------------------------------------
interface SeedCell {
  row: number
  col: number
  value: number
}
interface FormulaCell {
  row: number
  col: number
  formula: string
}
interface Workload {
  name: string
  seeds: SeedCell[]
  formulas: FormulaCell[]
  // Cells we read for the read-back + recalc passes. Same as formulas;
  // pre-formatted for fast iteration in the timed loop.
  formulaAddrs: string[]
}

// Tiny LCG so the workload is reproducible across runs without pulling
// crypto/seedrandom. Same seed = same workload shape.
function makeRng(seed: number) {
  let s = seed >>> 0
  return () => {
    // Numerical Recipes LCG.
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

// SUM ranges are bounded to this many cells regardless of workload size.
// Letting them grow to full-column for the Large workload means each
// running-total eval iterates ~100k cells; combined with 50k formulas
// (20% of which are SUMs), that's ~1B Map.get ops just for read-back —
// dwarfs the rest of the bench. Production sheets rarely have running
// totals across more than a few thousand rows, so we cap here.
const SUM_RANGE_CAP = 1024

function buildWorkload(name: string, cells: number, formulas: number): Workload {
  const rng = makeRng(0xc0ffee + cells + formulas)
  // Seeds live in column A (col 0). `cells` is the count of literal
  // numeric seed cells in A.
  const seeds: SeedCell[] = []
  for (let row = 0; row < cells; row += 1) {
    seeds.push({ row, col: 0, value: Math.floor(rng() * 100) })
  }
  // Formulas live in columns B/C/D (cols 1/2/3) per their kind,
  // staggered to avoid one cell being overwritten by two formulas.
  // 50% =Ax+By, 30% =IF(Ax>10, Bx*2, 0), 20% =SUM(A1:A<bounded>).
  const formulasOut: FormulaCell[] = []
  for (let i = 0; i < formulas; i += 1) {
    const kind = rng()
    // Pick a row in the seed range; -1 so we never reference row 0
    // (which is the recalc trigger).
    const sourceRow = 1 + Math.floor(rng() * Math.max(1, cells - 1))
    if (kind < 0.5) {
      // =Ax+By — two random earlier rows.
      const a = 1 + Math.floor(rng() * Math.max(1, cells - 1))
      const b = 1 + Math.floor(rng() * Math.max(1, cells - 1))
      formulasOut.push({
        row: i,
        col: 1,
        formula: `=${a1(a, 0)}+${a1(b, 0)}`,
      })
    } else if (kind < 0.8) {
      // =IF(Ax>10, Bx*2, 0)
      formulasOut.push({
        row: i,
        col: 2,
        formula: `=IF(${a1(sourceRow, 0)}>10,${a1(sourceRow, 0)}*2,0)`,
      })
    } else {
      // =SUM(A1:A<bounded>) — running total over the first ~1k rows.
      const limit = Math.max(1, Math.min(SUM_RANGE_CAP - 1, sourceRow))
      formulasOut.push({
        row: i,
        col: 3,
        formula: `=SUM(${a1(0, 0)}:${a1(limit, 0)})`,
      })
    }
  }
  return {
    name,
    seeds,
    formulas: formulasOut,
    formulaAddrs: formulasOut.map((f) => a1(f.row, f.col)),
  }
}

// ---------------------------------------------------------------------------
// Driver: TS backend. Goes through the `worker-runtime-ts` RPC handler
// to match the "what the actual worker would do" surface area.
// ---------------------------------------------------------------------------
interface BackendDriver {
  setup(): Promise<void>
  bulkWrite(): Promise<void>
  readBack(): Promise<void>
  recalc(): Promise<void>
  dispose(): void
}

function makeTsDriver(workload: Workload): BackendDriver {
  let runtime: ExcelCoreTsWorkerRuntime
  let rpcId = 0
  const rpc = async (msg: Record<string, unknown>) => {
    rpcId += 1
    const resp = await runtime.handle({ id: rpcId, ...msg })
    if (!resp.ok) {
      throw new Error(`ts rpc ${String(msg.cmd)} failed: ${resp.error.code} ${resp.error.message}`)
    }
    return resp.result
  }

  return {
    async setup() {
      runtime = createWorkerRuntimeTs()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      // Seed via the workbook's `bulkApply` (one atom write per
      // batch). Per-cell `setCell` is O(n²) under TS's broad-
      // invalidation Map-clone model (PLAN.md §4.1), so 100k seeds
      // one-by-one would dominate the bench — and the realistic
      // loader path IS bulk anyway (xlsx import, paste, restore).
      // Mirrors WASM's `bulk_import_cells` so both backends get
      // the same shape.
      const state = runtime.state()
      const sheet = state.sheets[0]
      const inputs = workload.seeds.map((seed) => ({
        row: seed.row,
        col: seed.col,
        input: String(seed.value),
      }))
      state.workbook.bulkApply(sheet.id, inputs)
    },
    async bulkWrite() {
      // Formulas also go through `bulkApply` — same fairness
      // reasoning. Models a paste-many-formulas-at-once flow,
      // and again mirrors what the WASM path does in its bulk
      // import. The actual *eval* cost is paid lazily on read.
      const state = runtime.state()
      const sheet = state.sheets[0]
      const inputs = workload.formulas.map((f) => ({
        row: f.row,
        col: f.col,
        input: f.formula,
      }))
      state.workbook.bulkApply(sheet.id, inputs)
    },
    async readBack() {
      // Single bulk readCells call (matches how the UI's
      // projection cursor batches reads — one round-trip per
      // refresh).
      await rpc({
        cmd: 'readCells',
        cells: workload.formulaAddrs.map((addr) => ({ sheet: 0, addr })),
      })
    },
    async recalc() {
      // Mutate A1 — every binop that references row 0 (and every
      // SUM(A1:An) running total) invalidates and re-evaluates on
      // the next read.
      await rpc({
        cmd: 'setCell',
        sheet: 0,
        addr: 'A1',
        value: { type: 'number', value: 999 },
      })
      await rpc({
        cmd: 'readCells',
        cells: workload.formulaAddrs.map((addr) => ({ sheet: 0, addr })),
      })
    },
    dispose() {
      // No-op — runtime is GC'd along with the closure.
    },
  }
}

// ---------------------------------------------------------------------------
// Driver: WASM backend. Calls WasmWorkbook directly. The auto-installing
// `worker-runtime.ts` dispatcher operates on `self` and isn't usable from
// jest, but the dispatcher's hot path is just `setFormulaAt` /
// `set_cell_number` / `snapshotCell` — same methods we invoke here.
// ---------------------------------------------------------------------------
function makeWasmDriver(workload: Workload): BackendDriver {
  let wb: WasmWorkbookLike | undefined

  return {
    async setup() {
      if (!WasmModule) throw new Error('wasm module not loaded')
      wb = new WasmModule.WasmWorkbook()
      // Use the bulk import path on both backends so the seed-phase
      // numbers compare the engines' insert primitives, not the
      // per-cell RPC dispatch loops.
      const imports = workload.seeds.map((seed) => ({
        sheet: 0,
        row: seed.row,
        col: seed.col,
        kind: 'number' as const,
        value: seed.value,
      }))
      wb.bulk_import_cells(imports)
    },
    async bulkWrite() {
      if (!wb) throw new Error('wasm wb not initialized')
      // Mirror the TS driver: bulk-import the formula batch in one
      // call. Rust's bulk_load also installs formulas lazily — they
      // hydrate on the read pass below, same as TS.
      const imports = workload.formulas.map((f) => ({
        sheet: 0,
        row: f.row,
        col: f.col,
        kind: 'formula' as const,
        value: f.formula,
      }))
      wb.bulk_import_cells(imports)
    },
    async readBack() {
      if (!wb) throw new Error('wasm wb not initialized')
      // No bulk readCells on WASM directly — the dispatcher loops over
      // snapshotCell per ref. Mirror that here.
      for (const addr of workload.formulaAddrs) {
        wb.snapshotCell(0, addr)
      }
    },
    async recalc() {
      if (!wb) throw new Error('wasm wb not initialized')
      wb.set_cell_number(0, 'A1', 999)
      for (const addr of workload.formulaAddrs) {
        wb.snapshotCell(0, addr)
      }
    },
    dispose() {
      if (wb) wb.free()
      wb = undefined
    },
  }
}

// ---------------------------------------------------------------------------
// Timing helpers. `time` measures one phase; `runOnce` builds a fresh driver
// and runs setup→bulkWrite→readBack→recalc, recording all four ms numbers.
//
// At the XLarge / Mega / Ultra tiers, every phase is also wrapped with an
// `rssDelta` probe so we can surface peak RSS growth in the report. Without
// it a tier that "completed" in 30s could quietly have pushed Node's heap
// to 6 GB — a finding the timing column hides.
// ---------------------------------------------------------------------------
interface PhaseTimings {
  setup: number
  bulkWrite: number
  readBack: number
  recalc: number
}

interface PhaseMem {
  // RSS in MB at the END of each phase (i.e. peak so far for the tier).
  setup: number
  bulkWrite: number
  readBack: number
  recalc: number
}

async function time(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024)
}

// Best-effort GC hook. Node only exposes `global.gc` when launched with
// `--expose-gc`; under jest the bench process usually doesn't have it, so
// this becomes a no-op. We call it between TS-driver and WASM-driver to
// keep peak-RSS readings from one engine bleeding into the other's column.
function maybeGc(): void {
  const fn = (globalThis as unknown as { gc?: () => void }).gc
  if (typeof fn === 'function') {
    try {
      fn()
    } catch {
      // ignore — gc() can throw if --expose-gc wasn't passed.
    }
  }
}

async function runOnce(
  makeDriver: (workload: Workload) => BackendDriver,
  workload: Workload,
): Promise<{ timings: PhaseTimings; mem: PhaseMem }> {
  const driver = makeDriver(workload)
  try {
    const setup = await time(() => driver.setup())
    const setupRss = rssMb()
    const bulkWrite = await time(() => driver.bulkWrite())
    const bulkWriteRss = rssMb()
    const readBack = await time(() => driver.readBack())
    const readBackRss = rssMb()
    const recalc = await time(() => driver.recalc())
    const recalcRss = rssMb()
    return {
      timings: { setup, bulkWrite, readBack, recalc },
      mem: {
        setup: setupRss,
        bulkWrite: bulkWriteRss,
        readBack: readBackRss,
        recalc: recalcRss,
      },
    }
  } finally {
    driver.dispose()
  }
}

function median(values: number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function medianTimings(runs: PhaseTimings[]): PhaseTimings {
  return {
    setup: median(runs.map((r) => r.setup)),
    bulkWrite: median(runs.map((r) => r.bulkWrite)),
    readBack: median(runs.map((r) => r.readBack)),
    recalc: median(runs.map((r) => r.recalc)),
  }
}

function maxMem(runs: PhaseMem[]): PhaseMem {
  // Peak across repetitions per phase. Median doesn't make sense for
  // memory — we want to know how close we got to the ceiling.
  const pick = (k: keyof PhaseMem) => Math.max(...runs.map((r) => r[k]))
  return {
    setup: pick('setup'),
    bulkWrite: pick('bulkWrite'),
    readBack: pick('readBack'),
    recalc: pick('recalc'),
  }
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1) return ms.toFixed(2)
  if (ms < 100) return ms.toFixed(1)
  return ms.toFixed(0)
}

function fmtRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—'
  return `${ratio.toFixed(2)}×`
}

function verdict(ratio: number): string {
  if (!Number.isFinite(ratio)) return 'n/a'
  if (ratio <= 5) return 'acceptable'
  if (ratio <= 10) return 'concerning'
  return 'blocker'
}

// ---------------------------------------------------------------------------
// Results accumulator. Phases × workloads × backends. Filled during specs;
// dumped to the report markdown in `afterAll`.
//
// `error` carries an OOM / timeout / explicit-throw message so the report
// surfaces the failure shape per backend rather than just printing dashes.
// The bench is designed so a single tier blowing up does NOT halt later
// specs — once `tsTierFailed` (or `wasmTierFailed`) is set we still RUN
// the next tier, but we skip THAT backend within it.
// ---------------------------------------------------------------------------
interface BackendOutcome {
  timings: PhaseTimings | undefined
  mem: PhaseMem | undefined
  error: string | undefined
}
interface BackendResult {
  ts: BackendOutcome
  wasm: BackendOutcome
}
const results = new Map<string, BackendResult>()

// One-way latch per backend: once a tier fails (typically OOM / RangeError
// on V8's heap, or a Rust panic surfaced through wasm-bindgen), every
// LARGER tier silently skips that backend. Smaller tiers already ran;
// larger tiers would just OOM harder. This is the "don't waste hours
// retrying" guard rail from the prompt.
let tsFailedAtOrAbove: number | undefined
let wasmFailedAtOrAbove: number | undefined

// `runs` = how many repetitions per workload (median-aggregated).
// Large+ use 1 run because each pass with 100k+ cells can take tens of
// seconds. Three runs would push the bench wall-clock past a reasonable
// local observation budget without changing the broad trend.
//
// Tier sizing:
//   - Tiny  / Medium / Large are unchanged (validate baseline).
//   - XLarge / Mega / Ultra retain the historical crossover probes. Sizes
//     track the millions-of-cells threshold:
//        XLarge = 0.5 M total cells (250k seeds + 250k formulas)
//        Mega   = 1.0 M total cells (500k + 500k)
//        Ultra  = 2.0 M total cells (1 M + 1 M)
//   - `softCellLimit` is the lower bound at which we WARN if RSS jumps
//     above the value (in MB) declared by the next field. We don't
//     hard-skip on it — Node will OOM-kill itself if it really runs
//     out — but we annotate the report.
const WORKLOAD_SPECS: Array<{
  name: string
  cells: number
  formulas: number
  runs: number
  timeoutMs: number
}> = [
  { name: 'Tiny', cells: 100, formulas: 50, runs: 3, timeoutMs: 10_000 },
  { name: 'Medium', cells: 10_000, formulas: 5_000, runs: 3, timeoutMs: 120_000 },
  { name: 'Large', cells: 100_000, formulas: 50_000, runs: 1, timeoutMs: 600_000 },
  { name: 'XLarge', cells: 250_000, formulas: 250_000, runs: 1, timeoutMs: 900_000 },
  { name: 'Mega', cells: 500_000, formulas: 500_000, runs: 1, timeoutMs: 1_500_000 },
  { name: 'Ultra', cells: 1_000_000, formulas: 1_000_000, runs: 1, timeoutMs: 1_800_000 },
]

// ---------------------------------------------------------------------------
// Specs.
// ---------------------------------------------------------------------------
describePerf('TS vs WASM perf bench (EINFACH_PERF=1)', () => {
  beforeAll(async () => {
    if (!existsSync(WASM_PKG_JS) || !existsSync(WASM_PKG_BIN)) {
      wasmSkipReason = `wasm-pkg missing at ${WASM_PKG_JS}; run \`npm --prefix solid/excel run build:wasm\` first`
      return
    }
    try {
      const mod = (await import(WASM_PKG_JS)) as WasmModule
      const bytes = readFileSync(WASM_PKG_BIN)
      // wasm-pack's newer init accepts `{ module_or_path: BufferSource }`;
      // the bare `init(bytes)` form is deprecated and logs a warning.
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

  for (let idx = 0; idx < WORKLOAD_SPECS.length; idx += 1) {
    const spec = WORKLOAD_SPECS[idx]
    const tierIdx = idx
    it(
      `${spec.name} workload (${spec.cells} cells, ${spec.formulas} formulas)`,
      async () => {
        const workload = buildWorkload(spec.name, spec.cells, spec.formulas)
        const rssAtStart = rssMb()
        // eslint-disable-next-line no-console -- bench progress; only runs under EINFACH_PERF=1
        console.log(
          `[bench] ${spec.name}: ${spec.cells} cells + ${spec.formulas} formulas; RSS=${rssAtStart.toFixed(0)} MB`,
        )

        // ---- TS backend -------------------------------------------------
        let ts: BackendOutcome = { timings: undefined, mem: undefined, error: undefined }
        if (tsFailedAtOrAbove !== undefined && tierIdx >= tsFailedAtOrAbove) {
          ts = {
            timings: undefined,
            mem: undefined,
            error: `skipped (TS engine failed at tier index ${tsFailedAtOrAbove}; larger tiers would OOM too)`,
          }
        } else {
          try {
            const tsRuns: Array<{ timings: PhaseTimings; mem: PhaseMem }> = []
            for (let i = 0; i < spec.runs; i += 1) {
              tsRuns.push(await runOnce(makeTsDriver, workload))
            }
            ts = {
              timings: medianTimings(tsRuns.map((r) => r.timings)),
              mem: maxMem(tsRuns.map((r) => r.mem)),
              error: undefined,
            }
          } catch (err) {
            const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
            ts = {
              timings: undefined,
              mem: undefined,
              error: msg,
            }
            tsFailedAtOrAbove = tierIdx
            // eslint-disable-next-line no-console -- bench progress
            console.error(`[bench] TS failed at ${spec.name}: ${msg}`)
          }
        }
        maybeGc()

        // ---- WASM backend ----------------------------------------------
        let wasm: BackendOutcome = { timings: undefined, mem: undefined, error: undefined }
        if (!wasmAvailable) {
          wasm = { timings: undefined, mem: undefined, error: `wasm unavailable: ${wasmSkipReason}` }
        } else if (wasmFailedAtOrAbove !== undefined && tierIdx >= wasmFailedAtOrAbove) {
          wasm = {
            timings: undefined,
            mem: undefined,
            error: `skipped (WASM engine failed at tier index ${wasmFailedAtOrAbove}; larger tiers would OOM too)`,
          }
        } else {
          try {
            const wasmRuns: Array<{ timings: PhaseTimings; mem: PhaseMem }> = []
            for (let i = 0; i < spec.runs; i += 1) {
              wasmRuns.push(await runOnce(makeWasmDriver, workload))
            }
            wasm = {
              timings: medianTimings(wasmRuns.map((r) => r.timings)),
              mem: maxMem(wasmRuns.map((r) => r.mem)),
              error: undefined,
            }
          } catch (err) {
            const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
            wasm = {
              timings: undefined,
              mem: undefined,
              error: msg,
            }
            wasmFailedAtOrAbove = tierIdx
            // eslint-disable-next-line no-console -- bench progress
            console.error(`[bench] WASM failed at ${spec.name}: ${msg}`)
          }
        }
        maybeGc()

        results.set(spec.name, { ts, wasm })
        logPerfOutcome(spec.name, 'TS', ts)
        logPerfOutcome(spec.name, 'WASM', wasm)

        // Persist partial results after each tier — if a later tier OOMs
        // hard enough that `afterAll` never runs, the markdown still
        // reflects what we did manage to measure.
        writeReport()
      },
      spec.timeoutMs,
    )
  }
})

// ===========================================================================
// CHAIN DEPENDENCY WORKLOAD
//
// Orthogonal to the size tiers above. Builds a single pure chain
// (`A1=1`, `A2=A1+1`, …, `An=A(n-1)+1`) and measures the four phases below.
// This is the deepest propagation shape in the suite. It compares how both
// backends install, hydrate, and settle the same dependency chain.
//
// Phases (mirrors existing bench shape but with chain-specific intent):
//
//   - setup: create the workbook (no cells yet)
//   - bulkWrite: install all `n` formulas in one bulk_apply / bulk_import
//   - firstRecalc: read `An`. Forces full chain evaluation top→bottom.
//                  evalCount delta should be ~n on both backends.
//   - mutateThenRecalc: set `A1=2`, read `An`. The Rust path settles mounted
//                  formula-inner atoms through Store propagation during the
//                  write; the following read observes the settled tail.
//                  Repeated 5×, median taken.
//   - steadyState: read `An` again with no mutation. Expected to be a
//                  cache hit (evalCount delta ≈ 0) — confirms the engine
//                  isn't re-evaluating on every read.
//
// Per-phase diagnostics: ms (perf.now delta), evalCount delta
// (debugFormulaEvalCount probe), RSS at phase exit. Read `An` only — no
// readBack-style fan-out, so the eval/timing numbers reflect chain walk
// cost alone.
// ===========================================================================

interface ChainSpec {
  name: string
  depth: number
  runs: number // how many mutate+read iterations to take median over
  timeoutMs: number
}

const CHAIN_SPECS: ChainSpec[] = [
  { name: 'Chain100', depth: 100, runs: 5, timeoutMs: 30_000 },
  { name: 'Chain1k', depth: 1_000, runs: 5, timeoutMs: 60_000 },
  { name: 'Chain10k', depth: 10_000, runs: 5, timeoutMs: 300_000 },
  { name: 'Chain100k', depth: 100_000, runs: 5, timeoutMs: 1_800_000 },
]

interface ChainPhaseTimings {
  setup: number
  bulkWrite: number
  firstRecalc: number
  // Median across `runs` iterations.
  mutateThenRecalc: number
  steadyState: number
}

interface ChainPhaseEvalDelta {
  setup: number
  bulkWrite: number
  firstRecalc: number
  // Median across `runs` iterations.
  mutateThenRecalc: number
  steadyState: number
}

interface ChainPhaseMem {
  setup: number
  bulkWrite: number
  firstRecalc: number
  mutateThenRecalc: number
  steadyState: number
}

interface ChainBackendOutcome {
  timings: ChainPhaseTimings | undefined
  evals: ChainPhaseEvalDelta | undefined
  mem: ChainPhaseMem | undefined
  error: string | undefined
}

interface ChainResult {
  ts: ChainBackendOutcome
  wasm: ChainBackendOutcome
}

const chainResults = new Map<string, ChainResult>()

// One-way latches mirror the size-tier bench: once a chain depth blows up
// a backend, every deeper tier silently skips that backend.
let tsChainFailedAtOrAbove: number | undefined
let wasmChainFailedAtOrAbove: number | undefined

// Build the `n` formula inputs (`A1=1`, `A2=A1+1`, …). Returns also the
// final-cell address for the read pass.
function buildChain(depth: number): {
  seedInput: string
  formulas: Array<{ row: number; col: number; input: string }>
  lastAddr: string
} {
  // Row 0 is A1 = 1 (number literal — feeds the chain).
  // Rows 1..depth-1 are formulas. The first formula at row 1 is `=A1+1`.
  const formulas: Array<{ row: number; col: number; input: string }> = []
  for (let row = 1; row < depth; row += 1) {
    formulas.push({
      row,
      col: 0,
      input: `=${a1(row - 1, 0)}+1`,
    })
  }
  return {
    seedInput: '1',
    formulas,
    lastAddr: a1(depth - 1, 0),
  }
}

interface ChainDriver {
  setup(): Promise<void>
  bulkWrite(): Promise<void>
  readLast(): Promise<void>
  mutateA1(value: number): Promise<void>
  evalCount(): number
  dispose(): void
}

function makeTsChainDriver(chain: ReturnType<typeof buildChain>): ChainDriver {
  let runtime: ExcelCoreTsWorkerRuntime
  let rpcId = 0
  const rpc = async (msg: Record<string, unknown>) => {
    rpcId += 1
    const resp = await runtime.handle({ id: rpcId, ...msg })
    if (!resp.ok) {
      throw new Error(`ts rpc ${String(msg.cmd)} failed: ${resp.error.code} ${resp.error.message}`)
    }
    return resp.result
  }

  return {
    async setup() {
      runtime = createWorkerRuntimeTs()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      // Seed A1=1 as a literal so the chain has a base value.
      const state = runtime.state()
      const sheet = state.sheets[0]
      state.workbook.bulkApply(sheet.id, [{ row: 0, col: 0, input: chain.seedInput }])
    },
    async bulkWrite() {
      const state = runtime.state()
      const sheet = state.sheets[0]
      state.workbook.bulkApply(sheet.id, chain.formulas)
    },
    async readLast() {
      await rpc({
        cmd: 'readCells',
        cells: [{ sheet: 0, addr: chain.lastAddr }],
      })
    },
    async mutateA1(value: number) {
      await rpc({
        cmd: 'setCell',
        sheet: 0,
        addr: 'A1',
        value: { type: 'number', value },
      })
    },
    evalCount() {
      // sheet idx 0; debugFormulaEvalCount is a direct workbook accessor.
      return runtime.state().workbook.debugFormulaEvalCount(0)
    },
    dispose() {
      // No-op — runtime is GC'd along with the closure.
    },
  }
}

function makeWasmChainDriver(chain: ReturnType<typeof buildChain>): ChainDriver {
  let wb: WasmWorkbookLike | undefined

  return {
    async setup() {
      if (!WasmModule) throw new Error('wasm module not loaded')
      wb = new WasmModule.WasmWorkbook()
      // Seed A1=1 via the bulk import so the path matches TS.
      wb.bulk_import_cells([
        { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
      ])
    },
    async bulkWrite() {
      if (!wb) throw new Error('wasm wb not initialized')
      const imports = chain.formulas.map((f) => ({
        sheet: 0,
        row: f.row,
        col: f.col,
        kind: 'formula' as const,
        value: f.input,
      }))
      wb.bulk_import_cells(imports)
    },
    async readLast() {
      if (!wb) throw new Error('wasm wb not initialized')
      wb.snapshotCell(0, chain.lastAddr)
    },
    async mutateA1(value: number) {
      if (!wb) throw new Error('wasm wb not initialized')
      wb.set_cell_number(0, 'A1', value)
    },
    evalCount() {
      if (!wb) return 0
      return wb.debug_formula_eval_count(0)
    },
    dispose() {
      if (wb) wb.free()
      wb = undefined
    },
  }
}

// Run a single chain workload through a backend, recording ms, eval-count
// delta, and RSS per phase. `runs` controls how many mutate+read iterations
// we take the median over for the `mutateThenRecalc` phase.
async function runChainOnce(
  makeDriver: (chain: ReturnType<typeof buildChain>) => ChainDriver,
  chain: ReturnType<typeof buildChain>,
  runs: number,
): Promise<{
  timings: ChainPhaseTimings
  evals: ChainPhaseEvalDelta
  mem: ChainPhaseMem
}> {
  const driver = makeDriver(chain)
  try {
    // ---- setup --------------------------------------------------------
    let evalBefore = 0 // pre-construction; no driver yet
    const setupMs = await time(() => driver.setup())
    const setupEval = driver.evalCount() - evalBefore
    const setupRss = rssMb()

    // ---- bulkWrite ----------------------------------------------------
    evalBefore = driver.evalCount()
    const bulkWriteMs = await time(() => driver.bulkWrite())
    const bulkWriteEval = driver.evalCount() - evalBefore
    const bulkWriteRss = rssMb()

    // ---- firstRecalc --------------------------------------------------
    evalBefore = driver.evalCount()
    const firstRecalcMs = await time(() => driver.readLast())
    const firstRecalcEval = driver.evalCount() - evalBefore
    const firstRecalcRss = rssMb()

    // ---- mutateThenRecalc (median over `runs`) ------------------------
    const mutMs: number[] = []
    const mutEval: number[] = []
    let mutRssMax = 0
    for (let i = 0; i < runs; i += 1) {
      // Each iteration: change A1 to a new value so the engine can't
      // short-circuit on "value unchanged". Use `i+2` so first mutation
      // moves off the seed value of 1.
      const newValue = i + 2
      evalBefore = driver.evalCount()
      const ms = await time(async () => {
        await driver.mutateA1(newValue)
        await driver.readLast()
      })
      const delta = driver.evalCount() - evalBefore
      mutMs.push(ms)
      mutEval.push(delta)
      const r = rssMb()
      if (r > mutRssMax) mutRssMax = r
    }
    const mutateThenRecalcMs = median(mutMs)
    const mutateThenRecalcEval = Math.round(median(mutEval))

    // ---- steadyState --------------------------------------------------
    // No mutation; just re-read `An`. Expected to be cache-hit on both
    // engines (evalCount delta ≈ 0).
    evalBefore = driver.evalCount()
    const steadyMs = await time(() => driver.readLast())
    const steadyEval = driver.evalCount() - evalBefore
    const steadyRss = rssMb()

    return {
      timings: {
        setup: setupMs,
        bulkWrite: bulkWriteMs,
        firstRecalc: firstRecalcMs,
        mutateThenRecalc: mutateThenRecalcMs,
        steadyState: steadyMs,
      },
      evals: {
        setup: setupEval,
        bulkWrite: bulkWriteEval,
        firstRecalc: firstRecalcEval,
        mutateThenRecalc: mutateThenRecalcEval,
        steadyState: steadyEval,
      },
      mem: {
        setup: setupRss,
        bulkWrite: bulkWriteRss,
        firstRecalc: firstRecalcRss,
        mutateThenRecalc: mutRssMax,
        steadyState: steadyRss,
      },
    }
  } finally {
    driver.dispose()
  }
}

describePerf('Chain dependency workload (EINFACH_PERF=1)', () => {
  // Re-run the wasm-module bootstrap here so this suite works when run in
  // isolation (e.g. `-t "Chain dependency"`). Idempotent: if the size-tier
  // suite already loaded the module, this block skips the init.
  beforeAll(async () => {
    if (WasmModule || !PERF_ENABLED) return
    if (!existsSync(WASM_PKG_JS) || !existsSync(WASM_PKG_BIN)) {
      wasmSkipReason = `wasm-pkg missing at ${WASM_PKG_JS}; run \`npm --prefix solid/excel run build:wasm\` first`
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

  for (let idx = 0; idx < CHAIN_SPECS.length; idx += 1) {
    const spec = CHAIN_SPECS[idx]
    const tierIdx = idx
    it(
      `${spec.name} (${spec.depth}-deep chain)`,
      async () => {
        const chain = buildChain(spec.depth)
        const rssAtStart = rssMb()
        // eslint-disable-next-line no-console -- bench progress; only runs under EINFACH_PERF=1
        console.log(
          `[bench] ${spec.name}: depth=${spec.depth}; RSS=${rssAtStart.toFixed(0)} MB`,
        )

        // ---- TS backend -------------------------------------------------
        let ts: ChainBackendOutcome = {
          timings: undefined,
          evals: undefined,
          mem: undefined,
          error: undefined,
        }
        if (tsChainFailedAtOrAbove !== undefined && tierIdx >= tsChainFailedAtOrAbove) {
          ts = {
            timings: undefined,
            evals: undefined,
            mem: undefined,
            error: `skipped (TS chain failed at tier index ${tsChainFailedAtOrAbove})`,
          }
        } else {
          try {
            const r = await runChainOnce(makeTsChainDriver, chain, spec.runs)
            ts = { timings: r.timings, evals: r.evals, mem: r.mem, error: undefined }
          } catch (err) {
            const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
            ts = { timings: undefined, evals: undefined, mem: undefined, error: msg }
            tsChainFailedAtOrAbove = tierIdx
            // eslint-disable-next-line no-console -- bench progress
            console.error(`[bench] TS chain failed at ${spec.name}: ${msg}`)
          }
        }
        maybeGc()

        // ---- WASM backend ----------------------------------------------
        let wasm: ChainBackendOutcome = {
          timings: undefined,
          evals: undefined,
          mem: undefined,
          error: undefined,
        }
        if (!wasmAvailable) {
          wasm = {
            timings: undefined,
            evals: undefined,
            mem: undefined,
            error: `wasm unavailable: ${wasmSkipReason}`,
          }
        } else if (
          wasmChainFailedAtOrAbove !== undefined &&
          tierIdx >= wasmChainFailedAtOrAbove
        ) {
          wasm = {
            timings: undefined,
            evals: undefined,
            mem: undefined,
            error: `skipped (WASM chain failed at tier index ${wasmChainFailedAtOrAbove})`,
          }
        } else {
          try {
            const r = await runChainOnce(makeWasmChainDriver, chain, spec.runs)
            wasm = { timings: r.timings, evals: r.evals, mem: r.mem, error: undefined }
          } catch (err) {
            const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
            wasm = { timings: undefined, evals: undefined, mem: undefined, error: msg }
            wasmChainFailedAtOrAbove = tierIdx
            // eslint-disable-next-line no-console -- bench progress
            console.error(`[bench] WASM chain failed at ${spec.name}: ${msg}`)
          }
        }
        maybeGc()

        chainResults.set(spec.name, { ts, wasm })
        logPerfOutcome(spec.name, 'TS', ts)
        logPerfOutcome(spec.name, 'WASM', wasm)

        // Persist partial chain results after each tier in case a deeper
        // tier OOMs hard enough to skip `afterAll`.
        writeReport()
      },
      spec.timeoutMs,
    )
  }
})

// ===========================================================================
// RANGE-HEAVY WORKLOADS
//
// Orthogonal to the size tiers above and to the chain workload. These tiers
// exercise formula-inner dependency derivation for point and range references
// in three patterns that real spreadsheets see:
//
//   - FanOut: one source cell drives many dependents (`B1..Bn = =A1*k`).
//     Pure point-cell deps, no range deps. Validates Store reverse propagation.
//   - FanIn: one wide range feeds a small number of aggregators
//     (`B1 = =SUM(A1:An)`, B2 = AVERAGE, B3 = COUNTIF). Mutating one A cell
//     re-derives all mounted aggregators through range geometry roots.
//   - Stripe: every row has a SUM over a 10-cell window overlapping the
//     previous row's window. The result is a sheet with hundreds /
//     thousands of overlapping ranges; mutating one A cell can touch up
//     to 10 SUMs. This stresses overlapping range-derived dependencies.
//
// Phases (shared by all three patterns):
//   - setup: create the workbook + seed the A column with literals.
//   - bulkWrite: install all dependent formulas in one bulk import.
//   - firstRecalc: read every dependent cell once. Forces evaluation.
//   - mutateThenRecalc: change one A cell, re-read every dependent.
//     Median over `runs`.
//
// Per-phase diagnostics: ms (perf.now delta), evalCount delta, RSS at
// phase exit.
// ===========================================================================

type RangeWorkloadKind = 'fanOut' | 'fanIn' | 'stripe'

interface RangeSpec {
  kind: RangeWorkloadKind
  name: string
  /// FanOut: dependent count. FanIn: A-column size. Stripe: row count.
  size: number
  runs: number
  timeoutMs: number
}

const RANGE_SPECS: RangeSpec[] = [
  // FanOut tiers: 1 source, N point-cell dependents.
  { kind: 'fanOut', name: 'FanOut1k', size: 1_000, runs: 3, timeoutMs: 60_000 },
  { kind: 'fanOut', name: 'FanOut10k', size: 10_000, runs: 3, timeoutMs: 300_000 },
  { kind: 'fanOut', name: 'FanOut100k', size: 100_000, runs: 1, timeoutMs: 900_000 },
  // FanIn tiers: 1 wide range, 3 aggregators.
  { kind: 'fanIn', name: 'FanIn1k', size: 1_000, runs: 3, timeoutMs: 60_000 },
  { kind: 'fanIn', name: 'FanIn10k', size: 10_000, runs: 3, timeoutMs: 300_000 },
  { kind: 'fanIn', name: 'FanIn100k', size: 100_000, runs: 1, timeoutMs: 900_000 },
  // Stripe tiers: N overlapping SUMs over a window of 10.
  { kind: 'stripe', name: 'Stripe1k', size: 1_000, runs: 3, timeoutMs: 60_000 },
  { kind: 'stripe', name: 'Stripe10k', size: 10_000, runs: 3, timeoutMs: 300_000 },
  { kind: 'stripe', name: 'Stripe100k', size: 100_000, runs: 1, timeoutMs: 900_000 },
]

const STRIPE_WINDOW = 10

interface RangeWorkload {
  kind: RangeWorkloadKind
  name: string
  size: number
  /// Initial seed cells (A column).
  seeds: SeedCell[]
  /// Formulas to install in bulkWrite.
  formulas: FormulaCell[]
  /// Addresses read during firstRecalc / mutateThenRecalc.
  readAddrs: string[]
  /// Address mutated in mutateThenRecalc.
  mutateAddr: string
}

function buildRangeWorkload(spec: RangeSpec): RangeWorkload {
  const seeds: SeedCell[] = []
  const formulas: FormulaCell[] = []
  const readAddrs: string[] = []
  // A small deterministic seed pool that's still reproducible across runs.
  const rng = makeRng(0xfa11ce + spec.size)

  if (spec.kind === 'fanOut') {
    // A1 = 1, then B1..BN = =A1*k. Mutating A1 settles all N mounted
    // formula-inner dependents through Store propagation.
    seeds.push({ row: 0, col: 0, value: 1 })
    for (let i = 0; i < spec.size; i += 1) {
      formulas.push({ row: i, col: 1, formula: `=${a1(0, 0)}*${i + 1}` })
      readAddrs.push(a1(i, 1))
    }
    return {
      kind: spec.kind,
      name: spec.name,
      size: spec.size,
      seeds,
      formulas,
      readAddrs,
      mutateAddr: a1(0, 0),
    }
  }

  if (spec.kind === 'fanIn') {
    // A1..AN literals, B1 = SUM(A1:AN), B2 = AVERAGE(A1:AN),
    // B3 = COUNTIF(A1:AN,">50"). Mutating one A cell pulls all three
    // aggregators dirty.
    for (let row = 0; row < spec.size; row += 1) {
      seeds.push({ row, col: 0, value: Math.floor(rng() * 100) })
    }
    const last = a1(spec.size - 1, 0)
    formulas.push({ row: 0, col: 1, formula: `=SUM(${a1(0, 0)}:${last})` })
    formulas.push({ row: 1, col: 1, formula: `=AVERAGE(${a1(0, 0)}:${last})` })
    formulas.push({ row: 2, col: 1, formula: `=COUNTIF(${a1(0, 0)}:${last},">50")` })
    readAddrs.push(a1(0, 1), a1(1, 1), a1(2, 1))
    return {
      kind: spec.kind,
      name: spec.name,
      size: spec.size,
      seeds,
      formulas,
      readAddrs,
      // Mutate a mid-column cell so the bucket lookup walks deeper
      // into the index than picking row 0 would.
      mutateAddr: a1(Math.floor(spec.size / 2), 0),
    }
  }

  // Stripe: A1..AN seeded, B_i = SUM(A_i:A_{i+window-1}). Each A cell
  // sits in up to `STRIPE_WINDOW` overlapping ranges; mutating any one
  // A cell re-derives up to that many mounted SUM formula-inner atoms.
  for (let row = 0; row < spec.size; row += 1) {
    seeds.push({ row, col: 0, value: Math.floor(rng() * 100) })
  }
  for (let i = 0; i < spec.size; i += 1) {
    const lo = i
    const hi = Math.min(spec.size - 1, i + STRIPE_WINDOW - 1)
    formulas.push({
      row: i,
      col: 1,
      formula: `=SUM(${a1(lo, 0)}:${a1(hi, 0)})`,
    })
    readAddrs.push(a1(i, 1))
  }
  return {
    kind: spec.kind,
    name: spec.name,
    size: spec.size,
    seeds,
    formulas,
    readAddrs,
    // Mutate a mid-column cell: this address sits inside ~STRIPE_WINDOW
    // ranges, so Store propagation exercises the most overlapping range
    // dependencies at that row.
    mutateAddr: a1(Math.floor(spec.size / 2), 0),
  }
}

interface RangePhaseTimings {
  setup: number
  bulkWrite: number
  firstRecalc: number
  mutateThenRecalc: number
}

interface RangePhaseEvalDelta {
  setup: number
  bulkWrite: number
  firstRecalc: number
  mutateThenRecalc: number
}

interface RangePhaseMem {
  setup: number
  bulkWrite: number
  firstRecalc: number
  mutateThenRecalc: number
}

interface RangeBackendOutcome {
  timings: RangePhaseTimings | undefined
  evals: RangePhaseEvalDelta | undefined
  mem: RangePhaseMem | undefined
  error: string | undefined
}

interface RangeResult {
  ts: RangeBackendOutcome
  wasm: RangeBackendOutcome
}

const rangeResults = new Map<string, RangeResult>()

let tsRangeFailedAtOrAbove: number | undefined
let wasmRangeFailedAtOrAbove: number | undefined

interface RangeDriver {
  setup(): Promise<void>
  bulkWrite(): Promise<void>
  readAll(): Promise<void>
  mutateOne(value: number): Promise<void>
  evalCount(): number
  dispose(): void
}

function makeTsRangeDriver(workload: RangeWorkload): RangeDriver {
  let runtime: ExcelCoreTsWorkerRuntime
  let rpcId = 0
  const rpc = async (msg: Record<string, unknown>) => {
    rpcId += 1
    const resp = await runtime.handle({ id: rpcId, ...msg })
    if (!resp.ok) {
      throw new Error(`ts rpc ${String(msg.cmd)} failed: ${resp.error.code} ${resp.error.message}`)
    }
    return resp.result
  }

  return {
    async setup() {
      runtime = createWorkerRuntimeTs()
      await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
      const state = runtime.state()
      const sheet = state.sheets[0]
      const inputs = workload.seeds.map((seed) => ({
        row: seed.row,
        col: seed.col,
        input: String(seed.value),
      }))
      state.workbook.bulkApply(sheet.id, inputs)
    },
    async bulkWrite() {
      const state = runtime.state()
      const sheet = state.sheets[0]
      const inputs = workload.formulas.map((f) => ({
        row: f.row,
        col: f.col,
        input: f.formula,
      }))
      state.workbook.bulkApply(sheet.id, inputs)
    },
    async readAll() {
      await rpc({
        cmd: 'readCells',
        cells: workload.readAddrs.map((addr) => ({ sheet: 0, addr })),
      })
    },
    async mutateOne(value: number) {
      await rpc({
        cmd: 'setCell',
        sheet: 0,
        addr: workload.mutateAddr,
        value: { type: 'number', value },
      })
    },
    evalCount() {
      return runtime.state().workbook.debugFormulaEvalCount(0)
    },
    dispose() {
      // No-op — runtime is GC'd along with the closure.
    },
  }
}

function makeWasmRangeDriver(workload: RangeWorkload): RangeDriver {
  let wb: WasmWorkbookLike | undefined

  return {
    async setup() {
      if (!WasmModule) throw new Error('wasm module not loaded')
      wb = new WasmModule.WasmWorkbook()
      const imports = workload.seeds.map((seed) => ({
        sheet: 0,
        row: seed.row,
        col: seed.col,
        kind: 'number' as const,
        value: seed.value,
      }))
      wb.bulk_import_cells(imports)
    },
    async bulkWrite() {
      if (!wb) throw new Error('wasm wb not initialized')
      const imports = workload.formulas.map((f) => ({
        sheet: 0,
        row: f.row,
        col: f.col,
        kind: 'formula' as const,
        value: f.formula,
      }))
      wb.bulk_import_cells(imports)
    },
    async readAll() {
      if (!wb) throw new Error('wasm wb not initialized')
      for (const addr of workload.readAddrs) {
        wb.snapshotCell(0, addr)
      }
    },
    async mutateOne(value: number) {
      if (!wb) throw new Error('wasm wb not initialized')
      wb.set_cell_number(0, workload.mutateAddr, value)
    },
    evalCount() {
      if (!wb) return 0
      return wb.debug_formula_eval_count(0)
    },
    dispose() {
      if (wb) wb.free()
      wb = undefined
    },
  }
}

async function runRangeOnce(
  makeDriver: (workload: RangeWorkload) => RangeDriver,
  workload: RangeWorkload,
  runs: number,
): Promise<{
  timings: RangePhaseTimings
  evals: RangePhaseEvalDelta
  mem: RangePhaseMem
}> {
  const driver = makeDriver(workload)
  try {
    // ---- setup -------------------------------------------------------
    let evalBefore = 0
    const setupMs = await time(() => driver.setup())
    const setupEval = driver.evalCount() - evalBefore
    const setupRss = rssMb()

    // ---- bulkWrite ---------------------------------------------------
    evalBefore = driver.evalCount()
    const bulkWriteMs = await time(() => driver.bulkWrite())
    const bulkWriteEval = driver.evalCount() - evalBefore
    const bulkWriteRss = rssMb()

    // ---- firstRecalc -------------------------------------------------
    evalBefore = driver.evalCount()
    const firstRecalcMs = await time(() => driver.readAll())
    const firstRecalcEval = driver.evalCount() - evalBefore
    const firstRecalcRss = rssMb()

    // ---- mutateThenRecalc (median over `runs`) ----------------------
    const mutMs: number[] = []
    const mutEval: number[] = []
    let mutRssMax = 0
    for (let i = 0; i < runs; i += 1) {
      const newValue = i + 2
      evalBefore = driver.evalCount()
      const ms = await time(async () => {
        await driver.mutateOne(newValue)
        await driver.readAll()
      })
      const delta = driver.evalCount() - evalBefore
      mutMs.push(ms)
      mutEval.push(delta)
      const r = rssMb()
      if (r > mutRssMax) mutRssMax = r
    }
    const mutateThenRecalcMs = median(mutMs)
    const mutateThenRecalcEval = Math.round(median(mutEval))

    return {
      timings: {
        setup: setupMs,
        bulkWrite: bulkWriteMs,
        firstRecalc: firstRecalcMs,
        mutateThenRecalc: mutateThenRecalcMs,
      },
      evals: {
        setup: setupEval,
        bulkWrite: bulkWriteEval,
        firstRecalc: firstRecalcEval,
        mutateThenRecalc: mutateThenRecalcEval,
      },
      mem: {
        setup: setupRss,
        bulkWrite: bulkWriteRss,
        firstRecalc: firstRecalcRss,
        mutateThenRecalc: mutRssMax,
      },
    }
  } finally {
    driver.dispose()
  }
}

describePerf('Range-heavy workloads (EINFACH_PERF=1)', () => {
  // Same lazy WASM bootstrap as the chain suite — keeps the range bench
  // runnable in isolation via `-t "FanOut|FanIn|Stripe"`.
  beforeAll(async () => {
    if (WasmModule || !PERF_ENABLED) return
    if (!existsSync(WASM_PKG_JS) || !existsSync(WASM_PKG_BIN)) {
      wasmSkipReason = `wasm-pkg missing at ${WASM_PKG_JS}; run \`npm --prefix solid/excel run build:wasm\` first`
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

  for (let idx = 0; idx < RANGE_SPECS.length; idx += 1) {
    const spec = RANGE_SPECS[idx]
    const tierIdx = idx
    it(
      `${spec.name} (${spec.kind} size=${spec.size})`,
      async () => {
        const workload = buildRangeWorkload(spec)
        const rssAtStart = rssMb()
        // eslint-disable-next-line no-console -- bench progress
        console.log(
          `[bench] ${spec.name}: kind=${spec.kind} size=${spec.size}; RSS=${rssAtStart.toFixed(0)} MB`,
        )

        // ---- TS backend ------------------------------------------------
        let ts: RangeBackendOutcome = {
          timings: undefined,
          evals: undefined,
          mem: undefined,
          error: undefined,
        }
        if (tsRangeFailedAtOrAbove !== undefined && tierIdx >= tsRangeFailedAtOrAbove) {
          ts = {
            timings: undefined,
            evals: undefined,
            mem: undefined,
            error: `skipped (TS range failed at tier index ${tsRangeFailedAtOrAbove})`,
          }
        } else {
          try {
            const r = await runRangeOnce(makeTsRangeDriver, workload, spec.runs)
            ts = { timings: r.timings, evals: r.evals, mem: r.mem, error: undefined }
          } catch (err) {
            const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
            ts = { timings: undefined, evals: undefined, mem: undefined, error: msg }
            tsRangeFailedAtOrAbove = tierIdx
            // eslint-disable-next-line no-console -- bench progress
            console.error(`[bench] TS range failed at ${spec.name}: ${msg}`)
          }
        }
        maybeGc()

        // ---- WASM backend ---------------------------------------------
        let wasm: RangeBackendOutcome = {
          timings: undefined,
          evals: undefined,
          mem: undefined,
          error: undefined,
        }
        if (!wasmAvailable) {
          wasm = {
            timings: undefined,
            evals: undefined,
            mem: undefined,
            error: `wasm unavailable: ${wasmSkipReason}`,
          }
        } else if (
          wasmRangeFailedAtOrAbove !== undefined &&
          tierIdx >= wasmRangeFailedAtOrAbove
        ) {
          wasm = {
            timings: undefined,
            evals: undefined,
            mem: undefined,
            error: `skipped (WASM range failed at tier index ${wasmRangeFailedAtOrAbove})`,
          }
        } else {
          try {
            const r = await runRangeOnce(makeWasmRangeDriver, workload, spec.runs)
            wasm = { timings: r.timings, evals: r.evals, mem: r.mem, error: undefined }
          } catch (err) {
            const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
            wasm = { timings: undefined, evals: undefined, mem: undefined, error: msg }
            wasmRangeFailedAtOrAbove = tierIdx
            // eslint-disable-next-line no-console -- bench progress
            console.error(`[bench] WASM range failed at ${spec.name}: ${msg}`)
          }
        }
        maybeGc()

        rangeResults.set(spec.name, { ts, wasm })
        logPerfOutcome(spec.name, 'TS', ts)
        logPerfOutcome(spec.name, 'WASM', wasm)

        // Persist partial range results after each tier.
        writeReport()
      },
      spec.timeoutMs,
    )
  }
})

function rangeCell(outcome: RangeBackendOutcome, phase: keyof RangePhaseTimings): string {
  if (outcome.timings) return fmtMs(outcome.timings[phase])
  if (outcome.error) {
    const short = outcome.error.length > 40 ? `${outcome.error.slice(0, 37)}…` : outcome.error
    return `*${short}*`
  }
  return '(not run)'
}

function rangeRatioCell(
  ts: RangeBackendOutcome,
  wasm: RangeBackendOutcome,
  phase: keyof RangePhaseTimings,
): string {
  if (!ts.timings || !wasm.timings) return '—'
  return fmtRatio(ts.timings[phase] / wasm.timings[phase])
}

function rangeVerdictCell(
  ts: RangeBackendOutcome,
  wasm: RangeBackendOutcome,
  phase: keyof RangePhaseTimings,
): string {
  if (!ts.timings || !wasm.timings) {
    if (ts.error && !wasm.error) return 'TS failed; WASM wins by default'
    if (wasm.error && !ts.error) return 'WASM failed; TS wins by default'
    if (ts.error && wasm.error) return 'both failed'
    return 'n/a'
  }
  const r = ts.timings[phase] / wasm.timings[phase]
  if (!Number.isFinite(r)) return 'n/a'
  if (r > 1.5) return 'WASM wins'
  if (r > 1.0) return 'WASM edges'
  if (r > 0.66) return 'roughly tied'
  return 'TS wins'
}

function rangeEvalCell(
  outcome: RangeBackendOutcome,
  phase: keyof RangePhaseEvalDelta,
): string {
  if (!outcome.evals) return outcome.error ? '*failed*' : '—'
  return outcome.evals[phase].toLocaleString()
}

function rangeMemCell(outcome: RangeBackendOutcome, phase: keyof RangePhaseMem): string {
  if (!outcome.mem) return outcome.error ? '*failed*' : '—'
  return `${outcome.mem[phase].toFixed(0)} MB`
}

function rangeSection(): string[] {
  const phases: Array<keyof RangePhaseTimings> = [
    'setup',
    'bulkWrite',
    'firstRecalc',
    'mutateThenRecalc',
  ]
  const out: string[] = []
  out.push('## Range-heavy workloads')
  out.push('')
  out.push('Three patterns exercising Store-derived formula dependencies:')
  out.push('')
  out.push('- **FanOut**: `A1` → `B1..BN = A1 * k`. Mutating `A1` invalidates')
  out.push('  N mounted point-cell dependents through Store propagation.')
  out.push('- **FanIn**: `A1..AN` literals → `B1 = SUM(A1:AN)`, `B2 = AVERAGE(…)`,')
  out.push('  `B3 = COUNTIF(…)`. Mutating one A cell pulls all aggregators dirty.')
  out.push('  Stresses range geometry roots feeding mounted formula-inner atoms.')
  out.push('- **Stripe**: `B_i = SUM(A_i : A_{i+9})` for i in 1..N — overlapping')
  out.push('  10-cell windows. Mutating one A cell can settle up to 10 mounted SUMs.')
  out.push('')
  out.push('Phases match the chain suite: setup → bulkWrite → firstRecalc →')
  out.push('mutateThenRecalc (median of `runs`).')
  out.push('')
  out.push('### ms per phase')
  out.push('')
  out.push('| Tier | Phase | TS (ms) | WASM (ms) | Ratio (ts/wasm) | Verdict |')
  out.push('| --- | --- | --- | --- | --- | --- |')
  for (const spec of RANGE_SPECS) {
    const row = rangeResults.get(spec.name)
    if (!row) {
      out.push(`| ${spec.name} | — | (not run) | (not run) | — | — |`)
      continue
    }
    for (const phase of phases) {
      out.push(
        `| ${spec.name} | ${phase} | ${rangeCell(row.ts, phase)} | ${rangeCell(row.wasm, phase)} | ${rangeRatioCell(row.ts, row.wasm, phase)} | ${rangeVerdictCell(row.ts, row.wasm, phase)} |`,
      )
    }
  }

  // ---- eval delta -----------------------------------------------------
  out.push('')
  out.push('### evalCount delta per phase')
  out.push('')
  out.push('| Tier | Phase | TS evals | WASM evals |')
  out.push('| --- | --- | --- | --- |')
  for (const spec of RANGE_SPECS) {
    const row = rangeResults.get(spec.name)
    if (!row) continue
    const evalPhases: Array<keyof RangePhaseEvalDelta> = [
      'setup',
      'bulkWrite',
      'firstRecalc',
      'mutateThenRecalc',
    ]
    for (const phase of evalPhases) {
      out.push(
        `| ${spec.name} | ${phase} | ${rangeEvalCell(row.ts, phase)} | ${rangeEvalCell(row.wasm, phase)} |`,
      )
    }
  }

  // ---- RSS ------------------------------------------------------------
  const anyMem = Array.from(rangeResults.values()).some((r) => r.ts.mem || r.wasm.mem)
  if (anyMem) {
    out.push('')
    out.push('### Peak RSS by phase (MB)')
    out.push('')
    out.push('| Tier | Phase | TS RSS | WASM RSS |')
    out.push('| --- | --- | --- | --- |')
    for (const spec of RANGE_SPECS) {
      const row = rangeResults.get(spec.name)
      if (!row) continue
      const memPhases: Array<keyof RangePhaseMem> = [
        'setup',
        'bulkWrite',
        'firstRecalc',
        'mutateThenRecalc',
      ]
      for (const phase of memPhases) {
        out.push(
          `| ${spec.name} | ${phase} | ${rangeMemCell(row.ts, phase)} | ${rangeMemCell(row.wasm, phase)} |`,
        )
      }
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Report writer. Composes a markdown table inside the template's
// BENCH:RESULTS marker pair so re-runs replace the table cleanly.
// ---------------------------------------------------------------------------
function cell(outcome: BackendOutcome, phase: keyof PhaseTimings): string {
  if (outcome.timings) return fmtMs(outcome.timings[phase])
  if (outcome.error) {
    // Truncate long error messages so they don't blow up table layout.
    const short = outcome.error.length > 40 ? `${outcome.error.slice(0, 37)}…` : outcome.error
    return `*${short}*`
  }
  return '(not run)'
}

function ratioCell(ts: BackendOutcome, wasm: BackendOutcome, phase: keyof PhaseTimings): string {
  if (!ts.timings || !wasm.timings) return '—'
  return fmtRatio(ts.timings[phase] / wasm.timings[phase])
}

function verdictCell(ts: BackendOutcome, wasm: BackendOutcome, phase: keyof PhaseTimings): string {
  if (!ts.timings || !wasm.timings) {
    if (ts.error && !wasm.error) return 'TS failed; WASM wins by default'
    if (wasm.error && !ts.error) return 'WASM failed; TS wins by default'
    if (ts.error && wasm.error) return 'both failed'
    return 'n/a'
  }
  return verdict(ts.timings[phase] / wasm.timings[phase])
}

function memCell(outcome: BackendOutcome, phase: keyof PhaseMem): string {
  if (!outcome.mem) return outcome.error ? '*failed*' : '—'
  return `${outcome.mem[phase].toFixed(0)} MB`
}

// Produce a "crossover analysis" block: for each phase, walks the tiers in
// size order and reports the first tier where WASM becomes faster than TS
// (ratio crosses 1.0×) plus the ratio direction at every step. Intended to
// be eyeballed — caller doesn't act on it programmatically.
function crossoverAnalysis(): string[] {
  const phases: Array<keyof PhaseTimings> = ['setup', 'bulkWrite', 'readBack', 'recalc']
  const out: string[] = []
  out.push('### Crossover analysis (TS-vs-WASM by tier)')
  out.push('')
  out.push('Ratio > 1.0× means TS is SLOWER than WASM. We track the first')
  out.push('tier where each phase crosses (WASM regains advantage).')
  out.push('')
  for (const phase of phases) {
    const trace: string[] = []
    let crossover = ''
    for (const spec of WORKLOAD_SPECS) {
      const row = results.get(spec.name)
      if (!row) continue
      if (!row.ts.timings && !row.wasm.timings) {
        trace.push(`${spec.name}=both-failed`)
        continue
      }
      if (!row.ts.timings) {
        trace.push(`${spec.name}=ts-failed`)
        if (!crossover) crossover = `${spec.name} (TS failed; WASM wins)`
        continue
      }
      if (!row.wasm.timings) {
        trace.push(`${spec.name}=wasm-failed`)
        continue
      }
      const r = row.ts.timings[phase] / row.wasm.timings[phase]
      trace.push(`${spec.name}=${r.toFixed(2)}×`)
      if (!crossover && r > 1.0) crossover = `${spec.name} (ratio ${r.toFixed(2)}×)`
    }
    out.push(`- **${phase}**: ${trace.join(', ')}`)
    out.push(`  - crossover: ${crossover || 'TS still faster at largest measured tier'}`)
  }
  return out
}

// Chain workload section — formats four tables (ms timings, ms ratio,
// evalCount deltas, peak RSS) and a one-line verdict per phase. Mirrors
// the size-tier output style but with chain-specific phase names.
function chainCell(outcome: ChainBackendOutcome, phase: keyof ChainPhaseTimings): string {
  if (outcome.timings) return fmtMs(outcome.timings[phase])
  if (outcome.error) {
    const short = outcome.error.length > 40 ? `${outcome.error.slice(0, 37)}…` : outcome.error
    return `*${short}*`
  }
  return '(not run)'
}

function chainRatioCell(
  ts: ChainBackendOutcome,
  wasm: ChainBackendOutcome,
  phase: keyof ChainPhaseTimings,
): string {
  if (!ts.timings || !wasm.timings) return '—'
  return fmtRatio(ts.timings[phase] / wasm.timings[phase])
}

function chainVerdictCell(
  ts: ChainBackendOutcome,
  wasm: ChainBackendOutcome,
  phase: keyof ChainPhaseTimings,
): string {
  if (!ts.timings || !wasm.timings) {
    if (ts.error && !wasm.error) return 'TS failed; WASM wins by default'
    if (wasm.error && !ts.error) return 'WASM failed; TS wins by default'
    if (ts.error && wasm.error) return 'both failed'
    return 'n/a'
  }
  const r = ts.timings[phase] / wasm.timings[phase]
  if (!Number.isFinite(r)) return 'n/a'
  // For chain workload, ratio > 1.0 means TS slower (= WASM wins). Phrase
  // explicitly because this is the FIRST place we want Rust to win.
  if (r > 1.5) return 'WASM wins'
  if (r > 1.0) return 'WASM edges'
  if (r > 0.66) return 'roughly tied'
  return 'TS wins'
}

function chainEvalCell(
  outcome: ChainBackendOutcome,
  phase: keyof ChainPhaseEvalDelta,
): string {
  if (!outcome.evals) return outcome.error ? '*failed*' : '—'
  return outcome.evals[phase].toLocaleString()
}

function chainMemCell(outcome: ChainBackendOutcome, phase: keyof ChainPhaseMem): string {
  if (!outcome.mem) return outcome.error ? '*failed*' : '—'
  return `${outcome.mem[phase].toFixed(0)} MB`
}

function chainSection(): string[] {
  const phases: Array<keyof ChainPhaseTimings> = [
    'setup',
    'bulkWrite',
    'firstRecalc',
    'mutateThenRecalc',
    'steadyState',
  ]
  const out: string[] = []
  out.push('## Chain dependency workload')
  out.push('')
  out.push('Single-column chain (`A1=1`, `A2=A1+1`, …, `An=A(n-1)+1`) — the')
  out.push('deepest Store propagation shape in the suite. Phases:')
  out.push('')
  out.push('- **setup**: create the workbook + seed `A1=1`.')
  out.push('- **bulkWrite**: install all `n-1` formulas via `bulkApply` / `bulk_import_cells`.')
  out.push('- **firstRecalc**: read `An` once. Forces full chain evaluation.')
  out.push("- **mutateThenRecalc**: set `A1` to a new value, then read `An`.")
  out.push('  Repeated 5×, median taken. THIS is the chain-workload diagnostic.')
  out.push('- **steadyState**: read `An` again without mutating. Cache-hit check.')
  out.push('')
  out.push('### ms per phase')
  out.push('')
  out.push('| Tier | Phase | TS (ms) | WASM (ms) | Ratio (ts/wasm) | Verdict |')
  out.push('| --- | --- | --- | --- | --- | --- |')
  for (const spec of CHAIN_SPECS) {
    const row = chainResults.get(spec.name)
    if (!row) {
      out.push(`| ${spec.name} | — | (not run) | (not run) | — | — |`)
      continue
    }
    for (const phase of phases) {
      out.push(
        `| ${spec.name} | ${phase} | ${chainCell(row.ts, phase)} | ${chainCell(row.wasm, phase)} | ${chainRatioCell(row.ts, row.wasm, phase)} | ${chainVerdictCell(row.ts, row.wasm, phase)} |`,
      )
    }
  }

  // ---- evalCount delta table ------------------------------------------
  out.push('')
  out.push('### evalCount delta per phase')
  out.push('')
  out.push(
    'For a depth-`n` chain, full re-evaluation = `n-1` formula evals. ' +
      'A delta of `0` on steadyState (or on mutateThenRecalc) means the ' +
      'engine cached the result.',
  )
  out.push('')
  out.push('| Tier | Phase | TS evals | WASM evals |')
  out.push('| --- | --- | --- | --- |')
  for (const spec of CHAIN_SPECS) {
    const row = chainResults.get(spec.name)
    if (!row) continue
    const evalPhases: Array<keyof ChainPhaseEvalDelta> = [
      'setup',
      'bulkWrite',
      'firstRecalc',
      'mutateThenRecalc',
      'steadyState',
    ]
    for (const phase of evalPhases) {
      out.push(
        `| ${spec.name} | ${phase} | ${chainEvalCell(row.ts, phase)} | ${chainEvalCell(row.wasm, phase)} |`,
      )
    }
  }

  // ---- RSS table ------------------------------------------------------
  const anyMem = Array.from(chainResults.values()).some((r) => r.ts.mem || r.wasm.mem)
  if (anyMem) {
    out.push('')
    out.push('### Peak RSS by phase (MB)')
    out.push('')
    out.push('| Tier | Phase | TS RSS | WASM RSS |')
    out.push('| --- | --- | --- | --- |')
    for (const spec of CHAIN_SPECS) {
      const row = chainResults.get(spec.name)
      if (!row) continue
      const memPhases: Array<keyof ChainPhaseMem> = [
        'setup',
        'bulkWrite',
        'firstRecalc',
        'mutateThenRecalc',
        'steadyState',
      ]
      for (const phase of memPhases) {
        out.push(
          `| ${spec.name} | ${phase} | ${chainMemCell(row.ts, phase)} | ${chainMemCell(row.wasm, phase)} |`,
        )
      }
    }
  }

  // ---- Chain-specific crossover trace --------------------------------
  out.push('')
  out.push('### Chain crossover trace (mutateThenRecalc)')
  out.push('')
  out.push('Ratio > 1.0× means TS is SLOWER than WASM on the chain mutate cycle.')
  out.push('This is THE chain-workload diagnostic. If Rust ever beats TS in this')
  out.push('repo, it should show up here first.')
  out.push('')
  {
    const trace: string[] = []
    let crossover = ''
    for (const spec of CHAIN_SPECS) {
      const row = chainResults.get(spec.name)
      if (!row) continue
      if (!row.ts.timings && !row.wasm.timings) {
        trace.push(`${spec.name}=both-failed`)
        continue
      }
      if (!row.ts.timings) {
        trace.push(`${spec.name}=ts-failed`)
        if (!crossover) crossover = `${spec.name} (TS failed; WASM wins by default)`
        continue
      }
      if (!row.wasm.timings) {
        trace.push(`${spec.name}=wasm-failed`)
        continue
      }
      const r = row.ts.timings.mutateThenRecalc / row.wasm.timings.mutateThenRecalc
      trace.push(`${spec.name}=${r.toFixed(2)}×`)
      if (!crossover && r > 1.0) crossover = `${spec.name} (ratio ${r.toFixed(2)}×)`
    }
    out.push(`- ${trace.join(', ')}`)
    out.push(`- crossover: ${crossover || 'TS still faster at deepest measured chain'}`)
  }

  return out
}

// Replace the content between `<!-- ${name}:START -->` and `<!-- ${name}:END -->`
// in the given template. Appends a fresh block at the end if the markers are
// missing. Used so the size-tier and chain suites can each own their own
// marker block — running one suite in isolation must not clobber the other's
// previously-persisted data.
function replaceBlock(template: string, name: string, body: string): string {
  const start = `<!-- ${name}:START -->`
  const end = `<!-- ${name}:END -->`
  const block = `${start}\n${body}\n${end}`
  if (template.includes(start) && template.includes(end)) {
    const before = template.slice(0, template.indexOf(start))
    const after = template.slice(template.indexOf(end) + end.length)
    return `${before}${block}${after}`
  }
  return `${template}\n\n${block}\n`
}

function writeReport() {
  if (!PERF_ENABLED || !PERF_WRITE_REPORT) return

  const reportPath = path.join(__dirname, 'perf-ts-vs-wasm-report.md')
  let template: string
  try {
    template = readFileSync(reportPath, 'utf8')
  } catch {
    template =
      '# TS vs WASM Backend — Perf Report\n\n' +
      '<!-- BENCH:RESULTS:START -->\n<!-- BENCH:RESULTS:END -->\n\n' +
      '<!-- BENCH:CHAIN:START -->\n<!-- BENCH:CHAIN:END -->\n\n' +
      '<!-- BENCH:RANGE:START -->\n<!-- BENCH:RANGE:END -->\n'
  }

  // ----- Size-tier block (only refreshed if we have any size-tier data
  // this run; otherwise the previously-persisted block stays as-is) -----
  if (results.size > 0) {
    const lines: string[] = []
    const stamp = new Date().toISOString()
    lines.push(`*Last bench run: ${stamp}*`)
    if (!wasmAvailable) {
      lines.push('')
      lines.push(`> WASM skipped: ${wasmSkipReason}`)
    }
    lines.push('')
    lines.push('| Workload | Phase | TS (ms) | WASM (ms) | Ratio (ts/wasm) | Verdict |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const spec of WORKLOAD_SPECS) {
      const row = results.get(spec.name)
      if (!row) continue
      const phases: Array<keyof PhaseTimings> = ['setup', 'bulkWrite', 'readBack', 'recalc']
      for (const phase of phases) {
        lines.push(
          `| ${spec.name} | ${phase} | ${cell(row.ts, phase)} | ${cell(row.wasm, phase)} | ${ratioCell(row.ts, row.wasm, phase)} | ${verdictCell(row.ts, row.wasm, phase)} |`,
        )
      }
    }

    const anyMem = Array.from(results.values()).some((r) => r.ts.mem || r.wasm.mem)
    if (anyMem) {
      lines.push('')
      lines.push('### Peak RSS by phase (MB)')
      lines.push('')
      lines.push('| Workload | Phase | TS RSS | WASM RSS |')
      lines.push('| --- | --- | --- | --- |')
      for (const spec of WORKLOAD_SPECS) {
        const row = results.get(spec.name)
        if (!row) continue
        const phases: Array<keyof PhaseMem> = ['setup', 'bulkWrite', 'readBack', 'recalc']
        for (const phase of phases) {
          lines.push(
            `| ${spec.name} | ${phase} | ${memCell(row.ts, phase)} | ${memCell(row.wasm, phase)} |`,
          )
        }
      }
    }

    const failures: string[] = []
    for (const spec of WORKLOAD_SPECS) {
      const row = results.get(spec.name)
      if (!row) continue
      if (row.ts.error) failures.push(`- **${spec.name} / TS**: ${row.ts.error}`)
      if (row.wasm.error) failures.push(`- **${spec.name} / WASM**: ${row.wasm.error}`)
    }
    if (failures.length > 0) {
      lines.push('')
      lines.push('### Failures / skipped backends')
      lines.push('')
      lines.push(...failures)
    }

    lines.push('')
    lines.push(...crossoverAnalysis())

    template = replaceBlock(template, 'BENCH:RESULTS', lines.join('\n'))
  }

  // ----- Chain block (independent: only refreshed if chain suite ran) --
  if (chainResults.size > 0) {
    const lines: string[] = []
    const stamp = new Date().toISOString()
    lines.push(`*Last chain bench run: ${stamp}*`)
    if (!wasmAvailable) {
      lines.push('')
      lines.push(`> WASM skipped: ${wasmSkipReason}`)
    }
    lines.push('')
    lines.push(...chainSection())

    const chainFailures: string[] = []
    for (const spec of CHAIN_SPECS) {
      const row = chainResults.get(spec.name)
      if (!row) continue
      if (row.ts.error) chainFailures.push(`- **${spec.name} / TS**: ${row.ts.error}`)
      if (row.wasm.error) chainFailures.push(`- **${spec.name} / WASM**: ${row.wasm.error}`)
    }
    if (chainFailures.length > 0) {
      lines.push('')
      lines.push('### Chain failures / skipped backends')
      lines.push('')
      lines.push(...chainFailures)
    }

    template = replaceBlock(template, 'BENCH:CHAIN', lines.join('\n'))
  }

  // ----- Range block (independent: only refreshed if range suite ran) --
  if (rangeResults.size > 0) {
    const lines: string[] = []
    const stamp = new Date().toISOString()
    lines.push(`*Last range bench run: ${stamp}*`)
    if (!wasmAvailable) {
      lines.push('')
      lines.push(`> WASM skipped: ${wasmSkipReason}`)
    }
    lines.push('')
    lines.push(...rangeSection())

    const rangeFailures: string[] = []
    for (const spec of RANGE_SPECS) {
      const row = rangeResults.get(spec.name)
      if (!row) continue
      if (row.ts.error) rangeFailures.push(`- **${spec.name} / TS**: ${row.ts.error}`)
      if (row.wasm.error) rangeFailures.push(`- **${spec.name} / WASM**: ${row.wasm.error}`)
    }
    if (rangeFailures.length > 0) {
      lines.push('')
      lines.push('### Range failures / skipped backends')
      lines.push('')
      lines.push(...rangeFailures)
    }

    template = replaceBlock(template, 'BENCH:RANGE', lines.join('\n'))
  }

  writeFileSync(reportPath, template)
}
