import { atom, type Getter, type Setter } from '@einfach/core'
import type {
  DeleteNameManagerEntryInput,
  DeleteNamedRangeRequest,
  LoadNamedRangeCapabilitiesInput,
  NamedRange,
  NamedRangeBackendCapabilities,
  NamedRangeBindingKind,
  NamedRangeCapabilityState,
  NamedRangeControllerPort,
  NamedRangeListResult,
  NamedRangeMutationOutcome,
  NamedRangeMutationPayload,
  NamedRangeMutationResult,
  NamedRangeMutationState,
  NamedRangeOperationAttempt,
  NamedRangeOperationAttemptStatus,
  NamedRangeRefersTo,
  NamedRangeRegistryState,
  NamedRangeScope,
  NameManagerEditorState,
  RefreshNamedRangeRegistryInput,
  RunNamedRangeMutationInput,
  SaveNameManagerInput,
  SetNamedRangeRequest,
  SettleNamedRangeMutationInput,
} from './types'
import { normalizeNamedRangeName } from './types'

export * from './types'

export const NAMED_RANGE_CACHE_MAX = 500
export const NAMED_RANGE_MUTATION_LEDGER_MAX = 32

const OPERATION_RESULT_UNCONFIRMED = '操作结果未确认'
const REGISTRY_RESULT_UNCONFIRMED = '名称列表未确认'

const INITIAL_CAPABILITY_STATE: NamedRangeCapabilityState = Object.freeze({
  status: 'idle',
  requestId: null,
  capabilities: null,
  error: null,
})

const INITIAL_REGISTRY_STATE: NamedRangeRegistryState = Object.freeze({
  status: 'idle',
  requestId: null,
  names: Object.freeze([]),
  error: null,
})

const INITIAL_MUTATION_STATE: NamedRangeMutationState = Object.freeze({
  status: 'idle',
  operationId: null,
  requestId: null,
  origin: null,
  sessionId: null,
  action: null,
  outcome: null,
  error: null,
})

type ReadCapabilitiesMethod = NonNullable<NamedRangeControllerPort['readNamedRangeCapabilities']>
type ListNamedRangesMethod = NonNullable<NamedRangeControllerPort['listNamedRanges']>
type SetNamedRangeMethod = NonNullable<NamedRangeControllerPort['setNamedRange']>
type DeleteNamedRangeMethod = NonNullable<NamedRangeControllerPort['deleteNamedRange']>
type MutationMethod = SetNamedRangeMethod | DeleteNamedRangeMethod

interface CapabilityTicket {
  readonly requestId: number
}

interface RegistryReadTicket {
  readonly requestId: number
  readonly capabilityRequestId: number
  readonly managerCloseWitness?: ManagerCloseWitness
}

interface ManagerCloseWitness {
  readonly sessionId: number
  readonly draftGeneration: number
}

interface RegistryReadReservationInput {
  readonly methodAvailable: boolean
  readonly managerCloseWitness?: ManagerCloseWitness
}

interface NamedRangeMutationTicket {
  readonly operationId: string
  readonly requestId: number
  readonly capabilityRequestId: number
  readonly origin: RunNamedRangeMutationInput['origin']
  readonly sessionId: number
  readonly managerDraftGeneration: number | null
  readonly action: NamedRangeMutationPayload['action']
  readonly name: string
  readonly scope: NamedRangeScope
  readonly bindingKind?: NamedRangeBindingKind
  readonly request: Readonly<SetNamedRangeRequest | DeleteNamedRangeRequest>
}

interface MutationReservationInput {
  readonly origin: RunNamedRangeMutationInput['origin']
  readonly sessionId: number
  readonly managerDraftGeneration: number | null
  readonly mutation: NamedRangeMutationPayload
  readonly mutationMethodAvailable: boolean
  readonly listMethodAvailable: boolean
}

interface TerminalMutationSettlement {
  readonly ticket: NamedRangeMutationTicket
  readonly outcome: NamedRangeMutationOutcome
  readonly revision?: number | string
}

const namedRangeCapabilityStateSourceAtom =
  atom<NamedRangeCapabilityState>(INITIAL_CAPABILITY_STATE)
namedRangeCapabilityStateSourceAtom.debugLabel = 'spreadsheet.namedRanges.capabilitySource'

const namedRangeCapabilitySequenceAtom = atom<number>(0)
namedRangeCapabilitySequenceAtom.debugLabel = 'spreadsheet.namedRanges.capabilitySequence'

const namedRangeRequestSequenceAtom = atom<number>(0)
namedRangeRequestSequenceAtom.debugLabel = 'spreadsheet.namedRanges.requestSequence'

const namedRangeRegistryStateSourceAtom = atom<NamedRangeRegistryState>(INITIAL_REGISTRY_STATE)
namedRangeRegistryStateSourceAtom.debugLabel = 'spreadsheet.namedRanges.registrySource'

const namedRangeMutationStateSourceAtom = atom<NamedRangeMutationState>(INITIAL_MUTATION_STATE)
namedRangeMutationStateSourceAtom.debugLabel = 'spreadsheet.namedRanges.mutationSource'

const namedRangeOperationAttemptLedgerSourceAtom = atom<readonly NamedRangeOperationAttempt[]>(
  Object.freeze([]),
)
namedRangeOperationAttemptLedgerSourceAtom.debugLabel =
  'spreadsheet.namedRanges.operationAttemptLedgerSource'

const activeNamedRangeMutationTicketAtom = atom<NamedRangeMutationTicket | null>(null)
activeNamedRangeMutationTicketAtom.debugLabel = 'spreadsheet.namedRanges.activeMutationTicket'

const lateNamedRangeSettlementAtom = atom<TerminalMutationSettlement | null>(null)
lateNamedRangeSettlementAtom.debugLabel = 'spreadsheet.namedRanges.lateSettlement'

export const namedRangeCapabilitiesAtom = atom((get) => get(namedRangeCapabilityStateSourceAtom))
namedRangeCapabilitiesAtom.debugLabel = 'spreadsheet.namedRanges.capabilities'

export const namedRangeRegistryStateAtom = atom((get) => get(namedRangeRegistryStateSourceAtom))
namedRangeRegistryStateAtom.debugLabel = 'spreadsheet.namedRanges.registryState'

export const nameRegistryCacheAtom = atom(
  (get) => get(namedRangeRegistryStateSourceAtom).names,
  (get, set, names: readonly NamedRange[]): void => {
    const snapshot = copyRegistry(names)
    const current = get(namedRangeRegistryStateSourceAtom)
    set(
      namedRangeRegistryStateSourceAtom,
      snapshot === null
        ? Object.freeze({
            ...current,
            status: 'projection-unknown',
            error: REGISTRY_RESULT_UNCONFIRMED,
          })
        : Object.freeze({
            ...current,
            status: 'ready',
            names: snapshot,
            error: null,
          }),
    )
  },
)
nameRegistryCacheAtom.debugLabel = 'spreadsheet.namedRanges.cache'

