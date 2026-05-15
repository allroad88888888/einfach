import { atom } from '@einfach/core'
import type {
  ConditionalFormatEditorState,
  ConditionalFormatRuleEntry,
  ConditionalFormatRulesState,
} from './types'

export * from './types'

export const CONDITIONAL_FORMAT_RULES_MAX = 200

// --- Source atoms ---

export const conditionalFormatRulesCacheAtom = atom<ConditionalFormatRulesState>({
  sheetId: null,
  rules: [],
})
conditionalFormatRulesCacheAtom.debugLabel = 'spreadsheet.conditionalFormat.rulesCache'

export const conditionalFormatEditorAtom = atom<ConditionalFormatEditorState>({
  open: false,
  ruleId: null,
  draft: null,
})
conditionalFormatEditorAtom.debugLabel = 'spreadsheet.conditionalFormat.editor'

// --- Command atoms ---

export const setConditionalFormatRulesAtom = atom(
  null,
  (_get, set, next: ConditionalFormatRulesState) => {
    const capped: ConditionalFormatRulesState = {
      sheetId: next.sheetId,
      rules:
        next.rules.length > CONDITIONAL_FORMAT_RULES_MAX
          ? next.rules.slice(next.rules.length - CONDITIONAL_FORMAT_RULES_MAX)
          : next.rules,
    }
    set(conditionalFormatRulesCacheAtom, capped)
  },
)
setConditionalFormatRulesAtom.debugLabel = 'spreadsheet.conditionalFormat.setRules'

export const openConditionalFormatEditorAtom = atom(
  null,
  (_get, set, entry: ConditionalFormatRuleEntry | null) => {
    set(conditionalFormatEditorAtom, {
      open: true,
      ruleId: entry?.id ?? null,
      draft: entry,
    })
  },
)
openConditionalFormatEditorAtom.debugLabel = 'spreadsheet.conditionalFormat.openEditor'

export const closeConditionalFormatEditorAtom = atom(null, (_get, set) => {
  set(conditionalFormatEditorAtom, {
    open: false,
    ruleId: null,
    draft: null,
  })
})
closeConditionalFormatEditorAtom.debugLabel = 'spreadsheet.conditionalFormat.closeEditor'
