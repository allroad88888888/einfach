export type NamedRangeScope = 'workbook' | { sheetId: string }

export type NamedRangeRefersTo =
  | { kind: 'range'; sheetId: string; address: string }
  | { kind: 'constant'; value: string }

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
