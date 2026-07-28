import { atom, type Atom, type Getter } from '@einfach/core'
import { editingSessionAtom } from '../editing'
import {
  selectionAuthorityWitnessAtom,
  selectionSnapshotAtom,
  type SelectionAuthorityWitness,
} from '../selection'
import type { CellRange } from '../shared'
import {
  workspaceActiveSheetAuthorityWitnessAtom,
  workspaceSessionAtom,
  type WorkspaceActiveSheetAuthorityWitness,
} from '../workspace'
import type {
  DataValidationMutationAcknowledgement,
  DataValidationOperationAttempt,
  DataValidationOperationAttemptStatus,
  OpenValidationRuleEditorInput,
  RunDataValidationMutationInput,
  ValidationOutcome,
  ValidationRule,
  ValidationRuleEditorState,
  ValidationRuleFormState,
} from './types'

export * from './types'

export const DATA_VALIDATION_MUTATION_LEDGER_MAX = 32

const DATA_VALIDATION_SESSION_IDENTITY_EXHAUSTED_ERROR =
  'Data validation editor session identity space is exhausted or corrupt'

export const DEFAULT_VALIDATION_RULE_FORM_STATE: Readonly<ValidationRuleFormState> = Object.freeze({
  kind: 'list',
  mode: 'warn',
  listValues: '',
  listDropdown: true,
  rangeMin: '',
  rangeMax: '',
  rangeIntegerOnly: false,
  regexPattern: '',
  regexFlags: '',
  formulaText: '',
})

const INITIAL_EDITOR_STATE: ValidationRuleEditorState = Object.freeze({
  status: 'closed',
  sessionId: 0,
  requestId: null,
  targetSheetId: null,
  hasRuleDraft: false,
  form: DEFAULT_VALIDATION_RULE_FORM_STATE,
  pending: false,
  error: null,
})

const VALIDATION_RULE_FORM_FIELDS = [
  'kind',
  'listValues',
  'listDropdown',
  'rangeMin',
  'rangeMax',
  'rangeIntegerOnly',
  'regexPattern',
  'regexFlags',
  'formulaText',
] as const satisfies readonly (keyof ValidationRuleFormState)[]

interface DataValidationMutationReservation {
  readonly sessionId: number
}

interface DataValidationMutationInputSnapshot {
  readonly action: RunDataValidationMutationInput['action']
  readonly sheetId: string | undefined
  readonly setRule: RunDataValidationMutationInput['setRule']
  readonly clearRule: RunDataValidationMutationInput['clearRule']
  readonly acceptAcknowledgedResult: RunDataValidationMutationInput['acceptAcknowledgedResult']
}

interface DataValidationMutationAuthority {
  readonly sheetId: string
  readonly requestId: DataValidationOperationAttempt['requestId']
  readonly range: Readonly<CellRange>
}

type DataValidationTargetAuthority =
  | {
      readonly source: 'explicit'
      readonly sheetId: string
    }
  | {
      readonly source: 'workspace'
      readonly sheetId: string
      readonly workspaceWitness: WorkspaceActiveSheetAuthorityWitness
    }
  | {
      readonly source: 'selection'
      readonly sheetId: string
      readonly workspaceWitness: WorkspaceActiveSheetAuthorityWitness
      readonly selectionWitness: SelectionAuthorityWitness
    }

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
  } catch {
    // Fall through to guarded string coercion.
  }
  try {
    return String(error)
  } catch {
    return 'Unknown data validation transport failure'
  }
}

function copyRange(range: Readonly<CellRange>): CellRange {
  return { ...range }
}

function snapshotRange(value: unknown): CellRange | null {
  if (!isObjectRecord(value)) return null
  try {
    const rowStart = value.rowStart
    const rowEnd = value.rowEnd
    const colStart = value.colStart
    const colEnd = value.colEnd
    if (
      typeof rowStart !== 'number' ||
      !Number.isSafeInteger(rowStart) ||
      rowStart < 0 ||
      typeof rowEnd !== 'number' ||
      !Number.isSafeInteger(rowEnd) ||
      rowEnd < rowStart ||
      typeof colStart !== 'number' ||
      !Number.isSafeInteger(colStart) ||
      colStart < 0 ||
      typeof colEnd !== 'number' ||
      !Number.isSafeInteger(colEnd) ||
      colEnd < colStart
    ) {
      return null
    }
    return { rowStart, rowEnd, colStart, colEnd }
  } catch {
    return null
  }
}

function freezeRange(range: Readonly<CellRange>): Readonly<CellRange> {
  return Object.freeze(copyRange(range))
}

