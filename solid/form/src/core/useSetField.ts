/** @jsxImportSource solid-js */
import type { FormInstance, NamePath } from './type'
import { useGetFormInstance } from './useGetFormInstance'
import { createMemo } from 'solid-js'

export type UseSetFieldOption = {
  formInstance?: FormInstance
}

export function useSetField<T>(
  name: NamePath,
  { formInstance }: UseSetFieldOption = {},
) {
  const form = useGetFormInstance(formInstance)
  const { setFieldValue } = form

  // 创建设置函数
  const onChange = createMemo(() => {
    return (param: T) => {
      setFieldValue(name, param)
    }
  })()

  return onChange
}
