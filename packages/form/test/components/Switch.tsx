import type { FormComponentProps } from './type'

export function Switch({ value = false, onChange, dataTestid }: FormComponentProps<boolean>) {
  return (
    <input
      type="checkbox"
      role="checkbox"
      checked={value || false}
      data-testid={dataTestid}
      onChange={(e) => {
        if (onChange) {
          onChange(e.target.checked)
        }
      }}
    />
  )
}
