/**
 * Adapter-level scale PARITY suite — `rust/excel-core/docs/SCALE_TEST_SUITE_PLAN.md`
 * ("Parity suite"): ONE seeded ~75k mixed workload driven through BOTH
 * worker runtimes, asserting identical observable state.
 *
 * Engines under test (both node-side, no browser, no real Worker):
 *
 *   - TS engine — `createWorkerRuntimeTs().handle()` RPC surface (the same
 *     dispatcher the real Worker runs). Bulk path:
 *     beginImport → importChunk → commitImport (one `bulkApply` per sheet).
 *   - WASM engine — `WasmWorkbook` from `solid/excel/wasm-pkg/`, driven
 *     exactly like `perf-ts-vs-wasm.bench.ts`: the wasm RPC dispatcher in
 *     `worker-runtime.ts` auto-installs onto `self` and can't be invoked
 *     twice cleanly under jest, so we call the same wasm-bindgen methods
 *     the dispatcher would call. Bulk path: `bulk_install_workbook`
 *     (storage-primary, Phase 6.2).
 *
 * Phases:
 *   P1 import parity      — seeded LCG workload (50k primitives + ~25k
 *                           formulas: binops, IF, bounded chains, whole-col
 *                           SUM/SUMIF/COUNTIF, cross-sheet refs over 3
 *                           sheets, SEQUENCE spills, deliberate error
 *                           formulas) → 500 deterministic sampled
 *                           addresses: `display` and `isError` identical.
 *                           Plus closed-form spot checks and the
 *                           CONTRACTUAL formula-cache-probe states.
 *   P2 mutation parity    — 200 seeded edits (set/clear/formula-overwrite,
 *                           incl. writes into spill regions) → re-sample
 *                           identical.
 *   P3 structural parity  — test.todo: `worker-runtime-ts.ts` stubs
 *                           insertRows / deleteRows / insertColumns /
 *                           deleteColumns as no-op `true` ("Wave E will
 *                           implement band shifts"). A guard spec pins the
 *                           stub so the todo flips loudly when structural
 *                           ops land on the TS runtime.
 *   P4 clearRange parity  — full-column clear over the seeded sheet
 *                           (e507222 sparse path): cleared-cell counter is
 *                           CLOSED-FORM (== existing cells in the column,
 *                           never the dense 1M rectangle) + identical
 *                           post-state.
 *   P5 restore parity     — snapshotPersistenceV1 → FRESH runtime →
 *                           restore on each engine (TS→TS, WASM→WASM),
 *                           sampled equality per engine + cross-engine,
 *                           plus snapshot-shape comparison between the two
 *                           wires.
 *
 * Discipline (SCALE_TEST_SUITE_PLAN design principles):
 *   - GATED, not always-on (measured deviation from the plan): the full
 *     file costs ~4.5 min wall (TS trampoline eval of ~25k formulas ×
 *     two engines × five phases) — 40× over the always-on budget, so it
 *     runs only when `EINFACH_SCALE=1` is set. The per-engine S1–S12
 *     suites (rust scale_suite.rs / excel-core-ts scale-suite.test.ts)
 *     remain always-on; this file is the cross-engine equivalence layer:
 *       EINFACH_SCALE=1 npx jest solid/excel/test/scale-parity.test.ts --no-coverage
 *   - deterministic: seeded LCG only — no Date.now / Math.random.
 *   - counters, not clocks: completion is asserted via cleared-cell /
 *     import-stat counters, never wall-time.
 *   - closed-form where possible: whole-col SUM == JS-computed seed sum.
 *
 * Documented divergences NOT asserted here (see
 * `solid/excel/e2e/BACKEND_PARITY.md` § "What the debug-probe RPC
 * surfaces" and the file-level comment in
 * `excel-core-ts-debug-probes.test.ts`): the cache-probe state of an
 * ALREADY-READ formula after a mutation (TS-core is eager-on-mutation,
 * Rust-core purely lazy). Probe assertions below stick to the contractual
 * subset both backends agree on: never-read formula → 'dirty', after a
 * host-facing read → 'clean', literal cell → 'none'.
 *
 * If a parity spec here fails, that is a REAL finding — report the failing
 * addresses together with `WORKLOAD_SEED` / `EDIT_SEED`; do not patch
 * either engine to make the suite green.
 */
import { describe, expect, test, beforeAll, afterAll } from '@jest/globals'
import { readFileSync, existsSync } from 'node:fs'
import { TextDecoder, TextEncoder } from 'node:util'
import path from 'node:path'

import {
  createWorkerRuntimeTs,
  type ExcelCoreTsWorkerRuntime,
} from '../src-vnext/adapter/worker-runtime-ts'

// jsdom under jest doesn't expose TextDecoder/TextEncoder; the wasm-bindgen
// glue grabs them at module-load time, so patch globals BEFORE importing
// the wasm module (same trick as perf-ts-vs-wasm.bench.ts).
const g = globalThis as unknown as {
  TextDecoder: typeof TextDecoder
  TextEncoder: typeof TextEncoder
}
if (!g.TextDecoder) g.TextDecoder = TextDecoder
if (!g.TextEncoder) g.TextEncoder = TextEncoder

