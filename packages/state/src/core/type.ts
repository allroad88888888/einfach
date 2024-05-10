export interface Setter {
  <State extends InterState = InterState>(entity: AtomEntity<State>, value: State): void
}

export interface Getter {
  <State extends InterState = InterState>(entity: AtomEntity<State>): State
}

export interface Read<State extends InterState = InterState> {
  (getter: Getter): State
}
export interface Write {
  (getter: Getter, setter: Setter, ...arg: any[]): void
}

export interface AtomEntity<State extends InterState = InterState> {
  init?: State
  read: Read<State>
  write: Write
  toString: () => string
  debugLabel?: string
}

export interface Store {
  sub: <State extends InterState = InterState>(atomEntity: AtomEntity<State>,
    listener: () => void) => () => void
  getter: <State extends InterState = InterState>(atomEntity: AtomEntity<State>) => State
  setter: <State extends InterState = InterState>(atomEntity: AtomEntity<State>, state: State) => void
  toString: () => string
}

export type InterState = unknown
