import { atom } from '../atom'
import type { AtomEntity, Atom } from './../type'

type IdObj = {
  id: string
}

function createIdObj(id: string): IdObj {
  const idObj = Object.create(null)
  idObj.id = id
  return idObj
}

const cacheBaseIdsMap = new Map<string, IdObj>()

// 为undefined参数创建一个固定的对象作为键
const UNDEFINED_PARAMS_KEY = Object.freeze(Object.create(null))

export function createGetFamilyAtomById<T2, T = AtomEntity<T2>>(options: {
  defaultState: T2
  debuggerKey?: string
}): <T3 = undefined>(id: string, params?: T2) => T3 extends undefined ? T : AtomEntity<T3>
export function createGetFamilyAtomById<T2, T = AtomEntity<T2>>(options: {
  createAtom: (id: string, params?: T2) => T
  debuggerKey?: string
}): <T3 = undefined>(id: string, params?: T2) => T3 extends undefined ? T : AtomEntity<T3>
/**
 * 终于解决了一个问题，就是家族式组件的缓存问题
 * @param id
 * @param options
 * @returns
 */
export function createGetFamilyAtomById<T2, T extends Atom<unknown> = AtomEntity<T2>>(options: {
  defaultState?: T2
  createAtom?: (id: string, params?: T2) => T
  debuggerKey?: string
}) {
  // const cacheAtomWeakMapAtom = atom(() => {
  //     return new WeakMap<WeakKey, WeakMap<object, T>>()
  // })

  const cacheAtomWeakMap = new WeakMap<WeakKey, WeakMap<object, T>>()

  function getFamilyAtomById<T3 = undefined>(id: string, params?: T2) {
    if (!cacheBaseIdsMap.has(id)) {
      const newIdObj = createIdObj(id)
      cacheBaseIdsMap.set(id, newIdObj)
    }

    // const cacheAtomWeakMap = getter(cacheAtomWeakMapAtom)
    const cacheKey = cacheBaseIdsMap.get(id)!

    // 处理第一层缓存 - 基于 id
    if (!cacheAtomWeakMap.has(cacheKey)) {
      cacheAtomWeakMap.set(cacheKey, new WeakMap())
    }

    const paramsWeakMap = cacheAtomWeakMap.get(cacheKey)!

    // 处理 params 为 undefined 的情况
    const paramsKey =
      params === undefined
        ? UNDEFINED_PARAMS_KEY // 使用固定的空对象作为键
        : (params as object) // 使用 params 作为键，要求 params 必须是对象

    // 处理第二层缓存 - 基于 params
    if (!paramsWeakMap.has(paramsKey)) {
      let newAtom = options.createAtom
        ? options.createAtom(id, params)
        : (atom(options.defaultState) as unknown as T)

      newAtom.debugLabel = `${options.debuggerKey}-${id}`
      paramsWeakMap.set(paramsKey, newAtom)
    }

    return paramsWeakMap.get(paramsKey)! as unknown as T3 extends undefined ? T : AtomEntity<T3>
  }

  return getFamilyAtomById
}
