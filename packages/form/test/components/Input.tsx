// import type { FormComponentProps } from './type'

interface InputProps
  extends React.DetailedHTMLProps<React.InputHTMLAttributes<HTMLInputElement>, HTMLInputElement> {
  dataTestid?: string
  onChange?: (value: any) => void
}

export function Input({ value, onChange, dataTestid, type = 'text', ...props }: InputProps) {
  return (
    <input
      {...props}
      type={type}
      value={value || ''}
      data-testid={dataTestid}
      onChange={(e) => {
        if (onChange) {
          onChange(e.target.value)
        }
      }}
    />
  )
}
