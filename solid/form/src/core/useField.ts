/** @jsxImportSource solid-js */
import type { FormInstance, NamePath } from './type'
import { useFieldValue } from './useFieldValue'
import { useSetField } from './useSetField'
import { useGetFormInstance } from './useGetFormInstance'


export type UseFieldOption = {
  formInstance?: FormInstance
}

export function useField<T>(
  name: NamePath,
  options: UseFieldOption = {},
) {

  const form = useGetFormInstance(options.formInstance)

  // 获取字段值
  const value = useFieldValue<T>(name, { formInstance: form })

  // 获取设置函数
  const setField = useSetField<T>(name, { formInstance: form })

  return {
    value,
    onChange: setField,
  }
}