export const namedRangeMutationStateAtom = atom((get) => get(namedRangeMutationStateSourceAtom))
namedRangeMutationStateAtom.debugLabel = 'spreadsheet.namedRanges.mutationState'

export const namedRangeOperationAttemptLedgerAtom = atom((get) =>
  get(namedRangeOperationAttemptLedgerSourceAtom),
)
namedRangeOperationAttemptLedgerAtom.debugLabel = 'spreadsheet.namedRanges.operationAttemptLedger'

export const namedRangeMutationPendingAtom = atom((get): boolean => {
  const active = get(activeNamedRangeMutationTicketAtom)
  if (active === null) return false
  return get(namedRangeMutationStateSourceAtom).status === 'pending'
})
namedRangeMutationPendingAtom.debugLabel = 'spreadsheet.namedRanges.mutationPending'

export const namedRangeMutationBlockedAtom = atom((get): boolean => {
  if (get(namedRangeCapabilityStateSourceAtom).status !== 'ready') return true
  const registryStatus = get(namedRangeRegistryStateSourceAtom).status
  if (registryStatus === 'refreshing' || registryStatus === 'projection-unknown') return true
  if (get(activeNamedRangeMutationTicketAtom) !== null) return true
  const ledger = get(namedRangeOperationAttemptLedgerSourceAtom)
  if (
    ledger.some((attempt) => attempt.status === 'pending' || attempt.status === 'outcome-unknown')
  ) {
    return true
  }
  return ledger.length >= NAMED_RANGE_MUTATION_LEDGER_MAX && findOldestTerminal(ledger) < 0
})
namedRangeMutationBlockedAtom.debugLabel = 'spreadsheet.namedRanges.mutationBlocked'

const CLOSED_NAME_MANAGER_EDITOR_STATE: NameManagerEditorState = Object.freeze({
  status: 'closed',
})

export const nameManagerEditorAtom = atom<NameManagerEditorState>(CLOSED_NAME_MANAGER_EDITOR_STATE)
nameManagerEditorAtom.debugLabel = 'spreadsheet.namedRanges.editor'

export type NameManagerKind = 'range' | 'value' | 'lambda'

const nameManagerDraftGenerationSourceAtom = atom<number>(0)
nameManagerDraftGenerationSourceAtom.debugLabel =
  'spreadsheet.namedRanges.managerDraftGenerationSource'

export const nameManagerDraftGenerationAtom = atom((get) =>
  get(nameManagerDraftGenerationSourceAtom),
)
nameManagerDraftGenerationAtom.debugLabel = 'spreadsheet.namedRanges.managerDraftGeneration'

const nameManagerKindDraftSourceAtom = atom<NameManagerKind>('range')
const nameManagerParamsDraftSourceAtom = atom<string>('')
const nameManagerRefersToDraftSourceAtom = atom<string>('')
const nameManagerNameDraftSourceAtom = atom<string>('')
const nameManagerScopeDraftSourceAtom = atom<string>('workbook')

export const nameManagerKindDraftAtom = atom(
  (get) => get(nameManagerKindDraftSourceAtom),
  (get, set, value: NameManagerKind): void => {
    if (Object.is(get(nameManagerKindDraftSourceAtom), value)) return
    set(nameManagerKindDraftSourceAtom, value)
    bumpManagerDraftGeneration(get, set)
  },
)
nameManagerKindDraftAtom.debugLabel = 'spreadsheet.namedRanges.kindDraft'

export const nameManagerParamsDraftAtom = atom(
  (get) => get(nameManagerParamsDraftSourceAtom),
  (get, set, value: string): void => {
    if (Object.is(get(nameManagerParamsDraftSourceAtom), value)) return
    set(nameManagerParamsDraftSourceAtom, value)
    bumpManagerDraftGeneration(get, set)
  },
)
nameManagerParamsDraftAtom.debugLabel = 'spreadsheet.namedRanges.paramsDraft'

export const nameManagerRefersToDraftAtom = atom(
  (get) => get(nameManagerRefersToDraftSourceAtom),
  (get, set, value: string): void => {
    if (Object.is(get(nameManagerRefersToDraftSourceAtom), value)) return
    set(nameManagerRefersToDraftSourceAtom, value)
    bumpManagerDraftGeneration(get, set)
  },
)
nameManagerRefersToDraftAtom.debugLabel = 'spreadsheet.namedRanges.refersToDraft'

export const nameManagerNameDraftAtom = atom(
  (get) => get(nameManagerNameDraftSourceAtom),
  (get, set, value: string): void => {
    if (Object.is(get(nameManagerNameDraftSourceAtom), value)) return
    set(nameManagerNameDraftSourceAtom, value)
    bumpManagerDraftGeneration(get, set)
  },
)
nameManagerNameDraftAtom.debugLabel = 'spreadsheet.namedRanges.nameDraft'

export const nameManagerScopeDraftAtom = atom(
  (get) => get(nameManagerScopeDraftSourceAtom),
  (get, set, value: string): void => {
    if (Object.is(get(nameManagerScopeDraftSourceAtom), value)) return
    set(nameManagerScopeDraftSourceAtom, value)
    bumpManagerDraftGeneration(get, set)
  },
)
nameManagerScopeDraftAtom.debugLabel = 'spreadsheet.namedRanges.scopeDraft'

export const nameManagerSessionIdAtom = atom<number>(0)
nameManagerSessionIdAtom.debugLabel = 'spreadsheet.namedRanges.managerSessionId'

const nameManagerSelectedEntrySourceAtom = atom<NamedRange | null>(null)
nameManagerSelectedEntrySourceAtom.debugLabel = 'spreadsheet.namedRanges.managerSelectedEntrySource'

export const nameManagerSelectedEntryAtom = atom(
  (get) => get(nameManagerSelectedEntrySourceAtom),
  (get, set, value: NamedRange | null): void => {
    if (Object.is(get(nameManagerSelectedEntrySourceAtom), value)) return
    const snapshot = value === null ? null : copyNamedRange(value)
    if (value !== null && snapshot === null) return
    set(nameManagerSelectedEntrySourceAtom, snapshot)
    bumpManagerDraftGeneration(get, set)
  },
)
nameManagerSelectedEntryAtom.debugLabel = 'spreadsheet.namedRanges.managerSelectedEntry'

function nextSequence(current: number): number | null {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    return null
  }
  return current + 1
}

function nextSessionId(current: number): number {
  return Number.isSafeInteger(current) && current >= 0 && current < Number.MAX_SAFE_INTEGER
    ? current + 1
    : 1
}

