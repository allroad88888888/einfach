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
  /**
   * Sheet-absolute row indices inside `rect` that must not be emitted at
   * all — no `<tr>`, no GFM row, no TSV line.
   *
   * Populate with FILTER-hidden rows only (`viewportFilterHiddenAtom`),
   * never the manual ∪ filter union. Excel skips filtered-out rows when you
   * copy a filtered region but copies manually hidden rows normally; passing
   * the union here would drop manually hidden rows out of the clipboard and
   * diverge from Excel. See `copy-as/visible-rows.ts` and §8.2 of
   * `excel/solid-excel/docs/online-excel-parity/design-filter-hidden-rows.md`.
   *
   * Omitted / empty means "emit every row in the rect", which is both the
   * pre-hardening behaviour and the only behaviour reachable until the S5
   * adapter flip stops compacting filtered rows out of the display range.
   */
  hiddenRows?: ReadonlySet<number> | readonly number[]
}

/**
 * Bundle of all three serialised text flavours the clipboard write will
 * publish. Hosts that only want one flavour can call the per-format
 * encoder directly; `encodeSelectionForClipboard` is the convenience
 * helper that returns the full triple in a single pass.
 *
 * `kind` defaults to `'text'` on legacy snapshots; the field remains optional
 * so existing persisted diagnostics can be read without migration.
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
 * Wave 8.4 — image variant for `lastCopyAsAtom`. After PNG encoding succeeds,
 * the host publishes this through `publishCopyAsResultAtom` and the diagnostics
 * mirror before attempting the system clipboard write. Clipboard failure only
 * updates status and preserves the published snapshot.
 */
export interface CopyAsImageResult {
  kind: 'image'
  mimeType: 'image/png'
  blob: Blob
}

export type CopyAsResult = CopyAsTextResult | CopyAsImageResult

/**
 * User-visible outcome of the latest copy-as attempt.
 *
 * This belongs to the framework-agnostic UI session rather than a host
 * component because status surfaces and command dispatchers must observe the
 * same result across framework adapters.
 */
export type CopyAsError =
  | { kind: 'too-large'; cells: number; limit: number }
  | { kind: 'fallback-plain-only' }
  | { kind: 'failed' }
  | { kind: 'image-too-large'; estimatedPixels: number; limit: number }
  | { kind: 'image-no-backend' }
  | { kind: 'image-failed' }
