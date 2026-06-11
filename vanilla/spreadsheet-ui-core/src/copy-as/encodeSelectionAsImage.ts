import type { CellRange } from '../shared'
import type { SpreadsheetBackend } from '../backend/types'
import type { CopyAsRect } from './types'

/**
 * Input shape for `encodeSelectionAsImage`. We accept the same `CopyAsRect`
 * the text encoders use so callers can hand the same rect into all
 * flavours; the encoder converts it to `CellRange` (the backend port's
 * wire shape) internally.
 */
export interface EncodeSelectionAsImageInput {
  sheetId: string
  rect: CopyAsRect
  /**
   * Output scale. `1` = CSS pixels (PoC default), `2` = retina. The
   * backend is the authority on what the scale actually means in pixels
   * — UI core forwards verbatim.
   */
  scale?: number
}

/**
 * Wave 8.4 — framework-agnostic PNG encoder. Calls the host
 * `exportRangeAsImage` port and wraps the returned bytes in a `Blob`
 * typed `image/png` so the caller can hand it straight to a
 * `ClipboardItem`.
 *
 * Returns `null` when:
 *   - the backend omits `exportRangeAsImage` (every Wave-8 port is
 *     optional and UI core stays inert when the host opts out),
 *   - the backend returns no bytes / empty bytes (defensive — keeps the
 *     blob non-empty so downstream `Blob.size > 0` assertions hold).
 *
 * No DOM access. The actual SVG / canvas / OffscreenCanvas paint
 * happens inside the host adapter.
 */
export async function encodeSelectionAsImage(
  input: EncodeSelectionAsImageInput,
  backend: SpreadsheetBackend,
): Promise<Blob | null> {
  if (!backend.exportRangeAsImage) return null

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
  })

  if (!result.bytes || result.bytes.byteLength === 0) return null

  return new Blob([result.bytes], { type: result.mimeType })
}
