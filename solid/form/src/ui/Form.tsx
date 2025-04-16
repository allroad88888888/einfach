/** @jsxImportSource solid-js */

import { FormContext } from '../core/context'
import { JSX } from 'solid-js'
import { FormInstance } from '../core/type'

interface FormProps {
  children: JSX.Element
  formInstance: FormInstance
}

export function Form(props: FormProps) {
  return <FormContext.Provider value={props.formInstance}>{props.children}</FormContext.Provider>
}
