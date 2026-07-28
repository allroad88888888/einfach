# 用 IndexedDB 持久化 history

`@einfach/core` 里不含浏览器实现 —— 它要能在 Node/jest 跑，不能依赖 `indexedDB` 全局。持久化通过 `HistoryPersistPort` 从外面接入，本文是一份可直接抄走的参考实现。

## 端口契约回顾

```ts
interface HistoryPersistPort {
  append(entry: HistoryEntry): void | Promise<void>   // 追加到末尾
  dropOldest(count: number): void | Promise<void>     // cap 溢出，删最老的 count 条
  dropAfter(cursor: number): void | Promise<void>     // 新分支覆盖，截断到 cursor 长度
  setCursor(cursor: number): void | Promise<void>
  load(): Promise<HistoryStackState | null>
}
```

两条硬约束：

1. **适配器内部必须排队。** 一次事务提交最多发四个调用（`dropAfter` → `append` → `dropOldest` → `setCursor`），core **不 await 也不串行化**。IndexedDB 每个事务独立，四个调用乱序落库就会把镜像写坏。
2. **端口是位置语义的镜像。** `dropOldest(n)` / `dropAfter(cursor)` 给的是**当前数组下标**，不是 txId。只要按收到的顺序执行，镜像就和内存栈逐位对齐。

## 参考实现

```ts
import type { HistoryEntry, HistoryPersistPort, HistoryStackState } from '@einfach/core'

const ENTRIES = 'entries'
const META = 'meta'
const CURSOR_KEY = 'cursor'

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result)
    source.onerror = () => reject(source.error)
  })
}

/**
 * body 必须是同步的：IndexedDB 事务在微任务队列排空且没有挂起请求时会自动
 * 提交，在 body 里 await 会让事务在你发下一个请求之前就关掉。
 */
function write(db: IDBDatabase, body: (entries: IDBObjectStore, meta: IDBObjectStore) => void) {
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([ENTRIES, META], 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'))
    body(transaction.objectStore(ENTRIES), transaction.objectStore(META))
  })
}

export function createIndexedDbHistoryPort(dbName: string): HistoryPersistPort {
  let dbPromise: Promise<IDBDatabase> | null = null
  /** 镜像的键序列，下标 = core 的位置语义。适配器是唯一写入者，可放心缓存 */
  let keys: number[] | null = null
  let chain: Promise<unknown> = Promise.resolve()

  // 串行化：前一个失败也要继续跑，队列本身不因单次失败断掉
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  function open(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const opening = indexedDB.open(dbName, 1)
        opening.onupgradeneeded = () => {
          const db = opening.result
          // 键外置 + autoIncrement：不往 entry 里注入字段，冻结的 entry 原样落库
          if (!db.objectStoreNames.contains(ENTRIES)) {
            db.createObjectStore(ENTRIES, { autoIncrement: true })
          }
          if (!db.objectStoreNames.contains(META)) {
            db.createObjectStore(META)
          }
        }
        opening.onsuccess = () => resolve(opening.result)
        opening.onerror = () => reject(opening.error)
      })
    }
    return dbPromise
  }

  async function ensureKeys(db: IDBDatabase): Promise<number[]> {
    if (!keys) {
      // getAllKeys 按键升序返回，对 autoIncrement 即插入顺序
      const stored = await request(db.transaction(ENTRIES).objectStore(ENTRIES).getAllKeys())
      keys = stored as number[]
    }
    return keys
  }

  return {
    append: (entry) =>
      enqueue(async () => {
        const db = await open()
        const mirror = await ensureKeys(db)
        await write(db, (entries) => {
          const adding = entries.add(entry)
          adding.onsuccess = () => mirror.push(adding.result as number)
        })
      }),

    dropOldest: (count) =>
      enqueue(async () => {
        const db = await open()
        const doomed = (await ensureKeys(db)).splice(0, count)
        await write(db, (entries) => doomed.forEach((key) => entries.delete(key)))
      }),

    dropAfter: (cursor) =>
      enqueue(async () => {
        const db = await open()
        const doomed = (await ensureKeys(db)).splice(cursor)
        await write(db, (entries) => doomed.forEach((key) => entries.delete(key)))
      }),

    setCursor: (cursor) =>
      enqueue(async () => {
        const db = await open()
        await write(db, (_entries, meta) => {
          meta.put(cursor, CURSOR_KEY)
        })
      }),

    load: () =>
      enqueue(async (): Promise<HistoryStackState | null> => {
        const db = await open()
        await ensureKeys(db)
        const entries = (await request(
          db.transaction(ENTRIES).objectStore(ENTRIES).getAll(),
        )) as HistoryEntry[]
        if (entries.length === 0) {
          return null
        }
        const saved = await request(db.transaction(META).objectStore(META).get(CURSOR_KEY))
        const cursor = typeof saved === 'number' ? saved : entries.length
        return { entries, cursor: Math.min(Math.max(cursor, 0), entries.length) }
      }),
  }
}
```

## 接线（阻塞式启动）

```ts
const store = createStore()
const history = createHistory(store, {
  cap: 100,
  persist: createIndexedDbHistoryPort(`einfach-history:${docId}`),
  onError: (error) => reportToMonitoring(error),
})

history.registerAtomApplier('cell', (scope) => getCellAtom(scope!))

// 恢复完再放行编辑：restore() 之后 UI 才可交互
const restored = await history.restore()
if (!restored) {
  // 无历史可恢复，或 load 失败（错误已经走 onError）。空历史开局即可
}
```

`hydrate()` 只在空栈上合法。放行编辑早于 `restore()` 的接线错误会被当场拒绝并经 `onError` 上报，而不是静默吃掉用户的编辑。

## IndexedDB 特有的三个坑

**1. 事务会自动提交。** 在 `write` 的 body 里 `await` 任何东西，事务会在你发下一个请求之前关掉，后续请求抛 `TransactionInactiveError`。所以 body 必须同步发完所有请求，异步的活（比如 `ensureKeys`）放到事务之外。

**2. 载荷必须可结构化克隆。** `before` / `after` 里不能有函数、类实例、DOM 节点、Proxy。einfach 的源子 atom 本来就无法直接持有函数（见 README「函数值」一节），但对象里嵌了方法一样会让 `add()` 抛 `DataCloneError`。

**3. 每份文档一个库（或一个 store）。** 上面用 `dbName` 区分。多文档共用一个 store 而只靠字段过滤的话，`dropOldest(n)` 的位置语义会跨文档串味。

## 本文没覆盖的

- **配额与驱逐**：浏览器可能在磁盘紧张时清掉整个 origin 的 IndexedDB。历史丢失应当是可降级的 —— `restore()` 返回 `false` 时空历史开局，不要阻断应用。
- **版本迁移**：`entry` 的形状变了（比如新增字段）之后，旧库里的记录仍会被 `hydrate` 的浅校验放行。要么在 `onupgradeneeded` 里清库，要么在 entry 里带上自己的 schema 版本并在 `load()` 里过滤。
- **多标签页**：两个标签页开同一份文档会各写各的镜像。需要 `BroadcastChannel` 或 Web Locks 协调，本文不涉及。
