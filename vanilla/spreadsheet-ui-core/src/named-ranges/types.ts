export type NamedRangeScope = 'workbook' | { sheetId: string }

/**
 * A name binding's referent.
 *
 *  - `range`   — an A1-style range on a specific sheet.
 *  - `constant`— a literal value (string, number-as-text, etc.).
 *  - `lambda`  — a callable body. `params` are the declared parameter
 *                identifiers (e.g. `['x', 'y']`). `body` is the **formula
 *                source string** (e.g. `'=x + y * 2'`) — the AST itself
 *                does not cross the `postMessage` worker boundary, so the
 *                wire format keeps the source verbatim. The TS worker
 *                runtime parses the body into an `Expr` AST before calling
 *                `workbook.defineName(...)`. The WASM runtime does not
 *                implement LAMBDA — adapters route lambda bindings only
 *                when the backend port advertises support; see
 *                `vanilla/spreadsheet-ui-core/docs/named-ranges.md`.
 */
export type NamedRangeRefersTo =
  | { kind: 'range'; sheetId: string; address: string }
  | { kind: 'constant'; value: string }
  | { kind: 'lambda'; params: string[]; body: string }

export interface NamedRange {
  name: string
  scope: NamedRangeScope
  refersTo: NamedRangeRefersTo
}

export interface ListNamedRangesRequest {
  kind: 'list-named-ranges'
  requestId?: number
  revision?: number | string
}

export interface NamedRangeListResult {
  requestId?: number
  revision?: number | string
  names: NamedRange[]
  truncated?: boolean
}

export interface SetNamedRangeRequest {
  kind: 'set-named-range'
  name: string
  scope: NamedRangeScope
  refersTo: NamedRangeRefersTo
  requestId?: number
  revision?: number | string
}

export interface DeleteNamedRangeRequest {
  kind: 'delete-named-range'
  name: string
  scope: NamedRangeScope
  requestId?: number
  revision?: number | string
}

export interface NamedRangeMutationResult {
  requestId?: number
  revision?: number | string
}

export interface NameManagerEditorState {
  status: 'closed' | 'editing-new' | 'editing-existing'
  draft?: NamedRange
}
