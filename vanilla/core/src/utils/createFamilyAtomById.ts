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

const cacheBaseIdsMap = new WeakMap<object, Map<string, IdObj>>()

function getIdObj(id: string, weakKey: object): IdObj {
  if (!cacheBaseIdsMap.has(weakKey)) {
    cacheBaseIdsMap.set(weakKey, new Map())
  }
  const idObjMap = cacheBaseIdsMap.get(weakKey)!

  if (!idObjMap.has(id)) {
    const newIdObj = createIdObj(id)
    idObjMap.set(id, newIdObj)
  }
  return idObjMap.get(id)!
}

// 为undefined参数创建一个固定的对象作为键
const UNDEFINED_PARAMS_KEY = Object.freeze(Object.create(null))

// 定义基础的 override 函数签名接口
type BaseOverrideFunction<T2 = any, TResult = any> = (
  id: string,
  params?: T2,
) => TResult | undefined

// 定义 getFamilyAtomById 函数类型，包含 override 数组和 push 方法
type GetFamilyAtomByIdWithOverride<T2, T> = {
  <T3 = undefined>(id: string, params?: T2): T3 extends undefined ? T : AtomEntity<T3>
  override: BaseOverrideFunction<T2>[]
  push: <TFunc extends BaseOverrideFunction<T2>>(overrideFunc: TFunc) => void
  set: (id: string, params: T2 | undefined, atom: T) => void
}

export function createGetFamilyAtomById<T2, T = AtomEntity<T2>>(options: {
  defaultState: T2
  debuggerKey?: string
}): GetFamilyAtomByIdWithOverride<T2, T>
export function createGetFamilyAtomById<T2 extends WeakKey, T = AtomEntity<T2>>(options: {
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
  const cacheAtomWeakMap = new WeakMap<IdObj, WeakMap<object, T>>()

  const weakKey = Object.freeze(Object.create(null))

  function getCacheAtomById(id: string) {
    const cacheKey = getIdObj(id, weakKey)
    if (!cacheAtomWeakMap.has(cacheKey)) {
      cacheAtomWeakMap.set(cacheKey, new WeakMap())
    }
    const idCacheAtomWeakMap = cacheAtomWeakMap.get(cacheKey)!

    return idCacheAtomWeakMap
  }

  function getCacheKeyByParams(params?: T2) {
    return params === undefined
      ? UNDEFINED_PARAMS_KEY // 使用固定的空对象作为键
      : (params as object) // 使用 params 作为键，要求 params 必须是对象
  }

  function getFamilyAtomById<T3 = undefined>(id: string, params?: T2) {
    const paramsWeakMap = getCacheAtomById(id)
    const paramsKey = getCacheKeyByParams(params)

    // 先检查缓存中是否已有结果
    if (paramsWeakMap.has(paramsKey)) {
      return paramsWeakMap.get(paramsKey)! as unknown as T3 extends undefined ? T : AtomEntity<T3>
    }

    // 缓存中没有，依次执行 override 数组中的函数
    for (const overrideFunc of (getFamilyAtomById as any).override) {
      const overrideResult = overrideFunc(id, params)
      if (overrideResult !== undefined) {
        // 将 override 的结果也存入缓存
        paramsWeakMap.set(paramsKey, overrideResult as T)
        return overrideResult as T3 extends undefined ? T : AtomEntity<T3>
      }
    }

    // 所有 override 函数都返回 undefined，创建默认的 atom
    let newAtom = options.createAtom
      ? options.createAtom(id, params)
      : (atom(options.defaultState) as unknown as T)

    newAtom.debugLabel = `${options.debuggerKey}-${id}`

    // 将新创建的 atom 存入缓存
    paramsWeakMap.set(paramsKey, newAtom)

    return newAtom as unknown as T3 extends undefined ? T : AtomEntity<T3>
  }

  const temp = getFamilyAtomById as GetFamilyAtomByIdWithOverride<T2, T>
  temp.override = []
  temp.push = function (overrideFunc: BaseOverrideFunction<T2>) {
    temp.override.push(overrideFunc)
  }
  temp.set = function (id: string, params: T2 | undefined, atomEntity: T) {
    const paramsWeakMap = getCacheAtomById(id)
    const paramsKey = getCacheKeyByParams(params)
    paramsWeakMap.set(paramsKey, atomEntity)
  }
  return temp
}
