import { atom, isSourceAtom } from '../atom'
import type { Atom, AtomEntity, Getter, Setter, Store } from '../type'

/**
 * 事务日志式的撤销/重做。
 *
 * 与快照式实现的根本区别:历史里存的不是「atom 对象 → 全量值」,而是
 * 「字符串 key → before/after」的事务日志。每条 entry 自带完整的逆操作,
 * 由此得到三件快照式做不到的事:
 *
 * - **可截断**:丢掉最老的条目不影响剩余条目回滚(快照式必须回溯扫描
 *   前序历史才能找到某个 atom 的上一个值,截断即永久丢失)。于是能加 cap。
 * - **可序列化**:key 是字符串而不是对象引用,整个栈可 JSON / structuredClone,
 *   可以落 IndexedDB。
 * - **代价与状态规模脱钩**:一次 undo 是 O(本条 ops 数),不是 O(历史长度);
 *   内存是 cap × 仅改动量,不是 无上限 × 全量值。
 *
 * 本模块不订阅任何 atom,也不自动推断改了什么——变更由调用方在
 * `transaction()` 内用 `record()` 显式声明。原因:自动捕获需要给每个被追踪
 * 的 atom 常驻订阅与基线值,成本 O(被追踪 atom 数),在 family(每行/每格
 * 一个 atom)场景下不成立。
 */

export type HistoryDirection = 'undo' | 'redo'

export interface HistoryOp {
  /** applier 注册键——定位「怎么还原」 */
  readonly key: string
  /** 实例键——定位「还原哪一个」(family atom)。单例 atom 省略 */
  readonly scope?: string
  readonly before: unknown
  readonly after: unknown
}

export interface HistoryEntry {
  readonly txId: string
  /** 给 UI 显示,如「撤销 输入」 */
  readonly label?: string
  readonly ops: readonly HistoryOp[]
}

export interface HistoryStackState {
  readonly entries: readonly HistoryEntry[]
  /** [0, entries.length],指向下一个 redo 位 */
  readonly cursor: number
}

/**
 * 还原一个 op。返回 `false` 表示还原失败(整条 entry 会被回滚,游标不动);
 * 其余返回值均视为成功。抛异常等同于返回 `false`。
 */
export interface HistoryApplier {
  (getter: Getter, setter: Setter, op: HistoryOp, direction: HistoryDirection): boolean | void
}

/**
 * 持久化端口。core 不碰 IndexedDB/文件系统,只按增量调用这些方法。
 *
 * 全部为「fire-and-forget」:失败不回滚内存状态,只经 `onError` 上报——
 * 否则一次 IO 抖动就会让 undo 永久卡死。
 *
 * 落盘的 `before`/`after` 必须可结构化克隆。反序列化回来的是新对象而非
 * 原引用,所以持有类实例、闭包、DOM 引用的状态只能用纯内存模式。
 */
export interface HistoryPersistPort {
  /** 追加一条新提交的 entry */
  append(entry: HistoryEntry): void | Promise<void>
  /** cap 溢出:丢弃最老的 count 条 */
  dropOldest(count: number): void | Promise<void>
  /** 新分支覆盖 redo 尾:丢弃下标 >= cursor 的条目 */
  dropAfter(cursor: number): void | Promise<void>
  setCursor(cursor: number): void | Promise<void>
  load(): Promise<HistoryStackState | null>
}

export interface CreateHistoryOptions {
  /** 历史条数上限,默认 100。超出后从最老一端丢弃 */
  cap?: number
  persist?: HistoryPersistPort
  /** 自定义 txId 生成。持久化场景应提供跨会话唯一的实现 */
  newTxId?: () => string
  /** applier 失败、持久化失败的上报口。不提供则静默 */
  onError?: (error: Error) => void
}

export const DEFAULT_HISTORY_CAP = 100

const EMPTY_ENTRIES: readonly HistoryEntry[] = Object.freeze([])
const INITIAL_STACK: HistoryStackState = Object.freeze({
  entries: EMPTY_ENTRIES,
  cursor: 0,
})

