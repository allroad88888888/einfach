import { createSignal } from 'solid-js'
import { sparseRangeToTSV } from './range-tsv'
import { createSheetStore, type SheetStore } from './sheet-store'
import { createWasmWorkbook, type WasmWorkbookApi } from './wasm-sheet'
import type { CellValue, ISheet, SparseCellSnapshot } from './types'
import {
  createWorkerWorkbook,
  type CellRefWire,
  type CellSnapshotWire,
  type CellWire,
  type SparseCellWire,
  type SparseRangeWire,
  type WorkerLike,
  type WorkerWorkbookClient,
} from './wasm-workbook-proxy'

interface WorkbookSheetAdapter extends ISheet {
  notifySubscribers(): void
}

interface WorkerWorkbookSheetAdapter extends ISheet {
  applyHydrated(cells: CellSnapshotWire[]): void
}

export interface WorkbookSheetMeta {
  idx: number
  name: string
}

export interface WasmWorkbookStore {
  sheets: () => WorkbookSheetMeta[]
  activeIdx: () => number
  revision: () => number
  setActiveIdx: (idx: number) => void
  activeStore: () => SheetStore
  sheetAt: (idx: number) => SheetStore | undefined
  formulaCacheState: (sheetIdx: number, addr: string) => string
  dispose: () => void
}

export interface WorkerWorkbookStoreOptions {
  client?: WorkerWorkbookClient
  workerFactory?: () => WorkerLike
  sheets?: string[]
  afterInit?: (client: WorkerWorkbookClient, sheets: WorkbookSheetMeta[]) => Promise<void> | void
}

type CachedWorkbookCell = {
  display: string
  type: CellValue['type']
  isError: boolean
  formula: string
}

const EMPTY_WORKBOOK_CELL: CachedWorkbookCell = {
  display: '',
  type: 'null',
  isError: false,
  formula: '',
}

export async function createWorkerWorkbookStore(
  opts: WorkerWorkbookStoreOptions,
): Promise<WasmWorkbookStore> {
  const client =
    opts.client ??
    (opts.workerFactory ? createWorkerWorkbook({ workerFactory: opts.workerFactory }) : null)

  if (!client) {
    throw new Error('createWorkerWorkbookStore requires client or workerFactory')
  }

  const workerClient: WorkerWorkbookClient = client

  const sheetMetas = await workerClient.initWorkbook(opts.sheets ?? ['Sheet1'])
  await opts.afterInit?.(workerClient, sheetMetas)
  const [activeIdx, setActiveIdxRaw] = createSignal(0)
  const [version, setVersion] = createSignal(0)
  const adapters = new Map<number, WorkerWorkbookSheetAdapter>()
  const stores = new Map<number, SheetStore>()
  const formulaStateCache = new Map<string, string>()
  const formulaStatePending = new Set<string>()
  let disposed = false

  const bumpRevision = () => setVersion((v) => v + 1)

  function formulaStateKey(sheetIdx: number, addr: string): string {
    return `${sheetIdx}:${addr.toUpperCase()}`
  }

  function invalidateFormulaStates(cells: CellRefWire[]) {
    let touched = false
    for (const cell of cells) {
      const key = formulaStateKey(cell.sheet, cell.addr)
      if (formulaStateCache.get(key) === 'dirty') continue
      formulaStateCache.set(key, 'dirty')
      touched = true
    }
    if (touched) bumpRevision()
  }

  function formulaCacheState(sheetIdx: number, addr: string): string {
    version()
    const key = formulaStateKey(sheetIdx, addr)
    const cached = formulaStateCache.get(key) ?? 'unknown'
    if (!formulaStatePending.has(key)) {
      formulaStatePending.add(key)
      void workerClient
        .debugFormulaCacheState(sheetIdx, addr.toUpperCase())
        .then((state) => {
          if (disposed) return
          if (formulaStateCache.get(key) !== state) {
            formulaStateCache.set(key, state)
            bumpRevision()
          }
        })
        .catch(() => {
          if (disposed) return
          if (!formulaStateCache.has(key)) formulaStateCache.set(key, 'unknown')
        })
        .finally(() => formulaStatePending.delete(key))
    }
    return cached
  }

  for (const meta of sheetMetas) {
    const adapter = createWorkerWorkbookSheetAdapter(workerClient, meta.idx, bumpRevision)
    adapters.set(meta.idx, adapter)
    stores.set(meta.idx, createSheetStore(adapter))
  }

  const offHydrated = workerClient.onCellsHydrated((cells) => {
    const bySheet = new Map<number, CellSnapshotWire[]>()
    for (const cell of cells) {
      const group = bySheet.get(cell.sheet) ?? []
      group.push(cell)
      bySheet.set(cell.sheet, group)
    }
    for (const [sheetIdx, group] of bySheet) {
      adapters.get(sheetIdx)?.applyHydrated(group)
    }
  })
  const offDirty = workerClient.onCellsDirty(invalidateFormulaStates)

  function setActiveIdx(idx: number) {
    if (!stores.has(idx)) return
    setActiveIdxRaw(idx)
  }

  function activeStore(): SheetStore {
    version()
    const store = stores.get(activeIdx()) ?? stores.values().next().value
    if (!store) throw new Error('worker workbook has no sheets')
    return store
  }

  return {
    sheets: () => {
      version()
      return sheetMetas.map((sheet) => ({ idx: sheet.idx, name: sheet.name }))
    },
    activeIdx,
    revision: version,
    setActiveIdx,
    activeStore,
    sheetAt: (idx) => stores.get(idx),
    formulaCacheState,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const store of stores.values()) store.dispose()
      offHydrated()
      offDirty()
      formulaStateCache.clear()
      formulaStatePending.clear()
      workerClient.dispose()
      bumpRevision()
    },
  }
}

