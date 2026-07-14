import { createContinuablePromise } from './promise'
import { isContinuablePromise, isPromiseLike } from './promiseUtils'
import { storeAtom } from './storeAtom'
import type { Atom, AtomState, ReadOptions, Setter, Store, WritableAtom } from './type'
import type { StatesWithPromise } from './typePromise'

let keyCount = 0

/**
 * 同步递归求值的最大深度。
 * 依赖链在此深度内走递归快路径（求值语义与旧实现一致，read 不会重跑）；
 * 超过后 getter 抛 SuspendDependency，由最近的 evaluateAtom 显式栈接管，
 * 保证任意深度的依赖链不会爆调用栈。
 */
const MAX_SYNC_EVALUATION_DEPTH = 250

/**
 * 单次 evaluateAtom 的迭代上限。正常图远达不到（10000 层链约 2 万步），
 * 仅用于兜底 read 每次重跑都动态创建新 atom 之类的病态场景，
 * 避免"挂起→求值新依赖→重跑"永不收敛
 */
const MAX_EVALUATION_STEPS = 1_000_000

/**
 * 内部控制流信号：当前 read 依赖了一个未就绪的 atom，且递归深度已达上限。
 * evaluateAtom 捕获后先求值该依赖，再重跑当前 read。不是错误。
 */
class SuspendDependency {
  dependency: Atom<unknown>

  constructor(dependency: Atom<unknown>) {
    this.dependency = dependency
  }
}

/**
 * 一轮 evaluateAtom 内某个 atom read 抛出的错误。
 * version 记录当时的 store 写入版本：之后若发生过写入，错误可能已失效，
 * 需重新求值而不是继续抛缓存的旧错误
 */
interface ErrorRecord {
  error: unknown
  version: number
}

/**
 * 一轮 evaluateAtom 的共享上下文。errorMap 懒创建（多数求值不会出错）
 */
interface EvaluationContext {
  errorMap: Map<Atom<unknown>, ErrorRecord> | null
}

/**
 * 取 WeakMap 中的集合，不存在则初始化
 */
function ensure<K extends object, V>(map: WeakMap<K, V>, key: K, create: () => V): V {
  let value = map.get(key)
  if (value === undefined) {
    value = create()
    map.set(key, value)
  }
  return value
}

