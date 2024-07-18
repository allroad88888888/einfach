import type { ReturnState } from './typePromise'

export interface Setter {
  <State >(entity: AtomEntity<State>, value: State): void
}

export interface Getter {
  <State >(entity: AtomEntity<State>): ReturnState<State>
}

export interface Read<State > {
  (getter: Getter, controller: AbortController): State
}
export interface Write {
  (getter: Getter, setter: Setter, ...arg: any[]): void
}

export interface AtomEntity<State > {
  // _init?: State
  read: Read<State> | State
  write: Write
  toString: () => string
  debugLabel?: string
}

export interface Store {
  sub: <State >(atomEntity: AtomEntity<State>,
    listener: (state: ReturnState<State>) => void) => () => void
  getter: <State >(atomEntity: AtomEntity<State>) => ReturnState<State>
  setter: <State >
  (atomEntity: AtomEntity<State>, state: State | ((prev: ReturnState<State>) => State)) => void
  toString: () => string
  debugLabel?: string
  resetAtom: <State >(oldAtomEntity?: AtomEntity<State>) => void
}

export type InterState = unknown