function bumpManagerDraftGeneration(get: Getter, set: Setter): void {
  set(
    nameManagerDraftGenerationSourceAtom,
    nextSessionId(get(nameManagerDraftGenerationSourceAtom)),
  )
}

function copyScope(scope: NamedRangeScope): NamedRangeScope | null {
  if (scope === 'workbook') return 'workbook'
  if (
    typeof scope !== 'object' ||
    scope === null ||
    typeof scope.sheetId !== 'string' ||
    scope.sheetId.trim().length === 0
  ) {
    return null
  }
  return Object.freeze({ sheetId: scope.sheetId })
}

function copyRefersTo(refersTo: NamedRangeRefersTo): NamedRangeRefersTo | null {
  if (typeof refersTo !== 'object' || refersTo === null) return null
  switch (refersTo.kind) {
    case 'range': {
      if (
        typeof refersTo.sheetId !== 'string' ||
        refersTo.sheetId.trim().length === 0 ||
        typeof refersTo.address !== 'string' ||
        refersTo.address.trim().length === 0
      ) {
        return null
      }
      return Object.freeze({
        kind: 'range',
        sheetId: refersTo.sheetId,
        address: refersTo.address,
      })
    }
    case 'constant': {
      if (typeof refersTo.value !== 'string') return null
      return Object.freeze({ kind: 'constant', value: refersTo.value })
    }
    case 'lambda': {
      if (!Array.isArray(refersTo.params) || typeof refersTo.body !== 'string') return null
      const params: string[] = []
      const seen = new Set<string>()
      for (const value of refersTo.params) {
        const param = typeof value === 'string' ? normalizeNamedRangeName(value) : null
        if (param === null) return null
        const identity = param.toUpperCase()
        if (seen.has(identity)) return null
        seen.add(identity)
        params.push(param)
      }
      if (refersTo.body.trim().length === 0) return null
      return Object.freeze({
        kind: 'lambda',
        params: Object.freeze(params) as unknown as string[],
        body: refersTo.body,
      })
    }
    default:
      return null
  }
}

function copyNamedRange(entry: NamedRange): NamedRange | null {
  if (typeof entry !== 'object' || entry === null) return null
  const name = typeof entry.name === 'string' ? normalizeNamedRangeName(entry.name) : null
  const scope = copyScope(entry.scope)
  const refersTo = copyRefersTo(entry.refersTo)
  if (name === null || scope === null || refersTo === null) return null
  return Object.freeze({ name, scope, refersTo })
}

function copyRegistry(names: readonly NamedRange[]): readonly NamedRange[] | null {
  if (!Array.isArray(names)) return null
  const start = Math.max(0, names.length - NAMED_RANGE_CACHE_MAX)
  const snapshot: NamedRange[] = []
  for (let index = start; index < names.length; index += 1) {
    const entry = copyNamedRange(names[index])
    if (entry === null) return null
    snapshot.push(entry)
  }
  return Object.freeze(snapshot)
}

interface OptionalRevisionSnapshot {
  readonly present: boolean
  readonly value?: number | string
}

const ABSENT_REVISION_SNAPSHOT: OptionalRevisionSnapshot = Object.freeze({ present: false })

function copyOptionalRevision(container: object): OptionalRevisionSnapshot | null {
  let present: boolean
  let value: unknown
  try {
    present = Object.prototype.hasOwnProperty.call(container, 'revision')
    if (!present) return ABSENT_REVISION_SNAPSHOT
    value = (container as { readonly revision?: unknown }).revision
  } catch {
    return null
  }
  if (typeof value === 'string') return Object.freeze({ present: true, value })
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Object.freeze({ present: true, value })
  }
  return null
}

function readyRegistryState(
  requestId: number | null,
  names: readonly NamedRange[],
  revision: OptionalRevisionSnapshot,
): NamedRangeRegistryState {
  const state = {
    status: 'ready' as const,
    requestId,
    names,
    error: null,
  }
  return Object.freeze(revision.present ? { ...state, revision: revision.value! } : state)
}

function copyMutationResult(result: NamedRangeMutationResult): NamedRangeMutationResult | null {
  if (typeof result !== 'object' || result === null) return null
  try {
    const requestId = result.requestId
    const outcome = result.outcome
    const revision = copyOptionalRevision(result)
    if (
      !Number.isSafeInteger(requestId) ||
      (outcome !== 'w0-acknowledged' && outcome !== 'confirmed-not-applied') ||
      revision === null
    ) {
      return null
    }
    const snapshot = { requestId, outcome }
    return Object.freeze(revision.present ? { ...snapshot, revision: revision.value! } : snapshot)
  } catch {
    return null
  }
}

function copyCapabilities(
  value: NamedRangeBackendCapabilities,
): NamedRangeBackendCapabilities | null {
  if (typeof value !== 'object' || value === null) return null
  if (
    value.runtime !== 'static-session' &&
    value.runtime !== 'worker-ts' &&
    value.runtime !== 'worker-wasm'
  ) {
    return null
  }
  if (!Array.isArray(value.scopes)) return null
  const scopes: ('workbook' | 'sheet')[] = []
  for (const scope of value.scopes) {
    if (scope !== 'workbook' && scope !== 'sheet') return null
    if (!scopes.includes(scope)) scopes.push(scope)
  }
  if (
    typeof value.bindings !== 'object' ||
    value.bindings === null ||
    typeof value.bindings.range !== 'boolean' ||
    typeof value.bindings.constant !== 'boolean' ||
    typeof value.bindings.lambda !== 'boolean' ||
    typeof value.delete !== 'boolean' ||
    typeof value.namesWitness !== 'boolean'
  ) {
    return null
  }
  if (
    value.rangeSemantics !== 'stored-definition' &&
    value.rangeSemantics !== 'live-reference' &&
    value.rangeSemantics !== 'unsupported'
  ) {
    return null
  }
  if (
    value.listAuthority !== 'static-session-registry' &&
    value.listAuthority !== 'adapter-post-ack-overlay'
  ) {
    return null
  }
  if (
    value.definitionReadback !== 'full' &&
    value.definitionReadback !== 'names-only' &&
    value.definitionReadback !== 'none'
  ) {
    return null
  }
  if (
    value.mutationAck !== 'session-registry-accepted' &&
    value.mutationAck !== 'engine-accepted' &&
    value.mutationAck !== 'engine-names-witnessed'
  ) {
    return null
  }
  if (value.durability !== 'session-local') return null
  return Object.freeze({
    runtime: value.runtime,
    scopes: Object.freeze(scopes),
    bindings: Object.freeze({
      range: value.bindings.range,
      constant: value.bindings.constant,
      lambda: value.bindings.lambda,
    }),
    delete: value.delete,
    rangeSemantics: value.rangeSemantics,
    listAuthority: value.listAuthority,
    definitionReadback: value.definitionReadback,
    namesWitness: value.namesWitness,
    mutationAck: value.mutationAck,
    durability: value.durability,
  })
}

