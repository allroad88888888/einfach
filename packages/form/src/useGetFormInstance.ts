import { useContext } from 'react';
import type { FormInstance } from './type';
import { FormContext } from './content';

export function useGetFormInstance(formInstance?: FormInstance): FormInstance {
  const instanceContext = useContext(FormContext);
  return formInstance || instanceContext;
}