const WASM_PKG_JS = path.join(__dirname, '..', 'wasm-pkg', 'einfach_wasm.js')
const WASM_PKG_BIN = path.join(__dirname, '..', 'wasm-pkg', 'einfach_wasm_bg.wasm')

// ---------------------------------------------------------------------------
// Seeds. Changing either changes the workload — keep them stable so a
// reported divergence stays reproducible.
// ---------------------------------------------------------------------------
const WORKLOAD_SEED = 0x5ca1ab1e
const EDIT_SEED = 0xed17ed17
const SAMPLE_SEED = 0x5a401e5

// ---------------------------------------------------------------------------
// Deterministic LCG (Numerical Recipes — same generator as the perf bench).
// ---------------------------------------------------------------------------
function makeRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}
function rngInt(rng: () => number, bound: number): number {
  return Math.floor(rng() * bound) % bound
}

function colLetters(col: number): string {
  let out = ''
  let n = col
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out
    if (n < 26) return out
    n = Math.floor(n / 26) - 1
  }
}
function a1(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`
}

// ---------------------------------------------------------------------------
// Workload definition — built ONCE; both engines consume the same object.
//
// Sheets: Sheet1 / Sheet2 / Sheet3.
//
// Primitives (50,000):
//   Sheet1 A1:A20000  numbers  (LCG 0..999)
//   Sheet1 B1:B3000   text     (`t<n>-<lcg>`)
//   Sheet1 C1:C2000   booleans
//   Sheet2 A1:A15000  numbers
//   Sheet3 A1:A10000  numbers
//
// Formulas (~25,000):
//   Sheet1 D1:D10000  50/50 `=Ax+Ay` | `=IF(Ax>500,Ax*2,Ax-1)`
//   Sheet1 E1:E5000   bounded SUMIF windows `=SUMIF(Alo:Ahi,">500")`
//   Sheet2 B1:B5000   cross-sheet `=Sheet1!Ax*2`
//   Sheet3 B1:B5000   chains in 50-cell blocks (`=B(r-1)+1`, head `=A(r)+0`)
//   Specials: whole-col aggregates, cross-sheet aggregate, SEQUENCE spills,
//             deliberate error formulas (see SPECIALS below).
// ---------------------------------------------------------------------------
const SHEET_NAMES = ['Sheet1', 'Sheet2', 'Sheet3']
const S1_NUMS = 20_000
const S1_TEXTS = 3_000
const S1_BOOLS = 2_000
const S2_NUMS = 15_000
const S3_NUMS = 10_000
const S1_BINOPS = 10_000
const S1_SUMIFS = 5_000
const S2_XSHEET = 5_000
const S3_CHAIN = 5_000
const CHAIN_BLOCK = 50

interface WorkloadCellNumber {
  sheet: number
  row: number
  col: number
  kind: 'number'
  value: number
}
interface WorkloadCellText {
  sheet: number
  row: number
  col: number
  kind: 'text'
  value: string
}
interface WorkloadCellBoolean {
  sheet: number
  row: number
  col: number
  kind: 'boolean'
  value: boolean
}
interface WorkloadCellFormula {
  sheet: number
  row: number
  col: number
  kind: 'formula'
  value: string
}
type WorkloadCell =
  | WorkloadCellNumber
  | WorkloadCellText
  | WorkloadCellBoolean
  | WorkloadCellFormula

interface CellRef {
  sheet: number
  addr: string
}

interface Workload {
  cells: WorkloadCell[]
  /** 500 deterministic sample refs (incl. specials, spill targets, errors, empties). */
  sampleRefs: CellRef[]
  /** Formula cells NOT in the sample set, reserved for the never-read probe. */
  probeRefs: { neverRead: CellRef; literal: CellRef }
  /** Closed form: sum of the Sheet1 A-column seed values. */
  sheet1ColASum: number
  /** Count of Sheet1 A-column cells (closed form for the P4 clear counter). */
  sheet1ColACount: number
  /** Addresses covered by spill regions (anchors + targets), per sheet. */
  spillRegionRefs: CellRef[]
}

// Specials — fixed addresses (zero-based row/col), all on top of the bulk
// columns above. Kept OUT of the LCG columns so nothing overwrites them.
const SPECIALS: WorkloadCellFormula[] = [
  // Whole-column aggregates (sparse fan-in at scale).
  { sheet: 0, row: 0, col: 6, kind: 'formula', value: '=SUM(A:A)' }, // Sheet1!G1
  { sheet: 0, row: 1, col: 6, kind: 'formula', value: '=SUMIF(A:A,">500")' }, // Sheet1!G2
  { sheet: 0, row: 2, col: 6, kind: 'formula', value: '=COUNTIF(A:A,"<200")' }, // Sheet1!G3
  { sheet: 1, row: 0, col: 2, kind: 'formula', value: '=SUM(A:A)' }, // Sheet2!C1
  { sheet: 2, row: 0, col: 2, kind: 'formula', value: '=SUM(A:A)' }, // Sheet3!C1
  // Cross-sheet aggregate.
  {
    sheet: 1,
    row: 1,
    col: 2,
    kind: 'formula',
    value: '=SUM(Sheet1!A1:A1000)+SUM(A1:A1000)', // Sheet2!C2
  },
  // Spill anchors (dynamic arrays).
  { sheet: 0, row: 0, col: 7, kind: 'formula', value: '=SEQUENCE(10)' }, // Sheet1!H1 → H1:H10
  { sheet: 0, row: 0, col: 9, kind: 'formula', value: '=SEQUENCE(4,3)' }, // Sheet1!J1 → J1:L4
  { sheet: 1, row: 0, col: 3, kind: 'formula', value: '=SEQUENCE(8)' }, // Sheet2!D1 → D1:D8
  { sheet: 2, row: 0, col: 3, kind: 'formula', value: '=SEQUENCE(5,2)' }, // Sheet3!D1 → D1:E5
  // Deliberate error formulas.
  { sheet: 0, row: 0, col: 12, kind: 'formula', value: '=1/0' }, // Sheet1!M1 → #DIV/0!
  { sheet: 0, row: 1, col: 12, kind: 'formula', value: '=NOSUCHFN_PARITY(1)' }, // Sheet1!M2 → #NAME?
  { sheet: 0, row: 2, col: 12, kind: 'formula', value: '=SQRT(-1)' }, // Sheet1!M3 → #NUM!
  { sheet: 0, row: 3, col: 12, kind: 'formula', value: '=1+"x"' }, // Sheet1!M4 → #VALUE!
]

// Spill regions implied by the SPECIALS above (anchor + targets).
function spillRegions(): CellRef[] {
  const out: CellRef[] = []
  const push = (sheet: number, row0: number, col0: number, rows: number, cols: number) => {
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        out.push({ sheet, addr: a1(row0 + r, col0 + c) })
      }
    }
  }
  push(0, 0, 7, 10, 1) // Sheet1 H1:H10
  push(0, 0, 9, 4, 3) // Sheet1 J1:L4
  push(1, 0, 3, 8, 1) // Sheet2 D1:D8
  push(2, 0, 3, 5, 2) // Sheet3 D1:E5
  return out
}

function buildWorkload(): Workload {
  const rng = makeRng(WORKLOAD_SEED)
  const cells: WorkloadCell[] = []

  // --- primitives ---------------------------------------------------------
  let sheet1ColASum = 0
  for (let r = 0; r < S1_NUMS; r += 1) {
    const v = rngInt(rng, 1000)
    sheet1ColASum += v
    cells.push({ sheet: 0, row: r, col: 0, kind: 'number', value: v })
  }
  for (let r = 0; r < S1_TEXTS; r += 1) {
    cells.push({ sheet: 0, row: r, col: 1, kind: 'text', value: `t${r}-${rngInt(rng, 100)}` })
  }
  for (let r = 0; r < S1_BOOLS; r += 1) {
    cells.push({ sheet: 0, row: r, col: 2, kind: 'boolean', value: rng() < 0.5 })
  }
  for (let r = 0; r < S2_NUMS; r += 1) {
    cells.push({ sheet: 1, row: r, col: 0, kind: 'number', value: rngInt(rng, 1000) })
  }
  for (let r = 0; r < S3_NUMS; r += 1) {
    cells.push({ sheet: 2, row: r, col: 0, kind: 'number', value: rngInt(rng, 1000) })
  }

  // --- formulas ------------------------------------------------------------
  // Sheet1 D: binop / IF mix over the A column.
  for (let r = 0; r < S1_BINOPS; r += 1) {
    if (rng() < 0.5) {
      const x = rngInt(rng, S1_NUMS)
      const y = rngInt(rng, S1_NUMS)
      cells.push({
        sheet: 0,
        row: r,
        col: 3,
        kind: 'formula',
        value: `=${a1(x, 0)}+${a1(y, 0)}`,
      })
    } else {
      const x = rngInt(rng, S1_NUMS)
      cells.push({
        sheet: 0,
        row: r,
        col: 3,
        kind: 'formula',
        value: `=IF(${a1(x, 0)}>500,${a1(x, 0)}*2,${a1(x, 0)}-1)`,
      })
    }
  }
  // Sheet1 E: bounded SUMIF windows (1,000-cell windows over A).
  for (let r = 0; r < S1_SUMIFS; r += 1) {
    const lo = rngInt(rng, S1_NUMS - 1000)
    cells.push({
      sheet: 0,
      row: r,
      col: 4,
      kind: 'formula',
      value: `=SUMIF(${a1(lo, 0)}:${a1(lo + 999, 0)},">500")`,
    })
  }
  // Sheet2 B: cross-sheet point refs into Sheet1.
  for (let r = 0; r < S2_XSHEET; r += 1) {
    const x = rngInt(rng, S1_NUMS)
    cells.push({ sheet: 1, row: r, col: 1, kind: 'formula', value: `=Sheet1!${a1(x, 0)}*2` })
  }
  // Sheet3 B: 50-deep chains (block head re-roots on the A column so a
  // single block stays a bounded dependency chain on both engines).
  for (let r = 0; r < S3_CHAIN; r += 1) {
    cells.push({
      sheet: 2,
      row: r,
      col: 1,
      kind: 'formula',
      value: r % CHAIN_BLOCK === 0 ? `=${a1(r, 0)}+0` : `=${a1(r - 1, 1)}+1`,
    })
  }
  cells.push(...SPECIALS)

  // --- deterministic samples ------------------------------------------------
  const spillRefs = spillRegions()
  const sampleRefs: CellRef[] = []
  const seen = new Set<string>()
  const addRef = (ref: CellRef) => {
    const key = `${ref.sheet}:${ref.addr}`
    if (seen.has(key)) return
    seen.add(key)
    sampleRefs.push(ref)
  }
  // Specials, full spill regions, and a blank just outside each spill edge.
  for (const s of SPECIALS) addRef({ sheet: s.sheet, addr: a1(s.row, s.col) })
  for (const ref of spillRefs) addRef(ref)
  addRef({ sheet: 0, addr: 'H11' }) // one past Sheet1!H1 spill
  addRef({ sheet: 1, addr: 'D9' }) // one past Sheet2!D1 spill
  // A handful of definitely-empty cells.
  addRef({ sheet: 0, addr: 'AZ99999' })
  addRef({ sheet: 1, addr: 'Q42' })
  addRef({ sheet: 2, addr: 'XFD1048576' })
  // Chain tails (closed-form-ish: head + 49).
  for (let b = 0; b < S3_CHAIN; b += CHAIN_BLOCK * 10) {
    addRef({ sheet: 2, addr: a1(b + CHAIN_BLOCK - 1, 1) })
  }
  // Fill to 500 by LCG over the workload cells. Reserve the LAST formula
  // rows of Sheet1 D / E for the never-read probe pool by skipping them.
  const sampleRng = makeRng(SAMPLE_SEED)
  while (sampleRefs.length < 500) {
    const cell = cells[rngInt(sampleRng, cells.length)]
    if (cell.sheet === 0 && cell.col === 3 && cell.row >= S1_BINOPS - 10) continue
    addRef({ sheet: cell.sheet, addr: a1(cell.row, cell.col) })
  }

  return {
    cells,
    sampleRefs,
    probeRefs: {
      // Reserved above — never read through any sampling pass.
      neverRead: { sheet: 0, addr: a1(S1_BINOPS - 1, 3) },
      literal: { sheet: 0, addr: 'A1' },
    },
    sheet1ColASum,
    sheet1ColACount: S1_NUMS,
    spillRegionRefs: spillRefs,
  }
}

// ---------------------------------------------------------------------------
// Seeded edit script (P2). Applied IDENTICALLY to both engines.
// ---------------------------------------------------------------------------
type EditOp =
  | { op: 'setNumber'; sheet: number; addr: string; value: number }
  | { op: 'setText'; sheet: number; addr: string; value: string }
  | { op: 'clearCell'; sheet: number; addr: string }
  | { op: 'setFormula'; sheet: number; addr: string; formula: string }

function buildEdits(): EditOp[] {
  const rng = makeRng(EDIT_SEED)
  const ops: EditOp[] = []
  for (let i = 0; i < 197; i += 1) {
    const k = rng()
    if (k < 0.4) {
      // Overwrite a seeded number (keeps the Sheet1 A-column cell COUNT
      // stable — the P4 closed form depends on it).
      const sheet = rngInt(rng, 3)
      const bound = sheet === 0 ? S1_NUMS : sheet === 1 ? S2_NUMS : S3_NUMS
      ops.push({
        op: 'setNumber',
        sheet,
        addr: a1(rngInt(rng, bound), 0),
        value: rngInt(rng, 5000),
      })
    } else if (k < 0.55) {
      ops.push({
        op: 'setText',
        sheet: 0,
        addr: a1(rngInt(rng, S1_TEXTS), 1),
        value: `edit${i}-${rngInt(rng, 100)}`,
      })
    } else if (k < 0.7) {
      ops.push({ op: 'clearCell', sheet: 0, addr: a1(rngInt(rng, S1_BINOPS - 10), 3) })
    } else if (k < 0.9) {
      const r = rngInt(rng, S1_NUMS)
      ops.push({
        op: 'setFormula',
        sheet: 0,
        addr: a1(rngInt(rng, S1_BINOPS - 10), 3),
        formula: `=${a1(r, 0)}*3+1`,
      })
    } else {
      const r = rngInt(rng, S3_NUMS)
      ops.push({
        op: 'setFormula',
        sheet: 1,
        addr: a1(rngInt(rng, S2_XSHEET), 1),
        formula: `=Sheet3!${a1(r, 0)}+${rngInt(rng, 100)}`,
      })
    }
  }
  // Spill-region edits (fixed, deterministic): a literal into a spill
  // target, a formula overwrite into a spill target, and an anchor clear.
  ops.push({ op: 'setNumber', sheet: 0, addr: 'H3', value: 999 }) // into Sheet1!H1 spill
  ops.push({ op: 'setFormula', sheet: 0, addr: 'K2', formula: '=1+1' }) // into Sheet1!J1 spill
  ops.push({ op: 'clearCell', sheet: 1, addr: 'D1' }) // tear down Sheet2!D1 anchor
  return ops
}

// ---------------------------------------------------------------------------
// Engine drivers — one common surface over both runtimes.
// ---------------------------------------------------------------------------
interface SampledCell {
  display: string
  isError: boolean
}

interface ParityEngine {
  readonly label: 'ts' | 'wasm'
  importWorkload(cells: WorkloadCell[]): Promise<void>
  readSamples(refs: CellRef[]): Promise<Map<string, SampledCell>>
  applyEdit(op: EditOp): Promise<void>
  /** Clear one full column (rows 0..1_048_575). Returns the cleared-cell counter. */
  clearColumn(sheet: number, col: number): Promise<number>
  cacheState(sheet: number, addr: string): Promise<string>
  snapshotPersistence(): Promise<PersistenceSnapshot>
  /** Build a FRESH engine of the same kind and restore the snapshot into it. */
  restoreIntoFresh(snapshot: PersistenceSnapshot): Promise<ParityEngine>
  dispose(): void
}

interface PersistenceSnapshot {
  version: number
  sheets: Array<{ idx: number; name: string }>
  cells: Array<{
    sheet: number
    addr: string
    row: number
    col: number
    kind: string
    value?: unknown
  }>
  [key: string]: unknown
}

function refKey(ref: CellRef): string {
  return `${ref.sheet}:${ref.addr}`
}

// --- TS engine -------------------------------------------------------------
function makeTsEngine(runtime?: ExcelCoreTsWorkerRuntime): ParityEngine & {
  rpc: (msg: Record<string, unknown>) => Promise<unknown>
} {
  const rt = runtime ?? createWorkerRuntimeTs()
  let rpcId = 0
  const rpc = async (msg: Record<string, unknown>) => {
    rpcId += 1
    const resp = await rt.handle({ id: rpcId, ...msg } as never)
    if (!resp.ok) {
      throw new Error(`ts rpc ${String(msg.cmd)} failed: ${resp.error.code} ${resp.error.message}`)
    }
    return resp.result
  }

  return {
    label: 'ts',
    rpc,
    async importWorkload(cells) {
      await rpc({ cmd: 'initWorkbook', sheets: SHEET_NAMES })
      const sessionId = (await rpc({ cmd: 'beginImport', mode: 'atomic' })) as number
      // Stream in chunks like the real backend does; the runtime buffers
      // and commits in one bulkApply per sheet either way.
      const CHUNK = 25_000
      for (let i = 0; i < cells.length; i += CHUNK) {
        await rpc({ cmd: 'importChunk', sessionId, cells: cells.slice(i, i + CHUNK) })
      }
      const stats = (await rpc({ cmd: 'commitImport', sessionId })) as {
        accepted: number
        formulas: number
        rejectedFormulas: number
      }
      // Counter, not clock: every staged cell must be accepted.
      expect(stats.accepted).toBe(cells.length)
      expect(stats.rejectedFormulas).toBe(0)
    },
    async readSamples(refs) {
      const out = new Map<string, SampledCell>()
      const snaps = (await rpc({
        cmd: 'readCells',
        cells: refs.map((r) => ({ sheet: r.sheet, addr: r.addr })),
      })) as Array<{ sheet: number; addr: string; display: string; isError: boolean }>
      snaps.forEach((snap, i) => {
        out.set(refKey(refs[i]), { display: snap.display, isError: snap.isError })
      })
      return out
    },
    async applyEdit(op) {
      switch (op.op) {
        case 'setNumber':
          await rpc({
            cmd: 'setCell',
            sheet: op.sheet,
            addr: op.addr,
            value: { type: 'number', value: op.value },
          })
          return
        case 'setText':
          await rpc({
            cmd: 'setCell',
            sheet: op.sheet,
            addr: op.addr,
            value: { type: 'text', value: op.value },
          })
          return
        case 'clearCell':
          await rpc({ cmd: 'clearCell', sheet: op.sheet, addr: op.addr })
          return
        case 'setFormula':
          await rpc({ cmd: 'setFormula', sheet: op.sheet, addr: op.addr, formula: op.formula })
          return
      }
    },
    async clearColumn(sheet, col) {
      return (await rpc({
        cmd: 'clearRange',
        range: { sheet, startRow: 0, startCol: col, endRow: 1_048_575, endCol: col },
      })) as number
    },
    async cacheState(sheet, addr) {
      return (await rpc({ cmd: 'debugFormulaCacheState', sheet, addr })) as string
    },
    async snapshotPersistence() {
      return (await rpc({ cmd: 'snapshotPersistenceV1' })) as PersistenceSnapshot
    },
    async restoreIntoFresh(snapshot) {
      const fresh = makeTsEngine()
      await fresh.rpc({ cmd: 'restorePersistenceV1', snapshot })
      return fresh
    },
    dispose() {
      // GC'd with the closure.
    },
  }
}

// --- WASM engine -------------------------------------------------------------
type WasmWorkbookCtor = new () => WasmWorkbookLike
interface WasmModuleShape {
  default: (init?: { module_or_path: ArrayBufferLike }) => Promise<unknown>
  WasmWorkbook: WasmWorkbookCtor
}

interface WasmWorkbookLike {
  rename_sheet(idx: number, name: string): boolean
  add_sheet(name: string): number
  bulk_install_workbook(payload: unknown): unknown
  snapshotCell(
    sheet: number,
    addr: string,
  ): {
    sheet: number
    addr: string
    display: string
    type: string
    isError: boolean
    formula: string
  }
  set_cell_number(sheet: number, addr: string, value: number): void
  set_cell_text(sheet: number, addr: string, value: string): void
  clearCellAt(sheet: number, addr: string): void
  setFormulaAt(sheet: number, addr: string, src: string): boolean
  clear_range(
    sheet: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): number
  debug_formula_cache_state(sheet: number, addr: string): string
  snapshot_persistence_v1(): unknown
  restore_persistence_v1(snapshot: unknown): unknown
  free(): void
}

let WasmModule: WasmModuleShape | undefined

async function loadWasmModule(): Promise<WasmModuleShape> {
  if (WasmModule) return WasmModule
  if (!existsSync(WASM_PKG_JS) || !existsSync(WASM_PKG_BIN)) {
    throw new Error(
      `scale-parity: wasm-pkg missing at ${WASM_PKG_JS} — run \`npm --prefix solid/excel run build:wasm\``,
    )
  }
  const mod = (await import(WASM_PKG_JS)) as WasmModuleShape
  const bytes = readFileSync(WASM_PKG_BIN)
  await mod.default({
    module_or_path: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })
  WasmModule = mod
  return mod
}

