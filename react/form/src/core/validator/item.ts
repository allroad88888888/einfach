import type { Store } from '@einfach/core'
import type { Rule } from '../type'
import { getLength } from './getLength'
import { isEmpty } from './isEmpty'

export function templateConvert<T extends Record<string, any>>(str: string, params: T) {
  const fnStr = `return (\`${str}\`)`
  const fn = new Function(...Object.keys(params), fnStr)
  return fn(...Object.values(params))
}

export function validatorItem(
  paramValue: any,
  {
    label = '',
    rule,
    values,
    store,
  }: {
    label?: string
    rule: Rule
    /**
     * 有些表单使用配置项配置 need it
     */
    values: any
    store: Store
  },
) {
  const {
    required = false,
    transform,
    pattern,
    enum: enumArray,
    warningOnly = false,
    validator,
  } = rule

  function formatMessage(message: string) {
    const params = {
      label,
      ...rule,
    }
    const tempMessage = templateConvert(rule.message || message, params)

    if (warningOnly === true) {
      return Promise.resolve(tempMessage)
    }
    return Promise.reject(tempMessage)
  }
  let value = paramValue
  if (transform) {
    value = transform(value)
  }

  if (required && isEmpty(value)) {
    return formatMessage('${label}请输入')
  }

  if (pattern) {
    if (isEmpty(value) || !pattern.test(value)) {
      return formatMessage('${label}不匹配${pattern}')
    }
  }

  if (validator) {
    return validator(rule, value, {
      values,
      store,
    })
  }

  if ('len' in rule) {
    const length = getLength(value)
    if (length !== rule.len) {
      return formatMessage('${label}须为${len}个字符')
    }
  }

  if ('min' in rule) {
    let compare: number = value
    if (typeof value !== 'number') {
      compare = getLength(value)
    }
    if (compare < rule.min!) {
      return formatMessage('${label}小于${min}')
    }
  }

  if ('max' in rule) {
    let compare: number = value
    if (typeof value !== 'number') {
      compare = getLength(value)
    }
    if (compare > rule.max!) {
      return formatMessage('${label}大于${max}')
    }
  }
  if (enumArray && !enumArray.includes(value)) {
    return formatMessage(`${label}不在[${enumArray.join(',')}]的范围内`)
  }

  return Promise.resolve()
}
