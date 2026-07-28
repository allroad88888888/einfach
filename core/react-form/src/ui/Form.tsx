import type { FormInstance } from '../core'
import { FormContext } from '../core'

export function Form({
  children,
  formInstance,
}: {
  children: React.ReactNode
  formInstance: FormInstance
}) {
  return <FormContext.Provider value={formInstance}>{children}</FormContext.Provider>
}
