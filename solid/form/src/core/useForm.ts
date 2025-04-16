/** @jsxImportSource solid-js */
import { createMemo } from 'solid-js'
import type { CreateDataHelpAtoms, FormInstance, NamePath } from './type'
import type { Obj } from '@einfach/utils'
import { easyGet, easySetIn } from '@einfach/utils'
import { buildEventRulesMapping, namePathToStr, validatorItem } from './validator'
import { createFormDataHelpContext as defaultCreateDataHelpContext } from './context'


export interface FormProps<T extends Obj> {
  initialValues?: any
  onValuesChange?: (changedValues: any, allValues: T) => void
  createFormDataHelpContext?: (
    ...param: Parameters<CreateDataHelpAtoms>
  ) => Partial<ReturnType<CreateDataHelpAtoms>>
}


export function useForm<Values extends Obj>(props: FormProps<Values>): FormInstance {
  const { initialValues, onValuesChange: propOnValueChange, createFormDataHelpContext } = props

  // 创建表单数据上下文
  const dataHelpContext = createMemo(() => {
    return {
      ...defaultCreateDataHelpContext(),
      ...(createFormDataHelpContext ? createFormDataHelpContext() : {}),
    }
  })()

  const { _store, _valuesAtom, _messageMappingAtom, _fieldOptionMappingAtom } = dataHelpContext
  const { getter, setter } = _store

  // 设置初始值
  if (initialValues) {
    setter(_valuesAtom, initialValues)
  }

  // 设置消息
  const setMessage = (name: NamePath, message: any) => {
    const nameStr = namePathToStr(name)
    const messageMap = new Map(getter(_messageMappingAtom))
    messageMap.set(nameStr, message)
    setter(_messageMappingAtom, messageMap)
  }

  // 值变化回调
  const onValuesChange = (changedValues: any, allValues: Values) => {
    if (propOnValueChange) {
      propOnValueChange(changedValues, allValues)
    }
  }

  // 获取字段值
  const getFieldValue = <T>(name: NamePath) => {
    const values = getter(_valuesAtom)
    return easyGet(values, name) as T
  }

  // 获取字段消息
  const getFieldMessage = (name: NamePath) => {
    const messageMap = getter(_messageMappingAtom)
    const nameStr = namePathToStr(name)
    return messageMap.get(nameStr as string)
  }

  // 验证字段
  const validateField = async (name: NamePath, eventName?: string) => {
    const fieldOptionMapping = getter(_fieldOptionMappingAtom)
    const nameStr = namePathToStr(name)
    const fieldOption = fieldOptionMapping.get(nameStr)

    if (!fieldOption) {
      return true
    }

    const { rules = [], label } = fieldOption
    const tempMethods = buildEventRulesMapping(rules)

    const val = getFieldValue(name)

    const warnList: string[] = []
    const errorList: string[] = []

    for (const [key, tRules] of tempMethods) {
      if (eventName && key !== eventName) {
        break
      }
      try {
        for (const rule of tRules) {
          const res = await validatorItem(val, {
            rule,
            label,
            values: getter(_valuesAtom),
            store: _store,
          })
          if (typeof res === 'string') {
            warnList.push(res)
          }
        }
      } catch (error) {
        if (typeof error === 'string') {
          errorList.push(error as string)
        } else {
          throw error
        }
      }
    }

    setMessage(name, {
      error: errorList.length === 0 ? undefined : errorList,
      warn: warnList.length === 0 ? undefined : warnList,
    })

    return errorList.length === 0
  }

  // 验证所有字段
  const validateFields = async () => {
    const fieldOptionMapping = getter(_fieldOptionMappingAtom)
    const nameList = Array.from(fieldOptionMapping.keys())

    const results = await Promise.all(
      nameList.map(async (nameStr) => {
        return validateField(nameStr)
      })
    )

    return results.every(Boolean)
  }

  // 设置字段值
  const setFieldValue = <T>(name: NamePath, value: T) => {
    const values = getter(_valuesAtom) as Values
    const res = easySetIn(values, name, value)
    setter(_valuesAtom, res)
    onValuesChange(
      {
        name,
        value,
      },
      res,
    )
  }

  // 设置多个字段值
  const resetValues = (values: any) => {
    setter(_valuesAtom, values)
    onValuesChange(values, values)
  }

  // 获取多个字段值
  const getFieldsValue = (nameList: true | NamePath[]) => {
    const values = getter(_valuesAtom)
    if (nameList === true) {
      return values
    }
    return nameList.map((path) => {
      return easyGet(values, path)
    })
  }

  // 返回表单实例
  return {
    ...dataHelpContext,
    setFieldValue,
    resetValues,
    getFieldValue,
    getFieldsValue,
    validateField,
    validateFields,
    getFieldMessage,
  }
}
