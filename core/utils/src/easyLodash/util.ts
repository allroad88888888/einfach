import type { ObjectType } from './type'

export function setObjProp(obj: any, prop: any, value: any) {
  if (typeof obj !== 'object') {
    // return isNaN(prop) ? { [prop]: value } : [value]
    throw "setObjProp can't support"
  }
  const type = Object.prototype.toString.call(obj) as ObjectType

  switch (type) {
    case '[object Array]': {
      obj[prop] = value
      return obj
    }
    case '[object Object]': {
      obj[prop] = value
      return obj
    }
    case '[object Map]': {
      obj.set(prop, value)
      return obj
    }
    case '[object Set]': {
      const temp = Array.from(obj)
      ;(obj as Set<any>).clear()
      temp.forEach((item, index) => {
        obj.add(index === prop ? value : item)
      })
      return obj
    }
    default:
      throw "setObjProp can't support"
  }
}

export function getObjProp(obj: any, prop: any) {
  if (typeof obj !== 'object' || null === obj) {
    // throw `getObjProp can't support`
    // return obj
    return undefined
  }
  const type = Object.prototype.toString.call(obj) as ObjectType

  switch (type) {
    case '[object Array]':
    case '[object Object]': {
      return obj[prop]
    }
    case '[object Map]': {
      return obj.get(prop)
    }
    case '[object Set]': {
      return Array.from(obj).find((temp, index) => {
        return index === prop
      })
    }
    default:
      throw "getObjProp can't support"
  }
}
