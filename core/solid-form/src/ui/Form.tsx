/** @jsxImportSource solid-js */

import { FormContext } from '../core/context'
import type { JSX } from 'solid-js'
import type { FormInstance } from '../core/type'

interface FormProps {
  children: JSX.Element
  formInstance: FormInstance
}

export function Form(props: FormProps) {
  return <FormContext.Provider value={props.formInstance}>{props.children}</FormContext.Provider>
}
