export type NamedRangeScope = 'workbook' | { sheetId: string }

export const NAMED_RANGE_NAME_MAX_LENGTH = 255
export const NAMED_RANGE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Normalize the public Excel-name spelling without changing its display case.
 * Identity comparisons use {@link namedRangeIdentity}; callers must not use
 * the returned display spelling as a case-sensitive key.
 */
export function normalizeNamedRangeName(name: string): string | null {
  const normalized = name.trim()
  if (
    normalized.length === 0 ||
    normalized.length > NAMED_RANGE_NAME_MAX_LENGTH ||
    !NAMED_RANGE_NAME_PATTERN.test(normalized)
  ) {
    return null
  }
  return normalized
}

/**
 * Workbook names are case-insensitive. Sheet-scoped names additionally use
 * the stable host sheet id as part of their identity.
 */
export function namedRangeIdentity(name: string, scope: NamedRangeScope): string | null {
  const normalized = normalizeNamedRangeName(name)
  if (!normalized) return null
  const scopeKey = scope === 'workbook' ? 'workbook' : `sheet:${scope.sheetId}`
  return `${scopeKey}:${normalized.toUpperCase()}`
}

export function namedRangeScopeEquals(left: NamedRangeScope, right: NamedRangeScope): boolean {
  if (left === 'workbook' || right === 'workbook') return left === right
  return left.sheetId === right.sheetId
}

export type NamedRangeRuntime = 'static-session' | 'worker-ts' | 'worker-wasm'
export type NamedRangeBindingKind = NamedRangeRefersTo['kind']
export type NamedRangeRangeSemantics = 'stored-definition' | 'live-reference' | 'unsupported'
export type NamedRangeListAuthority = 'static-session-registry' | 'adapter-post-ack-overlay'
export type NamedRangeDefinitionReadback = 'full' | 'names-only' | 'none'
export type NamedRangeMutationAck =
  | 'session-registry-accepted'
  | 'engine-accepted'
  | 'engine-names-witnessed'
export type NamedRangeDurability = 'session-local'

/** Backend facts used by Name Manager; method presence is not a capability. */
export interface NamedRangeBackendCapabilities {
  runtime: NamedRangeRuntime
  scopes: readonly ('workbook' | 'sheet')[]
  bindings: Readonly<Record<NamedRangeBindingKind, boolean>>
  delete: boolean
  rangeSemantics: NamedRangeRangeSemantics
  listAuthority: NamedRangeListAuthority
  definitionReadback: NamedRangeDefinitionReadback
  namesWitness: boolean
  mutationAck: NamedRangeMutationAck
  durability: NamedRangeDurability
}

export type NamedRangeMutationOutcome = 'w0-acknowledged' | 'confirmed-not-applied'
export type NamedRangeMutationAuthority =
  | 'static-session-registry'
  | 'worker-engine-ack'
  | 'worker-engine-names-witness'

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
  authority?: NamedRangeListAuthority
  definitionReadback?: NamedRangeDefinitionReadback
  witnessNames?: string[]
  canonical?: false
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
  outcome?: NamedRangeMutationOutcome
  authority?: NamedRangeMutationAuthority
  canonical?: false
}

export interface NameManagerEditorState {
  status: 'closed' | 'editing-new' | 'editing-existing'
  draft?: NamedRange
}

/**
 * Framework-neutral workbook port used by the controller. The port is passed
 * to commands and is never retained in atom state.
 */
export interface NamedRangeControllerPort {
  readNamedRangeCapabilities?: () => Promise<NamedRangeBackendCapabilities>
  listNamedRanges?: (request: ListNamedRangesRequest) => Promise<NamedRangeListResult>
  setNamedRange?: (request: SetNamedRangeRequest) => Promise<NamedRangeMutationResult>
  deleteNamedRange?: (request: DeleteNamedRangeRequest) => Promise<NamedRangeMutationResult>
}

export type NamedRangeCapabilityStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

export interface NamedRangeCapabilityState {
  status: NamedRangeCapabilityStatus
  requestId: number | null
  capabilities: NamedRangeBackendCapabilities | null
  error: string | null
}

export type NamedRangeRegistryStatus = 'idle' | 'refreshing' | 'ready' | 'projection-unknown'

export interface NamedRangeRegistryState {
  status: NamedRangeRegistryStatus
  requestId: number | null
  names: readonly NamedRange[]
  revision?: number | string
  error: string | null
}

export type NamedRangeMutationAction = 'set' | 'delete'
export type NamedRangeMutationOrigin = 'name-box' | 'name-manager'
export type NamedRangeOperationAttemptStatus =
  | 'pending'
  | 'acknowledged'
  | 'confirmed-not-applied'
  | 'outcome-unknown'

export interface NamedRangeOperationAttempt {
  operationId: string
  requestId: number
  origin: NamedRangeMutationOrigin
  sessionId: number
  action: NamedRangeMutationAction
  name: string
  scope: NamedRangeScope
  bindingKind?: NamedRangeBindingKind
  status: NamedRangeOperationAttemptStatus
  revision?: number | string
  error: string | null
}

export type NamedRangeMutationStatus = 'idle' | 'blocked' | NamedRangeOperationAttemptStatus

export interface NamedRangeMutationState {
  status: NamedRangeMutationStatus
  operationId: string | null
  requestId: number | null
  origin: NamedRangeMutationOrigin | null
  sessionId: number | null
  action: NamedRangeMutationAction | null
  outcome: NamedRangeMutationOutcome | null
  error: string | null
}

export type NamedRangeMutationPayload =
  | {
      action: 'set'
      name: string
      scope: NamedRangeScope
      refersTo: NamedRangeRefersTo
    }
  | {
      action: 'delete'
      name: string
      scope: NamedRangeScope
    }

export interface LoadNamedRangeCapabilitiesInput {
  source: NamedRangeControllerPort
}

export interface RefreshNamedRangeRegistryInput {
  source: NamedRangeControllerPort
}

export interface RunNamedRangeMutationInput {
  source: NamedRangeControllerPort
  origin: NamedRangeMutationOrigin
  sessionId?: number
  mutation: NamedRangeMutationPayload
}

/** An explicit late result for the currently unresolved immutable ticket. */
export interface SettleNamedRangeMutationInput {
  source: NamedRangeControllerPort
  result: NamedRangeMutationResult
}

export interface SaveNameManagerInput {
  source: NamedRangeControllerPort
  sessionId?: number
  /** Active sheet used by a new workbook-scoped range draft. */
  activeSheetId?: string
  entry?: NamedRange
}

export interface DeleteNameManagerEntryInput {
  source: NamedRangeControllerPort
  sessionId?: number
  entry?: NamedRange
}
