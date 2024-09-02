import { createContext } from 'react'
import type { FieldInfo, FormInstance, Message } from './type'
import { atom, createStore } from 'einfach-state'
import type { Obj } from 'einfach-utils'

export const FormContext = createContext(undefined as unknown as FormInstance)

export function createFormDataHelpContext() {
  const store = createStore()

  const valuesAtom = atom<Obj>({})

  // 校验结果
  const messageMappingAtom = atom(new Map<string | number, Message>())

  const fieldOptionMappingAtom = atom(new Map<string | number, FieldInfo>())
  return {
    _store: store,
    _valuesAtom: valuesAtom,
    _messageMappingAtom: messageMappingAtom,
    _fieldOptionMappingAtom: fieldOptionMappingAtom,
  }
}

export type FormDataHelpType = ReturnType<typeof createFormDataHelpContext>
