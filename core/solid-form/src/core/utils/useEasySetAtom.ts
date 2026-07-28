
import { easySetIn, type NamePath } from '@einfach/utils'
import type { AtomEntity } from '@einfach/core'
import type { HookOption } from '@einfach/solid'
import { useStore } from '@einfach/solid'

export interface SetAtomMethod<Value, Slice> {
  (namePath: NamePath, value: Slice): void
  (value: AtomEntity<Value> extends (...args: any[]) => any ? never : Value): void
  (value: (value: Value) => Value): void
}

// AtomState
export function useEasySetAtom<Value, Slice>(atom: AtomEntity<Value>, option: HookOption = {}) {
  const store = useStore(option)

  function setAtomMethod(namePath: NamePath, value: Slice): void
  function setAtomMethod(value: Value extends (...args: any[]) => any ? never : Value): void
  function setAtomMethod(fn: (value: Value) => Value): void
  function setAtomMethod(
    ...arg:
      | [NamePath, Slice]
      | [Value extends (...args: any[]) => any ? never : Value]
      | [(value: Value) => Value]
  ) {
    if (arg.length === 1) {
      if (typeof arg[0] === 'function') {
        store.setter(atom, (arg[0] as (value: Value) => Value)(store.getter(atom) as Value))
      } else {
        store.setter(atom, arg[0])
      }

      return
    }
    const info = store.getter(atom)
    const newInfo = easySetIn(info as any, arg[0], arg[1]) as Value
    store.setter(atom, newInfo)
  }

  return setAtomMethod
}
