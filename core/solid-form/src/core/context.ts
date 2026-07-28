/** @jsxImportSource solid-js */
import { createContext, useContext } from 'solid-js'
import type { FieldInfo, FormInstance, Message } from './type'
import { atom, createStore } from '@einfach/core'
import type { NamePath } from '@einfach/utils'

// 创建表单上下文
export const FormContext = createContext<FormInstance | undefined>(undefined)

// 使用表单上下文的钩子
export function useFormContext() {
  return useContext(FormContext)
}

export function createFormDataHelpContext() {
  const store = createStore()

  const valuesAtom = atom<any>({})

  // 校验结果
  const messageMappingAtom = atom(new Map<NamePath, Message>())
  messageMappingAtom.debugLabel = 'messageMappingAtom'

  const fieldOptionMappingAtom = atom(new Map<NamePath, FieldInfo>())
  return {
    _store: store,
    _valuesAtom: valuesAtom,
    _messageMappingAtom: messageMappingAtom,
    _fieldOptionMappingAtom: fieldOptionMappingAtom,
  }
}