const TX_ID_PATTERN = /^tx-(\d+)$/

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function normalizeCap(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_HISTORY_CAP
}

function freezeOp(key: string, scope: string | undefined, before: unknown, after: unknown) {
  return Object.freeze(
    scope === undefined ? { key, before, after } : { key, scope, before, after },
  ) as HistoryOp
}

/**
 * 浅校验一条外来 entry(来自 `hydrate`)。整条 fail-closed:任一字段不合法
 * 就整条丢弃,绝不放半条进栈。不校验 `before`/`after` 的形状——core 不知道
 * 载荷该长什么样;也不校验 key 是否已注册——hydrate 常在特性模块注册
 * applier 之前跑。
 */
function snapshotEntry(value: unknown): HistoryEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const raw = value as Partial<HistoryEntry>
  if (typeof raw.txId !== 'string' || raw.txId.length === 0) {
    return null
  }
  if (!Array.isArray(raw.ops) || raw.ops.length === 0) {
    return null
  }
  const ops: HistoryOp[] = []
  for (const rawOp of raw.ops) {
    if (typeof rawOp !== 'object' || rawOp === null) {
      return null
    }
    const op = rawOp as Partial<HistoryOp>
    if (typeof op.key !== 'string' || op.key.length === 0) {
      return null
    }
    if (op.scope !== undefined && typeof op.scope !== 'string') {
      return null
    }
    ops.push(freezeOp(op.key, op.scope, op.before, op.after))
  }
  const entry =
    typeof raw.label === 'string'
      ? { txId: raw.txId, label: raw.label, ops: Object.freeze(ops) }
      : { txId: raw.txId, ops: Object.freeze(ops) }
  return Object.freeze(entry) as HistoryEntry
}

function snapshotEntries(raw: readonly unknown[]): HistoryEntry[] {
  const clean: HistoryEntry[] = []
  for (const value of raw) {
    const snapshot = snapshotEntry(value)
    if (snapshot) {
      clean.push(snapshot)
    }
  }
  return clean
}

/** 把 op 的值直接写回 `resolve(scope)` 解析出的源子 atom */
function atomApplier<State>(
  key: string,
  resolve: (scope?: string) => AtomEntity<State>,
): HistoryApplier {
  return (_getter, setter, op, direction) => {
    const target = resolve(op.scope)
    if (!isSourceAtom(target as Atom<State>)) {
      throw new Error(
        `einfach history: key "${key}" 解析出的 atom 不是源子 atom(派生 atom / 自定义 write),` +
          '请改用 registerApplier 手写还原逻辑',
      )
    }
    const value = (direction === 'undo' ? op.before : op.after) as State
    // 必须包 thunk:atom(initialValue) 合成的 write 会把函数参数当 updater
    // 执行(见 atom.ts)。包一层后 updater 被调用并返回 value,于是函数值与
    // 普通值走同一条路,都能原样写回。
    setter(target, () => value)
    return true
  }
}

/** 让默认 txId 序号越过已恢复的最大值,避免跨会话重号 */
function highestTxSeq(entries: readonly HistoryEntry[], current: number): number {
  let highest = current
  for (const entry of entries) {
    const matched = TX_ID_PATTERN.exec(entry.txId)
    if (!matched) {
      continue
    }
    const parsed = Number(matched[1])
    if (Number.isSafeInteger(parsed) && parsed > highest) {
      highest = parsed
    }
  }
  return highest
}

