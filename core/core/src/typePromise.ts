export type PromiseStatus = 'pending' | 'fulfilled' | 'rejected'

export interface StatesWithPromise<T> extends Promise<T> {
  // ()=>
  value?: T
  status?: PromiseStatus
  reason?: any
  CONTINUE_PROMISE?: ContinuablePromise<T>
}

export interface ContinuablePromise<T> {
  (nextPromise: Promise<T>, nextAbort: () => void): void
}

// export type ReturnState<State> = State extends Promise<any>
//   ? StatesWithPromise<State> : State;