function freezeForm(form: Readonly<ValidationRuleFormState>): Readonly<ValidationRuleFormState> {
  return Object.freeze({ ...form })
}

function freezeEditorFacade(state: ValidationRuleEditorState): ValidationRuleEditorState {
  return Object.freeze({
    ...state,
    ...(state.range === undefined ? {} : { range: freezeRange(state.range) }),
    form: freezeForm(state.form),
  })
}

function freezeAttemptFacade(
  attempt: DataValidationOperationAttempt,
): DataValidationOperationAttempt {
  return Object.freeze({ ...attempt, range: freezeRange(attempt.range) })
}

function freezeLedgerFacade(
  ledger: readonly DataValidationOperationAttempt[],
): readonly DataValidationOperationAttempt[] {
  return Object.freeze(ledger.map(freezeAttemptFacade))
}

function sameRange(left: Readonly<CellRange>, right: Readonly<CellRange>): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function copyRule(rule: ValidationRule): ValidationRule {
  return rule.kind === 'list' ? { ...rule, values: [...rule.values] } : { ...rule }
}

function freezeRule(rule: ValidationRule): ValidationRule {
  if (rule.kind === 'list') {
    return Object.freeze({
      ...rule,
      values: Object.freeze([...rule.values]),
    }) as unknown as ValidationRule
  }
  return Object.freeze({ ...rule })
}

function snapshotRule(value: unknown): ValidationRule | undefined | null {
  if (value === undefined) return undefined
  if (!isObjectRecord(value)) return null
  try {
    const kind = value.kind
    if (kind === 'list') {
      const values = value.values
      const dropdown = value.dropdown
      if (!Array.isArray(values)) return null
      const valuesSnapshot = [...values]
      if (!valuesSnapshot.every((item) => typeof item === 'string')) return null
      if (typeof dropdown !== 'boolean') return null
      return { kind, values: valuesSnapshot, dropdown }
    }
    if (kind === 'range') {
      const min = value.min
      const max = value.max
      const integerOnly = value.integerOnly
      if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) return null
      if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) return null
      if (integerOnly !== undefined && typeof integerOnly !== 'boolean') return null
      return {
        kind,
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(integerOnly === undefined ? {} : { integerOnly }),
      }
    }
    if (kind === 'regex') {
      const pattern = value.pattern
      const flags = value.flags
      if (typeof pattern !== 'string' || (flags !== undefined && typeof flags !== 'string')) {
        return null
      }
      return { kind, pattern, ...(flags === undefined ? {} : { flags }) }
    }
    if (kind === 'formula') {
      const formula = value.formula
      return typeof formula === 'string' ? { kind, formula } : null
    }
    return null
  } catch {
    return null
  }
}

function snapshotOpenEditorInput(value: unknown): OpenValidationRuleEditorInput | null {
  if (!isObjectRecord(value)) return null
  try {
    const rangeValue = value.range
    const draftValue = value.draft
    const mode = value.mode
    const range = rangeValue === undefined ? undefined : snapshotRange(rangeValue)
    const draft = snapshotRule(draftValue)
    if (range === null || draft === null) return null
    if (mode !== undefined && mode !== 'warn' && mode !== 'reject') return null
    return Object.freeze({
      ...(range === undefined ? {} : { range: freezeRange(range) as CellRange }),
      ...(draft === undefined ? {} : { draft: freezeRule(draft) }),
      ...(mode === undefined ? {} : { mode }),
    })
  } catch {
    return null
  }
}

function snapshotFormPatch(value: unknown): Partial<ValidationRuleFormState> | null {
  if (!isObjectRecord(value)) return null
  const patch: Partial<ValidationRuleFormState> = {}
  try {
    for (const field of [...VALIDATION_RULE_FORM_FIELDS, 'mode'] as const) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue
      const fieldValue = value[field]
      if (field === 'kind') {
        if (
          fieldValue !== 'list' &&
          fieldValue !== 'range' &&
          fieldValue !== 'regex' &&
          fieldValue !== 'formula'
        ) {
          return null
        }
      } else if (field === 'mode') {
        if (fieldValue !== 'warn' && fieldValue !== 'reject') return null
      } else if (field === 'listDropdown' || field === 'rangeIntegerOnly') {
        if (typeof fieldValue !== 'boolean') return null
      } else if (typeof fieldValue !== 'string') {
        return null
      }
      Object.assign(patch, { [field]: fieldValue })
    }
    return Object.freeze(patch)
  } catch {
    return null
  }
}