export interface History {
  /** 只读栈投影,每次事务提交/游标移动写一次 */
  readonly stackAtom: Atom<HistoryStackState>
  readonly canUndoAtom: Atom<boolean>
  readonly canRedoAtom: Atom<boolean>
  /** 非响应式读取,等价于 stackAtom 的当前值 */
  getState(): HistoryStackState
  registerApplier(key: string, applier: HistoryApplier): void
  /**
   * `registerApplier` 的糖:把 op 的值直接写回 `resolve(scope)` 解析出的
   * 源子 atom。解析结果不是源子 atom 时抛错。
   */
  registerAtomApplier<State>(key: string, resolve: (scope?: string) => AtomEntity<State>): void
  transaction<T>(fn: () => T): T
  transaction<T>(label: string, fn: () => T): T
  /** 声明一次变更。只能在 `transaction()` 内调用 */
  record(op: HistoryOp): void
  undo(): boolean
  redo(): boolean
  clear(): boolean
  /**
   * 从 `persist.load()` 的结果恢复。非法条目整条丢弃。
   *
   * 只在空栈上合法——恢复属于阻塞式启动的一步,栈非空说明本会话已经产生过
   * 历史,覆盖会静默吃掉用户的编辑。有意换一份历史请先 `clear()`。
   */
  hydrate(state: HistoryStackState): boolean
  /**
   * `persist.load()` + `hydrate()` 的合并调用,供阻塞式启动使用:
   * `await history.restore()` 之后再放行编辑。没有配 `persist`、端口返回
   * 空、或 load 抛错时返回 `false`(错误经 `onError` 上报,不抛)。
   */
  restore(): Promise<boolean>
}

