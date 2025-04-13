import { atom } from '@einfach/core'
import type { Getter, Read, Setter } from '@einfach/core'

export function incrementAtom<T>(initState: T | Read<T>) {
  type ReadFn = (getter: Getter, prev: T) => T

  function isReadFn(p: any): p is ReadFn {
    return typeof p === 'function'
  }

  const readSetAtom = atom(new Set<ReadFn>())
  const selfAtom = atom(initState)

  function back(getter: Getter, setter: Setter, read: ReadFn | T) {
    if (isReadFn(read)) {
      setter(readSetAtom, (prev) => {
        const next = new Set(prev)
        next.add(read)
        return next
      })
      return () => {
        setter(readSetAtom, (prev) => {
          const next = new Set(prev)
          next.delete(read)
          return next
        })
      }
    }
    setter(selfAtom, read)
    return undefined
  }

  const backAtom = atom((getter) => {
    const readList = Array.from(getter(readSetAtom))
    let prev = getter(selfAtom) as T
    readList.forEach((read) => {
      prev = read(getter, prev)
    })
    return prev
  }, back)

  return backAtom
}