function freezeAttempt(attempt: NamedRangeOperationAttempt): NamedRangeOperationAttempt {
  return Object.freeze({
    ...attempt,
    scope: copyScope(attempt.scope) ?? 'workbook',
  })
}

function freezeLedger(
  attempts: readonly NamedRangeOperationAttempt[],
): readonly NamedRangeOperationAttempt[] {
  return Object.freeze(attempts.slice())
}

function findOldestTerminal(attempts: readonly NamedRangeOperationAttempt[]): number {
  return attempts.findIndex(
    (attempt) => attempt.status === 'acknowledged' || attempt.status === 'confirmed-not-applied',
  )
}

function reserveAttemptSlot(
  attempts: readonly NamedRangeOperationAttempt[],
): readonly NamedRangeOperationAttempt[] | null {
  if (attempts.length < NAMED_RANGE_MUTATION_LEDGER_MAX) return attempts
  const terminalIndex = findOldestTerminal(attempts)
  if (terminalIndex < 0) return null
  return Object.freeze([...attempts.slice(0, terminalIndex), ...attempts.slice(terminalIndex + 1)])
}

function supportsMutation(
  capabilities: NamedRangeBackendCapabilities,
  mutation: NamedRangeMutationPayload,
): boolean {
  const scopeKind = mutation.scope === 'workbook' ? 'workbook' : 'sheet'
  if (!capabilities.scopes.includes(scopeKind)) return false
  if (mutation.action === 'delete') return capabilities.delete
  if (!capabilities.bindings[mutation.refersTo.kind]) return false
  return mutation.refersTo.kind !== 'range' || capabilities.rangeSemantics !== 'unsupported'
}

function copyMutation(
  mutation: NamedRangeMutationPayload,
  requestId: number,
): {
  readonly name: string
  readonly scope: NamedRangeScope
  readonly bindingKind?: NamedRangeBindingKind
  readonly request: Readonly<SetNamedRangeRequest | DeleteNamedRangeRequest>
} | null {
  if (typeof mutation !== 'object' || mutation === null) return null
  const name = typeof mutation.name === 'string' ? normalizeNamedRangeName(mutation.name) : null
  const scope = copyScope(mutation.scope)
  if (name === null || scope === null) return null
  if (mutation.action === 'delete') {
    return Object.freeze({
      name,
      scope,
      request: Object.freeze({
        kind: 'delete-named-range',
        name,
        scope,
        requestId,
      }),
    })
  }
  if (mutation.action !== 'set') return null
  const refersTo = copyRefersTo(mutation.refersTo)
  if (refersTo === null) return null
  return Object.freeze({
    name,
    scope,
    bindingKind: refersTo.kind,
    request: Object.freeze({
      kind: 'set-named-range',
      name,
      scope,
      refersTo,
      requestId,
    }),
  })
}

function blockedMutationState(error: string): NamedRangeMutationState {
  return Object.freeze({
    status: 'blocked',
    operationId: null,
    requestId: null,
    origin: null,
    sessionId: null,
    action: null,
    outcome: null,
    error,
  })
}

const reserveCapabilityReadAtom = atom(null, (get, set): CapabilityTicket | null => {
  const next = nextSequence(get(namedRangeCapabilitySequenceAtom))
  if (next === null) {
    set(
      namedRangeCapabilityStateSourceAtom,
      Object.freeze({
        status: 'unavailable',
        requestId: null,
        capabilities: null,
        error: '名称能力不可用',
      }),
    )
    return null
  }
  const ticket: CapabilityTicket = Object.freeze({ requestId: next })
  set(namedRangeCapabilitySequenceAtom, next)
  set(
    namedRangeCapabilityStateSourceAtom,
    Object.freeze({
      status: 'loading',
      requestId: ticket.requestId,
      capabilities: null,
      error: null,
    }),
  )
  return ticket
})

const settleCapabilityReadAtom = atom(
  null,
  (
    get,
    set,
    input: {
      readonly ticket: CapabilityTicket
      readonly capabilities: NamedRangeBackendCapabilities | null
    },
  ): void => {
    const current = get(namedRangeCapabilityStateSourceAtom)
    if (current.requestId !== input.ticket.requestId || current.status !== 'loading') return
    set(
      namedRangeCapabilityStateSourceAtom,
      input.capabilities === null
        ? Object.freeze({
            status: 'unavailable',
            requestId: input.ticket.requestId,
            capabilities: null,
            error: '名称能力不可用',
          })
        : Object.freeze({
            status: 'ready',
            requestId: input.ticket.requestId,
            capabilities: input.capabilities,
            error: null,
          }),
    )
  },
)

async function executeCapabilityRead(
  set: Setter,
  ticket: CapabilityTicket,
  receiver: NamedRangeControllerPort,
  execute: ReadCapabilitiesMethod | undefined,
): Promise<void> {
  if (execute === undefined) {
    set(settleCapabilityReadAtom, { ticket, capabilities: null })
    return
  }
  let value: NamedRangeBackendCapabilities
  try {
    value = await Reflect.apply(execute, receiver, [])
  } catch {
    set(settleCapabilityReadAtom, { ticket, capabilities: null })
    return
  }
  set(settleCapabilityReadAtom, { ticket, capabilities: copyCapabilities(value) })
}

export const loadNamedRangeCapabilitiesAtom = atom(
  null,
  (_get, set, input: LoadNamedRangeCapabilitiesInput): void => {
    const receiver = input.source
    const method = receiver.readNamedRangeCapabilities
    const execute = typeof method === 'function' ? method : undefined
    const ticket = set(reserveCapabilityReadAtom)
    if (ticket === null) return
    void Promise.resolve().then(() => executeCapabilityRead(set, ticket, receiver, execute))
  },
)
loadNamedRangeCapabilitiesAtom.debugLabel = 'spreadsheet.namedRanges.loadCapabilities'

