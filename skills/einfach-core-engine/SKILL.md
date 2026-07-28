---
name: einfach-core-engine
description: "Use when reading, debugging, or modifying the @einfach/core store engine in core/core/src — atom state tables, dependency tracking, the isFresh snapshot check, the 256-depth recursion budget and FAULT frame loop for deep chains, flushPending propagation, circular-dependency errors, continuable promises for async atoms, or the dev-only Object.freeze on atom values. Also use when a bug looks like a stale atom value, a read function running more than once, RangeError maximum call stack, a frozen-object write failure, or an O(N^2) propagation slowdown."
---

# @einfach/core 引擎内核

`core/core/src` 的求值模型。**改这里之前先读完本文** —— 这个 store 有若干与 Jotai 不同、且被测试逐条钉住的刻意行为，凭直觉改会静默破坏 Excel 深公式链。

不涉及：`utils/` 那一层的用法（selectAtom / createUndoRedo / family 等）、React/Solid 绑定、vnext 分层规则。

## 1. atom 不持有状态

`src/atom.ts`（41 行）产出的只是描述对象：

```ts
{ toString(), read?, init?, write?, debugLabel }
```

- `atom(0)` → 存 `init`，**自动合成 write**（因此支持 `set(a, prev => prev + 1)`）
- `atom(get => …)` → 存 `read`
- 第二参数覆盖 `write`

值全在 store 里，atom 只当 WeakMap 的 key。同一批 atom 实体可被多个 store 同时使用且互不串扰（`deepChainBoundary.test.ts` B10 钉住）。

## 2. store 的五张表

`src/store.ts` `createStore()` 闭包内：

| 表 | 类型 | 作用 |
|---|---|---|
| `atomStateMap` | WeakMap | atom → 当前值 |
| `dependenciesMap` | WeakMap | 我依赖谁 → **依赖当时的值快照** |
| `backDependenciesMap` | WeakMap | 谁依赖我（反向边，传播用） |
| `listenersMap` | WeakMap | atom → listener 集合 |
| `pendingMap` | **Map** | 本批次变更的 atom → prev 值 |

`clear()` 重建 4 张 WeakMap 并清空 `pendingMap` + `pendingDepErrors` —— `pendingMap` 必须清（4a21dc3 修的：异步 setter 把 flush 推迟到 `.finally`，不清会让旧世界的条目在 clear 之后把已清除的 atom 重新物化）。

**没有 version / epoch / AtomState 对象。** 新鲜判定靠逐条依赖 `Object.is` 比对快照（`isFreshShallow`, store.ts:87）：有缓存，且（无依赖表项 ⟹ 永久新鲜 | 每条依赖的当前值都等于快照）。

**没有 mount / unmount 生命周期。** `sub()` 只是「先读一次 + 挂 listener」，依赖边不随取消订阅回收，靠 WeakMap 兜底。不要按 Jotai 的挂载模型推理这里的行为。

## 3. 读路径 —— 双模式，这是本包最关键的设计

`readAtomInternal`（store.ts:349）：新鲜直接返回；primitive 就地播种 `init`；派生 atom 走帧循环。

依赖拉取在 `readDep`（store.ts:236），按**语义顺序**检查，顺序本身是契约，别重排：

```
pendingDepErrors → isFresh → primitive 播种 → computing 环守卫 → 预算内递归 / 超预算 FAULT
```

分两种模式：

- **嵌套深度 ≤ 256**（`READ_RECURSION_BUDGET`）：getter 内直接递归，与重写前的旧实现逐字同构。**所有常规 atom 图、全部 UI 场景走这条路，行为不变。**
- **超预算**：切「缺失依赖故障-重试」帧循环。getter 对未算好的依赖返回 `FAULT` 哨兵（译成 `undefined` 交给 read fn，本轮结果作废），缺失依赖记进堆上显式栈自底向上算，再重跑本帧。调用栈封顶，链长只受堆内存限制。

动机写在 store.ts:9-31：纯递归在 Node 默认 ~1MB 栈下约 4000 层抛 `RangeError`，而 Excel 公式链（`A2=A1+1` 拉十万行）远超这个数。

细节见 `references/frame-loop.md`。

## 4. 写路径

```
setter(atom, …args)
  → writeAtomState        跑 atom.write；self-set 走 clearDependencies + setAtomState 短路
  → setAtomState          写 atomStateMap，把 prev 记进 pendingMap
  → flushPending          排空 pendingMap（while 循环，容纳重入写）
      → runDependenciesChange   显式栈先序 DFS 重读反向依赖，值没变即剪枝整棵子树
      → publishAtom             next !== prev 才通知 listener
```

- 异步 write 的 `flushPending` 推迟到 `.finally`。
- `runDependenciesChange` 对 **Promise 值不递归**（fdcd824 修的 O(N²)：新旧 Promise 引用必不同，递归无意义），靠 promise resolve 回调里的 `complete()` 再传播。
- 剪枝是规模化的关键：等值头写在 100k 链上只让直接依赖者跑一次校验（`deepChainPerf.test.ts` P5）。

