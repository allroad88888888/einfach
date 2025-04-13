import { useCallback, useRef } from 'react'
import { type Getter, type WritableAtom } from '../core'
import { useSetAtom } from '../react'

export function useIncrementAtom<T, T1 = T | ((getter: Getter, prev: T) => T)>(
  entity: WritableAtom<T, [read: T1], (() => void) | undefined>,
) {
  const cancelRef = useRef<() => void>()

  const setIncrementAtom = useSetAtom(entity)

  const cleanStateFn = useCallback(() => {
    if (cancelRef.current) {
      cancelRef.current()
    }
  }, [])

  const incrementStateFn = useCallback(
    (fn: T1) => {
      cleanStateFn()
      const cancel = setIncrementAtom(fn)
      if (cancel) {
        cancelRef.current = cancel
      }
      return cancel
    },
    [cleanStateFn, setIncrementAtom],
  )

  return [incrementStateFn, cleanStateFn] as [(fn: T1) => (() => void) | undefined, () => void]
}
