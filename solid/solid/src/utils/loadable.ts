import { Atom, atom, AtomAsyncState, StatesWithPromise } from '@einfach/core'
import { useAtomValue } from '../useAtomValue'

export type LoadableStatus = 'loading' | 'hasData' | 'hasError'

export interface LoadableValue<T> {
  status: LoadableStatus
  loading: boolean
  data?: T
  error?: Error
}

function isPromise<T>(promise: any): promise is Promise<T> {
  return promise instanceof Promise
}

/**
 * 创建一个可处理异步数据的 loadable atom
 * @param asyncAtom 异步atom或异步函数
 * @returns loadable atom
 */
export function loadable<AtomType extends Atom<Promise<unknown>>>(asyncAtom: AtomType) {

  const refreshAtom = atom(0)
  refreshAtom.debugLabel = 'loadable refresh'

  let cache: LoadableValue<AtomAsyncState<AtomType>>
  const derivedAtom = atom((getter, options) => {

    getter(refreshAtom)
    const value = getter(asyncAtom)
    if (!isPromise(value)) {
      return {
        status: 'hasData',
        data: value,
        loading: false,
      } as LoadableValue<AtomAsyncState<AtomType>>
    }
    if (cache) {
      return cache
    }
    const promise = value as StatesWithPromise<AtomAsyncState<AtomType>>
    if (promise.status === 'fulfilled') {
      cache = {
        status: 'hasData',
        data: promise.value,
        loading: false,
      }
    } else if (promise.status === 'rejected') {
      cache = {
        status: 'hasError',
        error: promise.reason,
        loading: false,
      }
    } else {
      if (promise) {
        promise
          .then((data) => {
            cache = {
              status: 'hasData',
              data: data,
              loading: false,
            }
          })
          .catch((error) => {
            cache = {
              status: 'hasError',
              error: error,
              loading: false,
            }
          }).finally(() => {
            options.setter(refreshAtom, (prev) => {
              return prev + 1
            })
          })
      }
    }
    if (cache) {
      return cache
    }
    return {
      status: 'loading',
      loading: true,
    } as LoadableValue<AtomAsyncState<AtomType>>
  })

  return derivedAtom
}

/**
 * 使用 loadable atom 的 hook
 * @param loadableAtom loadable atom
 * @returns loadable 值
 */
export function useLoadable<T>(
  loadableAtom: Atom<LoadableValue<T>>
) {
  const rawValue = useAtomValue(loadableAtom)
  return rawValue as () => LoadableValue<T>
}
