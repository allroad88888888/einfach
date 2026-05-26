/** @jsxImportSource solid-js */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  RangeProjectionRequest,
  RangeProjectionResult,
  SpreadsheetBackend,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  lastCopyAsAtom,
  selectionAtom,
  setSelectionBoundsAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetMenuBar } from '../src-vnext/menu-bar'
import {
  copyAsErrorAtom,
  dispatchCopyAs,
  MAX_COPY_AS_CELLS,
  SpreadsheetUiProvider,
} from '../src-vnext/provider'

afterEach(cleanup)

const VIEWPORT = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 8,
  viewportWidth: 8,
  rowHeight: 1,
  colWidth: 1,
  rowCount: 10,
  colCount: 10,
  overscanRows: 0,
  overscanCols: 0,
}

/**
 * 2x2 dataset (A1:B2):
 *   ┌──────┬───────┐
 *   │ apple│ 1     │
 *   ├──────┼───────┤
 *   │ pear │ 2     │
 *   └──────┴───────┘
 */
function buildRangeCells(range: {
  rowStart: number
  rowEnd: number
  colStart: number
  colEnd: number
}): DisplayCell[] {
  const grid: Record<string, string> = {
    '0,0': 'apple',
    '0,1': '1',
    '1,0': 'pear',
    '1,1': '2',
  }
  const cells: DisplayCell[] = []
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const display = grid[`${row},${col}`] ?? ''
      cells.push({
        row,
        col,
        displayValue: display,
        valueKind: display === '' ? 'blank' : isNaN(Number(display)) ? 'string' : 'number',
      })
    }
  }
  return cells
}

function createBackend(): SpreadsheetBackend {
  return {
    async readVisibleProjection(request) {
      const result: VisibleProjectionResult = {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells: buildRangeCells(request.window),
      }
      return result
    },
    async readRangeProjection(request: RangeProjectionRequest): Promise<RangeProjectionResult> {
      return {
        kind: 'range',
        sheetId: request.sheetId,
        range: { ...request.range },
        requestId: request.requestId,
        revision: request.revision,
        cells: buildRangeCells(request.range),
      }
    },
    async setCellInput(request) {
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
        affectedRange: {
          rowStart: request.row,
          rowEnd: request.row,
          colStart: request.col,
          colEnd: request.col,
        },
      }
    },
  }
}

function seedTwoByTwoSelection(store: ReturnType<typeof createStore>) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
  store.setter(selectionAtom, {
    kind: 'range',
    sheetId: 'sheet-1',
    anchor: { row: 0, col: 0 },
    focus: { row: 1, col: 1 },
  })
}

interface ClipboardWriteCall {
  types: string[]
  /** Map MIME → Promise resolving to the encoded payload string. */
  blobs: Record<string, Blob>
}

/**
 * Set of MIME types that Chrome (currently shipping) actually accepts in
 * `new ClipboardItem(…)`. The strict fake refuses everything else with the
 * same `DOMException: Type ... not supported` shape browsers throw — this
 * is what catches the markdown-rejection cascade that motivated the
 * multi-tier write fallback. `text/markdown` is intentionally absent.
 */
const STRICT_ACCEPTED_MIME = new Set([
  'text/plain',
  'text/html',
  'image/png',
  'image/svg+xml',
])

interface InstallFakeClipboardOptions {
  /** All `write([…])` calls reject (e.g. permission denied). */
  writeRejects?: boolean
  /**
   * Use the strict ClipboardItem fake that mirrors Chrome's MIME-type
   * filter. Necessary to exercise the tier-2 fallback (drop markdown)
   * that the dispatcher relies on for cross-browser compatibility.
   */
  strict?: boolean
}

/**
 * Install a fake `navigator.clipboard` + `ClipboardItem` for the duration
 * of a test. Returns spies + the captured `write` call payloads.
 *
 * jsdom has neither, so the install must run before render so the grid's
 * dispatcher sees them. Reset by `afterEach`.
 */
