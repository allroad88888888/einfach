import type { ReturnState } from './typePromise';

export interface Setter {
  <State, Args extends unknown[], Result>
    (atomEntity: WritableAtom<State, Args, Result>, ...args: Args): Result
}

export interface Getter {
  <State>(entity: WritableAtom<State>): ReturnState<State>
}

export interface Read<State> {
  (getter: Getter, controller: AbortController): State
}

export interface Write<Args extends unknown[], Result> {
  (getter: Getter, setter: Setter, ...args: Args): Result
}

export type AtomAbstract<State = any, Args extends unknown[] = any[], Result = any> =
  WritableAtom<State, Args, Result>;

export interface AtomBasic<State> {
  read: Read<State> | State
  toString: () => string
  debugLabel?: string
}



export type AtomEntity<State> = WritableAtom<State,
  [State | ((prev: ReturnState<State>) => State)], void>;


export interface WritableAtom<State,
  Args extends unknown[] = [State], Result = void> extends AtomBasic<State> {
  write: Write<Args, Result>
}

export type WritableItem<State> = State extends Function ?
  ((prev: ReturnState<State>) => State) : State;


export interface Store {
  sub: <State >(atomEntity: AtomEntity<State>,
    listener: () => void) => () => void
  getter: Getter
  setter: Setter
  toString: () => string
  debugLabel?: string
  resetAtom: <State >(oldAtomEntity?: AtomEntity<State>) => void
}


