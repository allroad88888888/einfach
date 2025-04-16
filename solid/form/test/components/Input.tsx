/** @jsxImportSource solid-js */
import { JSX, splitProps } from 'solid-js'

interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  dataTestid?: string
  onChange?: (value: any) => void
  value?: string
}

export function Input(props: InputProps) {
  const [lcoal, rest] = splitProps(props, ['value', 'onChange', 'dataTestid', 'type'])
  return (
    <input
      {...rest}
      type={lcoal.type}
      value={lcoal.value || ''}
      data-testid={lcoal.dataTestid}
      onInput={(e) => {
        if (lcoal.onChange) {
          lcoal.onChange(e.currentTarget.value)
        }
      }}
    />
  )
}