function installFakeClipboard(opts: InstallFakeClipboardOptions = {}) {
  const writeCalls: ClipboardWriteCall[] = []
  const writeTextCalls: string[] = []

  class LenientClipboardItem {
    types: string[]
    blobs: Record<string, Blob>
    constructor(items: Record<string, Blob>) {
      this.types = Object.keys(items)
      this.blobs = items
    }
  }

  class StrictClipboardItem {
    types: string[]
    blobs: Record<string, Blob>
    constructor(items: Record<string, Blob>) {
      for (const type of Object.keys(items)) {
        if (!STRICT_ACCEPTED_MIME.has(type)) {
          throw new DOMException(
            `Type ${type} not supported on write.`,
            'NotAllowedError',
          )
        }
      }
      this.types = Object.keys(items)
      this.blobs = items
    }
  }

  const FakeClipboardItem = opts.strict ? StrictClipboardItem : LenientClipboardItem

  const fakeWrite = jest.fn(async (items: LenientClipboardItem[]) => {
    if (opts.writeRejects) {
      throw new Error('clipboard.write denied (test)')
    }
    for (const item of items) {
      writeCalls.push({ types: [...item.types], blobs: { ...item.blobs } })
    }
  })
  const fakeWriteText = jest.fn(async (text: string) => {
    writeTextCalls.push(text)
  })

  const originalClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem
  const originalClipboard = (navigator as { clipboard?: unknown }).clipboard

  Object.defineProperty(globalThis, 'ClipboardItem', {
    value: FakeClipboardItem,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(navigator, 'clipboard', {
    value: { write: fakeWrite, writeText: fakeWriteText },
    configurable: true,
  })

  return {
    writeCalls,
    writeTextCalls,
    fakeWrite,
    fakeWriteText,
    restore() {
      if (originalClipboardItem === undefined) {
        delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem
      } else {
        Object.defineProperty(globalThis, 'ClipboardItem', {
          value: originalClipboardItem,
          configurable: true,
          writable: true,
        })
      }
      if (originalClipboard === undefined) {
        delete (navigator as { clipboard?: unknown }).clipboard
      } else {
        Object.defineProperty(navigator, 'clipboard', {
          value: originalClipboard,
          configurable: true,
        })
      }
    },
  }
}

async function readBlobText(blob: Blob): Promise<string> {
  // jsdom's Blob supports .text() in node 18+. Fall back to FileReader.
  const anyBlob = blob as unknown as { text?: () => Promise<string> }
  if (typeof anyBlob.text === 'function') return anyBlob.text()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

describe('Copy as HTML / Markdown (Ctrl+Shift+C)', () => {
  let fake: ReturnType<typeof installFakeClipboard>

  beforeEach(() => {
    fake = installFakeClipboard()
  })

  afterEach(() => {
    fake.restore()
  })

  it('Ctrl+Shift+C writes three MIME flavours and updates lastCopyAsAtom', async () => {
    const store = createStore()
    const backend = createBackend()
    seedTwoByTwoSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'c',
      ctrlKey: true,
      shiftKey: true,
    })

    await waitFor(() => {
      expect(store.getter(lastCopyAsAtom)).not.toBeNull()
    })

    expect(fake.fakeWrite).toHaveBeenCalledTimes(1)
    const call = fake.writeCalls[0]!
    expect(new Set(call.types)).toEqual(new Set(['text/html', 'text/plain', 'text/markdown']))

    const snapshot = store.getter(lastCopyAsAtom)!
    expect(snapshot.plainText).toContain('apple')
    expect(snapshot.plainText).toContain('pear')
    // Plain text is TSV — apples then a tab then 1, etc.
    expect(snapshot.plainText.split('\n')).toHaveLength(2)
    expect(snapshot.html).toContain('<table')
    expect(snapshot.html).toContain('apple')
    // Markdown table has a separator row.
    expect(snapshot.markdown).toContain('|')
    expect(snapshot.markdown.toLowerCase()).toContain('apple')

    // The Blob payloads handed to ClipboardItem match the encoded triple.
    const htmlBody = await readBlobText(call.blobs['text/html']!)
    const plainBody = await readBlobText(call.blobs['text/plain']!)
    const mdBody = await readBlobText(call.blobs['text/markdown']!)
    expect(htmlBody).toBe(snapshot.html)
    expect(plainBody).toBe(snapshot.plainText)
    expect(mdBody).toBe(snapshot.markdown)
    // Successful tier-1 write clears any prior error state.
    expect(store.getter(copyAsErrorAtom)).toBeNull()
  })

  it('falls back to writeText(plainText) when navigator.clipboard.write rejects', async () => {
    fake.restore()
    fake = installFakeClipboard({ writeRejects: true })

    const store = createStore()
    const backend = createBackend()
    seedTwoByTwoSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
      key: 'c',
      ctrlKey: true,
      shiftKey: true,
    })

    await waitFor(() => {
      expect(store.getter(lastCopyAsAtom)).not.toBeNull()
    })

    // Both tier-1 (html+plain+markdown) and tier-2 (html+plain) rejected
    // because `writeRejects: true` rejects ANY write([…]) call, so the
    // dispatcher fell through to writeText. The tier-2 attempt is the
    // second `write([…])` call.
    expect(fake.fakeWrite).toHaveBeenCalledTimes(2)
    expect(fake.fakeWriteText).toHaveBeenCalledTimes(1)
    const snapshot = store.getter(lastCopyAsAtom)!
    expect(fake.writeTextCalls[0]).toBe(snapshot.plainText)
    expect(store.getter(copyAsErrorAtom)).toEqual({ kind: 'fallback-plain-only' })
  })

  it('clicking Edit > Copy as in the menu triggers the same flow', async () => {
    const store = createStore()
    const backend = createBackend()
    seedTwoByTwoSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    // Open the Edit menu.
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    const item = container.querySelector('[data-testid="menu-bar-item-edit.copyAs"]')
    expect(item).not.toBeNull()
    fireEvent.click(item!)

    await waitFor(() => {
      expect(store.getter(lastCopyAsAtom)).not.toBeNull()
    })

    expect(fake.fakeWrite).toHaveBeenCalledTimes(1)
    expect(new Set(fake.writeCalls[0]!.types)).toEqual(
      new Set(['text/html', 'text/plain', 'text/markdown']),
    )
  })

  it('falls back to {html, plain} when the browser rejects text/markdown', async () => {
    // Strict ClipboardItem fake mirrors Chrome: it refuses non-standard
    // MIME types (text/markdown is currently not in the supported set).
    // The dispatcher must drop markdown and retry with the {html, plain}
    // pair before giving up — this is the tier-2 path.
    fake.restore()
    fake = installFakeClipboard({ strict: true })

    const store = createStore()
    const backend = createBackend()
    seedTwoByTwoSelection(store)

    await dispatchCopyAs(store, backend, {
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    // Tier-1 threw during `new ClipboardItem({…markdown})` — the dispatcher
    // catches that, then tier-2 succeeded with {html, plain}.
    expect(fake.fakeWrite).toHaveBeenCalledTimes(1)
    const call = fake.writeCalls[0]!
    expect(new Set(call.types)).toEqual(new Set(['text/html', 'text/plain']))
    // The full encoded triple is still on `lastCopyAsAtom` — only the
    // clipboard MIME bag was reduced.
    const snapshot = store.getter(lastCopyAsAtom)!
    expect(snapshot.markdown).toContain('|')
    expect(snapshot.html).toContain('<table')
    expect(store.getter(copyAsErrorAtom)).toEqual({ kind: 'fallback-plain-only' })
  })

  it('over-cap selection skips html/markdown and writes clipped plain text', async () => {
    const store = createStore()
    const backend = createBackend()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    // Allow a giant range without overflowing the selection bounds clamp.
    store.setter(setSelectionBoundsAtom, { rowCount: 1_500_000, colCount: 16_384 })

    // Whole-column-equivalent selection: > MAX_COPY_AS_CELLS cells.
    const oversizedRange = {
      rowStart: 0,
      rowEnd: 1_000_000,
      colStart: 0,
      colEnd: 0,
    }
    const totalCells =
      (oversizedRange.rowEnd - oversizedRange.rowStart + 1) *
      (oversizedRange.colEnd - oversizedRange.colStart + 1)
    expect(totalCells).toBeGreaterThan(MAX_COPY_AS_CELLS)

    const projectionSpy = jest.spyOn(backend, 'readRangeProjection')

    await dispatchCopyAs(store, backend, {
      sheetId: 'sheet-1',
      range: oversizedRange,
    })

    // The expensive multi-MIME write was skipped entirely.
    expect(fake.fakeWrite).not.toHaveBeenCalled()
    // writeText carried the clipped TSV.
    expect(fake.fakeWriteText).toHaveBeenCalledTimes(1)
    // `lastCopyAsAtom` stays at its previous value (null in this test) —
    // we never produced the html/markdown flavours, so writing a partial
    // result would mislead diagnostics.
    expect(store.getter(lastCopyAsAtom)).toBeNull()
    const error = store.getter(copyAsErrorAtom)
    expect(error?.kind).toBe('too-large')
    if (error?.kind === 'too-large') {
      expect(error.cells).toBe(totalCells)
      expect(error.limit).toBe(MAX_COPY_AS_CELLS)
    }
    // The projection request was for the CLIPPED range, not the original
    // 1M-row range — that's what stops the tab hanging.
    const projectionArg = projectionSpy.mock.calls[0]![0] as RangeProjectionRequest
    const clippedRange = projectionArg.range
    const clippedCells =
      (clippedRange.rowEnd - clippedRange.rowStart + 1) *
      (clippedRange.colEnd - clippedRange.colStart + 1)
    expect(clippedCells).toBeLessThanOrEqual(MAX_COPY_AS_CELLS)
  })

  it('leaves lastCopyAsAtom unchanged when both write paths fail', async () => {
    // Pre-populate the atom with a known sentinel so we can verify it's
    // not overwritten by a failed dispatch.
    const sentinel = {
      html: '<table>sentinel</table>',
      plainText: 'sentinel',
      markdown: '| sentinel |',
    }
    const store = createStore()
    store.setter(lastCopyAsAtom, sentinel)
    seedTwoByTwoSelection(store)

    // Remove writeText so even the tier-3 fallback fails.
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: jest.fn(async () => { throw new Error('blocked') }) },
      configurable: true,
    })

    const backend = createBackend()
    await dispatchCopyAs(store, backend, {
      sheetId: 'sheet-1',
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    // Atom unchanged — distinguishes "never copied" from "wrote stale value".
    expect(store.getter(lastCopyAsAtom)).toEqual(sentinel)
    expect(store.getter(copyAsErrorAtom)).toEqual({ kind: 'failed' })
  })
})
