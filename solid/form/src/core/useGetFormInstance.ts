import type { FormInstance } from './type'
import { useFormContext } from './context'

export function useGetFormInstance(formInstance?: FormInstance): FormInstance {
  const instanceContext = useFormContext()

  if (!formInstance && !instanceContext) {
    throw new Error('FormInstance not found in context. Please use Form component or provide formInstance.')
  }
  return formInstance || instanceContext!
}
