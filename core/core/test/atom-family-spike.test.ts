import { describe, test, expect, afterAll, jest } from '@jest/globals'
import { atom, createStore } from '../src'
import type { AtomEntity, Store } from '../src'

jest.setTimeout(600_000)

/**
 * Spike: validate the "getAtomFamily lazy per-cell atom" spreadsheet-state design
 * against the two historical pathologies of the one-big-sheetAtom model:
 *
 *   C-1: every keystroke cloned the whole cell Map (O(N) per write, 107ms @ 1M cells)
 *   C-2: any write re-derived ALL cached formula derives (503ms / 100k derives)
 *
 * The family prototype lives in this file only — core/core/src is untouched.
 * Deterministic count assertions are always-on; wall-time numbers are logged as a
 * markdown table with loose sanity bounds that must never flake.
 *
 * The expensive tiers (1M-cell workloads, 100k chain depth, 1M memory sample) only
 * run when EINFACH_PERF is set, so the default `npm test` run stays fast:
 *
 *   npx jest core/core/test/atom-family-spike.test.ts --no-coverage --runInBand
 *   EINFACH_PERF=1 NODE_OPTIONS='--expose-gc' \
 *     npx jest core/core/test/atom-family-spike.test.ts --no-coverage --runInBand
 */

const itPerf = process.env.EINFACH_PERF ? test : test.skip

// ------------------------------------------------------------------ prototype

interface AtomFamily<Key, State> {
  (key: Key): AtomEntity<State>
  remove: (key: Key) => void
  readonly size: number
}

function getAtomFamily<Key, State>(
  create: (key: Key) => AtomEntity<State>,
): AtomFamily<Key, State> {
  const cache = new Map<Key, AtomEntity<State>>()
  const family = ((key: Key): AtomEntity<State> => {
    let entity = cache.get(key)
    if (entity === undefined) {
      entity = create(key)
      cache.set(key, entity)
    }
    return entity
  }) as AtomFamily<Key, State>
  family.remove = (key: Key) => {
    cache.delete(key)
  }
  Object.defineProperty(family, 'size', { get: () => cache.size })
  return family
}

// -------------------------------------------------------------------- helpers

const now = () => performance.now()

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const fmt = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(1)} µs` : `${ms.toFixed(2)} ms`)

const label = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1_000}k`)

/** `${sheet}:${row}:${col}` — unique for i < 1M */
const keyOf = (i: number) => `S1:${(i / 1000) | 0}:${i % 1000}`

/**
 * Store quirk found while spiking: `store.getter` on a never-seen atom runs
 * setAtomState, which parks the atom in pendingMap — and nothing flushes it
 * until the NEXT setter call. After bulk-materializing N atoms via getter, the
 * first write would otherwise pay a one-time O(N) flush. Drain it explicitly
 * so timed writes start from a clean pendingMap.
 */
function drain(store: Store) {
  store.setter(atom(0), 1)
}

interface Row {
  workload: string
  metric: string
  family: string
  sheetAtom: string
}

const rows: Row[] = []
const findings: string[] = []