function snapshotMutationInput(value: unknown): DataValidationMutationInputSnapshot | null {
  if (!isObjectRecord(value)) return null
  try {
    const action = value.action
    const sheetId = value.sheetId
    const setRule = value.setRule
    const clearRule = value.clearRule
    const acceptAcknowledgedResult = value.acceptAcknowledgedResult
    if (action !== 'save' && action !== 'clear') return null
    if (sheetId !== undefined && typeof sheetId !== 'string') return null
    if (setRule !== undefined && typeof setRule !== 'function') return null
    if (clearRule !== undefined && typeof clearRule !== 'function') return null
    if (acceptAcknowledgedResult !== undefined && typeof acceptAcknowledgedResult !== 'function') {
      return null
    }
    return Object.freeze({
      action,
      sheetId,
      setRule: setRule as RunDataValidationMutationInput['setRule'],
      clearRule: clearRule as RunDataValidationMutationInput['clearRule'],
      acceptAcknowledgedResult:
        acceptAcknowledgedResult as RunDataValidationMutationInput['acceptAcknowledgedResult'],
    })
  } catch {
    return null
  }
}

function formStateFromInput(input: OpenValidationRuleEditorInput): ValidationRuleFormState {
  const draft = input.draft
  return {
    kind: draft?.kind ?? 'list',
    mode: input.mode ?? 'warn',
    listValues: draft?.kind === 'list' ? draft.values.join(', ') : '',
    listDropdown: draft?.kind === 'list' ? draft.dropdown : true,
    rangeMin: draft?.kind === 'range' && draft.min !== undefined ? String(draft.min) : '',
    rangeMax: draft?.kind === 'range' && draft.max !== undefined ? String(draft.max) : '',
    rangeIntegerOnly: draft?.kind === 'range' ? draft.integerOnly === true : false,
    regexPattern: draft?.kind === 'regex' ? draft.pattern : '',
    regexFlags: draft?.kind === 'regex' ? (draft.flags ?? '') : '',
    formulaText: draft?.kind === 'formula' ? draft.formula : '',
  }
}

function patchChangesValidationRule(
  form: Readonly<ValidationRuleFormState>,
  patch: Partial<ValidationRuleFormState>,
): boolean {
  return VALIDATION_RULE_FORM_FIELDS.some(
    (field) =>
      Object.prototype.hasOwnProperty.call(patch, field) && !Object.is(patch[field], form[field]),
  )
}

function validationRuleFromForm(form: Readonly<ValidationRuleFormState>): ValidationRule {
  if (form.kind === 'list') {
    return {
      kind: 'list',
      values: form.listValues
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      dropdown: form.listDropdown,
    }
  }
  if (form.kind === 'range') {
    return {
      kind: 'range',
      min: form.rangeMin !== '' ? Number(form.rangeMin) : undefined,
      max: form.rangeMax !== '' ? Number(form.rangeMax) : undefined,
      ...(form.rangeIntegerOnly ? { integerOnly: true } : {}),
    }
  }
  if (form.kind === 'regex') {
    return {
      kind: 'regex',
      pattern: form.regexPattern,
      ...(form.regexFlags === '' ? {} : { flags: form.regexFlags }),
    }
  }
  return { kind: 'formula', formula: form.formulaText }
}

function captureDataValidationTargetAuthority(
  get: Getter,
  explicitSheetId: string | undefined,
): DataValidationTargetAuthority | null {
  // Presence is a hard authority branch: even an invalid explicit id must not
  // consult workspace or selection fallback state.
  if (explicitSheetId !== undefined) {
    return explicitSheetId.length > 0
      ? Object.freeze({ source: 'explicit', sheetId: explicitSheetId })
      : null
  }

  try {
    // Public snapshots carry target data only. Continuity is proved by the
    // private aggregate's opaque witness, never by public object identity.
    const workspaceWitness = get(workspaceActiveSheetAuthorityWitnessAtom)
    const workspaceSession = get(workspaceSessionAtom)
    const workspaceSheetId = workspaceSession.activeSheetId
    if (get(workspaceActiveSheetAuthorityWitnessAtom) !== workspaceWitness) return null
    if (workspaceSheetId !== null && workspaceSheetId.length > 0) {
      return Object.freeze({
        source: 'workspace',
        sheetId: workspaceSheetId,
        workspaceWitness,
      })
    }

    const selectionWitness = get(selectionAuthorityWitnessAtom)
    const selectionSnapshot = get(selectionSnapshotAtom)
    const selectionSheetId = selectionSnapshot.selection.sheetId
    if (
      get(workspaceActiveSheetAuthorityWitnessAtom) !== workspaceWitness ||
      get(selectionAuthorityWitnessAtom) !== selectionWitness
    ) {
      return null
    }
    return selectionSheetId.length > 0
      ? Object.freeze({
          source: 'selection',
          sheetId: selectionSheetId,
          workspaceWitness,
          selectionWitness,
        })
      : null
  } catch {
    return null
  }
}