export async function createThreeSheetChainWorkbookStore(): Promise<WasmWorkbookStore> {
  const workbook = await createWasmWorkbook()
  workbook.add_sheet('Sheet2')
  workbook.add_sheet('Sheet3')

  const adapters: WorkbookSheetAdapter[] = []
  const stores: SheetStore[] = []
  const [activeIdx, setActiveIdxRaw] = createSignal(0)
  const [version, setVersion] = createSignal(0)

  const notifyAll = () => {
    for (const adapter of adapters) adapter.notifySubscribers()
    setVersion((v) => v + 1)
  }

  for (let idx = 0; idx < workbook.sheet_count(); idx++) {
    const adapter = createWorkbookSheetAdapter(workbook, idx, notifyAll)
    adapters.push(adapter)
    stores.push(createSheetStore(adapter))
  }

  function setActiveIdx(idx: number) {
    if (idx < 0 || idx >= stores.length) return
    setActiveIdxRaw(idx)
  }

  function sheets(): WorkbookSheetMeta[] {
    version()
    return stores.map((_, idx) => ({ idx, name: workbook.sheet_name(idx) }))
  }

  function activeStore(): SheetStore {
    version()
    return stores[activeIdx()]
  }

  return {
    sheets,
    activeIdx,
    revision: version,
    setActiveIdx,
    activeStore,
    sheetAt: (idx) => stores[idx],
    formulaCacheState: (sheetIdx, addr) => {
      version()
      return workbook.debug_formula_cache_state(sheetIdx, addr)
    },
    dispose: () => {
      for (const store of stores) store.dispose()
      setVersion((v) => v + 1)
    },
  }
}