function makeWasmEngine(existing?: WasmWorkbookLike): ParityEngine & { wb: WasmWorkbookLike } {
  if (!WasmModule) throw new Error('wasm module not loaded')
  const wb = existing ?? new WasmModule.WasmWorkbook()

  return {
    label: 'wasm',
    wb,
    async importWorkload(cells) {
      // Mirror worker-runtime.ts `resetWorkbook` sheet setup.
      wb.rename_sheet(0, SHEET_NAMES[0])
      for (const name of SHEET_NAMES.slice(1)) wb.add_sheet(name)
      // Storage-primary bulk install (Phase 6.2) — group per sheet.
      const bySheet = new Map<
        number,
        { sheet: number; primitives: Array<[string, unknown]>; formulas: Array<[string, string]> }
      >()
      for (let i = 0; i < SHEET_NAMES.length; i += 1) {
        bySheet.set(i, { sheet: i, primitives: [], formulas: [] })
      }
      for (const cell of cells) {
        const entry = bySheet.get(cell.sheet)
        if (!entry) throw new Error(`workload sheet out of range: ${cell.sheet}`)
        const addr = a1(cell.row, cell.col)
        if (cell.kind === 'formula') entry.formulas.push([addr, cell.value])
        else entry.primitives.push([addr, cell.value])
      }
      const stats = wb.bulk_install_workbook([...bySheet.values()]) as Array<{
        sheet: number
        primitivesInstalled: number
        formulasInstalled: number
      }>
      // Counter, not clock: install counts must cover the whole workload.
      const primitives = cells.filter((c) => c.kind !== 'formula').length
      const formulas = cells.length - primitives
      expect(stats.reduce((acc, s) => acc + s.primitivesInstalled, 0)).toBe(primitives)
      expect(stats.reduce((acc, s) => acc + s.formulasInstalled, 0)).toBe(formulas)
    },
    async readSamples(refs) {
      const out = new Map<string, SampledCell>()
      for (const ref of refs) {
        const snap = wb.snapshotCell(ref.sheet, ref.addr)
        out.set(refKey(ref), { display: snap.display, isError: snap.isError })
      }
      return out
    },
    async applyEdit(op) {
      switch (op.op) {
        case 'setNumber':
          wb.set_cell_number(op.sheet, op.addr, op.value)
          return
        case 'setText':
          wb.set_cell_text(op.sheet, op.addr, op.value)
          return
        case 'clearCell':
          wb.clearCellAt(op.sheet, op.addr)
          return
        case 'setFormula':
          wb.setFormulaAt(op.sheet, op.addr, op.formula)
          return
      }
    },
    async clearColumn(sheet, col) {
      return wb.clear_range(sheet, 0, col, 1_048_575, col)
    },
    async cacheState(sheet, addr) {
      return wb.debug_formula_cache_state(sheet, addr)
    },
    async snapshotPersistence() {
      return wb.snapshot_persistence_v1() as PersistenceSnapshot
    },
    async restoreIntoFresh(snapshot) {
      const fresh = makeWasmEngine()
      fresh.wb.restore_persistence_v1(snapshot)
      return fresh
    },
    dispose() {
      wb.free()
    },
  }
}