## 5. 异步 atom

`src/promise.ts` `createContinuablePromise`：给 Promise 挂 `status/value/reason`（供同步读），并提供 `CONTINUE_PROMISE` —— 新 Promise 到来时接管旧的、abort 旧的，避免竞态。read fn 通过 `options.signal` 拿 `AbortSignal`。

## 6. 硬不变量（改动必须守住）

1. **`FAULT` 哨兵会被写进依赖快照**，因为它与任何用户值都不 `Object.is` 相等 —— 保证故障轮的快照永远无法让重访的 `isFresh` 误判新鲜，**哪怕依赖恰好算出 `undefined`**。别「优化」成不写快照或写 `undefined`（`deepChain.test.ts` 有专门的钉）。
2. **依赖边写活表是边读边记的**，不是运行结束批量提交 —— 异步 read fn 在同步返回 Promise 之后才调 getter，只有活表写入才接得住这些迟到登记。
3. **一旦 `scratch.faulted`，后续 getter 不再写活表** —— 被丢弃的异步轮在提交轮之后迟到的 getter 调用，绝不能污染已提交的依赖表。
4. **环一律抛显式 `Error`**（`circular dependency detected` / `circular dependency suspected: no progress since …`），不是栈溢出、不是发散振荡、不是死循环。两道防线：`computing` 集合拦「不新鲜且正在算」，帧循环用「无进展计数」兜底。
5. **`get(self)` 首算短路到 `init`** 是保留的旧怪癖（`undefined + 1 = NaN`），`peek(self)` 首算则抛显式 circular。二者不同，都被钉住。

## 7. 已知偏差与坑

- **dev 下 `setAtomState` 会 `Object.freeze(state)`**（store.ts:499，`NODE_ENV !== 'production'`）。测试和开发环境里写入的对象是冻结的，任何原地 mutate 会失败。
- **超预算深链上 read fn 会执行多次**（至多 1 + 缺失依赖发现轮数次）。**副作用必须自行幂等**，异步 read 会双重执行。这是刻意取舍，不是 bug。
- **`options.getter` 的函数身份不再全局稳定**（旧版 `=== store.getter`），只在单轮 read 运行内稳定。
- **`runDependenciesChange` 的子集合按压栈时刻快照**（P3，已接受）；旧版 live `Set.forEach` 会访问遍历中新增的成员，快照不会 —— 仅「动态依赖在传播过程中扩张」时可观察。
- **`readAtom` 的 `force?: boolean` 只存在于重载签名**，实现忽略它（store.ts:424-435）。别照着签名写调用。
- **`storeAtom`** 让 store 把自己塞进一个 atom，任何 read/write 都能拿到 store；目前仓内除 core 自身外无人使用。

## 8. 改动后怎么验证

```bash
npx jest core/core --no-coverage
```

三份深链护栏是这块代码的合同，**任何一条红了都说明改坏了语义，不要调阈值**：

| 文件 | 钉住什么 |
|---|---|
| `deepChain.test.ts` | 100k 链传播 / 冷读订阅 / 等值剪枝 / 超预算菱形 / 缓存命中 / self-set；外加复审回归钉：`peek(self)` 累加器、256 层之下的 IFERROR 捕获、1200 扇入不误报环、undefined 与故障占位巧合不吞更新、异步僵尸轮无 unhandled rejection |
| `deepChainBoundary.test.ts` | B1-B15：noWatch 不记边、故障轮批量收集、依赖抛错的冻结语义、跨重试轮错误 re-record、环、菱形、全 undefined 链、可写派生、`clear()` 重物化、双 store 隔离、flush 中重入写、`signal` abort 时机 |
| `deepChainPerf.test.ts` | P1-P5。**原则：闭式计数（read fn 执行次数）做硬断言**，任何机器上确定；墙钟只做宽松天花板 / 比例护栏，抓复杂度级别回归（线性 → 二次方），不抓常数噪声。d6cd98e 把 P5 墙钟从 200ms 放宽到 1s，计数器仍是精确钉 —— **放宽墙钟可以，放宽计数不行** |

## 9. 不要做的事

- 不要把递归预算调大来「简化」—— 4000 层左右就爆栈，预算 256 是为了让常规路径与旧实现逐字同构，同时给深链留足帧循环空间。
- 不要给深链加并行 / 异步分片：`readAtomInternal` 是同步契约，调用方（含 WASM 桥）依赖它同步返回。
- 不要把 `pendingMap` 换成 WeakMap：需要可迭代排空。
- 不要在 `runDependenciesChange` 里恢复对 Promise 的递归。
- 修 bug 前先在 `deepChainBoundary.test.ts` 里加钉子复现，那份文件就是为此存在的。
