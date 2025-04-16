/** @jsxImportSource solid-js */
import type { FormInstance, Message, NamePath, Rule } from './type'
import { buildEventRulesMapping, namePathToStr } from './validator'
import { useGetFormInstance } from './useGetFormInstance'
import { createEffect, createMemo } from 'solid-js'
import { useEasySelectAtomValue } from './utils/useEasyGetAtom'

export type UseRulesOption = {
  formInstance?: FormInstance
  rules?: Rule[]
  label?: string
}

export function useValidator(name: NamePath, { formInstance, rules = [], label }: UseRulesOption) {
  const form = useGetFormInstance(formInstance)
  const { _store, validateField, _messageMappingAtom, _fieldOptionMappingAtom } = form

  const nameStr = namePathToStr(name)

  // 创建选择器atom获取消息
  const message = useEasySelectAtomValue(_messageMappingAtom, nameStr, Object.is, { store: _store }) as () => (Message | undefined)

  // 设置字段选项
  createEffect(() => {
    const rulesMapping = new Map(_store.getter(_fieldOptionMappingAtom))
    rulesMapping.set(nameStr, {
      label,
      rules,
    })
    _store.setter(_fieldOptionMappingAtom, rulesMapping)
  })

  // 创建验证方法
  const validatorEventsMap = createMemo(() => {
    const tempMethods = buildEventRulesMapping(rules)
    const func: Record<string, () => Promise<boolean>> = Object.create(null)

    tempMethods.forEach((_, eventName) => {
      func[eventName] = () => {
        return validateField(name, eventName)
      }
    })

    return func
  })()


  return { message, methods: validatorEventsMap }
}