// ---------------------------------------------------------------------------
// Comparison helper. Collects ALL mismatches so a failure reports the
// complete divergent address list + seeds in one shot.
// ---------------------------------------------------------------------------
function diffSamples(
  ts: Map<string, SampledCell>,
  wasm: Map<string, SampledCell>,
): string[] {
  const mismatches: string[] = []
  for (const [key, t] of ts) {
    const w = wasm.get(key)
    if (!w) {
      mismatches.push(`${key}: missing from wasm sample`)
      continue
    }
    if (t.display !== w.display || t.isError !== w.isError) {
      mismatches.push(
        `${key}: ts={display:${JSON.stringify(t.display)},isError:${t.isError}} ` +
          `wasm={display:${JSON.stringify(w.display)},isError:${w.isError}}`,
      )
    }
  }
  return mismatches
}

function expectParity(
  ts: Map<string, SampledCell>,
  wasm: Map<string, SampledCell>,
  phase: string,
) {
  const mismatches = diffSamples(ts, wasm)
  if (mismatches.length > 0) {
    throw new Error(
      `${phase}: ${mismatches.length} divergent cells ` +
        `(WORKLOAD_SEED=0x${WORKLOAD_SEED.toString(16)}, EDIT_SEED=0x${EDIT_SEED.toString(16)}):\n` +
        mismatches.join('\n'),
    )
  }
  expect(mismatches).toEqual([])
}

