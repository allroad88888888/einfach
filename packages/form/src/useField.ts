import type { FormInstance, NamePath } from './type';
import { useFieldValue } from './useFieldValue';
import { useSetField } from './useSetField';

export type UseFieldOption = {
  formInstance?: FormInstance;
};

export function useField<T extends unknown>(
  name: NamePath,
  { formInstance }: UseFieldOption = {},
): {
  value: T;
  onChange: (param: T) => void;
} {
  const value = useFieldValue<T>(name, { formInstance });
  const setField = useSetField<T>(name, { formInstance });

  return {
    value,
    onChange: setField,
  };
}
