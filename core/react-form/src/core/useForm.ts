import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { CreateDataHelpAtoms, FormInstance, NamePath } from './type'
import type { Obj } from '@einfach/utils'
import { easyGet, easySetIn } from '@einfach/utils'
import { buildEventRulesMapping, namePathToStr, validatorItem } from './validator'
import { createFormDataHelpContext as defaultCreateDataHelpContext } from './context'
import { useEasySetAtom, useInit } from '@einfach/react-utils'

export interface FormProps<T extends Obj> {
  initialValues?: any
  values?: any
  onValuesChange?: (changedValues: any, allValues: T) => void
  createFormDataHelpContext?: (
    ...param: Parameters<CreateDataHelpAtoms>
  ) => Partial<ReturnType<CreateDataHelpAtoms>>
}

export function useForm<Values extends Obj>(props: FormProps<Values>): FormInstance {
  const { initialValues, onValuesChange: propOnValueChange, createFormDataHelpContext } = props
  const dataHelpContext = useInit(() => {
    return {
      ...defaultCreateDataHelpContext(),
      ...(createFormDataHelpContext ? createFormDataHelpContext() : {}),
    }
  }, [createFormDataHelpContext])
  const { _store, _valuesAtom, _messageMappingAtom, _fieldOptionMappingAtom } = dataHelpContext
  const { getter, setter } = _store
  const setValues = useEasySetAtom(_valuesAtom, { store: _store })
  const { current } = useRef({
    init: false,
  })
  if (current.init === false) {
    if (initialValues) {
      setValues(initialValues)
    }
    current.init = true
  }

  useLayoutEffect(() => {
    if (!('values' in props)) {
      return
    }

    setValues(props.values)
  }, [props.values])

  const setMessage = useEasySetAtom(_messageMappingAtom, { store: _store })

  const onValuesChange = useCallback(
    (changedValues: any, allValues: Values) => {
      if (propOnValueChange) {
        propOnValueChange(changedValues, allValues)
      }
    },
    [propOnValueChange],
  )
  const getFieldValue = useCallback(
    <T>(name: NamePath) => {
      const values = getter(_valuesAtom)
      return easyGet(values, name) as T
    },
    [_valuesAtom, getter],
  )

  const getFieldMessage = useCallback(
    (name: NamePath) => {
      const messageMap = getter(_messageMappingAtom)
      const nameStr = namePathToStr(name)
      return messageMap.get(nameStr as string)
    },
    [_messageMappingAtom, getter],
  )
  const validateField = useCallback(
    async (name: NamePath, eventName?: string) => {
      const rulesMapping = getter(_fieldOptionMappingAtom)
      const nameStr = namePathToStr(name)
      if (!rulesMapping.has(nameStr) || rulesMapping.get(nameStr)?.rules?.length === 0) {
        return true
      }
      const { rules, label } = rulesMapping.get(nameStr)!
      const tempMethods = buildEventRulesMapping(rules)
      if (eventName && !tempMethods.has(eventName)) {
        return true
      }

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
    },
    [_fieldOptionMappingAtom, _store, _valuesAtom, getFieldValue, getter, setMessage],
  )

  const setFieldValue = useCallback(
    <T>(name: NamePath, value: T) => {
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
    },
    [_valuesAtom, getter, onValuesChange, setter],
  )

  const setFieldsValue = useCallback(
    (values: any) => {
      setter(_valuesAtom, values)
      onValuesChange(values, values)
    },
    [_valuesAtom, onValuesChange, setter],
  )

  const getFieldsValue = useCallback(
    (nameList: true | NamePath[]) => {
      const values = getter(_valuesAtom)
      if (nameList === true) {
        return values
      }
      return nameList.map((path) => {
        return easyGet(values, path)
      })
    },
    [_valuesAtom, getter],
  )
  const validateFields = useCallback(async () => {
    const rulesMapping = getter(_fieldOptionMappingAtom)
    for (const [namePath] of rulesMapping) {
      await validateField(namePath)
    }
    const messageMapping = getter(_messageMappingAtom)
    let hasError = false
    for (const [, message] of messageMapping) {
      if (hasError) {
        break
      }
      if (message.error && message.error.length > 0) {
        hasError = true
      }
    }

    return hasError
  }, [_fieldOptionMappingAtom, _messageMappingAtom, getter, validateField])

  return useMemo<FormInstance>(() => {
    return {
      ...dataHelpContext,
      setFieldValue,
      setFieldsValue,
      getFieldValue,
      getFieldsValue,
      validateField,
      validateFields,
      getFieldMessage: getFieldMessage,
    }
  }, [
    dataHelpContext,
    getFieldMessage,
    getFieldValue,
    getFieldsValue,
    setFieldValue,
    setFieldsValue,
    validateField,
    validateFields,
  ])
}
