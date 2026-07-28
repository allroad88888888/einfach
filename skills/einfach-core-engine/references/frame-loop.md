# 帧循环深读（超预算路径）

`core/core/src/store.ts` 中 `readDep` / `runReadFn` / `readAtomInternal` 三者的协作。仅在嵌套深度超过 `READ_RECURSION_BUDGET`（256）时进入。

引入于 `d995942 feat(core): iterative deep-chain readAtom/dependenciesChange in vanilla store`，护栏补于 `7226093`。

## 参与角色

**`FAULT`** —— `Symbol('einfach.store.fault')`。`readDep` 对「超预算且未算好」的依赖返回它。两个用途：

1. getter 把它译成 `undefined` 交给 read fn —— 维持**批量收集**：一轮能发现多条缺失依赖，而不是一次一条。
2. 同时把它**原样写进依赖快照** —— 它与任何用户值都不 `Object.is` 相等，故障轮的快照永远无法让重访的 `isFresh` 误判新鲜，哪怕依赖恰好算出 `undefined`。

**`Scratch`** —— 一次 read fn 运行的故障记账：

```ts
{ needed: AnyAtom[], neededSet: Set<AnyAtom>, faulted: boolean,
  lastDepError?: { atom, error } }
```

`needed` 去重保序。`lastDepError` 记本轮由 getter 送达（重抛）的依赖错误，供帧循环判断错误是否需要回存。

**`pendingDepErrors`** —— `Map<atom, error>`，store 级。旧实现里依赖的异常从消费者的 getter 调用处抛出（read fn 可以 try/catch，即 IFERROR 模式）；超预算时依赖在帧循环里独立计算，错误记到这里，消费者重试轮的 getter 在 read fn 内部重抛 —— **恢复可捕获性**。送达即删；`frameLoopDepth` 归零时清残留。

## `readDep(atom, scratch)` —— 检查顺序即语义

```
1. pendingDepErrors.has(atom)  → 取出、删除、记 scratch.lastDepError、throw
2. isFresh(atom)               → 返回缓存值
3. typeof atom.read !== 'function' → 就地播种 init（primitive 落底）
4. computing.has(atom)         → throw circular dependency detected
5. readDepth < 256             → readDepth++ 递归 readAtomInternal
6. 否则                         → recordFault(scratch, atom)，返回 FAULT
```

顺序上的两个要点：

- **送达的依赖错误最先** —— 该依赖此刻处于「冻结新鲜」态。
- **`isFresh` 先于 `computing` 守卫** —— 重入读（`peek(self)` / `options.getter` / 嵌套帧）会命中「运行前已清依赖 ⇒ 无表项 ⇒ 新鲜」这个旧怪癖，返回陈旧缓存，与旧实现一致。只有「不新鲜且正在计算」（真环）才拦截。调换这两步会改变 `peek(self)` 累加器语义（`deepChain.test.ts` 有钉）。

## `runReadFn(atomEntity)` —— 跑一轮 read 函数

- **getter 自读短路**：`Object.is(atom, atomEntity)` 时，无缓存返回 `init`，有缓存返回缓存值，不记边。
- **依赖边写活表**（`registerEdge`：反向边 + 确保依赖表条目），与旧实现逐字同序。**边读边记**，因为异步 read fn 会在同步返回 Promise 之后才调 getter，只有活表写入才接得住迟到登记。
- **`live = !scratch.faulted`**：一旦本轮故障，后续 getter 不再写活表 —— 本轮已注定作废，尤其是被丢弃的异步轮在提交轮之后迟到的 getter 调用，绝不能污染已提交的依赖表。
- `getter.peek` = `noWatchGetter`：读值但不记边，`FAULT` 译成 `undefined`。
- `options` 是三个惰性访问器（`signal` / `setter` / `getter`）。`signal` 每次访问新建 `AbortController`；`setter` 在 `isSync` 期间是 `writeAtomState`，之后是 `setAtom`。
- 返回 `ReadRunResult`，其中 `settle()` 把 `isSync` 翻 false —— 调用方必须在**提交之后**调用它（旧实现的翻转时机 = `setAtomState` 之后）。

## `readAtomInternal(rootEntity)` —— 帧循环

显式栈 `[rootEntity]`，另有 `progressCount` 与 `lastRunAt: Map<atom, number>`。

每轮取栈顶：

| 情况 | 动作 |
|---|---|
| 新鲜 | pop，`progressCount++` |
| primitive | 播种 `init`，pop，`progressCount++` |
| `lastRunAt.get(a) === progressCount` | throw `circular dependency suspected: no progress since …` |
| 否则 | 记 `lastRunAt`，`clearDependencies`，`runReadFn` |

`runReadFn` 之后按结果分三支：

**① `scratch.faulted`（丢弃轮）**
- 返回值作废
- `result.controller?.abort?.()` —— 挂起的 signal 中止
- `isPromiseLike(value)` → `Promise.resolve(value).catch(() => {})`，僵尸续体的异常不得变成 unhandled rejection
- 若本轮 getter 已送达但 read fn 未消化的依赖错误（`threw && Object.is(error, lastDepError.error)`）→ **回存 `pendingDepErrors`**，重试轮重新送达。不回存会静默错值（B4 钉住）
- `pushReversed(stack, scratch.needed)`，`continue` —— 不 pop，缺失依赖算好后重跑本帧

**② `result.threw`**
- 栈深为 1（根帧）→ 直接向调用方抛（旧行为，B15 钉住）
- 非根帧 → 错误**也是终局进展**：`pendingDepErrors.set(atom, error)`，pop，`progressCount++`，消费者重试轮经 getter 收到它

**③ 正常**
- `setAtomState(atom, value, abort)` → `settle()` → pop → `progressCount++`

`frameLoopDepth` 计数嵌套，归零时 `pendingDepErrors.clear()`。

## 无进展环检测为什么是对的

合法的「逐轮发现新依赖」模式每轮至少提交一个 atom（`progressCount` 增长），所以重跑时 `lastRunAt.get(a) !== progressCount`，不会误伤。而互相等待的环里没有任何 atom 能提交，`progressCount` 冻住，第二次跑到同一个 atom 就判定为环。

1200 依赖扇入、超预算菱形、全 `undefined` 深链这三种最容易误报的形态都有专门的钉。

## 中间态不可观察

故障轮的重跑发生在**同一次 `readAtomInternal` 调用内**，`atomStateMap` 里永远不会出现半成品：丢弃轮根本不 `setAtomState`。外部（listener、`getter`、WASM 桥）看到的只有终态。
