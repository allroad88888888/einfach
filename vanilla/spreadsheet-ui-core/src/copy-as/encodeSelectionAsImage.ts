import type { CellRange } from '../shared'
import type { SpreadsheetBackend } from '../backend/types'
import type { CopyAsRect } from './types'
import { copyAsVisibleRows } from './visible-rows'

/**
 * Soft cap on the estimated output pixel count (width × height) that
 * `encodeSelectionAsImage` will hand to the backend. Defends against
 * "select column A → PNG" pathological cases that would allocate a
 * multi-billion-pixel canvas and either OOM the tab or take seconds to
 * encode.
 *
 * Picked as `4096²` (16,777,216) — matches the conservative WebGL
 * `MAX_TEXTURE_SIZE` floor most desktop GPUs honour and lines up with
 * the 4K dimensional cap most browsers impose on a single canvas. A
 * future host with a larger budget can override via `maxPixels` on
 * `EncodeSelectionAsImageInput`.
 */
export const MAX_EXPORT_PIXELS = 4096 * 4096

/**
 * Default per-cell pixel sizing for the pre-flight size estimate. Mirrors
 * the PoC defaults baked into `solid/excel/src-vnext/copy-as/renderRangeAsImage.ts`
 * — 96 CSS px per column, 24 CSS px per row. The estimate only gates the
 * pixel-count cap; the host backend is still the authority on the actual
 * rendered dimensions.
 */
const DEFAULT_ESTIMATE_COL_WIDTH_PX = 96
const DEFAULT_ESTIMATE_ROW_HEIGHT_PX = 24

/**
 * Discriminated failure variants. UI core surfaces these to the host
 * dispatcher (`dispatchCopyAsImage`) which mirrors the relevant value
 * into `copyAsErrorAtom` and may surface a status-bar message.
 *
 *   - `no-backend`: the host omitted `exportRangeAsImage`. UI surfaces
 *     normally stay hidden in this case (capability-gated menus / shortcuts);
 *     this variant exists so a forced dispatch (e.g. programmatic keystroke
 *     replay) still produces a structured error.
 *   - `too-large`: estimated pixel count exceeds `MAX_EXPORT_PIXELS`. The
 *     backend was NOT called.
 *   - `empty-bytes`: backend returned a successful result with zero-length
 *     bytes. Treated as a render failure (no clipboard write is meaningful
 *     for a 0-byte PNG).
 */
export type EncodeSelectionAsImageFailureKind = 'no-backend' | 'too-large' | 'empty-bytes'

export interface EncodeSelectionAsImageInput {
  sheetId: string
  rect: CopyAsRect
  /**
   * Output scale. `1` = CSS pixels (PoC default), `2` = retina. The
   * backend is the authority on what the scale actually means in pixels
   * — UI core forwards verbatim.
   */
  scale?: number
  /**
   * Estimated per-cell sizes used by the pre-flight pixel-count cap. The
   * host normally derives these from `readViewportSizeProjection`; falls
   * back to the PoC defaults when omitted. Only used for the cap check;
   * the backend is still the authority on the actual rendered geometry.
   */
  estimatedColWidthPx?: number
  estimatedRowHeightPx?: number
  /**
   * Per-call override for the pixel-count cap. A host with a generous
   * memory budget (kiosk app, native shell) can raise this; UI core uses
   * `MAX_EXPORT_PIXELS` by default.
   */
  maxPixels?: number
  /**
   * FILTER-hidden rows inside `rect`, sourced from `viewportFilterHiddenAtom`
   * — never `effectiveHiddenAtom` (§8.2). Forwarded verbatim to
   * `exportRangeAsImage` so the host renderer skips both the paint AND the
   * geometry for those rows, and excluded from the pre-flight pixel
   * estimate below so a heavily filtered selection is not rejected as
   * `too-large` over rows it will never render.
   *
   * Always empty until the S5 adapter flip populates the atom.
   */
  hiddenRows?: ReadonlySet<number> | readonly number[]
}

