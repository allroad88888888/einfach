import type { FormInstance, NamePath, Rule } from './type'
import { useInit } from 'einfach-utils'
import { buildEventRulesMapping, namePathToStr } from './validator'
import { useSelectAtomValue } from 'einfach-state'
import type { Message } from './state'
import { messageMappingAtom, fieldOptionMappingAtom } from './state'
import { useGetFormInstance } from './useGetFormInstance'
import { useLayoutEffect } from 'react'

export type UseRulesOption = {
  formInstance?: FormInstance
  rules?: Rule[]
  label?: string
}

export function useValidator(
  name: NamePath,
  { formInstance, rules = [], label }: UseRulesOption,
) {
  const { _store, validateField } = useGetFormInstance(formInstance)

  const nameStr = namePathToStr(name)
  const message = useSelectAtomValue(messageMappingAtom,
    nameStr, { store: _store }) as Message | undefined

  useLayoutEffect(() => {
    const rulesMapping = _store.getter(fieldOptionMappingAtom)
    rulesMapping.set(nameStr, {
      label, rules,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameStr, rules])

  const validatorEventsMap = useInit(() => {
    const tempMethods = buildEventRulesMapping(rules)
    const func: Record<string, () => Promise<boolean>> = Object.create(null)
    tempMethods.forEach((rules, eventName) => {
      func[eventName] = () => {
        return validateField(name, eventName)
      }
    })

    return func
  }, [])

  return { message, methods: validatorEventsMap }
}
