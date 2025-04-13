import { useContext } from 'react'
import type { FormInstance } from './type'
import { FormContext } from './context'

export function useGetFormInstance(formInstance?: FormInstance): FormInstance {
  const instanceContext = useContext(FormContext)
  return formInstance || instanceContext
}
