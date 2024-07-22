import { useAtomValue } from 'einfach-state';
import { useGetFormInstance } from './useGetFormInstance';
import { valuesAtom } from './state';
import type { FormInstance } from './type';

export function useFormValues(formInstance: FormInstance) {
  const { _store: store } = useGetFormInstance(formInstance);
  const values = useAtomValue(valuesAtom, { store });
  return values;
}
