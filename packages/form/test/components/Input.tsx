export function Input({ value, onChange }: { value?: string, onChange?: (value: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => {
        if (onChange) {
          onChange(e.target.value)
        }
      }}
    />
  )
}