export interface EncodeSelectionAsImageSuccess {
  ok: true
  blob: Blob
}

export interface EncodeSelectionAsImageFailure {
  ok: false
  reason: EncodeSelectionAsImageFailureKind
  /** Estimated total pixels — only populated on `too-large`. */
  estimatedPixels?: number
  /** Pixel cap that triggered the rejection — only populated on `too-large`. */
  limit?: number
}

export type EncodeSelectionAsImageResult =
  | EncodeSelectionAsImageSuccess
  | EncodeSelectionAsImageFailure

/**
 * Wave 8.4 — framework-agnostic PNG encoder. Calls the host
 * `exportRangeAsImage` port and wraps the returned bytes in a `Blob`
 * typed `image/png` so the caller can hand it straight to a
 * `ClipboardItem`.
 *
 * Failure modes (no exceptions thrown — host narrows on `result.ok`):
 *   - `no-backend`: host omitted `exportRangeAsImage`. UI core stays
 *     inert; the capability gate normally hides the trigger surface.
 *   - `too-large`: estimated pixel count `width × height × scale²` exceeds
 *     `maxPixels` (defaults to `MAX_EXPORT_PIXELS`). Backend is NOT
 *     called; the host should surface a "selection too large" message.
 *   - `empty-bytes`: backend succeeded but returned a zero-length byte
 *     stream (defensive — keeps the clipboard write path from publishing
 *     an empty PNG).
 *
 * No DOM access. The actual SVG / canvas / OffscreenCanvas paint
 * happens inside the host adapter.
 */
export async function encodeSelectionAsImage(
  input: EncodeSelectionAsImageInput,
  backend: SpreadsheetBackend,
): Promise<EncodeSelectionAsImageResult> {
  if (!backend.exportRangeAsImage) {
    return { ok: false, reason: 'no-backend' }
  }

  // --- Pre-flight pixel-count cap ---------------------------------------
  // We estimate using the host-provided per-cell size (which is normally
  // derived from `readViewportSizeProjection`) or the PoC defaults. The
  // estimate intentionally OVER-counts in the common case (default 96×24)
  // so a sub-cap selection that the backend then renders with a larger
  // measured size still falls inside the cap on the host side.
  const colWidth = input.estimatedColWidthPx ?? DEFAULT_ESTIMATE_COL_WIDTH_PX
  const rowHeight = input.estimatedRowHeightPx ?? DEFAULT_ESTIMATE_ROW_HEIGHT_PX
  const scale = input.scale ?? 1
  const cols = Math.max(0, input.rect.endCol - input.rect.startCol + 1)
  // Only rows that will actually be painted count towards the cap — a
  // 100k-row selection with 99k rows filtered away renders as 1k rows and
  // must not be rejected for a size it never reaches. Degrades to the full
  // span when `hiddenRows` is omitted or empty, which is today's behaviour.
  const rows = copyAsVisibleRows(input.rect, input.hiddenRows).length
  const estimatedPixels = cols * colWidth * scale * rows * rowHeight * scale
  const limit = input.maxPixels ?? MAX_EXPORT_PIXELS
  if (estimatedPixels > limit) {
    return { ok: false, reason: 'too-large', estimatedPixels, limit }
  }

  const range: CellRange = {
    rowStart: input.rect.startRow,
    rowEnd: input.rect.endRow,
    colStart: input.rect.startCol,
    colEnd: input.rect.endCol,
  }

  const result = await backend.exportRangeAsImage({
    kind: 'export-range-image',
    sheetId: input.sheetId,
    range,
    format: 'png',
    scale: input.scale,
    hiddenRows: input.hiddenRows,
  })

  if (!result.bytes || result.bytes.byteLength === 0) {
    return { ok: false, reason: 'empty-bytes' }
  }

  return { ok: true, blob: new Blob([result.bytes], { type: result.mimeType }) }
}
