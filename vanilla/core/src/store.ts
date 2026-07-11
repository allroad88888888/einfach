import { createContinuablePromise } from './promise'
import { isContinuablePromise, isPromiseLike } from './promiseUtils'
import { storeAtom } from './storeAtom'
import type { Atom, AtomState, ReadOptions, Setter, Store, WritableAtom } from './type'
import type { StatesWithPromise } from './typePromise'

let keyCount = 0

/**
 * readAtom 依赖拉取的原生递归预算。
 *
 * 嵌套深度 ≤ 预算时走与旧实现完全相同的递归路径——所有常规 atom 图
 * (包括全部 UI 场景)行为不变;超过预算的深依赖链(如 Excel 公式链
 * A2=A1+1 连拉十万行)切换到"缺失依赖故障-重试"帧循环:待算依赖记到
 * 堆上的显式栈里自底向上算,调用栈深度封顶,链长只受堆内存限制。
 *
 * 背景:纯递归实现(getter 内 readAtom 再入)在 Node 默认 ~1MB 调用栈
 * 下约 4000 深度抛 RangeError: Maximum call stack size exceeded;
 * 深链场景的重算传播(dependenciesChange 自递归)同样受限,已一并迭代化。
 *
 * 与旧实现声明过的行为差异(均为刻意改良,其余逐字 parity):
 * - 环(任意深度):抛显式 Error('circular dependency ...'),而非旧版的
 *   栈溢出 RangeError / 发散重算振荡 / 帧循环死循环。
 * - 超预算的 read 函数会先跑一轮"故障收集"(getter 对缺失依赖返回
 *   undefined 占位,本轮结果作废)再完整重跑——read 函数在超预算深链上
 *   至多执行 1 + 缺失依赖发现轮数次,副作用(含异步 read 的双重执行)
 *   由调用方自行幂等。
 * - options.getter 的函数身份不再全局稳定(旧版 === store.getter);
 *   每轮 read 运行内稳定。
 */
const READ_RECURSION_BUDGET = 256

type AnyAtom = Atom<unknown>

/**
 * 故障占位哨兵:readDep 对超预算且未算好的依赖返回它;getter 把它译为
 * undefined 交给 read 函数(维持批量收集:一轮可发现多条缺失依赖),
 * 同时把它写进依赖快照——它与任何用户值都不 Object.is 相等,保证故障轮
 * 的快照永远无法让重访的 isFresh 误判新鲜(哪怕依赖恰好算出 undefined)。
 */
const FAULT = Symbol('einfach.store.fault')

/**
 * 一次 read 函数运行的故障记账。依赖边本身仍由 getter 边读边写进
 * 活的全局表(与旧实现逐字一致)——这不仅是 parity:异步 read 函数
 * (async fn)会在同步返回 Promise 之后才调用 getter,只有活表写入
 * 才能接住这些迟到的依赖登记。一旦本轮故障(faulted),后续 getter
 * 调用不再写活表:本轮已注定作废,尤其是被丢弃的异步轮在提交轮之后
 * 迟到的 getter 调用,绝不能污染已提交的依赖表。
 */
interface Scratch {
  /** 本轮发现的缺失(尚未计算好)依赖,去重保序 */
  needed: AnyAtom[]
  neededSet: Set<AnyAtom>
  faulted: boolean
  /** 本轮由 getter 送达(重抛)的依赖错误——供帧循环判断错误是否需回存 */
  lastDepError?: { atom: AnyAtom; error: unknown }
}

interface ReadRunResult {
  value: unknown
  scratch: Scratch
  controller?: AbortController
  threw: boolean
  error?: unknown
  /** 提交完成后调用:isSync → false(旧实现的翻转时机 = setAtomState 之后) */
  settle: () => void
}

function createScratch(): Scratch {
  return { needed: [], neededSet: new Set(), faulted: false }
}

// 超预算缺失依赖的故障登记(去重保序),返回 FAULT 占位。
function recordFault(scratch: Scratch, atom: AnyAtom): typeof FAULT {
  if (!scratch.neededSet.has(atom)) {
    scratch.neededSet.add(atom)
    scratch.needed.push(atom)
  }
  scratch.faulted = true
  return FAULT
}

