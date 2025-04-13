import type { StatesWithPromise } from '../core/typePromise'

export function use<T>(promise: StatesWithPromise<T>) {
  if (promise.status === 'pending') {
    throw promise
  } else if (promise.status === 'fulfilled') {
    return promise.value
  } else if (promise.status === 'rejected') {
    throw promise.reason
  } else {
    promise.status = 'pending'
    promise.then(
      function (v) {
        promise.status = 'fulfilled'
        promise.value = v
      },
      function (e) {
        promise.status = 'rejected'
        promise.reason = e
      },
    )
    throw promise
  }
}
