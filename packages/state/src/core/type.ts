import type { StatesWithPromise } from './typePromise'

export interface Setter {
  <Value, Args extends unknown[], Result>(
    atomEntity: WritableAtom<Value, Args, Result>,
    ...args: Args
  ): Result
}

export interface Getter {
  <State>(entity: Atom<State>): State extends Promise<infer P> ? StatesWithPromise<P> : State
  <State>(entity: Atom<State>): State
}

export interface ReadOptions extends Omit<AbortController, 'abort'> {
  setter: Setter
}

export interface Read<State> {
  (getter: Getter, controller: ReadOptions): State
}

export interface Write<Args extends unknown[], Result> {
  (getter: Getter, setter: Setter, ...args: Args): Result
}

export interface Atom<State> {
  toString: () => string
  read: Read<State>
  debugLabel?: string
  init?: State
}

export interface WritableAtom<State, Args extends unknown[], Result> extends Atom<State> {
  write: Write<Args, Result>
}

export type AtomSetParameters<AtomType> =
  AtomType extends WritableAtom<unknown, infer Args, any> ? Args : never
export type AtomSetResult<AtomType> =
  AtomType extends WritableAtom<unknown, any, infer Result> ? Result : never

export type AtomState<AtomType> = AtomType extends Atom<infer Value> ? Value : never

export type AtomEntity<State> = WritableAtom<State, [State | ((prev: State) => State)], void>

export interface Store {
  sub: <Entity extends Atom<unknown>>(atomEntity: Entity, listener: () => void) => () => void
  getter: Getter
  setter: Setter
  toString: () => string
  debugLabel?: string
  clear: () => void
  // resetAtom: <AtomType extends Atom<unknown>>(oldAtomEntity?: AtomType) => void
}