// ---------------------------------------------------------------------------
// Suite. Phases share one imported workbook pair — jest runs the specs in
// declaration order within the file.
// ---------------------------------------------------------------------------
// Gated: ~4.5 min measured (2026-06-12) — see the Discipline note above.
const describeScale = process.env.EINFACH_SCALE ? describe : describe.skip

describeScale('scale parity — one seeded ~75k workload through both worker runtimes', () => {
  const workload = buildWorkload()
  let tsEngine: ReturnType<typeof makeTsEngine>
  let wasmEngine: ReturnType<typeof makeWasmEngine>

  beforeAll(async () => {
    await loadWasmModule()
    tsEngine = makeTsEngine()
    wasmEngine = makeWasmEngine()
    await tsEngine.importWorkload(workload.cells)
    await wasmEngine.importWorkload(workload.cells)
  }, 60_000)

  afterAll(() => {
    wasmEngine?.dispose()
  })

  test(
    'P1 import parity — 500 sampled displays + error flags identical; closed forms; contractual probe states',
    async () => {
      // Contractual cache-probe states FIRST (before any read touches the
      // probe cells). Both backends agree on these three; post-mutation
      // probe semantics are a documented divergence and NOT asserted.
      const { neverRead, literal } = workload.probeRefs
      expect(await tsEngine.cacheState(neverRead.sheet, neverRead.addr)).toBe('dirty')
      expect(await wasmEngine.cacheState(neverRead.sheet, neverRead.addr)).toBe('dirty')
      expect(await tsEngine.cacheState(literal.sheet, literal.addr)).toBe('none')
      expect(await wasmEngine.cacheState(literal.sheet, literal.addr)).toBe('none')

      const tsSamples = await tsEngine.readSamples(workload.sampleRefs)
      const wasmSamples = await wasmEngine.readSamples(workload.sampleRefs)
      expectParity(tsSamples, wasmSamples, 'P1 import parity')

      // Closed form: whole-column SUM over Sheet1 A == JS-computed seed sum.
      const g1 = tsSamples.get('0:G1')
      expect(g1?.display).toBe(String(workload.sheet1ColASum))
      expect(wasmSamples.get('0:G1')?.display).toBe(String(workload.sheet1ColASum))
      // Error cells flagged on both engines.
      for (const addr of ['M1', 'M2', 'M3', 'M4']) {
        expect(tsSamples.get(`0:${addr}`)?.isError).toBe(true)
        expect(wasmSamples.get(`0:${addr}`)?.isError).toBe(true)
      }
      // Spill anchors resolved to non-empty, non-error displays.
      expect(tsSamples.get('0:H1')?.display).toBe('1')
      expect(wasmSamples.get('0:H1')?.display).toBe('1')

      // After a host-facing read, the probed formula reports 'clean' on
      // BOTH engines (still contractual — no mutation in between).
      await tsEngine.readSamples([neverRead])
      await wasmEngine.readSamples([neverRead])
      expect(await tsEngine.cacheState(neverRead.sheet, neverRead.addr)).toBe('clean')
      expect(await wasmEngine.cacheState(neverRead.sheet, neverRead.addr)).toBe('clean')
    },
    30_000,
  )

  test(
    'P2 mutation parity — 200 seeded edits (incl. spill-region writes) → identical re-sample',
    async () => {
      const edits = buildEdits()
      for (const op of edits) {
        await tsEngine.applyEdit(op)
        await wasmEngine.applyEdit(op)
      }
      const tsSamples = await tsEngine.readSamples(workload.sampleRefs)
      const wasmSamples = await wasmEngine.readSamples(workload.sampleRefs)
      expectParity(tsSamples, wasmSamples, 'P2 mutation parity')
    },
    30_000,
  )

  // P3 — structural parity. `worker-runtime-ts.ts` ('insertRows' /
  // 'deleteRows' / 'insertColumns' / 'deleteColumns' cases) explicitly
  // no-ops with `return true` ("Wave E will implement band shifts. For
  // Phase 4, no-op true."). Driving structural ops through both engines
  // would compare a real row shift against a no-op — not a parity signal.
  test.todo(
    'P3 structural parity — BLOCKED: TS runtime stubs insertRows/deleteRows/insertColumns/deleteColumns as no-op `true` (Wave E); enable once band shifts land',
  )

  test('P3 guard — TS structural stubs are still no-ops (flip the todo above when this fails)', async () => {
    // Pin the CURRENT stub shape: the RPC succeeds but moves nothing.
    // When Wave E implements band shifts this spec fails, which is the
    // signal to delete it and implement real P3 structural parity.
    const before = await tsEngine.readSamples([{ sheet: 0, addr: 'A5' }])
    const ok = await tsEngine.rpc({
      cmd: 'insertRows',
      sheet: 0,
      rowIndex: 0,
      count: 3,
    })
    expect(ok).toBe(true)
    const after = await tsEngine.readSamples([{ sheet: 0, addr: 'A5' }])
    expect(after.get('0:A5')).toEqual(before.get('0:A5'))
  })

  test(
    'P4 clearRange parity — full-column clear is sparse (closed-form counter) + identical post-state',
    async () => {
      // Sheet1 column A still holds exactly its seeded cell count: P2 only
      // OVERWROTE numbers there (never added/cleared A-column cells).
      const tsCleared = await tsEngine.clearColumn(0, 0)
      const wasmCleared = await wasmEngine.clearColumn(0, 0)
      expect(tsCleared).toBe(workload.sheet1ColACount)
      expect(wasmCleared).toBe(workload.sheet1ColACount)

      const tsSamples = await tsEngine.readSamples(workload.sampleRefs)
      const wasmSamples = await wasmEngine.readSamples(workload.sampleRefs)
      expectParity(tsSamples, wasmSamples, 'P4 clearRange parity')

      // Closed form after the clear: the whole-column SUM collapses to 0.
      expect(tsSamples.get('0:G1')?.display).toBe('0')
      expect(wasmSamples.get('0:G1')?.display).toBe('0')
    },
    30_000,
  )

  test(
    'P5 restore parity — snapshotPersistenceV1 → fresh runtime → restore on both engines',
    async () => {
      const tsBefore = await tsEngine.readSamples(workload.sampleRefs)
      const wasmBefore = await wasmEngine.readSamples(workload.sampleRefs)

      const tsSnapshot = await tsEngine.snapshotPersistence()
      const wasmSnapshot = await wasmEngine.snapshotPersistence()

      // Snapshot-shape parity (wire level): version + sheet metadata.
      expect(wasmSnapshot.version).toBe(tsSnapshot.version)
      expect(wasmSnapshot.sheets).toEqual(tsSnapshot.sheets)
      // Cell-record parity keyed by sheet:addr → kind:value. Spill-region
      // addresses stay excluded for robustness, though both engines now
      // omit spill projections from snapshots: the TS runtime's
      // `snapshotRangeSparse` serializes only real cells (anchor formula
      // source included) so restore cannot materialize projections, and
      // the Rust engine's spill targets are virtual derived atoms that
      // never serialize. Restored DISPLAYS are asserted equal below.
      const spillKeys = new Set(workload.spillRegionRefs.map(refKey))
      const cellMap = (snapshot: PersistenceSnapshot) => {
        const out = new Map<string, string>()
        for (const cell of snapshot.cells) {
          const key = `${cell.sheet}:${cell.addr}`
          if (spillKeys.has(key)) continue
          out.set(key, `${cell.kind}:${JSON.stringify(cell.value ?? null)}`)
        }
        return out
      }
      expect(cellMap(wasmSnapshot)).toEqual(cellMap(tsSnapshot))

      // Per-engine roundtrip: fresh runtime + restore reproduces the
      // pre-snapshot samples exactly.
      const tsRestored = await tsEngine.restoreIntoFresh(tsSnapshot)
      const wasmRestored = await wasmEngine.restoreIntoFresh(wasmSnapshot)
      try {
        const tsAfter = await tsRestored.readSamples(workload.sampleRefs)
        const wasmAfter = await wasmRestored.readSamples(workload.sampleRefs)
        expectParity(tsAfter, tsBefore, 'P5 TS restore roundtrip (restored vs pre-snapshot)')
        expectParity(wasmAfter, wasmBefore, 'P5 WASM restore roundtrip (restored vs pre-snapshot)')
        // Cross-engine equality of the restored workbooks.
        expectParity(tsAfter, wasmAfter, 'P5 cross-engine restored state')
      } finally {
        wasmRestored.dispose()
      }
    },
    30_000,
  )
})
