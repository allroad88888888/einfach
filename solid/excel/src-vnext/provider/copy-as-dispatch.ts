import { atom, type Store } from '@einfach/core'
import {
  encodeSelectionAsPlainText,
  encodeSelectionForClipboard,
  lastCopyAsAtom,
  selectionSnapshotAtom,
  type CellRange,
  type CopyAsResult,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'

import { advanceSpreadsheetProjectionRequestIdAtom } from './atoms'

/**
 * Maximum selection size (rows × cols) the multi-MIME copy-as path will
 * encode. Beyond this, we'd allocate huge HTML/Markdown strings and block
 * the main thread (e.g. column-A select = 1M rows). Matches Go To Special's
 * cap convention (`GO_TO_SCAN_MAX_CELLS = 100_000`).
 *
 * When exceeded, the dispatch falls back to writing a *clipped* TSV
 * (first `MAX_COPY_AS_CELLS` cells) via `navigator.clipboard.writeText` —
 * the keystroke still produces a usable plain-text result but skips the
 * expensive HTML/Markdown encoders.
 */
export const MAX_COPY_AS_CELLS = 100_000

/**
 * Discriminated reason for the most recent copy-as failure. UI can read
 * this to surface a status-bar message ("copyAs.status.failed" / ".tooLarge"
 * / ".fallback"). Cleared back to `null` on a successful multi-MIME write.
 */
export type CopyAsError =
  | { kind: 'too-large'; cells: number; limit: number }
  | { kind: 'fallback-plain-only' }
  | { kind: 'failed' }

export const copyAsErrorAtom = atom<CopyAsError | null>(null)
copyAsErrorAtom.debugLabel = 'spreadsheet.copyAs.error'

/**
 * Test-only mirror of `lastCopyAsAtom` written to `window.__einfach_lastCopyAs__`
 * for e2e visibility. Gated behind a runtime flag so the production bundle
 * never leaks an internal hook onto the global object.
 *
 * Detection (any positive match enables the mirror):
 *   - `process.env.NODE_ENV === 'test'`            (Jest unit tests)
 *   - `(globalThis as any).__EINFACH_E2E__ === true` (Playwright sets this
 *     before any page script runs via `context.addInitScript`)
 *
 * Note: we intentionally avoid `import.meta.env` here — Jest's SWC config
 * doesn't transform it, and bundlers (Vite, Rollup) can do their own
 * dead-code elimination via the `__EINFACH_E2E__` global when needed.
 */
function isE2EMirrorEnabled(): boolean {
  try {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') return true
  } catch {
    // process is undefined in browser bundles — that's fine, fall through.
  }
  const g = globalThis as { __EINFACH_E2E__?: boolean }
  return g.__EINFACH_E2E__ === true
}

function setE2EMirror(result: CopyAsResult | null): void {
  if (!isE2EMirrorEnabled()) return
  if (typeof window === 'undefined') return
  const w = window as unknown as { __einfach_lastCopyAs__?: CopyAsResult | null }
  w.__einfach_lastCopyAs__ = result
}

/**
 * Clip the rect to at most `MAX_COPY_AS_CELLS` cells, keeping the top-left
 * anchor (row 0/col 0 of the rect) and the leftmost columns. We prefer
 * a full-width prefix (whole rows of the original selection) so the
 * resulting TSV stays grid-shaped.
 */
function clipRectToCap(range: CellRange): CellRange {
  const rows = range.rowEnd - range.rowStart + 1
  const cols = range.colEnd - range.colStart + 1
  if (rows * cols <= MAX_COPY_AS_CELLS) return range
  // Keep full width if a single row fits; otherwise clip rows.
  if (cols >= MAX_COPY_AS_CELLS) {
    return {
      ...range,
      rowEnd: range.rowStart,
      colEnd: range.colStart + MAX_COPY_AS_CELLS - 1,
    }
  }
  const maxRows = Math.max(1, Math.floor(MAX_COPY_AS_CELLS / cols))
  return {
    ...range,
    rowEnd: range.rowStart + maxRows - 1,
  }
}

/**
 * Multi-tier clipboard write. Some browsers reject non-standard MIME types
 * (notably `text/markdown` in older Chrome / jsdom) and bin the whole
 * ClipboardItem when any one entry is unrecognised. Strategy:
 *
 *   tier 1 — `new ClipboardItem({html, plain, markdown})`
 *   tier 2 — `new ClipboardItem({html, plain})` (drop markdown)
 *   tier 3 — `navigator.clipboard.writeText(plain)`
 *
 * Returns the tier that ultimately succeeded, or `null` if all three failed.
 */
async function multiTierWrite(
  encoded: CopyAsResult,
): Promise<'rich-triple' | 'rich-no-markdown' | 'plain-text' | null> {
  const g = globalThis as { ClipboardItem?: typeof ClipboardItem }
  const hasClipboardItem = typeof g.ClipboardItem !== 'undefined'
  const hasClipboardWrite =
    typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.write)
  const hasWriteText =
    typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.writeText)

  // Tier 1: html + plain + markdown.
  if (hasClipboardItem && hasClipboardWrite) {
    try {
      const item = new g.ClipboardItem!({
        'text/html': new Blob([encoded.html], { type: 'text/html' }),
        'text/plain': new Blob([encoded.plainText], { type: 'text/plain' }),
        'text/markdown': new Blob([encoded.markdown], { type: 'text/markdown' }),
      })
      await navigator.clipboard.write([item])
      return 'rich-triple'
    } catch {
      // Fall through to tier 2.
    }

    // Tier 2: html + plain only (drop markdown — most common rejection cause).
    try {
      const item = new g.ClipboardItem!({
        'text/html': new Blob([encoded.html], { type: 'text/html' }),
        'text/plain': new Blob([encoded.plainText], { type: 'text/plain' }),
      })
      await navigator.clipboard.write([item])
      return 'rich-no-markdown'
    } catch {
      // Fall through to tier 3.
    }
  }

  // Tier 3: plain text only.
  if (hasWriteText) {
    try {
      await navigator.clipboard.writeText(encoded.plainText)
      return 'plain-text'
    } catch {
      return null
    }
  }
  return null
}

