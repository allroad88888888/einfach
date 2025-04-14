import type { Read, WritableAtom, Write } from '../type'
import { atom } from '../atom'

export function atomWithRefresh<State>(read: Read<State>): WritableAtom<State, [], void>

export function atomWithRefresh<State, Args extends unknown[], Result>(
  read: Read<State>,
  write: Write<Args, Result>,
): WritableAtom<State, Args, Result>

export function atomWithRefresh<State, Args extends unknown[], Result>(
  read: Read<State>,
  write?: Write<Args, Result>,
) {
  var refreshAtom = atom(0)

  return atom(
    function (getter, options) {
      getter(refreshAtom)
      return read(getter, options)
    },
    // @ts-ignore
    function (getter, setter, ...args: Args) {
      if (arguments.length < 3) {
        setter(refreshAtom, function (c) {
          return c + 1
        })
      } else if (write) {
        return (write as Write<Args, Result>).apply(void 0, [getter, setter, ...args])
      }
    },
  )
}
