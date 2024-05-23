import React from 'react'
import { FormContext } from './content'
import type { FormInstance } from './type'

export function Form({
  children,
  formInstance,
}: {
  children: React.ReactNode
  formInstance: FormInstance
}) {
  return <FormContext.Provider value={formInstance}>{children}</FormContext.Provider>
}
