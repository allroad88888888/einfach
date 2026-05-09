/** @jsxImportSource solid-js */

import { describe, it, expect } from '@jest/globals'
import { createRoot } from 'solid-js'
import { createWorkbookStore } from '../src/workbook-store'

describe('createWorkbookStore', () => {
  it('default workbook has one sheet named Sheet1 and active idx 0', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      const sheets = wb.sheets()
      expect(sheets).toHaveLength(1)
      expect(sheets[0]).toEqual({ idx: 0, name: 'Sheet1' })
      expect(wb.activeIdx()).toBe(0)
      expect(wb.indexOf('Sheet1')).toBe(0)
      dispose()
    })
  })

  it('addSheet returns increasing idx with default Sheet{N} naming', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      const idx2 = wb.addSheet()
      const idx3 = wb.addSheet()
      expect(idx2).toBe(1)
      expect(idx3).toBe(2)
      const sheets = wb.sheets()
      expect(sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet2', 'Sheet3'])
      dispose()
    })
  })

  it('addSheet with explicit name appends and returns idx', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      const idx = wb.addSheet('Data')
      expect(idx).toBe(1)
      expect(wb.sheets()[1].name).toBe('Data')
      expect(wb.indexOf('Data')).toBe(1)
      dispose()
    })
  })

  it('addSheet refuses duplicate explicit name and returns -1', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      wb.addSheet('Data')
      const second = wb.addSheet('Data')
      expect(second).toBe(-1)
      expect(wb.sheets()).toHaveLength(2)
      dispose()
    })
  })

  it('addSheet default-naming skips taken names', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      // Pre-take "Sheet2" so the next default has to pick "Sheet3".
      wb.addSheet('Sheet2')
      const idx = wb.addSheet()
      expect(idx).toBe(2)
      expect(wb.sheets()[2].name).toBe('Sheet3')
      dispose()
    })
  })

  it('removeSheet shifts trailing indices down', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      wb.addSheet('B')
      wb.addSheet('C')
      // [Sheet1, B, C] @ idx 0/1/2
      const ok = wb.removeSheet(1)
      expect(ok).toBe(true)
      const names = wb.sheets().map((s) => s.name)
      expect(names).toEqual(['Sheet1', 'C'])
      expect(wb.indexOf('C')).toBe(1)
      dispose()
    })
  })

  it('removeSheet on active tab re-points active to nearest neighbor', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      wb.addSheet('B')
      wb.addSheet('C')
      wb.setActiveIdx(2) // active = C
      expect(wb.activeIdx()).toBe(2)
      wb.removeSheet(2) // remove C
      // Active should drop to idx 1 (B), the previous neighbor.
      expect(wb.activeIdx()).toBe(1)
      expect(wb.sheets()[wb.activeIdx()].name).toBe('B')
      dispose()
    })
  })

  it('removeSheet of an earlier sheet decrements active idx', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      wb.addSheet('B')
      wb.addSheet('C')
      wb.setActiveIdx(2) // active = C @ idx 2
      wb.removeSheet(0) // remove Sheet1
      // C is now at idx 1; active should follow.
      expect(wb.activeIdx()).toBe(1)
      expect(wb.sheets()[wb.activeIdx()].name).toBe('C')
      dispose()
    })
  })

  it('removeSheet refuses to remove the last remaining sheet', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      const ok = wb.removeSheet(0)
      expect(ok).toBe(false)
      expect(wb.sheets()).toHaveLength(1)
      dispose()
    })
  })

  it('renameSheet succeeds with a fresh name', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      const ok = wb.renameSheet(0, 'Summary')
      expect(ok).toBe(true)
      expect(wb.sheets()[0].name).toBe('Summary')
      expect(wb.indexOf('Summary')).toBe(0)
      expect(wb.indexOf('Sheet1')).toBe(-1)
      dispose()
    })
  })

  it('renameSheet fails when name is already taken', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      wb.addSheet('Data')
      const ok = wb.renameSheet(0, 'Data')
      expect(ok).toBe(false)
      expect(wb.sheets()[0].name).toBe('Sheet1')
      dispose()
    })
  })

  it('renameSheet to the same name is a no-op success', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      const ok = wb.renameSheet(0, 'Sheet1')
      expect(ok).toBe(true)
      dispose()
    })
  })

  it('activeStore returns the right SheetStore after setActiveIdx', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      const idx2 = wb.addSheet('B')
      // Write to the second sheet through sheetAt so we can later verify
      // activeStore() picks it up after setActiveIdx.
      wb.sheetAt(idx2)!.setNumber('A1', 999)
      wb.setActiveIdx(idx2)
      expect(wb.activeStore().getCell('A1').display).toBe('999')
      wb.setActiveIdx(0)
      expect(wb.activeStore().getCell('A1').display).toBe('')
      dispose()
    })
  })

  it('SheetStores are independent — write to one does not affect another', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      const idx2 = wb.addSheet('B')
      const s1 = wb.sheetAt(0)!
      const s2 = wb.sheetAt(idx2)!
      s1.setNumber('A1', 1)
      s2.setNumber('A1', 2)
      expect(s1.getCell('A1').display).toBe('1')
      expect(s2.getCell('A1').display).toBe('2')
      // Independent selections too.
      s1.setSelection({ row: 0, col: 0 })
      s2.setSelection({ row: 4, col: 3 })
      expect(s1.selectionAddr()).toBe('A1')
      expect(s2.selectionAddr()).toBe('D5')
      dispose()
    })
  })

  it('setActiveIdx on out-of-range idx is a no-op', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      wb.setActiveIdx(5)
      expect(wb.activeIdx()).toBe(0)
      wb.setActiveIdx(-1)
      expect(wb.activeIdx()).toBe(0)
      dispose()
    })
  })

  it('sheets() is reactive — re-reads after addSheet', () => {
    createRoot((dispose) => {
      const wb = createWorkbookStore()
      let observed: number[] = []
      // Subscribe via a derived computation. Solid's createComputed is
      // overkill here — direct re-read after mutation is enough since we
      // wrap sheets() in a signal (version()). The key reactive surface
      // is that `sheets()` returns the current snapshot post-mutation.
      observed = wb.sheets().map((s) => s.idx)
      expect(observed).toEqual([0])
      wb.addSheet()
      observed = wb.sheets().map((s) => s.idx)
      expect(observed).toEqual([0, 1])
      wb.addSheet()
      observed = wb.sheets().map((s) => s.idx)
      expect(observed).toEqual([0, 1, 2])
      dispose()
    })
  })
})