const reserveRegistryReadAtom = atom(
  null,
  (get, set, input: RegistryReadReservationInput): RegistryReadTicket | null => {
    const capability = get(namedRangeCapabilityStateSourceAtom)
    if (capability.status !== 'ready' || capability.requestId === null) return null
    if (!input.methodAvailable) {
      const current = get(namedRangeRegistryStateSourceAtom)
      set(
        namedRangeRegistryStateSourceAtom,
        Object.freeze({
          ...current,
          status: 'projection-unknown',
          error: REGISTRY_RESULT_UNCONFIRMED,
        }),
      )
      return null
    }
    const next = nextSequence(get(namedRangeRequestSequenceAtom))
    if (next === null) {
      const current = get(namedRangeRegistryStateSourceAtom)
      set(
        namedRangeRegistryStateSourceAtom,
        Object.freeze({
          ...current,
          status: 'projection-unknown',
          error: REGISTRY_RESULT_UNCONFIRMED,
        }),
      )
      return null
    }
    const ticket: RegistryReadTicket = Object.freeze({
      requestId: next,
      capabilityRequestId: capability.requestId,
      ...(input.managerCloseWitness === undefined
        ? {}
        : {
            managerCloseWitness: Object.freeze({
              sessionId: input.managerCloseWitness.sessionId,
              draftGeneration: input.managerCloseWitness.draftGeneration,
            }),
          }),
    })
    const current = get(namedRangeRegistryStateSourceAtom)
    set(namedRangeRequestSequenceAtom, next)
    set(
      namedRangeRegistryStateSourceAtom,
      Object.freeze({
        ...current,
        status: 'refreshing',
        requestId: ticket.requestId,
        error: null,
      }),
    )
    return ticket
  },
)

const settleRegistryReadAtom = atom(
  null,
  (
    get,
    set,
    input: {
      readonly ticket: RegistryReadTicket
      readonly result: NamedRangeListResult | null
    },
  ): void => {
    const current = get(namedRangeRegistryStateSourceAtom)
    const capability = get(namedRangeCapabilityStateSourceAtom)
    if (
      capability.status !== 'ready' ||
      capability.requestId !== input.ticket.capabilityRequestId
    ) {
      return
    }
    if (current.requestId !== input.ticket.requestId || current.status !== 'refreshing') return
    let names: readonly NamedRange[] | null = null
    let revision: OptionalRevisionSnapshot | null = null
    try {
      if (input.result !== null && input.result.requestId === input.ticket.requestId) {
        names = copyRegistry(input.result.names)
        revision = copyOptionalRevision(input.result)
      }
    } catch {
      names = null
      revision = null
    }
    if (names === null || revision === null) {
      set(
        namedRangeRegistryStateSourceAtom,
        Object.freeze({
          ...current,
          status: 'projection-unknown',
          error: REGISTRY_RESULT_UNCONFIRMED,
        }),
      )
      return
    }
    set(
      namedRangeRegistryStateSourceAtom,
      readyRegistryState(input.ticket.requestId, names, revision),
    )
    closeOwnedManagerSessionAfterRefresh(get, set, input.ticket)
  },
)

async function executeRegistryRead(
  set: Setter,
  ticket: RegistryReadTicket,
  receiver: NamedRangeControllerPort,
  execute: ListNamedRangesMethod,
): Promise<void> {
  let result: NamedRangeListResult | null = null
  try {
    result = await Reflect.apply(execute, receiver, [
      { kind: 'list-named-ranges', requestId: ticket.requestId },
    ])
  } catch {
    result = null
  }
  set(settleRegistryReadAtom, { ticket, result })
}

function scheduleCapturedRegistryRead(
  set: Setter,
  receiver: NamedRangeControllerPort,
  execute: ListNamedRangesMethod | undefined,
  managerCloseWitness?: ManagerCloseWitness,
): void {
  const ticket = set(reserveRegistryReadAtom, {
    methodAvailable: execute !== undefined,
    managerCloseWitness,
  })
  if (ticket === null || execute === undefined) return
  void Promise.resolve().then(() => executeRegistryRead(set, ticket, receiver, execute))
}

export const refreshNamedRangeRegistryAtom = atom(
  null,
  (_get, set, input: RefreshNamedRangeRegistryInput): void => {
    const receiver = input.source
    const method = receiver.listNamedRanges
    const execute = typeof method === 'function' ? method : undefined
    scheduleCapturedRegistryRead(set, receiver, execute)
  },
)
refreshNamedRangeRegistryAtom.debugLabel = 'spreadsheet.namedRanges.refreshRegistry'

export const setNameRegistryAtom = atom(
  (get) => get(nameRegistryCacheAtom),
  (get, set, result: NamedRangeListResult): void => {
    let names: readonly NamedRange[] | null = null
    let revision: OptionalRevisionSnapshot | null = null
    try {
      if (typeof result === 'object' && result !== null) {
        names = copyRegistry(result.names)
        revision = copyOptionalRevision(result)
      }
    } catch {
      names = null
      revision = null
    }
    const current = get(namedRangeRegistryStateSourceAtom)
    set(
      namedRangeRegistryStateSourceAtom,
      names === null || revision === null
        ? Object.freeze({
            ...current,
            status: 'projection-unknown',
            error: REGISTRY_RESULT_UNCONFIRMED,
          })
        : readyRegistryState(current.requestId, names, revision),
    )
  },
)
setNameRegistryAtom.debugLabel = 'spreadsheet.namedRanges.setRegistry'

const reserveNamedRangeMutationAtom = atom(
  null,
  (get, set, input: MutationReservationInput): NamedRangeMutationTicket | null => {
    if (get(activeNamedRangeMutationTicketAtom) !== null) return null
    const ledger = get(namedRangeOperationAttemptLedgerSourceAtom)
    if (
      ledger.some((attempt) => attempt.status === 'pending' || attempt.status === 'outcome-unknown')
    ) {
      return null
    }
    const capabilityState = get(namedRangeCapabilityStateSourceAtom)
    const capabilities = capabilityState.capabilities
    if (
      capabilities === null ||
      capabilityState.status !== 'ready' ||
      capabilityState.requestId === null
    ) {
      set(namedRangeMutationStateSourceAtom, blockedMutationState('名称能力不可用'))
      return null
    }
    const registryStatus = get(namedRangeRegistryStateSourceAtom).status
    if (registryStatus === 'refreshing' || registryStatus === 'projection-unknown') {
      set(
        namedRangeMutationStateSourceAtom,
        blockedMutationState(
          registryStatus === 'refreshing' ? '名称列表正在刷新' : REGISTRY_RESULT_UNCONFIRMED,
        ),
      )
      return null
    }
    if (!input.mutationMethodAvailable || !input.listMethodAvailable) {
      set(namedRangeMutationStateSourceAtom, blockedMutationState('当前名称操作不可用'))
      return null
    }
    if (!supportsMutation(capabilities, input.mutation)) {
      set(namedRangeMutationStateSourceAtom, blockedMutationState('当前名称操作不受支持'))
      return null
    }
    const reservedLedger = reserveAttemptSlot(ledger)
    if (reservedLedger === null) {
      set(namedRangeMutationStateSourceAtom, blockedMutationState('名称操作记录已满'))
      return null
    }
    const requestId = nextSequence(get(namedRangeRequestSequenceAtom))
    if (requestId === null || ledger.some((attempt) => attempt.requestId === requestId)) {
      set(namedRangeMutationStateSourceAtom, blockedMutationState(OPERATION_RESULT_UNCONFIRMED))
      return null
    }
    const mutation = copyMutation(input.mutation, requestId)
    if (mutation === null) {
      set(namedRangeMutationStateSourceAtom, blockedMutationState('名称或引用无效'))
      return null
    }
    const operationId = `named-range-${requestId}`
    const ticket: NamedRangeMutationTicket = Object.freeze({
      operationId,
      requestId,
      capabilityRequestId: capabilityState.requestId,
      origin: input.origin,
      sessionId: input.sessionId,
      managerDraftGeneration: input.managerDraftGeneration,
      action: input.mutation.action,
      name: mutation.name,
      scope: mutation.scope,
      bindingKind: mutation.bindingKind,
      request: mutation.request,
    })
    const attempt = freezeAttempt({
      operationId,
      requestId,
      origin: input.origin,
      sessionId: input.sessionId,
      action: input.mutation.action,
      name: mutation.name,
      scope: mutation.scope,
      bindingKind: mutation.bindingKind,
      status: 'pending',
      error: null,
    })
    set(namedRangeRequestSequenceAtom, requestId)
    set(namedRangeOperationAttemptLedgerSourceAtom, freezeLedger([...reservedLedger, attempt]))
    set(activeNamedRangeMutationTicketAtom, ticket)
    set(
      namedRangeMutationStateSourceAtom,
      Object.freeze({
        status: 'pending',
        operationId,
        requestId,
        origin: input.origin,
        sessionId: input.sessionId,
        action: input.mutation.action,
        outcome: null,
        error: null,
      }),
    )
    return ticket
  },
)

