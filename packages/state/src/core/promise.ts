import { CONTINUE_PROMISE_TAG } from './promiseUtils'
import type { ContinuablePromise, StatesWithPromise } from './typePromise'

const PENDING = 'pending'
const FULFILLED = 'fulfilled'
const REJECTED = 'rejected'

// const CONTINUE_PROMISE = Symbol('CONTINUE_PROMISE')

const continuablePromiseMap = new WeakMap()
export function createContinuablePromise<T>(
  promise: Promise<T>,
  paramAbort: () => void,
  complete: () => void,
) {
  if (!continuablePromiseMap.has(promise)) {
    let continuePromise: ContinuablePromise<T> | undefined

    let abort = paramAbort

    const entityPromise: StatesWithPromise<T> = new Promise<T>(function (resolve, reject) {
      let curr = promise
      const onFulfilled = function onFulfilled(me: Promise<T>) {
        return function (v: T) {
          if (curr === me) {
            entityPromise.status = FULFILLED
            entityPromise.value = v
            resolve(v)
            complete()
          }
        }
      }
      const onRejected = function onRejected(me: Promise<T>) {
        return function (e: any) {
          if (curr === me) {
            entityPromise.status = REJECTED
            entityPromise.reason = e
            reject(e)
            complete()
          }
        }
      }
      promise.then(onFulfilled(promise), onRejected(promise))
      continuePromise = function (nextPromise: Promise<T>, nextAbort: () => void) {
        if (nextPromise) {
          continuablePromiseMap.set(nextPromise, entityPromise)
          curr = nextPromise
          nextPromise.then(onFulfilled(nextPromise), onRejected(nextPromise))
          abort()
          abort = nextAbort
        }
      }
    })
    entityPromise.status = PENDING
    entityPromise.CONTINUE_PROMISE = continuePromise
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    entityPromise[CONTINUE_PROMISE_TAG] = CONTINUE_PROMISE_TAG
    continuablePromiseMap.set(promise, entityPromise)
  }
  return continuablePromiseMap.get(promise) as StatesWithPromise<T>
}
