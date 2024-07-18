import { useCallback } from 'react'
import type { AtomEntity } from '../core/type'
import type { HookOption } from './type'
import { useStore } from './useStore'
import type { NamePath, Obj } from 'einfach-utils'
import { easySetIn } from 'einfach-utils'
import type { ReturnState } from '../core/typePromise'

export interface SetAtomMethod<Value> {
  (namePath: NamePath, value: any): void
  (value: Value extends (...args: any[]) => any ? never : Value): void
  (value: (value: ReturnState<Value>) => Value): void
}

export function useSetAtom<Value>(
  atom: AtomEntity<Value>,
  option: HookOption = {},
) {
  const store = useStore(option)

  function setAtomMethod(namePath: NamePath, value: any): void
  function setAtomMethod(value: Value extends (...args: any[]) => any ? never : Value): void
  function setAtomMethod(fn: (value: ReturnState<Value>) => Value): void
  function setAtomMethod(
    ...arg:
      | [NamePath, any]
      | [Value extends (...args: any[]) => any ? never : Value]
      | [(value: ReturnState<Value>) => Value]
  ) {
    if (arg.length === 1) {
      if (typeof arg[0] === 'function') {
        store.setter(atom, (arg[0] as (value: ReturnState<Value>) => Value)(store.getter(atom)))
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
