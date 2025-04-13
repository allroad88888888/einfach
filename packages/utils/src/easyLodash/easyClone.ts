import type { ObjectType } from './type'

export function easyClone<T>(obj: T): T {
  if (typeof obj !== 'object' || !obj) {
    return obj
  }
  const type = Object.prototype.toString.call(obj)

  if (type === '[object Array]') {
    return (obj as any[]).map((value) => {
      return easyClone(value)
    }) as T
  }
  if (type === '[object Object]') {
    const newObj = {
      ...(obj as object),
    }
    Object.keys(obj as object).forEach((key) => {
      (obj as Record<string, unknown>)[key] = easyClone((obj as Record<string, unknown>)[key])
    })
    return newObj as T
  }

  if (type === '[object Set]') {
    const newObj = new Set()
    for (const value of obj as unknown as Set<any>) {
      newObj.add(easyClone(value))
    }
    return newObj as T
  }

  if (type === '[object Map]') {
    const newObj = new Map()
    for (const [key, value] of obj as unknown as Map<any, any>) {
      newObj.set(key, easyClone(value))
    }
    return newObj as T
  }

  throw `can't support ${type}`
}

export function buildNewObj<T>(obj: T, path?: string | number): T {
  if (typeof obj === 'object') {
    const type = Object.prototype.toString.call(obj) as ObjectType

    switch (type) {
      case '[object Array]': {
        return [...(obj as any[])] as T
      }
      case '[object Object]': {
        return {
          ...(obj as object),
        } as T
      }
      case '[object Null]': {
        return obj
      }
      case '[object Set]': {
        return new Set(obj as Set<any>) as T
      }
      case '[object Map]': {
        return new Map(obj as Map<any, any>) as T
      }

      default:
        throw `can't support ${type}`
    }
  }
  if (obj === undefined && path) {
    const pathType = typeof path
    switch (pathType) {
      case 'string': {
        return {} as T
      }
      case 'number': {
        return new Array(path) as T
      }
      default:
        return obj
    }
  }
  return obj
}