export function createStore(): Store {
  let atomStateMap = new WeakMap<Atom<unknown>, unknown>()

  let listenersMap = new WeakMap<Atom<unknown>, Set<() => void>>()
  /**
   * 谁依赖你-我自己更新值了-要通知谁
   */
  let backDependenciesMap = new WeakMap<Atom<unknown>, Set<Atom<unknown>>>()

  /**
   * for clean backDependencies
   * 我依赖谁 +值， getter值时候，对比值是否相等
   */
  let dependenciesMap = new WeakMap<Atom<unknown>, Map<Atom<unknown>, unknown>>()

  const pendingMap = new Map<Atom<unknown>, unknown>()

  /**
   * 当前嵌套的 evaluateAtom 层数，决定走递归快路径还是挂起到显式栈
   */
  let evaluationDepth = 0

  /**
   * store 写入版本号，每次 atom 状态实际变更时 +1，用于判断 ErrorRecord 是否过期
   */
  let writeVersion = 0

  function clearDependencies<AtomType extends Atom<unknown>>(atomEntity: AtomType) {
    const dependencies = dependenciesMap.get(atomEntity)
    Array.from(dependencies?.keys() ?? []).forEach((depAtomEntity) => {
      backDependenciesMap.get(depAtomEntity)?.delete(atomEntity)
    })
    dependenciesMap.delete(atomEntity)
  }

  function getAtomState<AtomType extends Atom<unknown>>(atomEntity: AtomType) {
    return atomStateMap.get(atomEntity) as AtomState<AtomType>
  }

  /**
   * 有缓存值，且记录的每个依赖值与其当前值一致 → 无需重算
   */
  function isFreshAtom(atomEntity: Atom<unknown>): boolean {
    if (!atomStateMap.has(atomEntity)) {
      return false
    }
    const depAtomEntityMap = dependenciesMap.get(atomEntity)
    if (!depAtomEntityMap) {
      return true
    }
    for (const [depAtomEntity, depValue] of depAtomEntityMap) {
      if (!Object.is(getAtomState(depAtomEntity), depValue)) {
        return false
      }
    }
    return true
  }

  function readAtom<State extends Promise<unknown>>(
    atomEntity: Atom<Promise<State>>,
  ): State extends Promise<infer P> ? StatesWithPromise<P> : never
  function readAtom<State>(atomEntity: Atom<State>): State
  function readAtom<State>(atomEntity: Atom<State>): StatesWithPromise<State> | State {
    if (isFreshAtom(atomEntity)) {
      return getAtomState(atomEntity) as State
    }
    return evaluateAtom(atomEntity)
  }

  /**
   * 求值入口：显式栈迭代，代替无界递归。
   * 栈顶 atom 计算时若挂起（依赖未就绪且递归深度到顶），把依赖压栈先算，
   * 算完重跑栈顶，直到栈清空。栈深即依赖链深，不占用调用栈。
   */
  function evaluateAtom<State>(rootEntity: Atom<State>): StatesWithPromise<State> | State {
    const stack: Atom<unknown>[] = [rootEntity]
    const inStack = new Set<Atom<unknown>>(stack)
    const context: EvaluationContext = { errorMap: null }
    let steps = 0

    evaluationDepth += 1
    try {
      while (stack.length > 0) {
        if (++steps > MAX_EVALUATION_STEPS) {
          throw new Error(
            'Atom evaluation did not converge; a read function may create new atoms on every run',
          )
        }
        const top = stack[stack.length - 1]
        try {
          computeAtomState(top, context)
          stack.pop()
          inStack.delete(top)
        } catch (error) {
          if (!(error instanceof SuspendDependency)) {
            if (top === rootEntity) {
              throw error
            }
            if (!context.errorMap) {
              context.errorMap = new Map()
            }
            context.errorMap.set(top, { error, version: writeVersion })
            stack.pop()
            inStack.delete(top)
            continue
          }
          if (inStack.has(error.dependency)) {
            throw new Error('Circular dependency detected in atom graph')
          }
          stack.push(error.dependency)
          inStack.add(error.dependency)
        }
      }
    } finally {
      evaluationDepth -= 1
    }
    return getAtomState(rootEntity) as StatesWithPromise<State> | State
  }

  /**
   * 执行一次 atom 的 read 并把结果写入 store（不含缓存命中判断）
   */
  function computeAtomState<State>(
    atomEntity: Atom<State>,
    context: EvaluationContext,
  ): StatesWithPromise<State> | State {
    /**
     * 无 read 函数的原始 atom：直接写入初始值。不执行用户代码，无递归风险
     */
    if (typeof atomEntity.read !== 'function') {
      return setAtomState(atomEntity, atomEntity.init as State)
    }

    let isSync = true
    let controller: AbortController | undefined
    /**
     * 本次执行中挂起过的依赖。即使用户 read 用 try/catch 吞掉挂起信号、或
     * async read 把它变成 rejected Promise，read 结束后也能凭此标记交还挂起并丢弃本次结果
     */
    let suspendedDependency: Atom<unknown> | undefined

    /**
     * 取依赖的当前值（不登记依赖关系）：
     * 新鲜 → 缓存；原始 atom → 内联写入初始值；
     * 派生 atom 未就绪 → 浅层递归求值，深层挂起交给显式栈
     */
    function resolveDependency<State2>(atom: Atom<State2>): StatesWithPromise<State2> | State2 {
      const record = context.errorMap?.get(atom)
      if (record) {
        if (record.version === writeVersion) {
          throw record.error
        }
        context.errorMap!.delete(atom)
      }
      if (isFreshAtom(atom)) {
        return getAtomState(atom) as State2
      }
      if (typeof atom.read !== 'function') {
        return computeAtomState(atom, context)
      }
      if (evaluationDepth < MAX_SYNC_EVALUATION_DEPTH) {
        return evaluateAtom(atom)
      }
      suspendedDependency = atom
      throw new SuspendDependency(atom)
    }

    function getter<State2>(
      atom: Atom<State2>,
    ): State2 extends Promise<infer P> ? StatesWithPromise<P> : never
    function getter<State2>(atom: Atom<State2>): State2
    function getter<State2>(atom: Atom<State2>): StatesWithPromise<State2> | State2 {
      if (Object.is(atom, atomEntity)) {
        if (!atomStateMap.has(atom)) {
          return atom.init! as State2
        }
        return atomStateMap.get(atom)! as State2
      }
      ensure(backDependenciesMap, atom, () => new Set()).add(atomEntity)
      const depAtomEntityMap = ensure(dependenciesMap, atomEntity, () => new Map())
      const nextValue = resolveDependency(atom) as State2
      depAtomEntityMap.set(atom, nextValue)
      return nextValue
    }

    getter.peek = function peek<State2>(atom: Atom<State2>): StatesWithPromise<State2> | State2 {
      return resolveDependency(atom) as State2
    }

    const options = Object.defineProperties({} as ReadOptions, {
      signal: {
        get() {
          controller = new AbortController()
          return controller.signal
        },
      },
      setter: {
        get() {
          if (!isSync) {
            return setAtom
          }
          return writeAtomState
        },
      },
      getter: {
        get() {
          // read 同步执行期间走挂起感知的解析器（不登记依赖，等价旧行为）；
          // read 结束后异步调用时没有 evaluateAtom 上下文，退回 readAtom
          if (!isSync) {
            return readAtom
          }
          return resolveDependency
        },
      },
    })

    clearDependencies(atomEntity)

    let nextState: State
    try {
      nextState = atomEntity.read(getter, options)
    } catch (error) {
      if (suspendedDependency !== undefined) {
        controller?.abort?.()
        throw new SuspendDependency(suspendedDependency)
      }
      throw error
    }

    if (suspendedDependency !== undefined) {
      if (isPromiseLike(nextState)) {
        // async read 把挂起信号变成了 rejected Promise：结果作废重跑，消费掉 rejection
        Promise.resolve(nextState).catch(() => {})
      }
      controller?.abort?.()
      throw new SuspendDependency(suspendedDependency)
    }

    const next = setAtomState(atomEntity, nextState, () => {
      return controller?.abort?.()
    })
    isSync = false
    return next
  }

  function setAtom<State, Args extends unknown[], Result>(
    atomEntity: WritableAtom<State, Args, Result>,
    ...args: Args
  ): Result {
    /**
     * 当一个状态 派生另外一个状态时，
     * 设置当前态，订阅又去更新其它状态，会触发这里，导致pendingMap 丢失内容
     */
    // pendingMap.clear()
    const next = writeAtomState(atomEntity, ...args)
    if (isPromiseLike(next)) {
      Promise.resolve(next).finally(() => {
        flushPending()
      })
    } else {
      flushPending()
    }

    return next
  }

  function writeAtomState<State, Args extends unknown[], Result>(
    atomEntity: WritableAtom<State, Args, Result>,
    ...args: Args
  ) {
    let isSync = true
    function setter<NextState, NextArgs extends unknown[], NextResult>(
      nextSetAtomEntity: WritableAtom<NextState, NextArgs, NextResult>,
      ...nextArgs: NextArgs
    ) {
      if (atomEntity === (nextSetAtomEntity as unknown as WritableAtom<State, Args, Result>)) {
        clearDependencies(nextSetAtomEntity)
        setAtomState(nextSetAtomEntity, nextArgs[0])
        return undefined as Result
      }
      const next = writeAtomState(nextSetAtomEntity, ...nextArgs)
      // 应用场景  incrementAtom return 一个setter
      if (!isSync) {
        flushPending()
      }
      return next
    }
    const result = atomEntity.write(readAtom, setter as Setter, ...args)
    isSync = false
    return result
  }

  function setAtomState<State extends Promise<any>>(
    atomEntity: Atom<State>,
    state: State,
    abortPromise?: () => void,
  ): State extends Promise<infer P> ? StatesWithPromise<P> : never
  function setAtomState<State>(
    atomEntity: Atom<State>,
    state: State,
    abortPromise?: () => void,
  ): State | StatesWithPromise<State>
  function setAtomState<State>(
    atomEntity: Atom<State>,
    state: State,
    abortPromise: () => void = () => {},
  ): State | StatesWithPromise<State> {
    if (process.env.NODE_ENV !== 'production') {
      if (!isPromiseLike(state)) {
        Object.freeze(state)
      }
    }
    let nextState: StatesWithPromise<State> | State = state

    const prevState = atomStateMap.get(atomEntity) as StatesWithPromise<State> | State

    if (isPromiseLike(nextState)) {
      nextState = createContinuablePromise(nextState, abortPromise, () => {
        pendingMap.delete(atomEntity)
        publishAtom(atomEntity)
      })
      if (isContinuablePromise(prevState)) {
        prevState.CONTINUE_PROMISE?.(nextState as StatesWithPromise<State>, abortPromise)
      }
    }

    if (atomStateMap.has(atomEntity) && Object.is(prevState, nextState)) {
      return prevState
    }

    atomStateMap.set(atomEntity, nextState)
    pendingMap.set(atomEntity, prevState)
    writeVersion += 1

    return nextState
  }

  /**
   * 通知直接下游重算。这里不递归：重算产生的变更会写入 pendingMap，
   * 由 flushPending 的 while 循环逐层推进，任意深度的依赖链都不会爆栈
   */
  function dependenciesChange<Entity extends Atom<unknown>>(atomEntity: Entity) {
    backDependenciesMap.get(atomEntity)?.forEach((depAtomEntity) => {
      readAtom(depAtomEntity)
    })
  }

  function flushPending() {
    /**
     * 先把整张依赖图推进到收敛，再统一通知。
     * 若边推进边通知，listener 里读下游 atom 会拿到旧值：
     * isFreshAtom 只看直接依赖，中间层还没更新时会把下游误判为新鲜
     */
    const changedMap = new Map<Atom<unknown>, unknown>()
    while (pendingMap.size > 0) {
      const pending = Array.from(pendingMap)
      pendingMap.clear()
      pending.forEach(([atomEntity, prevState]) => {
        if (!changedMap.has(atomEntity)) {
          changedMap.set(atomEntity, prevState)
        }
        dependenciesChange(atomEntity)
      })
    }
    changedMap.forEach((prevState, atomEntity) => {
      if (!Object.is(getAtomState(atomEntity), prevState)) {
        publishAtom(atomEntity)
      }
    })
  }

  function publishAtom<Entity extends Atom<unknown>>(atomEntity: Entity) {
    const listenerSet = listenersMap.get(atomEntity)
    if (listenerSet) {
      listenerSet.forEach((listener) => {
        listener()
      })
    }
  }

  function subscribeAtom<Entity extends Atom<unknown>>(atomEntity: Entity, listener: () => void) {
    readAtom(atomEntity)
    flushPending()
    ensure(listenersMap, atomEntity, () => new Set<() => void>()).add(listener)
    return () => {
      listenersMap.get(atomEntity)?.delete(listener)
    }
  }
  const key = `store${++keyCount}`

  function clear() {
    atomStateMap = new WeakMap()
    listenersMap = new WeakMap()
    backDependenciesMap = new WeakMap()
    dependenciesMap = new WeakMap()
  }

  const store = {
    sub: subscribeAtom,
    getter: readAtom,
    setter: setAtom as Setter,
    toString: () => key,
    clear,
  }

  store.setter(storeAtom, store)

  return store
}
