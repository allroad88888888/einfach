import type { Atom, AtomSetParameters, AtomSetResult, AtomState, WritableAtom } from '@einfach/core'
import { atom, memo } from '@einfach/core'
import type { StatesWithPromise } from '@einfach/core'

function isPromise<T>(promise: any): promise is Promise<T> {
  return promise instanceof Promise
}

interface Res<Value> {
  state: 'loading' | 'hasData' | 'hasError'
  data?: Value
  error?: any
}

const LOADING = {
  state: 'loading',
} as Res<any>

/**
 * from jotai
 * @param anAtom
 * @returns
 */
export function loadable<AtomType extends Atom<unknown>>(
  anAtom: AtomType,
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
      getter(refreshAtom)

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
            options.setter(refreshAtom, (prev) => {
              return prev + 1
            })
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

    const loadableWritableAtom = atom<
      Res<AtomState<AtomType>>,
      AtomSetParameters<AtomType>,
      AtomSetResult<AtomType>
    >(
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
