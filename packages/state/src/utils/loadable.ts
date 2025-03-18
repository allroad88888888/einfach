import type { Atom, AtomSetParameters, AtomSetResult, AtomState, WritableAtom } from '../core'
import { atom } from '../core'
import type { StatesWithPromise } from '../core/typePromise'
import { memo } from './memo'

function isPromise<T>(promise: any): promise is Promise<T> {
  return promise instanceof Promise
}

// export type Res<Value> =
//   | {
//       state: 'init'
//     }
//   | {
//       state: 'loading'
//     }
//   | {
//       state: 'hasError'
//       error: unknown
//     }
//   | {
//       state: 'hasData'
//       data: Awaited<Value>
//     }

interface Res<Value> {
  state: 'loading' | 'hasData' | 'hasError' | 'init'
  data?: Value
  error?: any
}

const LOADING = {
  state: 'loading',
} as Res<any>

const Init = {
  state: 'init',
} as Res<any>

interface Options {
  /**
   * @default true
   */
  autoRun?: boolean
}

// AtomState<Entity> extends Promise<infer State1>
//   ? WritableAtom<Res<State1>, [], void>
//   : WritableAtom<Res<AtomState<Entity>>, [], void>

/**
 * from jotai
 * @param anAtom
 * @returns
 */
export function loadable<AtomType extends Atom<unknown>>(
  anAtom: AtomType,
  { autoRun = true }: Options = {},
): WritableAtom<
  Res<AtomState<AtomType> extends Promise<infer State1> ? State1 : AtomState<AtomType>>,
  AtomSetParameters<AtomType> | [],
  AtomSetResult<AtomType>
> {
  return memo(function () {
    var loadableCache = new WeakMap<
      StatesWithPromise<AtomState<AtomType>>,
      Res<AtomState<AtomType>>
    >()

    var refreshAtom = atom(0)
    refreshAtom.debugLabel = 'loadable refresh'

    const derivedAtom = atom<Res<AtomState<AtomType>>>(function (getter, options) {
      const refreshVal = getter(refreshAtom)

      if (refreshVal === 0 && autoRun === false) {
        return Init
      }

      let value
      try {
        value = getter(anAtom)
      } catch (error) {
        return {
          state: 'hasError',
          error: error,
        }
      }

      if (!isPromise(value)) {
        return {
          state: 'hasData',
          data: value,
        }
      }
      const promise = value as StatesWithPromise<AtomState<AtomType>>
      var cached1 = loadableCache.get(promise)
      if (cached1) {
        return cached1
      }

      if (promise.status === 'fulfilled') {
        loadableCache.set(promise, {
          state: 'hasData',
          data: promise.value,
        })
      } else if (promise.status === 'rejected') {
        loadableCache.set(promise, {
          state: 'hasError',
          error: promise.reason,
        })
      } else {
        promise
          .then(
            function (data) {
              loadableCache.set(promise, {
                state: 'hasData',
                data: data,
              })
            },
            function (error) {
              loadableCache.set(promise, {
                state: 'hasError',
                error: error,
              })
            },
          )
          .finally(() => {
            options.setter(refreshAtom, refreshVal + 1)
            // options.setter(derivedAtom, undefined as any)
          })
      }
      var cached2 = loadableCache.get(promise)
      if (cached2) {
        return cached2
      }
      loadableCache.set(promise, LOADING)
      return LOADING
    })

    derivedAtom.debugLabel = 'loadable derivedAtom'

    const loadableWritableAtom =
      atom<Res<AtomState<AtomType>>, AtomSetParameters<AtomType>, AtomSetResult<AtomType>>(
        function (getter) {
          return getter(derivedAtom)
        },
        // @ts-ignore
        function (_get, setter, ...args: AtomSetParameters<AtomType> | []) {
          setter(refreshAtom, function (c) {
            return c + 1
          })
          if (isWriteAtom(anAtom)) {
            return setter(anAtom, ...args)
          }
        },
      )
    loadableWritableAtom.debugLabel = 'loadableWritableAtom'
    return loadableWritableAtom
  }, anAtom)
}

export function isWriteAtom<State, Args extends unknown[], Result>(
  entity: any,
): entity is WritableAtom<State, Args, Result> {
  return 'write' in entity
}
