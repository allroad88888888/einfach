export function Switch({ value, onChange }:
{ value?: boolean, onChange?: (value: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={value}
      onChange={(e) => {
        if (onChange) {
          onChange(e.target.checked)
        }
      }}
    />
  )
}
