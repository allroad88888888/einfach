import type { Atom, AtomEntity, AtomState } from './../type'
import { atom } from './../atom'
import { isPromiseLike } from './../promiseUtils'

// 工具类型：解包 Promise
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T

// 条件类型：根据输入类型推断返回类型
type SelectAtomResult<T, Slice> = T extends Promise<any> ? Atom<Promise<Slice>> : Atom<Slice>

export function selectAtom<Slice, AtomType extends Atom<unknown>>(
  atomEntity: AtomType,
  selectFn: (current: UnwrapPromise<AtomState<AtomType>>, prev?: Slice) => Slice,
  equalityFn?: (prev: Slice, next: Slice) => boolean,
): SelectAtomResult<AtomState<AtomType>, Slice>
export function selectAtom<Slice, State, AtomType extends Atom<unknown> = AtomEntity<State>>(
  atomEntity: AtomType,
  selectFn: (current: UnwrapPromise<State>, prev?: Slice) => Slice,
  equalityFn?: (prev: Slice, next: Slice) => boolean,
): SelectAtomResult<State, Slice>
export function selectAtom<Slice, State>(
  atomEntity: AtomEntity<State>,
  selectFn: (current: UnwrapPromise<State>, prev?: Slice) => Slice,
  equalityFn: (prev: Slice, next: Slice) => boolean = Object.is,
) {
  const Empty = Symbol('empty')

  // 辅助函数：处理相等性比较
  const compareAndReturn = (prev: Slice | symbol, result: Slice): Slice => {
    if (prev !== Empty && equalityFn(prev as Slice, result)) {
      return prev as Slice
    }
    return result
  }

  const derivedAtom = atom<Slice | Promise<Slice> | symbol>((getter) => {
    const info = getter(atomEntity) as State
    const prev = getter(derivedAtom) as Slice | symbol

    // 先判断 info 是否是 Promise
    if (isPromiseLike(info)) {
      // 异步流程
      return info.then((resolvedInfo) => {
        const result = selectFn(
          resolvedInfo as UnwrapPromise<State>,
          prev === Empty ? undefined : (prev as Slice),
        )
        return compareAndReturn(prev, result)
      })
    }

    // 同步流程
    const result = selectFn(
      info as UnwrapPromise<State>,
      prev === Empty ? undefined : (prev as Slice),
    )
    return compareAndReturn(prev, result)
  })
  derivedAtom.init = Empty as Slice | Promise<Slice>

  return derivedAtom as SelectAtomResult<State, Slice>
}
