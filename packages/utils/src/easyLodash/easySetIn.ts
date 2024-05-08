/* eslint-disable @typescript-eslint/ban-ts-comment */
import type { NamePath } from './type'

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

// export type SetValue = Easy | Record<string, Easy> | (Easy | SetValue | Record<string, SetValue>)[]

export type Obj = { [key: string]: Easy | Obj } | Obj[]

function buildNewObj<T extends object | object[]>(obj: T): T | T[] {
  if (Array.isArray(obj)) {
    return [...obj]
  }
  return {
    ...obj,
  }
}

export function easySetIn<T extends object | object[]>(obj: T, path: NamePath, value: unknown) {
  const propList = exprPath(path)
  const res = buildNewObj(obj)
  let prev = res
  const { length } = propList
  propList.forEach((prop: string | number, index) => {
    const numProp = Number(prop)
    if (index === length - 1) {
      // @ts-expect-error
      prev[prop] = value
      return
    }

    if (isNaN(numProp)) {
      // @ts-expect-error
      prev[prop] = buildNewObj(prev[prop])
    }
    else {
      // @ts-expect-error
      prev[prop] = buildNewObj(prev[numProp])
    }
    // @ts-expect-error
    prev = prev[prop]
  })
  return res as T
}