// 浅新鲜检查(旧 readAtom 头部逻辑原样提取):有缓存,且(无依赖表
// 条目 ⟹ 永久新鲜 | 每条依赖快照与当前值 Object.is 相等)。不递归。
// 故障轮写入的 FAULT 哨兵快照与任何状态都不相等 → 必判不新鲜。
function isFreshShallow(
  atomStateMap: WeakMap<AnyAtom, unknown>,
  dependenciesMap: WeakMap<AnyAtom, Map<AnyAtom, unknown>>,
  atomEntity: AnyAtom,
): boolean {
  if (!atomStateMap.has(atomEntity)) {
    return false
  }
  const depAtomEntityMap = dependenciesMap.get(atomEntity)
  if (!depAtomEntityMap) {
    return true
  }
  for (const [tempAntity, depValue] of depAtomEntityMap) {
    if (!Object.is(atomStateMap.get(tempAntity), depValue)) {
      return false
    }
  }
  return true
}

function pushReversed(stack: AnyAtom[], items: Iterable<AnyAtom>) {
  const arr = Array.from(items)
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    stack.push(arr[i])
  }
}

// getter 的活表边登记(反向边 + 依赖表条目确保),与旧实现逐字同序。
function registerEdge(
  backDependenciesMap: WeakMap<AnyAtom, Set<AnyAtom>>,
  dependenciesMap: WeakMap<AnyAtom, Map<AnyAtom, unknown>>,
  dep: AnyAtom,
  consumer: AnyAtom,
) {
  if (!backDependenciesMap.has(dep)) {
    backDependenciesMap.set(dep, new Set())
  }
  backDependenciesMap.get(dep)!.add(consumer)
  if (!dependenciesMap.has(consumer)) {
    dependenciesMap.set(consumer, new Map())
  }
}

// options 惰性访问器骨架(signal/setter/getter 三个 get 访问器的搭建)。
function buildReadOptions(handlers: {
  signal: () => AbortSignal
  setter: () => unknown
  getter: () => unknown
}): ReadOptions {
  return Object.defineProperties({} as ReadOptions, {
    signal: { get: () => handlers.signal() },
    setter: { get: () => handlers.setter() },
    getter: { get: () => handlers.getter() },
  })
}

