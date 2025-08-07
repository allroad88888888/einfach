import { atom } from '../atom'
import type { AtomEntity, Atom } from './../type'

const globalIdSymbolMap = new Map<string, symbol>()

function getGlobalSymbolForId(id: string): symbol {
  let symbolKey = globalIdSymbolMap.get(id)
  if (!symbolKey) {
    symbolKey = Symbol(id)
    globalIdSymbolMap.set(id, symbolKey)
  }
  return symbolKey
}

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
export function createGetFamilyAtomById<T2, T extends Atom<unknown> = AtomEntity<T2>>(options: {
  defaultState?: T2
  createAtom?: (id: string, params?: T2) => T
  debuggerKey?: string
}) {
  const cacheAtomWeakMap = new WeakMap<symbol, T>()

  function getFamilyAtomById<T3 = undefined>(id: string, params?: T2) {
    const symbolKey = getGlobalSymbolForId(id)
    const cacheAtom = cacheAtomWeakMap.get(symbolKey)
    if (cacheAtom) {
      return cacheAtom as unknown as T3 extends undefined ? T : AtomEntity<T3>
    }

    let newAtom = options.createAtom
      ? options.createAtom(id, params)
      : (atom(options.defaultState) as unknown as T)

    newAtom.debugLabel = `${options.debuggerKey}-${id}`

    // 将新创建的 atom 存入缓存
    cacheAtomWeakMap.set(symbolKey, newAtom)

    return newAtom as unknown as T3 extends undefined ? T : AtomEntity<T3>
  }

  return getFamilyAtomById as GetFamilyAtomByIdWithOverride<T2, T>
}
