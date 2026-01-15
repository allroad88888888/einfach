import { atom } from '../atom'
import type { AtomEntity, Atom } from './../type'
import { createCacheStomById } from './createCacheStom'

// 定义 getFamilyAtomById 函数类型，包含 override 数组和 push 方法
type GetFamilyAtomByIdWithOverride<T2, T> = {
  <T3 = undefined>(id: string, params?: T2): T3 extends undefined ? T : AtomEntity<T3>
}

export function createGetFamilyAtomById<T2, T = AtomEntity<T2>>(options: {
  defaultState: T2
  debuggerKey?: string
}): GetFamilyAtomByIdWithOverride<T2, T>
export function createGetFamilyAtomById<T2, T = AtomEntity<T2>>(options: {
  createAtom: (id: string, params?: T2) => T
  debuggerKey?: string
}): GetFamilyAtomByIdWithOverride<T2, T>
/**
 * 终于解决了一个问题，就是家族式组件的缓存问题
 * @param id
 * @param options
 * @returns
 */
export function createGetFamilyAtomById<T2, T extends Atom<unknown> = AtomEntity<T2>>({
  debuggerKey,
  defaultState,
  createAtom,
}: {
  defaultState?: T2
  createAtom?: (id: string, params?: T2) => T
  debuggerKey?: string
}) {
  return (id: string, params?: T2) => {
    const fn = createCacheStomById({
      createAtom: (tid: string) => {
        return createAtom ? createAtom(id, params) : atom(defaultState)
      },
      debuggerKey: debuggerKey || 'family',
    }) as GetFamilyAtomByIdWithOverride<T2, T>
    return fn(id, params)
  }
}