const guardNamedRangeMutationTransportAtom = atom(
  null,
  (get, set, ticket: NamedRangeMutationTicket): boolean => {
    if (get(activeNamedRangeMutationTicketAtom) !== ticket) return false
    const isPending = get(namedRangeOperationAttemptLedgerSourceAtom).some(
      (attempt) => attempt.operationId === ticket.operationId && attempt.status === 'pending',
    )
    if (!isPending) return false
    const capability = get(namedRangeCapabilityStateSourceAtom)
    if (capability.status === 'ready' && capability.requestId === ticket.capabilityRequestId) {
      return true
    }
    const error = '工作簿上下文已变化'
    set(
      namedRangeOperationAttemptLedgerSourceAtom,
      replaceAttemptStatus(
        get(namedRangeOperationAttemptLedgerSourceAtom),
        ticket,
        'confirmed-not-applied',
        error,
      ),
    )
    set(activeNamedRangeMutationTicketAtom, null)
    set(
      namedRangeMutationStateSourceAtom,
      Object.freeze({
        status: 'confirmed-not-applied',
        operationId: ticket.operationId,
        requestId: ticket.requestId,
        origin: ticket.origin,
        sessionId: ticket.sessionId,
        action: ticket.action,
        outcome: 'confirmed-not-applied',
        error,
      }),
    )
    return false
  },
)

function replaceAttemptStatus(
  attempts: readonly NamedRangeOperationAttempt[],
  ticket: NamedRangeMutationTicket,
  status: Exclude<NamedRangeOperationAttemptStatus, 'pending'>,
  error: string | null,
  revision?: number | string,
): readonly NamedRangeOperationAttempt[] {
  let changed = false
  const next = attempts.map((attempt) => {
    if (attempt.operationId !== ticket.operationId) return attempt
    changed = true
    const snapshot = { ...attempt }
    delete snapshot.revision
    return freezeAttempt(
      revision === undefined
        ? { ...snapshot, status, error }
        : { ...snapshot, status, revision, error },
    )
  })
  return changed ? freezeLedger(next) : attempts
}

const markNamedRangeMutationUnknownAtom = atom(
  null,
  (get, set, ticket: NamedRangeMutationTicket): void => {
    if (get(activeNamedRangeMutationTicketAtom) !== ticket) return
    set(
      namedRangeOperationAttemptLedgerSourceAtom,
      replaceAttemptStatus(
        get(namedRangeOperationAttemptLedgerSourceAtom),
        ticket,
        'outcome-unknown',
        OPERATION_RESULT_UNCONFIRMED,
      ),
    )
    set(
      namedRangeMutationStateSourceAtom,
      Object.freeze({
        status: 'outcome-unknown',
        operationId: ticket.operationId,
        requestId: ticket.requestId,
        origin: ticket.origin,
        sessionId: ticket.sessionId,
        action: ticket.action,
        outcome: null,
        error: OPERATION_RESULT_UNCONFIRMED,
      }),
    )
  },
)

function closeOwnedManagerSessionAfterRefresh(
  get: Getter,
  set: Setter,
  ticket: RegistryReadTicket,
): void {
  const witness = ticket.managerCloseWitness
  if (witness === undefined) return
  const capability = get(namedRangeCapabilityStateSourceAtom)
  if (capability.status !== 'ready' || capability.requestId !== ticket.capabilityRequestId) {
    return
  }
  if (get(activeNamedRangeMutationTicketAtom) !== null) return
  if (get(nameManagerSessionIdAtom) !== witness.sessionId) return
  if (get(nameManagerDraftGenerationSourceAtom) !== witness.draftGeneration) return
  if (get(nameManagerEditorAtom).status === 'closed') return
  set(nameManagerSessionIdAtom, nextSessionId(witness.sessionId))
  set(nameManagerEditorAtom, CLOSED_NAME_MANAGER_EDITOR_STATE)
  set(nameManagerSelectedEntrySourceAtom, null)
  setManagerDraftAtoms(get, set, undefined)
}

function managerCloseWitnessForMutation(
  ticket: NamedRangeMutationTicket,
): ManagerCloseWitness | undefined {
  if (ticket.origin !== 'name-manager' || ticket.managerDraftGeneration === null) {
    return undefined
  }
  return Object.freeze({
    sessionId: ticket.sessionId,
    draftGeneration: ticket.managerDraftGeneration,
  })
}

const settleNamedRangeMutationResultAtom = atom(
  null,
  (
    get,
    set,
    input: {
      readonly ticket: NamedRangeMutationTicket
      readonly result: NamedRangeMutationResult
    },
  ): NamedRangeMutationOutcome | null => {
    if (get(activeNamedRangeMutationTicketAtom) !== input.ticket) return null
    const result = copyMutationResult(input.result)
    if (result === null || result.requestId !== input.ticket.requestId) {
      set(markNamedRangeMutationUnknownAtom, input.ticket)
      return null
    }
    const outcome = result.outcome!
    const status: NamedRangeOperationAttemptStatus =
      outcome === 'w0-acknowledged' ? 'acknowledged' : 'confirmed-not-applied'
    set(
      namedRangeOperationAttemptLedgerSourceAtom,
      replaceAttemptStatus(
        get(namedRangeOperationAttemptLedgerSourceAtom),
        input.ticket,
        status,
        null,
        result.revision,
      ),
    )
    set(activeNamedRangeMutationTicketAtom, null)
    set(
      namedRangeMutationStateSourceAtom,
      Object.freeze({
        status,
        operationId: input.ticket.operationId,
        requestId: input.ticket.requestId,
        origin: input.ticket.origin,
        sessionId: input.ticket.sessionId,
        action: input.ticket.action,
        outcome,
        error: null,
      }),
    )
    return outcome
  },
)

