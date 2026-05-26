import { atom } from '@einfach/core'
import { editingSessionAtom } from '../editing'
import type {
  ClearValidationRuleRequest,
  SetValidationRuleRequest,
  ValidationMode,
  ValidationOutcome,
  ValidationRule,
  ValidationRuleEditorState,
} from './types'

export * from './types'

export const validationRuleEditorAtom = atom<ValidationRuleEditorState>({ status: 'closed' })
validationRuleEditorAtom.debugLabel = 'spreadsheet.validation.ruleEditor'

export const openValidationRuleEditorAtom = atom(
  null,
  (_get, set, state: Omit<ValidationRuleEditorState, 'status'>) => {
    set(validationRuleEditorAtom, { status: 'editing', ...state })
  },
)
openValidationRuleEditorAtom.debugLabel = 'spreadsheet.validation.openRuleEditor'

export const closeValidationRuleEditorAtom = atom(null, (_get, set) => {
  set(validationRuleEditorAtom, { status: 'closed' })
})
closeValidationRuleEditorAtom.debugLabel = 'spreadsheet.validation.closeRuleEditor'

export const setValidationDraftAtom = atom(
  null,
  (get, set, patch: Partial<ValidationRule>) => {
    const editor = get(validationRuleEditorAtom)
    if (editor.status !== 'editing') return
    const merged = editor.draft == null ? patch : { ...editor.draft, ...patch }
    set(validationRuleEditorAtom, { ...editor, draft: merged as ValidationRule })
  },
)
setValidationDraftAtom.debugLabel = 'spreadsheet.validation.setDraft'

export function evaluateValidationLocal(rule: ValidationRule, input: string): ValidationOutcome | null {
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
    const re = new RegExp(rule.pattern, rule.flags)
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

  if (editing.status !== 'drafting' || editor.status !== 'editing') return null
  if (editor.draft == null) return null

  return evaluateValidationLocal(editor.draft, editing.draft)
})
validationStatusAtom.debugLabel = 'spreadsheet.validation.status'

export type { SetValidationRuleRequest, ClearValidationRuleRequest, ValidationMode, ValidationRule, ValidationOutcome }