function dataValidationTargetAuthorityIsCurrent(
  get: Getter,
  authority: DataValidationTargetAuthority,
): boolean {
  if (authority.source === 'explicit') return true
  try {
    if (get(workspaceActiveSheetAuthorityWitnessAtom) !== authority.workspaceWitness) return false
    return (
      authority.source === 'workspace' ||
      get(selectionAuthorityWitnessAtom) === authority.selectionWitness
    )
  } catch {
    return false
  }
}

/** Crosses the positive safe-integer boundary once, then descends without reuse. */
function nextSafeMonotonicIdentity(sequence: number): number | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) {
    return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  }
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

/** Pure plan; it exposes no writable access to the private editor authority. */
export function nextDataValidationSessionId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

function planClosedEditorState(
  previous: ValidationRuleEditorState,
): ValidationRuleEditorState | null {
  const sessionId = nextDataValidationSessionId(previous.sessionId)
  return sessionId === null
    ? null
    : {
        ...INITIAL_EDITOR_STATE,
        sessionId,
        form: DEFAULT_VALIDATION_RULE_FORM_STATE,
      }
}

function unavailableSessionEditorState(
  previous: ValidationRuleEditorState,
  pending = previous.pending,
): ValidationRuleEditorState {
  return {
    ...previous,
    pending,
    error: DATA_VALIDATION_SESSION_IDENTITY_EXHAUSTED_ERROR,
  }
}

function nextRequestId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

function reserveAttemptSlot(
  ledger: readonly DataValidationOperationAttempt[],
): DataValidationOperationAttempt[] | null {
  const next = [...ledger]
  while (next.length >= DATA_VALIDATION_MUTATION_LEDGER_MAX) {
    const acknowledgedIndex = next.findIndex((attempt) => attempt.status === 'acknowledged')
    if (acknowledgedIndex < 0) return null
    next.splice(acknowledgedIndex, 1)
  }
  return next
}

function settleAttempt(
  ledger: readonly DataValidationOperationAttempt[],
  operationId: string,
  status: DataValidationOperationAttemptStatus,
  detail: {
    error?: string
    resultRevision?: DataValidationMutationAcknowledgement['revision']
  },
): DataValidationOperationAttempt[] {
  return ledger.map((attempt) => {
    if (attempt.operationId !== operationId) return attempt
    if (attempt.status !== 'pending') return attempt
    return {
      ...attempt,
      status,
      ...(detail.error === undefined ? {} : { error: detail.error }),
      ...(detail.resultRevision === undefined ? {} : { resultRevision: detail.resultRevision }),
    }
  })
}

function snapshotAcknowledgement(
  value: unknown,
  authority: DataValidationMutationAuthority,
): { acknowledgement: DataValidationMutationAcknowledgement | null; error: string | null } {
  if (!isObjectRecord(value)) {
    return {
      acknowledgement: null,
      error: 'Data validation acknowledgement must be an object',
    }
  }
  try {
    const sheetId = value.sheetId
    const requestId = value.requestId
    const affectedRangeValue = value.affectedRange
    const revision = value.revision
    if (typeof sheetId !== 'string' || sheetId !== authority.sheetId) {
      return {
        acknowledgement: null,
        error: 'Data validation acknowledgement targeted a different sheet',
      }
    }
    if (
      typeof requestId !== 'number' ||
      !Number.isSafeInteger(requestId) ||
      requestId !== authority.requestId
    ) {
      return {
        acknowledgement: null,
        error: 'Data validation acknowledgement returned a different request id',
      }
    }
    let affectedRange: Readonly<CellRange> | undefined
    if (affectedRangeValue !== undefined) {
      const range = snapshotRange(affectedRangeValue)
      if (range === null || !sameRange(range, authority.range)) {
        return {
          acknowledgement: null,
          error: 'Data validation acknowledgement targeted a different range',
        }
      }
      affectedRange = freezeRange(range)
    }
    if (
      revision !== undefined &&
      typeof revision !== 'string' &&
      (typeof revision !== 'number' || !Number.isFinite(revision))
    ) {
      return {
        acknowledgement: null,
        error: 'Data validation acknowledgement returned an invalid revision',
      }
    }
    return {
      acknowledgement: Object.freeze({
        sheetId,
        requestId,
        ...(affectedRange === undefined ? {} : { affectedRange }),
        ...(revision === undefined ? {} : { revision }),
      }),
      error: null,
    }
  } catch {
    return {
      acknowledgement: null,
      error: 'Data validation acknowledgement could not be read safely',
    }
  }
}

