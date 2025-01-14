import type { FormInstance, Message, NamePath, Rule } from './type'
import { useInit } from '@einfach/utils'
import { buildEventRulesMapping, namePathToStr } from './validator'
import { useEasySelectAtomValue } from '@einfach/utils'

import { useGetFormInstance } from './useGetFormInstance'
import { useEffect, useLayoutEffect } from 'react'

export type UseRulesOption = {
  formInstance?: FormInstance
  rules?: Rule[]
  label?: string
}

export function useValidator(name: NamePath, { formInstance, rules = [], label }: UseRulesOption) {
  const { _store, validateField, _messageMappingAtom, _fieldOptionMappingAtom } =
    useGetFormInstance(formInstance)

  const nameStr = namePathToStr(name)
  const message = useEasySelectAtomValue(_messageMappingAtom, nameStr, Object.is, {
    store: _store,
  }) as Message | undefined

  useLayoutEffect(() => {
    const rulesMapping = new Map(_store.getter(_fieldOptionMappingAtom))
    rulesMapping.set(nameStr, {
      label,
      rules,
    })
    _store.setter(_fieldOptionMappingAtom, rulesMapping)
  }, [_fieldOptionMappingAtom, _store, label, nameStr, rules])

  const validatorEventsMap = useInit(() => {
    const tempMethods = buildEventRulesMapping(rules)
    const func: Record<string, () => Promise<boolean>> = Object.create(null)
    tempMethods.forEach((t, eventName) => {
      func[eventName] = () => {
        return validateField(name, eventName)
      }
    })

    return func
  }, [])

  useEffect(() => {
    return () => {
      const tMessage = _store.getter(_messageMappingAtom)
      tMessage.delete(nameStr)
      _store.setter(_messageMappingAtom, new Map(tMessage))
    }
  }, [])

  return { message, methods: validatorEventsMap }
}
