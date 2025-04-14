import type { Rule } from '../type'

export function buildEventRulesMapping(rules: Rule[] = []) {
  if (!Array.isArray(rules)) {
    throw 'rules not array'
  }
  const triggerMap = new Map<string, Set<Rule>>()
  rules.forEach((rule) => {
    let validateTriggers = (rule.validateTrigger || 'onChange') as string[]
    if (!Array.isArray(validateTriggers)) {
      validateTriggers = [validateTriggers as string]
    }
    validateTriggers.forEach((validateTrigger) => {
      if (!triggerMap.has(validateTrigger)) {
        triggerMap.set(validateTrigger, new Set())
      }
      triggerMap.get(validateTrigger)!.add(rule)
    })
  })
  return triggerMap
}
