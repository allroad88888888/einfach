import { useCallback } from 'react'
import type { AtomEntity, InterState } from '../core/type'
import type { HookOption } from './type'
import { useStore } from './useStore'
import type { Obj } from 'einfach-utils'
import { easySetIn } from 'einfach-utils'

export function useSetAtom(atom: AtomEntity, option: HookOption = {}) {
  const store = useStore(option)
  return useCallback(<T extends InterState = InterState>(namePath: string | T, value?: T) => {
    if (arguments.length === 1) {
      store.setter(atom, namePath)
      return
    }
    const info = store.getter(atom) as Obj
    const newInfo = easySetIn(info, namePath as string, value)
    store.setter(atom, newInfo)
  }, [atom, store])
}
