import { useState } from 'react'
import { selectAtom, useAtomValue } from 'einfach-state'
import type { FormInstance, NamePath } from './type'
import { useGetFormInstance } from './useGetFormInstance'
import { easyGet } from 'einfach-utils'

export type UseFieldValueOption = {
  formInstance?: FormInstance
}

export function useFieldValue<T>(name: NamePath, { formInstance }: UseFieldValueOption = {}): T {
  const { _store: store, _valuesAtom } = useGetFormInstance(formInstance)

  const [atomEntity] = useState(() => {
    return selectAtom(_valuesAtom, (state) => {
      return easyGet(state, name) as T
    })
  })

  const value = useAtomValue(atomEntity, { store })

  return value as T
}
