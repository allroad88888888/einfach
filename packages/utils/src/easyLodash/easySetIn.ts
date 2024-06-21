import { buildNewObj } from './easyClone'
import type { NamePath } from './type'
import { getObjProp, setObjProp } from './util'

export function exprPath(path: NamePath): (string | number)[] {
  if (Array.isArray(path)) {
    return path
  }
  return path
    .toString()
    .split(/[.[\]]/)
    .filter(Boolean)
}

type Easy = string | number | symbol | boolean | undefined | null

export type Obj = { [key: string]: Easy | Obj } | Obj[]

export function easySetIn<T extends object | object[]>(obj: T, path: NamePath, value: unknown) {
  const propList = exprPath(path)
  const res = buildNewObj(obj)
  let prev: any = res
  const { length } = propList
  propList.forEach((prop: string | number, index) => {
    const realProp = isNaN(prop as number) ? prop : Number(prop)

    if (index === length - 1) {
      // prev[prop] = value
      setObjProp(prev, prop, value)
      return
    }
    if (typeof prev !== 'object') {
      throw `can't support`
    }

    const next = getObjProp(prev, realProp)
    if (next === undefined) {
      const nextProp = propList[index + 1]
      const nextRealProp = isNaN(nextProp as number) ? nextProp : Number(nextProp)
      setObjProp(prev, prop, buildNewObj(getObjProp(prev, realProp), nextRealProp))
    }
    else {
      // prev[prop] = buildNewObj(prev[realProp])
      setObjProp(prev, prop, buildNewObj(getObjProp(prev, realProp)))
    }

    // prev = prev[prop]
    prev = getObjProp(prev, realProp)
  })
  return res as T
}