const namedRangeMutationGenerationIsCurrentAtom = atom(
  null,
  (get, _set, ticket: NamedRangeMutationTicket): boolean => {
    const capability = get(namedRangeCapabilityStateSourceAtom)
    return capability.status === 'ready' && capability.requestId === ticket.capabilityRequestId
  },
)

function copyMutationRequest(
  request: Readonly<SetNamedRangeRequest | DeleteNamedRangeRequest>,
): SetNamedRangeRequest | DeleteNamedRangeRequest {
  const scope = copyScope(request.scope) ?? 'workbook'
  if (request.kind === 'delete-named-range') {
    return {
      kind: request.kind,
      name: request.name,
      scope,
      requestId: request.requestId,
    }
  }
  return {
    kind: request.kind,
    name: request.name,
    scope,
    refersTo: copyRefersTo(request.refersTo)!,
    requestId: request.requestId,
  }
}

async function executeNamedRangeMutation(
  set: Setter,
  ticket: NamedRangeMutationTicket,
  receiver: NamedRangeControllerPort,
  execute: MutationMethod,
  list: ListNamedRangesMethod,
): Promise<void> {
  if (!set(guardNamedRangeMutationTransportAtom, ticket)) return
  let result: NamedRangeMutationResult
  try {
    result = await Reflect.apply(execute, receiver, [copyMutationRequest(ticket.request)])
  } catch {
    set(markNamedRangeMutationUnknownAtom, ticket)
    return
  }
  const outcome = set(settleNamedRangeMutationResultAtom, { ticket, result })
  if (outcome === 'w0-acknowledged' && set(namedRangeMutationGenerationIsCurrentAtom, ticket)) {
    scheduleCapturedRegistryRead(set, receiver, list, managerCloseWitnessForMutation(ticket))
  }
}

export const runNamedRangeMutationAtom = atom(
  null,
  (get, set, input: RunNamedRangeMutationInput): void => {
    const managerSessionId = get(nameManagerSessionIdAtom)
    if (
      input.origin === 'name-manager' &&
      input.sessionId !== undefined &&
      input.sessionId !== managerSessionId
    ) {
      return
    }
    const receiver = input.source
    const mutationMethod =
      input.mutation.action === 'set' ? receiver.setNamedRange : receiver.deleteNamedRange
    const execute = typeof mutationMethod === 'function' ? mutationMethod : undefined
    const listMethod = receiver.listNamedRanges
    const list = typeof listMethod === 'function' ? listMethod : undefined
    const sessionId = input.sessionId ?? (input.origin === 'name-manager' ? managerSessionId : 0)
    const ticket = set(reserveNamedRangeMutationAtom, {
      origin: input.origin,
      sessionId,
      managerDraftGeneration:
        input.origin === 'name-manager' ? get(nameManagerDraftGenerationSourceAtom) : null,
      mutation: input.mutation,
      mutationMethodAvailable: execute !== undefined,
      listMethodAvailable: list !== undefined,
    })
    if (ticket === null || execute === undefined || list === undefined) return
    void Promise.resolve().then(() =>
      executeNamedRangeMutation(set, ticket, receiver, execute, list),
    )
  },
)
runNamedRangeMutationAtom.debugLabel = 'spreadsheet.namedRanges.runMutation'

const reserveLateNamedRangeSettlementAtom = atom(
  null,
  (get, set, result: NamedRangeMutationResult): TerminalMutationSettlement | null => {
    if (get(lateNamedRangeSettlementAtom) !== null) return null
    const ticket = get(activeNamedRangeMutationTicketAtom)
    if (ticket === null) return null
    const state = get(namedRangeMutationStateSourceAtom)
    if (state.status !== 'outcome-unknown' || state.requestId !== ticket.requestId) return null
    const snapshot = copyMutationResult(result)
    if (snapshot === null || snapshot.requestId !== ticket.requestId) return null
    const settlementBase = {
      ticket,
      outcome: snapshot.outcome!,
    }
    const settlement: TerminalMutationSettlement = Object.freeze(
      snapshot.revision === undefined
        ? settlementBase
        : { ...settlementBase, revision: snapshot.revision },
    )
    set(lateNamedRangeSettlementAtom, settlement)
    return settlement
  },
)

const applyLateNamedRangeSettlementAtom = atom(
  null,
  (get, set, settlement: TerminalMutationSettlement): NamedRangeMutationOutcome | null => {
    if (get(lateNamedRangeSettlementAtom) !== settlement) return null
    set(lateNamedRangeSettlementAtom, null)
    const result: NamedRangeMutationResult =
      settlement.revision === undefined
        ? {
            requestId: settlement.ticket.requestId,
            outcome: settlement.outcome,
          }
        : {
            requestId: settlement.ticket.requestId,
            outcome: settlement.outcome,
            revision: settlement.revision,
          }
    return set(settleNamedRangeMutationResultAtom, {
      ticket: settlement.ticket,
      result,
    })
  },
)

function executeLateNamedRangeSettlement(
  set: Setter,
  settlement: TerminalMutationSettlement,
  receiver: NamedRangeControllerPort,
  list: ListNamedRangesMethod | undefined,
): void {
  const outcome = set(applyLateNamedRangeSettlementAtom, settlement)
  if (
    outcome === 'w0-acknowledged' &&
    set(namedRangeMutationGenerationIsCurrentAtom, settlement.ticket)
  ) {
    scheduleCapturedRegistryRead(
      set,
      receiver,
      list,
      managerCloseWitnessForMutation(settlement.ticket),
    )
  }
}

export const settleNamedRangeMutationAtom = atom(
  null,
  (_get, set, input: SettleNamedRangeMutationInput): void => {
    const receiver = input.source
    const listMethod = receiver.listNamedRanges
    const list = typeof listMethod === 'function' ? listMethod : undefined
    const settlement = set(reserveLateNamedRangeSettlementAtom, input.result)
    if (settlement === null) return
    void Promise.resolve().then(() =>
      executeLateNamedRangeSettlement(set, settlement, receiver, list),
    )
  },
)
settleNamedRangeMutationAtom.debugLabel = 'spreadsheet.namedRanges.settleMutation'

