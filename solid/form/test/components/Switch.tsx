/** @jsxImportSource solid-js */
import type { FormComponentProps } from './type'

export function Switch(props: FormComponentProps<boolean>) {
  return (
    <input
      type="checkbox"
      role="checkbox"
      checked={props.value || false}
      data-testid={props.dataTestid}
      onInput={(e) => {
        if (props.onChange) {
          props.onChange(e.currentTarget.checked)
        }
      }}
    />
  )
}
