import { atom, type Atom, type Getter, type Setter } from '@einfach/core'
import type {
  SpreadsheetBorderSide,
  SpreadsheetBorderSpec,
  SpreadsheetCellFormat,
  SpreadsheetNumberFormat,
} from '../backend'
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
  ConditionalFormatEditorState,
  ConditionalFormatMutationAcknowledgement,
  ConditionalFormatOperationAttempt,
  ConditionalFormatOperationAttemptStatus,
  ConditionalFormatRule,
  ConditionalFormatRuleEntry,
  ConditionalFormatRuleKind,
  ConditionalFormatRulesResult,
  ConditionalFormatRulesState,
  ConditionalFormatScope,
  RunConditionalFormatMutationInput,
  SetConditionalFormatRuleRequest,
  RemoveConditionalFormatRuleRequest,
} from './types'

export * from './types'

export const CONDITIONAL_FORMAT_RULES_MAX = 200
export const CONDITIONAL_FORMAT_MUTATION_LEDGER_MAX = 32

const INITIAL_EDITOR_STATE: ConditionalFormatEditorState = Object.freeze({
  open: false,
  sessionId: 0,
  requestId: null,
  ruleId: null,
  draft: null,
  selectedKind: 'cell-value',
  pending: false,
  error: null,
})

const RULE_KINDS = [
  'cell-value',
  'formula',
  'data-bar',
  'color-scale',
  'top-bottom',
] as const satisfies readonly ConditionalFormatRuleKind[]

const BORDER_SIDES = [
  'top',
  'right',
  'bottom',
  'left',
] as const satisfies readonly SpreadsheetBorderSide[]
const BORDER_STYLES = ['none', 'thin', 'medium', 'thick', 'dashed', 'dotted', 'double'] as const
const ALIGNMENTS = ['default', 'left', 'center', 'right', 'fill', 'justify', 'distributed'] as const
const VERTICAL_ALIGNMENTS = ['top', 'center', 'bottom', 'justify', 'distributed'] as const
const OVERFLOWS = ['overflow', 'clip', 'ellipsis', 'wrap', 'shrink-to-fit'] as const
const NEGATIVE_FORMATS = ['minus', 'red', 'parens', 'red-parens'] as const

type SheetTargetSource = 'explicit' | 'workspace-or-cache'
type ScopeTargetSource = 'explicit' | 'draft' | 'selection'

interface ConditionalFormatMutationInputSnapshot {
  readonly action: RunConditionalFormatMutationInput['action']
  readonly sheetId: string | undefined
  readonly scope: ConditionalFormatScope | undefined
  readonly setRule: RunConditionalFormatMutationInput['setRule']
  readonly removeRule: RunConditionalFormatMutationInput['removeRule']
  readonly listRules: RunConditionalFormatMutationInput['listRules']
  readonly acceptAcknowledgedResult: RunConditionalFormatMutationInput['acceptAcknowledgedResult']
}

interface ConditionalFormatMutationCapture {
  readonly kind: 'capture'
  readonly editor: ConditionalFormatEditorState
}

interface ConditionalFormatMutationTicket {
  readonly sessionId: number
  readonly requestId: number
  readonly sheetId: string
  readonly sheetTargetSource: SheetTargetSource
  readonly workspaceAuthorityWitness: WorkspaceActiveSheetAuthorityWitness | null
  readonly scope: ConditionalFormatScope
  readonly scopeTargetSource: ScopeTargetSource
  readonly selectionAuthorityWitness: SelectionAuthorityWitness | null
  readonly ruleId: string | null
  readonly selectedKind: ConditionalFormatRuleKind
  readonly operationId: string
}

interface ConditionalFormatMutationReservation {
  readonly kind: 'reservation'
  readonly editor: ConditionalFormatEditorState
  readonly cache: ConditionalFormatRulesState
  readonly expectedSequence: number
  readonly ticket: ConditionalFormatMutationTicket
  readonly input: ConditionalFormatMutationInputSnapshot
  readonly request: SetConditionalFormatRuleRequest | RemoveConditionalFormatRuleRequest
  readonly attempt: ConditionalFormatOperationAttempt
}

type ConditionalFormatMutationLaunchState =
  | ConditionalFormatMutationCapture
  | ConditionalFormatMutationReservation
  | null

interface AcknowledgementSnapshot {
  readonly acknowledgement: ConditionalFormatMutationAcknowledgement | null
  readonly error: string | null
}

interface RulesResultSnapshot {
  readonly result: ConditionalFormatRulesResult | null
  readonly error: string | null
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null
}

function isOneOf<const Values extends readonly unknown[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return (values as readonly unknown[]).includes(value)
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
  } catch {
    // Fall through to guarded coercion.
  }
  try {
    return String(error)
  } catch {
    return 'Unknown conditional formatting transport failure'
  }
}

function snapshotRevision(
  value: unknown,
): { readonly ok: true; readonly value: string | number | undefined } | { readonly ok: false } {
  if (value === undefined || typeof value === 'string') return { ok: true, value }
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value }
  return { ok: false }
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

function snapshotScope(value: unknown): ConditionalFormatScope | null {
  if (!isObjectRecord(value)) return null
  try {
    const range = snapshotRange(value.range)
    return range === null ? null : { range }
  } catch {
    return null
  }
}

function snapshotBorderSpec(value: unknown): SpreadsheetBorderSpec | null {
  if (!isObjectRecord(value)) return null
  try {
    const style = value.style
    const color = value.color
    if (!isOneOf(style, BORDER_STYLES)) return null
    if (color !== undefined && typeof color !== 'string') return null
    return { style, ...(color === undefined ? {} : { color }) }
  } catch {
    return null
  }
}

