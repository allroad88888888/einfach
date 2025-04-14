export type FormComponentProps<T> = {
  value?: T
  onChange?: (value: T) => void
  dataTestid?: string
}
