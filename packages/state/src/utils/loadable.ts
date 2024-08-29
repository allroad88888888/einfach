import type { Atom, AtomEntity, AtomState } from '../core'
import { atom } from '../core'
import type { StatesWithPromise } from '../core/typePromise'
import { memo } from './memo'

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
export function loadable<State, Entity extends Atom<State>>(
  anAtom: Entity,
): AtomState<Entity> extends Promise<infer State1>
  ? AtomEntity<Res<State1>>
  : AtomEntity<Res<AtomState<Entity>>> {
  return memo(function () {
    var loadableCache = new WeakMap<StatesWithPromise<AtomState<Entity>>, Res<AtomState<Entity>>>()

    var refreshAtom = atom(0)

    const derivedAtom = atom<Res<AtomState<Entity>>, [], void>(
      function (getter, { setter }) {
        const refreshVal = getter(refreshAtom)
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
        const promise = value as StatesWithPromise<AtomState<Entity>>
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
              setter(refreshAtom, refreshVal + 1)
            })
        }
        var cached2 = loadableCache.get(promise)
        if (cached2) {
          return cached2
        }
        loadableCache.set(promise, LOADING)
        return LOADING
      },
      function (_get, setter) {
        setter(refreshAtom, function (c) {
          return c + 1
        })
      },
    )

    return atom(function (getter) {
      return getter(derivedAtom)
    })
  }, anAtom)
}
