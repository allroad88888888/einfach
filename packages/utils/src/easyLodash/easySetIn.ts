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

export type Obj = { [key: string]: Easy | Obj | Easy[] } | (Obj | Easy)[]

export function easySetIn<T extends object | object[]>(obj: T, path: NamePath, value: unknown) {
  const propList = exprPath(path)
  const res = buildNewObj(obj)
  let prev: any = res
  const { length } = propList

  for (let i = 0; i < length; i += 1) {
    const prop = propList[i]
    const isObj = isNaN(prop as number)
    const realProp = isObj ? prop : Number(prop)

    if (i === length - 1) {
      setObjProp(prev, prop, value)
      break
    }

    const next = getObjProp(prev, realProp)
    if (!(next instanceof Object)) {
      setObjProp(prev, realProp, isNaN(propList[i + 1] as number) ? {} : [])
    } else {
      setObjProp(prev, realProp, buildNewObj(getObjProp(prev, realProp)))
    }
    prev = getObjProp(prev, realProp)
  }

  return res as T
}
