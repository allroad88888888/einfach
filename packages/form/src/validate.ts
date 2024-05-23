import type { Rule } from './type'

function isEmpty(value: any): boolean {
  if (value === undefined || value === '' || value === null) {
    return true
  }
  if (Array.isArray(value) && value.length === 0) {
    return true
  }
  if (Object.prototype.toString.call(value) === '[object Object]') {
    return isEmpty(Object.keys(value))
  }
  return false
}

function getLength(value: any): number {
  if (typeof value === 'string') {
    return value.length
  }
  if (typeof value === 'number') {
    return value.toString().length
  }
  if (typeof value === 'object') {
    const type = Object.prototype.toString.call(value)
    if (type === '[object Set]') {
      return (value as Set<any>).size
    }
    if (type === '[object Map]') {
      return (value as Map<any, any>).size
    }
    if (type === '[object Array]') {
      return (value as any[]).length
    }
  }
  return 0
}

export function validator(paramValue: any, rule: Rule) {
  const { required = false, transform, pattern, enum: enumArray,
    warningOnly = false, validator } = rule

  function formatMessage(message: string) {
    if (warningOnly === true) {
      return Promise.resolve(message)
    }
    return Promise.reject(message)
  }
  let value = paramValue
  if (transform) {
    value = transform(value)
  }

  if (required && !isEmpty(value)) {
    return formatMessage(`必填`)
  }

  if (pattern && !pattern.test(value)) {
    return formatMessage(`校验错误`)
  }

  if (validator) {
    return validator(rule, value)
  }

  if ('len' in rule) {
    const length = getLength(value)
    if (length !== rule.len) {
      return formatMessage(`长度不匹配`)
    }
  }

  if ('min' in rule) {
    let compare: number = value
    if (typeof value !== 'number') {
      compare = getLength(value)
    }
    if (compare < rule.min!) {
      return formatMessage(`小于${rule.min}`)
    }
  }

  if ('max' in rule) {
    let compare: number = value
    if (typeof value !== 'number') {
      compare = getLength(value)
    }
    if (compare > rule.max!) {
      return formatMessage(`大于${rule.min}`)
    }
  }
  if (enumArray && !enumArray.includes(value)) {
    return formatMessage(`不在枚举的范围内`)
  }

  return Promise.resolve()
}