export function createHistory(store: Store, options: CreateHistoryOptions = {}): History {
  const cap = normalizeCap(options.cap)
  const { persist, onError, newTxId } = options

  const appliers = new Map<string, HistoryApplier>()

  let entries: readonly HistoryEntry[] = EMPTY_ENTRIES
  let cursor = 0
  /**
   * idle → 无事务;recording → 事务进行中,record 合法;replaying → 正在写回
   * 历史值,此时 record 非法、undo/redo 拒绝重入。
   */
  let mode: 'idle' | 'recording' | 'replaying' = 'idle'
  let depth = 0
  let pending: HistoryOp[] = []
  let pendingLabel: string | undefined
  let txSeq = 0

  const stackBackingAtom = atom<HistoryStackState>(INITIAL_STACK)
  stackBackingAtom.debugLabel = 'einfach.history.stackBacking'

  const stackAtom: Atom<HistoryStackState> = atom((getter) => getter(stackBackingAtom))
  stackAtom.debugLabel = 'einfach.history.stack'

  const canUndoAtom: Atom<boolean> = atom((getter) => getter(stackBackingAtom).cursor > 0)
  canUndoAtom.debugLabel = 'einfach.history.canUndo'

  const canRedoAtom: Atom<boolean> = atom((getter) => {
    const state = getter(stackBackingAtom)
    return state.cursor < state.entries.length
  })
  canRedoAtom.debugLabel = 'einfach.history.canRedo'

  function report(error: unknown) {
    if (!onError) {
      return
    }
    try {
      onError(toError(error))
    } catch {
      // 宿主回调自身出错不再上抛:上报路径不该成为新的失败源
    }
  }

  function callPort(run: (port: HistoryPersistPort) => void | Promise<void>) {
    if (!persist) {
      return
    }
    try {
      const result = run(persist) as {
        catch?: (onRejected: (error: unknown) => void) => void
      } | void
      if (result && typeof result.catch === 'function') {
        result.catch(report)
      }
    } catch (error) {
      report(error)
    }
  }

  function publish() {
    store.setter(stackBackingAtom, Object.freeze({ entries, cursor }))
  }

  function nextTxId(): string {
    if (newTxId) {
      const id = newTxId()
      if (typeof id === 'string' && id.length > 0) {
        return id
      }
    }
    txSeq += 1
    return `tx-${txSeq}`
  }

  function applyOp(op: HistoryOp, direction: HistoryDirection): boolean {
    const applier = appliers.get(op.key)
    if (!applier) {
      report(new Error(`einfach history: 没有为 key "${op.key}" 注册 applier`))
      return false
    }
    try {
      return applier(store.getter, store.setter, op, direction) !== false
    } catch (error) {
      report(error)
      return false
    }
  }

  /**
   * 按方向回放一串 op:undo 逆序、redo 顺序。中途失败即把本次已生效的部分
   * 逐条反向退回,整串按「未发生」处理并返回 false——不留半应用状态。
   */
  function applySequence(ops: readonly HistoryOp[], direction: HistoryDirection): boolean {
    const ordered = direction === 'undo' ? [...ops].reverse() : ops
    const applied: HistoryOp[] = []
    const inverse: HistoryDirection = direction === 'undo' ? 'redo' : 'undo'
    for (const op of ordered) {
      if (applyOp(op, direction)) {
        applied.push(op)
        continue
      }
      for (let index = applied.length - 1; index >= 0; index -= 1) {
        applyOp(applied[index], inverse)
      }
      return false
    }
    return true
  }

  /** 把 pending 回退到某个基线(事务失败路径),并丢弃这些 op */
  function rollbackTo(baseline: number) {
    if (pending.length <= baseline) {
      return
    }
    const discarded = pending.slice(baseline)
    pending.length = baseline
    const previous = mode
    mode = 'replaying'
    try {
      applySequence(discarded, 'undo')
    } finally {
      mode = previous
    }
  }

  function commit() {
    // 值没真变的 op 不入历史:否则一次「设了个相同的值」也会占一步 undo
    const ops = pending.filter((op) => !Object.is(op.before, op.after))
    const label = pendingLabel
    pending = []
    pendingLabel = undefined
    mode = 'idle'
    if (ops.length === 0) {
      return
    }
    const entry = Object.freeze(
      label === undefined
        ? { txId: nextTxId(), ops: Object.freeze(ops) }
        : { txId: nextTxId(), label, ops: Object.freeze(ops) },
    ) as HistoryEntry

    const hadRedoTail = cursor < entries.length
    const base = entries.slice(0, cursor)
    const next = [...base, entry]
    const overflow = next.length > cap ? next.length - cap : 0
    entries = Object.freeze(overflow > 0 ? next.slice(overflow) : next)
    cursor = entries.length
    publish()

    if (hadRedoTail) {
      callPort((port) => port.dropAfter(base.length))
    }
    callPort((port) => port.append(entry))
    if (overflow > 0) {
      callPort((port) => port.dropOldest(overflow))
    }
    // 游标每次移动都要落盘,提交也不例外——否则镜像的 cursor 会停在上一次
    // undo/redo 的值,跨会话 hydrate 出来的游标是错的。放在最后一步,镜像
    // 的条目已经就位再落游标。
    callPort((port) => port.setCursor(cursor))
  }

  function transaction<T>(labelOrFn: string | (() => T), maybeFn?: () => T): T {
    const label = typeof labelOrFn === 'string' ? labelOrFn : undefined
    const fn = typeof labelOrFn === 'function' ? labelOrFn : maybeFn
    if (typeof fn !== 'function') {
      throw new TypeError('einfach history.transaction: 缺少事务函数')
    }
    if (mode === 'replaying') {
      throw new Error('einfach history.transaction: 回放期间不能开启事务')
    }

    if (depth === 0) {
      pending = []
      pendingLabel = label
      mode = 'recording'
    } else if (label !== undefined && pendingLabel === undefined) {
      pendingLabel = label
    }
    // 嵌套事务各自记住自己的基线:内层抛错被外层 catch 时,只退内层的 op
    const baseline = pending.length
    depth += 1

    let result: T
    try {
      result = fn()
    } catch (error) {
      rollbackTo(baseline)
      depth -= 1
      if (depth === 0) {
        pending = []
        pendingLabel = undefined
        mode = 'idle'
      }
      throw error
    }

    depth -= 1
    if (depth === 0) {
      commit()
    }
    return result
  }

  function record(op: HistoryOp): void {
    if (mode !== 'recording') {
      throw new Error('einfach history.record: 只能在 transaction() 内调用')
    }
    if (typeof op !== 'object' || op === null) {
      throw new TypeError('einfach history.record: op 必须是对象')
    }
    const { key, scope } = op
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('einfach history.record: op.key 必须是非空字符串')
    }
    if (!appliers.has(key)) {
      throw new Error(`einfach history.record: key "${key}" 没有注册 applier`)
    }
    if (scope !== undefined && typeof scope !== 'string') {
      throw new TypeError('einfach history.record: op.scope 必须是字符串')
    }
    pending.push(freezeOp(key, scope, op.before, op.after))
  }

  function registerApplier(key: string, applier: HistoryApplier): void {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('einfach history.registerApplier: key 必须是非空字符串')
    }
    if (typeof applier !== 'function') {
      throw new TypeError('einfach history.registerApplier: applier 必须是函数')
    }
    // 静默覆盖会让历史条目悄悄改变还原语义,必须炸
    if (appliers.has(key)) {
      throw new Error(`einfach history.registerApplier: key "${key}" 已注册`)
    }
    appliers.set(key, applier)
  }

  function registerAtomApplier<State>(
    key: string,
    resolve: (scope?: string) => AtomEntity<State>,
  ): void {
    if (typeof resolve !== 'function') {
      throw new TypeError('einfach history.registerAtomApplier: resolve 必须是函数')
    }
    registerApplier(key, atomApplier(key, resolve))
  }

  function undo(): boolean {
    if (mode !== 'idle' || cursor === 0) {
      return false
    }
    const entry = entries[cursor - 1]
    mode = 'replaying'
    let ok: boolean
    try {
      ok = applySequence(entry.ops, 'undo')
    } finally {
      mode = 'idle'
    }
    if (!ok) {
      return false
    }
    cursor -= 1
    publish()
    callPort((port) => port.setCursor(cursor))
    return true
  }

  function redo(): boolean {
    if (mode !== 'idle' || cursor >= entries.length) {
      return false
    }
    const entry = entries[cursor]
    mode = 'replaying'
    let ok: boolean
    try {
      ok = applySequence(entry.ops, 'redo')
    } finally {
      mode = 'idle'
    }
    if (!ok) {
      return false
    }
    cursor += 1
    publish()
    callPort((port) => port.setCursor(cursor))
    return true
  }

  function clear(): boolean {
    if (mode !== 'idle') {
      return false
    }
    entries = EMPTY_ENTRIES
    cursor = 0
    publish()
    callPort((port) => port.dropAfter(0))
    callPort((port) => port.setCursor(0))
    return true
  }

  function hydrate(state: HistoryStackState): boolean {
    if (mode !== 'idle') {
      return false
    }
    // 恢复是「阻塞式启动」的一步:宿主必须先 await 完 load 再放行编辑。
    // 栈非空说明本会话已经产生过历史,此时覆盖会静默吃掉用户的编辑——
    // 拒绝掉,让接线错误当场暴露。有意换一份历史(切文档)先调 clear()。
    if (entries.length > 0) {
      report(new Error('einfach history.hydrate: 栈非空,恢复前请先 clear()'))
      return false
    }
    if (typeof state !== 'object' || state === null || !Array.isArray(state.entries)) {
      return false
    }
    const clean = snapshotEntries(state.entries)
    const capped = clean.length > cap ? clean.slice(clean.length - cap) : clean
    entries = Object.freeze(capped)
    const rawCursor = state.cursor
    cursor = Number.isSafeInteger(rawCursor)
      ? Math.min(Math.max(rawCursor, 0), entries.length)
      : entries.length
    txSeq = highestTxSeq(entries, txSeq)
    publish()
    // 恢复时如果丢弃了条目(结构非法 / 超出本会话的 cap),镜像里还留着它们。
    // 不同步的话,下一次 dropOldest/dropAfter 的位置就与内存错开并永久漂移。
    // 只在真的丢过东西时重写,常规「load 出来原样喂回」不产生额外 IO。
    if (entries.length !== state.entries.length) {
      callPort((port) => port.dropAfter(0))
      for (const entry of entries) {
        callPort((port) => port.append(entry))
      }
    }
    callPort((port) => port.setCursor(cursor))
    return true
  }

  async function restore(): Promise<boolean> {
    if (!persist) {
      return false
    }
    try {
      const loaded = await persist.load()
      return loaded ? hydrate(loaded) : false
    } catch (error) {
      report(error)
      return false
    }
  }

  return {
    stackAtom,
    canUndoAtom,
    canRedoAtom,
    restore,
    getState: () => Object.freeze({ entries, cursor }),
    registerApplier,
    registerAtomApplier,
    transaction,
    record,
    undo,
    redo,
    clear,
    hydrate,
  }
}
