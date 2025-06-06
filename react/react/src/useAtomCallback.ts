import { atom, Getter, Setter } from '@einfach/core'
import { useMemo } from 'react'
import { HookOption } from './type'
import { useSetAtom } from './useSetAtom'

export function useAtomCallback<T extends (...args: any[]) => any>(
  callback: (get: Getter, set: Setter, ...args: Parameters<T>) => ReturnType<T>,
  watchParams: any[],
  options: HookOption = {},
): T {
  const tempAtom = useMemo(() => {
    return atom(0, function (getter, setter, ...args: Parameters<T>) {
      return callback.apply(void 0, [getter, setter, ...args])
    })
  }, watchParams)
  return useSetAtom(tempAtom, options) as T
}
