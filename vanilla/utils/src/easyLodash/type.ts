export type NamePath = string | number | (string | number)[]

export type ObjectType =
  | '[object Null]'
  | '[object Array]'
  | '[object Object]'
  | '[object Set]'
  | '[object Map]'
  | '[object WeakSet]'
  | '[object WeakMap]'
  | '[object Function]'
