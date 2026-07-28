import type { Atom, AtomEntity, Getter, Read, Setter, WritableAtom } from './type'

let keyCount = 0

type Value<State> = State | ((prev: State) => State)

/**
 * 合成 write 的标记。
 *
 * `atom(initialValue)` 没有自带 write 时,本文件会合成一个「写入即替换
 * (支持 updater 函数)」的 write 并打上这个标记;用户显式传入的 write 会
 * 覆盖合成结果,标记随之消失。
 *
 * 存在的理由:在此之前 `atom(0)`(源子)与 `atom(null, fn)`(命令 atom)
 * 在运行时结构完全相同——两者的 `read` 都不是函数、都有 `write`——凡是
 * 需要「这个 atom 是不是可以直接写回一个旧值」的场景(撤销/重做、持久化
 * 回放)都无法区分二者。有了标记,`isSourceAtom` 就能把命令 atom 与派生
 * atom 一并挡在外面。
 */
export const SYNTHESIZED_WRITE = Symbol('einfach.atom.synthesizedWrite')

/**
 * 是否为「源子 atom」——即 `atom(initialValue)` 造出、写入语义就是替换值的
 * atom。只有这类 atom 可以安全地被写回一个历史旧值。
 *
 * 排除的三类:
 * - 只读派生 `atom(get => …)`:没有 write,`store.setter` 会直接 TypeError
 * - 可写派生 `atom(get => …, w)`:真相在上游依赖,写回是双记
 * - 命令 atom `atom(null, w)`:write 是动作而非赋值,写回会触发副作用
 */
export function isSourceAtom<State>(atomEntity: Atom<State>): atomEntity is AtomEntity<State> {
  if (typeof atomEntity.read === 'function') {
    return false
  }
  const { write } = atomEntity as Partial<WritableAtom<State, unknown[], unknown>>
  return (
    typeof write === 'function' &&
    (write as unknown as Record<symbol, unknown>)[SYNTHESIZED_WRITE] === true
  )
}

export function atom<State>(read: Read<State>): AtomEntity<State>
export function atom<State>(read: State): AtomEntity<State>
export function atom<State, Args extends unknown[], Result>(
  read: Read<State> | State,
  write: (getter: Getter, setter: Setter, ...args: Args) => Result,
): WritableAtom<State, Args, Result>

export function atom<State, Args extends unknown[], Result>(
  read: Read<State> | State,
  write?: (getter: Getter, setter: Setter, ...args: Args) => Result,
): WritableAtom<State, Args, Result> {
  const key = `atom${++keyCount}`
  const entity = {
    toString: function () {
      return entity.debugLabel || key
    },
  } as WritableAtom<State, Args, Result>
  if (typeof read === 'function') {
    entity.read = read as Read<State>
  } else {
    entity.init = read as State
    entity.write = function (getter: Getter, setter: Setter, arg: Value<State>) {
      return setter(
        entity as unknown as WritableAtom<State, [Value<State>], Result>,
        typeof arg === 'function' ? (arg as (prev: State) => State)(getter(entity) as State) : arg,
      )
    } as unknown as (getter: Getter, setter: Setter, ...args: Args) => Result
    // 不可枚举:标记只服务于 isSourceAtom 的运行时判定,不该出现在遍历里
    Object.defineProperty(entity.write, SYNTHESIZED_WRITE, { value: true })
  }
  if (write) {
    entity.write = write
  }
  entity.debugLabel = key

  return entity
}
