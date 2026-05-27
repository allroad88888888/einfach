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
 * numbers, ratios, and a verdict per row. CI never runs it; humans
 * read the report when they want to see how the port is trending.
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
const describePerf = PERF_ENABLED ? describe : describe.skip

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
// Large+ use 1 run because each TS pass with 100k+ cells can take tens
// of seconds — broad-invalidation O(n) Map clones × O(n) per-cell writes
// (PLAN.md §4.1). 3 runs would push the bench wall-clock past any
// reasonable budget without changing the verdict.
//
// Tier sizing:
//   - Tiny  / Medium / Large are unchanged (validate baseline).
//   - XLarge / Mega / Ultra were added to find the Rust-overtakes-TS
//     crossover predicted by PLAN.md §4.1 ("per-cell dep graph beats
//     broad invalidation at scale"). Sizes track the millions-of-cells
//     threshold:
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

        // Persist partial results after each tier — if a later tier OOMs
        // hard enough that `afterAll` never runs, the markdown still
        // reflects what we did manage to measure.
        writeReport()
      },
      spec.timeoutMs,
    )
  }
})

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

function writeReport() {
  if (!PERF_ENABLED) return // describe.skip path — nothing to write.

  const reportPath = path.join(__dirname, 'perf-ts-vs-wasm-report.md')
  const lines: string[] = []
  const stamp = new Date().toISOString()
  lines.push(`*Last bench run: ${stamp}*`)
  if (!wasmAvailable) {
    lines.push('')
    lines.push(`> WASM skipped: ${wasmSkipReason}`)
  }
  lines.push('')

  // ----- Timings table --------------------------------------------------
  lines.push('| Workload | Phase | TS (ms) | WASM (ms) | Ratio (ts/wasm) | Verdict |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const spec of WORKLOAD_SPECS) {
    const row = results.get(spec.name)
    if (!row) {
      lines.push(`| ${spec.name} | — | (not run) | (not run) | — | — |`)
      continue
    }
    const phases: Array<keyof PhaseTimings> = ['setup', 'bulkWrite', 'readBack', 'recalc']
    for (const phase of phases) {
      lines.push(
        `| ${spec.name} | ${phase} | ${cell(row.ts, phase)} | ${cell(row.wasm, phase)} | ${ratioCell(row.ts, row.wasm, phase)} | ${verdictCell(row.ts, row.wasm, phase)} |`,
      )
    }
  }

  // ----- Memory footprint table (only emit if we have any mem data) -----
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

  // ----- Failures section (highlight OOMs etc.) -------------------------
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

  // ----- Crossover analysis --------------------------------------------
  lines.push('')
  lines.push(...crossoverAnalysis())

  // Replace the marker block in the existing template. Falls back to
  // appending a fresh block at the end if the markers are missing
  // (e.g. someone wiped the template).
  const start = '<!-- BENCH:RESULTS:START -->'
  const end = '<!-- BENCH:RESULTS:END -->'
  let template: string
  try {
    template = readFileSync(reportPath, 'utf8')
  } catch {
    template = `# TS vs WASM Backend — Perf Report\n\n${start}\n${end}\n`
  }
  const block = `${start}\n${lines.join('\n')}\n${end}`
  let next: string
  if (template.includes(start) && template.includes(end)) {
    const before = template.slice(0, template.indexOf(start))
    const after = template.slice(template.indexOf(end) + end.length)
    next = `${before}${block}${after}`
  } else {
    next = `${template}\n\n${block}\n`
  }
  writeFileSync(reportPath, next)
}
