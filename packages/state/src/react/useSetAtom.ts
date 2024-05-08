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
      store.set(atom, namePath)
      return
    }
    const info = store.get(atom) as Obj
    const newInfo = easySetIn(info, namePath as string, value)
    store.set(atom, newInfo)
  }, [atom, store])
}
