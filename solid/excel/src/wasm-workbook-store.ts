import { createSignal } from 'solid-js'
import { createSheetStore, type SheetStore } from './sheet-store'
import { createWasmWorkbook, type WasmWorkbookApi } from './wasm-sheet'
import type { ISheet } from './types'

interface WorkbookSheetAdapter extends ISheet {
  notifySubscribers(): void
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
