export function isPromiseLike(promise: any) {
  return typeof (promise == null ? void 0 : promise.then) === 'function'
}

export const CONTINUE_PROMISE_TAG = Symbol('CONTINUE_PROMISE_TAG')

export function isContinuablePromise(promise: any) {
  return typeof promise === 'object' && promise !== null && CONTINUE_PROMISE_TAG in promise
}
