/** @jsxImportSource solid-js */
import { selectAtom } from '@einfach/core'
import { useAtomValue } from '@einfach/solid'
import type { FormInstance, NamePath } from './type'
import { useGetFormInstance } from './useGetFormInstance'
import { easyGet } from '@einfach/utils'
import { createMemo } from 'solid-js'

export type UseFieldValueOption = {
  formInstance?: FormInstance
}

export function useFieldValue<T>(name: NamePath, options: UseFieldValueOption = {}) {
  const form = useGetFormInstance(options.formInstance)

  // 创建选择器atom
  const atomEntity = createMemo(() => {
    return selectAtom(form._valuesAtom, (state) => {
      return easyGet(state, name) as T
    })
  })()

  // 使用atom值
  const value = useAtomValue(atomEntity, { store: form._store })



  return value
}
