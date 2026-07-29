# @einfach/core

## 0.3.0

### Minor Changes

- 2cb4ce1: **破坏性变更**：移除 `createUndoRedo` 与 `openUndoRedoAtom`，由事务日志式的 `createHistory` 取代。旧实现按快照记录整棵状态树，新实现只记录 `HistoryOp` 序列，并提供 `HistoryApplier`（自定义应用方式）、`HistoryPersistPort`（持久化）、`DEFAULT_HISTORY_CAP = 100` 的有界栈。迁移需按新 API 重写调用点，二者不兼容。

  新增 `isSourceAtom()` 与 `SYNTHESIZED_WRITE` 标记：`atom(initialValue)` 合成的 write 现在带标记，使「源子 atom」可与只读派生、可写派生、命令 atom（`atom(null, fn)`）在运行时区分开 —— 撤销/重做与持久化回放需要这个判定才能安全地写回历史旧值。

  深链求值改为 `READ_RECURSION_BUDGET = 256` 的预算内递归 + 超预算后的 FAULT 哨兵帧循环，替换 0.2.19 中基于缺失依赖异常 + 显式栈的实现。两者对外保证一致（任意深度不再 RangeError、环报明确错误、等值传播剪枝），已用 0.2.19 的 `deepNesting.test.ts` 全套 19 个用例回归验证。三处可观察差异：超预算深链上 read fn 可能执行多次（副作用须自行幂等）、`options.getter` 的函数身份只在单轮 read 内稳定、`runDependenciesChange` 的反向依赖集合按压栈时刻快照而非实时遍历。

  `createCacheStom` / `createCacheStomById` 的泛型参数由 `AtomEntity` 更名为 `TAtom`，避免与同名导出类型遮蔽（仅类型参数名，不影响调用方）。

## 0.2.19

### Patch Changes

- 8e46430: 修复深层嵌套依赖链爆栈：求值改为深度受限递归（250 层内与旧行为一致）+ 超限后切换显式栈迭代，set 传播完全交由 flushPending 循环推进，任意深度依赖链不再 RangeError。flushPending 改为先收敛整张依赖图再统一通知，listener 中读取下游 atom 一定拿到新值。循环依赖现在报明确的 Circular dependency 错误。

## 0.2.18

### Patch Changes

- 341f8a7: Improve npm search discoverability: English descriptions and add einfach keyword

## 0.2.17

### Patch Changes

- fix: dependenciesChange 对 async atom 跳过递归，避免 O(N²) 无效遍历

  async atom 的 readAtom 每次返回新 Promise 引用，导致 Object.is 永远返回 false，
  dependenciesChange 递归遍历整个反向依赖图。改为由 flushPending while 循环 +
  Promise 链自然传播，getter 调用从 O(N²) 降到 O(N)。

## 0.2.16

### Patch Changes

- 修复版本

## 0.2.15

### Patch Changes

- 降级

## 0.2.15

### Patch Changes

- 暴露storeAtom

## 0.2.14

### Patch Changes

- easyset 如果prop为空 则直接返回value

## 0.2.13

### Patch Changes

- fixed:有些场景listenersMap.get(atomEntity) 为undeinfed

## 0.2.12

### Patch Changes

- 如果atom的setter方法是异步的，没有等待所有更新，再去更新flushPending

## 0.2.11

### Patch Changes

- 修复发版本 没有编译

## 0.2.10

### Patch Changes

- setter 自己设置自身时不应触发 getter 重算

## 0.2.9

### Patch Changes

- 对外暴露getGlobalSymbolForId

## 0.2.8

### Patch Changes

- 移除getFamilyAtomById的params缓存，创建对象修改为sysmbol 减少部分内存

## 0.2.7

### Patch Changes

- 类型更换

## 0.2.6

### Patch Changes

- createFamilyAtomById 添加Weakkey

## 0.2.5

### Patch Changes

- 移除开发模式下promise Object.frezz

## 0.2.4

### Patch Changes

- createGetFamilyAtomById的类型调整

## 0.2.3

### Patch Changes

- createGetFamilyAtomById 新增set方法