function setManagerDraftAtoms(get: Getter, set: Setter, draft: NamedRange | undefined): void {
  if (draft === undefined) {
    set(nameManagerKindDraftSourceAtom, 'range')
    set(nameManagerParamsDraftSourceAtom, '')
    set(nameManagerRefersToDraftSourceAtom, '')
    set(nameManagerNameDraftSourceAtom, '')
    set(nameManagerScopeDraftSourceAtom, 'workbook')
    bumpManagerDraftGeneration(get, set)
    return
  }
  set(nameManagerNameDraftSourceAtom, draft.name)
  set(
    nameManagerScopeDraftSourceAtom,
    draft.scope === 'workbook' ? 'workbook' : `sheet:${draft.scope.sheetId}`,
  )
  if (draft.refersTo.kind === 'range') {
    set(nameManagerKindDraftSourceAtom, 'range')
    set(nameManagerParamsDraftSourceAtom, '')
    set(nameManagerRefersToDraftSourceAtom, draft.refersTo.address)
  } else if (draft.refersTo.kind === 'constant') {
    set(nameManagerKindDraftSourceAtom, 'value')
    set(nameManagerParamsDraftSourceAtom, '')
    set(nameManagerRefersToDraftSourceAtom, draft.refersTo.value)
  } else {
    set(nameManagerKindDraftSourceAtom, 'lambda')
    set(nameManagerParamsDraftSourceAtom, draft.refersTo.params.join(', '))
    set(nameManagerRefersToDraftSourceAtom, draft.refersTo.body)
  }
  bumpManagerDraftGeneration(get, set)
}

export const openNameManagerAtom = atom(
  (get) => get(nameManagerEditorAtom),
  (get, set, state: NameManagerEditorState): number => {
    const sessionId = nextSessionId(get(nameManagerSessionIdAtom))
    const draft = state.draft === undefined ? undefined : (copyNamedRange(state.draft) ?? undefined)
    const editor: NameManagerEditorState = Object.freeze(
      state.status === 'closed'
        ? CLOSED_NAME_MANAGER_EDITOR_STATE
        : draft === undefined
          ? { status: state.status }
          : { status: state.status, draft },
    )
    set(nameManagerSessionIdAtom, sessionId)
    set(nameManagerEditorAtom, editor)
    set(nameManagerSelectedEntryAtom, state.status === 'editing-existing' ? (draft ?? null) : null)
    setManagerDraftAtoms(get, set, draft)
    return sessionId
  },
)
openNameManagerAtom.debugLabel = 'spreadsheet.namedRanges.open'

export const closeNameManagerAtom = atom(
  (get) => get(nameManagerEditorAtom),
  (get, set): void => {
    set(nameManagerSessionIdAtom, nextSessionId(get(nameManagerSessionIdAtom)))
    set(nameManagerEditorAtom, CLOSED_NAME_MANAGER_EDITOR_STATE)
    set(nameManagerSelectedEntryAtom, null)
    setManagerDraftAtoms(get, set, undefined)
  },
)
closeNameManagerAtom.debugLabel = 'spreadsheet.namedRanges.close'

function managerDraftEntry(get: Getter, activeSheetId: string | undefined): NamedRange | null {
  const name = normalizeNamedRangeName(get(nameManagerNameDraftAtom))
  if (name === null) return null
  const editorDraft = get(nameManagerEditorAtom).draft
  const scopeDraft = get(nameManagerScopeDraftAtom)
  const normalizedScopeDraft = scopeDraft.trim()
  const scope: NamedRangeScope = normalizedScopeDraft.startsWith('sheet:')
    ? { sheetId: normalizedScopeDraft.slice('sheet:'.length).trim() }
    : normalizedScopeDraft === 'workbook'
      ? 'workbook'
      : { sheetId: normalizedScopeDraft }
  const kind = get(nameManagerKindDraftAtom)
  let refersTo: NamedRangeRefersTo
  if (kind === 'range') {
    const value = get(nameManagerRefersToDraftAtom).trim()
    const separator = value.indexOf('!')
    const explicitSheetId = separator < 0 ? null : value.slice(0, separator).trim()
    const address = separator < 0 ? value : value.slice(separator + 1).trim()
    const fallbackSheetId =
      editorDraft?.refersTo.kind === 'range'
        ? editorDraft.refersTo.sheetId
        : scope === 'workbook'
          ? (activeSheetId?.trim() ?? '')
          : scope.sheetId
    const sheetId = explicitSheetId ?? fallbackSheetId
    if (sheetId.length === 0 || address.length === 0) return null
    refersTo = {
      kind: 'range',
      sheetId,
      address,
    }
  } else if (kind === 'value') {
    refersTo = { kind: 'constant', value: get(nameManagerRefersToDraftAtom).trim() }
  } else {
    const bodySource = get(nameManagerRefersToDraftAtom).trim()
    if (bodySource.length === 0) return null
    refersTo = {
      kind: 'lambda',
      params: get(nameManagerParamsDraftAtom)
        .split(',')
        .map((param) => param.trim())
        .filter(Boolean),
      body: bodySource.startsWith('=') ? bodySource : `=${bodySource}`,
    }
  }
  return copyNamedRange({ name, scope, refersTo })
}

export const saveNameManagerAtom = atom(null, (get, set, input: SaveNameManagerInput): void => {
  if (input.sessionId !== undefined && input.sessionId !== get(nameManagerSessionIdAtom)) return
  const entry =
    input.entry === undefined
      ? managerDraftEntry(get, input.activeSheetId)
      : copyNamedRange(input.entry)
  if (entry === null) {
    set(namedRangeMutationStateSourceAtom, blockedMutationState('名称或引用无效'))
    return
  }
  set(runNamedRangeMutationAtom, {
    source: input.source,
    origin: 'name-manager',
    sessionId: input.sessionId ?? get(nameManagerSessionIdAtom),
    mutation: {
      action: 'set',
      name: entry.name,
      scope: entry.scope,
      refersTo: entry.refersTo,
    },
  })
})
saveNameManagerAtom.debugLabel = 'spreadsheet.namedRanges.saveManager'

export const deleteNameManagerEntryAtom = atom(
  null,
  (get, set, input: DeleteNameManagerEntryInput): void => {
    if (input.sessionId !== undefined && input.sessionId !== get(nameManagerSessionIdAtom)) return
    const candidate =
      input.entry ?? get(nameManagerSelectedEntryAtom) ?? get(nameManagerEditorAtom).draft
    const entry = candidate === undefined ? null : copyNamedRange(candidate)
    if (entry === null) {
      set(namedRangeMutationStateSourceAtom, blockedMutationState('请选择要删除的名称'))
      return
    }
    set(runNamedRangeMutationAtom, {
      source: input.source,
      origin: 'name-manager',
      sessionId: input.sessionId ?? get(nameManagerSessionIdAtom),
      mutation: { action: 'delete', name: entry.name, scope: entry.scope },
    })
  },
)
deleteNameManagerEntryAtom.debugLabel = 'spreadsheet.namedRanges.deleteManagerEntry'