// --- Source atoms ---

const validationRuleEditorStateAtom = atom<ValidationRuleEditorState>(
  freezeEditorFacade(INITIAL_EDITOR_STATE),
)
validationRuleEditorStateAtom.debugLabel = 'spreadsheet.validation.ruleEditorState'

export const validationRuleEditorAtom: Atom<ValidationRuleEditorState> = atom((get) =>
  freezeEditorFacade(get(validationRuleEditorStateAtom)),
)
validationRuleEditorAtom.debugLabel = 'spreadsheet.validation.ruleEditor'

const dataValidationRequestSequenceAtom = atom(0)

const dataValidationMutationReservationAtom = atom<DataValidationMutationReservation | null>(null)

/** Per-store launch barrier used to publish the complete start snapshot before transport. */
const dataValidationTransportLaunchSequenceAtom = atom(0)

/** Local bounded evidence only; this is not the Stage 0.5 operation registry. */
const dataValidationOperationAttemptLedgerStateAtom = atom<
  readonly DataValidationOperationAttempt[]
>(Object.freeze([]))
dataValidationOperationAttemptLedgerStateAtom.debugLabel =
  'spreadsheet.validation.operationAttemptLedgerState'

export const dataValidationOperationAttemptLedgerAtom: Atom<
  readonly DataValidationOperationAttempt[]
> = atom((get) => freezeLedgerFacade(get(dataValidationOperationAttemptLedgerStateAtom)))
dataValidationOperationAttemptLedgerAtom.debugLabel =
  'spreadsheet.validation.operationAttemptLedger'

/** Signals unresolved transport outcomes without claiming they were not applied. */
export const dataValidationMutationBlockedAtom = atom((get): boolean =>
  get(dataValidationOperationAttemptLedgerStateAtom).some(
    (attempt) => attempt.status === 'outcome-unknown',
  ),
)
dataValidationMutationBlockedAtom.debugLabel = 'spreadsheet.validation.mutationBlocked'

// --- Derived atoms ---

export const validationRuleFormAtom: Atom<Readonly<ValidationRuleFormState>> = atom(
  (get) => get(validationRuleEditorStateAtom).form,
)
validationRuleFormAtom.debugLabel = 'spreadsheet.validation.ruleForm'

export const validationRuleFormRuleAtom: Atom<ValidationRule> = atom((get) =>
  freezeRule(validationRuleFromForm(get(validationRuleFormAtom))),
)
validationRuleFormRuleAtom.debugLabel = 'spreadsheet.validation.ruleFormRule'

// --- Command atoms ---

export const updateValidationRuleFormAtom = atom(
  null,
  (get, set, patch: Partial<ValidationRuleFormState>) => {
    const editor = get(validationRuleEditorStateAtom)
    if (editor.status !== 'editing' || editor.pending) return
    const patchSnapshot = snapshotFormPatch(patch)
    if (patchSnapshot === null || get(validationRuleEditorStateAtom) !== editor) return
    set(
      validationRuleEditorStateAtom,
      freezeEditorFacade({
        ...editor,
        hasRuleDraft: editor.hasRuleDraft || patchChangesValidationRule(editor.form, patchSnapshot),
        form: freezeForm({ ...editor.form, ...patchSnapshot }),
        error: null,
      }),
    )
  },
)
updateValidationRuleFormAtom.debugLabel = 'spreadsheet.validation.updateRuleForm'

export const openValidationRuleEditorAtom = atom(
  null,
  (get, set, input: OpenValidationRuleEditorInput) => {
    const previous = get(validationRuleEditorStateAtom)
    const sessionId = nextDataValidationSessionId(previous.sessionId)
    if (sessionId === null) {
      set(
        validationRuleEditorStateAtom,
        freezeEditorFacade(unavailableSessionEditorState(previous)),
      )
      return
    }
    const inputSnapshot = snapshotOpenEditorInput(input)
    if (inputSnapshot === null || get(validationRuleEditorStateAtom) !== previous) {
      return
    }
    set(
      validationRuleEditorStateAtom,
      freezeEditorFacade({
        status: 'editing',
        sessionId,
        requestId: null,
        targetSheetId: null,
        ...(inputSnapshot.range === undefined ? {} : { range: freezeRange(inputSnapshot.range) }),
        hasRuleDraft: inputSnapshot.draft !== undefined,
        form: freezeForm(formStateFromInput(inputSnapshot)),
        pending: false,
        error: null,
      }),
    )
  },
)
openValidationRuleEditorAtom.debugLabel = 'spreadsheet.validation.openRuleEditor'

