import { useCallback } from 'react'
import type { AtomEntity, InterState } from '../core/type'
import type { HookOption } from './type'
import { useStore } from './useStore'
import type { NamePath, Obj } from 'einfach-utils'
import { easySetIn } from 'einfach-utils'

export interface SetAtomMethod<Value> {
  (namePath: NamePath, value: any): void
  (value: Value extends (...args: any[]) => any ? never : Value): void
  (value: (value: Value) => Value): void
}

export function useSetAtom<Value extends InterState = InterState>(
  atom: AtomEntity<Value>,
  option: HookOption = {},
) {
  const store = useStore(option)

  function setAtomMethod(namePath: NamePath, value: any): void
  function setAtomMethod(value: Value extends (...args: any[]) => any ? never : Value): void
  function setAtomMethod(fn: (value: Value) => Value): void
  function setAtomMethod(
    ...arg:
      | [NamePath, any]
      | [Value extends (...args: any[]) => any ? never : Value]
      | [(value: Value) => Value]
  ) {
    if (arg.length === 1) {
      if (typeof arg[0] === 'function') {
        store.setter(atom, (arg[0] as (value: Value) => Value)(store.getter(atom)))
      }
      else {
        store.setter(atom, arg[0])
      }

      return
    }
    const info = store.getter(atom)
    const newInfo = easySetIn(info as Obj, arg[0], arg[1]) as Value
    store.setter(atom, newInfo)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback<SetAtomMethod<Value>>(setAtomMethod, [atom, store])!
}
