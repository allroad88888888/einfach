# @einfach/core

轻量级、受 Jotai 启发的 atom 状态管理核心库（框架无关）。

## 安装

```bash
npm install @einfach/core
# or
pnpm add @einfach/core
```

## 基本用法

### 创建 Atom

```ts
import { atom, createStore } from '@einfach/core'

// 基础 atom
const countAtom = atom(0)

// 派生 atom（只读）
const doubleAtom = atom((get) => get(countAtom) * 2)

// 可写派生 atom
const incrementAtom = atom(
  (get) => get(countAtom),
  (get, set, step: number) => set(countAtom, get(countAtom) + step)
)
```

### 使用 Store

```ts
const store = createStore()

// 读取
store.getter(countAtom) // 0

// 写入
store.setter(countAtom, 1)
store.getter(countAtom) // 1

// 订阅
const unsub = store.sub(countAtom, () => {
  console.log('count changed:', store.getter(countAtom))
})

// 取消订阅
unsub()

// 清空 store
store.clear()
```

### 异步 Atom

```ts
const userAtom = atom(async (get) => {
  const id = get(userIdAtom)
  const res = await fetch(`/api/users/${id}`)
  return res.json()
})
```

## 状态建模规则

- `atom(initialValue)` 表达一个小颗粒、可写的业务事实。
- `atom((getter) => ...)` 表达可追踪的派生规则；派生 atom 默认只读。
- 跨 atom 的读取和写入使用命令 atom：`atom(null, (getter, setter, ...args) => {})`。
- `atom(async (getter) => ...)` 是业务异步衍生：它读取 source atom 并返回 Promise。
- 新需求优先新增相关的 source atom 或 derived atom，避免把无关字段塞进一个大状态对象。

## API

### 核心

| API | 说明 |
|-----|------|
| `atom(initialValue)` | 创建基础 atom |
| `atom(readFn)` | 创建只读派生 atom |
| `atom(readFn, writeFn)` | 创建可写派生 atom |
| `createStore()` | 创建 store 实例 |
| `getDefaultStore()` | 获取默认 store 单例 |

### Store 方法

| 方法 | 说明 |
|------|------|
| `store.getter(atom)` | 读取 atom 值 |
| `store.setter(atom, ...args)` | 写入 atom 值 |
| `store.sub(atom, listener)` | 订阅 atom 变化，返回取消订阅函数 |
| `store.clear()` | 清空 store |

### 工具函数

| API | 说明 |
|-----|------|
| `selectAtom(atom, selectorFn, equalFn?)` | 创建带选择器的派生 atom |
| `atomWithCompare(initialValue, equalFn)` | 创建带自定义比较的 atom |
| `atomWithRefresh(readFn)` | 创建可刷新的 atom |
| `atomWithLazyRefresh(readFn)` | 创建懒加载可刷新 atom |
| `createAsyncParamsAtom(asyncFn)` | 创建接收参数的异步 atom |
| `createHistory(store, options?)` | 创建事务日志式撤销/重做系统 |
| `isSourceAtom(atom)` | 判断是否为 `atom(initialValue)` 造出的源子 atom |
| `incrementAtom(atom, derivations)` | 创建带派生计算的 atom |
| `createCacheStom(atomFn, options?)` | 创建 LRU 缓存 atom 工厂 |
| `memo(weakKey, fn)` | 基于 WeakKey 缓存值 |

## 撤销 / 重做

`createHistory` 是**事务日志**，不是状态快照：历史里存的是「字符串 key → before/after」，每条 entry 自带完整逆操作。由此可有界截断（默认 cap 100）、可 JSON 序列化落 IndexedDB、一次 undo 的代价是 O(本条改动数) 而非 O(历史长度)。

```ts
const history = createHistory(store, { cap: 100 })

// 注册「怎么还原」。scope 用于 family atom，单例 atom 可省略
history.registerAtomApplier('count', () => countAtom)
history.registerAtomApplier('row', (scope) => getRowAtom(scope!))

// 一次事务 = 一步 undo，哪怕改了多个 atom
history.transaction('输入', () => {
  const before = store.getter(countAtom)
  store.setter(countAtom, 7)
  history.record({ key: 'count', before, after: 7 })
})

history.undo()   // → true
store.getter(history.canRedoAtom)   // → true
```

要点：

- **不自动捕获**。变更由 `record()` 显式声明 —— 自动捕获需要给每个被追踪的 atom 常驻订阅与基线值，成本 O(被追踪 atom 数)，在 family 场景下不成立。
- **事务内抛异常**会把已记录的 op 逆序回退到事务开始状态，不留 entry，异常原样上抛。嵌套事务各自持有基线，内层失败被外层捕获时只退内层。
- **`registerAtomApplier` 只接受源子 atom**。派生 atom（真相在上游）和命令 atom（write 是动作不是赋值）会被 `isSourceAtom` 挡掉。
- **持久化**通过 `HistoryPersistPort`（`append` / `dropOldest` / `dropAfter` / `setCursor` / `load`）增量落盘，全部 fire-and-forget：IO 失败只经 `onError` 上报，不回滚内存状态。落盘的 `before`/`after` 必须可结构化克隆。

### 接 IndexedDB

core 不含浏览器实现，从外面传一个端口进去即可：

```ts
const history = createHistory(store, { cap: 100, persist: idbPort, onError: log })

// 阻塞式启动:恢复完再放行编辑
await history.restore()
```

适配器有两条硬约束：

1. **内部必须排队。** 一次提交最多发四个调用（`dropAfter` → `append` → `dropOldest` → `setCursor`），core 不 await 也不串行化。IndexedDB 每个事务独立，乱序执行会写坏镜像。
2. **端口是位置语义的镜像。** `dropOldest(n)` / `dropAfter(cursor)` 给的是当前数组下标而非 txId；按收到的顺序执行即可与内存逐位对齐。

完整的 IndexedDB 参考实现见 [docs/HISTORY_INDEXEDDB.md](./docs/HISTORY_INDEXEDDB.md)。

`hydrate()` 只在空栈上合法 —— 栈非空说明本会话已产生过历史，覆盖会静默吃掉用户的编辑，此时返回 `false` 并经 `onError` 上报。有意换一份历史（切文档）请先 `clear()`。

## 许可证

MIT
