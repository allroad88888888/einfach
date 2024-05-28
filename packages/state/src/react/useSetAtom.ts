import { useCallback } from 'react'
import type { AtomEntity, InterState } from '../core/type'
import type { HookOption } from './type'
import { useStore } from './useStore'
import type { NamePath, Obj } from 'einfach-utils'
import { easySetIn } from 'einfach-utils'

export function useSetAtom<T extends InterState = InterState>(
  atom: AtomEntity<T>, option: HookOption = {}) {
  const store = useStore(option)
  return useCallback((...arg: [NamePath, any ] | [T]) => {
    if (arg.length === 1) {
      store.setter(atom, arg[0])
      return
    }
    const info = store.getter(atom)
    const newInfo = easySetIn(info as Obj, arg[0], arg[1]) as T
    store.setter(atom, newInfo)
  }, [atom, store])
}
