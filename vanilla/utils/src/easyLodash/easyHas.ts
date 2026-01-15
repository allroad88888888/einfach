import type { NamePath, ObjectType } from './type'

/**
 * 检查对象中是否存在指定的属性
 * 类似于 getObjProp，但使用 "in" 操作符或相应的存在性检查
 */
export function hasObjProp(obj: any, prop: any): boolean {
  // 处理 null 和 undefined
  if (obj === null || obj === undefined) {
    return false
  }

  // 对于原始类型，尝试使用 in 操作符（会自动装箱）
  try {
    if (typeof obj !== 'object') {
      return prop in Object(obj)
    }
  } catch {
    return false
  }

  const type = Object.prototype.toString.call(obj) as ObjectType

  switch (type) {
    case '[object Array]':
    case '[object Object]': {
      return prop in obj
    }
    case '[object Map]': {
      return obj.has(prop)
    }
    case '[object Set]': {
      const array = Array.from(obj)
      return prop >= 0 && prop < array.length
    }
    default:
      return prop in obj
  }
}

/**
 * 判断指定的 namepath 路径是否存在于对象中
 *
 * @param data - 要检查的对象
 * @param path - 路径，可以是字符串、数字或数组形式
 * @returns 如果路径存在返回 true，否则返回 false
 *
 * @example
 * const obj = { user: { profile: { name: 'John' } } }
 * easyHas(obj, 'user.profile.name') // true
 * easyHas(obj, 'user.profile.age') // false
 * easyHas(obj, ['user', 'profile', 'name']) // true
 *
 * const arr = [{ id: 1 }, { id: 2 }]
 * easyHas(arr, '0.id') // true
 * easyHas(arr, '2.id') // false
 */
export function easyHas<TData>(data: TData, path: NamePath): boolean {
  let pathList: string[] = path as string[]

  if (!Array.isArray(path)) {
    pathList = path.toString().split(/[.[\]]/)
  }

  // 过滤掉空字符串
  const filteredPath = pathList.filter((temp) => {
    return Boolean(temp.toString())
  })

  let currentValue: any = data

  // 逐级检查路径是否存在
  for (let i = 0; i < filteredPath.length; i++) {
    const key = filteredPath[i]

    // 检查当前级别的属性是否存在
    if (!hasObjProp(currentValue, key)) {
      return false
    }

    // 如果不是最后一级，继续往下一级
    if (i < filteredPath.length - 1) {
      currentValue = currentValue[key]
    }
  }

  return true
}
