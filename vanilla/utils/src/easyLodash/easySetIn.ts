import { buildNewObj } from './easyClone'
import type { NamePath } from './type'
import { getObjProp, setObjProp } from './util'

export function exprPath(path: NamePath): (string | number)[] {
  if (Array.isArray(path)) {
    return path
  }

  const str = path.toString()
  const result: (string | number)[] = []

  // 使用正则表达式匹配不同的路径片段
  // 匹配: 普通属性名 或 方括号包围的内容
  const regex = /([^.\[\]]+)|\[([^\]]*)\]/g
  let match

  while ((match = regex.exec(str)) !== null) {
    if (match[1] !== undefined) {
      // 普通属性名（通过点分隔或直接的属性名）
      result.push(match[1])
    } else if (match[2] !== undefined) {
      // 方括号内的内容，检查是否为数字
      const bracketContent = match[2]
      const num = Number(bracketContent)
      if (!isNaN(num) && bracketContent !== '') {
        result.push(num)
      } else {
        result.push(bracketContent)
      }
    }
  }

  return result
}

type Easy = string | number | symbol | boolean | undefined | null

export type Obj = { [key: string]: Easy | Obj | Easy[] } | (Obj | Easy)[]

export function easySetIn<T extends object | object[]>(obj: T, path: NamePath, value: unknown) {
  if (!path) {
    return value as T
  }
  const propList = exprPath(path)
  const res = buildNewObj(obj)
  let prev: any = res
  const { length } = propList

  for (let i = 0; i < length; i += 1) {
    const prop = propList[i]

    if (i === length - 1) {
      setObjProp(prev, prop, value)
      break
    }

    const next = getObjProp(prev, prop)
    if (!(next instanceof Object)) {
      // 判断下一个属性是否为数字（数组索引），决定创建对象还是数组
      const nextProp = propList[i + 1]
      setObjProp(prev, prop, typeof nextProp === 'number' ? [] : {})
    } else {
      setObjProp(prev, prop, buildNewObj(getObjProp(prev, prop)))
    }
    prev = getObjProp(prev, prop)
  }

  return res as T
}