function createWorkbookSheetAdapter(
  workbook: WasmWorkbookApi,
  sheetIdx: number,
  notifyAll: () => void,
): WorkbookSheetAdapter {
  const listeners = new Map<number, () => void>()
  let nextToken = 0

  function mutate(write: () => void) {
    write()
    notifyAll()
  }

  function notifySubscribers() {
    const snapshot = [...listeners.values()]
    for (const callback of snapshot) callback()
  }

  function readWithLazyProbe(addr: string, read: () => string): string {
    const isLazyDemoCell = sheetIdx === 1 && addr.toUpperCase() === 'C5'
    if (!isLazyDemoCell) return read()

    const before = workbook.debug_formula_cache_state(sheetIdx, addr)
    const value = read()
    const after = workbook.debug_formula_cache_state(sheetIdx, addr)
    if (before !== 'clean' && after === 'clean') {
      console.log('[lazy-demo] computed Sheet2!C5', { before, after, value })
    }
    return value
  }

  return {
    set_number(addr, value) {
      mutate(() => workbook.set_number(sheetIdx, addr, value))
    },
    set_text(addr, value) {
      mutate(() => workbook.set_text(sheetIdx, addr, value))
    },
    set_boolean(addr, value) {
      mutate(() => workbook.set_boolean(sheetIdx, addr, value))
    },
    set_error(addr, value) {
      mutate(() => workbook.set_error(sheetIdx, addr, value))
    },
    set_formula(addr, formula) {
      let ok = false
      mutate(() => {
        ok = workbook.set_formula(sheetIdx, addr, formula)
      })
      return ok
    },
    clear_cell(addr) {
      mutate(() => workbook.clear_cell(sheetIdx, addr))
    },
    clear_range(startRow, startCol, endRow, endCol) {
      let cleared = 0
      mutate(() => {
        cleared = workbook.clear_range(sheetIdx, startRow, startCol, endRow, endCol)
      })
      return cleared
    },
    snapshot_range_sparse(startRow, startCol, endRow, endCol) {
      return workbook
        .snapshot_range_sparse(sheetIdx, startRow, startCol, endRow, endCol)
        .map(({ sheet: _sheet, ...cell }) => cell)
    },
    export_range_tsv(startRow, startCol, endRow, endCol) {
      const cells = workbook
        .snapshot_range_sparse(sheetIdx, startRow, startCol, endRow, endCol)
        .map(({ sheet: _sheet, ...cell }) => cell)
      return sparseRangeToTSV(cells, { startRow, startCol, endRow, endCol })
    },
    restore_sparse(cells) {
      let restored = 0
      mutate(() => {
        restored = workbook.restore_sparse(cells.map((cell) => ({ sheet: sheetIdx, ...cell })))
      })
      return restored
    },
    insert_row(at, count) {
      mutate(() => workbook.insert_row(sheetIdx, at, count))
    },
    delete_row(at, count) {
      mutate(() => workbook.delete_row(sheetIdx, at, count))
    },
    insert_col(at, count) {
      mutate(() => workbook.insert_col(sheetIdx, at, count))
    },
    delete_col(at, count) {
      mutate(() => workbook.delete_col(sheetIdx, at, count))
    },
    get_display: (addr) => readWithLazyProbe(addr, () => workbook.get_display(sheetIdx, addr)),
    get_number: (addr) => workbook.get_number(sheetIdx, addr),
    get_type: (addr) => workbook.get_type(sheetIdx, addr),
    is_error: (addr) => workbook.is_error(sheetIdx, addr),
    get_formula: (addr) => workbook.get_formula(sheetIdx, addr),
    subscribe(_addr, callback) {
      const token = nextToken++
      listeners.set(token, callback)
      return token
    },
    unsubscribe(token) {
      listeners.delete(token)
    },
    notifySubscribers,
  }
}