/**
 * Shared "Copy as HTML / Markdown / plain text" dispatch.
 *
 * Used by both the grid (Ctrl+Shift+C) and the menu bar (Edit > Copy as)
 * so the two entry points share a single implementation. Reads the
 * selection's projection cells via the backend port, runs the framework
 * agnostic encoders, then writes the triple to the system clipboard.
 *
 * Multi-tier fallback chain (see `multiTierWrite`):
 *   1. `ClipboardItem` with html + plain + markdown
 *   2. `ClipboardItem` with html + plain (drops markdown)
 *   3. `navigator.clipboard.writeText(plainText)`
 *
 * `lastCopyAsAtom` is only set on a successful write — on total failure it
 * stays at its previous value so callers can distinguish "never copied"
 * from "wrote stale value". Failure mode surfaces via `copyAsErrorAtom`.
 *
 * Large selections (rows × cols > `MAX_COPY_AS_CELLS`) skip the HTML/MD
 * encoders entirely and write a clipped TSV via `writeText` — selecting
 * a whole column shouldn't hang the tab.
 */
export async function dispatchCopyAs(
  store: Store,
  backend: SpreadsheetBackend,
  options: { sheetId?: string; range?: CellRange } = {},
): Promise<void> {
  const snap = store.getter(selectionSnapshotAtom)
  const sheetId = options.sheetId ?? snap.selection.sheetId ?? ''
  if (!sheetId) {
    return
  }
  const range = options.range ?? snap.range

  const rows = range.rowEnd - range.rowStart + 1
  const cols = range.colEnd - range.colStart + 1
  const totalCells = rows * cols

  // --- Oversized selection path: clip + plain-text only. ---
  if (totalCells > MAX_COPY_AS_CELLS) {
    const clipped = clipRectToCap(range)
    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    const result = await backend.readRangeProjection({
      kind: 'range',
      sheetId,
      requestId,
      reason: 'clipboard',
      range: clipped,
    })
    const plain = encodeSelectionAsPlainText({
      cells: result.cells,
      rect: {
        startRow: clipped.rowStart,
        startCol: clipped.colStart,
        endRow: clipped.rowEnd,
        endCol: clipped.colEnd,
      },
    })
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plain)
        store.setter(copyAsErrorAtom, {
          kind: 'too-large',
          cells: totalCells,
          limit: MAX_COPY_AS_CELLS,
        })
      } else {
        store.setter(copyAsErrorAtom, { kind: 'failed' })
      }
    } catch {
      store.setter(copyAsErrorAtom, { kind: 'failed' })
    }
    // Intentionally leave `lastCopyAsAtom` untouched — we never produced
    // the html/markdown flavours, and overwriting it with a partial result
    // would mislead diagnostics that assume the snapshot is the full
    // (html, plain, markdown) triple.
    return
  }

  // --- Normal path: encode all three flavours, multi-tier write. ---
  const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId,
    requestId,
    reason: 'clipboard',
    range,
  })

  const encoded = encodeSelectionForClipboard({
    cells: result.cells,
    rect: {
      startRow: range.rowStart,
      startCol: range.colStart,
      endRow: range.rowEnd,
      endCol: range.colEnd,
    },
  })

  const tier = await multiTierWrite(encoded)

  if (tier === null) {
    // Both paths failed — leave `lastCopyAsAtom` unchanged so consumers
    // can distinguish "never copied" from "wrote stale value".
    store.setter(copyAsErrorAtom, { kind: 'failed' })
    return
  }

  // Success at some tier. Persist the encoded triple + clear errors.
  store.setter(lastCopyAsAtom, encoded)
  setE2EMirror(encoded)
  if (tier === 'rich-triple') {
    store.setter(copyAsErrorAtom, null)
  } else {
    // Tier 2 or 3 — partial success. Surface as a non-fatal status.
    store.setter(copyAsErrorAtom, { kind: 'fallback-plain-only' })
  }
}
