import { createContext } from 'react'
import type { FieldInfo, FormInstance, Message } from './type'
import { atom, createStore } from '@einfach/core'
import type { NamePath } from '@einfach/utils'

export const FormContext = createContext(undefined as unknown as FormInstance)

export function createFormDataHelpContext() {
  const store = createStore()

  const valuesAtom = atom<any>({})

  // 校验结果
  const messageMappingAtom = atom(new Map<NamePath, Message>())

  const fieldOptionMappingAtom = atom(new Map<NamePath, FieldInfo>())
  return {
    _store: store,
    _valuesAtom: valuesAtom,
    _messageMappingAtom: messageMappingAtom,
    _fieldOptionMappingAtom: fieldOptionMappingAtom,
  }
}