export const closeValidationRuleEditorAtom = atom(null, (get, set) => {
  const previous = get(validationRuleEditorStateAtom)
  const next = planClosedEditorState(previous) ?? unavailableSessionEditorState(previous)
  set(validationRuleEditorStateAtom, freezeEditorFacade(next))
})
closeValidationRuleEditorAtom.debugLabel = 'spreadsheet.validation.closeRuleEditor'

/**
 * Dispatches a validation mutation from a core-owned form and target snapshot.
 * The local attempt ledger settles before stale UI-session checks. Fulfillment
 * is only acknowledged and is never described as applied or canonical.
 */
export const runDataValidationMutationAtom = atom(
  null,
  async (get, set, input: RunDataValidationMutationInput): Promise<void> => {
    const editor = get(validationRuleEditorStateAtom)
    if (
      editor.status !== 'editing' ||
      editor.pending ||
      get(dataValidationMutationReservationAtom) !== null
    ) {
      return
    }

    if (nextDataValidationSessionId(editor.sessionId) === null) {
      set(validationRuleEditorStateAtom, freezeEditorFacade(unavailableSessionEditorState(editor)))
      return
    }

    // Reserve synchronously before reading any caller-owned property. This closes
    // the same-tick/re-entrant window even though async atom writes flush later.
    const reservation = Object.freeze({ sessionId: editor.sessionId })
    set(dataValidationMutationReservationAtom, reservation)

    try {
      const ledgerBeforeInput = get(dataValidationOperationAttemptLedgerStateAtom)
      if (ledgerBeforeInput.some((attempt) => attempt.status === 'outcome-unknown')) {
        if (get(validationRuleEditorStateAtom) === editor) {
          set(
            validationRuleEditorStateAtom,
            freezeEditorFacade({
              ...editor,
              error: 'Data validation is blocked by an operation with an unknown outcome',
            }),
          )
        }
        return
      }

      const inputSnapshot = snapshotMutationInput(input)
      if (inputSnapshot === null) {
        if (get(validationRuleEditorStateAtom) === editor) {
          set(
            validationRuleEditorStateAtom,
            freezeEditorFacade({ ...editor, error: 'Data validation mutation input is invalid' }),
          )
        }
        return
      }
      if (
        get(validationRuleEditorStateAtom) !== editor ||
        get(dataValidationMutationReservationAtom) !== reservation
      ) {
        return
      }

      const execute =
        inputSnapshot.action === 'save' ? inputSnapshot.setRule : inputSnapshot.clearRule
      if (!execute) {
        set(
          validationRuleEditorStateAtom,
          freezeEditorFacade({
            ...editor,
            error: `Data validation ${inputSnapshot.action} is unavailable`,
          }),
        )
        return
      }

      if (!editor.range) {
        set(
          validationRuleEditorStateAtom,
          freezeEditorFacade({ ...editor, error: 'Data validation requires a target range' }),
        )
        return
      }

      const targetAuthority = captureDataValidationTargetAuthority(get, inputSnapshot.sheetId)
      if (
        get(validationRuleEditorStateAtom) !== editor ||
        get(dataValidationMutationReservationAtom) !== reservation
      ) {
        return
      }
      if (targetAuthority === null) {
        set(
          validationRuleEditorStateAtom,
          freezeEditorFacade({ ...editor, error: 'Data validation requires an active sheet' }),
        )
        return
      }
      const sheetId = targetAuthority.sheetId

      const reservedLedger = reserveAttemptSlot(get(dataValidationOperationAttemptLedgerStateAtom))
      if (reservedLedger === null) {
        set(
          validationRuleEditorStateAtom,
          freezeEditorFacade({
            ...editor,
            error: 'Data validation operation journal is full of unresolved attempts',
          }),
        )
        return
      }

      const requestId = nextRequestId(get(dataValidationRequestSequenceAtom))
      if (requestId === null) {
        set(
          validationRuleEditorStateAtom,
          freezeEditorFacade({
            ...editor,
            error: 'Data validation request ticket space is exhausted',
          }),
        )
        return
      }

      const sessionId = editor.sessionId
      const targetRange = freezeRange(editor.range)
      const form = freezeForm(editor.form)
      const rule = freezeRule(validationRuleFromForm(form))
      const authority: DataValidationMutationAuthority = Object.freeze({
        sheetId,
        requestId,
        range: targetRange,
      })
      const operationId = `data-validation-${requestId}`
      const attempt: DataValidationOperationAttempt = Object.freeze({
        operationId,
        requestId,
        sessionId,
        action: inputSnapshot.action,
        sheetId,
        range: freezeRange(targetRange),
        baseRevision: null,
        status: 'pending',
      })

      const matchesOwnedEditor = (current: ValidationRuleEditorState): boolean =>
        current.status === 'editing' &&
        current.sessionId === sessionId &&
        current.requestId === requestId &&
        current.targetSheetId === sheetId &&
        current.range !== undefined &&
        sameRange(current.range, targetRange)

      const readOwnedEditor = (): ValidationRuleEditorState | null => {
        if (get(dataValidationMutationReservationAtom) !== reservation) return null
        const current = get(validationRuleEditorStateAtom)
        if (!matchesOwnedEditor(current)) return null
        if (
          get(dataValidationMutationReservationAtom) !== reservation ||
          get(validationRuleEditorStateAtom) !== current
        ) {
          return null
        }
        return current
      }

      const isCurrentTarget = (): boolean => {
        try {
          if (get(dataValidationMutationReservationAtom) !== reservation) return false
          const current = get(validationRuleEditorStateAtom)
          if (!matchesOwnedEditor(current)) return false
          return (
            dataValidationTargetAuthorityIsCurrent(get, targetAuthority) &&
            get(dataValidationMutationReservationAtom) === reservation &&
            get(validationRuleEditorStateAtom) === current &&
            matchesOwnedEditor(current)
          )
        } catch {
          return false
        }
      }

      set(dataValidationRequestSequenceAtom, requestId)
      set(
        dataValidationOperationAttemptLedgerStateAtom,
        freezeLedgerFacade([...reservedLedger, attempt]),
      )
      set(
        validationRuleEditorStateAtom,
        freezeEditorFacade({
          ...editor,
          requestId,
          targetSheetId: sheetId,
          pending: true,
          error: null,
        }),
      )

      // The core store intentionally flushes an async writer when its Promise settles.
      // Cross a microtask boundary, then write a private per-store launch marker so the
      // editor and ledger start states flush together before any transport can settle.
      await Promise.resolve()
      if (!isCurrentTarget()) {
        const ledger = get(dataValidationOperationAttemptLedgerStateAtom)
        const withoutUnlaunchedAttempt = ledger.filter(
          (entry) => entry.operationId !== operationId || entry.status !== 'pending',
        )
        if (withoutUnlaunchedAttempt.length !== ledger.length) {
          set(
            dataValidationOperationAttemptLedgerStateAtom,
            freezeLedgerFacade(withoutUnlaunchedAttempt),
          )
        }
        const current = readOwnedEditor()
        if (current !== null && readOwnedEditor() === current) {
          set(
            validationRuleEditorStateAtom,
            freezeEditorFacade({
              ...current,
              pending: false,
              error: 'Data validation target changed before transport dispatch',
            }),
          )
        }
        return
      }
      set(dataValidationTransportLaunchSequenceAtom, requestId)

      const setRule = inputSnapshot.setRule
      const clearRule = inputSnapshot.clearRule
      let acknowledgementValue: unknown
      try {
        acknowledgementValue =
          inputSnapshot.action === 'save'
            ? await setRule!({
                kind: 'set-validation-rule',
                sheetId,
                range: copyRange(targetRange),
                rule: copyRule(rule),
                mode: form.mode,
                requestId,
              })
            : await clearRule!({
                kind: 'clear-validation-rule',
                sheetId,
                range: copyRange(targetRange),
                requestId,
              })
      } catch (error) {
        const message = errorMessage(error)
        set(
          dataValidationOperationAttemptLedgerStateAtom,
          freezeLedgerFacade(
            settleAttempt(
              get(dataValidationOperationAttemptLedgerStateAtom),
              operationId,
              'outcome-unknown',
              { error: message },
            ),
          ),
        )
        if (isCurrentTarget()) {
          const current = get(validationRuleEditorStateAtom)
          set(
            validationRuleEditorStateAtom,
            freezeEditorFacade({ ...current, pending: false, error: message }),
          )
        }
        return
      }

      const { acknowledgement, error: protocolError } = snapshotAcknowledgement(
        acknowledgementValue,
        authority,
      )
      if (acknowledgement === null) {
        const message = protocolError ?? 'Data validation acknowledgement was invalid'
        set(
          dataValidationOperationAttemptLedgerStateAtom,
          freezeLedgerFacade(
            settleAttempt(
              get(dataValidationOperationAttemptLedgerStateAtom),
              operationId,
              'outcome-unknown',
              { error: message },
            ),
          ),
        )
        if (isCurrentTarget()) {
          const current = get(validationRuleEditorStateAtom)
          set(
            validationRuleEditorStateAtom,
            freezeEditorFacade({ ...current, pending: false, error: message }),
          )
        }
        return
      }

      set(
        dataValidationOperationAttemptLedgerStateAtom,
        freezeLedgerFacade(
          settleAttempt(
            get(dataValidationOperationAttemptLedgerStateAtom),
            operationId,
            'acknowledged',
            { resultRevision: acknowledgement.revision },
          ),
        ),
      )

      // The acknowledgement remains useful journal evidence after a retarget,
      // but projection acceptance belongs only to the current dialog target.
      if (!isCurrentTarget()) return

      let acceptanceError: string | null = null
      const acceptAcknowledgedResult = inputSnapshot.acceptAcknowledgedResult
      if (acceptAcknowledgedResult) {
        try {
          await acceptAcknowledgedResult(acknowledgement)
        } catch (error) {
          acceptanceError = errorMessage(error)
        }
      }

      if (!isCurrentTarget()) return
      const current = get(validationRuleEditorStateAtom)
      if (acceptanceError !== null) {
        set(
          validationRuleEditorStateAtom,
          freezeEditorFacade({
            ...current,
            pending: false,
            error: `Mutation acknowledged; result acceptance failed: ${acceptanceError}`,
          }),
        )
        return
      }
      const next = planClosedEditorState(current) ?? unavailableSessionEditorState(current, false)
      set(validationRuleEditorStateAtom, freezeEditorFacade(next))
    } finally {
      if (get(dataValidationMutationReservationAtom) === reservation) {
        set(dataValidationMutationReservationAtom, null)
      }
    }
  },
)
runDataValidationMutationAtom.debugLabel = 'spreadsheet.validation.runMutation'

