/** @jsxImportSource solid-js */
import { useAtomValue } from '@einfach/solid'
import { useGetFormInstance } from './useGetFormInstance'
import type { FormInstance } from './type'

export function useFormValues(formInstance: FormInstance) {
  const { _store: store, _valuesAtom } = useGetFormInstance(formInstance)
  const values = useAtomValue(_valuesAtom, { store })
  return values
}