function snapshotNumberFormat(value: unknown): SpreadsheetNumberFormat | null {
  if (!isObjectRecord(value)) return null
  try {
    const kind = value.kind
    const digits = value.digits
    const negative = value.negative
    const validDigits =
      digits === undefined || (typeof digits === 'number' && Number.isFinite(digits))
    const validNegative = negative === undefined || isOneOf(negative, NEGATIVE_FORMATS)
    switch (kind) {
      case 'general':
      case 'text':
        return { kind }
      case 'number':
      case 'decimal': {
        const thousands = value.thousands
        if (
          !validDigits ||
          !validNegative ||
          (thousands !== undefined && typeof thousands !== 'boolean')
        ) {
          return null
        }
        return {
          kind,
          ...(digits === undefined ? {} : { digits }),
          ...(thousands === undefined ? {} : { thousands }),
          ...(negative === undefined ? {} : { negative }),
        }
      }
      case 'currency': {
        const symbol = value.symbol
        if (
          !validDigits ||
          !validNegative ||
          (symbol !== undefined && typeof symbol !== 'string')
        ) {
          return null
        }
        return {
          kind,
          ...(symbol === undefined ? {} : { symbol }),
          ...(digits === undefined ? {} : { digits }),
          ...(negative === undefined ? {} : { negative }),
        }
      }
      case 'accounting': {
        const symbol = value.symbol
        if (!validDigits || (symbol !== undefined && typeof symbol !== 'string')) return null
        return {
          kind,
          ...(symbol === undefined ? {} : { symbol }),
          ...(digits === undefined ? {} : { digits }),
        }
      }
      case 'date':
      case 'time': {
        const pattern = value.pattern
        if (pattern !== undefined && typeof pattern !== 'string') return null
        return { kind, ...(pattern === undefined ? {} : { pattern }) }
      }
      case 'percent':
      case 'percentage':
        if (!validDigits || !validNegative) return null
        return {
          kind,
          ...(digits === undefined ? {} : { digits }),
          ...(negative === undefined ? {} : { negative }),
        }
      case 'fraction': {
        const denominator = value.denominator
        if (
          denominator !== undefined &&
          denominator !== 'one-digit' &&
          denominator !== 'two-digit' &&
          denominator !== 'three-digit' &&
          (typeof denominator !== 'number' || !Number.isFinite(denominator))
        ) {
          return null
        }
        return { kind, ...(denominator === undefined ? {} : { denominator }) }
      }
      case 'scientific':
        if (!validDigits) return null
        return { kind, ...(digits === undefined ? {} : { digits }) }
      case 'special': {
        const preset = value.preset
        const locale = value.locale
        if (typeof preset !== 'string' || (locale !== undefined && typeof locale !== 'string')) {
          return null
        }
        return { kind, preset, ...(locale === undefined ? {} : { locale }) }
      }
      case 'custom': {
        const pattern = value.pattern
        return typeof pattern === 'string' ? { kind, pattern } : null
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

function snapshotFormat(value: unknown): SpreadsheetCellFormat | null {
  if (!isObjectRecord(value)) return null
  try {
    const result: SpreadsheetCellFormat = {}
    const numberFormatValue = value.numberFormat
    if (numberFormatValue !== undefined) {
      const numberFormat = snapshotNumberFormat(numberFormatValue)
      if (numberFormat === null) return null
      result.numberFormat = numberFormat
    }

    for (const field of [
      'bold',
      'italic',
      'underline',
      'strikethrough',
      'wrap',
      'shrinkToFit',
    ] as const) {
      const fieldValue = value[field]
      if (fieldValue !== undefined) {
        if (typeof fieldValue !== 'boolean') return null
        result[field] = fieldValue
      }
    }
    for (const field of ['fontFamily', 'fgColor', 'bgColor', 'locale'] as const) {
      const fieldValue = value[field]
      if (fieldValue !== undefined) {
        if (typeof fieldValue !== 'string') return null
        result[field] = fieldValue
      }
    }
    for (const field of ['fontSize', 'indent'] as const) {
      const fieldValue = value[field]
      if (fieldValue !== undefined) {
        if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) return null
        result[field] = fieldValue
      }
    }

    const align = value.align
    if (align !== undefined) {
      if (!isOneOf(align, ALIGNMENTS)) return null
      result.align = align
    }
    const verticalAlign = value.verticalAlign
    if (verticalAlign !== undefined) {
      if (!isOneOf(verticalAlign, VERTICAL_ALIGNMENTS)) return null
      result.verticalAlign = verticalAlign
    }
    const overflow = value.overflow
    if (overflow !== undefined) {
      if (!isOneOf(overflow, OVERFLOWS)) return null
      result.overflow = overflow
    }
    const rotation = value.rotation
    if (rotation !== undefined) {
      if (
        rotation !== 'vertical' &&
        (typeof rotation !== 'number' ||
          !Number.isFinite(rotation) ||
          rotation < -90 ||
          rotation > 90)
      ) {
        return null
      }
      result.rotation = rotation
    }

    const bordersValue = value.borders
    if (bordersValue !== undefined) {
      if (!isObjectRecord(bordersValue)) return null
      const borders: Partial<Record<SpreadsheetBorderSide, SpreadsheetBorderSpec>> = {}
      for (const side of BORDER_SIDES) {
        const specValue = bordersValue[side]
        if (specValue === undefined) continue
        const spec = snapshotBorderSpec(specValue)
        if (spec === null) return null
        borders[side] = spec
      }
      result.borders = borders
    }
    return result
  } catch {
    return null
  }
}

function snapshotRule(value: unknown): ConditionalFormatRule | null {
  if (!isObjectRecord(value)) return null
  try {
    const kind = value.kind
    switch (kind) {
      case 'cell-value': {
        const operator = value.operator
        const ruleValue = value.value
        const value2 = value.value2
        const format = snapshotFormat(value.format)
        if (
          !isOneOf(operator, [
            'eq',
            'ne',
            'gt',
            'gte',
            'lt',
            'lte',
            'between',
            'not-between',
          ] as const) ||
          typeof ruleValue !== 'string' ||
          (value2 !== undefined && typeof value2 !== 'string') ||
          format === null
        ) {
          return null
        }
        return {
          kind,
          operator,
          value: ruleValue,
          ...(value2 === undefined ? {} : { value2 }),
          format,
        }
      }
      case 'formula': {
        const formula = value.formula
        const format = snapshotFormat(value.format)
        return typeof formula === 'string' && format !== null ? { kind, formula, format } : null
      }
      case 'data-bar': {
        const minColor = value.minColor
        const maxColor = value.maxColor
        if (
          (minColor !== undefined && typeof minColor !== 'string') ||
          (maxColor !== undefined && typeof maxColor !== 'string')
        ) {
          return null
        }
        return {
          kind,
          ...(minColor === undefined ? {} : { minColor }),
          ...(maxColor === undefined ? {} : { maxColor }),
        }
      }
      case 'color-scale': {
        const minColor = value.minColor
        const midColor = value.midColor
        const maxColor = value.maxColor
        if (
          typeof minColor !== 'string' ||
          typeof maxColor !== 'string' ||
          (midColor !== undefined && typeof midColor !== 'string')
        ) {
          return null
        }
        return { kind, minColor, ...(midColor === undefined ? {} : { midColor }), maxColor }
      }
      case 'top-bottom': {
        const direction = value.direction
        const count = value.count
        const percent = value.percent
        const format = snapshotFormat(value.format)
        if (
          (direction !== 'top' && direction !== 'bottom') ||
          typeof count !== 'number' ||
          !Number.isFinite(count) ||
          (percent !== undefined && typeof percent !== 'boolean') ||
          format === null
        ) {
          return null
        }
        return { kind, direction, count, ...(percent === undefined ? {} : { percent }), format }
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

function snapshotEntry(value: unknown): ConditionalFormatRuleEntry | null {
  if (!isObjectRecord(value)) return null
  try {
    const id = value.id
    const priority = value.priority
    const scope = snapshotScope(value.scope)
    const rule = snapshotRule(value.rule)
    if (
      typeof id !== 'string' ||
      typeof priority !== 'number' ||
      !Number.isFinite(priority) ||
      scope === null ||
      rule === null
    ) {
      return null
    }
    return { id, priority, scope, rule }
  } catch {
    return null
  }
}

function snapshotRulesState(value: unknown): ConditionalFormatRulesState | null {
  if (!isObjectRecord(value)) return null
  try {
    const sheetId = value.sheetId
    const rulesValue = value.rules
    const revisionSnapshot = snapshotRevision(value.revision)
    if (
      (sheetId !== null && typeof sheetId !== 'string') ||
      !Array.isArray(rulesValue) ||
      !revisionSnapshot.ok
    ) {
      return null
    }
    const rulesValues = [...rulesValue]
    const rules: ConditionalFormatRuleEntry[] = []
    for (const ruleValue of rulesValues) {
      const rule = snapshotEntry(ruleValue)
      if (rule === null) return null
      rules.push(rule)
    }
    return {
      sheetId,
      rules:
        rules.length > CONDITIONAL_FORMAT_RULES_MAX
          ? rules.slice(rules.length - CONDITIONAL_FORMAT_RULES_MAX)
          : rules,
      ...(revisionSnapshot.value === undefined ? {} : { revision: revisionSnapshot.value }),
    }
  } catch {
    return null
  }
}

function snapshotMutationInput(value: unknown): ConditionalFormatMutationInputSnapshot | null {
  if (!isObjectRecord(value)) return null
  try {
    const action = value.action
    const sheetId = value.sheetId
    const scopeValue = value.scope
    const setRule = value.setRule
    const removeRule = value.removeRule
    const listRules = value.listRules
    const acceptAcknowledgedResult = value.acceptAcknowledgedResult
    if (action !== 'save' && action !== 'remove') return null
    if (sheetId !== undefined && typeof sheetId !== 'string') return null
    const scope = scopeValue === undefined ? undefined : snapshotScope(scopeValue)
    if (scope === null) return null
    if (setRule !== undefined && typeof setRule !== 'function') return null
    if (removeRule !== undefined && typeof removeRule !== 'function') return null
    if (listRules !== undefined && typeof listRules !== 'function') return null
    if (acceptAcknowledgedResult !== undefined && typeof acceptAcknowledgedResult !== 'function') {
      return null
    }
    return Object.freeze({
      action,
      sheetId,
      scope: scope === undefined ? undefined : freezeScope(scope),
      setRule: setRule as ConditionalFormatMutationInputSnapshot['setRule'],
      removeRule: removeRule as ConditionalFormatMutationInputSnapshot['removeRule'],
      listRules: listRules as ConditionalFormatMutationInputSnapshot['listRules'],
      acceptAcknowledgedResult:
        acceptAcknowledgedResult as ConditionalFormatMutationInputSnapshot['acceptAcknowledgedResult'], // eslint-disable-line max-len
    })
  } catch {
    return null
  }
}

function copyRange(range: Readonly<CellRange>): CellRange {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  }
}

function copyScope(scope: ConditionalFormatScope): ConditionalFormatScope {
  return { range: copyRange(scope.range) }
}

function copyFormat(format: SpreadsheetCellFormat): SpreadsheetCellFormat {
  const result: SpreadsheetCellFormat = { ...format }
  if (format.numberFormat !== undefined) result.numberFormat = { ...format.numberFormat }
  if (format.borders !== undefined) {
    const borders: Partial<Record<SpreadsheetBorderSide, SpreadsheetBorderSpec>> = {}
    for (const side of BORDER_SIDES) {
      const spec = format.borders[side]
      if (spec !== undefined) borders[side] = { ...spec }
    }
    result.borders = borders
  }
  return result
}

function copyRule(rule: ConditionalFormatRule): ConditionalFormatRule {
  switch (rule.kind) {
    case 'cell-value':
    case 'formula':
    case 'top-bottom':
      return { ...rule, format: copyFormat(rule.format) }
    case 'data-bar':
    case 'color-scale':
      return { ...rule }
  }
}

function freezeRange(range: Readonly<CellRange>): CellRange {
  return Object.freeze(copyRange(range))
}

function freezeScope(scope: ConditionalFormatScope): ConditionalFormatScope {
  return Object.freeze({ range: freezeRange(scope.range) })
}

function freezeFormat(format: SpreadsheetCellFormat): SpreadsheetCellFormat {
  const result = copyFormat(format)
  if (result.numberFormat !== undefined) result.numberFormat = Object.freeze(result.numberFormat)
  if (result.borders !== undefined) {
    for (const side of BORDER_SIDES) {
      const spec = result.borders[side]
      if (spec !== undefined) result.borders[side] = Object.freeze(spec)
    }
    result.borders = Object.freeze(result.borders)
  }
  return Object.freeze(result)
}

function freezeRule(rule: ConditionalFormatRule): ConditionalFormatRule {
  const result = copyRule(rule)
  if (result.kind === 'cell-value' || result.kind === 'formula' || result.kind === 'top-bottom') {
    result.format = freezeFormat(result.format)
  }
  return Object.freeze(result)
}

function freezeEntry(entry: ConditionalFormatRuleEntry): ConditionalFormatRuleEntry {
  return Object.freeze({
    id: entry.id,
    priority: entry.priority,
    scope: freezeScope(entry.scope),
    rule: freezeRule(entry.rule),
  })
}

function freezeRulesState(state: ConditionalFormatRulesState): ConditionalFormatRulesState {
  return Object.freeze({
    sheetId: state.sheetId,
    rules: Object.freeze(state.rules.map(freezeEntry)),
    ...(state.revision === undefined ? {} : { revision: state.revision }),
  })
}

function freezeEditorState(state: ConditionalFormatEditorState): ConditionalFormatEditorState {
  return Object.freeze({
    ...state,
    draft: state.draft === null ? null : freezeEntry(state.draft),
  })
}

function freezeAttempt(
  attempt: ConditionalFormatOperationAttempt,
): ConditionalFormatOperationAttempt {
  return Object.freeze({
    ...attempt,
    scope: attempt.scope === null ? null : freezeScope(attempt.scope),
  })
}

function freezeLedger(
  ledger: readonly ConditionalFormatOperationAttempt[],
): readonly ConditionalFormatOperationAttempt[] {
  return Object.freeze(ledger.map(freezeAttempt))
}

function defaultRuleForKind(kind: ConditionalFormatRuleKind): ConditionalFormatRule {
  switch (kind) {
    case 'cell-value':
      return { kind: 'cell-value', operator: 'gt', value: '0', format: { bgColor: '#fef3c7' } }
    case 'formula':
      return { kind: 'formula', formula: '=TRUE()', format: { bgColor: '#fef3c7' } }
    case 'data-bar':
      return { kind: 'data-bar' }
    case 'color-scale':
      return { kind: 'color-scale', minColor: '#ff0000', maxColor: '#00ff00' }
    case 'top-bottom':
      return { kind: 'top-bottom', direction: 'top', count: 10, format: { bgColor: '#fef3c7' } }
  }
}

function sameScope(left: ConditionalFormatScope, right: ConditionalFormatScope): boolean {
  return (
    left.range.rowStart === right.range.rowStart &&
    left.range.rowEnd === right.range.rowEnd &&
    left.range.colStart === right.range.colStart &&
    left.range.colEnd === right.range.colEnd
  )
}

/** Crosses the positive safe-integer boundary once, then continues downward without reuse. */
function nextSafeMonotonicIdentity(sequence: number): number | null {
  if (!Number.isSafeInteger(sequence)) return null
  if (sequence >= 0) return sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : -1
  return sequence > Number.MIN_SAFE_INTEGER ? sequence - 1 : null
}

export function nextConditionalFormatRequestId(sequence: number): number | null {
  return nextSafeMonotonicIdentity(sequence)
}

export function nextConditionalFormatSessionId(sessionId: number): number | null {
  return nextSafeMonotonicIdentity(sessionId)
}

function closeEditorState(previous: ConditionalFormatEditorState): ConditionalFormatEditorState {
  const sessionId = nextConditionalFormatSessionId(previous.sessionId)
  return sessionId === null
    ? {
        ...INITIAL_EDITOR_STATE,
        sessionId: previous.sessionId,
        error: 'Conditional formatting session identity space is exhausted',
      }
    : { ...INITIAL_EDITOR_STATE, sessionId }
}

function reserveAttemptSlot(
  ledger: readonly ConditionalFormatOperationAttempt[],
): ConditionalFormatOperationAttempt[] | null {
  const next = [...ledger]
  while (next.length >= CONDITIONAL_FORMAT_MUTATION_LEDGER_MAX) {
    const acknowledgedIndex = next.findIndex((attempt) => attempt.status === 'acknowledged')
    if (acknowledgedIndex < 0) return null
    next.splice(acknowledgedIndex, 1)
  }
  return next
}

function settleAttempt(
  ledger: readonly ConditionalFormatOperationAttempt[],
  operationId: string,
  status: ConditionalFormatOperationAttemptStatus,
  detail: { readonly error?: string; readonly resultRevision?: string | number },
): readonly ConditionalFormatOperationAttempt[] {
  return ledger.map((attempt) => {
    if (attempt.operationId !== operationId || attempt.status !== 'pending') return attempt
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
  ticket: ConditionalFormatMutationTicket,
): AcknowledgementSnapshot {
  if (!isObjectRecord(value)) {
    return {
      acknowledgement: null,
      error: 'Conditional formatting acknowledgement must be an object',
    }
  }
  try {
    const sheetId = value.sheetId
    const requestId = value.requestId
    const revisionSnapshot = snapshotRevision(value.revision)
    if (typeof sheetId !== 'string' || sheetId !== ticket.sheetId) {
      return {
        acknowledgement: null,
        error: 'Conditional formatting acknowledgement targeted a different sheet',
      }
    }
    if (
      typeof requestId !== 'number' ||
      !Number.isSafeInteger(requestId) ||
      requestId !== ticket.requestId
    ) {
      return {
        acknowledgement: null,
        error: 'Conditional formatting acknowledgement returned a different request id',
      }
    }
    if (!revisionSnapshot.ok) {
      return {
        acknowledgement: null,
        error: 'Conditional formatting acknowledgement returned an invalid revision',
      }
    }
    return {
      acknowledgement: Object.freeze({
        sheetId,
        requestId,
        ...(revisionSnapshot.value === undefined ? {} : { revision: revisionSnapshot.value }),
      }),
      error: null,
    }
  } catch {
    return {
      acknowledgement: null,
      error: 'Conditional formatting acknowledgement could not be read safely',
    }
  }
}

function snapshotRulesResult(
  value: unknown,
  ticket: ConditionalFormatMutationTicket,
): RulesResultSnapshot {
  if (!isObjectRecord(value)) {
    return { result: null, error: 'Conditional formatting rules response must be an object' }
  }
  try {
    const sheetId = value.sheetId
    const requestId = value.requestId
    const revisionSnapshot = snapshotRevision(value.revision)
    const rulesValue = value.rules
    if (typeof sheetId !== 'string' || sheetId !== ticket.sheetId) {
      return {
        result: null,
        error: 'Conditional formatting rules response targeted a different sheet',
      }
    }
    if (
      typeof requestId !== 'number' ||
      !Number.isSafeInteger(requestId) ||
      requestId !== ticket.requestId
    ) {
      return {
        result: null,
        error: 'Conditional formatting rules response returned a different request id',
      }
    }
    if (!revisionSnapshot.ok) {
      return {
        result: null,
        error: 'Conditional formatting rules response returned an invalid revision',
      }
    }
    if (!Array.isArray(rulesValue)) {
      return { result: null, error: 'Conditional formatting rules response returned invalid rules' }
    }
    const values = [...rulesValue]
    const rules: ConditionalFormatRuleEntry[] = []
    for (const ruleValue of values) {
      const rule = snapshotEntry(ruleValue)
      if (rule === null) {
        return {
          result: null,
          error: 'Conditional formatting rules response returned invalid rules',
        }
      }
      rules.push(freezeEntry(rule))
    }
    return {
      result: Object.freeze({
        sheetId,
        requestId,
        rules: Object.freeze(rules),
        ...(revisionSnapshot.value === undefined ? {} : { revision: revisionSnapshot.value }),
      }),
      error: null,
    }
  } catch {
    return { result: null, error: 'Conditional formatting rules response could not be read safely' }
  }
}

function resolveSheetTarget(
  get: Getter,
  explicitSheetId: string | undefined,
  cache: ConditionalFormatRulesState,
): {
  readonly sheetId: string
  readonly source: SheetTargetSource
  readonly authorityWitness: WorkspaceActiveSheetAuthorityWitness | null
} | null {
  if (explicitSheetId !== undefined) {
    return { sheetId: explicitSheetId, source: 'explicit', authorityWitness: null }
  }
  try {
    const authorityWitness = get(workspaceActiveSheetAuthorityWitnessAtom)
    const workspace = get(workspaceSessionAtom)
    if (!isObjectRecord(workspace)) return null
    const activeSheetId = workspace.activeSheetId
    if (get(workspaceActiveSheetAuthorityWitnessAtom) !== authorityWitness) return null
    if (activeSheetId !== null && typeof activeSheetId !== 'string') return null
    return {
      sheetId:
        typeof activeSheetId === 'string' && activeSheetId.length > 0
          ? activeSheetId
          : (cache.sheetId ?? ''),
      source: 'workspace-or-cache',
      authorityWitness,
    }
  } catch {
    return null
  }
}

function resolveScopeTarget(
  get: Getter,
  explicitScope: ConditionalFormatScope | undefined,
  editor: ConditionalFormatEditorState,
): {
  readonly scope: ConditionalFormatScope
  readonly source: ScopeTargetSource
  readonly authorityWitness: SelectionAuthorityWitness | null
} | null {
  if (explicitScope !== undefined) {
    return { scope: freezeScope(explicitScope), source: 'explicit', authorityWitness: null }
  }
  if (editor.draft !== null) {
    return { scope: freezeScope(editor.draft.scope), source: 'draft', authorityWitness: null }
  }
  try {
    const authorityWitness = get(selectionAuthorityWitnessAtom)
    const selection = get(selectionSnapshotAtom)
    if (!isObjectRecord(selection)) return null
    const range = snapshotRange(selection.range)
    if (get(selectionAuthorityWitnessAtom) !== authorityWitness) return null
    return range === null
      ? null
      : { scope: freezeScope({ range }), source: 'selection', authorityWitness }
  } catch {
    return null
  }
}

function resolvedTargetAuthorityIsCurrent(
  get: Getter,
  sheetTarget: {
    readonly authorityWitness: WorkspaceActiveSheetAuthorityWitness | null
  },
  scopeTarget: {
    readonly authorityWitness: SelectionAuthorityWitness | null
  },
): boolean {
  try {
    return (
      (sheetTarget.authorityWitness === null ||
        get(workspaceActiveSheetAuthorityWitnessAtom) === sheetTarget.authorityWitness) &&
      (scopeTarget.authorityWitness === null ||
        get(selectionAuthorityWitnessAtom) === scopeTarget.authorityWitness)
    )
  } catch {
    return false
  }
}

function copyMutationRequest(
  request: SetConditionalFormatRuleRequest | RemoveConditionalFormatRuleRequest,
): SetConditionalFormatRuleRequest | RemoveConditionalFormatRuleRequest {
  if (request.kind === 'remove-conditional-format-rule') return { ...request }
  return { ...request, scope: copyScope(request.scope), rule: copyRule(request.rule) }
}

// --- Private source atoms and readonly public projections ---

const conditionalFormatRulesCacheStateAtom = atom<ConditionalFormatRulesState>(
  freezeRulesState({ sheetId: null, rules: [] }),
)
conditionalFormatRulesCacheStateAtom.debugLabel = 'spreadsheet.conditionalFormat.rulesCacheState'

export const conditionalFormatRulesCacheAtom: Atom<ConditionalFormatRulesState> = atom((get) =>
  freezeRulesState(get(conditionalFormatRulesCacheStateAtom)),
)
conditionalFormatRulesCacheAtom.debugLabel = 'spreadsheet.conditionalFormat.rulesCache'

const conditionalFormatEditorStateAtom = atom<ConditionalFormatEditorState>(
  freezeEditorState(INITIAL_EDITOR_STATE),
)
conditionalFormatEditorStateAtom.debugLabel = 'spreadsheet.conditionalFormat.editorState'

export const conditionalFormatEditorAtom: Atom<ConditionalFormatEditorState> = atom((get) =>
  freezeEditorState(get(conditionalFormatEditorStateAtom)),
)
conditionalFormatEditorAtom.debugLabel = 'spreadsheet.conditionalFormat.editor'

const conditionalFormatRequestSequenceAtom = atom(0)
const conditionalFormatMutationLaunchStateAtom = atom<ConditionalFormatMutationLaunchState>(null)

const conditionalFormatOperationAttemptLedgerStateAtom = atom<
  readonly ConditionalFormatOperationAttempt[]
>(Object.freeze([]))
conditionalFormatOperationAttemptLedgerStateAtom.debugLabel =
  'spreadsheet.conditionalFormat.operationAttemptLedgerState'

/** Local bounded evidence only; this is not the Stage 0.5 operation registry. */
export const conditionalFormatOperationAttemptLedgerAtom: Atom<
  readonly ConditionalFormatOperationAttempt[]
> = atom((get) => freezeLedger(get(conditionalFormatOperationAttemptLedgerStateAtom)))
conditionalFormatOperationAttemptLedgerAtom.debugLabel =
  'spreadsheet.conditionalFormat.operationAttemptLedger'

/** Signals unresolved transport outcomes without claiming they were not applied. */
export const conditionalFormatMutationBlockedAtom: Atom<boolean> = atom((get): boolean =>
  get(conditionalFormatOperationAttemptLedgerStateAtom).some(
    (attempt) => attempt.status === 'outcome-unknown',
  ),
)
conditionalFormatMutationBlockedAtom.debugLabel = 'spreadsheet.conditionalFormat.mutationBlocked'

// --- Command atoms ---

export const setConditionalFormatRulesAtom = atom(
  null,
  (get, set, next: ConditionalFormatRulesState) => {
    const previous = get(conditionalFormatRulesCacheStateAtom)
    const snapshot = snapshotRulesState(next)
    if (snapshot === null || get(conditionalFormatRulesCacheStateAtom) !== previous) return
    set(conditionalFormatRulesCacheStateAtom, freezeRulesState(snapshot))
  },
)
setConditionalFormatRulesAtom.debugLabel = 'spreadsheet.conditionalFormat.setRules'

export const openConditionalFormatEditorAtom = atom(
  null,
  (get, set, entry: ConditionalFormatRuleEntry | null) => {
    const previous = get(conditionalFormatEditorStateAtom)
    const sessionId = nextConditionalFormatSessionId(previous.sessionId)
    if (sessionId === null) {
      set(
        conditionalFormatEditorStateAtom,
        freezeEditorState({
          ...previous,
          open: false,
          pending: false,
          error: 'Conditional formatting session identity space is exhausted',
        }),
      )
      return
    }
    const draft = entry === null ? null : snapshotEntry(entry)
    if ((entry !== null && draft === null) || get(conditionalFormatEditorStateAtom) !== previous)
      return
    set(
      conditionalFormatEditorStateAtom,
      freezeEditorState({
        open: true,
        sessionId,
        requestId: null,
        ruleId: draft?.id ?? null,
        draft,
        selectedKind: draft?.rule.kind ?? 'cell-value',
        pending: false,
        error: null,
      }),
    )
  },
)
openConditionalFormatEditorAtom.debugLabel = 'spreadsheet.conditionalFormat.openEditor'

export const closeConditionalFormatEditorAtom = atom(null, (get, set) => {
  set(
    conditionalFormatEditorStateAtom,
    freezeEditorState(closeEditorState(get(conditionalFormatEditorStateAtom))),
  )
})
closeConditionalFormatEditorAtom.debugLabel = 'spreadsheet.conditionalFormat.closeEditor'

export const setConditionalFormatEditorKindAtom = atom(
  (get) => get(conditionalFormatEditorAtom),
  (get, set, selectedKind: ConditionalFormatRuleKind) => {
    const editor = get(conditionalFormatEditorStateAtom)
    if (!editor.open || editor.pending || !isOneOf(selectedKind, RULE_KINDS)) return
    set(
      conditionalFormatEditorStateAtom,
      freezeEditorState({ ...editor, selectedKind, error: null }),
    )
  },
)
setConditionalFormatEditorKindAtom.debugLabel = 'spreadsheet.conditionalFormat.setEditorKind'

function releaseCapture(
  get: Getter,
  set: Setter,
  capture: ConditionalFormatMutationCapture,
  error: string | null,
): null {
  if (get(conditionalFormatMutationLaunchStateAtom) !== capture) return null
  const editor = get(conditionalFormatEditorStateAtom)
  if (error !== null && editor === capture.editor) {
    set(conditionalFormatEditorStateAtom, freezeEditorState({ ...editor, error }))
  }
  if (get(conditionalFormatMutationLaunchStateAtom) === capture) {
    set(conditionalFormatMutationLaunchStateAtom, null)
  }
  return null
}

const reserveConditionalFormatMutationLaunchAtom = atom(
  null,
  (
    get,
    set,
    input: RunConditionalFormatMutationInput,
  ): ConditionalFormatMutationReservation | null => {
    const editor = get(conditionalFormatEditorStateAtom)
    if (!editor.open || editor.pending || get(conditionalFormatMutationLaunchStateAtom) !== null) {
      return null
    }

    // This private token is installed before any caller-owned or public fallback read.
    const capture: ConditionalFormatMutationCapture = Object.freeze({ kind: 'capture', editor })
    set(conditionalFormatMutationLaunchStateAtom, capture)

    const ledgerBeforeInput = get(conditionalFormatOperationAttemptLedgerStateAtom)
    if (ledgerBeforeInput.some((attempt) => attempt.status === 'outcome-unknown')) {
      return releaseCapture(
        get,
        set,
        capture,
        'Conditional formatting is blocked by an operation with an unknown outcome',
      )
    }
    if (reserveAttemptSlot(ledgerBeforeInput) === null) {
      return releaseCapture(
        get,
        set,
        capture,
        'Conditional formatting operation journal is full of unresolved attempts',
      )
    }

    const inputSnapshot = snapshotMutationInput(input)
    if (
      get(conditionalFormatMutationLaunchStateAtom) !== capture ||
      get(conditionalFormatEditorStateAtom) !== editor
    ) {
      return releaseCapture(get, set, capture, null)
    }
    if (inputSnapshot === null) {
      return releaseCapture(get, set, capture, 'Conditional formatting mutation input is invalid')
    }

    const execute =
      inputSnapshot.action === 'save' ? inputSnapshot.setRule : inputSnapshot.removeRule
    if (execute === undefined) {
      return releaseCapture(
        get,
        set,
        capture,
        `Conditional formatting ${inputSnapshot.action} is unavailable`,
      )
    }

    const ruleId = editor.ruleId && editor.ruleId.length > 0 ? editor.ruleId : null
    if (inputSnapshot.action === 'remove' && ruleId === null) {
      return releaseCapture(get, set, capture, 'Conditional formatting remove requires a rule id')
    }

    const cache = get(conditionalFormatRulesCacheStateAtom)
    const sheetTarget = resolveSheetTarget(get, inputSnapshot.sheetId, cache)
    if (
      get(conditionalFormatMutationLaunchStateAtom) !== capture ||
      get(conditionalFormatEditorStateAtom) !== editor ||
      get(conditionalFormatRulesCacheStateAtom) !== cache
    ) {
      return releaseCapture(get, set, capture, null)
    }
    if (sheetTarget === null || sheetTarget.sheetId.length === 0) {
      return releaseCapture(get, set, capture, 'Conditional formatting requires an active sheet')
    }

    const scopeTarget = resolveScopeTarget(get, inputSnapshot.scope, editor)
    if (
      get(conditionalFormatMutationLaunchStateAtom) !== capture ||
      get(conditionalFormatEditorStateAtom) !== editor ||
      get(conditionalFormatRulesCacheStateAtom) !== cache ||
      (scopeTarget !== null && !resolvedTargetAuthorityIsCurrent(get, sheetTarget, scopeTarget))
    ) {
      return releaseCapture(get, set, capture, null)
    }
    if (scopeTarget === null) {
      return releaseCapture(
        get,
        set,
        capture,
        'Conditional formatting requires a valid target range',
      )
    }

    const expectedSequence = get(conditionalFormatRequestSequenceAtom)
    const requestId = nextConditionalFormatRequestId(expectedSequence)
    if (requestId === null) {
      return releaseCapture(
        get,
        set,
        capture,
        'Conditional formatting request ticket space is exhausted',
      )
    }

    const targetScope = freezeScope(scopeTarget.scope)
    const baseRevision = cache.sheetId === sheetTarget.sheetId ? cache.revision : undefined
    const selectedRule =
      editor.draft?.rule.kind === editor.selectedKind
        ? freezeRule(editor.draft.rule)
        : freezeRule(defaultRuleForKind(editor.selectedKind))
    const operationId = `conditional-format-${requestId}`
    const ticket: ConditionalFormatMutationTicket = Object.freeze({
      sessionId: editor.sessionId,
      requestId,
      sheetId: sheetTarget.sheetId,
      sheetTargetSource: sheetTarget.source,
      workspaceAuthorityWitness: sheetTarget.authorityWitness,
      scope: targetScope,
      scopeTargetSource: scopeTarget.source,
      selectionAuthorityWitness: scopeTarget.authorityWitness,
      ruleId,
      selectedKind: editor.selectedKind,
      operationId,
    })
    const request: SetConditionalFormatRuleRequest | RemoveConditionalFormatRuleRequest =
      inputSnapshot.action === 'save'
        ? Object.freeze({
            kind: 'set-conditional-format-rule',
            sheetId: ticket.sheetId,
            ...(ruleId === null ? {} : { ruleId }),
            scope: targetScope,
            ...(editor.draft?.priority === undefined ? {} : { priority: editor.draft.priority }),
            rule: selectedRule,
            requestId,
            ...(baseRevision === undefined ? {} : { revision: baseRevision }),
          })
        : Object.freeze({
            kind: 'remove-conditional-format-rule',
            sheetId: ticket.sheetId,
            ruleId: ruleId!,
            requestId,
            ...(baseRevision === undefined ? {} : { revision: baseRevision }),
          })
    const attempt = freezeAttempt({
      operationId,
      requestId,
      sessionId: editor.sessionId,
      action: inputSnapshot.action,
      sheetId: ticket.sheetId,
      ruleId,
      scope: inputSnapshot.action === 'save' ? targetScope : null,
      baseRevision: baseRevision ?? null,
      status: 'pending',
    })
    const reservation: ConditionalFormatMutationReservation = Object.freeze({
      kind: 'reservation',
      editor,
      cache,
      expectedSequence,
      ticket,
      input: inputSnapshot,
      request,
      attempt,
    })
    if (
      get(conditionalFormatMutationLaunchStateAtom) !== capture ||
      get(conditionalFormatEditorStateAtom) !== editor ||
      get(conditionalFormatRulesCacheStateAtom) !== cache ||
      get(conditionalFormatRequestSequenceAtom) !== expectedSequence ||
      get(conditionalFormatOperationAttemptLedgerStateAtom) !== ledgerBeforeInput ||
      !resolvedTargetAuthorityIsCurrent(get, sheetTarget, scopeTarget)
    ) {
      return releaseCapture(get, set, capture, null)
    }
    set(conditionalFormatMutationLaunchStateAtom, reservation)
    return reservation
  },
)

function matchesOwnedEditor(
  editor: ConditionalFormatEditorState,
  ticket: ConditionalFormatMutationTicket,
): boolean {
  return (
    editor.open &&
    editor.pending &&
    editor.sessionId === ticket.sessionId &&
    editor.requestId === ticket.requestId &&
    editor.ruleId === ticket.ruleId &&
    editor.selectedKind === ticket.selectedKind
  )
}

function targetIsCurrent(
  get: Getter,
  ticket: ConditionalFormatMutationTicket,
  expectedEditor?: ConditionalFormatEditorState,
  expectedCache?: ConditionalFormatRulesState,
): boolean {
  const editor = get(conditionalFormatEditorStateAtom)
  if (
    expectedEditor !== undefined ? editor !== expectedEditor : !matchesOwnedEditor(editor, ticket)
  ) {
    return false
  }
  const cache = get(conditionalFormatRulesCacheStateAtom)
  if (expectedCache !== undefined && cache !== expectedCache) return false

  const sheetTarget = resolveSheetTarget(
    get,
    ticket.sheetTargetSource === 'explicit' ? ticket.sheetId : undefined,
    cache,
  )
  if (
    sheetTarget === null ||
    sheetTarget.sheetId !== ticket.sheetId ||
    sheetTarget.source !== ticket.sheetTargetSource ||
    sheetTarget.authorityWitness !== ticket.workspaceAuthorityWitness
  ) {
    return false
  }

  const scopeTarget = resolveScopeTarget(
    get,
    ticket.scopeTargetSource === 'explicit' ? ticket.scope : undefined,
    ticket.scopeTargetSource === 'selection' ? { ...editor, draft: null } : editor,
  )
  if (
    scopeTarget === null ||
    scopeTarget.source !== ticket.scopeTargetSource ||
    scopeTarget.authorityWitness !== ticket.selectionAuthorityWitness ||
    !sameScope(scopeTarget.scope, ticket.scope) ||
    !resolvedTargetAuthorityIsCurrent(get, sheetTarget, scopeTarget)
  ) {
    return false
  }

  return (
    get(conditionalFormatEditorStateAtom) === editor &&
    get(conditionalFormatRulesCacheStateAtom) === cache &&
    (expectedEditor !== undefined || matchesOwnedEditor(editor, ticket))
  )
}

const conditionalFormatCurrentTargetAtom = atom(
  null,
  (get, _set, ticket: ConditionalFormatMutationTicket): boolean => targetIsCurrent(get, ticket),
)

const beginConditionalFormatMutationLaunchAtom = atom(
  null,
  (get, set, reservation: ConditionalFormatMutationReservation): boolean => {
    if (
      get(conditionalFormatMutationLaunchStateAtom) !== reservation ||
      get(conditionalFormatEditorStateAtom) !== reservation.editor ||
      get(conditionalFormatRulesCacheStateAtom) !== reservation.cache ||
      get(conditionalFormatRequestSequenceAtom) !== reservation.expectedSequence ||
      !targetIsCurrent(get, reservation.ticket, reservation.editor, reservation.cache) ||
      get(conditionalFormatMutationLaunchStateAtom) !== reservation
    ) {
      return false
    }
    const ledger = get(conditionalFormatOperationAttemptLedgerStateAtom)
    if (ledger.some((attempt) => attempt.status === 'outcome-unknown')) {
      set(
        conditionalFormatEditorStateAtom,
        freezeEditorState({
          ...reservation.editor,
          error: 'Conditional formatting is blocked by an operation with an unknown outcome',
        }),
      )
      return false
    }
    const reservedLedger = reserveAttemptSlot(ledger)
    if (reservedLedger === null) {
      set(
        conditionalFormatEditorStateAtom,
        freezeEditorState({
          ...reservation.editor,
          error: 'Conditional formatting operation journal is full of unresolved attempts',
        }),
      )
      return false
    }

    set(conditionalFormatRequestSequenceAtom, reservation.ticket.requestId)
    set(
      conditionalFormatOperationAttemptLedgerStateAtom,
      freezeLedger([...reservedLedger, reservation.attempt]),
    )
    set(
      conditionalFormatEditorStateAtom,
      freezeEditorState({
        ...reservation.editor,
        requestId: reservation.ticket.requestId,
        pending: true,
        error: null,
      }),
    )
    return true
  },
)

const revokeUnlaunchedConditionalFormatMutationAtom = atom(
  null,
  (get, set, reservation: ConditionalFormatMutationReservation): void => {
    const ledger = get(conditionalFormatOperationAttemptLedgerStateAtom)
    const nextLedger = ledger.filter(
      (attempt) =>
        attempt.operationId !== reservation.ticket.operationId || attempt.status !== 'pending',
    )
    if (nextLedger.length !== ledger.length) {
      set(conditionalFormatOperationAttemptLedgerStateAtom, freezeLedger(nextLedger))
    }
    const editor = get(conditionalFormatEditorStateAtom)
    if (matchesOwnedEditor(editor, reservation.ticket)) {
      set(
        conditionalFormatEditorStateAtom,
        freezeEditorState({
          ...editor,
          pending: false,
          error: 'Conditional formatting target changed before transport dispatch',
        }),
      )
    }
  },
)

const guardConditionalFormatTransportLaunchAtom = atom(
  null,
  (get, set, reservation: ConditionalFormatMutationReservation): boolean => {
    if (
      get(conditionalFormatMutationLaunchStateAtom) === reservation &&
      get(conditionalFormatRequestSequenceAtom) === reservation.ticket.requestId &&
      get(conditionalFormatRulesCacheStateAtom) === reservation.cache &&
      targetIsCurrent(get, reservation.ticket) &&
      get(conditionalFormatMutationLaunchStateAtom) === reservation
    ) {
      return true
    }
    set(revokeUnlaunchedConditionalFormatMutationAtom, reservation)
    return false
  },
)

const releaseConditionalFormatMutationLaunchAtom = atom(
  null,
  (get, set, reservation: ConditionalFormatMutationReservation): void => {
    if (get(conditionalFormatMutationLaunchStateAtom) === reservation) {
      set(conditionalFormatMutationLaunchStateAtom, null)
    }
  },
)

const settleConditionalFormatAttemptAtom = atom(
  null,
  (
    get,
    set,
    input: {
      readonly ticket: ConditionalFormatMutationTicket
      readonly status: Exclude<ConditionalFormatOperationAttemptStatus, 'pending'>
      readonly error?: string
      readonly resultRevision?: string | number
    },
  ): void => {
    set(
      conditionalFormatOperationAttemptLedgerStateAtom,
      freezeLedger(
        settleAttempt(
          get(conditionalFormatOperationAttemptLedgerStateAtom),
          input.ticket.operationId,
          input.status,
          { error: input.error, resultRevision: input.resultRevision },
        ),
      ),
    )
  },
)

const updateOwnedConditionalFormatEditorAtom = atom(
  null,
  (
    get,
    set,
    input: { readonly ticket: ConditionalFormatMutationTicket; readonly error: string },
  ): void => {
    const editor = get(conditionalFormatEditorStateAtom)
    if (!matchesOwnedEditor(editor, input.ticket) || !targetIsCurrent(get, input.ticket, editor)) {
      return
    }
    set(
      conditionalFormatEditorStateAtom,
      freezeEditorState({ ...editor, pending: false, error: input.error }),
    )
  },
)

const acceptConditionalFormatRulesResultAtom = atom(
  null,
  (
    get,
    set,
    input: {
      readonly ticket: ConditionalFormatMutationTicket
      readonly cache: ConditionalFormatRulesState
      readonly result: ConditionalFormatRulesResult
    },
  ): boolean => {
    if (
      get(conditionalFormatRulesCacheStateAtom) !== input.cache ||
      !targetIsCurrent(get, input.ticket) ||
      get(conditionalFormatRulesCacheStateAtom) !== input.cache
    ) {
      return false
    }
    set(
      conditionalFormatRulesCacheStateAtom,
      freezeRulesState({
        sheetId: input.result.sheetId,
        rules:
          input.result.rules.length > CONDITIONAL_FORMAT_RULES_MAX
            ? input.result.rules.slice(input.result.rules.length - CONDITIONAL_FORMAT_RULES_MAX)
            : input.result.rules,
        revision: input.result.revision,
      }),
    )
    return true
  },
)

const closeOwnedConditionalFormatEditorAtom = atom(
  null,
  (get, set, ticket: ConditionalFormatMutationTicket): void => {
    const editor = get(conditionalFormatEditorStateAtom)
    if (!matchesOwnedEditor(editor, ticket) || !targetIsCurrent(get, ticket)) return
    set(conditionalFormatEditorStateAtom, freezeEditorState(closeEditorState(editor)))
  },
)

async function executeReservedConditionalFormatMutation(
  set: Setter,
  reservation: ConditionalFormatMutationReservation,
): Promise<void> {
  const started = set(beginConditionalFormatMutationLaunchAtom, reservation)
  if (!started) {
    set(releaseConditionalFormatMutationLaunchAtom, reservation)
    return
  }

  // begin() has already flushed the pending editor and journal entry to subscribers.
  const launchCurrent = set(guardConditionalFormatTransportLaunchAtom, reservation)
  set(releaseConditionalFormatMutationLaunchAtom, reservation)
  if (!launchCurrent) return

  let acknowledgementValue: unknown
  try {
    const request = copyMutationRequest(reservation.request)
    acknowledgementValue =
      request.kind === 'set-conditional-format-rule'
        ? await Promise.resolve(reservation.input.setRule!(request))
        : await Promise.resolve(reservation.input.removeRule!(request))
  } catch (error) {
    const message = errorMessage(error)
    // Ledger settlement is intentionally a separate, first subscriber-visible write.
    set(settleConditionalFormatAttemptAtom, {
      ticket: reservation.ticket,
      status: 'outcome-unknown',
      error: message,
    })
    set(updateOwnedConditionalFormatEditorAtom, { ticket: reservation.ticket, error: message })
    return
  }

  const acknowledgementSnapshot = snapshotAcknowledgement(acknowledgementValue, reservation.ticket)
  if (acknowledgementSnapshot.acknowledgement === null) {
    const message =
      acknowledgementSnapshot.error ?? 'Conditional formatting acknowledgement was invalid'
    set(settleConditionalFormatAttemptAtom, {
      ticket: reservation.ticket,
      status: 'outcome-unknown',
      error: message,
    })
    set(updateOwnedConditionalFormatEditorAtom, { ticket: reservation.ticket, error: message })
    return
  }

  const acknowledgement = acknowledgementSnapshot.acknowledgement
  set(settleConditionalFormatAttemptAtom, {
    ticket: reservation.ticket,
    status: 'acknowledged',
    resultRevision: acknowledgement.revision,
  })

  const isCurrentTarget = (): boolean => {
    try {
      return set(conditionalFormatCurrentTargetAtom, reservation.ticket)
    } catch {
      return false
    }
  }

  if (!isCurrentTarget()) return

  let followupError: string | null = null
  if (reservation.input.acceptAcknowledgedResult !== undefined) {
    try {
      await reservation.input.acceptAcknowledgedResult(acknowledgement)
    } catch (error) {
      followupError = errorMessage(error)
    }
  }

  if (!isCurrentTarget()) return

  if (reservation.input.listRules !== undefined) {
    try {
      const resultValue = await Promise.resolve(
        reservation.input.listRules({
          kind: 'list-conditional-format-rules',
          sheetId: reservation.ticket.sheetId,
          requestId: reservation.ticket.requestId,
          revision: acknowledgement.revision,
        }),
      )
      const resultSnapshot = snapshotRulesResult(resultValue, reservation.ticket)
      if (resultSnapshot.result === null) {
        followupError ??=
          resultSnapshot.error ?? 'Conditional formatting rules response was invalid'
      } else if (isCurrentTarget()) {
        set(acceptConditionalFormatRulesResultAtom, {
          ticket: reservation.ticket,
          cache: reservation.cache,
          result: resultSnapshot.result,
        })
      }
    } catch (error) {
      followupError ??= errorMessage(error)
    }
  }

  if (!isCurrentTarget()) return
  if (followupError !== null) {
    set(updateOwnedConditionalFormatEditorAtom, {
      ticket: reservation.ticket,
      error: `Mutation acknowledged; result acceptance failed: ${followupError}`,
    })
    return
  }
  set(closeOwnedConditionalFormatEditorAtom, reservation.ticket)
}

/**
 * Dispatches a conditional-format mutation from a core-owned snapshot. The
 * synchronous reservation prevents caller reads and duplicate captures; the
 * microtask begin publishes pending state before any transport invocation.
 */
export const runConditionalFormatMutationAtom = atom(
  null,
  (_get, set, input: RunConditionalFormatMutationInput): Promise<void> => {
    const reservation = set(reserveConditionalFormatMutationLaunchAtom, input)
    if (reservation === null) return Promise.resolve()
    return Promise.resolve().then(() => executeReservedConditionalFormatMutation(set, reservation))
  },
)
runConditionalFormatMutationAtom.debugLabel = 'spreadsheet.conditionalFormat.runMutation'
