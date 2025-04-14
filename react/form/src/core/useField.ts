import type { FormInstance, Message, NamePath } from './type'
import { useFieldValue } from './useFieldValue'
import { useSetField } from './useSetField'
import { useGetFormInstance } from './useGetFormInstance'

export type UseFieldOption = {
  formInstance?: FormInstance
}

export function useField<T>(
  name: NamePath,
  { formInstance }: UseFieldOption = {},
): {
  value: T
  onChange: (param: T) => void
  message?: Message
} {
  const form = useGetFormInstance(formInstance)

  const value = useFieldValue<T>(name, { formInstance: form })
  const setField = useSetField<T>(name, { formInstance: form })

  return {
    value,
    onChange: setField,
  }
}
