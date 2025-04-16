/** @jsxImportSource solid-js */
import { JSX, Show, children as solidChildren, splitProps } from 'solid-js'
import { useValidator } from '../core/useValidator'
import type { NamePath, Rule, FormInstance } from '../core/type'
import { useField } from '../core'
import { useFormContext } from '../core/context'

export interface FormItemProps<T extends unknown = unknown>
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, 'children'> {
  label?: string
  noStyle?: boolean

  children: (params: { value: T; onChange: (val: T) => void }) => JSX.Element
  name: NamePath
  rules?: Rule[]
  dataTestid?: string
  formInstance?: FormInstance
}

export function FormItem<T>(props: FormItemProps<T>) {
  const [local, rest] = splitProps(props, [
    'children',
    'name',
    'rules',
    'label',
    'noStyle',
    'dataTestid',
    'formInstance',
  ])

  const contextFormInstance = useFormContext()

  const finalFormInstance = local.formInstance || contextFormInstance

  const { value, onChange } = useField<T>(local.name, { formInstance: finalFormInstance })

  const { message, methods } = useValidator(local.name, {
    rules: local.rules,
    label: local.label,
    formInstance: finalFormInstance,
  })

  const handChange = (val: any) => {
    onChange(val)
    methods?.onChange?.()
  }

  // 解析子组件
  const resolvedChildren = solidChildren(() => {
    if (typeof local.children === 'function') {
      return local.children({ value: value() as T, onChange: handChange })
    }
    return local.children
  })

  // 如果是无样式模式，直接返回子组件
  if (local.noStyle) {
    return resolvedChildren()
  }

  // 带样式的表单项
  return (
    <div data-testid={local.dataTestid} {...rest}>
      <Show when={local.label}>
        <label>{local.label}</label>
      </Show>
      {resolvedChildren()}
      <Show when={message()?.error}>
        <div data-testid={local.dataTestid ? `${local.dataTestid}-error` : undefined}>
          {message()?.error?.join('-')}
        </div>
      </Show>

      <Show when={message()?.warn}>
        <div data-testid={local.dataTestid ? `${local.dataTestid}-warn` : undefined}>
          {message()?.warn?.join('-')}
        </div>
      </Show>
    </div>
  )
}
