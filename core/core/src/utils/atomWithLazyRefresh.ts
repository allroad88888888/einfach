import type { Read, WritableAtom, Write } from '../type'
import { atom } from '../atom'
import { uninitialized } from './const'

export function atomWithLazyRefresh<State>(
  read: Read<State>,
): WritableAtom<State | undefined, [], void>

export function atomWithLazyRefresh<State, Args extends unknown[], Result>(
  read: Read<State>,
  write: Write<Args, Result>,
): WritableAtom<State | undefined, Args, Result>

export function atomWithLazyRefresh<State, Args extends unknown[], Result>(
  read: Read<State>,
  write?: Write<Args, Result>,
) {
  var refreshAtom = atom(0)

  return atom(
    function (getter, options) {
      const refreshCount = getter(refreshAtom)
      if (refreshCount > 0) {
        return read(options.getter, options)
      }
      return uninitialized
    },
    // @ts-ignore
    function (getter, setter, ...args: Args) {
      setter(refreshAtom, function (c) {
        return c + 1
      })
      if (write) {
        return (write as Write<Args, Result>).apply(void 0, [getter, setter, ...args])
      }
    },
  )
}
