import type { DisplayCell } from '../backend/types'

/**
 * Rectangle of the active selection (inclusive on both ends). Mirrors
 * `CellRange` from `shared`, but kept as a structural local type so the
 * encoders stay framework-agnostic and free of any optional fields hosts
 * sometimes attach (sheet id, anchor, etc.).
 */
export interface CopyAsRect {
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

/**
 * Input shape the Solid layer (or any host) hands to the encoders.
 *
 * - `cells` is sparse: only occupied cells from the projection. The encoders
 *   iterate `rect`, not `cells`, so empty cells in the rectangle render as
 *   empty `<td>` / blank GFM cell / empty plain-text column.
 * - `rect` is the inclusive bounding rectangle to emit.
 * - `columnWidths` / `rowHeights` are decoration hints the HTML emitter may
 *   apply via `<col>` / inline style. They are optional; encoders MUST
 *   tolerate their absence.
 */
export interface CopyAsInput {
  cells: ReadonlyArray<DisplayCell>
  rect: CopyAsRect
  columnWidths?: ReadonlyMap<number, number>
  rowHeights?: ReadonlyMap<number, number>
}

/**
 * Bundle of all three serialised text flavours the clipboard write will
 * publish. Hosts that only want one flavour can call the per-format
 * encoder directly; `encodeSelectionForClipboard` is the convenience
 * helper that returns the full triple in a single pass.
 *
 * `kind` defaults to `'text'` on legacy writers; the field is optional so
 * existing call sites (`store.setter(lastCopyAsAtom, encoded)`) continue
 * to type-check without modification.
 */
export interface CopyAsTextResult {
  kind?: 'text'
  /** `text/html` payload. */
  html: string
  /** `text/plain` payload. Tab-separated columns, `\n`-separated rows. */
  plainText: string
  /** `text/markdown` payload. GitHub Flavoured Markdown table. */
  markdown: string
}

/**
 * Wave 8.4 — image variant for `lastCopyAsAtom`. Host writes this after a
 * successful PNG clipboard write so diagnostics can mirror the snapshot
 * without reaching into `navigator.clipboard.read`.
 */
export interface CopyAsImageResult {
  kind: 'image'
  mimeType: 'image/png'
  blob: Blob
}

export type CopyAsResult = CopyAsTextResult | CopyAsImageResult
