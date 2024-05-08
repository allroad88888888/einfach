import { useRef, useState } from 'react';
import { Getter, Setter, createStore, useAtomMethods, useSetAtom } from 'einfach-state';
import type { FormInstance, NamePath } from './type';
import { valuesAtom } from './state';
import { Obj, easyGet, easySetIn, useMethods } from 'einfach-utils';

export interface FormProps<T extends Obj> {
  initialValues?: any;
  onValuesChange?: (changedValues: any, allValues: T) => void;
}

export function useForm<Values extends Obj>(props: FormProps<Values>): FormInstance {
  const { initialValues, onValuesChange } = props;
  const [store] = useState(() => {
    return createStore();
  });

  const setValues = useSetAtom(valuesAtom, { store });
  const { current } = useRef({
    init: false,
  });
  if (current.init === false) {
    if (initialValues) {
      setValues(initialValues);
    }
    current.init = true;
  }

  const privateMethods = useMethods({
    onValuesChange: (changedValues: any, allValues: Values) => {
      if (onValuesChange) {
        onValuesChange(changedValues, allValues);
      }
    },
  });

  const methods = useAtomMethods(
    {
      setFieldValue<T extends unknown>(getter: Getter, setter: Setter, name: NamePath, value: T) {
        const values = getter(valuesAtom) as Values;
        const res = easySetIn(values, name, value);
        setter(valuesAtom, res);
        privateMethods.onValuesChange(
          {
            name,
            value,
          },
          res,
        );
      },
      setFieldsValue(getter, setter, values: any) {
        setter(valuesAtom, values);
        privateMethods.onValuesChange(values, values);
      },
      getFieldValue<T extends unknown = unknown>(getter: Getter, setter: Setter, name: NamePath) {
        // const values = getter(valuesAtom);
        return easyGet({}, name) as T
      },
      getFieldsValue(getter, setter, nameList: true | NamePath[]) {
        const values = getter(valuesAtom);
        if (nameList === true) {
          return values;
        }
        return nameList.map((path) => {
          return easyGet(values, path);
        });
      },
    },
    { store },
  );

  return {
    store,
    ...methods,
  } as FormInstance
}