export function evaluateValidationLocal(
  rule: ValidationRule,
  input: string,
): ValidationOutcome | null {
  if (rule.kind === 'list') {
    if (!rule.values.includes(input)) {
      return {
        code: 'validation.list_mismatch',
        severity: 'error',
        message: `Value must be one of: ${rule.values.join(', ')}`,
      }
    }
    return null
  }

  if (rule.kind === 'range') {
    const num = Number(input)
    if (Number.isNaN(num)) {
      return {
        code: 'validation.range_out_of_bounds',
        severity: 'error',
        message: 'Value must be a number',
      }
    }
    if (rule.integerOnly && !Number.isInteger(num)) {
      return {
        code: 'validation.range_not_integer',
        severity: 'error',
        message: 'Value must be an integer',
      }
    }
    if (rule.min !== undefined && num < rule.min) {
      return {
        code: 'validation.range_out_of_bounds',
        severity: 'error',
        message: `Value must be >= ${rule.min}`,
      }
    }
    if (rule.max !== undefined && num > rule.max) {
      return {
        code: 'validation.range_out_of_bounds',
        severity: 'error',
        message: `Value must be <= ${rule.max}`,
      }
    }
    return null
  }

  if (rule.kind === 'regex') {
    let re: RegExp
    try {
      re = new RegExp(rule.pattern, rule.flags)
    } catch (error) {
      return {
        code: 'validation.regex_invalid',
        severity: 'error',
        message: `Validation regex is invalid: ${errorMessage(error)}`,
      }
    }
    if (!re.test(input)) {
      return {
        code: 'validation.regex_mismatch',
        severity: 'error',
        message: `Value does not match pattern /${rule.pattern}/${rule.flags ?? ''}`,
      }
    }
    return null
  }

  // formula — requires backend evaluation
  return null
}

export const validationStatusAtom = atom<ValidationOutcome | null>((get) => {
  const editing = get(editingSessionAtom)
  const editor = get(validationRuleEditorAtom)

  if (editing.status !== 'drafting' || editor.status !== 'editing' || !editor.hasRuleDraft) {
    return null
  }

  return evaluateValidationLocal(validationRuleFromForm(editor.form), editing.draft)
})
validationStatusAtom.debugLabel = 'spreadsheet.validation.status'