function createWorkerWorkbookSheetAdapter(
  client: WorkerWorkbookClient,
  sheetIdx: number,
  notifyRevision: () => void,
): WorkerWorkbookSheetAdapter {
  const cache = new Map<string, CachedWorkbookCell>()
  const requested = new Set<string>()
  const pendingReads = new Map<string, number>()
  const hydrateVersions = new Map<string, number>()
  const localVersions = new Map<string, number>()
  const listenersByAddr = new Map<string, Map<number, () => void>>()
  const tokenToAddr = new Map<number, string>()
  const workerSubs = new Map<
    string,
    { refCount: number; subId?: number; promise?: Promise<number> }
  >()
  let nextToken = 1
  let nextLocalVersion = 1
  let disposed = false

  function normalizeAddr(addr: string): string {
    return addr.toUpperCase()
  }

  function readCache(addr: string): CachedWorkbookCell {
    return cache.get(normalizeAddr(addr)) ?? EMPTY_WORKBOOK_CELL
  }

  function writeCache(addr: string, patch: Partial<CachedWorkbookCell>) {
    const a = normalizeAddr(addr)
    const cur = cache.get(a) ?? EMPTY_WORKBOOK_CELL
    cache.set(a, { ...cur, ...patch })
  }

  function fireListeners(addr: string) {
    const listeners = listenersByAddr.get(normalizeAddr(addr))
    if (!listeners) return
    for (const callback of listeners.values()) callback()
  }

  function hasListeners(addr: string): boolean {
    return (listenersByAddr.get(normalizeAddr(addr))?.size ?? 0) > 0
  }

  function currentLocalVersion(addr: string): number {
    return localVersions.get(normalizeAddr(addr)) ?? 0
  }

  function bumpLocalVersion(addr: string): number {
    const a = normalizeAddr(addr)
    const version = nextLocalVersion++
    localVersions.set(a, version)
    return version
  }

  function hydrateRefs(refs: CellRefWire[]) {
    if (disposed) return
    const cells: CellRefWire[] = []
    const requestVersions = new Map<string, number>()
    for (const ref of refs) {
      if (ref.sheet !== sheetIdx) continue
      const addr = normalizeAddr(ref.addr)
      const version = currentLocalVersion(addr)
      const pendingVersion = pendingReads.get(addr)
      if (pendingVersion !== undefined && pendingVersion >= version) continue
      pendingReads.set(addr, version)
      hydrateVersions.set(addr, version)
      requestVersions.set(addr, version)
      cells.push({ sheet: sheetIdx, addr })
    }
    if (cells.length === 0) return

    void client
      .readCells(cells)
      .then((snapshots) => applyHydrated(snapshots, requestVersions))
      .catch(() => {
        for (const cell of cells) {
          if (pendingReads.get(cell.addr) === requestVersions.get(cell.addr)) {
            pendingReads.delete(cell.addr)
          }
        }
      })
  }

  function hydrateAddr(addr: string) {
    hydrateRefs([{ sheet: sheetIdx, addr: normalizeAddr(addr) }])
  }

  function ensureHydration(addr: string) {
    const a = normalizeAddr(addr)
    if (requested.has(a)) return
    requested.add(a)
    hydrateAddr(a)
  }

  function applyHydrated(cells: CellSnapshotWire[], requestVersions?: Map<string, number>) {
    let touched = false
    for (const cell of cells) {
      if (cell.sheet !== sheetIdx) continue
      const addr = normalizeAddr(cell.addr)
      const hydrateVersion = requestVersions?.get(addr) ?? hydrateVersions.get(addr) ?? 0
      if (pendingReads.get(addr) === hydrateVersion) pendingReads.delete(addr)
      if (currentLocalVersion(addr) > hydrateVersion) continue
      requested.add(addr)
      cache.set(addr, {
        display: cell.display,
        type: cell.type,
        isError: cell.isError,
        formula: cell.formula,
      })
      fireListeners(addr)
      touched = true
    }
    if (touched) notifyRevision()
  }

  function optimisticCell(value: CellWire): CachedWorkbookCell {
    switch (value.type) {
      case 'number':
        return {
          display: String(value.value),
          type: 'number',
          isError: false,
          formula: '',
        }
      case 'text':
        return {
          display: value.value,
          type: value.value === '' ? 'null' : 'text',
          isError: false,
          formula: '',
        }
      case 'boolean':
        return {
          display: value.value ? 'TRUE' : 'FALSE',
          type: 'boolean',
          isError: false,
          formula: '',
        }
      case 'error':
        return {
          display: value.value,
          type: 'error',
          isError: true,
          formula: '',
        }
      case 'null':
        return EMPTY_WORKBOOK_CELL
    }
  }

  function setCell(addr: string, value: CellWire) {
    const a = normalizeAddr(addr)
    requested.add(a)
    bumpLocalVersion(a)
    cache.set(a, optimisticCell(value))
    void client
      .setCell(sheetIdx, a, value)
      .then((ok) => {
        if (hasListeners(a) || !ok) hydrateAddr(a)
      })
      .catch(() => hydrateAddr(a))
  }

  function setFormula(addr: string, formula: string): Promise<boolean> {
    const a = normalizeAddr(addr)
    requested.add(a)
    bumpLocalVersion(a)
    writeCache(a, { display: '', type: 'null', isError: false, formula })
    return client
      .setFormula(sheetIdx, a, formula)
      .then((ok) => {
        if (hasListeners(a) || !ok) hydrateAddr(a)
        return ok
      })
      .catch(() => {
        hydrateAddr(a)
        return false
      })
  }

  function startWorkerSubscription(addr: string) {
    const a = normalizeAddr(addr)
    const existing = workerSubs.get(a)
    if (existing) {
      existing.refCount += 1
      return
    }

    requested.add(a)
    const entry = { refCount: 1 } as {
      refCount: number
      subId?: number
      promise?: Promise<number>
    }
    workerSubs.set(a, entry)
    hydrateVersions.set(a, currentLocalVersion(a))
    entry.promise = client
      .subscribeCells([{ sheet: sheetIdx, addr: a }], (cells) => hydrateRefs(cells))
      .then((subId) => {
        if (!workerSubs.has(a) || entry.refCount <= 0) {
          void client.unsubscribeCells(subId).catch(() => {})
          return subId
        }
        entry.subId = subId
        return subId
      })
      .catch(() => {
        if (workerSubs.get(a) === entry) workerSubs.delete(a)
        return -1
      })
  }

  function stopWorkerSubscription(addr: string) {
    const a = normalizeAddr(addr)
    const entry = workerSubs.get(a)
    if (!entry) return
    entry.refCount -= 1
    if (entry.refCount > 0) return
    workerSubs.delete(a)
    if (entry.subId !== undefined) {
      void client.unsubscribeCells(entry.subId).catch(() => {})
      return
    }
    void entry.promise
      ?.then((subId) => {
        if (subId > 0) return client.unsubscribeCells(subId)
        return false
      })
      .catch(() => {})
  }

  function activeListenerAddrs(): string[] {
    return [...listenersByAddr.keys()]
  }

  function invalidateCachedStateForRemoteMutation(): string[] {
    const visibleAddrs = activeListenerAddrs()
    for (const addr of visibleAddrs) bumpLocalVersion(addr)
    cache.clear()
    requested.clear()
    for (const addr of visibleAddrs) fireListeners(addr)
    notifyRevision()
    return visibleAddrs
  }

  function hydrateVisibleAddrs(visibleAddrs: string[]) {
    hydrateRefs(visibleAddrs.map((addr) => ({ sheet: sheetIdx, addr })))
  }

  function toLocalSparseCell(cell: SparseCellWire): SparseCellSnapshot | null {
    if (cell.sheet !== sheetIdx) return null
    const { sheet: _sheet, ...local } = cell
    return local as SparseCellSnapshot
  }

  function toWireSparseCell(cell: SparseCellSnapshot): SparseCellWire {
    return { sheet: sheetIdx, ...cell } as SparseCellWire
  }

  function unsubscribeToken(token: number) {
    const addr = tokenToAddr.get(token)
    if (!addr) return
    tokenToAddr.delete(token)
    const listeners = listenersByAddr.get(addr)
    if (!listeners) return
    listeners.delete(token)
    if (listeners.size === 0) {
      listenersByAddr.delete(addr)
      stopWorkerSubscription(addr)
    }
  }

  return {
    set_number(addr, value) {
      setCell(addr, { type: 'number', value })
    },
    set_text(addr, value) {
      setCell(addr, { type: 'text', value })
    },
    set_boolean(addr, value) {
      setCell(addr, { type: 'boolean', value })
    },
    set_error(addr, value) {
      setCell(addr, { type: 'error', value })
    },
    set_formula(addr, formula) {
      void setFormula(addr, formula)
      return true
    },
    set_formula_async(addr, formula) {
      return setFormula(addr, formula)
    },
    clear_cell(addr) {
      setCell(addr, { type: 'null' })
    },
    clear_range(startRow, startCol, endRow, endCol) {
      const visibleAddrs = invalidateCachedStateForRemoteMutation()
      const range: SparseRangeWire = {
        sheet: sheetIdx,
        startRow,
        startCol,
        endRow,
        endCol,
      }
      return client
        .clearRange(range)
        .then((count) => {
          hydrateVisibleAddrs(visibleAddrs)
          return count
        })
        .catch((err) => {
          hydrateVisibleAddrs(visibleAddrs)
          throw err
        })
    },
    snapshot_range_sparse(startRow, startCol, endRow, endCol) {
      const range: SparseRangeWire = {
        sheet: sheetIdx,
        startRow,
        startCol,
        endRow,
        endCol,
      }
      return client.snapshotRangeSparse(range).then((cells) => {
        const out: SparseCellSnapshot[] = []
        for (const cell of cells) {
          const local = toLocalSparseCell(cell)
          if (local) out.push(local)
        }
        return out
      })
    },
    export_range_tsv(startRow, startCol, endRow, endCol) {
      return client.exportRangeTsv({ sheet: sheetIdx, startRow, startCol, endRow, endCol })
    },
    restore_sparse(cells) {
      const visibleAddrs = invalidateCachedStateForRemoteMutation()
      return client
        .restoreSparse(cells.map(toWireSparseCell))
        .then((count) => {
          hydrateVisibleAddrs(visibleAddrs)
          return count
        })
        .catch((err) => {
          hydrateVisibleAddrs(visibleAddrs)
          throw err
        })
    },
    get_display(addr) {
      ensureHydration(addr)
      return readCache(addr).display
    },
    get_number(addr) {
      ensureHydration(addr)
      const cell = readCache(addr)
      if (cell.type !== 'number') return 0
      const value = Number(cell.display)
      return Number.isFinite(value) ? value : 0
    },
    get_type(addr) {
      ensureHydration(addr)
      return readCache(addr).type
    },
    is_error(addr) {
      ensureHydration(addr)
      return readCache(addr).isError
    },
    get_formula(addr) {
      ensureHydration(addr)
      return readCache(addr).formula
    },
    subscribe(addr, callback) {
      const a = normalizeAddr(addr)
      const token = nextToken++
      let listeners = listenersByAddr.get(a)
      if (!listeners) {
        listeners = new Map()
        listenersByAddr.set(a, listeners)
        startWorkerSubscription(a)
      }
      listeners.set(token, callback)
      tokenToAddr.set(token, a)
      return token
    },
    unsubscribe(token) {
      unsubscribeToken(token)
    },
    applyHydrated,
    dispose() {
      if (disposed) return
      disposed = true
      for (const token of [...tokenToAddr.keys()]) unsubscribeToken(token)
      cache.clear()
      requested.clear()
      pendingReads.clear()
      hydrateVersions.clear()
      localVersions.clear()
      listenersByAddr.clear()
      tokenToAddr.clear()
      workerSubs.clear()
    },
  }
}
