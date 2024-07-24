import { useMemo, useRef, useState } from 'react';
import { createStore } from 'einfach-state';
import { useEasySetAtom } from 'einfach-utils';
import type { FormInstance, NamePath } from './type';
import { messageMappingAtom, fieldOptionMappingAtom, valuesAtom } from './state';
import type { Obj } from 'einfach-utils';
import { easyGet, easySetIn, useMethods } from 'einfach-utils';
import { buildEventRulesMapping, namePathToStr, validatorItem } from './validator';

export interface FormProps<T extends Obj> {
  initialValues?: any
  onValuesChange?: (changedValues: any, allValues: T) => void
}

export function useForm<Values extends Obj>(props: FormProps<Values>): FormInstance {
  const { initialValues, onValuesChange } = props;
  const [store] = useState(() => {
    return createStore();
  });
  const { getter, setter } = store;
  const setValues = useEasySetAtom(valuesAtom, { store });
  const { current } = useRef({
    init: false,
  });
  if (current.init === false) {
    if (initialValues) {
      setValues(initialValues);
    }
    current.init = true;
  }

  const setMessage = useEasySetAtom(messageMappingAtom, { store });

  const privateMethods = useMethods({
    onValuesChange: (changedValues: any, allValues: Values) => {
      if (onValuesChange) {
        onValuesChange(changedValues, allValues);
      }
    },
    getFieldValue<T>(name: NamePath) {
      const values = getter(valuesAtom);
      return easyGet(values, name) as T;
    },
    getFieldMessage(name: NamePath) {
      const messageMap = getter(messageMappingAtom);
      const nameStr = namePathToStr(name);
      return messageMap.get(nameStr as string);
    },
    async validateField(name: NamePath, eventName?: string) {
      const rulesMapping = getter(fieldOptionMappingAtom);
      const nameStr = namePathToStr(name);
      if (!rulesMapping.has(nameStr) || rulesMapping.get(nameStr)?.rules?.length === 0) {
        return true;
      }
      const { rules, label } = rulesMapping.get(nameStr)!;
      const tempMethods = buildEventRulesMapping(rules);
      if (eventName && !tempMethods.has(eventName)) {
        return true;
      }

      const val = privateMethods.getFieldValue(name);
      // const runKeys = Object.keys(tempMethods).filter((tempEventName) => {
      //   return eventName ? tempEventName === eventName : true
      // })
      const warnList: string[] = [];
      const errorList: string[] = [];
      for (const [key, tRules] of tempMethods) {
        if (eventName && key !== eventName) {
          break;
        }
        // const rules = tempMethods.get(key)!
        try {
          for (const rule of tRules) {
            const res = await validatorItem(val, { rule, label });
            if (typeof res === 'string') {
              warnList.push(res);
            }
          }
        } catch (error) {
          if (typeof error === 'string') {
            errorList.push(error as string);
          } else {
            throw error;
          }
        }
      }
      setMessage(name, {
        error: errorList.length === 0 ? undefined : errorList,
        warn: warnList.length === 0 ? undefined : warnList,
      });
      return errorList.length === 0;
    },
  });

  const methods = useMethods(
    {
      setFieldValue<T>(name: NamePath, value: T) {
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
      setFieldsValue(values: any) {
        setter(valuesAtom, values);
        privateMethods.onValuesChange(values, values);
      },
      getFieldValue: privateMethods.getFieldValue,
      getFieldsValue(nameList: true | NamePath[]) {
        const values = getter(valuesAtom);
        if (nameList === true) {
          return values;
        }
        return nameList.map((path) => {
          return easyGet(values, path);
        });
      },
      async validateFields() {
        const rulesMapping = getter(fieldOptionMappingAtom);
        for (const [namePath] of rulesMapping) {
          await privateMethods.validateField(namePath);
        }
        const messageMapping = getter(messageMappingAtom);
        let hasError = false;
        for (const [, message] of messageMapping) {
          if (hasError) {
            break;
          }
          if (message.error && message.error.length > 0) {
            hasError = true;
          }
        }

        return hasError;
      },
      validateField: privateMethods.validateField,
      getFieldMessage: privateMethods.getFieldMessage,

    },
  );

  return useMemo<FormInstance>(() => {
    return {
      _store: store,
      ...methods,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
