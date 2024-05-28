import type { ReactNode } from 'react'
import type React from 'react'
import { cloneElement, isValidElement, memo, useCallback } from 'react'
import { useField, type NamePath, type Rule } from '../core'
import { useInit } from 'einfach-utils'
import { useValidator } from '../core/useValidator'

export type FormItemProps = {
  label?: string
  noStyle?: boolean
  style?: React.CSSProperties
  className?: string
  children: ReactNode
  name: NamePath
  rules?: Rule[]
  dataTestid?: string
}

export function FormItemFc(props: FormItemProps) {
  const { noStyle = false, children, name, rules, dataTestid, label } = props
  const { value, onChange } = useField(name)

  const { message, methods } = useValidator(name, { rules, label })

  const handChange = useCallback((val: any) => {
    onChange(val)
    methods?.onChange?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const $children = useInit(() => {
    if (!isValidElement(children)) {
      return null
    }
    return cloneElement(children, {
      ...children.props,
      value,
      ...methods,
      onChange: handChange,
    })
  }, [])

  if (noStyle) {
    return $children
  }

  return (
    <div data-testid={dataTestid}>
      {label ? <label>{label}</label> : null}
      {$children}
      {message?.error ? <div data-testid={dataTestid ? `${dataTestid}-error` : undefined}>{message.error.join('-')}</div> : null}
      {message?.warn ? <div data-testid={dataTestid ? `${dataTestid}-warn` : undefined}>{message.warn.join('-')}</div> : null}
    </div>
  )
}

export const FormItem = memo(FormItemFc)
