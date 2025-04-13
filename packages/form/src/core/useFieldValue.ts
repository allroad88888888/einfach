import { selectAtom } from '@einfach/core'
import { useAtomValue } from '@einfach/react'
import type { FormInstance, NamePath } from './type'
import { useGetFormInstance } from './useGetFormInstance'
import { easyGet, useInit } from '@einfach/utils'

export type UseFieldValueOption = {
  formInstance?: FormInstance
}

export function useFieldValue<T>(name: NamePath, { formInstance }: UseFieldValueOption = {}): T {
  const { _store: store, _valuesAtom } = useGetFormInstance(formInstance)

  const atomEntity = useInit(() => {
    return selectAtom(_valuesAtom, (state) => {
      return easyGet(state, name) as T
    })
  }, [store, _valuesAtom, name])

  const value = useAtomValue(atomEntity, { store })

  return value as T
}