afterAll(() => {
  const lines = [
    '',
    `## atom-family spike results (${process.env.EINFACH_PERF ? 'full perf' : 'fast'} run)`,
    '',
    '| workload | metric | family (per-cell atoms) | sheetAtom (one big Map) |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.workload} | ${r.metric} | ${r.family} | ${r.sheetAtom} |`),
  ]
  if (findings.length > 0) {
    lines.push('', '### findings', ...findings.map((f) => `- ${f}`))
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'))
})

// ------------------------------------------------------------------ workloads

describe('atom-family spike (per-cell lazy atoms vs one big sheetAtom)', () => {
  // ---- W1 C-1 twin: single-cell write latency vs sheet size ----------------

  const c1FamMedians = new Map<number, number>()
  const c1OldMedians = new Map<number, number>()

  function runC1Size(n: number) {
    // family model: one primitive atom per cell, created through the family
    const store = createStore()
    const cells = getAtomFamily<string, number>(() => atom(0))
    const tMat0 = now()
    for (let i = 0; i < n; i++) store.getter(cells(keyOf(i)))
    drain(store)
    const matMs = now() - tMat0
    expect(cells.size).toBe(n)

    const famWrites: number[] = []
    for (let w = 0; w < 100; w++) {
      const key = keyOf((w * 9973 + 13) % n)
      const t0 = now()
      store.setter(cells(key), w + 1)
      famWrites.push(now() - t0)
    }
    const famMed = median(famWrites)
    c1FamMedians.set(n, famMed)

    // old model: ONE atom holding a Map of all N cells, write = clone + set
    const store2 = createStore()
    const initial = new Map<string, number>()
    for (let i = 0; i < n; i++) initial.set(keyOf(i), 0)
    const sheetAtom = atom(initial)
    store2.getter(sheetAtom)
    drain(store2)

    const writeCount = n >= 1_000_000 ? 20 : n >= 100_000 ? 50 : 100
    const oldWrites: number[] = []
    for (let w = 0; w < writeCount; w++) {
      const key = keyOf((w * 9973 + 13) % n)
      const t0 = now()
      store2.setter(sheetAtom, (prev) => new Map(prev).set(key, w + 1))
      oldWrites.push(now() - t0)
    }
    const oldMed = median(oldWrites)
    c1OldMedians.set(n, oldMed)

    rows.push({
      workload: 'W1 C-1',
      metric: `single-cell write median @ ${label(n)} cells`,
      family: fmt(famMed),
      sheetAtom: fmt(oldMed),
    })
    if (n === 1_000_000) {
      rows.push({
        workload: 'W1 C-1',
        metric: 'bulk-materialize 1M atoms via getter (+drain)',
        family: fmt(matMs),
        sheetAtom: '—',
      })
    }

    // loose sanity: family write is flat and fast at every sheet size
    expect(famMed).toBeLessThan(50)
  }

  test('W1 C-1 twin: single-cell write latency @ 10k / 100k cells', () => {
    findings.push(
      'store quirk: store.getter on a never-seen atom parks it in pendingMap and nothing ' +
        'flushes it until the NEXT setter call — the first write after a getter-only bulk ' +
        'materialization pays a one-time O(N) flush (drained explicitly in these benchmarks)',
    )
    runC1Size(10_000)
    runC1Size(100_000)
    // old model already grows visibly between 10k and 100k; family stays flat
    expect(c1OldMedians.get(100_000)!).toBeGreaterThan(c1OldMedians.get(10_000)! * 2)
  })

  itPerf('W1 C-1 twin (perf tier): single-cell write latency @ 1M cells', () => {
    runC1Size(1_000_000)
    expect(c1OldMedians.get(1_000_000)!).toBeGreaterThan(c1FamMedians.get(1_000_000)! * 10)
    expect(c1OldMedians.get(1_000_000)!).toBeGreaterThan(c1OldMedians.get(10_000)! * 5)
  })

  // ---- W2 C-2 twin: unrelated-write fanout ----------------------------------

  test('W2 C-2 twin: unrelated-write fanout across 100k cached derives', () => {
    const n = 100_000

    // family model: derive i reads exactly cell i
    const store = createStore()
    const cells = getAtomFamily<number, number>((i) => atom(i))
    let famEvals = 0
    const derives = getAtomFamily<number, number>((i) =>
      atom((get) => {
        famEvals++
        return get(cells(i)) + 1
      }),
    )
    const tMount0 = now()
    for (let i = 0; i < n; i++) store.getter(derives(i))
    drain(store)
    const famMountMs = now() - tMount0
    expect(famEvals).toBe(n) // each derive evaluated exactly once on mount
    expect(derives.size).toBe(n)

    famEvals = 0
    const t0 = now()
    store.setter(cells(77_777), 1_000_123)
    const famMs = now() - t0
    expect(famEvals).toBe(1) // ONLY the derive reading the written cell re-ran
    expect(store.getter(derives(77_777))).toBe(1_000_124)
    expect(store.getter(derives(0))).toBe(1)
    expect(famEvals).toBe(1) // cached reads after the write stay cached

    // old model: every derive reads the one big sheetAtom
    const store2 = createStore()
    const initial = new Map<number, number>()
    for (let i = 0; i < n; i++) initial.set(i, i)
    const sheetAtom = atom(initial)
    let oldEvals = 0
    const derives2 = getAtomFamily<number, number>((i) =>
      atom((get) => {
        oldEvals++
        return (get(sheetAtom).get(i) ?? 0) + 1
      }),
    )
    const tMount1 = now()
    for (let i = 0; i < n; i++) store2.getter(derives2(i))
    drain(store2)
    const oldMountMs = now() - tMount1
    expect(oldEvals).toBe(n)

    oldEvals = 0
    const t1 = now()
    store2.setter(sheetAtom, (prev) => new Map(prev).set(77_777, 1_000_123))
    const oldMs = now() - t1
    expect(oldEvals).toBe(n) // EVERY cached derive re-ran for one unrelated write
    expect(store2.getter(derives2(77_777))).toBe(1_000_124)

    rows.push(
      {
        workload: 'W2 C-2',
        metric: 'extra derive evals after ONE unrelated write',
        family: `${1}`,
        sheetAtom: `${n}`,
      },
      {
        workload: 'W2 C-2',
        metric: 'wall time of that one write',
        family: fmt(famMs),
        sheetAtom: fmt(oldMs),
      },
      {
        workload: 'W2 C-2',
        metric: 'mount 100k derives via getter (+drain)',
        family: fmt(famMountMs),
        sheetAtom: fmt(oldMountMs),
      },
    )

    expect(famMs).toBeLessThan(50)
  })

  // ---- W3 laziness -----------------------------------------------------------

  test('W3 laziness: 1M-cell backing data, 50×27 window creates exactly 1350 atoms', () => {
    const backing = new Map<string, number>()
    for (let r = 0; r < 1000; r++) {
      for (let c = 0; c < 1000; c++) backing.set(`S1:${r}:${c}`, r * 1000 + c)
    }

    const store = createStore()
    const cells = getAtomFamily<string, number>((key) => atom(backing.get(key) ?? 0))

    const t0 = now()
    let checksum = 0
    for (let r = 0; r < 50; r++) {
      for (let c = 0; c < 27; c++) checksum += store.getter(cells(`S1:${r}:${c}`))
    }
    const readMs = now() - t0

    expect(cells.size).toBe(1350) // bulk import created ZERO atoms; window created 50×27
    expect(checksum).toBe(33_092_550)
    expect(store.getter(cells('S1:49:26'))).toBe(49_026)
    expect(readMs).toBeLessThan(50)

    rows.push({
      workload: 'W3 laziness',
      metric: 'atoms after importing 1M cells + reading 50×27 window',
      family: `1350 atoms, window read ${fmt(readMs)}`,
      sheetAtom: '—',
    })
  })

  // ---- W4 chain depth ----------------------------------------------------------

  const buildChain = () => {
    const chain: AtomFamily<number, number> = getAtomFamily((i: number) =>
      i === 0 ? atom(0) : atom((get) => get(chain(i - 1)) + 1),
    )
    return chain
  }
  const swallowRangeError = (error: unknown) => {
    if (!(error instanceof RangeError)) throw error
  }

  /** cold pull of the tail: readAtom → read fn → getter → readAtom … recursion */
  const coldRead = (depth: number): number | undefined => {
    const store = createStore()
    const chain = buildChain()
    try {
      const t0 = now()
      const value = store.getter(chain(depth - 1))
      const ms = now() - t0
      expect(value).toBe(depth - 1)
      return ms
    } catch (error) {
      swallowRangeError(error)
      return undefined
    }
  }

  /**
   * head-write propagation measured independently of cold-read limits: the
   * chain is materialized ITERATIVELY (each getter is shallow because its
   * dependency is already cached), then one head write drives the recursive
   * dependenciesChange walk through every level.
   */
  const headWrite = (depth: number): number | undefined => {
    const store = createStore()
    const chain = buildChain()
    for (let i = 0; i < depth; i++) store.getter(chain(i))
    drain(store)
    try {
      const t0 = now()
      store.setter(chain(0), 1)
      const ms = now() - t0
      expect(store.getter(chain(depth - 1))).toBe(depth)
      return ms
    } catch (error) {
      swallowRangeError(error)
      return undefined
    }
  }

  function measureChainDepth(depth: number) {
    const coldMs = coldRead(depth)
    const writeMs = headWrite(depth)

    if (coldMs === undefined) {
      findings.push(
        `W4: stack overflow at depth ${label(depth)} on COLD READ (readAtom recursive ` +
          'pull) — validates the plan requirement for an iterative store',
      )
    }
    if (writeMs === undefined) {
      findings.push(
        `W4: stack overflow at depth ${label(depth)} on HEAD WRITE (dependenciesChange ` +
          'recursion) — validates the iterative-store requirement',
      )
    }

    const coldLabel = coldMs !== undefined ? fmt(coldMs) : 'stack overflow'
    const writeLabel = writeMs !== undefined ? fmt(writeMs) : 'stack overflow'
    rows.push({
      workload: 'W4 chain',
      metric: `depth ${label(depth)}: cold tail read / head write`,
      family: `${coldLabel} / ${writeLabel}`,
      sheetAtom: '—',
    })
    return { coldMs, writeMs }
  }

  test('W4 chain depth: cold pull and head-write propagation are recursive', () => {
    const { coldMs, writeMs } = measureChainDepth(1_000)
    // shallow chains must work; deeper depths are reported as findings, not failures
    expect(coldMs).toBeDefined()
    expect(writeMs).toBeDefined()
    measureChainDepth(10_000)

    // probe the actual recursion limits (indicative — stack budget varies per env)
    const findLimit = (works: (depth: number) => boolean): number => {
      let lo = 1_000
      let hi = 2_000
      while (works(hi)) {
        lo = hi
        hi *= 2
        if (hi > 400_000) return lo
      }
      while (hi - lo > 250) {
        const mid = Math.round((lo + hi) / 2)
        if (works(mid)) lo = mid
        else hi = mid
      }
      return lo
    }
    const coldLimit = findLimit((depth) => coldRead(depth) !== undefined)
    const writeLimit = findLimit((depth) => headWrite(depth) !== undefined)
    rows.push({
      workload: 'W4 chain',
      metric: 'max working depth before RangeError (cold read / head write)',
      family: `≈${coldLimit} / ≈${writeLimit} links`,
      sheetAtom: '—',
    })
    findings.push(
      `W4: recursion limits under jest defaults — cold pull ≈${coldLimit} links, ` +
        `head-write propagation ≈${writeLimit} links; deeper chains need an iterative store`,
    )
  })

  itPerf('W4 chain depth (perf tier): depth 100k', () => {
    measureChainDepth(100_000)
  })

  // ---- W5 fanout ---------------------------------------------------------------

  test('W5 fanout: one source cell feeding 10k derives', () => {
    const store = createStore()
    const source = atom(0)
    let evals = 0
    const derives = getAtomFamily<number, number>((i) =>
      atom((get) => {
        evals++
        return get(source) + i
      }),
    )
    const n = 10_000
    for (let i = 0; i < n; i++) store.getter(derives(i))
    drain(store)
    expect(evals).toBe(n)

    evals = 0
    const t0 = now()
    store.setter(source, 5)
    const flushMs = now() - t0
    expect(evals).toBe(n) // all 10k re-derive — correct, they all depend on source
    expect(store.getter(derives(9_999))).toBe(10_004)
    expect(flushMs).toBeLessThan(500)

    rows.push({
      workload: 'W5 fanout',
      metric: 'write 1 source → 10k dependent derives re-run',
      family: `${fmt(flushMs)} (${((flushMs * 1000) / n).toFixed(2)} µs/derive)`,
      sheetAtom: '—',
    })
  })

  // ---- W6 range Tier-A -----------------------------------------------------------

  test('W6 range Tier-A: one SUM derive over 256 member atoms', () => {
    const store = createStore()
    const members = getAtomFamily<number, number | null>((i) =>
      atom<number | null>(i < 128 ? i : null),
    )
    let sumEvals = 0
    const sumAtom = atom((get) => {
      sumEvals++
      let total = 0
      for (let i = 0; i < 256; i++) {
        const value = get(members(i))
        if (value !== null) total += value
      }
      return total
    })

    let fires = 0
    store.sub(sumAtom, () => fires++)
    expect(sumEvals).toBe(1)
    expect(store.getter(sumAtom)).toBe(8_128) // 0+1+…+127
    expect(members.size).toBe(256)

    // write a previously-EMPTY member: SUM re-derives exactly once and sees it
    sumEvals = 0
    store.setter(members(200), 5)
    expect(sumEvals).toBe(1)
    expect(store.getter(sumAtom)).toBe(8_133)
    expect(fires).toBe(1)

    // 100 writes to different members: exactly 100 re-derives, O(members) each
    sumEvals = 0
    fires = 0
    const t0 = now()
    for (let w = 0; w < 100; w++) store.setter(members(w), 1_000 + w)
    const totalMs = now() - t0
    expect(sumEvals).toBe(100)
    expect(fires).toBe(100)
    expect(store.getter(sumAtom)).toBe(108_133)

    rows.push({
      workload: 'W6 range',
      metric: 'SUM(256 members): per-write cost (validate + re-derive O(256))',
      family: `${((totalMs * 1000) / 100).toFixed(1)} µs/write`,
      sheetAtom: '—',
    })
  })

  // ---- W7 multi-sheet ----------------------------------------------------------

  test('W7 multi-sheet: cross-sheet derive, sheet2 atoms created lazily', () => {
    const store = createStore()
    const created: string[] = []
    const cells: AtomFamily<string, number> = getAtomFamily((key: string) => {
      created.push(key)
      if (key === 'Sheet2:0:1') return atom((get) => get(cells('Sheet1:0:0')) * 2)
      return atom(0)
    })

    store.setter(cells('Sheet1:0:0'), 21)
    expect(created).toEqual(['Sheet1:0:0']) // no Sheet2 atom exists yet
    expect(created.some((key) => key.startsWith('Sheet2'))).toBe(false)

    let fires = 0
    store.sub(cells('Sheet2:0:1'), () => fires++)
    expect(store.getter(cells('Sheet2:0:1'))).toBe(42)
    expect(created).toEqual(['Sheet1:0:0', 'Sheet2:0:1']) // created on first reference

    const t0 = now()
    store.setter(cells('Sheet1:0:0'), 10)
    const writeMs = now() - t0
    expect(store.getter(cells('Sheet2:0:1'))).toBe(20)
    expect(fires).toBe(1) // listener fired exactly once

    rows.push({
      workload: 'W7 multi-sheet',
      metric: 'Sheet1!A1 write → Sheet2!B1 derive update (1 listener fire)',
      family: fmt(writeMs),
      sheetAtom: '—',
    })
  })

  // ---- W8 memory ---------------------------------------------------------------

  function runMemory(n: number) {
    const gcFn = (globalThis as { gc?: () => void }).gc
    const store = createStore()
    const cells = getAtomFamily<number, number>((i) => atom(i))
    gcFn?.()
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < n; i++) store.getter(cells(i))
    drain(store)
    gcFn?.()
    const after = process.memoryUsage().heapUsed
    const perAtom = (after - before) / n
    expect(cells.size).toBe(n)

    rows.push({
      workload: 'W8 memory',
      metric: `heap per materialized atom @ ${label(n)}${gcFn ? '' : ' (approx)'}`,
      family: `${perAtom.toFixed(0)} B/atom (${((after - before) / 1_048_576).toFixed(1)} MB)`,
      sheetAtom: '—',
    })
  }

  test('W8 memory: heap delta per materialized primitive atom @ 100k (rough)', () => {
    if ((globalThis as { gc?: () => void }).gc === undefined) {
      findings.push(
        'W8: global.gc unavailable — bytes/atom is approximate; rerun with ' +
          "NODE_OPTIONS='--expose-gc' for exact numbers",
      )
    }
    runMemory(100_000)
  })

  itPerf('W8 memory (perf tier): heap delta per materialized primitive atom @ 1M', () => {
    runMemory(1_000_000)
  })
})
