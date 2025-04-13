import type { FormInstance, NamePath } from './type'
import { useGetFormInstance } from './useGetFormInstance'
import { useCallback } from 'react'

export type UseSetFieldOption = {
  formInstance?: FormInstance
}

export function useSetField<T>(
  name: NamePath,
  { formInstance }: UseSetFieldOption = {},
): (param: T) => void {
  const { setFieldValue } = useGetFormInstance(formInstance)

  const onChange = useCallback(
    (param: T) => {
      setFieldValue(name, param)
    },
    [name, setFieldValue],
  )

  return onChange
}
