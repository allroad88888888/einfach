export interface Setter {
  <State extends InterState = InterState>(entity: AtomEntity<State>, value: State): void
}

export interface Getter {
  <State extends InterState = InterState>(entity: AtomEntity<State>): State
}

export interface Read<State extends InterState = InterState > {
  // (get: <T>(entity: AtomEntity<T>) => T): State
  (get: Getter): State
}
export interface Write {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (get: Getter, set: Setter, ...arg: any[]): void
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
  get: <State extends InterState = InterState>(atomEntity: AtomEntity<State>) => State
  set: <State extends InterState = InterState>(atomEntity: AtomEntity<State>, state: State) => void
  toString: () => string
}

// export type InterState = string | number | boolean |
//   null | { [key in string]: InterState } | InterState[] | undefined

// type AnyJson = boolean | number | string | null | JsonArray | JsonMap | undefined
// interface JsonMap { [key: string]: AnyJson }
// interface JsonArray extends Array<AnyJson> {}

export type InterState = unknown
