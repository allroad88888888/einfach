import type { Store } from '@einfach/core'
import type { createFormDataHelpContext } from './context'

export type NamePath = string | number | (string | number)[]

export type Message = {
  warn?: string[] | undefined
  error?: string[] | undefined
}

export type FieldData = {
  /**
   * 错误信息
   * @deprecated
   */
  errors?: string[]
  /**
   * 警告信息
   * @deprecated
   */
  warnings?: string[]
  name: NamePath[]
  value: any
  /**
   * 是否正在校验
   * @deprecated
   */
  validating?: boolean
  /**
   * 是否被用户操作过
   * @deprecated
   */
  touched?: boolean
}

export type FieldInfo = {
  label?: string
  rules?: Rule[]
}

export interface FormInstance extends FormDataHelpType {
  setFieldValue: <Value>(name: NamePath, value: Value) => void
  /**
   * 重置所有值
   * @param values 
   * @returns 
   */
  resetValues: (values: any) => void
  getFieldValue: <Value>(name: NamePath) => Value | undefined
  getFieldsValue: (nameList: true | NamePath[]) => any
  getFieldMessage: (name: NamePath) => Message | undefined
  validateFields: () => Promise<boolean>
  validateField: (namePath: NamePath, eventName?: string) => Promise<boolean>
}

export type Rule = {
  enum?: any[]
  /**
   * input type string input number
   */
  len?: number
  /**
   * 最大
   */
  max?: number
  /**
   * 最小
   */
  min?: number
  /**
   * 正则表达式
   */
  pattern?: RegExp
  /**
   * 是否必填
   * @default false
   */
  required?: boolean
  /**
   * 数据转换 再校验
   * @returns
   */
  transform?: (value: any) => any
  /**
   * 触发事件
   */
  validateTrigger?: string | string[]
  /**
   * 自定义校验方法
   * @param rule
   * @returns
   */
  validator?: (
    rule: Rule,
    value: any,
    param: {
      values: any
      store: Store
    },
  ) => Promise<any>
  /**
   * 仅警告，不阻塞表单提交
   * @default false
   */
  warningOnly?: boolean
  message?: string
}

export type FormDataHelpType = ReturnType<typeof createFormDataHelpContext>

export type CreateDataHelpAtoms = typeof createFormDataHelpContext
