import type { ComponentProps, ReactElement } from 'react'
import type React from 'react'
import { isValidElement, memo, useCallback } from 'react'
import { useField, type NamePath, type Rule } from '../core'
import { useValidator } from '../core/useValidator'

export type FormItemProps<T extends React.ElementType> = {
  label?: string
  noStyle?: boolean
  style?: React.CSSProperties
  className?: string
  children: ReactElement<ComponentProps<T>>
  name: NamePath
  rules?: Rule[]
  dataTestid?: string
}

export function FormItemFc<T extends React.ElementType>(props: FormItemProps<T>) {
  const { noStyle = false, children, name, rules, dataTestid, label } = props
  const { value, onChange } = useField(name)

  const { message, methods } = useValidator(name, { rules, label })

  const handChange = useCallback((val: any) => {
    onChange(val)
    methods?.onChange?.()
    children.props.onChange?.(val)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!isValidElement(children)) {
    return null
  }

  const Item = children.type
  const $children = <Item {...children.props} value={value} {...methods} onChange={handChange} />

  if (noStyle) {
    return $children
  }

  return (
    <div data-testid={dataTestid}>
      {label ? <label>{label}</label> : null}
      {$children}
      {message?.error ? (
        <div data-testid={dataTestid ? `${dataTestid}-error` : undefined}>
          {message.error.join('-')}
        </div>
      ) : null}
      {message?.warn ? (
        <div data-testid={dataTestid ? `${dataTestid}-warn` : undefined}>
          {message.warn.join('-')}
        </div>
      ) : null}
    </div>
  )
}

export const FormItem = memo(FormItemFc)