// 变更传播:重读反向依赖者,值没变即剪枝整棵子树。旧实现为自递归
// (深链下同样爆栈),现为显式栈先序 DFS,访问顺序与嵌套 forEach 一致
// (子节点倒序压栈,LIFO 还原原序)。promise 不递归的旧行为保留。
// 已知偏差(P3,接受):子集合按压栈时刻快照;旧版 live Set.forEach
// 会访问遍历中新增的成员,快照不会——仅动态依赖在传播中扩张时可见。
function runDependenciesChange(
  backDependenciesMap: WeakMap<AnyAtom, Set<AnyAtom>>,
  atomStateMap: WeakMap<AnyAtom, unknown>,
  readAtomInternal: (atomEntity: AnyAtom) => unknown,
  atomEntity: AnyAtom,
) {
  const rootBack = backDependenciesMap.get(atomEntity)
  if (!rootBack) {
    return
  }
  const stack: AnyAtom[] = []
  pushReversed(stack, rootBack)
  while (stack.length > 0) {
    const depAtomEntity = stack.pop()!
    const currrnt = atomStateMap.get(depAtomEntity)
    const nextValue = readAtomInternal(depAtomEntity)
    if (Object.is(currrnt, nextValue)) {
      continue
    }
    // async atom (Promise) 不递归 — readAtom 已将其加入 pendingMap，
    // 由 flushPending while 循环处理。递归对 Promise 无意义：
    // 新旧 Promise 引用必不同，会导致 O(N²) 无效遍历。
    // promise resolve 后通过 complete 回调中的 dependenciesChange 传播。
    if (isPromiseLike(nextValue)) {
      continue
    }
    const children = backDependenciesMap.get(depAtomEntity)
    if (children) {
      pushReversed(stack, children)
    }
  }
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

  /** 当前原生嵌套深度(getter 递归拉取的层数) */
  let readDepth = 0

  /** read 函数正在运行中的 atom 集合(环检测,仅拦"不新鲜且在算") */
  const computing = new Set<AnyAtom>()

  /**
   * 帧循环里非根帧抛出的依赖错误。旧实现中依赖的异常从消费者的 getter
   * 调用处抛出(read 函数可 try/catch);超预算时依赖在帧循环里独立
   * 计算,错误记到这里,消费者重试轮的 getter 在 read 函数内部重抛——
   * 恢复可捕获性。送达即删;最外层帧循环退出时清残留。
   */
  const pendingDepErrors = new Map<AnyAtom, unknown>()
  let frameLoopDepth = 0

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

  function isFresh(atomEntity: AnyAtom): boolean {
    return isFreshShallow(atomStateMap, dependenciesMap, atomEntity)
  }

  // getter/peek 共用的依赖读取:新鲜/原始 atom 直接取;不新鲜的派生
  // atom 预算内递归计算(与旧实现同构),超预算登记缺失、返回 FAULT
  // 哨兵——本轮 read 结果必被丢弃,帧循环算好缺失依赖后重跑。
  // 检查顺序是语义:送达的依赖错误最先(该依赖此刻处于"冻结新鲜"态);
  // isFresh 先于 computing 守卫——重入读(peek(self)/options.getter/
  // 嵌套帧)命中"运行前已清依赖 ⇒ 无表项 ⇒ 新鲜"的旧怪癖,返回
  // 陈旧缓存,与旧实现一致;只有"不新鲜且正在计算"(真环)才拦截。
  function readDep(atom: AnyAtom, scratch: Scratch): unknown {
    if (pendingDepErrors.has(atom)) {
      const error = pendingDepErrors.get(atom)
      pendingDepErrors.delete(atom)
      scratch.lastDepError = { atom, error }
      throw error
    }
    if (isFresh(atom)) {
      return atomStateMap.get(atom)
    }
    if (typeof atom.read !== 'function') {
      // 原始 atom 首读:就地播种 init(旧 readAtom 对 primitive 的落底)
      return setAtomState(atom, atom.init)
    }
    if (computing.has(atom)) {
      throw new Error(`circular dependency detected: ${atom.toString()} is being computed`)
    }
    if (readDepth < READ_RECURSION_BUDGET) {
      readDepth += 1
      try {
        return readAtomInternal(atom)
      } finally {
        readDepth -= 1
      }
    }
    return recordFault(scratch, atom)
  }

  // 运行一次 read 函数。getter 自读短路、依赖边的活表写入(边读边记,
  // 异步 read fn 迟到调用 getter 时登记照常生效)、options 惰性访问器
  // 与旧实现一致;差异:依赖取值经 readDep(预算内递归/超预算故障),
  // 故障后的边写入被抑制(丢弃轮不得污染活表)。调用方负责每轮运行前
  // clearDependencies,并在提交后调用 settle()(旧 isSync 翻转时机)。
  function runReadFn(atomEntity: AnyAtom): ReadRunResult {
    const scratch = createScratch()

    let isSync = true
    let controller: AbortController | undefined

    // noWatch 全读(旧实现直接暴露 readAtom;身份在本轮内稳定)
    const noWatchGetter = (atom: AnyAtom) => {
      const raw = readDep(atom, scratch)
      return raw === FAULT ? undefined : raw
    }

    const options = buildReadOptions({
      signal: () => {
        controller = new AbortController()
        return controller.signal
      },
      setter: () => (isSync ? writeAtomState : setAtom),
      getter: () => noWatchGetter,
    })

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
      const live = !scratch.faulted
      if (live) {
        registerEdge(backDependenciesMap, dependenciesMap, atom, atomEntity)
      }
      const nextValue = readDep(atom, scratch)
      if (live) {
        // 故障依赖的快照即 FAULT 哨兵:重访 isFresh 必不新鲜(见 FAULT 注)
        dependenciesMap.get(atomEntity)!.set(atom, nextValue)
      }
      return (nextValue === FAULT ? undefined : nextValue) as State2
    }

    getter.peek = function peek<State2>(atom: Atom<State2>): StatesWithPromise<State2> | State2 {
      return noWatchGetter(atom) as State2
    }

    let value: unknown
    let threw = false
    let error: unknown
    computing.add(atomEntity)
    try {
      value = (atomEntity.read as (g: typeof getter, o: ReadOptions) => unknown)(getter, options)
    } catch (e) {
      threw = true
      error = e
    } finally {
      computing.delete(atomEntity)
    }
    return {
      value,
      scratch,
      controller,
      threw,
      error,
      settle: () => {
        isSync = false
      },
    }
  }

  // readAtom 计算主体,迭代帧循环(旧实现为递归):栈顶新鲜即弹出;
  // 不新鲜则清依赖、跑 read fn(旧 clearDependencies→read→setAtomState
  // →isSync 翻转的节奏)。故障 → 本轮值作废、缺失依赖压栈先算、同一
  // 调用内重跑本帧,中间态不被外部观察。环由"无进展检测"兜底:一个
  // atom 自上次运行以来若无任何进展(无提交/无新鲜化)又被重跑,即为
  // 互相等待的环——逐轮发现新依赖的合法模式(每轮至少提交一个)不误伤。
  // 非根帧的 read 异常记入 pendingDepErrors 由消费者 getter 重抛
  // (可捕获);根帧异常直接向调用方传播(旧行为)。
  function readAtomInternal(rootEntity: AnyAtom): unknown {
    if (isFresh(rootEntity)) {
      return atomStateMap.get(rootEntity)
    }
    if (typeof rootEntity.read !== 'function') {
      return setAtomState(rootEntity, rootEntity.init)
    }

    frameLoopDepth += 1
    try {
      const stack: AnyAtom[] = [rootEntity]
      let progressCount = 0
      const lastRunAt = new Map<AnyAtom, number>()
      while (stack.length > 0) {
        const atomEntity = stack[stack.length - 1]
        if (isFresh(atomEntity)) {
          stack.pop()
          progressCount += 1
          continue
        }
        if (typeof atomEntity.read !== 'function') {
          setAtomState(atomEntity, atomEntity.init)
          stack.pop()
          progressCount += 1
          continue
        }
        if (lastRunAt.get(atomEntity) === progressCount) {
          throw new Error(
            `circular dependency suspected: no progress since ${atomEntity.toString()} last ran`,
          )
        }
        lastRunAt.set(atomEntity, progressCount)

        clearDependencies(atomEntity)
        const result = runReadFn(atomEntity)
        if (result.scratch.faulted) {
          // 丢弃轮:返回值作废;挂起的 signal 中止;异步轮的 Promise 静默
          // 吞掉(僵尸续体的异常不得变成 unhandled rejection);getter 已
          // 送达却未被 read fn 消化的依赖错误回存,重试轮重新送达。
          result.controller?.abort?.()
          if (isPromiseLike(result.value)) Promise.resolve(result.value).catch(() => {})
          const delivered = result.scratch.lastDepError
          if (result.threw && delivered && Object.is(result.error, delivered.error)) {
            pendingDepErrors.set(delivered.atom, delivered.error)
          }
          pushReversed(stack, result.scratch.needed)
          continue
        }
        if (result.threw) {
          if (stack.length === 1) {
            throw result.error
          }
          // 错误也是终局进展:消费者重试轮会经 getter 收到这个错误
          pendingDepErrors.set(atomEntity, result.error)
          stack.pop()
          progressCount += 1
          continue
        }
        setAtomState(atomEntity, result.value, () => {
          return result.controller?.abort?.()
        })
        result.settle()
        stack.pop()
        progressCount += 1
      }
    } finally {
      frameLoopDepth -= 1
      if (frameLoopDepth === 0) {
        pendingDepErrors.clear()
      }
    }

    return atomStateMap.get(rootEntity)
  }

  function readAtom<State extends Promise<unknown>>(
    this: Atom<any>,
    atomEntity: Atom<Promise<State>>,
    force?: boolean,
  ): State extends Promise<infer P> ? StatesWithPromise<P> : never
  function readAtom<State>(this: Atom<any>, atomEntity: Atom<State>, force?: boolean): State
  function readAtom<State, Entity extends Atom<State>>(
    this: Atom<any>,
    atomEntity: Entity,
  ): StatesWithPromise<State> | State {
    return readAtomInternal(atomEntity as AnyAtom) as StatesWithPromise<State> | State
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

    return nextState
  }

  function flushPending() {
    while (pendingMap.size > 0) {
      const pending = Array.from(pendingMap)
      pendingMap.clear()
      for (const [atomEntity, prevState] of pending) {
        runDependenciesChange(backDependenciesMap, atomStateMap, readAtomInternal, atomEntity)
        const nextState = getAtomState(atomEntity)
        if (!Object.is(nextState, prevState)) {
          publishAtom(atomEntity)
        }
      }
    }
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
    readAtom.call(atomEntity, atomEntity)
    flushPending()
    if (!listenersMap.has(atomEntity)) {
      listenersMap.set(atomEntity, new Set())
    }
    listenersMap.get(atomEntity)?.add(listener)
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
    // 异步 setter 把 flushPending 推迟到 .finally；clear() 不清 pendingMap
    // 的话，旧世界的待刷新条目会在 clear 之后触发 getAtomState /
    // dependenciesChange，把已清除的 atom 重新物化进新的状态表。
    pendingMap.clear()
    pendingDepErrors.clear()
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
